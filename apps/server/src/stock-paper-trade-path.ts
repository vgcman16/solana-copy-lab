import { createHash } from "node:crypto";
import type { AlpacaStockBar } from "@copylab/providers";
import type {
  StockPaperTradePathEvidence,
  StockPaperTradePathMissingReason
} from "@copylab/shared";

const MINUTE_MS = 60_000;

export interface CompletedStockPaperTradePath {
  /** Canonical valid bars wholly inside the position's causal holding window. */
  causalBars: AlpacaStockBar[];
  evidence: StockPaperTradePathEvidence;
}

function validBar(bar: AlpacaStockBar): boolean {
  return Number.isFinite(Date.parse(bar.timestamp)) &&
    Number.isFinite(bar.open) && bar.open > 0 &&
    Number.isFinite(bar.high) && bar.high > 0 &&
    Number.isFinite(bar.low) && bar.low > 0 &&
    Number.isFinite(bar.close) && bar.close > 0 &&
    bar.high >= Math.max(bar.open, bar.low, bar.close) &&
    bar.low <= Math.min(bar.open, bar.high, bar.close) &&
    Number.isFinite(bar.volume) && bar.volume >= 0 &&
    Number.isFinite(bar.tradeCount) && bar.tradeCount >= 0 &&
    Number.isFinite(bar.vwap) && bar.vwap > 0;
}

function canonicalBar(bar: AlpacaStockBar): AlpacaStockBar {
  return {
    timestamp: new Date(Date.parse(bar.timestamp)).toISOString(),
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
    tradeCount: bar.tradeCount,
    vwap: bar.vwap
  };
}

function barFingerprint(bar: AlpacaStockBar): string {
  return JSON.stringify(canonicalBar(bar));
}

function addReason(
  reasons: StockPaperTradePathMissingReason[],
  reason: StockPaperTradePathMissingReason
): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}

/**
 * Builds truthful completed-trade path evidence without forward-filling.
 *
 * The minute containing an entry is excluded because a quote fill can occur
 * during that minute and a bar-based limit fill can occur after its open. The
 * liquidation minute is also excluded because the PAPER SELL fills at that
 * bar's open. Only intervening, fully-held minute bars are causally eligible.
 */
