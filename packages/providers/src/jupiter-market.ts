import type { ProviderHealth, PublicKeyString } from "@copylab/shared";
import {
  asRecord,
  finiteNumber,
  ProviderApiError,
  requestJson,
  stringValue,
  type FetchLike
} from "./http.js";

export type JupiterMarketCategory = "toptraded" | "toptrending" | "toporganicscore";
export type JupiterMarketCategoryInterval = "5m" | "1h" | "6h" | "24h";
export type JupiterMarketStatsInterval = "5m" | "1h" | "6h" | "24h";

export interface JupiterMarketStats {
  priceChange?: number;
  liquidityChange?: number;
  volumeChange?: number;
  buyVolume?: number;
  sellVolume?: number;
  buyOrganicVolume?: number;
  sellOrganicVolume?: number;
  numBuys?: number;
  numSells?: number;
  numTraders?: number;
  numOrganicBuyers?: number;
  numNetBuyers?: number;
}

export interface JupiterMarketCategoryRanks {
  topTraded24h?: number;
  topTraded6h?: number;
  topTraded1h?: number;
  topTrending6h?: number;
  topTrending1h?: number;
  topOrganicScore5m?: number;
  topOrganicScore1h?: number;
}

/**
 * One point-in-time Tokens V2 record. Schema-defined nullable fields remain
 * optional instead of being converted to reassuring zeroes. Consumers must
 * explicitly reject any evidence their policy requires but Jupiter omitted.
 */
export interface JupiterMarketTokenSnapshot {
  mint: PublicKeyString;
  name: string;
  symbol: string;
  decimals: number;
  tokenProgram: PublicKeyString;
  createdAt?: string;
  iconUrl?: string;
  twitter?: string;
  telegram?: string;
  website?: string;
  discord?: string;
  instagram?: string;
  tiktok?: string;
  otherUrl?: string;
  developer?: PublicKeyString;
  launchpad?: string;
  partnerConfig?: string;
  graduatedPool?: PublicKeyString;
  graduatedAt?: string;
  firstPoolId?: PublicKeyString;
  firstPoolAt?: string;
  circulatingSupply?: number;
  totalSupply?: number;
  holderCount?: number;
  fdvUsd?: number;
  marketCapUsd?: number;
  priceUsd?: number;
  priceBlockId?: number;
  liquidityUsd?: number;
  stats5m?: JupiterMarketStats;
  stats1h?: JupiterMarketStats;
  stats6h?: JupiterMarketStats;
  stats24h?: JupiterMarketStats;
  organicScore: number;
  organicScoreLabel: "high" | "medium" | "low";
  verified: boolean;
  tags: string[];
  suspicious: boolean;
  mintAuthorityDisabled: boolean;
  freezeAuthorityDisabled: boolean;
  topHoldersPercent?: number;
  updatedAt: string;
  categoryRanks: JupiterMarketCategoryRanks;
}

export interface JupiterMarketUniverseSnapshot {
  capturedAt: string;
  tokens: JupiterMarketTokenSnapshot[];
  /** Category rows are counted before mint de-duplication so callers can
   * distinguish a healthy partial feed from an empty or silently degraded
   * universe. Malformed rows are never exposed as token candidates. */
  diagnostics?: JupiterMarketUniverseDiagnostics;
}

export interface JupiterMarketUniverseDiagnostics {
  receivedRows: number;
  acceptedRows: number;
  quarantinedRows: number;
}

export interface JupiterMarketRequestUsage {
  path: string;
  requests: 1;
}

