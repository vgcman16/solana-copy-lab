import { createHash } from "node:crypto";

/**
 * Analysis-only stock learning diagnostics. Nothing in this module can place,
 * size, approve, cancel, or promote an order. Its output is deliberately
 * versioned so a later report can always identify the exact replay model.
 */
export const STOCK_PAPER_LEARNING_V4_VERSION = "stock-paper-learning-v4-analysis" as const;
export const STOCK_PAPER_LEARNING_V4_REPLAY_VERSION = "stock-paper-portfolio-replay-v1" as const;
export const STOCK_PAPER_LEARNING_V4_BOOTSTRAP_VERSION = "stock-paper-day-block-bootstrap-v1" as const;
export const STOCK_PAPER_LEARNING_V4_DATASET_SCHEMA_VERSION =
  "stock-paper-learning-v4-evidence-v2" as const;

export type StockPaperMarketRegimeV4 =
  | "UP_LOW_VOL"
  | "UP_HIGH_VOL"
  | "DOWN_LOW_VOL"
  | "DOWN_HIGH_VOL"
  | "SIDEWAYS_LOW_VOL"
  | "SIDEWAYS_HIGH_VOL"
  | "INSUFFICIENT_HISTORY";

export interface StockPaperAnalysisTradeV4 {
  id: string;
  laneId: string;
  symbol: string;
  sector?: string;
  arm: string;
  phase: string;
  feed: string;
  policyVersion: string;
  featureVersion: string;
  executionVersion: string;
  tradeDayKey: string;
  openedAt: string;
  closedAt: string;
  notionalUsd: number;
  netReturnPercent: number;
  /** Benchmark return over the same causal holding interval. */
  spyReturnPercent: number;
}

export interface StockPaperDailyReturnV4 {
  symbol: string;
  dateKey: string;
  returnPercent: number;
  adjusted: true;
  session: "REGULAR";
  coveragePercent: number;
}

export interface StockPaperLearningV4Config {
  initialNavUsd: number;
  bootstrapReplicates: number;
  bootstrapBlockDays: number;
  regimeLookbackDays: number;
  regimeTrendThresholdPercent: number;
  regimeHighVolatilityPercent: number;
  driftMinimumDaysPerWindow: number;
  driftMaterialityPercent: number;
  minimumCorrelationOverlapDays: number;
}

export const DEFAULT_STOCK_PAPER_LEARNING_V4_CONFIG: Readonly<StockPaperLearningV4Config> =
  Object.freeze({
    initialNavUsd: 141,
    bootstrapReplicates: 500,
    bootstrapBlockDays: 5,
    regimeLookbackDays: 20,
    regimeTrendThresholdPercent: 1,
    regimeHighVolatilityPercent: 1.5,
    driftMinimumDaysPerWindow: 5,
    driftMaterialityPercent: 0.25,
    minimumCorrelationOverlapDays: 5
  });

export interface StockPaperReplayPointV4 {
  /** Trades sharing one close instant are booked atomically. This prevents an
   * arbitrary id ordering from manufacturing an intrabatch drawdown. */
  tradeIds: readonly string[];
  symbols: readonly string[];
  closedAt: string;
  pnlUsd: number;
  navUsd: number;
  drawdownPercent: number;
}

export interface StockPaperPortfolioReplayV4 {
  version: typeof STOCK_PAPER_LEARNING_V4_REPLAY_VERSION;
  realizedPathOnly: true;
  portfolioCounterfactual: false;
  fixedHistoricalNotionals: true;
  initialNavUsd: number;
  endingNavUsd: number;
  totalPnlUsd: number;
  returnPercent: number;
  maximumDrawdownPercent: number;
  maximumConcurrentPositions: number;
  maximumGrossExposureUsd: number;
  points: readonly StockPaperReplayPointV4[];
}

export interface StockPaperCorrelationPairV4 {
  leftSymbol: string;
  rightSymbol: string;
  /** Strict upper bound on return evidence. The entry-day return itself is
   * excluded because it was not known when the exposure was opened. */
  asOfTradeDayKey: string;
  overlapDays: number;
  status: "AVAILABLE" | "INSUFFICIENT_OVERLAP" | "ZERO_VARIANCE";
  correlation?: number;
}

export interface StockPaperCorrelationContextV4 {
  pairs: readonly StockPaperCorrelationPairV4[];
  pairCoveragePercent: number;
  highestPositivePair?: StockPaperCorrelationPairV4;
  concurrentExposureWeightedCorrelation?: number;
  concurrentPairCount: number;
  concurrentPairUnavailableCount: number;
}

export interface StockPaperRegimePerformanceV4 {
  regime: StockPaperMarketRegimeV4;
  tradeCount: number;
  pnlUsd: number;
  meanNetReturnPercent: number;
  meanSpyExcessPercent: number;
  winRatePercent: number;
}

export interface StockPaperSectorPerformanceV4 {
  sector: string;
  tradeCount: number;
  notionalUsd: number;
  pnlUsd: number;
  /** Nonnegative share of total absolute sector P&L magnitude. */
  absolutePnlSharePercent: number;
  meanSpyExcessPercent: number;
}

export interface StockPaperSpyExcessV4 {
  tradeCount: number;
  strategyPnlUsd: number;
  benchmarkEquivalentPnlUsd: number;
  excessPnlUsd: number;
  notionalWeightedStrategyReturnPercent: number;
  notionalWeightedSpyReturnPercent: number;
  notionalWeightedExcessReturnPercent: number;
  excessWinRatePercent: number;
}

export interface StockPaperBlockBootstrapV4 {
  version: typeof STOCK_PAPER_LEARNING_V4_BOOTSTRAP_VERSION;
  replicates: number;
  blockDays: number;
  fixedHistoricalNotionals: true;
  activeTradeDays: number;
  returnPercentP05: number;
  returnPercentP50: number;
  returnPercentP95: number;
  excessReturnPercentP05: number;
  excessReturnPercentP50: number;
  excessReturnPercentP95: number;
  probabilityPositiveReturnPercent: number;
  probabilityPositiveExcessPercent: number;
}

