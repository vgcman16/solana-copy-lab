import {
  DEFAULT_TOKEN_POLICY,
  SOL_MINT,
  TOKEN_PROGRAM_ID,
  type ProviderHealth,
  type PublicKeyString,
  type TokenEligibility,
  type TokenPolicy,
  type TokenRiskProvider
} from "@copylab/shared";
import {
  asRecord,
  errorMessage,
  finiteNumber,
  nonNegativeNumber,
  requestJson,
  stringValue,
  type FetchLike
} from "./http.js";

export type TokenRejectionReason =
  | "TOKEN_NOT_FOUND"
  | "NOT_VERIFIED"
  | "SUSPICIOUS_OR_BANNED"
  | "UNSUPPORTED_TOKEN_PROGRAM"
  | "MINT_AUTHORITY_ENABLED_OR_UNKNOWN"
  | "FREEZE_AUTHORITY_ENABLED_OR_UNKNOWN"
  | "FIRST_POOL_UNKNOWN"
  | "TOKEN_TOO_YOUNG"
  | "INSUFFICIENT_LIQUIDITY"
  | "INSUFFICIENT_24H_VOLUME"
  | "INSUFFICIENT_HOLDERS"
  | "LOW_ORGANIC_SCORE"
  | "EXCESSIVE_TOP_HOLDER_CONCENTRATION";

export interface JupiterTokenOptions {
  baseUrl?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  policy?: Partial<TokenPolicy>;
  now?: () => Date;
}

function tokenNotFound(mint: string, now: Date): TokenEligibility {
  return {
    mint,
    checkedAt: now.toISOString(),
    eligible: false,
    reasons: ["TOKEN_NOT_FOUND"],
    verified: false,
    suspicious: false,
    mintAuthorityDisabled: false,
    freezeAuthorityDisabled: false,
    liquidityUsd: 0,
    volume24hUsd: 0,
    holderCount: 0,
    organicScore: 0,
    topHoldersPercent: 100
  };
}

export class JupiterTokenRiskProvider implements TokenRiskProvider {
  private readonly baseUrl: string;
  private readonly fetch: FetchLike | undefined;
  private readonly timeoutMs: number;
  private readonly policy: TokenPolicy;
  private readonly now: () => Date;
  private requestCount = 0;

  constructor(
    private readonly apiKey: string,
    options: JupiterTokenOptions = {}
  ) {
    if (!apiKey.trim()) throw new Error("Jupiter API key is required");
    this.baseUrl = (options.baseUrl ?? "https://api.jup.ag").replace(/\/$/, "");
    this.fetch = options.fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.policy = { ...DEFAULT_TOKEN_POLICY, ...options.policy };
    this.now = options.now ?? (() => new Date());
  }

