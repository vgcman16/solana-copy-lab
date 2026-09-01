import { randomUUID } from "node:crypto";
import {
  LiveBrokerOrchestrator,
  PaperBroker,
  accrueProportionalExit,
  applyExitFill,
  calculateProfitFactor,
  calculatePromotionGate,
  calculateRuntimeObservationCoverage,
  DEFAULT_RUNTIME_HEARTBEAT_GAP_MS,
  createIdempotencyKey,
  evaluateOperationalStops,
  evaluateRisk,
  evaluateTokenPolicy,
  openPositionLot,
  shouldForcePositionExit,
  type ClosedTradeResult
} from "@copylab/core";
import {
  BirdeyeSolUsdHistoryClient,
  BirdeyeProvider,
  AlpacaPaperProvider,
  createPacedFetch,
  DEFAULT_SPOT_SWAP_PROGRAM_IDS,
  decodeSpotSwapTransaction,
  HeliusRpcClient,
  HeliusObserver,
  JupiterMarketDataProvider,
  JupiterSwapProvider,
  JupiterTokenRiskProvider,
  PythBenchmarksClient,
  ResilientSolUsdHistoryProvider,
  redactSensitiveText,
  diagnoseStandardSolanaRpcReadiness,
  StandardSolanaObserver,
  StandardSolanaRpcClient,
  type FetchLike,
  type RejectedSwapObservation,
  type WalletTokenDecreaseObservation,
  type PythBenchmarksPriceProvider,
  type SolUsdHistoricalPriceProvider
} from "@copylab/providers";
import {
  DEFAULT_TOTAL_HELIUS_MONTHLY_CREDIT_BUDGET,
  DEFAULT_BIRDEYE_MONTHLY_CU_BUDGET,
  DEFAULT_RISK_POLICY,
  PAPER_EVALUATION_WALLET_COUNT,
  SOL_MINT,
  USDC_MINT,
  type AutonomousLearningOverview,
  type AlpacaPaperCredentials,
  type ChampionPromotionDecision,
  type CopyIntent,
  type DataProviderProfile,
  type BrokerOrder,
  type ExecutionRecord,
  type LeaderSwap,
  type ModeState,
  type OperationalPauseReason,
  type OperationalPauseState,
  type OperationalTelemetrySnapshot,
  type PortfolioSnapshot,
  type PositionLot,
  type ProviderCredentials,
  type ProviderHealth,
  type QuoteExecutor,
  type QuoteRequest,
  type QuoteSnapshot,
  type RejectedSourceAction,
  type RiskDecision,
  type StockPaperDashboard,
  type SignalAuditRecord,
  type SignalOutcomeAction,
  type SignalOutcomeReasonCode,
  type SignalOutcomeStatus,
  type TokenEligibility,
  type WalletAcquisitionGoal,
  type WalletCandidate,
  type WalletHistorySummary
} from "@copylab/shared";
import { VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import type { EventBus } from "./events.js";
import type { ModeManager } from "./mode.js";
import type {
  EmergencyExitOperation,
  MonitoringRepairCheckpoint,
  Repository
} from "./repository.js";
import type { RuntimeController } from "./runtime-contract.js";
import type { SecretVault } from "./vault.js";
import {
  HeliusBalanceReader,
  SolanaRpcBalanceReader,
  type BalanceReader
} from "./chain-balance.js";
import { LocalWalletDiscoveryProvider } from "./local-wallet-discovery.js";
import {
  ShadowWalletDiscoveryProvider,
  type HealthCheckedWalletDiscoveryProvider
} from "./provider-parity.js";
import {
  StandardSolanaRuntimeChainProvider,
  type RuntimeChainProvider
} from "./runtime-chain-provider.js";
import { ShadowChainProvider } from "./chain-provider-parity.js";
import { DurableProviderParitySink } from "./provider-parity-proof.js";
import { ProviderParityBaselineCoordinator } from "./provider-parity-coordinator.js";
import { LocalSolPriceOracle } from "./local-sol-price.js";
import { SolPriceBootstrapWorker } from "./sol-price-bootstrap.js";
import type { SolPriceBootstrapStatus } from "./sol-price-bootstrap-state.js";
import { normalizeDataProviderProfile } from "./provider-profile.js";
import {
  RPC_READINESS_SETTING,
  activeRpcReadiness,
  createStoredRpcReadiness,
  dataProviderEndpointFingerprint,
  rpcProfileValidationHealth,
  type StoredDataProviderRpcReadiness
} from "./provider-rpc-readiness.js";
import {
  SELF_HOSTED_PAPER_SOAK_MAXIMUM_AGE_MS,
  calculateSelfHostedPaperSoakStatus,
  completeFreshIndexHeadCoverage,
  selfHostedEndpointFingerprint
} from "./self-hosted-paper-soak.js";
import {
  DEFAULT_ALLOWED_PROGRAMS,
  DpapiTransactionSigner,
  JUPITER_V6_PROGRAM_ID,
  PERMITTED_JUPITER_ROUTE_PROGRAMS
} from "./wallet.js";
import {
  MANAGED_DEEP_HISTORY_RESCUE_CREDIT_RESERVE,
  WalletIndexWorker
} from "./wallet-index-worker.js";
import { ParsedBlockRepairRepository } from "./parsed-block-repair-repository.js";
import { ParsedBlockRepairWorker } from "./parsed-block-repair-worker.js";
import { WalletAcquisitionController } from "./wallet-acquisition-controller.js";
import {
  ManagedRecoveryPreflightCoordinator,
  managedRecoveryPreflightWindow
} from "./managed-recovery-preflight.js";
import {
  buildWalletResearchShortlist,
  combineManagedProviderAndFrozenHistory,
  scoreWalletResearchCandidate
} from "./wallet-research.js";
import { reconcileWalletHistory } from "./wallet-history-reconciliation.js";
import { persistManagedWalletIdentity, verifiedLocalWalletTags } from "./wallet-identity.js";
import {
  inactiveOperationalPause,
  legacyOperationalPause,
  resolveOperationalPause
} from "./operational-pause.js";
import { collectOperationalTelemetry } from "./operational-telemetry.js";
import {
  ResearchPaperEngine,
  type ResearchPaperSourceAction
} from "./research-paper.js";
import { AutonomousPaperEngine } from "./autonomous-paper.js";
import { AutonomousLearningEngine } from "./autonomous-learning.js";
import { StockPaperEngine } from "./stock-paper.js";
import { StockPaperRepository } from "./stock-paper-repository.js";
import { MarketplaceMirrorCoordinator } from "./marketplace-mirror-coordinator.js";
import {
  AUTONOMOUS_PAPER_POLICY_VERSION,
  AUTONOMOUS_PAPER_V12_POLICY_VERSION
} from "./autonomous-paper-policy.js";
import {
  AutonomousLearningRepository,
  openLearningDatabase,
  type LearningDatabase
} from "./learning-database.js";
import {
  EMERGENCY_EXIT_RPC_STATUS_SETTING,
  activeEmergencyExitRpcStatus,
  emergencyExitRpcFresh,
  probeEmergencyExitRpc,
  type StoredEmergencyExitRpcStatus
} from "./emergency-exit-rpc.js";

const USDC_DECIMALS = 6;
const DISCOVERY_SHORTLIST = 100;
const LOCAL_INDEX_SHORTLIST = 50;
const PAPER_WALLET_COUNT = PAPER_EVALUATION_WALLET_COUNT;
const BIRDEYE_DISCOVERY_BASE_CU = 180;
const BIRDEYE_PNL_PAIR_CU = 60;
const BIRDEYE_MONTHLY_DISCOVERY_BUDGET_CU = DEFAULT_BIRDEYE_MONTHLY_CU_BUDGET;
const BIRDEYE_DISCOVERY_WORST_CASE_CU =
  BIRDEYE_DISCOVERY_BASE_CU + (DISCOVERY_SHORTLIST + PAPER_WALLET_COUNT) * BIRDEYE_PNL_PAIR_CU;
// A preflight PnL request costs 30 CU and may retry twice. Keep the complete
// final discovery/qualification envelope plus a small control-plane margin.
const BIRDEYE_PREFLIGHT_STEP_WORST_CASE_CU = 90;
const BIRDEYE_PREFLIGHT_FINAL_RESERVE_CU = BIRDEYE_DISCOVERY_WORST_CASE_CU + 10;
// Helius history may traverse 100 transaction pages, then identity and asset
// evidence. Preserve the final paper cohort plus operational headroom.
const HELIUS_PREFLIGHT_HISTORY_WORST_CASE_CREDITS = 10_110;
const HELIUS_PREFLIGHT_FINAL_RESERVE_CREDITS =
  PAPER_WALLET_COUNT * HELIUS_PREFLIGHT_HISTORY_WORST_CASE_CREDITS + 25_000;
const MANAGED_PREFLIGHT_CONCENTRATION_ALIGNMENT_SETTING =
  "managed_recovery_preflight_concentration_alignment_v1";
const MANAGED_PREFLIGHT_LEGACY_INCONCLUSIVE_ERROR =
  "Managed recovery preflight history is valid but inconclusive for this weekly window.";
const LIVE_WALLET_COUNT = 3;
const HEALTH_INTERVAL_MS = 5 * 60_000;
const POSITION_INTERVAL_MS = 60_000;
const PAPER_EVIDENCE_HEARTBEAT_INTERVAL_MS = 60_000;
const DISCOVERY_CHECK_INTERVAL_MS = 6 * 60 * 60_000;
const SOL_PRICE_CAPTURE_INTERVAL_MS = 5 * 60_000;
const RESEARCH_PAPER_MARK_INTERVAL_MS = 5 * 60_000;
const STOCK_PAPER_INTERVAL_MS = 60_000;
/** Poll policy buckets once a minute. The engine's persisted, policy-versioned
 * cycle key remains authoritative, so v1-v3 still run every five minutes while
 * v4 can run every three minutes without rebuilding the runtime timer. */
export const AUTONOMOUS_PAPER_SCHEDULER_POLL_INTERVAL_MS = 60_000;
/** Health checks stay on their own cadence; shortening the scheduler poll must
 * not turn the five-feed Jupiter diagnostic into a near-continuous workload. */
export const AUTONOMOUS_MARKET_HEALTH_CACHE_TTL_MS = 5 * 60_000;
const MONITORING_REPAIR_BASE_RETRY_MS = 30_000;
const MONITORING_REPAIR_MAXIMUM_RETRY_MS = 5 * 60_000;

function requireManagedCredentials(credentials: ProviderCredentials): {
  birdeyeApiKey: string;
  heliusApiKey: string;
} {
  const birdeyeApiKey = credentials.birdeyeApiKey?.trim();
  const heliusApiKey = credentials.heliusApiKey?.trim();
  if (!birdeyeApiKey || !heliusApiKey) {
    throw new Error("Birdeye and Helius credentials are required in MANAGED and SHADOW modes.");
  }
  return { birdeyeApiKey, heliusApiKey };
}
const STRESS_DELAY_MS = 5_000;
const MINIMUM_HELIUS_RESEARCH_CREDITS_PER_WALLET = 200;

class ProviderQualificationBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderQualificationBudgetError";
  }
}

interface Providers {
  discovery: HealthCheckedWalletDiscoveryProvider;
  chain: RuntimeChainProvider;
  /**
   * Research-only wallet stream. It is deliberately a different observer
   * instance so a large experimental watchlist cannot replace, reconnect, or
   * fail the strict trading-head subscription.
   */
  researchChain: RuntimeChainProvider;
  token: JupiterTokenRiskProvider;
  /** Read-only Tokens V2 feed for the isolated autonomous PAPER strategy. */
  market: JupiterMarketDataProvider;
  swap: JupiterSwapProvider;
  quotes: RateLimitedQuoteExecutor;
}

interface StressLot {
  ready: boolean;
  entryCostUsd: number;
  remainingAtomic: string;
  proceedsUsd: number;
  extraCostsUsd: number;
}

export interface TradingRuntimeOptions {
  /** Optional bearer key for the Pyth Benchmarks API; never persisted or returned in status. */
  pythBenchmarksApiKey?: string;
  /** Test/operator injection seam. Production defaults to the official Benchmarks client. */
  pythBenchmarksProvider?: PythBenchmarksPriceProvider;
  pythBenchmarksProviderFactory?: (apiKey: string | undefined) => PythBenchmarksPriceProvider;
  solPriceBootstrapWorker?: SolPriceBootstrapWorker;
  /** Production supplies data/learning.db. Tests default to an isolated
   * in-memory learner so no fixture can mutate the operator dataset. */
  learningDatabase?: LearningDatabase;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function atomicToUi(amount: string, decimals: number): number {
  const value = BigInt(amount);
  const divisor = 10n ** BigInt(decimals);
  const whole = value / divisor;
  const remainder = value % divisor;
  return Number(whole) + Number(remainder) / Number(divisor);
}

function safePercentShortfall(expected: string, actual: string | undefined): number | undefined {
  if (!actual) return undefined;
  const expectedAmount = BigInt(expected);
  const actualAmount = BigInt(actual);
  if (expectedAmount <= 0n) return undefined;
  return Math.max(0, Number(expectedAmount - actualAmount) / Number(expectedAmount) * 100);
}

function signedTransactionSignature(signedTransactionBase64: string): string {
  const transaction = VersionedTransaction.deserialize(Buffer.from(signedTransactionBase64, "base64"));
  const signature = transaction.signatures[0];
  if (!signature || signature.every((byte) => byte === 0)) {
    throw new Error("Signed transaction did not contain a deterministic Solana signature.");
  }
  return bs58.encode(signature);
}

function rejected(code: RiskDecision["code"], reason: string): RiskDecision {
  return {
    allowed: false,
    code,
    reasons: [reason],
    decidedAt: new Date().toISOString()
  };
}

function unknownToken(mint: string, reason: string): TokenEligibility {
  return {
    mint,
    checkedAt: new Date().toISOString(),
    eligible: false,
    reasons: [reason],
    verified: false,
    suspicious: true,
    mintAuthorityDisabled: false,
    freezeAuthorityDisabled: false,
    liquidityUsd: 0,
    volume24hUsd: 0,
    holderCount: 0,
    organicScore: 0,
    topHoldersPercent: 100
  };
}

class RateLimitedQuoteExecutor implements QuoteExecutor {
  private tail: Promise<void> = Promise.resolve();
  private lastStartedAt = 0;

  constructor(
    private readonly delegate: JupiterSwapProvider,
    private readonly minimumIntervalMs = 1_000
  ) {}