export type StockPaperDriftStatusV4 =
  | "INSUFFICIENT_HISTORY"
  | "IMPROVING"
  | "STABLE"
  | "DETERIORATING";

export interface StockPaperDriftV4 {
  status: StockPaperDriftStatusV4;
  earlyDayCount: number;
  recentDayCount: number;
  earlyMeanNetReturnPercent: number;
  recentMeanNetReturnPercent: number;
  netReturnDeltaPercent: number;
  earlyMeanSpyExcessPercent: number;
  recentMeanSpyExcessPercent: number;
  spyExcessDeltaPercent: number;
  earlyWinRatePercent: number;
  recentWinRatePercent: number;
  symbolMixJensenShannonDivergence: number;
}

export interface StockPaperLearningDiagnosticsV4 {
  tradeCount: number;
  uniqueSymbols: number;
  uniqueTradeDays: number;
  missingSectorTrades: number;
  dailyReturnSymbols: number;
  spyHistoryDays: number;
  warnings: readonly string[];
}

export interface StockPaperLearningProvenanceV4 {
  datasetSchemaVersion: typeof STOCK_PAPER_LEARNING_V4_DATASET_SCHEMA_VERSION;
  analysisVersion: typeof STOCK_PAPER_LEARNING_V4_VERSION;
  replayVersion: typeof STOCK_PAPER_LEARNING_V4_REPLAY_VERSION;
  bootstrapVersion: typeof STOCK_PAPER_LEARNING_V4_BOOTSTRAP_VERSION;
  sourceLaneId: string | null;
  policyVersion: string | null;
  featureVersion: string | null;
  executionVersion: string | null;
  adjustedRegularSessionReturnsOnly: true;
  cutoffIndependentDatasetSeed: true;
}

export interface StockPaperLearningAnalysisV4 {
  version: typeof STOCK_PAPER_LEARNING_V4_VERSION;
  analysisOnly: true;
  affectsTrading: false;
  promotionEligible: false;
  portfolioCounterfactual: false;
  cutoffAt: string;
  datasetDigest: string;
  provenance: Readonly<StockPaperLearningProvenanceV4>;
  config: Readonly<StockPaperLearningV4Config>;
  replay: Readonly<StockPaperPortfolioReplayV4>;
  spyExcess: Readonly<StockPaperSpyExcessV4>;
  correlations: Readonly<StockPaperCorrelationContextV4>;
  regimePerformance: readonly StockPaperRegimePerformanceV4[];
  sectorPerformance: readonly StockPaperSectorPerformanceV4[];
  bootstrap: Readonly<StockPaperBlockBootstrapV4>;
  drift: Readonly<StockPaperDriftV4>;
  diagnostics: Readonly<StockPaperLearningDiagnosticsV4>;
  outputDigest: string;
}

export interface AnalyzeStockPaperLearningV4Input {
  cutoffAt: string;
  trades: readonly StockPaperAnalysisTradeV4[];
  dailyReturns: readonly StockPaperDailyReturnV4[];
  config?: Partial<StockPaperLearningV4Config>;
}

interface NormalizedDatasetV4 {
  trades: StockPaperAnalysisTradeV4[];
  dailyReturns: StockPaperDailyReturnV4[];
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  ).join(",")}}`;
}

function digest(namespace: string, value: unknown): string {
  return createHash("sha256").update(`${namespace}:${canonicalJson(value)}`).digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function finite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite.`);
  return value;
}

function positive(value: number, label: string): number {
  finite(value, label);
  if (value <= 0) throw new Error(`${label} must be positive.`);
  return value;
}

function safeAdd(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isFinite(result)) throw new Error(`${label} overflowed finite arithmetic.`);
  return result;
}

function safeMultiply(left: number, right: number, label: string): number {
  const result = left * right;
  if (!Number.isFinite(result)) throw new Error(`${label} overflowed finite arithmetic.`);
  return result;
}

function safeDivide(numerator: number, denominator: number, label: string): number {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    throw new Error(`${label} cannot divide nonfinite evidence or zero.`);
  }
  const result = numerator / denominator;
  if (!Number.isFinite(result)) throw new Error(`${label} overflowed finite arithmetic.`);
  return result;
}

function sum(values: readonly number[], label: string): number {
  return values.reduce((total, value) => safeAdd(total, finite(value, label), label), 0);
}

function pnlFor(trade: StockPaperAnalysisTradeV4, label = `Trade ${trade.id} P&L`): number {
  return safeDivide(
    safeMultiply(trade.notionalUsd, trade.netReturnPercent, label),
    100,
    label
  );
}

function excessPnlFor(trade: StockPaperAnalysisTradeV4): number {
  return safeDivide(
    safeMultiply(
      trade.notionalUsd,
      safeAdd(trade.netReturnPercent, -trade.spyReturnPercent, `Trade ${trade.id} excess return`),
      `Trade ${trade.id} excess P&L`
    ),
    100,
    `Trade ${trade.id} excess P&L`
  );
}

function bounded(value: number, label: string, minimum: number, maximum: number): number {
  finite(value, label);
  if (value < minimum || value > maximum) {
    throw new Error(`${label} must be from ${minimum} through ${maximum}.`);
  }
  return value;
}

