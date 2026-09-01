import { afterEach, describe, expect, it, vi } from "vitest";
import {
  STOCK_PAPER_EXECUTION_VERSION,
  STOCK_PAPER_FEATURE_VERSION,
  STOCK_PAPER_LEARNING_VERSION,
  type StockPaperCandidate,
  type StockPaperObservation,
  type StockPaperObservationOutcome,
  type StockPaperWalkForwardSummary
} from "@copylab/shared";
import { openDatabase, type CopyLabDatabase } from "../src/database.js";
import {
  createStockPaperLearningObservationV3,
  FROZEN_STOCK_PAPER_SHADOW_POLICIES_V3,
  stockPaperShadowPolicyDigestV3,
  stockPaperShadowPolicySetDigestV3
} from "../src/stock-paper-learning-v3.js";
import { StockPaperRepository } from "../src/stock-paper-repository.js";

const at = "2026-07-16T14:40:12.000Z";

function candidate(): StockPaperCandidate {
  return {
    symbol: "AAPL",
    priceUsd: 100,
    bidUsd: 99.95,
    askUsd: 100.05,
    spreadPercent: 0.1,
    change1mPercent: 0.2,
    change5mPercent: 1.1,
    change15mPercent: 2.3,
    changeFromOpenPercent: 2.8,
    dailyChangePercent: 3,
    relativeVolume: 2.5,
    dollarVolumeUsd: 25_000_000,
    vwapDistancePercent: 0.8,
    score: 82,
    arm: "BREAKOUT",
    highConviction: true,
    eligible: true,
    reasons: [],
    marketPhase: "REGULAR",
    marketFeed: "IEX",
    onlineSources: ["MOVER"],
    capturedAt: at
  };
}

