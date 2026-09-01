import { createHash } from "node:crypto";
import {
  STOCK_PAPER_FEATURE_VERSION,
  STOCK_PAPER_POLICY_VERSION,
  type StockPaperCandidate,
  type StockPaperExitReason,
  type StockPaperLearningStatus,
  type StockPaperMarketStatus,
  type StockPaperPolicy,
  type StockPaperPosition,
  type StockPaperReplaySummary,
  type StockPaperStrategyArm
} from "@copylab/shared";
import type {
  AlpacaMarketClock,
  AlpacaStockBar,
  AlpacaStockSnapshot
} from "@copylab/providers";

export { STOCK_PAPER_POLICY_VERSION };
export { STOCK_PAPER_FEATURE_VERSION };

export const STOCK_PAPER_REALTIME_BAR_MAX_AGE_MS = 4 * 60_000;
export const STOCK_PAPER_DERIVED_OVERNIGHT_BAR_MAX_AGE_MS = 20 * 60_000;

export function stockPaperMaximumBarAgeMs(
  phase: StockPaperMarketStatus["phase"]
): number {
  return phase === "OVERNIGHT"
    ? STOCK_PAPER_DERIVED_OVERNIGHT_BAR_MAX_AGE_MS
    : STOCK_PAPER_REALTIME_BAR_MAX_AGE_MS;
}

export const DEFAULT_STOCK_PAPER_POLICY: Readonly<StockPaperPolicy> = Object.freeze({
  scanIntervalSeconds: 60,
  initialNavUsd: 141,
  maximumOpenPositions: 4,
  maximumDeployedFraction: 0.9,
  minimumCashReserveUsd: 10,
  maximumPositionNavFraction: 0.45,
  warmupMaximumPositionNavFraction: 0.2,
  establishedMaximumPositionNavFraction: 0.35,
  leveragedMaximumPositionNavFraction: 0.18,
  maximumExposureGroupNavFraction: 0.35,
  normalRiskAtStopNavFraction: 0.04,
  highConvictionRiskAtStopNavFraction: 0.06,
  targetIntradayVolatilityPercent: 2,
  minimumVolatilitySizeMultiplier: 0.5,
  leveragedInstrumentSizeMultiplier: 0.72,
  inverseInstrumentSizeMultiplier: 0.65,
  minimumUpsizeContextTrades: 30,
  stopLossPercent: 8,
  takeProfitPercent: 12,
  trailingActivationPercent: 6,
  trailingDrawdownPercent: 4,
  maximumHoldingMinutes: 210,
  cooldownMinutes: 60,
  stopCooldownMinutes: 180,
  dailyLossPausePercent: 12,
  maximumDrawdownPercent: 25,
  maximumSpreadPercent: 1.25,
  minimumPriceUsd: 1,
  maximumPriceUsd: 500,
  minimumDailyDollarVolumeUsd: 2_000_000,
  minimumRelativeVolume: 1.15,
  minimumSignalScore: 62,
  universeSize: 280,
  detailedCandidateCount: 30,
  extendedEntrySpreadPercent: 0.6,
  extendedEntrySizeMultiplier: 0.55,
  extendedMaximumOpenPositions: 2,
  extendedFillPenaltyPercent: 0.15,
  extendedLimitConfirmationMinutes: 3,
  overnightDerivedLimitConfirmationMinutes: 25,
  maximumBarParticipationPercent: 1,
  observationRetentionDays: 180
});

