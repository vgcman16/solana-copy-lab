import { describe, expect, it } from "vitest";
import {
  accrueProportionalExit,
  applyExitFill,
  calculateExecutableNav,
  calculateMaxDrawdownPercent,
  calculateProfitFactor,
  calculatePromotionGate,
  calculateRuntimeObservationCoverage,
  openPositionLot,
  shouldForcePositionExit,
  type ClosedTradeResult
} from "../src/index.js";
import { NOW, leaderSwap } from "./fixtures.js";

describe("position accounting", () => {
  it("opens a wallet-attributed lot and accumulates exits below $1", () => {
    const opened = openPositionLot({
      id: "position-1",
      mode: "PAPER",
      sourceSwap: leaderSwap(),
      receivedAmountAtomic: "1000",
      entryCostUsd: 5,
      executableValueUsd: 5
    });
    expect(opened).toMatchObject({
      sourceWallet: leaderSwap().sourceWallet,
      sourceEntrySignature: leaderSwap().sourceSignature,
      remainingAmountAtomic: "1000",
      remainingCostUsd: 5,
      status: "OPEN"
    });

    const first = accrueProportionalExit(opened, 0.1, 5);
    expect(first.request).toBeUndefined();
    expect(first.position.pendingExitFraction).toBeCloseTo(0.1);

    const second = accrueProportionalExit(first.position, 0.2, 5);
    expect(second.request).toMatchObject({ amountAtomic: "280", estimatedValueUsd: 1.4, forceFullExit: false });
    const filled = applyExitFill(second.position, second.request!.amountAtomic, 1.5, NOW);
    expect(filled.costBasisReleasedUsd).toBeCloseTo(1.4);
    expect(filled.realizedPnlUsd).toBeCloseTo(0.1);
    expect(filled.position).toMatchObject({ remainingAmountAtomic: "720", remainingCostUsd: 3.6, status: "OPEN" });
  });

  it("treats a leader sale of at least 90% as a full close", () => {
    const opened = openPositionLot({
      id: "position-2",
      mode: "LIVE",
      sourceSwap: leaderSwap(),
      receivedAmountAtomic: "99",
      entryCostUsd: 5
    });
    const plan = accrueProportionalExit(opened, 0.9, 4);
    expect(plan.request).toMatchObject({ amountAtomic: "99", fractionOfRemaining: 1, forceFullExit: true });
    const filled = applyExitFill(plan.position, "99", 4, NOW);
    expect(filled.position).toMatchObject({ remainingAmountAtomic: "0", status: "CLOSED", closedAt: NOW.toISOString() });
    expect(filled.realizedPnlUsd).toBe(-1);
  });

  it("forces exits at the 15% loss, seven-day age, or token-safety boundary", () => {
    const opened = openPositionLot({
      id: "position-3",
      mode: "PAPER",
      sourceSwap: leaderSwap({ blockTime: "2026-02-08T12:00:00.000Z" }),
      receivedAmountAtomic: "100",
      entryCostUsd: 5,
      executableValueUsd: 4.25
    });
    const result = shouldForcePositionExit(opened, NOW, false);
    expect(result.force).toBe(true);
    expect(result.reasons).toHaveLength(3);
  });
});

describe("portfolio and profit metrics", () => {
  it("uses full-position executable values and excludes closed lots from NAV", () => {
    const open = openPositionLot({
      id: "open",
      mode: "PAPER",
      sourceSwap: leaderSwap(),
      receivedAmountAtomic: "100",
      entryCostUsd: 5,
      executableValueUsd: 4.8
    });
    const closed = { ...open, id: "closed", status: "CLOSED" as const, lastExecutableValueUsd: 10 };
    expect(calculateExecutableNav({
      solReserveUsd: 5,
      usdcReserveUsd: 40,
      positions: [open, closed],
      unsettledFeesUsd: 0.1
    })).toBeCloseTo(49.7);
  });

  it("computes profit factor and peak-to-trough drawdown", () => {
    expect(calculateProfitFactor([2, -1, 1, -0.5])).toBe(2);
    expect(calculateProfitFactor([1, 2])).toBe(Infinity);
    expect(calculateMaxDrawdownPercent([
      { at: "2026-01-01T00:00:00Z", navUsd: 50 },
      { at: "2026-01-02T00:00:00Z", navUsd: 60 },
      { at: "2026-01-03T00:00:00Z", navUsd: 54 }
    ])).toBeCloseTo(10);
  });
});

