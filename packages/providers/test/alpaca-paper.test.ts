import { describe, expect, it } from "vitest";
import {
  ALPACA_MARKET_DATA_ORIGIN,
  ALPACA_PAPER_TRADING_ORIGIN,
  AlpacaPaperProvider
} from "../src/alpaca-paper.js";
import { jsonResponse, mockFetch } from "./helpers.js";

describe("AlpacaPaperProvider", () => {
  it("validates only the fixed paper account and free IEX endpoints", async () => {
    const requests: Array<{ url: URL; headers: Headers }> = [];
    const provider = new AlpacaPaperProvider(
      { apiKey: "paper-api-key", secretKey: "paper-secret-key" },
      {
        now: () => new Date("2026-07-16T12:00:00.000Z"),
        fetch: mockFetch((url, init) => {
          requests.push({ url, headers: new Headers(init?.headers) });
          if (url.origin === ALPACA_PAPER_TRADING_ORIGIN) {
            return jsonResponse({ status: "ACTIVE", trading_blocked: false });
          }
          return jsonResponse({ quote: { ap: 212.5, bp: 212.4 } });
        })
      }
    );

    await expect(provider.checkHealth()).resolves.toMatchObject({
      configured: true,
      connected: true,
      paperOnly: true,
      liveOrderCapabilityEnabled: false,
      marketDataFeed: "IEX",
      accountStatus: "ACTIVE"
    });
    expect(requests.map(({ url }) => `${url.origin}${url.pathname}${url.search}`)).toEqual([
      `${ALPACA_PAPER_TRADING_ORIGIN}/v2/account`,
      `${ALPACA_MARKET_DATA_ORIGIN}/v2/stocks/AAPL/quotes/latest?feed=iex`
    ]);
    for (const request of requests) {
      expect(request.headers.get("APCA-API-KEY-ID")).toBe("paper-api-key");
      expect(request.headers.get("APCA-API-SECRET-KEY")).toBe("paper-secret-key");
    }
  });

  it("fails closed without returning provider payload or credentials", async () => {
    const provider = new AlpacaPaperProvider(
      { apiKey: "exposed-api-key", secretKey: "exposed-secret-key" },
      {
        fetch: mockFetch(() => jsonResponse({
          message: "exposed-api-key exposed-secret-key sensitive-response"
        }, 401))
      }
    );
    const status = await provider.checkHealth();
    expect(status.connected).toBe(false);
    expect(status.message).toBe("Alpaca Paper authentication or free IEX validation failed.");
    expect(JSON.stringify(status)).not.toContain("exposed-api-key");
    expect(JSON.stringify(status)).not.toContain("exposed-secret-key");
    expect(JSON.stringify(status)).not.toContain("sensitive-response");
  });

  it("rejects multiline or malformed credentials before network I/O", () => {
    expect(() => new AlpacaPaperProvider({
      apiKey: "bad\napi-key",
      secretKey: "paper-secret-key"
    })).toThrow("single-line");
    expect(() => new AlpacaPaperProvider({
      apiKey: "short",
      secretKey: "paper-secret-key"
    })).toThrow("between 8 and 512");
  });

  it("reads clock, assets, multi-symbol IEX snapshots, and one-minute bars without an order endpoint", async () => {
    const requests: string[] = [];
    const provider = new AlpacaPaperProvider(
      { apiKey: "paper-api-key", secretKey: "paper-secret-key" },
      {
        fetch: mockFetch((url) => {
          requests.push(`${url.origin}${url.pathname}${url.search}`);
          if (url.pathname === "/v2/clock") {
            return jsonResponse({
              timestamp: "2026-07-16T15:00:00Z",
              is_open: true,
              next_open: "2026-07-17T13:30:00Z",
              next_close: "2026-07-16T20:00:00Z"
            });
          }
          if (url.pathname === "/v2/assets") {
            return jsonResponse([{
              symbol: "AAPL",
              name: "Apple Inc.",
              exchange: "NASDAQ",
              status: "active",
              tradable: true,
              fractionable: true,
              marginable: true,
              shortable: true,
              easy_to_borrow: true,
              attributes: ["fractional_eh_enabled", "overnight_tradable"]
            }]);
          }
          if (url.pathname === "/v2/stocks/snapshots") {
            return jsonResponse({
              AAPL: {
                latestQuote: { t: "2026-07-16T15:00:00Z", bp: 210, bs: 2, ap: 210.1, as: 3 },
                latestTrade: { t: "2026-07-16T15:00:00Z", p: 210.05, s: 1 },
                minuteBar: { t: "2026-07-16T14:59:00Z", o: 209, h: 210.2, l: 208.9, c: 210, v: 1000, n: 50, vw: 209.8 },
                dailyBar: { t: "2026-07-16T04:00:00Z", o: 205, h: 211, l: 204, c: 210, v: 200000, n: 5000, vw: 208 },
                prevDailyBar: { t: "2026-07-15T04:00:00Z", o: 203, h: 207, l: 202, c: 205, v: 190000, n: 4900, vw: 204 }
              }
            });
          }
          return jsonResponse({
            bars: {
              AAPL: [{
                t: "2026-07-16T14:59:00Z",
                o: 209,
                h: 210.2,
                l: 208.9,
                c: 210,
                v: 1000,
                n: 50,
                vw: 209.8
              }]
            },
            next_page_token: null
          });
        })
      }
    );

    await expect(provider.getClock()).resolves.toMatchObject({ isOpen: true });
    await expect(provider.getAssets()).resolves.toEqual([
      expect.objectContaining({
        symbol: "AAPL",
        fractionable: true,
        fractionalEhEnabled: true,
        overnightTradable: true,
        overnightHalted: false
      })
    ]);
    await expect(provider.getSnapshots(["AAPL"])).resolves.toEqual([
      expect.objectContaining({
        symbol: "AAPL",
        latestQuote: expect.objectContaining({ bidPrice: 210, askPrice: 210.1 })
      })
    ]);
    const bars = await provider.getBars({
      symbols: ["AAPL"],
      start: "2026-07-16T14:00:00Z",
      end: "2026-07-16T15:00:00Z"
    });
    expect(bars.bars.get("AAPL")).toEqual([
      expect.objectContaining({ close: 210, volume: 1000 })
    ]);
    expect(requests).toHaveLength(4);
    expect(requests.every((request) => !request.includes("/orders"))).toBe(true);
    const stockRequests = requests.filter((request) => request.includes("/v2/stocks/"));
    expect(stockRequests.every((request) => request.includes("feed=iex"))).toBe(true);
  });

  it("selects the free overnight snapshot feed and delayed BOATS history explicitly", async () => {
    const requests: URL[] = [];
    const provider = new AlpacaPaperProvider(
      { apiKey: "paper-api-key", secretKey: "paper-secret-key" },
      {
        fetch: mockFetch((url) => {
          requests.push(url);
          if (url.pathname.endsWith("/snapshots")) {
            return jsonResponse({
              AAPL: {
                latestQuote: { t: "2026-07-17T01:00:00Z", bp: 210, bs: 2, ap: 210.1, as: 3 },
                minuteBar: { t: "2026-07-17T00:59:00Z", o: 209, h: 210.2, l: 208.9, c: 210, v: 1000, n: 50, vw: 209.8 },
                dailyBar: { t: "2026-07-17T00:00:00Z", o: 205, h: 211, l: 204, c: 210, v: 200000, n: 5000, vw: 208 },
                prevDailyBar: { t: "2026-07-16T00:00:00Z", o: 203, h: 207, l: 202, c: 205, v: 190000, n: 4900, vw: 204 }
              }
            });
          }
          return jsonResponse({
            bars: { AAPL: [] },
            next_page_token: null
          });
        })
      }
    );

    await provider.getSnapshots(["AAPL"], "overnight");
    await provider.getBars({
      symbols: ["AAPL"],
      start: "2026-07-16T20:00:00Z",
      end: "2026-07-17T00:44:00Z",
      feed: "boats"
    });

    expect(requests[0]?.searchParams.get("feed")).toBe("overnight");
    expect(requests[1]?.searchParams.get("feed")).toBe("boats");
  });

  it("requests delayed consolidated SIP history only when the caller selects it", async () => {
    const requests: URL[] = [];
    const provider = new AlpacaPaperProvider(
      { apiKey: "paper-api-key", secretKey: "paper-secret-key" },
      {
        fetch: mockFetch((url) => {
          requests.push(url);
          return jsonResponse({ bars: { IBIT: [] }, next_page_token: null });
        })
      }
    );

    await provider.getBars({
      symbols: ["IBIT"],
      start: "2026-07-17T08:00:00Z",
      end: "2026-07-17T11:44:00Z",
      feed: "sip"
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.pathname).toBe("/v2/stocks/bars");
    expect(requests[0]?.searchParams.get("feed")).toBe("sip");
  });

  it("calls the official screener endpoints and safely normalizes ranked symbols", async () => {
    const requests: URL[] = [];
    const provider = new AlpacaPaperProvider(
      { apiKey: "paper-api-key", secretKey: "paper-secret-key" },
      {
        fetch: mockFetch((url) => {
          requests.push(url);
          if (url.pathname.endsWith("/most-actives")) {
            return jsonResponse({
              most_actives: [
                { symbol: " aapl ", volume: "125000", trade_count: "4000" },
                { symbol: "AAPL", volume: 100, trade_count: 20 },
                { symbol: "bad symbol", volume: 99, trade_count: 3 },
                { symbol: "TSLA", volume: -1, trade_count: 2 }
              ],
              last_updated: "2026-07-17T00:58:00Z"
            });
          }
          return jsonResponse({
            gainers: [
              { symbol: " nvda ", price: "201.25", change: "3.25", percent_change: "1.64" },
              { symbol: "NVDA", price: 1, change: 1, percent_change: 1 },
              { symbol: "INVALID SYMBOL", price: 5, change: 1, percent_change: 25 }
            ],
            losers: [
              { symbol: " tsla ", price: 300, change: -5, percent_change: -1.64 },
              { symbol: "ZERO", price: 0, change: -1, percent_change: -10 }
            ],
            last_updated: "2026-07-17T00:59:00Z"
          });
        })
      }
    );

    await expect(provider.getMostActives(25, "trades")).resolves.toEqual({
      stocks: [{ symbol: "AAPL", volume: 125000, tradeCount: 4000 }],
      lastUpdated: "2026-07-17T00:58:00Z"
    });
    await expect(provider.getMarketMovers(15)).resolves.toEqual({
      gainers: [{ symbol: "NVDA", price: 201.25, change: 3.25, percentChange: 1.64 }],
      losers: [{ symbol: "TSLA", price: 300, change: -5, percentChange: -1.64 }],
      lastUpdated: "2026-07-17T00:59:00Z"
    });

    expect(requests[0]?.origin).toBe(ALPACA_MARKET_DATA_ORIGIN);
    expect(requests[0]?.pathname).toBe("/v1beta1/screener/stocks/most-actives");
    expect(requests[0]?.searchParams.get("top")).toBe("25");
    expect(requests[0]?.searchParams.get("by")).toBe("trades");
    expect(requests[1]?.origin).toBe(ALPACA_MARKET_DATA_ORIGIN);
    expect(requests[1]?.pathname).toBe("/v1beta1/screener/stocks/movers");
    expect(requests[1]?.searchParams.get("top")).toBe("15");
  });

  it("calls the official news endpoint and parses only valid, de-duplicated article symbols", async () => {
    const requests: URL[] = [];
    const provider = new AlpacaPaperProvider(
      { apiKey: "paper-api-key", secretKey: "paper-secret-key" },
      {
        fetch: mockFetch((url) => {
          requests.push(url);
          return jsonResponse({
            news: [
              {
                id: "123",
                headline: " First headline ",
                summary: " Summary ",
                author: " Reporter ",
                created_at: "2026-07-17T00:50:00Z",
                updated_at: "not-a-date",
                url: "https://example.test/first",
                symbols: [" aapl ", "AAPL", "BAD SYMBOL", 7],
                source: "benzinga"
              },
              {
                id: 124,
                headline: "Second headline",
                created_at: "2026-07-17T00:55:00Z",
                updated_at: "2026-07-17T00:56:00Z",
                symbols: " tsla, brk.b, bad symbol "
              },
              {
                id: 124,
                headline: "Duplicate",
                created_at: "2026-07-17T00:57:00Z",
                symbols: ["MSFT"]
              },
              {
                id: "not-an-id",
                headline: "Malformed",
                created_at: "2026-07-17T00:58:00Z",
                symbols: ["MSFT"]
              }
            ],
            next_page_token: "next-page"
          });
        })
      }
    );

    await expect(provider.getNews({
      start: "2026-07-17T00:00:00Z",
      end: "2026-07-17T01:00:00Z",
      limit: 20
    })).resolves.toEqual({
      articles: [
        {
          id: 123,
          headline: "First headline",
          summary: "Summary",
          author: "Reporter",
          createdAt: "2026-07-17T00:50:00Z",
          updatedAt: "2026-07-17T00:50:00Z",
          url: "https://example.test/first",
          symbols: ["AAPL"],
          source: "benzinga"
        },
        {
          id: 124,
          headline: "Second headline",
          createdAt: "2026-07-17T00:55:00Z",
          updatedAt: "2026-07-17T00:56:00Z",
          symbols: ["TSLA", "BRK.B"]
        }
      ],
      nextPageToken: "next-page"
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.origin).toBe(ALPACA_MARKET_DATA_ORIGIN);
    expect(requests[0]?.pathname).toBe("/v1beta1/news");
    expect(requests[0]?.searchParams.get("start")).toBe("2026-07-17T00:00:00Z");
    expect(requests[0]?.searchParams.get("end")).toBe("2026-07-17T01:00:00Z");
    expect(requests[0]?.searchParams.get("limit")).toBe("20");
    expect(requests[0]?.searchParams.get("sort")).toBe("desc");
  });

  it("rejects screener and news requests outside Alpaca's documented limits", async () => {
    let networkCalls = 0;
    const provider = new AlpacaPaperProvider(
      { apiKey: "paper-api-key", secretKey: "paper-secret-key" },
      {
        fetch: mockFetch(() => {
          networkCalls += 1;
          return jsonResponse({});
        })
      }
    );

    await expect(provider.getMostActives(101)).rejects.toThrow("between 1 and 100");
    await expect(provider.getMarketMovers(51)).rejects.toThrow("between 1 and 50");
    await expect(provider.getNews({
      start: "2026-07-17T02:00:00Z",
      end: "2026-07-17T01:00:00Z"
    })).rejects.toThrow("start must not be after end");
    await expect(provider.getNews({
      start: "2026-07-17T00:00:00Z",
      end: "2026-07-17T01:00:00Z",
      limit: 51
    })).rejects.toThrow("between 1 and 50");
    expect(networkCalls).toBe(0);
  });
});
