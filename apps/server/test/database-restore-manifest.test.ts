import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { COPYLAB_SCHEMA_VERSION, openDatabase } from "../src/database.js";
import {
  MINIMUM_RESTORABLE_SCHEMA_VERSION,
  restoreCopyLabDatabase,
  verifyCopyLabDatabase
} from "../src/database-restore.js";
import { Repository } from "../src/repository.js";

describe("CopyLab legacy restore manifests", () => {
  const workspaceData = resolve("data");
  let temporaryRoot: string | undefined;

  afterEach(() => {
    if (!temporaryRoot) return;
    const resolved = resolve(temporaryRoot);
    const prefix = `${workspaceData}${resolved.includes("\\") ? "\\" : "/"}`;
    if (!resolved.startsWith(prefix)) {
      throw new Error("Refusing to remove a restore-test directory outside workspace data.");
    }
    rmSync(resolved, { recursive: true, force: true });
    temporaryRoot = undefined;
  });

  function paths(): { backup: string; target: string } {
    mkdirSync(workspaceData, { recursive: true });
    temporaryRoot = mkdtempSync(join(workspaceData, "restore-manifest-test-"));
    const targetDirectory = join(temporaryRoot, "target");
    mkdirSync(targetDirectory);
    return {
      backup: join(temporaryRoot, "legacy-backup.db"),
      target: join(targetDirectory, "copylab.db")
    };
  }

  function createCurrentLedger(path: string, marker: string): void {
    const db = openDatabase(path);
    try {
      new Repository(db).setSetting("restore_marker", marker);
    } finally {
      db.close();
    }
  }

  function marker(path: string): string | undefined {
    const db = new Database(path, { readonly: true, fileMustExist: true });
    try {
      const row = db.prepare("SELECT value_json FROM settings WHERE key = ?")
        .get("restore_marker") as { value_json: string } | undefined;
      return row ? JSON.parse(row.value_json) as string : undefined;
    } finally {
      db.close();
    }
  }

  it("rejects an incomplete schema-18 backup before migration and preserves the target", () => {
    const { backup, target } = paths();
    createCurrentLedger(backup, "incomplete-backup");
    createCurrentLedger(target, "preserved-target");

    const legacy = new Database(backup);
    try {
      legacy.pragma("foreign_keys = OFF");
      legacy.exec(`
        DROP TABLE indexed_transactions;
        DROP TABLE positions;
        DROP TABLE executions;
        PRAGMA user_version = 18;
      `);
      expect(legacy.pragma("quick_check", { simple: true })).toBe("ok");
    } finally {
      legacy.close();
    }

    expect(() => verifyCopyLabDatabase(backup, { requireCurrentSchema: false }))
      .toThrow(/schema-18 backup is incomplete.*executions.*indexed_transactions.*positions/iu);
    expect(() => restoreCopyLabDatabase(backup, target, "missing-ledgers"))
      .toThrow(/schema-18 backup is incomplete/iu);
    expect(marker(target)).toBe("preserved-target");
  });

  it("rejects a pre-manifest backup instead of inventing missing ledgers", () => {
    const { backup, target } = paths();
    createCurrentLedger(backup, "old-backup");
    createCurrentLedger(target, "preserved-target");
    const legacy = new Database(backup);
    try {
      legacy.pragma(`user_version = ${MINIMUM_RESTORABLE_SCHEMA_VERSION - 1}`);
    } finally {
      legacy.close();
    }

    expect(() => restoreCopyLabDatabase(backup, target, "unsupported-legacy"))
      .toThrow(/predates the oldest fail-closed restore manifest/iu);
    expect(marker(target)).toBe("preserved-target");
  });

  it("rejects a current-schema backup missing its durable coarse-candidate ledger", () => {
    const { backup, target } = paths();
    createCurrentLedger(backup, "incomplete-current-backup");
    createCurrentLedger(target, "preserved-target");
    const incomplete = new Database(backup);
    try {
      incomplete.exec("DROP TABLE coarse_wallet_candidate_activity;");
    } finally {
      incomplete.close();
    }

    expect(() => verifyCopyLabDatabase(backup, { requireCurrentSchema: false }))
      .toThrow(new RegExp(
        `schema-${COPYLAB_SCHEMA_VERSION} backup is incomplete.*coarse_wallet_candidate_activity`,
        "iu"
      ));
    expect(() => restoreCopyLabDatabase(backup, target, "missing-coarse-ledger"))
      .toThrow(new RegExp(`schema-${COPYLAB_SCHEMA_VERSION} backup is incomplete`, "iu"));
    expect(marker(target)).toBe("preserved-target");
  });

  it("rejects a schema-28 backup missing its managed recovery authorization ledger", () => {
    const { backup, target } = paths();
    createCurrentLedger(backup, "incomplete-preflight-backup");
    createCurrentLedger(target, "preserved-target");
    const incomplete = new Database(backup);
    try {
      incomplete.exec("DROP TABLE managed_recovery_preflight_authorizations;");
    } finally {
      incomplete.close();
    }

    expect(() => verifyCopyLabDatabase(backup, { requireCurrentSchema: false }))
      .toThrow(new RegExp(
        `schema-${COPYLAB_SCHEMA_VERSION} backup is incomplete.*managed_recovery_preflight_authorizations`,
        "iu"
      ));
    expect(() => restoreCopyLabDatabase(backup, target, "missing-preflight-authorization"))
      .toThrow(new RegExp(`schema-${COPYLAB_SCHEMA_VERSION} backup is incomplete`, "iu"));
    expect(marker(target)).toBe("preserved-target");
  });

  it("rejects a current backup missing its isolated research paper ledger", () => {
    const { backup, target } = paths();
    createCurrentLedger(backup, "incomplete-research-backup");
    createCurrentLedger(target, "preserved-target");
    const incomplete = new Database(backup);
    try {
      incomplete.exec("DROP TABLE research_paper_events;");
    } finally {
      incomplete.close();
    }

    expect(() => verifyCopyLabDatabase(backup, { requireCurrentSchema: false }))
      .toThrow(new RegExp(
        `schema-${COPYLAB_SCHEMA_VERSION} backup is incomplete.*research_paper_events`,
        "iu"
      ));
    expect(() => restoreCopyLabDatabase(backup, target, "missing-research-paper-ledger"))
      .toThrow(new RegExp(`schema-${COPYLAB_SCHEMA_VERSION} backup is incomplete`, "iu"));
    expect(marker(target)).toBe("preserved-target");
  });

  it("rejects a current backup missing its isolated research watchlist ledger", () => {
    const { backup, target } = paths();
    createCurrentLedger(backup, "incomplete-research-watchlist-backup");
    createCurrentLedger(target, "preserved-target");
    const incomplete = new Database(backup);
    try {
      incomplete.exec("DROP TABLE research_paper_watchlist_members;");
    } finally {
      incomplete.close();
    }

    expect(() => verifyCopyLabDatabase(backup, { requireCurrentSchema: false }))
      .toThrow(new RegExp(
        `schema-${COPYLAB_SCHEMA_VERSION} backup is incomplete.*research_paper_watchlist_members`,
        "iu"
      ));
    expect(() => restoreCopyLabDatabase(backup, target, "missing-research-watchlist-ledger"))
      .toThrow(new RegExp(`schema-${COPYLAB_SCHEMA_VERSION} backup is incomplete`, "iu"));
    expect(marker(target)).toBe("preserved-target");
  });

  it("rejects a current backup missing the durable learning outbox", () => {
    const { backup, target } = paths();
    createCurrentLedger(backup, "incomplete-learning-outbox-backup");
    createCurrentLedger(target, "preserved-target");
    const incomplete = new Database(backup);
    try {
      incomplete.exec("DROP TABLE learning_outbox;");
    } finally {
      incomplete.close();
    }

    expect(() => verifyCopyLabDatabase(backup, { requireCurrentSchema: false }))
      .toThrow(new RegExp(
        `schema-${COPYLAB_SCHEMA_VERSION} backup is incomplete.*learning_outbox`,
        "iu"
      ));
    expect(() => restoreCopyLabDatabase(backup, target, "missing-learning-outbox"))
      .toThrow(new RegExp(`schema-${COPYLAB_SCHEMA_VERSION} backup is incomplete`, "iu"));
    expect(marker(target)).toBe("preserved-target");
  });

  it("rejects a current backup missing the append-only marketplace mark ledger", () => {
    const { backup, target } = paths();
    createCurrentLedger(backup, "incomplete-marketplace-marks-backup");
    createCurrentLedger(target, "preserved-target");
    const incomplete = new Database(backup);
    try {
      incomplete.exec("DROP TABLE marketplace_paper_position_marks;");
    } finally {
      incomplete.close();
    }

    expect(() => verifyCopyLabDatabase(backup, { requireCurrentSchema: false }))
      .toThrow(new RegExp(
        `schema-${COPYLAB_SCHEMA_VERSION} backup is incomplete.*marketplace_paper_position_marks`,
        "iu"
      ));
    expect(() => restoreCopyLabDatabase(backup, target, "missing-marketplace-marks"))
      .toThrow(new RegExp(`schema-${COPYLAB_SCHEMA_VERSION} backup is incomplete`, "iu"));
    expect(marker(target)).toBe("preserved-target");
  });
});
