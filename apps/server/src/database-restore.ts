import Database from "better-sqlite3";
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync
} from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { COPYLAB_SCHEMA_VERSION, openDatabase } from "./database.js";

// Restore is intentionally stricter than an in-place application upgrade. An
// absent legacy table cannot be distinguished from a ledger that lost that
// table, and the idempotent schema creator would otherwise replace it with an
// empty table. Only versions with an explicit, reviewed manifest are accepted.
export const MINIMUM_RESTORABLE_SCHEMA_VERSION = 18;

const SCHEMA_18_REQUIRED_TABLES = [
  "audit_events",
  "closed_trades",
  "cohorts",
  "emergency_exit_operations",
  "emergency_liquidations",
  "execution_applications",
  "executions",
  "index_signature_queue",
  "index_signature_sources",
  "indexed_spot_swaps",
  "indexed_transactions",
  "ingestion_checkpoints",
  "leader_lots",
  "monitoring_repair_checkpoints",
  "paper_evaluation_cohorts",
  "paper_runtime_heartbeats",
  "portfolio_snapshots",
  "positions",
  "provider_health",
  "provider_parity_observation_bindings",
  "provider_parity_observations",
  "provider_parity_proof_epochs",
  "provider_usage",
  "quotes",
  "secrets",
  "self_hosted_paper_soak_epochs",
  "self_hosted_paper_soak_heartbeats",
  "settings",
  "signal_decisions",
  "sol_price_snapshots",
  "source_events",
  "wallet_activity_samples",
  "wallet_candidates",
  "wallet_deep_history_cohorts",
  "wallet_deep_history_targets",
  "wallet_history_reconciliations",
  "wallet_identity_first_pools",
  "wallet_identity_transaction_evidence",
  "wallet_index",
  "wallet_index_dirty",
  "wallet_index_metrics",
  "wallet_index_runs",
  "wallet_prescreen_snapshots",
  "wallet_research_handoffs",
  "wallet_scores"
] as const;

const REQUIRED_TABLE_ADDITIONS = [
  {
    version: 19,
    tables: [
      "indexed_swap_reprice_queue",
      "wallet_deep_history_evidence",
      "wallet_deep_history_generations",
      "wallet_deep_history_signatures"
    ]
  },
  { version: 20, tables: ["provider_parity_baseline_runs"] },
  { version: 21, tables: ["signal_outcomes"] },
  {
    version: 22,
    tables: [
      "wallet_deep_history_managed_cohort_screenings",
      "wallet_deep_history_managed_generation_screenings",
      "wallet_deep_history_target_dispositions"
    ]
  },
  {
    version: 23,
    tables: [
      "parsed_block_repair_items",
      "parsed_block_repair_manifests"
    ]
  },
  {
    version: 26,
    tables: [
      "coarse_wallet_candidate_activity",
      "coarse_wallet_candidate_transactions"
    ]
  },
  {
    version: 28,
    tables: [
      "managed_recovery_preflight_authorizations",
      "managed_recovery_preflights"
    ]
  },
  {
    version: 29,
    tables: [
      "research_paper_accounts",
      "research_paper_events",
      "research_paper_lanes",
      "research_paper_positions"
    ]
  },
  {
    version: 30,
    tables: [
      "research_paper_monitoring_checkpoints",
      "research_paper_watchlist_members",
      "research_paper_watchlist_positions",
      "research_paper_watchlist_runs"
    ]
  },
  {
    version: 34,
    tables: [
      "autonomous_paper_replay_episodes",
      "autonomous_paper_replay_observations",
      "autonomous_paper_replay_reports",
      "autonomous_paper_replay_variant_results"
    ]
  },
  { version: 36, tables: ["learning_outbox"] },
  {
    version: 37,
    tables: [
      "stock_paper_accounts",
      "stock_paper_bars",
      "stock_paper_candidates",
      "stock_paper_equity_points",
      "stock_paper_lanes",
      "stock_paper_positions",
      "stock_paper_signals",
      "stock_paper_trades"
    ]
  },
  {
    version: 38,
    tables: [
      "stock_paper_news_evidence",
      "stock_paper_observation_outcomes",
      "stock_paper_observations",
      "stock_paper_orders",
      "stock_paper_shadow_results"
    ]
  },
  {
    version: 39,
    tables: ["stock_paper_learning_checkpoints"]
  },
  {
    version: 41,
    tables: ["stock_paper_order_events"]
  },
  {
    version: 44,
    tables: [
      "marketplace_enrollment_events",
      "marketplace_enrollments",
      "marketplace_performance_snapshots",
      "marketplace_paper_mirror_fills",
      "marketplace_paper_positions",
      "marketplace_pilots",
      "marketplace_rebalance_previews"
    ]
  },
  {
    version: 45,
    tables: ["marketplace_paper_position_marks"]
  }
] as const;

