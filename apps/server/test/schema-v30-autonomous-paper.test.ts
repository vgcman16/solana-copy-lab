import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { COPYLAB_SCHEMA_VERSION, openDatabase, type CopyLabDatabase } from "../src/database.js";

describe("isolated autonomous paper schema migration", () => {
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

  it("adds only the isolated autonomous and replay ledgers to an existing v30 database", () => {
    mkdirSync(workspaceData, { recursive: true });
    temporaryRoot = mkdtempSync(join(workspaceData, "schema-v30-autonomous-test-"));
    const path = join(temporaryRoot, "copylab.db");
    db = openDatabase(path);
    db.prepare(
      "INSERT INTO settings(key, value_json, updated_at) VALUES ('strict-marker', '141', '2026-07-14T00:00:00.000Z')"
    ).run();
    db.close();
    db = undefined;

    const legacy = new Database(path);
    try {
      legacy.exec(`
        DROP TABLE autonomous_paper_replay_variant_results;
        DROP TABLE autonomous_paper_replay_reports;
        DROP TABLE autonomous_paper_replay_observations;
        DROP TABLE autonomous_paper_replay_episodes;
        DROP TABLE autonomous_paper_candidate_rollups;
        DROP TABLE autonomous_paper_events;
        DROP TABLE autonomous_paper_positions;
        DROP TABLE autonomous_paper_accounts;
        DROP TABLE autonomous_paper_lanes;
      `);
      legacy.pragma("user_version = 30");
    } finally {
      legacy.close();
    }

    db = openDatabase(path);
    expect(db.pragma("user_version", { simple: true })).toBe(COPYLAB_SCHEMA_VERSION);
    expect((db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name LIKE 'autonomous_paper_%' ORDER BY name
    `).all() as Array<{ name: string }>).map((row) => row.name)).toEqual([
      "autonomous_paper_accounts",
      "autonomous_paper_candidate_rollups",
      "autonomous_paper_events",
      "autonomous_paper_lanes",
      "autonomous_paper_positions",
      "autonomous_paper_replay_episodes",
      "autonomous_paper_replay_observations",
      "autonomous_paper_replay_reports",
      "autonomous_paper_replay_variant_results"
    ]);
    expect(db.prepare("SELECT value_json FROM settings WHERE key = 'strict-marker'").get())
      .toEqual({ value_json: "141" });
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("contains no bridge columns into strict, live, wallet, or execution ledgers", () => {
    db = openDatabase(":memory:");
    for (const table of [
      "autonomous_paper_lanes",
      "autonomous_paper_accounts",
      "autonomous_paper_positions",
      "autonomous_paper_events",
      "autonomous_paper_candidate_rollups",
      "autonomous_paper_replay_episodes",
      "autonomous_paper_replay_observations",
      "autonomous_paper_replay_reports",
      "autonomous_paper_replay_variant_results"
    ]) {
      const columns = (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map(
        (column) => column.name
      );
      expect(columns).not.toContain("mode");
      expect(columns).not.toContain("evaluation_cohort_id");
      expect(columns).not.toContain("wallet");
      expect(columns).not.toContain("source_signature");
      expect(columns).not.toContain("execution_id");
    }
  });

  it("adds the autonomous entry-cadence covering index to an existing v31 ledger", () => {
    mkdirSync(workspaceData, { recursive: true });
    temporaryRoot = mkdtempSync(join(workspaceData, "schema-v32-cadence-index-test-"));
    const path = join(temporaryRoot, "copylab.db");
    db = openDatabase(path);
    db.prepare(
      "INSERT INTO settings(key, value_json, updated_at) VALUES ('cadence-marker', 'preserved', '2026-07-14T00:00:00.000Z')"
    ).run();
    db.exec("DROP INDEX autonomous_paper_events_entry_cadence");
    db.pragma("user_version = 31");
    db.close();
    db = undefined;

    db = openDatabase(path);
    expect(db.pragma("user_version", { simple: true })).toBe(COPYLAB_SCHEMA_VERSION);
    expect((db.pragma(
      "index_info(autonomous_paper_events_entry_cadence)"
    ) as Array<{ name: string }>).map((column) => column.name)).toEqual([
      "lane_id",
      "kind",
      "action",
      "outcome",
      "observed_at"
    ]);
    const plan = db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT COUNT(*) FROM autonomous_paper_events
      WHERE lane_id = ? AND kind = 'DECISION' AND action = 'BUY'
        AND outcome = 'SIMULATED' AND observed_at >= ? AND observed_at <= ?
    `).all(
      "autonomous-v1",
      "2026-07-14T00:00:00.000Z",
      "2026-07-14T23:59:59.999Z"
    ) as Array<{ detail: string }>;
    expect(plan.some((step) => step.detail.includes(
      "COVERING INDEX autonomous_paper_events_entry_cadence"
    ))).toBe(true);
    expect(db.prepare("SELECT value_json FROM settings WHERE key = 'cadence-marker'").get())
      .toEqual({ value_json: "preserved" });
  });

  it("adds the candidate rollup ledger and retention index to an existing v32 database", () => {
    mkdirSync(workspaceData, { recursive: true });
    temporaryRoot = mkdtempSync(join(workspaceData, "schema-v33-candidate-retention-test-"));
    const path = join(temporaryRoot, "copylab.db");
    db = openDatabase(path);
    db.prepare(
      "INSERT INTO settings(key, value_json, updated_at) VALUES ('retention-marker', 'preserved', '2026-07-14T00:00:00.000Z')"
    ).run();
    db.exec(`
      DROP TABLE autonomous_paper_candidate_rollups;
      DROP INDEX autonomous_paper_events_candidate_retention;
    `);
    db.pragma("user_version = 32");
    db.close();
    db = undefined;

    db = openDatabase(path);
    expect(db.pragma("user_version", { simple: true })).toBe(COPYLAB_SCHEMA_VERSION);
    expect(db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'autonomous_paper_candidate_rollups'
    `).get()).toEqual({ name: "autonomous_paper_candidate_rollups" });
    expect((db.pragma(
      "index_info(autonomous_paper_events_candidate_retention)"
    ) as Array<{ name: string }>).map((column) => column.name)).toEqual([
      "lane_id",
      "observed_at",
      "event_key"
    ]);
    const plan = db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT event_key FROM autonomous_paper_events
      WHERE lane_id = ?
        AND kind = 'DECISION'
        AND action IN ('REJECT', 'OBSERVE')
        AND outcome IN ('REJECTED', 'ANALYSIS_ONLY')
      ORDER BY observed_at DESC, event_key DESC
      LIMIT 1 OFFSET ?
    `).all("autonomous-v1", 25_000) as Array<{ detail: string }>;
    expect(plan.some((step) => step.detail.includes(
      "INDEX autonomous_paper_events_candidate_retention"
    ))).toBe(true);
    expect(db.prepare("SELECT value_json FROM settings WHERE key = 'retention-marker'").get())
      .toEqual({ value_json: "preserved" });
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("adds the targeted trade-cooldown index to an existing v34 database", () => {
    mkdirSync(workspaceData, { recursive: true });
    temporaryRoot = mkdtempSync(join(workspaceData, "schema-v35-trade-index-test-"));
    const path = join(temporaryRoot, "copylab.db");
    db = openDatabase(path);
    db.prepare(
      "INSERT INTO settings(key, value_json, updated_at) VALUES ('trade-index-marker', 'preserved', '2026-07-14T00:00:00.000Z')"
    ).run();
    db.exec("DROP INDEX autonomous_paper_events_trade_mint_time");
    db.pragma("user_version = 34");
    db.close();
    db = undefined;

    db = openDatabase(path);
    expect(db.pragma("user_version", { simple: true })).toBe(COPYLAB_SCHEMA_VERSION);
    expect((db.pragma(
      "index_info(autonomous_paper_events_trade_mint_time)"
    ) as Array<{ name: string }>).map((column) => column.name)).toEqual([
      "lane_id",
      "mint",
      "observed_at",
      "event_key"
    ]);
    const indexSql = (db.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type = 'index' AND name = 'autonomous_paper_events_trade_mint_time'
    `).get() as { sql: string }).sql;
    expect(indexSql).toContain("WHERE kind = 'TRADE' AND mint IS NOT NULL");
    const plan = db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT event_json
      FROM autonomous_paper_events
      WHERE lane_id = ?
        AND mint = ?
        AND kind = 'TRADE'
        AND json_type(event_json, '$.trade') = 'object'
      ORDER BY observed_at DESC, event_key DESC
      LIMIT 1
    `).all("autonomous-v1", "target-mint") as Array<{ detail: string }>;
    expect(plan.some((step) => step.detail.includes(
      "INDEX autonomous_paper_events_trade_mint_time"
    ))).toBe(true);
    expect(db.prepare("SELECT value_json FROM settings WHERE key = 'trade-index-marker'").get())
      .toEqual({ value_json: "preserved" });
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("adds the durable learning outbox to an existing v35 database without changing prior evidence", () => {
    mkdirSync(workspaceData, { recursive: true });
    temporaryRoot = mkdtempSync(join(workspaceData, "schema-v36-learning-outbox-test-"));
    const path = join(temporaryRoot, "copylab.db");
    db = openDatabase(path);
    db.prepare(
      "INSERT INTO settings(key, value_json, updated_at) VALUES ('learning-outbox-marker', 'preserved', '2026-07-14T00:00:00.000Z')"
    ).run();
    db.exec("DROP TABLE learning_outbox");
    db.pragma("user_version = 35");
    db.close();
    db = undefined;

    db = openDatabase(path);
    expect(db.pragma("user_version", { simple: true })).toBe(COPYLAB_SCHEMA_VERSION);
    expect((db.pragma("table_info(learning_outbox)") as Array<{ name: string }>).map(
      (column) => column.name
    )).toEqual([
      "id",
      "event_key",
      "kind",
      "payload_json",
      "created_at",
      "delivered_at",
      "attempts",
      "last_error"
    ]);
    expect(db.prepare("SELECT value_json FROM settings WHERE key = 'learning-outbox-marker'").get())
      .toEqual({ value_json: "preserved" });
  });
});
