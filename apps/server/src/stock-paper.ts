import { createHash, randomUUID } from "node:crypto";
import type {
  AlpacaHistoricalStockFeed,
  AlpacaPaperProvider,
  AlpacaNewsArticle,
  AlpacaStockAsset,
  AlpacaStockBar,
  AlpacaStockSnapshot
} from "@copylab/providers";
import type {
  AlpacaPaperCredentials,
  ModeState,
  StockPaperAccount,
  StockPaperCandidate,
  StockPaperEquityPoint,
  StockPaperExitReason,
  StockPaperMarketStatus,
  StockPaperObservation,
  StockPaperObservationOutcome,
  StockPaperOrder,
  StockPaperOrderEvent,
  StockPaperOrderFill,
  StockPaperOrderStatus,
  StockPaperPosition,
  StockPaperRotationDecision,
  StockPaperRotationOutcome,
  StockPaperSignal,
  StockPaperTrade
} from "@copylab/shared";
import {
  STOCK_PAPER_EXECUTION_VERSION,
  STOCK_PAPER_FEATURE_VERSION as STOCK_FEATURE_VERSION
} from "@copylab/shared";
import {
  DEFAULT_STOCK_PAPER_POLICY,
  adaptiveHierarchicalArmDecision,
  basicSnapshotScore,
  currentPhaseBarWindow,
  deterministicUniverse,
  marketPhase,
  modeledBuyFill,
  modeledSellFill,
  passesStockSnapshotPrefilter,
  replayClosedStockTrade,
  scoreStockCandidate,
  stockExitDecision,
  stockMarkPrice,
  stockPositionRiskDecision,
  stockPaperMaximumBarAgeMs,
  stockQuoteIsFresh,
  stockSnapshotIsFresh,
  stockTradeDayKey
} from "./stock-paper-policy.js";
import { StockPaperRepository } from "./stock-paper-repository.js";
import {
  cancelStockPaperLimitOrderV3,
  expireStockPaperLimitOrderV3,
  firstEligibleStockPaperBarAtV3,
  resolveLongStockPaperProtectiveExitV3,
  resolveStockPaperLimitOrderV3,
  submitStockPaperLimitOrderV3,
  type StockPaperLimitOrderV3
} from "./stock-paper-execution-v3.js";
import {
  evaluateStockPaperReadiness,
  rollingProviderBudget,
  type StockPaperProviderCall
} from "./stock-paper-readiness.js";
import {
  calculateStockPaperOutcomeLabelV3,
  createStockPaperLearningObservationV3,
  DEFAULT_STOCK_PAPER_OUTCOME_COST_POLICY_V3,
  evaluateStockPaperShadowArenaV3,
  evaluateStockPaperWalkForwardV3,
  parseStockPaperOutcomeLabelV3,
  STOCK_PAPER_LEARNING_V3_VERSION,
  stockPaperDatasetAtCutoffV3,
  stockPaperPolicyDigestV3,
  stockPaperShadowPolicySetDigestV3,
  type StockPaperLearningObservationV3,
  type StockPaperOutcomeLabelV3
} from "./stock-paper-learning-v3.js";
import { analyzeStockPaperLearningV4 } from "./stock-paper-learning-v4.js";
import { prepareStockPaperLearningV4Evidence } from "./stock-paper-learning-v4-evidence.js";
import { summarizeStockPaperLearningV4 } from "./stock-paper-learning-v4-summary.js";
import {
  calculateStockPaperRotationOutcome,
  evaluateStockPaperRotationDecision
} from "./stock-paper-rotation-shadow.js";
import { AlpacaStockHotlistStream } from "./stock-paper-stream.js";
import { buildCompletedStockPaperTradePath } from "./stock-paper-trade-path.js";

const CLOSED_SCAN_INTERVAL_MS = 5 * 60_000;
const OVERNIGHT_ASSET_REFRESH_MS = 10 * 60_000;
const ENTRY_OPENING_DELAY_MINUTES = 5;
const ENTRY_CLOSING_BUFFER_MINUTES = 30;
const ONLINE_UNIVERSE_REFRESH_MS = 5 * 60_000;
const NEWS_LOOKBACK_MS = 90 * 60_000;
const OBSERVATION_HORIZONS = [15, 45, 180] as const;
const OUTCOME_HISTORY_SYMBOLS_PER_CYCLE = 300;
const ALPACA_BAR_SYMBOL_BATCH_SIZE = 100;
const ALPACA_BAR_MAX_PAGES = 20;
const SELL_EVIDENCE_GRACE_MS = 5 * 60_000;
const ALPACA_DELAYED_SIP_MINIMUM_AGE_MS = 16 * 60_000;
const ALPACA_DELAYED_SIP_MAXIMUM_FAIR_VALUE_AGE_MS = 30 * 60_000;
const LEARNING_V4_MAX_TRADES = 500;
const LEARNING_V4_MAX_ORDER_EVENTS = 20_000;

function minuteKey(at: string): string {
  return at.slice(0, 16);
}

