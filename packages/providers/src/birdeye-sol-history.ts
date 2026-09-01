import { SOL_MINT } from "@copylab/shared";
import {
  asRecord,
  finiteNumber,
  ProviderApiError,
  requestJson,
  stringValue,
  type FetchLike
} from "./http.js";
import { OneRequestPerSecondQueue } from "./birdeye.js";
import {
  BIRDEYE_SOL_USD_HISTORY_SOURCE,
  type SolUsdHistoricalPrice,
  type SolUsdHistoricalPriceProvider
} from "./sol-usd-history.js";

export const BIRDEYE_SOL_USD_HISTORY_BASE_URL = "https://public-api.birdeye.so";
export const BIRDEYE_SOL_USD_HISTORY_CANDLE_SECONDS = 5 * 60;
const DEFAULT_MAXIMUM_CANDLES_PER_REQUEST = 4_800;
const DEFAULT_REQUEST_INTERVAL_MS = 1_100;

export interface BirdeyeSolUsdHistoryOptions {
  baseUrl?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  maximumCandlesPerRequest?: number;
  minimumRequestIntervalMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  /** Reserved before every physical request; CU follows Birdeye's documented tiers. */
  onRequest?: (usage: { path: "/defi/v3/ohlcv"; credits: 45 | 75 | 100 }) => void;
}

export type BirdeyeSolUsdHistoryValidationCode =
  | "RESPONSE_SHAPE"
  | "CANDLE_COUNT"
  | "CANDLE_SHAPE"
  | "CANDLE_TIME"
  | "CANDLE_PRICE"
  | "DUPLICATE_CANDLE"
  | "TARGET_MISSING";

export class BirdeyeSolUsdHistoryRequestError extends Error {
  constructor(
    readonly status: number | undefined,
    readonly retryable: boolean
  ) {
    super(`Birdeye SOL/USD history request failed${status === undefined ? "" : ` (HTTP ${status})`}.`);
    this.name = "BirdeyeSolUsdHistoryRequestError";
  }
}

export class BirdeyeSolUsdHistoryValidationError extends Error {
  constructor(readonly code: BirdeyeSolUsdHistoryValidationCode) {
    super(`Birdeye SOL/USD history response validation failed (${code}).`);
    this.name = "BirdeyeSolUsdHistoryValidationError";
  }
}

function normalizedBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Birdeye SOL/USD history baseUrl must be an absolute HTTPS URL.");
  }
  if (url.protocol !== "https:") throw new Error("Birdeye SOL/USD history baseUrl must use HTTPS.");
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Birdeye SOL/USD history baseUrl cannot contain credentials, a query, or a fragment.");
  }
  if (url.pathname !== "/") {
    throw new Error("Birdeye SOL/USD history baseUrl must be an origin without a path.");
  }
  return url.origin;
}

function normalizedApiKey(value: string): string {
  const key = value.trim();
  if (!key || key.length > 4_096 || /[\r\n]/.test(key)) {
    throw new Error("Birdeye SOL/USD history API key must be a non-empty single-line value.");
  }
  return key;
}

function candleItems(payload: unknown): unknown[] {
  const root = asRecord(payload);
  if (!root || root.success === false) {
    throw new BirdeyeSolUsdHistoryValidationError("RESPONSE_SHAPE");
  }
  const data = root.data ?? root;
  if (Array.isArray(data)) return data;
  const record = asRecord(data);
  const items = record?.items ?? record?.list ?? record?.candles;
  if (!Array.isArray(items)) throw new BirdeyeSolUsdHistoryValidationError("RESPONSE_SHAPE");
  return items;
}

