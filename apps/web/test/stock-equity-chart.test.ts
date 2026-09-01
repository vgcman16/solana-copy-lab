import { describe, expect, it } from "vitest";
import type { StockPaperEquityPoint } from "@copylab/shared";
import {
  normalizedStockEquitySeries,
  smoothStockChartPath,
  stockChartScale
} from "../src/stock-equity-chart";

function point(index: number, navUsd: number, benchmarkReturnPercent: number): StockPaperEquityPoint {
  return {
    capturedAt: new Date(Date.parse("2026-07-16T14:00:00Z") + index * 60_000).toISOString(),
    navUsd,
    cashUsd: 14,
    deployedUsd: navUsd - 14,
    drawdownPercent: 0,
    benchmarkReturnPercent
  };
}

describe("stock equity chart presentation", () => {
  it("rebases the selected range and removes isolated IEX valuation impulses", () => {
    const curve = [
      point(0, 141, 0),
      point(1, 141.1, 0.02),
      point(2, 141.2, 0.03),
      point(3, 137.6, 0.04),
      point(4, 141.3, 0.05),
      point(5, 141.25, 0.06),
      point(6, 141.4, 0.07),
      point(7, 141.35, 0.08),
      point(8, 141.45, 0.09)
    ];

    const series = normalizedStockEquitySeries(curve);

    expect(series.strategy[0]).toBe(100);
    expect(series.strategy[3]).toBeGreaterThan(100);
    expect(Math.min(...series.strategy)).toBeGreaterThan(99.9);
    expect(series.benchmark.at(-1)).toBeCloseTo(100.09, 5);
  });

  it("builds a smooth path on a stable professional index scale", () => {
    const series = {
      strategy: [100, 100.2, 100.1, 100.5, 100.4],
      benchmark: [100, 100.05, 100.08, 100.1, 100.12]
    };
    const scale = stockChartScale(series);
    const path = smoothStockChartPath(
      series.strategy,
      scale.minimum,
      scale.maximum
    );

    expect(scale.maximum - scale.minimum).toBeGreaterThanOrEqual(4);
    expect(scale.ticks).toHaveLength(5);
    expect(path).toMatch(/^M /);
    expect(path).toContain(" C ");
    expect(path).not.toContain("NaN");
  });

  it("subtracts simulated capital contributions instead of charting them as profit", () => {
    const before = point(0, 140, 0);
    const afterDeposit = {
      ...point(1, 1_000, 0.01),
      cumulativeExternalCapitalUsd: 860
    };
    const afterGain = {
      ...point(2, 1_001, 0.02),
      cumulativeExternalCapitalUsd: 860
    };

    const series = normalizedStockEquitySeries([before, afterDeposit, afterGain]);

    expect(series.strategy[0]).toBe(100);
    expect(series.strategy[1]).toBeLessThan(100.3);
    expect(series.strategy[2]).toBeCloseTo(100.7142857, 6);
    expect(Math.max(...series.strategy)).toBeLessThan(101);
  });

  it("joins legacy benchmark returns to robust price marks without an edge jump", () => {
    const curve = [
      point(0, 141, 0),
      point(1, 141.1, 0.08),
      point(2, 141.2, 0.12),
      point(3, 141.3, -0.52),
      point(4, 141.4, -0.52),
      point(5, 141.5, -0.52)
    ];
    curve[3]!.benchmarkPriceUsd = 750.87;
    curve[4]!.benchmarkPriceUsd = 750.95;
    curve[5]!.benchmarkPriceUsd = 751.02;

    const series = normalizedStockEquitySeries(curve);

    expect(Math.abs(series.benchmark[3]! - series.benchmark[2]!)).toBeLessThan(0.1);
    expect(series.benchmark.at(-1)).toBeGreaterThan(series.benchmark[3]!);
  });
});
