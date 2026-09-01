import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SOL_MINT,
  USDC_MINT,
  type ExecutionRecord,
  type CopyIntent,
  type IndexedSpotSwap,
  type LeaderSwap,
  type QuoteSnapshot,
  type RejectedSourceAction,
  type SignalAuditRecord,
  type WalletActivitySample,
  type WalletIndexRecord,
  type WalletIndexRun
} from "@copylab/shared";
import type { CopyLabDatabase } from "../src/database.js";
import { openDatabase } from "../src/database.js";
import { Repository } from "../src/repository.js";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";

describe("Repository", () => {
  let db: CopyLabDatabase | undefined;
  const temporaryDatabases: string[] = [];
  afterEach(() => {
    db?.close();
    db = undefined;
    for (const path of temporaryDatabases.splice(0)) rmSync(path, { force: true });
  });

  it("migrates an empty SQLite database and persists settings and audit records", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    repository.setSetting("mode", "PAPER");
    repository.audit("test", "repository works", { ok: true });

    expect(repository.getSetting("mode")).toBe("PAPER");
    expect(repository.listAudit()).toMatchObject([
      { eventType: "test", message: "repository works", details: { ok: true } }
    ]);
    expect(db.pragma("user_version", { simple: true })).toBeGreaterThanOrEqual(10);
    const indexTables = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name LIKE '%index%' OR name = 'ingestion_checkpoints'
      ORDER BY name
    `).all() as Array<{ name: string }>;
    expect(indexTables.map((row) => row.name)).toEqual(expect.arrayContaining([
      "index_signature_queue",
      "index_signature_sources",
      "indexed_spot_swaps",
      "indexed_transactions",
      "ingestion_checkpoints",
      "wallet_index",
      "wallet_index_runs"
    ]));
  });

  it("adds the index schema to an existing version-three ledger without losing data", () => {
    const path = join(tmpdir(), `copylab-v3-${randomUUID()}.db`);
    temporaryDatabases.push(path);
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO settings(key, value_json, updated_at)
      VALUES ('mode', '"PAPER"', '2026-01-01T00:00:00.000Z');
      PRAGMA user_version = 3;
    `);
    legacy.close();

    db = openDatabase(path);
    const repository = new Repository(db);
    expect(repository.getSetting("mode")).toBe("PAPER");
    expect(db.pragma("user_version", { simple: true })).toBeGreaterThanOrEqual(10);
    expect(repository.walletIndexCoverage()).toMatchObject({
      uniqueSignatures: 0,
      indexedTransactions: 0,
      indexedWallets: 0
    });
  });

  it("adds durable monitoring repair cursors to a version-thirteen ledger", () => {
    const path = join(tmpdir(), `copylab-v13-${randomUUID()}.db`);
    temporaryDatabases.push(path);
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      PRAGMA user_version = 13;
    `);
    legacy.close();

    db = openDatabase(path);
    const repository = new Repository(db);
    const cursorAt = "2026-07-01T00:00:00.000Z";
    expect(repository.ensureMonitoringRepairCheckpoint("wallet", cursorAt)).toMatchObject({
      wallet: "wallet",
      cursorAt,
      status: "PENDING"
    });
    expect(db.pragma("user_version", { simple: true })).toBeGreaterThanOrEqual(16);
  });

  it("adds the self-hosted PAPER soak ledger to a version-fourteen database without losing settings", () => {
    const path = join(tmpdir(), `copylab-v14-${randomUUID()}.db`);
    temporaryDatabases.push(path);
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO settings(key, value_json, updated_at)
      VALUES ('mode', '"PAPER"', '2026-07-10T00:00:00.000Z');
      PRAGMA user_version = 14;
    `);
    legacy.close();

    db = openDatabase(path);
    const repository = new Repository(db);
    expect(repository.getSetting("mode")).toBe("PAPER");
    expect(db.pragma("user_version", { simple: true })).toBeGreaterThanOrEqual(16);
    expect(db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name LIKE 'self_hosted_paper_soak_%'
      ORDER BY name
    `).all()).toEqual([
      { name: "self_hosted_paper_soak_epochs" },
      { name: "self_hosted_paper_soak_heartbeats" }
    ]);
  });

  it("migrates the v18 global wallet target constraint to per-generation uniqueness", () => {
    const path = join(tmpdir(), `copylab-v18-generations-${randomUUID()}.db`);
    temporaryDatabases.push(path);
    db = openDatabase(path);
    let repository = new Repository(db);
    const first = repository.createWalletDeepHistoryCohort({
      selectedAt: "2026-04-01T00:00:00.000Z",
      snapshotCutoffAt: "2026-04-01T00:00:00.000Z",
      windowStart: "2026-01-01T00:00:00.000Z",
      windowEnd: "2026-04-01T00:00:00.000Z",
      wallets: ["repeat-wallet"]
    });
    db.close();
    db = undefined;

    const legacy = new Database(path);
    legacy.pragma("foreign_keys = OFF");
    legacy.exec(`
      DROP TABLE wallet_deep_history_targets;
      CREATE TABLE wallet_deep_history_targets (
        cohort_id TEXT NOT NULL,
        wallet TEXT NOT NULL UNIQUE,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        PRIMARY KEY (cohort_id, wallet),
        FOREIGN KEY (cohort_id) REFERENCES wallet_deep_history_cohorts(id) ON DELETE CASCADE
      );
      PRAGMA user_version = 18;
    `);
    legacy.prepare(`
      INSERT INTO wallet_deep_history_targets(cohort_id, wallet, ordinal) VALUES (?, ?, 0)
    `).run(first.id, "repeat-wallet");
    legacy.close();

    db = openDatabase(path);
    repository = new Repository(db);
    expect(repository.getWalletDeepHistoryCohort(first.id)?.wallets).toEqual(["repeat-wallet"]);
    expect(() => repository.createWalletDeepHistoryCohort({
      selectedAt: "2026-04-02T00:00:00.000Z",
      snapshotCutoffAt: "2026-04-02T00:00:00.000Z",
      windowStart: "2026-01-02T00:00:00.000Z",
      windowEnd: "2026-04-02T00:00:00.000Z",
      wallets: ["repeat-wallet"]
    })).not.toThrow();
  });

  it("freezes durable paper evaluation evidence and filters trades and NAV by cohort", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    expect(repository.freezePaperEvaluationCohort(
      "weekly-cohort-incomplete",
      ["wallet-a", "wallet-b"],
      141,
      "2026-01-31T00:00:00.000Z"
    )).toBeUndefined();
    expect(repository.activePaperEvaluationCohort()).toBeUndefined();
    const qualifiedWallets = ["wallet-a", "wallet-b", "wallet-c"];
    repository.saveCohort({
      cohortId: "weekly-cohort-1",
      generatedAt: "2026-01-31T00:00:00.000Z",
      candidates: qualifiedWallets.map((address) => ({
        address,
        cohortId: "weekly-cohort-1",
        firstSeenAt: "2025-01-01T00:00:00.000Z",
        lastSeenAt: "2026-01-31T00:00:00.000Z",
        control: false,
        tags: []
      }))
    });
    repository.setActiveWallets("weekly-cohort-1", qualifiedWallets);
    for (const wallet of qualifiedWallets) {
      repository.saveWalletScore("weekly-cohort-1", {
        wallet,
        calculatedAt: "2026-01-31T00:00:00.000Z",
        qualified: wallet !== "wallet-c",
        reasons: wallet === "wallet-c" ? ["not yet qualified"] : [],
        historyDays: 90,
        closedEligibleSwaps: 50,
        activeWeeks: 3,
        medianHoldingMinutes: 15,
        topTokenProfitShare: 0.2,
        topThreeProfitShare: 0.5
      });
    }
    expect(repository.freezePaperEvaluationCohort(
      "weekly-cohort-1",
      qualifiedWallets,
      141,
      "2026-01-31T12:00:00.000Z"
    )).toBeUndefined();
    repository.saveWalletScore("weekly-cohort-1", {
      wallet: "wallet-c",
      calculatedAt: "2026-01-31T13:00:00.000Z",
      qualified: true,
      reasons: [],
      historyDays: 90,
      closedEligibleSwaps: 50,
      activeWeeks: 3,
      medianHoldingMinutes: 15,
      topTokenProfitShare: 0.2,
      topThreeProfitShare: 0.5
    });
    const first = repository.freezePaperEvaluationCohort(
      "weekly-cohort-1",
      ["wallet-c", "wallet-b", "wallet-a"],
      141,
      "2026-02-01T00:00:00.000Z"
    );
    expect(first).toMatchObject({
      created: true,
      cohort: {
        frozenAt: "2026-02-01T00:00:00.000Z",
        initialNavUsd: 141,
        wallets: ["wallet-a", "wallet-b", "wallet-c"]
      }
    });
    const evaluationId = first!.cohort.id;
    repository.recordPaperRuntimeHeartbeat(evaluationId, "2026-02-01T00:00:00.000Z");
    repository.recordPaperRuntimeHeartbeat(evaluationId, "2026-02-01T00:01:00.000Z");
    expect(repository.listPaperRuntimeHeartbeats(evaluationId)).toEqual([
      "2026-02-01T00:00:00.000Z",
      "2026-02-01T00:01:00.000Z"
    ]);

    repository.saveClosedTrade("old", "PAPER", {
      closedAt: "2026-01-20T00:00:00.000Z",
      pnlUsd: 99,
      sourceWallet: "wallet-a"
    });
    repository.saveClosedTrade("current", "PAPER", {
      closedAt: "2026-02-02T00:00:00.000Z",
      pnlUsd: 1,
      stressPnlUsd: 0.5,
      sourceWallet: "wallet-a",
      evaluationCohortId: evaluationId
    });
    repository.savePortfolioSnapshot({
      mode: "PAPER",
      capturedAt: "2026-02-01T00:00:00.000Z",
      navUsd: 141,
      peakNavUsd: 141,
      dayStartNavUsd: 141,
      deployedUsd: 0,
      solReserveUsd: 6,
      liquidReserveUsd: 141,
      realizedPnlUsd: 0,
      unrealizedPnlUsd: 0,
      openPositions: 0,
      balanceMismatchPercent: 0,
      evaluationCohortId: evaluationId,
      executablePricingComplete: true
    });
    expect(repository.listClosedTrades("PAPER", evaluationId)).toEqual([
      expect.objectContaining({ pnlUsd: 1, evaluationCohortId: evaluationId })
    ]);
    expect(repository.listPortfolioSnapshots("PAPER", evaluationId)).toHaveLength(1);

    const unchanged = repository.freezePaperEvaluationCohort(
      "weekly-cohort-2",
      ["wallet-a", "wallet-b", "wallet-c"],
      150,
      "2026-02-08T00:00:00.000Z"
    );
    expect(unchanged).toMatchObject({ created: false, cohort: { id: evaluationId } });

    const attemptedAutomaticRotation = repository.freezePaperEvaluationCohort(
      "weekly-cohort-3",
      ["wallet-f", "wallet-g", "wallet-h"],
      142,
      "2026-02-15T00:00:00.000Z"
    );
    expect(attemptedAutomaticRotation).toMatchObject({
      created: false,
      cohort: { id: evaluationId, frozenAt: "2026-02-01T00:00:00.000Z" }
    });
    expect(repository.activePaperEvaluationCohort()?.id).toBe(evaluationId);
  });

  it("serves exact wallet coverage from the materialized metric table without aggregate scans", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    repository.enqueueWalletIndexTransactions([{
      signature: "metric-signature",
      sourceAddress: "metric-program",
      source: "metric-test",
      discoveredAt: "2026-01-01T00:00:00.000Z"
    }]);
    const prepare = vi.spyOn(db, "prepare");

    expect(repository.walletIndexCoverage()).toMatchObject({
      uniqueSignatures: 1,
      sourceLinks: 1,
      queueByStatus: { PENDING: 1, LEASED: 0, PROCESSED: 0, RETRY: 0, FAILED: 0 }
    });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(String(prepare.mock.calls[0]?.[0])).toContain("wallet_index_metrics");
    expect(String(prepare.mock.calls[0]?.[0])).not.toContain("COUNT(");
  });

  it("keeps source events wallet-scoped and tracks confirmed-fill application exactly once", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const baseSwap: LeaderSwap = {
      sourceSignature: "same-signature",
      sourceWallet: "wallet-a",
      slot: 1,
      blockTime: new Date().toISOString(),
      detectedAt: new Date().toISOString(),
      side: "BUY",
      baseMint: USDC_MINT,
      targetMint: SOL_MINT,
      baseAmountAtomic: "1000000",
      targetAmountAtomic: "10000000",
      baseAmountUi: 1,
      targetAmountUi: 0.01,
      leaderPriceUsd: 100,
      recovered: false
    };
    expect(repository.insertSourceEvent(baseSwap)).toBe(true);
    expect(repository.insertSourceEvent({ ...baseSwap, sourceWallet: "wallet-b" })).toBe(true);
    expect(repository.insertSourceEvent(baseSwap)).toBe(false);
    expect(repository.listUnprocessedSourceEvents()).toHaveLength(2);

    const intent: CopyIntent = {
      id: "intent",
      idempotencyKey: "decision-idempotency",
      createdAt: "2026-01-01T00:00:00.000Z",
      sourceSwap: baseSwap,
      side: "BUY",
      inputMint: USDC_MINT,
      outputMint: SOL_MINT,
      inputAmountAtomic: "1000000",
      inputAmountUsd: 1
    };
    repository.saveDecision("decision", intent, undefined, {
      allowed: false,
      code: "TOKEN_INELIGIBLE",
      reasons: ["fixture rejection"],
      decidedAt: "2026-01-01T00:00:01.000Z"
    });
    expect(repository.listSignalOutcomes()).toEqual([expect.objectContaining({
      id: intent.idempotencyKey,
      idempotencyKey: intent.idempotencyKey,
      sourceSignature: baseSwap.sourceSignature,
      sourceWallet: baseSwap.sourceWallet,
      mint: baseSwap.targetMint,
      action: "BUY",
      mode: "PAPER",
      status: "REJECTED",
      reasonCode: "RISK_REJECTED",
      reason: "fixture rejection",
      decisionCode: "TOKEN_INELIGIBLE",
      positionValueUsd: 1
    })]);

    const quote: QuoteSnapshot = {
      requestId: "request",
      quotedAt: new Date().toISOString(),
      inputMint: USDC_MINT,
      outputMint: SOL_MINT,
      inputAmountAtomic: "1000000",
      outputAmountAtomic: "10000000",
      inputUsd: 1,
      outputUsd: 1,
      priceImpactPercent: 0,
      slippageBps: 10,
      feeBps: 0,
      signatureFeeLamports: 5000,
      prioritizationFeeLamports: 0,
      rentFeeLamports: 0,
      minimumOutputAtomic: "9990000",
      router: "iris"
    };
    const execution: ExecutionRecord = {
      id: "execution",
      idempotencyKey: "idempotency",
      intentId: "intent",
      mode: "PAPER",
      status: "CONFIRMED",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sourceSignature: baseSwap.sourceSignature,
      quote
    };
    repository.upsertExecution(execution);
    expect(repository.listUnappliedConfirmedExecutions()).toHaveLength(1);
    repository.markExecutionApplied(execution.id);
    repository.markExecutionApplied(execution.id);
    expect(repository.listUnappliedConfirmedExecutions()).toHaveLength(0);
  });

  it("atomically persists a rejected source once without creating trading state", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const action: RejectedSourceAction = {
      sourceSignature: "unsupported-program-signature",
      sourceWallet: "unsupported-program-wallet",
      slot: 42,
      blockTime: "2026-07-13T12:00:00.000Z",
      detectedAt: "2026-07-13T12:00:01.000Z",
      side: "BUY",
      baseMint: USDC_MINT,
      targetMint: SOL_MINT,
      recovered: false
    };
    const outcome: SignalAuditRecord = {
      id: "copy-v1-unsupported-program",
      idempotencyKey: "copy-v1-unsupported-program",
      sourceSignature: action.sourceSignature,
      sourceWallet: action.sourceWallet,
      mint: action.targetMint,
      action: action.side,
      mode: "PAPER",
      status: "REJECTED",
      reasonCode: "UNSUPPORTED_PROGRAM_ACTIVITY",
      reason: "Strict decoding rejected unsupported program activity.",
      sourceBlockTime: action.blockTime,
      observedAt: action.detectedAt,
      updatedAt: "2026-07-13T12:00:02.000Z"
    };

    expect(repository.persistRejectedSourceOutcome(action, outcome)).toBe(true);
    expect(repository.persistRejectedSourceOutcome(action, outcome)).toBe(false);

    expect(repository.db.prepare(`
      SELECT signature, wallet, processed FROM source_events
      WHERE signature = ? AND wallet = ?
    `).get(action.sourceSignature, action.sourceWallet)).toEqual({
      signature: action.sourceSignature,
      wallet: action.sourceWallet,
      processed: 1
    });
    expect(repository.listUnprocessedSourceEvents()).toEqual([]);
    expect(repository.listSignalOutcomes()).toEqual([
      expect.objectContaining({
        idempotencyKey: outcome.idempotencyKey,
        sourceSignature: action.sourceSignature,
        sourceWallet: action.sourceWallet,
        mint: action.targetMint,
        action: "BUY",
        mode: "PAPER",
        status: "REJECTED",
        reasonCode: "UNSUPPORTED_PROGRAM_ACTIVITY"
      })
    ]);
    for (const table of ["signal_decisions", "executions", "positions"]) {
      expect(repository.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    }
  });

  it("keeps one redacted scalar outcome while execution states advance", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const source: LeaderSwap = {
      sourceSignature: "leader-signature",
      sourceWallet: "leader-wallet",
      slot: 42,
      blockTime: "2026-01-01T00:00:00.000Z",
      detectedAt: "2026-01-01T00:00:01.000Z",
      side: "BUY",
      baseMint: USDC_MINT,
      targetMint: SOL_MINT,
      baseAmountAtomic: "1000000",
      targetAmountAtomic: "10000000",
      baseAmountUi: 1,
      targetAmountUi: 0.01,
      leaderPriceUsd: 100,
      recovered: false
    };
    repository.insertSourceEvent(source);
    const intent: CopyIntent = {
      id: "intent-lifecycle",
      idempotencyKey: "copy-v1-lifecycle",
      createdAt: source.detectedAt,
      sourceSwap: source,
      side: "BUY",
      inputMint: USDC_MINT,
      outputMint: SOL_MINT,
      inputAmountAtomic: "1000000",
      inputAmountUsd: 1
    };
    repository.saveDecision("decision-lifecycle", intent, undefined, {
      allowed: true,
      code: "ALLOWED",
      reasons: ["allowed"],
      decidedAt: "2026-01-01T00:00:02.000Z"
    }, "LIVE");
    const quote: QuoteSnapshot = {
      requestId: "request-lifecycle",
      quotedAt: "2026-01-01T00:00:03.000Z",
      inputMint: USDC_MINT,
      outputMint: SOL_MINT,
      inputAmountAtomic: "1000000",
      outputAmountAtomic: "10000000",
      inputUsd: 1,
      outputUsd: 0.99,
      priceImpactPercent: 0.1,
      slippageBps: 10,
      feeBps: 5,
      signatureFeeLamports: 5000,
      prioritizationFeeLamports: 0,
      rentFeeLamports: 0,
      minimumOutputAtomic: "9900000",
      router: "iris",
      transactionBase64: "signed-or-unsigned-transaction-payload-must-never-appear"
    };
    const execution: ExecutionRecord = {
      id: "execution-lifecycle",
      idempotencyKey: intent.idempotencyKey,
      intentId: intent.id,
      mode: "LIVE",
      status: "AWAITING_APPROVAL",
      createdAt: "2026-01-01T00:00:03.000Z",
      updatedAt: "2026-01-01T00:00:03.000Z",
      sourceSignature: source.sourceSignature,
      quote
    };
    repository.upsertExecution(execution);
    repository.upsertExecution({
      ...execution,
      status: "SUBMITTED",
      updatedAt: "2026-01-01T00:00:04.000Z",
      submittedAt: "2026-01-01T00:00:04.000Z",
      targetSignature: "bot-signature"
    });
    repository.upsertExecution({
      ...execution,
      status: "CONFIRMED",
      updatedAt: "2026-01-01T00:00:05.000Z",
      targetSignature: "bot-signature",
      actualFeesUsd: 0.01,
      implementationShortfallPercent: 0.2
    });
    repository.saveDecision("duplicate-decision", intent, undefined, {
      allowed: true,
      code: "ALLOWED",
      reasons: ["stale duplicate"],
      decidedAt: "2026-01-01T00:00:02.000Z"
    }, "LIVE");
    repository.upsertExecution({
      ...execution,
      status: "SUBMITTED",
      updatedAt: "2026-01-01T00:00:06.000Z",
      targetSignature: "late-stale-submission"
    });

    const outcomes = repository.listSignalOutcomes();
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      idempotencyKey: intent.idempotencyKey,
      status: "CONFIRMED",
      reasonCode: "LIVE_CONFIRMED",
      executionId: execution.id,
      targetSignature: "bot-signature",
      actualFeesUsd: 0.01,
      implementationShortfallPercent: 0.2
    });
    expect(JSON.stringify(outcomes[0])).not.toContain("transactionBase64");
    expect(JSON.stringify(outcomes[0])).not.toContain(quote.transactionBase64);
    expect(() => repository.upsertSignalOutcome({
      ...outcomes[0]!,
      sourceWallet: "tampered-wallet",
      updatedAt: "2026-01-01T00:00:07.000Z"
    })).toThrow("immutable source identity");
  });

  it("deduplicates, redacts, and bounds structured signal outcomes", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const source: LeaderSwap = {
      sourceSignature: "bounded-source-0",
      sourceWallet: "bounded-wallet",
      slot: 1,
      blockTime: "2026-01-01T00:00:00.000Z",
      detectedAt: "2026-01-01T00:00:01.000Z",
      side: "BUY",
      baseMint: USDC_MINT,
      targetMint: SOL_MINT,
      baseAmountAtomic: "1",
      targetAmountAtomic: "1",
      baseAmountUi: 1,
      targetAmountUi: 1,
      leaderPriceUsd: 1,
      recovered: false
    };
    repository.insertSourceEvent(source);
    const outcome = (index: number): SignalAuditRecord => ({
      id: `outcome-${index}`,
      idempotencyKey: `outcome-${index}`,
      sourceSignature: `bounded-source-${index}`,
      sourceWallet: source.sourceWallet,
      mint: source.targetMint,
      action: "BUY",
      mode: "PAPER",
      status: "BLOCKED",
      reasonCode: "MODE_BLOCKED",
      reason: `authorization: Bearer super-secret-token-${"x".repeat(40)}`,
      sourceBlockTime: source.blockTime,
      observedAt: source.detectedAt,
      updatedAt: new Date(Date.parse(source.detectedAt) + index * 1000).toISOString()
    });
    repository.upsertSignalOutcome(outcome(0));
    repository.upsertSignalOutcome({ ...outcome(0), status: "ANALYSIS_ONLY", reasonCode: "SHADOW_WALLET" });
    expect(() => repository.upsertSignalOutcome({
      ...outcome(0),
      id: "different-key-for-same-source",
      idempotencyKey: "different-key-for-same-source"
    })).toThrow();
    for (let index = 1; index < 505; index += 1) {
      repository.insertSourceEvent({ ...source, sourceSignature: `bounded-source-${index}` });
      repository.upsertSignalOutcome(outcome(index));
    }

    expect(repository.listSignalOutcomes(1_000)).toHaveLength(500);
    expect(repository.listSignalOutcomes(-10)).toEqual([]);
    expect(repository.db.prepare("SELECT COUNT(*) AS count FROM signal_outcomes WHERE idempotency_key = ?")
      .get("outcome-0")).toEqual({ count: 1 });
    const persisted = repository.getSignalOutcome("outcome-0");
    expect(persisted).toMatchObject({ status: "BLOCKED", reasonCode: "MODE_BLOCKED" });
    expect(persisted?.reason).not.toContain("super-secret-token");
  });

  it("globally deduplicates over one thousand signatures while retaining independent discovery sources", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const discoveredAt = "2026-01-01T00:00:00.000Z";
    const items = Array.from({ length: 1_200 }, (_, index) => ({
      signature: `signature-${index.toString().padStart(4, "0")}`,
      sourceAddress: "jupiter-program",
      wallet: `wallet-${index % 1_050}`,
      source: "program-scan",
      discoveredAt,
      slot: 10_000 + index,
      blockTime: new Date(Date.parse(discoveredAt) + index * 1_000).toISOString(),
      runId: "run-large"
    }));
    expect(repository.enqueueWalletIndexTransactions(items)).toEqual({
      observations: 1_200,
      enqueued: 1_200,
      deduplicated: 0,
      sourcesAdded: 1_200
    });
    expect(repository.enqueueWalletIndexTransactions([
      items[0]!,
      { ...items[0]!, wallet: "wallet-alternate" },
      {
        signature: items[0]!.signature,
        sourceAddress: "second-jupiter-program",
        source: "program-backfill",
        discoveredAt
      }
    ])).toEqual({
      observations: 3,
      enqueued: 0,
      deduplicated: 3,
      sourcesAdded: 2
    });

    const coverage = repository.walletIndexCoverage(new Date("2026-01-02T00:00:00.000Z"));
    expect(coverage).toMatchObject({
      uniqueSignatures: 1_200,
      sourceLinks: 1_202,
      indexedTransactions: 0,
      queueByStatus: { PENDING: 1_200, LEASED: 0, PROCESSED: 0, RETRY: 0, FAILED: 0 }
    });
    const sources = repository.listWalletIndexTransactionSources(items[0]!.signature);
    expect(sources).toHaveLength(3);
    expect(sources).toContainEqual(expect.objectContaining({
      sourceAddress: "second-jupiter-program",
      source: "program-backfill"
    }));
    expect(sources.find((source) => source.sourceAddress === "second-jupiter-program")?.wallet).toBeUndefined();
    expect((db.prepare("SELECT COUNT(*) AS count FROM source_events").get() as { count: number }).count).toBe(0);
  });

  it("leases non-null slots contiguously while keeping null-slot ordering deterministic", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const discoveredAt = "2026-01-02T00:00:00.000Z";
    repository.enqueueWalletIndexTransactions([
      ...Array.from({ length: 5 }, (_, index) => ({
        signature: `slot-100-${index}`,
        sourceAddress: "program",
        source: "scan",
        discoveredAt,
        slot: 100
      })),
      ...Array.from({ length: 5 }, (_, index) => ({
        signature: `slot-99-${index}`,
        sourceAddress: "program",
        source: "scan",
        discoveredAt,
        slot: 99
      })),
      { signature: "null-b", sourceAddress: "program", source: "scan", discoveredAt },
      { signature: "null-a", sourceAddress: "program", source: "scan", discoveredAt }
    ]);

    const first = repository.leaseWalletIndexTransactions("slot-worker-a", 6, 60, new Date(discoveredAt));
    expect(first.map((item) => item.slot)).toEqual([100, 100, 100, 100, 100, 99]);
    expect(first.slice(0, 5).map((item) => item.signature)).toEqual([
      "slot-100-0",
      "slot-100-1",
      "slot-100-2",
      "slot-100-3",
      "slot-100-4"
    ]);

    const second = repository.leaseWalletIndexTransactions("slot-worker-b", 6, 60, new Date(discoveredAt));
    expect(second.map((item) => item.signature)).toEqual([
      "slot-99-1",
      "slot-99-2",
      "slot-99-3",
      "slot-99-4",
      "null-a",
      "null-b"
    ]);
    expect(second.map((item) => item.slot)).toEqual([99, 99, 99, 99, undefined, undefined]);
  });

  it("leases atomically, retries safely across restart, and rejects stale acknowledgements", () => {
    const path = join(tmpdir(), `copylab-index-${randomUUID()}.db`);
    temporaryDatabases.push(path);
    const startedAt = new Date("2026-02-01T00:00:00.000Z");
    db = openDatabase(path);
    let repository = new Repository(db);
    repository.enqueueWalletIndexTransactions([
      { signature: "retry-me", sourceAddress: "wallet-a", wallet: "wallet-a", source: "scan", discoveredAt: startedAt.toISOString() },
      { signature: "expire-me", sourceAddress: "wallet-b", wallet: "wallet-b", source: "scan", discoveredAt: startedAt.toISOString() },
      { signature: "finish-me", sourceAddress: "wallet-c", wallet: "wallet-c", source: "scan", discoveredAt: startedAt.toISOString() }
    ]);

    const firstLeases = repository.leaseWalletIndexTransactions("worker-a", 3, 10, startedAt);
    expect(firstLeases).toHaveLength(3);
    const retryLease = firstLeases.find((entry) => entry.signature === "retry-me")!;
    const expireLease = firstLeases.find((entry) => entry.signature === "expire-me")!;
    const finishLease = firstLeases.find((entry) => entry.signature === "finish-me")!;
    expect(repository.retryWalletIndexTransaction(
      retryLease.signature,
      retryLease.leaseToken!,
      "temporary provider failure",
      5_000,
      3,
      startedAt
    )).toBe("RETRY");
    expect(repository.completeWalletIndexTransaction(finishLease, [], "stale-token", startedAt)).toBe(false);
    expect(repository.completeWalletIndexTransaction(finishLease, [], finishLease.leaseToken!, startedAt)).toBe(true);
    expect(repository.completeWalletIndexTransaction(finishLease, [], finishLease.leaseToken!, startedAt)).toBe(true);

    db.close();
    db = openDatabase(path);
    repository = new Repository(db);
    expect(repository.leaseWalletIndexTransactions(
      "worker-b",
      10,
      10,
      new Date(startedAt.getTime() + 4_000)
    )).toHaveLength(0);
    const retryAgain = repository.leaseWalletIndexTransactions(
      "worker-b",
      10,
      10,
      new Date(startedAt.getTime() + 6_000)
    );
    expect(retryAgain.map((entry) => entry.signature)).toEqual(["retry-me"]);
    expect(retryAgain[0]).toMatchObject({ attempts: 2, status: "LEASED" });
    expect(repository.retryWalletIndexTransaction(
      retryAgain[0]!.signature,
      retryAgain[0]!.leaseToken!,
      "permanent failure",
      0,
      2,
      new Date(startedAt.getTime() + 6_000)
    )).toBe("FAILED");

    const recovered = repository.leaseWalletIndexTransactions(
      "worker-c",
      10,
      10,
      new Date(startedAt.getTime() + 11_000)
    );
    expect(recovered.map((entry) => entry.signature)).toEqual([expireLease.signature]);
    expect(recovered[0]).toMatchObject({ attempts: 2, status: "LEASED" });
    expect(repository.walletIndexCoverage()).toMatchObject({
      uniqueSignatures: 3,
      indexedTransactions: 1,
      queueByStatus: { PENDING: 0, LEASED: 1, PROCESSED: 1, RETRY: 0, FAILED: 1 }
    });
  });

  it("recovers queue items exhausted by an unsupported Helius batch probe", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const at = new Date("2026-02-02T00:00:00.000Z");
    repository.enqueueWalletIndexTransactions([{
      signature: "batch-tier-failure",
      sourceAddress: "jupiter-program",
      source: "program-scan",
      discoveredAt: at.toISOString()
    }]);
    const lease = repository.leaseWalletIndexTransactions("worker", 1, 60, at)[0]!;
    expect(repository.retryWalletIndexTransaction(
      lease.signature,
      lease.leaseToken!,
      "Helius index RPC returned HTTP 403: Batch requests are only available for paid plans",
      0,
      1,
      at
    )).toBe("FAILED");

    expect(repository.recoverWalletIndexBatchFallbackFailures(at)).toBe(1);
    expect(repository.getWalletIndexTransaction(lease.signature)).toMatchObject({
      status: "RETRY",
      attempts: 0,
      lastError: "Recovered after Helius batch capability fallback."
    });
    expect(repository.recoverWalletIndexBatchFallbackFailures(at)).toBe(0);
  });

  it("atomically stores normalized swaps and exposes durable aggregate coverage", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const at = new Date("2026-03-01T12:00:00.000Z");
    repository.enqueueWalletIndexTransactions([
      {
        signature: "swap-signature",
        sourceAddress: "jupiter-program",
        wallet: "wallet-swapper",
        source: "program-scan",
        discoveredAt: at.toISOString(),
        slot: 123,
        blockTime: at.toISOString()
      }
    ]);
    const leased = repository.leaseWalletIndexTransactions("hydrator", 1, 60, at)[0]!;
    const swap: IndexedSpotSwap = {
      id: "swap-signature:wallet-swapper:0",
      signature: "swap-signature",
      wallet: "wallet-swapper",
      swapIndex: 0,
      slot: 123,
      blockTime: at.toISOString(),
      side: "BUY",
      baseMint: USDC_MINT,
      targetMint: SOL_MINT,
      inputMint: USDC_MINT,
      outputMint: SOL_MINT,
      inputAmountAtomic: "1000000",
      outputAmountAtomic: "5000000",
      inputAmountUi: 1,
      outputAmountUi: 0.005,
      eligible: true,
      eligibilityReasons: [],
      programIds: ["jupiter-program"],
      indexedAt: at.toISOString()
    };
    expect(repository.completeWalletIndexTransaction({
      ...leased,
      slot: 123,
      blockTime: at.toISOString(),
      success: true,
      feePayer: "wallet-swapper",
      accountKeys: ["wallet-swapper"],
      programIds: ["jupiter-program"],
      transactionVersion: "0",
      raw: { fixture: true }
    }, [swap], leased.leaseToken!, at)).toBe(true);
    expect(repository.listIndexedSpotSwaps("wallet-swapper")).toEqual([swap]);
    expect(repository.getWalletIndexTransaction("swap-signature")).toMatchObject({
      signature: "swap-signature",
      status: "PROCESSED",
      success: true,
      raw: { fixture: true },
      sourceWallets: ["wallet-swapper"]
    });
    expect(repository.walletIndexCoverage(at)).toMatchObject({
      indexedTransactions: 1,
      indexedSwaps: 1,
      oldestBlockTime: at.toISOString(),
      newestBlockTime: at.toISOString(),
      queueByStatus: { PENDING: 0, LEASED: 0, PROCESSED: 1, RETRY: 0, FAILED: 0 }
    });
    const dirty = repository.listDirtyWalletIndexRecords(10);
    expect(dirty).toEqual([expect.objectContaining({
      wallet: "wallet-swapper",
      lastSignature: "swap-signature"
    })]);
    expect(repository.clearDirtyWalletIndexRecord(
      "wallet-swapper",
      dirty[0]!.markedAt,
      "newer-signature"
    )).toBe(false);
    expect(repository.clearDirtyWalletIndexRecord(
      "wallet-swapper",
      dirty[0]!.markedAt,
      dirty[0]!.lastSignature
    )).toBe(true);
  });

  it("persists resumable checkpoints, runs, activity, pre-screen snapshots, and 5000 wallet aggregates", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const updatedAt = "2026-04-01T00:00:00.000Z";
    const records: WalletIndexRecord[] = Array.from({ length: 5_000 }, (_, index) => ({
      wallet: `indexed-wallet-${index.toString().padStart(4, "0")}`,
      firstSeenAt: "2025-01-01T00:00:00.000Z",
      lastSeenAt: updatedAt,
      historyDays: 455,
      transactionCount: 100 + index,
      successfulTransactionCount: 90 + index,
      spotSwapCount: 80 + index,
      eligibleSpotSwapCount: 70 + index,
      closedEligibleSwaps: 60 + index,
      buyCount: 40 + index,
      sellCount: 40,
      activeDays: 20,
      activeWeeks: 4,
      distinctMints: 10,
      medianHoldingMinutes: 30,
      preScreenEligible: index % 2 === 0,
      preScreenReasons: index % 2 === 0 ? [] : ["control"],
      deepHistoryStatus: index % 2 === 0 ? "COMPLETE" : "AWAITING",
      structuralEligible: index % 2 === 0,
      structuralReasons: index % 2 === 0 ? [] : ["awaiting local deep history"],
      updatedAt
    }));
    repository.upsertWalletIndexRecords(records);
    expect(repository.listWalletIndexRecords(10_000)).toHaveLength(5_000);
    expect(repository.listWalletIndexRecords(10_000, true)).toHaveLength(2_500);
    expect(repository.listWalletIndexResearchShortlist(3).map((record) => record.wallet)).toEqual([
      "indexed-wallet-4998",
      "indexed-wallet-4996",
      "indexed-wallet-4994"
    ]);

    const first = records[0]!;
    const sample: WalletActivitySample = {
      wallet: first.wallet,
      periodStart: "2026-03-01T00:00:00.000Z",
      periodEnd: updatedAt,
      transactionCount: 100,
      successfulTransactionCount: 90,
      spotSwapCount: 80,
      eligibleSpotSwapCount: 70,
      buyCount: 40,
      sellCount: 40,
      distinctMints: 10,
      sampledAt: updatedAt
    };
    repository.saveWalletActivitySample(sample);
    repository.saveWalletPreScreenSnapshot({
      wallet: first.wallet,
      runId: "run-index",
      calculatedAt: updatedAt,
      eligible: true,
      reasons: [],
      record: first
    });
    repository.saveWalletIndexCheckpoint({
      pipeline: "program-backfill",
      partition: "jupiter-v6",
      cursor: "cursor-new",
      lastSignature: "signature-new",
      completed: false,
      updatedAt
    });
    repository.saveWalletIndexCheckpoint({
      pipeline: "program-backfill",
      partition: "jupiter-v6",
      cursor: "cursor-stale",
      completed: false,
      updatedAt: "2026-03-01T00:00:00.000Z"
    });
    const run: WalletIndexRun = {
      id: "run-index",
      stage: "PRESCREEN",
      startedAt: updatedAt,
      updatedAt,
      discoveredWallets: 5_000,
      enqueuedSignatures: 0,
      hydratedTransactions: 0,
      indexedSwaps: 0,
      preScreenedWallets: 5_000,
      structuralCandidates: 2_500
    };
    repository.upsertWalletIndexRun(run);

    expect(repository.getWalletIndexCheckpoint("program-backfill", "jupiter-v6")).toMatchObject({
      cursor: "cursor-new",
      lastSignature: "signature-new"
    });
    expect(repository.listWalletActivitySamples(first.wallet)).toEqual([sample]);
    expect(repository.listWalletPreScreenSnapshots("run-index", true)).toHaveLength(1);
    expect(repository.getWalletIndexRun("run-index")).toEqual(run);
    expect(repository.walletIndexCoverage(new Date(updatedAt))).toMatchObject({
      indexedWallets: 5_000,
      preScreenEligibleWallets: 2_500,
      activitySamples: 1,
      preScreenSnapshots: 1,
      checkpoints: 1,
      activeRuns: 1
    });
  });

  it("claims each research-ready generation once and recovers an interrupted provider handoff", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const emptyRevision = repository.walletResearchHandoffScanRevision();
    const readyAt = new Date("2026-07-10T01:00:00.000Z");
    const input = {
      generation: "local-index-v1:2026-07-10T01:00:00.000Z",
      runId: "index-run",
      wallets: ["wallet-a", "wallet-b"],
      readyAt: readyAt.toISOString()
    };

    expect(repository.enqueueWalletResearchHandoff(input)).toBe(true);
    const readyRevision = repository.walletResearchHandoffScanRevision();
    expect(readyRevision).not.toBe(emptyRevision);
    expect(repository.listCompletedLocalProviderQualificationWallets()).toEqual([]);
    expect(repository.enqueueWalletResearchHandoff(input)).toBe(false);
    expect(repository.claimWalletResearchHandoff(readyAt)).toMatchObject({
      generation: input.generation,
      status: "RUNNING",
      attempts: 1,
      wallets: input.wallets
    });
    expect(repository.walletResearchHandoffScanRevision()).not.toBe(readyRevision);
    expect(repository.claimWalletResearchHandoff(readyAt)).toBeUndefined();

    expect(repository.recoverRunningWalletResearchHandoffs(readyAt)).toBe(1);
    const recovered = repository.claimWalletResearchHandoff(readyAt);
    expect(recovered).toMatchObject({ status: "RUNNING", attempts: 2 });
    const retryAt = new Date(readyAt.getTime() + 60_000);
    expect(repository.retryWalletResearchHandoff(input.generation, "temporary outage", retryAt, readyAt)).toBe(true);
    expect(repository.claimWalletResearchHandoff(readyAt)).toBeUndefined();
    expect(repository.claimWalletResearchHandoff(retryAt)).toMatchObject({ status: "RUNNING", attempts: 3 });
    expect(repository.completeWalletResearchHandoff(input.generation, "cohort-1", retryAt)).toBe(true);
    expect(repository.listCompletedLocalProviderQualificationWallets()).toEqual(input.wallets);
    expect(repository.getWalletResearchHandoff(input.generation)).toMatchObject({
      status: "COMPLETE",
      attempts: 3,
      cohortId: "cohort-1",
      completedAt: retryAt.toISOString()
    });
    expect(repository.claimWalletResearchHandoff(new Date(retryAt.getTime() + 1))).toBeUndefined();
  });

  it("keeps pending, retry, and prefix fences visible beyond the bounded dashboard horizon", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const insert = db.prepare(`
      INSERT INTO wallet_research_handoffs(
        generation, run_id, status, wallets_json, ready_at, updated_at,
        attempts, next_attempt_at, last_error, completed_at, cohort_id
      ) VALUES (?, 'index-run', ?, ?, ?, ?, ?, ?, NULL, ?, NULL)
    `);
    const oldPrefix = "local-index-v5-partial:old-generation:old-cohort:digest";
    const oldRetry = "old-retry-outside-dashboard-page";
    db.transaction(() => {
      insert.run(
        oldRetry,
        "RETRY",
        "[]",
        "2020-01-01T00:00:00.000Z",
        "2020-01-01T00:00:00.000Z",
        1,
        "2026-01-01T00:00:00.000Z",
        null
      );
      insert.run(
        oldPrefix,
        "COMPLETE",
        JSON.stringify(["old-prefix-wallet"]),
        "2020-01-02T00:00:00.000Z",
        "2020-01-02T00:00:00.000Z",
        1,
        "2020-01-02T00:00:00.000Z",
        "2020-01-02T00:00:00.000Z"
      );
      for (let index = 0; index < 1_001; index += 1) {
        const at = new Date(Date.UTC(2027, 0, 1, 0, 0, index)).toISOString();
        insert.run(`newer-complete-${index}`, "COMPLETE", "[]", at, at, 1, at, at);
      }
    })();

    const bounded = repository.listWalletResearchHandoffs(1_000);
    expect(bounded).toHaveLength(1_000);
    expect(bounded.some(({ generation }) => generation === oldPrefix || generation === oldRetry)).toBe(false);
    const all = repository.listAllWalletResearchHandoffs();
    expect(all).toHaveLength(1_003);
    expect(all.some(({ generation }) => generation === oldPrefix)).toBe(true);
    expect(repository.listCompletedLocalProviderQualificationWallets()).toContain("old-prefix-wallet");
    expect(repository.hasPendingWalletResearchHandoffs()).toBe(true);
    expect(repository.nextWalletResearchHandoffRetry()).toMatchObject({
      generation: oldRetry,
      status: "RETRY",
      nextAttemptAt: "2026-01-01T00:00:00.000Z"
    });

    db.prepare(`
      UPDATE wallet_research_handoffs
      SET status = 'COMPLETE', completed_at = updated_at
      WHERE generation = ?
    `).run(oldRetry);
    expect(repository.hasPendingWalletResearchHandoffs()).toBe(false);
    expect(repository.nextWalletResearchHandoffRetry()).toBeUndefined();
  });

  it("changes the research scan revision when a deep-history cohort becomes terminal", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const selectedAt = "2026-07-10T01:00:00.000Z";
    const cohort = repository.createWalletDeepHistoryCohort({
      selectedAt,
      snapshotCutoffAt: selectedAt,
      windowStart: "2026-04-11T01:00:00.000Z",
      windowEnd: selectedAt,
      wallets: ["revision-wallet"]
    });
    const openRevision = repository.walletResearchHandoffScanRevision();

    expect(repository.completeWalletDeepHistoryCohort(cohort.id, new Date(selectedAt))).toBe(true);
    expect(repository.walletResearchHandoffScanRevision()).not.toBe(openRevision);
  });

  it("atomically commits pre-screen evidence and safely rediscovers a faulted wallet after restart", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const calculatedAt = "2026-07-10T02:00:00.000Z";
    const pending: WalletIndexRecord = {
      wallet: "prescreen-fault-wallet",
      firstSeenAt: "2026-07-09T00:00:00.000Z",
      lastSeenAt: "2026-07-10T00:00:00.000Z",
      historyDays: 1,
      transactionCount: 1,
      successfulTransactionCount: 1,
      spotSwapCount: 1,
      eligibleSpotSwapCount: 1,
      closedEligibleSwaps: 0,
      buyCount: 1,
      sellCount: 0,
      activeDays: 1,
      activeWeeks: 1,
      distinctMints: 1,
      medianHoldingMinutes: 0,
      preScreenEligible: false,
      preScreenReasons: ["pending activity pre-screen"],
      updatedAt: "2026-07-10T01:00:00.000Z"
    };
    repository.upsertWalletIndexRecord(pending);
    const updated: WalletIndexRecord = {
      ...pending,
      historyDays: 90,
      transactionCount: 60,
      successfulTransactionCount: 60,
      activeWeeks: 3,
      preScreenEligible: true,
      preScreenReasons: [],
      deepHistoryStatus: "AWAITING",
      structuralEligible: false,
      structuralReasons: ["awaiting local deep history"],
      updatedAt: calculatedAt
    };
    const sample: WalletActivitySample = {
      wallet: pending.wallet,
      periodStart: "2026-04-11T02:00:00.000Z",
      periodEnd: calculatedAt,
      transactionCount: 60,
      successfulTransactionCount: 60,
      spotSwapCount: 1,
      eligibleSpotSwapCount: 1,
      buyCount: 1,
      sellCount: 0,
      distinctMints: 1,
      sampledAt: calculatedAt
    };
    const snapshot = {
      wallet: pending.wallet,
      runId: "prescreen-run",
      calculatedAt,
      eligible: true,
      reasons: [],
      record: updated
    };
    db.exec(`
      CREATE TRIGGER fail_prescreen_snapshot
      BEFORE INSERT ON wallet_prescreen_snapshots
      BEGIN SELECT RAISE(ABORT, 'simulated prescreen crash'); END;
    `);

    expect(() => repository.commitWalletPreScreen(sample, snapshot)).toThrow("simulated prescreen crash");
    expect(repository.getWalletIndexRecord(pending.wallet)).toEqual(pending);
    expect(repository.listWalletActivitySamples(pending.wallet)).toEqual([]);
    expect(repository.listWalletPreScreenSnapshots("prescreen-run")).toEqual([]);
    expect(repository.listWalletsAwaitingPreScreen(10).map((record) => record.wallet)).toEqual([pending.wallet]);

    db.exec("DROP TRIGGER fail_prescreen_snapshot");
    repository.commitWalletPreScreen(sample, snapshot);
    expect(repository.getWalletIndexRecord(pending.wallet)).toEqual(updated);
    expect(repository.listWalletActivitySamples(pending.wallet)).toEqual([sample]);
    expect(repository.listWalletPreScreenSnapshots("prescreen-run")).toEqual([snapshot]);
    expect(repository.listWalletsAwaitingPreScreen(10)).toEqual([]);
  });

  it("normalizes the legacy qualified-wallet run counter to structural candidates", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const at = "2026-07-10T03:00:00.000Z";
    db.prepare(`
      INSERT INTO wallet_index_runs(
        id, stage, started_at, updated_at, finished_at, discovered_wallets,
        enqueued_signatures, hydrated_transactions, indexed_swaps,
        prescreened_wallets, qualified_wallets, run_json
      ) VALUES (?, 'COMPLETE', ?, ?, ?, 5000, 100, 100, 10, 5000, 7, ?)
    `).run("legacy-counter-run", at, at, at, JSON.stringify({
      id: "legacy-counter-run",
      stage: "COMPLETE",
      startedAt: at,
      updatedAt: at,
      finishedAt: at,
      discoveredWallets: 5_000,
      enqueuedSignatures: 100,
      hydratedTransactions: 100,
      indexedSwaps: 10,
      preScreenedWallets: 5_000,
      qualifiedWallets: 7
    }));

    const run = repository.getWalletIndexRun("legacy-counter-run");
    expect(run).toMatchObject({ structuralCandidates: 7 });
    expect(run).not.toHaveProperty("qualifiedWallets");
  });
});
