import { afterEach, describe, expect, it } from "vitest";
import { BIRDEYE_SOL_USD_HISTORY_PREVIOUS_5M_SOURCE } from "@copylab/providers";
import { openDatabase, type CopyLabDatabase } from "../src/database.js";
import { LocalSolPriceOracle } from "../src/local-sol-price.js";
import { Repository } from "../src/repository.js";

describe("LocalSolPriceOracle", () => {
  let db: CopyLabDatabase | undefined;
  afterEach(() => db?.close());

  it("selects only the newest at-or-before price and exposes durable coverage", () => {
    db = openDatabase(":memory:");
    const oracle = new LocalSolPriceOracle(new Repository(db), 5 * 60_000);
    oracle.record(150, "2026-07-10T11:58:00.000Z", "fixture");
    oracle.record(151, "2026-07-10T12:03:00.000Z", "fixture");
    expect(oracle.resolve("2026-07-10T12:00:00.000Z")).toBe(150);
    expect(oracle.coverage()).toEqual({
      count: 2,
      pendingSwapReprices: 0,
      outOfHorizonSwapReprices: 0,
      oldestAt: "2026-07-10T11:58:00.000Z",
      newestAt: "2026-07-10T12:03:00.000Z",
      largestGapSeconds: expect.closeTo(300, 3)
    });
    expect(db.pragma("user_version", { simple: true })).toBeGreaterThanOrEqual(16);
  });

  it("reports the largest durable gap instead of trusting endpoint timestamps alone", () => {
    db = openDatabase(":memory:");
    const oracle = new LocalSolPriceOracle(new Repository(db));
    oracle.record(150, "2026-07-10T11:00:00.000Z", "fixture");
    oracle.record(151, "2026-07-10T11:05:00.000Z", "fixture");
    oracle.record(152, "2026-07-10T11:30:00.000Z", "fixture");

    expect(oracle.coverage()).toMatchObject({ largestGapSeconds: expect.closeTo(1_500, 3) });
  });

  it("orders prices by their effective observation rather than the fallback grid timestamp", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const oracle = new LocalSolPriceOracle(repository);
    repository.saveSolPriceSnapshot({
      capturedAt: "2026-07-10T12:00:00.000Z",
      observedAt: "2026-07-10T11:55:00.000Z",
      priceUsd: 150,
      source: BIRDEYE_SOL_USD_HISTORY_PREVIOUS_5M_SOURCE
    });
    oracle.record(151, "2026-07-10T11:58:00.000Z", "fixture");

    expect(oracle.resolve("2026-07-10T12:00:00.000Z")).toBe(151);
  });

  it("expires previous-five-minute evidence ten minutes after its real observation", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const oracle = new LocalSolPriceOracle(repository);
    repository.saveSolPriceSnapshot({
      capturedAt: "2026-07-10T12:00:00.000Z",
      observedAt: "2026-07-10T11:55:00.000Z",
      priceUsd: 150,
      source: BIRDEYE_SOL_USD_HISTORY_PREVIOUS_5M_SOURCE
    });

    expect(oracle.resolve("2026-07-10T12:05:00.000Z")).toBe(150);
    expect(() => oracle.resolve("2026-07-10T12:05:00.001Z")).toThrow("No at-or-before");
    expect(() => oracle.resolve("2026-07-10T11:54:59.999Z")).toThrow("No at-or-before");
  });

  it("measures coverage gaps from the fallback's real observation time", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const oracle = new LocalSolPriceOracle(repository);
    oracle.record(149, "2026-07-10T11:50:00.000Z", "fixture");
    repository.saveSolPriceSnapshot({
      capturedAt: "2026-07-10T12:00:00.000Z",
      observedAt: "2026-07-10T11:55:00.000Z",
      priceUsd: 150,
      source: BIRDEYE_SOL_USD_HISTORY_PREVIOUS_5M_SOURCE
    });
    oracle.record(151, "2026-07-10T12:10:00.000Z", "fixture");

    expect(oracle.coverage()).toMatchObject({
      count: 3,
      oldestAt: "2026-07-10T11:50:00.000Z",
      newestAt: "2026-07-10T12:10:00.000Z",
      largestGapSeconds: expect.closeTo(900, 3)
    });
  });

  it("reduces a truthful fallback gap from 900 to 600 seconds with a real following candle", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const oracle = new LocalSolPriceOracle(repository);
    oracle.record(149, "2026-07-10T11:50:00.000Z", "fixture");
    repository.saveSolPriceSnapshot({
      capturedAt: "2026-07-10T12:00:00.000Z",
      observedAt: "2026-07-10T11:55:00.000Z",
      priceUsd: 150,
      source: BIRDEYE_SOL_USD_HISTORY_PREVIOUS_5M_SOURCE
    });
    repository.saveSolPriceSnapshot({
      capturedAt: "2026-07-10T12:05:00.000Z",
      observedAt: "2026-07-10T12:05:00.000Z",
      priceUsd: 150.5,
      source: "birdeye_ohlcv_v3"
    });
    oracle.record(151, "2026-07-10T12:10:00.000Z", "fixture");

    expect(() => oracle.resolve("2026-07-10T12:04:59.999Z")).not.toThrow();
    expect(oracle.resolve("2026-07-10T12:04:59.999Z")).toBe(150);
    expect(oracle.coverage()).toMatchObject({ count: 4, largestGapSeconds: expect.closeTo(600, 3) });
  });

  it("uses a covering swap index for pending reprice coverage", () => {
    db = openDatabase(":memory:");
    const index = db.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type = 'index' AND name = 'indexed_spot_swaps_reprice_time'
    `).get() as { sql: string } | undefined;
    expect(index?.sql).toContain("indexed_spot_swaps(id, block_time)");

    const plan = db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT
        SUM(CASE WHEN swap.block_time >= ? THEN 1 ELSE 0 END),
        SUM(CASE WHEN swap.block_time < ? THEN 1 ELSE 0 END)
      FROM indexed_swap_reprice_queue queue
      JOIN indexed_spot_swaps swap INDEXED BY indexed_spot_swaps_reprice_time
        ON swap.id = queue.swap_id
      WHERE queue.status = 'PENDING'
    `).all("2026-04-01T00:00:00.000Z", "2026-04-01T00:00:00.000Z") as Array<{ detail: string }>;
    const details = plan.map((step) => step.detail).join("\n");
    expect(details).toContain("USING COVERING INDEX indexed_spot_swaps_reprice_time");
  });

  it("fails closed outside the configured historical tolerance", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const oracle = new LocalSolPriceOracle(repository, 60_000);
    oracle.record(150, "2026-07-10T12:00:00.000Z", "fixture");
    expect(() => oracle.resolve("2026-07-10T12:02:00.000Z")).toThrow("No at-or-before");
    expect(() => oracle.resolve("2026-07-10T11:59:59.000Z")).toThrow("No at-or-before");
    expect(() => oracle.record(0, "2026-07-10T12:00:00.000Z")).toThrow("positive");
    expect(() => oracle.record(151, "2026-07-10T12:00:00.000Z", "other-source")).toThrow(
      "cannot be overwritten"
    );
    expect(() => repository.saveSolPriceSnapshot({
      capturedAt: "2026-07-10T12:00:00.000Z",
      observedAt: "2026-07-10T11:59:00.000Z",
      priceUsd: 150,
      source: "fixture"
    })).toThrow("cannot be overwritten");
    repository.saveSolPriceSnapshot({
      capturedAt: "2026-07-10T12:05:00.000Z",
      observedAt: "2026-07-10T12:05:00.001Z",
      priceUsd: 150,
      source: "fixture"
    });
    expect(() => oracle.resolve("2026-07-10T12:05:00.000Z")).toThrow("No at-or-before");
    expect(oracle.resolve("2026-07-10T12:05:00.001Z")).toBe(150);
  });
});
