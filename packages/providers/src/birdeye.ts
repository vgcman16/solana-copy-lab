import type {
  DiscoveredWalletSet,
  ProviderHealth,
  PublicKeyString,
  WalletCandidate,
  WalletDiscoveryProvider,
  WalletPnlWindow
} from "@copylab/shared";
import {
  asRecord,
  cloneJson,
  errorMessage,
  finiteNumber,
  ProviderApiError,
  requestJson,
  stringValue,
  type FetchLike
} from "./http.js";

const DEFAULT_REQUEST_INTERVAL_MS = 1_100;
const DEFAULT_RATE_LIMIT_RETRIES = 2;
const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 6 * 60 * 60_000;

export interface BirdeyeOptions {
  baseUrl?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  minimumRequestIntervalMs?: number;
  maximumRateLimitRetries?: number;
  leaderboardLimit?: number;
  healthCheckIntervalMs?: number;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
  /** Called before every physical HTTP attempt so failures and 429 retries are metered. */
  onRequest?: (usage: { path: string; credits: number }) => void;
}

const BIRDEYE_CREDITS_ENDPOINT_CU = 1;
const BIRDEYE_WALLET_ANALYTICS_CU = 30;

interface RankedWallet {
  address: string;
  rank: number;
  tags: string[];
}

export class OneRequestPerSecondQueue {
  private tail: Promise<void> = Promise.resolve();
  private lastStartedAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly intervalMs = DEFAULT_REQUEST_INTERVAL_MS,
    private readonly now: () => number = Date.now,
    private readonly sleep: (milliseconds: number) => Promise<void> =
      (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
  ) {}

  schedule<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.tail.then(async () => {
      const remaining = this.intervalMs - (this.now() - this.lastStartedAt);
      if (remaining > 0) await this.sleep(remaining);
      this.lastStartedAt = this.now();
      return operation();
    });
    this.tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }
}

function weekStartIso(now: Date): string {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - day + 1);
  return date.toISOString().slice(0, 10);
}

function responseData(payload: unknown, operation: string): unknown {
  const root = asRecord(payload);
  if (!root) throw new Error(`Birdeye ${operation} returned a non-object response`);
  if (root.success === false) {
    throw new Error(
      `Birdeye ${operation} failed: ${stringValue(root.message) ?? "unknown API error"}`
    );
  }
  return root.data ?? root;
}

function extractLeaderboard(payload: unknown, offset = 0): RankedWallet[] {
  const data = responseData(payload, "leaderboard");
  const record = asRecord(data);
  const items = Array.isArray(data)
    ? data
    : Array.isArray(record?.items)
      ? record.items
      : Array.isArray(record?.traders)
        ? record.traders
        : Array.isArray(record?.list)
          ? record.list
          : undefined;

  if (!items) throw new Error("Birdeye leaderboard response did not contain an item list");

  const wallets: RankedWallet[] = [];
  for (const [index, item] of items.entries()) {
    const row = asRecord(item);
    if (!row) continue;
    const address =
      stringValue(row.address) ??
      stringValue(row.wallet) ??
      stringValue(row.wallet_address) ??
      stringValue(row.owner);
    if (!address) continue;
    const rawTags = row.tags ?? row.labels;
    const tags = Array.isArray(rawTags)
      ? rawTags.filter((tag): tag is string => typeof tag === "string")
      : typeof rawTags === "string"
        ? rawTags.split(",").map((tag) => tag.trim()).filter(Boolean)
        : [];
    wallets.push({ address, rank: offset + index + 1, tags });
  }
  return wallets;
}

function requiredNumber(record: Record<string, unknown>, keys: string[], field: string): number {
  for (const key of keys) {
    const value = finiteNumber(record[key]);
    if (value !== undefined) return value;
  }
  throw new Error(`Birdeye PnL response omitted ${field}`);
}

function optionalNumber(record: Record<string, unknown>, keys: string[], fallback = 0): number {
  for (const key of keys) {
    const value = finiteNumber(record[key]);
    if (value !== undefined) return value;
  }
  return fallback;
}