export function stockPaperPolicyDigest(policy: StockPaperPolicy): string {
  const canonical = Object.fromEntries(
    Object.entries(policy).sort(([left], [right]) => left.localeCompare(right))
  );
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** Liquid anchors make every scan useful while the deterministic daily sample
 * gives the experiment broad coverage without hard-coding one static list. */
export const STOCK_PAPER_CORE_UNIVERSE = Object.freeze([
  "AAPL", "ABBV", "ABNB", "AMD", "AMZN", "AVGO", "BA", "BAC", "BABA", "BITO",
  "C", "CAT", "CCL", "COIN", "COP", "COST", "CRM", "CRWD", "CVX", "DAL",
  "DIA", "DIS", "DKNG", "F", "FCX", "FXI", "GDX", "GE", "GME", "GOOG",
  "GOOGL", "GS", "HOOD", "HYG", "IBM", "INTC", "IWM", "JD", "JPM", "KO",
  "LI", "LLY", "LULU", "MARA", "META", "MS", "MSFT", "MU", "NCLH", "NFLX",
  "NIO", "NVDA", "ORCL", "OXY", "PANW", "PFE", "PLTR", "PYPL", "QCOM", "QQQ",
  "RBLX", "RIOT", "RIVN", "ROKU", "SBUX", "SHOP", "SLV", "SMCI", "SOFI", "SPY",
  "T", "TGT", "TLT", "TSLA", "TSM", "UBER", "UNH", "V", "VZ", "WFC",
  "WMT", "X", "XLE", "XLF", "XLP", "XLV", "XOM", "ZM"
] as const);

function finite(value: number | undefined, fallback = 0): number {
  return value !== undefined && Number.isFinite(value) ? value : fallback;
}

function percentChange(current: number, prior: number): number {
  return prior > 0 ? (current - prior) / prior * 100 : 0;
}

function average(values: readonly number[]): number {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function intradayVolatilityPercent(bars: readonly AlpacaStockBar[]): number {
  const returns = bars.slice(-31).flatMap((bar, index, window) => {
    const prior = window[index - 1];
    if (!prior || prior.close <= 0 || bar.close <= 0) return [];
    return [percentChange(bar.close, prior.close)];
  });
  if (returns.length === 0) return 0;
  const rootMeanSquare = Math.sqrt(average(returns.map((value) => value * value)));
  return rootMeanSquare * Math.sqrt(15);
}

function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : sorted[middle];
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

interface EasternPoint {
  dateKey: string;
  minutes: number;
}

function easternPoint(value: Date): EasternPoint | undefined {
  if (!Number.isFinite(value.getTime())) return undefined;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(value);
  const read = (type: Intl.DateTimeFormatPartTypes): string | undefined =>
    parts.find((part) => part.type === type)?.value;
  const year = read("year");
  const month = read("month");
  const day = read("day");
  const hour = Number(read("hour"));
  const minute = Number(read("minute"));
  if (!year || !month || !day || !Number.isFinite(hour) || !Number.isFinite(minute)) return undefined;
  return { dateKey: `${year}-${month}-${day}`, minutes: hour * 60 + minute };
}

function adjacentDateKey(dateKey: string, days: number): string {
  const atNoonUtc = new Date(`${dateKey}T12:00:00.000Z`);
  atNoonUtc.setUTCDate(atNoonUtc.getUTCDate() + days);
  return atNoonUtc.toISOString().slice(0, 10);
}

function inCurrentPhase(
  bar: EasternPoint,
  captured: EasternPoint,
  phase: StockPaperMarketStatus["phase"]
): boolean {
  if (phase === "REGULAR") {
    return bar.dateKey === captured.dateKey && bar.minutes >= 570 && bar.minutes < 960;
  }
  if (phase === "PREMARKET") {
    return bar.dateKey === captured.dateKey && bar.minutes >= 240 && bar.minutes < 570;
  }
  if (phase === "AFTER_HOURS") {
    return bar.dateKey === captured.dateKey && bar.minutes >= 960 && bar.minutes < 1_200;
  }
  if (phase !== "OVERNIGHT") return false;
  if (captured.minutes >= 1_200) {
    return bar.dateKey === captured.dateKey && bar.minutes >= 1_200;
  }
  if (captured.minutes < 240) {
    return (bar.dateKey === captured.dateKey && bar.minutes < 240) ||
      (bar.dateKey === adjacentDateKey(captured.dateKey, -1) && bar.minutes >= 1_200);
  }
  return false;
}

/** Returns only the current, timestamp-contiguous phase tail. This prevents a
 * delayed BOATS bar plus one indicative overnight bar from masquerading as a
 * one-minute momentum series. */
export function currentPhaseBarWindow(input: {
  bars: readonly AlpacaStockBar[];
  capturedAt: string;
  phase?: StockPaperMarketStatus["phase"];
  maximumLatestAgeMs?: number;
  maximumGapMs?: number;
  /** Reconstructs omitted no-trade minutes for feature calculation only. The
   * returned zero-volume bars must never be persisted or used as fills. */
  fillMissingMinutes?: boolean;
}): AlpacaStockBar[] {
  const capturedAt = new Date(input.capturedAt);
  const captured = easternPoint(capturedAt);
  if (!captured) return [];
  const capturedMs = capturedAt.getTime();
  const phase = input.phase;
  const ordered = [...new Map(input.bars.map((bar) => [bar.timestamp, bar])).values()]
    .filter((bar) => {
      const timestamp = Date.parse(bar.timestamp);
      if (!Number.isFinite(timestamp) || timestamp > capturedMs + 5_000) return false;
      if (!phase) return true;
      const point = easternPoint(new Date(timestamp));
      return point ? inCurrentPhase(point, captured, phase) : false;
    })
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  const latest = ordered.at(-1);
  if (!latest) return [];
  const maximumLatestAgeMs = input.maximumLatestAgeMs ?? 2 * 60_000;
  const latestAgeMs = capturedMs - Date.parse(latest.timestamp);
  if (latestAgeMs < -5_000 || latestAgeMs > maximumLatestAgeMs) return [];
  const maximumGapMs = input.maximumGapMs ?? 2 * 60_000;
  let start = ordered.length - 1;
  for (let index = ordered.length - 1; index > 0; index -= 1) {
    const currentAt = Date.parse(ordered[index]!.timestamp);
    const previousAt = Date.parse(ordered[index - 1]!.timestamp);
    if (currentAt - previousAt > maximumGapMs) break;
    start = index - 1;
  }
  const tail = ordered.slice(start);
  if (!input.fillMissingMinutes || tail.length < 2) return tail;
  const reconstructed: AlpacaStockBar[] = [tail[0]!];
  for (const current of tail.slice(1)) {
    const previous = reconstructed.at(-1)!;
    let missingAt = Date.parse(previous.timestamp) + 60_000;
    const currentAt = Date.parse(current.timestamp);
    while (missingAt < currentAt) {
      reconstructed.push({
        timestamp: new Date(missingAt).toISOString(),
        open: previous.close,
        high: previous.close,
        low: previous.close,
        close: previous.close,
        volume: 0,
        tradeCount: 0,
        vwap: previous.close
      });
      missingAt += 60_000;
    }
    reconstructed.push(current);
  }
  return reconstructed;
}

/** New York trading-date key. At 8 PM ET the overnight session belongs to the
 * following trade date, avoiding UTC-midnight risk resets in winter. */
export function stockTradeDayKey(now: Date): string {
  const point = easternPoint(now);
  if (!point) return now.toISOString().slice(0, 10);
  return point.minutes >= 1_200 ? adjacentDateKey(point.dateKey, 1) : point.dateKey;
}

function priceAt(bars: readonly AlpacaStockBar[], offset: number): number {
  return bars.at(Math.max(0, bars.length - 1 - offset))?.close ?? bars.at(-1)?.close ?? 0;
}

/** A causal pullback/reclaim needs an observed touch of VWAP followed by two
 * completed closes back above it and positive one-minute slope. Merely being
 * above VWAP with positive five-minute momentum is not a pullback. */
export function hasCausalPullbackReclaim(bars: readonly AlpacaStockBar[]): boolean {
  const recent = bars.slice(-12);
  if (recent.length < 8) return false;
  const reclaimBars = recent.slice(-2);
  const setupBars = recent.slice(0, -2);
  const pullbackObserved = setupBars.some((bar) =>
    bar.vwap > 0 && bar.low <= bar.vwap
  );
  const reclaimConfirmed = reclaimBars.every((bar) =>
    bar.vwap > 0 && bar.close > bar.vwap
  );
  const prior = reclaimBars[0];
  const latest = reclaimBars[1];
  return Boolean(
    pullbackObserved &&
    reclaimConfirmed &&
    prior &&
    latest &&
    latest.close > prior.close
  );
}

function armForBars(
  bars: readonly AlpacaStockBar[],
  relativeVolume: number,
  vwapDistancePercent: number
): StockPaperStrategyArm {
  const latest = bars.at(-1);
  if (!latest) return "VOLUME_SURGE";
  const earlier = bars.slice(Math.max(0, bars.length - 25), -1);
  const priorHigh = Math.max(0, ...earlier.map((bar) => bar.high));
  const opening = bars.slice(0, Math.min(5, bars.length));
  const openingHigh = Math.max(0, ...opening.map((bar) => bar.high));
  if (bars.length <= 90 && openingHigh > 0 && latest.close > openingHigh) return "OPENING_RANGE";
  if (
    vwapDistancePercent > 0 &&
    percentChange(latest.close, priceAt(bars, 5)) > 0.25 &&
    hasCausalPullbackReclaim(bars)
  ) return "PULLBACK_RECOVERY";
  if (priorHigh > 0 && latest.close >= priorHigh * 0.999) return "BREAKOUT";
  if (relativeVolume >= 1.5) return "VOLUME_SURGE";
  return "BREAKOUT";
}

export function marketPhase(
  clock: AlpacaMarketClock,
  now = new Date(clock.timestamp)
): StockPaperMarketStatus["phase"] {
  if (!Number.isFinite(now.getTime())) return "UNKNOWN";
  if (clock.isOpen) return "REGULAR";
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  });
  const parts = formatter.formatToParts(now);
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  const weekday = parts.find((part) => part.type === "weekday")?.value;
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return "UNKNOWN";
  const minutes = hour * 60 + minute;
  const weekdaySession = weekday !== "Sat" && weekday !== "Sun";
  const overnightEvening = minutes >= 1_200 &&
    (weekday === "Sun" || weekday === "Mon" || weekday === "Tue" || weekday === "Wed" || weekday === "Thu");
  const overnightMorning = minutes < 240 && weekdaySession;
  if (overnightEvening || overnightMorning) return "OVERNIGHT";
  if (weekdaySession && minutes >= 240 && minutes < 570) return "PREMARKET";
  if (weekdaySession && minutes >= 960 && minutes < 1_200) return "AFTER_HOURS";
  return "CLOSED";
}

