import { describe, expect, it } from "vitest";
import {
  PYTH_SOL_USD_FEED_ID,
  PythBenchmarksClient,
  PythBenchmarksRequestError,
  PythBenchmarksValidationError
} from "../src/pyth-benchmarks.js";
import { jsonResponse, mockFetch } from "./helpers.js";

const TIMESTAMP = 1_783_667_400;

function validResponse(overrides: {
  id?: unknown;
  price?: unknown;
  conf?: unknown;
  expo?: unknown;
  publishTime?: unknown;
  parsed?: unknown;
} = {}): unknown {
  if ("parsed" in overrides) return { parsed: overrides.parsed };
  return {
    binary: { encoding: "base64", data: ["ignored"] },
    parsed: {
      id: overrides.id ?? PYTH_SOL_USD_FEED_ID,
      price: "price" in overrides ? overrides.price : {
        price: "7889501505",
        conf: overrides.conf ?? "5446245",
        expo: overrides.expo ?? -8,
        publish_time: overrides.publishTime ?? TIMESTAMP
      },
      ema_price: {}
    }
  };
}

describe("PythBenchmarksClient", () => {
  it("requests the official SOL/USD feed with optional bearer auth and validates the parsed price", async () => {
    let requestedUrl: URL | undefined;
    let authorization: string | null = null;
    const client = new PythBenchmarksClient({
      apiKey: "test-bearer-key",
      fetch: mockFetch((url, init) => {
        requestedUrl = url;
        authorization = new Headers(init?.headers).get("authorization");
        return jsonResponse(validResponse({ id: `0x${PYTH_SOL_USD_FEED_ID}` }));
      })
    });

    await expect(client.getSolUsdPrice(TIMESTAMP)).resolves.toMatchObject({
      feedId: PYTH_SOL_USD_FEED_ID,
      requestedTimestampSeconds: TIMESTAMP,
      publishTimeSeconds: TIMESTAMP,
      priceMantissa: "7889501505",
      confidenceMantissa: "5446245",
      exponent: -8,
      priceUsd: 78.89501505,
      confidenceUsd: 0.05446245
    });
    expect(client.authenticationConfigured).toBe(true);
    expect(requestedUrl?.origin).toBe("https://benchmarks.pyth.network");
    expect(requestedUrl?.pathname).toBe(`/v1/updates/price/${TIMESTAMP}`);
    expect(requestedUrl?.searchParams.getAll("ids")).toEqual([PYTH_SOL_USD_FEED_ID]);
    expect(requestedUrl?.searchParams.get("parsed")).toBe("true");
    expect(authorization).toBe("Bearer test-bearer-key");
  });

  it("serializes calls at no more than one request per second", async () => {
    let clock = 0;
    const starts: number[] = [];
    const waits: number[] = [];
    const client = new PythBenchmarksClient({
      now: () => clock,
      sleep: async (milliseconds) => {
        waits.push(milliseconds);
        clock += milliseconds;
      },
      fetch: mockFetch((url) => {
        starts.push(clock);
        const timestamp = Number(url.pathname.split("/").at(-1));
        return jsonResponse(validResponse({ publishTime: timestamp }));
      })
    });

    await client.getSolUsdPrice(TIMESTAMP);
    await client.getSolUsdPrice(TIMESTAMP + 600);
    expect(starts).toEqual([0, 1_000]);
    expect(waits).toEqual([1_000]);
  });

  it.each([
    ["exact requested time", TIMESTAMP],
    ["maximum forward boundary", TIMESTAMP + 60]
  ])("accepts a valid observation at the %s", async (_label, publishTime) => {
    const client = new PythBenchmarksClient({
      fetch: mockFetch(() => jsonResponse(validResponse({ publishTime })))
    });

    await expect(client.getSolUsdPrice(TIMESTAMP)).resolves.toMatchObject({
      requestedTimestampSeconds: TIMESTAMP,
      observationTimestampSeconds: publishTime,
      publishTimeSeconds: publishTime
    });
  });

  it.each([
    ["PARSED_SHAPE", validResponse({ parsed: [] })],
    ["FEED_ID", validResponse({ id: "0".repeat(64) })],
    ["PRICE_SHAPE", validResponse({ price: null })],
    ["MANTISSA", validResponse({ price: { price: "7.8", conf: "1", expo: -8, publish_time: TIMESTAMP } })],
    ["EXPONENT", validResponse({ expo: -19 })],
    ["PUBLISH_TIME", validResponse({ publishTime: TIMESTAMP - 1 })],
    ["PUBLISH_TIME", validResponse({ publishTime: TIMESTAMP + 61 })],
    ["CONFIDENCE", validResponse({ conf: "-1" })],
    ["CONFIDENCE", validResponse({
      price: { price: "100", conf: "6", expo: 0, publish_time: TIMESTAMP }
    })]
  ])("fails closed on %s response validation", async (code, response) => {
    const client = new PythBenchmarksClient({
      fetch: mockFetch(() => jsonResponse(response))
    });
    const error = await client.getSolUsdPrice(TIMESTAMP).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PythBenchmarksValidationError);
    expect(error).toMatchObject({ code });
  });

  it("rejects unsafe configuration and rates above one request per second", () => {
    expect(() => new PythBenchmarksClient({ baseUrl: "http://benchmarks.example.test" })).toThrow("HTTPS");
    expect(() => new PythBenchmarksClient({ baseUrl: "https://user:pass@benchmarks.example.test" })).toThrow(
      "cannot contain credentials"
    );
    expect(() => new PythBenchmarksClient({ baseUrl: "https://benchmarks.example.test/path" })).toThrow(
      "without a path"
    );
    expect(() => new PythBenchmarksClient({ apiKey: "bad\nheader" })).toThrow("single-line");
    expect(() => new PythBenchmarksClient({ requestsPerSecond: 1.01 })).toThrow("no more than 1");
    expect(() => new PythBenchmarksClient().getSolUsdPrice(0)).toThrow("positive Unix-seconds");
  });

  it("redacts endpoint, response, and authorization details from request errors", async () => {
    const client = new PythBenchmarksClient({
      apiKey: "very-secret-bearer",
      baseUrl: "https://private-benchmarks.example.test",
      fetch: mockFetch(() => jsonResponse({
        authorization: "Bearer very-secret-bearer",
        internal: "sensitive-response-body"
      }, 401))
    });
    const error = await client.getSolUsdPrice(TIMESTAMP).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PythBenchmarksRequestError);
    expect(error).toMatchObject({ status: 401, retryable: false });
    expect(String(error)).not.toContain("very-secret-bearer");
    expect(String(error)).not.toContain("private-benchmarks");
    expect(String(error)).not.toContain("sensitive-response-body");
  });
});
