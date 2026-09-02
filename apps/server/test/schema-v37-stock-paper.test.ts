import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type CopyLabDatabase, COPYLAB_SCHEMA_VERSION } from "../src/database.js";
import { StockPaperRepository } from "../src/stock-paper-repository.js";

describe("current isolated stock paper ledger", () => {
  let db: CopyLabDatabase | undefined;

  afterEach(() => db?.close());

  it("creates the isolated tables and round-trips a dashboard cycle", () => {
    db = openDatabase(":memory:");
    expect(db.pragma("user_version", { simple: true })).toBe(COPYLAB_SCHEMA_VERSION);
    const tables = new Set((db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table'
    `).all() as Array<{ name: string }>).map((row) => row.name));
    for (const table of [
      "stock_paper_lanes",
      "stock_paper_accounts",
      "stock_paper_positions",
      "stock_paper_signals",
      "stock_paper_trades",
      "stock_paper_equity_points",
      "stock_paper_bars",
      "stock_paper_candidates",
      "stock_paper_orders",
      "stock_paper_observations",
      "stock_paper_observation_outcomes",
      "stock_paper_shadow_results",
      "stock_paper_news_evidence",
      "stock_paper_learning_checkpoints"
    ]) expect(tables.has(table)).toBe(true);
    expect((db.pragma("table_info(stock_paper_learning_checkpoints)") as Array<{ name: string }>)
      .map((column) => column.name)).toEqual([
      "id",
      "lane_id",
      "dataset_digest",
      "evaluation_digest",
      "captured_at",
      "cutoff_at",
      "checkpoint_json"
    ]);
    const checkpointUniqueColumns = (db.pragma("index_list(stock_paper_learning_checkpoints)") as Array<{
      name: string;
      unique: number;
    }>).filter((index) => index.unique === 1).map((index) =>
      (db!.pragma(`index_info(${JSON.stringify(index.name)})`) as Array<{ name: string }>)
        .map((column) => column.name)
    );
    expect(checkpointUniqueColumns).toContainEqual(["lane_id", "evaluation_digest"]);
    expect(checkpointUniqueColumns).not.toContainEqual(["lane_id", "dataset_digest"]);

    const repository = new StockPaperRepository(db);
    const now = "2026-07-16T15:00:00.000Z";
    const lane = repository.ensureActiveLane(now);
    const account = repository.account(lane.id)!;
    repository.commitCycle({
      account,
      positions: [],
      equityPoint: {
        capturedAt: now,
        navUsd: 141,
        cashUsd: 141,
        deployedUsd: 0,
        drawdownPercent: 0,
        benchmarkReturnPercent: 0
      },
      candidates: [{
        symbol: "AAPL",
        priceUsd: 210,
        bidUsd: 209.9,
        askUsd: 210,
        spreadPercent: 0.05,
        change1mPercent: 0.2,
        change5mPercent: 1,
        change15mPercent: 2,
        changeFromOpenPercent: 3,
        dailyChangePercent: 4,
        relativeVolume: 2,
        dollarVolumeUsd: 100_000_000,
        vwapDistancePercent: 1,
        score: 82,
        arm: "BREAKOUT",
        highConviction: true,
        eligible: true,
        reasons: [],
        capturedAt: now
      }],
      bars: [208, 209, 210].map((close, index) => ({
        symbol: "AAPL",
        bar: {
          timestamp: new Date(Date.parse(now) - (2 - index) * 60_000).toISOString(),
          open: close - 0.1,
          high: close + 0.2,
          low: close - 0.2,
          close,
          volume: 10_000 + index,
          tradeCount: 100 + index,
          vwap: close - 0.05
        }
      })),
      market: {
        feed: "IEX",
        isOpen: true,
        phase: "REGULAR",
        scannedSymbols: 280,
        detailedSymbols: 30,
        providerRequests: 6,
        lastScanAt: now
      }
    });
    expect(repository.dashboard()).toMatchObject({
      executionEnabled: false,
      promotionEligible: false,
      paperOnly: true,
      account: { navUsd: 141 },
      candidates: [{
        symbol: "AAPL",
        eligible: true,
        sparklinePricesUsd: [208, 209, 210]
      }],
      market: { feed: "IEX", isOpen: true }
    });
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("keeps the equity dashboard projection bounded without shortening its source horizon", () => {
    db = openDatabase(":memory:");
    const repository = new StockPaperRepository(db);
    const startedAt = "2026-01-01T00:00:00.000Z";
    const lane = repository.ensureActiveLane(startedAt);
    const insert = db.prepare(`
      INSERT INTO stock_paper_equity_points(lane_id, captured_at, point_json)
      VALUES (?, ?, ?)
    `);
    db.transaction(() => {
      for (let index = 0; index < 720; index += 1) {
        const capturedAt = new Date(Date.parse(startedAt) + index * 60_000).toISOString();
        insert.run(lane.id, capturedAt, JSON.stringify({
          capturedAt,
          navUsd: index === 411 ? 750 : 1_000 + index / 10,
          cashUsd: 1_000,
          deployedUsd: 0,
          drawdownPercent: index === 411 ? 25 : 0
        }));
      }
    })();

    const curve = repository.dashboard().equityCurve;
    expect(curve).toHaveLength(240);
    expect(curve[0]?.capturedAt).toBe(startedAt);
    expect(curve.at(-1)?.capturedAt).toBe(
      new Date(Date.parse(startedAt) + 719 * 60_000).toISOString()
    );
    expect(curve.some((point) => point.drawdownPercent === 25 && point.navUsd === 750)).toBe(true);
    expect(curve.every((point, index) => index === 0 || point.capturedAt > curve[index - 1]!.capturedAt))
      .toBe(true);
  });
});
