import { DEFAULT_RISK_POLICY, type ExecutionMode, type LeaderSwap, type PositionLot } from "@copylab/shared";

export interface OpenPositionInput {
  id: string;
  mode: ExecutionMode;
  sourceSwap: LeaderSwap;
  openedAt?: Date;
  receivedAmountAtomic: string;
  entryCostUsd: number;
  executableValueUsd?: number;
  evaluationCohortId?: string;
}

export interface ExitRequest {
  positionId: string;
  amountAtomic: string;
  fractionOfRemaining: number;
  estimatedValueUsd: number;
  forceFullExit: boolean;
}

export interface ExitPlan {
  position: PositionLot;
  request?: ExitRequest;
}

export interface ExitFillResult {
  position: PositionLot;
  costBasisReleasedUsd: number;
  realizedPnlUsd: number;
}

function checkedAtomic(value: string, label: string): bigint {
  try {
    const amount = BigInt(value);
    if (amount < 0n) throw new Error();
    return amount;
  } catch {
    throw new RangeError(`${label} must be a non-negative integer string`);
  }
}

function normalizedUsd(value: number): number {
  return Math.round(value * 1_000_000_000_000) / 1_000_000_000_000;
}

export function openPositionLot(input: OpenPositionInput): PositionLot {
  const amount = checkedAtomic(input.receivedAmountAtomic, "receivedAmountAtomic");
  if (amount <= 0n) throw new RangeError("receivedAmountAtomic must be positive");
  if (!Number.isFinite(input.entryCostUsd) || input.entryCostUsd <= 0) {
    throw new RangeError("entryCostUsd must be positive");
  }
  const openedAt = input.openedAt ?? new Date(input.sourceSwap.blockTime);
  const position: PositionLot = {
    id: input.id,
    mode: input.mode,
    sourceWallet: input.sourceSwap.sourceWallet,
    sourceEntrySignature: input.sourceSwap.sourceSignature,
    mint: input.sourceSwap.targetMint,
    openedAt: openedAt.toISOString(),
    entryAmountAtomic: amount.toString(),
    remainingAmountAtomic: amount.toString(),
    entryCostUsd: input.entryCostUsd,
    remainingCostUsd: input.entryCostUsd,
    lastExecutableValueUsd: input.executableValueUsd ?? input.entryCostUsd,
    pendingExitFraction: 0,
    status: "OPEN"
  };
  if (input.evaluationCohortId !== undefined) position.evaluationCohortId = input.evaluationCohortId;
  return position;
}

/**
 * Accumulates sub-$1 proportional exits. Fractions describe the leader's current
 * remaining position, so multiple unfilled signals compose multiplicatively.
 */
export function accrueProportionalExit(
  position: Readonly<PositionLot>,
  leaderSellFraction: number,
  executableValueUsd: number,
  minimumExitUsd: number = DEFAULT_RISK_POLICY.minimumExitUsd
): ExitPlan {
  if (position.status === "CLOSED" || position.status === "DUST") {
    throw new Error(`cannot plan an exit for a ${position.status} position`);
  }
  if (!Number.isFinite(leaderSellFraction) || leaderSellFraction <= 0 || leaderSellFraction > 1) {
    throw new RangeError("leaderSellFraction must be greater than 0 and no more than 1");
  }
  if (!Number.isFinite(executableValueUsd) || executableValueUsd < 0) {
    throw new RangeError("executableValueUsd must be non-negative");
  }

  const forceFullExit = leaderSellFraction >= 0.9;
  const rawPendingFraction = forceFullExit
    ? 1
    : 1 - (1 - Math.min(1, position.pendingExitFraction)) * (1 - leaderSellFraction);
  const pendingFraction = forceFullExit ? 1 : Math.round(rawPendingFraction * 1_000_000_000) / 1_000_000_000;
  const remainingAtomic = checkedAtomic(position.remainingAmountAtomic, "remainingAmountAtomic");
  const amountAtomic = forceFullExit
    ? remainingAtomic
    : (remainingAtomic * BigInt(Math.round(pendingFraction * 1_000_000_000))) / 1_000_000_000n;
  const estimatedValueUsd = Math.round(executableValueUsd * pendingFraction * 1_000_000_000) / 1_000_000_000;
  const shouldExecute = forceFullExit || (estimatedValueUsd >= minimumExitUsd && amountAtomic > 0n);

  const updated: PositionLot = {
    ...position,
    lastExecutableValueUsd: executableValueUsd,
    pendingExitFraction: pendingFraction,
    status: shouldExecute ? "CLOSING" : "OPEN"
  };

  if (!shouldExecute) return { position: updated };
  return {
    position: updated,
    request: {
      positionId: position.id,
      amountAtomic: amountAtomic.toString(),
      fractionOfRemaining: Number(amountAtomic) / Number(remainingAtomic),
      estimatedValueUsd,
      forceFullExit
    }
  };
}

