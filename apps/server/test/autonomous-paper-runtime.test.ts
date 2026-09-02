import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SOL_MINT,
  TOKEN_PROGRAM_ID,
  USDC_MINT,
  type QuoteRequest
} from "@copylab/shared";
import {
  JupiterMarketDataProvider,
  JupiterSwapProvider,
  JupiterTokenRiskProvider,
  type JupiterMarketStats,
  type JupiterMarketTokenSnapshot
} from "@copylab/providers";
import {
  AUTONOMOUS_PAPER_POLICY_VERSION,
  AUTONOMOUS_PAPER_V10_POLICY,
  AUTONOMOUS_PAPER_V10_POLICY_VERSION,
  DEFAULT_AUTONOMOUS_PAPER_POLICY
} from "../src/autonomous-paper-policy.js";
import type { AutonomousPaperEngineOptions } from "../src/autonomous-paper.js";
import type { CopyLabDatabase } from "../src/database.js";
import { openDatabase } from "../src/database.js";
import { EventBus } from "../src/events.js";
import { ModeManager } from "../src/mode.js";
import { Repository } from "../src/repository.js";
import {
  AUTONOMOUS_MARKET_HEALTH_CACHE_TTL_MS,
  AUTONOMOUS_PAPER_SCHEDULER_POLL_INTERVAL_MS,
  TradingRuntime
} from "../src/runtime.js";
import { SecretVault } from "../src/vault.js";
import type { DpapiTransactionSigner } from "../src/wallet.js";
import { WalletManager } from "../src/wallet.js";

const LANE_ID = "autonomous-runtime-paper";
const TARGET_MINT = "AutonomousRuntimeMint11111111111111111111111";

function stats(overrides: Partial<JupiterMarketStats> = {}): JupiterMarketStats {
  return {
    priceChange: 4,
    liquidityChange: 1,
    volumeChange: 20,
    buyVolume: 40_000,
    sellVolume: 10_000,
    buyOrganicVolume: 40_000,
    sellOrganicVolume: 10_000,
    numBuys: 120,
    numSells: 30,
    numTraders: 100,
    numOrganicBuyers: 100,
    numNetBuyers: 70,
    ...overrides
  };
}

function marketToken(
  mint: string,
  capturedAt: string,
  overrides: Partial<JupiterMarketTokenSnapshot> = {}
): JupiterMarketTokenSnapshot {
  return {
    mint,
    name: mint === SOL_MINT ? "Wrapped SOL" : "Runtime Momentum",
    symbol: mint === SOL_MINT ? "SOL" : "RUN",
    decimals: mint === SOL_MINT ? 9 : 6,
    tokenProgram: TOKEN_PROGRAM_ID,
    firstPoolAt: "2026-01-01T00:00:00.000Z",
    holderCount: 5_000,
    fdvUsd: 30_000_000,
    marketCapUsd: 20_000_000,
    priceUsd: mint === SOL_MINT ? 150 : 0.5,
    liquidityUsd: 3_000_000,
    stats5m: stats(),
    stats1h: stats({
      priceChange: mint === SOL_MINT ? 0 : 14,
      buyVolume: 300_000,
      sellVolume: 100_000,
      buyOrganicVolume: 200_000,
      sellOrganicVolume: 50_000,
      numOrganicBuyers: 500
    }),
    stats6h: stats({ priceChange: mint === SOL_MINT ? 1 : 20 }),
    stats24h: stats({ priceChange: 30, buyVolume: 4_000_000, sellVolume: 1_000_000 }),
    organicScore: 90,
    organicScoreLabel: "high",
    verified: true,
    tags: [],
    suspicious: false,
    mintAuthorityDisabled: true,
    freezeAuthorityDisabled: true,
    topHoldersPercent: 20,
    updatedAt: capturedAt,
    categoryRanks: mint === SOL_MINT
      ? {}
      : { topTraded24h: 1, topTrending1h: 1 },
    ...overrides
  };
}

