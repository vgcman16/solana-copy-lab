import { describe, expect, it } from "vitest";
import type { AlpacaStockBar } from "@copylab/providers";
import {
  FROZEN_STOCK_PAPER_SHADOW_POLICIES_V3,
  calculateStockPaperOutcomeLabelV3,
  createStockPaperLearningObservationV3,
  evaluateStockPaperShadowArenaV3,
  evaluateStockPaperWalkForwardV3,
  parseStockPaperOutcomeLabelV3,
  stockPaperDatasetAtCutoffV3,
  stockPaperDatasetDigestV3,
  stockPaperPolicyDigestV3,
  type CreateStockPaperLearningObservationV3Input,
  type StockPaperLearningObservationV3,
  type StockPaperOutcomeLabelV3,
  type StockPaperShadowPolicyV3
} from "../src/stock-paper-learning-v3.js";

const BASE_OBSERVATION: CreateStockPaperLearningObservationV3Input = {
  laneId: "stock-paper:test",
  symbol: "AAPL",
  arm: "BREAKOUT",
  phase: "OVERNIGHT",
  feed: "OVERNIGHT",
  policyVersion: "stock-paper-v2",
  policy: {
    maximumSpreadPercent: 0.6,
    minimumSignalScore: 62,
    nested: { confirmationSamples: 2 }
  },
  tradeDayKey: "2026-07-17",
  observedAt: "2026-07-17T01:20:00.000Z",
  candidateRank: 1,
  candidateScore: 82,
  highConviction: true,
  confirmationSamples: 2,
  entryPriceUsd: 100,
  entryNotionalUsd: 25,
  spreadPercent: 0.4,
  relativeVolume: 2,
  dollarVolumeUsd: 20_000_000,
  change1mPercent: 0.4,
  change5mPercent: 1.5,
  change15mPercent: 3,
  vwapDistancePercent: 1,
  sessionMinute: 20,
  onlineSources: ["NEWS", "MOVER", "NEWS"],
  newsArticleIds: [9, 3, 9],
  hardSafetyPassed: true
};

function observation(
  overrides: Partial<CreateStockPaperLearningObservationV3Input> = {}
): StockPaperLearningObservationV3 {
  return createStockPaperLearningObservationV3({ ...BASE_OBSERVATION, ...overrides });
}

function bar(at: string, close: number, input: Partial<AlpacaStockBar> = {}): AlpacaStockBar {
  return {
    timestamp: at,
    open: close - 0.1,
    high: close + 0.2,
    low: close - 0.3,
    close,
    volume: 1_000,
    tradeCount: 50,
    vwap: close - 0.05,
    ...input
  };
}

function path(
  observedAt: string,
  horizonMinutes: 15 | 45 | 180,
  finalReturnPercent = 2
): AlpacaStockBar[] {
  const start = Date.parse(observedAt);
  return Array.from({ length: horizonMinutes }, (_, index) => {
    const progress = (index + 1) / horizonMinutes;
    const close = 100 * (1 + finalReturnPercent / 100 * progress);
    return bar(new Date(start + (index + 1) * 60_000).toISOString(), close);
  });
}

function outcome(
  item: StockPaperLearningObservationV3,
  finalReturnPercent = 2,
  horizonMinutes: 15 | 45 | 180 = 15
): StockPaperOutcomeLabelV3 {
  return calculateStockPaperOutcomeLabelV3({
    observation: item,
    horizonMinutes,
    bars: path(item.observedAt, horizonMinutes, finalReturnPercent),
    labeledAt: new Date(Date.parse(item.observedAt) + (horizonMinutes + 1) * 60_000).toISOString(),
    costPolicy: {
      version: "test-costs-v1",
      entryFeeBps: 0,
      exitFeeBps: 1,
      exitPriceHaircutBps: 10,
      fixedRoundTripCostUsd: 0
    }
  });
}

