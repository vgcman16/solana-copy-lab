import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  COPYLAB_SCHEMA_VERSION,
  openDatabase,
  type CopyLabDatabase
} from "../src/database.js";

function columns(db: CopyLabDatabase, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((column) => column.name);
}

function uniqueIndexColumns(db: CopyLabDatabase, table: string): string[] {
  return (db.pragma(`index_list(${table})`) as Array<{ name: string; unique: number }>)
    .filter((index) => index.unique === 1)
    .map((index) => (db.pragma(`index_info(${JSON.stringify(index.name)})`) as Array<{ name: string }>)
      .map((column) => column.name)
      .join(","));
}

describe("schema v43 stock PAPER rotation shadow", () => {
  let db: CopyLabDatabase | undefined;
  let directory: string | undefined;

  afterEach(() => {
    db?.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it("migrates a v42 database to the isolated append-only decision and outcome ledgers", () => {
    directory = mkdtempSync(join(tmpdir(), "copylab-schema-v43-"));
    const databasePath = join(directory, "copylab.db");
    const legacy = new Database(databasePath);
    legacy.pragma("user_version = 42");
    legacy.close();

    db = openDatabase(databasePath);

    expect(COPYLAB_SCHEMA_VERSION).toBe(47);
    expect(db.pragma("user_version", { simple: true })).toBe(COPYLAB_SCHEMA_VERSION);
    expect(columns(db, "stock_paper_rotation_decisions")).toEqual([
      "id",
      "idempotency_key",
      "lane_id",
      "policy_digest",
      "idempotency_bucket",
      "decision_at",
      "status",
      "decision_json"
    ]);
    expect(columns(db, "stock_paper_rotation_outcomes")).toEqual([
      "id",
      "idempotency_key",
      "decision_id",
      "lane_id",
      "horizon_minutes",
      "status",
      "due_at",
      "labeled_at",
      "outcome_json"
    ]);
    expect(columns(db, "stock_paper_capital_events")).toEqual([
      "id",
      "idempotency_key",
      "lane_id",
      "event_type",
      "delta_usd",
      "target_nav_usd",
      "created_at",
      "event_json"
    ]);
    expect(uniqueIndexColumns(db, "stock_paper_capital_events"))
      .toEqual(expect.arrayContaining(["idempotency_key"]));
    expect(uniqueIndexColumns(db, "stock_paper_rotation_decisions")).toEqual(expect.arrayContaining([
      "idempotency_key",
      "id,lane_id",
      "lane_id,policy_digest,idempotency_bucket"
    ]));
    expect(uniqueIndexColumns(db, "stock_paper_rotation_outcomes")).toEqual(expect.arrayContaining([
      "idempotency_key",
      "decision_id,horizon_minutes"
    ]));
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("creates both rotation ledgers and their due/recent indexes in a fresh database", () => {
    db = openDatabase(":memory:");

    const indexes = db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'index' AND name LIKE 'stock_paper_rotation_%'
      ORDER BY name
    `).all() as Array<{ name: string }>;

    expect(indexes.map((index) => index.name)).toEqual(expect.arrayContaining([
      "stock_paper_rotation_decisions_due",
      "stock_paper_rotation_decisions_recent",
      "stock_paper_rotation_outcomes_decision",
      "stock_paper_rotation_outcomes_lane_time"
    ]));
    expect(db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND name = 'stock_paper_capital_events_lane_time'
    `).get()).toEqual({ name: "stock_paper_capital_events_lane_time" });
    expect(db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN (
        'stock_paper_rotation_decisions', 'stock_paper_rotation_outcomes'
      ) ORDER BY name
    `).all()).toEqual([
      { name: "stock_paper_rotation_decisions" },
      { name: "stock_paper_rotation_outcomes" }
    ]);
  });
});