export function deterministicUniverse(
  eligibleSymbols: readonly string[],
  dayKey: string,
  size = DEFAULT_STOCK_PAPER_POLICY.universeSize
): string[] {
  const core = new Set<string>(STOCK_PAPER_CORE_UNIVERSE);
  const ranked = [...new Set(eligibleSymbols)]
    .map((symbol) => symbol.trim().toUpperCase())
    .filter((symbol) => /^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol) && !symbol.includes("/"))
    .filter((symbol) => !core.has(symbol))
    .map((symbol) => ({
      symbol,
      rank: createHash("sha256").update(`${dayKey}:${symbol}`).digest("hex")
    }))
    .sort((left, right) => left.rank.localeCompare(right.rank) || left.symbol.localeCompare(right.symbol));
  return [...core, ...ranked.map((entry) => entry.symbol)].slice(0, Math.max(core.size, size));
}

export function basicSnapshotScore(snapshot: AlpacaStockSnapshot): number {
  const quote = snapshot.latestQuote;
  const daily = snapshot.dailyBar;
  const previous = snapshot.previousDailyBar;
  if (!quote || !daily || !previous || quote.askPrice <= quote.bidPrice) return Number.NEGATIVE_INFINITY;
  const mid = (quote.bidPrice + quote.askPrice) / 2;
  const spread = (quote.askPrice - quote.bidPrice) / mid * 100;
  const dailyMomentum = percentChange(daily.close, previous.close);
  const fromOpen = percentChange(daily.close, daily.open);
  const dollarVolume = daily.close * daily.volume;
  return dailyMomentum * 3 + fromOpen * 2 + Math.log10(Math.max(1, dollarVolume)) * 2 - spread * 6;
}

/**
 * Apply entry rules that can be decided from the bulk snapshot before using a
 * limited detailed-bar slot. This does not relax or replace the full candidate
 * scorer; it prevents impossible candidates from crowding actionable symbols
 * out of the minute-history scan.
 */
export function passesStockSnapshotPrefilter(
  snapshot: AlpacaStockSnapshot,
  policy: StockPaperPolicy = DEFAULT_STOCK_PAPER_POLICY,
  phase?: StockPaperMarketStatus["phase"]
): boolean {
  const quote = snapshot.latestQuote;
  const daily = snapshot.dailyBar;
  const previous = snapshot.previousDailyBar;
  if (!quote || !daily || !previous || quote.bidPrice <= 0 || quote.askPrice <= quote.bidPrice) {
    return false;
  }
  const priceUsd = (quote.bidPrice + quote.askPrice) / 2;
  const spread = (quote.askPrice - quote.bidPrice) / priceUsd * 100;
  // The newborn overnight daily bar can contain only a few minutes of volume.
  // Use the completed regular-session baseline instead of starving the funnel.
  const liquidityBar = phase === "OVERNIGHT" ? previous : daily;
  const dollarVolumeUsd = liquidityBar.volume * (phase === "OVERNIGHT" ? liquidityBar.close : priceUsd);
  return (
    priceUsd >= policy.minimumPriceUsd &&
    priceUsd <= policy.maximumPriceUsd &&
    spread <= policy.maximumSpreadPercent &&
    dollarVolumeUsd >= policy.minimumDailyDollarVolumeUsd
  );
}

export function stockQuoteIsFresh(
  snapshot: AlpacaStockSnapshot,
  now: Date,
  maximumQuoteAgeMs = 2 * 60_000
): boolean {
  const quote = snapshot.latestQuote;
  const quoteAt = Date.parse(quote?.timestamp ?? "");
  const nowMs = now.getTime();
  if (
    !quote ||
    !Number.isFinite(nowMs) ||
    !Number.isFinite(quoteAt) ||
    !Number.isFinite(quote.bidPrice) ||
    !Number.isFinite(quote.askPrice) ||
    quote.bidPrice <= 0 ||
    quote.askPrice <= quote.bidPrice
  ) return false;
  const quoteAge = nowMs - quoteAt;
  return quoteAge >= -30_000 && quoteAge <= maximumQuoteAgeMs;
}