describe("stock paper learning v3 analysis primitives", () => {
  it("creates immutable, normalized observations and deterministic policy/dataset digests", () => {
    const first = observation();
    const reordered = observation({
      policy: {
        nested: { confirmationSamples: 2 },
        minimumSignalScore: 62,
        maximumSpreadPercent: 0.6
      },
      onlineSources: ["MOVER", "NEWS"],
      newsArticleIds: [3, 9]
    });

    expect(first).toEqual(reordered);
    expect(first.onlineSources).toEqual(["MOVER", "NEWS"]);
    expect(first.newsArticleIds).toEqual([3, 9]);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.onlineSources)).toBe(true);
    expect(stockPaperPolicyDigestV3({ b: 2, a: 1 })).toBe(
      stockPaperPolicyDigestV3({ a: 1, b: 2 })
    );

    const label = outcome(first);
    expect(stockPaperDatasetDigestV3({ observations: [first], outcomes: [label] })).toBe(
      stockPaperDatasetDigestV3({ observations: [first], outcomes: [label] })
    );
  });

  it("requires explicit hard-safety evidence and excludes failed safety paths", () => {
    expect(() => createStockPaperLearningObservationV3({
      ...BASE_OBSERVATION,
      hardSafetyPassed: undefined
    } as unknown as CreateStockPaperLearningObservationV3Input)).toThrow(/hard-safety evidence must be explicit/i);
    const unsafe = observation({ hardSafetyPassed: false });
    const result = evaluateStockPaperShadowArenaV3({
      observations: [unsafe],
      outcomes: [outcome(unsafe, 10)],
      horizonMinutes: 15
    });
    expect(result.results.every((policy) => policy.selectedPathCount === 0)).toBe(true);
  });

  it("labels only strictly future bars and reports MFE, MAE, and net executable return after costs", () => {
    const item = observation();
    const observedMs = Date.parse(item.observedAt);
    const future = path(item.observedAt, 15, 5).map((entry, index) => index === 0
      ? bar(entry.timestamp, entry.close, { low: 99 })
      : index === 14
        ? bar(entry.timestamp, 105, { high: 106, low: 104.5, open: 104.8, vwap: 104.9 })
        : entry
    );
    const label = calculateStockPaperOutcomeLabelV3({
      observation: item,
      horizonMinutes: 15,
      bars: [
        bar(new Date(observedMs - 60_000).toISOString(), 100, { high: 1_000, low: 1 }),
        bar(item.observedAt, 100, { high: 900, low: 2 }),
        ...future
      ],
      labeledAt: new Date(observedMs + 16 * 60_000).toISOString(),
      costPolicy: {
        version: "cost-test-v1",
        entryFeeBps: 10,
        exitFeeBps: 10,
        exitPriceHaircutBps: 20,
        fixedRoundTripCostUsd: 0.05
      }
    });

    expect(label).toMatchObject({
      datasetEligible: true,
      modeledExecutable: true,
      barBasedExecutionModel: true,
      strictFutureBarsOnly: true,
      barsUsed: 15,
      grossReturnPercent: 5,
      maximumFavorableExcursionPercent: 6,
      maximumAdverseExcursionPercent: -1
    });
    expect(label.firstBarAt).toBe(new Date(observedMs + 60_000).toISOString());
    expect(label.netExecutableReturnPercent).toBeLessThan(label.grossReturnPercent!);
    expect(label.totalModeledCostsUsd).toBeGreaterThan(0);
    expect(Object.isFrozen(label)).toBe(true);
  });

  it("recomputes causal outcome ids, digests, and executable metrics from untrusted JSON", () => {
    const item = observation();
    const observedMs = Date.parse(item.observedAt);
    const label = calculateStockPaperOutcomeLabelV3({
      observation: item,
      horizonMinutes: 15,
      bars: path(item.observedAt, 15, 2),
      labeledAt: new Date(observedMs + 16 * 60_000).toISOString()
    });
    expect(parseStockPaperOutcomeLabelV3(JSON.parse(JSON.stringify(label)), { observation: item })).toEqual(label);
    expect(() => parseStockPaperOutcomeLabelV3({ ...label, strictFutureBarsOnly: false }, { observation: item }))
      .toThrow(/causality flags/i);
    expect(() => parseStockPaperOutcomeLabelV3({
      ...label,
      netExecutableReturnPercent: label.netExecutableReturnPercent! + 1
    }, { observation: item })).toThrow(/metrics did not recompute/i);
    expect(() => parseStockPaperOutcomeLabelV3({ ...label, id: `${label.id}-altered` }, { observation: item }))
      .toThrow(/id or canonical evidence/i);
  });

  it("excludes observations and labels that were not knowable at a declared cutoff", () => {
    const item = observation();
    const label = outcome(item);
    const beforeLabel = stockPaperDatasetAtCutoffV3({
      observations: [item],
      outcomes: [label],
      cutoffAt: label.horizonEndsAt
    });
    const afterLabel = stockPaperDatasetAtCutoffV3({
      observations: [item],
      outcomes: [label],
      cutoffAt: label.labeledAt
    });
    expect(beforeLabel).toMatchObject({ observations: [item], outcomes: [] });
    expect(afterLabel).toMatchObject({ observations: [item], outcomes: [label] });
  });

  it("keeps a causal terminal return when dense path metrics are unavailable", () => {
    const item = observation();
    const observedMs = Date.parse(item.observedAt);
    const notDue = calculateStockPaperOutcomeLabelV3({
      observation: item,
      horizonMinutes: 15,
      bars: path(item.observedAt, 15),
      labeledAt: new Date(observedMs + 14 * 60_000).toISOString()
    });
    const noFuture = calculateStockPaperOutcomeLabelV3({
      observation: item,
      horizonMinutes: 15,
      bars: [bar(item.observedAt, 100)],
      labeledAt: new Date(observedMs + 16 * 60_000).toISOString()
    });
    const gap = calculateStockPaperOutcomeLabelV3({
      observation: item,
      horizonMinutes: 15,
      bars: [
        bar(new Date(observedMs + 60_000).toISOString(), 101),
        ...path(item.observedAt, 15).slice(4)
      ],
      labeledAt: new Date(observedMs + 16 * 60_000).toISOString()
    });

    expect(notDue).toMatchObject({ datasetEligible: false, missingDataReason: "HORIZON_NOT_DUE" });
    expect(noFuture).toMatchObject({
      datasetEligible: false,
      missingDataReason: "NO_STRICTLY_FUTURE_BARS"
    });
    expect(gap).toMatchObject({
      datasetEligible: true,
      modeledExecutable: true,
      pathMetricsMissingReason: "PATH_GAP",
      exitReferencePriceUsd: expect.any(Number),
      netExecutableReturnPercent: expect.any(Number)
    });
    expect(gap).not.toHaveProperty("missingDataReason");
    expect(gap).not.toHaveProperty("maximumFavorableExcursionPercent");
    expect(gap).not.toHaveProperty("maximumAdverseExcursionPercent");
    expect(parseStockPaperOutcomeLabelV3(JSON.parse(JSON.stringify(gap)), {
      observation: item
    })).toEqual(gap);
  });

  it("does not invent an executable terminal return when the horizon endpoint is absent", () => {
    const item = observation();
    const observedMs = Date.parse(item.observedAt);
    const endpointMissing = calculateStockPaperOutcomeLabelV3({
      observation: item,
      horizonMinutes: 15,
      bars: path(item.observedAt, 15).slice(0, 10),
      labeledAt: new Date(observedMs + 16 * 60_000).toISOString()
    });

    expect(endpointMissing).toMatchObject({
      datasetEligible: false,
      modeledExecutable: false,
      missingDataReason: "HORIZON_NOT_COVERED"
    });
    expect(endpointMissing).not.toHaveProperty("netExecutableReturnPercent");
  });

  it("evaluates frozen threshold and confirmation policies as shadow analysis only", () => {
    expect(Object.isFrozen(FROZEN_STOCK_PAPER_SHADOW_POLICIES_V3)).toBe(true);
    const strong = observation({ symbol: "AAPL", observedAt: "2026-07-17T01:20:00Z" });
    const loose = observation({
      symbol: "AMD",
      observedAt: "2026-07-17T01:40:00Z",
      candidateScore: 65,
      relativeVolume: 1.2,
      spreadPercent: 1,
      highConviction: false,
      confirmationSamples: 1
    });
    const policies: readonly StockPaperShadowPolicyV3[] = [
      {
        id: "BASE",
        minimumScore: 60,
        minimumRelativeVolume: 1,
        maximumSpreadPercent: 1.25,
        minimumConfirmationSamples: 1,
        highConvictionOnly: false,
        additionalStressCostBps: 0
      },
      {
        id: "STRICT",
        minimumScore: 75,
        minimumRelativeVolume: 1.5,
        maximumSpreadPercent: 0.6,
        minimumConfirmationSamples: 2,
        highConvictionOnly: true,
        additionalStressCostBps: 100
      }
    ];
    const strongOutcome = outcome(strong, 3);
    const result = evaluateStockPaperShadowArenaV3({
      observations: [loose, strong],
      outcomes: [outcome(loose, -1), strongOutcome],
      horizonMinutes: 15,
      policies
    });

    expect(result).toMatchObject({ analysisOnly: true, pathsAreIndependentTrades: false });
    expect(result.results[0]).toMatchObject({ selectedPathCount: 2, scorablePathCount: 2 });
    expect(result.results[1]).toMatchObject({ selectedPathCount: 1, scorablePathCount: 1 });
    expect(result.results[1]!.meanNetReturnPercent).toBeCloseTo(
      strongOutcome.netExecutableReturnPercent! - 1,
      10
    );
  });

  it("keeps book-derived liquidity and discipline hypotheses in bounded shadow policies", () => {
    const lowLiquidity = observation({
      symbol: "LOW",
      observedAt: "2026-07-17T01:20:00Z",
      dollarVolumeUsd: 20_000_000
    });
    const overextended = observation({
      symbol: "FAST",
      observedAt: "2026-07-17T01:40:00Z",
      dollarVolumeUsd: 100_000_000,
      change5mPercent: 9
    });
    const controlled = observation({
      symbol: "GOOD",
      observedAt: "2026-07-17T02:00:00Z",
      dollarVolumeUsd: 100_000_000,
      change5mPercent: 3,
      vwapDistancePercent: 1.5
    });
    const reclaim = observation({
      symbol: "RECLAIM",
      observedAt: "2026-07-17T02:20:00Z",
      candidateScore: 40,
      highConviction: false,
      confirmationSamples: 1,
      spreadPercent: 0.4,
      relativeVolume: 1.2,
      dollarVolumeUsd: 100_000_000,
      change1mPercent: 0.3,
      change5mPercent: -2,
      vwapDistancePercent: -1.2
    });
    const result = evaluateStockPaperShadowArenaV3({
      observations: [lowLiquidity, overextended, controlled, reclaim],
      outcomes: [outcome(lowLiquidity), outcome(overextended), outcome(controlled), outcome(reclaim)],
      horizonMinutes: 15
    });
    const bookPolicies = FROZEN_STOCK_PAPER_SHADOW_POLICIES_V3
      .filter((policy) => policy.researchBasisId);

    expect(bookPolicies.map((policy) => policy.id)).toEqual([
      "BOOK_DISCIPLINED_EXECUTION_PROXY",
      "BOOK_QUALITY_FIRST_LIQUIDITY_PROXY",
      "BOOK_MEAN_REVERSION_RECLAIM_PROXY"
    ]);
    expect(bookPolicies.every(Object.isFrozen)).toBe(true);
    expect(result.results.find((score) =>
      score.policyId === "BOOK_DISCIPLINED_EXECUTION_PROXY"
    )?.selectedObservationIds).toEqual([controlled.id]);
    expect(result.results.find((score) =>
      score.policyId === "BOOK_QUALITY_FIRST_LIQUIDITY_PROXY"
    )?.selectedObservationIds).toEqual([controlled.id]);
    expect(result.results.find((score) =>
      score.policyId === "BOOK_MEAN_REVERSION_RECLAIM_PROXY"
    )?.selectedObservationIds).toEqual([reclaim.id]);
    expect(result.analysisOnly).toBe(true);
    expect(result.pathsAreIndependentTrades).toBe(false);
  });

  it("builds purged chronological folds and can only pass analysis gates", () => {
    const policies: readonly StockPaperShadowPolicyV3[] = [{
      id: "BASE",
      minimumScore: 60,
      minimumRelativeVolume: 1,
      maximumSpreadPercent: 1.25,
      minimumConfirmationSamples: 1,
      highConvictionOnly: false,
      additionalStressCostBps: 0
    }];
    const start = Date.parse("2026-07-01T00:00:00.000Z");
    const observations = Array.from({ length: 18 }, (_, index) => observation({
      symbol: `S${index}`,
      tradeDayKey: new Date(start + index * 24 * 60 * 60_000).toISOString().slice(0, 10),
      observedAt: new Date(start + index * 24 * 60 * 60_000).toISOString(),
      candidateScore: 70
    }));
    const outcomes = observations.map((item) => outcome(item, 1.5));
    const evaluation = evaluateStockPaperWalkForwardV3({
      observations,
      outcomes,
      horizonMinutes: 15,
      policies,
      baselinePolicyId: "BASE",
      foldCount: 2,
      embargoMinutes: 15,
      gates: {
        minimumCompletedFolds: 2,
        minimumTrainingScorablePathsPerFold: 4,
        minimumHoldoutScorablePaths: 10,
        minimumHoldoutCoveragePercent: 100,
        minimumHoldoutProfitFactor: 1,
        maximumHoldoutDrawdownPercent: 50,
        minimumHoldoutNetReturnPercent: 0,
        minimumExcessReturnVsBaselinePercent: 0
      }
    });

    expect(evaluation).toMatchObject({
      analysisOnly: true,
      promotionEligible: false,
      mayAffectTrading: false,
      baselinePolicyId: "BASE",
      embargoMinutes: 15
    });
    expect(evaluation.folds).toHaveLength(2);
    for (const fold of evaluation.folds) {
      expect(fold.trainingEndAt).toBeDefined();
      expect(
        Date.parse(fold.trainingEndAt!) + 15 * 60_000
      ).toBeLessThanOrEqual(Date.parse(fold.testStartAt) - 15 * 60_000);
    }
    expect(evaluation.policies[0]).toMatchObject({
      status: "ANALYSIS_GATES_PASSED",
      passesAnalysisGates: true,
      promotionEligible: false,
      mayAffectTrading: false,
      completedFolds: 2
    });
    expect(stockPaperDatasetDigestV3({ observations, outcomes })).toBe(
      stockPaperDatasetDigestV3({ observations: [...observations].reverse(), outcomes: [...outcomes].reverse() })
    );
  });

  it("gates evidence breadth on eligible holdout paths and versions evaluation configuration", () => {
    const training = [
      observation({ symbol: "TRN1", tradeDayKey: "2026-07-01", observedAt: "2026-07-01T14:30:00.000Z" }),
      observation({ symbol: "TRN2", tradeDayKey: "2026-07-02", observedAt: "2026-07-02T14:30:00.000Z" })
    ];
    const scorable = observation({
      symbol: "AAPL",
      tradeDayKey: "2026-07-03",
      observedAt: "2026-07-03T14:30:00.000Z"
    });
    const unrelated = observation({
      symbol: "MSFT",
      tradeDayKey: "2026-07-04",
      observedAt: "2026-07-04T14:30:00.000Z"
    });
    const observations = [...training, scorable, unrelated];
    const outcomes = [outcome(scorable, 2)];
    const common = {
      observations,
      outcomes,
      horizonMinutes: 15 as const,
      foldCount: 1,
      gates: {
        minimumCompletedFolds: 1,
        minimumTrainingScorablePathsPerFold: 0,
        minimumHoldoutScorablePaths: 1,
        minimumHoldoutCoveragePercent: 0,
        minimumHoldoutDistinctSymbols: 2,
        minimumHoldoutDistinctTradeDays: 2,
        minimumHoldoutProfitFactor: 0,
        maximumHoldoutDrawdownPercent: 100,
        minimumHoldoutNetReturnPercent: -100,
        minimumExcessReturnVsBaselinePercent: -100
      }
    };
    const first = evaluateStockPaperWalkForwardV3(common);
    const second = evaluateStockPaperWalkForwardV3({
      ...common,
      gates: { ...common.gates, minimumHoldoutDistinctSymbols: 1 }
    });
    expect(first.policies[0]).toMatchObject({
      status: "INSUFFICIENT_EVIDENCE",
      holdoutDistinctSymbols: 1,
      holdoutDistinctTradeDays: 1,
      gateReasons: expect.arrayContaining([
        "HOLDOUT_SYMBOLS_BELOW_MINIMUM",
        "HOLDOUT_TRADE_DAYS_BELOW_MINIMUM"
      ])
    });
    expect(first.datasetDigest).toBe(second.datasetDigest);
    expect(first.evaluationDigest).not.toBe(second.evaluationDigest);
  });

  it("never splits observations from one trading day across a fold boundary", () => {
    const start = Date.parse("2026-07-01T14:30:00.000Z");
    const observations = Array.from({ length: 8 }, (_, index) => {
      const day = Math.floor(index / 2);
      const observedAt = new Date(start + day * 24 * 60 * 60_000 + (index % 2) * 15 * 60_000).toISOString();
      return observation({
        symbol: `D${day}S${index % 2}`,
        tradeDayKey: observedAt.slice(0, 10),
        observedAt,
        candidateScore: 75
      });
    });
    const evaluation = evaluateStockPaperWalkForwardV3({
      observations,
      outcomes: observations.map((item) => outcome(item, 1)),
      horizonMinutes: 15,
      foldCount: 2
    });
    const dayById = new Map(observations.map((item) => [item.id, item.tradeDayKey]));
    for (const fold of evaluation.folds) {
      const trainingDays = new Set(
        fold.training.results.flatMap((result) => result.selectedObservationIds).map((id) => dayById.get(id))
      );
      const holdoutDays = new Set(
        fold.holdout.results.flatMap((result) => result.selectedObservationIds).map((id) => dayById.get(id))
      );
      expect([...trainingDays].filter((day) => holdoutDays.has(day))).toEqual([]);
    }
  });
});