function passingTrades(): ClosedTradeResult[] {
  const start = Date.parse("2026-01-01T12:00:00.000Z");
  return Array.from({ length: 50 }, (_, index) => {
    const loss = index % 5 === 0;
    return {
      closedAt: new Date(start + ((index % 28) + 1) * 86_400_000).toISOString(),
      pnlUsd: loss ? -0.1 : 0.2,
      stressPnlUsd: loss ? -0.15 : 0.1,
      sourceWallet: index % 2 === 0 ? "wallet-a" : "wallet-b"
    };
  });
}

const EVALUATION_START = "2026-01-01T00:00:00.000Z";

function executableCurve(trades: readonly ClosedTradeResult[], initialNavUsd = 50) {
  let navUsd = initialNavUsd;
  return [
    { at: EVALUATION_START, navUsd },
    ...[...trades]
      .sort((left, right) => Date.parse(left.closedAt) - Date.parse(right.closedAt))
      .map((trade) => {
        navUsd += trade.pnlUsd;
        return { at: trade.closedAt, navUsd };
      })
  ];
}

function promotionEvidence(trades: readonly ClosedTradeResult[], observedDays = 45) {
  return {
    initialNavUsd: 50,
    evaluationCohortId: "paper-evaluation-1",
    evaluationCohortStartAt: EVALUATION_START,
    observationCoverage: {
      heartbeatCount: observedDays * 1_440 + 1,
      consecutiveObservedMs: observedDays * 86_400_000,
      consecutiveObservedDays: observedDays,
      largestGapMs: 60_000,
      current: true,
      lastObservedAt: new Date(Date.parse(EVALUATION_START) + observedDays * 86_400_000).toISOString()
    },
    equityCurve: executableCurve(trades),
    executablePricingComplete: true
  };
}

