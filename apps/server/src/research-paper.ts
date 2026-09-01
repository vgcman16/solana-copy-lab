import { createHash, randomUUID } from "node:crypto";
import {
  DEFAULT_RISK_POLICY,
  USDC_MINT,
  type ModeState,
  type QuoteRequest,
  type QuoteSnapshot,
  type RejectedSourceAction,
  type ResearchPaperEvent,
  type ResearchPaperExitQuoteFailureCode,
  type ResearchPaperExitEvidence,
  type ResearchPaperLeaderAccount,
  type ResearchPaperPosition,
  type ResearchPaperTrade,
  type TokenEligibility
} from "@copylab/shared";
import { isJupiterNoRouteError } from "@copylab/providers";
import type { Repository } from "./repository.js";
import {
  researchPaperEntrySize,
  researchPaperExitPlan,
  researchPaperModeledQuoteCostUsd,
  researchPaperQuoteUsable,
  researchPaperSizingPolicy
} from "./research-paper-policy.js";

const USDC_DECIMALS = 6;
const RESEARCH_MARK_INTERVAL_MS = 5 * 60_000;
// Leave one minute of scheduling headroom so the next five-minute engine tick
// occurs after an aged terminal probe becomes due. Event-key bucketing still
// prevents more than one persisted probe per normal mark interval.
const RESEARCH_AGED_TERMINAL_PROBE_RETRY_MS = RESEARCH_MARK_INTERVAL_MS - 60_000;
export const RESEARCH_EXIT_QUOTE_RETRY_BASE_MS = 5 * 60_000;
export const RESEARCH_EXIT_QUOTE_TRANSIENT_RETRY_MAX_MS = 60 * 60_000;
export const RESEARCH_EXIT_QUOTE_RETRY_MAX_MS = 6 * 60 * 60_000;
export const RESEARCH_TERMINAL_WRITE_OFF_MINIMUM_AGE_MS = 7 * 24 * 60 * 60_000;
export const RESEARCH_TERMINAL_WRITE_OFF_MINIMUM_NO_ROUTE_FAILURES = 6;
const RESEARCH_STARTUP_TERMINAL_PROBE_MINIMUM_FAILURES = 24;
const RESEARCH_TERMINAL_TOKEN_EVIDENCE_MAX_AGE_MS = 5 * 60_000;
const RESEARCH_TERMINAL_MAXIMUM_LIQUIDITY_USD = 1;
const RESEARCH_TERMINAL_MAXIMUM_VOLUME_24H_USD = 0.01;
const RESEARCH_TERMINAL_MAXIMUM_HOLDERS = 10;

export interface ResearchPaperSourceAction {
  source: RejectedSourceAction;
  baseAmountAtomic: string;
  targetAmountAtomic: string;
  baseAmountUi: number;
  targetAmountUi: number;
  strictReasonCodes: string[];
}

export interface ResearchPaperEngineOptions {
  mode: () => ModeState;
  quote: (request: QuoteRequest) => Promise<QuoteSnapshot>;
  /** Fresh token evidence is used only to terminally write off legacy,
   * repeatedly unrouteable PAPER inventory. It never admits an entry. */
  checkToken?: (mint: string) => Promise<TokenEligibility>;
  /** Research-only confirmed owner balance. It never feeds strict risk,
   * execution, signing, or promotion state. */
  readLeaderMintBalance?: (wallet: string, mint: string) => Promise<bigint>;
  solPriceUsd: () => number;
  now?: () => Date;
  onUpdate?: (data: { laneId: string; wallet?: string; outcome?: string }) => void;
  onError?: (error: Error) => void;
}

interface ResearchExitDetails {
  evidence: ResearchPaperExitEvidence;
  sourceExitSignature?: string;
  nextLeaderObservedBalanceAtomic?: string;
  leaderBalanceObservedAt?: string;
}

class InvalidResearchExitQuoteError extends Error {}

function eventKey(laneId: string, source: RejectedSourceAction): string {
  const digest = createHash("sha256").update([
    "research-paper-v1",
    laneId,
    source.sourceSignature,
    source.sourceWallet,
    source.targetMint,
    source.side
  ].join("\u0000")).digest("hex");
  return `research-paper-v1:${digest}`;
}

function markEventKey(laneId: string, wallet: string, at: Date, dedupeNonce?: string): string {
  const bucket = Math.floor(at.getTime() / RESEARCH_MARK_INTERVAL_MS);
  const discriminator = dedupeNonce === undefined ? bucket : `nonce:${dedupeNonce}`;
  const digest = createHash("sha256")
    .update(["research-paper-mark-v1", laneId, wallet, discriminator].join("\u0000"))
    .digest("hex");
  return `research-paper-mark-v1:${digest}`;
}

function balanceExitEventKey(
  laneId: string,
  position: ResearchPaperPosition,
  previousBalanceAtomic: string,
  currentBalanceAtomic: string,
  at: Date
): string {
  const bucket = Math.floor(at.getTime() / RESEARCH_MARK_INTERVAL_MS);
  const digest = createHash("sha256").update([
    "research-paper-balance-exit-v1",
    laneId,
    position.id,
    previousBalanceAtomic,
    currentBalanceAtomic,
    bucket
  ].join("\u0000")).digest("hex");
  return `research-paper-balance-exit-v1:${digest}`;
}

function terminalWriteOffEventKey(
  laneId: string,
  position: ResearchPaperPosition,
  at: Date
): string {
  const bucket = Math.floor(at.getTime() / RESEARCH_MARK_INTERVAL_MS);
  const digest = createHash("sha256").update([
    "research-paper-terminal-writeoff-v1",
    laneId,
    position.id,
    String(position.exitQuoteFailureCount ?? 0),
    String(bucket)
  ].join("\u0000")).digest("hex");
  return `research-paper-terminal-writeoff-v1:${digest}`;
}

function sourceAgeSeconds(source: RejectedSourceAction, now: Date): number | undefined {
  const blockTime = Date.parse(source.blockTime);
  if (!Number.isFinite(blockTime)) return undefined;
  const age = (now.getTime() - blockTime) / 1_000;
  return age >= -5 ? age : undefined;
}

function bigintRatio(numerator: bigint, denominator: bigint): number {
  if (numerator < 0n || denominator <= 0n) return Number.NaN;
  return Number((numerator * 1_000_000_000n) / denominator) / 1_000_000_000;
}

