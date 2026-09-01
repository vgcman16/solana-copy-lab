import type { AlpacaStockBar } from "@copylab/providers";

export const STOCK_PAPER_EXECUTION_MODEL_V3 = "stock-paper-execution-v3" as const;

export type StockPaperOrderSideV3 = "BUY" | "SELL";

export type StockPaperOrderStatusV3 =
  | "SUBMITTED"
  | "PARTIAL"
  | "FILLED"
  | "CANCELED"
  | "EXPIRED"
  | "REJECTED";

export interface StockPaperLimitOrderSubmissionV3 {
  id: string;
  symbol: string;
  side: StockPaperOrderSideV3;
  limitPriceUsd: number;
  quantity: number;
  submittedAt: string;
  expiresAt: string;
}

/**
 * A local, deterministic PAPER order. It deliberately carries no broker,
 * signer, account, approval, or promotion identity.
 */
export interface StockPaperLimitOrderV3 extends StockPaperLimitOrderSubmissionV3 {
  modelVersion: typeof STOCK_PAPER_EXECUTION_MODEL_V3;
  status: StockPaperOrderStatusV3;
  filledQuantity: number;
  averageFillPriceUsd?: number;
  /** The first one-minute bar whose full path occurred after submission. */
  firstEligibleBarAt?: string;
  lastEvaluatedBarAt?: string;
  terminalReason?: string;
  updatedAt: string;
}

export interface StockPaperFillV3 {
  orderId: string;
  symbol: string;
  side: StockPaperOrderSideV3;
  quantity: number;
  priceUsd: number;
  notionalUsd: number;
  /** Start timestamp of the causal one-minute evidence bar. */
  barTimestamp: string;
}

export type StockPaperOrderResolutionReasonV3 =
  | "FILLED"
  | "PARTIAL_FILL"
  | "LIMIT_NOT_TOUCHED"
  | "NO_PARTICIPATING_VOLUME"
  | "BAR_BEFORE_ELIGIBLE_BOUNDARY"
  | "BAR_ALREADY_EVALUATED"
  | "ORDER_EXPIRED"
  | "ORDER_TERMINAL"
  | "INVALID_BAR";

export interface StockPaperOrderResolutionV3 {
  order: StockPaperLimitOrderV3;
  reason: StockPaperOrderResolutionReasonV3;
  fill?: StockPaperFillV3;
}

export interface ResolveStockPaperLimitOrderV3Input {
  order: StockPaperLimitOrderV3;
  bar: AlpacaStockBar;
  /** Maximum share of the evidence bar's reported volume available to this
   * simulated order. Defaults to a conservative 2%. */
  participationRate?: number;
  /** A PAPER liquidation already triggered by the strategy is marketable on
   * the next causal bar rather than conditional on its recorded reference
   * limit. This never routes an order to a broker. */
  marketable?: boolean;
  /** Conservative executable price supplied by the caller after applying its
   * spread/impact model. Valid only for a marketable PAPER liquidation. */
  marketableFillPriceUsd?: number;
}

export type StockPaperProtectiveExitReasonV3 = "STOP_LOSS" | "TAKE_PROFIT";

export interface StockPaperProtectiveExitV3 {
  reason: StockPaperProtectiveExitReasonV3;
  triggerPriceUsd: number;
  fillPriceUsd: number;
  barTimestamp: string;
  /** True when both stop and target were touched and the conservative stop
   * outcome was deliberately selected. */
  sameBarCollision: boolean;
  gapThrough: boolean;
}

const MINUTE_MS = 60_000;
const DEFAULT_PARTICIPATION_RATE = 0.02;
const QUANTITY_EPSILON = 1e-10;

function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function terminal(status: StockPaperOrderStatusV3): boolean {
  return status === "FILLED" ||
    status === "CANCELED" ||
    status === "EXPIRED" ||
    status === "REJECTED";
}

function validBar(bar: AlpacaStockBar): boolean {
  const timestamp = Date.parse(bar.timestamp);
  return Number.isFinite(timestamp) &&
    finitePositive(bar.open) &&
    finitePositive(bar.high) &&
    finitePositive(bar.low) &&
    finitePositive(bar.close) &&
    bar.high >= Math.max(bar.open, bar.low, bar.close) &&
    bar.low <= Math.min(bar.open, bar.high, bar.close) &&
    Number.isFinite(bar.volume) &&
    bar.volume >= 0;
}

/**
 * Returns the start of the first complete minute strictly after submission.
 * An order submitted exactly at 10:00:00 cannot use the 10:00 bar because its
 * eventual high/low was not known causally at submission time; 10:01 is first.
 */
