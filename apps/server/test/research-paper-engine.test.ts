import { afterEach, describe, expect, it, vi } from "vitest";
import {
  USDC_MINT,
  type LeaderSwap,
  type ModeState,
  type QuoteRequest,
  type QuoteSnapshot,
  type TokenEligibility
} from "@copylab/shared";
import { JupiterQuoteError } from "@copylab/providers";
import type { CopyLabDatabase } from "../src/database.js";
import { openDatabase } from "../src/database.js";
import { Repository } from "../src/repository.js";
import {
  ResearchPaperEngine,
  type ResearchPaperSourceAction
} from "../src/research-paper.js";

const WALLET = "research-leader-wallet";
const MINT = "research-target-mint";

function leaderSwap(
  signature: string,
  at: Date,
  side: "BUY" | "SELL" = "BUY",
  targetAmountAtomic = "2000"
): LeaderSwap {
  return {
    sourceSignature: signature,
    sourceWallet: WALLET,
    slot: 1,
    blockTime: at.toISOString(),
    detectedAt: at.toISOString(),
    side,
    baseMint: USDC_MINT,
    targetMint: MINT,
    baseAmountAtomic: "1000000",
    targetAmountAtomic,
    baseAmountUi: 1,
    targetAmountUi: Number(targetAmountAtomic) / 1_000,
    leaderPriceUsd: 1,
    recovered: false
  };
}

function researchAction(swap: LeaderSwap): ResearchPaperSourceAction {
  return {
    source: {
      sourceSignature: swap.sourceSignature,
      sourceWallet: swap.sourceWallet,
      slot: swap.slot,
      blockTime: swap.blockTime,
      detectedAt: swap.detectedAt,
      side: swap.side,
      baseMint: swap.baseMint,
      targetMint: swap.targetMint,
      recovered: swap.recovered
    },
    baseAmountAtomic: swap.baseAmountAtomic,
    targetAmountAtomic: swap.targetAmountAtomic,
    baseAmountUi: swap.baseAmountUi,
    targetAmountUi: swap.targetAmountUi,
    strictReasonCodes: ["UNSUPPORTED_PROGRAM_ACTIVITY"]
  };
}

function quoteFor(request: QuoteRequest, at: Date): QuoteSnapshot {
  const buying = request.inputMint === USDC_MINT;
  const inputUsd = buying ? Number(BigInt(request.inputAmountAtomic)) / 1_000_000 : 13.5;
  return {
    requestId: `research-${buying ? "buy" : "sell"}`,
    quotedAt: at.toISOString(),
    inputMint: request.inputMint,
    outputMint: request.outputMint,
    inputAmountAtomic: request.inputAmountAtomic,
    outputAmountAtomic: buying ? "1000000" : "13000000",
    inputUsd,
    outputUsd: buying ? 13.5 : 13,
    // These deliberately violate strict thresholds; the isolated comparison
    // still accepts the quote while modeling its costs.
    priceImpactPercent: 49,
    slippageBps: 5_000,
    feeBps: 100,
    signatureFeeLamports: 5_000,
    prioritizationFeeLamports: 10_000,
    rentFeeLamports: 0,
    minimumOutputAtomic: "1",
    router: "high-risk-research"
  };
}

