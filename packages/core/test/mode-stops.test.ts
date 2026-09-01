import { describe, expect, it } from "vitest";
import type { ExecutionRecord, PromotionGate } from "@copylab/shared";
import {
  ModeStateMachine,
  ModeTransitionError,
  evaluateOperationalStops,
  transitionMode
} from "../src/index.js";
import { NOW, portfolio, providerHealth, quote } from "./fixtures.js";

function promotion(paperPassed: boolean, manualLivePassed: boolean): PromotionGate {
  return {
    evaluatedAt: NOW.toISOString(),
    elapsedDays: 30,
    completedExits: 50,
    netReturnPercent: 1,
    profitFactor: 1.2,
    maxDrawdownPercent: 5,
    positiveWeeks: 3,
    largestTradeProfitShare: 0.1,
    topThreeProfitShare: 0.3,
    stressNetReturnPercent: 0,
    stressMaxDrawdownPercent: 10,
    qualifyingWallets: 2,
    manualLiveOrders: 20,
    manualCompletedPositions: 5,
    paperShortfallP95Percent: 0.25,
    manualWorstShortfallPercent: 0.2,
    manualPolicyViolations: 0,
    paperPassed,
    manualLivePassed,
    blockers: []
  };
}

describe("mode state machine", () => {
  it("follows SETUP -> PAPER -> MANUAL_LIVE -> AUTO_LIVE with explicit gates", () => {
    const machine = new ModeStateMachine();
    expect(machine.dispatch({ type: "SETUP_COMPLETE" }, { promotion: promotion(false, false) }).mode).toBe("PAPER");
    expect(() => machine.dispatch(
      { type: "ENABLE_MANUAL_LIVE", confirmed: true },
      { promotion: promotion(false, false) }
    )).toThrow(ModeTransitionError);
    machine.dispatch({ type: "ENABLE_MANUAL_LIVE", confirmed: true }, { promotion: promotion(true, false) });
    expect(machine.state.mode).toBe("MANUAL_LIVE");
    expect(() => machine.dispatch(
      { type: "ENABLE_AUTO_LIVE", confirmed: false },
      { promotion: promotion(true, true) }
    )).toThrow("explicit confirmation");
    machine.dispatch({ type: "ENABLE_AUTO_LIVE", confirmed: true }, { promotion: promotion(true, true) });
    expect(machine.state.mode).toBe("AUTO_LIVE");
  });

  it("remembers a paused mode but rechecks its promotion gate on resume", () => {
    const paused = transitionMode(
      { mode: "AUTO_LIVE" },
      { type: "PAUSE" },
      { promotion: promotion(true, true) }
    );
    expect(paused).toEqual({ mode: "PAUSED", pausedFrom: "AUTO_LIVE" });
    expect(() => transitionMode(paused, { type: "RESUME" }, { promotion: promotion(true, false) })).toThrow(
      "manual-live promotion gate"
    );
    expect(transitionMode(paused, { type: "RESUME" }, { promotion: promotion(true, true) })).toEqual({
      mode: "AUTO_LIVE"
    });
  });

  it("requires acknowledged review before leaving LOCKED and only resets to PAPER", () => {
    const locked = transitionMode({ mode: "MANUAL_LIVE" }, { type: "LOCK" }, { promotion: promotion(true, false) });
    expect(locked.mode).toBe("LOCKED");
    expect(() => transitionMode(
      locked,
      { type: "RESET_TO_PAPER", reviewAcknowledged: false },
      { promotion: promotion(true, false) }
    )).toThrow("acknowledged review");
    expect(transitionMode(
      locked,
      { type: "RESET_TO_PAPER", reviewAcknowledged: true },
      { promotion: promotion(true, false) }
    ).mode).toBe("PAPER");
  });
});

function failedRecord(id: string, updatedAt: string): ExecutionRecord {
  return {
    id,
    idempotencyKey: `key-${id}`,
    intentId: `intent-${id}`,
    mode: "LIVE",
    status: "FAILED",
    createdAt: updatedAt,
    updatedAt,
    sourceSignature: `source-${id}`,
    quote: quote()
  };
}