export function firstEligibleStockPaperBarAtV3(submittedAt: string): string | undefined {
  const submittedMs = Date.parse(submittedAt);
  if (!Number.isFinite(submittedMs)) return undefined;
  return new Date(Math.floor(submittedMs / MINUTE_MS) * MINUTE_MS + MINUTE_MS).toISOString();
}

export function submitStockPaperLimitOrderV3(
  input: StockPaperLimitOrderSubmissionV3
): StockPaperLimitOrderV3 {
  const firstEligibleBarAt = firstEligibleStockPaperBarAtV3(input.submittedAt);
  const expiresMs = Date.parse(input.expiresAt);
  const rejectionReasons: string[] = [];
  if (!input.id.trim()) rejectionReasons.push("Order id is required.");
  if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(input.symbol.trim().toUpperCase())) {
    rejectionReasons.push("Stock symbol is invalid.");
  }
  if (!finitePositive(input.limitPriceUsd)) rejectionReasons.push("Limit price must be positive.");
  if (!finitePositive(input.quantity)) rejectionReasons.push("Quantity must be positive.");
  if (!firstEligibleBarAt) rejectionReasons.push("Submission timestamp is invalid.");
  if (!Number.isFinite(expiresMs)) rejectionReasons.push("Expiry timestamp is invalid.");
  if (firstEligibleBarAt && Number.isFinite(expiresMs) && expiresMs <= Date.parse(firstEligibleBarAt)) {
    rejectionReasons.push("Expiry must leave at least one strictly post-submission bar eligible.");
  }

  const rejected = rejectionReasons.length > 0;
  return {
    ...input,
    symbol: input.symbol.trim().toUpperCase(),
    modelVersion: STOCK_PAPER_EXECUTION_MODEL_V3,
    status: rejected ? "REJECTED" : "SUBMITTED",
    filledQuantity: 0,
    ...(firstEligibleBarAt ? { firstEligibleBarAt } : {}),
    ...(rejected ? { terminalReason: rejectionReasons.join(" ") } : {}),
    updatedAt: input.submittedAt
  };
}

export function cancelStockPaperLimitOrderV3(
  order: StockPaperLimitOrderV3,
  canceledAt: string,
  reason = "Canceled by the PAPER execution policy."
): StockPaperLimitOrderV3 {
  if (terminal(order.status)) return order;
  return {
    ...order,
    status: "CANCELED",
    terminalReason: reason,
    updatedAt: canceledAt
  };
}

export function rejectStockPaperLimitOrderV3(
  order: StockPaperLimitOrderV3,
  rejectedAt: string,
  reason: string
): StockPaperLimitOrderV3 {
  if (terminal(order.status)) return order;
  return {
    ...order,
    status: "REJECTED",
    terminalReason: reason,
    updatedAt: rejectedAt
  };
}

export function expireStockPaperLimitOrderV3(
  order: StockPaperLimitOrderV3,
  observedAt: string
): StockPaperLimitOrderV3 {
  if (terminal(order.status)) return order;
  const observedMs = Date.parse(observedAt);
  const expiresMs = Date.parse(order.expiresAt);
  if (!Number.isFinite(observedMs) || !Number.isFinite(expiresMs) || observedMs < expiresMs) {
    return order;
  }
  return {
    ...order,
    status: "EXPIRED",
    terminalReason: order.filledQuantity > 0
      ? "The unfilled remainder expired."
      : "The order expired without a fill.",
    updatedAt: observedAt
  };
}

function limitTouched(order: StockPaperLimitOrderV3, bar: AlpacaStockBar): boolean {
  return order.side === "BUY"
    ? bar.low <= order.limitPriceUsd
    : bar.high >= order.limitPriceUsd;
}

function limitFillPrice(order: StockPaperLimitOrderV3, bar: AlpacaStockBar): number {
  if (order.side === "BUY") {
    return bar.open <= order.limitPriceUsd ? bar.open : order.limitPriceUsd;
  }
  return bar.open >= order.limitPriceUsd ? bar.open : order.limitPriceUsd;
}

