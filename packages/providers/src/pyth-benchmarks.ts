import {
  asRecord,
  ProviderApiError,
  requestJson,
  stringValue,
  type FetchLike
} from "./http.js";
import {
  PYTH_SOL_USD_HISTORY_SOURCE,
  type SolUsdHistoricalPrice,
  type SolUsdHistoricalPriceProvider
} from "./sol-usd-history.js";

export const PYTH_BENCHMARKS_BASE_URL = "https://benchmarks.pyth.network";
export const PYTH_SOL_USD_FEED_ID = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

const DEFAULT_REQUESTS_PER_SECOND = 1;
const DEFAULT_MAXIMUM_PUBLISH_DISTANCE_SECONDS = 60;
const DEFAULT_MAXIMUM_CONFIDENCE_RATIO = 0.05;
const MINIMUM_EXPONENT = -18;
const MAXIMUM_EXPONENT = 18;

export interface PythBenchmarksUsage {
  requests: 1;
}

export interface PythBenchmarksClientOptions {
  /** Pyth documents bearer authentication as mandatory from August 26, 2026 at 16:00 UTC. */
  apiKey?: string;
  baseUrl?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  /** The production client deliberately cannot be configured above one request per second. */
  requestsPerSecond?: number;
  maximumPublishDistanceSeconds?: number;
  maximumConfidenceRatio?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  onRequest?: (usage: PythBenchmarksUsage) => void;
}

export interface PythBenchmarksSolUsdPrice extends SolUsdHistoricalPrice {
  source: typeof PYTH_SOL_USD_HISTORY_SOURCE;
  feedId: typeof PYTH_SOL_USD_FEED_ID;
  requestedTimestampSeconds: number;
  observationTimestampSeconds: number;
  publishTimeSeconds: number;
  priceMantissa: string;
  confidenceMantissa: string;
  exponent: number;
  priceUsd: number;
  confidenceUsd: number;
  confidenceRatio: number;
}

export interface PythBenchmarksPriceProvider extends SolUsdHistoricalPriceProvider {
  readonly authenticationConfigured: boolean;
  readonly pythAuthenticationConfigured: boolean;
  readonly fallbackConfigured: false;
  readonly activeSource: typeof PYTH_SOL_USD_HISTORY_SOURCE;
  getSolUsdPrice(timestampSeconds: number): Promise<PythBenchmarksSolUsdPrice>;
}

export class PythBenchmarksRequestError extends Error {
  constructor(
    readonly status: number | undefined,
    readonly retryable: boolean
  ) {
    super(`Pyth Benchmarks request failed${status === undefined ? "" : ` (HTTP ${status})`}.`);
    this.name = "PythBenchmarksRequestError";
  }
}

export type PythBenchmarksValidationCode =
  | "PARSED_SHAPE"
  | "FEED_ID"
  | "PRICE_SHAPE"
  | "MANTISSA"
  | "EXPONENT"
  | "PUBLISH_TIME"
  | "CONFIDENCE";

export class PythBenchmarksValidationError extends Error {
  constructor(readonly code: PythBenchmarksValidationCode) {
    super(`Pyth Benchmarks response validation failed (${code}).`);
    this.name = "PythBenchmarksValidationError";
  }
}

class RequestIntervalQueue {
  private tail: Promise<void> = Promise.resolve();
  private lastStartedAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly minimumIntervalMs: number,
    private readonly now: () => number,
    private readonly sleep: (milliseconds: number) => Promise<void>
  ) {}

  schedule<T>(operation: () => Promise<T>): Promise<T> {
    const start = this.tail.then(async () => {
      const remaining = this.minimumIntervalMs - (this.now() - this.lastStartedAt);
      if (remaining > 0) await this.sleep(remaining);
      this.lastStartedAt = this.now();
    });
    this.tail = start.then(
      () => undefined,
      () => undefined
    );
    return start.then(operation);
  }
}

function normalizeBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Pyth Benchmarks baseUrl must be an absolute HTTPS URL.");
  }
  if (url.protocol !== "https:") throw new Error("Pyth Benchmarks baseUrl must use HTTPS.");
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Pyth Benchmarks baseUrl cannot contain credentials, a query, or a fragment.");
  }
  if (url.pathname !== "/") throw new Error("Pyth Benchmarks baseUrl must be an origin without a path.");
  return url.origin;
}

function normalizeApiKey(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const key = value.trim();
  if (!key || key.length > 4_096 || /[\r\n]/.test(key)) {
    throw new Error("Pyth Benchmarks apiKey must be a non-empty single-line value up to 4096 characters.");
  }
  return key;
}

function integerMantissa(value: unknown, code: "MANTISSA" | "CONFIDENCE"): bigint {
  if (typeof value !== "string" || !/^-?\d+$/.test(value)) {
    throw new PythBenchmarksValidationError(code);
  }
  const parsed = BigInt(value);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER) || parsed < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new PythBenchmarksValidationError(code);
  }
  return parsed;
}

function normalizedFeedId(value: unknown): string | undefined {
  const id = stringValue(value)?.toLowerCase().replace(/^0x/, "");
  return id && /^[0-9a-f]{64}$/.test(id) ? id : undefined;
}

export class PythBenchmarksClient implements PythBenchmarksPriceProvider {
  readonly authenticationConfigured: boolean;
  readonly pythAuthenticationConfigured: boolean;
  readonly fallbackConfigured = false as const;
  readonly activeSource = PYTH_SOL_USD_HISTORY_SOURCE;
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly fetch: FetchLike | undefined;
  private readonly timeoutMs: number;
  private readonly maximumPublishDistanceSeconds: number;
  private readonly maximumConfidenceRatio: number;
  private readonly onRequest: (usage: PythBenchmarksUsage) => void;
  private readonly queue: RequestIntervalQueue;

