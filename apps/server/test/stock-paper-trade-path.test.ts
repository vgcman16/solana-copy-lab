import { describe, expect, it } from "vitest";
import type { AlpacaStockBar } from "@copylab/providers";
import { buildCompletedStockPaperTradePath } from "../src/stock-paper-trade-path.js";

function bar(timestamp: string, high: number, low: number): AlpacaStockBar {
  return {
    timestamp,
    open: 100,
    high,
    low,
    close: 100,
    volume: 1_000,
    tradeCount: 100,
    vwap: 100
  };
}

describe("completed stock PAPER trade path evidence", () => {
  it("records MFE and MAE only from the complete fully-held minute path", () => {
    const result = buildCompletedStockPaperTradePath({
      bars: [
        bar("2026-07-17T14:30:00.000Z", 999, 1),
        bar("2026-07-17T14:31:00.000Z", 104, 98),
        bar("2026-07-17T14:32:00.000Z", 103, 95),
        bar("2026-07-17T14:33:00.000Z", 999, 1)
      ],
      entryPriceUsd: 100,
      openedAt: "2026-07-17T14:30:15.000Z",
      exitedAt: "2026-07-17T14:33:00.000Z",
      generatedAt: "2026-07-17T14:34:00.000Z"
    });

    expect(result.causalBars.map((entry) => entry.timestamp)).toEqual([
      "2026-07-17T14:31:00.000Z",
      "2026-07-17T14:32:00.000Z"
    ]);
    expect(result.evidence).toMatchObject({
      completeness: "COMPLETE",
      missingReasons: [],
      expectedBars: 2,
      barsUsed: 2,
      firstBarAt: "2026-07-17T14:31:00.000Z",
      lastBarAt: "2026-07-17T14:32:00.000Z",
      maximumFavorableExcursionPercent: 4,
      maximumAdverseExcursionPercent: -5
    });
    expect(result.evidence.pathDigest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("marks a gap partial and does not fabricate whole-trade excursion metrics", () => {
    const result = buildCompletedStockPaperTradePath({
      bars: [
        bar("2026-07-17T14:31:00.000Z", 104, 98),
        bar("2026-07-17T14:33:00.000Z", 106, 94)
      ],
      entryPriceUsd: 100,
      openedAt: "2026-07-17T14:30:00.000Z",
      exitedAt: "2026-07-17T14:34:00.000Z",
      generatedAt: "2026-07-17T14:35:00.000Z"
    });

    expect(result.evidence).toMatchObject({
      completeness: "PARTIAL",
      missingReasons: ["PATH_GAP"],
      expectedBars: 3,
      barsUsed: 2
    });
    expect(result.evidence.maximumFavorableExcursionPercent).toBeUndefined();
    expect(result.evidence.maximumAdverseExcursionPercent).toBeUndefined();
  });

  it("keeps conflicting recorded bars incomplete instead of choosing a favorable copy", () => {
    const result = buildCompletedStockPaperTradePath({
      bars: [
        bar("2026-07-17T14:31:00.000Z", 101, 99),
        bar("2026-07-17T14:31:00.000Z", 120, 80)
      ],
      entryPriceUsd: 100,
      openedAt: "2026-07-17T14:30:00.000Z",
      exitedAt: "2026-07-17T14:32:00.000Z",
      generatedAt: "2026-07-17T14:33:00.000Z"
    });

    expect(result.causalBars).toEqual([]);
    expect(result.evidence).toMatchObject({
      completeness: "UNAVAILABLE",
      missingReasons: ["CONFLICTING_DUPLICATE_BAR", "NO_RECORDED_BARS"],
      expectedBars: 1,
      barsUsed: 0
    });
  });

  it("truthfully records that a sub-minute holding has no fully-held bar", () => {
    const result = buildCompletedStockPaperTradePath({
      bars: [bar("2026-07-17T14:30:00.000Z", 110, 90)],
      entryPriceUsd: 100,
      openedAt: "2026-07-17T14:30:10.000Z",
      exitedAt: "2026-07-17T14:30:50.000Z",
      generatedAt: "2026-07-17T14:31:00.000Z"
    });

    expect(result.evidence).toMatchObject({
      completeness: "UNAVAILABLE",
      missingReasons: ["NO_FULLY_HELD_MINUTE"],
      expectedBars: 0,
      barsUsed: 0
    });
  });
});
