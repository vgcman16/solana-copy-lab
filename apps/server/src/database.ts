import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type CopyLabDatabase = Database.Database;

export const COPYLAB_SCHEMA_VERSION = 47;
export const STOCK_V41_EVIDENCE_ACTIVATION_SETTING_KEY =
  "stock_paper_v41_evidence_activation";

function addColumnIfMissing(
  db: CopyLabDatabase,
  table: string,
  column: string,
  definition: string
): void {
  const columns = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
  if (!columns.some((entry) => entry.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function tableExists(db: CopyLabDatabase, table: string): boolean {
  return Boolean(db.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(table));
}

function tableColumnNames(db: CopyLabDatabase, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((column) => column.name);
}

function ensureStockV41EvidenceActivationMarker(db: CopyLabDatabase): void {
  const existing = db.prepare("SELECT 1 FROM settings WHERE key = ?")
    .get(STOCK_V41_EVIDENCE_ACTIVATION_SETTING_KEY);
  if (existing) return;
  const row = db.prepare(`
    SELECT MIN(decision_at) AS decision_at
    FROM stock_paper_order_events
  `).get() as { decision_at: string | null };
  const earliestEventAt = row.decision_at && Number.isFinite(Date.parse(row.decision_at))
    ? new Date(row.decision_at).toISOString()
    : undefined;
  const activatedAt = earliestEventAt ?? new Date().toISOString();
  db.prepare(`
    INSERT INTO settings(key, value_json, updated_at)
    VALUES (?, ?, ?)
  `).run(
    STOCK_V41_EVIDENCE_ACTIVATION_SETTING_KEY,
    JSON.stringify({
      activatedAt,
      basis: earliestEventAt ? "EARLIEST_PERSISTED_V41_EVENT" : "SCHEMA_ACTIVATION"
    }),
    activatedAt
  );
}

const COARSE_CANDIDATE_MIGRATION_KEY = "schema_v26_coarse_candidate_backfill";
const COARSE_CANDIDATE_MIGRATION_BATCH_SIZE = 5_000;

/**
 * Builds the compact candidate ledger in bounded, restart-safe transactions.
 * The cursor is committed with each batch, so an interrupted 3+ GB upgrade
 * resumes from its last indexed transaction instead of rescanning the payload
 * ledger. The application is not serving requests while schema migration runs.
 */
function backfillCoarseWalletCandidatesV26(db: CopyLabDatabase): void {
  const persisted = db.prepare("SELECT value_json FROM settings WHERE key = ?")
    .get(COARSE_CANDIDATE_MIGRATION_KEY) as { value_json: string } | undefined;
  let lastRowId = 0;
  if (persisted) {
    const value = JSON.parse(persisted.value_json) as { lastRowId?: unknown };
    if (Number.isSafeInteger(value.lastRowId) && (value.lastRowId as number) >= 0) {
      lastRowId = value.lastRowId as number;
    }
  }

  const nextRows = db.prepare(`
    SELECT rowid AS row_id
    FROM indexed_transactions
    WHERE rowid > ?
    ORDER BY rowid
    LIMIT ?
  `);
  const insertCandidates = db.prepare(`
    INSERT OR IGNORE INTO coarse_wallet_candidate_transactions(
      signature, program_id, wallet, slot, block_time, observed_at, classified
    )
    SELECT
      tx.signature,
      source.source_address,
      tx.fee_payer,
      tx.slot,
      tx.block_time,
      COALESCE(tx.block_time, tx.indexed_at),
      CASE WHEN EXISTS (
        SELECT 1
        FROM index_signature_sources decision
        WHERE decision.signature = tx.signature
          AND decision.source_address = source.source_address
          AND decision.source IN (
            'local-coarse-signer-accepted',
            'local-coarse-signer-rejected',
            'local-exact-swap-attribution'
          )
      ) THEN 1 ELSE 0 END
    FROM indexed_transactions tx
    CROSS JOIN index_signature_sources source ON source.signature = tx.signature
    WHERE tx.rowid > ? AND tx.rowid <= ?
      AND tx.success = 1
      AND tx.fee_payer IS NOT NULL
      AND tx.fee_payer <> ''
      AND source.source IN ('helius-program-signature', 'helius-program-head')
  `);
  const updateActivity = db.prepare(`
    INSERT INTO coarse_wallet_candidate_activity(
      wallet, program_id, observed_successful_transactions, latest_observed_at
    )
    SELECT
      tx.fee_payer,
      source.source_address,
      COUNT(DISTINCT tx.signature),
      MAX(COALESCE(tx.block_time, tx.indexed_at))
    FROM indexed_transactions tx
    CROSS JOIN index_signature_sources source ON source.signature = tx.signature
    WHERE tx.rowid > ? AND tx.rowid <= ?
      AND tx.success = 1
      AND tx.fee_payer IS NOT NULL
      AND tx.fee_payer <> ''
      AND source.source IN ('helius-program-signature', 'helius-program-head')
    GROUP BY tx.fee_payer, source.source_address
    ON CONFLICT(wallet, program_id) DO UPDATE SET
      observed_successful_transactions =
        coarse_wallet_candidate_activity.observed_successful_transactions +
        excluded.observed_successful_transactions,
      latest_observed_at = MAX(
        coarse_wallet_candidate_activity.latest_observed_at,
        excluded.latest_observed_at
      )
  `);
  const saveCursor = db.prepare(`
    INSERT INTO settings(key, value_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value_json = excluded.value_json,
      updated_at = excluded.updated_at
  `);

  while (true) {
    const rows = nextRows.all(lastRowId, COARSE_CANDIDATE_MIGRATION_BATCH_SIZE) as Array<{
      row_id: number;
    }>;
    if (rows.length === 0) break;
    const batchEndRowId = rows.at(-1)?.row_id;
    if (!Number.isSafeInteger(batchEndRowId) || (batchEndRowId as number) <= lastRowId) {
      throw new Error("The v26 coarse-candidate migration cursor did not advance.");
    }
    const batchEnd = batchEndRowId as number;
    db.transaction(() => {
      insertCandidates.run(lastRowId, batchEnd);
      updateActivity.run(lastRowId, batchEnd);
      saveCursor.run(
        COARSE_CANDIDATE_MIGRATION_KEY,
        JSON.stringify({ lastRowId: batchEnd }),
        new Date().toISOString()
      );
    })();
    lastRowId = batchEnd;
  }
}

/**
 * SQLite cannot widen a CHECK constraint in place. Rebuild the v44 marketplace
 * ledgers as one fail-closed transaction so partial exits and executable marks
 * cannot appear without their corresponding durable source evidence.
 */
function migrateMarketplaceV45(db: CopyLabDatabase): void {
  const requiredV44Tables = [
    "marketplace_enrollment_events",
    "marketplace_paper_mirror_fills",
    "marketplace_paper_positions"
  ];
  const existingCount = requiredV44Tables.filter((table) => tableExists(db, table)).length;
  if (existingCount === 0) return;
  if (existingCount !== requiredV44Tables.length) {
    throw new Error("The v44 marketplace ledger is incomplete and cannot be migrated safely.");
  }

  const foreignKeysWereEnabled = Number(db.pragma("foreign_keys", { simple: true })) === 1;
  if (foreignKeysWereEnabled) db.pragma("foreign_keys = OFF");
  try {
    db.exec(`
      BEGIN IMMEDIATE;

      ALTER TABLE marketplace_paper_mirror_fills
        RENAME TO marketplace_paper_mirror_fills_v44;
      ALTER TABLE marketplace_paper_positions
        RENAME TO marketplace_paper_positions_v44;
      ALTER TABLE marketplace_enrollment_events
        RENAME TO marketplace_enrollment_events_v44;

      CREATE TABLE marketplace_paper_positions (
        id TEXT PRIMARY KEY,
        enrollment_id TEXT NOT NULL,
        pilot_id TEXT NOT NULL,
        asset_id TEXT NOT NULL,
        source_position_reference TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('OPEN', 'CLOSED')),
        position_json TEXT NOT NULL,
        opened_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        closed_at TEXT,
        UNIQUE (enrollment_id, source_position_reference),
        FOREIGN KEY (enrollment_id) REFERENCES marketplace_enrollments(id),
        FOREIGN KEY (pilot_id) REFERENCES marketplace_pilots(id)
      );

      INSERT INTO marketplace_paper_positions(
        id, enrollment_id, pilot_id, asset_id, source_position_reference,
        status, position_json, opened_at, updated_at, closed_at
      )
      SELECT
        id, enrollment_id, pilot_id, asset_id, 'legacy:' || id,
        status,
        json_set(position_json, '$.sourcePositionReference', 'legacy:' || id),
        opened_at, updated_at, closed_at
      FROM marketplace_paper_positions_v44;

      CREATE TABLE marketplace_paper_mirror_fills (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        enrollment_id TEXT NOT NULL,
        pilot_id TEXT NOT NULL,
        position_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('OPEN', 'REDUCE', 'CLOSE')),
        source_position_reference TEXT NOT NULL,
        source_reference TEXT NOT NULL,
        source_occurred_at TEXT NOT NULL,
        filled_at TEXT NOT NULL,
        fill_json TEXT NOT NULL,
        UNIQUE (enrollment_id, source_reference, action),
        FOREIGN KEY (enrollment_id) REFERENCES marketplace_enrollments(id),
        FOREIGN KEY (pilot_id) REFERENCES marketplace_pilots(id),
        FOREIGN KEY (position_id) REFERENCES marketplace_paper_positions(id)
      );

      INSERT INTO marketplace_paper_mirror_fills(
        id, idempotency_key, enrollment_id, pilot_id, position_id, action,
        source_position_reference, source_reference, source_occurred_at,
        filled_at, fill_json
      )
      SELECT
        fill.id, fill.idempotency_key, fill.enrollment_id, fill.pilot_id,
        fill.position_id, fill.action, position.source_position_reference,
        fill.source_reference, fill.filled_at, fill.filled_at,
        json_set(
          fill.fill_json,
          '$.sourcePositionReference', position.source_position_reference,
          '$.sourceOccurredAt', fill.filled_at
        )
      FROM marketplace_paper_mirror_fills_v44 AS fill
      JOIN marketplace_paper_positions AS position ON position.id = fill.position_id;

      CREATE TABLE marketplace_enrollment_events (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        enrollment_id TEXT NOT NULL,
        pilot_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN (
          'ENROLLED', 'PAUSED', 'RESUMED', 'ALLOCATION_UPDATED',
          'REBALANCE_PREVIEWED', 'REBALANCE_APPLIED',
          'PAPER_MIRROR_OPENED', 'PAPER_MIRROR_REDUCED',
          'PAPER_MIRROR_CLOSED', 'PAPER_POSITION_MARKED',
          'SWITCHED', 'UNENROLLED'
        )),
        occurred_at TEXT NOT NULL,
        event_json TEXT NOT NULL,
        FOREIGN KEY (enrollment_id) REFERENCES marketplace_enrollments(id),
        FOREIGN KEY (pilot_id) REFERENCES marketplace_pilots(id)
      );

      INSERT INTO marketplace_enrollment_events(
        id, idempotency_key, enrollment_id, pilot_id, kind, occurred_at, event_json
      )
      SELECT id, idempotency_key, enrollment_id, pilot_id, kind, occurred_at, event_json
      FROM marketplace_enrollment_events_v44;

      CREATE TABLE marketplace_paper_position_marks (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        enrollment_id TEXT NOT NULL,
        pilot_id TEXT NOT NULL,
        position_id TEXT NOT NULL,
        source_position_reference TEXT NOT NULL,
        source_reference TEXT NOT NULL,
        source_occurred_at TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        mark_json TEXT NOT NULL,
        UNIQUE (enrollment_id, source_reference),
        FOREIGN KEY (enrollment_id) REFERENCES marketplace_enrollments(id),
        FOREIGN KEY (pilot_id) REFERENCES marketplace_pilots(id),
        FOREIGN KEY (position_id) REFERENCES marketplace_paper_positions(id)
      );

      DROP TABLE marketplace_paper_mirror_fills_v44;
      DROP TABLE marketplace_paper_positions_v44;
      DROP TABLE marketplace_enrollment_events_v44;

      CREATE UNIQUE INDEX one_open_marketplace_paper_position_per_asset
        ON marketplace_paper_positions(enrollment_id, asset_id)
        WHERE status = 'OPEN';
      CREATE INDEX marketplace_paper_positions_enrollment_time
        ON marketplace_paper_positions(enrollment_id, updated_at DESC, id);
      CREATE INDEX marketplace_paper_positions_source_reference
        ON marketplace_paper_positions(enrollment_id, source_position_reference, id);
      CREATE INDEX marketplace_paper_mirror_fills_enrollment_time
        ON marketplace_paper_mirror_fills(enrollment_id, filled_at DESC, id);
      CREATE INDEX marketplace_enrollment_events_recent
        ON marketplace_enrollment_events(enrollment_id, occurred_at DESC, id);
      CREATE INDEX marketplace_paper_position_marks_enrollment_time
        ON marketplace_paper_position_marks(enrollment_id, recorded_at DESC, id);

      COMMIT;
    `);
  } catch (error) {
    if (db.inTransaction) db.exec("ROLLBACK");
    throw error;
  } finally {
    if (foreignKeysWereEnabled) db.pragma("foreign_keys = ON");
  }
}

/**
 * The autonomous dashboard retains a large rejection-heavy event ledger. Its
 * material-decision and simulated-exit projections have different predicates
 * from the candidate-retention index, so without exact partial indexes SQLite
 * must walk the full lane history whenever the dashboard cache expires.
 */
function migrateAutonomousDashboardIndexesV46(db: CopyLabDatabase): void {
  db.transaction(() => {
    db.exec(`
      CREATE INDEX IF NOT EXISTS autonomous_paper_events_dashboard_material
        ON autonomous_paper_events(lane_id, observed_at DESC, event_key DESC)
        WHERE kind IN ('DECISION', 'TRADE')
          AND outcome IN ('SIMULATED', 'REJECTED', 'ANALYSIS_ONLY', 'FAILED')
          AND (action IN ('BUY', 'SELL') OR outcome = 'FAILED');

      CREATE INDEX IF NOT EXISTS autonomous_paper_events_dashboard_simulated_sell
        ON autonomous_paper_events(lane_id, observed_at DESC, event_key DESC)
        WHERE kind = 'TRADE'
          AND action = 'SELL'
          AND outcome = 'SIMULATED';
    `);
    db.pragma("user_version = 46");
  })();
}

/**
 * v46 keyed SOL/USD rows only by the requested grid time and discarded the
 * provider's real observation time. Rebuild the small insert-only ledger so
 * future evidence retains both identities. The one labeled Birdeye fallback
 * has deterministic legacy provenance (exactly five minutes earlier); all
 * other legacy rows retain their previous captured-time semantics because an
 * exact historical observation cannot be reconstructed without inventing it.
 */
function upgradeSolPriceObservationSchemaV47(db: CopyLabDatabase): boolean {
  if (!tableExists(db, "sol_price_snapshots")) return false;
  if (!tableColumnNames(db, "sol_price_snapshots").includes("observed_at")) {
    db.exec(`
      ALTER TABLE sol_price_snapshots RENAME TO sol_price_snapshots_v46;

      CREATE TABLE sol_price_snapshots (
        captured_at TEXT PRIMARY KEY,
        observed_at TEXT NOT NULL,
        price_usd REAL NOT NULL CHECK(price_usd > 0),
        source TEXT NOT NULL
      );

      INSERT INTO sol_price_snapshots(captured_at, observed_at, price_usd, source)
      SELECT
        captured_at,
        CASE
          WHEN source = 'birdeye_ohlcv_v3_prev_5m'
            THEN strftime('%Y-%m-%dT%H:%M:%fZ', captured_at, '-5 minutes')
          ELSE strftime('%Y-%m-%dT%H:%M:%fZ', captured_at)
        END,
        price_usd,
        source
      FROM sol_price_snapshots_v46;

      DROP TABLE sol_price_snapshots_v46;

      CREATE INDEX sol_price_snapshot_time
        ON sol_price_snapshots(captured_at DESC);
      CREATE INDEX sol_price_snapshot_observation_time
        ON sol_price_snapshots(observed_at DESC, captured_at DESC);
    `);
  } else {
    db.exec(`
      CREATE INDEX IF NOT EXISTS sol_price_snapshot_time
        ON sol_price_snapshots(captured_at DESC);
      CREATE INDEX IF NOT EXISTS sol_price_snapshot_observation_time
        ON sol_price_snapshots(observed_at DESC, captured_at DESC);
    `);
  }
  return true;
}

function migrateSolPriceObservationV47(db: CopyLabDatabase): void {
  db.transaction(() => {
    if (!upgradeSolPriceObservationSchemaV47(db)) {
      throw new Error("The v46 SOL price ledger is missing and cannot be migrated safely.");
    }
    db.pragma("user_version = 47");
  })();
}

function migrate(db: CopyLabDatabase): void {
  const version = db.pragma("user_version", { simple: true }) as number;
  if (version > COPYLAB_SCHEMA_VERSION) {
    throw new Error(
      `CopyLab database schema ${version} is newer than this application supports (${COPYLAB_SCHEMA_VERSION}).`
    );
  }
  if (version === COPYLAB_SCHEMA_VERSION) {
    ensureStockV41EvidenceActivationMarker(db);
    return;
  }

  if (version === 46) {
    migrateSolPriceObservationV47(db);
    ensureStockV41EvidenceActivationMarker(db);
    return;
  }

  if (version === 45) {
    migrateAutonomousDashboardIndexesV46(db);
    migrateSolPriceObservationV47(db);
    ensureStockV41EvidenceActivationMarker(db);
    return;
  }

  if (version === 44) migrateMarketplaceV45(db);

  if (version > 0 && version < 3) {
    db.pragma("foreign_keys = OFF");
    db.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE signal_decisions RENAME TO signal_decisions_legacy;
      ALTER TABLE source_events RENAME TO source_events_legacy;

      CREATE TABLE source_events (
        signature TEXT NOT NULL,
        wallet TEXT NOT NULL,
        event_json TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        recovered INTEGER NOT NULL DEFAULT 0,
        processed INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (signature, wallet)
      );
      INSERT INTO source_events(signature, wallet, event_json, observed_at, recovered, processed)
        SELECT signature, wallet, event_json, observed_at, recovered, processed FROM source_events_legacy;

      CREATE TABLE signal_decisions (
        id TEXT PRIMARY KEY,
        source_signature TEXT NOT NULL,
        source_wallet TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        intent_json TEXT NOT NULL,
        token_json TEXT,
        decision_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (source_signature, source_wallet) REFERENCES source_events(signature, wallet)
      );
      INSERT INTO signal_decisions(
        id, source_signature, source_wallet, idempotency_key, intent_json, token_json, decision_json, created_at
      )
        SELECT d.id, d.source_signature, e.wallet, d.idempotency_key, d.intent_json,
               d.token_json, d.decision_json, d.created_at
        FROM signal_decisions_legacy d
        JOIN source_events_legacy e ON e.signature = d.source_signature;

      DROP TABLE signal_decisions_legacy;
      DROP TABLE source_events_legacy;
      COMMIT;
    `);
    db.pragma("foreign_keys = ON");
  }

  // v19 replaces the global one-cohort-per-wallet constraint with an exact
  // generation boundary. Run this before the idempotent schema block because
  // its generation indexes require the new columns to exist on an older DB.
  if (version > 0 && version < 19 && tableExists(db, "wallet_deep_history_cohorts")) {
    const foreignKeysWereEnabled = db.pragma("foreign_keys", { simple: true }) === 1;
    db.pragma("foreign_keys = OFF");
    try {
      db.exec("BEGIN IMMEDIATE");
      db.exec(`
        CREATE TABLE IF NOT EXISTS wallet_deep_history_generations (
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
      `);
      addColumnIfMissing(db, "wallet_deep_history_cohorts", "generation_id", "TEXT");
      db.exec(`
        INSERT OR IGNORE INTO wallet_deep_history_generations(
          id, sequence, status, selected_at, snapshot_cutoff_at,
          window_start, window_end, created_at, completed_at
        )
        SELECT
          'local-generation-v1:' || MIN(sequence),
          MIN(sequence),
          CASE WHEN SUM(CASE WHEN status = 'OPEN' THEN 1 ELSE 0 END) > 0 THEN 'OPEN' ELSE 'COMPLETE' END,
          MIN(selected_at),
          snapshot_cutoff_at,
          window_start,
          window_end,
          MIN(created_at),
          CASE WHEN SUM(CASE WHEN status = 'OPEN' THEN 1 ELSE 0 END) = 0 THEN MAX(completed_at) ELSE NULL END
        FROM wallet_deep_history_cohorts
        GROUP BY snapshot_cutoff_at, window_start, window_end;

        UPDATE wallet_deep_history_cohorts AS cohort
        SET generation_id = (
          SELECT generation.id
          FROM wallet_deep_history_generations AS generation
          WHERE generation.snapshot_cutoff_at = cohort.snapshot_cutoff_at
            AND generation.window_start = cohort.window_start
            AND generation.window_end = cohort.window_end
          LIMIT 1
        )
        WHERE generation_id IS NULL OR generation_id = '';
      `);

      const invalidCohorts = db.prepare(`
        SELECT COUNT(*) AS count
        FROM wallet_deep_history_cohorts AS cohort
        LEFT JOIN wallet_deep_history_generations AS generation ON generation.id = cohort.generation_id
        WHERE cohort.generation_id IS NULL OR cohort.generation_id = '' OR generation.id IS NULL
      `).get() as { count: number };
      if (invalidCohorts.count !== 0) {
        throw new Error("Could not assign every legacy deep-history cohort to a durable generation.");
      }

      const cohortColumns = db.pragma("table_info(wallet_deep_history_cohorts)") as Array<{
        name: string;
        notnull: number;
      }>;
      const cohortForeignKeys = db.pragma("foreign_key_list(wallet_deep_history_cohorts)") as Array<{
        table: string;
        from: string;
        to: string;
        on_delete: string;
      }>;
      const generationColumn = cohortColumns.find((column) => column.name === "generation_id");
      const hasGenerationForeignKey = cohortForeignKeys.some((foreignKey) =>
        foreignKey.table === "wallet_deep_history_generations" &&
        foreignKey.from === "generation_id" &&
        foreignKey.to === "id" &&
        foreignKey.on_delete.toUpperCase() === "CASCADE"
      );
      if (generationColumn?.notnull !== 1 || !hasGenerationForeignKey) {
        db.exec(`
          DROP TABLE IF EXISTS wallet_deep_history_cohorts_v19;
          CREATE TABLE wallet_deep_history_cohorts_v19 (
            id TEXT PRIMARY KEY,
            sequence INTEGER NOT NULL UNIQUE CHECK (sequence >= 1),
            generation_id TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('OPEN', 'COMPLETE')),
            selected_at TEXT NOT NULL,
            snapshot_cutoff_at TEXT NOT NULL,
            window_start TEXT NOT NULL,
            window_end TEXT NOT NULL,
            created_at TEXT NOT NULL,
            completed_at TEXT,
            FOREIGN KEY (generation_id) REFERENCES wallet_deep_history_generations(id) ON DELETE CASCADE
          );
          INSERT INTO wallet_deep_history_cohorts_v19(
            id, sequence, generation_id, status, selected_at, snapshot_cutoff_at,
            window_start, window_end, created_at, completed_at
          )
          SELECT
            id, sequence, generation_id, status, selected_at, snapshot_cutoff_at,
            window_start, window_end, created_at, completed_at
          FROM wallet_deep_history_cohorts;
          DROP TABLE wallet_deep_history_cohorts;
          ALTER TABLE wallet_deep_history_cohorts_v19 RENAME TO wallet_deep_history_cohorts;
        `);
      }

      if (tableExists(db, "wallet_deep_history_targets")) {
        const targetSql = (db.prepare(`
          SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'wallet_deep_history_targets'
        `).get() as { sql?: string } | undefined)?.sql ?? "";
        const targetColumns = db.pragma("table_info(wallet_deep_history_targets)") as Array<{
          name: string;
          notnull: number;
        }>;
        const generationTargetColumn = targetColumns.find((column) => column.name === "generation_id");
        const needsRebuild = generationTargetColumn?.notnull !== 1 ||
          /wallet\s+TEXT\s+NOT\s+NULL\s+UNIQUE/iu.test(targetSql);
        if (needsRebuild) {
          db.exec(`
            DROP TABLE IF EXISTS wallet_deep_history_targets_v19;
            CREATE TABLE wallet_deep_history_targets_v19 (
              cohort_id TEXT NOT NULL,
              generation_id TEXT NOT NULL,
              wallet TEXT NOT NULL,
              ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
              PRIMARY KEY (cohort_id, wallet),
              UNIQUE (generation_id, wallet),
              FOREIGN KEY (cohort_id) REFERENCES wallet_deep_history_cohorts(id) ON DELETE CASCADE,
              FOREIGN KEY (generation_id) REFERENCES wallet_deep_history_generations(id) ON DELETE CASCADE
            );
            INSERT INTO wallet_deep_history_targets_v19(cohort_id, generation_id, wallet, ordinal)
              SELECT target.cohort_id, cohort.generation_id, target.wallet, target.ordinal
              FROM wallet_deep_history_targets AS target
              JOIN wallet_deep_history_cohorts AS cohort ON cohort.id = target.cohort_id;
            DROP TABLE wallet_deep_history_targets;
            ALTER TABLE wallet_deep_history_targets_v19 RENAME TO wallet_deep_history_targets;
          `);
        }
      }
      db.exec("COMMIT");
    } catch (error) {
      if (db.inTransaction) db.exec("ROLLBACK");
      throw error;
    } finally {
      if (foreignKeysWereEnabled) db.pragma("foreign_keys = ON");
    }
  }

  // Older ledgers continue through the idempotent all-schema block below. Add
  // the v47 column first so that block can safely create its observation index;
  // the schema version is written only after every remaining migration passes.
  if (version > 0 && version < 45 && tableExists(db, "sol_price_snapshots")) {
    db.transaction(() => {
      upgradeSolPriceObservationSchemaV47(db);
    })();
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- Marketplace catalog rows are versioned deterministic definitions. No
    -- brokerage credential or order payload is stored in this subsystem.
    CREATE TABLE IF NOT EXISTS marketplace_pilots (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      version INTEGER NOT NULL CHECK (version >= 1),
      status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'RESEARCH_ONLY', 'ARCHIVED')),
      pilot_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- Performance evidence is append-only. A repeated snapshot id may be
    -- replayed only when its complete JSON evidence is identical.
    CREATE TABLE IF NOT EXISTS marketplace_performance_snapshots (
      id TEXT PRIMARY KEY,
      pilot_id TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      UNIQUE (pilot_id, captured_at),
      FOREIGN KEY (pilot_id) REFERENCES marketplace_pilots(id)
    );

    CREATE INDEX IF NOT EXISTS marketplace_performance_pilot_time
      ON marketplace_performance_snapshots(pilot_id, captured_at DESC, id);

    -- Enrollments own isolated virtual accounts and are permanently PAPER.
    -- Status changes are mutable state, but every mutation has a matching
    -- append-only event below.
    CREATE TABLE IF NOT EXISTS marketplace_enrollments (
      id TEXT PRIMARY KEY,
      create_idempotency_key TEXT NOT NULL UNIQUE,
      pilot_id TEXT NOT NULL,
      mode TEXT NOT NULL CHECK (mode = 'PAPER'),
      status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'PAUSED', 'UNENROLLED')),
      target_allocation_usd REAL NOT NULL CHECK (target_allocation_usd >= 0),
      enrollment_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (pilot_id) REFERENCES marketplace_pilots(id)
    );

    CREATE INDEX IF NOT EXISTS marketplace_enrollments_status_time
      ON marketplace_enrollments(status, updated_at DESC, id);
    CREATE INDEX IF NOT EXISTS marketplace_enrollments_pilot_time
      ON marketplace_enrollments(pilot_id, created_at DESC, id);

    CREATE TABLE IF NOT EXISTS marketplace_enrollment_events (
      id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      enrollment_id TEXT NOT NULL,
      pilot_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN (
        'ENROLLED', 'PAUSED', 'RESUMED', 'ALLOCATION_UPDATED',
        'REBALANCE_PREVIEWED', 'REBALANCE_APPLIED',
        'PAPER_MIRROR_OPENED', 'PAPER_MIRROR_REDUCED',
        'PAPER_MIRROR_CLOSED', 'PAPER_POSITION_MARKED',
        'SWITCHED', 'UNENROLLED'
      )),
      occurred_at TEXT NOT NULL,
      event_json TEXT NOT NULL,
      FOREIGN KEY (enrollment_id) REFERENCES marketplace_enrollments(id),
      FOREIGN KEY (pilot_id) REFERENCES marketplace_pilots(id)
    );

    CREATE INDEX IF NOT EXISTS marketplace_enrollment_events_recent
      ON marketplace_enrollment_events(enrollment_id, occurred_at DESC, id);

    CREATE TABLE IF NOT EXISTS marketplace_rebalance_previews (
      id TEXT PRIMARY KEY,
      create_idempotency_key TEXT NOT NULL UNIQUE,
      enrollment_id TEXT NOT NULL,
      pilot_id TEXT NOT NULL,
      mode TEXT NOT NULL CHECK (mode = 'PAPER'),
      status TEXT NOT NULL CHECK (status IN ('PREVIEWED', 'APPLIED', 'EXPIRED')),
      expires_at TEXT NOT NULL,
      preview_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (enrollment_id) REFERENCES marketplace_enrollments(id),
      FOREIGN KEY (pilot_id) REFERENCES marketplace_pilots(id)
    );

    CREATE INDEX IF NOT EXISTS marketplace_rebalance_previews_due
      ON marketplace_rebalance_previews(status, expires_at, id);

    CREATE TABLE IF NOT EXISTS marketplace_paper_positions (
      id TEXT PRIMARY KEY,
      enrollment_id TEXT NOT NULL,
      pilot_id TEXT NOT NULL,
      asset_id TEXT NOT NULL,
      source_position_reference TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('OPEN', 'CLOSED')),
      position_json TEXT NOT NULL,
      opened_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      closed_at TEXT,
      UNIQUE (enrollment_id, source_position_reference),
      FOREIGN KEY (enrollment_id) REFERENCES marketplace_enrollments(id),
      FOREIGN KEY (pilot_id) REFERENCES marketplace_pilots(id)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS one_open_marketplace_paper_position_per_asset
      ON marketplace_paper_positions(enrollment_id, asset_id)
      WHERE status = 'OPEN';
    CREATE INDEX IF NOT EXISTS marketplace_paper_positions_enrollment_time
      ON marketplace_paper_positions(enrollment_id, updated_at DESC, id);
    CREATE INDEX IF NOT EXISTS marketplace_paper_positions_source_reference
      ON marketplace_paper_positions(enrollment_id, source_position_reference, id);

    CREATE TABLE IF NOT EXISTS marketplace_paper_mirror_fills (
      id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      enrollment_id TEXT NOT NULL,
      pilot_id TEXT NOT NULL,
      position_id TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('OPEN', 'REDUCE', 'CLOSE')),
      source_position_reference TEXT NOT NULL,
      source_reference TEXT NOT NULL,
      source_occurred_at TEXT NOT NULL,
      filled_at TEXT NOT NULL,
      fill_json TEXT NOT NULL,
      UNIQUE (enrollment_id, source_reference, action),
      FOREIGN KEY (enrollment_id) REFERENCES marketplace_enrollments(id),
      FOREIGN KEY (pilot_id) REFERENCES marketplace_pilots(id),
      FOREIGN KEY (position_id) REFERENCES marketplace_paper_positions(id)
    );

    CREATE INDEX IF NOT EXISTS marketplace_paper_mirror_fills_enrollment_time
      ON marketplace_paper_mirror_fills(enrollment_id, filled_at DESC, id);

    -- Executable position marks are append-only evidence. The position and its
    -- isolated account projection are updated in the same transaction as each
    -- mark row by MarketplaceRepository.
    CREATE TABLE IF NOT EXISTS marketplace_paper_position_marks (
      id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      enrollment_id TEXT NOT NULL,
      pilot_id TEXT NOT NULL,
      position_id TEXT NOT NULL,
      source_position_reference TEXT NOT NULL,
      source_reference TEXT NOT NULL,
      source_occurred_at TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      mark_json TEXT NOT NULL,
      UNIQUE (enrollment_id, source_reference),
      FOREIGN KEY (enrollment_id) REFERENCES marketplace_enrollments(id),
      FOREIGN KEY (pilot_id) REFERENCES marketplace_pilots(id),
      FOREIGN KEY (position_id) REFERENCES marketplace_paper_positions(id)
    );

    CREATE INDEX IF NOT EXISTS marketplace_paper_position_marks_enrollment_time
      ON marketplace_paper_position_marks(enrollment_id, recorded_at DESC, id);

    CREATE TABLE IF NOT EXISTS secrets (
      name TEXT PRIMARY KEY,
      ciphertext TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS provider_health (
      provider TEXT PRIMARY KEY,
      health_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cohorts (
      id TEXT PRIMARY KEY,
      generated_at TEXT NOT NULL,
      frozen INTEGER NOT NULL DEFAULT 1,
      cohort_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS wallet_candidates (
      cohort_id TEXT NOT NULL,
      address TEXT NOT NULL,
      candidate_json TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 0,
      shadow INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (cohort_id, address),
      FOREIGN KEY (cohort_id) REFERENCES cohorts(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS wallet_scores (
      cohort_id TEXT NOT NULL,
      address TEXT NOT NULL,
      score_json TEXT NOT NULL,
      calculated_at TEXT NOT NULL,
      PRIMARY KEY (cohort_id, address)
    );

    CREATE TABLE IF NOT EXISTS source_events (
      signature TEXT NOT NULL,
      wallet TEXT NOT NULL,
      event_json TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      recovered INTEGER NOT NULL DEFAULT 0,
      processed INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (signature, wallet)
    );

    -- A wallet stream may start only after every confirmed event since this
    -- durable cursor has been repaired. Failed attempts deliberately leave
    -- cursor_at unchanged so a restart replays the same overlap.
    CREATE TABLE IF NOT EXISTS monitoring_repair_checkpoints (
      wallet TEXT PRIMARY KEY,
      cursor_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('PENDING', 'READY', 'FAILED')),
      attempt_started_at TEXT,
      last_succeeded_at TEXT,
      next_retry_at TEXT,
      failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
      last_error TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS monitoring_repair_status_retry
      ON monitoring_repair_checkpoints(status, next_retry_at, updated_at);

    CREATE TABLE IF NOT EXISTS signal_decisions (
      id TEXT PRIMARY KEY,
      source_signature TEXT NOT NULL,
      source_wallet TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      intent_json TEXT NOT NULL,
      token_json TEXT,
      decision_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (source_signature, source_wallet) REFERENCES source_events(signature, wallet)
    );

    CREATE TABLE IF NOT EXISTS signal_outcomes (
      idempotency_key TEXT PRIMARY KEY,
      source_signature TEXT NOT NULL,
      source_wallet TEXT NOT NULL,
      mint TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('BUY', 'SELL', 'FORCED_EXIT', 'EMERGENCY_EXIT')),
      mode TEXT NOT NULL CHECK (mode IN ('PAPER', 'LIVE')),
      status TEXT NOT NULL CHECK (status IN (
        'ANALYSIS_ONLY', 'BLOCKED', 'RETRY_PENDING', 'REJECTED', 'QUEUED',
        'AWAITING_APPROVAL', 'APPROVED', 'SUBMITTED', 'SUBMITTED_UNRESOLVED',
        'SIMULATED', 'CONFIRMED', 'FAILED'
      )),
      reason_code TEXT NOT NULL,
      reason TEXT NOT NULL,
      source_block_time TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      decision_code TEXT,
      execution_id TEXT,
      target_signature TEXT,
      position_value_usd REAL,
      price_impact_percent REAL,
      actual_fees_usd REAL,
      implementation_shortfall_percent REAL,
      FOREIGN KEY (source_signature, source_wallet) REFERENCES source_events(signature, wallet)
    );

    CREATE INDEX IF NOT EXISTS signal_outcomes_updated
      ON signal_outcomes(updated_at DESC, idempotency_key DESC);

    CREATE UNIQUE INDEX IF NOT EXISTS signal_outcomes_source_action
      ON signal_outcomes(source_signature, source_wallet, mint, action);

    CREATE TABLE IF NOT EXISTS quotes (
      request_id TEXT PRIMARY KEY,
      source_signature TEXT,
      purpose TEXT NOT NULL,
      quote_json TEXT NOT NULL,
      quoted_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS executions (
      id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      mode TEXT NOT NULL,
      execution_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS execution_applications (
      execution_id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL,
      FOREIGN KEY (execution_id) REFERENCES executions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS positions (
      id TEXT PRIMARY KEY,
      mode TEXT NOT NULL,
      mint TEXT NOT NULL,
      status TEXT NOT NULL,
      position_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS one_open_position_per_mint_mode
      ON positions(mode, mint)
      WHERE status IN ('OPEN', 'CLOSING');

    CREATE TABLE IF NOT EXISTS portfolio_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mode TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      evaluation_cohort_id TEXT,
      snapshot_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS portfolio_mode_time
      ON portfolio_snapshots(mode, captured_at DESC);

    -- Emergency liquidation is a durable state machine. The parent record is
    -- written before provider I/O, and every position keeps a stable operation
    -- id plus a deterministic idempotency key for its current broadcast attempt.
    CREATE TABLE IF NOT EXISTS emergency_liquidations (
      id TEXT PRIMARY KEY,
      state TEXT NOT NULL CHECK (state IN ('LIQUIDATING', 'LOCKED_COMPLETE', 'LOCKED_INCOMPLETE')),
      reason TEXT NOT NULL,
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      finished_at TEXT,
      closed_positions INTEGER NOT NULL DEFAULT 0 CHECK (closed_positions >= 0),
      failed_positions INTEGER NOT NULL DEFAULT 0 CHECK (failed_positions >= 0)
    );

    CREATE INDEX IF NOT EXISTS emergency_liquidations_state_time
      ON emergency_liquidations(state, updated_at DESC);

    CREATE TABLE IF NOT EXISTS emergency_exit_operations (
      operation_id TEXT PRIMARY KEY,
      liquidation_id TEXT NOT NULL,
      position_id TEXT NOT NULL UNIQUE,
      attempt INTEGER NOT NULL CHECK (attempt > 0),
      idempotency_key TEXT NOT NULL UNIQUE,
      source_signature TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL CHECK (
        state IN ('PENDING', 'SUBMITTED_UNRESOLVED', 'CONFIRMED', 'FAILED_SAFE')
      ),
      execution_id TEXT,
      target_signature TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (liquidation_id) REFERENCES emergency_liquidations(id) ON DELETE RESTRICT,
      FOREIGN KEY (position_id) REFERENCES positions(id) ON DELETE RESTRICT,
      FOREIGN KEY (execution_id) REFERENCES executions(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS emergency_exit_operations_state_time
      ON emergency_exit_operations(state, updated_at DESC);

    CREATE TABLE IF NOT EXISTS audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      severity TEXT NOT NULL,
      message TEXT NOT NULL,
      details_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS audit_events_severity_time
      ON audit_events(severity, created_at DESC);

    CREATE TABLE IF NOT EXISTS provider_usage (
      provider TEXT NOT NULL,
      usage_date TEXT NOT NULL,
      requests INTEGER NOT NULL DEFAULT 0,
      credits INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (provider, usage_date)
    );

    CREATE TABLE IF NOT EXISTS provider_parity_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      capability TEXT NOT NULL,
      subject TEXT NOT NULL,
      status TEXT NOT NULL,
      observation_json TEXT NOT NULL,
      observed_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS provider_parity_capability_time
      ON provider_parity_observations(capability, observed_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS provider_parity_status_time
      ON provider_parity_observations(status, observed_at DESC, id DESC);

    -- Promotion parity is a frozen, endpoint-bound experiment. Legacy rolling
    -- observations remain in provider_parity_observations for audit, but only
    -- observations with a validated binding row can contribute to readiness.
    CREATE TABLE IF NOT EXISTS provider_parity_proof_epochs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK (status IN ('PREPARED', 'ACTIVE', 'INVALIDATED')),
      endpoint_fingerprint TEXT NOT NULL,
      window_start_at TEXT NOT NULL,
      window_end_at TEXT NOT NULL,
      cutoff_at TEXT NOT NULL,
      control_population_available INTEGER NOT NULL CHECK (control_population_available IN (0, 1)),
      subjects_json TEXT NOT NULL,
      manifest_digest TEXT NOT NULL,
      created_at TEXT NOT NULL,
      activated_at TEXT,
      invalidated_at TEXT,
      invalidation_reason TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS one_active_provider_parity_proof_epoch
      ON provider_parity_proof_epochs(status)
      WHERE status = 'ACTIVE';
    CREATE UNIQUE INDEX IF NOT EXISTS one_prepared_provider_parity_proof_epoch
      ON provider_parity_proof_epochs(status)
      WHERE status = 'PREPARED';
    CREATE INDEX IF NOT EXISTS provider_parity_proof_endpoint_time
      ON provider_parity_proof_epochs(endpoint_fingerprint, created_at DESC);

    CREATE TABLE IF NOT EXISTS provider_parity_observation_bindings (
      observation_id INTEGER PRIMARY KEY,
      proof_epoch_id TEXT NOT NULL,
      endpoint_fingerprint TEXT NOT NULL,
      window_start_at TEXT NOT NULL,
      window_end_at TEXT NOT NULL,
      cutoff_at TEXT NOT NULL,
      manifest_digest TEXT NOT NULL,
      input_digest TEXT NOT NULL,
      result_digest TEXT NOT NULL,
      binding_json TEXT NOT NULL,
      FOREIGN KEY (observation_id) REFERENCES provider_parity_observations(id) ON DELETE CASCADE,
      FOREIGN KEY (proof_epoch_id) REFERENCES provider_parity_proof_epochs(id) ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS provider_parity_binding_epoch_observation
      ON provider_parity_observation_bindings(proof_epoch_id, observation_id DESC);
    CREATE INDEX IF NOT EXISTS provider_parity_binding_endpoint_window
      ON provider_parity_observation_bindings(endpoint_fingerprint, cutoff_at, proof_epoch_id);

    CREATE TABLE IF NOT EXISTS provider_parity_baseline_runs (
      id TEXT PRIMARY KEY,
      proof_epoch_id TEXT,
      status TEXT NOT NULL CHECK (status IN ('PREPARING', 'PREPARED', 'CAPTURING', 'BLOCKED', 'ACTIVE', 'FAILED')),
      run_json TEXT NOT NULL,
      requested_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (proof_epoch_id) REFERENCES provider_parity_proof_epochs(id) ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS provider_parity_baseline_run_time
      ON provider_parity_baseline_runs(requested_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS provider_parity_baseline_run_epoch
      ON provider_parity_baseline_runs(proof_epoch_id, updated_at DESC)
      WHERE proof_epoch_id IS NOT NULL;

    -- SHADOW parity only authorizes the provider switch. A separate durable
    -- epoch proves that the exact active SELF_HOSTED endpoint pair remained
    -- healthy while PAPER was the execution mode before live promotion.
    CREATE TABLE IF NOT EXISTS self_hosted_paper_soak_epochs (
      id TEXT PRIMARY KEY,
      endpoint_fingerprint TEXT NOT NULL,
      started_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'RESET')),
      ended_at TEXT,
      reset_reason TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS one_active_self_hosted_paper_soak
      ON self_hosted_paper_soak_epochs(status)
      WHERE status = 'ACTIVE';
    CREATE INDEX IF NOT EXISTS self_hosted_paper_soak_endpoint_time
      ON self_hosted_paper_soak_epochs(endpoint_fingerprint, started_at DESC);

    CREATE TABLE IF NOT EXISTS self_hosted_paper_soak_heartbeats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      epoch_id TEXT,
      endpoint_fingerprint TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      healthy INTEGER NOT NULL CHECK (healthy IN (0, 1)),
      discovery_healthy INTEGER NOT NULL CHECK (discovery_healthy IN (0, 1)),
      chain_healthy INTEGER NOT NULL CHECK (chain_healthy IN (0, 1)),
      index_healthy INTEGER NOT NULL CHECK (index_healthy IN (0, 1)),
      price_healthy INTEGER NOT NULL CHECK (price_healthy IN (0, 1)),
      UNIQUE(endpoint_fingerprint, observed_at),
      FOREIGN KEY (epoch_id) REFERENCES self_hosted_paper_soak_epochs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS self_hosted_paper_soak_heartbeat_epoch_time
      ON self_hosted_paper_soak_heartbeats(epoch_id, observed_at);
    CREATE INDEX IF NOT EXISTS self_hosted_paper_soak_heartbeat_endpoint_time
      ON self_hosted_paper_soak_heartbeats(endpoint_fingerprint, observed_at DESC);

    CREATE TABLE IF NOT EXISTS sol_price_snapshots (
      captured_at TEXT PRIMARY KEY,
      observed_at TEXT NOT NULL,
      price_usd REAL NOT NULL CHECK(price_usd > 0),
      source TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sol_price_snapshot_time
      ON sol_price_snapshots(captured_at DESC);
    CREATE INDEX IF NOT EXISTS sol_price_snapshot_observation_time
      ON sol_price_snapshots(observed_at DESC, captured_at DESC);

    CREATE TABLE IF NOT EXISTS leader_lots (
      source_entry_signature TEXT PRIMARY KEY,
      wallet TEXT NOT NULL,
      mint TEXT NOT NULL,
      initial_atomic TEXT NOT NULL,
      remaining_atomic TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS closed_trades (
      id TEXT PRIMARY KEY,
      mode TEXT NOT NULL,
      evaluation_cohort_id TEXT,
      trade_json TEXT NOT NULL,
      closed_at TEXT NOT NULL
    );

    -- Promotion evidence is anchored to the wallet set that was actually
    -- frozen for forward paper observation, never to setup initialization or
    -- to a later weekly discovery refresh with the same wallet set.
    CREATE TABLE IF NOT EXISTS paper_evaluation_cohorts (
      id TEXT PRIMARY KEY,
      source_cohort_id TEXT NOT NULL,
      frozen_at TEXT NOT NULL,
      initial_nav_usd REAL NOT NULL CHECK (initial_nav_usd > 0),
      wallets_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'SUPERSEDED')),
      superseded_at TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS one_active_paper_evaluation_cohort
      ON paper_evaluation_cohorts(status)
      WHERE status = 'ACTIVE';

    CREATE TABLE IF NOT EXISTS paper_runtime_heartbeats (
      evaluation_cohort_id TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      PRIMARY KEY (evaluation_cohort_id, observed_at),
      FOREIGN KEY (evaluation_cohort_id) REFERENCES paper_evaluation_cohorts(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS paper_runtime_heartbeats_time
      ON paper_runtime_heartbeats(evaluation_cohort_id, observed_at);

    -- High-risk paper research is physically separate from the strict PAPER
    -- ledger. None of these tables contains mode or evaluation_cohort_id, so
    -- their rows cannot enter promotion, live-wallet selection, or execution.
    CREATE TABLE IF NOT EXISTS research_paper_lanes (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL CHECK (label = 'HIGH-RISK PAPER — RESEARCH ONLY'),
      purpose TEXT NOT NULL CHECK (purpose = 'RESEARCH_ONLY'),
      policy_version TEXT NOT NULL,
      policy_json TEXT NOT NULL,
      initial_nav_per_leader_usd REAL NOT NULL CHECK (initial_nav_per_leader_usd > 0),
      status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'PAUSED', 'ARCHIVED')),
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS one_active_research_paper_lane
      ON research_paper_lanes(status)
      WHERE status = 'ACTIVE';

    CREATE TABLE IF NOT EXISTS research_paper_accounts (
      lane_id TEXT NOT NULL,
      wallet TEXT NOT NULL,
      initial_nav_usd REAL NOT NULL CHECK (initial_nav_usd > 0),
      cash_usd REAL NOT NULL CHECK (cash_usd >= 0),
      nav_usd REAL NOT NULL CHECK (nav_usd >= 0),
      peak_nav_usd REAL NOT NULL CHECK (peak_nav_usd >= 0),
      realized_pnl_usd REAL NOT NULL,
      unrealized_pnl_usd REAL NOT NULL,
      max_drawdown_percent REAL NOT NULL CHECK (max_drawdown_percent >= 0),
      open_positions INTEGER NOT NULL CHECK (open_positions >= 0),
      completed_trades INTEGER NOT NULL CHECK (completed_trades >= 0),
      pricing_complete INTEGER NOT NULL CHECK (pricing_complete IN (0, 1)),
      account_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (lane_id, wallet),
      FOREIGN KEY (lane_id) REFERENCES research_paper_lanes(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS research_paper_positions (
      id TEXT PRIMARY KEY,
      lane_id TEXT NOT NULL,
      wallet TEXT NOT NULL,
      mint TEXT NOT NULL,
      source_entry_signature TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('OPEN', 'CLOSING', 'CLOSED', 'UNPRICED')),
      position_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (lane_id) REFERENCES research_paper_lanes(id) ON DELETE CASCADE,
      FOREIGN KEY (source_entry_signature, wallet)
        REFERENCES source_events(signature, wallet)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS one_open_research_position_per_leader_mint
      ON research_paper_positions(lane_id, wallet, mint)
      WHERE status IN ('OPEN', 'CLOSING', 'UNPRICED');

    CREATE INDEX IF NOT EXISTS research_paper_positions_lane_time
      ON research_paper_positions(lane_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS research_paper_events (
      event_key TEXT PRIMARY KEY,
      lane_id TEXT NOT NULL,
      wallet TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('SIGNAL', 'TRADE', 'NAV_MARK')),
      source_signature TEXT,
      mint TEXT,
      action TEXT CHECK (action IS NULL OR action IN ('BUY', 'SELL')),
      outcome TEXT NOT NULL CHECK (outcome IN (
        'CLAIMED', 'SIMULATED', 'REJECTED', 'ANALYSIS_ONLY', 'FAILED'
      )),
      observed_at TEXT NOT NULL,
      finalized_at TEXT,
      event_json TEXT NOT NULL,
      FOREIGN KEY (lane_id) REFERENCES research_paper_lanes(id) ON DELETE CASCADE,
      FOREIGN KEY (source_signature, wallet)
        REFERENCES source_events(signature, wallet)
    );

    CREATE INDEX IF NOT EXISTS research_paper_events_leader_time
      ON research_paper_events(lane_id, wallet, kind, observed_at DESC);

    CREATE INDEX IF NOT EXISTS research_paper_events_lane_time
      ON research_paper_events(lane_id, observed_at DESC);

    -- Expanded research monitoring is an append-only enrollment. It is
    -- intentionally separate from wallet_candidates.active, the strict frozen
    -- cohort, strict repair cursors, and every execution/promotion ledger.
    CREATE TABLE IF NOT EXISTS research_paper_watchlist_runs (
      id TEXT PRIMARY KEY,
      lane_id TEXT NOT NULL,
      source_cohort_id TEXT,
      target_wallet_count INTEGER NOT NULL CHECK (target_wallet_count >= 1),
      eligible_candidate_count INTEGER NOT NULL CHECK (eligible_candidate_count >= 0),
      newly_enrolled_count INTEGER NOT NULL CHECK (newly_enrolled_count >= 0),
      selected_at TEXT NOT NULL,
      run_json TEXT NOT NULL,
      FOREIGN KEY (lane_id) REFERENCES research_paper_lanes(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS research_paper_watchlist_runs_lane_time
      ON research_paper_watchlist_runs(lane_id, selected_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS research_paper_watchlist_members (
      lane_id TEXT NOT NULL,
      wallet TEXT NOT NULL,
      source_cohort_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('STRICT_OVERLAP', 'RESEARCH_ONLY')),
      selection_rank INTEGER NOT NULL CHECK (selection_rank >= 1),
      completed_trades_30d INTEGER NOT NULL CHECK (completed_trades_30d >= 0),
      local_confirmed_spot_swaps INTEGER NOT NULL CHECK (local_confirmed_spot_swaps >= 0),
      selected_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      member_json TEXT NOT NULL,
      PRIMARY KEY (lane_id, wallet),
      FOREIGN KEY (lane_id) REFERENCES research_paper_lanes(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS research_paper_watchlist_members_lane_role_rank
      ON research_paper_watchlist_members(lane_id, role, selection_rank, wallet);

    -- Direct research-watch events deliberately never enter strict
    -- source_events. Their lots therefore use this parallel JSON ledger; the
    -- repository exposes it together with legacy strict-backed research lots.
    CREATE TABLE IF NOT EXISTS research_paper_watchlist_positions (
      id TEXT PRIMARY KEY,
      lane_id TEXT NOT NULL,
      wallet TEXT NOT NULL,
      mint TEXT NOT NULL,
      source_entry_signature TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('OPEN', 'CLOSING', 'CLOSED', 'UNPRICED')),
      position_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (lane_id) REFERENCES research_paper_lanes(id) ON DELETE CASCADE
    );

    CREATE UNIQUE INDEX IF NOT EXISTS one_open_research_watch_position_per_leader_mint
      ON research_paper_watchlist_positions(lane_id, wallet, mint)
      WHERE status IN ('OPEN', 'CLOSING', 'UNPRICED');

    CREATE INDEX IF NOT EXISTS research_paper_watchlist_positions_lane_time
      ON research_paper_watchlist_positions(lane_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS research_paper_monitoring_checkpoints (
      lane_id TEXT NOT NULL,
      wallet TEXT NOT NULL,
      cursor_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('PENDING', 'READY', 'FAILED')),
      attempt_started_at TEXT,
      last_succeeded_at TEXT,
      next_retry_at TEXT,
      failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
      last_error TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (lane_id, wallet),
      FOREIGN KEY (lane_id) REFERENCES research_paper_lanes(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS research_paper_monitoring_status_retry
      ON research_paper_monitoring_checkpoints(lane_id, status, next_retry_at, updated_at);

    -- The autonomous momentum experiment is a third, physically isolated
    -- PAPER-only ledger. It deliberately has no mode, evaluation-cohort,
    -- wallet, source-signature, execution, approval, or signer columns, so its
    -- rows cannot satisfy a strict/live foreign key or promotion query.
    CREATE TABLE IF NOT EXISTS autonomous_paper_lanes (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL CHECK (label = 'AUTONOMOUS MOMENTUM PAPER — RESEARCH ONLY'),
      purpose TEXT NOT NULL CHECK (purpose = 'RESEARCH_ONLY'),
      policy_version TEXT NOT NULL,
      policy_json TEXT NOT NULL,
      initial_nav_usd REAL NOT NULL CHECK (initial_nav_usd > 0),
      status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'PAUSED', 'ARCHIVED')),
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS one_active_autonomous_paper_lane
      ON autonomous_paper_lanes(status)
      WHERE status = 'ACTIVE';

    CREATE TABLE IF NOT EXISTS autonomous_paper_accounts (
      lane_id TEXT PRIMARY KEY,
      initial_nav_usd REAL NOT NULL CHECK (initial_nav_usd > 0),
      cash_usd REAL NOT NULL CHECK (cash_usd >= 0),
      nav_usd REAL NOT NULL CHECK (nav_usd >= 0),
      peak_nav_usd REAL NOT NULL CHECK (peak_nav_usd >= 0),
      deployed_usd REAL NOT NULL CHECK (deployed_usd >= 0),
      realized_pnl_usd REAL NOT NULL,
      unrealized_pnl_usd REAL NOT NULL,
      max_drawdown_percent REAL NOT NULL CHECK (max_drawdown_percent >= 0),
      open_positions INTEGER NOT NULL CHECK (open_positions >= 0),
      completed_trades INTEGER NOT NULL CHECK (completed_trades >= 0),
      winning_trades INTEGER NOT NULL CHECK (winning_trades >= 0),
      gross_profit_usd REAL NOT NULL CHECK (gross_profit_usd >= 0),
      gross_loss_usd REAL NOT NULL CHECK (gross_loss_usd >= 0),
      pricing_complete INTEGER NOT NULL CHECK (pricing_complete IN (0, 1)),
      account_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (lane_id) REFERENCES autonomous_paper_lanes(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS autonomous_paper_positions (
      id TEXT PRIMARY KEY,
      lane_id TEXT NOT NULL,
      mint TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('OPEN', 'CLOSED', 'UNPRICED')),
      position_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (lane_id) REFERENCES autonomous_paper_lanes(id) ON DELETE CASCADE
    );

    CREATE UNIQUE INDEX IF NOT EXISTS one_open_autonomous_position_per_mint
      ON autonomous_paper_positions(lane_id, mint)
      WHERE status IN ('OPEN', 'UNPRICED');

    CREATE INDEX IF NOT EXISTS autonomous_paper_positions_lane_time
      ON autonomous_paper_positions(lane_id, updated_at DESC, id);

    CREATE TABLE IF NOT EXISTS autonomous_paper_events (
      event_key TEXT PRIMARY KEY,
      lane_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('DECISION', 'TRADE', 'NAV_MARK')),
      mint TEXT,
      action TEXT CHECK (action IS NULL OR action IN ('BUY', 'SELL', 'REJECT', 'OBSERVE')),
      outcome TEXT NOT NULL CHECK (outcome IN (
        'CLAIMED', 'SIMULATED', 'REJECTED', 'ANALYSIS_ONLY', 'FAILED'
      )),
      observed_at TEXT NOT NULL,
      finalized_at TEXT,
      event_json TEXT NOT NULL,
      FOREIGN KEY (lane_id) REFERENCES autonomous_paper_lanes(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS autonomous_paper_events_lane_time
      ON autonomous_paper_events(lane_id, observed_at DESC, event_key DESC);

    CREATE INDEX IF NOT EXISTS autonomous_paper_events_mint_time
      ON autonomous_paper_events(lane_id, mint, kind, observed_at DESC)
      WHERE mint IS NOT NULL;

    -- Cooldown admission asks for only the newest material trade for one
    -- mint. Keep that lookup on a narrow partial index so a rejection-heavy
    -- autonomous lane never scans every candidate decision for each token.
    CREATE INDEX IF NOT EXISTS autonomous_paper_events_trade_mint_time
      ON autonomous_paper_events(lane_id, mint, observed_at DESC, event_key DESC)
      WHERE kind = 'TRADE' AND mint IS NOT NULL;

    CREATE INDEX IF NOT EXISTS autonomous_paper_events_entry_cadence
      ON autonomous_paper_events(lane_id, kind, action, outcome, observed_at);

    CREATE INDEX IF NOT EXISTS autonomous_paper_events_dashboard_material
      ON autonomous_paper_events(lane_id, observed_at DESC, event_key DESC)
      WHERE kind IN ('DECISION', 'TRADE')
        AND outcome IN ('SIMULATED', 'REJECTED', 'ANALYSIS_ONLY', 'FAILED')
        AND (action IN ('BUY', 'SELL') OR outcome = 'FAILED');

    CREATE INDEX IF NOT EXISTS autonomous_paper_events_dashboard_simulated_sell
      ON autonomous_paper_events(lane_id, observed_at DESC, event_key DESC)
      WHERE kind = 'TRADE'
        AND action = 'SELL'
        AND outcome = 'SIMULATED';

    -- High-volume REJECT/OBSERVE detail is retained only for a bounded recent
    -- audit window. Older terminal candidate decisions are atomically folded
    -- into these compact daily summaries; execution, failure, NAV, trade, and
    -- unfinished-claim evidence never enters this table's compaction path.
    CREATE TABLE IF NOT EXISTS autonomous_paper_candidate_rollups (
      lane_id TEXT NOT NULL,
      utc_day TEXT NOT NULL CHECK (length(utc_day) = 10),
      action TEXT NOT NULL CHECK (action IN ('REJECT', 'OBSERVE')),
      outcome TEXT NOT NULL CHECK (outcome IN ('REJECTED', 'ANALYSIS_ONLY')),
      decision_count INTEGER NOT NULL CHECK (decision_count >= 0),
      first_observed_at TEXT NOT NULL,
      last_observed_at TEXT NOT NULL,
      reason_counts_json TEXT NOT NULL,
      PRIMARY KEY (lane_id, utc_day, action, outcome),
      FOREIGN KEY (lane_id) REFERENCES autonomous_paper_lanes(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS autonomous_paper_events_candidate_retention
      ON autonomous_paper_events(lane_id, observed_at DESC, event_key DESC)
      WHERE kind = 'DECISION'
        AND action IN ('REJECT', 'OBSERVE')
        AND outcome IN ('REJECTED', 'ANALYSIS_ONLY');

    -- Replay Lab is rooted only in real autonomous PAPER positions, but is
    -- physically separate from accounts, positions, events, and trades. Its
    -- rows can therefore preserve causal what-if evidence without satisfying
    -- any calibration, NAV, promotion, approval, execution, or signing query.
    CREATE TABLE IF NOT EXISTS autonomous_paper_replay_episodes (
      id TEXT PRIMARY KEY,
      lane_id TEXT NOT NULL,
      position_id TEXT NOT NULL UNIQUE,
      entry_decision_id TEXT NOT NULL,
      mint TEXT NOT NULL,
      policy_version TEXT NOT NULL,
      replay_version TEXT NOT NULL,
      scenario_manifest_digest TEXT NOT NULL CHECK (length(scenario_manifest_digest) = 64),
      status TEXT NOT NULL CHECK (status IN ('CAPTURING', 'READY', 'REPLAYED', 'INCOMPLETE')),
      actual_opened_at TEXT NOT NULL,
      capture_started_at TEXT NOT NULL,
      horizon_ends_at TEXT NOT NULL,
      completed_at TEXT,
      path_digest TEXT CHECK (path_digest IS NULL OR length(path_digest) = 64),
      episode_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (lane_id) REFERENCES autonomous_paper_lanes(id) ON DELETE CASCADE,
      FOREIGN KEY (position_id) REFERENCES autonomous_paper_positions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS autonomous_paper_replay_episode_lane_status
      ON autonomous_paper_replay_episodes(lane_id, status, updated_at DESC, id);

    CREATE TABLE IF NOT EXISTS autonomous_paper_replay_observations (
      observation_key TEXT PRIMARY KEY,
      episode_id TEXT NOT NULL,
      lane_id TEXT NOT NULL,
      position_id TEXT NOT NULL,
      mint TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK (sequence >= 0),
      phase TEXT NOT NULL CHECK (phase IN ('ENTRY', 'MARK', 'ACTUAL_EXIT', 'POST_EXIT')),
      observed_at TEXT NOT NULL,
      source_updated_at TEXT NOT NULL,
      observation_digest TEXT NOT NULL CHECK (length(observation_digest) = 64),
      observation_json TEXT NOT NULL,
      UNIQUE (episode_id, sequence),
      FOREIGN KEY (episode_id) REFERENCES autonomous_paper_replay_episodes(id) ON DELETE CASCADE,
      FOREIGN KEY (lane_id) REFERENCES autonomous_paper_lanes(id) ON DELETE CASCADE,
      FOREIGN KEY (position_id) REFERENCES autonomous_paper_positions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS autonomous_paper_replay_observation_path
      ON autonomous_paper_replay_observations(episode_id, sequence, observed_at);

    CREATE TABLE IF NOT EXISTS autonomous_paper_replay_reports (
      id TEXT PRIMARY KEY,
      episode_id TEXT NOT NULL UNIQUE,
      lane_id TEXT NOT NULL,
      position_id TEXT NOT NULL,
      replay_version TEXT NOT NULL,
      scenario_manifest_digest TEXT NOT NULL CHECK (length(scenario_manifest_digest) = 64),
      path_digest TEXT NOT NULL CHECK (length(path_digest) = 64),
      results_digest TEXT NOT NULL CHECK (length(results_digest) = 64),
      variant_count INTEGER NOT NULL CHECK (variant_count = 1000),
      scorable_variant_count INTEGER NOT NULL CHECK (
        scorable_variant_count >= 0 AND scorable_variant_count <= variant_count
      ),
      report_json TEXT NOT NULL,
      generated_at TEXT NOT NULL,
      FOREIGN KEY (episode_id) REFERENCES autonomous_paper_replay_episodes(id) ON DELETE CASCADE,
      FOREIGN KEY (lane_id) REFERENCES autonomous_paper_lanes(id) ON DELETE CASCADE,
      FOREIGN KEY (position_id) REFERENCES autonomous_paper_positions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS autonomous_paper_replay_report_lane_time
      ON autonomous_paper_replay_reports(lane_id, generated_at DESC, id);

    CREATE TABLE IF NOT EXISTS autonomous_paper_replay_variant_results (
      report_id TEXT NOT NULL,
      episode_id TEXT NOT NULL,
      lane_id TEXT NOT NULL,
      position_id TEXT NOT NULL,
      variant_index INTEGER NOT NULL CHECK (variant_index >= 0 AND variant_index < 1000),
      variant_id TEXT NOT NULL,
      configuration_digest TEXT NOT NULL CHECK (length(configuration_digest) = 64),
      outcome TEXT NOT NULL CHECK (outcome IN ('COMPLETED', 'NO_ENTRY', 'UNSCORABLE')),
      result_json TEXT NOT NULL,
      PRIMARY KEY (report_id, variant_index),
      UNIQUE (report_id, variant_id),
      FOREIGN KEY (report_id) REFERENCES autonomous_paper_replay_reports(id) ON DELETE CASCADE,
      FOREIGN KEY (episode_id) REFERENCES autonomous_paper_replay_episodes(id) ON DELETE CASCADE,
      FOREIGN KEY (lane_id) REFERENCES autonomous_paper_lanes(id) ON DELETE CASCADE,
      FOREIGN KEY (position_id) REFERENCES autonomous_paper_positions(id) ON DELETE CASCADE
    );

    -- Small transactional handoff ledger for the separate learning database.
    -- event_key makes retries idempotent; delivered rows remain as an audit
    -- trail and can be compacted only after a verified paired backup.
    CREATE TABLE IF NOT EXISTS learning_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_key TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      delivered_at TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    );
    CREATE INDEX IF NOT EXISTS learning_outbox_pending
      ON learning_outbox(delivered_at, id);

    CREATE INDEX IF NOT EXISTS autonomous_paper_replay_variant_episode
      ON autonomous_paper_replay_variant_results(episode_id, variant_index);

    -- Alpaca authentication is used only for read-only market data. This
    -- fourth PAPER ledger is physically isolated from crypto positions,
    -- executions, approvals, signers, and promotion evidence.
    CREATE TABLE IF NOT EXISTS stock_paper_lanes (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL CHECK (label = 'US STOCK HIGH-RISK PAPER — RESEARCH ONLY'),
      purpose TEXT NOT NULL CHECK (purpose = 'RESEARCH_ONLY'),
      policy_version TEXT NOT NULL,
      policy_json TEXT NOT NULL,
      initial_nav_usd REAL NOT NULL CHECK (initial_nav_usd > 0),
      status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'PAUSED', 'ARCHIVED')),
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS one_active_stock_paper_lane
      ON stock_paper_lanes(status)
      WHERE status = 'ACTIVE';

    CREATE TABLE IF NOT EXISTS stock_paper_accounts (
      lane_id TEXT PRIMARY KEY,
      account_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (lane_id) REFERENCES stock_paper_lanes(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS stock_paper_positions (
      id TEXT PRIMARY KEY,
      lane_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      arm TEXT NOT NULL CHECK (arm IN (
        'BREAKOUT', 'OPENING_RANGE', 'PULLBACK_RECOVERY', 'VOLUME_SURGE'
      )),
      status TEXT NOT NULL CHECK (status IN ('OPEN', 'CLOSED', 'UNPRICED')),
      position_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (lane_id) REFERENCES stock_paper_lanes(id) ON DELETE CASCADE
    );

    CREATE UNIQUE INDEX IF NOT EXISTS one_open_stock_paper_position_per_symbol
      ON stock_paper_positions(lane_id, symbol)
      WHERE status IN ('OPEN', 'UNPRICED');

    CREATE INDEX IF NOT EXISTS stock_paper_positions_lane_time
      ON stock_paper_positions(lane_id, updated_at DESC, id);

    CREATE TABLE IF NOT EXISTS stock_paper_signals (
      id TEXT PRIMARY KEY,
      lane_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      arm TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('BUY', 'SELL', 'OBSERVE', 'REJECT')),
      outcome TEXT NOT NULL CHECK (outcome IN (
        'SIMULATED', 'REJECTED', 'ANALYSIS_ONLY', 'FAILED'
      )),
      observed_at TEXT NOT NULL,
      signal_json TEXT NOT NULL,
      FOREIGN KEY (lane_id) REFERENCES stock_paper_lanes(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS stock_paper_signals_lane_time
      ON stock_paper_signals(lane_id, observed_at DESC, id);

    CREATE INDEX IF NOT EXISTS stock_paper_signals_symbol_time
      ON stock_paper_signals(lane_id, symbol, observed_at DESC, id);

    CREATE TABLE IF NOT EXISTS stock_paper_trades (
      id TEXT PRIMARY KEY,
      lane_id TEXT NOT NULL,
      position_id TEXT NOT NULL UNIQUE,
      symbol TEXT NOT NULL,
      arm TEXT NOT NULL,
      closed_at TEXT NOT NULL,
      trade_json TEXT NOT NULL,
      FOREIGN KEY (lane_id) REFERENCES stock_paper_lanes(id) ON DELETE CASCADE,
      FOREIGN KEY (position_id) REFERENCES stock_paper_positions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS stock_paper_trades_lane_time
      ON stock_paper_trades(lane_id, closed_at DESC, id);

    CREATE TABLE IF NOT EXISTS stock_paper_equity_points (
      lane_id TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      point_json TEXT NOT NULL,
      PRIMARY KEY (lane_id, captured_at),
      FOREIGN KEY (lane_id) REFERENCES stock_paper_lanes(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS stock_paper_equity_lane_time
      ON stock_paper_equity_points(lane_id, captured_at DESC);

    CREATE TABLE IF NOT EXISTS stock_paper_bars (
      lane_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      bar_time TEXT NOT NULL,
      bar_json TEXT NOT NULL,
      PRIMARY KEY (lane_id, symbol, bar_time),
      FOREIGN KEY (lane_id) REFERENCES stock_paper_lanes(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS stock_paper_bars_symbol_time
      ON stock_paper_bars(lane_id, symbol, bar_time);

    CREATE TABLE IF NOT EXISTS stock_paper_candidates (
      lane_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      score REAL NOT NULL,
      eligible INTEGER NOT NULL CHECK (eligible IN (0, 1)),
      captured_at TEXT NOT NULL,
      candidate_json TEXT NOT NULL,
      PRIMARY KEY (lane_id, symbol),
      FOREIGN KEY (lane_id) REFERENCES stock_paper_lanes(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS stock_paper_candidates_lane_rank
      ON stock_paper_candidates(lane_id, eligible DESC, score DESC, symbol);

    -- v38 makes the PAPER execution model restart-safe. No row in this ledger
    -- can be routed to a broker; it records only deterministic simulation
    -- intent and causal market-data evidence.
    CREATE TABLE IF NOT EXISTS stock_paper_orders (
      id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      lane_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
      status TEXT NOT NULL CHECK (status IN (
        'SUBMITTED', 'PARTIAL', 'FILLED', 'CANCELED', 'EXPIRED', 'REJECTED'
      )),
      submitted_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      order_json TEXT NOT NULL,
      FOREIGN KEY (lane_id) REFERENCES stock_paper_lanes(id) ON DELETE CASCADE
    );

    CREATE UNIQUE INDEX IF NOT EXISTS one_pending_stock_paper_order_per_symbol_side
      ON stock_paper_orders(lane_id, symbol, side)
      WHERE status IN ('SUBMITTED', 'PARTIAL');

    CREATE INDEX IF NOT EXISTS stock_paper_orders_lane_time
      ON stock_paper_orders(lane_id, updated_at DESC, id);

    -- v41 is an immutable execution-evidence ledger. stock_paper_orders keeps
    -- the restart state, while this table preserves every PAPER transition and
    -- fill without allowing a later cycle to overwrite its original clocks or
    -- market-data assumptions.
    CREATE TABLE IF NOT EXISTS stock_paper_order_events (
      id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      lane_id TEXT NOT NULL,
      order_id TEXT NOT NULL,
      event_sequence INTEGER NOT NULL CHECK (event_sequence >= 0),
      symbol TEXT NOT NULL,
      side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
      event_type TEXT NOT NULL CHECK (event_type IN (
        'SUBMISSION', 'STATUS_TRANSITION', 'FILL'
      )),
      prior_status TEXT CHECK (prior_status IS NULL OR prior_status IN (
        'SUBMITTED', 'PARTIAL', 'FILLED', 'CANCELED', 'EXPIRED', 'REJECTED'
      )),
      new_status TEXT NOT NULL CHECK (new_status IN (
        'SUBMITTED', 'PARTIAL', 'FILLED', 'CANCELED', 'EXPIRED', 'REJECTED'
      )),
      decision_at TEXT NOT NULL,
      evidence_bar_at TEXT,
      evidence_observed_at TEXT,
      quote_timestamp TEXT,
      phase TEXT NOT NULL CHECK (phase IN (
        'OVERNIGHT', 'PREMARKET', 'REGULAR', 'AFTER_HOURS', 'CLOSED', 'UNKNOWN'
      )),
      feed TEXT NOT NULL CHECK (feed IN ('IEX', 'OVERNIGHT')),
      created_at TEXT NOT NULL,
      event_json TEXT NOT NULL,
      FOREIGN KEY (lane_id) REFERENCES stock_paper_lanes(id) ON DELETE CASCADE,
      FOREIGN KEY (order_id) REFERENCES stock_paper_orders(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS stock_paper_order_events_order_time
      ON stock_paper_order_events(order_id, event_sequence);

    CREATE UNIQUE INDEX IF NOT EXISTS stock_paper_order_events_order_sequence
      ON stock_paper_order_events(order_id, event_sequence);

    CREATE INDEX IF NOT EXISTS stock_paper_order_events_lane_time
      ON stock_paper_order_events(lane_id, decision_at DESC, id);

    CREATE TABLE IF NOT EXISTS stock_paper_observations (
      id TEXT PRIMARY KEY,
      lane_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      decision TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      policy_version TEXT NOT NULL,
      observation_json TEXT NOT NULL,
      UNIQUE (id, lane_id),
      FOREIGN KEY (lane_id) REFERENCES stock_paper_lanes(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS stock_paper_observations_due
      ON stock_paper_observations(lane_id, observed_at, id);
    CREATE INDEX IF NOT EXISTS stock_paper_observations_symbol_time
      ON stock_paper_observations(lane_id, symbol, observed_at DESC);

    CREATE TABLE IF NOT EXISTS stock_paper_observation_outcomes (
      observation_id TEXT NOT NULL,
      lane_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      horizon_minutes INTEGER NOT NULL CHECK (horizon_minutes IN (15, 45, 180)),
      status TEXT NOT NULL CHECK (status IN ('LABELED', 'MISSING')),
      due_at TEXT NOT NULL,
      labeled_at TEXT NOT NULL,
      outcome_json TEXT NOT NULL,
      PRIMARY KEY (observation_id, horizon_minutes),
      FOREIGN KEY (observation_id, lane_id)
        REFERENCES stock_paper_observations(id, lane_id) ON DELETE CASCADE,
      FOREIGN KEY (lane_id) REFERENCES stock_paper_lanes(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS stock_paper_outcomes_lane_time
      ON stock_paper_observation_outcomes(lane_id, labeled_at DESC);

    -- v43 also records explicit simulated capital contributions. They may
    -- increase only the isolated research account and are separated from
    -- trading P&L so a bankroll change cannot masquerade as strategy profit.
    CREATE TABLE IF NOT EXISTS stock_paper_capital_events (
      id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      lane_id TEXT NOT NULL,
      event_type TEXT NOT NULL CHECK (event_type = 'DEPOSIT'),
      delta_usd REAL NOT NULL CHECK (delta_usd > 0),
      target_nav_usd REAL NOT NULL CHECK (target_nav_usd > 0),
      created_at TEXT NOT NULL,
      event_json TEXT NOT NULL,
      FOREIGN KEY (lane_id) REFERENCES stock_paper_lanes(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS stock_paper_capital_events_lane_time
      ON stock_paper_capital_events(lane_id, created_at DESC, id DESC);

    -- v43 adds an append-only, analysis-only one-step rotation ledger. These
    -- decisions observe the authoritative stock PAPER account, but deliberately
    -- have no account, position, order, execution, or promotion identity of
    -- their own. A policy can emit at most one decision per sampling bucket.
    CREATE TABLE IF NOT EXISTS stock_paper_rotation_decisions (
      id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      lane_id TEXT NOT NULL,
      policy_digest TEXT NOT NULL,
      idempotency_bucket TEXT NOT NULL,
      decision_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('ROTATE', 'HOLD')),
      decision_json TEXT NOT NULL,
      UNIQUE (id, lane_id),
      UNIQUE (lane_id, policy_digest, idempotency_bucket),
      FOREIGN KEY (lane_id) REFERENCES stock_paper_lanes(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS stock_paper_rotation_decisions_due
      ON stock_paper_rotation_decisions(lane_id, decision_at, id);
    CREATE INDEX IF NOT EXISTS stock_paper_rotation_decisions_recent
      ON stock_paper_rotation_decisions(lane_id, decision_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS stock_paper_rotation_outcomes (
      id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      decision_id TEXT NOT NULL,
      lane_id TEXT NOT NULL,
      horizon_minutes INTEGER NOT NULL CHECK (horizon_minutes IN (15, 45, 180)),
      status TEXT NOT NULL CHECK (status IN ('LABELED', 'MISSING')),
      due_at TEXT NOT NULL,
      labeled_at TEXT NOT NULL,
      outcome_json TEXT NOT NULL,
      UNIQUE (decision_id, horizon_minutes),
      FOREIGN KEY (decision_id, lane_id)
        REFERENCES stock_paper_rotation_decisions(id, lane_id) ON DELETE CASCADE,
      FOREIGN KEY (lane_id) REFERENCES stock_paper_lanes(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS stock_paper_rotation_outcomes_lane_time
      ON stock_paper_rotation_outcomes(lane_id, labeled_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS stock_paper_rotation_outcomes_decision
      ON stock_paper_rotation_outcomes(decision_id, horizon_minutes);

    CREATE TABLE IF NOT EXISTS stock_paper_shadow_results (
      id TEXT PRIMARY KEY,
      lane_id TEXT NOT NULL,
      policy_id TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      result_json TEXT NOT NULL,
      FOREIGN KEY (lane_id) REFERENCES stock_paper_lanes(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS stock_paper_shadow_lane_time
      ON stock_paper_shadow_results(lane_id, captured_at DESC, policy_id);

    -- v40 persists full research-validation provenance separately from the
    -- minute-critical trading cycle. These artifacts are analysis-only and
    -- cannot activate or mutate a trading policy. Dataset provenance remains
    -- separate from the versioned evaluation identity so the same frozen data
    -- can be evaluated under multiple configurations.
    CREATE TABLE IF NOT EXISTS stock_paper_learning_checkpoints (
      id TEXT PRIMARY KEY,
      lane_id TEXT NOT NULL,
      dataset_digest TEXT NOT NULL,
      evaluation_digest TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      cutoff_at TEXT NOT NULL,
      checkpoint_json TEXT NOT NULL,
      UNIQUE (lane_id, evaluation_digest),
      FOREIGN KEY (lane_id) REFERENCES stock_paper_lanes(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS stock_paper_learning_checkpoint_lane_time
      ON stock_paper_learning_checkpoints(lane_id, captured_at DESC, id);

    CREATE TABLE IF NOT EXISTS stock_paper_news_evidence (
      article_id TEXT NOT NULL,
      lane_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      created_at TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      PRIMARY KEY (lane_id, article_id, symbol),
      FOREIGN KEY (lane_id) REFERENCES stock_paper_lanes(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS stock_paper_news_symbol_time
      ON stock_paper_news_evidence(lane_id, symbol, created_at DESC);

    -- The wallet intelligence index is intentionally separate from source_events,
    -- which remains the small, time-sensitive copy-signal ledger.
    CREATE TABLE IF NOT EXISTS ingestion_checkpoints (
      pipeline TEXT NOT NULL,
      partition_key TEXT NOT NULL,
      cursor_json TEXT NOT NULL,
      completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
      updated_at TEXT NOT NULL,
      PRIMARY KEY (pipeline, partition_key)
    );

    CREATE INDEX IF NOT EXISTS ingestion_checkpoints_updated
      ON ingestion_checkpoints(updated_at DESC);

    CREATE TABLE IF NOT EXISTS index_signature_queue (
      signature TEXT PRIMARY KEY,
      slot INTEGER,
      block_time TEXT,
      status TEXT NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING', 'LEASED', 'PROCESSED', 'RETRY', 'FAILED')),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      priority INTEGER NOT NULL DEFAULT 0,
      discovered_at TEXT NOT NULL,
      available_at TEXT NOT NULL,
      lease_owner TEXT,
      lease_token TEXT,
      leased_at TEXT,
      lease_expires_at TEXT,
      last_error TEXT,
      processed_at TEXT,
      updated_at TEXT NOT NULL,
      CHECK (
        (status = 'LEASED' AND lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
        OR
        (status <> 'LEASED' AND lease_owner IS NULL AND lease_token IS NULL AND leased_at IS NULL AND lease_expires_at IS NULL)
      )
    );

    CREATE INDEX IF NOT EXISTS index_signature_queue_ready
      ON index_signature_queue(status, available_at, priority DESC, discovered_at, signature);
    CREATE INDEX IF NOT EXISTS index_signature_queue_status_discovered
      ON index_signature_queue(status, discovered_at, signature);
    CREATE INDEX IF NOT EXISTS index_signature_queue_lease_expiry
      ON index_signature_queue(lease_expires_at)
      WHERE status = 'LEASED';
    CREATE INDEX IF NOT EXISTS index_signature_queue_block_time
      ON index_signature_queue(block_time DESC)
      WHERE block_time IS NOT NULL;

    CREATE TABLE IF NOT EXISTS index_signature_sources (
      signature TEXT NOT NULL,
      source_address TEXT NOT NULL,
      wallet TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      discovery_count INTEGER NOT NULL DEFAULT 1 CHECK (discovery_count > 0),
      first_run_id TEXT,
      last_run_id TEXT,
      metadata_json TEXT,
      PRIMARY KEY (signature, source_address, wallet, source),
      FOREIGN KEY (signature) REFERENCES index_signature_queue(signature) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS index_signature_sources_wallet
      ON index_signature_sources(wallet, last_seen_at DESC, signature);
    CREATE INDEX IF NOT EXISTS index_signature_sources_address
      ON index_signature_sources(source_address, last_seen_at DESC, signature);
    CREATE INDEX IF NOT EXISTS index_signature_sources_run
      ON index_signature_sources(last_run_id, last_seen_at DESC)
      WHERE last_run_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS indexed_transactions (
      signature TEXT PRIMARY KEY,
      slot INTEGER,
      block_time TEXT,
      success INTEGER,
      fee_payer TEXT,
      source_wallets_json TEXT NOT NULL,
      account_keys_json TEXT,
      program_ids_json TEXT,
      transaction_json TEXT NOT NULL,
      indexed_at TEXT NOT NULL,
      hydration_provenance TEXT,
      decoder_version TEXT,
      hydrated_at TEXT,
      FOREIGN KEY (signature) REFERENCES index_signature_queue(signature) ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS indexed_transactions_block_time
      ON indexed_transactions(block_time DESC, signature);
    CREATE INDEX IF NOT EXISTS indexed_transactions_slot
      ON indexed_transactions(slot DESC)
      WHERE slot IS NOT NULL;
    -- Coarse wallet acquisition ranks successful fee payers without reading
    -- the multi-kilobyte transaction_json payload from every hydrated row.
    -- The predicate and column order also make each selected wallet's newest
    -- unseen transaction a bounded covering-index lookup.
    CREATE INDEX IF NOT EXISTS indexed_transactions_coarse_wallet_candidates
      ON indexed_transactions(fee_payer, block_time DESC, signature, slot, success)
      WHERE success = 1 AND fee_payer IS NOT NULL AND fee_payer <> '';

    -- Compact durable seam between transaction hydration and coarse wallet
    -- admission. The transaction ledger contains multi-kilobyte JSON rows, so
    -- repeatedly grouping it stalls the loopback server. These scalar-only
    -- tables are maintained transactionally as hydration completes and are
    -- backfilled once during the v26 migration.
    CREATE TABLE IF NOT EXISTS coarse_wallet_candidate_transactions (
      signature TEXT NOT NULL,
      program_id TEXT NOT NULL,
      wallet TEXT NOT NULL,
      slot INTEGER,
      block_time TEXT,
      observed_at TEXT NOT NULL,
      classified INTEGER NOT NULL DEFAULT 0 CHECK (classified IN (0, 1)),
      PRIMARY KEY (signature, program_id),
      FOREIGN KEY (signature) REFERENCES indexed_transactions(signature) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS coarse_wallet_candidate_pending
      ON coarse_wallet_candidate_transactions(
        program_id, classified, wallet, block_time DESC, signature
      );

    CREATE TABLE IF NOT EXISTS coarse_wallet_candidate_activity (
      wallet TEXT NOT NULL,
      program_id TEXT NOT NULL,
      observed_successful_transactions INTEGER NOT NULL CHECK (observed_successful_transactions >= 1),
      latest_observed_at TEXT NOT NULL,
      PRIMARY KEY (wallet, program_id)
    );

    CREATE INDEX IF NOT EXISTS coarse_wallet_candidate_activity_rank
      ON coarse_wallet_candidate_activity(
        program_id, observed_successful_transactions DESC, latest_observed_at DESC, wallet
      );

    -- A repair manifest freezes one exact historical run and cutoff before any
    -- provider request is made. Its queue and metrics are deliberately
    -- separate from wallet_index_runs, so recovery can never rewrite the
    -- original acquisition counters or silently widen its source horizon.
    CREATE TABLE IF NOT EXISTS parsed_block_repair_manifests (
      id TEXT PRIMARY KEY,
      repair_version TEXT NOT NULL,
      decoder_version TEXT NOT NULL,
      source_run_id TEXT NOT NULL,
      source_run_started_at TEXT NOT NULL,
      cutoff_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING', 'RUNNING', 'COMPLETE', 'FAILED')),
      maximum_items INTEGER NOT NULL CHECK (maximum_items >= 1),
      item_count INTEGER NOT NULL DEFAULT 0 CHECK (item_count >= 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      last_error TEXT,
      UNIQUE (source_run_id, repair_version)
    );

    CREATE INDEX IF NOT EXISTS parsed_block_repair_manifests_status
      ON parsed_block_repair_manifests(status, created_at);

    CREATE TABLE IF NOT EXISTS parsed_block_repair_items (
      manifest_id TEXT NOT NULL,
      signature TEXT NOT NULL,
      slot INTEGER NOT NULL CHECK (slot >= 0),
      source_programs_json TEXT NOT NULL,
      source_indexed_at TEXT NOT NULL,
      source_transaction_digest TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING', 'LEASED', 'RETRY', 'RECOVERED', 'VALID_ZERO', 'FAILED')),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      available_at TEXT NOT NULL,
      lease_owner TEXT,
      lease_token TEXT,
      leased_at TEXT,
      lease_expires_at TEXT,
      last_error TEXT,
      result_swap_count INTEGER CHECK (result_swap_count IS NULL OR result_swap_count >= 0),
      hydration_provenance TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      PRIMARY KEY (manifest_id, signature),
      FOREIGN KEY (manifest_id) REFERENCES parsed_block_repair_manifests(id) ON DELETE CASCADE,
      FOREIGN KEY (signature) REFERENCES indexed_transactions(signature) ON DELETE RESTRICT,
      CHECK (
        (status = 'LEASED' AND lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
        OR
        (status <> 'LEASED' AND lease_owner IS NULL AND lease_token IS NULL AND leased_at IS NULL AND lease_expires_at IS NULL)
      )
    );

    CREATE INDEX IF NOT EXISTS parsed_block_repair_items_ready
      ON parsed_block_repair_items(manifest_id, status, available_at, slot, source_indexed_at, signature);
    CREATE INDEX IF NOT EXISTS parsed_block_repair_items_lease_expiry
      ON parsed_block_repair_items(lease_expires_at)
      WHERE status = 'LEASED';

    -- Minimal normalized evidence for provider-independent wallet identity.
    -- Full RPC transaction payloads are intentionally not retained.
    CREATE TABLE IF NOT EXISTS wallet_identity_transaction_evidence (
      wallet TEXT NOT NULL,
      signature TEXT NOT NULL,
      block_time TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      indexed_at TEXT NOT NULL,
      PRIMARY KEY (wallet, signature),
      FOREIGN KEY (signature) REFERENCES indexed_transactions(signature) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS wallet_identity_evidence_wallet_time
      ON wallet_identity_transaction_evidence(wallet, block_time, signature);

    CREATE TABLE IF NOT EXISTS wallet_identity_first_pools (
      mint TEXT PRIMARY KEY,
      first_pool_at TEXT,
      source TEXT NOT NULL CHECK (source = 'JUPITER'),
      checked_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS wallet_identity_first_pools_checked
      ON wallet_identity_first_pools(checked_at DESC, mint);

    CREATE TABLE IF NOT EXISTS indexed_spot_swaps (
      id TEXT PRIMARY KEY,
      signature TEXT NOT NULL,
      wallet TEXT NOT NULL,
      swap_index INTEGER NOT NULL CHECK (swap_index >= 0),
      slot INTEGER NOT NULL,
      block_time TEXT NOT NULL,
      side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
      base_mint TEXT NOT NULL,
      target_mint TEXT NOT NULL,
      input_mint TEXT NOT NULL,
      output_mint TEXT NOT NULL,
      input_amount_atomic TEXT NOT NULL,
      output_amount_atomic TEXT NOT NULL,
      eligible INTEGER NOT NULL CHECK (eligible IN (0, 1)),
      closes_position INTEGER NOT NULL DEFAULT 0 CHECK (closes_position IN (0, 1)),
      holding_minutes REAL,
      realized_pnl_usd REAL,
      swap_json TEXT NOT NULL,
      indexed_at TEXT NOT NULL,
      UNIQUE (signature, wallet, swap_index),
      FOREIGN KEY (signature) REFERENCES indexed_transactions(signature) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS indexed_spot_swaps_wallet_time
      ON indexed_spot_swaps(wallet, block_time DESC, signature);
    CREATE INDEX IF NOT EXISTS indexed_spot_swaps_wallet_eligible_time
      ON indexed_spot_swaps(wallet, eligible, block_time DESC);
    CREATE INDEX IF NOT EXISTS indexed_spot_swaps_target_time
      ON indexed_spot_swaps(target_mint, block_time DESC);
    CREATE INDEX IF NOT EXISTS indexed_spot_swaps_closed
      ON indexed_spot_swaps(wallet, block_time DESC)
      WHERE eligible = 1 AND closes_position = 1;

    -- Wallet aggregates are recomputed outside the transaction hydration loop.
    -- This durable marker makes that batching crash-safe.
    CREATE TABLE IF NOT EXISTS wallet_index_dirty (
      wallet TEXT PRIMARY KEY,
      marked_at TEXT NOT NULL,
      last_signature TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS wallet_index (
      wallet TEXT PRIMARY KEY,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      history_days INTEGER NOT NULL CHECK (history_days >= 0),
      transaction_count INTEGER NOT NULL CHECK (transaction_count >= 0),
      successful_transaction_count INTEGER NOT NULL CHECK (successful_transaction_count >= 0),
      spot_swap_count INTEGER NOT NULL CHECK (spot_swap_count >= 0),
      eligible_spot_swap_count INTEGER NOT NULL CHECK (eligible_spot_swap_count >= 0),
      closed_eligible_swaps INTEGER NOT NULL CHECK (closed_eligible_swaps >= 0),
      buy_count INTEGER NOT NULL CHECK (buy_count >= 0),
      sell_count INTEGER NOT NULL CHECK (sell_count >= 0),
      active_days INTEGER NOT NULL CHECK (active_days >= 0),
      active_weeks INTEGER NOT NULL CHECK (active_weeks >= 0),
      distinct_mints INTEGER NOT NULL CHECK (distinct_mints >= 0),
      median_holding_minutes REAL NOT NULL CHECK (median_holding_minutes >= 0),
      prescreen_eligible INTEGER NOT NULL CHECK (prescreen_eligible IN (0, 1)),
      record_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS wallet_index_prescreen
      ON wallet_index(prescreen_eligible, history_days DESC, closed_eligible_swaps DESC, active_weeks DESC);
    CREATE INDEX IF NOT EXISTS wallet_index_prescreen_pending
      ON wallet_index(updated_at, wallet);
    CREATE INDEX IF NOT EXISTS wallet_index_recent
      ON wallet_index(last_seen_at DESC, wallet);

    CREATE TABLE IF NOT EXISTS wallet_activity_samples (
      wallet TEXT NOT NULL,
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      sample_json TEXT NOT NULL,
      sampled_at TEXT NOT NULL,
      PRIMARY KEY (wallet, period_start, period_end)
    );

    CREATE INDEX IF NOT EXISTS wallet_activity_samples_period
      ON wallet_activity_samples(period_end DESC, wallet);

    CREATE TABLE IF NOT EXISTS wallet_prescreen_snapshots (
      wallet TEXT NOT NULL,
      run_id TEXT NOT NULL,
      calculated_at TEXT NOT NULL,
      eligible INTEGER NOT NULL CHECK (eligible IN (0, 1)),
      reasons_json TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      PRIMARY KEY (wallet, run_id)
    );

    CREATE INDEX IF NOT EXISTS wallet_prescreen_snapshots_run
      ON wallet_prescreen_snapshots(run_id, eligible, calculated_at DESC);
    CREATE INDEX IF NOT EXISTS wallet_prescreen_snapshots_wallet_time
      ON wallet_prescreen_snapshots(wallet, calculated_at DESC);

    CREATE TABLE IF NOT EXISTS wallet_history_reconciliations (
      id TEXT PRIMARY KEY,
      wallet TEXT NOT NULL,
      cohort_id TEXT NOT NULL,
      compared_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('LOCAL_UNAVAILABLE', 'PARTIAL', 'CONSISTENT', 'DIVERGENT')),
      comparable_metrics INTEGER NOT NULL CHECK (comparable_metrics >= 0),
      mismatch_metrics INTEGER NOT NULL CHECK (mismatch_metrics >= 0),
      snapshot_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS wallet_history_reconciliations_wallet_time
      ON wallet_history_reconciliations(wallet, compared_at DESC);
    CREATE INDEX IF NOT EXISTS wallet_history_reconciliations_cohort_status
      ON wallet_history_reconciliations(cohort_id, status, compared_at DESC);

    CREATE TABLE IF NOT EXISTS wallet_index_runs (
      id TEXT PRIMARY KEY,
      stage TEXT NOT NULL CHECK (
        stage IN ('DISCOVERY', 'HYDRATION', 'PRESCREEN', 'HISTORY', 'COMPLETE', 'PAUSED', 'FAILED')
      ),
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      finished_at TEXT,
      discovered_wallets INTEGER NOT NULL DEFAULT 0 CHECK (discovered_wallets >= 0),
      enqueued_signatures INTEGER NOT NULL DEFAULT 0 CHECK (enqueued_signatures >= 0),
      hydrated_transactions INTEGER NOT NULL DEFAULT 0 CHECK (hydrated_transactions >= 0),
      indexed_swaps INTEGER NOT NULL DEFAULT 0 CHECK (indexed_swaps >= 0),
      prescreened_wallets INTEGER NOT NULL DEFAULT 0 CHECK (prescreened_wallets >= 0),
      qualified_wallets INTEGER NOT NULL DEFAULT 0 CHECK (qualified_wallets >= 0),
      run_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS wallet_index_runs_stage_time
      ON wallet_index_runs(stage, updated_at DESC);
    CREATE INDEX IF NOT EXISTS wallet_index_runs_started
      ON wallet_index_runs(started_at DESC);

    CREATE TABLE IF NOT EXISTS wallet_deep_history_generations (
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

    CREATE TABLE IF NOT EXISTS wallet_deep_history_cohorts (
      id TEXT PRIMARY KEY,
      sequence INTEGER NOT NULL UNIQUE CHECK (sequence >= 1),
      generation_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('OPEN', 'COMPLETE')),
      selected_at TEXT NOT NULL,
      snapshot_cutoff_at TEXT NOT NULL,
      window_start TEXT NOT NULL,
      window_end TEXT NOT NULL,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      FOREIGN KEY (generation_id) REFERENCES wallet_deep_history_generations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS wallet_deep_history_targets (
      cohort_id TEXT NOT NULL,
      generation_id TEXT NOT NULL,
      wallet TEXT NOT NULL,
      ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
      PRIMARY KEY (cohort_id, wallet),
      UNIQUE (generation_id, wallet),
      FOREIGN KEY (cohort_id) REFERENCES wallet_deep_history_cohorts(id) ON DELETE CASCADE,
      FOREIGN KEY (generation_id) REFERENCES wallet_deep_history_generations(id) ON DELETE CASCADE
    );

    -- Managed screening is deliberately separate from exact deep-history
    -- evidence. A coarse skip can only defer an expensive target; it can
    -- never masquerade as an exact failure or make a local generation
    -- COMPLETE.
    CREATE TABLE IF NOT EXISTS wallet_deep_history_target_dispositions (
      cohort_id TEXT NOT NULL,
      generation_id TEXT NOT NULL,
      wallet TEXT NOT NULL,
      disposition TEXT NOT NULL CHECK (disposition = 'COARSE_COPYABILITY_SKIP'),
      policy_version TEXT NOT NULL,
      snapshot_calculated_at TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      snapshot_digest TEXT NOT NULL,
      details_json TEXT NOT NULL,
      decision_digest TEXT NOT NULL UNIQUE,
      decided_at TEXT NOT NULL,
      PRIMARY KEY (cohort_id, wallet),
      FOREIGN KEY (cohort_id, wallet)
        REFERENCES wallet_deep_history_targets(cohort_id, wallet) ON DELETE CASCADE,
      FOREIGN KEY (generation_id) REFERENCES wallet_deep_history_generations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS wallet_deep_history_managed_cohort_screenings (
      cohort_id TEXT PRIMARY KEY,
      generation_id TEXT NOT NULL,
      policy_version TEXT NOT NULL,
      manifest_digest TEXT NOT NULL UNIQUE,
      details_json TEXT NOT NULL,
      screened_at TEXT NOT NULL,
      FOREIGN KEY (cohort_id) REFERENCES wallet_deep_history_cohorts(id) ON DELETE CASCADE,
      FOREIGN KEY (generation_id) REFERENCES wallet_deep_history_generations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS wallet_deep_history_managed_generation_screenings (
      generation_id TEXT PRIMARY KEY,
      policy_version TEXT NOT NULL,
      manifest_digest TEXT NOT NULL UNIQUE,
      details_json TEXT NOT NULL,
      screened_at TEXT NOT NULL,
      FOREIGN KEY (generation_id) REFERENCES wallet_deep_history_generations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS wallet_deep_history_signatures (
      cohort_id TEXT NOT NULL,
      generation_id TEXT NOT NULL,
      wallet TEXT NOT NULL,
      signature TEXT NOT NULL,
      block_time TEXT,
      discovered_at TEXT NOT NULL,
      PRIMARY KEY (cohort_id, wallet, signature),
      FOREIGN KEY (cohort_id) REFERENCES wallet_deep_history_cohorts(id) ON DELETE CASCADE,
      FOREIGN KEY (generation_id) REFERENCES wallet_deep_history_generations(id) ON DELETE CASCADE,
      FOREIGN KEY (signature) REFERENCES index_signature_queue(signature) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS wallet_deep_history_evidence (
      generation_id TEXT NOT NULL,
      cohort_id TEXT NOT NULL,
      wallet TEXT NOT NULL,
      record_json TEXT NOT NULL,
      swaps_json TEXT NOT NULL,
      evidence_digest TEXT NOT NULL,
      frozen_at TEXT NOT NULL,
      PRIMARY KEY (generation_id, wallet),
      FOREIGN KEY (generation_id) REFERENCES wallet_deep_history_generations(id) ON DELETE CASCADE,
      FOREIGN KEY (cohort_id) REFERENCES wallet_deep_history_cohorts(id) ON DELETE CASCADE
    );

    -- Provider-backed preflight is a durable, resumable gate in front of the
    -- comparatively expensive exact-history rescue. PASS is the only state
    -- that can authorize a v3 rescue cohort; transient provider failures stay
    -- retryable and partial responses survive a restart.
    CREATE TABLE IF NOT EXISTS managed_recovery_preflights (
      id TEXT PRIMARY KEY,
      policy_version TEXT NOT NULL,
      week TEXT NOT NULL,
      window_start TEXT NOT NULL,
      wallet TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('READY', 'RUNNING', 'RETRY', 'PASS', 'REJECTED')),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      next_attempt_at TEXT NOT NULL,
      pnl30_json TEXT,
      pnl90_json TEXT,
      history_json TEXT,
      reasons_json TEXT NOT NULL,
      checked_at TEXT,
      expires_at TEXT,
      last_error TEXT,
      updated_at TEXT NOT NULL,
      UNIQUE (policy_version, window_start, wallet)
    );

    CREATE TABLE IF NOT EXISTS managed_recovery_preflight_authorizations (
      cohort_id TEXT NOT NULL,
      wallet TEXT NOT NULL,
      preflight_id TEXT NOT NULL,
      PRIMARY KEY (cohort_id, wallet),
      FOREIGN KEY (cohort_id, wallet)
        REFERENCES wallet_deep_history_targets(cohort_id, wallet) ON DELETE CASCADE,
      FOREIGN KEY (preflight_id) REFERENCES managed_recovery_preflights(id) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS indexed_swap_reprice_queue (
      swap_id TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK (status IN ('PENDING', 'COMPLETE')),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      available_at TEXT NOT NULL,
      last_error TEXT,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (swap_id) REFERENCES indexed_spot_swaps(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS wallet_deep_history_generations_status_sequence
      ON wallet_deep_history_generations(status, sequence);
    CREATE INDEX IF NOT EXISTS wallet_deep_history_cohorts_status_sequence
      ON wallet_deep_history_cohorts(status, sequence);
    CREATE INDEX IF NOT EXISTS wallet_deep_history_targets_cohort_order
      ON wallet_deep_history_targets(cohort_id, ordinal);
    CREATE INDEX IF NOT EXISTS wallet_deep_history_targets_generation_order
      ON wallet_deep_history_targets(generation_id, cohort_id, ordinal);
    CREATE INDEX IF NOT EXISTS wallet_deep_history_target_dispositions_generation
      ON wallet_deep_history_target_dispositions(generation_id, cohort_id, wallet);
    CREATE INDEX IF NOT EXISTS wallet_deep_history_signatures_wallet
      ON wallet_deep_history_signatures(cohort_id, wallet, block_time, signature);
    CREATE INDEX IF NOT EXISTS wallet_deep_history_evidence_cohort
      ON wallet_deep_history_evidence(cohort_id, wallet);
    CREATE INDEX IF NOT EXISTS managed_recovery_preflights_ready
      ON managed_recovery_preflights(policy_version, window_start, status, next_attempt_at, updated_at);
    CREATE INDEX IF NOT EXISTS managed_recovery_preflights_wallet
      ON managed_recovery_preflights(wallet, updated_at DESC);
    CREATE INDEX IF NOT EXISTS managed_recovery_preflight_authorizations_preflight
      ON managed_recovery_preflight_authorizations(preflight_id, cohort_id, wallet);
    CREATE INDEX IF NOT EXISTS indexed_swap_reprice_queue_ready
      ON indexed_swap_reprice_queue(status, available_at, swap_id);
    -- Dashboard and deep-history coverage checks start from the pending
    -- reprice queue and need only each swap's timestamp. Covering that lookup
    -- avoids tens of thousands of random reads from the large swap table.
    CREATE INDEX IF NOT EXISTS indexed_spot_swaps_reprice_time
      ON indexed_spot_swaps(id, block_time);

    CREATE TABLE IF NOT EXISTS wallet_research_handoffs (
      generation TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('READY', 'RUNNING', 'RETRY', 'COMPLETE')),
      wallets_json TEXT NOT NULL,
      ready_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      next_attempt_at TEXT NOT NULL,
      last_error TEXT,
      completed_at TEXT,
      cohort_id TEXT
    );

    CREATE INDEX IF NOT EXISTS wallet_research_handoffs_ready
      ON wallet_research_handoffs(status, next_attempt_at, ready_at);

    -- Exact, transactionally maintained coverage counters keep high-frequency
    -- dashboard reads from scanning the growing queue and transaction tables.
    CREATE TABLE IF NOT EXISTS wallet_index_metrics (
      metric TEXT PRIMARY KEY,
      integer_value INTEGER,
      text_value TEXT
    );

    INSERT OR REPLACE INTO wallet_index_metrics(metric, integer_value, text_value)
      SELECT 'uniqueSignatures', COUNT(*), NULL FROM index_signature_queue;
    INSERT OR REPLACE INTO wallet_index_metrics(metric, integer_value, text_value)
      SELECT 'sourceLinks', COUNT(*), NULL FROM index_signature_sources;
    INSERT OR REPLACE INTO wallet_index_metrics(metric, integer_value, text_value)
      SELECT 'indexedTransactions', COUNT(*), NULL FROM indexed_transactions;
    INSERT OR REPLACE INTO wallet_index_metrics(metric, integer_value, text_value)
      SELECT 'indexedSwaps', COUNT(*), NULL FROM indexed_spot_swaps;
    INSERT OR REPLACE INTO wallet_index_metrics(metric, integer_value, text_value)
      SELECT 'indexedWallets', COUNT(*), NULL FROM wallet_index;
    INSERT OR REPLACE INTO wallet_index_metrics(metric, integer_value, text_value)
      SELECT 'preScreenEligibleWallets', COUNT(*), NULL FROM wallet_index WHERE prescreen_eligible = 1;
    INSERT OR REPLACE INTO wallet_index_metrics(metric, integer_value, text_value)
      SELECT 'activitySamples', COUNT(*), NULL FROM wallet_activity_samples;
    INSERT OR REPLACE INTO wallet_index_metrics(metric, integer_value, text_value)
      SELECT 'preScreenSnapshots', COUNT(*), NULL FROM wallet_prescreen_snapshots;
    INSERT OR REPLACE INTO wallet_index_metrics(metric, integer_value, text_value)
      SELECT 'checkpoints', COUNT(*), NULL FROM ingestion_checkpoints;
    INSERT OR REPLACE INTO wallet_index_metrics(metric, integer_value, text_value)
      SELECT 'activeRuns', COUNT(*), NULL FROM wallet_index_runs
      WHERE stage NOT IN ('COMPLETE', 'FAILED');
    INSERT OR REPLACE INTO wallet_index_metrics(metric, integer_value, text_value)
      SELECT 'oldestBlockTime', NULL, MIN(block_time) FROM indexed_transactions WHERE block_time IS NOT NULL;
    INSERT OR REPLACE INTO wallet_index_metrics(metric, integer_value, text_value)
      SELECT 'newestBlockTime', NULL, MAX(block_time) FROM indexed_transactions WHERE block_time IS NOT NULL;
    INSERT OR REPLACE INTO wallet_index_metrics(metric, integer_value, text_value)
      SELECT 'queue:' || status, COUNT(*), NULL FROM index_signature_queue GROUP BY status;
    INSERT OR IGNORE INTO wallet_index_metrics(metric, integer_value, text_value) VALUES
      ('queue:PENDING', 0, NULL),
      ('queue:LEASED', 0, NULL),
      ('queue:PROCESSED', 0, NULL),
      ('queue:RETRY', 0, NULL),
      ('queue:FAILED', 0, NULL);

    CREATE TRIGGER IF NOT EXISTS wallet_metric_queue_insert
    AFTER INSERT ON index_signature_queue BEGIN
      UPDATE wallet_index_metrics SET integer_value = integer_value + 1 WHERE metric = 'uniqueSignatures';
      UPDATE wallet_index_metrics SET integer_value = integer_value + 1 WHERE metric = 'queue:' || NEW.status;
    END;
    CREATE TRIGGER IF NOT EXISTS wallet_metric_queue_delete
    AFTER DELETE ON index_signature_queue BEGIN
      UPDATE wallet_index_metrics SET integer_value = integer_value - 1 WHERE metric = 'uniqueSignatures';
      UPDATE wallet_index_metrics SET integer_value = integer_value - 1 WHERE metric = 'queue:' || OLD.status;
    END;
    CREATE TRIGGER IF NOT EXISTS wallet_metric_queue_status
    AFTER UPDATE OF status ON index_signature_queue
    WHEN OLD.status <> NEW.status BEGIN
      UPDATE wallet_index_metrics SET integer_value = integer_value - 1 WHERE metric = 'queue:' || OLD.status;
      UPDATE wallet_index_metrics SET integer_value = integer_value + 1 WHERE metric = 'queue:' || NEW.status;
    END;

    CREATE TRIGGER IF NOT EXISTS wallet_metric_source_insert
    AFTER INSERT ON index_signature_sources BEGIN
      UPDATE wallet_index_metrics SET integer_value = integer_value + 1 WHERE metric = 'sourceLinks';
    END;
    CREATE TRIGGER IF NOT EXISTS wallet_metric_source_delete
    AFTER DELETE ON index_signature_sources BEGIN
      UPDATE wallet_index_metrics SET integer_value = integer_value - 1 WHERE metric = 'sourceLinks';
    END;

    CREATE TRIGGER IF NOT EXISTS wallet_metric_transaction_insert
    AFTER INSERT ON indexed_transactions BEGIN
      UPDATE wallet_index_metrics SET integer_value = integer_value + 1 WHERE metric = 'indexedTransactions';
      UPDATE wallet_index_metrics
        SET text_value = CASE WHEN text_value IS NULL OR NEW.block_time < text_value THEN NEW.block_time ELSE text_value END
        WHERE metric = 'oldestBlockTime' AND NEW.block_time IS NOT NULL;
      UPDATE wallet_index_metrics
        SET text_value = CASE WHEN text_value IS NULL OR NEW.block_time > text_value THEN NEW.block_time ELSE text_value END
        WHERE metric = 'newestBlockTime' AND NEW.block_time IS NOT NULL;
    END;
    CREATE TRIGGER IF NOT EXISTS wallet_metric_transaction_delete
    AFTER DELETE ON indexed_transactions BEGIN
      UPDATE wallet_index_metrics SET integer_value = integer_value - 1 WHERE metric = 'indexedTransactions';
      UPDATE wallet_index_metrics SET text_value = (SELECT MIN(block_time) FROM indexed_transactions WHERE block_time IS NOT NULL)
        WHERE metric = 'oldestBlockTime';
      UPDATE wallet_index_metrics SET text_value = (SELECT MAX(block_time) FROM indexed_transactions WHERE block_time IS NOT NULL)
        WHERE metric = 'newestBlockTime';
    END;
    CREATE TRIGGER IF NOT EXISTS wallet_metric_transaction_time
    AFTER UPDATE OF block_time ON indexed_transactions
    WHEN OLD.block_time IS NOT NEW.block_time BEGIN
      UPDATE wallet_index_metrics SET text_value = (SELECT MIN(block_time) FROM indexed_transactions WHERE block_time IS NOT NULL)
        WHERE metric = 'oldestBlockTime';
      UPDATE wallet_index_metrics SET text_value = (SELECT MAX(block_time) FROM indexed_transactions WHERE block_time IS NOT NULL)
        WHERE metric = 'newestBlockTime';
    END;

    CREATE TRIGGER IF NOT EXISTS wallet_metric_swap_insert
    AFTER INSERT ON indexed_spot_swaps BEGIN
      UPDATE wallet_index_metrics SET integer_value = integer_value + 1 WHERE metric = 'indexedSwaps';
    END;
    CREATE TRIGGER IF NOT EXISTS wallet_metric_swap_delete
    AFTER DELETE ON indexed_spot_swaps BEGIN
      UPDATE wallet_index_metrics SET integer_value = integer_value - 1 WHERE metric = 'indexedSwaps';
    END;

    CREATE TRIGGER IF NOT EXISTS wallet_metric_wallet_insert
    AFTER INSERT ON wallet_index BEGIN
      UPDATE wallet_index_metrics SET integer_value = integer_value + 1 WHERE metric = 'indexedWallets';
      UPDATE wallet_index_metrics SET integer_value = integer_value + NEW.prescreen_eligible
        WHERE metric = 'preScreenEligibleWallets';
    END;
    CREATE TRIGGER IF NOT EXISTS wallet_metric_wallet_delete
    AFTER DELETE ON wallet_index BEGIN
      UPDATE wallet_index_metrics SET integer_value = integer_value - 1 WHERE metric = 'indexedWallets';
      UPDATE wallet_index_metrics SET integer_value = integer_value - OLD.prescreen_eligible
        WHERE metric = 'preScreenEligibleWallets';
    END;
    CREATE TRIGGER IF NOT EXISTS wallet_metric_wallet_prescreen
    AFTER UPDATE OF prescreen_eligible ON wallet_index
    WHEN OLD.prescreen_eligible <> NEW.prescreen_eligible BEGIN
      UPDATE wallet_index_metrics SET integer_value = integer_value + NEW.prescreen_eligible - OLD.prescreen_eligible
        WHERE metric = 'preScreenEligibleWallets';
    END;

    CREATE TRIGGER IF NOT EXISTS wallet_metric_activity_insert
    AFTER INSERT ON wallet_activity_samples BEGIN
      UPDATE wallet_index_metrics SET integer_value = integer_value + 1 WHERE metric = 'activitySamples';
    END;
    CREATE TRIGGER IF NOT EXISTS wallet_metric_activity_delete
    AFTER DELETE ON wallet_activity_samples BEGIN
      UPDATE wallet_index_metrics SET integer_value = integer_value - 1 WHERE metric = 'activitySamples';
    END;
    CREATE TRIGGER IF NOT EXISTS wallet_metric_prescreen_insert
    AFTER INSERT ON wallet_prescreen_snapshots BEGIN
      UPDATE wallet_index_metrics SET integer_value = integer_value + 1 WHERE metric = 'preScreenSnapshots';
    END;
    CREATE TRIGGER IF NOT EXISTS wallet_metric_prescreen_delete
    AFTER DELETE ON wallet_prescreen_snapshots BEGIN
      UPDATE wallet_index_metrics SET integer_value = integer_value - 1 WHERE metric = 'preScreenSnapshots';
    END;
    CREATE TRIGGER IF NOT EXISTS wallet_metric_checkpoint_insert
    AFTER INSERT ON ingestion_checkpoints BEGIN
      UPDATE wallet_index_metrics SET integer_value = integer_value + 1 WHERE metric = 'checkpoints';
    END;
    CREATE TRIGGER IF NOT EXISTS wallet_metric_checkpoint_delete
    AFTER DELETE ON ingestion_checkpoints BEGIN
      UPDATE wallet_index_metrics SET integer_value = integer_value - 1 WHERE metric = 'checkpoints';
    END;

    CREATE TRIGGER IF NOT EXISTS wallet_metric_run_insert
    AFTER INSERT ON wallet_index_runs BEGIN
      UPDATE wallet_index_metrics SET integer_value = integer_value +
        CASE WHEN NEW.stage NOT IN ('COMPLETE', 'FAILED') THEN 1 ELSE 0 END
        WHERE metric = 'activeRuns';
    END;
    CREATE TRIGGER IF NOT EXISTS wallet_metric_run_delete
    AFTER DELETE ON wallet_index_runs BEGIN
      UPDATE wallet_index_metrics SET integer_value = integer_value -
        CASE WHEN OLD.stage NOT IN ('COMPLETE', 'FAILED') THEN 1 ELSE 0 END
        WHERE metric = 'activeRuns';
    END;
    CREATE TRIGGER IF NOT EXISTS wallet_metric_run_stage
    AFTER UPDATE OF stage ON wallet_index_runs
    WHEN OLD.stage <> NEW.stage BEGIN
      UPDATE wallet_index_metrics SET integer_value = integer_value
        + CASE WHEN NEW.stage NOT IN ('COMPLETE', 'FAILED') THEN 1 ELSE 0 END
        - CASE WHEN OLD.stage NOT IN ('COMPLETE', 'FAILED') THEN 1 ELSE 0 END
        WHERE metric = 'activeRuns';
    END;
  `);

  // v39 keyed analysis checkpoints only by their frozen dataset. v40 gives
  // each complete evaluation configuration its own versioned identity while
  // retaining dataset_digest as immutable provenance. Rebuilding the small
  // checkpoint table also replaces SQLite's old dataset uniqueness index.
  if (tableExists(db, "stock_paper_learning_checkpoints") &&
      !tableColumnNames(db, "stock_paper_learning_checkpoints").includes("evaluation_digest")) {
    db.transaction(() => {
      db.exec(`
        DROP TABLE IF EXISTS stock_paper_learning_checkpoints_v40;
        CREATE TABLE stock_paper_learning_checkpoints_v40 (
          id TEXT PRIMARY KEY,
          lane_id TEXT NOT NULL,
          dataset_digest TEXT NOT NULL,
          evaluation_digest TEXT NOT NULL,
          captured_at TEXT NOT NULL,
          cutoff_at TEXT NOT NULL,
          checkpoint_json TEXT NOT NULL,
          UNIQUE (lane_id, evaluation_digest),
          FOREIGN KEY (lane_id) REFERENCES stock_paper_lanes(id) ON DELETE CASCADE
        );
        INSERT INTO stock_paper_learning_checkpoints_v40(
          id, lane_id, dataset_digest, evaluation_digest,
          captured_at, cutoff_at, checkpoint_json
        )
        SELECT
          id,
          lane_id,
          dataset_digest,
          CASE
            WHEN json_type(checkpoint_json, '$.evaluationDigest') = 'text'
              AND length(trim(json_extract(checkpoint_json, '$.evaluationDigest'))) > 0
              THEN json_extract(checkpoint_json, '$.evaluationDigest')
            ELSE 'stock-paper-evaluation-v3:legacy:' || id
          END,
          captured_at,
          cutoff_at,
          json_set(
            checkpoint_json,
            '$.evaluationDigest',
            CASE
              WHEN json_type(checkpoint_json, '$.evaluationDigest') = 'text'
                AND length(trim(json_extract(checkpoint_json, '$.evaluationDigest'))) > 0
                THEN json_extract(checkpoint_json, '$.evaluationDigest')
              ELSE 'stock-paper-evaluation-v3:legacy:' || id
            END
          )
        FROM stock_paper_learning_checkpoints;
        DROP TABLE stock_paper_learning_checkpoints;
        ALTER TABLE stock_paper_learning_checkpoints_v40
          RENAME TO stock_paper_learning_checkpoints;
      `);
    })();
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS stock_paper_learning_checkpoint_lane_time
      ON stock_paper_learning_checkpoints(lane_id, captured_at DESC, id);
  `);

  if (version < 26) backfillCoarseWalletCandidatesV26(db);

  // CREATE TABLE IF NOT EXISTS does not add columns to a pre-v11 ledger.
  // These ALTERs are independently guarded so an interrupted migration can be
  // safely retried without rewriting the existing evidence ledgers.
  addColumnIfMissing(db, "portfolio_snapshots", "evaluation_cohort_id", "TEXT");
  addColumnIfMissing(db, "closed_trades", "evaluation_cohort_id", "TEXT");
  addColumnIfMissing(db, "indexed_transactions", "hydration_provenance", "TEXT");
  addColumnIfMissing(db, "indexed_transactions", "decoder_version", "TEXT");
  addColumnIfMissing(db, "indexed_transactions", "hydrated_at", "TEXT");

  // Older builds appended evaluation_cohort_id with ALTER TABLE. SQLite keeps
  // appended column order, while a fresh database places the provenance field
  // before the JSON payload. Rebuild both small evidence ledgers so an upgraded
  // database is structurally identical to a fresh current schema. Named-column
  // copies preserve every row and the explicit AUTOINCREMENT ids.
  const rebuildPortfolioSnapshots = JSON.stringify(tableColumnNames(db, "portfolio_snapshots")) !==
    JSON.stringify(["id", "mode", "captured_at", "evaluation_cohort_id", "snapshot_json"]);
  const rebuildClosedTrades = JSON.stringify(tableColumnNames(db, "closed_trades")) !==
    JSON.stringify(["id", "mode", "evaluation_cohort_id", "trade_json", "closed_at"]);
  if (rebuildPortfolioSnapshots || rebuildClosedTrades) {
    db.transaction(() => {
      if (rebuildPortfolioSnapshots) {
        db.exec(`
          DROP TABLE IF EXISTS portfolio_snapshots_v21;
          CREATE TABLE portfolio_snapshots_v21 (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            mode TEXT NOT NULL,
            captured_at TEXT NOT NULL,
            evaluation_cohort_id TEXT,
            snapshot_json TEXT NOT NULL
          );
          INSERT INTO portfolio_snapshots_v21(
            id, mode, captured_at, evaluation_cohort_id, snapshot_json
          )
          SELECT id, mode, captured_at, evaluation_cohort_id, snapshot_json
          FROM portfolio_snapshots;
          DROP TABLE portfolio_snapshots;
          ALTER TABLE portfolio_snapshots_v21 RENAME TO portfolio_snapshots;
        `);
      }
      if (rebuildClosedTrades) {
        db.exec(`
          DROP TABLE IF EXISTS closed_trades_v21;
          CREATE TABLE closed_trades_v21 (
            id TEXT PRIMARY KEY,
            mode TEXT NOT NULL,
            evaluation_cohort_id TEXT,
            trade_json TEXT NOT NULL,
            closed_at TEXT NOT NULL
          );
          INSERT INTO closed_trades_v21(
            id, mode, evaluation_cohort_id, trade_json, closed_at
          )
          SELECT id, mode, evaluation_cohort_id, trade_json, closed_at
          FROM closed_trades;
          DROP TABLE closed_trades;
          ALTER TABLE closed_trades_v21 RENAME TO closed_trades;
        `);
      }
    })();
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS portfolio_mode_time
      ON portfolio_snapshots(mode, captured_at DESC);
    CREATE INDEX IF NOT EXISTS portfolio_evaluation_time
      ON portfolio_snapshots(evaluation_cohort_id, captured_at);
    CREATE INDEX IF NOT EXISTS closed_trades_evaluation_time
      ON closed_trades(evaluation_cohort_id, closed_at);

    -- Existing SOL-legged swaps without a local historical mark enter the
    -- durable reprice queue. The worker advances each row independently, so a
    -- process restart never converts missing coverage into a priced result.
    INSERT OR IGNORE INTO indexed_swap_reprice_queue(
      swap_id, status, attempts, available_at, last_error, updated_at
    )
    SELECT id, 'PENDING', 0, indexed_at, NULL, indexed_at
    FROM indexed_spot_swaps
    WHERE base_mint = 'So11111111111111111111111111111111111111112'
      AND (
        json_type(swap_json, '$.priceUsd') IS NULL
        OR json_extract(swap_json, '$.priceUsd') <= 0
      );

    -- Recover exact cohort membership for any pre-v19 deep-history source row
    -- whose metadata still names its frozen cohort. Rows without that durable
    -- provenance remain absent and therefore fail closed instead of borrowing
    -- signatures from a different generation.
    INSERT OR IGNORE INTO wallet_deep_history_signatures(
      cohort_id, generation_id, wallet, signature, block_time, discovered_at
    )
    SELECT
      json_extract(source.metadata_json, '$.cohortId'),
      cohort.generation_id,
      source.wallet,
      source.signature,
      queue.block_time,
      source.first_seen_at
    FROM index_signature_sources source
    JOIN index_signature_queue queue ON queue.signature = source.signature
    JOIN wallet_deep_history_cohorts cohort
      ON cohort.id = json_extract(source.metadata_json, '$.cohortId')
    WHERE source.source = 'helius-wallet-deep-history'
      AND source.wallet <> ''
      AND json_type(source.metadata_json, '$.cohortId') = 'text';
  `);

  // Preserve historical decisions in the scalar-only operator ledger without
  // copying provider payloads or transaction bytes out of their source tables.
  db.exec(`
    INSERT OR IGNORE INTO signal_outcomes(
      idempotency_key, source_signature, source_wallet, mint, action, mode,
      status, reason_code, reason, source_block_time, observed_at, updated_at,
      decision_code, execution_id, target_signature, position_value_usd,
      price_impact_percent, actual_fees_usd, implementation_shortfall_percent
    )
    SELECT
      decision.idempotency_key,
      decision.source_signature,
      decision.source_wallet,
      json_extract(decision.intent_json, '$.sourceSwap.targetMint'),
      CASE json_extract(decision.intent_json, '$.side') WHEN 'SELL' THEN 'SELL' ELSE 'BUY' END,
      CASE json_extract(execution.execution_json, '$.mode') WHEN 'LIVE' THEN 'LIVE' ELSE 'PAPER' END,
      CASE
        WHEN json_extract(execution.execution_json, '$.status') = 'CONFIRMED'
          AND json_extract(execution.execution_json, '$.mode') = 'PAPER' THEN 'SIMULATED'
        WHEN json_extract(execution.execution_json, '$.status') IN (
          'AWAITING_APPROVAL', 'APPROVED', 'SUBMITTED', 'SUBMITTED_UNRESOLVED', 'CONFIRMED', 'FAILED'
        ) THEN json_extract(execution.execution_json, '$.status')
        WHEN json_extract(execution.execution_json, '$.status') IN ('REJECTED', 'SKIPPED') THEN 'REJECTED'
        WHEN json_extract(decision.decision_json, '$.allowed') = 1 THEN 'QUEUED'
        ELSE 'REJECTED'
      END,
      CASE
        WHEN json_extract(execution.execution_json, '$.status') = 'CONFIRMED'
          AND json_extract(execution.execution_json, '$.mode') = 'PAPER' THEN 'PAPER_SIMULATION'
        WHEN json_extract(execution.execution_json, '$.status') = 'AWAITING_APPROVAL' THEN 'LIVE_APPROVAL_REQUIRED'
        WHEN json_extract(execution.execution_json, '$.status') = 'APPROVED' THEN 'LIVE_APPROVED'
        WHEN json_extract(execution.execution_json, '$.status') = 'SUBMITTED' THEN 'LIVE_SUBMITTED'
        WHEN json_extract(execution.execution_json, '$.status') = 'SUBMITTED_UNRESOLVED' THEN 'SUBMISSION_UNRESOLVED'
        WHEN json_extract(execution.execution_json, '$.status') = 'CONFIRMED' THEN 'LIVE_CONFIRMED'
        WHEN json_extract(execution.execution_json, '$.status') = 'FAILED' THEN 'EXECUTION_FAILED'
        WHEN json_extract(execution.execution_json, '$.status') = 'REJECTED' THEN 'USER_REJECTED'
        WHEN json_extract(decision.decision_json, '$.allowed') = 1 THEN 'RISK_ALLOWED'
        ELSE 'RISK_REJECTED'
      END,
      substr(COALESCE(
        json_extract(execution.execution_json, '$.failureReason'),
        json_extract(decision.decision_json, '$.reasons[0]'),
        CASE WHEN json_extract(decision.decision_json, '$.allowed') = 1
          THEN 'Risk checks allowed this source action.' ELSE 'Risk checks rejected this source action.' END
      ), 1, 1000),
      json_extract(decision.intent_json, '$.sourceSwap.blockTime'),
      json_extract(decision.intent_json, '$.sourceSwap.detectedAt'),
      COALESCE(json_extract(execution.execution_json, '$.updatedAt'), decision.created_at),
      json_extract(decision.decision_json, '$.code'),
      json_extract(execution.execution_json, '$.id'),
      json_extract(execution.execution_json, '$.targetSignature'),
      json_extract(decision.intent_json, '$.inputAmountUsd'),
      json_extract(execution.execution_json, '$.quote.priceImpactPercent'),
      json_extract(execution.execution_json, '$.actualFeesUsd'),
      json_extract(execution.execution_json, '$.implementationShortfallPercent')
    FROM signal_decisions AS decision
    LEFT JOIN executions AS execution ON execution.idempotency_key = decision.idempotency_key;
  `);

  ensureStockV41EvidenceActivationMarker(db);
  if (version < 26) {
    // Keep the v26 keyset cursor until the schema-version write commits with
    // its cleanup. If the process stops after the final backfill batch but
    // before this boundary, the next launch resumes at the stored high-water
    // mark instead of replaying and double-counting candidate activity.
    db.transaction(() => {
      db.pragma(`user_version = ${COPYLAB_SCHEMA_VERSION}`);
      db.prepare("DELETE FROM settings WHERE key = ?").run(COARSE_CANDIDATE_MIGRATION_KEY);
    })();
  } else {
    db.pragma(`user_version = ${COPYLAB_SCHEMA_VERSION}`);
  }
}

export function openDatabase(databasePath?: string): CopyLabDatabase {
  const requested = databasePath ?? process.env.COPYLAB_DB_PATH ?? resolve(process.cwd(), "data", "copylab.db");
  const resolved = requested === ":memory:" ? requested : resolve(requested);
  if (resolved !== ":memory:") mkdirSync(dirname(resolved), { recursive: true });
  const db = new Database(resolved);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  return db;
}
