import { createHash } from "node:crypto";
import {
  STOCK_PAPER_EXECUTION_VERSION,
  STOCK_PAPER_FEATURE_VERSION,
  STOCK_PAPER_POLICY_VERSION,
  type StockPaperOrderSide,
  type StockPaperTrade
} from "@copylab/shared";
import { describe, expect, it } from "vitest";
import {
  prepareStockPaperLearningV4Evidence,
  type StockPaperLearningV4OrderEvent,
  type StockPaperLearningV4RawBenchmarkEvidence
} from "../src/stock-paper-learning-v4-evidence.js";

const DIGEST = "a".repeat(64);

function trade(input: Partial<StockPaperTrade> = {}): StockPaperTrade {
  return {
    id: "trade-1",
    laneId: "lane-1",
    positionId: "position-1",
    symbol: "AAPL",
    arm: "BREAKOUT",
    quantity: 1,
    entryPriceUsd: 100,
    exitPriceUsd: 102,
    entryNotionalUsd: 100,
    proceedsUsd: 102,
    modeledCostsUsd: 0,
    pnlUsd: 2,
    returnPercent: 2,
    exitReason: "TAKE_PROFIT",
    openedAt: "2026-07-15T14:31:00.000Z",
    closedAt: "2026-07-15T15:31:00.000Z",
    entryContext: {
      featureVersion: STOCK_PAPER_FEATURE_VERSION,
      policyVersion: STOCK_PAPER_POLICY_VERSION,
      executionVersion: STOCK_PAPER_EXECUTION_VERSION,
      policyDigest: DIGEST,
      phase: "REGULAR",
      feed: "IEX",
      capturedAt: "2026-07-15T14:31:00.000Z",
      candidateRank: 1,
      candidateScore: 85,
      relativeVolume: 2,
      spreadPercent: 0.05,
      change1mPercent: 0.2,
      change5mPercent: 1,
      change15mPercent: 2,
      newsArticleCount: 0,
      screenerHit: true,
      learningMultiplier: 1,
      learningStatus: "NEUTRAL",
      learningSampleSize: 20,
      modeledLimitPriceUsd: 100,
      onlineSources: ["MOVER"],
      highConviction: true,
      dollarVolumeUsd: 50_000_000,
      vwapDistancePercent: 0.5,
      dailyChangePercent: 3
    },
    ...input
  };
}

function rawBenchmarkEvidence(
  evidence: "QUOTE" | "BAR",
  timestamp: string,
  priceUsd: number
): StockPaperLearningV4RawBenchmarkEvidence {
  return evidence === "QUOTE"
    ? {
        kind: "QUOTE",
        timestamp,
        bidPrice: priceUsd - 0.05,
        bidSize: 100,
        askPrice: priceUsd + 0.05,
        askSize: 120
      }
    : {
        kind: "BAR",
        timestamp,
        open: priceUsd,
        high: priceUsd + 1,
        low: priceUsd - 1,
        close: priceUsd,
        volume: 10_000,
        tradeCount: 500,
        vwap: priceUsd
      };
}

