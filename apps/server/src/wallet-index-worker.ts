import { createHash, randomUUID } from "node:crypto";
import {
  DEFAULT_TOTAL_HELIUS_MONTHLY_CREDIT_BUDGET,
  DEFAULT_WALLET_INDEX_MONTHLY_CREDIT_BUDGET,
  DEFAULT_WALLET_INDEX_TARGET,
  SOL_MINT,
  USDC_MINT,
  type IndexedSpotSwap,
  type TokenEligibility,
  type WalletActivitySample,
  type WalletIndexCheckpoint,
  type WalletIndexRecord,
  type WalletIndexRun,
  type WalletIndexTransaction,
  type WalletPreScreenSnapshot
} from "@copylab/shared";
import {
  HeliusProgramIndexer,
  HeliusRpcBudgetError,
  HeliusRpcClient,
  JUPITER_COARSE_WALLET_PROGRAM_IDS,
  ProviderApiError,
  classifyCoarseJupiterWalletCandidate,
  redactSensitiveText,
  confirmedTransactionMetadata,
  hasParsedSpotSwapSafetyInstructions,
  type HeliusIndexRpc,
  type FetchLike,
  type IndexedSpotSwapObservation
} from "@copylab/providers";
import type { EventBus } from "./events.js";
import {
  COMPLETE_LOCAL_WALLET_RESEARCH_PIPELINE_VERSION,
  type ManagedRecoveryPreflightGate,
  type Repository
} from "./repository.js";
import {
  AWAITING_LOCAL_DEEP_HISTORY,
  WalletDeepHistoryCoordinator
} from "./wallet-deep-history.js";
import { DEFAULT_LOCAL_RESEARCH_LIMIT } from "./wallet-research.js";
import { normalizeWalletIdentityTransactionEvidence } from "./wallet-identity-evidence.js";
import { LOCAL_WALLET_IDENTITY_SOURCE } from "./local-wallet-identity.js";
import {
  WALLET_DISCOVERY_ATTRIBUTION_SOURCES,
  exactWalletDiscoveryFields,
  materializeCoarseWalletCandidate,
  recordExactWalletAttribution,
  recordRejectedCoarseWalletCandidate
} from "./coarse-wallet-discovery.js";

export const WALLET_INDEX_PROGRAM_PIPELINE = "helius-jupiter-program-index";
export const WALLET_INDEX_PROGRAM_HEAD_PIPELINE = "helius-jupiter-program-head";
const PIPELINE = WALLET_INDEX_PROGRAM_PIPELINE;
const HEAD_PIPELINE = WALLET_INDEX_PROGRAM_HEAD_PIPELINE;
const DEEP_HISTORY_SOURCE = "helius-wallet-deep-history";
const PENDING_PRESCREEN = "pending activity pre-screen";
const PARTIAL_RESEARCH_MINIMUM = 1;
const PARTIAL_RESEARCH_BATCH_LIMIT = 5;
const PARTIAL_RESEARCH_PIPELINE_VERSION = "v5";
const DEFAULT_HEAD_MAXIMUM_REPAIR_AGE_MS = 15 * 60_000;
const DISCOVERY_ENQUEUE_CHUNK_SIZE = 50;
// Admit one final cheap rescue tranche while keeping the acquisition
// controller's 6,004-credit worst-case page reserve inviolate once it opens.
export const MANAGED_DEEP_HISTORY_RESCUE_CREDIT_RESERVE = 6_100;
const MANAGED_DEEP_HISTORY_RESCUE_HARD_CREDIT_FLOOR = 6_004;
const MANAGED_DEEP_HISTORY_RESCUE_FLOOR_PAUSE =
  "Managed wallet rescue paused at the 6,004-credit Helius index safety floor.";

function isManagedDeepHistoryRescueCohort(id: string | undefined): boolean {
  return id?.startsWith("managed-rescue-v2:") === true ||
    id?.startsWith("managed-rescue-v3:") === true;
}

export interface WalletIndexWorkerOptions {
  targetWallets?: number;
  /** Durable managed acquisition target; read fresh so a completed tranche can advance safely. */
  getTargetWallets?: () => number;
  /** Fresh fail-closed fence evaluated immediately before a historical discovery request. */
  canDiscoverPage?: () => boolean;
  /** Called only after every higher-priority managed scoring seam has drained. */
  onAcquisitionPipelineDrained?: (sourceExhausted: boolean) => boolean;
  hydrationBatchSize?: number;
  preScreenBatchSize?: number;
  /** Existing successful rows revalidated per turn for research-only signer discovery. */
  coarseBootstrapBatchSize?: number;
  /** Concurrent wallet/provider reads; commits remain in stable candidate order. */
  walletRequestConcurrency?: number;
  signaturePageSize?: number;
  activityPageSize?: number;
  maximumActivityPages?: number;
  maximumIndexCreditsPerMonth?: number;
  maximumTotalHeliusCreditsPerMonth?: number;
  /**
   * Managed Helius requests are credit metered. A self-hosted standard RPC
   * endpoint has no Helius credit ceiling, so its worker must not pause merely
   * because a legacy managed-provider counter reached its reserve.
   */
  enforceManagedCreditBudget?: boolean;
  requestsPerSecond?: number;
  /** Optional account-wide HTTP pacer shared with the other managed clients. */
  fetch?: FetchLike;
  /** Minimum delay between completed newest-signature polls for one program. */
  headSyncIntervalMs?: number;
  /**
   * Keeps post-bootstrap global program polling optional. Historical program
   * discovery is unchanged; managed free-tier operation disables only this
   * analysis-only maintenance feed once wallet-scoped monitoring takes over.
   */
  programHeadMaintenanceEnabled?: boolean;
  /** Gaps older than this are never traversed automatically on managed quota. */
  headMaximumRepairAgeMs?: number;
  /** Allows an audited forward-only head epoch only when trading evidence is absent. */
  allowHeadEpochReseed?: () => boolean;
  deepHistoryEnabled?: boolean;
  deepHistoryTargetLimit?: number;
  deepHistoryPageSize?: number;
  deepHistoryMaximumPages?: number;
  deepHistoryDays?: number;
  deepHistoryIncludeExistingBacklog?: boolean;
  deepHistoryAllowUnpricedStructuralCompletion?: boolean;
  /** Fail-closed pacing gate evaluated only between frozen history cohorts. */
  deepHistoryCanStartNextCohort?: () => boolean;
  /** Opens the bounded v2 rescue lane only after ordinary acquisition is exhausted. */
  deepHistoryCanStartManagedRecovery?: () => boolean;
  /** Fresh PASS-only authorization gate for v3 managed rescue cohorts. */
  deepHistoryManagedRecoveryPreflightGate?: () => ManagedRecoveryPreflightGate | undefined;
  /** Test-only compatibility seam for historical v2 rescue fixtures. */
  deepHistoryAllowLegacyManagedRecoveryWithoutPreflight?: boolean;
  /** Performs one durable provider-preflight step before scarce rescue indexing. */
  runManagedRecoveryPreflight?: () => Promise<boolean>;
  /** Enables complete provider-independent identity evidence and classification. */
  identityEvidenceEnabled?: boolean;
  identityFirstPoolResolver?: (mint: string, now: Date) => Promise<TokenEligibility>;
  /** Strict at-or-before local SOL/USD resolver used for historical SOL legs. */
  solPriceUsdResolver?: (at: string) => Promise<number>;
  programIds?: ReadonlySet<string>;
  rpc?: HeliusIndexRpc;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
  onResearchReady?: (generation: string) => void;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function monthStart(date: Date): string {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  return start.toISOString().slice(0, 10);
}

function errorText(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error));
}

const MAX_BLOCK_TRANSACTIONS = 10_000;
const TRANSIENT_HYDRATION_MAXIMUM_ATTEMPTS = 48;
const TRANSIENT_HYDRATION_MAXIMUM_DELAY_MS = 6 * 60 * 60_000;

class BlockHydrationUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockHydrationUnavailableError";
  }
}

class TransientHydrationUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransientHydrationUnavailableError";
  }
}

function transientHydrationFailure(error: unknown): boolean {
  if (error instanceof TransientHydrationUnavailableError) return true;
  return error instanceof ProviderApiError && (
    error.retryable || error.status === 408 || error.status === 429 || (error.status ?? 0) >= 500
  );
}

interface HydrationOutcome {
  hydratedTransactions: number;
  indexedSwaps: number;
}

const NO_HYDRATION: HydrationOutcome = Object.freeze({
  hydratedTransactions: 0,
  indexedSwaps: 0
});

function blockCapabilityUnavailable(error: unknown): error is ProviderApiError | BlockHydrationUnavailableError {
  if (error instanceof BlockHydrationUnavailableError) return true;
  return error instanceof ProviderApiError &&
    (error.status === 400 || error.status === 403 || error.status === 413 || error.status === 422);
}

export class WalletIndexWorker {
  private readonly targetWallets: number;
  private readonly getTargetWallets: () => number;
  private readonly canDiscoverPage: () => boolean;
  private readonly onAcquisitionPipelineDrained: ((sourceExhausted: boolean) => boolean) | undefined;
  private readonly hydrationBatchSize: number;
  private readonly preScreenBatchSize: number;
  private readonly coarseBootstrapBatchSize: number;
  private readonly walletRequestConcurrency: number;
  private readonly maximumIndexCreditsPerMonth: number;
  private readonly maximumTotalHeliusCreditsPerMonth: number;
  private readonly enforceManagedCreditBudget: boolean;
  private readonly headSyncIntervalMs: number;
  private readonly programHeadMaintenanceEnabled: boolean;
  private readonly headMaximumRepairAgeMs: number;
  private readonly allowHeadEpochReseed: () => boolean;
  private readonly now: () => Date;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly indexer: HeliusProgramIndexer;
  private readonly rpc: HeliusIndexRpc;
  private readonly deepHistory: WalletDeepHistoryCoordinator | undefined;
  private readonly onResearchReady: ((generation: string) => void) | undefined;
  private readonly identityEvidenceEnabled: boolean;
  private readonly allowUnpricedStructuralCompletion: boolean;
  private readonly runManagedRecoveryPreflight: (() => Promise<boolean>) | undefined;
  private readonly solPriceUsdResolver: ((at: string) => Promise<number>) | undefined;
  private readonly workerId = `wallet-index-${randomUUID()}`;
  private stopped = false;
  private loopPromise: Promise<void> | undefined;
  private run: WalletIndexRun | undefined;
  private blockHydrationEnabled: boolean;
  private preferManagedDeepHistory = true;
  private lastResearchHandoffScanRevision: string | undefined;
  private managedRescueCreditFloorBlockedAtHeadroom: number | undefined;