describe("autonomous PAPER runtime isolation", () => {
  let db: CopyLabDatabase | undefined;
  let runtime: TradingRuntime | undefined;
  let repository: Repository | undefined;
  let vault: SecretVault | undefined;
  const signerGetAddress = vi.fn(async () => {
    throw new Error("The autonomous PAPER strategy must not request a signer address.");
  });
  const signerSign = vi.fn(async () => {
    throw new Error("The autonomous PAPER strategy must not sign a transaction.");
  });

  afterEach(async () => {
    vi.useRealTimers();
    await runtime?.stop();
    db?.close();
    runtime = undefined;
    repository = undefined;
    vault = undefined;
    signerGetAddress.mockClear();
    signerSign.mockClear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function setup(mode: "PAPER" | "PAUSED" | "MANUAL_LIVE" = "PAPER") {
    db = openDatabase(":memory:");
    repository = new Repository(db);
    repository.setSetting("mode", mode);
    vault = new SecretVault(repository);
    const wallet = new WalletManager(vault, repository);
    const modes = new ModeManager(repository, wallet);
    const signer = {
      getAddress: signerGetAddress,
      signValidatedTransaction: signerSign
    } as unknown as DpapiTransactionSigner;
    runtime = new TradingRuntime(repository, vault, modes, new EventBus(), signer);
    return { repository, vault, runtime, modes };
  }

  function createLane(repo: Repository, frozenV10 = false): void {
    repo.createAutonomousPaperLane({
      id: LANE_ID,
      policyVersion: frozenV10
        ? AUTONOMOUS_PAPER_V10_POLICY_VERSION
        : AUTONOMOUS_PAPER_POLICY_VERSION,
      policy: { ...(frozenV10 ? AUTONOMOUS_PAPER_V10_POLICY : DEFAULT_AUTONOMOUS_PAPER_POLICY) },
      initialNavUsd: 141,
      startedAt: "2026-07-14T12:00:00.000Z"
    });
    repo.initializeAutonomousPaperAccount(LANE_ID, "2026-07-14T12:00:00.000Z");
  }

  it("polls policy buckets every minute without shrinking the market-health cache", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-14T12:00:00.000Z"));
    const { runtime } = setup();
    const checkHealth = vi.fn(async () => ({
      provider: "jupiter" as const,
      ok: true,
      checkedAt: new Date().toISOString(),
      message: "market healthy"
    }));
    const harness = runtime as unknown as {
      providers: unknown;
      checkAutonomousMarketHealth(): Promise<unknown>;
    };
    harness.providers = { market: { checkHealth } };

    expect(AUTONOMOUS_PAPER_SCHEDULER_POLL_INTERVAL_MS).toBe(60_000);
    expect(AUTONOMOUS_MARKET_HEALTH_CACHE_TTL_MS).toBe(5 * 60_000);
    await harness.checkAutonomousMarketHealth();
    vi.setSystemTime(new Date("2026-07-14T12:04:59.999Z"));
    await harness.checkAutonomousMarketHealth();
    expect(checkHealth).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date("2026-07-14T12:05:00.001Z"));
    await harness.checkAutonomousMarketHealth();
    expect(checkHealth).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent autonomous market-health diagnostics", async () => {
    const { runtime } = setup();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const checkHealth = vi.fn(async () => {
      await pending;
      return {
        provider: "jupiter" as const,
        ok: true,
        checkedAt: new Date().toISOString(),
        message: "all seven market categories healthy"
      };
    });
    const harness = runtime as unknown as {
      providers: unknown;
      checkAutonomousMarketHealth(): Promise<unknown>;
    };
    harness.providers = { market: { checkHealth } };

    const first = harness.checkAutonomousMarketHealth();
    const second = harness.checkAutonomousMarketHealth();
    await vi.waitFor(() => expect(checkHealth).toHaveBeenCalledTimes(1));
    release();

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(checkHealth).toHaveBeenCalledTimes(1);
  });

  it("discards an in-flight market-health result when its provider generation is superseded", async () => {
    const { runtime } = setup();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const checkHealth = vi.fn(async () => {
      await pending;
      return {
        provider: "jupiter" as const,
        ok: true,
        checkedAt: new Date().toISOString(),
        message: "old provider healthy"
      };
    });
    const harness = runtime as unknown as {
      providers: unknown;
      providerWorkGeneration: number;
      lastAutonomousMarketHealth?: unknown;
      autonomousMarketHealthRefresh?: unknown;
      checkAutonomousMarketHealth(): Promise<unknown>;
    };
    harness.providers = { market: { checkHealth } };

    const oldHealth = harness.checkAutonomousMarketHealth();
    await vi.waitFor(() => expect(checkHealth).toHaveBeenCalledTimes(1));
    harness.providerWorkGeneration += 1;
    release();

    await expect(oldHealth).rejects.toThrow("Provider-owned work was superseded");
    expect(harness.lastAutonomousMarketHealth).toBeUndefined();
    expect(harness.autonomousMarketHealthRefresh).toBeUndefined();
  });

  it("allows only an explicitly authorized same-generation health refresh while quiesced", async () => {
    const { runtime } = setup();
    const checkHealth = vi.fn(async () => ({
      provider: "jupiter" as const,
      ok: true,
      checkedAt: new Date().toISOString(),
      message: "new provider healthy"
    }));
    const harness = runtime as unknown as {
      providers: unknown;
      providerWorkQuiesced: boolean;
      checkAutonomousMarketHealth(allowQuiesced?: boolean): Promise<unknown>;
    };
    harness.providers = { market: { checkHealth } };
    harness.providerWorkQuiesced = true;

    await expect(harness.checkAutonomousMarketHealth()).rejects.toThrow(
      "Provider-owned work was superseded"
    );
    await expect(harness.checkAutonomousMarketHealth(true)).resolves.toMatchObject({
      ok: true,
      message: "new provider healthy"
    });
    expect(checkHealth).toHaveBeenCalledOnce();
  });

  it("does not publish failed market health when a universe scan is superseded", async () => {
    const { repository, runtime } = setup();
    createLane(repository);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fetchSignalUniverse = vi.fn(async () => {
      await gate;
      return [];
    });
    const preservedHealth = {
      provider: "jupiter" as const,
      ok: true,
      checkedAt: new Date().toISOString(),
      message: "current provider health"
    };
    const harness = runtime as unknown as {
      providers: unknown;
      providerWorkGeneration: number;
      lastAutonomousMarketHealth?: unknown;
      fetchAutonomousSignalUniverse(): Promise<unknown>;
    };
    harness.providers = { market: { fetchSignalUniverse } };

    const scan = harness.fetchAutonomousSignalUniverse();
    await vi.waitFor(() => expect(fetchSignalUniverse).toHaveBeenCalledOnce());
    harness.providerWorkGeneration += 1;
    harness.lastAutonomousMarketHealth = preservedHealth;
    release();

    await expect(scan).rejects.toThrow("Provider-owned work was superseded");
    expect(harness.lastAutonomousMarketHealth).toBe(preservedHealth);
  });

  it("still publishes failed market health for a current-generation universe failure", async () => {
    const { repository, runtime } = setup();
    createLane(repository);
    const harness = runtime as unknown as {
      providers: unknown;
      lastAutonomousMarketHealth?: { ok: boolean; message: string };
      fetchAutonomousSignalUniverse(): Promise<unknown>;
    };
    harness.providers = {
      market: {
        fetchSignalUniverse: async () => {
          throw new Error("current provider outage");
        }
      }
    };

    await expect(harness.fetchAutonomousSignalUniverse()).rejects.toThrow("current provider outage");
    expect(harness.lastAutonomousMarketHealth).toMatchObject({
      ok: false,
      message: "Jupiter autonomous market category scan failed safely"
    });
  });

  it("queues cycles only in exact PAPER with configured providers and an active lane", async () => {
    const { repository, runtime } = setup();
    createLane(repository);
    const enqueueCycle = vi.fn(async () => undefined);
    const harness = runtime as unknown as {
      providers?: unknown;
      providerWorkQuiesced: boolean;
      autonomousPaper: {
        enqueueCycle(): Promise<void>;
        drain(): Promise<void>;
        recoverInterruptedClaims(): number;
      };
      queueAutonomousPaperCycle(): void;
    };
    harness.autonomousPaper = {
      enqueueCycle,
      drain: async () => undefined,
      recoverInterruptedClaims: () => 0
    };

    harness.queueAutonomousPaperCycle();
    expect(enqueueCycle).not.toHaveBeenCalled();

    harness.providers = {};
    harness.queueAutonomousPaperCycle();
    await Promise.resolve();
    expect(enqueueCycle).toHaveBeenCalledOnce();

    repository.setSetting("mode", "PAUSED");
    harness.queueAutonomousPaperCycle();
    expect(enqueueCycle).toHaveBeenCalledOnce();

    repository.setSetting("mode", "PAPER");
    repository.pauseAutonomousPaperLane(LANE_ID);
    harness.queueAutonomousPaperCycle();
    expect(enqueueCycle).toHaveBeenCalledOnce();

    repository.resumeAutonomousPaperLane(LANE_ID);
    harness.providerWorkQuiesced = true;
    harness.queueAutonomousPaperCycle();
    expect(enqueueCycle).toHaveBeenCalledOnce();
  });

  it.runIf(process.platform === "win32")(
    "configures every Jupiter client with the runtime's exact account-wide request coordinator",
    async () => {
      const { vault, runtime } = setup();
      vault.setCredentials({
        birdeyeApiKey: "birdeye-runtime-test",
        heliusApiKey: "helius-runtime-test",
        jupiterApiKey: "jupiter-runtime-test"
      });
      const harness = runtime as unknown as {
        jupiterFetch: unknown;
        providers?: {
          token: JupiterTokenRiskProvider;
          market: JupiterMarketDataProvider;
          swap: JupiterSwapProvider;
        };
        configureProviders(): Promise<void>;
      };

      await harness.configureProviders();

      expect(harness.providers?.token).toBeInstanceOf(JupiterTokenRiskProvider);
      expect(harness.providers?.market).toBeInstanceOf(JupiterMarketDataProvider);
      expect(harness.providers?.swap).toBeInstanceOf(JupiterSwapProvider);
      expect(harness.providers?.market).not.toBe(harness.providers?.swap);
      expect((harness.providers!.token as unknown as { fetch: unknown }).fetch)
        .toBe(harness.jupiterFetch);
      expect((harness.providers!.market as unknown as { fetch: unknown }).fetch)
        .toBe(harness.jupiterFetch);
      expect((harness.providers!.swap as unknown as { fetch: unknown }).fetch)
        .toBe(harness.jupiterFetch);
      expect("quote" in harness.providers!.market).toBe(false);
      expect("getAddress" in harness.providers!.market).toBe(false);
      expect("signValidatedTransaction" in harness.providers!.market).toBe(false);
      expect("execute" in harness.providers!.market).toBe(false);
    }
  );

  it("recovers one quote-only 429 through the shared coordinator without signer or execute", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-14T12:00:00.000Z"));
    const { repository, runtime } = setup();
    repository.setSetting("last_sol_price_usd", 150);
    createLane(repository, true);
    const requestedUrls: URL[] = [];
    let rateLimitedRequests = 0;
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      requestedUrls.push(url);
      expect(init?.method).toBeUndefined();
      expect(url.pathname).toBe("/swap/v2/order");
      expect(url.searchParams.has("taker")).toBe(false);
      if (requestedUrls.length === 1) {
        rateLimitedRequests += 1;
        return new Response(JSON.stringify({ code: 429, message: "test rate limit" }), {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "0" }
        });
      }
      const buying = url.searchParams.get("inputMint") === USDC_MINT;
      const requestedUsd = Number(url.searchParams.get("amount")) / 1_000_000;
      const response = {
        inputMint: url.searchParams.get("inputMint"),
        outputMint: url.searchParams.get("outputMint"),
        inAmount: url.searchParams.get("amount"),
        outAmount: buying ? "70000000" : "34500000",
        inUsdValue: buying ? requestedUsd : 34.5,
        outUsdValue: buying ? 35 : 34.5,
        priceImpact: 0.001,
        priceImpactPct: 0.00001,
        otherAmountThreshold: buying ? "69000000" : "34300000",
        slippageBps: 10,
        feeBps: 0,
        signatureFeeLamports: 5_000,
        prioritizationFeeLamports: 0,
        rentFeeLamports: 0,
        router: "metis",
        transaction: null,
        requestId: `quote-only-${requestedUrls.length}`
      };
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    vi.stubGlobal("fetch", fetch);
    const sharedJupiterFetch = (runtime as unknown as { jupiterFetch: typeof fetch }).jupiterFetch;
    const swap = new JupiterSwapProvider("jupiter-runtime-test", {
      baseUrl: "https://api.jup.ag/swap/v2",
      fetch: sharedJupiterFetch
    });
    const execute = vi.spyOn(swap, "execute");
    const market = {
      fetchSignalUniverse: vi.fn(async () => {
        const capturedAt = new Date().toISOString();
        return { capturedAt, tokens: [marketToken(TARGET_MINT, capturedAt)] };
      }),
      lookupMints: vi.fn(async (mints: readonly string[]) => {
        const capturedAt = new Date().toISOString();
        return mints.map((mint) => marketToken(mint, capturedAt));
      })
    };
    const harness = runtime as unknown as {
      providers: unknown;
      autonomousPaper: {
        options: AutonomousPaperEngineOptions;
        drain(): Promise<void>;
      };
      queueAutonomousPaperCycle(): void;
    };
    harness.providers = { market, swap };

    expect(Object.keys(harness.autonomousPaper.options).sort()).toEqual([
      "fetchSignalUniverse",
      "learningStrategy",
      "lookupMints",
      "mode",
      "newEntriesAllowed",
      "onError",
      "onUniverse",
      "onUpdate",
      "quote",
      "solPriceUsd"
    ]);

    harness.queueAutonomousPaperCycle();
    const firstCycle = harness.autonomousPaper.drain();
    await vi.runAllTimersAsync();
    await firstCycle;

    expect(rateLimitedRequests).toBe(1);
    // V10 uses one quote-quality probe pair, an exact downsized pair, and a
    // quote-only learning observation. The first probe BUY is retried once by
    // the shared 429 coordinator.
    expect(requestedUrls).toHaveLength(7);
    expect(requestedUrls.filter((url) => url.searchParams.get("inputMint") === USDC_MINT))
      .toHaveLength(4);
    expect(requestedUrls.every((url) => !url.searchParams.has("taker"))).toBe(true);
    expect(repository.listAutonomousPaperPositions({ laneId: LANE_ID, openOnly: true }))
      .toHaveLength(1);
    expect(signerGetAddress).not.toHaveBeenCalled();
    expect(signerSign).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(7);
  });

  it("drains before recovery and queues the recovered active lane only in PAPER", async () => {
    const { repository, runtime } = setup();
    createLane(repository);
    const lifecycle: string[] = [];
    const harness = runtime as unknown as {
      providers: unknown;
      autonomousPaper: {
        enqueueCycle(): Promise<void>;
        drain(): Promise<void>;
        recoverInterruptedClaims(): number;
      };
    };
    harness.providers = {};
    harness.autonomousPaper = {
      drain: async () => { lifecycle.push("drain"); },
      recoverInterruptedClaims: () => {
        lifecycle.push("recover");
        return 2;
      },
      enqueueCycle: async () => { lifecycle.push("enqueue"); }
    };

    await runtime.autonomousPaperConfigurationChanged();

    expect(lifecycle).toEqual(["drain", "recover", "enqueue"]);

    lifecycle.length = 0;
    repository.setSetting("mode", "PAUSED");
    await runtime.autonomousPaperConfigurationChanged();
    expect(lifecycle).toEqual(["drain", "recover", "drain"]);
  });
});