function rawBenchmarkDigest(raw: StockPaperLearningV4RawBenchmarkEvidence): string {
  const payload = raw.kind === "QUOTE"
    ? {
        timestamp: raw.timestamp,
        bidPrice: raw.bidPrice,
        bidSize: raw.bidSize,
        askPrice: raw.askPrice,
        askSize: raw.askSize
      }
    : {
        timestamp: raw.timestamp,
        open: raw.open,
        high: raw.high,
        low: raw.low,
        close: raw.close,
        volume: raw.volume,
        tradeCount: raw.tradeCount,
        vwap: raw.vwap
      };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function fillEvent(input: {
  id: string;
  side: StockPaperOrderSide;
  quantity: number;
  notionalUsd: number;
  decisionAt: string;
  benchmarkPriceUsd: number;
  evidence?: "QUOTE" | "BAR";
  evidenceAt?: string;
  evidenceObservedAt?: string;
  benchmarkTimestamp?: string;
  benchmarkObservedAt?: string;
  omitBenchmark?: boolean;
  omitRawBenchmark?: boolean;
  modeledCostsUsd?: number;
}): StockPaperLearningV4OrderEvent {
  const evidence = input.evidence ?? "QUOTE";
  const evidenceAt = input.evidenceAt ?? input.decisionAt;
  const observedAt = input.evidenceObservedAt ?? input.decisionAt;
  const benchmarkTimestamp = input.benchmarkTimestamp ?? evidenceAt;
  const benchmarkObservedAt = input.benchmarkObservedAt ?? observedAt;
  const rawBenchmark = rawBenchmarkEvidence(evidence, benchmarkTimestamp, input.benchmarkPriceUsd);
  return {
    id: `event-${input.id}`,
    idempotencyKey: `order-${input.side}:${input.id}`,
    laneId: "lane-1",
    orderId: `order-${input.side}`,
    sequence: Number(input.id.replace(/\D/gu, "")) || 1,
    positionId: "position-1",
    symbol: "AAPL",
    side: input.side,
    eventType: "FILL",
    priorStatus: "SUBMITTED",
    newStatus: "FILLED",
    decisionAt: input.decisionAt,
    evidenceObservedAt: observedAt,
    ...(evidence === "BAR" ? { evidenceBarTimestamp: evidenceAt, barDigest: DIGEST } : {
      quoteTimestamp: evidenceAt,
      quoteDigest: DIGEST
    }),
    ...(!input.omitBenchmark ? {
      benchmarkSymbol: "SPY" as const,
      benchmarkEvidence: evidence,
      benchmarkTimestamp,
      benchmarkObservedAt,
      benchmarkPriceUsd: input.benchmarkPriceUsd,
      benchmarkDigest: rawBenchmarkDigest(rawBenchmark),
      ...(!input.omitRawBenchmark ? { benchmarkRawEvidence: rawBenchmark } : {})
    } : {}),
    phase: "REGULAR",
    feed: "IEX",
    assumptions: {
      executionVersion: STOCK_PAPER_EXECUTION_VERSION,
      limitPriceUsd: input.notionalUsd / input.quantity,
      participationRatePercent: 100,
      marketable: input.side === "SELL",
      spreadPercent: 0.05,
      extendedFillPenaltyPercent: 0
    },
    fill: {
      id: `fill-${input.id}`,
      quantity: input.quantity,
      priceUsd: input.notionalUsd / input.quantity,
      notionalUsd: input.notionalUsd,
      modeledCostsUsd: input.modeledCostsUsd ?? 0,
      evidence,
      evidenceAt,
      createdAt: input.decisionAt
    },
    reason: "Test PAPER fill evidence.",
    createdAt: input.decisionAt
  };
}

function completeEvents(): StockPaperLearningV4OrderEvent[] {
  return [
    fillEvent({
      id: "1",
      side: "BUY",
      quantity: 1,
      notionalUsd: 100,
      decisionAt: "2026-07-15T14:31:00.000Z",
      benchmarkPriceUsd: 500
    }),
    fillEvent({
      id: "2",
      side: "SELL",
      quantity: 1,
      notionalUsd: 102,
      decisionAt: "2026-07-15T15:31:00.000Z",
      benchmarkPriceUsd: 505
    })
  ];
}

describe("stock PAPER learning-v4 immutable evidence preparation", () => {
  it("uses same-cycle append-only fill evidence for the SPY comparison", () => {
    const result = prepareStockPaperLearningV4Evidence({
      cutoffAt: "2026-07-16T18:00:00.000Z",
      trades: [trade()],
      orderEvents: completeEvents()
    });

    expect(result.sourceTradeCount).toBe(1);
    expect(result.analysisTradeCount).toBe(1);
    expect(result.exclusions).toEqual([]);
    expect(result.trades[0]).toMatchObject({
      laneId: "lane-1",
      policyVersion: STOCK_PAPER_POLICY_VERSION,
      featureVersion: STOCK_PAPER_FEATURE_VERSION,
      executionVersion: STOCK_PAPER_EXECUTION_VERSION,
      tradeDayKey: "2026-07-15",
      openedAt: "2026-07-15T14:31:00.000Z",
      closedAt: "2026-07-15T15:31:00.000Z"
    });
    expect(result.trades[0]?.spyReturnPercent).toBeCloseTo(1, 10);
  });

  it("derives cost basis, proceeds, fees, realized P&L, and return only from BUY and SELL fills", () => {
    const events = [
      fillEvent({ id: "1", side: "BUY", quantity: 0.4, notionalUsd: 40,
        modeledCostsUsd: 0.04, decisionAt: "2026-07-15T14:31:00.000Z", benchmarkPriceUsd: 500 }),
      fillEvent({ id: "2", side: "BUY", quantity: 0.6, notionalUsd: 63,
        modeledCostsUsd: 0.06, decisionAt: "2026-07-15T14:32:00.000Z", benchmarkPriceUsd: 501 }),
      fillEvent({ id: "3", side: "SELL", quantity: 0.25, notionalUsd: 27,
        modeledCostsUsd: 0.01, decisionAt: "2026-07-15T15:30:00.000Z", benchmarkPriceUsd: 504 }),
      fillEvent({ id: "4", side: "SELL", quantity: 0.75, notionalUsd: 84,
        modeledCostsUsd: 0.02, decisionAt: "2026-07-15T15:31:00.000Z", benchmarkPriceUsd: 505 })
    ];
    const ledgerCostBasisUsd = 103.1;
    const ledgerNetProceedsUsd = 110.97;
    const ledgerPnlUsd = ledgerNetProceedsUsd - ledgerCostBasisUsd;
    const ledgerReturnPercent = ledgerPnlUsd / ledgerCostBasisUsd * 100;
    const result = prepareStockPaperLearningV4Evidence({
      cutoffAt: "2026-07-16T18:00:00.000Z",
      trades: [trade({
        entryPriceUsd: 103,
        exitPriceUsd: 111,
        entryNotionalUsd: ledgerCostBasisUsd,
        proceedsUsd: ledgerNetProceedsUsd,
        modeledCostsUsd: 0.13,
        pnlUsd: ledgerPnlUsd,
        returnPercent: ledgerReturnPercent
      })],
      orderEvents: events
    });

    expect(result.exclusions).toEqual([]);
    expect(result.trades[0]?.notionalUsd).toBeCloseTo(ledgerCostBasisUsd, 12);
    expect(result.trades[0]?.netReturnPercent).toBeCloseTo(ledgerReturnPercent, 12);
  });

  it("fails closed on every completed-trade economics mismatch instead of trusting the row return", () => {
    const cases: Array<{
      patch: Partial<StockPaperTrade>;
      reason: string;
    }> = [
      { patch: { entryNotionalUsd: 99 }, reason: "COST_BASIS_MISMATCH" },
      { patch: { entryPriceUsd: 99 }, reason: "COST_BASIS_MISMATCH" },
      { patch: { modeledCostsUsd: 0.01 }, reason: "MODELED_COSTS_MISMATCH" },
      { patch: { proceedsUsd: 101 }, reason: "GROSS_PROCEEDS_MISMATCH" },
      { patch: { exitPriceUsd: 101 }, reason: "GROSS_PROCEEDS_MISMATCH" },
      { patch: { pnlUsd: 3 }, reason: "REALIZED_PNL_MISMATCH" },
      { patch: { returnPercent: 999 }, reason: "RETURN_MISMATCH" }
    ];

    for (const testCase of cases) {
      const result = prepareStockPaperLearningV4Evidence({
        cutoffAt: "2026-07-16T18:00:00.000Z",
        trades: [trade(testCase.patch)],
        orderEvents: completeEvents()
      });
      expect(result.analysisTradeCount).toBe(0);
      expect(result.exclusions[0]?.reason).toBe(testCase.reason);
    }
  });

  it("rejects non-finite fill fees and price-times-quantity notional mismatches", () => {
    const invalidCostEvents = completeEvents();
    invalidCostEvents[0] = {
      ...invalidCostEvents[0]!,
      fill: { ...invalidCostEvents[0]!.fill!, modeledCostsUsd: Number.POSITIVE_INFINITY }
    };
    const wrongNotionalEvents = completeEvents();
    wrongNotionalEvents[0] = {
      ...wrongNotionalEvents[0]!,
      fill: { ...wrongNotionalEvents[0]!.fill!, notionalUsd: 99 }
    };

    const invalidCost = prepareStockPaperLearningV4Evidence({
      cutoffAt: "2026-07-16T18:00:00.000Z",
      trades: [trade()],
      orderEvents: invalidCostEvents
    });
    const wrongNotional = prepareStockPaperLearningV4Evidence({
      cutoffAt: "2026-07-16T18:00:00.000Z",
      trades: [trade()],
      orderEvents: wrongNotionalEvents
    });

    expect(invalidCost.exclusions[0]?.reason).toBe("FILL_ECONOMICS_INVALID");
    expect(wrongNotional.exclusions[0]?.reason).toBe("FILL_NOTIONAL_MISMATCH");
  });

  it("benchmarks partial fills cash-flow by cash-flow with FIFO lot matching", () => {
    const events = [
      fillEvent({ id: "1", side: "BUY", quantity: 0.5, notionalUsd: 50,
        decisionAt: "2026-07-15T14:31:00.000Z", benchmarkPriceUsd: 100 }),
      fillEvent({ id: "2", side: "BUY", quantity: 0.5, notionalUsd: 55,
        decisionAt: "2026-07-15T14:32:00.000Z", benchmarkPriceUsd: 110 }),
      fillEvent({ id: "3", side: "SELL", quantity: 0.25, notionalUsd: 27,
        decisionAt: "2026-07-15T15:30:00.000Z", benchmarkPriceUsd: 121 }),
      fillEvent({ id: "4", side: "SELL", quantity: 0.75, notionalUsd: 84,
        decisionAt: "2026-07-15T15:31:00.000Z", benchmarkPriceUsd: 132 })
    ];
    const result = prepareStockPaperLearningV4Evidence({
      cutoffAt: "2026-07-16T18:00:00.000Z",
      trades: [trade({
        entryPriceUsd: 105,
        exitPriceUsd: 111,
        entryNotionalUsd: 105,
        proceedsUsd: 111,
        pnlUsd: 6,
        returnPercent: 6 / 105 * 100
      })],
      orderEvents: events
    });

    expect(result.analysisTradeCount).toBe(1);
    expect(result.trades[0]?.spyReturnPercent).toBeCloseTo(24.25 / 105 * 100, 10);
  });

  it("rejects a minute-bar close until both market and arrival clocks prove it was known", () => {
    const events = completeEvents();
    events[0] = fillEvent({
      id: "1",
      side: "BUY",
      quantity: 1,
      notionalUsd: 100,
      decisionAt: "2026-07-15T14:31:30.000Z",
      evidence: "BAR",
      evidenceAt: "2026-07-15T14:31:00.000Z",
      evidenceObservedAt: "2026-07-15T14:31:30.000Z",
      benchmarkTimestamp: "2026-07-15T14:31:00.000Z",
      benchmarkObservedAt: "2026-07-15T14:31:30.000Z",
      benchmarkPriceUsd: 500
    });

    const result = prepareStockPaperLearningV4Evidence({
      cutoffAt: "2026-07-16T18:00:00.000Z",
      trades: [trade()],
      orderEvents: events
    });

    expect(result.analysisTradeCount).toBe(0);
    expect(result.exclusions[0]?.reason).toBe("NON_CAUSAL_EVENT_CLOCK");
  });

  it("accepts a completed minute bar only after its close was observed", () => {
    const events = completeEvents();
    events[0] = fillEvent({
      id: "1",
      side: "BUY",
      quantity: 1,
      notionalUsd: 100,
      decisionAt: "2026-07-15T14:32:05.000Z",
      evidence: "BAR",
      evidenceAt: "2026-07-15T14:31:00.000Z",
      evidenceObservedAt: "2026-07-15T14:32:05.000Z",
      benchmarkTimestamp: "2026-07-15T14:31:00.000Z",
      benchmarkObservedAt: "2026-07-15T14:32:05.000Z",
      benchmarkPriceUsd: 500
    });

    const result = prepareStockPaperLearningV4Evidence({
      cutoffAt: "2026-07-16T18:00:00.000Z",
      trades: [trade()],
      orderEvents: events
    });

    expect(result.analysisTradeCount).toBe(1);
    expect(result.trades[0]?.openedAt).toBe("2026-07-15T14:32:05.000Z");
  });

  it("fails closed when v41 benchmark evidence is absent", () => {
    const events = completeEvents();
    events[0] = fillEvent({
      id: "1",
      side: "BUY",
      quantity: 1,
      notionalUsd: 100,
      decisionAt: "2026-07-15T14:31:00.000Z",
      benchmarkPriceUsd: 500,
      omitBenchmark: true
    });
    const result = prepareStockPaperLearningV4Evidence({
      cutoffAt: "2026-07-16T18:00:00.000Z",
      trades: [trade()],
      orderEvents: events
    });

    expect(result.analysisTradeCount).toBe(0);
    expect(result.exclusions[0]?.reason).toBe("BENCHMARK_EVIDENCE_MISSING");
  });

  it("explicitly excludes a digest-shaped benchmark that lacks its reconstructable raw payload", () => {
    const events = completeEvents();
    events[0] = fillEvent({
      id: "1",
      side: "BUY",
      quantity: 1,
      notionalUsd: 100,
      decisionAt: "2026-07-15T14:31:00.000Z",
      benchmarkPriceUsd: 500,
      omitRawBenchmark: true
    });
    const result = prepareStockPaperLearningV4Evidence({
      cutoffAt: "2026-07-16T18:00:00.000Z",
      trades: [trade()],
      orderEvents: events
    });

    expect(result.analysisTradeCount).toBe(0);
    expect(result.exclusions[0]?.reason).toBe("BENCHMARK_EVIDENCE_UNVERIFIABLE");
  });

  it("recomputes the benchmark digest and rejects a raw payload changed after hashing", () => {
    const events = completeEvents();
    const original = events[0]!;
    const raw = original.benchmarkRawEvidence!;
    expect(raw.kind).toBe("QUOTE");
    events[0] = {
      ...original,
      benchmarkRawEvidence: raw.kind === "QUOTE"
        ? { ...raw, bidSize: raw.bidSize + 1 }
        : raw
    };
    const result = prepareStockPaperLearningV4Evidence({
      cutoffAt: "2026-07-16T18:00:00.000Z",
      trades: [trade()],
      orderEvents: events
    });

    expect(result.analysisTradeCount).toBe(0);
    expect(result.exclusions[0]?.reason).toBe("BENCHMARK_DIGEST_MISMATCH");
  });

  it("excludes pre-v41 trades instead of reconstructing their fills", () => {
    const result = prepareStockPaperLearningV4Evidence({
      cutoffAt: "2026-07-16T18:00:00.000Z",
      trades: [trade()],
      orderEvents: []
    });

    expect(result.analysisTradeCount).toBe(0);
    expect(result.exclusions).toEqual([{
      tradeId: "trade-1",
      symbol: "AAPL",
      reason: "BUY_FILL_EVENTS_MISSING",
      evidenceEra: "LEGACY"
    }]);
  });

  it("classifies a completed trade opened after the durable boundary as post-v41 even if events are missing", () => {
    const result = prepareStockPaperLearningV4Evidence({
      cutoffAt: "2026-07-16T18:00:00.000Z",
      v41EvidenceStartedAt: "2026-07-15T14:00:00.000Z",
      trades: [trade()],
      orderEvents: []
    });

    expect(result.v41EvidenceStartedAt).toBe("2026-07-15T14:00:00.000Z");
    expect(result.exclusions[0]).toMatchObject({
      tradeId: "trade-1",
      reason: "BUY_FILL_EVENTS_MISSING",
      evidenceEra: "POST_V41"
    });
  });

  it("rejects a fill quantity mismatch and a trade closed after the cutoff", () => {
    const mismatched = prepareStockPaperLearningV4Evidence({
      cutoffAt: "2026-07-16T18:00:00.000Z",
      trades: [trade()],
      orderEvents: completeEvents().map((event) => event.side === "SELL"
        ? { ...event, fill: { ...event.fill!, quantity: 0.5, notionalUsd: 51 } }
        : event)
    });
    const future = prepareStockPaperLearningV4Evidence({
      cutoffAt: "2026-07-15T15:00:00.000Z",
      trades: [trade()],
      orderEvents: completeEvents()
    });

    expect(mismatched.exclusions[0]?.reason).toBe("FILL_QUANTITY_MISMATCH");
    expect(future.exclusions[0]?.reason).toBe("CLOSED_AFTER_CUTOFF");
  });

  it("rejects mismatched entry cash flow and a benchmark from another interval", () => {
    const wrongNotional = prepareStockPaperLearningV4Evidence({
      cutoffAt: "2026-07-16T18:00:00.000Z",
      trades: [trade({ entryNotionalUsd: 99 })],
      orderEvents: completeEvents()
    });
    const events = completeEvents();
    events[0] = fillEvent({
      id: "1",
      side: "BUY",
      quantity: 1,
      notionalUsd: 100,
      decisionAt: "2026-07-15T14:33:00.000Z",
      evidence: "BAR",
      evidenceAt: "2026-07-15T14:31:00.000Z",
      evidenceObservedAt: "2026-07-15T14:33:00.000Z",
      benchmarkTimestamp: "2026-07-15T14:30:00.000Z",
      benchmarkObservedAt: "2026-07-15T14:33:00.000Z",
      benchmarkPriceUsd: 500
    });
    const wrongInterval = prepareStockPaperLearningV4Evidence({
      cutoffAt: "2026-07-16T18:00:00.000Z",
      trades: [trade()],
      orderEvents: events
    });

    expect(wrongNotional.exclusions[0]?.reason).toBe("COST_BASIS_MISMATCH");
    expect(wrongInterval.exclusions[0]?.reason).toBe("NON_CAUSAL_EVENT_CLOCK");
  });

  it("passes through only explicitly supplied adjusted daily context", () => {
    const dailyReturns = [{
      symbol: "SPY",
      dateKey: "2026-07-14",
      returnPercent: 0.5,
      adjusted: true as const,
      session: "REGULAR" as const,
      coveragePercent: 100
    }];
    const result = prepareStockPaperLearningV4Evidence({
      cutoffAt: "2026-07-16T18:00:00.000Z",
      trades: [],
      orderEvents: [],
      dailyReturns
    });

    expect(result.dailyReturns).toEqual(dailyReturns);
  });
});
