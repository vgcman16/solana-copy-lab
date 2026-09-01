import type { StockPaperEquityPoint } from "@copylab/shared";

export interface StockEquitySeries {
  strategy: number[];
  benchmark: number[];
}

interface PlotPoint {
  x: number;
  y: number;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
}

/**
 * IEX is a single-exchange feed, so a temporarily wide or stale quote can
 * create a false one-minute NAV jump even though the surrounding marks and
 * completed-trade ledger remain continuous. This centered Hampel-style pass
 * repairs only large local impulses; sustained market moves remain visible.
 */
export function stabilizeStockIndex(
  values: readonly number[],
  impulseThreshold: number,
  radius = 12
): number[] {
  if (values.length < 5) return [...values];
  return values.map((value, index) => {
    const start = Math.max(0, index - radius);
    const end = Math.min(values.length, index + radius + 1);
    const localMedian = median(values.slice(start, end));
    return Math.abs(value - localMedian) >= impulseThreshold
      ? localMedian
      : value;
  });
}

function smoothStockIndex(values: readonly number[]): number[] {
  const weights = [1, 2, 1] as const;
  const smoothed = values.map((_, index) => {
    let weighted = 0;
    let totalWeight = 0;
    for (let offset = -1; offset <= 1; offset += 1) {
      const value = values[index + offset];
      const weight = weights[offset + 1]!;
      if (value === undefined) continue;
      weighted += value * weight;
      totalWeight += weight;
    }
    return totalWeight > 0 ? weighted / totalWeight : (values[index] ?? 100);
  });
  if (values.length > 0) {
    smoothed[0] = values[0]!;
    smoothed[smoothed.length - 1] = values[values.length - 1]!;
  }
  return smoothed;
}

function normalizedBenchmark(curve: readonly StockPaperEquityPoint[]): number[] {
  const firstReturn = curve[0]?.benchmarkReturnPercent ?? 0;
  const returnSeries = curve.map((point) =>
    100 + (point.benchmarkReturnPercent ?? firstReturn) - firstReturn
  );
  const firstPriceIndex = curve.findIndex((point) =>
    point.benchmarkPriceUsd !== undefined && point.benchmarkPriceUsd > 0
  );
  if (firstPriceIndex < 0) return returnSeries;

  const priceBaseline = curve[firstPriceIndex]!.benchmarkPriceUsd!;
  const continuityAnchor = firstPriceIndex > 0
    ? returnSeries[firstPriceIndex - 1]!
    : 100;
  let lastPrice = priceBaseline;
  return curve.map((point, index) => {
    if (index < firstPriceIndex) return returnSeries[index]!;
    if (point.benchmarkPriceUsd !== undefined && point.benchmarkPriceUsd > 0) {
      lastPrice = point.benchmarkPriceUsd;
    }
    return continuityAnchor + (lastPrice / priceBaseline - 1) * 100;
  });
}

export function normalizedStockEquitySeries(
  curve: readonly StockPaperEquityPoint[]
): StockEquitySeries {
  if (curve.length === 0) return { strategy: [], benchmark: [] };
  const first = curve[0]!;
  const externalCapitalAdjustedNav = (point: StockPaperEquityPoint): number =>
    point.navUsd - (point.cumulativeExternalCapitalUsd ?? 0);
  const firstAdjustedNav = externalCapitalAdjustedNav(first);
  const initialNav = firstAdjustedNav > 0 ? firstAdjustedNav : 1;
  const rawStrategy = curve.map((point) =>
    externalCapitalAdjustedNav(point) / initialNav * 100
  );
  const rawBenchmark = normalizedBenchmark(curve);
  return {
    strategy: smoothStockIndex(stabilizeStockIndex(rawStrategy, 0.62)),
    benchmark: smoothStockIndex(stabilizeStockIndex(rawBenchmark, 0.24, 8))
  };
}

function plotPoints(
  values: readonly number[],
  minimum: number,
  maximum: number,
  width: number,
  height: number,
  offsetX: number
): PlotPoint[] {
  const range = maximum - minimum || 1;
  return values.map((value, index) => ({
    x: offsetX + (values.length <= 1 ? 0 : index / (values.length - 1) * width),
    y: height - (value - minimum) / range * height
  }));
}

function coordinate(value: number): string {
  return value.toFixed(2);
}

export function smoothStockChartPath(
  values: readonly number[],
  minimum: number,
  maximum: number,
  width = 588,
  height = 180,
  offsetX = 12
): string {
  const plotted = plotPoints(values, minimum, maximum, width, height, offsetX);
  if (plotted.length === 0) return "";
  if (plotted.length === 1) {
    const point = plotted[0]!;
    return `M ${coordinate(point.x)} ${coordinate(point.y)}`;
  }
  let path = `M ${coordinate(plotted[0]!.x)} ${coordinate(plotted[0]!.y)}`;
  for (let index = 0; index < plotted.length - 1; index += 1) {
    const previous = plotted[Math.max(0, index - 1)]!;
    const current = plotted[index]!;
    const next = plotted[index + 1]!;
    const following = plotted[Math.min(plotted.length - 1, index + 2)]!;
    const firstControl = {
      x: current.x + (next.x - previous.x) / 6,
      y: Math.min(height, Math.max(0, current.y + (next.y - previous.y) / 6))
    };
    const secondControl = {
      x: next.x - (following.x - current.x) / 6,
      y: Math.min(height, Math.max(0, next.y - (following.y - current.y) / 6))
    };
    path += ` C ${coordinate(firstControl.x)} ${coordinate(firstControl.y)}, ${coordinate(secondControl.x)} ${coordinate(secondControl.y)}, ${coordinate(next.x)} ${coordinate(next.y)}`;
  }
  return path;
}

export function stockChartScale(series: StockEquitySeries): {
  minimum: number;
  maximum: number;
  ticks: number[];
} {
  const all = [...series.strategy, ...series.benchmark, 100];
  const rawMinimum = Math.min(...all);
  const rawMaximum = Math.max(...all);
  const requiredSpan = Math.max(4, (rawMaximum - rawMinimum) * 1.18);
  const step = requiredSpan <= 4 ? 1 : requiredSpan <= 8 ? 2 : 5;
  const center = (rawMinimum + rawMaximum) / 2;
  let minimum = Math.floor((center - requiredSpan / 2) / step) * step;
  let maximum = minimum + step * 4;
  while (minimum > rawMinimum) {
    minimum -= step;
    maximum -= step;
  }
  while (maximum < rawMaximum) maximum += step;
  return {
    minimum,
    maximum,
    ticks: Array.from({ length: 5 }, (_, index) =>
      maximum - (maximum - minimum) * index / 4
    )
  };
}
