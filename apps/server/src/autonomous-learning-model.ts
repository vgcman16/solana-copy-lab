import { createHash } from "node:crypto";
import {
  AUTONOMOUS_LEARNING_FEATURE_VERSION,
  type LearningFeatureVector,
  type ModelArtifact,
  type OutcomeLabel,
  type ShadowEpisode
} from "@copylab/shared";

export const AUTONOMOUS_MODEL_MINIMUM_PATHS = 200;
export const AUTONOMOUS_SEGMENT_MINIMUM_PATHS = 30;
export const AUTONOMOUS_MODEL_REQUIRED_ARTIFACTS = 4;
export const AUTONOMOUS_MODEL_VERSION = "deterministic-purged-validation-model-v2";
const MINIMUM_VALIDATION_PATHS = 40;
const MINIMUM_PURGED_TRAINING_PATHS = 100;
const MINIMUM_DISTINCT_MINTS = 20;
const MINIMUM_DISTINCT_UTC_DAYS = 5;
const EMBARGO_MS = 24 * 60 * 60_000;

export const LEARNING_MODEL_FEATURE_NAMES = Object.freeze([
  "tokenAge",
  "liquidity",
  "volume24h",
  "holderBreadth",
  "organicScore",
  "topHolderSafety",
  "change5m",
  "change1h",
  "change6h",
  "change24h",
  "organicBuy5m",
  "organicBuy1h",
  "volumeAcceleration",
  "liquidityFlow",
  "solRelativeStrength",
  "categoryBreadth",
  "categoryRankQuality",
  "roundTripCostQuality",
  "impactQuality",
  "walletConfirmed",
  "armMomentum",
  "armExploration",
  "armBreakout",
  "armPullback",
  "armWallet",
  "armNegativeControl",
  "regimeRiskOn",
  "regimeBroadRiskOn",
  "regimeChoppy",
  "regimeHighVolatility",
  "regimeRiskOff"
] as const);

function clamp(value: number, minimum = -1, maximum = 1): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function finite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

/** Fixed transforms make artifacts replayable without persisting mutable
 * means/variances and keep every input bounded for deterministic training. */