function requiredPrice(row: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = finiteNumber(row[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function requestCredits(candles: number): 45 | 75 | 100 {
  if (candles <= 1_000) return 45;
  if (candles <= 2_000) return 75;
  return 100;
}

/**
 * Authenticated managed-provider fallback for Pyth Benchmarks. It downloads
 * real Birdeye 5-minute SOL/USD candles in bounded pages and admits only the
 * opening mark at an exact ten-minute grid timestamp. No interpolation,
 * padding, forward-fill, or synthesized confidence values are used.
 */
export class BirdeyeSolUsdHistoryClient implements SolUsdHistoricalPriceProvider {
  readonly authenticationConfigured = true;
  readonly pythAuthenticationConfigured = false;
  readonly fallbackConfigured = true;
  readonly activeSource = BIRDEYE_SOL_USD_HISTORY_SOURCE;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetch: FetchLike | undefined;
  private readonly timeoutMs: number;
  private readonly maximumCandlesPerRequest: number;
  private readonly onRequest: NonNullable<BirdeyeSolUsdHistoryOptions["onRequest"]>;
  private readonly queue: OneRequestPerSecondQueue;
  private readonly pricesByTimestamp = new Map<number, number>();

  constructor(apiKey: string, options: BirdeyeSolUsdHistoryOptions = {}) {
    this.apiKey = normalizedApiKey(apiKey);
    this.baseUrl = normalizedBaseUrl(options.baseUrl ?? BIRDEYE_SOL_USD_HISTORY_BASE_URL);
    this.fetch = options.fetch;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > 120_000) {
      throw new RangeError("Birdeye SOL/USD history timeoutMs must be between 0 and 120000 milliseconds.");
    }
    this.maximumCandlesPerRequest = options.maximumCandlesPerRequest
      ?? DEFAULT_MAXIMUM_CANDLES_PER_REQUEST;
    if (
      !Number.isSafeInteger(this.maximumCandlesPerRequest)
      || this.maximumCandlesPerRequest < 2
      || this.maximumCandlesPerRequest > 5_000
    ) {
      throw new RangeError("Birdeye SOL/USD history maximumCandlesPerRequest must be from 2 to 5000.");
    }
    this.onRequest = options.onRequest ?? (() => undefined);
    this.queue = new OneRequestPerSecondQueue(
      options.minimumRequestIntervalMs ?? DEFAULT_REQUEST_INTERVAL_MS,
      options.now ?? Date.now,
      options.sleep
    );
  }

  async getSolUsdPrice(timestampSeconds: number): Promise<SolUsdHistoricalPrice> {
    if (
      !Number.isSafeInteger(timestampSeconds)
      || timestampSeconds <= 0
      || timestampSeconds % (10 * 60) !== 0
    ) {
      throw new RangeError("Birdeye SOL/USD history timestamp must be a positive ten-minute Unix grid point.");
    }
    if (!this.pricesByTimestamp.has(timestampSeconds)) {
      await this.fetchPage(timestampSeconds);
    }
    const priceUsd = this.pricesByTimestamp.get(timestampSeconds);
    if (priceUsd === undefined) {
      throw new BirdeyeSolUsdHistoryValidationError("TARGET_MISSING");
    }
    return {
      source: BIRDEYE_SOL_USD_HISTORY_SOURCE,
      requestedTimestampSeconds: timestampSeconds,
      observationTimestampSeconds: timestampSeconds,
      priceUsd
    };
  }

  private async fetchPage(startSeconds: number): Promise<void> {
    const endSeconds = startSeconds
      + (this.maximumCandlesPerRequest - 1) * BIRDEYE_SOL_USD_HISTORY_CANDLE_SECONDS;
    const endpoint = new URL("/defi/v3/ohlcv", this.baseUrl);
    endpoint.searchParams.set("address", SOL_MINT);
    endpoint.searchParams.set("type", "5m");
    endpoint.searchParams.set("currency", "usd");
    endpoint.searchParams.set("chart_type", "price");
    endpoint.searchParams.set("mode", "range");
    endpoint.searchParams.set("time_from", String(startSeconds));
    endpoint.searchParams.set("time_to", String(endSeconds));
    endpoint.searchParams.set("padding", "false");
    endpoint.searchParams.set("ui_amount_mode", "raw");

    let payload: unknown;
    try {
      payload = await this.queue.schedule(async () => {
        this.onRequest({
          path: "/defi/v3/ohlcv",
          credits: requestCredits(this.maximumCandlesPerRequest)
        });
        return requestJson(endpoint, {
          method: "GET",
          headers: {
            "X-API-KEY": this.apiKey,
            "x-chain": "solana",
            accept: "application/json"
          }
        }, {
          provider: "Birdeye SOL/USD history",
          fetch: this.fetch,
          timeoutMs: this.timeoutMs
        });
      });
    } catch (error) {
      if (error instanceof ProviderApiError) {
        throw new BirdeyeSolUsdHistoryRequestError(error.status, error.retryable);
      }
      throw error;
    }

    const items = candleItems(payload);
    if (items.length > this.maximumCandlesPerRequest) {
      throw new BirdeyeSolUsdHistoryValidationError("CANDLE_COUNT");
    }
    const page = new Map<number, number>();
    for (const item of items) {
      const row = asRecord(item);
      if (!row) throw new BirdeyeSolUsdHistoryValidationError("CANDLE_SHAPE");
      const timestamp = finiteNumber(row.unix_time ?? row.unixTime ?? row.time);
      if (
        timestamp === undefined
        || !Number.isSafeInteger(timestamp)
        || timestamp < startSeconds
        || timestamp > endSeconds
        || timestamp % BIRDEYE_SOL_USD_HISTORY_CANDLE_SECONDS !== 0
      ) {
        throw new BirdeyeSolUsdHistoryValidationError("CANDLE_TIME");
      }
      const address = stringValue(row.address);
      const type = stringValue(row.type);
      const currency = stringValue(row.currency);
      if (
        (address !== undefined && address !== SOL_MINT)
        || (type !== undefined && type.toLowerCase() !== "5m")
        || (currency !== undefined && currency.toLowerCase() !== "usd")
      ) {
        throw new BirdeyeSolUsdHistoryValidationError("CANDLE_SHAPE");
      }
      const open = requiredPrice(row, ["o", "open"]);
      const high = requiredPrice(row, ["h", "high"]);
      const low = requiredPrice(row, ["l", "low"]);
      const close = requiredPrice(row, ["c", "close"]);
      if (
        open === undefined || high === undefined || low === undefined || close === undefined
        || open <= 0 || high <= 0 || low <= 0 || close <= 0
        || high < Math.max(open, low, close)
        || low > Math.min(open, high, close)
      ) {
        throw new BirdeyeSolUsdHistoryValidationError("CANDLE_PRICE");
      }
      const existing = page.get(timestamp);
      if (existing !== undefined && existing !== open) {
        throw new BirdeyeSolUsdHistoryValidationError("DUPLICATE_CANDLE");
      }
      page.set(timestamp, open);
    }
    for (const [timestamp, price] of page) this.pricesByTimestamp.set(timestamp, price);
  }
}
