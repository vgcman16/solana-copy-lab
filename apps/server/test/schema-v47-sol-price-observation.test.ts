import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { COPYLAB_SCHEMA_VERSION, openDatabase, type CopyLabDatabase } from "../src/database.js";

describe("schema v47 SOL price observation provenance", () => {
  const workspaceData = resolve("data");
  let temporaryRoot: string | undefined;
  let db: CopyLabDatabase | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
    if (!temporaryRoot) return;
    const resolved = resolve(temporaryRoot);
    const prefix = `${workspaceData}${resolved.includes("\\") ? "\\" : "/"}`;
    if (!resolved.startsWith(prefix)) throw new Error("Unsafe migration-test cleanup path.");
    rmSync(resolved, { recursive: true, force: true });
    temporaryRoot = undefined;
  });

  it("migrates v46 insert-only rows without inventing unavailable legacy provenance", () => {
    mkdirSync(workspaceData, { recursive: true });
    temporaryRoot = mkdtempSync(join(workspaceData, "schema-v47-sol-observation-test-"));
    const path = join(temporaryRoot, "copylab.db");
    db = openDatabase(path);
    db.exec(`
      DROP INDEX sol_price_snapshot_observation_time;
      DROP INDEX sol_price_snapshot_time;
      ALTER TABLE sol_price_snapshots RENAME TO sol_price_snapshots_v47;
      CREATE TABLE sol_price_snapshots (
        captured_at TEXT PRIMARY KEY,
        price_usd REAL NOT NULL CHECK(price_usd > 0),
        source TEXT NOT NULL
      );
      INSERT INTO sol_price_snapshots(captured_at, price_usd, source) VALUES
        ('2026-07-14T09:10:00.000Z', 75.1, 'birdeye_ohlcv_v3'),
        ('2026-07-14T09:20:00.000Z', 75.2, 'birdeye_ohlcv_v3_prev_5m'),
        ('2026-07-14T09:30:00.000Z', 75.3, 'pyth_benchmarks');
      DROP TABLE sol_price_snapshots_v47;
      CREATE INDEX sol_price_snapshot_time ON sol_price_snapshots(captured_at DESC);
    `);
    db.pragma("user_version = 46");
    db.close();
    db = undefined;

    const legacy = new Database(path);
    expect(legacy.pragma("user_version", { simple: true })).toBe(46);
    legacy.close();

    db = openDatabase(path);
    expect(COPYLAB_SCHEMA_VERSION).toBe(47);
    expect(db.pragma("user_version", { simple: true })).toBe(COPYLAB_SCHEMA_VERSION);
    expect((db.pragma("table_info(sol_price_snapshots)") as Array<{
      name: string;
      notnull: number;
    }>).map(({ name, notnull }) => ({ name, notnull }))).toEqual([
      { name: "captured_at", notnull: 0 },
      { name: "observed_at", notnull: 1 },
      { name: "price_usd", notnull: 1 },
      { name: "source", notnull: 1 }
    ]);
    expect(db.prepare(`
      SELECT captured_at, observed_at, price_usd, source
      FROM sol_price_snapshots
      ORDER BY captured_at
    `).all()).toEqual([
      {
        captured_at: "2026-07-14T09:10:00.000Z",
        observed_at: "2026-07-14T09:10:00.000Z",
        price_usd: 75.1,
        source: "birdeye_ohlcv_v3"
      },
      {
        captured_at: "2026-07-14T09:20:00.000Z",
        observed_at: "2026-07-14T09:15:00.000Z",
        price_usd: 75.2,
        source: "birdeye_ohlcv_v3_prev_5m"
      },
      {
        captured_at: "2026-07-14T09:30:00.000Z",
        observed_at: "2026-07-14T09:30:00.000Z",
        price_usd: 75.3,
        source: "pyth_benchmarks"
      }
    ]);
    const indexes = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND name LIKE 'sol_price_snapshot_%'
      ORDER BY name
    `).all() as Array<{ name: string }>;
    expect(indexes.map(({ name }) => name)).toEqual([
      "sol_price_snapshot_observation_time",
      "sol_price_snapshot_time"
    ]);
    const nearestPlan = db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT captured_at, price_usd, source
      FROM sol_price_snapshots
      WHERE observed_at BETWEEN ? AND ?
      ORDER BY observed_at DESC, captured_at DESC
      LIMIT 1
    `).all("2026-07-14T09:00:00.000Z", "2026-07-14T09:30:00.000Z") as Array<{
      detail: string;
    }>;
    expect(nearestPlan.some(({ detail }) =>
      detail.includes("INDEX sol_price_snapshot_observation_time")
    )).toBe(true);
    expect(db.pragma("foreign_key_check")).toEqual([]);

    db.close();
    db = openDatabase(path);
    expect(db.pragma("user_version", { simple: true })).toBe(47);
    expect(db.prepare("SELECT COUNT(*) AS count FROM sol_price_snapshots").get())
      .toEqual({ count: 3 });
  });

  it("upgrades an older all-schema migration before creating the observation index", () => {
    mkdirSync(workspaceData, { recursive: true });
    temporaryRoot = mkdtempSync(join(workspaceData, "schema-v43-sol-observation-test-"));
    const path = join(temporaryRoot, "copylab.db");
    db = openDatabase(path);
    db.exec(`
      DROP INDEX sol_price_snapshot_observation_time;
      DROP INDEX sol_price_snapshot_time;
      ALTER TABLE sol_price_snapshots RENAME TO sol_price_snapshots_v47;
      CREATE TABLE sol_price_snapshots (
        captured_at TEXT PRIMARY KEY,
        price_usd REAL NOT NULL CHECK(price_usd > 0),
        source TEXT NOT NULL
      );
      INSERT INTO sol_price_snapshots(captured_at, price_usd, source)
      VALUES ('2026-07-14T09:20:00.000Z', 75.2, 'birdeye_ohlcv_v3_prev_5m');
      DROP TABLE sol_price_snapshots_v47;
      CREATE INDEX sol_price_snapshot_time ON sol_price_snapshots(captured_at DESC);
    `);
    db.pragma("user_version = 43");
    db.close();
    db = undefined;

    db = openDatabase(path);
    expect(db.pragma("user_version", { simple: true })).toBe(47);
    expect(db.prepare(`
      SELECT captured_at, observed_at, price_usd, source FROM sol_price_snapshots
    `).get()).toEqual({
      captured_at: "2026-07-14T09:20:00.000Z",
      observed_at: "2026-07-14T09:15:00.000Z",
      price_usd: 75.2,
      source: "birdeye_ohlcv_v3_prev_5m"
    });
    expect((db.pragma("table_info(sol_price_snapshots)") as Array<{
      name: string;
      notnull: number;
    }>).find(({ name }) => name === "observed_at")).toMatchObject({ notnull: 1 });
    expect(db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND name = 'sol_price_snapshot_observation_time'
    `).get()).toEqual({ name: "sol_price_snapshot_observation_time" });
  });
});
