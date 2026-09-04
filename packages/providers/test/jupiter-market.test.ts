import { TOKEN_PROGRAM_ID } from "@copylab/shared";
import { describe, expect, it, vi } from "vitest";
import {
  JupiterMarketDataProvider,
  type JupiterMarketRequestUsage
} from "../src/jupiter-market.js";
import { jsonResponse, mockFetch } from "./helpers.js";

const MINT_A = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const MINT_B = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
const MINT_C = "MintC111111111111111111111111111111111111111";

function stats(overrides: Record<string, unknown> = {}) {
  return {
    priceChange: 2.5,
    liquidityChange: 1.25,
    volumeChange: 8,
    buyVolume: 250_000,
    sellVolume: 180_000,
    buyOrganicVolume: 40_000,
    sellOrganicVolume: 20_000,
    numBuys: 1_000,
    numSells: 800,
    numTraders: 500,
    numOrganicBuyers: 75,
    numNetBuyers: 125,
    ...overrides
  };
}

function token(
  mint: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: mint,
    name: `Token ${mint.slice(0, 4)}`,
    symbol: mint.slice(0, 4).toUpperCase(),
    icon: "https://assets.example.test/token.png",
    decimals: 6,
    tokenProgram: TOKEN_PROGRAM_ID,
    createdAt: "2025-01-01T00:00:00Z",
    dev: "Dev111111111111111111111111111111111111111",
    launchpad: "launchpad",
    partnerConfig: null,
    graduatedPool: null,
    graduatedAt: null,
    mintAuthority: null,
    freezeAuthority: null,
    circSupply: 75_000_000,
    totalSupply: 100_000_000,
    firstPool: {
      id: "Pool11111111111111111111111111111111111111",
      createdAt: "2025-01-02T00:00:00Z"
    },
    holderCount: 25_000,
    fdv: 20_000_000,
    mcap: 15_000_000,
    usdPrice: 0.2,
    priceBlockId: 350_000_000,
    liquidity: 2_000_000,
    stats5m: stats(),
    stats1h: stats({ priceChange: 7, buyVolume: 1_500_000, sellVolume: 900_000 }),
    stats6h: stats({ priceChange: 12 }),
    stats24h: stats({ priceChange: 25, buyVolume: 8_000_000, sellVolume: 7_000_000 }),
    audit: {
      isSus: false,
      topHoldersPercentage: 20
    },
    organicScore: 88,
    organicScoreLabel: "high",
    isVerified: true,
    tags: ["Verified", "Community"],
    updatedAt: "2026-07-14T10:00:00Z",
    ...overrides
  };
}

