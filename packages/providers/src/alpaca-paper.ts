import type {
  AlpacaPaperCredentials,
  AlpacaPaperStatus
} from "@copylab/shared";
import {
  asRecord,
  finiteNumber,
  requestJson,
  stringValue,
  type FetchLike
} from "./http.js";

export const ALPACA_PAPER_TRADING_ORIGIN = "https://paper-api.alpaca.markets";
export const ALPACA_MARKET_DATA_ORIGIN = "https://data.alpaca.markets";

export interface AlpacaPaperProviderOptions {
  fetch?: FetchLike;
  timeoutMs?: number;
  now?: () => Date;
}

export interface AlpacaStockAsset {
  symbol: string;
  name?: string;
  exchange?: string;
  status: string;
  tradable: boolean;
  fractionable: boolean;
  marginable: boolean;
  shortable: boolean;
  easyToBorrow: boolean;
  fractionalEhEnabled: boolean;
  overnightTradable: boolean;
  overnightHalted: boolean;
}

export type AlpacaLatestStockFeed = "iex" | "overnight";
export type AlpacaHistoricalStockFeed = "iex" | "boats" | "sip";

export interface AlpacaMarketClock {
  timestamp: string;
  isOpen: boolean;
  nextOpen: string;
  nextClose: string;
}

export interface AlpacaMarketCalendarDay {
  date: string;
  open: string;
  close: string;
}

export interface AlpacaCorporateAction {
  id: string;
  type: string;
  symbol: string;
  processDate?: string;
}

export interface AlpacaCorporateActionsResult {
  actions: AlpacaCorporateAction[];
  nextPageToken?: string;
}

export interface AlpacaStockQuote {
  timestamp: string;
  bidPrice: number;
  bidSize: number;
  askPrice: number;
  askSize: number;
}

export interface AlpacaStockTrade {
  timestamp: string;
  price: number;
  size: number;
}

export interface AlpacaStockBar {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  tradeCount: number;
  vwap: number;
}

export interface AlpacaStockSnapshot {
  symbol: string;
  latestQuote?: AlpacaStockQuote;
  latestTrade?: AlpacaStockTrade;
  minuteBar?: AlpacaStockBar;
  dailyBar?: AlpacaStockBar;
  previousDailyBar?: AlpacaStockBar;
}

export interface AlpacaBarsResult {
  bars: Map<string, AlpacaStockBar[]>;
  nextPageToken?: string;
}

export type AlpacaMostActiveBy = "volume" | "trades";

export interface AlpacaMostActiveStock {
  symbol: string;
  volume: number;
  tradeCount: number;
}

export interface AlpacaMostActivesResult {
  stocks: AlpacaMostActiveStock[];
  lastUpdated?: string;
}

export interface AlpacaMarketMover {
  symbol: string;
  price: number;
  change: number;
  percentChange: number;
}

export interface AlpacaMarketMoversResult {
  gainers: AlpacaMarketMover[];
  losers: AlpacaMarketMover[];
  lastUpdated?: string;
}

export interface AlpacaNewsArticle {
  id: number;
  headline: string;
  createdAt: string;
  updatedAt: string;
  symbols: string[];
  summary?: string;
  author?: string;
  url?: string;
  source?: string;
}

export interface AlpacaNewsResult {
  articles: AlpacaNewsArticle[];
  nextPageToken?: string;
}

export interface AlpacaNewsRequest {
  start: string;
  end: string;
  limit?: number;
  pageToken?: string;
}

function normalizeCredential(value: string, label: string): string {
  const normalized = value.trim();
  if (
    normalized.length < 8 ||
    normalized.length > 512 ||
    /[\r\n]/.test(normalized)
  ) {
    throw new Error(`${label} must be a single-line value between 8 and 512 characters.`);
  }
  return normalized;
}