  quote(request: QuoteRequest): Promise<QuoteSnapshot> {
    const run = this.tail.then(async () => {
      const wait = this.minimumIntervalMs - (Date.now() - this.lastStartedAt);
      if (wait > 0) await sleep(wait);
      this.lastStartedAt = Date.now();
      return this.delegate.quote(request);
    });
    this.tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  execute(signedTransactionBase64: string, requestId: string) {
    return this.delegate.execute(signedTransactionBase64, requestId);
  }
}

const PROVIDER_QUIESCE_TIMEOUT_MS = 30_000;
// Node clamps delays above a signed 32-bit millisecond value to 1 ms. Durable
// provider-budget retries can be almost a month away, so wake at most daily,
// re-read the durable deadline, and never turn a monthly retry into a hot loop.
const MAX_RESEARCH_HANDOFF_RETRY_TIMER_DELAY_MS = 24 * 60 * 60_000;
const JUPITER_GENERAL_REQUESTS_PER_SECOND = 0.8;
const JUPITER_REQUEST_TIMEOUT_MS = 30_000;
const JUPITER_MAXIMUM_429_RETRIES = 1;
const BIRDEYE_ACCOUNT_REQUESTS_PER_SECOND = 0.8;

class ProviderWorkSupersededError extends Error {
  constructor() {
    super("Provider-owned work was superseded by a credential or profile transition.");
    this.name = "ProviderWorkSupersededError";
  }
}

class ProviderQuiesceTimeoutError extends Error {
  constructor() {
    super("Provider work did not quiesce within 30 seconds.");
    this.name = "ProviderQuiesceTimeoutError";
  }
}

async function boundedProviderDrain(promise: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ProviderQuiesceTimeoutError()), PROVIDER_QUIESCE_TIMEOUT_MS);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class TradingRuntime implements RuntimeController {
  private providers?: Providers;
  private balanceReader?: BalanceReader;
  private executionRpc?: {
    getTransaction(signature: string): Promise<unknown | null>;
  };
  private emergencyExecutionRpc: {
    getTransaction(signature: string): Promise<unknown | null>;
  } | undefined;
  private liveBroker?: LiveBrokerOrchestrator;
  private walletIndexer?: WalletIndexWorker;
  private parsedBlockRepairRepository?: ParsedBlockRepairRepository;
  private parsedBlockRepairWorker?: ParsedBlockRepairWorker;
  private walletAcquisition: WalletAcquisitionController | undefined;
  private managedRecoveryPreflight: ManagedRecoveryPreflightCoordinator | undefined;
  private unsubscribe: (() => Promise<void> | void) | undefined;
  private researchUnsubscribe: (() => Promise<void> | void) | undefined;
  private healthTimer?: ReturnType<typeof setInterval>;
  private positionTimer?: ReturnType<typeof setInterval>;
  private discoveryTimer?: ReturnType<typeof setInterval>;
  private paperEvidenceTimer?: ReturnType<typeof setInterval>;
  private solPriceTimer?: ReturnType<typeof setInterval>;
  private researchPaperTimer?: ReturnType<typeof setInterval>;
  private autonomousPaperTimer?: ReturnType<typeof setInterval>;
  private stockPaperTimer?: ReturnType<typeof setInterval>;
  private rpcReadinessRefresh: { endpointFingerprint: string; promise: Promise<void> } | undefined;
  private monitoringRepairRetryTimer: ReturnType<typeof setTimeout> | undefined;
  private researchMonitoringRetryTimer: ReturnType<typeof setTimeout> | undefined;
  private researchHandoffRetryTimer: ReturnType<typeof setTimeout> | undefined;
  private signalTail: Promise<void> = Promise.resolve();
  private monitoringSubscriptionTail: Promise<void> = Promise.resolve();
  private researchSubscriptionTail: Promise<void> = Promise.resolve();
  private readonly ordersByKey = new Map<string, BrokerOrder>();
  private readonly executionKeys = new Map<string, string>();
  private readonly exitLocks = new Set<string>();
  private readonly tokenCache = new Map<string, { token: TokenEligibility; at: number }>();
  private readonly solPriceOracle: LocalSolPriceOracle;
  private readonly researchPaper: ResearchPaperEngine;
  private readonly autonomousPaper: AutonomousPaperEngine;
  private readonly autonomousLearning: AutonomousLearningEngine;
  private readonly stockPaper: StockPaperEngine;
  private readonly marketplaceMirror: MarketplaceMirrorCoordinator;
  private readonly learningDatabase: LearningDatabase;
  private readonly ownsLearningDatabase: boolean;
  private solPriceBootstrap: SolPriceBootstrapWorker;
  private readonly pythBenchmarksApiKeyFallback: string | undefined;
  private readonly pythBenchmarksProviderOverride: PythBenchmarksPriceProvider | undefined;
  private readonly pythBenchmarksProviderFactory:
    ((apiKey: string | undefined) => PythBenchmarksPriceProvider) | undefined;
  private readonly solPriceBootstrapWorkerOverride: SolPriceBootstrapWorker | undefined;
  private solPriceCache?: { price: number; at: number };
  private lastResearchQuoteAt = 0;
  private emergencyActive = false;
  private stopping = false;
  private stopPromise: Promise<void> | undefined;
  private discoveryRunning = false;
  private researchHandoffRunning = false;
  private managedRecoveryPreflightRunning = false;
  private positionCheckRunning = false;
  private providerWorkGeneration = 0;
  private providerWorkQuiesced = false;
  private providerDrain: Promise<void> | undefined;
  private providerDiscoveryRequired = false;
  private readonly providerWorkTasks = new Set<Promise<unknown>>();
  private readonly backgroundWriteTasks = new Set<Promise<unknown>>();
  private readonly researchMonitoringWallets = new Set<string>();
  private autonomousMarketTail: Promise<void> = Promise.resolve();
  private lastAutonomousMarketHealth: ProviderHealth | undefined;
  /**
   * Jupiter's general free-tier allowance is account-wide, so every token,
   * market, health, and quote client owned by this runtime shares this physical
   * request-start queue. The 0.8 RPS pace leaves boundary headroom below the
   * one-request-per-second ceiling. Only GET 429 responses receive the bounded
   * retry. POST /execute uses Jupiter's independent execute bucket and remains
   * immediate and single-attempt inside createPacedFetch.
   */
  private readonly jupiterFetch: FetchLike;
  /** One account-wide start queue shared by discovery, health, and history. */
  private readonly birdeyeFetch: FetchLike;

  constructor(
    private readonly repository: Repository,
    private readonly vault: SecretVault,
    private readonly modes: ModeManager,
    private readonly events: EventBus,
    private readonly signer: DpapiTransactionSigner,
    options: TradingRuntimeOptions = {}
  ) {
    this.jupiterFetch = createPacedFetch({
      requestsPerSecond: JUPITER_GENERAL_REQUESTS_PER_SECOND,
      max429Retries: JUPITER_MAXIMUM_429_RETRIES,
      retryBaseMs: 1_500,
      maximumRetryDelayMs: 8_000,
      unpacedMethods: ["POST"],
      onRequest: () => this.repository.incrementUsage("jupiter")
    });
    this.birdeyeFetch = createPacedFetch({
      requestsPerSecond: BIRDEYE_ACCOUNT_REQUESTS_PER_SECOND
    });
    this.solPriceOracle = new LocalSolPriceOracle(repository);
    this.marketplaceMirror = new MarketplaceMirrorCoordinator(repository.db, {
      onError: (stage, error, details) => this.recordError(stage, error, details),
      onChanged: (change) => this.events.publish("marketplace", change)
    });
    this.researchPaper = new ResearchPaperEngine(repository, {
      mode: () => this.modes.mode,
      quote: (request) => this.quoteResearchPaper(request),
      checkToken: (mint) => this.requireProviders().token.checkToken(mint),
      readLeaderMintBalance: async (wallet, mint) => {
        if (!this.balanceReader) {
          throw new Error("Research leader-balance reconciliation is not configured.");
        }
        return this.balanceReader.readMint(wallet, mint);
      },
      solPriceUsd: () =>
        this.solPriceCache?.price ?? this.repository.getSetting<number>("last_sol_price_usd") ?? 0,
      onUpdate: (data) => {
        this.events.publish("research-paper", data);
        this.marketplaceMirror.afterPerformanceUpdate("research_paper");
      },
      onError: (error) => this.recordError("research_paper", error)
    });
    this.learningDatabase = options.learningDatabase ?? openLearningDatabase(":memory:");
    this.ownsLearningDatabase = options.learningDatabase === undefined;
    this.autonomousLearning = new AutonomousLearningEngine(
      repository,
      new AutonomousLearningRepository(this.learningDatabase),
      {
        quote: (request) => this.quoteResearchPaper(request),
        lookupMints: (mints) => this.lookupAutonomousMints(mints),
        solPriceUsd: () =>
          this.solPriceCache?.price ?? this.repository.getSetting<number>("last_sol_price_usd") ?? 0,
        walletConfirmed: (mint, capturedAt) =>
          this.repository.hasRecentWalletConfirmedMint(mint, capturedAt),
        onUpdate: (data) => this.events.publish("autonomous-learning", data),
        onError: (error) => this.recordError("autonomous_learning", error)
      }
    );
    this.autonomousPaper = new AutonomousPaperEngine(repository, {
      mode: () => this.modes.mode,
      newEntriesAllowed: () => !this.operationalPauseState().active,
      fetchSignalUniverse: () => this.fetchAutonomousSignalUniverse(),
      lookupMints: (mints) => this.lookupAutonomousMints(mints),
      quote: (request) => this.quoteResearchPaper(request),
      solPriceUsd: () =>
        this.solPriceCache?.price ?? this.repository.getSetting<number>("last_sol_price_usd") ?? 0,
      onUniverse: (input) => {
        this.autonomousLearning.ingestUniverse(input);
        this.queueAutonomousLearningCycle();
      },
      learningStrategy: (token, capturedAt, lane) =>
        this.autonomousLearning.candidateStrategy(
          token,
          capturedAt,
          lane.policyVersion === AUTONOMOUS_PAPER_POLICY_VERSION ||
            lane.policyVersion === AUTONOMOUS_PAPER_V12_POLICY_VERSION
        ),
      onUpdate: (data) => {
        this.events.publish("autonomous-paper", data);
        this.marketplaceMirror.afterPerformanceUpdate("autonomous_paper");
      },
      onError: (error) => this.recordError("autonomous_paper", error)
    });
    this.stockPaper = new StockPaperEngine(
      new StockPaperRepository(repository.db),
      {
        mode: () => this.modes.mode,
        credentials: () => this.alpacaCredentials(),
        provider: (credentials) => new AlpacaPaperProvider(credentials, { timeoutMs: 20_000 }),
        streaming: true,
        onProviderRequest: () => this.repository.incrementUsage("alpaca_iex"),
        onUpdate: (data) => {
          this.events.publish("stock-paper", data);
          if (data.outcome === "CYCLE_COMPLETED" && typeof data.laneId === "string") {
            this.marketplaceMirror.afterStockCycle(data.laneId);
          }
        },
        onError: (error) => this.recordError("stock_paper", error)
      }
    );
    this.pythBenchmarksApiKeyFallback = options.pythBenchmarksApiKey?.trim() || undefined;
    this.pythBenchmarksProviderOverride = options.pythBenchmarksProvider;
    this.pythBenchmarksProviderFactory = options.pythBenchmarksProviderFactory;
    this.solPriceBootstrapWorkerOverride = options.solPriceBootstrapWorker;
    this.solPriceBootstrap = options.solPriceBootstrapWorker ?? this.createSolPriceBootstrapWorker();
  }

  async start(): Promise<void> {
    // Invalidate any stale persisted promotion decision before recovery,
    // provider I/O, subscriptions, or execution replay can proceed.
    this.updatePromotionGate();
    const resumeEmergency = this.restoreEmergencyLock();
    if (!resumeEmergency && (this.modes.mode === "MANUAL_LIVE" || this.modes.mode === "AUTO_LIVE")) {
      const prior = this.modes.mode;
      this.modes.transition("PAUSED");
      this.repository.audit(
        "live_restart_paused",
        "A persisted live mode was forced to PAUSED during startup; explicit resume must repeat every live preflight.",
        { prior },
        "warning"
      );
      this.events.publish("mode", { mode: "PAUSED", pausedFrom: prior });
    }
    this.expireRestartedApprovals();
    const recoveredResearch = this.repository.recoverRunningWalletResearchHandoffs();
    if (recoveredResearch > 0) {
      this.repository.audit(
        "wallet_research_handoff_recovered",
        "Interrupted provider qualification was returned to its durable retry queue.",
        { recovered: recoveredResearch },
        "warning"
      );
    }
    const recoveredPreflights = this.repository.recoverManagedRecoveryPreflightRuns({
      now: new Date().toISOString()
    });
    if (recoveredPreflights > 0) {
      this.repository.audit(
        "managed_recovery_preflight_recovered",
        "Expired managed-recovery provider leases were returned to their durable retry queue.",
        { recovered: recoveredPreflights },
        "warning"
      );
    }
    const preflightWindow = managedRecoveryPreflightWindow(new Date());
    const alignmentSetting =
      `${MANAGED_PREFLIGHT_CONCENTRATION_ALIGNMENT_SETTING}:${preflightWindow.windowStart}`;
    if (this.repository.getSetting<boolean>(alignmentSetting) !== true) {
      const requeued = this.repository.requeueManagedRecoveryPreflightHistoryRetries({
        policyVersion: preflightWindow.policyVersion,
        windowStart: preflightWindow.windowStart,
        now: new Date().toISOString(),
        expectedLastError: MANAGED_PREFLIGHT_LEGACY_INCONCLUSIVE_ERROR,
        reason: "Requeued after aligning zero concentration with the unchanged final qualification thresholds."
      });
      this.repository.setSetting(alignmentSetting, true);
      if (requeued > 0) {
        this.repository.audit(
          "managed_recovery_preflight_policy_aligned",
          "Positive-PnL history preflights were requeued after their admission rule was aligned with final qualification.",
          {
            policyVersion: preflightWindow.policyVersion,
            windowStart: preflightWindow.windowStart,
            requeued
          },
          "warning"
        );
      }
    }
    if (this.vault.hasCredentials()) {
      await this.configureProviders();
      await this.refreshActiveRpcReadiness();
      await this.refreshHealth(true);
      await this.getSolPriceUsd().catch((error) => this.recordError("sol_price_capture", error));
      await this.reconcileEmergencySubmissions();
      await this.replayConfirmedApplications();
      await this.reconcileLiveBalances(false);
      if (resumeEmergency) {
        await this.emergencyExit().catch((error) => this.recordError("emergency_recovery", error));
      }
      await this.replayUnprocessedSources();
      const recoveredResearchClaims = this.researchPaper.recoverInterruptedClaims();
      const importedResearchSignals = this.researchPaper.backfillRejectedVisibility();
      if (recoveredResearchClaims > 0 || importedResearchSignals > 0) {
        this.repository.audit(
          "research_paper_recovered",
          "The isolated high-risk PAPER ledger recovered safely at startup.",
          { recoveredResearchClaims, importedResearchSignals }
        );
      }
      const recoveredAutonomousClaims = this.autonomousPaper.recoverInterruptedClaims();
      if (recoveredAutonomousClaims > 0) {
        this.repository.audit(
          "autonomous_paper_recovered",
          "The isolated autonomous PAPER ledger recovered interrupted claims safely at startup.",
          { recoveredAutonomousClaims }
        );
      }
      if (this.modes.mode !== "SETUP") {
        this.ensureForwardPaperEvaluationFromCurrentCohort();
        this.walletIndexer?.start();
        this.startParsedBlockRepairIfPending();
        await this.subscribeActiveWallets();
        void this.subscribeResearchWallets().catch((error) =>
          this.recordProviderWorkError("research_monitoring_subscribe", error)
        );
        // Reconcile any research-only inventory that changed while CopyLab was
        // stopped before waiting for the next periodic five-minute mark.
        this.queueResearchPaperMarks(`startup:${randomUUID()}`);
        this.queueAutonomousPaperCycle();
        this.queueAutonomousLearningCycle();
        void this.refreshDiscoveryIfDue().catch((error) => this.recordProviderWorkError("discovery_start", error));
        this.scheduleResearchHandoffRetry();
      }
    }
    // Destination fills are derived only from already committed source rows.
    // Running this even without configured providers safely repairs a crash
    // between the source commit and its isolated marketplace replay.
    await this.marketplaceMirror.reconcileStartup();
    this.healthTimer = setInterval(() => {
      this.runBackgroundWriteTask("health_refresh", this.refreshHealthCycle(false));
    }, HEALTH_INTERVAL_MS);
    this.positionTimer = setInterval(() => {
      this.runBackgroundWriteTask("position_monitor", this.monitorPositions());
    }, POSITION_INTERVAL_MS);
    this.discoveryTimer = setInterval(() => {
      void this.refreshDiscoveryIfDue().catch((error) => this.recordProviderWorkError("discovery_schedule", error));
    }, DISCOVERY_CHECK_INTERVAL_MS);
    this.recordPaperEvidenceHeartbeat();
    this.updatePromotionGate();
    this.paperEvidenceTimer = setInterval(() => {
      this.recordPaperEvidenceHeartbeat();
      this.updatePromotionGate();
    }, PAPER_EVIDENCE_HEARTBEAT_INTERVAL_MS);
    this.solPriceTimer = setInterval(() => {
      if (!this.providers) return;
      this.runBackgroundWriteTask("sol_price_capture", this.getSolPriceUsd());
    }, SOL_PRICE_CAPTURE_INTERVAL_MS);
    this.researchPaperTimer = setInterval(() => {
      this.queueResearchPaperMarks();
    }, RESEARCH_PAPER_MARK_INTERVAL_MS);
    this.autonomousPaperTimer = setInterval(() => {
      this.queueAutonomousPaperCycle();
      this.queueAutonomousLearningCycle();
    }, AUTONOMOUS_PAPER_SCHEDULER_POLL_INTERVAL_MS);
    this.stockPaperTimer = setInterval(() => {
      this.queueStockPaperCycle();
    }, STOCK_PAPER_INTERVAL_MS);
    this.queueStockPaperCycle();
    if (this.modes.mode === "SETUP" || this.modes.mode === "PAPER") {
      this.solPriceBootstrap.resumePersistedActive();
    }
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.performStop();
    return this.stopPromise;
  }

  private async performStop(): Promise<void> {
    this.stopping = true;
    this.providerWorkQuiesced = true;
    this.providerWorkGeneration += 1;
    this.researchMonitoringWallets.clear();
    if (this.healthTimer) clearInterval(this.healthTimer);
    if (this.positionTimer) clearInterval(this.positionTimer);
    if (this.discoveryTimer) clearInterval(this.discoveryTimer);
    if (this.paperEvidenceTimer) clearInterval(this.paperEvidenceTimer);
    if (this.solPriceTimer) clearInterval(this.solPriceTimer);
    if (this.researchPaperTimer) clearInterval(this.researchPaperTimer);
    if (this.autonomousPaperTimer) clearInterval(this.autonomousPaperTimer);
    if (this.stockPaperTimer) clearInterval(this.stockPaperTimer);
    if (this.monitoringRepairRetryTimer) clearTimeout(this.monitoringRepairRetryTimer);
    this.monitoringRepairRetryTimer = undefined;
    if (this.researchMonitoringRetryTimer) clearTimeout(this.researchMonitoringRetryTimer);
    this.researchMonitoringRetryTimer = undefined;
    if (this.researchHandoffRetryTimer) clearTimeout(this.researchHandoffRetryTimer);
    this.researchHandoffRetryTimer = undefined;

    const cleanupFailures: Array<{ stage: string; error: string }> = [];
    const settle = async (stage: string, operation: () => Promise<unknown> | unknown): Promise<void> => {
      try {
        await operation();
      } catch (error) {
        cleanupFailures.push({ stage, error: this.errorText(error) });
      }
    };

    // Stop producers first. Every stage is isolated so one broken provider
    // cleanup cannot skip the signal tail that owns durable decision,
    // execution, position, and source-processed writes.
    await settle("rpc_readiness", () => this.rpcReadinessRefresh?.promise);
    await settle("sol_price_bootstrap", () => this.solPriceBootstrap.stopPreservingAuthorization());
    await settle("wallet_indexer", () => this.walletIndexer?.stop());
    await settle("parsed_block_repair", () => this.parsedBlockRepairWorker?.stop());
    await settle("monitoring_subscription", () => this.monitoringSubscriptionTail);
    const unsubscribe = this.unsubscribe;
    this.unsubscribe = undefined;
    await settle("monitoring_unsubscribe", () => unsubscribe?.());
    await settle("research_monitoring_subscription", () => this.researchSubscriptionTail);
    const researchUnsubscribe = this.researchUnsubscribe;
    this.researchUnsubscribe = undefined;
    await settle("research_monitoring_unsubscribe", () => researchUnsubscribe?.());

    // Do not await providerDrain as a monolith here: a previously timed-out
    // indexer stop can keep that composite promise pending forever. Its
    // durable components are drained explicitly below (provider tasks,
    // monitoring subscription, unsubscribe, and signal execution).
    const providerTasks = [...this.providerWorkTasks];
    if (providerTasks.length > 0) {
      await settle("provider_work", async () => {
        const results = await Promise.allSettled(providerTasks);
        // stop() intentionally advances the provider generation before this
        // drain. Work that notices that generation change rejects with this
        // sentinel; it is proof the stale task stopped safely, not a cleanup
        // failure. Genuine provider errors remain critical.
        const rejected = results.find((result): result is PromiseRejectedResult =>
          result.status === "rejected" && !(result.reason instanceof ProviderWorkSupersededError)
        );
        if (rejected) throw rejected.reason;
      });
    }
    const backgroundWriteTasks = [...this.backgroundWriteTasks];
    if (backgroundWriteTasks.length > 0) {
      await settle("background_writes", async () => {
        const results = await Promise.allSettled(backgroundWriteTasks);
        const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
        if (rejected) throw rejected.reason;
      });
    }

    // This must remain the last runtime-owned drain. The loopback server does
    // not close SQLite until stop() resolves, so all in-flight signal writes
    // have completed even when an earlier cleanup stage failed.
    await settle("signal_execution", () => this.signalTail);
    await settle("research_paper", () => this.researchPaper.drain());
    await settle("autonomous_paper", () => this.autonomousPaper.drain());
    await settle("autonomous_learning", () => this.autonomousLearning.drain());
    await settle("autonomous_market", () => this.autonomousMarketTail);
    await settle("stock_paper_stream", () => this.stockPaper.stop());
    await settle("stock_paper", () => this.stockPaper.drain());
    await settle("marketplace_mirror", () => this.marketplaceMirror.drain());

    if (this.ownsLearningDatabase) {
      await settle("learning_database", () => this.learningDatabase.close());
    }

    if (cleanupFailures.length > 0) {
      this.repository.audit(
        "runtime_stop_cleanup_failed",
        "Runtime shutdown completed its durable drains, but one or more cleanup stages failed.",
        { failures: cleanupFailures },
        "critical"
      );
    }
  }

  async validateCredentials(credentials: ProviderCredentials): Promise<ProviderHealth[]> {
    const token = new JupiterTokenRiskProvider(credentials.jupiterApiKey, {
      fetch: this.jupiterFetch,
      timeoutMs: JUPITER_REQUEST_TIMEOUT_MS
    });
    const swap = new JupiterSwapProvider(credentials.jupiterApiKey, {
      fetch: this.jupiterFetch,
      timeoutMs: JUPITER_REQUEST_TIMEOUT_MS
    });
    const market = new JupiterMarketDataProvider(credentials.jupiterApiKey, {
      fetch: this.jupiterFetch,
      timeoutMs: JUPITER_REQUEST_TIMEOUT_MS
    });
    const [tokenHealth, swapHealth, marketHealth] = await Promise.all([
      token.checkHealth(),
      swap.checkHealth(),
      market.checkHealth()
    ]);
    const jupiter: ProviderHealth = {
      provider: "jupiter",
      ok: tokenHealth.ok && swapHealth.ok && marketHealth.ok,
      checkedAt: new Date().toISOString(),
      latencyMs: Math.max(
        tokenHealth.latencyMs ?? 0,
        swapHealth.latencyMs ?? 0,
        marketHealth.latencyMs ?? 0
      ),
      message: tokenHealth.ok && swapHealth.ok && marketHealth.ok
        ? "Jupiter Tokens, market categories, and Swap v2 are reachable and authenticated"
        : `${tokenHealth.message}; ${marketHealth.message}; ${swapHealth.message}`
    };
    const health: ProviderHealth[] = [];
    if (this.vault.getDataProviderProfile().mode !== "SELF_HOSTED") {
      const managed = requireManagedCredentials(credentials);
      const [birdeyeHealth, heliusHealth] = await Promise.all([
        this.createBirdeyeProvider(managed.birdeyeApiKey).checkHealth(),
        new HeliusObserver(managed.heliusApiKey).checkHealth()
      ]);
      health.push(birdeyeHealth, heliusHealth);
    }
    health.push(jupiter);
    const pythBenchmarksApiKey = credentials.pythBenchmarksApiKey?.trim();
    if (pythBenchmarksApiKey) {
      health.push(await this.validatePythBenchmarksApiKey(pythBenchmarksApiKey));
    }
    return health;
  }

  async validateDataProviderProfile(input: DataProviderProfile): Promise<ProviderHealth> {
    const profile = normalizeDataProviderProfile(input);
    if (profile.mode === "MANAGED") {
      const credentials = this.vault.getCredentials();
      if (!credentials) throw new Error("Managed provider credentials are unavailable.");
      const managed = requireManagedCredentials(credentials);
      const [birdeye, helius] = await Promise.all([
        this.createBirdeyeProvider(managed.birdeyeApiKey).checkHealth(),
        new HeliusObserver(managed.heliusApiKey).checkHealth()
      ]);
      return {
        provider: "helius",
        ok: birdeye.ok && helius.ok,
        checkedAt: new Date().toISOString(),
        latencyMs: Math.max(birdeye.latencyMs ?? 0, helius.latencyMs ?? 0),
        message: birdeye.ok && helius.ok
          ? "Managed Birdeye and Helius data providers are healthy"
          : `${birdeye.message}; ${helius.message}`
      };
    }
    if (!profile.solanaHttpUrl || !profile.solanaWsUrl) {
      throw new Error("Self-hosted provider endpoints are not configured.");
    }
    const onRequest = (): void => this.repository.incrementUsage("solana_rpc");
    const rpc = new StandardSolanaRpcClient({
      httpUrl: profile.solanaHttpUrl,
      timeoutMs: 8_000,
      requestsPerSecond: 20,
      maximumRetries: 0,
      onRequest
    });
    const observer = new StandardSolanaObserver({
      httpUrl: profile.solanaHttpUrl,
      wsUrl: profile.solanaWsUrl,
      timeoutMs: 8_000,
      maximumRetries: 0
    });
    const [diagnostic, websocket] = await Promise.all([
      diagnoseStandardSolanaRpcReadiness(rpc),
      observer.checkWebSocketHealth(5_000)
    ]);
    const readiness = createStoredRpcReadiness(profile, diagnostic, websocket);
    this.repository.setSetting(RPC_READINESS_SETTING, readiness);
    const primaryHealth = rpcProfileValidationHealth(profile.mode, readiness);
    if (!profile.emergencySolanaHttpUrl) {
      this.repository.setSetting(EMERGENCY_EXIT_RPC_STATUS_SETTING, null);
      return primaryHealth;
    }
    const emergency = await probeEmergencyExitRpc(
      profile.emergencySolanaHttpUrl,
      () => this.repository.incrementUsage("solana_rpc")
    );
    this.repository.setSetting(EMERGENCY_EXIT_RPC_STATUS_SETTING, emergency);
    return {
      ...primaryHealth,
      ok: primaryHealth.ok && emergency.ok,
      message: primaryHealth.ok && emergency.ok
        ? `${primaryHealth.message}; independent emergency-exit RPC checks passed`
        : `${primaryHealth.message}; ${emergency.message}`
    };
  }

  async quiesceProviderWork(): Promise<void> {
    if (this.stopping) throw new Error("The runtime is stopping and cannot change providers.");
    if (this.providerWorkQuiesced) {
      // A later transition attempt takes ownership of a timed-out drain. The
      // generation bump prevents the prior attempt's deferred recovery from
      // resuming provider work underneath this caller.
      this.providerWorkGeneration += 1;
      if (this.providerDrain) await boundedProviderDrain(this.providerDrain);
      return;
    }

    this.providerWorkQuiesced = true;
    const generation = ++this.providerWorkGeneration;
    this.researchMonitoringWallets.clear();
    this.providerDiscoveryRequired = true;
    if (this.monitoringRepairRetryTimer) clearTimeout(this.monitoringRepairRetryTimer);
    this.monitoringRepairRetryTimer = undefined;
    if (this.researchMonitoringRetryTimer) clearTimeout(this.researchMonitoringRetryTimer);
    this.researchMonitoringRetryTimer = undefined;
    if (this.researchHandoffRetryTimer) clearTimeout(this.researchHandoffRetryTimer);
    this.researchHandoffRetryTimer = undefined;
    this.repository.recoverRunningWalletResearchHandoffs();

    const indexer = this.walletIndexer;
    const parsedBlockRepair = this.parsedBlockRepairWorker;
    const inFlightProviderTasks = [...this.providerWorkTasks];
    const drain = (async (): Promise<void> => {
      await Promise.all([
        indexer?.stop(),
        parsedBlockRepair?.stop(),
        ...inFlightProviderTasks.map((task) => task.then(
          () => undefined,
          () => undefined
        ))
      ]);
      await this.monitoringSubscriptionTail;
      const unsubscribe = this.unsubscribe;
      this.unsubscribe = undefined;
      await unsubscribe?.();
      await this.researchSubscriptionTail;
      const researchUnsubscribe = this.researchUnsubscribe;
      this.researchUnsubscribe = undefined;
      await researchUnsubscribe?.();
      await this.signalTail.catch(() => undefined);
      await this.researchPaper.drain().catch(() => undefined);
      await this.autonomousPaper.drain().catch(() => undefined);
      await this.autonomousMarketTail.catch(() => undefined);
    })();
    this.providerDrain = drain;

    try {
      await boundedProviderDrain(drain);
      if (this.providerDrain === drain) this.providerDrain = undefined;
    } catch (error) {
      if (error instanceof ProviderQuiesceTimeoutError) {
        // The vault is still unchanged because AppService waits for this
        // method before committing. Resume that same provider composition
        // only after the real drain completes, unless another transition or
        // shutdown has superseded this recovery generation.
        void drain.then(async () => {
          if (this.providerDrain === drain) this.providerDrain = undefined;
          if (
            !this.stopping &&
            this.providerWorkQuiesced &&
            this.providerWorkGeneration === generation
          ) {
            await this.resumeProviderWork();
          }
        }).catch((drainError) => {
          this.recordError("provider_quiesce_recovery", drainError);
        });
      }
      throw error;
    }
  }

  async resumeProviderWork(): Promise<void> {
    if (this.stopping) throw new Error("The runtime is stopping and cannot resume providers.");
    if (this.providerDrain) await boundedProviderDrain(this.providerDrain);
    if (!this.providerWorkQuiesced) return;

    const generation = this.providerWorkGeneration;
    if (this.modes.mode !== "SETUP") {
      this.walletIndexer?.start();
      this.startParsedBlockRepairIfPending();
    }
    this.providerWorkQuiesced = false;
    this.scheduleProviderWork(generation);
  }

  async credentialsChanged(): Promise<void> {
    await this.recreateSolPriceBootstrapClient();
    await this.configureProviders();
    await this.refreshActiveRpcReadiness();
    await this.refreshHealth(true);
    if (!this.providerWorkQuiesced) this.activateProviderWork(this.providerWorkGeneration);
  }

  async dataProviderProfileChanged(): Promise<void> {
    await this.configureProviders();
    await this.refreshActiveRpcReadiness();
    await this.refreshHealth(true);
    if (!this.providerWorkQuiesced) this.activateProviderWork(this.providerWorkGeneration);
  }

  private activateProviderWork(generation: number): void {
    if (!this.isProviderWorkCurrent(generation) || this.modes.mode === "SETUP") return;
    this.walletIndexer?.start();
    this.startParsedBlockRepairIfPending();
    this.scheduleProviderWork(generation);
  }

  private startParsedBlockRepairIfPending(): void {
    if (this.parsedBlockRepairRepository?.activeManifest()) {
      this.parsedBlockRepairWorker?.start();
    }
  }

  private scheduleProviderWork(generation: number): void {
    if (this.modes.mode === "SETUP") return;
    queueMicrotask(() => {
      if (!this.isProviderWorkCurrent(generation)) return;
      void this.subscribeActiveWallets(generation).catch((error) =>
        this.recordProviderWorkError("monitoring_subscribe", error)
      );
      void this.subscribeResearchWallets(generation).catch((error) =>
        this.recordProviderWorkError("research_monitoring_subscribe", error)
      );
      void this.refreshDiscoveryIfDue(generation).catch((error) =>
        this.recordProviderWorkError("discovery_start", error)
      );
      this.queueAutonomousPaperCycle();
      this.scheduleResearchHandoffRetry(generation);
    });
  }

  private isProviderWorkCurrent(generation: number): boolean {
    return !this.stopping && !this.providerWorkQuiesced && generation === this.providerWorkGeneration;
  }

  private assertProviderWorkCurrent(generation: number): void {
    if (!this.isProviderWorkCurrent(generation)) throw new ProviderWorkSupersededError();
  }

  private recordProviderWorkError(operation: string, error: unknown): void {
    if (error instanceof ProviderWorkSupersededError) return;
    this.recordError(operation, error);
  }

  private trackProviderWork<T>(task: Promise<T>): Promise<T> {
    this.providerWorkTasks.add(task);
    void task.then(
      () => this.providerWorkTasks.delete(task),
      () => this.providerWorkTasks.delete(task)
    );
    return task;
  }

  private runBackgroundWriteTask(operation: string, task: Promise<unknown>): void {
    this.backgroundWriteTasks.add(task);
    void task.then(
      () => this.backgroundWriteTasks.delete(task),
      (error) => {
        this.backgroundWriteTasks.delete(task);
        this.recordError(operation, error);
      }
    );
  }

  /**
   * Research quotes use their own low-priority pace and wait for the strict
   * signal queue before each request. Jupiter may serve the quote through
   * /order without a taker, but this path cannot request a transaction, sign,
   * or call /execute, and it cannot hold up a time-sensitive strict signal in
   * application code.
   */
  private async quoteResearchPaper(request: QuoteRequest): Promise<QuoteSnapshot> {
    const generation = this.providerWorkGeneration;
    await this.signalTail.catch(() => undefined);
    this.assertProviderWorkCurrent(generation);
    if (this.modes.mode !== "PAPER") throw new Error("Research quotes require exact PAPER mode.");
    const wait = 1_000 - (Date.now() - this.lastResearchQuoteAt);
    if (wait > 0) await sleep(wait);
    this.assertProviderWorkCurrent(generation);
    if (this.modes.mode !== "PAPER") throw new Error("Research quotes require exact PAPER mode.");
    this.lastResearchQuoteAt = Date.now();
    const quote = await this.requireProviders().swap.quote(request);
    this.assertProviderWorkCurrent(generation);
    return quote;
  }

  private async fetchAutonomousSignalUniverse() {
    const generation = this.providerWorkGeneration;
    await this.signalTail.catch(() => undefined);
    this.assertProviderWorkCurrent(generation);
    if (this.modes.mode !== "PAPER" || !this.repository.activeAutonomousPaperLane()) {
      throw new Error("Autonomous market discovery requires an active exact-PAPER lane.");
    }
    const startedAt = Date.now();
    try {
      const universe = await this.runAutonomousMarketTask(
        () => this.requireProviders().market.fetchSignalUniverse(100)
      );
      this.assertProviderWorkCurrent(generation);
      this.lastAutonomousMarketHealth = {
        provider: "jupiter",
        ok: true,
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - startedAt,
        message: "Jupiter autonomous market categories passed a recent live scan"
      };
      return universe;
    } catch (error) {
      this.lastAutonomousMarketHealth = {
        provider: "jupiter",
        ok: false,
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - startedAt,
        message: "Jupiter autonomous market category scan failed safely"
      };
      throw error;
    }
  }

  private async lookupAutonomousMints(mints: readonly string[]) {
    const generation = this.providerWorkGeneration;
    await this.signalTail.catch(() => undefined);
    this.assertProviderWorkCurrent(generation);
    if (this.modes.mode !== "PAPER" || !this.repository.activeAutonomousPaperLane()) {
      throw new Error("Autonomous market lookup requires an active exact-PAPER lane.");
    }
    const tokens = await this.runAutonomousMarketTask(
      () => this.requireProviders().market.lookupMints(mints)
    );
    this.assertProviderWorkCurrent(generation);
    return tokens;
  }

  private runAutonomousMarketTask<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.autonomousMarketTail.then(operation);
    this.autonomousMarketTail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async checkAutonomousMarketHealth(): Promise<ProviderHealth> {
    const cached = this.lastAutonomousMarketHealth;
    if (
      cached &&
      Date.now() - Date.parse(cached.checkedAt) <= AUTONOMOUS_MARKET_HEALTH_CACHE_TTL_MS
    ) return cached;
    await this.signalTail.catch(() => undefined);
    const health = await this.runAutonomousMarketTask(
      () => this.requireProviders().market.checkHealth()
    );
    this.lastAutonomousMarketHealth = health;
    return health;
  }

  async preflightModeChange(mode: ModeState): Promise<void> {
    const current = this.modes.mode;
    const enteringManual = mode === "MANUAL_LIVE" && current === "PAPER";
    const resumingLive =
      current === "PAUSED" &&
      this.modes.pausedFrom === mode &&
      (mode === "MANUAL_LIVE" || mode === "AUTO_LIVE");
    const enteringAuto = mode === "AUTO_LIVE" && current === "MANUAL_LIVE";
    if (!enteringManual && !enteringAuto && !resumingLive) return;
    if (mode === "MANUAL_LIVE" && !this.modes.promotion.paperPassed) {
      throw new Error("The paper promotion gate has not passed.");
    }
    if (mode === "AUTO_LIVE" && !this.modes.promotion.manualLivePassed) {
      throw new Error("The manual-live promotion gate has not passed.");
    }
    if (!this.vault.hasWallet() || !this.repository.getSetting<boolean>("wallet_backup_confirmed")) {
      throw new Error("A dedicated wallet and confirmed encrypted recovery backup are required.");
    }
    if (!this.providers) await this.configureProviders();
    await this.refreshActiveRpcReadiness();
    await this.refreshHealth(false);
    const operationalTelemetry = this.operationalTelemetry();
    if (operationalTelemetry.blocksNewEntries) {
      throw new Error(
        `Local operational telemetry blocks live mode: ${operationalTelemetry.blockingIssueCodes.join(", ")}`
      );
    }
    const providerProfile = this.vault.getDataProviderProfile();
    if (enteringManual && providerProfile.mode === "SELF_HOSTED") {
      const emergencyRpc = activeEmergencyExitRpcStatus(
        providerProfile,
        this.repository.getSetting<StoredEmergencyExitRpcStatus>(EMERGENCY_EXIT_RPC_STATUS_SETTING)
      );
      if (!emergencyExitRpcFresh(emergencyRpc)) {
        throw new Error(
          `The independent emergency-exit RPC is not ready: ${emergencyRpc.message}`
        );
      }
      const soak = calculateSelfHostedPaperSoakStatus(this.repository, providerProfile);
      if (!soak.ready) {
        throw new Error(`The self-hosted PAPER soak has not passed: ${soak.blockers.join("; ")}`);
      }
    }
    const health = new Map(this.repository.listProviderHealth().map((entry) => [entry.provider, entry]));
    for (const provider of ["helius", "jupiter"] as const) {
      const status = health.get(provider);
      if (!status?.ok) throw new Error(`${provider} must pass a fresh health check before live mode can start or resume.`);
    }
    if (enteringManual && !this.repository.getSetting<string[]>("live_wallets")) this.selectLiveWallets();
    await this.reconcileEmergencySubmissions();
    await this.replayConfirmedApplications();
    if (this.repository.listSubmittedExecutions().length > 0) {
      throw new Error("An earlier submitted transaction remains unresolved; live signing stays disabled.");
    }
    await this.reconcileLiveBalances(enteringManual);
    const livePortfolio = this.repository.latestPortfolioSnapshot("LIVE");
    if (!livePortfolio || livePortfolio.balanceMismatchPercent > 1) {
      throw new Error("Live wallet balances must reconcile within 1% of NAV before signing can resume.");
    }
    const pause = await this.evaluateStops(true);
    if (pause.active) {
      throw new Error(`Live safety preflight remains paused: ${pause.reasons.join(", ")}.`);
    }
  }

  async modeChanged(mode: ModeState): Promise<void> {
    if (mode !== "PAPER") await this.stopResearchMonitoring();
    if (mode !== "PAPER") await this.autonomousPaper.drain().catch(() => undefined);
    if (["PAPER", "MANUAL_LIVE", "AUTO_LIVE"].includes(mode)) {
      if (!this.providers) await this.configureProviders();
      if (this.providerWorkQuiesced) return;
      this.walletIndexer?.start();
      this.startParsedBlockRepairIfPending();
      if (mode === "MANUAL_LIVE" || mode === "AUTO_LIVE") await this.reconcileLiveBalances(false);
      await this.subscribeActiveWallets();
      if (mode === "PAPER") {
        void this.subscribeResearchWallets().catch((error) =>
          this.recordProviderWorkError("research_monitoring_subscribe", error)
        );
        const generation = this.providerWorkGeneration;
        void this.refreshDiscoveryIfDue(generation).catch((error) =>
          this.recordProviderWorkError("discovery_start", error)
        );
        this.queueAutonomousPaperCycle();
      }
    } else if (mode === "LOCKED") {
      await this.unsubscribe?.();
      this.unsubscribe = undefined;
      await this.signalTail.catch(() => undefined);
    }
    if (mode === "PAPER") this.queueStockPaperCycle();
  }

  async researchPaperConfigurationChanged(): Promise<void> {
    const recoveredResearchClaims = this.researchPaper.recoverInterruptedClaims();
    const importedResearchSignals = this.researchPaper.backfillRejectedVisibility();
    const lane = this.repository.activeResearchPaperLane();
    this.events.publish("research-paper", {
      active: Boolean(lane),
      recoveredResearchClaims,
      importedResearchSignals
    });
    if (lane && this.modes.mode === "PAPER") {
      this.queueResearchPaperMarks(`configuration:${randomUUID()}`);
      const task = this.trackProviderWork(this.subscribeResearchWallets());
      void task.catch((error) =>
        this.recordProviderWorkError("research_monitoring_subscribe", error)
      );
    } else {
      await this.stopResearchMonitoring();
    }
  }

  async autonomousPaperConfigurationChanged(): Promise<void> {
    // A repeated enable/pause request must never mistake an in-flight claim
    // for crash debris. Drain the serialized engine before recovery inspects
    // its append-only journal.
    await this.autonomousPaper.drain().catch(() => undefined);
    const recoveredAutonomousClaims = this.autonomousPaper.recoverInterruptedClaims();
    const lane = this.repository.activeAutonomousPaperLane();
    this.events.publish("autonomous-paper", {
      active: Boolean(lane),
      recoveredAutonomousClaims
    });
    if (lane && this.modes.mode === "PAPER") {
      this.queueAutonomousPaperCycle();
    } else {
      await this.autonomousPaper.drain().catch(() => undefined);
    }
  }

  async alpacaPaperConfigurationChanged(): Promise<void> {
    await this.stockPaper.drain().catch(() => undefined);
    this.events.publish("stock-paper", {
      active: this.modes.mode === "PAPER" && Boolean(this.alpacaCredentials())
    });
    this.queueStockPaperCycle();
  }

  stockPaperDashboard(): StockPaperDashboard {
    return this.stockPaper.dashboard();
  }

  async approveExecution(id: string): Promise<ExecutionRecord> {
    if (!this.liveBroker) throw new Error("Live broker is not configured.");
    const key = this.executionKeys.get(id);
    if (!key || !this.ordersByKey.has(key)) {
      throw new Error("This approval expired or the app restarted; the order was not signed.");
    }
    const record = await this.liveBroker.approve(id);
    this.persistExecutionOutcome(record);
    const order = this.ordersByKey.get(record.idempotencyKey);
    if (order && record.status === "CONFIRMED") await this.applyExecution(order, record);
    this.executionKeys.delete(id);
    this.ordersByKey.delete(record.idempotencyKey);
    this.updatePromotionGate();
    return record;
  }

  async rejectExecution(id: string): Promise<ExecutionRecord> {
    if (!this.liveBroker) throw new Error("Live broker is not configured.");
    const record = await this.liveBroker.reject(id, "rejected by user");
    this.persistExecutionOutcome(record);
    this.executionKeys.delete(id);
    this.ordersByKey.delete(record.idempotencyKey);
    this.repository.audit("manual_order_rejected", "A manual-live order was rejected.", { id });
    return record;
  }

  operationalPauseState(): OperationalPauseState {
    const persisted = this.repository.getSetting<OperationalPauseState>("operational_pause_state");
    if (persisted) return persisted;
    return this.repository.getSetting<boolean>("new_entries_paused")
      ? legacyOperationalPause()
      : inactiveOperationalPause();
  }

  operationalTelemetry(now = new Date()): OperationalTelemetrySnapshot {
    const chain = this.providers?.chain;
    const streamStatus = chain && typeof chain.getStreamStatus === "function"
      ? chain.getStreamStatus()
      : undefined;
    return collectOperationalTelemetry(
      this.repository,
      now,
      undefined,
      streamStatus ? { streamStatus } : {}
    );
  }

  walletAcquisitionStatus(): WalletAcquisitionGoal | undefined {
    return this.walletAcquisition?.snapshot();
  }

  solPriceBootstrapStatus(): SolPriceBootstrapStatus {
    return this.solPriceBootstrap.status();
  }

  /** Explicit operator seam for first start or resuming a deliberately paused/failed cursor. */
  startSolPriceBootstrap(): SolPriceBootstrapStatus {
    return this.solPriceBootstrap.startAuthorized();
  }

  pauseSolPriceBootstrap(): Promise<SolPriceBootstrapStatus> {
    return this.solPriceBootstrap.pause();
  }

  captureProviderParityBaseline() {
    // Current managed/local provider interfaces expose rolling reads only.
    // The coordinator persists precise capability blockers and deliberately
    // refuses to pass those providers as point-in-time adapters.
    return new ProviderParityBaselineCoordinator(
      this.repository,
      () => this.vault.getDataProviderProfile()
    ).capture();
  }

  async recheckOperationalPause(): Promise<OperationalPauseState> {
    const state = await this.evaluateStops(true);
    if (state.active) {
      throw new Error(
        `New entries remain paused: ${state.reasons.join(", ")}. The safety condition has not cleared.`
      );
    }
    return state;
  }

  async emergencyExit(): Promise<{ closed: number; failed: number; locked: boolean }> {
    if (this.emergencyActive) throw new Error("Emergency exit is already running.");
    if (this.executionMode() !== "LIVE") {
      throw new Error("Emergency exit is available only for live bot-created positions.");
    }
    const liquidation = this.repository.beginEmergencyLiquidation("emergency exit");
    // Persist the lock before the first await. A process kill, provider error,
    // or power loss can no longer restore AUTO_LIVE while liquidation is only
    // partially complete.
    this.modes.lock("Emergency liquidation is in progress; live signing is locked.");
    this.events.publish("mode", { mode: "LOCKED" });
    this.emergencyActive = true;
    let closed = 0;
    let failed = 0;
    try {
      await this.reconcileEmergencySubmissions().catch((error) => {
        this.recordError("emergency_reconciliation", error);
      });
      await this.replayConfirmedApplications();
      try {
        await this.unsubscribe?.();
      } catch (error) {
        this.recordError("emergency_unsubscribe", error);
      }
      this.unsubscribe = undefined;
      if (this.liveBroker) {
        try {
          for (const cancelled of await this.liveBroker.cancelPending("cancelled by emergency exit before signing")) {
            this.persistExecutionOutcome(cancelled);
            this.executionKeys.delete(cancelled.id);
            this.ordersByKey.delete(cancelled.idempotencyKey);
            this.events.publish("execution", cancelled);
          }
        } catch (error) {
          this.recordError("emergency_cancel_pending", error);
        }
      }
      for (const position of this.repository.listPositions("LIVE", true)) {
        const operation = this.prepareEmergencyExitOperation(liquidation.id, position);
        if (operation.state === "SUBMITTED_UNRESOLVED") {
          failed += 1;
          this.repository.audit(
            "emergency_retry_quarantined",
            "A prior broadcast remains unresolved; this position was not submitted again.",
            { positionId: position.id, operationId: operation.operationId, targetSignature: operation.targetSignature },
            "critical"
          );
          continue;
        }
        try {
          const result = await this.forceExitPosition(position, "emergency exit", "EMERGENCY_EXIT", operation);
          const execution = this.repository.getExecutionByIdempotencyKey(operation.idempotencyKey);
          if (result && execution?.status === "CONFIRMED") {
            closed += 1;
            this.repository.updateEmergencyExitOperation(position.id, "CONFIRMED", {
              executionId: execution.id,
              ...(execution.targetSignature ? { targetSignature: execution.targetSignature } : {})
            });
          } else {
            failed += 1;
            const unresolved = execution?.status === "SUBMITTED" || execution?.status === "SUBMITTED_UNRESOLVED";
            this.repository.updateEmergencyExitOperation(
              position.id,
              unresolved ? "SUBMITTED_UNRESOLVED" : "FAILED_SAFE",
              {
                ...(execution ? { executionId: execution.id } : {}),
                ...(execution?.targetSignature ? { targetSignature: execution.targetSignature } : {}),
                lastError: execution?.failureReason ?? "Emergency exit was not confirmed."
              }
            );
          }
        } catch (error) {
          failed += 1;
          const execution = this.repository.getExecutionByIdempotencyKey(operation.idempotencyKey);
          const unresolved = execution?.status === "SUBMITTED" || execution?.status === "SUBMITTED_UNRESOLVED";
          this.repository.updateEmergencyExitOperation(
            position.id,
            unresolved ? "SUBMITTED_UNRESOLVED" : "FAILED_SAFE",
            {
              ...(execution ? { executionId: execution.id } : {}),
              ...(execution?.targetSignature ? { targetSignature: execution.targetSignature } : {}),
              lastError: this.errorText(error)
            }
          );
          this.recordError("emergency_position", error, { positionId: position.id });
        }
      }
    } finally {
      const unresolved = this.repository.listEmergencyExitOperations(["SUBMITTED_UNRESOLVED"]).length;
      const remaining = this.repository.listPositions("LIVE", true).length;
      const incomplete = failed > 0 || unresolved > 0 || remaining > 0;
      this.repository.finishEmergencyLiquidation(
        liquidation.id,
        incomplete ? "LOCKED_INCOMPLETE" : "LOCKED_COMPLETE",
        closed,
        Math.max(failed, remaining, unresolved)
      );
      this.modes.lock(
        incomplete
          ? `Emergency exit is incomplete (${remaining} open, ${unresolved} unresolved); live signing remains locked.`
          : "Emergency exit completed; live signing is locked for review."
      );
      this.events.publish("mode", { mode: "LOCKED" });
      this.emergencyActive = false;
    }
    return { closed, failed, locked: true };
  }

  async refreshDiscovery(
    requiredLocalWallets: readonly string[] = [],
    expectedGeneration = this.providerWorkGeneration
  ): Promise<void> {
    return this.trackProviderWork(
      this.runDiscovery(requiredLocalWallets, expectedGeneration)
    );
  }

  private async runDiscovery(
    requiredLocalWallets: readonly string[],
    expectedGeneration: number
  ): Promise<void> {
    this.assertProviderWorkCurrent(expectedGeneration);
    const requiredLocal = new Set(requiredLocalWallets);
    const providerProfile = this.vault.getDataProviderProfile();
    const usesManagedChain = providerProfile.mode !== "SELF_HOSTED";
    const usesManagedDiscovery = providerProfile.mode !== "SELF_HOSTED";
    if (this.discoveryRunning || this.managedRecoveryPreflightRunning) {
      if (requiredLocal.size > 0) throw new Error("Provider qualification is already running.");
      return;
    }
    if (usesManagedChain && requiredLocal.size > 0) {
      const minimumCredits = requiredLocal.size * MINIMUM_HELIUS_RESEARCH_CREDITS_PER_WALLET;
      const availableCredits = this.availableTotalHeliusCredits();
      if (availableCredits < minimumCredits) {
        throw new ProviderQualificationBudgetError(
          `Provider qualification needs at least ${minimumCredits} Helius credits; ${availableCredits} remain this month.`
        );
      }
    }
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    const birdeyeUsage = this.repository
      .usageSince(monthStart.toISOString().slice(0, 10))
      .find((entry) => entry.provider === "birdeye");
    if (
      usesManagedDiscovery &&
      (birdeyeUsage?.credits ?? 0) + BIRDEYE_DISCOVERY_WORST_CASE_CU >
      BIRDEYE_MONTHLY_DISCOVERY_BUDGET_CU
    ) {
      const month = monthStart.toISOString().slice(0, 7);
      if (this.repository.getSetting<string>("birdeye_discovery_deferred_month") !== month) {
        this.repository.audit(
          "discovery_deferred",
          "Wallet discovery was deferred to preserve the Birdeye free-tier budget.",
          {
            usedCu: birdeyeUsage?.credits ?? 0,
            reservedCu: BIRDEYE_DISCOVERY_WORST_CASE_CU,
            budgetCu: BIRDEYE_MONTHLY_DISCOVERY_BUDGET_CU
          },
          "warning"
        );
        this.repository.setSetting("birdeye_discovery_deferred_month", month);
      }
      if (requiredLocal.size > 0) {
        throw new ProviderQualificationBudgetError(
          "Provider qualification is waiting for the next Birdeye monthly budget window."
        );
      }
      return;
    }
    const providers = this.requireProviders();
    this.discoveryRunning = true;
    try {
      const priorCohort = this.repository.latestCohort();
      const priorActive = priorCohort
        ? this.repository.listCandidates(priorCohort.cohortId, true).map((candidate) => candidate.address)
        : [];
      const priorQualified = priorCohort
        ? this.repository
            .listWalletScores(priorCohort.cohortId)
            .filter((score) => score.qualified)
            .map((score) => score.wallet)
        : [];
      const discovered = await providers.discovery.discoverCohort();
      this.assertProviderWorkCurrent(expectedGeneration);
      // Four first-page leaderboards plus second pages for 30d/90d winners.
      const sameCohort = priorCohort?.cohortId === discovered.cohortId;
      const priorCandidates = new Map(
        (priorCohort ? this.repository.listCandidates(priorCohort.cohortId) : []).map((candidate) => [
          candidate.address,
          candidate
        ])
      );
      const reusableScores = new Set(
        sameCohort
          ? this.repository
              .listWalletScores(discovered.cohortId)
              .map((score) => score.wallet)
          : []
      );

      const providerRankedShortlist = discovered.candidates
        .filter((candidate) => !candidate.control)
        .sort((left, right) => {
          const leftBoth = left.sourceRank30d !== undefined && left.sourceRank90d !== undefined;
          const rightBoth = right.sourceRank30d !== undefined && right.sourceRank90d !== undefined;
          const leftLane = leftBoth ? 0 : left.sourceRank90d !== undefined ? 1 : 2;
          const rightLane = rightBoth ? 0 : right.sourceRank90d !== undefined ? 1 : 2;
          if (leftLane !== rightLane) return leftLane - rightLane;
          return (
            Math.min(left.sourceRank30d ?? 9999, left.sourceRank90d ?? 9999) -
            Math.min(right.sourceRank30d ?? 9999, right.sourceRank90d ?? 9999)
          );
        })
        .slice(0, DISCOVERY_SHORTLIST);
      const controls = discovered.candidates
        .filter((candidate) => candidate.control)
        .slice(0, PAPER_WALLET_COUNT);
      const localRecords = requiredLocal.size === 0
        ? this.repository.listWalletIndexResearchShortlist(LOCAL_INDEX_SHORTLIST)
        : [...requiredLocal].map((wallet) => {
            const record = this.repository.getWalletIndexRecord(wallet);
            if (!record) throw new Error(`Research-ready wallet ${wallet} no longer has a local aggregate.`);
            return record;
          });
      const researchShortlist = buildWalletResearchShortlist({
        cohortId: discovered.cohortId,
        localRecords,
        providerCandidates: providerRankedShortlist,
        excludedWallets: discovered.candidates
          .filter((candidate) => candidate.control)
          .map((candidate) => candidate.address),
        totalLimit: DISCOVERY_SHORTLIST,
        localLimit: LOCAL_INDEX_SHORTLIST
      });
      const shortlist = [...researchShortlist.candidates, ...controls];

      const enriched = new Map<string, WalletCandidate>();
      for (const candidate of shortlist) {
        this.assertProviderWorkCurrent(expectedGeneration);
        const previous = sameCohort ? priorCandidates.get(candidate.address) : undefined;
        if (previous?.pnl30d && previous.pnl90d) {
          enriched.set(candidate.address, {
            ...candidate,
            pnl30d: previous.pnl30d,
            pnl90d: previous.pnl90d
          });
          continue;
        }
        try {
          const [pnl30dResult, pnl90dResult] = await Promise.allSettled([
            providers.discovery.getPnl(candidate.address, "30d"),
            providers.discovery.getPnl(candidate.address, "90d")
          ]);
          this.assertProviderWorkCurrent(expectedGeneration);
          if (pnl30dResult.status === "rejected") throw pnl30dResult.reason;
          if (pnl90dResult.status === "rejected") throw pnl90dResult.reason;
          const pnl30d = pnl30dResult.value;
          const pnl90d = pnl90dResult.value;
          enriched.set(candidate.address, { ...candidate, pnl30d, pnl90d });
        } catch (error) {
          if (error instanceof ProviderWorkSupersededError) throw error;
          this.recordError("candidate_pnl", error, { wallet: candidate.address });
          if (requiredLocal.has(candidate.address)) throw error;
          enriched.set(candidate.address, candidate);
        }
      }

      // Carry every still-qualified research candidate into the next scoring
      // pass, not only an already-active paper wallet. This lets bounded local
      // handoffs accumulate legitimate qualifiers into the required forward
      // set while a weekly cohort rollover still forces fresh PnL/history.
      for (const address of new Set([...priorActive, ...priorQualified])) {
        if (!enriched.has(address)) {
          const previous = priorCandidates.get(address);
          if (previous && !previous.control) {
            enriched.set(address, { ...previous, cohortId: discovered.cohortId });
          }
        }
      }

      const candidates = discovered.candidates.map((candidate) => enriched.get(candidate.address) ?? candidate);
      for (const [address, candidate] of enriched) {
        if (!candidates.some((item) => item.address === address)) candidates.push(candidate);
      }
      const cohort = { ...discovered, candidates };
      this.assertProviderWorkCurrent(expectedGeneration);
      this.repository.saveCohort(cohort);

      for (const candidate of enriched.values()) {
        this.assertProviderWorkCurrent(expectedGeneration);
        if (reusableScores.has(candidate.address) && !requiredLocal.has(candidate.address)) continue;
        let history: WalletHistorySummary;
        let providerHistoryAvailable = false;
        try {
          history = await providers.chain.summarizeHistory(candidate.address, 90);
          this.assertProviderWorkCurrent(expectedGeneration);
          providerHistoryAvailable = true;
        } catch (error) {
          if (error instanceof ProviderWorkSupersededError) throw error;
          this.recordError("candidate_history", error, { wallet: candidate.address });
          if (requiredLocal.has(candidate.address)) throw error;
          history = {
            wallet: candidate.address,
            historyDays: 0,
            closedEligibleSwaps: 0,
            activeWeeks: 0,
            medianHoldingMinutes: 0,
            topTokenProfitShare: 1,
            topThreeProfitShare: 1,
            tags: ["history-unavailable"]
          };
        }
        let qualificationHistory = history;
        if (providerHistoryAvailable) {
          const localRecord = this.repository.getWalletIndexRecord(candidate.address);
          if (localRecord && this.vault.getDataProviderProfile().mode === "MANAGED") {
            persistManagedWalletIdentity(this.repository, candidate.address, history);
            if (requiredLocal.has(candidate.address)) {
              const frozenCohort = this.repository.latestWalletDeepHistoryCohortForWallet(candidate.address);
              const frozenEvidence = frozenCohort
                ? this.repository.getWalletDeepHistoryEvidence(frozenCohort.generationId, candidate.address)
                : undefined;
              if (!frozenCohort || !frozenEvidence || frozenEvidence.cohortId !== frozenCohort.id) {
                throw new Error(
                  `Research-ready wallet ${candidate.address} lost its immutable deep-history evidence.`
                );
              }
              qualificationHistory = combineManagedProviderAndFrozenHistory(history, frozenEvidence.record);
              this.repository.audit(
                "managed_structural_history_selected",
                "Managed qualification used exact frozen Helius-RPC structural metrics with independent provider concentration and tags.",
                {
                  wallet: candidate.address,
                  cohortId: cohort.cohortId,
                  deepHistoryGenerationId: frozenEvidence.generationId,
                  deepHistoryCohortId: frozenEvidence.cohortId,
                  evidenceDigest: frozenEvidence.evidenceDigest,
                  providerHistory: {
                    historyDays: history.historyDays,
                    closedEligibleSwaps: history.closedEligibleSwaps,
                    activeWeeks: history.activeWeeks,
                    medianHoldingMinutes: history.medianHoldingMinutes
                  },
                  frozenHistory: {
                    historyDays: qualificationHistory.historyDays,
                    closedEligibleSwaps: qualificationHistory.closedEligibleSwaps,
                    activeWeeks: qualificationHistory.activeWeeks,
                    medianHoldingMinutes: qualificationHistory.medianHoldingMinutes
                  }
                }
              );
            }
          }
          try {
            const reconciliation = reconcileWalletHistory({
              wallet: candidate.address,
              cohortId: cohort.cohortId,
              comparedAt: new Date().toISOString(),
              providerHistory: history,
              localRecord: this.repository.getWalletIndexRecord(candidate.address)
            });
            this.repository.saveWalletHistoryReconciliation(reconciliation);
            this.repository.audit(
              "wallet_history_reconciled",
              reconciliation.status === "DIVERGENT"
                ? "Local wallet history diverged from the full provider history."
                : reconciliation.status === "LOCAL_UNAVAILABLE"
                  ? "Provider wallet history was recorded without a matching local aggregate."
                  : reconciliation.status === "PARTIAL"
                    ? "Available local wallet metrics matched provider history, but some local evidence was unavailable."
                    : "Local and provider wallet history were consistent within configured tolerances.",
              {
                wallet: candidate.address,
                cohortId: cohort.cohortId,
                status: reconciliation.status,
                agreementRate: reconciliation.agreementRate,
                comparableMetrics: reconciliation.comparableMetrics,
                mismatchMetrics: reconciliation.mismatchMetrics,
                unavailableMetrics: reconciliation.unavailableMetrics,
                reasons: reconciliation.reasons,
                limitations: reconciliation.limitations
              },
              reconciliation.status === "DIVERGENT" ? "warning" : "info"
            );
          } catch (error) {
            // Data-quality diagnostics must never replace or weaken the full
            // provider history used by the qualification policy.
            this.recordError("wallet_history_reconciliation", error, { wallet: candidate.address });
          }
        }
        this.repository.saveWalletScore(
          cohort.cohortId,
          scoreWalletResearchCandidate(candidate, qualificationHistory)
        );
      }

      this.assertProviderWorkCurrent(expectedGeneration);
      const savedScores = new Set(
        this.repository.listWalletScores(cohort.cohortId).map((score) => score.wallet)
      );
      const missingRequiredScores = researchShortlist.localAddresses.filter(
        (wallet) => requiredLocal.has(wallet) && !savedScores.has(wallet)
      );
      if (missingRequiredScores.length > 0) {
        throw new Error(
          `Provider qualification did not persist ${missingRequiredScores.length} required wallet score(s).`
        );
      }

      this.assertProviderWorkCurrent(expectedGeneration);
      this.reconcileForwardPaperSelection(cohort.cohortId);

      this.assertProviderWorkCurrent(expectedGeneration);
      this.freezeForwardPaperEvaluation(cohort.cohortId);
      await this.subscribeActiveWallets(expectedGeneration);
      this.assertProviderWorkCurrent(expectedGeneration);
      this.providerDiscoveryRequired = false;
      this.repository.audit("cohort_refreshed", "Wallet discovery and qualification completed.", {
        cohortId: cohort.cohortId,
        candidates: cohort.candidates.length,
        active: this.repository.listCandidates(cohort.cohortId, true).length,
        localIndexShortlisted: researchShortlist.localAddresses.length,
        providerShortlisted: researchShortlist.providerAddresses.length,
        shortlistOverlap: researchShortlist.overlapAddresses.length
      });
      this.events.publish("discovery", { cohortId: cohort.cohortId });
    } finally {
      this.discoveryRunning = false;
      if (!this.researchHandoffRunning && !this.stopping && !this.providerWorkQuiesced) {
        const generation = this.providerWorkGeneration;
        void this.refreshDiscoveryIfDue(generation).catch((error) =>
          this.recordProviderWorkError("wallet_research_handoff", error)
        );
      }
    }
  }

  private availableTotalHeliusCredits(at = new Date()): number {
    const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
    const used = this.repository
      .usageSince(start.toISOString().slice(0, 10))
      .filter((entry) => entry.provider === "helius" || entry.provider === "helius_index")
      .reduce((sum, entry) => sum + entry.credits, 0);
    return Math.max(0, DEFAULT_TOTAL_HELIUS_MONTHLY_CREDIT_BUDGET - used);
  }

  private availableBirdeyeCredits(at = new Date()): number {
    const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
    const used = this.repository
      .usageSince(start.toISOString().slice(0, 10))
      .find((entry) => entry.provider === "birdeye")?.credits ?? 0;
    return Math.max(0, BIRDEYE_MONTHLY_DISCOVERY_BUDGET_CU - used);
  }

  private canSpendManagedRecoveryBirdeyeStep(): boolean {
    return this.availableBirdeyeCredits() >=
      BIRDEYE_PREFLIGHT_FINAL_RESERVE_CU + BIRDEYE_PREFLIGHT_STEP_WORST_CASE_CU;
  }

  private canSpendManagedRecoveryHeliusHistory(): boolean {
    return this.availableTotalHeliusCredits() >=
      HELIUS_PREFLIGHT_FINAL_RESERVE_CREDITS + HELIUS_PREFLIGHT_HISTORY_WORST_CASE_CREDITS;
  }

  private canRunManagedRecoveryPreflight(expectedGeneration: number): boolean {
    if (
      !this.isProviderWorkCurrent(expectedGeneration) ||
      this.modes.mode === "SETUP" ||
      this.vault.getDataProviderProfile().mode !== "MANAGED" ||
      this.discoveryRunning ||
      this.researchHandoffRunning ||
      !this.providers ||
      !this.walletAcquisition ||
      this.repository.activePaperEvaluationCohort() ||
      this.repository.hasPendingWalletResearchHandoffs() ||
      this.repository.openWalletDeepHistoryCohort()
    ) return false;
    const acquisition = this.walletAcquisition.snapshot();
    return acquisition.targetWallets === acquisition.maximumWallets &&
      this.repository.walletIndexCoverage().indexedWallets >= acquisition.maximumWallets &&
      acquisition.budget.heliusIndexRemainingCredits >
        MANAGED_DEEP_HISTORY_RESCUE_CREDIT_RESERVE &&
      this.walletAcquisition.shouldContinueResearch();
  }

  private async runManagedRecoveryPreflightStep(
    expectedGeneration: number
  ): Promise<boolean> {
    const coordinator = this.managedRecoveryPreflight;
    if (
      !coordinator ||
      this.managedRecoveryPreflightRunning ||
      !this.canRunManagedRecoveryPreflight(expectedGeneration)
    ) return false;
    this.managedRecoveryPreflightRunning = true;
    try {
      return await coordinator.runOnce();
    } finally {
      this.managedRecoveryPreflightRunning = false;
    }
  }

  private reserveHeliusProviderCredits(credits: number): void {
    if (!Number.isSafeInteger(credits) || credits < 1) {
      throw new Error("Helius credit reservation must be a positive integer.");
    }
    const available = this.availableTotalHeliusCredits();
    if (available < credits) {
      throw new ProviderQualificationBudgetError(
        `Monthly Helius credit reserve reached; ${available} credit(s) remain.`
      );
    }
    this.repository.incrementUsage("helius", credits);
  }

  private reserveBirdeyeProviderCredits(credits: number): void {
    if (!Number.isSafeInteger(credits) || credits < 1) {
      throw new Error("Birdeye credit reservation must be a positive integer.");
    }
    const available = this.availableBirdeyeCredits();
    if (available < credits) {
      throw new ProviderQualificationBudgetError(
        `Monthly Birdeye credit reserve reached; ${available} CU remain.`
      );
    }
    // Reserve before network I/O. Failed responses and 429 retries can still
    // consume provider capacity and therefore remain in the durable budget.
    this.repository.incrementUsage("birdeye", credits);
  }

  private createBirdeyeProvider(apiKey: string): BirdeyeProvider {
    return new BirdeyeProvider(apiKey, {
      fetch: this.birdeyeFetch,
      onRequest: ({ credits }) => this.reserveBirdeyeProviderCredits(credits)
    });
  }

  private processResearchHandoffs(
    expectedGeneration = this.providerWorkGeneration
  ): Promise<boolean> {
    return this.trackProviderWork(this.runResearchHandoffs(expectedGeneration));
  }

  private async runResearchHandoffs(expectedGeneration: number): Promise<boolean> {
    if (
      !this.isProviderWorkCurrent(expectedGeneration) ||
      this.researchHandoffRunning ||
      this.discoveryRunning ||
      this.managedRecoveryPreflightRunning ||
      !this.providers
    ) return false;
    const handoff = this.repository.claimWalletResearchHandoff();
    if (!handoff) return false;
    this.researchHandoffRunning = true;
    try {
      this.assertProviderWorkCurrent(expectedGeneration);
      // A crash can leave a duplicate READY handoff created by the retired
      // generation-selection behavior. Re-check the durable completion fence
      // immediately before provider I/O so restart recovery cannot pay twice.
      const wallets = handoff.wallets.filter(
        (wallet) => !this.repository.hasCompletedLocalProviderQualification(wallet)
      );
      if (wallets.length > 0) await this.refreshDiscovery(wallets, expectedGeneration);
      this.assertProviderWorkCurrent(expectedGeneration);
      const cohortId = this.repository.latestCohort()?.cohortId;
      if (!this.repository.completeWalletResearchHandoff(handoff.generation, cohortId)) {
        throw new Error(`Research handoff ${handoff.generation} lost its running claim.`);
      }
      this.repository.audit(
        "wallet_research_handoff_complete",
        wallets.length > 0
          ? "Research-ready local wallets completed provider qualification."
          : handoff.wallets.length > 0
            ? "The local research generation was already provider-qualified by a prior durable handoff."
            : "The local research generation completed with no structural survivors to qualify.",
        {
          generation: handoff.generation,
          wallets: wallets.length,
          skippedCompletedWallets: handoff.wallets.length - wallets.length,
          cohortId
        }
      );
      this.events.publish("wallet-research-qualified", {
        generation: handoff.generation,
        wallets: wallets.length,
        cohortId
      });
      return true;
    } catch (error) {
      if (error instanceof ProviderWorkSupersededError) return false;
      this.assertProviderWorkCurrent(expectedGeneration);
      const at = new Date();
      const nextAttemptAt = error instanceof ProviderQualificationBudgetError
        ? new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1))
        : new Date(at.getTime() + Math.min(6 * 60 * 60_000, 60_000 * 2 ** Math.max(0, handoff.attempts - 1)));
      const message = this.errorText(error);
      this.repository.retryWalletResearchHandoff(handoff.generation, message, nextAttemptAt, at);
      this.repository.audit(
        "wallet_research_handoff_retry",
        "Provider qualification remains queued after a safe retryable failure.",
        {
          generation: handoff.generation,
          attempts: handoff.attempts,
          nextAttemptAt: nextAttemptAt.toISOString(),
          reason: message
        },
        "warning"
      );
      this.scheduleResearchHandoffRetry(expectedGeneration);
      return false;
    } finally {
      this.researchHandoffRunning = false;
      if (!this.stopping && !this.providerWorkQuiesced && !this.discoveryRunning && this.providers) {
        const generation = this.providerWorkGeneration;
        queueMicrotask(() => {
          void this.processResearchHandoffs(generation).catch((nextError) =>
            this.recordProviderWorkError("wallet_research_handoff", nextError)
          );
        });
      }
    }
  }

  private scheduleResearchHandoffRetry(expectedGeneration = this.providerWorkGeneration): void {
    if (
      this.stopping ||
      this.providerWorkQuiesced ||
      !this.isProviderWorkCurrent(expectedGeneration) ||
      this.researchHandoffRetryTimer
    ) return;
    const next = this.repository.nextWalletResearchHandoffRetry();
    if (!next) return;
    const retryAt = Date.parse(next.nextAttemptAt);
    const delay = Number.isFinite(retryAt) ? Math.max(0, retryAt - Date.now()) : 0;
    const scheduledDelay = Math.min(delay, MAX_RESEARCH_HANDOFF_RETRY_TIMER_DELAY_MS);
    this.researchHandoffRetryTimer = setTimeout(async () => {
      this.researchHandoffRetryTimer = undefined;
      if (!this.isProviderWorkCurrent(expectedGeneration)) return;
      // A capped long-range wake is only a checkpoint. Re-read the durable
      // retry rather than claiming early, and keep exactly one bounded timer.
      if (Number.isFinite(retryAt) && Date.now() < retryAt) {
        this.scheduleResearchHandoffRetry(expectedGeneration);
        return;
      }
      try {
        await this.processResearchHandoffs(expectedGeneration);
      } catch (error) {
        this.recordProviderWorkError("wallet_research_handoff_retry", error);
      }
    }, scheduledDelay);
    this.researchHandoffRetryTimer.unref?.();
  }

  private createPythBenchmarksProvider(
    apiKey: string | undefined,
    allowBootstrapOverride: boolean
  ): PythBenchmarksPriceProvider {
    if (allowBootstrapOverride && this.pythBenchmarksProviderOverride) {
      return this.pythBenchmarksProviderOverride;
    }
    if (this.pythBenchmarksProviderFactory) {
      return this.pythBenchmarksProviderFactory(apiKey);
    }
    return new PythBenchmarksClient({
      ...(apiKey ? { apiKey } : {}),
      onRequest: () => this.repository.incrementUsage("pyth_benchmarks")
    });
  }

  private createSolPriceBootstrapWorker(): SolPriceBootstrapWorker {
    const encryptedApiKey = this.vault.getCredentials()?.pythBenchmarksApiKey?.trim();
    const apiKey = encryptedApiKey || this.pythBenchmarksApiKeyFallback;
    const primary = this.createPythBenchmarksProvider(apiKey, true);
    let provider: SolUsdHistoricalPriceProvider = primary;
    const credentials = this.vault.getCredentials();
    const profile = this.vault.getDataProviderProfile();
    const birdeyeApiKey = credentials?.birdeyeApiKey?.trim();
    const injectedProvider = Boolean(
      this.pythBenchmarksProviderOverride || this.pythBenchmarksProviderFactory
    );
    if (!injectedProvider && profile.mode !== "SELF_HOSTED" && birdeyeApiKey) {
      const fallback = new BirdeyeSolUsdHistoryClient(birdeyeApiKey, {
        fetch: this.birdeyeFetch,
        onRequest: ({ credits }) => this.reserveBirdeyeProviderCredits(credits)
      });
      provider = new ResilientSolUsdHistoryProvider(primary, fallback, {
        onFallback: (reason) => this.repository.audit(
          "sol_price_bootstrap_managed_fallback",
          reason === "PRIMARY_NOT_CONFIGURED"
            ? "The SOL/USD history bootstrap selected authenticated Birdeye OHLCV because no Pyth bearer key is configured."
            : "The SOL/USD history bootstrap selected authenticated Birdeye OHLCV after Pyth failed.",
          { reason, source: "birdeye_ohlcv_v3" }
        )
      });
    }
    return new SolPriceBootstrapWorker(this.repository, provider, {
      onProgress: (status) => this.events.publish("sol-price-bootstrap", status)
    });
  }

  private async recreateSolPriceBootstrapClient(): Promise<void> {
    if (this.solPriceBootstrapWorkerOverride) return;
    const previous = this.solPriceBootstrap.status();
    await this.solPriceBootstrap.pause();
    this.solPriceBootstrap = this.createSolPriceBootstrapWorker();
    const current = this.solPriceBootstrap.status();
    this.events.publish("sol-price-bootstrap", current);
    if (previous.activeInProcess) {
      this.repository.audit(
        "sol_price_bootstrap_credentials_changed",
        "The active SOL/USD history bootstrap was paused before its provider client was recreated. Explicit resume is required.",
        { completedPoints: current.completedPoints, totalPoints: current.totalPoints },
        "warning"
      );
    }
  }

  private async validatePythBenchmarksApiKey(apiKey: string): Promise<ProviderHealth> {
    const startedAt = Date.now();
    try {
      const provider = this.createPythBenchmarksProvider(apiKey, false);
      if (!provider.authenticationConfigured) throw new Error("Pyth authentication was not configured.");
      const timestampSeconds = Math.floor(Date.now() / 1_000) - 60;
      await provider.getSolUsdPrice(timestampSeconds);
      return {
        provider: "pyth",
        ok: true,
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - startedAt,
        message: "Pyth Benchmarks is reachable and authenticated"
      };
    } catch {
      return {
        provider: "pyth",
        ok: false,
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - startedAt,
        message: "Pyth Benchmarks authentication or response validation failed"
      };
    }
  }

  private async configureProviders(): Promise<void> {
    const configuredGeneration = this.providerWorkGeneration;
    if (this.monitoringRepairRetryTimer) clearTimeout(this.monitoringRepairRetryTimer);
    this.monitoringRepairRetryTimer = undefined;
    if (this.researchMonitoringRetryTimer) clearTimeout(this.researchMonitoringRetryTimer);
    this.researchMonitoringRetryTimer = undefined;
    if (this.researchHandoffRetryTimer) clearTimeout(this.researchHandoffRetryTimer);
    this.researchHandoffRetryTimer = undefined;
    const credentials = this.vault.getCredentials();
    if (!credentials) throw new Error("Encrypted provider credentials are not configured.");
    if (!credentials.jupiterApiKey?.trim()) throw new Error("Jupiter credentials are not configured.");
    await this.unsubscribe?.();
    this.unsubscribe = undefined;
    await this.researchUnsubscribe?.();
    this.researchUnsubscribe = undefined;
    this.researchMonitoringWallets.clear();
    await this.walletIndexer?.stop();
    await this.parsedBlockRepairWorker?.stop();
    this.managedRecoveryPreflight = undefined;
    this.managedRecoveryPreflightRunning = false;
    this.emergencyExecutionRpc = undefined;
    this.lastAutonomousMarketHealth = undefined;
    const profile = this.vault.getDataProviderProfile();
    const localDiscovery = new LocalWalletDiscoveryProvider(this.repository);
    const paritySink = new DurableProviderParitySink(
      this.repository,
      () => this.vault.getDataProviderProfile()
    );
    const managed = profile.mode === "SELF_HOSTED" ? undefined : requireManagedCredentials(credentials);
    const managedFetch: FetchLike | undefined = managed
      ? createPacedFetch({ requestsPerSecond: 4 })
      : undefined;
    const discovery: HealthCheckedWalletDiscoveryProvider = managed
      ? profile.mode === "MANAGED"
        ? this.createBirdeyeProvider(managed.birdeyeApiKey)
        : new ShadowWalletDiscoveryProvider(
            this.createBirdeyeProvider(managed.birdeyeApiKey),
            localDiscovery,
            paritySink
          )
      : localDiscovery;
    const swap = new JupiterSwapProvider(credentials.jupiterApiKey, {
      fetch: this.jupiterFetch,
      timeoutMs: JUPITER_REQUEST_TIMEOUT_MS
    });
    const token = new JupiterTokenRiskProvider(credentials.jupiterApiKey, {
      fetch: this.jupiterFetch,
      timeoutMs: JUPITER_REQUEST_TIMEOUT_MS
    });
    const market = new JupiterMarketDataProvider(credentials.jupiterApiKey, {
      fetch: this.jupiterFetch,
      timeoutMs: JUPITER_REQUEST_TIMEOUT_MS
    });
    const quotes = new RateLimitedQuoteExecutor(swap);
    let chain: RuntimeChainProvider;
    let researchChain: RuntimeChainProvider;
    let indexRpc: StandardSolanaRpcClient | undefined;
    let selfHostedChain: RuntimeChainProvider | undefined;
    let selfHostedResearchChain: RuntimeChainProvider | undefined;
    let selfHostedRpc: StandardSolanaRpcClient | undefined;
    if (profile.mode !== "MANAGED") {
      if (!profile.solanaHttpUrl || !profile.solanaWsUrl) {
        throw new Error("Self-hosted provider endpoints are not configured.");
      }
      const onRequest = (): void => this.repository.incrementUsage("solana_rpc");
      selfHostedRpc = new StandardSolanaRpcClient({
        httpUrl: profile.solanaHttpUrl,
        onRequest
      });
      if (profile.emergencySolanaHttpUrl) {
        this.emergencyExecutionRpc = new StandardSolanaRpcClient({
          httpUrl: profile.emergencySolanaHttpUrl,
          onRequest
        });
      }
      const observer = new StandardSolanaObserver({
        httpUrl: profile.solanaHttpUrl,
        wsUrl: profile.solanaWsUrl,
        walletTagResolver: async (address) => verifiedLocalWalletTags(this.repository, address),
        solPriceUsdResolver: async (at) => this.resolveSelfHostedSolPriceUsd(at),
        onError: (error) => this.recordError("solana_stream", error),
        onRejectedSwap: (rejection) => this.queueProviderRejectedSwap(rejection),
        onRequest
      });
      selfHostedChain = new StandardSolanaRuntimeChainProvider(observer);
      const researchObserver = new StandardSolanaObserver({
        httpUrl: profile.solanaHttpUrl,
        wsUrl: profile.solanaWsUrl,
        solPriceUsdResolver: async (at) => this.resolveSelfHostedSolPriceUsd(at),
        onError: (error) => this.recordError("research_solana_stream", error),
        onRejectedSwap: (rejection) => this.queueResearchProviderRejectedSwap(rejection),
        onTokenDecrease: (observation) => this.queueResearchTokenDecrease(observation),
        onRequest
      });
      selfHostedResearchChain = new StandardSolanaRuntimeChainProvider(researchObserver);
      // SHADOW must exercise the local program/history index as well as the
      // live observer. Otherwise successful shadow evidence could still have
      // been produced by Helius-backed history and would not prove provider
      // independence.
      indexRpc = selfHostedRpc;
    }
    if (profile.mode === "SELF_HOSTED") {
      if (!profile.solanaHttpUrl || !selfHostedChain || !selfHostedRpc) {
        throw new Error("Self-hosted provider composition is incomplete.");
      }
      chain = selfHostedChain;
      researchChain = selfHostedResearchChain!;
      this.balanceReader = new SolanaRpcBalanceReader(profile.solanaHttpUrl, {
        onRequest: () => this.repository.incrementUsage("solana_rpc")
      });
      this.executionRpc = selfHostedRpc;
    } else {
      if (!managed) throw new Error("Managed provider composition is incomplete.");
      const managedChain: RuntimeChainProvider = new HeliusObserver(managed.heliusApiKey, {
        // Monitoring repair, provider history, identity, and live hydration
        // share one observer. Serialize their HTTP starts so a three-wallet
        // repair cannot burst past the managed free-tier allowance.
        requestsPerSecond: 1,
        fetch: managedFetch!,
        onError: (error) => this.recordError("helius_stream", error),
        onRequest: ({ credits }) => this.reserveHeliusProviderCredits(credits),
        onRejectedSwap: (rejection) => this.queueProviderRejectedSwap(rejection)
      });
      // The strict Helius observer permits one active wallet subscription.
      // A second, deliberately slower observer keeps experimental enrollment,
      // reconnects, and repair failures outside the strict trading head.
      researchChain = new HeliusObserver(managed.heliusApiKey, {
        requestsPerSecond: 0.5,
        fetch: managedFetch!,
        onError: (error) => this.recordError("research_helius_stream", error),
        onRequest: ({ credits }) => this.reserveHeliusProviderCredits(credits),
        onRejectedSwap: (rejection) => this.queueResearchProviderRejectedSwap(rejection),
        onTokenDecrease: (observation) => this.queueResearchTokenDecrease(observation)
      });
      chain = profile.mode === "SHADOW" && selfHostedChain
        ? new ShadowChainProvider(
            managedChain,
            selfHostedChain,
            paritySink,
            { onError: (error) => this.recordError("chain_parity", error) }
          )
        : managedChain;
      this.balanceReader = new HeliusBalanceReader(managed.heliusApiKey, {
        fetch: managedFetch!,
        onRequest: () => this.reserveHeliusProviderCredits(1)
      });
      this.executionRpc = new HeliusRpcClient(managed.heliusApiKey, {
        fetch: managedFetch!,
        onRequest: ({ credits }) => this.repository.incrementUsage("helius", credits)
      });
    }
    this.providers = {
      discovery,
      chain,
      researchChain,
      token,
      market,
      swap,
      quotes
    };
    this.managedRecoveryPreflight = profile.mode === "MANAGED"
      ? new ManagedRecoveryPreflightCoordinator(this.repository, discovery, chain, {
          canRun: () => this.canRunManagedRecoveryPreflight(configuredGeneration),
          canSpendBirdeye: () => this.canSpendManagedRecoveryBirdeyeStep(),
          canSpendHelius: () => this.canSpendManagedRecoveryHeliusHistory()
        })
      : undefined;
    this.walletAcquisition = profile.mode === "MANAGED"
      ? new WalletAcquisitionController(this.repository)
      : undefined;
    this.walletIndexer = new WalletIndexWorker(
      this.repository,
      profile.mode === "SELF_HOSTED" ? "" : managed?.heliusApiKey ?? "",
      this.events,
      {
        ...(indexRpc ? { rpc: indexRpc } : {}),
        // Helius' managed free tier is shared by wallet history, confirmed
        // monitoring, health checks, and isolated repair work. Six requests
        // here plus one repair request leaves headroom for those control-plane
        // calls and avoids the 429/backoff cycle that is slower in practice.
        requestsPerSecond: profile.mode === "MANAGED" ? 6 : 8,
        ...(managedFetch ? { fetch: managedFetch } : {}),
        ...(this.walletAcquisition
          ? {
              getTargetWallets: () => this.walletAcquisition?.targetWallets() ?? 5_000,
              canDiscoverPage: () => this.walletAcquisition?.canDiscoverPage() ?? false,
              onAcquisitionPipelineDrained: (sourceExhausted: boolean) =>
                this.walletAcquisition?.onPipelineDrained(sourceExhausted) ?? false
            }
          : {}),
        enforceManagedCreditBudget: profile.mode === "MANAGED",
        // Managed PAPER entries are guarded by each frozen leader's repaired,
        // acknowledged wallet stream. Keep historical program discovery, but
        // do not spend free-tier quota on an unrelated perpetual DEX head.
        programHeadMaintenanceEnabled: profile.mode !== "MANAGED",
        // Shadow/self-hosted diagnostics retain a bounded five-minute global
        // head cadence; MANAGED skips this maintenance path entirely.
        headSyncIntervalMs: 5 * 60_000,
        // Work through the already activity-proven backlog in immutable
        // 100-wallet cohorts. Provider scoring is paced one completed cohort
        // at a time and stops once the forward PAPER set exists.
        deepHistoryIncludeExistingBacklog: true,
        deepHistoryAllowUnpricedStructuralCompletion: profile.mode === "MANAGED",
        deepHistoryCanStartNextCohort: () =>
          !this.repository.activePaperEvaluationCohort() &&
          (this.walletAcquisition?.shouldContinueResearch() ?? true) &&
          !this.repository.hasPendingWalletResearchHandoffs(),
        deepHistoryCanStartManagedRecovery: () => {
          const acquisition = this.walletAcquisition?.snapshot();
          return acquisition !== undefined &&
            acquisition.targetWallets === acquisition.maximumWallets &&
            this.repository.walletIndexCoverage().indexedWallets >= acquisition.maximumWallets;
        },
        ...(profile.mode === "MANAGED"
          ? {
              deepHistoryManagedRecoveryPreflightGate: () => {
                const at = new Date();
                const window = managedRecoveryPreflightWindow(at);
                return {
                  policyVersion: window.policyVersion,
                  windowStart: window.windowStart,
                  validAt: at.toISOString()
                };
              },
              runManagedRecoveryPreflight: () =>
                this.runManagedRecoveryPreflightStep(configuredGeneration)
            }
          : {}),
        // A global managed-program gap can contain millions of signatures.
        // Before any paper cohort or bot exposure exists, quarantine that
        // historical discontinuity and prove a fresh forward-only epoch. Once
        // paper evidence exists, reseeding is forbidden and safety stays held.
        allowHeadEpochReseed: () =>
          this.repository.activePaperEvaluationCohort() === undefined &&
          this.repository.listPositions("PAPER", true).length === 0 &&
          this.repository.listPositions("LIVE", true).length === 0,
        identityEvidenceEnabled: profile.mode !== "MANAGED",
        identityFirstPoolResolver: (mint, now) => token.checkToken(mint, now),
        solPriceUsdResolver: (at) => this.resolveSelfHostedSolPriceUsd(at),
        onResearchReady: () => {
          if (!this.isProviderWorkCurrent(configuredGeneration)) return;
          void this.processResearchHandoffs(configuredGeneration).catch((error) =>
            this.recordProviderWorkError("wallet_research_handoff", error)
          );
        }
      }
    );
    this.parsedBlockRepairRepository = new ParsedBlockRepairRepository(this.repository);
    this.parsedBlockRepairRepository.ensureKnownAffectedManifest();
    const activeRepair = this.parsedBlockRepairRepository.activeManifest();
    if (activeRepair) {
      const repairPrograms = new Set(this.parsedBlockRepairRepository.manifestPrograms(activeRepair.id));
      if (repairPrograms.size === 0) {
        throw new Error("The active parsed-block repair manifest has no frozen program sources.");
      }
      const parsedBlockRepairRpc = indexRpc ?? new HeliusRpcClient(managed?.heliusApiKey ?? "", {
        // Keep background historical repair well below the exact-wallet
        // funnel. It still advances continuously, while the shared account
        // pacer gives current candidate evidence and monitoring priority.
        requestsPerSecond: 0.25,
        ...(managedFetch ? { fetch: managedFetch } : {}),
        onRequest: ({ credits }) => this.reserveHeliusProviderCredits(credits)
      });
      this.parsedBlockRepairWorker = new ParsedBlockRepairWorker(
        this.parsedBlockRepairRepository,
        this.events,
        {
          rpc: parsedBlockRepairRpc,
          programIds: repairPrograms,
          solPriceUsdResolver: (at) => this.resolveSelfHostedSolPriceUsd(at)
        }
      );
      this.repository.audit(
        "parsed_block_repair_runtime_configured",
        "The runtime found a frozen parsed-block repair manifest and will resume its isolated queue.",
        this.parsedBlockRepairRepository.coverage(activeRepair.id)
      );
    } else {
      delete this.parsedBlockRepairWorker;
    }
    this.liveBroker = new LiveBrokerOrchestrator({
      signer: this.signer,
      executor: quotes,
      getMode: () => (this.emergencyActive ? "PAUSED" : this.modes.mode),
      allowedPrograms: [...DEFAULT_ALLOWED_PROGRAMS, JUPITER_V6_PROGRAM_ID],
      allowedRoutePrograms: PERMITTED_JUPITER_ROUTE_PROGRAMS,
      maximumFeeLamports: 1_000_000,
      refreshOrder: (order) => this.refreshBrokerOrder(order),
      revalidate: (order) => this.revalidateOrder(order),
      deriveSignature: signedTransactionSignature,
      onUpdate: (record) => this.persistExecutionOutcome(record)
    });
  }

  private requireProviders(): Providers {
    if (!this.providers) throw new Error("Providers are not configured.");
    return this.providers;
  }

  private executionMode(): "PAPER" | "LIVE" {
    const mode = this.modes.mode === "PAUSED" ? this.modes.pausedFrom : this.modes.mode;
    return mode === "MANUAL_LIVE" || mode === "AUTO_LIVE" || mode === "LOCKED" ? "LIVE" : "PAPER";
  }

  private recordSourceOutcome(
    swap: LeaderSwap,
    status: SignalOutcomeStatus,
    reasonCode: SignalOutcomeReasonCode,
    reason: string,
    action: SignalOutcomeAction = swap.side
  ): SignalAuditRecord {
    const idempotencyKey = createIdempotencyKey({
      sourceSignature: swap.sourceSignature,
      sourceWallet: swap.sourceWallet,
      mint: swap.targetMint,
      action
    });
    const outcome: SignalAuditRecord = {
      id: idempotencyKey,
      idempotencyKey,
      sourceSignature: swap.sourceSignature,
      sourceWallet: swap.sourceWallet,
      mint: swap.targetMint,
      action,
      mode: this.executionMode(),
      status,
      reasonCode,
      reason: redactSensitiveText(reason, 1_000),
      sourceBlockTime: swap.blockTime,
      observedAt: swap.detectedAt,
      updatedAt: new Date().toISOString()
    };
    this.repository.upsertSignalOutcome(outcome);
    this.events.publish("signal-outcome", {
      idempotencyKey,
      status: outcome.status,
      reasonCode: outcome.reasonCode
    });
    return outcome;
  }

  private queueProviderRejectedSwap(rejection: RejectedSwapObservation): Promise<void> {
    const task = this.signalTail.then(() => this.persistProviderRejectedSwap(rejection));
    this.signalTail = task.catch((error) => {
      this.recordError("rejected_signal_persistence", error, {
        signature: rejection.action.sourceSignature
      });
    });
    return task;
  }

  /**
   * Rejections emitted by the research observer bypass the strict source and
   * signal ledgers completely. The research engine owns its own durable claim
   * and quote-only ledger, and also rechecks exact PAPER mode before commit.
   */
  private queueResearchProviderRejectedSwap(rejection: RejectedSwapObservation): Promise<void> {
    return this.enqueueResearchProviderAction({
      source: rejection.researchAction.source,
      baseAmountAtomic: rejection.researchAction.baseAmountAtomic,
      targetAmountAtomic: rejection.researchAction.targetAmountAtomic,
      baseAmountUi: rejection.researchAction.baseAmountUi,
      targetAmountUi: rejection.researchAction.targetAmountUi,
      strictReasonCodes: ["RESEARCH_WATCHLIST_UNSUPPORTED_ROUTE"]
    });
  }

  private queueResearchTokenDecrease(
    observation: WalletTokenDecreaseObservation
  ): Promise<void> {
    return this.enqueueResearchProviderAction({
      source: {
        sourceSignature: observation.signature,
        sourceWallet: observation.wallet,
        slot: observation.slot,
        blockTime: observation.blockTime,
        detectedAt: observation.detectedAt,
        side: "SELL",
        // Inventory-decrease evidence deliberately has no trusted proceeds
        // leg. USDC is only a non-executable placeholder for the research
        // source shape; the engine uses the target decrease and a fresh quote.
        baseMint: USDC_MINT,
        targetMint: observation.mint,
        recovered: observation.recovered
      },
      baseAmountAtomic: "0",
      targetAmountAtomic: observation.amountAtomic,
      baseAmountUi: 0,
      targetAmountUi: observation.amountUi,
      strictReasonCodes: ["LEADER_TOKEN_BALANCE_DECREASE"]
    });
  }

  private persistProviderRejectedSwap(rejection: RejectedSwapObservation): void {
    const action = rejection.action;
    const idempotencyKey = createIdempotencyKey({
      sourceSignature: action.sourceSignature,
      sourceWallet: action.sourceWallet,
      mint: action.targetMint,
      action: action.side
    });
    const outcome: SignalAuditRecord = {
      id: idempotencyKey,
      idempotencyKey,
      sourceSignature: action.sourceSignature,
      sourceWallet: action.sourceWallet,
      mint: action.targetMint,
      action: action.side,
      mode: this.executionMode(),
      status: "REJECTED",
      reasonCode: "UNSUPPORTED_PROGRAM_ACTIVITY",
      reason: redactSensitiveText(rejection.reason, 1_000),
      sourceBlockTime: action.blockTime,
      observedAt: action.detectedAt,
      updatedAt: new Date().toISOString()
    };
    const created = this.repository.persistRejectedSourceOutcome(action, outcome);
    if (created) {
      this.events.publish("signal-outcome", {
        idempotencyKey,
        status: outcome.status,
        reasonCode: outcome.reasonCode
      });
      this.repository.audit(
        "signal_decoder_rejected",
        "Swap-like source activity was retained as a rejected outcome and was not copied.",
        {
          wallet: action.sourceWallet,
          signature: action.sourceSignature,
          action: action.side,
          reasonCode: outcome.reasonCode,
          recovered: action.recovered
        }
      );
    }
    this.queueResearchPaperAction({
      source: rejection.researchAction.source,
      baseAmountAtomic: rejection.researchAction.baseAmountAtomic,
      targetAmountAtomic: rejection.researchAction.targetAmountAtomic,
      baseAmountUi: rejection.researchAction.baseAmountUi,
      targetAmountUi: rejection.researchAction.targetAmountUi,
      strictReasonCodes: ["UNSUPPORTED_PROGRAM_ACTIVITY"]
    });
  }

  private researchActionFromLeaderSwap(swap: LeaderSwap): ResearchPaperSourceAction {
    const source: RejectedSourceAction = {
      sourceSignature: swap.sourceSignature,
      sourceWallet: swap.sourceWallet,
      slot: swap.slot,
      blockTime: swap.blockTime,
      detectedAt: swap.detectedAt,
      side: swap.side,
      baseMint: swap.baseMint,
      targetMint: swap.targetMint,
      recovered: swap.recovered
    };
    return {
      source,
      baseAmountAtomic: swap.baseAmountAtomic,
      targetAmountAtomic: swap.targetAmountAtomic,
      baseAmountUi: swap.baseAmountUi,
      targetAmountUi: swap.targetAmountUi,
      strictReasonCodes: ["STRICT_PATH_EVALUATED_SEPARATELY"]
    };
  }

  private queueResearchPaperAction(action: ResearchPaperSourceAction): void {
    if (this.modes.mode !== "PAPER" || !this.repository.activeResearchPaperLane()) return;
    const task = this.trackProviderWork(this.researchPaper.enqueue(action));
    void task.catch(() => undefined);
  }

  private enqueueResearchProviderAction(action: ResearchPaperSourceAction): Promise<void> {
    const lane = this.repository.activeResearchPaperLane();
    if (
      this.modes.mode !== "PAPER" ||
      !lane ||
      !this.researchMonitoringWallets.has(action.source.sourceWallet) ||
      !this.repository.getResearchPaperLeader(lane.id, action.source.sourceWallet)
    ) return Promise.resolve();
    return this.trackProviderWork(this.researchPaper.enqueue(action)).then(() => {
      if (!action.source.recovered) {
        this.advanceResearchMonitoringCursor(lane.id, action.source.sourceWallet, action.source.blockTime);
      }
    });
  }

  private queueResearchPaperMarks(dedupeNonce?: string): void {
    if (this.modes.mode !== "PAPER" || !this.providers || !this.repository.activeResearchPaperLane()) return;
    const task = this.trackProviderWork(this.researchPaper.enqueueMarks(dedupeNonce));
    void task.catch(() => undefined);
  }

  private queueAutonomousPaperCycle(): void {
    if (
      this.modes.mode !== "PAPER" ||
      !this.providers ||
      this.providerWorkQuiesced ||
      !this.repository.activeAutonomousPaperLane()
    ) return;
    const task = this.trackProviderWork(this.autonomousPaper.enqueueCycle());
    // The engine reports failures through its redacting onError callback.
    void task.catch(() => undefined);
  }

  private alpacaCredentials(): AlpacaPaperCredentials | undefined {
    if (!this.vault.hasAlpacaPaperCredentials()) return undefined;
    try {
      return this.vault.getAlpacaPaperCredentials();
    } catch (error) {
      this.recordError("alpaca_paper_vault", error);
      return undefined;
    }
  }

  private queueStockPaperCycle(): void {
    if (
      this.modes.mode !== "PAPER" ||
      this.stopping ||
      !this.vault.hasAlpacaPaperCredentials()
    ) return;
    void this.stockPaper.enqueueCycle().catch(() => undefined);
  }

  private queueAutonomousLearningCycle(): void {
    if (
      this.modes.mode !== "PAPER" ||
      !this.providers ||
      this.providerWorkQuiesced ||
      !this.repository.activeAutonomousPaperLane()
    ) return;
    const task = this.trackProviderWork(this.autonomousLearning.enqueueProcess());
    void task.catch(() => undefined);
  }

  autonomousLearningOverview(): AutonomousLearningOverview {
    return this.autonomousLearning.overview();
  }

  trainAutonomousLearning(): Promise<AutonomousLearningOverview> {
    if (this.modes.mode !== "PAPER") {
      throw new Error("Autonomous learning can train only in exact PAPER mode.");
    }
    return this.autonomousLearning.train(true);
  }

  promoteAutonomousChallenger(confirmation: string): ChampionPromotionDecision {
    if (this.modes.mode !== "PAPER") {
      throw new Error("Autonomous challenger promotion can occur only in exact PAPER mode.");
    }
    const lane = this.repository.activeAutonomousPaperLane();
    if (!lane) throw new Error("An active autonomous PAPER lane is required.");
    const account = this.repository.getAutonomousPaperAccount(lane.id);
    if (!account || account.openPositions > 0 || Math.abs(account.deployedUsd) > 0.02) {
      throw new Error("Autonomous challenger promotion requires a flat isolated account.");
    }
    return this.autonomousLearning.requestPromotion(confirmation);
  }

  private saveSignalDecision(
    intent: CopyIntent,
    token: TokenEligibility | undefined,
    decision: RiskDecision,
    action: SignalOutcomeAction = intent.side,
    reasonCode: SignalOutcomeReasonCode = decision.allowed ? "RISK_ALLOWED" : "RISK_REJECTED"
  ): void {
    this.repository.saveDecision(
      randomUUID(),
      intent,
      token,
      decision,
      this.executionMode(),
      action,
      reasonCode
    );
    this.events.publish("signal-outcome", {
      idempotencyKey: intent.idempotencyKey,
      status: decision.allowed ? "QUEUED" : "REJECTED",
      reasonCode
    });
  }

  private persistExecutionOutcome(record: ExecutionRecord): void {
    this.repository.upsertExecution(record);
    this.events.publish("signal-outcome", {
      idempotencyKey: record.idempotencyKey,
      status: this.repository.getSignalOutcome(record.idempotencyKey)?.status ?? record.status
    });
  }

  private subscribeResearchWallets(expectedGeneration = this.providerWorkGeneration): Promise<void> {
    if (!this.isProviderWorkCurrent(expectedGeneration)) return Promise.resolve();
    const task = this.researchSubscriptionTail.then(() =>
      this.performSubscribeResearchWallets(expectedGeneration)
    );
    this.researchSubscriptionTail = task.catch(() => undefined);
    return task;
  }

  private async performSubscribeResearchWallets(expectedGeneration: number): Promise<void> {
    await this.researchUnsubscribe?.();
    this.researchUnsubscribe = undefined;
    this.researchMonitoringWallets.clear();
    if (
      !this.isProviderWorkCurrent(expectedGeneration) ||
      !this.providers ||
      this.modes.mode !== "PAPER"
    ) return;
    const lane = this.repository.activeResearchPaperLane();
    if (!lane) return;

    // The repository owns enrollment and its evidence gate. It returns fewer
    // than the requested target when fewer wallets prove recent trading; the
    // runtime must never fill the difference with passive holders.
    const addresses = this.repository.listResearchPaperWatchlistWallets(
      lane.id,
      { researchOnly: true }
    );
    if (addresses.length === 0) {
      this.repository.audit(
        "research_monitoring_waiting",
        "The research-only stream is waiting for activity-gated wallet enrollments.",
        { laneId: lane.id }
      );
      return;
    }
    this.repository.initializeResearchPaperLeaders(addresses, lane.id);
    for (const address of addresses) this.researchMonitoringWallets.add(address);

    // Freeze every forward-only cursor before opening the socket, then open
    // the socket before doing serialized HTTP repair. This overlap closes the
    // otherwise-uncovered interval between the first wallet's repair and a
    // later multi-wallet subscription acknowledgement. Recovered events are
    // analysis-only and durable event keys absorb the overlap duplicates.
    const enrolledAt = new Date().toISOString();
    for (const address of addresses) {
      this.repository.ensureResearchPaperMonitoringCheckpoint(
        lane.id,
        address,
        enrolledAt,
        enrolledAt
      );
    }

    try {
      const unsubscribe = await this.providers.researchChain.subscribe(
        addresses,
        async (swap) => {
          if (!this.isResearchMonitoringCurrent(expectedGeneration, lane.id)) return;
          await this.enqueueResearchProviderAction(this.researchActionFromLeaderSwap(swap));
        }
      );
      if (!this.isResearchMonitoringCurrent(expectedGeneration, lane.id)) {
        await unsubscribe();
        return;
      }
      this.researchUnsubscribe = unsubscribe;
    } catch (error) {
      if (!this.isProviderWorkCurrent(expectedGeneration)) return;
      const failedAt = new Date();
      for (const address of addresses) {
        const checkpoint = this.repository.getResearchPaperMonitoringCheckpoint(lane.id, address);
        if (!checkpoint) continue;
        this.repository.failResearchPaperMonitoringRepair(
          lane.id,
          address,
          checkpoint.cursorAt,
          new Date(failedAt.getTime() + this.monitoringRepairRetryDelay(checkpoint)).toISOString(),
          "The isolated research wallet subscription failed.",
          failedAt.toISOString()
        );
      }
      this.recordError("research_monitoring_subscribe", error, {
        wallets: addresses.length
      });
      this.scheduleResearchMonitoringRetry();
      return;
    }

    const repairedAddresses: string[] = [];
    for (const address of addresses) {
      if (!this.isResearchMonitoringCurrent(expectedGeneration, lane.id)) return;
      if (await this.repairResearchMonitoringWallet(lane.id, address)) {
        repairedAddresses.push(address);
      }
    }
    if (!this.isResearchMonitoringCurrent(expectedGeneration, lane.id)) return;

    if (this.researchMonitoringRetryTimer) clearTimeout(this.researchMonitoringRetryTimer);
    this.researchMonitoringRetryTimer = undefined;
    const failed = addresses.length - repairedAddresses.length;
    this.repository.audit(
      "research_monitoring_started",
      "The isolated activity-gated high-risk PAPER wallet stream started.",
      {
        laneId: lane.id,
        enrolled: addresses.length,
        subscribed: addresses.length,
        repairFailures: failed,
        strictOverlap: 0,
        signingEnabled: false,
        promotionEligible: false
      }
    );
    if (failed > 0) this.scheduleResearchMonitoringRetry();
  }

  private isResearchMonitoringCurrent(expectedGeneration: number, laneId: string): boolean {
    return this.isProviderWorkCurrent(expectedGeneration) &&
      this.modes.mode === "PAPER" &&
      this.repository.activeResearchPaperLane()?.id === laneId;
  }

  private async repairResearchMonitoringWallet(laneId: string, address: string): Promise<boolean> {
    const startedAt = new Date();
    const checkpoint = this.repository.ensureResearchPaperMonitoringCheckpoint(
      laneId,
      address,
      startedAt.toISOString(),
      startedAt.toISOString()
    );
    if (!this.repository.startResearchPaperMonitoringRepair(
      laneId,
      address,
      checkpoint.cursorAt,
      startedAt.toISOString()
    )) {
      throw new Error("The research monitoring checkpoint changed concurrently.");
    }
    try {
      const recovered = await this.requireProviders().researchChain.repairGap(address, checkpoint.cursorAt);
      for (const swap of [...recovered].sort((left, right) =>
        Date.parse(left.blockTime) - Date.parse(right.blockTime) ||
        left.sourceSignature.localeCompare(right.sourceSignature)
      )) {
        if (swap.sourceWallet !== address) {
          throw new Error("Research gap repair returned an event for the wrong wallet.");
        }
        const action = this.researchActionFromLeaderSwap(swap);
        await this.enqueueResearchProviderAction({
          ...action,
          source: { ...action.source, recovered: true }
        });
      }
      const completedAt = new Date().toISOString();
      if (!this.repository.completeResearchPaperMonitoringRepair(
        laneId,
        address,
        checkpoint.cursorAt,
        startedAt.toISOString(),
        completedAt
      )) throw new Error("The research monitoring repair cursor changed concurrently.");
      return true;
    } catch (error) {
      const failedAt = new Date();
      const current = this.repository.getResearchPaperMonitoringCheckpoint(laneId, address) ?? checkpoint;
      this.repository.failResearchPaperMonitoringRepair(
        laneId,
        address,
        checkpoint.cursorAt,
        new Date(failedAt.getTime() + this.monitoringRepairRetryDelay(current)).toISOString(),
        "Isolated research history repair failed.",
        failedAt.toISOString()
      );
      this.recordError("research_monitoring_gap_repair", error, { laneId });
      return false;
    }
  }

  private advanceResearchMonitoringCursor(laneId: string, wallet: string, nextCursorAt: string): void {
    if (!Number.isFinite(Date.parse(nextCursorAt))) return;
    this.repository.advanceResearchPaperMonitoringCursor(
      laneId,
      wallet,
      new Date(nextCursorAt).toISOString()
    );
  }

  private scheduleResearchMonitoringRetry(): void {
    if (
      this.stopping ||
      this.providerWorkQuiesced ||
      this.researchMonitoringRetryTimer ||
      this.modes.mode !== "PAPER"
    ) return;
    const lane = this.repository.activeResearchPaperLane();
    if (!lane) return;
    const pending = this.repository.listResearchPaperMonitoringCheckpoints(lane.id)
      .filter((checkpoint) => checkpoint.status !== "READY");
    const earliest = pending.reduce((value, checkpoint) => {
      const retryAt = checkpoint.nextRetryAt ? Date.parse(checkpoint.nextRetryAt) : Date.now();
      return Math.min(value, Number.isFinite(retryAt) ? retryAt : Date.now());
    }, Number.POSITIVE_INFINITY);
    const delay = Number.isFinite(earliest)
      ? Math.max(0, earliest - Date.now())
      : MONITORING_REPAIR_BASE_RETRY_MS;
    this.researchMonitoringRetryTimer = setTimeout(() => {
      this.researchMonitoringRetryTimer = undefined;
      const generation = this.providerWorkGeneration;
      void this.subscribeResearchWallets(generation).catch((error) =>
        this.recordProviderWorkError("research_monitoring_retry", error)
      );
    }, delay);
  }

  private async stopResearchMonitoring(): Promise<void> {
    if (this.researchMonitoringRetryTimer) clearTimeout(this.researchMonitoringRetryTimer);
    this.researchMonitoringRetryTimer = undefined;
    this.researchMonitoringWallets.clear();
    await this.researchSubscriptionTail.catch(() => undefined);
    const unsubscribe = this.researchUnsubscribe;
    this.researchUnsubscribe = undefined;
    await unsubscribe?.();
  }

  private subscribeActiveWallets(expectedGeneration = this.providerWorkGeneration): Promise<void> {
    if (!this.isProviderWorkCurrent(expectedGeneration)) return Promise.resolve();
    const task = this.monitoringSubscriptionTail.then(() =>
      this.performSubscribeActiveWallets(expectedGeneration)
    );
    this.monitoringSubscriptionTail = task.catch(() => undefined);
    return task;
  }

  private async performSubscribeActiveWallets(expectedGeneration: number): Promise<void> {
    if (
      !this.isProviderWorkCurrent(expectedGeneration) ||
      !this.providers ||
      ["SETUP", "LOCKED"].includes(this.modes.mode)
    ) return;
    await this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.assertProviderWorkCurrent(expectedGeneration);
    const monitoring = this.monitoringWallets();
    if (!monitoring) return;
    const { cohortId, activeAddresses, shadowAddresses, addresses } = monitoring;
    if (addresses.length === 0) {
      this.repository.audit("monitoring_waiting", "No wallets passed qualification; monitoring remains idle.", {
        cohortId
      }, "warning");
      await this.evaluateStops();
      return;
    }

    const requiredAddresses = activeAddresses.length > 0 ? activeAddresses : addresses;
    const requiredSet = new Set(requiredAddresses);
    this.pauseForMonitoringRepair(requiredAddresses);
    let requiredRepaired = true;
    const repairedAddresses: string[] = [];
    for (const address of addresses) {
      if (await this.repairMonitoringWallet(address)) repairedAddresses.push(address);
      else if (requiredSet.has(address)) requiredRepaired = false;
      this.assertProviderWorkCurrent(expectedGeneration);
    }
    if (!requiredRepaired || !this.isProviderWorkCurrent(expectedGeneration)) {
      if (this.isProviderWorkCurrent(expectedGeneration)) this.scheduleMonitoringRepairRetry();
      return;
    }

    try {
      const chain = this.providers.chain;
      const unsubscribe = await chain.subscribe(repairedAddresses, async (swap) => {
        if (!this.isProviderWorkCurrent(expectedGeneration)) return;
        const task = this.signalTail.then(() => this.handleSwap(swap));
        this.signalTail = task.catch((error) => {
          this.recordError("signal_processing", error, { signature: swap.sourceSignature });
        });
        await task;
      });
      if (!this.isProviderWorkCurrent(expectedGeneration)) {
        await unsubscribe();
        throw new ProviderWorkSupersededError();
      }
      this.unsubscribe = unsubscribe;
    } catch (error) {
      if (error instanceof ProviderWorkSupersededError) return;
      this.assertProviderWorkCurrent(expectedGeneration);
      const now = new Date();
      for (const address of repairedAddresses) {
        const checkpoint = this.repository.getMonitoringRepairCheckpoint(address);
        if (!checkpoint) continue;
        const nextRetryAt = new Date(now.getTime() + this.monitoringRepairRetryDelay(checkpoint));
        this.repository.failMonitoringRepair(
          address,
          checkpoint.cursorAt,
          nextRetryAt.toISOString(),
          "Confirmed wallet stream subscription failed closed.",
          now.toISOString()
        );
      }
      this.pauseForMonitoringRepair(requiredAddresses);
      this.recordError("monitoring_subscribe", error, { wallets: repairedAddresses.length });
      this.scheduleMonitoringRepairRetry();
      return;
    }

    if (this.monitoringRepairRetryTimer) clearTimeout(this.monitoringRepairRetryTimer);
    this.monitoringRepairRetryTimer = undefined;
    await this.evaluateStops();
    this.repository.audit("monitoring_started", "Confirmed wallet monitoring started.", {
      activeAddresses,
      shadowAddresses: shadowAddresses.filter((address) => repairedAddresses.includes(address))
    });
  }

  private monitoringWallets(): {
    cohortId: string;
    activeAddresses: string[];
    shadowAddresses: string[];
    addresses: string[];
  } | undefined {
    const cohort = this.repository.latestCohort();
    if (!cohort) return undefined;
    const activeAddresses = this.repository.activePaperEvaluationCohort()?.wallets ?? [];
    const activeSet = new Set(activeAddresses);
    const qualified = new Set(
      this.repository.listWalletScores(cohort.cohortId)
        .filter((score) => score.qualified)
        .map((score) => score.wallet)
    );
    const shadowAddresses = this.repository
      .listCandidates(cohort.cohortId)
      .filter((candidate) => !candidate.control && !activeSet.has(candidate.address) && qualified.has(candidate.address))
      .slice(0, PAPER_WALLET_COUNT)
      .map((candidate) => candidate.address);
    return {
      cohortId: cohort.cohortId,
      activeAddresses,
      shadowAddresses,
      addresses: [...new Set([...activeAddresses, ...shadowAddresses])]
    };
  }

  private monitoringRepairSeed(address: string, now: Date): string {
    const candidates = [
      this.repository.latestSourceBlockTime(address),
      this.repository.getSetting<string>(`monitoring_since:${address}`)
    ];
    for (const candidate of candidates) {
      if (candidate && Number.isFinite(Date.parse(candidate))) return new Date(candidate).toISOString();
    }
    return now.toISOString();
  }

  private async repairMonitoringWallet(address: string): Promise<boolean> {
    const startedAt = new Date();
    const checkpoint = this.repository.ensureMonitoringRepairCheckpoint(
      address,
      this.monitoringRepairSeed(address, startedAt),
      startedAt.toISOString()
    );
    if (!this.repository.startMonitoringRepair(address, checkpoint.cursorAt, startedAt.toISOString())) {
      throw new Error(`Monitoring repair checkpoint changed concurrently for ${address}`);
    }
    try {
      const recovered = await this.requireProviders().chain.repairGap(address, checkpoint.cursorAt);
      for (const swap of [...recovered].sort((left, right) =>
        Date.parse(left.blockTime) - Date.parse(right.blockTime)
        || left.sourceSignature.localeCompare(right.sourceSignature)
      )) {
        if (swap.sourceWallet !== address) {
          throw new Error("Gap repair returned a source event for the wrong wallet; operation fails closed");
        }
        await this.handleSwap({ ...swap, recovered: true });
      }
      const completedAt = new Date();
      if (!this.repository.completeMonitoringRepair(
        address,
        checkpoint.cursorAt,
        startedAt.toISOString(),
        completedAt.toISOString()
      )) {
        throw new Error(`Monitoring repair cursor changed concurrently for ${address}`);
      }
      this.repository.audit("monitoring_gap_repaired", "Confirmed wallet history repair completed.", {
        wallet: address,
        from: checkpoint.cursorAt,
        through: startedAt.toISOString(),
        recovered: recovered.length
      });
      return true;
    } catch (error) {
      const failedAt = new Date();
      const current = this.repository.getMonitoringRepairCheckpoint(address) ?? checkpoint;
      const nextRetryAt = new Date(failedAt.getTime() + this.monitoringRepairRetryDelay(current));
      this.repository.failMonitoringRepair(
        address,
        checkpoint.cursorAt,
        nextRetryAt.toISOString(),
        "Confirmed history repair failed closed.",
        failedAt.toISOString()
      );
      this.recordError("startup_gap_repair", error, { wallet: address, cursorAt: checkpoint.cursorAt });
      return false;
    }
  }

  private monitoringRepairRetryDelay(checkpoint: MonitoringRepairCheckpoint): number {
    return Math.min(
      MONITORING_REPAIR_MAXIMUM_RETRY_MS,
      MONITORING_REPAIR_BASE_RETRY_MS * 2 ** Math.min(4, checkpoint.failureCount)
    );
  }

  private monitoringRepairPending(): boolean {
    const monitoring = this.monitoringWallets();
    const activeAddresses = this.repository.activePaperEvaluationCohort()?.wallets ?? [];
    const requiredAddresses = activeAddresses.length > 0 ? activeAddresses : monitoring?.addresses ?? [];
    return requiredAddresses.some(
      (address) => this.repository.getMonitoringRepairCheckpoint(address)?.status !== "READY"
    );
  }

  private pauseForMonitoringRepair(addresses: readonly string[]): void {
    const previous = this.operationalPauseState();
    const reasons: OperationalPauseReason[] = [...previous.reasons];
    if (!reasons.includes("HISTORY_GAP_REPAIR")) reasons.push("HISTORY_GAP_REPAIR");
    this.persistOperationalPause(reasons, false, { wallets: [...addresses] });
  }

  private scheduleMonitoringRepairRetry(): void {
    if (this.stopping || this.providerWorkQuiesced || this.monitoringRepairRetryTimer) return;
    const monitoring = this.monitoringWallets();
    const activeAddresses = this.repository.activePaperEvaluationCohort()?.wallets ?? [];
    const requiredAddresses = activeAddresses.length > 0 ? activeAddresses : monitoring?.addresses ?? [];
    const pending = requiredAddresses
      .map((address) => this.repository.getMonitoringRepairCheckpoint(address))
      .filter((checkpoint): checkpoint is MonitoringRepairCheckpoint => checkpoint?.status !== "READY");
    const earliest = pending.reduce((value, checkpoint) => {
      const retryAt = checkpoint.nextRetryAt ? Date.parse(checkpoint.nextRetryAt) : Date.now();
      return Math.min(value, Number.isFinite(retryAt) ? retryAt : Date.now());
    }, Number.POSITIVE_INFINITY);
    const delay = Number.isFinite(earliest) ? Math.max(0, earliest - Date.now()) : MONITORING_REPAIR_BASE_RETRY_MS;
    this.monitoringRepairRetryTimer = setTimeout(() => {
      this.monitoringRepairRetryTimer = undefined;
      const generation = this.providerWorkGeneration;
      void this.subscribeActiveWallets(generation).catch((error) =>
        this.recordProviderWorkError("monitoring_retry", error)
      );
    }, delay);
  }

  private reconcileForwardPaperSelection(sourceCohortId: string): string[] {
    const frozenEvaluation = this.repository.activePaperEvaluationCohort();
    if (frozenEvaluation) {
      // Weekly discovery can refresh research around the cohort, but the
      // frozen forward set itself never rotates automatically.
      this.repository.setActiveWallets(sourceCohortId, frozenEvaluation.wallets);
      return frozenEvaluation.wallets;
    }

    const scores = new Map(
      this.repository.listWalletScores(sourceCohortId).map((score) => [score.wallet, score])
    );
    const selected = this.repository.listCandidates(sourceCohortId)
      .filter((candidate) => !candidate.control && scores.get(candidate.address)?.qualified)
      .sort((left, right) => {
        const leftFloor = Math.min(
          left.pnl30d?.realizedProfitPercent ?? -Infinity,
          left.pnl90d?.realizedProfitPercent ?? -Infinity
        );
        const rightFloor = Math.min(
          right.pnl30d?.realizedProfitPercent ?? -Infinity,
          right.pnl90d?.realizedProfitPercent ?? -Infinity
        );
        return rightFloor - leftFloor;
      })
      .slice(0, PAPER_WALLET_COUNT)
      .map((candidate) => candidate.address);
    if (selected.length === PAPER_WALLET_COUNT) {
      this.repository.setActiveWallets(sourceCohortId, selected);
      return selected;
    }

    this.repository.setActiveWallets(sourceCohortId, []);
    this.repository.audit(
      "paper_evaluation_waiting",
      `Forward paper observation is waiting for exactly ${PAPER_WALLET_COUNT} research-qualified wallets; all available candidates remain shadow-only.`,
      {
        cohortId: sourceCohortId,
        qualifiedAvailable: selected.length,
        required: PAPER_WALLET_COUNT
      },
      "warning"
    );
    return [];
  }

  /**
   * Adopts already-saved qualification evidence after a cohort-size policy
   * change or restart. This performs no provider calls and remains idempotent:
   * an existing frozen evaluation is never replaced or rotated.
   */
  private ensureForwardPaperEvaluationFromCurrentCohort(): void {
    if (this.executionMode() !== "PAPER" || this.repository.activePaperEvaluationCohort()) return;
    const cohort = this.repository.latestCohort();
    if (!cohort) return;
    const selected = this.reconcileForwardPaperSelection(cohort.cohortId);
    if (selected.length !== PAPER_WALLET_COUNT) return;
    this.freezeForwardPaperEvaluation(cohort.cohortId);
  }

  private freezeForwardPaperEvaluation(sourceCohortId: string): void {
    if (this.executionMode() !== "PAPER") return;
    const wallets = this.repository
      .listCandidates(sourceCohortId, true)
      .map((candidate) => candidate.address);
    if (wallets.length === 0) return;
    const current = this.currentPortfolio("PAPER");
    const frozenAt = new Date().toISOString();
    const frozen = this.repository.freezePaperEvaluationCohort(
      sourceCohortId,
      wallets,
      current.navUsd,
      frozenAt
    );
    if (!frozen?.created) return;

    const positions = this.repository.listPositions("PAPER", true);
    const unpricedPositionIds = positions.map((position) => position.id);
    const baseline: PortfolioSnapshot = {
      ...current,
      capturedAt: frozenAt,
      peakNavUsd: current.navUsd,
      dayStartNavUsd: current.navUsd,
      evaluationCohortId: frozen.cohort.id,
      executablePricingComplete: unpricedPositionIds.length === 0,
      ...(unpricedPositionIds.length > 0 ? { unpricedPositionIds } : {})
    };
    this.repository.savePortfolioSnapshot(baseline);
    this.repository.audit(
      "paper_evaluation_cohort_frozen",
      "A wallet set was frozen for forward paper observation; its promotion clock starts now.",
      {
        evaluationCohortId: frozen.cohort.id,
        sourceCohortId,
        frozenAt,
        wallets,
        initialExecutableNavUsd: current.navUsd,
        inheritedOpenPositions: unpricedPositionIds
      }
    );
    this.recordPaperEvidenceHeartbeat(frozenAt);
    this.updatePromotionGate(new Date(frozenAt));
  }

  private activeWalletAllowed(wallet: string): boolean {
    const cohort = this.repository.latestCohort();
    if (!cohort) return false;
    const active = this.repository.listCandidates(cohort.cohortId, true).some((candidate) => candidate.address === wallet);
    if (!active) return false;
    if (this.executionMode() === "PAPER") {
      return this.repository.activePaperEvaluationCohort()?.wallets.includes(wallet) ?? false;
    }
    const liveWallets = this.repository.getSetting<string[]>("live_wallets") ?? [];
    return liveWallets.includes(wallet);
  }

  private async handleSwap(swap: LeaderSwap, alreadyPersisted = false): Promise<void> {
    if (!alreadyPersisted && !this.repository.insertSourceEvent(swap)) {
      if (this.repository.isSourceProcessed(swap.sourceSignature, swap.sourceWallet)) return;
      alreadyPersisted = true;
    }
    let completed = false;
    try {
      const signalAgeSeconds = (Date.now() - Date.parse(swap.blockTime)) / 1_000;
      if (swap.recovered || !Number.isFinite(signalAgeSeconds) || signalAgeSeconds > DEFAULT_RISK_POLICY.maximumSignalAgeSeconds) {
        this.queueResearchPaperAction(this.researchActionFromLeaderSwap(swap));
        this.recordSourceOutcome(
          swap,
          "ANALYSIS_ONLY",
          swap.recovered ? "RECOVERED_SOURCE" : "STALE_SOURCE",
          swap.recovered
            ? "Recovered source activity was retained for analysis and was not copied."
            : "Stale source activity was retained for analysis and was not copied."
        );
        this.repository.audit("signal_analysis_only", "Recovered or stale source event was stored but not copied.", {
          wallet: swap.sourceWallet,
          signature: swap.sourceSignature,
          recovered: swap.recovered,
          signalAgeSeconds
        });
        completed = true;
        return;
      }
      if (this.monitoringRepairPending()) {
        this.recordSourceOutcome(
          swap,
          "BLOCKED",
          "MONITORING_GAP",
          "Confirmed history repair was incomplete, so the source action was not copied."
        );
        this.repository.audit(
          "signal_gap_repair_blocked",
          "Live source activity was stored for analysis while confirmed history repair remained incomplete.",
          { wallet: swap.sourceWallet, signature: swap.sourceSignature },
          "warning"
        );
        completed = true;
        return;
      }
      if (this.emergencyActive) {
        this.recordSourceOutcome(
          swap,
          "BLOCKED",
          "EMERGENCY_ACTIVE",
          "Emergency liquidation was active, so the source action was not copied."
        );
        this.repository.audit("signal_emergency_blocked", "New source activity was ignored during emergency liquidation.", {
          wallet: swap.sourceWallet,
          signature: swap.sourceSignature
        }, "warning");
        completed = true;
        return;
      }
      if (!this.activeWalletAllowed(swap.sourceWallet)) {
        this.recordSourceOutcome(
          swap,
          "ANALYSIS_ONLY",
          "SHADOW_WALLET",
          "The source wallet was shadow-only or inactive, so the action was observed but not copied."
        );
        this.repository.audit("signal_shadowed", "Signal came from a non-active or shadow wallet.", {
          wallet: swap.sourceWallet,
          signature: swap.sourceSignature
        });
        completed = true;
        return;
      }
      if (["SETUP", "LOCKED", "PAUSED"].includes(this.modes.mode)) {
        this.recordSourceOutcome(
          swap,
          "BLOCKED",
          "MODE_BLOCKED",
          `Copying was disabled in ${this.modes.mode} mode.`
        );
        this.repository.audit("signal_mode_blocked", `Signal ignored in ${this.modes.mode}.`, {
          signature: swap.sourceSignature
        });
        completed = true;
        return;
      }
      if (swap.side === "BUY") await this.processBuy(swap);
      else await this.processSell(swap);
      this.queueResearchPaperAction(this.researchActionFromLeaderSwap(swap));
      completed = true;
    } catch (error) {
      this.recordSourceOutcome(
        swap,
        "RETRY_PENDING",
        "PROVIDER_ERROR",
        `Source processing will retry after a safe failure: ${this.errorText(error)}`
      );
      throw error;
    } finally {
      if (completed) this.repository.markSourceProcessed(swap.sourceSignature, swap.sourceWallet);
    }
  }

  private async processBuy(swap: LeaderSwap): Promise<void> {
    const portfolio = this.currentPortfolio(this.executionMode());
    const sizeUsd = Math.min(
      DEFAULT_RISK_POLICY.maxPositionUsd,
      portfolio.navUsd * DEFAULT_RISK_POLICY.positionNavFraction
    );
    const idempotencyKey = createIdempotencyKey({
      sourceSignature: swap.sourceSignature,
      sourceWallet: swap.sourceWallet,
      mint: swap.targetMint,
      action: "BUY"
    });
    const intent: CopyIntent = {
      id: randomUUID(),
      idempotencyKey,
      createdAt: new Date().toISOString(),
      sourceSwap: swap,
      side: "BUY",
      inputMint: USDC_MINT,
      outputMint: swap.targetMint,
      inputAmountAtomic: Math.round(sizeUsd * 10 ** USDC_DECIMALS).toString(),
      inputAmountUsd: sizeUsd
    };

    let token: TokenEligibility | undefined;
    try {
      token = await this.getToken(swap.targetMint);
      const taker = this.executionMode() === "LIVE" ? await this.signer.getAddress() : undefined;
      const entryQuote = await this.requireProviders().quotes.quote({
        inputMint: intent.inputMint,
        outputMint: intent.outputMint,
        inputAmountAtomic: intent.inputAmountAtomic,
        ...(taker ? { taker } : {})
      });
      const exitQuote = await this.requireProviders().quotes.quote({
        inputMint: intent.outputMint,
        outputMint: USDC_MINT,
        inputAmountAtomic: entryQuote.outputAmountAtomic
      });
      this.repository.saveQuote(entryQuote, "entry", swap.sourceSignature);
      this.repository.saveQuote(exitQuote, "exit", swap.sourceSignature);
      const decision = await this.evaluateOrderRisk(intent, token, entryQuote, exitQuote);
      this.saveSignalDecision(intent, token, decision);
      await this.placeOrder({ intent, entryQuote, exitQuote, decision });
    } catch (error) {
      const decision = rejected("UNKNOWN_TRANSACTION", this.errorText(error));
      this.saveSignalDecision(intent, token, decision, "BUY", "PROVIDER_ERROR");
      this.repository.audit("signal_rejected", "Buy signal failed closed.", {
        signature: swap.sourceSignature,
        reason: decision.reasons[0]
      }, "warning");
    }
  }

  private async processSell(swap: LeaderSwap): Promise<void> {
    const position = this.repository
      .listPositions(this.executionMode(), true)
      .find((lot) => lot.mint === swap.targetMint && lot.sourceWallet === swap.sourceWallet);
    if (!position) {
      this.recordSourceOutcome(
        swap,
        "ANALYSIS_ONLY",
        "NO_BOT_POSITION",
        "The leader sell did not match a bot-created position lot."
      );
      this.repository.audit("sell_without_bot_lot", "Leader sell did not match a bot-created position.", {
        wallet: swap.sourceWallet,
        mint: swap.targetMint,
        signature: swap.sourceSignature
      });
      return;
    }
    const sellStateKey = `leader_sell:${swap.sourceWallet}:${swap.sourceSignature}`;
    let leader: ReturnType<Repository["recordLeaderSell"]> | undefined;
    this.repository.db.transaction(() => {
      leader = this.repository.getSetting<ReturnType<Repository["recordLeaderSell"]>>(sellStateKey);
      if (!leader) {
        leader = this.repository.recordLeaderSell(
          position.sourceEntrySignature,
          swap.targetAmountAtomic
        );
        this.repository.setSetting(sellStateKey, leader);
      }
    })();
    if (!leader) throw new Error("Leader sell state could not be recorded.");
    if ([...this.ordersByKey.values()].some((order) => order.intent.sourcePositionId === position.id)) {
      this.recordSourceOutcome(
        swap,
        "BLOCKED",
        "EXIT_ALREADY_PENDING",
        "An earlier exit for this position still awaits approval or completion."
      );
      this.repository.audit("sell_waiting_for_approval", "Leader sell was recorded while an earlier exit awaits approval.", {
        positionId: position.id,
        cumulativeSoldFraction: leader.cumulativeSoldFraction
      });
      return;
    }
    const entryAmount = BigInt(position.entryAmountAtomic);
    const desiredRemaining = (entryAmount * BigInt(Math.round((1 - leader.cumulativeSoldFraction) * 1_000_000_000))) /
      1_000_000_000n;
    const followerRemaining = BigInt(position.remainingAmountAtomic);
    if (followerRemaining <= desiredRemaining) {
      this.recordSourceOutcome(
        swap,
        "ANALYSIS_ONLY",
        "EXIT_ALREADY_SATISFIED",
        "The copied position had already exited at least the leader's cumulative fraction."
      );
      return;
    }
    const needed = followerRemaining - desiredRemaining;
    const fraction = Number((needed * 1_000_000_000n) / followerRemaining) / 1_000_000_000;
    await this.executePositionExit(position, swap, fraction, leader.cumulativeSoldFraction >= 0.9, false);
  }

  private async executePositionExit(
    position: PositionLot,
    swap: LeaderSwap,
    fraction: number,
    force: boolean,
    liquidationAuthorization = false
  ): Promise<boolean> {
    if (this.exitLocks.has(position.id)) {
      this.recordSourceOutcome(
        swap,
        "BLOCKED",
        "EXIT_ALREADY_PENDING",
        "A second exit was suppressed while the position exit lock was held.",
        force ? "FORCED_EXIT" : "SELL"
      );
      this.repository.audit("exit_already_running", "A second exit was suppressed for the same position.", {
        positionId: position.id
      }, "warning");
      return false;
    }
    this.exitLocks.add(position.id);
    try {
    const providers = this.requireProviders();
    const fullQuote = await providers.quotes.quote({
      inputMint: position.mint,
      outputMint: USDC_MINT,
      inputAmountAtomic: position.remainingAmountAtomic
    });
    const plan = accrueProportionalExit(position, force ? 1 : fraction, fullQuote.outputUsd);
    if (!plan.request) {
      this.recordSourceOutcome(
        swap,
        "ANALYSIS_ONLY",
        "PARTIAL_EXIT_ACCUMULATED",
        "The proportional exit was below $1 and was accumulated for a later sell.",
        force ? "FORCED_EXIT" : "SELL"
      );
      this.repository.upsertPosition(plan.position);
      this.repository.audit("partial_exit_accumulated", "A sub-$1 proportional exit was accumulated.", {
        positionId: position.id,
        pendingFraction: plan.position.pendingExitFraction
      });
      return false;
    }

    const idempotencyKey = createIdempotencyKey({
      sourceSignature: swap.sourceSignature,
      sourceWallet: swap.sourceWallet,
      mint: swap.targetMint,
      action: force ? "FORCED_EXIT" : "SELL"
    });
    const intent: CopyIntent = {
      id: randomUUID(),
      idempotencyKey,
      createdAt: new Date().toISOString(),
      sourceSwap: swap,
      side: "SELL",
      inputMint: position.mint,
      outputMint: USDC_MINT,
      inputAmountAtomic: plan.request.amountAtomic,
      inputAmountUsd: plan.request.estimatedValueUsd,
      sourcePositionId: position.id
    };
    let token: TokenEligibility;
    try {
      token = await this.getToken(position.mint, true);
    } catch (error) {
      token = unknownToken(position.mint, this.errorText(error));
    }
    const taker = this.executionMode() === "LIVE" ? await this.signer.getAddress() : undefined;
    const entryQuote = await providers.quotes.quote({
      inputMint: intent.inputMint,
      outputMint: intent.outputMint,
      inputAmountAtomic: intent.inputAmountAtomic,
      ...(taker ? { taker } : {})
    });
    this.repository.saveQuote(entryQuote, "exit", swap.sourceSignature);
    const decision = liquidationAuthorization
      ? this.evaluateForcedExitRisk(intent, entryQuote)
      : await this.evaluateOrderRisk(intent, token, entryQuote);
    this.saveSignalDecision(intent, token, decision, force ? "FORCED_EXIT" : "SELL");
    const execution = await this.placeOrder({ intent, entryQuote, decision }, liquidationAuthorization);
    return execution?.status === "CONFIRMED";
    } finally {
      this.exitLocks.delete(position.id);
    }
  }

  private async placeOrder(order: BrokerOrder, forcedExit = false): Promise<ExecutionRecord | undefined> {
    const persisted = this.repository.getExecutionByIdempotencyKey(order.intent.idempotencyKey);
    if (persisted) {
      this.persistExecutionOutcome(persisted);
      if (persisted.status === "CONFIRMED" && !this.repository.isExecutionApplied(persisted.id)) {
        await this.applyExecution(order, persisted);
      }
      return persisted;
    }
    this.ordersByKey.set(order.intent.idempotencyKey, order);
    let record: ExecutionRecord;
    if (this.executionMode() === "PAPER") {
      record = await new PaperBroker({ solPriceUsd: await this.getSolPriceUsd() }).place(order);
    } else {
      if (!this.liveBroker) throw new Error("Live broker is not configured.");
      record = forcedExit
        ? await this.liveBroker.placeForcedExit(order)
        : await this.liveBroker.place(order);
    }
    this.persistExecutionOutcome(record);
    this.events.publish("execution", record);
    if (record.status === "AWAITING_APPROVAL") {
      this.executionKeys.set(record.id, record.idempotencyKey);
      return record;
    }
    if (record.status === "CONFIRMED") await this.applyExecution(order, record);
    this.ordersByKey.delete(record.idempotencyKey);
    return record;
  }

  private async applyExecution(originalOrder: BrokerOrder, record: ExecutionRecord): Promise<void> {
    if (this.repository.isExecutionApplied(record.id)) return;
    const order = this.ordersByKey.get(record.idempotencyKey) ?? originalOrder;
    const solPrice = this.solPriceCache?.price ?? this.repository.getSetting<number>("last_sol_price_usd") ?? 0;
    const quote = record.quote;
    const feeLamports = quote.signatureFeeLamports + quote.prioritizationFeeLamports + quote.rentFeeLamports;
    const networkUsd =
      (feeLamports / 1_000_000_000) * solPrice;
    record.actualFeesUsd = quote.inputUsd * (quote.feeBps / 10_000) + networkUsd;
    const shortfall = safePercentShortfall(
      quote.outputAmountAtomic,
      record.actualOutputAtomic
    );
    if (shortfall !== undefined) record.implementationShortfallPercent = shortfall;
    let openedPosition: PositionLot | undefined;
    let closedPosition: PositionLot | undefined;
    let closedTrade: ClosedTradeResult | undefined;
    let soldAtomic: string | undefined;
    this.repository.db.transaction(() => {
      if (this.repository.isExecutionApplied(record.id)) return;
      this.persistExecutionOutcome(record);
      if (record.policyViolation) {
        const count = this.repository.getSetting<number>("manual_policy_violations") ?? 0;
        this.repository.setSetting("manual_policy_violations", count + 1);
        this.repository.audit("execution_policy_violation", record.policyViolation, {
          executionId: record.id,
          signature: record.targetSignature
        }, "critical");
      }

      if (order.intent.side === "BUY") {
        const received = record.actualOutputAtomic ?? quote.outputAmountAtomic;
        const paperEvaluation = record.mode === "PAPER"
          ? this.repository.activePaperEvaluationCohort()
          : undefined;
        const position = openPositionLot({
          id: record.id,
          mode: record.mode,
          sourceSwap: order.intent.sourceSwap,
          openedAt: new Date(record.updatedAt),
          receivedAmountAtomic: received,
          entryCostUsd: quote.inputUsd,
          executableValueUsd: order.exitQuote?.outputUsd ?? quote.outputUsd,
          ...(paperEvaluation ? { evaluationCohortId: paperEvaluation.id } : {})
        });
        this.repository.upsertPosition(position);
        this.repository.saveLeaderLot(
          order.intent.sourceSwap.sourceSignature,
          order.intent.sourceSwap.sourceWallet,
          order.intent.sourceSwap.targetMint,
          order.intent.sourceSwap.targetAmountAtomic
        );
        this.adjustTrackedBalances(record.mode, order.intent, record.actualInputAtomic ?? quote.inputAmountAtomic, received, feeLamports);
        this.updatePortfolioAfterBuy(position, quote, record.actualFeesUsd ?? 0, networkUsd);
        openedPosition = position;
      } else {
        const position = order.intent.sourcePositionId
          ? this.repository.listPositions(record.mode, true).find((lot) => lot.id === order.intent.sourcePositionId)
          : undefined;
        if (!position) throw new Error("Confirmed sell could not find its bot-created position lot.");
        const sold = record.actualInputAtomic ?? order.intent.inputAmountAtomic;
        const proceedsUsd = record.actualOutputAtomic
          ? atomicToUi(record.actualOutputAtomic, USDC_DECIMALS)
          : quote.outputUsd;
        // Keep sub-$1 residuals open so later leader sells can accumulate; only
        // an actual zero balance is closed in the runtime ledger.
        const result = applyExitFill(position, sold, proceedsUsd, new Date(record.updatedAt), 0);
        this.repository.upsertPosition(result.position);
        const realizedKey = `realized:${position.id}`;
        const realized = (this.repository.getSetting<number>(realizedKey) ?? 0) + result.realizedPnlUsd;
        this.repository.setSetting(realizedKey, realized);
        this.adjustTrackedBalances(
          record.mode,
          order.intent,
          sold,
          record.actualOutputAtomic ?? quote.outputAmountAtomic,
          feeLamports
        );
        this.updatePortfolioAfterSell(result.position, proceedsUsd, result.realizedPnlUsd, networkUsd);
        if (result.position.status === "CLOSED") {
          const trade: ClosedTradeResult = {
            closedAt: result.position.closedAt ?? record.updatedAt,
            pnlUsd: realized,
            sourceWallet: position.sourceWallet,
            ...(position.evaluationCohortId
              ? { evaluationCohortId: position.evaluationCohortId }
              : {})
          };
          this.repository.saveClosedTrade(position.id, record.mode, trade);
          closedPosition = position;
          closedTrade = trade;
        }
        soldAtomic = sold;
      }
      this.repository.markExecutionApplied(record.id);
    })();

    if (record.mode === "PAPER") {
      // This callback is deliberately after the atomic source application.
      // The coordinator re-reads that committed ledger row and cannot mirror
      // a live, unconfirmed, or unapplied execution.
      this.marketplaceMirror.afterStrictPaperExecution(record.id);
    }

    if (openedPosition && record.mode === "PAPER") {
      void this.captureStressEntry(openedPosition, order).catch((error) => {
        this.recordError("stress_entry", error, { positionId: openedPosition?.id });
      });
    }
    if (closedPosition && closedTrade && soldAtomic && record.mode === "PAPER") {
      try {
        const stressPnl = await this.captureStressExit(closedPosition, soldAtomic, true);
        if (stressPnl !== undefined) {
          this.repository.saveClosedTrade(closedPosition.id, record.mode, { ...closedTrade, stressPnlUsd: stressPnl });
        }
      } catch (error) {
        this.recordError("stress_exit", error, { positionId: closedPosition.id });
      }
    }
    if (closedTrade) this.updatePromotionGate();
    if (record.policyViolation && record.mode === "LIVE" && !this.emergencyActive) {
      void this.emergencyExit().catch((error) => this.recordError("policy_violation_exit", error));
    } else {
      void this.evaluateStops().catch((error) => this.recordError("post_fill_stop_check", error));
    }
  }

  private async getToken(mint: string, bypassCache = false): Promise<TokenEligibility> {
    const cached = this.tokenCache.get(mint);
    if (!bypassCache && cached && Date.now() - cached.at < 10 * 60_000) return cached.token;
    const token = evaluateTokenPolicy(await this.requireProviders().token.checkToken(mint));
    this.tokenCache.set(mint, { token, at: Date.now() });
    return token;
  }

  private async evaluateOrderRisk(
    intent: CopyIntent,
    token: TokenEligibility,
    entryQuote: QuoteSnapshot,
    exitQuote?: QuoteSnapshot
  ): Promise<RiskDecision> {
    const decimals = token.decimals;
    const outputUi = decimals === undefined ? 0 : atomicToUi(entryQuote.outputAmountAtomic, decimals);
    const followerPriceUsd = outputUi > 0 ? entryQuote.outputUsd / outputUi : undefined;
    const newEntriesPaused = this.repository.getSetting<boolean>("new_entries_paused") ?? false;
    const localDataBlocked = intent.side === "BUY" && this.operationalTelemetry().blocksNewEntries;
    const mode = intent.side === "BUY" && (newEntriesPaused || localDataBlocked) ? "PAUSED" : this.modes.mode;
    const liveStartNavUsd = this.repository.getSetting<number>("live_start_nav_usd");
    const decision = evaluateRisk({
      mode,
      intent,
      token,
      entryQuote,
      ...(exitQuote ? { exitQuote } : {}),
      ...(followerPriceUsd !== undefined ? { followerPriceUsd } : {}),
      solPriceUsd: await this.getSolPriceUsd(),
      portfolio: this.currentPortfolio(this.executionMode()),
      positions: this.repository.listPositions(this.executionMode(), true),
      providerHealth: this.repository.listProviderHealth(),
      ...(liveStartNavUsd !== undefined ? { liveStartNavUsd } : {})
    });
    // A stale actionable buy quote is an operational fault, not merely a
    // single rejected order. Keep the hold sticky until a later fresh buy
    // quote proves quote delivery has recovered.
    if (intent.side === "BUY") await this.evaluateStops(false, entryQuote);
    return decision;
  }

  private evaluateForcedExitRisk(intent: CopyIntent, quote: QuoteSnapshot): RiskDecision {
    const reasons: string[] = [];
    if (intent.side !== "SELL" || !intent.sourcePositionId) {
      reasons.push("liquidation authorization only permits sells of recorded lots");
    }
    if (
      quote.inputMint !== intent.inputMint ||
      quote.outputMint !== intent.outputMint ||
      quote.inputAmountAtomic !== intent.inputAmountAtomic
    ) {
      reasons.push("liquidation quote does not match the recorded position intent");
    }
    const ageSeconds = (Date.now() - Date.parse(quote.quotedAt)) / 1_000;
    if (!Number.isFinite(ageSeconds) || ageSeconds > DEFAULT_RISK_POLICY.maximumQuoteAgeSeconds) {
      reasons.push("liquidation quote is stale");
    }
    if (quote.expiresAt && Date.parse(quote.expiresAt) <= Date.now()) {
      reasons.push("liquidation quote is expired");
    }
    if (quote.priceImpactPercent > DEFAULT_RISK_POLICY.maximumPriceImpactPercent) {
      reasons.push(`liquidation price impact exceeds ${DEFAULT_RISK_POLICY.maximumPriceImpactPercent}%`);
    }
    return {
      allowed: reasons.length === 0,
      code: reasons.length === 0 ? "ALLOWED" : "UNKNOWN_TRANSACTION",
      reasons: reasons.length === 0 ? ["recorded-position liquidation checks passed"] : reasons,
      decidedAt: new Date().toISOString(),
      positionSizeUsd: intent.inputAmountUsd
    };
  }

  private async refreshBrokerOrder(order: BrokerOrder): Promise<BrokerOrder> {
    const taker = await this.signer.getAddress();
    const entryQuote = await this.requireProviders().quotes.quote({
      inputMint: order.intent.inputMint,
      outputMint: order.intent.outputMint,
      inputAmountAtomic: order.intent.inputAmountAtomic,
      taker
    });
    let exitQuote: QuoteSnapshot | undefined;
    if (order.intent.side === "BUY") {
      exitQuote = await this.requireProviders().quotes.quote({
        inputMint: order.intent.outputMint,
        outputMint: USDC_MINT,
        inputAmountAtomic: entryQuote.outputAmountAtomic
      });
    }
    const token = await this.getToken(order.intent.sourceSwap.targetMint, true);
    const decision = await this.evaluateOrderRisk(order.intent, token, entryQuote, exitQuote);
    const refreshed: BrokerOrder = {
      intent: order.intent,
      entryQuote,
      ...(exitQuote ? { exitQuote } : {}),
      decision
    };
    this.ordersByKey.set(order.intent.idempotencyKey, refreshed);
    this.repository.saveQuote(entryQuote, order.intent.side === "BUY" ? "entry" : "exit", order.intent.sourceSwap.sourceSignature);
    if (exitQuote) this.repository.saveQuote(exitQuote, "exit", order.intent.sourceSwap.sourceSignature);
    return refreshed;
  }

  private async revalidateOrder(order: BrokerOrder): Promise<RiskDecision> {
    const token = await this.getToken(order.intent.sourceSwap.targetMint, true);
    return this.evaluateOrderRisk(order.intent, token, order.entryQuote, order.exitQuote);
  }

  private async getSolPriceUsd(): Promise<number> {
    if (this.solPriceCache && Date.now() - this.solPriceCache.at < 60_000) return this.solPriceCache.price;
    const quote = await this.requireProviders().quotes.quote({
      inputMint: SOL_MINT,
      outputMint: USDC_MINT,
      inputAmountAtomic: "10000000"
    });
    const price = quote.inputUsd / 0.01;
    if (!Number.isFinite(price) || price <= 0) throw new Error("Unable to determine a positive SOL/USD price.");
    this.solPriceCache = { price, at: Date.now() };
    this.repository.setSetting("last_sol_price_usd", price);
    this.repository.setSetting("last_sol_price_at", new Date(this.solPriceCache.at).toISOString());
    this.solPriceOracle.record(price, new Date(this.solPriceCache.at).toISOString());
    return price;
  }

  private async resolveSelfHostedSolPriceUsd(at: string): Promise<number> {
    const requestedAt = Date.parse(at);
    if (!Number.isFinite(requestedAt)) throw new Error("SOL price request time is invalid.");
    // Never value an historical swap from a quote captured after its block.
    // Ongoing Jupiter captures populate the local ledger independently; a
    // missing prior point must remain unpriced and enter the durable reprice
    // queue instead of borrowing a future/current mark.
    return this.solPriceOracle.resolve(at);
  }

  private adjustTrackedBalances(
    mode: "PAPER" | "LIVE",
    intent: CopyIntent,
    actualInputAtomic: string,
    actualOutputAtomic: string,
    feeLamports: number
  ): void {
    if (mode !== "LIVE") return;
    let sol = BigInt(this.repository.getSetting<string>("live_tracked_sol_lamports") ?? "0");
    let usdc = BigInt(this.repository.getSetting<string>("live_tracked_usdc_atomic") ?? "0");
    sol = sol > BigInt(feeLamports) ? sol - BigInt(feeLamports) : 0n;
    if (intent.inputMint === USDC_MINT) {
      const input = BigInt(actualInputAtomic);
      usdc = usdc > input ? usdc - input : 0n;
    }
    if (intent.outputMint === USDC_MINT) usdc += BigInt(actualOutputAtomic);
    this.repository.setSetting("live_tracked_sol_lamports", sol.toString());
    this.repository.setSetting("live_tracked_usdc_atomic", usdc.toString());
  }

  private currentPortfolio(mode: "PAPER" | "LIVE"): PortfolioSnapshot {
    const existing = this.repository.latestPortfolioSnapshot(mode);
    if (existing) {
      const today = new Date().toISOString().slice(0, 10);
      if (existing.capturedAt.slice(0, 10) !== today) {
        return { ...existing, capturedAt: new Date().toISOString(), dayStartNavUsd: existing.navUsd };
      }
      return existing;
    }
    const initial =
      this.repository.getSetting<number>("paper_initial_nav_usd") ?? DEFAULT_RISK_POLICY.initialNavUsd;
    return {
      mode,
      capturedAt: new Date().toISOString(),
      navUsd: initial,
      peakNavUsd: initial,
      dayStartNavUsd: initial,
      deployedUsd: 0,
      solReserveUsd: DEFAULT_RISK_POLICY.initialSolAllocationUsd,
      liquidReserveUsd: initial,
      realizedPnlUsd: 0,
      unrealizedPnlUsd: 0,
      openPositions: 0,
      balanceMismatchPercent: 0
    };
  }

  private updatePortfolioAfterBuy(
    position: PositionLot,
    quote: QuoteSnapshot,
    totalFeesUsd: number,
    networkUsd: number
  ): void {
    const current = this.currentPortfolio(position.mode);
    const positions = this.repository.listPositions(position.mode, true);
    const evaluationCohortId = position.mode === "PAPER" ? position.evaluationCohortId : undefined;
    const unpricedPositionIds = positions
      .filter((lot) =>
        !Number.isFinite(lot.lastExecutableValueUsd) ||
        lot.lastExecutableValueUsd < 0 ||
        (position.mode === "PAPER" && lot.evaluationCohortId !== evaluationCohortId)
      )
      .map((lot) => lot.id);
    const deployed = positions.reduce((sum, lot) => sum + lot.lastExecutableValueUsd, 0);
    const liquid = Math.max(0, current.liquidReserveUsd - quote.inputUsd - networkUsd);
    const nav = liquid + deployed;
    const snapshot: PortfolioSnapshot = {
      ...current,
      capturedAt: new Date().toISOString(),
      navUsd: nav,
      peakNavUsd: Math.max(current.peakNavUsd, nav),
      deployedUsd: deployed,
      solReserveUsd: Math.max(0, current.solReserveUsd - networkUsd),
      liquidReserveUsd: liquid,
      unrealizedPnlUsd: positions.reduce(
        (sum, lot) => sum + lot.lastExecutableValueUsd - lot.remainingCostUsd,
        0
      ),
      openPositions: positions.length,
      ...(evaluationCohortId ? { evaluationCohortId } : {}),
      executablePricingComplete: unpricedPositionIds.length === 0,
      ...(unpricedPositionIds.length > 0 ? { unpricedPositionIds } : {})
    };
    void totalFeesUsd;
    this.repository.savePortfolioSnapshot(snapshot);
    this.events.publish("portfolio", snapshot);
  }

  private updatePortfolioAfterSell(
    position: PositionLot,
    proceedsUsd: number,
    realizedPnlUsd: number,
    networkUsd: number
  ): void {
    const current = this.currentPortfolio(position.mode);
    const positions = this.repository.listPositions(position.mode, true);
    const evaluationCohortId = position.mode === "PAPER" ? position.evaluationCohortId : undefined;
    const unpricedPositionIds = positions
      .filter((lot) =>
        !Number.isFinite(lot.lastExecutableValueUsd) ||
        lot.lastExecutableValueUsd < 0 ||
        (position.mode === "PAPER" && lot.evaluationCohortId !== evaluationCohortId)
      )
      .map((lot) => lot.id);
    const deployed = positions.reduce((sum, lot) => sum + lot.lastExecutableValueUsd, 0);
    const liquid = current.liquidReserveUsd + proceedsUsd - networkUsd;
    const nav = liquid + deployed;
    const snapshot: PortfolioSnapshot = {
      ...current,
      capturedAt: new Date().toISOString(),
      navUsd: nav,
      peakNavUsd: Math.max(current.peakNavUsd, nav),
      deployedUsd: deployed,
      solReserveUsd: Math.max(0, current.solReserveUsd - networkUsd),
      liquidReserveUsd: liquid,
      realizedPnlUsd: current.realizedPnlUsd + realizedPnlUsd,
      unrealizedPnlUsd: positions.reduce(
        (sum, lot) => sum + lot.lastExecutableValueUsd - lot.remainingCostUsd,
        0
      ),
      openPositions: positions.length,
      ...(evaluationCohortId ? { evaluationCohortId } : {}),
      executablePricingComplete: unpricedPositionIds.length === 0,
      ...(unpricedPositionIds.length > 0 ? { unpricedPositionIds } : {})
    };
    this.repository.savePortfolioSnapshot(snapshot);
    this.events.publish("portfolio", snapshot);
  }

  private stressKey(positionId: string): string {
    return `paper_stress:${positionId}`;
  }

  private async captureStressEntry(position: PositionLot, order: BrokerOrder): Promise<void> {
    const initial: StressLot = {
      ready: false,
      entryCostUsd: order.entryQuote.inputUsd,
      remainingAtomic: order.entryQuote.outputAmountAtomic,
      proceedsUsd: 0,
      extraCostsUsd: this.extraQuoteCostUsd(order.entryQuote)
    };
    this.repository.setSetting(this.stressKey(position.id), initial);
    await sleep(STRESS_DELAY_MS);
    const delayed = await this.requireProviders().quotes.quote({
      inputMint: order.intent.inputMint,
      outputMint: order.intent.outputMint,
      inputAmountAtomic: order.intent.inputAmountAtomic
    });
    const execution = this.repository.getExecution(position.id);
    if (execution) {
      execution.implementationShortfallPercent =
        safePercentShortfall(order.entryQuote.outputAmountAtomic, delayed.outputAmountAtomic) ?? 0;
      execution.updatedAt = new Date().toISOString();
      this.persistExecutionOutcome(execution);
      this.updatePromotionGate();
    }
    this.repository.setSetting(this.stressKey(position.id), {
      ...initial,
      ready: true,
      remainingAtomic: delayed.outputAmountAtomic,
      extraCostsUsd: initial.extraCostsUsd + this.extraQuoteCostUsd(delayed)
    } satisfies StressLot);
  }

  private async captureStressExit(
    position: PositionLot,
    actualSoldAtomic: string,
    closing: boolean
  ): Promise<number | undefined> {
    const meta = this.repository.getSetting<StressLot>(this.stressKey(position.id));
    if (!meta?.ready || BigInt(meta.remainingAtomic) <= 0n) return undefined;
    const actualBefore = BigInt(position.remainingAmountAtomic);
    const actualSold = BigInt(actualSoldAtomic);
    const fraction = actualBefore > 0n ? Math.min(1, Number(actualSold) / Number(actualBefore)) : 1;
    const stressRemaining = BigInt(meta.remainingAtomic);
    const stressSold = closing
      ? stressRemaining
      : (stressRemaining * BigInt(Math.floor(fraction * 1_000_000_000))) / 1_000_000_000n;
    if (stressSold <= 0n) return undefined;
    await sleep(STRESS_DELAY_MS);
    const quote = await this.requireProviders().quotes.quote({
      inputMint: position.mint,
      outputMint: USDC_MINT,
      inputAmountAtomic: stressSold.toString()
    });
    const updated: StressLot = {
      ...meta,
      remainingAtomic: (stressRemaining - stressSold).toString(),
      proceedsUsd: meta.proceedsUsd + quote.outputUsd,
      extraCostsUsd: meta.extraCostsUsd + this.extraQuoteCostUsd(quote)
    };
    this.repository.setSetting(this.stressKey(position.id), updated);
    return closing ? updated.proceedsUsd - updated.entryCostUsd - updated.extraCostsUsd : undefined;
  }

  private extraQuoteCostUsd(quote: QuoteSnapshot): number {
    const variable =
      quote.inputUsd *
      (quote.priceImpactPercent / 100 + quote.slippageBps / 10_000 + quote.feeBps / 10_000);
    const solPrice = this.solPriceCache?.price ?? 0;
    const network =
      ((quote.signatureFeeLamports + quote.prioritizationFeeLamports + quote.rentFeeLamports) /
        1_000_000_000) *
      solPrice;
    return variable + network;
  }

  private recordPaperEvidenceHeartbeat(observedAt = new Date().toISOString()): void {
    if (this.modes.mode !== "PAPER" || !this.providers) return;
    const evaluation = this.repository.activePaperEvaluationCohort();
    if (!evaluation) return;
    const helius = this.repository.listProviderHealth().find((health) => health.provider === "helius");
    if (helius?.ok !== true || !this.providers.chain.getStreamStatus().active) return;
    const positions = this.repository.listPositions("PAPER", true);
    const latest = this.repository.latestPortfolioSnapshot("PAPER");
    const markAgeMs = latest ? Date.parse(observedAt) - Date.parse(latest.capturedAt) : Number.POSITIVE_INFINITY;
    const pricingCurrent = positions.length === 0 || Boolean(
      latest &&
      latest.evaluationCohortId === evaluation.id &&
      latest.executablePricingComplete === true &&
      Number.isFinite(markAgeMs) &&
      markAgeMs >= 0 &&
      markAgeMs <= DEFAULT_RUNTIME_HEARTBEAT_GAP_MS &&
      positions.every((position) => position.evaluationCohortId === evaluation.id)
    );
    if (!pricingCurrent) return;
    this.repository.recordPaperRuntimeHeartbeat(evaluation.id, observedAt);
  }

  private updatePromotionGate(now = new Date()): void {
    const evaluation = this.repository.activePaperEvaluationCohort();
    const executions = this.repository.listExecutions(2_000);
    const manualExecutions = executions
      .filter((record) => record.mode === "LIVE" && record.approvedAt && record.status === "CONFIRMED");
    const paperShortfalls = executions
      .filter((record) =>
        record.mode === "PAPER" &&
        record.status === "CONFIRMED" &&
        Boolean(evaluation) &&
        Date.parse(record.createdAt) >= Date.parse(evaluation!.frozenAt)
      )
      .map((record) => record.implementationShortfallPercent)
      .filter((value): value is number => value !== undefined);
    const manualShortfalls = manualExecutions
      .map((record) => record.implementationShortfallPercent)
      .filter((value): value is number => value !== undefined);
    const snapshots = evaluation
      ? this.repository.listPortfolioSnapshots("PAPER", evaluation.id)
      : [];
    const latestSnapshot = snapshots.at(-1);
    const openPositions = this.repository.listPositions("PAPER", true);
    const latestMarkAgeMs = latestSnapshot
      ? now.getTime() - Date.parse(latestSnapshot.capturedAt)
      : Number.POSITIVE_INFINITY;
    const navEvidenceValid = Boolean(
      evaluation &&
      snapshots.length > 0 &&
      snapshots.every((snapshot) =>
        Number.isFinite(snapshot.navUsd) &&
        snapshot.navUsd >= 0 &&
        Number.isFinite(Date.parse(snapshot.capturedAt)) &&
        Date.parse(snapshot.capturedAt) >= Date.parse(evaluation.frozenAt)
      )
    );
    const executablePricingComplete = Boolean(
      evaluation &&
      latestSnapshot &&
      navEvidenceValid &&
      snapshots.every((snapshot) =>
        (snapshot.openPositions === 0 || snapshot.executablePricingComplete === true)
      ) &&
      openPositions.every((position) => position.evaluationCohortId === evaluation.id) &&
      (openPositions.length === 0 || (
        latestSnapshot.executablePricingComplete === true &&
        Number.isFinite(latestMarkAgeMs) &&
        latestMarkAgeMs >= 0 &&
        latestMarkAgeMs <= DEFAULT_RUNTIME_HEARTBEAT_GAP_MS
      ))
    );
    const observationCoverage = evaluation
      ? calculateRuntimeObservationCoverage(
          evaluation.frozenAt,
          this.repository.listPaperRuntimeHeartbeats(evaluation.id),
          now
        )
      : undefined;
    const gate = calculatePromotionGate({
      now,
      ...(evaluation ? {
        evaluationCohortId: evaluation.id,
        evaluationCohortStartAt: evaluation.frozenAt,
        initialNavUsd: evaluation.initialNavUsd,
        observationCoverage: observationCoverage!,
        equityCurve: navEvidenceValid
          ? snapshots.map((snapshot) => ({ at: snapshot.capturedAt, navUsd: snapshot.navUsd }))
          : []
      } : {
        initialNavUsd:
          this.repository.getSetting<number>("paper_initial_nav_usd") ?? DEFAULT_RISK_POLICY.initialNavUsd
      }),
      executablePricingComplete,
      trades: evaluation ? this.repository.listClosedTrades("PAPER", evaluation.id) : [],
      manualLiveOrders: manualExecutions.length,
      manualCompletedPositions: this.repository.listClosedTrades("LIVE").length,
      paperExecutionShortfalls: paperShortfalls,
      manualExecutionShortfalls: manualShortfalls,
      manualPolicyViolations: manualExecutions.filter((record) => Boolean(record.policyViolation)).length
    });
    this.modes.setPromotion(gate);
    this.updateForwardWalletScores();
    this.events.publish("promotion", gate);
  }

  private updateForwardWalletScores(): void {
    const cohort = this.repository.latestCohort();
    const evaluation = this.repository.activePaperEvaluationCohort();
    if (!cohort || !evaluation) return;
    const tradesByWallet = new Map<string, ClosedTradeResult[]>();
    for (const trade of this.repository.listClosedTrades("PAPER", evaluation.id)) {
      const trades = tradesByWallet.get(trade.sourceWallet) ?? [];
      trades.push(trade);
      tradesByWallet.set(trade.sourceWallet, trades);
    }
    const scores = new Map(
      this.repository.listWalletScores(cohort.cohortId).map((score) => [score.wallet, score])
    );
    for (const [wallet, trades] of tradesByWallet) {
      const score = scores.get(wallet);
      if (!score) continue;
      const initialNav = evaluation.initialNavUsd;
      let equity = initialNav;
      let peak = equity;
      let maxDrawdownPercent = 0;
      for (const trade of [...trades].sort((left, right) => Date.parse(left.closedAt) - Date.parse(right.closedAt))) {
        equity += trade.pnlUsd;
        peak = Math.max(peak, equity);
        if (peak > 0) maxDrawdownPercent = Math.max(maxDrawdownPercent, (peak - equity) / peak * 100);
      }
      this.repository.saveWalletScore(cohort.cohortId, {
        ...score,
        calculatedAt: new Date().toISOString(),
        forwardNetReturnPercent:
          trades.reduce((sum, trade) => sum + trade.pnlUsd, 0) / initialNav * 100,
        forwardProfitFactor: calculateProfitFactor(trades.map((trade) => trade.pnlUsd)),
        forwardMaxDrawdownPercent: maxDrawdownPercent
      });
    }
  }

  private selectLiveWallets(): void {
    const evaluation = this.repository.activePaperEvaluationCohort();
    const grouped = new Map<string, ClosedTradeResult[]>();
    for (const trade of evaluation ? this.repository.listClosedTrades("PAPER", evaluation.id) : []) {
      const values = grouped.get(trade.sourceWallet) ?? [];
      values.push(trade);
      grouped.set(trade.sourceWallet, values);
    }
    const selected = [...grouped.entries()]
      .map(([wallet, trades]) => ({
        wallet,
        trades,
        pnl: trades.reduce((sum, trade) => sum + trade.pnlUsd, 0),
        profitFactor: calculateProfitFactor(trades.map((trade) => trade.pnlUsd))
      }))
      .filter((entry) => entry.trades.length >= 10 && entry.pnl > 0 && entry.profitFactor >= 1.2)
      .sort((left, right) => right.pnl - left.pnl)
      .slice(0, LIVE_WALLET_COUNT)
      .map((entry) => entry.wallet);
    this.repository.setSetting("live_wallets", selected);
    this.repository.audit("live_wallets_selected", "Paper-qualified wallets were frozen for live calibration.", {
      wallets: selected
    });
  }

  private restoreEmergencyLock(): boolean {
    const liquidation = this.repository.latestEmergencyLiquidation();
    if (!liquidation) return false;
    if (this.modes.mode !== "LOCKED") {
      this.modes.lock(
        liquidation.state === "LOCKED_COMPLETE"
          ? "A completed emergency exit remains locked pending explicit review."
          : "An interrupted emergency exit was recovered; live signing remains locked."
      );
      this.repository.audit(
        "emergency_lock_recovered",
        "Persisted emergency state overrode the stored live mode during startup.",
        { liquidationId: liquidation.id, state: liquidation.state },
        "critical"
      );
    }
    return liquidation.state !== "LOCKED_COMPLETE";
  }

  private async reconcileEmergencySubmissions(): Promise<void> {
    for (const operation of this.repository.listEmergencyExitOperations([
      "PENDING",
      "SUBMITTED_UNRESOLVED",
      "FAILED_SAFE"
    ])) {
      const execution = this.repository.getExecutionByIdempotencyKey(operation.idempotencyKey);
      if (!execution) continue;
      if (execution.status === "CONFIRMED") {
        this.repository.updateEmergencyExitOperation(operation.positionId, "CONFIRMED", {
          executionId: execution.id,
          ...(execution.targetSignature ? { targetSignature: execution.targetSignature } : {})
        });
        continue;
      }
      if (["QUEUED", "AWAITING_APPROVAL", "APPROVED", "FAILED", "REJECTED", "SKIPPED"].includes(execution.status)) {
        this.repository.updateEmergencyExitOperation(operation.positionId, "FAILED_SAFE", {
          executionId: execution.id,
          ...(execution.targetSignature ? { targetSignature: execution.targetSignature } : {}),
          lastError: execution.failureReason ?? "The prior attempt failed before a confirmed fill."
        });
        continue;
      }
      if (execution.status !== "SUBMITTED" && execution.status !== "SUBMITTED_UNRESOLVED") continue;

      this.repository.updateEmergencyExitOperation(operation.positionId, "SUBMITTED_UNRESOLVED", {
        executionId: execution.id,
        ...(execution.targetSignature ? { targetSignature: execution.targetSignature } : {}),
        lastError: execution.failureReason ?? "Broadcast confirmation was not received."
      });
      const reconciliationRpc = this.vault.getDataProviderProfile().mode === "SELF_HOSTED"
        ? this.emergencyExecutionRpc
        : this.executionRpc;
      if (!execution.targetSignature || !reconciliationRpc) {
        this.repository.audit(
          "emergency_submission_unresolved",
          "An emergency broadcast cannot be retried because its signature is unavailable for reconciliation.",
          { operationId: operation.operationId, executionId: execution.id },
          "critical"
        );
        continue;
      }

      const transaction = await reconciliationRpc.getTransaction(execution.targetSignature);
      if (!transaction) {
        this.repository.audit(
          "emergency_submission_pending",
          "The emergency transaction is not yet available at confirmed commitment; retry remains blocked.",
          { operationId: operation.operationId, signature: execution.targetSignature },
          "warning"
        );
        continue;
      }
      const meta = typeof transaction === "object" && transaction !== null && "meta" in transaction
        ? (transaction as { meta?: unknown }).meta
        : undefined;
      if (!meta || typeof meta !== "object" || !("err" in meta)) {
        this.repository.audit(
          "emergency_submission_malformed",
          "Confirmed transaction evidence was malformed; retry remains blocked.",
          { operationId: operation.operationId, signature: execution.targetSignature },
          "critical"
        );
        continue;
      }
      if ((meta as { err: unknown }).err !== null) {
        execution.status = "FAILED";
        execution.updatedAt = new Date().toISOString();
        execution.failureReason = "The prior emergency transaction was confirmed failed on-chain; a new safe attempt is allowed.";
        this.persistExecutionOutcome(execution);
        this.repository.updateEmergencyExitOperation(operation.positionId, "FAILED_SAFE", {
          executionId: execution.id,
          targetSignature: execution.targetSignature,
          lastError: execution.failureReason
        });
        this.repository.audit(
          "emergency_submission_failed_reconciled",
          "A previously ambiguous emergency transaction was confirmed failed on-chain.",
          { operationId: operation.operationId, signature: execution.targetSignature },
          "warning"
        );
        continue;
      }

      const context = this.repository.getOrderContext(operation.idempotencyKey);
      const wallet = this.repository.getSetting<string>("wallet_address");
      if (!context || !wallet) {
        this.repository.audit(
          "emergency_submission_context_missing",
          "Successful emergency transaction evidence is missing its persisted order context; retry remains blocked.",
          { operationId: operation.operationId, signature: execution.targetSignature },
          "critical"
        );
        continue;
      }
      const swap = decodeSpotSwapTransaction(transaction, {
        signature: execution.targetSignature,
        wallet,
        detectedAt: new Date(),
        recovered: true,
        allowedSpotProgramIds: new Set([JUPITER_V6_PROGRAM_ID])
      });
      const valid =
        context.intent.side === "SELL" &&
        context.intent.sourcePositionId === operation.positionId &&
        context.intent.outputMint === USDC_MINT &&
        swap?.side === "SELL" &&
        swap.baseMint === USDC_MINT &&
        swap.targetMint === context.intent.inputMint &&
        BigInt(swap.targetAmountAtomic) > 0n &&
        BigInt(swap.targetAmountAtomic) <= BigInt(context.intent.inputAmountAtomic) &&
        BigInt(swap.baseAmountAtomic) > 0n;
      if (!valid || !swap) {
        this.repository.audit(
          "emergency_submission_evidence_mismatch",
          "Successful transaction evidence did not match the authorized emergency sell; retry remains blocked.",
          { operationId: operation.operationId, signature: execution.targetSignature },
          "critical"
        );
        continue;
      }
      execution.status = "CONFIRMED";
      execution.updatedAt = new Date().toISOString();
      execution.actualInputAtomic = swap.targetAmountAtomic;
      execution.actualOutputAtomic = swap.baseAmountAtomic;
      delete execution.failureReason;
      this.persistExecutionOutcome(execution);
      this.repository.updateEmergencyExitOperation(operation.positionId, "CONFIRMED", {
        executionId: execution.id,
        targetSignature: execution.targetSignature
      });
      this.repository.audit(
        "emergency_submission_confirmed_reconciled",
        "A previously ambiguous emergency transaction was confirmed and queued for idempotent ledger application.",
        { operationId: operation.operationId, signature: execution.targetSignature },
        "critical"
      );
    }
  }

  private async replayConfirmedApplications(): Promise<void> {
    for (const record of this.repository.listUnappliedConfirmedExecutions()) {
      const context = this.repository.getOrderContext(record.idempotencyKey);
      if (!context) {
        this.repository.audit("fill_replay_quarantined", "Confirmed execution has no persisted intent context.", {
          executionId: record.id
        }, "critical");
        continue;
      }
      try {
        await this.applyExecution({
          intent: context.intent,
          entryQuote: record.quote,
          decision: context.decision
        }, record);
        this.repository.audit("fill_replayed", "A previously confirmed fill was applied idempotently.", {
          executionId: record.id
        });
      } catch (error) {
        this.recordError("fill_replay_failed", error, { executionId: record.id });
      }
    }
  }

  private async replayUnprocessedSources(): Promise<void> {
    for (const swap of this.repository.listUnprocessedSourceEvents()) {
      try {
        await this.handleSwap(swap, true);
      } catch (error) {
        this.recordError("source_replay_failed", error, {
          signature: swap.sourceSignature,
          wallet: swap.sourceWallet
        });
      }
    }
  }

  private async reconcileLiveBalances(initialize: boolean): Promise<void> {
    const liveMode = this.executionMode() === "LIVE";
    if (!initialize && !liveMode) return;
    const wallet = this.repository.getSetting<string>("wallet_address");
    if (!wallet || !this.balanceReader) {
      if (initialize || liveMode) throw new Error("Dedicated wallet and Helius balance access are required for live reconciliation.");
      return;
    }
    const solPrice = await this.getSolPriceUsd();
    const balances = await this.balanceReader.read(wallet);
    const availableUsdc = balances.tokenAmounts.get(USDC_MINT) ?? 0n;

    if (initialize) {
      const initialNav =
        this.repository.getSetting<number>("paper_initial_nav_usd") ?? DEFAULT_RISK_POLICY.initialNavUsd;
      const initialUsdc = initialNav - DEFAULT_RISK_POLICY.initialSolAllocationUsd;
      const trackedSol = BigInt(Math.ceil((DEFAULT_RISK_POLICY.initialSolAllocationUsd / solPrice) * 1_000_000_000));
      const trackedUsdc = BigInt(
        Math.ceil(initialUsdc * 10 ** USDC_DECIMALS)
      );
      if (balances.solLamports < trackedSol || availableUsdc < trackedUsdc) {
        throw new Error(
          `Fund the dedicated bot wallet with at least $${DEFAULT_RISK_POLICY.initialSolAllocationUsd} of SOL and ${initialUsdc} USDC before entering MANUAL_LIVE.`
        );
      }
      this.repository.db.transaction(() => {
        this.repository.setSetting("live_tracked_sol_lamports", trackedSol.toString());
        this.repository.setSetting("live_tracked_usdc_atomic", trackedUsdc.toString());
        this.repository.setSetting("live_start_nav_usd", initialNav);
        const snapshot: PortfolioSnapshot = {
          mode: "LIVE",
          capturedAt: new Date().toISOString(),
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
        this.repository.savePortfolioSnapshot(snapshot);
        this.repository.audit("live_funding_reconciled", `Exactly $${initialNav} of wallet capital was allocated to the live ledger; excess deposits remain untouched.`, {
          wallet
        });
      })();
      return;
    }

    const trackedSolText = this.repository.getSetting<string>("live_tracked_sol_lamports");
    const trackedUsdcText = this.repository.getSetting<string>("live_tracked_usdc_atomic");
    if (!trackedSolText || !trackedUsdcText) {
      throw new Error("Live tracked-balance anchors are missing; signing remains disabled.");
    }
    const trackedSol = BigInt(trackedSolText);
    const trackedUsdc = BigInt(trackedUsdcText);
    let missingUsd =
      Number(trackedSol > balances.solLamports ? trackedSol - balances.solLamports : 0n) / 1_000_000_000 * solPrice +
      Number(trackedUsdc > availableUsdc ? trackedUsdc - availableUsdc : 0n) / 10 ** USDC_DECIMALS;
    const expectedByMint = new Map<string, bigint>();
    const positions = this.repository.listPositions("LIVE", true);
    for (const position of positions) {
      expectedByMint.set(
        position.mint,
        (expectedByMint.get(position.mint) ?? 0n) + BigInt(position.remainingAmountAtomic)
      );
    }
    for (const [mint, expected] of expectedByMint) {
      const actual = balances.tokenAmounts.get(mint) ?? 0n;
      if (actual >= expected) continue;
      const missing = expected - actual;
      const lots = positions.filter((position) => position.mint === mint);
      const expectedForLots = lots.reduce((sum, position) => sum + BigInt(position.remainingAmountAtomic), 0n);
      const executableValue = lots.reduce((sum, position) => sum + position.lastExecutableValueUsd, 0);
      if (expectedForLots > 0n) missingUsd += executableValue * (Number(missing) / Number(expectedForLots));
    }
    const current = this.currentPortfolio("LIVE");
    const deployedUsd = positions.reduce((sum, position) => sum + position.lastExecutableValueUsd, 0);
    const solReserveUsd = Number(trackedSol) / 1_000_000_000 * solPrice;
    const liquidReserveUsd = Number(trackedUsdc) / 10 ** USDC_DECIMALS + solReserveUsd;
    const navUsd = liquidReserveUsd + deployedUsd;
    const unresolved = this.repository.listSubmittedExecutions();
    const balanceMismatchPercent = unresolved.length > 0
      ? 100
      : navUsd > 0 ? missingUsd / navUsd * 100 : missingUsd > 0 ? 100 : 0;
    const snapshot: PortfolioSnapshot = {
      ...current,
      capturedAt: new Date().toISOString(),
      navUsd,
      peakNavUsd: Math.max(current.peakNavUsd, navUsd),
      deployedUsd,
      solReserveUsd,
      liquidReserveUsd,
      unrealizedPnlUsd: positions.reduce(
        (sum, position) => sum + position.lastExecutableValueUsd - position.remainingCostUsd,
        0
      ),
      openPositions: positions.length,
      balanceMismatchPercent
    };
    this.repository.savePortfolioSnapshot(snapshot);
    if (unresolved.length > 0) {
      this.repository.audit("submitted_execution_quarantined", "An execution was submitted before restart without final confirmation; signing is paused.", {
        executionIds: unresolved.map((record) => record.id)
      }, "critical");
    }
    if (balanceMismatchPercent > 1 && !["PAUSED", "LOCKED"].includes(this.modes.mode)) {
      this.modes.transition("PAUSED");
      this.repository.audit("balance_mismatch_pause", "On-chain balances differ from recorded bot lots by more than 1%; signing is paused.", {
        balanceMismatchPercent
      }, "critical");
      this.events.publish("mode", { mode: "PAUSED" });
    }
  }

  private async refreshHealth(includeBirdeye: boolean): Promise<void> {
    if (!this.providers) return;
    const activeProfile = this.vault.getDataProviderProfile();
    const tasks: Array<Promise<ProviderHealth>> = [
      this.providers.chain.checkHealth(),
      this.providers.token.checkHealth(),
      this.providers.swap.checkHealth(),
      this.checkAutonomousMarketHealth()
    ];
    if (includeBirdeye || activeProfile.mode === "SELF_HOSTED") {
      tasks.push(this.providers.discovery.checkHealth());
    }
    const results = await Promise.all(tasks);
    const tokenHealth = results.find((health, index) => health.provider === "jupiter" && index === 1);
    const swapHealth = results.find((health, index) => health.provider === "jupiter" && index === 2);
    const marketHealth = results.find((health, index) => health.provider === "jupiter" && index === 3);
    const combined = results.filter((health) => health.provider !== "jupiter");
    if (tokenHealth && swapHealth && marketHealth) {
      combined.push({
        provider: "jupiter",
        ok: tokenHealth.ok && swapHealth.ok && marketHealth.ok,
        checkedAt: new Date().toISOString(),
        latencyMs: Math.max(
          tokenHealth.latencyMs ?? 0,
          swapHealth.latencyMs ?? 0,
          marketHealth.latencyMs ?? 0
        ),
        message: tokenHealth.ok && swapHealth.ok && marketHealth.ok
          ? "Jupiter Tokens, market categories, and Swap v2 are healthy"
          : `${tokenHealth.message}; ${marketHealth.message}; ${swapHealth.message}`
      });
    }
    const heliusIndex = combined.findIndex((health) => health.provider === "helius");
    const streamStatus = this.providers.chain.getStreamStatus();
    if (heliusIndex >= 0 && streamStatus.active) {
      const rpcHealth = combined[heliusIndex]!;
      const streamHealth = this.providers.chain.getStreamHealth(60_000);
      combined[heliusIndex] = {
        ...rpcHealth,
        ok: rpcHealth.ok && streamHealth.ok,
        checkedAt: new Date().toISOString(),
        message: rpcHealth.ok && streamHealth.ok
          ? "Helius RPC and confirmed wallet stream are healthy"
          : `${rpcHealth.message}; ${streamHealth.message}`
      };
    }
    if (heliusIndex >= 0 && activeProfile.mode !== "MANAGED") {
      const rpcEvidenceHealthy = this.activeRpcReadinessHealthy(activeProfile, new Date());
      if (!rpcEvidenceHealthy) {
        const basic = combined[heliusIndex]!;
        combined[heliusIndex] = {
          ...basic,
          ok: false,
          checkedAt: new Date().toISOString(),
          message: `${basic.message}; full endpoint-bound RPC/WSS capability evidence is missing, stale, or unhealthy`
        };
      }
    }
    for (const health of combined) {
      this.repository.setProviderHealth(health);
      if (health.provider === "helius") {
        if (!health.ok && !this.repository.getSetting<string>("helius_unhealthy_since")) {
          this.repository.setSetting("helius_unhealthy_since", health.checkedAt);
        }
        if (health.ok) this.repository.setSetting("helius_unhealthy_since", null);
      }
    }
    this.recordSelfHostedPaperSoakHeartbeat(combined);
    this.events.publish("health", combined);
  }

  private async refreshHealthCycle(includeBirdeye: boolean): Promise<void> {
    await this.refreshActiveRpcReadiness();
    await this.refreshHealth(includeBirdeye);
  }

  private async refreshActiveRpcReadiness(): Promise<void> {
    const profile = this.vault.getDataProviderProfile();
    if (profile.mode === "MANAGED") return;
    const endpointFingerprint = dataProviderEndpointFingerprint(profile);
    if (!endpointFingerprint) return;
    if (this.rpcReadinessRefresh?.endpointFingerprint === endpointFingerprint) {
      return this.rpcReadinessRefresh.promise;
    }
    if (this.rpcReadinessRefresh) {
      await this.rpcReadinessRefresh.promise;
      return this.refreshActiveRpcReadiness();
    }
    const refresh = this.performActiveRpcReadinessRefresh(profile);
    this.rpcReadinessRefresh = { endpointFingerprint, promise: refresh };
    try {
      await refresh;
    } finally {
      if (this.rpcReadinessRefresh?.promise === refresh) this.rpcReadinessRefresh = undefined;
    }
  }

  private async performActiveRpcReadinessRefresh(
    profile: Exclude<DataProviderProfile, { mode: "MANAGED" }>
  ): Promise<void> {
    try {
      const health = await this.validateDataProviderProfile(profile);
      this.repository.setProviderHealth(health);
    } catch (error) {
      // Clearing the endpoint-bound record is durable. Neither a previously
      // fresh result nor a basic getHealth probe may mask a failed full cycle.
      this.repository.setSetting(RPC_READINESS_SETTING, null);
      this.repository.setSetting(EMERGENCY_EXIT_RPC_STATUS_SETTING, null);
      this.repository.setProviderHealth({
        provider: "helius",
        ok: false,
        checkedAt: new Date().toISOString(),
        message: `Self-hosted full RPC/WSS diagnostic failed: ${this.errorText(error)}`
      });
    }
  }

  private activeRpcReadinessHealthy(profile: DataProviderProfile, now: Date): boolean {
    const readiness = activeRpcReadiness(
      profile,
      this.repository.getSetting<StoredDataProviderRpcReadiness>(RPC_READINESS_SETTING)
    );
    const checkedAt = readiness ? Date.parse(readiness.checkedAt) : Number.NaN;
    return Boolean(
      readiness?.ok &&
      readiness.fullCapabilitiesOk &&
      readiness.websocketOk &&
      Number.isFinite(checkedAt) &&
      now.getTime() - checkedAt <= SELF_HOSTED_PAPER_SOAK_MAXIMUM_AGE_MS
    );
  }

  private recordSelfHostedPaperSoakHeartbeat(healthResults: readonly ProviderHealth[]): void {
    const profile = this.vault.getDataProviderProfile();
    if (profile.mode !== "SELF_HOSTED" || this.modes.mode !== "PAPER") return;
    const endpointFingerprint = selfHostedEndpointFingerprint(profile);
    if (!endpointFingerprint) return;
    const observedAt = new Date();
    const chain = healthResults.find((health) => health.provider === "helius");
    const discovery = healthResults.find((health) => health.provider === "birdeye");
    const headCheckpoints = this.repository.listWalletIndexCheckpoints("helius-jupiter-program-head");
    const indexCoverage = this.repository.walletIndexCoverage(observedAt);
    const indexHealthy =
      indexCoverage.indexedWallets > 0 &&
      indexCoverage.indexedTransactions > 0 &&
      completeFreshIndexHeadCoverage(headCheckpoints, DEFAULT_SPOT_SWAP_PROGRAM_IDS, observedAt);
    const priceCoverage = this.repository.solPriceCoverage();
    const newestPriceAt = Date.parse(priceCoverage.newestAt ?? "");
    const priceHealthy =
      priceCoverage.count > 0 &&
      priceCoverage.pendingSwapReprices === 0 &&
      Number.isFinite(newestPriceAt) &&
      observedAt.getTime() - newestPriceAt <= SELF_HOSTED_PAPER_SOAK_MAXIMUM_AGE_MS &&
      priceCoverage.largestGapSeconds <= 10 * 60;
    const emergencyRpcHealthy = emergencyExitRpcFresh(activeEmergencyExitRpcStatus(
      profile,
      this.repository.getSetting<StoredEmergencyExitRpcStatus>(EMERGENCY_EXIT_RPC_STATUS_SETTING)
    ), observedAt);
    const localOperationsHealthy = !this.operationalTelemetry(observedAt).blocksNewEntries;
    this.repository.recordSelfHostedPaperSoakHeartbeat({
      endpointFingerprint,
      observedAt: observedAt.toISOString(),
      health: {
        discovery: discovery?.ok === true,
        chain: chain?.ok === true &&
          this.activeRpcReadinessHealthy(profile, observedAt) &&
          emergencyRpcHealthy,
        index: indexHealthy && localOperationsHealthy,
        price: priceHealthy
      }
    });
  }

  private async monitorPositions(): Promise<void> {
    if (this.positionCheckRunning || !this.providers || ["SETUP", "LOCKED"].includes(this.modes.mode)) return;
    this.positionCheckRunning = true;
    try {
      const mode = this.executionMode();
      const unpricedPositionIds: string[] = [];
      for (const position of this.repository.listPositions(mode, true)) {
        try {
          const quote = await this.providers.quotes.quote({
            inputMint: position.mint,
            outputMint: USDC_MINT,
            inputAmountAtomic: position.remainingAmountAtomic
          });
          const token = await this.getToken(position.mint, true).catch((error) =>
            unknownToken(position.mint, this.errorText(error))
          );
          const updated = { ...position, lastExecutableValueUsd: quote.outputUsd };
          this.repository.upsertPosition(updated);
          const force = shouldForcePositionExit(updated, new Date(), token.eligible);
          if (force.force) await this.forceExitPosition(updated, force.reasons.join("; "), "FORCED_EXIT");
        } catch (error) {
          unpricedPositionIds.push(position.id);
          this.recordError("position_quote", error, { positionId: position.id });
        }
      }
      if (mode === "LIVE") await this.reconcileLiveBalances(false);
      else {
        this.refreshMarkedPortfolio("PAPER", unpricedPositionIds);
        // Marketplace valuation is copied only after both the source position
        // rows and strict PAPER portfolio mark have been committed.
        this.marketplaceMirror.afterStrictMarks();
      }
      this.syncHeliusStreamHealth();
      await this.evaluateStops();
    } finally {
      this.positionCheckRunning = false;
    }
  }

  private async forceExitPosition(
    position: PositionLot,
    reason: string,
    action: "FORCED_EXIT" | "EMERGENCY_EXIT",
    operation?: EmergencyExitOperation
  ): Promise<boolean> {
    const now = new Date();
    const source: LeaderSwap = {
      sourceSignature: operation?.sourceSignature ?? `${action.toLowerCase()}:${position.id}:${now.getTime()}`,
      sourceWallet: position.sourceWallet,
      slot: 0,
      blockTime: now.toISOString(),
      detectedAt: now.toISOString(),
      side: "SELL",
      baseMint: USDC_MINT,
      targetMint: position.mint,
      baseAmountAtomic: "0",
      targetAmountAtomic: position.remainingAmountAtomic,
      baseAmountUi: 0,
      targetAmountUi: 0,
      leaderPriceUsd: 0,
      recovered: false
    };
    this.repository.insertSourceEvent(source);
    this.repository.audit("forced_exit", reason, { positionId: position.id, action }, "warning");
    return this.executePositionExit(position, source, 1, true, true);
  }

  private prepareEmergencyExitOperation(
    liquidationId: string,
    position: PositionLot
  ): EmergencyExitOperation {
    const prior = this.repository.getEmergencyExitOperation(position.id);
    if (prior && prior.state !== "FAILED_SAFE") return prior;
    const attempt = prior ? prior.attempt + 1 : 1;
    const sourceSignature = `emergency-exit:${position.id}:attempt:${attempt}`;
    const idempotencyKey = createIdempotencyKey({
      sourceSignature,
      sourceWallet: position.sourceWallet,
      mint: position.mint,
      action: "FORCED_EXIT"
    });
    return this.repository.startEmergencyExitAttempt({
      liquidationId,
      positionId: position.id,
      idempotencyKey,
      sourceSignature
    });
  }

  private async evaluateStops(
    manualRecheck = false,
    latestActionableQuote?: QuoteSnapshot
  ): Promise<OperationalPauseState> {
    const mode = this.executionMode();
    const portfolio = this.currentPortfolio(mode);
    const liveStartNavUsd = this.repository.getSetting<number>("live_start_nav_usd");
    const heliusUnhealthySince = this.repository.getSetting<string>("helius_unhealthy_since");
    const previousPause = this.operationalPauseState();
    const stop = evaluateOperationalStops({
      portfolio,
      ...(liveStartNavUsd !== undefined ? { liveStartNavUsd } : {}),
      providerHealth: this.repository.listProviderHealth(),
      ...(heliusUnhealthySince ? { heliusUnhealthySince } : {}),
      ...(latestActionableQuote ? { latestQuote: latestActionableQuote } : {}),
      recentExecutions: this.repository.listExecutions(100)
    });
    const reasons: OperationalPauseReason[] = [...stop.reasons];
    if (this.monitoringRepairPending() && !reasons.includes("HISTORY_GAP_REPAIR")) {
      reasons.push("HISTORY_GAP_REPAIR");
    }
    if (
      this.operationalTelemetry().blocksNewEntries &&
      !reasons.includes("LOCAL_DATA_UNHEALTHY")
    ) {
      reasons.push("LOCAL_DATA_UNHEALTHY");
    }
    if (
      !latestActionableQuote &&
      previousPause.active &&
      previousPause.reasons.includes("STALE_QUOTE") &&
      !reasons.includes("STALE_QUOTE")
    ) reasons.push("STALE_QUOTE");
    if (stop.action === "LOCK_AND_LIQUIDATE" && !this.emergencyActive) {
      const state = this.persistOperationalPause(reasons, manualRecheck);
      this.repository.audit("hard_stop", `Hard stop: ${stop.reasons.join(", ")}`, stop, "critical");
      await this.emergencyExit();
      return state;
    }
    return this.persistOperationalPause(reasons, manualRecheck, stop);
  }

  private persistOperationalPause(
    reasons: Parameters<typeof resolveOperationalPause>[1],
    manualRecheck: boolean,
    details?: unknown
  ): OperationalPauseState {
    const previous = this.operationalPauseState();
    const next = resolveOperationalPause(previous, reasons, new Date(), manualRecheck);
    this.repository.setSetting("operational_pause_state", next);
    this.repository.setSetting("new_entries_paused", next.active);
    this.repository.setSetting(
      "soft_pause_date",
      next.active && next.pausedAt ? next.pausedAt.slice(0, 10) : null
    );

    const reasonsChanged = previous.reasons.join("|") !== next.reasons.join("|");
    if (next.active && (!previous.active || reasonsChanged)) {
      this.repository.audit(
        "entries_paused",
        `New entries paused: ${next.reasons.join(", ")}`,
        details ?? next,
        "warning"
      );
    } else if (previous.active && !next.active) {
      this.repository.audit(
        "entries_resumed",
        manualRecheck
          ? "New-entry safety pause cleared after an explicit clean recheck."
          : "New-entry safety pause cleared after its recovery condition was satisfied.",
        next
      );
    }
    if (previous.active !== next.active || reasonsChanged) {
      this.events.publish("operational-pause", next);
    }
    return next;
  }

  private refreshMarkedPortfolio(mode: "PAPER" | "LIVE", quoteFailures: readonly string[] = []): void {
    const current = this.currentPortfolio(mode);
    const positions = this.repository.listPositions(mode, true);
    const evaluationCohortId = mode === "PAPER"
      ? this.repository.activePaperEvaluationCohort()?.id
      : undefined;
    const unpricedPositionIds = [...new Set([
      ...quoteFailures,
      ...positions
        .filter((position) =>
          !Number.isFinite(position.lastExecutableValueUsd) ||
          position.lastExecutableValueUsd < 0 ||
          (mode === "PAPER" && position.evaluationCohortId !== evaluationCohortId)
        )
        .map((position) => position.id)
    ])];
    const deployedUsd = positions.reduce((sum, position) => sum + position.lastExecutableValueUsd, 0);
    const navUsd = current.liquidReserveUsd + deployedUsd;
    const snapshot: PortfolioSnapshot = {
      ...current,
      capturedAt: new Date().toISOString(),
      navUsd,
      peakNavUsd: Math.max(current.peakNavUsd, navUsd),
      deployedUsd,
      unrealizedPnlUsd: positions.reduce(
        (sum, position) => sum + position.lastExecutableValueUsd - position.remainingCostUsd,
        0
      ),
      openPositions: positions.length,
      ...(evaluationCohortId ? { evaluationCohortId } : {}),
      executablePricingComplete: unpricedPositionIds.length === 0,
      ...(unpricedPositionIds.length > 0 ? { unpricedPositionIds } : {})
    };
    this.repository.savePortfolioSnapshot(snapshot);
    this.events.publish("portfolio", snapshot);
  }

  private syncHeliusStreamHealth(): void {
    if (!this.providers) return;
    const status = this.providers.chain.getStreamStatus();
    if (!status.active) return;
    const health = this.providers.chain.getStreamHealth(60_000);
    this.repository.setProviderHealth(health);
    const unhealthySince = this.repository.getSetting<string>("helius_unhealthy_since");
    if (!health.ok && !unhealthySince) {
      this.repository.setSetting("helius_unhealthy_since", health.checkedAt);
    } else if (health.ok && unhealthySince) {
      this.repository.setSetting("helius_unhealthy_since", null);
    }
    this.events.publish("health", [health]);
  }

  private async refreshDiscoveryIfDue(
    expectedGeneration = this.providerWorkGeneration
  ): Promise<void> {
    if (!this.isProviderWorkCurrent(expectedGeneration)) return;
    await this.processResearchHandoffs(expectedGeneration);
    this.assertProviderWorkCurrent(expectedGeneration);
    if (this.repository.hasPendingWalletResearchHandoffs()) {
      return;
    }
    const latest = this.repository.latestCohort();
    if (
      this.providerDiscoveryRequired ||
      !latest ||
      Date.now() - Date.parse(latest.generatedAt) >= 7 * 86_400_000
    ) {
      await this.refreshDiscovery([], expectedGeneration);
    }
  }

  private expireRestartedApprovals(): void {
    for (const record of this.repository.listExecutions(500, true)) {
      record.status = "REJECTED";
      record.updatedAt = new Date().toISOString();
      record.failureReason = "App restarted; the cached Jupiter order expired and was never signed.";
      this.persistExecutionOutcome(record);
    }
  }

  private errorText(error: unknown): string {
    return redactSensitiveText(error instanceof Error ? error.message : "Unknown runtime error");
  }

  private recordError(event: string, error: unknown, details?: Record<string, unknown>): void {
    const message = this.errorText(error);
    this.repository.audit(event, message, details, "warning");
    this.events.publish("runtime-error", { event, message, ...details });
  }
}
