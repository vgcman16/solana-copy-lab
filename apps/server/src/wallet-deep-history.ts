import { WALLET_REASON } from "@copylab/core";
import { redactSensitiveText, type HeliusIndexRpc, type HeliusSignatureInfo } from "@copylab/providers";
import {
  DEFAULT_WALLET_POLICY,
  USDC_MINT,
  type IndexedSpotSwap,
  type TokenEligibility,
  type WalletDeepHistoryStatus,
  type WalletIndexCheckpoint,
  type WalletIndexRecord,
  type WalletProfitPricingCoverage
} from "@copylab/shared";
import type {
  ManagedRecoveryPreflightGate,
  Repository,
  WalletDeepHistoryCohort,
  WalletDeepHistoryQueueCoverage
} from "./repository.js";
import {
  classifyLocalWalletIdentity,
  LOCAL_WALLET_IDENTITY_SOURCE,
  type JupiterFirstPoolEvidence,
  type WalletIdentitySwapEvidence
} from "./local-wallet-identity.js";
import { persistLocalWalletIdentity } from "./wallet-identity.js";

export const WALLET_DEEP_HISTORY_PIPELINE = "helius-wallet-deep-history";
export const WALLET_DEEP_HISTORY_SOURCE = "helius-wallet-deep-history";
export const WALLET_DEEP_HISTORY_TARGET_SETTING = "wallet_deep_history_targets_v1";
export const AWAITING_LOCAL_DEEP_HISTORY = "awaiting local deep history";
export const AWAITING_LOCAL_SOL_PRICE = "awaiting local at-or-before SOL price evidence";
/**
 * Managed coarse results are scheduling deferrals, never qualification
 * evidence. V2 is paired with the bounded rescue lane below so an unknown
 * holding-time sentinel can no longer become a permanent terminal decision.
 */
export const MANAGED_COARSE_COPYABILITY_POLICY = "managed-coarse-copyability-v2";
export const MANAGED_DEEP_HISTORY_RESCUE_POLICY = "managed-deep-history-rescue-v3";
const DAY_MS = 86_400_000;
const EPSILON = 1e-12;
const DEEP_HISTORY_ENQUEUE_CHUNK_SIZE = 50;
const MANAGED_RESCUE_TARGET_LIMIT = 5;
const MANAGED_RESCUE_MAXIMUM_WALLET_TRANSACTIONS = 6_000;
const MANAGED_RESCUE_MAXIMUM_CUMULATIVE_TRANSACTIONS = 25_000;
const MANAGED_RESCUE_ESTIMATE_BUFFER = 1.15;
const MANAGED_RESCUE_MAXIMUM_PAGES = 6;

function isManagedRescueCohortId(cohortId: string): boolean {
  return cohortId.startsWith("managed-rescue-v2:") ||
    cohortId.startsWith("managed-rescue-v3:");
}

type DeepHistoryCheckpointStage =
  | "PAGING"
  | "AWAITING_HYDRATION"
  | "COMPLETE"
  | "FAILED";

export interface WalletDeepHistoryTargetSet {
  version: 2;
  cohortId: string;
  generationId: string;
  sequence: number;
  selectedAt: string;
  snapshotCutoffAt: string;
  windowStart: string;
  windowEnd: string;
  wallets: string[];
}

interface LegacyWalletDeepHistoryTargetSet {
  version: 1;
  selectedAt: string;
  windowStart: string;
  windowEnd: string;
  wallets: string[];
}

export interface WalletDeepHistoryCoordinatorOptions {
  targetLimit?: number;
  pageSize?: number;
  maximumPages?: number;
  historyDays?: number;
  /** Process already-screened backlog wallets, not only newly sampled ones. */
  includeExistingBacklog?: boolean;
  /**
   * MANAGED-only structural completion. PnL/concentration still come from the
   * managed providers; local discovery continues to require complete prices.
   */
  allowUnpricedStructuralCompletion?: boolean;
  includeFailedSignatures?: boolean;
  identityEnabled?: boolean;
  programIds?: readonly string[];
  firstPoolResolver?: (mint: string, now: Date) => Promise<TokenEligibility>;
  /**
   * A fail-closed pacing gate evaluated only between frozen cohorts. An open
   * cohort is always allowed to finish so its immutable evidence cannot be
   * abandoned halfway through, while a provider-scoring handoff or completed
   * required paper cohort can prevent the next batch from starting.
   */
  canStartNextCohort?: () => boolean;
  /** Enables the bounded v2 revisit only after ordinary managed acquisition drains. */
  canStartManagedRecovery?: () => boolean;
  /** Index credits available for rescue work after the caller's hard reserve. */
  managedRecoveryCreditBudget?: () => number;
  /**
   * Fresh provider preflight required before scarce managed index credits may
   * be frozen into a v3 rescue cohort. The gate is revalidated transactionally
   * by Repository.createWalletDeepHistoryCohort.
   */
  managedRecoveryPreflightGate?: () => ManagedRecoveryPreflightGate | undefined;
  /** Explicit compatibility seam for legacy v2 fixtures; production is false. */
  allowLegacyManagedRecoveryWithoutPreflight?: boolean;
  /** Test seam for the macrotask yield between durable enqueue chunks. */
  yieldControl?: () => Promise<void>;
  now?: () => Date;
}

export interface WalletDeepHistoryProgress {
  targets: number;
  complete: number;
  failed: number;
  coarseSkipped: number;
  pending: number;
}

export interface MaterializeWalletDeepHistoryOptions {
  windowStart: string;
  windowEnd: string;
  signatureCount: number;
  hydratedCount: number;
  successfulSignatureCount?: number;
  calculatedAt: string;
}

