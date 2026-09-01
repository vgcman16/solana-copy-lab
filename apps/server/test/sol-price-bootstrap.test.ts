import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BIRDEYE_SOL_USD_HISTORY_SOURCE,
  PYTH_SOL_USD_FEED_ID,
  PYTH_SOL_USD_HISTORY_SOURCE,
  PythBenchmarksRequestError,
  PythBenchmarksValidationError,
  type PythBenchmarksPriceProvider,
  type PythBenchmarksSolUsdPrice,
  type SolUsdHistoricalPriceProvider
} from "@copylab/providers";
import type { CopyLabDatabase } from "../src/database.js";
import { openDatabase } from "../src/database.js";
import { EventBus } from "../src/events.js";
import { ModeManager } from "../src/mode.js";
import { Repository } from "../src/repository.js";
import { TradingRuntime } from "../src/runtime.js";
import {
  SolPriceBootstrapCheckpointError,
  SolPriceBootstrapWorker
} from "../src/sol-price-bootstrap.js";
import {
  SOL_PRICE_BOOTSTRAP_INTERVAL_SECONDS,
  SOL_PRICE_BOOTSTRAP_REFRESH_LAG_SECONDS,
  SOL_PRICE_BOOTSTRAP_SETTING,
  SOL_PRICE_BOOTSTRAP_TOTAL_POINTS,
  type SolPriceBootstrapCheckpoint
} from "../src/sol-price-bootstrap-state.js";
import { SecretVault } from "../src/vault.js";
import { DpapiTransactionSigner, WalletManager } from "../src/wallet.js";

const NOW_ISO = "2026-07-10T03:20:00.000Z";

function price(timestampSeconds: number, priceUsd = 78.5): PythBenchmarksSolUsdPrice {
  return {
    source: PYTH_SOL_USD_HISTORY_SOURCE,
    feedId: PYTH_SOL_USD_FEED_ID,
    requestedTimestampSeconds: timestampSeconds,
    observationTimestampSeconds: timestampSeconds,
    publishTimeSeconds: timestampSeconds,
    priceMantissa: "7850000000",
    confidenceMantissa: "1000000",
    exponent: -8,
    priceUsd,
    confidenceUsd: 0.01,
    confidenceRatio: 1 / 7_850
  };
}

class FakePythProvider implements PythBenchmarksPriceProvider {
  readonly authenticationConfigured: boolean;
  readonly calls: number[] = [];
  outcomes: Array<PythBenchmarksSolUsdPrice | Error> = [];

  constructor(authenticationConfigured = false) {
    this.authenticationConfigured = authenticationConfigured;
  }

  get pythAuthenticationConfigured(): boolean { return this.authenticationConfigured; }
  readonly fallbackConfigured = false as const;
  readonly activeSource = PYTH_SOL_USD_HISTORY_SOURCE;

  async getSolUsdPrice(timestampSeconds: number): Promise<PythBenchmarksSolUsdPrice> {
    this.calls.push(timestampSeconds);
    const outcome = this.outcomes.shift();
    if (outcome instanceof Error) throw outcome;
    return outcome ?? price(timestampSeconds);
  }
}

class ControlledPythProvider implements PythBenchmarksPriceProvider {
  readonly authenticationConfigured = true;
  readonly pythAuthenticationConfigured = true;
  readonly fallbackConfigured = false as const;
  readonly activeSource = PYTH_SOL_USD_HISTORY_SOURCE;
  readonly calls: number[] = [];
  private releasePending: (() => void) | undefined;

  async getSolUsdPrice(timestampSeconds: number): Promise<PythBenchmarksSolUsdPrice> {
    this.calls.push(timestampSeconds);
    return new Promise<PythBenchmarksSolUsdPrice>((resolve) => {
      this.releasePending = () => resolve(price(timestampSeconds));
    });
  }

  releaseCurrent(): void {
    if (!this.releasePending) throw new Error("No controlled Pyth request is pending.");
    const release = this.releasePending;
    this.releasePending = undefined;
    release();
  }
}

class FakeBirdeyeHistoryProvider implements SolUsdHistoricalPriceProvider {
  readonly authenticationConfigured = true;
  readonly pythAuthenticationConfigured = false;
  readonly fallbackConfigured = true;
  readonly activeSource = BIRDEYE_SOL_USD_HISTORY_SOURCE;
  readonly calls: number[] = [];