export function buildCompletedStockPaperTradePath(input: {
  bars: readonly AlpacaStockBar[];
  entryPriceUsd: number;
  openedAt: string;
  exitedAt: string;
  generatedAt: string;
}): CompletedStockPaperTradePath {
  const reasons: StockPaperTradePathMissingReason[] = [];
  const openedMs = Date.parse(input.openedAt);
  const exitedMs = Date.parse(input.exitedAt);
  if (!Number.isFinite(openedMs) || !Number.isFinite(exitedMs) || exitedMs <= openedMs) {
    addReason(reasons, "INVALID_BOUNDARY");
  }
  if (!Number.isFinite(input.entryPriceUsd) || input.entryPriceUsd <= 0) {
    addReason(reasons, "INVALID_ENTRY_PRICE");
  }

  const firstEligibleMs = Number.isFinite(openedMs)
    ? Math.floor(openedMs / MINUTE_MS) * MINUTE_MS + MINUTE_MS
    : Number.NaN;
  const exitMinuteMs = Number.isFinite(exitedMs)
    ? Math.floor(exitedMs / MINUTE_MS) * MINUTE_MS
    : Number.NaN;
  const expectedBars = Number.isFinite(firstEligibleMs) && Number.isFinite(exitMinuteMs)
    ? Math.max(0, Math.floor((exitMinuteMs - firstEligibleMs) / MINUTE_MS))
    : 0;
  if (reasons.length === 0 && expectedBars === 0) {
    addReason(reasons, "NO_FULLY_HELD_MINUTE");
  }

  const barsByTime = new Map<number, AlpacaStockBar>();
  const conflictingTimes = new Set<number>();
  for (const rawBar of input.bars) {
    const barAt = Date.parse(rawBar.timestamp);
    if (!Number.isFinite(barAt)) {
      addReason(reasons, "INVALID_RECORDED_BAR");
      continue;
    }
    if (!Number.isFinite(firstEligibleMs) || !Number.isFinite(exitMinuteMs) ||
        barAt < firstEligibleMs || barAt >= exitMinuteMs) {
      continue;
    }
    if (barAt % MINUTE_MS !== 0 || !validBar(rawBar)) {
      addReason(reasons, "INVALID_RECORDED_BAR");
      continue;
    }
    const bar = canonicalBar(rawBar);
    const prior = barsByTime.get(barAt);
    if (prior && barFingerprint(prior) !== barFingerprint(bar)) {
      conflictingTimes.add(barAt);
      barsByTime.delete(barAt);
      addReason(reasons, "CONFLICTING_DUPLICATE_BAR");
      continue;
    }
    if (!conflictingTimes.has(barAt)) barsByTime.set(barAt, bar);
  }

  const causalBars = [...barsByTime.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, bar]) => bar);
  if (expectedBars > 0 && causalBars.length === 0) {
    addReason(reasons, "NO_RECORDED_BARS");
  }
  if (causalBars.length > 0 && Date.parse(causalBars[0]!.timestamp) > firstEligibleMs) {
    addReason(reasons, "PATH_STARTS_LATE");
  }
  for (let index = 1; index < causalBars.length; index += 1) {
    if (
      Date.parse(causalBars[index]!.timestamp) -
      Date.parse(causalBars[index - 1]!.timestamp) !== MINUTE_MS
    ) {
      addReason(reasons, "PATH_GAP");
    }
  }
  if (
    causalBars.length > 0 &&
    Date.parse(causalBars.at(-1)!.timestamp) < exitMinuteMs - MINUTE_MS
  ) {
    addReason(reasons, "PATH_ENDS_EARLY");
  }
  if (causalBars.length > 0 && causalBars.length !== expectedBars &&
      !reasons.includes("PATH_STARTS_LATE") && !reasons.includes("PATH_ENDS_EARLY")) {
    addReason(reasons, "PATH_GAP");
  }

  const complete = reasons.length === 0 && expectedBars > 0 && causalBars.length === expectedBars;
  const pathDigest = causalBars.length > 0
    ? createHash("sha256").update(JSON.stringify({
        schemaVersion: "stock-paper-trade-path-v1",
        openedAt: input.openedAt,
        exitedAt: input.exitedAt,
        entryPriceUsd: input.entryPriceUsd,
        bars: causalBars
      })).digest("hex")
    : undefined;
  const favorable = complete
    ? Math.max(0, ...causalBars.map((bar) =>
        (bar.high - input.entryPriceUsd) / input.entryPriceUsd * 100
      ))
    : undefined;
  const adverse = complete
    ? Math.min(0, ...causalBars.map((bar) =>
        (bar.low - input.entryPriceUsd) / input.entryPriceUsd * 100
      ))
    : undefined;

  return {
    causalBars,
    evidence: {
      schemaVersion: "stock-paper-trade-path-v1",
      provenance: "RECORDED_CAUSAL_MINUTE_BARS",
      metricBasis: "BAR_HIGH_LOW_VS_AVERAGE_ENTRY_PRICE",
      causalWindow: "ENTRY_MINUTE_EXCLUSIVE_EXIT_MINUTE_EXCLUSIVE",
      completeness: complete
        ? "COMPLETE"
        : causalBars.length > 0
          ? "PARTIAL"
          : "UNAVAILABLE",
      missingReasons: reasons,
      openedAt: input.openedAt,
      exitedAt: input.exitedAt,
      expectedBars,
      barsUsed: causalBars.length,
      ...(causalBars[0] ? { firstBarAt: causalBars[0].timestamp } : {}),
      ...(causalBars.at(-1) ? { lastBarAt: causalBars.at(-1)!.timestamp } : {}),
      ...(pathDigest ? { pathDigest } : {}),
      ...(favorable !== undefined ? { maximumFavorableExcursionPercent: favorable } : {}),
      ...(adverse !== undefined ? { maximumAdverseExcursionPercent: adverse } : {}),
      generatedAt: input.generatedAt
    }
  };
}
