import {
  DEFAULT_LOCAL_BACKUP_RETENTION_COUNT,
  retainVerifiedCopyLabBackup
} from "./backup-retention.js";

const backupDirectory = process.argv[2] ?? "";
const keeperDatabase = process.argv[3] ?? "";
const verifiedSha256 = process.argv[4] ?? "";
const keeperLearningDatabase = process.argv[5] ?? "";
const verifiedLearningSha256 = process.argv[6] ?? "";
const keeperManifest = process.argv[7] ?? "";
const retentionCount = Number(process.argv[8] ?? DEFAULT_LOCAL_BACKUP_RETENTION_COUNT);

const result = retainVerifiedCopyLabBackup({
  backupDirectory,
  keeperDatabase,
  verifiedSha256,
  keeperLearningDatabase,
  verifiedLearningSha256,
  keeperManifest,
  retentionCount
});

process.stdout.write(JSON.stringify({
  ok: true,
  keeperDatabase: result.keeperDatabase,
  retainedStamps: result.retainedStamps,
  deletedStamps: result.deletedStamps,
  deletedCount: result.deleted.length
}));
