import { afterEach, describe, expect, it } from "vitest";
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
    const oracle = new LocalSolPriceOracle(new Repository(db), 60_000);
    oracle.record(150, "2026-07-10T12:00:00.000Z", "fixture");
    expect(() => oracle.resolve("2026-07-10T12:02:00.000Z")).toThrow("No at-or-before");
    expect(() => oracle.resolve("2026-07-10T11:59:59.000Z")).toThrow("No at-or-before");
    expect(() => oracle.record(0, "2026-07-10T12:00:00.000Z")).toThrow("positive");
    expect(() => oracle.record(151, "2026-07-10T12:00:00.000Z", "other-source")).toThrow(
      "cannot be overwritten"
    );
  });
});