interface DeepHistoryCheckpointMetadata extends Record<string, unknown> {
  stage: DeepHistoryCheckpointStage;
  pages: number;
  signatureCount: number;
  windowStart: string;
  windowEnd: string;
  cohortId: string;
  upperSignature?: string;
  upperSlot?: number;
  upperBlockTime?: string;
  structuralEligible?: boolean;
  structuralReasons?: string[];
  queueCoverage?: WalletDeepHistoryQueueCoverage;
  reachedWindowStart?: boolean;
  identityIncludesFailedSignatures?: boolean;
  identityRepaging?: boolean;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function validLegacyTargetSet(value: unknown): value is LegacyWalletDeepHistoryTargetSet {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.version === 1 &&
    typeof record.selectedAt === "string" &&
    typeof record.windowStart === "string" &&
    typeof record.windowEnd === "string" &&
    Number.isFinite(Date.parse(record.selectedAt)) &&
    Number.isFinite(Date.parse(record.windowStart)) &&
    Number.isFinite(Date.parse(record.windowEnd)) &&
    Array.isArray(record.wallets) &&
    record.wallets.length <= 100 &&
    record.wallets.every((wallet) => typeof wallet === "string" && wallet.length > 0) &&
    new Set(record.wallets).size === record.wallets.length;
}

function targetSet(cohort: WalletDeepHistoryCohort): WalletDeepHistoryTargetSet {
  return {
    version: 2,
    cohortId: cohort.id,
    generationId: cohort.generationId,
    sequence: cohort.sequence,
    selectedAt: cohort.selectedAt,
    snapshotCutoffAt: cohort.snapshotCutoffAt,
    windowStart: cohort.windowStart,
    windowEnd: cohort.windowEnd,
    wallets: cohort.wallets
  };
}

function checkpointPartition(cohortId: string, wallet: string): string {
  return `${cohortId}:${wallet}`;
}

function metadata(checkpoint: WalletIndexCheckpoint | undefined): DeepHistoryCheckpointMetadata | undefined {
  const value = checkpoint?.metadata;
  if (!value) return undefined;
  const stage = value.stage;
  const pages = value.pages;
  const signatureCount = value.signatureCount;
  const windowStart = value.windowStart;
  const windowEnd = value.windowEnd;
  const upperSignature = value.upperSignature;
  const upperSlot = value.upperSlot;
  const upperBlockTime = value.upperBlockTime;
  const reachedWindowStart = value.reachedWindowStart;
  const identityIncludesFailedSignatures = value.identityIncludesFailedSignatures;
  const identityRepaging = value.identityRepaging;
  const cohortId = value.cohortId;
  if (
    (stage !== "PAGING" && stage !== "AWAITING_HYDRATION" && stage !== "COMPLETE" && stage !== "FAILED") ||
    typeof pages !== "number" || !Number.isSafeInteger(pages) || pages < 0 ||
    typeof signatureCount !== "number" || !Number.isSafeInteger(signatureCount) || signatureCount < 0 ||
    typeof windowStart !== "string" || !Number.isFinite(Date.parse(windowStart)) ||
    typeof windowEnd !== "string" || !Number.isFinite(Date.parse(windowEnd)) ||
    typeof cohortId !== "string" || cohortId.length === 0 ||
    (upperSignature !== undefined && (typeof upperSignature !== "string" || upperSignature.length === 0)) ||
    (upperSlot !== undefined && (typeof upperSlot !== "number" || !Number.isSafeInteger(upperSlot) || upperSlot < 0)) ||
    (upperBlockTime !== undefined &&
      (typeof upperBlockTime !== "string" || !Number.isFinite(Date.parse(upperBlockTime)))) ||
    (reachedWindowStart !== undefined && typeof reachedWindowStart !== "boolean") ||
    (identityIncludesFailedSignatures !== undefined && typeof identityIncludesFailedSignatures !== "boolean") ||
    (identityRepaging !== undefined && typeof identityRepaging !== "boolean")
  ) throw new Error("Wallet deep-history checkpoint metadata is malformed");
  return value as DeepHistoryCheckpointMetadata;
}

function minIso(left: string, right: string): string {
  return Date.parse(left) <= Date.parse(right) ? left : right;
}

function sameInstant(left: string | undefined, right: string): boolean {
  return left !== undefined && Date.parse(left) === Date.parse(right);
}

function maxIso(left: string, right: string): string {
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

function baseValueUsd(swap: IndexedSpotSwap): number | undefined {
  const quantity = swap.side === "BUY" ? swap.outputAmountUi : swap.inputAmountUi;
  const value = swap.baseMint === USDC_MINT
    ? swap.side === "BUY" ? swap.inputAmountUi : swap.outputAmountUi
    : swap.priceUsd !== undefined && Number.isFinite(swap.priceUsd) && swap.priceUsd > 0
      ? swap.priceUsd * quantity
      : undefined;
  if (value === undefined) return undefined;
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/** FIFO structural and priced-PnL materialization over one frozen 90-day window. */
export function materializeWalletDeepHistory(
  existing: WalletIndexRecord,
  swaps: readonly IndexedSpotSwap[],
  options: MaterializeWalletDeepHistoryOptions
): WalletIndexRecord {
  const windowStartMs = Date.parse(options.windowStart);
  const windowEndMs = Date.parse(options.windowEnd);
  if (!Number.isFinite(windowStartMs) || !Number.isFinite(windowEndMs) || windowStartMs >= windowEndMs) {
    throw new Error("Wallet deep-history window is invalid");
  }
  const ordered = swaps
    .filter((swap) => swap.wallet === existing.wallet && swap.eligible)
    .filter((swap) => {
      const time = Date.parse(swap.blockTime);
      return Number.isFinite(time) && time >= windowStartMs && time <= windowEndMs;
    })
    .sort((left, right) => Date.parse(left.blockTime) - Date.parse(right.blockTime));
  const lots = new Map<string, Array<{ quantity: number; costUsd?: number; openedAt: number }>>();
  const holdingMinutes: number[] = [];
  const pricedProfits = new Map<string, number>();
  let closedEligibleSwaps = 0;
  let pricedClosedEligibleSwaps = 0;
  let unpricedClosedEligibleSwaps = 0;
  let realizedPnlPricedUsd = 0;
  let hasPricedMatch = false;

  for (const swap of ordered) {
    const targetQuantity = swap.side === "BUY" ? swap.outputAmountUi : swap.inputAmountUi;
    if (!Number.isFinite(targetQuantity) || targetQuantity <= 0) continue;
    const valueUsd = baseValueUsd(swap);
    if (swap.side === "BUY") {
      const tokenLots = lots.get(swap.targetMint) ?? [];
      tokenLots.push({
        quantity: targetQuantity,
        ...(valueUsd !== undefined ? { costUsd: valueUsd } : {}),
        openedAt: Date.parse(swap.blockTime)
      });
      lots.set(swap.targetMint, tokenLots);
      continue;
    }

    const tokenLots = lots.get(swap.targetMint) ?? [];
    let remaining = targetQuantity;
    let matched = 0;
    let unpricedMatched = 0;
    while (remaining > EPSILON && tokenLots.length > 0) {
      const lot = tokenLots[0];
      if (!lot) break;
      const quantity = Math.min(remaining, lot.quantity);
      if (quantity <= 0) break;
      matched += quantity;
      holdingMinutes.push((Date.parse(swap.blockTime) - lot.openedAt) / 60_000);
      const proportionalCost = lot.costUsd === undefined
        ? undefined
        : lot.costUsd * (quantity / lot.quantity);
      const proportionalRevenue = valueUsd === undefined
        ? undefined
        : valueUsd * (quantity / targetQuantity);
      if (proportionalCost !== undefined && proportionalRevenue !== undefined) {
        const profit = proportionalRevenue - proportionalCost;
        realizedPnlPricedUsd += profit;
        pricedProfits.set(swap.targetMint, (pricedProfits.get(swap.targetMint) ?? 0) + profit);
        hasPricedMatch = true;
      } else {
        unpricedMatched += quantity;
      }
      lot.quantity -= quantity;
      if (lot.costUsd !== undefined && proportionalCost !== undefined) lot.costUsd -= proportionalCost;
      remaining -= quantity;
      if (lot.quantity <= EPSILON) tokenLots.shift();
    }
    if (matched <= 0) continue;
    closedEligibleSwaps += 1;
    if (unpricedMatched <= EPSILON) pricedClosedEligibleSwaps += 1;
    else unpricedClosedEligibleSwaps += 1;
  }

  const positiveProfits = [...pricedProfits.values()].filter((profit) => profit > 0).sort((a, b) => b - a);
  const totalPositiveProfit = positiveProfits.reduce((sum, profit) => sum + profit, 0);
  let profitPricingCoverage: WalletProfitPricingCoverage;
  if (closedEligibleSwaps === 0) profitPricingCoverage = "NO_CLOSED_EXITS";
  else if (unpricedClosedEligibleSwaps === 0) profitPricingCoverage = "COMPLETE";
  else if (hasPricedMatch) profitPricingCoverage = "PARTIAL";
  else profitPricingCoverage = "UNPRICED";
  const structuralReasons: string[] = [];
  if (closedEligibleSwaps < DEFAULT_WALLET_POLICY.minimumClosedEligibleSwaps) {
    structuralReasons.push(WALLET_REASON.INSUFFICIENT_SWAPS);
  }
  const medianHoldingMinutes = Math.max(0, median(holdingMinutes));
  if (medianHoldingMinutes < DEFAULT_WALLET_POLICY.minimumMedianHoldingMinutes) {
    structuralReasons.push(WALLET_REASON.HOLDING_TIME_TOO_SHORT);
  }

  const firstSwapAt = ordered[0]?.blockTime;
  const lastSwapAt = ordered.at(-1)?.blockTime;
  const activeDays = new Set(ordered.map((swap) => swap.blockTime.slice(0, 10))).size;
  const activeWeeks = new Set(
    ordered
      .map((swap) => Math.floor((windowEndMs - Date.parse(swap.blockTime)) / (7 * DAY_MS)))
      .filter((week) => week >= 0 && week < 4)
  ).size;
  const {
    topTokenProfitShare: _priorTopToken,
    topThreeProfitShare: _priorTopThree,
    ...base
  } = existing;
  return {
    ...base,
    ...(firstSwapAt ? { firstSeenAt: minIso(existing.firstSeenAt, firstSwapAt) } : {}),
    ...(lastSwapAt ? { lastSeenAt: maxIso(existing.lastSeenAt, lastSwapAt) } : {}),
    transactionCount: Math.max(existing.transactionCount, options.signatureCount),
    successfulTransactionCount: Math.max(
      existing.successfulTransactionCount,
      options.successfulSignatureCount ?? options.signatureCount
    ),
    spotSwapCount: Math.max(existing.spotSwapCount, ordered.length),
    eligibleSpotSwapCount: Math.max(existing.eligibleSpotSwapCount, ordered.length),
    closedEligibleSwaps,
    buyCount: Math.max(existing.buyCount, ordered.filter((swap) => swap.side === "BUY").length),
    sellCount: Math.max(existing.sellCount, ordered.filter((swap) => swap.side === "SELL").length),
    activeDays: Math.max(existing.activeDays, activeDays),
    activeWeeks: Math.max(existing.activeWeeks, activeWeeks),
    distinctMints: Math.max(existing.distinctMints, new Set(ordered.map((swap) => swap.targetMint)).size),
    medianHoldingMinutes,
    deepHistoryStatus: "COMPLETE",
    deepHistoryWindowStart: options.windowStart,
    deepHistoryWindowEnd: options.windowEnd,
    deepHistorySignatureCount: options.signatureCount,
    deepHistoryHydratedCount: options.hydratedCount,
    structuralEligible: structuralReasons.length === 0,
    structuralReasons,
    pricedClosedEligibleSwaps,
    unpricedClosedEligibleSwaps,
    realizedPnlPricedUsd,
    pricedProfitTokenCount: pricedProfits.size,
    profitPricingCoverage,
    ...(hasPricedMatch
      ? {
          topTokenProfitShare: totalPositiveProfit > 0 ? (positiveProfits[0] ?? 0) / totalPositiveProfit : 0,
          topThreeProfitShare: totalPositiveProfit > 0
            ? positiveProfits.slice(0, 3).reduce((sum, profit) => sum + profit, 0) / totalPositiveProfit
            : 0
        }
      : {}),
    updatedAt: options.calculatedAt
  };
}

export class WalletDeepHistoryCoordinator {
  private readonly targetLimit: number;
  private readonly pageSize: number;
  private readonly maximumPages: number;
  private readonly historyDays: number;
  private readonly includeExistingBacklog: boolean;
  private readonly allowUnpricedStructuralCompletion: boolean;
  private readonly includeFailedSignatures: boolean;
  private readonly identityEnabled: boolean;
  private readonly programIds: readonly string[];
  private readonly firstPoolResolver: ((mint: string, now: Date) => Promise<TokenEligibility>) | undefined;
  private readonly canStartNextCohort: () => boolean;
  private readonly canStartManagedRecovery: () => boolean;
  private readonly managedRecoveryCreditBudget: () => number;
  private readonly managedRecoveryPreflightGate:
    (() => ManagedRecoveryPreflightGate | undefined) | undefined;
  private readonly allowLegacyManagedRecoveryWithoutPreflight: boolean;
  private readonly yieldControl: () => Promise<void>;
  private readonly now: () => Date;
  private readonly identityRecheckAfter = new Map<string, number>();

  constructor(
    private readonly repository: Repository,
    private readonly rpc: HeliusIndexRpc,
    options: WalletDeepHistoryCoordinatorOptions = {}
  ) {
    this.targetLimit = Math.max(1, Math.min(100, Math.trunc(options.targetLimit ?? 100)));
    this.pageSize = Math.max(1, Math.min(1_000, Math.trunc(options.pageSize ?? 1_000)));
    this.maximumPages = Math.max(1, Math.min(1_000, Math.trunc(options.maximumPages ?? 100)));
    this.historyDays = Math.max(1, Math.trunc(options.historyDays ?? 90));
    this.includeExistingBacklog = options.includeExistingBacklog ?? false;
    this.allowUnpricedStructuralCompletion = options.allowUnpricedStructuralCompletion ?? false;
    this.includeFailedSignatures = options.includeFailedSignatures ?? false;
    this.identityEnabled = options.identityEnabled ?? false;
    if (this.allowUnpricedStructuralCompletion && this.identityEnabled) {
      throw new Error(
        "Unpriced structural completion is reserved for managed provider evidence and cannot be combined with local identity evidence"
      );
    }
    this.programIds = [...new Set(options.programIds ?? [])];
    this.firstPoolResolver = options.firstPoolResolver;
    this.canStartNextCohort = options.canStartNextCohort ?? (() => true);
    this.canStartManagedRecovery = options.canStartManagedRecovery ?? (() => false);
    this.managedRecoveryCreditBudget = options.managedRecoveryCreditBudget ?? (() => 0);
    this.managedRecoveryPreflightGate = options.managedRecoveryPreflightGate;
    this.allowLegacyManagedRecoveryWithoutPreflight =
      options.allowLegacyManagedRecoveryWithoutPreflight ?? false;
    this.yieldControl = options.yieldControl
      ?? (() => new Promise<void>((resolve) => setImmediate(resolve)));
    this.now = options.now ?? (() => new Date());
  }

  managedGenerationDrained(): boolean {
    if (!this.allowUnpricedStructuralCompletion) return true;
    if (this.repository.openWalletDeepHistoryCohort()) return false;
    if (this.repository.openWalletDeepHistoryGeneration()) return false;
    const terminal = this.repository.latestTerminalWalletDeepHistoryGeneration();
    return this.repository.listLatestWalletPreScreenSurvivors(
      1,
      terminal?.snapshotCutoffAt,
      undefined,
      undefined,
      true
    ).length === 0;
  }

  ensureTargets(): WalletDeepHistoryTargetSet | undefined {
    this.migrateLegacyTargets();
    const open = this.repository.openWalletDeepHistoryCohort();
    if (open) {
      const targets = targetSet(open);
      this.applyManagedCoarseDispositions(targets);
      return targets;
    }
    if (!this.canStartNextCohort()) return undefined;
    let generation = this.repository.openWalletDeepHistoryGeneration();
    // A managed generation is a point-in-time tranche, so every cohort in it
    // must keep the prior terminal cutoff as its durable lower bound. Without
    // this, cohort two replays old snapshots after a restart/generation roll.
    // Self-hosted mode intentionally keeps its older-backlog drain semantics
    // when a managed provider is replaced by complete local history.
    const priorManagedGeneration = generation && this.allowUnpricedStructuralCompletion
      ? this.repository.terminalWalletDeepHistoryGenerationBefore(generation.sequence)
      : undefined;
    let survivors = generation && this.includeExistingBacklog
      ? this.repository.listLatestWalletPreScreenSurvivors(
          this.targetLimit,
          priorManagedGeneration?.snapshotCutoffAt,
          generation.snapshotCutoffAt,
          generation.id,
          this.allowUnpricedStructuralCompletion
        )
      : [];
    if (generation && survivors.length === 0) {
      const completedGeneration = this.repository.completeWalletDeepHistoryGeneration(generation.id, this.now());
      if (completedGeneration) {
        this.repository.audit(
          "wallet_deep_history_generation_complete",
          "The immutable local ranking generation completed.",
          {
            generationId: generation.id,
            sequence: generation.sequence,
            cohorts: this.repository.listWalletDeepHistoryCohortsForGeneration(generation.id).length,
            wallets: this.repository.countWalletDeepHistoryEvidence(generation.id),
            snapshotCutoffAt: generation.snapshotCutoffAt,
            windowStart: generation.windowStart,
            windowEnd: generation.windowEnd
          }
        );
        generation = undefined;
      } else if (
        this.allowUnpricedStructuralCompletion &&
        this.repository.markWalletDeepHistoryGenerationManagedScreened(
          generation.id,
          MANAGED_COARSE_COPYABILITY_POLICY,
          this.now()
        )
      ) {
        generation = undefined;
      } else {
        return undefined;
      }
    }
    if (!generation) {
      const prior = this.allowUnpricedStructuralCompletion
        ? this.repository.latestTerminalWalletDeepHistoryGeneration()
        : this.repository.latestCompleteWalletDeepHistoryGeneration();
      survivors = this.repository.listLatestWalletPreScreenSurvivors(
        this.targetLimit,
        prior?.snapshotCutoffAt,
        undefined,
        undefined,
        this.allowUnpricedStructuralCompletion
      );
    }
    let managedRecovery = false;
    let recoveryPreflightGate: ManagedRecoveryPreflightGate | undefined;
    if (
      survivors.length === 0 &&
      !generation &&
      this.allowUnpricedStructuralCompletion &&
      this.canStartManagedRecovery()
    ) {
      const availableCredits = Math.max(0, Math.trunc(this.managedRecoveryCreditBudget()));
      const maximumCumulativeSuccessfulTransactions = Math.min(
        MANAGED_RESCUE_MAXIMUM_CUMULATIVE_TRANSACTIONS,
        Math.floor(availableCredits / MANAGED_RESCUE_ESTIMATE_BUFFER)
      );
      if (maximumCumulativeSuccessfulTransactions > 0) {
        const preflightGate = this.managedRecoveryPreflightGate?.();
        if (!preflightGate && !this.allowLegacyManagedRecoveryWithoutPreflight) {
          return undefined;
        }
        survivors = this.repository.listManagedWalletDeepHistoryRecoveryCandidates({
          limit: Math.min(this.targetLimit, MANAGED_RESCUE_TARGET_LIMIT),
          maximumWalletSuccessfulTransactions: MANAGED_RESCUE_MAXIMUM_WALLET_TRANSACTIONS,
          maximumCumulativeSuccessfulTransactions,
          ...(preflightGate ? { preflightGate } : {})
        });
        managedRecovery = survivors.length > 0;
        if (managedRecovery) recoveryPreflightGate = preflightGate;
      }
    }
    if (survivors.length === 0) return undefined;
    const selectedDate = this.now();
    const selectedAt = selectedDate.toISOString();
    const snapshotCutoffAt = generation?.snapshotCutoffAt
      ?? this.repository.latestWalletPreScreenSnapshotAt();
    if (!snapshotCutoffAt) throw new Error("Deep-history survivors have no durable pre-screen cutoff");
    const windowStart = generation?.windowStart
      ?? new Date(selectedDate.getTime() - this.historyDays * DAY_MS).toISOString();
    const windowEnd = generation?.windowEnd ?? selectedAt;
    const cohort = this.repository.createWalletDeepHistoryCohort({
      ...(generation ? { generationId: generation.id } : {}),
      ...(managedRecovery
        ? recoveryPreflightGate
          ? {
              kind: "MANAGED_RESCUE_V3" as const,
              preflightGate: recoveryPreflightGate
            }
          : { kind: "MANAGED_RESCUE_V2" as const }
        : {}),
      selectedAt,
      snapshotCutoffAt,
      windowStart,
      windowEnd,
      wallets: survivors.slice(0, this.targetLimit).map((record) => record.wallet)
    });
    const targets = targetSet(cohort);
    for (const record of survivors.slice(0, this.targetLimit)) {
      this.repository.upsertWalletIndexRecord({
        ...record,
        ...(this.identityEnabled
          ? {
              tags: [],
              walletIdentityStatus: "UNKNOWN" as const,
              walletIdentitySource: LOCAL_WALLET_IDENTITY_SOURCE,
              walletIdentityCheckedAt: selectedAt
            }
          : {}),
        deepHistoryStatus: "AWAITING",
        deepHistoryWindowStart: targets.windowStart,
        deepHistoryWindowEnd: targets.windowEnd,
        structuralEligible: false,
        structuralReasons: [AWAITING_LOCAL_DEEP_HISTORY],
        updatedAt: selectedAt
      });
    }
    this.applyManagedCoarseDispositions(targets);
    this.repository.audit("wallet_deep_history_targets_frozen", "A bounded wallet deep-history cohort was frozen.", {
      cohortId: targets.cohortId,
      generationId: targets.generationId,
      sequence: targets.sequence,
      lane: targets.sequence === 1 ? "BOOTSTRAP" : "SHADOW",
      targets: targets.wallets.length,
      snapshotCutoffAt: targets.snapshotCutoffAt,
      windowStart: targets.windowStart,
      windowEnd: targets.windowEnd,
      selectionPolicy: managedRecovery ? MANAGED_DEEP_HISTORY_RESCUE_POLICY : "standard-v2",
      ...(managedRecovery
        ? {
            estimatedSuccessfulTransactions: survivors
              .slice(0, this.targetLimit)
              .reduce((sum, record) => sum + record.successfulTransactionCount, 0),
            availableRecoveryCredits: Math.max(0, Math.trunc(this.managedRecoveryCreditBudget())),
            ...(recoveryPreflightGate
              ? {
                  preflightPolicy: recoveryPreflightGate.policyVersion,
                  preflightWindowStart: recoveryPreflightGate.windowStart,
                  preflightValidAt: recoveryPreflightGate.validAt
                }
              : {})
          }
        : {})
    });
    return targets;
  }

  private applyManagedCoarseDispositions(targets: WalletDeepHistoryTargetSet): void {
    if (
      !this.allowUnpricedStructuralCompletion ||
      isManagedRescueCohortId(targets.cohortId)
    ) return;
    const decidedAt = this.now().toISOString();
    for (const wallet of targets.wallets) {
      if (this.repository.getWalletDeepHistoryTargetDisposition(targets.cohortId, wallet)) continue;
      const state = metadata(this.checkpointForTargets(targets, wallet));
      // Once exact pagination has started, even a partial aggregate outranks a
      // coarse snapshot. Let the frozen scan reach a complete or failed exact
      // result; never replace in-flight evidence with a heuristic disposition.
      if (state) continue;
      const snapshot = this.repository.listWalletPreScreenSnapshotsAtOrBefore(
        wallet,
        targets.snapshotCutoffAt,
        1
      )[0];
      if (!snapshot || snapshot.record.medianHoldingMinutes >= DEFAULT_WALLET_POLICY.minimumMedianHoldingMinutes) {
        continue;
      }
      this.repository.saveManagedCoarseCopyabilitySkip({
        cohortId: targets.cohortId,
        wallet,
        policyVersion: MANAGED_COARSE_COPYABILITY_POLICY,
        thresholdMinutes: DEFAULT_WALLET_POLICY.minimumMedianHoldingMinutes,
        decidedAt
      });
    }
  }

  private migrateLegacyTargets(): void {
    if (this.repository.latestWalletDeepHistoryCohort()) return;
    const persisted = this.repository.getSetting<unknown>(WALLET_DEEP_HISTORY_TARGET_SETTING);
    if (persisted === undefined) return;
    if (!validLegacyTargetSet(persisted)) {
      throw new Error("Persisted wallet deep-history targets are malformed");
    }
    if (persisted.wallets.length === 0) return;
    const latestSnapshot = this.repository.latestWalletPreScreenSnapshotAt();
    const snapshotCutoffAt = latestSnapshot && Date.parse(latestSnapshot) <= Date.parse(persisted.selectedAt)
      ? latestSnapshot
      : persisted.selectedAt;
    const cohort = this.repository.createWalletDeepHistoryCohort({
      selectedAt: persisted.selectedAt,
      snapshotCutoffAt,
      windowStart: persisted.windowStart,
      windowEnd: persisted.windowEnd,
      wallets: persisted.wallets
    });
    this.repository.audit(
      "wallet_deep_history_targets_migrated",
      "The legacy singleton deep-history target set was migrated to a frozen versioned cohort.",
      { cohortId: cohort.id, targets: cohort.wallets.length }
    );
  }

  async runOnce(): Promise<boolean> {
    const targets = this.ensureTargets();
    if (!targets) return false;
    for (const wallet of targets.wallets) {
      if (this.repository.getWalletDeepHistoryTargetDisposition(targets.cohortId, wallet)) continue;
      const checkpoint = this.checkpointForTargets(targets, wallet);
      const state = metadata(checkpoint);
      if (state?.stage === "COMPLETE" || state?.stage === "FAILED") continue;
      if (!state || state.stage === "PAGING") {
        await this.pageWallet(wallet, targets, checkpoint, state);
        return true;
      }
      if (state.stage === "AWAITING_HYDRATION") {
        if (!checkpoint) throw new Error(`Wallet deep-history state lost its checkpoint for ${wallet}`);
        return this.finishWallet(wallet, checkpoint, state);
      }
    }
    return false;
  }

  progress(): WalletDeepHistoryProgress {
    const targets = this.ensureTargets();
    if (!targets) return { targets: 0, complete: 0, failed: 0, coarseSkipped: 0, pending: 0 };
    let complete = 0;
    let failed = 0;
    let coarseSkipped = 0;
    for (const wallet of targets.wallets) {
      if (this.repository.getWalletDeepHistoryTargetDisposition(targets.cohortId, wallet)) {
        coarseSkipped += 1;
        continue;
      }
      const state = metadata(
        this.checkpointForTargets(targets, wallet)
      );
      if (state?.stage === "COMPLETE" || state?.stage === "FAILED") {
        if (!this.repository.hasWalletDeepHistoryEvidence(targets.generationId, wallet)) {
          const legacyRecord = this.repository.getWalletIndexRecord(wallet);
          if (
            legacyRecord &&
            sameInstant(legacyRecord.deepHistoryWindowStart, targets.windowStart) &&
            sameInstant(legacyRecord.deepHistoryWindowEnd, targets.windowEnd)
          ) {
            this.freezeWalletEvidence(wallet, targets, legacyRecord, this.now().toISOString());
            this.repository.audit(
              "wallet_deep_history_legacy_evidence_frozen",
              "A pre-generation terminal wallet was frozen at schema-upgrade time.",
              { generationId: targets.generationId, cohortId: targets.cohortId, wallet },
              "warning"
            );
          }
        }
      }
      if (state?.stage === "COMPLETE") complete += 1;
      else if (state?.stage === "FAILED") failed += 1;
    }
    const progress = {
      targets: targets.wallets.length,
      complete,
      failed,
      coarseSkipped,
      pending: targets.wallets.length - complete - failed - coarseSkipped
    };
    if (progress.pending === 0) {
      const terminalAt = this.now();
      if (
        coarseSkipped > 0 &&
        this.repository.markWalletDeepHistoryCohortManagedScreened(
          targets.cohortId,
          MANAGED_COARSE_COPYABILITY_POLICY,
          terminalAt
        )
      ) {
        this.repository.audit(
          "wallet_deep_history_cohort_managed_terminal",
          "Managed screening reached a terminal scheduler state without exact local completion.",
          {
            cohortId: targets.cohortId,
            sequence: targets.sequence,
            targets: targets.wallets.length,
            complete,
            failed,
            coarseSkipped
          }
        );
      } else if (
        coarseSkipped === 0 &&
        this.repository.completeWalletDeepHistoryCohort(targets.cohortId, terminalAt)
      ) {
        this.repository.audit(
          "wallet_deep_history_cohort_complete",
          targets.sequence === 1
            ? "The bootstrap deep-history cohort completed."
            : "A shadow deep-history cohort completed without rotating active wallets.",
          {
            cohortId: targets.cohortId,
            sequence: targets.sequence,
            targets: targets.wallets.length,
            complete,
            failed,
            coarseSkipped
          }
        );
      }
    }
    return progress;
  }

  private checkpointForTargets(
    targets: WalletDeepHistoryTargetSet,
    wallet: string
  ): WalletIndexCheckpoint | undefined {
    const partition = checkpointPartition(targets.cohortId, wallet);
    const exact = this.repository.getWalletIndexCheckpoint(WALLET_DEEP_HISTORY_PIPELINE, partition);
    if (exact) return exact;
    const legacy = this.repository.getWalletIndexCheckpoint(WALLET_DEEP_HISTORY_PIPELINE, wallet);
    const legacyCohortId = legacy?.metadata?.cohortId;
    if (!legacy || !(
      legacyCohortId === targets.cohortId ||
      (legacyCohortId === undefined && targets.sequence === 1)
    )) return undefined;
    const migrated: WalletIndexCheckpoint = {
      ...legacy,
      partition,
      metadata: { ...(legacy.metadata ?? {}), cohortId: targets.cohortId }
    };
    this.repository.saveWalletIndexCheckpoint(migrated);
    return migrated;
  }

  async reclassifyUnknownIdentityOnce(): Promise<boolean> {
    if (!this.identityEnabled) return false;
    const now = this.now();
    const record = this.repository.listWalletIndexRecords(10_000).find((candidate) =>
      candidate.deepHistoryStatus === "COMPLETE" &&
      candidate.walletIdentityStatus === "UNKNOWN" &&
      (this.identityRecheckAfter.get(candidate.wallet) ?? 0) <= now.getTime()
    );
    if (!record) return false;
    const cohort = this.repository.latestWalletDeepHistoryCohortForWallet(record.wallet);
    if (!cohort) return false;
    const checkpoint = this.repository.getWalletIndexCheckpoint(
      WALLET_DEEP_HISTORY_PIPELINE,
      checkpointPartition(cohort.id, record.wallet)
    );
    const state = metadata(checkpoint);
    if (!checkpoint || state?.stage !== "COMPLETE") {
      this.identityRecheckAfter.set(record.wallet, now.getTime() + DAY_MS);
      return false;
    }
    const coverage = this.repository.walletDeepHistoryQueueCoverage(record.wallet, cohort.id);
    const result = await this.classifyIdentity(record.wallet, state, coverage, now.toISOString());
    if (result.status === "UNKNOWN") {
      this.identityRecheckAfter.set(record.wallet, now.getTime() + 10 * 60_000);
      return false;
    }
    this.identityRecheckAfter.delete(record.wallet);
    return persistLocalWalletIdentity(this.repository, result);
  }

  private async pageWallet(
    wallet: string,
    targets: WalletDeepHistoryTargetSet,
    checkpoint: WalletIndexCheckpoint | undefined,
    state: DeepHistoryCheckpointMetadata | undefined
  ): Promise<void> {
    const maximumPages = isManagedRescueCohortId(targets.cohortId)
      ? Math.min(this.maximumPages, MANAGED_RESCUE_MAXIMUM_PAGES)
      : this.maximumPages;
    if ((state?.pages ?? 0) >= maximumPages) {
      this.failPaginationCeiling(wallet, targets, checkpoint, state, maximumPages);
      return;
    }
    this.updateRecordStatus(wallet, "PAGING", targets, state?.signatureCount ?? 0);
    const signatures = await this.rpc.getSignaturesForAddress(wallet, {
      limit: this.pageSize,
      ...(checkpoint?.beforeSignature ? { before: checkpoint.beforeSignature } : {})
    });
    const tail = signatures.at(-1)?.signature;
    if (checkpoint?.beforeSignature && tail === checkpoint.beforeSignature) {
      throw new Error(`Wallet deep-history cursor did not advance for ${wallet}`);
    }
    if (signatures.length === this.pageSize && !tail) {
      throw new Error(`Wallet deep-history page had no pagination cursor for ${wallet}`);
    }
    const cutoffSeconds = Date.parse(targets.windowStart) / 1_000;
    const windowEndSeconds = Date.parse(targets.windowEnd) / 1_000;
    const reachedCutoff = signatures.some(
      (signature) => signature.blockTime !== undefined && signature.blockTime <= cutoffSeconds
    );
    const exhausted = signatures.length < this.pageSize;
    const selected = [...new Map(
      signatures
        .filter((signature) => this.includeFailedSignatures || !signature.failed)
        .filter((signature) =>
          signature.blockTime === undefined ||
          (signature.blockTime >= cutoffSeconds && signature.blockTime <= windowEndSeconds)
        )
        .map((signature) => [signature.signature, signature] as const)
    ).values()];
    const discoveredAt = this.now().toISOString();
    const items = selected.map((signature) => this.enqueueItem(wallet, signature, targets, discoveredAt));
    for (let offset = 0; offset < items.length; offset += DEEP_HISTORY_ENQUEUE_CHUNK_SIZE) {
      this.repository.enqueueWalletIndexTransactions(
        items.slice(offset, offset + DEEP_HISTORY_ENQUEUE_CHUNK_SIZE)
      );
      if (offset + DEEP_HISTORY_ENQUEUE_CHUNK_SIZE < items.length) {
        // Every chunk is independently idempotent. A crash before the final
        // checkpoint replays the same sources and reconstructs the exact
        // manifest count, while this yield keeps loopback requests responsive.
        await this.yieldControl();
      }
    }
    const finishedPaging = reachedCutoff || exhausted;
    // Derive the durable count from the source ledger. If a process crashes
    // after enqueue but before checkpoint commit, replay adds no new source yet
    // still reconstructs the correct terminal count.
    const signatureCount = this.repository.walletDeepHistoryQueueCoverage(wallet, targets.cohortId).total;
    const first = signatures[0];
    const nextMetadata: DeepHistoryCheckpointMetadata = {
      stage: finishedPaging ? "AWAITING_HYDRATION" : "PAGING",
      pages: (state?.pages ?? 0) + 1,
      signatureCount,
      cohortId: targets.cohortId,
      ...(state?.upperSignature
        ? { upperSignature: state.upperSignature }
        : first?.signature
          ? { upperSignature: first.signature }
          : {}),
      ...(state?.upperSlot !== undefined
        ? { upperSlot: state.upperSlot }
        : first?.slot !== undefined
          ? { upperSlot: first.slot }
          : {}),
      ...(state?.upperBlockTime
        ? { upperBlockTime: state.upperBlockTime }
        : first?.blockTime !== undefined
          ? { upperBlockTime: new Date(first.blockTime * 1_000).toISOString() }
          : {}),
      windowStart: targets.windowStart,
      windowEnd: targets.windowEnd,
      reachedWindowStart: state?.reachedWindowStart === true || reachedCutoff,
      identityIncludesFailedSignatures: state
        ? state.identityIncludesFailedSignatures === true
        : this.includeFailedSignatures,
      ...(state?.identityRepaging === true ? { identityRepaging: true } : {})
    };
    this.repository.saveWalletIndexCheckpoint({
      pipeline: WALLET_DEEP_HISTORY_PIPELINE,
      partition: checkpointPartition(targets.cohortId, wallet),
      completed: false,
      updatedAt: discoveredAt,
      ...(finishedPaging ? {} : tail ? { beforeSignature: tail } : {}),
      ...(tail ? { lastSignature: tail } : checkpoint?.lastSignature ? { lastSignature: checkpoint.lastSignature } : {}),
      metadata: nextMetadata
    });
    this.updateRecordStatus(
      wallet,
      finishedPaging ? "AWAITING_HYDRATION" : "PAGING",
      targets,
      signatureCount
    );
  }

  private failPaginationCeiling(
    wallet: string,
    targets: WalletDeepHistoryTargetSet,
    checkpoint: WalletIndexCheckpoint | undefined,
    state: DeepHistoryCheckpointMetadata | undefined,
    maximumPages: number
  ): void {
    if (!checkpoint || !state) {
      throw new Error(`Wallet deep-history page ceiling had no checkpoint evidence for ${wallet}`);
    }
    const at = this.now().toISOString();
    const reason = `deep-history pagination exceeded the safe ${maximumPages}-page ceiling`;
    const existing = this.repository.getWalletIndexRecord(wallet);
    if (!existing) throw new Error(`Wallet deep-history target ${wallet} has no local aggregate`);
    const coverage = this.repository.walletDeepHistoryQueueCoverage(wallet, targets.cohortId);
    const failedRecord: WalletIndexRecord = {
      ...existing,
      deepHistoryStatus: "FAILED",
      deepHistoryWindowStart: targets.windowStart,
      deepHistoryWindowEnd: targets.windowEnd,
      deepHistorySignatureCount: state.signatureCount,
      deepHistoryHydratedCount: coverage.processed,
      structuralEligible: false,
      structuralReasons: [reason],
      updatedAt: at
    };
    this.repository.upsertWalletIndexRecord(failedRecord);
    this.freezeWalletEvidence(wallet, targets, failedRecord, at);
    this.repository.saveWalletIndexCheckpoint({
      ...checkpoint,
      completed: true,
      updatedAt: at,
      metadata: {
        ...state,
        stage: "FAILED",
        failureKind: "PAGE_CEILING",
        maximumPages,
        queueCoverage: coverage,
        structuralReasons: [reason]
      }
    });
    this.repository.audit(
      "wallet_deep_history_page_ceiling",
      "Wallet deep-history paging stopped at the configured safety ceiling.",
      {
        cohortId: targets.cohortId,
        wallet,
        pages: state.pages,
        maximumPages,
        upperSignature: state.upperSignature,
        signatureCount: state.signatureCount,
        coverage
      },
      "warning"
    );
  }

  private enqueueItem(
    wallet: string,
    signature: HeliusSignatureInfo,
    targets: WalletDeepHistoryTargetSet,
    discoveredAt: string
  ) {
    return {
      signature: signature.signature,
      sourceAddress: wallet,
      wallet,
      source: WALLET_DEEP_HISTORY_SOURCE,
      discoveredAt,
      priority: 20,
      slot: signature.slot,
      ...(signature.blockTime !== undefined
        ? { blockTime: new Date(signature.blockTime * 1_000).toISOString() }
        : {}),
      metadata: {
        failed: signature.failed,
        deepHistory: true,
        cohortId: targets.cohortId,
        generationId: targets.generationId,
        windowStart: targets.windowStart,
        windowEnd: targets.windowEnd,
        ...(signature.confirmationStatus ? { confirmationStatus: signature.confirmationStatus } : {})
      }
    };
  }

  private async finishWallet(
    wallet: string,
    checkpoint: WalletIndexCheckpoint,
    state: DeepHistoryCheckpointMetadata
  ): Promise<boolean> {
    const coverage = this.repository.walletDeepHistoryQueueCoverage(wallet, state.cohortId);
    if (coverage.pending > 0 || coverage.leased > 0 || coverage.retry > 0) return false;
    if (coverage.total !== state.signatureCount) {
      throw new Error(`Wallet deep-history source coverage does not match its checkpoint for ${wallet}`);
    }
    const at = this.now().toISOString();
    const existing = this.repository.getWalletIndexRecord(wallet);
    if (!existing) throw new Error(`Wallet deep-history target ${wallet} has no local aggregate`);
    if (coverage.failed > 0) {
      const reasons = [`${coverage.failed} deep-history transactions failed hydration`];
      const failedRecord: WalletIndexRecord = {
        ...existing,
        deepHistoryStatus: "FAILED",
        deepHistorySignatureCount: state.signatureCount,
        deepHistoryHydratedCount: coverage.processed,
        structuralEligible: false,
        structuralReasons: reasons,
        updatedAt: at
      };
      this.repository.upsertWalletIndexRecord(failedRecord);
      const cohort = this.repository.getWalletDeepHistoryCohort(state.cohortId);
      if (!cohort) throw new Error(`Deep-history cohort ${state.cohortId} disappeared`);
      this.freezeWalletEvidence(wallet, targetSet(cohort), failedRecord, at);
      this.repository.saveWalletIndexCheckpoint({
        ...checkpoint,
        completed: true,
        updatedAt: at,
        metadata: { ...state, stage: "FAILED", queueCoverage: coverage, structuralReasons: reasons }
      });
      this.repository.audit("wallet_deep_history_failed", "Wallet deep-history hydration was incomplete.", {
        cohortId: state.cohortId,
        wallet,
        coverage
      }, "warning");
      return true;
    }
    const pendingReprices = this.repository.pendingIndexedSwapReprices(
      wallet,
      state.windowStart,
      state.windowEnd
    );
    if (pendingReprices > 0 && !this.allowUnpricedStructuralCompletion) {
      this.repository.upsertWalletIndexRecord({
        ...existing,
        deepHistoryStatus: "AWAITING_HYDRATION",
        deepHistorySignatureCount: state.signatureCount,
        deepHistoryHydratedCount: coverage.processed,
        structuralEligible: false,
        structuralReasons: [AWAITING_LOCAL_SOL_PRICE],
        updatedAt: at
      });
      return false;
    }
    if (this.identityEnabled && state.identityIncludesFailedSignatures !== true) {
      // A scan started by an older build omitted failed signatures. They have
      // no committed token effects, but excluding them makes the exact
      // signature/hydration proof unverifiable. Restart the frozen pagination
      // once and retain globally deduplicated prior source rows.
      const {
        beforeSignature: _beforeSignature,
        cursor: _cursor,
        ...checkpointBase
      } = checkpoint;
      this.repository.saveWalletIndexCheckpoint({
        ...checkpointBase,
        completed: false,
        updatedAt: at,
        metadata: {
          ...state,
          stage: "PAGING",
          pages: 0,
          signatureCount: coverage.total,
          reachedWindowStart: false,
          identityIncludesFailedSignatures: true,
          identityRepaging: true
        }
      });
      this.repository.upsertWalletIndexRecord({
        ...existing,
        deepHistoryStatus: "PAGING",
        walletIdentityStatus: "UNKNOWN",
        walletIdentitySource: LOCAL_WALLET_IDENTITY_SOURCE,
        walletIdentityCheckedAt: at,
        tags: [],
        structuralEligible: false,
        structuralReasons: [AWAITING_LOCAL_DEEP_HISTORY],
        updatedAt: at
      });
      this.repository.audit(
        "wallet_identity_history_repaging",
        "The frozen wallet window restarted once to include failed signatures in exact identity coverage.",
        { wallet, cohortId: state.cohortId, priorSignatures: coverage.total }
      );
      return true;
    }
    const identityTransactions = this.identityEnabled
      ? this.repository.listWalletIdentityTransactionEvidence(wallet, state.windowStart, state.windowEnd)
      : undefined;
    const materialized = materializeWalletDeepHistory(
      existing,
      this.repository.listIndexedSpotSwaps(wallet, 100_000),
      {
        windowStart: state.windowStart,
        windowEnd: state.windowEnd,
        signatureCount: state.signatureCount,
        hydratedCount: coverage.processed,
        ...(identityTransactions
          ? { successfulSignatureCount: identityTransactions.filter((transaction) => transaction.success).length }
          : {}),
        calculatedAt: at
      }
    );
    this.repository.upsertWalletIndexRecord(materialized);
    if (this.identityEnabled) {
      const result = await this.classifyIdentity(wallet, state, coverage, at, identityTransactions);
      if (!persistLocalWalletIdentity(this.repository, result)) {
        throw new Error(`Wallet identity target ${wallet} lost its local aggregate`);
      }
    }
    const frozenRecord = this.repository.getWalletIndexRecord(wallet);
    if (!frozenRecord) throw new Error(`Wallet ${wallet} disappeared before evidence freeze`);
    const cohort = this.repository.getWalletDeepHistoryCohort(state.cohortId);
    if (!cohort) throw new Error(`Deep-history cohort ${state.cohortId} disappeared`);
    this.freezeWalletEvidence(wallet, targetSet(cohort), frozenRecord, at);
    this.repository.saveWalletIndexCheckpoint({
      ...checkpoint,
      completed: true,
      updatedAt: at,
      metadata: {
        ...state,
        stage: "COMPLETE",
        queueCoverage: coverage,
        structuralEligible: materialized.structuralEligible,
        structuralReasons: materialized.structuralReasons ?? []
      }
    });
    this.repository.audit(
      "wallet_deep_history_complete",
      materialized.structuralEligible
        ? "Wallet deep history passed the local structural gates."
        : "Wallet deep history failed the local structural gates.",
      {
        cohortId: state.cohortId,
        wallet,
        closedEligibleSwaps: materialized.closedEligibleSwaps,
        medianHoldingMinutes: materialized.medianHoldingMinutes,
        pricingCoverage: materialized.profitPricingCoverage,
        structuralReasons: materialized.structuralReasons
      }
    );
    return true;
  }

  private freezeWalletEvidence(
    wallet: string,
    targets: WalletDeepHistoryTargetSet,
    record: WalletIndexRecord,
    frozenAt: string
  ): void {
    this.repository.saveWalletDeepHistoryEvidence({
      generationId: targets.generationId,
      cohortId: targets.cohortId,
      wallet,
      record,
      swaps: this.repository.listEligibleIndexedSpotSwapsBetween(
        wallet,
        targets.windowStart,
        targets.windowEnd
      ),
      frozenAt
    });
  }

  private async classifyIdentity(
    wallet: string,
    state: DeepHistoryCheckpointMetadata,
    queueCoverage: WalletDeepHistoryQueueCoverage,
    checkedAt: string,
    transactionsOverride?: ReturnType<Repository["listWalletIdentityTransactionEvidence"]>
  ) {
    const evidenceCoverage = this.repository.walletIdentityEvidenceCoverage(wallet, state.cohortId);
    const transactions = transactionsOverride ?? this.repository.listWalletIdentityTransactionEvidence(
      wallet,
      state.windowStart,
      state.windowEnd
    );
    const swaps = this.repository
      .listEligibleIndexedSpotSwapsBetween(wallet, state.windowStart, state.windowEnd)
      .map<WalletIdentitySwapEvidence>((swap) => ({
        signature: swap.signature,
        swapIndex: swap.swapIndex,
        wallet: swap.wallet,
        slot: swap.slot,
        blockTime: swap.blockTime,
        side: swap.side,
        targetMint: swap.targetMint,
        inputAmountAtomic: swap.inputAmountAtomic,
        outputAmountAtomic: swap.outputAmountAtomic
      }));
    const firstPools = await this.resolveFirstPools([...new Set(swaps.map((swap) => swap.targetMint))]);
    const buySlots = swaps.filter((swap) => swap.side === "BUY").map((swap) => swap.slot);
    const peerRows = buySlots.length === 0
      ? { rows: [], complete: true, reasons: [] }
      : this.repository.listCoordinatedBuyEvidence(swaps);
    const programCoverage = buySlots.length === 0
      ? { complete: true, reasons: [] }
      : this.repository.walletIdentityProgramSlotCoverage(this.programIds, buySlots);
    const transactionHydrationComplete =
      queueCoverage.failed === 0 &&
      queueCoverage.pending === 0 &&
      queueCoverage.leased === 0 &&
      queueCoverage.retry === 0 &&
      queueCoverage.processed === state.signatureCount &&
      evidenceCoverage.sourceSignatures === state.signatureCount &&
      evidenceCoverage.processedSignatures === state.signatureCount &&
      evidenceCoverage.evidenceSignatures === state.signatureCount &&
      transactions.length === state.signatureCount;
    const now = new Date(checkedAt);
    const result = classifyLocalWalletIdentity({
      wallet,
      windowStart: state.windowStart,
      windowEnd: state.windowEnd,
      coverage: {
        expectedSignatureCount: state.signatureCount,
        hydratedSignatureCount: evidenceCoverage.evidenceSignatures,
        reachedWindowStart: state.reachedWindowStart === true,
        signatureHistoryComplete: state.identityIncludesFailedSignatures === true,
        transactionHydrationComplete,
        coordinatedBuyScanComplete: peerRows.complete && programCoverage.complete
      },
      transactions,
      swaps,
      coordinatedBuys: peerRows.rows,
      firstPools
    }, { now });
    if (!peerRows.complete || !programCoverage.complete) {
      result.reasons = [...new Set([
        ...result.reasons,
        ...peerRows.reasons.slice(0, 20),
        ...programCoverage.reasons.slice(0, 20)
      ])];
    }
    return result;
  }

  private async resolveFirstPools(mints: readonly string[]): Promise<JupiterFirstPoolEvidence[]> {
    const evidence: JupiterFirstPoolEvidence[] = [];
    for (const mint of mints) {
      const cached = this.repository.getWalletIdentityFirstPool(mint);
      const nullCacheFresh = cached?.firstPoolAt === null &&
        this.now().getTime() - Date.parse(cached.checkedAt) < 60 * 60_000;
      if (cached && (cached.firstPoolAt !== null || nullCacheFresh)) {
        evidence.push(cached);
        continue;
      }
      if (!this.firstPoolResolver) continue;
      try {
        const token = await this.firstPoolResolver(mint, this.now());
        const resolved: JupiterFirstPoolEvidence = {
          mint,
          source: "JUPITER",
          firstPoolAt: token.firstPoolAt ?? null,
          checkedAt: token.checkedAt
        };
        this.repository.saveWalletIdentityFirstPool(resolved);
        evidence.push(resolved);
      } catch (error) {
        this.repository.audit(
          "wallet_identity_first_pool_unavailable",
          "Jupiter firstPoolAt lookup failed; local wallet identity remained UNKNOWN.",
          { walletMint: mint, reason: redactSensitiveText(error instanceof Error ? error.message : error, 500) },
          "warning"
        );
        // Provider/network failures are normally systemic. One failed lookup
        // is enough to keep the wallet UNKNOWN; stop the serial batch so an
        // outage cannot hold the index loop for one timeout per remaining mint.
        break;
      }
    }
    return evidence;
  }

  private updateRecordStatus(
    wallet: string,
    status: WalletDeepHistoryStatus,
    targets: WalletDeepHistoryTargetSet,
    signatureCount: number
  ): void {
    const record = this.repository.getWalletIndexRecord(wallet);
    if (!record) throw new Error(`Wallet deep-history target ${wallet} has no local aggregate`);
    this.repository.upsertWalletIndexRecord({
      ...record,
      deepHistoryStatus: status,
      deepHistoryWindowStart: targets.windowStart,
      deepHistoryWindowEnd: targets.windowEnd,
      deepHistorySignatureCount: signatureCount,
      structuralEligible: false,
      structuralReasons: [AWAITING_LOCAL_DEEP_HISTORY],
      updatedAt: this.now().toISOString()
    });
  }
}
