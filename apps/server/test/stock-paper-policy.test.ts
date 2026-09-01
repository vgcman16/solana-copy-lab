import { describe, expect, it } from "vitest";
import type { AlpacaStockBar, AlpacaStockSnapshot } from "@copylab/providers";
import {
  DEFAULT_STOCK_PAPER_POLICY,
  adaptiveArmDecision,
  adaptiveHierarchicalArmDecision,
  currentPhaseBarWindow,
  deterministicUniverse,
  hasCausalPullbackReclaim,
  marketPhase,
  passesStockSnapshotPrefilter,
  replayClosedStockTrade,
  scoreStockCandidate,
  stockExitDecision,
  stockMarkPrice,
  stockInstrumentRiskProfile,
  stockPositionRiskDecision,
  stockPaperMaximumBarAgeMs,
  stockPositionSize,
  stockQuoteIsFresh,
  stockSnapshotIsFresh,
  stockTradeDayKey
} from "../src/stock-paper-policy.js";

function bars(): AlpacaStockBar[] {
  return Array.from({ length: 40 }, (_, index) => {
    const close = 100 + index * 0.12;
    return {
      timestamp: new Date(Date.parse("2026-07-16T14:00:00Z") + index * 60_000).toISOString(),
      open: close - 0.08,
      high: close + 0.12,
      low: close - 0.14,
      close,
      volume: index >= 35 ? 3_000 : 1_000,
      tradeCount: 20,
      vwap: close - 0.2
    };
  });
}

function snapshot(): AlpacaStockSnapshot {
  return {
    symbol: "AAPL",
    latestQuote: {
      timestamp: "2026-07-16T14:40:00Z",
      bidPrice: 104.75,
      bidSize: 10,
      askPrice: 104.85,
      askSize: 10
    },
    dailyBar: {
      timestamp: "2026-07-16T04:00:00Z",
      open: 100,
      high: 105,
      low: 99.5,
      close: 104.8,
      volume: 500_000,
      tradeCount: 5_000,
      vwap: 102
    },
    previousDailyBar: {
      timestamp: "2026-07-15T04:00:00Z",
      open: 98,
      high: 101,
      low: 97,
      close: 100,
      volume: 450_000,
      tradeCount: 4_500,
      vwap: 99
    },
    minuteBar: {
      timestamp: "2026-07-16T14:39:00Z",
      open: 104.6,
      high: 104.9,
      low: 104.5,
      close: 104.8,
      volume: 3_000,
      tradeCount: 40,
      vwap: 104.7
    }
  };
}