export function stockSnapshotIsFresh(
  snapshot: AlpacaStockSnapshot,
  now: Date,
  maximumQuoteAgeMs = 2 * 60_000,
  maximumBarAgeMs = 4 * 60_000
): boolean {
  if (!stockQuoteIsFresh(snapshot, now, maximumQuoteAgeMs)) return false;
  const barAt = Date.parse(snapshot.minuteBar?.timestamp ?? "");
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs) || !Number.isFinite(barAt)) return false;
  const barAge = nowMs - barAt;
  return (
    barAge >= -90_000 &&
    barAge <= maximumBarAgeMs
  );
}

export function scoreStockCandidate(input: {
  snapshot: AlpacaStockSnapshot;
  bars: readonly AlpacaStockBar[];
  policy?: StockPaperPolicy;
  name?: string;
  exchange?: string;
  phase?: StockPaperMarketStatus["phase"];
  feed?: StockPaperMarketStatus["feed"];
  onlineSources?: StockPaperCandidate["onlineSources"];
  newsArticleCount?: number;
  capturedAt: string;
}): StockPaperCandidate {
  const policy = input.policy ?? DEFAULT_STOCK_PAPER_POLICY;
  const delayedDerivedOvernight = input.phase === "OVERNIGHT" && input.feed === "OVERNIGHT";
  const bars = currentPhaseBarWindow({
    bars: input.bars,
    capturedAt: input.capturedAt,
    ...(input.phase ? { phase: input.phase } : {}),
    ...(delayedDerivedOvernight
      ? {
          maximumLatestAgeMs: STOCK_PAPER_DERIVED_OVERNIGHT_BAR_MAX_AGE_MS,
          maximumGapMs: 5 * 60_000,
          fillMissingMinutes: true
        }
      : {})
  });
  const latest = bars.at(-1);
  const quote = input.snapshot.latestQuote;
  const daily = input.snapshot.dailyBar;
  const previous = input.snapshot.previousDailyBar;
  const priceUsd = quote ? (quote.bidPrice + quote.askPrice) / 2 : finite(latest?.close);
  const spreadPercent = quote && priceUsd > 0
    ? (quote.askPrice - quote.bidPrice) / priceUsd * 100
    : 100;
  const recentFive = bars.slice(-5);
  const priorTwenty = bars.slice(Math.max(0, bars.length - 25), Math.max(0, bars.length - 5));
  const recentVolume = recentFive.reduce((sum, bar) => sum + bar.volume, 0);
  const expectedRecentVolume = average(priorTwenty.map((bar) => bar.volume)) * Math.max(1, recentFive.length);
  const relativeVolume = expectedRecentVolume > 0 ? recentVolume / expectedRecentVolume : 0;
  const change1mPercent = percentChange(finite(latest?.close), priceAt(bars, 1));
  const change5mPercent = percentChange(finite(latest?.close), priceAt(bars, 5));
  const change15mPercent = percentChange(finite(latest?.close), priceAt(bars, 15));
  const changeFromOpenPercent = daily ? percentChange(priceUsd, daily.open) : 0;
  const dailyChangePercent = daily && previous ? percentChange(priceUsd, previous.close) : 0;
  const vwap = latest?.vwap || daily?.vwap || priceUsd;
  const vwapDistancePercent = percentChange(priceUsd, vwap);
  const realizedVolatilityPercent = intradayVolatilityPercent(bars);
  const liquidityBar = input.phase === "OVERNIGHT" ? previous : daily;
  const dollarVolumeUsd = (liquidityBar?.volume ?? 0) *
    (input.phase === "OVERNIGHT" ? (liquidityBar?.close ?? priceUsd) : priceUsd);
  const arm = armForBars(bars, relativeVolume, vwapDistancePercent);

  const score = clamp(
    45 +
      clamp(change1mPercent, -2, 2) * 3 +
      clamp(change5mPercent, -5, 5) * 3.2 +
      clamp(change15mPercent, -8, 8) * 1.5 +
      clamp(changeFromOpenPercent, -10, 10) * 1.1 +
      clamp(relativeVolume - 1, -1, 4) * 9 +
      clamp(Math.log10(Math.max(1, dollarVolumeUsd)) - 6, -2, 4) * 3 -
      spreadPercent * 7 +
      (vwapDistancePercent > 0 ? 4 : -4),
    0,
    100
  );
  const reasons: string[] = [];
  if (!quote || !daily || !previous) reasons.push("Incomplete market snapshot.");
  if (bars.length < 16) {
    reasons.push("Need 16 causal minute bars from the current market phase.");
  }
  if (priceUsd < policy.minimumPriceUsd || priceUsd > policy.maximumPriceUsd) {
    reasons.push("Price is outside the configured stock range.");
  }
  if (spreadPercent > policy.maximumSpreadPercent) reasons.push("Spread is too wide.");
  if (dollarVolumeUsd < policy.minimumDailyDollarVolumeUsd) reasons.push("IEX dollar volume is too low.");
  if (relativeVolume < policy.minimumRelativeVolume) reasons.push("Relative volume is below the entry floor.");
  if (change5mPercent <= 0 || change15mPercent < -1) reasons.push("Short-term momentum is not positive.");
  if (score < policy.minimumSignalScore) reasons.push("Composite signal score is below the entry floor.");
  const highConviction = score >= 78 && relativeVolume >= 1.75 && spreadPercent <= 0.55;
  return {
    symbol: input.snapshot.symbol,
    ...(input.name ? { name: input.name } : {}),
    ...(input.exchange ? { exchange: input.exchange } : {}),
    priceUsd,
    bidUsd: quote?.bidPrice ?? 0,
    askUsd: quote?.askPrice ?? 0,
    spreadPercent,
    change1mPercent,
    change5mPercent,
    change15mPercent,
    changeFromOpenPercent,
    dailyChangePercent,
    relativeVolume,
    dollarVolumeUsd,
    vwapDistancePercent,
    realizedVolatilityPercent,
    score,
    arm,
    highConviction,
    eligible: reasons.length === 0,
    reasons,
    ...(input.phase ? { marketPhase: input.phase } : {}),
    ...(input.feed ? { marketFeed: input.feed } : {}),
    ...(input.onlineSources && input.onlineSources.length > 0
      ? { onlineSources: [...input.onlineSources] }
      : {}),
    ...(input.newsArticleCount && input.newsArticleCount > 0
      ? { newsArticleCount: input.newsArticleCount }
      : {}),
    capturedAt: input.capturedAt
  };
}

