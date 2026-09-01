import {
  AUTONOMOUS_PAPER_LEARNING_CONTEXT_VERSION,
  AUTONOMOUS_PAPER_LEARNING_CONTEXT_V2_VERSION,
  AUTONOMOUS_PAPER_SIZING_VERSION,
  AUTONOMOUS_PAPER_SIZING_V1_VERSION,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  type AutonomousPaperAccount,
  type AutonomousPaperContextualReward,
  type AutonomousPaperExitReason,
  type AutonomousPaperLearningContext,
  type AutonomousPaperLearningContextV1,
  type AutonomousPaperLearningContextV2,
  type AutonomousPaperMarketSnapshot,
  type AutonomousPaperPolicy,
  type AutonomousPaperPosition,
  type AutonomousPaperSizingBindingConstraint,
  type AutonomousPaperSizingBreakdown,
  type AutonomousPaperSizingExplanationCode,
  type AutonomousPaperStrategyArm,
  type AutonomousPaperTrade
} from "@copylab/shared";

export const LEGACY_AUTONOMOUS_PAPER_POLICY_VERSION = "autonomous-momentum-paper-v1";
export const AUTONOMOUS_PAPER_V2_POLICY_VERSION = "autonomous-momentum-paper-v2";
export const AUTONOMOUS_PAPER_V3_POLICY_VERSION = "autonomous-momentum-paper-v3";
export const AUTONOMOUS_PAPER_V4_POLICY_VERSION = "autonomous-momentum-paper-v4";
export const AUTONOMOUS_PAPER_V5_POLICY_VERSION = "autonomous-momentum-paper-v5";
export const AUTONOMOUS_PAPER_V6_POLICY_VERSION = "autonomous-momentum-paper-v6";
export const AUTONOMOUS_PAPER_V7_POLICY_VERSION = "autonomous-momentum-paper-v7";
export const AUTONOMOUS_PAPER_V8_POLICY_VERSION = "autonomous-momentum-paper-v8";
export const AUTONOMOUS_PAPER_V9_POLICY_VERSION = "autonomous-momentum-paper-v9";
export const AUTONOMOUS_PAPER_V10_POLICY_VERSION = "autonomous-learning-paper-v10";
export const AUTONOMOUS_PAPER_V11_POLICY_VERSION = "autonomous-evidence-paper-v11";
export const AUTONOMOUS_PAPER_V12_POLICY_VERSION = "autonomous-validated-learning-paper-v12";
export const AUTONOMOUS_PAPER_POLICY_VERSION = "autonomous-regime-adaptive-paper-v13";

export const AUTONOMOUS_PAPER_HARD_MINIMUM_POSITION_USD = 5;
export const AUTONOMOUS_PAPER_HARD_MAXIMUM_POSITION_USD = Number.MAX_SAFE_INTEGER;

const DISABLED_ADAPTIVE_SIZING_POLICY = Object.freeze({
  adaptiveSizingEnabled: false,
  minimumPositionUsd: AUTONOMOUS_PAPER_HARD_MINIMUM_POSITION_USD,
  adaptiveSizingMinimumTrades: 20,
  adaptiveSizingWindowTrades: 100,
  adaptiveSizingPriorWins: 5,
  adaptiveSizingPriorLosses: 5,
  adaptiveSizingFractionalKelly: 0.5,
  adaptiveSizingMinimumCalibrationMultiplier: 0.25,
  adaptiveSizingMaximumCalibrationMultiplier: 1.25,
  adaptiveSizingMaximumLossStreak: 3,
  adaptiveSizingLossStreakMultiplier: 0.8,
  contextualRewardEnabled: false,
  contextualRewardMinimumComparableTrades: 8,
  contextualRewardMaximumDistance: 0.4,
  contextualRewardPriorWeight: 4,
  contextualRewardGain: 0.5,
  contextualRewardMinimumEffectiveSamples: 4,
  contextualRewardMinimumDistinctMints: 4,
  contextualRewardMinimumDistinctUtcDays: 3,
  contextualRewardMaximumSamplesPerMint: 2,
  contextualRewardMinimumMultiplier: 0.75,
  contextualRewardMaximumMultiplier: 1.2,
  riskAtStopSizingEnabled: false,
  normalRiskAtStopNavFraction: 0.03,
  highConvictionRiskAtStopNavFraction: 0.04,
  explorationRiskAtStopNavFraction: 0.02,
  maximumDeveloperClusterFraction: 1
});

/** Exact compatibility defaults for persisted v1 lanes. The original v1
 * stored only the first-generation numeric fields because its momentum gates
 * and two-sample confirmation were code constants. Decoding an archived v1
 * lane expands those constants without mutating its frozen database row. */
export const LEGACY_AUTONOMOUS_PAPER_POLICY: Readonly<AutonomousPaperPolicy> = Object.freeze({
  ...DISABLED_ADAPTIVE_SIZING_POLICY,
  scanIntervalMinutes: 5,
  confirmationSamples: 2,
  allowToken2022: false,
  maximumEntriesPerUtcDay: Number.MAX_SAFE_INTEGER,
  minimumEntrySpacingMinutes: 0,
  positionNavFraction: 0.2,
  maximumPositionUsd: 50,
  maximumOpenPositions: 2,
  maximumDeployedFraction: 0.4,
  minimumLiquidReserveUsd: 20,
  minimumAgeDays: 7,
  minimumLiquidityUsd: 750_000,
  minimumVolume24hUsd: 1_000_000,
  minimumHolderCount: 750,
  minimumOrganicScore: 70,
  maximumTopHoldersPercent: 35,
  minimumMarketCapUsd: 3_000_000,
  maximumMarketCapUsd: 300_000_000,
  maximumFdvToMarketCap: 2.5,
  minimumMomentumScore: 60,
  minimumPriceChange5mPercent: 0.5,
  maximumPriceChange5mPercent: 5,
  minimumPriceChange1hPercent: 2,
  maximumPriceChange1hPercent: 18,
  minimumPriceChange6hPercent: 0,
  maximumPriceChange6hPercent: 40,
  maximumPriceChange24hPercent: 80,
  minimumOrganicBuyShare5m: 0.6,
  minimumOrganicBuyShare1h: 0.55,
  minimumOrganicVolume5mUsd: 10_000,
  minimumOrganicVolume1hUsd: 50_000,
  minimumOrganicBuyers5m: 20,
  minimumVolumeAccelerationRatio: 0.1,
  minimumLiquidityChange1hPercent: -2,
  minimumSolPriceChange1hPercent: -2,
  minimumSolPriceChange6hPercent: -5,
  minimumSolRelativeStrength1hPercent: 2,
  maximumPriceImpactPercent: 1,
  maximumRoundTripCostPercent: 3,
  stopLossPercent: 10,
  breakEvenActivationPercent: 8,
  trailingActivationPercent: 15,
  trailingDrawdownPercent: 6,
  takeProfitPercent: 30,
  weakMomentumExitSamples: 2,
  noProgressMinutes: 90,
  maximumHoldingMinutes: 12 * 60,
  cooldownMinutes: 6 * 60,
  stopCooldownMinutes: 24 * 60,
  dailyLossPausePercent: 8,
  maximumDrawdownPercent: 20
});

/** Exact compatibility defaults for persisted v2 lanes. Never derive an
 * archived v2 lane from the current defaults: doing so would silently change
 * the meaning of its historical decisions when a later epoch is introduced. */
export const AUTONOMOUS_PAPER_V2_POLICY: Readonly<AutonomousPaperPolicy> = Object.freeze({
  ...DISABLED_ADAPTIVE_SIZING_POLICY,
  scanIntervalMinutes: 5,
  confirmationSamples: 1,
  allowToken2022: false,
  maximumEntriesPerUtcDay: Number.MAX_SAFE_INTEGER,
  minimumEntrySpacingMinutes: 0,
  positionNavFraction: 0.25,
  maximumPositionUsd: 50,
  maximumOpenPositions: 3,
  maximumDeployedFraction: 0.6,
  minimumLiquidReserveUsd: 20,
  minimumAgeDays: 3,
  minimumLiquidityUsd: 250_000,
  minimumVolume24hUsd: 250_000,
  minimumHolderCount: 300,
  minimumOrganicScore: 50,
  maximumTopHoldersPercent: 50,
  minimumMarketCapUsd: 500_000,
  maximumMarketCapUsd: 500_000_000,
  maximumFdvToMarketCap: 4,
  // A live category replay showed that the strongest fully evidenced standard
  // SPL candidate scored in the low 40s because the 24h top-traded universe is
  // less vertically extended than the old short-horizon pump feed. Keep all
  // hard momentum and safety gates, but let those established candidates reach
  // quote validation in this deliberately aggressive PAPER epoch.
  minimumMomentumScore: 35,
  minimumPriceChange5mPercent: 0.25,
  maximumPriceChange5mPercent: 12,
  minimumPriceChange1hPercent: 1,
  maximumPriceChange1hPercent: 30,
  minimumPriceChange6hPercent: -5,
  maximumPriceChange6hPercent: 80,
  maximumPriceChange24hPercent: 150,
  minimumOrganicBuyShare5m: 0.52,
  minimumOrganicBuyShare1h: 0.5,
  minimumOrganicVolume5mUsd: 2_000,
  minimumOrganicVolume1hUsd: 10_000,
  minimumOrganicBuyers5m: 3,
  minimumVolumeAccelerationRatio: 0.02,
  minimumLiquidityChange1hPercent: -5,
  minimumSolPriceChange1hPercent: -4,
  minimumSolPriceChange6hPercent: -10,
  minimumSolRelativeStrength1hPercent: 0.5,
  maximumPriceImpactPercent: 2,
  maximumRoundTripCostPercent: 5,
  stopLossPercent: 12,
  breakEvenActivationPercent: 6,
  trailingActivationPercent: 12,
  trailingDrawdownPercent: 8,
  takeProfitPercent: 25,
  weakMomentumExitSamples: 2,
  noProgressMinutes: 60,
  maximumHoldingMinutes: 6 * 60,
  cooldownMinutes: 2 * 60,
  stopCooldownMinutes: 6 * 60,
  dailyLossPausePercent: 12,
  maximumDrawdownPercent: 25
});