function requiredTablesForSchema(userVersion: number): string[] {
  if (userVersion < MINIMUM_RESTORABLE_SCHEMA_VERSION) {
    throw new Error(
      `Backup schema ${userVersion} predates the oldest fail-closed restore manifest (${MINIMUM_RESTORABLE_SCHEMA_VERSION}).`
    );
  }
  return [
    ...SCHEMA_18_REQUIRED_TABLES,
    ...REQUIRED_TABLE_ADDITIONS
      .filter((entry) => userVersion >= entry.version)
      .flatMap((entry) => [...entry.tables])
  ];
}

function absolutePath(value: string, label: string): string {
  if (!value.trim() || !isAbsolute(value)) throw new Error(`${label} must be an absolute path.`);
  return resolve(value);
}

interface VerifyCopyLabDatabaseOptions {
  requireCurrentSchema?: boolean;
}

interface SchemaColumn {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

interface SchemaForeignKey {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string;
  on_update: string;
  on_delete: string;
  match: string;
}

function schemaObjectNames(db: Database.Database, type: "table" | "index" | "trigger"): string[] {
  return (db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = ? AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all(type) as Array<{ name: string }>).map((row) => row.name);
}

function tableColumns(db: Database.Database, table: string): SchemaColumn[] {
  return (db.pragma(`table_info(${JSON.stringify(table)})`) as SchemaColumn[]).map((column) => ({
    name: column.name,
    type: column.type.toUpperCase(),
    notnull: column.notnull,
    dflt_value: column.dflt_value,
    pk: column.pk
  }));
}

function tableForeignKeys(db: Database.Database, table: string): SchemaForeignKey[] {
  return (db.pragma(`foreign_key_list(${JSON.stringify(table)})`) as SchemaForeignKey[]).map((foreignKey) => ({
    id: foreignKey.id,
    seq: foreignKey.seq,
    table: foreignKey.table,
    from: foreignKey.from,
    to: foreignKey.to,
    on_update: foreignKey.on_update,
    on_delete: foreignKey.on_delete,
    match: foreignKey.match
  }));
}

function assertCurrentSchema(db: Database.Database, userVersion: number): void {
  if (userVersion !== COPYLAB_SCHEMA_VERSION) {
    throw new Error(
      `The staged ledger schema ${userVersion} was not migrated to required schema ${COPYLAB_SCHEMA_VERSION}.`
    );
  }
  const reference = openDatabase(":memory:");
  try {
    const schemaMismatches: string[] = [];
    for (const table of schemaObjectNames(reference, "table")) {
      const actual = tableColumns(db, table);
      if (actual.length === 0) {
        schemaMismatches.push(`missing table ${table}`);
        continue;
      }
      if (JSON.stringify(actual) !== JSON.stringify(tableColumns(reference, table))) {
        schemaMismatches.push(`column schema differs for ${table}`);
      }
      if (JSON.stringify(tableForeignKeys(db, table)) !== JSON.stringify(tableForeignKeys(reference, table))) {
        schemaMismatches.push(`foreign-key schema differs for ${table}`);
      }
    }
    for (const type of ["index", "trigger"] as const) {
      const required = schemaObjectNames(reference, type);
      const actual = new Set(schemaObjectNames(db, type));
      const missing = required.filter((name) => !actual.has(name));
      if (missing.length > 0) {
        schemaMismatches.push(`missing ${type} objects ${missing.join(", ")}`);
      }
    }
    if (schemaMismatches.length > 0) {
      throw new Error(`The backup does not match the current CopyLab schema: ${schemaMismatches.join("; ")}.`);
    }
    const foreignKeyFailures = db.pragma("foreign_key_check") as unknown[];
    if (foreignKeyFailures.length > 0) {
      throw new Error("SQLite foreign_key_check rejected the CopyLab backup.");
    }
  } finally {
    reference.close();
  }
}

export function verifyCopyLabDatabase(
  path: string,
  options: VerifyCopyLabDatabaseOptions = {}
): { userVersion: number; quickCheck: "ok" } {
  const databasePath = absolutePath(path, "Database path");
  if (!existsSync(databasePath)) throw new Error("The database file does not exist.");
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const quickCheck = db.pragma("quick_check", { simple: true });
    if (quickCheck !== "ok") throw new Error("SQLite quick_check rejected the database.");
    const userVersion = db.pragma("user_version", { simple: true });
    if (!Number.isSafeInteger(userVersion) || (userVersion as number) < 1) {
      throw new Error("The backup has no supported CopyLab schema version.");
    }
    if ((userVersion as number) > COPYLAB_SCHEMA_VERSION) {
      throw new Error(
        `The backup schema ${String(userVersion)} is newer than this CopyLab build supports (${COPYLAB_SCHEMA_VERSION}).`
      );
    }
    const tables = new Set((db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table'
    `).all() as Array<{ name: string }>).map((row) => row.name));
    const missing = requiredTablesForSchema(userVersion as number).filter((table) => !tables.has(table));
    if (missing.length > 0) {
      throw new Error(
        `The schema-${String(userVersion)} backup is incomplete and is missing required CopyLab tables: ${missing.join(", ")}.`
      );
    }
    if (options.requireCurrentSchema ?? true) assertCurrentSchema(db, userVersion as number);
    return { userVersion: userVersion as number, quickCheck: "ok" };
  } finally {
    db.close();
  }
}

export function restoreCopyLabDatabase(
  backupPathInput: string,
  targetPathInput: string,
  operationId = `${Date.now()}-${process.pid}`
): { target: string; restoredSchemaVersion: number } {
  const backupPath = absolutePath(backupPathInput, "Backup path");
  const targetPath = absolutePath(targetPathInput, "Target path");
  if (backupPath === targetPath) throw new Error("The backup and target database must differ.");
  if (basename(targetPath).toLowerCase() !== "copylab.db") {
    throw new Error("The restore target must be the CopyLab copylab.db file.");
  }
  if (!/^[A-Za-z0-9-]+$/u.test(operationId)) throw new Error("Restore operation id is invalid.");
  verifyCopyLabDatabase(backupPath, { requireCurrentSchema: false });
  const walPath = `${targetPath}-wal`;
  const shmPath = `${targetPath}-shm`;
  if (existsSync(walPath) || existsSync(shmPath)) {
    throw new Error("The target database is not quiescent; stop CopyLab cleanly before restoring.");
  }

  mkdirSync(dirname(targetPath), { recursive: true });
  const stagingPath = `${targetPath}.restore-incomplete-${operationId}`;
  const previousPath = `${targetPath}.restore-previous-${operationId}`;
  rmSync(stagingPath, { force: true });
  rmSync(previousPath, { force: true });
  let priorMoved = false;
  let replacementMoved = false;
  try {
    copyFileSync(backupPath, stagingPath);
    const handle = openSync(stagingPath, "r+");
    try {
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    // Upgrade only the disposable staging copy. The source backup remains
    // immutable, and a failed migration can never touch the current ledger.
    const stagingDb = openDatabase(stagingPath);
    try {
      stagingDb.pragma("wal_checkpoint(TRUNCATE)");
    } finally {
      stagingDb.close();
    }
    rmSync(`${stagingPath}-wal`, { force: true });
    rmSync(`${stagingPath}-shm`, { force: true });
    const verifiedStaging = verifyCopyLabDatabase(stagingPath, { requireCurrentSchema: true });
    if (existsSync(targetPath)) {
      renameSync(targetPath, previousPath);
      priorMoved = true;
    }
    renameSync(stagingPath, targetPath);
    replacementMoved = true;
    verifyCopyLabDatabase(targetPath, { requireCurrentSchema: true });
    if (priorMoved) rmSync(previousPath, { force: true });
    return { target: targetPath, restoredSchemaVersion: verifiedStaging.userVersion };
  } catch (error) {
    if (replacementMoved && existsSync(targetPath)) rmSync(targetPath, { force: true });
    if (priorMoved && existsSync(previousPath) && !existsSync(targetPath)) {
      renameSync(previousPath, targetPath);
    }
    throw error;
  } finally {
    rmSync(stagingPath, { force: true });
    rmSync(`${stagingPath}-wal`, { force: true });
    rmSync(`${stagingPath}-shm`, { force: true });
  }
}