function integer(value: number, label: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

function isoTimestamp(value: string, label: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-](\d{2}):(\d{2}))$/u.exec(value);
  const hour = Number(match?.[2]);
  const minute = Number(match?.[3]);
  const second = Number(match?.[4]);
  const offsetHour = match?.[5] === "Z" ? 0 : Number(match?.[6]);
  const offsetMinute = match?.[5] === "Z" ? 0 : Number(match?.[7]);
  const validOffset = offsetHour < 14 || (offsetHour === 14 && offsetMinute === 0);
  if (!match || !validCalendarDate(match[1] ?? "") || hour > 23 || minute > 59 || second > 59 ||
      offsetHour > 14 || offsetMinute > 59 || !validOffset) {
    throw new Error(`${label} must be an ISO timestamp with an explicit timezone offset.`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a valid timestamp.`);
  return new Date(parsed).toISOString();
}

function validCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return false;
  const canonical = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
    .toISOString().slice(0, 10);
  return canonical === value;
}

function dateKey(value: string, label: string): string {
  if (!validCalendarDate(value)) {
    throw new Error(`${label} must be a YYYY-MM-DD date.`);
  }
  return value;
}

function newYorkTradeDayKey(timestamp: string): string {
  const instant = new Date(timestamp);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value ?? "";
  const localDate = `${part("year")}-${part("month")}-${part("day")}`;
  const minutes = Number(part("hour")) * 60 + Number(part("minute"));
  if (minutes < 1_200) return localDate;
  const next = new Date(`${localDate}T12:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

function symbol(value: string, label: string): string {
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(normalized)) throw new Error(`${label} is invalid.`);
  return normalized;
}

function round(value: number, digits = 10): number {
  finite(value, "Rounded analysis value");
  const factor = 10 ** digits;
  const scaled = safeMultiply(value + Number.EPSILON, factor, "Rounded analysis value");
  return Math.round(scaled) / factor;
}

function mean(values: readonly number[]): number {
  return values.length > 0 ? safeDivide(sum(values, "Analysis mean"), values.length, "Analysis mean") : 0;
}

function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const rank = Math.max(0, Math.min(ordered.length - 1, (ordered.length - 1) * quantile));
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  const weight = rank - lower;
  return (ordered[lower] ?? 0) * (1 - weight) + (ordered[upper] ?? 0) * weight;
}

function config(input?: Partial<StockPaperLearningV4Config>): StockPaperLearningV4Config {
  const value = { ...DEFAULT_STOCK_PAPER_LEARNING_V4_CONFIG, ...input };
  bounded(value.initialNavUsd, "Initial NAV", 0.01, 1_000_000_000_000);
  integer(value.bootstrapReplicates, "Bootstrap replicates", 50, 5_000);
  integer(value.bootstrapBlockDays, "Bootstrap block days", 1, 60);
  integer(value.regimeLookbackDays, "Regime lookback days", 3, 252);
  positive(value.regimeTrendThresholdPercent, "Regime trend threshold");
  positive(value.regimeHighVolatilityPercent, "Regime volatility threshold");
  integer(value.driftMinimumDaysPerWindow, "Drift minimum days", 2, 252);
  positive(value.driftMaterialityPercent, "Drift materiality");
  integer(value.minimumCorrelationOverlapDays, "Correlation overlap days", 3, 252);
  return value;
}

function normalizeDataset(
  input: AnalyzeStockPaperLearningV4Input,
  cutoffAt: string
): NormalizedDatasetV4 {
  const cutoffMs = Date.parse(cutoffAt);
  const tradeIds = new Set<string>();
  const trades = input.trades.map((trade, index) => {
    const id = trade.id.trim();
    if (!id) throw new Error(`Trade ${index + 1} id is required.`);
    if (tradeIds.has(id)) throw new Error(`Duplicate trade id: ${id}.`);
    tradeIds.add(id);
    const openedAt = isoTimestamp(trade.openedAt, `Trade ${id} openedAt`);
    const closedAt = isoTimestamp(trade.closedAt, `Trade ${id} closedAt`);
    if (Date.parse(closedAt) <= Date.parse(openedAt)) throw new Error(`Trade ${id} must close after it opens.`);
    if (Date.parse(closedAt) > cutoffMs) throw new Error(`Trade ${id} was not knowable at the cutoff.`);
    const normalizedTradeDay = dateKey(trade.tradeDayKey, `Trade ${id} trade day`);
    if (normalizedTradeDay !== newYorkTradeDayKey(openedAt)) {
      throw new Error(`Trade ${id} trade day does not match its causal opening clock.`);
    }
    const netReturnPercent = bounded(trade.netReturnPercent, `Trade ${id} return`, -100, 10_000);
    const spyReturnPercent = bounded(trade.spyReturnPercent, `Trade ${id} SPY return`, -100, 10_000);
    const required = (value: string, label: string): string => {
      const normalizedValue = value.trim().toUpperCase();
      if (!normalizedValue || normalizedValue.length > 100) throw new Error(`${label} is invalid.`);
      return normalizedValue;
    };
    const normalized: StockPaperAnalysisTradeV4 = {
      id,
      laneId: trade.laneId.trim(),
      symbol: symbol(trade.symbol, `Trade ${id} symbol`),
      arm: required(trade.arm, `Trade ${id} arm`),
      phase: required(trade.phase, `Trade ${id} phase`),
      feed: required(trade.feed, `Trade ${id} feed`),
      policyVersion: required(trade.policyVersion, `Trade ${id} policy version`),
      featureVersion: required(trade.featureVersion, `Trade ${id} feature version`),
      executionVersion: required(trade.executionVersion, `Trade ${id} execution version`),
      tradeDayKey: normalizedTradeDay,
      openedAt,
      closedAt,
      notionalUsd: bounded(trade.notionalUsd, `Trade ${id} notional`, 0.00000001, 1_000_000_000),
      netReturnPercent,
      spyReturnPercent,
      ...(trade.sector?.trim() ? { sector: trade.sector.trim().toUpperCase() } : {})
    };
    if (!normalized.laneId || normalized.laneId.length > 200) throw new Error(`Trade ${id} lane is invalid.`);
    return normalized;
  }).sort((left, right) =>
    left.closedAt.localeCompare(right.closedAt) || left.id.localeCompare(right.id)
  );
  for (const [label, values] of [
    ["lane", new Set(trades.map((trade) => trade.laneId))],
    ["policy version", new Set(trades.map((trade) => trade.policyVersion))],
    ["feature version", new Set(trades.map((trade) => trade.featureVersion))],
    ["execution version", new Set(trades.map((trade) => trade.executionVersion))]
  ] as const) {
    if (values.size > 1) throw new Error(`Stock learning-v4 cannot blend more than one ${label}.`);
  }

  const returnKeys = new Set<string>();
  const dailyReturns = input.dailyReturns.map((entry, index) => {
    const normalizedSymbol = symbol(entry.symbol, `Daily return ${index + 1} symbol`);
    const normalizedDate = dateKey(entry.dateKey, `Daily return ${index + 1} date`);
    if (Date.parse(`${normalizedDate}T23:59:59.999Z`) > cutoffMs) {
      throw new Error(`Daily return ${normalizedSymbol}:${normalizedDate} is beyond the cutoff.`);
    }
    const key = `${normalizedSymbol}:${normalizedDate}`;
    if (returnKeys.has(key)) throw new Error(`Duplicate daily return: ${key}.`);
    returnKeys.add(key);
    if (entry.adjusted !== true || entry.session !== "REGULAR" ||
        !Number.isFinite(entry.coveragePercent) || entry.coveragePercent < 95 ||
        entry.coveragePercent > 100) {
      throw new Error(`Daily return ${key} must be adjusted aligned regular-session evidence with at least 95% coverage.`);
    }
    const returnPercent = bounded(entry.returnPercent, `Daily return ${key}`, -100, 1_000);
    return {
      symbol: normalizedSymbol,
      dateKey: normalizedDate,
      returnPercent,
      adjusted: true as const,
      session: "REGULAR" as const,
      coveragePercent: entry.coveragePercent
    };
  }).sort((left, right) =>
    left.dateKey.localeCompare(right.dateKey) || left.symbol.localeCompare(right.symbol)
  );
  return { trades, dailyReturns };
}

