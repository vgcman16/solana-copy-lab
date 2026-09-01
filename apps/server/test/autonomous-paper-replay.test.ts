import { describe, expect, it } from "vitest";
import {
  AUTONOMOUS_PAPER_REPLAY_GRID_DIGEST,
  AUTONOMOUS_PAPER_REPLAY_GRID_VERSION,
  AUTONOMOUS_PAPER_REPLAY_VARIANT_COUNT,
  AUTONOMOUS_PAPER_REPLAY_VARIANTS,
  evaluateAutonomousPaperReplay,
  type AutonomousPaperReplayObservation,
  type AutonomousPaperReplayPath
} from "../src/autonomous-paper-replay.js";

const OPENED_AT = "2026-07-14T12:00:00.000Z";

function at(minutes: number): string {
  return new Date(Date.parse(OPENED_AT) + minutes * 60_000).toISOString();
}

function executable(
  id: string,
  minutes: number,
  executableValueUsd: number,
  overrides: Partial<Extract<
    AutonomousPaperReplayObservation,
    { status: "EXECUTABLE" }
  >> = {}
): Extract<AutonomousPaperReplayObservation, { status: "EXECUTABLE" }> {
  return {
    id,
    observedAt: at(minutes),
    kind: minutes === 0 ? "ENTRY" : "MARK",
    status: "EXECUTABLE",
    executableValueUsd,
    staticSafetyEligible: true,
    priceChange5mPercent: 1,
    organicBuyShare5m: 0.6,
    ...overrides
  };
}

function path(
  observations: readonly AutonomousPaperReplayObservation[],
  overrides: Partial<AutonomousPaperReplayPath> = {}
): AutonomousPaperReplayPath {
  const actual = observations.find((observation) => observation.kind === "ACTUAL_EXIT");
  if (!actual || actual.status !== "EXECUTABLE") {
    throw new Error("Test replay path requires an executable actual exit.");
  }
  return {
    id: "paper-trade-1",
    openedAt: OPENED_AT,
    entryCostUsd: 100,
    observations,
    actual: {
      exitObservationId: actual.id,
      exitReason: "TAKE_PROFIT",
      proceedsUsd: actual.executableValueUsd
    },
    ...overrides
  };
}

function resultAt(report: ReturnType<typeof evaluateAutonomousPaperReplay>, index: number) {
  const result = report.results[index];
  if (!result) throw new Error(`Missing replay result ${index}.`);
  return result;
}