export interface JupiterMarketDataOptions {
  baseUrl?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  now?: () => Date;
  /** Invoked immediately before each physical Jupiter request. */
  onRequest?: (usage: JupiterMarketRequestUsage) => void;
  /** One bounded retry is used only for transient transport/408/5xx failures.
   * HTTP 429 is owned by the shared account-wide pacing queue and is never
   * multiplied here. */
  maximumTransientRetries?: number;
  retryBaseMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

const CATEGORY_PATHS = Object.freeze({
  topTraded24h: "/tokens/v2/toptraded/24h",
  topTraded6h: "/tokens/v2/toptraded/6h",
  topTraded1h: "/tokens/v2/toptraded/1h",
  topTrending6h: "/tokens/v2/toptrending/6h",
  topTrending1h: "/tokens/v2/toptrending/1h",
  topOrganicScore5m: "/tokens/v2/toporganicscore/5m",
  topOrganicScore1h: "/tokens/v2/toporganicscore/1h"
});
const SEARCH_PATH = "/tokens/v2/search";
const MAX_CATEGORY_LIMIT = 100;
const MAX_SEARCH_MINTS = 100;

class MalformedJupiterMarketRowError extends Error {
  constructor(field: string) {
    super(`Jupiter Markets response contained invalid ${field}`);
    this.name = "MalformedJupiterMarketRowError";
  }
}

function malformed(field: string): never {
  throw new MalformedJupiterMarketRowError(field);
}

function requiredString(record: Record<string, unknown>, field: string): string {
  return stringValue(record[field]) ?? malformed(field);
}

function optionalString(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  if (value === null || value === undefined) return undefined;
  return stringValue(value) ?? malformed(field);
}

function requiredNumber(record: Record<string, unknown>, field: string): number {
  return finiteNumber(record[field]) ?? malformed(field);
}

function optionalNumber(record: Record<string, unknown>, field: string): number | undefined {
  const value = record[field];
  if (value === null || value === undefined) return undefined;
  return finiteNumber(value) ?? malformed(field);
}

function nonNegative(value: number, field: string): number {
  if (value < 0) malformed(field);
  return value;
}

function optionalNonNegative(
  record: Record<string, unknown>,
  field: string
): number | undefined {
  const value = optionalNumber(record, field);
  return value === undefined ? undefined : nonNegative(value, field);
}

function safeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) malformed(field);
  return value;
}

function optionalSafeInteger(
  record: Record<string, unknown>,
  field: string
): number | undefined {
  const value = optionalNumber(record, field);
  return value === undefined ? undefined : safeInteger(value, field);
}

function timestamp(value: string, field: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) malformed(field);
  return new Date(parsed).toISOString();
}

function optionalTimestamp(
  record: Record<string, unknown>,
  field: string
): string | undefined {
  const value = optionalString(record, field);
  return value === undefined ? undefined : timestamp(value, field);
}

function parseTags(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) malformed("tags");
  const tags = value.map((tag) => {
    if (typeof tag !== "string" || tag.length === 0) malformed("tags");
    return tag.toLowerCase();
  });
  return [...new Set(tags)];
}

