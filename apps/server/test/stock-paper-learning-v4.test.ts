import { describe, expect, it } from "vitest";
import {
  STOCK_PAPER_LEARNING_V4_VERSION,
  analyzeStockPaperLearningV4,
  type StockPaperAnalysisTradeV4,
  type StockPaperDailyReturnV4
} from "../src/stock-paper-learning-v4.js";

const CUTOFF = "2026-07-31T23:59:59.999Z";

function trade(
  id: string,
  day: number,
  symbol: string,
  netReturnPercent: number,
  spyReturnPercent = 0.2,
  input: Partial<StockPaperAnalysisTradeV4> = {}
): StockPaperAnalysisTradeV4 {
  const date = `2026-07-${String(day).padStart(2, "0")}`;
  const base: StockPaperAnalysisTradeV4 = {
    id,
    laneId: "stock-paper:test-v4",
    symbol,
    sector: symbol === "AAPL" ? "Technology" : "Consumer",
    arm: "BREAKOUT",
    phase: "REGULAR",
    feed: "IEX",
    policyVersion: "stock-paper-v3",
    featureVersion: "stock-paper-features-v3",
    executionVersion: "stock-paper-execution-v3",
    tradeDayKey: date,
    openedAt: `${date}T14:00:00.000Z`,
    closedAt: `${date}T15:00:00.000Z`,
    notionalUsd: 25,
    netReturnPercent,
    spyReturnPercent
  };
  return { ...base, ...input };
}

function histories(days = 25): StockPaperDailyReturnV4[] {
  return Array.from({ length: days }, (_, index) => index + 1).flatMap((day) => {
    const dateKey = `2026-07-${String(day).padStart(2, "0")}`;
    const base = day % 2 === 0 ? 0.4 : 0.2;
    return [
      daily("SPY", dateKey, base),
      daily("AAPL", dateKey, base * 1.1),
      daily("NFLX", dateKey, base * 1.05)
    ];
  });
}

function daily(symbol: string, dateKey: string, returnPercent: number): StockPaperDailyReturnV4 {
  return { symbol, dateKey, returnPercent, adjusted: true, session: "REGULAR", coveragePercent: 100 };
}

function baseInput() {
  return {
    cutoffAt: CUTOFF,
    trades: [
      trade("t1", 10, "AAPL", 2, 0.5),
      trade("t2", 11, "NFLX", -1, 0.2),
      trade("t3", 12, "AAPL", 3, 0.4)
    ],
    dailyReturns: histories(),
    config: {
      initialNavUsd: 100,
      bootstrapReplicates: 100,
      bootstrapBlockDays: 2,
      regimeLookbackDays: 5,
      minimumCorrelationOverlapDays: 5,
      driftMinimumDaysPerWindow: 2
    }
  } as const;
}

