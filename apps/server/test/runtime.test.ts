import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SOL_MINT,
  USDC_MINT,
  type ExecutionRecord,
  type LeaderSwap,
  type PositionLot,
  type QuoteSnapshot
} from "@copylab/shared";
import {
  BirdeyeProvider,
  HeliusObserver,
  JupiterMarketDataProvider,
  JupiterSwapProvider,
  JupiterTokenRiskProvider,
  PYTH_SOL_USD_FEED_ID,
  PYTH_SOL_USD_HISTORY_SOURCE,
  type PythBenchmarksPriceProvider
} from "@copylab/providers";
import type { CopyLabDatabase } from "../src/database.js";
import { openDatabase } from "../src/database.js";
import { EventBus } from "../src/events.js";
import { ModeManager } from "../src/mode.js";
import { Repository } from "../src/repository.js";
import { TradingRuntime } from "../src/runtime.js";
import { SecretVault } from "../src/vault.js";
import { DpapiTransactionSigner, WalletManager } from "../src/wallet.js";
import { RPC_READINESS_SETTING } from "../src/provider-rpc-readiness.js";

describe("TradingRuntime recovery controls", () => {
  let db: CopyLabDatabase | undefined;
  let runtime: TradingRuntime | undefined;

  afterEach(async () => {
    await runtime?.stop();
    db?.close();
    vi.unstubAllGlobals();
  });

  function setup(): { repository: Repository; modes: ModeManager; vault: SecretVault } {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
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
    return { repository, modes, vault };
  }

  function seedMonitoredWallet(repository: Repository, address: string, cursorAt: string): void {
    const at = "2026-07-10T00:00:00.000Z";
    repository.setSetting("mode", "PAPER");
    repository.setSetting(`monitoring_since:${address}`, cursorAt);
    repository.saveCohort({
      cohortId: "gap-repair-cohort",
      generatedAt: at,
      candidates: [{
        address,
        cohortId: "gap-repair-cohort",
        firstSeenAt: at,
        lastSeenAt: at,
        control: false,
        tags: []
      }]
    });
    repository.saveWalletScore("gap-repair-cohort", {
      wallet: address,
      calculatedAt: at,
      qualified: true,
      reasons: [],
      historyDays: 90,
      closedEligibleSwaps: 50,
      activeWeeks: 4,
      medianHoldingMinutes: 30,
      topTokenProfitShare: 0.2,
      topThreeProfitShare: 0.5
    });
  }

  it("starts fail-closed without credentials and stops cleanly", async () => {
    setup();
    await expect(runtime!.start()).resolves.toBeUndefined();
  });

  it("isolates cleanup failures and drains delayed signal writes before stop resolves", async () => {
    const { repository } = setup();
    let releaseSignal!: () => void;
    const signalGate = new Promise<void>((resolve) => {
      releaseSignal = resolve;
    });
    const unsubscribe = vi.fn(async () => {
      throw new Error("injected unsubscribe failure");
    });
    const indexerStop = vi.fn(async () => {
      throw new Error("injected indexer stop failure");
    });
    const harness = runtime! as unknown as {
      signalTail: Promise<void>;
      unsubscribe?: () => Promise<void>;
      walletIndexer?: { start(): void; stop(): Promise<void> };
    };
    harness.signalTail = signalGate.then(() => {
      repository.setSetting("delayed_signal_write", "settled-before-close");
      repository.audit("delayed_signal_write", "Injected signal execution finished its durable write.");
    });
    harness.unsubscribe = unsubscribe;
    harness.walletIndexer = { start: () => undefined, stop: indexerStop };

    let stopResolved = false;
    const stopping = runtime!.stop().then(() => {
      stopResolved = true;
    });
    await vi.waitFor(() => {
      expect(unsubscribe).toHaveBeenCalledOnce();
    });
    expect(stopResolved).toBe(false);

    releaseSignal();
    await stopping;

    expect(repository.getSetting("delayed_signal_write")).toBe("settled-before-close");
    expect(repository.listAudit(10)).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventType: "delayed_signal_write" }),
      expect.objectContaining({
        eventType: "runtime_stop_cleanup_failed",
        severity: "critical",
        details: expect.objectContaining({
          failures: expect.arrayContaining([
            expect.objectContaining({ stage: "wallet_indexer", error: "injected indexer stop failure" }),
            expect.objectContaining({ stage: "monitoring_unsubscribe", error: "injected unsubscribe failure" })
          ])
        })
      })
    ]));
  });

  it("treats expected provider-generation supersession as a clean shutdown", async () => {
    const { repository } = setup();
    const harness = runtime! as unknown as {
      providerWorkGeneration: number;
      providerWorkTasks: Set<Promise<unknown>>;
      assertProviderWorkCurrent(generation: number): void;
    };
    let superseded: unknown;
    try {
      harness.assertProviderWorkCurrent(harness.providerWorkGeneration + 1);
    } catch (error) {
      superseded = error;
    }
    expect(superseded).toMatchObject({ name: "ProviderWorkSupersededError" });
    const expectedRejection = Promise.reject(superseded);
    void expectedRejection.catch(() => undefined);
    harness.providerWorkTasks.add(expectedRejection);

    await runtime!.stop();

    expect(repository.listAudit(10)).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ eventType: "runtime_stop_cleanup_failed" })
    ]));
  });

  it("keeps a provider transition bounded when an old worker cannot stop", async () => {
    setup();
    vi.useFakeTimers();
    const harness = runtime! as unknown as {
      walletIndexer?: { start(): void; stop(): Promise<void> };
      providerWorkQuiesced: boolean;
    };
    harness.walletIndexer = {
      start: () => undefined,
      stop: () => new Promise<void>(() => undefined)
    };

    try {
      const quiescing = runtime!.quiesceProviderWork();
      const rejection = expect(quiescing).rejects.toThrow("did not quiesce within 30 seconds");
      await vi.advanceTimersByTimeAsync(30_000);
      await rejection;
      expect(harness.providerWorkQuiesced).toBe(true);
    } finally {
      delete harness.walletIndexer;
      vi.useRealTimers();
    }
  });

  it("configures while quiesced and starts only the newly selected provider worker on resume", async () => {
    const { repository } = setup();
    repository.setSetting("mode", "PAPER");
    let oldStops = 0;
    let newStarts = 0;
    let newStops = 0;
    let subscriptions = 0;
    let discoveries = 0;
    const oldIndexer = {
      start: () => undefined,
      stop: async () => { oldStops += 1; }
    };
    const newIndexer = {
      start: () => { newStarts += 1; },
      stop: async () => { newStops += 1; }
    };
    const harness = runtime! as unknown as {
      walletIndexer?: { start(): void; stop(): Promise<void> };
      configureProviders(): Promise<void>;
      recreateSolPriceBootstrapClient(): Promise<void>;
      refreshActiveRpcReadiness(): Promise<void>;
      refreshHealth(force: boolean): Promise<void>;
      subscribeActiveWallets(generation?: number): Promise<void>;
      refreshDiscoveryIfDue(generation?: number): Promise<void>;
    };
    harness.walletIndexer = oldIndexer;
    harness.configureProviders = async () => { harness.walletIndexer = newIndexer; };
    harness.recreateSolPriceBootstrapClient = async () => undefined;
    harness.refreshActiveRpcReadiness = async () => undefined;
    harness.refreshHealth = async () => undefined;
    harness.subscribeActiveWallets = async () => { subscriptions += 1; };
    harness.refreshDiscoveryIfDue = async () => { discoveries += 1; };

    await runtime!.quiesceProviderWork();
    await runtime!.credentialsChanged();
    expect(oldStops).toBe(1);
    expect(newStarts).toBe(0);
    expect(subscriptions).toBe(0);
    expect(discoveries).toBe(0);

    await runtime!.resumeProviderWork();
    await Promise.resolve();
    expect(newStarts).toBe(1);
    expect(subscriptions).toBe(1);
    expect(discoveries).toBe(1);
    expect(newStops).toBe(0);
  });

  it("keeps a failed startup repair cursor durable and retries it safely after restart", async () => {
    const { repository, modes, vault } = setup();
    const address = "wallet-gap-repair";
    const cursorAt = "2025-01-01T00:00:00.000Z";
    seedMonitoredWallet(repository, address, cursorAt);

    const failedCalls: string[] = [];
    let failedSubscriptions = 0;
    const failedChain = {
      repairGap: async (_wallet: string, since: string): Promise<LeaderSwap[]> => {
        failedCalls.push(since);
        throw new Error("mock pruned history");
      },
      subscribe: async (): Promise<() => void> => {
        failedSubscriptions += 1;
        return () => undefined;
      }
    };
    const failedHarness = runtime! as unknown as {
      providers: unknown;
      subscribeActiveWallets(): Promise<void>;
    };
    failedHarness.providers = { chain: failedChain };

    await expect(failedHarness.subscribeActiveWallets()).resolves.toBeUndefined();
    expect(failedCalls).toEqual([cursorAt]);
    expect(failedSubscriptions).toBe(0);
    expect(repository.getMonitoringRepairCheckpoint(address)).toMatchObject({
      cursorAt,
      status: "FAILED",
      failureCount: 1
    });
    expect(runtime!.operationalPauseState()).toMatchObject({
      active: true,
      reasons: ["HISTORY_GAP_REPAIR"],
      recovery: "WHEN_CONDITIONS_CLEAR"
    });

    await runtime!.stop();

    const recovered: LeaderSwap = {
      sourceSignature: "gap-repair-signature",
      sourceWallet: address,
      slot: 42,
      blockTime: "2025-01-02T00:00:00.000Z",
      detectedAt: "2026-07-10T00:00:00.000Z",
      side: "BUY",
      baseMint: USDC_MINT,
      targetMint: SOL_MINT,
      baseAmountAtomic: "1000000",
      targetAmountAtomic: "10000000",
      baseAmountUi: 1,
      targetAmountUi: 0.01,
      leaderPriceUsd: 100,
      recovered: true
    };
    const retriedCalls: string[] = [];
    let successfulSubscriptions = 0;
    const recoveredChain = {
      repairGap: async (_wallet: string, since: string): Promise<LeaderSwap[]> => {
        retriedCalls.push(since);
        return [recovered, recovered];
      },
      subscribe: async (): Promise<() => void> => {
        successfulSubscriptions += 1;
        return () => undefined;
      }
    };
    runtime = new TradingRuntime(
      repository,
      vault,
      modes,
      new EventBus(),
      new DpapiTransactionSigner(vault, repository)
    );
    const recoveredHarness = runtime as unknown as {
      providers: unknown;
      subscribeActiveWallets(): Promise<void>;
    };
    recoveredHarness.providers = { chain: recoveredChain };

    await expect(recoveredHarness.subscribeActiveWallets()).resolves.toBeUndefined();
    expect(retriedCalls).toEqual([cursorAt]);
    expect(successfulSubscriptions).toBe(1);
    const checkpoint = repository.getMonitoringRepairCheckpoint(address);
    expect(checkpoint).toMatchObject({ status: "READY", failureCount: 0 });
    expect(checkpoint?.cursorAt).not.toBe(cursorAt);
    expect(runtime.operationalPauseState()).toMatchObject({ active: false, reasons: [] });
    expect(repository.db.prepare(
      "SELECT COUNT(*) AS count FROM source_events WHERE signature = ? AND wallet = ?"
    ).get(recovered.sourceSignature, address)).toEqual({ count: 1 });
    expect(repository.listUnprocessedSourceEvents()).toEqual([]);
  });

  it("automatically retries a failed repair before starting the wallet stream", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T00:00:00.000Z"));
    try {
      const { repository } = setup();
      const address = "wallet-auto-repair";
      seedMonitoredWallet(repository, address, "2026-07-09T00:00:00.000Z");
      let failRepair = true;
      let repairs = 0;
      let subscriptions = 0;
      const chain = {
        repairGap: async (): Promise<LeaderSwap[]> => {
          repairs += 1;
          if (failRepair) throw new Error("temporary archive outage");
          return [];
        },
        subscribe: async (): Promise<() => void> => {
          subscriptions += 1;
          return () => undefined;
        }
      };
      const harness = runtime! as unknown as {
        providers: unknown;
        monitoringSubscriptionTail: Promise<void>;
        subscribeActiveWallets(): Promise<void>;
      };
      harness.providers = { chain };

      await harness.subscribeActiveWallets();
      expect(repairs).toBe(1);
      expect(subscriptions).toBe(0);
      expect(repository.getMonitoringRepairCheckpoint(address)).toMatchObject({ status: "FAILED" });

      failRepair = false;
      await vi.advanceTimersByTimeAsync(30_000);
      await harness.monitoringSubscriptionTail;

      expect(repairs).toBe(2);
      expect(subscriptions).toBe(1);
      expect(repository.getMonitoringRepairCheckpoint(address)).toMatchObject({ status: "READY" });
      expect(runtime!.operationalPauseState()).toMatchObject({ active: false, reasons: [] });
    } finally {
      vi.useRealTimers();
    }
  });

  it("subscribes all repaired active leaders without letting a failed shadow wallet hold entries", async () => {
    const { repository } = setup();
    repository.setSetting("mode", "PAPER");
    const at = new Date().toISOString();
    const active = ["leader-a", "leader-b", "leader-c"];
    const shadow = "shadow-only";
    const wallets = [...active, shadow];
    repository.saveCohort({
      cohortId: "active-plus-shadow",
      generatedAt: at,
      candidates: wallets.map((address) => ({
        address,
        cohortId: "active-plus-shadow",
        firstSeenAt: at,
        lastSeenAt: at,
        control: false,
        tags: []
      }))
    });
    for (const wallet of wallets) {
      repository.saveWalletScore("active-plus-shadow", {
        wallet,
        calculatedAt: at,
        qualified: true,
        reasons: [],
        historyDays: 90,
        closedEligibleSwaps: 50,
        activeWeeks: 4,
        medianHoldingMinutes: 30,
        topTokenProfitShare: 0.2,
        topThreeProfitShare: 0.5
      });
    }
    repository.setActiveWallets("active-plus-shadow", active);
    expect(repository.freezePaperEvaluationCohort("active-plus-shadow", active, 141, at)).toBeDefined();

    let subscribed: string[] = [];
    const chain = {
      repairGap: async (wallet: string): Promise<LeaderSwap[]> => {
        if (wallet === shadow) throw new Error("shadow archive unavailable");
        return [];
      },
      subscribe: async (addresses: string[]): Promise<() => void> => {
        subscribed = addresses;
        return () => undefined;
      },
      getStreamStatus: () => ({
        active: true,
        connected: true,
        ready: true,
        lastMessageAt: new Date().toISOString()
      })
    };
    const harness = runtime! as unknown as {
      providers: unknown;
      subscribeActiveWallets(): Promise<void>;
    };
    harness.providers = { chain };

    await expect(harness.subscribeActiveWallets()).resolves.toBeUndefined();
    expect(subscribed).toEqual(expect.arrayContaining(active));
    expect(subscribed).toHaveLength(active.length);
    expect(subscribed).not.toContain(shadow);
    expect(repository.getMonitoringRepairCheckpoint(shadow)).toMatchObject({ status: "FAILED" });
    expect(runtime!.operationalPauseState()).toMatchObject({ active: false, reasons: [] });
    expect(runtime!.operationalTelemetry()).toMatchObject({
      blocksNewEntries: false,
      tradingHead: { requiredWallets: 3, repairReadyWallets: 3, healthy: true }
    });
  });

  it("adopts three saved qualifiers into one idempotent forward PAPER cohort", () => {
    const { repository } = setup();
    repository.setSetting("mode", "PAPER");
    repository.setSetting("paper_initial_nav_usd", 141);
    const generatedAt = "2026-07-11T00:00:00.000Z";
    const wallets = ["saved-a", "saved-b", "saved-c"];
    repository.saveCohort({
      cohortId: "saved-qualified-cohort",
      generatedAt,
      candidates: wallets.map((address, index) => ({
        address,
        cohortId: "saved-qualified-cohort",
        firstSeenAt: "2026-01-01T00:00:00.000Z",
        lastSeenAt: generatedAt,
        control: false,
        tags: [],
        pnl30d: {
          duration: "30d" as const,
          realizedProfitUsd: 10,
          realizedProfitPercent: 10 - index,
          unrealizedProfitUsd: 0,
          totalTrades: 100,
          wins: 60,
          losses: 40
        },
        pnl90d: {
          duration: "90d" as const,
          realizedProfitUsd: 30,
          realizedProfitPercent: 20 - index,
          unrealizedProfitUsd: 0,
          totalTrades: 300,
          wins: 180,
          losses: 120
        }
      }))
    });
    for (const wallet of wallets) {
      repository.saveWalletScore("saved-qualified-cohort", {
        wallet,
        calculatedAt: generatedAt,
        qualified: true,
        reasons: [],
        historyDays: 90,
        closedEligibleSwaps: 50,
        activeWeeks: 4,
        medianHoldingMinutes: 30,
        topTokenProfitShare: 0.2,
        topThreeProfitShare: 0.5
      });
    }
    const harness = runtime! as unknown as {
      ensureForwardPaperEvaluationFromCurrentCohort(): void;
    };

    harness.ensureForwardPaperEvaluationFromCurrentCohort();
    const first = repository.activePaperEvaluationCohort();
    expect(first).toMatchObject({
      sourceCohortId: "saved-qualified-cohort",
      initialNavUsd: 141,
      wallets
    });
    expect(repository.listCandidates("saved-qualified-cohort", true).map((candidate) => candidate.address))
      .toEqual(wallets);
    expect(repository.latestPortfolioSnapshot("PAPER")).toMatchObject({
      navUsd: 141,
      evaluationCohortId: first?.id
    });

    harness.ensureForwardPaperEvaluationFromCurrentCohort();
    expect(repository.activePaperEvaluationCohort()?.id).toBe(first?.id);
    expect(repository.listAudit(100).filter((event) => event.eventType === "paper_evaluation_cohort_frozen"))
      .toHaveLength(1);
  });

  it.runIf(process.platform === "win32")(
    "validates only Jupiter credentials after managed data has been fully disabled",
    async () => {
      const { vault } = setup();
      vault.setDataProviderProfile({
        mode: "SELF_HOSTED",
        solanaHttpUrl: "http://127.0.0.1:8899",
        solanaWsUrl: "ws://127.0.0.1:8900"
      });
      const birdeye = vi.spyOn(BirdeyeProvider.prototype, "checkHealth");
      const helius = vi.spyOn(HeliusObserver.prototype, "checkHealth");
      vi.spyOn(JupiterTokenRiskProvider.prototype, "checkHealth").mockResolvedValue({
        provider: "jupiter",
        ok: true,
        checkedAt: new Date().toISOString(),
        message: "tokens healthy"
      });
      vi.spyOn(JupiterSwapProvider.prototype, "checkHealth").mockResolvedValue({
        provider: "jupiter",
        ok: true,
        checkedAt: new Date().toISOString(),
        message: "swap healthy"
      });
      vi.spyOn(JupiterMarketDataProvider.prototype, "checkHealth").mockResolvedValue({
        provider: "jupiter",
        ok: true,
        checkedAt: new Date().toISOString(),
        message: "market categories healthy"
      });

      await expect(runtime!.validateCredentials({ jupiterApiKey: "jup-self-hosted" })).resolves.toEqual([
        expect.objectContaining({ provider: "jupiter", ok: true })
      ]);
      expect(birdeye).not.toHaveBeenCalled();
      expect(helius).not.toHaveBeenCalled();
    }
  );

  it.runIf(process.platform === "win32")(
    "constructs every credential-health Jupiter client with the runtime's exact request coordinator",
    async () => {
      const { vault } = setup();
      vault.setDataProviderProfile({
        mode: "SELF_HOSTED",
        solanaHttpUrl: "http://127.0.0.1:8899",
        solanaWsUrl: "ws://127.0.0.1:8900"
      });
      const harness = runtime! as unknown as { jupiterFetch: unknown };
      const observedFetches: unknown[] = [];
      const captureFetch = (provider: object): void => {
        observedFetches.push((provider as { fetch: unknown }).fetch);
      };

      vi.spyOn(JupiterTokenRiskProvider.prototype, "checkHealth").mockImplementation(function (
        this: JupiterTokenRiskProvider
      ) {
        captureFetch(this);
        return Promise.resolve({
          provider: "jupiter",
          ok: true,
          checkedAt: new Date().toISOString(),
          message: "tokens healthy"
        });
      });
      vi.spyOn(JupiterSwapProvider.prototype, "checkHealth").mockImplementation(function (
        this: JupiterSwapProvider
      ) {
        captureFetch(this);
        return Promise.resolve({
          provider: "jupiter",
          ok: true,
          checkedAt: new Date().toISOString(),
          message: "swap healthy"
        });
      });
      vi.spyOn(JupiterMarketDataProvider.prototype, "checkHealth").mockImplementation(function (
        this: JupiterMarketDataProvider
      ) {
        captureFetch(this);
        return Promise.resolve({
          provider: "jupiter",
          ok: true,
          checkedAt: new Date().toISOString(),
          message: "market categories healthy"
        });
      });

      await expect(runtime!.validateCredentials({ jupiterApiKey: "jup-shared-coordinator" }))
        .resolves.toEqual([expect.objectContaining({ provider: "jupiter", ok: true })]);
      expect(observedFetches).toHaveLength(3);
      for (const fetch of observedFetches) expect(fetch).toBe(harness.jupiterFetch);
    }
  );

  it.runIf(process.platform === "win32")(
    "validates an optional Pyth bearer key with a redacted health result",
    async () => {
      const { repository, modes, vault } = setup();
      vault.setDataProviderProfile({
        mode: "SELF_HOSTED",
        solanaHttpUrl: "http://127.0.0.1:8899",
        solanaWsUrl: "ws://127.0.0.1:8900"
      });
      vi.spyOn(JupiterTokenRiskProvider.prototype, "checkHealth").mockResolvedValue({
        provider: "jupiter",
        ok: true,
        checkedAt: new Date().toISOString(),
        message: "tokens healthy"
      });
      vi.spyOn(JupiterSwapProvider.prototype, "checkHealth").mockResolvedValue({
        provider: "jupiter",
        ok: true,
        checkedAt: new Date().toISOString(),
        message: "swap healthy"
      });
      vi.spyOn(JupiterMarketDataProvider.prototype, "checkHealth").mockResolvedValue({
        provider: "jupiter",
        ok: true,
        checkedAt: new Date().toISOString(),
        message: "market categories healthy"
      });
      const observedKeys: Array<string | undefined> = [];
      let rejectPyth = false;
      const providerFactory = (apiKey: string | undefined): PythBenchmarksPriceProvider => {
        observedKeys.push(apiKey);
        return {
          authenticationConfigured: Boolean(apiKey),
          pythAuthenticationConfigured: Boolean(apiKey),
          fallbackConfigured: false,
          activeSource: PYTH_SOL_USD_HISTORY_SOURCE,
          async getSolUsdPrice(timestampSeconds) {
            if (rejectPyth) throw new Error(`provider rejected ${apiKey ?? "missing"}`);
            return {
              source: PYTH_SOL_USD_HISTORY_SOURCE,
              feedId: PYTH_SOL_USD_FEED_ID,
              requestedTimestampSeconds: timestampSeconds,
              observationTimestampSeconds: timestampSeconds,
              publishTimeSeconds: timestampSeconds,
              priceMantissa: "15000000000",
              confidenceMantissa: "1000000",
              exponent: -8,
              priceUsd: 150,
              confidenceUsd: 0.01,
              confidenceRatio: 1 / 15_000
            };
          }
        };
      };
      runtime = new TradingRuntime(
        repository,
        vault,
        modes,
        new EventBus(),
        new DpapiTransactionSigner(vault, repository),
        { pythBenchmarksProviderFactory: providerFactory }
      );

      const secret = "pyth-health-private-value";
      const healthy = await runtime.validateCredentials({
        jupiterApiKey: "jup-self-hosted",
        pythBenchmarksApiKey: secret
      });
      expect(healthy).toEqual([
        expect.objectContaining({ provider: "jupiter", ok: true }),
        expect.objectContaining({ provider: "pyth", ok: true })
      ]);
      expect(observedKeys).toContain(secret);

      rejectPyth = true;
      const rejectedHealth = await runtime.validateCredentials({
        jupiterApiKey: "jup-self-hosted",
        pythBenchmarksApiKey: secret
      });
      const pyth = rejectedHealth.find((entry) => entry.provider === "pyth");
      expect(pyth).toMatchObject({ ok: false });
      expect(pyth?.message).not.toContain(secret);
    }
  );

  it.runIf(process.platform === "win32")(
    "exposes the authenticated managed Birdeye history fallback without pretending a Pyth key exists",
    () => {
      db = openDatabase(":memory:");
      const repository = new Repository(db);
      const vault = new SecretVault(repository);
      const wallet = new WalletManager(vault, repository);
      const modes = new ModeManager(repository, wallet);
      vault.setCredentials({
        birdeyeApiKey: "managed-birdeye-key",
        heliusApiKey: "helius-key",
        jupiterApiKey: "jupiter-key"
      });
      runtime = new TradingRuntime(
        repository,
        vault,
        modes,
        new EventBus(),
        new DpapiTransactionSigner(vault, repository)
      );
      expect(runtime.solPriceBootstrapStatus()).toMatchObject({
        phase: "IDLE",
        authenticationConfigured: true,
        pythAuthenticationConfigured: false,
        managedFallbackConfigured: true,
        activeSource: "birdeye_ohlcv_v3"
      });
    }
  );

  it.runIf(process.platform === "win32")(
    "recreates the dormant Pyth worker from the encrypted credential after a key change",
    async () => {
      db = openDatabase(":memory:");
      const repository = new Repository(db);
      const vault = new SecretVault(repository);
      const wallet = new WalletManager(vault, repository);
      const modes = new ModeManager(repository, wallet);
      vault.setCredentials({
        birdeyeApiKey: "birdeye-key",
        heliusApiKey: "helius-key",
        jupiterApiKey: "jupiter-key",
        pythBenchmarksApiKey: "encrypted-old-pyth-key"
      });
      const observedKeys: Array<string | undefined> = [];
      runtime = new TradingRuntime(
        repository,
        vault,
        modes,
        new EventBus(),
        new DpapiTransactionSigner(vault, repository),
        {
          pythBenchmarksApiKey: "environment-fallback-key",
          pythBenchmarksProviderFactory: (apiKey) => {
            observedKeys.push(apiKey);
            return {
              authenticationConfigured: Boolean(apiKey),
              pythAuthenticationConfigured: Boolean(apiKey),
              fallbackConfigured: false,
              activeSource: PYTH_SOL_USD_HISTORY_SOURCE,
              async getSolUsdPrice() {
                throw new Error("The dormant worker must not request during credential refresh.");
              }
            };
          }
        }
      );
      expect(runtime.solPriceBootstrapStatus()).toMatchObject({
        phase: "IDLE",
        activeInProcess: false,
        authenticationConfigured: true
      });
      expect(observedKeys).toEqual(["encrypted-old-pyth-key"]);

      vault.setCredentials({
        birdeyeApiKey: "birdeye-key",
        heliusApiKey: "helius-key",
        jupiterApiKey: "jupiter-key",
        pythBenchmarksApiKey: "encrypted-new-pyth-key"
      });
      const harness = runtime as unknown as {
        configureProviders(): Promise<void>;
        refreshHealth(force: boolean): Promise<void>;
      };
      harness.configureProviders = async () => undefined;
      harness.refreshHealth = async () => undefined;
      await runtime.credentialsChanged();

      expect(observedKeys).toEqual(["encrypted-old-pyth-key", "encrypted-new-pyth-key"]);
      expect(runtime.solPriceBootstrapStatus()).toMatchObject({
        phase: "IDLE",
        activeInProcess: false,
        authenticationConfigured: true
      });
    }
  );

  it("persists redacted full RPC and WSS capability evidence during SHADOW validation", async () => {
    const { repository } = setup();
    const nowSeconds = Math.floor(Date.now() / 1_000);
    const signature = "5".repeat(88);
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
      const slot = request.params[0];
      const result = request.method === "getHealth" ? "ok"
        : request.method === "getSlot" ? 1_000
        : request.method === "getBlockTime" ? nowSeconds - 5
        : request.method === "getFirstAvailableBlock" ? 10
        : request.method === "getBlock" ? {
            blockTime: slot === 10 ? nowSeconds - 100 * 86_400 : nowSeconds - 60,
            transactions: []
          }
        : request.method === "getSignaturesForAddress" ? [{
            signature,
            slot: 900,
            blockTime: nowSeconds - 60,
            err: null,
            confirmationStatus: "confirmed"
          }]
        : request.method === "getTransaction" ? { slot: 900, transaction: {}, meta: {} }
        : request.method === "getBalance" ? { context: { slot: 1_000 }, value: 1 }
        : request.method === "getTokenAccountsByOwner" ? { context: { slot: 1_000 }, value: [] }
        : null;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }));

    class HealthyWebSocket {
      readyState = 0;
      private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

      constructor() {
        queueMicrotask(() => {
          this.readyState = 1;
          this.emit("open", {});
        });
      }

      addEventListener(type: string, listener: (event: unknown) => void): void {
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
      }

      send(data: string): void {
        const request = JSON.parse(data) as { id: number; method: string };
        if (request.method === "logsSubscribe") {
          queueMicrotask(() => this.emit("message", {
            data: JSON.stringify({ jsonrpc: "2.0", id: request.id, result: 77 })
          }));
        }
      }

      close(): void {
        this.readyState = 3;
        this.emit("close", {});
      }

      private emit(type: string, event: unknown): void {
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }
    }
    vi.stubGlobal("WebSocket", HealthyWebSocket);

    const httpSecret = "http-query-secret";
    const wsSecret = "ws-query-secret";
    const health = await runtime!.validateDataProviderProfile({
      mode: "SHADOW",
      solanaHttpUrl: `https://rpc.example.test/private?api-key=${httpSecret}`,
      solanaWsUrl: `wss://rpc.example.test/private?api-key=${wsSecret}`
    });

    expect(health).toMatchObject({ ok: true, provider: "helius" });
    const stored = repository.getSetting<unknown>(RPC_READINESS_SETTING);
    expect(stored).toMatchObject({ ok: true, fullCapabilitiesOk: true, websocketOk: true });
    expect(JSON.stringify(stored)).not.toContain(httpSecret);
    expect(JSON.stringify(stored)).not.toContain(wsSecret);
    expect(JSON.stringify(stored)).not.toContain("/private");
  });

  it("keeps a stale-quote pause until a fresh actionable quote proves recovery", async () => {
    const { repository } = setup();
    const quote = (quotedAt: string): QuoteSnapshot => ({
      requestId: `quote-${quotedAt}`,
      quotedAt,
      inputMint: USDC_MINT,
      outputMint: SOL_MINT,
      inputAmountAtomic: "1000000",
      outputAmountAtomic: "10000000",
      inputUsd: 1,
      outputUsd: 1,
      priceImpactPercent: 0,
      slippageBps: 10,
      feeBps: 0,
      signatureFeeLamports: 5000,
      prioritizationFeeLamports: 0,
      rentFeeLamports: 0,
      minimumOutputAtomic: "9990000",
      router: "iris"
    });
    const harness = runtime! as unknown as {
      evaluateStops(manualRecheck?: boolean, latestActionableQuote?: QuoteSnapshot): Promise<unknown>;
    };

    await harness.evaluateStops(false, quote("2020-01-01T00:00:00.000Z"));
    expect(repository.getSetting("new_entries_paused")).toBe(true);
    expect(runtime!.operationalPauseState()).toMatchObject({
      active: true,
      reasons: ["STALE_QUOTE"],
      recovery: "WHEN_CONDITIONS_CLEAR"
    });

    await harness.evaluateStops();
    expect(runtime!.operationalPauseState()).toMatchObject({ active: true, reasons: ["STALE_QUOTE"] });

    await harness.evaluateStops(false, quote(new Date().toISOString()));
    expect(runtime!.operationalPauseState()).toMatchObject({ active: false, reasons: [] });
    expect(repository.getSetting("new_entries_paused")).toBe(false);
  });

  it("uses the active-wallet trading head instead of global discovery lag for entry pauses", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T12:00:00.000Z"));
    try {
      const { repository } = setup();
      const frozenAt = "2026-07-10T11:50:00.000Z";
      const repairAt = "2026-07-10T11:51:00.000Z";
      const wallets = ["leader-a", "leader-b", "leader-c", "leader-d", "leader-e"];
      repository.db.prepare(`
        INSERT INTO paper_evaluation_cohorts(
          id, source_cohort_id, frozen_at, initial_nav_usd, wallets_json, status, superseded_at
        ) VALUES ('paper-evaluation:runtime-head', 'runtime-head-cohort', ?, 141, ?, 'ACTIVE', NULL)
      `).run(frozenAt, JSON.stringify(wallets));
      for (const wallet of wallets) {
        const seed = "2026-07-10T11:49:00.000Z";
        repository.ensureMonitoringRepairCheckpoint(wallet, seed, seed);
        repository.startMonitoringRepair(wallet, seed, repairAt);
        repository.completeMonitoringRepair(wallet, seed, repairAt, repairAt);
      }
      repository.saveWalletIndexCheckpoint({
        pipeline: "helius-jupiter-program-index",
        partition: "program-1",
        completed: false,
        updatedAt: "2026-07-10T11:59:30.000Z",
        lastSignature: "old-global-head",
        slot: 100
      });
      repository.saveWalletIndexCheckpoint({
        pipeline: "helius-jupiter-program-head",
        partition: "program-1",
        completed: false,
        updatedAt: "2026-07-10T11:59:30.000Z",
        lastSignature: "partial-global-head",
        slot: 110,
        cursor: "old-global-head",
        beforeSignature: "global-page-cursor",
        metadata: { coverageStartSlot: 101, coverageEndSlot: 110 }
      });
      let connected = true;
      const harness = runtime! as unknown as {
        providers: unknown;
        evaluateStops(manualRecheck?: boolean): Promise<unknown>;
      };
      harness.providers = {
        chain: {
          getStreamStatus: () => ({
            active: true,
            connected,
            ready: connected,
            lastMessageAt: "2026-07-10T11:59:30.000Z"
          })
        }
      };

      expect(runtime!.operationalTelemetry()).toMatchObject({
        blocksNewEntries: false,
        blockingIssueCodes: [],
        issues: expect.arrayContaining([
          expect.objectContaining({ code: "INDEX_HEAD_STALE", severity: "WARNING" })
        ]),
        tradingHead: { healthy: true }
      });
      await harness.evaluateStops();
      expect(runtime!.operationalPauseState()).toMatchObject({ active: false, reasons: [] });

      connected = false;
      await harness.evaluateStops();
      expect(runtime!.operationalPauseState()).toMatchObject({
        active: true,
        reasons: ["LOCAL_DATA_UNHEALTHY"]
      });
      connected = true;
      await harness.evaluateStops();
      expect(runtime!.operationalPauseState()).toMatchObject({ active: false, reasons: [] });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects stale manual approvals on restart before any signature can occur", async () => {
    const { repository } = setup();
    const at = new Date().toISOString();
    const pending: ExecutionRecord = {
      id: "pending",
      idempotencyKey: "pending-key",
      intentId: "intent",
      mode: "LIVE",
      status: "AWAITING_APPROVAL",
      createdAt: at,
      updatedAt: at,
      sourceSignature: "source",
      quote: {
        requestId: "request",
        quotedAt: at,
        inputMint: USDC_MINT,
        outputMint: SOL_MINT,
        inputAmountAtomic: "1000000",
        outputAmountAtomic: "10000000",
        inputUsd: 1,
        outputUsd: 1,
        priceImpactPercent: 0,
        slippageBps: 10,
        feeBps: 0,
        signatureFeeLamports: 5000,
        prioritizationFeeLamports: 0,
        rentFeeLamports: 0,
        minimumOutputAtomic: "9990000",
        router: "iris"
      }
    };
    repository.upsertExecution(pending);
    await runtime!.start();
    expect(repository.getExecution("pending")).toMatchObject({
      status: "REJECTED",
      failureReason: expect.stringContaining("restarted")
    });
  });

  it("rejects paper emergencies and locks safely for an empty live emergency", async () => {
    const { repository, modes } = setup();
    await expect(runtime!.emergencyExit()).rejects.toThrow("only for live");
    repository.setSetting("mode", "AUTO_LIVE");
    await expect(runtime!.emergencyExit()).resolves.toEqual({ closed: 0, failed: 0, locked: true });
    expect(modes.mode).toBe("LOCKED");
    expect(repository.latestEmergencyLiquidation()).toMatchObject({ state: "LOCKED_COMPLETE" });
  });

  it("restores LOCKED before startup work when liquidation was interrupted", async () => {
    const { repository, modes } = setup();
    repository.setSetting("mode", "AUTO_LIVE");
    repository.beginEmergencyLiquidation("simulated process kill");

    await runtime!.start();

    expect(modes.mode).toBe("LOCKED");
    expect(repository.listAudit(20)).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventType: "emergency_lock_recovered", severity: "critical" })
    ]));
  });

  it("forces persisted live mode to PAUSED before startup work and requires explicit resume", async () => {
    const { repository, modes } = setup();
    repository.setSetting("mode", "AUTO_LIVE");

    await runtime!.start();

    expect(modes.mode).toBe("PAUSED");
    expect(modes.pausedFrom).toBe("AUTO_LIVE");
    expect(repository.listAudit(20)).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventType: "live_restart_paused", severity: "warning" })
    ]));
  });

  it("reruns live safety preflight instead of blindly resuming AUTO_LIVE", async () => {
    const { repository } = setup();
    repository.setSetting("mode", "PAUSED");
    repository.setSetting("paused_from", "AUTO_LIVE");
    repository.setSetting("promotion_gate", {
      paperPassed: true,
      manualLivePassed: true
    });

    await expect(runtime!.preflightModeChange("AUTO_LIVE")).rejects.toThrow(
      "dedicated wallet and confirmed encrypted recovery backup"
    );
  });

  it("keeps one stable operation and advances attempts only after a known-safe failure", () => {
    const { repository } = setup();
    const position: PositionLot = {
      id: "live-position",
      mode: "LIVE",
      sourceWallet: "leader-wallet",
      sourceEntrySignature: "leader-entry",
      mint: SOL_MINT,
      openedAt: new Date().toISOString(),
      entryAmountAtomic: "1000",
      remainingAmountAtomic: "1000",
      entryCostUsd: 5,
      remainingCostUsd: 5,
      lastExecutableValueUsd: 4,
      pendingExitFraction: 0,
      status: "OPEN"
    };
    repository.upsertPosition(position);
    const liquidation = repository.beginEmergencyLiquidation("test");
    const first = repository.startEmergencyExitAttempt({
      liquidationId: liquidation.id,
      positionId: position.id,
      idempotencyKey: "attempt-1-key",
      sourceSignature: "attempt-1-source"
    });
    repository.updateEmergencyExitOperation(position.id, "SUBMITTED_UNRESOLVED", {
      targetSignature: "signature-1"
    });
    const quarantined = repository.startEmergencyExitAttempt({
      liquidationId: liquidation.id,
      positionId: position.id,
      idempotencyKey: "must-not-replace",
      sourceSignature: "must-not-replace"
    });
    expect(quarantined).toMatchObject({
      operationId: first.operationId,
      attempt: 1,
      idempotencyKey: "attempt-1-key",
      state: "SUBMITTED_UNRESOLVED"
    });

    repository.updateEmergencyExitOperation(position.id, "FAILED_SAFE", { lastError: "confirmed failed" });
    const second = repository.startEmergencyExitAttempt({
      liquidationId: liquidation.id,
      positionId: position.id,
      idempotencyKey: "attempt-2-key",
      sourceSignature: "attempt-2-source"
    });
    expect(second).toMatchObject({
      operationId: first.operationId,
      attempt: 2,
      idempotencyKey: "attempt-2-key",
      state: "PENDING"
    });
  });

  it("keeps a broadcast quarantined until chain evidence proves the attempt failed", async () => {
    const { repository } = setup();
    const at = new Date().toISOString();
    repository.upsertPosition({
      id: "ambiguous-position",
      mode: "LIVE",
      sourceWallet: "leader-wallet",
      sourceEntrySignature: "leader-entry",
      mint: SOL_MINT,
      openedAt: at,
      entryAmountAtomic: "1000",
      remainingAmountAtomic: "1000",
      entryCostUsd: 5,
      remainingCostUsd: 5,
      lastExecutableValueUsd: 4,
      pendingExitFraction: 0,
      status: "OPEN"
    });
    const liquidation = repository.beginEmergencyLiquidation("test reconciliation");
    repository.startEmergencyExitAttempt({
      liquidationId: liquidation.id,
      positionId: "ambiguous-position",
      idempotencyKey: "ambiguous-key",
      sourceSignature: "ambiguous-source"
    });
    const execution: ExecutionRecord = {
      id: "ambiguous-execution",
      idempotencyKey: "ambiguous-key",
      intentId: "intent",
      mode: "LIVE",
      status: "SUBMITTED_UNRESOLVED",
      createdAt: at,
      updatedAt: at,
      submittedAt: at,
      sourceSignature: "ambiguous-source",
      targetSignature: "deterministic-signature",
      quote: {
        requestId: "request",
        quotedAt: at,
        inputMint: SOL_MINT,
        outputMint: USDC_MINT,
        inputAmountAtomic: "1000",
        outputAmountAtomic: "4000000",
        inputUsd: 4,
        outputUsd: 4,
        priceImpactPercent: 0,
        slippageBps: 10,
        feeBps: 0,
        signatureFeeLamports: 5000,
        prioritizationFeeLamports: 0,
        rentFeeLamports: 0,
        minimumOutputAtomic: "3996000",
        router: "iris"
      }
    };
    repository.upsertExecution(execution);
    repository.updateEmergencyExitOperation("ambiguous-position", "SUBMITTED_UNRESOLVED", {
      executionId: execution.id,
      targetSignature: "deterministic-signature"
    });
    const harness = runtime! as unknown as {
      executionRpc: { getTransaction(signature: string): Promise<unknown> };
      reconcileEmergencySubmissions(): Promise<void>;
    };
    harness.executionRpc = {
      getTransaction: async () => ({ meta: { err: { InstructionError: [2, "Custom"] } } })
    };

    await harness.reconcileEmergencySubmissions();

    expect(repository.getExecution(execution.id)).toMatchObject({ status: "FAILED" });
    expect(repository.getEmergencyExitOperation("ambiguous-position")).toMatchObject({
      operationId: "emergency-exit:ambiguous-position",
      attempt: 1,
      state: "FAILED_SAFE",
      targetSignature: "deterministic-signature"
    });
  });

  it("anchors exactly $141 while leaving excess live funding unrelated", async () => {
    const { repository } = setup();
    repository.setSetting("wallet_address", "C8Zin6kMBRmuwW3hL17VuAJPN8hmb7kKpg9VdrfBbnKS");
    repository.setSetting("paper_initial_nav_usd", 141);

    let balances = {
      solLamports: 39_999_999n,
      tokenAmounts: new Map([[USDC_MINT, 135_000_000n]])
    };
    const harness = runtime! as unknown as {
      balanceReader: { read(owner: string): Promise<typeof balances> };
      solPriceCache: { price: number; at: number };
      reconcileLiveBalances(initialize: boolean): Promise<void>;
    };
    harness.balanceReader = { read: async () => balances };
    harness.solPriceCache = { price: 150, at: Date.now() };

    await expect(harness.reconcileLiveBalances(true)).rejects.toThrow("$6 of SOL and 135 USDC");
    balances = {
      solLamports: 40_000_000n,
      tokenAmounts: new Map([[USDC_MINT, 134_999_999n]])
    };
    await expect(harness.reconcileLiveBalances(true)).rejects.toThrow("$6 of SOL and 135 USDC");

    balances = {
      solLamports: 40_000_001n,
      tokenAmounts: new Map([[USDC_MINT, 135_000_001n]])
    };
    await expect(harness.reconcileLiveBalances(true)).resolves.toBeUndefined();
    expect(repository.getSetting("live_tracked_sol_lamports")).toBe("40000000");
    expect(repository.getSetting("live_tracked_usdc_atomic")).toBe("135000000");
    expect(repository.getSetting("live_start_nav_usd")).toBe(141);
    expect(repository.latestPortfolioSnapshot("LIVE")).toMatchObject({
      navUsd: 141,
      peakNavUsd: 141,
      dayStartNavUsd: 141,
      solReserveUsd: 6,
      liquidReserveUsd: 141
    });
  });

  it("builds promotion return and drawdown from cohort-tagged executable NAV marks", () => {
    const { repository, modes } = setup();
    const frozenAt = "2026-01-01T00:00:00.000Z";
    const evaluatedAt = "2026-01-03T00:00:00.000Z";
    const wallets = ["wallet-a", "wallet-b", "wallet-c"];
    repository.saveCohort({
      cohortId: "provider-cohort",
      generatedAt: frozenAt,
      candidates: wallets.map((address) => ({
        address,
        cohortId: "provider-cohort",
        firstSeenAt: "2025-01-01T00:00:00.000Z",
        lastSeenAt: frozenAt,
        control: false,
        tags: []
      }))
    });
    for (const wallet of wallets) {
      repository.saveWalletScore("provider-cohort", {
        wallet,
        calculatedAt: frozenAt,
        qualified: true,
        reasons: [],
        historyDays: 90,
        closedEligibleSwaps: 50,
        activeWeeks: 3,
        medianHoldingMinutes: 15,
        topTokenProfitShare: 0.2,
        topThreeProfitShare: 0.5
      });
    }
    repository.setActiveWallets("provider-cohort", wallets);
    const evaluation = repository.freezePaperEvaluationCohort(
      "provider-cohort",
      wallets,
      50,
      frozenAt
    )!.cohort;
    const snapshot = (capturedAt: string, navUsd: number, openPositions: number) => ({
      mode: "PAPER" as const,
      capturedAt,
      navUsd,
      peakNavUsd: Math.max(50, navUsd),
      dayStartNavUsd: 50,
      deployedUsd: openPositions > 0 ? 3 : 0,
      solReserveUsd: 5,
      liquidReserveUsd: navUsd - (openPositions > 0 ? 3 : 0),
      realizedPnlUsd: 0,
      unrealizedPnlUsd: navUsd - 50,
      openPositions,
      balanceMismatchPercent: 0,
      evaluationCohortId: evaluation.id,
      executablePricingComplete: true
    });
    repository.savePortfolioSnapshot(snapshot(frozenAt, 50, 0));
    repository.savePortfolioSnapshot(snapshot("2026-01-02T00:00:00.000Z", 60, 1));
    repository.savePortfolioSnapshot(snapshot(evaluatedAt, 53, 1));
    repository.upsertPosition({
      id: "marked-open-position",
      mode: "PAPER",
      sourceWallet: "wallet-a",
      sourceEntrySignature: "entry-signature",
      mint: SOL_MINT,
      openedAt: "2026-01-02T00:00:00.000Z",
      entryAmountAtomic: "1000",
      remainingAmountAtomic: "1000",
      entryCostUsd: 10,
      remainingCostUsd: 10,
      lastExecutableValueUsd: 3,
      pendingExitFraction: 0,
      status: "OPEN",
      evaluationCohortId: evaluation.id
    });
    repository.saveClosedTrade("pre-cohort-trade", "PAPER", {
      closedAt: "2025-12-20T00:00:00.000Z",
      pnlUsd: 100,
      sourceWallet: "wallet-a"
    });
    repository.saveClosedTrade("evaluation-trade", "PAPER", {
      closedAt: "2026-01-02T12:00:00.000Z",
      pnlUsd: 1,
      stressPnlUsd: 0.5,
      sourceWallet: "wallet-a",
      evaluationCohortId: evaluation.id
    });

    (runtime! as unknown as { updatePromotionGate(now: Date): void })
      .updatePromotionGate(new Date(evaluatedAt));

    expect(modes.promotion).toMatchObject({
      evaluationCohortId: evaluation.id,
      completedExits: 1,
      netReturnPercent: 6,
      paperPassed: false
    });
    expect(modes.promotion.maxDrawdownPercent).toBeCloseTo(11.6667, 3);
    expect(modes.promotion.blockers).toContain("paper maximum drawdown is above 10%");
  });
});