function parseStats(value: unknown, field: string): JupiterMarketStats | undefined {
  if (value === null || value === undefined) return undefined;
  const stats = asRecord(value);
  if (!stats) malformed(field);
  const priceChange = optionalNumber(stats, "priceChange");
  const liquidityChange = optionalNumber(stats, "liquidityChange");
  const volumeChange = optionalNumber(stats, "volumeChange");
  const buyVolumeValue = optionalNumber(stats, "buyVolume");
  const sellVolumeValue = optionalNumber(stats, "sellVolume");
  const buyOrganicVolumeValue = optionalNumber(stats, "buyOrganicVolume");
  const sellOrganicVolumeValue = optionalNumber(stats, "sellOrganicVolume");
  const numBuysValue = optionalNumber(stats, "numBuys");
  const numSellsValue = optionalNumber(stats, "numSells");
  const numTradersValue = optionalNumber(stats, "numTraders");
  const numOrganicBuyersValue = optionalNumber(stats, "numOrganicBuyers");
  const numNetBuyersValue = optionalNumber(stats, "numNetBuyers");
  const buyVolume = buyVolumeValue === undefined
    ? undefined : nonNegative(buyVolumeValue, `${field}.buyVolume`);
  const sellVolume = sellVolumeValue === undefined
    ? undefined : nonNegative(sellVolumeValue, `${field}.sellVolume`);
  const buyOrganicVolume = buyOrganicVolumeValue === undefined
    ? undefined : nonNegative(buyOrganicVolumeValue, `${field}.buyOrganicVolume`);
  const sellOrganicVolume = sellOrganicVolumeValue === undefined
    ? undefined : nonNegative(sellOrganicVolumeValue, `${field}.sellOrganicVolume`);
  const numBuys = numBuysValue === undefined
    ? undefined : safeInteger(numBuysValue, `${field}.numBuys`);
  const numSells = numSellsValue === undefined
    ? undefined : safeInteger(numSellsValue, `${field}.numSells`);
  const numTraders = numTradersValue === undefined
    ? undefined : safeInteger(numTradersValue, `${field}.numTraders`);
  const numOrganicBuyers = numOrganicBuyersValue === undefined
    ? undefined : safeInteger(numOrganicBuyersValue, `${field}.numOrganicBuyers`);
  const numNetBuyers = numNetBuyersValue === undefined
    ? undefined : safeInteger(numNetBuyersValue, `${field}.numNetBuyers`);
  return {
    ...(priceChange !== undefined ? { priceChange } : {}),
    ...(liquidityChange !== undefined ? { liquidityChange } : {}),
    ...(volumeChange !== undefined ? { volumeChange } : {}),
    ...(buyVolume !== undefined ? { buyVolume } : {}),
    ...(sellVolume !== undefined ? { sellVolume } : {}),
    ...(buyOrganicVolume !== undefined ? { buyOrganicVolume } : {}),
    ...(sellOrganicVolume !== undefined ? { sellOrganicVolume } : {}),
    ...(numBuys !== undefined ? { numBuys } : {}),
    ...(numSells !== undefined ? { numSells } : {}),
    ...(numTraders !== undefined ? { numTraders } : {}),
    ...(numOrganicBuyers !== undefined ? { numOrganicBuyers } : {}),
    ...(numNetBuyers !== undefined ? { numNetBuyers } : {})
  };
}

function optionalUrlField(
  row: Record<string, unknown>,
  field: string
): { [key: string]: string } {
  const value = optionalString(row, field);
  return value === undefined ? {} : { [field === "icon" ? "iconUrl" : field]: value };
}

