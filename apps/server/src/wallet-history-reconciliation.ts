import type { WalletHistorySummary, WalletIndexRecord } from "@copylab/shared";

export type WalletHistoryQualityStatus =
  | "LOCAL_UNAVAILABLE"
  | "PARTIAL"
  | "CONSISTENT"
  | "DIVERGENT";

export type WalletHistoryMetricName =
  | "historyDays"
  | "closedEligibleSwaps"
  | "activeWeeks"
  | "medianHoldingMinutes"
  | "topTokenProfitShare"
  | "topThreeProfitShare";

export interface WalletHistoryMetricTolerance {
  absolute: number;
  relative: number;
}

export type WalletHistoryReconciliationTolerances = Readonly<
  Record<WalletHistoryMetricName, Readonly<WalletHistoryMetricTolerance>>
>;

export const DEFAULT_WALLET_HISTORY_RECONCILIATION_TOLERANCES: WalletHistoryReconciliationTolerances =
  Object.freeze({
    historyDays: Object.freeze({ absolute: 7, relative: 0.1 }),
    closedEligibleSwaps: Object.freeze({ absolute: 5, relative: 0.2 }),
    activeWeeks: Object.freeze({ absolute: 1, relative: 0 }),
    medianHoldingMinutes: Object.freeze({ absolute: 5, relative: 0.25 }),
    topTokenProfitShare: Object.freeze({ absolute: 0.05, relative: 0 }),
    topThreeProfitShare: Object.freeze({ absolute: 0.05, relative: 0 })
  });

export interface WalletHistoryMetricComparison {
  metric: WalletHistoryMetricName;
  providerValue: number;
  comparable: boolean;
  tolerance: WalletHistoryMetricTolerance;
  localValue?: number;
  absoluteDifference?: number;
  relativeDifference?: number;
  allowedDifference?: number;
  withinTolerance?: boolean;
  issue?: string;
}

export interface WalletHistoryTagComparison {
  comparable: boolean;
  localTags: string[];
  providerTags: string[];
  onlyLocal: string[];
  onlyProvider: string[];
  consistent?: boolean;
}

export interface WalletHistoryReconciliationSnapshot {
  id: string;
  wallet: string;
  cohortId: string;
  comparedAt: string;
  status: WalletHistoryQualityStatus;
  comparableMetrics: number;
  mismatchMetrics: WalletHistoryMetricName[];
  unavailableMetrics: WalletHistoryMetricName[];
  agreementRate: number;
  reasons: string[];
  limitations: string[];
  comparisons: WalletHistoryMetricComparison[];
  tags: WalletHistoryTagComparison;
  providerHistory: WalletHistorySummary;
  localRecord?: WalletIndexRecord | undefined;
  localUpdatedAt?: string;
}

export interface ReconcileWalletHistoryOptions {
  wallet: string;
  cohortId: string;
  comparedAt: string;
  providerHistory: WalletHistorySummary;
  localRecord?: WalletIndexRecord | undefined;
  tolerances?: WalletHistoryReconciliationTolerances;
}

const METRICS: readonly WalletHistoryMetricName[] = [
  "historyDays",
  "closedEligibleSwaps",
  "activeWeeks",
  "medianHoldingMinutes",
  "topTokenProfitShare",
  "topThreeProfitShare"
];

function normalizeTags(tags: readonly string[] | undefined): string[] {
  return [...new Set((tags ?? []).map((tag) => tag.trim().toLowerCase()).filter(Boolean))].sort();
}

function finiteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function localMetricValue(record: WalletIndexRecord, metric: WalletHistoryMetricName): number | undefined {
  if (
    (metric === "topTokenProfitShare" || metric === "topThreeProfitShare") &&
    record.profitPricingCoverage !== "COMPLETE"
  ) return undefined;
  return record[metric];
}

function compareMetric(
  metric: WalletHistoryMetricName,
  localValue: number | undefined,
  providerValue: number,
  tolerance: Readonly<WalletHistoryMetricTolerance>
): WalletHistoryMetricComparison {
  const base = {
    metric,
    providerValue,
    comparable: localValue !== undefined,
    tolerance: { ...tolerance }
  };
  if (localValue === undefined) return base;
  if (!finiteNonNegative(localValue) || !finiteNonNegative(providerValue)) {
    return {
      ...base,
      localValue,
      comparable: true,
      withinTolerance: false,
      issue: `${metric} contains a non-finite or negative value`
    };
  }
  const absoluteDifference = Math.abs(localValue - providerValue);
  const relativeDifference = providerValue === 0
    ? (localValue === 0 ? 0 : 1)
    : absoluteDifference / Math.abs(providerValue);
  const allowedDifference = Math.max(tolerance.absolute, Math.abs(providerValue) * tolerance.relative);
  return {
    ...base,
    localValue,
    comparable: true,
    absoluteDifference,
    relativeDifference,
    allowedDifference,
    withinTolerance: absoluteDifference <= allowedDifference
  };
}

/**
 * Compares independent provider history with the local program index. The
 * output is diagnostic evidence only and is never used to modify qualification
 * inputs or policy thresholds.
 */
