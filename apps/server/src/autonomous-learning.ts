import { createHash } from "node:crypto";
import {
  AUTONOMOUS_LEARNING_FEATURE_VERSION,
  SOL_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  USDC_MINT,
  type AutonomousLearningOverview,
  type AutonomousPaperLane,
  type AutonomousPaperStrategyArm,
  type ChampionPromotionDecision,
  type LearningFeatureVector,
  type LearningAdmissionDecision,
  type LearningPathObservation,
  type MarketRegime,
  type ModelArtifact,
  type OutcomeLabel,
  type PolicyChallenger,
  type QuoteRequest,
  type QuoteSnapshot,
  type ShadowEpisode,
  type StrategyArmScore,
  type TradeAttribution,
  type WalkForwardResult
} from "@copylab/shared";
import type {
  JupiterMarketTokenSnapshot,
  JupiterMarketUniverseSnapshot
} from "@copylab/providers";
import type { Repository } from "./repository.js";
import { AutonomousLearningRepository, LEARNING_SCHEMA_VERSION } from "./learning-database.js";
import {
  AUTONOMOUS_MODEL_MINIMUM_PATHS,
  AUTONOMOUS_MODEL_REQUIRED_ARTIFACTS,
  AUTONOMOUS_SEGMENT_MINIMUM_PATHS,
  predictLearningModel,
  trainDeterministicModels
} from "./autonomous-learning-model.js";
import {
  AUTONOMOUS_PAPER_POLICY_VERSION,
  AUTONOMOUS_PAPER_V12_POLICY_VERSION
} from "./autonomous-paper-policy.js";

const REFERENCE_INPUT_USD = 20;
const USDC_DECIMALS = 6;
const LAMPORTS_PER_SOL = 1_000_000_000;
const MAXIMUM_OPEN_EPISODES = 120;
const MAXIMUM_NEW_EPISODES_PER_SCAN = 12;
const V12_MAXIMUM_EPISODES_PER_MINT_DAY = 2;
const V13_MAXIMUM_EPISODES_PER_MINT_DAY = 1;
const PROVIDER_WORK_BUDGET_FRACTION = 0.4 as const;
const PROVIDER_WORK_UNITS_PER_RUN = Math.floor(MAXIMUM_OPEN_EPISODES * PROVIDER_WORK_BUDGET_FRACTION);
const OUTCOME_HORIZONS = Object.freeze([15, 45, 180] as const);
const MAXIMUM_QUOTE_AGE_MS = 10_000;
const MAXIMUM_TRAINABLE_PRICE_IMPACT_PERCENT = 3;
const MAXIMUM_TRAINABLE_ROUND_TRIP_COST_PERCENT = 5;
const NIGHTLY_TRAINING_HOUR_UTC = 3;
const EVENT_TRAINING_45M_LABELS = 10;
const EVENT_TRAINING_180M_LABELS = 5;
const EVENT_TRAINING_DEBOUNCE_MS = 30 * 60_000;
const MINIMUM_SEGMENT_45M_PATHS = 30;
const MINIMUM_SEGMENT_180M_PATHS = 20;
const MINIMUM_SEGMENT_DAYS = 5;
const MINIMUM_SEGMENT_MINTS = 10;
const MAXIMUM_SEGMENT_MINT_SHARE = 0.2;
const MAXIMUM_SEGMENT_DAY_SHARE = 0.35;
const MINIMUM_SEGMENT_PROFIT_FACTOR = 1.2;
const PATH_OBSERVATION_INTERVAL_MINUTES = 5;
const MAXIMUM_DENSE_PATH_GAP_MINUTES = 12;
const MAXIMUM_ENTRY_QUOTE_ATTEMPTS = 3;
const ENTRY_QUOTE_RETRY_BASE_MS = 60_000;
const NEGATIVE_CONTROLS_PER_SCAN = 2;
const SIMULATION_ARENA_VERSION = "shadow-simulation-arena-v1" as const;
const SIMULATION_MINIMUM_BUY_5M = Object.freeze([0.5, 0.55, 0.6] as const);
const SIMULATION_MINIMUM_BUY_1H = Object.freeze([0.48, 0.52, 0.56] as const);
const SIMULATION_MINIMUM_ACCELERATION = Object.freeze([0.05, 0.1, 0.25, 0.5] as const);
const SIMULATION_MAXIMUM_COST = Object.freeze([0.5, 0.75, 1] as const);
const SIMULATION_STOP_LOSSES = Object.freeze([8, 10, 12] as const);
const SIMULATION_TAKE_PROFITS = Object.freeze([3, 4, 6, 8, 12, 18] as const);
const SIMULATION_MAXIMUM_HOLDS = Object.freeze([45, 90, 120, 180] as const);
const SIMULATION_ARENA_POLICY_COUNT =
  SIMULATION_MINIMUM_BUY_5M.length *
  SIMULATION_MINIMUM_BUY_1H.length *
  SIMULATION_MINIMUM_ACCELERATION.length *
  SIMULATION_MAXIMUM_COST.length *
  SIMULATION_STOP_LOSSES.length *
  SIMULATION_TAKE_PROFITS.length *
  SIMULATION_MAXIMUM_HOLDS.length;

interface UniverseCapturePayload {
  sourceKey: string;
  laneId: string;
  policyVersion: string;
  capturedAt: string;
  regime: MarketRegime;
  candidateCount: number;
  episodes: ShadowEpisode[];
}

export interface AutonomousLearningOptions {
  quote: (request: QuoteRequest) => Promise<QuoteSnapshot>;
  lookupMints: (mints: readonly string[]) => Promise<JupiterMarketTokenSnapshot[]>;
  solPriceUsd: () => number;
  now?: () => Date;
  walletConfirmed?: (mint: string, capturedAt: string) => boolean;
  onUpdate?: (data: { outcome: string; episodeId?: string; mint?: string }) => void;
  onError?: (error: Error) => void;
}

export interface LearningUniverseInput {
  lane: AutonomousPaperLane;
  universe: JupiterMarketUniverseSnapshot;
  tokens: readonly JupiterMarketTokenSnapshot[];
  sol?: JupiterMarketTokenSnapshot;
}

export interface AutonomousLearningCandidateStrategy {
  arm: AutonomousPaperStrategyArm;
  shadowOnly: boolean;
  heuristicScore: number;
  regime: MarketRegime;
  modelAllowed: boolean;
  modelHighConviction: boolean;
  modelReasonCodes: string[];
  admission: LearningAdmissionDecision;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function stableId(prefix: string, value: unknown): string {
  return `${prefix}:${digest(value)}`;
}

function finite(value: number | undefined, fallback = -1): number {
  return value !== undefined && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function median(values: readonly number[]): number {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (sorted.length === 0) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
}

function standardDeviation(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1));
}

function clusteredConfidenceBound(
  rows: ReadonlyArray<{ episode: ShadowEpisode; label: OutcomeLabel }>,
  value: (label: OutcomeLabel) => number,
  side: "LOWER" | "UPPER"
): number {
  if (rows.length === 0) return side === "LOWER" ? -1 : 1;
  const values = rows.map(({ label }) => value(label));
  const mean = values.reduce((sum, candidate) => sum + candidate, 0) / values.length;
  if (rows.length < 2) {
    const margin = 2 * Math.max(Math.abs(mean), 0.000001);
    return side === "LOWER" ? mean - margin : mean + margin;
  }
  const clusterMeans = (key: (row: { episode: ShadowEpisode; label: OutcomeLabel }) => string) => {
    const groups = new Map<string, number[]>();
    for (const row of rows) {
      const group = groups.get(key(row)) ?? [];
      group.push(value(row.label));
      groups.set(key(row), group);
    }
    return [...groups.values()].map((group) =>
      group.reduce((sum, candidate) => sum + candidate, 0) / group.length
    );
  };
  const dayMeans = clusterMeans(({ episode }) => episode.openedAt?.slice(0, 10) ?? episode.createdAt.slice(0, 10));
  const mintMeans = clusterMeans(({ episode }) => episode.mint);
  if (dayMeans.length < 2 || mintMeans.length < 2) {
    const margin = 2 * Math.max(standardDeviation(values), Math.abs(mean), 0.000001);
    return side === "LOWER" ? mean - margin : mean + margin;
  }
  const rowError = standardDeviation(values) / Math.sqrt(values.length);
  const dayError = standardDeviation(dayMeans) / Math.sqrt(dayMeans.length);
  const mintError = standardDeviation(mintMeans) / Math.sqrt(mintMeans.length);
  const margin = 1.645 * Math.max(rowError, dayError, mintError);
  return side === "LOWER" ? mean - margin : mean + margin;
}

function tokenVolume24h(token: JupiterMarketTokenSnapshot): number {
  const buy = token.stats24h?.buyVolume;
  const sell = token.stats24h?.sellVolume;
  return buy !== undefined && sell !== undefined ? buy + sell : -1;
}

function organicShare(stats: JupiterMarketTokenSnapshot["stats5m"]): number {
  if (stats?.buyOrganicVolume === undefined || stats.sellOrganicVolume === undefined) return -1;
  const total = stats.buyOrganicVolume + stats.sellOrganicVolume;
  return total > 0 ? stats.buyOrganicVolume / total : -1;
}

function categoryRanks(token: JupiterMarketTokenSnapshot): number[] {
  return Object.values(token.categoryRanks).filter(
    (value): value is number => value !== undefined && Number.isFinite(value) && value > 0
  );
}

function tokenAgeDays(token: JupiterMarketTokenSnapshot, capturedAt: string): number {
  const born = token.firstPoolAt ?? token.createdAt;
  const captured = Date.parse(capturedAt);
  const started = born ? Date.parse(born) : Number.NaN;
  return Number.isFinite(captured) && Number.isFinite(started) && captured >= started
    ? (captured - started) / 86_400_000
    : -1;
}

function completeLearningFeatureEvidence(
  token: JupiterMarketTokenSnapshot,
  capturedAt: string
): boolean {
  const volume1h = finite(token.stats1h?.buyOrganicVolume, 0) +
    finite(token.stats1h?.sellOrganicVolume, 0);
  return tokenAgeDays(token, capturedAt) >= 0 &&
    token.stats5m?.priceChange !== undefined &&
    token.stats1h?.priceChange !== undefined &&
    token.stats6h?.priceChange !== undefined &&
    token.stats24h?.priceChange !== undefined &&
    token.stats1h?.liquidityChange !== undefined &&
    organicShare(token.stats5m) >= 0 &&
    organicShare(token.stats1h) >= 0 &&
    volume1h > 0 &&
    categoryRanks(token).length > 0;
}

function hardSafetyEligible(token: JupiterMarketTokenSnapshot): boolean {
  return token.verified && !token.suspicious &&
    (token.tokenProgram === TOKEN_PROGRAM_ID || token.tokenProgram === TOKEN_2022_PROGRAM_ID) &&
    token.mintAuthorityDisabled && token.freezeAuthorityDisabled &&
    finite(token.priceUsd) > 0 && finite(token.liquidityUsd) >= 100_000 &&
    finite(token.holderCount) >= 100 && finite(token.topHoldersPercent, 101) <= 65 &&
    !token.tags.some((tag) => ["banned", "suspicious", "scam"].includes(tag.toLowerCase()));
}

/** Deterministic, causal regime classifier. It never reads prices newer than
 * the universe capture timestamp. */
