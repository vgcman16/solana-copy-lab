import { afterEach, describe, expect, it } from "vitest";
import {
  STOCK_PAPER_EXECUTION_VERSION,
  STOCK_PAPER_FEATURE_VERSION,
  type StockPaperCandidate,
  type StockPaperLane,
  type StockPaperObservation,
  type StockPaperObservationOutcome
} from "@copylab/shared";
import { openDatabase, type CopyLabDatabase } from "../src/database.js";
import { StockPaperRepository } from "../src/stock-paper-repository.js";

function observation(
  lane: StockPaperLane,
  observedAt: string,
  sequence: number
): StockPaperObservation {
  const symbol = `T${sequence}`;
  const candidate: StockPaperCandidate = {
    symbol,
    priceUsd: 100,
    bidUsd: 99.95,
    askUsd: 100.05,
    spreadPercent: 0.1,
    change1mPercent: 0.2,
    change5mPercent: 1,
    change15mPercent: 2,
    changeFromOpenPercent: 2,
    dailyChangePercent: 2,
    relativeVolume: 2,
    dollarVolumeUsd: 25_000_000,
    vwapDistancePercent: 0.5,
    score: 80,
    arm: "BREAKOUT",
    highConviction: true,
    eligible: true,
    reasons: [],
    marketPhase: "REGULAR",
    marketFeed: "IEX",
    capturedAt: observedAt
  };
  return {
    id: `observation-${sequence}`,
    laneId: lane.id,
    symbol,
    observedAt,
    idempotencyBucket: observedAt,
    policyVersion: lane.policyVersion,
    policy: lane.policy,
    featureVersion: STOCK_PAPER_FEATURE_VERSION,
    executionVersion: STOCK_PAPER_EXECUTION_VERSION,
    policyDigest: `policy-${sequence}`,
    phase: "REGULAR",
    feed: "IEX",
    candidate,
    tradeDayKey: observedAt.slice(0, 10),
    candidateRank: sequence,
    confirmationSamples: 2,
    entryPriceUsd: candidate.askUsd,
    entryNotionalUsd: 25,
    sessionMinute: sequence,
    newsArticleIds: [],
    hardSafetyPassed: true,
    safetyVetoes: [],
    decision: "OBSERVED",
    reasons: []
  };
}

function outcome(item: StockPaperObservation): StockPaperObservationOutcome {
  return {
    observationId: item.id,
    laneId: item.laneId,
    symbol: item.symbol,
    horizonMinutes: 15,
    status: "LABELED",
    entryPriceUsd: item.entryPriceUsd,
    exitPriceUsd: item.entryPriceUsd + 1,
    netReturnPercent: 1,
    dueAt: new Date(Date.parse(item.observedAt) + 15 * 60_000).toISOString(),
    labeledAt: new Date(Date.parse(item.observedAt) + 16 * 60_000).toISOString()
  };
}

