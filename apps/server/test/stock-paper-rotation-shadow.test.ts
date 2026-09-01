import { describe, expect, it } from "vitest";
import type { AlpacaStockBar } from "@copylab/providers";
import {
  STOCK_PAPER_ROTATION_SHADOW_VERSION,
  type StockPaperCandidate,
  type StockPaperPosition,
  type StockPaperRotationPolicy
} from "@copylab/shared";
import {
  DEFAULT_STOCK_PAPER_POLICY,
  modeledBuyFill,
  modeledSellFill
} from "../src/stock-paper-policy.js";
import {
  DEFAULT_STOCK_PAPER_ROTATION_POLICY,
  calculateStockPaperRotationOutcome,
  evaluateStockPaperRotationDecision,
  summarizeStockPaperRotationShadow
} from "../src/stock-paper-rotation-shadow.js";

const DECISION_AT = "2026-07-17T14:40:12.000Z";

function candidate(
  symbol: string,
  score: number,
  capturedAt = DECISION_AT,
  input: Partial<StockPaperCandidate> = {}
): StockPaperCandidate {
  return {
    symbol,
    priceUsd: 100,
    bidUsd: 99.95,
    askUsd: 100.05,
    spreadPercent: 0.1,
    change1mPercent: 0.5,
    change5mPercent: 1.5,
    change15mPercent: 3,
    changeFromOpenPercent: 3,
    dailyChangePercent: 3,
    relativeVolume: 2,
    dollarVolumeUsd: 20_000_000,
    vwapDistancePercent: 1,
    score,
    arm: "BREAKOUT",
    highConviction: true,
    eligible: true,
    reasons: [],
    marketPhase: "REGULAR",
    marketFeed: "IEX",
    capturedAt,
    ...input
  };
}

function position(
  symbol: string,
  input: Partial<StockPaperPosition> = {}
): StockPaperPosition {
  return {
    id: `stock-position:${symbol}`,
    laneId: "stock-paper:test-rotation",
    symbol,
    arm: "BREAKOUT",
    status: "OPEN",
    quantity: 0.63,
    entryPriceUsd: 100,
    entryNotionalUsd: 63,
    remainingCostUsd: 63,
    lastBidUsd: 99.95,
    lastAskUsd: 100.05,
    lastMarkUsd: 100,
    lastValueUsd: 63,
    lastExecutableValueUsd: 62.9,
    peakPriceUsd: 101,
    stopPriceUsd: 92,
    takeProfitPriceUsd: 112,
    scoreAtEntry: 80,
    openedAt: "2026-07-17T14:10:12.000Z",
    updatedAt: DECISION_AT,
    ...input
  };
}

function rotationPolicy(
  input: Partial<StockPaperRotationPolicy> = {}
): StockPaperRotationPolicy {
  return {
    ...DEFAULT_STOCK_PAPER_ROTATION_POLICY,
    maximumSwitchCostPercent: 100,
    ...input
  };
}

function decisionInput(input: Partial<Parameters<typeof evaluateStockPaperRotationDecision>[0]> = {}) {
  return {
    laneId: "stock-paper:test-rotation",
    account: { navUsd: 141, cashUsd: 14, deployedUsd: 127 },
    positions: [position("WEAK"), position("HELD", {
      id: "stock-position:HELD",
      quantity: 0.64,
      remainingCostUsd: 64
    })],
    candidates: [
      candidate("WEAK", 65),
      candidate("HELD", 76),
      candidate("BEST", 90, DECISION_AT, { relativeVolume: 3 }),
      candidate("SECOND", 90, DECISION_AT, { relativeVolume: 2.5 })
    ],
    sourcePolicy: { ...DEFAULT_STOCK_PAPER_POLICY },
    rotationPolicy: rotationPolicy(),
    phase: "REGULAR" as const,
    feed: "IEX" as const,
    decisionAt: DECISION_AT,
    ...input
  };
}