export interface StockPaperLearningDecision {
  multiplier: number;
  status: StockPaperLearningStatus;
  sampleSize: number;
  meanReturnPercent: number;
  conservativeReturnPercent: number;
  winRatePercent: number;
}

export interface StockPaperHierarchicalLearningDecision extends StockPaperLearningDecision {
  exactContextSampleSize: number;
  downsideReferenceSampleSize: number;
  downsideReference: "NONE" | "GLOBAL" | "EXPOSURE_GROUP";
  downsideMultiplier: number;
}

/** Confidence-gated contextual learner. It can protect the account after a
 * repeated bad pattern sooner than it can increase risk. Upsizing needs a
 * positive one-sided lower confidence bound across the configured minimum of
 * 30 matching, walk-forward trades by default. */
export function adaptiveArmDecision(input: {
  trades: readonly { pnlUsd: number; returnPercent: number }[];
  minimumUpsizeSampleSize?: number;
}): StockPaperLearningDecision {
  const recent = input.trades.slice(-40);
  const sampleSize = recent.length;
  const wins = recent.filter((trade) => trade.pnlUsd > 0);
  const winRate = sampleSize > 0 ? wins.length / sampleSize : 0;
  const meanReturnPercent = average(recent.map((trade) => clamp(trade.returnPercent, -25, 25)));
  const variance = sampleSize > 1
    ? recent.reduce((sum, trade) => {
        const difference = clamp(trade.returnPercent, -25, 25) - meanReturnPercent;
        return sum + difference * difference;
      }, 0) / (sampleSize - 1)
    : 0;
  const standardError = sampleSize > 0 ? Math.sqrt(variance) / Math.sqrt(sampleSize) : 0;
  const conservativeReturnPercent = meanReturnPercent - 1.645 * standardError;
  const base = {
    sampleSize,
    meanReturnPercent,
    conservativeReturnPercent,
    winRatePercent: winRate * 100
  };
  if (sampleSize < 8) return { ...base, multiplier: 1, status: "WARMING_UP" };
  if (meanReturnPercent < 0 || winRate < 0.4) {
    const severity = clamp((-meanReturnPercent) / 6 + Math.max(0, 0.45 - winRate), 0, 1);
    return {
      ...base,
      multiplier: clamp(1 - severity * 0.3, 0.7, 1),
      status: "DOWNSIZED"
    };
  }
  const minimumUpsizeSampleSize = Math.max(20, Math.round(
    input.minimumUpsizeSampleSize ?? DEFAULT_STOCK_PAPER_POLICY.minimumUpsizeContextTrades
  ));
  if (sampleSize >= minimumUpsizeSampleSize && conservativeReturnPercent > 0 && winRate >= 0.55) {
    return {
      ...base,
      multiplier: clamp(1 + conservativeReturnPercent / 20 + (winRate - 0.5) * 0.1, 1, 1.15),
      status: "UPSIZED"
    };
  }
  return { ...base, multiplier: 1, status: "NEUTRAL" };
}

export function adaptiveArmMultiplier(input: {
  trades: readonly { pnlUsd: number; returnPercent: number }[];
  minimumUpsizeSampleSize?: number;
}): number {
  return adaptiveArmDecision(input).multiplier;
}

/** Pools only negative evidence while an exact arm+phase context is young.
 * Pooled evidence may reduce risk but can never create or amplify an UPSIZED
 * decision; upside remains governed solely by the exact causal context. */
export function adaptiveHierarchicalArmDecision(input: {
  contextTrades: readonly { pnlUsd: number; returnPercent: number }[];
  downsideReferenceTrades?: readonly {
    pnlUsd: number;
    returnPercent: number;
    symbol?: string;
  }[];
  candidateSymbol?: string;
  minimumUpsizeSampleSize?: number;
}): StockPaperHierarchicalLearningDecision {
  const exact = adaptiveArmDecision({
    trades: input.contextTrades,
    ...(input.minimumUpsizeSampleSize !== undefined
      ? { minimumUpsizeSampleSize: input.minimumUpsizeSampleSize }
      : {})
  });
  const recentReference = (input.downsideReferenceTrades ?? []).slice(-40);
  const candidateGroup = input.candidateSymbol
    ? stockInstrumentRiskProfile(input.candidateSymbol).exposureGroup
    : undefined;
  const themeReference = candidateGroup
    ? recentReference.filter((trade) =>
        trade.symbol &&
        stockInstrumentRiskProfile(trade.symbol).exposureGroup === candidateGroup
      )
    : [];
  const reference = themeReference.length >= 6 ? themeReference : recentReference;
  const downsideReference = reference.length < 6
    ? "NONE"
      : themeReference.length >= 6
      ? "EXPOSURE_GROUP"
      : "GLOBAL";
  if (downsideReference === "NONE") {
    return {
      ...exact,
      exactContextSampleSize: exact.sampleSize,
      downsideReferenceSampleSize: reference.length,
      downsideReference,
      downsideMultiplier: 1
    };
  }
  const meanReturn = average(reference.map((trade) => clamp(trade.returnPercent, -25, 25)));
  const lossRate = reference.filter((trade) => trade.pnlUsd < 0).length / reference.length;
  const severity = clamp(
    Math.max(0, -meanReturn) / 5 + Math.max(0, lossRate - 0.55) * 1.5,
    0,
    1
  );
  const downsideMultiplier = severity > 0 ? clamp(1 - severity * 0.25, 0.75, 1) : 1;
  // A healthy pooled sample is not evidence against an exact context. It must
  // neither create an upsize nor cancel an upsize that the exact, confidence-
  // gated context earned on its own. Only a multiplier below one represents
  // pooled downside evidence that is allowed to override the exact decision.
  if (downsideMultiplier >= 1 || downsideMultiplier >= exact.multiplier) {
    return {
      ...exact,
      exactContextSampleSize: exact.sampleSize,
      downsideReferenceSampleSize: reference.length,
      downsideReference,
      downsideMultiplier
    };
  }
  return {
    ...exact,
    multiplier: downsideMultiplier,
    status: "DOWNSIZED",
    exactContextSampleSize: exact.sampleSize,
    downsideReferenceSampleSize: reference.length,
    downsideReference,
    downsideMultiplier
  };
}

