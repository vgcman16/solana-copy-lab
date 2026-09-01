import { createHash } from "node:crypto";
import {
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  resolve
} from "node:path";

const MANAGED_STAMP = "(?:\\d{8}-\\d{6}|pre-restore-\\d{8}-\\d{6}-\\d{3})";
const MANAGED_DATABASE_NAME = new RegExp(`^copylab-(${MANAGED_STAMP})\\.db$`, "u");
const MANAGED_LEARNING_DATABASE_NAME = new RegExp(`^copylab-learning-(${MANAGED_STAMP})\\.db$`, "u");
const MANAGED_PAIR_MANIFEST_NAME = new RegExp(`^copylab-(${MANAGED_STAMP})\\.pair\\.json$`, "u");
const SHA256 = /^[0-9a-f]{64}$/iu;
const CHECKSUM_LINE = /^([0-9a-f]{64})\s+\*?(.+)$/iu;

export const DEFAULT_LOCAL_BACKUP_RETENTION_COUNT = 4;
const MAX_LOCAL_BACKUP_RETENTION_COUNT = 52;

export interface CopyLabBackupRetentionInput {
  backupDirectory: string;
  keeperDatabase: string;
  /** SHA-256 calculated by the caller immediately before publishing the checksum sidecar. */
  verifiedSha256: string;
  keeperLearningDatabase: string;
  /** SHA-256 calculated for the learning ledger in the same stopped-server window. */
  verifiedLearningSha256: string;
  keeperManifest: string;
  /** Number of complete local generations to retain, including the newly verified keeper. */
  retentionCount?: number;
}

export interface CopyLabBackupRetentionResult {
  keeperDatabase: string;
  keeperChecksum: string;
  keeperLearningDatabase: string;
  keeperLearningChecksum: string;
  keeperManifest: string;
  retainedStamps: string[];
  deletedStamps: string[];
  deleted: string[];
}

interface PairManifest {
  formatVersion: number;
  stamp: string;
  mainDatabase: { file: string; sha256: string };
  learningDatabase: { file: string; sha256: string };
}

interface VerifiedBackupPair {
  stamp: string;
  mainDatabase: string;
  mainChecksum: string;
  learningDatabase: string;
  learningChecksum: string;
  manifest: string;
}

function requiredAbsolutePath(value: string, label: string): string {
  if (!value.trim() || !isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path.`);
  }
  return resolve(value);
}

function comparablePath(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function requireRegularFile(path: string, label: string): void {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new Error(`${label} does not exist.`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file.`);
  }
}

function requireDirectChild(path: string, root: string, label: string): void {
  if (comparablePath(dirname(path)) !== comparablePath(root)) {
    throw new Error(`${label} must be a direct child of the backup directory.`);
  }
}

function calculateFileSha256(path: string): string {
  const digest = createHash("sha256");
  const descriptor = openSync(path, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      digest.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    closeSync(descriptor);
  }
  return digest.digest("hex");
}

function validateChecksum(
  database: string,
  expectedHash: string,
  label: string
): string {
  const checksum = `${database}.sha256`;
  requireRegularFile(database, `${label} database`);
  requireRegularFile(checksum, `${label} checksum sidecar`);
  const checksumLine = readFileSync(checksum, "ascii").trim();
  const checksumMatch = CHECKSUM_LINE.exec(checksumLine);
  if (!checksumMatch) throw new Error(`${label} checksum sidecar is malformed.`);
  if (checksumMatch[2]!.trim() !== basename(database)) {
    throw new Error(`${label} checksum sidecar names a different backup file.`);
  }
  if (checksumMatch[1]!.toLowerCase() !== expectedHash.toLowerCase()) {
    throw new Error(`${label} checksum sidecar does not contain the verified SHA-256.`);
  }
  const actualHash = calculateFileSha256(database);
  if (actualHash.toLowerCase() !== expectedHash.toLowerCase()) {
    throw new Error(`${label} database no longer matches its verified SHA-256.`);
  }
  return checksum;
}

function retentionCount(value: number | undefined): number {
  const count = value ?? DEFAULT_LOCAL_BACKUP_RETENTION_COUNT;
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_LOCAL_BACKUP_RETENTION_COUNT) {
    throw new Error(`Local backup retention count must be an integer from 1 to ${MAX_LOCAL_BACKUP_RETENTION_COUNT}.`);
  }
  return count;
}

function readPairManifest(path: string, label: string): PairManifest {
  requireRegularFile(path, label);
  try {
    return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/u, "")) as PairManifest;
  } catch {
    throw new Error(`${label} is malformed JSON.`);
  }
}