/** Exact compatibility defaults for persisted v3 lanes. V3 admitted a shallow 5m
 * pullback inside otherwise strong 1h evidence and a minimum breadth of two
 * organic buyers. Every static safety, missing-evidence, quote, reserve, loss,
 * and drawdown gate remains identical to v2. */
export const AUTONOMOUS_PAPER_V3_POLICY: Readonly<AutonomousPaperPolicy> = Object.freeze({
  ...AUTONOMOUS_PAPER_V2_POLICY,
  minimumPriceChange5mPercent: -0.25,
  minimumOrganicBuyers5m: 2
});

/** Exact compatibility defaults for persisted v4 lanes. V4 broadened only the
 * isolated quote-model experiment: strict token policy, signing, promotion,
 * and live execution remain outside this policy and unchanged. */
export const AUTONOMOUS_PAPER_V4_POLICY: Readonly<AutonomousPaperPolicy> = Object.freeze({
  ...AUTONOMOUS_PAPER_V3_POLICY,
  scanIntervalMinutes: 3,
  allowToken2022: true,
  maximumEntriesPerUtcDay: 8,
  minimumEntrySpacingMinutes: 10,
  positionNavFraction: 0.2,
  maximumDeployedFraction: 0.65,
  minimumAgeDays: 2,
  minimumLiquidityUsd: 150_000,
  minimumVolume24hUsd: 150_000,
  minimumHolderCount: 250,
  minimumOrganicScore: 45,
  maximumTopHoldersPercent: 55,
  minimumMarketCapUsd: 300_000,
  maximumMarketCapUsd: 600_000_000,
  maximumFdvToMarketCap: 5,
  minimumMomentumScore: 30,
  minimumPriceChange5mPercent: -1,
  maximumPriceChange5mPercent: 15,
  minimumPriceChange1hPercent: 0.5,
  maximumPriceChange1hPercent: 35,
  minimumPriceChange6hPercent: -10,
  maximumPriceChange6hPercent: 100,
  maximumPriceChange24hPercent: 200,
  minimumOrganicBuyShare5m: 0.5,
  minimumOrganicBuyShare1h: 0.48,
  minimumOrganicVolume5mUsd: 1_000,
  minimumOrganicVolume1hUsd: 5_000,
  minimumOrganicBuyers5m: 2,
  minimumVolumeAccelerationRatio: 0.01,
  minimumLiquidityChange1hPercent: -7,
  minimumSolPriceChange1hPercent: -5,
  minimumSolPriceChange6hPercent: -12,
  minimumSolRelativeStrength1hPercent: 0,
  maximumPriceImpactPercent: 2,
  maximumRoundTripCostPercent: 3,
  stopLossPercent: 10,
  breakEvenActivationPercent: 4,
  trailingActivationPercent: 8,
  trailingDrawdownPercent: 5,
  takeProfitPercent: 18,
  weakMomentumExitSamples: 3,
  noProgressMinutes: 45,
  maximumHoldingMinutes: 180,
  cooldownMinutes: 60,
  stopCooldownMinutes: 180,
  dailyLossPausePercent: 10,
  maximumDrawdownPercent: 20
});

/** Exact compatibility defaults for persisted v5 lanes. V5 changed only the
 * research lane's deterministic position-sizing semantics; all V4 admission,
 * quote, exit, loss, and drawdown gates remain frozen exactly. */
export const AUTONOMOUS_PAPER_V5_POLICY: Readonly<AutonomousPaperPolicy> = Object.freeze({
  ...AUTONOMOUS_PAPER_V4_POLICY,
  adaptiveSizingEnabled: true,
  minimumPositionUsd: AUTONOMOUS_PAPER_HARD_MINIMUM_POSITION_USD,
  adaptiveSizingMinimumTrades: 20,
  adaptiveSizingWindowTrades: 100,
  adaptiveSizingPriorWins: 5,
  adaptiveSizingPriorLosses: 5,
  adaptiveSizingFractionalKelly: 0.5,
  adaptiveSizingMinimumCalibrationMultiplier: 0.25,
  adaptiveSizingMaximumCalibrationMultiplier: 1.25,
  adaptiveSizingMaximumLossStreak: 3,
  adaptiveSizingLossStreakMultiplier: 0.8
});

/** Exact compatibility defaults for persisted v6 lanes. V6 removed V5's flat
 * dollar ceiling while retaining every other adaptive-sizing rule. */
export const AUTONOMOUS_PAPER_V6_POLICY: Readonly<AutonomousPaperPolicy> = Object.freeze({
  ...AUTONOMOUS_PAPER_V5_POLICY,
  maximumPositionUsd: Number.MAX_SAFE_INTEGER,
  positionNavFraction: 0.35,
  maximumDeployedFraction: 0.80
});

/** Exact compatibility defaults for persisted v7 lanes. V7 added contextual
 * reward scaling while retaining the complete v6 admission and exit policy. */
export const AUTONOMOUS_PAPER_V7_POLICY: Readonly<AutonomousPaperPolicy> = Object.freeze({
  ...AUTONOMOUS_PAPER_V6_POLICY,
  contextualRewardEnabled: true
});

/** Exact compatibility defaults for persisted v8 lanes. V8 added a
 * version-gated controlled exploration arm in the engine while retaining the
 * numeric v7 policy, including its eight-entry UTC-day ceiling. */
export const AUTONOMOUS_PAPER_V8_POLICY: Readonly<AutonomousPaperPolicy> = Object.freeze({
  ...AUTONOMOUS_PAPER_V7_POLICY
});

/** Frozen no-flat-dollar-cap high-risk PAPER profile. V9 removes only the
 * normal UTC-day entry-count ceiling. Position size remains bounded by
 * executable NAV, reserve, deployment, concurrent-position limits, quote
 * quality, and the complete adaptive evidence formula. Number.MAX_SAFE_INTEGER
 * is the persisted sentinel for an unlimited daily count. */
export const AUTONOMOUS_PAPER_V9_POLICY: Readonly<AutonomousPaperPolicy> = Object.freeze({
  ...AUTONOMOUS_PAPER_V8_POLICY,
  maximumEntriesPerUtcDay: Number.MAX_SAFE_INTEGER
});

/** Current v10 PAPER profile. A normal entry risks 3% of NAV at the hard stop,
 * model-confirmed entries may risk 4%, and exploration risks 2%. The position
 * remains capped at 40% of NAV with four concurrent positions, 90% deployment,
 * a $10 liquid reserve, a 45% developer/launchpad cluster cap, a 12% UTC-day
 * pause, and a 25% peak-to-trough lock. */
export const AUTONOMOUS_PAPER_V10_POLICY: Readonly<AutonomousPaperPolicy> = Object.freeze({
  ...AUTONOMOUS_PAPER_V9_POLICY,
  riskAtStopSizingEnabled: true,
  normalRiskAtStopNavFraction: 0.03,
  highConvictionRiskAtStopNavFraction: 0.04,
  explorationRiskAtStopNavFraction: 0.02,
  maximumDeveloperClusterFraction: 0.45,
  positionNavFraction: 0.4,
  maximumOpenPositions: 4,
  maximumDeployedFraction: 0.9,
  minimumLiquidReserveUsd: 10,
  dailyLossPausePercent: 12,
  maximumDrawdownPercent: 25
});

/** Frozen V12 policy. It deliberately kept V11's aggressive PAPER capital
 * envelope while introducing the separate validated-learning cohort. */
export const AUTONOMOUS_PAPER_V12_POLICY: Readonly<AutonomousPaperPolicy> = Object.freeze({
  ...AUTONOMOUS_PAPER_V10_POLICY
});

/** Current V13 PAPER profile. Capital remains deliberately aggressive and all
 * execution/promotion boundaries remain unchanged. The exit envelope is
 * shorter because the first complete V12 cohort showed that early executable
 * gains commonly reversed before the old 18% / 180-minute exit pair. This is
 * a new auditable epoch; it never rewrites V12 outcomes. */
export const DEFAULT_AUTONOMOUS_PAPER_POLICY: Readonly<AutonomousPaperPolicy> = Object.freeze({
  ...AUTONOMOUS_PAPER_V12_POLICY,
  breakEvenActivationPercent: 2,
  trailingActivationPercent: 3,
  takeProfitPercent: 4,
  maximumHoldingMinutes: 120
});

