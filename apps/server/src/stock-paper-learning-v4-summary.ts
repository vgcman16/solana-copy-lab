import { createHash } from "node:crypto";
import type { StockPaperLearningV4Summary } from "@copylab/shared";
import type { StockPaperLearningAnalysisV4 } from "./stock-paper-learning-v4.js";
import type { StockPaperLearningV4Evidence } from "./stock-paper-learning-v4-evidence.js";

const MINIMUM_ANALYSIS_TRADES = 30;
const MINIMUM_ACTIVE_TRADE_DAYS = 20;
const MINIMUM_SPY_HISTORY_DAYS = 20;

function exclusionReasons(exclusions: StockPaperLearningV4Evidence["exclusions"]): Array<{
  reason: string;
  count: number;
}> {
  const counts = new Map<string, number>();
  for (const exclusion of exclusions) {
    counts.set(exclusion.reason, (counts.get(exclusion.reason) ?? 0) + 1);
  }
  return [...counts].map(([reason, count]) => ({ reason, count })).sort((left, right) =>
    right.count - left.count || left.reason.localeCompare(right.reason)
  );
}

function status(
  evidence: StockPaperLearningV4Evidence,
  analysis: StockPaperLearningAnalysisV4
): StockPaperLearningV4Summary["status"] {
  if (evidence.analysisTradeCount === 0) return "COLLECTING_V41_EVIDENCE";
  if (evidence.analysisTradeCount < MINIMUM_ANALYSIS_TRADES ||
      analysis.diagnostics.uniqueTradeDays < MINIMUM_ACTIVE_TRADE_DAYS ||
      analysis.diagnostics.spyHistoryDays < MINIMUM_SPY_HISTORY_DAYS ||
      analysis.correlations.pairCoveragePercent < 80) {
    return "INSUFFICIENT_EVIDENCE";
  }
  return "ANALYSIS_READY";
}

/** Compact, immutable dashboard projection. The projection preserves the
 * analysis-only boundary and never exposes a policy, order, size, threshold,
 * or promotion action. */