function bar(timestamp: string, close: number, input: Partial<AlpacaStockBar> = {}): AlpacaStockBar {
  return {
    timestamp,
    open: close - 0.05,
    high: close + 0.1,
    low: close - 0.1,
    close,
    volume: 2_000,
    tradeCount: 100,
    vwap: close,
    ...input
  };
}

function futurePath(
  decisionAt: string,
  minutes: number,
  startPrice: number,
  increment: number
): AlpacaStockBar[] {
  const decisionMs = Date.parse(decisionAt);
  const firstMinute = Math.floor(decisionMs / 60_000) * 60_000 + 60_000;
  return Array.from({ length: minutes }, (_, index) =>
    bar(
      new Date(firstMinute + index * 60_000).toISOString(),
      startPrice + increment * (index + 1)
    )
  );
}

describe("stock PAPER rotation shadow", () => {
  it("selects the weakest open symbol and strongest replacement deterministically without mutating inputs", () => {
    const input = decisionInput();
    const before = structuredClone(input);
    const first = evaluateStockPaperRotationDecision(input);
    const reversed = evaluateStockPaperRotationDecision({
      ...input,
      positions: [...input.positions].reverse(),
      candidates: [...input.candidates].reverse()
    });

    expect(first).toEqual(reversed);
    expect(first).toMatchObject({
      version: STOCK_PAPER_ROTATION_SHADOW_VERSION,
      status: "ROTATE",
      reasonCodes: [],
      analysisOnly: true,
      affectsTrading: false,
      promotionEligible: false,
      portfolioCounterfactual: false,
      resultsAreIndependentOneStepCounterfactuals: true,
      idempotencyBucket: "2026-07-17T14:30:00.000Z",
      outgoing: { symbol: "WEAK", currentScore: 65 },
      incoming: { symbol: "BEST", currentScore: 90 }
    });
    expect(first.sourcePolicyDigest).toMatch(/^stock-policy-v3:[a-f0-9]{64}$/u);
    expect(first.policyDigest).toMatch(/^stock-rotation-policy-v1:[a-f0-9]{64}$/u);
    expect(Object.isFrozen(first)).toBe(true);
    expect(input).toEqual(before);
    expect(first).not.toHaveProperty("order");
    expect(first).not.toHaveProperty("position");

    const laterAt = "2026-07-17T14:44:59.000Z";
    const later = evaluateStockPaperRotationDecision(decisionInput({
      decisionAt: laterAt,
      candidates: input.candidates.map((item) => ({ ...item, capturedAt: laterAt }))
    }));
    expect(later.idempotencyBucket).toBe(first.idempotencyBucket);
    expect(later.idempotencyKey).toBe(first.idempotencyKey);
    expect(later.id).toBe(first.id);
  });

  it("fails closed on mismatched clocks and honors exact age, cooldown, and score boundaries", () => {
    const staleOutgoing = evaluateStockPaperRotationDecision(decisionInput({
      candidates: [
        candidate("WEAK", 65, "2026-07-17T14:40:11.999Z"),
        candidate("BEST", 90)
      ],
      positions: [position("WEAK")]
    }));
    expect(staleOutgoing).toMatchObject({
      status: "HOLD",
      reasonCodes: ["NO_CURRENT_ELIGIBLE_OPEN_POSITION"]
    });

    const exactAge = evaluateStockPaperRotationDecision(decisionInput({
      positions: [position("WEAK", { openedAt: "2026-07-17T14:25:12.000Z" })],
      candidates: [candidate("WEAK", 65), candidate("BEST", 73)],
      rotationPolicy: rotationPolicy({ minimumPositionAgeMinutes: 15, minimumScoreDelta: 8 })
    }));
    expect(exactAge.status).toBe("ROTATE");

    const tooYoung = evaluateStockPaperRotationDecision(decisionInput({
      positions: [position("WEAK", { openedAt: "2026-07-17T14:25:12.001Z" })],
      candidates: [candidate("WEAK", 65), candidate("BEST", 73)],
      rotationPolicy: rotationPolicy({ minimumPositionAgeMinutes: 15, minimumScoreDelta: 8 })
    }));
    expect(tooYoung.reasonCodes).toEqual(["POSITION_TOO_YOUNG"]);

    const scoreBelow = evaluateStockPaperRotationDecision(decisionInput({
      positions: [position("WEAK")],
      candidates: [candidate("WEAK", 65), candidate("BEST", 72.999)],
      rotationPolicy: rotationPolicy({ minimumScoreDelta: 8 })
    }));
    expect(scoreBelow.reasonCodes).toEqual(["SCORE_DELTA_BELOW_MINIMUM"]);

    const cooldownActive = evaluateStockPaperRotationDecision(decisionInput({
      lastRotationAt: "2026-07-17T14:10:12.001Z"
    }));
    expect(cooldownActive.reasonCodes).toEqual(["ROTATION_COOLDOWN_ACTIVE"]);
    expect(evaluateStockPaperRotationDecision(decisionInput({
      lastRotationAt: "2026-07-17T14:10:12.000Z"
    })).status).toBe("ROTATE");

    const symbolCooldown = evaluateStockPaperRotationDecision(decisionInput({
      cooldownUntilBySymbol: { BEST: "2026-07-17T14:40:12.001Z" }
    }));
    expect(symbolCooldown.reasonCodes).toEqual(["SYMBOL_COOLDOWN_ACTIVE"]);
    expect(evaluateStockPaperRotationDecision(decisionInput({
      cooldownUntilBySymbol: { BEST: DECISION_AT }
    })).status).toBe("ROTATE");
  });

  it("can rotate away from a now-ineligible holding when its current quote and score are causal", () => {
    const result = evaluateStockPaperRotationDecision(decisionInput({
      positions: [position("WEAK")],
      candidates: [
        candidate("WEAK", 40, DECISION_AT, {
          eligible: false,
          reasons: ["Short-term momentum is not positive."]
        }),
        candidate("BEST", 80)
      ]
    }));

    expect(result).toMatchObject({
      status: "ROTATE",
      outgoing: { symbol: "WEAK", currentScore: 40 },
      incoming: { symbol: "BEST", currentScore: 80 },
      scoreDelta: 40
    });
  });

  it("sizes from the hypothetical post-sale account and includes both switching legs", () => {
    const input = decisionInput({
      positions: [position("WEAK")],
      candidates: [candidate("WEAK", 65), candidate("BEST", 90)]
    });
    const before = structuredClone(input);
    const result = evaluateStockPaperRotationDecision(input);

    expect(result.status).toBe("ROTATE");
    expect(result.hypotheticalPostSaleCashUsd).toBeGreaterThan(result.preRotationCashUsd);
    expect(result.hypotheticalPostSaleDeployedUsd).toBeLessThan(result.preRotationDeployedUsd);
    expect(result.incoming!.entryNotionalUsd).toBeGreaterThan(1);
    expect(result.hypotheticalPostEntryCashUsd)
      .toBeGreaterThanOrEqual(DEFAULT_STOCK_PAPER_POLICY.minimumCashReserveUsd);

    const expectedSell = modeledSellFill(
      result.outgoing!.bidUsd,
      result.outgoing!.spreadPercent
    );
    const expectedBuy = modeledBuyFill(
      result.incoming!.askUsd,
      result.incoming!.spreadPercent
    );
    expect(result.outgoing!.modeledSellPriceUsd).toBeCloseTo(expectedSell, 10);
    expect(result.incoming!.modeledBuyPriceUsd).toBeCloseTo(expectedBuy, 10);
    expect(result.modeledSwitchCostsUsd).toBeCloseTo(
      result.outgoing!.modeledExitCostUsd + result.incoming!.modeledEntryCostUsd,
      10
    );
    expect(result.hypotheticalPostEntryNavUsd).toBeLessThan(result.hypotheticalPostSaleNavUsd!);
    expect(input).toEqual(before);

    const costBlocked = evaluateStockPaperRotationDecision({
      ...input,
      rotationPolicy: rotationPolicy({ maximumSwitchCostPercent: 0 })
    });
    expect(costBlocked).toMatchObject({
      status: "HOLD",
      reasonCodes: ["SWITCH_COST_ABOVE_MAXIMUM"]
    });
    expect(costBlocked.modeledSwitchCostsUsd).toBeGreaterThan(0);
  });

  it("labels all supported horizons from strictly future complete two-symbol paths after costs", () => {
    const decision = evaluateStockPaperRotationDecision(decisionInput({
      positions: [position("WEAK")],
      candidates: [candidate("WEAK", 65), candidate("BEST", 90)]
    }));
    expect(decision.status).toBe("ROTATE");

    for (const horizonMinutes of [15, 45, 180] as const) {
      const dueMs = Date.parse(DECISION_AT) + horizonMinutes * 60_000;
      const outgoing = futurePath(DECISION_AT, horizonMinutes, 100, -0.01);
      const incoming = futurePath(DECISION_AT, horizonMinutes, 100, 0.04);
      const sameMinute = bar("2026-07-17T14:40:00.000Z", 10_000);
      const afterHorizon = bar(
        new Date(Math.floor(dueMs / 60_000) * 60_000 + 60_000).toISOString(),
        20_000
      );
      const outcome = calculateStockPaperRotationOutcome({
        decision,
        horizonMinutes,
        outgoingBars: [sameMinute, ...outgoing, afterHorizon],
        incomingBars: [sameMinute, ...incoming, afterHorizon],
        labeledAt: new Date(dueMs).toISOString()
      });

      const outgoingClose = outgoing.at(-1)!.close;
      const incomingClose = incoming.at(-1)!.close;
      const expectedBaselineExit = modeledSellFill(
        outgoingClose,
        decision.outgoing!.spreadPercent
      );
      const expectedIncomingExit = modeledSellFill(
        incomingClose,
        decision.incoming!.spreadPercent
      );
      const expectedBaselinePnl =
        decision.outgoing!.quantity * expectedBaselineExit - decision.outgoing!.remainingCostUsd;
      const expectedRotatedPnl =
        decision.outgoing!.executableProceedsUsd - decision.outgoing!.remainingCostUsd +
        decision.incoming!.quantity * expectedIncomingExit - decision.incoming!.entryNotionalUsd;

      expect(outcome).toMatchObject({
        status: "LABELED",
        horizonMinutes,
        analysisOnly: true,
        affectsTrading: false,
        promotionEligible: false,
        portfolioCounterfactual: false,
        outgoingFirstBarAt: outgoing[0]!.timestamp,
        outgoingLastBarAt: outgoing.at(-1)!.timestamp,
        incomingFirstBarAt: incoming[0]!.timestamp,
        incomingLastBarAt: incoming.at(-1)!.timestamp
      });
      expect(outcome.baselineHoldPnlUsd).toBeCloseTo(expectedBaselinePnl, 8);
      expect(outcome.rotatedPnlUsd).toBeCloseTo(expectedRotatedPnl, 8);
      expect(outcome.incrementalPnlUsd).toBeCloseTo(expectedRotatedPnl - expectedBaselinePnl, 8);
      expect(outcome.incrementalPnlUsd).toBeGreaterThan(0);
      expect(outcome.totalRotationModeledCostsUsd).toBeGreaterThan(
        decision.modeledSwitchCostsUsd!
      );
      expect(Object.isFrozen(outcome)).toBe(true);
    }
  });

  it("records explicit not-due, absent, gapped, conflicting, invalid, and non-rotation missingness", () => {
    const decision = evaluateStockPaperRotationDecision(decisionInput({
      positions: [position("WEAK")],
      candidates: [candidate("WEAK", 65), candidate("BEST", 90)]
    }));
    const complete = futurePath(DECISION_AT, 15, 100, 0.01);
    const dueAt = "2026-07-17T14:55:12.000Z";

    expect(calculateStockPaperRotationOutcome({
      decision,
      horizonMinutes: 15,
      outgoingBars: complete,
      incomingBars: complete,
      labeledAt: "2026-07-17T14:55:11.999Z"
    }).missingReason).toBe("HORIZON_NOT_DUE");
    expect(calculateStockPaperRotationOutcome({
      decision,
      horizonMinutes: 15,
      outgoingBars: [],
      incomingBars: complete,
      labeledAt: dueAt
    }).missingReason).toBe("OUTGOING_NO_STRICTLY_FUTURE_BARS");
    expect(calculateStockPaperRotationOutcome({
      decision,
      horizonMinutes: 15,
      outgoingBars: complete,
      incomingBars: complete.filter((_, index) => index !== 4),
      labeledAt: dueAt
    }).missingReason).toBe("INCOMING_PATH_GAP");
    expect(calculateStockPaperRotationOutcome({
      decision,
      horizonMinutes: 15,
      outgoingBars: [
        ...complete,
        { ...complete[0]!, close: complete[0]!.close + 1, high: complete[0]!.high + 1 }
      ],
      incomingBars: complete,
      labeledAt: dueAt
    }).missingReason).toBe("OUTGOING_CONFLICTING_BAR");
    expect(calculateStockPaperRotationOutcome({
      decision,
      horizonMinutes: 15,
      outgoingBars: complete.map((item, index) => index === 3 ? { ...item, low: -1 } : item),
      incomingBars: complete,
      labeledAt: dueAt
    }).missingReason).toBe("OUTGOING_INVALID_BAR");

    const held = evaluateStockPaperRotationDecision(decisionInput({
      positions: [],
      candidates: [candidate("BEST", 90)]
    }));
    expect(calculateStockPaperRotationOutcome({
      decision: held,
      horizonMinutes: 15,
      outgoingBars: complete,
      incomingBars: complete,
      labeledAt: dueAt
    })).toMatchObject({
      status: "MISSING",
      missingReason: "DECISION_DID_NOT_ROTATE"
    });
  });

  it("summarizes independent one-step evidence without inventing compounded NAV", () => {
    const decision = evaluateStockPaperRotationDecision(decisionInput({
      positions: [position("WEAK")],
      candidates: [candidate("WEAK", 65), candidate("BEST", 90)]
    }));
    const completeOutgoing = futurePath(DECISION_AT, 15, 100, -0.01);
    const completeIncoming = futurePath(DECISION_AT, 15, 100, 0.04);
    const outcome = calculateStockPaperRotationOutcome({
      decision,
      horizonMinutes: 15,
      outgoingBars: completeOutgoing,
      incomingBars: completeIncoming,
      labeledAt: "2026-07-17T14:55:12.000Z"
    });
    const summary = summarizeStockPaperRotationShadow({
      decisions: [decision],
      outcomes: [outcome],
      updatedAt: "2026-07-17T14:56:00.000Z"
    });

    expect(summary).toMatchObject({
      analysisOnly: true,
      affectsTrading: false,
      promotionEligible: false,
      portfolioCounterfactual: false,
      resultsAreIndependentOneStepCounterfactuals: true,
      compoundedPortfolioNavAvailable: false,
      evaluatedDecisions: 1,
      proposedRotations: 1,
      heldDecisions: 0,
      labeledOutcomes: 1,
      missingOutcomes: 0,
      incrementalWins: 1
    });
    expect(summary).not.toHaveProperty("navUsd");
    expect(Object.isFrozen(summary)).toBe(true);
  });
});
