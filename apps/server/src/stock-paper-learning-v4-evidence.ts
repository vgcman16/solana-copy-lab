import { createHash } from "node:crypto";
import type {
  StockPaperBenchmarkRawEvidence,
  StockPaperOrderEvent,
  StockPaperTrade
} from "@copylab/shared";
import { stockTradeDayKey } from "./stock-paper-policy.js";
import type {
  StockPaperAnalysisTradeV4,
  StockPaperDailyReturnV4
} from "./stock-paper-learning-v4.js";

const RELATIVE_TOLERANCE = 1e-8;

export type StockPaperLearningV4ExclusionReason =
  | "CLOSED_AFTER_CUTOFF"
  | "INVALID_TRADE_EVIDENCE"
  | "VERSIONED_ENTRY_CONTEXT_MISSING"
  | "BUY_FILL_EVENTS_MISSING"
  | "SELL_FILL_EVENTS_MISSING"
  | "DUPLICATE_FILL_EVIDENCE"
  | "FILL_ECONOMICS_INVALID"
  | "FILL_QUANTITY_MISMATCH"
  | "FILL_NOTIONAL_MISMATCH"
  | "COST_BASIS_MISMATCH"
  | "GROSS_PROCEEDS_MISMATCH"
  | "MODELED_COSTS_MISMATCH"
  | "REALIZED_PNL_MISMATCH"
  | "RETURN_MISMATCH"
  | "BENCHMARK_EVIDENCE_MISSING"
  | "BENCHMARK_EVIDENCE_UNVERIFIABLE"
  | "BENCHMARK_DIGEST_MISMATCH"
  | "NON_CAUSAL_EVENT_CLOCK";

export interface StockPaperLearningV4EvidenceExclusion {
  tradeId: string;
  symbol: string;
  reason: StockPaperLearningV4ExclusionReason;
  evidenceEra: "LEGACY" | "POST_V41";
}

export interface StockPaperLearningV4Evidence {
  v41EvidenceStartedAt?: string;
  sourceTradeCount: number;
  analysisTradeCount: number;
  exclusions: readonly StockPaperLearningV4EvidenceExclusion[];
  trades: readonly StockPaperAnalysisTradeV4[];
  /** Only adjusted, aligned, full-session context may be supplied. The current
   * engine intentionally passes none until that separate evidence exists. */
  dailyReturns: readonly StockPaperDailyReturnV4[];
}

/** Raw SPY payload required to reconstruct the digest stored beside a fill.
 * Existing v41 events did not persist this payload and therefore fail closed
 * instead of treating a digest-shaped string as proof of market evidence. */
export type StockPaperLearningV4RawBenchmarkEvidence = StockPaperBenchmarkRawEvidence;

/** Analysis-facing alias. The raw field remains optional because pre-upgrade
 * v41 events are retained and must be explicitly excluded as unverifiable. */
export type StockPaperLearningV4OrderEvent = StockPaperOrderEvent;

export interface PrepareStockPaperLearningV4EvidenceInput {
  cutoffAt: string;
  /** Durable first-event boundary from the complete ledger, not merely the
   * bounded analysis window. Trades opened before it are expected legacy rows. */
  v41EvidenceStartedAt?: string;
  trades: readonly StockPaperTrade[];
  orderEvents: readonly StockPaperLearningV4OrderEvent[];
  dailyReturns?: readonly StockPaperDailyReturnV4[];
}

interface VerifiedFillEvent {
  event: StockPaperLearningV4OrderEvent;
  quantity: number;
  priceUsd: number;
  grossNotionalUsd: number;
  modeledCostsUsd: number;
  benchmarkPriceUsd: number;
  decisionMs: number;
}

interface CanonicalBenchmarkEvidence {
  kind: "QUOTE" | "BAR";
  timestamp: string;
  priceUsd: number;
  digest: string;
}

type FillEvidenceResult =
  | { verified: VerifiedFillEvent }
  | { reason: StockPaperLearningV4ExclusionReason };

