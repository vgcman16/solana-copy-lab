import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TOTAL_HELIUS_MONTHLY_CREDIT_BUDGET,
  type WalletIndexRecord
} from "@copylab/shared";
import type { CopyLabDatabase } from "../src/database.js";
import { openDatabase } from "../src/database.js";
import { EventBus } from "../src/events.js";
import { ModeManager } from "../src/mode.js";
import { Repository } from "../src/repository.js";
import { TradingRuntime } from "../src/runtime.js";
import { SecretVault } from "../src/vault.js";
import { DpapiTransactionSigner, WalletManager } from "../src/wallet.js";
import { WalletAcquisitionController } from "../src/wallet-acquisition-controller.js";

const NOW = new Date("2026-07-10T04:00:00.000Z");
const WALLET = "research-ready-wallet";
const runtimes = new Set<TradingRuntime>();

interface RuntimeHarness {
  providers: unknown;
  processResearchHandoffs(): Promise<boolean>;
  quiesceProviderWork(): Promise<void>;
  resumeProviderWork(): Promise<void>;
}

function localRecord(): WalletIndexRecord {
  return {
    wallet: WALLET,
    firstSeenAt: new Date(NOW.getTime() - 90 * 86_400_000).toISOString(),
    lastSeenAt: NOW.toISOString(),
    historyDays: 90,
    transactionCount: 200,
    successfulTransactionCount: 200,
    spotSwapCount: 120,
    eligibleSpotSwapCount: 120,
    closedEligibleSwaps: 60,
    buyCount: 60,
    sellCount: 60,
    activeDays: 30,
    activeWeeks: 4,
    distinctMints: 20,
    medianHoldingMinutes: 30,
    preScreenEligible: true,
    preScreenReasons: [],
    deepHistoryStatus: "COMPLETE",
    deepHistoryWindowStart: new Date(NOW.getTime() - 90 * 86_400_000).toISOString(),
    deepHistoryWindowEnd: NOW.toISOString(),
    deepHistorySignatureCount: 200,
    deepHistoryHydratedCount: 200,
    structuralEligible: true,
    structuralReasons: [],
    updatedAt: NOW.toISOString()
  };
}

function persistLocalEvidence(repository: Repository, wallets: readonly string[] = [WALLET]): void {
  const cohort = repository.createWalletDeepHistoryCohort({
    selectedAt: NOW.toISOString(),
    snapshotCutoffAt: NOW.toISOString(),
    windowStart: new Date(NOW.getTime() - 90 * 86_400_000).toISOString(),
    windowEnd: NOW.toISOString(),
    wallets: [...wallets]
  });
  for (const wallet of wallets) {
    const record = { ...localRecord(), wallet };
    repository.upsertWalletIndexRecord(record);
    repository.saveWalletDeepHistoryEvidence({
      generationId: cohort.generationId,
      cohortId: cohort.id,
      wallet,
      record,
      swaps: [],
      frozenAt: NOW.toISOString()
    });
  }
}

function setup(): {
  db: CopyLabDatabase;
  repository: Repository;
  runtime: TradingRuntime;
  harness: RuntimeHarness;
} {
  const db = openDatabase(":memory:");
  const repository = new Repository(db);
  const vault = new SecretVault(repository);
  const wallet = new WalletManager(vault, repository);
  const runtime = new TradingRuntime(
    repository,
    vault,
    new ModeManager(repository, wallet),
    new EventBus(),
    new DpapiTransactionSigner(vault, repository)
  );
  runtimes.add(runtime);
  return { db, repository, runtime, harness: runtime as unknown as RuntimeHarness };
}