export function classifyMarketRegime(
  sol: JupiterMarketTokenSnapshot | undefined,
  tokens: readonly JupiterMarketTokenSnapshot[]
): MarketRegime {
  const sol1h = finite(sol?.stats1h?.priceChange, Number.NaN);
  const sol6h = finite(sol?.stats6h?.priceChange, Number.NaN);
  if (!Number.isFinite(sol1h) || !Number.isFinite(sol6h)) return "UNKNOWN";
  const changes = tokens.map((token) => finite(token.stats1h?.priceChange, Number.NaN)).filter(Number.isFinite);
  if (changes.length < 5) return "UNKNOWN";
  const positiveBreadth = changes.filter((value) => value > 0).length / changes.length;
  const dispersion = standardDeviation(changes.map((value) => clamp(value, -100, 100)));
  if (sol1h <= -2 || sol6h <= -5 || positiveBreadth < 0.3) return "RISK_OFF";
  if (Math.abs(sol1h) >= 3 || dispersion >= 12) return "HIGH_VOLATILITY";
  if (sol1h >= 0.5 && sol6h >= 1 && positiveBreadth >= 0.6) return "RISK_ON_TREND";
  if (positiveBreadth >= 0.65) return "BROAD_RISK_ON";
  return "CHOPPY";
}

function strategyForTokenV12(input: {
  token: JupiterMarketTokenSnapshot;
  capturedAt: string;
  walletConfirmed: boolean;
}): { arm: AutonomousPaperStrategyArm; shadowOnly: boolean; score: number } | undefined {
  const { token } = input;
  if (!hardSafetyEligible(token)) return undefined;
  const age = tokenAgeDays(token, input.capturedAt);
  const change5m = finite(token.stats5m?.priceChange);
  const change1h = finite(token.stats1h?.priceChange);
  const change6h = finite(token.stats6h?.priceChange);
  const buy5m = organicShare(token.stats5m);
  const buy1h = organicShare(token.stats1h);
  const liquidityFlow = finite(token.stats1h?.liquidityChange);
  const volume5m = finite(token.stats5m?.buyOrganicVolume, 0) + finite(token.stats5m?.sellOrganicVolume, 0);
  const volume1h = finite(token.stats1h?.buyOrganicVolume, 0) + finite(token.stats1h?.sellOrganicVolume, 0);
  const acceleration = volume1h > 0 ? volume5m * 12 / volume1h : -1;
  const rankQuality = categoryRanks(token).length > 0
    ? 1 - Math.min(...categoryRanks(token)) / 100
    : 0;
  const baseScore = 35 * clamp((buy5m - 0.45) / 0.35, 0, 1) +
    20 * clamp((buy1h - 0.45) / 0.3, 0, 1) +
    15 * clamp(acceleration / 1.5, 0, 1) +
    15 * clamp((liquidityFlow + 5) / 15, 0, 1) +
    15 * clamp(rankQuality, 0, 1);

  if (input.walletConfirmed && change1h > 0) {
    return { arm: "WALLET_CONFIRMED_MOMENTUM", shadowOnly: false, score: baseScore + 8 };
  }
  if (age >= 0.5 && age < 2 && finite(token.liquidityUsd) >= 100_000) {
    return { arm: "EARLY_LIQUIDITY", shadowOnly: true, score: baseScore + clamp(change1h, -5, 20) };
  }
  if (change5m >= 2 && change1h >= 3 && acceleration >= 0.8 && liquidityFlow >= 0) {
    return { arm: "BREAKOUT", shadowOnly: false, score: baseScore + 12 };
  }
  if (change5m >= -2 && change5m <= 0.75 && change1h >= 2 && change6h > -5 && buy5m >= 0.5) {
    return { arm: "PULLBACK_RECLAIM", shadowOnly: false, score: baseScore + 7 };
  }
  if (change5m >= 0 && change1h >= 1 && change1h <= 35 && buy5m >= 0.5 && buy1h >= 0.48) {
    return { arm: "MOMENTUM_CONTINUATION", shadowOnly: false, score: baseScore + 5 };
  }
  if (change1h > -1 && change6h > -10 && buy5m >= 0.47 && liquidityFlow >= -7) {
    return { arm: "CONTROLLED_EXPLORATION", shadowOnly: true, score: baseScore };
  }
  return undefined;
}

/** V13 admission learned from the first complete V12 cohort without mutating
 * that archived cohort. Missing organic evidence can no longer pass through a
 * breakout or pullback branch, repeated high-volatility exploration is
 * disabled, and every normal arm must clear a common market-quality floor. */
function strategyForTokenV13(input: {
  token: JupiterMarketTokenSnapshot;
  capturedAt: string;
  walletConfirmed: boolean;
  regime: MarketRegime;
}): { arm: AutonomousPaperStrategyArm; shadowOnly: boolean; score: number } | undefined {
  const { token, regime } = input;
  if (!hardSafetyEligible(token)) return undefined;
  const age = tokenAgeDays(token, input.capturedAt);
  const change5m = finite(token.stats5m?.priceChange);
  const change1h = finite(token.stats1h?.priceChange);
  const change6h = finite(token.stats6h?.priceChange);
  const buy5m = organicShare(token.stats5m);
  const buy1h = organicShare(token.stats1h);
  const liquidityFlow = finite(token.stats1h?.liquidityChange);
  const volume5m = finite(token.stats5m?.buyOrganicVolume, 0) +
    finite(token.stats5m?.sellOrganicVolume, 0);
  const volume1h = finite(token.stats1h?.buyOrganicVolume, 0) +
    finite(token.stats1h?.sellOrganicVolume, 0);
  const acceleration = volume1h > 0 ? volume5m * 12 / volume1h : -1;
  const rankQuality = categoryRanks(token).length > 0
    ? 1 - Math.min(...categoryRanks(token)) / 100
    : 0;
  const completeEvidence = completeLearningFeatureEvidence(token, input.capturedAt) &&
    buy5m >= 0 && buy1h >= 0 && acceleration >= 0 &&
    tokenVolume24h(token) >= 0 &&
    finite(token.organicScore) >= 0 &&
    finite(token.topHoldersPercent) >= 0;
  if (!completeEvidence ||
      finite(token.liquidityUsd) < 250_000 ||
      tokenVolume24h(token) < 250_000 ||
      finite(token.holderCount) < 300 ||
      finite(token.organicScore) < 55 ||
      finite(token.topHoldersPercent, 101) > 45) return undefined;

  const baseScore = 35 * clamp((buy5m - 0.48) / 0.32, 0, 1) +
    20 * clamp((buy1h - 0.48) / 0.27, 0, 1) +
    15 * clamp(acceleration / 1.5, 0, 1) +
    15 * clamp((liquidityFlow + 3) / 13, 0, 1) +
    15 * clamp(rankQuality, 0, 1);
  const established = age >= 2;
  const walletQuality = established && change1h > 0 &&
    buy5m >= 0.52 && buy1h >= 0.5 && acceleration >= 0.05;

  // A risk-off or unknown market is still useful research evidence, but no
  // heuristic alone may label it champion-capable.
  if (regime === "RISK_OFF" || regime === "UNKNOWN") {
    return input.walletConfirmed && walletQuality
      ? {
          arm: "WALLET_CONFIRMED_MOMENTUM",
          shadowOnly: true,
          score: baseScore + 4
        }
      : undefined;
  }

  if (regime === "HIGH_VOLATILITY") {
    const highVolQuality = established &&
      finite(token.liquidityUsd) >= 500_000 &&
      tokenVolume24h(token) >= 750_000 &&
      finite(token.holderCount) >= 500 &&
      finite(token.organicScore) >= 65 &&
      finite(token.topHoldersPercent, 101) <= 35 &&
      buy5m >= 0.58 && buy1h >= 0.54 &&
      acceleration >= 0.25 && liquidityFlow >= -1;
    if (highVolQuality) {
      if (input.walletConfirmed && change1h >= 1) {
        return { arm: "WALLET_CONFIRMED_MOMENTUM", shadowOnly: false, score: baseScore + 10 };
      }
      if (
        change5m >= 1.5 && change5m <= 8 &&
        change1h >= 3 && change1h <= 25 &&
        acceleration >= 0.5 && liquidityFlow >= 0
      ) {
        return { arm: "BREAKOUT", shadowOnly: false, score: baseScore + 12 };
      }
      if (
        change5m >= 0.2 && change5m <= 5 &&
        change1h >= 1.5 && change1h <= 20
      ) {
        return { arm: "MOMENTUM_CONTINUATION", shadowOnly: false, score: baseScore + 7 };
      }
    }
    const simulationProbeQuality = established &&
      finite(token.liquidityUsd) >= 500_000 &&
      tokenVolume24h(token) >= 500_000 &&
      finite(token.holderCount) >= 500 &&
      finite(token.organicScore) >= 60 &&
      finite(token.topHoldersPercent, 101) <= 40 &&
      change5m >= -3 && change5m <= 8 &&
      change1h >= -5 && change1h <= 30 &&
      change6h > -20 &&
      buy5m >= 0.42 && buy1h >= 0.42 &&
      (buy5m >= 0.48 || buy1h >= 0.5) &&
      acceleration >= 0.02 && liquidityFlow >= -3;
    if (simulationProbeQuality) {
      return { arm: "SIMULATION_PROBE", shadowOnly: true, score: baseScore + 2 };
    }
    return undefined;
  }

  if (input.walletConfirmed && walletQuality) {
    return { arm: "WALLET_CONFIRMED_MOMENTUM", shadowOnly: false, score: baseScore + 8 };
  }
  if (
    age >= 0.5 && age < 2 &&
    buy5m >= 0.55 && buy1h >= 0.52 &&
    acceleration >= 0.15 && liquidityFlow >= 0
  ) {
    return { arm: "EARLY_LIQUIDITY", shadowOnly: true, score: baseScore + clamp(change1h, -5, 20) };
  }
  if (
    established && change5m >= 1.5 && change5m <= 10 &&
    change1h >= 3 && change1h <= 30 &&
    buy5m >= 0.56 && buy1h >= 0.52 &&
    acceleration >= 0.5 && liquidityFlow >= 0
  ) {
    return { arm: "BREAKOUT", shadowOnly: false, score: baseScore + 12 };
  }
  if (
    established && change5m >= -1.5 && change5m <= 0.75 &&
    change1h >= 2 && change6h > -5 &&
    buy5m >= 0.52 && buy1h >= 0.5 &&
    acceleration >= 0.05
  ) {
    return { arm: "PULLBACK_RECLAIM", shadowOnly: false, score: baseScore + 7 };
  }
  if (
    established && change5m >= 0 && change5m <= 8 &&
    change1h >= 1 && change1h <= 25 &&
    buy5m >= 0.53 && buy1h >= 0.5 &&
    acceleration >= 0.08
  ) {
    return { arm: "MOMENTUM_CONTINUATION", shadowOnly: false, score: baseScore + 5 };
  }
  if (
    established && change1h > -0.5 && change6h > -8 &&
    buy5m >= 0.52 && buy1h >= 0.5 &&
    acceleration >= 0.05 && liquidityFlow >= -3
  ) {
    return { arm: "CONTROLLED_EXPLORATION", shadowOnly: true, score: baseScore };
  }
  return undefined;
}

function strategyForToken(input: {
  token: JupiterMarketTokenSnapshot;
  capturedAt: string;
  walletConfirmed: boolean;
  regime: MarketRegime;
  policyVersion: string;
}): { arm: AutonomousPaperStrategyArm; shadowOnly: boolean; score: number } | undefined {
  return input.policyVersion === AUTONOMOUS_PAPER_POLICY_VERSION
    ? strategyForTokenV13(input)
    : strategyForTokenV12(input);
}

