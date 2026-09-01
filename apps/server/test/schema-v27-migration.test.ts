import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  COPYLAB_SCHEMA_VERSION,
  openDatabase,
  type CopyLabDatabase
} from "../src/database.js";

describe("schema-v27 cohort evidence index migration", () => {
  const workspaceData = resolve("data");
  let temporaryRoot: string | undefined;
  let db: CopyLabDatabase | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
    if (!temporaryRoot) return;
    const resolved = resolve(temporaryRoot);
    const prefix = `${workspaceData}${resolved.includes("\\") ? "\\" : "/"}`;
    if (!resolved.startsWith(prefix)) {
      throw new Error("Refusing to remove a migration-test directory outside workspace data.");
    }
    rmSync(resolved, { recursive: true, force: true });
    temporaryRoot = undefined;
  });

  it("upgrades an existing v26 ledger that does not have the cohort evidence index", () => {
    mkdirSync(workspaceData, { recursive: true });
    temporaryRoot = mkdtempSync(join(workspaceData, "schema-v27-migration-test-"));
    const path = join(temporaryRoot, "copylab.db");

    // Start from a structurally complete ledger, then reproduce the deployed
    // v26 boundary: all v26 tables exist, but the new cohort lookup index does
    // not. This avoids relying on a hand-maintained partial schema fixture.
    db = openDatabase(path);
    db.close();
    db = undefined;

    const legacy = new Database(path);
    try {
      legacy.exec("DROP INDEX wallet_deep_history_evidence_cohort");
      legacy.pragma("user_version = 26");
      expect(legacy.prepare(`
        SELECT 1 FROM sqlite_master
        WHERE type = 'index' AND name = 'wallet_deep_history_evidence_cohort'
      `).get()).toBeUndefined();
    } finally {
      legacy.close();
    }

    db = openDatabase(path);
    expect(db.pragma("user_version", { simple: true })).toBe(COPYLAB_SCHEMA_VERSION);
    expect(db.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type = 'index' AND name = 'wallet_deep_history_evidence_cohort'
    `).get()).toMatchObject({
      sql: expect.stringContaining("ON wallet_deep_history_evidence(cohort_id, wallet)")
    });
    expect(db.prepare("SELECT 1 FROM settings WHERE key = ?")
      .get("schema_v26_coarse_candidate_backfill")).toBeUndefined();
  });
});
