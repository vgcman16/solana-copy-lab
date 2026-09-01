import { randomUUID } from "node:crypto";
import {
  DEFAULT_BIRDEYE_MONTHLY_CU_BUDGET,
  DEFAULT_TOTAL_HELIUS_MONTHLY_CREDIT_BUDGET,
  DEFAULT_WALLET_INDEX_MONTHLY_CREDIT_BUDGET,
  DEFAULT_WALLET_INDEX_TARGET,
  DASHBOARD_COHORT_WALLET_LIMIT,
  DEFAULT_RISK_POLICY,
  type AutonomousLearningOverview,
  type AutonomousPaperDashboard,
  type AutonomousPaperLane,
  type AlpacaPaperCredentials,
  type AlpacaPaperStatus,
  type ChampionPromotionDecision,
  type DashboardSnapshot,
  type DataProviderProfile,
  type DataProviderStatus,
  type DiscoveredWalletSet,
  type ExecutionRecord,
  type ModeState,
  type PortfolioSnapshot,
  type ProviderCredentials,
  type ProviderHealth,
  type SolPriceBootstrapStatus,
  type ProviderName,
  type ProviderUsageSource,
  type PaperComparisonSnapshot,
  type ResearchPaperDashboard,
  type ResearchPaperWatchlistRun,
  type WalletCandidate,
  type WalletResearchFilter,
  type WalletResearchFunnel,
  type WalletResearchPage,
  type WalletResearchSort,
  type WalletScore
} from "@copylab/shared";
import { AlpacaPaperProvider, redactSensitiveText } from "@copylab/providers";
import type { EventBus } from "./events.js";
import type { ModeManager } from "./mode.js";
import type { Repository, ResearchPaperWatchlistRefreshOptions } from "./repository.js";
import type { RuntimeController } from "./runtime-contract.js";
import type { SecretVault } from "./vault.js";
import type { WalletManager } from "./wallet.js";
import { MarketplaceService } from "./marketplace-service.js";
import { summarizeDataProviderProfile } from "./provider-profile.js";
import { normalizeDataProviderProfile } from "./provider-profile.js";
import { calculateProviderReadiness } from "./provider-readiness.js";
import {
  RPC_READINESS_SETTING,
  activeRpcReadiness,
  dataProviderEndpointFingerprint,
  type StoredDataProviderRpcReadiness
} from "./provider-rpc-readiness.js";
import {
  calculateSelfHostedPaperSoakStatus
} from "./self-hosted-paper-soak.js";
import {
  EMERGENCY_EXIT_RPC_STATUS_SETTING,
  activeEmergencyExitRpcStatus,
  type StoredEmergencyExitRpcStatus
} from "./emergency-exit-rpc.js";
import type { ProviderParityBaselineRun } from "./provider-parity-proof.js";
import { managedRecoveryPreflightWindow } from "./managed-recovery-preflight.js";
import {
  LARGER_RESEARCH_PAPER_SIZING_POLICY,
  RESEARCH_PAPER_POLICY_VERSION
} from "./research-paper-policy.js";
import {
  AUTONOMOUS_PAPER_POLICY_VERSION,
  AUTONOMOUS_PAPER_V2_POLICY_VERSION,
  AUTONOMOUS_PAPER_V3_POLICY_VERSION,
  AUTONOMOUS_PAPER_V4_POLICY_VERSION,
  AUTONOMOUS_PAPER_V5_POLICY_VERSION,
  AUTONOMOUS_PAPER_V6_POLICY_VERSION,
  AUTONOMOUS_PAPER_V7_POLICY_VERSION,
  AUTONOMOUS_PAPER_V8_POLICY_VERSION,
  AUTONOMOUS_PAPER_V9_POLICY_VERSION,
  AUTONOMOUS_PAPER_V10_POLICY_VERSION,
  AUTONOMOUS_PAPER_V11_POLICY_VERSION,
  AUTONOMOUS_PAPER_V12_POLICY_VERSION,
  DEFAULT_AUTONOMOUS_PAPER_POLICY,
  LEGACY_AUTONOMOUS_PAPER_POLICY_VERSION
} from "./autonomous-paper-policy.js";
import { buildLiveOperationsSnapshot } from "./live-operations.js";

function largerResearchPaperPolicy(): Record<string, unknown> {
  return {
    comparison: "larger research-only entries with modeled costs; token/program admission relaxed",
    ...LARGER_RESEARCH_PAPER_SIZING_POLICY,
    promotionEligible: false,
    executionEnabled: false
  };
}