function parseToken(value: unknown): JupiterMarketTokenSnapshot {
  const row = asRecord(value);
  if (!row) malformed("token row");
  const mint = requiredString(row, "id");
  const decimals = safeInteger(requiredNumber(row, "decimals"), "decimals");
  if (decimals > 255) malformed("decimals");

  const organicScore = requiredNumber(row, "organicScore");
  if (organicScore < 0 || organicScore > 100) malformed("organicScore");
  const organicScoreLabel = requiredString(row, "organicScoreLabel").toLowerCase();
  if (!["high", "medium", "low"].includes(organicScoreLabel)) {
    malformed("organicScoreLabel");
  }

  const firstPool = row.firstPool === null || row.firstPool === undefined
    ? undefined
    : asRecord(row.firstPool) ?? malformed("firstPool");
  const audit = row.audit === null || row.audit === undefined
    ? undefined
    : asRecord(row.audit) ?? malformed("audit");
  const tags = parseTags(row.tags);
  // Tokens V2 currently omits audit.isSus even on established verified
  // assets. Preserve an explicit true and the documented safety tags; the
  // autonomous policy separately requires verification, disabled authorities,
  // holder concentration, age, liquidity, and standard-token evidence.
  const suspicious = audit?.isSus === true ||
    tags.some((tag) => tag === "banned" || tag === "suspicious" || tag === "scam");
  const mintAuthorityDisabled = Object.hasOwn(row, "mintAuthority")
    ? row.mintAuthority === null
    : audit?.mintAuthorityDisabled === true;
  const freezeAuthorityDisabled = Object.hasOwn(row, "freezeAuthority")
    ? row.freezeAuthority === null
    : audit?.freezeAuthorityDisabled === true;
  const topHoldersPercent = audit
    ? optionalNumber(audit, "topHoldersPercentage")
    : undefined;
  if (
    topHoldersPercent !== undefined &&
    (topHoldersPercent < 0 || topHoldersPercent > 100)
  ) malformed("audit.topHoldersPercentage");

  const result: JupiterMarketTokenSnapshot = {
    mint,
    name: requiredString(row, "name"),
    symbol: requiredString(row, "symbol"),
    decimals,
    tokenProgram: requiredString(row, "tokenProgram"),
    ...optionalUrlField(row, "icon"),
    ...optionalUrlField(row, "twitter"),
    ...optionalUrlField(row, "telegram"),
    ...optionalUrlField(row, "website"),
    ...optionalUrlField(row, "discord"),
    ...optionalUrlField(row, "instagram"),
    ...optionalUrlField(row, "tiktok"),
    ...optionalUrlField(row, "otherUrl"),
    organicScore,
    organicScoreLabel: organicScoreLabel as "high" | "medium" | "low",
    verified: row.isVerified === true,
    tags,
    suspicious,
    mintAuthorityDisabled,
    freezeAuthorityDisabled,
    updatedAt: timestamp(requiredString(row, "updatedAt"), "updatedAt"),
    categoryRanks: {}
  };

  const createdAt = optionalTimestamp(row, "createdAt");
  const developer = optionalString(row, "dev");
  const launchpad = optionalString(row, "launchpad");
  const partnerConfig = optionalString(row, "partnerConfig");
  const graduatedPool = optionalString(row, "graduatedPool");
  const graduatedAt = optionalTimestamp(row, "graduatedAt");
  const circulatingSupply = optionalNonNegative(row, "circSupply");
  const totalSupply = optionalNonNegative(row, "totalSupply");
  const holderCount = optionalSafeInteger(row, "holderCount");
  const fdvUsd = optionalNonNegative(row, "fdv");
  const marketCapUsd = optionalNonNegative(row, "mcap");
  const priceUsd = optionalNonNegative(row, "usdPrice");
  const priceBlockId = optionalSafeInteger(row, "priceBlockId");
  const liquidityUsd = optionalNonNegative(row, "liquidity");
  const stats5m = parseStats(row.stats5m, "stats5m");
  const stats1h = parseStats(row.stats1h, "stats1h");
  const stats6h = parseStats(row.stats6h, "stats6h");
  const stats24h = parseStats(row.stats24h, "stats24h");
  const firstPoolId = firstPool ? optionalString(firstPool, "id") : undefined;
  const firstPoolAtValue = firstPool ? optionalTimestamp(firstPool, "createdAt") : undefined;

  if (createdAt) result.createdAt = createdAt;
  if (developer) result.developer = developer;
  if (launchpad) result.launchpad = launchpad;
  if (partnerConfig) result.partnerConfig = partnerConfig;
  if (graduatedPool) result.graduatedPool = graduatedPool;
  if (graduatedAt) result.graduatedAt = graduatedAt;
  if (firstPoolId) result.firstPoolId = firstPoolId;
  if (firstPoolAtValue) result.firstPoolAt = firstPoolAtValue;
  if (circulatingSupply !== undefined) result.circulatingSupply = circulatingSupply;
  if (totalSupply !== undefined) result.totalSupply = totalSupply;
  if (holderCount !== undefined) result.holderCount = holderCount;
  if (fdvUsd !== undefined) result.fdvUsd = fdvUsd;
  if (marketCapUsd !== undefined) result.marketCapUsd = marketCapUsd;
  if (priceUsd !== undefined) result.priceUsd = priceUsd;
  if (priceBlockId !== undefined) result.priceBlockId = priceBlockId;
  if (liquidityUsd !== undefined) result.liquidityUsd = liquidityUsd;
  if (stats5m) result.stats5m = stats5m;
  if (stats1h) result.stats1h = stats1h;
  if (stats6h) result.stats6h = stats6h;
  if (stats24h) result.stats24h = stats24h;
  if (topHoldersPercent !== undefined) result.topHoldersPercent = topHoldersPercent;
  return result;
}

