import { describe, expect, it } from "vitest";
import {
  evaluateStockPaperReadiness,
  rollingProviderBudget,
  type StockPaperReadinessInput
} from "../src/stock-paper-readiness.js";

const READY_NOW = "2026-07-17T00:20:00.000Z"; // 8:20 PM ET

function readyInput(overrides: Partial<StockPaperReadinessInput> = {}): StockPaperReadinessInput {
  return {
    now: READY_NOW,
    phase: "OVERNIGHT",
    clock: {
      timestamp: READY_NOW,
      isOpen: false,
      nextOpen: "2026-07-17T13:30:00.000Z",
      nextClose: "2026-07-17T20:00:00.000Z"
    },
    quoteAgeMs: 20_000,
    minuteBarAgeMs: 60_000,
    requestedSnapshots: 100,
    returnedSnapshots: 100,
    freshSnapshots: 25,
    openPositions: 2,
    pricedOpenPositions: 2,
    overnightEligibleAssets: 500,
    fractionalExtendedHoursAssets: 300,
    overnightHaltedAssets: 0,
    providerCalls: [{ at: "2026-07-17T00:19:40.000Z", requests: 8 }],
    providerRequestsToReserve: 10,
    ...overrides
  };
}

describe("rolling Alpaca provider budget", () => {
  it("reserves against a strict 200-request rolling minute and reports retry time", () => {
    const available = rollingProviderBudget({
      now: "2026-07-17T00:20:00.000Z",
      calls: [{ at: "2026-07-17T00:19:30.000Z", requests: 198 }],
      reserveRequests: 2
    });
    expect(available).toMatchObject({
      limit: 200,
      used: 198,
      remaining: 2,
      canReserve: true,
      retryAfterMs: 0,
      pressure: "HIGH"
    });

    const exhausted = rollingProviderBudget({
      now: "2026-07-17T00:20:00.000Z",
      calls: [{ at: "2026-07-17T00:19:30.000Z", requests: 198 }],
      reserveRequests: 3
    });
    expect(exhausted).toMatchObject({
      used: 198,
      remaining: 2,
      canReserve: false,
      retryAfterMs: 30_000,
      pressure: "EXHAUSTED"
    });
  });

  it("expires calls exactly on the left edge and rejects future evidence", () => {
    const budget = rollingProviderBudget({
      now: "2026-07-17T00:20:00.000Z",
      calls: [
        { at: "2026-07-17T00:19:00.000Z", requests: 190 },
        { at: "2026-07-17T00:19:00.001Z", requests: 5 }
      ],
      reserveRequests: 10
    });
    expect(budget.used).toBe(5);
    expect(budget.canReserve).toBe(true);
    expect(() => rollingProviderBudget({
      now: "2026-07-17T00:20:00.000Z",
      calls: [{ at: "2026-07-17T00:20:00.001Z" }]
    })).toThrow(/future/iu);
  });
});

