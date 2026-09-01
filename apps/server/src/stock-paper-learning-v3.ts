import { createHash } from "node:crypto";
import type { AlpacaStockBar } from "@copylab/providers";
import type {
  StockPaperMarketFeed,
  StockPaperMarketPhase,
  StockPaperStrategyArm
} from "@copylab/shared";
import { STOCK_PAPER_BOOK_SHADOW_MANIFEST_DIGEST } from "./stock-paper-book-shadow-manifest.js";

/**
 * Analysis-only stock-learning primitives. Nothing in this module can place an
 * order, mutate a paper account, activate a model, or promote a strategy.
 */
export const STOCK_PAPER_LEARNING_V3_VERSION = "stock-paper-learning-v3" as const;
export const STOCK_PAPER_LEARNING_V3_FEATURE_VERSION = "stock-learning-features-v3" as const;
export const STOCK_PAPER_OUTCOME_HORIZONS = Object.freeze([15, 45, 180] as const);

export type StockPaperOutcomeHorizonMinutes = typeof STOCK_PAPER_OUTCOME_HORIZONS[number];
export type StockPaperOnlineSourceV3 = "MOST_ACTIVE" | "MOVER" | "NEWS";

export interface StockPaperLearningObservationV3 {
  readonly id: string;
  readonly evidenceDigest: string;
  readonly learnerVersion: typeof STOCK_PAPER_LEARNING_V3_VERSION;
  readonly featureVersion: typeof STOCK_PAPER_LEARNING_V3_FEATURE_VERSION;
  readonly laneId: string;
  readonly symbol: string;
  readonly arm: StockPaperStrategyArm;
  readonly phase: StockPaperMarketPhase;
  readonly feed: StockPaperMarketFeed;
  readonly policyVersion: string;
  readonly policyDigest: string;
  readonly tradeDayKey: string;
  readonly observedAt: string;
  readonly idempotencyBucket: string;
  readonly candidateRank: number;
  readonly candidateScore: number;
  readonly highConviction: boolean;
  readonly confirmationSamples: number;
  readonly entryPriceUsd: number;
  readonly entryNotionalUsd: number;
  readonly spreadPercent: number;
  readonly relativeVolume: number;
  readonly dollarVolumeUsd: number;
  readonly change1mPercent: number;
  readonly change5mPercent: number;
  readonly change15mPercent: number;
  readonly vwapDistancePercent: number;
  readonly sessionMinute: number;
  readonly onlineSources: readonly StockPaperOnlineSourceV3[];
  readonly newsArticleIds: readonly number[];
  readonly hardSafetyPassed: boolean;
}

export interface CreateStockPaperLearningObservationV3Input {
  readonly laneId: string;
  readonly symbol: string;
  readonly arm: StockPaperStrategyArm;
  readonly phase: StockPaperMarketPhase;
  readonly feed: StockPaperMarketFeed;
  readonly policyVersion: string;
  readonly policy: unknown;
  readonly tradeDayKey: string;
  readonly observedAt: string;
  readonly idempotencyBucket?: string;
  readonly candidateRank: number;
  readonly candidateScore: number;
  readonly highConviction: boolean;
  readonly confirmationSamples: number;
  readonly entryPriceUsd: number;
  readonly entryNotionalUsd: number;
  readonly spreadPercent: number;
  readonly relativeVolume: number;
  readonly dollarVolumeUsd: number;
  readonly change1mPercent: number;
  readonly change5mPercent: number;
  readonly change15mPercent: number;
  readonly vwapDistancePercent: number;
  readonly sessionMinute: number;
  readonly onlineSources?: readonly StockPaperOnlineSourceV3[];
  readonly newsArticleIds?: readonly number[];
  readonly hardSafetyPassed: boolean;
}

export interface StockPaperOutcomeCostPolicyV3 {
  readonly version: string;
  readonly entryFeeBps: number;
  readonly exitFeeBps: number;
  readonly exitPriceHaircutBps: number;
  readonly fixedRoundTripCostUsd: number;
}

export const DEFAULT_STOCK_PAPER_OUTCOME_COST_POLICY_V3: Readonly<StockPaperOutcomeCostPolicyV3> =
  Object.freeze({
    version: "stock-outcome-costs-v1",
    entryFeeBps: 0,
    exitFeeBps: 1,
    exitPriceHaircutBps: 15,
    fixedRoundTripCostUsd: 0
  });

export type StockPaperOutcomeMissingReasonV3 =
  | "HORIZON_NOT_DUE"
  | "NO_STRICTLY_FUTURE_BARS"
  | "INVALID_BAR"
  | "PATH_STARTS_LATE"
  | "PATH_GAP"
  | "HORIZON_NOT_COVERED";

export type StockPaperOutcomePathMetricsMissingReasonV3 =
  | "PATH_STARTS_LATE"
  | "PATH_GAP";

export interface StockPaperOutcomeLabelV3 {
  readonly id: string;
  readonly labelKey: string;
  readonly learnerVersion: typeof STOCK_PAPER_LEARNING_V3_VERSION;
  readonly observationId: string;
  readonly symbol: string;
  readonly horizonMinutes: StockPaperOutcomeHorizonMinutes;
  readonly horizonEndsAt: string;
  readonly labeledAt: string;
  readonly costPolicyDigest: string;
  readonly datasetEligible: boolean;
  /** Executable only under the explicit bar-close haircut and cost model. It
   * is not represented as a real quote or fill. */
  readonly modeledExecutable: boolean;
  readonly barBasedExecutionModel: true;
  readonly strictFutureBarsOnly: true;
  readonly missingDataReason?: StockPaperOutcomeMissingReasonV3;
  readonly barsUsed: number;
  readonly firstBarAt?: string;
  readonly lastBarAt?: string;
  readonly pathDigest?: string;
  readonly entryPriceUsd?: number;
  readonly exitReferencePriceUsd?: number;
  readonly exitExecutablePriceUsd?: number;
  readonly entryNotionalUsd?: number;
  readonly grossReturnPercent?: number;
  readonly netExecutableReturnPercent?: number;
  readonly maximumFavorableExcursionPercent?: number;
  readonly maximumAdverseExcursionPercent?: number;
  /** A terminal executable return can remain causal and usable even when an
   * interior bar gap makes dense-path excursion statistics unknowable. No
   * price is forward-filled: MFE/MAE stay absent and the exact reason is
   * recorded instead. */
  readonly pathMetricsMissingReason?: StockPaperOutcomePathMetricsMissingReasonV3;
  readonly totalModeledCostsUsd?: number;
}

export interface CalculateStockPaperOutcomeLabelV3Input {
  readonly observation: StockPaperLearningObservationV3;
  readonly horizonMinutes: StockPaperOutcomeHorizonMinutes;
  readonly bars: readonly AlpacaStockBar[];
  readonly labeledAt: string;
  readonly costPolicy?: StockPaperOutcomeCostPolicyV3;
  readonly maximumGapMinutes?: number;
  readonly maximumEndpointAgeMinutes?: number;
}

export interface StockPaperShadowPolicyV3 {
  readonly id: string;
  readonly minimumScore: number;
  readonly minimumRelativeVolume: number;
  readonly maximumSpreadPercent: number;
  readonly minimumConfirmationSamples: number;
  readonly highConvictionOnly: boolean;
  readonly additionalStressCostBps: number;
  /** Optional, pre-registered analysis constraints. They are evaluated only
   * in the shadow arena and can never become PAPER order rules through this
   * module. */
  readonly minimumDollarVolumeUsd?: number;
  readonly maximumAbsoluteVwapDistancePercent?: number;
  readonly maximumAbsoluteChange5mPercent?: number;
  readonly minimumChange1mPercent?: number;
  readonly maximumChange5mPercent?: number;
  readonly maximumVwapDistancePercent?: number;
  /** Connects a frozen policy to a provenance-backed research hypothesis. */
  readonly researchBasisId?: string;
  /** Invalidates persisted book-policy evidence whenever its public source identities,
   * hypothesis wording, locators, or research version changes. */
  readonly researchManifestDigest?: string;
}