export function applyExitFill(
  position: Readonly<PositionLot>,
  soldAmountAtomic: string,
  proceedsUsd: number,
  closedAt: Date = new Date(),
  dustThresholdUsd: number = DEFAULT_RISK_POLICY.minimumExitUsd
): ExitFillResult {
  const remainingBefore = checkedAtomic(position.remainingAmountAtomic, "remainingAmountAtomic");
  const sold = checkedAtomic(soldAmountAtomic, "soldAmountAtomic");
  if (sold <= 0n || sold > remainingBefore) {
    throw new RangeError("soldAmountAtomic must be positive and no greater than the remaining amount");
  }
  if (!Number.isFinite(proceedsUsd) || proceedsUsd < 0) throw new RangeError("proceedsUsd must be non-negative");

  const fractionSold = Number(sold) / Number(remainingBefore);
  const costBasisReleasedUsd = normalizedUsd(position.remainingCostUsd * fractionSold);
  const remainingAfter = remainingBefore - sold;
  const remainingCostUsd = normalizedUsd(Math.max(0, position.remainingCostUsd - costBasisReleasedUsd));
  const remainingValueUsd = normalizedUsd(Math.max(0, position.lastExecutableValueUsd * (1 - fractionSold)));
  const status = remainingAfter === 0n ? "CLOSED" : remainingValueUsd < dustThresholdUsd ? "DUST" : "OPEN";

  const updated: PositionLot = {
    ...position,
    remainingAmountAtomic: remainingAfter.toString(),
    remainingCostUsd,
    lastExecutableValueUsd: remainingValueUsd,
    pendingExitFraction: 0,
    status
  };
  if (status === "CLOSED") updated.closedAt = closedAt.toISOString();

  return {
    position: updated,
    costBasisReleasedUsd,
    realizedPnlUsd: normalizedUsd(proceedsUsd - costBasisReleasedUsd)
  };
}

export function shouldForcePositionExit(
  position: Readonly<PositionLot>,
  now: Date,
  tokenStillSafe: boolean,
  maximumHoldingDays: number = DEFAULT_RISK_POLICY.maximumHoldingDays,
  stopLossPercent: number = DEFAULT_RISK_POLICY.positionStopLossPercent
): { force: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const ageDays = (now.getTime() - Date.parse(position.openedAt)) / 86_400_000;
  const lossPercent =
    position.remainingCostUsd > 0
      ? Math.max(0, ((position.remainingCostUsd - position.lastExecutableValueUsd) / position.remainingCostUsd) * 100)
      : 0;
  if (lossPercent >= stopLossPercent) reasons.push(`position loss reached ${stopLossPercent}%`);
  if (ageDays >= maximumHoldingDays) reasons.push(`position age reached ${maximumHoldingDays} days`);
  if (!tokenStillSafe) reasons.push("token safety policy failed");
  return { force: reasons.length > 0, reasons };
}