function parsePnl(payload: unknown, duration: "30d" | "90d"): WalletPnlWindow {
  const data = asRecord(responseData(payload, "PnL summary"));
  if (!data) throw new Error("Birdeye PnL summary data was not an object");
  const summary = asRecord(data.summary) ?? data;
  const pnl = asRecord(summary.pnl) ?? summary;
  const counts = asRecord(summary.counts) ?? summary;
  return {
    duration,
    realizedProfitUsd: requiredNumber(
      pnl,
      ["realized_profit_usd", "realizedProfitUsd", "realized_pnl"],
      "realized profit USD"
    ),
    realizedProfitPercent: requiredNumber(
      pnl,
      ["realized_profit_percent", "realizedProfitPercent", "realized_pnl_percentage"],
      "realized profit percent"
    ),
    unrealizedProfitUsd: optionalNumber(
      pnl,
      ["unrealized_usd", "unrealized_profit_usd", "unrealizedProfitUsd"]
    ),
    totalTrades: optionalNumber(counts, ["total_trade", "total_trades", "totalTrade"]),
    wins: optionalNumber(counts, ["total_win", "wins", "totalWin"]),
    losses: optionalNumber(counts, ["total_loss", "losses", "totalLoss"])
  };
}

export class BirdeyeProvider implements WalletDiscoveryProvider {
  private readonly baseUrl: string;
  private readonly fetch: FetchLike | undefined;
  private readonly timeoutMs: number;
  private readonly leaderboardLimit: number;
  private readonly maximumRateLimitRetries: number;
  private readonly healthCheckIntervalMs: number;
  private readonly now: () => Date;
  private readonly onRequest: ((usage: { path: string; credits: number }) => void) | undefined;
  private readonly queue: OneRequestPerSecondQueue;
  private cachedCohort?: DiscoveredWalletSet;
  private cachedHealth?: ProviderHealth;
  private requestCount = 0;

  constructor(
    private readonly apiKey: string,
    options: BirdeyeOptions = {}
  ) {
    if (!apiKey.trim()) throw new Error("Birdeye API key is required");
    this.baseUrl = (options.baseUrl ?? "https://public-api.birdeye.so").replace(/\/$/, "");
    this.fetch = options.fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.leaderboardLimit = Math.max(1, Math.min(100, options.leaderboardLimit ?? 100));
    this.maximumRateLimitRetries = options.maximumRateLimitRetries ?? DEFAULT_RATE_LIMIT_RETRIES;
    if (!Number.isInteger(this.maximumRateLimitRetries) || this.maximumRateLimitRetries < 0) {
      throw new RangeError("Birdeye maximumRateLimitRetries must be a non-negative integer");
    }
    this.healthCheckIntervalMs = options.healthCheckIntervalMs ?? DEFAULT_HEALTH_CHECK_INTERVAL_MS;
    if (!Number.isFinite(this.healthCheckIntervalMs) || this.healthCheckIntervalMs < 0) {
      throw new RangeError("Birdeye healthCheckIntervalMs must be a non-negative number");
    }
    this.now = options.now ?? (() => new Date());
    this.onRequest = options.onRequest;
    this.queue = new OneRequestPerSecondQueue(
      options.minimumRequestIntervalMs ?? DEFAULT_REQUEST_INTERVAL_MS,
      () => this.now().getTime(),
      options.sleep
    );
  }

  async discoverCohort(now = this.now()): Promise<DiscoveredWalletSet> {
    const cohortId = `birdeye-${weekStartIso(now)}`;
    if (this.cachedCohort?.cohortId === cohortId) return cloneJson(this.cachedCohort);

    const specifications = [
      { duration: "30d" as const, sort: "desc" as const, control: false },
      { duration: "30d" as const, sort: "asc" as const, control: true },
      { duration: "90d" as const, sort: "desc" as const, control: false },
      { duration: "90d" as const, sort: "asc" as const, control: true }
    ];
    const results: Array<(typeof specifications)[number] & { wallets: RankedWallet[] }> = [];
    for (const specification of specifications) {
      // A second winner page broadens discovery beyond the most bot-heavy top 100.
      // Controls remain a small first-page bias sample so free-tier spend stays bounded.
      const offsets = specification.control ? [0] : [0, this.leaderboardLimit];
      for (const offset of offsets) {
        const wallets = await this.getLeaderboard(
          specification.duration,
          specification.sort,
          this.leaderboardLimit,
          offset
        );
        results.push({ ...specification, wallets });
      }
    }

    const generatedAt = now.toISOString();
    const merged = new Map<
      string,
      {
        candidate: WalletCandidate;
        observedAsGainer: boolean;
      }
    >();

    for (const result of results) {
      for (const wallet of result.wallets) {
        const existing = merged.get(wallet.address);
        if (!existing) {
          const candidate: WalletCandidate = {
            address: wallet.address,
            cohortId,
            firstSeenAt: generatedAt,
            lastSeenAt: generatedAt,
            control: result.control,
            tags: [...new Set(wallet.tags.map((tag) => tag.toLowerCase()))]
          };
          if (!result.control && result.duration === "30d") candidate.sourceRank30d = wallet.rank;
          if (!result.control && result.duration === "90d") candidate.sourceRank90d = wallet.rank;
          merged.set(wallet.address, { candidate, observedAsGainer: !result.control });
          continue;
        }

        existing.observedAsGainer ||= !result.control;
        existing.candidate.control = !existing.observedAsGainer;
        existing.candidate.tags = [
          ...new Set([...existing.candidate.tags, ...wallet.tags.map((tag) => tag.toLowerCase())])
        ];
        if (!result.control && result.duration === "30d") {
          existing.candidate.sourceRank30d = Math.min(
            existing.candidate.sourceRank30d ?? Number.POSITIVE_INFINITY,
            wallet.rank
          );
        }
        if (!result.control && result.duration === "90d") {
          existing.candidate.sourceRank90d = Math.min(
            existing.candidate.sourceRank90d ?? Number.POSITIVE_INFINITY,
            wallet.rank
          );
        }
      }
    }

    const cohort: DiscoveredWalletSet = {
      cohortId,
      generatedAt,
      candidates: [...merged.values()].map(({ candidate, observedAsGainer }) => ({
        ...candidate,
        control: !observedAsGainer
      }))
    };
    this.cachedCohort = cloneJson(cohort);
    return cohort;
  }

