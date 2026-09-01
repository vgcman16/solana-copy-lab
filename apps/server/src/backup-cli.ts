import Database from "better-sqlite3";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

function requiredAbsolutePath(value: string | undefined, label: string): string {
  if (!value?.trim() || !isAbsolute(value)) throw new Error(`${label} must be an absolute path.`);
  return resolve(value);
}

const source = requiredAbsolutePath(process.argv[2], "Source database path");
const destination = requiredAbsolutePath(process.argv[3], "Backup database path");
if (source === destination) throw new Error("Backup destination must differ from the source database.");
if (!existsSync(source)) throw new Error("The CopyLab source database does not exist.");
if (existsSync(destination)) throw new Error("The backup destination already exists.");

mkdirSync(dirname(destination), { recursive: true });
const temporary = `${destination}.incomplete-${process.pid}`;
rmSync(temporary, { force: true });

const sourceDb = new Database(source, { readonly: true, fileMustExist: true });
try {
  await sourceDb.backup(temporary);
} finally {
  sourceDb.close();
}

const backupDb = new Database(temporary, { readonly: true, fileMustExist: true });
try {
  const quickCheck = backupDb.pragma("quick_check", { simple: true });
  if (quickCheck !== "ok") throw new Error("SQLite quick_check rejected the completed backup.");
} catch (error) {
  backupDb.close();
  rmSync(temporary, { force: true });
  throw error;
}
backupDb.close();
renameSync(temporary, destination);
process.stdout.write(JSON.stringify({ ok: true, destination }));
