import { createHash } from "node:crypto";
import {
  DEFAULT_RISK_POLICY,
  SOL_MINT,
  USDC_MINT,
  type AutonomousPaperAccount,
  type AutonomousPaperDecision,
  type AutonomousPaperEvent,
  type AutonomousPaperExitReason,
  type AutonomousPaperLane,
  type AutonomousPaperMarketSnapshot,
  type AutonomousPaperPosition,
  type AutonomousPaperReplayEpisode,
  type AutonomousPaperReplayExitEvidence,
  type AutonomousPaperReplayObservation as PersistedAutonomousPaperReplayObservation,
  type AutonomousPaperStrategyArm,
  type AutonomousPaperSizingBreakdown,
  type AutonomousPaperTrade,
  type ModeState,
  type QuoteRequest,
  type QuoteSnapshot
} from "@copylab/shared";
import type {
  JupiterMarketCategoryRanks,
  JupiterMarketTokenSnapshot,
  JupiterMarketUniverseSnapshot
} from "@copylab/providers";
import {
  AUTONOMOUS_PAPER_CANDIDATE_EVENT_BATCH_MAXIMUM,
  type Repository
} from "./repository.js";
import {
  AUTONOMOUS_PAPER_POLICY_VERSION,
  AUTONOMOUS_PAPER_V10_POLICY_VERSION,
  AUTONOMOUS_PAPER_V11_POLICY_VERSION,
  AUTONOMOUS_PAPER_V12_POLICY_VERSION,
  AUTONOMOUS_PAPER_V8_POLICY_VERSION,
  AUTONOMOUS_PAPER_V9_POLICY_VERSION,
  autonomousAdaptiveEntrySize,
  autonomousDailyEntryPaused,
  autonomousDrawdownLocked,
  autonomousEntrySize,
  autonomousExitDecision,
  autonomousPaperLearningContext,
  autonomousMomentum,
  autonomousStaticAdmission
} from "./autonomous-paper-policy.js";
import {
  AUTONOMOUS_PAPER_EXPLORATION_MAXIMUM_ENTRIES_PER_UTC_DAY,
  autonomousControlledExploration
} from "./autonomous-paper-exploration.js";
import {
  AUTONOMOUS_PAPER_REPLAY_HORIZON_MINUTES,
  autonomousPaperReplayCadenceGap,
  buildAutonomousPaperReplayReport,
  executableAutonomousPaperReplayObservation,
  newAutonomousPaperReplayEpisode,
  unpricedAutonomousPaperReplayObservation
} from "./autonomous-paper-replay-lab.js";
import type { AutonomousLearningCandidateStrategy } from "./autonomous-learning.js";

const USDC_DECIMALS = 6;
const LAMPORTS_PER_SOL = 1_000_000_000;
const MINIMUM_CONFIRMATION_GAP_MS = 60_000;
const STRESS_ADVERSE_MOVE_FRACTION = 0.005;
const MAXIMUM_EXACT_MINT_LOOKUP_SIZE = 100;
const EXACT_MINT_HYDRATION_CHUNK_SIZE = 50;
const UTC_DAY_MINUTES = 24 * 60;
const AUTONOMOUS_PAPER_REPLAY_QUOTE_BUDGET_PER_SCAN_FRACTION = 1 / 3;
/** This is not a scheduling cap. Every valid path is serviced each cycle. It is
 * only an absolute fail-closed guard for a corrupt or unexpectedly relaxed
 * policy whose derived causal-path maximum would make provider work unsafe. */
const AUTONOMOUS_PAPER_REPLAY_PROVIDER_WORK_HARD_CEILING = 64;

const CATEGORY_RANK_KEYS = Object.freeze([
  "topTraded24h",
  "topTraded6h",
  "topTraded1h",
  "topTrending6h",
  "topTrending1h",
  "topOrganicScore5m",
  "topOrganicScore1h"
] as const satisfies readonly (keyof JupiterMarketCategoryRanks)[]);

interface PersistedEntryCadence {
  entriesToday: number;
  explorationEntriesToday: number;
  latestEntryAt?: string;
}

interface AdaptiveRoundTripEvidence {
  buy: QuoteSnapshot;
  sell: QuoteSnapshot;
  requestedUsd: number;
  guaranteedSellUsd: number;
  buyFeeUsd: number;
  sellFeeUsd: number;
  projectedCostPercent: number;
  stressCostPercent: number;
}

function supportsControlledExploration(policyVersion: string): boolean {
  return policyVersion === AUTONOMOUS_PAPER_V8_POLICY_VERSION ||
    policyVersion === AUTONOMOUS_PAPER_V9_POLICY_VERSION ||
    policyVersion === AUTONOMOUS_PAPER_V10_POLICY_VERSION ||
    policyVersion === AUTONOMOUS_PAPER_V11_POLICY_VERSION ||
    policyVersion === AUTONOMOUS_PAPER_V12_POLICY_VERSION ||
    policyVersion === AUTONOMOUS_PAPER_POLICY_VERSION;
}

function supportsEvidenceLearning(policyVersion: string): boolean {
  return policyVersion === AUTONOMOUS_PAPER_V10_POLICY_VERSION ||
    policyVersion === AUTONOMOUS_PAPER_V11_POLICY_VERSION ||
    policyVersion === AUTONOMOUS_PAPER_V12_POLICY_VERSION ||
    policyVersion === AUTONOMOUS_PAPER_POLICY_VERSION;
}

function usesStrictEvidenceQuotes(policyVersion: string): boolean {
  return policyVersion === AUTONOMOUS_PAPER_V11_POLICY_VERSION ||
    policyVersion === AUTONOMOUS_PAPER_V12_POLICY_VERSION ||
    policyVersion === AUTONOMOUS_PAPER_POLICY_VERSION;
}

export interface AutonomousPaperEngineOptions {
  mode: () => ModeState;
  /** Independent entry gate. Existing PAPER positions must continue to mark
   * and exit while an operational hold blocks only new simulated inventory. */
  newEntriesAllowed?: () => boolean;
  fetchSignalUniverse: () => Promise<JupiterMarketUniverseSnapshot>;
  lookupMints: (mints: readonly string[]) => Promise<JupiterMarketTokenSnapshot[]>;
  quote: (request: QuoteRequest) => Promise<QuoteSnapshot>;
  solPriceUsd: () => number;
  /** Analysis-only handoff of the exact causal universe already fetched for
   * this cycle. A failure cannot rewrite or block the PAPER trade outcome. */
  onUniverse?: (input: {
    lane: AutonomousPaperLane;
    universe: JupiterMarketUniverseSnapshot;
    tokens: readonly JupiterMarketTokenSnapshot[];
    sol?: JupiterMarketTokenSnapshot;
  }) => Promise<void> | void;
  learningStrategy?: (
    token: JupiterMarketTokenSnapshot,
    capturedAt: string,
    lane: AutonomousPaperLane
  ) => AutonomousLearningCandidateStrategy | undefined;
  now?: () => Date;
  onUpdate?: (data: { laneId: string; outcome: string; mint?: string }) => void;
  onError?: (error: Error) => void;
}

function hashId(prefix: string, ...parts: Array<string | number>): string {
  const digest = createHash("sha256")
    .update([prefix, ...parts.map(String)].join("\u0000"))
    .digest("hex");
  return `${prefix}:${digest}`;
}

function developerCluster(token: JupiterMarketTokenSnapshot): string {
  return token.developer || token.launchpad
    ? hashId("autonomous-developer-cluster-v1", token.developer ?? "", token.launchpad ?? "")
    : `mint:${token.mint}`;
}

function cycleBucket(lane: AutonomousPaperLane, now: Date): number {
  return Math.floor(now.getTime() / (lane.policy.scanIntervalMinutes * 60_000));
}

function finiteOrMissing(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) ? value : -1;
}

function organicShare(stats: JupiterMarketTokenSnapshot["stats5m"]): number {
  if (!stats || stats.buyOrganicVolume === undefined || stats.sellOrganicVolume === undefined) {
    return -1;
  }
  const total = stats.buyOrganicVolume + stats.sellOrganicVolume;
  return total > 0 ? stats.buyOrganicVolume / total : -1;
}

function organicVolume(stats: JupiterMarketTokenSnapshot["stats5m"]): number {
  return stats?.buyOrganicVolume !== undefined && stats.sellOrganicVolume !== undefined
    ? stats.buyOrganicVolume + stats.sellOrganicVolume
    : -1;
}

function categoryRankCount(ranks: JupiterMarketCategoryRanks): number {
  return CATEGORY_RANK_KEYS.reduce(
    (count, key) => count + (ranks[key] === undefined ? 0 : 1),
    0
  );
}

function categoryRankTotal(ranks: JupiterMarketCategoryRanks): number {
  return CATEGORY_RANK_KEYS.reduce((sum, key) => sum + (ranks[key] ?? 10_000), 0);
}

function hasCategoryRank(token: JupiterMarketTokenSnapshot): boolean {
  return categoryRankCount(token.categoryRanks) > 0;
}

function missingOrganicEvidence(token: JupiterMarketTokenSnapshot): boolean {
  return [
    token.stats5m?.buyOrganicVolume,
    token.stats5m?.sellOrganicVolume,
    token.stats5m?.numOrganicBuyers,
    token.stats1h?.buyOrganicVolume,
    token.stats1h?.sellOrganicVolume
  ].some((value) => value === undefined || !Number.isFinite(value));
}

function missingMomentumEvidence(token: JupiterMarketTokenSnapshot): boolean {
  return missingOrganicEvidence(token) || [
    token.stats5m?.priceChange,
    token.stats1h?.priceChange,
    token.stats1h?.liquidityChange,
    token.stats6h?.priceChange,
    token.stats24h?.priceChange
  ].some((value) => value === undefined || !Number.isFinite(value));
}

function preserveCategoryRanks(
  exact: JupiterMarketTokenSnapshot,
  category: JupiterMarketTokenSnapshot
): JupiterMarketTokenSnapshot {
  return { ...exact, categoryRanks: { ...category.categoryRanks } };
}

/** Converts one strict Jupiter Tokens V2 record without inventing missing
 * evidence. A -1 sentinel is rejected by the policy as missing. */
export function autonomousMarketSnapshotFromJupiter(
  token: JupiterMarketTokenSnapshot,
  capturedAt: string
): AutonomousPaperMarketSnapshot {
  const capturedMs = Date.parse(capturedAt);
  const bornAt = token.firstPoolAt ?? token.createdAt;
  const bornMs = bornAt ? Date.parse(bornAt) : Number.NaN;
  const tokenAgeDays = Number.isFinite(capturedMs) && Number.isFinite(bornMs) && capturedMs >= bornMs
    ? (capturedMs - bornMs) / 86_400_000
    : -1;
  const organic5m = organicVolume(token.stats5m);
  const organic1h = organicVolume(token.stats1h);
  const totalBuy1h = token.stats1h?.buyVolume;
  const totalSell1h = token.stats1h?.sellVolume;
  const volume24hUsd = token.stats24h?.buyVolume !== undefined &&
    token.stats24h.sellVolume !== undefined
    ? token.stats24h.buyVolume + token.stats24h.sellVolume
    : -1;

  return {
    capturedAt,
    sourceUpdatedAt: token.updatedAt,
    mint: token.mint,
    symbol: token.symbol,
    name: token.name,
    decimals: token.decimals,
    tokenProgram: token.tokenProgram,
    verified: token.verified,
    suspicious: token.suspicious,
    mintAuthorityDisabled: token.mintAuthorityDisabled,
    freezeAuthorityDisabled: token.freezeAuthorityDisabled,
    tokenAgeDays,
    priceUsd: finiteOrMissing(token.priceUsd),
    marketCapUsd: finiteOrMissing(token.marketCapUsd),
    fdvUsd: finiteOrMissing(token.fdvUsd),
    liquidityUsd: finiteOrMissing(token.liquidityUsd),
    liquidityChange1hPercent: finiteOrMissing(token.stats1h?.liquidityChange),
    volume24hUsd,
    holderCount: finiteOrMissing(token.holderCount),
    organicScore: finiteOrMissing(token.organicScore),
    topHoldersPercent: finiteOrMissing(token.topHoldersPercent),
    priceChange5mPercent: finiteOrMissing(token.stats5m?.priceChange),
    priceChange1hPercent: finiteOrMissing(token.stats1h?.priceChange),
    priceChange6hPercent: finiteOrMissing(token.stats6h?.priceChange),
    priceChange24hPercent: finiteOrMissing(token.stats24h?.priceChange),
    organicBuyShare5m: organicShare(token.stats5m),
    organicBuyShare1h: organicShare(token.stats1h),
    organicVolume5mUsd: organic5m,
    organicVolume1hUsd: organic1h,
    organicBuyers5m: finiteOrMissing(token.stats5m?.numOrganicBuyers),
    volumeAccelerationRatio: organic5m >= 0 && organic1h > 0 ? organic5m / organic1h : -1,
    buySellRatio: totalBuy1h !== undefined && totalSell1h !== undefined && totalSell1h > 0
      ? totalBuy1h / totalSell1h
      : -1,
    momentumScore: 0,
    categoryRanks: {
      ...(token.categoryRanks.topTraded24h !== undefined
        ? { topTraded24h: token.categoryRanks.topTraded24h }
        : {}),
      ...(token.categoryRanks.topTrending1h !== undefined
        ? { topTrending1h: token.categoryRanks.topTrending1h }
        : {}),
      ...(token.categoryRanks.topTraded1h !== undefined
        ? { topTraded1h: token.categoryRanks.topTraded1h }
        : {}),
      ...(token.categoryRanks.topOrganicScore5m !== undefined
        ? { topOrganicScore5m: token.categoryRanks.topOrganicScore5m }
        : {}),
      ...(token.categoryRanks.topOrganicScore1h !== undefined
        ? { topOrganicScore1h: token.categoryRanks.topOrganicScore1h }
        : {})
    }
  };
}

