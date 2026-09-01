import {
  BIRDEYE_SOL_USD_HISTORY_SOURCE,
  BirdeyeSolUsdHistoryRequestError,
  BirdeyeSolUsdHistoryValidationError,
  PYTH_SOL_USD_FEED_ID,
  PYTH_SOL_USD_HISTORY_SOURCE,
  PythBenchmarksRequestError,
  PythBenchmarksValidationError,
  type PythBenchmarksSolUsdPrice,
  type SolUsdHistoricalPrice,
  type SolUsdHistoricalPriceProvider
} from "@copylab/providers";
import type { Repository } from "./repository.js";
import {
  SOL_PRICE_BOOTSTRAP_HORIZON_DAYS,
  SOL_PRICE_BOOTSTRAP_INTERVAL_SECONDS,
  SOL_PRICE_BOOTSTRAP_REFRESH_LAG_SECONDS,
  SOL_PRICE_BOOTSTRAP_TOTAL_POINTS,
  type SolPriceBootstrapCheckpoint,
  type SolPriceBootstrapPhase,
  type SolPriceBootstrapStatus
} from "./sol-price-bootstrap-state.js";

const DEFAULT_MAXIMUM_ATTEMPTS = 12;
const DEFAULT_RETRY_BASE_MS = 30_000;
const DEFAULT_MAXIMUM_RETRY_DELAY_MS = 60 * 60_000;
const PUBLISH_AVAILABILITY_LAG_SECONDS = 60;
const MAXIMUM_PUBLISH_DISTANCE_SECONDS = 60;
const MAXIMUM_CONFIDENCE_RATIO = 0.05;
const PHASES = new Set<SolPriceBootstrapPhase>([
  "RUNNING",
  "RETRY_WAIT",
  "PAUSED",
  "COMPLETE",
  "FAILED"
]);

export interface SolPriceBootstrapWorkerOptions {
  maximumAttempts?: number;
  retryBaseMs?: number;
  maximumRetryDelayMs?: number;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
  onProgress?: (status: SolPriceBootstrapStatus) => void;
}

export class SolPriceBootstrapCheckpointError extends Error {
  constructor() {
    super("The durable SOL/USD history bootstrap checkpoint is invalid.");
    this.name = "SolPriceBootstrapCheckpointError";
  }
}

function iso(date: Date): string {
  if (!Number.isFinite(date.getTime())) throw new Error("SOL price bootstrap clock returned an invalid time.");
  return date.toISOString();
}

function currentWindowEndSeconds(at: Date): number {
  return Math.floor(
    (Math.floor(at.getTime() / 1_000) - PUBLISH_AVAILABILITY_LAG_SECONDS)
    / SOL_PRICE_BOOTSTRAP_INTERVAL_SECONDS
  ) * SOL_PRICE_BOOTSTRAP_INTERVAL_SECONDS;
}

function newCheckpoint(at: Date): SolPriceBootstrapCheckpoint {
  const atIso = iso(at);
  const windowEndSeconds = currentWindowEndSeconds(at);
  const windowStartSeconds = windowEndSeconds - SOL_PRICE_BOOTSTRAP_HORIZON_DAYS * 24 * 60 * 60;
  if (windowStartSeconds <= 0) throw new Error("SOL price bootstrap window is outside valid Unix time.");
  return {
    version: 1,
    phase: "RUNNING",
    feedId: PYTH_SOL_USD_FEED_ID,
    intervalSeconds: SOL_PRICE_BOOTSTRAP_INTERVAL_SECONDS,
    horizonDays: SOL_PRICE_BOOTSTRAP_HORIZON_DAYS,
    windowStartSeconds,
    windowEndSeconds,
    nextTimestampSeconds: windowStartSeconds,
    totalPoints: SOL_PRICE_BOOTSTRAP_TOTAL_POINTS,
    completedPoints: 0,
    insertedSnapshots: 0,
    preservedSnapshots: 0,
    cursorAttempts: 0,
    startedAt: atIso,
    updatedAt: atIso
  };
}