export function vectorizeLearningFeatures(features: LearningFeatureVector): number[] {
  const arm = features.strategyArm;
  const regime = features.regime;
  return [
    clamp(finite(features.tokenAgeDays) / 30, 0, 1),
    clamp((finite(features.logLiquidityUsd) - 10) / 10),
    clamp((finite(features.logVolume24hUsd) - 10) / 10),
    clamp(finite(features.holderBreadth) / 10_000, 0, 1),
    clamp(finite(features.organicScore) / 100, 0, 1),
    clamp(1 - finite(features.topHoldersPercent, 100) / 100, 0, 1),
    clamp(finite(features.priceChange5mPercent) / 20),
    clamp(finite(features.priceChange1hPercent) / 40),
    clamp(finite(features.priceChange6hPercent) / 100),
    clamp(finite(features.priceChange24hPercent) / 200),
    clamp(finite(features.organicBuyShare5m), 0, 1),
    clamp(finite(features.organicBuyShare1h), 0, 1),
    clamp(finite(features.volumeAccelerationRatio) / 2, 0, 1),
    clamp(finite(features.liquidityChange1hPercent) / 20),
    clamp(finite(features.solRelativeStrength1hPercent) / 40),
    clamp(finite(features.categoryBreadth) / 7, 0, 1),
    clamp(1 - finite(features.bestCategoryRank, 100) / 100, 0, 1),
    clamp(1 - finite(features.projectedRoundTripCostPercent, 100) / 5, 0, 1),
    clamp(1 - Math.max(
      finite(features.buyPriceImpactPercent, 100),
      finite(features.sellPriceImpactPercent, 100)
    ) / 3, 0, 1),
    features.walletConfirmed ? 1 : 0,
    arm === "MOMENTUM" || arm === "MOMENTUM_CONTINUATION" ? 1 : 0,
    arm === "CONTROLLED_EXPLORATION" || arm === "SIMULATION_PROBE" ? 1 : 0,
    arm === "BREAKOUT" ? 1 : 0,
    arm === "PULLBACK_RECLAIM" ? 1 : 0,
    arm === "WALLET_CONFIRMED_MOMENTUM" ? 1 : 0,
    arm === "NEGATIVE_CONTROL" ? 1 : 0,
    regime === "RISK_ON_TREND" ? 1 : 0,
    regime === "BROAD_RISK_ON" ? 1 : 0,
    regime === "CHOPPY" ? 1 : 0,
    regime === "HIGH_VOLATILITY" ? 1 : 0,
    regime === "RISK_OFF" ? 1 : 0
  ];
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function dot(left: readonly number[], right: readonly number[]): number {
  let sum = 0;
  for (let index = 0; index < left.length; index += 1) sum += left[index]! * right[index]!;
  return sum;
}

function sigmoid(value: number): number {
  if (value >= 0) {
    const z = Math.exp(-Math.min(value, 40));
    return 1 / (1 + z);
  }
  const z = Math.exp(Math.max(value, -40));
  return z / (1 + z);
}

function logisticFit(rows: readonly number[][], labels: readonly number[]): {
  coefficients: number[];
  intercept: number;
} {
  const width = rows[0]?.length ?? LEARNING_MODEL_FEATURE_NAMES.length;
  const coefficients = Array.from({ length: width }, () => 0);
  let intercept = 0;
  const lambda = 0.02;
  const learningRate = 0.12;
  for (let iteration = 0; iteration < 600; iteration += 1) {
    let interceptGradient = 0;
    const gradients = Array.from({ length: width }, () => 0);
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      const error = sigmoid(intercept + dot(coefficients, rows[rowIndex]!)) - labels[rowIndex]!;
      interceptGradient += error;
      for (let featureIndex = 0; featureIndex < width; featureIndex += 1) {
        gradients[featureIndex] = gradients[featureIndex]! + error * rows[rowIndex]![featureIndex]!;
      }
    }
    const denominator = Math.max(1, rows.length);
    intercept -= learningRate * interceptGradient / denominator;
    for (let featureIndex = 0; featureIndex < width; featureIndex += 1) {
      const regularized = gradients[featureIndex]! / denominator + lambda * coefficients[featureIndex]!;
      coefficients[featureIndex] = coefficients[featureIndex]! - learningRate * regularized;
    }
  }
  return { coefficients, intercept };
}

function solve(matrix: number[][], values: number[]): number[] {
  const size = values.length;
  const augmented = matrix.map((row, index) => [...row, values[index]!]);
  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(augmented[row]![column]!) > Math.abs(augmented[pivot]![column]!)) pivot = row;
    }
    [augmented[column], augmented[pivot]] = [augmented[pivot]!, augmented[column]!];
    const divisor = Math.abs(augmented[column]![column]!) < 1e-12
      ? 1e-12
      : augmented[column]![column]!;
    for (let index = column; index <= size; index += 1) augmented[column]![index]! /= divisor;
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = augmented[row]![column]!;
      for (let index = column; index <= size; index += 1) {
        augmented[row]![index]! -= factor * augmented[column]![index]!;
      }
    }
  }
  return augmented.map((row) => row[size]!);
}

function ridgeFit(rows: readonly number[][], labels: readonly number[]): {
  coefficients: number[];
  intercept: number;
} {
  const width = rows[0]?.length ?? LEARNING_MODEL_FEATURE_NAMES.length;
  const expanded = rows.map((row) => [1, ...row]);
  const size = width + 1;
  const matrix = Array.from({ length: size }, () => Array.from({ length: size }, () => 0));
  const values = Array.from({ length: size }, () => 0);
  for (let rowIndex = 0; rowIndex < expanded.length; rowIndex += 1) {
    const row = expanded[rowIndex]!;
    for (let left = 0; left < size; left += 1) {
      values[left] = values[left]! + row[left]! * labels[rowIndex]!;
      for (let right = 0; right < size; right += 1) matrix[left]![right]! += row[left]! * row[right]!;
    }
  }
  for (let index = 1; index < size; index += 1) matrix[index]![index]! += 0.05;
  const solution = solve(matrix, values);
  return { intercept: solution[0]!, coefficients: solution.slice(1) };
}