function datePlusDays(dateKey: string, days: number): string {
  const date = new Date(`${dateKey}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function eventId(laneId: string, at: string, symbol: string, action: string): string {
  return createHash("sha256")
    .update(`${laneId}:${minuteKey(at)}:${symbol}:${action}`)
    .digest("hex");
}

function orderId(laneId: string, at: string, symbol: string, side: "BUY" | "SELL"): string {
  return `stock-order:${eventId(laneId, at, symbol, side)}`;
}

function rolloverOrderId(order: StockPaperOrder, phase: StockPaperMarketStatus["phase"], feed: StockPaperMarketStatus["feed"]): string {
  const count = (order.rolloverCount ?? 0) + 1;
  return `stock-order:${createHash("sha256")
    .update(`${order.id}:rollover:${count}:${phase}:${feed}`)
    .digest("hex")}`;
}

function quoteEvidence(snapshot: AlpacaStockSnapshot | undefined): {
  quoteTimestamp?: string;
  quoteDigest?: string;
} {
  const quote = snapshot?.latestQuote;
  if (!quote) return {};
  return {
    quoteTimestamp: quote.timestamp,
    quoteDigest: createHash("sha256").update(JSON.stringify({
      timestamp: quote.timestamp,
      bidPrice: quote.bidPrice,
      bidSize: quote.bidSize,
      askPrice: quote.askPrice,
      askSize: quote.askSize
    })).digest("hex")
  };
}

function barEvidenceDigest(bar: AlpacaStockBar | undefined): string | undefined {
  if (!bar) return undefined;
  return createHash("sha256").update(JSON.stringify({
    timestamp: bar.timestamp,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
    tradeCount: bar.tradeCount,
    vwap: bar.vwap
  })).digest("hex");
}

function causalEvidenceTime(
  at: string | undefined,
  evidence: "QUOTE" | "BAR" = "QUOTE"
): number | undefined {
  const parsed = Date.parse(at ?? "");
  if (!Number.isFinite(parsed)) return undefined;
  // Alpaca minute-bar timestamps identify the beginning of the interval. A
  // completed bar cannot be known until that interval has ended.
  return parsed + (evidence === "BAR" ? 60_000 : 0);
}

function latestCausalTimestamp(
  fallback: string,
  values: readonly (number | undefined)[]
): string {
  const fallbackMs = Date.parse(fallback);
  const latest = values
    .filter((value): value is number => value !== undefined && Number.isFinite(value))
    .reduce((maximum, value) => Math.max(maximum, value), fallbackMs);
  return new Date(latest).toISOString();
}

function sellEvidenceTimeoutAt(
  submittedAt: string,
  phase: StockPaperMarketStatus["phase"]
): string {
  return new Date(
    Date.parse(submittedAt) + stockPaperMaximumBarAgeMs(phase) + SELL_EVIDENCE_GRACE_MS
  ).toISOString();
}

function asExecutionOrder(order: StockPaperOrder): StockPaperLimitOrderV3 {
  return {
    id: order.id,
    symbol: order.symbol,
    side: order.side,
    limitPriceUsd: order.limitPriceUsd,
    quantity: order.requestedQuantity,
    submittedAt: order.submittedAt,
    expiresAt: order.expiresAt,
    modelVersion: "stock-paper-execution-v3",
    status: order.status,
    filledQuantity: order.filledQuantity,
    ...(order.averageFillPriceUsd !== undefined
      ? { averageFillPriceUsd: order.averageFillPriceUsd }
      : {}),
    ...(order.firstEligibleBarAt ? { firstEligibleBarAt: order.firstEligibleBarAt } : {}),
    ...(order.lastEvaluatedBarAt ? { lastEvaluatedBarAt: order.lastEvaluatedBarAt } : {}),
    ...(order.reason ? { terminalReason: order.reason } : {}),
    updatedAt: order.updatedAt
  };
}

function applyExecutionResolution(
  order: StockPaperOrder,
  result: ReturnType<typeof resolveStockPaperLimitOrderV3>,
  now: string
): { order: StockPaperOrder; fill?: StockPaperOrderFill } {
  const next = result.order;
  const fill = result.fill
    ? {
        id: `${order.id}:${result.fill.barTimestamp}:${order.fills.length + 1}`,
        quantity: result.fill.quantity,
        priceUsd: result.fill.priceUsd,
        notionalUsd: result.fill.notionalUsd,
        modeledCostsUsd: 0,
        evidence: "BAR" as const,
        evidenceAt: result.fill.barTimestamp,
        createdAt: now
      }
    : undefined;
  return {
    order: {
      ...order,
      status: next.status,
      filledQuantity: next.filledQuantity,
      ...(next.averageFillPriceUsd !== undefined
        ? { averageFillPriceUsd: next.averageFillPriceUsd }
        : {}),
      ...(next.firstEligibleBarAt ? { firstEligibleBarAt: next.firstEligibleBarAt } : {}),
      ...(next.lastEvaluatedBarAt ? { lastEvaluatedBarAt: next.lastEvaluatedBarAt } : {}),
      reservedNotionalUsd: Math.max(
        0,
        (order.requestedQuantity - next.filledQuantity) * order.limitPriceUsd
      ),
      fills: fill ? [...order.fills, fill] : order.fills,
      ...(next.terminalReason ? { reason: next.terminalReason } : {}),
      updatedAt: next.updatedAt || now
    },
    ...(fill ? { fill } : {})
  };
}

function newestAgeMs(
  values: readonly (string | undefined)[],
  nowMs: number
): number | undefined {
  const newest = values
    .map((value) => Date.parse(value ?? ""))
    .filter(Number.isFinite)
    .sort((left, right) => right - left)[0];
  return newest === undefined ? undefined : Math.max(0, nowMs - newest);
}

function learningEvidenceFromObservation(
  observation: StockPaperObservation
): StockPaperLearningObservationV3 {
  const candidate = observation.candidate;
  return createStockPaperLearningObservationV3({
    laneId: observation.laneId,
    symbol: observation.symbol,
    arm: candidate.arm,
    phase: observation.phase,
    feed: observation.feed,
    policyVersion: observation.policyVersion,
    policy: observation.policy,
    tradeDayKey: observation.tradeDayKey,
    observedAt: observation.observedAt,
    idempotencyBucket: observation.idempotencyBucket,
    candidateRank: observation.candidateRank,
    candidateScore: candidate.score,
    highConviction: candidate.highConviction,
    confirmationSamples: observation.confirmationSamples,
    entryPriceUsd: observation.entryPriceUsd,
    entryNotionalUsd: observation.entryNotionalUsd,
    spreadPercent: candidate.spreadPercent,
    relativeVolume: candidate.relativeVolume,
    dollarVolumeUsd: candidate.dollarVolumeUsd,
    change1mPercent: candidate.change1mPercent,
    change5mPercent: candidate.change5mPercent,
    change15mPercent: candidate.change15mPercent,
    vwapDistancePercent: candidate.vwapDistancePercent,
    sessionMinute: observation.sessionMinute,
    onlineSources: candidate.onlineSources ?? [],
    newsArticleIds: observation.newsArticleIds,
    hardSafetyPassed: observation.hardSafetyPassed
  });
}

function verifiedLearningEvidence(
  observation: StockPaperObservation
): StockPaperLearningObservationV3 | undefined {
  try {
    const rich = learningEvidenceFromObservation(observation);
    return rich.id === observation.id &&
      rich.policyDigest === observation.policyDigest &&
      observation.featureVersion === STOCK_FEATURE_VERSION &&
      observation.executionVersion === STOCK_PAPER_EXECUTION_VERSION &&
      rich.symbol === observation.symbol &&
      rich.observedAt === observation.observedAt
      ? rich
      : undefined;
  } catch {
    return undefined;
  }
}

function verifiedOutcomeEvidence(
  outcome: StockPaperObservationOutcome,
  observation: StockPaperLearningObservationV3
): StockPaperOutcomeLabelV3 | undefined {
  try {
    const label = parseStockPaperOutcomeLabelV3(outcome.analysisEvidence, {
      observation,
      costPolicy: DEFAULT_STOCK_PAPER_OUTCOME_COST_POLICY_V3
    });
    const sameOptionalNumber = (left: number | undefined, right: number | undefined) =>
      left === right;
    return outcome.laneId === observation.laneId &&
      label.observationId === outcome.observationId &&
      label.symbol === outcome.symbol &&
      label.horizonMinutes === outcome.horizonMinutes &&
      label.horizonEndsAt === outcome.dueAt &&
      label.labeledAt === outcome.labeledAt &&
      label.datasetEligible === (outcome.status === "LABELED") &&
      outcome.entryPriceUsd === observation.entryPriceUsd &&
      sameOptionalNumber(outcome.exitPriceUsd, label.exitExecutablePriceUsd) &&
      sameOptionalNumber(outcome.netReturnPercent, label.netExecutableReturnPercent) &&
      sameOptionalNumber(outcome.mfePercent, label.maximumFavorableExcursionPercent) &&
      sameOptionalNumber(outcome.maePercent, label.maximumAdverseExcursionPercent) &&
      outcome.missingReason === label.missingDataReason
      ? label
      : undefined;
  } catch {
    return undefined;
  }
}

function observationDecision(signal: StockPaperSignal | undefined): StockPaperObservation["decision"] {
  if (!signal) return "OBSERVED";
  if (signal.action === "BUY" && signal.outcome === "SIMULATED") return "BOUGHT";
  if (signal.action === "BUY" && signal.outcome === "ANALYSIS_ONLY") return "ORDER_SUBMITTED";
  const text = signal.reasons.join(" ").toLowerCase();
  if (text.includes("capacity")) return "CAPACITY_BLOCKED";
  if (text.includes("cooldown")) return "COOLDOWN_BLOCKED";
  if (text.includes("already open") || text.includes("already pending")) return "ALREADY_OPEN";
  if (signal.action === "REJECT") return "REJECTED";
  return "OBSERVED";
}

function batches<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function uniqueBars(values: readonly AlpacaStockBar[]): AlpacaStockBar[] {
  return [...new Map(values.map((bar) => [bar.timestamp, bar])).values()]
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp));
}

function outcomeEvidenceContextKey(input: Pick<StockPaperObservation, "phase" | "feed">): string {
  return `${input.phase}:${input.feed}`;
}

function outcomeEvidenceTargetKey(
  input: Pick<StockPaperObservation, "phase" | "feed">,
  symbol: string
): string {
  return `${outcomeEvidenceContextKey(input)}:${symbol}`;
}

function outcomeHistoricalFeed(
  input: Pick<StockPaperObservation, "phase" | "feed">
): AlpacaHistoricalStockFeed {
  // The immutable feed recorded with the observation/decision is authoritative.
  // The current wall-clock phase must never rewrite historical provenance.
  return input.feed === "OVERNIGHT" ? "boats" : "iex";
}

function mergeStockSnapshots(
  polled: readonly AlpacaStockSnapshot[],
  streamed: readonly AlpacaStockSnapshot[]
): AlpacaStockSnapshot[] {
  const merged = new Map(polled.map((snapshot) => [snapshot.symbol, snapshot]));
  for (const update of streamed) {
    const prior = merged.get(update.symbol) ?? { symbol: update.symbol };
    const priorQuoteAt = Date.parse(prior.latestQuote?.timestamp ?? "");
    const updateQuoteAt = Date.parse(update.latestQuote?.timestamp ?? "");
    const priorBarAt = Date.parse(prior.minuteBar?.timestamp ?? "");
    const updateBarAt = Date.parse(update.minuteBar?.timestamp ?? "");
    merged.set(update.symbol, {
      ...prior,
      ...(update.latestQuote &&
        (!Number.isFinite(priorQuoteAt) || updateQuoteAt >= priorQuoteAt)
        ? { latestQuote: update.latestQuote }
        : {}),
      ...(update.minuteBar &&
        (!Number.isFinite(priorBarAt) || updateBarAt >= priorBarAt)
        ? { minuteBar: update.minuteBar }
        : {})
    });
  }
  return [...merged.values()];
}

function spreadPercent(snapshot: AlpacaStockSnapshot): number {
  const quote = snapshot.latestQuote;
  if (!quote || quote.askPrice <= quote.bidPrice) return 100;
  const mid = (quote.askPrice + quote.bidPrice) / 2;
  return mid > 0 ? (quote.askPrice - quote.bidPrice) / mid * 100 : 100;
}

function sessionElapsedMinutes(now: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date(now));
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  return hour * 60 + minute - 570;
}

function easternSessionMinutes(now: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date(now));
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  return hour * 60 + minute;
}

/** BOATS ends at 04:00 ET and Alpaca Basic IEX does not provide actionable
 * evidence through the ensuing early-premarket gap. Returning this boundary
 * lets the existing SESSION_END rule liquidate while BOATS still has real
 * executable evidence instead of knowingly carrying a lot into that gap. */
export function stockPaperOvernightFeedMinutesRemaining(now: string): number | undefined {
  const minutes = easternSessionMinutes(now);
  if (minutes >= 1_200) return 1_680 - minutes;
  if (minutes < 240) return 240 - minutes;
  return undefined;
}

function overnightAssetPrewarmWindow(now: string): boolean {
  const minutes = easternSessionMinutes(now);
  return minutes >= 1_195 && minutes < 1_200;
}

function calendarAllowsEntries(
  clock: { isOpen: boolean; nextOpen: string },
  phase: StockPaperMarketStatus["phase"],
  now: Date
): boolean {
  if (phase === "REGULAR") return clock.isOpen;
  const untilNextOpenHours = (Date.parse(clock.nextOpen) - now.getTime()) / 3_600_000;
  if (!Number.isFinite(untilNextOpenHours) || untilNextOpenHours < 0) return false;
  if (phase === "PREMARKET") return untilNextOpenHours <= 6;
  if (phase === "AFTER_HOURS" || phase === "OVERNIGHT") return untilNextOpenHours <= 18;
  return false;
}

function discontinuityMinutesRemaining(
  clock: { nextOpen: string },
  phase: StockPaperMarketStatus["phase"],
  now: Date
): number | undefined {
  const untilNextOpenHours = (Date.parse(clock.nextOpen) - now.getTime()) / 3_600_000;
  if (!Number.isFinite(untilNextOpenHours) || untilNextOpenHours <= 18) return undefined;
  const minutes = easternSessionMinutes(now.toISOString());
  if (phase === "AFTER_HOURS") return Math.max(0, 1_200 - minutes);
  if (phase === "OVERNIGHT") {
    return minutes >= 1_200 ? Math.max(0, 1_680 - minutes) : Math.max(0, 240 - minutes);
  }
  return undefined;
}

function baseEligibleAsset(asset: AlpacaStockAsset): boolean {
  return asset.status === "active" &&
    asset.tradable &&
    asset.fractionable &&
    !/OTC/iu.test(asset.exchange ?? "") &&
    /^[A-Z][A-Z0-9.-]{0,9}$/.test(asset.symbol);
}

export function stockAssetSupportsPhase(
  asset: AlpacaStockAsset,
  phase: StockPaperMarketStatus["phase"]
): boolean {
  if (!baseEligibleAsset(asset)) return false;
  return phase !== "OVERNIGHT" || (asset.overnightTradable && !asset.overnightHalted);
}

export function stockAssetAllowsFractionalPhase(
  asset: AlpacaStockAsset,
  phase: StockPaperMarketStatus["phase"]
): boolean {
  return phase === "REGULAR" || asset.fractionalEhEnabled;
}

function extendedEntryWindowOpen(
  phase: StockPaperMarketStatus["phase"],
  now: string
): boolean {
  const minutes = easternSessionMinutes(now);
  if (phase === "PREMARKET") return minutes >= 255 && minutes < 555;
  if (phase === "AFTER_HOURS") return minutes >= 965 && minutes < 1_185;
  if (phase === "OVERNIGHT") return minutes >= 1_215 || minutes < 225;
  return false;
}

function activeStockSession(phase: StockPaperMarketStatus["phase"]): boolean {
  return phase === "OVERNIGHT" ||
    phase === "PREMARKET" ||
    phase === "REGULAR" ||
    phase === "AFTER_HOURS";
}

function safeError(error: unknown): string {
  if (error instanceof Error) {
    if (/401|403|credential|secret|key/iu.test(error.message)) {
      return "Alpaca authentication or authorization failed.";
    }
    if (/429/iu.test(error.message)) return "Alpaca rate limit was reached; the next cycle will retry.";
    if (/timed out|abort/iu.test(error.message)) return "Alpaca market-data request timed out.";
  }
  return "The Alpaca stock-paper cycle failed safely.";
}

export interface StockPaperEngineOptions {
  mode: () => ModeState;
  credentials: () => AlpacaPaperCredentials | undefined;
  provider: (credentials: AlpacaPaperCredentials) => AlpacaPaperProvider;
  now?: () => Date;
  onProviderRequest?: () => void;
  onUpdate?: (data: Record<string, unknown>) => void;
  onError?: (error: unknown) => void;
  streaming?: boolean;
}

interface StockPaperCycleNewsEvidence {
  articleId: string;
  symbol: string;
  createdAt: string;
  observedAt: string;
  evidence: Record<string, unknown>;
}

export class StockPaperEngine {
  private tail: Promise<void> = Promise.resolve();
  private learningTail: Promise<void> = Promise.resolve();
  private lastLearningCheckpointAt = 0;
  private assetsByDay = new Map<string, AlpacaStockAsset[]>();
  private benchmarkStartPrice: number | undefined;
  private lastClosedScanAt = 0;
  private lastOvernightAssetRefreshAt = 0;
  private lastOnlineUniverseRefreshAt = 0;
  private onlineUniverseUpdatedAt: string | undefined;
  private screenerStatus: "LIVE" | "STALE" | "FALLBACK" | "UNAVAILABLE" = "UNAVAILABLE";
  private newsStatus: "LIVE" | "STALE" | "FALLBACK" | "UNAVAILABLE" = "UNAVAILABLE";
  private screenerSourceUpdatedAt: string | undefined;
  private newestNewsAt: string | undefined;
  private dynamicSources = new Map<string, Set<"MOST_ACTIVE" | "MOVER" | "NEWS">>();
  private newsCounts = new Map<string, number>();
  private newsArticleIds = new Map<string, number[]>();
  private providerCalls: StockPaperProviderCall[] = [];
  private calendarCacheKey: string | undefined;
  private calendarTradeDays = new Set<string>();
  private calendarStatus: "VERIFIED" | "FALLBACK" | "UNAVAILABLE" = "UNAVAILABLE";
  private corporateActionSymbols = new Set<string>();
  private corporateActionCheckedSymbols = new Set<string>();
  private corporateActionsUpdatedAt = 0;
  private stream: AlpacaStockHotlistStream | undefined;
  private streamCredentialDigest: string | undefined;
  private streamCycleTimer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(
    private readonly repository: StockPaperRepository,
    private readonly options: StockPaperEngineOptions
  ) {}

  enqueueCycle(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const run = this.tail.then(() => this.runCycle());
    this.tail = run.catch((error) => {
      this.options.onError?.(error);
    });
    return run;
  }

  async drain(): Promise<void> {
    await this.tail;
    await this.learningTail;
  }

  stop(): void {
    this.stopped = true;
    if (this.streamCycleTimer) clearTimeout(this.streamCycleTimer);
    this.streamCycleTimer = undefined;
    this.stream?.stop();
    this.stream = undefined;
    this.streamCredentialDigest = undefined;
  }

  dashboard() {
    return this.repository.dashboard();
  }

  private reportRotationAnalysisFailure(stage: string, error: unknown): void {
    const reported = new Error(
      `The analysis-only stock PAPER rotation ${stage} failed safely.`,
      { cause: error }
    );
    try {
      this.options.onError?.(reported);
    } catch {
      // Diagnostics must never become part of the authoritative PAPER path.
    }
    try {
      this.options.onUpdate?.({
        outcome: "ROTATION_ANALYSIS_FAILED",
        analysisOnly: true,
        affectsTrading: false,
        stage
      });
    } catch {
      // A subscriber failure cannot turn a shadow-analysis fault into a cycle fault.
    }
  }

  private enqueueLearningEvaluation(laneId: string, cutoffAt: string): void {
    const cutoffMs = Date.parse(cutoffAt);
    if (!Number.isFinite(cutoffMs) || cutoffMs - this.lastLearningCheckpointAt < 15 * 60_000) return;
    this.lastLearningCheckpointAt = cutoffMs;
    const run = this.learningTail.then(() => this.runLearningEvaluation(laneId, cutoffAt));
    this.learningTail = run.catch((error) => {
      this.options.onError?.(error);
    });
  }

  private async runLearningEvaluation(laneId: string, cutoffAt: string): Promise<void> {
    const verifiedObservations = this.repository.observations(laneId, 20_000)
      .flatMap((observation): StockPaperLearningObservationV3[] => {
        const verified = verifiedLearningEvidence(observation);
        return verified ? [verified] : [];
      });
    const observationById = new Map(
      verifiedObservations.map((observation) => [observation.id, observation])
    );
    const verifiedOutcomes = this.repository.observationOutcomes(laneId, 60_000)
      .flatMap((outcome): StockPaperOutcomeLabelV3[] => {
        const observation = observationById.get(outcome.observationId);
        if (!observation) return [];
        const verified = verifiedOutcomeEvidence(outcome, observation);
        return verified ? [verified] : [];
      });
    const dataset = stockPaperDatasetAtCutoffV3({
      observations: verifiedObservations,
      outcomes: verifiedOutcomes,
      cutoffAt
    });
    const observations = dataset.observations;
    const outcomes = dataset.outcomes;
    const arena = evaluateStockPaperShadowArenaV3({
      observations,
      outcomes,
      horizonMinutes: 15
    });
    const walkForward = evaluateStockPaperWalkForwardV3({
      observations,
      outcomes,
      horizonMinutes: 15
    });
    const baseline = walkForward.policies.find((policy) =>
      policy.policyId === walkForward.baselinePolicyId
    ) ?? walkForward.policies[0]!;
    const distinctSymbols = baseline.holdoutDistinctSymbols;
    const distinctTradeDays = baseline.holdoutDistinctTradeDays;
    const evaluatedAt = new Date().toISOString();
    const status = baseline.holdout.scorablePathCount === 0
      ? "COLLECTING" as const
      : baseline.status;
    const summary: import("@copylab/shared").StockPaperWalkForwardSummary = {
      status,
      analysisOnly: true,
      mayAffectTrading: false,
      promotionEligible: false,
      evaluatedAt,
      cutoffAt,
      horizonMinutes: 15,
      folds: walkForward.folds.length,
      holdoutScorablePaths: baseline.holdout.scorablePathCount,
      coveragePercent: baseline.holdout.coveragePercent,
      distinctSymbols,
      distinctTradeDays,
      datasetDigest: walkForward.datasetDigest,
      policySetDigest: stockPaperShadowPolicySetDigestV3(),
      evaluationDigest: walkForward.evaluationDigest,
      gateReasons: [...baseline.gateReasons]
    };
    const checkpointId = `stock-learning-checkpoint:${createHash("sha256")
      .update(`${laneId}:${walkForward.evaluationDigest}`)
      .digest("hex")}`;
    this.repository.commitLearningEvaluation({
      laneId,
      checkpointId,
      datasetDigest: walkForward.datasetDigest,
      evaluationDigest: walkForward.evaluationDigest,
      capturedAt: evaluatedAt,
      cutoffAt,
      walkForward: summary,
      shadowResults: arena.results.map((result) => ({
        id: `stock-shadow:${createHash("sha256")
          .update(`${laneId}:${STOCK_PAPER_LEARNING_V3_VERSION}:${arena.datasetDigest}:${walkForward.evaluationDigest}:${result.policyDigest}:15`)
          .digest("hex")}`,
        score: {
          policyId: result.policyId,
          policyDigest: result.policyDigest,
          datasetDigest: arena.datasetDigest,
          learnerVersion: STOCK_PAPER_LEARNING_V3_VERSION,
          horizonMinutes: 15,
          evaluatedAt,
          observations: result.selectedPathCount,
          labeled: result.scorablePathCount,
          trades: result.selectedPathCount,
          wins: result.winningPathCount,
          netReturnPercent: result.compoundedNetReturnPercent,
          averageReturnPercent: result.meanNetReturnPercent,
          maximumDrawdownPercent: result.maximumDrawdownPercent,
          pathsAreIndependentTrades: false,
          promotionEligible: false
        }
      }))
    });
    const lane = this.repository.activeLane();
    let advancedAnalysisStatus: import("@copylab/shared").StockPaperLearningV4Status | undefined;
    if (lane?.id === laneId) {
      const v41EvidenceStartedAt = this.repository.v41EvidenceActivationAt();
      const evidence = prepareStockPaperLearningV4Evidence({
        cutoffAt,
        ...(v41EvidenceStartedAt ? { v41EvidenceStartedAt } : {}),
        trades: this.repository.trades(laneId, LEARNING_V4_MAX_TRADES),
        orderEvents: this.repository.orderEvents(
          laneId,
          undefined,
          LEARNING_V4_MAX_ORDER_EVENTS
        ),
        // Adjusted, aligned regular-session daily returns are intentionally
        // absent until a separate immutable evidence source is implemented.
        dailyReturns: []
      });
      const analysis = analyzeStockPaperLearningV4({
        cutoffAt,
        trades: evidence.trades,
        dailyReturns: evidence.dailyReturns,
        config: { initialNavUsd: lane.initialNavUsd }
      });
      const advancedAnalysis = summarizeStockPaperLearningV4({ evidence, analysis });
      this.repository.commitLearningV4Summary(laneId, advancedAnalysis);
      advancedAnalysisStatus = advancedAnalysis.status;
    }
    this.options.onUpdate?.({
      outcome: "LEARNING_CHECKPOINT",
      status,
      ...(advancedAnalysisStatus ? { advancedAnalysisStatus } : {}),
      observations: observations.length,
      outcomes: outcomes.length,
      datasetDigest: walkForward.datasetDigest
    });
  }

  private ensureStream(credentials: AlpacaPaperCredentials): AlpacaStockHotlistStream | undefined {
    if (!this.options.streaming) return undefined;
    const digest = createHash("sha256")
      .update(`${credentials.apiKey}\n${credentials.secretKey}`)
      .digest("hex");
    if (this.stream && this.streamCredentialDigest === digest) return this.stream;
    this.stream?.stop();
    this.streamCredentialDigest = digest;
    this.stream = new AlpacaStockHotlistStream({
      credentials,
      onData: (kind) => {
        if (kind !== "BAR" || this.streamCycleTimer) return;
        this.streamCycleTimer = setTimeout(() => {
          this.streamCycleTimer = undefined;
          void this.enqueueCycle().catch(() => undefined);
        }, 1_000);
        this.streamCycleTimer.unref?.();
      },
      onStatus: (status) => this.options.onUpdate?.({
        outcome: "STREAM_STATUS",
        status: status.status,
        symbols: status.symbols,
        reconnects: status.reconnects
      })
    });
    return this.stream;
  }

  private async runCycle(): Promise<void> {
    if (this.stopped) return;
    if (this.options.mode() !== "PAPER") return;
    const credentials = this.options.credentials();
    if (!credentials) return;
    const stream = this.ensureStream(credentials);
    const nowDate = this.options.now?.() ?? new Date();
    const now = nowDate.toISOString();
    const lane = this.repository.ensureActiveLane(now);
    const provider = this.options.provider(credentials);
    let requests = 0;
    const cycleStartedAt = Date.now();
    const endpointFailures: Array<{ endpoint: string; required: boolean; message?: string }> = [];
    const cycleNewsEvidence: StockPaperCycleNewsEvidence[] = [];
    const request = async <T>(operation: () => Promise<T>): Promise<T> => {
      const requestDate = this.options.now?.() ?? new Date();
      const requestAt = requestDate.toISOString();
      this.providerCalls = this.providerCalls.filter((call) =>
        Date.parse(call.at) > requestDate.getTime() - 60_000 &&
        Date.parse(call.at) <= requestDate.getTime()
      );
      const budget = rollingProviderBudget({
        now: requestAt,
        calls: this.providerCalls,
        reserveRequests: 1
      });
      if (!budget.canReserve) {
        throw new Error("Alpaca rate limit budget is exhausted; the next cycle will retry.");
      }
      requests += 1;
      this.providerCalls.push({ at: requestAt });
      this.options.onProviderRequest?.();
      return operation();
    };
    try {
      const clock = await request(() => provider.getClock());
      const phase = marketPhase(clock, nowDate);
      const maximumBarAgeMs = stockPaperMaximumBarAgeMs(phase);
      const sessionActive = activeStockSession(phase);
      if (!sessionActive && nowDate.getTime() - this.lastClosedScanAt < CLOSED_SCAN_INTERVAL_MS) return;
      if (!sessionActive) this.lastClosedScanAt = nowDate.getTime();
      const latestFeed = phase === "OVERNIGHT" ? "overnight" : "iex";
      const historicalFeed = phase === "OVERNIGHT" ? "boats" : "iex";
      const marketFeed: StockPaperMarketStatus["feed"] = phase === "OVERNIGHT" ? "OVERNIGHT" : "IEX";

      const dayKey = stockTradeDayKey(nowDate);
      if (this.calendarCacheKey !== dayKey && typeof provider.getCalendar === "function") {
        try {
          const calendar = await request(() => provider.getCalendar(
            datePlusDays(dayKey, -1),
            datePlusDays(dayKey, 4)
          ));
          this.calendarTradeDays = new Set(calendar.map((entry) => entry.date));
          this.calendarCacheKey = dayKey;
          this.calendarStatus = calendar.length > 0 ? "VERIFIED" : "UNAVAILABLE";
        } catch {
          this.calendarStatus = this.calendarTradeDays.size > 0 ? "FALLBACK" : "UNAVAILABLE";
          endpointFailures.push({ endpoint: "market-calendar", required: false });
        }
      }
      const assetDayKey = dayKey;
      const assetCacheKey = `${assetDayKey}:${latestFeed}`;
      let assets = this.assetsByDay.get(assetCacheKey);
      const overnightAssetsStale = phase === "OVERNIGHT" &&
        nowDate.getTime() - this.lastOvernightAssetRefreshAt >= OVERNIGHT_ASSET_REFRESH_MS;
      if (!assets || overnightAssetsStale) {
        assets = (await request(() => provider.getAssets())).filter(baseEligibleAsset);
        if (phase === "OVERNIGHT") this.lastOvernightAssetRefreshAt = nowDate.getTime();
        this.assetsByDay.set(assetCacheKey, assets);
      }
      if (phase !== "OVERNIGHT" && overnightAssetPrewarmWindow(now)) {
        const upcomingTradeDayKey = stockTradeDayKey(new Date(nowDate.getTime() + 10 * 60_000));
        const overnightCacheKey = `${upcomingTradeDayKey}:overnight`;
        if (!this.assetsByDay.has(overnightCacheKey)) {
          const overnightAssets = (await request(() => provider.getAssets())).filter(baseEligibleAsset);
          this.assetsByDay.set(overnightCacheKey, overnightAssets);
          this.lastOvernightAssetRefreshAt = nowDate.getTime();
        }
      }

      if (nowDate.getTime() - this.lastOnlineUniverseRefreshAt >= ONLINE_UNIVERSE_REFRESH_MS) {
        const nextSources = new Map<string, Set<"MOST_ACTIVE" | "MOVER" | "NEWS">>();
        const addSource = (symbol: string, source: "MOST_ACTIVE" | "MOVER" | "NEWS"): void => {
          const normalized = symbol.trim().toUpperCase();
          if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(normalized)) return;
          const sources = nextSources.get(normalized) ?? new Set();
          sources.add(source);
          nextSources.set(normalized, sources);
        };
        let screenerLive = false;
        let screenerPartialFailure = false;
        const screenerUpdatedAt: number[] = [];
        if (typeof provider.getMostActives === "function") {
          try {
            const actives = await request(() => provider.getMostActives(100, "volume"));
            actives.stocks.forEach((stock) => addSource(stock.symbol, "MOST_ACTIVE"));
            const updatedAt = Date.parse(actives.lastUpdated ?? "");
            if (Number.isFinite(updatedAt) && updatedAt <= nowDate.getTime()) screenerUpdatedAt.push(updatedAt);
            screenerLive = true;
          } catch {
            endpointFailures.push({ endpoint: "most-actives", required: false });
            screenerPartialFailure = true;
            for (const [symbol, sources] of this.dynamicSources) {
              if (sources.has("MOST_ACTIVE")) addSource(symbol, "MOST_ACTIVE");
            }
            // Screeners are additive. A free-plan restriction must not stop the
            // core deterministic scanner or account marking.
          }
        }
        if (typeof provider.getMarketMovers === "function") {
          try {
            const movers = await request(() => provider.getMarketMovers(50));
            [...movers.gainers, ...movers.losers].forEach((stock) => addSource(stock.symbol, "MOVER"));
            const updatedAt = Date.parse(movers.lastUpdated ?? "");
            if (Number.isFinite(updatedAt) && updatedAt <= nowDate.getTime()) screenerUpdatedAt.push(updatedAt);
            screenerLive = true;
          } catch {
            endpointFailures.push({ endpoint: "market-movers", required: false });
            screenerPartialFailure = true;
            for (const [symbol, sources] of this.dynamicSources) {
              if (sources.has("MOVER")) addSource(symbol, "MOVER");
            }
            // Keep the prior screener cohort when the optional endpoint is down.
          }
        }
        if (!screenerLive) {
          for (const [symbol, sources] of this.dynamicSources) {
            for (const source of sources) if (source !== "NEWS") addSource(symbol, source);
          }
        }
        const newestScreenerAt = screenerUpdatedAt.length > 0
          ? Math.max(...screenerUpdatedAt)
          : undefined;
        if (newestScreenerAt !== undefined) {
          this.screenerSourceUpdatedAt = new Date(newestScreenerAt).toISOString();
        }
        this.screenerStatus = screenerPartialFailure
          ? nextSources.size > 0 ? "FALLBACK" : "UNAVAILABLE"
          : screenerLive
          ? newestScreenerAt !== undefined && nowDate.getTime() - newestScreenerAt > 15 * 60_000
            ? "STALE"
            : "LIVE"
          : nextSources.size > 0 ? "FALLBACK" : "UNAVAILABLE";

        let newsLive = false;
        const nextNewsCounts = new Map<string, number>();
        const nextNewsArticleIds = new Map<string, number[]>();
        if (typeof provider.getNews === "function") {
          try {
            const articles: AlpacaNewsArticle[] = [];
            let newsPageToken: string | undefined;
            for (let page = 0; page < 3; page += 1) {
              const news = await request(() => provider.getNews!({
                start: new Date(nowDate.getTime() - NEWS_LOOKBACK_MS).toISOString(),
                end: now,
                limit: 50,
                ...(newsPageToken ? { pageToken: newsPageToken } : {})
              }));
              articles.push(...news.articles);
              newsPageToken = news.nextPageToken;
              if (!newsPageToken) break;
            }
            for (const article of new Map(articles.map((article) => [article.id, article])).values()) {
              const createdAt = Date.parse(article.createdAt);
              if (!Number.isFinite(createdAt) || createdAt > nowDate.getTime()) continue;
              if (!this.newestNewsAt || createdAt > Date.parse(this.newestNewsAt)) {
                this.newestNewsAt = article.createdAt;
              }
              for (const symbol of article.symbols) {
                addSource(symbol, "NEWS");
                nextNewsCounts.set(symbol, (nextNewsCounts.get(symbol) ?? 0) + 1);
                nextNewsArticleIds.set(symbol, [
                  ...new Set([...(nextNewsArticleIds.get(symbol) ?? []), article.id])
                ].sort((left, right) => left - right));
                cycleNewsEvidence.push({
                  articleId: String(article.id),
                  symbol,
                  createdAt: article.createdAt,
                  observedAt: now,
                  evidence: {
                    id: article.id,
                    headlineDigest: createHash("sha256").update(article.headline).digest("hex"),
                    createdAt: article.createdAt,
                    updatedAt: article.updatedAt,
                    ...(article.source ? { source: article.source } : {})
                  }
                });
              }
            }
            newsLive = true;
          } catch {
            endpointFailures.push({ endpoint: "news", required: false });
            for (const [symbol, sources] of this.dynamicSources) {
              if (sources.has("NEWS")) addSource(symbol, "NEWS");
            }
            for (const [symbol, count] of this.newsCounts) nextNewsCounts.set(symbol, count);
            for (const [symbol, ids] of this.newsArticleIds) nextNewsArticleIds.set(symbol, [...ids]);
          }
        } else {
          for (const [symbol, sources] of this.dynamicSources) {
            if (sources.has("NEWS")) addSource(symbol, "NEWS");
          }
          for (const [symbol, count] of this.newsCounts) nextNewsCounts.set(symbol, count);
          for (const [symbol, ids] of this.newsArticleIds) nextNewsArticleIds.set(symbol, [...ids]);
        }
        this.newsStatus = newsLive
          ? this.newestNewsAt && nowDate.getTime() - Date.parse(this.newestNewsAt) > NEWS_LOOKBACK_MS
            ? "STALE"
            : "LIVE"
          : nextNewsCounts.size > 0 ? "FALLBACK" : "UNAVAILABLE";
        this.dynamicSources = nextSources;
        this.newsCounts = nextNewsCounts;
        this.newsArticleIds = nextNewsArticleIds;
        this.lastOnlineUniverseRefreshAt = nowDate.getTime();
        this.onlineUniverseUpdatedAt = now;
      }
      const assetBySymbol = new Map(assets.map((asset) => [asset.symbol, asset]));
      const eligibleForPhase = (symbol: string): boolean => {
        const asset = assetBySymbol.get(symbol);
        return asset ? stockAssetSupportsPhase(asset, phase) : false;
      };
      const rotatingUniverse = deterministicUniverse(
        assets.map((asset) => asset.symbol),
        dayKey,
        lane.policy.universeSize
      ).filter(eligibleForPhase);
      const dynamicUniverse = [...this.dynamicSources.keys()].filter(eligibleForPhase);
      const universe = [...new Set([...dynamicUniverse, ...rotatingUniverse])]
        .slice(0, lane.policy.universeSize);
      const account = this.repository.account(lane.id);
      if (!account) throw new Error("The stock-paper account was not initialized.");
      const positions = this.repository.positions(lane.id, true, 100);
      const persistedPositionIds = new Set(positions.map((position) => position.id));
      const persistedPendingOrders = this.repository.pendingOrders(lane.id);
      const dueObservationsByHorizon = new Map<
        (typeof OBSERVATION_HORIZONS)[number],
        StockPaperObservation[]
      >();
      const dueRotationDecisionsByHorizon = new Map<
        (typeof OBSERVATION_HORIZONS)[number],
        StockPaperRotationDecision[]
      >();
      const dueEntries: Array<{
        observation: StockPaperObservation;
        horizonMinutes: (typeof OBSERVATION_HORIZONS)[number];
      }> = [];
      for (const horizonMinutes of OBSERVATION_HORIZONS) {
        const dueBefore = new Date(nowDate.getTime() - horizonMinutes * 60_000).toISOString();
        const due = this.repository.observationsDue(lane.id, horizonMinutes, dueBefore, 500);
        dueObservationsByHorizon.set(horizonMinutes, due);
        dueEntries.push(...due.map((observation) => ({ observation, horizonMinutes })));
        try {
          dueRotationDecisionsByHorizon.set(
            horizonMinutes,
            this.repository.rotationDecisionsDue(lane.id, horizonMinutes, dueBefore, 500)
          );
        } catch (error) {
          dueRotationDecisionsByHorizon.set(horizonMinutes, []);
          this.reportRotationAnalysisFailure(`due-${horizonMinutes}-minute query`, error);
        }
      }
      dueEntries.sort((left, right) =>
        left.observation.observedAt.localeCompare(right.observation.observedAt) ||
        left.observation.id.localeCompare(right.observation.id) ||
        left.horizonMinutes - right.horizonMinutes
      );
      type OutcomeHistoryTarget = {
        key: string;
        contextKey: string;
        symbol: string;
        startAt: string;
        endAt: string;
        phase: StockPaperObservation["phase"];
        feed: StockPaperObservation["feed"];
        historicalFeed: AlpacaHistoricalStockFeed;
        observationEvidence: boolean;
        rotationEvidence: boolean;
      };
      const outcomeHistoryTargetByKey = new Map<string, OutcomeHistoryTarget>();
      const addOutcomeHistoryTarget = (input: {
        symbol: string;
        startAt: string;
        endAt: string;
        phase: StockPaperObservation["phase"];
        feed: StockPaperObservation["feed"];
        observationEvidence?: boolean;
        rotationEvidence?: boolean;
      }): void => {
        const key = outcomeEvidenceTargetKey(input, input.symbol);
        const prior = outcomeHistoryTargetByKey.get(key);
        outcomeHistoryTargetByKey.set(key, {
          key,
          contextKey: outcomeEvidenceContextKey(input),
          symbol: input.symbol,
          phase: input.phase,
          feed: input.feed,
          historicalFeed: outcomeHistoricalFeed(input),
          startAt: prior && prior.startAt < input.startAt ? prior.startAt : input.startAt,
          endAt: prior && prior.endAt > input.endAt ? prior.endAt : input.endAt,
          observationEvidence: Boolean(prior?.observationEvidence || input.observationEvidence),
          rotationEvidence: Boolean(prior?.rotationEvidence || input.rotationEvidence)
        });
      };
      for (const { observation, horizonMinutes } of dueEntries) {
        const endAt = new Date(
          Date.parse(observation.observedAt) + horizonMinutes * 60_000
        ).toISOString();
        addOutcomeHistoryTarget({
          symbol: observation.symbol,
          startAt: observation.observedAt,
          endAt,
          phase: observation.phase,
          feed: observation.feed,
          observationEvidence: true
        });
      }
      for (const horizonMinutes of OBSERVATION_HORIZONS) {
        for (const decision of dueRotationDecisionsByHorizon.get(horizonMinutes) ?? []) {
          if (decision.status !== "ROTATE" || !decision.outgoing || !decision.incoming) continue;
          const endAt = new Date(
            Date.parse(decision.decisionAt) + horizonMinutes * 60_000
          ).toISOString();
          addOutcomeHistoryTarget({
            symbol: decision.outgoing.symbol,
            startAt: decision.decisionAt,
            endAt,
            phase: decision.phase,
            feed: decision.feed,
            rotationEvidence: true
          });
          addOutcomeHistoryTarget({
            symbol: decision.incoming.symbol,
            startAt: decision.decisionAt,
            endAt,
            phase: decision.phase,
            feed: decision.feed,
            rotationEvidence: true
          });
        }
      }
      // Work oldest pending symbols first. Remaining symbols stay label-pending
      // and rotate into the next cycle instead of becoming artificial MISSING rows.
      const outcomeHistoryTargets = [...outcomeHistoryTargetByKey.values()]
        .sort((left, right) =>
          Number(right.rotationEvidence) - Number(left.rotationEvidence) ||
          left.startAt.localeCompare(right.startAt) ||
          left.contextKey.localeCompare(right.contextKey) ||
          left.symbol.localeCompare(right.symbol)
        )
        .slice(0, OUTCOME_HISTORY_SYMBOLS_PER_CYCLE);
      // Benchmark bars use the same immutable phase/feed context as the source
      // observation. They are fetched alongside the selected target without
      // consuming another primary-outcome budget slot.
      const outcomeHistoryFetchTargetByKey = new Map(
        outcomeHistoryTargets.map((target) => [target.key, target])
      );
      for (const target of outcomeHistoryTargets.filter((entry) => entry.observationEvidence)) {
        const key = outcomeEvidenceTargetKey(target, "SPY");
        const prior = outcomeHistoryFetchTargetByKey.get(key);
        outcomeHistoryFetchTargetByKey.set(key, {
          ...target,
          key,
          symbol: "SPY",
          startAt: prior && prior.startAt < target.startAt ? prior.startAt : target.startAt,
          endAt: prior && prior.endAt > target.endAt ? prior.endAt : target.endAt,
          observationEvidence: true,
          rotationEvidence: Boolean(prior?.rotationEvidence)
        });
      }
      const symbols = [...new Set([
        ...universe,
        ...positions.map((position) => position.symbol),
        ...persistedPendingOrders.map((order) => order.symbol),
        "SPY"
      ])];
      const polledSnapshots: AlpacaStockSnapshot[] = [];
      for (const batch of batches(symbols, 100)) {
        polledSnapshots.push(...await request(() => provider.getSnapshots(batch, latestFeed)));
      }
      const snapshots = mergeStockSnapshots(polledSnapshots, stream?.marketSnapshots() ?? []);
      const snapshotBySymbol = new Map(snapshots.map((snapshot) => [snapshot.symbol, snapshot]));
      const universeSet = new Set(universe);
      const returnedUniverseSnapshots = snapshots.filter((snapshot) => universeSet.has(snapshot.symbol));
      const freshUniverseSnapshots = returnedUniverseSnapshots
        .filter((snapshot) => stockSnapshotIsFresh(snapshot, nowDate, undefined, maximumBarAgeMs));
      const prefilteredSnapshots = freshUniverseSnapshots
        .filter((snapshot) => passesStockSnapshotPrefilter(snapshot, lane.policy, phase));
      const ranked = prefilteredSnapshots
        .map((snapshot) => ({ snapshot, score: basicSnapshotScore(snapshot) }))
        .filter((entry) => Number.isFinite(entry.score))
        .sort((left, right) => right.score - left.score || left.snapshot.symbol.localeCompare(right.snapshot.symbol))
        .slice(0, lane.policy.detailedCandidateCount);
      const actionSymbols = [...new Set([
        ...ranked.map((entry) => entry.snapshot.symbol),
        ...positions.map((position) => position.symbol),
        ...persistedPendingOrders.map((order) => order.symbol)
      ])].slice(0, 100);
      const corporateActionEvidenceVerified = new Set<string>();
      if (typeof provider.getCorporateActions === "function") {
        const fullActionRefresh = nowDate.getTime() - this.corporateActionsUpdatedAt >= 15 * 60_000;
        if (!fullActionRefresh) {
          actionSymbols
            .filter((symbol) => this.corporateActionCheckedSymbols.has(symbol))
            .forEach((symbol) => corporateActionEvidenceVerified.add(symbol));
        }
        const symbolsToCheck = fullActionRefresh
          ? actionSymbols
          : actionSymbols.filter((symbol) => !this.corporateActionCheckedSymbols.has(symbol));
        if (symbolsToCheck.length > 0) {
          try {
            const blocked = fullActionRefresh
              ? new Set<string>()
              : new Set(this.corporateActionSymbols);
            let actionPageToken: string | undefined;
            for (let page = 0; page < 2; page += 1) {
              const result = await request(() => provider.getCorporateActions!({
                symbols: symbolsToCheck,
                start: dayKey,
                end: datePlusDays(dayKey, 3),
                ...(actionPageToken ? { pageToken: actionPageToken } : {})
              }));
              result.actions.forEach((action) => blocked.add(action.symbol));
              actionPageToken = result.nextPageToken;
              if (!actionPageToken) break;
            }
            this.corporateActionSymbols = blocked;
            if (fullActionRefresh) {
              this.corporateActionCheckedSymbols = new Set(symbolsToCheck);
              this.corporateActionsUpdatedAt = nowDate.getTime();
            } else {
              symbolsToCheck.forEach((symbol) => this.corporateActionCheckedSymbols.add(symbol));
            }
            symbolsToCheck.forEach((symbol) => corporateActionEvidenceVerified.add(symbol));
          } catch {
            endpointFailures.push({ endpoint: "corporate-actions", required: false });
          }
        }
      }
      stream?.configure(latestFeed, [...new Set([
        ...positions.map((position) => position.symbol),
        ...persistedPendingOrders.map((order) => order.symbol),
        ...ranked.map((entry) => entry.snapshot.symbol),
        "SPY",
        ...universe
      ])].slice(0, 30));
      const detailSymbols = [...new Set([
        ...ranked.map((entry) => entry.snapshot.symbol),
        ...positions.map((position) => position.symbol),
        ...persistedPendingOrders.map((order) => order.symbol),
        "SPY"
      ])];
      const start = new Date(nowDate.getTime() - 8 * 60 * 60_000).toISOString();
      const historicalEnd = phase === "OVERNIGHT"
        ? new Date(nowDate.getTime() - 16 * 60_000).toISOString()
        : now;
      const barsBySymbol = new Map<string, AlpacaStockBar[]>();
      const fetchBarHistory = async (
        batchSymbols: readonly string[],
        rangeStart: string,
        rangeEnd: string,
        requestedFeed: AlpacaHistoricalStockFeed = historicalFeed,
        destination: Map<string, AlpacaStockBar[]> = barsBySymbol
      ): Promise<boolean> => {
        if (batchSymbols.length === 0 || Date.parse(rangeEnd) <= Date.parse(rangeStart)) return false;
        let pageToken: string | undefined;
        for (let page = 0; page < ALPACA_BAR_MAX_PAGES; page += 1) {
          const result = await request(() => provider.getBars({
            symbols: batchSymbols,
            start: rangeStart,
            end: rangeEnd,
            feed: requestedFeed,
            ...(pageToken ? { pageToken } : {})
          }));
          for (const [symbol, bars] of result.bars) {
            destination.set(symbol, uniqueBars([...(destination.get(symbol) ?? []), ...bars]));
          }
          pageToken = result.nextPageToken;
          if (!pageToken) return true;
        }
        return false;
      };
      for (const batch of batches(detailSymbols, ALPACA_BAR_SYMBOL_BATCH_SIZE)) {
        await fetchBarHistory(batch, start, historicalEnd);
      }
      // Alpaca Basic exposes consolidated SIP history only after its delay.
      // During the 04:00-08:00 ET BOATS-to-IEX gap, fetch a separate stream for
      // fair-value accounting of held positions. It is deliberately never
      // merged into barsBySymbol or snapshotBySymbol, so it cannot trigger or
      // fill an order, alter a stop, or satisfy executable-price readiness.
      const delayedFairBarBySymbol = new Map<string, AlpacaStockBar>();
      if (phase === "PREMARKET") {
        const staleOpenSymbols = [...new Set(positions
          .filter((position) => {
            const snapshot = snapshotBySymbol.get(position.symbol);
            return !snapshot || !stockSnapshotIsFresh(
              snapshot,
              nowDate,
              undefined,
              maximumBarAgeMs
            );
          })
          .map((position) => position.symbol))];
        if (staleOpenSymbols.length > 0) {
          const delayedSipEnd = new Date(
            nowDate.getTime() - ALPACA_DELAYED_SIP_MINIMUM_AGE_MS
          ).toISOString();
          const delayedSipStart = new Date(nowDate.getTime() - 8 * 60 * 60_000).toISOString();
          const delayedSipBars = new Map<string, AlpacaStockBar[]>();
          try {
            for (const batch of batches(staleOpenSymbols, ALPACA_BAR_SYMBOL_BATCH_SIZE)) {
              await fetchBarHistory(
                batch,
                delayedSipStart,
                delayedSipEnd,
                "sip",
                delayedSipBars
              );
            }
            for (const symbol of staleOpenSymbols) {
              const causalPremarketWindow = currentPhaseBarWindow({
                bars: delayedSipBars.get(symbol) ?? [],
                capturedAt: now,
                phase: "PREMARKET",
                maximumLatestAgeMs: ALPACA_DELAYED_SIP_MAXIMUM_FAIR_VALUE_AGE_MS
              });
              const latest = causalPremarketWindow.at(-1);
              if (latest && Date.parse(latest.timestamp) <= Date.parse(delayedSipEnd)) {
                delayedFairBarBySymbol.set(symbol, latest);
              }
            }
          } catch {
            endpointFailures.push({
              endpoint: "delayed-sip-fair-value",
              required: false,
              message: "Delayed SIP fair-value history was unavailable; executable IEX safety remains unchanged."
            });
          }
        }
      }
      const outcomeBarsByContext = new Map<string, Map<string, AlpacaStockBar[]>>();
      const completedOutcomeHistoryTargets = new Set<string>();
      const outcomeTargetsByContext = new Map<string, OutcomeHistoryTarget[]>();
      for (const target of outcomeHistoryFetchTargetByKey.values()) {
        outcomeTargetsByContext.set(target.contextKey, [
          ...(outcomeTargetsByContext.get(target.contextKey) ?? []),
          target
        ]);
      }
      for (const [contextKey, contextTargets] of [...outcomeTargetsByContext].sort(([left], [right]) =>
        left.localeCompare(right)
      )) {
        const destination = outcomeBarsByContext.get(contextKey) ?? new Map<string, AlpacaStockBar[]>();
        outcomeBarsByContext.set(contextKey, destination);
        for (const targetBatch of batches(contextTargets, ALPACA_BAR_SYMBOL_BATCH_SIZE)) {
          const rangeStart = targetBatch.reduce(
            (oldest, target) => target.startAt < oldest ? target.startAt : oldest,
            targetBatch[0]!.startAt
          );
          const requestedEnd = targetBatch.reduce(
            (newest, target) => target.endAt > newest ? target.endAt : newest,
            targetBatch[0]!.endAt
          );
          const evidenceHistoricalEnd = targetBatch[0]!.historicalFeed === "boats"
            ? new Date(nowDate.getTime() - 16 * 60_000).toISOString()
            : now;
          const rangeEnd = requestedEnd < evidenceHistoricalEnd
            ? requestedEnd
            : evidenceHistoricalEnd;
          let complete = false;
          try {
            complete = await fetchBarHistory(
              targetBatch.map((target) => target.symbol),
              rangeStart,
              rangeEnd,
              targetBatch[0]!.historicalFeed,
              destination
            );
          } catch (error) {
            // Observation labeling is authoritative and must surface provider
            // failure. Rotation-only analysis remains non-blocking.
            if (targetBatch.some((target) => target.observationEvidence)) throw error;
            this.reportRotationAnalysisFailure("outcome history fetch", error);
            continue;
          }
          if (complete) {
            for (const target of targetBatch) {
              if (rangeEnd >= target.endAt) completedOutcomeHistoryTargets.add(target.key);
            }
          }
        }
      }
      for (const symbol of detailSymbols) {
        const persisted = this.repository.bars(lane.id, symbol, start, now);
        const latestBar = snapshotBySymbol.get(symbol)?.minuteBar;
        barsBySymbol.set(symbol, uniqueBars([
          ...persisted,
          ...(barsBySymbol.get(symbol) ?? []),
          ...(latestBar ? [latestBar] : [])
        ]));
      }
      const previousCandidateBySymbol = new Map(
        this.repository.candidates(lane.id, 1_000).map((candidate) => [candidate.symbol, candidate])
      );
      const scoreCurrentSnapshot = (snapshot: AlpacaStockSnapshot): StockPaperCandidate => {
        const asset = assetBySymbol.get(snapshot.symbol);
        const sources = [...(this.dynamicSources.get(snapshot.symbol) ?? new Set())];
        return scoreStockCandidate({
          snapshot,
          bars: barsBySymbol.get(snapshot.symbol) ?? [],
          policy: lane.policy,
          ...(asset?.name ? { name: asset.name } : {}),
          ...(asset?.exchange ? { exchange: asset.exchange } : {}),
          phase,
          feed: marketFeed,
          ...(sources.length > 0 ? { onlineSources: sources } : {}),
          newsArticleCount: this.newsCounts.get(snapshot.symbol) ?? 0,
          capturedAt: now
        });
      };
      const candidates = ranked.map(({ snapshot }) => scoreCurrentSnapshot(snapshot))
        .sort((left, right) => right.score - left.score || left.symbol.localeCompare(right.symbol));
      // Rotation research needs same-clock evidence for a weakening held symbol
      // even when it no longer passes the authoritative prefilter/ranking. This
      // map is deliberately not persisted or merged into the trading candidate
      // list; it can only serve as the outgoing leg of the pure challenger.
      const rotationOutgoingCandidateBySymbol = new Map<string, StockPaperCandidate>();
      for (const position of positions) {
        try {
          const snapshot = snapshotBySymbol.get(position.symbol);
          if (!snapshot || !stockSnapshotIsFresh(
            snapshot,
            nowDate,
            undefined,
            maximumBarAgeMs
          )) continue;
          rotationOutgoingCandidateBySymbol.set(
            position.symbol,
            scoreCurrentSnapshot(snapshot)
          );
        } catch (error) {
          this.reportRotationAnalysisFailure("outgoing evidence scoring", error);
        }
      }
      const candidateBySymbol = new Map(
        candidates.map((candidate) => [candidate.symbol, candidate])
      );

      const minutesRemaining = clock.isOpen
        ? Math.max(0, (Date.parse(clock.nextClose) - nowDate.getTime()) / 60_000)
        : undefined;
      const mutableAccount: StockPaperAccount = { ...account };
      const positionById = new Map(positions.map((position) => [position.id, position]));
      if (mutableAccount.dayKey !== dayKey) {
        mutableAccount.dayKey = dayKey;
        mutableAccount.dayStartNavUsd = mutableAccount.navUsd;
        delete mutableAccount.pausedReason;
      }
      const officialCalendarAllows = this.calendarStatus !== "VERIFIED" ||
        this.calendarTradeDays.has(dayKey);
      const calendarEntryWindow = calendarAllowsEntries(clock, phase, nowDate) &&
        officialCalendarAllows;
      const currentBuyCapacityState = () => {
        const currentPositions = [...positionById.values()];
        const executableValues = currentPositions.map((position) => {
          const snapshot = snapshotBySymbol.get(position.symbol);
          const quote = snapshot?.latestQuote;
          if (!snapshot || !quote || quote.bidPrice <= 0 || quote.askPrice <= quote.bidPrice ||
              !stockSnapshotIsFresh(snapshot, nowDate, undefined, maximumBarAgeMs)) {
            return undefined;
          }
          const currentSpread = spreadPercent(snapshot);
          const penalty = phase === "REGULAR"
            ? 1
            : 1 - lane.policy.extendedFillPenaltyPercent / 100;
          return position.quantity * modeledSellFill(quote.bidPrice, currentSpread) * penalty;
        });
        const pricingComplete = executableValues.every(
          (value): value is number => value !== undefined && Number.isFinite(value) && value >= 0
        );
        const executableNavUsd = pricingComplete
          ? mutableAccount.cashUsd + executableValues.reduce<number>((sum, value) => sum + value!, 0)
          : undefined;
        const drawdownPercent = executableNavUsd !== undefined && mutableAccount.peakNavUsd > 0
          ? (mutableAccount.peakNavUsd - executableNavUsd) / mutableAccount.peakNavUsd * 100
          : 0;
        const dailyLossPercent = executableNavUsd !== undefined && mutableAccount.dayStartNavUsd > 0
          ? (mutableAccount.dayStartNavUsd - executableNavUsd) / mutableAccount.dayStartNavUsd * 100
          : 0;
        return {
          pricingComplete,
          executableNavUsd,
          drawdownPercent,
          dailyLossPercent,
          deployedCostUsd: currentPositions.reduce(
            (sum, position) => sum + position.remainingCostUsd,
            0
          ),
          openPositions: currentPositions.length
        };
      };
      const pendingBuyCapacityReason = (
        order: StockPaperOrder,
        incrementalNotionalUsd = 0
      ): string | undefined => {
        const state = currentBuyCapacityState();
        const maximumPositions = phase === "REGULAR"
          ? lane.policy.maximumOpenPositions
          : Math.min(lane.policy.maximumOpenPositions, lane.policy.extendedMaximumOpenPositions);
        if (!positionById.has(order.positionId ?? "") && state.openPositions >= maximumPositions) {
          return "Open-position capacity became unavailable before the pending PAPER fill.";
        }
        const projectedCashUsd = mutableAccount.cashUsd - incrementalNotionalUsd;
        if (projectedCashUsd < lane.policy.minimumCashReserveUsd - 1e-8) {
          return "The pending PAPER fill would breach the minimum cash reserve.";
        }
        if (state.executableNavUsd === undefined || state.executableNavUsd <= 0) {
          return "Executable NAV is unavailable for the pending PAPER capacity check.";
        }
        const existingPositionCostUsd = positionById.get(order.positionId ?? "")
          ?.remainingCostUsd ?? 0;
        const remainingIntentNotionalUsd = Math.max(
          0,
          order.requestedQuantity - order.filledQuantity
        ) * order.limitPriceUsd;
        const projectedPositionNotionalUsd = Math.max(
          existingPositionCostUsd + incrementalNotionalUsd,
          existingPositionCostUsd + remainingIntentNotionalUsd
        );
        if (projectedPositionNotionalUsd >
            state.executableNavUsd * lane.policy.maximumPositionNavFraction + 1e-8) {
          return "The pending PAPER position would breach the maximum per-position NAV fraction.";
        }
        const projectedDeployedCostUsd = state.deployedCostUsd + incrementalNotionalUsd;
        if (projectedDeployedCostUsd >
            state.executableNavUsd * lane.policy.maximumDeployedFraction + 1e-8) {
          return "The pending PAPER fill would breach the maximum deployed fraction.";
        }
        return undefined;
      };
      type PendingBuyGateDecision = {
        action: "CANCEL" | "HOLD";
        reason: string;
      };
      const pendingBuyCancelReason = (order: StockPaperOrder): string | undefined => {
        const state = currentBuyCapacityState();
        if (mutableAccount.pausedReason) {
          return `The PAPER account is paused: ${mutableAccount.pausedReason}`;
        }
        if (state.drawdownPercent >= lane.policy.maximumDrawdownPercent) {
          return "The maximum PAPER drawdown gate became active before fill evidence arrived.";
        }
        if (state.dailyLossPercent >= lane.policy.dailyLossPausePercent) {
          return "The daily PAPER loss gate became active before fill evidence arrived.";
        }
        if (!sessionActive) {
          return "The current market phase is not actionable for a pending PAPER entry.";
        }
        if (order.phase !== phase || order.feed !== marketFeed) {
          return "The market phase or feed changed before the PAPER order filled.";
        }
        if (!calendarEntryWindow) {
          return officialCalendarAllows
            ? "The exchange calendar no longer provides a continuous actionable entry window."
            : "The verified exchange calendar does not allow an entry on this trade day.";
        }
        if (phase !== "REGULAR" && !extendedEntryWindowOpen(phase, now)) {
          return "The extended-hours entry window closed before the pending PAPER order filled.";
        }
        const asset = assetBySymbol.get(order.symbol);
        if (asset && !stockAssetSupportsPhase(asset, phase)) {
          return "Current symbol eligibility for this market phase is unsafe.";
        }
        if (this.corporateActionSymbols.has(order.symbol)) {
          return "A material corporate action is pending for the symbol.";
        }
        return undefined;
      };
      const pendingBuyHoldReason = (order: StockPaperOrder): string | undefined => {
        const state = currentBuyCapacityState();
        if (!state.pricingComplete) {
          return "Required executable account-pricing evidence is not actionable.";
        }
        const clockAgeMs = nowDate.getTime() - Date.parse(clock.timestamp);
        if (!Number.isFinite(clockAgeMs) || clockAgeMs < -30_000 || clockAgeMs > 2 * 60_000) {
          return "Required market-clock evidence is unavailable or stale.";
        }
        if (endpointFailures.some((failure) => failure.required)) {
          return "A required market-data endpoint failed before fill resolution.";
        }
        const asset = assetBySymbol.get(order.symbol);
        if (!asset) {
          return "Current symbol eligibility evidence is unavailable for the active market phase.";
        }
        if (!corporateActionEvidenceVerified.has(order.symbol)) {
          return "Current corporate-action safety evidence is unavailable; the entry remains on hold.";
        }
        const snapshot = snapshotBySymbol.get(order.symbol);
        if (!snapshot || !stockQuoteIsFresh(snapshot, nowDate)) {
          return "Required current quote evidence is unavailable or stale; the entry remains on hold.";
        }
        const currentSpread = spreadPercent(snapshot);
        const spreadLimit = phase === "REGULAR"
          ? lane.policy.maximumSpreadPercent
          : lane.policy.extendedEntrySpreadPercent;
        if (!Number.isFinite(currentSpread) || currentSpread > spreadLimit) {
          return `The fresh spread exceeds the ${spreadLimit.toFixed(2)}% PAPER fill policy; the entry remains on hold.`;
        }
        return undefined;
      };
      const pendingBuySoftGateReason = (order: StockPaperOrder): string | undefined => {
        const candidate = candidateBySymbol.get(order.symbol);
        if (!candidate || candidate.marketPhase !== phase || candidate.marketFeed !== marketFeed) {
          return "Current candidate evidence is unavailable on the active phase and feed.";
        }
        if (!candidate.eligible || candidate.score < lane.policy.minimumSignalScore) {
          return "The current candidate signal materially decayed below the v3 entry policy.";
        }
        if (phase !== "REGULAR" && !candidate.highConviction) {
          return "The current extended-hours candidate is no longer high-conviction.";
        }
        return undefined;
      };
      const pendingBuyGateDecision = (order: StockPaperOrder): PendingBuyGateDecision | undefined => {
        const cancelReason = pendingBuyCancelReason(order);
        if (cancelReason) return { action: "CANCEL", reason: cancelReason };
        const holdReason = pendingBuyHoldReason(order);
        if (holdReason) return { action: "HOLD", reason: holdReason };
        const capacityReason = pendingBuyCapacityReason(order);
        return capacityReason
          ? { action: "CANCEL", reason: capacityReason }
          : undefined;
      };
      const changedPositions: StockPaperPosition[] = [];
      const openPositions: StockPaperPosition[] = [];
      const signals: StockPaperSignal[] = [];
      const newTrades: StockPaperTrade[] = [];
      const changedOrderById = new Map<string, StockPaperOrder>();
      const orderEvents: StockPaperOrderEvent[] = [];
      const persistedOrderById = new Map(
        persistedPendingOrders.map((order) => [order.id, order])
      );
      // `now` is the immutable market-decision boundary for the cycle. Provider
      // calls happen after that boundary, so it must not also be used as the
      // observation time for evidence returned by those asynchronous calls.
      // Capture the real receipt/processing clock once all cycle evidence is in
      // memory. Individual events below advance from this point when their
      // provider evidence has a later causal availability timestamp.
      const cycleEvidenceReceivedAt = (this.options.now?.() ?? new Date()).toISOString();
      const stageOrder = (
        nextOrder: StockPaperOrder,
        evidence: {
          bar?: AlpacaStockBar;
          snapshot?: AlpacaStockSnapshot;
          spreadPercent?: number;
          participationRatePercent?: number;
          marketable?: boolean;
          evidenceObservedAt?: string;
          benchmarkBar?: AlpacaStockBar;
          benchmarkSnapshot?: AlpacaStockSnapshot;
          reason?: string | undefined;
        } = {}
      ): void => {
        const priorOrder = changedOrderById.get(nextOrder.id) ?? persistedOrderById.get(nextOrder.id);
        const priorFillIds = new Set([
          ...(priorOrder?.fills.map((fill) => fill.id) ?? []),
          ...(!priorOrder && nextOrder.replacesOrderId
            ? nextOrder.fills.map((fill) => fill.id)
            : [])
        ]);
        const newFills = nextOrder.fills.filter((fill) => !priorFillIds.has(fill.id));
        const quote = quoteEvidence(evidence.snapshot);
        const assumptions = {
          executionVersion: STOCK_PAPER_EXECUTION_VERSION,
          limitPriceUsd: nextOrder.limitPriceUsd,
          participationRatePercent:
            evidence.participationRatePercent ?? lane.policy.maximumBarParticipationPercent,
          marketable: evidence.marketable ?? nextOrder.side === "SELL",
          ...(evidence.spreadPercent !== undefined && Number.isFinite(evidence.spreadPercent)
            ? { spreadPercent: evidence.spreadPercent }
            : {}),
          extendedFillPenaltyPercent: phase === "REGULAR"
            ? 0
            : lane.policy.extendedFillPenaltyPercent
        };
        const appendEvent = (
          eventType: StockPaperOrderEvent["eventType"],
          priorStatus: StockPaperOrderStatus | undefined,
          newStatus: StockPaperOrderStatus,
          fill: StockPaperOrderFill | undefined,
          sequence: number
        ): void => {
          const identity = fill
            ? `fill:${fill.id}`
            : `${eventType.toLowerCase()}:${priorStatus ?? "NONE"}:${newStatus}:${nextOrder.updatedAt}`;
          const idempotencyKey = `${nextOrder.id}:${identity}`;
          const barDigest = barEvidenceDigest(evidence.bar);
          const benchmarkBarDigest = barEvidenceDigest(evidence.benchmarkBar);
          const benchmarkQuote = quoteEvidence(evidence.benchmarkSnapshot);
          const rawBenchmarkQuote = evidence.benchmarkSnapshot?.latestQuote;
          const benchmarkRawEvidence = evidence.benchmarkBar
            ? {
                kind: "BAR" as const,
                timestamp: evidence.benchmarkBar.timestamp,
                open: evidence.benchmarkBar.open,
                high: evidence.benchmarkBar.high,
                low: evidence.benchmarkBar.low,
                close: evidence.benchmarkBar.close,
                volume: evidence.benchmarkBar.volume,
                tradeCount: evidence.benchmarkBar.tradeCount,
                vwap: evidence.benchmarkBar.vwap
              }
            : rawBenchmarkQuote
              ? {
                  kind: "QUOTE" as const,
                  timestamp: rawBenchmarkQuote.timestamp,
                  bidPrice: rawBenchmarkQuote.bidPrice,
                  bidSize: rawBenchmarkQuote.bidSize,
                  askPrice: rawBenchmarkQuote.askPrice,
                  askSize: rawBenchmarkQuote.askSize
                }
              : undefined;
          const benchmarkPriceUsd = evidence.benchmarkBar?.close ??
            (rawBenchmarkQuote
              ? (rawBenchmarkQuote.bidPrice + rawBenchmarkQuote.askPrice) / 2
              : undefined);
          const benchmarkTimestamp = evidence.benchmarkBar?.timestamp ??
            benchmarkQuote.quoteTimestamp;
          const benchmarkDigest = benchmarkBarDigest ?? benchmarkQuote.quoteDigest;
          const recordedAt = (this.options.now?.() ?? new Date()).toISOString();
          const observedAt = latestCausalTimestamp(cycleEvidenceReceivedAt, [
            causalEvidenceTime(evidence.evidenceObservedAt),
            causalEvidenceTime(evidence.bar?.timestamp, "BAR"),
            causalEvidenceTime(evidence.snapshot?.latestQuote?.timestamp),
            causalEvidenceTime(evidence.benchmarkBar?.timestamp, "BAR"),
            causalEvidenceTime(evidence.benchmarkSnapshot?.latestQuote?.timestamp),
            causalEvidenceTime(fill?.evidenceAt, fill?.evidence)
          ]);
          const eventAt = latestCausalTimestamp(recordedAt, [
            causalEvidenceTime(now),
            causalEvidenceTime(observedAt)
          ]);
          const event: StockPaperOrderEvent = {
            id: `stock-order-event:${createHash("sha256").update(idempotencyKey).digest("hex")}`,
            idempotencyKey,
            laneId: nextOrder.laneId,
            orderId: nextOrder.id,
            sequence,
            ...(nextOrder.positionId ? { positionId: nextOrder.positionId } : {}),
            symbol: nextOrder.symbol,
            side: nextOrder.side,
            eventType,
            ...(priorStatus ? { priorStatus } : {}),
            newStatus,
            decisionAt: eventAt,
            ...(evidence.bar ? { evidenceBarTimestamp: evidence.bar.timestamp } : {}),
            ...((evidence.bar || evidence.snapshot)
              ? { evidenceObservedAt: observedAt }
              : {}),
            ...quote,
            ...(barDigest ? { barDigest } : {}),
            ...(benchmarkPriceUsd !== undefined && benchmarkTimestamp && benchmarkDigest &&
                benchmarkRawEvidence
              ? {
                  benchmarkSymbol: "SPY" as const,
                  benchmarkEvidence: evidence.benchmarkBar ? "BAR" as const : "QUOTE" as const,
                  benchmarkTimestamp,
                  benchmarkObservedAt: observedAt,
                  benchmarkPriceUsd,
                  benchmarkDigest,
                  benchmarkRawEvidence
                }
              : {}),
            phase,
            feed: marketFeed,
            assumptions,
            ...(fill ? { fill } : {}),
            reason: evidence.reason ?? nextOrder.reason ??
              `${eventType.replaceAll("_", " ").toLowerCase()} recorded by the PAPER execution model.`,
            createdAt: eventAt
          };
          orderEvents.push(event);
        };

        let statusCursor = priorOrder?.status;
        if (!priorOrder) {
          const submissionStatus = newFills.length > 0 ? "SUBMITTED" : nextOrder.status;
          appendEvent("SUBMISSION", undefined, submissionStatus, undefined, 0);
          statusCursor = submissionStatus;
        }
        for (const [index, fill] of newFills.entries()) {
          const fillStatus = index === newFills.length - 1
            ? nextOrder.status
            : "PARTIAL";
          const fillSequence = nextOrder.fills.findIndex((entry) => entry.id === fill.id) + 1;
          appendEvent("FILL", statusCursor, fillStatus, fill, fillSequence);
          statusCursor = fillStatus;
        }
        if (newFills.length === 0 && priorOrder && priorOrder.status !== nextOrder.status) {
          appendEvent(
            "STATUS_TRANSITION",
            priorOrder.status,
            nextOrder.status,
            undefined,
            nextOrder.fills.length + 1
          );
        }
        changedOrderById.set(nextOrder.id, nextOrder);
      };
      const completedBarBoundaryMs = Math.floor(nowDate.getTime() / 60_000) * 60_000;
      const completedBarsFor = (symbol: string): AlpacaStockBar[] =>
        uniqueBars(barsBySymbol.get(symbol) ?? []).filter((bar) => {
          const barAt = Date.parse(bar.timestamp);
          return Number.isFinite(barAt) && barAt < completedBarBoundaryMs;
        });
      const completedBenchmarkBarFor = (barTimestamp: string): AlpacaStockBar | undefined =>
        completedBarsFor("SPY").filter((bar) => bar.timestamp <= barTimestamp).at(-1);
      const isPending = (order: StockPaperOrder): boolean =>
        order.status === "SUBMITTED" || order.status === "PARTIAL";

      // Rehydrate and resolve durable entry intents before scoring new entries.
      // Provenance is validated before resolution so malformed persisted state
      // cannot gain fill evidence. Affirmative account, session, asset,
      // corporate-action, and capacity breaches remain terminal before every
      // fill. Missing/transient quote, clock, pricing, or spread evidence holds
      // the order without filling it. Entry-time ranking, score, and delayed
      // snapshot-bar freshness must not retroactively cancel an accepted
      // overnight order before its immutable confirmation window can receive the
      // delayed causal BOATS bar.
      // Completed bars prevent current-minute lookahead, and protective exits are
      // checked before every later BUY fill.
      for (const persistedOrder of persistedPendingOrders) {
        if (persistedOrder.side !== "BUY") continue;
        let currentOrder = persistedOrder;
        const positionId = currentOrder.positionId;
        const context = currentOrder.entryContext;
        if (!positionId || !context) {
          currentOrder = {
            ...currentOrder,
            status: "REJECTED",
            reason: "The persisted PAPER order is missing immutable entry provenance.",
            reservedNotionalUsd: 0,
            updatedAt: now
          };
          stageOrder(currentOrder, { reason: currentOrder.reason });
          continue;
        }
        const submittedAtMs = Date.parse(currentOrder.submittedAt);
        const firstEligibleBarAtMs = Date.parse(currentOrder.firstEligibleBarAt ?? "");
        const expiresAtMs = Date.parse(currentOrder.expiresAt);
        const contextCapturedAtMs = Date.parse(context.capturedAt);
        const immutableProvenanceInvalid =
          context.phase !== currentOrder.phase ||
          context.feed !== currentOrder.feed ||
          context.policyVersion !== currentOrder.policyVersion ||
          context.executionVersion !== currentOrder.executionVersion ||
          !Number.isFinite(submittedAtMs) ||
          !Number.isFinite(firstEligibleBarAtMs) ||
          !Number.isFinite(expiresAtMs) ||
          !Number.isFinite(contextCapturedAtMs) ||
          contextCapturedAtMs > submittedAtMs ||
          firstEligibleBarAtMs <= submittedAtMs ||
          expiresAtMs <= firstEligibleBarAtMs ||
          !Number.isFinite(currentOrder.limitPriceUsd) ||
          currentOrder.limitPriceUsd <= 0 ||
          !Number.isFinite(currentOrder.requestedQuantity) ||
          currentOrder.requestedQuantity <= 0 ||
          currentOrder.filledQuantity < 0 ||
          currentOrder.filledQuantity > currentOrder.requestedQuantity + 1e-8 ||
          Math.abs(context.modeledLimitPriceUsd - currentOrder.limitPriceUsd) > 1e-8 ||
          Math.abs(context.candidateScore - currentOrder.candidateScore) > 1e-8;
        if (immutableProvenanceInvalid) {
          currentOrder = {
            ...currentOrder,
            status: "REJECTED",
            reason: "The persisted PAPER order has inconsistent immutable entry provenance.",
            reservedNotionalUsd: 0,
            updatedAt: now
          };
          stageOrder(currentOrder, { reason: currentOrder.reason });
          continue;
        }
        if (this.repository.tradeForPosition(lane.id, positionId)) {
          currentOrder = {
            ...currentOrder,
            status: "REJECTED",
            reason: "The PAPER position was already closed; reopening from a stale order is forbidden.",
            reservedNotionalUsd: 0,
            updatedAt: now
          };
          stageOrder(currentOrder, { reason: currentOrder.reason });
          continue;
        }
        const persistedPosition = positionById.get(positionId);
        if (
          (persistedPosition && (
            persistedPosition.laneId !== lane.id ||
            persistedPosition.symbol !== currentOrder.symbol ||
            persistedPosition.arm !== currentOrder.arm ||
            Math.abs(persistedPosition.quantity - currentOrder.filledQuantity) > 1e-8
          )) ||
          (!persistedPosition && currentOrder.filledQuantity > 1e-8)
        ) {
          currentOrder = {
            ...currentOrder,
            status: "REJECTED",
            reason: "The persisted PAPER order and partial position do not reconcile.",
            reservedNotionalUsd: 0,
            updatedAt: now
          };
          stageOrder(currentOrder, { reason: currentOrder.reason });
          continue;
        }
        let buyHoldReason: string | undefined;
        const buyGateDecision = pendingBuyGateDecision(currentOrder);
        if (buyGateDecision?.action === "CANCEL") {
          const canceled = cancelStockPaperLimitOrderV3(
            asExecutionOrder(currentOrder),
            now,
            buyGateDecision.reason
          );
          currentOrder = {
            ...currentOrder,
            status: canceled.status,
            ...(canceled.terminalReason ? { reason: canceled.terminalReason } : {}),
            reservedNotionalUsd: 0,
            updatedAt: now
          };
          const gateSnapshot = snapshotBySymbol.get(currentOrder.symbol);
          stageOrder(currentOrder, {
            ...(gateSnapshot ? { snapshot: gateSnapshot, spreadPercent: spreadPercent(gateSnapshot) } : {}),
            reason: buyGateDecision.reason
          });
          continue;
        }
        if (buyGateDecision?.action === "HOLD") buyHoldReason = buyGateDecision.reason;
        if (!buyHoldReason) {
          for (const bar of completedBarsFor(currentOrder.symbol)) {
          if (!isPending(currentOrder)) break;
          const repeatedGateDecision = pendingBuyGateDecision(currentOrder);
          if (repeatedGateDecision?.action === "HOLD") {
            buyHoldReason = repeatedGateDecision.reason;
            break;
          }
          if (repeatedGateDecision?.action === "CANCEL") {
            const canceled = cancelStockPaperLimitOrderV3(
              asExecutionOrder(currentOrder),
              now,
              repeatedGateDecision.reason
            );
            currentOrder = {
              ...currentOrder,
              status: canceled.status,
              ...(canceled.terminalReason ? { reason: canceled.terminalReason } : {}),
              reservedNotionalUsd: 0,
              updatedAt: now
            };
            const repeatedGateSnapshot = snapshotBySymbol.get(currentOrder.symbol);
            stageOrder(currentOrder, {
              ...(repeatedGateSnapshot
                ? {
                    snapshot: repeatedGateSnapshot,
                    spreadPercent: spreadPercent(repeatedGateSnapshot)
                  }
                : {}),
              reason: repeatedGateDecision.reason
            });
            break;
          }
          const existingBeforeBar = positionById.get(positionId);
          if (existingBeforeBar) {
            const firstProtectiveBarAt = firstEligibleStockPaperBarAtV3(existingBeforeBar.openedAt);
            const protectiveBarEligible =
              (!firstProtectiveBarAt || bar.timestamp >= firstProtectiveBarAt) &&
              (!existingBeforeBar.lastProtectiveBarAt ||
                bar.timestamp > existingBeforeBar.lastProtectiveBarAt);
            const protectiveExit = protectiveBarEligible
              ? resolveLongStockPaperProtectiveExitV3({
                  bar,
                  stopPriceUsd: existingBeforeBar.stopPriceUsd,
                  targetPriceUsd: existingBeforeBar.takeProfitPriceUsd
                })
              : undefined;
            if (protectiveExit) {
              const canceled = cancelStockPaperLimitOrderV3(
                asExecutionOrder(currentOrder),
                now,
                `The unfilled BUY remainder was canceled before ${protectiveExit.reason} liquidation.`
              );
              currentOrder = {
                ...currentOrder,
                status: canceled.status,
                ...(canceled.terminalReason ? { reason: canceled.terminalReason } : {}),
                reservedNotionalUsd: 0,
                updatedAt: now
              };
              const cancelSnapshot = snapshotBySymbol.get(currentOrder.symbol);
              stageOrder(currentOrder, {
                bar,
                ...(cancelSnapshot
                  ? { snapshot: cancelSnapshot, spreadPercent: spreadPercent(cancelSnapshot) }
                  : {}),
                reason: currentOrder.reason
              });
              break;
            }
          }
          const result = resolveStockPaperLimitOrderV3({
            order: asExecutionOrder(currentOrder),
            bar,
            participationRate: lane.policy.maximumBarParticipationPercent / 100
          });
          const projectedCapacityReason = result.fill
            ? pendingBuyCapacityReason(currentOrder, result.fill.notionalUsd)
            : undefined;
          if (projectedCapacityReason) {
            const canceled = cancelStockPaperLimitOrderV3(
              asExecutionOrder(currentOrder),
              now,
              projectedCapacityReason
            );
            currentOrder = {
              ...currentOrder,
              status: canceled.status,
              ...(canceled.terminalReason ? { reason: canceled.terminalReason } : {}),
              reservedNotionalUsd: 0,
              updatedAt: now
            };
            const capacitySnapshot = snapshotBySymbol.get(currentOrder.symbol);
            stageOrder(currentOrder, {
              bar,
              ...(capacitySnapshot
                ? { snapshot: capacitySnapshot, spreadPercent: spreadPercent(capacitySnapshot) }
                : {}),
              reason: projectedCapacityReason
            });
            break;
          }
          const applied = applyExecutionResolution(currentOrder, result, now);
          currentOrder = applied.order;
          if (!applied.fill) continue;
          const fill = applied.fill;
          const existing = positionById.get(positionId);
          const nextQuantity = (existing?.quantity ?? 0) + fill.quantity;
          const nextCost = (existing?.remainingCostUsd ?? 0) + fill.notionalUsd;
          const averageEntry = nextCost / nextQuantity;
          const snapshot = snapshotBySymbol.get(currentOrder.symbol);
          const bid = snapshot?.latestQuote?.bidPrice ?? fill.priceUsd;
          const ask = snapshot?.latestQuote?.askPrice ?? fill.priceUsd;
          const benchmarkBar = completedBenchmarkBarFor(bar.timestamp);
          stageOrder(currentOrder, {
            bar,
            ...(benchmarkBar ? { benchmarkBar } : {}),
            ...(snapshot ? { snapshot, spreadPercent: spreadPercent(snapshot) } : {}),
            participationRatePercent: lane.policy.maximumBarParticipationPercent,
            marketable: false,
            reason: result.reason === "PARTIAL_FILL"
              ? "A causal bar produced a participation-limited PAPER BUY fill."
              : "A causal bar completed the durable PAPER BUY order."
          });
          const nextPosition: StockPaperPosition = {
            ...(existing ?? {
              id: positionId,
              laneId: lane.id,
              symbol: currentOrder.symbol,
              arm: currentOrder.arm,
              scoreAtEntry: currentOrder.candidateScore,
              entryContext: context,
              openedAt: fill.evidenceAt,
              peakPriceUsd: averageEntry
            }),
            status: "OPEN",
            quantity: nextQuantity,
            entryPriceUsd: averageEntry,
            entryNotionalUsd: nextCost,
            remainingCostUsd: nextCost,
            lastBidUsd: bid,
            lastAskUsd: ask,
            lastMarkUsd: bid,
            lastValueUsd: nextQuantity * bid,
            lastExecutableValueUsd: nextQuantity * bid,
            peakPriceUsd: Math.max(existing?.peakPriceUsd ?? averageEntry, bid),
            stopPriceUsd: averageEntry * (1 - lane.policy.stopLossPercent / 100),
            takeProfitPriceUsd: averageEntry * (1 + lane.policy.takeProfitPercent / 100),
            updatedAt: now
          };
          positionById.set(positionId, nextPosition);
          mutableAccount.cashUsd -= fill.notionalUsd + fill.modeledCostsUsd;
          signals.push({
            id: eventId(lane.id, now, currentOrder.symbol, `BUY_FILL:${fill.id}`),
            laneId: lane.id,
            symbol: currentOrder.symbol,
            arm: currentOrder.arm,
            action: "BUY",
            outcome: "SIMULATED",
            score: currentOrder.candidateScore,
            notionalUsd: fill.notionalUsd,
            priceUsd: fill.priceUsd,
            reasons: [
              `${phase.toLowerCase().replaceAll("_", " ")} causal next-bar PAPER fill`,
              currentOrder.status === "PARTIAL" ? "deterministic partial fill" : "durable limit order filled"
            ],
            observedAt: now
          });
          }
        }
        if (isPending(currentOrder) && nowDate.getTime() >= Date.parse(currentOrder.expiresAt)) {
          const expired = expireStockPaperLimitOrderV3(asExecutionOrder(currentOrder), now);
          currentOrder = {
            ...currentOrder,
            status: expired.status,
            ...(expired.terminalReason ? { reason: expired.terminalReason } : {}),
            reservedNotionalUsd: 0,
            updatedAt: now
          };
          stageOrder(currentOrder, { reason: currentOrder.reason });
        }
        // An accepted overnight signal is immutable for its configured order
        // lifetime. The free BOATS history used for fill causality is delayed,
        // so reapplying volatile ranking/high-conviction gates while the order is
        // waiting would make the 25-minute evidence window unreachable. Other
        // session types retain their legacy soft revalidation after every newly
        // available causal bar has been processed.
        if (isPending(currentOrder) && !buyHoldReason && currentOrder.phase !== "OVERNIGHT") {
          const softGateReason = pendingBuySoftGateReason(currentOrder);
          if (softGateReason) {
            const canceled = cancelStockPaperLimitOrderV3(
              asExecutionOrder(currentOrder),
              now,
              softGateReason
            );
            currentOrder = {
              ...currentOrder,
              status: canceled.status,
              ...(canceled.terminalReason ? { reason: canceled.terminalReason } : {}),
              reservedNotionalUsd: 0,
              updatedAt: now
            };
            const softGateSnapshot = snapshotBySymbol.get(currentOrder.symbol);
            stageOrder(currentOrder, {
              ...(softGateSnapshot
                ? { snapshot: softGateSnapshot, spreadPercent: spreadPercent(softGateSnapshot) }
                : {}),
              reason: softGateReason
            });
            continue;
          }
        }
        stageOrder(currentOrder);
      }

      const closedSymbolsThisCycle = new Set<string>();

      // Durable PAPER exits use the same completed-bar, participation-aware
      // lifecycle as entries. A partial SELL reduces the lot and realizes only
      // that slice; one final trade is emitted after the full quantity exits.
      const sellRolloverByPositionId = new Map<string, StockPaperOrder>();
      for (const persistedOrder of persistedPendingOrders) {
        if (persistedOrder.side !== "SELL") continue;
        let currentOrder = persistedOrder;
        const positionId = currentOrder.positionId;
        const exitReason = currentOrder.exitReason;
        const exitCostBasisUsd = currentOrder.exitCostBasisUsd;
        let currentPosition = positionId ? positionById.get(positionId) : undefined;
        const remainingOrderQuantity = currentOrder.requestedQuantity - currentOrder.filledQuantity;
        const invalidProvenance =
          !positionId ||
          !exitReason ||
          !Number.isFinite(exitCostBasisUsd) ||
          (exitCostBasisUsd ?? 0) <= 0 ||
          !currentPosition ||
          this.repository.tradeForPosition(lane.id, positionId ?? "") !== undefined ||
          (currentPosition !== undefined &&
            (currentPosition.laneId !== lane.id ||
              currentPosition.symbol !== currentOrder.symbol ||
              currentPosition.arm !== currentOrder.arm ||
              Math.abs(remainingOrderQuantity - currentPosition.quantity) > 1e-8));
        if (invalidProvenance) {
          currentOrder = {
            ...currentOrder,
            status: "REJECTED",
            reason: "The persisted PAPER liquidation is missing valid immutable position provenance.",
            reservedNotionalUsd: 0,
            updatedAt: now
          };
          stageOrder(currentOrder, { reason: currentOrder.reason });
          continue;
        }
        const evidenceTimeoutAt = currentOrder.evidenceTimeoutAt ??
          sellEvidenceTimeoutAt(currentOrder.submittedAt, currentOrder.phase);
        const evidenceTimeoutMs = Date.parse(evidenceTimeoutAt);
        const phaseOrFeedChanged = currentOrder.phase !== phase || currentOrder.feed !== marketFeed;
        const evidenceTimedOut = !Number.isFinite(evidenceTimeoutMs) ||
          nowDate.getTime() >= evidenceTimeoutMs;
        if (phaseOrFeedChanged || evidenceTimedOut) {
          const rolloverReason = phaseOrFeedChanged
            ? "The market phase or feed changed; the durable PAPER liquidation must roll to new causal evidence."
            : "PAPER liquidation evidence was not verifiable before the observed-time deadline; rollover is required.";
          currentOrder = {
            ...currentOrder,
            status: phaseOrFeedChanged ? "CANCELED" : "EXPIRED",
            evidenceTimeoutAt,
            reason: rolloverReason,
            reservedNotionalUsd: 0,
            updatedAt: now
          };
          stageOrder(currentOrder, {
            ...(snapshotBySymbol.get(currentOrder.symbol)
              ? { snapshot: snapshotBySymbol.get(currentOrder.symbol)! }
              : {}),
            marketable: true,
            reason: rolloverReason
          });
          sellRolloverByPositionId.set(positionId, currentOrder);
          continue;
        }
        let positionChanged = false;
        for (const bar of completedBarsFor(currentOrder.symbol)) {
          if (!isPending(currentOrder) || !currentPosition) break;
          const snapshot = snapshotBySymbol.get(currentOrder.symbol);
          const quote = snapshot?.latestQuote;
          if (!snapshot || !quote || quote.bidPrice <= 0 || quote.askPrice <= quote.bidPrice ||
              !stockSnapshotIsFresh(snapshot, nowDate, undefined, maximumBarAgeMs)) {
            // A historical bar and a later unknown/stale spread are not a
            // reproducible executable fill. Keep the liquidation pending until
            // the observed-time deadline forces an explicit rollover.
            break;
          }
          const sellSpread = spreadPercent(snapshot);
          const sessionFillPenalty = phase === "REGULAR"
            ? 1
            : 1 - lane.policy.extendedFillPenaltyPercent / 100;
          const marketableFillPriceUsd = modeledSellFill(bar.open, sellSpread) * sessionFillPenalty;
          const result = resolveStockPaperLimitOrderV3({
            order: asExecutionOrder(currentOrder),
            bar,
            participationRate: lane.policy.maximumBarParticipationPercent / 100,
            marketable: true,
            marketableFillPriceUsd
          });
          const applied = applyExecutionResolution(currentOrder, result, now);
          currentOrder = { ...applied.order, reservedNotionalUsd: 0 };
          if (!applied.fill) continue;

          const regulatoryCost = applied.fill.notionalUsd * 0.0001;
          const sellFill: StockPaperOrderFill = {
            ...applied.fill,
            modeledCostsUsd: regulatoryCost
          };
          currentOrder = {
            ...currentOrder,
            fills: [...currentOrder.fills.slice(0, -1), sellFill]
          };
          const benchmarkBar = completedBenchmarkBarFor(bar.timestamp);
          stageOrder(currentOrder, {
            bar,
            ...(benchmarkBar ? { benchmarkBar } : {}),
            ...(snapshot ? { snapshot } : {}),
            spreadPercent: sellSpread,
            participationRatePercent: lane.policy.maximumBarParticipationPercent,
            marketable: true,
            reason: result.reason === "PARTIAL_FILL"
              ? "A causal bar produced a participation-limited PAPER liquidation fill."
              : "A causal bar completed the durable PAPER liquidation."
          });
          const quantityBefore = currentPosition.quantity;
          const fillQuantity = Math.min(sellFill.quantity, quantityBefore);
          const costReleasedUsd = fillQuantity >= quantityBefore - 1e-10
            ? currentPosition.remainingCostUsd
            : currentPosition.remainingCostUsd * fillQuantity / quantityBefore;
          const proceedsUsd = Math.max(0, sellFill.notionalUsd - regulatoryCost);
          const fillPnlUsd = proceedsUsd - costReleasedUsd;
          mutableAccount.cashUsd += proceedsUsd;
          mutableAccount.realizedPnlUsd += fillPnlUsd;
          positionChanged = true;
          signals.push({
            id: eventId(lane.id, now, currentOrder.symbol, `SELL_FILL:${sellFill.id}`),
            laneId: lane.id,
            symbol: currentOrder.symbol,
            arm: currentOrder.arm,
            action: "SELL",
            outcome: "SIMULATED",
            score: currentOrder.candidateScore,
            notionalUsd: proceedsUsd,
            priceUsd: sellFill.priceUsd,
            reasons: [
              `${exitReason.replaceAll("_", " ").toLowerCase()} durable liquidation fill`,
              currentOrder.status === "PARTIAL"
                ? "participation-limited partial fill"
                : "full durable liquidation completed"
            ],
            observedAt: now
          });

          const nextQuantity = Math.max(0, quantityBefore - fillQuantity);
          if (nextQuantity > 1e-10) {
            const nextCost = Math.max(0, currentPosition.remainingCostUsd - costReleasedUsd);
            const bid = snapshot?.latestQuote?.bidPrice ?? sellFill.priceUsd;
            const ask = snapshot?.latestQuote?.askPrice ?? sellFill.priceUsd;
            currentPosition = {
              ...currentPosition,
              status: "OPEN",
              quantity: nextQuantity,
              entryNotionalUsd: nextCost,
              remainingCostUsd: nextCost,
              lastBidUsd: bid,
              lastAskUsd: ask,
              lastMarkUsd: bid,
              lastValueUsd: nextQuantity * bid,
              lastExecutableValueUsd: nextQuantity * bid,
              updatedAt: now
            };
            positionById.set(positionId, currentPosition);
            continue;
          }

          const totalModeledCostsUsd = currentOrder.fills.reduce(
            (sum, fill) => sum + fill.modeledCostsUsd,
            0
          );
          const totalProceedsUsd = currentOrder.fills.reduce(
            (sum, fill) => sum + Math.max(0, fill.notionalUsd - fill.modeledCostsUsd),
            0
          );
          const tradePnlUsd = totalProceedsUsd - exitCostBasisUsd!;
          const returnPercent = exitCostBasisUsd! > 0
            ? tradePnlUsd / exitCostBasisUsd! * 100
            : 0;
          const path = uniqueBars([
            ...this.repository.bars(lane.id, currentPosition.symbol, currentPosition.openedAt, now),
            ...(barsBySymbol.get(currentPosition.symbol) ?? [])
          ]);
          const completedTradePath = buildCompletedStockPaperTradePath({
            bars: path,
            entryPriceUsd: currentPosition.entryPriceUsd,
            openedAt: currentPosition.openedAt,
            exitedAt: sellFill.evidenceAt,
            generatedAt: now
          });
          newTrades.push({
            id: `stock-trade:${positionId}`,
            laneId: lane.id,
            positionId,
            symbol: currentPosition.symbol,
            arm: currentPosition.arm,
            quantity: currentOrder.requestedQuantity,
            entryPriceUsd: currentPosition.entryPriceUsd,
            exitPriceUsd: currentOrder.averageFillPriceUsd ?? sellFill.priceUsd,
            entryNotionalUsd: exitCostBasisUsd!,
            proceedsUsd: totalProceedsUsd,
            modeledCostsUsd: totalModeledCostsUsd,
            pnlUsd: tradePnlUsd,
            returnPercent,
            exitReason,
            openedAt: currentPosition.openedAt,
            closedAt: now,
            ...(currentPosition.entryContext ? { entryContext: currentPosition.entryContext } : {}),
            pathEvidence: completedTradePath.evidence,
            replay: replayClosedStockTrade({
              bars: completedTradePath.causalBars,
              entryPriceUsd: currentPosition.entryPriceUsd,
              actualReturnPercent: returnPercent,
              generatedAt: now
            })
          });
          mutableAccount.completedTrades += 1;
          if (tradePnlUsd > 0) {
            mutableAccount.winningTrades += 1;
            mutableAccount.grossProfitUsd += tradePnlUsd;
          } else {
            mutableAccount.grossLossUsd += Math.abs(tradePnlUsd);
          }
          changedPositions.push({
            ...currentPosition,
            status: "CLOSED",
            quantity: 0,
            lastValueUsd: 0,
            lastExecutableValueUsd: 0,
            remainingCostUsd: 0,
            updatedAt: now,
            closedAt: now
          });
          positionById.delete(positionId);
          closedSymbolsThisCycle.add(currentOrder.symbol);
          currentOrder = {
            ...currentOrder,
            status: "FILLED",
            reason: `${exitReason} completed through the durable participation-aware PAPER lifecycle.`,
            reservedNotionalUsd: 0,
            updatedAt: now
          };
          currentPosition = undefined;
        }
        if (isPending(currentOrder) && nowDate.getTime() >= Date.parse(currentOrder.expiresAt)) {
          currentOrder = {
            ...currentOrder,
            status: "EXPIRED",
            reason: "PAPER liquidation evidence was not verifiable before the finite order deadline; rollover is required.",
            reservedNotionalUsd: 0,
            updatedAt: now
          };
        }
        if (positionChanged && currentPosition) changedPositions.push(currentPosition);
        stageOrder(currentOrder, { reason: currentOrder.reason });
        if (currentPosition && currentOrder.status === "EXPIRED") {
          sellRolloverByPositionId.set(positionId, currentOrder);
        }
      }

      const pendingSellPositionIds = new Set(
        persistedPendingOrders
          .map((order) => changedOrderById.get(order.id) ?? order)
          .filter((order) => order.side === "SELL" && isPending(order) && order.positionId)
          .map((order) => order.positionId!)
      );

      const positionsForCycle = [...positionById.values()];
      const overnightFeedMinutesRemaining = phase === "OVERNIGHT"
        ? stockPaperOvernightFeedMinutesRemaining(now)
        : undefined;

      for (const position of positionsForCycle) {
        const rolloverOrder = sellRolloverByPositionId.get(position.id);
        const snapshot = snapshotBySymbol.get(position.symbol);
        const quote = snapshot?.latestQuote;
        const firstProtectiveBarAt = firstEligibleStockPaperBarAtV3(position.openedAt);
        const protectiveBars = uniqueBars(barsBySymbol.get(position.symbol) ?? [])
          .filter((bar) =>
            (!firstProtectiveBarAt || bar.timestamp >= firstProtectiveBarAt) &&
            (!position.lastProtectiveBarAt || bar.timestamp > position.lastProtectiveBarAt) &&
            Date.parse(bar.timestamp) < completedBarBoundaryMs
          );
        const newestProtectiveBarAt = protectiveBars.at(-1)?.timestamp ?? position.lastProtectiveBarAt;
        const protectiveEvidence = protectiveBars
          .map((bar) => ({
            bar,
            exit: resolveLongStockPaperProtectiveExitV3({
              bar,
              stopPriceUsd: position.stopPriceUsd,
              targetPriceUsd: position.takeProfitPriceUsd
            })
          }))
          .find((entry) => entry.exit !== undefined);
        const protectiveExit = protectiveEvidence?.exit;
        const quoteFresh = Boolean(
          quote && stockSnapshotIsFresh(snapshot, nowDate, undefined, maximumBarAgeMs)
        );
        if (!quoteFresh && !protectiveExit && !rolloverOrder) {
          const delayedFairBar = delayedFairBarBySymbol.get(position.symbol);
          const delayedFairValueEvidence = delayedFairBar
            ? {
                feed: "SIP_DELAYED" as const,
                priceUsd: delayedFairBar.close,
                evidenceAt: delayedFairBar.timestamp,
                observedAt: now,
                barDigest: barEvidenceDigest(delayedFairBar)!
              }
            : position.delayedFairValueEvidence;
          openPositions.push({
            ...position,
            status: "UNPRICED",
            ...(delayedFairValueEvidence
              ? {
                  lastMarkUsd: delayedFairValueEvidence.priceUsd,
                  lastValueUsd: position.quantity * delayedFairValueEvidence.priceUsd,
                  delayedFairValueEvidence
                }
              : {}),
            ...(newestProtectiveBarAt ? { lastProtectiveBarAt: newestProtectiveBarAt } : {}),
            updatedAt: now
          });
          changedPositions.push(openPositions.at(-1)!);
          continue;
        }
        const spread = quoteFresh && snapshot
          ? spreadPercent(snapshot)
          : position.lastAskUsd > position.lastBidUsd
            ? (position.lastAskUsd - position.lastBidUsd) /
              ((position.lastAskUsd + position.lastBidUsd) / 2) * 100
            : lane.policy.maximumSpreadPercent;
        const sessionFillPenalty = phase === "REGULAR"
          ? 1
          : 1 - lane.policy.extendedFillPenaltyPercent / 100;
        const rawSellPrice = protectiveExit?.fillPriceUsd ?? quote?.bidPrice ?? position.lastBidUsd;
        const sellPrice = modeledSellFill(rawSellPrice, spread) * sessionFillPenalty;
        const markPrice = (snapshot ? stockMarkPrice(snapshot) : undefined) ?? sellPrice;
        const { delayedFairValueEvidence: _priorDelayedFairValue, ...executablePosition } = position;
        const marked: StockPaperPosition = {
          ...executablePosition,
          status: "OPEN",
          lastBidUsd: quote?.bidPrice ?? position.lastBidUsd,
          lastAskUsd: quote?.askPrice ?? position.lastAskUsd,
          lastMarkUsd: markPrice,
          lastValueUsd: position.quantity * markPrice,
          lastExecutableValueUsd: position.quantity * sellPrice,
          peakPriceUsd: Math.max(
            position.peakPriceUsd,
            quote?.bidPrice ?? position.lastBidUsd,
            ...protectiveBars.map((bar) => bar.high)
          ),
          ...(newestProtectiveBarAt ? { lastProtectiveBarAt: newestProtectiveBarAt } : {}),
          updatedAt: now
        };
        if (pendingSellPositionIds.has(position.id)) {
          openPositions.push(marked);
          changedPositions.push(marked);
          continue;
        }
        const extendedDiscontinuity = discontinuityMinutesRemaining(clock, phase, nowDate);
        const reason = rolloverOrder?.exitReason ?? (this.corporateActionSymbols.has(position.symbol)
          ? "DATA_SAFETY"
          : protectiveExit?.reason ?? (sessionActive
          ? stockExitDecision({
              position: marked,
              bidPrice: sellPrice,
              now,
              ...(phase === "REGULAR" && minutesRemaining !== undefined
                ? { sessionMinutesRemaining: minutesRemaining }
                : phase === "OVERNIGHT" && overnightFeedMinutesRemaining !== undefined
                  ? { sessionMinutesRemaining: overnightFeedMinutesRemaining }
                : extendedDiscontinuity !== undefined
                  ? { sessionMinutesRemaining: extendedDiscontinuity }
                  : {}),
              policy: lane.policy
            })
          : undefined));
        if (!reason) {
          openPositions.push(marked);
          changedPositions.push(marked);
          continue;
        }
        for (const pendingOrder of persistedPendingOrders) {
          const effectiveOrder = changedOrderById.get(pendingOrder.id) ?? pendingOrder;
          if (
            effectiveOrder.side !== "BUY" ||
            effectiveOrder.positionId !== marked.id ||
            !isPending(effectiveOrder)
          ) continue;
          const canceled = cancelStockPaperLimitOrderV3(
            asExecutionOrder(effectiveOrder),
            now,
            `The unfilled BUY remainder was canceled atomically before ${reason} liquidation.`
          );
          const canceledOrder: StockPaperOrder = {
            ...effectiveOrder,
            status: canceled.status,
            ...(canceled.terminalReason ? { reason: canceled.terminalReason } : {}),
            reservedNotionalUsd: 0,
            updatedAt: now
          };
          stageOrder(canceledOrder, {
            ...(protectiveEvidence?.bar ? { bar: protectiveEvidence.bar } : {}),
            ...(snapshot ? { snapshot, spreadPercent: spread } : {}),
            reason: canceledOrder.reason
          });
        }
        const sellOrderId = rolloverOrder
          ? rolloverOrderId(rolloverOrder, phase, marketFeed)
          : orderId(lane.id, now, marked.symbol, "SELL");
        const expiresAt = sellEvidenceTimeoutAt(now, phase);
        const requestedQuantity = rolloverOrder?.requestedQuantity ?? marked.quantity;
        const filledQuantity = rolloverOrder?.filledQuantity ?? 0;
        const carriedFills = rolloverOrder?.fills ?? [];
        const submitted = submitStockPaperLimitOrderV3({
          id: sellOrderId,
          symbol: marked.symbol,
          side: "SELL",
          limitPriceUsd: sellPrice,
          quantity: requestedQuantity,
          submittedAt: now,
          expiresAt
        });
        const submittedOrder: StockPaperOrder = {
          id: sellOrderId,
          idempotencyKey: sellOrderId,
          laneId: lane.id,
          positionId: marked.id,
          symbol: marked.symbol,
          arm: marked.arm,
          side: "SELL",
          status: submitted.status,
          phase,
          feed: marketFeed,
          policyVersion: lane.policyVersion,
          executionVersion: STOCK_PAPER_EXECUTION_VERSION,
          submittedAt: now,
          expiresAt,
          evidenceTimeoutAt: expiresAt,
          ...(rolloverOrder?.triggerEvidenceAt
            ? { triggerEvidenceAt: rolloverOrder.triggerEvidenceAt }
            : protectiveExit?.barTimestamp
              ? { triggerEvidenceAt: protectiveExit.barTimestamp }
              : quote?.timestamp
                ? { triggerEvidenceAt: quote.timestamp }
                : {}),
          ...(rolloverOrder?.triggerObservedAt
            ? { triggerObservedAt: rolloverOrder.triggerObservedAt }
            : { triggerObservedAt: now }),
          ...(rolloverOrder
            ? {
                replacesOrderId: rolloverOrder.id,
                rolloverCount: (rolloverOrder.rolloverCount ?? 0) + 1
              }
            : { rolloverCount: 0 }),
          ...(submitted.firstEligibleBarAt
            ? { firstEligibleBarAt: submitted.firstEligibleBarAt }
            : {}),
          limitPriceUsd: sellPrice,
          requestedQuantity,
          filledQuantity,
          ...(rolloverOrder?.averageFillPriceUsd !== undefined
            ? { averageFillPriceUsd: rolloverOrder.averageFillPriceUsd }
            : {}),
          reservedNotionalUsd: 0,
          candidateScore: marked.scoreAtEntry,
          exitReason: reason,
          exitCostBasisUsd: rolloverOrder?.exitCostBasisUsd ?? marked.remainingCostUsd,
          fills: carriedFills,
          reason: rolloverOrder
            ? `${reason} liquidation rolled to a finite ${phase}/${marketFeed} causal-evidence window.`
            : protectiveExit
            ? `${protectiveExit.reason} triggered from causal bar evidence; durable liquidation awaits the next completed bar.`
            : `${reason} triggered from a fresh quote; durable liquidation awaits the next completed bar.`,
          updatedAt: now
        };
        stageOrder(submittedOrder, {
          ...(protectiveEvidence?.bar ? { bar: protectiveEvidence.bar } : {}),
          ...(snapshot ? { snapshot } : {}),
          spreadPercent: spread,
          participationRatePercent: lane.policy.maximumBarParticipationPercent,
          marketable: true,
          reason: submittedOrder.reason
        });
        pendingSellPositionIds.add(marked.id);
        openPositions.push(marked);
        changedPositions.push(marked);
        signals.push({
          id: eventId(lane.id, now, marked.symbol, `SELL:${reason}`),
          laneId: lane.id,
          symbol: marked.symbol,
          arm: marked.arm,
          action: "SELL",
          outcome: "ANALYSIS_ONLY",
          score: marked.scoreAtEntry,
          notionalUsd: marked.quantity * sellPrice,
          priceUsd: sellPrice,
          reasons: [
            reason.replaceAll("_", " ").toLowerCase(),
            "durable participation-aware PAPER liquidation submitted"
          ],
          observedAt: now
        });
      }

      const markAccount = (): void => {
        mutableAccount.fairDeployedUsd = openPositions.reduce((sum, position) => sum + position.lastValueUsd, 0);
        mutableAccount.deployedUsd = openPositions.reduce(
          (sum, position) => sum + (position.lastExecutableValueUsd ?? position.lastValueUsd),
          0
        );
        mutableAccount.unrealizedPnlUsd = openPositions.reduce(
          (sum, position) => sum + (position.lastExecutableValueUsd ?? position.lastValueUsd) - position.remainingCostUsd,
          0
        );
        mutableAccount.navUsd = mutableAccount.cashUsd + mutableAccount.deployedUsd;
        mutableAccount.executableNavUsd = mutableAccount.navUsd;
        mutableAccount.fairNavUsd = mutableAccount.cashUsd + mutableAccount.fairDeployedUsd;
        mutableAccount.peakNavUsd = Math.max(mutableAccount.peakNavUsd, mutableAccount.navUsd);
        const drawdown = mutableAccount.peakNavUsd > 0
          ? (mutableAccount.peakNavUsd - mutableAccount.navUsd) / mutableAccount.peakNavUsd * 100
          : 0;
        mutableAccount.maxDrawdownPercent = Math.max(mutableAccount.maxDrawdownPercent, drawdown);
        mutableAccount.openPositions = openPositions.length;
        mutableAccount.pricingComplete = openPositions.every((position) => position.status === "OPEN");
        mutableAccount.updatedAt = now;
      };
      markAccount();
      const dailyLossPercent = mutableAccount.dayStartNavUsd > 0
        ? (mutableAccount.dayStartNavUsd - mutableAccount.navUsd) / mutableAccount.dayStartNavUsd * 100
        : 0;
      const currentDrawdownPercent = mutableAccount.peakNavUsd > 0
        ? (mutableAccount.peakNavUsd - mutableAccount.navUsd) / mutableAccount.peakNavUsd * 100
        : 0;
      if (currentDrawdownPercent >= lane.policy.maximumDrawdownPercent) {
        mutableAccount.pausedReason = "Maximum stock-paper drawdown reached.";
      } else if (dailyLossPercent >= lane.policy.dailyLossPausePercent) {
        mutableAccount.pausedReason = "Daily stock-paper loss pause reached.";
      }

      const elapsed = sessionElapsedMinutes(now);
      const regularEntryWindow =
        phase === "REGULAR" &&
        elapsed >= ENTRY_OPENING_DELAY_MINUTES &&
        (minutesRemaining ?? 0) > ENTRY_CLOSING_BUFFER_MINUTES;
      const extendedEntryWindow = extendedEntryWindowOpen(phase, now);
      const entriesAllowed =
        sessionActive &&
        calendarEntryWindow &&
        (regularEntryWindow || extendedEntryWindow) &&
        mutableAccount.pricingComplete &&
        !mutableAccount.pausedReason;
      let rotationDecision: StockPaperRotationDecision | undefined;
      if (entriesAllowed) {
        try {
          const recentDecisions = this.repository.recentRotationDecisions(lane.id, 200);
          const recentRotations = recentDecisions.filter((decision) => decision.status === "ROTATE");
          const cooldownUntilBySymbol: Record<string, string> = {};
          for (const prior of recentRotations) {
            const until = new Date(
              Date.parse(prior.decisionAt) + prior.policy.rotationCooldownMinutes * 60_000
            ).toISOString();
            for (const symbol of [prior.outgoing?.symbol, prior.incoming?.symbol]) {
              if (!symbol) continue;
              const existing = cooldownUntilBySymbol[symbol];
              if (!existing || existing < until) cooldownUntilBySymbol[symbol] = until;
            }
          }
          const unavailableIncomingSymbols = new Set<string>([
            ...closedSymbolsThisCycle,
            ...this.corporateActionSymbols
          ]);
          for (const persistedOrder of persistedPendingOrders) {
            const currentOrder = changedOrderById.get(persistedOrder.id) ?? persistedOrder;
            if (isPending(currentOrder)) unavailableIncomingSymbols.add(currentOrder.symbol);
          }
          const evaluated = evaluateStockPaperRotationDecision({
            laneId: lane.id,
            account: {
              navUsd: mutableAccount.navUsd,
              cashUsd: mutableAccount.cashUsd,
              deployedUsd: mutableAccount.deployedUsd
            },
            positions: openPositions.filter((position) =>
              persistedPositionIds.has(position.id) &&
              position.status === "OPEN" &&
              !pendingSellPositionIds.has(position.id)
            ),
            candidates: [
              ...candidates,
              ...[...rotationOutgoingCandidateBySymbol.values()].filter((candidate) =>
                !candidateBySymbol.has(candidate.symbol)
              )
            ],
            sourcePolicy: lane.policy,
            phase,
            feed: marketFeed,
            decisionAt: now,
            ...(recentRotations[0]?.decisionAt
              ? { lastRotationAt: recentRotations[0].decisionAt }
              : {}),
            ...(Object.keys(cooldownUntilBySymbol).length > 0
              ? { cooldownUntilBySymbol }
              : {}),
            ...(unavailableIncomingSymbols.size > 0
              ? { unavailableIncomingSymbols: [...unavailableIncomingSymbols].sort() }
              : {})
          });
          const alreadyFrozen = recentDecisions.some((prior) =>
            prior.idempotencyBucket === evaluated.idempotencyBucket &&
            prior.policyDigest === evaluated.policyDigest
          );
          if (!alreadyFrozen) rotationDecision = evaluated;
        } catch (error) {
          this.reportRotationAnalysisFailure("decision evaluation", error);
        }
      }
      const currentOrderStates = persistedPendingOrders.map((order) =>
        changedOrderById.get(order.id) ?? order
      );
      const activePendingOrders = currentOrderStates.filter((order) =>
        order.status === "SUBMITTED" || order.status === "PARTIAL"
      );
      const portfolioRiskExposures = [
        ...openPositions.map((position) => ({
          symbol: position.symbol,
          notionalUsd: Math.max(
            position.remainingCostUsd,
            position.lastExecutableValueUsd ?? position.lastValueUsd
          )
        })),
        ...activePendingOrders
          .filter((order) => order.side === "BUY")
          .map((order) => ({
            symbol: order.symbol,
            notionalUsd: order.reservedNotionalUsd
          }))
      ];
      const pendingBuySymbols = new Set(
        activePendingOrders.filter((order) => order.side === "BUY").map((order) => order.symbol)
      );
      let reservedPendingUsd = activePendingOrders.reduce(
        (sum, order) => sum + order.reservedNotionalUsd,
        0
      );
      const openSymbols = new Set(openPositions.map((position) => position.symbol));
      const occupiedSymbols = new Set([
        ...openSymbols,
        ...pendingBuySymbols,
        ...closedSymbolsThisCycle
      ]);
      const policyDigest = stockPaperPolicyDigestV3(lane.policy);
      const pooledDownsideTrades = this.repository.trades(lane.id, 80)
        .filter((trade) =>
          trade.entryContext?.featureVersion === STOCK_FEATURE_VERSION &&
          trade.entryContext.policyVersion === lane.policyVersion &&
          trade.entryContext.policyDigest === policyDigest &&
          Date.parse(trade.closedAt) <= nowDate.getTime()
        )
        .map((trade) => ({
          symbol: trade.symbol,
          pnlUsd: trade.pnlUsd,
          returnPercent: trade.returnPercent
        }));
      for (const candidate of candidates) {
        const extendedSession = phase !== "REGULAR";
        const corporateActionBlocked = this.corporateActionSymbols.has(candidate.symbol);
        const extendedCandidateEligible = !extendedSession ||
          (candidate.highConviction &&
            candidate.spreadPercent <= lane.policy.extendedEntrySpreadPercent);
        if (!entriesAllowed || !candidate.eligible || !extendedCandidateEligible || corporateActionBlocked) {
          const gateReasons = [
            ...(!candidate.eligible ? candidate.reasons : []),
            ...(corporateActionBlocked
              ? ["A split, merger, redemption, reorganization, or other material corporate action is pending."]
              : []),
            ...(!extendedCandidateEligible
              ? [`Extended-hours entries require a high-conviction signal and spread no wider than ${lane.policy.extendedEntrySpreadPercent.toFixed(2)}%.`]
              : []),
            ...(!entriesAllowed
              ? [mutableAccount.pausedReason ??
                  (!calendarEntryWindow
                    ? "The exchange calendar does not provide a continuous next session."
                    : !mutableAccount.pricingComplete
                      ? "An open position does not have executable pricing."
                      : "Entry window is closed.")]
              : [])
          ];
          signals.push({
            id: eventId(lane.id, now, candidate.symbol, "OBSERVE"),
            laneId: lane.id,
            symbol: candidate.symbol,
            arm: candidate.arm,
            action: candidate.eligible && extendedCandidateEligible && !corporateActionBlocked ? "OBSERVE" : "REJECT",
            outcome: candidate.eligible && extendedCandidateEligible && !corporateActionBlocked ? "ANALYSIS_ONLY" : "REJECTED",
            score: candidate.score,
            reasons: [...new Set(gateReasons)],
            observedAt: now
          });
          continue;
        }
        const maximumPositions = extendedSession
          ? Math.min(lane.policy.maximumOpenPositions, lane.policy.extendedMaximumOpenPositions)
          : lane.policy.maximumOpenPositions;
        if (occupiedSymbols.size >= maximumPositions) {
          signals.push({
            id: eventId(lane.id, now, candidate.symbol, "CAPACITY"),
            laneId: lane.id,
            symbol: candidate.symbol,
            arm: candidate.arm,
            action: "OBSERVE",
            outcome: "ANALYSIS_ONLY",
            score: candidate.score,
            reasons: ["Position capacity is full; the signal remains a shadow observation."],
            observedAt: now
          });
          continue;
        }
        if (pendingBuySymbols.has(candidate.symbol)) {
          signals.push({
            id: eventId(lane.id, now, candidate.symbol, "ORDER_PENDING"),
            laneId: lane.id,
            symbol: candidate.symbol,
            arm: candidate.arm,
            action: "OBSERVE",
            outcome: "ANALYSIS_ONLY",
            score: candidate.score,
            reasons: ["A durable PAPER limit order for this symbol is awaiting causal fill evidence."],
            observedAt: now
          });
          continue;
        }
        if (openSymbols.has(candidate.symbol)) {
          signals.push({
            id: eventId(lane.id, now, candidate.symbol, "ALREADY_OPEN"),
            laneId: lane.id,
            symbol: candidate.symbol,
            arm: candidate.arm,
            action: "OBSERVE",
            outcome: "ANALYSIS_ONLY",
            score: candidate.score,
            reasons: ["A position in this symbol is already open."],
            observedAt: now
          });
          continue;
        }
        const prior = this.repository.latestTradeForSymbol(lane.id, candidate.symbol);
        if (prior) {
          const cooldown = prior.exitReason === "STOP_LOSS"
            ? lane.policy.stopCooldownMinutes
            : lane.policy.cooldownMinutes;
          if (Date.parse(prior.closedAt) + cooldown * 60_000 > nowDate.getTime()) {
            signals.push({
              id: eventId(lane.id, now, candidate.symbol, "COOLDOWN"),
              laneId: lane.id,
              symbol: candidate.symbol,
              arm: candidate.arm,
              action: "REJECT",
              outcome: "REJECTED",
              score: candidate.score,
              reasons: ["Symbol cooldown remains active."],
              observedAt: now
            });
            continue;
          }
        }
        const contextTrades = this.repository.recentTradesForContext(
          lane.id,
          candidate.arm,
          phase,
          40,
          policyDigest
        );
        const learning = adaptiveHierarchicalArmDecision({
          contextTrades: contextTrades.map((trade) => ({
            pnlUsd: trade.pnlUsd,
            returnPercent: trade.returnPercent
          })),
          downsideReferenceTrades: pooledDownsideTrades,
          candidateSymbol: candidate.symbol,
          minimumUpsizeSampleSize: lane.policy.minimumUpsizeContextTrades
        });
        const riskDecision = stockPositionRiskDecision({
          navUsd: mutableAccount.navUsd,
          cashUsd: Math.max(0, mutableAccount.cashUsd - reservedPendingUsd),
          deployedUsd: mutableAccount.deployedUsd + reservedPendingUsd,
          candidate,
          policy: lane.policy,
          armMultiplier: learning.multiplier,
          learningStatus: learning.status,
          learningSampleSize: learning.sampleSize,
          portfolioExposures: portfolioRiskExposures
        });
        const baseNotionalUsd = riskDecision.notionalUsd;
        const plannedNotionalUsd = baseNotionalUsd *
          (extendedSession ? lane.policy.extendedEntrySizeMultiplier : 1);
        if (plannedNotionalUsd < 1 || candidate.askUsd <= 0) {
          signals.push({
            id: eventId(lane.id, now, candidate.symbol, "SIZE"),
            laneId: lane.id,
            symbol: candidate.symbol,
            arm: candidate.arm,
            action: "REJECT",
            outcome: "REJECTED",
            score: candidate.score,
              reasons: ["Available risk budget is below the $1 entry minimum."],
            observedAt: now
          });
          continue;
        }
        const fillPrice = modeledBuyFill(candidate.askUsd, candidate.spreadPercent) *
          (extendedSession ? 1 + lane.policy.extendedFillPenaltyPercent / 100 : 1);
        const asset = assetBySymbol.get(candidate.symbol);
        const fractionalEntry = asset
          ? stockAssetAllowsFractionalPhase(asset, phase)
          : phase === "REGULAR";
        const quantity = fractionalEntry
          ? plannedNotionalUsd / fillPrice
          : Math.floor(plannedNotionalUsd / fillPrice);
        if (quantity <= 0) {
          signals.push({
            id: eventId(lane.id, now, candidate.symbol, "WHOLE_SHARE_SIZE"),
            laneId: lane.id,
            symbol: candidate.symbol,
            arm: candidate.arm,
            action: "REJECT",
            outcome: "REJECTED",
            score: candidate.score,
            reasons: [
              "Extended-hours fractional trading is unavailable and the risk budget cannot buy one whole share."
            ],
            observedAt: now
          });
          continue;
        }
        const notionalUsd = quantity * fillPrice;
        const candidateRank = candidates.findIndex((entry) => entry.symbol === candidate.symbol) + 1;
        const snapshot = snapshotBySymbol.get(candidate.symbol);
        const entryContext = {
          featureVersion: STOCK_FEATURE_VERSION,
          policyVersion: lane.policyVersion,
          executionVersion: STOCK_PAPER_EXECUTION_VERSION,
          policyDigest,
          phase,
          feed: marketFeed,
          capturedAt: now,
          candidateRank,
          candidateScore: candidate.score,
          relativeVolume: candidate.relativeVolume,
          spreadPercent: candidate.spreadPercent,
          change1mPercent: candidate.change1mPercent,
          change5mPercent: candidate.change5mPercent,
          change15mPercent: candidate.change15mPercent,
          newsArticleCount: candidate.newsArticleCount ?? 0,
          screenerHit: Boolean(candidate.onlineSources?.some((source) => source !== "NEWS")),
          learningMultiplier: learning.multiplier,
          learningStatus: learning.status,
          learningSampleSize: learning.sampleSize,
          downsideReference: learning.downsideReference,
          downsideReferenceSampleSize: learning.downsideReferenceSampleSize,
          downsideMultiplier: learning.downsideMultiplier,
          modeledLimitPriceUsd: fillPrice,
          onlineSources: candidate.onlineSources ?? [],
          highConviction: candidate.highConviction,
          dollarVolumeUsd: candidate.dollarVolumeUsd,
          vwapDistancePercent: candidate.vwapDistancePercent,
          dailyChangePercent: candidate.dailyChangePercent,
          riskExposureGroup: riskDecision.exposureGroup,
          instrumentRiskClass: riskDecision.instrument.riskClass,
          instrumentLeverageMultiple: riskDecision.instrument.leverageMultiple,
          realizedVolatilityPercent: candidate.realizedVolatilityPercent ?? 0,
          riskLearningTier: riskDecision.learningTier,
          riskPositionCapNavFraction: riskDecision.positionCapNavFraction,
          riskVolatilityMultiplier: riskDecision.volatilityMultiplier,
          riskInstrumentMultiplier: riskDecision.instrumentMultiplier,
          riskGroupExposureBeforeUsd: riskDecision.groupExposureBeforeUsd,
          ...(snapshot?.latestQuote?.timestamp
            ? { quoteTimestamp: snapshot.latestQuote.timestamp }
            : {}),
          ...(snapshot?.minuteBar?.timestamp
            ? { barTimestamp: snapshot.minuteBar.timestamp }
            : {})
        } as const;
        const positionId = `stock-position:${randomUUID()}`;
        const nextOrderId = orderId(lane.id, now, candidate.symbol, "BUY");
        if (extendedSession) {
          const confirmationMinutes = phase === "OVERNIGHT"
            ? lane.policy.overnightDerivedLimitConfirmationMinutes
            : lane.policy.extendedLimitConfirmationMinutes;
          const expiresAt = new Date(
            nowDate.getTime() + confirmationMinutes * 60_000
          ).toISOString();
          const submitted = submitStockPaperLimitOrderV3({
            id: nextOrderId,
            symbol: candidate.symbol,
            side: "BUY",
            limitPriceUsd: fillPrice,
            quantity,
            submittedAt: now,
            expiresAt
          });
          const order: StockPaperOrder = {
            id: nextOrderId,
            idempotencyKey: nextOrderId,
            laneId: lane.id,
            positionId,
            symbol: candidate.symbol,
            arm: candidate.arm,
            side: "BUY",
            status: submitted.status,
            phase,
            feed: marketFeed,
            policyVersion: lane.policyVersion,
            executionVersion: STOCK_PAPER_EXECUTION_VERSION,
            submittedAt: now,
            expiresAt,
            ...(submitted.firstEligibleBarAt
              ? { firstEligibleBarAt: submitted.firstEligibleBarAt }
              : {}),
            limitPriceUsd: fillPrice,
            requestedQuantity: quantity,
            filledQuantity: 0,
            reservedNotionalUsd: notionalUsd,
            candidateScore: candidate.score,
            entryContext,
            fills: [],
            ...(submitted.terminalReason ? { reason: submitted.terminalReason } : {}),
            updatedAt: now
          };
          stageOrder(order, {
            ...(snapshot ? { snapshot } : {}),
            spreadPercent: candidate.spreadPercent,
            participationRatePercent: lane.policy.maximumBarParticipationPercent,
            marketable: false,
            reason: order.reason ?? "Durable extended-hours PAPER limit order submitted."
          });
          if (order.status === "SUBMITTED") {
            pendingBuySymbols.add(candidate.symbol);
            occupiedSymbols.add(candidate.symbol);
            reservedPendingUsd += order.reservedNotionalUsd;
            portfolioRiskExposures.push({
              symbol: candidate.symbol,
              notionalUsd: order.reservedNotionalUsd
            });
          }
          signals.push({
            id: eventId(lane.id, now, candidate.symbol, "LIMIT_SUBMITTED"),
            laneId: lane.id,
            symbol: candidate.symbol,
            arm: candidate.arm,
            action: "BUY",
            outcome: "ANALYSIS_ONLY",
            score: candidate.score,
            notionalUsd,
            priceUsd: fillPrice,
            reasons: [
              "Durable extended-hours PAPER limit order submitted.",
              "A strictly later complete minute bar is required before any fill can be recorded."
            ],
            observedAt: now
          });
          continue;
        }
        const sellModel = modeledSellFill(candidate.bidUsd, candidate.spreadPercent);
        const executableSellModel = sellModel *
          (extendedSession ? 1 - lane.policy.extendedFillPenaltyPercent / 100 : 1);
        const position: StockPaperPosition = {
          id: positionId,
          laneId: lane.id,
          symbol: candidate.symbol,
          arm: candidate.arm,
          status: "OPEN",
          quantity,
          entryPriceUsd: fillPrice,
          entryNotionalUsd: notionalUsd,
          remainingCostUsd: notionalUsd,
          lastBidUsd: candidate.bidUsd,
          lastAskUsd: candidate.askUsd,
          lastMarkUsd: sellModel,
          lastValueUsd: quantity * sellModel,
          lastExecutableValueUsd: quantity * executableSellModel,
          peakPriceUsd: fillPrice,
          stopPriceUsd: fillPrice * (1 - lane.policy.stopLossPercent / 100),
          takeProfitPriceUsd: fillPrice * (1 + lane.policy.takeProfitPercent / 100),
          scoreAtEntry: candidate.score,
          entryContext,
          openedAt: now,
          updatedAt: now
        };
        mutableAccount.cashUsd -= notionalUsd;
        openPositions.push(position);
        portfolioRiskExposures.push({ symbol: position.symbol, notionalUsd });
        changedPositions.push(position);
        openSymbols.add(position.symbol);
        occupiedSymbols.add(position.symbol);
        const buyFill: StockPaperOrderFill = {
          id: `${nextOrderId}:1`,
          quantity,
          priceUsd: fillPrice,
          notionalUsd,
          modeledCostsUsd: 0,
          evidence: "QUOTE",
          evidenceAt: snapshot?.latestQuote?.timestamp ?? now,
          createdAt: now
        };
        const filledOrder: StockPaperOrder = {
          id: nextOrderId,
          idempotencyKey: nextOrderId,
          laneId: lane.id,
          positionId,
          symbol: candidate.symbol,
          arm: candidate.arm,
          side: "BUY",
          status: "FILLED",
          phase,
          feed: marketFeed,
          policyVersion: lane.policyVersion,
          executionVersion: STOCK_PAPER_EXECUTION_VERSION,
          submittedAt: now,
          expiresAt: now,
          limitPriceUsd: fillPrice,
          requestedQuantity: quantity,
          filledQuantity: quantity,
          averageFillPriceUsd: fillPrice,
          reservedNotionalUsd: 0,
          candidateScore: candidate.score,
          entryContext,
          fills: [buyFill],
          reason: "Fresh regular-session quote PAPER fill.",
          updatedAt: now
        };
        const benchmarkSnapshot = snapshotBySymbol.get("SPY");
        stageOrder(filledOrder, {
          ...(snapshot ? { snapshot } : {}),
          ...(benchmarkSnapshot ? { benchmarkSnapshot } : {}),
          spreadPercent: candidate.spreadPercent,
          participationRatePercent: 100,
          marketable: false,
          reason: filledOrder.reason
        });
        markAccount();
        signals.push({
          id: eventId(lane.id, now, candidate.symbol, "BUY"),
          laneId: lane.id,
          symbol: candidate.symbol,
          arm: candidate.arm,
          action: "BUY",
          outcome: "SIMULATED",
          score: candidate.score,
          notionalUsd,
          priceUsd: fillPrice,
          reasons: [
            `${candidate.arm.replaceAll("_", " ").toLowerCase()} signal`,
            `${learning.multiplier.toFixed(2)}x ${learning.status.toLowerCase().replaceAll("_", " ")} contextual learner`,
            "regular-session durable PAPER order model"
          ],
          observedAt: now
        });
      }

      const observationAt = now;
      const observationBucket = new Date(
        Math.floor(nowDate.getTime() / (15 * 60_000)) * 15 * 60_000
      ).toISOString();
      const knownObservationIds = this.repository.observationIdsSince(lane.id, observationBucket);
      const spySnapshot = snapshotBySymbol.get("SPY");
      const observationBenchmarkPrice = spySnapshot ? stockMarkPrice(spySnapshot) : undefined;
      const observations: StockPaperObservation[] = candidates.map((candidate, index) => {
        const candidateSignals = signals.filter((signal) =>
          signal.symbol === candidate.symbol && signal.observedAt === now && signal.action !== "SELL"
        );
        const signal = candidateSignals.find((entry) =>
          entry.action === "BUY" && entry.outcome === "SIMULATED"
        ) ?? candidateSignals.find((entry) => entry.action === "BUY") ?? candidateSignals.at(-1);
        const previous = previousCandidateBySymbol.get(candidate.symbol);
        const previousAgeMs = previous
          ? nowDate.getTime() - Date.parse(previous.capturedAt)
          : Number.POSITIVE_INFINITY;
        const confirmationSamples = previous?.eligible &&
          previous.marketPhase === phase &&
          previous.marketFeed === marketFeed &&
          previousAgeMs > 0 && previousAgeMs <= 2 * 60_000
          ? 2
          : 1;
        const entryPriceUsd = modeledBuyFill(candidate.askUsd, candidate.spreadPercent) *
          (phase === "REGULAR" ? 1 : 1 + lane.policy.extendedFillPenaltyPercent / 100);
        const entryNotionalUsd = Math.max(
          1,
          Math.min(
            25,
            mutableAccount.navUsd * lane.policy.maximumPositionNavFraction,
            Math.max(1, mutableAccount.cashUsd - lane.policy.minimumCashReserveUsd)
          )
        );
        const safetyVetoes = [
          ...(!sessionActive ? ["MARKET_SESSION_INACTIVE"] : []),
          ...(!calendarEntryWindow ? ["CALENDAR_ENTRY_WINDOW_CLOSED"] : []),
          ...(!officialCalendarAllows ? ["OFFICIAL_CALENDAR_CLOSED"] : []),
          ...(!mutableAccount.pricingComplete ? ["OPEN_POSITION_UNPRICED"] : []),
          ...(mutableAccount.pausedReason ? ["ACCOUNT_RISK_PAUSED"] : []),
          ...(this.corporateActionSymbols.has(candidate.symbol)
            ? ["MATERIAL_CORPORATE_ACTION"]
            : [])
        ];
        const rich = createStockPaperLearningObservationV3({
          laneId: lane.id,
          symbol: candidate.symbol,
          arm: candidate.arm,
          phase,
          feed: marketFeed,
          policyVersion: lane.policyVersion,
          policy: lane.policy,
          tradeDayKey: dayKey,
          observedAt: observationAt,
          idempotencyBucket: observationBucket,
          candidateRank: index + 1,
          candidateScore: candidate.score,
          highConviction: candidate.highConviction,
          confirmationSamples,
          entryPriceUsd,
          entryNotionalUsd,
          spreadPercent: candidate.spreadPercent,
          relativeVolume: candidate.relativeVolume,
          dollarVolumeUsd: candidate.dollarVolumeUsd,
          change1mPercent: candidate.change1mPercent,
          change5mPercent: candidate.change5mPercent,
          change15mPercent: candidate.change15mPercent,
          vwapDistancePercent: candidate.vwapDistancePercent,
          sessionMinute: Math.max(0, easternSessionMinutes(now)),
          onlineSources: candidate.onlineSources ?? [],
          newsArticleIds: this.newsArticleIds.get(candidate.symbol) ?? [],
          hardSafetyPassed: safetyVetoes.length === 0
        });
        const snapshot = snapshotBySymbol.get(candidate.symbol);
        return {
          id: rich.id,
          laneId: lane.id,
          symbol: candidate.symbol,
          observedAt: observationAt,
          idempotencyBucket: observationBucket,
          policyVersion: lane.policyVersion,
          policy: { ...lane.policy },
          featureVersion: STOCK_FEATURE_VERSION,
          executionVersion: STOCK_PAPER_EXECUTION_VERSION,
          policyDigest: rich.policyDigest,
          phase,
          feed: marketFeed,
          candidate: { ...candidate },
          tradeDayKey: dayKey,
          candidateRank: index + 1,
          confirmationSamples,
          entryPriceUsd,
          entryNotionalUsd,
          sessionMinute: Math.max(0, easternSessionMinutes(now)),
          newsArticleIds: [...(this.newsArticleIds.get(candidate.symbol) ?? [])],
          hardSafetyPassed: safetyVetoes.length === 0,
          safetyVetoes,
          decision: observationDecision(signal),
          reasons: signal?.reasons ?? candidate.reasons,
          ...(observationBenchmarkPrice ? { benchmarkPriceUsd: observationBenchmarkPrice } : {}),
          ...(snapshot?.latestQuote?.timestamp
            ? { quoteTimestamp: snapshot.latestQuote.timestamp }
            : {}),
          ...(snapshot?.minuteBar?.timestamp
            ? { barTimestamp: snapshot.minuteBar.timestamp }
            : {})
        };
      }).filter((observation) => {
        if (knownObservationIds.has(observation.id)) return false;
        knownObservationIds.add(observation.id);
        return true;
      });

      const outcomes: StockPaperObservationOutcome[] = [];
      for (const horizonMinutes of OBSERVATION_HORIZONS) {
        for (const observation of dueObservationsByHorizon.get(horizonMinutes) ?? []) {
          // Never turn an internal page/budget omission into market-data
          // evidence. Only a fully fetched target may become a terminal MISSING.
          const observationContextKey = outcomeEvidenceContextKey(observation);
          const observationTargetKey = outcomeEvidenceTargetKey(observation, observation.symbol);
          if (!completedOutcomeHistoryTargets.has(observationTargetKey)) continue;
          const richObservation = learningEvidenceFromObservation(observation);
          const dueAt = new Date(
            Date.parse(observation.observedAt) + horizonMinutes * 60_000
          ).toISOString();
          // Feed-less persisted bars may have been captured under a later
          // phase. Use only the freshly backfilled immutable observation
          // context so IEX and BOATS evidence can never be blended.
          const path = uniqueBars(
            outcomeBarsByContext.get(observationContextKey)?.get(observation.symbol) ?? []
          ).filter((bar) =>
            bar.timestamp > observation.observedAt && bar.timestamp <= dueAt
          );
          const label = calculateStockPaperOutcomeLabelV3({
            observation: richObservation,
            horizonMinutes,
            bars: path,
            labeledAt: now
          });
          // A delayed history page or an in-progress overnight bar is not a
          // permanent learning fact. Keep the canonical label absent for a
          // bounded grace period so the next cycle can repair the path; after
          // 30 minutes the same missing result becomes an honest terminal row.
          if (
            !label.datasetEligible &&
            nowDate.getTime() < Date.parse(label.horizonEndsAt) + 30 * 60_000
          ) {
            continue;
          }
          const spyPath = uniqueBars(
            outcomeBarsByContext.get(observationContextKey)?.get("SPY") ?? []
          ).filter((bar) =>
            bar.timestamp > observation.observedAt && bar.timestamp <= dueAt
          );
          const benchmarkEnd = completedOutcomeHistoryTargets.has(
            outcomeEvidenceTargetKey(observation, "SPY")
          )
            ? spyPath.at(-1)?.close
            : undefined;
          const benchmarkReturnPercent = observation.benchmarkPriceUsd && benchmarkEnd
            ? (benchmarkEnd - observation.benchmarkPriceUsd) /
              observation.benchmarkPriceUsd * 100
            : undefined;
          outcomes.push({
            observationId: observation.id,
            laneId: lane.id,
            symbol: observation.symbol,
            horizonMinutes,
            status: label.datasetEligible ? "LABELED" : "MISSING",
            entryPriceUsd: observation.entryPriceUsd,
            ...(label.exitExecutablePriceUsd !== undefined
              ? { exitPriceUsd: label.exitExecutablePriceUsd }
              : {}),
            ...(label.netExecutableReturnPercent !== undefined
              ? { netReturnPercent: label.netExecutableReturnPercent }
              : {}),
            ...(label.maximumFavorableExcursionPercent !== undefined
              ? { mfePercent: label.maximumFavorableExcursionPercent }
              : {}),
            ...(label.maximumAdverseExcursionPercent !== undefined
              ? { maePercent: label.maximumAdverseExcursionPercent }
              : {}),
            ...(benchmarkReturnPercent !== undefined
              ? { benchmarkReturnPercent }
              : {}),
            ...(benchmarkReturnPercent !== undefined && label.netExecutableReturnPercent !== undefined
              ? { benchmarkExcessReturnPercent: label.netExecutableReturnPercent - benchmarkReturnPercent }
              : {}),
            ...(label.missingDataReason ? { missingReason: label.missingDataReason } : {}),
            analysisEvidence: label as unknown as Record<string, unknown>,
            dueAt: label.horizonEndsAt,
            labeledAt: now
          });
        }
      }

      const rotationOutcomes: StockPaperRotationOutcome[] = [];
      for (const horizonMinutes of OBSERVATION_HORIZONS) {
        for (const decision of dueRotationDecisionsByHorizon.get(horizonMinutes) ?? []) {
          try {
            if (decision.status === "ROTATE") {
              if (!decision.outgoing || !decision.incoming) continue;
              if (!completedOutcomeHistoryTargets.has(
                outcomeEvidenceTargetKey(decision, decision.outgoing.symbol)
              ) || !completedOutcomeHistoryTargets.has(
                outcomeEvidenceTargetKey(decision, decision.incoming.symbol)
              )) {
                // A truncated page or bounded symbol budget is not evidence.
                // Leave the outcome absent so a later cycle can repair it.
                continue;
              }
            }
            const dueAt = new Date(
              Date.parse(decision.decisionAt) + horizonMinutes * 60_000
            ).toISOString();
            const rotationBars = outcomeBarsByContext.get(outcomeEvidenceContextKey(decision));
            const strictlyFutureBars = (symbol: string): AlpacaStockBar[] => uniqueBars(
              rotationBars?.get(symbol) ?? []
            ).filter((bar) =>
              bar.timestamp > decision.decisionAt && bar.timestamp <= dueAt
            );
            rotationOutcomes.push(calculateStockPaperRotationOutcome({
              decision,
              horizonMinutes,
              outgoingBars: decision.outgoing
                ? strictlyFutureBars(decision.outgoing.symbol)
                : [],
              incomingBars: decision.incoming
                ? strictlyFutureBars(decision.incoming.symbol)
                : [],
              labeledAt: now
            }));
          } catch (error) {
            this.reportRotationAnalysisFailure(
              `${horizonMinutes}-minute outcome calculation`,
              error
            );
          }
        }
      }

      markAccount();
      const finalDrawdownPercent = mutableAccount.peakNavUsd > 0
        ? (mutableAccount.peakNavUsd - mutableAccount.navUsd) / mutableAccount.peakNavUsd * 100
        : 0;
      const finalDailyLossPercent = mutableAccount.dayStartNavUsd > 0
        ? (mutableAccount.dayStartNavUsd - mutableAccount.navUsd) / mutableAccount.dayStartNavUsd * 100
        : 0;
      if (finalDrawdownPercent >= lane.policy.maximumDrawdownPercent) {
        mutableAccount.pausedReason = "Maximum stock-paper drawdown reached.";
      } else if (finalDailyLossPercent >= lane.policy.dailyLossPausePercent) {
        mutableAccount.pausedReason = "Daily stock-paper loss pause reached.";
      }
      const spy = snapshotBySymbol.get("SPY");
      const spyPrice = spy ? stockMarkPrice(spy) : undefined;
      if (spyPrice && !this.benchmarkStartPrice) {
        this.benchmarkStartPrice = spy?.previousDailyBar?.close ?? spyPrice;
      }
      const cumulativeExternalCapitalUsd = this.repository.cumulativeExternalCapitalUsd(lane.id);
      const equityPoint: StockPaperEquityPoint = {
        capturedAt: now,
        navUsd: mutableAccount.navUsd,
        cashUsd: mutableAccount.cashUsd,
        deployedUsd: mutableAccount.deployedUsd,
        drawdownPercent: finalDrawdownPercent,
        ...(cumulativeExternalCapitalUsd > 0
          ? { cumulativeExternalCapitalUsd }
          : {}),
        ...(spyPrice ? { benchmarkPriceUsd: spyPrice } : {}),
        ...(spyPrice && this.benchmarkStartPrice
          ? { benchmarkReturnPercent: (spyPrice - this.benchmarkStartPrice) / this.benchmarkStartPrice * 100 }
          : {})
      };
      const quoteAgeMs = newestAgeMs(
        snapshots.map((snapshot) => snapshot.latestQuote?.timestamp),
        nowDate.getTime()
      );
      const barAgeMs = newestAgeMs(
        snapshots.map((snapshot) => snapshot.minuteBar?.timestamp),
        nowDate.getTime()
      );
      const freshCoveragePercent = returnedUniverseSnapshots.length > 0
        ? freshUniverseSnapshots.length / returnedUniverseSnapshots.length * 100
        : 0;
      const returnedCoverage = universe.length > 0
        ? returnedUniverseSnapshots.length / universe.length
        : 0;
      const openPositionPricingCoveragePercent = openPositions.length > 0
        ? openPositions.filter((position) => position.status === "OPEN").length /
          openPositions.length * 100
        : 100;
      const overnightEligibleAssets = assets.filter((asset) =>
        asset.overnightTradable && !asset.overnightHalted
      ).length;
      const overnightFractionalAssets = assets.filter((asset) =>
        asset.overnightTradable && !asset.overnightHalted && asset.fractionalEhEnabled
      ).length;
      const overnightHaltedAssets = assets.filter((asset) =>
        asset.overnightTradable && asset.overnightHalted
      ).length;
      const finalOrderStates = new Map(
        [...persistedPendingOrders, ...changedOrderById.values()].map((order) => [order.id, order])
      );
      const finalPendingOrders = [...finalOrderStates.values()].filter((order) =>
        order.status === "SUBMITTED" || order.status === "PARTIAL"
      );
      const readinessNow = (this.options.now?.() ?? new Date()).toISOString();
      const readiness = evaluateStockPaperReadiness({
        now: readinessNow,
        phase,
        clock,
        ...(quoteAgeMs !== undefined ? { quoteAgeMs } : {}),
        ...(barAgeMs !== undefined ? { minuteBarAgeMs: barAgeMs } : {}),
        maximumMinuteBarAgeMs: maximumBarAgeMs,
        requestedSnapshots: universe.length,
        returnedSnapshots: returnedUniverseSnapshots.length,
        freshSnapshots: freshUniverseSnapshots.length,
        openPositions: openPositions.length,
        pricedOpenPositions: openPositions.filter((position) => position.status === "OPEN").length,
        overnightEligibleAssets,
        fractionalExtendedHoursAssets: overnightFractionalAssets,
        overnightHaltedAssets,
        endpointFailures,
        providerCalls: this.providerCalls,
        providerRequestsToReserve: 8
      });
      const feedActionable = sessionActive &&
        freshUniverseSnapshots.length > 0 &&
        returnedCoverage >= 0.8 &&
        mutableAccount.pricingComplete;
      const streamStatus = stream?.snapshot();
      const market: StockPaperMarketStatus = {
        feed: marketFeed,
        isOpen: feedActionable,
        phase,
        sessionActive,
        feedActionable,
        nextOpen: clock.nextOpen,
        nextClose: clock.nextClose,
        requestedSymbols: universe.length,
        returnedSnapshots: returnedUniverseSnapshots.length,
        freshSnapshots: freshUniverseSnapshots.length,
        prefilteredSnapshots: prefilteredSnapshots.length,
        scannedSymbols: freshUniverseSnapshots.length,
        detailedSymbols: candidates.length,
        eligibleSymbols: candidates.filter((candidate) => candidate.eligible).length,
        dynamicSymbols: dynamicUniverse.length,
        newsSymbols: [...this.newsCounts.keys()].filter(eligibleForPhase).length,
        screenerStatus: this.screenerStatus,
        newsStatus: this.newsStatus,
        ...(this.screenerSourceUpdatedAt
          ? { screenerSourceUpdatedAt: this.screenerSourceUpdatedAt }
          : {}),
        ...(this.newestNewsAt ? { newestNewsAt: this.newestNewsAt } : {}),
        ...(this.onlineUniverseUpdatedAt ? { onlineSignalsUpdatedAt: this.onlineUniverseUpdatedAt } : {}),
        ...(quoteAgeMs !== undefined ? { quoteAgeMs } : {}),
        ...(barAgeMs !== undefined ? { barAgeMs } : {}),
        barFreshnessLimitMs: maximumBarAgeMs,
        pricingEvidenceMode: phase === "OVERNIGHT" ? "DELAYED_DERIVED" : "REAL_TIME",
        ...(delayedFairBarBySymbol.size > 0
          ? {
              delayedFairValueFeed: "SIP" as const,
              delayedFairValueAt: [...delayedFairBarBySymbol.values()]
                .map((bar) => bar.timestamp)
                .sort()
                .at(-1)!
            }
          : {}),
        freshCoveragePercent,
        openPositionPricingCoveragePercent,
        overnightEligibleAssets,
        overnightFractionalAssets,
        overnightHaltedAssets,
        pendingOrders: finalPendingOrders.length,
        streamStatus: streamStatus?.status ?? "DISABLED",
        streamSymbols: streamStatus?.symbols ?? 0,
        streamReconnects: streamStatus?.reconnects ?? 0,
        ...(streamStatus?.lastMessageAt ? { streamLastMessageAt: streamStatus.lastMessageAt } : {}),
        ...(streamStatus?.lastQuoteAt ? { streamLastQuoteAt: streamStatus.lastQuoteAt } : {}),
        ...(streamStatus?.lastBarAt ? { streamLastBarAt: streamStatus.lastBarAt } : {}),
        streamQuoteMessages: streamStatus?.quoteMessages ?? 0,
        streamBarMessages: streamStatus?.barMessages ?? 0,
        ...(streamStatus?.lastError ? { streamLastError: streamStatus.lastError } : {}),
        calendarStatus: this.calendarStatus,
        corporateActionBlockedSymbols: this.corporateActionSymbols.size,
        readiness: {
          status: readiness.status,
          reasons: readiness.reasons.map((reason) => `${reason.code}: ${reason.message}`),
          ...(readiness.countdownSeconds !== undefined
            ? { countdownSeconds: readiness.countdownSeconds }
            : {}),
          checkedAt: readinessNow
        },
        providerRequests: requests,
        scanDurationMs: Math.max(0, Date.now() - cycleStartedAt),
        lastScanAt: now
      };
      this.repository.commitCycle({
        account: mutableAccount,
        positions: changedPositions,
        signals,
        trades: newTrades,
        equityPoint,
        candidates,
        bars: [...barsBySymbol].flatMap(([symbol, bars]) =>
          bars.map((bar) => ({ symbol, bar }))
        ),
        orders: [...changedOrderById.values()],
        orderEvents,
        observations,
        outcomes,
        newsEvidence: cycleNewsEvidence,
        market
      });
      if (rotationDecision || rotationOutcomes.length > 0) {
        try {
          this.repository.commitRotationAnalysis({
            laneId: lane.id,
            ...(rotationDecision ? { decisions: [rotationDecision] } : {}),
            ...(rotationOutcomes.length > 0 ? { outcomes: rotationOutcomes } : {})
          });
        } catch (error) {
          this.reportRotationAnalysisFailure("persistence", error);
        }
      }
      if (outcomes.length > 0) this.enqueueLearningEvaluation(lane.id, now);
      this.options.onUpdate?.({
        laneId: lane.id,
        navUsd: mutableAccount.navUsd,
        openPositions: mutableAccount.openPositions,
        trades: newTrades.length,
        entries: signals.filter((signal) => signal.action === "BUY" && signal.outcome === "SIMULATED").length,
        outcome: "CYCLE_COMPLETED",
        feed: marketFeed,
        phase,
        requestedSymbols: universe.length,
        returnedSnapshots: returnedUniverseSnapshots.length,
        freshSnapshots: freshUniverseSnapshots.length,
        prefilteredSnapshots: prefilteredSnapshots.length,
        scannedSymbols: freshUniverseSnapshots.length,
        detailedSymbols: candidates.length,
        eligibleCandidates: candidates.filter((candidate) => candidate.eligible).length,
        providerRequests: requests,
        scanDurationMs: market.scanDurationMs ?? 0
      });
    } catch (error) {
      this.repository.recordFailure(lane.id, safeError(error), now);
      throw error;
    }
  }
}
