import { describe, expect, it } from "vitest";
import {
  AUTONOMOUS_PAPER_EXPLORATION_MAXIMUM_ENTRIES_PER_UTC_DAY,
  AUTONOMOUS_PAPER_EXPLORATION_MINIMUM_SCORE,
  autonomousControlledExploration
} from "../src/autonomous-paper-exploration.js";

describe("autonomous high-risk PAPER controlled exploration", () => {
  it("admits one or two soft flow misses with enough momentum", () => {
    expect(autonomousControlledExploration({
      eligible: false,
      score: 39,
      reasons: ["WEAK_ONE_HOUR_ORGANIC_BUYING"]
    })).toMatchObject({
      eligible: true,
      waivedReasons: ["WEAK_ONE_HOUR_ORGANIC_BUYING"],
      blockingReasons: []
    });
    expect(autonomousControlledExploration({
      eligible: false,
      score: 35,
      reasons: ["LOW_FIVE_MINUTE_ORGANIC_VOLUME", "LOW_VOLUME_ACCELERATION"]
    }).eligible).toBe(true);
    expect(AUTONOMOUS_PAPER_EXPLORATION_MAXIMUM_ENTRIES_PER_UTC_DAY).toBe(4);
  });

  it("does not reinterpret a normally passing signal as exploration", () => {
    expect(autonomousControlledExploration({
      eligible: true,
      score: 80,
      reasons: []
    }).eligible).toBe(false);
  });

  it("keeps missing evidence, pump/range, SOL regime, and liquidity failures hard", () => {
    for (const reason of [
      "MOMENTUM_DATA_MISSING",
      "FIVE_MINUTE_MOMENTUM_OUTSIDE_RANGE",
      "ONE_HOUR_MOMENTUM_OUTSIDE_RANGE",
      "SIX_HOUR_MOMENTUM_OUTSIDE_RANGE",
      "LATE_VERTICAL_PUMP",
      "LIQUIDITY_DRAIN",
      "WEAK_SOL_REGIME",
      "INSUFFICIENT_SOL_RELATIVE_STRENGTH"
    ]) {
      expect(autonomousControlledExploration({
        eligible: false,
        score: 60,
        reasons: [reason]
      })).toMatchObject({ eligible: false, blockingReasons: [reason] });
    }
  });

  it("rejects low scores and more than two simultaneous soft misses", () => {
    expect(autonomousControlledExploration({
      eligible: false,
      score: AUTONOMOUS_PAPER_EXPLORATION_MINIMUM_SCORE - 1,
      reasons: ["WEAK_ONE_HOUR_ORGANIC_BUYING"]
    }).eligible).toBe(false);
    expect(autonomousControlledExploration({
      eligible: false,
      score: 50,
      reasons: [
        "WEAK_FIVE_MINUTE_ORGANIC_BUYING",
        "WEAK_ONE_HOUR_ORGANIC_BUYING",
        "LOW_VOLUME_ACCELERATION"
      ]
    }).eligible).toBe(false);
  });
});
