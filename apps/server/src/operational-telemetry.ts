import type {
  DataProviderMode,
  OperationalAuditTelemetry,
  OperationalIndexQueueTelemetry,
  OperationalMonitoringRepairTelemetry,
  OperationalStorageTelemetry,
  OperationalTelemetryIssue,
  OperationalTelemetryIssueCode,
  OperationalTelemetrySnapshot,
  OperationalTelemetryStatus,
  OperationalTradingHeadTelemetry,
  WalletIndexQueueStatus
} from "@copylab/shared";
import { statfsSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { Repository } from "./repository.js";
import {
  WALLET_ACQUISITION_GOAL_SETTING,
  type PersistedWalletAcquisitionGoal
} from "./wallet-acquisition-controller.js";

const AUDIT_WINDOW_HOURS = 24 as const;
const GIB = 1024 ** 3;
const PROGRAM_INDEX_PIPELINE = "helius-jupiter-program-index";
const PROGRAM_HEAD_PIPELINE = "helius-jupiter-program-head";
const HEAD_FRESHNESS_SECONDS = 15 * 60;
const WALLET_STREAM_FRESHNESS_SECONDS = 60;
const MANAGED_WALLET_INDEX_CAP = 25_000;

export interface OperationalTelemetryRuntimeState {
  /** Active credential-vault profile. Omission is fail-closed. */
  dataProviderMode?: DataProviderMode;
  streamStatus?: {
    active: boolean;
    connected: boolean;
    ready: boolean;
    lastMessageAt?: string;
  };
}

export interface OperationalTelemetryFileSystem {
  fileSize(path: string, missingAllowed?: boolean): number;
  driveCapacity(path: string): { availableBytes: number; totalBytes: number };
}

const localFileSystem: OperationalTelemetryFileSystem = {
  fileSize(path, missingAllowed = false) {
    try {
      return statSync(path).size;
    } catch (error) {
      if (missingAllowed && (error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
  },
  driveCapacity(path) {
    const stats = statfsSync(path, { bigint: true });
    return {
      availableBytes: Number(stats.bavail * stats.bsize),
      totalBytes: Number(stats.blocks * stats.bsize)
    };
  }
};

function safeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function parseTime(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`${label} is invalid`);
  return timestamp;
}

function ageSeconds(now: Date, value: string, label: string): number {
  const timestamp = parseTime(value, label);
  if (timestamp === undefined) throw new Error(`${label} is unavailable`);
  if (timestamp > now.getTime() + 60_000) throw new Error(`${label} is in the future`);
  return Math.max(0, Math.floor((now.getTime() - timestamp) / 1_000));
}

function oldestQueueTime(repository: Repository): string | undefined {
  const statuses: WalletIndexQueueStatus[] = ["PENDING", "RETRY", "LEASED"];
  const rows = statuses.flatMap((status) => {
    const row = repository.db.prepare(`
      SELECT discovered_at FROM index_signature_queue
      WHERE status = ? ORDER BY discovered_at, signature LIMIT 1
    `).get(status) as { discovered_at: string } | undefined;
    return row ? [row.discovered_at] : [];
  });
  return rows.sort()[0];
}

function managedSnapshotIsCapped(
  repository: Repository,
  coverage: ReturnType<Repository["walletIndexCoverage"]>,
  dataProviderMode: DataProviderMode | undefined
): boolean {
  // The durable acquisition goal intentionally survives provider changes, so
  // it cannot establish current MANAGED authority by itself.
  if (dataProviderMode !== "MANAGED") return false;
  const value = repository.getSetting<unknown>(WALLET_ACQUISITION_GOAL_SETTING);
  if (!value || typeof value !== "object") return false;
  const goal = value as Partial<PersistedWalletAcquisitionGoal>;
  const unresolved = coverage.queueByStatus.PENDING +
    coverage.queueByStatus.LEASED +
    coverage.queueByStatus.RETRY +
    coverage.queueByStatus.FAILED;
  return goal.version === 1 &&
    goal.targetWallets === MANAGED_WALLET_INDEX_CAP &&
    (goal.status === "SATISFIED" || goal.status === "MAXIMUM_REACHED") &&
    coverage.indexedWallets >= MANAGED_WALLET_INDEX_CAP &&
    coverage.activeRuns === 0 &&
    unresolved === 0;
}

function collectHeadIntegrity(repository: Repository, now: Date): Pick<
  OperationalIndexQueueTelemetry,
  "headProgramsRequired" | "headProgramsReady" | "headUnprocessed" | "headCatchupComplete"
> {
  const bootstrap = repository.listWalletIndexCheckpoints(PROGRAM_INDEX_PIPELINE);
  const heads = repository.listWalletIndexCheckpoints(PROGRAM_HEAD_PIPELINE);
  const requiredPrograms = new Set([
    ...bootstrap.map((checkpoint) => checkpoint.partition),
    ...heads.map((checkpoint) => checkpoint.partition)
  ]);
  const headByProgram = new Map(heads.map((checkpoint) => [checkpoint.partition, checkpoint]));
  let headProgramsReady = 0;
  for (const programId of requiredPrograms) {
    const checkpoint = headByProgram.get(programId);
    if (!checkpoint?.lastSignature) continue;
    const coverageStartSlot = checkpoint.metadata?.coverageStartSlot;
    const coverageEndSlot = checkpoint.metadata?.coverageEndSlot;
    const updatedAgeSeconds = ageSeconds(now, checkpoint.updatedAt, "Program head checkpoint time");
    if (
      updatedAgeSeconds < HEAD_FRESHNESS_SECONDS &&
      typeof coverageStartSlot === "number" &&
      Number.isSafeInteger(coverageStartSlot) &&
      coverageStartSlot >= 0 &&
      typeof coverageEndSlot === "number" &&
      Number.isSafeInteger(coverageEndSlot) &&
      coverageEndSlot >= coverageStartSlot &&
      checkpoint.slot === coverageEndSlot &&
      checkpoint.cursor === undefined &&
      checkpoint.beforeSignature === undefined
    ) headProgramsReady += 1;
  }
  const headUnprocessed = safeInteger((repository.db.prepare(`
    SELECT COUNT(*) AS count
    FROM index_signature_queue queue
    WHERE queue.status IN ('PENDING', 'RETRY', 'LEASED', 'FAILED')
      AND EXISTS (
        SELECT 1 FROM index_signature_sources source
        WHERE source.signature = queue.signature
          AND source.source = 'helius-program-head'
      )
  `).get() as { count: number }).count, "Unprocessed head transaction count");
  const headProgramsRequired = requiredPrograms.size;
  return {
    headProgramsRequired,
    headProgramsReady,
    headUnprocessed,
    // Legacy ledgers without a program index do not claim head coverage and
    // retain the timestamp-only behavior. Once a program index exists, every
    // configured head must prove a fresh continuous range before trading.
    headCatchupComplete: headProgramsRequired === 0 || (
      headProgramsReady === headProgramsRequired && headUnprocessed === 0
    )
  };
}

function collectStorage(
  repository: Repository,
  fileSystem: OperationalTelemetryFileSystem
): { storage: OperationalStorageTelemetry; inMemory: boolean } {
  const pageSizeBytes = safeInteger(repository.db.pragma("page_size", { simple: true }), "SQLite page size");
  const pageCount = safeInteger(repository.db.pragma("page_count", { simple: true }), "SQLite page count");
  const freelistPages = safeInteger(repository.db.pragma("freelist_count", { simple: true }), "SQLite freelist count");
  if (pageSizeBytes <= 0) throw new Error("SQLite page size is invalid");
  if (freelistPages > pageCount) throw new Error("SQLite freelist exceeds page count");

  const allocatedPageBytes = pageSizeBytes * pageCount;
  const usedPageBytes = pageSizeBytes * (pageCount - freelistPages);
  if (!Number.isSafeInteger(allocatedPageBytes) || !Number.isSafeInteger(usedPageBytes)) {
    throw new Error("SQLite page allocation exceeds safe telemetry bounds");
  }
  const databasePath = repository.db.name;
  if (databasePath === ":memory:") {
    return {
      inMemory: true,
      storage: {
        databaseBytes: allocatedPageBytes,
        walBytes: 0,
        pageSizeBytes,
        pageCount,
        freelistPages,
        allocatedPageBytes,
        usedPageBytes
      }
    };
  }

  const capacity = fileSystem.driveCapacity(dirname(databasePath));
  const availableBytes = safeInteger(capacity.availableBytes, "Drive available bytes");
  const totalBytes = safeInteger(capacity.totalBytes, "Drive total bytes");
  if (totalBytes <= 0 || availableBytes > totalBytes) throw new Error("Drive capacity is invalid");
  return {
    inMemory: false,
    storage: {
      databaseBytes: safeInteger(fileSystem.fileSize(databasePath), "SQLite database bytes"),
      walBytes: safeInteger(fileSystem.fileSize(`${databasePath}-wal`, true), "SQLite WAL bytes"),
      pageSizeBytes,
      pageCount,
      freelistPages,
      allocatedPageBytes,
      usedPageBytes,
      driveAvailableBytes: availableBytes,
      driveTotalBytes: totalBytes,
      driveAvailablePercent: availableBytes / totalBytes * 100
    }
  };
}

function collectIndexQueue(
  repository: Repository,
  now: Date,
  dataProviderMode: DataProviderMode | undefined
): OperationalIndexQueueTelemetry {
  const coverage = repository.walletIndexCoverage(now);
  const queueTotal = Object.values(coverage.queueByStatus)
    .reduce((sum, value) => sum + safeInteger(value, "Index queue count"), 0);
  if (queueTotal !== safeInteger(coverage.uniqueSignatures, "Unique signature count")) {
    throw new Error("Index queue counters do not reconcile");
  }
  const oldestBacklogAt = oldestQueueTime(repository);
  const newestIndexedBlockAt = coverage.newestBlockTime;
  const backlog = coverage.queueByStatus.PENDING + coverage.queueByStatus.RETRY + coverage.queueByStatus.LEASED;
  if (backlog > 0 && !oldestBacklogAt) throw new Error("Index backlog age is unavailable");
  if (coverage.indexedTransactions > 0 && !newestIndexedBlockAt) {
    throw new Error("Indexed block freshness is unavailable");
  }
  const headIntegrity = collectHeadIntegrity(repository, now);
  return {
    pending: safeInteger(coverage.queueByStatus.PENDING, "Pending queue count"),
    leased: safeInteger(coverage.queueByStatus.LEASED, "Leased queue count"),
    retry: safeInteger(coverage.queueByStatus.RETRY, "Retry queue count"),
    failed: safeInteger(coverage.queueByStatus.FAILED, "Failed queue count"),
    managedSnapshotCapped: managedSnapshotIsCapped(repository, coverage, dataProviderMode),
    ...headIntegrity,
    ...(oldestBacklogAt
      ? {
          oldestBacklogAt,
          oldestBacklogAgeSeconds: ageSeconds(now, oldestBacklogAt, "Oldest backlog time")
        }
      : {}),
    ...(newestIndexedBlockAt
      ? {
          newestIndexedBlockAt,
          newestIndexedBlockLagSeconds: ageSeconds(now, newestIndexedBlockAt, "Newest indexed block time")
        }
      : {})
  };
}

function collectMonitoringRepair(repository: Repository, now: Date): OperationalMonitoringRepairTelemetry {
  const rows = repository.db.prepare(`
    SELECT status, COUNT(*) AS count,
           MIN(CASE WHEN status <> 'READY' THEN updated_at END) AS oldest_unready_at,
           MAX(last_succeeded_at) AS latest_succeeded_at
    FROM monitoring_repair_checkpoints GROUP BY status
  `).all() as Array<{
    status: "PENDING" | "READY" | "FAILED";
    count: number;
    oldest_unready_at: string | null;
    latest_succeeded_at: string | null;
  }>;
  const counts = { PENDING: 0, READY: 0, FAILED: 0 };
  let oldestUnreadyAt: string | undefined;
  let latestSucceededAt: string | undefined;
  for (const row of rows) {
    if (!(row.status in counts)) throw new Error("Monitoring repair status is invalid");
    counts[row.status] = safeInteger(row.count, "Monitoring repair count");
    if (row.oldest_unready_at && (!oldestUnreadyAt || row.oldest_unready_at < oldestUnreadyAt)) {
      oldestUnreadyAt = row.oldest_unready_at;
    }
    if (row.latest_succeeded_at && (!latestSucceededAt || row.latest_succeeded_at > latestSucceededAt)) {
      latestSucceededAt = row.latest_succeeded_at;
    }
  }
  if (oldestUnreadyAt) parseTime(oldestUnreadyAt, "Oldest monitoring repair time");
  if (latestSucceededAt) ageSeconds(now, latestSucceededAt, "Latest monitoring repair success");
  const retryDue = repository.db.prepare(`
    SELECT COUNT(*) AS count FROM monitoring_repair_checkpoints
    WHERE status = 'FAILED' AND next_retry_at IS NOT NULL AND next_retry_at <= ?
  `).get(now.toISOString()) as { count: number };
  if ((counts.PENDING + counts.FAILED) > 0 && !oldestUnreadyAt) {
    throw new Error("Monitoring repair age is unavailable");
  }
  return {
    total: counts.PENDING + counts.READY + counts.FAILED,
    pending: counts.PENDING,
    ready: counts.READY,
    failed: counts.FAILED,
    retryDue: safeInteger(retryDue.count, "Monitoring repair retry count"),
    ...(oldestUnreadyAt
      ? {
          oldestUnreadyAt,
          oldestUnreadyAgeSeconds: ageSeconds(now, oldestUnreadyAt, "Oldest monitoring repair time")
        }
      : {}),
    ...(latestSucceededAt ? { latestSucceededAt } : {})
  };
}

function collectTradingHead(
  repository: Repository,
  now: Date,
  runtimeState: OperationalTelemetryRuntimeState
): OperationalTradingHeadTelemetry | undefined {
  const cohort = repository.activePaperEvaluationCohort();
  if (!cohort) return undefined;
  const frozenAt = parseTime(cohort.frozenAt, "Paper evaluation freeze time");
  if (frozenAt === undefined) throw new Error("Paper evaluation freeze time is unavailable");
  if (frozenAt > now.getTime() + 60_000) throw new Error("Paper evaluation freeze time is in the future");
  const wallets = [...new Set(cohort.wallets)];
  let repairReadyWallets = 0;
  for (const wallet of wallets) {
    const checkpoint = repository.getMonitoringRepairCheckpoint(wallet);
    if (
      checkpoint?.status !== "READY" ||
      !checkpoint.lastSucceededAt
    ) continue;
    const cursorAt = parseTime(checkpoint.cursorAt, "Active wallet repair cursor");
    const succeededAt = parseTime(checkpoint.lastSucceededAt, "Active wallet repair success time");
    if (
      cursorAt !== undefined &&
      succeededAt !== undefined &&
      cursorAt >= frozenAt &&
      succeededAt >= frozenAt &&
      succeededAt <= now.getTime() + 60_000
    ) repairReadyWallets += 1;
  }
  const placeholders = wallets.map(() => "?").join(", ");
  const unprocessedSourceEvents = wallets.length === 0
    ? 0
    : safeInteger((repository.db.prepare(`
        SELECT COUNT(*) AS count FROM source_events
        WHERE processed = 0 AND wallet IN (${placeholders})
      `).get(...wallets) as { count: number }).count, "Active wallet source backlog");
  const stream = runtimeState.streamStatus;
  const lastMessageAt = stream?.lastMessageAt;
  const lastMessageLagSeconds = lastMessageAt
    ? ageSeconds(now, lastMessageAt, "Wallet stream message time")
    : undefined;
  const streamFresh = lastMessageLagSeconds !== undefined &&
    lastMessageLagSeconds <= WALLET_STREAM_FRESHNESS_SECONDS;
  const streamActive = stream?.active === true;
  const streamConnected = stream?.connected === true;
  const streamReady = stream?.ready === true;
  const healthy =
    wallets.length > 0 &&
    repairReadyWallets === wallets.length &&
    unprocessedSourceEvents === 0 &&
    streamActive &&
    streamConnected &&
    streamReady &&
    streamFresh;
  return {
    evaluationCohortId: cohort.id,
    requiredWallets: wallets.length,
    repairReadyWallets,
    unprocessedSourceEvents,
    streamActive,
    streamConnected,
    streamReady,
    streamFresh,
    healthy,
    ...(lastMessageAt ? { lastMessageAt } : {}),
    ...(lastMessageLagSeconds !== undefined ? { lastMessageLagSeconds } : {})
  };
}

function collectAudit(repository: Repository, now: Date): OperationalAuditTelemetry {
  const cutoff = new Date(now.getTime() - AUDIT_WINDOW_HOURS * 60 * 60 * 1_000).toISOString();
  const unknownSeverity = repository.db.prepare(`
    SELECT 1 AS found FROM audit_events
    WHERE created_at >= ? AND severity NOT IN ('info', 'warning', 'critical') LIMIT 1
  `).get(cutoff) as { found: number } | undefined;
  if (unknownSeverity) throw new Error("Recent audit severity is invalid");
  const rows = repository.db.prepare(`
    SELECT event_type, severity, details_json, created_at
    FROM audit_events
    WHERE severity IN ('warning', 'critical') AND created_at >= ?
    ORDER BY created_at, id
  `).all(cutoff) as Array<{
    event_type: string;
    severity: "warning" | "critical";
    details_json: string | null;
    created_at: string;
  }>;
  let warnings = 0;
  let critical = 0;
  let latestWarningOrCriticalAt: string | undefined;
  for (const row of rows) {
    let expectedShutdownSupersession = false;
    if (row.event_type === "runtime_stop_cleanup_failed" && row.details_json) {
      try {
        const details = JSON.parse(row.details_json) as {
          failures?: Array<{ stage?: unknown; error?: unknown }>;
        };
        expectedShutdownSupersession = Boolean(
          details.failures?.length && details.failures.every((failure) =>
            failure.stage === "provider_work" &&
            failure.error === "Provider-owned work was superseded by a credential or profile transition."
          )
        );
      } catch {
        expectedShutdownSupersession = false;
      }
    }
    if (row.severity === "warning" || expectedShutdownSupersession) warnings += 1;
    else if (row.severity === "critical") critical += 1;
    else throw new Error("Audit severity is invalid");
    if (!latestWarningOrCriticalAt || row.created_at > latestWarningOrCriticalAt) {
      latestWarningOrCriticalAt = row.created_at;
    }
  }
  warnings = safeInteger(warnings, "Warning audit count");
  critical = safeInteger(critical, "Critical audit count");
  if (latestWarningOrCriticalAt) ageSeconds(now, latestWarningOrCriticalAt, "Latest audit time");
  return {
    windowHours: AUDIT_WINDOW_HOURS,
    warnings,
    critical,
    ...(latestWarningOrCriticalAt ? { latestWarningOrCriticalAt } : {})
  };
}

function issue(
  issues: OperationalTelemetryIssue[],
  severity: OperationalTelemetryIssue["severity"],
  code: OperationalTelemetryIssueCode,
  message: string
): void {
  issues.push({ severity, code, message });
}

function assess(
  storage: OperationalStorageTelemetry,
  indexQueue: OperationalIndexQueueTelemetry,
  monitoringRepair: OperationalMonitoringRepairTelemetry,
  tradingHead: OperationalTradingHeadTelemetry | undefined,
  audit: OperationalAuditTelemetry,
  inMemory: boolean
): { status: OperationalTelemetryStatus; issues: OperationalTelemetryIssue[] } {
  const issues: OperationalTelemetryIssue[] = [];
  if (inMemory) {
    issue(issues, "WARNING", "DRIVE_CAPACITY_UNAVAILABLE", "Drive capacity is unavailable for the in-memory ledger.");
  } else if (
    (storage.driveAvailablePercent ?? 0) <= 5 ||
    (storage.driveAvailableBytes ?? 0) <= 10 * GIB
  ) {
    issue(issues, "CRITICAL", "DRIVE_CAPACITY_CRITICAL", "The ledger volume is critically low on free space.");
  } else if (
    (storage.driveAvailablePercent ?? 0) <= 15 ||
    (storage.driveAvailableBytes ?? 0) <= 25 * GIB
  ) {
    issue(issues, "WARNING", "DRIVE_CAPACITY_LOW", "The ledger volume is running low on free space.");
  }

  if (storage.walBytes >= GIB) {
    issue(issues, "WARNING", "WAL_LARGE", "The SQLite write-ahead log is larger than 1 GiB.");
  }
  if (indexQueue.failed > 0) {
    issue(
      issues,
      tradingHead ? "WARNING" : "CRITICAL",
      "INDEX_QUEUE_FAILED",
      tradingHead
        ? "One or more discovery-index transactions exhausted their retry budget; active-wallet monitoring is evaluated separately."
        : "One or more index transactions exhausted their safe retry budget."
    );
  }
  if ((indexQueue.oldestBacklogAgeSeconds ?? 0) >= 60 * 60) {
    issue(
      issues,
      tradingHead ? "WARNING" : "CRITICAL",
      "INDEX_BACKLOG_STALE",
      tradingHead
        ? "The discovery-index backlog is stale; active-wallet monitoring is evaluated separately."
        : "The oldest index queue item has waited at least one hour."
    );
  } else if ((indexQueue.oldestBacklogAgeSeconds ?? 0) >= 15 * 60) {
    issue(issues, "WARNING", "INDEX_BACKLOG_AGING", "The oldest index queue item has waited at least 15 minutes.");
  }
  if (indexQueue.retry > 0) {
    issue(issues, "WARNING", "INDEX_RETRY_PENDING", "Index transactions are waiting for retry.");
  }
  const discoveryHeadRequiresAlert =
    !indexQueue.managedSnapshotCapped || tradingHead?.healthy !== true;
  if (
    discoveryHeadRequiresAlert && (
      !indexQueue.headCatchupComplete ||
      (indexQueue.newestIndexedBlockLagSeconds ?? 0) >= HEAD_FRESHNESS_SECONDS
    )
  ) {
    issue(
      issues,
      tradingHead ? "WARNING" : "CRITICAL",
      "INDEX_HEAD_STALE",
      tradingHead
        ? "The discovery index head is stale or incomplete; active-wallet monitoring is evaluated separately."
        : "The confirmed index head is stale or its continuous catch-up is incomplete."
    );
  } else if (
    discoveryHeadRequiresAlert &&
    (indexQueue.newestIndexedBlockLagSeconds ?? 0) >= 5 * 60
  ) {
    issue(issues, "WARNING", "INDEX_HEAD_AGING", "The newest indexed block is at least five minutes behind this host's clock.");
  }
  if (tradingHead) {
    if (tradingHead.repairReadyWallets !== tradingHead.requiredWallets || tradingHead.requiredWallets === 0) {
      issue(
        issues,
        "CRITICAL",
        "MONITORING_REPAIR_FAILED",
        "One or more active leaders lack a successful repair through the current evaluation window."
      );
    } else if (monitoringRepair.failed > 0 || monitoringRepair.pending > 0) {
      issue(
        issues,
        "WARNING",
        "MONITORING_REPAIR_PENDING",
        "Monitoring repair work outside the active leader set remains visible but does not block entries."
      );
    }
    if (!tradingHead.streamActive || !tradingHead.streamConnected ||
      !tradingHead.streamReady || !tradingHead.streamFresh) {
      issue(
        issues,
        "CRITICAL",
        "MONITORING_STREAM_UNHEALTHY",
        "The active-leader stream is disconnected, unacknowledged, or has been silent for more than 60 seconds."
      );
    }
    if (tradingHead.unprocessedSourceEvents > 0) {
      issue(
        issues,
        "CRITICAL",
        "MONITORING_SOURCE_BACKLOG",
        "One or more active-leader source events have not completed durable processing."
      );
    }
  } else if (monitoringRepair.failed > 0 || monitoringRepair.retryDue > 0) {
    issue(issues, "CRITICAL", "MONITORING_REPAIR_FAILED", "A monitoring gap is awaiting a successful repair.");
  } else if (monitoringRepair.pending > 0) {
    issue(issues, "WARNING", "MONITORING_REPAIR_PENDING", "Monitoring gap repair is in progress.");
  }
  if (audit.critical > 0) {
    issue(issues, "CRITICAL", "RECENT_CRITICAL_AUDIT", "Critical audit events were recorded during the last 24 hours.");
  }
  if (audit.warnings > 0) {
    issue(issues, "WARNING", "RECENT_WARNING_AUDIT", "Warning audit events were recorded during the last 24 hours.");
  }
  const status: OperationalTelemetryStatus = issues.some((entry) => entry.severity === "CRITICAL")
    ? "CRITICAL"
    : issues.length > 0
      ? "WARNING"
      : "HEALTHY";
  return { status, issues };
}

export function collectOperationalTelemetry(
  repository: Repository,
  now = new Date(),
  fileSystem: OperationalTelemetryFileSystem = localFileSystem,
  runtimeState: OperationalTelemetryRuntimeState = {}
): OperationalTelemetrySnapshot {
  const capturedAt = now.toISOString();
  try {
    const { storage, inMemory } = collectStorage(repository, fileSystem);
    const indexQueue = collectIndexQueue(repository, now, runtimeState.dataProviderMode);
    const monitoringRepair = collectMonitoringRepair(repository, now);
    const tradingHead = collectTradingHead(repository, now, runtimeState);
    const audit = collectAudit(repository, now);
    const assessment = assess(storage, indexQueue, monitoringRepair, tradingHead, audit, inMemory);
    const blockingIssueCodes = assessment.issues
      .filter((entry) => entry.severity === "CRITICAL")
      .map((entry) => entry.code);
    return {
      ...assessment,
      capturedAt,
      blocksNewEntries: blockingIssueCodes.length > 0,
      blockingIssueCodes,
      storage,
      indexQueue,
      monitoringRepair,
      ...(tradingHead ? { tradingHead } : {}),
      audit
    };
  } catch {
    return {
      status: "UNAVAILABLE",
      capturedAt,
      blocksNewEntries: true,
      blockingIssueCodes: ["TELEMETRY_UNAVAILABLE"],
      issues: [{
        severity: "CRITICAL",
        code: "TELEMETRY_UNAVAILABLE",
        message: "Local operational telemetry could not be verified."
      }]
    };
  }
}