export type StockInstrumentRiskClass =
  | "COMMON_STOCK"
  | "ETF"
  | "LEVERAGED_ETF"
  | "INVERSE_ETF";

export interface StockInstrumentRiskProfile {
  symbol: string;
  riskClass: StockInstrumentRiskClass;
  leverageMultiple: number;
  inverse: boolean;
  exposureGroup: string;
}

export interface StockPortfolioExposure {
  symbol: string;
  notionalUsd: number;
}

export interface StockPositionRiskDecision {
  notionalUsd: number;
  rawRiskSizedUsd: number;
  positionCapUsd: number;
  positionCapNavFraction: number;
  exposureGroup: string;
  groupExposureBeforeUsd: number;
  groupRoomUsd: number;
  volatilityMultiplier: number;
  instrumentMultiplier: number;
  instrument: StockInstrumentRiskProfile;
  learningTier: "WARMUP" | "ESTABLISHED" | "PROVEN";
}

const LEVERAGE_MULTIPLE_BY_SYMBOL: Readonly<Record<string, number>> = Object.freeze({
  BITX: 2,
  BOIL: 2,
  DUST: 2,
  FAS: 3,
  FAZ: 3,
  GUSH: 2,
  DRIP: 2,
  JDST: 2,
  JNUG: 2,
  KOLD: 2,
  LABD: 3,
  LABU: 3,
  NUGT: 2,
  QID: 2,
  QLD: 2,
  SDS: 2,
  SOXL: 3,
  SOXS: 3,
  SPXL: 3,
  SPXS: 3,
  SPXU: 3,
  SQQQ: 3,
  SSO: 2,
  TECL: 3,
  TECS: 3,
  TMF: 3,
  TMV: 3,
  TNA: 3,
  TQQQ: 3,
  TZA: 3,
  UPRO: 3,
  USD: 2,
  YANG: 3,
  YINN: 3
});

const INVERSE_ETFS = new Set([
  "BITI", "DRIP", "DUST", "FAZ", "JDST", "KOLD", "LABD", "QID", "SDS",
  "SOXS", "SPXS", "SPXU", "SQQQ", "TECS", "TMV", "TZA", "YANG"
]);

const UNLEVERAGED_ETFS = new Set([
  "BITO", "DIA", "FXI", "GDX", "HYG", "IWM", "QQQ", "SLV", "SPY", "TLT",
  "XBI", "XLE", "XLF", "XLP", "XLV"
]);

const EXPOSURE_GROUP_MEMBERS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  SEMICONDUCTORS: [
    "AMAT", "AMD", "ARM", "ASML", "AVGO", "DRAM", "INTC", "KLAC", "LRCX",
    "MRVL", "MU", "NVDA", "ON", "QCOM", "SMCI", "SOXL", "SOXS", "TSM", "TXN", "WOLF"
  ],
  CRYPTO_LINKED: [
    "BITF", "BITI", "BITO", "BITX", "CIFR", "CLSK", "COIN", "CORZ", "HUT",
    "IREN", "MARA", "RIOT", "WULF"
  ],
  FINANCIALS: ["BAC", "C", "FAS", "FAZ", "GS", "JPM", "MS", "USB", "WFC", "XLF"],
  ENERGY: ["COP", "CVX", "DRIP", "GUSH", "OXY", "XLE", "XOM"],
  CHINA: ["BABA", "FXI", "JD", "LI", "NIO", "YANG", "YINN"],
  SMALL_CAPS: ["IWM", "TNA", "TZA"],
  BROAD_SP500: ["DIA", "SDS", "SPY", "SPXL", "SPXS", "SPXU", "SSO", "UPRO"],
  NASDAQ_TECH: [
    "AAPL", "AMZN", "CRM", "GOOG", "GOOGL", "META", "MSFT", "NFLX", "ORCL",
    "QID", "QLD", "QQQ", "SQQQ", "TECL", "TECS", "TQQQ"
  ],
  BIOTECH: ["LABD", "LABU", "XBI"],
  METALS_MINERS: ["DUST", "GDX", "JDST", "JNUG", "NUGT", "SLV"],
  RATES_CREDIT: ["HYG", "TLT", "TMF", "TMV"],
  CONSUMER_DEFENSIVE: ["COST", "KO", "PG", "WMT", "XLP"],
  HEALTHCARE: ["ABBV", "LLY", "PFE", "UNH", "XLV"]
});

function exposureGroupForSymbol(symbol: string): string {
  for (const [group, members] of Object.entries(EXPOSURE_GROUP_MEMBERS)) {
    if (members.includes(symbol)) return group;
  }
  return `SYMBOL:${symbol}`;
}

export function stockInstrumentRiskProfile(symbol: string): StockInstrumentRiskProfile {
  const normalized = symbol.trim().toUpperCase();
  const leverageMultiple = LEVERAGE_MULTIPLE_BY_SYMBOL[normalized] ?? 1;
  const inverse = INVERSE_ETFS.has(normalized);
  const riskClass: StockInstrumentRiskClass = inverse
    ? "INVERSE_ETF"
    : leverageMultiple > 1
      ? "LEVERAGED_ETF"
      : UNLEVERAGED_ETFS.has(normalized)
        ? "ETF"
        : "COMMON_STOCK";
  return {
    symbol: normalized,
    riskClass,
    leverageMultiple,
    inverse,
    exposureGroup: exposureGroupForSymbol(normalized)
  };
}