/** Resolves at most one fill against one completed minute bar. */
export function resolveStockPaperLimitOrderV3(
  input: ResolveStockPaperLimitOrderV3Input
): StockPaperOrderResolutionV3 {
  const { order, bar } = input;
  if (terminal(order.status)) return { order, reason: "ORDER_TERMINAL" };
  if (!validBar(bar)) return { order, reason: "INVALID_BAR" };
  const barMs = Date.parse(bar.timestamp);
  const eligibleMs = Date.parse(order.firstEligibleBarAt ?? "");
  if (!Number.isFinite(eligibleMs) || barMs < eligibleMs) {
    return { order, reason: "BAR_BEFORE_ELIGIBLE_BOUNDARY" };
  }
  if (order.lastEvaluatedBarAt && barMs <= Date.parse(order.lastEvaluatedBarAt)) {
    return { order, reason: "BAR_ALREADY_EVALUATED" };
  }
  if (barMs >= Date.parse(order.expiresAt)) {
    return {
      order: expireStockPaperLimitOrderV3(order, bar.timestamp),
      reason: "ORDER_EXPIRED"
    };
  }

  const evaluatedOrder: StockPaperLimitOrderV3 = {
    ...order,
    lastEvaluatedBarAt: bar.timestamp,
    updatedAt: bar.timestamp
  };
  if (!input.marketable && !limitTouched(order, bar)) {
    return { order: evaluatedOrder, reason: "LIMIT_NOT_TOUCHED" };
  }

  const participationRate = input.participationRate ?? DEFAULT_PARTICIPATION_RATE;
  const boundedParticipationRate = Number.isFinite(participationRate)
    ? Math.max(0, Math.min(1, participationRate))
    : 0;
  const remainingQuantity = Math.max(0, order.quantity - order.filledQuantity);
  const fillQuantity = Math.min(remainingQuantity, bar.volume * boundedParticipationRate);
  if (fillQuantity <= QUANTITY_EPSILON) {
    return { order: evaluatedOrder, reason: "NO_PARTICIPATING_VOLUME" };
  }

  const marketablePrice = input.marketableFillPriceUsd;
  if (input.marketable && marketablePrice !== undefined && !finitePositive(marketablePrice)) {
    return { order: evaluatedOrder, reason: "INVALID_BAR" };
  }
  const priceUsd = input.marketable
    ? marketablePrice ?? bar.open
    : limitFillPrice(order, bar);
  const priorNotional = (order.averageFillPriceUsd ?? 0) * order.filledQuantity;
  const filledQuantity = Math.min(order.quantity, order.filledQuantity + fillQuantity);
  const averageFillPriceUsd = (priorNotional + priceUsd * fillQuantity) / filledQuantity;
  const completelyFilled = order.quantity - filledQuantity <= QUANTITY_EPSILON;
  const nextOrder: StockPaperLimitOrderV3 = {
    ...evaluatedOrder,
    status: completelyFilled ? "FILLED" : "PARTIAL",
    filledQuantity: completelyFilled ? order.quantity : filledQuantity,
    averageFillPriceUsd,
    ...(completelyFilled ? { terminalReason: "The full PAPER quantity was filled." } : {})
  };
  const fill: StockPaperFillV3 = {
    orderId: order.id,
    symbol: order.symbol,
    side: order.side,
    quantity: fillQuantity,
    priceUsd,
    notionalUsd: fillQuantity * priceUsd,
    barTimestamp: bar.timestamp
  };
  return {
    order: nextOrder,
    reason: completelyFilled ? "FILLED" : "PARTIAL_FILL",
    fill
  };
}

/**
 * Resolves a long position's stop and target from one OHLC bar. When both were
 * touched, OHLC cannot reveal ordering, so the stop wins deliberately. A gap
 * through a stop fills at the worse opening price; a favorable target gap gets
 * the opening-price improvement.
 */
export function resolveLongStockPaperProtectiveExitV3(input: {
  bar: AlpacaStockBar;
  stopPriceUsd: number;
  targetPriceUsd: number;
}): StockPaperProtectiveExitV3 | undefined {
  const { bar, stopPriceUsd, targetPriceUsd } = input;
  if (!validBar(bar) || !finitePositive(stopPriceUsd) || !finitePositive(targetPriceUsd)) {
    return undefined;
  }
  const stopTouched = bar.low <= stopPriceUsd;
  const targetTouched = bar.high >= targetPriceUsd;
  if (!stopTouched && !targetTouched) return undefined;
  if (stopTouched) {
    const gapThrough = bar.open < stopPriceUsd;
    return {
      reason: "STOP_LOSS",
      triggerPriceUsd: stopPriceUsd,
      fillPriceUsd: gapThrough ? bar.open : stopPriceUsd,
      barTimestamp: bar.timestamp,
      sameBarCollision: targetTouched,
      gapThrough
    };
  }
  const gapThrough = bar.open > targetPriceUsd;
  return {
    reason: "TAKE_PROFIT",
    triggerPriceUsd: targetPriceUsd,
    fillPriceUsd: gapThrough ? bar.open : targetPriceUsd,
    barTimestamp: bar.timestamp,
    sameBarCollision: false,
    gapThrough
  };
}