export function normalizeAutonomousPaperPolicy(
  policyVersion: string,
  stored: Partial<AutonomousPaperPolicy>
): AutonomousPaperPolicy {
  let defaults: Readonly<AutonomousPaperPolicy>;
  switch (policyVersion) {
    case AUTONOMOUS_PAPER_POLICY_VERSION:
      defaults = DEFAULT_AUTONOMOUS_PAPER_POLICY;
      break;
    case AUTONOMOUS_PAPER_V12_POLICY_VERSION:
      defaults = AUTONOMOUS_PAPER_V12_POLICY;
      break;
    case AUTONOMOUS_PAPER_V11_POLICY_VERSION:
      defaults = AUTONOMOUS_PAPER_V12_POLICY;
      break;
    case AUTONOMOUS_PAPER_V10_POLICY_VERSION:
      defaults = AUTONOMOUS_PAPER_V10_POLICY;
      break;
    case AUTONOMOUS_PAPER_V9_POLICY_VERSION:
      defaults = AUTONOMOUS_PAPER_V9_POLICY;
      break;
    case AUTONOMOUS_PAPER_V8_POLICY_VERSION:
      defaults = AUTONOMOUS_PAPER_V8_POLICY;
      break;
    case AUTONOMOUS_PAPER_V7_POLICY_VERSION:
      defaults = AUTONOMOUS_PAPER_V7_POLICY;
      break;
    case AUTONOMOUS_PAPER_V6_POLICY_VERSION:
      defaults = AUTONOMOUS_PAPER_V6_POLICY;
      break;
    case AUTONOMOUS_PAPER_V5_POLICY_VERSION:
      defaults = AUTONOMOUS_PAPER_V5_POLICY;
      break;
    case AUTONOMOUS_PAPER_V4_POLICY_VERSION:
      defaults = AUTONOMOUS_PAPER_V4_POLICY;
      break;
    case AUTONOMOUS_PAPER_V3_POLICY_VERSION:
      defaults = AUTONOMOUS_PAPER_V3_POLICY;
      break;
    case AUTONOMOUS_PAPER_V2_POLICY_VERSION:
      defaults = AUTONOMOUS_PAPER_V2_POLICY;
      break;
    case LEGACY_AUTONOMOUS_PAPER_POLICY_VERSION:
    default:
      // Retain the previous fail-closed compatibility behavior for unknown or
      // pre-versioned rows: only explicitly persisted fields can relax v1.
      defaults = LEGACY_AUTONOMOUS_PAPER_POLICY;
      break;
  }
  const normalized = { ...defaults, ...stored };
  if (
    policyVersion !== AUTONOMOUS_PAPER_POLICY_VERSION &&
    policyVersion !== AUTONOMOUS_PAPER_V12_POLICY_VERSION &&
    policyVersion !== AUTONOMOUS_PAPER_V11_POLICY_VERSION &&
    policyVersion !== AUTONOMOUS_PAPER_V10_POLICY_VERSION &&
    policyVersion !== AUTONOMOUS_PAPER_V9_POLICY_VERSION &&
    policyVersion !== AUTONOMOUS_PAPER_V8_POLICY_VERSION &&
    policyVersion !== AUTONOMOUS_PAPER_V7_POLICY_VERSION &&
    policyVersion !== AUTONOMOUS_PAPER_V6_POLICY_VERSION &&
    policyVersion !== AUTONOMOUS_PAPER_V5_POLICY_VERSION &&
    policyVersion !== AUTONOMOUS_PAPER_V4_POLICY_VERSION
  ) {
    // These controls did not exist in v1-v3. Never let a later or malformed
    // stored payload retroactively change an archived epoch's admission or
    // entry cadence semantics.
    normalized.allowToken2022 = false;
    normalized.maximumEntriesPerUtcDay = Number.MAX_SAFE_INTEGER;
    normalized.minimumEntrySpacingMinutes = 0;
  }
  if (
    policyVersion !== AUTONOMOUS_PAPER_POLICY_VERSION &&
    policyVersion !== AUTONOMOUS_PAPER_V12_POLICY_VERSION &&
    policyVersion !== AUTONOMOUS_PAPER_V11_POLICY_VERSION &&
    policyVersion !== AUTONOMOUS_PAPER_V10_POLICY_VERSION &&
    policyVersion !== AUTONOMOUS_PAPER_V9_POLICY_VERSION &&
    policyVersion !== AUTONOMOUS_PAPER_V8_POLICY_VERSION &&
    policyVersion !== AUTONOMOUS_PAPER_V7_POLICY_VERSION &&
    policyVersion !== AUTONOMOUS_PAPER_V6_POLICY_VERSION &&
    policyVersion !== AUTONOMOUS_PAPER_V5_POLICY_VERSION
  ) {
    // Adaptive sizing did not exist in v1-v4. Stored unknown fields cannot
    // retroactively alter those archived lanes or a fail-closed unknown lane.
    Object.assign(normalized, DISABLED_ADAPTIVE_SIZING_POLICY);
  }
  if (
    policyVersion !== AUTONOMOUS_PAPER_POLICY_VERSION &&
    policyVersion !== AUTONOMOUS_PAPER_V12_POLICY_VERSION &&
    policyVersion !== AUTONOMOUS_PAPER_V11_POLICY_VERSION &&
    policyVersion !== AUTONOMOUS_PAPER_V10_POLICY_VERSION &&
    policyVersion !== AUTONOMOUS_PAPER_V9_POLICY_VERSION &&
    policyVersion !== AUTONOMOUS_PAPER_V8_POLICY_VERSION &&
    policyVersion !== AUTONOMOUS_PAPER_V7_POLICY_VERSION
  ) {
    // Contextual reward did not exist before v7. Even a malformed archived row
    // cannot opt itself into later learning semantics.
    normalized.contextualRewardEnabled = false;
  }
  if (
    policyVersion !== AUTONOMOUS_PAPER_POLICY_VERSION &&
    policyVersion !== AUTONOMOUS_PAPER_V12_POLICY_VERSION &&
    policyVersion !== AUTONOMOUS_PAPER_V11_POLICY_VERSION &&
    policyVersion !== AUTONOMOUS_PAPER_V10_POLICY_VERSION
  ) {
    normalized.riskAtStopSizingEnabled = false;
    normalized.maximumDeveloperClusterFraction = 1;
  }
  return normalized;
}

export interface AutonomousAdmissionResult {
  eligible: boolean;
  reasons: string[];
}

export interface AutonomousMomentumResult {
  eligible: boolean;
  score: number;
  reasons: string[];
}

export type AutonomousEntrySizingResult =
  | { allowed: true; sizeUsd: number }
  | { allowed: false; reason: "MAX_POSITIONS" | "MAX_DEPLOYED" | "INSUFFICIENT_RESERVE" | "INVALID_CAPITAL" };

export interface AutonomousAdaptiveQuoteEvidence {
  projectedRoundTripCostPercent: number;
  buyPriceImpactPercent: number;
  sellPriceImpactPercent: number;
}

export interface AutonomousAdaptiveEntrySizingInput {
  account: AutonomousPaperAccount;
  snapshot: AutonomousPaperMarketSnapshot;
  completedTrades: readonly AutonomousPaperTrade[];
  /** Omit for the deterministic pre-quote upper-bound pass. That pass uses
   * perfect quote quality (1) and may therefore only be reduced after quotes. */
  quote?: AutonomousAdaptiveQuoteEvidence;
  /** V8 callers provide both fields to create and consume arm-isolated v2
   * contexts. Omitting both preserves exact v1-v7 context serialization. */
  strategyArm?: AutonomousPaperStrategyArm;
  waivedReasonCount?: number;
  modelHighConviction?: boolean;
  clusterDeployedUsd?: number;
  policy?: AutonomousPaperPolicy;
}

export type AutonomousAdaptiveEntrySizingResult =
  | { allowed: true; sizeUsd: number; breakdown: AutonomousPaperSizingBreakdown }
  | {
      allowed: false;
      reason:
        | "ADAPTIVE_SIZING_DISABLED"
        | "MAX_POSITIONS"
        | "MAX_DEPLOYED"
        | "INSUFFICIENT_RESERVE"
        | "BELOW_MINIMUM_POSITION"
        | "INVALID_CAPITAL"
        | "INVALID_SIZING_EVIDENCE";
    };

export interface AutonomousExitResult {
  exit: boolean;
  reason?: AutonomousPaperExitReason;
  nextWeakMomentumSamples: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function scale(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value) || maximum <= minimum) return 0;
  return clamp((value - minimum) / (maximum - minimum), 0, 1);
}

function validNumber(value: number): boolean {
  return Number.isFinite(value);
}