function featureVector(input: {
  token: JupiterMarketTokenSnapshot;
  sol?: JupiterMarketTokenSnapshot;
  capturedAt: string;
  arm: AutonomousPaperStrategyArm;
  regime: MarketRegime;
  shadowOnly: boolean;
  walletConfirmed: boolean;
  negativeControl?: boolean;
  projectedRoundTripCostPercent?: number;
  buyPriceImpactPercent?: number;
  sellPriceImpactPercent?: number;
  datasetEligible?: boolean;
}): LearningFeatureVector {
  const ranks = categoryRanks(input.token);
  const volume5m = finite(input.token.stats5m?.buyOrganicVolume, 0) +
    finite(input.token.stats5m?.sellOrganicVolume, 0);
  const volume1h = finite(input.token.stats1h?.buyOrganicVolume, 0) +
    finite(input.token.stats1h?.sellOrganicVolume, 0);
  const developerCluster = input.token.developer || input.token.launchpad
    ? digest({ developer: input.token.developer ?? "", launchpad: input.token.launchpad ?? "" }).slice(0, 24)
    : undefined;
  const missingFeatureNames = [
    ...(input.token.stats5m?.priceChange === undefined ? ["change5m"] : []),
    ...(input.token.stats1h?.priceChange === undefined ? ["change1h"] : []),
    ...(input.token.stats6h?.priceChange === undefined ? ["change6h"] : []),
    ...(input.token.stats24h?.priceChange === undefined ? ["change24h"] : []),
    ...(organicShare(input.token.stats5m) < 0 ? ["organicBuy5m"] : []),
    ...(organicShare(input.token.stats1h) < 0 ? ["organicBuy1h"] : []),
    ...(volume1h <= 0 ? ["volumeAcceleration"] : []),
    ...(input.token.stats1h?.liquidityChange === undefined ? ["liquidityFlow"] : []),
    ...(ranks.length === 0 ? ["categoryRankQuality"] : []),
    ...(input.projectedRoundTripCostPercent === undefined ? ["roundTripCostQuality"] : []),
    ...(input.buyPriceImpactPercent === undefined || input.sellPriceImpactPercent === undefined
      ? ["impactQuality"]
      : [])
  ];
  return {
    version: AUTONOMOUS_LEARNING_FEATURE_VERSION,
    capturedAt: input.capturedAt,
    mint: input.token.mint,
    strategyArm: input.arm,
    regime: input.regime,
    shadowOnly: input.shadowOnly,
    tokenAgeDays: tokenAgeDays(input.token, input.capturedAt),
    logLiquidityUsd: Math.log1p(Math.max(0, finite(input.token.liquidityUsd, 0))),
    logVolume24hUsd: Math.log1p(Math.max(0, tokenVolume24h(input.token))),
    holderBreadth: Math.max(0, finite(input.token.holderCount, 0)),
    organicScore: Math.max(0, finite(input.token.organicScore, 0)),
    topHoldersPercent: finite(input.token.topHoldersPercent, 100),
    priceChange5mPercent: finite(input.token.stats5m?.priceChange),
    priceChange1hPercent: finite(input.token.stats1h?.priceChange),
    priceChange6hPercent: finite(input.token.stats6h?.priceChange),
    priceChange24hPercent: finite(input.token.stats24h?.priceChange),
    organicBuyShare5m: organicShare(input.token.stats5m),
    organicBuyShare1h: organicShare(input.token.stats1h),
    volumeAccelerationRatio: volume1h > 0 ? volume5m * 12 / volume1h : -1,
    liquidityChange1hPercent: finite(input.token.stats1h?.liquidityChange),
    solRelativeStrength1hPercent:
      finite(input.token.stats1h?.priceChange) - finite(input.sol?.stats1h?.priceChange, 0),
    categoryBreadth: ranks.length,
    bestCategoryRank: ranks.length > 0 ? Math.min(...ranks) : 10_000,
    projectedRoundTripCostPercent: input.projectedRoundTripCostPercent ?? -1,
    buyPriceImpactPercent: input.buyPriceImpactPercent ?? -1,
    sellPriceImpactPercent: input.sellPriceImpactPercent ?? -1,
    walletConfirmed: input.walletConfirmed,
    ...(developerCluster ? { developerCluster } : {}),
    ...(missingFeatureNames.length > 0 ? { missingFeatureNames } : {}),
    ...(input.negativeControl ? { negativeControl: true } : {}),
    datasetEligible: input.datasetEligible ?? false
  };
}

function quoteUsable(quote: QuoteSnapshot, request: QuoteRequest, now: Date): boolean {
  try {
    if (
      BigInt(quote.inputAmountAtomic) <= 0n ||
      BigInt(quote.outputAmountAtomic) <= 0n ||
      BigInt(quote.minimumOutputAtomic) <= 0n ||
      BigInt(quote.minimumOutputAtomic) > BigInt(quote.outputAmountAtomic)
    ) return false;
  } catch {
    return false;
  }
  const quotedAt = Date.parse(quote.quotedAt);
  return quote.inputMint === request.inputMint && quote.outputMint === request.outputMint &&
    quote.inputAmountAtomic === request.inputAmountAtomic &&
    Number.isFinite(quotedAt) && now.getTime() - quotedAt >= -1_000 &&
    now.getTime() - quotedAt <= MAXIMUM_QUOTE_AGE_MS &&
    Number.isFinite(quote.inputUsd) && quote.inputUsd > 0 &&
    Number.isFinite(quote.outputUsd) && quote.outputUsd > 0 &&
    Number.isFinite(quote.priceImpactPercent) && quote.priceImpactPercent >= 0 &&
    Number.isFinite(quote.feeBps) && quote.feeBps >= 0 &&
    Number.isFinite(quote.signatureFeeLamports) && quote.signatureFeeLamports >= 0 &&
    Number.isFinite(quote.prioritizationFeeLamports) && quote.prioritizationFeeLamports >= 0 &&
    Number.isFinite(quote.rentFeeLamports) && quote.rentFeeLamports >= 0 &&
    quote.transactionBase64 === undefined &&
    (!quote.expiresAt || Date.parse(quote.expiresAt) > now.getTime());
}

function modeledFeeUsd(quote: QuoteSnapshot, solPriceUsd: number): number {
  if (!Number.isFinite(solPriceUsd) || solPriceUsd <= 0) throw new Error("LEARNING_SOL_PRICE_UNAVAILABLE");
  const lamports = quote.signatureFeeLamports + quote.prioritizationFeeLamports + quote.rentFeeLamports;
  const fee = quote.inputUsd * quote.feeBps / 10_000 + lamports / LAMPORTS_PER_SOL * solPriceUsd;
  if (!Number.isFinite(fee) || fee < 0) throw new Error("LEARNING_QUOTE_FEE_INVALID");
  return fee;
}

function labelFor(input: {
  episode: ShadowEpisode;
  horizon: OutcomeLabel["horizonMinutes"];
  observedAt: string;
  executableValueUsd: number;
  exitFeeUsd: number;
  solPriceUsd: number;
}): OutcomeLabel {
  const cost = input.episode.inputCostUsd ?? 0;
  const proceeds = Math.max(0, input.executableValueUsd - input.exitFeeUsd);
  const returnPercent = cost > 0 ? (proceeds - cost) / cost * 100 : -100;
  const solBenchmarkReturnPercent = input.episode.entrySolPriceUsd && input.solPriceUsd > 0
    ? (input.solPriceUsd - input.episode.entrySolPriceUsd) / input.episode.entrySolPriceUsd * 100
    : 0;
  const excessReturnPercent = returnPercent - solBenchmarkReturnPercent;
  return {
    id: stableId("learning-outcome-v1", { episodeId: input.episode.id, horizon: input.horizon }),
    episodeId: input.episode.id,
    horizonMinutes: input.horizon,
    observedAt: input.observedAt,
    executableValueUsd: proceeds,
    totalModeledCostUsd: Math.max(0, cost - (input.episode.entryExecutableValueUsd ?? cost)) + input.exitFeeUsd,
    netReturnPercent: returnPercent,
    netLogReturn: Math.log(Math.max(0.000001, proceeds / Math.max(0.000001, cost))),
    riskAdjustedReward: excessReturnPercent -
      0.25 * Math.abs(Math.min(0, input.episode.maximumAdverseExcursionPercent)) -
      0.002 * input.horizon,
    solBenchmarkReturnPercent,
    excessReturnPercent,
    maximumFavorableExcursionPercent: input.episode.maximumFavorableExcursionPercent,
    maximumAdverseExcursionPercent: input.episode.maximumAdverseExcursionPercent,
    profitable: returnPercent > 0,
    quoteExecutable: true,
    datasetEligible: input.episode.featureVector.datasetEligible
  };
}

function pathObservation(input: {
  episode: ShadowEpisode;
  phase: LearningPathObservation["phase"];
  observedAt: string;
  executableValueUsd: number;
  exitFeeUsd: number;
  priceImpactPercent: number;
  solPriceUsd: number;
}): LearningPathObservation {
  const cost = input.episode.inputCostUsd ?? 0;
  const proceeds = Math.max(0, input.executableValueUsd - input.exitFeeUsd);
  const netReturnPercent = cost > 0 ? (proceeds - cost) / cost * 100 : -100;
  const solBenchmarkReturnPercent = input.episode.entrySolPriceUsd && input.solPriceUsd > 0
    ? (input.solPriceUsd - input.episode.entrySolPriceUsd) / input.episode.entrySolPriceUsd * 100
    : 0;
  const elapsedMinutes = input.episode.openedAt
    ? Math.max(0, (Date.parse(input.observedAt) - Date.parse(input.episode.openedAt)) / 60_000)
    : 0;
  return {
    id: stableId("learning-path-observation-v1", {
      episodeId: input.episode.id,
      phase: input.phase,
      observedAt: input.observedAt
    }),
    episodeId: input.episode.id,
    phase: input.phase,
    observedAt: input.observedAt,
    elapsedMinutes,
    executableValueUsd: proceeds,
    totalModeledCostUsd: Math.max(
      0,
      cost - (input.episode.entryExecutableValueUsd ?? cost)
    ) + input.exitFeeUsd,
    netReturnPercent,
    solBenchmarkReturnPercent,
    excessReturnPercent: netReturnPercent - solBenchmarkReturnPercent,
    priceImpactPercent: input.priceImpactPercent,
    quoteExecutable: true,
    datasetEligible: input.episode.featureVector.datasetEligible
  };
}

function drawdownPercent(returns: readonly number[]): number {
  let nav = 1;
  let peak = 1;
  let maximum = 0;
  for (const value of returns) {
    nav *= Math.max(0.000001, 1 + value / 100);
    peak = Math.max(peak, nav);
    maximum = Math.max(maximum, (peak - nav) / peak * 100);
  }
  return maximum;
}

function policyReturn(
  row: { episode: ShadowEpisode; label: OutcomeLabel },
  policy: { stop: number; target: number; hold: number },
  observations: readonly LearningPathObservation[]
): number | undefined {
  const path = observations.filter((observation) =>
    observation.quoteExecutable && observation.datasetEligible &&
    observation.elapsedMinutes <= policy.hold + MAXIMUM_DENSE_PATH_GAP_MINUTES
  ).sort((left, right) => left.elapsedMinutes - right.elapsedMinutes ||
    left.observedAt.localeCompare(right.observedAt));
  if (path.length < 2 || path[0]!.elapsedMinutes > 0.5) return undefined;
  for (let index = 1; index < path.length; index += 1) {
    if (path[index]!.elapsedMinutes - path[index - 1]!.elapsedMinutes > MAXIMUM_DENSE_PATH_GAP_MINUTES) {
      return undefined;
    }
  }
  const eligible = path.filter((observation) => observation.elapsedMinutes <= policy.hold + 0.5);
  const terminal = eligible.at(-1);
  if (!terminal || terminal.elapsedMinutes < policy.hold - MAXIMUM_DENSE_PATH_GAP_MINUTES) return undefined;
  for (const observation of eligible) {
    if (observation.elapsedMinutes <= 0.5) continue;
    if (observation.netReturnPercent <= -policy.stop || observation.netReturnPercent >= policy.target) {
      return observation.netReturnPercent;
    }
  }
  return terminal.netReturnPercent;
}

