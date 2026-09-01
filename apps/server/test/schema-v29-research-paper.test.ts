import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { COPYLAB_SCHEMA_VERSION, openDatabase, type CopyLabDatabase } from "../src/database.js";

describe("schema-v30 isolated research watchlist migration", () => {
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

  it("adds only isolated watchlist tables to an existing v29 ledger", () => {
    mkdirSync(workspaceData, { recursive: true });
    temporaryRoot = mkdtempSync(join(workspaceData, "schema-v29-research-test-"));
    const path = join(temporaryRoot, "copylab.db");
    db = openDatabase(path);
    db.prepare("INSERT INTO settings(key, value_json, updated_at) VALUES ('strict-marker', '141', '2026-07-13T00:00:00.000Z')").run();
    db.close();
    db = undefined;

    const legacy = new Database(path);
    try {
      legacy.exec(`
        DROP TABLE research_paper_monitoring_checkpoints;
        DROP TABLE research_paper_watchlist_positions;
        DROP TABLE research_paper_watchlist_members;
        DROP TABLE research_paper_watchlist_runs;
      `);
      legacy.pragma("user_version = 29");
    } finally {
      legacy.close();
    }

    db = openDatabase(path);
    expect(db.pragma("user_version", { simple: true })).toBe(COPYLAB_SCHEMA_VERSION);
    expect((db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name LIKE 'research_paper_%' ORDER BY name
    `).all() as Array<{ name: string }>).map((row) => row.name)).toEqual([
      "research_paper_accounts",
      "research_paper_events",
      "research_paper_lanes",
      "research_paper_monitoring_checkpoints",
      "research_paper_positions",
      "research_paper_watchlist_members",
      "research_paper_watchlist_positions",
      "research_paper_watchlist_runs"
    ]);
    expect(db.prepare("SELECT value_json FROM settings WHERE key = 'strict-marker'").get())
      .toEqual({ value_json: "141" });
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });
});
