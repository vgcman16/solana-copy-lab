export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

export type IsoDateTime = string;
export type PublicKeyString = string;
export type TransactionSignature = string;
export type AtomicAmount = string;

export type ModeState =
  | "SETUP"
  | "PAPER"
  | "MANUAL_LIVE"
  | "AUTO_LIVE"
  | "PAUSED"
  | "LOCKED";

export type TradeSide = "BUY" | "SELL";
export type ExecutionMode = "PAPER" | "LIVE";
export type ExecutionStatus =
  | "QUEUED"
  | "AWAITING_APPROVAL"
  | "APPROVED"
  | "REJECTED"
  | "SUBMITTED"
  | "SUBMITTED_UNRESOLVED"
  | "CONFIRMED"
  | "FAILED"
  | "SKIPPED";

export type ProviderName = "birdeye" | "helius" | "jupiter" | "pyth";
export type ProviderUsageSource =
  | ProviderName
  | "solana_rpc"
  | "helius_index"
  | "pyth_benchmarks"
  | "alpaca_iex";
export const DEFAULT_BIRDEYE_MONTHLY_CU_BUDGET = 27_000;

export type DataProviderMode = "MANAGED" | "SHADOW" | "SELF_HOSTED";

export interface DataProviderProfile {
  mode: DataProviderMode;
  /** Standard Solana JSON-RPC endpoint. Stored only in the encrypted vault. */
  solanaHttpUrl?: string;
  /** Standard Solana WebSocket endpoint. Stored only in the encrypted vault. */
  solanaWsUrl?: string;
  /**
   * Independent HTTP RPC used only to validate and reconcile recorded-position
   * exits. It is never a source for new entries or silent provider failover.
   */
  emergencySolanaHttpUrl?: string;
}

export interface DataProviderProfileSummary {
  mode: DataProviderMode;
  configured: boolean;
  httpOrigin?: string;
  wsOrigin?: string;
  emergencyHttpOrigin?: string;
}

export interface DataProviderParitySummary {
  observations: number;
  latestMatches: number;
  latestDivergences: number;
  latestUnavailable: number;
  latestPending: number;
  matchedCapabilities: string[];
  /** Distinct matching subjects observed for each capability in the current proof epoch. */
  matchedSubjectCounts: Record<string, number>;
  /** Wallets independently matching PnL, history, and gap replay in the same proof epoch. */
  commonReplayWallets: number;
  evidenceDays: number;
  latestHealthAt?: IsoDateTime;
  largestHealthGapSeconds?: number;
  /** Only ACTIVE, digest-verified evidence for this epoch contributes to the counts above. */
  proofEpochId?: string;
  proofEpochStatus?: "PREPARED" | "ACTIVE" | "INVALIDATED";
  manifestDigest?: string;
  replaySubjects?: number;
  winnerSubjects?: number;
  controlSubjects?: number;
  invalidOrUnboundObservations?: number;
  baselineRunId?: string;
  baselineRunStatus?: "PREPARING" | "PREPARED" | "CAPTURING" | "BLOCKED" | "ACTIVE" | "FAILED";
  baselineBlockerCodes?: string[];
}

export interface SolPriceCoverageSummary {
  count: number;
  /** SOL-legged indexed swaps still waiting for an at-or-before USD mark. */
  pendingSwapReprices?: number;
  /** Older pending rows retained for audit outside the supported 90-day price horizon. */
  outOfHorizonSwapReprices?: number;
  oldestAt?: IsoDateTime;
  newestAt?: IsoDateTime;
  /** Largest interval between adjacent durable prices in the retained window. */
  largestGapSeconds?: number;
}

export type SolPriceBootstrapPhase =
  | "RUNNING"
  | "RETRY_WAIT"
  | "PAUSED"
  | "COMPLETE"
  | "FAILED";

/** Redacted, operator-safe progress for the optional historical SOL/USD bootstrap. */
export interface SolPriceBootstrapStatus {
  phase: "IDLE" | SolPriceBootstrapPhase;
  activeInProcess: boolean;
  authenticationConfigured: boolean;
  /** Redacted provider capability; never exposes either credential. */
  pythAuthenticationConfigured?: boolean;
  managedFallbackConfigured?: boolean;
  activeSource?:
    | "pyth_benchmarks"
    | "birdeye_ohlcv_v3"
    | "birdeye_ohlcv_v3_prev_5m";
  checkpointValid: boolean;
  feedId: string;
  intervalSeconds: number;
  horizonDays: number;
  totalPoints: number;
  completedPoints: number;
  remainingPoints: number;
  insertedSnapshots: number;
  preservedSnapshots: number;
  progressPercent: number;
  cursorAttempts: number;
  windowStartAt?: IsoDateTime;
  windowEndAt?: IsoDateTime;
  /** Current exact ten-minute target after the provider publication-lag guard. */
  currentWindowEndAt?: IsoDateTime;
  /** Non-negative distance from the frozen generation end to the current target. */
  windowLagSeconds?: number;
  /** True only when an explicit start may create a newer insert-only generation. */
  refreshAvailable?: boolean;
  nextTimestampAt?: IsoDateTime;
  startedAt?: IsoDateTime;
  updatedAt?: IsoDateTime;
  nextRetryAt?: IsoDateTime;
  completedAt?: IsoDateTime;
  lastError?: string;
}

export type DataProviderRpcCapability =
  | "GET_HEALTH"
  | "CONFIRMED_HEAD"
  | "ARCHIVE_HISTORY"
  | "SIGNATURE_HISTORY"
  | "FULL_TRANSACTION"
  | "FULL_BLOCK"
  | "BALANCE_READS";

export interface DataProviderRpcCapabilityDiagnostic {
  capability: DataProviderRpcCapability;
  status: "PASS" | "FAIL" | "BLOCKED";
  latencyMs: number;
  message: string;
  evidence: Record<string, string | number | boolean>;
}

/** Redacted standard-RPC evidence safe to return through the loopback API. */
export interface DataProviderRpcReadinessSummary {
  checkedAt: IsoDateTime;
  ok: boolean;
  fullCapabilitiesOk: boolean;
  websocketOk: boolean;
  websocketLatencyMs: number;
  websocketMessage: string;
  minimumArchiveDays: number;
  capabilities: DataProviderRpcCapabilityDiagnostic[];
}

export interface SelfHostedPaperSoakHealth {
  discovery: boolean;
  chain: boolean;
  index: boolean;
  price: boolean;
}

/**
 * Independent proof that the exact active self-hosted endpoints have operated
 * safely in PAPER mode. Shadow parity unlocks the provider switch; this later
 * soak unlocks the first transition into MANUAL_LIVE.
 */
export interface SelfHostedPaperSoakSummary {
  active: boolean;
  ready: boolean;
  requiredDays: number;
  elapsedDays: number;
  heartbeatCount: number;
  startedAt?: IsoDateTime;
  latestHeartbeatAt?: IsoDateTime;
  largestGapSeconds?: number;
  latestHealth?: SelfHostedPaperSoakHealth;
  blockers: string[];
}

export interface DataProviderStatus {
  profile: DataProviderProfileSummary;
  emergencyExitRpc: EmergencyExitRpcStatus;
  priceCoverage: SolPriceCoverageSummary;
  parity: DataProviderParitySummary;
  rpcReadiness?: DataProviderRpcReadinessSummary;
  selfHostedPaperSoak: SelfHostedPaperSoakSummary;
  selfHostedReady: boolean;
  blockers: string[];
}

/** Redacted liveness/capability evidence for the independent exit-only RPC. */
export interface EmergencyExitRpcStatus {
  configured: boolean;
  ok: boolean;
  checkedAt?: IsoDateTime;
  message: string;
}

export interface ProviderCredentials {
  /** Required only while MANAGED or SHADOW data remains enabled. */
  birdeyeApiKey?: string;
  /** Required only while MANAGED or SHADOW data remains enabled. */
  heliusApiKey?: string;
  /** Jupiter remains the token-risk, quote, and execution provider in every mode. */
  jupiterApiKey: string;
  /** Optional Pyth Benchmarks bearer key for the historical SOL/USD bootstrap. */
  pythBenchmarksApiKey?: string;
}

/** Alpaca credentials are isolated from the Solana provider composition. */
export interface AlpacaPaperCredentials {
  apiKey: string;
  secretKey: string;
}

/**
 * Operator-safe status for the optional US-stock PAPER connection. Account
 * identifiers, balances, credentials, and provider payloads are never exposed.
 */
export interface AlpacaPaperStatus {
  configured: boolean;
  connected: boolean;
  paperOnly: true;
  liveOrderCapabilityEnabled: false;
  marketDataFeed: "IEX";
  tradingEndpoint: "paper-api.alpaca.markets";
  dataEndpoint: "data.alpaca.markets";
  accountStatus?: string;
  checkedAt?: IsoDateTime;
  latencyMs?: number;
  message: string;
}

export interface ProviderHealth {
  provider: ProviderName;
  ok: boolean;
  checkedAt: IsoDateTime;
  latencyMs?: number;
  message: string;
  usage?: {
    /** Physical provider that incurred these requests, distinct from a logical health slot. */
    provider?: ProviderUsageSource;
    requests: number;
    /** Durable billable/provider credits reserved before physical request attempts. */
    credits?: number;
    creditLimit?: number;
    creditUnit?: "CU" | "credits";
    limit?: number;
    window: "day" | "month" | "unknown";
  };
}

export type LiveOperationSourceId =
  | "birdeye"
  | "helius"
  | "solana_rpc"
  | "jupiter"
  | "pyth_benchmarks"
  | "alpaca_iex"
  | "local_index";

export type LiveOperationScope = "CRYPTO" | "STOCK" | "LOCAL";
export type LiveOperationStatus = "ONLINE" | "DEGRADED" | "OFFLINE" | "IDLE" | "UNCONFIGURED";
export type LiveOperationPressure = "LOW" | "MEDIUM" | "HIGH" | "UNKNOWN";
export type LiveActivityKind =
  | "API"
  | "SCAN"
  | "SIGNAL"
  | "SIMULATION"
  | "POSITION"
  | "LEARNING"
  | "SAFETY"
  | "SYSTEM";
export type LiveActivityTone = "INFO" | "SUCCESS" | "WARNING" | "CRITICAL";

/** A deliberately scalar, credential-free view of one provider or local engine. */
export interface LiveOperationSource {
  id: LiveOperationSourceId;
  label: string;
  scope: LiveOperationScope;
  status: LiveOperationStatus;
  checkedAt?: IsoDateTime;
  latencyMs?: number;
  message: string;
  usage: {
    requests: number;
    credits?: number;
    limit?: number;
    unit?: "requests" | "CU" | "credits";
    window: "month" | "unknown";
    percent?: number;
    pressure: LiveOperationPressure;
  };
  lastEventAt?: IsoDateTime;
  lastEvent?: string;
  /** Bounded scalar metrics only. No credentials, endpoints, request bodies, or provider payloads. */
  metrics: Record<string, string | number | boolean>;
}

/** Sanitized event for the live dashboard rail. IDs are local display keys, not provider secrets. */
export interface LiveActivityEvent {
  id: string;
  at: IsoDateTime;
  source: LiveOperationSourceId;
  kind: LiveActivityKind;
  tone: LiveActivityTone;
  summary: string;
  detail?: string;
  metrics?: Record<string, string | number | boolean>;
}

/** Unified read-only live-operations view. All counts are explicitly bounded to the dashboard window. */
export interface LiveOperationsSnapshot {
  capturedAt: IsoDateTime;
  paperOnly: boolean;
  liveOrderCapabilityEnabled: boolean;
  stream: {
    transport: "SSE";
    refreshOnEvent: true;
    credentialFieldsExposed: false;
    rawProviderPayloadsExposed: false;
  };
  sources: LiveOperationSource[];
  activity: LiveActivityEvent[];
  totals: {
    recentAcceptedSignals: number;
    recentRejectedSignals: number;
    recentSimulatedActions: number;
    openPositions: number;
  };
}

export interface WalletPnlWindow {
  duration: "30d" | "90d";
  realizedProfitUsd: number;
  realizedProfitPercent: number;
  unrealizedProfitUsd: number;
  totalTrades: number;
  wins: number;
  losses: number;
}

export interface WalletCandidate {
  address: PublicKeyString;
  cohortId: string;
  firstSeenAt: IsoDateTime;
  lastSeenAt: IsoDateTime;
  sourceRank30d?: number;
  sourceRank90d?: number;
  control: boolean;
  tags: string[];
  pnl30d?: WalletPnlWindow;
  pnl90d?: WalletPnlWindow;
}

export interface WalletScore {
  wallet: PublicKeyString;
  calculatedAt: IsoDateTime;
  qualified: boolean;
  reasons: string[];
  historyDays: number;
  closedEligibleSwaps: number;
  activeWeeks: number;
  medianHoldingMinutes: number;
  topTokenProfitShare: number;
  topThreeProfitShare: number;
  forwardNetReturnPercent?: number;
  forwardProfitFactor?: number;
  forwardMaxDrawdownPercent?: number;
  bootstrapReturnFloorPercent?: number;
}

export interface LeaderSwap {
  sourceSignature: TransactionSignature;
  sourceWallet: PublicKeyString;
  slot: number;
  blockTime: IsoDateTime;
  detectedAt: IsoDateTime;
  side: TradeSide;
  baseMint: typeof SOL_MINT | typeof USDC_MINT;
  targetMint: PublicKeyString;
  baseAmountAtomic: AtomicAmount;
  targetAmountAtomic: AtomicAmount;
  baseAmountUi: number;
  targetAmountUi: number;
  leaderPriceUsd: number;
  recovered: boolean;
}

/**
 * Scalar attribution for swap-like activity rejected before it can become an
 * executable LeaderSwap. It deliberately omits amounts and prices so this
 * evidence cannot be passed to the broker or risk engine by mistake.
 */
export interface RejectedSourceAction {
  sourceSignature: TransactionSignature;
  sourceWallet: PublicKeyString;
  slot: number;
  blockTime: IsoDateTime;
  detectedAt: IsoDateTime;
  side: TradeSide;
  baseMint: typeof SOL_MINT | typeof USDC_MINT;
  targetMint: PublicKeyString;
  recovered: boolean;
}

export interface TokenEligibility {
  mint: PublicKeyString;
  checkedAt: IsoDateTime;
  eligible: boolean;
  reasons: string[];
  name?: string;
  symbol?: string;
  decimals?: number;
  tokenProgram?: string;
  verified: boolean;
  suspicious: boolean;
  mintAuthorityDisabled: boolean;
  freezeAuthorityDisabled: boolean;
  firstPoolAt?: IsoDateTime;
  liquidityUsd: number;
  volume24hUsd: number;
  holderCount: number;
  organicScore: number;
  topHoldersPercent: number;
}

export interface QuoteSnapshot {
  requestId: string;
  quotedAt: IsoDateTime;
  inputMint: PublicKeyString;
  outputMint: PublicKeyString;
  inputAmountAtomic: AtomicAmount;
  outputAmountAtomic: AtomicAmount;
  inputUsd: number;
  outputUsd: number;
  priceImpactPercent: number;
  slippageBps: number;
  feeBps: number;
  signatureFeeLamports: number;
  prioritizationFeeLamports: number;
  rentFeeLamports: number;
  minimumOutputAtomic: AtomicAmount;
  router: string;
  transactionBase64?: string;
  expiresAt?: IsoDateTime;
}

export interface CopyIntent {
  id: string;
  idempotencyKey: string;
  createdAt: IsoDateTime;
  sourceSwap: LeaderSwap;
  side: TradeSide;
  inputMint: PublicKeyString;
  outputMint: PublicKeyString;
  inputAmountAtomic: AtomicAmount;
  inputAmountUsd: number;
  sourcePositionId?: string;
}

export type RiskReasonCode =
  | "ALLOWED"
  | "MODE_BLOCKED"
  | "STALE_SIGNAL"
  | "RECOVERED_SIGNAL"
  | "TOKEN_INELIGIBLE"
  | "NO_SELL_QUOTE"
  | "PRICE_DIVERGENCE"
  | "PRICE_IMPACT"
  | "ROUND_TRIP_COST"
  | "MAX_POSITIONS"
  | "MAX_DEPLOYED"
  | "INSUFFICIENT_RESERVE"
  | "DUPLICATE_POSITION"
  | "DAILY_LOSS_STOP"
  | "HARD_DRAWDOWN_STOP"
  | "PROVIDER_UNHEALTHY"
  | "BALANCE_MISMATCH"
  | "DUPLICATE_SIGNAL"
  | "UNKNOWN_TRANSACTION"
  | "QUOTE_EXPIRED";

export interface RiskDecision {
  allowed: boolean;
  code: RiskReasonCode;
  reasons: string[];
  decidedAt: IsoDateTime;
  projectedRoundTripCostPercent?: number;
  followerPriceDivergencePercent?: number;
  positionSizeUsd?: number;
}

export type SignalOutcomeAction = TradeSide | "FORCED_EXIT" | "EMERGENCY_EXIT";

export type SignalOutcomeStatus =
  | "ANALYSIS_ONLY"
  | "BLOCKED"
  | "RETRY_PENDING"
  | "REJECTED"
  | "QUEUED"
  | "AWAITING_APPROVAL"
  | "APPROVED"
  | "SUBMITTED"
  | "SUBMITTED_UNRESOLVED"
  | "SIMULATED"
  | "CONFIRMED"
  | "FAILED";