function validatePairAtManifest(
  backupDirectory: string,
  manifestPath: string
): VerifiedBackupPair {
  requireDirectChild(manifestPath, backupDirectory, "Pair manifest");
  const manifestName = basename(manifestPath);
  const manifestMatch = MANAGED_PAIR_MANIFEST_NAME.exec(manifestName);
  if (!manifestMatch) {
    throw new Error("Pair manifest name is not a managed CopyLab backup name.");
  }
  const stamp = manifestMatch[1]!;
  const mainName = `copylab-${stamp}.db`;
  const learningName = `copylab-learning-${stamp}.db`;
  const mainDatabase = resolve(join(backupDirectory, mainName));
  const learningDatabase = resolve(join(backupDirectory, learningName));
  requireDirectChild(mainDatabase, backupDirectory, "Pair database");
  requireDirectChild(learningDatabase, backupDirectory, "Pair learning database");

  const manifest = readPairManifest(manifestPath, "Pair manifest");
  const mainHash = manifest.mainDatabase?.sha256?.trim().toLowerCase();
  const learningHash = manifest.learningDatabase?.sha256?.trim().toLowerCase();
  if (
    manifest.formatVersion !== 1 ||
    manifest.stamp !== stamp ||
    manifest.mainDatabase?.file !== mainName ||
    !SHA256.test(mainHash ?? "") ||
    manifest.learningDatabase?.file !== learningName ||
    !SHA256.test(learningHash ?? "")
  ) {
    throw new Error("Pair manifest does not bind a complete managed CopyLab database pair.");
  }

  const mainChecksum = validateChecksum(mainDatabase, mainHash!, "Pair main");
  const learningChecksum = validateChecksum(learningDatabase, learningHash!, "Pair learning");
  for (const [path, label] of [
    [mainChecksum, "Pair main checksum"],
    [learningChecksum, "Pair learning checksum"]
  ] as const) {
    requireDirectChild(path, backupDirectory, label);
  }

  return {
    stamp,
    mainDatabase,
    mainChecksum,
    learningDatabase,
    learningChecksum,
    manifest: manifestPath
  };
}

function validateKeeper(input: CopyLabBackupRetentionInput): {
  backupDirectory: string;
  pair: VerifiedBackupPair;
} {
  const backupDirectory = requiredAbsolutePath(input.backupDirectory, "Backup directory");
  const keeperDatabase = requiredAbsolutePath(input.keeperDatabase, "Keeper database");
  const keeperLearningDatabase = requiredAbsolutePath(
    input.keeperLearningDatabase,
    "Keeper learning database"
  );
  const keeperManifest = requiredAbsolutePath(input.keeperManifest, "Keeper pair manifest");
  const verifiedSha256 = input.verifiedSha256.trim().toLowerCase();
  const verifiedLearningSha256 = input.verifiedLearningSha256.trim().toLowerCase();
  if (!SHA256.test(verifiedSha256)) {
    throw new Error("Verified backup SHA-256 must contain exactly 64 hexadecimal characters.");
  }
  if (!SHA256.test(verifiedLearningSha256)) {
    throw new Error("Verified learning backup SHA-256 must contain exactly 64 hexadecimal characters.");
  }

  let directoryStat;
  try {
    directoryStat = lstatSync(backupDirectory);
  } catch {
    throw new Error("Backup directory does not exist.");
  }
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error("Backup directory must be a real directory.");
  }

  for (const [path, label] of [
    [keeperDatabase, "Keeper database"],
    [keeperLearningDatabase, "Keeper learning database"],
    [keeperManifest, "Keeper pair manifest"]
  ] as const) {
    requireDirectChild(path, backupDirectory, label);
  }
  const keeperName = basename(keeperDatabase);
  const mainMatch = MANAGED_DATABASE_NAME.exec(keeperName);
  if (!mainMatch) {
    throw new Error("Keeper database name is not a managed CopyLab backup name.");
  }
  const stamp = mainMatch[1]!;
  const learningName = basename(keeperLearningDatabase);
  const learningMatch = MANAGED_LEARNING_DATABASE_NAME.exec(learningName);
  if (!learningMatch || learningMatch[1] !== stamp) {
    throw new Error("Keeper learning database does not belong to the same backup stamp.");
  }
  const manifestName = basename(keeperManifest);
  const manifestMatch = MANAGED_PAIR_MANIFEST_NAME.exec(manifestName);
  if (!manifestMatch || manifestMatch[1] !== stamp) {
    throw new Error("Keeper pair manifest does not belong to the same backup stamp.");
  }

  const pair = validatePairAtManifest(backupDirectory, keeperManifest);
  if (
    comparablePath(pair.mainDatabase) !== comparablePath(keeperDatabase) ||
    comparablePath(pair.learningDatabase) !== comparablePath(keeperLearningDatabase)
  ) {
    throw new Error("Keeper paths do not match the verified pair manifest.");
  }
  const manifest = readPairManifest(keeperManifest, "Keeper pair manifest");
  if (
    manifest.mainDatabase.sha256.toLowerCase() !== verifiedSha256 ||
    manifest.learningDatabase.sha256.toLowerCase() !== verifiedLearningSha256
  ) {
    throw new Error("Keeper pair manifest does not match the caller-verified database hashes.");
  }

  return { backupDirectory, pair };
}