describe("isolated high-risk PAPER engine", () => {
  let db: CopyLabDatabase | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  function setup(policy: Record<string, unknown> = {}) {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const lane = repository.createResearchPaperLane({
      id: "research-lane",
      policyVersion: "high-risk-paper-v1",
      policy,
      initialNavPerLeaderUsd: 141
    });
    repository.initializeResearchPaperLeader(WALLET, lane.id, "2026-07-13T12:00:00.000Z");
    let mode: ModeState = "PAPER";
    let now = new Date("2026-07-13T12:00:00.000Z");
    let leaderBalance = 2_000n;
    let leaderBalanceError = false;
    let tokenOverrides: Partial<TokenEligibility> = {};
    const quote = vi.fn(async (request: QuoteRequest) => quoteFor(request, now));
    const checkToken = vi.fn(async (): Promise<TokenEligibility> => ({
      mint: MINT,
      checkedAt: now.toISOString(),
      eligible: true,
      reasons: [],
      verified: true,
      suspicious: false,
      mintAuthorityDisabled: true,
      freezeAuthorityDisabled: true,
      liquidityUsd: 10_000_000,
      volume24hUsd: 2_000_000,
      holderCount: 10_000,
      organicScore: 90,
      topHoldersPercent: 10,
      ...tokenOverrides
    }));
    const readLeaderMintBalance = vi.fn(async () => {
      if (leaderBalanceError) throw new Error("leader balance unavailable");
      return leaderBalance;
    });
    const engine = new ResearchPaperEngine(repository, {
      mode: () => mode,
      quote,
      checkToken,
      readLeaderMintBalance,
      solPriceUsd: () => 200,
      now: () => now
    });
    return {
      repository,
      engine,
      quote,
      checkToken,
      readLeaderMintBalance,
      setMode: (next: ModeState) => { mode = next; },
      setNow: (next: Date) => { now = next; },
      setLeaderBalance: (next: bigint) => { leaderBalance = next; },
      setLeaderBalanceError: (next: boolean) => { leaderBalanceError = next; },
      setToken: (next: Partial<TokenEligibility>) => { tokenOverrides = next; }
    };
  }

  it("simulates a high-impact buy only in research tables and deduplicates it durably", async () => {
    const { repository, engine, quote } = setup();
    const swap = leaderSwap("research-buy", new Date("2026-07-13T12:00:00.000Z"));
    repository.insertSourceEvent(swap);

    await engine.enqueue(researchAction(swap));
    await engine.enqueue(researchAction(swap));

    const dashboard = repository.researchPaperDashboard();
    expect(quote).toHaveBeenCalledTimes(2);
    expect(dashboard).toMatchObject({ promotionEligible: false, executionEnabled: false });
    expect(dashboard.positions).toEqual([
      expect.objectContaining({
        wallet: WALLET,
        mint: MINT,
        status: "OPEN",
        leaderInitialAtomic: "2000",
        leaderObservedBalanceAtomic: "2000",
        simulatedInitialAtomic: "1000000"
      })
    ]);
    expect(dashboard.recentSignals).toHaveLength(1);
    expect(dashboard.recentSignals[0]).toMatchObject({ outcome: "SIMULATED", action: "BUY" });
    expect(dashboard.leaders[0]?.navUsd).toBeLessThan(141);

    expect(repository.db.prepare("SELECT COUNT(*) AS count FROM signal_decisions").get()).toEqual({ count: 0 });
    expect(repository.listExecutions()).toEqual([]);
    expect(repository.listPositions()).toEqual([]);
    expect(repository.listClosedTrades("PAPER")).toEqual([]);
    expect(repository.latestPortfolioSnapshot("PAPER")).toBeUndefined();
  });

  it("uses the revised lane policy for a $25 future entry without touching strict state", async () => {
    const { repository, engine, quote } = setup({
      positionNavFraction: 0.2,
      maximumPositionUsd: 25,
      maximumOpenPositions: 3,
      maximumDeployedFraction: 0.3,
      minimumLiquidReserveUsd: 10
    });
    const swap = leaderSwap("research-larger-buy", new Date("2026-07-13T12:00:00.000Z"));
    repository.insertSourceEvent(swap);

    await engine.enqueue(researchAction(swap));

    expect(quote.mock.calls[0]?.[0]).toMatchObject({ inputAmountAtomic: "25000000" });
    expect(repository.researchPaperDashboard().positions[0]).toMatchObject({
      status: "OPEN",
      entryCostUsd: 25.253,
      remainingCostUsd: 25.253
    });
    expect(repository.listPositions()).toEqual([]);
    expect(repository.listExecutions()).toEqual([]);
  });

  it("keeps recovered activity analysis-only and never requests a quote", async () => {
    const { repository, engine, quote } = setup();
    const swap = leaderSwap("research-recovered", new Date("2026-07-13T12:00:00.000Z"));
    swap.recovered = true;
    repository.insertSourceEvent(swap);

    await engine.enqueue(researchAction(swap));

    expect(quote).not.toHaveBeenCalled();
    expect(repository.researchPaperDashboard().recentSignals[0]).toMatchObject({
      outcome: "ANALYSIS_ONLY",
      action: "BUY"
    });
    expect(repository.listResearchPaperPositions({ laneId: "research-lane", openOnly: true })).toEqual([]);
  });

  it("rechecks exact mode after provider I/O and cannot commit after PAPER ends", async () => {
    const { repository, engine, setMode } = setup();
    const swap = leaderSwap("research-mode-change", new Date("2026-07-13T12:00:00.000Z"));
    repository.insertSourceEvent(swap);
    let resolveQuote!: (quote: QuoteSnapshot) => void;
    const pending = new Promise<QuoteSnapshot>((resolve) => { resolveQuote = resolve; });
    const deferredEngine = new ResearchPaperEngine(repository, {
      mode: () => repository.getSetting<ModeState>("test_mode") ?? "PAPER",
      quote: () => pending,
      solPriceUsd: () => 200,
      now: () => new Date("2026-07-13T12:00:00.000Z")
    });
    repository.setSetting("test_mode", "PAPER");
    const task = deferredEngine.enqueue(researchAction(swap));
    await Promise.resolve();
    repository.setSetting("test_mode", "MANUAL_LIVE");
    setMode("MANUAL_LIVE");
    resolveQuote(quoteFor({
      inputMint: USDC_MINT,
      outputMint: MINT,
      inputAmountAtomic: "14100000"
    }, new Date("2026-07-13T12:00:00.000Z")));
    await task;

    expect(repository.listResearchPaperPositions({ laneId: "research-lane", openOnly: true })).toEqual([]);
    expect(repository.researchPaperDashboard().recentSignals[0]).toMatchObject({ outcome: "ANALYSIS_ONLY" });
    expect(repository.listExecutions()).toEqual([]);
  });

  it("revalidates both entry and full-position exit quotes after the leader-balance RPC", async () => {
    const { repository } = setup();
    const openedAt = new Date("2026-07-13T12:00:00.000Z");
    const swap = leaderSwap("research-final-quote-clock", openedAt);
    repository.insertSourceEvent(swap);
    let now = openedAt;
    const quote = vi.fn(async (request: QuoteRequest) => quoteFor(request, now));
    const delayedEngine = new ResearchPaperEngine(repository, {
      mode: () => "PAPER",
      quote,
      readLeaderMintBalance: async () => {
        now = new Date(openedAt.getTime() + 6_000);
        return 2_000n;
      },
      solPriceUsd: () => 200,
      now: () => now
    });

    await delayedEngine.enqueue(researchAction(swap));

    expect(quote).toHaveBeenCalledTimes(2);
    expect(repository.listResearchPaperPositions({ laneId: "research-lane", openOnly: true }))
      .toEqual([]);
    expect(repository.researchPaperDashboard().recentSignals[0]).toMatchObject({
      outcome: "ANALYSIS_ONLY",
      action: "BUY"
    });
    expect(repository.researchPaperDashboard().recentSignals[0]?.reason)
      .toContain("entry/exit quote validity changed");
    expect(repository.listExecutions()).toEqual([]);
    expect(repository.listPositions()).toEqual([]);
  });

  it("mirrors the leader exit, closes the isolated lot, and never creates a strict trade", async () => {
    const { repository, engine, setNow } = setup();
    const buy = leaderSwap("research-roundtrip-buy", new Date("2026-07-13T12:00:00.000Z"));
    repository.insertSourceEvent(buy);
    await engine.enqueue(researchAction(buy));

    setNow(new Date("2026-07-13T12:00:05.000Z"));
    const sell = leaderSwap("research-roundtrip-sell", new Date("2026-07-13T12:00:05.000Z"), "SELL", "1800");
    repository.insertSourceEvent(sell);
    await engine.enqueue(researchAction(sell));

    const dashboard = repository.researchPaperDashboard();
    expect(dashboard.positions).toEqual([]);
    expect(dashboard.recentTrades).toHaveLength(1);
    expect(dashboard.recentTrades[0]).toMatchObject({
      sourceEntrySignature: buy.sourceSignature,
      sourceExitSignature: sell.sourceSignature
    });
    expect(dashboard.leaders[0]).toMatchObject({ openPositions: 0, completedTrades: 1 });
    expect(repository.listClosedTrades("PAPER")).toEqual([]);
    expect(repository.listExecutions()).toEqual([]);
    expect(repository.listPositions()).toEqual([]);
  });

  it("deduplicates a research token decrease and normal sell from the same transaction", async () => {
    const { repository, engine, quote, setNow } = setup();
    const buy = leaderSwap("research-dedupe-buy", new Date("2026-07-13T12:00:00.000Z"));
    repository.insertSourceEvent(buy);
    await engine.enqueue(researchAction(buy));

    setNow(new Date("2026-07-13T12:00:05.000Z"));
    const sell = leaderSwap(
      "research-shared-exit",
      new Date("2026-07-13T12:00:05.000Z"),
      "SELL",
      "500"
    );
    const decrease = researchAction(sell);
    decrease.strictReasonCodes = ["LEADER_TOKEN_BALANCE_DECREASE"];
    await engine.enqueue(decrease);
    await engine.enqueue(researchAction(sell));

    expect(repository.researchPaperDashboard().positions[0]).toMatchObject({
      leaderRemainingAtomic: "1500",
      leaderObservedBalanceAtomic: "1500",
      simulatedRemainingAtomic: "750000"
    });
    expect(quote).toHaveBeenCalledTimes(3);
    const exits = repository.listResearchPaperEvents({ laneId: "research-lane", limit: 100 })
      .filter((event) => event.action === "SELL");
    expect(exits).toHaveLength(1);
  });

  it("closes a stale research lot when confirmed leader inventory reaches zero", async () => {
    const { repository, engine, setNow, setLeaderBalance } = setup();
    const buy = leaderSwap("research-balance-buy", new Date("2026-07-13T12:00:00.000Z"));
    repository.insertSourceEvent(buy);
    await engine.enqueue(researchAction(buy));

    setLeaderBalance(0n);
    setNow(new Date("2026-07-13T12:05:00.000Z"));
    await engine.enqueueMarks();

    const dashboard = repository.researchPaperDashboard();
    expect(dashboard.positions).toEqual([]);
    expect(dashboard.recentTrades).toEqual([
      expect.objectContaining({
        sourceEntrySignature: buy.sourceSignature,
        exitEvidence: "BALANCE_RECONCILIATION"
      })
    ]);
    expect(dashboard.recentTrades[0]?.sourceExitSignature).toBeUndefined();
    expect(dashboard.leaders[0]).toMatchObject({ openPositions: 0, completedTrades: 1 });
    expect(repository.listPositions()).toEqual([]);
    expect(repository.listExecutions()).toEqual([]);
  });

  it("mirrors a partial confirmed balance decrease once and advances its durable baseline", async () => {
    const { repository, engine, setNow, setLeaderBalance } = setup();
    const buy = leaderSwap("research-partial-balance-buy", new Date("2026-07-13T12:00:00.000Z"));
    repository.insertSourceEvent(buy);
    await engine.enqueue(researchAction(buy));

    setLeaderBalance(1_500n);
    setNow(new Date("2026-07-13T12:05:00.000Z"));
    await engine.enqueueMarks();
    let position = repository.researchPaperDashboard().positions[0];
    expect(position).toMatchObject({
      leaderRemainingAtomic: "1500",
      leaderObservedBalanceAtomic: "1500",
      simulatedRemainingAtomic: "750000",
      status: "OPEN"
    });
    expect(repository.researchPaperDashboard().leaders[0]?.completedTrades).toBe(0);

    setNow(new Date("2026-07-13T12:10:00.000Z"));
    await engine.enqueueMarks();
    position = repository.researchPaperDashboard().positions[0];
    expect(position).toMatchObject({
      leaderRemainingAtomic: "1500",
      simulatedRemainingAtomic: "750000"
    });
    const balanceExits = repository.listResearchPaperEvents({ laneId: "research-lane", limit: 100 })
      .filter((event) => event.strictReasonCodes?.includes("LEADER_BALANCE_DECREASE"));
    expect(balanceExits).toHaveLength(1);
  });

  it("persists an immediate restart checkpoint even when the periodic mark bucket already exists", async () => {
    const { repository, engine } = setup();
    const buy = leaderSwap("research-restart-checkpoint-buy", new Date("2026-07-13T12:00:00.000Z"));
    repository.insertSourceEvent(buy);
    await engine.enqueue(researchAction(buy));
    await engine.enqueueMarks();

    const marked = repository.researchPaperDashboard().positions[0];
    expect(marked).toBeDefined();
    const legacyPosition = { ...marked! };
    delete legacyPosition.leaderObservedBalanceAtomic;
    delete legacyPosition.leaderBalanceObservedAt;
    repository.upsertResearchPaperPosition(legacyPosition);

    await engine.enqueueMarks();
    expect(repository.researchPaperDashboard().positions[0]?.leaderObservedBalanceAtomic).toBeUndefined();

    await engine.enqueueMarks("startup:test-boot");
    expect(repository.researchPaperDashboard().positions[0]).toMatchObject({
      leaderObservedBalanceAtomic: "2000",
      leaderBalanceObservedAt: "2026-07-13T12:00:00.000Z"
    });
    const navMarks = repository.listResearchPaperEvents({ laneId: "research-lane", limit: 100 })
      .filter((event) => event.kind === "NAV_MARK");
    expect(navMarks).toHaveLength(2);
  });

  it("uses the post-entry aggregate balance so pre-existing inventory cannot mask a later exit", async () => {
    const { repository, engine, setNow, setLeaderBalance } = setup();
    setLeaderBalance(10_000n);
    const buy = leaderSwap("research-preexisting-balance-buy", new Date("2026-07-13T12:00:00.000Z"));
    repository.insertSourceEvent(buy);
    await engine.enqueue(researchAction(buy));
    expect(repository.researchPaperDashboard().positions[0]?.leaderObservedBalanceAtomic).toBe("10000");

    setLeaderBalance(8_000n);
    setNow(new Date("2026-07-13T12:05:00.000Z"));
    await engine.enqueueMarks();

    expect(repository.researchPaperDashboard().positions).toEqual([]);
    expect(repository.researchPaperDashboard().recentTrades[0]).toMatchObject({
      exitEvidence: "BALANCE_RECONCILIATION"
    });
  });

  it("leaves inventory unchanged on a balance-read failure and retries a later confirmed decrease", async () => {
    const {
      repository,
      engine,
      setNow,
      setLeaderBalance,
      setLeaderBalanceError
    } = setup();
    const buy = leaderSwap("research-balance-retry-buy", new Date("2026-07-13T12:00:00.000Z"));
    repository.insertSourceEvent(buy);
    await engine.enqueue(researchAction(buy));

    setLeaderBalance(0n);
    setLeaderBalanceError(true);
    setNow(new Date("2026-07-13T12:05:00.000Z"));
    await engine.enqueueMarks();
    expect(repository.researchPaperDashboard().positions[0]).toMatchObject({
      leaderRemainingAtomic: "2000",
      leaderObservedBalanceAtomic: "2000"
    });

    setLeaderBalanceError(false);
    setNow(new Date("2026-07-13T12:10:00.000Z"));
    await engine.enqueueMarks();
    expect(repository.researchPaperDashboard().positions).toEqual([]);
  });

  it("fails a missing entry quote inside the research ledger without touching strict state", async () => {
    const { repository } = setup();
    const swap = leaderSwap("research-quote-failure", new Date("2026-07-13T12:00:00.000Z"));
    repository.insertSourceEvent(swap);
    const engine = new ResearchPaperEngine(repository, {
      mode: () => "PAPER",
      quote: async () => { throw new Error("provider secret must not persist"); },
      solPriceUsd: () => 200,
      now: () => new Date("2026-07-13T12:00:00.000Z")
    });

    await engine.enqueue(researchAction(swap));

    const event = repository.researchPaperDashboard().recentSignals[0];
    expect(event).toMatchObject({ outcome: "REJECTED" });
    expect(event?.reason).not.toContain("secret");
    expect(repository.listExecutions()).toEqual([]);
    expect(repository.listPositions()).toEqual([]);
    expect(repository.db.prepare("SELECT COUNT(*) AS count FROM signal_decisions").get()).toEqual({ count: 0 });
  });

  it("keeps a non-routable entry in the research ledger without creating unsellable inventory", async () => {
    const { repository, engine, quote } = setup();
    const swap = leaderSwap("research-no-route-buy", new Date("2026-07-13T12:00:00.000Z"));
    repository.insertSourceEvent(swap);
    quote.mockImplementation(async (request) => {
      if (request.inputMint !== USDC_MINT) {
        throw new JupiterQuoteError(
          "NO_ROUTES_FOUND",
          "no executable route exists for the requested pair and amount"
        );
      }
      return quoteFor(request, new Date("2026-07-13T12:00:00.000Z"));
    });

    await engine.enqueue(researchAction(swap));

    expect(repository.researchPaperDashboard().positions).toEqual([]);
    expect(repository.researchPaperDashboard().recentSignals[0]).toMatchObject({
      outcome: "REJECTED",
      action: "BUY"
    });
    expect(repository.researchPaperDashboard().recentSignals[0]?.reason)
      .toContain("immediate full-position sellability is required");
    expect(repository.listExecutions()).toEqual([]);
    expect(repository.listPositions()).toEqual([]);
  });

  it("writes off an overdue legacy lot only after six consecutive fresh no-route probes and terminal token evidence", async () => {
    const {
      repository,
      engine,
      quote,
      checkToken,
      setNow,
      setToken
    } = setup();
    const buy = leaderSwap("research-terminal-writeoff-buy", new Date("2026-07-13T12:00:00.000Z"));
    repository.insertSourceEvent(buy);
    await engine.enqueue(researchAction(buy));

    const open = repository.researchPaperDashboard().positions[0]!;
    const overdueAt = new Date("2026-07-21T12:00:00.000Z");
    repository.upsertResearchPaperPosition({
      ...open,
      lastExecutableValueUsd: 0,
      status: "UNPRICED",
      exitQuoteFailureCount: 303,
      lastExitQuoteAttemptAt: "2026-07-21T11:00:00.000Z",
      nextExitQuoteRetryAt: "2026-07-21T13:00:00.000Z",
      lastExitQuoteFailureCode: "JUPITER_EXIT_QUOTE_UNAVAILABLE",
      updatedAt: "2026-07-21T11:00:00.000Z"
    });
    const before = repository.getResearchPaperLeader("research-lane", WALLET)!;
    repository.upsertResearchPaperLeader({
      ...before,
      navUsd: before.cashUsd,
      unrealizedPnlUsd: before.cashUsd - before.initialNavUsd - before.realizedPnlUsd,
      pricingComplete: false,
      updatedAt: "2026-07-21T11:00:00.000Z"
    });
    quote.mockImplementation(async (request) => {
      if (request.inputMint === MINT) {
        throw new JupiterQuoteError(
          "NO_ROUTES_FOUND",
          "no executable route exists for the requested pair and amount"
        );
      }
      return quoteFor(request, overdueAt);
    });
    setNow(overdueAt);
    setToken({
      eligible: false,
      reasons: [
        "NOT_VERIFIED",
        "SUSPICIOUS_OR_BANNED",
        "INSUFFICIENT_LIQUIDITY",
        "INSUFFICIENT_24H_VOLUME",
        "INSUFFICIENT_HOLDERS"
      ],
      verified: false,
      suspicious: true,
      liquidityUsd: 0.00002,
      volume24hUsd: 0,
      holderCount: 3,
      organicScore: 0,
      topHoldersPercent: 100
    });

    // The old durable retry is still an hour away. A startup mark is allowed
    // one bounded fresh probe, but hundreds of historical service failures do
    // not count as repeated no-route evidence.
    await engine.enqueueMarks("startup:terminal-writeoff-test");

    expect(checkToken).not.toHaveBeenCalled();
    expect(repository.researchPaperDashboard().recentTrades).toEqual([]);
    expect(repository.getResearchPaperPosition(open.id)).toMatchObject({
      status: "UNPRICED",
      exitQuoteFailureCount: 304,
      consecutiveExitNoRouteFailureCount: 1,
      lastExitQuoteFailureCode: "JUPITER_EXIT_NO_ROUTE",
      nextExitQuoteRetryAt: "2026-07-21T12:04:00.000Z"
    });
    await engine.enqueueMarks("startup:terminal-writeoff-no-burst");
    expect(quote).toHaveBeenCalledTimes(3);
    expect(repository.getResearchPaperPosition(open.id)?.consecutiveExitNoRouteFailureCount).toBe(1);

    // Honest, bounded probes accumulate over their persisted due times. They
    // are deliberately not issued in a burst to manufacture terminal evidence.
    for (let attempt = 2; attempt <= 6; attempt += 1) {
      const retryAt = repository.getResearchPaperPosition(open.id)?.nextExitQuoteRetryAt;
      expect(retryAt).toBeDefined();
      setNow(new Date(retryAt!));
      await engine.enqueueMarks(`terminal-writeoff-streak:${attempt}`);
    }

    const dashboard = repository.researchPaperDashboard();
    expect(quote).toHaveBeenCalledTimes(8);
    expect(checkToken).toHaveBeenCalledTimes(1);
    expect(dashboard.positions).toEqual([]);
    expect(dashboard.recentTrades[0]).toMatchObject({
      positionId: open.id,
      exitEvidence: "TERMINAL_UNROUTABLE_WRITEOFF",
      proceedsUsd: 0,
      modeledCostsUsd: 0,
      costBasisUsd: open.remainingCostUsd,
      pnlUsd: -open.remainingCostUsd
    });
    expect(dashboard.recentSignals[0]).toMatchObject({
      outcome: "SIMULATED",
      action: "SELL",
      strictReasonCodes: ["PAPER_TERMINAL_WRITEOFF", "TOKEN_SAFETY_FAILURE"]
    });
    expect(dashboard.recentSignals[0]?.reason).toContain("not an executable sale");
    expect(dashboard.leaders[0]).toMatchObject({
      navUsd: before.cashUsd,
      realizedPnlUsd: before.realizedPnlUsd - open.remainingCostUsd,
      pricingComplete: true,
      openPositions: 0,
      completedTrades: 1
    });
    expect(repository.getResearchPaperPosition(open.id)).toMatchObject({
      status: "CLOSED",
      simulatedRemainingAtomic: "0",
      remainingCostUsd: 0,
      lastExecutableValueUsd: 0
    });
    expect(repository.getResearchPaperPosition(open.id)?.exitQuoteFailureCount).toBeUndefined();
    expect(repository.listExecutions()).toEqual([]);
    expect(repository.listPositions()).toEqual([]);
  });

  it("resets consecutive no-route evidence during a temporary quote-service failure", async () => {
    const { repository, engine, quote, checkToken, setNow, setToken } = setup();
    const buy = leaderSwap("research-transient-writeoff-guard-buy", new Date("2026-07-13T12:00:00.000Z"));
    repository.insertSourceEvent(buy);
    await engine.enqueue(researchAction(buy));
    const open = repository.researchPaperDashboard().positions[0]!;
    repository.upsertResearchPaperPosition({
      ...open,
      lastExecutableValueUsd: 0,
      status: "UNPRICED",
      exitQuoteFailureCount: 303,
      consecutiveExitNoRouteFailureCount: 5,
      lastExitQuoteAttemptAt: "2026-07-21T11:00:00.000Z",
      nextExitQuoteRetryAt: "2026-07-21T13:00:00.000Z",
      lastExitQuoteFailureCode: "JUPITER_EXIT_NO_ROUTE",
      updatedAt: "2026-07-21T11:00:00.000Z"
    });
    quote.mockImplementation(async (request) => {
      if (request.inputMint === MINT) throw new Error("temporary service timeout");
      return quoteFor(request, new Date("2026-07-21T12:00:00.000Z"));
    });
    setNow(new Date("2026-07-21T12:00:00.000Z"));
    setToken({
      eligible: false,
      reasons: ["SUSPICIOUS_OR_BANNED", "INSUFFICIENT_LIQUIDITY"],
      suspicious: true,
      liquidityUsd: 0,
      volume24hUsd: 0,
      holderCount: 1
    });

    await engine.enqueueMarks("startup:transient-writeoff-guard");

    expect(checkToken).not.toHaveBeenCalled();
    expect(repository.researchPaperDashboard().positions[0]).toMatchObject({
      id: open.id,
      status: "UNPRICED",
      exitQuoteFailureCount: 304,
      lastExitQuoteFailureCode: "JUPITER_EXIT_QUOTE_UNAVAILABLE"
    });
    expect(repository.researchPaperDashboard().positions[0]?.consecutiveExitNoRouteFailureCount)
      .toBeUndefined();
    expect(repository.researchPaperDashboard().recentTrades).toEqual([]);
  });

  it("persists exponential exit-quote backoff across an engine restart and closes only after a valid quote", async () => {
    const {
      repository,
      engine,
      quote,
      setNow,
      setLeaderBalance
    } = setup();
    const buy = leaderSwap("research-durable-backoff-buy", new Date("2026-07-13T12:00:00.000Z"));
    repository.insertSourceEvent(buy);
    await engine.enqueue(researchAction(buy));
    expect(quote).toHaveBeenCalledTimes(2);

    quote.mockImplementation(async (request) => {
      if (request.inputMint === MINT) throw new Error("provider secret must not persist");
      return quoteFor(request, new Date("2026-07-13T12:05:00.000Z"));
    });
    setLeaderBalance(0n);
    setNow(new Date("2026-07-13T12:05:00.000Z"));
    await engine.enqueueMarks("durable-backoff:first-failure");

    const openId = repository.researchPaperDashboard().positions[0]!.id;
    expect(quote).toHaveBeenCalledTimes(3);
    expect(repository.getResearchPaperPosition(openId)).toMatchObject({
      status: "UNPRICED",
      lastExecutableValueUsd: 0,
      exitQuoteFailureCount: 1,
      lastExitQuoteAttemptAt: "2026-07-13T12:05:00.000Z",
      nextExitQuoteRetryAt: "2026-07-13T12:10:00.000Z",
      lastExitQuoteFailureCode: "JUPITER_EXIT_QUOTE_UNAVAILABLE"
    });
    expect(repository.researchPaperDashboard().leaders[0]).toMatchObject({
      pricingComplete: false,
      openPositions: 1
    });
    let rejectedBalanceExits = repository.listResearchPaperEvents({ laneId: "research-lane", limit: 100 })
      .filter((event) => event.strictReasonCodes?.includes("LEADER_BALANCE_DECREASE") &&
        event.outcome === "REJECTED");
    expect(rejectedBalanceExits).toHaveLength(1);
    expect(rejectedBalanceExits[0]?.reason).not.toContain("secret");

    let restartedAt = new Date("2026-07-13T12:06:00.000Z");
    const restarted = new ResearchPaperEngine(repository, {
      mode: () => "PAPER",
      quote,
      readLeaderMintBalance: async () => 0n,
      solPriceUsd: () => 200,
      now: () => restartedAt
    });
    await restarted.enqueueMarks("durable-backoff:restart-before-due");
    expect(quote).toHaveBeenCalledTimes(3);
    expect(repository.getResearchPaperPosition(openId)).toMatchObject({
      exitQuoteFailureCount: 1,
      nextExitQuoteRetryAt: "2026-07-13T12:10:00.000Z"
    });
    rejectedBalanceExits = repository.listResearchPaperEvents({ laneId: "research-lane", limit: 100 })
      .filter((event) => event.strictReasonCodes?.includes("LEADER_BALANCE_DECREASE") &&
        event.outcome === "REJECTED");
    expect(rejectedBalanceExits).toHaveLength(1);

    restartedAt = new Date("2026-07-13T12:10:00.000Z");
    await restarted.enqueueMarks("durable-backoff:second-failure");
    expect(quote).toHaveBeenCalledTimes(4);
    expect(repository.getResearchPaperPosition(openId)).toMatchObject({
      status: "UNPRICED",
      exitQuoteFailureCount: 2,
      lastExitQuoteAttemptAt: "2026-07-13T12:10:00.000Z",
      nextExitQuoteRetryAt: "2026-07-13T12:20:00.000Z"
    });

    restartedAt = new Date("2026-07-13T12:19:00.000Z");
    await restarted.enqueueMarks("durable-backoff:second-wait");
    expect(quote).toHaveBeenCalledTimes(4);

    quote.mockImplementation(async (request) => quoteFor(request, restartedAt));
    restartedAt = new Date("2026-07-13T12:20:00.000Z");
    await restarted.enqueueMarks("durable-backoff:recovered");
    expect(quote).toHaveBeenCalledTimes(5);
    expect(repository.researchPaperDashboard().positions).toEqual([]);
    expect(repository.getResearchPaperPosition(openId)).toMatchObject({
      status: "CLOSED",
      lastExecutableValueUsd: 0
    });
    const closed = repository.getResearchPaperPosition(openId)!;
    expect(closed.exitQuoteFailureCount).toBeUndefined();
    expect(closed.lastExitQuoteAttemptAt).toBeUndefined();
    expect(closed.nextExitQuoteRetryAt).toBeUndefined();
    expect(closed.lastExitQuoteFailureCode).toBeUndefined();
    expect(repository.researchPaperDashboard().recentTrades).toEqual([
      expect.objectContaining({
        sourceEntrySignature: buy.sourceSignature,
        exitEvidence: "BALANCE_RECONCILIATION"
      })
    ]);
    expect(repository.researchPaperDashboard().leaders[0]).toMatchObject({
      pricingComplete: true,
      openPositions: 0,
      completedTrades: 1
    });
    expect(repository.listExecutions()).toEqual([]);
    expect(repository.listPositions()).toEqual([]);
  });
});