function learningPositionCap(input: {
  policy: StockPaperPolicy;
  learningStatus?: StockPaperLearningStatus;
  learningSampleSize?: number;
}): { fraction: number; tier: StockPositionRiskDecision["learningTier"] } {
  const sampleSize = Math.max(0, Math.floor(input.learningSampleSize ?? 0));
  if (
    input.learningStatus === "UPSIZED" &&
    sampleSize >= input.policy.minimumUpsizeContextTrades
  ) {
    return { fraction: input.policy.maximumPositionNavFraction, tier: "PROVEN" };
  }
  // A pooled downside decision is deliberately allowed to protect a young
  // exact context. Honor that decision before the warmup branch: otherwise a
  // DOWNSIZED context with fewer than eight exact samples receives the full
  // warmup cap and the learner's protection is effectively ignored. Keep a
  // small exploration budget so PAPER continues collecting causal evidence,
  // but prevent repeatedly losing contexts from occupying a large share of
  // NAV while they do so.
  if (input.learningStatus === "DOWNSIZED") {
    return {
      fraction: Math.min(
        input.policy.warmupMaximumPositionNavFraction,
        input.policy.establishedMaximumPositionNavFraction * 0.35,
        input.policy.maximumPositionNavFraction * 0.25
      ),
      tier: "ESTABLISHED"
    };
  }
  if (sampleSize < 8 || input.learningStatus === "WARMING_UP" || !input.learningStatus) {
    return { fraction: input.policy.warmupMaximumPositionNavFraction, tier: "WARMUP" };
  }
  return { fraction: input.policy.establishedMaximumPositionNavFraction, tier: "ESTABLISHED" };
}

export function stockPositionRiskDecision(input: {
  navUsd: number;
  cashUsd: number;
  deployedUsd: number;
  candidate: StockPaperCandidate;
  policy?: StockPaperPolicy;
  armMultiplier?: number;
  learningStatus?: StockPaperLearningStatus;
  learningSampleSize?: number;
  portfolioExposures?: readonly StockPortfolioExposure[];
}): StockPositionRiskDecision {
  const policy = input.policy ?? DEFAULT_STOCK_PAPER_POLICY;
  const instrument = stockInstrumentRiskProfile(input.candidate.symbol);
  const riskFraction = input.candidate.highConviction
    ? policy.highConvictionRiskAtStopNavFraction
    : policy.normalRiskAtStopNavFraction;
  const rawRiskSizedUsd = input.navUsd * riskFraction / (policy.stopLossPercent / 100);
  const learningCap = learningPositionCap({
    policy,
    ...(input.learningStatus ? { learningStatus: input.learningStatus } : {}),
    ...(input.learningSampleSize !== undefined
      ? { learningSampleSize: input.learningSampleSize }
      : {})
  });
  const instrumentCapFraction = instrument.riskClass === "LEVERAGED_ETF" ||
    instrument.riskClass === "INVERSE_ETF"
    ? policy.leveragedMaximumPositionNavFraction
    : policy.maximumPositionNavFraction;
  const positionCapNavFraction = Math.min(
    policy.maximumPositionNavFraction,
    learningCap.fraction,
    instrumentCapFraction
  );
  const positionCapUsd = Math.max(0, input.navUsd * positionCapNavFraction);
  const realizedVolatilityPercent = Math.max(
    0,
    finite(input.candidate.realizedVolatilityPercent)
  );
  const volatilityMultiplier = realizedVolatilityPercent > policy.targetIntradayVolatilityPercent
    ? clamp(
        policy.targetIntradayVolatilityPercent / realizedVolatilityPercent,
        policy.minimumVolatilitySizeMultiplier,
        1
      )
    : 1;
  const instrumentMultiplier = instrument.inverse
    ? policy.inverseInstrumentSizeMultiplier
    : instrument.leverageMultiple > 1
      ? policy.leveragedInstrumentSizeMultiplier
      : 1;
  const armMultiplier = clamp(input.armMultiplier ?? 1, 0.65, 1.15);
  const groupExposureBeforeUsd = (input.portfolioExposures ?? [])
    .filter((exposure) =>
      stockInstrumentRiskProfile(exposure.symbol).exposureGroup === instrument.exposureGroup
    )
    .reduce((sum, exposure) => sum + Math.max(0, finite(exposure.notionalUsd)), 0);
  const groupRoomUsd = Math.max(
    0,
    input.navUsd * policy.maximumExposureGroupNavFraction - groupExposureBeforeUsd
  );
  const deploymentRoom = Math.max(0, input.navUsd * policy.maximumDeployedFraction - input.deployedUsd);
  const cashRoom = Math.max(0, input.cashUsd - policy.minimumCashReserveUsd);
  const riskAdjustedUsd = Math.min(rawRiskSizedUsd, positionCapUsd) *
    armMultiplier *
    volatilityMultiplier *
    instrumentMultiplier;
  const notionalUsd = Math.max(0, Math.min(
    riskAdjustedUsd,
    positionCapUsd,
    groupRoomUsd,
    deploymentRoom,
    cashRoom
  ));
  return {
    notionalUsd,
    rawRiskSizedUsd,
    positionCapUsd,
    positionCapNavFraction,
    exposureGroup: instrument.exposureGroup,
    groupExposureBeforeUsd,
    groupRoomUsd,
    volatilityMultiplier,
    instrumentMultiplier,
    instrument,
    learningTier: learningCap.tier
  };
}

export function stockPositionSize(input: {
  navUsd: number;
  cashUsd: number;
  deployedUsd: number;
  candidate: StockPaperCandidate;
  policy?: StockPaperPolicy;
  armMultiplier?: number;
  learningStatus?: StockPaperLearningStatus;
  learningSampleSize?: number;
  portfolioExposures?: readonly StockPortfolioExposure[];
}): number {
  return stockPositionRiskDecision(input).notionalUsd;
}

export function modeledBuyFill(askPrice: number, spreadPercent: number): number {
  const impactPercent = clamp(0.03 + spreadPercent * 0.12, 0.03, 0.35);
  return askPrice * (1 + impactPercent / 100);
}

