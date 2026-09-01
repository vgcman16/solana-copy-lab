import { afterEach, describe, expect, it } from "vitest";
import {
  AUTONOMOUS_LEARNING_FEATURE_VERSION,
  type LearningAdmissionDecision,
  type LearningFeatureVector,
  type LearningPathObservation,
  type OutcomeLabel,
  type PolicyChallenger,
  type ShadowEpisode,
  type WalkForwardResult
} from "@copylab/shared";
import {
  AUTONOMOUS_MODEL_MINIMUM_PATHS,
  LEARNING_MODEL_FEATURE_NAMES,
  predictLearningModel,
  trainDeterministicModels,
  vectorizeLearningFeatures
} from "../src/autonomous-learning-model.js";
import {
  AutonomousLearningRepository,
  type LearningDatabase,
  openLearningDatabase
} from "../src/learning-database.js";

const START = "2026-07-01T00:00:00.000Z";
const CUTOFF = "2026-08-01T00:00:00.000Z";

function features(index = 0): LearningFeatureVector {
  const profitable = index % 2 === 0;
  return {
    version: AUTONOMOUS_LEARNING_FEATURE_VERSION,
    capturedAt: new Date(Date.parse(START) + index * 60 * 60_000).toISOString(),
    mint: `learning-mint-${index}`,
    strategyArm: index % 3 === 0 ? "BREAKOUT" : "MOMENTUM_CONTINUATION",
    regime: index % 4 === 0 ? "RISK_ON_TREND" : "CHOPPY",
    shadowOnly: false,
    tokenAgeDays: 10 + index % 30,
    logLiquidityUsd: Math.log1p(1_000_000 + index * 1_000),
    logVolume24hUsd: Math.log1p(2_000_000 + index * 2_000),
    holderBreadth: 2_000 + index,
    organicScore: profitable ? 90 : 55,
    topHoldersPercent: profitable ? 18 : 42,
    priceChange5mPercent: profitable ? 4 : -1,
    priceChange1hPercent: profitable ? 12 : -3,
    priceChange6hPercent: profitable ? 20 : -8,
    priceChange24hPercent: profitable ? 30 : -15,
    organicBuyShare5m: profitable ? 0.78 : 0.48,
    organicBuyShare1h: profitable ? 0.68 : 0.46,
    volumeAccelerationRatio: profitable ? 1.4 : 0.2,
    liquidityChange1hPercent: profitable ? 3 : -4,
    solRelativeStrength1hPercent: profitable ? 8 : -5,
    categoryBreadth: profitable ? 6 : 2,
    bestCategoryRank: profitable ? 3 : 70,
    projectedRoundTripCostPercent: profitable ? 0.8 : 3.5,
    buyPriceImpactPercent: profitable ? 0.2 : 1.5,
    sellPriceImpactPercent: profitable ? 0.3 : 1.8,
    walletConfirmed: index % 5 === 0,
    datasetEligible: true
  };
}

function episode(index = 0, overrides: Partial<ShadowEpisode> = {}): ShadowEpisode {
  const capturedAt = features(index).capturedAt;
  return {
    id: `episode-${index}`,
    sourceKey: `source-${index}`,
    laneId: "learning-lane",
    policyVersion: "autonomous-learning-paper-v10",
    mint: `learning-mint-${index}`,
    symbol: `L${index}`,
    strategyArm: features(index).strategyArm,
    regime: features(index).regime,
    status: "COMPLETED",
    shadowOnly: false,
    featureVector: features(index),
    referenceInputUsd: 20,
    inputCostUsd: 20.05,
    outputAmountAtomic: "1000000",
    tokenDecimals: 6,
    entryExecutableValueUsd: 19.8,
    maximumFavorableExcursionPercent: index % 2 === 0 ? 12 : 1,
    maximumAdverseExcursionPercent: index % 2 === 0 ? -2 : -10,
    openedAt: capturedAt,
    horizonEndsAt: new Date(Date.parse(capturedAt) + 180 * 60_000).toISOString(),
    lastObservedAt: new Date(Date.parse(capturedAt) + 180 * 60_000).toISOString(),
    createdAt: capturedAt,
    updatedAt: new Date(Date.parse(capturedAt) + 180 * 60_000).toISOString(),
    ...overrides
  };
}