  constructor(
    private readonly repository: Repository,
    heliusApiKey: string,
    private readonly events?: EventBus,
    options: WalletIndexWorkerOptions = {}
  ) {
    this.targetWallets = Math.max(1, Math.trunc(options.targetWallets ?? DEFAULT_WALLET_INDEX_TARGET));
    this.getTargetWallets = options.getTargetWallets ?? (() => this.targetWallets);
    this.canDiscoverPage = options.canDiscoverPage ?? (() => true);
    this.onAcquisitionPipelineDrained = options.onAcquisitionPipelineDrained;
    this.hydrationBatchSize = Math.max(1, Math.min(250, Math.trunc(options.hydrationBatchSize ?? 250)));
    this.preScreenBatchSize = Math.max(1, Math.min(100, Math.trunc(options.preScreenBatchSize ?? 10)));
    this.coarseBootstrapBatchSize = Math.max(
      1,
      Math.min(100, Math.trunc(options.coarseBootstrapBatchSize ?? 25))
    );
    this.walletRequestConcurrency = Math.max(
      1,
      Math.min(8, Math.trunc(options.walletRequestConcurrency ?? 4))
    );
    this.maximumIndexCreditsPerMonth = Math.max(
      1,
      Math.trunc(options.maximumIndexCreditsPerMonth ?? DEFAULT_WALLET_INDEX_MONTHLY_CREDIT_BUDGET)
    );
    this.maximumTotalHeliusCreditsPerMonth = Math.max(
      this.maximumIndexCreditsPerMonth,
      Math.trunc(options.maximumTotalHeliusCreditsPerMonth ?? DEFAULT_TOTAL_HELIUS_MONTHLY_CREDIT_BUDGET)
    );
    this.enforceManagedCreditBudget = options.enforceManagedCreditBudget ?? true;
    const headSyncIntervalMs = options.headSyncIntervalMs ?? 60_000;
    if (!Number.isSafeInteger(headSyncIntervalMs) || headSyncIntervalMs < 1_000) {
      throw new RangeError("headSyncIntervalMs must be an integer of at least 1000 milliseconds");
    }
    this.headSyncIntervalMs = headSyncIntervalMs;
    this.programHeadMaintenanceEnabled = options.programHeadMaintenanceEnabled ?? true;
    const headMaximumRepairAgeMs = options.headMaximumRepairAgeMs ?? DEFAULT_HEAD_MAXIMUM_REPAIR_AGE_MS;
    if (!Number.isSafeInteger(headMaximumRepairAgeMs) || headMaximumRepairAgeMs < 60_000) {
      throw new RangeError("headMaximumRepairAgeMs must be an integer of at least 60000 milliseconds");
    }
    this.headMaximumRepairAgeMs = headMaximumRepairAgeMs;
    this.allowHeadEpochReseed = options.allowHeadEpochReseed ?? (() => false);
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.onResearchReady = options.onResearchReady;
    this.identityEvidenceEnabled = options.identityEvidenceEnabled ?? false;
    const allowUnpricedStructuralCompletion =
      options.deepHistoryAllowUnpricedStructuralCompletion ?? false;
    if (allowUnpricedStructuralCompletion && this.identityEvidenceEnabled) {
      throw new Error(
        "Managed unpriced structural completion cannot be enabled with self-hosted identity evidence"
      );
    }
    this.allowUnpricedStructuralCompletion = allowUnpricedStructuralCompletion;
    this.runManagedRecoveryPreflight = options.runManagedRecoveryPreflight;
    this.solPriceUsdResolver = options.solPriceUsdResolver;
    this.blockHydrationEnabled = this.repository.getSetting<boolean>("helius_index_block_supported") !== false;
    const client = options.rpc ?? new HeliusRpcClient(heliusApiKey, {
      requestsPerSecond: options.requestsPerSecond ?? 8,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      tryReserve: ({ credits }) => this.reserveCredits(credits)
    });
    this.rpc = client;
    this.indexer = new HeliusProgramIndexer(client, {
      ...(options.programIds ? { programIds: options.programIds } : {}),
      signaturePageSize: options.signaturePageSize ?? 1_000,
      activityPageSize: options.activityPageSize ?? 1_000,
      maximumActivityPages: options.maximumActivityPages ?? 10,
      now: this.now
    });
    this.deepHistory = options.deepHistoryEnabled === false
      ? undefined
      : new WalletDeepHistoryCoordinator(this.repository, this.rpc, {
          targetLimit: options.deepHistoryTargetLimit ?? 100,
          pageSize: options.deepHistoryPageSize ?? 1_000,
          maximumPages: options.deepHistoryMaximumPages ?? 100,
          historyDays: options.deepHistoryDays ?? 90,
          includeExistingBacklog: options.deepHistoryIncludeExistingBacklog ?? false,
          allowUnpricedStructuralCompletion,
          ...(options.deepHistoryCanStartNextCohort
            ? { canStartNextCohort: options.deepHistoryCanStartNextCohort }
            : {}),
          canStartManagedRecovery: () =>
            (options.deepHistoryCanStartManagedRecovery?.() ?? false) &&
            this.availableCreditHeadroom() > MANAGED_DEEP_HISTORY_RESCUE_CREDIT_RESERVE,
          managedRecoveryCreditBudget: () => Math.max(
            0,
            this.availableCreditHeadroom() - MANAGED_DEEP_HISTORY_RESCUE_CREDIT_RESERVE
          ),
          ...(options.deepHistoryManagedRecoveryPreflightGate
            ? { managedRecoveryPreflightGate: options.deepHistoryManagedRecoveryPreflightGate }
            : {}),
          allowLegacyManagedRecoveryWithoutPreflight:
            options.deepHistoryAllowLegacyManagedRecoveryWithoutPreflight ?? false,
          includeFailedSignatures: this.identityEvidenceEnabled,
          identityEnabled: this.identityEvidenceEnabled,
          programIds: this.indexer.listPrograms(),
          ...(options.identityFirstPoolResolver
            ? { firstPoolResolver: options.identityFirstPoolResolver }
            : {}),
          now: this.now
        });
  }

  start(): void {
    if (this.loopPromise) return;
    const recovered = this.repository.recoverWalletIndexBatchFallbackFailures(this.now());
    if (recovered > 0) {
      this.repository.audit(
        "wallet_index_batch_failures_recovered",
        "Transactions affected by the retired Helius batch probe were returned to the standard hydration queue.",
        { recovered }
      );
    }
    this.stopped = false;
    this.loopPromise = this.loop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.loopPromise;
    this.loopPromise = undefined;
  }

  async runOnce(): Promise<boolean> {
    const run = this.ensureRun();
    const managedRescueOpen = isManagedDeepHistoryRescueCohort(
      this.repository.openWalletDeepHistoryCohort()?.id
    );
    if (!managedRescueOpen) {
      this.managedRescueCreditFloorBlockedAtHeadroom = undefined;
    } else if (this.managedRescueCreditFloorBlockedAtHeadroom !== undefined) {
      const availableHeadroom = this.availableCreditHeadroom();
      if (availableHeadroom > this.managedRescueCreditFloorBlockedAtHeadroom) {
        // A monthly reset (or an explicitly raised budget) may safely resume
        // the same immutable cohort without abandoning its partial evidence.
        this.managedRescueCreditFloorBlockedAtHeadroom = undefined;
      } else {
        if (run.stage !== "PAUSED" || run.error !== MANAGED_DEEP_HISTORY_RESCUE_FLOOR_PAUSE) {
          this.updateRun({ stage: "PAUSED", error: MANAGED_DEEP_HISTORY_RESCUE_FLOOR_PAUSE });
        }
        return false;
      }
    }
    this.repository.requeueExpiredWalletIndexLeases(this.now());
    // Provider scoring runs on its own fenced task. Publish any newly frozen
    // managed survivor batch before local head/backlog work so a busy global
    // program cannot delay the scarce-wallet decision funnel.
    const handoffCreated = this.enqueueResearchHandoffs();
    const hasCreditHeadroom = this.hasCreditHeadroom();
    const coverage = this.repository.walletIndexCoverage(this.now());
    const backlog = coverage.queueByStatus.PENDING + coverage.queueByStatus.RETRY;

    // Durable transaction hydration outranks local repricing. This prevents a
    // large SOL reprice queue from starving newly observed head transactions.
    if (hasCreditHeadroom && backlog > 0) {
      this.updateRun({ stage: "HYDRATION" });
      return this.hydrateBatch();
    }

    const handoffPending = handoffCreated || this.researchHandoffPending();
    let managedHistoryChecked = false;
    if (
      this.allowUnpricedStructuralCompletion &&
      this.preferManagedDeepHistory &&
      !handoffPending
    ) {
      managedHistoryChecked = true;
      const progressed = await this.runDeepHistoryOnce();
      if (progressed === true) {
        this.preferManagedDeepHistory = false;
        return true;
      }
    }

    // A frozen 90-day history cohort can take hours. Shadow and self-hosted
    // modes retain their independent confirmed program head. MANAGED disables
    // that global maintenance path and relies on wallet-scoped leader safety.
    if (
      hasCreditHeadroom &&
      this.programHeadMaintenanceEnabled &&
      this.repository.openWalletDeepHistoryCohort() !== undefined &&
      this.hasBootstrapHeadAnchor()
    ) {
      const headProgressed = await this.syncHeadPageIfDue();
      if (headProgressed) {
        this.preferManagedDeepHistory = true;
        return true;
      }
    }

    // A managed provider handoff always fences additional history and discovery
    // work. Self-hosted identity repair may continue after its cohort closes.
    if (handoffPending) {
      const openCohort = this.repository.openWalletDeepHistoryCohort();
      if (!this.allowUnpricedStructuralCompletion) {
        if (openCohort !== undefined) return handoffCreated;
      } else {
        let completedNow = false;
        if (openCohort === undefined) {
          completedNow = this.completeRun(run, this.repository.walletIndexCoverage(this.now()));
        }
        if (completedNow || handoffCreated || openCohort !== undefined || !this.programHeadMaintenanceEnabled) {
          return handoffCreated;
        }
        // Legacy shadow/self-hosted maintenance may keep its bounded analysis
        // head fresh while provider qualification is pending. MANAGED disables
        // this option in Runtime, so no global request can compete there.
        return this.syncHeadPageIfDue();
      }
    }

    // Managed qualification gets profitability and concentration from the
    // authenticated providers, so its immutable structural cohort must not be
    // starved behind the independent 90-day local SOL reprice queue.
    if (this.allowUnpricedStructuralCompletion && !managedHistoryChecked) {
      const progressed = await this.runDeepHistoryOnce();
      if (progressed === true) {
        this.preferManagedDeepHistory = false;
        return true;
      }
    }

    // Once normal managed history has drained, spend cheap provider evidence
    // before scarce index credits. A PASS is only an authorization to open the
    // exact v3 cohort; every unchanged qualification rule still runs later.
    if (
      this.allowUnpricedStructuralCompletion &&
      !handoffPending &&
      this.runManagedRecoveryPreflight &&
      this.availableCreditHeadroom() > MANAGED_DEEP_HISTORY_RESCUE_CREDIT_RESERVE &&
      await this.runManagedRecoveryPreflight()
    ) {
      this.preferManagedDeepHistory = true;
      return true;
    }

    // SELF_HOSTED ranking requires complete at-or-before prices, so preserve
    // its price-first behavior. MANAGED gets PnL from providers and deliberately
    // leaves the large local SOL reprice queue behind the full scoring funnel.
    if (!this.allowUnpricedStructuralCompletion && await this.repriceOne()) return true;
    if (this.repository.listDirtyWalletIndexRecords(1).length > 0) {
      this.updateRun({ stage: "HYDRATION" });
      await this.materializeDirtyWallets();
      this.events?.publish("wallet-index", this.repository.walletIndexCoverage(this.now()));
      return true;
    }
    if (!hasCreditHeadroom) {
      if (run.stage !== "PAUSED") {
        this.updateRun({ stage: "PAUSED", error: "Monthly Helius index credit reserve reached." });
        this.repository.audit(
          "wallet_index_paused",
          "Local wallet indexing paused before the configured Helius credit reserve was exhausted.",
          this.repository.walletIndexCoverage(),
          "warning"
        );
      }
      return false;
    }

    const pending = this.repository.listWalletsAwaitingPreScreen(this.preScreenBatchSize);
    // In MANAGED mode, materialized wallets must be pre-screened before another
    // program page is allowed. This turns a 5,000-wallet target into bounded
    // hydrate -> screen -> history cycles instead of a discovery traffic jam.
    if (this.allowUnpricedStructuralCompletion && pending.length > 0) {
      this.updateRun({ stage: "PRESCREEN" });
      await this.preScreen(pending);
      return true;
    }

    const coarseTarget = this.currentTargetWallets();
    const coarseGenerationDrained = !this.allowUnpricedStructuralCompletion ||
      this.deepHistory?.managedGenerationDrained() !== false;
    if (
      coarseGenerationDrained &&
      this.repository.walletIndexCoverage(this.now()).indexedWallets < coarseTarget &&
      await this.bootstrapCoarseWalletCandidates(coarseTarget)
    ) return true;

    const targetWallets = this.currentTargetWallets();
    const managedGenerationDrained = !this.allowUnpricedStructuralCompletion ||
      this.deepHistory?.managedGenerationDrained() !== false;
    if (coverage.indexedWallets < targetWallets && managedGenerationDrained) {
      // This is intentionally adjacent to the network call. A paper-cohort
      // freeze or monthly-budget transition cannot be hidden by stale loop
      // state captured earlier in the turn.
      const allowed = !this.allowUnpricedStructuralCompletion || this.canDiscoverPage();
      if (allowed) {
        const discovered = await this.discoverPage();
        if (discovered) return true;
      }
    }

    // Preserve the historical SELF_HOSTED order: discovery precedes its
    // ordinary pre-screen batch, but both remain behind strict SOL repricing.
    if (!this.allowUnpricedStructuralCompletion && pending.length > 0) {
      this.updateRun({ stage: "PRESCREEN" });
      await this.preScreen(pending);
      return true;
    }

    if (!this.allowUnpricedStructuralCompletion) {
      const progressed = await this.runDeepHistoryOnce();
      if (progressed !== undefined) return progressed;
    }

    this.enqueueResearchHandoffs();

    if (this.allowUnpricedStructuralCompletion && this.onAcquisitionPipelineDrained) {
      if (this.deepHistory?.managedGenerationDrained() === false) {
        // A screened 100-wallet cohort is not the acquisition boundary. Keep
        // the persisted target fenced until its entire frozen generation is
        // certified MANAGED_SCREENED (or exactly COMPLETE).
        if (await this.repriceOne()) return true;
        return false;
      }
      const finalCoverage = this.repository.walletIndexCoverage(this.now());
      this.completeRun(run, finalCoverage);
      const sourceExhausted = finalCoverage.indexedWallets < targetWallets && this.discoverySourceExhausted();
      if (this.onAcquisitionPipelineDrained(sourceExhausted)) {
        // The next target is a separate durable acquisition tranche.
        this.run = undefined;
        return true;
      }
      // No managed acquisition/scoring seam is runnable. Only now may local
      // price evidence consume a worker turn.
      if (await this.repriceOne()) return true;
      return false;
    }

    const finalCoverage = this.repository.walletIndexCoverage(this.now());
    if (this.completeRun(run, finalCoverage)) return false;

    // Bootstrap is complete, so keep its immutable newest-signature anchor
    // current. Head history remains an analysis-only queue and never enters
    // source_events or the trading/signing path.
    if (this.programHeadMaintenanceEnabled) {
      const headProgressed = await this.syncHeadPageIfDue();
      if (headProgressed) return true;
    }
    return this.deepHistory?.reclassifyUnknownIdentityOnce() ?? false;
  }