function timestampMs(value: string | undefined): number | undefined {
  if (!value || !/(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isDigest(value: string | undefined): boolean {
  return Boolean(value && /^[a-f0-9]{64}$/u.test(value));
}

function approximatelyEqual(left: number, right: number): boolean {
  return Number.isFinite(left) && Number.isFinite(right) &&
    Math.abs(left - right) <= RELATIVE_TOLERANCE * Math.max(1, Math.abs(left), Math.abs(right));
}

function finiteSum(values: readonly number[]): number | undefined {
  let total = 0;
  for (const value of values) {
    if (!Number.isFinite(value)) return undefined;
    total += value;
    if (!Number.isFinite(total)) return undefined;
  }
  return total;
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return actual.length === canonical.length && actual.every((key, index) => key === canonical[index]);
}

function canonicalBenchmarkEvidence(
  raw: StockPaperLearningV4RawBenchmarkEvidence | undefined
): CanonicalBenchmarkEvidence | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  if (raw.kind === "QUOTE") {
    if (!exactKeys(raw, ["kind", "timestamp", "bidPrice", "bidSize", "askPrice", "askSize"]) ||
        timestampMs(raw.timestamp) === undefined ||
        !Number.isFinite(raw.bidPrice) || raw.bidPrice <= 0 ||
        !Number.isFinite(raw.askPrice) || raw.askPrice <= 0 ||
        raw.askPrice < raw.bidPrice ||
        !Number.isFinite(raw.bidSize) || raw.bidSize < 0 ||
        !Number.isFinite(raw.askSize) || raw.askSize < 0) return undefined;
    const payload = {
      timestamp: raw.timestamp,
      bidPrice: raw.bidPrice,
      bidSize: raw.bidSize,
      askPrice: raw.askPrice,
      askSize: raw.askSize
    };
    return {
      kind: raw.kind,
      timestamp: raw.timestamp,
      priceUsd: (raw.bidPrice + raw.askPrice) / 2,
      digest: createHash("sha256").update(JSON.stringify(payload)).digest("hex")
    };
  }
  if (raw.kind !== "BAR" ||
      !exactKeys(raw, [
        "kind", "timestamp", "open", "high", "low", "close", "volume", "tradeCount", "vwap"
      ]) || timestampMs(raw.timestamp) === undefined ||
      !Number.isFinite(raw.open) || raw.open <= 0 ||
      !Number.isFinite(raw.high) || raw.high <= 0 ||
      !Number.isFinite(raw.low) || raw.low <= 0 ||
      !Number.isFinite(raw.close) || raw.close <= 0 ||
      raw.high < Math.max(raw.open, raw.close) || raw.low > Math.min(raw.open, raw.close) ||
      !Number.isFinite(raw.volume) || raw.volume < 0 ||
      !Number.isSafeInteger(raw.tradeCount) || raw.tradeCount < 0 ||
      !Number.isFinite(raw.vwap) || raw.vwap <= 0) return undefined;
  const payload = {
    timestamp: raw.timestamp,
    open: raw.open,
    high: raw.high,
    low: raw.low,
    close: raw.close,
    volume: raw.volume,
    tradeCount: raw.tradeCount,
    vwap: raw.vwap
  };
  return {
    kind: raw.kind,
    timestamp: raw.timestamp,
    priceUsd: raw.close,
    digest: createHash("sha256").update(JSON.stringify(payload)).digest("hex")
  };
}

function fillEvidence(event: StockPaperLearningV4OrderEvent): FillEvidenceResult {
  const fill = event.fill;
  if (event.eventType !== "FILL" || !fill ||
      !Number.isFinite(fill.quantity) || fill.quantity <= 0 ||
      !Number.isFinite(fill.priceUsd) || fill.priceUsd <= 0 ||
      !Number.isFinite(fill.notionalUsd) || fill.notionalUsd <= 0 ||
      !Number.isFinite(fill.modeledCostsUsd) || fill.modeledCostsUsd < 0) {
    return { reason: "FILL_ECONOMICS_INVALID" };
  }
  const calculatedNotionalUsd = fill.quantity * fill.priceUsd;
  if (!Number.isFinite(calculatedNotionalUsd) ||
      !approximatelyEqual(fill.notionalUsd, calculatedNotionalUsd)) {
    return { reason: "FILL_NOTIONAL_MISMATCH" };
  }

  const decisionMs = timestampMs(event.decisionAt);
  const observedMs = timestampMs(event.evidenceObservedAt);
  const benchmarkObservedMs = timestampMs(event.benchmarkObservedAt);
  const benchmarkTimestampMs = timestampMs(event.benchmarkTimestamp);
  const fillEvidenceMs = timestampMs(fill.evidenceAt);
  if (event.benchmarkSymbol !== "SPY" || !event.benchmarkEvidence ||
      !Number.isFinite(event.benchmarkPriceUsd) || (event.benchmarkPriceUsd ?? 0) <= 0 ||
      !event.benchmarkTimestamp || !event.benchmarkObservedAt || !event.benchmarkDigest) {
    return { reason: "BENCHMARK_EVIDENCE_MISSING" };
  }
  if (!isDigest(event.benchmarkDigest)) return { reason: "BENCHMARK_DIGEST_MISMATCH" };
  const canonicalBenchmark = canonicalBenchmarkEvidence(event.benchmarkRawEvidence);
  if (!canonicalBenchmark) return { reason: "BENCHMARK_EVIDENCE_UNVERIFIABLE" };
  if (canonicalBenchmark.kind !== event.benchmarkEvidence ||
      canonicalBenchmark.timestamp !== event.benchmarkTimestamp ||
      !approximatelyEqual(canonicalBenchmark.priceUsd, event.benchmarkPriceUsd!) ||
      canonicalBenchmark.digest !== event.benchmarkDigest) {
    return { reason: "BENCHMARK_DIGEST_MISMATCH" };
  }
  if (decisionMs === undefined || observedMs === undefined ||
      benchmarkObservedMs === undefined || benchmarkTimestampMs === undefined ||
      fillEvidenceMs === undefined) return { reason: "NON_CAUSAL_EVENT_CLOCK" };

  const fillKnownMs = fill.evidence === "BAR" ? fillEvidenceMs + 60_000 : fillEvidenceMs;
  const benchmarkKnownMs = event.benchmarkEvidence === "BAR"
    ? benchmarkTimestampMs + 60_000
    : benchmarkTimestampMs;
  const evidenceIntervalsMatch = fill.evidence === event.benchmarkEvidence &&
    (fill.evidence === "BAR"
      ? fillEvidenceMs === benchmarkTimestampMs
      : Math.abs(fillEvidenceMs - benchmarkTimestampMs) <= 60_000);
  if (fillKnownMs > observedMs || benchmarkKnownMs > benchmarkObservedMs ||
      observedMs > decisionMs || benchmarkObservedMs > decisionMs ||
      !evidenceIntervalsMatch) return { reason: "NON_CAUSAL_EVENT_CLOCK" };
  return {
    verified: {
      event,
      quantity: fill.quantity,
      priceUsd: fill.priceUsd,
      grossNotionalUsd: fill.notionalUsd,
      modeledCostsUsd: fill.modeledCostsUsd,
      benchmarkPriceUsd: event.benchmarkPriceUsd!,
      decisionMs
    }
  };
}

function preparedTrade(
  trade: StockPaperTrade,
  events: readonly StockPaperLearningV4OrderEvent[],
  cutoffMs: number,
  v41EvidenceStartedMs: number | undefined
): StockPaperAnalysisTradeV4 | StockPaperLearningV4EvidenceExclusion {
  const openedMs = timestampMs(trade.openedAt);
  const base = {
    tradeId: trade.id,
    symbol: trade.symbol,
    evidenceEra: v41EvidenceStartedMs !== undefined && openedMs !== undefined &&
      openedMs >= v41EvidenceStartedMs
      ? "POST_V41" as const
      : "LEGACY" as const
  };
  const closedMs = timestampMs(trade.closedAt);
  if (closedMs !== undefined && closedMs > cutoffMs) return { ...base, reason: "CLOSED_AFTER_CUTOFF" };
  if (closedMs === undefined || !Number.isFinite(trade.quantity) || trade.quantity <= 0 ||
      !Number.isFinite(trade.entryPriceUsd) || trade.entryPriceUsd <= 0 ||
      !Number.isFinite(trade.exitPriceUsd) || trade.exitPriceUsd <= 0 ||
      !Number.isFinite(trade.entryNotionalUsd) || trade.entryNotionalUsd <= 0 ||
      !Number.isFinite(trade.proceedsUsd) || trade.proceedsUsd < 0 ||
      !Number.isFinite(trade.modeledCostsUsd) || trade.modeledCostsUsd < 0 ||
      !Number.isFinite(trade.pnlUsd) || !Number.isFinite(trade.returnPercent)) {
    return { ...base, reason: "INVALID_TRADE_EVIDENCE" };
  }
  const context = trade.entryContext;
  if (!context) return { ...base, reason: "VERSIONED_ENTRY_CONTEXT_MISSING" };

  const positionEvents = events.filter((event) =>
    event.laneId === trade.laneId && event.positionId === trade.positionId &&
    event.eventType === "FILL"
  );
  const rawBuys = positionEvents.filter((event) => event.side === "BUY");
  const rawSells = positionEvents.filter((event) => event.side === "SELL");
  if (rawBuys.length === 0) return { ...base, reason: "BUY_FILL_EVENTS_MISSING" };
  if (rawSells.length === 0) return { ...base, reason: "SELL_FILL_EVENTS_MISSING" };
  const eventIds = new Set<string>();
  const fillIds = new Set<string>();
  for (const event of [...rawBuys, ...rawSells]) {
    if (eventIds.has(event.id) || (event.fill && fillIds.has(event.fill.id))) {
      return { ...base, reason: "DUPLICATE_FILL_EVIDENCE" };
    }
    eventIds.add(event.id);
    if (event.fill) fillIds.add(event.fill.id);
  }

  const verifiedBuys: VerifiedFillEvent[] = [];
  const verifiedSells: VerifiedFillEvent[] = [];
  for (const [raw, destination] of [
    [rawBuys, verifiedBuys],
    [rawSells, verifiedSells]
  ] as const) {
    for (const event of raw) {
      const result = fillEvidence(event);
      if ("reason" in result) return { ...base, reason: result.reason };
      destination.push(result.verified);
    }
  }
  verifiedBuys.sort((left, right) =>
    left.decisionMs - right.decisionMs || left.event.id.localeCompare(right.event.id)
  );
  verifiedSells.sort((left, right) =>
    left.decisionMs - right.decisionMs || left.event.id.localeCompare(right.event.id)
  );

  const buyQuantity = finiteSum(verifiedBuys.map((fill) => fill.quantity));
  const sellQuantity = finiteSum(verifiedSells.map((fill) => fill.quantity));
  if (buyQuantity === undefined || sellQuantity === undefined) {
    return { ...base, reason: "FILL_ECONOMICS_INVALID" };
  }
  if (!approximatelyEqual(buyQuantity, trade.quantity) ||
      !approximatelyEqual(sellQuantity, trade.quantity)) {
    return { ...base, reason: "FILL_QUANTITY_MISMATCH" };
  }

  const buyGrossNotionalUsd = finiteSum(verifiedBuys.map((fill) => fill.grossNotionalUsd));
  const sellGrossProceedsUsd = finiteSum(verifiedSells.map((fill) => fill.grossNotionalUsd));
  const buyModeledCostsUsd = finiteSum(verifiedBuys.map((fill) => fill.modeledCostsUsd));
  const sellModeledCostsUsd = finiteSum(verifiedSells.map((fill) => fill.modeledCostsUsd));
  if (buyGrossNotionalUsd === undefined || sellGrossProceedsUsd === undefined ||
      buyModeledCostsUsd === undefined || sellModeledCostsUsd === undefined) {
    return { ...base, reason: "FILL_ECONOMICS_INVALID" };
  }
  const ledgerCostBasisUsd = buyGrossNotionalUsd + buyModeledCostsUsd;
  const ledgerModeledCostsUsd = buyModeledCostsUsd + sellModeledCostsUsd;
  const ledgerNetProceedsUsd = sellGrossProceedsUsd - sellModeledCostsUsd;
  const ledgerRealizedPnlUsd = ledgerNetProceedsUsd - ledgerCostBasisUsd;
  const ledgerReturnPercent = ledgerRealizedPnlUsd / ledgerCostBasisUsd * 100;
  const ledgerEntryPriceUsd = buyGrossNotionalUsd / buyQuantity;
  const ledgerExitPriceUsd = sellGrossProceedsUsd / sellQuantity;
  if (![ledgerCostBasisUsd, ledgerModeledCostsUsd, ledgerNetProceedsUsd, ledgerRealizedPnlUsd,
    ledgerReturnPercent, ledgerEntryPriceUsd, ledgerExitPriceUsd].every(Number.isFinite) ||
      ledgerCostBasisUsd <= 0 || ledgerNetProceedsUsd < 0) {
    return { ...base, reason: "FILL_ECONOMICS_INVALID" };
  }
  if (!approximatelyEqual(ledgerCostBasisUsd, trade.entryNotionalUsd) ||
      !approximatelyEqual(ledgerEntryPriceUsd, trade.entryPriceUsd)) {
    return { ...base, reason: "COST_BASIS_MISMATCH" };
  }
  if (!approximatelyEqual(ledgerModeledCostsUsd, trade.modeledCostsUsd)) {
    return { ...base, reason: "MODELED_COSTS_MISMATCH" };
  }
  if (!approximatelyEqual(ledgerNetProceedsUsd, trade.proceedsUsd) ||
      !approximatelyEqual(sellGrossProceedsUsd, trade.proceedsUsd + sellModeledCostsUsd) ||
      !approximatelyEqual(ledgerExitPriceUsd, trade.exitPriceUsd)) {
    return { ...base, reason: "GROSS_PROCEEDS_MISMATCH" };
  }
  if (!approximatelyEqual(ledgerRealizedPnlUsd, trade.pnlUsd)) {
    return { ...base, reason: "REALIZED_PNL_MISMATCH" };
  }
  if (!approximatelyEqual(ledgerReturnPercent, trade.returnPercent)) {
    return { ...base, reason: "RETURN_MISMATCH" };
  }

  const buyLots = verifiedBuys.map((fill) => ({
    ...fill,
    remaining: fill.quantity,
    costBasisUsd: fill.grossNotionalUsd + fill.modeledCostsUsd
  }));
  let benchmarkEquivalentPnlUsd = 0;
  let matchedEntryNotionalUsd = 0;
  for (const sell of verifiedSells) {
    let remainingSell = sell.quantity;
    for (const buy of buyLots) {
      if (remainingSell <= RELATIVE_TOLERANCE) break;
      if (buy.remaining <= RELATIVE_TOLERANCE) continue;
      const matchedQuantity = Math.min(remainingSell, buy.remaining);
      const matchedEntryNotional = buy.costBasisUsd * matchedQuantity / buy.quantity;
      benchmarkEquivalentPnlUsd += matchedEntryNotional *
        (sell.benchmarkPriceUsd - buy.benchmarkPriceUsd) / buy.benchmarkPriceUsd;
      matchedEntryNotionalUsd += matchedEntryNotional;
      buy.remaining -= matchedQuantity;
      remainingSell -= matchedQuantity;
    }
    if (remainingSell > RELATIVE_TOLERANCE) {
      return { ...base, reason: "FILL_QUANTITY_MISMATCH" };
    }
  }
  if (buyLots.some((fill) => fill.remaining > RELATIVE_TOLERANCE) ||
      !Number.isFinite(benchmarkEquivalentPnlUsd) ||
      !Number.isFinite(matchedEntryNotionalUsd) || matchedEntryNotionalUsd <= 0) {
    return { ...base, reason: "FILL_QUANTITY_MISMATCH" };
  }

  const openedAt = new Date(verifiedBuys[0]!.decisionMs).toISOString();
  const closedAt = new Date(verifiedSells.at(-1)!.decisionMs).toISOString();
  if (Date.parse(closedAt) > cutoffMs || Date.parse(closedAt) <= Date.parse(openedAt)) {
    return { ...base, reason: "NON_CAUSAL_EVENT_CLOCK" };
  }
  return {
    id: trade.id,
    laneId: trade.laneId,
    symbol: trade.symbol,
    arm: trade.arm,
    phase: context.phase,
    feed: context.feed,
    policyVersion: context.policyVersion,
    featureVersion: context.featureVersion,
    executionVersion: context.executionVersion,
    tradeDayKey: stockTradeDayKey(new Date(openedAt)),
    openedAt,
    closedAt,
    notionalUsd: ledgerCostBasisUsd,
    netReturnPercent: ledgerReturnPercent,
    spyReturnPercent: benchmarkEquivalentPnlUsd / matchedEntryNotionalUsd * 100
  };
}

/** Converts v41+ append-only fill events into strict, cash-flow-weighted v4
 * research evidence. Pre-v41 or non-reconstructable trades are excluded. */
export function prepareStockPaperLearningV4Evidence(
  input: PrepareStockPaperLearningV4EvidenceInput
): Readonly<StockPaperLearningV4Evidence> {
  const cutoffMs = timestampMs(input.cutoffAt);
  if (cutoffMs === undefined) throw new Error("Learning-v4 evidence cutoff must include a valid timezone offset.");
  const explicitV41StartMs = timestampMs(input.v41EvidenceStartedAt);
  if (input.v41EvidenceStartedAt !== undefined && explicitV41StartMs === undefined) {
    throw new Error("Learning-v4 evidence boundary must include a valid timezone offset.");
  }
  const eventStartMs = input.orderEvents.reduce<number | undefined>((oldest, event) => {
    const eventMs = timestampMs(event.decisionAt);
    if (eventMs === undefined) return oldest;
    return oldest === undefined || eventMs < oldest ? eventMs : oldest;
  }, undefined);
  const v41EvidenceStartedMs = explicitV41StartMs ?? eventStartMs;
  const eventsByPosition = new Map<string, StockPaperLearningV4OrderEvent[]>();
  for (const event of input.orderEvents) {
    if (!event.positionId) continue;
    const key = `${event.laneId}:${event.positionId}`;
    const events = eventsByPosition.get(key) ?? [];
    events.push(event);
    eventsByPosition.set(key, events);
  }
  const trades: StockPaperAnalysisTradeV4[] = [];
  const exclusions: StockPaperLearningV4EvidenceExclusion[] = [];
  for (const trade of [...input.trades].sort((left, right) =>
    left.closedAt.localeCompare(right.closedAt) || left.id.localeCompare(right.id)
  )) {
    const prepared = preparedTrade(
      trade,
      eventsByPosition.get(`${trade.laneId}:${trade.positionId}`) ?? [],
      cutoffMs,
      v41EvidenceStartedMs
    );
    if ("reason" in prepared) exclusions.push(prepared);
    else trades.push(prepared);
  }
  return Object.freeze({
    ...(v41EvidenceStartedMs !== undefined
      ? { v41EvidenceStartedAt: new Date(v41EvidenceStartedMs).toISOString() }
      : {}),
    sourceTradeCount: input.trades.length,
    analysisTradeCount: trades.length,
    exclusions: Object.freeze(exclusions),
    trades: Object.freeze(trades),
    dailyReturns: Object.freeze([...(input.dailyReturns ?? [])])
  });
}
