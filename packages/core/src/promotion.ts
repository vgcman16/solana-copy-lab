import { DEFAULT_RISK_POLICY, DEFAULT_WALLET_POLICY, type PromotionGate } from "@copylab/shared";
import {
  calculateMaxDrawdownPercent,
  calculateProfitFactor,
  calculateProfitMetrics,
  equityFromTrades,
  type ClosedTradeResult,
  type EquityPoint
} from "./metrics.js";

export interface PromotionInput {
  now?: Date;
  /** @deprecated Promotion uses evaluationCohortStartAt; retained for display compatibility. */
  paperStartAt?: string;
  evaluationCohortId?: string;
  evaluationCohortStartAt?: string;
  observationCoverage?: RuntimeObservationCoverage;
  executablePricingComplete?: boolean;
  initialNavUsd?: number;
  trades: readonly ClosedTradeResult[];
  equityCurve?: readonly EquityPoint[];
  stressEquityCurve?: readonly EquityPoint[];
  manualLiveOrders: number;
  manualCompletedPositions: number;
  paperExecutionShortfalls?: readonly number[];
  manualExecutionShortfalls?: readonly number[];
  manualPolicyViolations?: number;
}

export interface RuntimeObservationCoverage {
  heartbeatCount: number;
  consecutiveObservedMs: number;
  consecutiveObservedDays: number;
  largestGapMs: number;
  current: boolean;
  lastObservedAt?: string;
}

export const DEFAULT_RUNTIME_HEARTBEAT_GAP_MS = 5 * 60_000;

export const PROMOTION_REQUIREMENTS = Object.freeze({
  minimumPaperDays: 30,
  minimumCompletedExits: 50,
  minimumProfitFactor: 1.2,
  maximumDrawdownPercent: 10,
  minimumPositiveWeeks: 3,
  maximumLargestTradeProfitShare: DEFAULT_WALLET_POLICY.maximumTopTokenProfitShare,
  maximumTopThreeProfitShare: DEFAULT_WALLET_POLICY.maximumTopThreeProfitShare,
  maximumStressDrawdownPercent: 15,
  minimumQualifyingWallets: 2,
  minimumWalletExits: 10,
  minimumManualOrders: 20,
  minimumManualCompletedPositions: 5
});

export function calculateRuntimeObservationCoverage(
  cohortStartAt: string,
  heartbeatTimes: readonly string[],
  now: Date = new Date(),
  maximumGapMs: number = DEFAULT_RUNTIME_HEARTBEAT_GAP_MS
): RuntimeObservationCoverage {
  const start = Date.parse(cohortStartAt);
  const end = now.getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || maximumGapMs <= 0) {
    return {
      heartbeatCount: 0,
      consecutiveObservedMs: 0,
      consecutiveObservedDays: 0,
      largestGapMs: 0,
      current: false
    };
  }
  const times = [...new Set(
    heartbeatTimes
      .map((value) => Date.parse(value))
      .filter((value) => Number.isFinite(value) && value >= start && value <= end)
  )].sort((left, right) => left - right);
  if (times.length === 0) {
    return {
      heartbeatCount: 0,
      consecutiveObservedMs: 0,
      consecutiveObservedDays: 0,
      largestGapMs: Math.max(0, end - start),
      current: false
    };
  }

  let previous = start;
  let segmentStart = start;
  let largestGapMs = 0;
  for (const observedAt of times) {
    const gap = observedAt - previous;
    largestGapMs = Math.max(largestGapMs, gap);
    if (gap > maximumGapMs) segmentStart = observedAt;
    previous = observedAt;
  }
  const trailingGap = end - previous;
  largestGapMs = Math.max(largestGapMs, trailingGap);
  const current = trailingGap <= maximumGapMs;
  const consecutiveObservedMs = current ? Math.max(0, end - segmentStart) : 0;
  return {
    heartbeatCount: times.length,
    consecutiveObservedMs,
    consecutiveObservedDays: Math.floor(consecutiveObservedMs / 86_400_000),
    largestGapMs,
    current,
    lastObservedAt: new Date(previous).toISOString()
  };
}