  private currentTargetWallets(): number {
    const target = this.getTargetWallets();
    if (!Number.isSafeInteger(target) || target < 1) {
      throw new Error("Wallet acquisition target must be a positive safe integer.");
    }
    return target;
  }

  private discoverySourceExhausted(): boolean {
    const programId = this.indexer.listPrograms()[0];
    return programId
      ? this.repository.getWalletIndexCheckpoint(PIPELINE, programId)?.completed === true
      : true;
  }

  private completeRun(run: WalletIndexRun, coverage: ReturnType<Repository["walletIndexCoverage"]>): boolean {
    const current = this.run ?? run;
    if (current.stage === "COMPLETE") return false;
    this.updateRun({
      stage: "COMPLETE",
      finishedAt: this.now().toISOString(),
      discoveredWallets: coverage.indexedWallets,
      structuralCandidates: this.deepHistory
        ? this.repository.listWalletIndexResearchShortlist(100).length
        : 0
    });
    this.repository.audit("wallet_index_complete", "Local wallet index bootstrap completed.", coverage);
    this.events?.publish("wallet-index", coverage);
    return true;
  }

  private enqueueResearchHandoffs(): boolean {
    if (!this.deepHistory) return false;
    const revision = this.repository.walletResearchHandoffScanRevision();
    if (revision === this.lastResearchHandoffScanRevision) return false;
    let createdAny = false;
    const handoffs = this.repository.listAllWalletResearchHandoffs();
    const completedProviderWallets = this.allowUnpricedStructuralCompletion
      ? new Set(this.repository.listCompletedLocalProviderQualificationWallets())
      : undefined;
    const completed = this.repository.listUnhandedCompletedWalletDeepHistoryCohortEvidence();
    for (const completedCohort of completed) {
      const evidence = completedCohort.evidence;
      const partialPrefixes = [
        COMPLETE_LOCAL_WALLET_RESEARCH_PIPELINE_VERSION,
        PARTIAL_RESEARCH_PIPELINE_VERSION
      ].map((version) =>
        `local-index-${version}-partial:${completedCohort.generationId}:${completedCohort.cohortId}:`
      );
      const alreadyHanded = new Set(
        handoffs
          .filter((handoff) => partialPrefixes.some((prefix) => handoff.generation.startsWith(prefix)))
          .flatMap((handoff) => handoff.wallets)
      );
      if (this.identityEvidenceEnabled) {
        const unresolvedStructuralIdentity = evidence.some(({ record }) => {
          return record?.preScreenEligible && record.deepHistoryStatus === "COMPLETE" &&
            record.structuralEligible && !(
              (record.walletIdentityStatus === "VERIFIED" || record.walletIdentityStatus === "REJECTED") &&
              record.walletIdentitySource === LOCAL_WALLET_IDENTITY_SOURCE
            );
        });
        if (unresolvedStructuralIdentity) continue;
      }
      const wallets = evidence
        .flatMap(({ record }) => {
          const identityReady = !this.identityEvidenceEnabled || (
            (record?.walletIdentityStatus === "VERIFIED" || record?.walletIdentityStatus === "REJECTED") &&
            record.walletIdentitySource === LOCAL_WALLET_IDENTITY_SOURCE
          );
          return record?.preScreenEligible && record.deepHistoryStatus === "COMPLETE" &&
            record.structuralEligible && identityReady && !alreadyHanded.has(record.wallet) &&
            (!this.allowUnpricedStructuralCompletion ||
              !completedProviderWallets?.has(record.wallet))
            ? [record]
            : [];
        })
        .sort((left, right) =>
          right.closedEligibleSwaps - left.closedEligibleSwaps ||
          right.historyDays - left.historyDays ||
          right.activeWeeks - left.activeWeeks ||
          right.medianHoldingMinutes - left.medianHoldingMinutes ||
          left.wallet.localeCompare(right.wallet)
        )
        .slice(0, DEFAULT_LOCAL_RESEARCH_LIMIT)
        .map((record) => record.wallet);
      // Handoff each immutable 100-wallet cohort as soon as it completes.
      // Waiting for an entire multi-cohort generation would outrun provider
      // quotas and delay the first possible forward paper cohort.
      const generation =
        `local-index-${COMPLETE_LOCAL_WALLET_RESEARCH_PIPELINE_VERSION}:` +
        `${completedCohort.generationId}:${completedCohort.cohortId}`;
      const readyAt = this.now().toISOString();
      const created = this.repository.enqueueWalletResearchHandoff({
        generation,
        runId: this.ensureRun().id,
        wallets,
        readyAt
      });
      if (!created) continue;
      createdAny = true;
      this.repository.audit(
        "wallet_research_ready",
        completedCohort.generationSequence === 1
          ? "The completed local wallet cohort is ready for provider qualification."
          : "A completed shadow wallet cohort is ready for provider qualification without active-wallet rotation.",
        {
          generation,
          deepHistoryGenerationId: completedCohort.generationId,
          deepHistoryCohortId: completedCohort.cohortId,
          sequence: completedCohort.generationSequence,
          wallets: wallets.length,
          targetWallets: evidence.length
        }
      );
      this.events?.publish("wallet-research-ready", { generation, wallets: wallets.length });
      try {
        this.onResearchReady?.(generation);
      } catch (error) {
        this.repository.audit(
          "wallet_research_ready_callback_failed",
          errorText(error),
          { generation },
          "warning"
        );
      }
    }
    if (!createdAny && !this.identityEvidenceEnabled) {
      createdAny = this.enqueuePartialManagedResearchHandoff(handoffs, completedProviderWallets);
    }
    // Re-read after the scan because a newly enqueued handoff changes the
    // durable revision. A later READY/RUNNING/RETRY/COMPLETE transition or new
    // frozen evidence will change it again and make the next scan runnable.
    this.lastResearchHandoffScanRevision = this.repository.walletResearchHandoffScanRevision();
    return createdAny;
  }

  private researchHandoffPending(): boolean {
    return this.repository.hasPendingWalletResearchHandoffs();
  }

  /**
   * MANAGED mode may pass individually frozen structural evidence to the
   * authoritative Birdeye + Helius qualification policy before the enclosing
   * local ranking generation finishes. This never claims local discovery
   * parity: SELF_HOSTED keeps requiring a fully priced COMPLETE generation.
   */
  private enqueuePartialManagedResearchHandoff(
    handoffs: ReturnType<Repository["listAllWalletResearchHandoffs"]>,
    completedProviderWallets: ReadonlySet<string> | undefined
  ): boolean {
    if (handoffs.some((handoff) => handoff.status !== "COMPLETE")) return false;
    // Evidence-first repository grouping omits the potentially unbounded
    // history of zero-evidence, coarsely skipped cohorts. MANAGED_SCREENED
    // cohorts remain included when exact evidence was frozen before screening.
    for (const cohort of this.repository.listOpenWalletDeepHistoryCohortEvidence()) {
      const prefix = `local-index-${PARTIAL_RESEARCH_PIPELINE_VERSION}-partial:${cohort.generationId}:${cohort.cohortId}:`;
      const alreadyHanded = new Set(
        handoffs
          .filter((handoff) => handoff.generation.startsWith(prefix))
          .flatMap((handoff) => handoff.wallets)
      );
      const readyEvidence = cohort.evidence
        .filter(({ record }) =>
          record.preScreenEligible &&
          record.deepHistoryStatus === "COMPLETE" &&
          record.structuralEligible &&
          !alreadyHanded.has(record.wallet) &&
          (!this.allowUnpricedStructuralCompletion ||
            !completedProviderWallets?.has(record.wallet))
        )
        .sort((left, right) =>
          right.record.closedEligibleSwaps - left.record.closedEligibleSwaps ||
          right.record.historyDays - left.record.historyDays ||
          right.record.activeWeeks - left.record.activeWeeks ||
          right.record.medianHoldingMinutes - left.record.medianHoldingMinutes ||
          left.wallet.localeCompare(right.wallet)
        )
        .slice(0, PARTIAL_RESEARCH_BATCH_LIMIT);
      if (readyEvidence.length < PARTIAL_RESEARCH_MINIMUM) continue;
      const digest = createHash("sha256")
        .update(readyEvidence.map((entry) => `${entry.wallet}:${entry.evidenceDigest}`).join("|"))
        .digest("hex")
        .slice(0, 24);
      const generation = `${prefix}${digest}`;
      const wallets = readyEvidence.map((entry) => entry.wallet);
      const readyAt = this.now().toISOString();
      if (!this.repository.enqueueWalletResearchHandoff({
        generation,
        runId: this.ensureRun().id,
        wallets,
        readyAt
      })) continue;
      this.repository.audit(
        "wallet_research_partial_ready",
        "A bounded set of immutable structural survivors is ready for managed provider qualification.",
        {
          generation,
          deepHistoryGenerationId: cohort.generationId,
          deepHistoryCohortId: cohort.cohortId,
          deepHistoryCohortSequence: cohort.sequence,
          deepHistoryCohortStatus: cohort.status,
          wallets: wallets.length,
          minimumBatch: PARTIAL_RESEARCH_MINIMUM,
          localGenerationStillOpen: true
        }
      );
      this.events?.publish("wallet-research-ready", { generation, wallets: wallets.length });
      try {
        this.onResearchReady?.(generation);
      } catch (error) {
        this.repository.audit(
          "wallet_research_ready_callback_failed",
          errorText(error),
          { generation },
          "warning"
        );
      }
      return true;
    }
    return false;
  }

