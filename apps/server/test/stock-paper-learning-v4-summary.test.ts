import type { StockPaperLearningV4Summary } from "@copylab/shared";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type CopyLabDatabase } from "../src/database.js";
import { analyzeStockPaperLearningV4 } from "../src/stock-paper-learning-v4.js";
import type { StockPaperLearningV4Evidence } from "../src/stock-paper-learning-v4-evidence.js";
import { summarizeStockPaperLearningV4 } from "../src/stock-paper-learning-v4-summary.js";
import { StockPaperRepository } from "../src/stock-paper-repository.js";

const at = "2026-07-16T18:00:00.000Z";

function emptyEvidence(sourceTradeCount = 0): StockPaperLearningV4Evidence {
  return {
    v41EvidenceStartedAt: "2026-07-16T17:00:00.000Z",
    sourceTradeCount,
    analysisTradeCount: 0,
    exclusions: sourceTradeCount > 0 ? [{
      tradeId: "legacy-trade",
      symbol: "AAPL",
      reason: "BUY_FILL_EVENTS_MISSING",
      evidenceEra: "LEGACY"
    }] : [],
    trades: [],
    dailyReturns: []
  };
}

describe("stock PAPER learning-v4 dashboard summary", () => {
  let db: CopyLabDatabase | undefined;
  afterEach(() => db?.close());

  it("labels an empty v41 event window as collecting and preserves honest limitations", () => {
    const evidence = emptyEvidence(1);
    const analysis = analyzeStockPaperLearningV4({
      cutoffAt: at,
      trades: evidence.trades,
      dailyReturns: evidence.dailyReturns,
      config: { bootstrapReplicates: 50 }
    });
    const summary = summarizeStockPaperLearningV4({ evidence, analysis });

    expect(summary).toMatchObject({
      status: "COLLECTING_V41_EVIDENCE",
      analysisOnly: true,
      affectsTrading: false,
      promotionEligible: false,
      portfolioCounterfactual: false,
      sourceTradeCount: 1,
      analyzedTradeCount: 0,
      excludedTradeCount: 1,
      replay: {
        realizedPathOnly: true,
        portfolioCounterfactual: false,
        fixedHistoricalNotionals: true
      },
      bootstrap: {
        fixedHistoricalNotionals: true,
        activeTradeDays: 0
      },
      evidenceHealth: {
        status: "HEALTHY",
        legacyExcludedTradeCount: 1,
        postV41ExcludedTradeCount: 0
      }
    });
    expect(summary.exclusionReasons).toEqual([{
      reason: "BUY_FILL_EVENTS_MISSING",
      count: 1
    }]);
    expect(summary.warnings.join(" ")).toMatch(/realized-close bookkeeping/i);
    expect(summary.warnings.join(" ")).toMatch(/adjusted full-session/i);
    expect(summary.warnings.join(" ")).not.toMatch(/evidence health alert/i);
  });

  it("alerts only for a completed trade opened after the v41 evidence boundary", () => {
    const evidence: StockPaperLearningV4Evidence = {
      ...emptyEvidence(1),
      exclusions: [{
        tradeId: "post-v41-trade",
        symbol: "MSFT",
        reason: "SELL_FILL_EVENTS_MISSING",
        evidenceEra: "POST_V41"
      }]
    };
    const analysis = analyzeStockPaperLearningV4({
      cutoffAt: at,
      trades: [],
      dailyReturns: [],
      config: { bootstrapReplicates: 50 }
    });

    const summary = summarizeStockPaperLearningV4({ evidence, analysis });
    expect(summary.evidenceHealth).toEqual({
      status: "POST_V41_EXCLUSIONS",
      v41EvidenceStartedAt: "2026-07-16T17:00:00.000Z",
      legacyExcludedTradeCount: 0,
      postV41ExcludedTradeCount: 1,
      postV41ExclusionReasons: [{ reason: "SELL_FILL_EVENTS_MISSING", count: 1 }]
    });
    expect(summary.warnings.join(" ")).toMatch(/evidence health alert/i);
  });

  it("never reports healthy evidence when the durable activation boundary is unavailable", () => {
    const evidence = emptyEvidence(0);
    delete evidence.v41EvidenceStartedAt;
    const analysis = analyzeStockPaperLearningV4({
      cutoffAt: at,
      trades: [],
      dailyReturns: [],
      config: { bootstrapReplicates: 50 }
    });

    const summary = summarizeStockPaperLearningV4({ evidence, analysis });
    expect(summary.evidenceHealth).toMatchObject({
      status: "ACTIVATION_UNKNOWN",
      legacyExcludedTradeCount: 0,
      postV41ExcludedTradeCount: 0
    });
    expect(summary.warnings.join(" ")).toMatch(/evidence health unknown/i);
  });

  it("binds the exact excluded trade identities into the evidence digest", () => {
    const firstEvidence = emptyEvidence(1);
    const secondEvidence: StockPaperLearningV4Evidence = {
      ...firstEvidence,
      exclusions: [{
        tradeId: "different-legacy-trade",
        symbol: "AAPL",
        reason: "BUY_FILL_EVENTS_MISSING",
        evidenceEra: "LEGACY"
      }]
    };
    const analysis = analyzeStockPaperLearningV4({
      cutoffAt: at,
      trades: [],
      dailyReturns: [],
      config: { bootstrapReplicates: 50 }
    });

    expect(summarizeStockPaperLearningV4({
      evidence: firstEvidence,
      analysis
    }).evidenceDigest).not.toBe(summarizeStockPaperLearningV4({
      evidence: secondEvidence,
      analysis
    }).evidenceDigest);
  });

  it("persists immutable artifacts and advances only a validated latest pointer", () => {
    db = openDatabase(":memory:");
    const repository = new StockPaperRepository(db);
    const lane = repository.ensureActiveLane(at);
    const evidence = emptyEvidence();
    const analysis = analyzeStockPaperLearningV4({
      cutoffAt: at,
      trades: [],
      dailyReturns: [],
      config: { bootstrapReplicates: 50 }
    });
    const summary = summarizeStockPaperLearningV4({ evidence, analysis });

    repository.commitLearningV4Summary(lane.id, summary);
    repository.commitLearningV4Summary(lane.id, summary);
    expect(repository.dashboard().learning.advancedAnalysis).toEqual(summary);
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM settings
      WHERE key LIKE 'stock_paper_learning_v4:%:artifact:%'
    `).get()).toEqual({ count: 1 });
    db.prepare(`
      UPDATE settings SET updated_at = 'idempotency-sentinel'
      WHERE key = ?
    `).run(`stock_paper_learning_v4:${lane.id}:latest`);
    repository.commitLearningV4Summary(lane.id, summary);
    expect(db.prepare(`
      SELECT updated_at FROM settings WHERE key = ?
    `).get(`stock_paper_learning_v4:${lane.id}:latest`)).toEqual({
      updated_at: "idempotency-sentinel"
    });
    expect(() => repository.commitLearningV4Summary(lane.id, {
      ...summary,
      warnings: [...summary.warnings, "different evidence"]
    })).toThrow(/collided with different analysis evidence/i);
    expect(() => repository.commitLearningV4Summary(lane.id, {
      ...summary,
      affectsTrading: true
    } as unknown as StockPaperLearningV4Summary)).toThrow(/research-only boundary/i);

    const reconfiguredAnalysis = analyzeStockPaperLearningV4({
      cutoffAt: at,
      trades: [],
      dailyReturns: [],
      config: {
        initialNavUsd: 250,
        bootstrapReplicates: 75
      }
    });
    const second = summarizeStockPaperLearningV4({
      evidence,
      analysis: reconfiguredAnalysis
    });
    expect(second.evidenceDigest).toBe(summary.evidenceDigest);
    expect(second.datasetDigest).toBe(summary.datasetDigest);
    expect(second.outputDigest).not.toBe(summary.outputDigest);
    repository.commitLearningV4Summary(lane.id, second);
    expect(repository.dashboard().learning.advancedAnalysis).toEqual(second);
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM settings
      WHERE key LIKE 'stock_paper_learning_v4:%:artifact:%'
    `).get()).toEqual({ count: 2 });
    expect(db.prepare(`
      SELECT value_json FROM settings WHERE key = ?
    `).get(`stock_paper_learning_v4:${lane.id}:latest`)).toEqual({
      value_json: JSON.stringify({ outputDigest: second.outputDigest })
    });
  });

  it("stores a future analyzer-version output from identical evidence without mutating prior artifacts", () => {
    db = openDatabase(":memory:");
    const repository = new StockPaperRepository(db);
    const lane = repository.ensureActiveLane(at);
    const evidence = emptyEvidence();
    const analysis = analyzeStockPaperLearningV4({
      cutoffAt: at,
      trades: [],
      dailyReturns: [],
      config: { bootstrapReplicates: 50 }
    });
    const original = summarizeStockPaperLearningV4({ evidence, analysis });
    repository.commitLearningV4Summary(lane.id, original);
    const originalArtifactKey =
      `stock_paper_learning_v4:${lane.id}:artifact:${original.outputDigest}`;
    const originalArtifact = db.prepare(`
      SELECT value_json FROM settings WHERE key = ?
    `).get(originalArtifactKey) as { value_json: string };

    // This extended runtime shape models a future analyzer revision before the
    // shared dashboard type is widened. The output digest is the immutable
    // identity and commits analyzer version/configuration changes.
    const upgraded = {
      ...original,
      analyzerVersion: "stock-paper-learning-v4-analysis-vNext",
      analyzerConfiguration: {
        bootstrapReplicates: 100,
        minimumCorrelationOverlapDays: 30
      },
      warnings: [...original.warnings, "future analyzer output"],
      outputDigest: "d".repeat(64)
    } as unknown as StockPaperLearningV4Summary;
    repository.commitLearningV4Summary(lane.id, upgraded);

    expect(repository.dashboard().learning.advancedAnalysis).toEqual(upgraded);
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM settings
      WHERE key LIKE 'stock_paper_learning_v4:%:artifact:%'
    `).get()).toEqual({ count: 2 });
    expect(db.prepare(`
      SELECT value_json FROM settings WHERE key = ?
    `).get(originalArtifactKey)).toEqual(originalArtifact);
    expect(db.prepare(`
      SELECT value_json FROM settings WHERE key = ?
    `).get(`stock_paper_learning_v4:${lane.id}:latest`)).toEqual({
      value_json: JSON.stringify({ outputDigest: upgraded.outputDigest })
    });

    repository.commitLearningV4Summary(lane.id, upgraded);
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM settings
      WHERE key LIKE 'stock_paper_learning_v4:%:artifact:%'
    `).get()).toEqual({ count: 2 });
    expect(() => repository.commitLearningV4Summary(lane.id, {
      ...upgraded,
      analyzerConfiguration: { bootstrapReplicates: 200 }
    } as unknown as StockPaperLearningV4Summary)).toThrow(/collided with different analysis evidence/i);
  });
});
