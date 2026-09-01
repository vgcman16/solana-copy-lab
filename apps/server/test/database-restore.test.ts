import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { COPYLAB_SCHEMA_VERSION, openDatabase } from "../src/database.js";
import { restoreCopyLabDatabase, verifyCopyLabDatabase } from "../src/database-restore.js";
import { Repository } from "../src/repository.js";
import { StockPaperRepository } from "../src/stock-paper-repository.js";

describe("CopyLab database restore", () => {
  const workspaceData = resolve("data");
  let temporaryRoot: string | undefined;
  afterEach(() => {
    if (!temporaryRoot) return;
    const resolved = resolve(temporaryRoot);
    if (!resolved.startsWith(`${workspaceData}\\`) && !resolved.startsWith(`${workspaceData}/`)) {
      throw new Error("Refusing to remove a restore-test directory outside workspace data.");
    }
    rmSync(resolved, { recursive: true, force: true });
    temporaryRoot = undefined;
  });

  function paths() {
    mkdirSync(workspaceData, { recursive: true });
    temporaryRoot = mkdtempSync(join(workspaceData, "restore-test-"));
    const targetDirectory = join(temporaryRoot, "data");
    mkdirSync(targetDirectory);
    return {
      backup: join(temporaryRoot, "verified-backup.db"),
      target: join(targetDirectory, "copylab.db")
    };
  }

  function createLedger(path: string, marker: string): void {
    const db = openDatabase(path);
    try {
      new Repository(db).setSetting("restore_marker", marker);
    } finally {
      db.close();
    }
  }

  function createVersionThirtyNineLearningLedger(path: string): {
    checkpointId: string;
    datasetDigest: string;
    expectedEvaluationDigest: string;
  } {
    const checkpointId = "stock-learning-checkpoint:legacy-v39";
    const datasetDigest = "stock-dataset-v3:legacy-v39";
    const expectedEvaluationDigest = `stock-paper-evaluation-v3:legacy:${checkpointId}`;
    const capturedAt = "2026-07-16T14:40:12.000Z";
    const db = openDatabase(path);
    try {
      new Repository(db).setSetting("restore_marker", "v39-learning-backup");
      const lane = new StockPaperRepository(db).ensureActiveLane(capturedAt);
      db.pragma("foreign_keys = OFF");
      db.exec(`
        DROP TABLE stock_paper_learning_checkpoints;
        CREATE TABLE stock_paper_learning_checkpoints (
          id TEXT PRIMARY KEY,
          lane_id TEXT NOT NULL,
          dataset_digest TEXT NOT NULL,
          captured_at TEXT NOT NULL,
          cutoff_at TEXT NOT NULL,
          checkpoint_json TEXT NOT NULL,
          UNIQUE (lane_id, dataset_digest),
          FOREIGN KEY (lane_id) REFERENCES stock_paper_lanes(id) ON DELETE CASCADE
        );
        CREATE INDEX stock_paper_learning_checkpoint_lane_time
          ON stock_paper_learning_checkpoints(lane_id, captured_at DESC, id);
      `);
      db.prepare(`
        INSERT INTO stock_paper_learning_checkpoints(
          id, lane_id, dataset_digest, captured_at, cutoff_at, checkpoint_json
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        checkpointId,
        lane.id,
        datasetDigest,
        capturedAt,
        capturedAt,
        JSON.stringify({
          status: "COLLECTING",
          analysisOnly: true,
          mayAffectTrading: false,
          promotionEligible: false,
          evaluatedAt: capturedAt,
          cutoffAt: capturedAt,
          horizonMinutes: 15,
          folds: 0,
          holdoutScorablePaths: 0,
          coveragePercent: 0,
          distinctSymbols: 1,
          distinctTradeDays: 1,
          datasetDigest,
          gateReasons: ["HOLDOUT_PATHS_BELOW_MINIMUM"]
        })
      );
      db.pragma("user_version = 39");
    } finally {
      db.close();
    }
    return { checkpointId, datasetDigest, expectedEvaluationDigest };
  }

  function createVersionEighteenDeepHistoryLedger(path: string): {
    cohortId: string;
    signature: string;
    wallets: string[];
  } {
    const wallets = Array.from({ length: 100 }, (_, index) =>
      `legacy-deep-history-wallet-${String(index).padStart(3, "0")}`
    );
    const signature = "legacy-deep-history-signature";
    const db = openDatabase(path);
    let cohortId: string;
    try {
      const repository = new Repository(db);
      repository.setSetting("restore_marker", "v18-backup");
      const cohort = repository.createWalletDeepHistoryCohort({
        selectedAt: "2026-07-01T00:00:00.000Z",
        snapshotCutoffAt: "2026-07-01T00:00:00.000Z",
        windowStart: "2026-04-02T00:00:00.000Z",
        windowEnd: "2026-07-01T00:00:00.000Z",
        wallets
      });
      cohortId = cohort.id;
      repository.saveWalletIndexCheckpoint({
        pipeline: "helius-wallet-deep-history",
        partition: wallets[0]!,
        cursor: "legacy-page-cursor",
        lastSignature: signature,
        completed: false,
        updatedAt: "2026-07-01T00:01:00.000Z",
        metadata: { cohortId }
      });
      repository.enqueueWalletIndexTransactions([{
        signature,
        sourceAddress: wallets[0]!,
        wallet: wallets[0]!,
        source: "helius-wallet-deep-history",
        blockTime: "2026-06-30T23:59:00.000Z",
        discoveredAt: "2026-07-01T00:01:00.000Z",
        metadata: { cohortId }
      }]);
    } finally {
      db.close();
    }

    // Recreate the exact pre-generation cohort/target shape while preserving
    // the real v18 queue source and resumable ingestion checkpoint ledgers.
    const legacy = new Database(path);
    try {
      legacy.pragma("foreign_keys = OFF");
      legacy.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE portfolio_snapshots_v18 (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          mode TEXT NOT NULL,
          captured_at TEXT NOT NULL,
          snapshot_json TEXT NOT NULL,
          evaluation_cohort_id TEXT
        );
        INSERT INTO portfolio_snapshots_v18(
          id, mode, captured_at, snapshot_json, evaluation_cohort_id
        )
          SELECT id, mode, captured_at, snapshot_json, evaluation_cohort_id
          FROM portfolio_snapshots;
        DROP TABLE portfolio_snapshots;
        ALTER TABLE portfolio_snapshots_v18 RENAME TO portfolio_snapshots;
        INSERT INTO portfolio_snapshots(
          mode, captured_at, snapshot_json, evaluation_cohort_id
        ) VALUES (
          'PAPER', '2026-07-01T00:02:00.000Z', '{"marker":"legacy-portfolio"}', 'legacy-evaluation'
        );

        CREATE TABLE closed_trades_v18 (
          id TEXT PRIMARY KEY,
          mode TEXT NOT NULL,
          trade_json TEXT NOT NULL,
          closed_at TEXT NOT NULL,
          evaluation_cohort_id TEXT
        );
        INSERT INTO closed_trades_v18(
          id, mode, trade_json, closed_at, evaluation_cohort_id
        )
          SELECT id, mode, trade_json, closed_at, evaluation_cohort_id
          FROM closed_trades;
        DROP TABLE closed_trades;
        ALTER TABLE closed_trades_v18 RENAME TO closed_trades;
        INSERT INTO closed_trades(
          id, mode, trade_json, closed_at, evaluation_cohort_id
        ) VALUES (
          'legacy-closed-trade', 'PAPER', '{"marker":"legacy-trade"}',
          '2026-07-01T00:03:00.000Z', 'legacy-evaluation'
        );

        DROP TABLE wallet_deep_history_evidence;
        DROP TABLE wallet_deep_history_signatures;

        CREATE TABLE wallet_deep_history_targets_v18 (
          cohort_id TEXT NOT NULL,
          wallet TEXT NOT NULL UNIQUE,
          ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
          PRIMARY KEY (cohort_id, wallet),
          FOREIGN KEY (cohort_id) REFERENCES wallet_deep_history_cohorts(id) ON DELETE CASCADE
        );
        INSERT INTO wallet_deep_history_targets_v18(cohort_id, wallet, ordinal)
          SELECT cohort_id, wallet, ordinal FROM wallet_deep_history_targets;
        DROP TABLE wallet_deep_history_targets;
        ALTER TABLE wallet_deep_history_targets_v18 RENAME TO wallet_deep_history_targets;

        CREATE TABLE wallet_deep_history_cohorts_v18 (
          id TEXT PRIMARY KEY,
          sequence INTEGER NOT NULL UNIQUE CHECK (sequence >= 1),
          status TEXT NOT NULL CHECK (status IN ('OPEN', 'COMPLETE')),
          selected_at TEXT NOT NULL,
          snapshot_cutoff_at TEXT NOT NULL,
          window_start TEXT NOT NULL,
          window_end TEXT NOT NULL,
          created_at TEXT NOT NULL,
          completed_at TEXT
        );
        INSERT INTO wallet_deep_history_cohorts_v18(
          id, sequence, status, selected_at, snapshot_cutoff_at,
          window_start, window_end, created_at, completed_at
        )
        SELECT
          id, sequence, status, selected_at, snapshot_cutoff_at,
          window_start, window_end, created_at, completed_at
        FROM wallet_deep_history_cohorts;
        DROP TABLE wallet_deep_history_cohorts;
        ALTER TABLE wallet_deep_history_cohorts_v18 RENAME TO wallet_deep_history_cohorts;
        DROP TABLE wallet_deep_history_generations;
        PRAGMA user_version = 18;
        COMMIT;
      `);
    } finally {
      legacy.close();
    }
    return { cohortId, signature, wallets };
  }

  it("atomically replaces a quiescent ledger with a verified CopyLab backup", () => {
    const { backup, target } = paths();
    createLedger(backup, "backup");
    createLedger(target, "old-target");

    const result = restoreCopyLabDatabase(backup, target, "fixture-1");
    expect(result.target).toBe(resolve(target));
    expect(result.restoredSchemaVersion).toBeGreaterThanOrEqual(1);
    expect(verifyCopyLabDatabase(target)).toMatchObject({ quickCheck: "ok" });
    const restored = new Database(target, { readonly: true });
    try {
      expect(JSON.parse((restored.prepare("SELECT value_json FROM settings WHERE key = ?")
        .get("restore_marker") as { value_json: string }).value_json)).toBe("backup");
    } finally {
      restored.close();
    }
    expect(existsSync(`${target}.restore-previous-fixture-1`)).toBe(false);
  });

  it("restores a populated v39 learning checkpoint with v40 evaluation identity", () => {
    const { backup, target } = paths();
    const fixture = createVersionThirtyNineLearningLedger(backup);
    createLedger(target, "old-target");

    expect(verifyCopyLabDatabase(backup, { requireCurrentSchema: false })).toEqual({
      userVersion: 39,
      quickCheck: "ok"
    });
    expect(restoreCopyLabDatabase(backup, target, "v39-learning")).toMatchObject({
      target: resolve(target),
      restoredSchemaVersion: COPYLAB_SCHEMA_VERSION
    });

    const restored = new Database(target, { readonly: true, fileMustExist: true });
    try {
      const row = restored.prepare(`
        SELECT dataset_digest, evaluation_digest, checkpoint_json
        FROM stock_paper_learning_checkpoints WHERE id = ?
      `).get(fixture.checkpointId) as {
        dataset_digest: string;
        evaluation_digest: string;
        checkpoint_json: string;
      };
      expect(row.dataset_digest).toBe(fixture.datasetDigest);
      expect(row.evaluation_digest).toBe(fixture.expectedEvaluationDigest);
      expect(JSON.parse(row.checkpoint_json)).toMatchObject({
        datasetDigest: fixture.datasetDigest,
        evaluationDigest: fixture.expectedEvaluationDigest
      });
      expect(restored.pragma("foreign_key_check")).toEqual([]);
    } finally {
      restored.close();
    }
    expect(verifyCopyLabDatabase(target)).toEqual({
      userVersion: COPYLAB_SCHEMA_VERSION,
      quickCheck: "ok"
    });
  });

  it("restores a populated v18 deep-history cohort into the exact current schema", () => {
    const { backup, target } = paths();
    const fixture = createVersionEighteenDeepHistoryLedger(backup);
    createLedger(target, "old-target");

    expect(verifyCopyLabDatabase(backup, { requireCurrentSchema: false })).toMatchObject({
      userVersion: 18,
      quickCheck: "ok"
    });
    expect(restoreCopyLabDatabase(backup, target, "v18-deep-history")).toMatchObject({
      target: resolve(target),
      restoredSchemaVersion: COPYLAB_SCHEMA_VERSION
    });

    const restored = openDatabase(target);
    const reference = openDatabase(":memory:");
    try {
      const repository = new Repository(restored);
      expect(repository.getWalletDeepHistoryCohort(fixture.cohortId)).toMatchObject({
        id: fixture.cohortId,
        status: "OPEN",
        wallets: fixture.wallets
      });
      const cohort = repository.getWalletDeepHistoryCohort(fixture.cohortId)!;
      expect(cohort.generationId).toBeTruthy();
      expect(repository.getWalletIndexCheckpoint(
        "helius-wallet-deep-history",
        fixture.wallets[0]!
      )).toMatchObject({
        cursor: "legacy-page-cursor",
        lastSignature: fixture.signature,
        completed: false,
        metadata: { cohortId: fixture.cohortId }
      });
      expect(repository.listWalletIndexTransactionSources(fixture.signature)).toEqual([
        expect.objectContaining({
          wallet: fixture.wallets[0],
          source: "helius-wallet-deep-history",
          metadata: { cohortId: fixture.cohortId }
        })
      ]);
      expect(restored.prepare(`
        SELECT cohort_id, generation_id, wallet, signature
        FROM wallet_deep_history_signatures WHERE signature = ?
      `).get(fixture.signature)).toEqual({
        cohort_id: fixture.cohortId,
        generation_id: cohort.generationId,
        wallet: fixture.wallets[0],
        signature: fixture.signature
      });
      expect(restored.prepare(`
        SELECT COUNT(*) AS count FROM wallet_deep_history_targets
        WHERE cohort_id = ? AND generation_id = ?
      `).get(fixture.cohortId, cohort.generationId)).toEqual({ count: 100 });
      expect(restored.prepare(`
        SELECT mode, captured_at, evaluation_cohort_id, snapshot_json
        FROM portfolio_snapshots WHERE evaluation_cohort_id = 'legacy-evaluation'
      `).get()).toEqual({
        mode: "PAPER",
        captured_at: "2026-07-01T00:02:00.000Z",
        evaluation_cohort_id: "legacy-evaluation",
        snapshot_json: '{"marker":"legacy-portfolio"}'
      });
      expect(restored.prepare(`
        SELECT mode, evaluation_cohort_id, trade_json, closed_at
        FROM closed_trades WHERE id = 'legacy-closed-trade'
      `).get()).toEqual({
        mode: "PAPER",
        evaluation_cohort_id: "legacy-evaluation",
        trade_json: '{"marker":"legacy-trade"}',
        closed_at: "2026-07-01T00:03:00.000Z"
      });

      for (const table of [
        "closed_trades",
        "portfolio_snapshots",
        "wallet_deep_history_cohorts",
        "wallet_deep_history_targets"
      ] as const) {
        expect(restored.pragma(`table_info(${table})`)).toEqual(reference.pragma(`table_info(${table})`));
        expect(restored.pragma(`foreign_key_list(${table})`))
          .toEqual(reference.pragma(`foreign_key_list(${table})`));
      }
      expect(restored.pragma("foreign_key_check")).toEqual([]);
      expect(verifyCopyLabDatabase(target)).toEqual({
        userVersion: COPYLAB_SCHEMA_VERSION,
        quickCheck: "ok"
      });
    } finally {
      reference.close();
      restored.close();
    }
  });

  it("rejects corrupt input without replacing the current ledger", () => {
    const { backup, target } = paths();
    writeFileSync(backup, "not sqlite");
    createLedger(target, "preserved");

    expect(() => restoreCopyLabDatabase(backup, target, "fixture-2")).toThrow();
    const preserved = new Repository(new Database(target));
    try {
      expect(preserved.getSetting("restore_marker")).toBe("preserved");
    } finally {
      preserved.db.close();
    }
  });

  it("rejects a valid-looking backup created by a newer application schema", () => {
    const { backup } = paths();
    createLedger(backup, "future");
    const db = new Database(backup);
    try {
      db.pragma(`user_version = ${COPYLAB_SCHEMA_VERSION + 1}`);
    } finally {
      db.close();
    }

    expect(() => verifyCopyLabDatabase(backup)).toThrow(/newer than this CopyLab build/u);
  });

  it("rejects a quick-check-clean current-version backup with missing schema objects", () => {
    const { backup, target } = paths();
    createLedger(backup, "incomplete");
    createLedger(target, "preserved");
    const incomplete = new Database(backup);
    try {
      incomplete.pragma("foreign_keys = OFF");
      incomplete.exec("DROP TABLE positions");
    } finally {
      incomplete.close();
    }

    expect(() => verifyCopyLabDatabase(backup)).toThrow(/missing (?:required )?CopyLab tables?: positions/u);
    expect(() => restoreCopyLabDatabase(backup, target, "fixture-3"))
      .toThrow(/missing (?:required )?CopyLab tables?: positions/u);
    const preserved = new Repository(new Database(target));
    try {
      expect(preserved.getSetting("restore_marker")).toBe("preserved");
    } finally {
      preserved.db.close();
    }
  });
});