export const FROZEN_STOCK_PAPER_SHADOW_POLICIES_V3: readonly StockPaperShadowPolicyV3[] =
  deepFreeze([
    {
      id: "STATIC_BASELINE",
      minimumScore: 62,
      minimumRelativeVolume: 1.15,
      maximumSpreadPercent: 1.25,
      minimumConfirmationSamples: 1,
      highConvictionOnly: false,
      additionalStressCostBps: 0
    },
    {
      id: "CONFIRMED_BALANCED",
      minimumScore: 68,
      minimumRelativeVolume: 1.35,
      maximumSpreadPercent: 0.8,
      minimumConfirmationSamples: 2,
      highConvictionOnly: false,
      additionalStressCostBps: 10
    },
    {
      id: "HIGH_CONVICTION_EXTENDED",
      minimumScore: 78,
      minimumRelativeVolume: 1.75,
      maximumSpreadPercent: 0.55,
      minimumConfirmationSamples: 2,
      highConvictionOnly: true,
      additionalStressCostBps: 20
    },
    {
      id: "TRIPLE_CONFIRMED",
      minimumScore: 72,
      minimumRelativeVolume: 1.5,
      maximumSpreadPercent: 0.7,
      minimumConfirmationSamples: 3,
      highConvictionOnly: false,
      additionalStressCostBps: 15
    },
    {
      id: "BOOK_DISCIPLINED_EXECUTION_PROXY",
      minimumScore: 70,
      minimumRelativeVolume: 1.4,
      maximumSpreadPercent: 0.65,
      minimumConfirmationSamples: 2,
      highConvictionOnly: false,
      additionalStressCostBps: 25,
      minimumDollarVolumeUsd: 25_000_000,
      maximumAbsoluteVwapDistancePercent: 2.5,
      maximumAbsoluteChange5mPercent: 6,
      researchBasisId: "EXECUTION_COST_DISCIPLINE",
      researchManifestDigest: STOCK_PAPER_BOOK_SHADOW_MANIFEST_DIGEST
    },
    {
      id: "BOOK_QUALITY_FIRST_LIQUIDITY_PROXY",
      minimumScore: 74,
      minimumRelativeVolume: 1.6,
      maximumSpreadPercent: 0.5,
      minimumConfirmationSamples: 2,
      highConvictionOnly: false,
      additionalStressCostBps: 30,
      minimumDollarVolumeUsd: 50_000_000,
      maximumAbsoluteVwapDistancePercent: 3,
      maximumAbsoluteChange5mPercent: 8,
      researchBasisId: "QUALITY_BEFORE_RANKING_PROXY",
      researchManifestDigest: STOCK_PAPER_BOOK_SHADOW_MANIFEST_DIGEST
    },
    {
      id: "BOOK_MEAN_REVERSION_RECLAIM_PROXY",
      minimumScore: 0,
      minimumRelativeVolume: 1,
      maximumSpreadPercent: 0.55,
      minimumConfirmationSamples: 1,
      highConvictionOnly: false,
      additionalStressCostBps: 30,
      minimumDollarVolumeUsd: 50_000_000,
      minimumChange1mPercent: 0.1,
      maximumChange5mPercent: -1,
      maximumVwapDistancePercent: -0.75,
      researchBasisId: "MEAN_REVERSION_RECLAIM_PROXY",
      researchManifestDigest: STOCK_PAPER_BOOK_SHADOW_MANIFEST_DIGEST
    }
  ] satisfies StockPaperShadowPolicyV3[]);

export interface StockPaperShadowPolicyResultV3 {
  readonly policyId: string;
  readonly policyDigest: string;
  readonly selectedPathCount: number;
  readonly scorablePathCount: number;
  readonly unscorablePathCount: number;
  readonly coveragePercent: number;
  readonly winningPathCount: number;
  readonly winRatePercent: number;
  readonly meanNetReturnPercent: number;
  readonly compoundedNetReturnPercent: number;
  readonly grossProfitPercent: number;
  readonly grossLossPercent: number;
  readonly profitFactor?: number;
  readonly maximumDrawdownPercent: number;
  readonly selectedObservationIds: readonly string[];
}

export interface StockPaperShadowArenaResultV3 {
  readonly learnerVersion: typeof STOCK_PAPER_LEARNING_V3_VERSION;
  readonly analysisOnly: true;
  readonly pathsAreIndependentTrades: false;
  readonly horizonMinutes: StockPaperOutcomeHorizonMinutes;
  readonly datasetDigest: string;
  readonly results: readonly StockPaperShadowPolicyResultV3[];
}

export interface EvaluateStockPaperShadowArenaV3Input {
  readonly observations: readonly StockPaperLearningObservationV3[];
  readonly outcomes: readonly StockPaperOutcomeLabelV3[];
  readonly horizonMinutes: StockPaperOutcomeHorizonMinutes;
  readonly policies?: readonly StockPaperShadowPolicyV3[];
}

export interface StockPaperWalkForwardGatesV3 {
  readonly minimumCompletedFolds: number;
  readonly minimumTrainingScorablePathsPerFold: number;
  readonly minimumHoldoutScorablePaths: number;
  readonly minimumHoldoutCoveragePercent: number;
  readonly minimumHoldoutDistinctSymbols: number;
  readonly minimumHoldoutDistinctTradeDays: number;
  readonly minimumHoldoutProfitFactor: number;
  readonly maximumHoldoutDrawdownPercent: number;
  readonly minimumHoldoutNetReturnPercent: number;
  readonly minimumExcessReturnVsBaselinePercent: number;
}

export const DEFAULT_STOCK_PAPER_WALK_FORWARD_GATES_V3: Readonly<StockPaperWalkForwardGatesV3> =
  Object.freeze({
    minimumCompletedFolds: 3,
    minimumTrainingScorablePathsPerFold: 20,
    minimumHoldoutScorablePaths: 30,
    minimumHoldoutCoveragePercent: 70,
    minimumHoldoutDistinctSymbols: 5,
    minimumHoldoutDistinctTradeDays: 5,
    minimumHoldoutProfitFactor: 1.1,
    maximumHoldoutDrawdownPercent: 20,
    minimumHoldoutNetReturnPercent: 0,
    minimumExcessReturnVsBaselinePercent: 0
  });

export type StockPaperWalkForwardGateReasonV3 =
  | "FOLDS_BELOW_MINIMUM"
  | "TRAINING_PATHS_BELOW_MINIMUM"
  | "HOLDOUT_PATHS_BELOW_MINIMUM"
  | "HOLDOUT_COVERAGE_BELOW_MINIMUM"
  | "HOLDOUT_SYMBOLS_BELOW_MINIMUM"
  | "HOLDOUT_TRADE_DAYS_BELOW_MINIMUM"
  | "HOLDOUT_NET_RETURN_NOT_POSITIVE"
  | "HOLDOUT_PROFIT_FACTOR_BELOW_MINIMUM"
  | "HOLDOUT_DRAWDOWN_ABOVE_MAXIMUM"
  | "HOLDOUT_UNDERPERFORMS_BASELINE";

export type StockPaperWalkForwardAnalysisStatusV3 =
  | "INSUFFICIENT_EVIDENCE"
  | "ANALYSIS_GATES_FAILED"
  | "ANALYSIS_GATES_PASSED";

export interface StockPaperWalkForwardFoldV3 {
  readonly fold: number;
  readonly trainingStartAt?: string;
  readonly trainingEndAt?: string;
  readonly testStartAt: string;
  readonly testEndAt: string;
  readonly embargoMinutes: number;
  readonly rawTrainingObservationCount: number;
  readonly purgedTrainingObservationCount: number;
  readonly testObservationCount: number;
  readonly training: StockPaperShadowArenaResultV3;
  readonly holdout: StockPaperShadowArenaResultV3;
}

export interface StockPaperWalkForwardPolicyAnalysisV3 {
  readonly policyId: string;
  readonly status: StockPaperWalkForwardAnalysisStatusV3;
  readonly passesAnalysisGates: boolean;
  readonly promotionEligible: false;
  readonly mayAffectTrading: false;
  readonly gateReasons: readonly StockPaperWalkForwardGateReasonV3[];
  readonly completedFolds: number;
  readonly minimumTrainingScorablePaths: number;
  readonly holdout: StockPaperShadowPolicyResultV3;
  readonly holdoutDistinctSymbols: number;
  readonly holdoutDistinctTradeDays: number;
  readonly excessReturnVsBaselinePercent: number;
}

export interface StockPaperWalkForwardEvaluationV3 {
  readonly learnerVersion: typeof STOCK_PAPER_LEARNING_V3_VERSION;
  readonly analysisOnly: true;
  readonly promotionEligible: false;
  readonly mayAffectTrading: false;
  readonly datasetDigest: string;
  readonly evaluationDigest: string;
  readonly baselinePolicyId: string;
  readonly horizonMinutes: StockPaperOutcomeHorizonMinutes;
  readonly embargoMinutes: number;
  readonly folds: readonly StockPaperWalkForwardFoldV3[];
  readonly policies: readonly StockPaperWalkForwardPolicyAnalysisV3[];
  readonly gates: Readonly<StockPaperWalkForwardGatesV3>;
}

