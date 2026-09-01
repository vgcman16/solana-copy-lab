import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  DEFAULT_LOCAL_BACKUP_RETENTION_COUNT,
  retainVerifiedCopyLabBackup,
  type CopyLabBackupRetentionInput
} from "../src/backup-retention.js";

const VERIFIED_SHA = "a".repeat(64);
const VERIFIED_LEARNING_SHA = "c".repeat(64);
const OTHER_SHA = "b".repeat(64);

interface BackupPair {
  main: string;
  learning: string;
  manifest: string;
  stamp: string;
  mainSha: string;
  learningSha: string;
}

describe("CopyLab paired backup retention", () => {
  const temporaryRoots: string[] = [];

  afterEach(() => {
    for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function temporaryDirectory(prefix = "copylab-retention-"): string {
    const root = mkdtempSync(join(tmpdir(), prefix));
    temporaryRoots.push(root);
    return root;
  }

  function createBackupPair(
    directory: string,
    stamp: string,
    _mainSha = VERIFIED_SHA,
    _learningSha = VERIFIED_LEARNING_SHA
  ): BackupPair {
    const mainName = `copylab-${stamp}.db`;
    const learningName = `copylab-learning-${stamp}.db`;
    const manifestName = `copylab-${stamp}.pair.json`;
    const main = join(directory, mainName);
    const learning = join(directory, learningName);
    const manifest = join(directory, manifestName);
    const mainContents = `main:${stamp}`;
    const learningContents = `learning:${stamp}`;
    const mainSha = createHash("sha256").update(mainContents).digest("hex");
    const learningSha = createHash("sha256").update(learningContents).digest("hex");
    writeFileSync(main, mainContents);
    writeFileSync(`${main}.sha256`, `${mainSha}  ${mainName}\n`, "ascii");
    writeFileSync(learning, learningContents);
    writeFileSync(`${learning}.sha256`, `${learningSha}  ${learningName}\n`, "ascii");
    writeFileSync(manifest, JSON.stringify({
      formatVersion: 1,
      stamp,
      mainDatabase: { file: mainName, sha256: mainSha },
      learningDatabase: { file: learningName, sha256: learningSha }
    }));
    return { main, learning, manifest, stamp, mainSha, learningSha };
  }

  function input(
    directory: string,
    pair: BackupPair,
    retentionCount?: number
  ): CopyLabBackupRetentionInput {
    return {
      backupDirectory: directory,
      keeperDatabase: pair.main,
      verifiedSha256: pair.mainSha,
      keeperLearningDatabase: pair.learning,
      verifiedLearningSha256: pair.learningSha,
      keeperManifest: pair.manifest,
      ...(retentionCount === undefined ? {} : { retentionCount })
    };
  }

  function pairExists(pair: BackupPair): boolean {
    return [
      pair.main,
      `${pair.main}.sha256`,
      pair.learning,
      `${pair.learning}.sha256`,
      pair.manifest
    ].every((path) => existsSync(path));
  }

  it("defaults to four complete generations and deletes only the five files of an expired verified pair", () => {
    expect(DEFAULT_LOCAL_BACKUP_RETENTION_COUNT).toBe(4);
    const directory = temporaryDirectory();
    const keeper = createBackupPair(directory, "20260715-060621");
    const second = createBackupPair(directory, "20260714-010203", OTHER_SHA, OTHER_SHA);
    const third = createBackupPair(directory, "20260713-010203", OTHER_SHA, OTHER_SHA);
    const fourth = createBackupPair(directory, "20260712-010203", OTHER_SHA, OTHER_SHA);
    const expired = createBackupPair(directory, "20260711-010203", OTHER_SHA, OTHER_SHA);

    const untouchedNames = [
      "copylab-20260711-010203.db-wal",
      "copylab-20260711-010203.db-shm",
      "copylab-learning-20260711-010203.db-wal",
      "copylab-learning-20260711-010203.db-shm",
      "copylab-20260710-010203.db.incomplete-1234",
      "copylab-learning-20260710-010203.db.sha256.incomplete-4321",
      "copylab-20260710-010203.pair.json.incomplete-999",
      "copylab-not-a-timestamp.db",
      "notes.txt"
    ];
    for (const name of untouchedNames) writeFileSync(join(directory, name), "untouched");
    const nestedRecovery = join(directory, "CopyLab Recovery");
    mkdirSync(nestedRecovery);
    writeFileSync(join(nestedRecovery, "copylab-20200101-000000.db"), "protected nested file");

    const result = retainVerifiedCopyLabBackup(input(directory, keeper));

    expect(result.retainedStamps).toEqual([
      keeper.stamp,
      second.stamp,
      third.stamp,
      fourth.stamp
    ]);
    expect(result.deletedStamps).toEqual([expired.stamp]);
    expect(result.deleted).toHaveLength(5);
    expect(result.deleted.map((path) => basename(path)).sort()).toEqual([
      `copylab-${expired.stamp}.db`,
      `copylab-${expired.stamp}.db.sha256`,
      `copylab-${expired.stamp}.pair.json`,
      `copylab-learning-${expired.stamp}.db`,
      `copylab-learning-${expired.stamp}.db.sha256`
    ]);
    expect(pairExists(keeper)).toBe(true);
    expect(pairExists(second)).toBe(true);
    expect(pairExists(third)).toBe(true);
    expect(pairExists(fourth)).toBe(true);
    expect(pairExists(expired)).toBe(false);
    for (const name of untouchedNames) expect(existsSync(join(directory, name)), name).toBe(true);
    expect(existsSync(join(nestedRecovery, "copylab-20200101-000000.db"))).toBe(true);
  });

  it("supports an explicit retention count while always protecting the newly verified keeper", () => {
    const directory = temporaryDirectory();
    const newerThanKeeper = createBackupPair(directory, "20260716-010203", OTHER_SHA, OTHER_SHA);
    const keeper = createBackupPair(directory, "20260715-060621");
    const older = createBackupPair(directory, "20260714-010203", OTHER_SHA, OTHER_SHA);

    const result = retainVerifiedCopyLabBackup(input(directory, keeper, 2));

    expect(result.retainedStamps).toEqual([keeper.stamp, newerThanKeeper.stamp]);
    expect(result.deletedStamps).toEqual([older.stamp]);
    expect(pairExists(keeper)).toBe(true);
    expect(pairExists(newerThanKeeper)).toBe(true);
    expect(pairExists(older)).toBe(false);
  });

  it("leaves malformed and incomplete generations untouched without letting them displace complete retained pairs", () => {
    const directory = temporaryDirectory();
    const keeper = createBackupPair(directory, "20260716-010203");
    const valid2 = createBackupPair(directory, "20260715-010203", OTHER_SHA, OTHER_SHA);
    const malformed = createBackupPair(directory, "20260714-010203", OTHER_SHA, OTHER_SHA);
    writeFileSync(malformed.manifest, "not json");
    const valid3 = createBackupPair(directory, "20260713-010203", OTHER_SHA, OTHER_SHA);
    const valid4 = createBackupPair(directory, "20260712-010203", OTHER_SHA, OTHER_SHA);
    const expired = createBackupPair(directory, "20260711-010203", OTHER_SHA, OTHER_SHA);
    const partialManifest = join(directory, "copylab-20260710-010203.pair.json");
    writeFileSync(partialManifest, JSON.stringify({
      formatVersion: 1,
      stamp: "20260710-010203",
      mainDatabase: { file: "copylab-20260710-010203.db", sha256: OTHER_SHA },
      learningDatabase: { file: "copylab-learning-20260710-010203.db", sha256: OTHER_SHA }
    }));

    const result = retainVerifiedCopyLabBackup(input(directory, keeper));

    expect(result.retainedStamps).toEqual([keeper.stamp, valid2.stamp, valid3.stamp, valid4.stamp]);
    expect(result.deletedStamps).toEqual([expired.stamp]);
    expect(pairExists(malformed)).toBe(true);
    expect(existsSync(partialManifest)).toBe(true);
  });

  it("rehashes every database before a generation can count toward retention", () => {
    const directory = temporaryDirectory();
    const keeper = createBackupPair(directory, "20260716-010203");
    const corrupted = createBackupPair(directory, "20260715-010203");
    const valid = createBackupPair(directory, "20260714-010203");
    const expired = createBackupPair(directory, "20260713-010203");
    writeFileSync(corrupted.main, "silently corrupted after checksums were published");

    const result = retainVerifiedCopyLabBackup(input(directory, keeper, 2));

    expect(result.retainedStamps).toEqual([keeper.stamp, valid.stamp]);
    expect(result.deletedStamps).toEqual([expired.stamp]);
    expect(pairExists(corrupted)).toBe(true);
    expect(pairExists(valid)).toBe(true);
  });

  it("refuses a corrupted keeper before deleting any older generation", () => {
    const directory = temporaryDirectory();
    const keeper = createBackupPair(directory, "20260716-010203");
    const older = createBackupPair(directory, "20260715-010203");
    writeFileSync(keeper.learning, "silently corrupted after checksums were published");

    expect(() => retainVerifiedCopyLabBackup(input(directory, keeper, 1))).toThrow(
      /no longer matches its verified SHA-256/u
    );
    expect(pairExists(older)).toBe(true);
  });

  it("validates the keeper completely before deleting any older generation", () => {
    const mutations: Array<{ label: string; mutate: (pair: BackupPair) => void }> = [
      { label: "missing main sidecar", mutate: (pair) => rmSync(`${pair.main}.sha256`) },
      { label: "malformed main sidecar", mutate: (pair) => writeFileSync(`${pair.main}.sha256`, "bad") },
      { label: "missing learning sidecar", mutate: (pair) => rmSync(`${pair.learning}.sha256`) },
      { label: "wrong learning hash", mutate: (pair) => writeFileSync(`${pair.learning}.sha256`, `${OTHER_SHA}  ${basename(pair.learning)}\n`) },
      { label: "malformed manifest", mutate: (pair) => writeFileSync(pair.manifest, "not json") },
      { label: "mismatched manifest", mutate: (pair) => writeFileSync(pair.manifest, JSON.stringify({
        formatVersion: 1,
        stamp: pair.stamp,
        mainDatabase: { file: `copylab-${pair.stamp}.db`, sha256: pair.mainSha },
        learningDatabase: { file: "another.db", sha256: pair.learningSha }
      })) }
    ];

    for (const [index, fixture] of mutations.entries()) {
      const directory = temporaryDirectory(`copylab-retention-invalid-${index}-`);
      const keeper = createBackupPair(directory, "20260715-060621");
      fixture.mutate(keeper);
      const older = createBackupPair(directory, "20260714-010203", OTHER_SHA, OTHER_SHA);

      expect(() => retainVerifiedCopyLabBackup(input(directory, keeper)), fixture.label).toThrow();
      expect(pairExists(older), fixture.label).toBe(true);
    }
  });

  it("rejects pair members outside the directory, differing stamps, unmanaged names, and invalid counts", () => {
    const directory = temporaryDirectory();
    const outsideDirectory = temporaryDirectory("copylab-retention-outside-");
    const outside = createBackupPair(outsideDirectory, "20260715-060621");
    const local = createBackupPair(directory, "20260715-060621");
    const older = createBackupPair(directory, "20260714-010203", OTHER_SHA, OTHER_SHA);

    expect(() => retainVerifiedCopyLabBackup({
      ...input(directory, local),
      keeperDatabase: outside.main
    })).toThrow(/direct child/u);
    expect(() => retainVerifiedCopyLabBackup({
      ...input(directory, local),
      keeperLearningDatabase: older.learning
    })).toThrow(/same backup stamp/u);

    const unmanaged = join(directory, "copylab-latest.db");
    writeFileSync(unmanaged, "unmanaged");
    writeFileSync(`${unmanaged}.sha256`, `${VERIFIED_SHA}  copylab-latest.db\n`);
    expect(() => retainVerifiedCopyLabBackup({
      ...input(directory, local),
      keeperDatabase: unmanaged
    })).toThrow(/not a managed CopyLab backup name/u);
    for (const invalid of [0, 1.5, 53, Number.NaN]) {
      expect(() => retainVerifiedCopyLabBackup(input(directory, local, invalid))).toThrow(/retention count/u);
    }
    expect(pairExists(older)).toBe(true);
  });

  it("orders regular and pre-restore generations by their embedded UTC timestamp", () => {
    const directory = temporaryDirectory();
    const keeper = createBackupPair(directory, "20260716-010203");
    const newestPreRestore = createBackupPair(
      directory,
      "pre-restore-20260715-230000-500",
      OTHER_SHA,
      OTHER_SHA
    );
    const regular = createBackupPair(directory, "20260715-220000", OTHER_SHA, OTHER_SHA);
    const olderPreRestore = createBackupPair(
      directory,
      "pre-restore-20260715-210000-999",
      OTHER_SHA,
      OTHER_SHA
    );
    const expired = createBackupPair(directory, "20260715-200000", OTHER_SHA, OTHER_SHA);

    const result = retainVerifiedCopyLabBackup(input(directory, keeper));

    expect(result.retainedStamps).toEqual([
      keeper.stamp,
      newestPreRestore.stamp,
      regular.stamp,
      olderPreRestore.stamp
    ]);
    expect(result.deletedStamps).toEqual([expired.stamp]);
  });

  it("is idempotent when the retained four complete generations remain", () => {
    const directory = temporaryDirectory();
    const keeper = createBackupPair(directory, "20260715-060621");
    createBackupPair(directory, "20260714-010203", OTHER_SHA, OTHER_SHA);
    createBackupPair(directory, "20260713-010203", OTHER_SHA, OTHER_SHA);
    createBackupPair(directory, "20260712-010203", OTHER_SHA, OTHER_SHA);

    const first = retainVerifiedCopyLabBackup(input(directory, keeper));
    const second = retainVerifiedCopyLabBackup(input(directory, keeper));

    expect(first.deleted).toEqual([]);
    expect(second.deleted).toEqual([]);
    expect(second.retainedStamps).toHaveLength(4);
  });

  it("never descends into an exact-name directory when discovering a generation", () => {
    const directory = temporaryDirectory();
    const keeper = createBackupPair(directory, "20260715-060621");
    const fakeManifestDirectory = join(directory, "copylab-20260714-010203.pair.json");
    mkdirSync(fakeManifestDirectory);
    writeFileSync(join(fakeManifestDirectory, "payload"), "untouched");

    const result = retainVerifiedCopyLabBackup(input(directory, keeper, 1));

    expect(result.deleted).toEqual([]);
    expect(readdirSync(fakeManifestDirectory)).toEqual(["payload"]);
  });
});