export function autonomousStaticAdmission(
  snapshot: AutonomousPaperMarketSnapshot,
  policy: AutonomousPaperPolicy = DEFAULT_AUTONOMOUS_PAPER_POLICY
): AutonomousAdmissionResult {
  const reasons: string[] = [];
  const numericFields: Array<readonly [number, string]> = [
    [snapshot.tokenAgeDays, "TOKEN_AGE_MISSING"],
    [snapshot.priceUsd, "PRICE_MISSING"],
    [snapshot.marketCapUsd, "MARKET_CAP_MISSING"],
    [snapshot.fdvUsd, "FDV_MISSING"],
    [snapshot.liquidityUsd, "LIQUIDITY_MISSING"],
    [snapshot.volume24hUsd, "VOLUME_MISSING"],
    [snapshot.holderCount, "HOLDERS_MISSING"],
    [snapshot.organicScore, "ORGANIC_SCORE_MISSING"],
    [snapshot.topHoldersPercent, "TOP_HOLDERS_MISSING"]
  ];
  for (const [value, reason] of numericFields) {
    if (!validNumber(value) || value < 0) reasons.push(reason);
  }
  if (!snapshot.verified) reasons.push("NOT_VERIFIED");
  if (snapshot.suspicious) reasons.push("SUSPICIOUS_OR_BANNED");
  if (
    snapshot.tokenProgram !== TOKEN_PROGRAM_ID &&
    !(policy.allowToken2022 && snapshot.tokenProgram === TOKEN_2022_PROGRAM_ID)
  ) reasons.push("UNSUPPORTED_TOKEN_PROGRAM");
  if (!snapshot.mintAuthorityDisabled) reasons.push("MINT_AUTHORITY_ENABLED");
  if (!snapshot.freezeAuthorityDisabled) reasons.push("FREEZE_AUTHORITY_ENABLED");
  if (snapshot.tokenAgeDays < policy.minimumAgeDays) reasons.push("TOKEN_TOO_YOUNG");
  if (snapshot.priceUsd <= 0) reasons.push("INVALID_PRICE");
  if (snapshot.liquidityUsd < policy.minimumLiquidityUsd) reasons.push("INSUFFICIENT_LIQUIDITY");
  if (snapshot.volume24hUsd < policy.minimumVolume24hUsd) reasons.push("INSUFFICIENT_VOLUME");
  if (snapshot.holderCount < policy.minimumHolderCount) reasons.push("INSUFFICIENT_HOLDERS");
  if (snapshot.organicScore < policy.minimumOrganicScore) reasons.push("LOW_ORGANIC_SCORE");
  if (snapshot.topHoldersPercent > policy.maximumTopHoldersPercent) reasons.push("TOP_HOLDER_CONCENTRATION");
  if (snapshot.marketCapUsd < policy.minimumMarketCapUsd) reasons.push("MARKET_CAP_TOO_LOW");
  if (snapshot.marketCapUsd > policy.maximumMarketCapUsd) reasons.push("MARKET_CAP_TOO_HIGH");
  if (snapshot.marketCapUsd > 0 && snapshot.fdvUsd / snapshot.marketCapUsd > policy.maximumFdvToMarketCap) {
    reasons.push("FDV_TO_MARKET_CAP_TOO_HIGH");
  }
  return { eligible: reasons.length === 0, reasons: [...new Set(reasons)] };
}

/** Cross-sectional momentum score. Hard gates reject vertical pumps and weak
 * organic flow before the score is considered. */
export function autonomousMomentum(
  snapshot: AutonomousPaperMarketSnapshot,
  sol: AutonomousPaperMarketSnapshot,
  policy: AutonomousPaperPolicy = DEFAULT_AUTONOMOUS_PAPER_POLICY
): AutonomousMomentumResult {
  const reasons: string[] = [];
  const fields = [
    snapshot.priceChange5mPercent,
    snapshot.priceChange1hPercent,
    snapshot.priceChange6hPercent,
    snapshot.priceChange24hPercent,
    snapshot.organicBuyShare5m,
    snapshot.organicBuyShare1h,
    snapshot.organicVolume5mUsd,
    snapshot.organicVolume1hUsd,
    snapshot.organicBuyers5m,
    snapshot.volumeAccelerationRatio,
    snapshot.liquidityChange1hPercent,
    sol.priceChange1hPercent,
    sol.priceChange6hPercent
  ];
  if (fields.some((value) => !Number.isFinite(value))) reasons.push("MOMENTUM_DATA_MISSING");
  if (
    snapshot.priceChange5mPercent < policy.minimumPriceChange5mPercent ||
    snapshot.priceChange5mPercent > policy.maximumPriceChange5mPercent
  ) {
    reasons.push("FIVE_MINUTE_MOMENTUM_OUTSIDE_RANGE");
  }
  if (
    snapshot.priceChange1hPercent < policy.minimumPriceChange1hPercent ||
    snapshot.priceChange1hPercent > policy.maximumPriceChange1hPercent
  ) {
    reasons.push("ONE_HOUR_MOMENTUM_OUTSIDE_RANGE");
  }
  if (
    snapshot.priceChange6hPercent <= policy.minimumPriceChange6hPercent ||
    snapshot.priceChange6hPercent > policy.maximumPriceChange6hPercent
  ) {
    reasons.push("SIX_HOUR_MOMENTUM_OUTSIDE_RANGE");
  }
  if (snapshot.priceChange24hPercent >= policy.maximumPriceChange24hPercent) {
    reasons.push("LATE_VERTICAL_PUMP");
  }
  if (snapshot.organicBuyShare5m < policy.minimumOrganicBuyShare5m) {
    reasons.push("WEAK_FIVE_MINUTE_ORGANIC_BUYING");
  }
  if (snapshot.organicBuyShare1h < policy.minimumOrganicBuyShare1h) {
    reasons.push("WEAK_ONE_HOUR_ORGANIC_BUYING");
  }
  if (snapshot.organicVolume5mUsd < policy.minimumOrganicVolume5mUsd) {
    reasons.push("LOW_FIVE_MINUTE_ORGANIC_VOLUME");
  }
  if (snapshot.organicVolume1hUsd < policy.minimumOrganicVolume1hUsd) {
    reasons.push("LOW_ONE_HOUR_ORGANIC_VOLUME");
  }
  if (snapshot.organicBuyers5m < policy.minimumOrganicBuyers5m) {
    reasons.push("LOW_ORGANIC_BUYER_BREADTH");
  }
  if (snapshot.volumeAccelerationRatio < policy.minimumVolumeAccelerationRatio) {
    reasons.push("LOW_VOLUME_ACCELERATION");
  }
  if (snapshot.liquidityChange1hPercent < policy.minimumLiquidityChange1hPercent) {
    reasons.push("LIQUIDITY_DRAIN");
  }
  if (
    sol.priceChange1hPercent <= policy.minimumSolPriceChange1hPercent ||
    sol.priceChange6hPercent <= policy.minimumSolPriceChange6hPercent
  ) reasons.push("WEAK_SOL_REGIME");
  const relativeStrength = snapshot.priceChange1hPercent - sol.priceChange1hPercent;
  if (relativeStrength < policy.minimumSolRelativeStrength1hPercent) {
    reasons.push("INSUFFICIENT_SOL_RELATIVE_STRENGTH");
  }

  const score = Math.round(100 * (
    0.15 * scale(snapshot.organicScore, policy.minimumOrganicScore, 100) +
    0.15 * scale(
      snapshot.priceChange5mPercent,
      policy.minimumPriceChange5mPercent,
      policy.maximumPriceChange5mPercent
    ) +
    0.15 * scale(
      snapshot.priceChange1hPercent,
      policy.minimumPriceChange1hPercent,
      policy.maximumPriceChange1hPercent
    ) +
    0.15 * scale(snapshot.organicBuyShare5m, policy.minimumOrganicBuyShare5m, 0.85) +
    0.10 * scale(snapshot.organicBuyShare1h, policy.minimumOrganicBuyShare1h, 0.75) +
    0.10 * scale(relativeStrength, policy.minimumSolRelativeStrength1hPercent, 12) +
    0.10 * scale(snapshot.volumeAccelerationRatio, policy.minimumVolumeAccelerationRatio, 0.35) +
    0.10 * scale(snapshot.organicBuyers5m, policy.minimumOrganicBuyers5m, 250)
  ));
  if (score < policy.minimumMomentumScore) reasons.push("MOMENTUM_SCORE_TOO_LOW");
  return { eligible: reasons.length === 0, score, reasons: [...new Set(reasons)] };
}

export function autonomousEntrySize(
  account: AutonomousPaperAccount,
  policy: AutonomousPaperPolicy = DEFAULT_AUTONOMOUS_PAPER_POLICY
): AutonomousEntrySizingResult {
  if (
    !Number.isFinite(account.navUsd) || account.navUsd <= 0 ||
    !Number.isFinite(account.cashUsd) || account.cashUsd < 0 ||
    !Number.isFinite(account.deployedUsd) || account.deployedUsd < 0 ||
    !Number.isSafeInteger(account.openPositions) || account.openPositions < 0
  ) return { allowed: false, reason: "INVALID_CAPITAL" };
  if (account.openPositions >= policy.maximumOpenPositions) return { allowed: false, reason: "MAX_POSITIONS" };
  const sizeUsd = Math.floor(
    Math.min(policy.maximumPositionUsd, account.navUsd * policy.positionNavFraction) * 1_000_000
  ) / 1_000_000;
  if (account.deployedUsd + sizeUsd > account.navUsd * policy.maximumDeployedFraction + 1e-9) {
    return { allowed: false, reason: "MAX_DEPLOYED" };
  }
  if (account.cashUsd - sizeUsd < policy.minimumLiquidReserveUsd - 1e-9) {
    return { allowed: false, reason: "INSUFFICIENT_RESERVE" };
  }
  return { allowed: true, sizeUsd };
}

const ADAPTIVE_CATEGORY_RANK_KEYS = Object.freeze([
  "topTraded24h",
  "topTraded1h",
  "topTrending1h",
  "topOrganicScore5m",
  "topOrganicScore1h"
] as const);

function floorUsdCents(value: number): number {
  return Math.floor((value + 1e-9) * 100) / 100;
}

function logarithmicThresholdScale(value: number, minimum: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(minimum) || value < 0 || minimum <= 0) return 0;
  if (value <= minimum) return 0;
  return clamp(Math.log(value / minimum) / Math.log(20), 0, 1);
}

function ceilingQuality(value: number, ceiling: number): number {
  if (!Number.isFinite(value) || value < 0 || !Number.isFinite(ceiling) || ceiling <= 0) return 0;
  return 1 - clamp(value / ceiling, 0, 1);
}