export interface LearningTrainingRow {
  episode: ShadowEpisode;
  label: OutcomeLabel;
}

function featureCoverage(rows: readonly LearningTrainingRow[]): number {
  if (rows.length === 0) return 0;
  return rows.reduce((sum, { episode }) => {
    const missing = new Set(episode.featureVector.missingFeatureNames ?? []);
    const vector = vectorizeLearningFeatures(episode.featureVector);
    const nonFinite = vector.filter((value) => !Number.isFinite(value)).length;
    return sum + Math.max(0, 1 - (missing.size + nonFinite) / LEARNING_MODEL_FEATURE_NAMES.length);
  }, 0) / rows.length;
}

function meanAbsoluteError(predictions: readonly number[], labels: readonly number[]): number {
  if (predictions.length === 0) return Number.POSITIVE_INFINITY;
  return predictions.reduce(
    (sum, prediction, index) => sum + Math.abs(prediction - labels[index]!),
    0
  ) / predictions.length;
}

function expectedCalibrationError(predictions: readonly number[], labels: readonly number[]): number {
  if (predictions.length === 0) return Number.POSITIVE_INFINITY;
  let weighted = 0;
  for (let bin = 0; bin < 10; bin += 1) {
    const lower = bin / 10;
    const upper = (bin + 1) / 10;
    const indexes = predictions.map((value, index) => ({ value, index })).filter(({ value }) =>
      value >= lower && (bin === 9 ? value <= upper : value < upper)
    );
    if (indexes.length === 0) continue;
    const predicted = indexes.reduce((sum, row) => sum + row.value, 0) / indexes.length;
    const actual = indexes.reduce((sum, row) => sum + labels[row.index]!, 0) / indexes.length;
    weighted += indexes.length / predictions.length * Math.abs(predicted - actual);
  }
  return weighted;
}

function featureDrift(training: readonly number[][], validation: readonly number[][]): number {
  if (training.length === 0 || validation.length === 0) return 1;
  let drift = 0;
  for (let feature = 0; feature < LEARNING_MODEL_FEATURE_NAMES.length; feature += 1) {
    const trainingMean = training.reduce((sum, row) => sum + row[feature]!, 0) / training.length;
    const validationMean = validation.reduce((sum, row) => sum + row[feature]!, 0) / validation.length;
    drift += Math.abs(trainingMean - validationMean) / 2;
  }
  return clamp(drift / LEARNING_MODEL_FEATURE_NAMES.length, 0, 1);
}

