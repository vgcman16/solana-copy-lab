import {
  DEFAULT_RISK_POLICY,
  type ExecutionRecord,
  type PortfolioSnapshot,
  type ProviderHealth,
  type QuoteSnapshot,
  type RiskPolicy
} from "@copylab/shared";

export type StopAction = "NONE" | "PAUSE_NEW_ENTRIES" | "LOCK_AND_LIQUIDATE";

export type StopReason =
  | "DAILY_LOSS"
  | "LIVE_START_LOSS"
  | "PEAK_DRAWDOWN"
  | "HELIUS_OUTAGE"
  | "STALE_QUOTE"
  | "BALANCE_MISMATCH"
  | "REPEATED_EXECUTION_FAILURES";

export interface OperationalStopInput {
  now?: Date;
  portfolio: PortfolioSnapshot;
  liveStartNavUsd?: number;
  providerHealth: readonly ProviderHealth[];
  heliusUnhealthySince?: string;
  latestQuote?: QuoteSnapshot;
  recentExecutions: readonly ExecutionRecord[];
}

export interface StopEvaluation {
  action: StopAction;
  reasons: StopReason[];
  pauseNewEntries: boolean;
  cancelQueuedEntries: boolean;
  liquidateBotPositions: boolean;
  lockLiveMode: boolean;
  dailyLossPercent: number;
  drawdownPercent: number;
  liveStartLossUsd: number;
  liveStartLossPercent: number;
  liveStartLossLimitUsd: number;
}

function percentLoss(start: number, current: number): number {
  return start > 0 ? Math.max(0, ((start - current) / start) * 100) : 0;
}

function reachesThreshold(value: number, threshold: number): boolean {
  const tolerance = Math.max(1, Math.abs(threshold)) * 1e-12;
  return value >= threshold - tolerance;
}

function secondsSince(value: string, now: Date): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? (now.getTime() - parsed) / 1_000 : Infinity;
}

export function evaluateOperationalStops(
  input: OperationalStopInput,
  policy: Readonly<RiskPolicy> = DEFAULT_RISK_POLICY
): StopEvaluation {
  const now = input.now ?? new Date();
  const reasons: StopReason[] = [];
  const dailyLossPercent = percentLoss(input.portfolio.dayStartNavUsd, input.portfolio.navUsd);
  const drawdownPercent = percentLoss(input.portfolio.peakNavUsd, input.portfolio.navUsd);
  const liveStartLossUsd =
    input.liveStartNavUsd === undefined ? 0 : Math.max(0, input.liveStartNavUsd - input.portfolio.navUsd);
  const liveStartLossPercent =
    input.liveStartNavUsd === undefined ? 0 : percentLoss(input.liveStartNavUsd, input.portfolio.navUsd);
  const liveStartLossLimitUsd =
    input.liveStartNavUsd === undefined
      ? 0
      : input.liveStartNavUsd * (policy.hardLiveStartLossPercent / 100);
  const isLive = input.portfolio.mode === "LIVE";

  if (reachesThreshold(dailyLossPercent, policy.dailyLossPausePercent)) reasons.push("DAILY_LOSS");
  if (isLive && reachesThreshold(liveStartLossPercent, policy.hardLiveStartLossPercent)) {
    reasons.push("LIVE_START_LOSS");
  }
  if (isLive && reachesThreshold(drawdownPercent, policy.hardDrawdownPercent)) reasons.push("PEAK_DRAWDOWN");

  const helius = input.providerHealth.find((health) => health.provider === "helius");
  if (helius && !helius.ok) {
    const unhealthySince = input.heliusUnhealthySince ?? helius.checkedAt;
    if (secondsSince(unhealthySince, now) > 60) reasons.push("HELIUS_OUTAGE");
  }

  if (input.latestQuote) {
    const staleByAge = secondsSince(input.latestQuote.quotedAt, now) > policy.maximumQuoteAgeSeconds;
    const expiresAt = input.latestQuote.expiresAt ? Date.parse(input.latestQuote.expiresAt) : undefined;
    const staleByExpiry =
      expiresAt !== undefined && (!Number.isFinite(expiresAt) || expiresAt <= now.getTime());
    if (staleByAge || staleByExpiry) reasons.push("STALE_QUOTE");
  }
  if (input.portfolio.balanceMismatchPercent > 1) reasons.push("BALANCE_MISMATCH");

  const tenMinutesAgo = now.getTime() - 10 * 60 * 1_000;
  const recentFailures = input.recentExecutions.filter(
    (record) => {
      const updatedAt = Date.parse(record.updatedAt);
      return record.status === "FAILED" && updatedAt >= tenMinutesAgo && updatedAt <= now.getTime();
    }
  ).length;
  if (recentFailures >= 3) reasons.push("REPEATED_EXECUTION_FAILURES");

  const hardStop = reasons.includes("LIVE_START_LOSS") || reasons.includes("PEAK_DRAWDOWN");
  const pause = reasons.length > 0;
  return {
    action: hardStop ? "LOCK_AND_LIQUIDATE" : pause ? "PAUSE_NEW_ENTRIES" : "NONE",
    reasons,
    pauseNewEntries: pause,
    cancelQueuedEntries: hardStop,
    liquidateBotPositions: hardStop,
    lockLiveMode: hardStop,
    dailyLossPercent,
    drawdownPercent,
    liveStartLossUsd,
    liveStartLossPercent,
    liveStartLossLimitUsd
  };
}