describe("promotion gates", () => {
  it("passes only after all exact paper and manual-live gates are met", () => {
    const trades = passingTrades();
    const gate = calculatePromotionGate({
      now: NOW,
      initialNavUsd: 50,
      ...promotionEvidence(trades),
      trades,
      manualLiveOrders: 20,
      manualCompletedPositions: 5,
      paperExecutionShortfalls: Array(50).fill(0.25),
      manualExecutionShortfalls: Array(20).fill(0.2),
      manualPolicyViolations: 0
    });
    expect(gate).toMatchObject({
      elapsedDays: 45,
      completedExits: 50,
      positiveWeeks: 5,
      qualifyingWallets: 2,
      paperPassed: true,
      manualLivePassed: true,
      blockers: []
    });
    expect(gate.netReturnPercent).toBeGreaterThan(0);
    expect(gate.profitFactor).toBeGreaterThanOrEqual(1.2);
    expect(gate.maxDrawdownPercent).toBeLessThanOrEqual(10);
    expect(gate.stressNetReturnPercent).toBeGreaterThanOrEqual(0);
    expect(gate.stressMaxDrawdownPercent).toBeLessThanOrEqual(15);
  });

  it("keeps auto-live locked for excess shortfall or any policy violation", () => {
    const trades = passingTrades();
    const gate = calculatePromotionGate({
      now: NOW,
      ...promotionEvidence(trades),
      trades,
      manualLiveOrders: 20,
      manualCompletedPositions: 5,
      paperExecutionShortfalls: Array(50).fill(0.1),
      manualExecutionShortfalls: [...Array(19).fill(0.05), 0.2],
      manualPolicyViolations: 1
    });
    expect(gate.manualLivePassed).toBe(false);
    expect(gate.blockers).toEqual(expect.arrayContaining([
      "manual-live execution shortfall exceeds the paper 95th percentile",
      "a manual-live policy violation was recorded"
    ]));
  });

  it("keeps auto-live locked at 19 orders or four completed positions", () => {
    const trades = passingTrades();
    const gate = calculatePromotionGate({
      now: NOW,
      ...promotionEvidence(trades),
      trades,
      manualLiveOrders: 19,
      manualCompletedPositions: 4
    });
    expect(gate.paperPassed, JSON.stringify(gate.blockers)).toBe(true);
    expect(gate.manualLivePassed).toBe(false);
    expect(gate.blockers).toEqual(expect.arrayContaining([
      "fewer than 20 manually approved live orders",
      "fewer than five manual-live positions are complete"
    ]));
  });

  it("fails closed when stress PnL is missing", () => {
    const trades = passingTrades().map(({ stressPnlUsd: _stress, ...trade }) => trade);
    const gate = calculatePromotionGate({
      now: NOW,
      ...promotionEvidence(trades),
      trades,
      manualLiveOrders: 20,
      manualCompletedPositions: 5
    });
    expect(gate.paperPassed).toBe(false);
    expect(gate.blockers).toContain("stress replay is incomplete");
  });

  it("accepts a complete stress equity curve when per-trade stress PnL is stored separately", () => {
    const trades = passingTrades().map(({ stressPnlUsd: _stress, ...trade }) => trade);
    const gate = calculatePromotionGate({
      now: NOW,
      initialNavUsd: 50,
      ...promotionEvidence(trades),
      trades,
      stressEquityCurve: [
        { at: "2026-01-01T00:00:00.000Z", navUsd: 50 },
        { at: "2026-02-01T00:00:00.000Z", navUsd: 51 }
      ],
      manualLiveOrders: 20,
      manualCompletedPositions: 5
    });
    expect(gate.paperPassed).toBe(true);
    expect(gate.stressNetReturnPercent).toBe(2);
  });

  it("blocks runs shorter than 30 days and cohorts below 50 exits", () => {
    const trades = passingTrades().slice(0, 49);
    const gate = calculatePromotionGate({
      now: new Date("2026-01-30T00:00:00.000Z"),
      ...promotionEvidence(trades, 29),
      trades,
      manualLiveOrders: 20,
      manualCompletedPositions: 5
    });
    expect(gate.blockers).toEqual(expect.arrayContaining([
      "fewer than 30 consecutive observed paper days",
      "fewer than 50 paper exits are complete"
    ]));
  });

  it("does not turn 29 offline days plus one observed day into a 30-day run", () => {
    const start = "2026-01-01T00:00:00.000Z";
    const resumed = Date.parse("2026-01-30T00:00:00.000Z");
    const now = new Date("2026-01-31T00:00:00.000Z");
    const heartbeats = Array.from({ length: 1_441 }, (_, index) =>
      new Date(resumed + index * 60_000).toISOString()
    );
    const coverage = calculateRuntimeObservationCoverage(start, heartbeats, now);
    const trades = passingTrades();
    const gate = calculatePromotionGate({
      now,
      initialNavUsd: 50,
      ...promotionEvidence(trades),
      evaluationCohortStartAt: start,
      observationCoverage: coverage,
      trades,
      manualLiveOrders: 20,
      manualCompletedPositions: 5
    });
    expect(coverage.consecutiveObservedDays).toBe(1);
    expect(gate.elapsedDays).toBe(1);
    expect(gate.paperPassed).toBe(false);
    expect(gate.blockers).toContain("fewer than 30 consecutive observed paper days");
  });

  it("starts the clock at a late cohort freeze instead of paper setup", () => {
    const trades = passingTrades();
    const gate = calculatePromotionGate({
      now: NOW,
      paperStartAt: "2025-12-01T00:00:00.000Z",
      ...promotionEvidence(trades, 26),
      evaluationCohortStartAt: "2026-01-20T00:00:00.000Z",
      trades,
      manualLiveOrders: 20,
      manualCompletedPositions: 5
    });
    expect(gate.paperStartAt).toBe("2026-01-20T00:00:00.000Z");
    expect(gate.elapsedDays).toBe(26);
    expect(gate.paperPassed).toBe(false);
  });

  it("blocks promotion on a greater-than-10% intratrade executable mark drawdown", () => {
    const trades = passingTrades();
    const gate = calculatePromotionGate({
      now: NOW,
      initialNavUsd: 50,
      ...promotionEvidence(trades),
      equityCurve: [
        { at: EVALUATION_START, navUsd: 50 },
        { at: "2026-01-10T00:00:00.000Z", navUsd: 60 },
        { at: "2026-01-11T00:00:00.000Z", navUsd: 53 },
        { at: NOW.toISOString(), navUsd: 61 }
      ],
      trades,
      manualLiveOrders: 20,
      manualCompletedPositions: 5
    });
    expect(gate.netReturnPercent).toBe(22);
    expect(gate.maxDrawdownPercent).toBeCloseTo(11.6667, 3);
    expect(gate.paperPassed).toBe(false);
    expect(gate.blockers).toContain("paper maximum drawdown is above 10%");
  });

  it("fails closed when open exposure does not have a complete executable price", () => {
    const trades = passingTrades();
    const gate = calculatePromotionGate({
      now: NOW,
      ...promotionEvidence(trades),
      executablePricingComplete: false,
      trades,
      manualLiveOrders: 20,
      manualCompletedPositions: 5
    });
    expect(gate.paperPassed).toBe(false);
    expect(gate.blockers).toContain("open exposure is missing a current executable price");
  });
});
