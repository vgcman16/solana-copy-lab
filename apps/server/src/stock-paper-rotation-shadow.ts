import { createHash } from "node:crypto";
import type { AlpacaStockBar } from "@copylab/providers";
import {
  STOCK_PAPER_ROTATION_SHADOW_VERSION,
  type StockPaperAccount,
  type StockPaperCandidate,
  type StockPaperMarketFeed,
  type StockPaperMarketPhase,
  type StockPaperObservationOutcome,
  type StockPaperPolicy,
  type StockPaperPosition,
  type StockPaperRotationDecision,
  type StockPaperRotationIncomingLeg,
  type StockPaperRotationOutcome,
  type StockPaperRotationOutcomeMissingReason,
  type StockPaperRotationOutgoingLeg,
  type StockPaperRotationPolicy,
  type StockPaperRotationReasonCode,
  type StockPaperRotationSummary
} from "@copylab/shared";
import {
  modeledBuyFill,
  modeledSellFill,
  stockPositionSize
} from "./stock-paper-policy.js";
import { stockPaperPolicyDigestV3 } from "./stock-paper-learning-v3.js";

const MINUTE_MS = 60_000;
const IDEMPOTENCY_BUCKET_MS = 15 * MINUTE_MS;
const SUPPORTED_HORIZONS = new Set<StockPaperObservationOutcome["horizonMinutes"]>([15, 45, 180]);

export const DEFAULT_STOCK_PAPER_ROTATION_POLICY: Readonly<StockPaperRotationPolicy> =
  Object.freeze({
    version: STOCK_PAPER_ROTATION_SHADOW_VERSION,
    minimumPositionAgeMinutes: 15,
    rotationCooldownMinutes: 30,
    minimumScoreDelta: 8,
    minimumReplacementNotionalUsd: 1,
    maximumSwitchCostPercent: 2
  });

/** Comparator order is part of the versioned experiment, not an implementation
 * accident. Changing it requires a new rotation-shadow version. */
export const STOCK_PAPER_ROTATION_TIE_BREAKS = Object.freeze({
  outgoing: Object.freeze([
    "CURRENT_SCORE_ASC",
    "EXECUTABLE_RETURN_ASC",
    "SYMBOL_ASC",
    "POSITION_ID_ASC"
  ] as const),
  incoming: Object.freeze([
    "CURRENT_SCORE_DESC",
    "RELATIVE_VOLUME_DESC",
    "SYMBOL_ASC"
  ] as const)
});

export interface EvaluateStockPaperRotationDecisionInput {
  laneId: string;
  account: Pick<StockPaperAccount, "navUsd" | "cashUsd" | "deployedUsd">;
  positions: readonly StockPaperPosition[];
  candidates: readonly StockPaperCandidate[];
  sourcePolicy: StockPaperPolicy;
  phase: StockPaperMarketPhase;
  feed: StockPaperMarketFeed;
  decisionAt: string;
  lastRotationAt?: string;
  cooldownUntilBySymbol?: Readonly<Record<string, string>>;
  unavailableIncomingSymbols?: readonly string[];
  rotationPolicy?: StockPaperRotationPolicy;
}

export interface CalculateStockPaperRotationOutcomeInput {
  decision: StockPaperRotationDecision;
  horizonMinutes: StockPaperObservationOutcome["horizonMinutes"];
  outgoingBars: readonly AlpacaStockBar[];
  incomingBars: readonly AlpacaStockBar[];
  labeledAt: string;
}

export interface SummarizeStockPaperRotationShadowInput {
  decisions: readonly StockPaperRotationDecision[];
  outcomes: readonly StockPaperRotationOutcome[];
  updatedAt: string;
  recentLimit?: number;
}

interface OutgoingSelection {
  position: StockPaperPosition;
  candidate: StockPaperCandidate;
  leg: StockPaperRotationOutgoingLeg;
}

interface CompletePath {
  bars: AlpacaStockBar[];
  firstBarAt: string;
  lastBarAt: string;
}