function terminalEvent(
  claim: ResearchPaperEvent,
  outcome: Exclude<ResearchPaperEvent["outcome"], "CLAIMED">,
  reason: string,
  finalizedAt: string,
  additions: Partial<Pick<ResearchPaperEvent, "navUsd" | "trade">> = {}
): ResearchPaperEvent {
  return { ...claim, outcome, reason, finalizedAt, ...additions };
}

function recalculateAccount(
  previous: ResearchPaperLeaderAccount,
  positions: readonly ResearchPaperPosition[],
  input: {
    cashUsd?: number;
    realizedPnlUsd?: number;
    completedTrades?: number;
    at: string;
  }
): ResearchPaperLeaderAccount {
  const active = positions.filter((position) =>
    position.status === "OPEN" || position.status === "CLOSING" || position.status === "UNPRICED"
  );
  const cashUsd = input.cashUsd ?? previous.cashUsd;
  const realizedPnlUsd = input.realizedPnlUsd ?? previous.realizedPnlUsd;
  const navUsd = Math.max(0, cashUsd + active.reduce(
    (total, position) => total + position.lastExecutableValueUsd,
    0
  ));
  const peakNavUsd = Math.max(previous.peakNavUsd, navUsd);
  const currentDrawdown = peakNavUsd > 0 ? ((peakNavUsd - navUsd) / peakNavUsd) * 100 : 0;
  return {
    ...previous,
    cashUsd,
    navUsd,
    peakNavUsd,
    realizedPnlUsd,
    unrealizedPnlUsd: navUsd - previous.initialNavUsd - realizedPnlUsd,
    maxDrawdownPercent: Math.max(previous.maxDrawdownPercent, currentDrawdown),
    openPositions: active.length,
    completedTrades: input.completedTrades ?? previous.completedTrades,
    pricingComplete: active.every((position) => position.status !== "UNPRICED"),
    updatedAt: input.at
  };
}

function quoteMatches(
  quote: QuoteSnapshot,
  request: QuoteRequest,
  now: Date
): boolean {
  return quote.inputMint === request.inputMint &&
    quote.outputMint === request.outputMint &&
    quote.inputAmountAtomic === request.inputAmountAtomic &&
    researchPaperQuoteUsable(quote, now);
}

function exitQuoteRetryDue(position: ResearchPaperPosition, at: Date): boolean {
  if (!position.nextExitQuoteRetryAt) return true;
  const retryAt = Date.parse(position.nextExitQuoteRetryAt);
  return Number.isFinite(retryAt) && at.getTime() >= retryAt;
}

function classifyExitQuoteFailure(error: unknown): ResearchPaperExitQuoteFailureCode {
  if (error instanceof InvalidResearchExitQuoteError) return "JUPITER_EXIT_QUOTE_INVALID";
  return isJupiterNoRouteError(error)
    ? "JUPITER_EXIT_NO_ROUTE"
    : "JUPITER_EXIT_QUOTE_UNAVAILABLE";
}

function exitQuoteFailureReason(code: ResearchPaperExitQuoteFailureCode): string {
  if (code === "JUPITER_EXIT_NO_ROUTE") {
    return "Jupiter reports that no executable exit route currently exists";
  }
  if (code === "JUPITER_EXIT_QUOTE_INVALID") {
    return "Jupiter returned an exit quote that failed local validity checks";
  }
  return "Jupiter's exit-quote service was unavailable";
}

function clearExitQuoteRetry(position: ResearchPaperPosition): ResearchPaperPosition {
  const cleared = { ...position };
  delete cleared.exitQuoteFailureCount;
  delete cleared.consecutiveExitNoRouteFailureCount;
  delete cleared.lastExitQuoteAttemptAt;
  delete cleared.nextExitQuoteRetryAt;
  delete cleared.lastExitQuoteFailureCode;
  return cleared;
}

function withExitQuoteFailure(
  position: ResearchPaperPosition,
  at: Date,
  code: ResearchPaperExitQuoteFailureCode
): ResearchPaperPosition {
  const previous = Number.isSafeInteger(position.exitQuoteFailureCount) &&
    (position.exitQuoteFailureCount ?? 0) > 0
    ? position.exitQuoteFailureCount!
    : 0;
  const failures = Math.min(Number.MAX_SAFE_INTEGER, previous + 1);
  const previousConsecutiveNoRoutes =
    position.lastExitQuoteFailureCode === "JUPITER_EXIT_NO_ROUTE" &&
    Number.isSafeInteger(position.consecutiveExitNoRouteFailureCount) &&
    (position.consecutiveExitNoRouteFailureCount ?? 0) > 0
      ? position.consecutiveExitNoRouteFailureCount!
      : 0;
  const consecutiveNoRoutes = code === "JUPITER_EXIT_NO_ROUTE"
    ? Math.min(Number.MAX_SAFE_INTEGER, previousConsecutiveNoRoutes + 1)
    : undefined;
  const retryOrdinal = consecutiveNoRoutes ?? failures;
  const exponent = Math.min(20, retryOrdinal - 1);
  const maximumDelayMs = code === "JUPITER_EXIT_NO_ROUTE"
    ? RESEARCH_EXIT_QUOTE_RETRY_MAX_MS
    : RESEARCH_EXIT_QUOTE_TRANSIENT_RETRY_MAX_MS;
  const openedAt = Date.parse(position.openedAt);
  const agedTerminalVerification = code === "JUPITER_EXIT_NO_ROUTE" &&
    consecutiveNoRoutes !== undefined &&
    consecutiveNoRoutes < RESEARCH_TERMINAL_WRITE_OFF_MINIMUM_NO_ROUTE_FAILURES &&
    Number.isFinite(openedAt) &&
    at.getTime() - openedAt >= RESEARCH_TERMINAL_WRITE_OFF_MINIMUM_AGE_MS;
  // Once an already-zero PAPER lot is old enough for terminal verification,
  // collect honest observations at most once per normal five-minute mark. The
  // separate streak still has to reach the terminal threshold; no burst or
  // historical outage count can accelerate it.
  const delayMs = agedTerminalVerification
    ? RESEARCH_AGED_TERMINAL_PROBE_RETRY_MS
    : Math.min(maximumDelayMs, RESEARCH_EXIT_QUOTE_RETRY_BASE_MS * 2 ** exponent);
  const failed: ResearchPaperPosition = {
    ...position,
    lastExecutableValueUsd: 0,
    status: "UNPRICED",
    exitQuoteFailureCount: failures,
    lastExitQuoteAttemptAt: at.toISOString(),
    nextExitQuoteRetryAt: new Date(at.getTime() + delayMs).toISOString(),
    lastExitQuoteFailureCode: code,
    updatedAt: at.toISOString()
  };
  if (consecutiveNoRoutes === undefined) delete failed.consecutiveExitNoRouteFailureCount;
  else failed.consecutiveExitNoRouteFailureCount = consecutiveNoRoutes;
  return failed;
}