function excludedCategoryReasons(token: JupiterMarketTokenSnapshot): string[] {
  const reasons: string[] = [];
  if (token.mint === SOL_MINT) reasons.push("SOL_EXCLUDED");
  if (token.mint === USDC_MINT) reasons.push("USDC_EXCLUDED");
  const tags = token.tags.map((tag) => tag.trim().toLowerCase().replace(/[_ ]+/g, "-"));
  if (tags.some((tag) => tag === "stable" || tag.includes("stablecoin"))) {
    reasons.push("STABLECOIN_EXCLUDED");
  }
  if (tags.some((tag) => tag === "lst" || tag.includes("liquid-staking") || tag.includes("liquid-staked"))) {
    reasons.push("LST_EXCLUDED");
  }
  if (tags.some((tag) => tag === "stock" || tag === "stocks" || tag.includes("tokenized-stock"))) {
    reasons.push("STOCK_EXCLUDED");
  }
  return [...new Set(reasons)];
}

function quoteUsable(quote: QuoteSnapshot, request: QuoteRequest, now: Date): boolean {
  let positiveAtomic = false;
  try {
    positiveAtomic = BigInt(quote.inputAmountAtomic) > 0n &&
      BigInt(quote.outputAmountAtomic) > 0n &&
      BigInt(quote.minimumOutputAtomic) > 0n &&
      BigInt(quote.minimumOutputAtomic) <= BigInt(quote.outputAmountAtomic);
  } catch {
    return false;
  }
  const quotedAt = Date.parse(quote.quotedAt);
  const ageMs = now.getTime() - quotedAt;
  return positiveAtomic &&
    quote.inputMint === request.inputMint &&
    quote.outputMint === request.outputMint &&
    quote.inputAmountAtomic === request.inputAmountAtomic &&
    Number.isFinite(quotedAt) && ageMs >= -1_000 &&
    ageMs <= DEFAULT_RISK_POLICY.maximumQuoteAgeSeconds * 1_000 &&
    Number.isFinite(quote.inputUsd) && quote.inputUsd > 0 &&
    Number.isFinite(quote.outputUsd) && quote.outputUsd > 0 &&
    Number.isFinite(quote.priceImpactPercent) && quote.priceImpactPercent >= 0 &&
    Number.isFinite(quote.slippageBps) && quote.slippageBps >= 0 &&
    Number.isFinite(quote.feeBps) && quote.feeBps >= 0 &&
    Number.isFinite(quote.signatureFeeLamports) && quote.signatureFeeLamports >= 0 &&
    Number.isFinite(quote.prioritizationFeeLamports) && quote.prioritizationFeeLamports >= 0 &&
    Number.isFinite(quote.rentFeeLamports) && quote.rentFeeLamports >= 0 &&
    quote.transactionBase64 === undefined &&
    (!quote.expiresAt || Date.parse(quote.expiresAt) > now.getTime());
}

function sourceFresh(
  snapshot: AutonomousPaperMarketSnapshot,
  now: Date,
  scanIntervalMinutes: number
): boolean {
  const sourceAt = Date.parse(snapshot.sourceUpdatedAt);
  const ageMs = now.getTime() - sourceAt;
  return Number.isFinite(sourceAt) && ageMs >= -1_000 &&
    ageMs <= scanIntervalMinutes * 2 * 60_000;
}

function quoteLegsCoherent(
  buy: QuoteSnapshot,
  sell: QuoteSnapshot,
  now: Date,
  buyRequest: QuoteRequest,
  sellRequest: QuoteRequest
): boolean {
  if (!quoteUsable(buy, buyRequest, now) || !quoteUsable(sell, sellRequest, now)) return false;
  const buyAt = Date.parse(buy.quotedAt);
  const sellAt = Date.parse(sell.quotedAt);
  return Number.isFinite(buyAt) && Number.isFinite(sellAt) &&
    Math.abs(sellAt - buyAt) <= DEFAULT_RISK_POLICY.maximumQuoteAgeSeconds * 1_000;
}

function modeledQuoteFeeUsd(
  quote: QuoteSnapshot,
  solPriceUsd: number,
  conservativeInputUsd = quote.inputUsd
): number {
  if (!Number.isFinite(solPriceUsd) || solPriceUsd <= 0) {
    throw new Error("Autonomous PAPER requires a positive finite SOL price for modeled fees.");
  }
  const lamports = quote.signatureFeeLamports +
    quote.prioritizationFeeLamports +
    quote.rentFeeLamports;
  if (!Number.isFinite(conservativeInputUsd) || conservativeInputUsd <= 0) {
    throw new Error("Autonomous PAPER quote fee basis was invalid.");
  }
  const result = Math.max(quote.inputUsd, conservativeInputUsd) * quote.feeBps / 10_000 +
    lamports / LAMPORTS_PER_SOL * solPriceUsd;
  if (!Number.isFinite(result) || result < 0) {
    throw new Error("Autonomous PAPER quote fees were invalid.");
  }
  return result;
}

function guaranteedUsdcProceedsUsd(quote: QuoteSnapshot): number {
  if (quote.outputMint !== USDC_MINT) {
    throw new Error("Autonomous PAPER proceeds require a USDC output quote.");
  }
  let result: number;
  try {
    result = Number(BigInt(quote.minimumOutputAtomic)) / 10 ** USDC_DECIMALS;
  } catch {
    throw new Error("Autonomous PAPER USDC minimum output was invalid.");
  }
  if (!Number.isFinite(result) || result <= 0) {
    throw new Error("Autonomous PAPER USDC minimum output was invalid.");
  }
  return result;
}

function decision(
  lane: AutonomousPaperLane,
  action: AutonomousPaperDecision["action"],
  outcome: AutonomousPaperDecision["outcome"],
  snapshot: AutonomousPaperMarketSnapshot,
  reasons: string[],
  decidedAt: string,
  additions: Partial<Pick<AutonomousPaperDecision,
    "positionId" | "modeledPositionUsd" | "projectedRoundTripCostPercent" |
    "stressRoundTripCostPercent" | "sizing">> = {}
): AutonomousPaperDecision {
  const id = hashId("autonomous-decision-v1", lane.id, snapshot.mint, action, decidedAt);
  return {
    id,
    laneId: lane.id,
    action,
    outcome,
    mint: snapshot.mint,
    ...(snapshot.symbol ? { symbol: snapshot.symbol } : {}),
    score: snapshot.momentumScore,
    reasons: [...new Set(reasons)],
    snapshot,
    ...additions,
    decidedAt
  };
}

function claimForDecision(
  lane: AutonomousPaperLane,
  value: AutonomousPaperDecision,
  bucket: number,
  scope: string,
  kind: "DECISION" | "TRADE" = "DECISION"
): AutonomousPaperEvent {
  return {
    eventKey: hashId("autonomous-event-v1", lane.id, bucket, scope, value.mint, value.action),
    laneId: lane.id,
    kind,
    outcome: "CLAIMED",
    observedAt: value.decidedAt,
    mint: value.mint,
    action: value.action
  };
}

function terminal(
  claim: AutonomousPaperEvent,
  value: AutonomousPaperDecision,
  reason: string,
  finalizedAt: string,
  trade?: AutonomousPaperTrade
): AutonomousPaperEvent {
  return {
    ...claim,
    outcome: value.outcome,
    reason,
    decision: value,
    ...(trade ? { trade } : {}),
    finalizedAt
  };
}

function unpricedSnapshot(position: AutonomousPaperPosition, at: string): AutonomousPaperMarketSnapshot {
  return {
    capturedAt: at,
    sourceUpdatedAt: at,
    mint: position.mint,
    ...(position.symbol ? { symbol: position.symbol } : {}),
    decimals: 0,
    tokenProgram: "",
    verified: false,
    suspicious: true,
    mintAuthorityDisabled: false,
    freezeAuthorityDisabled: false,
    tokenAgeDays: -1,
    priceUsd: position.lastPriceUsd,
    marketCapUsd: -1,
    fdvUsd: -1,
    liquidityUsd: -1,
    liquidityChange1hPercent: -1,
    volume24hUsd: -1,
    holderCount: -1,
    organicScore: -1,
    topHoldersPercent: -1,
    priceChange5mPercent: -1,
    priceChange1hPercent: -1,
    priceChange6hPercent: -1,
    priceChange24hPercent: -1,
    organicBuyShare5m: -1,
    organicBuyShare1h: -1,
    organicVolume5mUsd: -1,
    organicVolume1hUsd: -1,
    organicBuyers5m: -1,
    volumeAccelerationRatio: -1,
    buySellRatio: -1,
    momentumScore: 0,
    categoryRanks: {}
  };
}

function recalculateAccount(
  previous: AutonomousPaperAccount,
  positions: readonly AutonomousPaperPosition[],
  additions: {
    cashUsd?: number;
    realizedPnlUsd?: number;
    completedTrades?: number;
    winningTrades?: number;
    grossProfitUsd?: number;
    grossLossUsd?: number;
    at: string;
  }
): AutonomousPaperAccount {
  const open = positions.filter((position) => position.status !== "CLOSED");
  const cashUsd = additions.cashUsd ?? previous.cashUsd;
  const realizedPnlUsd = additions.realizedPnlUsd ?? previous.realizedPnlUsd;
  const deployedUsd = open.reduce((sum, position) => sum + position.remainingCostUsd, 0);
  const executableValue = open.reduce((sum, position) => sum + position.lastExecutableValueUsd, 0);
  const navUsd = Math.max(0, cashUsd + executableValue);
  const pricingComplete = open.every((position) => position.status === "OPEN");
  const peakNavUsd = pricingComplete ? Math.max(previous.peakNavUsd, navUsd) : previous.peakNavUsd;
  const currentDrawdown = pricingComplete && peakNavUsd > 0
    ? (peakNavUsd - navUsd) / peakNavUsd * 100
    : 0;
  return {
    ...previous,
    cashUsd,
    navUsd,
    peakNavUsd,
    deployedUsd,
    realizedPnlUsd,
    unrealizedPnlUsd: executableValue - deployedUsd,
    maxDrawdownPercent: pricingComplete
      ? Math.max(previous.maxDrawdownPercent, currentDrawdown)
      : previous.maxDrawdownPercent,
    openPositions: open.length,
    completedTrades: additions.completedTrades ?? previous.completedTrades,
    winningTrades: additions.winningTrades ?? previous.winningTrades,
    grossProfitUsd: additions.grossProfitUsd ?? previous.grossProfitUsd,
    grossLossUsd: additions.grossLossUsd ?? previous.grossLossUsd,
    pricingComplete,
    updatedAt: additions.at
  };
}

function latestEntryModeledCost(
  repository: Repository,
  position: AutonomousPaperPosition
): number {
  const entry = repository.listAutonomousPaperEvents({
    laneId: position.laneId,
    mint: position.mint,
    kind: "DECISION",
    limit: 500
  }).map((event) => event.decision)
    .find((candidate) => candidate?.id === position.entryDecisionId);
  return Math.max(0, position.entryCostUsd - (entry?.modeledPositionUsd ?? position.entryCostUsd));
}

