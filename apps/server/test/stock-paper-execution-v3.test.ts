import { describe, expect, it } from "vitest";
import type { AlpacaStockBar } from "@copylab/providers";
import {
  cancelStockPaperLimitOrderV3,
  expireStockPaperLimitOrderV3,
  firstEligibleStockPaperBarAtV3,
  rejectStockPaperLimitOrderV3,
  resolveLongStockPaperProtectiveExitV3,
  resolveStockPaperLimitOrderV3,
  submitStockPaperLimitOrderV3
} from "../src/stock-paper-execution-v3.js";

function bar(input: Partial<AlpacaStockBar> = {}): AlpacaStockBar {
  return {
    timestamp: "2026-07-17T01:21:00.000Z",
    open: 101,
    high: 102,
    low: 99,
    close: 100.5,
    volume: 1_000,
    tradeCount: 100,
    vwap: 100.5,
    ...input
  };
}

function buyOrder(input: Partial<Parameters<typeof submitStockPaperLimitOrderV3>[0]> = {}) {
  return submitStockPaperLimitOrderV3({
    id: "paper-order:1",
    symbol: "AAPL",
    side: "BUY",
    limitPriceUsd: 100,
    quantity: 10,
    submittedAt: "2026-07-17T01:20:30.000Z",
    expiresAt: "2026-07-17T01:25:00.000Z",
    ...input
  });
}