interface PathResult {
  path?: CompletePath;
  missingReason?: StockPaperRotationOutcomeMissingReason;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(object[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(label: string, value: unknown): string {
  return createHash("sha256").update(`${label}:${canonicalJson(value)}`).digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function timestamp(value: string): number | undefined {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function requiredTimestamp(value: string, label: string): number {
  const parsed = timestamp(value);
  if (parsed === undefined) throw new Error(`${label} must be an ISO timestamp with an explicit timezone.`);
  return parsed;
}

function round(value: number, digits = 12): number {
  if (!Number.isFinite(value)) return value;
  return Number(value.toFixed(digits));
}

function finiteNonnegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function safeNumber(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function validateRotationPolicy(policy: StockPaperRotationPolicy): void {
  if (policy.version !== STOCK_PAPER_ROTATION_SHADOW_VERSION) {
    throw new Error("Unsupported stock PAPER rotation-shadow policy version.");
  }
  const nonnegative = [
    policy.minimumPositionAgeMinutes,
    policy.rotationCooldownMinutes,
    policy.minimumScoreDelta,
    policy.minimumReplacementNotionalUsd,
    policy.maximumSwitchCostPercent
  ];
  if (!nonnegative.every(finiteNonnegative)) {
    throw new Error("Stock PAPER rotation-shadow policy values must be finite and nonnegative.");
  }
}

function sameDecisionClock(
  candidate: StockPaperCandidate,
  decisionMs: number,
  phase: StockPaperMarketPhase,
  feed: StockPaperMarketFeed
): boolean {
  return timestamp(candidate.capturedAt) === decisionMs &&
    candidate.marketPhase === phase &&
    candidate.marketFeed === feed;
}

function usableQuote(candidate: StockPaperCandidate): boolean {
  return finitePositive(candidate.bidUsd) &&
    finitePositive(candidate.askUsd) &&
    candidate.askUsd >= candidate.bidUsd &&
    finiteNonnegative(candidate.spreadPercent) &&
    finiteNonnegative(candidate.relativeVolume) &&
    Number.isFinite(candidate.score);
}

function phasePenaltyPercent(phase: StockPaperMarketPhase, sourcePolicy: StockPaperPolicy): number {
  return phase === "REGULAR" ? 0 : sourcePolicy.extendedFillPenaltyPercent;
}

function sellPrice(
  referencePriceUsd: number,
  spreadPercent: number,
  extendedFillPenaltyPercent: number
): number {
  return modeledSellFill(referencePriceUsd, spreadPercent) *
    (1 - extendedFillPenaltyPercent / 100);
}

function buyPrice(
  askPriceUsd: number,
  spreadPercent: number,
  extendedFillPenaltyPercent: number
): number {
  return modeledBuyFill(askPriceUsd, spreadPercent) *
    (1 + extendedFillPenaltyPercent / 100);
}

function quoteMidpoint(candidate: StockPaperCandidate): number {
  return (candidate.bidUsd + candidate.askUsd) / 2;
}

function outgoingSelection(
  position: StockPaperPosition,
  candidate: StockPaperCandidate,
  decisionMs: number,
  extendedFillPenaltyPercent: number
): OutgoingSelection | undefined {
  if (position.status !== "OPEN" || !finitePositive(position.quantity) ||
      !finitePositive(position.remainingCostUsd) || !usableQuote(candidate)) {
    return undefined;
  }
  const openedMs = timestamp(position.openedAt);
  if (openedMs === undefined || openedMs > decisionMs) return undefined;
  const modeledSellPriceUsd = sellPrice(
    candidate.bidUsd,
    candidate.spreadPercent,
    extendedFillPenaltyPercent
  );
  const executableProceedsUsd = position.quantity * modeledSellPriceUsd;
  const modeledExitCostUsd = Math.max(
    0,
    position.quantity * (quoteMidpoint(candidate) - modeledSellPriceUsd)
  );
  return {
    position,
    candidate,
    leg: {
      positionId: position.id,
      symbol: position.symbol,
      openedAt: new Date(openedMs).toISOString(),
      ageMinutes: round((decisionMs - openedMs) / MINUTE_MS),
      candidateCapturedAt: candidate.capturedAt,
      currentScore: candidate.score,
      currentRelativeVolume: candidate.relativeVolume,
      bidUsd: candidate.bidUsd,
      askUsd: candidate.askUsd,
      spreadPercent: candidate.spreadPercent,
      quantity: position.quantity,
      remainingCostUsd: position.remainingCostUsd,
      executableReturnPercent: round(
        (executableProceedsUsd - position.remainingCostUsd) / position.remainingCostUsd * 100
      ),
      modeledSellPriceUsd: round(modeledSellPriceUsd),
      executableProceedsUsd: round(executableProceedsUsd),
      modeledExitCostUsd: round(modeledExitCostUsd)
    }
  };
}

function outgoingComparator(left: OutgoingSelection, right: OutgoingSelection): number {
  return left.leg.currentScore - right.leg.currentScore ||
    left.leg.executableReturnPercent - right.leg.executableReturnPercent ||
    left.leg.symbol.localeCompare(right.leg.symbol) ||
    left.leg.positionId.localeCompare(right.leg.positionId);
}

function incomingComparator(left: StockPaperCandidate, right: StockPaperCandidate): number {
  return right.score - left.score ||
    right.relativeVolume - left.relativeVolume ||
    left.symbol.localeCompare(right.symbol);
}

function decisionIdentity(input: {
  laneId: string;
  bucket: string;
  policyDigest: string;
  outgoingSymbol?: string;
  outgoingPositionId?: string;
  incomingSymbol?: string;
}): { id: string; idempotencyKey: string } {
  const identity = digest("stock-paper-rotation-decision-v1", input);
  return {
    id: `stock-rotation-decision:${identity}`,
    idempotencyKey: `stock-rotation-decision:${identity}`
  };
}

function baseDecision(input: {
  request: EvaluateStockPaperRotationDecisionInput;
  decisionAt: string;
  bucket: string;
  policy: StockPaperRotationPolicy;
  policyDigest: string;
  sourcePolicyDigest: string;
  extendedFillPenaltyPercent: number;
  status: StockPaperRotationDecision["status"];
  reasonCodes: StockPaperRotationReasonCode[];
  outgoing?: StockPaperRotationOutgoingLeg;
  incoming?: StockPaperRotationIncomingLeg;
  scoreDelta?: number;
  modeledSwitchCostsUsd?: number;
  modeledSwitchCostPercent?: number;
  hypothetical?: {
    postSaleCashUsd: number;
    postSaleDeployedUsd: number;
    postSaleNavUsd: number;
    postEntryCashUsd: number;
    postEntryDeployedUsd: number;
    postEntryNavUsd: number;
  };
}): StockPaperRotationDecision {
  const { request } = input;
  const identity = decisionIdentity({
    laneId: request.laneId,
    bucket: input.bucket,
    policyDigest: input.policyDigest,
    ...(input.outgoing
      ? { outgoingSymbol: input.outgoing.symbol, outgoingPositionId: input.outgoing.positionId }
      : {}),
    ...(input.incoming ? { incomingSymbol: input.incoming.symbol } : {})
  });
  return deepFreeze({
    ...identity,
    laneId: request.laneId,
    version: STOCK_PAPER_ROTATION_SHADOW_VERSION,
    policy: { ...input.policy },
    policyDigest: input.policyDigest,
    sourcePolicyDigest: input.sourcePolicyDigest,
    idempotencyBucket: input.bucket,
    decisionAt: input.decisionAt,
    phase: request.phase,
    feed: request.feed,
    extendedFillPenaltyPercent: input.extendedFillPenaltyPercent,
    status: input.status,
    reasonCodes: [...input.reasonCodes],
    analysisOnly: true,
    affectsTrading: false,
    promotionEligible: false,
    portfolioCounterfactual: false,
    resultsAreIndependentOneStepCounterfactuals: true,
    ...(input.outgoing ? { outgoing: { ...input.outgoing } } : {}),
    ...(input.incoming ? { incoming: { ...input.incoming } } : {}),
    ...(input.scoreDelta !== undefined ? { scoreDelta: round(input.scoreDelta) } : {}),
    ...(input.modeledSwitchCostsUsd !== undefined
      ? { modeledSwitchCostsUsd: round(input.modeledSwitchCostsUsd) }
      : {}),
    ...(input.modeledSwitchCostPercent !== undefined
      ? { modeledSwitchCostPercent: round(input.modeledSwitchCostPercent) }
      : {}),
    preRotationNavUsd: safeNumber(request.account.navUsd),
    preRotationCashUsd: safeNumber(request.account.cashUsd),
    preRotationDeployedUsd: safeNumber(request.account.deployedUsd),
    ...(input.hypothetical ? {
      hypotheticalPostSaleCashUsd: round(input.hypothetical.postSaleCashUsd),
      hypotheticalPostSaleDeployedUsd: round(input.hypothetical.postSaleDeployedUsd),
      hypotheticalPostSaleNavUsd: round(input.hypothetical.postSaleNavUsd),
      hypotheticalPostEntryCashUsd: round(input.hypothetical.postEntryCashUsd),
      hypotheticalPostEntryDeployedUsd: round(input.hypothetical.postEntryDeployedUsd),
      hypotheticalPostEntryNavUsd: round(input.hypothetical.postEntryNavUsd)
    } : {})
  });
}

export function evaluateStockPaperRotationDecision(
  request: EvaluateStockPaperRotationDecisionInput
): StockPaperRotationDecision {
  const decisionMs = requiredTimestamp(request.decisionAt, "Rotation decision time");
  const decisionAt = new Date(decisionMs).toISOString();
  const bucket = new Date(Math.floor(decisionMs / IDEMPOTENCY_BUCKET_MS) * IDEMPOTENCY_BUCKET_MS)
    .toISOString();
  const policy = { ...(request.rotationPolicy ?? DEFAULT_STOCK_PAPER_ROTATION_POLICY) };
  validateRotationPolicy(policy);
  const sourcePolicyDigest = stockPaperPolicyDigestV3(request.sourcePolicy);
  const policyDigest = `stock-rotation-policy-v1:${digest("stock-paper-rotation-policy-v1", {
    policy,
    sourcePolicyDigest,
    tieBreaks: STOCK_PAPER_ROTATION_TIE_BREAKS
  })}`;
  const extendedFillPenaltyPercent = phasePenaltyPercent(request.phase, request.sourcePolicy);
  const common = {
    request,
    decisionAt,
    bucket,
    policy,
    policyDigest,
    sourcePolicyDigest,
    extendedFillPenaltyPercent
  };

  if (!finitePositive(request.account.navUsd) || !finiteNonnegative(request.account.cashUsd) ||
      !finiteNonnegative(request.account.deployedUsd)) {
    return baseDecision({
      ...common,
      status: "HOLD",
      reasonCodes: ["INVALID_ACCOUNT_STATE"]
    });
  }

  const currentCandidateBySymbol = new Map(
    request.candidates
      .filter((candidate) => sameDecisionClock(candidate, decisionMs, request.phase, request.feed))
      .map((candidate) => [candidate.symbol, candidate] as const)
  );
  const outgoingSelections = request.positions.flatMap((position) => {
    const candidate = currentCandidateBySymbol.get(position.symbol);
    if (!candidate) return [];
    const selected = outgoingSelection(position, candidate, decisionMs, extendedFillPenaltyPercent);
    return selected ? [selected] : [];
  }).sort(outgoingComparator);
  const outgoing = outgoingSelections[0];
  if (!outgoing) {
    return baseDecision({
      ...common,
      status: "HOLD",
      reasonCodes: ["NO_CURRENT_ELIGIBLE_OPEN_POSITION"]
    });
  }

  const openSymbols = new Set(request.positions
    .filter((position) => position.status === "OPEN" || position.status === "UNPRICED")
    .map((position) => position.symbol));
  const unavailableIncoming = new Set(request.unavailableIncomingSymbols ?? []);
  const incoming = request.candidates.filter((candidate) =>
    sameDecisionClock(candidate, decisionMs, request.phase, request.feed) &&
    candidate.eligible &&
    usableQuote(candidate) &&
    !openSymbols.has(candidate.symbol) &&
    !unavailableIncoming.has(candidate.symbol) &&
    (request.phase === "REGULAR" || (
      candidate.highConviction &&
      candidate.spreadPercent <= request.sourcePolicy.extendedEntrySpreadPercent
    ))
  ).sort(incomingComparator)[0];
  if (!incoming) {
    return baseDecision({
      ...common,
      status: "HOLD",
      reasonCodes: ["NO_CURRENT_ELIGIBLE_REPLACEMENT"],
      outgoing: outgoing.leg
    });
  }

  const preliminaryIncoming: StockPaperRotationIncomingLeg = {
    symbol: incoming.symbol,
    candidateCapturedAt: incoming.capturedAt,
    currentScore: incoming.score,
    currentRelativeVolume: incoming.relativeVolume,
    bidUsd: incoming.bidUsd,
    askUsd: incoming.askUsd,
    spreadPercent: incoming.spreadPercent,
    modeledBuyPriceUsd: 0,
    quantity: 0,
    entryNotionalUsd: 0,
    modeledEntryCostUsd: 0
  };
  const scoreDelta = incoming.score - outgoing.candidate.score;

  if (outgoing.leg.ageMinutes + 1e-9 < policy.minimumPositionAgeMinutes) {
    return baseDecision({
      ...common,
      status: "HOLD",
      reasonCodes: ["POSITION_TOO_YOUNG"],
      outgoing: outgoing.leg,
      incoming: preliminaryIncoming,
      scoreDelta
    });
  }

  if (request.lastRotationAt !== undefined) {
    const lastRotationMs = timestamp(request.lastRotationAt);
    if (lastRotationMs === undefined) {
      return baseDecision({
        ...common,
        status: "HOLD",
        reasonCodes: ["INVALID_ACCOUNT_STATE"],
        outgoing: outgoing.leg,
        incoming: preliminaryIncoming,
        scoreDelta
      });
    }
    if (decisionMs < lastRotationMs + policy.rotationCooldownMinutes * MINUTE_MS) {
      return baseDecision({
        ...common,
        status: "HOLD",
        reasonCodes: ["ROTATION_COOLDOWN_ACTIVE"],
        outgoing: outgoing.leg,
        incoming: preliminaryIncoming,
        scoreDelta
      });
    }
  }

  const symbolCooldownUntil = request.cooldownUntilBySymbol?.[incoming.symbol];
  if (symbolCooldownUntil !== undefined) {
    const cooldownUntilMs = timestamp(symbolCooldownUntil);
    if (cooldownUntilMs === undefined) {
      return baseDecision({
        ...common,
        status: "HOLD",
        reasonCodes: ["INVALID_ACCOUNT_STATE"],
        outgoing: outgoing.leg,
        incoming: preliminaryIncoming,
        scoreDelta
      });
    }
    if (decisionMs < cooldownUntilMs) {
      return baseDecision({
        ...common,
        status: "HOLD",
        reasonCodes: ["SYMBOL_COOLDOWN_ACTIVE"],
        outgoing: outgoing.leg,
        incoming: preliminaryIncoming,
        scoreDelta
      });
    }
  }

  if (scoreDelta + 1e-9 < policy.minimumScoreDelta) {
    return baseDecision({
      ...common,
      status: "HOLD",
      reasonCodes: ["SCORE_DELTA_BELOW_MINIMUM"],
      outgoing: outgoing.leg,
      incoming: preliminaryIncoming,
      scoreDelta
    });
  }

  const postSaleCashUsd = request.account.cashUsd + outgoing.leg.executableProceedsUsd;
  const postSaleDeployedUsd = Math.max(
    0,
    request.account.deployedUsd - outgoing.leg.executableProceedsUsd
  );
  const postSaleNavUsd = postSaleCashUsd + postSaleDeployedUsd;
  const baseReplacementNotionalUsd = stockPositionSize({
    navUsd: postSaleNavUsd,
    cashUsd: postSaleCashUsd,
    deployedUsd: postSaleDeployedUsd,
    candidate: incoming,
    policy: request.sourcePolicy,
    armMultiplier: 1
  });
  const entryNotionalUsd = baseReplacementNotionalUsd *
    (request.phase === "REGULAR" ? 1 : request.sourcePolicy.extendedEntrySizeMultiplier);
  const modeledBuyPriceUsd = buyPrice(
    incoming.askUsd,
    incoming.spreadPercent,
    extendedFillPenaltyPercent
  );
  const quantity = modeledBuyPriceUsd > 0 ? entryNotionalUsd / modeledBuyPriceUsd : 0;
  const modeledEntryCostUsd = Math.max(
    0,
    quantity * (modeledBuyPriceUsd - quoteMidpoint(incoming))
  );
  const incomingLeg: StockPaperRotationIncomingLeg = {
    ...preliminaryIncoming,
    modeledBuyPriceUsd: round(modeledBuyPriceUsd),
    quantity: round(quantity),
    entryNotionalUsd: round(entryNotionalUsd),
    modeledEntryCostUsd: round(modeledEntryCostUsd)
  };
  const immediateIncomingExitPriceUsd = sellPrice(
    incoming.bidUsd,
    incoming.spreadPercent,
    extendedFillPenaltyPercent
  );
  const postEntryCashUsd = postSaleCashUsd - entryNotionalUsd;
  const postEntryDeployedUsd = postSaleDeployedUsd + quantity * immediateIncomingExitPriceUsd;
  const postEntryNavUsd = postEntryCashUsd + postEntryDeployedUsd;
  const hypothetical = {
    postSaleCashUsd,
    postSaleDeployedUsd,
    postSaleNavUsd,
    postEntryCashUsd,
    postEntryDeployedUsd,
    postEntryNavUsd
  };

  if (entryNotionalUsd + 1e-9 < policy.minimumReplacementNotionalUsd || !finitePositive(quantity)) {
    return baseDecision({
      ...common,
      status: "HOLD",
      reasonCodes: ["REPLACEMENT_SIZE_BELOW_MINIMUM"],
      outgoing: outgoing.leg,
      incoming: incomingLeg,
      scoreDelta,
      hypothetical
    });
  }

  const modeledSwitchCostsUsd = outgoing.leg.modeledExitCostUsd + modeledEntryCostUsd;
  const modeledSwitchCostPercent = modeledSwitchCostsUsd / entryNotionalUsd * 100;
  if (modeledSwitchCostPercent > policy.maximumSwitchCostPercent + 1e-9) {
    return baseDecision({
      ...common,
      status: "HOLD",
      reasonCodes: ["SWITCH_COST_ABOVE_MAXIMUM"],
      outgoing: outgoing.leg,
      incoming: incomingLeg,
      scoreDelta,
      modeledSwitchCostsUsd,
      modeledSwitchCostPercent,
      hypothetical
    });
  }

  return baseDecision({
    ...common,
    status: "ROTATE",
    reasonCodes: [],
    outgoing: outgoing.leg,
    incoming: incomingLeg,
    scoreDelta,
    modeledSwitchCostsUsd,
    modeledSwitchCostPercent,
    hypothetical
  });
}

function barsEqual(left: AlpacaStockBar, right: AlpacaStockBar): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function validCompleteBar(bar: AlpacaStockBar): boolean {
  return finitePositive(bar.open) && finitePositive(bar.high) && finitePositive(bar.low) &&
    finitePositive(bar.close) && finitePositive(bar.vwap) && finiteNonnegative(bar.volume) &&
    finiteNonnegative(bar.tradeCount) && bar.low <= bar.open && bar.low <= bar.close &&
    bar.high >= bar.open && bar.high >= bar.close && bar.high >= bar.low;
}

function completePath(input: {
  bars: readonly AlpacaStockBar[];
  decisionMs: number;
  dueMs: number;
  horizonMinutes: number;
  side: "OUTGOING" | "INCOMING";
}): PathResult {
  const firstExpectedMs = Math.floor(input.decisionMs / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  const expected = Array.from(
    { length: input.horizonMinutes },
    (_, index) => firstExpectedMs + index * MINUTE_MS
  );
  const byTimestamp = new Map<number, AlpacaStockBar>();
  let sawStrictlyFuture = false;
  for (const bar of input.bars) {
    const barMs = timestamp(bar.timestamp);
    if (barMs === undefined || barMs <= input.decisionMs || barMs > input.dueMs) continue;
    sawStrictlyFuture = true;
    if (!expected.includes(barMs)) continue;
    const prior = byTimestamp.get(barMs);
    if (prior && !barsEqual(prior, bar)) {
      return { missingReason: `${input.side}_CONFLICTING_BAR` as StockPaperRotationOutcomeMissingReason };
    }
    byTimestamp.set(barMs, bar);
  }
  if (!sawStrictlyFuture) {
    return {
      missingReason: `${input.side}_NO_STRICTLY_FUTURE_BARS` as StockPaperRotationOutcomeMissingReason
    };
  }
  const path = expected.map((barMs) => byTimestamp.get(barMs));
  if (path.some((bar) => bar === undefined)) {
    return { missingReason: `${input.side}_PATH_GAP` as StockPaperRotationOutcomeMissingReason };
  }
  if (path.some((bar) => !validCompleteBar(bar!))) {
    return { missingReason: `${input.side}_INVALID_BAR` as StockPaperRotationOutcomeMissingReason };
  }
  const complete = path as AlpacaStockBar[];
  return {
    path: {
      bars: complete,
      firstBarAt: complete[0]!.timestamp,
      lastBarAt: complete.at(-1)!.timestamp
    }
  };
}

function outcomeIdentity(
  decision: StockPaperRotationDecision,
  horizonMinutes: number
): { id: string; idempotencyKey: string } {
  const identity = digest("stock-paper-rotation-outcome-v1", {
    decisionId: decision.id,
    horizonMinutes
  });
  return {
    id: `stock-rotation-outcome:${identity}`,
    idempotencyKey: `stock-rotation-outcome:${identity}`
  };
}

function baseOutcome(input: {
  decision: StockPaperRotationDecision;
  horizonMinutes: StockPaperObservationOutcome["horizonMinutes"];
  dueAt: string;
  labeledAt: string;
  status: StockPaperRotationOutcome["status"];
  missingReason?: StockPaperRotationOutcomeMissingReason;
}): StockPaperRotationOutcome {
  return deepFreeze({
    ...outcomeIdentity(input.decision, input.horizonMinutes),
    decisionId: input.decision.id,
    laneId: input.decision.laneId,
    version: STOCK_PAPER_ROTATION_SHADOW_VERSION,
    horizonMinutes: input.horizonMinutes,
    status: input.status,
    dueAt: input.dueAt,
    labeledAt: input.labeledAt,
    analysisOnly: true,
    affectsTrading: false,
    promotionEligible: false,
    portfolioCounterfactual: false,
    resultsAreIndependentOneStepCounterfactuals: true,
    ...(input.missingReason ? { missingReason: input.missingReason } : {})
  });
}

export function calculateStockPaperRotationOutcome(
  request: CalculateStockPaperRotationOutcomeInput
): StockPaperRotationOutcome {
  if (!SUPPORTED_HORIZONS.has(request.horizonMinutes)) {
    throw new Error("Stock PAPER rotation outcomes support only 15, 45, or 180 minute horizons.");
  }
  const decisionMs = requiredTimestamp(request.decision.decisionAt, "Rotation decision time");
  const labeledMs = requiredTimestamp(request.labeledAt, "Rotation outcome label time");
  const dueMs = decisionMs + request.horizonMinutes * MINUTE_MS;
  const dueAt = new Date(dueMs).toISOString();
  const labeledAt = new Date(labeledMs).toISOString();
  const common = {
    decision: request.decision,
    horizonMinutes: request.horizonMinutes,
    dueAt,
    labeledAt
  };
  if (request.decision.status !== "ROTATE" || !request.decision.outgoing || !request.decision.incoming) {
    return baseOutcome({
      ...common,
      status: "MISSING",
      missingReason: "DECISION_DID_NOT_ROTATE"
    });
  }
  if (labeledMs < dueMs) {
    return baseOutcome({ ...common, status: "MISSING", missingReason: "HORIZON_NOT_DUE" });
  }
  const outgoing = completePath({
    bars: request.outgoingBars,
    decisionMs,
    dueMs,
    horizonMinutes: request.horizonMinutes,
    side: "OUTGOING"
  });
  if (!outgoing.path) {
    return baseOutcome({
      ...common,
      status: "MISSING",
      missingReason: outgoing.missingReason ?? "OUTGOING_PATH_GAP"
    });
  }
  const incoming = completePath({
    bars: request.incomingBars,
    decisionMs,
    dueMs,
    horizonMinutes: request.horizonMinutes,
    side: "INCOMING"
  });
  if (!incoming.path) {
    return baseOutcome({
      ...common,
      status: "MISSING",
      missingReason: incoming.missingReason ?? "INCOMING_PATH_GAP"
    });
  }

  const outgoingLeg = request.decision.outgoing;
  const incomingLeg = request.decision.incoming;
  const outgoingClose = outgoing.path.bars.at(-1)!.close;
  const incomingClose = incoming.path.bars.at(-1)!.close;
  const baselineExitPriceUsd = sellPrice(
    outgoingClose,
    outgoingLeg.spreadPercent,
    request.decision.extendedFillPenaltyPercent ?? 0
  );
  const baselineExitProceedsUsd = outgoingLeg.quantity * baselineExitPriceUsd;
  const baselineModeledExitCostUsd = Math.max(
    0,
    outgoingLeg.quantity * (outgoingClose - baselineExitPriceUsd)
  );
  const baselineHoldPnlUsd = baselineExitProceedsUsd - outgoingLeg.remainingCostUsd;
  const rotatedIncomingExitPriceUsd = sellPrice(
    incomingClose,
    incomingLeg.spreadPercent,
    request.decision.extendedFillPenaltyPercent ?? 0
  );
  const rotatedIncomingExitProceedsUsd = incomingLeg.quantity * rotatedIncomingExitPriceUsd;
  const rotatedIncomingModeledExitCostUsd = Math.max(
    0,
    incomingLeg.quantity * (incomingClose - rotatedIncomingExitPriceUsd)
  );
  const rotatedPnlUsd =
    outgoingLeg.executableProceedsUsd - outgoingLeg.remainingCostUsd +
    rotatedIncomingExitProceedsUsd - incomingLeg.entryNotionalUsd;
  const incrementalPnlUsd = rotatedPnlUsd - baselineHoldPnlUsd;
  const comparisonNotionalUsd = Math.max(
    outgoingLeg.remainingCostUsd,
    incomingLeg.entryNotionalUsd
  );
  const incrementalReturnPercent = comparisonNotionalUsd > 0
    ? incrementalPnlUsd / comparisonNotionalUsd * 100
    : 0;
  const totalRotationModeledCostsUsd =
    (request.decision.modeledSwitchCostsUsd ??
      outgoingLeg.modeledExitCostUsd + incomingLeg.modeledEntryCostUsd) +
    rotatedIncomingModeledExitCostUsd;

  return deepFreeze({
    ...baseOutcome({ ...common, status: "LABELED" }),
    outgoingFirstBarAt: outgoing.path.firstBarAt,
    outgoingLastBarAt: outgoing.path.lastBarAt,
    incomingFirstBarAt: incoming.path.firstBarAt,
    incomingLastBarAt: incoming.path.lastBarAt,
    baselineExitPriceUsd: round(baselineExitPriceUsd),
    baselineExitProceedsUsd: round(baselineExitProceedsUsd),
    baselineModeledExitCostUsd: round(baselineModeledExitCostUsd),
    baselineHoldPnlUsd: round(baselineHoldPnlUsd),
    rotatedIncomingExitPriceUsd: round(rotatedIncomingExitPriceUsd),
    rotatedIncomingExitProceedsUsd: round(rotatedIncomingExitProceedsUsd),
    rotatedIncomingModeledExitCostUsd: round(rotatedIncomingModeledExitCostUsd),
    rotatedPnlUsd: round(rotatedPnlUsd),
    totalRotationModeledCostsUsd: round(totalRotationModeledCostsUsd),
    incrementalPnlUsd: round(incrementalPnlUsd),
    incrementalReturnPercent: round(incrementalReturnPercent)
  });
}

export function summarizeStockPaperRotationShadow(
  request: SummarizeStockPaperRotationShadowInput
): StockPaperRotationSummary {
  const updatedMs = requiredTimestamp(request.updatedAt, "Rotation summary update time");
  const recentLimit = Math.max(1, Math.min(100, Math.trunc(request.recentLimit ?? 20)));
  const labeled = request.outcomes.filter((outcome) =>
    outcome.status === "LABELED" &&
    outcome.incrementalPnlUsd !== undefined &&
    outcome.incrementalReturnPercent !== undefined
  );
  const wins = labeled.filter((outcome) => outcome.incrementalPnlUsd! > 0).length;
  const meanPnl = labeled.length > 0
    ? labeled.reduce((sum, outcome) => sum + outcome.incrementalPnlUsd!, 0) / labeled.length
    : 0;
  const meanReturn = labeled.length > 0
    ? labeled.reduce((sum, outcome) => sum + outcome.incrementalReturnPercent!, 0) / labeled.length
    : 0;
  return deepFreeze({
    version: STOCK_PAPER_ROTATION_SHADOW_VERSION,
    analysisOnly: true,
    affectsTrading: false,
    promotionEligible: false,
    portfolioCounterfactual: false,
    resultsAreIndependentOneStepCounterfactuals: true,
    compoundedPortfolioNavAvailable: false,
    evaluatedDecisions: request.decisions.length,
    proposedRotations: request.decisions.filter((decision) => decision.status === "ROTATE").length,
    heldDecisions: request.decisions.filter((decision) => decision.status === "HOLD").length,
    labeledOutcomes: labeled.length,
    missingOutcomes: request.outcomes.filter((outcome) => outcome.status === "MISSING").length,
    incrementalWins: wins,
    incrementalWinRatePercent: labeled.length > 0 ? round(wins / labeled.length * 100) : 0,
    meanIncrementalPnlUsd: round(meanPnl),
    meanIncrementalReturnPercent: round(meanReturn),
    recentDecisions: [...request.decisions]
      .sort((left, right) => right.decisionAt.localeCompare(left.decisionAt) || left.id.localeCompare(right.id))
      .slice(0, recentLimit),
    recentOutcomes: [...request.outcomes]
      .sort((left, right) => right.labeledAt.localeCompare(left.labeledAt) || left.id.localeCompare(right.id))
      .slice(0, recentLimit),
    updatedAt: new Date(updatedMs).toISOString()
  });
}