  constructor(options: PythBenchmarksClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? PYTH_BENCHMARKS_BASE_URL);
    this.apiKey = normalizeApiKey(options.apiKey);
    this.authenticationConfigured = this.apiKey !== undefined;
    this.pythAuthenticationConfigured = this.authenticationConfigured;
    this.fetch = options.fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > 120_000) {
      throw new RangeError("Pyth Benchmarks timeoutMs must be between 0 and 120000 milliseconds.");
    }
    const requestsPerSecond = options.requestsPerSecond ?? DEFAULT_REQUESTS_PER_SECOND;
    if (!Number.isFinite(requestsPerSecond) || requestsPerSecond <= 0 || requestsPerSecond > 1) {
      throw new RangeError("Pyth Benchmarks requestsPerSecond must be greater than 0 and no more than 1.");
    }
    this.maximumPublishDistanceSeconds =
      options.maximumPublishDistanceSeconds ?? DEFAULT_MAXIMUM_PUBLISH_DISTANCE_SECONDS;
    if (
      !Number.isSafeInteger(this.maximumPublishDistanceSeconds)
      || this.maximumPublishDistanceSeconds < 0
      || this.maximumPublishDistanceSeconds > 600
    ) {
      throw new RangeError("Pyth Benchmarks maximumPublishDistanceSeconds must be an integer from 0 to 600.");
    }
    this.maximumConfidenceRatio = options.maximumConfidenceRatio ?? DEFAULT_MAXIMUM_CONFIDENCE_RATIO;
    if (
      !Number.isFinite(this.maximumConfidenceRatio)
      || this.maximumConfidenceRatio < 0
      || this.maximumConfidenceRatio > 1
    ) {
      throw new RangeError("Pyth Benchmarks maximumConfidenceRatio must be between 0 and 1.");
    }
    const now = options.now ?? Date.now;
    const sleep = options.sleep ?? ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
    this.queue = new RequestIntervalQueue(1_000 / requestsPerSecond, now, sleep);
    this.onRequest = options.onRequest ?? (() => undefined);
  }

  getSolUsdPrice(timestampSeconds: number): Promise<PythBenchmarksSolUsdPrice> {
    if (!Number.isSafeInteger(timestampSeconds) || timestampSeconds <= 0) {
      throw new RangeError("Pyth Benchmarks timestamp must be a positive Unix-seconds safe integer.");
    }
    return this.queue.schedule(async () => {
      const endpoint = new URL(`/v1/updates/price/${timestampSeconds}`, this.baseUrl);
      endpoint.searchParams.append("ids", PYTH_SOL_USD_FEED_ID);
      endpoint.searchParams.set("encoding", "base64");
      endpoint.searchParams.set("parsed", "true");
      const headers: Record<string, string> = { accept: "application/json" };
      if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
      this.onRequest({ requests: 1 });
      let response: unknown;
      try {
        response = await requestJson<unknown>(endpoint, { method: "GET", headers }, {
          fetch: this.fetch,
          timeoutMs: this.timeoutMs,
          provider: "pyth-benchmarks"
        });
      } catch (error) {
        if (error instanceof ProviderApiError) {
          throw new PythBenchmarksRequestError(error.status, error.retryable);
        }
        throw new PythBenchmarksRequestError(undefined, true);
      }
      return this.validate(response, timestampSeconds);
    });
  }

  private validate(response: unknown, requestedTimestampSeconds: number): PythBenchmarksSolUsdPrice {
    const root = asRecord(response);
    const rawParsed = root?.parsed;
    const parsed = Array.isArray(rawParsed)
      ? rawParsed.length === 1 ? asRecord(rawParsed[0]) : undefined
      : asRecord(rawParsed);
    if (!parsed) throw new PythBenchmarksValidationError("PARSED_SHAPE");
    if (normalizedFeedId(parsed.id) !== PYTH_SOL_USD_FEED_ID) {
      throw new PythBenchmarksValidationError("FEED_ID");
    }
    const price = asRecord(parsed.price);
    if (!price) throw new PythBenchmarksValidationError("PRICE_SHAPE");
    const mantissa = integerMantissa(price.price, "MANTISSA");
    if (mantissa <= 0n) throw new PythBenchmarksValidationError("MANTISSA");
    const exponent = price.expo;
    if (
      typeof exponent !== "number"
      || !Number.isSafeInteger(exponent)
      || exponent < MINIMUM_EXPONENT
      || exponent > MAXIMUM_EXPONENT
    ) {
      throw new PythBenchmarksValidationError("EXPONENT");
    }
    const publishTime = price.publish_time;
    if (
      typeof publishTime !== "number"
      || !Number.isSafeInteger(publishTime)
      || publishTime <= 0
      || Math.abs(publishTime - requestedTimestampSeconds) > this.maximumPublishDistanceSeconds
    ) {
      throw new PythBenchmarksValidationError("PUBLISH_TIME");
    }
    const confidence = integerMantissa(price.conf, "CONFIDENCE");
    if (confidence < 0n) throw new PythBenchmarksValidationError("CONFIDENCE");
    const priceNumber = Number(mantissa);
    const confidenceNumber = Number(confidence);
    const scale = 10 ** exponent;
    const priceUsd = priceNumber * scale;
    const confidenceUsd = confidenceNumber * scale;
    const confidenceRatio = confidenceNumber / priceNumber;
    if (
      !Number.isFinite(priceUsd)
      || priceUsd <= 0
      || !Number.isFinite(confidenceUsd)
      || confidenceUsd < 0
      || !Number.isFinite(confidenceRatio)
      || confidenceRatio > this.maximumConfidenceRatio
    ) {
      throw new PythBenchmarksValidationError("CONFIDENCE");
    }
    return {
      source: PYTH_SOL_USD_HISTORY_SOURCE,
      feedId: PYTH_SOL_USD_FEED_ID,
      requestedTimestampSeconds,
      observationTimestampSeconds: publishTime,
      publishTimeSeconds: publishTime,
      priceMantissa: mantissa.toString(),
      confidenceMantissa: confidence.toString(),
      exponent,
      priceUsd,
      confidenceUsd,
      confidenceRatio
    };
  }
}
