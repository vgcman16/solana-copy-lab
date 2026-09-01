import { TOKEN_PROGRAM_ID } from "@copylab/shared";
import { describe, expect, it } from "vitest";
import { JupiterTokenRiskProvider } from "../src/jupiter-token.js";
import { jsonResponse, mockFetch } from "./helpers.js";

const MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

function eligibleToken(overrides: Record<string, unknown> = {}) {
  return {
    id: MINT,
    name: "Bonk",
    symbol: "BONK",
    decimals: 5,
    tokenProgram: TOKEN_PROGRAM_ID,
    firstPool: { id: "pool", createdAt: "2024-01-01T00:00:00Z" },
    holderCount: 100_000,
    audit: {
      mintAuthorityDisabled: true,
      freezeAuthorityDisabled: true,
      topHoldersPercentage: 12
    },
    organicScore: 91,
    isVerified: true,
    tags: ["verified", "strict"],
    liquidity: 10_000_000,
    stats24h: { buyVolume: 700_000, sellVolume: 600_000 },
    ...overrides
  };
}

describe("JupiterTokenRiskProvider", () => {
  it("maps exact Tokens V2 fields and passes the default policy", async () => {
    const provider = new JupiterTokenRiskProvider("key", {
      fetch: mockFetch((url) => {
        expect(url.pathname).toBe("/tokens/v2/search");
        expect(url.searchParams.get("query")).toBe(MINT);
        return jsonResponse([eligibleToken()]);
      })
    });
    const result = await provider.checkToken(MINT, new Date("2026-07-09T00:00:00Z"));
    expect(result).toMatchObject({
      eligible: true,
      reasons: [],
      decimals: 5,
      liquidityUsd: 10_000_000,
      volume24hUsd: 1_300_000,
      holderCount: 100_000,
      organicScore: 91,
      topHoldersPercent: 12,
      mintAuthorityDisabled: true,
      freezeAuthorityDisabled: true
    });
  });

  it("fails closed for suspicious Token-2022 assets and omitted audit controls", async () => {
    const provider = new JupiterTokenRiskProvider("key", {
      fetch: mockFetch(() => jsonResponse([eligibleToken({
        tokenProgram: "TokenzQdYh...",
        tags: ["banned"],
        audit: { isSus: true },
        firstPool: null
      })]))
    });
    const result = await provider.checkToken(MINT, new Date("2026-07-09T00:00:00Z"));
    expect(result.eligible).toBe(false);
    expect(result.reasons).toEqual(expect.arrayContaining([
      "SUSPICIOUS_OR_BANNED",
      "UNSUPPORTED_TOKEN_PROGRAM",
      "MINT_AUTHORITY_ENABLED_OR_UNKNOWN",
      "FREEZE_AUTHORITY_ENABLED_OR_UNKNOWN",
      "FIRST_POOL_UNKNOWN",
      "EXCESSIVE_TOP_HOLDER_CONCENTRATION"
    ]));
  });

  it("accepts explicit null top-level authorities when conditional audit flags are omitted", async () => {
    const provider = new JupiterTokenRiskProvider("key", {
      fetch: mockFetch(() => jsonResponse([eligibleToken({
        mintAuthority: null,
        freezeAuthority: null,
        audit: { topHoldersPercentage: 12 }
      })]))
    });
    const result = await provider.checkToken(MINT, new Date("2026-07-09T00:00:00Z"));
    expect(result.mintAuthorityDisabled).toBe(true);
    expect(result.freezeAuthorityDisabled).toBe(true);
    expect(result.eligible).toBe(true);
  });

  it("rejects a present authority even when the audit flag disagrees", async () => {
    const provider = new JupiterTokenRiskProvider("key", {
      fetch: mockFetch(() => jsonResponse([eligibleToken({
        mintAuthority: "Authority111111111111111111111111111111111",
        freezeAuthority: "Authority222222222222222222222222222222222"
      })]))
    });
    const result = await provider.checkToken(MINT, new Date("2026-07-09T00:00:00Z"));
    expect(result.mintAuthorityDisabled).toBe(false);
    expect(result.freezeAuthorityDisabled).toBe(false);
    expect(result.reasons).toEqual(expect.arrayContaining([
      "MINT_AUTHORITY_ENABLED_OR_UNKNOWN",
      "FREEZE_AUTHORITY_ENABLED_OR_UNKNOWN"
    ]));
  });

  it("returns a stable ineligible result when exact mint search has no match", async () => {
    const provider = new JupiterTokenRiskProvider("key", {
      fetch: mockFetch(() => jsonResponse([{ ...eligibleToken(), id: "another-mint" }]))
    });
    await expect(provider.checkToken(MINT)).resolves.toMatchObject({
      mint: MINT,
      eligible: false,
      reasons: ["TOKEN_NOT_FOUND"]
    });
  });
});
