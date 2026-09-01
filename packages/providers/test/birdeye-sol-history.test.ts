import { describe, expect, it } from "vitest";
import { SOL_MINT } from "@copylab/shared";
import {
  BIRDEYE_SOL_USD_HISTORY_PREVIOUS_5M_SOURCE,
  BIRDEYE_SOL_USD_HISTORY_SOURCE,
  BirdeyeSolUsdHistoryClient,
  BirdeyeSolUsdHistoryRequestError,
  BirdeyeSolUsdHistoryValidationError,
  ResilientSolUsdHistoryProvider,
  type SolUsdHistoricalPriceProvider
} from "../src/index.js";
import { jsonResponse, mockFetch } from "./helpers.js";

const START = 1_788_192_000;

function candle(timestamp: number, open = 150): Record<string, unknown> {
  return {
    address: SOL_MINT,
    type: "5m",
    currency: "usd",
    unix_time: timestamp,
    o: open,
    h: open + 2,
    l: open - 1,
    c: open + 1,
    v: 10_000
  };
}

describe("BirdeyeSolUsdHistoryClient", () => {
  it("loads a bounded authenticated page, uses the exact candle open, and caches later grid points", async () => {
    const requests: URL[] = [];
    const authorizations: Array<string | null> = [];
    const reservations: number[] = [];
    const client = new BirdeyeSolUsdHistoryClient("managed-birdeye-key", {
      maximumCandlesPerRequest: 5,
      minimumRequestIntervalMs: 0,
      onRequest: ({ credits }) => reservations.push(credits),
      fetch: mockFetch((url, init) => {
        requests.push(url);
        authorizations.push(new Headers(init?.headers).get("X-API-KEY"));
        return jsonResponse({
          success: true,
          data: {
            items: Array.from({ length: 5 }, (_, index) => candle(START + index * 300, 150 + index))
          }
        });
      })
    });

    await expect(client.getSolUsdPrice(START)).resolves.toEqual({
      source: BIRDEYE_SOL_USD_HISTORY_SOURCE,
      requestedTimestampSeconds: START,
      observationTimestampSeconds: START,
      priceUsd: 150,
      followingObservation: {
        source: BIRDEYE_SOL_USD_HISTORY_SOURCE,
        observationTimestampSeconds: START + 300,
        priceUsd: 151
      }
    });
    await expect(client.getSolUsdPrice(START + 600)).resolves.toMatchObject({ priceUsd: 152 });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.pathname).toBe("/defi/v3/ohlcv");
    expect(requests[0]?.searchParams.get("address")).toBe(SOL_MINT);
    expect(requests[0]?.searchParams.get("type")).toBe("5m");
    expect(requests[0]?.searchParams.get("time_from")).toBe(String(START));
    expect(requests[0]?.searchParams.get("time_to")).toBe(String(START + 4 * 300));
    expect(requests[0]?.searchParams.get("padding")).toBe("false");
    expect(authorizations).toEqual(["managed-birdeye-key"]);
    expect(reservations).toEqual([45]);
  });

  it("performs one focused three-candle fetch and prefers an exact candle recovered there", async () => {
    const requests: URL[] = [];
    let call = 0;
    const client = new BirdeyeSolUsdHistoryClient("managed-birdeye-key", {
      maximumCandlesPerRequest: 3,
      minimumRequestIntervalMs: 0,
      fetch: mockFetch((url) => {
        requests.push(url);
        call += 1;
        return jsonResponse({
          success: true,
          data: {
            items: call === 1
              ? [candle(START + 300, 151)]
              : [candle(START - 300, 149), candle(START, 150), candle(START + 300, 151)]
          }
        });
      })
    });
    await expect(client.getSolUsdPrice(START)).resolves.toEqual({
      source: BIRDEYE_SOL_USD_HISTORY_SOURCE,
      requestedTimestampSeconds: START,
      observationTimestampSeconds: START,
      priceUsd: 150,
      followingObservation: {
        source: BIRDEYE_SOL_USD_HISTORY_SOURCE,
        observationTimestampSeconds: START + 300,
        priceUsd: 151
      }
    });
    expect(requests).toHaveLength(2);
    expect(requests[1]?.searchParams.get("time_from")).toBe(String(START - 300));
    expect(requests[1]?.searchParams.get("time_to")).toBe(String(START + 300));
    expect(requests[1]?.searchParams.get("padding")).toBe("false");
  });

  it("uses the previous real candle when the focused neighborhood confirms the exact hole", async () => {
    const requests: URL[] = [];
    const reservations: number[] = [];
    let call = 0;
    const client = new BirdeyeSolUsdHistoryClient("managed-birdeye-key", {
      maximumCandlesPerRequest: 3,
      minimumRequestIntervalMs: 0,
      onRequest: ({ credits }) => reservations.push(credits),
      fetch: mockFetch((url) => {
        requests.push(url);
        call += 1;
        return jsonResponse({
          success: true,
          data: {
            items: call === 1
              ? [candle(START + 300, 151)]
              : [candle(START - 300, 149), candle(START + 300, 151)]
          }
        });
      })
    });
    await expect(client.getSolUsdPrice(START)).resolves.toEqual({
      source: BIRDEYE_SOL_USD_HISTORY_PREVIOUS_5M_SOURCE,
      requestedTimestampSeconds: START,
      observationTimestampSeconds: START - 300,
      priceUsd: 149,
      followingObservation: {
        source: BIRDEYE_SOL_USD_HISTORY_SOURCE,
        observationTimestampSeconds: START + 300,
        priceUsd: 151
      }
    });
    expect(requests[1]?.searchParams.get("time_from")).toBe(String(START - 300));
    expect(requests[1]?.searchParams.get("time_to")).toBe(String(START + 300));
    expect(reservations).toEqual([45, 45]);
  });

  it("uses only one focused request when a prior broad page already proves the omission", async () => {
    const requests: URL[] = [];
    let call = 0;
    const target = START + 600;
    const client = new BirdeyeSolUsdHistoryClient("managed-birdeye-key", {
      maximumCandlesPerRequest: 5,
      minimumRequestIntervalMs: 0,
      fetch: mockFetch((url) => {
        requests.push(url);
        call += 1;
        return jsonResponse({
          success: true,
          data: {
            items: call === 1
              ? [
                  candle(START, 150),
                  candle(START + 300, 151),
                  candle(START + 900, 153),
                  candle(START + 1_200, 154)
                ]
              : [candle(target - 300, 151), candle(target + 300, 153)]
          }
        });
      })
    });

    await expect(client.getSolUsdPrice(START)).resolves.toMatchObject({ priceUsd: 150 });
    await expect(client.getSolUsdPrice(target)).resolves.toMatchObject({
      source: BIRDEYE_SOL_USD_HISTORY_PREVIOUS_5M_SOURCE,
      observationTimestampSeconds: target - 300,
      priceUsd: 151
    });
    expect(requests).toHaveLength(2);
    expect(requests[1]?.searchParams.get("time_from")).toBe(String(target - 300));
    expect(requests[1]?.searchParams.get("time_to")).toBe(String(target + 300));
  });

  it("accepts only the real previous five-minute candle under distinct provenance", async () => {
    let call = 0;
    const client = new BirdeyeSolUsdHistoryClient("managed-birdeye-key", {
      maximumCandlesPerRequest: 3,
      minimumRequestIntervalMs: 0,
      fetch: mockFetch(() => {
        call += 1;
        return jsonResponse({
          success: true,
          data: { items: call === 1 ? [] : [candle(START - 300, 149)] }
        });
      })
    });
    await expect(client.getSolUsdPrice(START)).resolves.toEqual({
      source: BIRDEYE_SOL_USD_HISTORY_PREVIOUS_5M_SOURCE,
      requestedTimestampSeconds: START,
      observationTimestampSeconds: START - 300,
      priceUsd: 149
    });
  });

  it("rejects a future-only focused neighborhood rather than looking ahead", async () => {
    const client = new BirdeyeSolUsdHistoryClient("managed-birdeye-key", {
      maximumCandlesPerRequest: 3,
      minimumRequestIntervalMs: 0,
      fetch: mockFetch(() => jsonResponse({
        success: true,
        data: { items: [candle(START + 300)] }
      }))
    });
    const error = await client.getSolUsdPrice(START).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BirdeyeSolUsdHistoryValidationError);
    expect(error).toMatchObject({ code: "TARGET_MISSING" });
  });

  it("rejects an older-only focused response rather than extending the lookback", async () => {
    let call = 0;
    const client = new BirdeyeSolUsdHistoryClient("managed-birdeye-key", {
      maximumCandlesPerRequest: 3,
      minimumRequestIntervalMs: 0,
      fetch: mockFetch(() => {
        call += 1;
        return jsonResponse({
          success: true,
          data: { items: call === 1 ? [] : [candle(START - 600)] }
        });
      })
    });
    await expect(client.getSolUsdPrice(START)).rejects.toMatchObject({ code: "CANDLE_TIME" });
  });

  it("reserves the documented worst-case 100 CU before a 4,800-candle page", async () => {
    const reservations: number[] = [];
    const client = new BirdeyeSolUsdHistoryClient("managed-birdeye-key", {
      maximumCandlesPerRequest: 4_800,
      minimumRequestIntervalMs: 0,
      onRequest: ({ credits }) => reservations.push(credits),
      fetch: mockFetch(() => jsonResponse({
        success: true,
        data: { items: [candle(START)] }
      }))
    });
    await expect(client.getSolUsdPrice(START)).resolves.toMatchObject({ priceUsd: 150 });
    expect(reservations).toEqual([100]);
  });

  it("rejects impossible OHLC evidence and redacts request failures", async () => {
    const malformed = new BirdeyeSolUsdHistoryClient("managed-birdeye-key", {
      maximumCandlesPerRequest: 3,
      minimumRequestIntervalMs: 0,
      fetch: mockFetch(() => jsonResponse({
        success: true,
        data: { items: [{ ...candle(START), h: 149 }] }
      }))
    });
    await expect(malformed.getSolUsdPrice(START)).rejects.toMatchObject({ code: "CANDLE_PRICE" });

    const failed = new BirdeyeSolUsdHistoryClient("managed-birdeye-key", {
      maximumCandlesPerRequest: 3,
      minimumRequestIntervalMs: 0,
      fetch: mockFetch(() => jsonResponse({ detail: "managed-birdeye-key" }, 401))
    });
    const error = await failed.getSolUsdPrice(START).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BirdeyeSolUsdHistoryRequestError);
    expect(error).toMatchObject({ status: 401, retryable: false });
    expect(String(error)).not.toContain("managed-birdeye-key");
  });
});

