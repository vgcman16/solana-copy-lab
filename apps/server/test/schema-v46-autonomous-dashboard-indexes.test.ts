import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { COPYLAB_SCHEMA_VERSION, openDatabase, type CopyLabDatabase } from "../src/database.js";

describe("schema v46 autonomous dashboard indexes", () => {
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

  it("migrates v45 in place and routes both exact dashboard queries through partial indexes", () => {
    mkdirSync(workspaceData, { recursive: true });
    temporaryRoot = mkdtempSync(join(workspaceData, "schema-v46-dashboard-index-test-"));
    const path = join(temporaryRoot, "copylab.db");
    db = openDatabase(path);
    db.prepare(`
      INSERT INTO settings(key, value_json, updated_at)
      VALUES ('v46-marker', '"preserved"', '2026-09-01T00:00:00.000Z')
    `).run();
    db.exec(`
      DROP INDEX autonomous_paper_events_dashboard_material;
      DROP INDEX autonomous_paper_events_dashboard_simulated_sell;
    `);
    db.pragma("user_version = 45");
    db.close();
    db = undefined;

    // Confirm this is a real v45 reopen rather than a fresh-schema shortcut.
    const legacy = new Database(path);
    expect(legacy.pragma("user_version", { simple: true })).toBe(45);
    legacy.close();

    db = openDatabase(path);
    expect(COPYLAB_SCHEMA_VERSION).toBe(48);
    expect(db.pragma("user_version", { simple: true })).toBe(COPYLAB_SCHEMA_VERSION);
    expect(db.prepare("SELECT value_json FROM settings WHERE key = 'v46-marker'").get())
      .toEqual({ value_json: '"preserved"' });

    const materialPlan = db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT event_json FROM autonomous_paper_events
      WHERE lane_id = ?
        AND kind IN ('DECISION', 'TRADE')
        AND outcome IN ('SIMULATED', 'REJECTED', 'ANALYSIS_ONLY', 'FAILED')
        AND (action IN ('BUY', 'SELL') OR outcome = 'FAILED')
        AND json_type(event_json, '$.decision') = 'object'
      ORDER BY observed_at DESC, event_key DESC
      LIMIT 50
    `).all("autonomous-v1") as Array<{ detail: string }>;
    expect(materialPlan.some((step) => step.detail.includes(
      "INDEX autonomous_paper_events_dashboard_material"
    ))).toBe(true);

    const sellPlan = db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT event_json FROM autonomous_paper_events
      WHERE lane_id = ?
        AND kind = 'TRADE'
        AND action = 'SELL'
        AND outcome = 'SIMULATED'
        AND json_type(event_json, '$.trade') = 'object'
      ORDER BY observed_at DESC, event_key DESC
      LIMIT 50
    `).all("autonomous-v1") as Array<{ detail: string }>;
    expect(sellPlan.some((step) => step.detail.includes(
      "INDEX autonomous_paper_events_dashboard_simulated_sell"
    ))).toBe(true);

    const indexSql = db.prepare(`
      SELECT name, sql FROM sqlite_master
      WHERE type = 'index' AND name IN (
        'autonomous_paper_events_dashboard_material',
        'autonomous_paper_events_dashboard_simulated_sell'
      )
      ORDER BY name
    `).all() as Array<{ name: string; sql: string }>;
    expect(indexSql).toHaveLength(2);
    expect(indexSql[0]!.sql).toContain("action IN ('BUY', 'SELL') OR outcome = 'FAILED'");
    expect(indexSql[1]!.sql).toContain("action = 'SELL'");
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });
});