function uniqueSizingCodes<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function contextualRewardState(
  multiplier: number,
  overrides: Partial<AutonomousPaperContextualReward> = {}
): AutonomousPaperContextualReward {
  return {
    active: false,
    preQuoteUpperBound: false,
    comparableTrades: 0,
    effectiveSampleSize: 0,
    distinctMints: 0,
    distinctUtcDays: 0,
    ignoredMissingContext: 0,
    weightedAverageReward: 0,
    shrunkReward: 0,
    multiplier,
    contributingTradeIds: [],
    ...overrides
  };
}

interface NormalizedLearningContext {
  momentum: number;
  categoryRank: number;
  liquidityFlow: number;
  quoteQuality: number;
  projectedRoundTripCostPercent: number;
  strategyArm: AutonomousPaperStrategyArm;
  waivedReasonCount: number;
}

function normalizeLearningContext(
  value: AutonomousPaperLearningContext
): NormalizedLearningContext | undefined {
  const featuresValid = [
    value.momentum,
    value.categoryRank,
    value.liquidityFlow,
    value.quoteQuality,
    value.projectedRoundTripCostPercent
  ].every((number) => Number.isFinite(number)) &&
    value.momentum >= 0 && value.momentum <= 1 &&
    value.categoryRank >= 0 && value.categoryRank <= 1 &&
    value.liquidityFlow >= 0 && value.liquidityFlow <= 1 &&
    value.quoteQuality >= 0 && value.quoteQuality <= 1 &&
    value.projectedRoundTripCostPercent >= 0;
  if (!featuresValid) return undefined;

  const features = {
    momentum: value.momentum,
    categoryRank: value.categoryRank,
    liquidityFlow: value.liquidityFlow,
    quoteQuality: value.quoteQuality,
    projectedRoundTripCostPercent: value.projectedRoundTripCostPercent
  };
  if (value.version === AUTONOMOUS_PAPER_LEARNING_CONTEXT_VERSION) {
    // V1 had no arm field because every archived contextual sample came from
    // the normal momentum arm. Normalize in memory without rewriting payloads.
    return { ...features, strategyArm: "MOMENTUM", waivedReasonCount: 0 };
  }
  if (
    value.version !== AUTONOMOUS_PAPER_LEARNING_CONTEXT_V2_VERSION ||
    ![
      "MOMENTUM",
      "MOMENTUM_CONTINUATION",
      "CONTROLLED_EXPLORATION",
      "BREAKOUT",
      "PULLBACK_RECLAIM",
      "WALLET_CONFIRMED_MOMENTUM",
      "EARLY_LIQUIDITY"
    ].includes(value.strategyArm) ||
    !Number.isSafeInteger(value.waivedReasonCount) ||
    value.waivedReasonCount < 0 ||
    (value.strategyArm !== "CONTROLLED_EXPLORATION" && value.waivedReasonCount !== 0) ||
    (value.strategyArm === "CONTROLLED_EXPLORATION" && value.waivedReasonCount < 1)
  ) return undefined;
  return {
    ...features,
    strategyArm: value.strategyArm,
    waivedReasonCount: value.waivedReasonCount
  };
}

function validLearningContext(value: AutonomousPaperLearningContext): boolean {
  return normalizeLearningContext(value) !== undefined;
}

/** Builds the compact immutable feature vector that the engine persists on a
 * contextual-policy position and later copies onto its completed trade. */
export function autonomousPaperLearningContext(
  sizing: AutonomousPaperSizingBreakdown,
  projectedRoundTripCostPercent: number
): AutonomousPaperLearningContextV1;
export function autonomousPaperLearningContext(
  sizing: AutonomousPaperSizingBreakdown,
  projectedRoundTripCostPercent: number,
  strategyArm: AutonomousPaperStrategyArm,
  waivedReasonCount: number
): AutonomousPaperLearningContextV2;
export function autonomousPaperLearningContext(
  sizing: AutonomousPaperSizingBreakdown,
  projectedRoundTripCostPercent: number,
  strategyArm?: AutonomousPaperStrategyArm,
  waivedReasonCount?: number
): AutonomousPaperLearningContext {
  const features = {
    momentum: sizing.componentScores.momentum,
    categoryRank: sizing.componentScores.categoryRank,
    liquidityFlow: sizing.componentScores.liquidityFlow,
    quoteQuality: sizing.componentScores.quoteQuality,
    projectedRoundTripCostPercent
  };
  if ((strategyArm === undefined) !== (waivedReasonCount === undefined)) {
    throw new RangeError("Autonomous PAPER v2 learning context requires complete arm provenance.");
  }
  const context: AutonomousPaperLearningContext = strategyArm === undefined
    ? {
        version: AUTONOMOUS_PAPER_LEARNING_CONTEXT_VERSION,
        ...features
      }
    : {
        version: AUTONOMOUS_PAPER_LEARNING_CONTEXT_V2_VERSION,
        ...features,
        strategyArm,
        waivedReasonCount: waivedReasonCount!
      };
  if (!validLearningContext(context)) {
    throw new RangeError("Autonomous PAPER learning context is invalid.");
  }
  return context;
}

function contextualRewardForSizing(input: {
  current?: AutonomousPaperLearningContext;
  trades: readonly AutonomousPaperTrade[];
  policy: AutonomousPaperPolicy;
}): AutonomousPaperContextualReward | undefined {
  const { policy } = input;
  if (!policy.contextualRewardEnabled) return contextualRewardState(1);
  if (!input.current) {
    // Context includes final quote quality. Before the quote exists, use the
    // persisted maximum as a strict upper bound so final sizing cannot grow.
    return contextualRewardState(policy.contextualRewardMaximumMultiplier, {
      preQuoteUpperBound: true
    });
  }
  const current = normalizeLearningContext(input.current);
  if (!current) return undefined;

  let ignoredMissingContext = 0;
  let weightSum = 0;
  let squaredWeightSum = 0;
  let weightedRewardSum = 0;
  const contributingTradeIds: string[] = [];
  const mintCounts = new Map<string, number>();
  const distinctMints = new Set<string>();
  const distinctUtcDays = new Set<string>();

  for (const trade of input.trades) {
    const context = trade.entryLearningContext;
    if (!context) {
      ignoredMissingContext += 1;
      continue;
    }
    const normalized = normalizeLearningContext(context);
    if (!normalized) return undefined;
    if (normalized.strategyArm !== current.strategyArm) continue;
    const distance =
      0.40 * Math.abs(current.momentum - normalized.momentum) +
      0.20 * Math.abs(current.categoryRank - normalized.categoryRank) +
      0.25 * Math.abs(current.liquidityFlow - normalized.liquidityFlow) +
      0.15 * Math.abs(current.quoteQuality - normalized.quoteQuality);
    if (distance >= policy.contextualRewardMaximumDistance) continue;
    const mintCount = mintCounts.get(trade.mint) ?? 0;
    if (mintCount >= policy.contextualRewardMaximumSamplesPerMint) continue;

    const similarity = 1 - distance / policy.contextualRewardMaximumDistance;
    const weight = similarity ** 2;
    if (!Number.isFinite(weight) || weight <= 0) continue;
    const denominator = trade.returnPercent >= 0
      ? policy.takeProfitPercent
      : policy.stopLossPercent;
    // returnPercent is executable and already includes modeled entry/exit
    // costs. Subtracting modeledCostsUsd here would double-count costs.
    const netReward = clamp(trade.returnPercent / denominator, -1, 1);
    weightSum += weight;
    squaredWeightSum += weight ** 2;
    weightedRewardSum += weight * netReward;
    mintCounts.set(trade.mint, mintCount + 1);
    distinctMints.add(trade.mint);
    distinctUtcDays.add(trade.closedAt.slice(0, 10));
    contributingTradeIds.push(trade.id);
  }

  const comparableTrades = contributingTradeIds.length;
  const effectiveSampleSize = squaredWeightSum > 0
    ? weightSum ** 2 / squaredWeightSum
    : 0;
  const weightedAverageReward = weightSum > 0 ? weightedRewardSum / weightSum : 0;
  const shrunkReward = weightSum > 0
    ? weightedRewardSum / (weightSum + policy.contextualRewardPriorWeight)
    : 0;
  const active =
    comparableTrades >= policy.contextualRewardMinimumComparableTrades &&
    effectiveSampleSize + 1e-12 >= policy.contextualRewardMinimumEffectiveSamples &&
    distinctMints.size >= policy.contextualRewardMinimumDistinctMints &&
    distinctUtcDays.size >= policy.contextualRewardMinimumDistinctUtcDays;
  const multiplier = active
    ? clamp(
        1 + policy.contextualRewardGain * shrunkReward,
        policy.contextualRewardMinimumMultiplier,
        policy.contextualRewardMaximumMultiplier
      )
    : 1;
  return contextualRewardState(multiplier, {
    active,
    comparableTrades,
    effectiveSampleSize,
    distinctMints: distinctMints.size,
    distinctUtcDays: distinctUtcDays.size,
    ignoredMissingContext,
    weightedAverageReward,
    shrunkReward,
    contributingTradeIds
  });
}

/**
 * Deterministic adaptive sizing. This function has no clock, network, randomness, or
 * mutable model state: identical frozen policy, account, snapshot, completed
 * trades, and optional quote evidence always return the same cent amount.
 *
 * Omit `quote` for a pre-quote upper-bound pass (Q=1). The engine must never
 * increase that result after observing quotes; a smaller result requires an
 * exact-size re-quote before it can be committed.
 */