describe("autonomous PAPER replay lab", () => {
  it("builds exactly 1,000 stable variants and includes the frozen v7 exit policy", () => {
    expect(AUTONOMOUS_PAPER_REPLAY_GRID_VERSION).toBe("autonomous-exit-replay-v2");
    expect(AUTONOMOUS_PAPER_REPLAY_VARIANTS).toHaveLength(1_000);
    expect(AUTONOMOUS_PAPER_REPLAY_VARIANT_COUNT).toBe(1_000);
    expect(new Set(AUTONOMOUS_PAPER_REPLAY_VARIANTS.map((variant) => variant.id)).size)
      .toBe(1_000);
    expect(new Set(AUTONOMOUS_PAPER_REPLAY_VARIANTS.map((variant) => variant.digest)).size)
      .toBe(1_000);
    expect(AUTONOMOUS_PAPER_REPLAY_VARIANTS.map((variant) => variant.index))
      .toEqual(Array.from({ length: 1_000 }, (_unused, index) => index));

    expect(AUTONOMOUS_PAPER_REPLAY_VARIANTS[473]).toMatchObject({
      index: 473,
      stopLossPercent: 10,
      takeProfitPercent: 18,
      trailingActivationPercent: 8,
      trailingDrawdownPercent: 5,
      maximumHoldingMinutes: 180,
      breakEvenActivationPercent: 4,
      weakMomentumExitSamples: 3,
      noProgressMinutes: 45
    });
    expect(AUTONOMOUS_PAPER_REPLAY_GRID_DIGEST)
      .toBe("63e9f2696fd33b01e9491e82b04b36b2ddea98adc325429e3c8af8d1ee8f3431");
  });

  it("uses the first chronological trigger and labels the per-path winner as hindsight only", () => {
    const report = evaluateAutonomousPaperReplay(path([
      executable("entry", 0, 97),
      executable("mark-10", 10, 105),
      executable("actual-exit", 20, 120, { kind: "ACTUAL_EXIT" }),
      executable("follow-30", 30, 150, { kind: "FOLLOW_THROUGH" }),
      executable("follow-60", 60, 125, { kind: "FOLLOW_THROUGH" }),
      executable("follow-180", 180, 110, { kind: "FOLLOW_THROUGH" })
    ]));

    const frozenV7 = resultAt(report, 473);
    expect(frozenV7).toMatchObject({
      status: "RESOLVED",
      exitReason: "TAKE_PROFIT",
      exitObservationId: "actual-exit",
      exitedAt: at(20),
      executableValueUsd: 120
    });
    if (frozenV7.status !== "RESOLVED") throw new Error("Expected resolved v7 replay.");
    expect(frozenV7.returnPercent).toBeCloseTo(20, 12);
    expect(report).toMatchObject({
      sampleCount: 1,
      variantCount: 1_000,
      actual: { proceedsUsd: 120, pnlUsd: 20 },
      hindsightBest: {
        evidenceClass: "HINDSIGHT_ONLY",
        variantIndex: 80,
        exitObservationId: "follow-30",
        returnPercent: 50
      }
    });
    expect(report.actual.returnPercent).toBeCloseTo(20, 12);
    expect(report.hindsightBest?.returnDeltaVsActualPercent).toBeCloseTo(30, 12);
  });

  it("marks every still-open policy unresolved at the first missing executable point", () => {
    const report = evaluateAutonomousPaperReplay(path([
      executable("entry", 0, 97),
      executable("actual-exit", 10, 100, { kind: "ACTUAL_EXIT" }),
      {
        id: "unpriced-20",
        observedAt: at(20),
        kind: "FOLLOW_THROUGH",
        status: "UNPRICED",
        failureCode: "SELL_QUOTE_UNAVAILABLE"
      },
      executable("follow-30", 30, 140, { kind: "FOLLOW_THROUGH" }),
      executable("follow-180", 180, 140, { kind: "FOLLOW_THROUGH" })
    ], {
      actual: {
        exitObservationId: "actual-exit",
        exitReason: "MANUAL_PAUSE",
        proceedsUsd: 100
      }
    }));

    expect(report.resolvedVariantCount).toBe(0);
    expect(report.unresolvedVariantCount).toBe(1_000);
    expect(resultAt(report, 473)).toMatchObject({
      status: "UNRESOLVED",
      unresolvedReason: "MISSING_EXECUTABLE_OBSERVATION",
      unresolvedAt: at(20),
      unresolvedObservationId: "unpriced-20",
      observationsConsumed: 3
    });
    expect(report.hindsightBest).toBeUndefined();
  });

  it("does not let a later missing quote invalidate a policy that already exited", () => {
    const report = evaluateAutonomousPaperReplay(path([
      executable("entry", 0, 97),
      executable("actual-exit", 5, 80, { kind: "ACTUAL_EXIT" }),
      {
        id: "unpriced-10",
        observedAt: at(10),
        kind: "FOLLOW_THROUGH",
        status: "UNPRICED",
        failureCode: "SELL_QUOTE_UNAVAILABLE"
      }
    ], {
      actual: {
        exitObservationId: "actual-exit",
        exitReason: "STOP_LOSS",
        proceedsUsd: 80
      }
    }));

    expect(report.resolvedVariantCount).toBe(1_000);
    expect(report.unresolvedVariantCount).toBe(0);
    expect(report.results.every((result) =>
      result.status === "RESOLVED" &&
      result.exitReason === "STOP_LOSS" &&
      result.exitObservationId === "actual-exit"
    )).toBe(true);
  });

  it("reports incomplete follow-through only for variants whose first exit was not observed", () => {
    const report = evaluateAutonomousPaperReplay(path([
      executable("entry", 0, 97),
      executable("mark-10", 10, 105),
      executable("actual-exit", 20, 105, { kind: "ACTUAL_EXIT" }),
      executable("follow-60", 60, 105, { kind: "FOLLOW_THROUGH" })
    ], {
      actual: {
        exitObservationId: "actual-exit",
        exitReason: "MANUAL_PAUSE",
        proceedsUsd: 105
      }
    }));

    expect(report.resolvedVariantCount).toBe(500);
    expect(report.unresolvedVariantCount).toBe(500);
    expect(AUTONOMOUS_PAPER_REPLAY_VARIANTS[472]?.maximumHoldingMinutes).toBe(60);
    expect(resultAt(report, 472)).toMatchObject({
      status: "RESOLVED",
      exitReason: "MAX_HOLD",
      exitObservationId: "follow-60"
    });
    expect(resultAt(report, 473)).toMatchObject({
      status: "UNRESOLVED",
      unresolvedReason: "PATH_ENDED_BEFORE_EXIT"
    });
  });

  it("uses executable values as already net of modeled costs and keeps one path as one sample", () => {
    const report = evaluateAutonomousPaperReplay(path([
      executable("entry", 0, 97),
      executable("actual-exit", 1, 90, { kind: "ACTUAL_EXIT" }),
      executable("follow-45", 45, 100, { kind: "FOLLOW_THROUGH" }),
      executable("follow-180", 180, 100, { kind: "FOLLOW_THROUGH" })
    ], {
      entryCostUsd: 102,
      actual: {
        exitObservationId: "actual-exit",
        exitReason: "MANUAL_PAUSE",
        proceedsUsd: 90
      }
    }));

    expect(report.sampleCount).toBe(1);
    expect(report.results).toHaveLength(1_000);
    expect(report.actual).toMatchObject({
      proceedsUsd: 90,
      pnlUsd: -12,
      returnPercent: (90 / 102 - 1) * 100
    });
    const frozenV7 = resultAt(report, 473);
    expect(frozenV7.status).toBe("RESOLVED");
    if (frozenV7.status !== "RESOLVED") throw new Error("Expected resolved v7 replay.");
    expect(frozenV7.pnlUsd).toBe(-12);
    expect(frozenV7.returnPercent).toBe((90 / 102 - 1) * 100);
  });

  it("applies token safety before a simultaneous profitable exit trigger", () => {
    const report = evaluateAutonomousPaperReplay(path([
      executable("entry", 0, 97),
      executable("actual-exit", 3, 150, {
        kind: "ACTUAL_EXIT",
        staticSafetyEligible: false
      })
    ], {
      actual: {
        exitObservationId: "actual-exit",
        exitReason: "TOKEN_SAFETY",
        proceedsUsd: 150
      }
    }));

    expect(report.results.every((result) =>
      result.status === "RESOLVED" && result.exitReason === "TOKEN_SAFETY"
    )).toBe(true);
  });

  it("accepts the -1 organic-share sentinel and exits on its third weak sample", () => {
    const report = evaluateAutonomousPaperReplay(path([
      executable("entry", 0, 100),
      executable("weak-1", 1, 100, { organicBuyShare5m: -1 }),
      executable("weak-2", 2, 100, { organicBuyShare5m: -1 }),
      executable("actual-exit", 3, 100, {
        kind: "ACTUAL_EXIT",
        organicBuyShare5m: -1
      })
    ], {
      actual: {
        exitObservationId: "actual-exit",
        exitReason: "MANUAL_PAUSE",
        proceedsUsd: 100
      }
    }));

    expect(report.results).toHaveLength(1_000);
    const resolved = report.results.filter((result) => result.status === "RESOLVED");
    const unresolved = report.results.filter((result) => result.status === "UNRESOLVED");
    expect(resolved).toHaveLength(500);
    expect(unresolved).toHaveLength(500);
    expect(resolved.every((result) =>
      result.status === "RESOLVED" && result.exitReason === "WEAK_MOMENTUM"
    )).toBe(true);
  });

  it.each([0, 1])("accepts organic buy-share boundary %s", (organicBuyShare5m) => {
    expect(() => evaluateAutonomousPaperReplay(path([
      executable("entry", 0, 100, { organicBuyShare5m }),
      executable("actual-exit", 1, 120, {
        kind: "ACTUAL_EXIT",
        organicBuyShare5m
      })
    ]))).not.toThrow();
  });

  it.each([-0.5, -1.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects invalid organic buy share %s",
    (organicBuyShare5m) => {
      expect(() => evaluateAutonomousPaperReplay(path([
        executable("entry", 0, 100, { organicBuyShare5m }),
        executable("actual-exit", 1, 100, { kind: "ACTUAL_EXIT" })
      ]))).toThrow("Replay organic buy share must be exactly -1");
    }
  );

  it("rejects reordered, duplicate, and mismatched executable evidence", () => {
    expect(() => evaluateAutonomousPaperReplay(path([
      executable("entry", 0, 97),
      executable("actual-exit", 20, 100, { kind: "ACTUAL_EXIT" }),
      executable("late-in-array", 10, 100, { kind: "FOLLOW_THROUGH" })
    ]))).toThrow("strictly chronological");

    expect(() => evaluateAutonomousPaperReplay(path([
      executable("entry", 0, 97),
      executable("entry", 20, 100, { kind: "ACTUAL_EXIT" })
    ]))).toThrow("non-empty and unique");

    expect(() => evaluateAutonomousPaperReplay(path([
      executable("entry", 0, 97),
      executable("actual-exit", 20, 100, { kind: "ACTUAL_EXIT" })
    ], {
      actual: {
        exitObservationId: "actual-exit",
        exitReason: "TAKE_PROFIT",
        proceedsUsd: 99
      }
    }))).toThrow("do not match");
  });
});