describe("overnight stock-paper readiness", () => {
  it("returns READY only after the entry delay with fresh, covered, priced evidence", () => {
    const readiness = evaluateStockPaperReadiness(readyInput());
    expect(readiness.status).toBe("READY");
    expect(readiness.reasons).toEqual([]);
    expect(readiness.metrics).toMatchObject({
      returnedCoveragePercent: 100,
      freshCoveragePercent: 25,
      openPositionPricingCoveragePercent: 100
    });
  });

  it("reports phase-specific PAPER entry warmups and cutoffs", () => {
    const premarketNow = "2026-07-17T08:10:00.000Z"; // 4:10 AM ET
    const premarket = evaluateStockPaperReadiness(readyInput({
      now: premarketNow,
      phase: "PREMARKET",
      clock: {
        timestamp: premarketNow,
        isOpen: false,
        nextOpen: "2026-07-17T13:30:00.000Z",
        nextClose: "2026-07-17T20:00:00.000Z"
      },
      providerCalls: []
    }));
    expect(premarket.status).toBe("WARMING");
    expect(premarket.countdownSeconds).toBe(5 * 60);
    expect(premarket.reasons).toContainEqual(expect.objectContaining({
      code: "SESSION_ENTRY_DELAY",
      message: expect.stringContaining("premarket")
    }));

    const regularNow = "2026-07-17T13:32:00.000Z"; // 9:32 AM ET
    const regular = evaluateStockPaperReadiness(readyInput({
      now: regularNow,
      phase: "REGULAR",
      clock: {
        timestamp: regularNow,
        isOpen: true,
        nextOpen: "2026-07-20T13:30:00.000Z",
        nextClose: "2026-07-17T20:00:00.000Z"
      },
      providerCalls: []
    }));
    expect(regular.status).toBe("WARMING");
    expect(regular.countdownSeconds).toBe(3 * 60);
    expect(regular.reasons).toContainEqual(expect.objectContaining({
      code: "SESSION_ENTRY_DELAY",
      message: expect.stringContaining("regular-session")
    }));
    expect(regular.reasons.some((reason) => reason.code === "CALENDAR_DISCONTINUITY")).toBe(false);

    const afterHoursNow = "2026-07-16T20:02:00.000Z"; // Thursday 4:02 PM ET
    const afterHours = evaluateStockPaperReadiness(readyInput({
      now: afterHoursNow,
      phase: "AFTER_HOURS",
      clock: {
        timestamp: afterHoursNow,
        isOpen: false,
        nextOpen: "2026-07-17T13:30:00.000Z",
        nextClose: "2026-07-17T20:00:00.000Z"
      },
      providerCalls: []
    }));
    expect(afterHours.status).toBe("WARMING");
    expect(afterHours.countdownSeconds).toBe(3 * 60);
    expect(afterHours.reasons).toContainEqual(expect.objectContaining({
      code: "SESSION_ENTRY_DELAY",
      message: expect.stringContaining("after-hours")
    }));

    const overnightNow = "2026-07-17T00:10:00.000Z"; // 8:10 PM ET
    const overnight = evaluateStockPaperReadiness(readyInput({
      now: overnightNow,
      clock: { ...readyInput().clock, timestamp: overnightNow },
      providerCalls: []
    }));
    expect(overnight.status).toBe("WARMING");
    expect(overnight.countdownSeconds).toBe(5 * 60);
    expect(overnight.reasons).toContainEqual(expect.objectContaining({
      code: "OVERNIGHT_ENTRY_DELAY",
      message: expect.stringContaining("overnight")
    }));

    const afterHoursCutoffNow = "2026-07-16T23:50:00.000Z"; // Thursday 7:50 PM ET
    const afterHoursCutoff = evaluateStockPaperReadiness(readyInput({
      now: afterHoursCutoffNow,
      phase: "AFTER_HOURS",
      clock: {
        timestamp: afterHoursCutoffNow,
        isOpen: false,
        nextOpen: "2026-07-17T13:30:00.000Z",
        nextClose: "2026-07-17T20:00:00.000Z"
      },
      providerCalls: []
    }));
    expect(afterHoursCutoff.status).toBe("BLOCKED");
    expect(afterHoursCutoff.reasons).toContainEqual(expect.objectContaining({
      code: "SESSION_ENTRY_WINDOW_CLOSED",
      message: expect.stringContaining("7:45 PM ET")
    }));
  });

  it("keeps an ordinary Friday regular session READY even when the next open is Monday", () => {
    const now = "2026-07-17T14:00:00.000Z"; // Friday 10:00 AM ET
    const readiness = evaluateStockPaperReadiness(readyInput({
      now,
      phase: "REGULAR",
      clock: {
        timestamp: now,
        isOpen: true,
        nextOpen: "2026-07-20T13:30:00.000Z",
        nextClose: "2026-07-17T20:00:00.000Z"
      },
      overnightEligibleAssets: 0,
      fractionalExtendedHoursAssets: 0,
      providerCalls: []
    }));

    expect(readiness.status).toBe("READY");
    expect(readiness.reasons).toEqual([]);
    expect(readiness.reasons.some((reason) =>
      reason.code === "CALENDAR_DISCONTINUITY" || reason.code === "OVERNIGHT_SESSION_PENDING"
    )).toBe(false);
  });

  it("uses phase-correct IEX wording and adds advisory stale-feed warnings only after grace", () => {
    const stale = {
      quoteAgeMs: 10 * 60_000,
      minuteBarAgeMs: 10 * 60_000,
      freshSnapshots: 0,
      providerCalls: []
    } as const;
    const beforeGraceNow = "2026-07-17T12:04:00.000Z"; // 8:04 AM ET
    const beforeGrace = evaluateStockPaperReadiness(readyInput({
      ...stale,
      now: beforeGraceNow,
      phase: "PREMARKET",
      clock: {
        timestamp: beforeGraceNow,
        isOpen: false,
        nextOpen: "2026-07-17T13:30:00.000Z",
        nextClose: "2026-07-17T20:00:00.000Z"
      }
    }));
    expect(beforeGrace.status).toBe("WARMING");
    expect(beforeGrace.reasons.filter((reason) => [
      "QUOTE_STALE", "MINUTE_BAR_STALE", "FRESH_SNAPSHOT_PENDING"
    ].includes(reason.code)).every((reason) => /premarket IEX/iu.test(reason.message))).toBe(true);
    expect(beforeGrace.reasons.some((reason) =>
      reason.code === "IEX_EVIDENCE_STALE_AFTER_GRACE"
    )).toBe(false);

    const afterGraceNow = "2026-07-17T12:05:00.000Z"; // 8:05 AM ET
    const afterGrace = evaluateStockPaperReadiness(readyInput({
      ...stale,
      now: afterGraceNow,
      phase: "PREMARKET",
      clock: {
        timestamp: afterGraceNow,
        isOpen: false,
        nextOpen: "2026-07-17T13:30:00.000Z",
        nextClose: "2026-07-17T20:00:00.000Z"
      }
    }));
    expect(afterGrace.reasons).toContainEqual(expect.objectContaining({
      code: "IEX_EVIDENCE_STALE_AFTER_GRACE",
      disposition: "ADVISORY",
      message: expect.stringMatching(/premarket IEX.*8:05 AM ET.*does not change PAPER trading policy/iu)
    }));

    const regularNow = "2026-07-17T13:35:00.000Z"; // 9:35 AM ET
    const regular = evaluateStockPaperReadiness(readyInput({
      ...stale,
      now: regularNow,
      phase: "REGULAR",
      clock: {
        timestamp: regularNow,
        isOpen: true,
        nextOpen: "2026-07-20T13:30:00.000Z",
        nextClose: "2026-07-17T20:00:00.000Z"
      }
    }));
    expect(regular.reasons).toContainEqual(expect.objectContaining({
      code: "IEX_EVIDENCE_STALE_AFTER_GRACE",
      disposition: "ADVISORY",
      message: expect.stringMatching(/regular-session IEX.*9:35 AM ET/iu)
    }));
    expect(regular.reasons.some((reason) => /overnight/iu.test(reason.message))).toBe(false);
  });

  it("names the pre-08:00 Alpaca Basic coverage gap without treating delayed SIP as executable", () => {
    const now = "2026-07-17T11:15:00.000Z"; // 7:15 AM ET
    const readiness = evaluateStockPaperReadiness(readyInput({
      now,
      phase: "PREMARKET",
      clock: {
        timestamp: now,
        isOpen: false,
        nextOpen: "2026-07-17T13:30:00.000Z",
        nextClose: "2026-07-17T20:00:00.000Z"
      },
      quoteAgeMs: 12 * 60 * 60_000,
      minuteBarAgeMs: 12 * 60 * 60_000,
      freshSnapshots: 0,
      openPositions: 2,
      pricedOpenPositions: 0,
      providerCalls: []
    }));

    expect(readiness.status).toBe("BLOCKED");
    expect(readiness.countdownSeconds).toBe(45 * 60);
    expect(readiness.reasons).toContainEqual(expect.objectContaining({
      code: "IEX_PREMARKET_COVERAGE_PENDING",
      disposition: "WAITING",
      message: expect.stringMatching(/8:00 AM ET.*Delayed SIP.*cannot price or fill/iu)
    }));
    expect(readiness.reasons).toContainEqual(expect.objectContaining({
      code: "OPEN_POSITION_PRICING_INCOMPLETE",
      disposition: "BLOCKING"
    }));
    expect(readiness.metrics.openPositionPricingCoveragePercent).toBe(0);
  });

  it("blocks CLOSED and UNKNOWN phases with explicit phase diagnostics", () => {
    for (const phase of ["CLOSED", "UNKNOWN"] as const) {
      const readiness = evaluateStockPaperReadiness(readyInput({
        phase,
        clock: { ...readyInput().clock, isOpen: false }
      }));
      expect(readiness.status).toBe("BLOCKED");
      expect(readiness.reasons).toContainEqual(expect.objectContaining({
        code: "MARKET_SESSION_INACTIVE",
        disposition: "BLOCKING"
      }));
    }
  });

  it("keeps transient stale feed evidence in WARMING instead of claiming readiness", () => {
    const readiness = evaluateStockPaperReadiness(readyInput({
      quoteAgeMs: 3 * 60_000,
      minuteBarAgeMs: 5 * 60_000,
      freshSnapshots: 0
    }));
    expect(readiness.status).toBe("WARMING");
    expect(readiness.reasons.map((reason) => reason.code)).toEqual(expect.arrayContaining([
      "QUOTE_STALE",
      "MINUTE_BAR_STALE",
      "FRESH_SNAPSHOT_PENDING"
    ]));
  });

  it("accepts an explicit causal window for the delayed derived overnight feed", () => {
    const defaultWindow = evaluateStockPaperReadiness(readyInput({
      minuteBarAgeMs: 16 * 60_000
    }));
    expect(defaultWindow.status).toBe("WARMING");
    expect(defaultWindow.reasons).toContainEqual(expect.objectContaining({ code: "MINUTE_BAR_STALE" }));
    expect(defaultWindow.metrics.maximumMinuteBarAgeMs).toBe(4 * 60_000);

    const delayedWindow = evaluateStockPaperReadiness(readyInput({
      minuteBarAgeMs: 16 * 60_000,
      maximumMinuteBarAgeMs: 20 * 60_000
    }));
    expect(delayedWindow.status).toBe("READY");
    expect(delayedWindow.reasons).toEqual([]);
    expect(delayedWindow.metrics.maximumMinuteBarAgeMs).toBe(20 * 60_000);
  });

  it("fails closed when a caller supplies an unsafe bar-age window", () => {
    const readiness = evaluateStockPaperReadiness(readyInput({
      maximumMinuteBarAgeMs: 31 * 60_000
    }));
    expect(readiness.status).toBe("BLOCKED");
    expect(readiness.reasons).toContainEqual(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(readiness.metrics.maximumMinuteBarAgeMs).toBe(4 * 60_000);
  });

  it("blocks required endpoint failure, incomplete position pricing, and exhausted budget", () => {
    const readiness = evaluateStockPaperReadiness(readyInput({
      openPositions: 2,
      pricedOpenPositions: 1,
      endpointFailures: [{ endpoint: "snapshots", required: true, message: "Snapshot preflight failed." }],
      providerCalls: [{ at: "2026-07-17T00:19:30.000Z", requests: 198 }],
      providerRequestsToReserve: 3
    }));
    expect(readiness.status).toBe("BLOCKED");
    expect(readiness.countdownSeconds).toBe(30);
    expect(readiness.reasons.map((reason) => reason.code)).toEqual(expect.arrayContaining([
      "OPEN_POSITION_PRICING_INCOMPLETE",
      "REQUIRED_ENDPOINT_FAILED",
      "PROVIDER_RATE_LIMIT"
    ]));
  });

  it("treats optional online discovery failure and halted assets as advisory", () => {
    const readiness = evaluateStockPaperReadiness(readyInput({
      overnightHaltedAssets: 4,
      endpointFailures: [{ endpoint: "news", required: false }]
    }));
    expect(readiness.status).toBe("READY");
    expect(readiness.reasons).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "OVERNIGHT_HALTS_PRESENT", disposition: "ADVISORY" }),
      expect.objectContaining({ code: "OPTIONAL_ENDPOINT_FAILED", disposition: "ADVISORY" })
    ]));
  });

  it("blocks the Friday after-hours discontinuity and a contradictory open clock", () => {
    const now = "2026-07-17T23:55:00.000Z"; // Friday 7:55 PM ET
    const readiness = evaluateStockPaperReadiness(readyInput({
      now,
      phase: "AFTER_HOURS",
      clock: {
        timestamp: now,
        isOpen: false,
        nextOpen: "2026-07-20T13:30:00.000Z",
        nextClose: "2026-07-20T20:00:00.000Z"
      },
      providerCalls: []
    }));
    expect(readiness.status).toBe("BLOCKED");
    expect(readiness.reasons.map((reason) => reason.code)).toEqual(expect.arrayContaining([
      "CALENDAR_DISCONTINUITY",
      "OVERNIGHT_NOT_SCHEDULED"
    ]));

    const mismatch = evaluateStockPaperReadiness(readyInput({
      clock: { ...readyInput().clock, isOpen: true }
    }));
    expect(mismatch.status).toBe("BLOCKED");
    expect(mismatch.reasons).toContainEqual(expect.objectContaining({ code: "CLOCK_PHASE_MISMATCH" }));
  });
});