describe("operational stops", () => {
  it("does nothing below every threshold", () => {
    const result = evaluateOperationalStops({
      now: NOW,
      portfolio: portfolio({ mode: "LIVE", navUsd: 47.51, dayStartNavUsd: 50, peakNavUsd: 52.77 }),
      liveStartNavUsd: 52.5,
      providerHealth: [providerHealth()],
      latestQuote: quote(),
      recentExecutions: []
    });
    expect(result).toMatchObject({ action: "NONE", reasons: [], pauseNewEntries: false });
  });

  it("pauses new entries at the exact 5% daily loss", () => {
    const result = evaluateOperationalStops({
      now: NOW,
      portfolio: portfolio({ navUsd: 47.5, dayStartNavUsd: 50 }),
      providerHealth: [providerHealth()],
      recentExecutions: []
    });
    expect(result).toMatchObject({ action: "PAUSE_NEW_ENTRIES", pauseNewEntries: true, lockLiveMode: false });
    expect(result.reasons).toContain("DAILY_LOSS");
  });

  it("locks and requests liquidation at either live hard-stop boundary", () => {
    const lossStop = evaluateOperationalStops({
      now: NOW,
      portfolio: portfolio({ mode: "LIVE", navUsd: 45, peakNavUsd: 50 }),
      liveStartNavUsd: 50,
      providerHealth: [providerHealth()],
      recentExecutions: []
    });
    expect(lossStop).toMatchObject({
      action: "LOCK_AND_LIQUIDATE",
      cancelQueuedEntries: true,
      liquidateBotPositions: true,
      lockLiveMode: true
    });
    expect(lossStop.reasons).toEqual(expect.arrayContaining(["LIVE_START_LOSS", "PEAK_DRAWDOWN"]));
  });

  it("does not hard-stop at the obsolete fixed $5 boundary for a $141 live start", () => {
    const result = evaluateOperationalStops({
      now: NOW,
      portfolio: portfolio({ mode: "LIVE", navUsd: 136, dayStartNavUsd: 141, peakNavUsd: 141 }),
      liveStartNavUsd: 141,
      providerHealth: [providerHealth()],
      recentExecutions: []
    });
    expect(result).toMatchObject({
      action: "NONE",
      lockLiveMode: false,
      liveStartLossUsd: 5
    });
    expect(result.liveStartLossLimitUsd).toBeCloseTo(14.1);
    expect(result.reasons).not.toContain("LIVE_START_LOSS");
    expect(result.reasons).not.toContain("PEAK_DRAWDOWN");
  });

  it("hard-stops at 10% of the $141 live-start NAV", () => {
    const result = evaluateOperationalStops({
      now: NOW,
      portfolio: portfolio({ mode: "LIVE", navUsd: 126.9, dayStartNavUsd: 141, peakNavUsd: 141 }),
      liveStartNavUsd: 141,
      providerHealth: [providerHealth()],
      recentExecutions: []
    });
    expect(result).toMatchObject({
      action: "LOCK_AND_LIQUIDATE",
      lockLiveMode: true
    });
    expect(result.liveStartLossUsd).toBeCloseTo(14.1);
    expect(result.liveStartLossLimitUsd).toBeCloseTo(14.1);
    expect(result.reasons).toEqual(expect.arrayContaining(["LIVE_START_LOSS", "PEAK_DRAWDOWN"]));
  });

  it("pauses for a >60s Helius outage, stale quote, >1% mismatch, or 3 failures in 10 minutes", () => {
    const result = evaluateOperationalStops({
      now: NOW,
      portfolio: portfolio({ balanceMismatchPercent: 1.01 }),
      providerHealth: [providerHealth({ ok: false, checkedAt: "2026-02-15T11:58:58.000Z" })],
      heliusUnhealthySince: "2026-02-15T11:58:58.000Z",
      latestQuote: quote({ quotedAt: "2026-02-15T11:59:54.000Z" }),
      recentExecutions: [
        failedRecord("1", "2026-02-15T11:51:00.000Z"),
        failedRecord("2", "2026-02-15T11:55:00.000Z"),
        failedRecord("3", "2026-02-15T11:59:00.000Z")
      ]
    });
    expect(result.action).toBe("PAUSE_NEW_ENTRIES");
    expect(result.reasons).toEqual(expect.arrayContaining([
      "HELIUS_OUTAGE",
      "STALE_QUOTE",
      "BALANCE_MISMATCH",
      "REPEATED_EXECUTION_FAILURES"
    ]));
  });

  it("does not pause at exactly 60 seconds of provider outage", () => {
    const result = evaluateOperationalStops({
      now: NOW,
      portfolio: portfolio(),
      providerHealth: [providerHealth({ ok: false, checkedAt: "2026-02-15T11:59:00.000Z" })],
      recentExecutions: []
    });
    expect(result.reasons).not.toContain("HELIUS_OUTAGE");
  });
});