describe("ResilientSolUsdHistoryProvider", () => {
  function provider(input: {
    authenticated: boolean;
    source: "pyth_benchmarks" | "birdeye_ohlcv_v3";
    result?: number;
    failure?: Error;
  }): SolUsdHistoricalPriceProvider {
    return {
      authenticationConfigured: input.authenticated,
      pythAuthenticationConfigured: input.source === "pyth_benchmarks" && input.authenticated,
      fallbackConfigured: input.source === "birdeye_ohlcv_v3" && input.authenticated,
      activeSource: input.source,
      async getSolUsdPrice(timestampSeconds) {
        if (input.failure) throw input.failure;
        return {
          source: input.source,
          requestedTimestampSeconds: timestampSeconds,
          observationTimestampSeconds: timestampSeconds,
          priceUsd: input.result ?? 150
        };
      }
    };
  }

  it("uses the managed fallback directly when no Pyth bearer is configured", async () => {
    const reasons: string[] = [];
    const resilient = new ResilientSolUsdHistoryProvider(
      provider({ authenticated: false, source: "pyth_benchmarks", failure: new Error("must not run") }),
      provider({ authenticated: true, source: "birdeye_ohlcv_v3", result: 151 }),
      { onFallback: (reason) => reasons.push(reason) }
    );
    await expect(resilient.getSolUsdPrice(START)).resolves.toMatchObject({
      source: "birdeye_ohlcv_v3",
      priceUsd: 151
    });
    await expect(resilient.getSolUsdPrice(START + 600)).resolves.toMatchObject({ priceUsd: 151 });
    expect(resilient.activeSource).toBe("birdeye_ohlcv_v3");
    expect(reasons).toEqual(["PRIMARY_NOT_CONFIGURED"]);
  });

  it("prefers authenticated Pyth but requires independent valid fallback evidence after failure", async () => {
    const reasons: string[] = [];
    let primaryCalls = 0;
    const primary = provider({
      authenticated: true,
      source: "pyth_benchmarks",
      failure: new Error("provider failed")
    });
    const requestPrimary = primary.getSolUsdPrice.bind(primary);
    primary.getSolUsdPrice = async (timestampSeconds) => {
      primaryCalls += 1;
      return requestPrimary(timestampSeconds);
    };
    const resilient = new ResilientSolUsdHistoryProvider(
      primary,
      provider({ authenticated: true, source: "birdeye_ohlcv_v3", result: 152 }),
      { onFallback: (reason) => reasons.push(reason) }
    );
    await expect(resilient.getSolUsdPrice(START)).resolves.toMatchObject({
      source: "birdeye_ohlcv_v3",
      priceUsd: 152
    });
    await expect(resilient.getSolUsdPrice(START + 600)).resolves.toMatchObject({ priceUsd: 152 });
    expect(primaryCalls).toBe(1);
    expect(reasons).toEqual(["PRIMARY_FAILED"]);
  });
});