function attribution(row: { episode: ShadowEpisode; label: OutcomeLabel }): TradeAttribution {
  const { episode, label } = row;
  let primaryCause: TradeAttribution["primaryCause"] = "POSITIVE_EXECUTION";
  const reasons: string[] = [];
  if (!label.datasetEligible) {
    primaryCause = "DATA_QUALITY";
    reasons.push("NON_TRAINABLE_PATH");
  } else if (label.totalModeledCostUsd / Math.max(episode.inputCostUsd ?? 1, 1) > 0.03) {
    primaryCause = "EXECUTION_COST";
    reasons.push("COST_DRAG_ABOVE_3_PERCENT");
  } else if (label.maximumFavorableExcursionPercent <= 0) {
    primaryCause = "ENTRY_QUALITY";
    reasons.push("NO_PROFITABLE_EXECUTABLE_FOLLOW_THROUGH");
  } else if (!label.profitable && label.maximumFavorableExcursionPercent > 0) {
    primaryCause = "EXIT_POLICY";
    reasons.push("PROFITABLE_WINDOW_NOT_CAPTURED");
  } else if (episode.regime === "RISK_OFF" || episode.regime === "HIGH_VOLATILITY") {
    primaryCause = "REGIME_SHIFT";
    reasons.push("ADVERSE_MARKET_REGIME");
  }
  if (reasons.length === 0) reasons.push("EXECUTABLE_PATH_FINISHED_POSITIVE");
  return {
    id: stableId("learning-attribution-v1", { episodeId: episode.id, horizon: label.horizonMinutes }),
    episodeId: episode.id,
    primaryCause,
    reasonCodes: reasons,
    avoidableLossUsd: Math.max(0, -(label.netReturnPercent / 100) * (episode.inputCostUsd ?? 0)),
    createdAt: label.observedAt
  };
}

export class AutonomousLearningEngine {
  private tail: Promise<void> = Promise.resolve();
  private training = false;
  private learningIntegrityStatus: string;

  constructor(
    private readonly repository: Repository,
    private readonly learning: AutonomousLearningRepository,
    private readonly options: AutonomousLearningOptions
  ) {
    // A full SQLite integrity check reads the entire learning database. Run it
    // at controlled lifecycle boundaries, not from the frequently refreshed
    // dashboard projection. Any non-ok result (including a thrown check) is
    // retained fail-closed and reported as DEGRADED by overview().
    this.learningIntegrityStatus = this.refreshLearningIntegrityStatus();
  }

