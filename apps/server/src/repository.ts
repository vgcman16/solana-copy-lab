import {
  AUTONOMOUS_PAPER_LABEL,
  AUTONOMOUS_PAPER_REPLAY_LABEL,
  AUTONOMOUS_PAPER_REPLAY_VARIANT_COUNT,
  AUTONOMOUS_PAPER_REPLAY_VERSION,
  DEFAULT_RISK_POLICY,
  DEFAULT_RESEARCH_PAPER_ACTIVITY_WINDOW_DAYS,
  DEFAULT_RESEARCH_PAPER_LOCAL_ACTIVITY_LOOKBACK_DAYS,
  DEFAULT_RESEARCH_PAPER_MINIMUM_COMPLETED_TRADES,
  DEFAULT_RESEARCH_PAPER_PROVIDER_SNAPSHOT_MAX_AGE_DAYS,
  DEFAULT_RESEARCH_PAPER_WATCHLIST_TARGET,
  DEFAULT_WALLET_POLICY,
  MAXIMUM_RESEARCH_PAPER_WATCHLIST_TARGET,
  PAPER_EVALUATION_WALLET_COUNT,
  RESEARCH_PAPER_LABEL,
  SOL_MINT
} from "@copylab/shared";
import type {
  DiscoveredWalletSet,
  ExecutionRecord,
  PortfolioSnapshot,
  PositionLot,
  ProviderHealth,
  TokenEligibility,
  WalletCandidate,
  WalletScore,
  CopyIntent,
  AutonomousPaperAccount,
  AutonomousPaperDashboard,
  AutonomousPaperDecision,
  AutonomousPaperEvent,
  AutonomousPaperEventKind,
  AutonomousPaperLane,
  AutonomousPaperPolicy,
  AutonomousPaperPosition,
  AutonomousPaperReplayDashboard,
  AutonomousPaperReplayEpisode,
  AutonomousPaperReplayEpisodeStatus,
  AutonomousPaperReplayInsight,
  AutonomousPaperReplayObservation,
  AutonomousPaperReplayReport,
  AutonomousPaperReplayVariantParameters,
  AutonomousPaperReplayVariantResult,
  AutonomousPaperTrade,
  AutonomousPaperUpgradeDrain,
  RiskDecision,
  SignalAuditRecord,
  SignalOutcomeAction,
  SignalOutcomeReasonCode,
  SignalOutcomeStatus,
  ExecutionMode,
  QuoteSnapshot,
  LeaderSwap,
  RejectedSourceAction,
  ResearchPaperDashboard,
  ResearchPaperEvent,
  ResearchPaperEventKind,
  ResearchPaperLane,
  ResearchPaperLeaderAccount,
  ResearchPaperMonitoringCheckpoint,
  ResearchPaperPosition,
  ResearchPaperWatchlistMember,
  ResearchPaperWatchlistPolicy,
  ResearchPaperWatchlistRun,
  IndexedSpotSwap,
  WalletActivitySample,
  WalletIndexCheckpoint,
  WalletIndexCoverage,
  WalletIndexQueueStatus,
  WalletIndexRecord,
  WalletIndexRun,
  WalletIndexTransaction,
  WalletIndexTransactionSource,
  WalletPreScreenSnapshot,
  WalletPnlWindow,
  WalletHistorySummary,
  WalletResearchFilter,
  WalletResearchSort
} from "@copylab/shared";
import { redactSensitiveText } from "@copylab/providers";
import { autonomousPaperReplayCadenceGap } from "./autonomous-paper-replay-lab.js";
import type { CopyLabDatabase } from "./database.js";
import type { ClosedTradeResult } from "@copylab/core";
import { createHash, randomUUID } from "node:crypto";
import type { WalletHistoryReconciliationSnapshot } from "./wallet-history-reconciliation.js";
import type { ProviderParityObservation } from "./provider-parity.js";
import {
  prepareProviderParityProofEpoch as buildProviderParityProofEpoch,
  verifyBoundProviderParityObservation,
  type PrepareProviderParityProofEpochInput,
  type ProviderParityBaselineRun,
  type ProviderParityProofBinding,
  type ProviderParityProofEpoch
} from "./provider-parity-proof.js";
import {
  SELF_HOSTED_PAPER_SOAK_MAXIMUM_GAP_MS,
  type SelfHostedPaperSoakEpoch,
  type SelfHostedPaperSoakHeartbeat,
  type SelfHostedPaperSoakHeartbeatInput
} from "./self-hosted-paper-soak.js";
import {
  SOL_PRICE_BOOTSTRAP_SOURCES,
  SOL_PRICE_BOOTSTRAP_SETTING,
  SOL_PRICE_BOOTSTRAP_SOURCE,
  type SolPriceBootstrapCheckpoint
} from "./sol-price-bootstrap-state.js";
import type {
  JupiterFirstPoolEvidence,
  WalletIdentityCoordinatedBuyEvidence,
  WalletIdentitySwapEvidence,
  WalletIdentityTransactionEvidenceRecord
} from "./local-wallet-identity.js";
import type {
  ManagedRecoveryPreflightClaim,
  ManagedRecoveryPreflightRepository,
  ManagedRecoveryPreflightStep,
  ManagedRecoveryPreflightWindow
} from "./managed-recovery-preflight.js";
import { normalizeAutonomousPaperPolicy } from "./autonomous-paper-policy.js";
import {
  summarizeResearchPaperPerformance,
  type ResearchPaperExitLedgerEvidence
} from "./research-paper-performance.js";

export type {
  ManagedRecoveryPreflightClaim,
  ManagedRecoveryPreflightStep
} from "./managed-recovery-preflight.js";

const nowIso = (): string => new Date().toISOString();
const encode = (value: unknown): string => JSON.stringify(value);
const decode = <T>(value: string): T => JSON.parse(value) as T;
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const WALLET_PRESCREEN_SURVIVOR_CACHE_MAX_ENTRIES = 32;
export const AUTONOMOUS_PAPER_CANDIDATE_DETAIL_RETENTION = 25_000;
export const AUTONOMOUS_PAPER_CANDIDATE_COMPACTION_BATCH_SIZE = 1_000;
export const AUTONOMOUS_PAPER_UPGRADE_DRAIN_SETTING = "autonomous-paper:upgrade-drain";

function normalizeAutonomousPaperUpgradeDrain(
  value: unknown
): AutonomousPaperUpgradeDrain | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate);
  if (
    keys.length !== 4 ||
    !["laneId", "fromPolicyVersion", "toPolicyVersion", "requestedAt"]
      .every((key) => Object.hasOwn(candidate, key)) ||
    typeof candidate.laneId !== "string" ||
    typeof candidate.fromPolicyVersion !== "string" ||
    typeof candidate.toPolicyVersion !== "string" ||
    typeof candidate.requestedAt !== "string"
  ) return undefined;
  const laneId = candidate.laneId.trim();
  const fromPolicyVersion = candidate.fromPolicyVersion.trim();
  const toPolicyVersion = candidate.toPolicyVersion.trim();
  if (
    !laneId ||
    !fromPolicyVersion ||
    !toPolicyVersion ||
    fromPolicyVersion === toPolicyVersion ||
    laneId !== candidate.laneId ||
    fromPolicyVersion !== candidate.fromPolicyVersion ||
    toPolicyVersion !== candidate.toPolicyVersion ||
    !Number.isFinite(Date.parse(candidate.requestedAt))
  ) return undefined;
  return {
    laneId,
    fromPolicyVersion,
    toPolicyVersion,
    requestedAt: candidate.requestedAt
  };
}
const AUTONOMOUS_PAPER_POLICY_KEYS: readonly (keyof AutonomousPaperPolicy)[] = [
  "scanIntervalMinutes",
  "confirmationSamples",
  "allowToken2022",
  "adaptiveSizingEnabled",
  "maximumEntriesPerUtcDay",
  "minimumEntrySpacingMinutes",
  "minimumPositionUsd",
  "positionNavFraction",
  "maximumPositionUsd",
  "maximumOpenPositions",
  "maximumDeployedFraction",
  "minimumLiquidReserveUsd",
  "minimumAgeDays",
  "minimumLiquidityUsd",
  "minimumVolume24hUsd",
  "minimumHolderCount",
  "minimumOrganicScore",
  "maximumTopHoldersPercent",
  "minimumMarketCapUsd",
  "maximumMarketCapUsd",
  "maximumFdvToMarketCap",
  "minimumMomentumScore",
  "minimumPriceChange5mPercent",
  "maximumPriceChange5mPercent",
  "minimumPriceChange1hPercent",
  "maximumPriceChange1hPercent",
  "minimumPriceChange6hPercent",
  "maximumPriceChange6hPercent",
  "maximumPriceChange24hPercent",
  "minimumOrganicBuyShare5m",
  "minimumOrganicBuyShare1h",
  "minimumOrganicVolume5mUsd",
  "minimumOrganicVolume1hUsd",
  "minimumOrganicBuyers5m",
  "minimumVolumeAccelerationRatio",
  "minimumLiquidityChange1hPercent",
  "minimumSolPriceChange1hPercent",
  "minimumSolPriceChange6hPercent",
  "minimumSolRelativeStrength1hPercent",
  "maximumPriceImpactPercent",
  "maximumRoundTripCostPercent",
  "stopLossPercent",
  "breakEvenActivationPercent",
  "trailingActivationPercent",
  "trailingDrawdownPercent",
  "takeProfitPercent",
  "weakMomentumExitSamples",
  "noProgressMinutes",
  "maximumHoldingMinutes",
  "cooldownMinutes",
  "stopCooldownMinutes",
  "dailyLossPausePercent",
  "maximumDrawdownPercent",
  "adaptiveSizingMinimumTrades",
  "adaptiveSizingWindowTrades",
  "adaptiveSizingPriorWins",
  "adaptiveSizingPriorLosses",
  "adaptiveSizingFractionalKelly",
  "adaptiveSizingMinimumCalibrationMultiplier",
  "adaptiveSizingMaximumCalibrationMultiplier",
  "adaptiveSizingMaximumLossStreak",
  "adaptiveSizingLossStreakMultiplier",
  "contextualRewardEnabled",
  "contextualRewardMinimumComparableTrades",
  "contextualRewardMaximumDistance",
  "contextualRewardPriorWeight",
  "contextualRewardGain",
  "contextualRewardMinimumEffectiveSamples",
  "contextualRewardMinimumDistinctMints",
  "contextualRewardMinimumDistinctUtcDays",
  "contextualRewardMaximumSamplesPerMint",
  "contextualRewardMinimumMultiplier",
  "contextualRewardMaximumMultiplier",
  "riskAtStopSizingEnabled",
  "normalRiskAtStopNavFraction",
  "highConvictionRiskAtStopNavFraction",
  "explorationRiskAtStopNavFraction",
  "maximumDeveloperClusterFraction"
];

function validateAutonomousPaperPolicy(policy: AutonomousPaperPolicy): void {
  const keys = Object.keys(policy);
  const booleanKeys: readonly (keyof AutonomousPaperPolicy)[] = [
    "allowToken2022",
    "adaptiveSizingEnabled",
    "contextualRewardEnabled",
    "riskAtStopSizingEnabled"
  ];
  const numericKeys = AUTONOMOUS_PAPER_POLICY_KEYS.filter((key) => !booleanKeys.includes(key));
  if (
    keys.length !== AUTONOMOUS_PAPER_POLICY_KEYS.length ||
    !AUTONOMOUS_PAPER_POLICY_KEYS.every((key) => Object.hasOwn(policy, key)) ||
    !booleanKeys.every((key) => typeof policy[key] === "boolean") ||
    !numericKeys.every((key) =>
      typeof policy[key] === "number" && Number.isFinite(policy[key] as number)
    )
  ) {
    throw new Error("Autonomous paper policy must contain every finite control and every boolean feature gate.");
  }
  const positive: Array<readonly [number, string]> = [
    [policy.scanIntervalMinutes, "scan interval"],
    [policy.confirmationSamples, "confirmation samples"],
    [policy.maximumEntriesPerUtcDay, "maximum daily entries"],
    [policy.minimumPositionUsd, "minimum position"],
    [policy.positionNavFraction, "position fraction"],
    [policy.maximumPositionUsd, "maximum position"],
    [policy.maximumOpenPositions, "maximum open positions"],
    [policy.maximumDeployedFraction, "maximum deployed fraction"],
    [policy.maximumFdvToMarketCap, "FDV ratio"],
    [policy.stopLossPercent, "stop loss"],
    [policy.breakEvenActivationPercent, "break-even activation"],
    [policy.trailingActivationPercent, "trailing activation"],
    [policy.trailingDrawdownPercent, "trailing drawdown"],
    [policy.takeProfitPercent, "take profit"],
    [policy.weakMomentumExitSamples, "weak-momentum samples"],
    [policy.noProgressMinutes, "no-progress timeout"],
    [policy.maximumHoldingMinutes, "maximum hold"],
    [policy.cooldownMinutes, "cooldown"],
    [policy.stopCooldownMinutes, "stop cooldown"],
    [policy.dailyLossPausePercent, "daily loss pause"],
    [policy.maximumDrawdownPercent, "maximum drawdown"],
    [policy.adaptiveSizingMinimumTrades, "adaptive-sizing minimum trades"],
    [policy.adaptiveSizingWindowTrades, "adaptive-sizing trade window"],
    [policy.adaptiveSizingPriorWins, "adaptive-sizing prior wins"],
    [policy.adaptiveSizingPriorLosses, "adaptive-sizing prior losses"],
    [policy.adaptiveSizingFractionalKelly, "adaptive-sizing Kelly fraction"],
    [policy.adaptiveSizingMinimumCalibrationMultiplier, "adaptive-sizing minimum multiplier"],
    [policy.adaptiveSizingMaximumCalibrationMultiplier, "adaptive-sizing maximum multiplier"],
    [policy.adaptiveSizingLossStreakMultiplier, "adaptive-sizing loss-streak multiplier"],
    [policy.contextualRewardMinimumComparableTrades, "contextual-reward minimum trades"],
    [policy.contextualRewardMaximumDistance, "contextual-reward distance"],
    [policy.contextualRewardPriorWeight, "contextual-reward prior"],
    [policy.contextualRewardGain, "contextual-reward gain"],
    [policy.contextualRewardMinimumEffectiveSamples, "contextual-reward effective samples"],
    [policy.contextualRewardMinimumDistinctMints, "contextual-reward mint breadth"],
    [policy.contextualRewardMinimumDistinctUtcDays, "contextual-reward day breadth"],
    [policy.contextualRewardMaximumSamplesPerMint, "contextual-reward per-mint limit"],
    [policy.contextualRewardMinimumMultiplier, "contextual-reward minimum multiplier"],
    [policy.contextualRewardMaximumMultiplier, "contextual-reward maximum multiplier"],
    [policy.normalRiskAtStopNavFraction, "normal risk-at-stop fraction"],
    [policy.highConvictionRiskAtStopNavFraction, "high-conviction risk-at-stop fraction"],
    [policy.explorationRiskAtStopNavFraction, "exploration risk-at-stop fraction"],
    [policy.maximumDeveloperClusterFraction, "developer-cluster fraction"]
  ];
  if (positive.some(([value]) => value <= 0)) {
    throw new RangeError("Autonomous paper positive policy limits must be greater than zero.");
  }
  const nonNegative = [
    policy.minimumEntrySpacingMinutes,
    policy.minimumLiquidReserveUsd,
    policy.minimumAgeDays,
    policy.minimumLiquidityUsd,
    policy.minimumVolume24hUsd,
    policy.minimumHolderCount,
    policy.minimumMarketCapUsd,
    policy.maximumMarketCapUsd,
    policy.minimumOrganicVolume5mUsd,
    policy.minimumOrganicVolume1hUsd,
    policy.minimumOrganicBuyers5m,
    policy.minimumVolumeAccelerationRatio,
    policy.maximumPriceImpactPercent,
    policy.maximumRoundTripCostPercent
  ];
  if (nonNegative.some((value) => value < 0)) {
    throw new RangeError("Autonomous paper minimums and cost ceilings cannot be negative.");
  }
  if (
    !Number.isSafeInteger(policy.maximumOpenPositions) ||
    !Number.isSafeInteger(policy.maximumEntriesPerUtcDay) ||
    !Number.isSafeInteger(policy.minimumEntrySpacingMinutes) ||
    !Number.isSafeInteger(policy.confirmationSamples) ||
    !Number.isSafeInteger(policy.weakMomentumExitSamples) ||
    !Number.isSafeInteger(policy.minimumHolderCount) ||
    !Number.isSafeInteger(policy.minimumOrganicBuyers5m)
    || !Number.isSafeInteger(policy.adaptiveSizingMinimumTrades)
    || !Number.isSafeInteger(policy.adaptiveSizingWindowTrades)
    || !Number.isSafeInteger(policy.adaptiveSizingPriorWins)
    || !Number.isSafeInteger(policy.adaptiveSizingPriorLosses)
    || !Number.isSafeInteger(policy.adaptiveSizingMaximumLossStreak)
    || !Number.isSafeInteger(policy.contextualRewardMinimumComparableTrades)
    || !Number.isSafeInteger(policy.contextualRewardMinimumDistinctMints)
    || !Number.isSafeInteger(policy.contextualRewardMinimumDistinctUtcDays)
    || !Number.isSafeInteger(policy.contextualRewardMaximumSamplesPerMint)
  ) throw new RangeError("Autonomous paper count limits must be safe integers.");
  if (
    policy.confirmationSamples > 2 ||
    policy.positionNavFraction > 1 ||
    policy.maximumDeployedFraction > 1 ||
    policy.positionNavFraction > policy.maximumDeployedFraction ||
    policy.minimumOrganicScore < 0 || policy.minimumOrganicScore > 100 ||
    policy.maximumTopHoldersPercent < 0 || policy.maximumTopHoldersPercent > 100 ||
    policy.minimumMomentumScore < 0 || policy.minimumMomentumScore > 100 ||
    policy.minimumOrganicBuyShare5m < 0 || policy.minimumOrganicBuyShare5m > 1 ||
    policy.minimumOrganicBuyShare1h < 0 || policy.minimumOrganicBuyShare1h > 1 ||
    policy.maximumPriceImpactPercent > 100 ||
    policy.maximumRoundTripCostPercent > 100 ||
    policy.stopLossPercent > 100 ||
    policy.trailingDrawdownPercent > 100 ||
    policy.dailyLossPausePercent > 100 ||
    policy.maximumDrawdownPercent > 100
    || policy.normalRiskAtStopNavFraction > 1
    || policy.highConvictionRiskAtStopNavFraction > 1
    || policy.explorationRiskAtStopNavFraction > 1
    || policy.maximumDeveloperClusterFraction > 1
  ) throw new RangeError("Autonomous paper fractions and percentages are outside safe bounds.");
  if (
    policy.minimumPositionUsd < 5 ||
    policy.minimumPositionUsd > 50 ||
    policy.minimumPositionUsd > policy.maximumPositionUsd ||
    policy.adaptiveSizingMinimumTrades > policy.adaptiveSizingWindowTrades ||
    policy.adaptiveSizingPriorWins <= 0 ||
    policy.adaptiveSizingPriorLosses <= 0 ||
    policy.adaptiveSizingFractionalKelly < 0 ||
    policy.adaptiveSizingFractionalKelly > 1 ||
    policy.adaptiveSizingMinimumCalibrationMultiplier <= 0 ||
    policy.adaptiveSizingMaximumCalibrationMultiplier <
      policy.adaptiveSizingMinimumCalibrationMultiplier ||
    policy.adaptiveSizingMaximumLossStreak < 0 ||
    policy.adaptiveSizingLossStreakMultiplier <= 0 ||
    policy.adaptiveSizingLossStreakMultiplier > 1 ||
    policy.contextualRewardMaximumDistance > 1 ||
    policy.contextualRewardGain > 1 ||
    policy.contextualRewardMinimumEffectiveSamples >
      policy.contextualRewardMinimumComparableTrades ||
    policy.contextualRewardMinimumDistinctMints >
      policy.contextualRewardMinimumComparableTrades ||
    policy.contextualRewardMinimumDistinctUtcDays >
      policy.contextualRewardMinimumComparableTrades ||
    policy.contextualRewardMinimumDistinctMints *
      policy.contextualRewardMaximumSamplesPerMint <
      policy.contextualRewardMinimumComparableTrades ||
    policy.contextualRewardMinimumMultiplier > 1 ||
    policy.contextualRewardMaximumMultiplier < 1 ||
    policy.contextualRewardMaximumMultiplier < policy.contextualRewardMinimumMultiplier
    || policy.explorationRiskAtStopNavFraction > policy.normalRiskAtStopNavFraction
    || policy.normalRiskAtStopNavFraction > policy.highConvictionRiskAtStopNavFraction
  ) throw new RangeError("Autonomous paper adaptive-sizing controls are outside safe bounds.");
  if (
    policy.minimumMarketCapUsd > policy.maximumMarketCapUsd ||
    policy.minimumPriceChange5mPercent >= policy.maximumPriceChange5mPercent ||
    policy.minimumPriceChange1hPercent >= policy.maximumPriceChange1hPercent ||
    policy.minimumPriceChange6hPercent >= policy.maximumPriceChange6hPercent ||
    policy.breakEvenActivationPercent >= policy.trailingActivationPercent ||
    policy.trailingActivationPercent >= policy.takeProfitPercent ||
    policy.noProgressMinutes > policy.maximumHoldingMinutes ||
    policy.cooldownMinutes > policy.stopCooldownMinutes
  ) throw new RangeError("Autonomous paper policy thresholds are internally inconsistent.");
}

function autonomousDecisionReason(reason: string): string {
  // Strategy reason codes are fixed internal identifiers, not credentials.
  // Preserve them for an auditable dashboard while still redacting free-form
  // provider errors that may echo request metadata.
  return /^[A-Z][A-Z0-9_]{1,95}$/.test(reason)
    ? reason
    : redactSensitiveText(reason, 1_000);
}

export interface ResearchPaperWatchlistRefreshOptions {
  targetWalletCount?: number;
  providerSnapshotMaxAgeDays?: number;
  activityWindowDays?: number;
  minimumRecentTrades?: number;
  localActivityLookbackDays?: number;
  at?: Date;
}

function boundedResearchInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string
): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved)) throw new RangeError(`${label} must be finite.`);
  return Math.max(minimum, Math.min(maximum, Math.trunc(resolved)));
}

function researchPaperWatchlistPolicy(
  options: ResearchPaperWatchlistRefreshOptions
): ResearchPaperWatchlistPolicy {
  if (options.activityWindowDays !== undefined &&
      Math.trunc(options.activityWindowDays) !== DEFAULT_RESEARCH_PAPER_ACTIVITY_WINDOW_DAYS) {
    throw new RangeError("Research paper provider activity evidence is available only for the 30-day window.");
  }
  return {
    targetWalletCount: boundedResearchInteger(
      options.targetWalletCount,
      DEFAULT_RESEARCH_PAPER_WATCHLIST_TARGET,
      1,
      MAXIMUM_RESEARCH_PAPER_WATCHLIST_TARGET,
      "Research paper wallet target"
    ),
    providerSnapshotMaxAgeDays: boundedResearchInteger(
      options.providerSnapshotMaxAgeDays,
      DEFAULT_RESEARCH_PAPER_PROVIDER_SNAPSHOT_MAX_AGE_DAYS,
      1,
      30,
      "Research paper provider snapshot age"
    ),
    activityWindowDays: DEFAULT_RESEARCH_PAPER_ACTIVITY_WINDOW_DAYS,
    minimumRecentTrades: boundedResearchInteger(
      options.minimumRecentTrades,
      DEFAULT_RESEARCH_PAPER_MINIMUM_COMPLETED_TRADES,
      1,
      10_000,
      "Research paper minimum recent trades"
    ),
    localActivityLookbackDays: boundedResearchInteger(
      options.localActivityLookbackDays,
      DEFAULT_RESEARCH_PAPER_LOCAL_ACTIVITY_LOOKBACK_DAYS,
      1,
      30,
      "Research paper local activity lookback"
    )
  };
}

interface SignalOutcomeRow {
  idempotency_key: string;
  source_signature: string;
  source_wallet: string;
  mint: string;
  action: SignalOutcomeAction;
  mode: ExecutionMode;
  status: SignalOutcomeStatus;
  reason_code: SignalOutcomeReasonCode;
  reason: string;
  source_block_time: string;
  observed_at: string;
  updated_at: string;
  decision_code: RiskDecision["code"] | null;
  execution_id: string | null;
  target_signature: string | null;
  position_value_usd: number | null;
  price_impact_percent: number | null;
  actual_fees_usd: number | null;
  implementation_shortfall_percent: number | null;
}

interface ResearchPaperLaneRow {
  id: string;
  label: typeof RESEARCH_PAPER_LABEL;
  purpose: "RESEARCH_ONLY";
  policy_version: string;
  policy_json: string;
  initial_nav_per_leader_usd: number;
  status: ResearchPaperLane["status"];
  started_at: string;
  updated_at: string;
  archived_at: string | null;
}

interface ResearchPaperEventRow {
  event_json: string;
}

interface AutonomousPaperLaneRow {
  id: string;
  label: typeof AUTONOMOUS_PAPER_LABEL;
  purpose: "RESEARCH_ONLY";
  policy_version: string;
  policy_json: string;
  initial_nav_usd: number;
  status: AutonomousPaperLane["status"];
  started_at: string;
  updated_at: string;
  archived_at: string | null;
}

interface AutonomousPaperEventRow {
  event_json: string;
}

interface AutonomousPaperReplayEpisodeRow {
  episode_json: string;
}

interface AutonomousPaperReplayObservationRow {
  observation_key: string;
  sequence: number;
  observed_at: string;
  phase: AutonomousPaperReplayObservation["phase"];
  observation_digest: string;
  observation_json: string;
}

interface AutonomousPaperReplayReportRow {
  report_json: string;
}

interface AutonomousPaperReplayVariantRow {
  result_json: string;
}

type AutonomousPaperCandidateAction = "REJECT" | "OBSERVE";
type AutonomousPaperCandidateOutcome = "REJECTED" | "ANALYSIS_ONLY";
export const AUTONOMOUS_PAPER_CANDIDATE_EVENT_BATCH_MAXIMUM = 500;

interface AutonomousPaperCandidateDetailRow {
  event_key: string;
  lane_id: string;
  action: AutonomousPaperCandidateAction;
  outcome: AutonomousPaperCandidateOutcome;
  observed_at: string;
  event_json: string;
}

interface AutonomousPaperCandidateRollupRow {
  lane_id: string;
  utc_day: string;
  action: AutonomousPaperCandidateAction;
  outcome: AutonomousPaperCandidateOutcome;
  decision_count: number;
  first_observed_at: string;
  last_observed_at: string;
  reason_counts_json: string;
}

export interface AutonomousPaperCandidateRollup {
  laneId: string;
  utcDay: string;
  action: AutonomousPaperCandidateAction;
  outcome: AutonomousPaperCandidateOutcome;
  decisionCount: number;
  firstObservedAt: string;
  lastObservedAt: string;
  reasonCounts: Record<string, number>;
}

export interface AutonomousPaperCandidateCompactionOptions {
  retainNewest?: number;
  batchSize?: number;
}

export interface AutonomousPaperCandidateCompactionResult {
  laneId: string;
  compacted: number;
  rollupRows: number;
  retainedCandidateDetails: number;
  retainNewest: number;
  batchSize: number;
}

function autonomousCandidateReasonCounts(value: string): Record<string, number> {
  const decoded = decode<unknown>(value);
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new Error("Autonomous candidate rollup reason counts are invalid.");
  }
  const entries = Object.entries(decoded).sort(([left], [right]) => left.localeCompare(right));
  for (const [reason, count] of entries) {
    if (!reason || !Number.isSafeInteger(count) || (count as number) < 0) {
      throw new Error("Autonomous candidate rollup reason counts are invalid.");
    }
  }
  return Object.fromEntries(entries) as Record<string, number>;
}

function encodeAutonomousCandidateReasonCounts(counts: ReadonlyMap<string, number>): string {
  return encode(Object.fromEntries(
    [...counts.entries()].sort(([left], [right]) => left.localeCompare(right))
  ));
}

function decodeResearchPaperLane(row: ResearchPaperLaneRow): ResearchPaperLane {
  return {
    id: row.id,
    label: row.label,
    purpose: row.purpose,
    policyVersion: row.policy_version,
    policy: decode<Record<string, unknown>>(row.policy_json),
    initialNavPerLeaderUsd: row.initial_nav_per_leader_usd,
    status: row.status,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    ...(row.archived_at ? { archivedAt: row.archived_at } : {})
  };
}

function decodeAutonomousPaperLane(row: AutonomousPaperLaneRow): AutonomousPaperLane {
  const storedPolicy = decode<Partial<AutonomousPaperPolicy>>(row.policy_json);
  return {
    id: row.id,
    label: row.label,
    purpose: row.purpose,
    policyVersion: row.policy_version,
    policy: normalizeAutonomousPaperPolicy(row.policy_version, storedPolicy),
    initialNavUsd: row.initial_nav_usd,
    status: row.status,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    ...(row.archived_at ? { archivedAt: row.archived_at } : {})
  };
}

function finiteResearchNumber(value: number, label: string, minimum = 0): void {
  if (!Number.isFinite(value) || value < minimum) {
    throw new RangeError(`${label} must be a finite number no less than ${minimum}.`);
  }
}

const REPLAY_DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const REPLAY_EPISODE_KEYS = new Set([
  "id", "laneId", "positionId", "entryDecisionId", "mint", "symbol",
  "policyVersion", "replayVersion", "scenarioManifestDigest", "status",
  "actualOpenedAt", "captureStartedAt", "horizonEndsAt", "actualClosedAt",
  "observationCount", "pathDigest", "incompleteReason", "completedAt", "updatedAt"
]);
const REPLAY_OBSERVATION_KEYS = new Set([
  "observationKey", "episodeId", "laneId", "positionId", "mint", "sequence",
  "phase", "observedAt", "sourceUpdatedAt", "status", "failureCode",
  "marketPriceUsd", "momentumScore",
  "priceChange5mPercent", "organicBuyShare5m", "staticSafetyEligible",
  "signalEligible", "positionCostBasisUsd", "entryEvidence", "exitEvidence"
]);
const REPLAY_ENTRY_EVIDENCE_KEYS = new Set([
  "inputUsd", "outputAmountAtomic", "modeledFeeUsd", "totalCostUsd",
  "priceImpactPercent", "slippageBps", "projectedRoundTripCostPercent", "quotedAt"
]);
const REPLAY_EXIT_EVIDENCE_KEYS = new Set([
  "inputAmountAtomic", "guaranteedProceedsUsd", "modeledFeeUsd",
  "executableValueUsd", "priceImpactPercent", "slippageBps", "quotedAt"
]);
const REPLAY_VARIANT_PARAMETER_KEYS = new Set([
  "entryDelaySamples", "confirmationSamples", "minimumMomentumScore",
  "stopLossPercent", "breakEvenActivationPercent", "trailingActivationPercent",
  "trailingDrawdownPercent", "takeProfitPercent", "weakMomentumExitSamples",
  "noProgressMinutes", "maximumHoldingMinutes"
]);
const REPLAY_VARIANT_RESULT_KEYS = new Set([
  "reportId", "episodeId", "laneId", "positionId", "variantIndex", "variantId",
  "configurationDigest", "parameters", "causal", "independentTradeWeight",
  "outcome", "entryObservationKey", "exitObservationKey", "exitReason",
  "enteredAt", "exitedAt", "costBasisUsd", "proceedsUsd", "pnlUsd",
  "returnPercent", "maximumDrawdownPercent", "reward"
]);
const REPLAY_REPORT_KEYS = new Set([
  "id", "episodeId", "laneId", "positionId", "replayVersion",
  "scenarioManifestDigest", "pathDigest", "resultsDigest", "variantCount",
  "scorableVariantCount", "independentEpisodeCount", "calibrationTradeCount",
  "replayResultsAreIndependentTrades", "baselineVariantId",
  "baselineReturnPercent", "hindsightBestVariantId", "hindsightBestReturnPercent",
  "hindsightRegretPercent", "generatedAt"
]);

function exactReplayKeys(value: object, allowed: ReadonlySet<string>, label: string): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new Error(`${label} contains unsupported fields: ${unexpected.sort().join(", ")}.`);
  }
}

function replayTimestamp(value: string | undefined, label: string): number {
  const milliseconds = value === undefined ? Number.NaN : Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error(`${label} must be a valid timestamp.`);
  return milliseconds;
}

function replayDigest(value: string | undefined, label: string): void {
  if (!value || !REPLAY_DIGEST_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest.`);
  }
}

function replayIdentity(value: string | undefined, label: string): void {
  if (!value?.trim() || value.length > 512) throw new Error(`${label} is invalid.`);
}

function replayAtomicAmount(value: string, label: string): void {
  if (!/^\d+$/u.test(value) || BigInt(value) <= 0n) {
    throw new Error(`${label} must be a positive atomic integer string.`);
  }
}

function validateAutonomousPaperReplayEpisode(value: AutonomousPaperReplayEpisode): void {
  exactReplayKeys(value, REPLAY_EPISODE_KEYS, "Autonomous replay episode");
  replayIdentity(value.id, "Autonomous replay episode id");
  replayIdentity(value.laneId, "Autonomous replay lane id");
  replayIdentity(value.positionId, "Autonomous replay position id");
  replayIdentity(value.entryDecisionId, "Autonomous replay entry-decision id");
  replayIdentity(value.mint, "Autonomous replay mint");
  replayIdentity(value.policyVersion, "Autonomous replay policy version");
  if (value.symbol !== undefined && (!value.symbol.trim() || value.symbol.length > 128)) {
    throw new Error("Autonomous replay symbol is invalid.");
  }
  if (value.replayVersion !== AUTONOMOUS_PAPER_REPLAY_VERSION) {
    throw new Error("Autonomous replay version is unsupported.");
  }
  replayDigest(value.scenarioManifestDigest, "Autonomous replay scenario manifest digest");
  const openedAt = replayTimestamp(value.actualOpenedAt, "Autonomous replay actual-open time");
  const captureAt = replayTimestamp(value.captureStartedAt, "Autonomous replay capture-start time");
  const horizonAt = replayTimestamp(value.horizonEndsAt, "Autonomous replay horizon time");
  replayTimestamp(value.updatedAt, "Autonomous replay update time");
  if (captureAt < openedAt || horizonAt <= captureAt) {
    throw new Error("Autonomous replay episode time ordering is invalid.");
  }
  if (!Number.isSafeInteger(value.observationCount) || value.observationCount < 0) {
    throw new Error("Autonomous replay observation count is invalid.");
  }
  if (value.pathDigest !== undefined) replayDigest(value.pathDigest, "Autonomous replay path digest");
  if (value.actualClosedAt !== undefined) {
    const closedAt = replayTimestamp(value.actualClosedAt, "Autonomous replay actual-close time");
    if (closedAt < openedAt) throw new Error("Autonomous replay close precedes its actual entry.");
  }
  if (value.completedAt !== undefined) {
    const completedAt = replayTimestamp(value.completedAt, "Autonomous replay completion time");
    if (completedAt < captureAt) throw new Error("Autonomous replay completion precedes capture.");
  }
  if (value.incompleteReason !== undefined && (!value.incompleteReason.trim() || value.incompleteReason.length > 1_000)) {
    throw new Error("Autonomous replay incomplete reason is invalid.");
  }
}

function validateAutonomousPaperReplayObservation(value: AutonomousPaperReplayObservation): void {
  exactReplayKeys(value, REPLAY_OBSERVATION_KEYS, "Autonomous replay observation");
  for (const [identity, label] of [
    [value.observationKey, "observation key"],
    [value.episodeId, "episode id"],
    [value.laneId, "lane id"],
    [value.positionId, "position id"],
    [value.mint, "mint"]
  ] as const) replayIdentity(identity, `Autonomous replay ${label}`);
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 0) {
    throw new Error("Autonomous replay observation sequence is invalid.");
  }
  replayTimestamp(value.observedAt, "Autonomous replay observation time");
  replayTimestamp(value.sourceUpdatedAt, "Autonomous replay source-update time");
  finiteResearchNumber(value.positionCostBasisUsd, "Autonomous replay position cost basis", Number.EPSILON);
  if (value.status !== "EXECUTABLE" && value.status !== "UNPRICED") {
    throw new Error("Autonomous replay observation status is invalid.");
  }
  if (value.status === "UNPRICED") {
    if (!value.failureCode.trim() || value.failureCode.length > 256) {
      throw new Error("Autonomous replay unpriced observation failure code is invalid.");
    }
    if (value.phase === "ENTRY" || value.phase === "ACTUAL_EXIT") {
      throw new Error("Autonomous replay ENTRY and ACTUAL_EXIT evidence must be executable.");
    }
    if ([
      "marketPriceUsd", "momentumScore", "priceChange5mPercent",
      "organicBuyShare5m", "staticSafetyEligible", "signalEligible",
      "entryEvidence", "exitEvidence"
    ].some((key) => key in value)) {
      throw new Error("Autonomous replay unpriced observations cannot contain fabricated quote evidence.");
    }
    if (encode(value).length > 32_000) {
      throw new Error("Autonomous replay observation exceeds the sanitized evidence limit.");
    }
    return;
  }
  if ("failureCode" in value) {
    throw new Error("Autonomous replay executable observations cannot contain a failure code.");
  }
  finiteResearchNumber(value.marketPriceUsd, "Autonomous replay market price", Number.EPSILON);
  finiteResearchNumber(value.momentumScore, "Autonomous replay momentum score");
  if (value.momentumScore > 100) throw new Error("Autonomous replay momentum score exceeds 100.");
  if (!Number.isFinite(value.priceChange5mPercent)) {
    throw new Error("Autonomous replay five-minute price change is invalid.");
  }
  if (!Number.isFinite(value.organicBuyShare5m) ||
      (value.organicBuyShare5m !== -1 &&
        (value.organicBuyShare5m < 0 || value.organicBuyShare5m > 1))) {
    throw new Error("Autonomous replay organic-buy share is invalid.");
  }
  if (typeof value.staticSafetyEligible !== "boolean" || typeof value.signalEligible !== "boolean") {
    throw new Error("Autonomous replay eligibility flags are invalid.");
  }
  exactReplayKeys(value.exitEvidence, REPLAY_EXIT_EVIDENCE_KEYS, "Autonomous replay exit evidence");
  replayAtomicAmount(value.exitEvidence.inputAmountAtomic, "Autonomous replay exit input amount");
  finiteResearchNumber(value.exitEvidence.guaranteedProceedsUsd, "Autonomous replay guaranteed proceeds");
  finiteResearchNumber(value.exitEvidence.modeledFeeUsd, "Autonomous replay exit fee");
  finiteResearchNumber(value.exitEvidence.executableValueUsd, "Autonomous replay executable value");
  finiteResearchNumber(value.exitEvidence.priceImpactPercent, "Autonomous replay exit price impact");
  finiteResearchNumber(value.exitEvidence.slippageBps, "Autonomous replay exit slippage");
  replayTimestamp(value.exitEvidence.quotedAt, "Autonomous replay exit quote time");
  if (Math.abs(
    value.exitEvidence.executableValueUsd -
      Math.max(0, value.exitEvidence.guaranteedProceedsUsd - value.exitEvidence.modeledFeeUsd)
  ) > 0.01) throw new Error("Autonomous replay executable value does not reconcile.");
  if (value.entryEvidence) {
    exactReplayKeys(value.entryEvidence, REPLAY_ENTRY_EVIDENCE_KEYS, "Autonomous replay entry evidence");
    replayAtomicAmount(value.entryEvidence.outputAmountAtomic, "Autonomous replay entry output amount");
    finiteResearchNumber(value.entryEvidence.inputUsd, "Autonomous replay entry input", Number.EPSILON);
    finiteResearchNumber(value.entryEvidence.modeledFeeUsd, "Autonomous replay entry fee");
    finiteResearchNumber(value.entryEvidence.totalCostUsd, "Autonomous replay total entry cost", Number.EPSILON);
    finiteResearchNumber(value.entryEvidence.priceImpactPercent, "Autonomous replay entry price impact");
    finiteResearchNumber(value.entryEvidence.slippageBps, "Autonomous replay entry slippage");
    finiteResearchNumber(
      value.entryEvidence.projectedRoundTripCostPercent,
      "Autonomous replay projected round-trip cost"
    );
    replayTimestamp(value.entryEvidence.quotedAt, "Autonomous replay entry quote time");
    if (Math.abs(
      value.entryEvidence.totalCostUsd -
        (value.entryEvidence.inputUsd + value.entryEvidence.modeledFeeUsd)
    ) > 0.01) throw new Error("Autonomous replay total entry cost does not reconcile.");
  }
  if ((value.phase === "ENTRY") !== (value.entryEvidence !== undefined)) {
    throw new Error("Autonomous replay entry evidence must appear exactly once on the ENTRY observation.");
  }
  if (encode(value).length > 32_000) {
    throw new Error("Autonomous replay observation exceeds the sanitized evidence limit.");
  }
}

function validateAutonomousPaperReplayVariantParameters(
  value: AutonomousPaperReplayVariantParameters
): void {
  exactReplayKeys(value, REPLAY_VARIANT_PARAMETER_KEYS, "Autonomous replay variant parameters");
  for (const [field, label, minimum] of [
    [value.entryDelaySamples, "entry delay samples", 0],
    [value.confirmationSamples, "confirmation samples", 1],
    [value.weakMomentumExitSamples, "weak-momentum samples", 1],
    [value.noProgressMinutes, "no-progress minutes", 1],
    [value.maximumHoldingMinutes, "maximum holding minutes", 1]
  ] as const) {
    if (!Number.isSafeInteger(field) || field < minimum) {
      throw new Error(`Autonomous replay ${label} is invalid.`);
    }
  }
  for (const [field, label, minimum] of [
    [value.minimumMomentumScore, "minimum momentum score", 0],
    [value.stopLossPercent, "stop loss", Number.EPSILON],
    [value.breakEvenActivationPercent, "break-even activation", Number.EPSILON],
    [value.trailingActivationPercent, "trailing activation", Number.EPSILON],
    [value.trailingDrawdownPercent, "trailing drawdown", Number.EPSILON],
    [value.takeProfitPercent, "take profit", Number.EPSILON]
  ] as const) finiteResearchNumber(field, `Autonomous replay ${label}`, minimum);
  if (value.minimumMomentumScore > 100 || value.maximumHoldingMinutes < value.noProgressMinutes) {
    throw new Error("Autonomous replay variant parameter ordering is invalid.");
  }
}

function validateAutonomousPaperReplayVariantResult(value: AutonomousPaperReplayVariantResult): void {
  exactReplayKeys(value, REPLAY_VARIANT_RESULT_KEYS, "Autonomous replay variant result");
  for (const [identity, label] of [
    [value.reportId, "report id"], [value.episodeId, "episode id"],
    [value.laneId, "lane id"], [value.positionId, "position id"],
    [value.variantId, "variant id"]
  ] as const) replayIdentity(identity, `Autonomous replay ${label}`);
  if (!Number.isSafeInteger(value.variantIndex) || value.variantIndex < 0 ||
      value.variantIndex >= AUTONOMOUS_PAPER_REPLAY_VARIANT_COUNT) {
    throw new Error("Autonomous replay variant index is invalid.");
  }
  replayDigest(value.configurationDigest, "Autonomous replay configuration digest");
  validateAutonomousPaperReplayVariantParameters(value.parameters);
  if (value.causal !== true || value.independentTradeWeight !== 0) {
    throw new Error("Autonomous replay results must be causal and carry zero independent-trade weight.");
  }
  for (const [timestamp, label] of [
    [value.enteredAt, "entry time"], [value.exitedAt, "exit time"]
  ] as const) if (timestamp !== undefined) replayTimestamp(timestamp, `Autonomous replay ${label}`);
  for (const [field, label, minimum] of [
    [value.costBasisUsd, "cost basis", 0], [value.proceedsUsd, "proceeds", 0],
    [value.maximumDrawdownPercent, "maximum drawdown", 0]
  ] as const) if (field !== undefined) finiteResearchNumber(field, `Autonomous replay ${label}`, minimum);
  for (const [field, label] of [
    [value.pnlUsd, "PnL"], [value.returnPercent, "return"], [value.reward, "reward"]
  ] as const) if (field !== undefined && !Number.isFinite(field)) {
    throw new Error(`Autonomous replay ${label} is invalid.`);
  }
  if (value.reward !== undefined && (value.reward < -1 || value.reward > 1)) {
    throw new Error("Autonomous replay reward must be between -1 and 1.");
  }
  if (value.outcome === "COMPLETED" && (
    !value.entryObservationKey || !value.exitObservationKey || !value.exitReason ||
    value.enteredAt === undefined || value.exitedAt === undefined ||
    value.costBasisUsd === undefined || value.proceedsUsd === undefined ||
    value.pnlUsd === undefined || value.returnPercent === undefined
  )) throw new Error("A completed autonomous replay result requires terminal outcome evidence.");
}

function validateAutonomousPaperReplayReport(value: AutonomousPaperReplayReport): void {
  exactReplayKeys(value, REPLAY_REPORT_KEYS, "Autonomous replay report");
  for (const [identity, label] of [
    [value.id, "report id"], [value.episodeId, "episode id"],
    [value.laneId, "lane id"], [value.positionId, "position id"],
    [value.baselineVariantId, "baseline variant id"]
  ] as const) replayIdentity(identity, `Autonomous replay ${label}`);
  if (value.replayVersion !== AUTONOMOUS_PAPER_REPLAY_VERSION) {
    throw new Error("Autonomous replay report version is unsupported.");
  }
  replayDigest(value.scenarioManifestDigest, "Autonomous replay report manifest digest");
  replayDigest(value.pathDigest, "Autonomous replay report path digest");
  replayDigest(value.resultsDigest, "Autonomous replay results digest");
  if (value.variantCount !== AUTONOMOUS_PAPER_REPLAY_VARIANT_COUNT ||
      !Number.isSafeInteger(value.scorableVariantCount) || value.scorableVariantCount < 0 ||
      value.scorableVariantCount > value.variantCount || value.independentEpisodeCount !== 1 ||
      value.calibrationTradeCount !== 0 || value.replayResultsAreIndependentTrades !== false) {
    throw new Error("Autonomous replay report count or independence metadata is invalid.");
  }
  replayTimestamp(value.generatedAt, "Autonomous replay report generation time");
  for (const [field, label] of [
    [value.baselineReturnPercent, "baseline return"],
    [value.hindsightBestReturnPercent, "hindsight-best return"],
    [value.hindsightRegretPercent, "hindsight regret"]
  ] as const) if (field !== undefined && !Number.isFinite(field)) {
    throw new Error(`Autonomous replay ${label} is invalid.`);
  }
  if (value.hindsightBestVariantId !== undefined) {
    replayIdentity(value.hindsightBestVariantId, "Autonomous replay hindsight-best variant id");
  }
}

/** Builds a UI-only interpretation from immutable replay evidence. The return
 * value has no persistence or trading identity and is never consumed by the
 * autonomous engine. */
export function deriveAutonomousPaperReplayInsight(
  report: AutonomousPaperReplayReport,
  variants: readonly AutonomousPaperReplayVariantResult[],
  observations: readonly AutonomousPaperReplayObservation[]
): AutonomousPaperReplayInsight {
  const identitiesMatch = variants.every((variant) =>
    variant.reportId === report.id &&
    variant.episodeId === report.episodeId &&
    variant.laneId === report.laneId &&
    variant.positionId === report.positionId
  ) && observations.every((observation) =>
    observation.episodeId === report.episodeId &&
    observation.laneId === report.laneId &&
    observation.positionId === report.positionId
  );
  const completeCoverage = identitiesMatch &&
    report.variantCount === AUTONOMOUS_PAPER_REPLAY_VARIANT_COUNT &&
    variants.length === report.variantCount;
  const completed = variants.filter((variant) =>
    variant.outcome === "COMPLETED" &&
    variant.exitReason !== undefined &&
    variant.exitedAt !== undefined &&
    variant.pnlUsd !== undefined && Number.isFinite(variant.pnlUsd) &&
    variant.returnPercent !== undefined && Number.isFinite(variant.returnPercent)
  );
  const profitableVariantCount = completed.filter((variant) => variant.pnlUsd! > 0).length;
  const best = [...completed].sort((left, right) =>
    right.returnPercent! - left.returnPercent! || left.variantIndex - right.variantIndex
  )[0];
  const observedExits = observations.flatMap((observation) => {
    if (observation.phase === "ENTRY" || observation.status !== "EXECUTABLE") return [];
    const costBasisUsd = observation.positionCostBasisUsd;
    const executableValueUsd = observation.exitEvidence.executableValueUsd;
    if (!Number.isFinite(costBasisUsd) || costBasisUsd <= 0 ||
        !Number.isFinite(executableValueUsd)) return [];
    const pnlUsd = executableValueUsd - costBasisUsd;
    return [{
      observationKey: observation.observationKey,
      phase: observation.phase,
      observedAt: observation.observedAt,
      executableValueUsd,
      pnlUsd,
      returnPercent: pnlUsd / costBasisUsd * 100,
      sequence: observation.sequence
    }];
  });
  const bestObserved = [...observedExits].sort((left, right) =>
    right.returnPercent - left.returnPercent || left.sequence - right.sequence
  )[0];
  const actualObserved = observedExits.find((observation) => observation.phase === "ACTUAL_EXIT");
  const observedProfitableExit = bestObserved !== undefined && bestObserved.pnlUsd > 0;
  const hasUnpricedPostEntryGap = observations.some((observation) =>
    observation.phase !== "ENTRY" && observation.status === "UNPRICED"
  );
  const comparable = completeCoverage && best !== undefined &&
    actualObserved !== undefined;
  const improvementPercentPoints = comparable
    ? best.returnPercent! - actualObserved.returnPercent
    : undefined;
  const classification: AutonomousPaperReplayInsight["classification"] = !comparable
    ? "UNSCORABLE"
    : improvementPercentPoints! <= 1e-9
      ? "NO_IMPROVEMENT"
      : best.pnlUsd! > 0
        ? "PROFITABLE_TESTED_ALTERNATIVE"
        : "REDUCED_LOSS_ONLY";
  const pathDiagnosis: AutonomousPaperReplayInsight["pathDiagnosis"] = !completeCoverage
    ? "UNSCORABLE"
    : profitableVariantCount > 0
      ? "TESTED_POLICY_FOUND_PROFIT"
      : observedProfitableExit
        ? "GRID_POLICY_GAP"
        : bestObserved === undefined || hasUnpricedPostEntryGap
          ? "UNSCORABLE"
          : "ENTRY_QUALITY_PROBLEM";
  return {
    reportId: report.id,
    episodeId: report.episodeId,
    classification,
    evaluatedVariantCount: variants.length,
    profitableVariantCount,
    pathDiagnosis,
    ...(actualObserved
      ? {
          actualExit: {
            observationKey: actualObserved.observationKey,
            observedAt: actualObserved.observedAt,
            executableValueUsd: actualObserved.executableValueUsd,
            pnlUsd: actualObserved.pnlUsd,
            returnPercent: actualObserved.returnPercent
          }
        }
      : {}),
    ...(best
      ? {
          bestVariant: {
            variantId: best.variantId,
            variantIndex: best.variantIndex,
            parameters: best.parameters,
            exitReason: best.exitReason!,
            exitedAt: best.exitedAt!,
            pnlUsd: best.pnlUsd!,
            returnPercent: best.returnPercent!
          }
        }
      : {}),
    ...(improvementPercentPoints !== undefined ? { improvementPercentPoints } : {}),
    ...(bestObserved
      ? {
          bestObservedExit: {
            observationKey: bestObserved.observationKey,
            phase: bestObserved.phase,
            observedAt: bestObserved.observedAt,
            executableValueUsd: bestObserved.executableValueUsd,
            pnlUsd: bestObserved.pnlUsd,
            returnPercent: bestObserved.returnPercent
          }
        }
      : {}),
    observedProfitableExit
  };
}

function decodeSignalOutcome(row: SignalOutcomeRow): SignalAuditRecord {
  return {
    id: row.idempotency_key,
    idempotencyKey: row.idempotency_key,
    sourceSignature: row.source_signature,
    sourceWallet: row.source_wallet,
    mint: row.mint,
    action: row.action,
    mode: row.mode,
    status: row.status,
    reasonCode: row.reason_code,
    reason: redactSensitiveText(row.reason, 1_000),
    sourceBlockTime: row.source_block_time,
    observedAt: row.observed_at,
    updatedAt: row.updated_at,
    ...(row.decision_code ? { decisionCode: row.decision_code } : {}),
    ...(row.execution_id ? { executionId: row.execution_id } : {}),
    ...(row.target_signature ? { targetSignature: row.target_signature } : {}),
    ...(row.position_value_usd !== null ? { positionValueUsd: row.position_value_usd } : {}),
    ...(row.price_impact_percent !== null ? { priceImpactPercent: row.price_impact_percent } : {}),
    ...(row.actual_fees_usd !== null ? { actualFeesUsd: row.actual_fees_usd } : {}),
    ...(row.implementation_shortfall_percent !== null
      ? { implementationShortfallPercent: row.implementation_shortfall_percent }
      : {})
  };
}

const TERMINAL_SIGNAL_OUTCOMES = new Set<SignalOutcomeStatus>([
  "ANALYSIS_ONLY",
  "BLOCKED",
  "REJECTED",
  "SIMULATED",
  "CONFIRMED",
  "FAILED"
]);

function signalOutcomeTransitionAllowed(
  current: SignalOutcomeStatus,
  next: SignalOutcomeStatus
): boolean {
  if (current === next) return true;
  if (TERMINAL_SIGNAL_OUTCOMES.has(current)) return false;
  if (current === "RETRY_PENDING") return true;
  if (current === "QUEUED") {
    return !["ANALYSIS_ONLY", "BLOCKED", "RETRY_PENDING"].includes(next);
  }
  if (current === "AWAITING_APPROVAL") {
    return ["APPROVED", "SUBMITTED", "SUBMITTED_UNRESOLVED", "CONFIRMED", "REJECTED", "FAILED"].includes(next);
  }
  if (current === "APPROVED") {
    return ["SUBMITTED", "SUBMITTED_UNRESOLVED", "CONFIRMED", "FAILED"].includes(next);
  }
  if (current === "SUBMITTED") {
    return ["SUBMITTED_UNRESOLVED", "CONFIRMED", "FAILED"].includes(next);
  }
  if (current === "SUBMITTED_UNRESOLVED") return ["CONFIRMED", "FAILED"].includes(next);
  return false;
}

function decodeWalletIndexRun(value: string): WalletIndexRun {
  const legacy = decode<WalletIndexRun & { qualifiedWallets?: number }>(value);
  const { qualifiedWallets, ...run } = legacy;
  return {
    ...run,
    structuralCandidates: run.structuralCandidates ?? qualifiedWallets ?? 0
  };
}
const LOCAL_SOL_PRICE_HORIZON_MS = 90 * 86_400_000;
const LOCAL_SOL_PRICE_TOLERANCE_MS = 10 * 60_000;

interface ProviderParityProofEpochRow {
  id: string;
  status: ProviderParityProofEpoch["status"];
  endpoint_fingerprint: string;
  window_start_at: string;
  window_end_at: string;
  cutoff_at: string;
  control_population_available: number;
  subjects_json: string;
  manifest_digest: string;
  created_at: string;
  activated_at: string | null;
  invalidated_at: string | null;
  invalidation_reason: string | null;
}

function decodeProviderParityProofEpoch(row: ProviderParityProofEpochRow): ProviderParityProofEpoch {
  return {
    id: row.id,
    status: row.status,
    endpointFingerprint: row.endpoint_fingerprint,
    windowStartAt: row.window_start_at,
    windowEndAt: row.window_end_at,
    cutoffAt: row.cutoff_at,
    controlPopulationAvailable: row.control_population_available === 1,
    subjects: decode<ProviderParityProofEpoch["subjects"]>(row.subjects_json),
    manifestDigest: row.manifest_digest,
    createdAt: row.created_at,
    ...(row.activated_at ? { activatedAt: row.activated_at } : {}),
    ...(row.invalidated_at ? { invalidatedAt: row.invalidated_at } : {}),
    ...(row.invalidation_reason ? { invalidationReason: row.invalidation_reason } : {})
  };
}

function frozenProviderParityBaselineBlockers(
  epoch: ProviderParityProofEpoch,
  observations: readonly ProviderParityObservation[]
): string[] {
  const blockers: string[] = [];
  const verified = observations.filter((observation) => {
    const result = verifyBoundProviderParityObservation(epoch, observation);
    if (!result.ok) blockers.push(`invalid ${observation.capability.toLowerCase()} digest`);
    return result.ok;
  });
  const baselineCapabilities = new Set<ProviderParityObservation["capability"]>([
    "WALLET_DISCOVERY",
    "WALLET_PNL_30D",
    "WALLET_PNL_90D",
    "CHAIN_HISTORY",
    "CHAIN_GAP"
  ]);
  if (verified.some((observation) => baselineCapabilities.has(observation.capability) && observation.status !== "MATCH")) {
    blockers.push("the prepared baseline contains a divergence, unavailable result, or pending comparison");
  }
  const discovery = verified.find((observation) =>
    observation.capability === "WALLET_DISCOVERY" && observation.status === "MATCH"
  );
  if (!discovery || discovery.proof?.input.kind !== "DISCOVERY") {
    blockers.push("same-cutoff discovery ranks and control lanes are not frozen");
  }
  for (const subject of epoch.subjects) {
    for (const capability of [
      "WALLET_PNL_30D",
      "WALLET_PNL_90D",
      "CHAIN_HISTORY",
      "CHAIN_GAP"
    ] as const) {
      if (!verified.some((observation) =>
        observation.capability === capability &&
        observation.subject === subject.address &&
        observation.status === "MATCH"
      )) blockers.push(`${subject.address} has no frozen ${capability.toLowerCase()} match`);
    }
  }
  return [...new Set(blockers)];
}

export type EmergencyLiquidationState = "LIQUIDATING" | "LOCKED_COMPLETE" | "LOCKED_INCOMPLETE";
export type EmergencyExitOperationState = "PENDING" | "SUBMITTED_UNRESOLVED" | "CONFIRMED" | "FAILED_SAFE";

export interface EmergencyLiquidationRecord {
  id: string;
  state: EmergencyLiquidationState;
  reason: string;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  closedPositions: number;
  failedPositions: number;
}

export interface EmergencyExitOperation {
  operationId: string;
  liquidationId: string;
  positionId: string;
  attempt: number;
  idempotencyKey: string;
  sourceSignature: string;
  state: EmergencyExitOperationState;
  executionId?: string;
  targetSignature?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PaperEvaluationCohort {
  id: string;
  sourceCohortId: string;
  frozenAt: string;
  initialNavUsd: number;
  wallets: string[];
  status: "ACTIVE" | "SUPERSEDED";
  supersededAt?: string;
}

export type MonitoringRepairStatus = "PENDING" | "READY" | "FAILED";

export interface MonitoringRepairCheckpoint {
  wallet: string;
  cursorAt: string;
  status: MonitoringRepairStatus;
  attemptStartedAt?: string;
  lastSucceededAt?: string;
  nextRetryAt?: string;
  failureCount: number;
  lastError?: string;
  updatedAt: string;
}

export interface WalletIndexEnqueueItem {
  signature: string;
  sourceAddress: string;
  source: string;
  wallet?: string;
  discoveredAt?: string;
  runId?: string;
  slot?: number;
  blockTime?: string;
  priority?: number;
  metadata?: Record<string, unknown>;
}

export interface WalletIndexEnqueueResult {
  observations: number;
  enqueued: number;
  deduplicated: number;
  sourcesAdded: number;
}

export interface WalletDeepHistoryQueueCoverage {
  total: number;
  pending: number;
  leased: number;
  processed: number;
  retry: number;
  failed: number;
}

export interface WalletIdentityEvidenceCoverage {
  sourceSignatures: number;
  processedSignatures: number;
  evidenceSignatures: number;
  missingEvidence: number;
}

export interface CoordinatedBuyEvidenceResult {
  rows: WalletIdentityCoordinatedBuyEvidence[];
  complete: boolean;
  reasons: string[];
}

export interface WalletIdentityProgramSlotCoverage {
  complete: boolean;
  reasons: string[];
}

export interface DirtyWalletIndexRecord {
  wallet: string;
  markedAt: string;
  lastSignature: string;
}

export interface WalletIndexResearchPageOptions {
  page: number;
  pageSize: number;
  filter: WalletResearchFilter;
  sort: WalletResearchSort;
}

export interface WalletIndexFunnelCounts {
  indexed: number;
  coarseSignerCandidates: number;
  exactSwapWallets: number;
  activityScreened: number;
  activityProven: number;
  closedSwaps: number;
  holdingTime: number;
}

export interface CoarseWalletBootstrapCandidate {
  signature: string;
  wallet: string;
  programId: string;
  slot?: number;
  blockTime?: string;
  observedSuccessfulTransactions: number;
}

export interface WalletDiscoveryAttributionInput {
  signature: string;
  programId: string;
  source: string;
  observedAt: string;
  metadata: Record<string, unknown>;
  wallet?: string;
}

export type WalletResearchHandoffStatus = "READY" | "RUNNING" | "RETRY" | "COMPLETE";

export interface WalletResearchHandoff {
  generation: string;
  runId: string;
  status: WalletResearchHandoffStatus;
  wallets: string[];
  readyAt: string;
  updatedAt: string;
  attempts: number;
  nextAttemptAt: string;
  lastError?: string;
  completedAt?: string;
  cohortId?: string;
}

export interface EnqueueWalletResearchHandoff {
  generation: string;
  runId: string;
  wallets: string[];
  readyAt: string;
}

/**
 * MANAGED_SCREENED is an effective, certificate-backed status. The underlying
 * exact-evidence row deliberately remains OPEN so legacy/local selectors can
 * never mistake a coarse managed pass for COMPLETE evidence.
 */
export type WalletDeepHistoryCohortStatus = "OPEN" | "MANAGED_SCREENED" | "COMPLETE";

export type WalletDeepHistoryTargetDispositionKind = "COARSE_COPYABILITY_SKIP";

export interface WalletDeepHistoryTargetDisposition {
  cohortId: string;
  generationId: string;
  wallet: string;
  disposition: WalletDeepHistoryTargetDispositionKind;
  policyVersion: string;
  snapshotCalculatedAt: string;
  snapshot: WalletPreScreenSnapshot;
  snapshotDigest: string;
  details: {
    cohortId: string;
    generationId: string;
    wallet: string;
    snapshotCutoffAt: string;
    snapshotCalculatedAt: string;
    policyVersion: string;
    disposition: WalletDeepHistoryTargetDispositionKind;
    thresholdMinutes: number;
    observedMedianHoldingMinutes: number;
  };
  decisionDigest: string;
  decidedAt: string;
}

export interface SaveManagedCoarseDispositionResult {
  disposition: WalletDeepHistoryTargetDisposition;
  created: boolean;
}

export interface WalletDeepHistoryGeneration {
  id: string;
  sequence: number;
  status: WalletDeepHistoryCohortStatus;
  selectedAt: string;
  snapshotCutoffAt: string;
  windowStart: string;
  windowEnd: string;
  createdAt: string;
  completedAt?: string;
}

export interface WalletDeepHistoryCohort {
  id: string;
  sequence: number;
  generationId: string;
  status: WalletDeepHistoryCohortStatus;
  selectedAt: string;
  snapshotCutoffAt: string;
  windowStart: string;
  windowEnd: string;
  wallets: string[];
  createdAt: string;
  completedAt?: string;
}

export interface CreateWalletDeepHistoryCohort {
  generationId?: string;
  /**
   * Rescue cohorts deliberately revisit an earlier managed-only coarse skip.
   * The immutable id prefix keeps that scheduling policy recoverable across a
   * restart without changing or deleting the original v1 disposition.
   */
  kind?: "STANDARD" | "MANAGED_RESCUE_V2" | "MANAGED_RESCUE_V3";
  /** Required for v3 so authorization is rechecked in the cohort transaction. */
  preflightGate?: ManagedRecoveryPreflightGate;
  selectedAt: string;
  snapshotCutoffAt: string;
  windowStart: string;
  windowEnd: string;
  wallets: string[];
}

export type ManagedRecoveryPreflightStatus =
  | "READY"
  | "RUNNING"
  | "RETRY"
  | "PASS"
  | "REJECTED";

export interface ManagedRecoveryPreflightGate {
  policyVersion: string;
  windowStart: string;
  validAt: string;
}

export interface ManagedRecoveryPreflight {
  id: string;
  policyVersion: string;
  week: string;
  windowStart: string;
  wallet: string;
  status: ManagedRecoveryPreflightStatus;
  attempts: number;
  nextAttemptAt: string;
  step: ManagedRecoveryPreflightStep;
  pnl30d?: WalletPnlWindow;
  pnl90d?: WalletPnlWindow;
  history?: WalletHistorySummary;
  reasons: string[];
  checkedAt?: string;
  expiresAt?: string;
  lastError?: string;
  updatedAt: string;
}

export interface ManagedRecoveryPreflightCounts {
  total: number;
  ready: number;
  running: number;
  retry: number;
  pass: number;
  rejected: number;
}

export interface WalletDeepHistoryEvidence {
  generationId: string;
  cohortId: string;
  wallet: string;
  record: WalletIndexRecord;
  swaps: IndexedSpotSwap[];
  evidenceDigest: string;
  frozenAt: string;
}

/**
 * Scheduling metadata for frozen evidence. The large swap payload is omitted;
 * selected wallets must still load full evidence before handoff so the
 * record+swap digest remains verified end to end.
 */
export interface WalletDeepHistoryEvidenceSummary {
  generationId: string;
  cohortId: string;
  wallet: string;
  record: WalletIndexRecord;
  evidenceDigest: string;
  frozenAt: string;
}

/** Evidence-bearing managed cohort metadata used by the partial handoff scheduler. */
export interface WalletDeepHistoryOpenCohortEvidence {
  cohortId: string;
  generationId: string;
  sequence: number;
  status: "OPEN" | "MANAGED_SCREENED";
  evidence: WalletDeepHistoryEvidenceSummary[];
}

export interface WalletDeepHistoryCompletedCohortEvidence {
  cohortId: string;
  generationId: string;
  cohortSequence: number;
  generationSequence: number;
  evidence: WalletDeepHistoryEvidenceSummary[];
}

export const COMPLETE_LOCAL_WALLET_RESEARCH_PIPELINE_VERSION = "v4";

/**
 * Select only completed cohorts that have not reached their exact full-handoff
 * idempotency key. The nullable evidence join deliberately retains completed
 * zero-evidence cohorts so the scheduler still records their empty handoff.
 */
export const WALLET_DEEP_HISTORY_UNHANDED_COMPLETE_QUERY = `
  SELECT
    generation.id AS generation_id,
    generation.sequence AS generation_sequence,
    cohort.id AS cohort_id,
    cohort.sequence AS cohort_sequence,
    evidence.wallet,
    evidence.record_json,
    evidence.evidence_digest,
    evidence.frozen_at
  FROM wallet_deep_history_cohorts AS cohort
    INDEXED BY wallet_deep_history_cohorts_status_sequence
  JOIN wallet_deep_history_generations AS generation
    ON generation.id = cohort.generation_id
  LEFT JOIN wallet_deep_history_evidence AS evidence
    INDEXED BY wallet_deep_history_evidence_cohort
    ON evidence.cohort_id = cohort.id
   AND evidence.generation_id = cohort.generation_id
  WHERE cohort.status = 'COMPLETE'
    AND NOT EXISTS (
      SELECT 1 FROM wallet_research_handoffs AS exact_handoff
      WHERE exact_handoff.generation =
        'local-index-${COMPLETE_LOCAL_WALLET_RESEARCH_PIPELINE_VERSION}:' || cohort.generation_id || ':' || cohort.id
    )
  ORDER BY generation.sequence, cohort.sequence, evidence.wallet
`;

/**
 * Start from the narrow evidence index so a long history of zero-evidence,
 * coarsely skipped cohorts never becomes scheduler work. CROSS JOIN fixes the
 * evidence-first loop order; the cohort join verifies the frozen generation.
 */
export const WALLET_DEEP_HISTORY_OPEN_EVIDENCE_QUERY = `
  SELECT
    cohort.id AS cohort_id,
    cohort.generation_id,
    cohort.sequence AS cohort_sequence,
    CASE WHEN managed.cohort_id IS NULL THEN 'OPEN' ELSE 'MANAGED_SCREENED' END AS cohort_status,
    evidence.wallet,
    evidence.record_json,
    evidence.evidence_digest,
    evidence.frozen_at
  FROM wallet_deep_history_evidence AS evidence
    INDEXED BY wallet_deep_history_evidence_cohort
  CROSS JOIN wallet_deep_history_cohorts AS cohort
    ON cohort.id = evidence.cohort_id
   AND cohort.generation_id = evidence.generation_id
  LEFT JOIN wallet_deep_history_managed_cohort_screenings AS managed
    ON managed.cohort_id = cohort.id
  WHERE cohort.status = 'OPEN'
  ORDER BY cohort.sequence, evidence.wallet
`;

export interface PendingIndexedSwapReprice {
  swap: IndexedSpotSwap;
  attempts: number;
  availableAt: string;
  lastError?: string;
}

interface WalletIndexQueueRow {
  signature: string;
  slot: number | null;
  block_time: string | null;
  status: WalletIndexQueueStatus;
  attempts: number;
  priority: number;
  discovered_at: string;
  available_at: string;
  lease_owner: string | null;
  lease_token: string | null;
  leased_at: string | null;
  lease_expires_at: string | null;
  last_error: string | null;
  processed_at: string | null;
  updated_at: string;
  success: number | null;
  fee_payer: string | null;
  account_keys_json: string | null;
  program_ids_json: string | null;
  transaction_json: string | null;
  indexed_at: string | null;
}

interface EmergencyLiquidationRow {
  id: string;
  state: EmergencyLiquidationState;
  reason: string;
  started_at: string;
  updated_at: string;
  finished_at: string | null;
  closed_positions: number;
  failed_positions: number;
}

interface EmergencyExitOperationRow {
  operation_id: string;
  liquidation_id: string;
  position_id: string;
  attempt: number;
  idempotency_key: string;
  source_signature: string;
  state: EmergencyExitOperationState;
  execution_id: string | null;
  target_signature: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

interface WalletResearchHandoffRow {
  generation: string;
  run_id: string;
  status: WalletResearchHandoffStatus;
  wallets_json: string;
  ready_at: string;
  updated_at: string;
  attempts: number;
  next_attempt_at: string;
  last_error: string | null;
  completed_at: string | null;
  cohort_id: string | null;
}

interface WalletDeepHistoryEvidenceSummaryRow {
  generation_id: string;
  cohort_id: string;
  wallet: string;
  record_json: string;
  evidence_digest: string;
  frozen_at: string;
}

interface ManagedRecoveryPreflightRow {
  id: string;
  policy_version: string;
  week: string;
  window_start: string;
  wallet: string;
  status: ManagedRecoveryPreflightStatus;
  attempts: number;
  next_attempt_at: string;
  pnl30_json: string | null;
  pnl90_json: string | null;
  history_json: string | null;
  reasons_json: string;
  checked_at: string | null;
  expires_at: string | null;
  last_error: string | null;
  updated_at: string;
}

function managedRecoveryPreflightStep(row: ManagedRecoveryPreflightRow): ManagedRecoveryPreflightStep {
  if (row.pnl30_json === null) return "PNL_30D";
  if (row.pnl90_json === null) return "PNL_90D";
  return "HISTORY";
}

function managedRecoveryPreflightFromRow(row: ManagedRecoveryPreflightRow): ManagedRecoveryPreflight {
  return {
    id: row.id,
    policyVersion: row.policy_version,
    week: row.week,
    windowStart: row.window_start,
    wallet: row.wallet,
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    step: managedRecoveryPreflightStep(row),
    ...(row.pnl30_json !== null ? { pnl30d: decode<WalletPnlWindow>(row.pnl30_json) } : {}),
    ...(row.pnl90_json !== null ? { pnl90d: decode<WalletPnlWindow>(row.pnl90_json) } : {}),
    ...(row.history_json !== null ? { history: decode<WalletHistorySummary>(row.history_json) } : {}),
    reasons: decode<string[]>(row.reasons_json),
    ...(row.checked_at !== null ? { checkedAt: row.checked_at } : {}),
    ...(row.expires_at !== null ? { expiresAt: row.expires_at } : {}),
    ...(row.last_error !== null ? { lastError: row.last_error } : {}),
    updatedAt: row.updated_at
  };
}

function managedRecoveryPreflightId(
  policyVersion: string,
  windowStart: string,
  wallet: string
): string {
  return `managed-recovery-preflight-v1:${sha256(encode([
    policyVersion,
    windowStart,
    wallet
  ]))}`;
}

function managedRecoveryClaimToken(row: ManagedRecoveryPreflightRow): string {
  return sha256(encode([
    row.id,
    row.wallet,
    row.policy_version,
    row.window_start,
    row.attempts,
    row.expires_at
  ]));
}

function walletResearchHandoffFromRow(row: WalletResearchHandoffRow): WalletResearchHandoff {
  const handoff: WalletResearchHandoff = {
    generation: row.generation,
    runId: row.run_id,
    status: row.status,
    wallets: decode<string[]>(row.wallets_json),
    readyAt: row.ready_at,
    updatedAt: row.updated_at,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at
  };
  if (row.last_error !== null) handoff.lastError = row.last_error;
  if (row.completed_at !== null) handoff.completedAt = row.completed_at;
  if (row.cohort_id !== null) handoff.cohortId = row.cohort_id;
  return handoff;
}

function walletDeepHistoryEvidenceSummaryFromRow(
  row: WalletDeepHistoryEvidenceSummaryRow
): WalletDeepHistoryEvidenceSummary {
  const record = decode<WalletIndexRecord>(row.record_json);
  if (
    record.wallet !== row.wallet ||
    !/^[a-f0-9]{64}$/u.test(row.evidence_digest) ||
    !Number.isFinite(Date.parse(row.frozen_at))
  ) throw new Error(`Frozen deep-history evidence summary is malformed for ${row.wallet}.`);
  return {
    generationId: row.generation_id,
    cohortId: row.cohort_id,
    wallet: row.wallet,
    record,
    evidenceDigest: row.evidence_digest,
    frozenAt: row.frozen_at
  };
}

function emergencyLiquidationFromRow(row: EmergencyLiquidationRow): EmergencyLiquidationRecord {
  return {
    id: row.id,
    state: row.state,
    reason: row.reason,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
    closedPositions: row.closed_positions,
    failedPositions: row.failed_positions
  };
}

function emergencyOperationFromRow(row: EmergencyExitOperationRow): EmergencyExitOperation {
  return {
    operationId: row.operation_id,
    liquidationId: row.liquidation_id,
    positionId: row.position_id,
    attempt: row.attempt,
    idempotencyKey: row.idempotency_key,
    sourceSignature: row.source_signature,
    state: row.state,
    ...(row.execution_id ? { executionId: row.execution_id } : {}),
    ...(row.target_signature ? { targetSignature: row.target_signature } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export interface LearningOutboxRecord {
  id: number;
  eventKey: string;
  kind: string;
  payload: unknown;
  createdAt: string;
  attempts: number;
  lastError?: string;
}

export class Repository implements ManagedRecoveryPreflightRepository {
  private walletPreScreenSurvivorRevision = 0;
  private readonly walletPreScreenSurvivorCache = new Map<string, readonly string[]>();
  private walletPreScreenSurvivorCacheClearScheduled = false;
  // Snapshot rows are immutable, and this is the expensive half of coverage.
  // Queue counts remain live on every call because their horizon classification
  // depends on the caller's time. Repository writes invalidate this aggregate.
  private solPriceCoverageAggregateCache:
    | {
        readonly count: number;
        readonly oldestAt?: string;
        readonly newestAt?: string;
        readonly largestGapSeconds: number;
      }
    | undefined;

  constructor(readonly db: CopyLabDatabase) {}

  enqueueLearningOutbox(input: {
    eventKey: string;
    kind: string;
    payload: unknown;
    createdAt?: string;
  }): boolean {
    if (!input.eventKey.trim() || !input.kind.trim()) {
      throw new Error("Learning outbox events require a stable key and kind.");
    }
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO learning_outbox(
        event_key, kind, payload_json, created_at, delivered_at, attempts, last_error
      ) VALUES (?, ?, ?, ?, NULL, 0, NULL)
    `).run(input.eventKey, input.kind, encode(input.payload), input.createdAt ?? nowIso());
    return result.changes === 1;
  }

  pendingLearningOutbox(limit = 100): LearningOutboxRecord[] {
    const bounded = Math.max(1, Math.min(1_000, Math.floor(limit)));
    const rows = this.db.prepare(`
      SELECT id, event_key, kind, payload_json, created_at, attempts, last_error
      FROM learning_outbox
      WHERE delivered_at IS NULL
      ORDER BY id
      LIMIT ?
    `).all(bounded) as Array<{
      id: number;
      event_key: string;
      kind: string;
      payload_json: string;
      created_at: string;
      attempts: number;
      last_error: string | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      eventKey: row.event_key,
      kind: row.kind,
      payload: decode<unknown>(row.payload_json),
      createdAt: row.created_at,
      attempts: row.attempts,
      ...(row.last_error ? { lastError: row.last_error } : {})
    }));
  }

  markLearningOutboxDelivered(id: number, deliveredAt = nowIso()): boolean {
    const result = this.db.prepare(`
      UPDATE learning_outbox
      SET delivered_at = ?, attempts = attempts + 1, last_error = NULL
      WHERE id = ? AND delivered_at IS NULL
    `).run(deliveredAt, id);
    return result.changes === 1;
  }

  markLearningOutboxFailed(id: number, reason: string): void {
    this.db.prepare(`
      UPDATE learning_outbox
      SET attempts = attempts + 1, last_error = ?
      WHERE id = ? AND delivered_at IS NULL
    `).run(reason.slice(0, 1_000), id);
  }

  /** Causal cross-lane confirmation only. The cutoff is the market snapshot
   * time, so a later wallet signal can never leak into an earlier feature. */
  hasRecentWalletConfirmedMint(mint: string, capturedAt: string, windowMinutes = 30): boolean {
    const cutoff = Date.parse(capturedAt);
    if (!mint.trim() || !Number.isFinite(cutoff) || !Number.isFinite(windowMinutes) || windowMinutes <= 0) {
      return false;
    }
    const windowStart = new Date(cutoff - windowMinutes * 60_000).toISOString();
    return Boolean(this.db.prepare(`
      SELECT 1
      FROM signal_outcomes
      WHERE mint = ?
        AND action = 'BUY'
        AND status IN ('QUEUED', 'AWAITING_APPROVAL', 'SIMULATED', 'CONFIRMED')
        AND updated_at >= ?
        AND updated_at <= ?
      LIMIT 1
    `).get(mint, windowStart, capturedAt));
  }

  private insertManagedRecoveryPreflightCandidate(input: {
    policyVersion: string;
    windowStart: string;
    readyAt: string;
    wallet?: string;
  }): ManagedRecoveryPreflightRow | undefined {
    const requestedWallet = input.wallet?.trim();
    if (requestedWallet) {
      const existing = this.db.prepare(`
        SELECT * FROM managed_recovery_preflights
        WHERE policy_version = ? AND window_start = ? AND wallet = ?
      `).get(input.policyVersion, input.windowStart, requestedWallet) as
        | ManagedRecoveryPreflightRow
        | undefined;
      if (existing) return existing;
    }
    const selected = this.db.prepare(`
      SELECT wi.wallet
      FROM wallet_index wi
      WHERE wi.prescreen_eligible = 1
        AND COALESCE(json_extract(wi.record_json, '$.deepHistoryStatus'), '') = 'AWAITING'
        AND wi.successful_transaction_count BETWEEN 0 AND 6000
        AND (
          (wi.closed_eligible_swaps > 0 AND wi.median_holding_minutes >= 15)
          OR (wi.closed_eligible_swaps = 0 AND wi.eligible_spot_swap_count >= 10)
          OR (wi.closed_eligible_swaps > 0 AND wi.median_holding_minutes >= 10)
          OR (wi.closed_eligible_swaps = 0 AND wi.eligible_spot_swap_count >= 5)
        )
        AND (? IS NULL OR wi.wallet = ?)
        AND EXISTS (
          SELECT 1
          FROM wallet_deep_history_target_dispositions disposition
          WHERE disposition.wallet = wi.wallet
        )
        AND NOT EXISTS (
          SELECT 1
          FROM wallet_deep_history_evidence evidence
          WHERE evidence.wallet = wi.wallet
        )
        AND NOT EXISTS (
          SELECT 1
          FROM wallet_deep_history_targets target
          JOIN wallet_deep_history_cohorts cohort ON cohort.id = target.cohort_id
          LEFT JOIN wallet_deep_history_managed_cohort_screenings managed
            ON managed.cohort_id = cohort.id
          WHERE target.wallet = wi.wallet
            AND cohort.status = 'OPEN'
            AND managed.cohort_id IS NULL
        )
        AND NOT EXISTS (
          SELECT 1
          FROM managed_recovery_preflights preflight
          WHERE preflight.policy_version = ?
            AND preflight.window_start = ?
            AND preflight.wallet = wi.wallet
        )
      ORDER BY
        wi.successful_transaction_count ASC,
        CASE
          WHEN wi.closed_eligible_swaps > 0 AND wi.median_holding_minutes >= 15 THEN 1
          WHEN wi.closed_eligible_swaps = 0 AND wi.eligible_spot_swap_count >= 10 THEN 2
          WHEN wi.closed_eligible_swaps > 0 AND wi.median_holding_minutes >= 10 THEN 3
          WHEN wi.closed_eligible_swaps = 0 AND wi.eligible_spot_swap_count >= 5 THEN 4
          ELSE 5
        END,
        wi.closed_eligible_swaps DESC,
        wi.eligible_spot_swap_count DESC,
        wi.median_holding_minutes DESC,
        wi.active_weeks DESC,
        wi.history_days DESC,
        wi.wallet
      LIMIT 1
    `).get(
      requestedWallet ?? null,
      requestedWallet ?? null,
      input.policyVersion,
      input.windowStart
    ) as { wallet: string } | undefined;
    if (!selected) return undefined;
    const id = managedRecoveryPreflightId(
      input.policyVersion,
      input.windowStart,
      selected.wallet
    );
    this.db.prepare(`
      INSERT OR IGNORE INTO managed_recovery_preflights(
        id, policy_version, week, window_start, wallet, status, attempts,
        next_attempt_at, pnl30_json, pnl90_json, history_json, reasons_json,
        checked_at, expires_at, last_error, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'READY', 0, ?, NULL, NULL, NULL, '[]', NULL, NULL, NULL, ?)
    `).run(
      id,
      input.policyVersion,
      input.windowStart.slice(0, 10),
      input.windowStart,
      selected.wallet,
      input.readyAt,
      input.readyAt
    );
    return this.db.prepare("SELECT * FROM managed_recovery_preflights WHERE id = ?")
      .get(id) as ManagedRecoveryPreflightRow | undefined;
  }

  private getManagedRecoveryRunningClaim(input: {
    claimToken: string;
    wallet: string;
    policyVersion: string;
    windowStart: string;
    expectedStep: ManagedRecoveryPreflightStep;
  }): ManagedRecoveryPreflightRow | undefined {
    const row = this.db.prepare(`
      SELECT * FROM managed_recovery_preflights
      WHERE wallet = ? AND policy_version = ? AND window_start = ? AND status = 'RUNNING'
    `).get(input.wallet, input.policyVersion, input.windowStart) as
      | ManagedRecoveryPreflightRow
      | undefined;
    if (
      !row ||
      managedRecoveryClaimToken(row) !== input.claimToken ||
      managedRecoveryPreflightStep(row) !== input.expectedStep
    ) return undefined;
    return row;
  }

  private invalidateWalletPreScreenSurvivorCache(): void {
    this.walletPreScreenSurvivorRevision = this.walletPreScreenSurvivorRevision >= Number.MAX_SAFE_INTEGER
      ? 0
      : this.walletPreScreenSurvivorRevision + 1;
    this.walletPreScreenSurvivorCache.clear();
  }

  private scheduleWalletPreScreenSurvivorCacheClear(): void {
    if (this.walletPreScreenSurvivorCacheClearScheduled) return;
    this.walletPreScreenSurvivorCacheClearScheduled = true;
    setImmediate(() => {
      this.walletPreScreenSurvivorCache.clear();
      this.walletPreScreenSurvivorCacheClearScheduled = false;
    });
  }

  getSetting<T>(key: string): T | undefined {
    const row = this.db.prepare("SELECT value_json FROM settings WHERE key = ?").get(key) as
      | { value_json: string }
      | undefined;
    return row ? decode<T>(row.value_json) : undefined;
  }

  setSetting(key: string, value: unknown): void {
    this.db
      .prepare(`
        INSERT INTO settings(key, value_json, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
      `)
      .run(key, encode(value), nowIso());
  }

  getSecretCiphertext(name: string): string | undefined {
    const row = this.db.prepare("SELECT ciphertext FROM secrets WHERE name = ?").get(name) as
      | { ciphertext: string }
      | undefined;
    return row?.ciphertext;
  }

  setSecretCiphertext(name: string, ciphertext: string): void {
    this.db
      .prepare(`
        INSERT INTO secrets(name, ciphertext, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET ciphertext = excluded.ciphertext, updated_at = excluded.updated_at
      `)
      .run(name, ciphertext, nowIso());
  }

  deleteSecret(name: string): boolean {
    if (!name.trim()) throw new Error("Secret name is required.");
    return this.db.prepare("DELETE FROM secrets WHERE name = ?").run(name).changes === 1;
  }

  hasSecret(name: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 AS ok FROM secrets WHERE name = ?").get(name));
  }

  setProviderHealth(health: ProviderHealth): void {
    this.db
      .prepare(`
        INSERT INTO provider_health(provider, health_json, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(provider) DO UPDATE SET health_json = excluded.health_json, updated_at = excluded.updated_at
      `)
      .run(health.provider, encode(health), health.checkedAt);
  }

  listProviderHealth(): ProviderHealth[] {
    const rows = this.db.prepare("SELECT health_json FROM provider_health ORDER BY provider").all() as Array<{
      health_json: string;
    }>;
    return rows.map((row) => decode<ProviderHealth>(row.health_json));
  }

  saveCohort(cohort: DiscoveredWalletSet): void {
    const transaction = this.db.transaction(() => {
      this.db
        .prepare(`
          INSERT INTO cohorts(id, generated_at, frozen, cohort_json) VALUES (?, ?, 1, ?)
          ON CONFLICT(id) DO UPDATE SET cohort_json = excluded.cohort_json
        `)
        .run(cohort.cohortId, cohort.generatedAt, encode(cohort));
      const insert = this.db.prepare(`
        INSERT INTO wallet_candidates(cohort_id, address, candidate_json, active, shadow, updated_at)
        VALUES (?, ?, ?, 0, 1, ?)
        ON CONFLICT(cohort_id, address) DO UPDATE SET candidate_json = excluded.candidate_json, updated_at = excluded.updated_at
      `);
      for (const candidate of cohort.candidates) {
        insert.run(cohort.cohortId, candidate.address, encode(candidate), nowIso());
      }
    });
    transaction();
  }

  latestCohort(): DiscoveredWalletSet | undefined {
    const row = this.db
      .prepare("SELECT cohort_json FROM cohorts ORDER BY generated_at DESC LIMIT 1")
      .get() as { cohort_json: string } | undefined;
    return row ? decode<DiscoveredWalletSet>(row.cohort_json) : undefined;
  }

  listCandidates(cohortId?: string, activeOnly = false): WalletCandidate[] {
    const id = cohortId ?? this.latestCohort()?.cohortId;
    if (!id) return [];
    const sql = `SELECT candidate_json FROM wallet_candidates WHERE cohort_id = ?${activeOnly ? " AND active = 1" : ""} ORDER BY address`;
    const rows = this.db.prepare(sql).all(id) as Array<{ candidate_json: string }>;
    return rows.map((row) => decode<WalletCandidate>(row.candidate_json));
  }

  setActiveWallets(cohortId: string, addresses: string[]): void {
    const wanted = new Set(addresses);
    const transaction = this.db.transaction(() => {
      this.db.prepare("UPDATE wallet_candidates SET active = 0 WHERE cohort_id = ?").run(cohortId);
      const activate = this.db.prepare(
        "UPDATE wallet_candidates SET active = 1, shadow = 0, updated_at = ? WHERE cohort_id = ? AND address = ?"
      );
      for (const address of wanted) activate.run(nowIso(), cohortId, address);
    });
    transaction();
  }

  freezePaperEvaluationCohort(
    sourceCohortId: string,
    addresses: readonly string[],
    initialNavUsd: number,
    frozenAt = nowIso()
  ): { cohort: PaperEvaluationCohort; created: boolean } | undefined {
    const wallets = [...new Set(addresses)].sort();
    if (!Number.isFinite(initialNavUsd) || initialNavUsd <= 0) {
      throw new RangeError("Paper evaluation initial NAV must be positive.");
    }
    return this.db.transaction(() => {
      const current = this.activePaperEvaluationCohort();
      // Discovery may replenish shadow candidates, but it must never rotate an
      // already-frozen evaluation automatically.
      if (current) return { cohort: current, created: false };
      if (wallets.length !== PAPER_EVALUATION_WALLET_COUNT) return undefined;
      const scoreLookup = this.db.prepare(`
        SELECT s.score_json, c.active
        FROM wallet_scores s
        JOIN wallet_candidates c ON c.cohort_id = s.cohort_id AND c.address = s.address
        WHERE s.cohort_id = ? AND s.address = ?
      `);
      const allResearchQualified = wallets.every((wallet) => {
        const row = scoreLookup.get(sourceCohortId, wallet) as {
          score_json: string;
          active: number;
        } | undefined;
        return row ? row.active === 1 && decode<WalletScore>(row.score_json).qualified : false;
      });
      if (!allResearchQualified) return undefined;
      const cohort: PaperEvaluationCohort = {
        id: `paper-evaluation:${randomUUID()}`,
        sourceCohortId,
        frozenAt,
        initialNavUsd,
        wallets,
        status: "ACTIVE"
      };
      this.db.prepare(`
        INSERT INTO paper_evaluation_cohorts(
          id, source_cohort_id, frozen_at, initial_nav_usd, wallets_json, status, superseded_at
        ) VALUES (?, ?, ?, ?, ?, 'ACTIVE', NULL)
      `).run(cohort.id, sourceCohortId, frozenAt, initialNavUsd, encode(wallets));
      return { cohort, created: true };
    })();
  }

  activePaperEvaluationCohort(): PaperEvaluationCohort | undefined {
    const row = this.db.prepare(`
      SELECT id, source_cohort_id, frozen_at, initial_nav_usd, wallets_json, status, superseded_at
      FROM paper_evaluation_cohorts WHERE status = 'ACTIVE' LIMIT 1
    `).get() as {
      id: string;
      source_cohort_id: string;
      frozen_at: string;
      initial_nav_usd: number;
      wallets_json: string;
      status: "ACTIVE" | "SUPERSEDED";
      superseded_at: string | null;
    } | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      sourceCohortId: row.source_cohort_id,
      frozenAt: row.frozen_at,
      initialNavUsd: row.initial_nav_usd,
      wallets: decode<string[]>(row.wallets_json),
      status: row.status,
      ...(row.superseded_at ? { supersededAt: row.superseded_at } : {})
    };
  }

  recordPaperRuntimeHeartbeat(evaluationCohortId: string, observedAt = nowIso()): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO paper_runtime_heartbeats(evaluation_cohort_id, observed_at)
      VALUES (?, ?)
    `).run(evaluationCohortId, observedAt);
  }

  listPaperRuntimeHeartbeats(evaluationCohortId: string): string[] {
    return (this.db.prepare(`
      SELECT observed_at FROM paper_runtime_heartbeats
      WHERE evaluation_cohort_id = ? ORDER BY observed_at
    `).all(evaluationCohortId) as Array<{ observed_at: string }>).map((row) => row.observed_at);
  }

  saveWalletScore(cohortId: string, score: WalletScore): void {
    this.db
      .prepare(`
        INSERT INTO wallet_scores(cohort_id, address, score_json, calculated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(cohort_id, address) DO UPDATE SET score_json = excluded.score_json, calculated_at = excluded.calculated_at
      `)
      .run(cohortId, score.wallet, encode(score), score.calculatedAt);
  }

  listWalletScores(cohortId?: string): WalletScore[] {
    const id = cohortId ?? this.latestCohort()?.cohortId;
    if (!id) return [];
    const rows = this.db
      .prepare("SELECT score_json FROM wallet_scores WHERE cohort_id = ? ORDER BY calculated_at DESC")
      .all(id) as Array<{ score_json: string }>;
    return rows.map((row) => decode<WalletScore>(row.score_json));
  }

  /**
   * Returns whether this wallet already completed the durable local-evidence
   * -> provider-qualification handoff. A provider leaderboard score alone is
   * deliberately insufficient: its first exact local structural pass can
   * still correct or upgrade that provider-only result. Explicit scheduled
   * provider rescoring intentionally does not use this local-pipeline fence.
   */
  hasCompletedLocalProviderQualification(wallet: string): boolean {
    const row = this.db.prepare(`
      SELECT 1
      FROM wallet_research_handoffs handoff
      JOIN json_each(handoff.wallets_json) handed
      WHERE handoff.status = 'COMPLETE'
        AND handed.value = ?
      LIMIT 1
    `).get(wallet) as { 1: number } | undefined;
    return row !== undefined;
  }

  /**
   * Materializes the completed local-provider fence once for callers that
   * need to test a batch of wallets. This preserves the all-history semantics
   * of hasCompletedLocalProviderQualification without repeating json_each for
   * every evidence row.
   */
  listCompletedLocalProviderQualificationWallets(): string[] {
    const rows = this.db.prepare(`
      SELECT DISTINCT CAST(handed.value AS TEXT) AS wallet
      FROM wallet_research_handoffs handoff
      JOIN json_each(handoff.wallets_json) handed
      WHERE handoff.status = 'COMPLETE' AND handed.type = 'text'
      ORDER BY wallet
    `).all() as Array<{ wallet: string }>;
    return rows.map((row) => row.wallet);
  }

  enqueueWalletIndexTransactions(items: WalletIndexEnqueueItem[]): WalletIndexEnqueueResult {
    if (items.length === 0) {
      return { observations: 0, enqueued: 0, deduplicated: 0, sourcesAdded: 0 };
    }
    const insertQueue = this.db.prepare(`
      INSERT INTO index_signature_queue(
        signature, slot, block_time, status, attempts, priority,
        discovered_at, available_at, updated_at
      ) VALUES (?, ?, ?, 'PENDING', 0, ?, ?, ?, ?)
      ON CONFLICT(signature) DO NOTHING
    `);
    const refreshQueue = this.db.prepare(`
      UPDATE index_signature_queue SET
        slot = COALESCE(slot, ?),
        block_time = COALESCE(block_time, ?),
        priority = MAX(priority, ?),
        updated_at = MAX(updated_at, ?)
      WHERE signature = ?
    `);
    const insertSource = this.db.prepare(`
      INSERT OR IGNORE INTO index_signature_sources(
        signature, source_address, wallet, source, first_seen_at, last_seen_at,
        discovery_count, first_run_id, last_run_id, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
    `);
    const refreshSource = this.db.prepare(`
      UPDATE index_signature_sources SET
        last_seen_at = MAX(last_seen_at, ?),
        discovery_count = discovery_count + 1,
        last_run_id = COALESCE(?, last_run_id),
        metadata_json = COALESCE(?, metadata_json)
      WHERE signature = ? AND source_address = ? AND wallet = ? AND source = ?
    `);
    const insertDeepHistorySignature = this.db.prepare(`
      INSERT OR IGNORE INTO wallet_deep_history_signatures(
        cohort_id, generation_id, wallet, signature, block_time, discovered_at
      )
      SELECT cohort.id, cohort.generation_id, ?, ?, ?, ?
      FROM wallet_deep_history_cohorts cohort
      WHERE cohort.id = ?
    `);

    return this.db.transaction(() => {
      let enqueued = 0;
      let sourcesAdded = 0;
      for (const item of items) {
        if (!item.signature.trim()) throw new Error("Wallet index signature is required.");
        if (!item.sourceAddress.trim()) throw new Error("Wallet index source address is required.");
        if (!item.source.trim()) throw new Error("Wallet index source name is required.");
        const discoveredAt = item.discoveredAt ?? nowIso();
        const priority = item.priority ?? 0;
        const queueResult = insertQueue.run(
          item.signature,
          item.slot ?? null,
          item.blockTime ?? null,
          priority,
          discoveredAt,
          discoveredAt,
          discoveredAt
        );
        if (queueResult.changes === 1) enqueued += 1;
        else {
          refreshQueue.run(
            item.slot ?? null,
            item.blockTime ?? null,
            priority,
            discoveredAt,
            item.signature
          );
        }

        const metadata = item.metadata === undefined ? null : encode(item.metadata);
        const sourceResult = insertSource.run(
          item.signature,
          item.sourceAddress,
          item.wallet ?? "",
          item.source,
          discoveredAt,
          discoveredAt,
          item.runId ?? null,
          item.runId ?? null,
          metadata
        );
        if (sourceResult.changes === 1) sourcesAdded += 1;
        else {
          refreshSource.run(
            discoveredAt,
            item.runId ?? null,
            metadata,
            item.signature,
            item.sourceAddress,
            item.wallet ?? "",
            item.source
          );
        }
        if (item.source === "helius-wallet-deep-history") {
          const cohortId = item.metadata?.cohortId;
          if (typeof cohortId !== "string" || !cohortId.trim() || !item.wallet?.trim()) {
            throw new Error("Deep-history source requires an exact cohort and wallet manifest.");
          }
          const manifest = insertDeepHistorySignature.run(
            item.wallet,
            item.signature,
            item.blockTime ?? null,
            discoveredAt,
            cohortId
          );
          if (manifest.changes !== 1) {
            const exists = this.db.prepare(`
              SELECT 1 FROM wallet_deep_history_signatures
              WHERE cohort_id = ? AND wallet = ? AND signature = ?
            `).get(cohortId, item.wallet, item.signature);
            if (!exists) throw new Error("Deep-history source cohort does not exist.");
          }
        }
      }
      return {
        observations: items.length,
        enqueued,
        deduplicated: items.length - enqueued,
        sourcesAdded
      };
    })();
  }

  listWalletIndexTransactionSources(signature: string): WalletIndexTransactionSource[] {
    const rows = this.db.prepare(`
      SELECT signature, source_address, wallet, source, first_seen_at, last_seen_at, last_run_id, metadata_json
      FROM index_signature_sources
      WHERE signature = ?
      ORDER BY wallet, source
    `).all(signature) as Array<{
      signature: string;
      source_address: string;
      wallet: string;
      source: string;
      first_seen_at: string;
      last_seen_at: string;
      last_run_id: string | null;
      metadata_json: string | null;
    }>;
    return rows.map((row) => {
      const source: WalletIndexTransactionSource = {
        signature: row.signature,
        sourceAddress: row.source_address,
        source: row.source,
        discoveredAt: row.first_seen_at
      };
      if (row.wallet !== "") source.wallet = row.wallet;
      if (row.last_run_id !== null) source.runId = row.last_run_id;
      if (row.metadata_json !== null) source.metadata = decode<Record<string, unknown>>(row.metadata_json);
      return source;
    });
  }

  /**
   * Saves an immutable analytics attribution beside the original program
   * source. INSERT OR IGNORE makes restarts and transaction replays harmless.
   */
  recordWalletDiscoveryAttribution(input: WalletDiscoveryAttributionInput): boolean {
    if (!input.signature.trim() || !input.programId.trim() || !input.source.trim()) {
      throw new Error("Wallet discovery attribution identifiers are required.");
    }
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO index_signature_sources(
        signature, source_address, wallet, source, first_seen_at, last_seen_at,
        discovery_count, first_run_id, last_run_id, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, 1, NULL, NULL, ?)
    `).run(
      input.signature,
      input.programId,
      input.wallet ?? "",
      input.source,
      input.observedAt,
      input.observedAt,
      encode(input.metadata)
    );
    if (
      input.source === "local-coarse-signer-accepted" ||
      input.source === "local-coarse-signer-rejected" ||
      input.source === "local-exact-swap-attribution"
    ) {
      this.db.prepare(`
        UPDATE coarse_wallet_candidate_transactions
        SET classified = 1
        WHERE signature = ? AND program_id = ?
      `).run(input.signature, input.programId);
    }
    return result.changes === 1;
  }

  /**
   * Returns one not-yet-classified transaction per fee payer. Ranking is based
   * only on successful program observations already in SQLite; raw bytes are
   * fetched and revalidated by the caller before a wallet can be admitted.
   */
  listCoarseWalletBootstrapCandidates(
    programIds: readonly string[],
    attributionSources: readonly string[],
    limit = 25
  ): CoarseWalletBootstrapCandidate[] {
    const programs = [...new Set(programIds.filter((value) => value.trim()))];
    const sources = [...new Set(attributionSources.filter((value) => value.trim()))];
    const boundedLimit = Math.max(0, Math.min(250, Math.trunc(limit)));
    if (programs.length === 0 || sources.length === 0 || boundedLimit === 0) return [];
    const programPlaceholders = programs.map(() => "?").join(", ");
    const rankedWallets = this.db.prepare(`
      WITH wallet_activity AS (
        SELECT
          activity.wallet,
          SUM(activity.observed_successful_transactions) AS observed_successful_transactions,
          MAX(activity.latest_observed_at) AS latest_unseen_sort_time
        FROM coarse_wallet_candidate_activity activity
        LEFT JOIN wallet_index indexed_wallet ON indexed_wallet.wallet = activity.wallet
        WHERE activity.program_id IN (${programPlaceholders})
          AND indexed_wallet.wallet IS NULL
          AND EXISTS (
            SELECT 1
            FROM coarse_wallet_candidate_transactions candidate
            WHERE candidate.wallet = activity.wallet
              AND candidate.program_id = activity.program_id
              AND candidate.classified = 0
          )
        GROUP BY activity.wallet
      )
      SELECT wallet, observed_successful_transactions
      FROM wallet_activity
      ORDER BY observed_successful_transactions DESC, latest_unseen_sort_time DESC, wallet
      LIMIT ?
    `).all(...programs, boundedLimit) as Array<{
      wallet: string;
      observed_successful_transactions: number;
    }>;
    const newestUnseen = this.db.prepare(`
      SELECT
        candidate.signature,
        candidate.wallet,
        candidate.program_id,
        candidate.slot,
        candidate.block_time
      FROM coarse_wallet_candidate_transactions candidate
      WHERE candidate.program_id IN (${programPlaceholders})
        AND candidate.wallet = ?
        AND candidate.classified = 0
      ORDER BY candidate.block_time DESC, candidate.signature, candidate.program_id
      LIMIT 1
    `);
    return rankedWallets.flatMap((ranked) => {
      const row = newestUnseen.get(...programs, ranked.wallet) as {
        signature: string;
        wallet: string;
        program_id: string;
        slot: number | null;
        block_time: string | null;
      } | undefined;
      if (!row) return [];
      return [{
        signature: row.signature,
        wallet: row.wallet,
        programId: row.program_id,
        observedSuccessfulTransactions: ranked.observed_successful_transactions,
        ...(row.slot !== null ? { slot: row.slot } : {}),
        ...(row.block_time !== null ? { blockTime: row.block_time } : {})
      }];
    });
  }

  getWalletIndexTransaction(signature: string): WalletIndexTransaction | undefined {
    const row = this.db.prepare(`
      SELECT q.*,
             t.success, t.fee_payer, t.account_keys_json, t.program_ids_json,
             t.transaction_json, t.indexed_at
      FROM index_signature_queue q
      LEFT JOIN indexed_transactions t ON t.signature = q.signature
      WHERE q.signature = ?
    `).get(signature) as WalletIndexQueueRow | undefined;
    if (!row) return undefined;
    return this.decodeWalletIndexTransaction(row);
  }

  private decodeWalletIndexTransaction(row: WalletIndexQueueRow): WalletIndexTransaction {
    const hydrated = row.transaction_json
      ? decode<Partial<WalletIndexTransaction>>(row.transaction_json)
      : undefined;
    const sourceWallets = this.db
      .prepare("SELECT DISTINCT wallet FROM index_signature_sources WHERE signature = ? AND wallet <> '' ORDER BY wallet")
      .all(row.signature) as Array<{ wallet: string }>;
    const transaction: WalletIndexTransaction = {
      signature: row.signature,
      status: row.status,
      attempts: row.attempts,
      priority: row.priority,
      discoveredAt: row.discovered_at,
      availableAt: row.available_at,
      updatedAt: row.updated_at,
      sourceWallets: sourceWallets.map((source) => source.wallet)
    };
    if (row.slot !== null) transaction.slot = row.slot;
    if (row.block_time !== null) transaction.blockTime = row.block_time;
    if (row.success !== null) transaction.success = row.success === 1;
    if (row.fee_payer !== null) transaction.feePayer = row.fee_payer;
    if (row.account_keys_json !== null) transaction.accountKeys = decode<string[]>(row.account_keys_json);
    if (row.program_ids_json !== null) transaction.programIds = decode<string[]>(row.program_ids_json);
    if (row.lease_owner !== null) transaction.leaseOwner = row.lease_owner;
    if (row.lease_token !== null) transaction.leaseToken = row.lease_token;
    if (row.leased_at !== null) transaction.leasedAt = row.leased_at;
    if (row.lease_expires_at !== null) transaction.leaseExpiresAt = row.lease_expires_at;
    if (row.last_error !== null) transaction.lastError = row.last_error;
    if (row.indexed_at !== null) transaction.indexedAt = row.indexed_at;
    if (row.processed_at !== null) transaction.processedAt = row.processed_at;
    if (hydrated?.transactionVersion !== undefined) transaction.transactionVersion = hydrated.transactionVersion;
    if (hydrated?.raw !== undefined) transaction.raw = hydrated.raw;
    return transaction;
  }

  requeueExpiredWalletIndexLeases(at = new Date()): number {
    const timestamp = at.toISOString();
    return this.db.prepare(`
      UPDATE index_signature_queue SET
        status = 'RETRY',
        available_at = ?,
        lease_owner = NULL,
        lease_token = NULL,
        leased_at = NULL,
        lease_expires_at = NULL,
        last_error = COALESCE(last_error, 'Lease expired before acknowledgement.'),
        updated_at = ?
      WHERE status = 'LEASED' AND lease_expires_at <= ?
    `).run(timestamp, timestamp, timestamp).changes;
  }

  /**
   * Recovers items that were exhausted while probing JSON-RPC transaction
   * batching on an account tier that does not support it. The worker disables
   * batching before these items become leaseable again, so they resume through
   * the ordinary single-request path without losing their signatures.
   */
  recoverWalletIndexBatchFallbackFailures(at = new Date()): number {
    const timestamp = at.toISOString();
    return this.db.prepare(`
      UPDATE index_signature_queue SET
        status = 'RETRY',
        attempts = 0,
        available_at = ?,
        lease_owner = NULL,
        lease_token = NULL,
        leased_at = NULL,
        lease_expires_at = NULL,
        last_error = 'Recovered after Helius batch capability fallback.',
        updated_at = ?
      WHERE status IN ('RETRY', 'FAILED')
        AND (
          last_error LIKE '%Batch requests are only available for paid plans%'
          OR last_error LIKE '%returned HTTP 413%'
        )
    `).run(timestamp, timestamp).changes;
  }

  leaseWalletIndexTransactions(
    workerId: string,
    limit = 100,
    leaseDurationSeconds = 60,
    at = new Date()
  ): WalletIndexTransaction[] {
    if (!workerId.trim()) throw new Error("Wallet index worker id is required.");
    const boundedLimit = Math.max(0, Math.min(1_000, Math.trunc(limit)));
    if (boundedLimit === 0) return [];
    if (!Number.isFinite(leaseDurationSeconds) || leaseDurationSeconds <= 0) {
      throw new Error("Wallet index lease duration must be positive.");
    }
    const leasedAt = at.toISOString();
    const leaseExpiresAt = new Date(at.getTime() + leaseDurationSeconds * 1_000).toISOString();
    return this.db.transaction(() => {
      this.requeueExpiredWalletIndexLeases(at);
      const ready = this.db.prepare(`
        SELECT signature
        FROM index_signature_queue
        WHERE status IN ('PENDING', 'RETRY') AND available_at <= ?
        ORDER BY
          priority DESC,
          CASE WHEN slot IS NULL THEN 1 ELSE 0 END,
          slot DESC,
          discovered_at,
          signature
        LIMIT ?
      `).all(leasedAt, boundedLimit) as Array<{ signature: string }>;
      const leased: WalletIndexTransaction[] = [];
      const claim = this.db.prepare(`
        UPDATE index_signature_queue SET
          status = 'LEASED',
          attempts = attempts + 1,
          lease_owner = ?,
          lease_token = ?,
          leased_at = ?,
          lease_expires_at = ?,
          updated_at = ?
        WHERE signature = ? AND status IN ('PENDING', 'RETRY') AND available_at <= ?
      `);
      for (const row of ready) {
        const leaseToken = randomUUID();
        const result = claim.run(
          workerId,
          leaseToken,
          leasedAt,
          leaseExpiresAt,
          leasedAt,
          row.signature,
          leasedAt
        );
        if (result.changes !== 1) continue;
        const transaction = this.getWalletIndexTransaction(row.signature);
        if (transaction) leased.push(transaction);
      }
      return leased;
    })();
  }

  completeWalletIndexTransaction(
    transaction: WalletIndexTransaction,
    swaps: IndexedSpotSwap[],
    leaseToken: string,
    at = new Date(),
    identityEvidence: readonly WalletIdentityTransactionEvidenceRecord[] = []
  ): boolean {
    const completedAt = at.toISOString();
    return this.db.transaction(() => {
      const identityWallets = new Set<string>();
      for (const evidence of identityEvidence) {
        if (
          evidence.signature !== transaction.signature ||
          evidence.slot !== transaction.slot ||
          evidence.blockTime !== transaction.blockTime ||
          evidence.success !== transaction.success ||
          identityWallets.has(evidence.wallet)
        ) {
          throw new Error("Wallet identity evidence does not match its leased transaction.");
        }
        identityWallets.add(evidence.wallet);
      }
      const persistIdentityEvidence = (): void => {
        if (identityEvidence.length === 0) return;
        const hasDeepHistorySource = this.db.prepare(`
          SELECT 1 FROM index_signature_sources
          WHERE signature = ? AND wallet = ? AND source = 'helius-wallet-deep-history'
        `);
        const insert = this.db.prepare(`
          INSERT INTO wallet_identity_transaction_evidence(
            wallet, signature, block_time, evidence_json, indexed_at
          ) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(wallet, signature) DO UPDATE SET
            block_time = excluded.block_time,
            evidence_json = excluded.evidence_json,
            indexed_at = excluded.indexed_at
          WHERE excluded.indexed_at >= wallet_identity_transaction_evidence.indexed_at
        `);
        for (const evidence of identityEvidence) {
          if (!hasDeepHistorySource.get(evidence.signature, evidence.wallet)) {
            throw new Error("Wallet identity evidence has no matching deep-history source link.");
          }
          insert.run(evidence.wallet, evidence.signature, evidence.blockTime, encode(evidence), completedAt);
        }
      };
      const queue = this.db
        .prepare("SELECT status, lease_token FROM index_signature_queue WHERE signature = ?")
        .get(transaction.signature) as { status: WalletIndexQueueStatus; lease_token: string | null } | undefined;
      if (!queue) return false;
      if (queue.status === "PROCESSED") {
        const exists = Boolean(
          this.db.prepare("SELECT 1 FROM indexed_transactions WHERE signature = ?").get(transaction.signature)
        );
        if (exists) persistIdentityEvidence();
        return exists;
      }
      if (queue.status !== "LEASED" || queue.lease_token !== leaseToken) return false;
      for (const swap of swaps) {
        if (swap.signature !== transaction.signature) {
          throw new Error("Indexed swap signature does not match its leased transaction.");
        }
      }
      const persisted: WalletIndexTransaction = {
        ...transaction,
        status: "PROCESSED",
        sourceWallets: transaction.sourceWallets,
        updatedAt: completedAt,
        indexedAt: transaction.indexedAt ?? completedAt,
        processedAt: completedAt
      };
      this.db.prepare(`
        INSERT INTO indexed_transactions(
          signature, slot, block_time, success, fee_payer, source_wallets_json,
          account_keys_json, program_ids_json, transaction_json, indexed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(signature) DO UPDATE SET
          slot = excluded.slot,
          block_time = excluded.block_time,
          success = excluded.success,
          fee_payer = excluded.fee_payer,
          source_wallets_json = excluded.source_wallets_json,
          account_keys_json = excluded.account_keys_json,
          program_ids_json = excluded.program_ids_json,
          transaction_json = excluded.transaction_json,
          indexed_at = excluded.indexed_at
      `).run(
        persisted.signature,
        persisted.slot ?? null,
        persisted.blockTime ?? null,
        persisted.success === undefined ? null : persisted.success ? 1 : 0,
        persisted.feePayer ?? null,
        encode(persisted.sourceWallets),
        persisted.accountKeys === undefined ? null : encode(persisted.accountKeys),
        persisted.programIds === undefined ? null : encode(persisted.programIds),
        encode(persisted),
        persisted.indexedAt
      );
      if (persisted.success && persisted.feePayer) {
        const programSources = this.db.prepare(`
          SELECT DISTINCT source_address
          FROM index_signature_sources
          WHERE signature = ?
            AND source IN ('helius-program-signature', 'helius-program-head')
          ORDER BY source_address
        `).all(persisted.signature) as Array<{ source_address: string }>;
        const insertCandidate = this.db.prepare(`
          INSERT OR IGNORE INTO coarse_wallet_candidate_transactions(
            signature, program_id, wallet, slot, block_time, observed_at, classified
          ) VALUES (?, ?, ?, ?, ?, ?, 0)
        `);
        const upsertActivity = this.db.prepare(`
          INSERT INTO coarse_wallet_candidate_activity(
            wallet, program_id, observed_successful_transactions, latest_observed_at
          ) VALUES (?, ?, 1, ?)
          ON CONFLICT(wallet, program_id) DO UPDATE SET
            observed_successful_transactions =
              coarse_wallet_candidate_activity.observed_successful_transactions + 1,
            latest_observed_at = MAX(
              coarse_wallet_candidate_activity.latest_observed_at,
              excluded.latest_observed_at
            )
        `);
        const observedAt = persisted.blockTime ?? persisted.indexedAt ?? completedAt;
        for (const source of programSources) {
          const inserted = insertCandidate.run(
            persisted.signature,
            source.source_address,
            persisted.feePayer,
            persisted.slot ?? null,
            persisted.blockTime ?? null,
            observedAt
          );
          if (inserted.changes === 1) {
            upsertActivity.run(persisted.feePayer, source.source_address, observedAt);
          }
        }
      }
      persistIdentityEvidence();
      this.db.prepare("DELETE FROM indexed_spot_swaps WHERE signature = ?").run(persisted.signature);
      const insertSwap = this.db.prepare(`
        INSERT INTO indexed_spot_swaps(
          id, signature, wallet, swap_index, slot, block_time, side, base_mint,
          target_mint, input_mint, output_mint, input_amount_atomic,
          output_amount_atomic, eligible, closes_position, holding_minutes,
          realized_pnl_usd, swap_json, indexed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const enqueueReprice = this.db.prepare(`
        INSERT OR IGNORE INTO indexed_swap_reprice_queue(
          swap_id, status, attempts, available_at, last_error, updated_at
        ) VALUES (?, 'PENDING', 0, ?, NULL, ?)
      `);
      for (const swap of swaps) {
        insertSwap.run(
          swap.id,
          swap.signature,
          swap.wallet,
          swap.swapIndex,
          swap.slot,
          swap.blockTime,
          swap.side,
          swap.baseMint,
          swap.targetMint,
          swap.inputMint,
          swap.outputMint,
          swap.inputAmountAtomic,
          swap.outputAmountAtomic,
          swap.eligible ? 1 : 0,
          swap.closesPosition ? 1 : 0,
          swap.holdingMinutes ?? null,
          swap.realizedPnlUsd ?? null,
          encode(swap),
          swap.indexedAt
        );
        if (
          swap.baseMint === SOL_MINT &&
          (swap.priceUsd === undefined || !Number.isFinite(swap.priceUsd) || swap.priceUsd <= 0)
        ) {
          enqueueReprice.run(swap.id, completedAt, completedAt);
        }
      }
      const markDirty = this.db.prepare(`
        INSERT INTO wallet_index_dirty(wallet, marked_at, last_signature)
        VALUES (?, ?, ?)
        ON CONFLICT(wallet) DO UPDATE SET
          marked_at = excluded.marked_at,
          last_signature = excluded.last_signature
      `);
      for (const wallet of new Set(swaps.map((swap) => swap.wallet))) {
        markDirty.run(wallet, completedAt, persisted.signature);
      }
      const changed = this.db.prepare(`
        UPDATE index_signature_queue SET
          slot = COALESCE(?, slot),
          block_time = COALESCE(?, block_time),
          status = 'PROCESSED',
          processed_at = ?,
          lease_owner = NULL,
          lease_token = NULL,
          leased_at = NULL,
          lease_expires_at = NULL,
          last_error = NULL,
          updated_at = ?
        WHERE signature = ? AND status = 'LEASED' AND lease_token = ?
      `).run(
        transaction.slot ?? null,
        transaction.blockTime ?? null,
        completedAt,
        completedAt,
        transaction.signature,
        leaseToken
      );
      return changed.changes === 1;
    })();
  }

  retryWalletIndexTransaction(
    signature: string,
    leaseToken: string,
    error: string,
    retryDelayMs = 1_000,
    maxAttempts = 5,
    at = new Date()
  ): WalletIndexQueueStatus | undefined {
    const timestamp = at.toISOString();
    const row = this.db.prepare(`
      SELECT attempts FROM index_signature_queue
      WHERE signature = ? AND status = 'LEASED' AND lease_token = ?
    `).get(signature, leaseToken) as { attempts: number } | undefined;
    if (!row) return undefined;
    const status: WalletIndexQueueStatus = row.attempts >= maxAttempts ? "FAILED" : "RETRY";
    const availableAt = new Date(at.getTime() + Math.max(0, retryDelayMs)).toISOString();
    const result = this.db.prepare(`
      UPDATE index_signature_queue SET
        status = ?,
        available_at = ?,
        lease_owner = NULL,
        lease_token = NULL,
        leased_at = NULL,
        lease_expires_at = NULL,
        last_error = ?,
        updated_at = ?
      WHERE signature = ? AND status = 'LEASED' AND lease_token = ?
    `).run(status, availableAt, error.slice(0, 4_000), timestamp, signature, leaseToken);
    return result.changes === 1 ? status : undefined;
  }

  saveWalletIndexCheckpoint(checkpoint: WalletIndexCheckpoint): void {
    this.db.prepare(`
      INSERT INTO ingestion_checkpoints(pipeline, partition_key, cursor_json, completed, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(pipeline, partition_key) DO UPDATE SET
        cursor_json = excluded.cursor_json,
        completed = excluded.completed,
        updated_at = excluded.updated_at
      WHERE excluded.updated_at >= ingestion_checkpoints.updated_at
    `).run(
      checkpoint.pipeline,
      checkpoint.partition,
      encode(checkpoint),
      checkpoint.completed ? 1 : 0,
      checkpoint.updatedAt
    );
  }

  getWalletIndexCheckpoint(pipeline: string, partition: string): WalletIndexCheckpoint | undefined {
    const row = this.db.prepare(`
      SELECT cursor_json FROM ingestion_checkpoints WHERE pipeline = ? AND partition_key = ?
    `).get(pipeline, partition) as { cursor_json: string } | undefined;
    return row ? decode<WalletIndexCheckpoint>(row.cursor_json) : undefined;
  }

  listWalletIndexCheckpoints(pipeline?: string): WalletIndexCheckpoint[] {
    const rows = pipeline
      ? this.db.prepare(`
          SELECT cursor_json FROM ingestion_checkpoints WHERE pipeline = ? ORDER BY partition_key
        `).all(pipeline)
      : this.db.prepare(`
          SELECT cursor_json FROM ingestion_checkpoints ORDER BY pipeline, partition_key
        `).all();
    return (rows as Array<{ cursor_json: string }>).map((row) => decode<WalletIndexCheckpoint>(row.cursor_json));
  }

  upsertWalletIndexRecords(records: WalletIndexRecord[]): void {
    const statement = this.db.prepare(`
      INSERT INTO wallet_index(
        wallet, first_seen_at, last_seen_at, history_days, transaction_count,
        successful_transaction_count, spot_swap_count, eligible_spot_swap_count,
        closed_eligible_swaps, buy_count, sell_count, active_days, active_weeks,
        distinct_mints, median_holding_minutes, prescreen_eligible, record_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(wallet) DO UPDATE SET
        first_seen_at = excluded.first_seen_at,
        last_seen_at = excluded.last_seen_at,
        history_days = excluded.history_days,
        transaction_count = excluded.transaction_count,
        successful_transaction_count = excluded.successful_transaction_count,
        spot_swap_count = excluded.spot_swap_count,
        eligible_spot_swap_count = excluded.eligible_spot_swap_count,
        closed_eligible_swaps = excluded.closed_eligible_swaps,
        buy_count = excluded.buy_count,
        sell_count = excluded.sell_count,
        active_days = excluded.active_days,
        active_weeks = excluded.active_weeks,
        distinct_mints = excluded.distinct_mints,
        median_holding_minutes = excluded.median_holding_minutes,
        prescreen_eligible = excluded.prescreen_eligible,
        record_json = excluded.record_json,
        updated_at = excluded.updated_at
      WHERE excluded.updated_at >= wallet_index.updated_at
    `);
    const changed = this.db.transaction(() => {
      let changed = false;
      for (const record of records) {
        const result = statement.run(
          record.wallet,
          record.firstSeenAt,
          record.lastSeenAt,
          record.historyDays,
          record.transactionCount,
          record.successfulTransactionCount,
          record.spotSwapCount,
          record.eligibleSpotSwapCount,
          record.closedEligibleSwaps,
          record.buyCount,
          record.sellCount,
          record.activeDays,
          record.activeWeeks,
          record.distinctMints,
          record.medianHoldingMinutes,
          record.preScreenEligible ? 1 : 0,
          encode(record),
          record.updatedAt
        );
        if (result.changes > 0) changed = true;
      }
      return changed;
    })();
    if (changed) this.invalidateWalletPreScreenSurvivorCache();
  }

  upsertWalletIndexRecord(record: WalletIndexRecord): void {
    this.upsertWalletIndexRecords([record]);
  }

  getWalletIndexRecord(wallet: string): WalletIndexRecord | undefined {
    const row = this.db.prepare("SELECT record_json FROM wallet_index WHERE wallet = ?").get(wallet) as
      | { record_json: string }
      | undefined;
    return row ? decode<WalletIndexRecord>(row.record_json) : undefined;
  }

  listWalletIndexRecords(limit = 1_000, preScreenEligible?: boolean): WalletIndexRecord[] {
    const boundedLimit = Math.max(0, Math.min(100_000, Math.trunc(limit)));
    const rows = preScreenEligible === undefined
      ? this.db.prepare(`
          SELECT record_json FROM wallet_index
          ORDER BY closed_eligible_swaps DESC, history_days DESC, wallet LIMIT ?
        `).all(boundedLimit)
      : this.db.prepare(`
          SELECT record_json FROM wallet_index WHERE prescreen_eligible = ?
          ORDER BY closed_eligible_swaps DESC, history_days DESC, wallet LIMIT ?
        `).all(preScreenEligible ? 1 : 0, boundedLimit);
    return (rows as Array<{ record_json: string }>).map((row) => decode<WalletIndexRecord>(row.record_json));
  }

  listWalletsAwaitingPreScreen(limit = 100): WalletIndexRecord[] {
    const boundedLimit = Math.max(0, Math.min(10_000, Math.trunc(limit)));
    const rows = this.db.prepare(`
      SELECT wi.record_json
      FROM wallet_index wi
      WHERE NOT EXISTS (
        SELECT 1 FROM wallet_prescreen_snapshots wps WHERE wps.wallet = wi.wallet
      )
      ORDER BY wi.updated_at, wi.wallet
      LIMIT ?
    `).all(boundedLimit) as Array<{ record_json: string }>;
    return rows.map((row) => decode<WalletIndexRecord>(row.record_json));
  }

  pageWalletIndexRecords(options: WalletIndexResearchPageOptions): {
    items: WalletIndexRecord[];
    total: number;
  } {
    const page = Math.max(1, Math.trunc(options.page));
    const pageSize = Math.max(1, Math.min(100, Math.trunc(options.pageSize)));
    const where = {
      ALL: "1 = 1",
      PRESCREEN_READY: "wi.prescreen_eligible = 1",
      PRESCREEN_REJECTED: `
        wi.prescreen_eligible = 0 AND EXISTS (
          SELECT 1 FROM wallet_prescreen_snapshots wps WHERE wps.wallet = wi.wallet
        )
      `,
      AWAITING_PRESCREEN: `
        NOT EXISTS (
          SELECT 1 FROM wallet_prescreen_snapshots wps WHERE wps.wallet = wi.wallet
        )
      `
    } satisfies Record<WalletResearchFilter, string>;
    const order = {
      CLOSED_SWAPS: "wi.closed_eligible_swaps DESC, wi.history_days DESC, wi.wallet",
      HISTORY: "wi.history_days DESC, wi.closed_eligible_swaps DESC, wi.wallet",
      ACTIVITY: "wi.active_weeks DESC, wi.successful_transaction_count DESC, wi.wallet",
      RECENT: "wi.last_seen_at DESC, wi.wallet"
    } satisfies Record<WalletResearchSort, string>;
    const predicate = where[options.filter];
    const ordering = order[options.sort];
    const total = (this.db.prepare(`
      SELECT COUNT(*) AS count FROM wallet_index wi WHERE ${predicate}
    `).get() as { count: number }).count;
    const rows = this.db.prepare(`
      SELECT wi.record_json FROM wallet_index wi
      WHERE ${predicate}
      ORDER BY ${ordering}
      LIMIT ? OFFSET ?
    `).all(pageSize, (page - 1) * pageSize) as Array<{ record_json: string }>;
    return {
      items: rows.map((row) => decode<WalletIndexRecord>(row.record_json)),
      total
    };
  }

  walletIndexFunnelCounts(): WalletIndexFunnelCounts {
    const aggregate = this.db.prepare(`
      SELECT
        COUNT(*) AS indexed,
        COALESCE(SUM(CASE
          WHEN COALESCE(json_extract(wi.record_json, '$.discoveryTier'), '') = 'COARSE_SIGNER'
          THEN 1 ELSE 0 END), 0) AS coarse_signer_candidates,
        COALESCE(SUM(CASE
          WHEN COALESCE(json_extract(wi.record_json, '$.discoveryTier'), '') = 'EXACT_SWAP'
            OR (
              json_type(wi.record_json, '$.discoveryTier') IS NULL
              AND wi.spot_swap_count > 0
            )
          THEN 1 ELSE 0 END), 0) AS exact_swap_wallets,
        COALESCE(SUM(CASE WHEN wi.prescreen_eligible = 1 THEN 1 ELSE 0 END), 0) AS activity_proven,
        COALESCE(SUM(CASE
          WHEN wi.prescreen_eligible = 1
            AND COALESCE(json_extract(wi.record_json, '$.deepHistoryStatus'), '') = 'COMPLETE'
            AND wi.closed_eligible_swaps >= ?
          THEN 1 ELSE 0 END), 0) AS closed_swaps,
        COALESCE(SUM(CASE
          WHEN wi.prescreen_eligible = 1
            AND COALESCE(json_extract(wi.record_json, '$.deepHistoryStatus'), '') = 'COMPLETE'
            AND wi.closed_eligible_swaps >= ?
            AND wi.median_holding_minutes >= ?
          THEN 1 ELSE 0 END), 0) AS holding_time
      FROM wallet_index wi
    `).get(
      DEFAULT_WALLET_POLICY.minimumClosedEligibleSwaps,
      DEFAULT_WALLET_POLICY.minimumClosedEligibleSwaps,
      DEFAULT_WALLET_POLICY.minimumMedianHoldingMinutes
    ) as {
      indexed: number;
      coarse_signer_candidates: number;
      exact_swap_wallets: number;
      activity_proven: number;
      closed_swaps: number;
      holding_time: number;
    };
    const activityScreened = (this.db.prepare(`
      SELECT COUNT(DISTINCT wallet) AS count FROM wallet_prescreen_snapshots
    `).get() as { count: number }).count;
    return {
      indexed: aggregate.indexed,
      coarseSignerCandidates: aggregate.coarse_signer_candidates,
      exactSwapWallets: aggregate.exact_swap_wallets,
      activityScreened,
      activityProven: aggregate.activity_proven,
      closedSwaps: aggregate.closed_swaps,
      holdingTime: aggregate.holding_time
    };
  }

  /**
   * Returns only the inexpensive activity-screen survivors, ordered for bounded
   * detailed research. This is intentionally not a qualification query.
   */
  listWalletIndexResearchShortlist(limit = 50): WalletIndexRecord[] {
    const boundedLimit = Math.max(0, Math.min(10_000, Math.trunc(limit)));
    const rows = this.db.prepare(`
      SELECT record_json FROM wallet_index
      WHERE prescreen_eligible = 1
        AND COALESCE(json_extract(record_json, '$.deepHistoryStatus'), '') = 'COMPLETE'
        AND COALESCE(json_extract(record_json, '$.structuralEligible'), 0) = 1
      ORDER BY
        closed_eligible_swaps DESC,
        history_days DESC,
        active_weeks DESC,
        median_holding_minutes DESC,
        eligible_spot_swap_count DESC,
        successful_transaction_count DESC,
        wallet
      LIMIT ?
    `).all(boundedLimit) as Array<{ record_json: string }>;
    return rows.map((row) => decode<WalletIndexRecord>(row.record_json));
  }

  latestWalletPreScreenSnapshotAt(): string | undefined {
    const row = this.db.prepare(`
      SELECT MAX(calculated_at) AS calculated_at FROM wallet_prescreen_snapshots
    `).get() as { calculated_at: string | null };
    return row.calculated_at ?? undefined;
  }

  listLatestWalletPreScreenSurvivors(
    limit = 100,
    newerThan?: string,
    atOrBefore?: string,
    excludedGenerationId?: string,
    excludeCompletedLocalQualifications = false
  ): WalletIndexRecord[] {
    const boundedLimit = Math.max(0, Math.min(100, Math.trunc(limit)));
    const cacheKey = encode([
      this.walletPreScreenSurvivorRevision,
      boundedLimit,
      newerThan ?? null,
      atOrBefore ?? null,
      excludedGenerationId ?? "",
      excludeCompletedLocalQualifications ? 1 : 0,
      DEFAULT_WALLET_POLICY.minimumMedianHoldingMinutes
    ]);
    const cached = this.walletPreScreenSurvivorCache.get(cacheKey);
    if (cached !== undefined) {
      this.walletPreScreenSurvivorCache.delete(cacheKey);
      this.walletPreScreenSurvivorCache.set(cacheKey, cached);
      return cached.map((snapshotJson) => decode<WalletPreScreenSnapshot>(snapshotJson).record);
    }
    const rows = this.db.prepare(`
      SELECT latest.snapshot_json
      FROM wallet_index wi
      JOIN (
        SELECT wallet, eligible, calculated_at, snapshot_json
        FROM (
          SELECT
            wallet,
            eligible,
            calculated_at,
            snapshot_json,
            ROW_NUMBER() OVER (
              PARTITION BY wallet ORDER BY calculated_at DESC, run_id DESC
            ) AS latest_rank
           FROM wallet_prescreen_snapshots
           WHERE (? IS NULL OR calculated_at <= ?)
             -- A managed generation is always lower-bounded by the prior
             -- terminal cutoff. Apply that bound before ROW_NUMBER so rapid
             -- shadow rollovers rank only the new tranche instead of
             -- repeatedly materializing every historical pre-screen row.
             AND (? IS NULL OR calculated_at > ?)
         ) ranked
        WHERE latest_rank = 1
      ) latest ON latest.wallet = wi.wallet
      LEFT JOIN (
        SELECT DISTINCT handed.value AS address
        FROM wallet_research_handoffs handoff
        JOIN json_each(handoff.wallets_json) handed
        WHERE handoff.status = 'COMPLETE'
      ) completed_local ON completed_local.address = wi.wallet
      WHERE latest.eligible = 1
        AND (? IS NULL OR latest.calculated_at > ?)
        AND (? = 0 OR completed_local.address IS NULL)
        AND NOT EXISTS (
          SELECT 1 FROM wallet_deep_history_targets target
          WHERE target.wallet = wi.wallet
            AND target.generation_id = ?
        )
      ORDER BY
        CASE WHEN json_extract(latest.snapshot_json, '$.record.medianHoldingMinutes') >= ? THEN 1 ELSE 0 END DESC,
        json_extract(latest.snapshot_json, '$.record.closedEligibleSwaps') DESC,
        json_extract(latest.snapshot_json, '$.record.eligibleSpotSwapCount') DESC,
        json_extract(latest.snapshot_json, '$.record.activeWeeks') DESC,
        json_extract(latest.snapshot_json, '$.record.historyDays') DESC,
        json_extract(latest.snapshot_json, '$.record.successfulTransactionCount') DESC,
        wi.wallet
      LIMIT ?
    `).all(
      atOrBefore ?? null,
      atOrBefore ?? null,
      newerThan ?? null,
      newerThan ?? null,
      newerThan ?? null,
      newerThan ?? null,
      excludeCompletedLocalQualifications ? 1 : 0,
      excludedGenerationId ?? "",
      DEFAULT_WALLET_POLICY.minimumMedianHoldingMinutes,
      boundedLimit
    ) as Array<{ snapshot_json: string }>;
    const snapshotJsonRows = rows.map((row) => row.snapshot_json);
    this.walletPreScreenSurvivorCache.set(cacheKey, snapshotJsonRows);
    if (this.walletPreScreenSurvivorCache.size > WALLET_PRESCREEN_SURVIVOR_CACHE_MAX_ENTRIES) {
      const oldestKey = this.walletPreScreenSurvivorCache.keys().next().value as string | undefined;
      if (oldestKey !== undefined) this.walletPreScreenSurvivorCache.delete(oldestKey);
    }
    this.scheduleWalletPreScreenSurvivorCacheClear();
    return snapshotJsonRows.map((snapshotJson) => decode<WalletPreScreenSnapshot>(snapshotJson).record);
  }

  /**
   * Reconsiders a small, budget-bounded set of activity-proven wallets whose
   * earlier managed cohort recorded only a coarse disposition. A disposition
   * is immutable scheduling history, not exact evidence, so this selector
   * deliberately requires that no exact evidence exists in any generation and
   * that no unscreened open cohort already owns the wallet.
   */
  seedManagedRecoveryPreflight(input: {
    policyVersion: string;
    windowStart: string;
    readyAt: string;
    wallet?: string;
  }): ManagedRecoveryPreflight | undefined {
    if (
      !input.policyVersion.trim() ||
      !Number.isFinite(Date.parse(input.windowStart)) ||
      !Number.isFinite(Date.parse(input.readyAt))
    ) throw new Error("Managed recovery preflight seed metadata is invalid.");
    const seed = this.db.transaction(() => this.insertManagedRecoveryPreflightCandidate({
      ...input,
      policyVersion: input.policyVersion.trim()
    }));
    const row = seed.immediate();
    return row ? managedRecoveryPreflightFromRow(row) : undefined;
  }

  claimManagedRecoveryPreflight(input: ManagedRecoveryPreflightWindow & {
    now: string;
    leaseExpiresAt: string;
  }): ManagedRecoveryPreflightClaim | undefined {
    const policyVersion = input.policyVersion.trim();
    const now = Date.parse(input.now);
    const windowStart = Date.parse(input.windowStart);
    const expiresAt = Date.parse(input.expiresAt);
    const leaseExpiresAt = Date.parse(input.leaseExpiresAt);
    if (
      !policyVersion ||
      !Number.isFinite(now) ||
      !Number.isFinite(windowStart) ||
      !Number.isFinite(expiresAt) ||
      !Number.isFinite(leaseExpiresAt) ||
      expiresAt <= now ||
      leaseExpiresAt <= now
    ) throw new Error("Managed recovery preflight claim metadata is invalid.");

    const claim = this.db.transaction(() => {
      // A process loss cannot strand work in RUNNING. expires_at is the lease
      // deadline while running and becomes the evidence expiry only at a
      // terminal PASS/REJECTED transition.
      this.db.prepare(`
        UPDATE managed_recovery_preflights
        SET status = 'RETRY', next_attempt_at = ?, expires_at = NULL,
            last_error = 'Recovered an expired preflight lease.', updated_at = ?
        WHERE policy_version = ? AND window_start = ?
          AND status = 'RUNNING' AND expires_at IS NOT NULL AND expires_at <= ?
      `).run(input.now, input.now, policyVersion, input.windowStart, input.now);

      let row = this.db.prepare(`
        SELECT * FROM managed_recovery_preflights
        WHERE policy_version = ? AND window_start = ?
          AND status IN ('READY', 'RETRY') AND next_attempt_at <= ?
        ORDER BY next_attempt_at, updated_at, wallet
        LIMIT 1
      `).get(policyVersion, input.windowStart, input.now) as
        | ManagedRecoveryPreflightRow
        | undefined;
      if (!row) {
        row = this.insertManagedRecoveryPreflightCandidate({
          policyVersion,
          windowStart: input.windowStart,
          readyAt: input.now
        });
      }
      if (!row || !["READY", "RETRY"].includes(row.status) || row.next_attempt_at > input.now) {
        return undefined;
      }
      const changed = this.db.prepare(`
        UPDATE managed_recovery_preflights
        SET status = 'RUNNING', attempts = attempts + 1, expires_at = ?,
            last_error = NULL, updated_at = ?
        WHERE id = ? AND status IN ('READY', 'RETRY') AND next_attempt_at <= ?
      `).run(input.leaseExpiresAt, input.now, row.id, input.now);
      if (changed.changes !== 1) return undefined;
      return this.db.prepare("SELECT * FROM managed_recovery_preflights WHERE id = ?")
        .get(row.id) as ManagedRecoveryPreflightRow;
    }).immediate();
    if (!claim) return undefined;
    return {
      claimToken: managedRecoveryClaimToken(claim),
      wallet: claim.wallet,
      policyVersion: input.policyVersion,
      windowStart: claim.window_start,
      expiresAt: input.expiresAt,
      step: managedRecoveryPreflightStep(claim),
      attempts: claim.attempts,
      ...(claim.pnl30_json !== null ? { pnl30d: decode<WalletPnlWindow>(claim.pnl30_json) } : {}),
      ...(claim.pnl90_json !== null ? { pnl90d: decode<WalletPnlWindow>(claim.pnl90_json) } : {})
    };
  }

  saveManagedRecoveryPreflightPartial(input: {
    claimToken: string;
    wallet: string;
    policyVersion: string;
    windowStart: string;
    expectedStep: "PNL_30D" | "PNL_90D";
    nextStep: "PNL_90D" | "HISTORY";
    observedAt: string;
    pnl30d?: WalletPnlWindow;
    pnl90d?: WalletPnlWindow;
  }): boolean {
    if (!Number.isFinite(Date.parse(input.observedAt))) return false;
    if (
      (input.expectedStep === "PNL_30D" && (input.nextStep !== "PNL_90D" || !input.pnl30d || input.pnl90d)) ||
      (input.expectedStep === "PNL_90D" && (input.nextStep !== "HISTORY" || !input.pnl90d || input.pnl30d))
    ) return false;
    return this.db.transaction(() => {
      const row = this.getManagedRecoveryRunningClaim(input);
      if (!row || !row.expires_at || input.observedAt > row.expires_at) return false;
      const changed = input.expectedStep === "PNL_30D"
        ? this.db.prepare(`
            UPDATE managed_recovery_preflights
            SET status = 'READY', attempts = 0, next_attempt_at = ?, pnl30_json = ?,
                expires_at = NULL, last_error = NULL, updated_at = ?
            WHERE id = ? AND status = 'RUNNING'
          `).run(input.observedAt, encode(input.pnl30d), input.observedAt, row.id)
        : this.db.prepare(`
            UPDATE managed_recovery_preflights
            SET status = 'READY', attempts = 0, next_attempt_at = ?, pnl90_json = ?,
                expires_at = NULL, last_error = NULL, updated_at = ?
            WHERE id = ? AND status = 'RUNNING'
          `).run(input.observedAt, encode(input.pnl90d), input.observedAt, row.id);
      return changed.changes === 1;
    }).immediate();
  }

  passManagedRecoveryPreflight(input: {
    claimToken: string;
    wallet: string;
    policyVersion: string;
    windowStart: string;
    expectedStep: "HISTORY";
    validAt: string;
    expiresAt: string;
    history: WalletHistorySummary;
  }): boolean {
    const validAt = Date.parse(input.validAt);
    const expiresAt = Date.parse(input.expiresAt);
    if (!Number.isFinite(validAt) || !Number.isFinite(expiresAt) || expiresAt <= validAt) return false;
    return this.db.transaction(() => {
      const row = this.getManagedRecoveryRunningClaim(input);
      if (
        !row || !row.expires_at || input.validAt > row.expires_at ||
        row.pnl30_json === null || row.pnl90_json === null
      ) return false;
      const changed = this.db.prepare(`
        UPDATE managed_recovery_preflights
        SET status = 'PASS', history_json = ?, reasons_json = '[]',
            checked_at = ?, expires_at = ?, last_error = NULL, updated_at = ?
        WHERE id = ? AND status = 'RUNNING'
      `).run(encode(input.history), input.validAt, input.expiresAt, input.validAt, row.id);
      return changed.changes === 1;
    }).immediate();
  }

  rejectManagedRecoveryPreflight(input: {
    claimToken: string;
    wallet: string;
    policyVersion: string;
    windowStart: string;
    expectedStep: ManagedRecoveryPreflightStep;
    reasonCode: string;
    observedAt: string;
    expiresAt: string;
  }): boolean {
    const observedAt = Date.parse(input.observedAt);
    const expiresAt = Date.parse(input.expiresAt);
    const reasonCode = input.reasonCode.trim();
    if (
      !reasonCode || !Number.isFinite(observedAt) || !Number.isFinite(expiresAt) ||
      expiresAt <= observedAt
    ) return false;
    return this.db.transaction(() => {
      const row = this.getManagedRecoveryRunningClaim(input);
      if (!row || !row.expires_at || input.observedAt > row.expires_at) return false;
      const changed = this.db.prepare(`
        UPDATE managed_recovery_preflights
        SET status = 'REJECTED', reasons_json = ?, checked_at = ?, expires_at = ?,
            last_error = NULL, updated_at = ?
        WHERE id = ? AND status = 'RUNNING'
      `).run(encode([reasonCode]), input.observedAt, input.expiresAt, input.observedAt, row.id);
      return changed.changes === 1;
    }).immediate();
  }

  retryManagedRecoveryPreflight(input: {
    claimToken: string;
    wallet: string;
    policyVersion: string;
    windowStart: string;
    expectedStep: ManagedRecoveryPreflightStep;
    attemptedAt: string;
    nextAttemptAt: string;
    error: string;
  }): boolean {
    if (
      !Number.isFinite(Date.parse(input.attemptedAt)) ||
      !Number.isFinite(Date.parse(input.nextAttemptAt)) ||
      input.nextAttemptAt < input.attemptedAt
    ) return false;
    return this.db.transaction(() => {
      const row = this.getManagedRecoveryRunningClaim(input);
      if (!row) return false;
      const changed = this.db.prepare(`
        UPDATE managed_recovery_preflights
        SET status = 'RETRY', next_attempt_at = ?, expires_at = NULL,
            last_error = ?, updated_at = ?
        WHERE id = ? AND status = 'RUNNING'
      `).run(
        input.nextAttemptAt,
        redactSensitiveText(input.error, 1_000),
        input.attemptedAt,
        row.id
      );
      return changed.changes === 1;
    }).immediate();
  }

  recoverManagedRecoveryPreflightRuns(input: {
    now: string;
    policyVersion?: string;
    windowStart?: string;
  }): number {
    if (!Number.isFinite(Date.parse(input.now))) {
      throw new Error("Managed recovery recovery timestamp is invalid.");
    }
    const result = this.db.prepare(`
      UPDATE managed_recovery_preflights
      SET status = 'RETRY', next_attempt_at = ?, expires_at = NULL,
          last_error = 'Recovered an expired preflight lease.', updated_at = ?
      WHERE status = 'RUNNING' AND expires_at IS NOT NULL AND expires_at <= ?
        AND (? IS NULL OR policy_version = ?)
        AND (? IS NULL OR window_start = ?)
    `).run(
      input.now,
      input.now,
      input.now,
      input.policyVersion ?? null,
      input.policyVersion ?? null,
      input.windowStart ?? null,
      input.windowStart ?? null
    );
    return result.changes;
  }

  requeueManagedRecoveryPreflightHistoryRetries(input: {
    policyVersion: string;
    windowStart: string;
    now: string;
    expectedLastError: string;
    reason: string;
  }): number {
    if (
      !input.policyVersion.trim() ||
      !Number.isFinite(Date.parse(input.windowStart)) ||
      !Number.isFinite(Date.parse(input.now)) ||
      !input.expectedLastError.trim() ||
      !input.reason.trim()
    ) throw new Error("Managed recovery history requeue metadata is invalid.");
    const result = this.db.prepare(`
      UPDATE managed_recovery_preflights
      SET status = 'READY', attempts = 0, next_attempt_at = ?, expires_at = NULL,
          last_error = ?, updated_at = ?
      WHERE policy_version = ? AND window_start = ? AND status = 'RETRY'
        AND pnl30_json IS NOT NULL AND pnl90_json IS NOT NULL
        AND history_json IS NULL AND last_error = ?
    `).run(
      input.now,
      redactSensitiveText(input.reason, 1_000),
      input.now,
      input.policyVersion,
      input.windowStart,
      input.expectedLastError
    );
    return result.changes;
  }

  getManagedRecoveryPreflight(id: string): ManagedRecoveryPreflight | undefined {
    const row = this.db.prepare("SELECT * FROM managed_recovery_preflights WHERE id = ?")
      .get(id) as ManagedRecoveryPreflightRow | undefined;
    return row ? managedRecoveryPreflightFromRow(row) : undefined;
  }

  getManagedRecoveryPreflightForWallet(input: {
    policyVersion: string;
    windowStart: string;
    wallet: string;
  }): ManagedRecoveryPreflight | undefined {
    const row = this.db.prepare(`
      SELECT * FROM managed_recovery_preflights
      WHERE policy_version = ? AND window_start = ? AND wallet = ?
    `).get(input.policyVersion, input.windowStart, input.wallet) as
      | ManagedRecoveryPreflightRow
      | undefined;
    return row ? managedRecoveryPreflightFromRow(row) : undefined;
  }

  countManagedRecoveryPreflights(input: {
    policyVersion?: string;
    windowStart?: string;
  } = {}): ManagedRecoveryPreflightCounts {
    const rows = this.db.prepare(`
      SELECT status, COUNT(*) AS count
      FROM managed_recovery_preflights
      WHERE (? IS NULL OR policy_version = ?)
        AND (? IS NULL OR window_start = ?)
      GROUP BY status
    `).all(
      input.policyVersion ?? null,
      input.policyVersion ?? null,
      input.windowStart ?? null,
      input.windowStart ?? null
    ) as Array<{ status: ManagedRecoveryPreflightStatus; count: number }>;
    const counts: ManagedRecoveryPreflightCounts = {
      total: 0,
      ready: 0,
      running: 0,
      retry: 0,
      pass: 0,
      rejected: 0
    };
    for (const row of rows) {
      counts.total += row.count;
      counts[row.status.toLowerCase() as keyof Omit<ManagedRecoveryPreflightCounts, "total">] = row.count;
    }
    return counts;
  }

  listManagedWalletDeepHistoryRecoveryCandidates(options: {
    limit?: number;
    maximumWalletSuccessfulTransactions?: number;
    maximumCumulativeSuccessfulTransactions?: number;
    preflightGate?: ManagedRecoveryPreflightGate;
  } = {}): WalletIndexRecord[] {
    const boundedInteger = (value: number | undefined, fallback: number, maximum: number): number => {
      const resolved = value === undefined ? fallback : value;
      if (!Number.isFinite(resolved)) return fallback;
      return Math.max(0, Math.min(maximum, Math.trunc(resolved)));
    };
    const limit = boundedInteger(options.limit, 5, 100);
    const maximumWalletSuccessfulTransactions = boundedInteger(
      options.maximumWalletSuccessfulTransactions,
      5_000,
      Number.MAX_SAFE_INTEGER
    );
    const maximumCumulativeSuccessfulTransactions = boundedInteger(
      options.maximumCumulativeSuccessfulTransactions,
      25_000,
      Number.MAX_SAFE_INTEGER
    );
    if (limit === 0) return [];
    const preflightGate = options.preflightGate;
    if (preflightGate && (
      !preflightGate.policyVersion.trim() ||
      !Number.isFinite(Date.parse(preflightGate.windowStart)) ||
      !Number.isFinite(Date.parse(preflightGate.validAt))
    )) throw new Error("Managed recovery preflight gate metadata is invalid.");

    /*
     * wallet_index is one row per wallet and both historical relations are
     * tested with EXISTS, so repeated dispositions cannot duplicate results.
     * The four CASE lanes distinguish positive holding evidence from unknown
     * holding time while keeping the final exact-history policy unchanged.
     */
    const rows = this.db.prepare(`
      SELECT wi.record_json, wi.successful_transaction_count
      FROM wallet_index wi
      WHERE wi.prescreen_eligible = 1
        AND COALESCE(json_extract(wi.record_json, '$.deepHistoryStatus'), '') = 'AWAITING'
        AND wi.successful_transaction_count BETWEEN 0 AND ?
        AND (
          (wi.closed_eligible_swaps > 0 AND wi.median_holding_minutes >= 15)
          OR (wi.closed_eligible_swaps = 0 AND wi.eligible_spot_swap_count >= 10)
          OR (wi.closed_eligible_swaps > 0 AND wi.median_holding_minutes >= 10)
          OR (wi.closed_eligible_swaps = 0 AND wi.eligible_spot_swap_count >= 5)
        )
        AND EXISTS (
          SELECT 1
          FROM wallet_deep_history_target_dispositions disposition
          WHERE disposition.wallet = wi.wallet
        )
        AND NOT EXISTS (
          SELECT 1
          FROM wallet_deep_history_evidence evidence
          WHERE evidence.wallet = wi.wallet
        )
        AND NOT EXISTS (
          SELECT 1
          FROM wallet_deep_history_targets target
          JOIN wallet_deep_history_cohorts cohort ON cohort.id = target.cohort_id
          LEFT JOIN wallet_deep_history_managed_cohort_screenings managed
            ON managed.cohort_id = cohort.id
          WHERE target.wallet = wi.wallet
            AND cohort.status = 'OPEN'
            AND managed.cohort_id IS NULL
        )
        AND (
          ? = 0 OR EXISTS (
            SELECT 1
            FROM managed_recovery_preflights preflight
            WHERE preflight.wallet = wi.wallet
              AND preflight.policy_version = ?
              AND preflight.window_start = ?
              AND preflight.status = 'PASS'
              AND preflight.checked_at IS NOT NULL
              AND preflight.checked_at <= ?
              AND preflight.expires_at IS NOT NULL
              AND preflight.expires_at > ?
          )
        )
      ORDER BY
        CASE
          WHEN wi.closed_eligible_swaps > 0 AND wi.median_holding_minutes >= 15 THEN 1
          WHEN wi.closed_eligible_swaps = 0 AND wi.eligible_spot_swap_count >= 10 THEN 2
          WHEN wi.closed_eligible_swaps > 0 AND wi.median_holding_minutes >= 10 THEN 3
          WHEN wi.closed_eligible_swaps = 0 AND wi.eligible_spot_swap_count >= 5 THEN 4
          ELSE 5
        END,
        wi.closed_eligible_swaps DESC,
        wi.eligible_spot_swap_count DESC,
        wi.median_holding_minutes DESC,
        wi.active_weeks DESC,
        wi.history_days DESC,
        wi.successful_transaction_count ASC,
        wi.wallet
    `).all(
      maximumWalletSuccessfulTransactions,
      preflightGate ? 1 : 0,
      preflightGate?.policyVersion ?? "",
      preflightGate?.windowStart ?? "",
      preflightGate?.validAt ?? "",
      preflightGate?.validAt ?? ""
    ) as Array<{
      record_json: string;
      successful_transaction_count: number;
    }>;

    const selected: WalletIndexRecord[] = [];
    let cumulativeSuccessfulTransactions = 0;
    for (const row of rows) {
      const nextCumulative = cumulativeSuccessfulTransactions + row.successful_transaction_count;
      if (nextCumulative > maximumCumulativeSuccessfulTransactions) continue;
      selected.push(decode<WalletIndexRecord>(row.record_json));
      cumulativeSuccessfulTransactions = nextCumulative;
      if (selected.length >= limit) break;
    }
    return selected;
  }

  createWalletDeepHistoryCohort(input: CreateWalletDeepHistoryCohort): WalletDeepHistoryCohort {
    const wallets = [...new Set(input.wallets.map((wallet) => wallet.trim()).filter(Boolean))];
    if (wallets.length === 0 || wallets.length !== input.wallets.length || wallets.length > 100) {
      throw new Error("A deep-history cohort requires between 1 and 100 unique wallet addresses.");
    }
    const selectedAt = Date.parse(input.selectedAt);
    const snapshotCutoffAt = Date.parse(input.snapshotCutoffAt);
    const windowStart = Date.parse(input.windowStart);
    const windowEnd = Date.parse(input.windowEnd);
    if (
      !Number.isFinite(selectedAt) || !Number.isFinite(snapshotCutoffAt) ||
      !Number.isFinite(windowStart) || !Number.isFinite(windowEnd) ||
      windowStart >= windowEnd || snapshotCutoffAt > selectedAt
    ) {
      throw new Error("Deep-history cohort timestamps are invalid.");
    }
    const preflightGate = input.preflightGate;
    if (input.kind === "MANAGED_RESCUE_V3" && (!preflightGate || (
      !preflightGate.policyVersion.trim() ||
      !Number.isFinite(Date.parse(preflightGate.windowStart)) ||
      !Number.isFinite(Date.parse(preflightGate.validAt)) ||
      Date.parse(preflightGate.windowStart) > selectedAt ||
      Date.parse(preflightGate.validAt) > selectedAt
    ))) {
      throw new Error("A v3 managed rescue requires a valid preflight gate.");
    }
    const cohort = this.db.transaction(() => {
      const preflightIds = new Map<string, string>();
      if (input.kind === "MANAGED_RESCUE_V3" && preflightGate) {
        const findAuthorization = this.db.prepare(`
          SELECT id
          FROM managed_recovery_preflights
          WHERE wallet = ? AND policy_version = ? AND window_start = ?
            AND status = 'PASS' AND checked_at IS NOT NULL AND checked_at <= ?
            AND expires_at IS NOT NULL AND expires_at > ?
        `);
        for (const wallet of wallets) {
          const row = findAuthorization.get(
            wallet,
            preflightGate.policyVersion,
            preflightGate.windowStart,
            input.selectedAt,
            input.selectedAt
          ) as { id: string } | undefined;
          if (!row) {
            throw new Error(`Wallet ${wallet} has no fresh passing managed recovery preflight.`);
          }
          preflightIds.set(wallet, row.id);
        }
      }
      let generation = input.generationId
        ? this.getWalletDeepHistoryGeneration(input.generationId)
        : undefined;
      if (input.generationId && !generation) {
        throw new Error("Deep-history generation does not exist.");
      }
      if (generation) {
        if (
          generation.status !== "OPEN" ||
          generation.snapshotCutoffAt !== input.snapshotCutoffAt ||
          generation.windowStart !== input.windowStart ||
          generation.windowEnd !== input.windowEnd
        ) {
          throw new Error("Deep-history cohort does not match its open immutable generation.");
        }
      } else {
        const generationSequence = (this.db.prepare(`
          SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM wallet_deep_history_generations
        `).get() as { sequence: number }).sequence;
        const generationId = `local-generation-v1:${generationSequence}:${randomUUID()}`;
        this.db.prepare(`
          INSERT INTO wallet_deep_history_generations(
            id, sequence, status, selected_at, snapshot_cutoff_at,
            window_start, window_end, created_at
          ) VALUES (?, ?, 'OPEN', ?, ?, ?, ?, ?)
        `).run(
          generationId,
          generationSequence,
          input.selectedAt,
          input.snapshotCutoffAt,
          input.windowStart,
          input.windowEnd,
          input.selectedAt
        );
        generation = this.getWalletDeepHistoryGeneration(generationId);
        if (!generation) throw new Error("Deep-history generation was not persisted.");
      }
      const sequence = (this.db.prepare(`
        SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM wallet_deep_history_cohorts
      `).get() as { sequence: number }).sequence;
      const idPrefix = input.kind === "MANAGED_RESCUE_V3"
        ? "managed-rescue-v3"
        : input.kind === "MANAGED_RESCUE_V2"
          ? "managed-rescue-v2"
          : "local-deep-v2";
      const id = `${idPrefix}:${sequence}:${randomUUID()}`;
      this.db.prepare(`
        INSERT INTO wallet_deep_history_cohorts(
          id, sequence, generation_id, status, selected_at, snapshot_cutoff_at,
          window_start, window_end, created_at
        ) VALUES (?, ?, ?, 'OPEN', ?, ?, ?, ?, ?)
      `).run(
        id,
        sequence,
        generation.id,
        input.selectedAt,
        input.snapshotCutoffAt,
        input.windowStart,
        input.windowEnd,
        input.selectedAt
      );
      const insertTarget = this.db.prepare(`
        INSERT INTO wallet_deep_history_targets(cohort_id, generation_id, wallet, ordinal)
        VALUES (?, ?, ?, ?)
      `);
      wallets.forEach((wallet, ordinal) => insertTarget.run(id, generation.id, wallet, ordinal));
      if (input.kind === "MANAGED_RESCUE_V3") {
        const insertAuthorization = this.db.prepare(`
          INSERT INTO managed_recovery_preflight_authorizations(cohort_id, wallet, preflight_id)
          VALUES (?, ?, ?)
        `);
        for (const wallet of wallets) {
          const preflightId = preflightIds.get(wallet);
          if (!preflightId) throw new Error("Managed recovery preflight authorization was lost.");
          insertAuthorization.run(id, wallet, preflightId);
        }
      }
      const savedCohort = this.getWalletDeepHistoryCohort(id);
      if (!savedCohort) throw new Error("Deep-history cohort was not persisted.");
      return savedCohort;
    }).immediate();
    this.invalidateWalletPreScreenSurvivorCache();
    return cohort;
  }

  getManagedRecoveryPreflightAuthorization(
    cohortId: string,
    wallet: string
  ): { cohortId: string; wallet: string; preflightId: string } | undefined {
    const row = this.db.prepare(`
      SELECT cohort_id, wallet, preflight_id
      FROM managed_recovery_preflight_authorizations
      WHERE cohort_id = ? AND wallet = ?
    `).get(cohortId, wallet) as {
      cohort_id: string;
      wallet: string;
      preflight_id: string;
    } | undefined;
    return row ? {
      cohortId: row.cohort_id,
      wallet: row.wallet,
      preflightId: row.preflight_id
    } : undefined;
  }

  getWalletDeepHistoryCohort(id: string): WalletDeepHistoryCohort | undefined {
    const row = this.db.prepare(`
      SELECT cohort.id, cohort.sequence, cohort.generation_id, cohort.status,
             cohort.selected_at, cohort.snapshot_cutoff_at, cohort.window_start,
             cohort.window_end, cohort.created_at, cohort.completed_at,
             managed.screened_at AS managed_screened_at
      FROM wallet_deep_history_cohorts cohort
      LEFT JOIN wallet_deep_history_managed_cohort_screenings managed
        ON managed.cohort_id = cohort.id
      WHERE cohort.id = ?
    `).get(id) as {
      id: string;
      sequence: number;
      generation_id: string;
      status: "OPEN" | "COMPLETE";
      selected_at: string;
      snapshot_cutoff_at: string;
      window_start: string;
      window_end: string;
      created_at: string;
      completed_at: string | null;
      managed_screened_at: string | null;
    } | undefined;
    if (!row) return undefined;
    const targets = this.db.prepare(`
      SELECT wallet FROM wallet_deep_history_targets WHERE cohort_id = ? ORDER BY ordinal
    `).all(id) as Array<{ wallet: string }>;
    const cohort: WalletDeepHistoryCohort = {
      id: row.id,
      sequence: row.sequence,
      generationId: row.generation_id,
      status: row.status === "OPEN" && row.managed_screened_at
        ? "MANAGED_SCREENED"
        : row.status,
      selectedAt: row.selected_at,
      snapshotCutoffAt: row.snapshot_cutoff_at,
      windowStart: row.window_start,
      windowEnd: row.window_end,
      wallets: targets.map((target) => target.wallet),
      createdAt: row.created_at
    };
    const terminalAt = row.completed_at ?? row.managed_screened_at;
    if (terminalAt !== null) cohort.completedAt = terminalAt;
    return cohort;
  }

  listWalletDeepHistoryCohorts(limit = 100): WalletDeepHistoryCohort[] {
    const rows = this.db.prepare(`
      SELECT id FROM wallet_deep_history_cohorts ORDER BY sequence DESC LIMIT ?
    `).all(Math.max(0, Math.min(10_000, Math.trunc(limit)))) as Array<{ id: string }>;
    return rows.flatMap((row) => {
      const cohort = this.getWalletDeepHistoryCohort(row.id);
      return cohort ? [cohort] : [];
    });
  }

  getWalletDeepHistoryGeneration(id: string): WalletDeepHistoryGeneration | undefined {
    const row = this.db.prepare(`
      SELECT generation.id, generation.sequence, generation.status,
             generation.selected_at, generation.snapshot_cutoff_at,
             generation.window_start, generation.window_end,
             generation.created_at, generation.completed_at,
             managed.screened_at AS managed_screened_at
      FROM wallet_deep_history_generations generation
      LEFT JOIN wallet_deep_history_managed_generation_screenings managed
        ON managed.generation_id = generation.id
      WHERE generation.id = ?
    `).get(id) as {
      id: string;
      sequence: number;
      status: "OPEN" | "COMPLETE";
      selected_at: string;
      snapshot_cutoff_at: string;
      window_start: string;
      window_end: string;
      created_at: string;
      completed_at: string | null;
      managed_screened_at: string | null;
    } | undefined;
    if (!row) return undefined;
    const terminalAt = row.completed_at ?? row.managed_screened_at;
    return {
      id: row.id,
      sequence: row.sequence,
      status: row.status === "OPEN" && row.managed_screened_at
        ? "MANAGED_SCREENED"
        : row.status,
      selectedAt: row.selected_at,
      snapshotCutoffAt: row.snapshot_cutoff_at,
      windowStart: row.window_start,
      windowEnd: row.window_end,
      createdAt: row.created_at,
      ...(terminalAt ? { completedAt: terminalAt } : {})
    };
  }

  listWalletDeepHistoryGenerations(limit = 100): WalletDeepHistoryGeneration[] {
    const rows = this.db.prepare(`
      SELECT id FROM wallet_deep_history_generations ORDER BY sequence DESC LIMIT ?
    `).all(Math.max(0, Math.min(10_000, Math.trunc(limit)))) as Array<{ id: string }>;
    return rows.flatMap((row) => {
      const generation = this.getWalletDeepHistoryGeneration(row.id);
      return generation ? [generation] : [];
    });
  }

  openWalletDeepHistoryGeneration(): WalletDeepHistoryGeneration | undefined {
    const row = this.db.prepare(`
      SELECT generation.id
      FROM wallet_deep_history_generations generation
      WHERE generation.status = 'OPEN'
        AND NOT EXISTS (
          SELECT 1 FROM wallet_deep_history_managed_generation_screenings managed
          WHERE managed.generation_id = generation.id
        )
      ORDER BY generation.sequence LIMIT 1
    `).get() as { id: string } | undefined;
    return row ? this.getWalletDeepHistoryGeneration(row.id) : undefined;
  }

  latestCompleteWalletDeepHistoryGeneration(): WalletDeepHistoryGeneration | undefined {
    const row = this.db.prepare(`
      SELECT id FROM wallet_deep_history_generations WHERE status = 'COMPLETE'
      ORDER BY sequence DESC LIMIT 1
    `).get() as { id: string } | undefined;
    return row ? this.getWalletDeepHistoryGeneration(row.id) : undefined;
  }

  latestTerminalWalletDeepHistoryGeneration(): WalletDeepHistoryGeneration | undefined {
    const row = this.db.prepare(`
      SELECT generation.id
      FROM wallet_deep_history_generations generation
      LEFT JOIN wallet_deep_history_managed_generation_screenings managed
        ON managed.generation_id = generation.id
      WHERE generation.status = 'COMPLETE' OR managed.generation_id IS NOT NULL
      ORDER BY generation.sequence DESC LIMIT 1
    `).get() as { id: string } | undefined;
    return row ? this.getWalletDeepHistoryGeneration(row.id) : undefined;
  }

  terminalWalletDeepHistoryGenerationBefore(sequence: number): WalletDeepHistoryGeneration | undefined {
    const boundedSequence = Math.max(1, Math.trunc(sequence));
    const row = this.db.prepare(`
      SELECT generation.id
      FROM wallet_deep_history_generations generation
      LEFT JOIN wallet_deep_history_managed_generation_screenings managed
        ON managed.generation_id = generation.id
      WHERE generation.sequence < ?
        AND (generation.status = 'COMPLETE' OR managed.generation_id IS NOT NULL)
      ORDER BY generation.sequence DESC LIMIT 1
    `).get(boundedSequence) as { id: string } | undefined;
    return row ? this.getWalletDeepHistoryGeneration(row.id) : undefined;
  }

  listWalletDeepHistoryCohortsForGeneration(generationId: string): WalletDeepHistoryCohort[] {
    const rows = this.db.prepare(`
      SELECT id FROM wallet_deep_history_cohorts WHERE generation_id = ? ORDER BY sequence DESC
    `).all(generationId) as Array<{ id: string }>;
    return rows.flatMap((row) => {
      const cohort = this.getWalletDeepHistoryCohort(row.id);
      return cohort ? [cohort] : [];
    });
  }

  latestWalletDeepHistoryCohortForWallet(wallet: string): WalletDeepHistoryCohort | undefined {
    const row = this.db.prepare(`
      SELECT cohort.id
      FROM wallet_deep_history_targets target
      JOIN wallet_deep_history_cohorts cohort ON cohort.id = target.cohort_id
      WHERE target.wallet = ?
      ORDER BY cohort.sequence DESC LIMIT 1
    `).get(wallet) as { id: string } | undefined;
    return row ? this.getWalletDeepHistoryCohort(row.id) : undefined;
  }

  openWalletDeepHistoryCohort(): WalletDeepHistoryCohort | undefined {
    const row = this.db.prepare(`
      SELECT cohort.id
      FROM wallet_deep_history_cohorts cohort
      WHERE cohort.status = 'OPEN'
        AND NOT EXISTS (
          SELECT 1 FROM wallet_deep_history_managed_cohort_screenings managed
          WHERE managed.cohort_id = cohort.id
        )
      ORDER BY cohort.sequence LIMIT 1
    `).get() as { id: string } | undefined;
    return row ? this.getWalletDeepHistoryCohort(row.id) : undefined;
  }

  latestWalletDeepHistoryCohort(): WalletDeepHistoryCohort | undefined {
    const row = this.db.prepare(`
      SELECT id FROM wallet_deep_history_cohorts ORDER BY sequence DESC LIMIT 1
    `).get() as { id: string } | undefined;
    return row ? this.getWalletDeepHistoryCohort(row.id) : undefined;
  }

  getWalletDeepHistoryTargetDisposition(
    cohortId: string,
    wallet: string
  ): WalletDeepHistoryTargetDisposition | undefined {
    const row = this.db.prepare(`
      SELECT cohort_id, generation_id, wallet, disposition, policy_version,
             snapshot_calculated_at, snapshot_json, snapshot_digest,
             details_json, decision_digest, decided_at
      FROM wallet_deep_history_target_dispositions
      WHERE cohort_id = ? AND wallet = ?
    `).get(cohortId, wallet) as {
      cohort_id: string;
      generation_id: string;
      wallet: string;
      disposition: WalletDeepHistoryTargetDispositionKind;
      policy_version: string;
      snapshot_calculated_at: string;
      snapshot_json: string;
      snapshot_digest: string;
      details_json: string;
      decision_digest: string;
      decided_at: string;
    } | undefined;
    if (!row) return undefined;
    const snapshotDigest = sha256(row.snapshot_json);
    const decisionDigest = sha256(`${snapshotDigest}\n${row.policy_version}\n${row.details_json}`);
    if (snapshotDigest !== row.snapshot_digest || decisionDigest !== row.decision_digest) {
      throw new Error(`Managed coarse disposition digest mismatch for ${row.wallet}.`);
    }
    const snapshot = decode<WalletPreScreenSnapshot>(row.snapshot_json);
    const details = decode<WalletDeepHistoryTargetDisposition["details"]>(row.details_json);
    if (
      row.disposition !== "COARSE_COPYABILITY_SKIP" ||
      snapshot.wallet !== row.wallet || snapshot.record.wallet !== row.wallet ||
      snapshot.calculatedAt !== row.snapshot_calculated_at ||
      details.cohortId !== row.cohort_id || details.generationId !== row.generation_id ||
      details.wallet !== row.wallet || details.policyVersion !== row.policy_version ||
      details.disposition !== row.disposition ||
      details.snapshotCalculatedAt !== row.snapshot_calculated_at
    ) {
      throw new Error(`Managed coarse disposition metadata mismatch for ${row.wallet}.`);
    }
    return {
      cohortId: row.cohort_id,
      generationId: row.generation_id,
      wallet: row.wallet,
      disposition: row.disposition,
      policyVersion: row.policy_version,
      snapshotCalculatedAt: row.snapshot_calculated_at,
      snapshot,
      snapshotDigest: row.snapshot_digest,
      details,
      decisionDigest: row.decision_digest,
      decidedAt: row.decided_at
    };
  }

  listWalletDeepHistoryTargetDispositions(cohortId: string): WalletDeepHistoryTargetDisposition[] {
    const rows = this.db.prepare(`
      SELECT wallet FROM wallet_deep_history_target_dispositions
      WHERE cohort_id = ? ORDER BY wallet
    `).all(cohortId) as Array<{ wallet: string }>;
    return rows.flatMap((row) => {
      const disposition = this.getWalletDeepHistoryTargetDisposition(cohortId, row.wallet);
      return disposition ? [disposition] : [];
    });
  }

  saveManagedCoarseCopyabilitySkip(input: {
    cohortId: string;
    wallet: string;
    policyVersion: string;
    thresholdMinutes: number;
    decidedAt: string;
  }): SaveManagedCoarseDispositionResult {
    if (
      !input.cohortId.trim() || !input.wallet.trim() || !input.policyVersion.trim() ||
      !Number.isFinite(input.thresholdMinutes) || input.thresholdMinutes <= 0 ||
      !Number.isFinite(Date.parse(input.decidedAt))
    ) throw new Error("Managed coarse disposition input is invalid.");
    const cohort = this.getWalletDeepHistoryCohort(input.cohortId);
    if (!cohort) throw new Error("Managed coarse disposition cohort does not exist.");
    const target = this.db.prepare(`
      SELECT generation_id FROM wallet_deep_history_targets
      WHERE cohort_id = ? AND wallet = ?
    `).get(input.cohortId, input.wallet) as { generation_id: string } | undefined;
    if (!target || target.generation_id !== cohort.generationId) {
      throw new Error("Managed coarse disposition has no matching frozen target.");
    }
    const snapshotRow = this.db.prepare(`
      SELECT calculated_at, snapshot_json
      FROM wallet_prescreen_snapshots
      WHERE wallet = ? AND calculated_at <= ?
      ORDER BY calculated_at DESC, run_id DESC
      LIMIT 1
    `).get(input.wallet, cohort.snapshotCutoffAt) as {
      calculated_at: string;
      snapshot_json: string;
    } | undefined;
    if (!snapshotRow) throw new Error("Managed coarse disposition has no frozen pre-screen snapshot.");
    const snapshot = decode<WalletPreScreenSnapshot>(snapshotRow.snapshot_json);
    if (
      !snapshot.eligible || snapshot.wallet !== input.wallet || snapshot.record.wallet !== input.wallet ||
      snapshot.calculatedAt !== snapshotRow.calculated_at ||
      snapshot.record.medianHoldingMinutes >= input.thresholdMinutes
    ) {
      throw new Error("Managed coarse disposition is not a below-threshold frozen survivor.");
    }
    const snapshotDigest = sha256(snapshotRow.snapshot_json);
    const details: WalletDeepHistoryTargetDisposition["details"] = {
      cohortId: cohort.id,
      generationId: cohort.generationId,
      wallet: input.wallet,
      snapshotCutoffAt: cohort.snapshotCutoffAt,
      snapshotCalculatedAt: snapshotRow.calculated_at,
      policyVersion: input.policyVersion,
      disposition: "COARSE_COPYABILITY_SKIP",
      thresholdMinutes: input.thresholdMinutes,
      observedMedianHoldingMinutes: snapshot.record.medianHoldingMinutes
    };
    const detailsJson = encode(details);
    const decisionDigest = sha256(`${snapshotDigest}\n${input.policyVersion}\n${detailsJson}`);
    return this.db.transaction(() => {
      const prior = this.getWalletDeepHistoryTargetDisposition(input.cohortId, input.wallet);
      if (prior) {
        if (prior.decisionDigest !== decisionDigest) {
          throw new Error("Managed coarse disposition cannot be overwritten with mutable inputs.");
        }
        return { disposition: prior, created: false };
      }
      if (cohort.status !== "OPEN") {
        throw new Error("Managed coarse disposition requires an open exact cohort.");
      }
      if (this.getWalletDeepHistoryEvidence(cohort.generationId, input.wallet)) {
        throw new Error("Exact deep-history evidence cannot also be coarsely skipped.");
      }
      this.db.prepare(`
        INSERT INTO wallet_deep_history_target_dispositions(
          cohort_id, generation_id, wallet, disposition, policy_version,
          snapshot_calculated_at, snapshot_json, snapshot_digest,
          details_json, decision_digest, decided_at
        ) VALUES (?, ?, ?, 'COARSE_COPYABILITY_SKIP', ?, ?, ?, ?, ?, ?, ?)
      `).run(
        cohort.id,
        cohort.generationId,
        input.wallet,
        input.policyVersion,
        snapshotRow.calculated_at,
        snapshotRow.snapshot_json,
        snapshotDigest,
        detailsJson,
        decisionDigest,
        input.decidedAt
      );
      this.audit(
        "wallet_deep_history_coarse_copyability_skipped",
        "A managed-only target was deferred by its frozen coarse copyability screen; no exact evidence or rejection was created.",
        { ...details, snapshotDigest, decisionDigest }
      );
      const disposition = this.getWalletDeepHistoryTargetDisposition(input.cohortId, input.wallet);
      if (!disposition) throw new Error("Managed coarse disposition was not persisted.");
      return { disposition, created: true };
    })();
  }

  markWalletDeepHistoryCohortManagedScreened(
    id: string,
    policyVersion: string,
    at = new Date()
  ): boolean {
    if (!policyVersion.trim() || !Number.isFinite(at.getTime())) {
      throw new Error("Managed cohort screening input is invalid.");
    }
    const changed = this.db.transaction(() => {
      const raw = this.db.prepare(`
        SELECT id, generation_id, status FROM wallet_deep_history_cohorts WHERE id = ?
      `).get(id) as { id: string; generation_id: string; status: "OPEN" | "COMPLETE" } | undefined;
      if (!raw || raw.status !== "OPEN") return false;
      const rows = this.db.prepare(`
        SELECT target.ordinal, target.wallet, evidence.evidence_digest,
               disposition.decision_digest
        FROM wallet_deep_history_targets target
        LEFT JOIN wallet_deep_history_evidence evidence
          ON evidence.generation_id = target.generation_id AND evidence.wallet = target.wallet
        LEFT JOIN wallet_deep_history_target_dispositions disposition
          ON disposition.cohort_id = target.cohort_id AND disposition.wallet = target.wallet
        WHERE target.cohort_id = ?
        ORDER BY target.ordinal
      `).all(id) as Array<{
        ordinal: number;
        wallet: string;
        evidence_digest: string | null;
        decision_digest: string | null;
      }>;
      if (rows.length === 0 || rows.some((row) =>
        (row.evidence_digest === null) === (row.decision_digest === null)
      )) return false;
      const manifest = rows.map((row) => ({
        ordinal: row.ordinal,
        wallet: row.wallet,
        kind: row.evidence_digest ? "EXACT_EVIDENCE" : "COARSE_COPYABILITY_SKIP",
        digest: row.evidence_digest ?? row.decision_digest
      }));
      const manifestDigest = sha256(`${policyVersion}\n${encode(manifest)}`);
      const prior = this.db.prepare(`
        SELECT policy_version, manifest_digest FROM wallet_deep_history_managed_cohort_screenings
        WHERE cohort_id = ?
      `).get(id) as { policy_version: string; manifest_digest: string } | undefined;
      if (prior) {
        if (prior.policy_version !== policyVersion || prior.manifest_digest !== manifestDigest) {
          throw new Error("Managed cohort screening manifest cannot be overwritten.");
        }
        return false;
      }
      const details = {
        cohortId: id,
        generationId: raw.generation_id,
        targets: rows.length,
        exactEvidence: rows.filter((row) => row.evidence_digest !== null).length,
        coarseSkipped: rows.filter((row) => row.decision_digest !== null).length,
        policyVersion
      };
      this.db.prepare(`
        INSERT INTO wallet_deep_history_managed_cohort_screenings(
          cohort_id, generation_id, policy_version, manifest_digest, details_json, screened_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(id, raw.generation_id, policyVersion, manifestDigest, encode(details), at.toISOString());
      this.audit(
        "wallet_deep_history_cohort_managed_screened",
        "The managed scheduler exhausted a frozen cohort without claiming exact local completion.",
        { ...details, manifestDigest }
      );
      return true;
    })();
    if (changed) this.invalidateWalletPreScreenSurvivorCache();
    return changed;
  }

  markWalletDeepHistoryGenerationManagedScreened(
    id: string,
    policyVersion: string,
    at = new Date()
  ): boolean {
    if (!policyVersion.trim() || !Number.isFinite(at.getTime())) {
      throw new Error("Managed generation screening input is invalid.");
    }
    const changed = this.db.transaction(() => {
      const raw = this.db.prepare(`
        SELECT id, status FROM wallet_deep_history_generations WHERE id = ?
      `).get(id) as { id: string; status: "OPEN" | "COMPLETE" } | undefined;
      if (!raw || raw.status !== "OPEN") return false;
      const rows = this.db.prepare(`
        SELECT cohort.id, cohort.sequence, cohort.status,
               managed.manifest_digest AS managed_digest
        FROM wallet_deep_history_cohorts cohort
        LEFT JOIN wallet_deep_history_managed_cohort_screenings managed
          ON managed.cohort_id = cohort.id
        WHERE cohort.generation_id = ?
        ORDER BY cohort.sequence
      `).all(id) as Array<{
        id: string;
        sequence: number;
        status: "OPEN" | "COMPLETE";
        managed_digest: string | null;
      }>;
      if (rows.length === 0 || rows.some((row) => row.status !== "COMPLETE" && !row.managed_digest)) {
        return false;
      }
      const manifest = rows.map((row) => ({
        cohortId: row.id,
        sequence: row.sequence,
        kind: row.status === "COMPLETE" ? "EXACT_COMPLETE" : "MANAGED_SCREENED",
        digest: row.status === "COMPLETE" ? "EXACT_COMPLETE" : row.managed_digest
      }));
      const manifestDigest = sha256(`${policyVersion}\n${encode(manifest)}`);
      const prior = this.db.prepare(`
        SELECT policy_version, manifest_digest FROM wallet_deep_history_managed_generation_screenings
        WHERE generation_id = ?
      `).get(id) as { policy_version: string; manifest_digest: string } | undefined;
      if (prior) {
        if (prior.policy_version !== policyVersion || prior.manifest_digest !== manifestDigest) {
          throw new Error("Managed generation screening manifest cannot be overwritten.");
        }
        return false;
      }
      const details = {
        generationId: id,
        cohorts: rows.length,
        exactCohorts: rows.filter((row) => row.status === "COMPLETE").length,
        managedScreenedCohorts: rows.filter((row) => row.status !== "COMPLETE").length,
        policyVersion
      };
      this.db.prepare(`
        INSERT INTO wallet_deep_history_managed_generation_screenings(
          generation_id, policy_version, manifest_digest, details_json, screened_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(id, policyVersion, manifestDigest, encode(details), at.toISOString());
      this.audit(
        "wallet_deep_history_generation_managed_screened",
        "The managed scheduler exhausted a point-in-time generation without claiming exact local completion.",
        { ...details, manifestDigest }
      );
      return true;
    })();
    if (changed) this.invalidateWalletPreScreenSurvivorCache();
    return changed;
  }

  completeWalletDeepHistoryCohort(id: string, at = new Date()): boolean {
    const timestamp = at.toISOString();
    const changed = this.db.prepare(`
      UPDATE wallet_deep_history_cohorts
      SET status = 'COMPLETE', completed_at = ?
      WHERE id = ? AND status = 'OPEN'
        AND NOT EXISTS (
          SELECT 1 FROM wallet_deep_history_managed_cohort_screenings managed
          WHERE managed.cohort_id = wallet_deep_history_cohorts.id
        )
    `).run(timestamp, id).changes === 1;
    if (changed) this.invalidateWalletPreScreenSurvivorCache();
    return changed;
  }

  completeWalletDeepHistoryGeneration(id: string, at = new Date()): boolean {
    const timestamp = at.toISOString();
    const changed = this.db.transaction(() => {
      const generation = this.getWalletDeepHistoryGeneration(id);
      if (!generation || generation.status !== "OPEN") return false;
      const counts = this.db.prepare(`
        SELECT
          (SELECT COUNT(*) FROM wallet_deep_history_cohorts
           WHERE generation_id = ? AND status = 'OPEN') AS open_cohorts,
          (SELECT COUNT(*) FROM wallet_deep_history_targets
           WHERE generation_id = ?) AS targets,
          (SELECT COUNT(*) FROM wallet_deep_history_evidence
           WHERE generation_id = ?) AS evidence
      `).get(id, id, id) as { open_cohorts: number; targets: number; evidence: number };
      if (counts.open_cohorts > 0) return false;
      if (counts.targets === 0 || counts.evidence !== counts.targets) {
        return false;
      }
      return this.db.prepare(`
        UPDATE wallet_deep_history_generations
        SET status = 'COMPLETE', completed_at = ?
        WHERE id = ? AND status = 'OPEN'
      `).run(timestamp, id).changes === 1;
    })();
    if (changed) this.invalidateWalletPreScreenSurvivorCache();
    return changed;
  }

  saveWalletDeepHistoryEvidence(input: {
    generationId: string;
    cohortId: string;
    wallet: string;
    record: WalletIndexRecord;
    swaps: readonly IndexedSpotSwap[];
    frozenAt: string;
  }): WalletDeepHistoryEvidence {
    if (input.record.wallet !== input.wallet || !Number.isFinite(Date.parse(input.frozenAt))) {
      throw new Error("Deep-history frozen evidence is malformed.");
    }
    const swaps = [...input.swaps].sort((left, right) =>
      Date.parse(left.blockTime) - Date.parse(right.blockTime) ||
      left.slot - right.slot ||
      left.signature.localeCompare(right.signature) ||
      left.swapIndex - right.swapIndex ||
      left.id.localeCompare(right.id)
    );
    if (swaps.some((swap) => swap.wallet !== input.wallet)) {
      throw new Error("Deep-history frozen swap evidence belongs to another wallet.");
    }
    const recordJson = encode(input.record);
    const swapsJson = encode(swaps);
    const evidenceDigest = createHash("sha256")
      .update(recordJson)
      .update("\n")
      .update(swapsJson)
      .digest("hex");
    return this.db.transaction(() => {
      const target = this.db.prepare(`
        SELECT 1 FROM wallet_deep_history_targets
        WHERE generation_id = ? AND cohort_id = ? AND wallet = ?
      `).get(input.generationId, input.cohortId, input.wallet);
      if (!target) throw new Error("Deep-history frozen evidence has no matching target.");
      if (this.getWalletDeepHistoryTargetDisposition(input.cohortId, input.wallet)) {
        throw new Error("A coarsely skipped target cannot create exact deep-history evidence.");
      }
      const prior = this.getWalletDeepHistoryEvidence(input.generationId, input.wallet);
      if (prior) {
        if (prior.evidenceDigest !== evidenceDigest) {
          throw new Error("Frozen deep-history evidence cannot be overwritten with mutable inputs.");
        }
        return prior;
      }
      this.db.prepare(`
        INSERT INTO wallet_deep_history_evidence(
          generation_id, cohort_id, wallet, record_json, swaps_json, evidence_digest, frozen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.generationId,
        input.cohortId,
        input.wallet,
        recordJson,
        swapsJson,
        evidenceDigest,
        input.frozenAt
      );
      return {
        generationId: input.generationId,
        cohortId: input.cohortId,
        wallet: input.wallet,
        record: input.record,
        swaps,
        evidenceDigest,
        frozenAt: input.frozenAt
      };
    })();
  }

  getWalletDeepHistoryEvidence(
    generationId: string,
    wallet: string
  ): WalletDeepHistoryEvidence | undefined {
    const row = this.db.prepare(`
      SELECT generation_id, cohort_id, wallet, record_json, swaps_json, evidence_digest, frozen_at
      FROM wallet_deep_history_evidence
      WHERE generation_id = ? AND wallet = ?
    `).get(generationId, wallet) as {
      generation_id: string;
      cohort_id: string;
      wallet: string;
      record_json: string;
      swaps_json: string;
      evidence_digest: string;
      frozen_at: string;
    } | undefined;
    if (!row) return undefined;
    const actualDigest = createHash("sha256")
      .update(row.record_json)
      .update("\n")
      .update(row.swaps_json)
      .digest("hex");
    if (actualDigest !== row.evidence_digest) {
      throw new Error(`Frozen deep-history evidence digest mismatch for ${row.wallet}.`);
    }
    return {
      generationId: row.generation_id,
      cohortId: row.cohort_id,
      wallet: row.wallet,
      record: decode<WalletIndexRecord>(row.record_json),
      swaps: decode<IndexedSpotSwap[]>(row.swaps_json),
      evidenceDigest: row.evidence_digest,
      frozenAt: row.frozen_at
    };
  }

  hasWalletDeepHistoryEvidence(generationId: string, wallet: string): boolean {
    return Boolean(this.db.prepare(`
      SELECT 1 FROM wallet_deep_history_evidence
      WHERE generation_id = ? AND wallet = ?
    `).get(generationId, wallet));
  }

  countWalletDeepHistoryEvidence(generationId: string): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count FROM wallet_deep_history_evidence
      WHERE generation_id = ?
    `).get(generationId) as { count: number };
    return row.count;
  }

  listWalletDeepHistoryEvidenceSummaries(
    generationId: string,
    cohortId?: string
  ): WalletDeepHistoryEvidenceSummary[] {
    const rows = (cohortId
      ? this.db.prepare(`
          SELECT generation_id, cohort_id, wallet, record_json, evidence_digest, frozen_at
          FROM wallet_deep_history_evidence
          WHERE generation_id = ? AND cohort_id = ?
          ORDER BY wallet
        `).all(generationId, cohortId)
      : this.db.prepare(`
          SELECT generation_id, cohort_id, wallet, record_json, evidence_digest, frozen_at
          FROM wallet_deep_history_evidence
          WHERE generation_id = ? ORDER BY wallet
        `).all(generationId)) as WalletDeepHistoryEvidenceSummaryRow[];
    return rows.map(walletDeepHistoryEvidenceSummaryFromRow);
  }

  /**
   * Returns completed cohorts that still need their exact full handoff. One
   * anti-join replaces the former generation/cohort/evidence N+1 traversal.
   */
  listUnhandedCompletedWalletDeepHistoryCohortEvidence(): WalletDeepHistoryCompletedCohortEvidence[] {
    const rows = this.db.prepare(WALLET_DEEP_HISTORY_UNHANDED_COMPLETE_QUERY).all() as Array<{
      generation_id: string;
      generation_sequence: number;
      cohort_id: string;
      cohort_sequence: number;
      wallet: string | null;
      record_json: string | null;
      evidence_digest: string | null;
      frozen_at: string | null;
    }>;
    const grouped = new Map<string, WalletDeepHistoryCompletedCohortEvidence>();
    for (const row of rows) {
      let cohort = grouped.get(row.cohort_id);
      if (!cohort) {
        cohort = {
          cohortId: row.cohort_id,
          generationId: row.generation_id,
          cohortSequence: row.cohort_sequence,
          generationSequence: row.generation_sequence,
          evidence: []
        };
        grouped.set(row.cohort_id, cohort);
      } else if (
        cohort.generationId !== row.generation_id ||
        cohort.cohortSequence !== row.cohort_sequence ||
        cohort.generationSequence !== row.generation_sequence
      ) {
        throw new Error(`Completed deep-history cohort metadata is inconsistent for ${row.cohort_id}.`);
      }
      const nullableEvidence = [row.wallet, row.record_json, row.evidence_digest, row.frozen_at];
      if (nullableEvidence.every((value) => value === null)) continue;
      if (nullableEvidence.some((value) => value === null)) {
        throw new Error(`Completed deep-history evidence is incomplete for ${row.cohort_id}.`);
      }
      cohort.evidence.push(walletDeepHistoryEvidenceSummaryFromRow({
        generation_id: row.generation_id,
        cohort_id: row.cohort_id,
        wallet: row.wallet as string,
        record_json: row.record_json as string,
        evidence_digest: row.evidence_digest as string,
        frozen_at: row.frozen_at as string
      }));
    }
    return [...grouped.values()];
  }

  /**
   * Returns only open/managed-screened cohorts that contain immutable evidence.
   * One evidence-first join replaces the former list-all-cohorts plus one query
   * per cohort, while preserving cohort sequence and wallet ordering.
   */
  listOpenWalletDeepHistoryCohortEvidence(): WalletDeepHistoryOpenCohortEvidence[] {
    const rows = this.db.prepare(WALLET_DEEP_HISTORY_OPEN_EVIDENCE_QUERY).all() as Array<
      WalletDeepHistoryEvidenceSummaryRow & {
        cohort_sequence: number;
        cohort_status: "OPEN" | "MANAGED_SCREENED";
      }
    >;
    const grouped = new Map<string, WalletDeepHistoryOpenCohortEvidence>();
    for (const row of rows) {
      const summary = walletDeepHistoryEvidenceSummaryFromRow(row);
      const prior = grouped.get(row.cohort_id);
      if (prior) {
        if (
          prior.generationId !== row.generation_id ||
          prior.sequence !== row.cohort_sequence ||
          prior.status !== row.cohort_status
        ) throw new Error(`Frozen deep-history cohort metadata is inconsistent for ${row.cohort_id}.`);
        prior.evidence.push(summary);
        continue;
      }
      grouped.set(row.cohort_id, {
        cohortId: row.cohort_id,
        generationId: row.generation_id,
        sequence: row.cohort_sequence,
        status: row.cohort_status,
        evidence: [summary]
      });
    }
    return [...grouped.values()];
  }

  listWalletDeepHistoryEvidence(generationId: string): WalletDeepHistoryEvidence[] {
    const rows = this.db.prepare(`
      SELECT wallet FROM wallet_deep_history_evidence
      WHERE generation_id = ? ORDER BY wallet
    `).all(generationId) as Array<{ wallet: string }>;
    return rows.flatMap((row) => {
      const evidence = this.getWalletDeepHistoryEvidence(generationId, row.wallet);
      return evidence ? [evidence] : [];
    });
  }

  walletDeepHistoryQueueCoverage(wallet: string, cohortId?: string): WalletDeepHistoryQueueCoverage {
    const rows = cohortId
      ? this.db.prepare(`
          SELECT q.status, COUNT(*) AS count
          FROM wallet_deep_history_signatures manifest
          JOIN index_signature_queue q ON q.signature = manifest.signature
          WHERE manifest.wallet = ? AND manifest.cohort_id = ?
          GROUP BY q.status
        `).all(wallet, cohortId)
      : this.db.prepare(`
          SELECT q.status, COUNT(DISTINCT q.signature) AS count
          FROM index_signature_sources source
          JOIN index_signature_queue q ON q.signature = source.signature
          WHERE source.wallet = ? AND source.source = 'helius-wallet-deep-history'
          GROUP BY q.status
        `).all(wallet);
    const typedRows = rows as Array<{ status: WalletIndexQueueStatus; count: number }>;
    const coverage: WalletDeepHistoryQueueCoverage = {
      total: 0,
      pending: 0,
      leased: 0,
      processed: 0,
      retry: 0,
      failed: 0
    };
    for (const row of typedRows) {
      coverage.total += row.count;
      if (row.status === "PENDING") coverage.pending = row.count;
      else if (row.status === "LEASED") coverage.leased = row.count;
      else if (row.status === "PROCESSED") coverage.processed = row.count;
      else if (row.status === "RETRY") coverage.retry = row.count;
      else coverage.failed = row.count;
    }
    return coverage;
  }

  walletIdentityEvidenceCoverage(wallet: string, cohortId?: string): WalletIdentityEvidenceCoverage {
    const row = cohortId
      ? this.db.prepare(`
          SELECT
            COUNT(*) AS source_signatures,
            COUNT(CASE WHEN q.status = 'PROCESSED' THEN 1 END) AS processed_signatures,
            COUNT(evidence.signature) AS evidence_signatures
          FROM wallet_deep_history_signatures manifest
          JOIN index_signature_queue q ON q.signature = manifest.signature
          LEFT JOIN wallet_identity_transaction_evidence evidence
            ON evidence.signature = manifest.signature AND evidence.wallet = manifest.wallet
          WHERE manifest.wallet = ? AND manifest.cohort_id = ?
        `).get(wallet, cohortId)
      : this.db.prepare(`
          SELECT
            COUNT(DISTINCT source.signature) AS source_signatures,
            COUNT(DISTINCT CASE WHEN q.status = 'PROCESSED' THEN source.signature END) AS processed_signatures,
            COUNT(DISTINCT evidence.signature) AS evidence_signatures
          FROM index_signature_sources source
          JOIN index_signature_queue q ON q.signature = source.signature
          LEFT JOIN wallet_identity_transaction_evidence evidence
            ON evidence.signature = source.signature AND evidence.wallet = source.wallet
          WHERE source.wallet = ? AND source.source = 'helius-wallet-deep-history'
        `).get(wallet);
    const typedRow = row as {
      source_signatures: number;
      processed_signatures: number;
      evidence_signatures: number;
    };
    return {
      sourceSignatures: typedRow.source_signatures,
      processedSignatures: typedRow.processed_signatures,
      evidenceSignatures: typedRow.evidence_signatures,
      missingEvidence: Math.max(0, typedRow.source_signatures - typedRow.evidence_signatures)
    };
  }

  listWalletIdentityTransactionEvidence(
    wallet: string,
    windowStart: string,
    windowEnd: string
  ): WalletIdentityTransactionEvidenceRecord[] {
    if (!wallet.trim()) throw new Error("A wallet is required for identity evidence.");
    const start = Date.parse(windowStart);
    const end = Date.parse(windowEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
      throw new RangeError("Wallet identity evidence window is invalid.");
    }
    const rows = this.db.prepare(`
      SELECT evidence_json
      FROM wallet_identity_transaction_evidence
      WHERE wallet = ? AND block_time >= ? AND block_time <= ?
      ORDER BY block_time, signature
    `).all(wallet, windowStart, windowEnd) as Array<{ evidence_json: string }>;
    return rows.map((row) => decode<WalletIdentityTransactionEvidenceRecord>(row.evidence_json));
  }

  saveWalletIdentityFirstPool(evidence: JupiterFirstPoolEvidence): void {
    if (evidence.source !== "JUPITER" || !Number.isFinite(Date.parse(evidence.checkedAt))) {
      throw new Error("Wallet identity first-pool evidence is malformed.");
    }
    if (evidence.firstPoolAt !== null && !Number.isFinite(Date.parse(evidence.firstPoolAt))) {
      throw new Error("Wallet identity first-pool timestamp is malformed.");
    }
    this.db.prepare(`
      INSERT INTO wallet_identity_first_pools(mint, first_pool_at, source, checked_at)
      VALUES (?, ?, 'JUPITER', ?)
      ON CONFLICT(mint) DO UPDATE SET
        first_pool_at = excluded.first_pool_at,
        source = excluded.source,
        checked_at = excluded.checked_at
      WHERE excluded.checked_at >= wallet_identity_first_pools.checked_at
    `).run(evidence.mint, evidence.firstPoolAt, evidence.checkedAt);
  }

  getWalletIdentityFirstPool(mint: string): JupiterFirstPoolEvidence | undefined {
    const row = this.db.prepare(`
      SELECT mint, first_pool_at, checked_at
      FROM wallet_identity_first_pools WHERE mint = ?
    `).get(mint) as { mint: string; first_pool_at: string | null; checked_at: string } | undefined;
    return row ? {
      mint: row.mint,
      source: "JUPITER",
      firstPoolAt: row.first_pool_at,
      checkedAt: row.checked_at
    } : undefined;
  }

  listCoordinatedBuyEvidence(
    subjectSwaps: readonly WalletIdentitySwapEvidence[],
    maximumRowsPerSlot = 10_000
  ): CoordinatedBuyEvidenceResult {
    const limit = Math.max(1, Math.min(100_000, Math.trunc(maximumRowsPerSlot)));
    const rows: WalletIdentityCoordinatedBuyEvidence[] = [];
    const reasons: string[] = [];
    const seenGroups = new Set<string>();
    const seenRows = new Set<string>();
    const statement = this.db.prepare(`
      SELECT swap_json FROM indexed_spot_swaps
      WHERE side = 'BUY' AND slot = ? AND target_mint = ?
      ORDER BY wallet, signature, swap_index
      LIMIT ?
    `);
    for (const subject of subjectSwaps) {
      if (subject.side !== "BUY") continue;
      const group = `${subject.slot}:${subject.targetMint}`;
      if (seenGroups.has(group)) continue;
      seenGroups.add(group);
      const found = statement.all(subject.slot, subject.targetMint, limit + 1) as Array<{ swap_json: string }>;
      if (found.length > limit) {
        reasons.push(`coordinated-buy evidence exceeded ${limit} rows for slot ${subject.slot}`);
      }
      for (const row of found.slice(0, limit)) {
        const swap = decode<IndexedSpotSwap>(row.swap_json);
        const key = `${swap.signature}:${swap.wallet}:${swap.swapIndex}`;
        if (seenRows.has(key)) continue;
        seenRows.add(key);
        rows.push({
          signature: swap.signature,
          wallet: swap.wallet,
          slot: swap.slot,
          blockTime: swap.blockTime,
          side: swap.side,
          targetMint: swap.targetMint,
          outputAmountAtomic: swap.outputAmountAtomic
        });
      }
    }
    return { rows, complete: reasons.length === 0, reasons };
  }

  walletIdentityProgramSlotCoverage(
    programIds: readonly string[],
    slots: readonly number[]
  ): WalletIdentityProgramSlotCoverage {
    const reasons: string[] = [];
    const uniqueSlots = [...new Set(slots)].sort((left, right) => left - right);
    const pendingAtSlot = this.db.prepare(`
      SELECT COUNT(DISTINCT q.signature) AS count
      FROM index_signature_sources source
      JOIN index_signature_queue q ON q.signature = source.signature
      WHERE source.source_address = ? AND q.slot = ? AND q.status <> 'PROCESSED'
    `);
    for (const programId of [...new Set(programIds)].sort()) {
      const checkpoint = this.getWalletIndexCheckpoint("helius-jupiter-program-head", programId);
      const start = checkpoint?.metadata?.coverageStartSlot;
      const end = checkpoint?.metadata?.coverageEndSlot;
      if (
        typeof start !== "number" || !Number.isSafeInteger(start) || start < 0 ||
        typeof end !== "number" || !Number.isSafeInteger(end) || end < start ||
        checkpoint?.slot !== end
      ) {
        reasons.push(`program ${programId} has no committed continuous head range`);
        continue;
      }
      for (const slot of uniqueSlots) {
        if (!Number.isSafeInteger(slot) || slot < start || slot > end) {
          reasons.push(`program ${programId} head range does not cover slot ${slot}`);
          continue;
        }
        const row = pendingAtSlot.get(programId, slot) as { count: number };
        if (row.count > 0) {
          reasons.push(`program ${programId} still has unhydrated signatures at slot ${slot}`);
        }
      }
    }
    if (programIds.length === 0) reasons.push("no configured spot programs were supplied");
    return { complete: reasons.length === 0, reasons };
  }

  saveWalletActivitySample(sample: WalletActivitySample): void {
    this.db.prepare(`
      INSERT INTO wallet_activity_samples(
        wallet, period_start, period_end, sample_json, sampled_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(wallet, period_start, period_end) DO UPDATE SET
        sample_json = excluded.sample_json,
        sampled_at = excluded.sampled_at
      WHERE excluded.sampled_at >= wallet_activity_samples.sampled_at
    `).run(sample.wallet, sample.periodStart, sample.periodEnd, encode(sample), sample.sampledAt);
  }

  listWalletActivitySamples(wallet: string): WalletActivitySample[] {
    const rows = this.db.prepare(`
      SELECT sample_json FROM wallet_activity_samples WHERE wallet = ? ORDER BY period_start
    `).all(wallet) as Array<{ sample_json: string }>;
    return rows.map((row) => decode<WalletActivitySample>(row.sample_json));
  }

  saveWalletPreScreenSnapshot(snapshot: WalletPreScreenSnapshot): void {
    const changed = this.db.prepare(`
      INSERT INTO wallet_prescreen_snapshots(
        wallet, run_id, calculated_at, eligible, reasons_json, snapshot_json
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(wallet, run_id) DO UPDATE SET
        calculated_at = excluded.calculated_at,
        eligible = excluded.eligible,
        reasons_json = excluded.reasons_json,
        snapshot_json = excluded.snapshot_json
      WHERE excluded.calculated_at >= wallet_prescreen_snapshots.calculated_at
    `).run(
      snapshot.wallet,
      snapshot.runId,
      snapshot.calculatedAt,
      snapshot.eligible ? 1 : 0,
      encode(snapshot.reasons),
      encode(snapshot)
    ).changes > 0;
    if (changed) this.invalidateWalletPreScreenSurvivorCache();
  }

  commitWalletPreScreen(sample: WalletActivitySample, snapshot: WalletPreScreenSnapshot): void {
    if (sample.wallet !== snapshot.wallet || snapshot.record.wallet !== snapshot.wallet) {
      throw new Error("Wallet pre-screen sample, snapshot, and aggregate must have the same wallet.");
    }
    if (sample.sampledAt !== snapshot.calculatedAt || snapshot.record.updatedAt !== snapshot.calculatedAt) {
      throw new Error("Wallet pre-screen sample, snapshot, and aggregate must share one calculation time.");
    }
    this.db.transaction(() => {
      this.saveWalletActivitySample(sample);
      this.upsertWalletIndexRecord(snapshot.record);
      this.saveWalletPreScreenSnapshot(snapshot);
    })();
  }

  listWalletPreScreenSnapshots(runId: string, eligible?: boolean): WalletPreScreenSnapshot[] {
    const rows = eligible === undefined
      ? this.db.prepare(`
          SELECT snapshot_json FROM wallet_prescreen_snapshots
          WHERE run_id = ? ORDER BY calculated_at DESC, wallet
        `).all(runId)
      : this.db.prepare(`
          SELECT snapshot_json FROM wallet_prescreen_snapshots
          WHERE run_id = ? AND eligible = ? ORDER BY calculated_at DESC, wallet
        `).all(runId, eligible ? 1 : 0);
    return (rows as Array<{ snapshot_json: string }>).map((row) =>
      decode<WalletPreScreenSnapshot>(row.snapshot_json)
    );
  }

  listWalletPreScreenSnapshotsAtOrBefore(
    wallet: string,
    atOrBefore: string,
    limit = 1
  ): WalletPreScreenSnapshot[] {
    if (!wallet.trim() || !Number.isFinite(Date.parse(atOrBefore))) {
      throw new Error("Frozen wallet pre-screen lookup is invalid.");
    }
    const boundedLimit = Math.max(0, Math.min(100, Math.trunc(limit)));
    const rows = this.db.prepare(`
      SELECT snapshot_json FROM wallet_prescreen_snapshots
      WHERE wallet = ? AND calculated_at <= ?
      ORDER BY calculated_at DESC, run_id DESC
      LIMIT ?
    `).all(wallet, atOrBefore, boundedLimit) as Array<{ snapshot_json: string }>;
    return rows.map((row) => decode<WalletPreScreenSnapshot>(row.snapshot_json));
  }

  saveWalletHistoryReconciliation(snapshot: WalletHistoryReconciliationSnapshot): void {
    this.db.prepare(`
      INSERT INTO wallet_history_reconciliations(
        id, wallet, cohort_id, compared_at, status, comparable_metrics,
        mismatch_metrics, snapshot_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        comparable_metrics = excluded.comparable_metrics,
        mismatch_metrics = excluded.mismatch_metrics,
        snapshot_json = excluded.snapshot_json
    `).run(
      snapshot.id,
      snapshot.wallet,
      snapshot.cohortId,
      snapshot.comparedAt,
      snapshot.status,
      snapshot.comparableMetrics,
      snapshot.mismatchMetrics.length,
      encode(snapshot)
    );
  }

  listWalletHistoryReconciliations(
    wallet: string,
    cohortId?: string,
    limit = 100
  ): WalletHistoryReconciliationSnapshot[] {
    const boundedLimit = Math.max(0, Math.min(1_000, Math.trunc(limit)));
    const rows = cohortId === undefined
      ? this.db.prepare(`
          SELECT snapshot_json FROM wallet_history_reconciliations
          WHERE wallet = ? ORDER BY compared_at DESC, id DESC LIMIT ?
        `).all(wallet, boundedLimit)
      : this.db.prepare(`
          SELECT snapshot_json FROM wallet_history_reconciliations
          WHERE wallet = ? AND cohort_id = ? ORDER BY compared_at DESC, id DESC LIMIT ?
        `).all(wallet, cohortId, boundedLimit);
    return (rows as Array<{ snapshot_json: string }>).map((row) =>
      decode<WalletHistoryReconciliationSnapshot>(row.snapshot_json)
    );
  }

  /**
   * Compact durable revision for the expensive historical handoff scan.
   * Frozen evidence is immutable, so count plus the newest rowid detects its
   * append/delete boundary without scanning the large swaps_json payload.
   * Handoff and cohort/generation state complete the scheduling revision.
   */
  walletResearchHandoffScanRevision(): string {
    const row = this.db.prepare(`
      SELECT
        evidence.evidence_count,
        evidence.latest_evidence_rowid,
        handoff.handoff_count,
        handoff.latest_handoff_at,
        handoff.ready_count,
        handoff.running_count,
        handoff.retry_count,
        handoff.complete_count,
        cohort.cohort_count,
        cohort.complete_cohort_count,
        cohort.managed_cohort_count,
        cohort.latest_managed_cohort_at,
        generation.generation_count,
        generation.complete_generation_count,
        generation.managed_generation_count,
        generation.latest_managed_generation_at
      FROM (
        SELECT COUNT(*) AS evidence_count, COALESCE(MAX(rowid), 0) AS latest_evidence_rowid
        FROM wallet_deep_history_evidence
      ) evidence
      CROSS JOIN (
        SELECT
          COUNT(*) AS handoff_count,
          COALESCE(MAX(updated_at), '') AS latest_handoff_at,
          COALESCE(SUM(CASE WHEN status = 'READY' THEN 1 ELSE 0 END), 0) AS ready_count,
          COALESCE(SUM(CASE WHEN status = 'RUNNING' THEN 1 ELSE 0 END), 0) AS running_count,
          COALESCE(SUM(CASE WHEN status = 'RETRY' THEN 1 ELSE 0 END), 0) AS retry_count,
          COALESCE(SUM(CASE WHEN status = 'COMPLETE' THEN 1 ELSE 0 END), 0) AS complete_count
        FROM wallet_research_handoffs
      ) handoff
      CROSS JOIN (
        SELECT
          COUNT(*) AS cohort_count,
          COALESCE(SUM(CASE WHEN cohort.status = 'COMPLETE' THEN 1 ELSE 0 END), 0) AS complete_cohort_count,
          COUNT(managed.cohort_id) AS managed_cohort_count,
          COALESCE(MAX(managed.screened_at), '') AS latest_managed_cohort_at
        FROM wallet_deep_history_cohorts cohort
        LEFT JOIN wallet_deep_history_managed_cohort_screenings managed ON managed.cohort_id = cohort.id
      ) cohort
      CROSS JOIN (
        SELECT
          COUNT(*) AS generation_count,
          COALESCE(SUM(CASE WHEN generation.status = 'COMPLETE' THEN 1 ELSE 0 END), 0)
            AS complete_generation_count,
          COUNT(managed.generation_id) AS managed_generation_count,
          COALESCE(MAX(managed.screened_at), '') AS latest_managed_generation_at
        FROM wallet_deep_history_generations generation
        LEFT JOIN wallet_deep_history_managed_generation_screenings managed
          ON managed.generation_id = generation.id
      ) generation
    `).get() as {
      evidence_count: number;
      latest_evidence_rowid: number;
      handoff_count: number;
      latest_handoff_at: string;
      ready_count: number;
      running_count: number;
      retry_count: number;
      complete_count: number;
      cohort_count: number;
      complete_cohort_count: number;
      managed_cohort_count: number;
      latest_managed_cohort_at: string;
      generation_count: number;
      complete_generation_count: number;
      managed_generation_count: number;
      latest_managed_generation_at: string;
    };
    return [
      row.evidence_count,
      row.latest_evidence_rowid,
      row.handoff_count,
      row.latest_handoff_at,
      row.ready_count,
      row.running_count,
      row.retry_count,
      row.complete_count,
      row.cohort_count,
      row.complete_cohort_count,
      row.managed_cohort_count,
      row.latest_managed_cohort_at,
      row.generation_count,
      row.complete_generation_count,
      row.managed_generation_count,
      row.latest_managed_generation_at
    ].join(":");
  }

  enqueueWalletResearchHandoff(input: EnqueueWalletResearchHandoff): boolean {
    if (!input.generation.trim()) throw new Error("Wallet research generation is required.");
    if (!input.runId.trim()) throw new Error("Wallet research run id is required.");
    if (!Number.isFinite(Date.parse(input.readyAt))) throw new Error("Wallet research ready time is invalid.");
    const wallets = [...new Set(input.wallets.map((wallet) => wallet.trim()).filter(Boolean))];
    if (wallets.length !== input.wallets.length) {
      throw new Error("Wallet research handoff wallets must be unique, non-empty addresses.");
    }
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO wallet_research_handoffs(
        generation, run_id, status, wallets_json, ready_at, updated_at,
        attempts, next_attempt_at
      ) VALUES (?, ?, 'READY', ?, ?, ?, 0, ?)
    `).run(
      input.generation,
      input.runId,
      encode(wallets),
      input.readyAt,
      input.readyAt,
      input.readyAt
    );
    return result.changes === 1;
  }

  getWalletResearchHandoff(generation: string): WalletResearchHandoff | undefined {
    const row = this.db.prepare(`
      SELECT generation, run_id, status, wallets_json, ready_at, updated_at,
             attempts, next_attempt_at, last_error, completed_at, cohort_id
      FROM wallet_research_handoffs WHERE generation = ?
    `).get(generation) as WalletResearchHandoffRow | undefined;
    return row ? walletResearchHandoffFromRow(row) : undefined;
  }

  listWalletResearchHandoffs(limit = 25): WalletResearchHandoff[] {
    const rows = this.db.prepare(`
      SELECT generation, run_id, status, wallets_json, ready_at, updated_at,
             attempts, next_attempt_at, last_error, completed_at, cohort_id
      FROM wallet_research_handoffs
      ORDER BY ready_at DESC, generation LIMIT ?
    `).all(Math.max(0, Math.min(1_000, Math.trunc(limit)))) as WalletResearchHandoffRow[];
    return rows.map(walletResearchHandoffFromRow);
  }

  /** Complete, single-query preload used only after the durable scan revision changes. */
  listAllWalletResearchHandoffs(): WalletResearchHandoff[] {
    const rows = this.db.prepare(`
      SELECT generation, run_id, status, wallets_json, ready_at, updated_at,
             attempts, next_attempt_at, last_error, completed_at, cohort_id
      FROM wallet_research_handoffs
      ORDER BY ready_at DESC, generation
    `).all() as WalletResearchHandoffRow[];
    return rows.map(walletResearchHandoffFromRow);
  }

  hasPendingWalletResearchHandoffs(): boolean {
    return Boolean(this.db.prepare(`
      SELECT 1 FROM wallet_research_handoffs
      WHERE status <> 'COMPLETE' LIMIT 1
    `).get());
  }

  nextWalletResearchHandoffRetry(): WalletResearchHandoff | undefined {
    const row = this.db.prepare(`
      SELECT generation, run_id, status, wallets_json, ready_at, updated_at,
             attempts, next_attempt_at, last_error, completed_at, cohort_id
      FROM wallet_research_handoffs
      WHERE status = 'RETRY'
      ORDER BY next_attempt_at, generation LIMIT 1
    `).get() as WalletResearchHandoffRow | undefined;
    return row ? walletResearchHandoffFromRow(row) : undefined;
  }

  recoverRunningWalletResearchHandoffs(at = new Date()): number {
    const timestamp = at.toISOString();
    const recovered = this.db.prepare(`
      UPDATE wallet_research_handoffs SET
        status = 'RETRY',
        next_attempt_at = ?,
        last_error = COALESCE(last_error, 'Recovered after the app restarted during provider qualification.'),
        updated_at = ?
      WHERE status = 'RUNNING'
    `).run(timestamp, timestamp).changes;
    if (recovered > 0) this.invalidateWalletPreScreenSurvivorCache();
    return recovered;
  }

  claimWalletResearchHandoff(at = new Date()): WalletResearchHandoff | undefined {
    const timestamp = at.toISOString();
    return this.db.transaction(() => {
      const row = this.db.prepare(`
        SELECT generation FROM wallet_research_handoffs
        WHERE status IN ('READY', 'RETRY') AND next_attempt_at <= ?
        ORDER BY ready_at, generation LIMIT 1
      `).get(timestamp) as { generation: string } | undefined;
      if (!row) return undefined;
      const claimed = this.db.prepare(`
        UPDATE wallet_research_handoffs SET
          status = 'RUNNING', attempts = attempts + 1,
          last_error = NULL, updated_at = ?
        WHERE generation = ? AND status IN ('READY', 'RETRY') AND next_attempt_at <= ?
      `).run(timestamp, row.generation, timestamp);
      return claimed.changes === 1 ? this.getWalletResearchHandoff(row.generation) : undefined;
    })();
  }

  completeWalletResearchHandoff(
    generation: string,
    cohortId: string | undefined,
    at = new Date()
  ): boolean {
    const timestamp = at.toISOString();
    const changed = this.db.prepare(`
      UPDATE wallet_research_handoffs SET
        status = 'COMPLETE', completed_at = ?, cohort_id = ?,
        last_error = NULL, updated_at = ?
      WHERE generation = ? AND status = 'RUNNING'
    `).run(timestamp, cohortId ?? null, timestamp, generation).changes === 1;
    if (changed) this.invalidateWalletPreScreenSurvivorCache();
    return changed;
  }

  retryWalletResearchHandoff(
    generation: string,
    error: string,
    nextAttemptAt: Date,
    at = new Date()
  ): boolean {
    const timestamp = at.toISOString();
    return this.db.prepare(`
      UPDATE wallet_research_handoffs SET
        status = 'RETRY', next_attempt_at = ?, last_error = ?, updated_at = ?
      WHERE generation = ? AND status = 'RUNNING'
    `).run(nextAttemptAt.toISOString(), error.slice(0, 4_000), timestamp, generation).changes === 1;
  }

  upsertWalletIndexRun(run: WalletIndexRun): void {
    this.db.prepare(`
      INSERT INTO wallet_index_runs(
        id, stage, started_at, updated_at, finished_at, discovered_wallets,
        enqueued_signatures, hydrated_transactions, indexed_swaps,
        prescreened_wallets, qualified_wallets, run_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        stage = excluded.stage,
        updated_at = excluded.updated_at,
        finished_at = excluded.finished_at,
        discovered_wallets = excluded.discovered_wallets,
        enqueued_signatures = excluded.enqueued_signatures,
        hydrated_transactions = excluded.hydrated_transactions,
        indexed_swaps = excluded.indexed_swaps,
        prescreened_wallets = excluded.prescreened_wallets,
        qualified_wallets = excluded.qualified_wallets,
        run_json = excluded.run_json
      WHERE excluded.updated_at >= wallet_index_runs.updated_at
    `).run(
      run.id,
      run.stage,
      run.startedAt,
      run.updatedAt,
      run.finishedAt ?? null,
      run.discoveredWallets,
      run.enqueuedSignatures,
      run.hydratedTransactions,
      run.indexedSwaps,
      run.preScreenedWallets,
      run.structuralCandidates,
      encode(run)
    );
  }

  getWalletIndexRun(id: string): WalletIndexRun | undefined {
    const row = this.db.prepare("SELECT run_json FROM wallet_index_runs WHERE id = ?").get(id) as
      | { run_json: string }
      | undefined;
    return row ? decodeWalletIndexRun(row.run_json) : undefined;
  }

  listWalletIndexRuns(limit = 25): WalletIndexRun[] {
    const rows = this.db.prepare(`
      SELECT run_json FROM wallet_index_runs ORDER BY started_at DESC, id LIMIT ?
    `).all(Math.max(0, Math.min(1_000, Math.trunc(limit)))) as Array<{ run_json: string }>;
    return rows.map((row) => decodeWalletIndexRun(row.run_json));
  }

  listIndexedSpotSwaps(wallet?: string, limit = 1_000): IndexedSpotSwap[] {
    const boundedLimit = Math.max(0, Math.min(100_000, Math.trunc(limit)));
    const rows = wallet
      ? this.db.prepare(`
          SELECT swap_json FROM indexed_spot_swaps
          WHERE wallet = ? ORDER BY block_time DESC, swap_index LIMIT ?
        `).all(wallet, boundedLimit)
      : this.db.prepare(`
          SELECT swap_json FROM indexed_spot_swaps
          ORDER BY block_time DESC, signature, swap_index LIMIT ?
        `).all(boundedLimit);
    return (rows as Array<{ swap_json: string }>).map((row) => decode<IndexedSpotSwap>(row.swap_json));
  }

  nextPendingIndexedSwapReprice(at = new Date()): PendingIndexedSwapReprice | undefined {
    const timestamp = at.toISOString();
    const retainedAfter = new Date(
      at.getTime() - LOCAL_SOL_PRICE_HORIZON_MS - LOCAL_SOL_PRICE_TOLERANCE_MS
    ).toISOString();
    return this.db.transaction(() => {
      const row = this.db.prepare(`
        SELECT queue.swap_id, queue.attempts, queue.available_at, queue.last_error, swap.swap_json
        FROM indexed_swap_reprice_queue queue
        JOIN indexed_spot_swaps swap ON swap.id = queue.swap_id
        WHERE queue.status = 'PENDING' AND queue.available_at <= ?
          AND swap.block_time >= ?
        ORDER BY queue.available_at, queue.swap_id
        LIMIT 1
      `).get(timestamp, retainedAfter) as {
        swap_id: string;
        attempts: number;
        available_at: string;
        last_error: string | null;
        swap_json: string;
      } | undefined;
      if (!row) return undefined;
      this.db.prepare(`
        UPDATE indexed_swap_reprice_queue
        SET attempts = attempts + 1, updated_at = ?
        WHERE swap_id = ? AND status = 'PENDING'
      `).run(timestamp, row.swap_id);
      return {
        swap: decode<IndexedSpotSwap>(row.swap_json),
        attempts: row.attempts + 1,
        availableAt: row.available_at,
        ...(row.last_error ? { lastError: row.last_error } : {})
      };
    })();
  }

  completeIndexedSwapReprice(swapId: string, priceUsd: number, at = new Date()): boolean {
    if (!Number.isFinite(priceUsd) || priceUsd <= 0) throw new Error("Indexed swap reprice must be positive.");
    const timestamp = at.toISOString();
    return this.db.transaction(() => {
      const row = this.db.prepare(`
        SELECT swap_json FROM indexed_spot_swaps WHERE id = ?
      `).get(swapId) as { swap_json: string } | undefined;
      if (!row) return false;
      const swap = decode<IndexedSpotSwap>(row.swap_json);
      if (swap.baseMint !== SOL_MINT) throw new Error("Only SOL-legged swaps enter the reprice queue.");
      const updated = { ...swap, priceUsd };
      this.db.prepare(`
        UPDATE indexed_spot_swaps SET swap_json = ? WHERE id = ?
      `).run(encode(updated), swapId);
      const completed = this.db.prepare(`
        UPDATE indexed_swap_reprice_queue
        SET status = 'COMPLETE', last_error = NULL, updated_at = ?
        WHERE swap_id = ? AND status = 'PENDING'
      `).run(timestamp, swapId).changes === 1;
      if (completed) {
        this.db.prepare(`
          INSERT INTO wallet_index_dirty(wallet, marked_at, last_signature)
          VALUES (?, ?, ?)
          ON CONFLICT(wallet) DO UPDATE SET
            marked_at = excluded.marked_at,
            last_signature = excluded.last_signature
        `).run(swap.wallet, timestamp, swap.signature);
      }
      return completed;
    })();
  }

  retryIndexedSwapReprice(
    swapId: string,
    error: string,
    delayMs: number,
    at = new Date()
  ): boolean {
    if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error("Reprice retry delay is invalid.");
    const timestamp = at.toISOString();
    const availableAt = new Date(at.getTime() + delayMs).toISOString();
    return this.db.prepare(`
      UPDATE indexed_swap_reprice_queue
      SET available_at = ?, last_error = ?, updated_at = ?
      WHERE swap_id = ? AND status = 'PENDING'
    `).run(availableAt, error.slice(0, 1_000), timestamp, swapId).changes === 1;
  }

  pendingIndexedSwapReprices(wallet?: string, windowStart?: string, windowEnd?: string): number {
    if ((windowStart === undefined) !== (windowEnd === undefined)) {
      throw new Error("Reprice coverage requires both window bounds.");
    }
    if (wallet !== undefined) {
      const row = windowStart !== undefined && windowEnd !== undefined
        ? this.db.prepare(`
            SELECT COUNT(*) AS count
            FROM indexed_spot_swaps AS swap INDEXED BY indexed_spot_swaps_wallet_time
            WHERE swap.wallet = ? AND swap.block_time >= ? AND swap.block_time <= ?
              AND EXISTS (
                SELECT 1 FROM indexed_swap_reprice_queue AS queue
                WHERE queue.swap_id = swap.id AND queue.status = 'PENDING'
              )
          `).get(wallet, windowStart, windowEnd)
        : this.db.prepare(`
            SELECT COUNT(*) AS count
            FROM indexed_spot_swaps AS swap INDEXED BY indexed_spot_swaps_wallet_time
            WHERE swap.wallet = ?
              AND EXISTS (
                SELECT 1 FROM indexed_swap_reprice_queue AS queue
                WHERE queue.swap_id = swap.id AND queue.status = 'PENDING'
              )
          `).get(wallet);
      return (row as { count: number }).count;
    }
    const row = windowStart !== undefined && windowEnd !== undefined
      ? this.db.prepare(`
          SELECT COUNT(*) AS count
          FROM indexed_swap_reprice_queue AS queue
          JOIN indexed_spot_swaps AS swap INDEXED BY indexed_spot_swaps_reprice_time
            ON swap.id = queue.swap_id
          WHERE queue.status = 'PENDING'
            AND swap.block_time >= ? AND swap.block_time <= ?
        `).get(windowStart, windowEnd)
      : this.db.prepare(`
          SELECT COUNT(*) AS count FROM indexed_swap_reprice_queue
          WHERE status = 'PENDING'
        `).get();
    return (row as { count: number }).count;
  }

  listEligibleIndexedSpotSwapsBetween(
    wallet: string,
    windowStart: string,
    windowEnd: string
  ): IndexedSpotSwap[] {
    if (!wallet.trim()) throw new Error("A wallet is required for an indexed swap window.");
    const start = Date.parse(windowStart);
    const end = Date.parse(windowEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
      throw new RangeError("Indexed swap window timestamps are invalid.");
    }
    const rows = this.db.prepare(`
      SELECT swap_json FROM indexed_spot_swaps
      WHERE wallet = ? AND eligible = 1 AND block_time >= ? AND block_time <= ?
      ORDER BY block_time, slot, signature, swap_index, id
    `).all(wallet, windowStart, windowEnd) as Array<{ swap_json: string }>;
    return rows.map((row) => decode<IndexedSpotSwap>(row.swap_json));
  }

  listDirtyWalletIndexRecords(limit = 1_000): DirtyWalletIndexRecord[] {
    const boundedLimit = Math.max(0, Math.min(10_000, Math.trunc(limit)));
    const rows = this.db.prepare(`
      SELECT wallet, marked_at, last_signature
      FROM wallet_index_dirty
      ORDER BY marked_at, wallet
      LIMIT ?
    `).all(boundedLimit) as Array<{
      wallet: string;
      marked_at: string;
      last_signature: string;
    }>;
    return rows.map((row) => ({
      wallet: row.wallet,
      markedAt: row.marked_at,
      lastSignature: row.last_signature
    }));
  }

  clearDirtyWalletIndexRecord(wallet: string, markedAt: string, lastSignature: string): boolean {
    return this.db.prepare(`
      DELETE FROM wallet_index_dirty
      WHERE wallet = ? AND marked_at = ? AND last_signature = ?
    `).run(wallet, markedAt, lastSignature).changes === 1;
  }

  walletIndexCoverage(at = new Date()): WalletIndexCoverage {
    const rows = this.db.prepare(`
      SELECT metric, integer_value, text_value FROM wallet_index_metrics
    `).all() as Array<{
      metric: string;
      integer_value: number | null;
      text_value: string | null;
    }>;
    const metrics = new Map(rows.map((row) => [row.metric, row] as const));
    const integer = (metric: string): number => {
      const value = metrics.get(metric)?.integer_value;
      if (value === null || value === undefined) throw new Error(`Wallet index metric ${metric} is missing`);
      return value;
    };
    const queueByStatus: Record<WalletIndexQueueStatus, number> = {
      PENDING: integer("queue:PENDING"),
      LEASED: integer("queue:LEASED"),
      PROCESSED: integer("queue:PROCESSED"),
      RETRY: integer("queue:RETRY"),
      FAILED: integer("queue:FAILED")
    };
    const coverage: WalletIndexCoverage = {
      capturedAt: at.toISOString(),
      uniqueSignatures: integer("uniqueSignatures"),
      sourceLinks: integer("sourceLinks"),
      indexedTransactions: integer("indexedTransactions"),
      indexedSwaps: integer("indexedSwaps"),
      indexedWallets: integer("indexedWallets"),
      preScreenEligibleWallets: integer("preScreenEligibleWallets"),
      activitySamples: integer("activitySamples"),
      preScreenSnapshots: integer("preScreenSnapshots"),
      checkpoints: integer("checkpoints"),
      activeRuns: integer("activeRuns"),
      queueByStatus
    };
    const oldest = metrics.get("oldestBlockTime")?.text_value;
    const newest = metrics.get("newestBlockTime")?.text_value;
    if (oldest) coverage.oldestBlockTime = oldest;
    if (newest) coverage.newestBlockTime = newest;
    return coverage;
  }

  insertSourceEvent(event: LeaderSwap): boolean {
    const result = this.db
      .prepare(`
        INSERT OR IGNORE INTO source_events(signature, wallet, event_json, observed_at, recovered, processed)
        VALUES (?, ?, ?, ?, ?, 0)
      `)
      .run(
        event.sourceSignature,
        event.sourceWallet,
        encode(event),
        event.detectedAt,
        event.recovered ? 1 : 0
      );
    return result.changes === 1;
  }

  markSourceProcessed(signature: string, wallet: string): void {
    this.db.prepare("UPDATE source_events SET processed = 1 WHERE signature = ? AND wallet = ?").run(signature, wallet);
  }

  persistRejectedSourceOutcome(event: RejectedSourceAction, outcome: SignalAuditRecord): boolean {
    if (
      outcome.sourceSignature !== event.sourceSignature ||
      outcome.sourceWallet !== event.sourceWallet ||
      outcome.mint !== event.targetMint ||
      outcome.action !== event.side ||
      outcome.status !== "REJECTED"
    ) {
      throw new Error("A rejected source outcome did not match its immutable source event.");
    }
    const persist = this.db.transaction(() => {
      const existing = this.getSignalOutcome(outcome.idempotencyKey);
      this.db.prepare(`
        INSERT OR IGNORE INTO source_events(signature, wallet, event_json, observed_at, recovered, processed)
        VALUES (?, ?, ?, ?, ?, 1)
      `).run(
        event.sourceSignature,
        event.sourceWallet,
        encode(event),
        event.detectedAt,
        event.recovered ? 1 : 0
      );
      if (!existing) this.upsertSignalOutcome(outcome);
      this.markSourceProcessed(event.sourceSignature, event.sourceWallet);
      return existing === undefined;
    });
    return persist();
  }

  isSourceProcessed(signature: string, wallet: string): boolean {
    const row = this.db
      .prepare("SELECT processed FROM source_events WHERE signature = ? AND wallet = ?")
      .get(signature, wallet) as { processed: number } | undefined;
    return row?.processed === 1;
  }

  listUnprocessedSourceEvents(limit = 500): LeaderSwap[] {
    const rows = this.db
      .prepare("SELECT event_json FROM source_events WHERE processed = 0 ORDER BY observed_at LIMIT ?")
      .all(limit) as Array<{ event_json: string }>;
    return rows.map((row) => decode<LeaderSwap>(row.event_json));
  }

  latestSourceBlockTime(wallet: string): string | undefined {
    const row = this.db
      .prepare("SELECT event_json FROM source_events WHERE wallet = ? ORDER BY observed_at DESC LIMIT 1")
      .get(wallet) as { event_json: string } | undefined;
    return row ? decode<{ blockTime: string }>(row.event_json).blockTime : undefined;
  }

  ensureMonitoringRepairCheckpoint(
    wallet: string,
    cursorAt: string,
    at = nowIso()
  ): MonitoringRepairCheckpoint {
    this.db.prepare(`
      INSERT OR IGNORE INTO monitoring_repair_checkpoints(
        wallet, cursor_at, status, failure_count, updated_at
      ) VALUES (?, ?, 'PENDING', 0, ?)
    `).run(wallet, cursorAt, at);
    const checkpoint = this.getMonitoringRepairCheckpoint(wallet);
    if (!checkpoint) throw new Error(`Monitoring repair checkpoint was not persisted for ${wallet}`);
    return checkpoint;
  }

  getMonitoringRepairCheckpoint(wallet: string): MonitoringRepairCheckpoint | undefined {
    const row = this.db.prepare(`
      SELECT wallet, cursor_at, status, attempt_started_at, last_succeeded_at,
             next_retry_at, failure_count, last_error, updated_at
      FROM monitoring_repair_checkpoints WHERE wallet = ?
    `).get(wallet) as {
      wallet: string;
      cursor_at: string;
      status: MonitoringRepairStatus;
      attempt_started_at: string | null;
      last_succeeded_at: string | null;
      next_retry_at: string | null;
      failure_count: number;
      last_error: string | null;
      updated_at: string;
    } | undefined;
    if (!row) return undefined;
    return {
      wallet: row.wallet,
      cursorAt: row.cursor_at,
      status: row.status,
      failureCount: row.failure_count,
      updatedAt: row.updated_at,
      ...(row.attempt_started_at ? { attemptStartedAt: row.attempt_started_at } : {}),
      ...(row.last_succeeded_at ? { lastSucceededAt: row.last_succeeded_at } : {}),
      ...(row.next_retry_at ? { nextRetryAt: row.next_retry_at } : {}),
      ...(row.last_error ? { lastError: row.last_error } : {})
    };
  }

  startMonitoringRepair(wallet: string, expectedCursorAt: string, attemptStartedAt: string): boolean {
    const result = this.db.prepare(`
      UPDATE monitoring_repair_checkpoints
      SET status = 'PENDING', attempt_started_at = ?, next_retry_at = NULL,
          last_error = NULL, updated_at = ?
      WHERE wallet = ? AND cursor_at = ?
    `).run(attemptStartedAt, attemptStartedAt, wallet, expectedCursorAt);
    return result.changes === 1;
  }

  completeMonitoringRepair(
    wallet: string,
    expectedCursorAt: string,
    nextCursorAt: string,
    completedAt = nowIso()
  ): boolean {
    const result = this.db.prepare(`
      UPDATE monitoring_repair_checkpoints
      SET cursor_at = ?, status = 'READY', last_succeeded_at = ?,
          next_retry_at = NULL, failure_count = 0, last_error = NULL, updated_at = ?
      WHERE wallet = ? AND cursor_at = ? AND status = 'PENDING'
    `).run(nextCursorAt, completedAt, completedAt, wallet, expectedCursorAt);
    return result.changes === 1;
  }

  failMonitoringRepair(
    wallet: string,
    expectedCursorAt: string,
    nextRetryAt: string,
    lastError: string,
    failedAt = nowIso()
  ): boolean {
    const result = this.db.prepare(`
      UPDATE monitoring_repair_checkpoints
      SET status = 'FAILED', next_retry_at = ?, failure_count = failure_count + 1,
          last_error = ?, updated_at = ?
      WHERE wallet = ? AND cursor_at = ?
    `).run(nextRetryAt, lastError, failedAt, wallet, expectedCursorAt);
    return result.changes === 1;
  }

  saveDecision(
    id: string,
    intent: CopyIntent,
    token: TokenEligibility | undefined,
    decision: RiskDecision,
    mode: ExecutionMode = "PAPER",
    action: SignalOutcomeAction = intent.side,
    reasonCode: SignalOutcomeReasonCode = decision.allowed ? "RISK_ALLOWED" : "RISK_REJECTED"
  ): void {
    this.db.transaction(() => {
      this.db
        .prepare(`
          INSERT OR IGNORE INTO signal_decisions(
            id, source_signature, source_wallet, idempotency_key, intent_json, token_json, decision_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          id,
          intent.sourceSwap.sourceSignature,
          intent.sourceSwap.sourceWallet,
          intent.idempotencyKey,
          encode(intent),
          token ? encode(token) : null,
          encode(decision),
          decision.decidedAt
        );
      this.upsertSignalOutcome({
        id: intent.idempotencyKey,
        idempotencyKey: intent.idempotencyKey,
        sourceSignature: intent.sourceSwap.sourceSignature,
        sourceWallet: intent.sourceSwap.sourceWallet,
        mint: intent.sourceSwap.targetMint,
        action,
        mode,
        status: decision.allowed ? "QUEUED" : "REJECTED",
        reasonCode,
        reason: decision.reasons[0] ?? (decision.allowed
          ? "Risk checks allowed this source action."
          : "Risk checks rejected this source action."),
        sourceBlockTime: intent.sourceSwap.blockTime,
        observedAt: intent.sourceSwap.detectedAt,
        updatedAt: decision.decidedAt,
        decisionCode: decision.code,
        positionValueUsd: intent.inputAmountUsd
      });
    })();
  }

  upsertSignalOutcome(outcome: SignalAuditRecord): void {
    const existing = this.getSignalOutcome(outcome.idempotencyKey);
    if (existing) {
      if (
        existing.sourceSignature !== outcome.sourceSignature ||
        existing.sourceWallet !== outcome.sourceWallet ||
        existing.mint !== outcome.mint ||
        existing.action !== outcome.action ||
        existing.mode !== outcome.mode
      ) {
        throw new Error("A signal outcome update changed immutable source identity fields.");
      }
      const existingAt = Date.parse(existing.updatedAt);
      const nextAt = Date.parse(outcome.updatedAt);
      if (
        (Number.isFinite(existingAt) && Number.isFinite(nextAt) && nextAt < existingAt) ||
        !signalOutcomeTransitionAllowed(existing.status, outcome.status)
      ) return;
    }
    this.db.prepare(`
      INSERT INTO signal_outcomes(
        idempotency_key, source_signature, source_wallet, mint, action, mode,
        status, reason_code, reason, source_block_time, observed_at, updated_at,
        decision_code, execution_id, target_signature, position_value_usd,
        price_impact_percent, actual_fees_usd, implementation_shortfall_percent
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(idempotency_key) DO UPDATE SET
        status = excluded.status,
        reason_code = excluded.reason_code,
        reason = excluded.reason,
        updated_at = excluded.updated_at,
        decision_code = COALESCE(excluded.decision_code, signal_outcomes.decision_code),
        execution_id = COALESCE(excluded.execution_id, signal_outcomes.execution_id),
        target_signature = COALESCE(excluded.target_signature, signal_outcomes.target_signature),
        position_value_usd = COALESCE(excluded.position_value_usd, signal_outcomes.position_value_usd),
        price_impact_percent = COALESCE(excluded.price_impact_percent, signal_outcomes.price_impact_percent),
        actual_fees_usd = COALESCE(excluded.actual_fees_usd, signal_outcomes.actual_fees_usd),
        implementation_shortfall_percent = COALESCE(
          excluded.implementation_shortfall_percent,
          signal_outcomes.implementation_shortfall_percent
        )
    `).run(
      outcome.idempotencyKey,
      outcome.sourceSignature,
      outcome.sourceWallet,
      outcome.mint,
      outcome.action,
      outcome.mode,
      outcome.status,
      outcome.reasonCode,
      redactSensitiveText(outcome.reason, 1_000),
      outcome.sourceBlockTime,
      outcome.observedAt,
      outcome.updatedAt,
      outcome.decisionCode ?? null,
      outcome.executionId ?? null,
      outcome.targetSignature ?? null,
      outcome.positionValueUsd ?? null,
      outcome.priceImpactPercent ?? null,
      outcome.actualFeesUsd ?? null,
      outcome.implementationShortfallPercent ?? null
    );
  }

  getSignalOutcome(idempotencyKey: string): SignalAuditRecord | undefined {
    const row = this.db.prepare(`
      SELECT * FROM signal_outcomes WHERE idempotency_key = ?
    `).get(idempotencyKey) as SignalOutcomeRow | undefined;
    return row ? decodeSignalOutcome(row) : undefined;
  }

  listSignalOutcomes(limit = 100): SignalAuditRecord[] {
    const boundedLimit = Math.max(0, Math.min(500, Math.trunc(limit)));
    const rows = this.db.prepare(`
      SELECT * FROM signal_outcomes
      ORDER BY updated_at DESC, idempotency_key DESC
      LIMIT ?
    `).all(boundedLimit) as SignalOutcomeRow[];
    return rows.map(decodeSignalOutcome);
  }

  saveQuote(quote: QuoteSnapshot, purpose: "entry" | "exit", sourceSignature?: string): void {
    this.db
      .prepare(`
        INSERT OR REPLACE INTO quotes(request_id, source_signature, purpose, quote_json, quoted_at)
        VALUES (?, ?, ?, ?, ?)
      `)
      .run(quote.requestId, sourceSignature ?? null, purpose, encode(quote), quote.quotedAt);
  }

  upsertExecution(execution: ExecutionRecord): void {
    this.db.transaction(() => {
      this.db
        .prepare(`
          INSERT INTO executions(id, idempotency_key, status, mode, execution_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            status = excluded.status,
            execution_json = excluded.execution_json,
            updated_at = excluded.updated_at
        `)
        .run(
          execution.id,
          execution.idempotencyKey,
          execution.status,
          execution.mode,
          encode(execution),
          execution.createdAt,
          execution.updatedAt
        );
      this.updateSignalOutcomeFromExecution(execution);
    })();
  }

  private updateSignalOutcomeFromExecution(execution: ExecutionRecord): void {
    const existing = this.getSignalOutcome(execution.idempotencyKey);
    const context = existing ? undefined : this.getOrderContext(execution.idempotencyKey);
    if (!existing && !context) return;
    const intent = context?.intent;
    const status: SignalOutcomeStatus = execution.mode === "PAPER" && execution.status === "CONFIRMED"
      ? "SIMULATED"
      : execution.status === "SKIPPED" || execution.status === "REJECTED"
        ? "REJECTED"
        : execution.status;
    let reasonCode: SignalOutcomeReasonCode;
    if (status === "SIMULATED") reasonCode = "PAPER_SIMULATION";
    else if (status === "AWAITING_APPROVAL") reasonCode = "LIVE_APPROVAL_REQUIRED";
    else if (status === "APPROVED") reasonCode = "LIVE_APPROVED";
    else if (status === "QUEUED") reasonCode = "LIVE_QUEUED";
    else if (status === "SUBMITTED") reasonCode = "LIVE_SUBMITTED";
    else if (status === "SUBMITTED_UNRESOLVED") reasonCode = "SUBMISSION_UNRESOLVED";
    else if (status === "CONFIRMED") reasonCode = "LIVE_CONFIRMED";
    else if (status === "FAILED") reasonCode = "EXECUTION_FAILED";
    else if (status === "REJECTED" && /emergency exit/iu.test(execution.failureReason ?? "")) {
      reasonCode = "EMERGENCY_CANCELLED";
    } else if (status === "REJECTED" && execution.status === "REJECTED") reasonCode = "USER_REJECTED";
    else reasonCode = existing?.reasonCode ?? "RISK_REJECTED";
    const reason = execution.failureReason
      ?? (status === "SIMULATED"
        ? "Paper trade simulated and recorded without signing."
        : status === "CONFIRMED"
          ? "Live transaction confirmed."
          : status === "AWAITING_APPROVAL"
            ? "Manual approval is required before signing."
            : status === "SUBMITTED"
              ? "Signed transaction submitted for confirmation."
              : status === "APPROVED"
                ? "Manual approval recorded."
                : status === "QUEUED"
                  ? "Live transaction queued for signing."
                  : existing?.reason ?? "Execution state updated.");
    this.upsertSignalOutcome({
      id: execution.idempotencyKey,
      idempotencyKey: execution.idempotencyKey,
      sourceSignature: existing?.sourceSignature ?? intent!.sourceSwap.sourceSignature,
      sourceWallet: existing?.sourceWallet ?? intent!.sourceSwap.sourceWallet,
      mint: existing?.mint ?? intent!.sourceSwap.targetMint,
      action: existing?.action ?? intent!.side,
      mode: execution.mode,
      status,
      reasonCode,
      reason,
      sourceBlockTime: existing?.sourceBlockTime ?? intent!.sourceSwap.blockTime,
      observedAt: existing?.observedAt ?? intent!.sourceSwap.detectedAt,
      updatedAt: execution.updatedAt,
      ...(existing?.decisionCode ?? context?.decision.code
        ? { decisionCode: existing?.decisionCode ?? context!.decision.code }
        : {}),
      executionId: execution.id,
      ...(execution.targetSignature ? { targetSignature: execution.targetSignature } : {}),
      positionValueUsd: existing?.positionValueUsd ?? intent?.inputAmountUsd ?? execution.quote.inputUsd,
      priceImpactPercent: execution.quote.priceImpactPercent,
      ...(execution.actualFeesUsd !== undefined ? { actualFeesUsd: execution.actualFeesUsd } : {}),
      ...(execution.implementationShortfallPercent !== undefined
        ? { implementationShortfallPercent: execution.implementationShortfallPercent }
        : {})
    });
  }

  getExecution(id: string): ExecutionRecord | undefined {
    const row = this.db.prepare("SELECT execution_json FROM executions WHERE id = ?").get(id) as
      | { execution_json: string }
      | undefined;
    return row ? decode<ExecutionRecord>(row.execution_json) : undefined;
  }

  getExecutionByIdempotencyKey(idempotencyKey: string): ExecutionRecord | undefined {
    const row = this.db
      .prepare("SELECT execution_json FROM executions WHERE idempotency_key = ?")
      .get(idempotencyKey) as { execution_json: string } | undefined;
    return row ? decode<ExecutionRecord>(row.execution_json) : undefined;
  }

  getOrderContext(idempotencyKey: string):
    | { intent: CopyIntent; token?: TokenEligibility; decision: RiskDecision }
    | undefined {
    const row = this.db.prepare(`
      SELECT intent_json, token_json, decision_json
      FROM signal_decisions WHERE idempotency_key = ?
    `).get(idempotencyKey) as
      | { intent_json: string; token_json: string | null; decision_json: string }
      | undefined;
    if (!row) return undefined;
    return {
      intent: decode<CopyIntent>(row.intent_json),
      ...(row.token_json ? { token: decode<TokenEligibility>(row.token_json) } : {}),
      decision: decode<RiskDecision>(row.decision_json)
    };
  }

  listExecutions(limit = 100, pendingOnly = false): ExecutionRecord[] {
    const condition = pendingOnly ? "WHERE status = 'AWAITING_APPROVAL'" : "";
    const rows = this.db
      .prepare(`SELECT execution_json FROM executions ${condition} ORDER BY created_at DESC LIMIT ?`)
      .all(limit) as Array<{ execution_json: string }>;
    return rows.map((row) => decode<ExecutionRecord>(row.execution_json));
  }

  listUnappliedConfirmedExecutions(): ExecutionRecord[] {
    const rows = this.db.prepare(`
      SELECT e.execution_json
      FROM executions e
      LEFT JOIN execution_applications a ON a.execution_id = e.id
      WHERE e.status = 'CONFIRMED' AND a.execution_id IS NULL
      ORDER BY e.created_at
    `).all() as Array<{ execution_json: string }>;
    return rows.map((row) => decode<ExecutionRecord>(row.execution_json));
  }

  listSubmittedExecutions(): ExecutionRecord[] {
    const rows = this.db
      .prepare(
        "SELECT execution_json FROM executions WHERE status IN ('SUBMITTED', 'SUBMITTED_UNRESOLVED') ORDER BY created_at"
      )
      .all() as Array<{ execution_json: string }>;
    return rows.map((row) => decode<ExecutionRecord>(row.execution_json));
  }

  beginEmergencyLiquidation(reason: string): EmergencyLiquidationRecord {
    const existing = this.latestEmergencyLiquidation();
    if (existing && existing.state !== "LOCKED_COMPLETE") {
      const updatedAt = nowIso();
      this.db.prepare(`
        UPDATE emergency_liquidations
        SET state = 'LIQUIDATING', reason = ?, updated_at = ?, finished_at = NULL
        WHERE id = ?
      `).run(reason, updatedAt, existing.id);
      const { finishedAt: _finishedAt, ...active } = existing;
      return { ...active, state: "LIQUIDATING", reason, updatedAt };
    }
    const at = nowIso();
    const record: EmergencyLiquidationRecord = {
      id: randomUUID(),
      state: "LIQUIDATING",
      reason,
      startedAt: at,
      updatedAt: at,
      closedPositions: 0,
      failedPositions: 0
    };
    this.db.prepare(`
      INSERT INTO emergency_liquidations(
        id, state, reason, started_at, updated_at, closed_positions, failed_positions
      ) VALUES (?, ?, ?, ?, ?, 0, 0)
    `).run(record.id, record.state, record.reason, record.startedAt, record.updatedAt);
    return record;
  }

  latestEmergencyLiquidation(): EmergencyLiquidationRecord | undefined {
    const row = this.db.prepare(`
      SELECT id, state, reason, started_at, updated_at, finished_at, closed_positions, failed_positions
      FROM emergency_liquidations ORDER BY started_at DESC LIMIT 1
    `).get() as EmergencyLiquidationRow | undefined;
    return row ? emergencyLiquidationFromRow(row) : undefined;
  }

  finishEmergencyLiquidation(
    id: string,
    state: Extract<EmergencyLiquidationState, "LOCKED_COMPLETE" | "LOCKED_INCOMPLETE">,
    closedPositions: number,
    failedPositions: number
  ): EmergencyLiquidationRecord {
    const at = nowIso();
    this.db.prepare(`
      UPDATE emergency_liquidations
      SET state = ?, updated_at = ?, finished_at = ?, closed_positions = ?, failed_positions = ?
      WHERE id = ?
    `).run(state, at, at, closedPositions, failedPositions, id);
    const record = this.latestEmergencyLiquidation();
    if (!record || record.id !== id) throw new Error("Emergency liquidation record was not found.");
    return record;
  }

  getEmergencyExitOperation(positionId: string): EmergencyExitOperation | undefined {
    const row = this.db.prepare(`
      SELECT operation_id, liquidation_id, position_id, attempt, idempotency_key, source_signature,
             state, execution_id, target_signature, last_error, created_at, updated_at
      FROM emergency_exit_operations WHERE position_id = ?
    `).get(positionId) as EmergencyExitOperationRow | undefined;
    return row ? emergencyOperationFromRow(row) : undefined;
  }

  listEmergencyExitOperations(
    states?: readonly EmergencyExitOperationState[]
  ): EmergencyExitOperation[] {
    const allowed = new Set<EmergencyExitOperationState>([
      "PENDING",
      "SUBMITTED_UNRESOLVED",
      "CONFIRMED",
      "FAILED_SAFE"
    ]);
    if (states?.some((state) => !allowed.has(state))) throw new Error("Unknown emergency operation state.");
    const placeholders = states?.length ? states.map(() => "?").join(", ") : "";
    const where = states?.length ? `WHERE state IN (${placeholders})` : "";
    const rows = this.db.prepare(`
      SELECT operation_id, liquidation_id, position_id, attempt, idempotency_key, source_signature,
             state, execution_id, target_signature, last_error, created_at, updated_at
      FROM emergency_exit_operations ${where} ORDER BY created_at, operation_id
    `).all(...(states ?? [])) as EmergencyExitOperationRow[];
    return rows.map(emergencyOperationFromRow);
  }

  startEmergencyExitAttempt(input: {
    liquidationId: string;
    positionId: string;
    idempotencyKey: string;
    sourceSignature: string;
  }): EmergencyExitOperation {
    const existing = this.getEmergencyExitOperation(input.positionId);
    if (existing && existing.state !== "FAILED_SAFE") return existing;
    const at = nowIso();
    const attempt = existing ? existing.attempt + 1 : 1;
    const operationId = existing?.operationId ?? `emergency-exit:${input.positionId}`;
    this.db.prepare(`
      INSERT INTO emergency_exit_operations(
        operation_id, liquidation_id, position_id, attempt, idempotency_key, source_signature,
        state, execution_id, target_signature, last_error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'PENDING', NULL, NULL, NULL, ?, ?)
      ON CONFLICT(operation_id) DO UPDATE SET
        liquidation_id = excluded.liquidation_id,
        attempt = excluded.attempt,
        idempotency_key = excluded.idempotency_key,
        source_signature = excluded.source_signature,
        state = 'PENDING',
        execution_id = NULL,
        target_signature = NULL,
        last_error = NULL,
        updated_at = excluded.updated_at
    `).run(
      operationId,
      input.liquidationId,
      input.positionId,
      attempt,
      input.idempotencyKey,
      input.sourceSignature,
      existing?.createdAt ?? at,
      at
    );
    return this.getEmergencyExitOperation(input.positionId)!;
  }

  updateEmergencyExitOperation(
    positionId: string,
    state: EmergencyExitOperationState,
    details: { executionId?: string; targetSignature?: string; lastError?: string } = {}
  ): EmergencyExitOperation {
    const at = nowIso();
    const result = this.db.prepare(`
      UPDATE emergency_exit_operations
      SET state = ?, execution_id = COALESCE(?, execution_id),
          target_signature = COALESCE(?, target_signature), last_error = ?, updated_at = ?
      WHERE position_id = ?
    `).run(
      state,
      details.executionId ?? null,
      details.targetSignature ?? null,
      details.lastError ?? null,
      at,
      positionId
    );
    if (result.changes !== 1) throw new Error("Emergency exit operation was not found.");
    return this.getEmergencyExitOperation(positionId)!;
  }

  isExecutionApplied(executionId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 AS ok FROM execution_applications WHERE execution_id = ?").get(executionId));
  }

  markExecutionApplied(executionId: string): void {
    this.db
      .prepare("INSERT OR IGNORE INTO execution_applications(execution_id, applied_at) VALUES (?, ?)")
      .run(executionId, nowIso());
  }

  upsertPosition(position: PositionLot): void {
    this.db
      .prepare(`
        INSERT INTO positions(id, mode, mint, status, position_json, updated_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET status = excluded.status, position_json = excluded.position_json, updated_at = excluded.updated_at
      `)
      .run(position.id, position.mode, position.mint, position.status, encode(position), nowIso());
  }

  listPositions(mode?: "PAPER" | "LIVE", openOnly = false): PositionLot[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (mode) {
      clauses.push("mode = ?");
      params.push(mode);
    }
    if (openOnly) clauses.push("status IN ('OPEN', 'CLOSING')");
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT position_json FROM positions ${where} ORDER BY updated_at DESC`)
      .all(...params) as Array<{ position_json: string }>;
    return rows.map((row) => decode<PositionLot>(row.position_json));
  }

  savePortfolioSnapshot(snapshot: PortfolioSnapshot): void {
    this.db
      .prepare(`
        INSERT INTO portfolio_snapshots(mode, captured_at, evaluation_cohort_id, snapshot_json)
        VALUES (?, ?, ?, ?)
      `)
      .run(snapshot.mode, snapshot.capturedAt, snapshot.evaluationCohortId ?? null, encode(snapshot));
  }

  latestPortfolioSnapshot(mode: "PAPER" | "LIVE"): PortfolioSnapshot | undefined {
    const row = this.db
      .prepare(
        "SELECT snapshot_json FROM portfolio_snapshots WHERE mode = ? ORDER BY captured_at DESC LIMIT 1"
      )
      .get(mode) as { snapshot_json: string } | undefined;
    return row ? decode<PortfolioSnapshot>(row.snapshot_json) : undefined;
  }

  listPortfolioSnapshots(mode: "PAPER" | "LIVE", evaluationCohortId: string): PortfolioSnapshot[] {
    const rows = this.db.prepare(`
      SELECT snapshot_json FROM portfolio_snapshots
      WHERE mode = ? AND evaluation_cohort_id = ? ORDER BY captured_at
    `).all(mode, evaluationCohortId) as Array<{ snapshot_json: string }>;
    return rows.map((row) => decode<PortfolioSnapshot>(row.snapshot_json));
  }

  audit(
    eventType: string,
    message: string,
    details?: unknown,
    severity: "info" | "warning" | "critical" = "info"
  ): void {
    this.db
      .prepare(
        "INSERT INTO audit_events(event_type, severity, message, details_json, created_at) VALUES (?, ?, ?, ?, ?)"
      )
      .run(eventType, severity, message, details === undefined ? null : encode(details), nowIso());
  }

  listAudit(limit = 100): Array<{
    id: number;
    eventType: string;
    severity: string;
    message: string;
    details?: unknown;
    createdAt: string;
  }> {
    const rows = this.db
      .prepare(
        "SELECT id, event_type, severity, message, details_json, created_at FROM audit_events ORDER BY id DESC LIMIT ?"
      )
      .all(limit) as Array<{
      id: number;
      event_type: string;
      severity: string;
      message: string;
      details_json: string | null;
      created_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      eventType: row.event_type,
      severity: row.severity,
      message: row.message,
      ...(row.details_json ? { details: decode<unknown>(row.details_json) } : {}),
      createdAt: row.created_at
    }));
  }

  incrementUsage(provider: string, credits = 0, at = new Date()): void {
    const date = at.toISOString().slice(0, 10);
    this.db
      .prepare(`
        INSERT INTO provider_usage(provider, usage_date, requests, credits) VALUES (?, ?, 1, ?)
        ON CONFLICT(provider, usage_date) DO UPDATE SET requests = requests + 1, credits = credits + excluded.credits
      `)
      .run(provider, date, credits);
  }

  usageSince(isoDate: string): Array<{ provider: string; requests: number; credits: number }> {
    return this.db
      .prepare(`
        SELECT provider, SUM(requests) AS requests, SUM(credits) AS credits
        FROM provider_usage WHERE usage_date >= ? GROUP BY provider ORDER BY provider
      `)
      .all(isoDate) as Array<{ provider: string; requests: number; credits: number }>;
  }

  saveProviderParityObservation(observation: ProviderParityObservation): number {
    if (!Number.isFinite(Date.parse(observation.observedAt))) {
      throw new Error("Provider parity observation time is invalid.");
    }
    return this.db.transaction(() => {
      const proof = observation.proof;
      if (proof) {
        const epoch = this.providerParityProofEpoch(proof.proofEpochId);
        if (!epoch) throw new Error("Provider parity proof epoch does not exist.");
        const verification = verifyBoundProviderParityObservation(epoch, observation);
        if (!verification.ok) throw new Error(`Provider parity proof is invalid: ${verification.reason}`);
      }
      const { proof: _proof, ...auditObservation } = observation;
      const result = this.db.prepare(`
        INSERT INTO provider_parity_observations(
          capability, subject, status, observation_json, observed_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        observation.capability,
        observation.subject,
        observation.status,
        encode(auditObservation),
        observation.observedAt
      );
      const id = Number(result.lastInsertRowid);
      if (proof) {
        this.db.prepare(`
          INSERT INTO provider_parity_observation_bindings(
            observation_id, proof_epoch_id, endpoint_fingerprint,
            window_start_at, window_end_at, cutoff_at, manifest_digest,
            input_digest, result_digest, binding_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id,
          proof.proofEpochId,
          proof.endpointFingerprint,
          proof.windowStartAt,
          proof.windowEndAt,
          proof.cutoffAt,
          proof.manifestDigest,
          proof.inputDigest,
          proof.resultDigest,
          encode(proof)
        );
      }
      return id;
    })();
  }

  listProviderParityObservations(limit = 100): Array<ProviderParityObservation & { id: number }> {
    const boundedLimit = Math.max(0, Math.min(10_000, Math.trunc(limit)));
    const rows = this.db.prepare(`
      SELECT o.id, o.observation_json, b.binding_json
      FROM provider_parity_observations o
      LEFT JOIN provider_parity_observation_bindings b ON b.observation_id = o.id
      ORDER BY o.observed_at DESC, o.id DESC LIMIT ?
    `).all(boundedLimit) as Array<{ id: number; observation_json: string; binding_json: string | null }>;
    return rows.map((row) => ({
      id: row.id,
      ...decode<ProviderParityObservation>(row.observation_json),
      ...(row.binding_json ? { proof: decode<ProviderParityProofBinding>(row.binding_json) } : {})
    }));
  }

  listProviderParityObservationsSince(
    since: string,
    limit = 100_000
  ): Array<ProviderParityObservation & { id: number }> {
    if (!Number.isFinite(Date.parse(since))) throw new Error("Provider parity cutoff is invalid.");
    const boundedLimit = Math.max(0, Math.min(100_000, Math.trunc(limit)));
    const rows = this.db.prepare(`
      SELECT o.id, o.observation_json, b.binding_json
      FROM provider_parity_observations o
      LEFT JOIN provider_parity_observation_bindings b ON b.observation_id = o.id
      WHERE o.observed_at >= ?
      ORDER BY o.observed_at DESC, o.id DESC LIMIT ?
    `).all(since, boundedLimit) as Array<{ id: number; observation_json: string; binding_json: string | null }>;
    return rows.map((row) => ({
      id: row.id,
      ...decode<ProviderParityObservation>(row.observation_json),
      ...(row.binding_json ? { proof: decode<ProviderParityProofBinding>(row.binding_json) } : {})
    }));
  }

  prepareProviderParityProofEpoch(input: PrepareProviderParityProofEpochInput): ProviderParityProofEpoch {
    const epoch = buildProviderParityProofEpoch(input);
    return this.db.transaction(() => {
      if (this.activeProviderParityProofEpoch()) {
        throw new Error("Invalidate the active provider parity proof before preparing another epoch.");
      }
      const priorPrepared = this.latestProviderParityProofEpoch(undefined, "PREPARED");
      if (priorPrepared) {
        this.db.prepare(`
          UPDATE provider_parity_proof_epochs
          SET status = 'INVALIDATED', invalidated_at = ?, invalidation_reason = ?
          WHERE id = ? AND status = 'PREPARED'
        `).run(epoch.createdAt, "a newer frozen proof manifest was prepared", priorPrepared.id);
      }
      this.db.prepare(`
        INSERT INTO provider_parity_proof_epochs(
          id, status, endpoint_fingerprint, window_start_at, window_end_at, cutoff_at,
          control_population_available, subjects_json, manifest_digest, created_at
        ) VALUES (?, 'PREPARED', ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        epoch.id,
        epoch.endpointFingerprint,
        epoch.windowStartAt,
        epoch.windowEndAt,
        epoch.cutoffAt,
        Number(epoch.controlPopulationAvailable),
        encode(epoch.subjects),
        epoch.manifestDigest,
        epoch.createdAt
      );
      return epoch;
    })();
  }

  providerParityProofEpoch(id: string): ProviderParityProofEpoch | undefined {
    const row = this.db.prepare(`
      SELECT * FROM provider_parity_proof_epochs WHERE id = ?
    `).get(id) as ProviderParityProofEpochRow | undefined;
    return row ? decodeProviderParityProofEpoch(row) : undefined;
  }

  activeProviderParityProofEpoch(endpointFingerprint?: string): ProviderParityProofEpoch | undefined {
    const row = this.db.prepare(`
      SELECT * FROM provider_parity_proof_epochs
      WHERE status = 'ACTIVE' AND (? IS NULL OR endpoint_fingerprint = ?)
      ORDER BY activated_at DESC, created_at DESC LIMIT 1
    `).get(endpointFingerprint ?? null, endpointFingerprint ?? null) as ProviderParityProofEpochRow | undefined;
    return row ? decodeProviderParityProofEpoch(row) : undefined;
  }

  latestProviderParityProofEpoch(
    endpointFingerprint?: string,
    status?: ProviderParityProofEpoch["status"]
  ): ProviderParityProofEpoch | undefined {
    const row = this.db.prepare(`
      SELECT * FROM provider_parity_proof_epochs
      WHERE (? IS NULL OR endpoint_fingerprint = ?)
        AND (? IS NULL OR status = ?)
      ORDER BY created_at DESC, id DESC LIMIT 1
    `).get(
      endpointFingerprint ?? null,
      endpointFingerprint ?? null,
      status ?? null,
      status ?? null
    ) as ProviderParityProofEpochRow | undefined;
    return row ? decodeProviderParityProofEpoch(row) : undefined;
  }

  listProviderParityObservationsForProofEpoch(
    proofEpochId: string,
    limit = 100_000
  ): Array<ProviderParityObservation & { id: number }> {
    const boundedLimit = Math.max(0, Math.min(100_000, Math.trunc(limit)));
    const rows = this.db.prepare(`
      SELECT o.id, o.observation_json, b.binding_json
      FROM provider_parity_observations o
      JOIN provider_parity_observation_bindings b ON b.observation_id = o.id
      WHERE b.proof_epoch_id = ?
      ORDER BY o.observed_at DESC, o.id DESC LIMIT ?
    `).all(proofEpochId, boundedLimit) as Array<{
      id: number;
      observation_json: string;
      binding_json: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      ...decode<ProviderParityObservation>(row.observation_json),
      proof: decode<ProviderParityProofBinding>(row.binding_json)
    }));
  }

  activateProviderParityProofEpoch(id: string, activatedAt: string): ProviderParityProofEpoch {
    if (!Number.isFinite(Date.parse(activatedAt)) || new Date(Date.parse(activatedAt)).toISOString() !== activatedAt) {
      throw new Error("Provider parity proof activation time is invalid.");
    }
    return this.db.transaction(() => {
      const epoch = this.providerParityProofEpoch(id);
      if (!epoch || epoch.status !== "PREPARED") {
        throw new Error("Only a prepared provider parity proof can be activated.");
      }
      if (Date.parse(activatedAt) < Date.parse(epoch.createdAt)) {
        throw new Error("Provider parity proof activation cannot predate preparation.");
      }
      if (this.activeProviderParityProofEpoch()) {
        throw new Error("Another provider parity proof epoch is already active.");
      }
      const observations = this.listProviderParityObservationsForProofEpoch(epoch.id);
      const blockers = frozenProviderParityBaselineBlockers(epoch, observations);
      if (blockers.length > 0) {
        throw new Error(`Frozen provider parity baseline is incomplete: ${blockers.join("; ")}`);
      }
      this.db.prepare(`
        UPDATE provider_parity_proof_epochs
        SET status = 'ACTIVE', activated_at = ?
        WHERE id = ? AND status = 'PREPARED'
      `).run(activatedAt, id);
      return { ...epoch, status: "ACTIVE" as const, activatedAt };
    })();
  }

  activateProviderParityProofEpochWithRun(
    id: string,
    run: ProviderParityBaselineRun,
    activatedAt: string
  ): { epoch: ProviderParityProofEpoch; run: ProviderParityBaselineRun } {
    if (run.proofEpochId !== id || run.status !== "CAPTURING") {
      throw new Error("Provider parity activation requires the owning CAPTURING run.");
    }
    return this.db.transaction(() => {
      const observations = this.listProviderParityObservationsForProofEpoch(id).filter((observation) =>
        observation.capability === "WALLET_DISCOVERY" ||
        observation.capability === "WALLET_PNL_30D" ||
        observation.capability === "WALLET_PNL_90D" ||
        observation.capability === "CHAIN_HISTORY" ||
        observation.capability === "CHAIN_GAP"
      );
      const acquired = new Set(run.acquisitions.map((entry) => `${entry.inputDigest}:${entry.resultDigest}`));
      if (observations.some((observation) =>
        !observation.proof || !acquired.has(`${observation.proof.inputDigest}:${observation.proof.resultDigest}`)
      )) throw new Error("Provider parity activation run is missing a frozen observation acquisition.");
      const epoch = this.activateProviderParityProofEpoch(id, activatedAt);
      const activeRun: ProviderParityBaselineRun = {
        ...run,
        status: "ACTIVE",
        activatedAt,
        updatedAt: activatedAt,
        blockers: []
      };
      this.saveProviderParityBaselineRun(activeRun);
      return { epoch, run: activeRun };
    })();
  }

  invalidateProviderParityProofEpochs(reason: string, invalidatedAt = nowIso()): number {
    if (!reason.trim()) throw new Error("Provider parity proof invalidation requires a reason.");
    if (!Number.isFinite(Date.parse(invalidatedAt))) {
      throw new Error("Provider parity proof invalidation time is invalid.");
    }
    const result = this.db.prepare(`
      UPDATE provider_parity_proof_epochs
      SET status = 'INVALIDATED', invalidated_at = ?, invalidation_reason = ?
      WHERE status IN ('PREPARED', 'ACTIVE')
    `).run(invalidatedAt, reason.trim());
    return result.changes;
  }

  saveProviderParityBaselineRun(run: ProviderParityBaselineRun): void {
    if (
      !run.id.trim() ||
      !Number.isFinite(Date.parse(run.requestedAt)) ||
      !Number.isFinite(Date.parse(run.updatedAt))
    ) throw new Error("Provider parity baseline run is malformed.");
    if (run.proofEpochId && !this.providerParityProofEpoch(run.proofEpochId)) {
      throw new Error("Provider parity baseline run references an unknown proof epoch.");
    }
    this.db.transaction(() => {
      const prior = this.providerParityBaselineRun(run.id);
      if (prior) {
        const immutable = (value: ProviderParityBaselineRun): string => encode({
          id: value.id,
          requestedAt: value.requestedAt,
          proofEpochId: value.proofEpochId ?? null,
          endpointFingerprint: value.endpointFingerprint ?? null,
          generationId: value.generationId ?? null,
          windowStartAt: value.windowStartAt ?? null,
          cutoffAt: value.cutoffAt ?? null,
          subjects: value.subjects ?? null
        });
        if (immutable(prior) !== immutable(run)) {
          throw new Error("Provider parity baseline immutable inputs cannot change.");
        }
        if (run.acquisitions.length < prior.acquisitions.length || prior.acquisitions.some((entry, index) =>
          encode(entry) !== encode(run.acquisitions[index])
        )) throw new Error("Provider parity baseline acquisitions are append-only.");
        const transitions: Record<ProviderParityBaselineRun["status"], ReadonlySet<ProviderParityBaselineRun["status"]>> = {
          PREPARING: new Set(["PREPARING", "PREPARED", "BLOCKED", "FAILED"]),
          PREPARED: new Set(["PREPARED", "CAPTURING", "BLOCKED", "FAILED"]),
          CAPTURING: new Set(["CAPTURING", "ACTIVE", "BLOCKED", "FAILED"]),
          BLOCKED: new Set(["BLOCKED"]),
          ACTIVE: new Set(["ACTIVE"]),
          FAILED: new Set(["FAILED"])
        };
        if (!transitions[prior.status].has(run.status)) {
          throw new Error(`Invalid provider parity baseline transition ${prior.status} -> ${run.status}.`);
        }
      }
      this.db.prepare(`
        INSERT INTO provider_parity_baseline_runs(
          id, proof_epoch_id, status, run_json, requested_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          status = excluded.status,
          run_json = excluded.run_json,
          updated_at = excluded.updated_at
      `).run(
        run.id,
        run.proofEpochId ?? null,
        run.status,
        encode(run),
        run.requestedAt,
        run.updatedAt
      );
    })();
  }

  appendProviderParityBaselineObservation(
    run: ProviderParityBaselineRun,
    observation: ProviderParityObservation,
    acquisition: ProviderParityBaselineRun["acquisitions"][number]
  ): { observationId: number; run: ProviderParityBaselineRun } {
    if (
      run.status !== "CAPTURING" ||
      !run.proofEpochId ||
      observation.proof?.proofEpochId !== run.proofEpochId ||
      acquisition.inputDigest !== observation.proof.inputDigest ||
      acquisition.resultDigest !== observation.proof.resultDigest ||
      acquisition.capability !== observation.capability ||
      acquisition.subject !== observation.subject
    ) throw new Error("Provider parity acquisition does not match its CAPTURING run observation.");
    if (run.acquisitions.some((entry) =>
      entry.inputDigest === acquisition.inputDigest && entry.resultDigest === acquisition.resultDigest
    )) throw new Error("Provider parity acquisition was already appended to this run.");
    return this.db.transaction(() => {
      const observationId = this.saveProviderParityObservation(observation);
      const next: ProviderParityBaselineRun = {
        ...run,
        acquisitions: [...run.acquisitions, acquisition],
        updatedAt: nowIso()
      };
      this.saveProviderParityBaselineRun(next);
      return { observationId, run: next };
    })();
  }

  providerParityBaselineRun(id: string): ProviderParityBaselineRun | undefined {
    const row = this.db.prepare(`
      SELECT run_json FROM provider_parity_baseline_runs WHERE id = ?
    `).get(id) as { run_json: string } | undefined;
    return row ? decode<ProviderParityBaselineRun>(row.run_json) : undefined;
  }

  latestProviderParityBaselineRun(): ProviderParityBaselineRun | undefined {
    const row = this.db.prepare(`
      SELECT run_json FROM provider_parity_baseline_runs
      ORDER BY requested_at DESC, rowid DESC LIMIT 1
    `).get() as { run_json: string } | undefined;
    return row ? decode<ProviderParityBaselineRun>(row.run_json) : undefined;
  }

  providerParityBaselineRunForProofEpoch(proofEpochId: string): ProviderParityBaselineRun | undefined {
    const row = this.db.prepare(`
      SELECT run_json FROM provider_parity_baseline_runs
      WHERE proof_epoch_id = ?
      ORDER BY updated_at DESC, rowid DESC LIMIT 1
    `).get(proofEpochId) as { run_json: string } | undefined;
    return row ? decode<ProviderParityBaselineRun>(row.run_json) : undefined;
  }

  recordSelfHostedPaperSoakHeartbeat(input: SelfHostedPaperSoakHeartbeatInput): void {
    const observedAtMs = Date.parse(input.observedAt);
    if (!Number.isFinite(observedAtMs)) throw new Error("Self-hosted PAPER soak heartbeat time is invalid.");
    if (!/^[a-f0-9]{64}$/u.test(input.endpointFingerprint)) {
      throw new Error("Self-hosted PAPER soak endpoint fingerprint is invalid.");
    }
    const healthy = Object.values(input.health).every(Boolean);
    this.db.transaction(() => {
      let epoch = this.activeSelfHostedPaperSoakEpoch();
      if (epoch && epoch.endpointFingerprint !== input.endpointFingerprint) {
        this.resetSelfHostedPaperSoak("the active self-hosted endpoint pair changed", input.observedAt);
        epoch = undefined;
      }

      if (!healthy) {
        if (epoch) {
          const failed = Object.entries(input.health)
            .filter(([, ok]) => !ok)
            .map(([component]) => component)
            .join(", ");
          this.resetSelfHostedPaperSoak(
            `an unhealthy self-hosted PAPER interval was observed (${failed})`,
            input.observedAt
          );
        }
        this.insertSelfHostedPaperSoakHeartbeat(undefined, input, false);
        return;
      }

      if (epoch) {
        const latest = this.listSelfHostedPaperSoakHeartbeats(epoch.id).at(-1);
        const latestAt = latest ? Date.parse(latest.observedAt) : Date.parse(epoch.startedAt);
        if (Number.isFinite(latestAt) && observedAtMs < latestAt) {
          this.resetSelfHostedPaperSoak(
            "the system clock moved backwards during the self-hosted PAPER soak",
            input.observedAt
          );
          epoch = undefined;
        } else if (!Number.isFinite(latestAt) || observedAtMs - latestAt > SELF_HOSTED_PAPER_SOAK_MAXIMUM_GAP_MS) {
          this.resetSelfHostedPaperSoak(
            "the self-hosted PAPER heartbeat gap exceeded fifteen minutes",
            input.observedAt
          );
          epoch = undefined;
        }
      }

      if (!epoch) {
        epoch = {
          id: `self-hosted-paper-soak:${randomUUID()}`,
          endpointFingerprint: input.endpointFingerprint,
          startedAt: input.observedAt,
          status: "ACTIVE"
        };
        this.db.prepare(`
          INSERT INTO self_hosted_paper_soak_epochs(
            id, endpoint_fingerprint, started_at, status, ended_at, reset_reason
          ) VALUES (?, ?, ?, 'ACTIVE', NULL, NULL)
        `).run(epoch.id, epoch.endpointFingerprint, epoch.startedAt);
      }
      this.insertSelfHostedPaperSoakHeartbeat(epoch.id, input, true);
    })();
  }

  resetSelfHostedPaperSoak(reason: string, at = nowIso()): boolean {
    if (!reason.trim()) throw new Error("Self-hosted PAPER soak reset reason is required.");
    if (!Number.isFinite(Date.parse(at))) throw new Error("Self-hosted PAPER soak reset time is invalid.");
    return this.db.prepare(`
      UPDATE self_hosted_paper_soak_epochs
      SET status = 'RESET', ended_at = ?, reset_reason = ?
      WHERE status = 'ACTIVE'
    `).run(at, reason.trim().slice(0, 1_000)).changes > 0;
  }

  activeSelfHostedPaperSoakEpoch(endpointFingerprint?: string): SelfHostedPaperSoakEpoch | undefined {
    const row = this.db.prepare(`
      SELECT id, endpoint_fingerprint, started_at, status, ended_at, reset_reason
      FROM self_hosted_paper_soak_epochs
      WHERE status = 'ACTIVE' AND (? IS NULL OR endpoint_fingerprint = ?)
      ORDER BY started_at DESC LIMIT 1
    `).get(endpointFingerprint ?? null, endpointFingerprint ?? null) as {
      id: string;
      endpoint_fingerprint: string;
      started_at: string;
      status: "ACTIVE" | "RESET";
      ended_at: string | null;
      reset_reason: string | null;
    } | undefined;
    return row ? {
      id: row.id,
      endpointFingerprint: row.endpoint_fingerprint,
      startedAt: row.started_at,
      status: row.status,
      ...(row.ended_at ? { endedAt: row.ended_at } : {}),
      ...(row.reset_reason ? { resetReason: row.reset_reason } : {})
    } : undefined;
  }

  listSelfHostedPaperSoakHeartbeats(epochId: string): SelfHostedPaperSoakHeartbeat[] {
    const rows = this.db.prepare(`
      SELECT id, epoch_id, endpoint_fingerprint, observed_at, healthy,
             discovery_healthy, chain_healthy, index_healthy, price_healthy
      FROM self_hosted_paper_soak_heartbeats
      WHERE epoch_id = ? ORDER BY observed_at, id
    `).all(epochId) as Array<{
      id: number;
      epoch_id: string | null;
      endpoint_fingerprint: string;
      observed_at: string;
      healthy: number;
      discovery_healthy: number;
      chain_healthy: number;
      index_healthy: number;
      price_healthy: number;
    }>;
    return rows.map((row) => this.mapSelfHostedPaperSoakHeartbeat(row));
  }

  latestSelfHostedPaperSoakHeartbeat(endpointFingerprint: string): SelfHostedPaperSoakHeartbeat | undefined {
    const row = this.db.prepare(`
      SELECT id, epoch_id, endpoint_fingerprint, observed_at, healthy,
             discovery_healthy, chain_healthy, index_healthy, price_healthy
      FROM self_hosted_paper_soak_heartbeats
      WHERE endpoint_fingerprint = ? ORDER BY observed_at DESC, id DESC LIMIT 1
    `).get(endpointFingerprint) as {
      id: number;
      epoch_id: string | null;
      endpoint_fingerprint: string;
      observed_at: string;
      healthy: number;
      discovery_healthy: number;
      chain_healthy: number;
      index_healthy: number;
      price_healthy: number;
    } | undefined;
    return row ? this.mapSelfHostedPaperSoakHeartbeat(row) : undefined;
  }

  private insertSelfHostedPaperSoakHeartbeat(
    epochId: string | undefined,
    input: SelfHostedPaperSoakHeartbeatInput,
    healthy: boolean
  ): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO self_hosted_paper_soak_heartbeats(
        epoch_id, endpoint_fingerprint, observed_at, healthy,
        discovery_healthy, chain_healthy, index_healthy, price_healthy
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      epochId ?? null,
      input.endpointFingerprint,
      input.observedAt,
      healthy ? 1 : 0,
      input.health.discovery ? 1 : 0,
      input.health.chain ? 1 : 0,
      input.health.index ? 1 : 0,
      input.health.price ? 1 : 0
    );
  }

  private mapSelfHostedPaperSoakHeartbeat(row: {
    id: number;
    epoch_id: string | null;
    endpoint_fingerprint: string;
    observed_at: string;
    healthy: number;
    discovery_healthy: number;
    chain_healthy: number;
    index_healthy: number;
    price_healthy: number;
  }): SelfHostedPaperSoakHeartbeat {
    return {
      id: row.id,
      ...(row.epoch_id ? { epochId: row.epoch_id } : {}),
      endpointFingerprint: row.endpoint_fingerprint,
      observedAt: row.observed_at,
      healthy: row.healthy === 1,
      health: {
        discovery: row.discovery_healthy === 1,
        chain: row.chain_healthy === 1,
        index: row.index_healthy === 1,
        price: row.price_healthy === 1
      }
    };
  }

  saveSolPriceSnapshot(snapshot: { capturedAt: string; priceUsd: number; source: string }): void {
    if (!Number.isFinite(Date.parse(snapshot.capturedAt))) throw new Error("SOL price capture time is invalid.");
    if (!Number.isFinite(snapshot.priceUsd) || snapshot.priceUsd <= 0) {
      throw new Error("SOL price must be positive.");
    }
    if (!snapshot.source.trim()) throw new Error("SOL price source is required.");
    const source = snapshot.source.trim();
    const existing = this.getSolPriceSnapshotAt(snapshot.capturedAt);
    if (existing) {
      if (existing.priceUsd === snapshot.priceUsd && existing.source === source) return;
      throw new Error("A frozen SOL price timestamp cannot be overwritten with different evidence.");
    }
    this.db.prepare(`
      INSERT INTO sol_price_snapshots(captured_at, price_usd, source) VALUES (?, ?, ?)
    `).run(snapshot.capturedAt, snapshot.priceUsd, source);
    this.solPriceCoverageAggregateCache = undefined;
  }

  getSolPriceBootstrapCheckpoint(): SolPriceBootstrapCheckpoint | undefined {
    return this.getSetting<SolPriceBootstrapCheckpoint>(SOL_PRICE_BOOTSTRAP_SETTING);
  }

  saveSolPriceBootstrapCheckpoint(checkpoint: SolPriceBootstrapCheckpoint): void {
    this.setSetting(SOL_PRICE_BOOTSTRAP_SETTING, checkpoint);
  }

  /**
   * Atomically advances the historical-price cursor with an insert-only grid snapshot.
   * Existing exact timestamps, including newer Jupiter captures, are retained.
   */
  commitSolPriceBootstrapPoint(
    snapshot: { capturedAt: string; priceUsd: number; source?: string },
    advancedCheckpoint: SolPriceBootstrapCheckpoint
  ): { inserted: boolean; checkpoint: SolPriceBootstrapCheckpoint } {
    if (!Number.isFinite(Date.parse(snapshot.capturedAt))) throw new Error("SOL price capture time is invalid.");
    if (!Number.isFinite(snapshot.priceUsd) || snapshot.priceUsd <= 0) {
      throw new Error("SOL price must be positive.");
    }
    const source = snapshot.source ?? SOL_PRICE_BOOTSTRAP_SOURCE;
    if (!SOL_PRICE_BOOTSTRAP_SOURCES.has(source)) {
      throw new Error("SOL price bootstrap source is not approved.");
    }
    const result = this.db.transaction(() => {
      const inserted = this.db.prepare(`
        INSERT OR IGNORE INTO sol_price_snapshots(captured_at, price_usd, source)
        VALUES (?, ?, ?)
      `).run(snapshot.capturedAt, snapshot.priceUsd, source).changes === 1;
      const checkpoint: SolPriceBootstrapCheckpoint = {
        ...advancedCheckpoint,
        insertedSnapshots: advancedCheckpoint.insertedSnapshots + (inserted ? 1 : 0),
        preservedSnapshots: advancedCheckpoint.preservedSnapshots + (inserted ? 0 : 1)
      };
      this.saveSolPriceBootstrapCheckpoint(checkpoint);
      return { inserted, checkpoint };
    })();
    if (result.inserted) this.solPriceCoverageAggregateCache = undefined;
    return result;
  }

  getSolPriceSnapshotAt(capturedAt: string): { capturedAt: string; priceUsd: number; source: string } | undefined {
    if (!Number.isFinite(Date.parse(capturedAt))) throw new Error("SOL price capture time is invalid.");
    const row = this.db.prepare(`
      SELECT captured_at, price_usd, source FROM sol_price_snapshots WHERE captured_at = ?
    `).get(capturedAt) as { captured_at: string; price_usd: number; source: string } | undefined;
    return row ? { capturedAt: row.captured_at, priceUsd: row.price_usd, source: row.source } : undefined;
  }

  nearestSolPriceSnapshot(
    requestedAt: string,
    maximumDistanceMs: number
  ): { capturedAt: string; priceUsd: number; source: string } | undefined {
    const requested = Date.parse(requestedAt);
    if (!Number.isFinite(requested)) throw new Error("SOL price request time is invalid.");
    if (!Number.isFinite(maximumDistanceMs) || maximumDistanceMs < 0) {
      throw new Error("SOL price maximum distance must be non-negative.");
    }
    const start = new Date(requested - maximumDistanceMs).toISOString();
    const row = this.db.prepare(`
      SELECT captured_at, price_usd, source FROM sol_price_snapshots
      WHERE captured_at BETWEEN ? AND ?
      ORDER BY captured_at DESC
      LIMIT 1
    `).get(start, requestedAt) as {
      captured_at: string;
      price_usd: number;
      source: string;
    } | undefined;
    return row ? { capturedAt: row.captured_at, priceUsd: row.price_usd, source: row.source } : undefined;
  }

  solPriceCoverage(at = new Date()): {
    count: number;
    pendingSwapReprices: number;
    outOfHorizonSwapReprices: number;
    oldestAt?: string;
    newestAt?: string;
    largestGapSeconds: number;
  } {
    const aggregate = this.solPriceCoverageAggregateCache ?? (() => {
      const row = this.db.prepare(`
        WITH ordered AS (
          SELECT
            captured_at,
            LAG(captured_at) OVER (ORDER BY captured_at) AS previous_at
          FROM sol_price_snapshots
        )
        SELECT
          COUNT(*) AS count,
          MIN(captured_at) AS oldest_at,
          MAX(captured_at) AS newest_at,
          MAX((julianday(captured_at) - julianday(previous_at)) * 86400.0) AS largest_gap_seconds
        FROM ordered
      `).get() as {
        count: number;
        oldest_at: string | null;
        newest_at: string | null;
        largest_gap_seconds: number | null;
      };
      const calculated = {
        count: row.count,
        largestGapSeconds: Math.max(0, row.largest_gap_seconds ?? 0),
        ...(row.oldest_at ? { oldestAt: row.oldest_at } : {}),
        ...(row.newest_at ? { newestAt: row.newest_at } : {})
      };
      this.solPriceCoverageAggregateCache = calculated;
      return calculated;
    })();
    const retainedAfter = new Date(
      at.getTime() - LOCAL_SOL_PRICE_HORIZON_MS - LOCAL_SOL_PRICE_TOLERANCE_MS
    ).toISOString();
    const reprices = this.db.prepare(`
      SELECT
        SUM(CASE WHEN swap.block_time >= ? THEN 1 ELSE 0 END) AS pending_in_horizon,
        SUM(CASE WHEN swap.block_time < ? THEN 1 ELSE 0 END) AS pending_out_of_horizon
      FROM indexed_swap_reprice_queue queue
      JOIN indexed_spot_swaps swap INDEXED BY indexed_spot_swaps_reprice_time
        ON swap.id = queue.swap_id
      WHERE queue.status = 'PENDING'
    `).get(retainedAfter, retainedAfter) as {
      pending_in_horizon: number | null;
      pending_out_of_horizon: number | null;
    };
    return {
      count: aggregate.count,
      pendingSwapReprices: reprices.pending_in_horizon ?? 0,
      outOfHorizonSwapReprices: reprices.pending_out_of_horizon ?? 0,
      largestGapSeconds: aggregate.largestGapSeconds,
      ...(aggregate.oldestAt ? { oldestAt: aggregate.oldestAt } : {}),
      ...(aggregate.newestAt ? { newestAt: aggregate.newestAt } : {})
    };
  }

  createResearchPaperLane(input: {
    id: string;
    policyVersion: string;
    policy?: Record<string, unknown>;
    initialNavPerLeaderUsd?: number;
    startedAt?: string;
  }): ResearchPaperLane {
    const id = input.id.trim();
    const policyVersion = input.policyVersion.trim();
    if (!id || !policyVersion) throw new Error("Research paper lane id and policy version are required.");
    const existing = this.getResearchPaperLane(id);
    if (existing) {
      const requestedInitialNav = input.initialNavPerLeaderUsd ?? DEFAULT_RISK_POLICY.initialNavUsd;
      if (existing.policyVersion !== policyVersion ||
          existing.initialNavPerLeaderUsd !== requestedInitialNav) {
        throw new Error("An existing research paper lane cannot change policy epoch or initial NAV.");
      }
      return existing;
    }
    const initialNav = input.initialNavPerLeaderUsd ?? DEFAULT_RISK_POLICY.initialNavUsd;
    finiteResearchNumber(initialNav, "Research paper initial NAV", Number.EPSILON);
    const startedAt = input.startedAt ?? nowIso();
    const lane: ResearchPaperLane = {
      id,
      label: RESEARCH_PAPER_LABEL,
      purpose: "RESEARCH_ONLY",
      policyVersion,
      policy: input.policy ?? {},
      initialNavPerLeaderUsd: initialNav,
      status: "ACTIVE",
      startedAt,
      updatedAt: startedAt
    };
    this.db.prepare(`
      INSERT INTO research_paper_lanes(
        id, label, purpose, policy_version, policy_json,
        initial_nav_per_leader_usd, status, started_at, updated_at
      ) VALUES (?, ?, 'RESEARCH_ONLY', ?, ?, ?, 'ACTIVE', ?, ?)
    `).run(
      lane.id, lane.label, lane.policyVersion, encode(lane.policy),
      lane.initialNavPerLeaderUsd, lane.startedAt, lane.updatedAt
    );
    return lane;
  }

  getResearchPaperLane(id: string): ResearchPaperLane | undefined {
    const row = this.db.prepare("SELECT * FROM research_paper_lanes WHERE id = ?")
      .get(id) as ResearchPaperLaneRow | undefined;
    return row ? decodeResearchPaperLane(row) : undefined;
  }

  activeResearchPaperLane(): ResearchPaperLane | undefined {
    const row = this.db.prepare("SELECT * FROM research_paper_lanes WHERE status = 'ACTIVE' LIMIT 1")
      .get() as ResearchPaperLaneRow | undefined;
    return row ? decodeResearchPaperLane(row) : undefined;
  }

  latestResearchPaperLane(): ResearchPaperLane | undefined {
    const row = this.db.prepare(`
      SELECT * FROM research_paper_lanes ORDER BY started_at DESC, id DESC LIMIT 1
    `).get() as ResearchPaperLaneRow | undefined;
    return row ? decodeResearchPaperLane(row) : undefined;
  }

  pauseResearchPaperLane(id: string, at = nowIso()): ResearchPaperLane | undefined {
    this.db.prepare(`
      UPDATE research_paper_lanes SET status = 'PAUSED', updated_at = ?
      WHERE id = ? AND status = 'ACTIVE'
    `).run(at, id);
    return this.getResearchPaperLane(id);
  }

  resumeResearchPaperLane(id: string, at = nowIso()): ResearchPaperLane | undefined {
    this.db.prepare(`
      UPDATE research_paper_lanes SET status = 'ACTIVE', updated_at = ?
      WHERE id = ? AND status = 'PAUSED'
    `).run(at, id);
    return this.getResearchPaperLane(id);
  }

  reviseResearchPaperLanePolicy(input: {
    id: string;
    policyVersion: string;
    policy: Record<string, unknown>;
    effectiveAt?: string;
  }): ResearchPaperLane {
    const id = input.id.trim();
    const policyVersion = input.policyVersion.trim();
    const effectiveAt = input.effectiveAt ?? nowIso();
    if (!id || !policyVersion || !Number.isFinite(Date.parse(effectiveAt))) {
      throw new Error("Research paper policy revision metadata is invalid.");
    }
    const lane = this.getResearchPaperLane(id);
    if (!lane || lane.status !== "ACTIVE") {
      throw new Error("An active research paper lane is required for a policy revision.");
    }
    if (Date.parse(effectiveAt) < Date.parse(lane.updatedAt)) {
      throw new Error("A research paper policy revision cannot be backdated.");
    }
    const requestedPolicy = { ...input.policy };
    const currentPolicy = { ...lane.policy };
    delete currentPolicy.revisionHistory;
    delete currentPolicy.effectiveAt;
    const unchanged = lane.policyVersion === policyVersion &&
      encode(currentPolicy) === encode(requestedPolicy);
    if (unchanged) return lane;

    const priorHistory = Array.isArray(lane.policy.revisionHistory)
      ? lane.policy.revisionHistory
      : [];
    const nextPolicy: Record<string, unknown> = {
      ...requestedPolicy,
      effectiveAt,
      revisionHistory: [
        ...priorHistory,
        {
          policyVersion: lane.policyVersion,
          policy: currentPolicy,
          effectiveFrom: typeof lane.policy.effectiveAt === "string"
            ? lane.policy.effectiveAt
            : lane.startedAt,
          effectiveUntil: effectiveAt
        }
      ]
    };
    const originalPolicyJson = encode(lane.policy);
    const revise = this.db.transaction(() => {
      const result = this.db.prepare(`
        UPDATE research_paper_lanes
        SET policy_version = ?, policy_json = ?, updated_at = ?
        WHERE id = ? AND status = 'ACTIVE' AND policy_version = ? AND policy_json = ?
      `).run(policyVersion, encode(nextPolicy), effectiveAt, id, lane.policyVersion, originalPolicyJson);
      if (result.changes !== 1) {
        throw new Error("The active research paper policy changed concurrently.");
      }
      this.audit(
        "research_paper_sizing_revised",
        "Future high-risk PAPER entries changed sizing without modifying existing positions, strict PAPER, or live policy.",
        {
          laneId: id,
          priorVersion: lane.policyVersion,
          policyVersion,
          priorPolicy: currentPolicy,
          policy: requestedPolicy,
          effectiveAt,
          existingPositionsPreserved: true,
          executionEnabled: false,
          promotionEligible: false
        }
      );
    });
    revise();
    const revised = this.getResearchPaperLane(id);
    if (!revised) throw new Error("The revised research paper lane could not be loaded.");
    return revised;
  }

  initializeResearchPaperLeader(
    wallet: string,
    laneId?: string,
    at = nowIso()
  ): ResearchPaperLeaderAccount {
    const lane = laneId ? this.getResearchPaperLane(laneId) : this.activeResearchPaperLane();
    if (!lane || lane.status !== "ACTIVE") throw new Error("An active research paper lane is required.");
    if (!wallet.trim()) throw new Error("Research paper leader wallet is required.");
    const account: ResearchPaperLeaderAccount = {
      laneId: lane.id,
      wallet,
      initialNavUsd: lane.initialNavPerLeaderUsd,
      cashUsd: lane.initialNavPerLeaderUsd,
      navUsd: lane.initialNavPerLeaderUsd,
      peakNavUsd: lane.initialNavPerLeaderUsd,
      realizedPnlUsd: 0,
      unrealizedPnlUsd: 0,
      maxDrawdownPercent: 0,
      openPositions: 0,
      completedTrades: 0,
      pricingComplete: true,
      updatedAt: at
    };
    this.db.prepare(`
      INSERT OR IGNORE INTO research_paper_accounts(
        lane_id, wallet, initial_nav_usd, cash_usd, nav_usd, peak_nav_usd,
        realized_pnl_usd, unrealized_pnl_usd, max_drawdown_percent,
        open_positions, completed_trades, pricing_complete, account_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 1, ?, ?)
    `).run(
      account.laneId, account.wallet, account.initialNavUsd, account.cashUsd,
      account.navUsd, account.peakNavUsd, encode(account), account.updatedAt
    );
    return this.getResearchPaperLeader(lane.id, wallet)!;
  }

  initializeResearchPaperLeaders(
    wallets: readonly string[],
    laneId?: string,
    at = nowIso()
  ): ResearchPaperLeaderAccount[] {
    const unique = [...new Set(wallets.map((wallet) => wallet.trim()).filter(Boolean))];
    return this.db.transaction(() =>
      unique.map((wallet) => this.initializeResearchPaperLeader(wallet, laneId, at))
    )();
  }

  initializeResearchPaperAccountsForActiveLeaders(
    laneId?: string,
    at = nowIso()
  ): ResearchPaperLeaderAccount[] {
    return this.initializeResearchPaperLeaders(
      this.activePaperEvaluationCohort()?.wallets ?? [],
      laneId,
      at
    );
  }

  /**
   * Adds actively trading, provider-scored wallets to the isolated research
   * lane. Existing accounts and memberships are never removed or reset.
   * Provider evidence is the admission gate; recent locally confirmed spot
   * swaps are retained as stronger ranking evidence while the index catches up.
   */
  refreshResearchPaperWatchlist(
    laneId?: string,
    options: ResearchPaperWatchlistRefreshOptions = {}
  ): ResearchPaperWatchlistRun {
    const lane = laneId ? this.getResearchPaperLane(laneId) : this.activeResearchPaperLane();
    if (!lane || lane.status !== "ACTIVE") throw new Error("An active research paper lane is required.");
    const at = options.at ?? new Date();
    if (!Number.isFinite(at.getTime())) throw new RangeError("Research watchlist selection time is invalid.");
    const selectedAt = at.toISOString();
    const policy = researchPaperWatchlistPolicy(options);
    const sourceCohort = this.latestCohort();
    const sourceCohortId = sourceCohort?.cohortId;
    const strictWallets = new Set(this.activePaperEvaluationCohort()?.wallets ?? []);
    const snapshotCutoff = new Date(
      at.getTime() - policy.providerSnapshotMaxAgeDays * 24 * 60 * 60 * 1_000
    ).toISOString();
    const localCutoff = new Date(
      at.getTime() - policy.localActivityLookbackDays * 24 * 60 * 60 * 1_000
    ).toISOString();

    type EligibleRow = {
      wallet: string;
      candidate_json: string;
      score_calculated_at: string;
      candidate_saved_at: string;
      completed_trades_30d: number;
      local_confirmed_spot_swaps: number;
      local_active_days: number;
      latest_local_spot_swap_at: string | null;
    };
    const eligible = sourceCohortId
      ? this.db.prepare(`
          WITH local_activity AS (
            SELECT
              wallet,
              COUNT(*) AS confirmed_spot_swaps,
              COUNT(DISTINCT substr(block_time, 1, 10)) AS active_days,
              MAX(block_time) AS latest_spot_swap_at
            FROM indexed_spot_swaps
            WHERE block_time >= ? AND block_time <= ?
            GROUP BY wallet
          )
          SELECT
            candidate.address AS wallet,
            candidate.candidate_json,
            score.calculated_at AS score_calculated_at,
            candidate.updated_at AS candidate_saved_at,
            CAST(json_extract(candidate.candidate_json, '$.pnl30d.wins') AS INTEGER) +
              CAST(json_extract(candidate.candidate_json, '$.pnl30d.losses') AS INTEGER)
              AS completed_trades_30d,
            COALESCE(local.confirmed_spot_swaps, 0) AS local_confirmed_spot_swaps,
            COALESCE(local.active_days, 0) AS local_active_days,
            local.latest_spot_swap_at AS latest_local_spot_swap_at
          FROM wallet_candidates candidate
          JOIN wallet_scores score
            ON score.cohort_id = candidate.cohort_id AND score.address = candidate.address
          LEFT JOIN local_activity local ON local.wallet = candidate.address
          WHERE candidate.cohort_id = ?
            AND candidate.updated_at >= ? AND candidate.updated_at <= ?
            AND score.calculated_at >= ? AND score.calculated_at <= ?
            AND COALESCE(json_extract(candidate.candidate_json, '$.control'), 0) = 0
            AND json_extract(candidate.candidate_json, '$.pnl30d.realizedProfitUsd') > 0
            AND json_extract(candidate.candidate_json, '$.pnl90d.realizedProfitUsd') > 0
            AND (
              CAST(json_extract(candidate.candidate_json, '$.pnl30d.wins') AS INTEGER) +
              CAST(json_extract(candidate.candidate_json, '$.pnl30d.losses') AS INTEGER)
            ) >= ?
          ORDER BY
            CASE WHEN COALESCE(local.confirmed_spot_swaps, 0) > 0 THEN 0 ELSE 1 END,
            COALESCE(local.confirmed_spot_swaps, 0) DESC,
            completed_trades_30d DESC,
            candidate.updated_at DESC,
            (
              COALESCE(CAST(json_extract(candidate.candidate_json, '$.sourceRank30d') AS INTEGER), 100000) +
              COALESCE(CAST(json_extract(candidate.candidate_json, '$.sourceRank90d') AS INTEGER), 100000)
            ) ASC,
            (
              json_extract(candidate.candidate_json, '$.pnl30d.realizedProfitUsd') +
              json_extract(candidate.candidate_json, '$.pnl90d.realizedProfitUsd')
            ) DESC,
            candidate.address
        `).all(
          localCutoff,
          selectedAt,
          sourceCohortId,
          snapshotCutoff,
          selectedAt,
          snapshotCutoff,
          selectedAt,
          policy.minimumRecentTrades
        ) as EligibleRow[]
      : [];

    return this.db.transaction(() => {
      // The strict accounts remain present for apples-to-apples comparison,
      // but their frozen cohort and monitoring state are read-only here.
      this.initializeResearchPaperLeaders([...strictWallets], lane.id, selectedAt);
      const existingAccounts = new Set(
        this.listResearchPaperLeaders(lane.id, MAXIMUM_RESEARCH_PAPER_WATCHLIST_TARGET)
          .map((account) => account.wallet)
      );
      const preexistingLeaderCount = existingAccounts.size;
      let newlyEnrolledCount = 0;

      const upsertMember = this.db.prepare(`
        INSERT INTO research_paper_watchlist_members(
          lane_id, wallet, source_cohort_id, role, selection_rank,
          completed_trades_30d, local_confirmed_spot_swaps,
          selected_at, updated_at, member_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(lane_id, wallet) DO UPDATE SET
          source_cohort_id=excluded.source_cohort_id,
          role=excluded.role,
          selection_rank=excluded.selection_rank,
          completed_trades_30d=excluded.completed_trades_30d,
          local_confirmed_spot_swaps=excluded.local_confirmed_spot_swaps,
          updated_at=excluded.updated_at,
          member_json=excluded.member_json
      `);

      for (const [index, row] of eligible.entries()) {
        const strictOverlap = strictWallets.has(row.wallet);
        const alreadyEnrolled = existingAccounts.has(row.wallet);
        if (!alreadyEnrolled && existingAccounts.size >= policy.targetWalletCount) continue;
        if (!alreadyEnrolled) {
          this.initializeResearchPaperLeader(row.wallet, lane.id, selectedAt);
          existingAccounts.add(row.wallet);
          newlyEnrolledCount += 1;
        }
        const candidate = decode<WalletCandidate>(row.candidate_json);
        const prior = this.getResearchPaperWatchlistMember(lane.id, row.wallet);
        const member: ResearchPaperWatchlistMember = {
          laneId: lane.id,
          wallet: row.wallet,
          sourceCohortId: sourceCohortId!,
          role: strictOverlap ? "STRICT_OVERLAP" : "RESEARCH_ONLY",
          activityEvidenceSource: row.local_confirmed_spot_swaps > 0
            ? "LOCAL_CONFIRMED_SPOT_AND_PROVIDER"
            : "FRESH_PROVIDER_COMPLETED_TRADES",
          selectionRank: index + 1,
          providerScoreCalculatedAt: row.score_calculated_at,
          providerCandidateSavedAt: row.candidate_saved_at,
          realizedPnl30dUsd: candidate.pnl30d!.realizedProfitUsd,
          realizedPnl90dUsd: candidate.pnl90d!.realizedProfitUsd,
          completedTrades30d: row.completed_trades_30d,
          ...(candidate.sourceRank30d !== undefined ? { sourceRank30d: candidate.sourceRank30d } : {}),
          ...(candidate.sourceRank90d !== undefined ? { sourceRank90d: candidate.sourceRank90d } : {}),
          localConfirmedSpotSwaps: row.local_confirmed_spot_swaps,
          localActiveDays: row.local_active_days,
          ...(row.latest_local_spot_swap_at
            ? { latestLocalSpotSwapAt: row.latest_local_spot_swap_at }
            : {}),
          selectedAt: prior?.selectedAt ?? selectedAt,
          updatedAt: selectedAt
        };
        upsertMember.run(
          member.laneId,
          member.wallet,
          member.sourceCohortId,
          member.role,
          member.selectionRank,
          member.completedTrades30d,
          member.localConfirmedSpotSwaps,
          member.selectedAt,
          member.updatedAt,
          encode(member)
        );
      }

      const members = this.listResearchPaperWatchlistMembers(lane.id);
      const totalLeaderCount = this.listResearchPaperLeaders(
        lane.id,
        MAXIMUM_RESEARCH_PAPER_WATCHLIST_TARGET
      ).length;
      const run: ResearchPaperWatchlistRun = {
        id: `research-watchlist:${randomUUID()}`,
        laneId: lane.id,
        ...(sourceCohortId ? { sourceCohortId } : {}),
        policy,
        eligibleCandidateCount: eligible.length,
        preexistingLeaderCount,
        newlyEnrolledCount,
        totalLeaderCount,
        strictLeaderCount: strictWallets.size,
        strictOverlapCount: eligible.filter((row) => strictWallets.has(row.wallet)).length,
        researchOnlyMonitoredCount: members.filter((member) => member.role === "RESEARCH_ONLY").length,
        remainingCapacity: Math.max(0, policy.targetWalletCount - totalLeaderCount),
        selectedAt
      };
      this.db.prepare(`
        INSERT INTO research_paper_watchlist_runs(
          id, lane_id, source_cohort_id, target_wallet_count,
          eligible_candidate_count, newly_enrolled_count, selected_at, run_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        run.id,
        run.laneId,
        run.sourceCohortId ?? null,
        run.policy.targetWalletCount,
        run.eligibleCandidateCount,
        run.newlyEnrolledCount,
        run.selectedAt,
        encode(run)
      );
      return run;
    })();
  }

  getResearchPaperWatchlistMember(
    laneId: string,
    wallet: string
  ): ResearchPaperWatchlistMember | undefined {
    const row = this.db.prepare(`
      SELECT member_json FROM research_paper_watchlist_members
      WHERE lane_id = ? AND wallet = ?
    `).get(laneId, wallet) as { member_json: string } | undefined;
    return row ? decode<ResearchPaperWatchlistMember>(row.member_json) : undefined;
  }

  listResearchPaperWatchlistMembers(laneId: string, limit = 500): ResearchPaperWatchlistMember[] {
    const bounded = Math.max(0, Math.min(500, Math.trunc(limit)));
    const rows = this.db.prepare(`
      SELECT member_json FROM research_paper_watchlist_members
      WHERE lane_id = ?
      ORDER BY CASE role WHEN 'STRICT_OVERLAP' THEN 0 ELSE 1 END, selection_rank, wallet
      LIMIT ?
    `).all(laneId, bounded) as Array<{ member_json: string }>;
    return rows.map((row) => decode<ResearchPaperWatchlistMember>(row.member_json));
  }

  listResearchPaperWatchlistWallets(
    laneId: string,
    options: { researchOnly?: boolean } = {}
  ): string[] {
    const rows = options.researchOnly
      ? this.db.prepare(`
          SELECT wallet FROM research_paper_watchlist_members
          WHERE lane_id = ? AND role = 'RESEARCH_ONLY'
          ORDER BY selection_rank, wallet
        `).all(laneId)
      : this.db.prepare(`
          SELECT wallet FROM research_paper_watchlist_members
          WHERE lane_id = ? ORDER BY selection_rank, wallet
        `).all(laneId);
    return (rows as Array<{ wallet: string }>).map((row) => row.wallet);
  }

  latestResearchPaperWatchlistRun(laneId: string): ResearchPaperWatchlistRun | undefined {
    const row = this.db.prepare(`
      SELECT run_json FROM research_paper_watchlist_runs
      WHERE lane_id = ? ORDER BY selected_at DESC, id DESC LIMIT 1
    `).get(laneId) as { run_json: string } | undefined;
    return row ? decode<ResearchPaperWatchlistRun>(row.run_json) : undefined;
  }

  ensureResearchPaperMonitoringCheckpoint(
    laneId: string,
    wallet: string,
    cursorAt: string,
    at = nowIso()
  ): ResearchPaperMonitoringCheckpoint {
    if (!this.getResearchPaperWatchlistMember(laneId, wallet)) {
      throw new Error("A research monitoring checkpoint requires an enrolled watchlist member.");
    }
    this.db.prepare(`
      INSERT OR IGNORE INTO research_paper_monitoring_checkpoints(
        lane_id, wallet, cursor_at, status, failure_count, updated_at
      ) VALUES (?, ?, ?, 'PENDING', 0, ?)
    `).run(laneId, wallet, cursorAt, at);
    const checkpoint = this.getResearchPaperMonitoringCheckpoint(laneId, wallet);
    if (!checkpoint) throw new Error("Research monitoring checkpoint was not persisted.");
    return checkpoint;
  }

  getResearchPaperMonitoringCheckpoint(
    laneId: string,
    wallet: string
  ): ResearchPaperMonitoringCheckpoint | undefined {
    const row = this.db.prepare(`
      SELECT lane_id, wallet, cursor_at, status, attempt_started_at, last_succeeded_at,
             next_retry_at, failure_count, last_error, updated_at
      FROM research_paper_monitoring_checkpoints WHERE lane_id = ? AND wallet = ?
    `).get(laneId, wallet) as {
      lane_id: string;
      wallet: string;
      cursor_at: string;
      status: ResearchPaperMonitoringCheckpoint["status"];
      attempt_started_at: string | null;
      last_succeeded_at: string | null;
      next_retry_at: string | null;
      failure_count: number;
      last_error: string | null;
      updated_at: string;
    } | undefined;
    if (!row) return undefined;
    return {
      laneId: row.lane_id,
      wallet: row.wallet,
      cursorAt: row.cursor_at,
      status: row.status,
      failureCount: row.failure_count,
      updatedAt: row.updated_at,
      ...(row.attempt_started_at ? { attemptStartedAt: row.attempt_started_at } : {}),
      ...(row.last_succeeded_at ? { lastSucceededAt: row.last_succeeded_at } : {}),
      ...(row.next_retry_at ? { nextRetryAt: row.next_retry_at } : {}),
      ...(row.last_error ? { lastError: row.last_error } : {})
    };
  }

  listResearchPaperMonitoringCheckpoints(laneId: string): ResearchPaperMonitoringCheckpoint[] {
    const wallets = this.listResearchPaperWatchlistWallets(laneId, { researchOnly: true });
    return wallets
      .map((wallet) => this.getResearchPaperMonitoringCheckpoint(laneId, wallet))
      .filter((checkpoint): checkpoint is ResearchPaperMonitoringCheckpoint => checkpoint !== undefined);
  }

  startResearchPaperMonitoringRepair(
    laneId: string,
    wallet: string,
    expectedCursorAt: string,
    attemptStartedAt: string
  ): boolean {
    return this.db.prepare(`
      UPDATE research_paper_monitoring_checkpoints
      SET status = 'PENDING', attempt_started_at = ?, next_retry_at = NULL,
          last_error = NULL, updated_at = ?
      WHERE lane_id = ? AND wallet = ? AND cursor_at = ?
    `).run(attemptStartedAt, attemptStartedAt, laneId, wallet, expectedCursorAt).changes === 1;
  }

  completeResearchPaperMonitoringRepair(
    laneId: string,
    wallet: string,
    expectedCursorAt: string,
    nextCursorAt: string,
    completedAt = nowIso()
  ): boolean {
    return this.db.prepare(`
      UPDATE research_paper_monitoring_checkpoints
      SET cursor_at = ?, status = 'READY', last_succeeded_at = ?,
          next_retry_at = NULL, failure_count = 0, last_error = NULL, updated_at = ?
      WHERE lane_id = ? AND wallet = ? AND cursor_at = ? AND status = 'PENDING'
    `).run(
      nextCursorAt,
      completedAt,
      completedAt,
      laneId,
      wallet,
      expectedCursorAt
    ).changes === 1;
  }

  failResearchPaperMonitoringRepair(
    laneId: string,
    wallet: string,
    expectedCursorAt: string,
    nextRetryAt: string,
    lastError: string,
    failedAt = nowIso()
  ): boolean {
    return this.db.prepare(`
      UPDATE research_paper_monitoring_checkpoints
      SET status = 'FAILED', next_retry_at = ?, failure_count = failure_count + 1,
          last_error = ?, updated_at = ?
      WHERE lane_id = ? AND wallet = ? AND cursor_at = ?
    `).run(
      nextRetryAt,
      redactSensitiveText(lastError, 1_000),
      failedAt,
      laneId,
      wallet,
      expectedCursorAt
    ).changes === 1;
  }

  /** Advances only a READY research cursor and never moves it backwards. */
  advanceResearchPaperMonitoringCursor(
    laneId: string,
    wallet: string,
    nextCursorAt: string,
    at = nowIso()
  ): boolean {
    return this.db.prepare(`
      UPDATE research_paper_monitoring_checkpoints
      SET cursor_at = ?, last_succeeded_at = ?, updated_at = ?
      WHERE lane_id = ? AND wallet = ? AND status = 'READY' AND cursor_at < ?
    `).run(nextCursorAt, at, at, laneId, wallet, nextCursorAt).changes === 1;
  }

  getResearchPaperLeader(laneId: string, wallet: string): ResearchPaperLeaderAccount | undefined {
    const row = this.db.prepare(`
      SELECT account_json FROM research_paper_accounts WHERE lane_id = ? AND wallet = ?
    `).get(laneId, wallet) as { account_json: string } | undefined;
    return row ? decode<ResearchPaperLeaderAccount>(row.account_json) : undefined;
  }

  listResearchPaperLeaders(laneId: string, limit = 100): ResearchPaperLeaderAccount[] {
    const bounded = Math.max(0, Math.min(500, Math.trunc(limit)));
    const rows = this.db.prepare(`
      SELECT account_json FROM research_paper_accounts
      WHERE lane_id = ? ORDER BY nav_usd DESC, wallet LIMIT ?
    `).all(laneId, bounded) as Array<{ account_json: string }>;
    return rows.map((row) => decode<ResearchPaperLeaderAccount>(row.account_json));
  }

  upsertResearchPaperLeader(account: ResearchPaperLeaderAccount): void {
    if (!account.laneId || !account.wallet) throw new Error("Research paper account identity is required.");
    finiteResearchNumber(account.initialNavUsd, "Research account initial NAV", Number.EPSILON);
    finiteResearchNumber(account.cashUsd, "Research account cash");
    finiteResearchNumber(account.navUsd, "Research account NAV");
    finiteResearchNumber(account.peakNavUsd, "Research account peak NAV");
    if (!Number.isFinite(account.realizedPnlUsd) || !Number.isFinite(account.unrealizedPnlUsd)) {
      throw new RangeError("Research account PnL must be finite.");
    }
    finiteResearchNumber(account.maxDrawdownPercent, "Research account drawdown");
    if (!Number.isSafeInteger(account.openPositions) || account.openPositions < 0 ||
        !Number.isSafeInteger(account.completedTrades) || account.completedTrades < 0) {
      throw new RangeError("Research account counts must be non-negative integers.");
    }
    const existing = this.getResearchPaperLeader(account.laneId, account.wallet);
    if (existing && existing.initialNavUsd !== account.initialNavUsd) {
      throw new Error("A research paper account cannot change its initial NAV.");
    }
    this.db.prepare(`
      INSERT INTO research_paper_accounts(
        lane_id, wallet, initial_nav_usd, cash_usd, nav_usd, peak_nav_usd,
        realized_pnl_usd, unrealized_pnl_usd, max_drawdown_percent,
        open_positions, completed_trades, pricing_complete, account_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(lane_id, wallet) DO UPDATE SET
        initial_nav_usd=excluded.initial_nav_usd, cash_usd=excluded.cash_usd,
        nav_usd=excluded.nav_usd, peak_nav_usd=excluded.peak_nav_usd,
        realized_pnl_usd=excluded.realized_pnl_usd,
        unrealized_pnl_usd=excluded.unrealized_pnl_usd,
        max_drawdown_percent=excluded.max_drawdown_percent,
        open_positions=excluded.open_positions, completed_trades=excluded.completed_trades,
        pricing_complete=excluded.pricing_complete, account_json=excluded.account_json,
        updated_at=excluded.updated_at
    `).run(
      account.laneId, account.wallet, account.initialNavUsd, account.cashUsd,
      account.navUsd, account.peakNavUsd, account.realizedPnlUsd,
      account.unrealizedPnlUsd, account.maxDrawdownPercent, account.openPositions,
      account.completedTrades, account.pricingComplete ? 1 : 0,
      encode(account), account.updatedAt
    );
  }

  getResearchPaperPosition(id: string): ResearchPaperPosition | undefined {
    const row = (this.db.prepare("SELECT position_json FROM research_paper_positions WHERE id = ?")
      .get(id) ?? this.db.prepare(`
        SELECT position_json FROM research_paper_watchlist_positions WHERE id = ?
      `).get(id)) as { position_json: string } | undefined;
    return row ? decode<ResearchPaperPosition>(row.position_json) : undefined;
  }

  listResearchPaperPositions(options: {
    laneId: string;
    wallet?: string;
    openOnly?: boolean;
    limit?: number;
  }): ResearchPaperPosition[] {
    const bounded = Math.max(0, Math.min(500, Math.trunc(options.limit ?? 100)));
    const clauses = ["lane_id = ?"];
    const params: unknown[] = [options.laneId];
    if (options.wallet) {
      clauses.push("wallet = ?");
      params.push(options.wallet);
    }
    if (options.openOnly) clauses.push("status IN ('OPEN', 'CLOSING', 'UNPRICED')");
    const query = (table: "research_paper_positions" | "research_paper_watchlist_positions") =>
      this.db.prepare(`
        SELECT position_json FROM ${table}
        WHERE ${clauses.join(" AND ")}
        ORDER BY updated_at DESC, id LIMIT ?
      `).all(...params, bounded) as Array<{ position_json: string }>;
    return [...query("research_paper_positions"), ...query("research_paper_watchlist_positions")]
      .map((row) => decode<ResearchPaperPosition>(row.position_json))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id))
      .slice(0, bounded);
  }

  upsertResearchPaperPosition(position: ResearchPaperPosition): void {
    if (!position.id || !position.laneId || !position.wallet || !position.mint || !position.sourceEntrySignature) {
      throw new Error("Research paper position identity is required.");
    }
    const atomicFields: Array<readonly [string, string]> = [
      [position.simulatedInitialAtomic, "simulatedInitialAtomic"],
      [position.simulatedRemainingAtomic, "simulatedRemainingAtomic"],
      [position.leaderInitialAtomic, "leaderInitialAtomic"],
      [position.leaderRemainingAtomic, "leaderRemainingAtomic"]
    ];
    if (position.leaderObservedBalanceAtomic !== undefined) {
      atomicFields.push([position.leaderObservedBalanceAtomic, "leaderObservedBalanceAtomic"]);
    }
    for (const [value, label] of atomicFields) {
      if (!/^\d+$/.test(value) || BigInt(value) < 0n) {
        throw new RangeError(`${label} must be non-negative atomic units.`);
      }
    }
    if (position.leaderBalanceObservedAt !== undefined &&
        !Number.isFinite(Date.parse(position.leaderBalanceObservedAt))) {
      throw new RangeError("leaderBalanceObservedAt must be a valid timestamp.");
    }
    finiteResearchNumber(position.entryCostUsd, "Research position entry cost");
    finiteResearchNumber(position.remainingCostUsd, "Research position remaining cost");
    finiteResearchNumber(position.lastExecutableValueUsd, "Research position executable value");
    if (!Number.isFinite(position.pendingExitFraction) ||
        position.pendingExitFraction < 0 || position.pendingExitFraction > 1) {
      throw new RangeError("Research position pending exit fraction must be between zero and one.");
    }
    const retryFields = [
      position.exitQuoteFailureCount,
      position.lastExitQuoteAttemptAt,
      position.nextExitQuoteRetryAt,
      position.lastExitQuoteFailureCode
    ];
    const hasRetryEvidence = retryFields.some((value) => value !== undefined);
    if (hasRetryEvidence) {
      if (retryFields.some((value) => value === undefined) ||
          !Number.isSafeInteger(position.exitQuoteFailureCount) ||
          position.exitQuoteFailureCount! < 1) {
        throw new RangeError("Research exit-quote retry evidence requires a positive integer failure count and complete timestamps/code.");
      }
      const attemptedAt = Date.parse(position.lastExitQuoteAttemptAt!);
      const retryAt = Date.parse(position.nextExitQuoteRetryAt!);
      if (!Number.isFinite(attemptedAt) || !Number.isFinite(retryAt) || retryAt <= attemptedAt) {
        throw new RangeError("Research exit-quote retry timestamps are invalid or out of order.");
      }
      if (!["JUPITER_EXIT_NO_ROUTE", "JUPITER_EXIT_QUOTE_UNAVAILABLE", "JUPITER_EXIT_QUOTE_INVALID"]
        .includes(position.lastExitQuoteFailureCode!)) {
        throw new RangeError("Research exit-quote failure code is invalid.");
      }
      if (position.status !== "UNPRICED" || position.lastExecutableValueUsd !== 0) {
        throw new Error("Research exit-quote retry evidence must remain UNPRICED at zero executable value.");
      }
    }
    if (position.consecutiveExitNoRouteFailureCount !== undefined) {
      if (
        !hasRetryEvidence ||
        position.lastExitQuoteFailureCode !== "JUPITER_EXIT_NO_ROUTE" ||
        !Number.isSafeInteger(position.consecutiveExitNoRouteFailureCount) ||
        position.consecutiveExitNoRouteFailureCount < 1 ||
        position.consecutiveExitNoRouteFailureCount > position.exitQuoteFailureCount!
      ) {
        throw new RangeError(
          "Consecutive research no-route evidence requires typed NO_ROUTE retry evidence and cannot exceed total failures."
        );
      }
    }
    const existing = this.getResearchPaperPosition(position.id);
    if (existing && (
      existing.laneId !== position.laneId || existing.wallet !== position.wallet ||
      existing.mint !== position.mint ||
      existing.sourceEntrySignature !== position.sourceEntrySignature
    )) throw new Error("A research paper position cannot change immutable source identity.");
    const existingExternal = this.db.prepare(`
      SELECT 1 FROM research_paper_watchlist_positions WHERE id = ?
    `).get(position.id) !== undefined;
    const existingStrict = this.db.prepare(`
      SELECT 1 FROM research_paper_positions WHERE id = ?
    `).get(position.id) !== undefined;
    const strictSourceExists = this.db.prepare(`
      SELECT 1 FROM source_events WHERE signature = ? AND wallet = ?
    `).get(position.sourceEntrySignature, position.wallet) !== undefined;
    const useExternal = existingExternal || (!existingStrict && !strictSourceExists);
    if (useExternal && !this.getResearchPaperWatchlistMember(position.laneId, position.wallet)) {
      throw new Error("A direct research position requires an enrolled research watchlist wallet.");
    }
    const table = useExternal ? "research_paper_watchlist_positions" : "research_paper_positions";
    this.db.prepare(`
      INSERT INTO ${table}(
        id, lane_id, wallet, mint, source_entry_signature, status, position_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status=excluded.status, position_json=excluded.position_json, updated_at=excluded.updated_at
    `).run(
      position.id, position.laneId, position.wallet, position.mint,
      position.sourceEntrySignature, position.status, encode(position), position.updatedAt
    );
  }

  deleteResearchPaperPosition(id: string): boolean {
    return this.db.transaction(() => {
      const strict = this.db.prepare("DELETE FROM research_paper_positions WHERE id = ?").run(id).changes;
      const research = this.db.prepare(`
        DELETE FROM research_paper_watchlist_positions WHERE id = ?
      `).run(id).changes;
      return strict + research > 0;
    })();
  }

  claimResearchPaperEvent(event: ResearchPaperEvent): boolean {
    if (event.outcome !== "CLAIMED") throw new Error("A research paper event claim must use CLAIMED outcome.");
    if (!event.eventKey || !event.laneId || !event.wallet) {
      throw new Error("Research paper event identity is required.");
    }
    const strictSourceExists = event.sourceSignature
      ? this.db.prepare(`
          SELECT 1 FROM source_events WHERE signature = ? AND wallet = ?
        `).get(event.sourceSignature, event.wallet) !== undefined
      : false;
    return this.db.prepare(`
      INSERT OR IGNORE INTO research_paper_events(
        event_key, lane_id, wallet, kind, source_signature, mint, action,
        outcome, observed_at, finalized_at, event_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'CLAIMED', ?, NULL, ?)
    `).run(
      event.eventKey, event.laneId, event.wallet, event.kind,
      strictSourceExists ? event.sourceSignature! : null, event.mint ?? null, event.action ?? null,
      event.observedAt, encode(event)
    ).changes === 1;
  }

  getResearchPaperEvent(eventKey: string): ResearchPaperEvent | undefined {
    const row = this.db.prepare("SELECT event_json FROM research_paper_events WHERE event_key = ?")
      .get(eventKey) as ResearchPaperEventRow | undefined;
    return row ? decode<ResearchPaperEvent>(row.event_json) : undefined;
  }

  listResearchPaperEvents(options: {
    laneId: string;
    wallet?: string;
    kind?: ResearchPaperEventKind;
    limit?: number;
  }): ResearchPaperEvent[] {
    const bounded = Math.max(0, Math.min(500, Math.trunc(options.limit ?? 100)));
    const clauses = ["lane_id = ?"];
    const params: unknown[] = [options.laneId];
    if (options.wallet) {
      clauses.push("wallet = ?");
      params.push(options.wallet);
    }
    if (options.kind) {
      clauses.push("kind = ?");
      params.push(options.kind);
    }
    params.push(bounded);
    const rows = this.db.prepare(`
      SELECT event_json FROM research_paper_events
      WHERE ${clauses.join(" AND ")}
      ORDER BY observed_at DESC, event_key DESC LIMIT ?
    `).all(...params) as ResearchPaperEventRow[];
    return rows.map((row) => decode<ResearchPaperEvent>(row.event_json));
  }

  finalizeResearchPaperEvent(event: ResearchPaperEvent): boolean {
    if (event.outcome === "CLAIMED") throw new Error("A finalized research paper event must be terminal.");
    const existing = this.getResearchPaperEvent(event.eventKey);
    if (!existing || existing.outcome !== "CLAIMED") return false;
    if (existing.laneId !== event.laneId || existing.wallet !== event.wallet ||
        existing.kind !== event.kind || existing.sourceSignature !== event.sourceSignature ||
        existing.mint !== event.mint || existing.action !== event.action ||
        existing.observedAt !== event.observedAt) {
      throw new Error("A finalized research paper event changed immutable source identity.");
    }
    const normalized: ResearchPaperEvent = {
      ...event,
      finalizedAt: event.finalizedAt ?? nowIso()
    };
    return this.db.prepare(`
      UPDATE research_paper_events SET outcome = ?, finalized_at = ?, event_json = ?
      WHERE event_key = ? AND outcome = 'CLAIMED'
    `).run(
      normalized.outcome, normalized.finalizedAt!, encode(normalized), normalized.eventKey
    ).changes === 1;
  }

  commitResearchPaperEvent(input: {
    event: ResearchPaperEvent;
    account: ResearchPaperLeaderAccount;
    positions?: readonly ResearchPaperPosition[];
  }): boolean {
    if (input.event.laneId !== input.account.laneId || input.event.wallet !== input.account.wallet) {
      throw new Error("Research paper event and account identities must match.");
    }
    return this.db.transaction(() => {
      if (!this.finalizeResearchPaperEvent(input.event)) return false;
      this.upsertResearchPaperLeader(input.account);
      for (const position of input.positions ?? []) {
        if (position.laneId !== input.account.laneId || position.wallet !== input.account.wallet) {
          throw new Error("Research paper position and account identities must match.");
        }
        this.upsertResearchPaperPosition(position);
      }
      return true;
    })();
  }

  researchPaperDashboard(laneId?: string, limit = 50): ResearchPaperDashboard {
    const lane = laneId
      ? this.getResearchPaperLane(laneId)
      : this.activeResearchPaperLane() ?? this.latestResearchPaperLane();
    const capturedAt = nowIso();
    if (!lane) return {
      label: RESEARCH_PAPER_LABEL,
      promotionEligible: false,
      executionEnabled: false,
      leaders: [],
      positions: [],
      recentSignals: [],
      recentTrades: [],
      updatedAt: capturedAt
    };
    const bounded = Math.max(0, Math.min(100, Math.trunc(limit)));
    const recentEvents = this.listResearchPaperEvents({
      laneId: lane.id,
      limit: Math.min(500, Math.max(bounded, bounded * 3))
    });
    const leaders = this.listResearchPaperLeaders(lane.id, bounded);
    const openPositions = this.listResearchPaperPositions({
      laneId: lane.id,
      openOnly: true,
      limit: 500
    });
    const exitLedger = this.db.prepare(`
      SELECT wallet,
             COALESCE(SUM(
               CASE WHEN json_type(event_json, '$.trade.pnlUsd') IN ('real', 'integer')
                    THEN CAST(json_extract(event_json, '$.trade.pnlUsd') AS REAL)
                    ELSE 0 END
             ), 0) AS recorded_closed_trade_pnl_usd,
             SUM(CASE WHEN kind = 'SIGNAL' AND action = 'SELL'
                           AND json_type(event_json, '$.trade') IS NULL
                      THEN 1 ELSE 0 END) AS proportional_exit_count,
             SUM(CASE WHEN json_extract(event_json, '$.trade.exitEvidence') = 'BALANCE_RECONCILIATION'
                      THEN 1 ELSE 0 END) AS balance_reconciled_trade_count
      FROM research_paper_events
      WHERE lane_id = ? AND outcome = 'SIMULATED'
        AND (
          json_type(event_json, '$.trade') IS NOT NULL OR
          (kind = 'SIGNAL' AND action = 'SELL')
        )
      GROUP BY wallet
    `).all(lane.id).map((row) => {
      const value = row as {
        wallet: string;
        recorded_closed_trade_pnl_usd: number;
        proportional_exit_count: number;
        balance_reconciled_trade_count: number;
      };
      return {
        wallet: value.wallet,
        recordedClosedTradePnlUsd: value.recorded_closed_trade_pnl_usd,
        proportionalExitCount: value.proportional_exit_count,
        balanceReconciledTradeCount: value.balance_reconciled_trade_count
      } satisfies ResearchPaperExitLedgerEvidence;
    });
    const latestWatchlistRun = this.latestResearchPaperWatchlistRun(lane.id);
    return {
      label: RESEARCH_PAPER_LABEL,
      promotionEligible: false,
      executionEnabled: false,
      lane,
      leaders,
      positions: openPositions.slice(0, bounded),
      recentSignals: recentEvents
        .filter((event) => event.kind !== "NAV_MARK")
        .slice(0, bounded),
      recentTrades: recentEvents
        .map((event) => event.trade)
        .filter((trade): trade is NonNullable<typeof trade> => trade !== undefined)
        .slice(0, bounded),
      performanceEvidence: summarizeResearchPaperPerformance({
        leaders,
        positions: openPositions,
        exitLedger,
        capturedAt
      }),
      watchlist: {
        ...(latestWatchlistRun ? { latestRun: latestWatchlistRun } : {}),
        members: this.listResearchPaperWatchlistMembers(lane.id, bounded)
      },
      updatedAt: capturedAt
    };
  }

  createAutonomousPaperLane(input: {
    id: string;
    policyVersion: string;
    policy: AutonomousPaperPolicy;
    initialNavUsd?: number;
    startedAt?: string;
  }): AutonomousPaperLane {
    const id = input.id.trim();
    const policyVersion = input.policyVersion.trim();
    if (!id || !policyVersion) {
      throw new Error("Autonomous paper lane id and policy version are required.");
    }
    const initialNavUsd = input.initialNavUsd ?? DEFAULT_RISK_POLICY.initialNavUsd;
    finiteResearchNumber(initialNavUsd, "Autonomous paper initial NAV", Number.EPSILON);
    const startedAt = input.startedAt ?? nowIso();
    if (!Number.isFinite(Date.parse(startedAt))) {
      throw new Error("Autonomous paper lane start time is invalid.");
    }
    validateAutonomousPaperPolicy(input.policy);
    const existing = this.getAutonomousPaperLane(id);
    if (existing) {
      if (
        existing.policyVersion !== policyVersion ||
        existing.initialNavUsd !== initialNavUsd ||
        encode(existing.policy) !== encode(input.policy)
      ) {
        throw new Error("An existing autonomous paper lane cannot change its frozen policy or initial NAV.");
      }
      return existing;
    }
    const lane: AutonomousPaperLane = {
      id,
      label: AUTONOMOUS_PAPER_LABEL,
      purpose: "RESEARCH_ONLY",
      policyVersion,
      policy: { ...input.policy },
      initialNavUsd,
      status: "ACTIVE",
      startedAt,
      updatedAt: startedAt
    };
    this.db.prepare(`
      INSERT INTO autonomous_paper_lanes(
        id, label, purpose, policy_version, policy_json, initial_nav_usd,
        status, started_at, updated_at
      ) VALUES (?, ?, 'RESEARCH_ONLY', ?, ?, ?, 'ACTIVE', ?, ?)
    `).run(
      lane.id,
      lane.label,
      lane.policyVersion,
      encode(lane.policy),
      lane.initialNavUsd,
      lane.startedAt,
      lane.updatedAt
    );
    return lane;
  }

  getAutonomousPaperLane(id: string): AutonomousPaperLane | undefined {
    const row = this.db.prepare("SELECT * FROM autonomous_paper_lanes WHERE id = ?")
      .get(id) as AutonomousPaperLaneRow | undefined;
    return row ? decodeAutonomousPaperLane(row) : undefined;
  }

  activeAutonomousPaperLane(): AutonomousPaperLane | undefined {
    const row = this.db.prepare(`
      SELECT * FROM autonomous_paper_lanes WHERE status = 'ACTIVE' LIMIT 1
    `).get() as AutonomousPaperLaneRow | undefined;
    return row ? decodeAutonomousPaperLane(row) : undefined;
  }

  latestAutonomousPaperLane(): AutonomousPaperLane | undefined {
    const row = this.db.prepare(`
      SELECT * FROM autonomous_paper_lanes ORDER BY started_at DESC, id DESC LIMIT 1
    `).get() as AutonomousPaperLaneRow | undefined;
    return row ? decodeAutonomousPaperLane(row) : undefined;
  }

  requestAutonomousPaperUpgradeDrain(input: {
    laneId: string;
    fromPolicyVersion: string;
    toPolicyVersion: string;
    requestedAt?: string;
  }): AutonomousPaperUpgradeDrain {
    const requested = normalizeAutonomousPaperUpgradeDrain({
      laneId: input.laneId.trim(),
      fromPolicyVersion: input.fromPolicyVersion.trim(),
      toPolicyVersion: input.toPolicyVersion.trim(),
      requestedAt: input.requestedAt ?? nowIso()
    });
    if (!requested) {
      throw new Error("Autonomous paper upgrade-drain metadata is invalid.");
    }
    const lane = this.getAutonomousPaperLane(requested.laneId);
    if (!lane || lane.status !== "ACTIVE") {
      throw new Error("Autonomous paper upgrade drain requires the active source lane.");
    }
    if (lane.policyVersion !== requested.fromPolicyVersion) {
      throw new Error("Autonomous paper upgrade drain must match the source policy version.");
    }
    if (Date.parse(requested.requestedAt) < Date.parse(lane.updatedAt)) {
      throw new Error("Autonomous paper upgrade drain cannot be backdated.");
    }
    const existing = this.getAutonomousPaperUpgradeDrain(lane.id);
    if (existing) {
      if (
        existing.fromPolicyVersion === requested.fromPolicyVersion &&
        existing.toPolicyVersion === requested.toPolicyVersion
      ) return existing;
      throw new Error("A different autonomous paper upgrade drain is already active.");
    }
    this.setSetting(AUTONOMOUS_PAPER_UPGRADE_DRAIN_SETTING, requested);
    const persisted = this.getAutonomousPaperUpgradeDrain(lane.id);
    if (!persisted) {
      throw new Error("Autonomous paper upgrade drain was not persisted safely.");
    }
    return persisted;
  }

  getAutonomousPaperUpgradeDrain(laneId?: string): AutonomousPaperUpgradeDrain | undefined {
    let raw: unknown;
    try {
      raw = this.getSetting<unknown>(AUTONOMOUS_PAPER_UPGRADE_DRAIN_SETTING);
    } catch {
      return undefined;
    }
    const drain = normalizeAutonomousPaperUpgradeDrain(raw);
    if (!drain) return undefined;
    const requestedLaneId = laneId?.trim();
    if (laneId !== undefined && (!requestedLaneId || requestedLaneId !== drain.laneId)) {
      return undefined;
    }
    const lane = this.getAutonomousPaperLane(drain.laneId);
    if (
      !lane ||
      lane.status !== "ACTIVE" ||
      lane.policyVersion !== drain.fromPolicyVersion ||
      Date.parse(drain.requestedAt) < Date.parse(lane.startedAt)
    ) return undefined;
    return drain;
  }

  /** Entry authorization is deliberately stricter than dashboard decoding.
   * The fixed setting key is an interlock: if anything is present there,
   * including corrupt or stale JSON, no autonomous PAPER entry is authorized.
   * A caller may still mark and exit existing positions while this returns
   * true. Only an explicit clear or an atomic policy rotation consumes it. */
  autonomousPaperUpgradeDrainBlocksEntries(laneId: string): boolean {
    if (!laneId.trim()) {
      throw new Error("Autonomous paper upgrade-drain lane id is required.");
    }
    return Boolean(this.db.prepare("SELECT 1 AS present FROM settings WHERE key = ?")
      .get(AUTONOMOUS_PAPER_UPGRADE_DRAIN_SETTING));
  }

  clearAutonomousPaperUpgradeDrain(laneId: string): boolean {
    const normalizedLaneId = laneId.trim();
    if (!normalizedLaneId) {
      throw new Error("Autonomous paper upgrade-drain lane id is required.");
    }
    let raw: unknown;
    try {
      raw = this.getSetting<unknown>(AUTONOMOUS_PAPER_UPGRADE_DRAIN_SETTING);
    } catch {
      return false;
    }
    const drain = normalizeAutonomousPaperUpgradeDrain(raw);
    if (!drain || drain.laneId !== normalizedLaneId) return false;
    return this.db.prepare("DELETE FROM settings WHERE key = ?")
      .run(AUTONOMOUS_PAPER_UPGRADE_DRAIN_SETTING).changes === 1;
  }

  pauseAutonomousPaperLane(id: string, at = nowIso()): AutonomousPaperLane | undefined {
    this.db.prepare(`
      UPDATE autonomous_paper_lanes SET status = 'PAUSED', updated_at = ?
      WHERE id = ? AND status = 'ACTIVE'
    `).run(at, id);
    return this.getAutonomousPaperLane(id);
  }

  resumeAutonomousPaperLane(id: string, at = nowIso()): AutonomousPaperLane | undefined {
    this.db.prepare(`
      UPDATE autonomous_paper_lanes SET status = 'ACTIVE', updated_at = ?
      WHERE id = ? AND status = 'PAUSED'
    `).run(at, id);
    return this.getAutonomousPaperLane(id);
  }

  /**
   * Starts a distinct autonomous-policy epoch without rewriting the prior
   * lane's frozen policy, account, positions, or event journal. The caller
   * must pause and drain the engine first; this repository boundary then
   * proves there is no inventory or unfinished work before carrying only the
   * executable NAV into the new research-only account.
   */
  rotateAutonomousPaperLane(input: {
    priorLaneId: string;
    newLaneId: string;
    policyVersion: string;
    policy: AutonomousPaperPolicy;
    rotatedAt?: string;
  }): AutonomousPaperLane {
    const priorLaneId = input.priorLaneId.trim();
    const newLaneId = input.newLaneId.trim();
    const policyVersion = input.policyVersion.trim();
    const rotatedAt = input.rotatedAt ?? nowIso();
    if (
      !priorLaneId ||
      !newLaneId ||
      priorLaneId === newLaneId ||
      !policyVersion ||
      !Number.isFinite(Date.parse(rotatedAt))
    ) {
      throw new Error("Autonomous paper policy rotation metadata is invalid.");
    }
    validateAutonomousPaperPolicy(input.policy);

    return this.db.transaction(() => {
      if (this.activeAutonomousPaperLane()) {
        throw new Error("Autonomous paper policy rotation requires no active lane.");
      }
      const prior = this.getAutonomousPaperLane(priorLaneId);
      if (!prior || prior.status !== "PAUSED") {
        throw new Error("Autonomous paper policy rotation requires the prior lane to be paused.");
      }
      if (Date.parse(rotatedAt) < Date.parse(prior.updatedAt)) {
        throw new Error("Autonomous paper policy rotation cannot be backdated.");
      }
      if (this.getAutonomousPaperLane(newLaneId)) {
        throw new Error("Autonomous paper policy rotation requires a distinct new lane id.");
      }
      if (prior.policyVersion === policyVersion) {
        throw new Error("Autonomous paper policy rotation requires a new policy version.");
      }

      const upgradeDrainRow = this.db.prepare(`
        SELECT value_json FROM settings WHERE key = ?
      `).get(AUTONOMOUS_PAPER_UPGRADE_DRAIN_SETTING) as
        | { value_json: string }
        | undefined;
      if (upgradeDrainRow) {
        let upgradeDrain: AutonomousPaperUpgradeDrain | undefined;
        try {
          upgradeDrain = normalizeAutonomousPaperUpgradeDrain(
            decode<unknown>(upgradeDrainRow.value_json)
          );
        } catch {
          upgradeDrain = undefined;
        }
        if (
          !upgradeDrain ||
          upgradeDrain.laneId !== prior.id ||
          upgradeDrain.fromPolicyVersion !== prior.policyVersion ||
          upgradeDrain.toPolicyVersion !== policyVersion ||
          Date.parse(upgradeDrain.requestedAt) < Date.parse(prior.startedAt)
        ) {
          throw new Error(
            "Autonomous paper policy rotation is blocked by invalid upgrade-drain state."
          );
        }
      }

      const account = this.getAutonomousPaperAccount(prior.id);
      if (!account) {
        throw new Error("Autonomous paper policy rotation requires the prior account.");
      }
      const tolerance = 0.02;
      const openRows = this.db.prepare(`
        SELECT COUNT(*) AS count FROM autonomous_paper_positions
        WHERE lane_id = ? AND status IN ('OPEN', 'UNPRICED')
      `).get(prior.id) as { count: number };
      if (
        !account.pricingComplete ||
        account.openPositions !== 0 ||
        openRows.count !== 0 ||
        Math.abs(account.deployedUsd) > tolerance ||
        Math.abs(account.unrealizedPnlUsd) > tolerance ||
        Math.abs(account.cashUsd - account.navUsd) > tolerance ||
        account.navUsd <= 0
      ) {
        throw new Error("Autonomous paper policy rotation requires a flat, fully priced, reconciled prior account.");
      }
      const expectedNav = account.initialNavUsd + account.realizedPnlUsd + account.unrealizedPnlUsd;
      const expectedRealized = account.grossProfitUsd - account.grossLossUsd;
      if (
        Math.abs(account.navUsd - expectedNav) > tolerance ||
        Math.abs(account.realizedPnlUsd - expectedRealized) > tolerance
      ) {
        throw new Error("Autonomous paper policy rotation requires a flat, fully priced, reconciled prior account.");
      }

      const unfinished = this.db.prepare(`
        SELECT COUNT(*) AS count FROM autonomous_paper_events WHERE outcome = 'CLAIMED'
      `).get() as { count: number };
      if (unfinished.count !== 0) {
        throw new Error("Autonomous paper policy rotation requires all autonomous claims to be finalized.");
      }
      const priorEvents = this.db.prepare(`
        SELECT COUNT(*) AS count FROM autonomous_paper_events WHERE lane_id = ?
      `).get(prior.id) as { count: number };

      const archived = this.db.prepare(`
        UPDATE autonomous_paper_lanes
        SET status = 'ARCHIVED', updated_at = ?, archived_at = ?
        WHERE id = ? AND status = 'PAUSED'
      `).run(rotatedAt, rotatedAt, prior.id);
      if (archived.changes !== 1) {
        throw new Error("The paused autonomous paper lane changed concurrently.");
      }

      const lane = this.createAutonomousPaperLane({
        id: newLaneId,
        policyVersion,
        policy: { ...input.policy },
        initialNavUsd: account.navUsd,
        startedAt: rotatedAt
      });
      const nextAccount = this.initializeAutonomousPaperAccount(lane.id, rotatedAt);
      if (
        nextAccount.initialNavUsd !== account.navUsd ||
        nextAccount.cashUsd !== account.navUsd ||
        nextAccount.navUsd !== account.navUsd ||
        nextAccount.openPositions !== 0 ||
        nextAccount.completedTrades !== 0
      ) {
        throw new Error("The rotated autonomous paper account did not preserve the executable NAV boundary.");
      }

      if (upgradeDrainRow) {
        const cleared = this.db.prepare(`
          DELETE FROM settings WHERE key = ? AND value_json = ?
        `).run(AUTONOMOUS_PAPER_UPGRADE_DRAIN_SETTING, upgradeDrainRow.value_json);
        if (cleared.changes !== 1) {
          throw new Error("Autonomous paper policy rotation could not consume its upgrade drain atomically.");
        }
      }

      this.audit(
        "autonomous_paper_policy_rotated",
        "A flat autonomous PAPER account started a distinct policy epoch without rewriting prior evidence.",
        {
          priorLaneId: prior.id,
          newLaneId: lane.id,
          priorPolicyVersion: prior.policyVersion,
          policyVersion: lane.policyVersion,
          carryForwardNavUsd: account.navUsd,
          priorEventCount: priorEvents.count,
          priorDataPreserved: true,
          upgradeDrainConsumed: upgradeDrainRow !== undefined,
          executionEnabled: false,
          promotionEligible: false,
          rotatedAt
        }
      );
      return lane;
    })();
  }

  initializeAutonomousPaperAccount(
    laneId?: string,
    at = nowIso()
  ): AutonomousPaperAccount {
    const lane = laneId
      ? this.getAutonomousPaperLane(laneId)
      : this.activeAutonomousPaperLane();
    if (!lane || lane.status !== "ACTIVE") {
      throw new Error("An active autonomous paper lane is required.");
    }
    const account: AutonomousPaperAccount = {
      laneId: lane.id,
      initialNavUsd: lane.initialNavUsd,
      cashUsd: lane.initialNavUsd,
      navUsd: lane.initialNavUsd,
      peakNavUsd: lane.initialNavUsd,
      deployedUsd: 0,
      realizedPnlUsd: 0,
      unrealizedPnlUsd: 0,
      maxDrawdownPercent: 0,
      openPositions: 0,
      completedTrades: 0,
      winningTrades: 0,
      grossProfitUsd: 0,
      grossLossUsd: 0,
      pricingComplete: true,
      updatedAt: at
    };
    this.db.prepare(`
      INSERT OR IGNORE INTO autonomous_paper_accounts(
        lane_id, initial_nav_usd, cash_usd, nav_usd, peak_nav_usd,
        deployed_usd, realized_pnl_usd, unrealized_pnl_usd,
        max_drawdown_percent, open_positions, completed_trades, winning_trades,
        gross_profit_usd, gross_loss_usd, pricing_complete, account_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, ?, ?)
    `).run(
      account.laneId,
      account.initialNavUsd,
      account.cashUsd,
      account.navUsd,
      account.peakNavUsd,
      encode(account),
      account.updatedAt
    );
    const persisted = this.getAutonomousPaperAccount(lane.id);
    if (!persisted) throw new Error("Autonomous paper account was not persisted.");
    return persisted;
  }

  getAutonomousPaperAccount(laneId: string): AutonomousPaperAccount | undefined {
    const row = this.db.prepare(`
      SELECT account_json FROM autonomous_paper_accounts WHERE lane_id = ?
    `).get(laneId) as { account_json: string } | undefined;
    return row ? decode<AutonomousPaperAccount>(row.account_json) : undefined;
  }

  upsertAutonomousPaperAccount(account: AutonomousPaperAccount): void {
    if (!account.laneId) throw new Error("Autonomous paper account identity is required.");
    finiteResearchNumber(account.initialNavUsd, "Autonomous account initial NAV", Number.EPSILON);
    finiteResearchNumber(account.cashUsd, "Autonomous account cash");
    finiteResearchNumber(account.navUsd, "Autonomous account NAV");
    finiteResearchNumber(account.peakNavUsd, "Autonomous account peak NAV");
    finiteResearchNumber(account.deployedUsd, "Autonomous account deployed value");
    finiteResearchNumber(account.maxDrawdownPercent, "Autonomous account drawdown");
    finiteResearchNumber(account.grossProfitUsd, "Autonomous account gross profit");
    finiteResearchNumber(account.grossLossUsd, "Autonomous account gross loss");
    if (!Number.isFinite(account.realizedPnlUsd) || !Number.isFinite(account.unrealizedPnlUsd)) {
      throw new RangeError("Autonomous account PnL must be finite.");
    }
    for (const [value, label] of [
      [account.openPositions, "open positions"],
      [account.completedTrades, "completed trades"],
      [account.winningTrades, "winning trades"]
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError(`Autonomous account ${label} must be a non-negative integer.`);
      }
    }
    if (account.winningTrades > account.completedTrades) {
      throw new RangeError("Autonomous winning trades cannot exceed completed trades.");
    }
    const accountingTolerance = 0.02;
    if (account.peakNavUsd + accountingTolerance < account.navUsd) {
      throw new RangeError("Autonomous account peak NAV cannot be below current NAV.");
    }
    if (account.cashUsd > account.navUsd + accountingTolerance) {
      throw new RangeError("Autonomous account cash cannot exceed executable NAV.");
    }
    if (Math.abs(
      account.initialNavUsd + account.realizedPnlUsd + account.unrealizedPnlUsd - account.navUsd
    ) > accountingTolerance) {
      throw new RangeError("Autonomous account NAV does not reconcile to initial NAV and PnL.");
    }
    if (Math.abs(
      account.grossProfitUsd - account.grossLossUsd - account.realizedPnlUsd
    ) > accountingTolerance) {
      throw new RangeError("Autonomous account realized PnL does not reconcile to gross results.");
    }
    const currentDrawdown = account.peakNavUsd > 0
      ? Math.max(0, (account.peakNavUsd - account.navUsd) / account.peakNavUsd * 100)
      : 0;
    if (account.pricingComplete && account.maxDrawdownPercent + 1e-6 < currentDrawdown) {
      throw new RangeError("Autonomous account maximum drawdown understates the current drawdown.");
    }
    if (!Number.isFinite(Date.parse(account.updatedAt))) {
      throw new RangeError("Autonomous account update time must be valid.");
    }
    const lane = this.getAutonomousPaperLane(account.laneId);
    if (!lane) throw new Error("Autonomous paper account requires an existing lane.");
    if (account.openPositions > lane.policy.maximumOpenPositions) {
      throw new RangeError("Autonomous account exceeds its frozen open-position limit.");
    }
    const existing = this.getAutonomousPaperAccount(account.laneId);
    if (existing && existing.initialNavUsd !== account.initialNavUsd) {
      throw new Error("An autonomous paper account cannot change its initial NAV.");
    }
    if (account.initialNavUsd !== lane.initialNavUsd) {
      throw new Error("Autonomous paper account initial NAV must match its lane.");
    }
    this.db.prepare(`
      INSERT INTO autonomous_paper_accounts(
        lane_id, initial_nav_usd, cash_usd, nav_usd, peak_nav_usd,
        deployed_usd, realized_pnl_usd, unrealized_pnl_usd,
        max_drawdown_percent, open_positions, completed_trades, winning_trades,
        gross_profit_usd, gross_loss_usd, pricing_complete, account_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(lane_id) DO UPDATE SET
        initial_nav_usd=excluded.initial_nav_usd,
        cash_usd=excluded.cash_usd,
        nav_usd=excluded.nav_usd,
        peak_nav_usd=excluded.peak_nav_usd,
        deployed_usd=excluded.deployed_usd,
        realized_pnl_usd=excluded.realized_pnl_usd,
        unrealized_pnl_usd=excluded.unrealized_pnl_usd,
        max_drawdown_percent=excluded.max_drawdown_percent,
        open_positions=excluded.open_positions,
        completed_trades=excluded.completed_trades,
        winning_trades=excluded.winning_trades,
        gross_profit_usd=excluded.gross_profit_usd,
        gross_loss_usd=excluded.gross_loss_usd,
        pricing_complete=excluded.pricing_complete,
        account_json=excluded.account_json,
        updated_at=excluded.updated_at
    `).run(
      account.laneId,
      account.initialNavUsd,
      account.cashUsd,
      account.navUsd,
      account.peakNavUsd,
      account.deployedUsd,
      account.realizedPnlUsd,
      account.unrealizedPnlUsd,
      account.maxDrawdownPercent,
      account.openPositions,
      account.completedTrades,
      account.winningTrades,
      account.grossProfitUsd,
      account.grossLossUsd,
      account.pricingComplete ? 1 : 0,
      encode(account),
      account.updatedAt
    );
  }

  getAutonomousPaperPosition(id: string): AutonomousPaperPosition | undefined {
    const row = this.db.prepare(`
      SELECT position_json FROM autonomous_paper_positions WHERE id = ?
    `).get(id) as { position_json: string } | undefined;
    return row ? decode<AutonomousPaperPosition>(row.position_json) : undefined;
  }

  listAutonomousPaperPositions(options: {
    laneId: string;
    openOnly?: boolean;
    limit?: number;
  }): AutonomousPaperPosition[] {
    const bounded = Math.max(0, Math.min(500, Math.trunc(options.limit ?? 100)));
    const openClause = options.openOnly ? "AND status IN ('OPEN', 'UNPRICED')" : "";
    const rows = this.db.prepare(`
      SELECT position_json FROM autonomous_paper_positions
      WHERE lane_id = ? ${openClause}
      ORDER BY updated_at DESC, id LIMIT ?
    `).all(options.laneId, bounded) as Array<{ position_json: string }>;
    return rows.map((row) => decode<AutonomousPaperPosition>(row.position_json));
  }

  upsertAutonomousPaperPosition(position: AutonomousPaperPosition): void {
    if (!position.id || !position.laneId || !position.entryDecisionId || !position.mint) {
      throw new Error("Autonomous paper position identity is required.");
    }
    if (!/^\d+$/.test(position.initialAmountAtomic) || BigInt(position.initialAmountAtomic) <= 0n ||
        !/^\d+$/.test(position.remainingAmountAtomic) || BigInt(position.remainingAmountAtomic) < 0n ||
        BigInt(position.remainingAmountAtomic) > BigInt(position.initialAmountAtomic)) {
      throw new RangeError("Autonomous position amounts must be valid non-negative atomic units.");
    }
    for (const [value, label, minimum] of [
      [position.entryCostUsd, "entry cost", 0],
      [position.remainingCostUsd, "remaining cost", 0],
      [position.lastExecutableValueUsd, "executable value", 0],
      [position.peakExecutableValueUsd, "peak executable value", 0],
      [position.entryPriceUsd, "entry price", Number.EPSILON],
      [position.lastPriceUsd, "last price", Number.EPSILON],
      [position.stopPriceUsd, "stop price", Number.EPSILON],
      [position.takeProfitPriceUsd, "take-profit price", Number.EPSILON]
    ] as const) finiteResearchNumber(value, `Autonomous position ${label}`, minimum);
    if (position.breakEvenPriceUsd !== undefined) {
      finiteResearchNumber(position.breakEvenPriceUsd, "Autonomous position break-even price", Number.EPSILON);
    }
    if (position.trailingStopPriceUsd !== undefined) {
      finiteResearchNumber(position.trailingStopPriceUsd, "Autonomous position trailing-stop price", Number.EPSILON);
    }
    if (!Number.isSafeInteger(position.weakMomentumSamples) || position.weakMomentumSamples < 0) {
      throw new RangeError("Autonomous weak-momentum samples must be a non-negative integer.");
    }
    if (!Number.isFinite(Date.parse(position.openedAt)) ||
        !Number.isFinite(Date.parse(position.updatedAt)) ||
        (position.closedAt !== undefined && !Number.isFinite(Date.parse(position.closedAt)))) {
      throw new RangeError("Autonomous position timestamps must be valid.");
    }
    if (position.status === "CLOSED" && !position.closedAt) {
      throw new Error("A closed autonomous position requires a close timestamp.");
    }
    if (position.status === "CLOSED" && (
      position.remainingAmountAtomic !== "0" || position.remainingCostUsd !== 0
    )) throw new Error("A closed autonomous position cannot retain inventory or cost basis.");
    if (position.status !== "CLOSED" && (
      BigInt(position.remainingAmountAtomic) <= 0n || position.remainingCostUsd <= 0
    )) throw new Error("An open autonomous position requires inventory and positive cost basis.");
    if (position.peakExecutableValueUsd + 1e-9 < position.lastExecutableValueUsd) {
      throw new RangeError("Autonomous peak executable value cannot be below the latest value.");
    }
    if (position.stopPriceUsd >= position.entryPriceUsd ||
        position.takeProfitPriceUsd <= position.entryPriceUsd) {
      throw new RangeError("Autonomous stop and take-profit prices must bracket entry price.");
    }
    const existing = this.getAutonomousPaperPosition(position.id);
    if (existing && (
      existing.laneId !== position.laneId ||
      existing.entryDecisionId !== position.entryDecisionId ||
      existing.mint !== position.mint ||
      existing.initialAmountAtomic !== position.initialAmountAtomic ||
      existing.openedAt !== position.openedAt
    )) {
      throw new Error("An autonomous paper position cannot change immutable entry identity.");
    }
    if (existing) {
      if (existing.status === "CLOSED" && position.status !== "CLOSED") {
        throw new Error("A closed autonomous paper position is terminal.");
      }
      if (
        BigInt(position.remainingAmountAtomic) > BigInt(existing.remainingAmountAtomic) ||
        position.remainingCostUsd > existing.remainingCostUsd + 1e-9
      ) throw new Error("Autonomous paper inventory and cost basis cannot increase after entry.");
      if (position.peakExecutableValueUsd + 1e-9 < existing.peakExecutableValueUsd) {
        throw new Error("Autonomous peak executable value cannot move backward.");
      }
      if (Date.parse(position.updatedAt) < Date.parse(existing.updatedAt)) {
        throw new Error("Autonomous position updates cannot move backward in time.");
      }
    }
    if (!this.getAutonomousPaperLane(position.laneId)) {
      throw new Error("Autonomous paper position requires an existing lane.");
    }
    this.db.prepare(`
      INSERT INTO autonomous_paper_positions(
        id, lane_id, mint, status, position_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status=excluded.status,
        position_json=excluded.position_json,
        updated_at=excluded.updated_at
    `).run(
      position.id,
      position.laneId,
      position.mint,
      position.status,
      encode(position),
      position.updatedAt
    );
  }

  claimAutonomousPaperEvent(event: AutonomousPaperEvent): boolean {
    if (event.outcome !== "CLAIMED") {
      throw new Error("An autonomous paper event claim must use CLAIMED outcome.");
    }
    if (!event.eventKey || !event.laneId || !Number.isFinite(Date.parse(event.observedAt))) {
      throw new Error("Autonomous paper event identity is invalid.");
    }
    if (!this.getAutonomousPaperLane(event.laneId)) {
      throw new Error("Autonomous paper event requires an existing lane.");
    }
    return this.db.prepare(`
      INSERT OR IGNORE INTO autonomous_paper_events(
        event_key, lane_id, kind, mint, action, outcome,
        observed_at, finalized_at, event_json
      ) VALUES (?, ?, ?, ?, ?, 'CLAIMED', ?, NULL, ?)
    `).run(
      event.eventKey,
      event.laneId,
      event.kind,
      event.mint ?? null,
      event.action ?? null,
      event.observedAt,
      encode(event)
    ).changes === 1;
  }

  getAutonomousPaperEvent(eventKey: string): AutonomousPaperEvent | undefined {
    const row = this.db.prepare(`
      SELECT event_json FROM autonomous_paper_events WHERE event_key = ?
    `).get(eventKey) as AutonomousPaperEventRow | undefined;
    return row ? decode<AutonomousPaperEvent>(row.event_json) : undefined;
  }

  listAutonomousPaperEvents(options: {
    laneId: string;
    mint?: string;
    kind?: AutonomousPaperEventKind;
    limit?: number;
  }): AutonomousPaperEvent[] {
    const bounded = Math.max(0, Math.min(500, Math.trunc(options.limit ?? 100)));
    const clauses = ["lane_id = ?"];
    const params: unknown[] = [options.laneId];
    if (options.mint) {
      clauses.push("mint = ?");
      params.push(options.mint);
    }
    if (options.kind) {
      clauses.push("kind = ?");
      params.push(options.kind);
    }
    params.push(bounded);
    const rows = this.db.prepare(`
      SELECT event_json FROM autonomous_paper_events
      WHERE ${clauses.join(" AND ")}
      ORDER BY observed_at DESC, event_key DESC LIMIT ?
    `).all(...params) as AutonomousPaperEventRow[];
    return rows.map((row) => decode<AutonomousPaperEvent>(row.event_json));
  }

  /**
   * Returns every unfinished event for the active lane. Recovery must not use
   * the generic recent-event window: rejection-heavy cycles can add more than
   * 500 terminal decisions after an older interrupted root claim.
   */
  listClaimedAutonomousPaperEvents(laneId: string): AutonomousPaperEvent[] {
    const id = laneId.trim();
    const lane = id ? this.getAutonomousPaperLane(id) : undefined;
    if (!lane || lane.status !== "ACTIVE") {
      throw new Error("An active autonomous paper lane is required to list unfinished claims.");
    }
    const rows = this.db.prepare(`
      SELECT event_json FROM autonomous_paper_events
      WHERE lane_id = ? AND outcome = 'CLAIMED'
      ORDER BY observed_at ASC, event_key ASC
    `).all(id) as AutonomousPaperEventRow[];
    return rows.map((row) => decode<AutonomousPaperEvent>(row.event_json));
  }

  /** Material completed exits used by deterministic V5 sizing calibration.
   * Candidate-detail compaction never deletes these TRADE rows. */
  listAutonomousPaperTradesForCalibration(
    laneId: string,
    limit = 100
  ): AutonomousPaperTrade[] {
    const id = laneId.trim();
    if (!id || !this.getAutonomousPaperLane(id)) {
      throw new Error("Autonomous sizing calibration requires an existing lane.");
    }
    const bounded = Math.max(0, Math.min(500, Math.trunc(limit)));
    const rows = this.db.prepare(`
      SELECT event_json
      FROM autonomous_paper_events
      WHERE lane_id = ?
        AND kind = 'TRADE'
        AND action = 'SELL'
        AND outcome = 'SIMULATED'
        AND json_type(event_json, '$.trade') = 'object'
      ORDER BY observed_at DESC, event_key DESC
      LIMIT ?
    `).all(id, bounded) as AutonomousPaperEventRow[];
    return rows
      .map((row) => decode<AutonomousPaperEvent>(row.event_json).trade)
      .filter((value): value is AutonomousPaperTrade => value !== undefined);
  }

  createAutonomousPaperReplayEpisode(
    episode: AutonomousPaperReplayEpisode
  ): AutonomousPaperReplayEpisode {
    validateAutonomousPaperReplayEpisode(episode);
    if (
      episode.status !== "CAPTURING" || episode.observationCount !== 0 ||
      episode.pathDigest !== undefined || episode.actualClosedAt !== undefined ||
      episode.completedAt !== undefined || episode.incompleteReason !== undefined
    ) throw new Error("A new autonomous replay episode must begin as an empty CAPTURING path.");
    const lane = this.getAutonomousPaperLane(episode.laneId);
    const position = this.getAutonomousPaperPosition(episode.positionId);
    if (!lane || !position) {
      throw new Error("Autonomous replay episodes require an existing actual PAPER lane and position.");
    }
    if (
      lane.policyVersion !== episode.policyVersion || position.laneId !== episode.laneId ||
      position.entryDecisionId !== episode.entryDecisionId || position.mint !== episode.mint ||
      position.openedAt !== episode.actualOpenedAt
    ) throw new Error("Autonomous replay episode identity does not match its actual PAPER position.");

    return this.db.transaction(() => {
      const inserted = this.db.prepare(`
        INSERT OR IGNORE INTO autonomous_paper_replay_episodes(
          id, lane_id, position_id, entry_decision_id, mint, policy_version,
          replay_version, scenario_manifest_digest, status, actual_opened_at,
          capture_started_at, horizon_ends_at, completed_at, path_digest,
          episode_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'CAPTURING', ?, ?, ?, NULL, NULL, ?, ?)
      `).run(
        episode.id,
        episode.laneId,
        episode.positionId,
        episode.entryDecisionId,
        episode.mint,
        episode.policyVersion,
        episode.replayVersion,
        episode.scenarioManifestDigest,
        episode.actualOpenedAt,
        episode.captureStartedAt,
        episode.horizonEndsAt,
        encode(episode),
        episode.updatedAt
      ).changes;
      if (inserted === 1) return episode;
      const existing = this.getAutonomousPaperReplayEpisode(episode.id);
      if (existing && encode(existing) === encode(episode)) return existing;
      const positionConflict = this.db.prepare(`
        SELECT episode_json FROM autonomous_paper_replay_episodes WHERE position_id = ?
      `).get(episode.positionId) as AutonomousPaperReplayEpisodeRow | undefined;
      if (positionConflict) {
        throw new Error("An actual autonomous PAPER position already has a different replay episode.");
      }
      throw new Error("Autonomous replay episode idempotency identity changed.");
    })();
  }

  getAutonomousPaperReplayEpisode(id: string): AutonomousPaperReplayEpisode | undefined {
    const row = this.db.prepare(`
      SELECT episode_json FROM autonomous_paper_replay_episodes WHERE id = ?
    `).get(id) as AutonomousPaperReplayEpisodeRow | undefined;
    return row ? decode<AutonomousPaperReplayEpisode>(row.episode_json) : undefined;
  }

  listAutonomousPaperReplayEpisodes(options: {
    laneId: string;
    status?: AutonomousPaperReplayEpisodeStatus;
    limit?: number;
  }): AutonomousPaperReplayEpisode[] {
    const bounded = Math.max(0, Math.min(500, Math.trunc(options.limit ?? 100)));
    const statusClause = options.status ? "AND status = ?" : "";
    const params: unknown[] = [options.laneId];
    if (options.status) params.push(options.status);
    params.push(bounded);
    const rows = this.db.prepare(`
      SELECT episode_json FROM autonomous_paper_replay_episodes
      WHERE lane_id = ? ${statusClause}
      ORDER BY updated_at DESC, id DESC LIMIT ?
    `).all(...params) as AutonomousPaperReplayEpisodeRow[];
    return rows.map((row) => decode<AutonomousPaperReplayEpisode>(row.episode_json));
  }

  appendAutonomousPaperReplayObservation(
    observation: AutonomousPaperReplayObservation
  ): boolean {
    validateAutonomousPaperReplayObservation(observation);
    const observationJson = encode(observation);
    const observationDigest = sha256(observationJson);
    return this.db.transaction(() => {
      const episode = this.getAutonomousPaperReplayEpisode(observation.episodeId);
      if (!episode || episode.status !== "CAPTURING") {
        throw new Error("Autonomous replay observations require a CAPTURING episode.");
      }
      if (
        observation.laneId !== episode.laneId || observation.positionId !== episode.positionId ||
        observation.mint !== episode.mint
      ) throw new Error("Autonomous replay observation identity does not match its episode.");
      const observedAt = replayTimestamp(observation.observedAt, "Autonomous replay observation time");
      const sourceAt = replayTimestamp(observation.sourceUpdatedAt, "Autonomous replay source time");
      if (observedAt < Date.parse(episode.captureStartedAt) || sourceAt > observedAt + 1_000) {
        throw new Error("Autonomous replay observation uses pre-capture or future source evidence.");
      }
      for (const quotedAt of [
        observation.status === "EXECUTABLE" ? observation.entryEvidence?.quotedAt : undefined,
        observation.status === "EXECUTABLE" ? observation.exitEvidence.quotedAt : undefined
      ]) {
        if (quotedAt !== undefined && Date.parse(quotedAt) > observedAt + 1_000) {
          throw new Error("Autonomous replay observation uses future quote evidence.");
        }
      }

      const existing = this.db.prepare(`
        SELECT observation_digest, observation_json
        FROM autonomous_paper_replay_observations WHERE observation_key = ?
      `).get(observation.observationKey) as {
        observation_digest: string;
        observation_json: string;
      } | undefined;
      if (existing) {
        if (existing.observation_digest === observationDigest && existing.observation_json === observationJson) {
          return false;
        }
        throw new Error("Autonomous replay observation idempotency evidence changed.");
      }
      const previous = this.db.prepare(`
        SELECT observation_key, sequence, observed_at, phase, observation_digest, observation_json
        FROM autonomous_paper_replay_observations
        WHERE episode_id = ? ORDER BY sequence DESC LIMIT 1
      `).get(episode.id) as AutonomousPaperReplayObservationRow | undefined;
      const expectedSequence = previous ? previous.sequence + 1 : 0;
      if (observation.sequence !== expectedSequence) {
        throw new Error("Autonomous replay observation sequence must be contiguous and append-only.");
      }
      if (!previous && observation.phase !== "ENTRY") {
        throw new Error("An autonomous replay path must begin with ENTRY evidence.");
      }
      if (previous && observation.phase === "ENTRY") {
        throw new Error("An autonomous replay path can contain only one ENTRY observation.");
      }
      if (previous && Date.parse(observation.observedAt) <= Date.parse(previous.observed_at)) {
        throw new Error("Autonomous replay observation time must move strictly forward.");
      }
      if (previous && ["ACTUAL_EXIT", "POST_EXIT"].includes(previous.phase) &&
          observation.phase !== "POST_EXIT") {
        throw new Error("Only POST_EXIT evidence may follow an actual autonomous exit.");
      }
      if (observation.phase === "POST_EXIT" &&
          (!previous || !["ACTUAL_EXIT", "POST_EXIT"].includes(previous.phase))) {
        throw new Error("POST_EXIT replay evidence requires an earlier actual exit.");
      }
      this.db.prepare(`
        INSERT INTO autonomous_paper_replay_observations(
          observation_key, episode_id, lane_id, position_id, mint, sequence,
          phase, observed_at, source_updated_at, observation_digest, observation_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        observation.observationKey,
        observation.episodeId,
        observation.laneId,
        observation.positionId,
        observation.mint,
        observation.sequence,
        observation.phase,
        observation.observedAt,
        observation.sourceUpdatedAt,
        observationDigest,
        observationJson
      );
      const updatedEpisode: AutonomousPaperReplayEpisode = {
        ...episode,
        observationCount: expectedSequence + 1,
        updatedAt: observation.observedAt
      };
      validateAutonomousPaperReplayEpisode(updatedEpisode);
      this.db.prepare(`
        UPDATE autonomous_paper_replay_episodes
        SET episode_json = ?, updated_at = ?
        WHERE id = ? AND status = 'CAPTURING'
      `).run(encode(updatedEpisode), updatedEpisode.updatedAt, updatedEpisode.id);
      return true;
    })();
  }

  listAutonomousPaperReplayObservations(
    episodeId: string,
    limit = 10_000
  ): AutonomousPaperReplayObservation[] {
    if (!this.getAutonomousPaperReplayEpisode(episodeId)) {
      throw new Error("Autonomous replay observations require an existing episode.");
    }
    const bounded = Math.max(0, Math.min(10_000, Math.trunc(limit)));
    const rows = this.db.prepare(`
      SELECT observation_key, sequence, observed_at, phase, observation_digest, observation_json
      FROM autonomous_paper_replay_observations
      WHERE episode_id = ? ORDER BY sequence ASC LIMIT ?
    `).all(episodeId, bounded) as AutonomousPaperReplayObservationRow[];
    return rows.map((row) => decode<AutonomousPaperReplayObservation>(row.observation_json));
  }

  completeAutonomousPaperReplayEpisode(
    episodeId: string,
    input: { completedAt: string; incompleteReason?: string }
  ): AutonomousPaperReplayEpisode {
    const completedAt = replayTimestamp(input.completedAt, "Autonomous replay completion time");
    if (input.incompleteReason !== undefined &&
        (!input.incompleteReason.trim() || input.incompleteReason.length > 1_000)) {
      throw new Error("Autonomous replay incomplete reason is invalid.");
    }
    return this.db.transaction(() => {
      const episode = this.getAutonomousPaperReplayEpisode(episodeId);
      if (!episode) throw new Error("Autonomous replay episode does not exist.");
      if (episode.status !== "CAPTURING") {
        if (episode.completedAt === input.completedAt &&
            episode.incompleteReason === input.incompleteReason) return episode;
        throw new Error("A terminal autonomous replay episode cannot be completed again differently.");
      }
      const rows = this.db.prepare(`
        SELECT observation_key, sequence, observed_at, phase, observation_digest, observation_json
        FROM autonomous_paper_replay_observations
        WHERE episode_id = ? ORDER BY sequence ASC
      `).all(episode.id) as AutonomousPaperReplayObservationRow[];
      const last = rows.at(-1);
      if (last && completedAt < Date.parse(last.observed_at)) {
        throw new Error("Autonomous replay completion precedes its final observation.");
      }
      const incomplete = input.incompleteReason !== undefined;
      const actualExit = rows.find((row) => row.phase === "ACTUAL_EXIT");
      const lane = this.getAutonomousPaperLane(episode.laneId);
      const observations = rows.map((row) =>
        decode<AutonomousPaperReplayObservation>(row.observation_json)
      );
      const cadenceGap = lane
        ? autonomousPaperReplayCadenceGap(observations, lane.policy.scanIntervalMinutes)
        : undefined;
      if (!incomplete && (
        rows.length === 0 || rows[0]?.phase !== "ENTRY" || !actualExit ||
        !last || Date.parse(last.observed_at) < Date.parse(episode.horizonEndsAt) ||
        completedAt < Date.parse(episode.horizonEndsAt) || !lane || cadenceGap
      )) throw new Error("A READY autonomous replay episode requires a complete causal horizon and actual exit.");
      const pathDigest = rows.length > 0
        ? sha256(rows.map((row) => `${row.sequence}:${row.observation_digest}`).join("\n"))
        : undefined;
      const next: AutonomousPaperReplayEpisode = {
        ...episode,
        status: incomplete ? "INCOMPLETE" : "READY",
        ...(actualExit ? { actualClosedAt: actualExit.observed_at } : {}),
        observationCount: rows.length,
        ...(pathDigest ? { pathDigest } : {}),
        ...(input.incompleteReason
          ? { incompleteReason: redactSensitiveText(input.incompleteReason, 1_000) }
          : {}),
        completedAt: input.completedAt,
        updatedAt: input.completedAt
      };
      validateAutonomousPaperReplayEpisode(next);
      this.db.prepare(`
        UPDATE autonomous_paper_replay_episodes
        SET status = ?, completed_at = ?, path_digest = ?, episode_json = ?, updated_at = ?
        WHERE id = ? AND status = 'CAPTURING'
      `).run(
        next.status,
        next.completedAt,
        next.pathDigest ?? null,
        encode(next),
        next.updatedAt,
        next.id
      );
      return next;
    })();
  }

  saveAutonomousPaperReplayReport(
    report: AutonomousPaperReplayReport,
    results: readonly AutonomousPaperReplayVariantResult[]
  ): boolean {
    validateAutonomousPaperReplayReport(report);
    if (results.length !== AUTONOMOUS_PAPER_REPLAY_VARIANT_COUNT) {
      throw new Error(`Autonomous replay reports require exactly ${AUTONOMOUS_PAPER_REPLAY_VARIANT_COUNT} variants.`);
    }
    const sorted = [...results].sort((left, right) => left.variantIndex - right.variantIndex);
    const variantIds = new Set<string>();
    const configurationDigests = new Set<string>();
    for (let index = 0; index < sorted.length; index += 1) {
      const result = sorted[index]!;
      validateAutonomousPaperReplayVariantResult(result);
      if (
        result.variantIndex !== index || result.reportId !== report.id ||
        result.episodeId !== report.episodeId || result.laneId !== report.laneId ||
        result.positionId !== report.positionId
      ) throw new Error("Autonomous replay variant identity or index coverage is invalid.");
      if (result.configurationDigest !== sha256(encode(result.parameters))) {
        throw new Error("Autonomous replay variant configuration digest does not match its parameters.");
      }
      if (variantIds.has(result.variantId) || configurationDigests.has(result.configurationDigest)) {
        throw new Error("Autonomous replay variants must have unique ids and configurations.");
      }
      variantIds.add(result.variantId);
      configurationDigests.add(result.configurationDigest);
    }
    const resultsDigest = sha256(sorted.map((result) => encode(result)).join("\n"));
    if (report.resultsDigest !== resultsDigest) {
      throw new Error("Autonomous replay results digest does not match the 1,000 variants.");
    }
    const manifestDigest = sha256(sorted.map((result) =>
      `${result.variantIndex}:${result.variantId}:${result.configurationDigest}`
    ).join("\n"));
    if (report.scenarioManifestDigest !== manifestDigest) {
      throw new Error("Autonomous replay scenario manifest does not match its 1,000 configurations.");
    }
    const scorable = sorted.filter((result) => result.outcome !== "UNSCORABLE").length;
    if (report.scorableVariantCount !== scorable || !variantIds.has(report.baselineVariantId) ||
        (report.hindsightBestVariantId !== undefined && !variantIds.has(report.hindsightBestVariantId))) {
      throw new Error("Autonomous replay report summary does not match its variants.");
    }
    const baseline = sorted.find((result) => result.variantId === report.baselineVariantId)!;
    if (baseline.returnPercent !== report.baselineReturnPercent) {
      throw new Error("Autonomous replay baseline summary does not match its selected result.");
    }
    const hindsight = sorted.filter((result) =>
      result.outcome === "COMPLETED" && result.returnPercent !== undefined
    ).sort((left, right) =>
      right.returnPercent! - left.returnPercent! || left.variantIndex - right.variantIndex
    )[0];
    if (!hindsight) {
      if (
        report.hindsightBestVariantId !== undefined ||
        report.hindsightBestReturnPercent !== undefined ||
        report.hindsightRegretPercent !== undefined
      ) throw new Error("Autonomous replay hindsight summary exists without a scorable result.");
    } else {
      const expectedRegret = baseline.returnPercent === undefined
        ? undefined
        : hindsight.returnPercent! - baseline.returnPercent;
      if (
        report.hindsightBestVariantId !== hindsight.variantId ||
        report.hindsightBestReturnPercent !== hindsight.returnPercent ||
        report.hindsightRegretPercent !== expectedRegret
      ) throw new Error("Autonomous replay hindsight summary is not the deterministic best result.");
    }
    return this.db.transaction(() => {
      const episode = this.getAutonomousPaperReplayEpisode(report.episodeId);
      if (!episode || !["READY", "REPLAYED"].includes(episode.status) ||
          !episode.pathDigest || episode.pathDigest !== report.pathDigest ||
          episode.laneId !== report.laneId || episode.positionId !== report.positionId ||
          episode.replayVersion !== report.replayVersion ||
          episode.scenarioManifestDigest !== report.scenarioManifestDigest) {
        throw new Error("Autonomous replay report does not match a READY causal episode.");
      }
      if (Date.parse(report.generatedAt) < Date.parse(episode.completedAt ?? episode.updatedAt)) {
        throw new Error("Autonomous replay report predates its completed path.");
      }
      const existing = this.getAutonomousPaperReplayReport(report.id);
      if (existing) {
        const count = (this.db.prepare(`
          SELECT COUNT(*) AS count FROM autonomous_paper_replay_variant_results WHERE report_id = ?
        `).get(report.id) as { count: number }).count;
        if (encode(existing) === encode(report) && count === AUTONOMOUS_PAPER_REPLAY_VARIANT_COUNT) return false;
        throw new Error("Autonomous replay report idempotency evidence changed.");
      }
      const episodeReport = this.db.prepare(`
        SELECT report_json FROM autonomous_paper_replay_reports WHERE episode_id = ?
      `).get(report.episodeId) as AutonomousPaperReplayReportRow | undefined;
      if (episodeReport) throw new Error("An autonomous replay episode already has a different report.");

      this.db.prepare(`
        INSERT INTO autonomous_paper_replay_reports(
          id, episode_id, lane_id, position_id, replay_version,
          scenario_manifest_digest, path_digest, results_digest, variant_count,
          scorable_variant_count, report_json, generated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        report.id,
        report.episodeId,
        report.laneId,
        report.positionId,
        report.replayVersion,
        report.scenarioManifestDigest,
        report.pathDigest,
        report.resultsDigest,
        report.variantCount,
        report.scorableVariantCount,
        encode(report),
        report.generatedAt
      );
      const insertResult = this.db.prepare(`
        INSERT INTO autonomous_paper_replay_variant_results(
          report_id, episode_id, lane_id, position_id, variant_index,
          variant_id, configuration_digest, outcome, result_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const result of sorted) {
        insertResult.run(
          result.reportId,
          result.episodeId,
          result.laneId,
          result.positionId,
          result.variantIndex,
          result.variantId,
          result.configurationDigest,
          result.outcome,
          encode(result)
        );
      }
      const replayed: AutonomousPaperReplayEpisode = {
        ...episode,
        status: "REPLAYED",
        updatedAt: report.generatedAt
      };
      validateAutonomousPaperReplayEpisode(replayed);
      this.db.prepare(`
        UPDATE autonomous_paper_replay_episodes
        SET status = 'REPLAYED', episode_json = ?, updated_at = ?
        WHERE id = ? AND status = 'READY'
      `).run(encode(replayed), replayed.updatedAt, replayed.id);
      return true;
    })();
  }

  getAutonomousPaperReplayReport(id: string): AutonomousPaperReplayReport | undefined {
    const row = this.db.prepare(`
      SELECT report_json FROM autonomous_paper_replay_reports WHERE id = ?
    `).get(id) as AutonomousPaperReplayReportRow | undefined;
    return row ? decode<AutonomousPaperReplayReport>(row.report_json) : undefined;
  }

  listAutonomousPaperReplayReports(laneId: string, limit = 20): AutonomousPaperReplayReport[] {
    const bounded = Math.max(0, Math.min(100, Math.trunc(limit)));
    const rows = this.db.prepare(`
      SELECT report_json FROM autonomous_paper_replay_reports
      WHERE lane_id = ? ORDER BY generated_at DESC, id DESC LIMIT ?
    `).all(laneId, bounded) as AutonomousPaperReplayReportRow[];
    return rows.map((row) => decode<AutonomousPaperReplayReport>(row.report_json));
  }

  listAutonomousPaperReplayVariantResults(
    reportId: string
  ): AutonomousPaperReplayVariantResult[] {
    const rows = this.db.prepare(`
      SELECT result_json FROM autonomous_paper_replay_variant_results
      WHERE report_id = ? ORDER BY variant_index ASC
    `).all(reportId) as AutonomousPaperReplayVariantRow[];
    return rows.map((row) => decode<AutonomousPaperReplayVariantResult>(row.result_json));
  }

  autonomousPaperReplayDashboard(laneId?: string, limit = 10): AutonomousPaperReplayDashboard {
    const capturedAt = nowIso();
    const bounded = Math.max(0, Math.min(50, Math.trunc(limit)));
    if (!laneId || !this.getAutonomousPaperLane(laneId)) return {
      label: AUTONOMOUS_PAPER_REPLAY_LABEL,
      executionEnabled: false,
      promotionEligible: false,
      calibrationTradeCount: 0,
      independentEpisodeCount: 0,
      scenarioEvaluations: 0,
      capturingEpisodes: 0,
      readyEpisodes: 0,
      replayedEpisodes: 0,
      incompleteEpisodes: 0,
      recentEpisodes: [],
      recentReports: [],
      recentInsights: [],
      updatedAt: capturedAt
    };
    const counts = this.db.prepare(`
      SELECT
        SUM(CASE WHEN status = 'CAPTURING' THEN 1 ELSE 0 END) AS capturing,
        SUM(CASE WHEN status = 'READY' THEN 1 ELSE 0 END) AS ready,
        SUM(CASE WHEN status = 'REPLAYED' THEN 1 ELSE 0 END) AS replayed,
        SUM(CASE WHEN status = 'INCOMPLETE' THEN 1 ELSE 0 END) AS incomplete
      FROM autonomous_paper_replay_episodes WHERE lane_id = ?
    `).get(laneId) as { capturing: number | null; ready: number | null; replayed: number | null; incomplete: number | null };
    const scenarioEvaluations = (this.db.prepare(`
      SELECT COUNT(*) AS count FROM autonomous_paper_replay_variant_results WHERE lane_id = ?
    `).get(laneId) as { count: number }).count;
    const recentEpisodes = this.listAutonomousPaperReplayEpisodes({ laneId, limit: bounded });
    const recentReports = this.listAutonomousPaperReplayReports(laneId, bounded);
    return {
      label: AUTONOMOUS_PAPER_REPLAY_LABEL,
      executionEnabled: false,
      promotionEligible: false,
      calibrationTradeCount: 0,
      independentEpisodeCount: counts.replayed ?? 0,
      scenarioEvaluations,
      capturingEpisodes: counts.capturing ?? 0,
      readyEpisodes: counts.ready ?? 0,
      replayedEpisodes: counts.replayed ?? 0,
      incompleteEpisodes: counts.incomplete ?? 0,
      recentEpisodes,
      recentReports,
      recentInsights: recentReports.map((report) => deriveAutonomousPaperReplayInsight(
        report,
        this.listAutonomousPaperReplayVariantResults(report.id),
        this.listAutonomousPaperReplayObservations(report.episodeId)
      )),
      updatedAt: capturedAt
    };
  }

  /**
   * Atomically folds only old terminal REJECT/OBSERVE detail into compact UTC
   * day summaries. Material trading, failure, NAV, trade, and unfinished-claim
   * evidence is outside the SQL predicate and therefore cannot be deleted.
   */
  compactAutonomousPaperCandidateDetails(
    laneId: string,
    options: AutonomousPaperCandidateCompactionOptions = {}
  ): AutonomousPaperCandidateCompactionResult {
    const id = laneId.trim();
    if (!id || !this.getAutonomousPaperLane(id)) {
      throw new Error("Autonomous candidate compaction requires an existing lane.");
    }
    const retainNewest = options.retainNewest ?? AUTONOMOUS_PAPER_CANDIDATE_DETAIL_RETENTION;
    const batchSize = options.batchSize ?? AUTONOMOUS_PAPER_CANDIDATE_COMPACTION_BATCH_SIZE;
    if (!Number.isSafeInteger(retainNewest) || retainNewest < 0) {
      throw new RangeError("Autonomous candidate detail retention must be a non-negative safe integer.");
    }
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 ||
        batchSize > AUTONOMOUS_PAPER_CANDIDATE_COMPACTION_BATCH_SIZE) {
      throw new RangeError(
        `Autonomous candidate compaction batch must be between 1 and ${AUTONOMOUS_PAPER_CANDIDATE_COMPACTION_BATCH_SIZE}.`
      );
    }

    const countDetails = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM autonomous_paper_events
      WHERE lane_id = ?
        AND kind = 'DECISION'
        AND action IN ('REJECT', 'OBSERVE')
        AND outcome IN ('REJECTED', 'ANALYSIS_ONLY')
    `);
    const findCutoff = this.db.prepare(`
      SELECT observed_at, event_key
      FROM autonomous_paper_events
      WHERE lane_id = ?
        AND kind = 'DECISION'
        AND action IN ('REJECT', 'OBSERVE')
        AND outcome IN ('REJECTED', 'ANALYSIS_ONLY')
      ORDER BY observed_at DESC, event_key DESC
      LIMIT 1 OFFSET ?
    `);
    const selectAllOldest = this.db.prepare(`
      SELECT event_key, lane_id, action, outcome, observed_at, event_json
      FROM autonomous_paper_events
      WHERE lane_id = ?
        AND kind = 'DECISION'
        AND action IN ('REJECT', 'OBSERVE')
        AND outcome IN ('REJECTED', 'ANALYSIS_ONLY')
      ORDER BY observed_at ASC, event_key ASC
      LIMIT ?
    `);
    const selectBeforeCutoff = this.db.prepare(`
      SELECT event_key, lane_id, action, outcome, observed_at, event_json
      FROM autonomous_paper_events
      WHERE lane_id = ?
        AND kind = 'DECISION'
        AND action IN ('REJECT', 'OBSERVE')
        AND outcome IN ('REJECTED', 'ANALYSIS_ONLY')
        AND (observed_at < ? OR (observed_at = ? AND event_key < ?))
      ORDER BY observed_at ASC, event_key ASC
      LIMIT ?
    `);
    const getRollup = this.db.prepare(`
      SELECT lane_id, utc_day, action, outcome, decision_count,
        first_observed_at, last_observed_at, reason_counts_json
      FROM autonomous_paper_candidate_rollups
      WHERE lane_id = ? AND utc_day = ? AND action = ? AND outcome = ?
    `);
    const saveRollup = this.db.prepare(`
      INSERT INTO autonomous_paper_candidate_rollups(
        lane_id, utc_day, action, outcome, decision_count,
        first_observed_at, last_observed_at, reason_counts_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(lane_id, utc_day, action, outcome) DO UPDATE SET
        decision_count = excluded.decision_count,
        first_observed_at = excluded.first_observed_at,
        last_observed_at = excluded.last_observed_at,
        reason_counts_json = excluded.reason_counts_json
    `);
    const deleteDetail = this.db.prepare(`
      DELETE FROM autonomous_paper_events
      WHERE event_key = ? AND lane_id = ?
        AND kind = 'DECISION'
        AND action IN ('REJECT', 'OBSERVE')
        AND outcome IN ('REJECTED', 'ANALYSIS_ONLY')
    `);

    return this.db.transaction((): AutonomousPaperCandidateCompactionResult => {
      const before = (countDetails.get(id) as { count: number }).count;
      let rows: AutonomousPaperCandidateDetailRow[];
      if (retainNewest === 0) {
        rows = selectAllOldest.all(id, batchSize) as AutonomousPaperCandidateDetailRow[];
      } else {
        const cutoff = findCutoff.get(id, retainNewest - 1) as {
          observed_at: string;
          event_key: string;
        } | undefined;
        rows = cutoff
          ? selectBeforeCutoff.all(
              id,
              cutoff.observed_at,
              cutoff.observed_at,
              cutoff.event_key,
              batchSize
            ) as AutonomousPaperCandidateDetailRow[]
          : [];
      }
      if (rows.length === 0) {
        return {
          laneId: id,
          compacted: 0,
          rollupRows: 0,
          retainedCandidateDetails: before,
          retainNewest,
          batchSize
        };
      }

      const groups = new Map<string, {
        utcDay: string;
        action: AutonomousPaperCandidateAction;
        outcome: AutonomousPaperCandidateOutcome;
        decisionCount: number;
        firstObservedAt: string;
        lastObservedAt: string;
        reasonCounts: Map<string, number>;
      }>();
      for (const row of rows) {
        const event = decode<AutonomousPaperEvent>(row.event_json);
        if (
          event.eventKey !== row.event_key || event.laneId !== row.lane_id ||
          event.kind !== "DECISION" || event.action !== row.action ||
          event.outcome !== row.outcome || event.observedAt !== row.observed_at ||
          !event.decision || event.decision.action !== row.action ||
          event.decision.outcome !== row.outcome || event.decision.laneId !== id
        ) {
          throw new Error("Autonomous candidate detail changed identity before compaction.");
        }
        const observedMs = Date.parse(event.observedAt);
        if (!Number.isFinite(observedMs)) {
          throw new Error("Autonomous candidate detail has an invalid observation time.");
        }
        const observedAt = new Date(observedMs).toISOString();
        const utcDay = observedAt.slice(0, 10);
        const key = `${utcDay}\u0000${row.action}\u0000${row.outcome}`;
        let group = groups.get(key);
        if (!group) {
          group = {
            utcDay,
            action: row.action,
            outcome: row.outcome,
            decisionCount: 0,
            firstObservedAt: observedAt,
            lastObservedAt: observedAt,
            reasonCounts: new Map()
          };
          groups.set(key, group);
        }
        group.decisionCount += 1;
        if (observedAt < group.firstObservedAt) group.firstObservedAt = observedAt;
        if (observedAt > group.lastObservedAt) group.lastObservedAt = observedAt;
        for (const reason of new Set(event.decision.reasons.map(autonomousDecisionReason))) {
          group.reasonCounts.set(reason, (group.reasonCounts.get(reason) ?? 0) + 1);
        }
      }

      for (const group of groups.values()) {
        const existing = getRollup.get(
          id,
          group.utcDay,
          group.action,
          group.outcome
        ) as AutonomousPaperCandidateRollupRow | undefined;
        const reasonCounts = new Map<string, number>();
        if (existing) {
          if (!Number.isSafeInteger(existing.decision_count) || existing.decision_count < 0) {
            throw new Error("Autonomous candidate rollup decision count is invalid.");
          }
          for (const [reason, count] of Object.entries(
            autonomousCandidateReasonCounts(existing.reason_counts_json)
          )) reasonCounts.set(reason, count);
        }
        for (const [reason, count] of group.reasonCounts) {
          reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + count);
        }
        saveRollup.run(
          id,
          group.utcDay,
          group.action,
          group.outcome,
          (existing?.decision_count ?? 0) + group.decisionCount,
          existing && existing.first_observed_at < group.firstObservedAt
            ? existing.first_observed_at
            : group.firstObservedAt,
          existing && existing.last_observed_at > group.lastObservedAt
            ? existing.last_observed_at
            : group.lastObservedAt,
          encodeAutonomousCandidateReasonCounts(reasonCounts)
        );
      }

      for (const row of rows) {
        if (deleteDetail.run(row.event_key, id).changes !== 1) {
          throw new Error("Autonomous candidate detail changed before its atomic deletion.");
        }
      }
      const retainedCandidateDetails = (countDetails.get(id) as { count: number }).count;
      const result: AutonomousPaperCandidateCompactionResult = {
        laneId: id,
        compacted: rows.length,
        rollupRows: groups.size,
        retainedCandidateDetails,
        retainNewest,
        batchSize
      };
      this.audit(
        "autonomous_paper_candidate_details_compacted",
        "Older autonomous PAPER candidate details were atomically rolled up into bounded audit summaries.",
        result
      );
      return result;
    })();
  }

  listAutonomousPaperCandidateRollups(laneId: string): AutonomousPaperCandidateRollup[] {
    const id = laneId.trim();
    if (!id || !this.getAutonomousPaperLane(id)) {
      throw new Error("Autonomous candidate rollups require an existing lane.");
    }
    const rows = this.db.prepare(`
      SELECT lane_id, utc_day, action, outcome, decision_count,
        first_observed_at, last_observed_at, reason_counts_json
      FROM autonomous_paper_candidate_rollups
      WHERE lane_id = ?
      ORDER BY utc_day DESC, action ASC, outcome ASC
    `).all(id) as AutonomousPaperCandidateRollupRow[];
    return rows.map((row) => ({
      laneId: row.lane_id,
      utcDay: row.utc_day,
      action: row.action,
      outcome: row.outcome,
      decisionCount: row.decision_count,
      firstObservedAt: row.first_observed_at,
      lastObservedAt: row.last_observed_at,
      reasonCounts: autonomousCandidateReasonCounts(row.reason_counts_json)
    }));
  }

  countAutonomousPaperSimulatedBuyEntriesForUtcDay(
    laneId: string,
    at: string
  ): number {
    const id = laneId.trim();
    if (!id || !this.getAutonomousPaperLane(id)) {
      throw new Error("Autonomous paper entry cadence requires an existing lane.");
    }
    const atMs = Date.parse(at);
    if (!Number.isFinite(atMs)) {
      throw new Error("Autonomous paper entry cadence time is invalid.");
    }
    const instant = new Date(atMs);
    const dayStart = new Date(Date.UTC(
      instant.getUTCFullYear(),
      instant.getUTCMonth(),
      instant.getUTCDate()
    )).toISOString();
    const through = instant.toISOString();
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM autonomous_paper_events
      WHERE lane_id = ?
        AND kind = 'DECISION'
        AND action = 'BUY'
        AND outcome = 'SIMULATED'
        AND observed_at >= ?
        AND observed_at <= ?
    `).get(id, dayStart, through) as { count: number };
    return row.count;
  }

  countAutonomousPaperControlledExplorationEntriesForUtcDay(
    laneId: string,
    at: string
  ): number {
    const id = laneId.trim();
    if (!id || !this.getAutonomousPaperLane(id)) {
      throw new Error("Autonomous paper exploration cadence requires an existing lane.");
    }
    const atMs = Date.parse(at);
    if (!Number.isFinite(atMs)) {
      throw new Error("Autonomous paper exploration cadence time is invalid.");
    }
    const instant = new Date(atMs);
    const dayStart = new Date(Date.UTC(
      instant.getUTCFullYear(),
      instant.getUTCMonth(),
      instant.getUTCDate()
    )).toISOString();
    const through = instant.toISOString();
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM autonomous_paper_events AS event
      WHERE event.lane_id = ?
        AND event.kind = 'DECISION'
        AND event.action = 'BUY'
        AND event.outcome = 'SIMULATED'
        AND event.observed_at >= ?
        AND event.observed_at <= ?
        AND EXISTS (
          SELECT 1
          FROM json_each(json_extract(event.event_json, '$.decision.reasons')) AS reason
          WHERE reason.value = 'CONTROLLED_EXPLORATION'
        )
    `).get(id, dayStart, through) as { count: number };
    return row.count;
  }

  latestAutonomousPaperSimulatedBuyEntryAtOrBefore(
    laneId: string,
    at: string
  ): string | undefined {
    const id = laneId.trim();
    if (!id || !this.getAutonomousPaperLane(id)) {
      throw new Error("Autonomous paper entry cadence requires an existing lane.");
    }
    const atMs = Date.parse(at);
    if (!Number.isFinite(atMs)) {
      throw new Error("Autonomous paper entry cadence time is invalid.");
    }
    const row = this.db.prepare(`
      SELECT observed_at
      FROM autonomous_paper_events
      WHERE lane_id = ?
        AND kind = 'DECISION'
        AND action = 'BUY'
        AND outcome = 'SIMULATED'
        AND observed_at <= ?
      ORDER BY observed_at DESC
      LIMIT 1
    `).get(id, new Date(atMs).toISOString()) as { observed_at: string } | undefined;
    return row?.observed_at;
  }

  latestAutonomousPaperDecision(
    laneId: string,
    mint: string
  ): AutonomousPaperDecision | undefined {
    return this.listAutonomousPaperEvents({ laneId, mint, kind: "DECISION", limit: 100 })
      .find((event) => event.outcome !== "CLAIMED" && event.decision !== undefined)
      ?.decision;
  }

  /** Exact latest material trade for one mint. This deliberately does not use
   * the generic event-history reader: cooldown checks run once per ranked
   * candidate and must stay on the dedicated partial trade index. The JSON
   * predicate preserves the former map/find behavior by skipping unfinished
   * or failed TRADE events that contain no trade payload. */
  latestAutonomousPaperTrade(
    laneId: string,
    mint: string
  ): AutonomousPaperTrade | undefined {
    const row = this.db.prepare(`
      SELECT event_json
      FROM autonomous_paper_events
      WHERE lane_id = ?
        AND mint = ?
        AND kind = 'TRADE'
        AND json_type(event_json, '$.trade') = 'object'
      ORDER BY observed_at DESC, event_key DESC
      LIMIT 1
    `).get(laneId, mint) as AutonomousPaperEventRow | undefined;
    return row ? decode<AutonomousPaperEvent>(row.event_json).trade : undefined;
  }

  finalizeAutonomousPaperEvent(event: AutonomousPaperEvent): boolean {
    if (event.outcome === "CLAIMED") {
      throw new Error("A finalized autonomous paper event must be terminal.");
    }
    const existing = this.getAutonomousPaperEvent(event.eventKey);
    if (!existing || existing.outcome !== "CLAIMED") return false;
    if (
      existing.laneId !== event.laneId ||
      existing.kind !== event.kind ||
      existing.observedAt !== event.observedAt ||
      existing.mint !== event.mint ||
      existing.action !== event.action
    ) {
      throw new Error("A finalized autonomous paper event changed immutable decision identity.");
    }
    if (event.navUsd !== undefined) {
      finiteResearchNumber(event.navUsd, "Autonomous event NAV");
    }
    if (event.decision && (
      event.decision.laneId !== event.laneId ||
      event.decision.mint !== event.mint ||
      event.decision.action !== event.action ||
      event.decision.outcome !== event.outcome
    )) {
      throw new Error("Autonomous event decision identity does not match its claim.");
    }
    if (event.trade && (
      event.trade.laneId !== event.laneId ||
      event.trade.mint !== event.mint
    )) {
      throw new Error("Autonomous event trade identity does not match its claim.");
    }
    const normalized: AutonomousPaperEvent = {
      ...event,
      ...(event.reason ? { reason: redactSensitiveText(event.reason, 1_000) } : {}),
      ...(event.decision
        ? {
            decision: {
              ...event.decision,
              reasons: event.decision.reasons.map(autonomousDecisionReason)
            }
          }
        : {}),
      finalizedAt: event.finalizedAt ?? nowIso()
    };
    if (!Number.isFinite(Date.parse(normalized.finalizedAt!))) {
      throw new Error("Autonomous paper event finalization time is invalid.");
    }
    if (Date.parse(normalized.finalizedAt!) < Date.parse(normalized.observedAt)) {
      throw new Error("Autonomous paper event cannot finalize before it was observed.");
    }
    return this.db.prepare(`
      UPDATE autonomous_paper_events
      SET outcome = ?, finalized_at = ?, event_json = ?
      WHERE event_key = ? AND outcome = 'CLAIMED'
    `).run(
      normalized.outcome,
      normalized.finalizedAt!,
      encode(normalized),
      normalized.eventKey
    ).changes === 1;
  }

  /** Persists high-volume, non-material candidate outcomes in one SQLite
   * transaction while deliberately reusing the ordinary claim/finalize path.
   * This preserves unique-key, immutable-identity, normalization, and legacy
   * interrupted-claim semantics exactly. BUY/SELL/NAV/trade events are rejected
   * here and must continue through their material commit paths. */
  commitAutonomousPaperCandidateEvents(events: readonly AutonomousPaperEvent[]): number {
    if (events.length === 0) return 0;
    if (events.length > AUTONOMOUS_PAPER_CANDIDATE_EVENT_BATCH_MAXIMUM) {
      throw new RangeError(
        `Autonomous candidate batches cannot exceed ${AUTONOMOUS_PAPER_CANDIDATE_EVENT_BATCH_MAXIMUM} events.`
      );
    }
    return this.db.transaction(() => {
      let committed = 0;
      for (const event of events) {
        const auxiliary = event.kind === "DECISION" &&
          (event.action === "REJECT" || event.action === "OBSERVE") &&
          (event.outcome === "REJECTED" || event.outcome === "ANALYSIS_ONLY") &&
          event.decision !== undefined &&
          event.trade === undefined &&
          event.navUsd === undefined;
        const matchedOutcome =
          (event.action === "REJECT" && event.outcome === "REJECTED") ||
          (event.action === "OBSERVE" && event.outcome === "ANALYSIS_ONLY");
        if (!auxiliary || !matchedOutcome) {
          throw new Error(
            "Autonomous candidate batches accept only terminal REJECT/OBSERVE decision evidence."
          );
        }
        const claim: AutonomousPaperEvent = {
          eventKey: event.eventKey,
          laneId: event.laneId,
          kind: event.kind,
          ...(event.mint ? { mint: event.mint } : {}),
          ...(event.action ? { action: event.action } : {}),
          outcome: "CLAIMED",
          observedAt: event.observedAt
        };
        // INSERT OR IGNORE is the same idempotency boundary used by the
        // one-at-a-time path. A terminal duplicate or legacy unfinished claim
        // is never rewritten by a retry.
        if (!this.claimAutonomousPaperEvent(claim)) continue;
        if (!this.finalizeAutonomousPaperEvent(event)) {
          throw new Error("A claimed autonomous candidate event did not finalize atomically.");
        }
        committed += 1;
      }
      return committed;
    })();
  }

  commitAutonomousPaperEvent(input: {
    event: AutonomousPaperEvent;
    account?: AutonomousPaperAccount;
    positions?: readonly AutonomousPaperPosition[];
    replay?: {
      episode?: AutonomousPaperReplayEpisode;
      observation: AutonomousPaperReplayObservation;
    };
  }): boolean {
    if (input.account && input.account.laneId !== input.event.laneId) {
      throw new Error("Autonomous paper event and account identities must match.");
    }
    for (const position of input.positions ?? []) {
      if (position.laneId !== input.event.laneId) {
        throw new Error("Autonomous paper event and position identities must match.");
      }
    }
    if (input.account) {
      const reconciled = new Map(
        this.listAutonomousPaperPositions({ laneId: input.event.laneId, limit: 500 })
          .map((position) => [position.id, position] as const)
      );
      for (const position of input.positions ?? []) reconciled.set(position.id, position);
      const open = [...reconciled.values()].filter((position) => position.status !== "CLOSED");
      const deployedUsd = open.reduce((sum, position) => sum + position.remainingCostUsd, 0);
      const executableValueUsd = open.reduce(
        (sum, position) => sum + position.lastExecutableValueUsd,
        0
      );
      const tolerance = 0.02;
      if (
        input.account.openPositions !== open.length ||
        Math.abs(input.account.deployedUsd - deployedUsd) > tolerance ||
        Math.abs(input.account.navUsd - input.account.cashUsd - executableValueUsd) > tolerance ||
        Math.abs(input.account.unrealizedPnlUsd - (executableValueUsd - deployedUsd)) > tolerance ||
        input.account.pricingComplete !== open.every((position) => position.status === "OPEN")
      ) throw new Error("Autonomous account does not reconcile to its isolated position ledger.");
    }
    return this.db.transaction(() => {
      if (!this.finalizeAutonomousPaperEvent(input.event)) return false;
      if (input.account) this.upsertAutonomousPaperAccount(input.account);
      for (const position of input.positions ?? []) this.upsertAutonomousPaperPosition(position);
      if (input.replay) {
        try {
          // Replay capture shares the successful commit boundary when valid,
          // but its own savepoint is deliberately non-authoritative. A Replay
          // Lab bug can lose research evidence; it can never cancel or rewrite
          // the actual PAPER event, account, or position transition.
          this.db.transaction(() => {
            const { episode, observation } = input.replay!;
            if (
              observation.laneId !== input.event.laneId ||
              (episode !== undefined && (
                episode.laneId !== input.event.laneId ||
                episode.id !== observation.episodeId ||
                episode.positionId !== observation.positionId ||
                episode.mint !== observation.mint
              ))
            ) throw new Error("Autonomous paper event and replay identities must match.");
            if (episode) this.createAutonomousPaperReplayEpisode(episode);
            this.appendAutonomousPaperReplayObservation(observation);
          })();
        } catch (error) {
          this.audit(
            "autonomous_paper_replay_capture_failed",
            "Replay evidence was rejected without changing the committed autonomous PAPER ledger.",
            {
              laneId: input.event.laneId,
              eventKey: input.event.eventKey,
              reason: redactSensitiveText(
                error instanceof Error ? error.message : "Replay capture failed safely.",
                1_000
              )
            },
            "warning"
          );
        }
      }
      return true;
    })();
  }

  autonomousPaperDashboard(laneId?: string, limit = 50): AutonomousPaperDashboard {
    const lane = laneId
      ? this.getAutonomousPaperLane(laneId)
      : this.activeAutonomousPaperLane() ?? this.latestAutonomousPaperLane();
    const capturedAt = nowIso();
    if (!lane) return {
      label: AUTONOMOUS_PAPER_LABEL,
      promotionEligible: false,
      executionEnabled: false,
      positions: [],
      recentDecisions: [],
      recentTrades: [],
      replayLab: this.autonomousPaperReplayDashboard(),
      updatedAt: capturedAt
    };
    const bounded = Math.max(0, Math.min(100, Math.trunc(limit)));
    // Reserve a small slice for durable BUY/SELL/FAILED evidence without
    // letting a long material history crowd current candidate diagnostics out
    // of the bounded dashboard response.
    const materialReserve = bounded === 0 ? 0 : Math.max(1, Math.floor(bounded / 4));
    const materialDecisionRows = this.db.prepare(`
      SELECT event_json FROM autonomous_paper_events
      WHERE lane_id = ?
        AND kind IN ('DECISION', 'TRADE')
        AND outcome IN ('SIMULATED', 'REJECTED', 'ANALYSIS_ONLY', 'FAILED')
        AND (action IN ('BUY', 'SELL') OR outcome = 'FAILED')
        AND json_type(event_json, '$.decision') = 'object'
      ORDER BY observed_at DESC, event_key DESC
      LIMIT ?
    `).all(lane.id, bounded) as AutonomousPaperEventRow[];
    const materialDecisions: AutonomousPaperDecision[] = [];
    const materialIds = new Set<string>();
    for (const row of materialDecisionRows) {
      const value = decode<AutonomousPaperEvent>(row.event_json).decision;
      if (!value || materialIds.has(value.id)) continue;
      materialIds.add(value.id);
      materialDecisions.push(value);
      if (materialDecisions.length >= materialReserve) break;
    }
    const candidateLimit = Math.max(0, bounded - materialDecisions.length);
    const candidateDecisionRows = this.db.prepare(`
      SELECT event_json FROM autonomous_paper_events
      WHERE lane_id = ?
        AND kind = 'DECISION'
        AND action IN ('REJECT', 'OBSERVE')
        AND outcome IN ('REJECTED', 'ANALYSIS_ONLY')
        AND json_type(event_json, '$.decision') = 'object'
      ORDER BY observed_at DESC, event_key DESC
      LIMIT ?
    `).all(lane.id, bounded) as AutonomousPaperEventRow[];
    const candidateDecisions: AutonomousPaperDecision[] = [];
    const returnedIds = new Set(materialIds);
    for (const row of candidateDecisionRows) {
      const value = decode<AutonomousPaperEvent>(row.event_json).decision;
      if (!value || returnedIds.has(value.id)) continue;
      returnedIds.add(value.id);
      candidateDecisions.push(value);
      if (candidateDecisions.length >= candidateLimit) break;
    }
    const recentDecisions = [...materialDecisions, ...candidateDecisions]
      .sort((left, right) =>
        Date.parse(right.decidedAt) - Date.parse(left.decidedAt) ||
        right.id.localeCompare(left.id)
      )
      .slice(0, bounded);
    const recentTradeRows = this.db.prepare(`
      SELECT event_json FROM autonomous_paper_events
      WHERE lane_id = ?
        AND kind = 'TRADE'
        AND action = 'SELL'
        AND outcome = 'SIMULATED'
        AND json_type(event_json, '$.trade') = 'object'
      ORDER BY observed_at DESC, event_key DESC
      LIMIT ?
    `).all(lane.id, bounded) as AutonomousPaperEventRow[];
    const recentTrades = recentTradeRows
      .map((row) => decode<AutonomousPaperEvent>(row.event_json).trade)
      .filter((value): value is AutonomousPaperTrade => value !== undefined);
    const latestCompletedScan = this.db.prepare(`
      SELECT finalized_at FROM autonomous_paper_events
      WHERE lane_id = ?
        AND kind = 'NAV_MARK'
        AND event_key LIKE 'autonomous-cycle-v1:%'
        AND outcome = 'SIMULATED'
        AND finalized_at IS NOT NULL
      ORDER BY finalized_at DESC, event_key DESC
      LIMIT 1
    `).get(lane.id) as { finalized_at: string } | undefined;
    const account = this.getAutonomousPaperAccount(lane.id);
    const upgradeDrain = this.getAutonomousPaperUpgradeDrain(lane.id);
    return {
      label: AUTONOMOUS_PAPER_LABEL,
      promotionEligible: false,
      executionEnabled: false,
      lane,
      ...(account ? { account } : {}),
      positions: this.listAutonomousPaperPositions({
        laneId: lane.id,
        openOnly: true,
        limit: bounded
      }),
      recentDecisions,
      recentTrades,
      replayLab: this.autonomousPaperReplayDashboard(lane.id, Math.min(10, bounded)),
      ...(upgradeDrain ? { upgradeDrain } : {}),
      ...(latestCompletedScan ? { lastScanAt: latestCompletedScan.finalized_at } : {}),
      updatedAt: capturedAt
    };
  }

  saveLeaderLot(
    sourceEntrySignature: string,
    wallet: string,
    mint: string,
    amountAtomic: string
  ): void {
    if (BigInt(amountAtomic) <= 0n) throw new Error("Leader lot amount must be positive.");
    this.db
      .prepare(`
        INSERT OR IGNORE INTO leader_lots(
          source_entry_signature, wallet, mint, initial_atomic, remaining_atomic, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(sourceEntrySignature, wallet, mint, amountAtomic, amountAtomic, nowIso());
  }

  getLeaderLot(sourceEntrySignature: string):
    | { sourceEntrySignature: string; wallet: string; mint: string; initialAtomic: string; remainingAtomic: string }
    | undefined {
    const row = this.db
      .prepare(`
        SELECT source_entry_signature, wallet, mint, initial_atomic, remaining_atomic
        FROM leader_lots WHERE source_entry_signature = ?
      `)
      .get(sourceEntrySignature) as
      | {
          source_entry_signature: string;
          wallet: string;
          mint: string;
          initial_atomic: string;
          remaining_atomic: string;
        }
      | undefined;
    return row
      ? {
          sourceEntrySignature: row.source_entry_signature,
          wallet: row.wallet,
          mint: row.mint,
          initialAtomic: row.initial_atomic,
          remainingAtomic: row.remaining_atomic
        }
      : undefined;
  }

  applyLeaderSell(sourceEntrySignature: string, soldAtomic: string): number {
    return this.recordLeaderSell(sourceEntrySignature, soldAtomic).incrementalFraction;
  }

  recordLeaderSell(sourceEntrySignature: string, soldAtomic: string): {
    incrementalFraction: number;
    cumulativeSoldFraction: number;
    remainingAtomic: string;
  } {
    const lot = this.getLeaderLot(sourceEntrySignature);
    if (!lot) return { incrementalFraction: 1, cumulativeSoldFraction: 1, remainingAtomic: "0" };
    const remaining = BigInt(lot.remainingAtomic);
    const initial = BigInt(lot.initialAtomic);
    const sold = BigInt(soldAtomic);
    if (remaining <= 0n || initial <= 0n) {
      return { incrementalFraction: 1, cumulativeSoldFraction: 1, remainingAtomic: "0" };
    }
    if (sold <= 0n) {
      const scale = 1_000_000_000n;
      return {
        incrementalFraction: 0,
        cumulativeSoldFraction: Number(((initial - remaining) * scale) / initial) / Number(scale),
        remainingAtomic: remaining.toString()
      };
    }
    const applied = sold > remaining ? remaining : sold;
    const nextRemaining = remaining - applied;
    const scale = 1_000_000_000n;
    const incrementalFraction = Number((applied * scale) / remaining) / Number(scale);
    const cumulativeSoldFraction = Number(((initial - nextRemaining) * scale) / initial) / Number(scale);
    this.db
      .prepare("UPDATE leader_lots SET remaining_atomic = ?, updated_at = ? WHERE source_entry_signature = ?")
      .run(nextRemaining.toString(), nowIso(), sourceEntrySignature);
    return {
      incrementalFraction: Math.min(1, incrementalFraction),
      cumulativeSoldFraction: Math.min(1, cumulativeSoldFraction),
      remainingAtomic: nextRemaining.toString()
    };
  }

  saveClosedTrade(id: string, mode: "PAPER" | "LIVE", trade: ClosedTradeResult): void {
    this.db
      .prepare(`
        INSERT OR REPLACE INTO closed_trades(
          id, mode, evaluation_cohort_id, trade_json, closed_at
        ) VALUES (?, ?, ?, ?, ?)
      `)
      .run(id, mode, trade.evaluationCohortId ?? null, encode(trade), trade.closedAt);
  }

  listClosedTrades(mode: "PAPER" | "LIVE", evaluationCohortId?: string): ClosedTradeResult[] {
    const rows = (evaluationCohortId === undefined
      ? this.db.prepare("SELECT trade_json FROM closed_trades WHERE mode = ? ORDER BY closed_at").all(mode)
      : this.db.prepare(`
          SELECT trade_json FROM closed_trades
          WHERE mode = ? AND evaluation_cohort_id = ? ORDER BY closed_at
        `).all(mode, evaluationCohortId)) as Array<{ trade_json: string }>;
    return rows.map((row) => decode<ClosedTradeResult>(row.trade_json));
  }
}
