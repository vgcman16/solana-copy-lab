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
import {
  LEARNING_SCHEMA_VERSION,
  openLearningDatabase
} from "./learning-database.js";

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

interface VerifyLearningDatabaseOptions {
  requireCurrentSchema?: boolean;
}

const MINIMUM_RESTORABLE_LEARNING_SCHEMA_VERSION = 3;

function absolutePath(value: string, label: string): string {
  if (!value.trim() || !isAbsolute(value)) throw new Error(`${label} must be an absolute path.`);
  return resolve(value);
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

function sortedColumns(columns: readonly SchemaColumn[]): SchemaColumn[] {
  return [...columns].sort((left, right) => left.name.localeCompare(right.name));
}

function missingNames(required: readonly string[], actual: readonly string[]): string[] {
  const names = new Set(actual);
  return required.filter((name) => !names.has(name));
}

function unexpectedNames(required: readonly string[], actual: readonly string[]): string[] {
  const names = new Set(required);
  return actual.filter((name) => !names.has(name));
}

function assertSupportedSchema(
  db: Database.Database,
  userVersion: number,
  requireCurrentSchema: boolean
): void {
  if (!Number.isSafeInteger(userVersion) || userVersion < MINIMUM_RESTORABLE_LEARNING_SCHEMA_VERSION) {
    throw new Error(
      `Learning backup schema ${String(userVersion)} predates the oldest supported fail-closed schema ` +
      `${MINIMUM_RESTORABLE_LEARNING_SCHEMA_VERSION}.`
    );
  }
  if (userVersion > LEARNING_SCHEMA_VERSION) {
    throw new Error(
      `Learning backup schema ${String(userVersion)} is newer than supported schema ${LEARNING_SCHEMA_VERSION}.`
    );
  }
  if (requireCurrentSchema && userVersion !== LEARNING_SCHEMA_VERSION) {
    throw new Error(
      `The staged learning schema ${String(userVersion)} was not migrated to required schema ` +
      `${LEARNING_SCHEMA_VERSION}.`
    );
  }

  const reference = openLearningDatabase(":memory:");
  try {
    const mismatches: string[] = [];
    const requiredTables = schemaObjectNames(reference, "table");
    const actualTables = schemaObjectNames(db, "table");
    for (const table of missingNames(requiredTables, actualTables)) mismatches.push(`missing table ${table}`);
    if (requireCurrentSchema) {
      for (const table of unexpectedNames(requiredTables, actualTables)) {
        mismatches.push(`unexpected table ${table}`);
      }
    }
    for (const table of requiredTables.filter((name) => actualTables.includes(name))) {
      const actual = tableColumns(db, table);
      const expected = tableColumns(reference, table);
      // The only supported legacy variance is physical column order. v2
      // appended execution_tier with ALTER TABLE, while fresh v3 ledgers
      // created it in canonical position. All column semantics must still
      // match before a v3 backup is admitted to disposable staging.
      const comparableActual = requireCurrentSchema ? actual : sortedColumns(actual);
      const comparableExpected = requireCurrentSchema ? expected : sortedColumns(expected);
      if (JSON.stringify(comparableActual) !== JSON.stringify(comparableExpected)) {
        mismatches.push(`column schema differs for ${table}`);
      }
      if (JSON.stringify(tableForeignKeys(db, table)) !== JSON.stringify(tableForeignKeys(reference, table))) {
        mismatches.push(`foreign-key schema differs for ${table}`);
      }
    }
    for (const type of ["index", "trigger"] as const) {
      const required = schemaObjectNames(reference, type);
      const actual = schemaObjectNames(db, type);
      const missing = missingNames(required, actual);
      if (missing.length > 0) mismatches.push(`missing ${type} objects ${missing.join(", ")}`);
      if (requireCurrentSchema) {
        const unexpected = unexpectedNames(required, actual);
        if (unexpected.length > 0) mismatches.push(`unexpected ${type} objects ${unexpected.join(", ")}`);
      }
    }
    if (mismatches.length > 0) {
      throw new Error(`The learning backup schema is incomplete: ${mismatches.join("; ")}.`);
    }
  } finally {
    reference.close();
  }
}

function removeDatabaseArtifacts(databasePath: string): void {
  rmSync(databasePath, { force: true });
  rmSync(`${databasePath}-wal`, { force: true });
  rmSync(`${databasePath}-shm`, { force: true });
}

export function verifyLearningDatabase(
  pathInput: string,
  options: VerifyLearningDatabaseOptions = {}
): {
  userVersion: number;
  quickCheck: "ok";
} {
  const path = absolutePath(pathInput, "Learning database path");
  if (!existsSync(path)) throw new Error("The learning database file does not exist.");
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const quickCheck = db.pragma("quick_check", { simple: true });
    if (quickCheck !== "ok") throw new Error("SQLite quick_check rejected the learning database.");
    const userVersion = db.pragma("user_version", { simple: true }) as number;
    assertSupportedSchema(db, userVersion, options.requireCurrentSchema ?? true);
    if ((db.pragma("foreign_key_check") as unknown[]).length > 0) {
      throw new Error("SQLite foreign_key_check rejected the learning database.");
    }
    return { userVersion, quickCheck: "ok" };
  } finally {
    db.close();
  }
}