describe("stock PAPER learning v4 analysis-only diagnostics", () => {
  it("produces immutable, versioned, order-independent deterministic output", () => {
    const input = baseInput();
    const first = analyzeStockPaperLearningV4(input);
    const reordered = analyzeStockPaperLearningV4({
      ...input,
      trades: [...input.trades].reverse(),
      dailyReturns: [...input.dailyReturns].reverse()
    });

    expect(first).toEqual(reordered);
    expect(first.version).toBe(STOCK_PAPER_LEARNING_V4_VERSION);
    expect(first.analysisOnly).toBe(true);
    expect(first.affectsTrading).toBe(false);
    expect(first.promotionEligible).toBe(false);
    expect(first.portfolioCounterfactual).toBe(false);
    expect(first.replay.fixedHistoricalNotionals).toBe(true);
    expect(first.bootstrap.fixedHistoricalNotionals).toBe(true);
    expect(first.provenance.cutoffIndependentDatasetSeed).toBe(true);
    expect(first.outputDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.replay.points)).toBe(true);
  });

  it("replays realized portfolio PnL, drawdown, concurrency, and SPY excess", () => {
    const input = baseInput();
    const result = analyzeStockPaperLearningV4({
      ...input,
      trades: [
        trade("gain", 10, "AAPL", 10, 2, {
          openedAt: "2026-07-10T14:00:00.000Z",
          closedAt: "2026-07-10T16:00:00.000Z",
          notionalUsd: 50
        }),
        trade("loss", 10, "NFLX", -20, -1, {
          openedAt: "2026-07-10T15:00:00.000Z",
          closedAt: "2026-07-10T17:00:00.000Z",
          notionalUsd: 25
        })
      ]
    });

    expect(result.replay).toMatchObject({
      initialNavUsd: 100,
      endingNavUsd: 100,
      totalPnlUsd: 0,
      maximumConcurrentPositions: 2,
      maximumGrossExposureUsd: 75
    });
    expect(result.replay.maximumDrawdownPercent).toBeCloseTo(4.7619047619, 8);
    expect(result.spyExcess).toMatchObject({
      strategyPnlUsd: 0,
      benchmarkEquivalentPnlUsd: 0.75,
      excessPnlUsd: -0.75
    });
  });

  it("calculates correlation from overlapping days and groups regime and sector performance", () => {
    const result = analyzeStockPaperLearningV4(baseInput());
    const pair = result.correlations.pairs.find((entry) =>
      entry.leftSymbol === "AAPL" && entry.rightSymbol === "NFLX"
    );
    expect(pair).toMatchObject({ asOfTradeDayKey: "2026-07-11", overlapDays: 10, status: "AVAILABLE" });
    expect(pair?.correlation).toBeCloseTo(1, 10);
    expect(result.correlations.highestPositivePair).toEqual(pair);
    expect(result.regimePerformance.some((entry) => entry.regime === "UP_LOW_VOL")).toBe(true);
    expect(result.sectorPerformance.map((entry) => entry.sector)).toEqual(["CONSUMER", "TECHNOLOGY"]);
  });

  it("uses deterministic whole-day block bootstrap instead of treating correlated trades as independent", () => {
    const input = baseInput();
    const sameDayTrades = Array.from({ length: 5 }, (_, index) =>
      trade(`gain-${index}`, 10, index % 2 === 0 ? "AAPL" : "NFLX", 2, 0)
    );
    const result = analyzeStockPaperLearningV4({ ...input, trades: sameDayTrades });
    const repeated = analyzeStockPaperLearningV4({ ...input, trades: [...sameDayTrades].reverse() });

    expect(result.bootstrap).toEqual(repeated.bootstrap);
    expect(result.bootstrap.activeTradeDays).toBe(1);
    expect(result.bootstrap.returnPercentP05).toBe(2.5);
    expect(result.bootstrap.returnPercentP95).toBe(2.5);
    expect(result.bootstrap.probabilityPositiveReturnPercent).toBe(100);
  });

  it("detects recent SPY-excess deterioration and symbol-mix drift", () => {
    const input = baseInput();
    const trades = [
      trade("e1", 10, "AAPL", 2, 0),
      trade("e2", 11, "AAPL", 2, 0),
      trade("e3", 12, "AAPL", 2, 0),
      trade("e4", 13, "AAPL", 2, 0),
      trade("r1", 20, "NFLX", -1, 0),
      trade("r2", 21, "NFLX", -1, 0),
      trade("r3", 22, "NFLX", -1, 0),
      trade("r4", 23, "NFLX", -1, 0)
    ];
    const result = analyzeStockPaperLearningV4({
      ...input,
      trades,
      config: { ...input.config, driftMinimumDaysPerWindow: 4 }
    });

    expect(result.drift).toMatchObject({
      status: "DETERIORATING",
      earlyMeanSpyExcessPercent: 2,
      recentMeanSpyExcessPercent: -1,
      spyExcessDeltaPercent: -3,
      earlyWinRatePercent: 100,
      recentWinRatePercent: 0,
      symbolMixJensenShannonDivergence: 1
    });
    expect(result.diagnostics.warnings).toContain("Recent SPY-excess performance deteriorated materially.");
  });

  it("fails closed on duplicate or non-causal evidence", () => {
    const input = baseInput();
    expect(() => analyzeStockPaperLearningV4({
      ...input,
      trades: [input.trades[0]!, input.trades[0]!]
    })).toThrow(/duplicate trade id/i);
    expect(() => analyzeStockPaperLearningV4({
      ...input,
      trades: [trade("future", 10, "AAPL", 1, 0, { closedAt: "2026-08-01T00:00:00.000Z" })]
    })).toThrow(/not knowable at the cutoff/i);
    expect(() => analyzeStockPaperLearningV4({
      ...input,
      dailyReturns: [...input.dailyReturns, input.dailyReturns[0]!]
    })).toThrow(/duplicate daily return/i);
  });

  it("rejects invalid calendar dates, timezone-less clocks, and mismatched New York trade days", () => {
    const input = baseInput();
    expect(() => analyzeStockPaperLearningV4({
      ...input,
      trades: [trade("no-zone", 10, "AAPL", 1, 0, { openedAt: "2026-07-10T14:00:00" })]
    })).toThrow(/explicit timezone offset/i);
    expect(() => analyzeStockPaperLearningV4({
      ...input,
      cutoffAt: "2026-07-32T23:59:59.999Z"
    })).toThrow(/explicit timezone offset/i);
    expect(() => analyzeStockPaperLearningV4({
      ...input,
      cutoffAt: "2026-07-31T23:59:59+15:00"
    })).toThrow(/explicit timezone offset/i);
    expect(() => analyzeStockPaperLearningV4({
      ...input,
      trades: [trade("wrong-day", 10, "AAPL", 1, 0, { tradeDayKey: "2026-07-11" })]
    })).toThrow(/does not match its causal opening clock/i);
  });

  it("rejects future full-session return evidence", () => {
    const input = baseInput();
    expect(() => analyzeStockPaperLearningV4({
      ...input,
      cutoffAt: "2026-07-25T12:00:00.000Z",
      dailyReturns: [...input.dailyReturns, daily("MSFT", "2026-07-25", 1)]
    })).toThrow(/beyond the cutoff/i);
  });

  it("keeps the dataset seed and bootstrap stable when only the cutoff advances", () => {
    const input = baseInput();
    const first = analyzeStockPaperLearningV4(input);
    const later = analyzeStockPaperLearningV4({ ...input, cutoffAt: "2026-08-05T23:59:59.999Z" });

    expect(later.datasetDigest).toBe(first.datasetDigest);
    expect(later.bootstrap).toEqual(first.bootstrap);
    expect(later.outputDigest).not.toBe(first.outputDigest);
  });

  it("books simultaneous closes atomically so ordering cannot manufacture drawdown", () => {
    const input = baseInput();
    const simultaneous = [
      trade("win", 10, "AAPL", 10, 0, { notionalUsd: 50, closedAt: "2026-07-10T16:00:00.000Z" }),
      trade("loss", 10, "NFLX", -10, 0, { notionalUsd: 50, closedAt: "2026-07-10T16:00:00.000Z" })
    ];
    const first = analyzeStockPaperLearningV4({ ...input, trades: simultaneous });
    const reversed = analyzeStockPaperLearningV4({ ...input, trades: [...simultaneous].reverse() });

    expect(first.replay.maximumDrawdownPercent).toBe(0);
    expect(first.replay.points).toHaveLength(1);
    expect(first.replay.points[0]).toMatchObject({ pnlUsd: 0, navUsd: 100 });
    expect(reversed.replay).toEqual(first.replay);
  });

  it("marks zero-variance correlations unavailable and never reports a nonpositive best pair", () => {
    const input = baseInput();
    const constantReturns = Array.from({ length: 10 }, (_, index) => index + 1).flatMap((day) => {
      const dateKey = `2026-07-${String(day).padStart(2, "0")}`;
      return [daily("SPY", dateKey, 0.1), daily("AAPL", dateKey, 1), daily("NFLX", dateKey, 1)];
    });
    const zeroVariance = analyzeStockPaperLearningV4({
      ...input,
      trades: [trade("a", 10, "AAPL", 1), trade("n", 11, "NFLX", 1)],
      dailyReturns: constantReturns
    });
    expect(zeroVariance.correlations.pairs[0]).toMatchObject({
      status: "ZERO_VARIANCE",
      overlapDays: 10
    });
    expect(zeroVariance.correlations.pairs[0]).not.toHaveProperty("correlation");
    expect(zeroVariance.correlations.highestPositivePair).toBeUndefined();

    const negativeReturns = constantReturns.map((entry) => entry.symbol === "AAPL"
      ? { ...entry, returnPercent: Number(entry.dateKey.slice(-2)) % 2 === 0 ? 1 : -1 }
      : entry.symbol === "NFLX"
        ? { ...entry, returnPercent: Number(entry.dateKey.slice(-2)) % 2 === 0 ? -1 : 1 }
        : entry
    );
    const negative = analyzeStockPaperLearningV4({
      ...input,
      trades: [trade("a2", 10, "AAPL", 1), trade("n2", 11, "NFLX", 1)],
      dailyReturns: negativeReturns
    });
    expect(negative.correlations.pairs[0]?.correlation).toBeLessThan(0);
    expect(negative.correlations.highestPositivePair).toBeUndefined();
  });

  it("uses only pre-entry returns for correlation context", () => {
    const input = baseInput();
    const first = analyzeStockPaperLearningV4(input);
    const futureChanged = input.dailyReturns.map((entry) =>
      entry.symbol === "NFLX" && entry.dateKey >= "2026-07-11"
        ? { ...entry, returnPercent: -entry.returnPercent * 20 }
        : entry
    );
    const changed = analyzeStockPaperLearningV4({ ...input, dailyReturns: futureChanged });
    expect(changed.correlations.pairs).toEqual(first.correlations.pairs);
    expect(changed.datasetDigest).not.toBe(first.datasetDigest);
  });

  it("reports nonnegative absolute-PnL sector shares that sum to 100%", () => {
    const input = baseInput();
    const result = analyzeStockPaperLearningV4({
      ...input,
      trades: [trade("tech-win", 10, "AAPL", 2, 0), trade("consumer-loss", 11, "NFLX", -1, 0)]
    });
    const shares = result.sectorPerformance.map((entry) => entry.absolutePnlSharePercent);
    expect(shares.every((share) => share >= 0 && share <= 100)).toBe(true);
    expect(shares.reduce((total, share) => total + share, 0)).toBeCloseTo(100, 8);
  });

  it("weights drift by active day rather than allowing a busy day to dominate", () => {
    const input = baseInput();
    const earlyBusy = Array.from({ length: 10 }, (_, index) => trade(`busy-${index}`, 10, "AAPL", 10, 0));
    const trades = [
      ...earlyBusy,
      trade("early-loss", 11, "NFLX", -10, 0),
      trade("recent-flat-1", 20, "AAPL", 0, 0),
      trade("recent-flat-2", 21, "NFLX", 0, 0)
    ];
    const result = analyzeStockPaperLearningV4({
      ...input,
      trades,
      config: { ...input.config, driftMinimumDaysPerWindow: 2 }
    });
    expect(result.drift).toMatchObject({
      earlyMeanNetReturnPercent: 0,
      recentMeanNetReturnPercent: 0,
      status: "STABLE"
    });
  });

  it("fails closed on overflow-sized inputs and blended provenance", () => {
    const input = baseInput();
    expect(() => analyzeStockPaperLearningV4({
      ...input,
      trades: [trade("overflow", 10, "AAPL", 1, 0, { notionalUsd: Number.MAX_VALUE })]
    })).toThrow(/notional must be from/i);
    expect(() => analyzeStockPaperLearningV4({
      ...input,
      config: { ...input.config, initialNavUsd: Number.MAX_VALUE }
    })).toThrow(/initial NAV must be from/i);
    expect(() => analyzeStockPaperLearningV4({
      ...input,
      trades: [
        trade("v1", 10, "AAPL", 1),
        trade("v2", 11, "NFLX", 1, 0, { policyVersion: "stock-paper-other" })
      ]
    })).toThrow(/cannot blend more than one policy version/i);
  });

  it("prominently labels realized-close bookkeeping and analysis-only provenance", () => {
    const result = analyzeStockPaperLearningV4(baseInput());
    expect(result.diagnostics.warnings[0]).toMatch(/^REALIZED-CLOSE BOOKKEEPING ONLY:/);
    expect(result).toMatchObject({
      analysisOnly: true,
      affectsTrading: false,
      promotionEligible: false,
      portfolioCounterfactual: false
    });
    expect(result.provenance).toMatchObject({
      datasetSchemaVersion: "stock-paper-learning-v4-evidence-v2",
      sourceLaneId: "stock-paper:test-v4",
      policyVersion: "STOCK-PAPER-V3",
      adjustedRegularSessionReturnsOnly: true,
      cutoffIndependentDatasetSeed: true
    });
  });
});
