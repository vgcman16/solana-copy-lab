import { describe, expect, it, vi } from "vitest";
import { AlpacaStockHotlistStream } from "../src/stock-paper-stream.js";

class FakeSocket {
  readyState = 1;
  readonly sent: string[] = [];
  closed = false;
  private listeners = new Map<string, Array<(...values: never[]) => void>>();

  on(event: string, listener: (...values: never[]) => void): this {
    const values = this.listeners.get(event) ?? [];
    values.push(listener);
    this.listeners.set(event, values);
    return this;
  }

  send(data: string): void { this.sent.push(data); }
  close(): void { this.closed = true; }
  emit(event: string, value?: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value as never);
  }
}

describe("AlpacaStockHotlistStream", () => {
  it("authenticates, caps the free hotlist at 30, and retains newer quote/bar evidence", () => {
    const sockets: FakeSocket[] = [];
    const urls: string[] = [];
    const onData = vi.fn();
    const stream = new AlpacaStockHotlistStream({
      credentials: { apiKey: "paper-api-key", secretKey: "paper-secret-key" },
      now: () => new Date("2026-07-17T01:21:02.000Z"),
      socket: (url) => {
        urls.push(url);
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      onData
    });
    stream.configure("iex", Array.from({ length: 40 }, (_, index) => `S${index}`));
    const socket = sockets[0]!;
    socket.emit("open");
    expect(JSON.parse(socket.sent[0]!)).toEqual({
      action: "auth",
      key: "paper-api-key",
      secret: "paper-secret-key"
    });
    socket.emit("message", JSON.stringify([{ T: "success", msg: "authenticated" }]));
    const subscription = JSON.parse(socket.sent[1]!) as { quotes: string[]; bars: string[] };
    expect(subscription.quotes).toHaveLength(30);
    expect(subscription.bars).toEqual(subscription.quotes);
    expect(urls[0]).toBe("wss://stream.data.alpaca.markets/v2/iex");

    socket.emit("message", JSON.stringify([
      { T: "q", S: "S1", bp: 99.9, bs: 4, ap: 100.1, as: 5, t: "2026-07-17T01:21:01.000Z" },
      { T: "b", S: "S1", o: 100, h: 101, l: 99, c: 100.5, v: 1000, n: 20, vw: 100.2, t: "2026-07-17T01:20:00.000Z" }
    ]));
    expect(stream.marketSnapshots()[0]).toMatchObject({
      symbol: "S1",
      latestQuote: { bidPrice: 99.9, askPrice: 100.1 },
      minuteBar: { close: 100.5, volume: 1000 }
    });
    expect(onData).toHaveBeenCalledWith("QUOTE");
    expect(onData).toHaveBeenCalledWith("BAR");
    expect(stream.snapshot()).toMatchObject({
      status: "LIVE",
      feed: "iex",
      symbols: 30,
      lastQuoteAt: "2026-07-17T01:21:01.000Z",
      lastBarAt: "2026-07-17T01:20:00.000Z",
      quoteMessages: 1,
      barMessages: 1
    });
    expect(JSON.stringify(stream.snapshot())).not.toContain("paper-secret-key");
    stream.stop();
    expect(socket.closed).toBe(true);
  });

  it("reconnects on a feed change and uses the official overnight endpoint", () => {
    const sockets: FakeSocket[] = [];
    const urls: string[] = [];
    const stream = new AlpacaStockHotlistStream({
      credentials: { apiKey: "paper-api-key", secretKey: "paper-secret-key" },
      socket: (url) => {
        urls.push(url);
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      }
    });
    stream.configure("iex", ["AAPL"]);
    stream.configure("overnight", ["AAPL", "AMD"]);
    expect(sockets[0]?.closed).toBe(true);
    expect(urls[1]).toBe("wss://stream.data.alpaca.markets/v1beta1/overnight");
    expect(stream.snapshot()).toMatchObject({ feed: "overnight", symbols: 2 });
    stream.stop();
  });

  it("cannot be resurrected by a late configure call after shutdown", () => {
    const sockets: FakeSocket[] = [];
    const stream = new AlpacaStockHotlistStream({
      credentials: { apiKey: "paper-api-key", secretKey: "paper-secret-key" },
      socket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      }
    });
    stream.configure("iex", ["AAPL"]);
    stream.stop();
    stream.configure("overnight", ["AMD"]);

    expect(sockets).toHaveLength(1);
    expect(stream.snapshot().status).toBe("DISABLED");
  });

  it("updates a live same-feed hotlist with subscription deltas instead of reconnecting", () => {
    const sockets: FakeSocket[] = [];
    const stream = new AlpacaStockHotlistStream({
      credentials: { apiKey: "paper-api-key", secretKey: "paper-secret-key" },
      socket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      }
    });
    stream.configure("iex", ["AAPL", "AMD"]);
    const socket = sockets[0]!;
    socket.emit("open");
    socket.emit("message", JSON.stringify([{ T: "success", msg: "authenticated" }]));
    stream.configure("iex", ["MSFT", "AAPL"]);

    expect(sockets).toHaveLength(1);
    expect(socket.closed).toBe(false);
    expect(socket.sent.slice(-2).map((value) => JSON.parse(value))).toEqual([
      { action: "unsubscribe", quotes: ["AMD"], bars: ["AMD"] },
      { action: "subscribe", quotes: ["MSFT"], bars: ["MSFT"] }
    ]);
    stream.stop();
  });

  it("fails closed on a fatal authentication error until configuration changes", () => {
    const sockets: FakeSocket[] = [];
    const stream = new AlpacaStockHotlistStream({
      credentials: { apiKey: "paper-api-key", secretKey: "paper-secret-key" },
      socket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      }
    });
    stream.configure("iex", ["AAPL"]);
    const socket = sockets[0]!;
    socket.emit("open");
    socket.emit("message", JSON.stringify([{ T: "error", code: 402, msg: "auth failed" }]));
    stream.configure("iex", ["AAPL"]);

    expect(socket.closed).toBe(true);
    expect(sockets).toHaveLength(1);
    expect(stream.snapshot().status).toBe("ERROR");
    stream.stop();
  });

  it("times out a socket that never opens and enters bounded reconnect", () => {
    vi.useFakeTimers();
    try {
      const sockets: FakeSocket[] = [];
      const stream = new AlpacaStockHotlistStream({
        credentials: { apiKey: "paper-api-key", secretKey: "paper-secret-key" },
        connectionTimeoutMs: 1_000,
        reconnectBaseMs: 250,
        socket: () => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        }
      });
      stream.configure("iex", ["AAPL"]);
      vi.advanceTimersByTime(1_000);

      expect(sockets[0]?.closed).toBe(true);
      expect(stream.snapshot()).toMatchObject({ status: "RECONNECTING", reconnects: 1 });
      stream.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