export function autonomousAdaptiveEntrySize(
  input: AutonomousAdaptiveEntrySizingInput
): AutonomousAdaptiveEntrySizingResult {
  const policy = input.policy ?? DEFAULT_AUTONOMOUS_PAPER_POLICY;
  const { account, snapshot } = input;
  if (!policy.adaptiveSizingEnabled) {
    return { allowed: false, reason: "ADAPTIVE_SIZING_DISABLED" };
  }
  const hasStrategyArm = input.strategyArm !== undefined;
  const hasWaivedReasonCount = input.waivedReasonCount !== undefined;
  if (
    hasStrategyArm !== hasWaivedReasonCount ||
    (hasStrategyArm && (
      ![
        "MOMENTUM",
        "MOMENTUM_CONTINUATION",
        "CONTROLLED_EXPLORATION",
        "BREAKOUT",
        "PULLBACK_RECLAIM",
        "WALLET_CONFIRMED_MOMENTUM",
        "EARLY_LIQUIDITY"
      ].includes(input.strategyArm!) ||
      !Number.isSafeInteger(input.waivedReasonCount) ||
      input.waivedReasonCount! < 0 ||
      (input.strategyArm !== "CONTROLLED_EXPLORATION" && input.waivedReasonCount !== 0) ||
      (input.strategyArm === "CONTROLLED_EXPLORATION" &&
        input.waivedReasonCount! < 1)
    ))
  ) return { allowed: false, reason: "INVALID_SIZING_EVIDENCE" };
  if (
    !Number.isFinite(account.navUsd) || account.navUsd <= 0 ||
    !Number.isFinite(account.cashUsd) || account.cashUsd < 0 ||
    !Number.isFinite(account.peakNavUsd) || account.peakNavUsd <= 0 ||
    !Number.isFinite(account.deployedUsd) || account.deployedUsd < 0 ||
    !Number.isSafeInteger(account.openPositions) || account.openPositions < 0 ||
    !account.pricingComplete ||
    !Number.isFinite(policy.minimumPositionUsd) ||
    !Number.isFinite(policy.maximumPositionUsd) ||
    !Number.isFinite(policy.positionNavFraction) || policy.positionNavFraction <= 0 ||
    !Number.isFinite(policy.maximumDeployedFraction) || policy.maximumDeployedFraction <= 0 ||
    !Number.isFinite(policy.minimumLiquidReserveUsd) || policy.minimumLiquidReserveUsd < 0 ||
    !Number.isFinite(policy.maximumDrawdownPercent) || policy.maximumDrawdownPercent <= 0 ||
    (input.modelHighConviction !== undefined && typeof input.modelHighConviction !== "boolean") ||
    (input.clusterDeployedUsd !== undefined &&
      (!Number.isFinite(input.clusterDeployedUsd) || input.clusterDeployedUsd < 0))
  ) return { allowed: false, reason: "INVALID_CAPITAL" };
  if (account.openPositions >= policy.maximumOpenPositions) {
    return { allowed: false, reason: "MAX_POSITIONS" };
  }

  const minimumUsd = Math.max(
    AUTONOMOUS_PAPER_HARD_MINIMUM_POSITION_USD,
    policy.minimumPositionUsd
  );
  const explorationArm = input.strategyArm === "CONTROLLED_EXPLORATION" ||
    input.strategyArm === "EARLY_LIQUIDITY";
  const riskFraction = input.modelHighConviction
    ? policy.highConvictionRiskAtStopNavFraction
    : explorationArm
      ? policy.explorationRiskAtStopNavFraction
      : policy.normalRiskAtStopNavFraction;
  const capitalCaps = {
    hardUsd: AUTONOMOUS_PAPER_HARD_MAXIMUM_POSITION_USD,
    policyUsd: policy.maximumPositionUsd,
    navFractionUsd: account.navUsd * policy.positionNavFraction,
    reserveUsd: account.cashUsd - policy.minimumLiquidReserveUsd,
    deploymentUsd: account.navUsd * policy.maximumDeployedFraction - account.deployedUsd,
    riskAtStopUsd: policy.riskAtStopSizingEnabled
      ? account.navUsd * riskFraction / (policy.stopLossPercent / 100)
      : AUTONOMOUS_PAPER_HARD_MAXIMUM_POSITION_USD,
    developerClusterUsd: policy.riskAtStopSizingEnabled
      ? account.navUsd * policy.maximumDeveloperClusterFraction - (input.clusterDeployedUsd ?? 0)
      : AUTONOMOUS_PAPER_HARD_MAXIMUM_POSITION_USD
  };
  if (
    !Object.values(capitalCaps).every((value) => Number.isFinite(value)) ||
    minimumUsd > AUTONOMOUS_PAPER_HARD_MAXIMUM_POSITION_USD
  ) return { allowed: false, reason: "INVALID_CAPITAL" };
  const maximumAvailableRaw = Math.min(...Object.values(capitalCaps));
  const maximumAvailableUsd = floorUsdCents(Math.max(0, maximumAvailableRaw));
  if (maximumAvailableUsd + 1e-9 < minimumUsd) {
    if (capitalCaps.reserveUsd + 1e-9 < minimumUsd) {
      return { allowed: false, reason: "INSUFFICIENT_RESERVE" };
    }
    if (capitalCaps.deploymentUsd + 1e-9 < minimumUsd) {
      return { allowed: false, reason: "MAX_DEPLOYED" };
    }
    return { allowed: false, reason: "BELOW_MINIMUM_POSITION" };
  }

  const sizingNumbers = [
    snapshot.momentumScore,
    snapshot.liquidityUsd,
    snapshot.organicVolume5mUsd,
    snapshot.organicVolume1hUsd,
    snapshot.organicBuyers5m,
    snapshot.organicBuyShare5m,
    snapshot.organicBuyShare1h,
    policy.minimumMomentumScore,
    policy.minimumLiquidityUsd,
    policy.minimumOrganicVolume5mUsd,
    policy.minimumOrganicVolume1hUsd,
    policy.minimumOrganicBuyers5m,
    policy.minimumOrganicBuyShare5m,
    policy.minimumOrganicBuyShare1h,
    policy.takeProfitPercent,
    policy.stopLossPercent,
    policy.adaptiveSizingMinimumTrades,
    policy.adaptiveSizingWindowTrades,
    policy.adaptiveSizingPriorWins,
    policy.adaptiveSizingPriorLosses,
    policy.adaptiveSizingFractionalKelly,
    policy.adaptiveSizingMinimumCalibrationMultiplier,
    policy.adaptiveSizingMaximumCalibrationMultiplier,
    policy.adaptiveSizingMaximumLossStreak,
    policy.adaptiveSizingLossStreakMultiplier,
    policy.contextualRewardMinimumComparableTrades,
    policy.contextualRewardMaximumDistance,
    policy.contextualRewardPriorWeight,
    policy.contextualRewardGain,
    policy.contextualRewardMinimumEffectiveSamples,
    policy.contextualRewardMinimumDistinctMints,
    policy.contextualRewardMinimumDistinctUtcDays,
    policy.contextualRewardMaximumSamplesPerMint,
    policy.contextualRewardMinimumMultiplier,
    policy.contextualRewardMaximumMultiplier,
    policy.normalRiskAtStopNavFraction,
    policy.highConvictionRiskAtStopNavFraction,
    policy.explorationRiskAtStopNavFraction,
    policy.maximumDeveloperClusterFraction
  ];
  if (
    sizingNumbers.some((value) => !Number.isFinite(value)) ||
    snapshot.momentumScore < 0 || snapshot.momentumScore > 100 ||
    snapshot.liquidityUsd < 0 || snapshot.organicVolume5mUsd < 0 ||
    snapshot.organicVolume1hUsd < 0 || snapshot.organicBuyers5m < 0 ||
    snapshot.organicBuyShare5m < 0 || snapshot.organicBuyShare5m > 1 ||
    snapshot.organicBuyShare1h < 0 || snapshot.organicBuyShare1h > 1 ||
    policy.minimumLiquidityUsd <= 0 || policy.minimumOrganicVolume5mUsd <= 0 ||
    policy.minimumOrganicVolume1hUsd <= 0 || policy.minimumOrganicBuyers5m <= 0 ||
    policy.takeProfitPercent <= 0 || policy.stopLossPercent <= 0 ||
    !Number.isSafeInteger(policy.adaptiveSizingMinimumTrades) ||
    !Number.isSafeInteger(policy.adaptiveSizingWindowTrades) ||
    policy.adaptiveSizingMinimumTrades < 1 ||
    policy.adaptiveSizingWindowTrades < policy.adaptiveSizingMinimumTrades ||
    !Number.isSafeInteger(policy.adaptiveSizingPriorWins) ||
    !Number.isSafeInteger(policy.adaptiveSizingPriorLosses) ||
    policy.adaptiveSizingPriorWins <= 0 || policy.adaptiveSizingPriorLosses <= 0 ||
    policy.adaptiveSizingFractionalKelly < 0 || policy.adaptiveSizingFractionalKelly > 1 ||
    policy.adaptiveSizingMinimumCalibrationMultiplier <= 0 ||
    policy.adaptiveSizingMaximumCalibrationMultiplier <
      policy.adaptiveSizingMinimumCalibrationMultiplier ||
    !Number.isSafeInteger(policy.adaptiveSizingMaximumLossStreak) ||
    policy.adaptiveSizingMaximumLossStreak < 0 ||
    policy.adaptiveSizingLossStreakMultiplier <= 0 ||
    policy.adaptiveSizingLossStreakMultiplier > 1 ||
    !Number.isSafeInteger(policy.contextualRewardMinimumComparableTrades) ||
    policy.contextualRewardMinimumComparableTrades < 1 ||
    policy.contextualRewardMaximumDistance <= 0 ||
    policy.contextualRewardMaximumDistance > 1 ||
    policy.contextualRewardPriorWeight <= 0 ||
    policy.contextualRewardGain <= 0 ||
    policy.contextualRewardMinimumEffectiveSamples <= 0 ||
    policy.contextualRewardMinimumEffectiveSamples >
      policy.contextualRewardMinimumComparableTrades ||
    !Number.isSafeInteger(policy.contextualRewardMinimumDistinctMints) ||
    policy.contextualRewardMinimumDistinctMints < 1 ||
    policy.contextualRewardMinimumDistinctMints >
      policy.contextualRewardMinimumComparableTrades ||
    !Number.isSafeInteger(policy.contextualRewardMinimumDistinctUtcDays) ||
    policy.contextualRewardMinimumDistinctUtcDays < 1 ||
    policy.contextualRewardMinimumDistinctUtcDays >
      policy.contextualRewardMinimumComparableTrades ||
    !Number.isSafeInteger(policy.contextualRewardMaximumSamplesPerMint) ||
    policy.contextualRewardMaximumSamplesPerMint < 1 ||
    policy.contextualRewardMinimumDistinctMints *
      policy.contextualRewardMaximumSamplesPerMint <
      policy.contextualRewardMinimumComparableTrades ||
    policy.contextualRewardMinimumMultiplier <= 0 ||
    policy.contextualRewardMinimumMultiplier > 1 ||
    policy.contextualRewardMaximumMultiplier < 1 ||
    policy.contextualRewardMaximumMultiplier < policy.contextualRewardMinimumMultiplier
    || policy.normalRiskAtStopNavFraction <= 0 || policy.normalRiskAtStopNavFraction > 1
    || policy.highConvictionRiskAtStopNavFraction < policy.normalRiskAtStopNavFraction
    || policy.highConvictionRiskAtStopNavFraction > 1
    || policy.explorationRiskAtStopNavFraction <= 0
    || policy.explorationRiskAtStopNavFraction > policy.normalRiskAtStopNavFraction
    || policy.maximumDeveloperClusterFraction <= 0 || policy.maximumDeveloperClusterFraction > 1
  ) return { allowed: false, reason: "INVALID_SIZING_EVIDENCE" };

  let categoryRankTotal = 0;
  for (const key of ADAPTIVE_CATEGORY_RANK_KEYS) {
    const rank = snapshot.categoryRanks[key];
    if (rank === undefined) continue;
    if (!Number.isSafeInteger(rank) || rank < 1 || rank > 100) {
      return { allowed: false, reason: "INVALID_SIZING_EVIDENCE" };
    }
    categoryRankTotal += (101 - rank) / 100;
  }
  const categoryRank = categoryRankTotal / ADAPTIVE_CATEGORY_RANK_KEYS.length;
  const momentum = policy.minimumMomentumScore < 100
    ? scale(snapshot.momentumScore, policy.minimumMomentumScore, 100)
    : Number(snapshot.momentumScore >= 100);
  const liquidityFlow = clamp(
    0.20 * logarithmicThresholdScale(snapshot.liquidityUsd, policy.minimumLiquidityUsd) +
    0.20 * logarithmicThresholdScale(
      snapshot.organicVolume5mUsd,
      policy.minimumOrganicVolume5mUsd
    ) +
    0.15 * logarithmicThresholdScale(
      snapshot.organicVolume1hUsd,
      policy.minimumOrganicVolume1hUsd
    ) +
    0.15 * logarithmicThresholdScale(
      snapshot.organicBuyers5m,
      policy.minimumOrganicBuyers5m
    ) +
    0.20 * scale(snapshot.organicBuyShare5m, policy.minimumOrganicBuyShare5m, 0.85) +
    0.10 * scale(snapshot.organicBuyShare1h, policy.minimumOrganicBuyShare1h, 0.75),
    0,
    1
  );

  let quoteQuality = 1;
  if (input.quote) {
    const quoteNumbers = [
      input.quote.projectedRoundTripCostPercent,
      input.quote.buyPriceImpactPercent,
      input.quote.sellPriceImpactPercent
    ];
    if (quoteNumbers.some((value) => !Number.isFinite(value) || value < 0)) {
      return { allowed: false, reason: "INVALID_SIZING_EVIDENCE" };
    }
    const costQuality = ceilingQuality(
      input.quote.projectedRoundTripCostPercent,
      policy.maximumRoundTripCostPercent
    );
    const impactQuality = ceilingQuality(
      Math.max(input.quote.buyPriceImpactPercent, input.quote.sellPriceImpactPercent),
      policy.maximumPriceImpactPercent
    );
    quoteQuality = 0.60 * costQuality + 0.40 * impactQuality;
  }
  const conviction = clamp(
    0.45 * momentum +
    0.20 * categoryRank +
    0.20 * liquidityFlow +
    0.15 * quoteQuality,
    0,
    1
  );

  const sortedTrades = [...input.completedTrades].sort((left, right) =>
    Date.parse(right.closedAt) - Date.parse(left.closedAt) ||
    right.id.localeCompare(left.id)
  );
  if (sortedTrades.some((trade) =>
    trade.laneId !== account.laneId ||
    !trade.id ||
    !Number.isFinite(Date.parse(trade.closedAt)) ||
    !Number.isFinite(trade.returnPercent)
  )) return { allowed: false, reason: "INVALID_SIZING_EVIDENCE" };
  const requestedStrategyArm = input.strategyArm ?? "MOMENTUM";
  const calibrationTrades: AutonomousPaperTrade[] = [];
  for (const trade of sortedTrades) {
    const context = trade.entryLearningContext;
    if (!context) {
      // Context-free trades predate strategy arms and therefore belong only to
      // the original momentum calibration. They can never train exploration.
      if (requestedStrategyArm === "MOMENTUM") calibrationTrades.push(trade);
    } else {
      const normalized = normalizeLearningContext(context);
      // Retain malformed evidence so contextual validation fails closed rather
      // than making a corrupt sample disappear from the deterministic replay.
      if (!normalized || normalized.strategyArm === requestedStrategyArm) {
        calibrationTrades.push(trade);
      }
    }
    if (calibrationTrades.length >= policy.adaptiveSizingWindowTrades) break;
  }
  const sampleCount = calibrationTrades.length;
  const winningReturns = calibrationTrades
    .map((trade) => trade.returnPercent)
    .filter((value) => value > 0);
  const losingReturns = calibrationTrades
    .map((trade) => trade.returnPercent)
    .filter((value) => value <= 0);
  const winProbability = (
    winningReturns.length + policy.adaptiveSizingPriorWins
  ) / (
    sampleCount + policy.adaptiveSizingPriorWins + policy.adaptiveSizingPriorLosses
  );
  const averageWinPercent = (
    winningReturns.reduce((sum, value) => sum + value, 0) +
    policy.adaptiveSizingPriorWins * (policy.takeProfitPercent / 2)
  ) / (winningReturns.length + policy.adaptiveSizingPriorWins);
  const averageLossPercent = (
    losingReturns.reduce((sum, value) => sum + Math.abs(value), 0) +
    policy.adaptiveSizingPriorLosses * (policy.stopLossPercent / 2)
  ) / (losingReturns.length + policy.adaptiveSizingPriorLosses);
  const payoffRatio = averageWinPercent / averageLossPercent;
  const fullKelly = clamp(
    winProbability - (1 - winProbability) / payoffRatio,
    -1,
    1
  );
  const coldStart = sampleCount < policy.adaptiveSizingMinimumTrades;
  const calibrationMultiplier = coldStart
    ? 1
    : clamp(
        0.5 + policy.adaptiveSizingFractionalKelly * fullKelly /
          policy.positionNavFraction,
        policy.adaptiveSizingMinimumCalibrationMultiplier,
        policy.adaptiveSizingMaximumCalibrationMultiplier
      );
  const rewardSum = calibrationTrades.reduce((sum, trade) => {
    const denominator = trade.returnPercent >= 0
      ? policy.takeProfitPercent
      : policy.stopLossPercent;
    return sum + clamp(trade.returnPercent / denominator, -1, 1);
  }, 0);
  const averageReward = rewardSum / (
    sampleCount + policy.adaptiveSizingPriorWins + policy.adaptiveSizingPriorLosses
  );
  const baseRewardMultiplier = coldStart
    ? 1
    : clamp(1 + 0.25 * averageReward, 0.75, 1.20);
  const currentLearningContext: AutonomousPaperLearningContext | undefined = input.quote
    ? input.strategyArm === undefined
      ? {
          version: AUTONOMOUS_PAPER_LEARNING_CONTEXT_VERSION,
          momentum,
          categoryRank,
          liquidityFlow,
          quoteQuality,
          projectedRoundTripCostPercent: input.quote.projectedRoundTripCostPercent
        }
      : {
          version: AUTONOMOUS_PAPER_LEARNING_CONTEXT_V2_VERSION,
          momentum,
          categoryRank,
          liquidityFlow,
          quoteQuality,
          projectedRoundTripCostPercent: input.quote.projectedRoundTripCostPercent,
          strategyArm: input.strategyArm,
          waivedReasonCount: input.waivedReasonCount!
        }
    : undefined;
  const contextualReward = contextualRewardForSizing({
    ...(currentLearningContext ? { current: currentLearningContext } : {}),
    trades: calibrationTrades,
    policy
  });
  if (!contextualReward) return { allowed: false, reason: "INVALID_SIZING_EVIDENCE" };
  const rewardMultiplier = policy.contextualRewardEnabled
    ? clamp(
        baseRewardMultiplier * contextualReward.multiplier,
        policy.contextualRewardMinimumMultiplier,
        policy.contextualRewardMaximumMultiplier
      )
    : baseRewardMultiplier;

  let consecutiveLosses = 0;
  if (policy.adaptiveSizingMaximumLossStreak > 0) {
    for (const trade of calibrationTrades) {
      if (trade.returnPercent > 0) break;
      consecutiveLosses += 1;
      if (consecutiveLosses >= policy.adaptiveSizingMaximumLossStreak) break;
    }
  }
  const lossStreak = policy.adaptiveSizingLossStreakMultiplier ** consecutiveLosses;
  const currentDrawdownPercent = Math.max(
    0,
    (account.peakNavUsd - account.navUsd) / account.peakNavUsd * 100
  );
  const drawdown = clamp(
    1 - 0.75 * currentDrawdownPercent / policy.maximumDrawdownPercent,
    0.25,
    1
  );
  const maximumDeploymentUsd = account.navUsd * policy.maximumDeployedFraction;
  const exposureFraction = clamp(account.deployedUsd / maximumDeploymentUsd, 0, 1);
  const exposure = clamp(1 - 0.5 * exposureFraction, 0.5, 1);
  const strength = clamp(
    conviction ** 1.35 *
      calibrationMultiplier *
      rewardMultiplier *
      drawdown *
      exposure *
      lossStreak,
    0,
    1
  );
  const unroundedUsd = minimumUsd + (maximumAvailableUsd - minimumUsd) * strength;
  const sizeUsd = Math.max(minimumUsd, Math.min(maximumAvailableUsd, floorUsdCents(unroundedUsd)));

  const capBindings: Array<readonly [number, AutonomousPaperSizingBindingConstraint]> = [
    [capitalCaps.hardUsd, "HARD_USD_CAP"],
    [capitalCaps.policyUsd, "POLICY_POSITION_CAP"],
    [capitalCaps.navFractionUsd, "NAV_FRACTION_CAP"],
    [capitalCaps.reserveUsd, "CASH_RESERVE_CAP"],
    [capitalCaps.deploymentUsd, "DEPLOYMENT_CAP"],
    [capitalCaps.riskAtStopUsd, "RISK_AT_STOP_CAP"],
    [capitalCaps.developerClusterUsd, "DEVELOPER_CLUSTER_CAP"]
  ];
  const bindingConstraints = capBindings
    .filter(([value]) => Math.abs(value - maximumAvailableRaw) <= 1e-6)
    .map(([, code]) => code);
  if (Math.abs(sizeUsd - minimumUsd) <= 1e-9) {
    bindingConstraints.push("MINIMUM_SIZE_FLOOR");
  }
  const explanationCodes: AutonomousPaperSizingExplanationCode[] = [
    ...bindingConstraints,
    coldStart ? "COLD_START" : "EMPIRICAL_CALIBRATION",
    ...(!coldStart && rewardMultiplier > 1 ? ["POSITIVE_REWARD_SCALING" as const] : []),
    ...(!coldStart && rewardMultiplier < 1 ? ["NEGATIVE_REWARD_SCALING" as const] : []),
    ...(lossStreak < 1 ? ["LOSS_STREAK_REDUCTION" as const] : []),
    ...(drawdown < 1 ? ["DRAWDOWN_REDUCTION" as const] : []),
    ...(exposure < 1 ? ["EXPOSURE_REDUCTION" as const] : []),
    ...(input.quote && quoteQuality < 1 ? ["QUOTE_QUALITY_REDUCTION" as const] : []),
    ...(contextualReward.preQuoteUpperBound
      ? ["CONTEXTUAL_PREQUOTE_UPPER_BOUND" as const]
      : []),
    ...(policy.contextualRewardEnabled && input.quote && !contextualReward.active
      ? ["CONTEXTUAL_REWARD_COLD_START" as const]
      : []),
    ...(contextualReward.active ? ["CONTEXTUAL_REWARD_ACTIVE" as const] : []),
    ...(contextualReward.active && contextualReward.multiplier > 1
      ? ["CONTEXTUAL_REWARD_INCREASE" as const]
      : []),
    ...(contextualReward.active && contextualReward.multiplier < 1
      ? ["CONTEXTUAL_REWARD_REDUCTION" as const]
      : []),
    ...(sizeUsd + 1e-9 < unroundedUsd ? ["CENT_ROUNDING" as const] : [])
  ];
  const breakdown: AutonomousPaperSizingBreakdown = {
    version: policy.contextualRewardEnabled
      ? AUTONOMOUS_PAPER_SIZING_VERSION
      : AUTONOMOUS_PAPER_SIZING_V1_VERSION,
    minimumUsd,
    maximumAvailableUsd,
    unroundedUsd,
    sizeUsd,
    componentScores: {
      momentum,
      categoryRank,
      liquidityFlow,
      quoteQuality,
      conviction
    },
    calibration: {
      sampleCount,
      coldStart,
      winProbability,
      averageWinPercent,
      averageLossPercent,
      fullKelly,
      multiplier: calibrationMultiplier,
      averageReward,
      baseRewardMultiplier,
      rewardMultiplier
    },
    contextualReward,
    riskMultipliers: {
      currentDrawdownPercent,
      drawdown,
      exposureFraction,
      exposure,
      consecutiveLosses,
      lossStreak
    },
    capitalCaps,
    bindingConstraints: uniqueSizingCodes(bindingConstraints),
    explanationCodes: uniqueSizingCodes(explanationCodes)
  };
  return { allowed: true, sizeUsd, breakdown };
}

