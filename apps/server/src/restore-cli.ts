import { restoreCopyLabDatabase } from "./database-restore.js";
import { basename } from "node:path";
import { restoreLearningDatabase } from "./learning-database-restore.js";

const backupPath = process.argv[2];
const targetPath = process.argv[3];
if (!backupPath || !targetPath) {
  throw new Error("Usage: restore-cli <absolute-backup-path> <absolute-target-path>");
}

const result = basename(targetPath).toLowerCase() === "learning.db"
  ? restoreLearningDatabase(backupPath, targetPath)
  : restoreCopyLabDatabase(backupPath, targetPath);
process.stdout.write(JSON.stringify({ ok: true, ...result }));