function boundedInteger(value: number, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${label} must be a safe integer between 1 and ${maximum}.`);
  }
  return value;
}

function requestTimestamp(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || !Number.isFinite(Date.parse(normalized))) {
    throw new Error(`${label} must be a valid date or RFC 3339 timestamp.`);
  }
  return normalized;
}

function requestDate(value: string, label: string): string {
  const normalized = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized) || !Number.isFinite(Date.parse(`${normalized}T00:00:00Z`))) {
    throw new Error(`${label} must use YYYY-MM-DD.`);
  }
  return normalized;
}

function stockSymbol(value: unknown): string | undefined {
  const normalized = stringValue(value)?.trim().toUpperCase();
  if (
    !normalized ||
    normalized.length > 32 ||
    /[\s\u0000-\u001f\u007f,]/.test(normalized)
  ) return undefined;
  return normalized;
}

function stockSymbols(value: unknown): string[] {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  return [...new Set(values.map(stockSymbol).filter((symbol): symbol is string => Boolean(symbol)))];
}

function parseMostActiveStocks(value: unknown): AlpacaMostActiveStock[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const stocks: AlpacaMostActiveStock[] = [];
  for (const item of value) {
    const row = asRecord(item);
    const symbol = stockSymbol(row?.symbol);
    const volume = finiteNumber(row?.volume);
    const tradeCount = finiteNumber(row?.trade_count);
    if (
      !row ||
      !symbol ||
      seen.has(symbol) ||
      volume === undefined ||
      volume < 0 ||
      tradeCount === undefined ||
      tradeCount < 0
    ) continue;
    seen.add(symbol);
    stocks.push({ symbol, volume, tradeCount });
  }
  return stocks;
}

function parseMarketMovers(value: unknown): AlpacaMarketMover[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const movers: AlpacaMarketMover[] = [];
  for (const item of value) {
    const row = asRecord(item);
    const symbol = stockSymbol(row?.symbol);
    const price = finiteNumber(row?.price);
    const change = finiteNumber(row?.change);
    const percentChange = finiteNumber(row?.percent_change);
    if (
      !row ||
      !symbol ||
      seen.has(symbol) ||
      price === undefined ||
      price <= 0 ||
      change === undefined ||
      percentChange === undefined
    ) continue;
    seen.add(symbol);
    movers.push({ symbol, price, change, percentChange });
  }
  return movers;
}

function parseNewsArticles(value: unknown): AlpacaNewsArticle[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<number>();
  const articles: AlpacaNewsArticle[] = [];
  for (const item of value) {
    const row = asRecord(item);
    const id = finiteNumber(row?.id);
    const headline = stringValue(row?.headline)?.trim();
    const createdAt = stringValue(row?.created_at)?.trim();
    if (
      !row ||
      id === undefined ||
      !Number.isSafeInteger(id) ||
      id <= 0 ||
      seen.has(id) ||
      !headline ||
      !createdAt ||
      !Number.isFinite(Date.parse(createdAt))
    ) continue;
    const updatedAtRaw = stringValue(row.updated_at)?.trim();
    const updatedAt = updatedAtRaw && Number.isFinite(Date.parse(updatedAtRaw))
      ? updatedAtRaw
      : createdAt;
    const summary = stringValue(row.summary)?.trim();
    const author = stringValue(row.author)?.trim();
    const url = stringValue(row.url)?.trim();
    const source = stringValue(row.source)?.trim();
    seen.add(id);
    articles.push({
      id,
      headline,
      createdAt,
      updatedAt,
      symbols: stockSymbols(row.symbols),
      ...(summary ? { summary } : {}),
      ...(author ? { author } : {}),
      ...(url ? { url } : {}),
      ...(source ? { source } : {})
    });
  }
  return articles;
}

function stockBar(value: unknown): AlpacaStockBar | undefined {
  const row = asRecord(value);
  if (!row) return undefined;
  const timestamp = stringValue(row.t);
  const open = finiteNumber(row.o);
  const high = finiteNumber(row.h);
  const low = finiteNumber(row.l);
  const close = finiteNumber(row.c);
  const volume = finiteNumber(row.v);
  if (
    !timestamp ||
    open === undefined ||
    high === undefined ||
    low === undefined ||
    close === undefined ||
    volume === undefined ||
    open <= 0 ||
    high <= 0 ||
    low <= 0 ||
    close <= 0 ||
    volume < 0
  ) return undefined;
  return {
    timestamp,
    open,
    high,
    low,
    close,
    volume,
    tradeCount: Math.max(0, finiteNumber(row.n) ?? 0),
    vwap: finiteNumber(row.vw) ?? close
  };
}

function stockQuote(value: unknown): AlpacaStockQuote | undefined {
  const row = asRecord(value);
  if (!row) return undefined;
  const timestamp = stringValue(row.t);
  const bidPrice = finiteNumber(row.bp);
  const askPrice = finiteNumber(row.ap);
  if (!timestamp || bidPrice === undefined || askPrice === undefined || bidPrice <= 0 || askPrice <= 0) {
    return undefined;
  }
  return {
    timestamp,
    bidPrice,
    bidSize: Math.max(0, finiteNumber(row.bs) ?? 0),
    askPrice,
    askSize: Math.max(0, finiteNumber(row.as) ?? 0)
  };
}

function stockTrade(value: unknown): AlpacaStockTrade | undefined {
  const row = asRecord(value);
  if (!row) return undefined;
  const timestamp = stringValue(row.t);
  const price = finiteNumber(row.p);
  if (!timestamp || price === undefined || price <= 0) return undefined;
  return {
    timestamp,
    price,
    size: Math.max(0, finiteNumber(row.s) ?? 0)
  };
}

export class AlpacaPaperProvider {
  private readonly credentials: AlpacaPaperCredentials;
  private readonly fetch: FetchLike | undefined;
  private readonly timeoutMs: number | undefined;
  private readonly now: () => Date;

  constructor(
    credentials: AlpacaPaperCredentials,
    options: AlpacaPaperProviderOptions = {}
  ) {
    this.credentials = {
      apiKey: normalizeCredential(credentials.apiKey, "Alpaca Paper API key"),
      secretKey: normalizeCredential(credentials.secretKey, "Alpaca Paper secret key")
    };
    this.fetch = options.fetch;
    this.timeoutMs = options.timeoutMs;
    this.now = options.now ?? (() => new Date());
  }

  private headers(): Record<string, string> {
    return {
      "APCA-API-KEY-ID": this.credentials.apiKey,
      "APCA-API-SECRET-KEY": this.credentials.secretKey,
      Accept: "application/json"
    };
  }

  private request<T>(url: string, provider: string): Promise<T> {
    return requestJson<T>(
      url,
      { headers: this.headers() },
      {
        fetch: this.fetch,
        ...(this.timeoutMs === undefined ? {} : { timeoutMs: this.timeoutMs }),
        provider
      }
    );
  }

  async checkHealth(): Promise<AlpacaPaperStatus> {
    const startedAt = this.now().getTime();
    try {
      const account = asRecord(await this.request<unknown>(
        `${ALPACA_PAPER_TRADING_ORIGIN}/v2/account`,
        "Alpaca Paper"
      ));
      const accountStatus = stringValue(account?.status);
      if (!account || !accountStatus || account.trading_blocked === true) {
        throw new Error("Alpaca Paper account response was not active and usable.");
      }

      const quote = asRecord(await this.request<unknown>(
        `${ALPACA_MARKET_DATA_ORIGIN}/v2/stocks/AAPL/quotes/latest?feed=iex`,
        "Alpaca IEX"
      ));
      if (!asRecord(quote?.quote)) {
        throw new Error("Alpaca IEX quote response was invalid.");
      }

      return {
        configured: true,
        connected: true,
        paperOnly: true,
        liveOrderCapabilityEnabled: false,
        marketDataFeed: "IEX",
        tradingEndpoint: "paper-api.alpaca.markets",
        dataEndpoint: "data.alpaca.markets",
        accountStatus,
        checkedAt: this.now().toISOString(),
        latencyMs: Math.max(0, this.now().getTime() - startedAt),
        message: "Alpaca Paper is authenticated and the free IEX feed is reachable."
      };
    } catch {
      return {
        configured: true,
        connected: false,
        paperOnly: true,
        liveOrderCapabilityEnabled: false,
        marketDataFeed: "IEX",
        tradingEndpoint: "paper-api.alpaca.markets",
        dataEndpoint: "data.alpaca.markets",
        checkedAt: this.now().toISOString(),
        latencyMs: Math.max(0, this.now().getTime() - startedAt),
        message: "Alpaca Paper authentication or free IEX validation failed."
      };
    }
  }

  async getClock(): Promise<AlpacaMarketClock> {
    const row = asRecord(await this.request<unknown>(
      `${ALPACA_PAPER_TRADING_ORIGIN}/v2/clock`,
      "Alpaca Market Clock"
    ));
    const timestamp = stringValue(row?.timestamp);
    const nextOpen = stringValue(row?.next_open);
    const nextClose = stringValue(row?.next_close);
    if (!row || !timestamp || !nextOpen || !nextClose || typeof row.is_open !== "boolean") {
      throw new Error("Alpaca market clock response was invalid.");
    }
    return { timestamp, isOpen: row.is_open, nextOpen, nextClose };
  }

  async getCalendar(start: string, end: string): Promise<AlpacaMarketCalendarDay[]> {
    const normalizedStart = requestDate(start, "Alpaca calendar start");
    const normalizedEnd = requestDate(end, "Alpaca calendar end");
    if (normalizedStart > normalizedEnd) throw new Error("Alpaca calendar start must not be after end.");
    const query = new URLSearchParams({ start: normalizedStart, end: normalizedEnd });
    const payload = await this.request<unknown>(
      `${ALPACA_PAPER_TRADING_ORIGIN}/v2/calendar?${query}`,
      "Alpaca Calendar"
    );
    if (!Array.isArray(payload)) throw new Error("Alpaca calendar response was invalid.");
    return payload.flatMap((value): AlpacaMarketCalendarDay[] => {
      const row = asRecord(value);
      const date = stringValue(row?.date)?.trim();
      const open = stringValue(row?.open)?.trim();
      const close = stringValue(row?.close)?.trim();
      return row && date && open && close && /^\d{4}-\d{2}-\d{2}$/.test(date)
        ? [{ date, open, close }]
        : [];
    });
  }

  async getCorporateActions(input: {
    symbols: readonly string[];
    start: string;
    end: string;
    pageToken?: string;
  }): Promise<AlpacaCorporateActionsResult> {
    const symbols = [...new Set(input.symbols.map(stockSymbol).filter((value): value is string => Boolean(value)))];
    if (symbols.length === 0 || symbols.length > 100) {
      throw new Error("Alpaca corporate-action requests require between 1 and 100 symbols.");
    }
    const start = requestDate(input.start, "Alpaca corporate-action start");
    const end = requestDate(input.end, "Alpaca corporate-action end");
    if (start > end) throw new Error("Alpaca corporate-action start must not be after end.");
    const query = new URLSearchParams({
      symbols: symbols.join(","),
      types: [
        "reverse_split", "forward_split", "unit_split", "spin_off", "cash_merger",
        "stock_merger", "stock_and_cash_merger", "redemption", "name_change",
        "worthless_removal", "rights_distribution", "partial_call", "reorganization"
      ].join(","),
      region: "us",
      start,
      end,
      limit: "1000"
    });
    const pageToken = input.pageToken?.trim();
    if (pageToken) query.set("page_token", pageToken);
    const payload = asRecord(await this.request<unknown>(
      `${ALPACA_MARKET_DATA_ORIGIN}/v1/corporate-actions?${query}`,
      "Alpaca Corporate Actions"
    ));
    if (!payload) throw new Error("Alpaca corporate-action response was invalid.");
    const actions: AlpacaCorporateAction[] = [];
    for (const [collection, values] of Object.entries(payload)) {
      if (!Array.isArray(values)) continue;
      for (const value of values) {
        const row = asRecord(value);
        const id = stringValue(row?.id)?.trim();
        const symbol = stockSymbol(row?.symbol);
        if (!row || !id || !symbol) continue;
        const type = stringValue(row.type)?.trim() || collection.replace(/s$/u, "");
        const processDate = stringValue(row.process_date)?.trim() || stringValue(row.ex_date)?.trim();
        actions.push({
          id,
          type,
          symbol,
          ...(processDate ? { processDate } : {})
        });
      }
    }
    const nextPageToken = stringValue(payload.next_page_token)?.trim();
    return {
      actions,
      ...(nextPageToken ? { nextPageToken } : {})
    };
  }

  async getAssets(): Promise<AlpacaStockAsset[]> {
    const rows = await this.request<unknown>(
      `${ALPACA_PAPER_TRADING_ORIGIN}/v2/assets?status=active&asset_class=us_equity`,
      "Alpaca Assets"
    );
    if (!Array.isArray(rows)) throw new Error("Alpaca asset response was invalid.");
    return rows.flatMap((value): AlpacaStockAsset[] => {
      const row = asRecord(value);
      const symbol = stringValue(row?.symbol);
      const status = stringValue(row?.status);
      if (!row || !symbol || !status) return [];
      const name = stringValue(row.name);
      const exchange = stringValue(row.exchange);
      const attributes = new Set(
        Array.isArray(row.attributes)
          ? row.attributes.flatMap((attribute): string[] => {
              const value = stringValue(attribute)?.trim();
              return value ? [value] : [];
            })
          : []
      );
      return [{
        symbol,
        ...(name ? { name } : {}),
        ...(exchange ? { exchange } : {}),
        status,
        tradable: row.tradable === true,
        fractionable: row.fractionable === true,
        marginable: row.marginable === true,
        shortable: row.shortable === true,
        easyToBorrow: row.easy_to_borrow === true,
        // Alpaca's current Assets response exposes these flags in the
        // `attributes` array; retain boolean-field compatibility for older
        // responses and recorded fixtures.
        fractionalEhEnabled: row.fractional_eh_enabled === true || attributes.has("fractional_eh_enabled"),
        overnightTradable: row.overnight_tradable === true || attributes.has("overnight_tradable"),
        overnightHalted: row.overnight_halted === true || attributes.has("overnight_halted")
      }];
    });
  }

  async getMostActives(
    top = 100,
    by: AlpacaMostActiveBy = "volume"
  ): Promise<AlpacaMostActivesResult> {
    const normalizedTop = boundedInteger(top, "Alpaca most-actives top", 100);
    if (by !== "volume" && by !== "trades") {
      throw new Error("Alpaca most-actives ranking must be volume or trades.");
    }
    const query = new URLSearchParams({
      by,
      top: normalizedTop.toString()
    });
    const payload = asRecord(await this.request<unknown>(
      `${ALPACA_MARKET_DATA_ORIGIN}/v1beta1/screener/stocks/most-actives?${query}`,
      "Alpaca Screener"
    ));
    if (!payload || !Array.isArray(payload.most_actives)) {
      throw new Error("Alpaca most-actives response was invalid.");
    }
    const lastUpdated = stringValue(payload.last_updated)?.trim();
    return {
      stocks: parseMostActiveStocks(payload.most_actives),
      ...(lastUpdated ? { lastUpdated } : {})
    };
  }

  async getMarketMovers(top = 50): Promise<AlpacaMarketMoversResult> {
    const normalizedTop = boundedInteger(top, "Alpaca market-movers top", 50);
    const query = new URLSearchParams({ top: normalizedTop.toString() });
    const payload = asRecord(await this.request<unknown>(
      `${ALPACA_MARKET_DATA_ORIGIN}/v1beta1/screener/stocks/movers?${query}`,
      "Alpaca Screener"
    ));
    if (!payload || !Array.isArray(payload.gainers) || !Array.isArray(payload.losers)) {
      throw new Error("Alpaca market-movers response was invalid.");
    }
    const lastUpdated = stringValue(payload.last_updated)?.trim();
    return {
      gainers: parseMarketMovers(payload.gainers),
      losers: parseMarketMovers(payload.losers),
      ...(lastUpdated ? { lastUpdated } : {})
    };
  }

  async getNews(input: AlpacaNewsRequest): Promise<AlpacaNewsResult> {
    const start = requestTimestamp(input.start, "Alpaca news start");
    const end = requestTimestamp(input.end, "Alpaca news end");
    if (Date.parse(start) > Date.parse(end)) {
      throw new Error("Alpaca news start must not be after end.");
    }
    const limit = boundedInteger(input.limit ?? 50, "Alpaca news limit", 50);
    const query = new URLSearchParams({
      start,
      end,
      limit: limit.toString(),
      sort: "desc"
    });
    const pageToken = input.pageToken?.trim();
    if (pageToken) {
      if (pageToken.length > 2_048 || /[\r\n]/.test(pageToken)) {
        throw new Error("Alpaca news page token is invalid.");
      }
      query.set("page_token", pageToken);
    }
    const payload = asRecord(await this.request<unknown>(
      `${ALPACA_MARKET_DATA_ORIGIN}/v1beta1/news?${query}`,
      "Alpaca News"
    ));
    if (!payload || !Array.isArray(payload.news)) {
      throw new Error("Alpaca news response was invalid.");
    }
    const nextPageToken = stringValue(payload.next_page_token)?.trim();
    return {
      articles: parseNewsArticles(payload.news),
      ...(nextPageToken ? { nextPageToken } : {})
    };
  }

  async getSnapshots(
    symbols: readonly string[],
    feed: AlpacaLatestStockFeed = "iex"
  ): Promise<AlpacaStockSnapshot[]> {
    const normalized = [...new Set(symbols.map((symbol) => symbol.trim().toUpperCase()).filter(Boolean))];
    if (normalized.length === 0 || normalized.length > 100) {
      throw new Error("Alpaca snapshot requests require between 1 and 100 unique symbols.");
    }
    const query = new URLSearchParams({
      symbols: normalized.join(","),
      feed
    });
    const payload = asRecord(await this.request<unknown>(
      `${ALPACA_MARKET_DATA_ORIGIN}/v2/stocks/snapshots?${query}`,
      feed === "overnight" ? "Alpaca Overnight" : "Alpaca IEX"
    ));
    // Alpaca's current multi-snapshot response is a direct symbol map. Keep
    // wrapped `snapshots` compatibility for recorded/legacy fixtures.
    const snapshots = asRecord(payload?.snapshots) ?? payload;
    if (!snapshots) throw new Error("Alpaca snapshot response was invalid.");
    return normalized.flatMap((symbol): AlpacaStockSnapshot[] => {
      const row = asRecord(snapshots[symbol]);
      if (!row) return [];
      const latestQuote = stockQuote(row.latestQuote);
      const latestTrade = stockTrade(row.latestTrade);
      const minuteBar = stockBar(row.minuteBar);
      const dailyBar = stockBar(row.dailyBar);
      const previousDailyBar = stockBar(row.prevDailyBar);
      return [{
        symbol,
        ...(latestQuote ? { latestQuote } : {}),
        ...(latestTrade ? { latestTrade } : {}),
        ...(minuteBar ? { minuteBar } : {}),
        ...(dailyBar ? { dailyBar } : {}),
        ...(previousDailyBar ? { previousDailyBar } : {})
      }];
    });
  }

  async getBars(input: {
    symbols: readonly string[];
    start: string;
    end: string;
    pageToken?: string;
    feed?: AlpacaHistoricalStockFeed;
  }): Promise<AlpacaBarsResult> {
    const normalized = [...new Set(input.symbols.map((symbol) => symbol.trim().toUpperCase()).filter(Boolean))];
    if (normalized.length === 0 || normalized.length > 100) {
      throw new Error("Alpaca bar requests require between 1 and 100 unique symbols.");
    }
    const query = new URLSearchParams({
      symbols: normalized.join(","),
      timeframe: "1Min",
      start: input.start,
      end: input.end,
      limit: "10000",
      adjustment: "raw",
      feed: input.feed ?? "iex",
      sort: "asc"
    });
    if (input.pageToken) query.set("page_token", input.pageToken);
    const payload = asRecord(await this.request<unknown>(
      `${ALPACA_MARKET_DATA_ORIGIN}/v2/stocks/bars?${query}`,
      input.feed === "boats"
        ? "Alpaca BOATS"
        : input.feed === "sip"
          ? "Alpaca delayed SIP"
          : "Alpaca IEX"
    ));
    const rows = asRecord(payload?.bars);
    if (!rows) throw new Error("Alpaca bars response was invalid.");
    const bars = new Map<string, AlpacaStockBar[]>();
    for (const symbol of normalized) {
      const values = rows[symbol];
      bars.set(symbol, Array.isArray(values)
        ? values.map(stockBar).filter((bar): bar is AlpacaStockBar => Boolean(bar))
        : []);
    }
    const nextPageToken = stringValue(payload?.next_page_token);
    return { bars, ...(nextPageToken ? { nextPageToken } : {}) };
  }
}