export interface EvaluateStockPaperWalkForwardV3Input {
  readonly observations: readonly StockPaperLearningObservationV3[];
  readonly outcomes: readonly StockPaperOutcomeLabelV3[];
  readonly horizonMinutes: StockPaperOutcomeHorizonMinutes;
  readonly policies?: readonly StockPaperShadowPolicyV3[];
  readonly baselinePolicyId?: string;
  readonly foldCount?: number;
  readonly embargoMinutes?: number;
  readonly gates?: Partial<StockPaperWalkForwardGatesV3>;
}

function canonicalJson(value: unknown, ancestors = new Set<object>()): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Digest inputs must contain only finite numbers.");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value === "undefined") return "null";
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new TypeError("Digest inputs must not be cyclic.");
    ancestors.add(value);
    const encoded = `[${value.map((entry) => canonicalJson(entry, ancestors)).join(",")}]`;
    ancestors.delete(value);
    return encoded;
  }
  if (typeof value === "object") {
    if (ancestors.has(value)) throw new TypeError("Digest inputs must not be cyclic.");
    ancestors.add(value);
    const record = value as Record<string, unknown>;
    const encoded = `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key], ancestors)}`)
      .join(",")}}`;
    ancestors.delete(value);
    return encoded;
  }
  throw new TypeError("Digest inputs must be JSON-compatible.");
}

function sha256(namespace: string, value: unknown): string {
  return createHash("sha256")
    .update(`${namespace}\n${canonicalJson(value)}`)
    .digest("hex");
}

export function stockPaperShadowPolicyDigestV3(policy: StockPaperShadowPolicyV3): string {
  return `stock-shadow-policy-v3:${sha256("stock-shadow-policy-v3", policy)}`;
}

export function stockPaperShadowPolicySetDigestV3(
  policies: readonly StockPaperShadowPolicyV3[] = FROZEN_STOCK_PAPER_SHADOW_POLICIES_V3
): string {
  const policyDigests = [...policies]
    .map((policy) => ({ id: policy.id, digest: stockPaperShadowPolicyDigestV3(policy) }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return `stock-shadow-policy-set-v3:${sha256("stock-shadow-policy-set-v3", policyDigests)}`;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function finite(value: number, label: string, minimum?: number): number {
  if (!Number.isFinite(value) || (minimum !== undefined && value < minimum)) {
    throw new RangeError(`${label} must be a finite number${minimum !== undefined ? ` at least ${minimum}` : ""}.`);
  }
  return Object.is(value, -0) ? 0 : value;
}

function positive(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${label} must be positive.`);
  return value;
}

function integer(value: number, label: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RangeError(`${label} must be a safe integer at least ${minimum}.`);
  }
  return value;
}

function timestamp(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || !Number.isFinite(Date.parse(normalized))) {
    throw new Error(`${label} must be a valid timestamp.`);
  }
  return new Date(normalized).toISOString();
}

function freezeWithId<T extends Record<string, unknown>>(namespace: string, value: T): Readonly<T & { id: string }> {
  const id = `${namespace}:${sha256(namespace, value)}`;
  return deepFreeze({ id, ...value });
}

export function stockPaperPolicyDigestV3(policy: unknown): string {
  return `stock-policy-v3:${sha256("stock-policy-v3", policy)}`;
}

export function stockPaperDatasetDigestV3(input: {
  readonly observations: readonly StockPaperLearningObservationV3[];
  readonly outcomes: readonly StockPaperOutcomeLabelV3[];
}): string {
  const observations = [...input.observations]
    .sort((left, right) => left.id.localeCompare(right.id));
  const outcomes = [...input.outcomes]
    .sort((left, right) => left.id.localeCompare(right.id));
  return `stock-dataset-v3:${sha256("stock-dataset-v3", { observations, outcomes })}`;
}

export function stockPaperDatasetAtCutoffV3(input: {
  readonly observations: readonly StockPaperLearningObservationV3[];
  readonly outcomes: readonly StockPaperOutcomeLabelV3[];
  readonly cutoffAt: string;
}): {
  readonly observations: readonly StockPaperLearningObservationV3[];
  readonly outcomes: readonly StockPaperOutcomeLabelV3[];
} {
  const cutoffAt = timestamp(input.cutoffAt, "Stock learning cutoff");
  const observationRows = input.observations
    .filter((observation) => observation.observedAt <= cutoffAt)
    .sort((left, right) => left.observedAt.localeCompare(right.observedAt) || left.id.localeCompare(right.id));
  const observationIds = new Set(observationRows.map((observation) => observation.id));
  const outcomeRows = input.outcomes
    .filter((outcome) => observationIds.has(outcome.observationId))
    .filter((outcome) => outcome.horizonEndsAt <= cutoffAt && outcome.labeledAt <= cutoffAt)
    .sort((left, right) => left.labeledAt.localeCompare(right.labeledAt) || left.id.localeCompare(right.id));
  return deepFreeze({ observations: observationRows, outcomes: outcomeRows });
}

export function createStockPaperLearningObservationV3(
  input: CreateStockPaperLearningObservationV3Input
): StockPaperLearningObservationV3 {
  const laneId = input.laneId.trim();
  const symbol = input.symbol.trim().toUpperCase();
  const policyVersion = input.policyVersion.trim();
  if (!laneId) throw new Error("Stock observation laneId is required.");
  if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol)) throw new Error("Stock observation symbol is invalid.");
  if (!policyVersion) throw new Error("Stock observation policyVersion is required.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.tradeDayKey)) {
    throw new Error("Stock observation tradeDayKey must use YYYY-MM-DD.");
  }
  const onlineSources = [...new Set(input.onlineSources ?? [])].sort();
  const newsArticleIds = [...new Set(input.newsArticleIds ?? [])]
    .map((id) => integer(id, "Stock news article id", 1))
    .sort((left, right) => left - right);
  const evidence = {
    learnerVersion: STOCK_PAPER_LEARNING_V3_VERSION,
    featureVersion: STOCK_PAPER_LEARNING_V3_FEATURE_VERSION,
    laneId,
    symbol,
    arm: input.arm,
    phase: input.phase,
    feed: input.feed,
    policyVersion,
    policyDigest: stockPaperPolicyDigestV3(input.policy),
    tradeDayKey: input.tradeDayKey,
    observedAt: timestamp(input.observedAt, "Stock observation observedAt"),
    idempotencyBucket: timestamp(
      input.idempotencyBucket ?? input.observedAt,
      "Stock observation idempotency bucket"
    ),
    candidateRank: integer(input.candidateRank, "Stock candidate rank", 1),
    candidateScore: finite(input.candidateScore, "Stock candidate score", 0),
    highConviction: input.highConviction,
    confirmationSamples: integer(input.confirmationSamples, "Stock confirmation samples", 1),
    entryPriceUsd: positive(input.entryPriceUsd, "Stock entry price"),
    entryNotionalUsd: positive(input.entryNotionalUsd, "Stock entry notional"),
    spreadPercent: finite(input.spreadPercent, "Stock spread percent", 0),
    relativeVolume: finite(input.relativeVolume, "Stock relative volume", 0),
    dollarVolumeUsd: finite(input.dollarVolumeUsd, "Stock dollar volume", 0),
    change1mPercent: finite(input.change1mPercent, "Stock one-minute change"),
    change5mPercent: finite(input.change5mPercent, "Stock five-minute change"),
    change15mPercent: finite(input.change15mPercent, "Stock fifteen-minute change"),
    vwapDistancePercent: finite(input.vwapDistancePercent, "Stock VWAP distance"),
    sessionMinute: integer(input.sessionMinute, "Stock session minute", 0),
    onlineSources,
    newsArticleIds,
    hardSafetyPassed: (() => {
      if (typeof input.hardSafetyPassed !== "boolean") {
        throw new TypeError("Stock observation hard-safety evidence must be explicit.");
      }
      return input.hardSafetyPassed;
    })()
  } as const;
  const evidenceDigest = `stock-evidence-v3:${sha256("stock-evidence-v3", evidence)}`;
  const idEvidence = input.idempotencyBucket
    ? {
        laneId,
        symbol,
        phase: input.phase,
        feed: input.feed,
        policyVersion,
        tradeDayKey: input.tradeDayKey,
        idempotencyBucket: evidence.idempotencyBucket
      }
    : evidence;
  return deepFreeze({
    id: `stock-observation-v3:${sha256("stock-observation-v3", idEvidence)}`,
    evidenceDigest,
    ...evidence
  });
}

function validateCostPolicy(policy: StockPaperOutcomeCostPolicyV3): StockPaperOutcomeCostPolicyV3 {
  const version = policy.version.trim();
  if (!version) throw new Error("Stock outcome cost policy version is required.");
  return deepFreeze({
    version,
    entryFeeBps: finite(policy.entryFeeBps, "Entry fee bps", 0),
    exitFeeBps: finite(policy.exitFeeBps, "Exit fee bps", 0),
    exitPriceHaircutBps: finite(policy.exitPriceHaircutBps, "Exit haircut bps", 0),
    fixedRoundTripCostUsd: finite(policy.fixedRoundTripCostUsd, "Fixed round-trip cost", 0)
  });
}

