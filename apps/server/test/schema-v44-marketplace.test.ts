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

describe("schema v45 PAPER marketplace", () => {
  let db: CopyLabDatabase | undefined;
  let directory: string | undefined;

  afterEach(() => {
    db?.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it("migrates v43 and creates the complete fail-closed marketplace ledger", () => {
    directory = mkdtempSync(join(tmpdir(), "copylab-marketplace-v44-"));
    const path = join(directory, "copylab.db");
    const legacy = new Database(path);
    legacy.pragma("user_version = 43");
    legacy.close();

    db = openDatabase(path);

    expect(COPYLAB_SCHEMA_VERSION).toBe(47);
    expect(db.pragma("user_version", { simple: true })).toBe(COPYLAB_SCHEMA_VERSION);
    const tables = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name LIKE 'marketplace_%'
      ORDER BY name
    `).all() as Array<{ name: string }>;
    expect(tables.map((row) => row.name)).toEqual([
      "marketplace_enrollment_events",
      "marketplace_enrollments",
      "marketplace_paper_mirror_fills",
      "marketplace_paper_position_marks",
      "marketplace_paper_positions",
      "marketplace_performance_snapshots",
      "marketplace_pilots",
      "marketplace_rebalance_previews"
    ]);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("rejects any non-PAPER enrollment or mirror fill at the database boundary", () => {
    db = openDatabase(":memory:");
    expect(() => db!.prepare(`
      INSERT INTO marketplace_enrollments(
        id, create_idempotency_key, pilot_id, mode, status,
        target_allocation_usd, enrollment_json, created_at, updated_at
      ) VALUES ('bad', 'bad', 'missing', 'LIVE', 'ACTIVE', 1, '{}', 'x', 'x')
    `).run()).toThrow();
  });
});
