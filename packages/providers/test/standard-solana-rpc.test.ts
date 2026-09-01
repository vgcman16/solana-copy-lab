import { describe, expect, it } from "vitest";
import { StandardSolanaRpcClient } from "../src/standard-solana-rpc.js";
import { jsonResponse, mockFetch } from "./helpers.js";

const ADDRESS = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const SIGNATURE = "5".repeat(88);

function rpcResponse(init: RequestInit | undefined, result: unknown): Response {
  const request = JSON.parse(String(init?.body)) as { id: number };
  return jsonResponse({ jsonrpc: "2.0", id: request.id, result });
}

describe("StandardSolanaRpcClient", () => {
  it("requires an explicit standard HTTP endpoint and no API key", () => {
    expect(() => new StandardSolanaRpcClient({ httpUrl: "" })).toThrow("httpUrl is required");
    expect(() => new StandardSolanaRpcClient({ httpUrl: "wss://rpc.example.test" })).toThrow("http: or https:");
    expect(() => new StandardSolanaRpcClient({ httpUrl: "https://rpc.example.test/#secret" })).toThrow("fragment");
    expect(() => new StandardSolanaRpcClient({ httpUrl: "http://127.0.0.1:8899" })).not.toThrow();
  });

  it("requests and validates confirmed signature history", async () => {
    let request: { method: string; params: unknown[] } | undefined;
    const client = new StandardSolanaRpcClient({
      httpUrl: "http://rpc.example.test",
      requestsPerSecond: 100,
      fetch: mockFetch((_url, init) => {
        request = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
        return rpcResponse(init, [{
          signature: SIGNATURE,
          slot: 42,
          blockTime: 123,
          err: null,
          confirmationStatus: "confirmed"
        }]);
      })
    });

    await expect(client.getSignaturesForAddress(ADDRESS, { limit: 500 })).resolves.toEqual([{
      signature: SIGNATURE,
      slot: 42,
      blockTime: 123,
      confirmationStatus: "confirmed",
      failed: false
    }]);
    expect(request).toMatchObject({
      method: "getSignaturesForAddress",
      params: [ADDRESS, { limit: 500, commitment: "confirmed" }]
    });
  });

  it("rate-limits concurrent calls and retries only retryable failures", async () => {
    let clock = 0;
    let calls = 0;
    const starts: number[] = [];
    const usage: string[] = [];
    const client = new StandardSolanaRpcClient({
      httpUrl: "http://rpc.example.test",
      requestsPerSecond: 5,
      maximumRetries: 1,
      retryBaseMs: 100,
      jitter: () => 0.5,
      now: () => clock,
      sleep: async (milliseconds) => { clock += milliseconds; },
      onRequest: ({ method }) => usage.push(method),
      fetch: mockFetch((_url, init) => {
        starts.push(clock);
        calls += 1;
        if (calls === 1) return jsonResponse({ message: "slow down" }, 429);
        return rpcResponse(init, null);
      })
    });

    await expect(client.getTransaction(SIGNATURE)).resolves.toBeNull();
    expect(starts).toEqual([0, 200]);
    expect(usage).toEqual(["getTransaction", "getTransaction"]);
  });

  it("requests confirmed full blocks for provider-neutral batch hydration", async () => {
    let request: { method: string; params: unknown[] } | undefined;
    const client = new StandardSolanaRpcClient({
      httpUrl: "http://rpc.example.test",
      fetch: mockFetch((_url, init) => {
        request = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
        return rpcResponse(init, { blockTime: 123, transactions: [] });
      })
    });
    await expect(client.getBlock(42)).resolves.toEqual({ blockTime: 123, transactions: [] });
    expect(request).toMatchObject({
      method: "getBlock",
      params: [42, {
        commitment: "confirmed",
        encoding: "jsonParsed",
        transactionDetails: "full",
        rewards: false,
        maxSupportedTransactionVersion: 0
      }]
    });
    expect(() => client.getBlock(-1)).toThrow("non-negative safe integer");
  });

  it("requests and validates readiness and balance compatibility methods", async () => {
    const requests: Array<{ method: string; params: unknown[] }> = [];
    const client = new StandardSolanaRpcClient({
      httpUrl: "http://rpc.example.test",
      requestsPerSecond: 100,
      fetch: mockFetch((_url, init) => {
        const request = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
        requests.push(request);
        const result = request.method === "getSlot" ? 55
          : request.method === "getBlockTime" ? 123
          : request.method === "getFirstAvailableBlock" ? 1
          : request.method === "minimumLedgerSlot" ? 2
          : request.method === "getBalance" ? { context: { slot: 55 }, value: 99 }
          : request.method === "getTokenAccountsByOwner" ? { context: { slot: 55 }, value: [] }
          : null;
        return rpcResponse(init, result);
      })
    });

    await expect(client.getSlot()).resolves.toBe(55);
    await expect(client.getBlockTime(55)).resolves.toBe(123);
    await expect(client.getFirstAvailableBlock()).resolves.toBe(1);
    await expect(client.getMinimumLedgerSlot()).resolves.toBe(2);
    await expect(client.getBalance(ADDRESS)).resolves.toBe(99);
    await expect(client.getTokenAccountsByOwner(ADDRESS)).resolves.toEqual([]);

    expect(requests.map(({ method, params }) => ({ method, params }))).toEqual([
      { method: "getSlot", params: [{ commitment: "confirmed" }] },
      { method: "getBlockTime", params: [55] },
      { method: "getFirstAvailableBlock", params: [] },
      { method: "minimumLedgerSlot", params: [] },
      { method: "getBalance", params: [ADDRESS, { commitment: "confirmed" }] },
      {
        method: "getTokenAccountsByOwner",
        params: [
          ADDRESS,
          { programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" },
          { commitment: "confirmed", encoding: "base64" }
        ]
      }
    ]);
  });

  it("fails closed on mismatched responses, malformed rows, and exhausted request budgets", async () => {
    const mismatch = new StandardSolanaRpcClient({
      httpUrl: "http://rpc.example.test",
      fetch: mockFetch(() => jsonResponse({ jsonrpc: "2.0", id: 999, result: [] }))
    });
    await expect(mismatch.getSignaturesForAddress(ADDRESS)).rejects.toThrow("mismatched JSON-RPC");

    const malformed = new StandardSolanaRpcClient({
      httpUrl: "http://rpc.example.test",
      fetch: mockFetch((_url, init) => rpcResponse(init, [{ slot: 1 }]))
    });
    await expect(malformed.getSignaturesForAddress(ADDRESS)).rejects.toThrow("result 0 was malformed");

    let fetches = 0;
    const budgeted = new StandardSolanaRpcClient({
      httpUrl: "http://rpc.example.test",
      tryReserve: () => false,
      fetch: mockFetch(() => {
        fetches += 1;
        return jsonResponse({});
      })
    });
    await expect(budgeted.getHealth()).rejects.toThrow("budget is exhausted");
    expect(fetches).toBe(0);
  });
});
