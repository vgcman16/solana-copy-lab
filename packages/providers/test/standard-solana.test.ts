import { describe, expect, it, vi } from "vitest";
import {
  StandardSolanaObserver,
  type StandardSolanaWebSocketLike
} from "../src/standard-solana.js";
import { flushPromises, jsonResponse, mockFetch } from "./helpers.js";
import {
  PUBLIC_SWAP_SIGNATURE,
  PUBLIC_SWAP_WALLET,
  TEST_SIGNATURE,
  TEST_WALLET,
  capturedSolSpotSwap,
  capturedTokenToTokenRotation,
  capturedUsdcSpotSwap,
  recordedPublicSolSell
} from "./fixtures/helius-transactions.js";

const SELL_SIGNATURE = `${TEST_SIGNATURE.slice(0, -1)}R`;
const OLD_SIGNATURE = `${TEST_SIGNATURE.slice(0, -1)}S`;
const HTTP_URL = "http://rpc.example.test";
const WS_URL = "ws://rpc.example.test";

function rpcResponse(init: RequestInit | undefined, result: unknown): Response {
  const request = JSON.parse(String(init?.body)) as { id: number };
  return jsonResponse({ jsonrpc: "2.0", id: request.id, result });
}

function usdcSellTransaction(): unknown {
  return {
    ...capturedUsdcSpotSwap,
    slot: capturedUsdcSpotSwap.slot + 1,
    blockTime: capturedUsdcSpotSwap.blockTime + 86_400,
    meta: {
      ...capturedUsdcSpotSwap.meta,
      preTokenBalances: [
        {
          accountIndex: 1,
          mint: capturedUsdcSpotSwap.meta.preTokenBalances[0]?.mint,
          owner: TEST_WALLET,
          uiTokenAmount: { amount: "1000000", decimals: 6 }
        },
        {
          accountIndex: 2,
          mint: capturedUsdcSpotSwap.meta.preTokenBalances[1]?.mint,
          owner: TEST_WALLET,
          uiTokenAmount: { amount: "2000000", decimals: 6 }
        }
      ],
      postTokenBalances: [
        {
          accountIndex: 1,
          mint: capturedUsdcSpotSwap.meta.preTokenBalances[0]?.mint,
          owner: TEST_WALLET,
          uiTokenAmount: { amount: "6000000", decimals: 6 }
        },
        {
          accountIndex: 2,
          mint: capturedUsdcSpotSwap.meta.preTokenBalances[1]?.mint,
          owner: TEST_WALLET,
          uiTokenAmount: { amount: "0", decimals: 6 }
        }
      ]
    },
    transaction: {
      ...capturedUsdcSpotSwap.transaction,
      signatures: [SELL_SIGNATURE]
    }
  };
}

class FakeWebSocket implements StandardSolanaWebSocketLike {
  readyState = 0;
  readonly sent: string[] = [];
  readonly closeCalls: Array<{ code: number | undefined; reason: string | undefined }> = [];
  private readonly listeners = new Map<string, Array<(event: any) => void>>();

  addEventListener(type: "open" | "close" | "error" | "message", listener: (event: any) => void) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(data: string) { this.sent.push(data); }

  close(code?: number, reason?: string) {
    if (code !== undefined && code !== 1000 && (code < 3000 || code > 4999)) {
      throw new DOMException("invalid code", "InvalidAccessError");
    }
    this.closeCalls.push({ code, reason });
    this.readyState = 3;
    this.emit("close", {});
  }

  open() {
    this.readyState = 1;
    this.emit("open", {});
  }

  message(payload: unknown) {
    this.emit("message", { data: JSON.stringify(payload) });
  }