export function trainDeterministicModels(
  inputRows: readonly LearningTrainingRow[],
  cutoffAt: string,
  horizonMinutes: 45 | 180 = 180,
  policyVersion?: string
): ModelArtifact[] {
  const rows = inputRows
    .filter(({ episode, label }) =>
      episode.featureVector.version === AUTONOMOUS_LEARNING_FEATURE_VERSION &&
      label.datasetEligible && label.quoteExecutable && label.horizonMinutes === horizonMinutes &&
      (!policyVersion || episode.policyVersion === policyVersion) &&
      Date.parse(label.observedAt) <= Date.parse(cutoffAt)
    )
    .sort((left, right) =>
      Date.parse(left.label.observedAt) - Date.parse(right.label.observedAt) ||
      left.episode.id.localeCompare(right.episode.id)
  );
  if (rows.length === 0) return [];
  const validationCount = Math.max(1, Math.ceil(rows.length * 0.2));
  const validationRows = rows.slice(-validationCount);
  const validationStartAt = validationRows[0]!.label.observedAt;
  const validationMints = new Set(validationRows.map(({ episode }) => episode.mint));
  const embargoCutoff = Date.parse(validationStartAt) - EMBARGO_MS;
  const preValidationRows = rows.slice(0, -validationCount);
  const purgedTrainingRows = preValidationRows.filter(({ episode, label }) =>
    Date.parse(label.observedAt) <= embargoCutoff && !validationMints.has(episode.mint)
  );
  // Sparse early ledgers still produce an explicitly inactive diagnostic
  // artifact. Activation always requires the genuinely purged cohort below.
  const trainingRows = purgedTrainingRows.length > 0
    ? purgedTrainingRows
    : preValidationRows.length > 0 ? preValidationRows : rows;
  const trainingFeatures = trainingRows.map(({ episode }) => vectorizeLearningFeatures(episode.featureVector));
  const validationFeatures = validationRows.map(({ episode }) => vectorizeLearningFeatures(episode.featureVector));
  const targets = (selected: readonly LearningTrainingRow[]) => ({
    profitability: selected.map(({ label }) => label.profitable ? 1 : 0),
    logReturns: selected.map(({ label }) => clamp(label.netLogReturn, -0.5, 0.5)),
    adverse: selected.map(({ label }) => clamp(Math.min(0, label.netLogReturn), -0.5, 0)),
    reward: selected.map(({ label }) => clamp((label.riskAdjustedReward ?? label.netReturnPercent) / 100, -0.5, 0.5))
  });
  const trainingTargets = targets(trainingRows);
  const validationTargets = targets(validationRows);
  const datasetDigest = digest(rows.map(({ episode, label }) => ({
    episodeId: episode.id,
    featureVector: episode.featureVector,
    label
  })));
  // Artifact payloads are deterministic for a fixed dataset and cutoff. This
  // makes a retry byte-for-byte replayable and prevents wall-clock metadata
  // from changing an otherwise identical trained model.
  const createdAt = cutoffAt;
  const definitions = [
    {
      kind: "PROFITABILITY_PROBABILITY" as const,
      fit: logisticFit(trainingFeatures, trainingTargets.profitability),
      validationLabels: validationTargets.profitability
    },
    {
      kind: "EXPECTED_NET_LOG_RETURN" as const,
      fit: ridgeFit(trainingFeatures, trainingTargets.logReturns),
      validationLabels: validationTargets.logReturns
    },
    {
      kind: "ADVERSE_TAIL_RETURN" as const,
      fit: ridgeFit(trainingFeatures, trainingTargets.adverse),
      validationLabels: validationTargets.adverse
    },
    {
      kind: "RISK_ADJUSTED_REWARD" as const,
      fit: ridgeFit(trainingFeatures, trainingTargets.reward),
      validationLabels: validationTargets.reward
    }
  ];
  const evaluated = definitions.map(({ kind, fit, validationLabels }) => {
    const predictions = validationFeatures.map((row) => {
      const raw = fit.intercept + dot(fit.coefficients, row);
      return kind === "PROFITABILITY_PROBABILITY" ? sigmoid(raw) : raw;
    });
    const mae = meanAbsoluteError(predictions, validationLabels);
    const brierScore = kind === "PROFITABILITY_PROBABILITY"
      ? predictions.reduce(
          (sum, prediction, index) => sum + (prediction - validationLabels[index]!) ** 2,
          0
        ) / predictions.length
      : undefined;
    const calibrationError = kind === "PROFITABILITY_PROBABILITY"
      ? expectedCalibrationError(predictions, validationLabels)
      : undefined;
    return { kind, fit, validationLabels, predictions, mae, brierScore, calibrationError };
  });
  const coverage = featureCoverage(rows);
  const driftScore = featureDrift(trainingFeatures, validationFeatures);
  const distinctMints = new Set(rows.map(({ episode }) => episode.mint)).size;
  const distinctDays = new Set(rows.map(({ episode }) => episode.createdAt.slice(0, 10))).size;
  const probability = evaluated.find(({ kind }) => kind === "PROFITABILITY_PROBABILITY")!;
  const reasons = [
    ...(rows.length < AUTONOMOUS_MODEL_MINIMUM_PATHS ? ["MODEL_NEEDS_200_POLICY_COHORT_PATHS"] : []),
    ...(purgedTrainingRows.length < MINIMUM_PURGED_TRAINING_PATHS ? ["PURGED_TRAINING_NEEDS_100_PATHS"] : []),
    ...(validationRows.length < MINIMUM_VALIDATION_PATHS ? ["HOLDOUT_NEEDS_40_PATHS"] : []),
    ...(distinctMints < MINIMUM_DISTINCT_MINTS ? ["MODEL_NEEDS_20_DISTINCT_MINTS"] : []),
    ...(distinctDays < MINIMUM_DISTINCT_UTC_DAYS ? ["MODEL_NEEDS_5_DISTINCT_UTC_DAYS"] : []),
    ...(coverage < 0.98 ? ["FEATURE_COVERAGE_BELOW_98_PERCENT"] : []),
    ...(driftScore > 0.25 ? ["FEATURE_DRIFT_ABOVE_25_PERCENT"] : []),
    ...((probability.brierScore ?? 1) > 0.25 ? ["HOLDOUT_BRIER_ABOVE_0_25"] : []),
    ...((probability.calibrationError ?? 1) > 0.15 ? ["HOLDOUT_CALIBRATION_ERROR_ABOVE_0_15"] : []),
    ...(evaluated.some(({ kind, mae }) => kind !== "PROFITABILITY_PROBABILITY" && mae > 0.1)
      ? ["HOLDOUT_RETURN_ERROR_ABOVE_10_PERCENT"]
      : [])
  ];
  const active = reasons.length === 0;
  return evaluated.map(({ kind, fit, validationLabels, predictions, mae, brierScore, calibrationError }) => {
    const evaluationDigest = digest({
      kind,
      validationStartAt,
      validationEpisodeIds: validationRows.map(({ episode }) => episode.id),
      predictions,
      labels: validationLabels,
      brierScore,
      meanAbsoluteError: mae,
      expectedCalibrationError: calibrationError,
      featureCoverage: coverage,
      driftScore,
      validationReasonCodes: reasons
    });
    return {
      id: `learning-model:${digest({ kind, horizonMinutes, cutoffAt, datasetDigest, fit, evaluationDigest })}`,
      modelVersion: AUTONOMOUS_MODEL_VERSION,
      modelKind: kind,
      horizonMinutes,
      featureVersion: AUTONOMOUS_LEARNING_FEATURE_VERSION,
      featureNames: [...LEARNING_MODEL_FEATURE_NAMES],
      coefficients: fit.coefficients,
      intercept: fit.intercept,
      trainingCutoffAt: cutoffAt,
      independentEpisodeCount: rows.length,
      ...(policyVersion ? { policyVersion } : {}),
      trainingEpisodeCount: purgedTrainingRows.length,
      validationEpisodeCount: validationRows.length,
      validationStartAt,
      ...(brierScore !== undefined ? { brierScore } : {}),
      meanAbsoluteError: mae,
      ...(calibrationError !== undefined ? { expectedCalibrationError: calibrationError } : {}),
      featureCoverage: coverage,
      driftScore,
      validationPassed: active,
      validationReasonCodes: reasons,
      datasetDigest,
      evaluationDigest,
      active,
      createdAt
    } satisfies ModelArtifact;
  });
}

export function predictLearningModel(artifact: ModelArtifact, features: LearningFeatureVector): number {
  if (
    artifact.featureVersion !== AUTONOMOUS_LEARNING_FEATURE_VERSION ||
    artifact.featureNames.join("\u0000") !== LEARNING_MODEL_FEATURE_NAMES.join("\u0000") ||
    artifact.coefficients.length !== LEARNING_MODEL_FEATURE_NAMES.length
  ) throw new Error("Learning model artifact uses an incompatible causal feature schema.");
  const raw = artifact.intercept + dot(artifact.coefficients, vectorizeLearningFeatures(features));
  return artifact.modelKind === "PROFITABILITY_PROBABILITY" ? sigmoid(raw) : raw;
}
