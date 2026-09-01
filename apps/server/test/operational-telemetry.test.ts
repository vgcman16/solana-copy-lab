import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CopyLabDatabase } from "../src/database.js";
import { openDatabase } from "../src/database.js";
import {
  collectOperationalTelemetry,
  type OperationalTelemetryFileSystem
} from "../src/operational-telemetry.js";
import { Repository } from "../src/repository.js";

const GIB = 1024 ** 3;
const NOW = new Date("2026-07-10T12:00:00.000Z");

function isoBefore(seconds: number): string {
  return new Date(NOW.getTime() - seconds * 1_000).toISOString();
}

function insertQueue(
  db: CopyLabDatabase,
  signature: string,
  status: "PENDING" | "RETRY" | "FAILED",
  discoveredAt: string
): void {
  db.prepare(`
    INSERT INTO index_signature_queue(
      signature, status, attempts, priority, discovered_at, available_at, updated_at
    ) VALUES (?, ?, 0, 0, ?, ?, ?)
  `).run(signature, status, discoveredAt, discoveredAt, discoveredAt);
}

function insertAudit(
  db: CopyLabDatabase,
  severity: "info" | "warning" | "critical",
  createdAt: string
): void {
  db.prepare(`
    INSERT INTO audit_events(event_type, severity, message, created_at)
    VALUES ('telemetry_test', ?, 'bounded test event', ?)
  `).run(severity, createdAt);
}

function totalChanges(db: CopyLabDatabase): number {
  return (db.prepare("SELECT total_changes() AS count").get() as { count: number }).count;
}

function seedActivePaperCohort(
  repository: Repository,
  wallets: readonly string[],
  frozenAt = isoBefore(10 * 60)
): void {
  repository.db.prepare(`
    INSERT INTO paper_evaluation_cohorts(
      id, source_cohort_id, frozen_at, initial_nav_usd, wallets_json, status, superseded_at
    ) VALUES ('paper-evaluation:telemetry', 'source-cohort', ?, 141, ?, 'ACTIVE', NULL)
  `).run(frozenAt, JSON.stringify(wallets));
}

function completeCurrentRepair(
  repository: Repository,
  wallet: string,
  frozenAt = isoBefore(10 * 60),
  completedAt = isoBefore(9 * 60)
): void {
  const seed = new Date(Date.parse(frozenAt) - 60_000).toISOString();
  repository.ensureMonitoringRepairCheckpoint(wallet, seed, seed);
  repository.startMonitoringRepair(wallet, seed, completedAt);
  repository.completeMonitoringRepair(wallet, seed, completedAt, completedAt);
}

function insertUnprocessedSource(repository: Repository, wallet: string, signature: string): void {
  repository.db.prepare(`
    INSERT INTO source_events(signature, wallet, event_json, observed_at, recovered, processed)
    VALUES (?, ?, '{}', ?, 0, 0)
  `).run(signature, wallet, isoBefore(30));
}

