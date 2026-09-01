import { describe, expect, it } from "vitest";
import {
  ALPACA_MARKET_DATA_ORIGIN,
  ALPACA_PAPER_TRADING_ORIGIN,
  AlpacaPaperProvider
} from "../src/alpaca-paper.js";
import { jsonResponse, mockFetch } from "./helpers.js";

function providerWith(
  implementation: Parameters<typeof mockFetch>[0]
): AlpacaPaperProvider {
  return new AlpacaPaperProvider(
    { apiKey: "paper-api-key", secretKey: "paper-secret-key" },
    { fetch: mockFetch(implementation) }
  );
}

describe("AlpacaPaperProvider market-safety endpoints", () => {
  it("forwards an opaque news page token and normalizes the returned next token", async () => {
    const requests: URL[] = [];
    const provider = providerWith((url) => {
      requests.push(url);
      return jsonResponse({ news: [], next_page_token: " next-page/+= " });
    });

    await expect(provider.getNews({
      start: "2026-07-16T22:00:00Z",
      end: "2026-07-16T23:00:00Z",
      limit: 10,
      pageToken: " opaque-page/+= "
    })).resolves.toEqual({
      articles: [],
      nextPageToken: "next-page/+="
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.origin).toBe(ALPACA_MARKET_DATA_ORIGIN);
    expect(requests[0]?.pathname).toBe("/v1beta1/news");
    expect(requests[0]?.searchParams.get("page_token")).toBe("opaque-page/+=");

    await expect(provider.getNews({
      start: "2026-07-16T22:00:00Z",
      end: "2026-07-16T23:00:00Z",
      pageToken: "bad\npage"
    })).rejects.toThrow("page token is invalid");
    expect(requests).toHaveLength(1);
  });

  it("uses the paper calendar route and keeps only normalized complete market days", async () => {
    const requests: URL[] = [];
    const provider = providerWith((url) => {
      requests.push(url);
      return jsonResponse([
        { date: " 2026-07-16 ", open: " 09:30 ", close: " 16:00 " },
        { date: "2026-07-17", open: "09:30", close: "13:00" },
        { date: "2026-7-18", open: "09:30", close: "16:00" },
        { date: "2026-07-19", open: "", close: "16:00" },
        null
      ]);
    });

    await expect(provider.getCalendar("2026-07-16", "2026-07-19")).resolves.toEqual([
      { date: "2026-07-16", open: "09:30", close: "16:00" },
      { date: "2026-07-17", open: "09:30", close: "13:00" }
    ]);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.origin).toBe(ALPACA_PAPER_TRADING_ORIGIN);
    expect(requests[0]?.pathname).toBe("/v2/calendar");
    expect(requests[0]?.searchParams.get("start")).toBe("2026-07-16");
    expect(requests[0]?.searchParams.get("end")).toBe("2026-07-19");
  });

  it("uses the corporate-actions route and normalizes typed and collection-derived actions", async () => {
    const requests: URL[] = [];
    const provider = providerWith((url) => {
      requests.push(url);
      return jsonResponse({
        reverse_splits: [
          {
            id: " split-1 ",
            symbol: " aapl ",
            type: " reverse_split ",
            process_date: " 2026-07-18 "
          },
          { id: "", symbol: "MSFT", process_date: "2026-07-18" },
          { id: "split-invalid", symbol: "bad symbol", process_date: "2026-07-18" }
        ],
        cash_mergers: [
          { id: "merger-1", symbol: " brk.b ", ex_date: " 2026-07-19 " }
        ],
        next_page_token: " next-actions/+= "
      });
    });

    await expect(provider.getCorporateActions({
      symbols: [" aapl ", "AAPL", " brk.b ", "bad symbol"],
      start: "2026-07-16",
      end: "2026-07-20",
      pageToken: " actions-page/+= "
    })).resolves.toEqual({
      actions: [
        {
          id: "split-1",
          type: "reverse_split",
          symbol: "AAPL",
          processDate: "2026-07-18"
        },
        {
          id: "merger-1",
          type: "cash_merger",
          symbol: "BRK.B",
          processDate: "2026-07-19"
        }
      ],
      nextPageToken: "next-actions/+="
    });

    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.origin).toBe(ALPACA_MARKET_DATA_ORIGIN);
    expect(request.pathname).toBe("/v1/corporate-actions");
    expect(request.searchParams.get("symbols")).toBe("AAPL,BRK.B");
    expect(request.searchParams.get("start")).toBe("2026-07-16");
    expect(request.searchParams.get("end")).toBe("2026-07-20");
    expect(request.searchParams.get("region")).toBe("us");
    expect(request.searchParams.get("limit")).toBe("1000");
    expect(request.searchParams.get("page_token")).toBe("actions-page/+=");
    expect(request.searchParams.get("types")?.split(",")).toEqual([
      "reverse_split",
      "forward_split",
      "unit_split",
      "spin_off",
      "cash_merger",
      "stock_merger",
      "stock_and_cash_merger",
      "redemption",
      "name_change",
      "worthless_removal",
      "rights_distribution",
      "partial_call",
      "reorganization"
    ]);
  });
});