function compareRecency(
  left: JupiterMarketTokenSnapshot,
  right: JupiterMarketTokenSnapshot
): number {
  const timestampDifference = Date.parse(left.updatedAt) - Date.parse(right.updatedAt);
  if (timestampDifference !== 0) return timestampDifference;
  return (left.priceBlockId ?? -1) - (right.priceBlockId ?? -1);
}

function mergeToken(
  existing: JupiterMarketTokenSnapshot,
  incoming: JupiterMarketTokenSnapshot
): JupiterMarketTokenSnapshot {
  if (
    existing.mint !== incoming.mint ||
    existing.decimals !== incoming.decimals ||
    existing.tokenProgram !== incoming.tokenProgram
  ) malformed("conflicting category token identity");
  const preferred = compareRecency(incoming, existing) > 0 ? incoming : existing;
  return {
    ...preferred,
    categoryRanks: mergeCategoryRanks(existing.categoryRanks, incoming.categoryRanks)
  };
}

const CATEGORY_RANK_KEYS = Object.freeze([
  "topTraded24h",
  "topTraded6h",
  "topTraded1h",
  "topTrending6h",
  "topTrending1h",
  "topOrganicScore5m",
  "topOrganicScore1h"
] as const satisfies readonly (keyof JupiterMarketCategoryRanks)[]);

/** Preserve every source rank and keep the best rank if a malformed upstream
 * category repeats a mint. This also makes rank merging independent of feed
 * completion order. */
function mergeCategoryRanks(
  existing: JupiterMarketCategoryRanks,
  incoming: JupiterMarketCategoryRanks
): JupiterMarketCategoryRanks {
  const merged: JupiterMarketCategoryRanks = {};
  for (const key of CATEGORY_RANK_KEYS) {
    const left = existing[key];
    const right = incoming[key];
    if (left !== undefined || right !== undefined) {
      merged[key] = Math.min(left ?? Number.POSITIVE_INFINITY, right ?? Number.POSITIVE_INFINITY);
    }
  }
  return merged;
}

function parseArray(payload: unknown, operation: string): JupiterMarketTokenSnapshot[] {
  if (!Array.isArray(payload)) {
    throw new Error(`Jupiter Markets ${operation} returned a non-array response`);
  }
  return payload.map(parseToken);
}

interface ParsedCategoryToken {
  /** Preserve the upstream rank even when an earlier malformed row is skipped. */
  rank: number;
  token: JupiterMarketTokenSnapshot;
}

interface ParsedCategory {
  rows: ParsedCategoryToken[];
  receivedRows: number;
  quarantinedRows: number;
}

/** Category discovery is best-effort across independent public market rows.
 * A schema-invalid row is quarantined, while transport/envelope/programming
 * failures still reject the whole category request. Exact-mint parsing uses
 * parseArray above and deliberately remains fail-closed. */
function parseCategoryArray(payload: unknown, operation: string): ParsedCategory {
  if (!Array.isArray(payload)) {
    throw new Error(`Jupiter Markets ${operation} returned a non-array response`);
  }
  const rows: ParsedCategoryToken[] = [];
  let quarantinedRows = 0;
  payload.forEach((value, index) => {
    try {
      rows.push({ rank: index + 1, token: parseToken(value) });
    } catch (error) {
      if (!(error instanceof MalformedJupiterMarketRowError)) throw error;
      quarantinedRows += 1;
    }
  });
  return { rows, receivedRows: payload.length, quarantinedRows };
}

