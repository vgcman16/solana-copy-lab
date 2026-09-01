import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { COPYLAB_SCHEMA_VERSION, openDatabase, type CopyLabDatabase } from "../src/database.js";

describe("schema-v28 managed recovery preflight migration", () => {
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

  it("adds the preflight and authorization ledgers to an existing v27 database", () => {
    mkdirSync(workspaceData, { recursive: true });
    temporaryRoot = mkdtempSync(join(workspaceData, "schema-v28-migration-test-"));
    const path = join(temporaryRoot, "copylab.db");
    db = openDatabase(path);
    db.close();
    db = undefined;

    const legacy = new Database(path);
    try {
      legacy.exec(`
        DROP TABLE managed_recovery_preflight_authorizations;
        DROP TABLE managed_recovery_preflights;
      `);
      legacy.pragma("user_version = 27");
    } finally {
      legacy.close();
    }

    db = openDatabase(path);
    expect(db.pragma("user_version", { simple: true })).toBe(COPYLAB_SCHEMA_VERSION);
    const tables = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name LIKE 'managed_recovery_preflight%'
      ORDER BY name
    `).all() as Array<{ name: string }>;
    expect(tables.map((row) => row.name)).toEqual([
      "managed_recovery_preflight_authorizations",
      "managed_recovery_preflights"
    ]);
  });
});