  private emit(type: string, event: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

describe("StandardSolanaObserver", () => {
  it("uses a WHATWG-safe close code and reconnects after an acknowledgement timeout", async () => {
    vi.useFakeTimers();
    try {
      const sockets: FakeWebSocket[] = [];
      const errors: Error[] = [];
      const observer = new StandardSolanaObserver({
        httpUrl: HTTP_URL,
        wsUrl: WS_URL,
        websocketFactory: () => {
          const socket = new FakeWebSocket();
          sockets.push(socket);
          return socket;
        },
        subscriptionAckTimeoutMs: 10,
        reconnectBaseMs: 10,
        reconnectMaximumMs: 10,
        heartbeatMs: 600_000,
        livenessTimeoutMs: 600_000,
        onError: (error) => errors.push(error)
      });

      const unsubscribe = await observer.subscribe([TEST_WALLET], async () => undefined);
      sockets[0]?.open();
      await vi.advanceTimersByTimeAsync(10);

      expect(errors.map((error) => error.message)).toContain(
        "Standard Solana logsSubscribe acknowledgement timed out"
      );
      expect(sockets[0]?.closeCalls).toEqual([{
        code: 4000,
        reason: "subscription acknowledgement timeout"
      }]);

      await vi.advanceTimersByTimeAsync(10);
      expect(sockets).toHaveLength(2);
      await unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });

  it("requires explicit RPC/WSS endpoints and never accepts a Helius key", () => {
    expect(() => new StandardSolanaObserver({ httpUrl: HTTP_URL, wsUrl: "" })).toThrow("wsUrl is required");
    expect(() => new StandardSolanaObserver({ httpUrl: HTTP_URL, wsUrl: "https://rpc.example.test" }))
      .toThrow("ws: or wss:");
    expect(() => new StandardSolanaObserver({ httpUrl: HTTP_URL, wsUrl: WS_URL })).not.toThrow();
  });

  it("subscribes at confirmed, fetches the full transaction, and deduplicates notifications", async () => {
    const socket = new FakeWebSocket();
    let transactionCalls = 0;
    const observer = new StandardSolanaObserver({
      httpUrl: HTTP_URL,
      wsUrl: WS_URL,
      requestsPerSecond: 100,
      heartbeatMs: 600_000,
      livenessTimeoutMs: 600_000,
      websocketFactory: () => socket,
      fetch: mockFetch((_url, init) => {
        const request = JSON.parse(String(init?.body)) as { method: string };
        if (request.method === "getSignaturesForAddress") return rpcResponse(init, []);
        if (request.method === "getFirstAvailableBlock") return rpcResponse(init, 1);
        if (request.method === "getBlockTime") {
          return rpcResponse(init, capturedUsdcSpotSwap.blockTime - 86_400);
        }
        expect(request.method).toBe("getTransaction");
        transactionCalls += 1;
        return rpcResponse(init, capturedUsdcSpotSwap);
      })
    });
    const received: unknown[] = [];
    const unsubscribe = await observer.subscribe([TEST_WALLET], async (swap) => { received.push(swap); });
    socket.open();
    const request = JSON.parse(socket.sent[0] ?? "{}") as { id: number; params: unknown[] };
    expect(request.params).toEqual([{ mentions: [TEST_WALLET] }, { commitment: "confirmed" }]);
    socket.message({ jsonrpc: "2.0", id: request.id, result: 42 });
    const notification = {
      jsonrpc: "2.0",
      method: "logsNotification",
      params: {
        subscription: 42,
        result: { context: { slot: 302_000_001 }, value: { signature: TEST_SIGNATURE, err: null, logs: [] } }
      }
    };
    socket.message(notification);
    socket.message(notification);
    await flushPromises();
    expect(received).toEqual([]);
    expect(observer.getStreamStatus()).toMatchObject({ ready: false, gapRepairPending: true });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await flushPromises();

    expect(transactionCalls).toBe(1);
    expect(received).toEqual([expect.objectContaining({ sourceSignature: TEST_SIGNATURE, recovered: false })]);
    expect(observer.getStreamStatus()).toMatchObject({ active: true, connected: true, ready: true });
    await unsubscribe();
  });

  it("reports one rejected PumpSwap observation for duplicate live notifications and never emits a swap", async () => {
    const socket = new FakeWebSocket();
    let transactionCalls = 0;
    const onRejectedSwap = vi.fn(async () => undefined);
    const onSwap = vi.fn(async () => undefined);
    const observer = new StandardSolanaObserver({
      httpUrl: HTTP_URL,
      wsUrl: WS_URL,
      requestsPerSecond: 100,
      heartbeatMs: 600_000,
      livenessTimeoutMs: 600_000,
      websocketFactory: () => socket,
      onRejectedSwap,
      fetch: mockFetch((_url, init) => {
        const request = JSON.parse(String(init?.body)) as { method: string };
        if (request.method === "getSignaturesForAddress") return rpcResponse(init, []);
        if (request.method === "getFirstAvailableBlock") return rpcResponse(init, 1);
        if (request.method === "getBlockTime") {
          return rpcResponse(init, recordedPublicSolSell.blockTime - 86_400);
        }
        expect(request.method).toBe("getTransaction");
        transactionCalls += 1;
        return rpcResponse(init, recordedPublicSolSell);
      })
    });
    const unsubscribe = await observer.subscribe([PUBLIC_SWAP_WALLET], onSwap);
    socket.open();
    const request = JSON.parse(socket.sent[0] ?? "{}") as { id: number };
    socket.message({ jsonrpc: "2.0", id: request.id, result: 42 });
    const notification = {
      jsonrpc: "2.0",
      method: "logsNotification",
      params: {
        subscription: 42,
        result: {
          context: { slot: recordedPublicSolSell.slot },
          value: { signature: PUBLIC_SWAP_SIGNATURE, err: null, logs: [] }
        }
      }
    };

    socket.message(notification);
    socket.message(notification);
    await vi.waitFor(() => expect(onRejectedSwap).toHaveBeenCalledTimes(1));
    socket.message(notification);
    await flushPromises();

    expect(transactionCalls).toBe(1);
    expect(onSwap).not.toHaveBeenCalled();
    expect(onRejectedSwap).toHaveBeenCalledWith(expect.objectContaining({
      action: expect.objectContaining({
        sourceSignature: PUBLIC_SWAP_SIGNATURE,
        sourceWallet: PUBLIC_SWAP_WALLET,
        recovered: false
      }),
      researchAction: expect.objectContaining({
        kind: "UNSUPPORTED_ROUTE_RESEARCH_ONLY",
        baseAmountAtomic: "138253008",
        targetAmountAtomic: "181449172110",
        baseAmountUi: 0.138253008,
        targetAmountUi: 181449.17211
      }),
      reason: expect.stringContaining("strict decoder allowlist")
    }));
    await unsubscribe();
  });

  it("emits ignored inventory loss only on monitoring paths and never duplicates an accepted sell", async () => {
    const onTokenDecrease = vi.fn(async () => undefined);
    const observer = new StandardSolanaObserver({
      httpUrl: HTTP_URL,
      wsUrl: WS_URL,
      requestsPerSecond: 100,
      onTokenDecrease,
      fetch: mockFetch((_url, init) => {
        const request = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
        expect(request.method).toBe("getTransaction");
        return rpcResponse(
          init,
          request.params[0] === TEST_SIGNATURE
            ? capturedTokenToTokenRotation
            : usdcSellTransaction()
        );
      })
    });
    const detectedAt = new Date("2024-07-03T09:46:41Z");

    await expect(observer.hydrateSwap(
      TEST_SIGNATURE,
      TEST_WALLET,
      false,
      detectedAt,
      false
    )).resolves.toBeNull();
    expect(onTokenDecrease).not.toHaveBeenCalled();

    await expect(observer.hydrateSwap(
      TEST_SIGNATURE,
      TEST_WALLET,
      false,
      detectedAt,
      true
    )).resolves.toBeNull();
    expect(onTokenDecrease).toHaveBeenCalledTimes(1);
    expect(onTokenDecrease).toHaveBeenCalledWith(expect.objectContaining({
      kind: "WALLET_TOKEN_DECREASE_RESEARCH_ONLY",
      signature: TEST_SIGNATURE,
      wallet: TEST_WALLET,
      recovered: false,
      amountAtomic: "4000000",
      amountUi: 4
    }));

    await expect(observer.hydrateSwap(
      SELL_SIGNATURE,
      TEST_WALLET,
      false,
      detectedAt,
      true
    )).resolves.toMatchObject({ side: "SELL" });
    expect(onTokenDecrease).toHaveBeenCalledTimes(1);
  });

  it("repairs a history gap from standard signatures and deduplicates full transaction fetches", async () => {
    let transactionCalls = 0;
    const observer = new StandardSolanaObserver({
      httpUrl: HTTP_URL,
      wsUrl: WS_URL,
      requestsPerSecond: 100,
      fetch: mockFetch((_url, init) => {
        const request = JSON.parse(String(init?.body)) as { method: string };
        if (request.method === "getSignaturesForAddress") {
          return rpcResponse(init, [
            { signature: TEST_SIGNATURE, slot: 1, blockTime: capturedUsdcSpotSwap.blockTime, err: null, confirmationStatus: "confirmed" },
            { signature: TEST_SIGNATURE, slot: 1, blockTime: capturedUsdcSpotSwap.blockTime, err: null, confirmationStatus: "confirmed" }
          ]);
        }
        if (request.method === "getFirstAvailableBlock") return rpcResponse(init, 1);
        if (request.method === "getBlockTime") {
          return rpcResponse(init, capturedUsdcSpotSwap.blockTime - 86_400);
        }
        transactionCalls += 1;
        return rpcResponse(init, capturedUsdcSpotSwap);
      })
    });
    const swaps = await observer.repairGap(TEST_WALLET, "2024-07-03T00:00:00Z");
    expect(transactionCalls).toBe(1);
    expect(swaps).toEqual([expect.objectContaining({ sourceSignature: TEST_SIGNATURE, recovered: true })]);

    await Promise.all([
      observer.hydrateSwap(TEST_SIGNATURE, TEST_WALLET),
      observer.hydrateSwap(TEST_SIGNATURE, TEST_WALLET)
    ]);
    expect(transactionCalls).toBe(1);
  });

  it("reports one recovered rejection for duplicate PumpSwap history signatures without returning a swap", async () => {
    let transactionCalls = 0;
    const onRejectedSwap = vi.fn(async () => undefined);
    const historyEntry = {
      signature: PUBLIC_SWAP_SIGNATURE,
      slot: recordedPublicSolSell.slot,
      blockTime: recordedPublicSolSell.blockTime,
      err: null,
      confirmationStatus: "confirmed"
    };
    const observer = new StandardSolanaObserver({
      httpUrl: HTTP_URL,
      wsUrl: WS_URL,
      requestsPerSecond: 100,
      onRejectedSwap,
      fetch: mockFetch((_url, init) => {
        const request = JSON.parse(String(init?.body)) as { method: string };
        if (request.method === "getSignaturesForAddress") {
          return rpcResponse(init, [historyEntry, historyEntry]);
        }
        if (request.method === "getFirstAvailableBlock") return rpcResponse(init, 1);
        if (request.method === "getBlockTime") {
          return rpcResponse(init, recordedPublicSolSell.blockTime - 86_400);
        }
        expect(request.method).toBe("getTransaction");
        transactionCalls += 1;
        return rpcResponse(init, recordedPublicSolSell);
      })
    });

    const since = new Date((recordedPublicSolSell.blockTime - 1) * 1_000).toISOString();
    await expect(observer.repairGap(PUBLIC_SWAP_WALLET, since)).resolves.toEqual([]);
    expect(transactionCalls).toBe(1);
    expect(onRejectedSwap).toHaveBeenCalledTimes(1);
    expect(onRejectedSwap).toHaveBeenCalledWith(expect.objectContaining({
      action: expect.objectContaining({
        sourceSignature: PUBLIC_SWAP_SIGNATURE,
        sourceWallet: PUBLIC_SWAP_WALLET,
        recovered: true
      }),
      researchAction: expect.objectContaining({
        kind: "UNSUPPORTED_ROUTE_RESEARCH_ONLY",
        baseAmountAtomic: "138253008",
        targetAmountAtomic: "181449172110",
        baseAmountUi: 0.138253008,
        targetAmountUi: 181449.17211
      }),
      reason: expect.stringContaining("strict decoder allowlist")
    }));
  });

  it("accepts empty history only when the retained archive proves cursor coverage", async () => {
    const observer = (archiveBoundary: string) => new StandardSolanaObserver({
      httpUrl: HTTP_URL,
      wsUrl: WS_URL,
      requestsPerSecond: 100,
      maximumRetries: 0,
      fetch: mockFetch((_url, init) => {
        const request = JSON.parse(String(init?.body)) as { method: string };
        if (request.method === "getSignaturesForAddress") return rpcResponse(init, []);
        if (request.method === "getFirstAvailableBlock") return rpcResponse(init, 10);
        if (request.method === "getBlockTime") {
          return rpcResponse(init, Math.floor(Date.parse(archiveBoundary) / 1_000));
        }
        throw new Error(`Unexpected method ${request.method}`);
      })
    });

    await expect(
      observer("2024-07-02T00:00:00Z").repairGap(TEST_WALLET, "2024-07-03T00:00:00Z")
    ).resolves.toEqual([]);
    await expect(
      observer("2024-07-04T00:00:00Z").repairGap(TEST_WALLET, "2024-07-03T00:00:00Z")
    ).rejects.toThrow("retained archive begins");
  });

  it("repairs the missed interval before declaring a reconnected stream ready", async () => {
    const sockets: FakeWebSocket[] = [];
    let historyCalls = 0;
    const observer = new StandardSolanaObserver({
      httpUrl: HTTP_URL,
      wsUrl: WS_URL,
      requestsPerSecond: 100,
      reconnectBaseMs: 10,
      reconnectMaximumMs: 10,
      heartbeatMs: 600_000,
      livenessTimeoutMs: 600_000,
      now: () => new Date("2024-07-03T09:40:00Z"),
      websocketFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
      fetch: mockFetch((_url, init) => {
        const request = JSON.parse(String(init?.body)) as { method: string };
        if (request.method === "getSignaturesForAddress") {
          historyCalls += 1;
          return rpcResponse(init, historyCalls === 1 ? [] : [{
              signature: TEST_SIGNATURE,
              slot: capturedUsdcSpotSwap.slot,
              blockTime: capturedUsdcSpotSwap.blockTime,
              err: null,
              confirmationStatus: "confirmed"
            }]);
        }
        if (request.method === "getFirstAvailableBlock") return rpcResponse(init, 1);
        if (request.method === "getBlockTime") {
          return rpcResponse(init, capturedUsdcSpotSwap.blockTime - 86_400);
        }
        return rpcResponse(init, capturedUsdcSpotSwap);
      })
    });
    const received: unknown[] = [];
    const unsubscribe = await observer.subscribe([TEST_WALLET], async (swap) => { received.push(swap); });
    sockets[0]?.open();
    const firstRequest = JSON.parse(sockets[0]?.sent[0] ?? "{}") as { id: number };
    sockets[0]?.message({ jsonrpc: "2.0", id: firstRequest.id, result: 41 });
    await vi.waitFor(() => expect(observer.getStreamStatus().ready).toBe(true));

    sockets[0]?.close();
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    sockets[1]?.open();
    const reconnectRequest = JSON.parse(sockets[1]?.sent[0] ?? "{}") as { id: number };
    sockets[1]?.message({ jsonrpc: "2.0", id: reconnectRequest.id, result: 42 });
    expect(observer.getStreamStatus()).toMatchObject({ ready: false, gapRepairPending: true });
    await vi.waitFor(() => {
      expect(received).toEqual([expect.objectContaining({ sourceSignature: TEST_SIGNATURE, recovered: true })]);
      expect(observer.getStreamStatus()).toMatchObject({
        ready: true,
        gapRepairPending: false,
        gapRepairFailed: false
      });
    });
    await unsubscribe();
  });

  it("derives wallet history from recorded full transactions and verified local tags", async () => {
    const sell = usdcSellTransaction();
    const tagResolver = vi.fn(async () => ["Sniper Desk", "Exchange"]);
    const observer = new StandardSolanaObserver({
      httpUrl: HTTP_URL,
      wsUrl: WS_URL,
      requestsPerSecond: 100,
      now: () => new Date("2024-07-06T00:00:00Z"),
      walletTagResolver: tagResolver,
      fetch: mockFetch((_url, init) => {
        const request = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
        if (request.method === "getSignaturesForAddress") {
          return rpcResponse(init, [
            { signature: SELL_SIGNATURE, slot: 2, blockTime: capturedUsdcSpotSwap.blockTime + 86_400, err: null, confirmationStatus: "finalized" },
            { signature: TEST_SIGNATURE, slot: 1, blockTime: capturedUsdcSpotSwap.blockTime, err: null, confirmationStatus: "confirmed" },
            { signature: OLD_SIGNATURE, slot: 0, blockTime: capturedUsdcSpotSwap.blockTime - 91 * 86_400, err: "failed", confirmationStatus: "finalized" }
          ]);
        }
        const signature = request.params[0];
        return rpcResponse(init, signature === SELL_SIGNATURE ? sell : capturedUsdcSpotSwap);
      })
    });

    await expect(observer.summarizeHistory(TEST_WALLET, 90)).resolves.toMatchObject({
      wallet: TEST_WALLET,
      historyDays: 90,
      closedEligibleSwaps: 1,
      activeWeeks: 1,
      medianHoldingMinutes: 1_440,
      topTokenProfitShare: 1,
      topThreeProfitShare: 1,
      tags: ["sniper desk", "exchange", "sniper", "desk"]
    });
    expect(tagResolver).toHaveBeenCalledWith(TEST_WALLET);
  });

  it("fails closed without local identity tags, SOL pricing, or complete pagination", async () => {
    let fetches = 0;
    const noTags = new StandardSolanaObserver({
      httpUrl: HTTP_URL,
      wsUrl: WS_URL,
      fetch: mockFetch(() => {
        fetches += 1;
        return jsonResponse({});
      })
    });
    await expect(noTags.summarizeHistory(TEST_WALLET, 90)).rejects.toThrow("identity tags");
    expect(fetches).toBe(0);

    const noPrice = new StandardSolanaObserver({
      httpUrl: HTTP_URL,
      wsUrl: WS_URL,
      requestsPerSecond: 100,
      fetch: mockFetch((_url, init) => rpcResponse(init, capturedSolSpotSwap))
    });
    await expect(noPrice.hydrateSwap(TEST_SIGNATURE, TEST_WALLET)).rejects.toThrow("SOL-legged swap");

    const truncated = new StandardSolanaObserver({
      httpUrl: HTTP_URL,
      wsUrl: WS_URL,
      requestsPerSecond: 100,
      maxHistoryPages: 1,
      historyPageSize: 1,
      walletTagResolver: async () => [],
      now: () => new Date("2024-07-06T00:00:00Z"),
      fetch: mockFetch((_url, init) => rpcResponse(init, [{
        signature: TEST_SIGNATURE,
        slot: 1,
        blockTime: capturedUsdcSpotSwap.blockTime,
        err: null,
        confirmationStatus: "confirmed"
      }]))
    });
    await expect(truncated.summarizeHistory(TEST_WALLET, 90)).rejects.toThrow("pagination cap");
  });

  it("uses an injected historical SOL price for SOL-legged swaps", async () => {
    const prices: string[] = [];
    const observer = new StandardSolanaObserver({
      httpUrl: HTTP_URL,
      wsUrl: WS_URL,
      requestsPerSecond: 100,
      solPriceUsdResolver: async (at) => {
        prices.push(at);
        return 200;
      },
      fetch: mockFetch((_url, init) => rpcResponse(init, capturedSolSpotSwap))
    });

    await expect(observer.hydrateSwap(TEST_SIGNATURE, TEST_WALLET)).resolves.toMatchObject({
      baseMint: "So11111111111111111111111111111111111111112",
      leaderPriceUsd: 2
    });
    expect(prices).toEqual([new Date(capturedSolSpotSwap.blockTime * 1_000).toISOString()]);
  });

  it("reports health diagnostics without throwing", async () => {
    const healthy = new StandardSolanaObserver({
      httpUrl: HTTP_URL,
      wsUrl: WS_URL,
      requestsPerSecond: 100,
      fetch: mockFetch((_url, init) => rpcResponse(init, "ok"))
    });
    await expect(healthy.checkHealth()).resolves.toMatchObject({
      provider: "solana-rpc",
      ok: true,
      message: "Standard Solana RPC is reachable and healthy",
      usage: { requests: 1, window: "process" }
    });

    const unhealthy = new StandardSolanaObserver({
      httpUrl: HTTP_URL,
      wsUrl: WS_URL,
      requestsPerSecond: 100,
      maximumRetries: 0,
      fetch: mockFetch((_url, init) => {
        const request = JSON.parse(String(init?.body)) as { id: number };
        return jsonResponse({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "node unavailable" } });
      })
    });
    await expect(unhealthy.checkHealth()).resolves.toMatchObject({ provider: "solana-rpc", ok: false });
  });

  it("proves WebSocket health with a bounded confirmed logs subscription", async () => {
    const socket = new FakeWebSocket();
    const usage: string[] = [];
    const observer = new StandardSolanaObserver({
      httpUrl: HTTP_URL,
      wsUrl: WS_URL,
      websocketFactory: () => socket,
      onRequest: (entry) => usage.push(entry.method),
      fetch: mockFetch(() => { throw new Error("HTTP should not be used by the WebSocket probe"); })
    });

    const pending = observer.checkWebSocketHealth(1_000);
    socket.open();
    const subscribe = JSON.parse(socket.sent[0] ?? "{}") as {
      id: number;
      method: string;
      params: unknown[];
    };
    expect(subscribe).toMatchObject({
      method: "logsSubscribe",
      params: [
        { mentions: ["11111111111111111111111111111111"] },
        { commitment: "confirmed" }
      ]
    });
    socket.message({ jsonrpc: "2.0", id: subscribe.id, result: 77 });

    await expect(pending).resolves.toMatchObject({
      provider: "solana-rpc",
      ok: true,
      message: "Standard Solana WebSocket accepted a confirmed logs subscription",
      usage: { requests: 2, window: "process" }
    });
    expect(JSON.parse(socket.sent[1] ?? "{}")).toMatchObject({
      method: "logsUnsubscribe",
      params: [77]
    });
    expect(socket.readyState).toBe(3);
    expect(usage).toEqual(["logsSubscribe", "logsUnsubscribe"]);
  });

  it("fails a WebSocket probe closed on timeout without leaking endpoint query secrets", async () => {
    const secret = "do-not-log-this-token";
    const observer = new StandardSolanaObserver({
      httpUrl: HTTP_URL,
      wsUrl: `wss://rpc.example.test/socket?api-key=${secret}`,
      websocketFactory: (url) => {
        throw new Error(`connection refused for ${url}`);
      }
    });

    const failedOpen = await observer.checkWebSocketHealth(20);
    expect(failedOpen).toMatchObject({
      ok: false,
      message: "Standard Solana WebSocket could not be opened"
    });
    expect(JSON.stringify(failedOpen)).not.toContain(secret);

    const silentSocket = new FakeWebSocket();
    const timeoutObserver = new StandardSolanaObserver({
      httpUrl: HTTP_URL,
      wsUrl: WS_URL,
      websocketFactory: () => silentSocket
    });
    const timedOut = await timeoutObserver.checkWebSocketHealth(5);
    expect(timedOut).toMatchObject({
      ok: false,
      message: "Standard Solana WebSocket confirmed subscription probe timed out"
    });
    expect(silentSocket.readyState).toBe(3);
  });

  it("redacts endpoint user-info, path, and query secrets from live-stream adapter errors", async () => {
    const secret = "stream-query-secret";
    const pathSecret = "private-rpc-key";
    const errors: Error[] = [];
    const observer = new StandardSolanaObserver({
      httpUrl: HTTP_URL,
      wsUrl: `wss://rpc-user:rpc-password@rpc.example.test/${pathSecret}?token=${secret}`,
      websocketFactory: (url) => {
        throw new Error(`failed to open ${url}`);
      },
      onError: (error) => errors.push(error)
    });

    const unsubscribe = await observer.subscribe([TEST_WALLET], async () => undefined);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("wss://rpc.example.test/[redacted-endpoint]");
    expect(errors[0]?.message).not.toContain(secret);
    expect(errors[0]?.message).not.toContain(pathSecret);
    expect(errors[0]?.message).not.toContain("rpc-user");
    expect(errors[0]?.message).not.toContain("rpc-password");
    await unsubscribe();
  });
});