export function stockPaperOutcomeCostPolicyDigestV3(
  policy: StockPaperOutcomeCostPolicyV3 = DEFAULT_STOCK_PAPER_OUTCOME_COST_POLICY_V3
): string {
  return `stock-cost-policy-v3:${sha256("stock-cost-policy-v3", validateCostPolicy(policy))}`;
}

function validBar(bar: AlpacaStockBar): boolean {
  const prices = [bar.open, bar.high, bar.low, bar.close, bar.vwap];
  return prices.every((value) => Number.isFinite(value) && value > 0) &&
    Number.isFinite(bar.volume) && bar.volume >= 0 &&
    Number.isFinite(bar.tradeCount) && bar.tradeCount >= 0 &&
    bar.high >= Math.max(bar.open, bar.close, bar.low) &&
    bar.low <= Math.min(bar.open, bar.close, bar.high);
}

function canonicalFutureBars(input: {
  bars: readonly AlpacaStockBar[];
  observedAtMs: number;
  horizonEndsAtMs: number;
}): { bars: AlpacaStockBar[]; invalid: boolean } {
  const candidates = input.bars
    .flatMap((bar): Array<{ bar: AlpacaStockBar; at: number }> => {
      const at = Date.parse(bar.timestamp);
      return Number.isFinite(at) && at > input.observedAtMs && at <= input.horizonEndsAtMs
        ? [{ bar: { ...bar, timestamp: new Date(at).toISOString() }, at }]
        : [];
    })
    .sort((left, right) => {
      const time = left.at - right.at;
      return time !== 0 ? time : canonicalJson(left.bar).localeCompare(canonicalJson(right.bar));
    });
  const bars: AlpacaStockBar[] = [];
  let invalid = false;
  let priorAt = Number.NaN;
  for (const candidate of candidates) {
    const { bar, at } = candidate;
    if (!validBar(bar)) invalid = true;
    if (at === priorAt) continue;
    priorAt = at;
    bars.push(bar);
  }
  return { bars, invalid };
}

function makeOutcomeLabel(
  value: Omit<StockPaperOutcomeLabelV3, "id">
): StockPaperOutcomeLabelV3 {
  return freezeWithId("stock-outcome-v3", value) as StockPaperOutcomeLabelV3;
}

function outcomeRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Stock outcome evidence must be an object.");
  }
  return value as Record<string, unknown>;
}

function outcomeString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value) throw new TypeError(`Stock outcome ${key} must be a string.`);
  return value;
}

function outcomeBoolean(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") throw new TypeError(`Stock outcome ${key} must be a boolean.`);
  return value;
}

function outcomeNumber(
  record: Record<string, unknown>,
  key: string,
  options: { minimum?: number; maximum?: number; integer?: boolean } = {}
): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`Stock outcome ${key} must be finite.`);
  }
  if (options.integer && !Number.isSafeInteger(value)) {
    throw new TypeError(`Stock outcome ${key} must be a safe integer.`);
  }
  if (options.minimum !== undefined && value < options.minimum) {
    throw new RangeError(`Stock outcome ${key} is below its minimum.`);
  }
  if (options.maximum !== undefined && value > options.maximum) {
    throw new RangeError(`Stock outcome ${key} is above its maximum.`);
  }
  return Object.is(value, -0) ? 0 : value;
}

function sameNumber(left: number, right: number): boolean {
  const scale = Math.max(1, Math.abs(left), Math.abs(right));
  return Math.abs(left - right) <= scale * 1e-12;
}

const OUTCOME_MISSING_REASONS = new Set<StockPaperOutcomeMissingReasonV3>([
  "HORIZON_NOT_DUE",
  "NO_STRICTLY_FUTURE_BARS",
  "INVALID_BAR",
  "PATH_STARTS_LATE",
  "PATH_GAP",
  "HORIZON_NOT_COVERED"
]);

const OUTCOME_PATH_METRICS_MISSING_REASONS =
  new Set<StockPaperOutcomePathMetricsMissingReasonV3>([
    "PATH_STARTS_LATE",
    "PATH_GAP"
  ]);

export interface ParseStockPaperOutcomeLabelV3Context {
  readonly observation?: StockPaperLearningObservationV3;
  readonly costPolicy?: StockPaperOutcomeCostPolicyV3;
}

/**
 * Reconstructs an outcome label from untrusted JSON. Exact canonical equality
 * rejects extra/missing fields, while the rebuilt id and label key prove that
 * the immutable evidence was not silently altered.
 */