export type SignalOutcomeReasonCode =
  | "RECOVERED_SOURCE"
  | "STALE_SOURCE"
  | "UNSUPPORTED_PROGRAM_ACTIVITY"
  | "MONITORING_GAP"
  | "EMERGENCY_ACTIVE"
  | "SHADOW_WALLET"
  | "MODE_BLOCKED"
  | "NO_BOT_POSITION"
  | "EXIT_ALREADY_PENDING"
  | "EXIT_ALREADY_SATISFIED"
  | "PARTIAL_EXIT_ACCUMULATED"
  | "PROVIDER_ERROR"
  | "RISK_ALLOWED"
  | "RISK_REJECTED"
  | "PAPER_SIMULATION"
  | "LIVE_QUEUED"
  | "LIVE_APPROVAL_REQUIRED"
  | "LIVE_APPROVED"
  | "LIVE_SUBMITTED"
  | "SUBMISSION_UNRESOLVED"
  | "LIVE_CONFIRMED"
  | "EXECUTION_FAILED"
  | "USER_REJECTED"
  | "EMERGENCY_CANCELLED";

/**
 * Scalar-only operator view of one copied source action. It deliberately omits
 * serialized intents, token-provider payloads, and unsigned/signed transactions.
 */
export interface SignalAuditRecord {
  id: string;
  idempotencyKey: string;
  sourceSignature: TransactionSignature;
  sourceWallet: PublicKeyString;
  mint: PublicKeyString;
  action: SignalOutcomeAction;
  mode: ExecutionMode;
  status: SignalOutcomeStatus;
  reasonCode: SignalOutcomeReasonCode;
  reason: string;
  sourceBlockTime: IsoDateTime;
  observedAt: IsoDateTime;
  updatedAt: IsoDateTime;
  decisionCode?: RiskReasonCode;
  executionId?: string;
  targetSignature?: TransactionSignature;
  positionValueUsd?: number;
  priceImpactPercent?: number;
  actualFeesUsd?: number;
  implementationShortfallPercent?: number;
}

export interface PositionLot {
  id: string;
  mode: ExecutionMode;
  sourceWallet: PublicKeyString;
  sourceEntrySignature: TransactionSignature;
  mint: PublicKeyString;
  openedAt: IsoDateTime;
  entryAmountAtomic: AtomicAmount;
  remainingAmountAtomic: AtomicAmount;
  entryCostUsd: number;
  remainingCostUsd: number;
  lastExecutableValueUsd: number;
  pendingExitFraction: number;
  status: "OPEN" | "CLOSING" | "CLOSED" | "DUST";
  closedAt?: IsoDateTime;
  /** Frozen forward-paper cohort that authorized this lot. */
  evaluationCohortId?: string;
}

export interface ExecutionRecord {
  id: string;
  idempotencyKey: string;
  intentId: string;
  mode: ExecutionMode;
  status: ExecutionStatus;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  sourceSignature: TransactionSignature;
  targetSignature?: TransactionSignature;
  quote: QuoteSnapshot;
  actualInputAtomic?: AtomicAmount;
  actualOutputAtomic?: AtomicAmount;
  actualFeesUsd?: number;
  implementationShortfallPercent?: number;
  failureReason?: string;
  policyViolation?: string;
  approvedAt?: IsoDateTime;
  /** Persisted before broadcast so a lost execute response remains quarantined across restarts. */
  submittedAt?: IsoDateTime;
}

export interface PromotionGate {
  evaluatedAt: IsoDateTime;
  /** Kept for dashboard compatibility; this is the frozen cohort time, not setup time. */
  paperStartAt?: IsoDateTime;
  evaluationCohortId?: string;
  evaluationCohortStartAt?: IsoDateTime;
  observationDays?: number;
  largestObservationGapSeconds?: number;
  observationCurrent?: boolean;
  executablePricingComplete?: boolean;
  elapsedDays: number;
  completedExits: number;
  netReturnPercent: number;
  profitFactor: number;
  maxDrawdownPercent: number;
  positiveWeeks: number;
  largestTradeProfitShare: number;
  topThreeProfitShare: number;
  stressNetReturnPercent: number;
  stressMaxDrawdownPercent: number;
  qualifyingWallets: number;
  manualLiveOrders: number;
  manualCompletedPositions: number;
  paperShortfallP95Percent: number;
  manualWorstShortfallPercent: number;
  manualPolicyViolations: number;
  paperPassed: boolean;
  manualLivePassed: boolean;
  blockers: string[];
}

export interface PortfolioSnapshot {
  mode: ExecutionMode;
  capturedAt: IsoDateTime;
  navUsd: number;
  peakNavUsd: number;
  dayStartNavUsd: number;
  deployedUsd: number;
  solReserveUsd: number;
  liquidReserveUsd: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  openPositions: number;
  balanceMismatchPercent: number;
  /** Identifies the forward cohort whose promotion evidence this mark belongs to. */
  evaluationCohortId?: string;
  /** False when any open lot lacked a fresh full-position executable quote. */
  executablePricingComplete?: boolean;
  unpricedPositionIds?: string[];
}

export const RESEARCH_PAPER_LABEL = "HIGH-RISK PAPER — RESEARCH ONLY" as const;

export const DEFAULT_RESEARCH_PAPER_WATCHLIST_TARGET = 25;
export const MAXIMUM_RESEARCH_PAPER_WATCHLIST_TARGET = 100;
export const DEFAULT_RESEARCH_PAPER_PROVIDER_SNAPSHOT_MAX_AGE_DAYS = 7;
export const DEFAULT_RESEARCH_PAPER_ACTIVITY_WINDOW_DAYS = 30;
export const DEFAULT_RESEARCH_PAPER_MINIMUM_COMPLETED_TRADES = 25;
export const DEFAULT_RESEARCH_PAPER_LOCAL_ACTIVITY_LOOKBACK_DAYS = 7;

export type ResearchPaperLaneStatus = "ACTIVE" | "PAUSED" | "ARCHIVED";

/** A versioned, simulation-only experiment that can never supply promotion evidence. */
export interface ResearchPaperLane {
  id: string;
  label: typeof RESEARCH_PAPER_LABEL;
  purpose: "RESEARCH_ONLY";
  policyVersion: string;
  policy: Record<string, unknown>;
  initialNavPerLeaderUsd: number;
  status: ResearchPaperLaneStatus;
  startedAt: IsoDateTime;
  updatedAt: IsoDateTime;
  archivedAt?: IsoDateTime;
}

/** One independent virtual bankroll for one leader; balances never represent real funds. */
export interface ResearchPaperLeaderAccount {
  laneId: string;
  wallet: PublicKeyString;
  initialNavUsd: number;
  cashUsd: number;
  navUsd: number;
  peakNavUsd: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  maxDrawdownPercent: number;
  openPositions: number;
  completedTrades: number;
  pricingComplete: boolean;
  updatedAt: IsoDateTime;
}

export interface ResearchPaperWatchlistPolicy {
  /** Total independent accounts, including the preserved strict comparison accounts. */
  targetWalletCount: number;
  providerSnapshotMaxAgeDays: number;
  activityWindowDays: number;
  minimumRecentTrades: number;
  /** Local confirmed swaps improve ranking but are not required while the local index catches up. */
  localActivityLookbackDays: number;
}

export type ResearchPaperWatchlistRole = "STRICT_OVERLAP" | "RESEARCH_ONLY";
export type ResearchPaperActivityEvidenceSource =
  | "LOCAL_CONFIRMED_SPOT_AND_PROVIDER"
  | "FRESH_PROVIDER_COMPLETED_TRADES";

