import { afterEach, describe, expect, it } from "vitest";
import {
  STOCK_PAPER_ROTATION_SHADOW_VERSION,
  type StockPaperRotationDecision,
  type StockPaperRotationOutcome,
  type StockPaperRotationPolicy
} from "@copylab/shared";
import { openDatabase, type CopyLabDatabase } from "../src/database.js";
import { stockPaperPolicyDigestV3 } from "../src/stock-paper-learning-v3.js";
import { StockPaperRepository } from "../src/stock-paper-repository.js";

const decisionAt = "2026-07-17T14:40:00.000Z";
const bucket = "2026-07-17T14:30:00.000Z";
const policy: StockPaperRotationPolicy = {
  version: STOCK_PAPER_ROTATION_SHADOW_VERSION,
  minimumPositionAgeMinutes: 15,
  rotationCooldownMinutes: 30,
  minimumScoreDelta: 10,
  minimumReplacementNotionalUsd: 10,
  maximumSwitchCostPercent: 1
};

function decision(laneId: string, sourcePolicyDigest: string): StockPaperRotationDecision {
  return {
    id: "stock-rotation-decision:test",
    idempotencyKey: "stock-rotation-idempotency:test",
    laneId,
    version: STOCK_PAPER_ROTATION_SHADOW_VERSION,
    policy,
    policyDigest: `stock-rotation-policy-v1:${"a".repeat(64)}`,
    sourcePolicyDigest,
    idempotencyBucket: bucket,
    decisionAt,
    phase: "REGULAR",
    feed: "IEX",
    extendedFillPenaltyPercent: 0,
    status: "ROTATE",
    reasonCodes: [],
    analysisOnly: true,
    affectsTrading: false,
    promotionEligible: false,
    portfolioCounterfactual: false,
    resultsAreIndependentOneStepCounterfactuals: true,
    outgoing: {
      positionId: "stock-position:usb",
      symbol: "USB",
      openedAt: "2026-07-17T13:46:00.000Z",
      ageMinutes: 54,
      candidateCapturedAt: decisionAt,
      currentScore: 54,
      currentRelativeVolume: 1.1,
      bidUsd: 63.8,
      askUsd: 63.82,
      spreadPercent: 0.0313,
      quantity: 1,
      remainingCostUsd: 64,
      executableReturnPercent: -0.35,
      modeledSellPriceUsd: 63.78,
      executableProceedsUsd: 63.7736,
      modeledExitCostUsd: 0.0064
    },
    incoming: {
      symbol: "LCID",
      candidateCapturedAt: decisionAt,
      currentScore: 71,
      currentRelativeVolume: 3.1,
      bidUsd: 6.56,
      askUsd: 6.57,
      spreadPercent: 0.1523,
      modeledBuyPriceUsd: 6.5732,
      quantity: 9.7,
      entryNotionalUsd: 63.758,
      modeledEntryCostUsd: 0.031
    },
    scoreDelta: 17,
    modeledSwitchCostsUsd: 0.0374,
    modeledSwitchCostPercent: 0.0586,
    preRotationNavUsd: 140,
    preRotationCashUsd: 14,
    preRotationDeployedUsd: 126,
    hypotheticalPostSaleCashUsd: 77.7736,
    hypotheticalPostSaleDeployedUsd: 62,
    hypotheticalPostSaleNavUsd: 139.7736,
    hypotheticalPostEntryCashUsd: 14.0156,
    hypotheticalPostEntryDeployedUsd: 125.758,
    hypotheticalPostEntryNavUsd: 139.7736
  };
}

function outcome(
  source: StockPaperRotationDecision,
  horizonMinutes: 15 | 45 | 180 = 15
): StockPaperRotationOutcome {
  const dueAt = new Date(Date.parse(source.decisionAt) + horizonMinutes * 60_000).toISOString();
  return {
    id: `stock-rotation-outcome:test:${horizonMinutes}`,
    idempotencyKey: `stock-rotation-outcome-idempotency:test:${horizonMinutes}`,
    decisionId: source.id,
    laneId: source.laneId,
    version: STOCK_PAPER_ROTATION_SHADOW_VERSION,
    horizonMinutes,
    status: "LABELED",
    dueAt,
    labeledAt: new Date(Date.parse(dueAt) + 60_000).toISOString(),
    analysisOnly: true,
    affectsTrading: false,
    promotionEligible: false,
    portfolioCounterfactual: false,
    resultsAreIndependentOneStepCounterfactuals: true,
    outgoingFirstBarAt: "2026-07-17T14:41:00.000Z",
    outgoingLastBarAt: dueAt,
    incomingFirstBarAt: "2026-07-17T14:41:00.000Z",
    incomingLastBarAt: dueAt,
    baselineExitPriceUsd: 63.4,
    baselineExitProceedsUsd: 63.3937,
    baselineModeledExitCostUsd: 0.0063,
    baselineHoldPnlUsd: -0.6063,
    rotatedIncomingExitPriceUsd: 6.72,
    rotatedIncomingExitProceedsUsd: 65.1775,
    rotatedIncomingModeledExitCostUsd: 0.0065,
    rotatedPnlUsd: 1.3821,
    totalRotationModeledCostsUsd: 0.0439,
    incrementalPnlUsd: 1.9884,
    incrementalReturnPercent: 3.1069
  };
}