function replayPortfolio(
  trades: readonly StockPaperAnalysisTradeV4[],
  initialNavUsd: number
): StockPaperPortfolioReplayV4 {
  let navUsd = initialNavUsd;
  let peakNavUsd = initialNavUsd;
  let maximumDrawdownPercent = 0;
  const points: StockPaperReplayPointV4[] = [];
  const closeTimes = [...new Set(trades.map((trade) => trade.closedAt))].sort();
  for (const closedAt of closeTimes) {
    const batch = trades.filter((trade) => trade.closedAt === closedAt)
      .sort((left, right) => left.id.localeCompare(right.id));
    const tradePnls = batch.map((trade) => pnlFor(trade));
    const batchPnlUsd = sum(tradePnls, "Same-time close batch P&L");
    navUsd = safeAdd(navUsd, batchPnlUsd, "Portfolio replay NAV");
    peakNavUsd = Math.max(peakNavUsd, navUsd);
    const drawdownPercent = peakNavUsd > 0
      ? safeMultiply(
          safeDivide(peakNavUsd - navUsd, peakNavUsd, "Portfolio replay drawdown"),
          100,
          "Portfolio replay drawdown"
        )
      : 0;
    maximumDrawdownPercent = Math.max(maximumDrawdownPercent, drawdownPercent);
    points.push({
      tradeIds: batch.map((trade) => trade.id),
      symbols: [...new Set(batch.map((trade) => trade.symbol))].sort(),
      closedAt,
      pnlUsd: round(batchPnlUsd),
      navUsd: round(navUsd),
      drawdownPercent: round(drawdownPercent)
    });
  }

  const exposureEvents = trades.flatMap((trade) => [
    { at: trade.openedAt, kind: "OPEN" as const, id: trade.id, notionalUsd: trade.notionalUsd },
    { at: trade.closedAt, kind: "CLOSE" as const, id: trade.id, notionalUsd: trade.notionalUsd }
  ]).sort((left, right) =>
    left.at.localeCompare(right.at) ||
    (left.kind === right.kind ? left.id.localeCompare(right.id) : left.kind === "CLOSE" ? -1 : 1)
  );
  let concurrent = 0;
  let grossExposureUsd = 0;
  let maximumConcurrentPositions = 0;
  let maximumGrossExposureUsd = 0;
  for (const event of exposureEvents) {
    if (event.kind === "OPEN") {
      concurrent += 1;
      grossExposureUsd = safeAdd(grossExposureUsd, event.notionalUsd, "Portfolio gross exposure");
    } else {
      concurrent = Math.max(0, concurrent - 1);
      grossExposureUsd = Math.max(0, grossExposureUsd - event.notionalUsd);
    }
    maximumConcurrentPositions = Math.max(maximumConcurrentPositions, concurrent);
    maximumGrossExposureUsd = Math.max(maximumGrossExposureUsd, grossExposureUsd);
  }
  const totalPnlUsd = navUsd - initialNavUsd;
  return {
    version: STOCK_PAPER_LEARNING_V4_REPLAY_VERSION,
    realizedPathOnly: true,
    portfolioCounterfactual: false,
    fixedHistoricalNotionals: true,
    initialNavUsd: round(initialNavUsd),
    endingNavUsd: round(navUsd),
    totalPnlUsd: round(totalPnlUsd),
    returnPercent: round(safeMultiply(
      safeDivide(totalPnlUsd, initialNavUsd, "Portfolio replay return"),
      100,
      "Portfolio replay return"
    )),
    maximumDrawdownPercent: round(maximumDrawdownPercent),
    maximumConcurrentPositions,
    maximumGrossExposureUsd: round(maximumGrossExposureUsd),
    points
  };
}

