import {
  DEFAULT_WALLET_POLICY,
  type WalletCandidate,
  type WalletHistorySummary,
  type WalletQualificationPolicy,
  type WalletScore
} from "@copylab/shared";

export const WALLET_REASON = Object.freeze({
  MISSING_30D_PNL: "missing 30-day PnL",
  MISSING_90D_PNL: "missing 90-day PnL",
  NON_POSITIVE_30D_PNL: "30-day realized profit is not positive",
  NON_POSITIVE_90D_PNL: "90-day realized profit is not positive",
  INSUFFICIENT_HISTORY: "insufficient history",
  INSUFFICIENT_SWAPS: "insufficient closed eligible swaps",
  INSUFFICIENT_ACTIVE_WEEKS: "insufficient active weeks",
  HOLDING_TIME_TOO_SHORT: "median holding time is too short",
  TOP_TOKEN_CONCENTRATION: "largest token profit concentration is too high",
  TOP_THREE_CONCENTRATION: "top-three token profit concentration is too high",
  DISALLOWED_TAG: "wallet has a disallowed tag"
});

function normalizedTags(...tagSets: readonly (readonly string[])[]): string[] {
  return [...new Set(tagSets.flat().map((tag) => tag.trim().toLowerCase()).filter(Boolean))].sort();
}

export function qualifyWallet(
  candidate: WalletCandidate,
  history: WalletHistorySummary,
  now: Date = new Date(),
  policy: Readonly<WalletQualificationPolicy> = DEFAULT_WALLET_POLICY
): WalletScore {
  const reasons: string[] = [];

  if (!candidate.pnl30d) {
    reasons.push(WALLET_REASON.MISSING_30D_PNL);
  } else if (candidate.pnl30d.realizedProfitUsd <= 0) {
    reasons.push(WALLET_REASON.NON_POSITIVE_30D_PNL);
  }

  if (!candidate.pnl90d) {
    reasons.push(WALLET_REASON.MISSING_90D_PNL);
  } else if (candidate.pnl90d.realizedProfitUsd <= 0) {
    reasons.push(WALLET_REASON.NON_POSITIVE_90D_PNL);
  }

  if (history.historyDays < policy.minimumHistoryDays) {
    reasons.push(WALLET_REASON.INSUFFICIENT_HISTORY);
  }
  if (history.closedEligibleSwaps < policy.minimumClosedEligibleSwaps) {
    reasons.push(WALLET_REASON.INSUFFICIENT_SWAPS);
  }
  if (history.activeWeeks < policy.minimumActiveWeeks) {
    reasons.push(WALLET_REASON.INSUFFICIENT_ACTIVE_WEEKS);
  }
  if (history.medianHoldingMinutes < policy.minimumMedianHoldingMinutes) {
    reasons.push(WALLET_REASON.HOLDING_TIME_TOO_SHORT);
  }
  if (history.topTokenProfitShare > policy.maximumTopTokenProfitShare) {
    reasons.push(WALLET_REASON.TOP_TOKEN_CONCENTRATION);
  }
  if (history.topThreeProfitShare > policy.maximumTopThreeProfitShare) {
    reasons.push(WALLET_REASON.TOP_THREE_CONCENTRATION);
  }

  const tags = normalizedTags(candidate.tags, history.tags);
  const blockedTags = new Set(policy.disallowedTags.map((tag) => tag.toLowerCase()));
  const matchedBlockedTags = tags.filter((tag) => blockedTags.has(tag));
  if (matchedBlockedTags.length > 0) {
    reasons.push(`${WALLET_REASON.DISALLOWED_TAG}: ${matchedBlockedTags.join(", ")}`);
  }

  return {
    wallet: candidate.address,
    calculatedAt: now.toISOString(),
    qualified: reasons.length === 0,
    reasons,
    historyDays: history.historyDays,
    closedEligibleSwaps: history.closedEligibleSwaps,
    activeWeeks: history.activeWeeks,
    medianHoldingMinutes: history.medianHoldingMinutes,
    topTokenProfitShare: history.topTokenProfitShare,
    topThreeProfitShare: history.topThreeProfitShare
  };
}