describe("operational telemetry", () => {
  let db: CopyLabDatabase | undefined;
  const temporaryDatabases: string[] = [];

  afterEach(() => {
    db?.close();
    db = undefined;
    for (const path of temporaryDatabases.splice(0)) {
      rmSync(path, { force: true });
      rmSync(`${path}-wal`, { force: true });
      rmSync(`${path}-shm`, { force: true });
    }
  });

  function openFileRepository(): Repository {
    const path = join(tmpdir(), `copylab-telemetry-${randomUUID()}.db`);
    temporaryDatabases.push(path);
    db = openDatabase(path);
    return new Repository(db);
  }

  it("reports source-backed storage, queue, repair, and 24-hour audit evidence without writing", () => {
    const repository = openFileRepository();
    insertQueue(repository.db, "pending", "PENDING", isoBefore(60));
    repository.db.prepare(`
      UPDATE wallet_index_metrics SET text_value = ? WHERE metric = 'newestBlockTime'
    `).run(isoBefore(30));
    repository.ensureMonitoringRepairCheckpoint("wallet-ready", isoBefore(120), isoBefore(120));
    repository.completeMonitoringRepair("wallet-ready", isoBefore(120), isoBefore(60), isoBefore(60));
    insertAudit(repository.db, "info", isoBefore(60));
    insertAudit(repository.db, "warning", isoBefore(25 * 60 * 60));

    const fileSystem: OperationalTelemetryFileSystem = {
      fileSize: (path) => path.endsWith("-wal") ? 32 * 1024 ** 2 : 2 * GIB,
      driveCapacity: () => ({ availableBytes: 500 * GIB, totalBytes: 1_000 * GIB })
    };
    const before = totalChanges(repository.db);
    const snapshot = collectOperationalTelemetry(repository, NOW, fileSystem);
    const after = totalChanges(repository.db);

    expect(after).toBe(before);
    expect(snapshot).toMatchObject({
      status: "HEALTHY",
      blocksNewEntries: false,
      blockingIssueCodes: [],
      issues: [],
      storage: {
        databaseBytes: 2 * GIB,
        walBytes: 32 * 1024 ** 2,
        pageSizeBytes: 4_096,
        driveAvailableBytes: 500 * GIB,
        driveTotalBytes: 1_000 * GIB,
        driveAvailablePercent: 50
      },
      indexQueue: {
        pending: 1,
        leased: 0,
        retry: 0,
        failed: 0,
        oldestBacklogAt: isoBefore(60),
        oldestBacklogAgeSeconds: 60,
        newestIndexedBlockAt: isoBefore(30),
        newestIndexedBlockLagSeconds: 30
      },
      monitoringRepair: {
        total: 1,
        ready: 1,
        pending: 0,
        failed: 0,
        retryDue: 0,
        latestSucceededAt: isoBefore(60)
      },
      audit: {
        windowHours: 24,
        warnings: 0,
        critical: 0
      }
    });
    expect(snapshot.storage?.allocatedPageBytes).toBe(
      (snapshot.storage?.pageCount ?? 0) * (snapshot.storage?.pageSizeBytes ?? 0)
    );

    const indexes = repository.db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'index' AND name IN (
        'audit_events_severity_time', 'index_signature_queue_status_discovered'
      ) ORDER BY name
    `).all() as Array<{ name: string }>;
    expect(indexes.map(({ name }) => name)).toEqual([
      "audit_events_severity_time",
      "index_signature_queue_status_discovered"
    ]);
  });

  it("keeps a fresh timestamp fail-closed until head coverage is continuous and fully hydrated", () => {
    const repository = openFileRepository();
    repository.db.prepare(`
      UPDATE wallet_index_metrics SET text_value = ? WHERE metric = 'newestBlockTime'
    `).run(isoBefore(30));
    repository.saveWalletIndexCheckpoint({
      pipeline: "helius-jupiter-program-index",
      partition: "program-1",
      completed: false,
      updatedAt: isoBefore(60),
      lastSignature: "bootstrap-head",
      slot: 100
    });
    const healthyHead = {
      pipeline: "helius-jupiter-program-head",
      partition: "program-1",
      completed: false,
      updatedAt: isoBefore(30),
      lastSignature: "current-head",
      slot: 110,
      metadata: { coverageStartSlot: 101, coverageEndSlot: 110 }
    } as const;
    repository.saveWalletIndexCheckpoint(healthyHead);
    const fileSystem: OperationalTelemetryFileSystem = {
      fileSize: () => 1_024,
      driveCapacity: () => ({ availableBytes: 500 * GIB, totalBytes: 1_000 * GIB })
    };

    expect(collectOperationalTelemetry(repository, NOW, fileSystem)).toMatchObject({
      blocksNewEntries: false,
      indexQueue: {
        headProgramsRequired: 1,
        headProgramsReady: 1,
        headUnprocessed: 0,
        headCatchupComplete: true
      }
    });

    repository.saveWalletIndexCheckpoint({
      ...healthyHead,
      cursor: "bootstrap-head",
      beforeSignature: "page-cursor",
      updatedAt: isoBefore(20)
    });
    expect(collectOperationalTelemetry(repository, NOW, fileSystem)).toMatchObject({
      blocksNewEntries: true,
      blockingIssueCodes: ["INDEX_HEAD_STALE"],
      indexQueue: { headProgramsReady: 0, headCatchupComplete: false }
    });

    repository.saveWalletIndexCheckpoint({ ...healthyHead, updatedAt: isoBefore(10) });
    repository.enqueueWalletIndexTransactions([{
      signature: "unhydrated-head",
      sourceAddress: "program-1",
      source: "helius-program-head",
      discoveredAt: isoBefore(10),
      slot: 111,
      blockTime: isoBefore(10)
    }]);
    expect(collectOperationalTelemetry(repository, NOW, fileSystem)).toMatchObject({
      blocksNewEntries: true,
      blockingIssueCodes: ["INDEX_HEAD_STALE"],
      indexQueue: { headProgramsReady: 1, headUnprocessed: 1, headCatchupComplete: false }
    });
  });

  it("treats global discovery lag and unrelated old-wallet work as nonblocking once all three trading heads are healthy", () => {
    const repository = openFileRepository();
    const wallets = ["leader-a", "leader-b", "leader-c"];
    seedActivePaperCohort(repository, wallets);
    for (const wallet of wallets) completeCurrentRepair(repository, wallet);
    repository.saveWalletIndexCheckpoint({
      pipeline: "helius-jupiter-program-index",
      partition: "program-1",
      completed: false,
      updatedAt: isoBefore(30),
      lastSignature: "old-global-head",
      slot: 100
    });
    repository.saveWalletIndexCheckpoint({
      pipeline: "helius-jupiter-program-head",
      partition: "program-1",
      completed: false,
      updatedAt: isoBefore(30),
      lastSignature: "partial-global-head",
      slot: 110,
      cursor: "old-global-head",
      beforeSignature: "global-page-cursor",
      metadata: { coverageStartSlot: 101, coverageEndSlot: 110 }
    });
    repository.ensureMonitoringRepairCheckpoint("retired-wallet", isoBefore(60 * 60), isoBefore(60 * 60));
    repository.failMonitoringRepair(
      "retired-wallet",
      isoBefore(60 * 60),
      isoBefore(60),
      "old wallet retry",
      isoBefore(30 * 60)
    );
    insertUnprocessedSource(repository, "retired-wallet", "old-wallet-source");

    const snapshot = collectOperationalTelemetry(repository, NOW, {
      fileSize: () => 1_024,
      driveCapacity: () => ({ availableBytes: 500 * GIB, totalBytes: 1_000 * GIB })
    }, {
      streamStatus: {
        active: true,
        connected: true,
        ready: true,
        lastMessageAt: isoBefore(30)
      }
    });

    expect(snapshot).toMatchObject({
      status: "WARNING",
      blocksNewEntries: false,
      blockingIssueCodes: [],
      tradingHead: {
        requiredWallets: 3,
        repairReadyWallets: 3,
        unprocessedSourceEvents: 0,
        streamFresh: true,
        healthy: true
      }
    });
    expect(snapshot.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "INDEX_HEAD_STALE", severity: "WARNING" }),
      expect.objectContaining({ code: "MONITORING_REPAIR_PENDING", severity: "WARNING" })
    ]));
  });

  it("fails closed for each active-wallet repair, stream, and source-processing break", () => {
    const repository = openFileRepository();
    const wallets = ["leader-a", "leader-b", "leader-c"];
    seedActivePaperCohort(repository, wallets);
    for (const wallet of wallets.slice(0, 2)) completeCurrentRepair(repository, wallet);
    const fileSystem: OperationalTelemetryFileSystem = {
      fileSize: () => 1_024,
      driveCapacity: () => ({ availableBytes: 500 * GIB, totalBytes: 1_000 * GIB })
    };
    const healthyStream = {
      streamStatus: {
        active: true,
        connected: true,
        ready: true,
        lastMessageAt: isoBefore(30)
      }
    };

    expect(collectOperationalTelemetry(repository, NOW, fileSystem, healthyStream)).toMatchObject({
      blocksNewEntries: true,
      blockingIssueCodes: expect.arrayContaining(["MONITORING_REPAIR_FAILED"]),
      tradingHead: { requiredWallets: 3, repairReadyWallets: 2, healthy: false }
    });

    completeCurrentRepair(repository, wallets[2]!);
    const third = repository.getMonitoringRepairCheckpoint(wallets[2]!)!;
    repository.failMonitoringRepair(
      wallets[2]!,
      third.cursorAt,
      isoBefore(-60),
      "active repair failed",
      isoBefore(20)
    );
    expect(collectOperationalTelemetry(repository, NOW, fileSystem, healthyStream)).toMatchObject({
      blocksNewEntries: true,
      blockingIssueCodes: expect.arrayContaining(["MONITORING_REPAIR_FAILED"])
    });

    repository.startMonitoringRepair(wallets[2]!, third.cursorAt, isoBefore(15));
    repository.completeMonitoringRepair(wallets[2]!, third.cursorAt, isoBefore(14), isoBefore(14));
    expect(collectOperationalTelemetry(repository, NOW, fileSystem, {
      streamStatus: {
        active: true,
        connected: true,
        ready: true,
        lastMessageAt: isoBefore(61)
      }
    })).toMatchObject({
      blocksNewEntries: true,
      blockingIssueCodes: expect.arrayContaining(["MONITORING_STREAM_UNHEALTHY"]),
      tradingHead: { streamFresh: false, healthy: false }
    });
    expect(collectOperationalTelemetry(repository, NOW, fileSystem, {
      streamStatus: {
        active: true,
        connected: false,
        ready: false,
        lastMessageAt: isoBefore(10)
      }
    })).toMatchObject({
      blocksNewEntries: true,
      blockingIssueCodes: expect.arrayContaining(["MONITORING_STREAM_UNHEALTHY"]),
      tradingHead: { streamConnected: false, healthy: false }
    });

    insertUnprocessedSource(repository, wallets[0]!, "active-wallet-source");
    expect(collectOperationalTelemetry(repository, NOW, fileSystem, healthyStream)).toMatchObject({
      blocksNewEntries: true,
      blockingIssueCodes: expect.arrayContaining(["MONITORING_SOURCE_BACKLOG"]),
      tradingHead: { unprocessedSourceEvents: 1, healthy: false }
    });
  });

  it("marks durable failures, stale progress, low disk, and recent audit alerts critical", () => {
    const repository = openFileRepository();
    insertQueue(repository.db, "retry", "RETRY", isoBefore(30 * 60));
    insertQueue(repository.db, "failed", "FAILED", isoBefore(2 * 60 * 60));
    repository.db.prepare(`
      UPDATE wallet_index_metrics SET text_value = ? WHERE metric = 'newestBlockTime'
    `).run(isoBefore(60 * 60));
    repository.ensureMonitoringRepairCheckpoint("wallet-failed", isoBefore(2 * 60 * 60), isoBefore(30 * 60));
    repository.failMonitoringRepair(
      "wallet-failed",
      isoBefore(2 * 60 * 60),
      isoBefore(60),
      "secret endpoint details that must never reach telemetry",
      isoBefore(30 * 60)
    );
    insertAudit(repository.db, "warning", isoBefore(10 * 60));
    insertAudit(repository.db, "critical", isoBefore(5 * 60));
    const snapshot = collectOperationalTelemetry(repository, NOW, {
      fileSize: (path) => path.endsWith("-wal") ? 2 * GIB : 4 * GIB,
      driveCapacity: () => ({ availableBytes: 5 * GIB, totalBytes: 1_000 * GIB })
    });

    expect(snapshot.status).toBe("CRITICAL");
    expect(snapshot.blocksNewEntries).toBe(true);
    expect(snapshot.blockingIssueCodes).toEqual(expect.arrayContaining([
      "DRIVE_CAPACITY_CRITICAL",
      "INDEX_HEAD_STALE",
      "MONITORING_REPAIR_FAILED",
      "RECENT_CRITICAL_AUDIT"
    ]));
    expect(snapshot.indexQueue).toMatchObject({ retry: 1, failed: 1, oldestBacklogAgeSeconds: 1_800 });
    expect(snapshot.monitoringRepair).toMatchObject({ failed: 1, retryDue: 1, oldestUnreadyAgeSeconds: 1_800 });
    expect(snapshot.audit).toMatchObject({ warnings: 1, critical: 1 });
    expect(snapshot.issues.map(({ code }) => code)).toEqual(expect.arrayContaining([
      "DRIVE_CAPACITY_CRITICAL",
      "WAL_LARGE",
      "INDEX_QUEUE_FAILED",
      "INDEX_BACKLOG_AGING",
      "INDEX_RETRY_PENDING",
      "INDEX_HEAD_STALE",
      "MONITORING_REPAIR_FAILED",
      "RECENT_CRITICAL_AUDIT",
      "RECENT_WARNING_AUDIT"
    ]));
    expect(JSON.stringify(snapshot)).not.toContain("secret endpoint");
  });

  it("downgrades the legacy expected shutdown-supersession audit without hiding real cleanup failures", () => {
    const repository = openFileRepository();
    repository.db.prepare(`
      INSERT INTO audit_events(event_type, severity, message, details_json, created_at)
      VALUES ('runtime_stop_cleanup_failed', 'critical', 'legacy expected stop', ?, ?)
    `).run(JSON.stringify({
      failures: [{
        stage: "provider_work",
        error: "Provider-owned work was superseded by a credential or profile transition."
      }]
    }), isoBefore(5 * 60));
    const healthyCapacity: OperationalTelemetryFileSystem = {
      fileSize: () => 1024,
      driveCapacity: () => ({ availableBytes: 500 * GIB, totalBytes: 1_000 * GIB })
    };

    const legacy = collectOperationalTelemetry(repository, NOW, healthyCapacity);
    expect(legacy.audit).toMatchObject({ warnings: 1, critical: 0 });
    expect(legacy.blockingIssueCodes).not.toContain("RECENT_CRITICAL_AUDIT");

    repository.db.prepare(`
      INSERT INTO audit_events(event_type, severity, message, details_json, created_at)
      VALUES ('runtime_stop_cleanup_failed', 'critical', 'real failed stop', ?, ?)
    `).run(JSON.stringify({
      failures: [{ stage: "wallet_indexer", error: "real indexer failure" }]
    }), isoBefore(4 * 60));
    const realFailure = collectOperationalTelemetry(repository, NOW, healthyCapacity);
    expect(realFailure.audit).toMatchObject({ warnings: 1, critical: 1 });
    expect(realFailure.blockingIssueCodes).toContain("RECENT_CRITICAL_AUDIT");
  });

  it("fails closed with a redacted state when local capacity cannot be verified", () => {
    const repository = openFileRepository();
    const snapshot = collectOperationalTelemetry(repository, NOW, {
      fileSize: () => {
        throw new Error("https://user:password@rpc.example/?api-key=super-secret");
      },
      driveCapacity: () => ({ availableBytes: 500 * GIB, totalBytes: 1_000 * GIB })
    });

    expect(snapshot).toEqual({
      status: "UNAVAILABLE",
      capturedAt: NOW.toISOString(),
      blocksNewEntries: true,
      blockingIssueCodes: ["TELEMETRY_UNAVAILABLE"],
      issues: [{
        severity: "CRITICAL",
        code: "TELEMETRY_UNAVAILABLE",
        message: "Local operational telemetry could not be verified."
      }]
    });
    expect(JSON.stringify(snapshot)).not.toContain("super-secret");
    expect(snapshot.storage).toBeUndefined();
  });
});
