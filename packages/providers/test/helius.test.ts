import { describe, expect, it, vi } from "vitest";
import { HeliusObserver, type WebSocketLike } from "../src/helius.js";
import { flushPromises, jsonResponse, mockFetch } from "./helpers.js";
import {
  PUBLIC_SWAP_SIGNATURE,
  PUBLIC_SWAP_WALLET,
  TEST_SIGNATURE,
  TEST_WALLET,
  capturedSolSellWithAccountClosure,
  capturedTokenToTokenRotation,
  capturedUsdcSpotSwap,
  recordedPublicSolSell,
  recordedWalletHistoryUsdcBuy,
  recordedWalletHistoryUsdcSell,
  walletHistoryUsdcBuy
} from "./fixtures/helius-transactions.js";

class FakeWebSocket implements WebSocketLike {
  readyState = 0;
  readonly sent: string[] = [];
  readonly closeCalls: Array<{ code: number | undefined; reason: string | undefined }> = [];
  private readonly listeners = new Map<string, Array<(event: any) => void>>();

  addEventListener(type: "open" | "close" | "error" | "message", listener: (event: any) => void) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(data: string) {
    this.sent.push(data);
  }

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

describe("HeliusObserver", () => {
  it("uses a WHATWG-safe close code and reconnects after an acknowledgement timeout", async () => {
    vi.useFakeTimers();
    try {
      const sockets: FakeWebSocket[] = [];
      const errors: Error[] = [];
      const observer = new HeliusObserver("key", {
        websocketFactory: () => {
          const socket = new FakeWebSocket();
          sockets.push(socket);
          return socket;
        },
        subscriptionAckTimeoutMs: 10,
        reconnectBaseMs: 10,
        reconnectMaximumMs: 10,
        heartbeatMs: 600_000,
        onError: (error) => errors.push(error)
      });

      const unsubscribe = await observer.subscribe([TEST_WALLET], async () => undefined);
      sockets[0]?.open();
      await vi.advanceTimersByTimeAsync(10);

      expect(errors.map((error) => error.message)).toContain(
        "Helius logsSubscribe acknowledgement timed out"
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

  it("paces reconnect attempts with bounded exponential backoff and injected jitter", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const attempts: number[] = [];
      const observer = new HeliusObserver("key", {
        websocketFactory: () => {
          attempts.push(Date.now());
          throw new Error("socket factory unavailable");
        },
        reconnectBaseMs: 20,
        reconnectMaximumMs: 50,
        jitter: () => 0,
        heartbeatMs: 600_000
      });

      const unsubscribe = await observer.subscribe([TEST_WALLET], async () => undefined);
      expect(attempts).toEqual([0]);
      await vi.advanceTimersByTimeAsync(9);
      expect(attempts).toEqual([0]);
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(20);
      await vi.advanceTimersByTimeAsync(25);
      expect(attempts).toEqual([0, 10, 30, 55]);
      await unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });

  it("subscribes at confirmed commitment, hydrates getTransaction, and deduplicates notifications", async () => {
    const socket = new FakeWebSocket();
    const rpcMethods: string[] = [];
    const fetch = mockFetch((_url, init) => {
      const body = JSON.parse(String(init?.body)) as { method: string };
      rpcMethods.push(body.method);
      if (body.method === "getTransaction") {
        return jsonResponse({ jsonrpc: "2.0", id: 1, result: capturedUsdcSpotSwap });
      }
      return jsonResponse({ jsonrpc: "2.0", id: 1, result: "ok" });
    });
    const observer = new HeliusObserver("key", {
      fetch,
      websocketFactory: () => socket,
      heartbeatMs: 600_000
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
    await flushPromises();

    expect(rpcMethods).toEqual(["getTransaction"]);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ sourceSignature: TEST_SIGNATURE, recovered: false });
    await unsubscribe();
  });

  it("reports one rejected PumpSwap observation for duplicate live notifications and never emits a swap", async () => {
    const socket = new FakeWebSocket();
    const rpcMethods: string[] = [];
    const onRejectedSwap = vi.fn(async () => undefined);
    const onSwap = vi.fn(async () => undefined);
    const observer = new HeliusObserver("key", {
      fetch: mockFetch((_url, init) => {
        const body = JSON.parse(String(init?.body)) as { method: string };
        rpcMethods.push(body.method);
        if (body.method === "getTransaction") {
          return jsonResponse({ jsonrpc: "2.0", id: 1, result: recordedPublicSolSell });
        }
        return jsonResponse({ jsonrpc: "2.0", id: 1, result: "ok" });
      }),
      websocketFactory: () => socket,
      heartbeatMs: 600_000,
      onRejectedSwap
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

    expect(rpcMethods).toEqual(["getTransaction"]);
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

  it("emits research inventory loss for an ignored rotation but not for an accepted sell", async () => {
    const acceptedSignature = `${TEST_SIGNATURE.slice(0, -1)}T`;
    const onTokenDecrease = vi.fn(async () => undefined);
    const observer = new HeliusObserver("key", {
      onTokenDecrease,
      fetch: mockFetch((_url, init) => {
        const request = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
        if (request.method === "getAsset") {
          return jsonResponse({
            jsonrpc: "2.0",
            id: 1,
            result: { token_info: { price_info: { price_per_token: 200 } } }
          });
        }
        expect(request.method).toBe("getTransaction");
        return jsonResponse({
          jsonrpc: "2.0",
          id: 1,
          result: request.params[0] === TEST_SIGNATURE
            ? capturedTokenToTokenRotation
            : capturedSolSellWithAccountClosure
        });
      })
    });

    await expect(observer.hydrateSwap(TEST_SIGNATURE, TEST_WALLET)).resolves.toBeNull();
    await expect(observer.hydrateSwap(acceptedSignature, TEST_WALLET)).resolves.toMatchObject({
      side: "SELL"
    });
    expect(onTokenDecrease).toHaveBeenCalledTimes(1);
    expect(onTokenDecrease).toHaveBeenCalledWith(expect.objectContaining({
      kind: "WALLET_TOKEN_DECREASE_RESEARCH_ONLY",
      signature: TEST_SIGNATURE,
      wallet: TEST_WALLET,
      recovered: false,
      amountAtomic: "4000000",
      amountUi: 4
    }));
  });

  it("deduplicates history signatures and hydrates exact recovered wallet deltas", async () => {
    let transactionCalls = 0;
    const fetch = mockFetch((url, init) => {
      if (url.pathname.includes("/history")) {
        return jsonResponse({
          data: [recordedWalletHistoryUsdcBuy, recordedWalletHistoryUsdcBuy],
          pagination: { hasMore: false, nextCursor: null }
        });
      }
      const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
      expect(body.method).toBe("getTransaction");
      expect(body.params[0]).toBe(recordedWalletHistoryUsdcBuy.signature);
      transactionCalls += 1;
      return jsonResponse({
        jsonrpc: "2.0",
        id: 1,
        result: capturedUsdcSpotSwap
      });
    });
    const observer = new HeliusObserver("key", { fetch });
    const swaps = await observer.repairGap(TEST_WALLET, "2024-07-03T00:00:00Z");
    expect(transactionCalls).toBe(1);
    expect(swaps).toHaveLength(1);
    expect(swaps.every((swap) => swap.recovered)).toBe(true);
    expect(swaps[0]).toMatchObject({
      sourceSignature: recordedWalletHistoryUsdcBuy.signature,
      side: "BUY",
      baseAmountAtomic: "4000000",
      targetAmountAtomic: "2000000",
      baseAmountUi: 4,
      targetAmountUi: 2
    });
  });

  it("repairs non-swap history into recovered research inventory evidence only when enabled", async () => {
    const onTokenDecrease = vi.fn(async () => undefined);
    let transactionCalls = 0;
    const historyEntry = {
      signature: TEST_SIGNATURE,
      type: "TRANSFER",
      timestamp: capturedTokenToTokenRotation.blockTime,
      slot: capturedTokenToTokenRotation.slot,
      error: null
    };
    const observer = new HeliusObserver("key", {
      onTokenDecrease,
      fetch: mockFetch((url, init) => {
        if (url.pathname.includes("/history")) {
          return jsonResponse({
            data: [historyEntry, historyEntry],
            pagination: { hasMore: false, nextCursor: null }
          });
        }
        const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
        expect(body.method).toBe("getTransaction");
        expect(body.params[0]).toBe(TEST_SIGNATURE);
        transactionCalls += 1;
        return jsonResponse({ jsonrpc: "2.0", id: 1, result: capturedTokenToTokenRotation });
      })
    });

    const since = new Date((capturedTokenToTokenRotation.blockTime - 1) * 1_000).toISOString();
    await expect(observer.repairGap(TEST_WALLET, since)).resolves.toEqual([]);
    expect(transactionCalls).toBe(1);
    expect(onTokenDecrease).toHaveBeenCalledTimes(1);
    expect(onTokenDecrease).toHaveBeenCalledWith(expect.objectContaining({
      signature: TEST_SIGNATURE,
      wallet: TEST_WALLET,
      recovered: true,
      amountAtomic: "4000000",
      amountUi: 4
    }));
  });

  it("reports one recovered rejection for duplicate PumpSwap history entries without returning a swap", async () => {
    let transactionCalls = 0;
    const onRejectedSwap = vi.fn(async () => undefined);
    const historyEntry = {
      signature: PUBLIC_SWAP_SIGNATURE,
      type: "SWAP",
      timestamp: recordedPublicSolSell.blockTime,
      slot: recordedPublicSolSell.slot,
      error: null
    };
    const observer = new HeliusObserver("key", {
      onRejectedSwap,
      fetch: mockFetch((url, init) => {
        if (url.pathname.includes("/history")) {
          return jsonResponse({
            data: [historyEntry, historyEntry],
            pagination: { hasMore: false, nextCursor: null }
          });
        }
        const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
        expect(body.method).toBe("getTransaction");
        expect(body.params[0]).toBe(PUBLIC_SWAP_SIGNATURE);
        transactionCalls += 1;
        return jsonResponse({ jsonrpc: "2.0", id: 1, result: recordedPublicSolSell });
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

  it("fails gap repair closed when bounded history paging cannot reach the cursor", async () => {
    let transactionCalls = 0;
    const observer = new HeliusObserver("key", {
      maxHistoryPages: 1,
      fetch: mockFetch((url) => {
        if (url.pathname.includes("/history")) {
          return jsonResponse({
            data: [walletHistoryUsdcBuy],
            pagination: { hasMore: true, nextCursor: "more-history" }
          });
        }
        transactionCalls += 1;
        return jsonResponse({ jsonrpc: "2.0", id: 1, result: capturedUsdcSpotSwap });
      })
    });

    await expect(observer.repairGap(TEST_WALLET, "2024-07-03T09:40:00Z"))
      .rejects.toThrow("page safety cap");
    expect(transactionCalls).toBe(0);
  });

  it("reconnects after a socket close and replays the missed interval as recovered", async () => {
    const sockets: FakeWebSocket[] = [];
    let historyCalls = 0;
    const observer = new HeliusObserver("key", {
      now: () => new Date("2024-07-03T09:40:00Z"),
      reconnectBaseMs: 10,
      reconnectMaximumMs: 10,
      heartbeatMs: 600_000,
      websocketFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
      fetch: mockFetch((url, init) => {
        if (url.pathname.endsWith("/history")) {
          historyCalls += 1;
          return jsonResponse({
            data: [walletHistoryUsdcBuy],
            pagination: { hasMore: false, nextCursor: null }
          });
        }
        const body = JSON.parse(String(init?.body)) as { method: string };
        if (body.method === "getTransaction") {
          return jsonResponse({ jsonrpc: "2.0", id: 1, result: capturedUsdcSpotSwap });
        }
        throw new Error(`Unexpected request: ${url}`);
      })
    });
    const received: unknown[] = [];
    const unsubscribe = await observer.subscribe([TEST_WALLET], async (swap) => { received.push(swap); });
    sockets[0]?.open();
    sockets[0]?.close();
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(sockets).toHaveLength(2);
    sockets[1]?.open();
    const reconnectRequest = JSON.parse(sockets[1]?.sent[0] ?? "{}") as { id: number };
    sockets[1]?.message({ jsonrpc: "2.0", id: reconnectRequest.id, result: 99 });
    expect(observer.getStreamStatus()).toMatchObject({
      ready: false,
      gapRepairPending: true,
      gapRepairFailed: false
    });
    await flushPromises();
    await flushPromises();
    expect(historyCalls).toBe(1);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ sourceSignature: TEST_SIGNATURE, recovered: true });
    expect(observer.getStreamStatus()).toMatchObject({
      ready: true,
      gapRepairPending: false,
      gapRepairFailed: false
    });
    await unsubscribe();
  });

  it("stays failed closed, buffers live signals, and retries reconnect repair", async () => {
    const sockets: FakeWebSocket[] = [];
    const errors: Error[] = [];
    let historyCalls = 0;
    const observer = new HeliusObserver("key", {
      now: () => new Date("2024-07-03T09:40:00Z"),
      reconnectBaseMs: 20,
      reconnectMaximumMs: 20,
      jitter: () => 1,
      heartbeatMs: 600_000,
      websocketFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
      onError: (error) => errors.push(error),
      fetch: mockFetch((url, init) => {
        if (url.pathname.endsWith("/history")) {
          historyCalls += 1;
          if (historyCalls === 1) return jsonResponse({ error: "temporary outage" }, 503);
          return jsonResponse({
            data: [walletHistoryUsdcBuy],
            pagination: { hasMore: false, nextCursor: null }
          });
        }
        const body = JSON.parse(String(init?.body)) as { method: string };
        if (body.method === "getTransaction") {
          return jsonResponse({ jsonrpc: "2.0", id: 1, result: capturedUsdcSpotSwap });
        }
        throw new Error(`Unexpected request: ${url}`);
      })
    });
    const received: unknown[] = [];
    const unsubscribe = await observer.subscribe([TEST_WALLET], async (swap) => { received.push(swap); });
    sockets[0]?.open();
    const firstRequest = JSON.parse(sockets[0]?.sent[0] ?? "{}") as { id: number };
    sockets[0]?.message({ jsonrpc: "2.0", id: firstRequest.id, result: 41 });
    await flushPromises();
    expect(observer.getStreamStatus().ready).toBe(true);

    sockets[0]?.close();
    await new Promise((resolve) => setTimeout(resolve, 25));
    sockets[1]?.open();
    const reconnectRequest = JSON.parse(sockets[1]?.sent[0] ?? "{}") as { id: number };
    sockets[1]?.message({ jsonrpc: "2.0", id: reconnectRequest.id, result: 42 });
    expect(observer.getStreamStatus()).toMatchObject({ ready: false, gapRepairPending: true });
    await flushPromises();

    expect(historyCalls).toBe(1);
    expect(observer.getStreamStatus()).toMatchObject({
      ready: false,
      gapRepairPending: false,
      gapRepairFailed: true
    });
    expect(observer.getStreamHealth()).toMatchObject({
      ok: false,
      message: "Helius wallet stream gap repair failed closed"
    });

    sockets[1]?.message({
      jsonrpc: "2.0",
      method: "logsNotification",
      params: {
        subscription: 42,
        result: { context: { slot: 302_000_001 }, value: { signature: TEST_SIGNATURE, err: null, logs: [] } }
      }
    });
    await flushPromises();
    expect(received).toEqual([]);

    await new Promise((resolve) => setTimeout(resolve, 25));
    await flushPromises();
    await flushPromises();
    expect(historyCalls).toBe(2);
    expect(received).toEqual([
      expect.objectContaining({ sourceSignature: TEST_SIGNATURE, recovered: true })
    ]);
    expect(observer.getStreamStatus()).toMatchObject({
      ready: true,
      gapRepairPending: false,
      gapRepairFailed: false
    });
    expect(errors.some((error) => error.message.includes("503"))).toBe(true);
    await unsubscribe();
  });

  it("stays not ready and preserves buffered notification order through a reconnect drain", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-11T12:00:00Z"));
    let releaseFirstCallback = (): void => undefined;
    try {
      const sockets: FakeWebSocket[] = [];
      let resolveHistory!: (response: Response) => void;
      const historyResponse = new Promise<Response>((resolve) => {
        resolveHistory = resolve;
      });
      const signatures = [
        "buffered-first-signature",
        "buffered-second-signature",
        "buffered-third-signature"
      ];
      const observer = new HeliusObserver("key", {
        reconnectBaseMs: 10,
        reconnectMaximumMs: 10,
        jitter: () => 1,
        heartbeatMs: 600_000,
        websocketFactory: () => {
          const socket = new FakeWebSocket();
          sockets.push(socket);
          return socket;
        },
        fetch: mockFetch(async (url, init) => {
          if (url.pathname.endsWith("/history")) return historyResponse;
          const body = JSON.parse(String(init?.body)) as { method: string };
          if (body.method === "getTransaction") {
            return jsonResponse({ jsonrpc: "2.0", id: 1, result: capturedUsdcSpotSwap });
          }
          throw new Error(`Unexpected request: ${url}`);
        })
      });
      let firstCallbackReleased!: () => void;
      const firstCallbackGate = new Promise<void>((resolve) => {
        firstCallbackReleased = resolve;
      });
      releaseFirstCallback = firstCallbackReleased;
      const received: Array<{ signature: string; recovered: boolean }> = [];
      const unsubscribe = await observer.subscribe([TEST_WALLET], async (swap) => {
        received.push({ signature: swap.sourceSignature, recovered: swap.recovered });
        if (swap.sourceSignature === signatures[0]) await firstCallbackGate;
      });

      sockets[0]?.open();
      const firstRequest = JSON.parse(sockets[0]?.sent[0] ?? "{}") as { id: number };
      sockets[0]?.message({ jsonrpc: "2.0", id: firstRequest.id, result: 41 });
      await vi.advanceTimersByTimeAsync(0);
      expect(observer.getStreamStatus().ready).toBe(true);

      sockets[0]?.close();
      await vi.advanceTimersByTimeAsync(10);
      sockets[1]?.open();
      const reconnectRequest = JSON.parse(sockets[1]?.sent[0] ?? "{}") as { id: number };
      sockets[1]?.message({ jsonrpc: "2.0", id: reconnectRequest.id, result: 42 });
      await vi.advanceTimersByTimeAsync(0);
      expect(observer.getStreamStatus()).toMatchObject({ ready: false, gapRepairPending: true });

      const notify = (signature: string): void => sockets[1]?.message({
        jsonrpc: "2.0",
        method: "logsNotification",
        params: {
          subscription: 42,
          result: { context: { slot: 302_000_001 }, value: { signature, err: null, logs: [] } }
        }
      });
      notify(signatures[0]!);
      notify(signatures[1]!);
      await vi.advanceTimersByTimeAsync(0);
      resolveHistory(jsonResponse({ data: [], pagination: { hasMore: false, nextCursor: null } }));

      await vi.waitFor(() => {
        expect(received).toEqual([{ signature: signatures[0], recovered: false }]);
      });
      expect(observer.getStreamStatus()).toMatchObject({ ready: false, gapRepairPending: true });

      // This later notification arrives while the first buffered callback is
      // still blocked. It must join the same ordered buffer, not overtake it.
      notify(signatures[2]!);
      await vi.advanceTimersByTimeAsync(0);
      expect(received).toEqual([{ signature: signatures[0], recovered: false }]);
      expect(observer.getStreamStatus()).toMatchObject({ ready: false, gapRepairPending: true });

      releaseFirstCallback();
      await vi.waitFor(() => {
        expect(received).toEqual(signatures.map((signature) => ({ signature, recovered: false })));
      });
      expect(observer.getStreamStatus()).toMatchObject({
        ready: true,
        gapRepairPending: false,
        gapRepairFailed: false
      });
      await unsubscribe();
    } finally {
      releaseFirstCallback();
      vi.useRealTimers();
    }
  });

  it("keeps a quiet subscribed wallet healthy past 60 seconds with default liveness probes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-11T12:00:00Z"));
    try {
      const socket = new FakeWebSocket();
      const observer = new HeliusObserver("key", {
        websocketFactory: () => socket
      });
      const unsubscribe = await observer.subscribe([TEST_WALLET], async () => undefined);
      socket.open();
      const subscription = JSON.parse(socket.sent[0] ?? "{}") as { id: number; method: string };
      socket.message({ jsonrpc: "2.0", id: subscription.id, result: 42 });
      await vi.advanceTimersByTimeAsync(0);
      expect(observer.getStreamStatus().ready).toBe(true);

      await vi.advanceTimersByTimeAsync(30_000);
      const firstProbe = JSON.parse(socket.sent.at(-1) ?? "{}") as { id: number; method: string };
      expect(firstProbe.method).toBe("getSlot");
      socket.message({ jsonrpc: "2.0", id: firstProbe.id, result: 431_909_600 });
      await vi.advanceTimersByTimeAsync(0);

      await vi.advanceTimersByTimeAsync(30_000);
      const secondProbe = JSON.parse(socket.sent.at(-1) ?? "{}") as { id: number; method: string };
      expect(secondProbe).toMatchObject({ method: "getSlot" });
      expect(secondProbe.id).not.toBe(firstProbe.id);
      socket.message({ jsonrpc: "2.0", id: secondProbe.id, result: 431_909_700 });
      await vi.advanceTimersByTimeAsync(0);

      await vi.advanceTimersByTimeAsync(5_001);
      expect(socket.sent.map((entry) => (JSON.parse(entry) as { method: string }).method))
        .toEqual(["logsSubscribe", "getSlot", "getSlot"]);
      expect(observer.getStreamHealth(60_000)).toMatchObject({
        ok: true,
        active: true,
        connected: true,
        ready: true,
        gapRepairPending: false,
        gapRepairFailed: false,
        lastMessageAt: "2026-07-11T12:01:00.000Z",
        message: "Helius wallet stream is connected, acknowledged, and live"
      });
      await unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed and reconnects when quiet-stream liveness probes receive no response", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-11T12:00:00Z"));
    try {
      const sockets: FakeWebSocket[] = [];
      const errors: Error[] = [];
      const observer = new HeliusObserver("key", {
        websocketFactory: () => {
          const socket = new FakeWebSocket();
          sockets.push(socket);
          return socket;
        },
        reconnectBaseMs: 10,
        reconnectMaximumMs: 10,
        jitter: () => 1,
        onError: (error) => errors.push(error)
      });
      const unsubscribe = await observer.subscribe([TEST_WALLET], async () => undefined);
      sockets[0]?.open();
      const subscription = JSON.parse(sockets[0]?.sent[0] ?? "{}") as { id: number };
      sockets[0]?.message({ jsonrpc: "2.0", id: subscription.id, result: 42 });
      await vi.advanceTimersByTimeAsync(0);

      await vi.advanceTimersByTimeAsync(60_001);
      expect(observer.getStreamHealth(60_000)).toMatchObject({
        ok: false,
        active: true,
        connected: true,
        ready: true,
        message: "Helius wallet stream has been silent for 61 seconds"
      });
      expect(sockets[0]?.sent.map((entry) => (JSON.parse(entry) as { method: string }).method))
        .toEqual(["logsSubscribe", "getSlot", "getSlot"]);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(errors.map((error) => error.message)).toContain(
        "Helius WebSocket liveness check timed out"
      );
      expect(sockets[0]?.closeCalls).toContainEqual({
        code: 4000,
        reason: "liveness timeout"
      });
      expect(observer.getStreamStatus()).toMatchObject({
        active: true,
        connected: false,
        ready: false,
        gapRepairPending: true,
        gapRepairFailed: false
      });

      await vi.advanceTimersByTimeAsync(10);
      expect(sockets).toHaveLength(2);
      await unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports synchronous stream acknowledgement, liveness, and disconnect health without RPC", async () => {
    const socket = new FakeWebSocket();
    let nowMs = Date.parse("2026-07-09T12:00:00Z");
    let fetchCalls = 0;
    const observer = new HeliusObserver("key", {
      now: () => new Date(nowMs),
      heartbeatMs: 600_000,
      websocketFactory: () => socket,
      fetch: mockFetch(() => {
        fetchCalls += 1;
        return jsonResponse({ jsonrpc: "2.0", id: 1, result: "ok" });
      })
    });

    expect(observer.getStreamStatus()).toEqual({
      active: false,
      connected: false,
      ready: false,
      gapRepairPending: false,
      gapRepairFailed: false
    });
    expect(observer.getStreamHealth()).toMatchObject({
      provider: "helius",
      ok: false,
      message: "Helius wallet stream is not active"
    });

    const unsubscribe = await observer.subscribe([TEST_WALLET], async () => undefined);
    expect(observer.getStreamStatus()).toMatchObject({
      active: true,
      connected: false,
      ready: false
    });

    socket.open();
    expect(observer.getStreamHealth()).toMatchObject({
      ok: false,
      connected: true,
      ready: false,
      message: "Helius wallet stream is awaiting subscription acknowledgement"
    });

    const request = JSON.parse(socket.sent[0] ?? "{}") as { id: number };
    socket.message({ jsonrpc: "2.0", id: request.id, result: 42 });
    await flushPromises();
    expect(observer.getStreamStatus()).toEqual({
      active: true,
      connected: true,
      ready: true,
      gapRepairPending: false,
      gapRepairFailed: false,
      lastMessageAt: "2026-07-09T12:00:00.000Z"
    });
    expect(observer.getStreamHealth()).toMatchObject({
      provider: "helius",
      ok: true,
      checkedAt: "2026-07-09T12:00:00.000Z",
      message: "Helius wallet stream is connected, acknowledged, and live"
    });

    nowMs += 60_001;
    expect(observer.getStreamHealth(60_000)).toMatchObject({
      ok: false,
      active: true,
      connected: true,
      ready: true,
      message: "Helius wallet stream has been silent for 61 seconds"
    });

    socket.close();
    expect(observer.getStreamHealth()).toMatchObject({
      ok: false,
      active: true,
      connected: false,
      ready: false,
      message: "Helius wallet stream is disconnected"
    });
    expect(fetchCalls).toBe(0);
    expect(() => observer.getStreamHealth(0)).toThrow("maximumSilenceMs");
    await unsubscribe();
    expect(observer.getStreamStatus()).toMatchObject({
      active: false,
      connected: false,
      ready: false,
      lastMessageAt: "2026-07-09T12:00:00.000Z"
    });
  });

  it("derives holding time, closed swaps, concentration, and wallet tags from history", async () => {
    const errors = vi.fn();
    const usage: Array<{ service: string; method: string; credits: number }> = [];
    const fetch = mockFetch((url, init) => {
      if (url.pathname.endsWith("/history")) {
        return jsonResponse({
          data: [recordedWalletHistoryUsdcSell, recordedWalletHistoryUsdcBuy],
          pagination: { hasMore: false, nextCursor: null }
        });
      }
      if (url.pathname.endsWith("/identity")) {
        return jsonResponse({ data: { tags: ["Sniper", "Exchange"] } });
      }
      const body = JSON.parse(String(init?.body)) as { method: string };
      if (body.method === "getAsset") {
        return jsonResponse({
          jsonrpc: "2.0",
          id: 1,
          result: { token_info: { price_info: { price_per_token: 200 } } }
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const observer = new HeliusObserver("key", {
      fetch,
      now: () => new Date("2024-07-06T00:00:00Z"),
      onError: errors,
      onRequest: (entry) => usage.push(entry)
    });
    const summary = await observer.summarizeHistory(TEST_WALLET, 90);
    expect(summary).toMatchObject({
      wallet: TEST_WALLET,
      closedEligibleSwaps: 1,
      activeWeeks: 1,
      medianHoldingMinutes: 1_440,
      topTokenProfitShare: 1,
      topThreeProfitShare: 1,
      tags: ["sniper", "exchange"]
    });
    expect(errors).not.toHaveBeenCalled();
    expect(usage).toEqual([
      { service: "wallet", method: "history", credits: 100 },
      { service: "wallet", method: "identity", credits: 100 }
    ]);
  });

  it("serializes observer HTTP starts at the configured shared pace", async () => {
    let nowMs = 0;
    const starts: number[] = [];
    const sleeps: number[] = [];
    const observer = new HeliusObserver("key", {
      requestsPerSecond: 1,
      now: () => new Date(nowMs),
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        nowMs += milliseconds;
      },
      fetch: mockFetch((url) => {
        starts.push(nowMs);
        return url.pathname.endsWith("/history")
          ? jsonResponse({ data: [], pagination: { hasMore: false, nextCursor: null } })
          : jsonResponse({ data: { tags: [] } });
      })
    });

    await observer.summarizeHistory(TEST_WALLET, 90);

    expect(starts).toEqual([0, 1_000]);
    expect(sleeps).toEqual([1_000]);
    expect(() => new HeliusObserver("key", { requestsPerSecond: 0 })).toThrow(/requestsPerSecond/);
  });

  it("fails wallet qualification closed when identity tags cannot be verified", async () => {
    const observer = new HeliusObserver("key", {
      fetch: mockFetch((url) =>
        url.pathname.endsWith("/history")
          ? jsonResponse({ data: [], pagination: { hasMore: false, nextCursor: null } })
          : jsonResponse({ error: "plan does not include identity" }, 403)
      )
    });
    await expect(observer.summarizeHistory(TEST_WALLET, 90))
      .rejects.toThrow("wallet tags could not be verified");
  });

  it("reports RPC health failures as diagnostics", async () => {
    const observer = new HeliusObserver("key", {
      fetch: mockFetch(() => jsonResponse({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32000, message: "node unavailable" }
      }))
    });
    await expect(observer.checkHealth()).resolves.toMatchObject({
      provider: "helius",
      ok: false
    });
  });
});