export function parseStockPaperOutcomeLabelV3(
  value: unknown,
  context: ParseStockPaperOutcomeLabelV3Context = {}
): StockPaperOutcomeLabelV3 {
  const record = outcomeRecord(value);
  const id = outcomeString(record, "id");
  const learnerVersion = outcomeString(record, "learnerVersion");
  if (learnerVersion !== STOCK_PAPER_LEARNING_V3_VERSION) throw new Error("Stock outcome learner version is unsupported.");
  const observationId = outcomeString(record, "observationId");
  const symbol = outcomeString(record, "symbol").toUpperCase();
  if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol) || symbol !== record.symbol) {
    throw new Error("Stock outcome symbol is invalid.");
  }
  const horizonMinutes = outcomeNumber(record, "horizonMinutes", { integer: true }) as StockPaperOutcomeHorizonMinutes;
  if (!STOCK_PAPER_OUTCOME_HORIZONS.includes(horizonMinutes)) throw new Error("Stock outcome horizon is unsupported.");
  const horizonEndsAt = timestamp(outcomeString(record, "horizonEndsAt"), "Stock outcome horizon end");
  const labeledAt = timestamp(outcomeString(record, "labeledAt"), "Stock outcome labeledAt");
  const costPolicy = validateCostPolicy(context.costPolicy ?? DEFAULT_STOCK_PAPER_OUTCOME_COST_POLICY_V3);
  const costPolicyDigest = outcomeString(record, "costPolicyDigest");
  if (costPolicyDigest !== stockPaperOutcomeCostPolicyDigestV3(costPolicy)) {
    throw new Error("Stock outcome cost-policy digest did not match the declared model.");
  }
  const expectedLabelKey = `stock-label-key-v3:${sha256("stock-label-key-v3", {
    observationId,
    horizonMinutes,
    costPolicyDigest
  })}`;
  const labelKey = outcomeString(record, "labelKey");
  if (labelKey !== expectedLabelKey) throw new Error("Stock outcome label key did not verify.");
  if (outcomeBoolean(record, "barBasedExecutionModel") !== true ||
      outcomeBoolean(record, "strictFutureBarsOnly") !== true) {
    throw new Error("Stock outcome causality flags must be true.");
  }
  const datasetEligible = outcomeBoolean(record, "datasetEligible");
  const modeledExecutable = outcomeBoolean(record, "modeledExecutable");
  const barsUsed = outcomeNumber(record, "barsUsed", { minimum: 0, integer: true });
  const common = {
    labelKey,
    learnerVersion: STOCK_PAPER_LEARNING_V3_VERSION,
    observationId,
    symbol,
    horizonMinutes,
    horizonEndsAt,
    labeledAt,
    costPolicyDigest,
    barBasedExecutionModel: true as const,
    strictFutureBarsOnly: true as const
  };
  let payload: Omit<StockPaperOutcomeLabelV3, "id">;
  if (datasetEligible) {
    if (Date.parse(labeledAt) < Date.parse(horizonEndsAt)) {
      throw new Error("Eligible stock outcome was labeled before its horizon ended.");
    }
    if (!modeledExecutable || barsUsed < 1 || record.missingDataReason !== undefined) {
      throw new Error("Eligible stock outcomes require executable path evidence.");
    }
    const firstBarAt = timestamp(outcomeString(record, "firstBarAt"), "Stock outcome first bar");
    const lastBarAt = timestamp(outcomeString(record, "lastBarAt"), "Stock outcome last bar");
    if (Date.parse(firstBarAt) > Date.parse(lastBarAt) || Date.parse(lastBarAt) > Date.parse(horizonEndsAt)) {
      throw new Error("Stock outcome bar timestamps are inconsistent.");
    }
    const pathDigest = outcomeString(record, "pathDigest");
    if (!/^stock-path-v3:[0-9a-f]{64}$/.test(pathDigest)) throw new Error("Stock outcome path digest is invalid.");
    const entryPriceUsd = outcomeNumber(record, "entryPriceUsd", { minimum: Number.MIN_VALUE });
    const exitReferencePriceUsd = outcomeNumber(record, "exitReferencePriceUsd", { minimum: Number.MIN_VALUE });
    const exitExecutablePriceUsd = outcomeNumber(record, "exitExecutablePriceUsd", { minimum: Number.MIN_VALUE });
    const entryNotionalUsd = outcomeNumber(record, "entryNotionalUsd", { minimum: Number.MIN_VALUE });
    const grossReturnPercent = outcomeNumber(record, "grossReturnPercent");
    const netExecutableReturnPercent = outcomeNumber(record, "netExecutableReturnPercent");
    const pathMetricsMissingReason = record.pathMetricsMissingReason === undefined
      ? undefined
      : outcomeString(record, "pathMetricsMissingReason") as
        StockPaperOutcomePathMetricsMissingReasonV3;
    if (pathMetricsMissingReason !== undefined &&
        !OUTCOME_PATH_METRICS_MISSING_REASONS.has(pathMetricsMissingReason)) {
      throw new Error("Stock outcome path-metrics missing-data reason is invalid.");
    }
    const hasFavorableExcursion = record.maximumFavorableExcursionPercent !== undefined;
    const hasAdverseExcursion = record.maximumAdverseExcursionPercent !== undefined;
    if (hasFavorableExcursion !== hasAdverseExcursion) {
      throw new Error("Stock outcome path metrics must be present or absent together.");
    }
    if (pathMetricsMissingReason === undefined && !hasFavorableExcursion) {
      throw new Error("Eligible stock outcomes require dense-path metrics or an explicit gap reason.");
    }
    if (pathMetricsMissingReason !== undefined && hasFavorableExcursion) {
      throw new Error("A sparse stock outcome cannot claim dense-path excursion metrics.");
    }
    const maximumFavorableExcursionPercent = hasFavorableExcursion
      ? outcomeNumber(record, "maximumFavorableExcursionPercent", { minimum: 0 })
      : undefined;
    const maximumAdverseExcursionPercent = hasAdverseExcursion
      ? outcomeNumber(record, "maximumAdverseExcursionPercent", { maximum: 0 })
      : undefined;
    const totalModeledCostsUsd = outcomeNumber(record, "totalModeledCostsUsd", { minimum: 0 });
    const quantity = entryNotionalUsd / entryPriceUsd;
    const expectedExecutablePrice = exitReferencePriceUsd *
      (1 - Math.min(10_000, costPolicy.exitPriceHaircutBps) / 10_000);
    const executableExitValue = quantity * expectedExecutablePrice;
    const entryFee = entryNotionalUsd * costPolicy.entryFeeBps / 10_000;
    const exitFee = executableExitValue * costPolicy.exitFeeBps / 10_000;
    const expectedCosts = entryFee + exitFee +
      Math.max(0, quantity * exitReferencePriceUsd - executableExitValue) +
      costPolicy.fixedRoundTripCostUsd;
    const expectedGrossReturn = (exitReferencePriceUsd - entryPriceUsd) / entryPriceUsd * 100;
    const expectedNetReturn = (executableExitValue - entryNotionalUsd - entryFee - exitFee -
      costPolicy.fixedRoundTripCostUsd) / entryNotionalUsd * 100;
    if (!sameNumber(exitExecutablePriceUsd, expectedExecutablePrice) ||
        !sameNumber(grossReturnPercent, expectedGrossReturn) ||
        !sameNumber(netExecutableReturnPercent, expectedNetReturn) ||
        !sameNumber(totalModeledCostsUsd, expectedCosts)) {
      throw new Error("Stock outcome executable metrics did not recompute.");
    }
    payload = {
      ...common,
      datasetEligible: true,
      modeledExecutable: true,
      barsUsed,
      firstBarAt,
      lastBarAt,
      pathDigest,
      entryPriceUsd,
      exitReferencePriceUsd,
      exitExecutablePriceUsd,
      entryNotionalUsd,
      grossReturnPercent,
      netExecutableReturnPercent,
      ...(maximumFavorableExcursionPercent !== undefined
        ? { maximumFavorableExcursionPercent }
        : {}),
      ...(maximumAdverseExcursionPercent !== undefined
        ? { maximumAdverseExcursionPercent }
        : {}),
      ...(pathMetricsMissingReason ? { pathMetricsMissingReason } : {}),
      totalModeledCostsUsd
    };
  } else {
    if (modeledExecutable) throw new Error("Missing stock outcomes cannot be executable.");
    const missingDataReason = outcomeString(record, "missingDataReason") as StockPaperOutcomeMissingReasonV3;
    if (!OUTCOME_MISSING_REASONS.has(missingDataReason)) throw new Error("Stock outcome missing-data reason is invalid.");
    if (missingDataReason === "HORIZON_NOT_DUE" && Date.parse(labeledAt) >= Date.parse(horizonEndsAt)) {
      throw new Error("A not-due outcome must precede its horizon end.");
    }
    if (missingDataReason !== "HORIZON_NOT_DUE" && Date.parse(labeledAt) < Date.parse(horizonEndsAt)) {
      throw new Error("A completed missing outcome cannot precede its horizon end.");
    }
    const timeEvidence = barsUsed > 0
      ? {
          firstBarAt: timestamp(outcomeString(record, "firstBarAt"), "Stock outcome first bar"),
          lastBarAt: timestamp(outcomeString(record, "lastBarAt"), "Stock outcome last bar")
        }
      : {};
    if (barsUsed === 0 && (record.firstBarAt !== undefined || record.lastBarAt !== undefined)) {
      throw new Error("Empty stock outcome paths cannot claim bar timestamps.");
    }
    if (timeEvidence.firstBarAt && (
      Date.parse(timeEvidence.firstBarAt) > Date.parse(timeEvidence.lastBarAt!) ||
      Date.parse(timeEvidence.lastBarAt!) > Date.parse(horizonEndsAt)
    )) throw new Error("Stock outcome missing-path timestamps are inconsistent.");
    payload = {
      ...common,
      datasetEligible: false,
      modeledExecutable: false,
      missingDataReason,
      barsUsed,
      ...timeEvidence
    };
  }
  const rebuilt = makeOutcomeLabel(payload);
  if (rebuilt.id !== id || canonicalJson(rebuilt) !== canonicalJson(record)) {
    throw new Error("Stock outcome id or canonical evidence did not verify.");
  }
  const observation = context.observation;
  if (observation) {
    const expectedHorizonEnd = new Date(
      Date.parse(observation.observedAt) + horizonMinutes * 60_000
    ).toISOString();
    if (observation.id !== observationId || observation.symbol !== symbol || expectedHorizonEnd !== horizonEndsAt) {
      throw new Error("Stock outcome does not belong to its observation.");
    }
    if (rebuilt.firstBarAt && Date.parse(rebuilt.firstBarAt) <= Date.parse(observation.observedAt)) {
      throw new Error("Stock outcome path contains non-future evidence.");
    }
    if (rebuilt.datasetEligible && (
      !sameNumber(rebuilt.entryPriceUsd!, observation.entryPriceUsd) ||
      !sameNumber(rebuilt.entryNotionalUsd!, observation.entryNotionalUsd)
    )) throw new Error("Stock outcome entry evidence differs from its observation.");
  }
  return rebuilt;
}