export function modeledSellFill(bidPrice: number, spreadPercent: number): number {
  const impactPercent = clamp(0.03 + spreadPercent * 0.12, 0.03, 0.35);
  return bidPrice * (1 - impactPercent / 100);
}

/**
 * Account valuation uses a robust market mark rather than an executable bid.
 * A free IEX snapshot can briefly expose a wide single-exchange quote; taking
 * the median of the quote midpoint, latest trade, and minute close prevents
 * that one quote from manufacturing a false portfolio drawdown. Actual exits
 * continue to use the conservative modeled bid fill.
 */
export function stockMarkPrice(snapshot: AlpacaStockSnapshot): number | undefined {
  const quote = snapshot.latestQuote;
  const quoteMid = quote && quote.bidPrice > 0 && quote.askPrice > 0
    ? (quote.bidPrice + quote.askPrice) / 2
    : undefined;
  const candidates = [
    quoteMid,
    snapshot.latestTrade?.price,
    snapshot.minuteBar?.close
  ].filter((value): value is number => value !== undefined && Number.isFinite(value) && value > 0);
  return median(candidates)
    ?? snapshot.dailyBar?.close
    ?? snapshot.previousDailyBar?.close;
}

export function stockExitDecision(input: {
  position: StockPaperPosition;
  bidPrice: number;
  now: string;
  sessionMinutesRemaining?: number;
  policy?: StockPaperPolicy;
}): StockPaperExitReason | undefined {
  const policy = input.policy ?? DEFAULT_STOCK_PAPER_POLICY;
  if (input.bidPrice <= input.position.stopPriceUsd) return "STOP_LOSS";
  if (input.bidPrice >= input.position.takeProfitPriceUsd) return "TAKE_PROFIT";
  const peakReturn = percentChange(input.position.peakPriceUsd, input.position.entryPriceUsd);
  const drawdownFromPeak = percentChange(input.bidPrice, input.position.peakPriceUsd);
  if (
    peakReturn >= policy.trailingActivationPercent &&
    drawdownFromPeak <= -policy.trailingDrawdownPercent
  ) return "TRAILING_STOP";
  const ageMinutes = (Date.parse(input.now) - Date.parse(input.position.openedAt)) / 60_000;
  if (ageMinutes >= policy.maximumHoldingMinutes) return "MAX_HOLD";
  if (input.sessionMinutesRemaining !== undefined && input.sessionMinutesRemaining <= 10) {
    return "SESSION_END";
  }
  return undefined;
}

function replayVariant(input: {
  bars: readonly AlpacaStockBar[];
  entryPriceUsd: number;
  stopLossPercent: number;
  takeProfitPercent: number;
  trailingPercent: number;
  maximumHoldingBars: number;
}): number | undefined {
  if (input.bars.length === 0 || input.entryPriceUsd <= 0) return undefined;
  let peak = input.entryPriceUsd;
  for (const [index, bar] of input.bars.entries()) {
    peak = Math.max(peak, bar.high);
    const stop = input.entryPriceUsd * (1 - input.stopLossPercent / 100);
    const take = input.entryPriceUsd * (1 + input.takeProfitPercent / 100);
    if (bar.low <= stop) return -input.stopLossPercent;
    if (bar.high >= take) return input.takeProfitPercent;
    const peakReturn = percentChange(peak, input.entryPriceUsd);
    const trailingPrice = peak * (1 - input.trailingPercent / 100);
    if (peakReturn >= 4 && bar.low <= trailingPrice) return percentChange(trailingPrice, input.entryPriceUsd);
    if (index + 1 >= input.maximumHoldingBars) return percentChange(bar.close, input.entryPriceUsd);
  }
  return percentChange(input.bars.at(-1)?.close ?? input.entryPriceUsd, input.entryPriceUsd);
}

export function replayClosedStockTrade(input: {
  bars: readonly AlpacaStockBar[];
  entryPriceUsd: number;
  actualReturnPercent: number;
  generatedAt: string;
}): StockPaperReplaySummary {
  const results: Array<{
    returnPercent: number;
    stop: number;
    take: number;
    trailing: number;
  }> = [];
  for (let stopIndex = 0; stopIndex < 10; stopIndex += 1) {
    for (let takeIndex = 0; takeIndex < 10; takeIndex += 1) {
      for (let trailIndex = 0; trailIndex < 10; trailIndex += 1) {
        const stop = 3 + stopIndex;
        const take = 4 + takeIndex * 2;
        const trailing = 2 + trailIndex * 0.75;
        const returnPercent = replayVariant({
          bars: input.bars,
          entryPriceUsd: input.entryPriceUsd,
          stopLossPercent: stop,
          takeProfitPercent: take,
          trailingPercent: trailing,
          maximumHoldingBars: 60 + ((stopIndex + takeIndex + trailIndex) % 6) * 30
        });
        if (returnPercent !== undefined) results.push({ returnPercent, stop, take, trailing });
      }
    }
  }
  const ordered = [...results].sort((left, right) => left.returnPercent - right.returnPercent);
  const best = ordered.at(-1);
  const belowOrEqual = ordered.filter((result) => result.returnPercent <= input.actualReturnPercent).length;
  return {
    variantCount: 1000,
    scorableVariantCount: ordered.length,
    profitableVariantCount: ordered.filter((result) => result.returnPercent > 0).length,
    actualReturnPercent: input.actualReturnPercent,
    actualPercentile: ordered.length > 0 ? belowOrEqual / ordered.length * 100 : 0,
    bestReturnPercent: best?.returnPercent ?? input.actualReturnPercent,
    bestStopLossPercent: best?.stop ?? DEFAULT_STOCK_PAPER_POLICY.stopLossPercent,
    bestTakeProfitPercent: best?.take ?? DEFAULT_STOCK_PAPER_POLICY.takeProfitPercent,
    bestTrailingPercent: best?.trailing ?? DEFAULT_STOCK_PAPER_POLICY.trailingDrawdownPercent,
    generatedAt: input.generatedAt
  };
}