function label(index = 0, overrides: Partial<OutcomeLabel> = {}): OutcomeLabel {
  const profitable = index % 2 === 0;
  const observedAt = new Date(Date.parse(START) + index * 60 * 60_000 + 180 * 60_000).toISOString();
  return {
    id: `label-${index}`,
    episodeId: `episode-${index}`,
    horizonMinutes: 180,
    observedAt,
    executableValueUsd: profitable ? 22 : 18,
    totalModeledCostUsd: 0.2,
    netReturnPercent: profitable ? 9.7 : -10.2,
    netLogReturn: profitable ? Math.log(1.097) : Math.log(0.898),
    riskAdjustedReward: profitable ? 8.5 : -12,
    maximumFavorableExcursionPercent: profitable ? 12 : 1,
    maximumAdverseExcursionPercent: profitable ? -2 : -10,
    profitable,
    quoteExecutable: true,
    datasetEligible: true,
    ...overrides
  };
}

function challenger(id = "challenger-1"): PolicyChallenger {
  return {
    id,
    policyVersion: "autonomous-learning-challenger-v1",
    rank: 1,
    status: "SHADOW",
    minimumScore: 0,
    stopLossPercent: 10,
    takeProfitPercent: 18,
    maximumHoldingMinutes: 180,
    completedPaths: 1,
    netReturnPercent: 1,
    profitFactor: 1.5,
    maximumDrawdownPercent: 5,
    stressNetReturnPercent: 0.2,
    largestProfitContributionPercent: 20,
    datasetDigest: "dataset",
    createdAt: CUTOFF
  };
}

function fold(challengerId = "challenger-1"): WalkForwardResult {
  return {
    id: `fold-${challengerId}`,
    challengerId,
    fold: 1,
    trainingStartAt: START,
    trainingEndAt: "2026-07-10T00:00:00.000Z",
    testStartAt: "2026-07-11T00:00:00.000Z",
    testEndAt: "2026-07-12T00:00:00.000Z",
    embargoHours: 24,
    episodeCount: 1,
    netReturnPercent: 1,
    maximumDrawdownPercent: 0,
    profitable: true,
    createdAt: CUTOFF
  };
}

