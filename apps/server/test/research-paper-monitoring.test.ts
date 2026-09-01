import { afterEach, describe, expect, it, vi } from "vitest";
import {
  USDC_MINT,
  type LeaderSwap,
  type QuoteRequest,
  type QuoteSnapshot,
  type RejectedSourceAction,
  type ResearchPaperWatchlistMember
} from "@copylab/shared";
import type { RejectedSwapObservation } from "@copylab/providers";
import type { CopyLabDatabase } from "../src/database.js";
import { openDatabase } from "../src/database.js";
import { EventBus } from "../src/events.js";
import { ModeManager } from "../src/mode.js";
import { Repository } from "../src/repository.js";
import { TradingRuntime } from "../src/runtime.js";
import { SecretVault } from "../src/vault.js";
import { DpapiTransactionSigner, WalletManager } from "../src/wallet.js";

const RESEARCH_WALLET = "research-wallet-active";
const TARGET_MINT = "research-target-mint";

function quote(request: QuoteRequest): QuoteSnapshot {
  const entry = request.inputMint === USDC_MINT;
  return {
    requestId: `research-quote-${entry ? "entry" : "exit"}`,
    quotedAt: new Date().toISOString(),
    inputMint: request.inputMint,
    outputMint: request.outputMint,
    inputAmountAtomic: request.inputAmountAtomic,
    outputAmountAtomic: entry ? "1000000" : "14000000",
    inputUsd: entry ? 14.1 : 14,
    outputUsd: entry ? 14 : 14,
    priceImpactPercent: 9,
    slippageBps: 500,
    feeBps: 0,
    signatureFeeLamports: 0,
    prioritizationFeeLamports: 0,
    rentFeeLamports: 0,
    minimumOutputAtomic: entry ? "1" : "1",
    router: "research-only"
  };
}

function freshSwap(overrides: Partial<LeaderSwap> = {}): LeaderSwap {
  const now = new Date().toISOString();
  return {
    sourceSignature: "research-only-signature",
    sourceWallet: RESEARCH_WALLET,
    slot: 100,
    blockTime: now,
    detectedAt: now,
    side: "BUY",
    baseMint: USDC_MINT,
    targetMint: TARGET_MINT,
    baseAmountAtomic: "14100000",
    targetAmountAtomic: "1000000",
    baseAmountUi: 14.1,
    targetAmountUi: 1,
    leaderPriceUsd: 14.1,
    recovered: false,
    ...overrides
  };
}