describe("StockPaperRepository v3 learning ledger", () => {
  let db: CopyLabDatabase | undefined;
  afterEach(() => db?.close());

  it("round-trips immutable observations/outcomes and rejects evidence collisions", () => {
    db = openDatabase(":memory:");
    const repository = new StockPaperRepository(db);
    const lane = repository.ensureActiveLane(at);
    const account = repository.account(lane.id)!;
    const item = candidate();
    const bucket = "2026-07-16T14:30:00.000Z";
    const rich = createStockPaperLearningObservationV3({
      laneId: lane.id,
      symbol: item.symbol,
      arm: item.arm,
      phase: "REGULAR",
      feed: "IEX",
      policyVersion: lane.policyVersion,
      policy: lane.policy,
      tradeDayKey: "2026-07-16",
      observedAt: at,
      idempotencyBucket: bucket,
      candidateRank: 1,
      candidateScore: item.score,
      highConviction: item.highConviction,
      confirmationSamples: 2,
      entryPriceUsd: item.askUsd,
      entryNotionalUsd: 25,
      spreadPercent: item.spreadPercent,
      relativeVolume: item.relativeVolume,
      dollarVolumeUsd: item.dollarVolumeUsd,
      change1mPercent: item.change1mPercent,
      change5mPercent: item.change5mPercent,
      change15mPercent: item.change15mPercent,
      vwapDistancePercent: item.vwapDistancePercent,
      sessionMinute: 10,
      onlineSources: item.onlineSources ?? [],
      hardSafetyPassed: true
    });
    const observation: StockPaperObservation = {
      id: rich.id,
      laneId: lane.id,
      symbol: item.symbol,
      observedAt: at,
      idempotencyBucket: bucket,
      policyVersion: lane.policyVersion,
      policy: lane.policy,
      featureVersion: STOCK_PAPER_FEATURE_VERSION,
      executionVersion: STOCK_PAPER_EXECUTION_VERSION,
      policyDigest: rich.policyDigest,
      phase: "REGULAR",
      feed: "IEX",
      candidate: item,
      tradeDayKey: "2026-07-16",
      candidateRank: 1,
      confirmationSamples: 2,
      entryPriceUsd: item.askUsd,
      entryNotionalUsd: 25,
      sessionMinute: 10,
      newsArticleIds: [],
      hardSafetyPassed: true,
      safetyVetoes: [],
      decision: "OBSERVED",
      reasons: []
    };
    const outcome: StockPaperObservationOutcome = {
      observationId: observation.id,
      laneId: lane.id,
      symbol: item.symbol,
      horizonMinutes: 15,
      status: "LABELED",
      entryPriceUsd: 100.05,
      exitPriceUsd: 101,
      netReturnPercent: 0.8,
      dueAt: "2026-07-16T14:55:12.000Z",
      labeledAt: "2026-07-16T14:56:00.000Z"
    };
    const commit = {
      account,
      positions: [],
      equityPoint: {
        capturedAt: at,
        navUsd: account.navUsd,
        cashUsd: account.cashUsd,
        deployedUsd: 0,
        drawdownPercent: 0
      },
      observations: [observation],
      outcomes: [outcome],
      market: {
        feed: "IEX" as const,
        isOpen: false,
        phase: "CLOSED" as const,
        scannedSymbols: 0,
        detailedSymbols: 0,
        providerRequests: 0
      }
    };
    repository.commitCycle(commit);
    repository.commitCycle(commit);

    const prepare = vi.spyOn(db, "prepare");
    const learning = repository.dashboard().learning;
    const boundedQualityReads = prepare.mock.calls.filter(([sql]) =>
      typeof sql === "string" &&
      sql.includes("LEFT JOIN stock_paper_observation_outcomes outcome") &&
      sql.includes("ORDER BY observation.id, outcome.horizon_minutes")
    );
    prepare.mockRestore();
    expect(boundedQualityReads).toHaveLength(1);
    expect(learning).toMatchObject({
      observations: 1,
      labeledOutcomes: 1,
      missingOutcomes: 0,
      pendingOutcomes: 2,
      eligibleCoveragePercent: 100
    });
    expect(learning.outcomeQuality).toEqual([
      expect.objectContaining({
        horizonMinutes: 15,
        dueObservations: 1,
        labeledOutcomes: 1,
        missingOutcomes: 0,
        pendingDueOutcomes: 0,
        futureOutcomes: 0,
        completionPercent: 100,
        eligibleCoveragePercent: 100
      }),
      expect.objectContaining({
        horizonMinutes: 45,
        dueObservations: 1,
        labeledOutcomes: 0,
        missingOutcomes: 0,
        pendingDueOutcomes: 1,
        futureOutcomes: 0,
        completionPercent: 0,
        eligibleCoveragePercent: 0
      }),
      expect.objectContaining({
        horizonMinutes: 180,
        dueObservations: 1,
        labeledOutcomes: 0,
        missingOutcomes: 0,
        pendingDueOutcomes: 1,
        futureOutcomes: 0,
        completionPercent: 0,
        eligibleCoveragePercent: 0
      })
    ]);
    expect(learning.outcomeQuality[0]?.sessionBreakdown).toEqual([
      expect.objectContaining({
        phase: "REGULAR",
        totalObservations: 1,
        dueObservations: 1,
        labeledOutcomes: 1,
        missingOutcomes: 0,
        pendingDueOutcomes: 0,
        eligibleCoveragePercent: 100
      }),
      expect.objectContaining({ phase: "PREMARKET", totalObservations: 0 }),
      expect.objectContaining({ phase: "AFTER_HOURS", totalObservations: 0 }),
      expect.objectContaining({ phase: "OVERNIGHT", totalObservations: 0 })
    ]);
    expect(() => repository.commitCycle({
      ...commit,
      observations: [{ ...observation, reasons: ["different evidence"] }],
      outcomes: []
    })).toThrow(/collided with different evidence/i);
    expect(() => repository.commitCycle({
      ...commit,
      observations: [],
      outcomes: [{ ...outcome, laneId: "wrong-lane", horizonMinutes: 45 }]
    })).toThrow(/outcome lane/i);
  });

  it("isolates contextual learning trades by the exact current policy digest", () => {
    db = openDatabase(":memory:");
    const repository = new StockPaperRepository(db);
    const lane = repository.ensureActiveLane(at);
    const account = repository.account(lane.id)!;
    const entryContext = (policyDigest: string) => ({
      featureVersion: STOCK_PAPER_FEATURE_VERSION,
      policyVersion: lane.policyVersion,
      executionVersion: STOCK_PAPER_EXECUTION_VERSION,
      policyDigest,
      phase: "REGULAR" as const,
      feed: "IEX" as const,
      capturedAt: at,
      candidateRank: 1,
      candidateScore: 82,
      relativeVolume: 2,
      spreadPercent: 0.1,
      change1mPercent: 0.2,
      change5mPercent: 1,
      change15mPercent: 2,
      newsArticleCount: 0,
      screenerHit: true,
      learningMultiplier: 1,
      learningStatus: "WARMING_UP" as const,
      learningSampleSize: 0,
      modeledLimitPriceUsd: 100,
      onlineSources: ["MOVER" as const],
      highConviction: true,
      dollarVolumeUsd: 25_000_000,
      vwapDistancePercent: 0.5,
      dailyChangePercent: 2
    });
    const trade = (id: string, policyDigest: string, closedAt: string) => ({
      id,
      laneId: lane.id,
      positionId: `position:${id}`,
      symbol: "AAPL",
      arm: "BREAKOUT" as const,
      quantity: 1,
      entryPriceUsd: 100,
      exitPriceUsd: 101,
      entryNotionalUsd: 100,
      proceedsUsd: 101,
      modeledCostsUsd: 0,
      pnlUsd: 1,
      returnPercent: 1,
      exitReason: "MAX_HOLD" as const,
      openedAt: at,
      closedAt,
      entryContext: entryContext(policyDigest)
    });
    const position = (id: string, closedAt: string) => ({
      id: `position:${id}`,
      laneId: lane.id,
      symbol: "AAPL",
      arm: "BREAKOUT" as const,
      status: "CLOSED" as const,
      quantity: 0,
      entryPriceUsd: 100,
      entryNotionalUsd: 100,
      remainingCostUsd: 0,
      lastBidUsd: 101,
      lastAskUsd: 101.1,
      lastMarkUsd: 101,
      lastValueUsd: 0,
      peakPriceUsd: 101,
      stopPriceUsd: 92,
      takeProfitPriceUsd: 112,
      scoreAtEntry: 82,
      openedAt: at,
      updatedAt: closedAt,
      closedAt
    });
    repository.commitCycle({
      account,
      positions: [
        position("old-policy", "2026-07-16T15:00:00.000Z"),
        position("current-policy", "2026-07-16T15:01:00.000Z")
      ],
      trades: [
        trade("old-policy", "stock-policy-v3:old", "2026-07-16T15:00:00.000Z"),
        trade("current-policy", "stock-policy-v3:current", "2026-07-16T15:01:00.000Z")
      ],
      equityPoint: {
        capturedAt: "2026-07-16T15:01:00.000Z",
        navUsd: account.navUsd,
        cashUsd: account.cashUsd,
        deployedUsd: 0,
        drawdownPercent: 0
      },
      market: {
        feed: "IEX",
        isOpen: true,
        phase: "REGULAR",
        scannedSymbols: 0,
        detailedSymbols: 0,
        providerRequests: 0
      }
    });

    expect(repository.recentTradesForContext(
      lane.id,
      "BREAKOUT",
      "REGULAR",
      40,
      "stock-policy-v3:current"
    ).map((item) => item.id)).toEqual(["current-policy"]);
  });

  it("persists append-only walk-forward provenance and blocks stale READY status on failure", () => {
    db = openDatabase(":memory:");
    const repository = new StockPaperRepository(db);
    const lane = repository.ensureActiveLane(at);
    const walkForward: StockPaperWalkForwardSummary = {
      status: "COLLECTING",
      analysisOnly: true,
      mayAffectTrading: false,
      promotionEligible: false,
      evaluatedAt: at,
      cutoffAt: at,
      horizonMinutes: 15,
      folds: 0,
      holdoutScorablePaths: 0,
      coveragePercent: 0,
      distinctSymbols: 1,
      distinctTradeDays: 1,
      datasetDigest: "stock-dataset-v3:test",
      policySetDigest: stockPaperShadowPolicySetDigestV3(),
      evaluationDigest: "stock-evaluation-v3:test-a",
      gateReasons: ["HOLDOUT_PATHS_BELOW_MINIMUM"]
    };
    const evaluation = {
      laneId: lane.id,
      checkpointId: "stock-learning-checkpoint:test",
      datasetDigest: walkForward.datasetDigest,
      evaluationDigest: walkForward.evaluationDigest,
      capturedAt: at,
      cutoffAt: at,
      walkForward,
      shadowResults: FROZEN_STOCK_PAPER_SHADOW_POLICIES_V3.map((policy) => ({
        id: `stock-shadow:test:${policy.id}`,
        score: {
          policyId: policy.id,
          policyDigest: stockPaperShadowPolicyDigestV3(policy),
          datasetDigest: walkForward.datasetDigest,
          learnerVersion: STOCK_PAPER_LEARNING_VERSION,
          horizonMinutes: 15 as const,
          evaluatedAt: at,
          observations: 1,
          labeled: 0,
          trades: 1,
          wins: 0,
          netReturnPercent: 0,
          averageReturnPercent: 0,
          maximumDrawdownPercent: 0,
          pathsAreIndependentTrades: false as const,
          promotionEligible: false as const
        }
      }))
    };
    repository.commitLearningEvaluation(evaluation);
    repository.commitLearningEvaluation(evaluation);
    expect(repository.dashboard().learning.walkForward).toEqual(walkForward);
    expect(repository.dashboard().learning.shadowPolicies).toHaveLength(
      FROZEN_STOCK_PAPER_SHADOW_POLICIES_V3.length
    );
    expect(repository.dashboard().learning.shadowPolicies).toContainEqual(
      expect.objectContaining({
        policyId: "STATIC_BASELINE",
        pathsAreIndependentTrades: false
      })
    );
    expect(() => repository.commitLearningEvaluation({
      ...evaluation,
      shadowResults: [evaluation.shadowResults[0]!]
    })).toThrow(/every frozen shadow policy/i);
    expect(() => repository.commitLearningEvaluation({
      ...evaluation,
      shadowResults: [{
        ...evaluation.shadowResults[0]!,
        score: { ...evaluation.shadowResults[0]!.score, policyDigest: "stock-shadow-policy-v3:stale" }
      }]
    })).toThrow(/stale policy digest/i);
    const persistedShadow = db.prepare(`
      SELECT result_json FROM stock_paper_shadow_results WHERE id = ?
    `).get("stock-shadow:test:STATIC_BASELINE") as { result_json: string };
    const staleShadow = {
      ...(JSON.parse(persistedShadow.result_json) as Record<string, unknown>),
      policyDigest: "stock-shadow-policy-v3:stale"
    };
    db.prepare(`UPDATE stock_paper_shadow_results SET result_json = ? WHERE id = ?`)
      .run(JSON.stringify(staleShadow), "stock-shadow:test:STATIC_BASELINE");
    expect(repository.dashboard().learning.shadowPolicies).toEqual([]);
    db.prepare(`UPDATE stock_paper_shadow_results SET result_json = ? WHERE id = ?`)
      .run(persistedShadow.result_json, "stock-shadow:test:STATIC_BASELINE");
    expect(() => repository.commitLearningEvaluation({
      ...evaluation,
      walkForward: { ...walkForward, gateReasons: ["different"] }
    })).toThrow(/collided with different evidence/i);

    const secondWalkForward: StockPaperWalkForwardSummary = {
      ...walkForward,
      evaluatedAt: "2026-07-16T14:41:12.000Z",
      evaluationDigest: "stock-evaluation-v3:test-b",
      gateReasons: ["DISTINCT_SYMBOLS_BELOW_MINIMUM"]
    };
    repository.commitLearningEvaluation({
      ...evaluation,
      checkpointId: "stock-learning-checkpoint:test-b",
      evaluationDigest: secondWalkForward.evaluationDigest,
      capturedAt: secondWalkForward.evaluatedAt,
      walkForward: secondWalkForward,
      shadowResults: evaluation.shadowResults.map((result) => ({
        id: `${result.id}:test-b`,
        score: { ...result.score, evaluatedAt: secondWalkForward.evaluatedAt }
      }))
    });
    expect(db.prepare(`
      SELECT dataset_digest, evaluation_digest
      FROM stock_paper_learning_checkpoints
      ORDER BY evaluation_digest
    `).all()).toEqual([
      {
        dataset_digest: walkForward.datasetDigest,
        evaluation_digest: walkForward.evaluationDigest
      },
      {
        dataset_digest: walkForward.datasetDigest,
        evaluation_digest: secondWalkForward.evaluationDigest
      }
    ]);
    expect(repository.dashboard().learning.walkForward).toEqual(secondWalkForward);
    expect(repository.dashboard().learning.shadowPolicies).toHaveLength(
      FROZEN_STOCK_PAPER_SHADOW_POLICIES_V3.length
    );
    expect(repository.dashboard().learning.shadowPolicies.every((score) =>
      score.evaluatedAt === secondWalkForward.evaluatedAt
    )).toBe(true);

    repository.recordFailure(lane.id, "snapshots unavailable", at);
    expect(repository.dashboard().market).toMatchObject({
      isOpen: false,
      feedActionable: false,
      readiness: { status: "BLOCKED" }
    });
  });
});