function spyExcess(trades: readonly StockPaperAnalysisTradeV4[]): StockPaperSpyExcessV4 {
  const totalNotional = sum(trades.map((trade) => trade.notionalUsd), "Total analyzed notional");
  const strategyPnlUsd = sum(trades.map((trade) => pnlFor(trade)), "Strategy P&L");
  const benchmarkEquivalentPnlUsd = sum(trades.map((trade) => safeDivide(
    safeMultiply(trade.notionalUsd, trade.spyReturnPercent, `Trade ${trade.id} benchmark P&L`),
    100,
    `Trade ${trade.id} benchmark P&L`
  )), "Benchmark-equivalent P&L");
  const excessPnlUsd = safeAdd(strategyPnlUsd, -benchmarkEquivalentPnlUsd, "SPY excess P&L");
  return {
    tradeCount: trades.length,
    strategyPnlUsd: round(strategyPnlUsd),
    benchmarkEquivalentPnlUsd: round(benchmarkEquivalentPnlUsd),
    excessPnlUsd: round(excessPnlUsd),
    notionalWeightedStrategyReturnPercent: round(totalNotional > 0
      ? safeMultiply(safeDivide(strategyPnlUsd, totalNotional, "Weighted strategy return"), 100, "Weighted strategy return")
      : 0),
    notionalWeightedSpyReturnPercent: round(totalNotional > 0
      ? safeMultiply(safeDivide(benchmarkEquivalentPnlUsd, totalNotional, "Weighted SPY return"), 100, "Weighted SPY return")
      : 0),
    notionalWeightedExcessReturnPercent: round(
      totalNotional > 0
        ? safeMultiply(safeDivide(excessPnlUsd, totalNotional, "Weighted SPY excess"), 100, "Weighted SPY excess")
        : 0
    ),
    excessWinRatePercent: round(
      trades.length > 0
        ? trades.filter((trade) => trade.netReturnPercent > trade.spyReturnPercent).length / trades.length * 100
        : 0
    )
  };
}

function pearson(left: readonly number[], right: readonly number[]): number | undefined {
  if (left.length !== right.length || left.length < 2) return undefined;
  const leftMean = mean(left);
  const rightMean = mean(right);
  let covariance = 0;
  let leftVariance = 0;
  let rightVariance = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftDelta = (left[index] ?? 0) - leftMean;
    const rightDelta = (right[index] ?? 0) - rightMean;
    covariance += leftDelta * rightDelta;
    leftVariance += leftDelta ** 2;
    rightVariance += rightDelta ** 2;
  }
  if (leftVariance <= Number.EPSILON || rightVariance <= Number.EPSILON) return undefined;
  const denominator = Math.sqrt(safeMultiply(leftVariance, rightVariance, "Correlation variance"));
  if (!Number.isFinite(denominator) || denominator <= 0) return undefined;
  return Math.max(-1, Math.min(1, safeDivide(covariance, denominator, "Correlation")));
}

function correlationPair(
  leftSymbol: string,
  rightSymbol: string,
  asOfTradeDayKey: string,
  bySymbol: ReadonlyMap<string, ReadonlyMap<string, number>>,
  minimumOverlapDays: number
): StockPaperCorrelationPairV4 {
  const leftSeries = bySymbol.get(leftSymbol) ?? new Map<string, number>();
  const rightSeries = bySymbol.get(rightSymbol) ?? new Map<string, number>();
  const dates = [...leftSeries.keys()].filter((date) =>
    date < asOfTradeDayKey && rightSeries.has(date)
  ).sort();
  const base = { leftSymbol, rightSymbol, asOfTradeDayKey, overlapDays: dates.length };
  if (dates.length < minimumOverlapDays) {
    return { ...base, status: "INSUFFICIENT_OVERLAP" };
  }
  const correlation = pearson(
    dates.map((date) => leftSeries.get(date) ?? 0),
    dates.map((date) => rightSeries.get(date) ?? 0)
  );
  return correlation === undefined
    ? { ...base, status: "ZERO_VARIANCE" }
    : { ...base, status: "AVAILABLE", correlation: round(correlation) };
}

function correlationContext(
  trades: readonly StockPaperAnalysisTradeV4[],
  dailyReturns: readonly StockPaperDailyReturnV4[],
  minimumOverlapDays: number
): StockPaperCorrelationContextV4 {
  const bySymbol = new Map<string, Map<string, number>>();
  for (const entry of dailyReturns) {
    const series = bySymbol.get(entry.symbol) ?? new Map<string, number>();
    series.set(entry.dateKey, entry.returnPercent);
    bySymbol.set(entry.symbol, series);
  }
  const symbols = [...new Set(trades.map((trade) => trade.symbol))].sort();
  const firstTradeDay = new Map(symbols.map((entry) => [
    entry,
    trades.filter((trade) => trade.symbol === entry)
      .map((trade) => trade.tradeDayKey)
      .sort()[0]!
  ]));
  const pairs: StockPaperCorrelationPairV4[] = [];
  for (let leftIndex = 0; leftIndex < symbols.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < symbols.length; rightIndex += 1) {
      const leftSymbol = symbols[leftIndex]!;
      const rightSymbol = symbols[rightIndex]!;
      const asOfTradeDayKey = [firstTradeDay.get(leftSymbol)!, firstTradeDay.get(rightSymbol)!]
        .sort().at(-1)!;
      pairs.push(correlationPair(
        leftSymbol,
        rightSymbol,
        asOfTradeDayKey,
        bySymbol,
        minimumOverlapDays
      ));
    }
  }
  let weightedCorrelation = 0;
  let totalWeight = 0;
  let concurrentPairCount = 0;
  let concurrentPairUnavailableCount = 0;
  for (let leftIndex = 0; leftIndex < trades.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < trades.length; rightIndex += 1) {
      const left = trades[leftIndex]!;
      const right = trades[rightIndex]!;
      if (left.symbol === right.symbol || left.closedAt <= right.openedAt || right.closedAt <= left.openedAt) continue;
      const [leftSymbol, rightSymbol] = [left.symbol, right.symbol].sort() as [string, string];
      const pair = correlationPair(
        leftSymbol,
        rightSymbol,
        [left.tradeDayKey, right.tradeDayKey].sort().at(-1)!,
        bySymbol,
        minimumOverlapDays
      );
      if (pair.status !== "AVAILABLE" || pair.correlation === undefined) {
        concurrentPairUnavailableCount += 1;
        continue;
      }
      const weight = Math.min(left.notionalUsd, right.notionalUsd);
      weightedCorrelation = safeAdd(
        weightedCorrelation,
        safeMultiply(pair.correlation, weight, "Concurrent correlation weight"),
        "Concurrent correlation weight"
      );
      totalWeight = safeAdd(totalWeight, weight, "Concurrent correlation weight");
      concurrentPairCount += 1;
    }
  }
  const possiblePairs = symbols.length * (symbols.length - 1) / 2;
  const availablePairs = pairs.filter((pair) =>
    pair.status === "AVAILABLE" && pair.correlation !== undefined
  );
  const highestPositivePair = availablePairs.filter((pair) => (pair.correlation ?? 0) > 0).sort((left, right) =>
    (right.correlation ?? 0) - (left.correlation ?? 0) ||
    left.leftSymbol.localeCompare(right.leftSymbol) ||
    left.rightSymbol.localeCompare(right.rightSymbol)
  ).at(0);
  return {
    pairs,
    pairCoveragePercent: round(possiblePairs > 0 ? availablePairs.length / possiblePairs * 100 : 100),
    ...(highestPositivePair ? { highestPositivePair } : {}),
    ...(totalWeight > 0 ? { concurrentExposureWeightedCorrelation: round(weightedCorrelation / totalWeight) } : {}),
    concurrentPairCount,
    concurrentPairUnavailableCount
  };
}