  async checkToken(mint: PublicKeyString, now = this.now()): Promise<TokenEligibility> {
    if (!mint) throw new Error("Jupiter token mint is required");
    const url = new URL(`${this.baseUrl}/tokens/v2/search`);
    url.searchParams.set("query", mint);
    this.requestCount += 1;
    const payload = await requestJson<unknown>(url, {
      headers: { "x-api-key": this.apiKey, accept: "application/json" }
    }, {
      provider: "Jupiter Tokens",
      fetch: this.fetch,
      timeoutMs: this.timeoutMs
    });

    if (!Array.isArray(payload)) {
      throw new Error("Jupiter Tokens search returned a non-array response");
    }
    const row = payload
      .map(asRecord)
      .find((token) => stringValue(token?.id) === mint);
    if (!row) return tokenNotFound(mint, now);

    const audit = asRecord(row.audit);
    const stats24h = asRecord(row.stats24h);
    const firstPool = asRecord(row.firstPool);
    const tags = Array.isArray(row.tags)
      ? row.tags.filter((tag): tag is string => typeof tag === "string").map((tag) => tag.toLowerCase())
      : [];
    const verified = row.isVerified === true;
    const suspicious =
      audit?.isSus === true ||
      tags.some((tag) => tag === "banned" || tag === "suspicious" || tag === "scam");
    const mintAuthorityDisabled = Object.hasOwn(row, "mintAuthority")
      ? row.mintAuthority === null
      : audit?.mintAuthorityDisabled === true;
    const freezeAuthorityDisabled = Object.hasOwn(row, "freezeAuthority")
      ? row.freezeAuthority === null
      : audit?.freezeAuthorityDisabled === true;
    const tokenProgram = stringValue(row.tokenProgram);
    const decimals = finiteNumber(row.decimals);
    const liquidityUsd = nonNegativeNumber(row.liquidity);
    const volume24hUsd =
      nonNegativeNumber(stats24h?.buyVolume) + nonNegativeNumber(stats24h?.sellVolume);
    const holderCount = nonNegativeNumber(row.holderCount);
    const organicScore = nonNegativeNumber(row.organicScore);
    const topHoldersPercent = finiteNumber(audit?.topHoldersPercentage) ?? 100;
    const firstPoolAt = stringValue(firstPool?.createdAt);
    const firstPoolTime = firstPoolAt ? Date.parse(firstPoolAt) : Number.NaN;
    const ageDays = Number.isFinite(firstPoolTime)
      ? (now.getTime() - firstPoolTime) / 86_400_000
      : Number.NaN;

    const reasons: TokenRejectionReason[] = [];
    if (this.policy.requireVerified && !verified) reasons.push("NOT_VERIFIED");
    if (suspicious) reasons.push("SUSPICIOUS_OR_BANNED");
    if (this.policy.requireStandardTokenProgram && tokenProgram !== TOKEN_PROGRAM_ID) {
      reasons.push("UNSUPPORTED_TOKEN_PROGRAM");
    }
    if (!mintAuthorityDisabled) reasons.push("MINT_AUTHORITY_ENABLED_OR_UNKNOWN");
    if (!freezeAuthorityDisabled) reasons.push("FREEZE_AUTHORITY_ENABLED_OR_UNKNOWN");
    if (!Number.isFinite(ageDays)) reasons.push("FIRST_POOL_UNKNOWN");
    else if (ageDays < this.policy.minimumAgeDays) reasons.push("TOKEN_TOO_YOUNG");
    if (liquidityUsd < this.policy.minimumLiquidityUsd) reasons.push("INSUFFICIENT_LIQUIDITY");
    if (volume24hUsd < this.policy.minimumVolume24hUsd) {
      reasons.push("INSUFFICIENT_24H_VOLUME");
    }
    if (holderCount < this.policy.minimumHolderCount) reasons.push("INSUFFICIENT_HOLDERS");
    if (organicScore < this.policy.minimumOrganicScore) reasons.push("LOW_ORGANIC_SCORE");
    if (topHoldersPercent > this.policy.maximumTopHoldersPercent) {
      reasons.push("EXCESSIVE_TOP_HOLDER_CONCENTRATION");
    }

    const result: TokenEligibility = {
      mint,
      checkedAt: now.toISOString(),
      eligible: reasons.length === 0,
      reasons,
      verified,
      suspicious,
      mintAuthorityDisabled,
      freezeAuthorityDisabled,
      liquidityUsd,
      volume24hUsd,
      holderCount,
      organicScore,
      topHoldersPercent
    };
    const name = stringValue(row.name);
    const symbol = stringValue(row.symbol);
    if (name) result.name = name;
    if (symbol) result.symbol = symbol;
    if (decimals !== undefined && Number.isInteger(decimals) && decimals >= 0) {
      result.decimals = decimals;
    }
    if (tokenProgram) result.tokenProgram = tokenProgram;
    if (firstPoolAt && Number.isFinite(firstPoolTime)) {
      result.firstPoolAt = new Date(firstPoolTime).toISOString();
    }
    return result;
  }

  async checkHealth(): Promise<ProviderHealth> {
    const startedAt = this.now().getTime();
    try {
      await this.checkToken(SOL_MINT);
      return {
        provider: "jupiter",
        ok: true,
        checkedAt: this.now().toISOString(),
        latencyMs: Math.max(0, this.now().getTime() - startedAt),
        message: "Jupiter Tokens V2 API is reachable and authenticated",
        usage: { requests: this.requestCount, window: "unknown" }
      };
    } catch (error) {
      return {
        provider: "jupiter",
        ok: false,
        checkedAt: this.now().toISOString(),
        latencyMs: Math.max(0, this.now().getTime() - startedAt),
        message: errorMessage(error),
        usage: { requests: this.requestCount, window: "unknown" }
      };
    }
  }
}