  private async runDeepHistoryOnce(): Promise<boolean | undefined> {
    if (!this.deepHistory) return undefined;
    const cohortBefore = this.repository.openWalletDeepHistoryCohort()?.id;
    const generationBefore = this.repository.openWalletDeepHistoryGeneration()?.id;
    const before = this.deepHistory.progress();
    if (before.targets === 0) return undefined;
    if (before.pending === 0) {
      // progress() terminalizes one fully screened cohort. Immediately roll
      // the same immutable generation forward (or certify the generation)
      // before the worker can consider discovery or target advancement. Give
      // Fastify, provider heartbeats, and repair work one event-loop turn
      // between the two synchronous SQLite phases so a rapid managed rollover
      // cannot make the loopback dashboard appear unavailable.
      await new Promise<void>((resolve) => setImmediate(resolve));
      const after = this.deepHistory.progress();
      this.updateRun({
        stage: "HISTORY",
        structuralCandidates: this.repository.listWalletIndexResearchShortlist(100).length
      });
      this.enqueueResearchHandoffs();
      this.events?.publish("wallet-index-deep-history", after);
      const cohortAfter = this.repository.openWalletDeepHistoryCohort()?.id;
      const generationAfter = this.repository.openWalletDeepHistoryGeneration()?.id;
      return cohortBefore !== cohortAfter || generationBefore !== generationAfter
        ? true
        : undefined;
    }
    this.updateRun({ stage: "HISTORY" });
    const progressed = await this.deepHistory.runOnce();
    const after = this.deepHistory.progress();
    this.updateRun({
      stage: "HISTORY",
      structuralCandidates: this.repository.listWalletIndexResearchShortlist(100).length
    });
    this.enqueueResearchHandoffs();
    this.events?.publish("wallet-index-deep-history", after);
    return progressed;
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        const progressed = await this.runOnce();
        if (!progressed) {
          await this.sleep(5_000);
        } else {
          // Many local-only turns complete through already-resolved promises.
          // Yield a macrotask before starting the next turn so a long reprice,
          // dirty-wallet, or cohort backlog cannot monopolize the loopback
          // server through an unbroken microtask chain.
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      } catch (error) {
        const message = errorText(error);
        if (error instanceof HeliusRpcBudgetError) {
          this.updateRun({ stage: "PAUSED", error: message });
        } else {
          this.updateRun({ stage: "FAILED", error: message, finishedAt: this.now().toISOString() });
        }
        this.repository.audit("wallet_index_error", message, undefined, "warning");
        this.events?.publish("wallet-index-error", { message });
        await this.sleep(5_000);
      }
    }
  }

  /**
   * Revalidates a bounded, activity-ranked slice of already indexed program
   * transactions. Stored fee-payer metadata is never enough on its own: the
   * raw transaction must still prove success, one signer, and a top-level
   * Jupiter invocation before the wallet enters the pre-screen queue.
   */
  private async bootstrapCoarseWalletCandidates(targetWallets: number): Promise<boolean> {
    const coverage = this.repository.walletIndexCoverage(this.now());
    const remaining = Math.max(0, targetWallets - coverage.indexedWallets);
    if (remaining === 0) return false;
    const programs = this.indexer.listPrograms().filter((program) =>
      JUPITER_COARSE_WALLET_PROGRAM_IDS.has(program)
    );
    const candidates = this.repository.listCoarseWalletBootstrapCandidates(
      programs,
      WALLET_DISCOVERY_ATTRIBUTION_SOURCES,
      Math.min(remaining, this.coarseBootstrapBatchSize)
    );
    if (candidates.length === 0) return false;
    let progressed = false;
    for (let offset = 0; offset < candidates.length; offset += this.walletRequestConcurrency) {
      const batch = candidates.slice(offset, offset + this.walletRequestConcurrency);
      const payloads = await Promise.allSettled(
        batch.map((candidate) => this.rpc.getTransaction(candidate.signature))
      );
      // Provider reads overlap, but every decision is committed in the stable
      // activity-ranked order returned by SQLite. That keeps target admission
      // deterministic across restarts and across different network timings.
      for (let index = 0; index < batch.length; index += 1) {
        if (this.repository.walletIndexCoverage(this.now()).indexedWallets >= targetWallets) break;
        const candidate = batch[index];
        const payload = payloads[index];
        if (!candidate || !payload) continue;
        if (payload.status === "rejected") throw payload.reason;
        const raw = payload.value;
        // A temporarily unavailable confirmed payload is left unclassified so a
        // later worker turn can retry it instead of persisting a false rejection.
        if (raw === null) continue;
        const decision = classifyCoarseJupiterWalletCandidate(
          candidate.programId,
          candidate.signature,
          raw,
          this.now()
        );
        if (decision.accepted) {
          const admission = materializeCoarseWalletCandidate(
            this.repository,
            decision,
            targetWallets,
            candidate.observedSuccessfulTransactions
          );
          progressed ||= admission !== "TARGET_REACHED";
        } else {
          progressed = recordRejectedCoarseWalletCandidate(
            this.repository,
            decision,
            candidate.observedSuccessfulTransactions
          ) || progressed;
        }
      }
      if (this.repository.walletIndexCoverage(this.now()).indexedWallets >= targetWallets) break;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    if (progressed) this.events?.publish("wallet-index", this.repository.walletIndexCoverage(this.now()));
    return progressed;
  }

  private async discoverPage(): Promise<boolean> {
    this.updateRun({ stage: "DISCOVERY" });
    // Jupiter v6 is the productive discovery source. V4 remains approved for
    // strict decoding and historical cross-checks, but a live probe showed its
    // address pages were sparse references with no eligible swaps, so bulk
    // crawling them would waste free-tier credits.
    const programId = this.indexer.listPrograms()[0];
    if (!programId) return false;
    const checkpoint = this.repository.getWalletIndexCheckpoint(PIPELINE, programId);
    if (checkpoint?.completed) return false;
    const page = await this.indexer.fetchProgramSignatures(programId, checkpoint?.beforeSignature);
    const discoveredAt = this.now().toISOString();
    const items = page.signatures.map((signature) => ({
      signature: signature.signature,
      sourceAddress: programId,
      source: "helius-program-signature",
      discoveredAt,
      runId: this.ensureRun().id,
      slot: signature.slot,
      ...(signature.blockTime !== undefined
        ? { blockTime: new Date(signature.blockTime * 1_000).toISOString() }
        : {}),
      metadata: {
        failed: signature.failed,
        ...(signature.confirmationStatus ? { confirmationStatus: signature.confirmationStatus } : {})
      }
    }));
    const enqueue = { observations: 0, enqueued: 0, deduplicated: 0, sourcesAdded: 0 };
    for (let offset = 0; offset < items.length; offset += DISCOVERY_ENQUEUE_CHUNK_SIZE) {
      const committed = this.repository.enqueueWalletIndexTransactions(
        items.slice(offset, offset + DISCOVERY_ENQUEUE_CHUNK_SIZE)
      );
      enqueue.observations += committed.observations;
      enqueue.enqueued += committed.enqueued;
      enqueue.deduplicated += committed.deduplicated;
      enqueue.sourcesAdded += committed.sourcesAdded;
      if (offset + DISCOVERY_ENQUEUE_CHUNK_SIZE < items.length) {
        // Each chunk is independently idempotent. A crash before the page
        // checkpoint simply replays already committed signatures, while this
        // yield keeps static files and loopback controls responsive during a
        // large 1,000-signature discovery-page commit.
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    const pageNumber = Number(checkpoint?.metadata?.pages ?? 0) + 1;
    const pageHead = page.signatures[0];
    const pageTail = page.signatures.at(-1);
    this.repository.saveWalletIndexCheckpoint({
      pipeline: PIPELINE,
      partition: programId,
      completed: page.exhausted,
      updatedAt: discoveredAt,
      ...(page.nextBefore ? { beforeSignature: page.nextBefore } : {}),
      ...(checkpoint?.lastSignature
        ? { lastSignature: checkpoint.lastSignature }
        : page.signatures[0]?.signature
          ? { lastSignature: page.signatures[0].signature }
          : {}),
      ...(checkpoint?.slot !== undefined
        ? { slot: checkpoint.slot }
        : pageHead?.slot !== undefined
          ? { slot: pageHead.slot }
          : {}),
      ...(checkpoint?.blockTime
        ? { blockTime: checkpoint.blockTime }
        : pageHead?.blockTime !== undefined
          ? { blockTime: new Date(pageHead.blockTime * 1_000).toISOString() }
          : {}),
      metadata: {
        pages: pageNumber,
        observations: enqueue.observations,
        ...(pageTail?.slot !== undefined ? { tailSlot: pageTail.slot } : {}),
        ...(pageTail?.blockTime !== undefined
          ? { tailBlockTime: new Date(pageTail.blockTime * 1_000).toISOString() }
          : {})
      }
    });
    this.updateRun({ enqueuedSignatures: this.ensureRun().enqueuedSignatures + enqueue.enqueued });
    this.events?.publish("wallet-index", this.repository.walletIndexCoverage(this.now()));
    return page.signatures.length > 0;
  }

  /**
   * Fetch at most one head page per worker turn. A separate checkpoint keeps
   * the committed high-water signature stable while a multi-page gap is being
   * traversed. That makes enqueue + checkpoint updates restart-safe: a crash
   * can replay a page (global signature dedupe makes that harmless), but it
   * cannot skip the remaining pages by committing the new head too early.
   */
  private async syncHeadPageIfDue(): Promise<boolean> {
    for (const programId of this.indexer.listPrograms()) {
      const bootstrap = this.repository.getWalletIndexCheckpoint(PIPELINE, programId);
      const checkpoint = this.repository.getWalletIndexCheckpoint(HEAD_PIPELINE, programId);
      const hasCursor = Boolean(checkpoint?.cursor);
      const hasBefore = Boolean(checkpoint?.beforeSignature);
      if (hasCursor !== hasBefore) {
        throw new Error(`Wallet index head checkpoint is incomplete for program ${programId}`);
      }

      const inProgress = hasCursor && hasBefore;
      if (!inProgress && checkpoint) {
        const updatedAt = Date.parse(checkpoint.updatedAt);
        if (Number.isFinite(updatedAt) && this.now().getTime() - updatedAt < this.headSyncIntervalMs) continue;
      }

      const committedHead = checkpoint?.lastSignature ?? bootstrap?.lastSignature;
      if (!committedHead) {
        // Newly enabled direct-DEX programs deliberately do not trigger an
        // unbounded historical crawl after the 5,000-wallet bootstrap. Seed a
        // one-signature durable head, enqueue that exact transaction, and let
        // ordinary bounded head repair cover everything that follows.
        const seed = (await this.rpc.getSignaturesForAddress(programId, { limit: 1 }))[0];
        const seededAt = this.now().toISOString();
        let enqueued = 0;
        if (seed) {
          enqueued = this.repository.enqueueWalletIndexTransactions([{
            signature: seed.signature,
            sourceAddress: programId,
            source: "helius-program-head",
            discoveredAt: seededAt,
            runId: this.ensureRun().id,
            slot: seed.slot,
            ...(seed.blockTime !== undefined
              ? { blockTime: new Date(seed.blockTime * 1_000).toISOString() }
              : {}),
            metadata: {
              headSeed: true,
              failed: seed.failed,
              ...(seed.confirmationStatus ? { confirmationStatus: seed.confirmationStatus } : {})
            }
          }]).enqueued;
        }
        this.repository.saveWalletIndexCheckpoint({
          pipeline: HEAD_PIPELINE,
          partition: programId,
          completed: false,
          updatedAt: seededAt,
          ...(seed ? {
            lastSignature: seed.signature,
            slot: seed.slot,
            ...(seed.blockTime !== undefined
              ? { blockTime: new Date(seed.blockTime * 1_000).toISOString() }
              : {})
          } : {}),
          metadata: {
            seededAt,
            lastPageCount: seed ? 1 : 0,
            // A one-signature seed cannot prove that the rest of its slot was
            // traversed. Coverage starts at the following slot and remains
            // uncommitted until a later head cycle crosses that boundary.
            ...(seed ? { coverageStartSlot: seed.slot + 1 } : {})
          }
        });
        if (enqueued > 0) {
          this.updateRun({ enqueuedSignatures: this.ensureRun().enqueuedSignatures + enqueued });
          this.events?.publish("wallet-index", this.repository.walletIndexCoverage(this.now()));
        }
        return true;
      }
      const committedBlockTime = checkpoint?.blockTime ?? bootstrap?.blockTime;
      const committedAt = committedBlockTime ? Date.parse(committedBlockTime) : Number.NaN;
      if (
        this.enforceManagedCreditBudget &&
        Number.isFinite(committedAt) &&
        this.now().getTime() - committedAt > this.headMaximumRepairAgeMs
      ) {
        return this.resolveOversizedManagedHeadGap(
          programId,
          committedHead,
          bootstrap,
          checkpoint,
          inProgress
        );
      }
      const until = inProgress ? checkpoint?.cursor : committedHead;
      const before = inProgress ? checkpoint?.beforeSignature : undefined;
      if (!until) throw new Error(`Wallet index head checkpoint has no anchor for program ${programId}`);
      if (before === until) throw new Error(`Wallet index head cursor equals its anchor for program ${programId}`);

      const page = await this.indexer.fetchProgramSignatures(programId, before, until);
      if (page.signatures.some((signature) => signature.signature === until)) {
        throw new Error(`Wallet index head page crossed its committed anchor for program ${programId}`);
      }
      const discoveredAt = this.now().toISOString();
      const enqueue = this.repository.enqueueWalletIndexTransactions(
        page.signatures.map((signature) => ({
          signature: signature.signature,
          sourceAddress: programId,
          source: "helius-program-head",
          discoveredAt,
          runId: this.ensureRun().id,
          slot: signature.slot,
          ...(signature.blockTime !== undefined
            ? { blockTime: new Date(signature.blockTime * 1_000).toISOString() }
            : {}),
          metadata: {
            headSync: true,
            failed: signature.failed,
            ...(signature.confirmationStatus ? { confirmationStatus: signature.confirmationStatus } : {})
          }
        }))
      );

      const previousMetadata = checkpoint?.metadata ?? {};
      const bootstrapMetadata = bootstrap?.metadata ?? {};
      const totalPages = this.metadataNumber(previousMetadata, "pages") + 1;
      const totalObservations = this.metadataNumber(previousMetadata, "observations") + enqueue.observations;
      const cyclePages = inProgress ? this.metadataNumber(previousMetadata, "cyclePages") + 1 : 1;
      const first = page.signatures[0];
      const candidateHead = inProgress
        ? this.metadataString(previousMetadata, "candidateHeadSignature")
        : first?.signature ?? committedHead;
      if (!candidateHead) {
        throw new Error(`Wallet index head checkpoint lost its candidate signature for program ${programId}`);
      }
      const candidateSlot = inProgress
        ? this.metadataNumberOrUndefined(previousMetadata, "candidateHeadSlot")
        : first?.slot;
      const candidateBlockTime = inProgress
        ? this.metadataString(previousMetadata, "candidateHeadBlockTime")
        : first?.blockTime !== undefined
          ? new Date(first.blockTime * 1_000).toISOString()
          : undefined;
      const coverageStartSlot = this.metadataNumberOrUndefined(previousMetadata, "coverageStartSlot")
        ?? (() => {
          const bootstrapTail = this.metadataNumberOrUndefined(bootstrapMetadata, "tailSlot");
          if (bootstrapTail !== undefined) return bootstrapTail + 1;
          if (bootstrap?.slot !== undefined) return bootstrap.slot + 1;
          if (checkpoint?.slot !== undefined) return checkpoint.slot + 1;
          return undefined;
        })();
      const committedCoverageEndSlot = this.metadataNumberOrUndefined(previousMetadata, "coverageEndSlot")
        ?? (checkpoint?.slot !== undefined
          ? checkpoint.slot
          : bootstrap?.slot !== undefined
            ? Math.max(0, bootstrap.slot - 1)
            : undefined);
      const finishedCycle = page.exhausted;
      const confirmsSeedOnlyRange = finishedCycle && page.signatures.length === 0 &&
        checkpoint?.slot !== undefined && (
          typeof previousMetadata.seededAt === "string" ||
          typeof previousMetadata.reseededAt === "string"
        );
      // A second empty poll after a one-signature seed proves that no newer
      // signature (including one in the same slot) was skipped. Represent that
      // exact one-slot signature range as continuous instead of waiting forever
      // for an inactive legacy program to emit another transaction.
      const effectiveCoverageStartSlot = confirmsSeedOnlyRange
        ? checkpoint.slot as number
        : coverageStartSlot;
      const effectiveCoverageEndSlot = confirmsSeedOnlyRange
        ? checkpoint.slot as number
        : candidateSlot !== undefined &&
            (coverageStartSlot === undefined || candidateSlot >= coverageStartSlot)
          ? candidateSlot
          : committedCoverageEndSlot !== undefined &&
              (coverageStartSlot === undefined || committedCoverageEndSlot >= coverageStartSlot)
            ? committedCoverageEndSlot
            : undefined;
      if (!finishedCycle && !page.nextBefore) {
        throw new Error(`Wallet index head page has no advancing cursor for program ${programId}`);
      }

      this.repository.saveWalletIndexCheckpoint({
        pipeline: HEAD_PIPELINE,
        partition: programId,
        completed: false,
        updatedAt: discoveredAt,
        lastSignature: finishedCycle ? candidateHead : committedHead,
        ...(finishedCycle
          ? {}
          : {
              cursor: until,
              beforeSignature: page.nextBefore as string
            }),
        ...(finishedCycle
          ? candidateSlot !== undefined
            ? { slot: candidateSlot }
            : checkpoint?.slot !== undefined
              ? { slot: checkpoint.slot }
              : {}
          : checkpoint?.slot !== undefined
            ? { slot: checkpoint.slot }
            : bootstrap?.slot !== undefined
              ? { slot: bootstrap.slot }
              : {}),
        ...(finishedCycle
          ? candidateBlockTime
            ? { blockTime: candidateBlockTime }
            : checkpoint?.blockTime
              ? { blockTime: checkpoint.blockTime }
              : {}
          : checkpoint?.blockTime
            ? { blockTime: checkpoint.blockTime }
            : bootstrap?.blockTime
              ? { blockTime: bootstrap.blockTime }
              : {}),
        metadata: finishedCycle
          ? {
              pages: totalPages,
              observations: totalObservations,
              cycles: this.metadataNumber(previousMetadata, "cycles") + 1,
              lastCyclePages: cyclePages,
              lastPageCount: page.signatures.length,
              lastSyncedAt: discoveredAt,
              ...(typeof previousMetadata.headEpoch === "number"
                ? { headEpoch: previousMetadata.headEpoch }
                : {}),
              ...(typeof previousMetadata.reseededAt === "string"
                ? { reseededAt: previousMetadata.reseededAt }
                : {}),
              ...(typeof previousMetadata.gapReason === "string"
                ? { gapReason: previousMetadata.gapReason }
                : {}),
              ...(typeof previousMetadata.abandonedFromSlot === "number"
                ? { abandonedFromSlot: previousMetadata.abandonedFromSlot }
                : {}),
              ...(typeof previousMetadata.abandonedFromBlockTime === "string"
                ? { abandonedFromBlockTime: previousMetadata.abandonedFromBlockTime }
                : {}),
              ...(typeof previousMetadata.abandonedToSlot === "number"
                ? { abandonedToSlot: previousMetadata.abandonedToSlot }
                : {}),
              ...(typeof previousMetadata.abandonedToBlockTime === "string"
                ? { abandonedToBlockTime: previousMetadata.abandonedToBlockTime }
                : {}),
              ...(typeof previousMetadata.abandonedCatchupPages === "number"
                ? { abandonedCatchupPages: previousMetadata.abandonedCatchupPages }
                : {}),
              ...(effectiveCoverageStartSlot !== undefined
                ? { coverageStartSlot: effectiveCoverageStartSlot }
                : {}),
              ...(effectiveCoverageEndSlot !== undefined
                ? { coverageEndSlot: effectiveCoverageEndSlot }
                : {})
            }
          : {
              pages: totalPages,
              observations: totalObservations,
              cycles: this.metadataNumber(previousMetadata, "cycles"),
              cyclePages,
              lastPageCount: page.signatures.length,
              catchupStartedAt: inProgress
                ? this.metadataString(previousMetadata, "catchupStartedAt") ?? discoveredAt
                : discoveredAt,
              candidateHeadSignature: candidateHead,
              ...(candidateSlot !== undefined ? { candidateHeadSlot: candidateSlot } : {}),
              ...(candidateBlockTime ? { candidateHeadBlockTime: candidateBlockTime } : {}),
              ...(coverageStartSlot !== undefined ? { coverageStartSlot } : {}),
              ...(committedCoverageEndSlot !== undefined &&
                (coverageStartSlot === undefined || committedCoverageEndSlot >= coverageStartSlot)
                ? { coverageEndSlot: committedCoverageEndSlot }
                : {})
            }
      });
      this.updateRun({ enqueuedSignatures: this.ensureRun().enqueuedSignatures + enqueue.enqueued });
      if (finishedCycle && enqueue.enqueued > 0) {
        this.repository.audit("wallet_index_head_synced", "New confirmed program signatures joined the local index.", {
          programId,
          observed: enqueue.observations,
          enqueued: enqueue.enqueued,
          committedHead: candidateHead
        });
      }
      this.events?.publish("wallet-index", this.repository.walletIndexCoverage(this.now()));
      return true;
    }
    return false;
  }

  private async resolveOversizedManagedHeadGap(
    programId: string,
    committedHead: string,
    bootstrap: WalletIndexCheckpoint | undefined,
    checkpoint: WalletIndexCheckpoint | undefined,
    inProgress: boolean
  ): Promise<boolean> {
    const previousMetadata = checkpoint?.metadata ?? {};
    const now = this.now();
    const at = now.toISOString();
    if (!this.allowHeadEpochReseed()) {
      if (typeof previousMetadata.gapCatchupBlockedAt === "string") return false;
      this.repository.saveWalletIndexCheckpoint({
        pipeline: HEAD_PIPELINE,
        partition: programId,
        completed: false,
        updatedAt: at,
        lastSignature: committedHead,
        ...(checkpoint?.cursor ? { cursor: checkpoint.cursor } : {}),
        ...(checkpoint?.beforeSignature ? { beforeSignature: checkpoint.beforeSignature } : {}),
        ...(checkpoint?.slot !== undefined
          ? { slot: checkpoint.slot }
          : bootstrap?.slot !== undefined
            ? { slot: bootstrap.slot }
            : {}),
        ...(checkpoint?.blockTime
          ? { blockTime: checkpoint.blockTime }
          : bootstrap?.blockTime
            ? { blockTime: bootstrap.blockTime }
            : {}),
        metadata: {
          ...previousMetadata,
          gapCatchupBlockedAt: at,
          gapReason: "MANAGED_GAP_EXCEEDS_AUTOMATIC_REPAIR_HORIZON"
        }
      });
      this.repository.audit(
        "wallet_index_head_gap_blocked",
        "A managed-provider program-head gap exceeded the automatic repair horizon; safety remained paused.",
        {
          programId,
          inProgress,
          repairHorizonSeconds: this.headMaximumRepairAgeMs / 1_000,
          pagesAttempted: this.metadataNumber(previousMetadata, "cyclePages")
        },
        "warning"
      );
      return true;
    }

    let seed: { signature: string; slot: number; blockTime: number; failed: boolean } | undefined;
    if (inProgress) {
      const signature = this.metadataString(previousMetadata, "candidateHeadSignature");
      const slot = this.metadataNumberOrUndefined(previousMetadata, "candidateHeadSlot");
      const blockTimeText = this.metadataString(previousMetadata, "candidateHeadBlockTime");
      const blockTime = blockTimeText ? Date.parse(blockTimeText) / 1_000 : Number.NaN;
      if (signature && slot !== undefined && Number.isSafeInteger(blockTime) && blockTime > 0) {
        seed = { signature, slot, blockTime, failed: false };
      }
    } else {
      const latest = (await this.rpc.getSignaturesForAddress(programId, { limit: 1 }))[0];
      if (latest?.blockTime !== undefined) {
        seed = {
          signature: latest.signature,
          slot: latest.slot,
          blockTime: latest.blockTime,
          failed: latest.failed
        };
      }
    }
    if (!seed) {
      if (typeof previousMetadata.gapCatchupBlockedAt === "string") return false;
      this.repository.saveWalletIndexCheckpoint({
        pipeline: HEAD_PIPELINE,
        partition: programId,
        completed: false,
        updatedAt: at,
        lastSignature: committedHead,
        ...(checkpoint?.slot !== undefined
          ? { slot: checkpoint.slot }
          : bootstrap?.slot !== undefined
            ? { slot: bootstrap.slot }
            : {}),
        ...(checkpoint?.blockTime
          ? { blockTime: checkpoint.blockTime }
          : bootstrap?.blockTime
            ? { blockTime: bootstrap.blockTime }
            : {}),
        metadata: {
          ...previousMetadata,
          gapCatchupBlockedAt: at,
          gapReason: "CURRENT_HEAD_SEED_UNAVAILABLE"
        }
      });
      this.repository.audit(
        "wallet_index_head_reseed_unavailable",
        "A safe current program-head seed was unavailable; safety remained paused.",
        { programId },
        "warning"
      );
      return true;
    }

    let enqueued = 0;
    if (!inProgress) {
      enqueued = this.repository.enqueueWalletIndexTransactions([{
        signature: seed.signature,
        sourceAddress: programId,
        source: "helius-program-head",
        discoveredAt: at,
        runId: this.ensureRun().id,
        slot: seed.slot,
        blockTime: new Date(seed.blockTime * 1_000).toISOString(),
        metadata: {
          headEpochSeed: true,
          discontinuityBeforeSeed: true,
          failed: seed.failed
        }
      }]).enqueued;
    }
    const abandonedFromSlot = checkpoint?.slot ?? bootstrap?.slot;
    const abandonedFromBlockTime = checkpoint?.blockTime ?? bootstrap?.blockTime;
    const seedBlockTime = new Date(seed.blockTime * 1_000).toISOString();
    this.repository.saveWalletIndexCheckpoint({
      pipeline: HEAD_PIPELINE,
      partition: programId,
      completed: false,
      updatedAt: at,
      lastSignature: seed.signature,
      slot: seed.slot,
      blockTime: seedBlockTime,
      metadata: {
        pages: this.metadataNumber(previousMetadata, "pages"),
        observations: this.metadataNumber(previousMetadata, "observations"),
        cycles: this.metadataNumber(previousMetadata, "cycles"),
        headEpoch: this.metadataNumber(previousMetadata, "headEpoch") + 1,
        lastPageCount: 1,
        lastSyncedAt: at,
        coverageStartSlot: seed.slot + 1,
        reseededAt: at,
        gapReason: "MANAGED_GAP_QUARANTINED_BEFORE_PAPER_MONITORING",
        abandonedAnchorSignature: committedHead,
        ...(abandonedFromSlot !== undefined ? { abandonedFromSlot } : {}),
        ...(abandonedFromBlockTime ? { abandonedFromBlockTime } : {}),
        abandonedToSlot: seed.slot,
        abandonedToBlockTime: seedBlockTime,
        abandonedCatchupPages: this.metadataNumber(previousMetadata, "cyclePages")
      }
    });
    if (enqueued > 0) {
      this.updateRun({ enqueuedSignatures: this.ensureRun().enqueuedSignatures + enqueued });
    }
    this.repository.audit(
      "wallet_index_head_epoch_reseeded",
      "An oversized managed-provider history gap was quarantined before paper monitoring; a new forward-only head epoch was seeded.",
      {
        programId,
        seedSlot: seed.slot,
        seedBlockTime,
        abandonedFromSlot,
        abandonedFromBlockTime,
        attemptedPages: this.metadataNumber(previousMetadata, "cyclePages"),
        activePaperCohort: false
      },
      "warning"
    );
    this.events?.publish("wallet-index", this.repository.walletIndexCoverage(this.now()));
    return true;
  }

  private metadataNumber(metadata: Record<string, unknown>, key: string): number {
    const value = metadata[key];
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
  }

  private hasBootstrapHeadAnchor(): boolean {
    return this.indexer.listPrograms().some((programId) =>
      Boolean(this.repository.getWalletIndexCheckpoint(PIPELINE, programId)?.lastSignature)
    );
  }

  private metadataNumberOrUndefined(metadata: Record<string, unknown>, key: string): number | undefined {
    const value = metadata[key];
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
  }

  private metadataString(metadata: Record<string, unknown>, key: string): string | undefined {
    const value = metadata[key];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  }

  private async hydrateBatch(): Promise<boolean> {
    const leaseLimit = Math.max(
      1,
      Math.min(this.hydrationBatchSize, Math.floor(this.availableCreditHeadroom()))
    );
    const leased = this.repository.leaseWalletIndexTransactions(
      this.workerId,
      leaseLimit,
      120,
      this.now()
    );
    if (leased.length === 0) return false;
    const prefetched = new Map<string, unknown | null>();
    const blockFetch = this.blockHydrationEnabled ? this.rpc.getBlock?.bind(this.rpc) : undefined;
    if (blockFetch) {
      const bySlot = new Map<number, WalletIndexTransaction[]>();
      for (const item of leased) {
        if (!this.isBlockHydrationCandidate(item)) continue;
        const slot = item.slot as number;
        const group = bySlot.get(slot) ?? [];
        group.push(item);
        bySlot.set(slot, group);
      }
      // A whole block is worthwhile only when it replaces multiple transaction
      // reads. Sparse program-address history (notably older Jupiter v4 pages)
      // stays on compact getTransaction responses.
      for (const [slot, items] of bySlot) {
        if (items.length < 2) bySlot.delete(slot);
      }
      // Slot-grouped leases normally span only a few blocks. Fetch those
      // blocks concurrently; HeliusRpcClient still throttles request starts,
      // while this avoids serial network latency without retaining an
      // unbounded number of full blocks in memory.
      const blockResults = await Promise.all([...bySlot].map(async ([slot, items]) => {
        try {
          return { slot, items, block: await blockFetch(slot) } as const;
        } catch (error) {
          return { slot, items, error } as const;
        }
      }));
      for (const result of blockResults) {
        if ("error" in result) {
          if (result.error instanceof HeliusRpcBudgetError) throw result.error;
          if (blockCapabilityUnavailable(result.error)) {
            this.disableBlockHydration(result.error);
            prefetched.clear();
            break;
          }
          // A transient block-level failure is not charged to any queue item;
          // each lease continues through its ordinary getTransaction fallback.
          continue;
        }
        if (result.block === null) continue;
        const signatures = new Set(result.items.map((item) => item.signature));
        try {
          for (const [signature, transaction] of this.blockTransactions(result.block, result.slot, signatures)) {
            prefetched.set(signature, transaction);
          }
        } catch (error) {
          if (blockCapabilityUnavailable(error)) {
            this.disableBlockHydration(error);
            prefetched.clear();
            break;
          }
          continue;
        }
      }
    }
    let processedInTurn = 0;
    let hydratedTransactions = 0;
    let indexedSwaps = 0;
    for (const item of leased) {
      const outcome = await this.hydrateOne(
        item,
        prefetched.has(item.signature) ? { raw: prefetched.get(item.signature) ?? null } : undefined
      );
      hydratedTransactions += outcome.hydratedTransactions;
      indexedSwaps += outcome.indexedSwaps;
      processedInTurn += 1;
      if (processedInTurn % 25 === 0) {
        // SQLite work is synchronous. Yield between small chunks so the
        // loopback dashboard and SSE heartbeat remain responsive during a
        // large 250-item hydration lease.
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    await this.materializeDirtyWallets();
    const coverage = this.repository.walletIndexCoverage(this.now());
    if (hydratedTransactions > 0 || indexedSwaps > 0) {
      const run = this.ensureRun();
      this.updateRun({
        hydratedTransactions: run.hydratedTransactions + hydratedTransactions,
        indexedSwaps: run.indexedSwaps + indexedSwaps,
        discoveredWallets: coverage.indexedWallets
      });
    }
    this.events?.publish("wallet-index", coverage);
    return true;
  }

  private isBlockHydrationCandidate(item: WalletIndexTransaction): boolean {
    if (!Number.isSafeInteger(item.slot) || (item.slot ?? -1) < 0) return false;
    const sources = this.repository.listWalletIndexTransactionSources(item.signature);
    if (this.identityEvidenceEnabled && sources.some((source) => source.source === DEEP_HISTORY_SOURCE)) {
      return false;
    }
    // Program pages contain many signatures per slot, so one full block
    // amortizes across the group. A wallet's 90-day deep history usually has
    // one signature per slot; fetching whole blocks there would cost the same
    // credits while transferring far more data, so it stays on getTransaction.
    const supported = sources.some((source) =>
      this.indexer.listPrograms().includes(source.sourceAddress)
    );
    return supported &&
      !sources.some((source) => source.metadata?.failed === true);
  }

  private blockTransactions(
    block: unknown,
    slot: number,
    wanted: ReadonlySet<string>
  ): Map<string, unknown> {
    if (block === null || typeof block !== "object" || Array.isArray(block)) {
      throw new BlockHydrationUnavailableError("Helius getBlock returned a malformed block object");
    }
    const record = block as Record<string, unknown>;
    const blockTime = record.blockTime;
    const transactions = record.transactions;
    if (
      typeof blockTime !== "number" ||
      !Number.isSafeInteger(blockTime) ||
      blockTime < 0 ||
      blockTime > 8_640_000_000_000 ||
      !Array.isArray(transactions)
    ) {
      throw new BlockHydrationUnavailableError("Helius getBlock returned malformed block metadata");
    }
    if (transactions.length > MAX_BLOCK_TRANSACTIONS) {
      throw new BlockHydrationUnavailableError(
        `Helius getBlock returned more than ${MAX_BLOCK_TRANSACTIONS} transactions`
      );
    }
    const mapped = new Map<string, unknown>();
    const duplicates = new Set<string>();
    for (const value of transactions) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
      const entry = value as Record<string, unknown>;
      const transaction = entry.transaction;
      if (transaction === null || typeof transaction !== "object" || Array.isArray(transaction)) continue;
      const signatures = (transaction as Record<string, unknown>).signatures;
      const signature = Array.isArray(signatures) && typeof signatures[0] === "string"
        ? signatures[0]
        : undefined;
      if (!signature || !wanted.has(signature) || duplicates.has(signature)) continue;
      const augmented = { ...entry, slot, blockTime };
      // Malformed individual block entries are deliberately ignored so their
      // queue items fall back to getTransaction without consuming an attempt.
      if (!confirmedTransactionMetadata(augmented)) continue;
      // The strict swap policy needs parsed Token/System/ATA fields. If a node
      // ignores the requested jsonParsed encoding, leave this signature out of
      // the prefetch map so hydrateOne performs its safe per-transaction fetch.
      if (!hasParsedSpotSwapSafetyInstructions(augmented)) continue;
      if (mapped.has(signature)) {
        mapped.delete(signature);
        duplicates.add(signature);
        continue;
      }
      mapped.set(signature, augmented);
    }
    return mapped;
  }

  private disableBlockHydration(error: ProviderApiError | BlockHydrationUnavailableError): void {
    if (!this.blockHydrationEnabled) return;
    this.blockHydrationEnabled = false;
    this.repository.setSetting("helius_index_block_supported", false);
    this.repository.audit(
      "wallet_index_block_disabled",
      "Helius block hydration is unavailable or unsafe; indexing continued with individual confirmed transactions.",
      {
        ...(error instanceof ProviderApiError && error.status !== undefined ? { status: error.status } : {}),
        reason: errorText(error)
      },
      "warning"
    );
  }

  private async hydrateOne(
    item: WalletIndexTransaction,
    prefetched?: { raw: unknown | null }
  ): Promise<HydrationOutcome> {
    const leaseToken = item.leaseToken;
    if (!leaseToken) return NO_HYDRATION;
    try {
      const sources = this.repository.listWalletIndexTransactionSources(item.signature);
      const directPrograms = [...new Set(
        sources
          .map((source) => source.sourceAddress)
          .filter((address) => this.indexer.listPrograms().includes(address))
      )];
      const deepWallets = new Set(
        sources
          .filter((source) => source.source === DEEP_HISTORY_SOURCE && source.wallet)
          .map((source) => source.wallet as string)
      );
      if (directPrograms.length === 0 && deepWallets.size === 0) {
        throw new Error("Indexed signature has no approved program or wallet-history source");
      }
      const knownFailed = sources.some((source) => source.metadata?.failed === true);
      if (knownFailed && (!this.identityEvidenceEnabled || deepWallets.size === 0)) {
        const completed = this.repository.completeWalletIndexTransaction(
          {
            ...item,
            success: false,
            programIds: directPrograms,
            sourceWallets: [...deepWallets],
            updatedAt: this.now().toISOString()
          },
          [],
          leaseToken,
          this.now()
        );
        return completed
          ? { hydratedTransactions: 1, indexedSwaps: 0 }
          : NO_HYDRATION;
      }

      const raw = prefetched ? prefetched.raw : await this.rpc.getTransaction(item.signature);
      if (raw === null) {
        throw new TransientHydrationUnavailableError("Confirmed transaction is temporarily unavailable");
      }
      const metadata = confirmedTransactionMetadata(raw);
      if (!metadata) throw new Error("Confirmed transaction metadata is malformed");
      const programs = [...new Set([
        ...directPrograms,
        ...metadata.programIds.filter((program) => this.indexer.listPrograms().includes(program))
      ])];
      const observations = new Map<string, IndexedSpotSwapObservation>();
      for (const program of programs) {
        for (const observation of this.indexer.decodeProgramTransaction(program, item.signature, raw, this.now())) {
          if (directPrograms.length === 0 && !deepWallets.has(observation.wallet)) continue;
          observations.set(`${observation.wallet}:${observation.targetMint}:${observation.side}`, observation);
        }
      }
      const swaps = await Promise.all([...observations.values()].map((observation, index) =>
        this.toIndexedSwap(observation, index, metadata.programIds)
      ));
      const identityEvidence = this.identityEvidenceEnabled && deepWallets.size > 0
        ? normalizeWalletIdentityTransactionEvidence(raw, {
            signature: item.signature,
            wallets: [...deepWallets],
            swapScanComplete: !metadata.success ||
              metadata.signers.length === 1 ||
              !metadata.programIds.some((program) => this.indexer.listPrograms().includes(program))
          })
        : [];
      const completed = this.repository.completeWalletIndexTransaction(
        {
          ...item,
          status: "LEASED",
          slot: metadata.slot,
          blockTime: metadata.blockTime,
          success: metadata.success,
          ...(metadata.feePayer ? { feePayer: metadata.feePayer } : {}),
          accountKeys: metadata.accountKeys,
          programIds: metadata.programIds,
          ...(metadata.transactionVersion ? { transactionVersion: metadata.transactionVersion } : {}),
          sourceWallets: [...new Set([...deepWallets, ...swaps.map((swap) => swap.wallet)])],
          updatedAt: this.now().toISOString()
        },
        swaps,
        leaseToken,
        this.now(),
        identityEvidence
      );
      if (!completed) return NO_HYDRATION;
      const exactWallets = new Set(swaps.map((swap) => swap.wallet));
      for (const program of directPrograms.filter((candidate) =>
        JUPITER_COARSE_WALLET_PROGRAM_IDS.has(candidate)
      )) {
        for (const swap of swaps) recordExactWalletAttribution(this.repository, swap, program);
        const decision = classifyCoarseJupiterWalletCandidate(program, item.signature, raw, this.now());
        if (decision.accepted) {
          if (!exactWallets.has(decision.wallet)) {
            materializeCoarseWalletCandidate(
              this.repository,
              decision,
              this.currentTargetWallets()
            );
          }
        } else {
          recordRejectedCoarseWalletCandidate(this.repository, decision, 1);
        }
      }
      return { hydratedTransactions: 1, indexedSwaps: swaps.length };
    } catch (error) {
      if (error instanceof HeliusRpcBudgetError) throw error;
      this.retryHydration(item, error);
      return NO_HYDRATION;
    }
  }

  private async materializeDirtyWallets(limit = 100): Promise<number> {
    const dirty = this.repository.listDirtyWalletIndexRecords(limit);
    let materialized = 0;
    for (const record of dirty) {
      this.materializeWallet(record.wallet);
      if (this.repository.clearDirtyWalletIndexRecord(
        record.wallet,
        record.markedAt,
        record.lastSignature
      )) materialized += 1;
      // One wallet can contain a long 90-day swap history. Yield after each
      // aggregate so loopback controls and health probes are never starved by
      // a multi-wallet batch.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return materialized;
  }

  private retryHydration(item: WalletIndexTransaction, error: unknown): void {
    if (!item.leaseToken) return;
    const transient = transientHydrationFailure(error);
    const delayMs = transient
      ? Math.min(
          TRANSIENT_HYDRATION_MAXIMUM_DELAY_MS,
          30_000 * 2 ** Math.min(10, Math.max(0, item.attempts - 1))
        )
      : Math.min(30_000, 1_000 * 2 ** Math.max(0, item.attempts - 1));
    const status = this.repository.retryWalletIndexTransaction(
      item.signature,
      item.leaseToken,
      `${transient ? "transient provider failure" : "non-retryable data failure"}: ${errorText(error)}`,
      delayMs,
      transient ? TRANSIENT_HYDRATION_MAXIMUM_ATTEMPTS : 5,
      this.now()
    );
    if (transient && status === "FAILED") {
      this.repository.audit(
        "wallet_index_transient_retry_exhausted",
        "A transaction remained unavailable after the long-lived provider retry window.",
        {
          signature: item.signature,
          attempts: item.attempts,
          maximumAttempts: TRANSIENT_HYDRATION_MAXIMUM_ATTEMPTS,
          reason: errorText(error)
        },
        "warning"
      );
    }
  }

  private async toIndexedSwap(
    observation: IndexedSpotSwapObservation,
    swapIndex: number,
    programIds: string[]
  ): Promise<IndexedSpotSwap> {
    const buying = observation.side === "BUY";
    let baseValueUsd = observation.baseValueUsd;
    if (
      baseValueUsd === undefined &&
      observation.baseMint === SOL_MINT &&
      this.solPriceUsdResolver
    ) {
      try {
        const solPriceUsd = await this.solPriceUsdResolver(observation.blockTime);
        const resolved = observation.baseAmountUi * solPriceUsd;
        if (Number.isFinite(resolved) && resolved > 0) baseValueUsd = resolved;
      } catch {
        // Hydration evidence is still durable. The separate reprice queue keeps
        // this row ineligible for ranking until exact at-or-before coverage is
        // available and can resume after a restart.
      }
    }
    return {
      id: `${observation.sourceSignature}:${observation.wallet}:${swapIndex}`,
      signature: observation.sourceSignature,
      wallet: observation.wallet,
      swapIndex,
      slot: observation.slot,
      blockTime: observation.blockTime,
      side: observation.side,
      baseMint: observation.baseMint,
      targetMint: observation.targetMint,
      inputMint: buying ? observation.baseMint : observation.targetMint,
      outputMint: buying ? observation.targetMint : observation.baseMint,
      inputAmountAtomic: buying ? observation.baseAmountAtomic : observation.targetAmountAtomic,
      outputAmountAtomic: buying ? observation.targetAmountAtomic : observation.baseAmountAtomic,
      inputAmountUi: buying ? observation.baseAmountUi : observation.targetAmountUi,
      outputAmountUi: buying ? observation.targetAmountUi : observation.baseAmountUi,
      eligible: true,
      eligibilityReasons: [],
      programIds,
      indexedAt: observation.indexedAt,
      ...(baseValueUsd !== undefined && observation.targetAmountUi > 0
        ? { priceUsd: baseValueUsd / observation.targetAmountUi }
        : {})
    };
  }

  private async repriceOne(): Promise<boolean> {
    const pending = this.repository.nextPendingIndexedSwapReprice(this.now());
    if (!pending) return false;
    if (!this.solPriceUsdResolver) {
      this.repository.retryIndexedSwapReprice(
        pending.swap.id,
        "No local at-or-before SOL/USD resolver is configured.",
        5 * 60_000,
        this.now()
      );
      return false;
    }
    try {
      const solPriceUsd = await this.solPriceUsdResolver(pending.swap.blockTime);
      const baseQuantity = pending.swap.side === "BUY"
        ? pending.swap.inputAmountUi
        : pending.swap.outputAmountUi;
      const targetQuantity = pending.swap.side === "BUY"
        ? pending.swap.outputAmountUi
        : pending.swap.inputAmountUi;
      const targetPriceUsd = baseQuantity * solPriceUsd / targetQuantity;
      if (!Number.isFinite(targetPriceUsd) || targetPriceUsd <= 0) {
        throw new Error("Historical SOL swap produced an invalid USD unit price.");
      }
      if (!this.repository.completeIndexedSwapReprice(pending.swap.id, targetPriceUsd, this.now())) {
        throw new Error("Historical SOL swap reprice lost its pending ledger row.");
      }
      this.events?.publish("wallet-index-reprice", { swapId: pending.swap.id, blockTime: pending.swap.blockTime });
      return true;
    } catch (error) {
      const delayMs = Math.min(6 * 60 * 60_000, 30_000 * 2 ** Math.min(10, pending.attempts - 1));
      this.repository.retryIndexedSwapReprice(pending.swap.id, errorText(error), delayMs, this.now());
      return false;
    }
  }

  private materializeWallet(wallet: string): void {
    const swaps = this.repository.listIndexedSpotSwaps(wallet, 100_000);
    if (swaps.length === 0) return;
    const ordered = [...swaps].sort((left, right) => Date.parse(left.blockTime) - Date.parse(right.blockTime));
    const firstSeenAt = ordered[0]?.blockTime ?? this.now().toISOString();
    const lastSeenAt = ordered.at(-1)?.blockTime ?? firstSeenAt;
    const activeDays = new Set(ordered.map((swap) => swap.blockTime.slice(0, 10))).size;
    const activeWeeks = new Set(
      ordered
        .map((swap) => Math.floor((this.now().getTime() - Date.parse(swap.blockTime)) / (7 * 86_400_000)))
        .filter((week) => week >= 0 && week < 4)
    ).size;
    const lots = new Map<string, Array<{ amount: number; openedAt: number }>>();
    const holdingMinutes: number[] = [];
    let closedEligibleSwaps = 0;
    for (const swap of ordered) {
      if (swap.side === "BUY") {
        const mintLots = lots.get(swap.targetMint) ?? [];
        mintLots.push({ amount: swap.outputAmountUi, openedAt: Date.parse(swap.blockTime) });
        lots.set(swap.targetMint, mintLots);
        continue;
      }
      const mintLots = lots.get(swap.targetMint) ?? [];
      let remaining = swap.inputAmountUi;
      let matched = false;
      while (remaining > 1e-12 && mintLots.length > 0) {
        const lot = mintLots[0];
        if (!lot) break;
        const amount = Math.min(remaining, lot.amount);
        if (amount > 0) {
          matched = true;
          holdingMinutes.push((Date.parse(swap.blockTime) - lot.openedAt) / 60_000);
        }
        lot.amount -= amount;
        remaining -= amount;
        if (lot.amount <= 1e-12) mintLots.shift();
      }
      if (matched) closedEligibleSwaps += 1;
    }
    const existing = this.repository.getWalletIndexRecord(wallet);
    const discoverySwap = ordered[0] as IndexedSpotSwap;
    const discoveryProgram = discoverySwap.programIds.find((program) =>
      JUPITER_COARSE_WALLET_PROGRAM_IDS.has(program)
    ) ?? this.indexer.listPrograms().find((program) =>
      JUPITER_COARSE_WALLET_PROGRAM_IDS.has(program)
    ) ?? discoverySwap.programIds[0] ?? "unknown-program";
    const calculatedHistoryDays = Math.max(
      0,
      Math.floor((Date.parse(lastSeenAt) - Date.parse(firstSeenAt)) / 86_400_000)
    );
    const calculatedTransactionCount = new Set(swaps.map((swap) => swap.signature)).size;
    const record: WalletIndexRecord = {
      ...(existing ?? {}),
      wallet,
      firstSeenAt,
      lastSeenAt,
      historyDays: Math.max(calculatedHistoryDays, existing?.historyDays ?? 0),
      transactionCount: Math.max(calculatedTransactionCount, existing?.transactionCount ?? 0),
      successfulTransactionCount: Math.max(
        calculatedTransactionCount,
        existing?.successfulTransactionCount ?? 0
      ),
      spotSwapCount: swaps.length,
      eligibleSpotSwapCount: swaps.filter((swap) => swap.eligible).length,
      closedEligibleSwaps: existing?.deepHistoryStatus === "COMPLETE"
        ? existing.closedEligibleSwaps
        : closedEligibleSwaps,
      buyCount: swaps.filter((swap) => swap.side === "BUY").length,
      sellCount: swaps.filter((swap) => swap.side === "SELL").length,
      activeDays,
      activeWeeks: Math.max(activeWeeks, existing?.activeWeeks ?? 0),
      distinctMints: new Set(swaps.map((swap) => swap.targetMint)).size,
      medianHoldingMinutes: existing?.deepHistoryStatus === "COMPLETE"
        ? existing.medianHoldingMinutes
        : Math.max(0, median(holdingMinutes)),
      preScreenEligible: existing?.preScreenEligible ?? false,
      preScreenReasons: existing?.preScreenReasons ?? [PENDING_PRESCREEN],
      ...exactWalletDiscoveryFields(discoverySwap, discoveryProgram),
      updatedAt: this.now().toISOString()
    };
    this.repository.upsertWalletIndexRecord(record);
  }

  private async preScreen(records: WalletIndexRecord[]): Promise<void> {
    let processed = 0;
    for (let offset = 0; offset < records.length; offset += this.walletRequestConcurrency) {
      const batch = records.slice(offset, offset + this.walletRequestConcurrency);
      const samples = await Promise.allSettled(
        batch.map((record) => this.indexer.preScreenWalletActivity(record.wallet))
      );
      for (let index = 0; index < batch.length; index += 1) {
        const record = batch[index];
        const sampled = samples[index];
        if (!record || !sampled) continue;
        if (sampled.status === "rejected") throw sampled.reason;
        const sample = sampled.value;
        const periodEnd = sample.sampledAt;
        const periodStart = new Date(Date.parse(periodEnd) - 90 * 86_400_000).toISOString();
        const activity: WalletActivitySample = {
          wallet: record.wallet,
          periodStart,
          periodEnd,
          transactionCount: sample.successfulTransactions,
          successfulTransactionCount: sample.successfulTransactions,
          spotSwapCount: record.spotSwapCount,
          eligibleSpotSwapCount: record.eligibleSpotSwapCount,
          buyCount: record.buyCount,
          sellCount: record.sellCount,
          distinctMints: record.distinctMints,
          sampledAt: sample.sampledAt
        };
        const updated: WalletIndexRecord = {
          ...record,
          historyDays: Math.max(record.historyDays, sample.historyDays),
          transactionCount: Math.max(record.transactionCount, sample.successfulTransactions),
          successfulTransactionCount: Math.max(record.successfulTransactionCount, sample.successfulTransactions),
          activeWeeks: Math.max(record.activeWeeks, sample.activeWeeks),
          preScreenEligible: sample.passed,
          preScreenReasons: sample.reasons,
          ...(sample.passed
            ? {
                deepHistoryStatus: "AWAITING" as const,
                structuralEligible: false,
                structuralReasons: [AWAITING_LOCAL_DEEP_HISTORY]
              }
            : {
                structuralEligible: false,
                structuralReasons: sample.reasons
              }),
          updatedAt: sample.sampledAt
        };
        const snapshot: WalletPreScreenSnapshot = {
          wallet: record.wallet,
          runId: this.ensureRun().id,
          calculatedAt: sample.sampledAt,
          eligible: sample.passed,
          reasons: sample.reasons,
          record: updated
        };
        this.repository.commitWalletPreScreen(activity, snapshot);
        processed += 1;
      }
    }
    const coverage = this.repository.walletIndexCoverage(this.now());
    const run = this.ensureRun();
    this.updateRun({
      preScreenedWallets: run.preScreenedWallets + processed,
      structuralCandidates: this.repository.listWalletIndexResearchShortlist(100).length
    });
    this.events?.publish("wallet-index", coverage);
  }

  private reserveCredits(credits: number): boolean {
    if (!this.enforceManagedCreditBudget) return true;
    const usage = this.repository.usageSince(monthStart(this.now()));
    const indexCredits = usage.find((entry) => entry.provider === "helius_index")?.credits ?? 0;
    const totalHeliusCredits = usage
      .filter((entry) => entry.provider === "helius" || entry.provider === "helius_index")
      .reduce((sum, entry) => sum + entry.credits, 0);
    const availableHeadroom = Math.max(
      0,
      Math.min(
        this.maximumIndexCreditsPerMonth - indexCredits,
        this.maximumTotalHeliusCreditsPerMonth - totalHeliusCredits
      )
    );
    if (
      isManagedDeepHistoryRescueCohort(this.repository.openWalletDeepHistoryCohort()?.id) &&
      availableHeadroom - credits < MANAGED_DEEP_HISTORY_RESCUE_HARD_CREDIT_FLOOR
    ) {
      // Helius reserves every retry separately. Latch the denial so a provider
      // outage cannot turn this hard floor into a five-second retry loop.
      this.managedRescueCreditFloorBlockedAtHeadroom = availableHeadroom;
      return false;
    }
    if (
      indexCredits + credits > this.maximumIndexCreditsPerMonth ||
      totalHeliusCredits + credits > this.maximumTotalHeliusCreditsPerMonth
    ) return false;
    this.repository.incrementUsage("helius_index", credits, this.now());
    return true;
  }

  private hasCreditHeadroom(): boolean {
    return this.availableCreditHeadroom() >= 1;
  }

  private availableCreditHeadroom(): number {
    if (!this.enforceManagedCreditBudget) return Number.MAX_SAFE_INTEGER;
    const usage = this.repository.usageSince(monthStart(this.now()));
    const indexCredits = usage.find((entry) => entry.provider === "helius_index")?.credits ?? 0;
    const totalHeliusCredits = usage
      .filter((entry) => entry.provider === "helius" || entry.provider === "helius_index")
      .reduce((sum, entry) => sum + entry.credits, 0);
    return Math.max(
      0,
      Math.min(
        this.maximumIndexCreditsPerMonth - indexCredits,
        this.maximumTotalHeliusCreditsPerMonth - totalHeliusCredits
      )
    );
  }

  private ensureRun(): WalletIndexRun {
    if (this.run) return this.run;
    const latest = this.repository.listWalletIndexRuns(1)[0];
    if (latest && !["COMPLETE", "FAILED"].includes(latest.stage)) {
      this.run = latest;
      return latest;
    }
    const at = this.now().toISOString();
    this.run = {
      id: randomUUID(),
      stage: "DISCOVERY",
      startedAt: at,
      updatedAt: at,
      discoveredWallets: this.repository.walletIndexCoverage(this.now()).indexedWallets,
      enqueuedSignatures: 0,
      hydratedTransactions: 0,
      indexedSwaps: 0,
      preScreenedWallets: 0,
      structuralCandidates: 0,
      configuration: {
        targetWallets: this.currentTargetWallets(),
        dataSource: this.enforceManagedCreditBudget ? "managed-helius" : "standard-solana-rpc",
        maximumIndexCreditsPerMonth: this.maximumIndexCreditsPerMonth,
        maximumTotalHeliusCreditsPerMonth: this.maximumTotalHeliusCreditsPerMonth,
        programs: this.indexer.listPrograms()
      }
    };
    this.repository.upsertWalletIndexRun(this.run);
    this.repository.audit("wallet_index_started", "Local wallet index bootstrap started.", this.run);
    return this.run;
  }

  private updateRun(patch: Partial<WalletIndexRun>): void {
    const current = this.ensureRun();
    this.run = { ...current, ...patch, updatedAt: this.now().toISOString() };
    this.repository.upsertWalletIndexRun(this.run);
  }
}
