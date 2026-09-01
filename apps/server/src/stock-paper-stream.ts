import { WebSocket } from "ws";
import type { AlpacaStockBar, AlpacaStockQuote, AlpacaStockSnapshot } from "@copylab/providers";
import type { AlpacaPaperCredentials } from "@copylab/shared";

export type StockPaperStreamFeed = "iex" | "overnight";
export type StockPaperStreamStatus = "DISABLED" | "CONNECTING" | "AUTHENTICATING" | "LIVE" | "RECONNECTING" | "ERROR";

export interface StockPaperStreamSnapshot {
  status: StockPaperStreamStatus;
  feed?: StockPaperStreamFeed;
  symbols: number;
  reconnects: number;
  lastMessageAt?: string;
  lastQuoteAt?: string;
  lastBarAt?: string;
  quoteMessages: number;
  barMessages: number;
  lastError?: string;
}

interface WebSocketLike {
  readyState: number;
  on(event: "open", listener: () => void): this;
  on(event: "message", listener: (data: unknown) => void): this;
  on(event: "close", listener: () => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  send(data: string): void;
  close(): void;
}

export interface AlpacaStockHotlistStreamOptions {
  credentials: AlpacaPaperCredentials;
  now?: () => Date;
  socket?: (url: string) => WebSocketLike;
  reconnectBaseMs?: number;
  reconnectMaximumMs?: number;
  connectionTimeoutMs?: number;
  onData?: (kind: "QUOTE" | "BAR") => void;
  onStatus?: (snapshot: StockPaperStreamSnapshot) => void;
}

const MAXIMUM_SYMBOLS = 30;
const OPEN = 1;

function normalizedSymbols(symbols: readonly string[]): string[] {
  return [...new Set(symbols.map((symbol) => symbol.trim().toUpperCase()))]
    .filter((symbol) => /^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol))
    .slice(0, MAXIMUM_SYMBOLS);
}

function sameSymbolSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const values = new Set(left);
  return right.every((symbol) => values.has(symbol));
}

function finitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function parsePayload(data: unknown): unknown[] {
  try {
    const text = typeof data === "string"
      ? data
      : data instanceof Buffer
        ? data.toString("utf8")
        : String(data);
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export class AlpacaStockHotlistStream {
  private readonly now: () => Date;
  private readonly socketFactory: (url: string) => WebSocketLike;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaximumMs: number;
  private readonly connectionTimeoutMs: number;
  private socket: WebSocketLike | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private connectionTimer: NodeJS.Timeout | undefined;
  private stopped = false;
  private feed: StockPaperStreamFeed | undefined;
  private symbols: string[] = [];
  private status: StockPaperStreamStatus = "DISABLED";
  private reconnects = 0;
  private fatalConfigurationError = false;
  private lastMessageAt: string | undefined;
  private lastQuoteAt: string | undefined;
  private lastBarAt: string | undefined;
  private quoteMessages = 0;
  private barMessages = 0;
  private lastError: string | undefined;
  private quotes = new Map<string, AlpacaStockQuote>();
  private bars = new Map<string, AlpacaStockBar>();

  constructor(private readonly options: AlpacaStockHotlistStreamOptions) {
    this.now = options.now ?? (() => new Date());
    this.socketFactory = options.socket ?? ((url) => new WebSocket(url) as WebSocketLike);
    this.reconnectBaseMs = Math.max(250, options.reconnectBaseMs ?? 1_000);
    this.reconnectMaximumMs = Math.max(this.reconnectBaseMs, options.reconnectMaximumMs ?? 30_000);
    this.connectionTimeoutMs = Math.max(1_000, options.connectionTimeoutMs ?? 10_000);
  }

  configure(feed: StockPaperStreamFeed, symbols: readonly string[]): void {
    if (this.stopped) {
      this.disconnect("DISABLED");
      return;
    }
    const nextSymbols = normalizedSymbols(symbols);
    const priorSymbols = this.symbols;
    const feedChanged = feed !== this.feed;
    const changed = feedChanged || !sameSymbolSet(nextSymbols, priorSymbols);
    if (changed) this.fatalConfigurationError = false;
    if (feedChanged) {
      this.quotes.clear();
      this.bars.clear();
      this.lastQuoteAt = undefined;
      this.lastBarAt = undefined;
      this.quoteMessages = 0;
      this.barMessages = 0;
    } else {
      const retained = new Set(nextSymbols);
      for (const symbol of this.quotes.keys()) {
        if (!retained.has(symbol)) this.quotes.delete(symbol);
      }
      for (const symbol of this.bars.keys()) {
        if (!retained.has(symbol)) this.bars.delete(symbol);
      }
    }
    this.feed = feed;
    this.symbols = nextSymbols;
    if (nextSymbols.length === 0) {
      this.disconnect("DISABLED");
      return;
    }
    if (
      !feedChanged && changed && this.socket &&
      this.socket.readyState === OPEN && this.status === "LIVE"
    ) {
      const prior = new Set(priorSymbols);
      const next = new Set(nextSymbols);
      const removed = priorSymbols.filter((symbol) => !next.has(symbol));
      const added = nextSymbols.filter((symbol) => !prior.has(symbol));
      if (removed.length > 0) {
        this.socket.send(JSON.stringify({ action: "unsubscribe", quotes: removed, bars: removed }));
      }
      if (added.length > 0) {
        this.socket.send(JSON.stringify({ action: "subscribe", quotes: added, bars: added }));
      }
      this.publish();
      return;
    }
    if (!changed && this.socket && this.socket.readyState === OPEN) return;
    if (!changed && this.fatalConfigurationError) return;
    this.disconnect("CONNECTING");
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.disconnect("DISABLED");
  }

  snapshot(): StockPaperStreamSnapshot {
    return {
      status: this.status,
      ...(this.feed ? { feed: this.feed } : {}),
      symbols: this.symbols.length,
      reconnects: this.reconnects,
      ...(this.lastMessageAt ? { lastMessageAt: this.lastMessageAt } : {}),
      ...(this.lastQuoteAt ? { lastQuoteAt: this.lastQuoteAt } : {}),
      ...(this.lastBarAt ? { lastBarAt: this.lastBarAt } : {}),
      quoteMessages: this.quoteMessages,
      barMessages: this.barMessages,
      ...(this.lastError ? { lastError: this.lastError } : {})
    };
  }

  marketSnapshots(): AlpacaStockSnapshot[] {
    const symbols = new Set([...this.quotes.keys(), ...this.bars.keys()]);
    return [...symbols].map((symbol) => ({
      symbol,
      ...(this.quotes.get(symbol) ? { latestQuote: this.quotes.get(symbol)! } : {}),
      ...(this.bars.get(symbol) ? { minuteBar: this.bars.get(symbol)! } : {})
    }));
  }

  private publish(): void {
    this.options.onStatus?.(this.snapshot());
  }

  private disconnect(status: StockPaperStreamStatus, close = true): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    if (this.connectionTimer) clearTimeout(this.connectionTimer);
    this.connectionTimer = undefined;
    const socket = this.socket;
    this.socket = undefined;
    if (close && socket) {
      try { socket.close(); } catch { /* best-effort local cleanup */ }
    }
    this.status = status;
    this.publish();
  }

  private connect(): void {
    if (this.stopped || !this.feed || this.symbols.length === 0) return;
    this.status = this.reconnects > 0 ? "RECONNECTING" : "CONNECTING";
    this.publish();
    const generationFeed = this.feed;
    const socket = this.socketFactory(
      `wss://stream.data.alpaca.markets/${generationFeed === "iex" ? "v2/iex" : "v1beta1/overnight"}`
    );
    this.socket = socket;
    this.armConnectionTimeout(socket, "The Alpaca market-data stream did not connect in time.");
    socket.on("open", () => {
      if (this.socket !== socket || this.stopped) return;
      if (this.connectionTimer) clearTimeout(this.connectionTimer);
      this.connectionTimer = undefined;
      this.status = "AUTHENTICATING";
      this.publish();
      socket.send(JSON.stringify({
        action: "auth",
        key: this.options.credentials.apiKey,
        secret: this.options.credentials.secretKey
      }));
      this.armConnectionTimeout(socket, "The Alpaca market-data stream did not authenticate in time.");
    });
    socket.on("message", (data) => {
      if (this.socket !== socket || this.stopped) return;
      this.handleMessages(socket, parsePayload(data));
    });
    socket.on("error", () => {
      if (this.socket !== socket || this.stopped) return;
      if (this.connectionTimer) clearTimeout(this.connectionTimer);
      this.connectionTimer = undefined;
      this.lastError = "The Alpaca market-data stream reported a connection error.";
      this.status = "ERROR";
      this.publish();
      try { socket.close(); } catch { /* close event drives bounded reconnect */ }
      if (this.socket === socket) {
        this.socket = undefined;
        this.scheduleReconnect();
      }
    });
    socket.on("close", () => {
      if (this.socket !== socket || this.stopped) return;
      if (this.connectionTimer) clearTimeout(this.connectionTimer);
      this.connectionTimer = undefined;
      this.socket = undefined;
      this.scheduleReconnect();
    });
  }

  private handleMessages(socket: WebSocketLike, messages: readonly unknown[]): void {
    for (const item of messages) {
      const row = record(item);
      if (!row) continue;
      if (row.T === "success" && row.msg === "authenticated") {
        if (this.connectionTimer) clearTimeout(this.connectionTimer);
        this.connectionTimer = undefined;
        this.fatalConfigurationError = false;
        this.status = "LIVE";
        this.lastError = undefined;
        socket.send(JSON.stringify({ action: "subscribe", quotes: this.symbols, bars: this.symbols }));
        this.publish();
        continue;
      }
      if (row.T === "error") {
        if (this.connectionTimer) clearTimeout(this.connectionTimer);
        this.connectionTimer = undefined;
        const code = typeof row.code === "number" ? row.code : undefined;
        const fatal = code !== undefined && [401, 402, 403, 404, 405, 409].includes(code);
        this.lastError = "Alpaca rejected or limited the market-data stream.";
        this.fatalConfigurationError = fatal;
        this.status = "ERROR";
        this.publish();
        try { socket.close(); } catch { /* close event drives bounded reconnect */ }
        if (this.socket === socket) {
          this.socket = undefined;
          if (!fatal) this.scheduleReconnect();
        }
        return;
      }
      const symbol = typeof row.S === "string" ? row.S.trim().toUpperCase() : "";
      const timestamp = typeof row.t === "string" && Number.isFinite(Date.parse(row.t))
        ? row.t
        : undefined;
      if (!symbol || !timestamp || !this.symbols.includes(symbol)) continue;
      if (row.T === "q" && finitePositive(row.bp) && finitePositive(row.ap)) {
        const quote: AlpacaStockQuote = {
          timestamp,
          bidPrice: row.bp,
          bidSize: typeof row.bs === "number" && Number.isFinite(row.bs) ? Math.max(0, row.bs) : 0,
          askPrice: row.ap,
          askSize: typeof row.as === "number" && Number.isFinite(row.as) ? Math.max(0, row.as) : 0
        };
        const priorQuoteAt = Date.parse(this.quotes.get(symbol)?.timestamp ?? "");
        if (!Number.isFinite(priorQuoteAt) || Date.parse(quote.timestamp) >= priorQuoteAt) {
          this.quotes.set(symbol, quote);
        }
        this.lastMessageAt = this.now().toISOString();
        this.lastQuoteAt = timestamp;
        this.quoteMessages += 1;
        this.options.onData?.("QUOTE");
      } else if (
        row.T === "b" &&
        finitePositive(row.o) && finitePositive(row.h) && finitePositive(row.l) && finitePositive(row.c) &&
        typeof row.v === "number" && Number.isFinite(row.v) && row.v >= 0
      ) {
        const bar: AlpacaStockBar = {
          timestamp,
          open: row.o,
          high: row.h,
          low: row.l,
          close: row.c,
          volume: row.v,
          tradeCount: typeof row.n === "number" && Number.isFinite(row.n) ? Math.max(0, row.n) : 0,
          vwap: finitePositive(row.vw) ? row.vw : row.c
        };
        const priorBarAt = Date.parse(this.bars.get(symbol)?.timestamp ?? "");
        if (!Number.isFinite(priorBarAt) || Date.parse(bar.timestamp) >= priorBarAt) {
          this.bars.set(symbol, bar);
        }
        this.lastMessageAt = this.now().toISOString();
        this.lastBarAt = timestamp;
        this.barMessages += 1;
        this.options.onData?.("BAR");
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnects += 1;
    this.status = "RECONNECTING";
    this.publish();
    const delay = Math.min(
      this.reconnectMaximumMs,
      this.reconnectBaseMs * 2 ** Math.min(8, this.reconnects - 1)
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private armConnectionTimeout(socket: WebSocketLike, message: string): void {
    if (this.connectionTimer) clearTimeout(this.connectionTimer);
    this.connectionTimer = setTimeout(() => {
      this.connectionTimer = undefined;
      if (this.socket !== socket || this.stopped) return;
      this.lastError = message;
      this.status = "ERROR";
      this.publish();
      try { socket.close(); } catch { /* bounded reconnect below is authoritative */ }
      if (this.socket === socket) {
        this.socket = undefined;
        this.scheduleReconnect();
      }
    }, this.connectionTimeoutMs);
    this.connectionTimer.unref?.();
  }
}