export function calculateStockPaperOutcomeLabelV3(
  input: CalculateStockPaperOutcomeLabelV3Input
): StockPaperOutcomeLabelV3 {
  if (!STOCK_PAPER_OUTCOME_HORIZONS.includes(input.horizonMinutes)) {
    throw new RangeError("Stock outcome horizon must be 15, 45, or 180 minutes.");
  }
  const labeledAt = timestamp(input.labeledAt, "Stock outcome labeledAt");
  const observedAtMs = Date.parse(input.observation.observedAt);
  const horizonEndsAtMs = observedAtMs + input.horizonMinutes * 60_000;
  const horizonEndsAt = new Date(horizonEndsAtMs).toISOString();
  const costPolicy = validateCostPolicy(input.costPolicy ?? DEFAULT_STOCK_PAPER_OUTCOME_COST_POLICY_V3);
  const costPolicyDigest = stockPaperOutcomeCostPolicyDigestV3(costPolicy);
  const labelKey = `stock-label-key-v3:${sha256("stock-label-key-v3", {
    observationId: input.observation.id,
    horizonMinutes: input.horizonMinutes,
    costPolicyDigest
  })}`;
  const common = {
    labelKey,
    learnerVersion: STOCK_PAPER_LEARNING_V3_VERSION,
    observationId: input.observation.id,
    symbol: input.observation.symbol,
    horizonMinutes: input.horizonMinutes,
    horizonEndsAt,
    labeledAt,
    costPolicyDigest,
    barBasedExecutionModel: true as const,
    strictFutureBarsOnly: true as const
  };
  const missing = (
    reason: StockPaperOutcomeMissingReasonV3,
    bars: readonly AlpacaStockBar[] = []
  ): StockPaperOutcomeLabelV3 => makeOutcomeLabel({
    ...common,
    datasetEligible: false,
    modeledExecutable: false,
    missingDataReason: reason,
    barsUsed: bars.length,
    ...(bars[0] ? { firstBarAt: bars[0].timestamp } : {}),
    ...(bars.at(-1) ? { lastBarAt: bars.at(-1)!.timestamp } : {})
  });

  if (Date.parse(labeledAt) < horizonEndsAtMs) return missing("HORIZON_NOT_DUE");
  const path = canonicalFutureBars({ bars: input.bars, observedAtMs, horizonEndsAtMs });
  if (path.invalid) return missing("INVALID_BAR", path.bars);
  if (path.bars.length === 0) return missing("NO_STRICTLY_FUTURE_BARS");
  const maximumGapMs = finite(input.maximumGapMinutes ?? 2, "Maximum path gap minutes", 0) * 60_000;
  const endpointAgeMs = finite(
    input.maximumEndpointAgeMinutes ?? 2,
    "Maximum endpoint age minutes",
    0
  ) * 60_000;
  const firstAt = Date.parse(path.bars[0]!.timestamp);
  let pathMetricsMissingReason: StockPaperOutcomePathMetricsMissingReasonV3 | undefined;
  if (firstAt - observedAtMs > maximumGapMs) pathMetricsMissingReason = "PATH_STARTS_LATE";
  for (let index = 1; index < path.bars.length; index += 1) {
    const gap = Date.parse(path.bars[index]!.timestamp) - Date.parse(path.bars[index - 1]!.timestamp);
    if (gap > maximumGapMs && pathMetricsMissingReason === undefined) {
      pathMetricsMissingReason = "PATH_GAP";
    }
  }
  const last = path.bars.at(-1)!;
  if (horizonEndsAtMs - Date.parse(last.timestamp) > endpointAgeMs) {
    return missing("HORIZON_NOT_COVERED", path.bars);
  }

  const entryPriceUsd = input.observation.entryPriceUsd;
  const entryNotionalUsd = input.observation.entryNotionalUsd;
  const quantity = entryNotionalUsd / entryPriceUsd;
  const exitReferencePriceUsd = last.close;
  const exitExecutablePriceUsd = exitReferencePriceUsd *
    (1 - Math.min(10_000, costPolicy.exitPriceHaircutBps) / 10_000);
  const rawExitValueUsd = quantity * exitReferencePriceUsd;
  const executableExitValueUsd = quantity * exitExecutablePriceUsd;
  const entryFeeUsd = entryNotionalUsd * costPolicy.entryFeeBps / 10_000;
  const exitFeeUsd = executableExitValueUsd * costPolicy.exitFeeBps / 10_000;
  const haircutCostUsd = Math.max(0, rawExitValueUsd - executableExitValueUsd);
  const totalModeledCostsUsd = entryFeeUsd + exitFeeUsd + haircutCostUsd +
    costPolicy.fixedRoundTripCostUsd;
  const netPnlUsd = executableExitValueUsd - entryNotionalUsd - entryFeeUsd - exitFeeUsd -
    costPolicy.fixedRoundTripCostUsd;
  const grossReturnPercent = (exitReferencePriceUsd - entryPriceUsd) / entryPriceUsd * 100;
  const netExecutableReturnPercent = netPnlUsd / entryNotionalUsd * 100;
  const favorable = pathMetricsMissingReason === undefined
    ? Math.max(...path.bars.map((bar) => (bar.high - entryPriceUsd) / entryPriceUsd * 100))
    : undefined;
  const adverse = pathMetricsMissingReason === undefined
    ? Math.min(...path.bars.map((bar) => (bar.low - entryPriceUsd) / entryPriceUsd * 100))
    : undefined;
  const pathDigest = `stock-path-v3:${sha256("stock-path-v3", path.bars)}`;
  return makeOutcomeLabel({
    ...common,
    datasetEligible: true,
    modeledExecutable: true,
    barsUsed: path.bars.length,
    firstBarAt: path.bars[0]!.timestamp,
    lastBarAt: last.timestamp,
    pathDigest,
    entryPriceUsd,
    exitReferencePriceUsd,
    exitExecutablePriceUsd,
    entryNotionalUsd,
    grossReturnPercent,
    netExecutableReturnPercent,
    ...(favorable !== undefined
      ? { maximumFavorableExcursionPercent: Math.max(0, favorable) }
      : {}),
    ...(adverse !== undefined
      ? { maximumAdverseExcursionPercent: Math.min(0, adverse) }
      : {}),
    ...(pathMetricsMissingReason ? { pathMetricsMissingReason } : {}),
    totalModeledCostsUsd
  });
}

function policyMatchesObservation(
  policy: StockPaperShadowPolicyV3,
  observation: StockPaperLearningObservationV3
): boolean {
  return observation.hardSafetyPassed &&
    observation.candidateScore >= policy.minimumScore &&
    observation.relativeVolume >= policy.minimumRelativeVolume &&
    observation.spreadPercent <= policy.maximumSpreadPercent &&
    observation.confirmationSamples >= policy.minimumConfirmationSamples &&
    (policy.minimumDollarVolumeUsd === undefined ||
      observation.dollarVolumeUsd >= policy.minimumDollarVolumeUsd) &&
    (policy.maximumAbsoluteVwapDistancePercent === undefined ||
      Math.abs(observation.vwapDistancePercent) <= policy.maximumAbsoluteVwapDistancePercent) &&
    (policy.maximumAbsoluteChange5mPercent === undefined ||
      Math.abs(observation.change5mPercent) <= policy.maximumAbsoluteChange5mPercent) &&
    (policy.minimumChange1mPercent === undefined ||
      observation.change1mPercent >= policy.minimumChange1mPercent) &&
    (policy.maximumChange5mPercent === undefined ||
      observation.change5mPercent <= policy.maximumChange5mPercent) &&
    (policy.maximumVwapDistancePercent === undefined ||
      observation.vwapDistancePercent <= policy.maximumVwapDistancePercent) &&
    (!policy.highConvictionOnly || observation.highConviction);
}

function outcomeKey(observationId: string, horizon: StockPaperOutcomeHorizonMinutes): string {
  return `${observationId}:${horizon}`;
}

function canonicalOutcomeMap(
  outcomes: readonly StockPaperOutcomeLabelV3[],
  horizon: StockPaperOutcomeHorizonMinutes
): Map<string, StockPaperOutcomeLabelV3> {
  const grouped = new Map<string, StockPaperOutcomeLabelV3[]>();
  for (const outcome of outcomes) {
    if (outcome.horizonMinutes !== horizon) continue;
    const key = outcomeKey(outcome.observationId, horizon);
    const group = grouped.get(key) ?? [];
    group.push(outcome);
    grouped.set(key, group);
  }
  return new Map([...grouped].map(([key, values]) => [key, [...values].sort((left, right) =>
    Number(right.datasetEligible) - Number(left.datasetEligible) ||
    left.labeledAt.localeCompare(right.labeledAt) ||
    left.id.localeCompare(right.id)
  )[0]!]));
}

function compoundedReturnAndDrawdown(returns: readonly number[]): {
  compoundedReturnPercent: number;
  maximumDrawdownPercent: number;
} {
  let equity = 100;
  let peak = equity;
  let maximumDrawdownPercent = 0;
  for (const value of returns) {
    equity *= Math.max(0, 1 + value / 100);
    peak = Math.max(peak, equity);
    const drawdown = peak > 0 ? (peak - equity) / peak * 100 : 0;
    maximumDrawdownPercent = Math.max(maximumDrawdownPercent, drawdown);
  }
  return { compoundedReturnPercent: equity - 100, maximumDrawdownPercent };
}