export function restoreLearningDatabase(
  backupPathInput: string,
  targetPathInput: string,
  operationId = `${Date.now()}-${process.pid}`
): { target: string; restoredSchemaVersion: number } {
  const backupPath = absolutePath(backupPathInput, "Learning backup path");
  const targetPath = absolutePath(targetPathInput, "Learning target path");
  if (backupPath === targetPath) throw new Error("The learning backup and target database must differ.");
  if (basename(targetPath).toLowerCase() !== "learning.db") {
    throw new Error("The learning restore target must be the CopyLab learning.db file.");
  }
  if (!/^[A-Za-z0-9-]+$/u.test(operationId)) throw new Error("Learning restore operation id is invalid.");
  verifyLearningDatabase(backupPath, { requireCurrentSchema: false });
  if (existsSync(`${targetPath}-wal`) || existsSync(`${targetPath}-shm`)) {
    throw new Error("The learning database is not quiescent; stop CopyLab cleanly before restoring.");
  }

  mkdirSync(dirname(targetPath), { recursive: true });
  const stagingPath = `${targetPath}.restore-incomplete-${operationId}`;
  const previousPath = `${targetPath}.restore-previous-${operationId}`;
  removeDatabaseArtifacts(stagingPath);
  removeDatabaseArtifacts(previousPath);
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
    // immutable, and a failed migration cannot modify the current target.
    const stagingDb = openLearningDatabase(stagingPath);
    try {
      if ((stagingDb.pragma("foreign_key_check") as unknown[]).length > 0) {
        throw new Error("SQLite foreign_key_check rejected the migrated learning staging database.");
      }
      const checkpoint = stagingDb.pragma("wal_checkpoint(TRUNCATE)") as Array<{
        busy: number;
        log: number;
        checkpointed: number;
      }>;
      if (checkpoint.some((row) => row.busy !== 0 || row.log !== row.checkpointed)) {
        throw new Error("The migrated learning staging database could not be checkpointed safely.");
      }
      const journalMode = String(stagingDb.pragma("journal_mode = DELETE", { simple: true })).toLowerCase();
      if (journalMode !== "delete") {
        throw new Error("The migrated learning staging database could not leave WAL mode safely.");
      }
    } finally {
      stagingDb.close();
    }
    rmSync(`${stagingPath}-wal`, { force: true });
    rmSync(`${stagingPath}-shm`, { force: true });
    const verifiedStaging = verifyLearningDatabase(stagingPath, { requireCurrentSchema: true });
    if (existsSync(targetPath)) {
      renameSync(targetPath, previousPath);
      priorMoved = true;
    }
    renameSync(stagingPath, targetPath);
    replacementMoved = true;
    verifyLearningDatabase(targetPath, { requireCurrentSchema: true });
    if (priorMoved) removeDatabaseArtifacts(previousPath);
    return { target: targetPath, restoredSchemaVersion: verifiedStaging.userVersion };
  } catch (error) {
    if (replacementMoved && existsSync(targetPath)) rmSync(targetPath, { force: true });
    if (priorMoved && existsSync(previousPath) && !existsSync(targetPath)) {
      renameSync(previousPath, targetPath);
    }
    throw error;
  } finally {
    removeDatabaseArtifacts(stagingPath);
  }
}