export function summarizeStockPaperLearningV4(input: {
  evidence: StockPaperLearningV4Evidence;
  analysis: StockPaperLearningAnalysisV4;
}): StockPaperLearningV4Summary {
  const { evidence, analysis } = input;
  const groupedExclusions = exclusionReasons(evidence.exclusions);
  const postV41Exclusions = evidence.exclusions.filter((exclusion) =>
    exclusion.evidenceEra === "POST_V41"
  );
  const postV41ExclusionReasons = exclusionReasons(postV41Exclusions);
  const legacyExcludedTradeCount = evidence.exclusions.length - postV41Exclusions.length;
  const evidenceDigest = createHash("sha256").update(JSON.stringify({
    sourceTradeCount: evidence.sourceTradeCount,
    analysisTradeIds: evidence.trades.map((trade) => trade.id).sort(),
    exclusions: evidence.exclusions
      .map((exclusion) => ({
        tradeId: exclusion.tradeId,
        symbol: exclusion.symbol,
        reason: exclusion.reason,
        evidenceEra: exclusion.evidenceEra
      }))
      .sort((left, right) =>
        left.tradeId.localeCompare(right.tradeId) ||
        left.symbol.localeCompare(right.symbol) ||
        left.reason.localeCompare(right.reason)
      ),
    exclusionReasons: groupedExclusions,
    datasetDigest: analysis.datasetDigest
  })).digest("hex");
  const warnings = [...analysis.diagnostics.warnings];
  if (legacyExcludedTradeCount > 0) {
    warnings.push(
      `${legacyExcludedTradeCount} legacy completed trades predate complete immutable v41 fill evidence and remain intentionally excluded.`
    );
  }
  if (!evidence.v41EvidenceStartedAt) {
    warnings.push(
      "EVIDENCE HEALTH UNKNOWN: the durable v41 activation boundary is unavailable, so exclusion eras cannot be trusted."
    );
  }
  if (postV41Exclusions.length > 0) {
    warnings.push(
      `EVIDENCE HEALTH ALERT: ${postV41Exclusions.length} completed post-v41 trades were excluded from learning analysis.`
    );
  }
  if (analysis.diagnostics.spyHistoryDays < MINIMUM_SPY_HISTORY_DAYS) {
    warnings.push(
      "Adjusted full-session daily return context is not yet available; regime and correlation diagnostics remain incomplete."
    );
  }
  return {
    version: analysis.version,
    status: status(evidence, analysis),
    analysisOnly: true,
    affectsTrading: false,
    promotionEligible: false,
    portfolioCounterfactual: false,
    cutoffAt: analysis.cutoffAt,
    evidenceDigest,
    datasetDigest: analysis.datasetDigest,
    outputDigest: analysis.outputDigest,
    provenance: {
      datasetSchemaVersion: analysis.provenance.datasetSchemaVersion,
      sourceLaneId: analysis.provenance.sourceLaneId,
      policyVersion: analysis.provenance.policyVersion,
      featureVersion: analysis.provenance.featureVersion,
      executionVersion: analysis.provenance.executionVersion,
      adjustedRegularSessionReturnsOnly: true,
      cutoffIndependentDatasetSeed: true
    },
    sourceTradeCount: evidence.sourceTradeCount,
    analyzedTradeCount: evidence.analysisTradeCount,
    excludedTradeCount: evidence.exclusions.length,
    exclusionReasons: groupedExclusions,
    evidenceHealth: {
      status: !evidence.v41EvidenceStartedAt
        ? "ACTIVATION_UNKNOWN"
        : postV41Exclusions.length > 0 ? "POST_V41_EXCLUSIONS" : "HEALTHY",
      ...(evidence.v41EvidenceStartedAt
        ? { v41EvidenceStartedAt: evidence.v41EvidenceStartedAt }
        : {}),
      legacyExcludedTradeCount,
      postV41ExcludedTradeCount: postV41Exclusions.length,
      postV41ExclusionReasons
    },
    uniqueSymbols: analysis.diagnostics.uniqueSymbols,
    uniqueTradeDays: analysis.diagnostics.uniqueTradeDays,
    dailyReturnSymbols: analysis.diagnostics.dailyReturnSymbols,
    spyHistoryDays: analysis.diagnostics.spyHistoryDays,
    replay: {
      realizedPathOnly: true,
      portfolioCounterfactual: false,
      fixedHistoricalNotionals: true,
      initialNavUsd: analysis.replay.initialNavUsd,
      endingNavUsd: analysis.replay.endingNavUsd,
      totalPnlUsd: analysis.replay.totalPnlUsd,
      returnPercent: analysis.replay.returnPercent,
      maximumDrawdownPercent: analysis.replay.maximumDrawdownPercent,
      maximumConcurrentPositions: analysis.replay.maximumConcurrentPositions,
      maximumGrossExposureUsd: analysis.replay.maximumGrossExposureUsd
    },
    spyExcess: {
      tradeCount: analysis.spyExcess.tradeCount,
      excessPnlUsd: analysis.spyExcess.excessPnlUsd,
      notionalWeightedExcessReturnPercent:
        analysis.spyExcess.notionalWeightedExcessReturnPercent,
      excessWinRatePercent: analysis.spyExcess.excessWinRatePercent
    },
    bootstrap: {
      fixedHistoricalNotionals: true,
      activeTradeDays: analysis.bootstrap.activeTradeDays,
      returnPercentP05: analysis.bootstrap.returnPercentP05,
      returnPercentP50: analysis.bootstrap.returnPercentP50,
      returnPercentP95: analysis.bootstrap.returnPercentP95,
      excessReturnPercentP05: analysis.bootstrap.excessReturnPercentP05,
      excessReturnPercentP50: analysis.bootstrap.excessReturnPercentP50,
      excessReturnPercentP95: analysis.bootstrap.excessReturnPercentP95,
      probabilityPositiveReturnPercent: analysis.bootstrap.probabilityPositiveReturnPercent,
      probabilityPositiveExcessPercent: analysis.bootstrap.probabilityPositiveExcessPercent
    },
    drift: {
      status: analysis.drift.status,
      earlyDayCount: analysis.drift.earlyDayCount,
      recentDayCount: analysis.drift.recentDayCount,
      spyExcessDeltaPercent: analysis.drift.spyExcessDeltaPercent,
      symbolMixJensenShannonDivergence:
        analysis.drift.symbolMixJensenShannonDivergence
    },
    correlations: {
      pairCoveragePercent: analysis.correlations.pairCoveragePercent,
      concurrentPairCount: analysis.correlations.concurrentPairCount,
      concurrentPairUnavailableCount:
        analysis.correlations.concurrentPairUnavailableCount,
      ...(analysis.correlations.concurrentExposureWeightedCorrelation !== undefined
        ? {
            concurrentExposureWeightedCorrelation:
              analysis.correlations.concurrentExposureWeightedCorrelation
          }
        : {}),
      ...(analysis.correlations.highestPositivePair?.correlation !== undefined
        ? {
            highestPositivePair: {
              leftSymbol: analysis.correlations.highestPositivePair.leftSymbol,
              rightSymbol: analysis.correlations.highestPositivePair.rightSymbol,
              overlapDays: analysis.correlations.highestPositivePair.overlapDays,
              correlation: analysis.correlations.highestPositivePair.correlation
            }
          }
        : {})
    },
    regimePerformance: analysis.regimePerformance.map((performance) => ({
      regime: performance.regime,
      tradeCount: performance.tradeCount,
      pnlUsd: performance.pnlUsd,
      meanSpyExcessPercent: performance.meanSpyExcessPercent
    })),
    sectorPerformance: analysis.sectorPerformance.map((performance) => ({
      sector: performance.sector,
      tradeCount: performance.tradeCount,
      pnlUsd: performance.pnlUsd,
      absolutePnlSharePercent: performance.absolutePnlSharePercent,
      meanSpyExcessPercent: performance.meanSpyExcessPercent
    })),
    warnings: [...new Set(warnings)]
  };
}