function evaluatePolicy(input: {
  policy: StockPaperShadowPolicyV3;
  observations: readonly StockPaperLearningObservationV3[];
  outcomeByObservation: ReadonlyMap<string, StockPaperOutcomeLabelV3>;
  horizon: StockPaperOutcomeHorizonMinutes;
}): StockPaperShadowPolicyResultV3 {
  const selected = [...input.observations]
    .filter((observation) => policyMatchesObservation(input.policy, observation))
    .sort((left, right) => left.observedAt.localeCompare(right.observedAt) || left.id.localeCompare(right.id));
  const returns = selected.flatMap((observation): number[] => {
    const outcome = input.outcomeByObservation.get(outcomeKey(observation.id, input.horizon));
    return outcome?.datasetEligible && outcome.netExecutableReturnPercent !== undefined
      ? [outcome.netExecutableReturnPercent - input.policy.additionalStressCostBps / 100]
      : [];
  });
  const grossProfitPercent = returns.reduce((sum, value) => sum + Math.max(0, value), 0);
  const grossLossPercent = returns.reduce((sum, value) => sum + Math.max(0, -value), 0);
  const curve = compoundedReturnAndDrawdown(returns);
  const result: StockPaperShadowPolicyResultV3 = {
    policyId: input.policy.id,
    policyDigest: stockPaperShadowPolicyDigestV3(input.policy),
    selectedPathCount: selected.length,
    scorablePathCount: returns.length,
    unscorablePathCount: selected.length - returns.length,
    coveragePercent: selected.length > 0 ? returns.length / selected.length * 100 : 0,
    winningPathCount: returns.filter((value) => value > 0).length,
    winRatePercent: returns.length > 0 ? returns.filter((value) => value > 0).length / returns.length * 100 : 0,
    meanNetReturnPercent: returns.length > 0
      ? returns.reduce((sum, value) => sum + value, 0) / returns.length
      : 0,
    compoundedNetReturnPercent: curve.compoundedReturnPercent,
    grossProfitPercent,
    grossLossPercent,
    ...(grossLossPercent > 0 ? { profitFactor: grossProfitPercent / grossLossPercent } : {}),
    maximumDrawdownPercent: curve.maximumDrawdownPercent,
    selectedObservationIds: selected.map((observation) => observation.id)
  };
  return deepFreeze(result);
}

export function evaluateStockPaperShadowArenaV3(
  input: EvaluateStockPaperShadowArenaV3Input
): StockPaperShadowArenaResultV3 {
  const policies = input.policies ?? FROZEN_STOCK_PAPER_SHADOW_POLICIES_V3;
  if (policies.length === 0) throw new Error("The stock shadow arena needs at least one frozen policy.");
  const outcomeByObservation = canonicalOutcomeMap(input.outcomes, input.horizonMinutes);
  return deepFreeze({
    learnerVersion: STOCK_PAPER_LEARNING_V3_VERSION,
    analysisOnly: true as const,
    pathsAreIndependentTrades: false as const,
    horizonMinutes: input.horizonMinutes,
    datasetDigest: stockPaperDatasetDigestV3(input),
    results: policies.map((policy) => evaluatePolicy({
      policy,
      observations: input.observations,
      outcomeByObservation,
      horizon: input.horizonMinutes
    }))
  });
}

function outcomesFor(
  observationIds: ReadonlySet<string>,
  outcomes: readonly StockPaperOutcomeLabelV3[]
): StockPaperOutcomeLabelV3[] {
  return outcomes.filter((outcome) => observationIds.has(outcome.observationId));
}

function metricPassesProfitFactor(result: StockPaperShadowPolicyResultV3, minimum: number): boolean {
  if (result.grossLossPercent <= 0) return result.grossProfitPercent > 0;
  return (result.profitFactor ?? 0) >= minimum;
}

