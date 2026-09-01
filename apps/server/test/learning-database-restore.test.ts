import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  AutonomousLearningRepository,
  LEARNING_SCHEMA_VERSION,
  openLearningDatabase
} from "../src/learning-database.js";
import {
  restoreLearningDatabase,
  verifyLearningDatabase
} from "../src/learning-database-restore.js";

describe("learning database restore", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function root(): string {
    const value = mkdtempSync(join(tmpdir(), "copylab-learning-restore-"));
    roots.push(value);
    return value;
  }

  function database(path: string, marker: string): void {
    const db = openLearningDatabase(path);
    new AutonomousLearningRepository(db).setMeta("marker", marker, "2026-07-15T00:00:00.000Z");
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.close();
  }

  function legacyV3Database(
    path: string,
    marker: string,
    executionTier: "SHADOW" | "INVALID" = "SHADOW"
  ): void {
    database(path, marker);
    const db = new Database(path);
    db.pragma("foreign_keys = OFF");
    try {
      db.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE learning_shadow_episodes_legacy (
          id TEXT PRIMARY KEY,
          source_key TEXT NOT NULL UNIQUE,
          lane_id TEXT NOT NULL,
          mint TEXT NOT NULL,
          strategy_arm TEXT NOT NULL,
          regime TEXT NOT NULL,
          status TEXT NOT NULL,
          shadow_only INTEGER NOT NULL CHECK (shadow_only IN (0, 1)),
          created_day TEXT NOT NULL,
          opened_at TEXT,
          horizon_ends_at TEXT,
          last_observed_at TEXT,
          payload_json TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          execution_tier TEXT NOT NULL DEFAULT 'SHADOW'
        );
        INSERT INTO learning_shadow_episodes_legacy(
          id, source_key, lane_id, mint, strategy_arm, regime, status,
          shadow_only, created_day, opened_at, horizon_ends_at,
          last_observed_at, payload_json, updated_at, execution_tier
        )
        SELECT
          id, source_key, lane_id, mint, strategy_arm, regime, status,
          shadow_only, created_day, opened_at, horizon_ends_at,
          last_observed_at, payload_json, updated_at, execution_tier
        FROM learning_shadow_episodes;
        DROP TABLE learning_shadow_episodes;
        ALTER TABLE learning_shadow_episodes_legacy RENAME TO learning_shadow_episodes;
        CREATE INDEX learning_shadow_episodes_work
          ON learning_shadow_episodes(status, updated_at, id);
        CREATE INDEX learning_shadow_episodes_mint_day
          ON learning_shadow_episodes(mint, created_day, id);
        CREATE INDEX learning_shadow_episodes_arm_regime
          ON learning_shadow_episodes(strategy_arm, regime, status);
        COMMIT;
      `);
      db.prepare(`
        INSERT INTO learning_shadow_episodes(
          id, source_key, lane_id, mint, strategy_arm, regime, status,
          shadow_only, execution_tier, created_day, opened_at, horizon_ends_at,
          last_observed_at, payload_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        "episode-v3",
        "source-v3",
        "lane-v3",
        "mint-v3",
        "MOMENTUM_BREAKOUT",
        "RISK_ON",
        "COMPLETED",
        1,
        executionTier,
        "2026-07-15",
        "2026-07-15T12:00:00.000Z",
        "2026-07-15T15:00:00.000Z",
        "2026-07-15T15:00:00.000Z",
        JSON.stringify({ id: "episode-v3", executionTier }),
        "2026-07-15T15:00:00.000Z"
      );
      db.prepare(`
        INSERT INTO learning_outcome_labels(
          id, episode_id, horizon_minutes, dataset_eligible, observed_at, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        "label-v3",
        "episode-v3",
        180,
        1,
        "2026-07-15T15:00:00.000Z",
        JSON.stringify({ id: "label-v3", episodeId: "episode-v3" })
      );
      db.pragma("user_version = 3");
      expect(db.pragma("foreign_key_check")).toEqual([]);
      db.pragma("wal_checkpoint(TRUNCATE)");
      db.pragma("journal_mode = DELETE");
    } finally {
      db.close();
    }
  }

  it("atomically restores a complete current-schema learning ledger", () => {
    const directory = root();
    const source = resolve(directory, "source-learning.db");
    const backup = resolve(directory, "copylab-learning-20260715-120000.db");
    const target = resolve(directory, "learning.db");
    database(source, "backup");
    copyFileSync(source, backup);
    database(target, "current");

    expect(verifyLearningDatabase(backup)).toEqual({
      userVersion: LEARNING_SCHEMA_VERSION,
      quickCheck: "ok"
    });
    expect(restoreLearningDatabase(backup, target, "test-restore")).toEqual({
      target,
      restoredSchemaVersion: LEARNING_SCHEMA_VERSION
    });

    const restored = openLearningDatabase(target);
    expect(new AutonomousLearningRepository(restored).getMeta("marker")).toBe("backup");
    restored.close();
    expect(existsSync(`${target}.restore-previous-test-restore`)).toBe(false);
    expect(existsSync(`${target}.restore-incomplete-test-restore`)).toBe(false);
  });

  it("restores a populated legacy v3 ledger with appended execution_tier into canonical v4", () => {
    const directory = root();
    const backup = resolve(directory, "copylab-learning-legacy-v3.db");
    const target = resolve(directory, "learning.db");
    legacyV3Database(backup, "legacy-backup");
    database(target, "current");

    expect(verifyLearningDatabase(backup, { requireCurrentSchema: false })).toEqual({
      userVersion: 3,
      quickCheck: "ok"
    });
    expect(() => verifyLearningDatabase(backup)).toThrow("was not migrated");
    expect(restoreLearningDatabase(backup, target, "legacy-v3")).toEqual({
      target,
      restoredSchemaVersion: LEARNING_SCHEMA_VERSION
    });

    expect(existsSync(`${target}-wal`)).toBe(false);
    expect(existsSync(`${target}-shm`)).toBe(false);
    const restored = new Database(target, { readonly: true, fileMustExist: true });
    try {
      expect(restored.pragma("user_version", { simple: true })).toBe(LEARNING_SCHEMA_VERSION);
      expect((restored.pragma("table_info(learning_shadow_episodes)") as Array<{ name: string }>)
        .map((column) => column.name)).toEqual([
          "id",
          "source_key",
          "lane_id",
          "mint",
          "strategy_arm",
          "regime",
          "status",
          "shadow_only",
          "execution_tier",
          "created_day",
          "opened_at",
          "horizon_ends_at",
          "last_observed_at",
          "payload_json",
          "updated_at"
        ]);
      expect(restored.prepare("SELECT execution_tier FROM learning_shadow_episodes WHERE id = ?")
        .get("episode-v3")).toEqual({ execution_tier: "SHADOW" });
      expect(restored.prepare("SELECT episode_id FROM learning_outcome_labels WHERE id = ?")
        .get("label-v3")).toEqual({ episode_id: "episode-v3" });
      expect(restored.pragma("foreign_key_check")).toEqual([]);
    } finally {
      restored.close();
    }

    const unchangedBackup = new Database(backup, { readonly: true, fileMustExist: true });
    try {
      expect(unchangedBackup.pragma("user_version", { simple: true })).toBe(3);
      expect((unchangedBackup.pragma("table_info(learning_shadow_episodes)") as Array<{ name: string }>)
        .at(-1)?.name).toBe("execution_tier");
    } finally {
      unchangedBackup.close();
    }
  });

  it("rejects corrupt or incomplete backups and preserves the current target", () => {
    const directory = root();
    const corrupt = resolve(directory, "corrupt.db");
    const incomplete = resolve(directory, "incomplete.db");
    const target = resolve(directory, "learning.db");
    writeFileSync(corrupt, "not sqlite");
    database(incomplete, "incomplete");
    const damaged = openLearningDatabase(incomplete);
    damaged.exec("DROP TABLE learning_outcome_labels");
    damaged.close();
    database(target, "current");

    expect(() => verifyLearningDatabase(corrupt)).toThrow();
    expect(() => restoreLearningDatabase(incomplete, target, "bad-restore"))
      .toThrow("schema is incomplete");
    const current = openLearningDatabase(target);
    expect(new AutonomousLearningRepository(current).getMeta("marker")).toBe("current");
    current.close();
  });

  it("preserves the target and removes staging sidecars when a legacy migration fails", () => {
    const directory = root();
    const backup = resolve(directory, "copylab-learning-invalid-v3.db");
    const target = resolve(directory, "learning.db");
    const operationId = "failed-v3";
    const staging = `${target}.restore-incomplete-${operationId}`;
    legacyV3Database(backup, "invalid-backup", "INVALID");
    database(target, "current");
    writeFileSync(staging, "stale staging");
    writeFileSync(`${staging}-wal`, "stale wal");
    writeFileSync(`${staging}-shm`, "stale shm");

    expect(() => restoreLearningDatabase(backup, target, operationId)).toThrow(/CHECK constraint/iu);
    const current = openLearningDatabase(target);
    expect(new AutonomousLearningRepository(current).getMeta("marker")).toBe("current");
    current.close();
    expect(existsSync(staging)).toBe(false);
    expect(existsSync(`${staging}-wal`)).toBe(false);
    expect(existsSync(`${staging}-shm`)).toBe(false);
    expect(existsSync(`${target}.restore-previous-${operationId}`)).toBe(false);

    const unchangedBackup = new Database(backup, { readonly: true, fileMustExist: true });
    try {
      expect(unchangedBackup.pragma("user_version", { simple: true })).toBe(3);
      expect(unchangedBackup.prepare("SELECT execution_tier FROM learning_shadow_episodes WHERE id = ?")
        .get("episode-v3")).toEqual({ execution_tier: "INVALID" });
    } finally {
      unchangedBackup.close();
    }
  });

  it("removes stale and newly-created restore WAL/SHM artifacts after success", () => {
    const directory = root();
    const backup = resolve(directory, "copylab-learning-current.db");
    const target = resolve(directory, "learning.db");
    const operationId = "sidecar-cleanup";
    const staging = `${target}.restore-incomplete-${operationId}`;
    database(backup, "backup");
    database(target, "current");
    writeFileSync(staging, "stale staging");
    writeFileSync(`${staging}-wal`, "stale wal");
    writeFileSync(`${staging}-shm`, "stale shm");

    restoreLearningDatabase(backup, target, operationId);

    for (const artifact of [
      staging,
      `${staging}-wal`,
      `${staging}-shm`,
      `${target}.restore-previous-${operationId}`,
      `${target}.restore-previous-${operationId}-wal`,
      `${target}.restore-previous-${operationId}-shm`,
      `${target}-wal`,
      `${target}-shm`
    ]) {
      expect(existsSync(artifact), artifact).toBe(false);
    }
  });

  it("allows only the exact learning.db target name and a quiescent target", () => {
    const directory = root();
    const backup = resolve(directory, "copylab-learning-20260715-120000.db");
    database(backup, "backup");
    expect(() => restoreLearningDatabase(backup, resolve(directory, "other.db")))
      .toThrow("learning.db");

    const target = resolve(directory, "learning.db");
    database(target, "current");
    writeFileSync(`${target}-wal`, "busy");
    expect(() => restoreLearningDatabase(backup, target))
      .toThrow("not quiescent");
  });
});