export function autonomousExitDecision(input: {
  position: AutonomousPaperPosition;
  snapshot: AutonomousPaperMarketSnapshot;
  staticSafetyEligible: boolean;
  now: Date;
  policy?: AutonomousPaperPolicy;
}): AutonomousExitResult {
  const policy = input.policy ?? DEFAULT_AUTONOMOUS_PAPER_POLICY;
  const { position, snapshot } = input;
  const currentReturn = position.remainingCostUsd > 0
    ? (position.lastExecutableValueUsd / position.remainingCostUsd - 1) * 100
    : 0;
  const peakReturn = position.remainingCostUsd > 0
    ? (position.peakExecutableValueUsd / position.remainingCostUsd - 1) * 100
    : 0;
  const peakDrawdown = position.peakExecutableValueUsd > 0
    ? (position.peakExecutableValueUsd - position.lastExecutableValueUsd) /
      position.peakExecutableValueUsd * 100
    : 0;
  const weak = snapshot.priceChange5mPercent <= -1 || snapshot.organicBuyShare5m < 0.45;
  const nextWeakMomentumSamples = weak ? position.weakMomentumSamples + 1 : 0;
  const ageMinutes = (input.now.getTime() - Date.parse(position.openedAt)) / 60_000;

  if (!input.staticSafetyEligible) return { exit: true, reason: "TOKEN_SAFETY", nextWeakMomentumSamples };
  if (currentReturn <= -policy.stopLossPercent) return { exit: true, reason: "STOP_LOSS", nextWeakMomentumSamples };
  if (currentReturn >= policy.takeProfitPercent) return { exit: true, reason: "TAKE_PROFIT", nextWeakMomentumSamples };
  if (peakReturn >= policy.trailingActivationPercent && peakDrawdown >= policy.trailingDrawdownPercent) {
    return { exit: true, reason: "TRAILING_STOP", nextWeakMomentumSamples };
  }
  if (peakReturn >= policy.breakEvenActivationPercent && currentReturn <= 0) {
    return { exit: true, reason: "BREAK_EVEN", nextWeakMomentumSamples };
  }
  if (nextWeakMomentumSamples >= policy.weakMomentumExitSamples) {
    return { exit: true, reason: "WEAK_MOMENTUM", nextWeakMomentumSamples };
  }
  if (ageMinutes >= policy.maximumHoldingMinutes) {
    return { exit: true, reason: "MAX_HOLD", nextWeakMomentumSamples };
  }
  if (ageMinutes >= policy.noProgressMinutes && peakReturn < 3) {
    return { exit: true, reason: "NO_PROGRESS", nextWeakMomentumSamples };
  }
  return { exit: false, nextWeakMomentumSamples };
}

export function autonomousDailyEntryPaused(
  account: AutonomousPaperAccount,
  dayStartNavUsd: number,
  policy: AutonomousPaperPolicy = DEFAULT_AUTONOMOUS_PAPER_POLICY
): boolean {
  return Number.isFinite(dayStartNavUsd) && dayStartNavUsd > 0 &&
    (dayStartNavUsd - account.navUsd) / dayStartNavUsd * 100 >= policy.dailyLossPausePercent;
}

export function autonomousDrawdownLocked(
  account: AutonomousPaperAccount,
  policy: AutonomousPaperPolicy = DEFAULT_AUTONOMOUS_PAPER_POLICY
): boolean {
  return account.pricingComplete && account.maxDrawdownPercent >= policy.maximumDrawdownPercent;
}