function hasFreshTerminalTokenEvidence(token: TokenEligibility, at: Date): boolean {
  const checkedAt = Date.parse(token.checkedAt);
  const ageMs = at.getTime() - checkedAt;
  if (!Number.isFinite(checkedAt) || ageMs < -30_000 || ageMs > RESEARCH_TERMINAL_TOKEN_EVIDENCE_MAX_AGE_MS) {
    return false;
  }
  const reasons = new Set(token.reasons);
  const terminalIdentity = token.suspicious || reasons.has("TOKEN_NOT_FOUND");
  return !token.eligible &&
    terminalIdentity &&
    token.liquidityUsd <= RESEARCH_TERMINAL_MAXIMUM_LIQUIDITY_USD &&
    token.volume24hUsd <= RESEARCH_TERMINAL_MAXIMUM_VOLUME_24H_USD &&
    token.holderCount <= RESEARCH_TERMINAL_MAXIMUM_HOLDERS;
}

export class ResearchPaperEngine {
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly repository: Repository,
    private readonly options: ResearchPaperEngineOptions
  ) {}

  enqueue(action: ResearchPaperSourceAction): Promise<void> {
    const task = this.tail.then(() => this.process(action));
    this.tail = task.catch((error) => this.options.onError?.(
      error instanceof Error ? error : new Error("Research-paper processing failed safely.")
    ));
    return task;
  }

  enqueueMarks(dedupeNonce?: string): Promise<void> {
    const task = this.tail.then(() => this.markOpenPositions(dedupeNonce));
    this.tail = task.catch((error) => this.options.onError?.(
      error instanceof Error ? error : new Error("Research-paper marking failed safely.")
    ));
    return task;
  }

  drain(): Promise<void> {
    return this.tail;
  }

  recoverInterruptedClaims(): number {
    const lane = this.repository.activeResearchPaperLane();
    if (!lane) return 0;
    const claims = this.repository
      .listResearchPaperEvents({ laneId: lane.id, limit: 500 })
      .filter((event) => event.outcome === "CLAIMED");
    const at = this.now().toISOString();
    let recovered = 0;
    for (const claim of claims) {
      if (this.repository.finalizeResearchPaperEvent(terminalEvent(
        claim,
        "FAILED",
        "An interrupted quote-only research operation was closed without changing simulated inventory.",
        at
      ))) recovered += 1;
    }
    return recovered;
  }

  backfillRejectedVisibility(): number {
    const lane = this.repository.activeResearchPaperLane();
    if (!lane) return 0;
    const wallets = new Set(this.repository.listResearchPaperLeaders(lane.id, 500).map((entry) => entry.wallet));
    if (wallets.size === 0) return 0;
    const rows = this.repository.db.prepare(`
      SELECT source.event_json
      FROM source_events source
      JOIN signal_outcomes outcome
        ON outcome.source_signature = source.signature AND outcome.source_wallet = source.wallet
      WHERE outcome.reason_code = 'UNSUPPORTED_PROGRAM_ACTIVITY'
      ORDER BY source.observed_at
      LIMIT 5000
    `).all() as Array<{ event_json: string }>;
    let inserted = 0;
    for (const row of rows) {
      let source: RejectedSourceAction;
      try {
        source = JSON.parse(row.event_json) as RejectedSourceAction;
      } catch {
        continue;
      }
      if (!wallets.has(source.sourceWallet)) continue;
      const claim: ResearchPaperEvent = {
        eventKey: eventKey(lane.id, source),
        laneId: lane.id,
        wallet: source.sourceWallet,
        kind: "SIGNAL",
        outcome: "CLAIMED",
        observedAt: source.detectedAt,
        sourceSignature: source.sourceSignature,
        mint: source.targetMint,
        action: source.side,
        strictReasonCodes: ["UNSUPPORTED_PROGRAM_ACTIVITY"]
      };
      if (!this.repository.claimResearchPaperEvent(claim)) continue;
      if (this.repository.finalizeResearchPaperEvent(terminalEvent(
        claim,
        "ANALYSIS_ONLY",
        "Historical blocked activity was imported for comparison and was not retroactively simulated.",
        this.now().toISOString()
      ))) inserted += 1;
    }
    if (inserted > 0) this.options.onUpdate?.({ laneId: lane.id, outcome: "BACKFILLED" });
    return inserted;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private exactPaperLane(laneId?: string): boolean {
    if (this.options.mode() !== "PAPER") return false;
    const active = this.repository.activeResearchPaperLane();
    return Boolean(active && (!laneId || active.id === laneId));
  }

  private async process(action: ResearchPaperSourceAction): Promise<void> {
    const lane = this.repository.activeResearchPaperLane();
    if (!lane || !this.exactPaperLane(lane.id)) return;
    const account = this.repository.getResearchPaperLeader(lane.id, action.source.sourceWallet);
    if (!account) return;
    const existingPosition = this.repository.listResearchPaperPositions({
      laneId: lane.id,
      wallet: account.wallet,
      openOnly: true,
      limit: 100
    }).find((position) => position.mint === action.source.targetMint);
    const exitPlan = action.source.side === "SELL" && existingPosition
      ? researchPaperExitPlan({
          followerRemainingAtomic: existingPosition.simulatedRemainingAtomic,
          leaderInitialAtomic: existingPosition.leaderInitialAtomic,
          leaderRemainingAtomic: existingPosition.leaderRemainingAtomic,
          sourceSellAtomic: action.targetAmountAtomic
        })
      : undefined;
    const claim: ResearchPaperEvent = {
      eventKey: eventKey(lane.id, action.source),
      laneId: lane.id,
      wallet: account.wallet,
      kind: exitPlan?.closesPosition ? "TRADE" : "SIGNAL",
      outcome: "CLAIMED",
      observedAt: action.source.detectedAt,
      sourceSignature: action.source.sourceSignature,
      mint: action.source.targetMint,
      action: action.source.side,
      strictReasonCodes: [...new Set(action.strictReasonCodes)]
    };
    if (!this.repository.claimResearchPaperEvent(claim)) return;
    const now = this.now();
    const age = sourceAgeSeconds(action.source, now);
    if (action.source.recovered || age === undefined || age > DEFAULT_RISK_POLICY.maximumSignalAgeSeconds) {
      this.repository.finalizeResearchPaperEvent(terminalEvent(
        claim,
        "ANALYSIS_ONLY",
        action.source.recovered
          ? "Recovered activity is visible but is never retroactively simulated."
          : "Stale or invalid source activity is visible but is never simulated.",
        now.toISOString()
      ));
      this.options.onUpdate?.({ laneId: lane.id, wallet: account.wallet, outcome: "ANALYSIS_ONLY" });
      return;
    }
    if (action.source.side === "BUY") {
      await this.processBuy(action, claim, account, existingPosition);
    } else {
      await this.processSell(action, claim, account, existingPosition, exitPlan);
    }
  }

  private async processBuy(
    action: ResearchPaperSourceAction,
    claim: ResearchPaperEvent,
    account: ResearchPaperLeaderAccount,
    existingPosition: ResearchPaperPosition | undefined
  ): Promise<void> {
    if (existingPosition) {
      this.finalizeWithoutMutation(claim, "REJECTED", "The comparison keeps the strict one-position-per-wallet-token rule.");
      return;
    }
    const lane = this.repository.getResearchPaperLane(claim.laneId);
    if (!lane || lane.status !== "ACTIVE") {
      this.finalizeWithoutMutation(claim, "ANALYSIS_ONLY", "The research policy lane was no longer active.");
      return;
    }
    const positions = this.repository.listResearchPaperPositions({
      laneId: claim.laneId,
      wallet: claim.wallet,
      openOnly: true,
      limit: 100
    });
    const deployedUsd = positions.reduce((total, position) => total + position.remainingCostUsd, 0);
    const sizingPolicy = researchPaperSizingPolicy(lane.policy);
    const size = researchPaperEntrySize({
      navUsd: account.navUsd,
      cashUsd: account.cashUsd,
      deployedUsd,
      openPositions: positions.length
    }, sizingPolicy);
    if (!size.allowed) {
      this.finalizeWithoutMutation(claim, "REJECTED", `Capital allocation remained blocked by ${size.reason}.`);
      return;
    }
    const request: QuoteRequest = {
      inputMint: USDC_MINT,
      outputMint: action.source.targetMint,
      inputAmountAtomic: Math.floor(size.sizeUsd * 10 ** USDC_DECIMALS).toString()
    };
    let entryQuote: QuoteSnapshot;
    try {
      entryQuote = await this.options.quote(request);
    } catch {
      this.finalizeWithoutMutation(claim, "REJECTED", "Jupiter could not provide a quote-only research entry.");
      return;
    }
    const afterEntry = this.now();
    if (!this.exactPaperLane(claim.laneId) || !quoteMatches(entryQuote, request, afterEntry) ||
        this.repository.getResearchPaperLane(claim.laneId)?.policyVersion !== lane.policyVersion ||
        (sourceAgeSeconds(action.source, afterEntry) ?? Number.POSITIVE_INFINITY) > DEFAULT_RISK_POLICY.maximumSignalAgeSeconds) {
      this.finalizeWithoutMutation(
        claim,
        "ANALYSIS_ONLY",
        "The mode, source freshness, or quote validity changed before the simulated fill; no inventory was created."
      );
      return;
    }
    const entryFeesUsd = researchPaperModeledQuoteCostUsd(entryQuote, this.options.solPriceUsd());
    const entryCostUsd = entryQuote.inputUsd + entryFeesUsd;
    if (!sizingPolicy) {
      this.finalizeWithoutMutation(claim, "REJECTED", "The persisted research sizing policy became invalid.");
      return;
    }
    if (deployedUsd + entryCostUsd > account.navUsd * sizingPolicy.maximumDeployedFraction + 1e-9) {
      this.finalizeWithoutMutation(claim, "REJECTED", "Modeled fees would breach the research deployment ceiling.");
      return;
    }
    if (account.cashUsd - entryCostUsd < sizingPolicy.minimumLiquidReserveUsd - 1e-9) {
      this.finalizeWithoutMutation(claim, "REJECTED", "Modeled fees would breach the research liquid reserve.");
      return;
    }

    const exitRequest: QuoteRequest = {
      inputMint: action.source.targetMint,
      outputMint: USDC_MINT,
      inputAmountAtomic: entryQuote.outputAmountAtomic
    };
    let exitQuote: QuoteSnapshot | undefined;
    let exitQuoteFailureCode: ResearchPaperExitQuoteFailureCode | undefined;
    try {
      const candidate = await this.options.quote(exitRequest);
      if (quoteMatches(candidate, exitRequest, this.now())) exitQuote = candidate;
      else exitQuoteFailureCode = "JUPITER_EXIT_QUOTE_INVALID";
    } catch (error) {
      exitQuoteFailureCode = classifyExitQuoteFailure(error);
    }
    if (!exitQuote) {
      const code = exitQuoteFailureCode ?? "JUPITER_EXIT_QUOTE_UNAVAILABLE";
      this.finalizeWithoutMutation(
        claim,
        "REJECTED",
        `${exitQuoteFailureReason(code)}. The opportunity remains in the research signal ledger, ` +
          "but no simulated inventory was created because immediate full-position sellability is required."
      );
      return;
    }
    let leaderObservedBalanceAtomic = action.targetAmountAtomic;
    let leaderBalanceObservedAt = this.now().toISOString();
    if (this.options.readLeaderMintBalance) {
      try {
        const observed = await this.options.readLeaderMintBalance(
          action.source.sourceWallet,
          action.source.targetMint
        );
        if (observed < 0n) throw new Error("negative leader balance");
        const acquired = BigInt(action.targetAmountAtomic);
        if (observed < acquired) {
          this.finalizeWithoutMutation(
            claim,
            "ANALYSIS_ONLY",
            "The leader no longer held the detected entry amount before the research fill could commit."
          );
          return;
        }
        leaderObservedBalanceAtomic = observed.toString();
        leaderBalanceObservedAt = this.now().toISOString();
      } catch {
        this.finalizeWithoutMutation(
          claim,
          "REJECTED",
          "A confirmed leader-balance checkpoint could not be established; no research inventory was created."
        );
        return;
      }
    }
    const beforeCommit = this.now();
    if (!this.exactPaperLane(claim.laneId) ||
        this.repository.getResearchPaperLane(claim.laneId)?.policyVersion !== lane.policyVersion ||
        !quoteMatches(entryQuote, request, beforeCommit) ||
        !quoteMatches(exitQuote, exitRequest, beforeCommit) ||
        (sourceAgeSeconds(action.source, beforeCommit) ?? Number.POSITIVE_INFINITY) >
          DEFAULT_RISK_POLICY.maximumSignalAgeSeconds) {
      this.finalizeWithoutMutation(
        claim,
        "ANALYSIS_ONLY",
        "PAPER mode, source freshness, or entry/exit quote validity changed before the research entry committed."
      );
      return;
    }
    const at = beforeCommit.toISOString();
    const executableValueUsd = Math.max(
      0,
      exitQuote.outputUsd - researchPaperModeledQuoteCostUsd(exitQuote, this.options.solPriceUsd())
    );
    const position: ResearchPaperPosition = {
      id: randomUUID(),
      laneId: claim.laneId,
      wallet: claim.wallet,
      mint: action.source.targetMint,
      sourceEntrySignature: action.source.sourceSignature,
      openedAt: at,
      simulatedInitialAtomic: entryQuote.outputAmountAtomic,
      simulatedRemainingAtomic: entryQuote.outputAmountAtomic,
      leaderInitialAtomic: action.targetAmountAtomic,
      leaderRemainingAtomic: action.targetAmountAtomic,
      leaderObservedBalanceAtomic,
      leaderBalanceObservedAt,
      entryCostUsd,
      remainingCostUsd: entryCostUsd,
      lastExecutableValueUsd: executableValueUsd,
      pendingExitFraction: 0,
      status: "OPEN",
      updatedAt: at
    };
    const nextPositions = [...positions, position];
    const nextAccount = recalculateAccount(account, nextPositions, {
      cashUsd: account.cashUsd - entryCostUsd,
      at
    });
    const event = terminalEvent(
      claim,
      "SIMULATED",
      "Entry was simulated with token/program admission relaxed and a full-position exit quote; " +
        "no order, signature, or real funds were used.",
      at,
      { navUsd: nextAccount.navUsd }
    );
    if (this.repository.commitResearchPaperEvent({ event, account: nextAccount, positions: [position] })) {
      this.options.onUpdate?.({ laneId: claim.laneId, wallet: claim.wallet, outcome: "SIMULATED" });
    }
  }

  private async processSell(
    action: ResearchPaperSourceAction,
    claim: ResearchPaperEvent,
    account: ResearchPaperLeaderAccount,
    position: ResearchPaperPosition | undefined,
    plan: ReturnType<typeof researchPaperExitPlan>
  ): Promise<void> {
    if (!position || !plan) {
      this.finalizeWithoutMutation(claim, "ANALYSIS_ONLY", "The leader sell had no matching high-risk research position.");
      return;
    }
    if (!exitQuoteRetryDue(position, this.now())) {
      this.finalizeWithoutMutation(
        claim,
        "ANALYSIS_ONLY",
        `The durable exit-quote retry is deferred until ${position.nextExitQuoteRetryAt}; the simulated lot remains open and valued at zero.`
      );
      return;
    }
    const previousObserved = BigInt(
      position.leaderObservedBalanceAtomic ?? position.leaderRemainingAtomic
    );
    const soldByLeader = BigInt(position.leaderRemainingAtomic) - BigInt(plan.nextLeaderRemainingAtomic);
    const nextObserved = previousObserved > soldByLeader ? previousObserved - soldByLeader : 0n;
    await this.simulateExit({
      claim,
      account,
      position,
      plan,
      source: action.source,
      details: {
        evidence: action.strictReasonCodes.includes("LEADER_TOKEN_BALANCE_DECREASE")
          ? "TOKEN_BALANCE_DECREASE"
          : "LEADER_SWAP",
        sourceExitSignature: action.source.sourceSignature,
        nextLeaderObservedBalanceAtomic: nextObserved.toString(),
        leaderBalanceObservedAt: this.now().toISOString()
      }
    });
  }

  private async simulateExit(input: {
    claim: ResearchPaperEvent;
    account: ResearchPaperLeaderAccount;
    position: ResearchPaperPosition;
    plan: NonNullable<ReturnType<typeof researchPaperExitPlan>>;
    source?: RejectedSourceAction;
    details: ResearchExitDetails;
  }): Promise<boolean> {
    const { claim, account, position, plan, source, details } = input;
    const request: QuoteRequest = {
      inputMint: position.mint,
      outputMint: USDC_MINT,
      inputAmountAtomic: plan.followerSellAtomic
    };
    let quote: QuoteSnapshot;
    try {
      quote = await this.options.quote(request);
    } catch (error) {
      if (!this.exactPaperLane(claim.laneId)) {
        this.finalizeWithoutMutation(claim, "ANALYSIS_ONLY", "PAPER mode ended during the research exit quote.");
        return false;
      }
      return this.recordExitQuoteFailure(
        claim,
        account,
        position,
        classifyExitQuoteFailure(error)
      );
    }
    const afterQuote = this.now();
    if (!this.exactPaperLane(claim.laneId) ||
        (source && (sourceAgeSeconds(source, afterQuote) ?? Number.POSITIVE_INFINITY) >
          DEFAULT_RISK_POLICY.maximumSignalAgeSeconds)) {
      this.finalizeWithoutMutation(claim, "ANALYSIS_ONLY", "The mode or source freshness changed before the research exit could commit.");
      return false;
    }
    if (!quoteMatches(quote, request, afterQuote)) {
      return this.recordExitQuoteFailure(
        claim,
        account,
        position,
        "JUPITER_EXIT_QUOTE_INVALID"
      );
    }
    const followerRemaining = BigInt(position.simulatedRemainingAtomic);
    const sold = BigInt(plan.followerSellAtomic);
    const nextRemaining = followerRemaining - sold;
    const soldFraction = bigintRatio(sold, followerRemaining);
    const costBasisUsd = position.remainingCostUsd * soldFraction;
    const modeledCostsUsd = researchPaperModeledQuoteCostUsd(quote, this.options.solPriceUsd());
    const proceedsUsd = Math.max(0, quote.outputUsd - modeledCostsUsd);
    const pnlUsd = proceedsUsd - costBasisUsd;
    const at = afterQuote.toISOString();
    const nextPosition = clearExitQuoteRetry({
      ...position,
      simulatedRemainingAtomic: plan.closesPosition ? "0" : nextRemaining.toString(),
      leaderRemainingAtomic: plan.nextLeaderRemainingAtomic,
      ...(details.nextLeaderObservedBalanceAtomic !== undefined
        ? { leaderObservedBalanceAtomic: details.nextLeaderObservedBalanceAtomic }
        : {}),
      ...(details.leaderBalanceObservedAt !== undefined
        ? { leaderBalanceObservedAt: details.leaderBalanceObservedAt }
        : {}),
      remainingCostUsd: plan.closesPosition ? 0 : Math.max(0, position.remainingCostUsd - costBasisUsd),
      lastExecutableValueUsd: plan.closesPosition
        ? 0
        : Math.max(0, quote.outputUsd * bigintRatio(nextRemaining, sold)),
      status: plan.closesPosition ? "CLOSED" : "OPEN",
      updatedAt: at,
      ...(plan.closesPosition ? { closedAt: at } : {})
    });
    const positions = this.repository.listResearchPaperPositions({
      laneId: claim.laneId,
      wallet: claim.wallet,
      openOnly: true,
      limit: 100
    }).map((candidate) => candidate.id === position.id ? nextPosition : candidate);
    const nextAccount = recalculateAccount(account, positions, {
      cashUsd: account.cashUsd + proceedsUsd,
      realizedPnlUsd: account.realizedPnlUsd + pnlUsd,
      completedTrades: account.completedTrades + (plan.closesPosition ? 1 : 0),
      at
    });
    let trade: ResearchPaperTrade | undefined;
    if (plan.closesPosition) {
      trade = {
        id: randomUUID(),
        laneId: claim.laneId,
        wallet: claim.wallet,
        mint: position.mint,
        positionId: position.id,
        sourceEntrySignature: position.sourceEntrySignature,
        ...(details.sourceExitSignature ? { sourceExitSignature: details.sourceExitSignature } : {}),
        exitEvidence: details.evidence,
        openedAt: position.openedAt,
        closedAt: at,
        proceedsUsd,
        costBasisUsd,
        modeledCostsUsd,
        pnlUsd
      };
    }
    const event = terminalEvent(
      claim,
      "SIMULATED",
      plan.closesPosition
        ? details.evidence === "BALANCE_RECONCILIATION"
          ? "A confirmed leader-balance decrease closed the stale research position without any real transaction."
          : "The research position followed the leader exit and closed without any real transaction."
        : details.evidence === "BALANCE_RECONCILIATION"
          ? "A confirmed leader-balance decrease produced a proportional research exit without any real transaction."
          : "A proportional leader exit was simulated without any real transaction.",
      at,
      { navUsd: nextAccount.navUsd, ...(trade ? { trade } : {}) }
    );
    const committed = this.repository.commitResearchPaperEvent({
      event,
      account: nextAccount,
      positions: [nextPosition]
    });
    if (committed) {
      this.options.onUpdate?.({ laneId: claim.laneId, wallet: claim.wallet, outcome: "SIMULATED" });
    }
    return committed;
  }

  private recordExitQuoteFailure(
    claim: ResearchPaperEvent,
    account: ResearchPaperLeaderAccount,
    position: ResearchPaperPosition,
    code: ResearchPaperExitQuoteFailureCode
  ): false {
    const attemptedAt = this.now();
    const failedPosition = withExitQuoteFailure(position, attemptedAt, code);
    const positions = this.repository.listResearchPaperPositions({
      laneId: claim.laneId,
      wallet: claim.wallet,
      openOnly: true,
      limit: 100
    }).map((candidate) => candidate.id === position.id ? failedPosition : candidate);
    const nextAccount = recalculateAccount(account, positions, { at: attemptedAt.toISOString() });
    const event = terminalEvent(
      claim,
      "REJECTED",
      `${exitQuoteFailureReason(code)}. Attempt ${failedPosition.exitQuoteFailureCount} failed; retry is deferred until ${failedPosition.nextExitQuoteRetryAt}. The simulated lot remains open and valued at zero.`,
      attemptedAt.toISOString(),
      { navUsd: nextAccount.navUsd }
    );
    if (this.repository.commitResearchPaperEvent({
      event,
      account: nextAccount,
      positions: [failedPosition]
    })) {
      this.options.onUpdate?.({ laneId: claim.laneId, wallet: claim.wallet, outcome: "REJECTED" });
    }
    return false;
  }

  /**
   * Closes only legacy PAPER inventory whose executable value is already zero
   * and whose terminal state is proven independently by both durable quote
   * failures and a fresh Jupiter token-safety snapshot. This records a total
   * loss, not a synthetic sale or fallback price.
   */
  private async tryTerminalWriteOff(
    laneId: string,
    persistedCandidate: ResearchPaperPosition,
    failedCandidate: ResearchPaperPosition,
    at: Date
  ): Promise<boolean> {
    const failures = failedCandidate.exitQuoteFailureCount ?? 0;
    const consecutiveNoRoutes = failedCandidate.consecutiveExitNoRouteFailureCount ?? 0;
    const openedAt = Date.parse(failedCandidate.openedAt);
    if (
      !this.options.checkToken ||
      failedCandidate.status !== "UNPRICED" ||
      failedCandidate.lastExecutableValueUsd !== 0 ||
      failedCandidate.lastExitQuoteFailureCode !== "JUPITER_EXIT_NO_ROUTE" ||
      !Number.isFinite(openedAt) ||
      at.getTime() - openedAt < RESEARCH_TERMINAL_WRITE_OFF_MINIMUM_AGE_MS ||
      consecutiveNoRoutes < RESEARCH_TERMINAL_WRITE_OFF_MINIMUM_NO_ROUTE_FAILURES
    ) return false;

    let token: TokenEligibility;
    try {
      token = await this.options.checkToken(failedCandidate.mint);
    } catch {
      // Missing safety evidence can delay a write-off but can never authorize
      // one. The existing zero executable value and retry state remain intact.
      return false;
    }
    if (!hasFreshTerminalTokenEvidence(token, at) || !this.exactPaperLane(laneId)) return false;

    const position = this.repository.getResearchPaperPosition(persistedCandidate.id);
    if (
      !position ||
      position.laneId !== laneId ||
      position.status !== "UNPRICED" ||
      position.lastExecutableValueUsd !== 0 ||
      position.exitQuoteFailureCount !== persistedCandidate.exitQuoteFailureCount ||
      position.consecutiveExitNoRouteFailureCount !==
        persistedCandidate.consecutiveExitNoRouteFailureCount ||
      position.lastExitQuoteFailureCode !== persistedCandidate.lastExitQuoteFailureCode
    ) return false;
    const account = this.repository.getResearchPaperLeader(laneId, position.wallet);
    if (!account) return false;

    const claim: ResearchPaperEvent = {
      eventKey: terminalWriteOffEventKey(laneId, failedCandidate, at),
      laneId,
      wallet: position.wallet,
      kind: "TRADE",
      outcome: "CLAIMED",
      observedAt: at.toISOString(),
      mint: position.mint,
      action: "SELL",
      strictReasonCodes: ["PAPER_TERMINAL_WRITEOFF", "TOKEN_SAFETY_FAILURE"]
    };
    if (!this.repository.claimResearchPaperEvent(claim)) return false;

    const costBasisUsd = position.remainingCostUsd;
    const closed = clearExitQuoteRetry({
      ...position,
      simulatedRemainingAtomic: "0",
      remainingCostUsd: 0,
      lastExecutableValueUsd: 0,
      pendingExitFraction: 0,
      status: "CLOSED",
      updatedAt: at.toISOString(),
      closedAt: at.toISOString()
    });
    const positions = this.repository.listResearchPaperPositions({
      laneId,
      wallet: position.wallet,
      openOnly: true,
      limit: 100
    }).map((current) => current.id === position.id ? closed : current);
    const nextAccount = recalculateAccount(account, positions, {
      realizedPnlUsd: account.realizedPnlUsd - costBasisUsd,
      completedTrades: account.completedTrades + 1,
      at: at.toISOString()
    });
    const trade: ResearchPaperTrade = {
      id: randomUUID(),
      laneId,
      wallet: position.wallet,
      mint: position.mint,
      positionId: position.id,
      sourceEntrySignature: position.sourceEntrySignature,
      exitEvidence: "TERMINAL_UNROUTABLE_WRITEOFF",
      openedAt: position.openedAt,
      closedAt: at.toISOString(),
      proceedsUsd: 0,
      costBasisUsd,
      modeledCostsUsd: 0,
      pnlUsd: -costBasisUsd
    };
    const reasons = [...new Set(token.reasons)].sort().join(", ");
    const event = terminalEvent(
      claim,
      "SIMULATED",
      `Legacy PAPER inventory was written off at zero proceeds after ${failures} total exit-quote failures, ` +
        `including ${consecutiveNoRoutes} consecutive typed no-route results, ` +
        `and fresh terminal token evidence (${reasons || "unsafe token"}; liquidity $${token.liquidityUsd}; ` +
        `24h volume $${token.volume24hUsd}; holders ${token.holderCount}). This was not an executable sale, ` +
        "fallback price, order, signature, or real transaction.",
      at.toISOString(),
      { navUsd: nextAccount.navUsd, trade }
    );
    const committed = this.repository.commitResearchPaperEvent({
      event,
      account: nextAccount,
      positions: [closed]
    });
    if (committed) {
      this.options.onUpdate?.({ laneId, wallet: position.wallet, outcome: "SIMULATED" });
    }
    return committed;
  }

  private finalizeWithoutMutation(
    claim: ResearchPaperEvent,
    outcome: "REJECTED" | "ANALYSIS_ONLY" | "FAILED",
    reason: string
  ): void {
    if (this.repository.finalizeResearchPaperEvent(terminalEvent(
      claim,
      outcome,
      reason,
      this.now().toISOString()
    ))) this.options.onUpdate?.({ laneId: claim.laneId, wallet: claim.wallet, outcome });
  }

  private async readLeaderBalance(position: ResearchPaperPosition): Promise<bigint | undefined> {
    if (!this.options.readLeaderMintBalance) return undefined;
    try {
      const balance = await this.options.readLeaderMintBalance(position.wallet, position.mint);
      if (balance < 0n) throw new Error("negative leader balance");
      return balance;
    } catch {
      this.options.onError?.(new Error(
        "Research leader-balance reconciliation failed safely; simulated inventory was not changed."
      ));
      return undefined;
    }
  }

  private async reconcileLeaderBalance(
    laneId: string,
    account: ResearchPaperLeaderAccount,
    position: ResearchPaperPosition,
    currentBalance: bigint,
    observedAt: Date
  ): Promise<"NO_DECREASE" | "APPLIED" | "PENDING"> {
    const previousBalanceAtomic = position.leaderObservedBalanceAtomic ?? position.leaderRemainingAtomic;
    const previousBalance = BigInt(previousBalanceAtomic);
    if (currentBalance >= previousBalance) return "NO_DECREASE";
    if (!exitQuoteRetryDue(position, observedAt)) return "PENDING";
    const decrease = previousBalance - currentBalance;
    const plan = researchPaperExitPlan({
      followerRemainingAtomic: position.simulatedRemainingAtomic,
      leaderInitialAtomic: position.leaderInitialAtomic,
      leaderRemainingAtomic: position.leaderRemainingAtomic,
      sourceSellAtomic: decrease.toString()
    });
    if (!plan) return "PENDING";
    const claim: ResearchPaperEvent = {
      eventKey: balanceExitEventKey(
        laneId,
        position,
        previousBalanceAtomic,
        currentBalance.toString(),
        observedAt
      ),
      laneId,
      wallet: position.wallet,
      kind: plan.closesPosition ? "TRADE" : "SIGNAL",
      outcome: "CLAIMED",
      observedAt: observedAt.toISOString(),
      mint: position.mint,
      action: "SELL",
      strictReasonCodes: ["LEADER_BALANCE_DECREASE"]
    };
    if (!this.repository.claimResearchPaperEvent(claim)) return "PENDING";
    const committed = await this.simulateExit({
      claim,
      account,
      position,
      plan,
      details: {
        evidence: "BALANCE_RECONCILIATION",
        nextLeaderObservedBalanceAtomic: currentBalance.toString(),
        leaderBalanceObservedAt: observedAt.toISOString()
      }
    });
    return committed ? "APPLIED" : "PENDING";
  }

  private async markOpenPositions(dedupeNonce?: string): Promise<void> {
    const lane = this.repository.activeResearchPaperLane();
    if (!lane || !this.exactPaperLane(lane.id)) return;
    const startupTerminalProbe = dedupeNonce?.startsWith("startup:") === true;
    for (const initialAccount of this.repository.listResearchPaperLeaders(lane.id, 100)) {
      if (!this.exactPaperLane(lane.id)) return;
      let positions = this.repository.listResearchPaperPositions({
        laneId: lane.id,
        wallet: initialAccount.wallet,
        openOnly: true,
        limit: 100
      });
      if (positions.length === 0) continue;

      const observedBalances = new Map<string, bigint>();
      for (const candidate of positions) {
        if (!this.exactPaperLane(lane.id)) return;
        const position = this.repository.getResearchPaperPosition(candidate.id);
        if (!position || !["OPEN", "CLOSING", "UNPRICED"].includes(position.status)) continue;
        const currentBalance = await this.readLeaderBalance(position);
        if (currentBalance === undefined) continue;
        const account = this.repository.getResearchPaperLeader(lane.id, position.wallet);
        if (!account) continue;
        const balanceObservedAt = this.now();
        const result = await this.reconcileLeaderBalance(
          lane.id,
          account,
          position,
          currentBalance,
          balanceObservedAt
        );
        if (result !== "PENDING") observedBalances.set(position.id, currentBalance);
      }

      let account = this.repository.getResearchPaperLeader(lane.id, initialAccount.wallet);
      if (!account) continue;
      positions = this.repository.listResearchPaperPositions({
        laneId: lane.id,
        wallet: account.wallet,
        openOnly: true,
        limit: 100
      });
      if (positions.length === 0) continue;
      const observedAt = this.now();
      const claim: ResearchPaperEvent = {
        eventKey: markEventKey(lane.id, account.wallet, observedAt, dedupeNonce),
        laneId: lane.id,
        wallet: account.wallet,
        kind: "NAV_MARK",
        outcome: "CLAIMED",
        observedAt: observedAt.toISOString()
      };
      if (!this.repository.claimResearchPaperEvent(claim)) continue;
      const marked: ResearchPaperPosition[] = [];
      for (const position of positions) {
        const retryCheckedAt = this.now();
        const openedAt = Date.parse(position.openedAt);
        const overdueStartupProbe = startupTerminalProbe &&
          position.status === "UNPRICED" &&
          (position.exitQuoteFailureCount ?? 0) >= RESEARCH_STARTUP_TERMINAL_PROBE_MINIMUM_FAILURES &&
          Number.isFinite(openedAt) &&
          retryCheckedAt.getTime() - openedAt >= RESEARCH_TERMINAL_WRITE_OFF_MINIMUM_AGE_MS &&
          Number.isFinite(Date.parse(position.lastExitQuoteAttemptAt ?? "")) &&
          retryCheckedAt.getTime() - Date.parse(position.lastExitQuoteAttemptAt!) >= RESEARCH_MARK_INTERVAL_MS;
        if (!exitQuoteRetryDue(position, retryCheckedAt) && !overdueStartupProbe) {
          marked.push({
            ...position,
            lastExecutableValueUsd: 0,
            status: "UNPRICED"
          });
          continue;
        }
        const request: QuoteRequest = {
          inputMint: position.mint,
          outputMint: USDC_MINT,
          inputAmountAtomic: position.simulatedRemainingAtomic
        };
        try {
          const quote = await this.options.quote(request);
          if (!this.exactPaperLane(lane.id)) {
            this.finalizeWithoutMutation(claim, "ANALYSIS_ONLY", "PAPER mode ended during research NAV marking.");
            return;
          }
          if (!quoteMatches(quote, request, this.now())) throw new InvalidResearchExitQuoteError();
          const costs = researchPaperModeledQuoteCostUsd(quote, this.options.solPriceUsd());
          const observedBalance = observedBalances.get(position.id);
          marked.push(clearExitQuoteRetry({
            ...position,
            ...(observedBalance !== undefined
              ? {
                  leaderObservedBalanceAtomic: observedBalance.toString(),
                  leaderBalanceObservedAt: observedAt.toISOString()
                }
              : {}),
            lastExecutableValueUsd: Math.max(0, quote.outputUsd - costs),
            status: "OPEN",
            updatedAt: this.now().toISOString()
          }));
        } catch (error) {
          const observedBalance = observedBalances.get(position.id);
          const code = classifyExitQuoteFailure(error);
          const failed = withExitQuoteFailure({
            ...position,
            ...(observedBalance !== undefined
              ? {
                  leaderObservedBalanceAtomic: observedBalance.toString(),
                  leaderBalanceObservedAt: observedAt.toISOString()
                }
              : {}),
            lastExecutableValueUsd: 0
          }, this.now(), code);
          if (await this.tryTerminalWriteOff(lane.id, position, failed, this.now())) {
            account = this.repository.getResearchPaperLeader(lane.id, initialAccount.wallet);
            if (!account) return;
            continue;
          }
          marked.push(failed);
        }
      }
      if (!this.exactPaperLane(lane.id)) {
        this.finalizeWithoutMutation(claim, "ANALYSIS_ONLY", "PAPER mode ended before the NAV mark committed.");
        return;
      }
      const at = this.now().toISOString();
      const nextAccount = recalculateAccount(account, marked, { at });
      const event = terminalEvent(
        claim,
        "SIMULATED",
        this.options.readLeaderMintBalance
          ? "Confirmed leader balances and quote-only executable values were refreshed; no transaction was built or signed."
          : "Quote-only executable values were refreshed; no transaction was built or signed.",
        at,
        { navUsd: nextAccount.navUsd }
      );
      if (this.repository.commitResearchPaperEvent({ event, account: nextAccount, positions: marked })) {
        this.options.onUpdate?.({ laneId: lane.id, wallet: account.wallet, outcome: "NAV_MARK" });
      }
    }
  }
}