function authoritativeState(db: CopyLabDatabase): string {
  const tables = [
    "stock_paper_accounts",
    "stock_paper_positions",
    "stock_paper_orders",
    "stock_paper_trades"
  ];
  return JSON.stringify(Object.fromEntries(tables.map((table) => [
    table,
    db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()
  ])));
}

describe("StockPaperRepository rotation analysis", () => {
  let db: CopyLabDatabase | undefined;

  afterEach(() => db?.close());

  it("round-trips idempotent one-step evidence without mutating the authoritative PAPER ledger", () => {
    db = openDatabase(":memory:");
    const repository = new StockPaperRepository(db);
    const lane = repository.ensureActiveLane(decisionAt);
    const item = decision(lane.id, stockPaperPolicyDigestV3(lane.policy));
    const label = outcome(item);
    const before = authoritativeState(db);

    repository.commitRotationAnalysis({ laneId: lane.id, decisions: [item] });
    repository.commitRotationAnalysis({ laneId: lane.id, decisions: [item] });

    expect(repository.rotationDecisionsDue(lane.id, 15, decisionAt)).toEqual([item]);
    expect(repository.rotationDecisionsDue(lane.id, 45, decisionAt)).toEqual([item]);

    repository.commitRotationAnalysis({ laneId: lane.id, outcomes: [label] });
    repository.commitRotationAnalysis({ laneId: lane.id, decisions: [item], outcomes: [label] });

    expect(repository.rotationDecisionsDue(lane.id, 15, decisionAt)).toEqual([]);
    expect(repository.rotationDecisionsDue(lane.id, 45, decisionAt)).toEqual([item]);
    expect(repository.recentRotationDecisions(lane.id)).toEqual([item]);
    expect(repository.recentRotationOutcomes(lane.id)).toEqual([label]);
    expect(repository.rotationSummary(lane.id)).toMatchObject({
      version: STOCK_PAPER_ROTATION_SHADOW_VERSION,
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
      incrementalWins: 1,
      incrementalWinRatePercent: 100,
      meanIncrementalPnlUsd: label.incrementalPnlUsd,
      meanIncrementalReturnPercent: label.incrementalReturnPercent
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM stock_paper_rotation_decisions").get())
      .toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM stock_paper_rotation_outcomes").get())
      .toEqual({ count: 1 });
    expect(authoritativeState(db)).toBe(before);
  });

  it("rejects decision and outcome identity collisions including a second policy-bucket decision", () => {
    db = openDatabase(":memory:");
    const repository = new StockPaperRepository(db);
    const lane = repository.ensureActiveLane(decisionAt);
    const item = decision(lane.id, stockPaperPolicyDigestV3(lane.policy));
    const label = outcome(item);
    repository.commitRotationAnalysis({ laneId: lane.id, decisions: [item], outcomes: [label] });

    expect(() => repository.commitRotationAnalysis({
      laneId: lane.id,
      decisions: [{ ...item, id: "stock-rotation-decision:other", idempotencyKey: "other-key" }]
    })).toThrow(/identity collided/i);
    expect(() => repository.commitRotationAnalysis({
      laneId: lane.id,
      decisions: [{ ...item, reasonCodes: ["SCORE_DELTA_BELOW_MINIMUM"] }]
    })).toThrow(/identity collided/i);
    expect(() => repository.commitRotationAnalysis({
      laneId: lane.id,
      outcomes: [{ ...label, incrementalPnlUsd: -2 }]
    })).toThrow(/identity collided/i);
    expect(db.prepare("SELECT COUNT(*) AS count FROM stock_paper_rotation_decisions").get())
      .toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM stock_paper_rotation_outcomes").get())
      .toEqual({ count: 1 });
  });

  it("keeps HOLD decisions as evidence without scheduling or accepting outcome rows", () => {
    db = openDatabase(":memory:");
    const repository = new StockPaperRepository(db);
    const lane = repository.ensureActiveLane(decisionAt);
    const rotating = decision(lane.id, stockPaperPolicyDigestV3(lane.policy));
    const { outgoing: _outgoing, incoming: _incoming, ...base } = rotating;
    const hold: StockPaperRotationDecision = {
      ...base,
      id: "stock-rotation-decision:hold",
      idempotencyKey: "stock-rotation-idempotency:hold",
      status: "HOLD",
      reasonCodes: ["SCORE_DELTA_BELOW_MINIMUM"]
    };
    repository.commitRotationAnalysis({ laneId: lane.id, decisions: [hold] });

    expect(repository.rotationDecisionsDue(lane.id, 15, decisionAt)).toEqual([]);
    expect(() => repository.commitRotationAnalysis({
      laneId: lane.id,
      outcomes: [outcome(hold)]
    })).toThrow(/hold decisions cannot produce outcome rows/i);
    expect(repository.rotationSummary(lane.id)).toMatchObject({
      evaluatedDecisions: 1,
      proposedRotations: 0,
      heldDecisions: 1,
      labeledOutcomes: 0,
      missingOutcomes: 0
    });
  });

  it("preserves old decision provenance after a lane-policy change but rejects new stale-policy decisions", () => {
    db = openDatabase(":memory:");
    const repository = new StockPaperRepository(db);
    const lane = repository.ensureActiveLane(decisionAt);
    const original = decision(lane.id, stockPaperPolicyDigestV3(lane.policy));
    repository.commitRotationAnalysis({ laneId: lane.id, decisions: [original] });

    db.prepare(`
      UPDATE stock_paper_lanes
      SET policy_json = ?, updated_at = ?
      WHERE id = ?
    `).run(
      JSON.stringify({ ...lane.policy, minimumSignalScore: lane.policy.minimumSignalScore + 1 }),
      "2026-07-17T14:50:00.000Z",
      lane.id
    );

    expect(repository.recentRotationDecisions(lane.id)).toEqual([original]);
    repository.commitRotationAnalysis({ laneId: lane.id, outcomes: [outcome(original)] });
    expect(repository.recentRotationOutcomes(lane.id)).toHaveLength(1);

    const staleNewDecision: StockPaperRotationDecision = {
      ...original,
      id: "stock-rotation-decision:stale-new",
      idempotencyKey: "stock-rotation-idempotency:stale-new",
      idempotencyBucket: "2026-07-17T14:45:00.000Z",
      decisionAt: "2026-07-17T14:55:00.000Z"
    };
    expect(() => repository.commitRotationAnalysis({
      laneId: lane.id,
      decisions: [staleNewDecision]
    })).toThrow(/source policy is not the active lane policy/i);
  });

  it("rejects empty, wrong-lane, non-research, and orphaned outcome commits atomically", () => {
    db = openDatabase(":memory:");
    const repository = new StockPaperRepository(db);
    const lane = repository.ensureActiveLane(decisionAt);
    const item = decision(lane.id, stockPaperPolicyDigestV3(lane.policy));
    const invalidBoundary = {
      ...item,
      affectsTrading: true
    } as unknown as StockPaperRotationDecision;

    expect(() => repository.commitRotationAnalysis({ laneId: lane.id })).toThrow(/cannot be empty/i);
    expect(() => repository.commitRotationAnalysis({
      laneId: "wrong-lane",
      decisions: [{ ...item, laneId: "wrong-lane" }]
    })).toThrow(/active research-only lane/i);
    expect(() => repository.commitRotationAnalysis({
      laneId: lane.id,
      decisions: [invalidBoundary]
    })).toThrow(/research-only boundary mismatch/i);

    const orphan = outcome({ ...item, id: "missing-decision" });
    expect(() => repository.commitRotationAnalysis({
      laneId: lane.id,
      decisions: [item],
      outcomes: [orphan]
    })).toThrow(/no committed source decision/i);
    expect(db.prepare("SELECT COUNT(*) AS count FROM stock_paper_rotation_decisions").get())
      .toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM stock_paper_rotation_outcomes").get())
      .toEqual({ count: 0 });
  });

  it("fails closed when persisted decision or outcome JSON violates the independent-analysis boundary", () => {
    db = openDatabase(":memory:");
    const repository = new StockPaperRepository(db);
    const lane = repository.ensureActiveLane(decisionAt);
    const item = decision(lane.id, stockPaperPolicyDigestV3(lane.policy));
    const label = outcome(item);
    repository.commitRotationAnalysis({ laneId: lane.id, decisions: [item], outcomes: [label] });

    db.prepare(`
      UPDATE stock_paper_rotation_outcomes SET outcome_json = ? WHERE id = ?
    `).run(JSON.stringify({ ...label, portfolioCounterfactual: true }), label.id);
    expect(repository.recentRotationOutcomes(lane.id)).toEqual([]);
    expect(repository.rotationSummary(lane.id)).toMatchObject({
      evaluatedDecisions: 1,
      labeledOutcomes: 0,
      missingOutcomes: 0,
      compoundedPortfolioNavAvailable: false
    });

    db.prepare(`
      UPDATE stock_paper_rotation_decisions SET decision_json = ? WHERE id = ?
    `).run(JSON.stringify({ ...item, analysisOnly: false }), item.id);
    expect(repository.recentRotationDecisions(lane.id)).toEqual([]);
    expect(repository.recentRotationOutcomes(lane.id)).toEqual([]);
    expect(repository.rotationSummary(lane.id)).toBeUndefined();
  });
});