describe("isolated research-paper monitoring", () => {
  let db: CopyLabDatabase | undefined;
  let runtime: TradingRuntime | undefined;

  afterEach(async () => {
    await runtime?.stop();
    db?.close();
    vi.restoreAllMocks();
  });

  function setup(mode: "PAPER" | "MANUAL_LIVE" = "PAPER"): {
    repository: Repository;
    runtime: TradingRuntime;
  } {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    repository.setSetting("mode", mode);
    const vault = new SecretVault(repository);
    const wallet = new WalletManager(vault, repository);
    const modes = new ModeManager(repository, wallet);
    runtime = new TradingRuntime(
      repository,
      vault,
      modes,
      new EventBus(),
      new DpapiTransactionSigner(vault, repository)
    );
    const lane = repository.createResearchPaperLane({
      id: "research-monitoring-lane",
      policyVersion: "test",
      initialNavPerLeaderUsd: 141
    });
    const now = new Date().toISOString();
    const member: ResearchPaperWatchlistMember = {
      laneId: lane.id,
      wallet: RESEARCH_WALLET,
      sourceCohortId: "runtime-test-cohort",
      role: "RESEARCH_ONLY",
      activityEvidenceSource: "LOCAL_CONFIRMED_SPOT_AND_PROVIDER",
      selectionRank: 1,
      providerScoreCalculatedAt: now,
      providerCandidateSavedAt: now,
      realizedPnl30dUsd: 10,
      realizedPnl90dUsd: 20,
      completedTrades30d: 30,
      localConfirmedSpotSwaps: 3,
      localActiveDays: 2,
      latestLocalSpotSwapAt: now,
      selectedAt: now,
      updatedAt: now
    };
    repository.db.prepare(`
      INSERT INTO research_paper_watchlist_members(
        lane_id, wallet, source_cohort_id, role, selection_rank,
        completed_trades_30d, local_confirmed_spot_swaps,
        selected_at, updated_at, member_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      member.laneId,
      member.wallet,
      member.sourceCohortId,
      member.role,
      member.selectionRank,
      member.completedTrades30d,
      member.localConfirmedSpotSwaps,
      member.selectedAt,
      member.updatedAt,
      JSON.stringify(member)
    );
    return { repository, runtime };
  }

  it("simulates a fresh research-only swap without touching any strict or live ledger", async () => {
    const { repository, runtime } = setup();
    const strictRepair = vi.fn(async () => {
      throw new Error("strict observer must not be used by research monitoring");
    });
    const strictSubscribe = vi.fn(async () => {
      throw new Error("strict observer must not be used by research monitoring");
    });
    let researchCallback: ((swap: LeaderSwap) => Promise<void>) | undefined;
    const researchSubscribe = vi.fn(async (
      addresses: string[],
      callback: (swap: LeaderSwap) => Promise<void>
    ) => {
      expect(addresses).toEqual([RESEARCH_WALLET]);
      researchCallback = callback;
      return async () => undefined;
    });
    const harness = runtime as unknown as {
      providers: unknown;
      balanceReader: unknown;
      subscribeResearchWallets(): Promise<void>;
      queueResearchProviderRejectedSwap(rejection: RejectedSwapObservation): Promise<void>;
    };
    harness.balanceReader = {
      readMint: async () => 1_000_000n,
      read: async () => ({ solLamports: 0n, tokenAmounts: new Map() })
    };
    harness.providers = {
      chain: { repairGap: strictRepair, subscribe: strictSubscribe },
      researchChain: { repairGap: async () => [], subscribe: researchSubscribe },
      swap: { quote: async (request: QuoteRequest) => quote(request) }
    };

    await harness.subscribeResearchWallets();
    expect(researchSubscribe).toHaveBeenCalledOnce();
    expect(strictRepair).not.toHaveBeenCalled();
    expect(strictSubscribe).not.toHaveBeenCalled();
    expect(repository.getResearchPaperMonitoringCheckpoint(
      "research-monitoring-lane",
      RESEARCH_WALLET
    )).toMatchObject({ status: "READY" });

    await researchCallback?.(freshSwap());

    const rejectedAt = new Date(Date.now() + 1_000).toISOString();
    const rejectedSource: RejectedSourceAction = {
      sourceSignature: "research-only-rejected-signature",
      sourceWallet: RESEARCH_WALLET,
      slot: 101,
      blockTime: rejectedAt,
      detectedAt: rejectedAt,
      side: "BUY",
      baseMint: USDC_MINT,
      targetMint: TARGET_MINT,
      recovered: false
    };
    await harness.queueResearchProviderRejectedSwap({
      action: rejectedSource,
      researchAction: {
        kind: "UNSUPPORTED_ROUTE_RESEARCH_ONLY",
        source: rejectedSource,
        baseAmountAtomic: "14100000",
        targetAmountAtomic: "1000000",
        baseAmountUi: 14.1,
        targetAmountUi: 1
      },
      reason: "unsupported route"
    });

    expect(repository.researchPaperDashboard().positions).toEqual([
      expect.objectContaining({ wallet: RESEARCH_WALLET, mint: TARGET_MINT, status: "OPEN" })
    ]);
    expect(repository.researchPaperDashboard().recentSignals).toEqual(expect.arrayContaining([
      expect.objectContaining({ wallet: RESEARCH_WALLET, outcome: "SIMULATED" })
    ]));
    expect(repository.getResearchPaperMonitoringCheckpoint(
      "research-monitoring-lane",
      RESEARCH_WALLET
    )?.cursorAt).toBe(rejectedAt);
    expect(repository.db.prepare("SELECT COUNT(*) AS count FROM source_events").get()).toEqual({ count: 0 });
    expect(repository.db.prepare("SELECT COUNT(*) AS count FROM signal_outcomes").get()).toEqual({ count: 0 });
    expect(repository.db.prepare("SELECT COUNT(*) AS count FROM signal_decisions").get()).toEqual({ count: 0 });
    expect(repository.db.prepare("SELECT COUNT(*) AS count FROM executions").get()).toEqual({ count: 0 });
    expect(repository.db.prepare("SELECT COUNT(*) AS count FROM positions").get()).toEqual({ count: 0 });
  });

  it("keeps a research repair failure out of strict monitoring holds and ledgers", async () => {
    const { repository, runtime } = setup();
    const researchSubscribe = vi.fn(async () => async () => undefined);
    const harness = runtime as unknown as {
      providers: unknown;
      subscribeResearchWallets(): Promise<void>;
    };
    harness.providers = {
      chain: {
        repairGap: async () => [],
        subscribe: async () => async () => undefined
      },
      researchChain: {
        repairGap: async () => { throw new Error("research archive timeout"); },
        subscribe: researchSubscribe
      }
    };

    await expect(harness.subscribeResearchWallets()).resolves.toBeUndefined();

    // The socket opens before serialized repair so its live feed overlaps the
    // whole repair window; a research-only repair failure never closes or
    // blocks the strict trading head.
    expect(researchSubscribe).toHaveBeenCalledOnce();
    expect(repository.getResearchPaperMonitoringCheckpoint(
      "research-monitoring-lane",
      RESEARCH_WALLET
    )).toMatchObject({ status: "FAILED", failureCount: 1 });
    expect(repository.getMonitoringRepairCheckpoint(RESEARCH_WALLET)).toBeUndefined();
    expect(runtime.operationalPauseState()).toMatchObject({ active: false, reasons: [] });
    expect(repository.db.prepare("SELECT COUNT(*) AS count FROM source_events").get()).toEqual({ count: 0 });
    expect(repository.db.prepare("SELECT COUNT(*) AS count FROM signal_decisions").get()).toEqual({ count: 0 });
    expect(repository.db.prepare("SELECT COUNT(*) AS count FROM executions").get()).toEqual({ count: 0 });
  });

  it("closes a buy-only research position when confirmed leader inventory later reaches zero", async () => {
    const { repository, runtime } = setup();
    let balance = 1_000_000n;
    const readMint = vi.fn(async () => balance);
    let researchCallback: ((swap: LeaderSwap) => Promise<void>) | undefined;
    const harness = runtime as unknown as {
      providers: unknown;
      balanceReader: unknown;
      researchPaper: { enqueueMarks(): Promise<void> };
      subscribeResearchWallets(): Promise<void>;
    };
    harness.balanceReader = {
      readMint,
      read: async () => ({ solLamports: 0n, tokenAmounts: new Map() })
    };
    harness.providers = {
      chain: {
        repairGap: async () => [],
        subscribe: async () => async () => undefined
      },
      researchChain: {
        repairGap: async () => [],
        subscribe: async (_addresses: string[], callback: (swap: LeaderSwap) => Promise<void>) => {
          researchCallback = callback;
          return async () => undefined;
        }
      },
      swap: { quote: async (request: QuoteRequest) => quote(request) }
    };

    await harness.subscribeResearchWallets();
    await researchCallback?.(freshSwap({ sourceSignature: "research-buy-with-missed-exit" }));
    expect(repository.researchPaperDashboard().positions).toHaveLength(1);

    balance = 0n;
    await harness.researchPaper.enqueueMarks();

    const dashboard = repository.researchPaperDashboard();
    expect(dashboard.positions).toEqual([]);
    expect(dashboard.recentTrades[0]).toMatchObject({
      exitEvidence: "BALANCE_RECONCILIATION"
    });
    expect(readMint).toHaveBeenCalledTimes(2);
    expect(repository.db.prepare("SELECT COUNT(*) AS count FROM source_events").get()).toEqual({ count: 0 });
    expect(repository.db.prepare("SELECT COUNT(*) AS count FROM signal_decisions").get()).toEqual({ count: 0 });
    expect(repository.db.prepare("SELECT COUNT(*) AS count FROM executions").get()).toEqual({ count: 0 });
    expect(repository.db.prepare("SELECT COUNT(*) AS count FROM positions").get()).toEqual({ count: 0 });
    expect(repository.db.prepare("SELECT COUNT(*) AS count FROM closed_trades").get()).toEqual({ count: 0 });
  });

  it("does not repair or subscribe the research watchlist outside exact PAPER mode", async () => {
    const { runtime } = setup("MANUAL_LIVE");
    const repairGap = vi.fn(async () => []);
    const subscribe = vi.fn(async () => async () => undefined);
    const harness = runtime as unknown as {
      providers: unknown;
      subscribeResearchWallets(): Promise<void>;
    };
    harness.providers = {
      chain: { repairGap: async () => [], subscribe: async () => async () => undefined },
      researchChain: { repairGap, subscribe }
    };

    await harness.subscribeResearchWallets();

    expect(repairGap).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
  });
});