function standardDeviation(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const valueMean = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - valueMean) ** 2, 0) / (values.length - 1));
}

function marketRegime(
  tradeDayKey: string,
  spyReturns: readonly StockPaperDailyReturnV4[],
  settings: StockPaperLearningV4Config
): StockPaperMarketRegimeV4 {
  const prior = spyReturns.filter((entry) => entry.dateKey < tradeDayKey).slice(-settings.regimeLookbackDays);
  if (prior.length < Math.min(5, settings.regimeLookbackDays)) return "INSUFFICIENT_HISTORY";
  const growth = prior.reduce((current, entry) => safeMultiply(
    current,
    safeAdd(1, safeDivide(entry.returnPercent, 100, "Regime daily return"), "Regime growth factor"),
    "Regime compounded return"
  ), 1);
  const compounded = safeMultiply(growth - 1, 100, "Regime compounded return");
  const volatility = standardDeviation(prior.map((entry) => entry.returnPercent));
  const direction = compounded > settings.regimeTrendThresholdPercent
    ? "UP"
    : compounded < -settings.regimeTrendThresholdPercent
      ? "DOWN"
      : "SIDEWAYS";
  const volatilityLabel = volatility >= settings.regimeHighVolatilityPercent ? "HIGH_VOL" : "LOW_VOL";
  return `${direction}_${volatilityLabel}` as StockPaperMarketRegimeV4;
}

function groupPerformance(
  trades: readonly StockPaperAnalysisTradeV4[],
  keyFor: (trade: StockPaperAnalysisTradeV4) => string
): Array<{ key: string; trades: StockPaperAnalysisTradeV4[] }> {
  const groups = new Map<string, StockPaperAnalysisTradeV4[]>();
  for (const trade of trades) {
    const key = keyFor(trade);
    groups.set(key, [...(groups.get(key) ?? []), trade]);
  }
  return [...groups].sort(([left], [right]) => left.localeCompare(right)).map(([key, grouped]) => ({ key, trades: grouped }));
}

function regimePerformance(
  trades: readonly StockPaperAnalysisTradeV4[],
  dailyReturns: readonly StockPaperDailyReturnV4[],
  settings: StockPaperLearningV4Config
): StockPaperRegimePerformanceV4[] {
  const spy = dailyReturns.filter((entry) => entry.symbol === "SPY");
  return groupPerformance(trades, (trade) => marketRegime(trade.tradeDayKey, spy, settings)).map((group) => ({
    regime: group.key as StockPaperMarketRegimeV4,
    tradeCount: group.trades.length,
    pnlUsd: round(sum(group.trades.map((trade) => pnlFor(trade)), `Regime ${group.key} P&L`)),
    meanNetReturnPercent: round(mean(group.trades.map((trade) => trade.netReturnPercent))),
    meanSpyExcessPercent: round(mean(group.trades.map(
      (trade) => trade.netReturnPercent - trade.spyReturnPercent
    ))),
    winRatePercent: round(group.trades.filter((trade) => trade.netReturnPercent > 0).length / group.trades.length * 100)
  }));
}

function sectorPerformance(trades: readonly StockPaperAnalysisTradeV4[]): StockPaperSectorPerformanceV4[] {
  const groups = groupPerformance(trades, (trade) => trade.sector ?? "UNKNOWN").map((group) => ({
    ...group,
    pnlUsd: sum(group.trades.map((trade) => pnlFor(trade)), `Sector ${group.key} P&L`)
  }));
  const totalAbsolutePnl = sum(groups.map((group) => Math.abs(group.pnlUsd)), "Total absolute sector P&L");
  return groups.map((group) => {
    return {
      sector: group.key,
      tradeCount: group.trades.length,
      notionalUsd: round(sum(group.trades.map((trade) => trade.notionalUsd), `Sector ${group.key} notional`)),
      pnlUsd: round(group.pnlUsd),
      absolutePnlSharePercent: round(totalAbsolutePnl > 0
        ? safeMultiply(
            safeDivide(Math.abs(group.pnlUsd), totalAbsolutePnl, `Sector ${group.key} absolute P&L share`),
            100,
            `Sector ${group.key} absolute P&L share`
          )
        : 0),
      meanSpyExcessPercent: round(mean(group.trades.map(
        (trade) => trade.netReturnPercent - trade.spyReturnPercent
      )))
    };
  });
}