function chronologyKey(stamp: string): string {
  if (stamp.startsWith("pre-restore-")) return stamp.slice("pre-restore-".length);
  return `${stamp}-000`;
}

function pairFiles(pair: VerifiedBackupPair): string[] {
  return [
    pair.mainDatabase,
    pair.mainChecksum,
    pair.learningDatabase,
    pair.learningChecksum,
    pair.manifest
  ];
}

function requireSafeDeletionPath(path: string, root: string, stamp: string): void {
  requireDirectChild(path, root, "Retention target");
  const allowedNames = new Set([
    `copylab-${stamp}.db`,
    `copylab-${stamp}.db.sha256`,
    `copylab-learning-${stamp}.db`,
    `copylab-learning-${stamp}.db.sha256`,
    `copylab-${stamp}.pair.json`
  ]);
  if (!allowedNames.has(basename(path))) {
    throw new Error("Retention target is not an exact artifact of the expired verified pair.");
  }
  requireRegularFile(path, "Retention target");
}

/**
 * Keeps the newly verified pair plus the newest additional complete,
 * manifest-bound local generations. Only exact direct-child artifacts that
 * belong to an expired complete pair can be deleted. Partial, malformed,
 * linked, nested, and unknown content is deliberately retained.
 */
export function retainVerifiedCopyLabBackup(
  input: CopyLabBackupRetentionInput
): CopyLabBackupRetentionResult {
  const keepCount = retentionCount(input.retentionCount);
  const keeper = validateKeeper(input);

  const pairs: VerifiedBackupPair[] = [];
  for (const entry of readdirSync(keeper.backupDirectory, { withFileTypes: true })) {
    if (!entry.isFile() || entry.isSymbolicLink() || !MANAGED_PAIR_MANIFEST_NAME.test(entry.name)) {
      continue;
    }
    const manifestPath = resolve(join(keeper.backupDirectory, entry.name));
    try {
      pairs.push(validatePairAtManifest(keeper.backupDirectory, manifestPath));
    } catch {
      // Retention fails closed for an older malformed or incomplete generation:
      // it remains untouched and does not displace a complete retained pair.
    }
  }

  const keeperKey = comparablePath(keeper.pair.manifest);
  const otherPairs = pairs
    .filter((pair) => comparablePath(pair.manifest) !== keeperKey)
    .sort((left, right) => {
      const chronology = chronologyKey(right.stamp).localeCompare(chronologyKey(left.stamp));
      return chronology || right.stamp.localeCompare(left.stamp);
    });
  const retainedPairs = [keeper.pair, ...otherPairs.slice(0, keepCount - 1)];
  const retainedPaths = new Set(retainedPairs.map((pair) => comparablePath(pair.manifest)));
  const expiredPairs = otherPairs.filter((pair) => !retainedPaths.has(comparablePath(pair.manifest)));

  const deletionSet: Array<{ path: string; stamp: string }> = [];
  for (const pair of expiredPairs) {
    for (const path of pairFiles(pair)) deletionSet.push({ path, stamp: pair.stamp });
  }
  deletionSet.sort((left, right) => left.path.localeCompare(right.path));

  // Validate the complete deletion set immediately before the first removal so
  // an unsafe or replaced path aborts without partially pruning a generation.
  for (const target of deletionSet) {
    requireSafeDeletionPath(target.path, keeper.backupDirectory, target.stamp);
  }
  for (const target of deletionSet) rmSync(target.path, { force: false });

  return {
    keeperDatabase: keeper.pair.mainDatabase,
    keeperChecksum: keeper.pair.mainChecksum,
    keeperLearningDatabase: keeper.pair.learningDatabase,
    keeperLearningChecksum: keeper.pair.learningChecksum,
    keeperManifest: keeper.pair.manifest,
    retainedStamps: retainedPairs.map((pair) => pair.stamp),
    deletedStamps: expiredPairs.map((pair) => pair.stamp),
    deleted: deletionSet.map((target) => target.path)
  };
}