export class AutonomousPaperEngine {
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly repository: Repository,
    private readonly options: AutonomousPaperEngineOptions
  ) {}

  enqueueCycle(): Promise<void> {
    const task = this.tail.then(() => this.runCycle());
    this.tail = task.catch((error) => this.options.onError?.(
      error instanceof Error ? error : new Error("Autonomous PAPER cycle failed safely.")
    ));
    return task;
  }

  drain(): Promise<void> {
    return this.tail;
  }

  recoverInterruptedClaims(): number {
    const lane = this.repository.activeAutonomousPaperLane();
    if (!lane) return 0;
    const at = this.now().toISOString();
    let recovered = 0;
    for (const claim of this.repository.listClaimedAutonomousPaperEvents(lane.id)) {
      const dayStartNav = claim.kind === "NAV_MARK" &&
        claim.eventKey.startsWith("autonomous-day-start-v1:")
        ? this.repository.getAutonomousPaperAccount(lane.id)?.navUsd
        : undefined;
      const failed: AutonomousPaperEvent = {
        ...claim,
        outcome: "FAILED",
        reason: "Interrupted quote-only autonomous PAPER work was closed without changing inventory.",
        ...(dayStartNav !== undefined ? { navUsd: dayStartNav } : {}),
        finalizedAt: at
      };
      if (this.repository.finalizeAutonomousPaperEvent(failed)) recovered += 1;
    }
    return recovered;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private exactPaperLane(laneId: string): boolean {
    return this.options.mode() === "PAPER" &&
      this.repository.activeAutonomousPaperLane()?.id === laneId &&
      this.repository.getAutonomousPaperLane(laneId)?.status === "ACTIVE";
  }

  /** Operational entry authorization is intentionally separate from mode.
   * Treat a missing callback as legacy-compatible and a throwing callback as
   * fail-closed. */
  private newEntriesAllowed(): boolean {
    try {
      return this.options.newEntriesAllowed?.() ?? true;
    } catch {
      return false;
    }
  }

  /** A confirmed upgrade drain is a durable entry authorization boundary.
   * Existing inventory must keep using the frozen lane's normal mark/exit
   * policy, but no provider response that completes after the request may
   * create new simulated inventory. */
  private policyUpgradeDrainActive(laneId: string): boolean {
    return this.repository.autonomousPaperUpgradeDrainBlocksEntries(laneId);
  }

  private finalizePolicyUpgradeDrainCycle(
    lane: AutonomousPaperLane,
    rootClaim: AutonomousPaperEvent,
    account: AutonomousPaperAccount
  ): void {
    const finalAt = this.now().toISOString();
    const completed = this.repository.finalizeAutonomousPaperEvent({
      ...rootClaim,
      outcome: "SIMULATED",
      reason: "Policy-upgrade drain marked existing positions and paused all new entries without forced liquidation.",
      navUsd: account.navUsd,
      finalizedAt: finalAt
    });
    if (completed) {
      this.options.onUpdate?.({ laneId: lane.id, outcome: "UPGRADE_DRAIN_CYCLE_COMPLETED" });
    }
  }

  private replayEnabled(lane: AutonomousPaperLane): boolean {
    return supportsControlledExploration(lane.policyVersion) &&
      this.options.mode() === "PAPER";
  }

  private replayEpisodeForPosition(
    laneId: string,
    positionId: string
  ): AutonomousPaperReplayEpisode | undefined {
    return this.repository.listAutonomousPaperReplayEpisodes({ laneId, limit: 500 })
      .find((episode) => episode.positionId === positionId);
  }

  private replayAppendPoint(
    episode: AutonomousPaperReplayEpisode,
    candidateAt: string
  ): { sequence: number; observedAt: string } {
    const observations = this.repository.listAutonomousPaperReplayObservations(episode.id);
    const previousAt = observations.at(-1)?.observedAt;
    return {
      sequence: observations.length,
      observedAt: previousAt && Date.parse(candidateAt) <= Date.parse(previousAt)
        ? new Date(Date.parse(previousAt) + 1).toISOString()
        : candidateAt
    };
  }

  private replayExitEvidence(
    quote: QuoteSnapshot,
    inputAmountAtomic: string,
    modeledFeeUsd: number
  ): AutonomousPaperReplayExitEvidence {
    const guaranteedProceedsUsd = guaranteedUsdcProceedsUsd(quote);
    return {
      inputAmountAtomic,
      guaranteedProceedsUsd,
      modeledFeeUsd,
      executableValueUsd: Math.max(0, guaranteedProceedsUsd - modeledFeeUsd),
      priceImpactPercent: quote.priceImpactPercent,
      slippageBps: quote.slippageBps,
      quotedAt: quote.quotedAt
    };
  }

  private replayTradeForPosition(
    laneId: string,
    positionId: string
  ): AutonomousPaperTrade | undefined {
    return this.repository.listAutonomousPaperEvents({
      laneId,
      kind: "TRADE",
      limit: 500
    }).map((event) => event.trade)
      .find((trade): trade is AutonomousPaperTrade => trade?.positionId === positionId);
  }

  private replayReadyEpisode(episode: AutonomousPaperReplayEpisode): void {
    if (episode.status !== "READY") return;
    const position = this.repository.getAutonomousPaperPosition(episode.positionId);
    const trade = this.replayTradeForPosition(episode.laneId, episode.positionId);
    if (!position || !trade) return;
    const generatedAt = new Date(Math.max(
      this.now().getTime(),
      Date.parse(episode.completedAt ?? episode.updatedAt)
    )).toISOString();
    const built = buildAutonomousPaperReplayReport({
      episode,
      position,
      trade,
      observations: this.repository.listAutonomousPaperReplayObservations(episode.id),
      generatedAt
    });
    this.repository.saveAutonomousPaperReplayReport(built.report, built.results);
    this.options.onUpdate?.({
      laneId: episode.laneId,
      mint: episode.mint,
      outcome: "REPLAY_1000_COMPLETED"
    });
  }

  private replayCadenceIncompleteReason(
    lane: AutonomousPaperLane,
    observations: readonly Pick<PersistedAutonomousPaperReplayObservation, "observedAt">[],
    candidateAt?: string
  ): string | undefined {
    if (observations.length === 0) return "REPLAY_OBSERVATION_EVIDENCE_MISSING";
    const completePathGap = autonomousPaperReplayCadenceGap(
      observations,
      lane.policy.scanIntervalMinutes
    );
    const last = observations.at(-1)!;
    const candidateMs = candidateAt === undefined ? undefined : Date.parse(candidateAt);
    const lastMs = Date.parse(last.observedAt);
    if (!Number.isFinite(lastMs) || (candidateAt !== undefined && !Number.isFinite(candidateMs))) {
      return "REPLAY_OBSERVATION_TIMESTAMP_INVALID";
    }
    const trailingGap = !completePathGap && candidateAt !== undefined && candidateMs! > lastMs
      ? autonomousPaperReplayCadenceGap(
          [last, { observedAt: candidateAt }],
          lane.policy.scanIntervalMinutes
        )
      : undefined;
    const gap = completePathGap ?? trailingGap;
    return gap
      ? `OBSERVATION_CADENCE_GAP:${gap.previousObservedAt}:${gap.nextObservedAt}`
      : undefined;
  }

  private completeReplayIncomplete(
    episode: AutonomousPaperReplayEpisode,
    completedAt: string,
    incompleteReason: string
  ): void {
    this.repository.completeAutonomousPaperReplayEpisode(episode.id, {
      completedAt,
      incompleteReason
    });
    this.options.onUpdate?.({
      laneId: episode.laneId,
      mint: episode.mint,
      outcome: "REPLAY_CAPTURE_INCOMPLETE"
    });
  }

  private failAllCapturingReplayEpisodes(
    laneId: string,
    completedAt: string,
    incompleteReason: string
  ): void {
    for (;;) {
      const batch = this.repository.listAutonomousPaperReplayEpisodes({
        laneId,
        status: "CAPTURING",
        limit: AUTONOMOUS_PAPER_REPLAY_PROVIDER_WORK_HARD_CEILING
      });
      if (batch.length === 0) return;
      let completed = 0;
      for (const episode of batch) {
        try {
          this.completeReplayIncomplete(episode, completedAt, incompleteReason);
          completed += 1;
        } catch (error) {
          this.options.onError?.(error instanceof Error
            ? error
            : new Error("Autonomous replay capacity failure did not close safely."));
        }
      }
      // Avoid an infinite retry loop if durable storage rejects every terminal
      // transition. No provider work is attempted while this remains unresolved.
      if (completed === 0) return;
    }
  }

  /** Trading remains able to run without a daily entry ceiling, while replay
   * work stays provably finite. The engine can open at most one position per
   * scan and must honor the persisted minimum entry spacing, so the tighter of
   * the cadence-derived bound and any finite daily bound covers every path in
   * the three-hour replay horizon. An unexpectedly aggressive cadence still
   * fails replay closed without blocking the trading ledger. */
  private replayProviderWorkMaximum(lane: AutonomousPaperLane): number | undefined {
    const maximumEntriesPerUtcDay = lane.policy.maximumEntriesPerUtcDay;
    const maximumTouchedUtcDays =
      Math.ceil(AUTONOMOUS_PAPER_REPLAY_HORIZON_MINUTES / UTC_DAY_MINUTES) + 1;
    const dailyMaximum = maximumEntriesPerUtcDay * maximumTouchedUtcDays;
    const entryCadenceMinutes = Math.max(
      lane.policy.scanIntervalMinutes,
      lane.policy.minimumEntrySpacingMinutes
    );
    const cadenceMaximum = Math.floor(
      AUTONOMOUS_PAPER_REPLAY_HORIZON_MINUTES / entryCadenceMinutes
    ) + 2;
    const finiteDailyMaximum = Number.isSafeInteger(maximumEntriesPerUtcDay) &&
      maximumEntriesPerUtcDay > 0 && Number.isSafeInteger(dailyMaximum) && dailyMaximum > 0
      ? dailyMaximum
      : undefined;
    const maximum = finiteDailyMaximum === undefined
      ? cadenceMaximum
      : Math.min(cadenceMaximum, finiteDailyMaximum);
    return Number.isFinite(entryCadenceMinutes) && entryCadenceMinutes > 0 &&
      Number.isSafeInteger(maximum) && maximum > 0 &&
      maximum <= AUTONOMOUS_PAPER_REPLAY_PROVIDER_WORK_HARD_CEILING
      ? maximum
      : undefined;
  }

  private completeReplayIfHorizonReached(
    episode: AutonomousPaperReplayEpisode,
    at: string
  ): void {
    if (episode.status !== "CAPTURING" || Date.parse(at) < Date.parse(episode.horizonEndsAt)) {
      return;
    }
    const observations = this.repository.listAutonomousPaperReplayObservations(episode.id);
    const last = observations.at(-1);
    if (!last || Date.parse(last.observedAt) < Date.parse(episode.horizonEndsAt)) return;
    const lane = this.repository.getAutonomousPaperLane(episode.laneId);
    const cadenceReason = lane
      ? this.replayCadenceIncompleteReason(lane, observations)
      : undefined;
    if (!lane || cadenceReason) {
      this.completeReplayIncomplete(
        episode,
        at,
        !lane ? "REPLAY_LANE_EVIDENCE_MISSING" : cadenceReason!
      );
      return;
    }
    const actualExit = observations.some((observation) => observation.phase === "ACTUAL_EXIT");
    if (!actualExit) {
      const position = this.repository.getAutonomousPaperPosition(episode.positionId);
      if (position?.status === "CLOSED") {
        this.completeReplayIncomplete(episode, at, "ACTUAL_EXIT_EVIDENCE_MISSING");
      }
      return;
    }
    const ready = this.repository.completeAutonomousPaperReplayEpisode(episode.id, {
      completedAt: at
    });
    this.replayReadyEpisode(ready);
  }

  /** Auxiliary research tail. It runs only after the trading cycle commits and
   * never mutates the account/position/event ledger. Every causally valid path
   * is serviced; provider work is bounded by the frozen entry policy rather
   * than an oldest-first sampling cap that could silently starve later paths. */
  private async captureReplayFollowThrough(lane: AutonomousPaperLane): Promise<void> {
    if (!this.replayEnabled(lane) || !this.exactPaperLane(lane.id)) return;
    for (const ready of this.repository.listAutonomousPaperReplayEpisodes({
      laneId: lane.id,
      status: "READY",
      limit: 500
    })) {
      try {
        this.replayReadyEpisode(ready);
      } catch (error) {
        this.options.onError?.(error instanceof Error
          ? error
          : new Error("Autonomous replay report recovery failed safely."));
      }
    }

    const providerWorkMaximum = this.replayProviderWorkMaximum(lane);
    if (providerWorkMaximum === undefined) {
      const failedAt = this.now().toISOString();
      this.failAllCapturingReplayEpisodes(
        lane.id,
        failedAt,
        "REPLAY_CAPACITY_UNPROVEN"
      );
      this.options.onError?.(new Error(
        "Autonomous replay provider-work bound was not proven by the active policy; capture failed closed."
      ));
      return;
    }

    const episodes = this.repository.listAutonomousPaperReplayEpisodes({
      laneId: lane.id,
      status: "CAPTURING",
      limit: providerWorkMaximum + 1
    });
    const preflightAt = this.now().toISOString();
    const valid: Array<{
      episode: AutonomousPaperReplayEpisode;
      observations: PersistedAutonomousPaperReplayObservation[];
    }> = [];
    for (const episode of episodes) {
      try {
        const observations = this.repository.listAutonomousPaperReplayObservations(episode.id);
        const cadenceReason = this.replayCadenceIncompleteReason(
          lane,
          observations,
          preflightAt
        );
        if (cadenceReason) {
          this.completeReplayIncomplete(episode, preflightAt, cadenceReason);
          continue;
        }
        valid.push({ episode, observations });
      } catch (error) {
        this.options.onError?.(error instanceof Error
          ? error
          : new Error("Autonomous replay cadence preflight failed safely."));
      }
    }

    if (episodes.length > providerWorkMaximum) {
      const failedAt = this.now().toISOString();
      this.failAllCapturingReplayEpisodes(lane.id, failedAt, "REPLAY_CAPACITY_EXCEEDED");
      this.options.onError?.(new Error(
        `Autonomous replay capture found more than ${providerWorkMaximum} causally possible paths; capture failed closed.`
      ));
      return;
    }

    const due: Array<{
      episode: AutonomousPaperReplayEpisode;
      observations: PersistedAutonomousPaperReplayObservation[];
      position: AutonomousPaperPosition;
    }> = [];
    for (const candidate of valid.sort((left, right) =>
      Date.parse(left.observations.at(-1)!.observedAt) -
      Date.parse(right.observations.at(-1)!.observedAt) ||
      left.episode.id.localeCompare(right.episode.id)
    )) {
      const { episode } = candidate;
      try {
        const observations = this.repository.listAutonomousPaperReplayObservations(episode.id);
        const lookupAt = this.now().toISOString();
        const cadenceReason = this.replayCadenceIncompleteReason(lane, observations, lookupAt);
        if (cadenceReason) {
          this.completeReplayIncomplete(episode, lookupAt, cadenceReason);
          continue;
        }
        const actualExit = observations.find((observation) => observation.phase === "ACTUAL_EXIT");
        const position = this.repository.getAutonomousPaperPosition(episode.positionId);
        if (!position) {
          this.completeReplayIncomplete(episode, lookupAt, "REPLAY_POSITION_EVIDENCE_MISSING");
          continue;
        }
        if (!actualExit) {
          if (position.status === "CLOSED") {
            this.completeReplayIncomplete(episode, lookupAt, "ACTUAL_EXIT_EVIDENCE_MISSING");
          } else {
            // An open position receives MARK/UNPRICED evidence in the primary
            // cycle. It needs no duplicate provider tail observation.
            this.completeReplayIfHorizonReached(episode, lookupAt);
          }
          continue;
        }
        if (position.status !== "CLOSED") {
          this.completeReplayIncomplete(episode, lookupAt, "ACTUAL_EXIT_POSITION_STATE_MISMATCH");
          continue;
        }
        const previous = observations.at(-1)!;
        if (Date.parse(lookupAt) <= Date.parse(previous.observedAt)) continue;
        due.push({ episode, observations, position });
      } catch (error) {
        this.options.onError?.(error instanceof Error
          ? error
          : new Error("Autonomous replay follow-through preflight failed safely."));
      }
    }

    if (due.length === 0) return;
    if (due.length > providerWorkMaximum) {
      const failedAt = this.now().toISOString();
      this.failAllCapturingReplayEpisodes(
        lane.id,
        failedAt,
        "REPLAY_CAPACITY_EXCEEDED"
      );
      return;
    }

    // One exact lookup hydrates every due mint. This keeps market-data work at
    // one bounded provider call instead of N sequential lookups. Quote-only
    // sell probes remain sequential so each low-priority request rechecks the
    // strict signal tail before it enters the shared Jupiter start queue. A
    // wall-clock budget leaves the rest as explicit UNPRICED evidence instead
    // of allowing research work to delay the next trading scan.
    const uniqueMints = [...new Set(due.map(({ position }) => position.mint))];
    const lookupCapturedAt = this.now().toISOString();
    let tokensByMint = new Map<string, JupiterMarketTokenSnapshot>();
    let lookupFailureCode: string | undefined;
    try {
      const tokens = await this.options.lookupMints(uniqueMints);
      if (!this.exactPaperLane(lane.id)) return;
      tokensByMint = new Map(tokens.map((token) => [token.mint, token]));
    } catch {
      lookupFailureCode = "POST_EXIT_MARKET_LOOKUP_FAILED";
    }

    const quoteBudgetStartedAt = Date.now();
    const quoteBudgetMs = Math.max(
      1_000,
      lane.policy.scanIntervalMinutes * 60_000 *
        AUTONOMOUS_PAPER_REPLAY_QUOTE_BUDGET_PER_SCAN_FRACTION
    );
    const evidence: Array<{
      episode: AutonomousPaperReplayEpisode;
      observations: PersistedAutonomousPaperReplayObservation[];
      position: AutonomousPaperPosition;
      snapshot: AutonomousPaperMarketSnapshot | undefined;
      sellQuote: QuoteSnapshot | undefined;
      exitFee: number;
      failureCode: string | undefined;
      laneEnded: boolean;
    }> = [];
    for (const candidate of due) {
      const { position } = candidate;
      let snapshot: AutonomousPaperMarketSnapshot | undefined;
      let failureCode = lookupFailureCode;
      if (!failureCode) {
        try {
          const token = tokensByMint.get(position.mint);
          if (!token) throw new Error("POST_EXIT_MARKET_DATA_UNAVAILABLE");
          snapshot = autonomousMarketSnapshotFromJupiter(token, lookupCapturedAt);
          if (!sourceFresh(snapshot, this.now(), lane.policy.scanIntervalMinutes)) {
            throw new Error("POST_EXIT_MARKET_DATA_STALE");
          }
        } catch (error) {
          failureCode = error instanceof Error
            ? error.message
            : "POST_EXIT_MARKET_DATA_UNAVAILABLE";
        }
      }

      let sellQuote: QuoteSnapshot | undefined;
      let exitFee = 0;
      let laneEnded = false;
      if (snapshot && !failureCode) {
        const request: QuoteRequest = {
          inputMint: position.mint,
          outputMint: USDC_MINT,
          inputAmountAtomic: position.initialAmountAtomic
        };
        if (Date.now() - quoteBudgetStartedAt >= quoteBudgetMs) {
          failureCode = "POST_EXIT_QUOTE_BUDGET_EXHAUSTED";
        } else {
          try {
            sellQuote = await this.options.quote(request);
            const quoteAt = this.now();
            if (!this.exactPaperLane(lane.id)) {
              laneEnded = true;
            } else if (!quoteUsable(sellQuote, request, quoteAt) ||
                sellQuote.priceImpactPercent > lane.policy.maximumPriceImpactPercent) {
              throw new Error("POST_EXIT_QUOTE_FAILED_CEILINGS");
            } else {
              const guaranteed = guaranteedUsdcProceedsUsd(sellQuote);
              exitFee = modeledQuoteFeeUsd(sellQuote, this.options.solPriceUsd(), guaranteed);
            }
          } catch (error) {
            sellQuote = undefined;
            failureCode = error instanceof Error ? error.message : "POST_EXIT_QUOTE_UNAVAILABLE";
          }
        }
      }
      evidence.push({ ...candidate, snapshot, sellQuote, exitFee, failureCode, laneEnded });
    }
    if (!this.exactPaperLane(lane.id) || evidence.some((item) => item.laneEnded)) return;

    for (const item of evidence) {
      const { episode, observations, position, snapshot, sellQuote, exitFee, failureCode } = item;
      const observedAt = this.now().toISOString();
      try {
        const providerCadenceReason = this.replayCadenceIncompleteReason(
          lane,
          observations,
          observedAt
        );
        if (providerCadenceReason) {
          this.completeReplayIncomplete(episode, observedAt, providerCadenceReason);
          continue;
        }
        const observation: PersistedAutonomousPaperReplayObservation =
          snapshot && sellQuote && !failureCode
            ? executableAutonomousPaperReplayObservation({
                episode,
                sequence: observations.length,
                phase: "POST_EXIT",
                observedAt,
                sourceUpdatedAt: snapshot.sourceUpdatedAt,
                positionCostBasisUsd: position.entryCostUsd,
                snapshot,
                staticSafetyEligible: autonomousStaticAdmission(snapshot, lane.policy).eligible,
                signalEligible: false,
                exitEvidence: this.replayExitEvidence(
                  sellQuote,
                  position.initialAmountAtomic,
                  exitFee
                )
              })
            : unpricedAutonomousPaperReplayObservation({
                episode,
                sequence: observations.length,
                phase: "POST_EXIT",
                observedAt,
                sourceUpdatedAt: observedAt,
                positionCostBasisUsd: position.entryCostUsd,
                failureCode: failureCode ?? "POST_EXIT_EVIDENCE_UNAVAILABLE"
              });
        this.repository.appendAutonomousPaperReplayObservation(observation);
        this.completeReplayIfHorizonReached(episode, observedAt);
      } catch (error) {
        try {
          this.completeReplayIncomplete(
            episode,
            observedAt,
            "REPLAY_POST_EXIT_OBSERVATION_REJECTED"
          );
        } catch {
          // The original error remains the useful diagnostic when even the
          // terminal transition cannot be persisted.
        }
        this.options.onError?.(error instanceof Error
          ? error
          : new Error("Autonomous replay follow-through failed safely."));
      }
    }
  }

  /** Quote-only two-leg evidence for V5. No transaction payload is accepted,
   * and exact PAPER plus the active lane are rechecked after every provider
   * await. Ceiling enforcement is intentionally performed by the caller on
   * the final exact-size pair so a costly provisional probe can only downsize,
   * never authorize a larger position. */
  private async adaptiveRoundTripQuote(
    lane: AutonomousPaperLane,
    token: JupiterMarketTokenSnapshot,
    sizeUsd: number
  ): Promise<AdaptiveRoundTripEvidence> {
    if (!this.newEntriesAllowed()) {
      throw new Error("OPERATIONAL_ENTRY_PAUSE_ACTIVE");
    }
    if (this.policyUpgradeDrainActive(lane.id)) {
      throw new Error("POLICY_UPGRADE_DRAIN_ACTIVE");
    }
    if (!Number.isFinite(sizeUsd) || sizeUsd <= 0) {
      throw new Error("INVALID_ADAPTIVE_POSITION_SIZE");
    }
    const inputAmountAtomic = BigInt(Math.floor(sizeUsd * 10 ** USDC_DECIMALS)).toString();
    const buyRequest: QuoteRequest = {
      inputMint: USDC_MINT,
      outputMint: token.mint,
      inputAmountAtomic
    };
    const buy = await this.options.quote(buyRequest);
    if (!this.exactPaperLane(lane.id)) throw new Error("EXACT_PAPER_LANE_ENDED");
    if (!this.newEntriesAllowed()) {
      throw new Error("OPERATIONAL_ENTRY_PAUSE_ACTIVE");
    }
    if (this.policyUpgradeDrainActive(lane.id)) {
      throw new Error("POLICY_UPGRADE_DRAIN_ACTIVE");
    }
    if (!quoteUsable(buy, buyRequest, this.now())) {
      throw new Error("BUY_QUOTE_FAILED_CEILINGS");
    }
    const requestedUsd = Number(BigInt(inputAmountAtomic)) / 10 ** USDC_DECIMALS;
    const usdMetadataTolerance = Math.max(0.01, requestedUsd * 0.01);
    if (!Number.isFinite(requestedUsd) || requestedUsd <= 0 ||
        Math.abs(buy.inputUsd - requestedUsd) > usdMetadataTolerance) {
      throw new Error("BUY_QUOTE_USD_METADATA_MISMATCH");
    }
    const sellRequest: QuoteRequest = {
      inputMint: token.mint,
      outputMint: USDC_MINT,
      inputAmountAtomic: buy.minimumOutputAtomic
    };
    const sell = await this.options.quote(sellRequest);
    if (!this.exactPaperLane(lane.id)) throw new Error("EXACT_PAPER_LANE_ENDED");
    if (!this.newEntriesAllowed()) {
      throw new Error("OPERATIONAL_ENTRY_PAUSE_ACTIVE");
    }
    if (this.policyUpgradeDrainActive(lane.id)) {
      throw new Error("POLICY_UPGRADE_DRAIN_ACTIVE");
    }
    if (!quoteLegsCoherent(buy, sell, this.now(), buyRequest, sellRequest)) {
      throw new Error("SELL_QUOTE_FAILED_CEILINGS");
    }

    const solPrice = this.options.solPriceUsd();
    const guaranteedSellUsd = guaranteedUsdcProceedsUsd(sell);
    const buyFeeUsd = modeledQuoteFeeUsd(buy, solPrice, requestedUsd);
    const sellFeeUsd = modeledQuoteFeeUsd(sell, solPrice, guaranteedSellUsd);
    const executableRoundTripLoss = Math.max(0, requestedUsd - guaranteedSellUsd);
    const projectedCostPercent = (
      executableRoundTripLoss + buyFeeUsd + sellFeeUsd
    ) / requestedUsd * 100;
    const stressCostPercent = (
      executableRoundTripLoss +
      2 * (buyFeeUsd + sellFeeUsd) +
      requestedUsd * STRESS_ADVERSE_MOVE_FRACTION
    ) / requestedUsd * 100;
    if (!Number.isFinite(projectedCostPercent) || !Number.isFinite(stressCostPercent)) {
      throw new Error("INVALID_QUOTE_COST_EVIDENCE");
    }
    return {
      buy,
      sell,
      requestedUsd,
      guaranteedSellUsd,
      buyFeeUsd,
      sellFeeUsd,
      projectedCostPercent,
      stressCostPercent
    };
  }

  private async runCycle(): Promise<void> {
    const lane = this.repository.activeAutonomousPaperLane();
    if (!lane || lane.status !== "ACTIVE" || this.options.mode() !== "PAPER") return;
    const started = this.now();
    const at = started.toISOString();
    const bucket = cycleBucket(lane, started);
    const rootClaim: AutonomousPaperEvent = {
      eventKey: hashId("autonomous-cycle-v1", lane.id, bucket),
      laneId: lane.id,
      kind: "NAV_MARK",
      outcome: "CLAIMED",
      observedAt: at
    };
    if (!this.repository.claimAutonomousPaperEvent(rootClaim)) return;
    const candidateEvents: AutonomousPaperEvent[] = [];
    const flushCandidateEvents = (): void => {
      if (candidateEvents.length === 0) return;
      const pending = candidateEvents.splice(0, candidateEvents.length);
      try {
        this.repository.commitAutonomousPaperCandidateEvents(pending);
      } catch (error) {
        candidateEvents.unshift(...pending);
        throw error;
      }
    };

    try {
      let account = this.repository.getAutonomousPaperAccount(lane.id) ??
        this.repository.initializeAutonomousPaperAccount(lane.id, at);
      const dayStartNavUsd = this.ensureDayStartNav(lane, started, account.navUsd);

      account = await this.markOpenPositions(lane, account, bucket);
      if (!this.exactPaperLane(lane.id)) {
        this.repository.finalizeAutonomousPaperEvent({
          ...rootClaim,
          outcome: "FAILED",
          reason: "Exact PAPER mode or the active autonomous lane ended during marking.",
          finalizedAt: this.now().toISOString()
        });
        return;
      }

      // A requested policy upgrade never force-closes inventory. Marking and
      // normal exits above remain active, while this early return prevents a
      // new universe scan or entry attempt. The user explicitly retries the
      // upgrade after the account becomes flat.
      if (this.policyUpgradeDrainActive(lane.id)) {
        this.finalizePolicyUpgradeDrainCycle(lane, rootClaim, account);
        return;
      }

      // Freeze one lane-local learning sample for the whole cycle. Candidate
      // order and sizing must not depend on which candidate happens to be
      // evaluated first, nor on bounded dashboard history.
      const completedTrades = lane.policy.adaptiveSizingEnabled
        ? this.repository.listAutonomousPaperTradesForCalibration(
            lane.id,
            lane.policy.adaptiveSizingWindowTrades
          )
        : [];

      const universe = await this.options.fetchSignalUniverse();
      if (!this.exactPaperLane(lane.id)) {
        this.repository.finalizeAutonomousPaperEvent({
          ...rootClaim,
          outcome: "FAILED",
          reason: "Exact PAPER mode or the active autonomous lane ended during universe lookup.",
          finalizedAt: this.now().toISOString()
        });
        return;
      }
      if (this.policyUpgradeDrainActive(lane.id)) {
        this.finalizePolicyUpgradeDrainCycle(lane, rootClaim, account);
        return;
      }
      const categoryUniverse = universe.tokens.filter(hasCategoryRank);
      const hydrationCandidates = categoryUniverse
        .filter((token) => {
          const snapshot = autonomousMarketSnapshotFromJupiter(token, universe.capturedAt);
          return excludedCategoryReasons(token).length === 0 &&
            autonomousStaticAdmission(snapshot, lane.policy).eligible &&
            missingOrganicEvidence(token);
        })
        .sort((left, right) =>
          categoryRankCount(right.categoryRanks) - categoryRankCount(left.categoryRanks) ||
          categoryRankTotal(left.categoryRanks) - categoryRankTotal(right.categoryRanks) ||
          left.mint.localeCompare(right.mint)
        )
        .slice(0, MAXIMUM_EXACT_MINT_LOOKUP_SIZE);

      let solToken: JupiterMarketTokenSnapshot | undefined;
      try {
        solToken = (await this.options.lookupMints([SOL_MINT]))
          .find((token) => token.mint === SOL_MINT);
      } catch {
        solToken = undefined;
      }
      if (this.policyUpgradeDrainActive(lane.id)) {
        this.finalizePolicyUpgradeDrainCycle(lane, rootClaim, account);
        return;
      }
      const exactByMint = await this.lookupOptionalHydration(hydrationCandidates);

      // Provider awaits are an authorization boundary. A mode transition or
      // lane rotation while exact evidence is in flight must stop before any
      // ranking, candidate claim, quote, or simulated inventory mutation.
      if (!this.exactPaperLane(lane.id)) {
        this.repository.finalizeAutonomousPaperEvent({
          ...rootClaim,
          outcome: "FAILED",
          reason: "Exact PAPER mode or the active autonomous lane ended during exact-mint lookup.",
          finalizedAt: this.now().toISOString()
        });
        return;
      }
      if (this.policyUpgradeDrainActive(lane.id)) {
        this.finalizePolicyUpgradeDrainCycle(lane, rootClaim, account);
        return;
      }

      const hydratedUniverse = categoryUniverse.map((token) => {
        const exact = exactByMint.get(token.mint);
        return exact ? preserveCategoryRanks(exact, token) : token;
      });
      let sol: AutonomousPaperMarketSnapshot | undefined;
      if (solToken) {
        const candidate = autonomousMarketSnapshotFromJupiter(solToken, universe.capturedAt);
        if (sourceFresh(candidate, this.now(), lane.policy.scanIntervalMinutes)) sol = candidate;
      }

      try {
        await this.options.onUniverse?.({
          lane,
          universe,
          tokens: hydratedUniverse,
          ...(solToken ? { sol: solToken } : {})
        });
      } catch (error) {
        this.options.onError?.(error instanceof Error
          ? error
          : new Error("Autonomous learning universe handoff failed safely."));
      }

      const rankingAt = this.now();
      const ranked = hydratedUniverse.map((token) => {
        const snapshot = autonomousMarketSnapshotFromJupiter(token, universe.capturedAt);
        const staticEligible = excludedCategoryReasons(token).length === 0 &&
          autonomousStaticAdmission(snapshot, lane.policy).eligible &&
          sourceFresh(snapshot, rankingAt, lane.policy.scanIntervalMinutes);
        const momentum = sol
          ? autonomousMomentum(snapshot, sol, lane.policy)
          : { eligible: false, score: 0 };
        const normalEligible = staticEligible &&
          !missingMomentumEvidence(token) && momentum.eligible;
        const explorationEligible = supportsControlledExploration(lane.policyVersion) &&
          staticEligible && !missingMomentumEvidence(token) &&
          autonomousControlledExploration({
            eligible: momentum.eligible,
            score: momentum.score,
            reasons: "reasons" in momentum ? momentum.reasons : []
          }).eligible;
        const learningStrategy = supportsEvidenceLearning(lane.policyVersion)
          ? this.options.learningStrategy?.(token, universe.capturedAt, lane)
          : undefined;
        const learningStrategyEnabled = supportsEvidenceLearning(lane.policyVersion) &&
          this.options.learningStrategy !== undefined;
        const learningEligible = Boolean(
          learningStrategy && !learningStrategy.shadowOnly && learningStrategy.modelAllowed &&
          staticEligible && !missingMomentumEvidence(token)
        );
        const eligible = learningStrategyEnabled
          ? learningEligible
          : normalEligible || explorationEligible;
        const strategyArm: AutonomousPaperStrategyArm = learningStrategyEnabled
          ? learningStrategy?.arm ?? "MOMENTUM_CONTINUATION"
          : explorationEligible && !normalEligible
            ? "CONTROLLED_EXPLORATION"
            : "MOMENTUM";
        const waivedReasonCount = strategyArm === "CONTROLLED_EXPLORATION"
          ? Math.max(1, autonomousControlledExploration({
                eligible: momentum.eligible,
                score: momentum.score,
                reasons: "reasons" in momentum ? momentum.reasons : []
              }).waivedReasons.length)
          : 0;
        const sizing = eligible && lane.policy.adaptiveSizingEnabled
          ? autonomousAdaptiveEntrySize({
              account,
              snapshot: { ...snapshot, momentumScore: momentum.score },
              completedTrades,
              ...(supportsControlledExploration(lane.policyVersion)
                ? {
                    strategyArm,
                    waivedReasonCount,
                    ...(learningStrategy?.modelHighConviction
                      ? { modelHighConviction: true }
                      : {})
                  }
                : {}),
              policy: lane.policy
            })
          : undefined;
        return {
          token,
          sources: categoryRankCount(token.categoryRanks),
          eligible,
          normalEligible: learningStrategyEnabled
            ? learningEligible && strategyArm !== "CONTROLLED_EXPLORATION"
            : normalEligible,
          score: learningStrategy?.heuristicScore ?? momentum.score,
          conviction: sizing?.allowed ? sizing.breakdown.componentScores.conviction : 0,
          totalRank: categoryRankTotal(token.categoryRanks)
        };
      });
      const rankedUniverse = ranked.sort((left, right) => lane.policy.adaptiveSizingEnabled
        ? Number(right.eligible) - Number(left.eligible) ||
          Number(right.normalEligible) - Number(left.normalEligible) ||
          right.conviction - left.conviction ||
          right.sources - left.sources ||
          right.score - left.score ||
          left.totalRank - right.totalRank ||
          left.token.mint.localeCompare(right.token.mint)
        : right.sources - left.sources ||
          Number(right.eligible) - Number(left.eligible) ||
          right.score - left.score ||
          left.totalRank - right.totalRank ||
          left.token.mint.localeCompare(right.token.mint)
      ).map(({ token }) => token);
      const entryCadence = this.persistedEntryCadence(lane, started);

      let entered = false;
      for (const token of rankedUniverse) {
        const result = await this.evaluateCandidate({
          lane,
          account,
          token,
          ...(sol ? { sol } : {}),
          capturedAt: universe.capturedAt,
          bucket,
          entered,
          dayStartNavUsd,
          entryCadence,
          completedTrades,
          candidateEvents,
          flushCandidateEvents
        });
        account = result.account;
        entered ||= result.entered;

        // Rejection-heavy candidates are otherwise entirely synchronous. Give
        // Fastify and other localhost work one macrotask turn between every
        // ranked candidate without changing candidate order or evidence.
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (!this.exactPaperLane(lane.id)) {
          this.repository.finalizeAutonomousPaperEvent({
            ...rootClaim,
            outcome: "FAILED",
            reason: "Exact PAPER mode or the active autonomous lane ended during candidate scanning.",
            finalizedAt: this.now().toISOString()
          });
          return;
        }
        if (this.policyUpgradeDrainActive(lane.id)) {
          this.finalizePolicyUpgradeDrainCycle(lane, rootClaim, account);
          return;
        }
      }

      const finalAt = this.now().toISOString();
      if (!this.exactPaperLane(lane.id)) {
        this.repository.finalizeAutonomousPaperEvent({
          ...rootClaim,
          outcome: "FAILED",
          reason: "Exact PAPER mode or the active autonomous lane ended before cycle commit.",
          finalizedAt: finalAt
        });
        return;
      }
      flushCandidateEvents();
      const completed = this.repository.finalizeAutonomousPaperEvent({
        ...rootClaim,
        outcome: "SIMULATED",
        reason: "Autonomous PAPER cycle completed without any execution capability.",
        navUsd: account.navUsd,
        finalizedAt: finalAt
      });
      if (!completed) return;
      try {
        // One bounded transaction per completed cycle lets SQLite reuse the
        // retired rejection-detail pages without VACUUM while every material
        // BUY/SELL/failure/NAV/trade/claim row remains immutable.
        this.repository.compactAutonomousPaperCandidateDetails(lane.id);
      } catch (error) {
        // Compaction is atomic and auxiliary: a failure rolls back its rollup
        // and deletes, but must not rewrite a successfully completed cycle.
        this.options.onError?.(error instanceof Error
          ? error
          : new Error("Autonomous candidate detail compaction failed safely."));
      }
      this.options.onUpdate?.({ laneId: lane.id, outcome: "CYCLE_COMPLETED" });
    } catch (error) {
      this.repository.finalizeAutonomousPaperEvent({
        ...rootClaim,
        outcome: "FAILED",
        reason: error instanceof Error ? error.message : "Autonomous PAPER cycle failed safely.",
        finalizedAt: this.now().toISOString()
      });
      throw error;
    } finally {
      if (candidateEvents.length > 0) {
        try {
          // Each buffered event passed exact PAPER/lane authorization when it
          // was created. Flushing here preserves the former per-event behavior
          // across a later provider failure, early return, or mode transition,
          // while never masking the primary root outcome or thrown error.
          flushCandidateEvents();
        } catch (error) {
          this.options.onError?.(error instanceof Error
            ? error
            : new Error("Autonomous candidate decision batch failed safely."));
        }
      }
      // Replay is an isolated evidence tail, not part of the trading outcome.
      // It must run after every claimed cycle—including a provider-failed root
      // cycle—so a universe outage becomes an explicit UNPRICED sample rather
      // than a silent cadence hole. Its own failure cannot rewrite the root
      // event, account, positions, sizing, execution, or the original throw.
      try {
        await this.captureReplayFollowThrough(lane);
      } catch (error) {
        this.options.onError?.(error instanceof Error
          ? error
          : new Error("Autonomous replay tail failed safely after the trading cycle."));
      }
    }
  }

  private dayStartNav(laneId: string, now: Date, fallback: number): number {
    const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const marks = this.repository.listAutonomousPaperEvents({
      laneId,
      kind: "NAV_MARK",
      limit: 500
    }).filter((event) => event.outcome !== "CLAIMED" && event.navUsd !== undefined &&
      Date.parse(event.observedAt) >= dayStart)
      .sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt));
    return marks[0]?.navUsd ?? fallback;
  }

  private ensureDayStartNav(
    lane: AutonomousPaperLane,
    now: Date,
    fallback: number
  ): number {
    const dayStartMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const dayStartAt = new Date(dayStartMs).toISOString();
    const existing = this.repository.getAutonomousPaperEvent(
      hashId("autonomous-day-start-v1", lane.id, dayStartAt)
    );
    if (existing?.navUsd !== undefined && existing.outcome !== "CLAIMED") return existing.navUsd;

    const previous = this.repository.listAutonomousPaperEvents({
      laneId: lane.id,
      kind: "NAV_MARK",
      limit: 500
    }).find((event) => event.outcome !== "CLAIMED" && event.navUsd !== undefined &&
      Date.parse(event.observedAt) < dayStartMs);
    const baseline = previous?.navUsd ?? fallback;
    const claim: AutonomousPaperEvent = {
      eventKey: hashId("autonomous-day-start-v1", lane.id, dayStartAt),
      laneId: lane.id,
      kind: "NAV_MARK",
      outcome: "CLAIMED",
      observedAt: dayStartAt
    };
    if (this.repository.claimAutonomousPaperEvent(claim)) {
      this.repository.finalizeAutonomousPaperEvent({
        ...claim,
        outcome: "SIMULATED",
        reason: "Pre-cycle NAV frozen as the UTC-day entry-loss baseline.",
        navUsd: baseline,
        finalizedAt: now.toISOString()
      });
    }
    return this.dayStartNav(lane.id, now, baseline);
  }

  private async markOpenPositions(
    lane: AutonomousPaperLane,
    initialAccount: AutonomousPaperAccount,
    bucket: number
  ): Promise<AutonomousPaperAccount> {
    let account = initialAccount;
    const positions = this.repository.listAutonomousPaperPositions({
      laneId: lane.id,
      openOnly: true,
      limit: 500
    });
    for (const persisted of positions) {
      const decidedAt = this.now().toISOString();
      let snapshot: AutonomousPaperMarketSnapshot;
      try {
        const token = (await this.options.lookupMints([persisted.mint]))[0];
        if (!token) throw new Error("Exact mint lookup omitted an open position.");
        snapshot = autonomousMarketSnapshotFromJupiter(token, decidedAt);
        if (!sourceFresh(snapshot, this.now(), lane.policy.scanIntervalMinutes)) {
          throw new Error("Open-position market snapshot was stale or future-dated.");
        }
      } catch {
        snapshot = unpricedSnapshot(persisted, decidedAt);
        account = this.commitUnpriced(lane, persisted, snapshot, account, bucket, "MARKET_DATA_UNAVAILABLE");
        continue;
      }

      const request: QuoteRequest = {
        inputMint: persisted.mint,
        outputMint: USDC_MINT,
        inputAmountAtomic: persisted.remainingAmountAtomic
      };
      let sellQuote: QuoteSnapshot;
      try {
        sellQuote = await this.options.quote(request);
      } catch {
        account = this.commitUnpriced(lane, persisted, snapshot, account, bucket, "SELL_QUOTE_UNAVAILABLE");
        continue;
      }
      const quoteAt = this.now();
      if (!this.exactPaperLane(lane.id)) return account;
      if (!quoteUsable(sellQuote, request, quoteAt) ||
          sellQuote.priceImpactPercent > lane.policy.maximumPriceImpactPercent) {
        account = this.commitUnpriced(lane, persisted, snapshot, account, bucket, "SELL_QUOTE_FAILED_CEILINGS");
        continue;
      }

      const guaranteedProceeds = guaranteedUsdcProceedsUsd(sellQuote);
      const exitFee = modeledQuoteFeeUsd(
        sellQuote,
        this.options.solPriceUsd(),
        guaranteedProceeds
      );
      const executableValue = Math.max(0, guaranteedProceeds - exitFee);
      const peak = Math.max(persisted.peakExecutableValueUsd, executableValue);
      const peakReturn = persisted.remainingCostUsd > 0
        ? (peak / persisted.remainingCostUsd - 1) * 100
        : 0;
      const marked: AutonomousPaperPosition = {
        ...persisted,
        lastExecutableValueUsd: executableValue,
        peakExecutableValueUsd: peak,
        lastPriceUsd: snapshot.priceUsd > 0 ? snapshot.priceUsd : persisted.lastPriceUsd,
        ...(peakReturn >= lane.policy.breakEvenActivationPercent
          ? { breakEvenPriceUsd: persisted.entryPriceUsd }
          : {}),
        ...(peakReturn >= lane.policy.trailingActivationPercent
          ? {
              trailingStopPriceUsd: Math.max(
                persisted.trailingStopPriceUsd ?? 0,
                (snapshot.priceUsd > 0 ? snapshot.priceUsd : persisted.lastPriceUsd) *
                  (1 - lane.policy.trailingDrawdownPercent / 100)
              )
            }
          : {}),
        status: "OPEN",
        updatedAt: quoteAt.toISOString()
      };
      const safety = autonomousStaticAdmission(snapshot, lane.policy);
      const exit = autonomousExitDecision({
        position: marked,
        snapshot,
        staticSafetyEligible: safety.eligible,
        now: quoteAt,
        policy: lane.policy
      });
      marked.weakMomentumSamples = exit.nextWeakMomentumSamples;

      if (exit.exit && exit.reason) {
        account = this.commitExit(lane, marked, snapshot, sellQuote, exitFee, exit.reason, account, bucket);
      } else {
        const value = decision(
          lane,
          "OBSERVE",
          "ANALYSIS_ONLY",
          snapshot,
          ["POSITION_MARKED", ...safety.reasons],
          marked.updatedAt,
          { positionId: marked.id }
        );
        const claim = claimForDecision(lane, value, bucket, `mark:${marked.id}`);
        if (!this.repository.claimAutonomousPaperEvent(claim)) continue;
        const all = this.replacePosition(lane.id, marked);
        const next = recalculateAccount(account, all, { at: marked.updatedAt });
        const replayEpisode = this.replayEnabled(lane)
          ? this.replayEpisodeForPosition(lane.id, marked.id)
          : undefined;
        const replay = replayEpisode?.status === "CAPTURING"
          ? (() => {
              const point = this.replayAppendPoint(replayEpisode, marked.updatedAt);
              return {
                observation: executableAutonomousPaperReplayObservation({
                  episode: replayEpisode,
                  ...point,
                  phase: "MARK",
                  sourceUpdatedAt: snapshot.sourceUpdatedAt,
                  positionCostBasisUsd: marked.remainingCostUsd,
                  snapshot,
                  staticSafetyEligible: safety.eligible,
                  signalEligible: false,
                  exitEvidence: this.replayExitEvidence(
                    sellQuote,
                    marked.remainingAmountAtomic,
                    exitFee
                  )
                })
              };
            })()
          : undefined;
        if (this.repository.commitAutonomousPaperEvent({
          event: terminal(claim, value, "Open position marked from an exact full-position sell quote.", marked.updatedAt),
          account: next,
          positions: [marked],
          ...(replay ? { replay } : {})
        })) account = next;
      }
    }
    return account;
  }

  private commitUnpriced(
    lane: AutonomousPaperLane,
    persisted: AutonomousPaperPosition,
    snapshot: AutonomousPaperMarketSnapshot,
    account: AutonomousPaperAccount,
    bucket: number,
    reason: string
  ): AutonomousPaperAccount {
    if (!this.exactPaperLane(lane.id)) return account;
    const at = this.now().toISOString();
    const unpriced: AutonomousPaperPosition = { ...persisted, status: "UNPRICED", updatedAt: at };
    const value = decision(lane, "OBSERVE", "FAILED", snapshot, [reason], at, { positionId: persisted.id });
    const claim = claimForDecision(lane, value, bucket, `mark:${persisted.id}`);
    if (!this.repository.claimAutonomousPaperEvent(claim)) return account;
    const all = this.replacePosition(lane.id, unpriced);
    const next = recalculateAccount(account, all, { at });
    const replayEpisode = this.replayEnabled(lane)
      ? this.replayEpisodeForPosition(lane.id, persisted.id)
      : undefined;
    const replay = replayEpisode?.status === "CAPTURING"
      ? {
          observation: unpricedAutonomousPaperReplayObservation({
            episode: replayEpisode,
            ...this.replayAppendPoint(replayEpisode, at),
            phase: "MARK",
            sourceUpdatedAt: snapshot.sourceUpdatedAt,
            positionCostBasisUsd: persisted.remainingCostUsd,
            failureCode: reason
          })
        }
      : undefined;
    return this.repository.commitAutonomousPaperEvent({
      event: terminal(claim, value, reason, at),
      account: next,
      positions: [unpriced],
      ...(replay ? { replay } : {})
    }) ? next : account;
  }

  private commitExit(
    lane: AutonomousPaperLane,
    marked: AutonomousPaperPosition,
    snapshot: AutonomousPaperMarketSnapshot,
    sellQuote: QuoteSnapshot,
    exitFee: number,
    exitReason: AutonomousPaperExitReason,
    account: AutonomousPaperAccount,
    bucket: number
  ): AutonomousPaperAccount {
    if (!this.exactPaperLane(lane.id)) return account;
    const at = this.now().toISOString();
    const proceedsUsd = Math.max(0, guaranteedUsdcProceedsUsd(sellQuote) - exitFee);
    const pnlUsd = proceedsUsd - marked.remainingCostUsd;
    const closed: AutonomousPaperPosition = {
      ...marked,
      remainingAmountAtomic: "0",
      remainingCostUsd: 0,
      lastExecutableValueUsd: 0,
      status: "CLOSED",
      updatedAt: at,
      closedAt: at
    };
    const value = decision(
      lane,
      "SELL",
      "SIMULATED",
      snapshot,
      [exitReason],
      at,
      { positionId: marked.id }
    );
    const trade: AutonomousPaperTrade = {
      id: hashId("autonomous-trade-v1", lane.id, marked.id, value.id),
      laneId: lane.id,
      positionId: marked.id,
      entryDecisionId: marked.entryDecisionId,
      exitDecisionId: value.id,
      mint: marked.mint,
      ...(marked.symbol ? { symbol: marked.symbol } : {}),
      exitReason,
      openedAt: marked.openedAt,
      closedAt: at,
      proceedsUsd,
      costBasisUsd: marked.remainingCostUsd,
      modeledCostsUsd: latestEntryModeledCost(this.repository, marked) + exitFee,
      pnlUsd,
      returnPercent: marked.remainingCostUsd > 0 ? pnlUsd / marked.remainingCostUsd * 100 : 0,
      ...(marked.entryLearningContext
        ? { entryLearningContext: { ...marked.entryLearningContext } }
        : {})
    };
    const claim = claimForDecision(lane, value, bucket, `exit:${marked.id}`, "TRADE");
    if (!this.repository.claimAutonomousPaperEvent(claim)) return account;
    const all = this.replacePosition(lane.id, closed);
    const next = recalculateAccount(account, all, {
      cashUsd: account.cashUsd + proceedsUsd,
      realizedPnlUsd: account.realizedPnlUsd + pnlUsd,
      completedTrades: account.completedTrades + 1,
      winningTrades: account.winningTrades + (pnlUsd > 0 ? 1 : 0),
      grossProfitUsd: account.grossProfitUsd + Math.max(0, pnlUsd),
      grossLossUsd: account.grossLossUsd + Math.max(0, -pnlUsd),
      at
    });
    const replayEpisode = this.replayEnabled(lane)
      ? this.replayEpisodeForPosition(lane.id, marked.id)
      : undefined;
    const replay = replayEpisode?.status === "CAPTURING"
      ? {
          observation: executableAutonomousPaperReplayObservation({
            episode: replayEpisode,
            ...this.replayAppendPoint(replayEpisode, at),
            phase: "ACTUAL_EXIT",
            sourceUpdatedAt: snapshot.sourceUpdatedAt,
            positionCostBasisUsd: marked.remainingCostUsd,
            snapshot,
            staticSafetyEligible: autonomousStaticAdmission(snapshot, lane.policy).eligible,
            signalEligible: false,
            exitEvidence: this.replayExitEvidence(
              sellQuote,
              marked.remainingAmountAtomic,
              exitFee
            )
          })
        }
      : undefined;
    if (this.repository.commitAutonomousPaperEvent({
      event: terminal(claim, value, exitReason, at, trade),
      account: next,
      positions: [closed],
      ...(replay ? { replay } : {})
    })) {
      this.options.onUpdate?.({ laneId: lane.id, mint: marked.mint, outcome: "SELL_SIMULATED" });
      return next;
    }
    return account;
  }

  private async simulateAdaptiveEntry(input: {
    lane: AutonomousPaperLane;
    account: AutonomousPaperAccount;
    token: JupiterMarketTokenSnapshot;
    snapshot: AutonomousPaperMarketSnapshot;
    completedTrades: readonly AutonomousPaperTrade[];
    bucket: number;
    strategyArm?: AutonomousPaperStrategyArm;
    waivedReasonCount?: number;
    modelHighConviction?: boolean;
    strategyReasons?: readonly string[];
    minimumExpectedEdgePercent?: number;
    candidateEvents: AutonomousPaperEvent[];
    flushCandidateEvents: () => void;
  }): Promise<{ account: AutonomousPaperAccount; entered: boolean }> {
    const { lane, account, token, snapshot, bucket } = input;
    const cluster = developerCluster(token);
    const clusterDeployedUsd = this.repository.listAutonomousPaperPositions({
      laneId: lane.id,
      openOnly: true,
      limit: 500
    }).filter((position) => (position.developerCluster ?? `mint:${position.mint}`) === cluster)
      .reduce((sum, position) => sum + position.remainingCostUsd, 0);
    if (this.policyUpgradeDrainActive(lane.id)) {
      this.storeCandidateDecision(
        lane,
        snapshot,
        "REJECT",
        "REJECTED",
        ["POLICY_UPGRADE_DRAIN_ACTIVE"],
        bucket,
        input.candidateEvents,
        input.flushCandidateEvents
      );
      return { account, entered: false };
    }
    if (!this.newEntriesAllowed()) {
      this.storeCandidateDecision(
        lane,
        snapshot,
        "REJECT",
        "REJECTED",
        ["OPERATIONAL_ENTRY_PAUSE_ACTIVE"],
        bucket,
        input.candidateEvents,
        input.flushCandidateEvents
      );
      return { account, entered: false };
    }
    const preliminary = autonomousAdaptiveEntrySize({
      account,
      snapshot,
      completedTrades: input.completedTrades,
      ...(input.strategyArm ? { strategyArm: input.strategyArm } : {}),
      ...(input.waivedReasonCount !== undefined
        ? { waivedReasonCount: input.waivedReasonCount }
        : {}),
      ...(input.modelHighConviction !== undefined
        ? { modelHighConviction: input.modelHighConviction }
        : {}),
      clusterDeployedUsd,
      policy: lane.policy
    });
    if (!preliminary.allowed) {
      this.storeCandidateDecision(
        lane,
        snapshot,
        "REJECT",
        "REJECTED",
        [preliminary.reason],
        bucket,
        input.candidateEvents,
        input.flushCandidateEvents
      );
      return { account, entered: false };
    }

    // Preserve every earlier auxiliary decision before the material BUY claim
    // crosses a provider await/crash boundary. This is normally a no-op because
    // eligible candidates sort first, but retains exact prior durability when
    // a later candidate becomes quoteable.
    input.flushCandidateEvents();
    const decidedAt = this.now().toISOString();
    const provisional = decision(
      lane,
      "BUY",
      "FAILED",
      snapshot,
      ["ADAPTIVE_QUOTE_PENDING"],
      decidedAt,
      { modeledPositionUsd: preliminary.sizeUsd, sizing: preliminary.breakdown }
    );
    const claim = claimForDecision(lane, provisional, bucket, `candidate:${token.mint}`);
    if (!this.repository.claimAutonomousPaperEvent(claim)) {
      return { account, entered: false };
    }

    let recordedSizing: AutonomousPaperSizingBreakdown = preliminary.breakdown;
    try {
      const probe = await this.adaptiveRoundTripQuote(lane, token, preliminary.sizeUsd);
      const finalized = autonomousAdaptiveEntrySize({
        account,
        snapshot,
        completedTrades: input.completedTrades,
        ...(input.strategyArm ? { strategyArm: input.strategyArm } : {}),
        ...(input.waivedReasonCount !== undefined
          ? { waivedReasonCount: input.waivedReasonCount }
          : {}),
        ...(input.modelHighConviction !== undefined
          ? { modelHighConviction: input.modelHighConviction }
          : {}),
        clusterDeployedUsd,
        quote: {
          projectedRoundTripCostPercent: probe.projectedCostPercent,
          buyPriceImpactPercent: probe.buy.priceImpactPercent,
          sellPriceImpactPercent: probe.sell.priceImpactPercent
        },
        policy: lane.policy
      });
      if (!finalized.allowed) throw new Error(finalized.reason);
      if (finalized.sizeUsd > preliminary.sizeUsd + 1e-9) {
        throw new Error("ADAPTIVE_SIZE_INCREASED_AFTER_QUOTE");
      }
      recordedSizing = finalized.breakdown;

      // The probe may only reduce the position. When it does, the final pair
      // is fetched for that exact USDC amount and exact guaranteed token output;
      // no provisional route or amount is ever committed as fill evidence.
      const evidence = finalized.sizeUsd + 1e-9 < probe.requestedUsd
        ? await this.adaptiveRoundTripQuote(lane, token, finalized.sizeUsd)
        : probe;
      if (Math.abs(evidence.requestedUsd - finalized.sizeUsd) > 1e-9) {
        throw new Error("FINAL_ADAPTIVE_QUOTE_SIZE_MISMATCH");
      }
      const maximumImpact = usesStrictEvidenceQuotes(lane.policyVersion)
        ? 0.35
        : lane.policy.maximumPriceImpactPercent;
      const maximumCost = usesStrictEvidenceQuotes(lane.policyVersion)
        ? 0.75
        : lane.policy.maximumRoundTripCostPercent;
      if (
        evidence.buy.priceImpactPercent > maximumImpact ||
        evidence.sell.priceImpactPercent > maximumImpact
      ) throw new Error("FINAL_QUOTE_PRICE_IMPACT_TOO_HIGH");
      if (evidence.projectedCostPercent > maximumCost) {
        throw new Error("ROUND_TRIP_COST_TOO_HIGH");
      }
      if (
        usesStrictEvidenceQuotes(lane.policyVersion) &&
        (input.minimumExpectedEdgePercent === undefined ||
          input.minimumExpectedEdgePercent <= 2 * evidence.projectedCostPercent)
      ) throw new Error("EXPECTED_EDGE_DOES_NOT_COVER_TWICE_COST");
      if (!this.exactPaperLane(lane.id)) throw new Error("EXACT_PAPER_LANE_ENDED");
      if (!this.newEntriesAllowed()) {
        throw new Error("OPERATIONAL_ENTRY_PAUSE_ACTIVE");
      }
      if (this.policyUpgradeDrainActive(lane.id)) {
        throw new Error("POLICY_UPGRADE_DRAIN_ACTIVE");
      }

      const entryCostUsd = evidence.requestedUsd + evidence.buyFeeUsd;
      if (account.cashUsd - entryCostUsd < lane.policy.minimumLiquidReserveUsd - 1e-9 ||
          account.deployedUsd + entryCostUsd >
            account.navUsd * lane.policy.maximumDeployedFraction + 1e-9) {
        throw new Error("MODELED_FEES_EXCEED_CAPITAL_LIMIT");
      }
      const amountUi = Number(BigInt(evidence.buy.minimumOutputAtomic)) / 10 ** token.decimals;
      if (!Number.isFinite(amountUi) || amountUi <= 0) {
        throw new Error("INVALID_QUOTED_TOKEN_AMOUNT");
      }
      const entryPriceUsd = entryCostUsd / amountUi;
      const positionId = hashId("autonomous-position-v1", lane.id, token.mint, decidedAt);
      const openedAt = this.replayEnabled(lane)
        ? new Date(Math.max(
            this.now().getTime(),
            Date.parse(evidence.buy.quotedAt),
            Date.parse(evidence.sell.quotedAt)
          )).toISOString()
        : decidedAt;
      const entryLearningContext =
        lane.policy.contextualRewardEnabled
          ? input.strategyArm
            ? autonomousPaperLearningContext(
                recordedSizing,
                evidence.projectedCostPercent,
                input.strategyArm,
                input.waivedReasonCount ?? 0
              )
            : autonomousPaperLearningContext(recordedSizing, evidence.projectedCostPercent)
          : undefined;
      const successful = decision(
        lane,
        "BUY",
        "SIMULATED",
        snapshot,
        [
          "AGGRESSIVE_SINGLE_SNAPSHOT",
          "ADAPTIVE_HIGH_RISK_SIZE",
          ...(input.strategyReasons ?? []),
          "QUOTE_CEILINGS_PASSED"
        ],
        decidedAt,
        {
          positionId,
          modeledPositionUsd: evidence.requestedUsd,
          projectedRoundTripCostPercent: evidence.projectedCostPercent,
          stressRoundTripCostPercent: evidence.stressCostPercent,
          sizing: recordedSizing
        }
      );
      const executableValueUsd = Math.max(0, evidence.guaranteedSellUsd - evidence.sellFeeUsd);
      const position: AutonomousPaperPosition = {
        id: positionId,
        laneId: lane.id,
        entryDecisionId: successful.id,
        mint: token.mint,
        ...(token.symbol ? { symbol: token.symbol } : {}),
        developerCluster: cluster,
        initialAmountAtomic: evidence.buy.minimumOutputAtomic,
        remainingAmountAtomic: evidence.buy.minimumOutputAtomic,
        entryCostUsd,
        remainingCostUsd: entryCostUsd,
        lastExecutableValueUsd: executableValueUsd,
        peakExecutableValueUsd: executableValueUsd,
        entryPriceUsd,
        lastPriceUsd: snapshot.priceUsd,
        stopPriceUsd: entryPriceUsd * (1 - lane.policy.stopLossPercent / 100),
        takeProfitPriceUsd: entryPriceUsd * (1 + lane.policy.takeProfitPercent / 100),
        weakMomentumSamples: 0,
        ...(entryLearningContext ? { entryLearningContext } : {}),
        status: "OPEN",
        openedAt,
        updatedAt: openedAt
      };
      const all = this.replacePosition(lane.id, position);
      const next = recalculateAccount(account, all, {
        cashUsd: account.cashUsd - entryCostUsd,
        at: openedAt
      });
      const replay = this.replayEnabled(lane)
        ? (() => {
            const episode = newAutonomousPaperReplayEpisode(lane, position);
            return {
              episode,
              observation: executableAutonomousPaperReplayObservation({
                episode,
                sequence: 0,
                phase: "ENTRY",
                observedAt: openedAt,
                sourceUpdatedAt: snapshot.sourceUpdatedAt,
                positionCostBasisUsd: entryCostUsd,
                snapshot,
                staticSafetyEligible: true,
                signalEligible: true,
                entryEvidence: {
                  inputUsd: evidence.requestedUsd,
                  outputAmountAtomic: evidence.buy.minimumOutputAtomic,
                  modeledFeeUsd: evidence.buyFeeUsd,
                  totalCostUsd: entryCostUsd,
                  priceImpactPercent: evidence.buy.priceImpactPercent,
                  slippageBps: evidence.buy.slippageBps,
                  projectedRoundTripCostPercent: evidence.projectedCostPercent,
                  quotedAt: evidence.buy.quotedAt
                },
                exitEvidence: this.replayExitEvidence(
                  evidence.sell,
                  evidence.buy.minimumOutputAtomic,
                  evidence.sellFeeUsd
                )
              })
            };
          })()
        : undefined;
      const committed = this.repository.commitAutonomousPaperEvent({
        event: terminal(claim, successful, "Adaptive quote-only PAPER entry simulated.", openedAt),
        account: next,
        positions: [position],
        ...(replay ? { replay } : {})
      });
      if (!committed) return { account, entered: false };
      this.options.onUpdate?.({ laneId: lane.id, mint: token.mint, outcome: "BUY_SIMULATED" });
      return { account: next, entered: true };
    } catch (error) {
      const reason = error instanceof Error ? error.message : "QUOTE_FAILED";
      const failed = decision(
        lane,
        "BUY",
        "FAILED",
        snapshot,
        [reason],
        decidedAt,
        {
          modeledPositionUsd: recordedSizing.sizeUsd,
          sizing: recordedSizing
        }
      );
      this.repository.finalizeAutonomousPaperEvent(
        terminal(claim, failed, reason, this.now().toISOString())
      );
      return { account, entered: false };
    }
  }

  private async evaluateCandidate(input: {
    lane: AutonomousPaperLane;
    account: AutonomousPaperAccount;
    token: JupiterMarketTokenSnapshot;
    sol?: AutonomousPaperMarketSnapshot;
    capturedAt: string;
    bucket: number;
    entered: boolean;
    dayStartNavUsd: number;
    entryCadence: PersistedEntryCadence;
    completedTrades: readonly AutonomousPaperTrade[];
    candidateEvents: AutonomousPaperEvent[];
    flushCandidateEvents: () => void;
  }): Promise<{ account: AutonomousPaperAccount; entered: boolean }> {
    const { lane, token, bucket } = input;
    let snapshot = autonomousMarketSnapshotFromJupiter(token, input.capturedAt);
    if (this.policyUpgradeDrainActive(lane.id)) {
      this.storeCandidateDecision(
        lane,
        snapshot,
        "REJECT",
        "REJECTED",
        ["POLICY_UPGRADE_DRAIN_ACTIVE"],
        bucket,
        input.candidateEvents,
        input.flushCandidateEvents
      );
      return { account: input.account, entered: false };
    }
    if (!this.newEntriesAllowed()) {
      this.storeCandidateDecision(
        lane,
        snapshot,
        "REJECT",
        "REJECTED",
        ["OPERATIONAL_ENTRY_PAUSE_ACTIVE"],
        bucket,
        input.candidateEvents,
        input.flushCandidateEvents
      );
      return { account: input.account, entered: false };
    }
    const excluded = excludedCategoryReasons(token);
    const staticAdmission = autonomousStaticAdmission(snapshot, lane.policy);
    const momentum = input.sol
      ? autonomousMomentum(snapshot, input.sol, lane.policy)
      : { eligible: false, score: 0, reasons: ["SOL_REGIME_UNAVAILABLE"] };
    const exploration = supportsControlledExploration(lane.policyVersion)
      ? autonomousControlledExploration(momentum)
      : undefined;
    const learningStrategy = supportsEvidenceLearning(lane.policyVersion)
      ? this.options.learningStrategy?.(token, input.capturedAt, lane)
      : undefined;
    const learningStrategyEnabled = supportsEvidenceLearning(lane.policyVersion) &&
      this.options.learningStrategy !== undefined;
    const controlledExploration = learningStrategyEnabled
      ? learningStrategy?.arm === "CONTROLLED_EXPLORATION" &&
        !learningStrategy.shadowOnly && learningStrategy.modelAllowed
      : Boolean(
          exploration?.eligible &&
          excluded.length === 0 &&
          staticAdmission.eligible &&
          !missingMomentumEvidence(token)
        );
    snapshot = { ...snapshot, momentumScore: momentum.score };
    const open = this.repository.listAutonomousPaperPositions({
      laneId: lane.id,
      openOnly: true,
      limit: 500
    }).some((position) => position.mint === token.mint);
    const entryReasons = learningStrategyEnabled
      ? [
          ...excluded,
          ...staticAdmission.reasons,
          ...(!learningStrategy ? ["NO_EVIDENCE_STRATEGY_MATCH"] : []),
          ...(learningStrategy?.shadowOnly ? ["SHADOW_ONLY_STRATEGY"] : []),
          ...(learningStrategy && !learningStrategy.modelAllowed
            ? ["LEARNED_SEGMENT_BLOCKED", ...learningStrategy.modelReasonCodes]
            : [])
        ]
      : [
          ...excluded,
          ...staticAdmission.reasons,
          ...(controlledExploration ? exploration?.blockingReasons ?? [] : momentum.reasons)
        ];
    if (missingMomentumEvidence(token)) entryReasons.push("MOMENTUM_DATA_MISSING");

    if (!sourceFresh(snapshot, this.now(), lane.policy.scanIntervalMinutes)) {
      entryReasons.push("MARKET_SNAPSHOT_STALE_OR_FUTURE");
    }

    if (open) entryReasons.push("POSITION_ALREADY_OPEN");
    if (!input.account.pricingComplete) entryReasons.push("OPEN_POSITION_UNPRICED");
    if (autonomousDrawdownLocked(input.account, lane.policy)) entryReasons.push("DRAWDOWN_LOCKED");
    if (autonomousDailyEntryPaused(input.account, input.dayStartNavUsd, lane.policy)) {
      entryReasons.push("DAILY_ENTRY_PAUSE");
    }
    const cooldown = this.cooldownReason(lane, token.mint, this.now());
    if (cooldown) entryReasons.push(cooldown);
    if (input.entryCadence.entriesToday >= lane.policy.maximumEntriesPerUtcDay) {
      entryReasons.push("UTC_DAILY_ENTRY_CAP_REACHED");
    }
    if (controlledExploration &&
        input.entryCadence.explorationEntriesToday >=
          AUTONOMOUS_PAPER_EXPLORATION_MAXIMUM_ENTRIES_PER_UTC_DAY) {
      entryReasons.push("EXPLORATION_DAILY_CAP_REACHED");
    }
    if (input.entryCadence.latestEntryAt) {
      const elapsedMinutes = (this.now().getTime() - Date.parse(input.entryCadence.latestEntryAt)) / 60_000;
      if (!Number.isFinite(elapsedMinutes) || elapsedMinutes < lane.policy.minimumEntrySpacingMinutes) {
        entryReasons.push("MINIMUM_ENTRY_SPACING_ACTIVE");
      }
    }

    if (entryReasons.length > 0) {
      this.storeCandidateDecision(
        lane,
        snapshot,
        "REJECT",
        "REJECTED",
        entryReasons,
        bucket,
        input.candidateEvents,
        input.flushCandidateEvents
      );
      return { account: input.account, entered: false };
    }

    const previous = this.repository.latestAutonomousPaperDecision(lane.id, token.mint);
    const now = this.now();
    const previousAt = previous ? Date.parse(previous.decidedAt) : Number.NaN;
    const previousSourceAt = previous ? Date.parse(previous.snapshot.sourceUpdatedAt) : Number.NaN;
    const currentSourceAt = Date.parse(snapshot.sourceUpdatedAt);
    const maximumConfirmationGapMs = lane.policy.scanIntervalMinutes * 2 * 60_000;
    const confirmed = lane.policy.confirmationSamples <= 1 || (
      previous?.action === "OBSERVE" &&
      previous.outcome === "ANALYSIS_ONLY" &&
      previous.reasons.includes("SIGNAL_PASSED") &&
      Number.isFinite(previousAt) && now.getTime() - previousAt >= MINIMUM_CONFIRMATION_GAP_MS &&
      Number.isFinite(previousAt) && now.getTime() - previousAt <= maximumConfirmationGapMs &&
      Number.isFinite(previousSourceAt) && Number.isFinite(currentSourceAt) &&
      currentSourceAt > previousSourceAt
    );
    if (!confirmed) {
      this.storeCandidateDecision(
        lane,
        snapshot,
        "OBSERVE",
        "ANALYSIS_ONLY",
        ["SIGNAL_PASSED", "WAIT_NEXT_SAMPLE"],
        bucket,
        input.candidateEvents,
        input.flushCandidateEvents
      );
      return { account: input.account, entered: false };
    }
    if (input.entered) {
      this.storeCandidateDecision(
        lane,
        snapshot,
        "OBSERVE",
        "ANALYSIS_ONLY",
        ["SIGNAL_PASSED", "CYCLE_ENTRY_LIMIT_REACHED"],
        bucket,
        input.candidateEvents,
        input.flushCandidateEvents
      );
      return { account: input.account, entered: false };
    }

    if (lane.policy.adaptiveSizingEnabled) {
      const strategyArm: AutonomousPaperStrategyArm = learningStrategyEnabled
        ? learningStrategy?.arm ?? "MOMENTUM_CONTINUATION"
        : controlledExploration
          ? "CONTROLLED_EXPLORATION"
          : "MOMENTUM";
      const waivedReasonCount = controlledExploration
        ? Math.max(1, exploration?.waivedReasons.length ?? 0)
        : 0;
      return this.simulateAdaptiveEntry({
        lane,
        account: input.account,
        token,
        snapshot,
          completedTrades: input.completedTrades,
          candidateEvents: input.candidateEvents,
          flushCandidateEvents: input.flushCandidateEvents,
        bucket,
        ...(supportsControlledExploration(lane.policyVersion)
          ? {
              strategyArm,
              waivedReasonCount,
              ...(learningStrategy?.modelHighConviction
                ? { modelHighConviction: true }
                : {})
            }
          : {}),
        ...(learningStrategyEnabled && learningStrategy
          ? {
              strategyReasons: [
                `STRATEGY_${learningStrategy.arm}`,
                `REGIME_${learningStrategy.regime}`,
                ...(learningStrategy.modelHighConviction ? ["MODEL_HIGH_CONVICTION"] : [])
              ],
              ...(learningStrategy.admission.lowerConfidenceNetReturnPercent !== undefined
                ? {
                    minimumExpectedEdgePercent:
                      learningStrategy.admission.lowerConfidenceNetReturnPercent
                  }
                : {})
            }
          : controlledExploration && exploration
          ? {
              strategyReasons: [
                "CONTROLLED_EXPLORATION",
                ...exploration.waivedReasons.map((reason) => `WAIVED_${reason}`)
              ]
            }
          : {})
      });
    }

    const sizing = autonomousEntrySize(input.account, lane.policy);
    if (!sizing.allowed) {
      this.storeCandidateDecision(
        lane,
        snapshot,
        "REJECT",
        "REJECTED",
        [sizing.reason],
        bucket,
        input.candidateEvents,
        input.flushCandidateEvents
      );
      return { account: input.account, entered: false };
    }
    const inputAmountAtomic = BigInt(Math.floor(sizing.sizeUsd * 10 ** USDC_DECIMALS)).toString();
    const buyRequest: QuoteRequest = {
      inputMint: USDC_MINT,
      outputMint: token.mint,
      inputAmountAtomic
    };
    input.flushCandidateEvents();
    const decidedAt = now.toISOString();
    const provisional = decision(lane, "BUY", "FAILED", snapshot, ["QUOTE_PENDING"], decidedAt);
    const claim = claimForDecision(lane, provisional, bucket, `candidate:${token.mint}`);
    if (!this.repository.claimAutonomousPaperEvent(claim)) {
      return { account: input.account, entered: false };
    }

    try {
      const buy = await this.options.quote(buyRequest);
      if (!this.exactPaperLane(lane.id)) throw new Error("EXACT_PAPER_LANE_ENDED");
      if (!this.newEntriesAllowed()) {
        throw new Error("OPERATIONAL_ENTRY_PAUSE_ACTIVE");
      }
      if (this.policyUpgradeDrainActive(lane.id)) {
        throw new Error("POLICY_UPGRADE_DRAIN_ACTIVE");
      }
      if (!quoteUsable(buy, buyRequest, this.now()) ||
          buy.priceImpactPercent > lane.policy.maximumPriceImpactPercent) {
        throw new Error("BUY_QUOTE_FAILED_CEILINGS");
      }
      const requestedUsd = Number(BigInt(inputAmountAtomic)) / 10 ** USDC_DECIMALS;
      const usdMetadataTolerance = Math.max(0.01, requestedUsd * 0.01);
      if (!Number.isFinite(requestedUsd) || requestedUsd <= 0 ||
          Math.abs(buy.inputUsd - requestedUsd) > usdMetadataTolerance) {
        throw new Error("BUY_QUOTE_USD_METADATA_MISMATCH");
      }
      const sellRequest: QuoteRequest = {
        inputMint: token.mint,
        outputMint: USDC_MINT,
        // Model only the guaranteed output, never Jupiter's optimistic amount.
        inputAmountAtomic: buy.minimumOutputAtomic
      };
      const sell = await this.options.quote(sellRequest);
      const finalQuoteAt = this.now();
      if (!quoteLegsCoherent(buy, sell, finalQuoteAt, buyRequest, sellRequest) ||
          buy.priceImpactPercent > lane.policy.maximumPriceImpactPercent ||
          sell.priceImpactPercent > lane.policy.maximumPriceImpactPercent) {
        throw new Error("SELL_QUOTE_FAILED_CEILINGS");
      }
      if (!this.exactPaperLane(lane.id)) throw new Error("EXACT_PAPER_LANE_ENDED");
      if (!this.newEntriesAllowed()) {
        throw new Error("OPERATIONAL_ENTRY_PAUSE_ACTIVE");
      }
      if (this.policyUpgradeDrainActive(lane.id)) {
        throw new Error("POLICY_UPGRADE_DRAIN_ACTIVE");
      }

      const solPrice = this.options.solPriceUsd();
      const guaranteedSellUsd = guaranteedUsdcProceedsUsd(sell);
      const buyFee = modeledQuoteFeeUsd(buy, solPrice, requestedUsd);
      const sellFee = modeledQuoteFeeUsd(sell, solPrice, guaranteedSellUsd);
      const executableRoundTripLoss = Math.max(0, requestedUsd - guaranteedSellUsd);
      const projectedCostUsd = executableRoundTripLoss + buyFee + sellFee;
      const projectedPercent = projectedCostUsd / requestedUsd * 100;
      const stressPercent = (
        executableRoundTripLoss +
        2 * (buyFee + sellFee) +
        requestedUsd * STRESS_ADVERSE_MOVE_FRACTION
      ) / requestedUsd * 100;
      if (!Number.isFinite(projectedPercent) ||
          projectedPercent > lane.policy.maximumRoundTripCostPercent) {
        throw new Error("ROUND_TRIP_COST_TOO_HIGH");
      }

      const entryCostUsd = requestedUsd + buyFee;
      if (input.account.cashUsd - entryCostUsd < lane.policy.minimumLiquidReserveUsd - 1e-9 ||
          input.account.deployedUsd + entryCostUsd >
            input.account.navUsd * lane.policy.maximumDeployedFraction + 1e-9) {
        throw new Error("MODELED_FEES_EXCEED_CAPITAL_LIMIT");
      }
      const amountUi = Number(BigInt(buy.minimumOutputAtomic)) / 10 ** token.decimals;
      if (!Number.isFinite(amountUi) || amountUi <= 0) throw new Error("INVALID_QUOTED_TOKEN_AMOUNT");
      const entryPriceUsd = entryCostUsd / amountUi;
      const positionId = hashId("autonomous-position-v1", lane.id, token.mint, decidedAt);
      const successful = decision(
        lane,
        "BUY",
        "SIMULATED",
        snapshot,
        [
          lane.policy.confirmationSamples <= 1
            ? "AGGRESSIVE_SINGLE_SNAPSHOT"
            : "TWO_PASSING_SNAPSHOTS",
          "QUOTE_CEILINGS_PASSED"
        ],
        decidedAt,
        {
          positionId,
          modeledPositionUsd: requestedUsd,
          projectedRoundTripCostPercent: projectedPercent,
          stressRoundTripCostPercent: stressPercent
        }
      );
      const position: AutonomousPaperPosition = {
        id: positionId,
        laneId: lane.id,
        entryDecisionId: successful.id,
        mint: token.mint,
        ...(token.symbol ? { symbol: token.symbol } : {}),
        initialAmountAtomic: buy.minimumOutputAtomic,
        remainingAmountAtomic: buy.minimumOutputAtomic,
        entryCostUsd,
        remainingCostUsd: entryCostUsd,
        lastExecutableValueUsd: Math.max(0, guaranteedSellUsd - sellFee),
        peakExecutableValueUsd: Math.max(0, guaranteedSellUsd - sellFee),
        entryPriceUsd,
        lastPriceUsd: snapshot.priceUsd,
        stopPriceUsd: entryPriceUsd * (1 - lane.policy.stopLossPercent / 100),
        takeProfitPriceUsd: entryPriceUsd * (1 + lane.policy.takeProfitPercent / 100),
        weakMomentumSamples: 0,
        status: "OPEN",
        openedAt: decidedAt,
        updatedAt: decidedAt
      };
      const all = this.replacePosition(lane.id, position);
      const next = recalculateAccount(input.account, all, {
        cashUsd: input.account.cashUsd - entryCostUsd,
        at: decidedAt
      });
      const committed = this.repository.commitAutonomousPaperEvent({
        event: terminal(claim, successful, "Autonomous quote-only PAPER entry simulated.", decidedAt),
        account: next,
        positions: [position]
      });
      if (!committed) return { account: input.account, entered: false };
      this.options.onUpdate?.({ laneId: lane.id, mint: token.mint, outcome: "BUY_SIMULATED" });
      return { account: next, entered: true };
    } catch (error) {
      const reason = error instanceof Error ? error.message : "QUOTE_FAILED";
      const failed = decision(lane, "BUY", "FAILED", snapshot, [reason], decidedAt);
      this.repository.finalizeAutonomousPaperEvent(terminal(claim, failed, reason, this.now().toISOString()));
      return { account: input.account, entered: false };
    }
  }

  private storeCandidateDecision(
    lane: AutonomousPaperLane,
    snapshot: AutonomousPaperMarketSnapshot,
    action: "REJECT" | "OBSERVE",
    outcome: "REJECTED" | "ANALYSIS_ONLY",
    reasons: string[],
    bucket: number,
    candidateEvents: AutonomousPaperEvent[],
    flushCandidateEvents: () => void
  ): void {
    if (!this.exactPaperLane(lane.id)) return;
    const at = this.now().toISOString();
    const value = decision(lane, action, outcome, snapshot, reasons, at);
    const claim = claimForDecision(lane, value, bucket, `candidate:${snapshot.mint}`);
    candidateEvents.push(terminal(claim, value, reasons.join(", "), at));
    if (candidateEvents.length >= AUTONOMOUS_PAPER_CANDIDATE_EVENT_BATCH_MAXIMUM) {
      flushCandidateEvents();
    }
  }

  private cooldownReason(
    lane: AutonomousPaperLane,
    mint: string,
    now: Date
  ): string | undefined {
    const latestTrade = this.repository.latestAutonomousPaperTrade(lane.id, mint);
    if (!latestTrade) return undefined;
    const elapsedMinutes = (now.getTime() - Date.parse(latestTrade.closedAt)) / 60_000;
    const required = latestTrade.exitReason === "STOP_LOSS"
      ? lane.policy.stopCooldownMinutes
      : lane.policy.cooldownMinutes;
    return elapsedMinutes >= 0 && elapsedMinutes < required
      ? (latestTrade.exitReason === "STOP_LOSS" ? "STOP_COOLDOWN_ACTIVE" : "COOLDOWN_ACTIVE")
      : undefined;
  }

  private async lookupOptionalHydration(
    candidates: readonly JupiterMarketTokenSnapshot[]
  ): Promise<Map<string, JupiterMarketTokenSnapshot>> {
    const exactByMint = new Map<string, JupiterMarketTokenSnapshot>();
    const mergeRequested = (
      requested: readonly string[],
      snapshots: readonly JupiterMarketTokenSnapshot[]
    ) => {
      const requestedMints = new Set(requested);
      for (const snapshot of snapshots) {
        if (requestedMints.has(snapshot.mint)) exactByMint.set(snapshot.mint, snapshot);
      }
    };

    for (let offset = 0; offset < candidates.length; offset += EXACT_MINT_HYDRATION_CHUNK_SIZE) {
      const chunk = candidates
        .slice(offset, offset + EXACT_MINT_HYDRATION_CHUNK_SIZE)
        .map((candidate) => candidate.mint);
      try {
        mergeRequested(chunk, await this.options.lookupMints(chunk));
        continue;
      } catch {
        // Jupiter can fail an entire exact-mint batch when one member is bad.
        // Split a failed chunk exactly once so a good half survives, while
        // keeping the retry tree strictly bounded.
      }
      if (chunk.length < 2) continue;
      const midpoint = Math.ceil(chunk.length / 2);
      for (const half of [chunk.slice(0, midpoint), chunk.slice(midpoint)]) {
        if (half.length === 0) continue;
        try {
          mergeRequested(half, await this.options.lookupMints(half));
        } catch {
          // Missing evidence remains rejected; never recursively retry a half.
        }
      }
    }
    return exactByMint;
  }

  private persistedEntryCadence(
    lane: AutonomousPaperLane,
    now: Date
  ): PersistedEntryCadence {
    const at = now.toISOString();
    const latestEntryAt = this.repository
      .latestAutonomousPaperSimulatedBuyEntryAtOrBefore(lane.id, at);
    return {
      entriesToday: this.repository
        .countAutonomousPaperSimulatedBuyEntriesForUtcDay(lane.id, at),
      explorationEntriesToday: this.repository
        .countAutonomousPaperControlledExplorationEntriesForUtcDay(lane.id, at),
      ...(latestEntryAt ? { latestEntryAt } : {})
    };
  }

  private replacePosition(
    laneId: string,
    replacement: AutonomousPaperPosition
  ): AutonomousPaperPosition[] {
    const all = this.repository.listAutonomousPaperPositions({ laneId, limit: 500 });
    const index = all.findIndex((position) => position.id === replacement.id);
    if (index >= 0) all[index] = replacement;
    else all.push(replacement);
    return all;
  }
}