/** Read-only Tokens V2 market data. This class deliberately has no execution method. */
export class JupiterMarketDataProvider {
  private readonly baseUrl: string;
  private readonly fetch: FetchLike | undefined;
  private readonly timeoutMs: number;
  private readonly now: () => Date;
  private readonly onRequest: ((usage: JupiterMarketRequestUsage) => void) | undefined;
  private readonly maximumTransientRetries: number;
  private readonly retryBaseMs: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(
    private readonly apiKey: string,
    options: JupiterMarketDataOptions = {}
  ) {
    if (!apiKey.trim()) throw new Error("Jupiter API key is required");
    this.baseUrl = (options.baseUrl ?? "https://api.jup.ag").replace(/\/$/, "");
    this.fetch = options.fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.now = options.now ?? (() => new Date());
    this.onRequest = options.onRequest;
    this.maximumTransientRetries = options.maximumTransientRetries ?? 1;
    this.retryBaseMs = options.retryBaseMs ?? 500;
    this.sleep = options.sleep ?? ((milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds))
    );
    if (
      !Number.isSafeInteger(this.maximumTransientRetries) ||
      this.maximumTransientRetries < 0 ||
      this.maximumTransientRetries > 2
    ) {
      throw new RangeError("Jupiter market maximumTransientRetries must be between 0 and 2");
    }
    if (!Number.isFinite(this.retryBaseMs) || this.retryBaseMs < 0 || this.retryBaseMs > 10_000) {
      throw new RangeError("Jupiter market retryBaseMs must be between 0 and 10000 milliseconds");
    }
  }

  async fetchSignalUniverse(limit = MAX_CATEGORY_LIMIT): Promise<JupiterMarketUniverseSnapshot> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CATEGORY_LIMIT) {
      throw new RangeError(`Jupiter market category limit must be between 1 and ${MAX_CATEGORY_LIMIT}`);
    }
    // Keep category calls sequential. The shared account-wide Jupiter FIFO can
    // then interleave a time-sensitive quote between these background reads.
    const traded24h = await this.fetchCategory(
      CATEGORY_PATHS.topTraded24h,
      limit,
      "top-traded 24h"
    );
    const traded6h = await this.fetchCategory(
      CATEGORY_PATHS.topTraded6h,
      limit,
      "top-traded 6h"
    );
    const traded1h = await this.fetchCategory(
      CATEGORY_PATHS.topTraded1h,
      limit,
      "top-traded 1h"
    );
    const trending6h = await this.fetchCategory(
      CATEGORY_PATHS.topTrending6h,
      limit,
      "top-trending 6h"
    );
    const trending1h = await this.fetchCategory(
      CATEGORY_PATHS.topTrending1h,
      limit,
      "top-trending 1h"
    );
    const organic5m = await this.fetchCategory(
      CATEGORY_PATHS.topOrganicScore5m,
      limit,
      "top-organic-score 5m"
    );
    const organic1h = await this.fetchCategory(
      CATEGORY_PATHS.topOrganicScore1h,
      limit,
      "top-organic-score 1h"
    );
    const categories = [traded24h, traded6h, traded1h, trending6h, trending1h, organic5m, organic1h];
    const diagnostics: JupiterMarketUniverseDiagnostics = {
      receivedRows: categories.reduce((total, category) => total + category.receivedRows, 0),
      acceptedRows: categories.reduce((total, category) => total + category.rows.length, 0),
      quarantinedRows: categories.reduce(
        (total, category) => total + category.quarantinedRows,
        0
      )
    };
    const merged = new Map<string, JupiterMarketTokenSnapshot>();
    const add = (
      token: JupiterMarketTokenSnapshot,
      ranks: JupiterMarketCategoryRanks
    ): void => {
      const ranked = { ...token, categoryRanks: ranks };
      const existing = merged.get(token.mint);
      merged.set(token.mint, existing ? mergeToken(existing, ranked) : ranked);
    };
    traded24h.rows.forEach(({ token, rank }) => add(token, { topTraded24h: rank }));
    traded6h.rows.forEach(({ token, rank }) => add(token, { topTraded6h: rank }));
    traded1h.rows.forEach(({ token, rank }) => add(token, { topTraded1h: rank }));
    trending6h.rows.forEach(({ token, rank }) => add(token, { topTrending6h: rank }));
    trending1h.rows.forEach(({ token, rank }) => add(token, { topTrending1h: rank }));
    organic5m.rows.forEach(({ token, rank }) => add(token, { topOrganicScore5m: rank }));
    organic1h.rows.forEach(({ token, rank }) => add(token, { topOrganicScore1h: rank }));
    if (merged.size === 0) {
      throw new Error(
        "Jupiter Markets market categories returned no usable valid tokens " +
        `(${diagnostics.quarantinedRows} malformed of ${diagnostics.receivedRows} rows quarantined)`
      );
    }
    return {
      capturedAt: this.now().toISOString(),
      tokens: [...merged.values()],
      diagnostics
    };
  }

  /**
   * Resolve exact mints in batches of 100, preserving first-seen input order.
   * Any omitted or unexpected mint fails the entire lookup closed.
   */
  async lookupMints(mints: readonly PublicKeyString[]): Promise<JupiterMarketTokenSnapshot[]> {
    const requested = [...new Set(mints)];
    if (requested.some((mint) => typeof mint !== "string" || mint.length === 0)) {
      throw new Error("Jupiter exact-mint lookup requires non-empty mint addresses");
    }
    if (requested.length === 0) return [];

    const results = new Map<string, JupiterMarketTokenSnapshot>();
    for (let offset = 0; offset < requested.length; offset += MAX_SEARCH_MINTS) {
      const chunk = requested.slice(offset, offset + MAX_SEARCH_MINTS);
      const url = this.url(SEARCH_PATH);
      url.searchParams.set("query", chunk.join(","));
      const payload = await this.request(url, SEARCH_PATH);
      const tokens = parseArray(payload, "exact-mint search");
      const expected = new Set(chunk);
      for (const token of tokens) {
        if (!expected.has(token.mint)) {
          throw new Error("Jupiter Markets exact-mint search returned an unexpected mint");
        }
        if (results.has(token.mint)) {
          throw new Error("Jupiter Markets exact-mint search returned a duplicate mint");
        }
        results.set(token.mint, token);
      }
      if (chunk.some((mint) => !results.has(mint))) {
        throw new Error("Jupiter Markets exact-mint search omitted a requested mint");
      }
    }
    return requested.map((mint) => results.get(mint) as JupiterMarketTokenSnapshot);
  }

  async checkHealth(): Promise<ProviderHealth> {
    const startedAt = Date.now();
    try {
      const universe = await this.fetchSignalUniverse(1);
      const quarantinedRows = universe.diagnostics?.quarantinedRows ?? 0;
      return {
        provider: "jupiter",
        ok: true,
        checkedAt: this.now().toISOString(),
        latencyMs: Date.now() - startedAt,
        message: quarantinedRows > 0
          ? "Jupiter Tokens V2 market categories are reachable with " +
            `${quarantinedRows} malformed row${quarantinedRows === 1 ? "" : "s"} quarantined`
          : "Jupiter Tokens V2 market categories are reachable and authenticated"
      };
    } catch (error) {
      return {
        provider: "jupiter",
        ok: false,
        checkedAt: this.now().toISOString(),
        latencyMs: Date.now() - startedAt,
        message: error instanceof Error
          ? error.message
          : "Jupiter Tokens V2 market category diagnostics failed"
      };
    }
  }

  private async fetchCategory(
    path: string,
    limit: number,
    operation: string
  ): Promise<ParsedCategory> {
    const url = this.url(path);
    url.searchParams.set("limit", String(limit));
    return parseCategoryArray(await this.request(url, path), operation);
  }

  private url(path: string): URL {
    return new URL(`${this.baseUrl}${path}`);
  }

  private async request(url: URL, metricPath: string): Promise<unknown> {
    for (let attempt = 0; ; attempt += 1) {
      this.onRequest?.({ path: metricPath, requests: 1 });
      try {
        return await requestJson<unknown>(url, {
          headers: { "x-api-key": this.apiKey, accept: "application/json" }
        }, {
          provider: "Jupiter Markets",
          fetch: this.fetch,
          timeoutMs: this.timeoutMs
        });
      } catch (error) {
        const transient = error instanceof ProviderApiError &&
          error.retryable && error.status !== 429;
        if (!transient || attempt >= this.maximumTransientRetries) throw error;
        await this.sleep(this.retryBaseMs * 2 ** attempt);
      }
    }
  }
}
