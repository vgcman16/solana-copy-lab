import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { JUPITER_V6_PROGRAM_ID } from "@copylab/providers";
import { COPYLAB_SCHEMA_VERSION, openDatabase, type CopyLabDatabase } from "../src/database.js";
import { Repository } from "../src/repository.js";

const NOW = new Date("2027-01-15T00:00:00Z");
const WALLET = "Vote111111111111111111111111111111111111111";

function persistSuccessfulProgramTransaction(
  repository: Repository,
  signature: string,
  secondsOffset: number
): void {
  const observedAt = new Date(NOW.getTime() + secondsOffset * 1_000).toISOString();
  repository.enqueueWalletIndexTransactions([{
    signature,
    sourceAddress: JUPITER_V6_PROGRAM_ID,
    source: "helius-program-signature",
    discoveredAt: observedAt,
    slot: 42 + secondsOffset,
    blockTime: observedAt,
    metadata: { failed: false }
  }]);
  const leased = repository.leaseWalletIndexTransactions("migration-test", 1, 60, new Date(observedAt))[0];
  if (!leased?.leaseToken) throw new Error("Expected a migration fixture lease");
  expect(repository.completeWalletIndexTransaction({
    ...leased,
    success: true,
    feePayer: WALLET,
    sourceWallets: [],
    accountKeys: [WALLET, JUPITER_V6_PROGRAM_ID],
    programIds: [JUPITER_V6_PROGRAM_ID],
    updatedAt: observedAt
  }, [], leased.leaseToken, new Date(observedAt))).toBe(true);
}

describe("schema-v26 coarse wallet candidate migration", () => {
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

  it("resumes after a committed batch without recounting it", () => {
    mkdirSync(workspaceData, { recursive: true });
    temporaryRoot = mkdtempSync(join(workspaceData, "coarse-migration-test-"));
    const path = join(temporaryRoot, "copylab.db");
    db = openDatabase(path);
    const repository = new Repository(db);
    persistSuccessfulProgramTransaction(repository, "migration-first", 0);
    persistSuccessfulProgramTransaction(repository, "migration-second", 1);
    db.close();
    db = undefined;

    const interrupted = new Database(path);
    try {
      const rows = interrupted.prepare(`
        SELECT rowid AS row_id, signature
        FROM indexed_transactions
        ORDER BY rowid
      `).all() as Array<{ row_id: number; signature: string }>;
      expect(rows).toHaveLength(2);
      const first = rows[0];
      if (!first) throw new Error("Expected a first migration row");
      interrupted.transaction(() => {
        interrupted.exec(`
          DELETE FROM coarse_wallet_candidate_activity;
          DELETE FROM coarse_wallet_candidate_transactions;
        `);
        interrupted.prepare(`
          INSERT INTO coarse_wallet_candidate_transactions(
            signature, program_id, wallet, slot, block_time, observed_at, classified
          )
          SELECT
            tx.signature, source.source_address, tx.fee_payer, tx.slot,
            tx.block_time, COALESCE(tx.block_time, tx.indexed_at), 0
          FROM indexed_transactions tx
          JOIN index_signature_sources source ON source.signature = tx.signature
          WHERE tx.rowid = ? AND source.source = 'helius-program-signature'
        `).run(first.row_id);
        interrupted.prepare(`
          INSERT INTO coarse_wallet_candidate_activity(
            wallet, program_id, observed_successful_transactions, latest_observed_at
          ) VALUES (?, ?, 1, ?)
        `).run(WALLET, JUPITER_V6_PROGRAM_ID, NOW.toISOString());
        interrupted.prepare(`
          INSERT INTO settings(key, value_json, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
        `).run(
          "schema_v26_coarse_candidate_backfill",
          JSON.stringify({ lastRowId: first.row_id }),
          NOW.toISOString()
        );
        interrupted.pragma("user_version = 25");
      })();
    } finally {
      interrupted.close();
    }

    db = openDatabase(path);
    expect(db.pragma("user_version", { simple: true })).toBe(COPYLAB_SCHEMA_VERSION);
    expect(db.prepare("SELECT COUNT(*) AS count FROM coarse_wallet_candidate_transactions").get())
      .toEqual({ count: 2 });
    expect(db.prepare(`
      SELECT observed_successful_transactions AS count
      FROM coarse_wallet_candidate_activity
      WHERE wallet = ? AND program_id = ?
    `).get(WALLET, JUPITER_V6_PROGRAM_ID)).toEqual({ count: 2 });
    expect(db.prepare("SELECT 1 FROM settings WHERE key = ?")
      .get("schema_v26_coarse_candidate_backfill")).toBeUndefined();
  });

  it("does not replay a completed backfill if shutdown occurs before the version commit", () => {
    mkdirSync(workspaceData, { recursive: true });
    temporaryRoot = mkdtempSync(join(workspaceData, "coarse-migration-test-"));
    const path = join(temporaryRoot, "copylab.db");
    db = openDatabase(path);
    const repository = new Repository(db);
    persistSuccessfulProgramTransaction(repository, "migration-final-first", 0);
    persistSuccessfulProgramTransaction(repository, "migration-final-second", 1);

    const maximum = db.prepare("SELECT MAX(rowid) AS row_id FROM indexed_transactions")
      .get() as { row_id: number };
    db.transaction(() => {
      db?.prepare(`
        INSERT INTO settings(key, value_json, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
      `).run(
        "schema_v26_coarse_candidate_backfill",
        JSON.stringify({ lastRowId: maximum.row_id }),
        NOW.toISOString()
      );
      db?.pragma("user_version = 25");
    })();
    db.close();
    db = undefined;

    db = openDatabase(path);
    expect(db.pragma("user_version", { simple: true })).toBe(COPYLAB_SCHEMA_VERSION);
    expect(db.prepare(`
      SELECT observed_successful_transactions AS count
      FROM coarse_wallet_candidate_activity
      WHERE wallet = ? AND program_id = ?
    `).get(WALLET, JUPITER_V6_PROGRAM_ID)).toEqual({ count: 2 });
    expect(db.prepare("SELECT 1 FROM settings WHERE key = ?")
      .get("schema_v26_coarse_candidate_backfill")).toBeUndefined();
  });
});