  private refreshLearningIntegrityStatus(): string {
    try {
      this.learningIntegrityStatus = this.learning.integrityCheck();
    } catch {
      this.learningIntegrityStatus = "integrity_check_failed";
    }
    return this.learningIntegrityStatus;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private cohortPolicyVersion(): string {
    return this.repository.activeAutonomousPaperLane()?.policyVersion ?? AUTONOMOUS_PAPER_POLICY_VERSION;
  }

  private latestTrainingMetaKey(policyVersion = this.cohortPolicyVersion()): string {
    return `latest_training_at:${policyVersion}`;
  }

  private latestSimulationEvaluationsMetaKey(
    policyVersion = this.cohortPolicyVersion()
  ): string {
    return `latest_simulation_evaluations:${policyVersion}`;
  }

  candidateStrategy(
    token: JupiterMarketTokenSnapshot,
    capturedAt: string,
    evidenceAdmission = false
  ): AutonomousLearningCandidateStrategy | undefined {
    const regime = this.learning.getMeta<MarketRegime>("current_regime") ?? "UNKNOWN";
    const policyVersion = this.cohortPolicyVersion();
    const walletConfirmed = this.options.walletConfirmed?.(token.mint, capturedAt) ?? false;
    const selected = strategyForToken({
      token,
      capturedAt,
      walletConfirmed,
      regime,
      policyVersion
    });
    if (!selected) return undefined;
    const counts = this.learning.episodeCounts(policyVersion);
    const activeModels = this.learning.activeModels().filter((model) => model.policyVersion === policyVersion);
    const modelInfluence = counts.datasetEligible >= AUTONOMOUS_MODEL_MINIMUM_PATHS &&
      activeModels.length === AUTONOMOUS_MODEL_REQUIRED_ARTIFACTS;
    const armScore = this.learning.listArmScores().find((score) =>
      score.strategyArm === selected.arm && score.regime === regime &&
      score.policyVersion === policyVersion
    );
    const modelAllowed = evidenceAdmission
      ? Boolean(armScore?.eligibleForChampion) && !selected.shadowOnly
      : !modelInfluence || Boolean(armScore?.eligibleForChampion);
    const modelHighConviction = modelInfluence && Boolean(
      armScore?.eligibleForChampion &&
      armScore.profitableProbability >= 0.62 &&
      armScore.lowerConfidenceNetLogReturn >= 0.005 &&
      (armScore.lowerConfidenceRiskAdjustedReward ?? Number.NEGATIVE_INFINITY) > 0 &&
      armScore.adverseTailReturn > -0.08
    );
    const reasonCodes = [
      ...(selected.shadowOnly ? ["SHADOW_ONLY_ARM"] : []),
      ...(armScore?.reasonCodes ?? (
      evidenceAdmission
        ? ["SEGMENT_HAS_NO_EVIDENCE_SCORE"]
        : modelInfluence ? ["SEGMENT_HAS_NO_TRAINED_SCORE"] : []
      ))
    ];
    const admission: LearningAdmissionDecision = {
      policyVersion,
      strategyArm: selected.arm,
      regime,
      executionTier: modelAllowed && !selected.shadowOnly ? "CHAMPION" : "SHADOW",
      allowed: modelAllowed && !selected.shadowOnly,
      highConviction: modelHighConviction,
      reasonCodes: [...new Set(reasonCodes)],
      ...(armScore ? {
        expectedNetReturnPercent: (Math.exp(armScore.expectedNetLogReturn) - 1) * 100,
        lowerConfidenceNetReturnPercent:
          (Math.exp(armScore.lowerConfidenceNetLogReturn) - 1) * 100
      } : {}),
      decidedAt: capturedAt
    };
    this.learning.saveAdmission(admission);
    return {
      arm: selected.arm,
      shadowOnly: selected.shadowOnly,
      heuristicScore: selected.score,
      regime,
      modelAllowed,
      modelHighConviction,
      modelReasonCodes: admission.reasonCodes,
      admission
    };
  }

  ingestUniverse(input: LearningUniverseInput): void {
    const capturedAt = input.universe.capturedAt;
    const regime = classifyMarketRegime(input.sol, input.tokens);
    const sampledMints = input.lane.policyVersion === AUTONOMOUS_PAPER_POLICY_VERSION
      ? this.learning.episodeMintsForDay(capturedAt.slice(0, 10), input.lane.policyVersion)
      : new Set<string>();
    const allStrategyCandidates = input.tokens.map((token) => {
      const walletConfirmed = this.options.walletConfirmed?.(token.mint, capturedAt) ?? false;
      const strategy = strategyForToken({
        token,
        capturedAt,
        walletConfirmed,
        regime,
        policyVersion: input.lane.policyVersion
      });
      return strategy ? { token, walletConfirmed, ...strategy } : undefined;
    }).filter((value): value is NonNullable<typeof value> => value !== undefined);
    const strategyMints = new Set(allStrategyCandidates.map(({ token }) => token.mint));
    const quarantinedArms = input.lane.policyVersion === AUTONOMOUS_PAPER_POLICY_VERSION
      ? new Set(this.learning.listArmScores().filter((score) =>
          score.policyVersion === input.lane.policyVersion &&
          score.regime === regime &&
          score.quarantined
        ).map((score) => score.strategyArm))
      : new Set<AutonomousPaperStrategyArm>();
    const strategyCandidates = allStrategyCandidates.filter(
      (candidate) =>
        !sampledMints.has(candidate.token.mint) &&
        !quarantinedArms.has(candidate.arm)
    );
    const negativeControls = input.tokens.filter((token) =>
      hardSafetyEligible(token) &&
      (
        input.lane.policyVersion !== AUTONOMOUS_PAPER_POLICY_VERSION ||
        completeLearningFeatureEvidence(token, capturedAt)
      ) &&
      !sampledMints.has(token.mint) &&
      !strategyMints.has(token.mint)
    ).sort((left, right) =>
      finite(right.liquidityUsd, 0) - finite(left.liquidityUsd, 0) ||
      tokenVolume24h(right) - tokenVolume24h(left) ||
      left.mint.localeCompare(right.mint)
    ).slice(0, NEGATIVE_CONTROLS_PER_SCAN).map((token) => ({
      token,
      walletConfirmed: false,
      arm: "NEGATIVE_CONTROL" as const,
      shadowOnly: true,
      score: 0
    }));
    const candidates = strategyCandidates
      .sort((left, right) =>
        Number(left.shadowOnly) - Number(right.shadowOnly) ||
        right.score - left.score ||
        left.token.mint.localeCompare(right.token.mint)
      );
    const armLimit = Math.max(1, Math.floor(MAXIMUM_NEW_EPISODES_PER_SCAN * 0.4));
    const armCounts = new Map<AutonomousPaperStrategyArm, number>();
    const rankedStrategies = candidates.filter((candidate) => {
      if ([...armCounts.values()].reduce((sum, count) => sum + count, 0) >=
          MAXIMUM_NEW_EPISODES_PER_SCAN - negativeControls.length) return false;
      const count = armCounts.get(candidate.arm) ?? 0;
      if (count >= armLimit) return false;
      armCounts.set(candidate.arm, count + 1);
      return true;
    });
    const ranked = [...rankedStrategies, ...negativeControls];
    const sourceKey = stableId("learning-universe-v1", {
      laneId: input.lane.id,
      capturedAt,
      mints: ranked.map(({ token }) => token.mint)
    });
    const evidenceAdmission = input.lane.policyVersion === AUTONOMOUS_PAPER_POLICY_VERSION ||
      input.lane.policyVersion === AUTONOMOUS_PAPER_V12_POLICY_VERSION;
    const currentScores = evidenceAdmission ? this.learning.listArmScores() : [];
    const episodes = ranked.map(({ token, walletConfirmed, arm, shadowOnly }) => {
      const episodeSourceKey = stableId("learning-shadow-source-v1", {
        sourceKey,
        mint: token.mint,
        arm
      });
      const admitted = !shadowOnly && Boolean(currentScores.find((score) =>
        score.strategyArm === arm && score.regime === regime &&
        score.policyVersion === input.lane.policyVersion)?.eligibleForChampion);
      const episodeShadowOnly = shadowOnly || (evidenceAdmission && !admitted);
      return {
        id: stableId("learning-shadow-episode-v1", episodeSourceKey),
        sourceKey: episodeSourceKey,
        laneId: input.lane.id,
        policyVersion: input.lane.policyVersion,
        mint: token.mint,
        ...(token.symbol ? { symbol: token.symbol } : {}),
        strategyArm: arm,
        regime,
        status: "PENDING_QUOTE",
        shadowOnly: episodeShadowOnly,
        executionTier: episodeShadowOnly ? "SHADOW" : "CHAMPION",
        featureVector: featureVector({
          token,
          ...(input.sol ? { sol: input.sol } : {}),
          capturedAt,
          arm,
          regime,
          shadowOnly: episodeShadowOnly,
          walletConfirmed,
          negativeControl: arm === "NEGATIVE_CONTROL"
        }),
        referenceInputUsd: REFERENCE_INPUT_USD,
        tokenDecimals: token.decimals,
        maximumFavorableExcursionPercent: 0,
        maximumAdverseExcursionPercent: 0,
        createdAt: capturedAt,
        updatedAt: capturedAt
      } satisfies ShadowEpisode;
    });
    const payload: UniverseCapturePayload = {
      sourceKey,
      laneId: input.lane.id,
      policyVersion: input.lane.policyVersion,
      capturedAt,
      regime,
      candidateCount: input.tokens.length,
      episodes
    };
    this.repository.enqueueLearningOutbox({
      eventKey: sourceKey,
      kind: "UNIVERSE_CAPTURE",
      payload,
      createdAt: capturedAt
    });
    this.learning.setMeta("current_regime", regime, capturedAt);
  }

  enqueueProcess(): Promise<void> {
    const run = this.tail.then(() => this.process());
    this.tail = run.catch(() => undefined);
    return run;
  }

  async drain(): Promise<void> {
    await this.tail;
  }

  private drainOutbox(): void {
    for (const record of this.repository.pendingLearningOutbox(100)) {
      try {
        if (!this.learning.hasProcessedOutbox(record.id)) {
          if (record.kind !== "UNIVERSE_CAPTURE") throw new Error(`UNKNOWN_LEARNING_EVENT:${record.kind}`);
          const payload = record.payload as UniverseCapturePayload;
          if (!payload || payload.sourceKey !== record.eventKey || !Array.isArray(payload.episodes)) {
            throw new Error("MALFORMED_LEARNING_UNIVERSE_CAPTURE");
          }
          this.learning.db.transaction(() => {
            this.learning.saveUniverseCycle({
              sourceKey: payload.sourceKey,
              laneId: payload.laneId,
              policyVersion: payload.policyVersion,
              capturedAt: payload.capturedAt,
              regime: payload.regime,
              candidateCount: payload.candidateCount,
              payload: { episodeIds: payload.episodes.map((episode) => episode.id) }
            });
            const counts = this.learning.episodeCounts();
            let available = Math.max(0, MAXIMUM_OPEN_EPISODES - counts.pending - counts.active);
            for (const episode of payload.episodes) {
              if (available <= 0) break;
              if (
                this.learning.countEpisodesForMintDay(
                  episode.mint,
                  episode.createdAt.slice(0, 10),
                  payload.policyVersion
                ) >=
                (payload.policyVersion === AUTONOMOUS_PAPER_POLICY_VERSION
                  ? V13_MAXIMUM_EPISODES_PER_MINT_DAY
                  : V12_MAXIMUM_EPISODES_PER_MINT_DAY)
              ) continue;
              this.learning.upsertEpisode(episode);
              available -= 1;
            }
            this.learning.markOutboxProcessed(record.id, record.eventKey, this.now().toISOString());
          })();
        }
        this.repository.markLearningOutboxDelivered(record.id, this.now().toISOString());
      } catch (error) {
        const reason = error instanceof Error ? error.message : "LEARNING_OUTBOX_FAILED";
        this.repository.markLearningOutboxFailed(record.id, reason);
        throw error;
      }
    }
  }

  private async openPendingEpisode(episode: ShadowEpisode): Promise<void> {
    const now = this.now();
    if (episode.nextQuoteAttemptAt && Date.parse(episode.nextQuoteAttemptAt) > now.getTime()) return;
    try {
      const token = (await this.options.lookupMints([episode.mint]))[0];
      if (!token) throw new Error("LEARNING_TOKEN_LOOKUP_EMPTY");
      if (!hardSafetyEligible(token)) throw new Error("LEARNING_TOKEN_SAFETY_FAILED");
      const buyRequest: QuoteRequest = {
        inputMint: USDC_MINT,
        outputMint: episode.mint,
        inputAmountAtomic: String(Math.round(episode.referenceInputUsd * 10 ** USDC_DECIMALS))
      };
      const buy = await this.options.quote(buyRequest);
      if (!quoteUsable(buy, buyRequest, this.now())) throw new Error("LEARNING_BUY_QUOTE_INVALID");
      const sellRequest: QuoteRequest = {
        inputMint: episode.mint,
        outputMint: USDC_MINT,
        inputAmountAtomic: buy.minimumOutputAtomic
      };
      const sell = await this.options.quote(sellRequest);
      if (!quoteUsable(sell, sellRequest, this.now())) throw new Error("LEARNING_SELL_QUOTE_INVALID");
      const buyFee = modeledFeeUsd(buy, this.options.solPriceUsd());
      const sellFee = modeledFeeUsd(sell, this.options.solPriceUsd());
      const inputCostUsd = buy.inputUsd + buyFee;
      const entryValueUsd = Math.max(0, sell.outputUsd - sellFee);
      const roundTripCost = (inputCostUsd - entryValueUsd) / buy.inputUsd * 100;
      const remainingMissingFeatureNames = (episode.featureVector.missingFeatureNames ?? []).filter(
        (name) => name !== "roundTripCostQuality" && name !== "impactQuality"
      );
      const datasetEligible = remainingMissingFeatureNames.length === 0 &&
        buy.priceImpactPercent <= MAXIMUM_TRAINABLE_PRICE_IMPACT_PERCENT &&
        sell.priceImpactPercent <= MAXIMUM_TRAINABLE_PRICE_IMPACT_PERCENT &&
        roundTripCost <= MAXIMUM_TRAINABLE_ROUND_TRIP_COST_PERCENT;
      const openedAt = new Date(Math.max(Date.parse(buy.quotedAt), Date.parse(sell.quotedAt))).toISOString();
      const updated: ShadowEpisode = {
        ...episode,
        status: "ACTIVE",
        featureVector: {
          ...episode.featureVector,
          projectedRoundTripCostPercent: roundTripCost,
          buyPriceImpactPercent: buy.priceImpactPercent,
          sellPriceImpactPercent: sell.priceImpactPercent,
          datasetEligible,
          ...(remainingMissingFeatureNames.length > 0
            ? { missingFeatureNames: remainingMissingFeatureNames }
            : { missingFeatureNames: [] })
        },
        inputCostUsd,
        outputAmountAtomic: buy.minimumOutputAtomic,
        entryExecutableValueUsd: entryValueUsd,
        entrySolPriceUsd: this.options.solPriceUsd(),
        maximumFavorableExcursionPercent: Math.max(0, (entryValueUsd - inputCostUsd) / inputCostUsd * 100),
        maximumAdverseExcursionPercent: Math.min(0, (entryValueUsd - inputCostUsd) / inputCostUsd * 100),
        openedAt,
        horizonEndsAt: new Date(Date.parse(openedAt) + 180 * 60_000).toISOString(),
        lastObservedAt: openedAt,
        quoteAttempts: (episode.quoteAttempts ?? 0) + 1,
        updatedAt: openedAt
      };
      delete updated.failureCode;
      delete updated.nextQuoteAttemptAt;
      this.learning.upsertEpisode(updated);
      this.learning.savePathObservation(pathObservation({
        episode: updated,
        phase: "ENTRY",
        observedAt: openedAt,
        executableValueUsd: sell.outputUsd,
        exitFeeUsd: sellFee,
        priceImpactPercent: Math.max(buy.priceImpactPercent, sell.priceImpactPercent),
        solPriceUsd: this.options.solPriceUsd()
      }));
      this.options.onUpdate?.({ outcome: "SHADOW_OPENED", episodeId: updated.id, mint: updated.mint });
    } catch (error) {
      const reason = error instanceof Error ? error.message.slice(0, 160) : "LEARNING_QUOTE_FAILED";
      const attempts = (episode.quoteAttempts ?? 0) + 1;
      const structural = reason === "LEARNING_TOKEN_SAFETY_FAILED";
      const retryable = !structural && attempts < MAXIMUM_ENTRY_QUOTE_ATTEMPTS;
      const failed: ShadowEpisode = {
        ...episode,
        status: structural ? "REJECTED" : retryable ? "PENDING_QUOTE" : "UNPRICED",
        failureCode: reason,
        quoteAttempts: attempts,
        ...(retryable ? {
          nextQuoteAttemptAt: new Date(
            now.getTime() + ENTRY_QUOTE_RETRY_BASE_MS * 2 ** (attempts - 1)
          ).toISOString()
        } : {}),
        updatedAt: now.toISOString()
      };
      this.learning.upsertEpisode(failed);
      throw error;
    }
  }

  private async observeEpisode(episode: ShadowEpisode): Promise<void> {
    if (!episode.openedAt || !episode.outputAmountAtomic || !episode.inputCostUsd) return;
    const elapsedMinutes = (this.now().getTime() - Date.parse(episode.openedAt)) / 60_000;
    const due = OUTCOME_HORIZONS.filter((horizon) =>
      elapsedMinutes >= horizon && !this.learning.outcomeFor(episode.id, horizon)
    );
    const request: QuoteRequest = {
      inputMint: episode.mint,
      outputMint: USDC_MINT,
      inputAmountAtomic: episode.outputAmountAtomic
    };
    const quote = await this.options.quote(request);
    const observedAt = this.now().toISOString();
    if (!quoteUsable(quote, request, this.now())) throw new Error("LEARNING_EXIT_QUOTE_INVALID");
    const exitFee = modeledFeeUsd(quote, this.options.solPriceUsd());
    const executableValue = Math.max(0, quote.outputUsd - exitFee);
    const returnPercent = (executableValue - episode.inputCostUsd) / episode.inputCostUsd * 100;
    const updated: ShadowEpisode = {
      ...episode,
      maximumFavorableExcursionPercent: Math.max(episode.maximumFavorableExcursionPercent, returnPercent),
      maximumAdverseExcursionPercent: Math.min(episode.maximumAdverseExcursionPercent, returnPercent),
      lastObservedAt: observedAt,
      updatedAt: observedAt
    };
    this.learning.savePathObservation(pathObservation({
      episode: updated,
      phase: due.length > 0 ? "HORIZON" : "MARK",
      observedAt,
      executableValueUsd: quote.outputUsd,
      exitFeeUsd: exitFee,
      priceImpactPercent: quote.priceImpactPercent,
      solPriceUsd: this.options.solPriceUsd()
    }));
    for (const horizon of due) {
      const label = labelFor({
        episode: updated,
        horizon,
        observedAt,
        executableValueUsd: quote.outputUsd,
        exitFeeUsd: exitFee,
        solPriceUsd: this.options.solPriceUsd()
      });
      if (this.learning.saveOutcome(label)) this.learning.saveAttribution(attribution({ episode: updated, label }));
    }
    const completed = due.includes(180) || elapsedMinutes >= 180 && Boolean(this.learning.outcomeFor(episode.id, 180));
    this.learning.upsertEpisode({ ...updated, status: completed ? "COMPLETED" : "ACTIVE" });
    this.options.onUpdate?.({
      outcome: completed ? "SHADOW_COMPLETED" : due.length > 0 ? "SHADOW_LABELED" : "SHADOW_MARKED",
      episodeId: episode.id,
      mint: episode.mint
    });
  }

  private async process(): Promise<void> {
    this.drainOutbox();
    let workUnits = PROVIDER_WORK_UNITS_PER_RUN;
    for (const episode of this.learning.listEpisodes(["PENDING_QUOTE"], MAXIMUM_NEW_EPISODES_PER_SCAN)) {
      if (workUnits < 2) break;
      try {
        await this.openPendingEpisode(episode);
      } catch (error) {
        this.options.onError?.(error instanceof Error ? error : new Error("Learning entry quote failed safely."));
      }
      workUnits -= 2;
    }
    for (const storedEpisode of this.learning.listEpisodes(["ACTIVE"], MAXIMUM_OPEN_EPISODES)) {
      if (workUnits < 1) break;
      const episode = storedEpisode.featureVector.datasetEligible &&
          (storedEpisode.featureVector.missingFeatureNames?.length ?? 0) > 0
        ? {
            ...storedEpisode,
            featureVector: {
              ...storedEpisode.featureVector,
              datasetEligible: false
            },
            updatedAt: this.now().toISOString()
          }
        : storedEpisode;
      if (episode !== storedEpisode) this.learning.upsertEpisode(episode);
      const nextHorizon = OUTCOME_HORIZONS.find((horizon) => !this.learning.outcomeFor(episode.id, horizon));
      if (!episode.openedAt) continue;
      const nowMs = this.now().getTime();
      const horizonDue = Boolean(nextHorizon &&
        nowMs - Date.parse(episode.openedAt) >= nextHorizon * 60_000);
      const lastPath = this.learning.pathObservations(episode.id).at(-1);
      const pathDue = !lastPath ||
        nowMs - Date.parse(lastPath.observedAt) >= PATH_OBSERVATION_INTERVAL_MINUTES * 60_000;
      if (!horizonDue && !pathDue) continue;
      try {
        await this.observeEpisode(episode);
      } catch (error) {
        this.options.onError?.(error instanceof Error ? error : new Error("Learning follow-through quote failed safely."));
      }
      workUnits -= 1;
    }
    const eventTrainingDue = this.shouldTrainForNewLabels();
    if (eventTrainingDue || this.shouldTrainNightly()) {
      await this.train(false, eventTrainingDue ? "EVENT" : "NIGHTLY");
    }
  }

  private shouldTrainForNewLabels(): boolean {
    const policyVersion = this.cohortPolicyVersion();
    const latest = this.learning.getMeta<string>(this.latestTrainingMetaKey(policyVersion));
    if (latest && this.now().getTime() - Date.parse(latest) < EVENT_TRAINING_DEBOUNCE_MS) {
      return false;
    }
    const counts = this.learning.eligibleLabelCountsSince(latest, policyVersion);
    return counts.horizon45 >= EVENT_TRAINING_45M_LABELS ||
      counts.horizon180 >= EVENT_TRAINING_180M_LABELS;
  }

  private shouldTrainNightly(): boolean {
    const now = this.now();
    if (now.getUTCHours() < NIGHTLY_TRAINING_HOUR_UTC) return false;
    const latest = this.learning.getMeta<string>(this.latestTrainingMetaKey());
    return !latest || latest.slice(0, 10) !== now.toISOString().slice(0, 10);
  }

  async train(
    manual = true,
    reason: "EVENT" | "NIGHTLY" | "MANUAL" = manual ? "MANUAL" : "NIGHTLY"
  ): Promise<AutonomousLearningOverview> {
    if (this.training) throw new Error("Autonomous learning training is already running.");
    this.training = true;
    try {
      const cutoffAt = this.now().toISOString();
      const policyVersion = this.cohortPolicyVersion();
      const rows45 = this.learning.listTrainingRows(45, policyVersion);
      const rows = this.learning.listTrainingRows(180, policyVersion);
      const tacticalArtifacts = trainDeterministicModels(rows45, cutoffAt, 45, policyVersion).map((artifact) => ({
        ...artifact,
        active: false
      }));
      const artifacts = trainDeterministicModels(rows, cutoffAt, 180, policyVersion);
      this.learning.replaceActiveModels([...tacticalArtifacts, ...artifacts]);
      const activeModels = artifacts.filter((artifact) => artifact.active);
      const scores = this.buildArmScores(rows45, rows, activeModels);
      this.learning.replaceArmScores(scores, cutoffAt);
      const {
        challengers,
        folds,
        evaluatedScenarioCount
      } = this.buildChallengers(rows, artifacts[0]?.datasetDigest ?? digest([]), cutoffAt);
      this.learning.replaceChallengers(challengers, folds);
      const promotion = this.buildPromotionDecision(rows, challengers, folds, cutoffAt);
      this.learning.savePromotion(promotion);
      this.learning.setMeta("latest_training_at", cutoffAt, cutoffAt);
      this.learning.setMeta(this.latestTrainingMetaKey(policyVersion), cutoffAt, cutoffAt);
      this.learning.setMeta("latest_training_policy_version", policyVersion, cutoffAt);
      this.learning.setMeta("latest_training_reason", reason, cutoffAt);
      this.learning.setMeta(
        this.latestSimulationEvaluationsMetaKey(policyVersion),
        evaluatedScenarioCount,
        cutoffAt
      );
      this.options.onUpdate?.({ outcome: "LEARNING_TRAINED" });
    } finally {
      this.training = false;
      // Training replaces multiple durable model artifacts. Recheck the
      // database after that mutation boundary so a cached healthy status can
      // never survive a failed/corrupt training commit.
      this.refreshLearningIntegrityStatus();
    }
    return this.overview();
  }

  private buildArmScores(
    rows45: ReadonlyArray<{ episode: ShadowEpisode; label: OutcomeLabel }>,
    rows180: ReadonlyArray<{ episode: ShadowEpisode; label: OutcomeLabel }>,
    models: readonly ModelArtifact[]
  ): StrategyArmScore[] {
    const groups = new Map<string, {
      rows45: Array<{ episode: ShadowEpisode; label: OutcomeLabel }>;
      rows180: Array<{ episode: ShadowEpisode; label: OutcomeLabel }>;
    }>();
    for (const row of [...rows45, ...rows180]) {
      const key = `${row.episode.strategyArm}\u0000${row.episode.regime}`;
      const group = groups.get(key) ?? { rows45: [], rows180: [] };
      (row.label.horizonMinutes === 45 ? group.rows45 : group.rows180).push(row);
      groups.set(key, group);
    }
    return [...groups.entries()].map(([key, group]) => {
      const [strategyArm, regime] = key.split("\u0000") as [AutonomousPaperStrategyArm, MarketRegime];
      const policyVersion = group.rows180[0]?.episode.policyVersion ??
        group.rows45[0]?.episode.policyVersion ?? this.cohortPolicyVersion();
      const returns45 = group.rows45.map(({ label }) => label.netLogReturn);
      const returns = group.rows180.map(({ label }) => label.netLogReturn);
      const probabilityModel = models.find((model) => model.modelKind === "PROFITABILITY_PROBABILITY");
      const expectedModel = models.find((model) => model.modelKind === "EXPECTED_NET_LOG_RETURN");
      const adverseModel = models.find((model) => model.modelKind === "ADVERSE_TAIL_RETURN");
      const rewardModel = models.find((model) => model.modelKind === "RISK_ADJUSTED_REWARD");
      const learned = Boolean(
        probabilityModel && expectedModel && adverseModel && rewardModel && returns.length > 0
      );
      const empiricalMean = returns.length > 0
        ? returns.reduce((sum, value) => sum + value, 0) / returns.length
        : 0;
      const lower45 = clusteredConfidenceBound(group.rows45, (label) => label.netLogReturn, "LOWER");
      const upper45 = clusteredConfidenceBound(group.rows45, (label) => label.netLogReturn, "UPPER");
      const profitableProbability = learned
        ? group.rows180.reduce((sum, row) =>
            sum + predictLearningModel(probabilityModel!, row.episode.featureVector), 0) /
            group.rows180.length
        : returns.length > 0
          ? group.rows180.filter(({ label }) => label.profitable).length / returns.length
          : 0;
      const expected = learned
        ? group.rows180.reduce((sum, row) =>
            sum + predictLearningModel(expectedModel!, row.episode.featureVector), 0) /
            group.rows180.length
        : empiricalMean;
      const adverse = learned
        ? group.rows180.reduce((sum, row) =>
            sum + predictLearningModel(adverseModel!, row.episode.featureVector), 0) /
            group.rows180.length
        : returns.length > 0
          ? [...returns].sort((a, b) => a - b)[Math.floor((returns.length - 1) * 0.1)]!
          : 0;
      const lower = clusteredConfidenceBound(group.rows180, (label) => label.netLogReturn, "LOWER");
      const upper = clusteredConfidenceBound(group.rows180, (label) => label.netLogReturn, "UPPER");
      const empiricalReward = group.rows180.length > 0
        ? group.rows180.reduce(
            (sum, { label }) => sum + (label.riskAdjustedReward ?? label.netReturnPercent),
            0
          ) / group.rows180.length
        : 0;
      const expectedRiskAdjustedReward = learned
        ? group.rows180.reduce((sum, row) =>
            sum + predictLearningModel(rewardModel!, row.episode.featureVector) * 100,
          0) / group.rows180.length
        : empiricalReward;
      const lowerConfidenceRiskAdjustedReward = clusteredConfidenceBound(
        group.rows180,
        (label) => label.riskAdjustedReward ?? label.netReturnPercent,
        "LOWER"
      );
      const distinctMints = new Set(group.rows180.map(({ episode }) => episode.mint)).size;
      const distinctUtcDays = new Set(group.rows180.map(({ episode }) =>
        episode.openedAt?.slice(0, 10) ?? episode.createdAt.slice(0, 10))).size;
      const countShare = (values: readonly string[]) => values.length === 0 ? 0 :
        Math.max(...[...new Set(values)].map((value) =>
          values.filter((candidate) => candidate === value).length / values.length));
      const maximumMintShare = countShare(group.rows180.map(({ episode }) => episode.mint));
      const maximumDayShare = countShare(group.rows180.map(({ episode }) =>
        episode.openedAt?.slice(0, 10) ?? episode.createdAt.slice(0, 10)));
      const percentReturns = group.rows180.map(({ label }) => label.netReturnPercent);
      const grossProfit = percentReturns.filter((value) => value > 0)
        .reduce((sum, value) => sum + value, 0);
      const grossLoss = -percentReturns.filter((value) => value < 0)
        .reduce((sum, value) => sum + value, 0);
      const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0
        ? Number.POSITIVE_INFINITY : 0;
      const stressNetReturnPercent = group.rows180.reduce((sum, { episode, label }) => {
        const costPercent = label.totalModeledCostUsd /
          Math.max(episode.inputCostUsd ?? REFERENCE_INPUT_USD, 0.01) * 100;
        return sum + label.netReturnPercent - costPercent - 0.1;
      }, 0);
      const shadowOnly = strategyArm === "EARLY_LIQUIDITY" ||
        strategyArm === "CONTROLLED_EXPLORATION" ||
        strategyArm === "SIMULATION_PROBE" ||
        strategyArm === "NEGATIVE_CONTROL";
      const quarantined = (returns45.length >= 15 && upper45 < 0) ||
        (returns.length >= 10 && upper < 0);
      const eligible = learned && !quarantined && !shadowOnly &&
        returns45.length >= MINIMUM_SEGMENT_45M_PATHS &&
        returns.length >= MINIMUM_SEGMENT_180M_PATHS &&
        distinctUtcDays >= MINIMUM_SEGMENT_DAYS &&
        distinctMints >= MINIMUM_SEGMENT_MINTS &&
        maximumMintShare <= MAXIMUM_SEGMENT_MINT_SHARE &&
        maximumDayShare <= MAXIMUM_SEGMENT_DAY_SHARE &&
        lower45 > 0 && lower > 0 && profitFactor >= MINIMUM_SEGMENT_PROFIT_FACTOR &&
        stressNetReturnPercent >= 0 && lowerConfidenceRiskAdjustedReward > 0;
      return {
        strategyArm,
        regime,
        policyVersion,
        sampleCount: returns.length,
        profitableProbability,
        expectedNetLogReturn: expected,
        adverseTailReturn: adverse,
        lowerConfidenceNetLogReturn: lower,
        expectedRiskAdjustedReward,
        lowerConfidenceRiskAdjustedReward,
        horizonMinutes: 180 as const,
        distinctMints,
        distinctUtcDays,
        profitFactor,
        stressNetReturnPercent,
        maximumMintShare,
        maximumDayShare,
        quarantined,
        learned,
        eligibleForChampion: eligible,
        reasonCodes: [
          ...(returns45.length < MINIMUM_SEGMENT_45M_PATHS ? ["SEGMENT_NEEDS_30_45M_PATHS"] : []),
          ...(returns.length < MINIMUM_SEGMENT_180M_PATHS ? ["SEGMENT_NEEDS_20_180M_PATHS"] : []),
          ...(distinctUtcDays < MINIMUM_SEGMENT_DAYS ? ["SEGMENT_NEEDS_5_UTC_DAYS"] : []),
          ...(distinctMints < MINIMUM_SEGMENT_MINTS ? ["SEGMENT_NEEDS_10_MINTS"] : []),
          ...(maximumMintShare > MAXIMUM_SEGMENT_MINT_SHARE ? ["MINT_CONCENTRATION_TOO_HIGH"] : []),
          ...(maximumDayShare > MAXIMUM_SEGMENT_DAY_SHARE ? ["DAY_CONCENTRATION_TOO_HIGH"] : []),
          ...(lower45 <= 0 ? ["LOWER_45M_CONFIDENCE_RETURN_NOT_POSITIVE"] : []),
          ...(lower <= 0 ? ["LOWER_180M_CONFIDENCE_RETURN_NOT_POSITIVE"] : []),
          ...(profitFactor < MINIMUM_SEGMENT_PROFIT_FACTOR ? ["PROFIT_FACTOR_BELOW_1_2"] : []),
          ...(stressNetReturnPercent < 0 ? ["DOUBLED_COST_DELAY_STRESS_NEGATIVE"] : []),
          ...(lowerConfidenceRiskAdjustedReward <= 0 ? ["RISK_ADJUSTED_REWARD_NOT_POSITIVE"] : []),
          ...(quarantined ? ["SEGMENT_QUARANTINED_NEGATIVE_UPPER_BOUND"] : []),
          ...(shadowOnly ? ["SHADOW_ONLY_ARM"] : []),
          ...(!learned ? ["GLOBAL_MODEL_NEEDS_200_PATHS"] : [])
        ]
      };
    }).sort((left, right) =>
      right.lowerConfidenceNetLogReturn - left.lowerConfidenceNetLogReturn ||
      left.strategyArm.localeCompare(right.strategyArm) ||
      left.regime.localeCompare(right.regime)
    );
  }

  private buildChallengers(
    rows: ReadonlyArray<{ episode: ShadowEpisode; label: OutcomeLabel }>,
    datasetDigest: string,
    at: string
  ): {
    challengers: PolicyChallenger[];
    folds: WalkForwardResult[];
    evaluatedScenarioCount: number;
  } {
    if (rows.length < 10) {
      return { challengers: [], folds: [], evaluatedScenarioCount: 0 };
    }
    const ordered = [...rows].sort((left, right) =>
      Date.parse(left.label.observedAt) - Date.parse(right.label.observedAt) ||
      left.episode.id.localeCompare(right.episode.id)
    );
    const split = Math.max(1, Math.floor(ordered.length * 0.6));
    const tentativeTest = ordered.slice(split);
    const testStartAt = tentativeTest[0]?.label.observedAt ?? at;
    const embargoCutoff = Date.parse(testStartAt) - 24 * 60 * 60_000;
    const testMints = new Set(tentativeTest.map(({ episode }) => episode.mint));
    const development = ordered.slice(0, split).filter(({ episode, label }) =>
      Date.parse(label.observedAt) <= embargoCutoff && !testMints.has(episode.mint)
    );
    const holdout = tentativeTest;
    if (development.length === 0 || holdout.length === 0) {
      return { challengers: [], folds: [], evaluatedScenarioCount: 0 };
    }
    const pathCache = new Map(rows.map(({ episode }) => [
      episode.id,
      this.learning.pathObservations(episode.id)
    ]));
    interface CandidatePolicy {
      minimumBuy5m: number;
      minimumBuy1h: number;
      minimumAcceleration: number;
      maximumCost: number;
      stop: number;
      target: number;
      hold: number;
    }
    const matches = (
      row: { episode: ShadowEpisode; label: OutcomeLabel },
      policy: CandidatePolicy
    ) => row.episode.featureVector.datasetEligible &&
      !row.episode.featureVector.negativeControl &&
      row.episode.featureVector.organicBuyShare5m >= policy.minimumBuy5m &&
      row.episode.featureVector.organicBuyShare1h >= policy.minimumBuy1h &&
      row.episode.featureVector.volumeAccelerationRatio >= policy.minimumAcceleration &&
      row.episode.featureVector.projectedRoundTripCostPercent <= policy.maximumCost;
    const returnsFor = (
      selected: ReadonlyArray<{ episode: ShadowEpisode; label: OutcomeLabel }>,
      policy: CandidatePolicy
    ) => selected.filter((row) => matches(row, policy)).map((row) =>
      policyReturn(row, policy, pathCache.get(row.episode.id) ?? [])
    ).filter((value): value is number => value !== undefined);
    const metrics = (returns: readonly number[]) => {
      const grossProfit = returns.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
      const grossLoss = -returns.filter((value) => value < 0).reduce((sum, value) => sum + value, 0);
      const total = returns.reduce((sum, value) => sum + value, 0);
      const largest = Math.max(0, ...returns);
      const stress = returns.reduce((sum, value) => sum + value - Math.abs(value) * 0.01 - 0.5, 0);
      return {
        grossProfit,
        grossLoss,
        total,
        largest,
        stress,
        profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0
          ? Number.MAX_SAFE_INTEGER : 0,
        drawdown: drawdownPercent(returns)
      };
    };
    const candidates: Array<{ policy: CandidatePolicy; developmentReturns: number[]; id: string }> = [];
    let evaluatedScenarioCount = 0;
    for (const minimumBuy5m of SIMULATION_MINIMUM_BUY_5M) {
      for (const minimumBuy1h of SIMULATION_MINIMUM_BUY_1H) {
       for (const minimumAcceleration of SIMULATION_MINIMUM_ACCELERATION) {
        for (const maximumCost of SIMULATION_MAXIMUM_COST) {
         for (const stop of SIMULATION_STOP_LOSSES) {
          for (const target of SIMULATION_TAKE_PROFITS) {
          for (const hold of SIMULATION_MAXIMUM_HOLDS) {
            const policy = {
              minimumBuy5m,
              minimumBuy1h,
              minimumAcceleration,
              maximumCost,
              stop,
              target,
              hold
            };
            const developmentReturns = returnsFor(development, policy);
            evaluatedScenarioCount += developmentReturns.length;
            if (developmentReturns.length === 0) continue;
            const id = stableId("learning-challenger-v1", {
              datasetDigest, minimumBuy5m, minimumBuy1h, minimumAcceleration,
              maximumCost, stop, target, hold
            });
            candidates.push({ id, policy, developmentReturns });
          }
          }
         }
        }
       }
      }
    }
    const ranked = candidates.map((candidate) => ({
      ...candidate,
      developmentMetrics: metrics(candidate.developmentReturns)
    })).sort((left, right) =>
      Number(right.developmentMetrics.stress >= 0) - Number(left.developmentMetrics.stress >= 0) ||
      right.developmentMetrics.total - left.developmentMetrics.total ||
      left.developmentMetrics.drawdown - right.developmentMetrics.drawdown ||
      left.id.localeCompare(right.id)
    ).slice(0, 5);
    const top = ranked.map((candidate, index) => {
      const holdoutReturns = returnsFor(holdout, candidate.policy);
      evaluatedScenarioCount += holdoutReturns.length;
      const holdoutMetrics = metrics(holdoutReturns);
      const selectedHoldoutRows = holdout.filter((row) => matches(row, candidate.policy)).length;
      const densePathCoveragePercent = selectedHoldoutRows > 0
        ? holdoutReturns.length / selectedHoldoutRows * 100
        : 0;
      return {
        id: candidate.id,
        policyVersion: "autonomous-learning-challenger-v3",
        rank: index + 1,
        status: holdoutReturns.length >= 300 && holdoutMetrics.total > 0 &&
          holdoutMetrics.profitFactor >= 1.3 && holdoutMetrics.drawdown <= 25 &&
          holdoutMetrics.stress >= 0 &&
          (holdoutMetrics.grossProfit > 0
            ? holdoutMetrics.largest / holdoutMetrics.grossProfit * 100
            : 100) <= 25 && densePathCoveragePercent >= 95
          ? "PROMOTABLE" as const
          : "SHADOW" as const,
        minimumScore: candidate.policy.minimumBuy5m - 0.5,
        minimumOrganicBuyShare5m: candidate.policy.minimumBuy5m,
        minimumOrganicBuyShare1h: candidate.policy.minimumBuy1h,
        minimumVolumeAccelerationRatio: candidate.policy.minimumAcceleration,
        maximumRoundTripCostPercent: candidate.policy.maximumCost,
        stopLossPercent: candidate.policy.stop,
        takeProfitPercent: candidate.policy.target,
        maximumHoldingMinutes: candidate.policy.hold,
        completedPaths: holdoutReturns.length,
        scorablePathCount: holdoutReturns.length,
        densePathCoveragePercent,
        netReturnPercent: holdoutMetrics.total,
        profitFactor: holdoutMetrics.profitFactor,
        maximumDrawdownPercent: holdoutMetrics.drawdown,
        stressNetReturnPercent: holdoutMetrics.stress,
        largestProfitContributionPercent: holdoutMetrics.grossProfit > 0
          ? holdoutMetrics.largest / holdoutMetrics.grossProfit * 100
          : 100,
        datasetDigest,
        createdAt: at
      } satisfies PolicyChallenger;
    });
    const folds: WalkForwardResult[] = [];
    for (const challenger of top) {
      const policy: CandidatePolicy = {
        minimumBuy5m: challenger.minimumOrganicBuyShare5m ?? challenger.minimumScore + 0.5,
        minimumBuy1h: challenger.minimumOrganicBuyShare1h ?? 0.48,
        minimumAcceleration: challenger.minimumVolumeAccelerationRatio ?? 0,
        maximumCost: challenger.maximumRoundTripCostPercent ?? MAXIMUM_TRAINABLE_ROUND_TRIP_COST_PERCENT,
        stop: challenger.stopLossPercent,
        target: challenger.takeProfitPercent,
        hold: challenger.maximumHoldingMinutes
      };
      for (let fold = 0; fold < 5; fold += 1) {
        const start = Math.floor(holdout.length * fold / 5);
        const end = Math.floor(holdout.length * (fold + 1) / 5);
        const test = holdout.slice(start, end).filter((row) => matches(row, policy));
        const returns = returnsFor(test, policy);
        const testStartAt = test[0]?.label.observedAt ?? at;
        const testEndAt = test.at(-1)?.label.observedAt ?? testStartAt;
        folds.push({
          id: stableId("learning-walk-forward-v1", { challengerId: challenger.id, fold }),
          challengerId: challenger.id,
          fold: fold + 1,
          trainingStartAt: development[0]?.episode.createdAt ?? at,
          trainingEndAt: new Date(Math.max(0, embargoCutoff)).toISOString(),
          testStartAt,
          testEndAt,
          embargoHours: 24,
          trainingEpisodeCount: development.length,
          selectedOnTrainingOnly: true,
          episodeCount: test.length,
          netReturnPercent: returns.reduce((sum, value) => sum + value, 0),
          maximumDrawdownPercent: drawdownPercent(returns),
          profitable: returns.length > 0 && returns.reduce((sum, value) => sum + value, 0) > 0,
          createdAt: at
        });
      }
    }
    return { challengers: top, folds, evaluatedScenarioCount };
  }

  private buildPromotionDecision(
    rows: ReadonlyArray<{ episode: ShadowEpisode; label: OutcomeLabel }>,
    challengers: readonly PolicyChallenger[],
    folds: readonly WalkForwardResult[],
    at: string
  ): ChampionPromotionDecision {
    const challenger = challengers[0];
    const observedDays = rows.length === 0 ? 0 : Math.max(1, Math.ceil(
      (Date.parse(rows.at(-1)!.label.observedAt) - Date.parse(rows[0]!.episode.createdAt)) / 86_400_000
    ));
    const championCompletedExits = this.repository.activeAutonomousPaperLane()
      ? this.repository.getAutonomousPaperAccount(this.repository.activeAutonomousPaperLane()!.id)?.completedTrades ?? 0
      : 0;
    const profitableFolds = challenger
      ? folds.filter((fold) => fold.challengerId === challenger.id && fold.profitable).length
      : 0;
    const clusteredLowerDifference = clusteredConfidenceBound(
      rows,
      (label) => label.excessReturnPercent ?? label.netReturnPercent,
      "LOWER"
    );
    const lowerDifference = Number.isFinite(clusteredLowerDifference) ? clusteredLowerDifference : -100;
    const activeModelCount = this.learning.activeModels().filter((model) =>
      model.policyVersion === this.cohortPolicyVersion()
    ).length;
    const blockers = [
      ...(observedDays < 30 ? ["NEEDS_30_CONSECUTIVE_OBSERVED_DAYS"] : []),
      ...(rows.length < 300 ? ["NEEDS_300_EXECUTABLE_SHADOW_PATHS"] : []),
      ...(activeModelCount !== AUTONOMOUS_MODEL_REQUIRED_ARTIFACTS
        ? ["VALIDATED_MODEL_FAMILY_INACTIVE"]
        : []),
      ...(championCompletedExits < 100 ? ["NEEDS_100_CHAMPION_PAPER_EXITS"] : []),
      ...(!challenger || challenger.netReturnPercent <= 0 ? ["NET_RETURN_NOT_POSITIVE"] : []),
      ...(!challenger || challenger.profitFactor < 1.3 ? ["PROFIT_FACTOR_BELOW_1_3"] : []),
      ...(profitableFolds < 4 ? ["NEEDS_4_OF_5_PROFITABLE_WALK_FORWARD_FOLDS"] : []),
      ...(!challenger || challenger.maximumDrawdownPercent > 25 ? ["DRAWDOWN_ABOVE_25_PERCENT"] : []),
      ...(!challenger || challenger.stressNetReturnPercent < 0 ? ["STRESS_REPLAY_NEGATIVE"] : []),
      ...(!challenger || challenger.largestProfitContributionPercent > 25 ? ["PROFIT_TOO_CONCENTRATED"] : []),
      ...(!challenger || (challenger.densePathCoveragePercent ?? 0) < 95
        ? ["DENSE_PATH_COVERAGE_BELOW_95_PERCENT"]
        : []),
      ...(lowerDifference <= 0 ? ["LOWER_90_PERCENT_CONFIDENCE_NOT_POSITIVE"] : [])
    ];
    return {
      id: stableId("learning-promotion-v1", { challengerId: challenger?.id, at, blockers }),
      ...(challenger ? { challengerId: challenger.id } : {}),
      allowed: blockers.length === 0,
      blockerCodes: blockers,
      observedDays,
      executableShadowPaths: rows.length,
      championCompletedExits,
      profitableWalkForwardFolds: profitableFolds,
      lowerConfidenceDifferencePercent: lowerDifference,
      decidedAt: at
    };
  }

  requestPromotion(confirmation: string): ChampionPromotionDecision {
    if (confirmation !== "PROMOTE AUTONOMOUS CHALLENGER") {
      throw new Error("Autonomous champion promotion requires exact typed confirmation.");
    }
    const decision = this.learning.latestPromotion() ?? this.buildPromotionDecision([], [], [], this.now().toISOString());
    if (!decision.allowed) {
      throw new Error(`Autonomous challenger promotion is blocked: ${decision.blockerCodes.join(", ")}`);
    }
    return decision;
  }

  score(features: LearningFeatureVector): StrategyArmScore | undefined {
    return this.learning.listArmScores().find((score) =>
      score.strategyArm === features.strategyArm && score.regime === features.regime &&
      score.policyVersion === this.cohortPolicyVersion()
    );
  }

  overview(): AutonomousLearningOverview {
    const counts = this.learning.episodeCounts();
    const policyVersion = this.cohortPolicyVersion();
    const cohortCounts = this.learning.episodeCounts(policyVersion);
    const activeModels = this.learning.activeModels().filter((model) => model.policyVersion === policyVersion);
    const promotion = this.learning.latestPromotion() ?? this.buildPromotionDecision([], [], [], this.now().toISOString());
    const latestTrainingAt = this.learning.getMeta<string>(this.latestTrainingMetaKey(policyVersion));
    const currentRegime = this.learning.getMeta<MarketRegime>("current_regime") ?? "UNKNOWN";
    const newLabels = this.learning.eligibleLabelCountsSince(latestTrainingAt, policyVersion);
    const cohortRows180 = this.learning.listTrainingRows(180, policyVersion);
    const strategyRows180 = cohortRows180.filter((row) => !row.episode.featureVector.negativeControl);
    const densePaths = cohortRows180.filter((row) => policyReturn(
      row,
      { stop: 100, target: 100, hold: 180 },
      this.learning.pathObservations(row.episode.id)
    ) !== undefined).length;
    const denseStrategyPaths = strategyRows180.filter((row) => policyReturn(
      row,
      { stop: 100, target: 100, hold: 180 },
      this.learning.pathObservations(row.episode.id)
    ) !== undefined).length;
    const densePathCoveragePercent = cohortRows180.length > 0
      ? densePaths / cohortRows180.length * 100
      : 0;
    const simulationProbeCounts = this.learning.episodeCountsForArm(
      "SIMULATION_PROBE",
      policyVersion
    );
    const challengers = this.learning.activeChallengers();
    const latestScorableScenarioEvaluations =
      this.learning.getMeta<number>(this.latestSimulationEvaluationsMetaKey(policyVersion)) ?? 0;
    const quotePopulation = cohortCounts.pending + cohortCounts.active + cohortCounts.completed +
      cohortCounts.rejected + cohortCounts.unpriced;
    const quoteCoveragePercent = quotePopulation > 0
      ? (cohortCounts.active + cohortCounts.completed) / quotePopulation * 100
      : 0;
    const debounceEndsAt = latestTrainingAt
      ? new Date(Date.parse(latestTrainingAt) + EVENT_TRAINING_DEBOUNCE_MS).toISOString()
      : undefined;
    const eventTrainingDue = newLabels.horizon45 >= EVENT_TRAINING_45M_LABELS ||
      newLabels.horizon180 >= EVENT_TRAINING_180M_LABELS;
    return {
      databaseSchemaVersion: LEARNING_SCHEMA_VERSION,
      status: this.training
        ? "TRAINING"
        : this.learningIntegrityStatus !== "ok"
          ? "DEGRADED"
          : activeModels.length === AUTONOMOUS_MODEL_REQUIRED_ARTIFACTS ? "READY" : "COLLECTING",
      currentRegime,
      pendingEpisodes: counts.pending,
      activeEpisodes: counts.active,
      completedExecutablePaths: counts.completed,
      cohortPendingEpisodes: cohortCounts.pending,
      cohortActiveEpisodes: cohortCounts.active,
      cohortCompletedEpisodes: cohortCounts.completed,
      datasetEligiblePaths: counts.datasetEligible,
      policyCohortVersion: policyVersion,
      cohortDatasetEligiblePaths: cohortCounts.datasetEligible,
      historicalDatasetEligiblePaths: Math.max(0, counts.datasetEligible - cohortCounts.datasetEligible),
      pathObservationCount: this.learning.pathObservationCount(policyVersion),
      densePathCoveragePercent,
      quoteCoveragePercent,
      modelInfluenceEnabled: activeModels.length === AUTONOMOUS_MODEL_REQUIRED_ARTIFACTS &&
        cohortCounts.datasetEligible >= AUTONOMOUS_MODEL_MINIMUM_PATHS,
      minimumPathsForModelInfluence: AUTONOMOUS_MODEL_MINIMUM_PATHS,
      quoteWorkBudgetFraction: PROVIDER_WORK_BUDGET_FRACTION,
      ...(latestTrainingAt ? { latestTrainingAt } : {}),
      activeModels,
      armScores: this.learning.listArmScores().filter((score) => score.policyVersion === policyVersion),
      admissions: this.learning.recentAdmissions(20, policyVersion),
      calibrations: ([45, 180] as const).map((horizonMinutes) => {
        const rows = this.learning.listTrainingRows(horizonMinutes, policyVersion);
        const family = this.learning.latestModelFamily(horizonMinutes, policyVersion);
        const probability = family.find((model) => model.modelKind === "PROFITABILITY_PROBABILITY");
        const returnModel = family.find((model) => model.modelKind === "EXPECTED_NET_LOG_RETURN");
        const reasonCodes = [...new Set([
          ...(family.flatMap((model) => model.validationReasonCodes ?? [])),
          ...(horizonMinutes === 45 ? ["TACTICAL_HORIZON_USED_FOR_ADMISSION_SAFETY"] : []),
          ...(family.length === 0 ? ["POLICY_COHORT_HAS_NO_MODEL_ARTIFACT"] : [])
        ])];
        return {
          horizonMinutes,
          policyVersion,
          independentEpisodeCount: rows.length,
          trainingEpisodeCount: probability?.trainingEpisodeCount ?? 0,
          validationEpisodeCount: probability?.validationEpisodeCount ?? 0,
          distinctMints: new Set(rows.map(({ episode }) => episode.mint)).size,
          distinctUtcDays: new Set(rows.map(({ episode }) => episode.createdAt.slice(0, 10))).size,
          ...(probability?.brierScore !== undefined ? { brierScore: probability.brierScore } : {}),
          ...(returnModel?.meanAbsoluteError !== undefined
            ? { meanAbsoluteReturnError: returnModel.meanAbsoluteError }
            : {}),
          ...(probability?.expectedCalibrationError !== undefined
            ? { expectedCalibrationError: probability.expectedCalibrationError }
            : {}),
          featureCoverage: probability?.featureCoverage ?? 0,
          driftScore: probability?.driftScore ?? 1,
          active: horizonMinutes === 180 &&
            activeModels.length === AUTONOMOUS_MODEL_REQUIRED_ARTIFACTS,
          reasonCodes
        };
      }),
      scheduler: {
        activeCapacity: MAXIMUM_OPEN_EPISODES,
        maximumNewPerScan: MAXIMUM_NEW_EPISODES_PER_SCAN,
        newEligible45mLabelsSinceTraining: newLabels.horizon45,
        newEligible180mLabelsSinceTraining: newLabels.horizon180,
        eventTrainingDue,
        ...(debounceEndsAt ? { earliestNextTrainingAt: debounceEndsAt } : {}),
        nextTrainingReason: eventTrainingDue ? "EVENT" : "NOT_DUE"
      },
      simulationArena: {
        version: SIMULATION_ARENA_VERSION,
        status: challengers.length > 0
          ? "LEADER_AVAILABLE"
          : strategyRows180.length >= 10 ? "EVALUATING" : "COLLECTING",
        candidatePolicyCount: SIMULATION_ARENA_POLICY_COUNT,
        pendingOrActiveProbePaths: simulationProbeCounts.pending + simulationProbeCounts.active,
        completedProbePaths: simulationProbeCounts.completed,
        datasetEligibleProbePaths: simulationProbeCounts.datasetEligible,
        independentPathCount: strategyRows180.length,
        denseIndependentPathCount: denseStrategyPaths,
        latestScorableScenarioEvaluations,
        capitalInfluenceEnabled: false,
        correlatedScenariosAreIndependentEvidence: false,
        reasonCodes: [
          "SIMULATION_PROBES_CANNOT_USE_CAPITAL",
          "POLICY_VARIANTS_ARE_CORRELATED_COUNTERFACTUALS",
          ...(strategyRows180.length < 10 ? ["NEEDS_10_INDEPENDENT_STRATEGY_PATHS"] : []),
          ...(denseStrategyPaths < strategyRows180.length
            ? ["SOME_PATHS_LACK_DENSE_EXECUTABLE_MARKS"]
            : [])
        ]
      },
      challengers,
      recentAttributions: this.learning.recentAttributions(20, policyVersion),
      promotion,
      updatedAt: this.now().toISOString()
    };
  }
}