function qualifyingWalletCount(trades: readonly ClosedTradeResult[]): number {
  const perWallet = new Map<string, number[]>();
  for (const trade of trades) {
    const values = perWallet.get(trade.sourceWallet) ?? [];
    values.push(trade.pnlUsd);
    perWallet.set(trade.sourceWallet, values);
  }
  return [...perWallet.values()].filter(
    (pnls) =>
      pnls.length >= PROMOTION_REQUIREMENTS.minimumWalletExits &&
      pnls.reduce((sum, pnl) => sum + pnl, 0) > 0 &&
      calculateProfitFactor(pnls) >= PROMOTION_REQUIREMENTS.minimumProfitFactor
  ).length;
}

function percentile95(values: readonly number[]): number {
  const finite = values.filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  if (finite.length === 0) return 0;
  return finite[Math.max(0, Math.ceil(finite.length * 0.95) - 1)] ?? 0;
}

export function calculatePromotionGate(input: PromotionInput): PromotionGate {
  const now = input.now ?? new Date();
  const initialNavUsd = input.initialNavUsd ?? DEFAULT_RISK_POLICY.initialNavUsd;
  const evaluationStartAt = input.evaluationCohortStartAt ?? input.paperStartAt ?? now.toISOString();
  const metrics = calculateProfitMetrics(initialNavUsd, evaluationStartAt, input.trades, input.equityCurve);
  const elapsed = input.observationCoverage?.consecutiveObservedDays ?? 0;
  const perTradeStressComplete =
    input.trades.length > 0 && input.trades.every((trade) => trade.stressPnlUsd !== undefined);
  const curveStressComplete = input.stressEquityCurve !== undefined && input.stressEquityCurve.length > 0;
  const stressComplete = perTradeStressComplete || curveStressComplete;
  const sortedStressCurve = input.stressEquityCurve
    ? [...input.stressEquityCurve].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    : undefined;
  const stressPnl = perTradeStressComplete
    ? input.trades.reduce((sum, trade) => sum + (trade.stressPnlUsd ?? 0), 0)
    : curveStressComplete
      ? (sortedStressCurve?.at(-1)?.navUsd ?? initialNavUsd) - initialNavUsd
      : 0;
  const stressCurve =
    sortedStressCurve ??
    (perTradeStressComplete
      ? equityFromTrades(initialNavUsd, evaluationStartAt, input.trades, (trade) => trade.stressPnlUsd ?? 0)
      : [{ at: evaluationStartAt, navUsd: initialNavUsd }]);
  const stressNetReturnPercent = (stressPnl / initialNavUsd) * 100;
  const stressMaxDrawdownPercent = calculateMaxDrawdownPercent(stressCurve);
  const qualifyingWallets = qualifyingWalletCount(input.trades);
  const paperBlockers: string[] = [];

  if (!input.evaluationCohortId || !input.evaluationCohortStartAt) {
    paperBlockers.push("a frozen forward paper cohort is unavailable");
  }
  if (!input.observationCoverage) {
    paperBlockers.push("runtime observation coverage is unavailable");
  } else if (!input.observationCoverage.current) {
    paperBlockers.push("runtime observation heartbeat is stale");
  }
  if (elapsed < PROMOTION_REQUIREMENTS.minimumPaperDays) {
    paperBlockers.push("fewer than 30 consecutive observed paper days");
  }
  if (!input.equityCurve || input.equityCurve.length === 0) {
    paperBlockers.push("executable NAV history is unavailable");
  }
  if (input.executablePricingComplete !== true) {
    paperBlockers.push("open exposure is missing a current executable price");
  }
  if (input.trades.length < PROMOTION_REQUIREMENTS.minimumCompletedExits) {
    paperBlockers.push("fewer than 50 paper exits are complete");
  }
  if (metrics.netReturnPercent <= 0) paperBlockers.push("paper net return is not positive");
  if (metrics.profitFactor < PROMOTION_REQUIREMENTS.minimumProfitFactor) {
    paperBlockers.push("paper profit factor is below 1.2");
  }
  if (metrics.maxDrawdownPercent > PROMOTION_REQUIREMENTS.maximumDrawdownPercent) {
    paperBlockers.push("paper maximum drawdown is above 10%");
  }
  if (metrics.positiveWeeks < PROMOTION_REQUIREMENTS.minimumPositiveWeeks) {
    paperBlockers.push("fewer than three profitable calendar weeks");
  }
  if (metrics.largestTradeProfitShare > PROMOTION_REQUIREMENTS.maximumLargestTradeProfitShare) {
    paperBlockers.push("one trade supplies more than 35% of gross profit");
  }
  if (metrics.topThreeProfitShare > PROMOTION_REQUIREMENTS.maximumTopThreeProfitShare) {
    paperBlockers.push("the top three trades supply more than 60% of gross profit");
  }
  if (!stressComplete) paperBlockers.push("stress replay is incomplete");
  if (stressNetReturnPercent < 0) paperBlockers.push("stress replay return is negative");
  if (stressMaxDrawdownPercent > PROMOTION_REQUIREMENTS.maximumStressDrawdownPercent) {
    paperBlockers.push("stress replay drawdown is above 15%");
  }
  if (qualifyingWallets < PROMOTION_REQUIREMENTS.minimumQualifyingWallets) {
    paperBlockers.push("fewer than two wallets pass forward paper requirements");
  }

  const paperPassed = paperBlockers.length === 0;
  const manualBlockers: string[] = [];
  const paperShortfallP95Percent = percentile95(input.paperExecutionShortfalls ?? []);
  const manualShortfalls = (input.manualExecutionShortfalls ?? []).filter(
    (value) => Number.isFinite(value) && value >= 0
  );
  const manualWorstShortfallPercent = Math.max(0, ...manualShortfalls);
  const manualPolicyViolations = Math.max(0, input.manualPolicyViolations ?? 0);
  if (!paperPassed) manualBlockers.push("paper promotion gate has not passed");
  if (input.manualLiveOrders < PROMOTION_REQUIREMENTS.minimumManualOrders) {
    manualBlockers.push("fewer than 20 manually approved live orders");
  }
  if (input.manualCompletedPositions < PROMOTION_REQUIREMENTS.minimumManualCompletedPositions) {
    manualBlockers.push("fewer than five manual-live positions are complete");
  }
  if (input.manualLiveOrders >= PROMOTION_REQUIREMENTS.minimumManualOrders) {
    if ((input.paperExecutionShortfalls?.length ?? 0) === 0) {
      manualBlockers.push("paper execution-shortfall baseline is unavailable");
    }
    if (manualShortfalls.length < input.manualLiveOrders) {
      manualBlockers.push("manual-live execution-shortfall evidence is incomplete");
    }
  }
  if (manualWorstShortfallPercent > paperShortfallP95Percent) {
    manualBlockers.push("manual-live execution shortfall exceeds the paper 95th percentile");
  }
  if (manualPolicyViolations > 0) manualBlockers.push("a manual-live policy violation was recorded");
  const manualLivePassed = manualBlockers.length === 0;

  const result: PromotionGate = {
    evaluatedAt: now.toISOString(),
    ...(input.evaluationCohortId ? { evaluationCohortId: input.evaluationCohortId } : {}),
    ...(input.evaluationCohortStartAt
      ? { evaluationCohortStartAt: input.evaluationCohortStartAt, paperStartAt: input.evaluationCohortStartAt }
      : {}),
    observationDays: elapsed,
    largestObservationGapSeconds: (input.observationCoverage?.largestGapMs ?? 0) / 1_000,
    observationCurrent: input.observationCoverage?.current ?? false,
    executablePricingComplete: input.executablePricingComplete === true,
    elapsedDays: elapsed,
    completedExits: input.trades.length,
    netReturnPercent: metrics.netReturnPercent,
    profitFactor: metrics.profitFactor,
    maxDrawdownPercent: metrics.maxDrawdownPercent,
    positiveWeeks: metrics.positiveWeeks,
    largestTradeProfitShare: metrics.largestTradeProfitShare,
    topThreeProfitShare: metrics.topThreeProfitShare,
    stressNetReturnPercent,
    stressMaxDrawdownPercent,
    qualifyingWallets,
    manualLiveOrders: input.manualLiveOrders,
    manualCompletedPositions: input.manualCompletedPositions,
    paperShortfallP95Percent,
    manualWorstShortfallPercent,
    manualPolicyViolations,
    paperPassed,
    manualLivePassed,
    blockers: [...paperBlockers, ...manualBlockers]
  };
  return result;
}