describe("research-ready provider handoff", () => {
  let db: CopyLabDatabase | undefined;

  afterEach(async () => {
    for (const runtime of runtimes) await runtime.quiesceProviderWork();
    runtimes.clear();
    db?.close();
    db = undefined;
    vi.useRealTimers();
  });

  it("immediately qualifies a completed local generation exactly once", async () => {
    const context = setup();
    db = context.db;
    const { repository, harness } = context;
    const frozenActive = Array.from({ length: 3 }, (_, index) => ({
      address: `frozen-active-wallet-${index}`,
      cohortId: "birdeye-2026-07-06",
      firstSeenAt: new Date(NOW.getTime() - 180 * 86_400_000).toISOString(),
      lastSeenAt: NOW.toISOString(),
      control: false,
      tags: [],
      pnl30d: {
        duration: "30d" as const,
        realizedProfitUsd: 50,
        realizedProfitPercent: 5,
        unrealizedProfitUsd: 0,
        totalTrades: 100,
        wins: 60,
        losses: 40
      },
      pnl90d: {
        duration: "90d" as const,
        realizedProfitUsd: 100,
        realizedProfitPercent: 10,
        unrealizedProfitUsd: 0,
        totalTrades: 300,
        wins: 180,
        losses: 120
      }
    }));
    repository.saveCohort({
      cohortId: "birdeye-2026-07-06",
      generatedAt: NOW.toISOString(),
      candidates: frozenActive
    });
    const frozenAddresses = frozenActive.map((candidate) => candidate.address);
    repository.setActiveWallets("birdeye-2026-07-06", frozenAddresses);
    for (const candidate of frozenActive) {
      repository.saveWalletScore("birdeye-2026-07-06", {
        wallet: candidate.address,
        calculatedAt: NOW.toISOString(),
        qualified: true,
        reasons: [],
        historyDays: 90,
        closedEligibleSwaps: 60,
        activeWeeks: 4,
        medianHoldingMinutes: 30,
        topTokenProfitShare: 0.2,
        topThreeProfitShare: 0.5
      });
    }
    expect(repository.freezePaperEvaluationCohort(
      "birdeye-2026-07-06",
      frozenAddresses,
      141,
      NOW.toISOString()
    )?.created).toBe(true);
    persistLocalEvidence(repository);
    repository.enqueueWalletResearchHandoff({
      generation: "local-index-v1:ready",
      runId: "index-run",
      wallets: [WALLET],
      readyAt: NOW.toISOString()
    });
    let discoveries = 0;
    let histories = 0;
    harness.providers = {
      discovery: {
        discoverCohort: async () => {
          discoveries += 1;
          return { cohortId: "birdeye-2026-07-06", generatedAt: NOW.toISOString(), candidates: [] };
        },
        getPnl: async (_wallet: string, duration: "30d" | "90d") => ({
          duration,
          realizedProfitUsd: 100,
          realizedProfitPercent: 10,
          unrealizedProfitUsd: 0,
          totalTrades: 100,
          wins: 60,
          losses: 40
        })
      },
      chain: {
        summarizeHistory: async () => {
          histories += 1;
          return {
            wallet: WALLET,
            historyDays: 90,
            closedEligibleSwaps: 60,
            activeWeeks: 4,
            medianHoldingMinutes: 30,
            topTokenProfitShare: 0.2,
            topThreeProfitShare: 0.5,
            tags: []
          };
        }
      },
      token: {},
      swap: {},
      quotes: {}
    };

    await expect(harness.processResearchHandoffs()).resolves.toBe(true);
    expect(repository.getWalletResearchHandoff("local-index-v1:ready")).toMatchObject({
      status: "COMPLETE",
      attempts: 1,
      cohortId: "birdeye-2026-07-06"
    });
    expect(repository.listWalletScores("birdeye-2026-07-06").find((score) => score.wallet === WALLET))
      .toMatchObject({ wallet: WALLET, qualified: true });
    expect(repository.listCandidates("birdeye-2026-07-06", true).map((candidate) => candidate.address))
      .toEqual(frozenAddresses);
    expect(discoveries).toBe(1);
    expect(histories).toBe(1);

    await expect(harness.processResearchHandoffs()).resolves.toBe(false);
    expect(discoveries).toBe(1);
    expect(histories).toBe(1);
  });

  it("skips provider I/O for a duplicate handoff that was durably queued before restart", async () => {
    const context = setup();
    db = context.db;
    const { repository, harness } = context;
    repository.enqueueWalletResearchHandoff({
      generation: "prior-complete",
      runId: "prior-run",
      wallets: [WALLET],
      readyAt: NOW.toISOString()
    });
    expect(repository.claimWalletResearchHandoff(NOW)?.generation).toBe("prior-complete");
    expect(repository.completeWalletResearchHandoff("prior-complete", undefined, NOW)).toBe(true);
    repository.enqueueWalletResearchHandoff({
      generation: "queued-before-restart",
      runId: "recovered-run",
      wallets: [WALLET],
      readyAt: NOW.toISOString()
    });
    let providerCalls = 0;
    harness.providers = {
      discovery: new Proxy({}, { get: () => () => { providerCalls += 1; } }),
      chain: new Proxy({}, { get: () => () => { providerCalls += 1; } }),
      token: {},
      swap: {},
      quotes: {}
    };

    await expect(harness.processResearchHandoffs()).resolves.toBe(true);
    expect(providerCalls).toBe(0);
    expect(repository.getWalletResearchHandoff("queued-before-restart")).toMatchObject({
      status: "COMPLETE",
      attempts: 1
    });
  });

  it("accumulates qualified wallets across bounded handoffs before freezing exactly three", async () => {
    const context = setup();
    db = context.db;
    const { repository, harness } = context;
    const firstBatch = ["qualified-a", "qualified-b"];
    const secondBatch = ["qualified-c"];
    persistLocalEvidence(repository, [...firstBatch, ...secondBatch]);
    const enqueue = (generation: string, wallets: string[]) => repository.enqueueWalletResearchHandoff({
      generation,
      runId: "index-run",
      wallets,
      readyAt: NOW.toISOString()
    });
    enqueue("local-index-v4:first", firstBatch);
    harness.providers = {
      discovery: {
        discoverCohort: async () => ({
          cohortId: "birdeye-2026-07-06",
          generatedAt: NOW.toISOString(),
          candidates: []
        }),
        getPnl: async (_wallet: string, duration: "30d" | "90d") => ({
          duration,
          realizedProfitUsd: 100,
          realizedProfitPercent: 10,
          unrealizedProfitUsd: 0,
          totalTrades: 100,
          wins: 60,
          losses: 40
        })
      },
      chain: {
        summarizeHistory: async (wallet: string) => ({
          wallet,
          historyDays: 90,
          closedEligibleSwaps: 60,
          activeWeeks: 4,
          medianHoldingMinutes: 30,
          topTokenProfitShare: 0.2,
          topThreeProfitShare: 0.5,
          tags: []
        })
      },
      token: {},
      swap: {},
      quotes: {}
    };

    await expect(harness.processResearchHandoffs()).resolves.toBe(true);
    expect(repository.activePaperEvaluationCohort()).toBeUndefined();
    expect(repository.listCandidates("birdeye-2026-07-06", true)).toEqual([]);

    enqueue("local-index-v4:second", secondBatch);
    await expect(harness.processResearchHandoffs()).resolves.toBe(true);
    expect(repository.activePaperEvaluationCohort()?.wallets)
      .toEqual([...firstBatch, ...secondBatch].sort());
    expect(repository.listCandidates("birdeye-2026-07-06", true).map((candidate) => candidate.address).sort())
      .toEqual([...firstBatch, ...secondBatch].sort());
    const acquisition = new WalletAcquisitionController(repository, { now: () => new Date(NOW) });
    expect(acquisition.snapshot()).toMatchObject({ qualifiedWallets: 3, status: "SATISFIED" });
    expect(acquisition.shouldContinueResearch()).toBe(false);
  });

  it("clears a legacy partial active set instead of treating it as a frozen evaluation", async () => {
    const context = setup();
    db = context.db;
    const { repository, harness } = context;
    const legacy = {
      address: "legacy-partial-active",
      cohortId: "birdeye-2026-07-06",
      firstSeenAt: new Date(NOW.getTime() - 180 * 86_400_000).toISOString(),
      lastSeenAt: NOW.toISOString(),
      control: false,
      tags: []
    };
    repository.saveCohort({
      cohortId: legacy.cohortId,
      generatedAt: NOW.toISOString(),
      candidates: [legacy]
    });
    repository.setActiveWallets(legacy.cohortId, [legacy.address]);
    repository.saveWalletScore(legacy.cohortId, {
      wallet: legacy.address,
      calculatedAt: NOW.toISOString(),
      qualified: false,
      reasons: ["legacy partial evidence"],
      historyDays: 0,
      closedEligibleSwaps: 0,
      activeWeeks: 0,
      medianHoldingMinutes: 0,
      topTokenProfitShare: 1,
      topThreeProfitShare: 1
    });
    persistLocalEvidence(repository);
    repository.enqueueWalletResearchHandoff({
      generation: "local-index-v1:legacy-partial",
      runId: "index-run",
      wallets: [WALLET],
      readyAt: NOW.toISOString()
    });
    harness.providers = {
      discovery: {
        discoverCohort: async () => ({
          cohortId: legacy.cohortId,
          generatedAt: NOW.toISOString(),
          candidates: []
        }),
        getPnl: async (_wallet: string, duration: "30d" | "90d") => ({
          duration,
          realizedProfitUsd: 100,
          realizedProfitPercent: 10,
          unrealizedProfitUsd: 0,
          totalTrades: 100,
          wins: 60,
          losses: 40
        })
      },
      chain: {
        summarizeHistory: async () => ({
          wallet: WALLET,
          historyDays: 90,
          closedEligibleSwaps: 60,
          activeWeeks: 4,
          medianHoldingMinutes: 30,
          topTokenProfitShare: 0.2,
          topThreeProfitShare: 0.5,
          tags: []
        })
      },
      token: {},
      swap: {},
      quotes: {}
    };

    await expect(harness.processResearchHandoffs()).resolves.toBe(true);
    expect(repository.activePaperEvaluationCohort()).toBeUndefined();
    expect(repository.listCandidates(legacy.cohortId, true)).toEqual([]);
  });

  it("defers before provider calls when the shared monthly Helius reserve is insufficient", async () => {
    const context = setup();
    db = context.db;
    const { repository, harness } = context;
    persistLocalEvidence(repository);
    repository.enqueueWalletResearchHandoff({
      generation: "local-index-v1:budget",
      runId: "index-run",
      wallets: [WALLET],
      readyAt: new Date().toISOString()
    });
    repository.incrementUsage("helius_index", DEFAULT_TOTAL_HELIUS_MONTHLY_CREDIT_BUDGET - 100);
    let providerCalls = 0;
    harness.providers = {
      discovery: { discoverCohort: async () => { providerCalls += 1; throw new Error("must not run"); } },
      chain: {},
      token: {},
      swap: {},
      quotes: {}
    };

    await expect(harness.processResearchHandoffs()).resolves.toBe(false);
    expect(providerCalls).toBe(0);
    expect(repository.getWalletResearchHandoff("local-index-v1:budget")).toMatchObject({
      status: "RETRY",
      attempts: 1,
      lastError: expect.stringContaining("Helius credits")
    });
  });

  it("keeps a month-boundary budget retry on bounded checkpoint timers", async () => {
    const january = new Date("2026-01-01T00:00:00.000Z");
    vi.useFakeTimers({ now: january });
    const context = setup();
    db = context.db;
    const { repository, harness } = context;
    persistLocalEvidence(repository);
    repository.enqueueWalletResearchHandoff({
      generation: "local-index-v1:long-budget-retry",
      runId: "index-run",
      wallets: [WALLET],
      readyAt: january.toISOString()
    });
    repository.incrementUsage("helius_index", DEFAULT_TOTAL_HELIUS_MONTHLY_CREDIT_BUDGET - 100);
    let providerCalls = 0;
    harness.providers = {
      discovery: { discoverCohort: async () => { providerCalls += 1; throw new Error("must not run"); } },
      chain: {},
      token: {},
      swap: {},
      quotes: {}
    };

    await expect(harness.processResearchHandoffs()).resolves.toBe(false);
    expect(repository.getWalletResearchHandoff("local-index-v1:long-budget-retry")).toMatchObject({
      status: "RETRY",
      attempts: 1,
      nextAttemptAt: "2026-02-01T00:00:00.000Z"
    });
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000 + 1);
    expect(providerCalls).toBe(0);
    expect(repository.getWalletResearchHandoff("local-index-v1:long-budget-retry")).toMatchObject({
      status: "RETRY",
      attempts: 1
    });
    expect(vi.getTimerCount()).toBe(1);
  });

  it("keeps transient provider-history failures retryable instead of saving a terminal zero score", async () => {
    const context = setup();
    db = context.db;
    const { repository, harness } = context;
    persistLocalEvidence(repository);
    repository.enqueueWalletResearchHandoff({
      generation: "local-index-v1:transient",
      runId: "index-run",
      wallets: [WALLET],
      readyAt: new Date().toISOString()
    });
    harness.providers = {
      discovery: {
        discoverCohort: async () => ({
          cohortId: "birdeye-2026-07-06",
          generatedAt: NOW.toISOString(),
          candidates: []
        }),
        getPnl: async (_wallet: string, duration: "30d" | "90d") => ({
          duration,
          realizedProfitUsd: 100,
          realizedProfitPercent: 10,
          unrealizedProfitUsd: 0,
          totalTrades: 100,
          wins: 60,
          losses: 40
        })
      },
      chain: { summarizeHistory: async () => { throw new Error("temporary history outage"); } },
      token: {},
      swap: {},
      quotes: {}
    };

    await expect(harness.processResearchHandoffs()).resolves.toBe(false);
    expect(repository.getWalletResearchHandoff("local-index-v1:transient")).toMatchObject({
      status: "RETRY",
      lastError: "temporary history outage"
    });
    expect(repository.listWalletScores("birdeye-2026-07-06")).toEqual([]);
  });

  it("automatically runs a transient handoff retry at its durable next-attempt time", async () => {
    vi.useFakeTimers({ now: NOW });
    const context = setup();
    db = context.db;
    const { repository, harness } = context;
    persistLocalEvidence(repository);
    repository.enqueueWalletResearchHandoff({
      generation: "local-index-v1:scheduled-retry",
      runId: "index-run",
      wallets: [WALLET],
      readyAt: NOW.toISOString()
    });
    let discoveries = 0;
    harness.providers = {
      discovery: {
        discoverCohort: async () => {
          discoveries += 1;
          if (discoveries === 1) throw new Error("temporary discovery timeout");
          return {
            cohortId: "birdeye-2026-07-06",
            generatedAt: new Date().toISOString(),
            candidates: []
          };
        },
        getPnl: async (_wallet: string, duration: "30d" | "90d") => ({
          duration,
          realizedProfitUsd: 100,
          realizedProfitPercent: 10,
          unrealizedProfitUsd: 0,
          totalTrades: 100,
          wins: 60,
          losses: 40
        })
      },
      chain: {
        summarizeHistory: async () => ({
          wallet: WALLET,
          historyDays: 90,
          closedEligibleSwaps: 60,
          activeWeeks: 4,
          medianHoldingMinutes: 30,
          topTokenProfitShare: 0.2,
          topThreeProfitShare: 0.5,
          tags: []
        })
      },
      token: {},
      swap: {},
      quotes: {}
    };

    await expect(harness.processResearchHandoffs()).resolves.toBe(false);
    expect(repository.getWalletResearchHandoff("local-index-v1:scheduled-retry")).toMatchObject({
      status: "RETRY",
      attempts: 1,
      nextAttemptAt: new Date(NOW.getTime() + 60_000).toISOString()
    });

    await vi.advanceTimersByTimeAsync(60_001);
    expect(repository.getWalletResearchHandoff("local-index-v1:scheduled-retry")).toMatchObject({
      status: "COMPLETE",
      attempts: 2,
      cohortId: "birdeye-2026-07-06"
    });
    expect(discoveries).toBe(2);
  });

  it("drains and fences an in-flight research request before a provider transition can continue", async () => {
    const context = setup();
    db = context.db;
    const { repository, harness } = context;
    persistLocalEvidence(repository);
    repository.enqueueWalletResearchHandoff({
      generation: "local-index-v1:transition-fence",
      runId: "index-run",
      wallets: [WALLET],
      readyAt: NOW.toISOString()
    });

    let releaseDiscovery!: () => void;
    let discoveryEntered!: () => void;
    const providerBlocked = new Promise<void>((resolve) => { releaseDiscovery = resolve; });
    const entered = new Promise<void>((resolve) => { discoveryEntered = resolve; });
    harness.providers = {
      discovery: {
        discoverCohort: async () => {
          discoveryEntered();
          await providerBlocked;
          return {
            cohortId: "old-provider-cohort",
            generatedAt: NOW.toISOString(),
            candidates: []
          };
        }
      },
      chain: {},
      token: {},
      swap: {},
      quotes: {}
    };

    const processing = harness.processResearchHandoffs();
    await entered;
    let quiesced = false;
    const quiescing = harness.quiesceProviderWork().then(() => { quiesced = true; });
    await Promise.resolve();
    expect(quiesced).toBe(false);
    expect(repository.getWalletResearchHandoff("local-index-v1:transition-fence")).toMatchObject({
      status: "RETRY",
      attempts: 1
    });

    releaseDiscovery();
    await expect(processing).resolves.toBe(false);
    await expect(quiescing).resolves.toBeUndefined();
    expect(repository.latestCohort()).toBeUndefined();
    expect(repository.listWalletScores("old-provider-cohort")).toEqual([]);
    expect(repository.getWalletResearchHandoff("local-index-v1:transition-fence")).toMatchObject({
      status: "RETRY",
      attempts: 1
    });

    repository.enqueueWalletResearchHandoff({
      generation: "local-index-v1:quiesced",
      runId: "index-run-2",
      wallets: [WALLET],
      readyAt: NOW.toISOString()
    });
    await expect(harness.processResearchHandoffs()).resolves.toBe(false);
    expect(repository.getWalletResearchHandoff("local-index-v1:quiesced")).toMatchObject({
      status: "READY",
      attempts: 0
    });
    await harness.resumeProviderWork();
  });
});