export function stockPaperEvaluationDigestV3(input: {
  readonly datasetDigest: string;
  readonly horizonMinutes: StockPaperOutcomeHorizonMinutes;
  readonly policies: readonly StockPaperShadowPolicyV3[];
  readonly baselinePolicyId: string;
  readonly foldCount: number;
  readonly embargoMinutes: number;
  readonly gates: Readonly<StockPaperWalkForwardGatesV3>;
}): string {
  const policies = [...input.policies]
    .map((policy) => ({ id: policy.id, digest: stockPaperShadowPolicyDigestV3(policy) }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return `stock-evaluation-v3:${sha256("stock-evaluation-v3", {
    learnerVersion: STOCK_PAPER_LEARNING_V3_VERSION,
    datasetDigest: input.datasetDigest,
    horizonMinutes: input.horizonMinutes,
    policies,
    baselinePolicyId: input.baselinePolicyId,
    foldCount: input.foldCount,
    embargoMinutes: input.embargoMinutes,
    gates: input.gates
  })}`;
}

export function evaluateStockPaperWalkForwardV3(
  input: EvaluateStockPaperWalkForwardV3Input
): StockPaperWalkForwardEvaluationV3 {
  const policies = input.policies ?? FROZEN_STOCK_PAPER_SHADOW_POLICIES_V3;
  if (policies.length === 0) throw new Error("Walk-forward evaluation needs at least one frozen policy.");
  const policyIds = new Set(policies.map((policy) => policy.id));
  if (policyIds.size !== policies.length) throw new Error("Walk-forward policy ids must be unique.");
  const baselinePolicyId = input.baselinePolicyId ?? policies[0]!.id;
  if (!policyIds.has(baselinePolicyId)) throw new Error("Walk-forward baseline policy was not provided.");
  const foldCount = integer(input.foldCount ?? 3, "Walk-forward fold count", 1);
  const embargoMinutes = Math.max(
    input.horizonMinutes,
    finite(input.embargoMinutes ?? 180, "Walk-forward embargo minutes", 0)
  );
  const gates: StockPaperWalkForwardGatesV3 = deepFreeze({
    minimumCompletedFolds: integer(
      input.gates?.minimumCompletedFolds ?? DEFAULT_STOCK_PAPER_WALK_FORWARD_GATES_V3.minimumCompletedFolds,
      "Minimum completed folds",
      1
    ),
    minimumTrainingScorablePathsPerFold: integer(
      input.gates?.minimumTrainingScorablePathsPerFold ??
        DEFAULT_STOCK_PAPER_WALK_FORWARD_GATES_V3.minimumTrainingScorablePathsPerFold,
      "Minimum training paths",
      0
    ),
    minimumHoldoutScorablePaths: integer(
      input.gates?.minimumHoldoutScorablePaths ??
        DEFAULT_STOCK_PAPER_WALK_FORWARD_GATES_V3.minimumHoldoutScorablePaths,
      "Minimum holdout paths",
      0
    ),
    minimumHoldoutCoveragePercent: finite(
      input.gates?.minimumHoldoutCoveragePercent ??
        DEFAULT_STOCK_PAPER_WALK_FORWARD_GATES_V3.minimumHoldoutCoveragePercent,
      "Minimum holdout coverage",
      0
    ),
    minimumHoldoutDistinctSymbols: integer(
      input.gates?.minimumHoldoutDistinctSymbols ??
        DEFAULT_STOCK_PAPER_WALK_FORWARD_GATES_V3.minimumHoldoutDistinctSymbols,
      "Minimum holdout symbols",
      1
    ),
    minimumHoldoutDistinctTradeDays: integer(
      input.gates?.minimumHoldoutDistinctTradeDays ??
        DEFAULT_STOCK_PAPER_WALK_FORWARD_GATES_V3.minimumHoldoutDistinctTradeDays,
      "Minimum holdout trade days",
      1
    ),
    minimumHoldoutProfitFactor: finite(
      input.gates?.minimumHoldoutProfitFactor ??
        DEFAULT_STOCK_PAPER_WALK_FORWARD_GATES_V3.minimumHoldoutProfitFactor,
      "Minimum holdout profit factor",
      0
    ),
    maximumHoldoutDrawdownPercent: finite(
      input.gates?.maximumHoldoutDrawdownPercent ??
        DEFAULT_STOCK_PAPER_WALK_FORWARD_GATES_V3.maximumHoldoutDrawdownPercent,
      "Maximum holdout drawdown",
      0
    ),
    minimumHoldoutNetReturnPercent: finite(
      input.gates?.minimumHoldoutNetReturnPercent ??
        DEFAULT_STOCK_PAPER_WALK_FORWARD_GATES_V3.minimumHoldoutNetReturnPercent,
      "Minimum holdout return"
    ),
    minimumExcessReturnVsBaselinePercent: finite(
      input.gates?.minimumExcessReturnVsBaselinePercent ??
        DEFAULT_STOCK_PAPER_WALK_FORWARD_GATES_V3.minimumExcessReturnVsBaselinePercent,
      "Minimum excess return"
    )
  });
  if (gates.minimumHoldoutCoveragePercent > 100) throw new RangeError("Minimum holdout coverage cannot exceed 100%.");
  const datasetDigest = stockPaperDatasetDigestV3(input);
  const evaluationDigest = stockPaperEvaluationDigestV3({
    datasetDigest,
    horizonMinutes: input.horizonMinutes,
    policies,
    baselinePolicyId,
    foldCount,
    embargoMinutes,
    gates
  });
  const ordered = [...new Map(input.observations.map((observation) => [observation.id, observation])).values()]
    .sort((left, right) => left.observedAt.localeCompare(right.observedAt) || left.id.localeCompare(right.id));
  // Split only on whole trading-day groups. Row-index folds can place highly
  // correlated observations from the same session on both sides of a holdout.
  const tradeDays = [...new Set(ordered.map((observation) => observation.tradeDayKey))];
  const foldWidth = Math.max(1, Math.floor(tradeDays.length / (foldCount + 1)));
  const folds: StockPaperWalkForwardFoldV3[] = [];
  const aggregateHoldoutIds = new Set<string>();
  for (let fold = 0; fold < foldCount; fold += 1) {
    const testStartIndex = Math.min(tradeDays.length, (fold + 1) * foldWidth);
    const testEndIndex = fold === foldCount - 1
      ? tradeDays.length
      : Math.min(tradeDays.length, testStartIndex + foldWidth);
    const testDaySet = new Set(tradeDays.slice(testStartIndex, testEndIndex));
    const trainingDaySet = new Set(tradeDays.slice(0, testStartIndex));
    const test = ordered.filter((observation) => testDaySet.has(observation.tradeDayKey));
    if (test.length === 0) continue;
    for (const observation of test) aggregateHoldoutIds.add(observation.id);
    const testStartAt = test[0]!.observedAt;
    const embargoCutoffMs = Date.parse(testStartAt) - embargoMinutes * 60_000;
    const testSymbols = new Set(test.map((observation) => observation.symbol));
    const testTradeDays = new Set(test.map((observation) => observation.tradeDayKey));
    const rawTraining = ordered.filter((observation) => trainingDaySet.has(observation.tradeDayKey));
    const training = rawTraining.filter((observation) => {
      const horizonEnd = Date.parse(observation.observedAt) + input.horizonMinutes * 60_000;
      return horizonEnd <= embargoCutoffMs &&
        !testSymbols.has(observation.symbol) &&
        !testTradeDays.has(observation.tradeDayKey);
    });
    const trainingIds = new Set(training.map((observation) => observation.id));
    const testIds = new Set(test.map((observation) => observation.id));
    folds.push(deepFreeze({
      fold,
      ...(training[0] ? { trainingStartAt: training[0].observedAt } : {}),
      ...(training.at(-1) ? { trainingEndAt: training.at(-1)!.observedAt } : {}),
      testStartAt,
      testEndAt: test.at(-1)!.observedAt,
      embargoMinutes,
      rawTrainingObservationCount: rawTraining.length,
      purgedTrainingObservationCount: training.length,
      testObservationCount: test.length,
      training: evaluateStockPaperShadowArenaV3({
        observations: training,
        outcomes: outcomesFor(trainingIds, input.outcomes).filter((outcome) =>
          Date.parse(outcome.horizonEndsAt) <= embargoCutoffMs &&
          Date.parse(outcome.labeledAt) <= embargoCutoffMs
        ),
        horizonMinutes: input.horizonMinutes,
        policies
      }),
      holdout: evaluateStockPaperShadowArenaV3({
        observations: test,
        outcomes: outcomesFor(testIds, input.outcomes),
        horizonMinutes: input.horizonMinutes,
        policies
      })
    }));
  }

  const uniqueHoldout = ordered.filter((observation) => aggregateHoldoutIds.has(observation.id));
  const holdoutIds = new Set(uniqueHoldout.map((observation) => observation.id));
  const aggregate = evaluateStockPaperShadowArenaV3({
    observations: uniqueHoldout,
    outcomes: outcomesFor(holdoutIds, input.outcomes),
    horizonMinutes: input.horizonMinutes,
    policies
  });
  const eligibleHoldoutOutcomeIds = new Set(
    input.outcomes
      .filter((outcome) => outcome.horizonMinutes === input.horizonMinutes && outcome.datasetEligible)
      .map((outcome) => outcome.observationId)
  );
  const holdoutObservationById = new Map(uniqueHoldout.map((observation) => [observation.id, observation]));
  const baseline = aggregate.results.find((result) => result.policyId === baselinePolicyId)!;
  const analyses = policies.map((policy): StockPaperWalkForwardPolicyAnalysisV3 => {
    const holdout = aggregate.results.find((result) => result.policyId === policy.id)!;
    const trainingCounts = folds.map((fold) =>
      fold.training.results.find((result) => result.policyId === policy.id)?.scorablePathCount ?? 0
    );
    const minimumTrainingScorablePaths = trainingCounts.length > 0 ? Math.min(...trainingCounts) : 0;
    const excessReturnVsBaselinePercent = holdout.compoundedNetReturnPercent -
      baseline.compoundedNetReturnPercent;
    const scorableHoldoutObservations = holdout.selectedObservationIds.flatMap((id) => {
      const observation = holdoutObservationById.get(id);
      return observation && eligibleHoldoutOutcomeIds.has(id) ? [observation] : [];
    });
    const holdoutDistinctSymbols = new Set(
      scorableHoldoutObservations.map((observation) => observation.symbol)
    ).size;
    const holdoutDistinctTradeDays = new Set(
      scorableHoldoutObservations.map((observation) => observation.tradeDayKey)
    ).size;
    const gateReasons: StockPaperWalkForwardGateReasonV3[] = [];
    if (folds.length < gates.minimumCompletedFolds) gateReasons.push("FOLDS_BELOW_MINIMUM");
    if (minimumTrainingScorablePaths < gates.minimumTrainingScorablePathsPerFold) {
      gateReasons.push("TRAINING_PATHS_BELOW_MINIMUM");
    }
    if (holdout.scorablePathCount < gates.minimumHoldoutScorablePaths) {
      gateReasons.push("HOLDOUT_PATHS_BELOW_MINIMUM");
    }
    if (holdout.coveragePercent < gates.minimumHoldoutCoveragePercent) {
      gateReasons.push("HOLDOUT_COVERAGE_BELOW_MINIMUM");
    }
    if (holdoutDistinctSymbols < gates.minimumHoldoutDistinctSymbols) {
      gateReasons.push("HOLDOUT_SYMBOLS_BELOW_MINIMUM");
    }
    if (holdoutDistinctTradeDays < gates.minimumHoldoutDistinctTradeDays) {
      gateReasons.push("HOLDOUT_TRADE_DAYS_BELOW_MINIMUM");
    }
    if (holdout.compoundedNetReturnPercent <= gates.minimumHoldoutNetReturnPercent) {
      gateReasons.push("HOLDOUT_NET_RETURN_NOT_POSITIVE");
    }
    if (!metricPassesProfitFactor(holdout, gates.minimumHoldoutProfitFactor)) {
      gateReasons.push("HOLDOUT_PROFIT_FACTOR_BELOW_MINIMUM");
    }
    if (holdout.maximumDrawdownPercent > gates.maximumHoldoutDrawdownPercent) {
      gateReasons.push("HOLDOUT_DRAWDOWN_ABOVE_MAXIMUM");
    }
    if (
      policy.id !== baselinePolicyId &&
      excessReturnVsBaselinePercent < gates.minimumExcessReturnVsBaselinePercent
    ) {
      gateReasons.push("HOLDOUT_UNDERPERFORMS_BASELINE");
    }
    const evidenceReasons = new Set<StockPaperWalkForwardGateReasonV3>([
      "FOLDS_BELOW_MINIMUM",
      "TRAINING_PATHS_BELOW_MINIMUM",
      "HOLDOUT_PATHS_BELOW_MINIMUM",
      "HOLDOUT_COVERAGE_BELOW_MINIMUM",
      "HOLDOUT_SYMBOLS_BELOW_MINIMUM",
      "HOLDOUT_TRADE_DAYS_BELOW_MINIMUM"
    ]);
    const insufficient = gateReasons.some((reason) => evidenceReasons.has(reason));
    return deepFreeze({
      policyId: policy.id,
      status: insufficient
        ? "INSUFFICIENT_EVIDENCE"
        : gateReasons.length > 0 ? "ANALYSIS_GATES_FAILED" : "ANALYSIS_GATES_PASSED",
      passesAnalysisGates: gateReasons.length === 0,
      promotionEligible: false as const,
      mayAffectTrading: false as const,
      gateReasons,
      completedFolds: folds.length,
      minimumTrainingScorablePaths,
      holdout,
      holdoutDistinctSymbols,
      holdoutDistinctTradeDays,
      excessReturnVsBaselinePercent
    });
  });
  return deepFreeze({
    learnerVersion: STOCK_PAPER_LEARNING_V3_VERSION,
    analysisOnly: true as const,
    promotionEligible: false as const,
    mayAffectTrading: false as const,
    datasetDigest,
    evaluationDigest,
    baselinePolicyId,
    horizonMinutes: input.horizonMinutes,
    embargoMinutes,
    folds,
    policies: analyses,
    gates
  });
}