/** Frozen evidence explaining why a wallet was admitted to the research-only monitor. */
export interface ResearchPaperWatchlistMember {
  laneId: string;
  wallet: PublicKeyString;
  sourceCohortId: string;
  role: ResearchPaperWatchlistRole;
  activityEvidenceSource: ResearchPaperActivityEvidenceSource;
  selectionRank: number;
  providerScoreCalculatedAt: IsoDateTime;
  providerCandidateSavedAt: IsoDateTime;
  realizedPnl30dUsd: number;
  realizedPnl90dUsd: number;
  completedTrades30d: number;
  sourceRank30d?: number;
  sourceRank90d?: number;
  localConfirmedSpotSwaps: number;
  localActiveDays: number;
  latestLocalSpotSwapAt?: IsoDateTime;
  selectedAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** Append-only selection summary; member evidence is stored separately. */
export interface ResearchPaperWatchlistRun {
  id: string;
  laneId: string;
  sourceCohortId?: string;
  policy: ResearchPaperWatchlistPolicy;
  eligibleCandidateCount: number;
  preexistingLeaderCount: number;
  newlyEnrolledCount: number;
  totalLeaderCount: number;
  /** Preserved strict baseline accounts, whether or not they pass the active-trading gate today. */
  strictLeaderCount: number;
  /** Strict baseline wallets that also passed the current active-trading gate. */
  strictOverlapCount: number;
  researchOnlyMonitoredCount: number;
  remainingCapacity: number;
  selectedAt: IsoDateTime;
}

export interface ResearchPaperWatchlistSummary {
  latestRun?: ResearchPaperWatchlistRun;
  members: ResearchPaperWatchlistMember[];
}

export type ResearchPaperMonitoringRepairStatus = "PENDING" | "READY" | "FAILED";

/** Separate cursor state for research-only subscriptions; strict repair state is never reused. */
export interface ResearchPaperMonitoringCheckpoint {
  laneId: string;
  wallet: PublicKeyString;
  cursorAt: IsoDateTime;
  status: ResearchPaperMonitoringRepairStatus;
  attemptStartedAt?: IsoDateTime;
  lastSucceededAt?: IsoDateTime;
  nextRetryAt?: IsoDateTime;
  failureCount: number;
  lastError?: string;
  updatedAt: IsoDateTime;
}

export type ResearchPaperPositionStatus = "OPEN" | "CLOSING" | "CLOSED" | "UNPRICED";

export type ResearchPaperExitQuoteFailureCode =
  | "JUPITER_EXIT_NO_ROUTE"
  | "JUPITER_EXIT_QUOTE_UNAVAILABLE"
  | "JUPITER_EXIT_QUOTE_INVALID";

/** Research-only lot. It intentionally has neither mode nor evaluationCohortId. */
export interface ResearchPaperPosition {
  id: string;
  laneId: string;
  wallet: PublicKeyString;
  mint: PublicKeyString;
  sourceEntrySignature: TransactionSignature;
  openedAt: IsoDateTime;
  simulatedInitialAtomic: AtomicAmount;
  simulatedRemainingAtomic: AtomicAmount;
  leaderInitialAtomic: AtomicAmount;
  leaderRemainingAtomic: AtomicAmount;
  /** Latest confirmed aggregate balance for this leader and mint. Research-only
   * inventory reconciliation uses the delta from this checkpoint to catch
   * delegated exits and token rotations that do not decode as copyable swaps. */
  leaderObservedBalanceAtomic?: AtomicAmount;
  leaderBalanceObservedAt?: IsoDateTime;
  entryCostUsd: number;
  remainingCostUsd: number;
  lastExecutableValueUsd: number;
  pendingExitFraction: number;
  status: ResearchPaperPositionStatus;
  /** Durable, fail-closed retry evidence for a missing full-position sell
   * quote. Optional fields keep legacy lots readable; when present, all four
   * fields are persisted together in the research-only position JSON. */
  exitQuoteFailureCount?: number;
  /** Consecutive, typed Jupiter NO_ROUTE observations. This is deliberately
   * separate from the total failure count so outages or invalid responses can
   * never contribute to terminal write-off evidence. Optional for legacy rows. */
  consecutiveExitNoRouteFailureCount?: number;
  lastExitQuoteAttemptAt?: IsoDateTime;
  nextExitQuoteRetryAt?: IsoDateTime;
  lastExitQuoteFailureCode?: ResearchPaperExitQuoteFailureCode;
  updatedAt: IsoDateTime;
  closedAt?: IsoDateTime;
}

export type ResearchPaperExitEvidence =
  | "LEADER_SWAP"
  | "TOKEN_BALANCE_DECREASE"
  | "BALANCE_RECONCILIATION"
  /** A legacy PAPER-only lot had no executable Jupiter exit after durable
   * retries and fresh token evidence proved it economically terminal. This is
   * a zero-proceeds accounting write-off, never an executable sale or price. */
  | "TERMINAL_UNROUTABLE_WRITEOFF";

export interface ResearchPaperTrade {
  id: string;
  laneId: string;
  wallet: PublicKeyString;
  mint: PublicKeyString;
  positionId: string;
  sourceEntrySignature: TransactionSignature;
  /** Missing only when a confirmed balance invariant found an exit whose
   * original transaction was not visible to the wallet subscription. */
  sourceExitSignature?: TransactionSignature;
  exitEvidence?: ResearchPaperExitEvidence;
  openedAt: IsoDateTime;
  closedAt: IsoDateTime;
  proceedsUsd: number;
  costBasisUsd: number;
  modeledCostsUsd: number;
  pnlUsd: number;
}

export type ResearchPaperPerformanceEvidenceStatus =
  | "COMPLETE"
  | "RECONCILIATION_DEPENDENT"
  | "PRICING_INCOMPLETE";

/** Read-only accounting-quality evidence derived from the append-only PAPER
 * event ledger. A non-zero realized PnL gap means proportional exits affected
 * the account but were not emitted as standalone closed-trade rows by the
 * legacy ledger. The historical account is intentionally not rewritten. */
export interface ResearchPaperLeaderPerformanceEvidence {
  wallet: PublicKeyString;
  status: ResearchPaperPerformanceEvidenceStatus;
  recordedClosedTradePnlUsd: number;
  nonTradeItemizedRealizedPnlUsd: number;
  proportionalExitCount: number;
  balanceReconciledTradeCount: number;
}

/** Robust, read-only view of a multi-wallet PAPER experiment. The ex-outlier
 * result excludes exactly one account: the account with the largest absolute
 * PnL. It is diagnostic only and never mutates sizing, selection, or ledgers. */
export interface ResearchPaperPerformanceEvidence {
  status: ResearchPaperPerformanceEvidenceStatus;
  accountCount: number;
  pricingIncompleteAccountCount: number;
  unpricedPositionCount: number;
  staleUnpricedPositionCount: number;
  reconciliationDependentAccountCount: number;
  medianAccountPnlUsd: number;
  exOutlierAccountCount: number;
  exOutlierInitialNavUsd: number;
  exOutlierNormalizedNavUsd: number;
  exOutlierNormalizedPnlUsd: number;
  exOutlierNetReturnPercent: number;
  largestOutlierWallet?: PublicKeyString;
  largestOutlierPnlUsd?: number;
  leaderEvidence: ResearchPaperLeaderPerformanceEvidence[];
  disclosure: string;
}

export type ResearchPaperEventKind = "SIGNAL" | "TRADE" | "NAV_MARK";
export type ResearchPaperEventOutcome =
  | "CLAIMED"
  | "SIMULATED"
  | "REJECTED"
  | "ANALYSIS_ONLY"
  | "FAILED";

/** Append-only/idempotent research evidence. Terminal updates may only replace CLAIMED. */
export interface ResearchPaperEvent {
  eventKey: string;
  laneId: string;
  wallet: PublicKeyString;
  kind: ResearchPaperEventKind;
  outcome: ResearchPaperEventOutcome;
  observedAt: IsoDateTime;
  sourceSignature?: TransactionSignature;
  mint?: PublicKeyString;
  action?: TradeSide;
  reason?: string;
  strictReasonCodes?: string[];
  navUsd?: number;
  trade?: ResearchPaperTrade;
  finalizedAt?: IsoDateTime;
}

export interface ResearchPaperDashboard {
  label: typeof RESEARCH_PAPER_LABEL;
  promotionEligible: false;
  executionEnabled: false;
  lane?: ResearchPaperLane;
  leaders: ResearchPaperLeaderAccount[];
  positions: ResearchPaperPosition[];
  recentSignals: ResearchPaperEvent[];
  recentTrades: ResearchPaperTrade[];
  performanceEvidence?: ResearchPaperPerformanceEvidence;
  watchlist?: ResearchPaperWatchlistSummary;
  updatedAt: IsoDateTime;
}

export const AUTONOMOUS_PAPER_LABEL = "AUTONOMOUS MOMENTUM PAPER — RESEARCH ONLY" as const;

export type AutonomousPaperLaneStatus = "ACTIVE" | "PAUSED" | "ARCHIVED";

/** Frozen, versioned policy for the autonomous simulation. None of these
 * values can affect strict PAPER, promotion, signing, or live execution. */
export interface AutonomousPaperPolicy {
  scanIntervalMinutes: number;
  confirmationSamples: number;
  allowToken2022: boolean;
  /** V5-only deterministic sizing gate. Persisted v1-v4 lanes normalize this
   * to false so their historical position semantics cannot change. */
  adaptiveSizingEnabled: boolean;
  maximumEntriesPerUtcDay: number;
  minimumEntrySpacingMinutes: number;
  minimumPositionUsd: number;
  positionNavFraction: number;
  maximumPositionUsd: number;
  maximumOpenPositions: number;
  maximumDeployedFraction: number;
  minimumLiquidReserveUsd: number;
  minimumAgeDays: number;
  minimumLiquidityUsd: number;
  minimumVolume24hUsd: number;
  minimumHolderCount: number;
  minimumOrganicScore: number;
  maximumTopHoldersPercent: number;
  minimumMarketCapUsd: number;
  maximumMarketCapUsd: number;
  maximumFdvToMarketCap: number;
  minimumMomentumScore: number;
  minimumPriceChange5mPercent: number;
  maximumPriceChange5mPercent: number;
  minimumPriceChange1hPercent: number;
  maximumPriceChange1hPercent: number;
  minimumPriceChange6hPercent: number;
  maximumPriceChange6hPercent: number;
  maximumPriceChange24hPercent: number;
  minimumOrganicBuyShare5m: number;
  minimumOrganicBuyShare1h: number;
  minimumOrganicVolume5mUsd: number;
  minimumOrganicVolume1hUsd: number;
  minimumOrganicBuyers5m: number;
  minimumVolumeAccelerationRatio: number;
  minimumLiquidityChange1hPercent: number;
  minimumSolPriceChange1hPercent: number;
  minimumSolPriceChange6hPercent: number;
  minimumSolRelativeStrength1hPercent: number;
  maximumPriceImpactPercent: number;
  maximumRoundTripCostPercent: number;
  stopLossPercent: number;
  breakEvenActivationPercent: number;
  trailingActivationPercent: number;
  trailingDrawdownPercent: number;
  takeProfitPercent: number;
  weakMomentumExitSamples: number;
  noProgressMinutes: number;
  maximumHoldingMinutes: number;
  cooldownMinutes: number;
  stopCooldownMinutes: number;
  dailyLossPausePercent: number;
  maximumDrawdownPercent: number;
  adaptiveSizingMinimumTrades: number;
  adaptiveSizingWindowTrades: number;
  adaptiveSizingPriorWins: number;
  adaptiveSizingPriorLosses: number;
  adaptiveSizingFractionalKelly: number;
  adaptiveSizingMinimumCalibrationMultiplier: number;
  adaptiveSizingMaximumCalibrationMultiplier: number;
  adaptiveSizingMaximumLossStreak: number;
  adaptiveSizingLossStreakMultiplier: number;
  /** V7-only contextual reward gate. Earlier policy epochs normalize this to
   * false so their archived sizing semantics remain byte-for-byte stable. */
  contextualRewardEnabled: boolean;
  contextualRewardMinimumComparableTrades: number;
  contextualRewardMaximumDistance: number;
  contextualRewardPriorWeight: number;
  contextualRewardGain: number;
  contextualRewardMinimumEffectiveSamples: number;
  contextualRewardMinimumDistinctMints: number;
  contextualRewardMinimumDistinctUtcDays: number;
  contextualRewardMaximumSamplesPerMint: number;
  contextualRewardMinimumMultiplier: number;
  contextualRewardMaximumMultiplier: number;
  /** V10 deterministic high-risk sizing. Risk is budgeted at the hard stop,
   * then bounded by reserve, deployment, quote, and cluster caps. */
  riskAtStopSizingEnabled: boolean;
  normalRiskAtStopNavFraction: number;
  highConvictionRiskAtStopNavFraction: number;
  explorationRiskAtStopNavFraction: number;
  maximumDeveloperClusterFraction: number;
}

/** One isolated autonomous strategy epoch with a single virtual bankroll. */
export interface AutonomousPaperLane {
  id: string;
  label: typeof AUTONOMOUS_PAPER_LABEL;
  purpose: "RESEARCH_ONLY";
  policyVersion: string;
  policy: AutonomousPaperPolicy;
  initialNavUsd: number;
  status: AutonomousPaperLaneStatus;
  startedAt: IsoDateTime;
  updatedAt: IsoDateTime;
  archivedAt?: IsoDateTime;
}

/** Executable-market evidence captured before an autonomous decision. */
export interface AutonomousPaperMarketSnapshot {
  capturedAt: IsoDateTime;
  sourceUpdatedAt: IsoDateTime;
  mint: PublicKeyString;
  symbol?: string;
  name?: string;
  decimals: number;
  tokenProgram: string;
  verified: boolean;
  suspicious: boolean;
  mintAuthorityDisabled: boolean;
  freezeAuthorityDisabled: boolean;
  tokenAgeDays: number;
  priceUsd: number;
  marketCapUsd: number;
  fdvUsd: number;
  liquidityUsd: number;
  liquidityChange1hPercent: number;
  volume24hUsd: number;
  holderCount: number;
  organicScore: number;
  topHoldersPercent: number;
  priceChange5mPercent: number;
  priceChange1hPercent: number;
  priceChange6hPercent: number;
  priceChange24hPercent: number;
  organicBuyShare5m: number;
  organicBuyShare1h: number;
  organicVolume5mUsd: number;
  organicVolume1hUsd: number;
  organicBuyers5m: number;
  volumeAccelerationRatio: number;
  buySellRatio: number;
  momentumScore: number;
  categoryRanks: Record<string, number>;
}

export const AUTONOMOUS_PAPER_SIZING_V1_VERSION = "adaptive-sizing-v1" as const;
export const AUTONOMOUS_PAPER_SIZING_VERSION = "adaptive-sizing-v2" as const;
/** Frozen v7-and-earlier context identifier. Keep this export and payload
 * shape unchanged so archived positions and trades retain exact serialization. */
export const AUTONOMOUS_PAPER_LEARNING_CONTEXT_VERSION = "contextual-reward-v1" as const;
export const AUTONOMOUS_PAPER_LEARNING_CONTEXT_V2_VERSION = "contextual-reward-v2" as const;
export type AutonomousPaperStrategyArm =
  | "MOMENTUM"
  | "MOMENTUM_CONTINUATION"
  | "CONTROLLED_EXPLORATION"
  | "BREAKOUT"
  | "PULLBACK_RECLAIM"
  | "WALLET_CONFIRMED_MOMENTUM"
  | "EARLY_LIQUIDITY"
  | "SIMULATION_PROBE"
  | "NEGATIVE_CONTROL";

/** Coarse market state calculated only from evidence available before an
 * entry decision. UNKNOWN is fail-closed for learned sizing. */
export type MarketRegime =
  | "RISK_ON_TREND"
  | "BROAD_RISK_ON"
  | "CHOPPY"
  | "HIGH_VOLATILITY"
  | "RISK_OFF"
  | "UNKNOWN";

export const AUTONOMOUS_LEARNING_FEATURE_VERSION = "autonomous-learning-features-v2" as const;

/** Immutable causal features for one independent executable shadow path.
 * Capital and future-path values are deliberately absent. */
export interface LearningFeatureVector {
  version: typeof AUTONOMOUS_LEARNING_FEATURE_VERSION;
  capturedAt: IsoDateTime;
  mint: PublicKeyString;
  strategyArm: AutonomousPaperStrategyArm;
  regime: MarketRegime;
  shadowOnly: boolean;
  tokenAgeDays: number;
  logLiquidityUsd: number;
  logVolume24hUsd: number;
  holderBreadth: number;
  organicScore: number;
  topHoldersPercent: number;
  priceChange5mPercent: number;
  priceChange1hPercent: number;
  priceChange6hPercent: number;
  priceChange24hPercent: number;
  organicBuyShare5m: number;
  organicBuyShare1h: number;
  volumeAccelerationRatio: number;
  liquidityChange1hPercent: number;
  solRelativeStrength1hPercent: number;
  categoryBreadth: number;
  bestCategoryRank: number;
  projectedRoundTripCostPercent: number;
  buyPriceImpactPercent: number;
  sellPriceImpactPercent: number;
  walletConfirmed: boolean;
  developerCluster?: string;
  /** Explicit pre-entry missingness. V12 never presents sentinel-filled data as
   * complete feature coverage. */
  missingFeatureNames?: string[];
  /** A hard-safe opportunity sampled outside every entry arm. It may teach the
   * opportunity base rate but can never receive champion capital. */
  negativeControl?: boolean;
  datasetEligible: boolean;
}

export type ShadowEpisodeStatus =
  | "PENDING_QUOTE"
  | "ACTIVE"
  | "COMPLETED"
  | "REJECTED"
  | "UNPRICED";

/** Whether an opportunity may consume the isolated champion PAPER account.
 * This is deliberately independent from dataset eligibility: rejected and
 * research-only opportunities are still valuable causal training evidence. */
export type LearningExecutionTier = "SHADOW" | "CHAMPION";

/** One independent opportunity. Replays and counterfactual variants never
 * create additional ShadowEpisode rows. */
export interface ShadowEpisode {
  id: string;
  sourceKey: string;
  laneId: string;
  policyVersion: string;
  mint: PublicKeyString;
  symbol?: string;
  strategyArm: AutonomousPaperStrategyArm;
  regime: MarketRegime;
  status: ShadowEpisodeStatus;
  shadowOnly: boolean;
  /** V11 identity. Older persisted v10 rows decode `shadowOnly` instead. */
  executionTier?: LearningExecutionTier;
  featureVector: LearningFeatureVector;
  referenceInputUsd: number;
  inputCostUsd?: number;
  outputAmountAtomic?: string;
  tokenDecimals: number;
  entryExecutableValueUsd?: number;
  entrySolPriceUsd?: number;
  maximumFavorableExcursionPercent: number;
  maximumAdverseExcursionPercent: number;
  openedAt?: IsoDateTime;
  horizonEndsAt?: IsoDateTime;
  lastObservedAt?: IsoDateTime;
  failureCode?: string;
  quoteAttempts?: number;
  nextQuoteAttemptAt?: IsoDateTime;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface LearningPathObservation {
  id: string;
  episodeId: string;
  phase: "ENTRY" | "MARK" | "HORIZON";
  observedAt: IsoDateTime;
  elapsedMinutes: number;
  executableValueUsd: number;
  totalModeledCostUsd: number;
  netReturnPercent: number;
  solBenchmarkReturnPercent?: number;
  excessReturnPercent?: number;
  priceImpactPercent: number;
  quoteExecutable: boolean;
  datasetEligible: boolean;
}

export interface OutcomeLabel {
  id: string;
  episodeId: string;
  horizonMinutes: 15 | 45 | 180;
  observedAt: IsoDateTime;
  executableValueUsd: number;
  totalModeledCostUsd: number;
  netReturnPercent: number;
  netLogReturn: number;
  /** V11 cost-inclusive reward with explicit path-risk and capital-time drag. */
  riskAdjustedReward?: number;
  /** V12 benchmark accounting. Positive values are net executable alpha over
   * SOL during the identical holding window. */
  solBenchmarkReturnPercent?: number;
  excessReturnPercent?: number;
  maximumFavorableExcursionPercent: number;
  maximumAdverseExcursionPercent: number;
  profitable: boolean;
  quoteExecutable: boolean;
  datasetEligible: boolean;
}

export type LearningModelKind =
  | "PROFITABILITY_PROBABILITY"
  | "EXPECTED_NET_LOG_RETURN"
  | "ADVERSE_TAIL_RETURN"
  | "RISK_ADJUSTED_REWARD";

export interface ModelArtifact {
  id: string;
  modelVersion: string;
  modelKind: LearningModelKind;
  /** V11 trains independent tactical and full-horizon model families. */
  horizonMinutes?: 45 | 180;
  featureVersion: typeof AUTONOMOUS_LEARNING_FEATURE_VERSION;
  featureNames: string[];
  coefficients: number[];
  intercept: number;
  trainingCutoffAt: IsoDateTime;
  independentEpisodeCount: number;
  policyVersion?: string;
  trainingEpisodeCount?: number;
  validationEpisodeCount?: number;
  validationStartAt?: IsoDateTime;
  brierScore?: number;
  meanAbsoluteError?: number;
  expectedCalibrationError?: number;
  featureCoverage?: number;
  driftScore?: number;
  validationPassed?: boolean;
  validationReasonCodes?: string[];
  datasetDigest: string;
  evaluationDigest: string;
  active: boolean;
  createdAt: IsoDateTime;
}

export interface StrategyArmScore {
  strategyArm: AutonomousPaperStrategyArm;
  regime: MarketRegime;
  policyVersion?: string;
  sampleCount: number;
  profitableProbability: number;
  expectedNetLogReturn: number;
  adverseTailReturn: number;
  lowerConfidenceNetLogReturn: number;
  expectedRiskAdjustedReward?: number;
  lowerConfidenceRiskAdjustedReward?: number;
  horizonMinutes?: 45 | 180;
  distinctMints?: number;
  distinctUtcDays?: number;
  profitFactor?: number;
  stressNetReturnPercent?: number;
  maximumMintShare?: number;
  maximumDayShare?: number;
  quarantined?: boolean;
  learned: boolean;
  eligibleForChampion: boolean;
  reasonCodes: string[];
}

export interface LearningAdmissionDecision {
  /** Cohort identity prevents a visually identical decision from an archived
   * policy from suppressing the first decision made by the active policy. */
  policyVersion?: string;
  strategyArm: AutonomousPaperStrategyArm;
  regime: MarketRegime;
  executionTier: LearningExecutionTier;
  allowed: boolean;
  highConviction: boolean;
  reasonCodes: string[];
  expectedNetReturnPercent?: number;
  lowerConfidenceNetReturnPercent?: number;
  projectedRoundTripCostPercent?: number;
  decidedAt: IsoDateTime;
}

export interface LearningModelCalibration {
  horizonMinutes: 45 | 180;
  independentEpisodeCount: number;
  policyVersion?: string;
  trainingEpisodeCount?: number;
  validationEpisodeCount?: number;
  distinctMints?: number;
  distinctUtcDays?: number;
  brierScore?: number;
  meanAbsoluteReturnError?: number;
  expectedCalibrationError?: number;
  featureCoverage: number;
  driftScore: number;
  active: boolean;
  reasonCodes: string[];
}

export interface LearningSchedulerStatus {
  activeCapacity: number;
  maximumNewPerScan: number;
  newEligible45mLabelsSinceTraining: number;
  newEligible180mLabelsSinceTraining: number;
  eventTrainingDue: boolean;
  earliestNextTrainingAt?: IsoDateTime;
  nextTrainingReason: "EVENT" | "NIGHTLY" | "NOT_DUE";
}

/** High-throughput counterfactual research that is structurally separated
 * from the champion bankroll. Each completed executable path remains one
 * independent sample even when thousands of policies are replayed over it. */
export interface LearningSimulationArenaOverview {
  version: "shadow-simulation-arena-v1";
  status: "COLLECTING" | "EVALUATING" | "LEADER_AVAILABLE";
  candidatePolicyCount: number;
  pendingOrActiveProbePaths: number;
  completedProbePaths: number;
  datasetEligibleProbePaths: number;
  independentPathCount: number;
  denseIndependentPathCount: number;
  latestScorableScenarioEvaluations: number;
  capitalInfluenceEnabled: false;
  correlatedScenariosAreIndependentEvidence: false;
  reasonCodes: string[];
}

export type TradeAttributionCause =
  | "ENTRY_QUALITY"
  | "EXIT_POLICY"
  | "EXECUTION_COST"
  | "REGIME_SHIFT"
  | "LIQUIDITY_DETERIORATION"
  | "DATA_QUALITY"
  | "POSITIVE_EXECUTION";

export interface TradeAttribution {
  id: string;
  episodeId: string;
  tradeId?: string;
  primaryCause: TradeAttributionCause;
  reasonCodes: string[];
  avoidableLossUsd: number;
  createdAt: IsoDateTime;
}

export interface PolicyChallenger {
  id: string;
  policyVersion: string;
  rank: number;
  status: "SHADOW" | "PROMOTABLE" | "REJECTED" | "ARCHIVED";
  minimumScore: number;
  minimumOrganicBuyShare5m?: number;
  minimumOrganicBuyShare1h?: number;
  minimumVolumeAccelerationRatio?: number;
  maximumRoundTripCostPercent?: number;
  stopLossPercent: number;
  takeProfitPercent: number;
  maximumHoldingMinutes: number;
  completedPaths: number;
  scorablePathCount?: number;
  densePathCoveragePercent?: number;
  netReturnPercent: number;
  profitFactor: number;
  maximumDrawdownPercent: number;
  stressNetReturnPercent: number;
  largestProfitContributionPercent: number;
  datasetDigest: string;
  createdAt: IsoDateTime;
}

export interface WalkForwardResult {
  id: string;
  challengerId: string;
  fold: number;
  trainingStartAt: IsoDateTime;
  trainingEndAt: IsoDateTime;
  testStartAt: IsoDateTime;
  testEndAt: IsoDateTime;
  embargoHours: 24;
  trainingEpisodeCount?: number;
  selectedOnTrainingOnly?: boolean;
  episodeCount: number;
  netReturnPercent: number;
  maximumDrawdownPercent: number;
  profitable: boolean;
  createdAt: IsoDateTime;
}

export interface ChampionPromotionDecision {
  id: string;
  challengerId?: string;
  allowed: boolean;
  blockerCodes: string[];
  observedDays: number;
  executableShadowPaths: number;
  championCompletedExits: number;
  profitableWalkForwardFolds: number;
  lowerConfidenceDifferencePercent: number;
  decidedAt: IsoDateTime;
}

export interface AutonomousLearningOverview {
  databaseSchemaVersion: number;
  status: "COLLECTING" | "TRAINING" | "READY" | "DEGRADED";
  currentRegime: MarketRegime;
  pendingEpisodes: number;
  activeEpisodes: number;
  completedExecutablePaths: number;
  cohortPendingEpisodes?: number;
  cohortActiveEpisodes?: number;
  cohortCompletedEpisodes?: number;
  datasetEligiblePaths: number;
  policyCohortVersion?: string;
  cohortDatasetEligiblePaths?: number;
  historicalDatasetEligiblePaths?: number;
  pathObservationCount?: number;
  densePathCoveragePercent?: number;
  quoteCoveragePercent?: number;
  modelInfluenceEnabled: boolean;
  minimumPathsForModelInfluence: 200;
  quoteWorkBudgetFraction: 0.4;
  latestTrainingAt?: IsoDateTime;
  activeModels: ModelArtifact[];
  armScores: StrategyArmScore[];
  admissions?: LearningAdmissionDecision[];
  calibrations?: LearningModelCalibration[];
  scheduler?: LearningSchedulerStatus;
  simulationArena?: LearningSimulationArenaOverview;
  challengers: PolicyChallenger[];
  recentAttributions: TradeAttribution[];
  promotion: ChampionPromotionDecision;
  updatedAt: IsoDateTime;
}

/** Compact point-in-time entry features copied onto the position and eventual
 * completed trade. Capital state is deliberately excluded: similarity should
 * describe the opportunity, not how much cash happened to be available. */
interface AutonomousPaperLearningContextFeatures {
  momentum: number;
  categoryRank: number;
  liquidityFlow: number;
  quoteQuality: number;
  projectedRoundTripCostPercent: number;
}

/** Exact frozen v1 payload written by contextual v7 and earlier callers. */
export interface AutonomousPaperLearningContextV1
  extends AutonomousPaperLearningContextFeatures {
  version: typeof AUTONOMOUS_PAPER_LEARNING_CONTEXT_VERSION;
}

/** V8 context adds immutable strategy provenance. Scenario/replay outputs are
 * still outside this type and cannot become sizing samples. */
export interface AutonomousPaperLearningContextV2
  extends AutonomousPaperLearningContextFeatures {
  version: typeof AUTONOMOUS_PAPER_LEARNING_CONTEXT_V2_VERSION;
  strategyArm: AutonomousPaperStrategyArm;
  waivedReasonCount: number;
}

export type AutonomousPaperLearningContext =
  | AutonomousPaperLearningContextV1
  | AutonomousPaperLearningContextV2;

/** Replay evidence for the lane-local, similarity-weighted reward layer. */
export interface AutonomousPaperContextualReward {
  active: boolean;
  preQuoteUpperBound: boolean;
  comparableTrades: number;
  effectiveSampleSize: number;
  distinctMints: number;
  distinctUtcDays: number;
  ignoredMissingContext: number;
  weightedAverageReward: number;
  shrunkReward: number;
  multiplier: number;
  contributingTradeIds: string[];
}

export type AutonomousPaperSizingBindingConstraint =
  | "HARD_USD_CAP"
  | "POLICY_POSITION_CAP"
  | "NAV_FRACTION_CAP"
  | "CASH_RESERVE_CAP"
  | "DEPLOYMENT_CAP"
  | "RISK_AT_STOP_CAP"
  | "DEVELOPER_CLUSTER_CAP"
  | "MINIMUM_SIZE_FLOOR";

export type AutonomousPaperSizingExplanationCode =
  | AutonomousPaperSizingBindingConstraint
  | "COLD_START"
  | "EMPIRICAL_CALIBRATION"
  | "POSITIVE_REWARD_SCALING"
  | "NEGATIVE_REWARD_SCALING"
  | "LOSS_STREAK_REDUCTION"
  | "DRAWDOWN_REDUCTION"
  | "EXPOSURE_REDUCTION"
  | "QUOTE_QUALITY_REDUCTION"
  | "CONTEXTUAL_REWARD_COLD_START"
  | "CONTEXTUAL_REWARD_ACTIVE"
  | "CONTEXTUAL_REWARD_INCREASE"
  | "CONTEXTUAL_REWARD_REDUCTION"
  | "CONTEXTUAL_PREQUOTE_UPPER_BOUND"
  | "CENT_ROUNDING";

/** Complete replay evidence for one deterministic autonomous PAPER size.
 * Every number is derived from the frozen lane policy, the point-in-time
 * market/quote evidence, and material completed trades from that same lane. */
export interface AutonomousPaperSizingBreakdown {
  version:
    | typeof AUTONOMOUS_PAPER_SIZING_V1_VERSION
    | typeof AUTONOMOUS_PAPER_SIZING_VERSION;
  minimumUsd: number;
  maximumAvailableUsd: number;
  unroundedUsd: number;
  sizeUsd: number;
  componentScores: {
    momentum: number;
    categoryRank: number;
    liquidityFlow: number;
    quoteQuality: number;
    conviction: number;
  };
  calibration: {
    sampleCount: number;
    coldStart: boolean;
    winProbability: number;
    averageWinPercent: number;
    averageLossPercent: number;
    fullKelly: number;
    multiplier: number;
    /** Cost-aware normalized reward, smoothed toward neutral. Closed-trade
     * return already includes the modeled executable entry/exit costs. */
    averageReward: number;
    /** Pre-context, lane-wide normalized reward multiplier. */
    baseRewardMultiplier: number;
    /** Final bounded reward multiplier used in position strength. */
    rewardMultiplier: number;
  };
  contextualReward: AutonomousPaperContextualReward;
  riskMultipliers: {
    currentDrawdownPercent: number;
    drawdown: number;
    exposureFraction: number;
    exposure: number;
    consecutiveLosses: number;
    lossStreak: number;
  };
  capitalCaps: {
    hardUsd: number;
    policyUsd: number;
    navFractionUsd: number;
    reserveUsd: number;
    deploymentUsd: number;
    riskAtStopUsd?: number;
    developerClusterUsd?: number;
  };
  bindingConstraints: AutonomousPaperSizingBindingConstraint[];
  explanationCodes: AutonomousPaperSizingExplanationCode[];
}

export type AutonomousPaperDecisionAction = "BUY" | "SELL" | "REJECT" | "OBSERVE";
export type AutonomousPaperDecisionOutcome = "SIMULATED" | "REJECTED" | "ANALYSIS_ONLY" | "FAILED";

/** Append-only explanation of what the autonomous strategy considered and why. */
export interface AutonomousPaperDecision {
  id: string;
  laneId: string;
  action: AutonomousPaperDecisionAction;
  outcome: AutonomousPaperDecisionOutcome;
  mint: PublicKeyString;
  symbol?: string;
  score: number;
  reasons: string[];
  snapshot: AutonomousPaperMarketSnapshot;
  positionId?: string;
  modeledPositionUsd?: number;
  projectedRoundTripCostPercent?: number;
  stressRoundTripCostPercent?: number;
  sizing?: AutonomousPaperSizingBreakdown;
  decidedAt: IsoDateTime;
}

export type AutonomousPaperPositionStatus = "OPEN" | "UNPRICED" | "CLOSED";

/** Autonomous research lot. It deliberately has no source wallet, source
 * transaction signature, mode, or evaluation-cohort link. */
export interface AutonomousPaperPosition {
  id: string;
  laneId: string;
  entryDecisionId: string;
  mint: PublicKeyString;
  symbol?: string;
  /** Hashed developer+launchpad identity. Missing legacy values are treated
   * as isolated rather than grouped together. */
  developerCluster?: string;
  initialAmountAtomic: AtomicAmount;
  remainingAmountAtomic: AtomicAmount;
  entryCostUsd: number;
  remainingCostUsd: number;
  lastExecutableValueUsd: number;
  peakExecutableValueUsd: number;
  entryPriceUsd: number;
  lastPriceUsd: number;
  stopPriceUsd: number;
  breakEvenPriceUsd?: number;
  trailingStopPriceUsd?: number;
  takeProfitPriceUsd: number;
  weakMomentumSamples: number;
  /** Present for contextual-learning policy epochs; optional so archived
   * positions remain decodable and, critically, always remain exitable. */
  entryLearningContext?: AutonomousPaperLearningContext;
  status: AutonomousPaperPositionStatus;
  openedAt: IsoDateTime;
  updatedAt: IsoDateTime;
  closedAt?: IsoDateTime;
}

export type AutonomousPaperExitReason =
  | "STOP_LOSS"
  | "BREAK_EVEN"
  | "TRAILING_STOP"
  | "TAKE_PROFIT"
  | "WEAK_MOMENTUM"
  | "NO_PROGRESS"
  | "MAX_HOLD"
  | "TOKEN_SAFETY"
  | "MANUAL_PAUSE";

export interface AutonomousPaperTrade {
  id: string;
  laneId: string;
  positionId: string;
  entryDecisionId: string;
  exitDecisionId?: string;
  mint: PublicKeyString;
  symbol?: string;
  exitReason: AutonomousPaperExitReason;
  openedAt: IsoDateTime;
  closedAt: IsoDateTime;
  proceedsUsd: number;
  costBasisUsd: number;
  modeledCostsUsd: number;
  pnlUsd: number;
  returnPercent: number;
  /** Immutable entry features used by later same-lane contextual calibration. */
  entryLearningContext?: AutonomousPaperLearningContext;
}

export type AutonomousPaperEventKind = "DECISION" | "TRADE" | "NAV_MARK";
export type AutonomousPaperEventOutcome =
  | "CLAIMED"
  | AutonomousPaperDecisionOutcome;

/** Idempotent autonomous-paper journal record. A terminal update may replace
 * only CLAIMED, matching the crash-safe research-paper claim pattern. */
export interface AutonomousPaperEvent {
  eventKey: string;
  laneId: string;
  kind: AutonomousPaperEventKind;
  outcome: AutonomousPaperEventOutcome;
  observedAt: IsoDateTime;
  mint?: PublicKeyString;
  action?: AutonomousPaperDecisionAction;
  reason?: string;
  navUsd?: number;
  decision?: AutonomousPaperDecision;
  trade?: AutonomousPaperTrade;
  finalizedAt?: IsoDateTime;
}

/** Single virtual account for the autonomous strategy. */
export interface AutonomousPaperAccount {
  laneId: string;
  initialNavUsd: number;
  cashUsd: number;
  navUsd: number;
  peakNavUsd: number;
  deployedUsd: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  maxDrawdownPercent: number;
  openPositions: number;
  completedTrades: number;
  winningTrades: number;
  grossProfitUsd: number;
  grossLossUsd: number;
  pricingComplete: boolean;
  updatedAt: IsoDateTime;
}

export const AUTONOMOUS_PAPER_REPLAY_LABEL = "AUTONOMOUS PAPER REPLAY LAB — RESEARCH ONLY" as const;
export const AUTONOMOUS_PAPER_REPLAY_VARIANT_COUNT = 1_000 as const;
export const AUTONOMOUS_PAPER_REPLAY_VERSION = "deterministic-replay-v1" as const;

export type AutonomousPaperReplayEpisodeStatus =
  | "CAPTURING"
  | "READY"
  | "REPLAYED"
  | "INCOMPLETE";

/** One prospectively captured path rooted in an actual autonomous PAPER
 * position. Replay episodes are deliberately not positions or trades and have
 * no account, execution, approval, signer, or promotion identity. */
export interface AutonomousPaperReplayEpisode {
  id: string;
  laneId: string;
  positionId: string;
  entryDecisionId: string;
  mint: PublicKeyString;
  symbol?: string;
  policyVersion: string;
  replayVersion: typeof AUTONOMOUS_PAPER_REPLAY_VERSION;
  scenarioManifestDigest: string;
  status: AutonomousPaperReplayEpisodeStatus;
  actualOpenedAt: IsoDateTime;
  captureStartedAt: IsoDateTime;
  horizonEndsAt: IsoDateTime;
  actualClosedAt?: IsoDateTime;
  observationCount: number;
  pathDigest?: string;
  incompleteReason?: string;
  completedAt?: IsoDateTime;
  updatedAt: IsoDateTime;
}

export type AutonomousPaperReplayObservationPhase =
  | "ENTRY"
  | "MARK"
  | "ACTUAL_EXIT"
  | "POST_EXIT";

/** Sanitized quote scalars for a possible entry at one observed path point.
 * Raw provider responses, request identifiers, routes, instructions, and
 * transaction bytes are intentionally absent. */
export interface AutonomousPaperReplayEntryEvidence {
  inputUsd: number;
  outputAmountAtomic: AtomicAmount;
  modeledFeeUsd: number;
  totalCostUsd: number;
  priceImpactPercent: number;
  slippageBps: number;
  projectedRoundTripCostPercent: number;
  quotedAt: IsoDateTime;
}

/** Sanitized full-lot executable exit evidence. This is sufficient for causal
 * replay while remaining structurally incapable of carrying a transaction. */
export interface AutonomousPaperReplayExitEvidence {
  inputAmountAtomic: AtomicAmount;
  guaranteedProceedsUsd: number;
  modeledFeeUsd: number;
  executableValueUsd: number;
  priceImpactPercent: number;
  slippageBps: number;
  quotedAt: IsoDateTime;
}

interface AutonomousPaperReplayObservationIdentity {
  observationKey: string;
  episodeId: string;
  laneId: string;
  positionId: string;
  mint: PublicKeyString;
  sequence: number;
  phase: AutonomousPaperReplayObservationPhase;
  observedAt: IsoDateTime;
  sourceUpdatedAt: IsoDateTime;
  positionCostBasisUsd: number;
}

/** Append-only causal observation. Only evidence known at `observedAt` may be
 * stored; replay variants consume these rows in ascending sequence. A missing
 * exact quote is preserved explicitly instead of being silently skipped or
 * replaced with a fabricated price. */
export type AutonomousPaperReplayObservation =
  | (AutonomousPaperReplayObservationIdentity & {
  status: "EXECUTABLE";
  marketPriceUsd: number;
  momentumScore: number;
  priceChange5mPercent: number;
  organicBuyShare5m: number;
  staticSafetyEligible: boolean;
  signalEligible: boolean;
  entryEvidence?: AutonomousPaperReplayEntryEvidence;
  exitEvidence: AutonomousPaperReplayExitEvidence;
})
  | (AutonomousPaperReplayObservationIdentity & {
  status: "UNPRICED";
  failureCode: string;
});

/** Frozen, outcome-independent controls for one of the 1,000 replay state
 * machines. The manifest is generated before the path outcome is known. */
export interface AutonomousPaperReplayVariantParameters {
  entryDelaySamples: number;
  confirmationSamples: number;
  minimumMomentumScore: number;
  stopLossPercent: number;
  breakEvenActivationPercent: number;
  trailingActivationPercent: number;
  trailingDrawdownPercent: number;
  takeProfitPercent: number;
  weakMomentumExitSamples: number;
  noProgressMinutes: number;
  maximumHoldingMinutes: number;
}

export type AutonomousPaperReplayVariantOutcome =
  | "COMPLETED"
  | "NO_ENTRY"
  | "UNSCORABLE";

/** One correlated what-if evaluation. `independentTradeWeight` is a literal
 * zero so 1,000 variants can never masquerade as 1,000 independent trades. */
export interface AutonomousPaperReplayVariantResult {
  reportId: string;
  episodeId: string;
  laneId: string;
  positionId: string;
  variantIndex: number;
  variantId: string;
  configurationDigest: string;
  parameters: AutonomousPaperReplayVariantParameters;
  causal: true;
  independentTradeWeight: 0;
  outcome: AutonomousPaperReplayVariantOutcome;
  entryObservationKey?: string;
  exitObservationKey?: string;
  exitReason?: AutonomousPaperExitReason;
  enteredAt?: IsoDateTime;
  exitedAt?: IsoDateTime;
  costBasisUsd?: number;
  proceedsUsd?: number;
  pnlUsd?: number;
  returnPercent?: number;
  maximumDrawdownPercent?: number;
  reward?: number;
}

/** One report summarizes 1,000 correlated evaluations of one independent
 * actual-position path. Hindsight-best output is diagnostic only; it is not a
 * trade, reward sample, or automatic policy transition. */
export interface AutonomousPaperReplayReport {
  id: string;
  episodeId: string;
  laneId: string;
  positionId: string;
  replayVersion: typeof AUTONOMOUS_PAPER_REPLAY_VERSION;
  scenarioManifestDigest: string;
  pathDigest: string;
  resultsDigest: string;
  variantCount: typeof AUTONOMOUS_PAPER_REPLAY_VARIANT_COUNT;
  scorableVariantCount: number;
  independentEpisodeCount: 1;
  calibrationTradeCount: 0;
  replayResultsAreIndependentTrades: false;
  baselineVariantId: string;
  baselineReturnPercent?: number;
  hindsightBestVariantId?: string;
  hindsightBestReturnPercent?: number;
  hindsightRegretPercent?: number;
  generatedAt: IsoDateTime;
}

export type AutonomousPaperReplayInsightClassification =
  | "PROFITABLE_TESTED_ALTERNATIVE"
  | "REDUCED_LOSS_ONLY"
  | "NO_IMPROVEMENT"
  | "UNSCORABLE";

export type AutonomousPaperReplayPathDiagnosis =
  | "TESTED_POLICY_FOUND_PROFIT"
  | "GRID_POLICY_GAP"
  | "ENTRY_QUALITY_PROBLEM"
  | "UNSCORABLE";

/** Read-only dashboard interpretation of persisted replay variants. It is not
 * persisted with the report and deliberately carries no account, order,
 * signer, reward, sizing, policy, promotion, or execution identity. */
export interface AutonomousPaperReplayInsight {
  reportId: string;
  episodeId: string;
  classification: AutonomousPaperReplayInsightClassification;
  evaluatedVariantCount: number;
  profitableVariantCount: number;
  pathDiagnosis: AutonomousPaperReplayPathDiagnosis;
  actualExit?: {
    observationKey: string;
    observedAt: IsoDateTime;
    executableValueUsd: number;
    pnlUsd: number;
    returnPercent: number;
  };
  bestVariant?: {
    variantId: string;
    variantIndex: number;
    parameters: AutonomousPaperReplayVariantParameters;
    exitReason: AutonomousPaperExitReason;
    exitedAt: IsoDateTime;
    pnlUsd: number;
    returnPercent: number;
  };
  improvementPercentPoints?: number;
  bestObservedExit?: {
    observationKey: string;
    phase: Exclude<AutonomousPaperReplayObservationPhase, "ENTRY">;
    observedAt: IsoDateTime;
    executableValueUsd: number;
    pnlUsd: number;
    returnPercent: number;
  };
  observedProfitableExit: boolean;
}

export interface AutonomousPaperReplayDashboard {
  label: typeof AUTONOMOUS_PAPER_REPLAY_LABEL;
  executionEnabled: false;
  promotionEligible: false;
  calibrationTradeCount: 0;
  independentEpisodeCount: number;
  scenarioEvaluations: number;
  capturingEpisodes: number;
  readyEpisodes: number;
  replayedEpisodes: number;
  incompleteEpisodes: number;
  recentEpisodes: AutonomousPaperReplayEpisode[];
  recentReports: AutonomousPaperReplayReport[];
  /** Optional so archived dashboard payloads remain renderable. */
  recentInsights?: AutonomousPaperReplayInsight[];
  updatedAt: IsoDateTime;
}

/** Durable, lane-bound intent to stop opening new autonomous PAPER positions
 * while the current inventory continues through its normal mark/exit rules.
 * This is coordination state only: it cannot execute, liquidate, or mutate an
 * account, and it is cleared after the policy epoch is rotated. */
export interface AutonomousPaperUpgradeDrain {
  laneId: string;
  fromPolicyVersion: string;
  toPolicyVersion: string;
  requestedAt: IsoDateTime;
}

export interface AutonomousPaperDashboard {
  label: typeof AUTONOMOUS_PAPER_LABEL;
  promotionEligible: false;
  executionEnabled: false;
  lane?: AutonomousPaperLane;
  account?: AutonomousPaperAccount;
  positions: AutonomousPaperPosition[];
  recentDecisions: AutonomousPaperDecision[];
  recentTrades: AutonomousPaperTrade[];
  replayLab?: AutonomousPaperReplayDashboard;
  /** Separate executable-path learner. It is analysis-only until its evidence
   * and explicit promotion gates pass. */
  learning?: AutonomousLearningOverview;
  upgradeDrain?: AutonomousPaperUpgradeDrain;
  /** Finalization time of the newest completed autonomous market scan. */
  lastScanAt?: IsoDateTime;
  updatedAt: IsoDateTime;
}

export const STOCK_PAPER_LABEL = "US STOCK HIGH-RISK PAPER — RESEARCH ONLY" as const;
export const STOCK_PAPER_POLICY_VERSION = "stock-paper-v3" as const;
export const STOCK_PAPER_FEATURE_VERSION = "stock-features-v3" as const;
export const STOCK_PAPER_EXECUTION_VERSION = "stock-execution-v3" as const;
export const STOCK_PAPER_LEARNING_VERSION = "stock-paper-learning-v3" as const;

export type StockPaperPolicyVersion = "stock-paper-v1" | typeof STOCK_PAPER_POLICY_VERSION;

export type StockPaperStrategyArm =
  | "BREAKOUT"
  | "OPENING_RANGE"
  | "PULLBACK_RECOVERY"
  | "VOLUME_SURGE";

export type StockPaperLaneStatus = "ACTIVE" | "PAUSED" | "ARCHIVED";

/** Frozen rules for the isolated stock simulation. This lane has no order,
 * signer, approval, or live-promotion identity. */
export interface StockPaperPolicy {
  scanIntervalSeconds: number;
  initialNavUsd: number;
  maximumOpenPositions: number;
  maximumDeployedFraction: number;
  minimumCashReserveUsd: number;
  maximumPositionNavFraction: number;
  /** Cold-start cap for an arm/market-phase context that has not accumulated
   * enough causal exits to establish its own performance. */
  warmupMaximumPositionNavFraction: number;
  /** Cap after the context clears warm-up but before it earns the stricter
   * confidence-gated UPSIZED state. */
  establishedMaximumPositionNavFraction: number;
  /** Leveraged and inverse products retain a separate individual cap because
   * one ticker can contain several times the economic exposure of a stock. */
  leveragedMaximumPositionNavFraction: number;
  /** Deterministic sector/theme proxy budget shared by correlated positions. */
  maximumExposureGroupNavFraction: number;
  normalRiskAtStopNavFraction: number;
  highConvictionRiskAtStopNavFraction: number;
  /** Fifteen-minute realized-volatility target used only to reduce, never
   * increase, the raw risk-at-stop allocation. */
  targetIntradayVolatilityPercent: number;
  minimumVolatilitySizeMultiplier: number;
  leveragedInstrumentSizeMultiplier: number;
  inverseInstrumentSizeMultiplier: number;
  minimumUpsizeContextTrades: number;
  stopLossPercent: number;
  takeProfitPercent: number;
  trailingActivationPercent: number;
  trailingDrawdownPercent: number;
  maximumHoldingMinutes: number;
  cooldownMinutes: number;
  stopCooldownMinutes: number;
  dailyLossPausePercent: number;
  maximumDrawdownPercent: number;
  maximumSpreadPercent: number;
  minimumPriceUsd: number;
  maximumPriceUsd: number;
  minimumDailyDollarVolumeUsd: number;
  minimumRelativeVolume: number;
  minimumSignalScore: number;
  universeSize: number;
  detailedCandidateCount: number;
  /** Extended-session execution rules are frozen with the lane so archived
   * decisions remain reproducible instead of depending on code constants. */
  extendedEntrySpreadPercent: number;
  extendedEntrySizeMultiplier: number;
  extendedMaximumOpenPositions: number;
  extendedFillPenaltyPercent: number;
  extendedLimitConfirmationMinutes: number;
  /** Free derived overnight bars arrive about fifteen minutes behind quotes,
   * so PAPER limits need a separate causal confirmation horizon. */
  overnightDerivedLimitConfirmationMinutes: number;
  maximumBarParticipationPercent: number;
  observationRetentionDays: number;
}

export interface StockPaperLane {
  id: string;
  label: typeof STOCK_PAPER_LABEL;
  purpose: "RESEARCH_ONLY";
  policyVersion: StockPaperPolicyVersion;
  policy: StockPaperPolicy;
  status: StockPaperLaneStatus;
  initialNavUsd: number;
  startedAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface StockPaperAccount {
  laneId: string;
  initialNavUsd: number;
  cashUsd: number;
  /** navUsd is the conservative executable value used for risk decisions. */
  navUsd: number;
  /** Mid/robust-mark value shown only as a valuation reference. */
  fairNavUsd?: number;
  executableNavUsd?: number;
  peakNavUsd: number;
  deployedUsd: number;
  fairDeployedUsd?: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  maxDrawdownPercent: number;
  openPositions: number;
  completedTrades: number;
  winningTrades: number;
  grossProfitUsd: number;
  grossLossUsd: number;
  pricingComplete: boolean;
  dayKey: string;
  dayStartNavUsd: number;
  pausedReason?: string;
  updatedAt: IsoDateTime;
}

export const STOCK_PAPER_CAPITAL_EVENT_VERSION = "stock-paper-capital-v1" as const;

/** An append-only simulated cash-flow record for the isolated stock PAPER
 * lane. Capital events alter research buying power, but are never broker
 * deposits and are excluded from trading profit. */
export interface StockPaperCapitalEvent {
  id: string;
  idempotencyKey: string;
  laneId: string;
  version: typeof STOCK_PAPER_CAPITAL_EVENT_VERSION;
  eventType: "DEPOSIT";
  reason: "USER_REQUESTED_BANKROLL_INCREASE";
  paperOnly: true;
  realMoney: false;
  excludedFromTradingPnl: true;
  targetNavUsd: number;
  deltaUsd: number;
  priorNavUsd: number;
  adjustedNavUsd: number;
  priorCashUsd: number;
  adjustedCashUsd: number;
  priorInitialNavUsd: number;
  adjustedInitialNavUsd: number;
  priorPeakNavUsd: number;
  adjustedPeakNavUsd: number;
  priorDayStartNavUsd: number;
  adjustedDayStartNavUsd: number;
  tradingPnlUsdBefore: number;
  tradingPnlUsdAfter: number;
  cumulativeExternalCapitalUsd: number;
  createdAt: IsoDateTime;
}

export type StockPaperPositionStatus = "OPEN" | "CLOSED" | "UNPRICED";

export type StockPaperMarketFeed = "IEX" | "OVERNIGHT";
export type StockPaperMarketPhase =
  | "OVERNIGHT"
  | "PREMARKET"
  | "REGULAR"
  | "AFTER_HOURS"
  | "CLOSED"
  | "UNKNOWN";
export type StockPaperLearningStatus = "WARMING_UP" | "NEUTRAL" | "DOWNSIZED" | "UPSIZED";

/** Immutable evidence captured when a simulated stock position is created.
 * It keeps learning walk-forward and prevents one market session from silently
 * training another. Older v1 rows intentionally have no entryContext. */
export interface StockPaperEntryContext {
  featureVersion: typeof STOCK_PAPER_FEATURE_VERSION;
  policyVersion: StockPaperPolicyVersion;
  executionVersion: typeof STOCK_PAPER_EXECUTION_VERSION;
  policyDigest: string;
  phase: StockPaperMarketPhase;
  feed: StockPaperMarketFeed;
  capturedAt: IsoDateTime;
  candidateRank: number;
  candidateScore: number;
  relativeVolume: number;
  spreadPercent: number;
  change1mPercent: number;
  change5mPercent: number;
  change15mPercent: number;
  newsArticleCount: number;
  screenerHit: boolean;
  learningMultiplier: number;
  learningStatus: StockPaperLearningStatus;
  learningSampleSize: number;
  downsideReference?: "NONE" | "GLOBAL" | "EXPOSURE_GROUP";
  downsideReferenceSampleSize?: number;
  downsideMultiplier?: number;
  modeledLimitPriceUsd: number;
  onlineSources: Array<"MOST_ACTIVE" | "MOVER" | "NEWS">;
  highConviction: boolean;
  dollarVolumeUsd: number;
  vwapDistancePercent: number;
  dailyChangePercent: number;
  /** Immutable portfolio-risk provenance for the simulated entry. */
  riskExposureGroup?: string;
  instrumentRiskClass?: "COMMON_STOCK" | "ETF" | "LEVERAGED_ETF" | "INVERSE_ETF";
  instrumentLeverageMultiple?: number;
  realizedVolatilityPercent?: number;
  riskLearningTier?: "WARMUP" | "ESTABLISHED" | "PROVEN";
  riskPositionCapNavFraction?: number;
  riskVolatilityMultiplier?: number;
  riskInstrumentMultiplier?: number;
  riskGroupExposureBeforeUsd?: number;
  quoteTimestamp?: IsoDateTime;
  barTimestamp?: IsoDateTime;
}

export type StockPaperOrderSide = "BUY" | "SELL";
export type StockPaperOrderStatus =
  | "SUBMITTED"
  | "PARTIAL"
  | "FILLED"
  | "CANCELED"
  | "EXPIRED"
  | "REJECTED";

export interface StockPaperOrderFill {
  id: string;
  quantity: number;
  priceUsd: number;
  notionalUsd: number;
  modeledCostsUsd: number;
  evidence: "QUOTE" | "BAR";
  evidenceAt: IsoDateTime;
  createdAt: IsoDateTime;
}

export type StockPaperOrderEventType = "SUBMISSION" | "STATUS_TRANSITION" | "FILL";

export interface StockPaperOrderFillAssumptions {
  executionVersion: typeof STOCK_PAPER_EXECUTION_VERSION;
  limitPriceUsd: number;
  participationRatePercent: number;
  marketable: boolean;
  /** Exact spread applied by the PAPER model. This is deliberately separate
   * from the causal bar clock because delayed feeds can deliver that bar well
   * after the quote used to model executable costs. */
  spreadPercent?: number;
  extendedFillPenaltyPercent?: number;
}

export type StockPaperBenchmarkRawEvidence =
  | {
      kind: "QUOTE";
      timestamp: IsoDateTime;
      bidPrice: number;
      bidSize: number;
      askPrice: number;
      askSize: number;
    }
  | {
      kind: "BAR";
      timestamp: IsoDateTime;
      open: number;
      high: number;
      low: number;
      close: number;
      volume: number;
      tradeCount: number;
      vwap: number;
    };

/** Append-only PAPER execution evidence. The scalar columns make the ledger
 * queryable while event_json preserves the complete deterministic artifact.
 * Missing quote/bar fields mean that evidence did not exist for that event;
 * they must never be reconstructed from a later market-data cycle. */
export interface StockPaperOrderEvent {
  id: string;
  idempotencyKey: string;
  laneId: string;
  orderId: string;
  /** Zero-based causal sequence within one order. Submission is zero, fills
   * follow their durable fill index, and a terminal no-fill transition follows
   * the last fill. */
  sequence: number;
  positionId?: string;
  symbol: string;
  side: StockPaperOrderSide;
  eventType: StockPaperOrderEventType;
  priorStatus?: StockPaperOrderStatus;
  newStatus: StockPaperOrderStatus;
  decisionAt: IsoDateTime;
  evidenceBarTimestamp?: IsoDateTime;
  evidenceObservedAt?: IsoDateTime;
  quoteTimestamp?: IsoDateTime;
  quoteDigest?: string;
  barDigest?: string;
  /** Immutable SPY evidence captured in the same decision cycle as a fill.
   * V4 research excludes fills that predate this field instead of rebuilding
   * a benchmark from market data fetched later. */
  benchmarkSymbol?: "SPY";
  benchmarkEvidence?: "QUOTE" | "BAR";
  benchmarkTimestamp?: IsoDateTime;
  benchmarkObservedAt?: IsoDateTime;
  benchmarkPriceUsd?: number;
  benchmarkDigest?: string;
  /** Canonical raw SPY quote/bar fields used to recompute benchmarkDigest.
   * Research must fail closed when this payload is absent or inconsistent. */
  benchmarkRawEvidence?: StockPaperBenchmarkRawEvidence;
  phase: StockPaperMarketPhase;
  feed: StockPaperMarketFeed;
  assumptions: StockPaperOrderFillAssumptions;
  fill?: StockPaperOrderFill;
  reason: string;
  createdAt: IsoDateTime;
}

/** Durable PAPER-only order intent. This is never routed to Alpaca trading and
 * exists solely to make restarts, partial fills and causal fill evidence
 * auditable. */
export interface StockPaperOrder {
  id: string;
  idempotencyKey: string;
  laneId: string;
  positionId?: string;
  symbol: string;
  arm: StockPaperStrategyArm;
  side: StockPaperOrderSide;
  status: StockPaperOrderStatus;
  phase: StockPaperMarketPhase;
  feed: StockPaperMarketFeed;
  policyVersion: StockPaperPolicyVersion;
  executionVersion: typeof STOCK_PAPER_EXECUTION_VERSION;
  submittedAt: IsoDateTime;
  expiresAt: IsoDateTime;
  /** Observed-time deadline for receiving causal SELL evidence. This second
   * clock prevents delayed or unavailable bars from leaving a liquidation
   * order pending forever. BUY orders continue to use expiresAt only. */
  evidenceTimeoutAt?: IsoDateTime;
  /** Original trigger clock and the later wall-clock instant at which that
   * evidence became available to the engine. */
  triggerEvidenceAt?: IsoDateTime;
  triggerObservedAt?: IsoDateTime;
  replacesOrderId?: string;
  rolloverCount?: number;
  firstEligibleBarAt?: IsoDateTime;
  lastEvaluatedBarAt?: IsoDateTime;
  limitPriceUsd: number;
  requestedQuantity: number;
  filledQuantity: number;
  averageFillPriceUsd?: number;
  reservedNotionalUsd: number;
  candidateScore: number;
  entryContext?: StockPaperEntryContext;
  /** Immutable liquidation provenance captured when a durable PAPER SELL is
   * armed. It lets a restart complete one trade from many participation-limited
   * fills without reconstructing the original cost basis from a reduced lot. */
  exitReason?: StockPaperExitReason;
  exitCostBasisUsd?: number;
  fills: StockPaperOrderFill[];
  reason?: string;
  updatedAt: IsoDateTime;
}

export interface StockPaperPosition {
  id: string;
  laneId: string;
  symbol: string;
  arm: StockPaperStrategyArm;
  status: StockPaperPositionStatus;
  quantity: number;
  entryPriceUsd: number;
  entryNotionalUsd: number;
  remainingCostUsd: number;
  lastBidUsd: number;
  lastAskUsd: number;
  lastMarkUsd: number;
  lastValueUsd: number;
  /** A delayed consolidated SIP bar may update fair value during the known
   * Alpaca Basic 04:00-08:00 ET coverage gap. This evidence is display and
   * accounting provenance only: it must never be treated as an executable
   * quote, order fill, stop/target trigger, or readiness price. */
  delayedFairValueEvidence?: {
    feed: "SIP_DELAYED";
    priceUsd: number;
    evidenceAt: IsoDateTime;
    observedAt: IsoDateTime;
    barDigest: string;
  };
  /** Conservative liquidation value after spread, impact, and any
   * extended-hours penalty. */
  lastExecutableValueUsd?: number;
  peakPriceUsd: number;
  stopPriceUsd: number;
  takeProfitPriceUsd: number;
  scoreAtEntry: number;
  entryContext?: StockPaperEntryContext;
  openedAt: IsoDateTime;
  /** Latest completed minute bar evaluated for protective stop/target logic.
   * This is a durable execution cursor and is intentionally independent of
   * quote-mark/update timestamps. */
  lastProtectiveBarAt?: IsoDateTime;
  updatedAt: IsoDateTime;
  closedAt?: IsoDateTime;
}

export interface StockPaperCandidate {
  symbol: string;
  name?: string;
  exchange?: string;
  /** Recent persisted one-minute close prices used only for truthful UI
   * visualization. The strategy decision remains based on the explicit
   * momentum fields below. */
  sparklinePricesUsd?: number[];
  priceUsd: number;
  bidUsd: number;
  askUsd: number;
  spreadPercent: number;
  change1mPercent: number;
  change5mPercent: number;
  change15mPercent: number;
  changeFromOpenPercent: number;
  dailyChangePercent: number;
  relativeVolume: number;
  dollarVolumeUsd: number;
  vwapDistancePercent: number;
  /** Root-mean-square one-minute return, scaled to a fifteen-minute window. */
  realizedVolatilityPercent?: number;
  score: number;
  arm: StockPaperStrategyArm;
  highConviction: boolean;
  eligible: boolean;
  reasons: string[];
  marketPhase?: StockPaperMarketPhase;
  marketFeed?: StockPaperMarketFeed;
  onlineSources?: Array<"MOST_ACTIVE" | "MOVER" | "NEWS">;
  newsArticleCount?: number;
  capturedAt: IsoDateTime;
}

export type StockPaperObservationDecision =
  | "ORDER_SUBMITTED"
  | "BOUGHT"
  | "REJECTED"
  | "CAPACITY_BLOCKED"
  | "COOLDOWN_BLOCKED"
  | "ALREADY_OPEN"
  | "OBSERVED";

/** Append-only feature evidence. Current dashboard candidates can rotate, but
 * these rows never change and can therefore support causal later labels. */
export interface StockPaperObservation {
  id: string;
  laneId: string;
  symbol: string;
  observedAt: IsoDateTime;
  /** Fifteen-minute sampling bucket used only for idempotency. The evidence
   * timestamp above remains the exact time the decision was known. */
  idempotencyBucket: IsoDateTime;
  policyVersion: StockPaperPolicyVersion;
  policy: StockPaperPolicy;
  featureVersion: typeof STOCK_PAPER_FEATURE_VERSION;
  executionVersion: typeof STOCK_PAPER_EXECUTION_VERSION;
  policyDigest: string;
  phase: StockPaperMarketPhase;
  feed: StockPaperMarketFeed;
  candidate: StockPaperCandidate;
  tradeDayKey: string;
  candidateRank: number;
  confirmationSamples: number;
  entryPriceUsd: number;
  entryNotionalUsd: number;
  sessionMinute: number;
  newsArticleIds: number[];
  hardSafetyPassed: boolean;
  safetyVetoes: string[];
  decision: StockPaperObservationDecision;
  reasons: string[];
  benchmarkPriceUsd?: number;
  quoteTimestamp?: IsoDateTime;
  barTimestamp?: IsoDateTime;
}

export type StockPaperOutcomeHorizonMinutes = 15 | 45 | 180;
export interface StockPaperObservationOutcome {
  observationId: string;
  laneId: string;
  symbol: string;
  horizonMinutes: StockPaperOutcomeHorizonMinutes;
  status: "LABELED" | "MISSING";
  entryPriceUsd: number;
  exitPriceUsd?: number;
  netReturnPercent?: number;
  mfePercent?: number;
  maePercent?: number;
  benchmarkReturnPercent?: number;
  benchmarkExcessReturnPercent?: number;
  missingReason?: string;
  /** Full immutable analysis-only label produced by the v3 learner. */
  analysisEvidence?: Record<string, unknown>;
  dueAt: IsoDateTime;
  labeledAt: IsoDateTime;
}

export const STOCK_PAPER_ROTATION_SHADOW_VERSION =
  "stock-paper-rotation-shadow-v1" as const;

/** Frozen controls for the one-step position-rotation counterfactual. The
 * challenger observes the authoritative PAPER lane but has no order, position,
 * account, signer, or promotion identity of its own. */
export interface StockPaperRotationPolicy {
  version: typeof STOCK_PAPER_ROTATION_SHADOW_VERSION;
  minimumPositionAgeMinutes: number;
  rotationCooldownMinutes: number;
  minimumScoreDelta: number;
  minimumReplacementNotionalUsd: number;
  maximumSwitchCostPercent: number;
}

export type StockPaperRotationReasonCode =
  | "NO_CURRENT_ELIGIBLE_OPEN_POSITION"
  | "NO_CURRENT_ELIGIBLE_REPLACEMENT"
  | "POSITION_TOO_YOUNG"
  | "ROTATION_COOLDOWN_ACTIVE"
  | "SYMBOL_COOLDOWN_ACTIVE"
  | "SCORE_DELTA_BELOW_MINIMUM"
  | "REPLACEMENT_SIZE_BELOW_MINIMUM"
  | "SWITCH_COST_ABOVE_MAXIMUM"
  | "INVALID_ACCOUNT_STATE";

export interface StockPaperRotationOutgoingLeg {
  positionId: string;
  symbol: string;
  openedAt: IsoDateTime;
  ageMinutes: number;
  candidateCapturedAt: IsoDateTime;
  currentScore: number;
  currentRelativeVolume: number;
  bidUsd: number;
  askUsd: number;
  spreadPercent: number;
  quantity: number;
  remainingCostUsd: number;
  executableReturnPercent: number;
  modeledSellPriceUsd: number;
  executableProceedsUsd: number;
  modeledExitCostUsd: number;
}

export interface StockPaperRotationIncomingLeg {
  symbol: string;
  candidateCapturedAt: IsoDateTime;
  currentScore: number;
  currentRelativeVolume: number;
  bidUsd: number;
  askUsd: number;
  spreadPercent: number;
  modeledBuyPriceUsd: number;
  quantity: number;
  entryNotionalUsd: number;
  modeledEntryCostUsd: number;
}

/** Immutable analysis decision. A ROTATE result means only that the
 * counterfactual should be labeled later; it never represents a submitted or
 * simulated order in the authoritative PAPER portfolio. */
export interface StockPaperRotationDecision {
  id: string;
  idempotencyKey: string;
  laneId: string;
  version: typeof STOCK_PAPER_ROTATION_SHADOW_VERSION;
  policy: StockPaperRotationPolicy;
  policyDigest: string;
  sourcePolicyDigest: string;
  idempotencyBucket: IsoDateTime;
  decisionAt: IsoDateTime;
  phase: StockPaperMarketPhase;
  feed: StockPaperMarketFeed;
  extendedFillPenaltyPercent: number;
  status: "ROTATE" | "HOLD";
  reasonCodes: StockPaperRotationReasonCode[];
  analysisOnly: true;
  affectsTrading: false;
  promotionEligible: false;
  portfolioCounterfactual: false;
  resultsAreIndependentOneStepCounterfactuals: true;
  outgoing?: StockPaperRotationOutgoingLeg;
  incoming?: StockPaperRotationIncomingLeg;
  scoreDelta?: number;
  modeledSwitchCostsUsd?: number;
  modeledSwitchCostPercent?: number;
  preRotationNavUsd: number;
  preRotationCashUsd: number;
  preRotationDeployedUsd: number;
  hypotheticalPostSaleCashUsd?: number;
  hypotheticalPostSaleDeployedUsd?: number;
  hypotheticalPostSaleNavUsd?: number;
  hypotheticalPostEntryCashUsd?: number;
  hypotheticalPostEntryDeployedUsd?: number;
  hypotheticalPostEntryNavUsd?: number;
}

export type StockPaperRotationOutcomeMissingReason =
  | "DECISION_DID_NOT_ROTATE"
  | "HORIZON_NOT_DUE"
  | "OUTGOING_NO_STRICTLY_FUTURE_BARS"
  | "INCOMING_NO_STRICTLY_FUTURE_BARS"
  | "OUTGOING_PATH_GAP"
  | "INCOMING_PATH_GAP"
  | "OUTGOING_INVALID_BAR"
  | "INCOMING_INVALID_BAR"
  | "OUTGOING_CONFLICTING_BAR"
  | "INCOMING_CONFLICTING_BAR";

/** A cost-adjusted comparison between continuing to hold the outgoing lot and
 * the one-step rotation. Overlapping decisions remain correlated observations;
 * their results must not be compounded into a virtual NAV. */
export interface StockPaperRotationOutcome {
  id: string;
  idempotencyKey: string;
  decisionId: string;
  laneId: string;
  version: typeof STOCK_PAPER_ROTATION_SHADOW_VERSION;
  horizonMinutes: StockPaperOutcomeHorizonMinutes;
  status: "LABELED" | "MISSING";
  dueAt: IsoDateTime;
  labeledAt: IsoDateTime;
  analysisOnly: true;
  affectsTrading: false;
  promotionEligible: false;
  portfolioCounterfactual: false;
  resultsAreIndependentOneStepCounterfactuals: true;
  missingReason?: StockPaperRotationOutcomeMissingReason;
  outgoingFirstBarAt?: IsoDateTime;
  outgoingLastBarAt?: IsoDateTime;
  incomingFirstBarAt?: IsoDateTime;
  incomingLastBarAt?: IsoDateTime;
  baselineExitPriceUsd?: number;
  baselineExitProceedsUsd?: number;
  baselineModeledExitCostUsd?: number;
  baselineHoldPnlUsd?: number;
  rotatedIncomingExitPriceUsd?: number;
  rotatedIncomingExitProceedsUsd?: number;
  rotatedIncomingModeledExitCostUsd?: number;
  rotatedPnlUsd?: number;
  totalRotationModeledCostsUsd?: number;
  incrementalPnlUsd?: number;
  incrementalReturnPercent?: number;
}

export interface StockPaperRotationSummary {
  version: typeof STOCK_PAPER_ROTATION_SHADOW_VERSION;
  analysisOnly: true;
  affectsTrading: false;
  promotionEligible: false;
  portfolioCounterfactual: false;
  resultsAreIndependentOneStepCounterfactuals: true;
  compoundedPortfolioNavAvailable: false;
  evaluatedDecisions: number;
  proposedRotations: number;
  heldDecisions: number;
  labeledOutcomes: number;
  missingOutcomes: number;
  incrementalWins: number;
  incrementalWinRatePercent: number;
  meanIncrementalPnlUsd: number;
  meanIncrementalReturnPercent: number;
  recentDecisions: StockPaperRotationDecision[];
  recentOutcomes: StockPaperRotationOutcome[];
  updatedAt: IsoDateTime;
}

export interface StockPaperShadowPolicyScore {
  policyId: string;
  policyDigest: string;
  datasetDigest: string;
  learnerVersion: typeof STOCK_PAPER_LEARNING_VERSION;
  horizonMinutes: StockPaperOutcomeHorizonMinutes;
  evaluatedAt: IsoDateTime;
  observations: number;
  labeled: number;
  trades: number;
  wins: number;
  netReturnPercent: number;
  averageReturnPercent: number;
  maximumDrawdownPercent: number;
  /** Paths may overlap in time and are not an executable portfolio equity curve. */
  pathsAreIndependentTrades: false;
  promotionEligible: false;
}

export type StockPaperWalkForwardStatus =
  | "COLLECTING"
  | "INSUFFICIENT_EVIDENCE"
  | "ANALYSIS_GATES_FAILED"
  | "ANALYSIS_GATES_PASSED";

export interface StockPaperWalkForwardSummary {
  status: StockPaperWalkForwardStatus;
  analysisOnly: true;
  mayAffectTrading: false;
  promotionEligible: false;
  evaluatedAt: IsoDateTime;
  cutoffAt: IsoDateTime;
  horizonMinutes: StockPaperOutcomeHorizonMinutes;
  folds: number;
  holdoutScorablePaths: number;
  coveragePercent: number;
  distinctSymbols: number;
  distinctTradeDays: number;
  datasetDigest: string;
  /** Digest of the exact frozen shadow-policy set, including any bound
   * research manifest, used for this checkpoint. */
  policySetDigest: string;
  /** Versioned digest of the learner, gates, policies, folds, and dataset. */
  evaluationDigest: string;
  gateReasons: string[];
}

export interface StockPaperOutcomeMissingReasonSummary {
  reason: string;
  count: number;
}

export type StockPaperOutcomeSessionPhase = Extract<
  StockPaperMarketPhase,
  "REGULAR" | "PREMARKET" | "AFTER_HOURS" | "OVERNIGHT"
>;

/** Outcome completeness for one session/feed lane. Keeping these figures
 * separate prevents sparse overnight history from obscuring regular-session
 * evidence quality. */
export interface StockPaperOutcomeSessionQualitySummary {
  phase: StockPaperOutcomeSessionPhase;
  totalObservations: number;
  dueObservations: number;
  labeledOutcomes: number;
  missingOutcomes: number;
  pendingDueOutcomes: number;
  futureOutcomes: number;
  completionPercent: number;
  eligibleCoveragePercent: number;
  topMissingReasons: StockPaperOutcomeMissingReasonSummary[];
}

/** Data-completeness diagnostics for one causal outcome horizon. A pending
 * due outcome is distinct from an observation whose horizon has not elapsed. */
export interface StockPaperOutcomeQualitySummary {
  horizonMinutes: StockPaperOutcomeHorizonMinutes;
  totalObservations: number;
  dueObservations: number;
  labeledOutcomes: number;
  missingOutcomes: number;
  pendingDueOutcomes: number;
  futureOutcomes: number;
  completionPercent: number;
  eligibleCoveragePercent: number;
  oldestPendingObservedAt?: IsoDateTime;
  topMissingReasons: StockPaperOutcomeMissingReasonSummary[];
  sessionBreakdown: StockPaperOutcomeSessionQualitySummary[];
}

export type StockPaperMarketRegimeV4 =
  | "UP_LOW_VOL"
  | "UP_HIGH_VOL"
  | "DOWN_LOW_VOL"
  | "DOWN_HIGH_VOL"
  | "SIDEWAYS_LOW_VOL"
  | "SIDEWAYS_HIGH_VOL"
  | "INSUFFICIENT_HISTORY";

export type StockPaperLearningV4Status =
  | "COLLECTING_V41_EVIDENCE"
  | "INSUFFICIENT_EVIDENCE"
  | "ANALYSIS_READY";

/** Compact dashboard projection of the immutable v4 research artifact. It is
 * intentionally unable to promote a policy or affect live/PAPER decisions. */
export interface StockPaperLearningV4Summary {
  version: "stock-paper-learning-v4-analysis";
  status: StockPaperLearningV4Status;
  analysisOnly: true;
  affectsTrading: false;
  promotionEligible: false;
  portfolioCounterfactual: false;
  cutoffAt: IsoDateTime;
  evidenceDigest: string;
  datasetDigest: string;
  outputDigest: string;
  provenance: {
    datasetSchemaVersion: string;
    sourceLaneId: string | null;
    policyVersion: string | null;
    featureVersion: string | null;
    executionVersion: string | null;
    adjustedRegularSessionReturnsOnly: true;
    cutoffIndependentDatasetSeed: true;
  };
  sourceTradeCount: number;
  analyzedTradeCount: number;
  excludedTradeCount: number;
  exclusionReasons: Array<{ reason: string; count: number }>;
  /** Added after the first v41 deployment. It is optional only so immutable
   * summaries written by the immediately preceding build remain readable. */
  evidenceHealth?: {
    status: "HEALTHY" | "POST_V41_EXCLUSIONS" | "ACTIVATION_UNKNOWN";
    v41EvidenceStartedAt?: IsoDateTime;
    legacyExcludedTradeCount: number;
    postV41ExcludedTradeCount: number;
    postV41ExclusionReasons: Array<{ reason: string; count: number }>;
  };
  uniqueSymbols: number;
  uniqueTradeDays: number;
  dailyReturnSymbols: number;
  spyHistoryDays: number;
  replay: {
    realizedPathOnly: true;
    portfolioCounterfactual: false;
    fixedHistoricalNotionals: true;
    initialNavUsd: number;
    endingNavUsd: number;
    totalPnlUsd: number;
    returnPercent: number;
    maximumDrawdownPercent: number;
    maximumConcurrentPositions: number;
    maximumGrossExposureUsd: number;
  };
  spyExcess: {
    tradeCount: number;
    excessPnlUsd: number;
    notionalWeightedExcessReturnPercent: number;
    excessWinRatePercent: number;
  };
  bootstrap: {
    fixedHistoricalNotionals: true;
    activeTradeDays: number;
    returnPercentP05: number;
    returnPercentP50: number;
    returnPercentP95: number;
    excessReturnPercentP05: number;
    excessReturnPercentP50: number;
    excessReturnPercentP95: number;
    probabilityPositiveReturnPercent: number;
    probabilityPositiveExcessPercent: number;
  };
  drift: {
    status: "INSUFFICIENT_HISTORY" | "IMPROVING" | "STABLE" | "DETERIORATING";
    earlyDayCount: number;
    recentDayCount: number;
    spyExcessDeltaPercent: number;
    symbolMixJensenShannonDivergence: number;
  };
  correlations: {
    pairCoveragePercent: number;
    concurrentPairCount: number;
    concurrentPairUnavailableCount: number;
    concurrentExposureWeightedCorrelation?: number;
    highestPositivePair?: {
      leftSymbol: string;
      rightSymbol: string;
      overlapDays: number;
      correlation: number;
    };
  };
  regimePerformance: Array<{
    regime: StockPaperMarketRegimeV4;
    tradeCount: number;
    pnlUsd: number;
    meanSpyExcessPercent: number;
  }>;
  sectorPerformance: Array<{
    sector: string;
    tradeCount: number;
    pnlUsd: number;
    absolutePnlSharePercent: number;
    meanSpyExcessPercent: number;
  }>;
  warnings: string[];
}

export type StockPaperBookResearchStatus =
  | "ACTIVE_EVIDENCE"
  | "SHADOW_TESTING"
  | "DATA_REQUIRED"
  | "EXCLUDED";

/** Public bibliographic identity for a user-provided research source. `sha256`
 * is derived only from the committed source id, title, author, and format; it
 * is not a checksum of a user's local file. Book text is intentionally not
 * copied into the dashboard or a model prompt. */
interface StockPaperBookResearchSourceBase {
  id: string;
  title: string;
  author?: string;
  format: "PDF" | "EPUB";
  sha256: string;
  userProvided: true;
  contentCopied: false;
  reviewNote: string;
}

export type StockPaperBookResearchSource = StockPaperBookResearchSourceBase & (
  | { reviewStatus: "CURATED" | "CAUTION"; researchEligible: true }
  | { reviewStatus: "QUARANTINED"; researchEligible: false }
);

/** A paraphrased, pre-registered hypothesis derived from one or more sources.
 * Every item stays analysis-only even when an associated shadow policy scores
 * well. Long-horizon claims that lack point-in-time data remain unavailable. */
export interface StockPaperBookResearchHypothesis {
  id: string;
  label: string;
  status: StockPaperBookResearchStatus;
  summary: string;
  implementation: string;
  sources: Array<{ sourceId: string; locator: string }>;
  analysisOnly: true;
  affectsTrading: false;
  promotionEligible: false;
  shadowPolicyId?: string;
  proxyWarning?: string;
  requiredData?: string[];
  exclusionReason?: string;
}

/** Dashboard projection of the immutable source registry and its deliberately
 * bounded research mappings. This is a hypothesis ledger, not model weights,
 * financial advice, or proof that a book claim works. */
export interface StockPaperBookResearchSummary {
  version: "stock-paper-book-research-v2";
  analysisOnly: true;
  affectsTrading: false;
  promotionEligible: false;
  fingerprintAlgorithm: "SHA-256";
  shadowManifestDigest: string;
  policyTestsUseCausalOutcomes: true;
  sourceCount: number;
  curatedSourceCount: number;
  cautionSourceCount: number;
  quarantinedSourceCount: number;
  activeEvidenceCount: number;
  shadowTestingCount: number;
  dataRequiredCount: number;
  excludedCount: number;
  sources: StockPaperBookResearchSource[];
  hypotheses: StockPaperBookResearchHypothesis[];
  warnings: string[];
}

export interface StockPaperLearningDashboard {
  version: typeof STOCK_PAPER_LEARNING_VERSION;
  observations: number;
  labeledOutcomes: number;
  missingOutcomes: number;
  pendingOutcomes: number;
  eligibleCoveragePercent: number;
  distinctSymbols: number;
  distinctDays: number;
  shadowPolicies: StockPaperShadowPolicyScore[];
  walkForward?: StockPaperWalkForwardSummary;
  outcomeQuality: StockPaperOutcomeQualitySummary[];
  advancedAnalysis?: StockPaperLearningV4Summary;
  rotationShadow?: StockPaperRotationSummary;
  bookResearch: StockPaperBookResearchSummary;
  promotionEnabled: false;
}

export type StockPaperSignalOutcome =
  | "SIMULATED"
  | "REJECTED"
  | "ANALYSIS_ONLY"
  | "FAILED";

export interface StockPaperSignal {
  id: string;
  laneId: string;
  symbol: string;
  arm: StockPaperStrategyArm;
  action: "BUY" | "SELL" | "OBSERVE" | "REJECT";
  outcome: StockPaperSignalOutcome;
  score: number;
  notionalUsd?: number;
  priceUsd?: number;
  reasons: string[];
  observedAt: IsoDateTime;
}

export interface StockPaperReplaySummary {
  variantCount: 1000;
  scorableVariantCount: number;
  profitableVariantCount: number;
  actualReturnPercent: number;
  actualPercentile: number;
  bestReturnPercent: number;
  bestStopLossPercent: number;
  bestTakeProfitPercent: number;
  bestTrailingPercent: number;
  generatedAt: IsoDateTime;
}

export type StockPaperTradePathCompleteness = "COMPLETE" | "PARTIAL" | "UNAVAILABLE";

export type StockPaperTradePathMissingReason =
  | "INVALID_BOUNDARY"
  | "INVALID_ENTRY_PRICE"
  | "NO_FULLY_HELD_MINUTE"
  | "NO_RECORDED_BARS"
  | "INVALID_RECORDED_BAR"
  | "CONFLICTING_DUPLICATE_BAR"
  | "PATH_STARTS_LATE"
  | "PATH_GAP"
  | "PATH_ENDS_EARLY";

/** Immutable, PAPER-only intratrade evidence. Excursion metrics are present
 * only when every fully-held minute between entry and liquidation has a valid
 * recorded bar; incomplete paths remain explicit rather than being filled. */
export interface StockPaperTradePathEvidence {
  schemaVersion: "stock-paper-trade-path-v1";
  provenance: "RECORDED_CAUSAL_MINUTE_BARS";
  metricBasis: "BAR_HIGH_LOW_VS_AVERAGE_ENTRY_PRICE";
  causalWindow: "ENTRY_MINUTE_EXCLUSIVE_EXIT_MINUTE_EXCLUSIVE";
  completeness: StockPaperTradePathCompleteness;
  missingReasons: StockPaperTradePathMissingReason[];
  openedAt: IsoDateTime;
  exitedAt: IsoDateTime;
  expectedBars: number;
  barsUsed: number;
  firstBarAt?: IsoDateTime;
  lastBarAt?: IsoDateTime;
  pathDigest?: string;
  maximumFavorableExcursionPercent?: number;
  maximumAdverseExcursionPercent?: number;
  generatedAt: IsoDateTime;
}

export type StockPaperExitReason =
  | "STOP_LOSS"
  | "TAKE_PROFIT"
  | "TRAILING_STOP"
  | "MAX_HOLD"
  | "SESSION_END"
  | "DATA_SAFETY";

export interface StockPaperTrade {
  id: string;
  laneId: string;
  positionId: string;
  symbol: string;
  arm: StockPaperStrategyArm;
  quantity: number;
  entryPriceUsd: number;
  exitPriceUsd: number;
  entryNotionalUsd: number;
  proceedsUsd: number;
  modeledCostsUsd: number;
  pnlUsd: number;
  returnPercent: number;
  exitReason: StockPaperExitReason;
  openedAt: IsoDateTime;
  closedAt: IsoDateTime;
  entryContext?: StockPaperEntryContext;
  pathEvidence?: StockPaperTradePathEvidence;
  replay?: StockPaperReplaySummary;
}

export interface StockPaperEquityPoint {
  capturedAt: IsoDateTime;
  navUsd: number;
  cashUsd: number;
  deployedUsd: number;
  drawdownPercent: number;
  /** Cumulative simulated deposits. Charts subtract this amount so a bankroll
   * increase cannot be rendered as strategy profit. */
  cumulativeExternalCapitalUsd?: number;
  benchmarkPriceUsd?: number;
  benchmarkReturnPercent?: number;
}

export interface StockPaperArmStats {
  arm: StockPaperStrategyArm;
  trades: number;
  wins: number;
  winRatePercent: number;
  pnlUsd: number;
  profitFactor?: number;
  adaptiveSizingMultiplier: number;
  learningStatus?: StockPaperLearningStatus;
  learningSampleSize?: number;
  conservativeReturnPercent?: number;
}

export interface StockPaperMarketStatus {
  feed: StockPaperMarketFeed;
  isOpen: boolean;
  phase: StockPaperMarketPhase;
  /** The exchange session clock can be active while a free feed has no current
   * evidence. isOpen/feedActionable only become true when fresh data exists. */
  sessionActive?: boolean;
  feedActionable?: boolean;
  nextOpen?: IsoDateTime;
  nextClose?: IsoDateTime;
  requestedSymbols?: number;
  returnedSnapshots?: number;
  freshSnapshots?: number;
  prefilteredSnapshots?: number;
  scannedSymbols: number;
  detailedSymbols: number;
  eligibleSymbols?: number;
  dynamicSymbols?: number;
  newsSymbols?: number;
  screenerStatus?: "LIVE" | "STALE" | "FALLBACK" | "UNAVAILABLE";
  newsStatus?: "LIVE" | "STALE" | "FALLBACK" | "UNAVAILABLE";
  screenerSourceUpdatedAt?: IsoDateTime;
  newestNewsAt?: IsoDateTime;
  onlineSignalsUpdatedAt?: IsoDateTime;
  quoteAgeMs?: number;
  barAgeMs?: number;
  barFreshnessLimitMs?: number;
  pricingEvidenceMode?: "REAL_TIME" | "DELAYED_DERIVED";
  /** Delayed consolidated evidence can keep fair NAV current while executable
   * IEX pricing remains correctly unavailable. */
  delayedFairValueFeed?: "SIP";
  delayedFairValueAt?: IsoDateTime;
  freshCoveragePercent?: number;
  openPositionPricingCoveragePercent?: number;
  overnightEligibleAssets?: number;
  overnightFractionalAssets?: number;
  overnightHaltedAssets?: number;
  pendingOrders?: number;
  streamStatus?: "DISABLED" | "CONNECTING" | "AUTHENTICATING" | "LIVE" | "RECONNECTING" | "ERROR";
  streamSymbols?: number;
  streamReconnects?: number;
  streamLastMessageAt?: IsoDateTime;
  streamLastQuoteAt?: IsoDateTime;
  streamLastBarAt?: IsoDateTime;
  streamQuoteMessages?: number;
  streamBarMessages?: number;
  streamLastError?: string;
  calendarStatus?: "VERIFIED" | "FALLBACK" | "UNAVAILABLE";
  corporateActionBlockedSymbols?: number;
  readiness?: {
    status: "READY" | "WARMING" | "BLOCKED";
    reasons: string[];
    countdownSeconds?: number;
    checkedAt: IsoDateTime;
  };
  providerRequests: number;
  scanDurationMs?: number;
  lastScanAt?: IsoDateTime;
  lastError?: string;
}

export interface StockPaperDashboard {
  label: typeof STOCK_PAPER_LABEL;
  promotionEligible: false;
  executionEnabled: false;
  paperOnly: true;
  lane?: StockPaperLane;
  account?: StockPaperAccount;
  positions: StockPaperPosition[];
  candidates: StockPaperCandidate[];
  recentSignals: StockPaperSignal[];
  recentTrades: StockPaperTrade[];
  equityCurve: StockPaperEquityPoint[];
  capitalEvents?: StockPaperCapitalEvent[];
  armStats: StockPaperArmStats[];
  orders: StockPaperOrder[];
  learning: StockPaperLearningDashboard;
  market: StockPaperMarketStatus;
  updatedAt: IsoDateTime;
}

export type PaperComparisonKind = "STRICT_COPY" | "HIGH_RISK_COPY" | "AUTONOMOUS_HIGH_RISK";
export type PaperComparisonStatus = "ACTIVE" | "PAUSED" | "NOT_STARTED";
export type PaperComparisonBasis = "SINGLE_ACCOUNT" | "EQUAL_WEIGHT_PER_ACCOUNT";

/** Server-normalized performance for an apples-to-apples PAPER comparison.
 * Multi-wallet research is equal-weighted back to one starting bankroll and
 * is never presented as a pooled balance. */
export interface PaperComparisonSnapshot {
  kind: PaperComparisonKind;
  label: string;
  status: PaperComparisonStatus;
  basis: PaperComparisonBasis;
  sampleSize: number;
  initialNavUsd: number;
  normalizedNavUsd: number;
  normalizedPnlUsd: number;
  netReturnPercent: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  maxDrawdownPercent: number;
  completedTrades: number;
  openPositions: number;
  winRatePercent?: number;
  profitFactor?: number;
  pricingComplete: boolean;
  /** Optional robust diagnostic for multi-account research. Raw ledger values
   * remain above for audit; UI may prefer these values when one account
   * dominates the equal-weight result. */
  evidenceStatus?: ResearchPaperPerformanceEvidenceStatus;
  robustNormalizedNavUsd?: number;
  robustNormalizedPnlUsd?: number;
  robustNetReturnPercent?: number;
  medianAccountPnlUsd?: number;
  excludedOutlierWallet?: PublicKeyString;
  excludedOutlierPnlUsd?: number;
  reconciliationDependentAccountCount?: number;
  evidenceDisclosure?: string;
  /** Last balance-changing ledger update, when distinct from scan freshness. */
  accountUpdatedAt?: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface RiskPolicy {
  initialNavUsd: number;
  initialSolAllocationUsd: number;
  maxPositionUsd: number;
  positionNavFraction: number;
  maxOpenPositions: number;
  maxDeployedFraction: number;
  minimumSolReserveUsd: number;
  minimumLiquidReserveUsd: number;
  maximumSignalAgeSeconds: number;
  maximumQuoteAgeSeconds: number;
  maximumPriceImpactPercent: number;
  maximumLeaderDivergencePercent: number;
  maximumRoundTripCostPercent: number;
  positionStopLossPercent: number;
  maximumHoldingDays: number;
  dailyLossPausePercent: number;
  hardLiveStartLossPercent: number;
  hardDrawdownPercent: number;
  minimumExitUsd: number;
}

export const DEFAULT_RISK_POLICY: Readonly<RiskPolicy> = Object.freeze({
  initialNavUsd: 141,
  initialSolAllocationUsd: 6,
  // Compound at 10% of executable NAV, with a conservative absolute ceiling.
  maxPositionUsd: 25,
  positionNavFraction: 0.1,
  maxOpenPositions: 3,
  maxDeployedFraction: 0.3,
  minimumSolReserveUsd: 5,
  minimumLiquidReserveUsd: 10,
  maximumSignalAgeSeconds: 20,
  maximumQuoteAgeSeconds: 5,
  maximumPriceImpactPercent: 0.5,
  maximumLeaderDivergencePercent: 1,
  maximumRoundTripCostPercent: 2,
  positionStopLossPercent: 15,
  maximumHoldingDays: 7,
  dailyLossPausePercent: 5,
  hardLiveStartLossPercent: 10,
  hardDrawdownPercent: 10,
  minimumExitUsd: 1
});

export interface TokenPolicy {
  minimumAgeDays: number;
  minimumLiquidityUsd: number;
  minimumVolume24hUsd: number;
  minimumHolderCount: number;
  minimumOrganicScore: number;
  maximumTopHoldersPercent: number;
  requireVerified: boolean;
  requireStandardTokenProgram: boolean;
}

export const DEFAULT_TOKEN_POLICY: Readonly<TokenPolicy> = Object.freeze({
  minimumAgeDays: 30,
  minimumLiquidityUsd: 5_000_000,
  minimumVolume24hUsd: 1_000_000,
  minimumHolderCount: 1_000,
  minimumOrganicScore: 70,
  maximumTopHoldersPercent: 30,
  requireVerified: true,
  requireStandardTokenProgram: true
});

export interface WalletQualificationPolicy {
  minimumHistoryDays: number;
  minimumClosedEligibleSwaps: number;
  minimumActiveWeeks: number;
  minimumMedianHoldingMinutes: number;
  maximumTopTokenProfitShare: number;
  maximumTopThreeProfitShare: number;
  disallowedTags: string[];
}

export const DEFAULT_WALLET_POLICY: Readonly<WalletQualificationPolicy> = Object.freeze({
  minimumHistoryDays: 90,
  minimumClosedEligibleSwaps: 50,
  minimumActiveWeeks: 3,
  minimumMedianHoldingMinutes: 15,
  maximumTopTokenProfitShare: 0.35,
  maximumTopThreeProfitShare: 0.6,
  disallowedTags: ["dev", "bundler", "sniper", "insider"]
});

export interface DashboardSnapshot {
  mode: ModeState;
  pausedFrom?: ModeState;
  dataProvider: DataProviderStatus;
  solPriceBootstrap: SolPriceBootstrapStatus;
  operationalPause: OperationalPauseState;
  operationalTelemetry: OperationalTelemetrySnapshot;
  providerHealth: ProviderHealth[];
  liveOperations: LiveOperationsSnapshot;
  portfolio: PortfolioSnapshot;
  promotion: PromotionGate;
  walletIndex: WalletIndexDashboardSnapshot;
  activeWallets: Array<WalletCandidate & {
    score?: WalletScore;
    trackingLane: "ACTIVE" | "SHADOW" | "CONTROL";
  }>;
  positions: PositionLot[];
  recentExecutions: ExecutionRecord[];
  recentSignals: SignalAuditRecord[];
  pendingApprovals: ExecutionRecord[];
  /** Separate, visibly labeled simulation data; never included in promotion or live selection. */
  researchPaper?: ResearchPaperDashboard;
  /** Autonomous strategy simulation with no source-wallet or execution path. */
  autonomousPaper?: AutonomousPaperDashboard;
  /** Isolated US-stock simulation using Alpaca Paper authentication and free IEX data. */
  stockPaper?: StockPaperDashboard;
  /** Normalized, non-pooled comparison across the three PAPER experiments. */
  paperComparisons?: PaperComparisonSnapshot[];
  updatedAt: IsoDateTime;
}

export type OperationalTelemetryStatus = "HEALTHY" | "WARNING" | "CRITICAL" | "UNAVAILABLE";

export type OperationalTelemetryIssueCode =
  | "DRIVE_CAPACITY_UNAVAILABLE"
  | "DRIVE_CAPACITY_CRITICAL"
  | "DRIVE_CAPACITY_LOW"
  | "WAL_LARGE"
  | "INDEX_QUEUE_FAILED"
  | "INDEX_BACKLOG_STALE"
  | "INDEX_BACKLOG_AGING"
  | "INDEX_RETRY_PENDING"
  | "INDEX_HEAD_STALE"
  | "INDEX_HEAD_AGING"
  | "MONITORING_REPAIR_FAILED"
  | "MONITORING_REPAIR_PENDING"
  | "MONITORING_STREAM_UNHEALTHY"
  | "MONITORING_SOURCE_BACKLOG"
  | "RECENT_CRITICAL_AUDIT"
  | "RECENT_WARNING_AUDIT"
  | "TELEMETRY_UNAVAILABLE";

export interface OperationalTelemetryIssue {
  severity: "WARNING" | "CRITICAL";
  code: OperationalTelemetryIssueCode;
  /** Deliberately operator-safe: no endpoint, filesystem path, or credential detail. */
  message: string;
}

export interface OperationalStorageTelemetry {
  databaseBytes: number;
  walBytes: number;
  pageSizeBytes: number;
  pageCount: number;
  freelistPages: number;
  allocatedPageBytes: number;
  usedPageBytes: number;
  driveAvailableBytes?: number;
  driveTotalBytes?: number;
  driveAvailablePercent?: number;
}

export interface OperationalIndexQueueTelemetry {
  pending: number;
  leased: number;
  retry: number;
  failed: number;
  /**
   * True only when managed discovery has reached its fixed maximum wallet
   * target and has no active or unresolved index work. The historical program
   * head remains visible below, but active-wallet streams are the trading
   * authority for the frozen PAPER cohort in this state.
   */
  managedSnapshotCapped: boolean;
  /** Programs with a durable bootstrap or maintenance-head checkpoint. */
  headProgramsRequired: number;
  /** Programs with a fresh, cursor-free, continuous committed head range. */
  headProgramsReady: number;
  /** Head-source signatures that have not completed strict hydration. */
  headUnprocessed: number;
  /** True only when every required program is continuous and fully hydrated. */
  headCatchupComplete: boolean;
  oldestBacklogAt?: IsoDateTime;
  oldestBacklogAgeSeconds?: number;
  newestIndexedBlockAt?: IsoDateTime;
  newestIndexedBlockLagSeconds?: number;
}

export interface OperationalMonitoringRepairTelemetry {
  total: number;
  pending: number;
  ready: number;
  failed: number;
  retryDue: number;
  oldestUnreadyAt?: IsoDateTime;
  oldestUnreadyAgeSeconds?: number;
  latestSucceededAt?: IsoDateTime;
}

/**
 * Entry-safety evidence for the immutable wallets in the active forward-paper
 * cohort. The program-wide index remains useful discovery telemetry, but it is
 * not the source of live leader signals once this scope exists.
 */
export interface OperationalTradingHeadTelemetry {
  evaluationCohortId: string;
  requiredWallets: number;
  repairReadyWallets: number;
  unprocessedSourceEvents: number;
  streamActive: boolean;
  streamConnected: boolean;
  streamReady: boolean;
  streamFresh: boolean;
  healthy: boolean;
  lastMessageAt?: IsoDateTime;
  lastMessageLagSeconds?: number;
}

export interface OperationalAuditTelemetry {
  windowHours: 24;
  warnings: number;
  critical: number;
  latestWarningOrCriticalAt?: IsoDateTime;
}

/**
 * Read-only operational evidence sourced from the local Windows-app SQLite
 * ledger and its containing volume. Remote RPC ledger/accounts/snapshot disks
 * are a separate operator concern. Optional sections are absent only when
 * collection failed; callers must then treat `UNAVAILABLE` as unhealthy rather
 * than assuming zero.
 */
export interface OperationalTelemetrySnapshot {
  status: OperationalTelemetryStatus;
  capturedAt: IsoDateTime;
  issues: OperationalTelemetryIssue[];
  /** Machine-readable gate evidence; CRITICAL/UNAVAILABLE always blocks entries. */
  blocksNewEntries: boolean;
  blockingIssueCodes: OperationalTelemetryIssueCode[];
  storage?: OperationalStorageTelemetry;
  indexQueue?: OperationalIndexQueueTelemetry;
  monitoringRepair?: OperationalMonitoringRepairTelemetry;
  tradingHead?: OperationalTradingHeadTelemetry;
  audit?: OperationalAuditTelemetry;
}

export type OperationalPauseReason =
  | "DAILY_LOSS"
  | "LIVE_START_LOSS"
  | "PEAK_DRAWDOWN"
  | "HELIUS_OUTAGE"
  | "HISTORY_GAP_REPAIR"
  | "STALE_QUOTE"
  | "BALANCE_MISMATCH"
  | "REPEATED_EXECUTION_FAILURES"
  | "LOCAL_DATA_UNHEALTHY"
  | "LEGACY_SAFETY_PAUSE";

export type OperationalPauseRecovery =
  | "NONE"
  | "WHEN_CONDITIONS_CLEAR"
  | "NEXT_UTC_DAY"
  | "MANUAL_REVIEW";

/**
 * Durable new-entry safety state. This is deliberately separate from the
 * operator-selected PAUSED mode: exits and monitoring continue while buys are
 * blocked, and the dashboard can explain exactly why.
 */
export interface OperationalPauseState {
  active: boolean;
  reasons: OperationalPauseReason[];
  recovery: OperationalPauseRecovery;
  lastEvaluatedAt: IsoDateTime;
  pausedAt?: IsoDateTime;
  recoveredAt?: IsoDateTime;
}

export interface DiscoveredWalletSet {
  cohortId: string;
  generatedAt: IsoDateTime;
  candidates: WalletCandidate[];
}

export interface WalletHistorySummary {
  wallet: PublicKeyString;
  historyDays: number;
  closedEligibleSwaps: number;
  activeWeeks: number;
  medianHoldingMinutes: number;
  topTokenProfitShare: number;
  topThreeProfitShare: number;
  tags: string[];
}

/** Durable queue state for the local, provider-independent wallet index. */
export type WalletIndexQueueStatus =
  | "PENDING"
  | "LEASED"
  | "PROCESSED"
  | "RETRY"
  | "FAILED";

export type WalletIndexRunStage =
  | "DISCOVERY"
  | "HYDRATION"
  | "PRESCREEN"
  | "HISTORY"
  | "COMPLETE"
  | "PAUSED"
  | "FAILED";

export interface WalletIndexTransactionSource {
  signature: TransactionSignature;
  /** Address that yielded the signature (for example, a DEX program or wallet). */
  sourceAddress: PublicKeyString;
  source: string;
  discoveredAt: IsoDateTime;
  /** Participating wallet, once attribution is known. */
  wallet?: PublicKeyString;
  runId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * A globally deduplicated transaction in the local indexing queue. Hydrated
 * fields are optional until the queue item has been processed.
 */
export interface WalletIndexTransaction {
  signature: TransactionSignature;
  status: WalletIndexQueueStatus;
  attempts: number;
  priority: number;
  discoveredAt: IsoDateTime;
  availableAt: IsoDateTime;
  updatedAt: IsoDateTime;
  sourceWallets: PublicKeyString[];
  slot?: number;
  blockTime?: IsoDateTime;
  success?: boolean;
  feePayer?: PublicKeyString;
  accountKeys?: PublicKeyString[];
  programIds?: PublicKeyString[];
  transactionVersion?: string;
  raw?: unknown;
  leaseOwner?: string;
  leaseToken?: string;
  leasedAt?: IsoDateTime;
  leaseExpiresAt?: IsoDateTime;
  lastError?: string;
  indexedAt?: IsoDateTime;
  processedAt?: IsoDateTime;
}

/** A normalized successful spot swap attributed to one participating wallet. */
export interface IndexedSpotSwap {
  id: string;
  signature: TransactionSignature;
  wallet: PublicKeyString;
  swapIndex: number;
  slot: number;
  blockTime: IsoDateTime;
  side: TradeSide;
  baseMint: typeof SOL_MINT | typeof USDC_MINT;
  targetMint: PublicKeyString;
  inputMint: PublicKeyString;
  outputMint: PublicKeyString;
  inputAmountAtomic: AtomicAmount;
  outputAmountAtomic: AtomicAmount;
  inputAmountUi: number;
  outputAmountUi: number;
  eligible: boolean;
  eligibilityReasons: string[];
  programIds: PublicKeyString[];
  indexedAt: IsoDateTime;
  priceUsd?: number;
  feeUsd?: number;
  realizedPnlUsd?: number;
  holdingMinutes?: number;
  closesPosition?: boolean;
}

/** Materialized wallet aggregate used by the inexpensive pre-screen. */
export type WalletDeepHistoryStatus =
  | "AWAITING"
  | "PAGING"
  | "AWAITING_HYDRATION"
  | "COMPLETE"
  | "FAILED";

export type WalletProfitPricingCoverage =
  | "NO_CLOSED_EXITS"
  | "UNPRICED"
  | "PARTIAL"
  | "COMPLETE";

export interface WalletIndexRecord {
  wallet: PublicKeyString;
  firstSeenAt: IsoDateTime;
  lastSeenAt: IsoDateTime;
  historyDays: number;
  transactionCount: number;
  successfulTransactionCount: number;
  spotSwapCount: number;
  eligibleSpotSwapCount: number;
  closedEligibleSwaps: number;
  buyCount: number;
  sellCount: number;
  activeDays: number;
  activeWeeks: number;
  distinctMints: number;
  medianHoldingMinutes: number;
  preScreenEligible: boolean;
  preScreenReasons: string[];
  updatedAt: IsoDateTime;
  realizedPnl30dUsd?: number;
  realizedPnl90dUsd?: number;
  topTokenProfitShare?: number;
  topThreeProfitShare?: number;
  tags?: string[];
  /** Missing/UNKNOWN is never equivalent to a verified empty tag list. */
  walletIdentityStatus?: "UNKNOWN" | "VERIFIED" | "REJECTED";
  walletIdentitySource?: string;
  walletIdentityCheckedAt?: IsoDateTime;
  /** Coarse activity survivors remain ineligible for research until this is COMPLETE. */
  deepHistoryStatus?: WalletDeepHistoryStatus;
  deepHistoryWindowStart?: IsoDateTime;
  deepHistoryWindowEnd?: IsoDateTime;
  deepHistorySignatureCount?: number;
  deepHistoryHydratedCount?: number;
  structuralEligible?: boolean;
  structuralReasons?: string[];
  pricedClosedEligibleSwaps?: number;
  unpricedClosedEligibleSwaps?: number;
  realizedPnlPricedUsd?: number;
  pricedProfitTokenCount?: number;
  profitPricingCoverage?: WalletProfitPricingCoverage;
  /** Research provenance only. COARSE_SIGNER never asserts a decoded swap. */
  discoveryTier?: "COARSE_SIGNER" | "EXACT_SWAP";
  discoveryProvenance?: {
    sourceSignature: TransactionSignature;
    sourceProgram: PublicKeyString;
    source: "DIRECT_JUPITER_SINGLE_SIGNER" | "STRICT_NORMALIZED_SWAP";
    observedAt: IsoDateTime;
  };
  /** Ranking hint from local program observations, not a swap or PnL claim. */
  discoveryObservedSuccessfulTransactions?: number;
}

export interface WalletActivitySample {
  wallet: PublicKeyString;
  periodStart: IsoDateTime;
  periodEnd: IsoDateTime;
  transactionCount: number;
  successfulTransactionCount: number;
  spotSwapCount: number;
  eligibleSpotSwapCount: number;
  buyCount: number;
  sellCount: number;
  distinctMints: number;
  sampledAt: IsoDateTime;
}

export interface WalletPreScreenSnapshot {
  wallet: PublicKeyString;
  runId: string;
  calculatedAt: IsoDateTime;
  eligible: boolean;
  reasons: string[];
  record: WalletIndexRecord;
}

/** Resumable cursor for one ingestion pipeline partition. */
export interface WalletIndexCheckpoint {
  pipeline: string;
  partition: string;
  completed: boolean;
  updatedAt: IsoDateTime;
  cursor?: string;
  beforeSignature?: TransactionSignature;
  lastSignature?: TransactionSignature;
  slot?: number;
  blockTime?: IsoDateTime;
  metadata?: Record<string, unknown>;
}

export interface WalletIndexRun {
  id: string;
  stage: WalletIndexRunStage;
  startedAt: IsoDateTime;
  updatedAt: IsoDateTime;
  discoveredWallets: number;
  enqueuedSignatures: number;
  hydratedTransactions: number;
  indexedSwaps: number;
  preScreenedWallets: number;
  /** Local structural survivors only; provider qualification is recorded in WalletScore. */
  structuralCandidates: number;
  finishedAt?: IsoDateTime;
  error?: string;
  configuration?: Record<string, unknown>;
}

export interface WalletIndexCoverage {
  capturedAt: IsoDateTime;
  uniqueSignatures: number;
  sourceLinks: number;
  indexedTransactions: number;
  indexedSwaps: number;
  indexedWallets: number;
  preScreenEligibleWallets: number;
  activitySamples: number;
  preScreenSnapshots: number;
  checkpoints: number;
  activeRuns: number;
  queueByStatus: Record<WalletIndexQueueStatus, number>;
  oldestBlockTime?: IsoDateTime;
  newestBlockTime?: IsoDateTime;
}

export const DEFAULT_WALLET_INDEX_TARGET = 5_000;
export const DEFAULT_WALLET_INDEX_MONTHLY_CREDIT_BUDGET = 250_000;
export const DEFAULT_TOTAL_HELIUS_MONTHLY_CREDIT_BUDGET = 750_000;
/** Frozen leaders used for the current forward PAPER experiment. */
export const PAPER_EVALUATION_WALLET_COUNT = 3;

export type WalletAcquisitionStatus =
  | "DRAINING"
  | "ACQUIRING"
  | "WAITING_FOR_FREEZE"
  | "WAITING_FOR_BUDGET"
  | "SATISFIED"
  | "MAXIMUM_REACHED"
  | "SOURCE_EXHAUSTED";

export type WalletAcquisitionBudgetBlocker = "BIRDEYE" | "HELIUS_INDEX" | "HELIUS_TOTAL";

export interface WalletAcquisitionBudgetSnapshot {
  monthStart: string;
  nextResetAt: IsoDateTime;
  birdeyeRemainingCu: number;
  heliusIndexRemainingCredits: number;
  totalHeliusRemainingCredits: number;
  birdeyeScoringReserveCu: number;
  heliusDiscoveryPageReserveCredits: number;
  heliusScoringReserveCredits: number;
}

/** Durable managed-wallet acquisition state plus a live monthly budget view. */
export interface WalletAcquisitionGoal {
  version: 1;
  targetWallets: 5_000 | 10_000 | 15_000 | 20_000 | 25_000;
  maximumWallets: 25_000;
  qualifiedWallets: number;
  status: WalletAcquisitionStatus;
  updatedAt: IsoDateTime;
  budgetBlockers: WalletAcquisitionBudgetBlocker[];
  budget: WalletAcquisitionBudgetSnapshot;
}
/** Keeps the frequently refreshed dashboard payload bounded as cohorts grow. */
export const DASHBOARD_COHORT_WALLET_LIMIT = 50;

export type WalletResearchFilter =
  | "ALL"
  | "PRESCREEN_READY"
  | "PRESCREEN_REJECTED"
  | "AWAITING_PRESCREEN";

export type WalletResearchSort = "CLOSED_SWAPS" | "HISTORY" | "ACTIVITY" | "RECENT";

export type WalletResearchFunnelScope = "LOCAL_INDEX" | "PROVIDER_COHORT";

export interface WalletResearchFunnelStage {
  key:
    | "INDEXED"
    | "ACTIVITY_SCREENED"
    | "ACTIVITY_PROVEN"
    | "CLOSED_SWAPS"
    | "HOLDING_TIME"
    | "DEPTH_SCORED"
    | "POSITIVE_REALIZED_PNL"
    | "RESEARCH_QUALIFIED"
    | "FROZEN_ACTIVE";
  scope: WalletResearchFunnelScope;
  label: string;
  count: number;
  /** Human-readable metric contract shown in the dashboard. */
  definition: string;
  /** Durable SQLite tables that back the count. */
  sources: string[];
}

export interface WalletResearchFunnel {
  capturedAt: IsoDateTime;
  localIndex: WalletResearchFunnelStage[];
  providerCohort: WalletResearchFunnelStage[];
}

export interface WalletResearchPage {
  items: WalletIndexRecord[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  filter: WalletResearchFilter;
  sort: WalletResearchSort;
  capturedAt: IsoDateTime;
}

export interface WalletIndexDashboardSnapshot {
  coverage: WalletIndexCoverage;
  targetWallets: number;
  acquisition?: WalletAcquisitionGoal;
  indexCreditsUsed: number;
  indexCreditBudget: number;
  totalHeliusCreditsUsed: number;
  totalHeliusCreditBudget: number;
  managedRecoveryPreflight?: {
    policyVersion: string;
    windowStart: IsoDateTime;
    expiresAt: IsoDateTime;
    total: number;
    ready: number;
    running: number;
    retry: number;
    pass: number;
    rejected: number;
  };
  researchFunnel: WalletResearchFunnel;
  latestRun?: WalletIndexRun;
}

export interface Unsubscribe {
  (): Promise<void> | void;
}

export interface WalletDiscoveryProvider {
  discoverCohort(now?: Date): Promise<DiscoveredWalletSet>;
  getPnl(address: PublicKeyString, duration: "30d" | "90d"): Promise<WalletPnlWindow>;
}

export interface ChainObserver {
  summarizeHistory(address: PublicKeyString, days: number): Promise<WalletHistorySummary>;
  subscribe(
    addresses: PublicKeyString[],
    onSwap: (swap: LeaderSwap) => Promise<void>
  ): Promise<Unsubscribe>;
  repairGap(address: PublicKeyString, since: IsoDateTime): Promise<LeaderSwap[]>;
}

export interface TokenRiskProvider {
  checkToken(mint: PublicKeyString, now?: Date): Promise<TokenEligibility>;
}

export interface QuoteRequest {
  inputMint: PublicKeyString;
  outputMint: PublicKeyString;
  inputAmountAtomic: AtomicAmount;
  taker?: PublicKeyString;
}

export interface QuoteExecutor {
  quote(request: QuoteRequest): Promise<QuoteSnapshot>;
  execute(signedTransactionBase64: string, requestId: string): Promise<{
    success: boolean;
    signature?: TransactionSignature;
    inputAmountAtomic?: AtomicAmount;
    outputAmountAtomic?: AtomicAmount;
    error?: string;
  }>;
}

export interface SignerValidation {
  wallet: PublicKeyString;
  inputMint: PublicKeyString;
  outputMint: PublicKeyString;
  maximumInputAtomic: AtomicAmount;
  quotedOutputAtomic: AtomicAmount;
  minimumOutputAtomic: AtomicAmount;
  expectedSlippageBps: number;
  signatureFeeLamports: number;
  prioritizationFeeLamports: number;
  rentFeeLamports: number;
  expectedRouter: string;
  maximumFeeLamports: number;
  allowedPrograms: string[];
  /** V1 never requests an integrator/platform fee from Jupiter. */
  expectedPlatformFeeBps: number;
  /** Empty in v1; any fee recipient in a signed route therefore fails closed. */
  allowedFeeAccounts: PublicKeyString[];
  /** Bounded on-chain DEX programs the decoded direct route may invoke. */
  allowedRoutePrograms: PublicKeyString[];
  /** Authorizes the independent exit-only RPC; never set for a new entry. */
  exitOnlyRpcAuthorized: boolean;
}

export interface Signer {
  getAddress(): Promise<PublicKeyString>;
  signValidatedTransaction(
    transactionBase64: string,
    validation: SignerValidation
  ): Promise<string>;
}

export interface BrokerOrder {
  intent: CopyIntent;
  entryQuote: QuoteSnapshot;
  exitQuote?: QuoteSnapshot;
  decision: RiskDecision;
}

export interface Broker {
  readonly mode: ExecutionMode;
  place(order: BrokerOrder): Promise<ExecutionRecord>;
}

export * from "./marketplace.js";