describe("bounded stock PAPER learning evidence", () => {
  let db: CopyLabDatabase | undefined;
  afterEach(() => db?.close());

  it("retains oldest/newest chronology and exact labels after rows cross the count limit", () => {
    db = openDatabase(":memory:");
    const repository = new StockPaperRepository(db);
    const lane = repository.ensureActiveLane("2026-07-01T14:00:00.000Z");
    const items = [
      observation(lane, "2026-07-01T14:01:00.000Z", 1),
      observation(lane, "2026-07-01T14:02:00.000Z", 2),
      observation(lane, "2026-07-01T14:03:00.000Z", 3),
      // A one-row day is deliberately both its first and last anchor. It must
      // never be duplicated in the sampled identity table.
      observation(lane, "2026-07-02T14:01:00.000Z", 4),
      observation(lane, "2026-07-03T14:01:00.000Z", 5),
      observation(lane, "2026-07-03T14:02:00.000Z", 6),
      observation(lane, "2026-07-03T14:03:00.000Z", 7),
      observation(lane, "2026-07-04T14:01:00.000Z", 8),
      observation(lane, "2026-07-04T14:02:00.000Z", 9)
    ];
    const insertObservation = db.prepare(`
      INSERT INTO stock_paper_observations(
        id, lane_id, symbol, decision, observed_at, policy_version, observation_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertOutcome = db.prepare(`
      INSERT INTO stock_paper_observation_outcomes(
        observation_id, lane_id, symbol, horizon_minutes, status,
        due_at, labeled_at, outcome_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    db.transaction(() => {
      for (const item of items) {
        insertObservation.run(
          item.id,
          item.laneId,
          item.symbol,
          item.decision,
          item.observedAt,
          item.policyVersion,
          JSON.stringify(item)
        );
        const label = outcome(item);
        insertOutcome.run(
          label.observationId,
          label.laneId,
          label.symbol,
          label.horizonMinutes,
          label.status,
          label.dueAt,
          label.labeledAt,
          JSON.stringify(label)
        );
      }
    })();

    // A newest-five query loses July 1 entirely. The learning sample remains
    // bounded and pins both ends of the complete chronology even when the
    // seven per-day anchors themselves exceed the five-row capacity.
    expect(repository.observations(lane.id, 5).map((item) => item.tradeDayKey))
      .not.toContain("2026-07-01");
    const first = repository.learningEvidenceSample(lane.id, 5);
    const second = repository.learningEvidenceSample(lane.id, 5);

    expect(first.observations.length).toBeLessThanOrEqual(5);
    expect(first.observations[0]?.id).toBe("observation-1");
    expect(first.observations.at(-1)?.id).toBe("observation-9");
    expect(new Set(first.observations.map((item) => item.id)).size)
      .toBe(first.observations.length);
    expect(first.observations.map((item) => item.id))
      .toEqual(second.observations.map((item) => item.id));
    expect(first.outcomes.map((item) => item.observationId).sort())
      .toEqual(first.observations.map((item) => item.id).sort());
    expect(first.outcomes.every((item) =>
      first.observations.some((observation) => observation.id === item.observationId)
    )).toBe(true);
  });

  it("deduplicates a one-row UTC day while retaining every day when capacity permits", () => {
    db = openDatabase(":memory:");
    const repository = new StockPaperRepository(db);
    const lane = repository.ensureActiveLane("2026-07-01T14:00:00.000Z");
    const items = [
      observation(lane, "2026-07-01T14:01:00.000Z", 1),
      observation(lane, "2026-07-01T14:02:00.000Z", 2),
      observation(lane, "2026-07-02T14:01:00.000Z", 3),
      observation(lane, "2026-07-03T14:01:00.000Z", 4),
      observation(lane, "2026-07-03T14:02:00.000Z", 5)
    ];
    const insert = db.prepare(`
      INSERT INTO stock_paper_observations(
        id, lane_id, symbol, decision, observed_at, policy_version, observation_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const item of items) {
      insert.run(
        item.id,
        item.laneId,
        item.symbol,
        item.decision,
        item.observedAt,
        item.policyVersion,
        JSON.stringify(item)
      );
    }

    const sampled = repository.learningEvidenceSample(lane.id, 5);
    expect(sampled.observations).toHaveLength(5);
    expect(sampled.observations.filter((item) => item.tradeDayKey === "2026-07-02"))
      .toHaveLength(1);
    expect(new Set(sampled.observations.map((item) => item.tradeDayKey)))
      .toEqual(new Set(["2026-07-01", "2026-07-02", "2026-07-03"]));
  });

  it("rejects invalid sample limits", () => {
    db = openDatabase(":memory:");
    const repository = new StockPaperRepository(db);
    const lane = repository.ensureActiveLane("2026-07-01T14:00:00.000Z");
    expect(() => repository.learningEvidenceSample(lane.id, 0)).toThrow(/safe integer of at least two/i);
    expect(() => repository.learningEvidenceSample(lane.id, 1)).toThrow(/safe integer of at least two/i);
    expect(() => repository.learningEvidenceSample(lane.id, 1.5)).toThrow(/safe integer of at least two/i);
  });
});