describe("JupiterMarketDataProvider", () => {
  it("sequentially unions all seven signal categories, preserves every rank, and prefers fresher overlap data", async () => {
    const usage: JupiterMarketRequestUsage[] = [];
    const requests: Array<{ path: string; method: string | undefined }> = [];
    const provider = new JupiterMarketDataProvider("key", {
      now: () => new Date("2026-07-14T10:05:00Z"),
      onRequest: (entry) => usage.push(entry),
      fetch: mockFetch((url, init) => {
        requests.push({ path: url.pathname, method: init?.method });
        expect(url.searchParams.get("limit")).toBe("2");
        if (url.pathname === "/tokens/v2/toptraded/24h") {
          return jsonResponse([
            token(MINT_A),
            token(MINT_B, { updatedAt: "2026-07-14T09:59:00Z", usdPrice: 1 })
          ]);
        }
        if (url.pathname === "/tokens/v2/toptraded/6h") {
          return jsonResponse([token(MINT_A), token(MINT_C)]);
        }
        if (url.pathname === "/tokens/v2/toptraded/1h") {
          return jsonResponse([
            token(MINT_A),
            token(MINT_C, { updatedAt: "2026-07-14T10:02:00Z", usdPrice: 0.15 })
          ]);
        }
        if (url.pathname === "/tokens/v2/toptrending/6h") {
          return jsonResponse([token(MINT_B), token(MINT_A)]);
        }
        if (url.pathname === "/tokens/v2/toptrending/1h") {
          return jsonResponse([
            token(MINT_B, {
              updatedAt: "2026-07-14T10:01:00Z",
              priceBlockId: 350_000_100,
              usdPrice: 1.25
            }),
            token(MINT_C, { updatedAt: "2026-07-14T09:58:00Z", usdPrice: 0.1 })
          ]);
        }
        if (url.pathname === "/tokens/v2/toporganicscore/5m") {
          return jsonResponse([
            token(MINT_C, { updatedAt: "2026-07-14T10:02:00Z", usdPrice: 0.15 }),
            token(MINT_A)
          ]);
        }
        if (url.pathname === "/tokens/v2/toporganicscore/1h") {
          return jsonResponse([
            token(MINT_B, { updatedAt: "2026-07-14T10:01:00Z", usdPrice: 1.25 }),
            token(MINT_C, { updatedAt: "2026-07-14T10:02:00Z", usdPrice: 0.15 })
          ]);
        }
        throw new Error(`unexpected path ${url.pathname}`);
      })
    });

    const snapshot = await provider.fetchSignalUniverse(2);

    expect(snapshot.capturedAt).toBe("2026-07-14T10:05:00.000Z");
    expect(snapshot.tokens).toHaveLength(3);
    expect(snapshot.tokens.find((entry) => entry.mint === MINT_A)).toMatchObject({
      priceUsd: 0.2,
      verified: true,
      tags: ["verified", "community"],
      suspicious: false,
      mintAuthorityDisabled: true,
      freezeAuthorityDisabled: true,
      topHoldersPercent: 20,
      categoryRanks: {
        topTraded24h: 1,
        topTraded6h: 1,
        topTraded1h: 1,
        topTrending6h: 2,
        topOrganicScore5m: 2
      },
      stats5m: {
        priceChange: 2.5,
        buyOrganicVolume: 40_000,
        numOrganicBuyers: 75
      }
    });
    expect(snapshot.tokens.find((entry) => entry.mint === MINT_B)).toMatchObject({
      priceUsd: 1.25,
      priceBlockId: 350_000_100,
      updatedAt: "2026-07-14T10:01:00.000Z",
      categoryRanks: {
        topTraded24h: 2,
        topTrending6h: 1,
        topTrending1h: 1,
        topOrganicScore1h: 1
      }
    });
    expect(snapshot.tokens.find((entry) => entry.mint === MINT_C)).toMatchObject({
      priceUsd: 0.15,
      updatedAt: "2026-07-14T10:02:00.000Z",
      categoryRanks: {
        topTraded1h: 2,
        topTraded6h: 2,
        topTrending1h: 2,
        topOrganicScore5m: 1,
        topOrganicScore1h: 2
      }
    });
    expect(usage).toEqual(expect.arrayContaining([
      { path: "/tokens/v2/toptraded/24h", requests: 1 },
      { path: "/tokens/v2/toptraded/6h", requests: 1 },
      { path: "/tokens/v2/toptraded/1h", requests: 1 },
      { path: "/tokens/v2/toptrending/6h", requests: 1 },
      { path: "/tokens/v2/toptrending/1h", requests: 1 },
      { path: "/tokens/v2/toporganicscore/5m", requests: 1 },
      { path: "/tokens/v2/toporganicscore/1h", requests: 1 }
    ]));
    expect(requests).toEqual(expect.arrayContaining([
      { path: "/tokens/v2/toptraded/24h", method: undefined },
      { path: "/tokens/v2/toptraded/6h", method: undefined },
      { path: "/tokens/v2/toptraded/1h", method: undefined },
      { path: "/tokens/v2/toptrending/6h", method: undefined },
      { path: "/tokens/v2/toptrending/1h", method: undefined },
      { path: "/tokens/v2/toporganicscore/5m", method: undefined },
      { path: "/tokens/v2/toporganicscore/1h", method: undefined }
    ]));
    expect(requests.map(({ path }) => path)).toEqual([
      "/tokens/v2/toptraded/24h",
      "/tokens/v2/toptraded/6h",
      "/tokens/v2/toptraded/1h",
      "/tokens/v2/toptrending/6h",
      "/tokens/v2/toptrending/1h",
      "/tokens/v2/toporganicscore/5m",
      "/tokens/v2/toporganicscore/1h"
    ]);
    expect("execute" in provider).toBe(false);
  });

  it("quarantines malformed category rows while preserving valid tokens and upstream ranks", async () => {
    const provider = new JupiterMarketDataProvider("key", {
      now: () => new Date("2026-07-14T10:05:00Z"),
      fetch: mockFetch(() => jsonResponse([
        token(MINT_A, { symbol: null }),
        token(MINT_B)
      ]))
    });

    const snapshot = await provider.fetchSignalUniverse(2);

    expect(snapshot.tokens).toHaveLength(1);
    expect(snapshot.tokens[0]).toMatchObject({
      mint: MINT_B,
      categoryRanks: {
        topTraded24h: 2,
        topTraded6h: 2,
        topTraded1h: 2,
        topTrending6h: 2,
        topTrending1h: 2,
        topOrganicScore5m: 2,
        topOrganicScore1h: 2
      }
    });
    expect(snapshot.diagnostics).toEqual({
      receivedRows: 14,
      acceptedRows: 7,
      quarantinedRows: 7
    });
    expect(snapshot.tokens.some((entry) => entry.mint === MINT_A)).toBe(false);
  });

  it("fails health and universe discovery when every category row is malformed", async () => {
    const provider = new JupiterMarketDataProvider("key", {
      fetch: mockFetch(() => jsonResponse([token(MINT_A, { symbol: null })]))
    });

    await expect(provider.fetchSignalUniverse(1)).rejects.toThrow(
      "no usable valid tokens (7 malformed of 7 rows quarantined)"
    );
    await expect(provider.checkHealth()).resolves.toMatchObject({
      provider: "jupiter",
      ok: false,
      message: expect.stringContaining("no usable valid tokens")
    });
  });

  it("keeps exact-mint safety lookup fail-closed on an invalid symbol", async () => {
    const provider = new JupiterMarketDataProvider("key", {
      fetch: mockFetch(() => jsonResponse([token(MINT_A, { symbol: null })]))
    });

    await expect(provider.lookupMints([MINT_A]))
      .rejects.toThrow("Jupiter Markets response contained invalid symbol");
  });

  it("resolves exact mints in batches of 100, deduplicates input, and preserves order", async () => {
    const mints = Array.from({ length: 101 }, (_, index) => `Mint${String(index).padStart(40, "0")}`);
    const paths: string[] = [];
    const provider = new JupiterMarketDataProvider("key", {
      onRequest: ({ path }) => paths.push(path),
      fetch: mockFetch((url, init) => {
        expect(url.pathname).toBe("/tokens/v2/search");
        expect(init?.method).toBeUndefined();
        const requested = url.searchParams.get("query")?.split(",") ?? [];
        expect(requested.length).toBeLessThanOrEqual(100);
        return jsonResponse(requested.map((mint) => token(mint)));
      })
    });

    const resolved = await provider.lookupMints([mints[100]!, ...mints, mints[0]!]);

    expect(resolved).toHaveLength(101);
    expect(resolved[0]?.mint).toBe(mints[100]);
    expect(resolved[1]?.mint).toBe(mints[0]);
    expect(paths).toEqual(["/tokens/v2/search", "/tokens/v2/search"]);
  });

  it("preserves schema-defined null evidence as missing instead of safe-looking zeroes", async () => {
    const provider = new JupiterMarketDataProvider("key", {
      fetch: mockFetch(() => jsonResponse([token(MINT_A, {
        firstPool: null,
        holderCount: null,
        fdv: null,
        mcap: null,
        usdPrice: null,
        priceBlockId: null,
        liquidity: null,
        stats5m: stats({ buyOrganicVolume: null }),
        stats6h: null,
        tags: null,
        isVerified: null,
        audit: null,
        mintAuthority: undefined,
        freezeAuthority: undefined
      })]))
    });

    const [result] = await provider.lookupMints([MINT_A]);
    if (!result) throw new Error("Expected the exact-mint fixture to be returned.");

    expect(result).toMatchObject({
      mint: MINT_A,
      verified: false,
      tags: [],
      suspicious: false,
      mintAuthorityDisabled: false,
      freezeAuthorityDisabled: false,
      categoryRanks: {}
    });
    expect(result).not.toHaveProperty("firstPoolAt");
    expect(result).not.toHaveProperty("holderCount");
    expect(result).not.toHaveProperty("liquidityUsd");
    expect(result).not.toHaveProperty("stats6h");
    expect(result.stats5m).not.toHaveProperty("buyOrganicVolume");
  });

  it("uses explicit suspicious evidence without requiring the currently omitted isSus field", async () => {
    const provider = new JupiterMarketDataProvider("key", {
      fetch: mockFetch((url) => {
        const requested = url.searchParams.get("query")?.split(",") ?? [];
        return jsonResponse(requested.map((mint) => token(mint, mint === MINT_A
          ? { audit: { topHoldersPercentage: 20 } }
          : { audit: { topHoldersPercentage: 20 }, tags: ["verified", "scam"] }
        )));
      })
    });

    const [clean, tagged] = await provider.lookupMints([MINT_A, MINT_B]);
    expect(clean?.suspicious).toBe(false);
    expect(tagged?.suspicious).toBe(true);
  });

  it("fails closed on malformed stats, category limits, missing mints, and identity conflicts", async () => {
    const malformedStats = new JupiterMarketDataProvider("key", {
      fetch: mockFetch(() => jsonResponse([token(MINT_A, {
        stats5m: stats({ numNetBuyers: -1 })
      })]))
    });
    await expect(malformedStats.lookupMints([MINT_A]))
      .rejects.toThrow("invalid stats5m.numNetBuyers");
    await expect(malformedStats.fetchSignalUniverse(0))
      .rejects.toThrow("limit must be between 1 and 100");

    const missing = new JupiterMarketDataProvider("key", {
      fetch: mockFetch(() => jsonResponse([]))
    });
    await expect(missing.lookupMints([MINT_A]))
      .rejects.toThrow("omitted a requested mint");

    const conflicting = new JupiterMarketDataProvider("key", {
      fetch: mockFetch((url) => url.pathname.includes("toptraded")
        ? jsonResponse([token(MINT_A)])
        : jsonResponse([token(MINT_A, { decimals: 9 })]))
    });
    await expect(conflicting.fetchSignalUniverse())
      .rejects.toThrow("conflicting category token identity");
  });

  it("rejects unexpected exact-search rows and redacts API credentials from provider errors", async () => {
    const unexpected = new JupiterMarketDataProvider("key", {
      fetch: mockFetch(() => jsonResponse([token(MINT_B)]))
    });
    await expect(unexpected.lookupMints([MINT_A]))
      .rejects.toThrow("returned an unexpected mint");

    const secret = "jup_super_secret_1234567890123456789012345678901234567890";
    const failed = new JupiterMarketDataProvider(secret, {
      fetch: mockFetch(() => jsonResponse({
        error: `authorization x-api-key=${secret} was rejected`
      }, 401))
    });
    let message = "";
    try {
      await failed.lookupMints([MINT_A]);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("Jupiter Markets");
    expect(message).toContain("HTTP 401");
    expect(message).not.toContain(secret);
  });

  it("does not meter or call Jupiter when an exact lookup is empty", async () => {
    const onRequest = vi.fn();
    const fetch = vi.fn();
    const provider = new JupiterMarketDataProvider("key", {
      onRequest,
      fetch: fetch as never
    });

    await expect(provider.lookupMints([])).resolves.toEqual([]);
    expect(onRequest).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("retries one transient market read without multiplying account-wide 429 handling", async () => {
    const sleep = vi.fn(async () => undefined);
    const onRequest = vi.fn();
    let attempts = 0;
    const provider = new JupiterMarketDataProvider("key", {
      retryBaseMs: 500,
      sleep,
      onRequest,
      fetch: mockFetch(() => {
        attempts += 1;
        return attempts === 1
          ? jsonResponse({ error: "temporary upstream failure" }, 503)
          : jsonResponse([token(MINT_A)]);
      })
    });

    await expect(provider.lookupMints([MINT_A])).resolves.toEqual([
      expect.objectContaining({ mint: MINT_A })
    ]);
    expect(attempts).toBe(2);
    expect(onRequest).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(500);

    let rateLimitedAttempts = 0;
    const rateLimited = new JupiterMarketDataProvider("key", {
      sleep,
      fetch: mockFetch(() => {
        rateLimitedAttempts += 1;
        return jsonResponse({ error: "rate limited" }, 429);
      })
    });
    await expect(rateLimited.lookupMints([MINT_A])).rejects.toMatchObject({ status: 429 });
    expect(rateLimitedAttempts).toBe(1);
  });

  it("includes all autonomous market categories in provider health", async () => {
    const paths: string[] = [];
    const provider = new JupiterMarketDataProvider("key", {
      fetch: mockFetch((url) => {
        paths.push(url.pathname);
        return jsonResponse([token(MINT_A)]);
      })
    });

    await expect(provider.checkHealth()).resolves.toMatchObject({
      provider: "jupiter",
      ok: true,
      message: expect.stringContaining("market categories")
    });
    expect(paths).toEqual(expect.arrayContaining([
      "/tokens/v2/toptraded/24h",
      "/tokens/v2/toptraded/6h",
      "/tokens/v2/toptraded/1h",
      "/tokens/v2/toptrending/6h",
      "/tokens/v2/toptrending/1h",
      "/tokens/v2/toporganicscore/5m",
      "/tokens/v2/toporganicscore/1h"
    ]));
  });
});