function validIso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validCounter(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function assertCheckpoint(checkpoint: SolPriceBootstrapCheckpoint): SolPriceBootstrapCheckpoint {
  if (
    checkpoint === null
    || typeof checkpoint !== "object"
    || checkpoint.version !== 1
    || !PHASES.has(checkpoint.phase)
    || checkpoint.feedId !== PYTH_SOL_USD_FEED_ID
    || checkpoint.intervalSeconds !== SOL_PRICE_BOOTSTRAP_INTERVAL_SECONDS
    || checkpoint.horizonDays !== SOL_PRICE_BOOTSTRAP_HORIZON_DAYS
    || checkpoint.totalPoints !== SOL_PRICE_BOOTSTRAP_TOTAL_POINTS
    || !validCounter(checkpoint.windowStartSeconds)
    || !validCounter(checkpoint.windowEndSeconds)
    || !validCounter(checkpoint.nextTimestampSeconds)
    || checkpoint.windowStartSeconds % SOL_PRICE_BOOTSTRAP_INTERVAL_SECONDS !== 0
    || checkpoint.windowEndSeconds % SOL_PRICE_BOOTSTRAP_INTERVAL_SECONDS !== 0
    || checkpoint.nextTimestampSeconds % SOL_PRICE_BOOTSTRAP_INTERVAL_SECONDS !== 0
    || checkpoint.windowEndSeconds - checkpoint.windowStartSeconds
      !== SOL_PRICE_BOOTSTRAP_HORIZON_DAYS * 24 * 60 * 60
    || checkpoint.nextTimestampSeconds < checkpoint.windowStartSeconds
    || checkpoint.nextTimestampSeconds > checkpoint.windowEndSeconds + SOL_PRICE_BOOTSTRAP_INTERVAL_SECONDS
    || !validCounter(checkpoint.completedPoints)
    || !validCounter(checkpoint.insertedSnapshots)
    || !validCounter(checkpoint.preservedSnapshots)
    || !validCounter(checkpoint.cursorAttempts)
    || checkpoint.completedPoints > checkpoint.totalPoints
    || checkpoint.insertedSnapshots + checkpoint.preservedSnapshots !== checkpoint.completedPoints
    || checkpoint.completedPoints
      !== (checkpoint.nextTimestampSeconds - checkpoint.windowStartSeconds) / SOL_PRICE_BOOTSTRAP_INTERVAL_SECONDS
    || !validIso(checkpoint.startedAt)
    || !validIso(checkpoint.updatedAt)
    || (checkpoint.nextRetryAt !== undefined && !validIso(checkpoint.nextRetryAt))
    || (checkpoint.completedAt !== undefined && !validIso(checkpoint.completedAt))
    || (checkpoint.lastError !== undefined && (typeof checkpoint.lastError !== "string" || checkpoint.lastError.length > 500))
    || (checkpoint.phase === "COMPLETE" && checkpoint.completedPoints !== checkpoint.totalPoints)
    || (checkpoint.phase !== "COMPLETE" && checkpoint.completedPoints === checkpoint.totalPoints)
  ) {
    throw new SolPriceBootstrapCheckpointError();
  }
  return checkpoint;
}

function loadCheckpoint(repository: Repository): SolPriceBootstrapCheckpoint | undefined {
  try {
    const stored = repository.getSolPriceBootstrapCheckpoint();
    return stored ? assertCheckpoint(stored) : undefined;
  } catch {
    throw new SolPriceBootstrapCheckpointError();
  }
}

function coreCheckpoint(
  checkpoint: SolPriceBootstrapCheckpoint
): Omit<SolPriceBootstrapCheckpoint, "phase" | "updatedAt" | "nextRetryAt" | "completedAt" | "lastError"> {
  return {
    version: checkpoint.version,
    feedId: checkpoint.feedId,
    intervalSeconds: checkpoint.intervalSeconds,
    horizonDays: checkpoint.horizonDays,
    windowStartSeconds: checkpoint.windowStartSeconds,
    windowEndSeconds: checkpoint.windowEndSeconds,
    nextTimestampSeconds: checkpoint.nextTimestampSeconds,
    totalPoints: checkpoint.totalPoints,
    completedPoints: checkpoint.completedPoints,
    insertedSnapshots: checkpoint.insertedSnapshots,
    preservedSnapshots: checkpoint.preservedSnapshots,
    cursorAttempts: checkpoint.cursorAttempts,
    startedAt: checkpoint.startedAt
  };
}

function sanitizedProviderFailure(error: unknown): {
  retryable: boolean;
  message: string;
} {
  if (error instanceof PythBenchmarksRequestError) {
    return {
      retryable: error.retryable,
      message: error.retryable
        ? `Pyth Benchmarks is temporarily unavailable${error.status === undefined ? "" : ` (HTTP ${error.status})`}.`
        : `Pyth Benchmarks rejected the request${error.status === undefined ? "" : ` (HTTP ${error.status})`}.`
    };
  }
  if (error instanceof PythBenchmarksValidationError) {
    return {
      retryable: false,
      message: `Pyth Benchmarks response failed strict validation (${error.code}).`
    };
  }
  if (error instanceof BirdeyeSolUsdHistoryRequestError) {
    return {
      retryable: error.retryable,
      message: error.retryable
        ? `Birdeye SOL/USD history is temporarily unavailable${error.status === undefined ? "" : ` (HTTP ${error.status})`}.`
        : `Birdeye SOL/USD history rejected the request${error.status === undefined ? "" : ` (HTTP ${error.status})`}.`
    };
  }
  if (error instanceof BirdeyeSolUsdHistoryValidationError) {
    return {
      retryable: false,
      message: `Birdeye SOL/USD history response failed strict validation (${error.code}).`
    };
  }
  return {
    retryable: false,
    message: "SOL/USD history bootstrap failed closed on an unexpected provider result."
  };
}

function assertPrice(price: SolUsdHistoricalPrice, timestampSeconds: number): void {
  if (
    (price.source !== PYTH_SOL_USD_HISTORY_SOURCE && price.source !== BIRDEYE_SOL_USD_HISTORY_SOURCE)
    || price.requestedTimestampSeconds !== timestampSeconds
    || !Number.isSafeInteger(price.observationTimestampSeconds)
    || Math.abs(price.observationTimestampSeconds - timestampSeconds) > MAXIMUM_PUBLISH_DISTANCE_SECONDS
    || !Number.isFinite(price.priceUsd)
    || price.priceUsd <= 0
  ) {
    throw new PythBenchmarksValidationError("PRICE_SHAPE");
  }
  if (price.source === BIRDEYE_SOL_USD_HISTORY_SOURCE) {
    if (price.observationTimestampSeconds !== timestampSeconds) {
      throw new BirdeyeSolUsdHistoryValidationError("CANDLE_TIME");
    }
    return;
  }
  const pyth = price as PythBenchmarksSolUsdPrice;
  if (
    pyth.feedId !== PYTH_SOL_USD_FEED_ID
    || !Number.isSafeInteger(pyth.publishTimeSeconds)
    || Math.abs(pyth.publishTimeSeconds - timestampSeconds) > MAXIMUM_PUBLISH_DISTANCE_SECONDS
    || !/^[1-9]\d*$/.test(pyth.priceMantissa)
    || !/^\d+$/.test(pyth.confidenceMantissa)
    || !Number.isSafeInteger(pyth.exponent)
    || pyth.exponent < -18
    || pyth.exponent > 18
    || !Number.isFinite(pyth.confidenceUsd)
    || pyth.confidenceUsd < 0
    || !Number.isFinite(pyth.confidenceRatio)
    || pyth.confidenceRatio < 0
    || pyth.confidenceRatio > MAXIMUM_CONFIDENCE_RATIO
  ) throw new PythBenchmarksValidationError("PRICE_SHAPE");
}

export class SolPriceBootstrapWorker {
  private readonly maximumAttempts: number;
  private readonly retryBaseMs: number;
  private readonly maximumRetryDelayMs: number;
  private readonly now: () => Date;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly onProgress: (status: SolPriceBootstrapStatus) => void;
  private stopRequested = false;
  private loopPromise: Promise<void> | undefined;

  constructor(
    private readonly repository: Repository,
    private readonly provider: SolUsdHistoricalPriceProvider,
    options: SolPriceBootstrapWorkerOptions = {}
  ) {
    this.maximumAttempts = options.maximumAttempts ?? DEFAULT_MAXIMUM_ATTEMPTS;
    if (!Number.isSafeInteger(this.maximumAttempts) || this.maximumAttempts < 1 || this.maximumAttempts > 100) {
      throw new RangeError("SOL price bootstrap maximumAttempts must be an integer from 1 to 100.");
    }
    this.retryBaseMs = options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
    this.maximumRetryDelayMs = options.maximumRetryDelayMs ?? DEFAULT_MAXIMUM_RETRY_DELAY_MS;
    if (!Number.isFinite(this.retryBaseMs) || this.retryBaseMs < 0) {
      throw new RangeError("SOL price bootstrap retryBaseMs must be non-negative.");
    }
    if (!Number.isFinite(this.maximumRetryDelayMs) || this.maximumRetryDelayMs < this.retryBaseMs) {
      throw new RangeError("SOL price bootstrap maximumRetryDelayMs must be at least retryBaseMs.");
    }
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? ((milliseconds) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
    this.onProgress = options.onProgress ?? (() => undefined);
  }

  status(): SolPriceBootstrapStatus {
    const currentEndSeconds = currentWindowEndSeconds(this.now());
    const currentWindowEndAt = new Date(currentEndSeconds * 1_000).toISOString();
    let checkpoint: SolPriceBootstrapCheckpoint | undefined;
    try {
      checkpoint = loadCheckpoint(this.repository);
    } catch {
      return {
        phase: "FAILED",
        activeInProcess: Boolean(this.loopPromise),
        authenticationConfigured: this.provider.authenticationConfigured,
        ...(this.provider.pythAuthenticationConfigured === undefined
          ? {}
          : { pythAuthenticationConfigured: this.provider.pythAuthenticationConfigured }),
        ...(this.provider.fallbackConfigured === undefined
          ? {}
          : { managedFallbackConfigured: this.provider.fallbackConfigured }),
        ...(this.provider.activeSource ? { activeSource: this.provider.activeSource } : {}),
        checkpointValid: false,
        feedId: PYTH_SOL_USD_FEED_ID,
        intervalSeconds: SOL_PRICE_BOOTSTRAP_INTERVAL_SECONDS,
        horizonDays: SOL_PRICE_BOOTSTRAP_HORIZON_DAYS,
        totalPoints: SOL_PRICE_BOOTSTRAP_TOTAL_POINTS,
        completedPoints: 0,
        remainingPoints: SOL_PRICE_BOOTSTRAP_TOTAL_POINTS,
        insertedSnapshots: 0,
        preservedSnapshots: 0,
        progressPercent: 0,
        cursorAttempts: 0,
        currentWindowEndAt,
        windowLagSeconds: 0,
        refreshAvailable: false,
        lastError: "The durable bootstrap checkpoint is invalid; no provider requests will run."
      };
    }
    if (!checkpoint) {
      return {
        phase: "IDLE",
        activeInProcess: Boolean(this.loopPromise),
        authenticationConfigured: this.provider.authenticationConfigured,
        ...(this.provider.pythAuthenticationConfigured === undefined
          ? {}
          : { pythAuthenticationConfigured: this.provider.pythAuthenticationConfigured }),
        ...(this.provider.fallbackConfigured === undefined
          ? {}
          : { managedFallbackConfigured: this.provider.fallbackConfigured }),
        ...(this.provider.activeSource ? { activeSource: this.provider.activeSource } : {}),
        checkpointValid: true,
        feedId: PYTH_SOL_USD_FEED_ID,
        intervalSeconds: SOL_PRICE_BOOTSTRAP_INTERVAL_SECONDS,
        horizonDays: SOL_PRICE_BOOTSTRAP_HORIZON_DAYS,
        totalPoints: SOL_PRICE_BOOTSTRAP_TOTAL_POINTS,
        completedPoints: 0,
        remainingPoints: SOL_PRICE_BOOTSTRAP_TOTAL_POINTS,
        insertedSnapshots: 0,
        preservedSnapshots: 0,
        progressPercent: 0,
        cursorAttempts: 0,
        currentWindowEndAt,
        windowLagSeconds: 0,
        refreshAvailable: false
      };
    }
    const windowLagSeconds = Math.max(0, currentEndSeconds - checkpoint.windowEndSeconds);
    return {
      phase: checkpoint.phase,
      activeInProcess: Boolean(this.loopPromise),
      authenticationConfigured: this.provider.authenticationConfigured,
      ...(this.provider.pythAuthenticationConfigured === undefined
        ? {}
        : { pythAuthenticationConfigured: this.provider.pythAuthenticationConfigured }),
      ...(this.provider.fallbackConfigured === undefined
        ? {}
        : { managedFallbackConfigured: this.provider.fallbackConfigured }),
      ...(this.provider.activeSource ? { activeSource: this.provider.activeSource } : {}),
      checkpointValid: true,
      feedId: checkpoint.feedId,
      intervalSeconds: checkpoint.intervalSeconds,
      horizonDays: checkpoint.horizonDays,
      totalPoints: checkpoint.totalPoints,
      completedPoints: checkpoint.completedPoints,
      remainingPoints: checkpoint.totalPoints - checkpoint.completedPoints,
      insertedSnapshots: checkpoint.insertedSnapshots,
      preservedSnapshots: checkpoint.preservedSnapshots,
      progressPercent: checkpoint.totalPoints === 0
        ? 0
        : checkpoint.completedPoints / checkpoint.totalPoints * 100,
      cursorAttempts: checkpoint.cursorAttempts,
      windowStartAt: new Date(checkpoint.windowStartSeconds * 1_000).toISOString(),
      windowEndAt: new Date(checkpoint.windowEndSeconds * 1_000).toISOString(),
      currentWindowEndAt,
      windowLagSeconds,
      refreshAvailable: checkpoint.phase === "COMPLETE"
        && windowLagSeconds >= SOL_PRICE_BOOTSTRAP_REFRESH_LAG_SECONDS,
      ...(checkpoint.nextTimestampSeconds <= checkpoint.windowEndSeconds
        ? { nextTimestampAt: new Date(checkpoint.nextTimestampSeconds * 1_000).toISOString() }
        : {}),
      startedAt: checkpoint.startedAt,
      updatedAt: checkpoint.updatedAt,
      ...(checkpoint.nextRetryAt ? { nextRetryAt: checkpoint.nextRetryAt } : {}),
      ...(checkpoint.completedAt ? { completedAt: checkpoint.completedAt } : {}),
      ...(checkpoint.lastError ? { lastError: checkpoint.lastError } : {})
    };
  }

  /** Initializes or explicitly resumes the durable cursor without starting background I/O. */
  initializeAuthorized(): SolPriceBootstrapStatus {
    const at = this.now();
    const atIso = iso(at);
    const checkpoint = loadCheckpoint(this.repository);
    if (checkpoint) {
      if (checkpoint.phase === "COMPLETE") {
        const currentEndSeconds = currentWindowEndSeconds(at);
        const windowLagSeconds = Math.max(0, currentEndSeconds - checkpoint.windowEndSeconds);
        if (windowLagSeconds < SOL_PRICE_BOOTSTRAP_REFRESH_LAG_SECONDS) return this.status();
        const refreshed = newCheckpoint(at);
        this.repository.saveSolPriceBootstrapCheckpoint(refreshed);
        this.repository.audit(
          "sol_price_bootstrap_refresh_started",
          "A newer rolling 90-day SOL/USD history generation was explicitly authorized; existing timestamps remain insert-only.",
          {
            priorWindowEndAt: new Date(checkpoint.windowEndSeconds * 1_000).toISOString(),
            windowLagSeconds,
            intervalSeconds: refreshed.intervalSeconds,
            totalPoints: refreshed.totalPoints,
            windowStartAt: new Date(refreshed.windowStartSeconds * 1_000).toISOString(),
            windowEndAt: new Date(refreshed.windowEndSeconds * 1_000).toISOString()
          }
        );
        return this.status();
      }
      const retryStillPending = checkpoint.phase === "RETRY_WAIT"
        && checkpoint.nextRetryAt !== undefined
        && Date.parse(checkpoint.nextRetryAt) > at.getTime();
      const resumed: SolPriceBootstrapCheckpoint = {
        ...coreCheckpoint(checkpoint),
        phase: retryStillPending ? "RETRY_WAIT" : "RUNNING",
        cursorAttempts: checkpoint.phase === "FAILED" ? 0 : checkpoint.cursorAttempts,
        updatedAt: atIso,
        ...(retryStillPending ? { nextRetryAt: checkpoint.nextRetryAt } : {})
      };
      this.repository.saveSolPriceBootstrapCheckpoint(resumed);
      this.repository.audit(
        "sol_price_bootstrap_resumed",
        "The optional SOL/USD history bootstrap was explicitly resumed from its durable cursor.",
        { completedPoints: resumed.completedPoints, totalPoints: resumed.totalPoints }
      );
      return this.status();
    }
    const createdCheckpoint = newCheckpoint(at);
    this.repository.saveSolPriceBootstrapCheckpoint(createdCheckpoint);
    this.repository.audit(
      "sol_price_bootstrap_started",
      "The optional 90-day SOL/USD history bootstrap was explicitly authorized.",
      {
        intervalSeconds: createdCheckpoint.intervalSeconds,
        totalPoints: createdCheckpoint.totalPoints,
        windowStartAt: new Date(createdCheckpoint.windowStartSeconds * 1_000).toISOString(),
        windowEndAt: new Date(createdCheckpoint.windowEndSeconds * 1_000).toISOString()
      }
    );
    return this.status();
  }

  startAuthorized(): SolPriceBootstrapStatus {
    this.initializeAuthorized();
    return this.startActiveLoop();
  }

  /**
   * Restarts only a cursor whose durable state proves that an operator had
   * already authorized active work. IDLE, PAUSED, FAILED, COMPLETE, and
   * invalid checkpoints remain dormant and cannot issue provider requests.
   */
  resumePersistedActive(): SolPriceBootstrapStatus {
    const status = this.status();
    if (
      this.loopPromise
      || !status.checkpointValid
      || (status.phase !== "RUNNING" && status.phase !== "RETRY_WAIT")
    ) {
      return status;
    }
    this.repository.audit(
      "sol_price_bootstrap_auto_resumed",
      "The previously authorized SOL/USD history bootstrap resumed automatically from its durable cursor.",
      { completedPoints: status.completedPoints, totalPoints: status.totalPoints, phase: status.phase }
    );
    return this.startActiveLoop();
  }

  /** Stops in-process work for shutdown without converting active intent into an operator pause. */
  async stopPreservingAuthorization(): Promise<SolPriceBootstrapStatus> {
    this.stopRequested = true;
    await this.loopPromise;
    return this.status();
  }

  private startActiveLoop(): SolPriceBootstrapStatus {
    const status = this.status();
    if (
      this.loopPromise
      || !status.checkpointValid
      || (status.phase !== "RUNNING" && status.phase !== "RETRY_WAIT")
    ) {
      return status;
    }
    this.stopRequested = false;
    const task = this.loop().catch(() => {
      this.repository.audit(
        "sol_price_bootstrap_worker_failed",
        "The optional SOL/USD history bootstrap worker stopped fail-closed.",
        undefined,
        "warning"
      );
    });
    this.loopPromise = task;
    void task.finally(() => {
      if (this.loopPromise === task) this.loopPromise = undefined;
    });
    return this.status();
  }

  async pause(): Promise<SolPriceBootstrapStatus> {
    await this.stopPreservingAuthorization();
    const checkpoint = loadCheckpoint(this.repository);
    if (checkpoint) {
      if (checkpoint.phase === "RUNNING" || checkpoint.phase === "RETRY_WAIT") {
        const paused: SolPriceBootstrapCheckpoint = {
          ...coreCheckpoint(checkpoint),
          phase: "PAUSED",
          updatedAt: iso(this.now()),
          ...(checkpoint.nextRetryAt ? { nextRetryAt: checkpoint.nextRetryAt } : {}),
          ...(checkpoint.lastError ? { lastError: checkpoint.lastError } : {})
        };
        this.repository.saveSolPriceBootstrapCheckpoint(paused);
        this.repository.audit(
          "sol_price_bootstrap_paused",
          "The optional SOL/USD history bootstrap was paused at its durable cursor.",
          { completedPoints: paused.completedPoints, totalPoints: paused.totalPoints }
        );
      }
    }
    return this.status();
  }

  async runOnce(): Promise<boolean> {
    const checkpoint = loadCheckpoint(this.repository);
    if (!checkpoint) return false;
    if (checkpoint.phase === "PAUSED" || checkpoint.phase === "COMPLETE" || checkpoint.phase === "FAILED") {
      return false;
    }
    const now = this.now();
    if (
      checkpoint.phase === "RETRY_WAIT"
      && checkpoint.nextRetryAt
      && Date.parse(checkpoint.nextRetryAt) > now.getTime()
    ) {
      return false;
    }
    const target = checkpoint.nextTimestampSeconds;
    try {
      const price = await this.provider.getSolUsdPrice(target);
      assertPrice(price, target);
      const nextTimestampSeconds = target + SOL_PRICE_BOOTSTRAP_INTERVAL_SECONDS;
      const completedPoints = checkpoint.completedPoints + 1;
      const complete = completedPoints === checkpoint.totalPoints;
      const advanced: SolPriceBootstrapCheckpoint = {
        ...coreCheckpoint(checkpoint),
        phase: complete ? "COMPLETE" : "RUNNING",
        nextTimestampSeconds,
        completedPoints,
        cursorAttempts: 0,
        updatedAt: iso(this.now()),
        ...(complete ? { completedAt: iso(this.now()) } : {})
      };
      const committed = this.repository.commitSolPriceBootstrapPoint({
        capturedAt: new Date(target * 1_000).toISOString(),
        priceUsd: price.priceUsd,
        source: price.source
      }, advanced);
      if (complete) {
        this.repository.audit(
          "sol_price_bootstrap_complete",
          "The active 90-day SOL/USD history generation completed without replacing existing timestamps.",
          {
            insertedSnapshots: committed.checkpoint.insertedSnapshots,
            preservedSnapshots: committed.checkpoint.preservedSnapshots,
            totalPoints: committed.checkpoint.totalPoints
          }
        );
      }
      const progressInterval = price.source === BIRDEYE_SOL_USD_HISTORY_SOURCE ? 250 : 10;
      if (complete || committed.checkpoint.completedPoints % progressInterval === 0) {
        this.onProgress(this.status());
      }
      return true;
    } catch (error) {
      this.recordFailure(checkpoint, error, now);
      return true;
    }
  }

  private recordFailure(checkpoint: SolPriceBootstrapCheckpoint, error: unknown, now: Date): void {
    const failure = sanitizedProviderFailure(error);
    const attempts = checkpoint.cursorAttempts + 1;
    const exhausted = !failure.retryable || attempts >= this.maximumAttempts;
    const updatedAt = iso(now);
    const nextRetryAt = exhausted
      ? undefined
      : new Date(now.getTime() + Math.min(
          this.maximumRetryDelayMs,
          this.retryBaseMs * 2 ** Math.min(20, attempts - 1)
        )).toISOString();
    const failed: SolPriceBootstrapCheckpoint = {
      ...coreCheckpoint(checkpoint),
      phase: exhausted ? "FAILED" : "RETRY_WAIT",
      cursorAttempts: attempts,
      updatedAt,
      lastError: failure.message,
      ...(nextRetryAt ? { nextRetryAt } : {})
    };
    this.repository.saveSolPriceBootstrapCheckpoint(failed);
    this.onProgress(this.status());
    if (exhausted) {
      this.repository.audit(
        "sol_price_bootstrap_failed",
        failure.message,
        {
          attempts,
          completedPoints: failed.completedPoints,
          totalPoints: failed.totalPoints
        },
        "warning"
      );
    }
  }

  private async loop(): Promise<void> {
    while (!this.stopRequested) {
      const status = this.status();
      if (!status.checkpointValid || status.phase === "COMPLETE" || status.phase === "FAILED" || status.phase === "PAUSED") {
        return;
      }
      const changed = await this.runOnce();
      if (!changed) await this.sleep(1_000);
    }
  }
}