function seededRandom(seedHex: string): () => number {
  let state = Number.parseInt(seedHex.slice(0, 8), 16) >>> 0;
  if (state === 0) state = 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function blockBootstrap(
  trades: readonly StockPaperAnalysisTradeV4[],
  settings: StockPaperLearningV4Config,
  seed: string
): StockPaperBlockBootstrapV4 {
  const dayKeys = [...new Set(trades.map((trade) => trade.tradeDayKey))].sort();
  const byDay = new Map(dayKeys.map((day) => [day, trades.filter((trade) => trade.tradeDayKey === day)]));
  const dayPnl = dayKeys.map((day) => sum(
    (byDay.get(day) ?? []).map((trade) => pnlFor(trade)),
    `Trade-day ${day} P&L`
  ));
  const dayExcessPnl = dayKeys.map((day) => sum(
    (byDay.get(day) ?? []).map((trade) => excessPnlFor(trade)),
    `Trade-day ${day} excess P&L`
  ));
  const random = seededRandom(seed);
  const sampledReturns: number[] = [];
  const sampledExcessReturns: number[] = [];
  if (dayKeys.length === 0) {
    sampledReturns.push(0);
    sampledExcessReturns.push(0);
  } else {
    const blockDays = Math.min(settings.bootstrapBlockDays, dayKeys.length);
    for (let replicate = 0; replicate < settings.bootstrapReplicates; replicate += 1) {
      let pnlUsd = 0;
      let excessPnlUsd = 0;
      let sampled = 0;
      while (sampled < dayKeys.length) {
        const blockStart = Math.floor(random() * dayKeys.length);
        for (let offset = 0; offset < blockDays && sampled < dayKeys.length; offset += 1) {
          const index = (blockStart + offset) % dayKeys.length;
          pnlUsd = safeAdd(pnlUsd, dayPnl[index] ?? 0, "Bootstrap P&L");
          excessPnlUsd = safeAdd(excessPnlUsd, dayExcessPnl[index] ?? 0, "Bootstrap excess P&L");
          sampled += 1;
        }
      }
      sampledReturns.push(safeMultiply(
        safeDivide(pnlUsd, settings.initialNavUsd, "Bootstrap return"),
        100,
        "Bootstrap return"
      ));
      sampledExcessReturns.push(safeMultiply(
        safeDivide(excessPnlUsd, settings.initialNavUsd, "Bootstrap excess return"),
        100,
        "Bootstrap excess return"
      ));
    }
  }
  return {
    version: STOCK_PAPER_LEARNING_V4_BOOTSTRAP_VERSION,
    replicates: settings.bootstrapReplicates,
    blockDays: Math.min(settings.bootstrapBlockDays, Math.max(1, dayKeys.length)),
    fixedHistoricalNotionals: true,
    activeTradeDays: dayKeys.length,
    returnPercentP05: round(percentile(sampledReturns, 0.05)),
    returnPercentP50: round(percentile(sampledReturns, 0.5)),
    returnPercentP95: round(percentile(sampledReturns, 0.95)),
    excessReturnPercentP05: round(percentile(sampledExcessReturns, 0.05)),
    excessReturnPercentP50: round(percentile(sampledExcessReturns, 0.5)),
    excessReturnPercentP95: round(percentile(sampledExcessReturns, 0.95)),
    probabilityPositiveReturnPercent: round(
      sampledReturns.filter((value) => value > 0).length / sampledReturns.length * 100
    ),
    probabilityPositiveExcessPercent: round(
      sampledExcessReturns.filter((value) => value > 0).length / sampledExcessReturns.length * 100
    )
  };
}

function dayWeightedDistribution(trades: readonly StockPaperAnalysisTradeV4[]): Map<string, number> {
  const result = new Map<string, number>();
  const days = [...new Set(trades.map((trade) => trade.tradeDayKey))].sort();
  for (const day of days) {
    const dayTrades = trades.filter((trade) => trade.tradeDayKey === day);
    for (const trade of dayTrades) {
      const contribution = safeDivide(1, Math.max(1, dayTrades.length), "Day-weighted symbol mix");
      result.set(trade.symbol, safeAdd(
        result.get(trade.symbol) ?? 0,
        contribution,
        "Day-weighted symbol mix"
      ));
    }
  }
  for (const [key, weight] of result) {
    result.set(key, days.length > 0 ? safeDivide(weight, days.length, "Day-weighted symbol mix") : 0);
  }
  return result;
}

function jensenShannon(left: Map<string, number>, right: Map<string, number>): number {
  const keys = new Set([...left.keys(), ...right.keys()]);
  const kl = (source: Map<string, number>): number => [...keys].reduce((sum, key) => {
    const probability = source.get(key) ?? 0;
    const midpoint = ((left.get(key) ?? 0) + (right.get(key) ?? 0)) / 2;
    return probability > 0 && midpoint > 0 ? sum + probability * Math.log2(probability / midpoint) : sum;
  }, 0);
  return (kl(left) + kl(right)) / 2;
}

function drift(
  trades: readonly StockPaperAnalysisTradeV4[],
  settings: StockPaperLearningV4Config
): StockPaperDriftV4 {
  const days = [...new Set(trades.map((trade) => trade.tradeDayKey))].sort();
  const middle = Math.floor(days.length / 2);
  const earlyDays = new Set(days.slice(0, middle));
  const recentDays = new Set(days.slice(middle));
  const early = trades.filter((trade) => earlyDays.has(trade.tradeDayKey));
  const recent = trades.filter((trade) => recentDays.has(trade.tradeDayKey));
  const dayMetric = (subset: readonly StockPaperAnalysisTradeV4[], subsetDays: ReadonlySet<string>) =>
    [...subsetDays].sort().map((day) => {
      const dayTrades = subset.filter((trade) => trade.tradeDayKey === day);
      return {
        netReturnPercent: mean(dayTrades.map((trade) => trade.netReturnPercent)),
        spyExcessPercent: mean(dayTrades.map((trade) =>
          safeAdd(trade.netReturnPercent, -trade.spyReturnPercent, `Trade-day ${day} excess`)
        )),
        winRatePercent: dayTrades.length > 0
          ? safeMultiply(
              safeDivide(
                dayTrades.filter((trade) => trade.netReturnPercent > 0).length,
                dayTrades.length,
                `Trade-day ${day} win rate`
              ),
              100,
              `Trade-day ${day} win rate`
            )
          : 0
      };
    });
  const earlyMetrics = dayMetric(early, earlyDays);
  const recentMetrics = dayMetric(recent, recentDays);
  const earlyMean = mean(earlyMetrics.map((entry) => entry.netReturnPercent));
  const recentMean = mean(recentMetrics.map((entry) => entry.netReturnPercent));
  const earlyExcess = mean(earlyMetrics.map((entry) => entry.spyExcessPercent));
  const recentExcess = mean(recentMetrics.map((entry) => entry.spyExcessPercent));
  const excessDelta = recentExcess - earlyExcess;
  const enough = earlyDays.size >= settings.driftMinimumDaysPerWindow &&
    recentDays.size >= settings.driftMinimumDaysPerWindow;
  const status: StockPaperDriftStatusV4 = !enough
    ? "INSUFFICIENT_HISTORY"
    : excessDelta > settings.driftMaterialityPercent
      ? "IMPROVING"
      : excessDelta < -settings.driftMaterialityPercent
        ? "DETERIORATING"
        : "STABLE";
  return {
    status,
    earlyDayCount: earlyDays.size,
    recentDayCount: recentDays.size,
    earlyMeanNetReturnPercent: round(earlyMean),
    recentMeanNetReturnPercent: round(recentMean),
    netReturnDeltaPercent: round(recentMean - earlyMean),
    earlyMeanSpyExcessPercent: round(earlyExcess),
    recentMeanSpyExcessPercent: round(recentExcess),
    spyExcessDeltaPercent: round(excessDelta),
    earlyWinRatePercent: round(mean(earlyMetrics.map((entry) => entry.winRatePercent))),
    recentWinRatePercent: round(mean(recentMetrics.map((entry) => entry.winRatePercent))),
    symbolMixJensenShannonDivergence: round(jensenShannon(
      dayWeightedDistribution(early),
      dayWeightedDistribution(recent)
    ))
  };
}

function diagnostics(
  trades: readonly StockPaperAnalysisTradeV4[],
  dailyReturns: readonly StockPaperDailyReturnV4[],
  correlations: StockPaperCorrelationContextV4,
  driftResult: StockPaperDriftV4
): StockPaperLearningDiagnosticsV4 {
  const uniqueDays = new Set(trades.map((trade) => trade.tradeDayKey));
  const warnings: string[] = [
    "REALIZED-CLOSE BOOKKEEPING ONLY: portfolio P&L and drawdown change only when a trade closes; intratrade mark-to-market drawdown is not measured."
  ];
  if (trades.length < 30) warnings.push("Fewer than 30 completed trades; estimates remain low confidence.");
  if (uniqueDays.size < 20) warnings.push("Fewer than 20 active trade days; bootstrap tails remain unstable.");
  if (trades.some((trade) => !trade.sector)) warnings.push("Some trades lack sector context.");
  if (correlations.pairCoveragePercent < 80) warnings.push("Return-history coverage is incomplete for portfolio correlations.");
  if ((correlations.highestPositivePair?.correlation ?? 0) >= 0.8) {
    warnings.push("At least one traded symbol pair has correlation of 0.80 or greater.");
  }
  if (driftResult.status === "DETERIORATING") warnings.push("Recent SPY-excess performance deteriorated materially.");
  return {
    tradeCount: trades.length,
    uniqueSymbols: new Set(trades.map((trade) => trade.symbol)).size,
    uniqueTradeDays: uniqueDays.size,
    missingSectorTrades: trades.filter((trade) => !trade.sector).length,
    dailyReturnSymbols: new Set(dailyReturns.map((entry) => entry.symbol)).size,
    spyHistoryDays: dailyReturns.filter((entry) => entry.symbol === "SPY").length,
    warnings
  };
}

export function analyzeStockPaperLearningV4(
  input: AnalyzeStockPaperLearningV4Input
): Readonly<StockPaperLearningAnalysisV4> {
  const cutoffAt = isoTimestamp(input.cutoffAt, "Analysis cutoff");
  const settings = config(input.config);
  const dataset = normalizeDataset(input, cutoffAt);
  const firstTrade = dataset.trades[0];
  const provenance: StockPaperLearningProvenanceV4 = {
    datasetSchemaVersion: STOCK_PAPER_LEARNING_V4_DATASET_SCHEMA_VERSION,
    analysisVersion: STOCK_PAPER_LEARNING_V4_VERSION,
    replayVersion: STOCK_PAPER_LEARNING_V4_REPLAY_VERSION,
    bootstrapVersion: STOCK_PAPER_LEARNING_V4_BOOTSTRAP_VERSION,
    sourceLaneId: firstTrade?.laneId ?? null,
    policyVersion: firstTrade?.policyVersion ?? null,
    featureVersion: firstTrade?.featureVersion ?? null,
    executionVersion: firstTrade?.executionVersion ?? null,
    adjustedRegularSessionReturnsOnly: true,
    cutoffIndependentDatasetSeed: true
  };
  const datasetDigest = digest("stock-paper-learning-v4-dataset", {
    datasetSchemaVersion: STOCK_PAPER_LEARNING_V4_DATASET_SCHEMA_VERSION,
    trades: dataset.trades,
    dailyReturns: dataset.dailyReturns
  });
  const replay = replayPortfolio(dataset.trades, settings.initialNavUsd);
  const excess = spyExcess(dataset.trades);
  const correlations = correlationContext(
    dataset.trades,
    dataset.dailyReturns,
    settings.minimumCorrelationOverlapDays
  );
  const regimes = regimePerformance(dataset.trades, dataset.dailyReturns, settings);
  const sectors = sectorPerformance(dataset.trades);
  const bootstrap = blockBootstrap(dataset.trades, settings, datasetDigest);
  const driftResult = drift(dataset.trades, settings);
  const diagnosticResult = diagnostics(dataset.trades, dataset.dailyReturns, correlations, driftResult);
  const unsigned = {
    version: STOCK_PAPER_LEARNING_V4_VERSION,
    analysisOnly: true as const,
    affectsTrading: false as const,
    promotionEligible: false as const,
    portfolioCounterfactual: false as const,
    cutoffAt,
    datasetDigest,
    provenance,
    config: settings,
    replay,
    spyExcess: excess,
    correlations,
    regimePerformance: regimes,
    sectorPerformance: sectors,
    bootstrap,
    drift: driftResult,
    diagnostics: diagnosticResult
  };
  return deepFreeze({
    ...unsigned,
    outputDigest: digest("stock-paper-learning-v4-output-v2", unsigned)
  });
}