  async getPnl(
    address: PublicKeyString,
    duration: "30d" | "90d"
  ): Promise<WalletPnlWindow> {
    if (!address) throw new Error("Birdeye wallet address is required");
    const url = new URL(`${this.baseUrl}/wallet/v2/pnl/summary`);
    url.searchParams.set("wallet", address);
    url.searchParams.set("duration", duration);
    url.searchParams.set("position_scope", "duration_only");
    const payload = await this.get(url);
    return parsePnl(payload, duration);
  }

  async checkHealth(): Promise<ProviderHealth> {
    const startedAt = this.now().getTime();
    if (
      this.cachedHealth &&
      startedAt - Date.parse(this.cachedHealth.checkedAt) < this.healthCheckIntervalMs
    ) {
      return cloneJson(this.cachedHealth);
    }
    try {
      // The credits endpoint validates connectivity and authentication for 1 CU;
      // the leaderboard endpoint costs 30 CU and is reserved for discovery.
      const url = new URL(`${this.baseUrl}/utils/v1/credits`);
      await this.get(url);
      const health: ProviderHealth = {
        provider: "birdeye",
        ok: true,
        checkedAt: this.now().toISOString(),
        latencyMs: Math.max(0, this.now().getTime() - startedAt),
        message: "Birdeye API is reachable and authenticated",
        usage: { requests: this.requestCount, window: "unknown" }
      };
      this.cachedHealth = cloneJson(health);
      return health;
    } catch (error) {
      return {
        provider: "birdeye",
        ok: false,
        checkedAt: this.now().toISOString(),
        latencyMs: Math.max(0, this.now().getTime() - startedAt),
        message: errorMessage(error),
        usage: { requests: this.requestCount, window: "unknown" }
      };
    }
  }

  private async getLeaderboard(
    duration: "30d" | "90d",
    sort: "asc" | "desc",
    limit = this.leaderboardLimit,
    offset = 0
  ): Promise<RankedWallet[]> {
    const url = new URL(`${this.baseUrl}/trader/gainers-losers`);
    url.searchParams.set("type", duration);
    url.searchParams.set("sort_by", "realized_pnl");
    url.searchParams.set("sort_type", sort);
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("limit", String(limit));
    return extractLeaderboard(await this.get(url), offset);
  }

  private async get(url: URL): Promise<unknown> {
    for (let retry = 0; ; retry += 1) {
      try {
        return await this.queue.schedule(async () => {
          const credits = url.pathname === "/utils/v1/credits"
            ? BIRDEYE_CREDITS_ENDPOINT_CU
            : BIRDEYE_WALLET_ANALYTICS_CU;
          this.onRequest?.({ path: url.pathname, credits });
          this.requestCount += 1;
          return requestJson(url, {
            headers: {
              "X-API-KEY": this.apiKey,
              "x-chain": "solana",
              accept: "application/json"
            }
          }, {
            provider: "Birdeye",
            fetch: this.fetch,
            timeoutMs: this.timeoutMs
          });
        });
      } catch (error) {
        const shouldRetry =
          error instanceof ProviderApiError &&
          error.status === 429 &&
          retry < this.maximumRateLimitRetries;
        if (!shouldRetry) throw error;
      }
    }
  }
}