  async getSolUsdPrice(timestampSeconds: number) {
    this.calls.push(timestampSeconds);
    return {
      source: BIRDEYE_SOL_USD_HISTORY_SOURCE,
      requestedTimestampSeconds: timestampSeconds,
      observationTimestampSeconds: timestampSeconds,
      priceUsd: 81.25
    };
  }
}

describe("SolPriceBootstrapWorker", () => {
  let db: CopyLabDatabase | undefined;

  afterEach(() => {
    vi.restoreAllMocks();
    db?.close();
    db = undefined;
  });

  function setup(
    provider = new FakePythProvider(),
    options: ConstructorParameters<typeof SolPriceBootstrapWorker>[2] = {}
  ): { repository: Repository; provider: FakePythProvider; worker: SolPriceBootstrapWorker } {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const worker = new SolPriceBootstrapWorker(repository, provider, {
      now: () => new Date(NOW_ISO),
      ...options
    });
    return { repository, provider, worker };
  }

  it("remains IDLE and performs no network I/O until explicitly initialized", async () => {
    const { provider, worker } = setup(new FakePythProvider(true));
    expect(worker.status()).toMatchObject({
      phase: "IDLE",
      activeInProcess: false,
      authenticationConfigured: true,
      checkpointValid: true,
      totalPoints: SOL_PRICE_BOOTSTRAP_TOTAL_POINTS,
      completedPoints: 0
    });
    await expect(worker.runOnce()).resolves.toBe(false);
    expect(provider.calls).toEqual([]);
  });

  it("keeps IDLE and explicitly PAUSED cursors dormant during automatic recovery", async () => {
    const { repository, provider, worker } = setup(new FakePythProvider(true));

    expect(worker.resumePersistedActive()).toMatchObject({ phase: "IDLE", activeInProcess: false });
    expect(provider.calls).toEqual([]);

    worker.initializeAuthorized();
    await worker.pause();
    expect(worker.status()).toMatchObject({ phase: "PAUSED", activeInProcess: false });

    const restartedProvider = new FakePythProvider(true);
    const restarted = new SolPriceBootstrapWorker(repository, restartedProvider, {
      now: () => new Date(NOW_ISO)
    });
    expect(restarted.resumePersistedActive()).toMatchObject({ phase: "PAUSED", activeInProcess: false });
    expect(restartedProvider.calls).toEqual([]);
  });

  it("preserves a RUNNING cursor across graceful runtime stops and resumes exactly once after restart", async () => {
    const { repository, worker: initializer } = setup();
    repository.setSetting("mode", "PAPER");
    initializer.initializeAuthorized();
    const initialCursor = repository.getSolPriceBootstrapCheckpoint()!.nextTimestampSeconds;

    const createRuntime = (worker: SolPriceBootstrapWorker): TradingRuntime => {
      const vault = new SecretVault(repository);
      const wallet = new WalletManager(vault, repository);
      return new TradingRuntime(
        repository,
        vault,
        new ModeManager(repository, wallet),
        new EventBus(),
        new DpapiTransactionSigner(vault, repository),
        { solPriceBootstrapWorker: worker }
      );
    };
    const stopAfterWorkerEntry = async (
      runtime: TradingRuntime,
      worker: SolPriceBootstrapWorker,
      provider: ControlledPythProvider
    ): Promise<void> => {
      let entered!: () => void;
      const workerEntered = new Promise<void>((resolve) => { entered = resolve; });
      const stopPreserving = worker.stopPreservingAuthorization.bind(worker);
      vi.spyOn(worker, "stopPreservingAuthorization").mockImplementation(async () => {
        entered();
        return stopPreserving();
      });
      const stopping = runtime.stop();
      await workerEntered;
      provider.releaseCurrent();
      await stopping;
    };

    const firstProvider = new ControlledPythProvider();
    const firstWorker = new SolPriceBootstrapWorker(repository, firstProvider, {
      now: () => new Date(NOW_ISO)
    });
    const firstRuntime = createRuntime(firstWorker);
    await firstRuntime.start();
    expect(firstProvider.calls).toEqual([initialCursor]);
    await stopAfterWorkerEntry(firstRuntime, firstWorker, firstProvider);

    const afterFirstStop = repository.getSolPriceBootstrapCheckpoint()!;
    expect(firstWorker.status()).toMatchObject({ phase: "RUNNING", activeInProcess: false, completedPoints: 1 });
    expect(afterFirstStop.nextTimestampSeconds).toBe(initialCursor + SOL_PRICE_BOOTSTRAP_INTERVAL_SECONDS);

    const secondProvider = new ControlledPythProvider();
    const secondWorker = new SolPriceBootstrapWorker(repository, secondProvider, {
      now: () => new Date(NOW_ISO)
    });
    const secondRuntime = createRuntime(secondWorker);
    await secondRuntime.start();
    expect(secondProvider.calls).toEqual([afterFirstStop.nextTimestampSeconds]);
    await stopAfterWorkerEntry(secondRuntime, secondWorker, secondProvider);

    expect(secondWorker.status()).toMatchObject({ phase: "RUNNING", activeInProcess: false, completedPoints: 2 });
    expect(repository.listAudit(20)).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventType: "sol_price_bootstrap_auto_resumed" })
    ]));
  });

  it("auto-recovers RETRY_WAIT without bypassing its durable retry time", async () => {
    let now = new Date(NOW_ISO);
    const initialProvider = new FakePythProvider(true);
    initialProvider.outcomes.push(new PythBenchmarksRequestError(429, true));
    const { repository, worker } = setup(initialProvider, {
      now: () => now,
      retryBaseMs: 1_000,
      maximumRetryDelayMs: 5_000,
      maximumAttempts: 3
    });
    worker.initializeAuthorized();
    await worker.runOnce();
    const waiting = worker.status();
    expect(waiting).toMatchObject({ phase: "RETRY_WAIT", cursorAttempts: 1 });

    let releaseSleep!: () => void;
    let sleepEntered!: () => void;
    const sleeping = new Promise<void>((resolve) => { sleepEntered = resolve; });
    const waitingProvider = new FakePythProvider(true);
    const restarted = new SolPriceBootstrapWorker(repository, waitingProvider, {
      now: () => now,
      sleep: () => new Promise<void>((resolve) => {
        releaseSleep = resolve;
        sleepEntered();
      })
    });
    expect(restarted.resumePersistedActive()).toMatchObject({ phase: "RETRY_WAIT", activeInProcess: true });
    await sleeping;
    expect(waitingProvider.calls).toEqual([]);
    const stopWaiting = restarted.stopPreservingAuthorization();
    releaseSleep();
    await stopWaiting;
    expect(restarted.status()).toMatchObject({ phase: "RETRY_WAIT", activeInProcess: false });

    now = new Date(waiting.nextRetryAt!);
    const dueProvider = new ControlledPythProvider();
    const due = new SolPriceBootstrapWorker(repository, dueProvider, { now: () => now });
    expect(due.resumePersistedActive()).toMatchObject({ phase: "RETRY_WAIT", activeInProcess: true });
    expect(dueProvider.calls).toEqual([repository.getSolPriceBootstrapCheckpoint()!.nextTimestampSeconds]);
    const stopDue = due.stopPreservingAuthorization();
    dueProvider.releaseCurrent();
    await stopDue;
    expect(due.status()).toMatchObject({ phase: "RUNNING", activeInProcess: false, completedPoints: 1 });
  });

  it("exposes an explicit runtime start/status/pause seam without auto-running", async () => {
    const { repository, provider, worker } = setup();
    const vault = new SecretVault(repository);
    const wallet = new WalletManager(vault, repository);
    const runtime = new TradingRuntime(
      repository,
      vault,
      new ModeManager(repository, wallet),
      new EventBus(),
      new DpapiTransactionSigner(vault, repository),
      { solPriceBootstrapWorker: worker }
    );
    expect(runtime.solPriceBootstrapStatus()).toMatchObject({ phase: "IDLE", activeInProcess: false });
    expect(provider.calls).toEqual([]);

    expect(runtime.startSolPriceBootstrap()).toMatchObject({ phase: "RUNNING", activeInProcess: true });
    const paused = await runtime.pauseSolPriceBootstrap();
    expect(paused).toMatchObject({ phase: "PAUSED", activeInProcess: false, completedPoints: 1 });
    expect(provider.calls).toHaveLength(1);
  });

  it("freezes an inclusive 90-day ten-minute grid and preserves an existing Jupiter timestamp", async () => {
    const { repository, provider, worker } = setup();
    const initialized = worker.initializeAuthorized();
    expect(initialized).toMatchObject({
      phase: "RUNNING",
      intervalSeconds: 600,
      horizonDays: 90,
      totalPoints: 12_961,
      completedPoints: 0
    });
    const checkpoint = repository.getSolPriceBootstrapCheckpoint()!;
    expect(checkpoint.windowEndSeconds - checkpoint.windowStartSeconds).toBe(90 * 24 * 60 * 60);
    expect(checkpoint.nextTimestampSeconds).toBe(checkpoint.windowStartSeconds);
    expect(provider.calls).toEqual([]);

    const capturedAt = new Date(checkpoint.windowStartSeconds * 1_000).toISOString();
    repository.saveSolPriceSnapshot({ capturedAt, priceUsd: 79, source: "jupiter_quote" });
    await expect(worker.runOnce()).resolves.toBe(true);
    expect(repository.getSolPriceSnapshotAt(capturedAt)).toEqual({
      capturedAt,
      priceUsd: 79,
      source: "jupiter_quote"
    });
    expect(worker.status()).toMatchObject({
      completedPoints: 1,
      insertedSnapshots: 0,
      preservedSnapshots: 1,
      cursorAttempts: 0
    });
  });

  it("resumes a durable cursor in a new worker without refetching completed points", async () => {
    const { repository, provider, worker } = setup();
    worker.initializeAuthorized();
    await worker.runOnce();
    const afterFirst = repository.getSolPriceBootstrapCheckpoint()!;

    const resumedProvider = new FakePythProvider();
    const resumed = new SolPriceBootstrapWorker(repository, resumedProvider, {
      now: () => new Date(NOW_ISO)
    });
    resumed.initializeAuthorized();
    await resumed.runOnce();

    expect(provider.calls).toEqual([afterFirst.windowStartSeconds]);
    expect(resumedProvider.calls).toEqual([afterFirst.nextTimestampSeconds]);
    expect(resumed.status().completedPoints).toBe(2);
  });

  it("resumes a failed Pyth cursor with explicit Birdeye provenance without replacing Pyth evidence", async () => {
    const { repository, worker } = setup(new FakePythProvider(true));
    worker.initializeAuthorized();
    await worker.runOnce();
    const afterPyth = repository.getSolPriceBootstrapCheckpoint()!;
    const pythTimestamp = new Date(afterPyth.windowStartSeconds * 1_000).toISOString();
    expect(repository.getSolPriceSnapshotAt(pythTimestamp)?.source).toBe("pyth_benchmarks");
    repository.saveSolPriceBootstrapCheckpoint({
      ...afterPyth,
      phase: "FAILED",
      cursorAttempts: 1,
      lastError: "Pyth Benchmarks rejected the request (HTTP 404)."
    });

    const fallback = new FakeBirdeyeHistoryProvider();
    const resumed = new SolPriceBootstrapWorker(repository, fallback, {
      now: () => new Date(NOW_ISO)
    });
    const preservedCursor = repository.getSolPriceBootstrapCheckpoint()!.nextTimestampSeconds;
    resumed.initializeAuthorized();
    await resumed.runOnce();

    expect(fallback.calls).toEqual([preservedCursor]);
    expect(repository.getSolPriceSnapshotAt(pythTimestamp)?.source).toBe("pyth_benchmarks");
    expect(repository.getSolPriceSnapshotAt(new Date(preservedCursor * 1_000).toISOString())).toEqual({
      capturedAt: new Date(preservedCursor * 1_000).toISOString(),
      priceUsd: 81.25,
      source: "birdeye_ohlcv_v3"
    });
    expect(resumed.status()).toMatchObject({
      completedPoints: 2,
      activeSource: "birdeye_ohlcv_v3",
      managedFallbackConfigured: true,
      pythAuthenticationConfigured: false
    });
  });

  it("persists retry timing and attempts for transient 429 failures", async () => {
    let now = new Date(NOW_ISO);
    const provider = new FakePythProvider();
    provider.outcomes.push(new PythBenchmarksRequestError(429, true));
    const { worker } = setup(provider, {
      now: () => now,
      retryBaseMs: 1_000,
      maximumRetryDelayMs: 5_000,
      maximumAttempts: 3
    });
    worker.initializeAuthorized();

    await expect(worker.runOnce()).resolves.toBe(true);
    const waiting = worker.status();
    expect(waiting).toMatchObject({
      phase: "RETRY_WAIT",
      completedPoints: 0,
      cursorAttempts: 1,
      lastError: "Pyth Benchmarks is temporarily unavailable (HTTP 429)."
    });
    expect(waiting.lastError).not.toContain("http://");
    await expect(worker.runOnce()).resolves.toBe(false);
    expect(provider.calls).toHaveLength(1);

    now = new Date(Date.parse(waiting.nextRetryAt!));
    await expect(worker.runOnce()).resolves.toBe(true);
    expect(worker.status()).toMatchObject({ phase: "RUNNING", completedPoints: 1, cursorAttempts: 0 });
    expect(provider.calls).toHaveLength(2);
  });

  it("fails closed without advancing on malformed or non-retryable responses", async () => {
    const provider = new FakePythProvider();
    provider.outcomes.push(new PythBenchmarksValidationError("MANTISSA"));
    const { repository, worker } = setup(provider);
    worker.initializeAuthorized();
    const before = repository.getSolPriceBootstrapCheckpoint()!;

    await expect(worker.runOnce()).resolves.toBe(true);
    expect(worker.status()).toMatchObject({
      phase: "FAILED",
      completedPoints: 0,
      cursorAttempts: 1,
      lastError: "Pyth Benchmarks response failed strict validation (MANTISSA)."
    });
    expect(repository.getSolPriceBootstrapCheckpoint()?.nextTimestampSeconds).toBe(before.nextTimestampSeconds);
    expect(repository.getSolPriceSnapshotAt(new Date(before.nextTimestampSeconds * 1_000).toISOString())).toBeUndefined();
  });

  it("fails closed on a corrupt durable checkpoint and sends no request", async () => {
    const { repository, provider, worker } = setup();
    repository.setSetting(SOL_PRICE_BOOTSTRAP_SETTING, {
      version: 1,
      phase: "RUNNING",
      feedId: "wrong"
    });
    expect(worker.status()).toMatchObject({ phase: "FAILED", checkpointValid: false });
    expect(() => worker.initializeAuthorized()).toThrow(SolPriceBootstrapCheckpointError);
    await expect(worker.runOnce()).rejects.toThrow(SolPriceBootstrapCheckpointError);
    expect(provider.calls).toEqual([]);
  });

  it("commits the insert and cursor atomically when SQLite faults", () => {
    const { repository, worker } = setup();
    worker.initializeAuthorized();
    const checkpoint = repository.getSolPriceBootstrapCheckpoint()!;
    const capturedAt = new Date(checkpoint.nextTimestampSeconds * 1_000).toISOString();
    const advanced: SolPriceBootstrapCheckpoint = {
      ...checkpoint,
      nextTimestampSeconds: checkpoint.nextTimestampSeconds + SOL_PRICE_BOOTSTRAP_INTERVAL_SECONDS,
      completedPoints: 1,
      updatedAt: NOW_ISO
    };
    db!.exec(`
      CREATE TRIGGER fail_pyth_cursor_update
      BEFORE UPDATE ON settings
      WHEN NEW.key = '${SOL_PRICE_BOOTSTRAP_SETTING}'
      BEGIN SELECT RAISE(ABORT, 'simulated cursor crash'); END;
    `);

    expect(() => repository.commitSolPriceBootstrapPoint({ capturedAt, priceUsd: 78.5 }, advanced)).toThrow(
      "simulated cursor crash"
    );
    expect(repository.getSolPriceSnapshotAt(capturedAt)).toBeUndefined();
    expect(repository.getSolPriceBootstrapCheckpoint()).toEqual(checkpoint);
  });

  it("marks the active generation complete at the final frozen point", async () => {
    const { repository, provider, worker } = setup();
    worker.initializeAuthorized();
    const checkpoint = repository.getSolPriceBootstrapCheckpoint()!;
    repository.saveSolPriceBootstrapCheckpoint({
      ...checkpoint,
      nextTimestampSeconds: checkpoint.windowEndSeconds,
      completedPoints: checkpoint.totalPoints - 1,
      insertedSnapshots: checkpoint.totalPoints - 1,
      preservedSnapshots: 0
    });

    await expect(worker.runOnce()).resolves.toBe(true);
    expect(worker.status()).toMatchObject({
      phase: "COMPLETE",
      completedPoints: SOL_PRICE_BOOTSTRAP_TOTAL_POINTS,
      remainingPoints: 0,
      progressPercent: 100,
      windowLagSeconds: 0,
      refreshAvailable: false
    });
    const calls = provider.calls.length;
    worker.initializeAuthorized();
    await expect(worker.runOnce()).resolves.toBe(false);
    expect(provider.calls).toHaveLength(calls);
  });

  it("keeps a stale complete generation dormant until an explicit rolling refresh", async () => {
    let now = new Date(NOW_ISO);
    const provider = new FakePythProvider(true);
    const { repository, worker } = setup(provider, { now: () => now });
    worker.initializeAuthorized();
    const completed = repository.getSolPriceBootstrapCheckpoint()!;
    repository.saveSolPriceBootstrapCheckpoint({
      ...completed,
      phase: "COMPLETE",
      nextTimestampSeconds: completed.windowEndSeconds + SOL_PRICE_BOOTSTRAP_INTERVAL_SECONDS,
      completedPoints: completed.totalPoints,
      insertedSnapshots: completed.totalPoints,
      preservedSnapshots: 0,
      completedAt: NOW_ISO
    });

    now = new Date(now.getTime() + SOL_PRICE_BOOTSTRAP_REFRESH_LAG_SECONDS * 1_000);
    expect(worker.status()).toMatchObject({
      phase: "COMPLETE",
      activeInProcess: false,
      windowLagSeconds: SOL_PRICE_BOOTSTRAP_REFRESH_LAG_SECONDS,
      refreshAvailable: true
    });
    expect(worker.resumePersistedActive()).toMatchObject({ phase: "COMPLETE", activeInProcess: false });
    expect(provider.calls).toEqual([]);

    const refreshed = worker.initializeAuthorized();
    expect(refreshed).toMatchObject({
      phase: "RUNNING",
      activeInProcess: false,
      completedPoints: 0,
      insertedSnapshots: 0,
      preservedSnapshots: 0,
      windowLagSeconds: 0,
      refreshAvailable: false
    });
    const next = repository.getSolPriceBootstrapCheckpoint()!;
    expect(next.windowEndSeconds).toBe(completed.windowEndSeconds + SOL_PRICE_BOOTSTRAP_REFRESH_LAG_SECONDS);
    expect(next.windowEndSeconds - next.windowStartSeconds).toBe(90 * 24 * 60 * 60);
    expect(provider.calls).toEqual([]);
    expect(repository.listAudit(20)).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventType: "sol_price_bootstrap_refresh_started" })
    ]));
  });

  it("refreshes insert-only and leaves an existing current-generation timestamp untouched", async () => {
    let now = new Date(NOW_ISO);
    const provider = new FakePythProvider(true);
    const { repository, worker } = setup(provider, { now: () => now });
    worker.initializeAuthorized();
    const completed = repository.getSolPriceBootstrapCheckpoint()!;
    repository.saveSolPriceBootstrapCheckpoint({
      ...completed,
      phase: "COMPLETE",
      nextTimestampSeconds: completed.windowEndSeconds + SOL_PRICE_BOOTSTRAP_INTERVAL_SECONDS,
      completedPoints: completed.totalPoints,
      insertedSnapshots: completed.totalPoints,
      preservedSnapshots: 0,
      completedAt: NOW_ISO
    });
    now = new Date(now.getTime() + SOL_PRICE_BOOTSTRAP_REFRESH_LAG_SECONDS * 1_000);
    worker.initializeAuthorized();
    const current = repository.getSolPriceBootstrapCheckpoint()!;
    const capturedAt = new Date(current.windowStartSeconds * 1_000).toISOString();
    repository.saveSolPriceSnapshot({ capturedAt, priceUsd: 123.45, source: "jupiter_quote" });

    await worker.runOnce();

    expect(repository.getSolPriceSnapshotAt(capturedAt)).toEqual({
      capturedAt,
      priceUsd: 123.45,
      source: "jupiter_quote"
    });
    expect(worker.status()).toMatchObject({ completedPoints: 1, insertedSnapshots: 0, preservedSnapshots: 1 });
    expect(provider.calls).toEqual([current.windowStartSeconds]);
  });
});