describe("autonomous learning database and deterministic models", () => {
  let database: LearningDatabase | undefined;

  afterEach(() => {
    database?.close();
    database = undefined;
  });

  it("persists idempotent learning evidence and safely retries identical model and challenger writes", () => {
    database = openLearningDatabase(":memory:");
    const repository = new AutonomousLearningRepository(database);
    const firstEpisode = episode();
    const firstLabel = label();

    repository.setMeta("current_regime", "CHOPPY", START);
    expect(repository.getMeta("current_regime")).toBe("CHOPPY");
    expect(repository.saveUniverseCycle({
      sourceKey: "cycle-1",
      laneId: "learning-lane",
      policyVersion: "autonomous-learning-paper-v10",
      capturedAt: START,
      regime: "CHOPPY",
      candidateCount: 1,
      payload: { episodeIds: [firstEpisode.id] }
    })).toBe(true);
    expect(repository.saveUniverseCycle({
      sourceKey: "cycle-1",
      laneId: "learning-lane",
      policyVersion: "autonomous-learning-paper-v10",
      capturedAt: START,
      regime: "CHOPPY",
      candidateCount: 1,
      payload: { episodeIds: [firstEpisode.id] }
    })).toBe(false);

    repository.upsertEpisode(firstEpisode);
    expect(repository.countEpisodesForMintDay(firstEpisode.mint, "2026-07-01")).toBe(1);
    expect(repository.countEpisodesForMintDay(
      firstEpisode.mint,
      "2026-07-01",
      firstEpisode.policyVersion
    )).toBe(1);
    expect(repository.countEpisodesForMintDay(
      firstEpisode.mint,
      "2026-07-01",
      "another-policy-version"
    )).toBe(0);
    expect(repository.episodeMintsForDay("2026-07-01", firstEpisode.policyVersion))
      .toEqual(new Set([firstEpisode.mint]));
    expect(repository.episodeMintsForDay("2026-07-01", "another-policy-version"))
      .toEqual(new Set());
    const observation: LearningPathObservation = {
      id: "path-episode-0-entry",
      episodeId: firstEpisode.id,
      phase: "ENTRY",
      observedAt: firstEpisode.openedAt!,
      elapsedMinutes: 0,
      executableValueUsd: firstEpisode.entryExecutableValueUsd!,
      totalModeledCostUsd: firstEpisode.inputCostUsd! - firstEpisode.entryExecutableValueUsd!,
      netReturnPercent: -1.25,
      solBenchmarkReturnPercent: 0,
      excessReturnPercent: -1.25,
      priceImpactPercent: 0.3,
      quoteExecutable: true,
      datasetEligible: true
    };
    expect(repository.savePathObservation(observation)).toBe(true);
    expect(repository.savePathObservation(observation)).toBe(false);
    expect(repository.pathObservations(firstEpisode.id)).toEqual([observation]);
    expect(repository.saveOutcome(firstLabel)).toBe(true);
    expect(repository.saveOutcome(firstLabel)).toBe(false);
    expect(repository.listTrainingRows()).toEqual([{ episode: firstEpisode, label: firstLabel }]);
    expect(repository.listTrainingRows(180, firstEpisode.policyVersion)).toHaveLength(1);
    expect(repository.listTrainingRows(180, "another-policy")).toEqual([]);
    expect(repository.episodeCounts(firstEpisode.policyVersion).datasetEligible).toBe(1);
    expect(repository.episodeCounts("another-policy").datasetEligible).toBe(0);
    expect(repository.episodeCountsForArm(
      firstEpisode.strategyArm,
      firstEpisode.policyVersion
    ).datasetEligible).toBe(1);
    expect(repository.episodeCountsForArm(
      "SIMULATION_PROBE",
      firstEpisode.policyVersion
    ).datasetEligible).toBe(0);

    const admission: LearningAdmissionDecision = {
      policyVersion: firstEpisode.policyVersion,
      strategyArm: firstEpisode.strategyArm,
      regime: firstEpisode.regime,
      executionTier: "SHADOW",
      allowed: false,
      highConviction: false,
      reasonCodes: ["VALIDATION_NOT_READY"],
      decidedAt: START
    };
    repository.saveAdmission(admission);
    repository.saveAdmission({ ...admission, decidedAt: "2026-07-01T00:05:00.000Z" });
    expect(repository.recentAdmissions()).toEqual([admission]);
    repository.saveAdmission({
      ...admission,
      policyVersion: "another-policy",
      decidedAt: "2026-07-01T00:10:00.000Z"
    });
    expect(repository.recentAdmissions()).toHaveLength(2);
    expect(repository.recentAdmissions(20, firstEpisode.policyVersion)).toEqual([admission]);
    expect(repository.recentAdmissions(20, "another-policy")).toHaveLength(1);

    const artifacts = trainDeterministicModels([{ episode: firstEpisode, label: firstLabel }], CUTOFF);
    repository.replaceActiveModels(artifacts);
    repository.replaceActiveModels(artifacts);
    expect(repository.activeModels()).toEqual([]);

    repository.replaceChallengers([challenger()], [fold()]);
    repository.replaceChallengers([challenger()], [fold()]);
    expect(repository.activeChallengers()).toEqual([challenger()]);
    expect(repository.walkForwardFor("challenger-1")).toEqual([fold()]);
    expect(repository.integrityCheck()).toBe("ok");
  });

  it("keeps every transformed feature bounded and rejects incompatible artifacts", () => {
    const vector = vectorizeLearningFeatures(features());
    expect(vector).toHaveLength(LEARNING_MODEL_FEATURE_NAMES.length);
    expect(vector.every((value) => Number.isFinite(value) && value >= -1 && value <= 1)).toBe(true);

    const [artifact] = trainDeterministicModels(
      Array.from({ length: AUTONOMOUS_MODEL_MINIMUM_PATHS }, (_, index) => ({
        episode: episode(index),
        label: label(index)
      })),
      CUTOFF
    );
    expect(artifact).toBeDefined();
    expect(() => predictLearningModel({
      ...artifact!,
      featureNames: ["incompatible"]
    }, features())).toThrow("incompatible causal feature schema");
  });

  it("activates only after 200 independent paths and is byte-for-byte deterministic at a fixed cutoff", () => {
    const rows = Array.from({ length: AUTONOMOUS_MODEL_MINIMUM_PATHS }, (_, index) => ({
      episode: episode(index),
      label: label(index)
    }));
    const belowGate = trainDeterministicModels(rows.slice(0, -1), CUTOFF);
    const first = trainDeterministicModels(rows, CUTOFF);
    const second = trainDeterministicModels([...rows].reverse(), CUTOFF);

    expect(belowGate).toHaveLength(4);
    expect(belowGate.every((artifact) => !artifact.active)).toBe(true);
    expect(first).toEqual(second);
    expect(first).toHaveLength(4);
    expect(first.every((artifact) =>
      artifact.active && artifact.independentEpisodeCount === AUTONOMOUS_MODEL_MINIMUM_PATHS &&
      artifact.createdAt === CUTOFF && artifact.validationPassed &&
      artifact.trainingEpisodeCount! >= 100 && artifact.validationEpisodeCount! >= 40 &&
      artifact.featureCoverage === 1 && artifact.driftScore! <= 0.25
    )).toBe(true);
    const probability = first.find((artifact) => artifact.modelKind === "PROFITABILITY_PROBABILITY")!;
    expect(predictLearningModel(probability, features(2))).toBeGreaterThan(0.5);
    expect(predictLearningModel(probability, features(3))).toBeLessThan(0.5);
    expect(first.some((artifact) => artifact.modelKind === "RISK_ADJUSTED_REWARD")).toBe(true);
  });
});