export function reconcileWalletHistory(
  options: ReconcileWalletHistoryOptions
): WalletHistoryReconciliationSnapshot {
  if (options.providerHistory.wallet !== options.wallet) {
    throw new Error("Provider wallet history does not match the requested wallet");
  }
  if (options.localRecord && options.localRecord.wallet !== options.wallet) {
    throw new Error("Local wallet index record does not match the requested wallet");
  }

  const id = `${options.cohortId}:${options.wallet}:${options.comparedAt}`;
  const localRecord = options.localRecord;
  if (!localRecord) {
    return {
      id,
      wallet: options.wallet,
      cohortId: options.cohortId,
      comparedAt: options.comparedAt,
      status: "LOCAL_UNAVAILABLE",
      comparableMetrics: 0,
      mismatchMetrics: [],
      unavailableMetrics: [...METRICS],
      agreementRate: 0,
      reasons: ["No local wallet aggregate was available for provider reconciliation."],
      limitations: ["All local comparison metrics and tags were unavailable."],
      comparisons: METRICS.map((metric) => ({
        metric,
        providerValue: options.providerHistory[metric],
        comparable: false,
        tolerance: { ...(options.tolerances ?? DEFAULT_WALLET_HISTORY_RECONCILIATION_TOLERANCES)[metric] }
      })),
      tags: {
        comparable: false,
        localTags: [],
        providerTags: normalizeTags(options.providerHistory.tags),
        onlyLocal: [],
        onlyProvider: normalizeTags(options.providerHistory.tags)
      },
      providerHistory: options.providerHistory
    };
  }

  const tolerances = options.tolerances ?? DEFAULT_WALLET_HISTORY_RECONCILIATION_TOLERANCES;
  const comparisons = METRICS.map((metric) =>
    compareMetric(metric, localMetricValue(localRecord, metric), options.providerHistory[metric], tolerances[metric])
  );
  const mismatchMetrics = comparisons
    .filter((comparison) => comparison.comparable && comparison.withinTolerance === false)
    .map((comparison) => comparison.metric);
  const unavailableMetrics = comparisons
    .filter((comparison) => !comparison.comparable)
    .map((comparison) => comparison.metric);
  const comparableMetrics = comparisons.filter((comparison) => comparison.comparable).length;
  const localTags = normalizeTags(localRecord.tags);
  const providerTags = normalizeTags(options.providerHistory.tags);
  const tagsComparable = localRecord.tags !== undefined;
  const onlyLocal = tagsComparable ? localTags.filter((tag) => !providerTags.includes(tag)) : [];
  const onlyProvider = tagsComparable ? providerTags.filter((tag) => !localTags.includes(tag)) : providerTags;
  const tagsConsistent = tagsComparable ? onlyLocal.length === 0 && onlyProvider.length === 0 : undefined;
  const matched = comparisons.filter((comparison) => comparison.comparable && comparison.withinTolerance).length +
    (tagsComparable && tagsConsistent ? 1 : 0);
  const comparableChecks = comparableMetrics + (tagsComparable ? 1 : 0);
  const reasons = comparisons
    .filter((comparison) => comparison.comparable && comparison.withinTolerance === false)
    .map((comparison) => comparison.issue ??
      `${comparison.metric} differs by ${comparison.absoluteDifference} (allowed ${comparison.allowedDifference}).`);
  if (tagsComparable && !tagsConsistent) {
    reasons.push(`Wallet tags differ between local and provider history.`);
  }
  const limitations: string[] = [];
  if (unavailableMetrics.length > 0) {
    limitations.push(`Local evidence was unavailable for: ${unavailableMetrics.join(", ")}.`);
  }
  if (
    unavailableMetrics.some((metric) => metric === "topTokenProfitShare" || metric === "topThreeProfitShare") &&
    localRecord.profitPricingCoverage !== "COMPLETE"
  ) {
    limitations.push(
      `Local profit concentration was not fully comparable because pricing coverage was ${localRecord.profitPricingCoverage ?? "unknown"}.`
    );
  }
  if (!tagsComparable) limitations.push("Local wallet tags were unavailable for comparison.");
  const status: WalletHistoryQualityStatus = reasons.length > 0
    ? "DIVERGENT"
    : limitations.length > 0
      ? "PARTIAL"
      : "CONSISTENT";

  return {
    id,
    wallet: options.wallet,
    cohortId: options.cohortId,
    comparedAt: options.comparedAt,
    status,
    comparableMetrics,
    mismatchMetrics,
    unavailableMetrics,
    agreementRate: comparableChecks === 0 ? 0 : matched / comparableChecks,
    reasons,
    limitations,
    comparisons,
    tags: {
      comparable: tagsComparable,
      localTags,
      providerTags,
      onlyLocal,
      onlyProvider,
      ...(tagsConsistent === undefined ? {} : { consistent: tagsConsistent })
    },
    providerHistory: options.providerHistory,
    localRecord,
    localUpdatedAt: localRecord.updatedAt
  };
}