describe("stock paper execution v3", () => {
  it("uses the next minute as the strict post-submission boundary, including exact-minute submissions", () => {
    expect(firstEligibleStockPaperBarAtV3("2026-07-17T01:20:30.000Z"))
      .toBe("2026-07-17T01:21:00.000Z");
    expect(firstEligibleStockPaperBarAtV3("2026-07-17T01:20:00.000Z"))
      .toBe("2026-07-17T01:21:00.000Z");
  });

  it("rejects same-minute lookahead even when that bar crossed the limit", () => {
    const order = buyOrder();
    const sameMinute = resolveStockPaperLimitOrderV3({
      order,
      bar: bar({
        timestamp: "2026-07-17T01:20:00.000Z",
        open: 101,
        high: 102,
        low: 95,
        close: 99
      }),
      participationRate: 1
    });

    expect(sameMinute.reason).toBe("BAR_BEFORE_ELIGIBLE_BOUNDARY");
    expect(sameMinute.order).toMatchObject({ status: "SUBMITTED", filledQuantity: 0 });

    const nextMinute = resolveStockPaperLimitOrderV3({
      order: sameMinute.order,
      bar: bar(),
      participationRate: 1
    });
    expect(nextMinute.reason).toBe("FILLED");
    expect(nextMinute.order).toMatchObject({ status: "FILLED", filledQuantity: 10 });
  });

  it("caps participation, carries a partial remainder, and computes a weighted average fill", () => {
    const first = resolveStockPaperLimitOrderV3({
      order: buyOrder(),
      bar: bar({ open: 99, high: 101, low: 98, close: 100, volume: 30 }),
      participationRate: 0.1
    });
    expect(first.reason).toBe("PARTIAL_FILL");
    expect(first.fill).toMatchObject({ quantity: 3, priceUsd: 99, notionalUsd: 297 });
    expect(first.order).toMatchObject({
      status: "PARTIAL",
      filledQuantity: 3,
      averageFillPriceUsd: 99
    });

    const second = resolveStockPaperLimitOrderV3({
      order: first.order,
      bar: bar({
        timestamp: "2026-07-17T01:22:00.000Z",
        open: 101,
        high: 102,
        low: 99,
        close: 100,
        volume: 70
      }),
      participationRate: 0.1
    });
    expect(second.reason).toBe("FILLED");
    expect(second.fill).toMatchObject({ quantity: 7, priceUsd: 100 });
    expect(second.order.status).toBe("FILLED");
    expect(second.order.filledQuantity).toBe(10);
    expect(second.order.averageFillPriceUsd).toBeCloseTo(99.7, 10);
  });

  it("does not double-fill when the same evidence bar is replayed", () => {
    const first = resolveStockPaperLimitOrderV3({
      order: buyOrder(),
      bar: bar({ volume: 30 }),
      participationRate: 0.1
    });
    const replay = resolveStockPaperLimitOrderV3({
      order: first.order,
      bar: bar({ volume: 30 }),
      participationRate: 0.1
    });
    expect(first.order.filledQuantity).toBe(3);
    expect(replay.reason).toBe("BAR_ALREADY_EVALUATED");
    expect(replay.order.filledQuantity).toBe(3);
  });

  it("preserves partial fills when the remainder expires", () => {
    const partial = resolveStockPaperLimitOrderV3({
      order: buyOrder(),
      bar: bar({ volume: 20 }),
      participationRate: 0.1
    }).order;
    const expired = expireStockPaperLimitOrderV3(partial, "2026-07-17T01:25:00.000Z");
    expect(expired).toMatchObject({
      status: "EXPIRED",
      filledQuantity: 2,
      terminalReason: "The unfilled remainder expired."
    });
  });

  it("expires before evaluating a bar that starts at the expiry boundary", () => {
    const result = resolveStockPaperLimitOrderV3({
      order: buyOrder({ expiresAt: "2026-07-17T01:22:00.000Z" }),
      bar: bar({ timestamp: "2026-07-17T01:22:00.000Z" }),
      participationRate: 1
    });
    expect(result.reason).toBe("ORDER_EXPIRED");
    expect(result.order).toMatchObject({ status: "EXPIRED", filledQuantity: 0 });
  });

  it("supports explicit cancel and reject terminal transitions", () => {
    const canceled = cancelStockPaperLimitOrderV3(
      buyOrder(),
      "2026-07-17T01:21:30.000Z",
      "Signal safety failed."
    );
    expect(canceled).toMatchObject({ status: "CANCELED", terminalReason: "Signal safety failed." });
    expect(resolveStockPaperLimitOrderV3({ order: canceled, bar: bar() }).reason)
      .toBe("ORDER_TERMINAL");

    const rejected = rejectStockPaperLimitOrderV3(
      buyOrder({ id: "paper-order:2" }),
      "2026-07-17T01:20:31.000Z",
      "Asset halted."
    );
    expect(rejected).toMatchObject({ status: "REJECTED", terminalReason: "Asset halted." });
  });

  it("creates a rejected state for an invalid submission instead of a fillable order", () => {
    const rejected = buyOrder({ quantity: 0, expiresAt: "2026-07-17T01:20:40.000Z" });
    expect(rejected.status).toBe("REJECTED");
    expect(rejected.terminalReason).toContain("Quantity must be positive.");
    expect(rejected.terminalReason).toContain("Expiry must leave at least one strictly post-submission bar eligible.");
  });

  it("models favorable gap-through improvement for sell limits", () => {
    const order = submitStockPaperLimitOrderV3({
      id: "paper-order:sell",
      symbol: "AAPL",
      side: "SELL",
      limitPriceUsd: 110,
      quantity: 4,
      submittedAt: "2026-07-17T01:20:30.000Z",
      expiresAt: "2026-07-17T01:25:00.000Z"
    });
    const result = resolveStockPaperLimitOrderV3({
      order,
      bar: bar({ open: 112, high: 114, low: 111, close: 113, volume: 100 }),
      participationRate: 1
    });
    expect(result.fill).toMatchObject({ quantity: 4, priceUsd: 112 });
    expect(result.order.averageFillPriceUsd).toBe(112);
  });

  it("participation-limits a marketable PAPER liquidation across completed bars", () => {
    const order = submitStockPaperLimitOrderV3({
      id: "paper-order:market-sell",
      symbol: "AAPL",
      side: "SELL",
      limitPriceUsd: 110,
      quantity: 10,
      submittedAt: "2026-07-17T01:20:30.000Z",
      expiresAt: "2026-07-17T01:25:00.000Z"
    });
    const first = resolveStockPaperLimitOrderV3({
      order,
      bar: bar({ open: 90, high: 91, low: 89, close: 90, volume: 30 }),
      participationRate: 0.1,
      marketable: true,
      marketableFillPriceUsd: 89.5
    });
    expect(first.reason).toBe("PARTIAL_FILL");
    expect(first.fill).toMatchObject({ quantity: 3, priceUsd: 89.5 });
    expect(first.order).toMatchObject({ status: "PARTIAL", filledQuantity: 3 });

    const second = resolveStockPaperLimitOrderV3({
      order: first.order,
      bar: bar({
        timestamp: "2026-07-17T01:22:00.000Z",
        open: 88,
        high: 89,
        low: 87,
        close: 88.5,
        volume: 70
      }),
      participationRate: 0.1,
      marketable: true,
      marketableFillPriceUsd: 87.75
    });
    expect(second.reason).toBe("FILLED");
    expect(second.fill).toMatchObject({ quantity: 7, priceUsd: 87.75 });
    expect(second.order.status).toBe("FILLED");
    expect(second.order.averageFillPriceUsd).toBeCloseTo(88.275, 10);
  });

  it("chooses the stop conservatively when stop and target touch in the same bar", () => {
    const exit = resolveLongStockPaperProtectiveExitV3({
      stopPriceUsd: 92,
      targetPriceUsd: 112,
      bar: bar({ open: 100, high: 115, low: 90, close: 105 })
    });
    expect(exit).toEqual({
      reason: "STOP_LOSS",
      triggerPriceUsd: 92,
      fillPriceUsd: 92,
      barTimestamp: "2026-07-17T01:21:00.000Z",
      sameBarCollision: true,
      gapThrough: false
    });
  });

  it("prices adverse stop gaps at the open and favorable target gaps at the open", () => {
    const stopped = resolveLongStockPaperProtectiveExitV3({
      stopPriceUsd: 92,
      targetPriceUsd: 112,
      bar: bar({ open: 88, high: 90, low: 87, close: 89 })
    });
    expect(stopped).toMatchObject({ reason: "STOP_LOSS", fillPriceUsd: 88, gapThrough: true });

    const target = resolveLongStockPaperProtectiveExitV3({
      stopPriceUsd: 92,
      targetPriceUsd: 112,
      bar: bar({ open: 115, high: 116, low: 113, close: 114 })
    });
    expect(target).toMatchObject({ reason: "TAKE_PROFIT", fillPriceUsd: 115, gapThrough: true });
  });
});