function average(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function paperComparisons(input: {
  mode: ModeState;
  portfolio: PortfolioSnapshot;
  strictInitialNavUsd: number;
  strictMaxDrawdownPercent: number;
  strictProfitFactor: number;
  strictCompletedTrades: number;
  research: ResearchPaperDashboard;
  autonomous: AutonomousPaperDashboard;
  updatedAt: string;
}): PaperComparisonSnapshot[] {
  const strictPnl = input.portfolio.navUsd - input.strictInitialNavUsd;
  const strict: PaperComparisonSnapshot = {
    kind: "STRICT_COPY",
    label: "Strict wallet copy",
    status: input.mode === "PAPER" ? "ACTIVE" : "PAUSED",
    basis: "SINGLE_ACCOUNT",
    sampleSize: 1,
    initialNavUsd: input.strictInitialNavUsd,
    normalizedNavUsd: input.portfolio.navUsd,
    normalizedPnlUsd: strictPnl,
    netReturnPercent: input.strictInitialNavUsd > 0 ? strictPnl / input.strictInitialNavUsd * 100 : 0,
    realizedPnlUsd: input.portfolio.realizedPnlUsd,
    unrealizedPnlUsd: input.portfolio.unrealizedPnlUsd,
    maxDrawdownPercent: input.strictMaxDrawdownPercent,
    completedTrades: input.strictCompletedTrades,
    openPositions: input.portfolio.openPositions,
    ...(Number.isFinite(input.strictProfitFactor) ? { profitFactor: input.strictProfitFactor } : {}),
    pricingComplete: input.portfolio.executablePricingComplete !== false,
    updatedAt: input.portfolio.capturedAt
  };

  const leaders = input.research.leaders;
  const researchInitial = average(leaders.map((leader) => leader.initialNavUsd));
  const researchNav = average(leaders.map((leader) => leader.navUsd));
  const researchRealized = average(leaders.map((leader) => leader.realizedPnlUsd));
  const researchUnrealized = average(leaders.map((leader) => leader.unrealizedPnlUsd));
  const researchPnl = researchNav - researchInitial;
  const researchEvidence = input.research.performanceEvidence;
  const highRisk: PaperComparisonSnapshot = {
    kind: "HIGH_RISK_COPY",
    label: "High-risk wallet copy",
    status: input.research.lane?.status === "ACTIVE"
      ? "ACTIVE"
      : input.research.lane ? "PAUSED" : "NOT_STARTED",
    basis: "EQUAL_WEIGHT_PER_ACCOUNT",
    sampleSize: leaders.length,
    initialNavUsd: researchInitial || input.strictInitialNavUsd,
    normalizedNavUsd: researchNav || input.strictInitialNavUsd,
    normalizedPnlUsd: researchPnl,
    netReturnPercent: researchInitial > 0 ? researchPnl / researchInitial * 100 : 0,
    realizedPnlUsd: researchRealized,
    unrealizedPnlUsd: researchUnrealized,
    maxDrawdownPercent: average(leaders.map((leader) => leader.maxDrawdownPercent)),
    completedTrades: leaders.reduce((sum, leader) => sum + leader.completedTrades, 0),
    openPositions: leaders.reduce((sum, leader) => sum + leader.openPositions, 0),
    pricingComplete: leaders.every((leader) => leader.pricingComplete),
    ...(researchEvidence ? {
      evidenceStatus: researchEvidence.status,
      robustNormalizedNavUsd: researchEvidence.exOutlierNormalizedNavUsd,
      robustNormalizedPnlUsd: researchEvidence.exOutlierNormalizedPnlUsd,
      robustNetReturnPercent: researchEvidence.exOutlierNetReturnPercent,
      medianAccountPnlUsd: researchEvidence.medianAccountPnlUsd,
      ...(researchEvidence.largestOutlierWallet
        ? { excludedOutlierWallet: researchEvidence.largestOutlierWallet }
        : {}),
      ...(researchEvidence.largestOutlierPnlUsd !== undefined
        ? { excludedOutlierPnlUsd: researchEvidence.largestOutlierPnlUsd }
        : {}),
      reconciliationDependentAccountCount: researchEvidence.reconciliationDependentAccountCount,
      evidenceDisclosure: researchEvidence.disclosure
    } : {}),
    updatedAt: input.research.updatedAt
  };

  const account = input.autonomous.account;
  const autonomousInitial = account?.initialNavUsd ?? input.strictInitialNavUsd;
  const autonomousNav = account?.navUsd ?? autonomousInitial;
  const autonomousPnl = autonomousNav - autonomousInitial;
  const autonomous: PaperComparisonSnapshot = {
    kind: "AUTONOMOUS_HIGH_RISK",
    label: "Autonomous high-risk momentum",
    status: input.autonomous.lane?.status === "ACTIVE"
      ? "ACTIVE"
      : input.autonomous.lane ? "PAUSED" : "NOT_STARTED",
    basis: "SINGLE_ACCOUNT",
    sampleSize: account ? 1 : 0,
    initialNavUsd: autonomousInitial,
    normalizedNavUsd: autonomousNav,
    normalizedPnlUsd: autonomousPnl,
    netReturnPercent: autonomousInitial > 0 ? autonomousPnl / autonomousInitial * 100 : 0,
    realizedPnlUsd: account?.realizedPnlUsd ?? 0,
    unrealizedPnlUsd: account?.unrealizedPnlUsd ?? 0,
    maxDrawdownPercent: account?.maxDrawdownPercent ?? 0,
    completedTrades: account?.completedTrades ?? 0,
    openPositions: account?.openPositions ?? 0,
    ...(account && account.completedTrades > 0
      ? { winRatePercent: account.winningTrades / account.completedTrades * 100 }
      : {}),
    ...(account && account.grossLossUsd > 0
      ? { profitFactor: account.grossProfitUsd / account.grossLossUsd }
      : {}),
    pricingComplete: account?.pricingComplete ?? true,
    ...(account ? { accountUpdatedAt: account.updatedAt } : {}),
    updatedAt: input.autonomous.lastScanAt ?? account?.updatedAt ?? input.updatedAt
  };
  return [strict, highRisk, autonomous];
}

function defaultPortfolio(initialNav = DEFAULT_RISK_POLICY.initialNavUsd): PortfolioSnapshot {
  const at = new Date().toISOString();
  return {
    mode: "PAPER",
    capturedAt: at,
    navUsd: initialNav,
    peakNavUsd: initialNav,
    dayStartNavUsd: initialNav,
    deployedUsd: 0,
    solReserveUsd: DEFAULT_RISK_POLICY.initialSolAllocationUsd,
    liquidReserveUsd: initialNav,
    realizedPnlUsd: 0,
    unrealizedPnlUsd: 0,
    openPositions: 0,
    balanceMismatchPercent: 0
  };
}

const SHADOW_EVIDENCE_STARTED_AT_SETTING = "data_provider_shadow_evidence_started_at";
// Dashboard construction performs several synchronous SQLite aggregates over
// the durable research ledger. A browser can request the same snapshot many
// times after an SSE burst, so bound those scans to one per refresh window.
// `updatedAt` remains the honest capture time, runtime/background writes become
// visible within this bounded window, and AppService-owned mutations invalidate
// both caches immediately.
const DASHBOARD_SNAPSHOT_CACHE_TTL_MS = 15_000;
const DATA_PROVIDER_STATUS_CACHE_TTL_MS = 15_000;

function dashboardExecution(record: ExecutionRecord): ExecutionRecord {
  const { transactionBase64: _transactionBase64, ...quote } = record.quote;
  return {
    ...record,
    quote,
    ...(record.failureReason ? { failureReason: redactSensitiveText(record.failureReason, 1_000) } : {}),
    ...(record.policyViolation ? { policyViolation: redactSensitiveText(record.policyViolation, 1_000) } : {})
  };
}

class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.tail;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

// One lock protects the complete validate -> persist -> reconfigure sequence
// from every user-requested mode/profile transition in this process. Keeping
// it at module scope also protects deployments that construct more than one
// AppService around the same durable state (for example, during tests or a
// staged server handoff).
const dataProviderModeTransitionMutex = new AsyncMutex();

export function dashboardUsageProvider(
  mode: DataProviderProfile["mode"],
  logicalProvider: ProviderName
): ProviderUsageSource {
  if (logicalProvider === "pyth") return "pyth_benchmarks";
  return logicalProvider === "helius" && mode !== "MANAGED" ? "solana_rpc" : logicalProvider;
}

function sameDataProviderProfile(left: DataProviderProfile, right: DataProviderProfile): boolean {
  return left.mode === right.mode
    && left.solanaHttpUrl === right.solanaHttpUrl
    && left.solanaWsUrl === right.solanaWsUrl
    && left.emergencySolanaHttpUrl === right.emergencySolanaHttpUrl;
}

function sameShadowEndpoints(left: DataProviderProfile, right: DataProviderProfile): boolean {
  return left.solanaHttpUrl === right.solanaHttpUrl
    && left.solanaWsUrl === right.solanaWsUrl
    && left.emergencySolanaHttpUrl === right.emergencySolanaHttpUrl;
}

export class AppService {
  readonly marketplace: MarketplaceService;
  private dashboardSnapshotCache:
    | { readonly expiresAt: number; readonly snapshot: DashboardSnapshot }
    | undefined;
  private dataProviderStatusCache:
    | { readonly expiresAt: number; readonly status: DataProviderStatus }
    | undefined;
  private alpacaPaperStatusCache:
    | { readonly expiresAt: number; readonly status: AlpacaPaperStatus }
    | undefined;

  constructor(
    readonly repository: Repository,
    readonly vault: SecretVault,
    readonly wallet: WalletManager,
    readonly modes: ModeManager,
    readonly events: EventBus,
    readonly runtime: RuntimeController
  ) {
    this.marketplace = new MarketplaceService(repository.db);
  }

  setupStatus(): {
    configured: boolean;
    credentialsConfigured: boolean;
    paperInitialized: boolean;
    paperCapitalUsd: number | null;
    providers: ReturnType<Repository["listProviderHealth"]>;
    paperStartAt?: string;
    mode: ModeState;
    wallet: ReturnType<WalletManager["status"]>;
    dataProvider: DataProviderStatus;
  } {
    const paperStartAt = this.repository.getSetting<string>("paper_start_at");
    const credentials = this.vault.getCredentials();
    const profile = this.vault.getDataProviderProfile();
    const credentialsConfigured = Boolean(
      credentials?.jupiterApiKey?.trim() &&
      (profile.mode === "SELF_HOSTED" || (
        credentials.birdeyeApiKey?.trim() && credentials.heliusApiKey?.trim()
      ))
    );
    return {
      configured: credentialsConfigured && Boolean(paperStartAt),
      credentialsConfigured,
      paperInitialized: Boolean(paperStartAt),
      paperCapitalUsd: this.repository.getSetting<number>("paper_initial_nav_usd") ?? null,
      providers: this.repository.listProviderHealth(),
      ...(paperStartAt ? { paperStartAt } : {}),
      mode: this.modes.mode,
      wallet: this.wallet.status(),
      dataProvider: this.dataProviderStatus()
    };
  }

  async alpacaPaperStatus(): Promise<AlpacaPaperStatus> {
    const cached = this.alpacaPaperStatusCache;
    if (cached && Date.now() < cached.expiresAt) return cached.status;

    let status: AlpacaPaperStatus;
    let credentials: AlpacaPaperCredentials | undefined;
    try {
      credentials = this.vault.getAlpacaPaperCredentials();
    } catch {
      status = {
        configured: true,
        connected: false,
        paperOnly: true,
        liveOrderCapabilityEnabled: false,
        marketDataFeed: "IEX",
        tradingEndpoint: "paper-api.alpaca.markets",
        dataEndpoint: "data.alpaca.markets",
        message: "The encrypted Alpaca Paper credential could not be read by this Windows account."
      };
      this.alpacaPaperStatusCache = {
        status,
        expiresAt: Date.now() + DATA_PROVIDER_STATUS_CACHE_TTL_MS
      };
      return status;
    }
    if (!credentials) {
      status = {
        configured: false,
        connected: false,
        paperOnly: true,
        liveOrderCapabilityEnabled: false,
        marketDataFeed: "IEX",
        tradingEndpoint: "paper-api.alpaca.markets",
        dataEndpoint: "data.alpaca.markets",
        message: "Alpaca Paper is optional and has not been connected."
      };
    } else {
      status = await new AlpacaPaperProvider(credentials).checkHealth();
    }
    this.alpacaPaperStatusCache = {
      status,
      expiresAt: Date.now() + DATA_PROVIDER_STATUS_CACHE_TTL_MS
    };
    return status;
  }

  async saveAlpacaPaperCredentials(
    credentials: AlpacaPaperCredentials
  ): Promise<AlpacaPaperStatus> {
    return dataProviderModeTransitionMutex.runExclusive(async () => {
      this.assertAlpacaPaperCredentialChangeAllowed();
      const status = await new AlpacaPaperProvider(credentials).checkHealth();
      if (!status.connected) {
        throw new Error("Alpaca Paper validation failed; nothing was saved.");
      }
      this.assertAlpacaPaperCredentialChangeAllowed();
      this.vault.setAlpacaPaperCredentials(credentials);
      this.alpacaPaperStatusCache = undefined;
      this.repository.audit(
        "alpaca_paper_credentials_saved",
        "Alpaca Paper credentials were validated against the fixed paper and free-IEX endpoints, then encrypted with Windows DPAPI."
      );
      await this.runtime.alpacaPaperConfigurationChanged?.();
      this.invalidateDashboardSnapshot();
      this.events.publish("alpaca-paper", status);
      return status;
    });
  }

  private assertAlpacaPaperCredentialChangeAllowed(): void {
    if (this.modes.mode !== "SETUP" && this.modes.mode !== "PAPER") {
      throw new Error("Alpaca Paper credentials can be changed only in SETUP or PAPER mode.");
    }
  }

  dataProviderStatus(): DataProviderStatus {
    const cached = this.dataProviderStatusCache;
    if (cached && Date.now() < cached.expiresAt) return cached.status;

    const status = this.buildDataProviderStatus();
    this.dataProviderStatusCache = {
      status,
      expiresAt: Date.now() + DATA_PROVIDER_STATUS_CACHE_TTL_MS
    };
    return status;
  }

  private buildDataProviderStatus(): DataProviderStatus {
    const fullProfile = this.vault.getDataProviderProfile();
    const profile = summarizeDataProviderProfile(fullProfile);
    const rpcReadiness = activeRpcReadiness(
      fullProfile,
      this.repository.getSetting<StoredDataProviderRpcReadiness>(RPC_READINESS_SETTING)
    );
    const emergencyExitRpc = activeEmergencyExitRpcStatus(
      fullProfile,
      this.repository.getSetting<StoredEmergencyExitRpcStatus>(EMERGENCY_EXIT_RPC_STATUS_SETTING)
    );
    const endpointFingerprint = dataProviderEndpointFingerprint(fullProfile);
    const proofEpoch = endpointFingerprint
      ? this.repository.activeProviderParityProofEpoch(endpointFingerprint)
      : undefined;
    const latestProofCandidate = endpointFingerprint
      ? this.repository.latestProviderParityProofEpoch(endpointFingerprint)
      : undefined;
    const proofCandidate = proofEpoch ?? (
      latestProofCandidate?.status === "PREPARED" ? latestProofCandidate : undefined
    );
    // Legacy and rolling comparisons remain queryable in the audit ledger, but
    // readiness receives only rows bound to the one exact ACTIVE proof epoch.
    const observations = proofEpoch
      ? this.repository.listProviderParityObservationsForProofEpoch(proofEpoch.id)
      : [];
    const baselineRun = this.relevantProviderParityBaselineRun(
      endpointFingerprint,
      proofEpoch?.id ?? proofCandidate?.id
    );
    return calculateProviderReadiness({
      profile,
      emergencyExitRpc,
      ...(endpointFingerprint ? { endpointFingerprint } : {}),
      ...(proofEpoch ? { proofEpoch } : {}),
      ...(proofCandidate ? { proofCandidate } : {}),
      ...(baselineRun ? { baselineRun } : {}),
      ...(rpcReadiness ? { rpcReadiness } : {}),
      priceCoverage: this.repository.solPriceCoverage(),
      observations,
      selfHostedPaperSoak: calculateSelfHostedPaperSoakStatus(this.repository, fullProfile)
    });
  }

  solPriceBootstrapStatus(): SolPriceBootstrapStatus {
    return this.runtime.solPriceBootstrapStatus();
  }

  providerParityBaselineStatus(): ProviderParityBaselineRun | undefined {
    const profile = this.vault.getDataProviderProfile();
    const endpointFingerprint = dataProviderEndpointFingerprint(profile);
    if (!endpointFingerprint) return undefined;
    const active = this.repository.activeProviderParityProofEpoch(endpointFingerprint);
    const prepared = active ?? this.repository.latestProviderParityProofEpoch(endpointFingerprint, "PREPARED");
    return this.relevantProviderParityBaselineRun(endpointFingerprint, prepared?.id);
  }

  private relevantProviderParityBaselineRun(
    endpointFingerprint: string | undefined,
    proofEpochId?: string
  ): ProviderParityBaselineRun | undefined {
    if (!endpointFingerprint) return undefined;
    if (proofEpochId) return this.repository.providerParityBaselineRunForProofEpoch(proofEpochId);
    const latest = this.repository.latestProviderParityBaselineRun();
    if (!latest || latest.endpointFingerprint !== endpointFingerprint) return undefined;
    if (latest.proofEpochId) {
      const epoch = this.repository.providerParityProofEpoch(latest.proofEpochId);
      if (!epoch || epoch.status === "INVALIDATED") return undefined;
    }
    return latest;
  }

  async captureProviderParityBaseline(): Promise<ProviderParityBaselineRun> {
    return dataProviderModeTransitionMutex.runExclusive(async () => {
      if (this.modes.mode !== "PAPER") {
        throw new Error("Frozen provider parity capture is allowed only in PAPER mode.");
      }
      if (this.vault.getDataProviderProfile().mode !== "SHADOW") {
        throw new Error("Frozen provider parity capture requires the active SHADOW profile.");
      }
      if (
        this.repository.listPositions("PAPER", true).length > 0 ||
        this.repository.listPositions("LIVE", true).length > 0
      ) throw new Error("Close every bot-created position before freezing a provider parity baseline.");
      const run = await this.runtime.captureProviderParityBaseline();
      this.repository.audit(
        "provider_parity_baseline_capture",
        run.status === "ACTIVE"
          ? "The frozen provider parity baseline was captured and activated."
          : "The frozen provider parity baseline remains fail-closed.",
        {
          runId: run.id,
          status: run.status,
          blockerCodes: run.blockers.map((entry) => entry.code),
          acquisitions: run.acquisitions.length
        },
        run.status === "ACTIVE" ? "info" : "warning"
      );
      this.invalidateDashboardSnapshot();
      this.events.publish("provider-parity-baseline", run);
      return run;
    });
  }

  startSolPriceBootstrap(): SolPriceBootstrapStatus {
    if (this.modes.mode !== "SETUP" && this.modes.mode !== "PAPER") {
      throw new Error("The SOL/USD bootstrap can start only in SETUP or PAPER mode.");
    }
    const status = this.runtime.startSolPriceBootstrap();
    this.invalidateDashboardSnapshot();
    this.events.publish("sol-price-bootstrap", status);
    return status;
  }

  async pauseSolPriceBootstrap(): Promise<SolPriceBootstrapStatus> {
    const status = await this.runtime.pauseSolPriceBootstrap();
    this.invalidateDashboardSnapshot();
    this.events.publish("sol-price-bootstrap", status);
    return status;
  }

  async savePythBenchmarksApiKey(apiKey: string): Promise<SolPriceBootstrapStatus> {
    this.assertPythBenchmarksCredentialChangeAllowed();
    const credentials = this.vault.getCredentials();
    if (!credentials) throw new Error("Save the required provider credentials first.");
    await this.saveCredentials(
      { ...credentials, pythBenchmarksApiKey: apiKey },
      () => this.assertPythBenchmarksCredentialChangeAllowed()
    );
    this.repository.audit(
      "pyth_benchmarks_key_saved",
      "The optional Pyth Benchmarks key was validated and stored in the encrypted provider vault."
    );
    return this.solPriceBootstrapStatus();
  }

  async saveCredentials(
    credentials: ProviderCredentials,
    beforeCommit?: () => void
  ): Promise<ProviderHealth[]> {
    return dataProviderModeTransitionMutex.runExclusive(
      () => this.saveCredentialsExclusively(credentials, beforeCommit)
    );
  }

  private async saveCredentialsExclusively(
    credentials: ProviderCredentials,
    beforeCommit?: () => void
  ): Promise<ProviderHealth[]> {
    this.assertCredentialChangeAllowed();
    const previousCredentials = this.vault.getCredentials();
    const health = await this.runtime.validateCredentials(credentials);
    if (health.some((entry) => !entry.ok)) {
      throw new Error("One or more provider credentials failed validation; nothing was saved.");
    }
    // Validation performs provider I/O. Recheck immediately before the vault
    // write so a newly opened lot or mode change cannot race the commit.
    this.assertCredentialChangeAllowed();
    await this.runtime.quiesceProviderWork();
    let vaultChanged = false;
    try {
      // Quiescing awaits old index/stream shutdown. Recheck once more before
      // making the newly selected credentials visible to any runtime reader.
      this.assertCredentialChangeAllowed();
      beforeCommit?.();
      this.vault.setCredentials(credentials);
      vaultChanged = true;
      await this.runtime.credentialsChanged();
      this.assertCredentialChangeAllowed();
      await this.runtime.resumeProviderWork();
    } catch (error) {
      let rollbackFailure: unknown;
      if (vaultChanged) {
        if (previousCredentials) this.vault.setCredentials(previousCredentials);
        else this.vault.clearCredentials();
        try {
          await this.runtime.credentialsChanged();
        } catch (rollbackError) {
          rollbackFailure = rollbackError;
        }
      }
      if (!rollbackFailure) {
        try {
          await this.runtime.resumeProviderWork();
        } catch (resumeError) {
          rollbackFailure = resumeError;
        }
      }
      if (rollbackFailure) {
        this.repository.audit(
          "provider_credentials_rollback_failed",
          "Provider credential rollback could not safely resume the prior provider composition.",
          undefined,
          "critical"
        );
        throw new Error(
          `Provider credential transition failed and rollback stayed quiesced: ${rollbackFailure instanceof Error ? rollbackFailure.message : "unknown rollback failure"}`,
          { cause: error }
        );
      }
      throw error;
    }
    for (const entry of health) this.repository.setProviderHealth(entry);
    this.repository.audit("credentials_saved", "Provider credentials were validated and encrypted.");
    this.invalidateDashboardSnapshot();
    this.events.publish("setup", { credentialsConfigured: true });
    return health;
  }

  private assertCredentialChangeAllowed(): void {
    if (this.modes.mode !== "SETUP" && this.modes.mode !== "PAPER") {
      throw new Error("Provider credentials can be changed only in SETUP or PAPER mode.");
    }
    if (
      this.repository.listPositions("PAPER", true).length > 0 ||
      this.repository.listPositions("LIVE", true).length > 0
    ) {
      throw new Error("Close every bot-created position before changing provider credentials.");
    }
  }

  private assertPythBenchmarksCredentialChangeAllowed(): void {
    if (this.modes.mode !== "SETUP" && this.modes.mode !== "PAPER") {
      throw new Error("The Pyth API key can be changed only in SETUP or PAPER mode.");
    }
  }

  async saveDataProviderProfile(input: DataProviderProfile): Promise<DataProviderStatus> {
    return dataProviderModeTransitionMutex.runExclusive(
      () => this.saveDataProviderProfileExclusively(input)
    );
  }

  private async saveDataProviderProfileExclusively(input: DataProviderProfile): Promise<DataProviderStatus> {
    this.assertDataProviderChangeAllowed();
    const profile = normalizeDataProviderProfile(input);
    const previous = this.vault.getDataProviderProfile();
    if (profile.mode === "SELF_HOSTED") {
      this.assertSelfHostedPromotionAllowed(profile, previous);
    }
    const health = await this.runtime.validateDataProviderProfile(profile);
    if (!health.ok) throw new Error(`Data-provider validation failed: ${health.message}`);
    // Health validation performs network I/O. Recheck every mutable safety
    // prerequisite immediately before changing the encrypted profile.
    this.assertDataProviderChangeAllowed();
    const current = this.vault.getDataProviderProfile();
    if (!sameDataProviderProfile(current, previous)) {
      throw new Error("The data-provider profile changed during validation; review it and try again.");
    }
    if (profile.mode === "SELF_HOSTED") {
      this.assertSelfHostedPromotionAllowed(profile, current);
    }
    const shadowEvidenceStartedAt = new Date().toISOString();
    const resetShadowEvidence = profile.mode === "SHADOW" && (
      previous.mode !== "SHADOW"
      || !sameShadowEndpoints(previous, profile)
      || typeof this.repository.getSetting<unknown>(SHADOW_EVIDENCE_STARTED_AT_SETTING) !== "string"
    );
    const profileChanged = !sameDataProviderProfile(previous, profile);
    await this.runtime.quiesceProviderWork();
    let vaultChanged = false;
    try {
      this.assertDataProviderChangeAllowed();
      const selectedProfile = this.vault.getDataProviderProfile();
      if (!sameDataProviderProfile(selectedProfile, previous)) {
        throw new Error("The data-provider profile changed while old provider work was quiescing.");
      }
      if (profileChanged) {
        this.repository.resetSelfHostedPaperSoak(
          "the encrypted data-provider profile changed",
          shadowEvidenceStartedAt
        );
      }
      this.vault.setDataProviderProfile(profile);
      vaultChanged = true;
      await this.runtime.dataProviderProfileChanged();
      this.assertDataProviderChangeAllowed();
      await this.runtime.resumeProviderWork();
    } catch (error) {
      let rollbackFailure: unknown;
      if (vaultChanged) {
        this.vault.setDataProviderProfile(previous);
        if (profileChanged) {
          this.repository.resetSelfHostedPaperSoak(
            "the data-provider profile change was rolled back",
            new Date().toISOString()
          );
        }
        try {
          await this.runtime.dataProviderProfileChanged();
        } catch (rollbackError) {
          rollbackFailure = rollbackError;
        }
      }
      if (!rollbackFailure) {
        try {
          await this.runtime.resumeProviderWork();
        } catch (resumeError) {
          rollbackFailure = resumeError;
        }
      }
      if (vaultChanged && previous.mode === "SHADOW" && !sameShadowEndpoints(previous, profile)) {
        // A failed endpoint change can still emit observations while the new
        // composition is partially active. Reset the old profile's epoch so
        // mixed-endpoint evidence can never unlock promotion.
        this.repository.setSetting(SHADOW_EVIDENCE_STARTED_AT_SETTING, new Date().toISOString());
      }
      if (rollbackFailure) {
        this.repository.audit(
          "data_provider_profile_rollback_failed",
          "Data-provider rollback could not safely resume the prior provider composition.",
          undefined,
          "critical"
        );
        throw new Error(
          `Data-provider transition failed and rollback stayed quiesced: ${rollbackFailure instanceof Error ? rollbackFailure.message : "unknown rollback failure"}`,
          { cause: error }
        );
      }
      throw error;
    }
    if (resetShadowEvidence) {
      this.repository.setSetting(SHADOW_EVIDENCE_STARTED_AT_SETTING, shadowEvidenceStartedAt);
      this.repository.invalidateProviderParityProofEpochs(
        "the active SHADOW endpoint profile or proof start changed",
        shadowEvidenceStartedAt
      );
      this.repository.audit(
        "data_provider_shadow_evidence_reset",
        "Shadow parity evidence restarted for the active self-hosted endpoints.",
        { startedAt: shadowEvidenceStartedAt }
      );
    }
    const summary = summarizeDataProviderProfile(profile);
    this.repository.audit("data_provider_profile_changed", `Data provider changed to ${profile.mode}.`, summary);
    this.invalidateDashboardSnapshot();
    this.events.publish("data-provider", summary);
    return this.dataProviderStatus();
  }

  private assertDataProviderChangeAllowed(): void {
    if (this.modes.mode !== "SETUP" && this.modes.mode !== "PAPER") {
      throw new Error("Data-provider changes are allowed only in SETUP or PAPER mode.");
    }
    if (
      this.repository.listPositions("PAPER", true).length > 0 ||
      this.repository.listPositions("LIVE", true).length > 0
    ) {
      throw new Error("Close every bot-created position before changing the data provider.");
    }
  }

  private assertSelfHostedPromotionAllowed(
    profile: DataProviderProfile,
    activeProfile: DataProviderProfile
  ): void {
    if (activeProfile.mode !== "SHADOW" || !sameShadowEndpoints(activeProfile, profile)) {
      throw new Error(
        "Self-hosted promotion requires the exact primary, WebSocket, and emergency-exit endpoints from the active SHADOW profile."
      );
    }
    // Promotion is safety-critical: never let the bounded display cache unlock
    // SELF_HOSTED after its proof, RPC readiness, soak, or coverage changed.
    const readiness = this.buildDataProviderStatus();
    if (!readiness.selfHostedReady) {
      throw new Error(`Self-hosted promotion is blocked: ${readiness.blockers.join("; ")}`);
    }
  }

  async initializePaper(initialNavUsd = DEFAULT_RISK_POLICY.initialNavUsd): Promise<PortfolioSnapshot> {
    return dataProviderModeTransitionMutex.runExclusive(
      () => this.initializePaperExclusively(initialNavUsd)
    );
  }

  private async initializePaperExclusively(
    initialNavUsd = DEFAULT_RISK_POLICY.initialNavUsd
  ): Promise<PortfolioSnapshot> {
    if (!this.setupStatus().credentialsConfigured) throw new Error("Validate the required provider credentials first.");
    if (initialNavUsd !== DEFAULT_RISK_POLICY.initialNavUsd) {
      throw new Error(`The paper portfolio is fixed at $${DEFAULT_RISK_POLICY.initialNavUsd}.`);
    }
    if (this.repository.getSetting<string>("paper_start_at")) {
      throw new Error("Paper mode is already initialized; its start date cannot be reset.");
    }
    const snapshot = defaultPortfolio(initialNavUsd);
    this.repository.setSetting("paper_start_at", snapshot.capturedAt);
    this.repository.setSetting("paper_initial_nav_usd", initialNavUsd);
    this.repository.savePortfolioSnapshot(snapshot);
    this.modes.transition("PAPER");
    await this.runtime.modeChanged("PAPER");
    this.repository.audit(
      "paper_initialized",
      `A $${DEFAULT_RISK_POLICY.initialNavUsd} paper portfolio was initialized.`,
      snapshot
    );
    this.invalidateDashboardSnapshot();
    this.events.publish("mode", { mode: "PAPER" });
    return snapshot;
  }

  dashboard(): DashboardSnapshot {
    const cached = this.dashboardSnapshotCache;
    if (cached && Date.now() < cached.expiresAt) return cached.snapshot;

    const snapshot = this.buildDashboardSnapshot();
    this.dashboardSnapshotCache = {
      snapshot,
      // Measure from completion so a slow aggregate cannot consume the whole
      // coalescing window before its result becomes available.
      expiresAt: Date.now() + DASHBOARD_SNAPSHOT_CACHE_TTL_MS
    };
    return snapshot;
  }

  private buildDashboardSnapshot(): DashboardSnapshot {
    const mode = this.modes.mode;
    const executionMode = mode === "MANUAL_LIVE" || mode === "AUTO_LIVE" || mode === "LOCKED" ? "LIVE" : "PAPER";
    const portfolio =
      this.repository.latestPortfolioSnapshot(executionMode) ??
      this.repository.latestPortfolioSnapshot("PAPER") ??
      defaultPortfolio(
        this.repository.getSetting<number>("paper_initial_nav_usd") ?? DEFAULT_RISK_POLICY.initialNavUsd
      );
    const cohort = this.repository.latestCohort();
    const candidates = cohort ? this.repository.listCandidates(cohort.cohortId) : [];
    const activeAddresses = new Set(this.repository.activePaperEvaluationCohort()?.wallets ?? []);
    const scoreList = cohort ? this.repository.listWalletScores(cohort.cohortId) : [];
    const scores = new Map(scoreList.map((score) => [score.wallet, score]));
    const cohortWallets: DashboardSnapshot["activeWallets"] = candidates.map((candidate) => {
      const score = scores.get(candidate.address);
      const trackingLane = candidate.control
        ? "CONTROL" as const
        : activeAddresses.has(candidate.address)
          ? "ACTIVE" as const
          : "SHADOW" as const;
      return score ? { ...candidate, score, trackingLane } : { ...candidate, trackingLane };
    });
    // The dashboard is refreshed frequently, so it carries only a bounded
    // cohort digest. The full local universe is available through the
    // paginated research endpoint below.
    const activeWallets = cohortWallets
      .sort((left, right) => {
        const priority = (wallet: typeof left): number => {
          if (wallet.trackingLane === "ACTIVE") return 0;
          if (wallet.trackingLane === "CONTROL") return 1;
          if (wallet.score?.qualified) return 2;
          if (wallet.score) return 3;
          return 4;
        };
        return priority(left) - priority(right)
          || (left.sourceRank30d ?? Number.MAX_SAFE_INTEGER) - (right.sourceRank30d ?? Number.MAX_SAFE_INTEGER)
          || left.address.localeCompare(right.address);
      })
      .slice(0, DASHBOARD_COHORT_WALLET_LIMIT);
    const pausedFrom = this.modes.pausedFrom;
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    const usage = new Map(
      this.repository.usageSince(monthStart.toISOString().slice(0, 10)).map((entry) => [entry.provider, entry])
    );
    const dataProviderMode = this.vault.getDataProviderProfile().mode;
    const providerHealth = this.repository.listProviderHealth().map((health) => {
      const usageProvider = dashboardUsageProvider(dataProviderMode, health.provider);
      const providerUsage = usage.get(usageProvider);
      return {
        ...health,
        usage: {
          provider: usageProvider,
          requests: providerUsage?.requests ?? 0,
          ...(providerUsage && providerUsage.credits > 0
            ? {
                credits: providerUsage.credits,
                ...(usageProvider === "birdeye"
                  ? { creditLimit: DEFAULT_BIRDEYE_MONTHLY_CU_BUDGET, creditUnit: "CU" as const }
                  : usageProvider === "helius"
                    ? {
                        creditLimit: DEFAULT_TOTAL_HELIUS_MONTHLY_CREDIT_BUDGET,
                        creditUnit: "credits" as const
                      }
                    : usageProvider === "pyth_benchmarks"
                      ? { creditUnit: "credits" as const }
                    : {})
              }
            : {}),
          window: "month" as const
        }
      };
    });
    const indexCreditsUsed = usage.get("helius_index")?.credits ?? 0;
    const totalHeliusCreditsUsed = (usage.get("helius")?.credits ?? 0) + indexCreditsUsed;
    const latestIndexRun = this.repository.listWalletIndexRuns(1)[0];
    const acquisition = this.runtime.walletAcquisitionStatus?.();
    const preflightWindow = managedRecoveryPreflightWindow(new Date());
    const preflightCounts = this.repository.countManagedRecoveryPreflights({
      policyVersion: preflightWindow.policyVersion,
      windowStart: preflightWindow.windowStart
    });
    const researchPaper = this.repository.researchPaperDashboard();
    const autonomousBase = this.repository.autonomousPaperDashboard();
    const learning = this.runtime.autonomousLearningOverview?.();
    const autonomousPaper = learning
      ? { ...autonomousBase, learning }
      : autonomousBase;
    const stockPaper = this.runtime.stockPaperDashboard?.();
    const updatedAt = new Date().toISOString();
    const dataProvider = this.dataProviderStatus();
    const operationalPause = this.runtime.operationalPauseState();
    const operationalTelemetry = this.runtime.operationalTelemetry();
    const comparisons = paperComparisons({
      mode,
      portfolio,
      strictInitialNavUsd:
        this.repository.getSetting<number>("paper_initial_nav_usd") ?? DEFAULT_RISK_POLICY.initialNavUsd,
      strictMaxDrawdownPercent: this.modes.promotion.maxDrawdownPercent,
      strictProfitFactor: this.modes.promotion.profitFactor,
      strictCompletedTrades: this.modes.promotion.completedExits,
      research: researchPaper,
      autonomous: autonomousPaper,
      updatedAt
    });
    const walletIndex: DashboardSnapshot["walletIndex"] = {
      coverage: this.repository.walletIndexCoverage(),
      targetWallets: acquisition?.targetWallets ?? DEFAULT_WALLET_INDEX_TARGET,
      ...(acquisition ? { acquisition } : {}),
      indexCreditsUsed,
      indexCreditBudget: DEFAULT_WALLET_INDEX_MONTHLY_CREDIT_BUDGET,
      totalHeliusCreditsUsed,
      totalHeliusCreditBudget: DEFAULT_TOTAL_HELIUS_MONTHLY_CREDIT_BUDGET,
      managedRecoveryPreflight: {
        ...preflightWindow,
        ...preflightCounts
      },
      researchFunnel: this.walletResearchFunnel(cohort, candidates, scoreList, activeAddresses),
      ...(latestIndexRun ? { latestRun: latestIndexRun } : {})
    };
    const positions = this.repository.listPositions(executionMode);
    const recentExecutions = this.repository.listExecutions(100).map(dashboardExecution);
    const recentSignals = this.repository.listSignalOutcomes(100);
    const pendingApprovals = this.repository.listExecutions(100, true).map(dashboardExecution);
    const liveOperations = buildLiveOperationsSnapshot({
      capturedAt: updatedAt,
      mode,
      dataProvider,
      operationalPause,
      operationalTelemetry,
      providerHealth,
      providerUsage: usage,
      walletIndex,
      positions,
      recentExecutions,
      recentSignals,
      researchPaper,
      autonomousPaper,
      ...(stockPaper ? { stockPaper } : {}),
      runtimeEvents: this.events.recent(100)
    });
    return {
      mode,
      ...(pausedFrom ? { pausedFrom } : {}),
      dataProvider,
      solPriceBootstrap: this.solPriceBootstrapStatus(),
      operationalPause,
      operationalTelemetry,
      providerHealth,
      liveOperations,
      portfolio,
      promotion: this.modes.promotion,
      researchPaper,
      autonomousPaper,
      ...(stockPaper ? { stockPaper } : {}),
      paperComparisons: comparisons,
      walletIndex,
      activeWallets,
      positions,
      recentExecutions,
      recentSignals,
      pendingApprovals,
      updatedAt
    };
  }

  private invalidateDashboardSnapshot(): void {
    this.dashboardSnapshotCache = undefined;
    this.dataProviderStatusCache = undefined;
  }

  walletResearchPage(options: {
    page: number;
    pageSize: number;
    filter: WalletResearchFilter;
    sort: WalletResearchSort;
  }): WalletResearchPage {
    const result = this.repository.pageWalletIndexRecords(options);
    return {
      ...result,
      page: options.page,
      pageSize: options.pageSize,
      totalPages: Math.ceil(result.total / options.pageSize),
      filter: options.filter,
      sort: options.sort,
      capturedAt: new Date().toISOString()
    };
  }

  private walletResearchFunnel(
    cohort?: DiscoveredWalletSet,
    candidates: WalletCandidate[] = cohort ? this.repository.listCandidates(cohort.cohortId) : [],
    scores: WalletScore[] = cohort ? this.repository.listWalletScores(cohort.cohortId) : [],
    activeAddresses: Set<string> = new Set(this.repository.activePaperEvaluationCohort()?.wallets ?? [])
  ): WalletResearchFunnel {
    const local = this.repository.walletIndexFunnelCounts();
    const scored = new Set(scores.map((score) => score.wallet));
    const qualified = new Set(scores.filter((score) => score.qualified).map((score) => score.wallet));
    const eligibleCandidates = candidates.filter((candidate) => !candidate.control);
    const source = ["wallet_candidates", "wallet_scores"];
    return {
      capturedAt: new Date().toISOString(),
      localIndex: [
        {
          key: "INDEXED",
          scope: "LOCAL_INDEX",
          label: "Observed signer candidates",
          count: local.indexed,
          definition: "Distinct wallets observed as the sole fee-paying signer of a successful top-level Jupiter transaction, or proven by a strict normalized swap. Coarse observations make no swap claim.",
          sources: ["wallet_index", "index_signature_sources", "indexed_spot_swaps"]
        },
        {
          key: "ACTIVITY_SCREENED",
          scope: "LOCAL_INDEX",
          label: "Activity checked",
          count: local.activityScreened,
          definition: "Distinct wallets with a durable 90-day activity pre-screen snapshot.",
          sources: ["wallet_prescreen_snapshots"]
        },
        {
          key: "ACTIVITY_PROVEN",
          scope: "LOCAL_INDEX",
          label: "Activity proven",
          count: local.activityProven,
          definition: "Pre-screen proves 90 days of history, at least 50 successful transactions, and activity in three of the latest four weeks.",
          sources: ["wallet_index", "wallet_prescreen_snapshots"]
        },
        {
          key: "CLOSED_SWAPS",
          scope: "LOCAL_INDEX",
          label: "50 closed swaps",
          count: local.closedSwaps,
          definition: "Activity-proven wallets whose frozen 90-day deep history completed with at least 50 locally matched eligible spot exits.",
          sources: ["wallet_index", "indexed_spot_swaps", "ingestion_checkpoints"]
        },
        {
          key: "HOLDING_TIME",
          scope: "LOCAL_INDEX",
          label: "15 min median hold",
          count: local.holdingTime,
          definition: "The completed 90-day deep-history stage with at least 50 exits and a median FIFO matched-lot hold of at least 15 minutes.",
          sources: ["wallet_index", "indexed_spot_swaps", "ingestion_checkpoints"]
        }
      ],
      providerCohort: [
        {
          key: "DEPTH_SCORED",
          scope: "PROVIDER_COHORT",
          label: "Depth scored",
          count: eligibleCandidates.filter((candidate) => scored.has(candidate.address)).length,
          definition: "Non-control candidates with a saved full wallet qualification score.",
          sources: source
        },
        {
          key: "POSITIVE_REALIZED_PNL",
          scope: "PROVIDER_COHORT",
          label: "Positive 30d + 90d",
          count: eligibleCandidates.filter((candidate) =>
            scored.has(candidate.address)
            && (candidate.pnl30d?.realizedProfitUsd ?? 0) > 0
            && (candidate.pnl90d?.realizedProfitUsd ?? 0) > 0
          ).length,
          definition: "Depth-scored non-control candidates with positive realized PnL in both provider windows.",
          sources: source
        },
        {
          key: "RESEARCH_QUALIFIED",
          scope: "PROVIDER_COHORT",
          label: "Research qualified",
          count: eligibleCandidates.filter((candidate) => qualified.has(candidate.address)).length,
          definition: "Non-control candidates passing the unchanged historical wallet qualification policy; this is not a live promotion.",
          sources: source
        },
        {
          key: "FROZEN_ACTIVE",
          scope: "PROVIDER_COHORT",
          label: "Frozen active",
          count: eligibleCandidates.filter((candidate) => activeAddresses.has(candidate.address)).length,
          definition: "Research-qualified wallets explicitly frozen into the current forward paper evaluation cohort.",
          sources: ["wallet_candidates"]
        }
      ]
    };
  }

  async transitionMode(mode: ModeState, confirmed = false): Promise<ModeState> {
    return dataProviderModeTransitionMutex.runExclusive(
      () => this.transitionModeExclusively(mode, confirmed)
    );
  }

  async setResearchPaperEnabled(enabled: boolean): Promise<ResearchPaperDashboard> {
    if (this.modes.mode !== "PAPER") {
      throw new Error("The high-risk research comparison can be changed only in exact PAPER mode.");
    }
    let lane = this.repository.activeResearchPaperLane();
    if (enabled) {
      if (!lane) {
        const latest = this.repository.latestResearchPaperLane();
        lane = latest?.status === "PAUSED"
          ? this.repository.resumeResearchPaperLane(latest.id)
          : this.repository.createResearchPaperLane({
              id: `research-paper:${randomUUID()}`,
              policyVersion: RESEARCH_PAPER_POLICY_VERSION,
              initialNavPerLeaderUsd:
                this.repository.getSetting<number>("paper_initial_nav_usd") ?? DEFAULT_RISK_POLICY.initialNavUsd,
              policy: largerResearchPaperPolicy()
            });
      }
      if (!lane) throw new Error("The high-risk research lane could not be activated.");
      this.repository.initializeResearchPaperAccountsForActiveLeaders(lane.id);
      const watchlist = this.repository.refreshResearchPaperWatchlist(lane.id);
      this.repository.audit(
        "research_paper_enabled",
        "The isolated high-risk PAPER comparison was enabled without changing strict PAPER or live policy.",
        {
          laneId: lane.id,
          leaders: watchlist.totalLeaderCount,
          strictLeaders: watchlist.strictLeaderCount,
          researchOnlyWallets: watchlist.researchOnlyMonitoredCount,
          eligibleCandidates: watchlist.eligibleCandidateCount,
          targetWallets: watchlist.policy.targetWalletCount
        }
      );
    } else if (lane) {
      lane = this.repository.pauseResearchPaperLane(lane.id);
      this.repository.audit(
        "research_paper_paused",
        "The isolated high-risk PAPER comparison was paused.",
        { laneId: lane?.id }
      );
    }
    await this.runtime.researchPaperConfigurationChanged?.();
    this.invalidateDashboardSnapshot();
    const dashboard = this.repository.researchPaperDashboard(lane?.id);
    this.events.publish("research-paper", {
      enabled: dashboard.lane?.status === "ACTIVE",
      laneId: dashboard.lane?.id
    });
    return dashboard;
  }

  async setAutonomousPaperEnabled(enabled: boolean): Promise<AutonomousPaperDashboard> {
    return dataProviderModeTransitionMutex.runExclusive(async () => {
      if (this.modes.mode !== "PAPER") {
        throw new Error("The autonomous momentum comparison can be changed only in exact PAPER mode.");
      }
      let lane = this.repository.activeAutonomousPaperLane();
      if (enabled) {
        if (!lane) {
          const latest = this.repository.latestAutonomousPaperLane();
          lane = latest?.status === "PAUSED"
            ? this.repository.resumeAutonomousPaperLane(latest.id)
            : this.repository.createAutonomousPaperLane({
                id: `autonomous-paper:${randomUUID()}`,
                policyVersion: AUTONOMOUS_PAPER_POLICY_VERSION,
                policy: { ...DEFAULT_AUTONOMOUS_PAPER_POLICY },
                initialNavUsd:
                  this.repository.getSetting<number>("paper_initial_nav_usd") ?? DEFAULT_RISK_POLICY.initialNavUsd
              });
        }
        if (!lane) throw new Error("The autonomous momentum lane could not be activated.");
        this.repository.initializeAutonomousPaperAccount(lane.id);
        this.repository.audit(
          "autonomous_paper_enabled",
          "The isolated autonomous momentum PAPER comparison was enabled without changing copy trading or live policy.",
          { laneId: lane.id, policyVersion: lane.policyVersion, initialNavUsd: lane.initialNavUsd }
        );
      } else if (lane) {
        lane = this.repository.pauseAutonomousPaperLane(lane.id);
        this.repository.audit(
          "autonomous_paper_paused",
          "The isolated autonomous momentum PAPER comparison was paused.",
          { laneId: lane?.id }
        );
      }
      await this.runtime.autonomousPaperConfigurationChanged?.();
      this.invalidateDashboardSnapshot();
      const dashboard = this.repository.autonomousPaperDashboard(lane?.id);
      this.events.publish("autonomous-paper", {
        enabled: dashboard.lane?.status === "ACTIVE",
        laneId: dashboard.lane?.id
      });
      return dashboard;
    });
  }

  autonomousLearningOverview(): AutonomousLearningOverview {
    const overview = this.runtime.autonomousLearningOverview?.();
    if (!overview) throw new Error("The autonomous learning engine is unavailable.");
    return overview;
  }

  async trainAutonomousLearning(): Promise<AutonomousLearningOverview> {
    const train = this.runtime.trainAutonomousLearning;
    if (!train) throw new Error("The autonomous learning engine cannot train in this runtime.");
    const overview = await train.call(this.runtime);
    this.invalidateDashboardSnapshot();
    this.events.publish("autonomous-learning", { outcome: "TRAINING_COMPLETE" });
    return overview;
  }

  promoteAutonomousChallenger(confirmation: string): ChampionPromotionDecision {
    const promote = this.runtime.promoteAutonomousChallenger;
    if (!promote) throw new Error("Autonomous challenger promotion is unavailable.");
    const decision = promote.call(this.runtime, confirmation);
    this.invalidateDashboardSnapshot();
    this.events.publish("autonomous-learning", { outcome: "PROMOTION_APPROVED", decisionId: decision.id });
    return decision;
  }

  /**
   * Explicitly starts a new autonomous-paper policy epoch. If the prior lane
   * still has inventory, the first confirmation records a durable drain that
   * blocks new entries while normal exits continue. A later confirmation when
   * flat pauses and drains the runtime, then performs the atomic rotation.
   * This path never accepts a caller-supplied policy and remains entirely
   * outside promotion, approval, signing, and execution state.
   */
  async upgradeAutonomousPaperPolicy(confirmed = false): Promise<AutonomousPaperDashboard> {
    return dataProviderModeTransitionMutex.runExclusive(async () => {
      if (!confirmed) {
        throw new Error("Upgrading autonomous PAPER requires explicit confirmation.");
      }
      if (this.modes.mode !== "PAPER") {
        throw new Error("The autonomous PAPER policy can be upgraded only in exact PAPER mode.");
      }
      const prior = this.repository.activeAutonomousPaperLane();
      if (!prior) {
        throw new Error("Enable the autonomous PAPER lane before upgrading its policy.");
      }
      if (prior.policyVersion === AUTONOMOUS_PAPER_POLICY_VERSION) {
        throw new Error("The autonomous PAPER lane already uses the current policy version.");
      }
      if (![
        LEGACY_AUTONOMOUS_PAPER_POLICY_VERSION,
        AUTONOMOUS_PAPER_V2_POLICY_VERSION,
        AUTONOMOUS_PAPER_V3_POLICY_VERSION,
        AUTONOMOUS_PAPER_V4_POLICY_VERSION,
        AUTONOMOUS_PAPER_V5_POLICY_VERSION,
        AUTONOMOUS_PAPER_V6_POLICY_VERSION,
        AUTONOMOUS_PAPER_V7_POLICY_VERSION,
        AUTONOMOUS_PAPER_V8_POLICY_VERSION,
        AUTONOMOUS_PAPER_V9_POLICY_VERSION,
        AUTONOMOUS_PAPER_V10_POLICY_VERSION,
        AUTONOMOUS_PAPER_V11_POLICY_VERSION,
        AUTONOMOUS_PAPER_V12_POLICY_VERSION
      ]
        .includes(prior.policyVersion)) {
        throw new Error("Only a supported prior autonomous PAPER policy can be upgraded to the current version.");
      }
      if (!this.runtime.autonomousPaperConfigurationChanged) {
        throw new Error("The autonomous PAPER runtime cannot drain policy work safely.");
      }

      const account = this.repository.getAutonomousPaperAccount(prior.id);
      if (!account) {
        throw new Error("The autonomous PAPER policy cannot be upgraded without its isolated account.");
      }
      const tolerance = 0.02;
      const openPositions = this.repository.listAutonomousPaperPositions({
        laneId: prior.id,
        openOnly: true,
        limit: 500
      });
      const expectedNav = account.initialNavUsd + account.realizedPnlUsd + account.unrealizedPnlUsd;
      const expectedRealized = account.grossProfitUsd - account.grossLossUsd;
      const readyToRotate = account.pricingComplete &&
        account.openPositions === 0 &&
        openPositions.length === 0 &&
        Math.abs(account.deployedUsd) <= tolerance &&
        Math.abs(account.unrealizedPnlUsd) <= tolerance &&
        Math.abs(account.cashUsd - account.navUsd) <= tolerance &&
        Math.abs(account.navUsd - expectedNav) <= tolerance &&
        Math.abs(account.realizedPnlUsd - expectedRealized) <= tolerance &&
        account.navUsd > 0;

      const pendingDrain = this.repository.getAutonomousPaperUpgradeDrain(prior.id);
      if (pendingDrain && pendingDrain.toPolicyVersion !== AUTONOMOUS_PAPER_POLICY_VERSION) {
        throw new Error(
          "The pending autonomous PAPER upgrade targets a different policy version and requires review."
        );
      }

      if (!readyToRotate) {
        const drain = this.repository.requestAutonomousPaperUpgradeDrain({
          laneId: prior.id,
          fromPolicyVersion: prior.policyVersion,
          toPolicyVersion: AUTONOMOUS_PAPER_POLICY_VERSION
        });
        if (!pendingDrain) {
          this.repository.audit(
            "autonomous_paper_policy_upgrade_drain_requested",
            "The confirmed autonomous PAPER upgrade paused new entries while existing positions continue normal policy exits.",
            {
              laneId: prior.id,
              fromPolicyVersion: prior.policyVersion,
              toPolicyVersion: AUTONOMOUS_PAPER_POLICY_VERSION,
              openPositions: openPositions.length,
              forcedLiquidation: false,
              executionEnabled: false
            }
          );
        }
        try {
          await this.runtime.autonomousPaperConfigurationChanged();
        } catch (error) {
          this.repository.audit(
            "autonomous_paper_upgrade_drain_requeue_failed",
            "The policy-upgrade drain is durable, but its immediate PAPER runtime refresh failed.",
            {
              laneId: prior.id,
              policyVersion: prior.policyVersion,
              error: redactSensitiveText(error instanceof Error ? error.message : String(error))
            }
          );
        }
        this.invalidateDashboardSnapshot();
        const dashboard = this.repository.autonomousPaperDashboard(prior.id);
        this.events.publish("autonomous-paper", {
          enabled: true,
          draining: true,
          laneId: prior.id,
          policyVersion: prior.policyVersion,
          toPolicyVersion: drain.toPolicyVersion,
          executionEnabled: false
        });
        return dashboard;
      }

      const paused = this.repository.pauseAutonomousPaperLane(prior.id);
      if (!paused || paused.status !== "PAUSED") {
        throw new Error("The prior autonomous PAPER lane could not be paused for upgrade.");
      }

      const restorePriorLane = async (reason: unknown): Promise<never> => {
        this.repository.audit(
          "autonomous_paper_policy_upgrade_failed",
          "The confirmed autonomous PAPER upgrade failed before policy rotation committed; the prior lane was restored.",
          {
            laneId: prior.id,
            policyVersion: prior.policyVersion,
            error: redactSensitiveText(reason instanceof Error ? reason.message : String(reason))
          }
        );
        const restored = this.repository.resumeAutonomousPaperLane(prior.id);
        try {
          await this.runtime.autonomousPaperConfigurationChanged?.();
        } catch (recoveryError) {
          this.repository.audit(
            "autonomous_paper_upgrade_restore_failed",
            "The prior lane was restored after a failed policy upgrade, but its immediate runtime requeue failed.",
            {
              laneId: prior.id,
              policyVersion: prior.policyVersion,
              restored: restored?.status === "ACTIVE",
              error: redactSensitiveText(
                recoveryError instanceof Error ? recoveryError.message : String(recoveryError)
              )
            }
          );
        }
        throw reason;
      };

      try {
        // With no active autonomous lane, the configuration hook drains and
        // recovers claims without being able to queue a replacement cycle.
        await this.runtime.autonomousPaperConfigurationChanged();
      } catch (error) {
        return restorePriorLane(error);
      }
      if (this.modes.mode !== "PAPER") {
        return restorePriorLane(new Error("Exact PAPER mode ended during the autonomous policy upgrade."));
      }

      const rotatedAt = new Date().toISOString();
      const newLaneId = `autonomous-paper:${randomUUID()}`;
      let lane: AutonomousPaperLane;
      try {
        lane = this.repository.rotateAutonomousPaperLane({
          priorLaneId: prior.id,
          newLaneId,
          policyVersion: AUTONOMOUS_PAPER_POLICY_VERSION,
          policy: { ...DEFAULT_AUTONOMOUS_PAPER_POLICY },
          rotatedAt
        });
      } catch (error) {
        return restorePriorLane(error);
      }

      // Successful rotation consumes an exact pending intent inside the
      // repository transaction. This explicit clear remains a harmless
      // compatibility fallback for flat upgrades that had no pending drain.
      this.repository.clearAutonomousPaperUpgradeDrain(prior.id);

      this.repository.initializeAutonomousPaperAccount(lane.id, rotatedAt);
      this.repository.audit(
        "autonomous_paper_policy_upgraded",
        "The confirmed prior autonomous PAPER experiment was archived and a separate current-policy experiment was activated.",
        {
          priorLaneId: prior.id,
          priorPolicyVersion: prior.policyVersion,
          laneId: lane.id,
          policyVersion: lane.policyVersion,
          executionEnabled: false,
          promotionEligible: false
        }
      );

      try {
        await this.runtime.autonomousPaperConfigurationChanged();
      } catch (error) {
        // Rotation is already durable and the prior lane is archived. Leave
        // the current-policy lane active so
        // the normal timer/startup recovery can queue it, and make the failed
        // immediate requeue visible without pretending the rotation rolled back.
        this.repository.audit(
          "autonomous_paper_upgrade_requeue_failed",
          "The current policy rotation committed, but its immediate PAPER runtime requeue failed.",
          {
            laneId: lane.id,
            policyVersion: lane.policyVersion,
            error: redactSensitiveText(error instanceof Error ? error.message : String(error))
          }
        );
      }

      this.invalidateDashboardSnapshot();
      const dashboard = this.repository.autonomousPaperDashboard(lane.id);
      this.events.publish("autonomous-paper", {
        enabled: dashboard.lane?.status === "ACTIVE",
        upgraded: true,
        priorLaneId: prior.id,
        laneId: dashboard.lane?.id,
        policyVersion: dashboard.lane?.policyVersion,
        executionEnabled: false
      });
      return dashboard;
    });
  }

  async enlargeResearchPaperEntries(): Promise<ResearchPaperDashboard> {
    if (this.modes.mode !== "PAPER") {
      throw new Error("High-risk research sizing can be changed only in exact PAPER mode.");
    }
    const active = this.repository.activeResearchPaperLane();
    if (!active) throw new Error("Enable the high-risk research lane before changing its sizing.");
    const revised = this.repository.reviseResearchPaperLanePolicy({
      id: active.id,
      policyVersion: RESEARCH_PAPER_POLICY_VERSION,
      policy: largerResearchPaperPolicy()
    });
    await this.runtime.researchPaperConfigurationChanged?.();
    this.invalidateDashboardSnapshot();
    const dashboard = this.repository.researchPaperDashboard(revised.id);
    this.events.publish("research-paper", {
      laneId: revised.id,
      policyVersion: revised.policyVersion,
      sizingChanged: true
    });
    return dashboard;
  }

  async refreshResearchPaperWatchlist(
    options: ResearchPaperWatchlistRefreshOptions = {}
  ): Promise<ResearchPaperWatchlistRun> {
    if (this.modes.mode !== "PAPER") {
      throw new Error("The high-risk research watchlist can be refreshed only in exact PAPER mode.");
    }
    const lane = this.repository.activeResearchPaperLane();
    if (!lane) throw new Error("Enable the high-risk research comparison before selecting wallets.");
    const run = this.repository.refreshResearchPaperWatchlist(lane.id, options);
    this.repository.audit(
      "research_paper_watchlist_refreshed",
      "Actively trading provider-scored wallets were enrolled without rotating strict or existing research accounts.",
      {
        laneId: lane.id,
        eligibleCandidates: run.eligibleCandidateCount,
        newlyEnrolled: run.newlyEnrolledCount,
        strictLeaders: run.strictLeaderCount,
        strictOverlap: run.strictOverlapCount,
        researchOnlyWallets: run.researchOnlyMonitoredCount,
        totalLeaders: run.totalLeaderCount,
        targetWallets: run.policy.targetWalletCount,
        remainingCapacity: run.remainingCapacity
      }
    );
    await this.runtime.researchPaperConfigurationChanged?.();
    this.invalidateDashboardSnapshot();
    this.events.publish("research-paper", {
      laneId: lane.id,
      watchlist: run
    });
    return run;
  }

  private async transitionModeExclusively(mode: ModeState, confirmed = false): Promise<ModeState> {
    if (this.modes.mode === "PAPER" && mode === "MANUAL_LIVE") {
      const profile = this.vault.getDataProviderProfile();
      if (profile.mode === "SELF_HOSTED") {
        const soak = calculateSelfHostedPaperSoakStatus(this.repository, profile);
        if (!soak.ready) {
          throw new Error(`Manual live is blocked by the self-hosted PAPER soak: ${soak.blockers.join("; ")}`);
        }
      }
    }
    if (mode !== this.modes.mode) await this.runtime.preflightModeChange(mode);
    const result = this.modes.transition(mode, { confirmed });
    if (result !== "PAPER") {
      const researchLane = this.repository.activeResearchPaperLane();
      if (researchLane) this.repository.pauseResearchPaperLane(researchLane.id);
      const autonomousLane = this.repository.activeAutonomousPaperLane();
      if (autonomousLane) this.repository.pauseAutonomousPaperLane(autonomousLane.id);
    }
    try {
      await this.runtime.modeChanged(result);
    } catch (error) {
      if (result === "MANUAL_LIVE" || result === "AUTO_LIVE") {
        const failure = redactSensitiveText(
          error instanceof Error ? error.message : "Live runtime activation failed.",
          1_000
        );
        this.modes.pauseFailedLiveActivation(result, failure);
        this.events.publish("mode", { mode: "PAUSED", pausedFrom: result });
      }
      this.invalidateDashboardSnapshot();
      throw error;
    }
    this.invalidateDashboardSnapshot();
    this.events.publish("mode", { mode: result });
    return result;
  }

  async pause(): Promise<ModeState> {
    return this.transitionMode("PAUSED");
  }

  async resume(): Promise<ModeState> {
    return dataProviderModeTransitionMutex.runExclusive(async () => {
      const target = this.modes.pausedFrom;
      if (!target || target === "PAUSED" || target === "LOCKED") {
        throw new Error("There is no safe mode to resume.");
      }
      return this.transitionModeExclusively(target);
    });
  }
}
