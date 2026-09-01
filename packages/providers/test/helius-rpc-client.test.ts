import { describe, expect, it } from "vitest";
import { HeliusRpcClient } from "../src/helius-rpc-client.js";
import { jsonResponse, mockFetch } from "./helpers.js";

const ADDRESS = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const SIGNATURE = "5".repeat(88);

describe("HeliusRpcClient", () => {
  it("requests a confirmed paginated signature page and validates its rows", async () => {
    let body: Record<string, unknown> | undefined;
    const client = new HeliusRpcClient("key", {
      requestsPerSecond: 10,
      fetch: mockFetch((_url, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse({
          jsonrpc: "2.0",
          id: 1,
          result: [{ signature: SIGNATURE, slot: 42, blockTime: 123, err: null, confirmationStatus: "confirmed" }]
        });
      })
    });

    await expect(client.getSignaturesForAddress(ADDRESS, {
      before: "before-signature",
      until: "until-signature",
      limit: 500
    })).resolves.toEqual([{
      signature: SIGNATURE,
      slot: 42,
      blockTime: 123,
      confirmationStatus: "confirmed",
      failed: false
    }]);
    expect(body?.method).toBe("getSignaturesForAddress");
    expect(body?.params).toEqual([
      ADDRESS,
      { limit: 500, commitment: "confirmed", before: "before-signature", until: "until-signature" }
    ]);
  });

  it("serializes concurrent requests at the configured free-tier rate", async () => {
    let clock = 0;
    const starts: number[] = [];
    const client = new HeliusRpcClient("key", {
      requestsPerSecond: 5,
      now: () => clock,
      sleep: async (milliseconds) => { clock += milliseconds; },
      fetch: mockFetch(() => {
        starts.push(clock);
        return jsonResponse({ jsonrpc: "2.0", id: 1, result: [] });
      })
    });
    await Promise.all([
      client.getSignaturesForAddress(ADDRESS),
      client.getSignaturesForAddress(ADDRESS),
      client.getSignaturesForAddress(ADDRESS)
    ]);
    expect(starts).toEqual([0, 200, 400]);
  });

  it("retries retryable HTTP failures and meters every actual request", async () => {
    let calls = 0;
    let clock = 0;
    const usage: string[] = [];
    const client = new HeliusRpcClient("key", {
      requestsPerSecond: 10,
      maximumRetries: 2,
      retryBaseMs: 50,
      jitter: () => 0.5,
      now: () => clock,
      sleep: async (milliseconds) => { clock += milliseconds; },
      onRequest: ({ method, credits }) => usage.push(`${method}:${credits}`),
      fetch: mockFetch(() => {
        calls += 1;
        return calls < 3
          ? jsonResponse({ message: "slow down" }, 429)
          : jsonResponse({ jsonrpc: "2.0", id: 3, result: null });
      })
    });

    await expect(client.getTransaction(SIGNATURE)).resolves.toBeNull();
    expect(calls).toBe(3);
    expect(usage).toEqual(["getTransaction:1", "getTransaction:1", "getTransaction:1"]);
    expect(clock).toBeGreaterThanOrEqual(200);
  });

  it("requests a compact confirmed full block and meters one credit per attempt", async () => {
    const usage: string[] = [];
    let body: Record<string, unknown> | undefined;
    const client = new HeliusRpcClient("key", {
      requestsPerSecond: 10,
      onRequest: ({ method, credits }) => usage.push(`${method}:${credits}`),
      fetch: mockFetch((_url, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse({ jsonrpc: "2.0", id: 1, result: { blockTime: 123, transactions: [] } });
      })
    });

    await expect(client.getBlock(42)).resolves.toEqual({ blockTime: 123, transactions: [] });
    expect(body?.method).toBe("getBlock");
    expect(body?.params).toEqual([42, {
      commitment: "confirmed",
      encoding: "jsonParsed",
      transactionDetails: "full",
      rewards: false,
      maxSupportedTransactionVersion: 0
    }]);
    expect(usage).toEqual(["getBlock:1"]);
    expect(() => client.getBlock(-1)).toThrow("non-negative safe integer");
  });

  it("fails closed on malformed signature rows and invalid limits", async () => {
    const client = new HeliusRpcClient("key", {
      fetch: mockFetch(() => jsonResponse({ jsonrpc: "2.0", id: 1, result: [{ slot: 1 }] }))
    });
    await expect(client.getSignaturesForAddress(ADDRESS)).rejects.toThrow("result 0 was malformed");
    await expect(client.getSignaturesForAddress(ADDRESS, { limit: 1_001 })).rejects.toThrow("between 1 and 1000");
  });

  it("rejects corrupt timestamps, processed results, and invalid error fields", async () => {
    const rows = [
      { signature: SIGNATURE, slot: 1, blockTime: -1, err: null, confirmationStatus: "confirmed" },
      { signature: SIGNATURE, slot: 1, blockTime: 1, err: null, confirmationStatus: "processed" },
      { signature: SIGNATURE, slot: 1, blockTime: 1, err: 42, confirmationStatus: "confirmed" }
    ];
    const client = new HeliusRpcClient("key", {
      requestsPerSecond: 10,
      fetch: mockFetch(() => jsonResponse({ jsonrpc: "2.0", id: 1, result: [rows.shift()] }))
    });
    await expect(client.getSignaturesForAddress(ADDRESS)).rejects.toThrow("invalid block time");
    await expect(client.getSignaturesForAddress(ADDRESS)).rejects.toThrow("invalid confirmation status");
    await expect(client.getSignaturesForAddress(ADDRESS)).rejects.toThrow("invalid error field");
  });

  it("accepts both Solana string and tagged-object transaction errors", async () => {
    const rows = [
      { signature: SIGNATURE, slot: 1, blockTime: 1, err: "BlockhashNotFound", confirmationStatus: "confirmed" },
      { signature: SIGNATURE, slot: 2, blockTime: 2, err: { InstructionError: [2, { Custom: 6001 }] }, confirmationStatus: "confirmed" }
    ];
    const client = new HeliusRpcClient("key", {
      requestsPerSecond: 10,
      fetch: mockFetch(() => jsonResponse({ jsonrpc: "2.0", id: 1, result: [rows.shift()] }))
    });

    await expect(client.getSignaturesForAddress(ADDRESS)).resolves.toMatchObject([{ failed: true }]);
    await expect(client.getSignaturesForAddress(ADDRESS)).resolves.toMatchObject([{ failed: true }]);
  });

  it("enforces the credit reservation before an HTTP request starts", async () => {
    let fetches = 0;
    const client = new HeliusRpcClient("key", {
      tryReserve: () => false,
      fetch: mockFetch(() => {
        fetches += 1;
        return jsonResponse({ jsonrpc: "2.0", id: 1, result: [] });
      })
    });
    await expect(client.getSignaturesForAddress(ADDRESS)).rejects.toThrow("credit budget is exhausted");
    expect(fetches).toBe(0);
  });
});