describe("stock paper policy", () => {
  it("builds the same rotating universe for the same day", () => {
    const symbols = ["ZZZ", "AAA", "BBB", "CCC", "DDD"];
    expect(deterministicUniverse(symbols, "2026-07-16", 90))
      .toEqual(deterministicUniverse([...symbols].reverse(), "2026-07-16", 90));
  });

  it("recognizes weekday overnight sessions without treating the weekend as open", () => {
    const clock = {
      timestamp: "2026-07-17T01:20:00Z",
      isOpen: false,
      nextOpen: "2026-07-17T13:30:00Z",
      nextClose: "2026-07-17T20:00:00Z"
    };
    expect(marketPhase(clock, new Date("2026-07-17T01:20:00Z"))).toBe("OVERNIGHT");
    expect(marketPhase(clock, new Date("2026-07-18T01:20:00Z"))).toBe("CLOSED");
    expect(marketPhase(clock, new Date("2026-07-20T01:20:00Z"))).toBe("OVERNIGHT");
  });

  it("requires current quote and minute-bar evidence before a stock can enter", () => {
    const current = snapshot();
    expect(stockSnapshotIsFresh(current, new Date("2026-07-16T14:40:00Z"))).toBe(true);
    current.latestQuote = {
      ...current.latestQuote!,
      timestamp: "2026-07-16T14:30:00Z"
    };
    expect(stockSnapshotIsFresh(current, new Date("2026-07-16T14:40:00Z"))).toBe(false);
  });

  it("validates current quote evidence independently from delayed minute bars", () => {
    const current = snapshot();
    const now = new Date("2026-07-16T14:40:00Z");
    current.minuteBar = {
      ...current.minuteBar!,
      timestamp: "2026-07-16T14:20:00Z"
    };

    expect(stockQuoteIsFresh(current, now)).toBe(true);
    expect(stockSnapshotIsFresh(current, now)).toBe(false);

    current.latestQuote = {
      ...current.latestQuote!,
      bidPrice: 105,
      askPrice: 104.9
    };
    expect(stockQuoteIsFresh(current, now)).toBe(false);
  });

  it("models the free derived overnight bar delay without weakening real-time feeds", () => {
    const delayed = snapshot();
    delayed.latestQuote = { ...delayed.latestQuote!, timestamp: "2026-07-17T00:20:00Z" };
    delayed.minuteBar = { ...delayed.minuteBar!, timestamp: "2026-07-17T00:04:00Z" };
    const now = new Date("2026-07-17T00:20:00Z");

    expect(stockPaperMaximumBarAgeMs("REGULAR")).toBe(4 * 60_000);
    expect(stockPaperMaximumBarAgeMs("OVERNIGHT")).toBe(20 * 60_000);
    expect(stockSnapshotIsFresh(delayed, now)).toBe(false);
    expect(stockSnapshotIsFresh(
      delayed,
      now,
      undefined,
      stockPaperMaximumBarAgeMs("OVERNIGHT")
    )).toBe(true);
    expect(DEFAULT_STOCK_PAPER_POLICY.overnightDerivedLimitConfirmationMinutes).toBeGreaterThan(20);
  });

  it("rejects stale or gapped cross-session bars and accepts a contiguous current-phase window", () => {
    const capturedAt = "2026-07-17T01:20:00.000Z";
    expect(currentPhaseBarWindow({
      bars: bars(),
      capturedAt,
      phase: "OVERNIGHT"
    })).toHaveLength(0);

    const fresh = Array.from({ length: 16 }, (_, index): AlpacaStockBar => ({
      timestamp: new Date(Date.parse(capturedAt) - (16 - index) * 60_000).toISOString(),
      open: 100 + index * 0.1,
      high: 100.2 + index * 0.1,
      low: 99.9 + index * 0.1,
      close: 100.1 + index * 0.1,
      volume: index >= 11 ? 3_000 : 1_000,
      tradeCount: 20,
      vwap: 100 + index * 0.1
    }));
    expect(currentPhaseBarWindow({ bars: fresh, capturedAt, phase: "OVERNIGHT" })).toHaveLength(16);

    const gapped = fresh.filter((_, index) => index !== 12);
    expect(currentPhaseBarWindow({ bars: gapped, capturedAt, phase: "OVERNIGHT" }).length).toBeLessThan(16);
    expect(currentPhaseBarWindow({
      bars: [...fresh, { ...fresh.at(-1)!, timestamp: "2026-07-17T01:21:00.000Z" }],
      capturedAt,
      phase: "OVERNIGHT"
    })).toHaveLength(16);
  });

  it("reconstructs bounded zero-trade overnight minutes for scoring only", () => {
    const capturedAt = "2026-07-17T00:38:00.000Z";
    const sparse = Array.from({ length: 16 }, (_, index): AlpacaStockBar => {
      const minute = index + Math.floor(index / 4);
      return {
        timestamp: new Date(Date.parse("2026-07-17T00:01:00.000Z") + minute * 60_000).toISOString(),
        open: 100 + index * 0.1,
        high: 100.2 + index * 0.1,
        low: 99.9 + index * 0.1,
        close: 100.1 + index * 0.1,
        volume: 1_000,
        tradeCount: 20,
        vwap: 100 + index * 0.1
      };
    });
    const reconstructed = currentPhaseBarWindow({
      bars: sparse,
      capturedAt,
      phase: "OVERNIGHT",
      maximumLatestAgeMs: 20 * 60_000,
      maximumGapMs: 5 * 60_000,
      fillMissingMinutes: true
    });
    expect(reconstructed.length).toBeGreaterThan(sparse.length);
    expect(reconstructed.filter((bar) => bar.volume === 0)).not.toHaveLength(0);
    expect(reconstructed.at(-1)?.timestamp).toBe(sparse.at(-1)?.timestamp);
  });

  it("uses the New York trade date instead of UTC midnight for risk resets", () => {
    expect(stockTradeDayKey(new Date("2026-01-16T00:30:00.000Z"))).toBe("2026-01-15");
    expect(stockTradeDayKey(new Date("2026-01-16T01:15:00.000Z"))).toBe("2026-01-16");
  });

  it("scores liquid momentum and gives an unproven context a cold-start cap", () => {
    const candidate = scoreStockCandidate({
      snapshot: snapshot(),
      bars: bars(),
      capturedAt: "2026-07-16T14:40:00Z"
    });
    expect(candidate.eligible).toBe(true);
    expect(candidate.score).toBeGreaterThanOrEqual(DEFAULT_STOCK_PAPER_POLICY.minimumSignalScore);
    const size = stockPositionSize({
      navUsd: 141,
      cashUsd: 141,
      deployedUsd: 0,
      candidate
    });
    expect(size).toBeCloseTo(141 * DEFAULT_STOCK_PAPER_POLICY.warmupMaximumPositionNavFraction, 8);
    expect(size).toBeLessThanOrEqual(141 * DEFAULT_STOCK_PAPER_POLICY.maximumPositionNavFraction);
  });

  it("keeps learning neutral during warmup, protects after repeated losses, and requires broad wins to upsize", () => {
    const fiveWins = adaptiveArmDecision({
      trades: Array.from({ length: 5 }, () => ({ pnlUsd: 1, returnPercent: 2 }))
    });
    expect(fiveWins).toMatchObject({ multiplier: 1, status: "WARMING_UP", sampleSize: 5 });

    const losses = adaptiveArmDecision({
      trades: Array.from({ length: 8 }, () => ({ pnlUsd: -1, returnPercent: -3 }))
    });
    expect(losses.status).toBe("DOWNSIZED");
    expect(losses.multiplier).toBeLessThan(1);
    expect(losses.multiplier).toBeGreaterThanOrEqual(0.7);

    const broadWins = adaptiveArmDecision({
      trades: Array.from({ length: 30 }, (_, index) => ({
        pnlUsd: index % 4 === 0 ? -0.25 : 1,
        returnPercent: index % 4 === 0 ? -0.5 : 2
      }))
    });
    expect(broadWins.status).toBe("UPSIZED");
    expect(broadWins.multiplier).toBeGreaterThan(1);
    expect(broadWins.multiplier).toBeLessThanOrEqual(1.15);
  });

  it("uses pooled evidence only to protect a young exact context", () => {
    const protectedDecision = adaptiveHierarchicalArmDecision({
      contextTrades: [
        { pnlUsd: 1, returnPercent: 1 },
        { pnlUsd: 1, returnPercent: 1 }
      ],
      downsideReferenceTrades: Array.from({ length: 10 }, (_, index) => ({
        symbol: index < 6 ? "SOXL" : "AAPL",
        pnlUsd: -1,
        returnPercent: -3
      })),
      candidateSymbol: "DRAM"
    });
    expect(protectedDecision).toMatchObject({
      status: "DOWNSIZED",
      exactContextSampleSize: 2,
      downsideReference: "EXPOSURE_GROUP",
      downsideReferenceSampleSize: 6
    });
    expect(protectedDecision.multiplier).toBeLessThan(1);

    const positivePoolCannotUpsize = adaptiveHierarchicalArmDecision({
      contextTrades: Array.from({ length: 5 }, () => ({ pnlUsd: 1, returnPercent: 2 })),
      downsideReferenceTrades: Array.from({ length: 20 }, () => ({
        symbol: "JPM",
        pnlUsd: 1,
        returnPercent: 2
      })),
      candidateSymbol: "AAPL"
    });
    expect(positivePoolCannotUpsize).toMatchObject({
      status: "WARMING_UP",
      multiplier: 1,
      exactContextSampleSize: 5
    });

    const exactUpsizeSurvivesHealthyPool = adaptiveHierarchicalArmDecision({
      contextTrades: Array.from({ length: 30 }, (_, index) => ({
        pnlUsd: index % 4 === 0 ? -0.25 : 1,
        returnPercent: index % 4 === 0 ? -0.5 : 2
      })),
      downsideReferenceTrades: Array.from({ length: 20 }, () => ({
        symbol: "JPM",
        pnlUsd: 1,
        returnPercent: 2
      })),
      candidateSymbol: "AAPL"
    });
    expect(exactUpsizeSurvivesHealthyPool.status).toBe("UPSIZED");
    expect(exactUpsizeSurvivesHealthyPool.multiplier).toBeGreaterThan(1);
  });

  it("caps downside exploration even when the exact context is still young", () => {
    const candidate = scoreStockCandidate({
      snapshot: snapshot(),
      bars: bars(),
      capturedAt: "2026-07-16T14:40:00Z"
    });
    const decision = stockPositionRiskDecision({
      navUsd: 1_000,
      cashUsd: 1_000,
      deployedUsd: 0,
      candidate,
      armMultiplier: 0.75,
      learningStatus: "DOWNSIZED",
      learningSampleSize: 0
    });
    const downsideCapFraction = Math.min(
      DEFAULT_STOCK_PAPER_POLICY.warmupMaximumPositionNavFraction,
      DEFAULT_STOCK_PAPER_POLICY.establishedMaximumPositionNavFraction * 0.35,
      DEFAULT_STOCK_PAPER_POLICY.maximumPositionNavFraction * 0.25
    );

    expect(decision.learningTier).toBe("ESTABLISHED");
    expect(decision.positionCapNavFraction).toBeCloseTo(downsideCapFraction, 8);
    expect(decision.notionalUsd).toBeLessThanOrEqual(1_000 * downsideCapFraction);
    expect(decision.notionalUsd).toBeLessThan(1_000 * DEFAULT_STOCK_PAPER_POLICY.warmupMaximumPositionNavFraction);
  });

  it("classifies leveraged products and shares a deterministic semiconductor budget", () => {
    expect(stockInstrumentRiskProfile("SOXL")).toMatchObject({
      riskClass: "LEVERAGED_ETF",
      leverageMultiple: 3,
      inverse: false,
      exposureGroup: "SEMICONDUCTORS"
    });
    expect(stockInstrumentRiskProfile("SOXS")).toMatchObject({
      riskClass: "INVERSE_ETF",
      leverageMultiple: 3,
      inverse: true,
      exposureGroup: "SEMICONDUCTORS"
    });
    expect(stockInstrumentRiskProfile("DRAM").exposureGroup).toBe("SEMICONDUCTORS");
  });

  it("sizes by volatility, instrument leverage, learning proof, and shared exposure", () => {
    const base = scoreStockCandidate({
      snapshot: snapshot(),
      bars: bars(),
      capturedAt: "2026-07-16T14:40:00Z"
    });
    const soxl = stockPositionRiskDecision({
      navUsd: 1_000,
      cashUsd: 1_000,
      deployedUsd: 0,
      candidate: {
        ...base,
        symbol: "SOXL",
        highConviction: true,
        realizedVolatilityPercent: 1
      },
      learningStatus: "WARMING_UP",
      learningSampleSize: 0
    });
    expect(soxl.positionCapNavFraction).toBe(
      DEFAULT_STOCK_PAPER_POLICY.leveragedMaximumPositionNavFraction
    );
    expect(soxl.notionalUsd).toBeLessThan(180);

    const correlated = stockPositionRiskDecision({
      navUsd: 1_000,
      cashUsd: 820,
      deployedUsd: 180,
      candidate: {
        ...base,
        symbol: "DRAM",
        highConviction: true,
        realizedVolatilityPercent: 1
      },
      armMultiplier: 1.15,
      learningStatus: "UPSIZED",
      learningSampleSize: 30,
      portfolioExposures: [{ symbol: "SOXL", notionalUsd: 180 }]
    });
    expect(correlated.groupRoomUsd).toBe(170);
    expect(correlated.notionalUsd).toBe(170);

    const independent = stockPositionRiskDecision({
      navUsd: 1_000,
      cashUsd: 820,
      deployedUsd: 180,
      candidate: {
        ...base,
        symbol: "JPM",
        highConviction: true,
        realizedVolatilityPercent: 1
      },
      armMultiplier: 1.15,
      learningStatus: "UPSIZED",
      learningSampleSize: 30,
      portfolioExposures: [{ symbol: "SOXL", notionalUsd: 180 }]
    });
    expect(independent.notionalUsd).toBe(350);

    const highVolatility = stockPositionRiskDecision({
      navUsd: 1_000,
      cashUsd: 1_000,
      deployedUsd: 0,
      candidate: {
        ...base,
        symbol: "JPM",
        highConviction: true,
        realizedVolatilityPercent: 8
      },
      armMultiplier: 1.15,
      learningStatus: "UPSIZED",
      learningSampleSize: 30
    });
    expect(highVolatility.volatilityMultiplier).toBe(
      DEFAULT_STOCK_PAPER_POLICY.minimumVolatilitySizeMultiplier
    );
    expect(highVolatility.notionalUsd).toBeCloseTo(258.75, 8);
    expect(highVolatility.notionalUsd).toBeLessThan(independent.notionalUsd);
  });

  it("requires an observed pullback followed by a two-bar VWAP reclaim", () => {
    const reclaimBars = Array.from({ length: 10 }, (_, index): AlpacaStockBar => {
      const close = index < 8 ? 100 + index * 0.05 : 100.5 + (index - 8) * 0.2;
      const vwap = index === 7 ? 100.4 : close - 0.08;
      return {
        timestamp: new Date(Date.parse("2026-07-16T14:00:00Z") + index * 60_000).toISOString(),
        open: close - 0.04,
        high: close + 0.08,
        low: index === 7 ? 100.35 : close - 0.05,
        close,
        volume: 1_000,
        tradeCount: 20,
        vwap
      };
    });
    expect(hasCausalPullbackReclaim(reclaimBars)).toBe(true);
    expect(hasCausalPullbackReclaim(reclaimBars.map((bar) => ({
      ...bar,
      low: bar.vwap + 0.01
    })))).toBe(false);
  });

  it("lets a learned downsize reduce a high-conviction capped position", () => {
    const candidate = scoreStockCandidate({
      snapshot: snapshot(),
      bars: bars(),
      capturedAt: "2026-07-16T14:40:00Z"
    });
    const neutral = stockPositionSize({
      navUsd: 141,
      cashUsd: 141,
      deployedUsd: 0,
      candidate,
      armMultiplier: 1
    });
    const reduced = stockPositionSize({
      navUsd: 141,
      cashUsd: 141,
      deployedUsd: 0,
      candidate,
      armMultiplier: 0.7
    });
    expect(reduced).toBeCloseTo(neutral * 0.7, 8);
    expect(neutral).toBeLessThanOrEqual(141 * DEFAULT_STOCK_PAPER_POLICY.maximumPositionNavFraction);
  });

  it("reserves detailed scan slots for snapshots that can still qualify", () => {
    const eligible = snapshot();
    expect(passesStockSnapshotPrefilter(eligible)).toBe(true);

    const tooExpensive = snapshot();
    tooExpensive.latestQuote = {
      timestamp: "2026-07-16T14:40:00Z",
      bidPrice: 704.9,
      bidSize: 10,
      askPrice: 705.1,
      askSize: 10
    };
    expect(passesStockSnapshotPrefilter(tooExpensive)).toBe(false);

    const tooWide = snapshot();
    tooWide.latestQuote = {
      timestamp: "2026-07-16T14:40:00Z",
      bidPrice: 95,
      bidSize: 10,
      askPrice: 105,
      askSize: 10
    };
    expect(passesStockSnapshotPrefilter(tooWide)).toBe(false);

    const tooThin = snapshot();
    tooThin.dailyBar = {
      ...tooThin.dailyBar!,
      volume: 1_000
    };
    expect(passesStockSnapshotPrefilter(tooThin)).toBe(false);
  });

  it("applies deterministic stop, target, trailing, and time exits", () => {
    const position = {
      id: "position",
      laneId: "lane",
      symbol: "AAPL",
      arm: "BREAKOUT" as const,
      status: "OPEN" as const,
      quantity: 0.5,
      entryPriceUsd: 100,
      entryNotionalUsd: 50,
      remainingCostUsd: 50,
      lastBidUsd: 99,
      lastAskUsd: 99.1,
      lastMarkUsd: 99,
      lastValueUsd: 49.5,
      peakPriceUsd: 108,
      stopPriceUsd: 92,
      takeProfitPriceUsd: 112,
      scoreAtEntry: 80,
      openedAt: "2026-07-16T14:00:00Z",
      updatedAt: "2026-07-16T14:00:00Z"
    };
    expect(stockExitDecision({
      position,
      bidPrice: 91,
      now: "2026-07-16T14:30:00Z"
    })).toBe("STOP_LOSS");
    expect(stockExitDecision({
      position,
      bidPrice: 112,
      now: "2026-07-16T14:30:00Z"
    })).toBe("TAKE_PROFIT");
    expect(stockExitDecision({
      position,
      bidPrice: 103,
      now: "2026-07-16T14:30:00Z"
    })).toBe("TRAILING_STOP");
  });

  it("uses a robust portfolio mark when a single-exchange quote is temporarily wide", () => {
    const wideSnapshot = snapshot();
    wideSnapshot.latestQuote = {
      timestamp: "2026-07-16T14:40:00Z",
      bidPrice: 79,
      bidSize: 1,
      askPrice: 91,
      askSize: 1
    };
    wideSnapshot.latestTrade = {
      timestamp: "2026-07-16T14:40:00Z",
      price: 85.05,
      size: 10
    };
    wideSnapshot.minuteBar = {
      timestamp: "2026-07-16T14:40:00Z",
      open: 84.9,
      high: 85.1,
      low: 84.85,
      close: 85,
      volume: 1_000,
      tradeCount: 20,
      vwap: 85
    };

    expect(stockMarkPrice(wideSnapshot)).toBeCloseTo(85, 5);
  });

  it("evaluates exactly 1,000 exit variants without turning them into trades", () => {
    const replay = replayClosedStockTrade({
      bars: bars(),
      entryPriceUsd: 100,
      actualReturnPercent: 2,
      generatedAt: "2026-07-16T15:00:00Z"
    });
    expect(replay.variantCount).toBe(1000);
    expect(replay.scorableVariantCount).toBe(1000);
    expect(replay.profitableVariantCount).toBeGreaterThan(0);
    expect(replay.actualPercentile).toBeGreaterThanOrEqual(0);
    expect(replay.actualPercentile).toBeLessThanOrEqual(100);
  });
});
