import type {
  ResearchPaperLeaderAccount,
  ResearchPaperPerformanceEvidence,
  ResearchPaperPerformanceEvidenceStatus,
  ResearchPaperPosition
} from "@copylab/shared";

export interface ResearchPaperExitLedgerEvidence {
  wallet: string;
  recordedClosedTradePnlUsd: number;
  proportionalExitCount: number;
  balanceReconciledTradeCount: number;
}

const ACCOUNTING_TOLERANCE_USD = 0.01;
const STALE_UNPRICED_AGE_MS = 24 * 60 * 60 * 1_000;

function average(values: readonly number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 1
    ? ordered[middle]!
    : (ordered[middle - 1]! + ordered[middle]!) / 2;
}

function evidenceStatus(input: {
  pricingComplete: boolean;
  pnlGapUsd: number;
  proportionalExitCount: number;
  balanceReconciledTradeCount: number;
}): ResearchPaperPerformanceEvidenceStatus {
  if (!input.pricingComplete) return "PRICING_INCOMPLETE";
  if (
    Math.abs(input.pnlGapUsd) > ACCOUNTING_TOLERANCE_USD ||
    input.proportionalExitCount > 0 ||
    input.balanceReconciledTradeCount > 0
  ) return "RECONCILIATION_DEPENDENT";
  return "COMPLETE";
}

/** Builds a display-only evidence view. It deliberately leaves persisted
 * accounts, events, and trades untouched. */
export function summarizeResearchPaperPerformance(input: {
  leaders: readonly ResearchPaperLeaderAccount[];
  positions: readonly ResearchPaperPosition[];
  exitLedger: readonly ResearchPaperExitLedgerEvidence[];
  capturedAt: string;
}): ResearchPaperPerformanceEvidence {
  const ledgerByWallet = new Map(input.exitLedger.map((entry) => [entry.wallet, entry]));
  const leaderEvidence = input.leaders.map((leader) => {
    const ledger = ledgerByWallet.get(leader.wallet);
    const recordedClosedTradePnlUsd = ledger?.recordedClosedTradePnlUsd ?? 0;
    const nonTradeItemizedRealizedPnlUsd = leader.realizedPnlUsd - recordedClosedTradePnlUsd;
    const proportionalExitCount = ledger?.proportionalExitCount ?? 0;
    const balanceReconciledTradeCount = ledger?.balanceReconciledTradeCount ?? 0;
    return {
      wallet: leader.wallet,
      status: evidenceStatus({
        pricingComplete: leader.pricingComplete,
        pnlGapUsd: nonTradeItemizedRealizedPnlUsd,
        proportionalExitCount,
        balanceReconciledTradeCount
      }),
      recordedClosedTradePnlUsd,
      nonTradeItemizedRealizedPnlUsd,
      proportionalExitCount,
      balanceReconciledTradeCount
    };
  });

  const accountPnl = input.leaders.map((leader) => ({
    leader,
    pnlUsd: leader.navUsd - leader.initialNavUsd
  }));
  const orderedOutliers = [...accountPnl].sort((left, right) =>
    Math.abs(right.pnlUsd) - Math.abs(left.pnlUsd) ||
    left.leader.wallet.localeCompare(right.leader.wallet)
  );
  const largestOutlier = orderedOutliers[0];
  const robustAccounts = input.leaders.length > 1 && largestOutlier
    ? input.leaders.filter((leader) => leader.wallet !== largestOutlier.leader.wallet)
    : [...input.leaders];
  const exOutlierInitialNavUsd = average(robustAccounts.map((leader) => leader.initialNavUsd));
  const exOutlierNormalizedNavUsd = average(robustAccounts.map((leader) => leader.navUsd));
  const exOutlierNormalizedPnlUsd = exOutlierNormalizedNavUsd - exOutlierInitialNavUsd;
  const pricingIncompleteAccountCount = input.leaders.filter((leader) => !leader.pricingComplete).length;
  const unpricedPositions = input.positions.filter((position) => position.status === "UNPRICED");
  const capturedAtMs = Date.parse(input.capturedAt);
  const staleUnpricedPositionCount = unpricedPositions.filter((position) =>
    Number.isFinite(capturedAtMs) &&
    Number.isFinite(Date.parse(position.openedAt)) &&
    capturedAtMs - Date.parse(position.openedAt) >= STALE_UNPRICED_AGE_MS
  ).length;
  const reconciliationDependentAccountCount = leaderEvidence.filter((entry) =>
    entry.status === "RECONCILIATION_DEPENDENT"
  ).length;
  const status: ResearchPaperPerformanceEvidenceStatus = pricingIncompleteAccountCount > 0
    ? "PRICING_INCOMPLETE"
    : reconciliationDependentAccountCount > 0
      ? "RECONCILIATION_DEPENDENT"
      : "COMPLETE";

  return {
    status,
    accountCount: input.leaders.length,
    pricingIncompleteAccountCount,
    unpricedPositionCount: unpricedPositions.length,
    staleUnpricedPositionCount,
    reconciliationDependentAccountCount,
    medianAccountPnlUsd: median(accountPnl.map(({ pnlUsd }) => pnlUsd)),
    exOutlierAccountCount: robustAccounts.length,
    exOutlierInitialNavUsd,
    exOutlierNormalizedNavUsd,
    exOutlierNormalizedPnlUsd,
    exOutlierNetReturnPercent: exOutlierInitialNavUsd > 0
      ? exOutlierNormalizedPnlUsd / exOutlierInitialNavUsd * 100
      : 0,
    ...(input.leaders.length > 1 && largestOutlier
      ? {
          largestOutlierWallet: largestOutlier.leader.wallet,
          largestOutlierPnlUsd: largestOutlier.pnlUsd
        }
      : {}),
    leaderEvidence,
    disclosure: status === "PRICING_INCOMPLETE"
      ? "At least one open position has no executable exit price. Ledger NAV is retained for audit, but the result is incomplete; use the ex-outlier diagnostic only as context."
      : status === "RECONCILIATION_DEPENDENT"
        ? "Some realized PnL came from proportional or balance-reconciled exits that legacy closed-trade rows do not fully itemize. Ledger NAV is retained for audit and is not treated as independently verified performance."
        : "Executable prices and itemized closed-trade PnL reconcile to the account ledger. The ex-outlier result remains a robustness diagnostic."
  };
}
