import { describe, expect, it, vi } from "vitest";
import { BirdeyeProvider, OneRequestPerSecondQueue } from "../src/birdeye.js";
import { jsonResponse, mockFetch } from "./helpers.js";

describe("BirdeyeProvider", () => {
  it("discovers and freezes one weekly cohort from 30d/90d gainers and losers", async () => {
    const requests: URL[] = [];
    const usage: Array<{ path: string; credits: number }> = [];
    const fetch = mockFetch((url) => {
      requests.push(url);
      const duration = url.searchParams.get("type");
      const sort = url.searchParams.get("sort_type");
      const offset = Number(url.searchParams.get("offset") ?? "0");
      const address = sort === "desc" ? `winner-${duration}-${offset}` : `control-${duration}`;
      return jsonResponse({ success: true, data: { items: [{ address, tags: ["Smart-Money"] }] } });
    });
    const provider = new BirdeyeProvider("key", {
      fetch,
      minimumRequestIntervalMs: 0,
      onRequest: (entry) => usage.push(entry),
      now: () => new Date("2026-07-09T12:00:00Z")
    });

    const first = await provider.discoverCohort();
    const second = await provider.discoverCohort(new Date("2026-07-10T00:00:00Z"));

    expect(first.cohortId).toBe("birdeye-2026-07-06");
    expect(first.candidates).toHaveLength(6);
    expect(first.candidates.filter((candidate) => candidate.control)).toHaveLength(2);
    expect(first.candidates.find((candidate) => candidate.address === "winner-30d-0")?.sourceRank30d).toBe(1);
    expect(first.candidates.find((candidate) => candidate.address === "winner-30d-100")?.sourceRank30d).toBe(101);
    expect(first.candidates[0]?.tags).toContain("smart-money");
    expect(second).toEqual(first);
    expect(requests).toHaveLength(6);
    expect(requests.map((url) => [
      url.searchParams.get("type"),
      url.searchParams.get("sort_type"),
      url.searchParams.get("offset")
    ])).toEqual([
      ["30d", "desc", "0"],
      ["30d", "desc", "100"],
      ["30d", "asc", "0"],
      ["90d", "desc", "0"],
      ["90d", "desc", "100"],
      ["90d", "asc", "0"]
    ]);
    expect(requests.every((url) => url.searchParams.get("limit") === "100")).toBe(true);
    expect(usage).toEqual(Array.from({ length: 6 }, () => ({
      path: "/trader/gainers-losers",
      credits: 30
    })));
  });

  it("parses the current nested wallet PnL summary envelope", async () => {
    const fetch = mockFetch(() => jsonResponse({
      success: true,
      data: {
        summary: {
          counts: { total_trade: 80, total_win: 50, total_loss: 30 },
          cashflow_usd: { buy: 1_000, sell: 1_125.5 },
          pnl: {
            realized_profit_usd: 125.5,
            realized_profit_percent: 22.5,
            unrealized_usd: 8.25
          }
        }
      }
    }));
    const provider = new BirdeyeProvider("key", { fetch, minimumRequestIntervalMs: 0 });
    await expect(provider.getPnl("wallet", "30d")).resolves.toEqual({
      duration: "30d",
      realizedProfitUsd: 125.5,
      realizedProfitPercent: 22.5,
      unrealizedProfitUsd: 8.25,
      totalTrades: 80,
      wins: 50,
      losses: 30
    });
  });

  it("preserves the legacy direct wallet PnL summary envelope", async () => {
    const fetch = mockFetch(() => jsonResponse({
      success: true,
      data: {
        counts: { total_trade: 80, total_win: 50, total_loss: 30 },
        pnl: {
          realized_profit_usd: 125.5,
          realized_profit_percent: 22.5,
          unrealized_usd: 8.25
        }
      }
    }));
    const provider = new BirdeyeProvider("key", { fetch, minimumRequestIntervalMs: 0 });
    await expect(provider.getPnl("wallet", "30d")).resolves.toEqual({
      duration: "30d",
      realizedProfitUsd: 125.5,
      realizedProfitPercent: 22.5,
      unrealizedProfitUsd: 8.25,
      totalTrades: 80,
      wins: 50,
      losses: 30
    });
  });

  it("fails closed when the selected PnL summary omits a required realized metric", async () => {
    const provider = new BirdeyeProvider("key", {
      minimumRequestIntervalMs: 0,
      fetch: mockFetch(() => jsonResponse({
        success: true,
        data: {
          summary: {
            counts: { total_trade: 80 },
            pnl: { realized_profit_usd: 125.5 }
          }
        }
      }))
    });

    await expect(provider.getPnl("wallet", "30d"))
      .rejects.toThrow("Birdeye PnL response omitted realized profit percent");
  });

  it("serializes starts at no more than one request per configured interval", async () => {
    let clock = 0;
    const starts: number[] = [];
    const queue = new OneRequestPerSecondQueue(
      1_000,
      () => clock,
      async (milliseconds) => { clock += milliseconds; }
    );
    await Promise.all([0, 1, 2].map(() => queue.schedule(async () => { starts.push(clock); })));
    expect(starts).toEqual([0, 1_000, 2_000]);
  });

  it("keeps default health-to-discovery request starts beyond the one-second boundary", async () => {
    const baseTime = Date.parse("2026-07-09T12:00:00Z");
    let elapsedMs = 0;
    const starts: number[] = [];
    const provider = new BirdeyeProvider("key", {
      now: () => new Date(baseTime + elapsedMs),
      sleep: async (milliseconds) => { elapsedMs += milliseconds; },
      fetch: mockFetch(() => {
        starts.push(elapsedMs);
        return jsonResponse({ success: true, data: { items: [{ address: "wallet" }] } });
      })
    });

    await expect(provider.checkHealth()).resolves.toMatchObject({ ok: true });
    await expect(provider.discoverCohort()).resolves.toMatchObject({
      candidates: expect.any(Array)
    });
    expect(starts).toEqual([0, 1_100, 2_200, 3_300, 4_400, 5_500, 6_600]);
  });

  it("uses the low-cost credits endpoint and caches a healthy diagnostic", async () => {
    const urls: URL[] = [];
    const provider = new BirdeyeProvider("key", {
      minimumRequestIntervalMs: 0,
      now: () => new Date("2026-07-09T12:00:00Z"),
      fetch: mockFetch((url) => {
        urls.push(url);
        return jsonResponse({ success: true, data: { used: 10, limit: 30_000 } });
      })
    });

    const first = await provider.checkHealth();
    const second = await provider.checkHealth();

    expect(first.ok).toBe(true);
    expect(second).toEqual(first);
    expect(urls).toHaveLength(1);
    expect(urls[0]?.pathname).toBe("/utils/v1/credits");
  });

  it("retries HTTP 429 twice through the same serialized queue", async () => {
    const baseTime = Date.parse("2026-07-09T12:00:00Z");
    let elapsedMs = 0;
    let calls = 0;
    const starts: number[] = [];
    const usage: Array<{ path: string; credits: number }> = [];
    const provider = new BirdeyeProvider("key", {
      now: () => new Date(baseTime + elapsedMs),
      sleep: async (milliseconds) => { elapsedMs += milliseconds; },
      onRequest: (entry) => usage.push(entry),
      fetch: mockFetch(() => {
        starts.push(elapsedMs);
        calls += 1;
        return calls < 3
          ? jsonResponse({ message: "Too many requests" }, 429)
          : jsonResponse({ success: true, data: { items: [{ address: "wallet" }] } });
      })
    });

    await expect(provider.checkHealth()).resolves.toMatchObject({
      ok: true,
      usage: { requests: 3 }
    });
    expect(starts).toEqual([0, 1_100, 2_200]);
    expect(usage).toEqual(Array.from({ length: 3 }, () => ({
      path: "/utils/v1/credits",
      credits: 1
    })));
  });

  it("stops after the bounded number of HTTP 429 retries", async () => {
    let elapsedMs = 0;
    let calls = 0;
    const provider = new BirdeyeProvider("key", {
      now: () => new Date(Date.parse("2026-07-09T12:00:00Z") + elapsedMs),
      sleep: async (milliseconds) => { elapsedMs += milliseconds; },
      fetch: mockFetch(() => {
        calls += 1;
        return jsonResponse({ message: "Too many requests" }, 429);
      })
    });

    await expect(provider.checkHealth()).resolves.toMatchObject({
      ok: false,
      usage: { requests: 3 }
    });
    expect(calls).toBe(3);
    expect(elapsedMs).toBe(2_200);
  });

  it("reserves request cost before network I/O and honors a fail-closed budget rejection", async () => {
    const fetch = vi.fn();
    const provider = new BirdeyeProvider("key", {
      minimumRequestIntervalMs: 0,
      fetch,
      onRequest: ({ path, credits }) => {
        expect(path).toBe("/wallet/v2/pnl/summary");
        expect(credits).toBe(30);
        throw new Error("monthly budget exhausted");
      }
    });

    await expect(provider.getPnl("wallet", "30d")).rejects.toThrow("monthly budget exhausted");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns a diagnostic health result rather than leaking an exception", async () => {
    let calls = 0;
    const provider = new BirdeyeProvider("bad", {
      fetch: mockFetch(() => {
        calls += 1;
        return jsonResponse({ message: "Unauthorized" }, 401);
      }),
      minimumRequestIntervalMs: 0
    });
    const health = await provider.checkHealth();
    expect(health.ok).toBe(false);
    expect(health.message).toContain("HTTP 401");
    expect(health.message).not.toContain("bad");
    expect(calls).toBe(1);
  });
});
