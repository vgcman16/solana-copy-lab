import type { PositionLot } from "@copylab/shared";

export interface ClosedTradeResult {
  closedAt: string;
  pnlUsd: number;
  sourceWallet: string;
  stressPnlUsd?: number;
  evaluationCohortId?: string;
}

export interface EquityPoint {
  at: string;
  navUsd: number;
}

export interface ProfitMetrics {
  netPnlUsd: number;
  netReturnPercent: number;
  grossProfitUsd: number;
  grossLossUsd: number;
  profitFactor: number;
  maxDrawdownPercent: number;
  positiveWeeks: number;
  largestTradeProfitShare: number;
  topThreeProfitShare: number;
}

export interface ExecutableNavInput {
  solReserveUsd: number;
  usdcReserveUsd: number;
  otherLiquidUsd?: number;
  positions: readonly PositionLot[];
  unsettledFeesUsd?: number;
}

function assertFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
}

export function calculateExecutableNav(input: ExecutableNavInput): number {
  assertFinite(input.solReserveUsd, "solReserveUsd");
  assertFinite(input.usdcReserveUsd, "usdcReserveUsd");
  const openPositionValue = input.positions
    .filter((position) => position.status !== "CLOSED")
    .reduce((sum, position) => sum + position.lastExecutableValueUsd, 0);
  return (
    input.solReserveUsd +
    input.usdcReserveUsd +
    (input.otherLiquidUsd ?? 0) +
    openPositionValue -
    (input.unsettledFeesUsd ?? 0)
  );
}

export function calculateProfitFactor(pnls: readonly number[]): number {
  const grossProfit = pnls.filter((pnl) => pnl > 0).reduce((sum, pnl) => sum + pnl, 0);
  const grossLoss = Math.abs(pnls.filter((pnl) => pnl < 0).reduce((sum, pnl) => sum + pnl, 0));
  if (grossLoss === 0) return grossProfit > 0 ? Number.POSITIVE_INFINITY : 0;
  return grossProfit / grossLoss;
}

export function calculateMaxDrawdownPercent(points: readonly EquityPoint[]): number {
  let peak = 0;
  let maximum = 0;
  for (const point of [...points].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
    assertFinite(point.navUsd, "equity navUsd");
    peak = Math.max(peak, point.navUsd);
    if (peak > 0) maximum = Math.max(maximum, ((peak - point.navUsd) / peak) * 100);
  }
  return maximum;
}

function utcWeekKey(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new RangeError(`invalid trade timestamp: ${value}`);
  const day = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - day);
  date.setUTCHours(0, 0, 0, 0);
  return date.toISOString().slice(0, 10);
}

export function countPositiveCalendarWeeks(trades: readonly ClosedTradeResult[]): number {
  const totals = new Map<string, number>();
  for (const trade of trades) {
    const key = utcWeekKey(trade.closedAt);
    totals.set(key, (totals.get(key) ?? 0) + trade.pnlUsd);
  }
  return [...totals.values()].filter((pnl) => pnl > 0).length;
}

export function equityFromTrades(
  initialNavUsd: number,
  startAt: string,
  trades: readonly ClosedTradeResult[],
  pnlSelector: (trade: ClosedTradeResult) => number = (trade) => trade.pnlUsd
): EquityPoint[] {
  let nav = initialNavUsd;
  const result: EquityPoint[] = [{ at: startAt, navUsd: nav }];
  for (const trade of [...trades].sort((a, b) => Date.parse(a.closedAt) - Date.parse(b.closedAt))) {
    nav += pnlSelector(trade);
    result.push({ at: trade.closedAt, navUsd: nav });
  }
  return result;
}

export function calculateProfitMetrics(
  initialNavUsd: number,
  startAt: string,
  trades: readonly ClosedTradeResult[],
  equityCurve?: readonly EquityPoint[]
): ProfitMetrics {
  if (!Number.isFinite(initialNavUsd) || initialNavUsd <= 0) {
    throw new RangeError("initialNavUsd must be positive");
  }
  const pnls = trades.map((trade) => trade.pnlUsd);
  pnls.forEach((pnl) => assertFinite(pnl, "trade pnlUsd"));
  const grossProfitUsd = pnls.filter((pnl) => pnl > 0).reduce((sum, pnl) => sum + pnl, 0);
  const grossLossUsd = Math.abs(pnls.filter((pnl) => pnl < 0).reduce((sum, pnl) => sum + pnl, 0));
  const realizedNetPnlUsd = pnls.reduce((sum, pnl) => sum + pnl, 0);
  const profitableTrades = pnls.filter((pnl) => pnl > 0).sort((a, b) => b - a);
  const curve = equityCurve ? [...equityCurve] : equityFromTrades(initialNavUsd, startAt, trades);
  const finalExecutableNavUsd = curve.length > 0
    ? [...curve].sort((left, right) => Date.parse(left.at) - Date.parse(right.at)).at(-1)?.navUsd
    : undefined;
  const netPnlUsd = equityCurve && finalExecutableNavUsd !== undefined
    ? finalExecutableNavUsd - initialNavUsd
    : realizedNetPnlUsd;
  return {
    netPnlUsd,
    netReturnPercent: (netPnlUsd / initialNavUsd) * 100,
    grossProfitUsd,
    grossLossUsd,
    profitFactor: calculateProfitFactor(pnls),
    maxDrawdownPercent: calculateMaxDrawdownPercent(curve),
    positiveWeeks: countPositiveCalendarWeeks(trades),
    largestTradeProfitShare: grossProfitUsd > 0 ? (profitableTrades[0] ?? 0) / grossProfitUsd : 0,
    topThreeProfitShare:
      grossProfitUsd > 0
        ? profitableTrades.slice(0, 3).reduce((sum, pnl) => sum + pnl, 0) / grossProfitUsd
        : 0
  };
}
