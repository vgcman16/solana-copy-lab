import type { HeliusIndexRpc, HeliusSignaturePageRequest } from "@copylab/providers";
import {
  SOL_MINT,
  USDC_MINT,
  type IndexedSpotSwap,
  type WalletIndexRecord
} from "@copylab/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CopyLabDatabase } from "../src/database.js";
import { openDatabase } from "../src/database.js";
import {
  COMPLETE_LOCAL_WALLET_RESEARCH_PIPELINE_VERSION,
  Repository,
  WALLET_DEEP_HISTORY_OPEN_EVIDENCE_QUERY,
  WALLET_DEEP_HISTORY_UNHANDED_COMPLETE_QUERY
} from "../src/repository.js";
import {
  AWAITING_LOCAL_SOL_PRICE,
  AWAITING_LOCAL_DEEP_HISTORY,
  WALLET_DEEP_HISTORY_PIPELINE,
  WALLET_DEEP_HISTORY_TARGET_SETTING,
  WalletDeepHistoryCoordinator,
  materializeWalletDeepHistory
} from "../src/wallet-deep-history.js";
import {
  MANAGED_RECOVERY_PREFLIGHT_POLICY,
  managedRecoveryPreflightWindow
} from "../src/managed-recovery-preflight.js";

const NOW = new Date("2026-07-09T12:00:00.000Z");
const DAY = 86_400_000;

function record(wallet: string, overrides: Partial<WalletIndexRecord> = {}): WalletIndexRecord {
  return {
    wallet,
    firstSeenAt: "2025-01-01T00:00:00.000Z",
    lastSeenAt: NOW.toISOString(),
    historyDays: 90,
    transactionCount: 100,
    successfulTransactionCount: 100,
    spotSwapCount: 0,
    eligibleSpotSwapCount: 0,
    closedEligibleSwaps: 0,
    buyCount: 0,
    sellCount: 0,
    activeDays: 20,
    activeWeeks: 4,
    distinctMints: 0,
    medianHoldingMinutes: 0,
    preScreenEligible: true,
    preScreenReasons: [],
    updatedAt: NOW.toISOString(),
    ...overrides
  };
}

function saveSurvivor(repository: Repository, item: WalletIndexRecord, runId = "run-1"): void {
  repository.upsertWalletIndexRecord(item);
  repository.saveWalletPreScreenSnapshot({
    wallet: item.wallet,
    runId,
    calculatedAt: item.updatedAt,
    eligible: true,
    reasons: [],
    record: item
  });
}

function saveManagedRecoveryCandidates(
  repository: Repository,
  items: WalletIndexRecord[]
): ReturnType<Repository["createWalletDeepHistoryCohort"]> {
  for (const item of items) {
    saveSurvivor(repository, record(item.wallet, {
      successfulTransactionCount: item.successfulTransactionCount,
      deepHistoryStatus: "AWAITING"
    }), `recovery-${item.wallet}`);
  }
  const cohort = repository.createWalletDeepHistoryCohort({
    selectedAt: NOW.toISOString(),
    snapshotCutoffAt: NOW.toISOString(),
    windowStart: new Date(NOW.getTime() - 90 * DAY).toISOString(),
    windowEnd: NOW.toISOString(),
    wallets: items.map((item) => item.wallet)
  });
  for (const item of items) {
    repository.saveManagedCoarseCopyabilitySkip({
      cohortId: cohort.id,
      wallet: item.wallet,
      policyVersion: "recovery-test-v1",
      thresholdMinutes: 15,
      decidedAt: NOW.toISOString()
    });
  }
  if (!repository.markWalletDeepHistoryCohortManagedScreened(
    cohort.id,
    "recovery-test-v1",
    NOW
  )) {
    throw new Error("Managed recovery test cohort did not close its scheduling screen.");
  }
  const updatedAt = new Date(NOW.getTime() + 1_000).toISOString();
  for (const item of items) {
    repository.upsertWalletIndexRecord({ ...item, updatedAt });
  }
  return cohort;
}

function swap(
  wallet: string,
  targetMint: string,
  side: "BUY" | "SELL",
  blockTime: string,
  baseMint: typeof USDC_MINT | typeof SOL_MINT,
  index: number
): IndexedSpotSwap {
  const baseAmount = side === "BUY" ? 10 : 12;
  return {
    id: `swap-${index}`,
    signature: `signature-${index}`,
    wallet,
    swapIndex: 0,
    slot: index,
    blockTime,
    side,
    baseMint,
    targetMint,
    inputMint: side === "BUY" ? baseMint : targetMint,
    outputMint: side === "BUY" ? targetMint : baseMint,
    inputAmountAtomic: "1",
    outputAmountAtomic: "1",
    inputAmountUi: side === "BUY" ? baseAmount : 1,
    outputAmountUi: side === "BUY" ? 1 : baseAmount,
    eligible: true,
    eligibilityReasons: [],
    programIds: ["jupiter"],
    indexedAt: NOW.toISOString()
  };
}

function structurallyEligibleSwaps(wallet: string): IndexedSpotSwap[] {
  const swaps: IndexedSpotSwap[] = [];
  const openedAt = new Date("2026-07-01T00:00:00.000Z");
  for (let index = 0; index < 50; index += 1) {
    const mint = `managed-mint-${index}`;
    swaps.push(swap(wallet, mint, "BUY", openedAt.toISOString(), USDC_MINT, index * 2));
    swaps.push(swap(
      wallet,
      mint,
      "SELL",
      new Date(openedAt.getTime() + 20 * 60_000).toISOString(),
      USDC_MINT,
      index * 2 + 1
    ));
  }
  swaps.push(swap(wallet, "managed-sol-mint", "BUY", openedAt.toISOString(), SOL_MINT, 100));
  swaps.push(swap(
    wallet,
    "managed-sol-mint",
    "SELL",
    new Date(openedAt.getTime() + 20 * 60_000).toISOString(),
    SOL_MINT,
    101
  ));
  return swaps;
}

describe("WalletDeepHistoryCoordinator", () => {
  let db: CopyLabDatabase | undefined;

  afterEach(() => {
    vi.restoreAllMocks();
    db?.close();
    db = undefined;
  });

  it("selects distinct managed recovery candidates in evidence-safe priority lanes", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const candidates = [
      record("lane-1-strong", {
        deepHistoryStatus: "AWAITING",
        closedEligibleSwaps: 2,
        eligibleSpotSwapCount: 2,
        medianHoldingMinutes: 15
      }),
      record("lane-1-observed-hold", {
        deepHistoryStatus: "AWAITING",
        closedEligibleSwaps: 1,
        eligibleSpotSwapCount: 20,
        medianHoldingMinutes: 50
      }),
      record("lane-2-ten-swaps", {
        deepHistoryStatus: "AWAITING",
        eligibleSpotSwapCount: 12
      }),
      record("lane-3-borderline-hold", {
        deepHistoryStatus: "AWAITING",
        closedEligibleSwaps: 3,
        eligibleSpotSwapCount: 50,
        medianHoldingMinutes: 10
      }),
      record("lane-4-five-swaps", {
        deepHistoryStatus: "AWAITING",
        eligibleSpotSwapCount: 8
      }),
      record("complete-history", {
        deepHistoryStatus: "COMPLETE",
        closedEligibleSwaps: 10,
        medianHoldingMinutes: 30
      }),
      record("no-longer-activity-proven", {
        deepHistoryStatus: "AWAITING",
        closedEligibleSwaps: 10,
        medianHoldingMinutes: 30,
        preScreenEligible: false
      }),
      record("short-observed-hold", {
        deepHistoryStatus: "AWAITING",
        closedEligibleSwaps: 1,
        eligibleSpotSwapCount: 100,
        medianHoldingMinutes: 9.9
      }),
      record("too-few-unknown-swaps", {
        deepHistoryStatus: "AWAITING",
        eligibleSpotSwapCount: 4
      })
    ];
    saveManagedRecoveryCandidates(repository, candidates);

    // Repeated immutable dispositions must not duplicate the wallet result.
    const repeated = repository.createWalletDeepHistoryCohort({
      selectedAt: NOW.toISOString(),
      snapshotCutoffAt: NOW.toISOString(),
      windowStart: new Date(NOW.getTime() - 90 * DAY).toISOString(),
      windowEnd: NOW.toISOString(),
      wallets: ["lane-1-strong"]
    });
    repository.saveManagedCoarseCopyabilitySkip({
      cohortId: repeated.id,
      wallet: "lane-1-strong",
      policyVersion: "recovery-test-v1",
      thresholdMinutes: 15,
      decidedAt: NOW.toISOString()
    });
    expect(repository.markWalletDeepHistoryCohortManagedScreened(
      repeated.id,
      "recovery-test-v1",
      NOW
    )).toBe(true);

    repository.upsertWalletIndexRecord(record("no-prior-disposition", {
      deepHistoryStatus: "AWAITING",
      closedEligibleSwaps: 20,
      eligibleSpotSwapCount: 20,
      medianHoldingMinutes: 30
    }));

    expect(repository.listManagedWalletDeepHistoryRecoveryCandidates({ limit: 20 })
      .map((item) => item.wallet)).toEqual([
      "lane-1-strong",
      "lane-1-observed-hold",
      "lane-2-ten-swaps",
      "lane-3-borderline-hold",
      "lane-4-five-swaps"
    ]);
  });

  it("excludes recovery wallets with exact evidence or an unscreened open target", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const candidates = ["available", "has-exact-evidence", "owned-by-open-cohort"].map((wallet) =>
      record(wallet, {
        deepHistoryStatus: "AWAITING",
        closedEligibleSwaps: 1,
        eligibleSpotSwapCount: 5,
        medianHoldingMinutes: 20
      })
    );
    saveManagedRecoveryCandidates(repository, candidates);

    const exact = repository.createWalletDeepHistoryCohort({
      selectedAt: NOW.toISOString(),
      snapshotCutoffAt: NOW.toISOString(),
      windowStart: new Date(NOW.getTime() - 90 * DAY).toISOString(),
      windowEnd: NOW.toISOString(),
      wallets: ["has-exact-evidence"]
    });
    repository.saveWalletDeepHistoryEvidence({
      generationId: exact.generationId,
      cohortId: exact.id,
      wallet: "has-exact-evidence",
      record: candidates[1]!,
      swaps: [],
      frozenAt: NOW.toISOString()
    });
    expect(repository.completeWalletDeepHistoryCohort(exact.id, NOW)).toBe(true);

    repository.createWalletDeepHistoryCohort({
      selectedAt: NOW.toISOString(),
      snapshotCutoffAt: NOW.toISOString(),
      windowStart: new Date(NOW.getTime() - 90 * DAY).toISOString(),
      windowEnd: NOW.toISOString(),
      wallets: ["owned-by-open-cohort"]
    });

    expect(repository.listManagedWalletDeepHistoryRecoveryCandidates({ limit: 5 })
      .map((item) => item.wallet)).toEqual(["available"]);
  });

  it("skips per-wallet and cumulative transaction-budget overflows while filling later slots", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    saveManagedRecoveryCandidates(repository, [
      record("over-per-wallet-budget", {
        deepHistoryStatus: "AWAITING",
        successfulTransactionCount: 501,
        closedEligibleSwaps: 5,
        medianHoldingMinutes: 20
      }),
      record("selected-first", {
        deepHistoryStatus: "AWAITING",
        successfulTransactionCount: 400,
        closedEligibleSwaps: 4,
        medianHoldingMinutes: 20
      }),
      record("over-cumulative-budget", {
        deepHistoryStatus: "AWAITING",
        successfulTransactionCount: 350,
        closedEligibleSwaps: 3,
        medianHoldingMinutes: 20
      }),
      record("selected-after-skip", {
        deepHistoryStatus: "AWAITING",
        successfulTransactionCount: 200,
        closedEligibleSwaps: 2,
        medianHoldingMinutes: 20
      })
    ]);

    expect(repository.listManagedWalletDeepHistoryRecoveryCandidates({
      limit: 3,
      maximumWalletSuccessfulTransactions: 500,
      maximumCumulativeSuccessfulTransactions: 600
    }).map((item) => item.wallet)).toEqual(["selected-first", "selected-after-skip"]);
    expect(repository.listManagedWalletDeepHistoryRecoveryCandidates({ limit: 0 })).toEqual([]);
  });

  it("reopens an immutable coarse deferral in a bounded rescue cohort without rewriting it", async () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const wallet = "managed-rescue-wallet";
    const prior = saveManagedRecoveryCandidates(repository, [
      record(wallet, {
        deepHistoryStatus: "AWAITING",
        successfulTransactionCount: 100,
        closedEligibleSwaps: 1,
        eligibleSpotSwapCount: 2,
        medianHoldingMinutes: 45
      })
    ]);
    const priorDisposition = repository.getWalletDeepHistoryTargetDisposition(prior.id, wallet);
    const coordinator = new WalletDeepHistoryCoordinator(repository, {
      getSignaturesForAddress: async () => [],
      getTransaction: async () => null
    }, {
      allowUnpricedStructuralCompletion: true,
      includeExistingBacklog: true,
      canStartManagedRecovery: () => true,
      managedRecoveryCreditBudget: () => 2_000,
      allowLegacyManagedRecoveryWithoutPreflight: true,
      now: () => new Date(NOW.getTime() + DAY)
    });

    const rescued = coordinator.ensureTargets();
    expect(rescued?.cohortId).toMatch(/^managed-rescue-v2:/);
    expect(rescued?.wallets).toEqual([wallet]);
    expect(repository.getWalletDeepHistoryTargetDisposition(rescued!.cohortId, wallet)).toBeUndefined();
    expect(repository.getWalletDeepHistoryTargetDisposition(prior.id, wallet)?.decisionDigest)
      .toBe(priorDisposition?.decisionDigest);

    expect(await coordinator.runOnce()).toBe(true);
    expect(await coordinator.runOnce()).toBe(true);
    expect(repository.getWalletDeepHistoryEvidence(rescued!.generationId, wallet)).toMatchObject({
      cohortId: rescued!.cohortId,
      record: {
        deepHistoryStatus: "COMPLETE",
        structuralEligible: false,
        closedEligibleSwaps: 0
      }
    });
  });

  it("fails managed recovery closed when no provider preflight gate is wired", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    saveManagedRecoveryCandidates(repository, [
      record("missing-preflight-gate", {
        deepHistoryStatus: "AWAITING",
        successfulTransactionCount: 100,
        closedEligibleSwaps: 1,
        medianHoldingMinutes: 45
      })
    ]);
    const coordinator = new WalletDeepHistoryCoordinator(repository, {
      getSignaturesForAddress: async () => [],
      getTransaction: async () => null
    }, {
      allowUnpricedStructuralCompletion: true,
      includeExistingBacklog: true,
      canStartManagedRecovery: () => true,
      managedRecoveryCreditBudget: () => 2_000,
      now: () => new Date(NOW.getTime() + DAY)
    });

    expect(coordinator.ensureTargets()).toBeUndefined();
  });

  it("freezes a v3 rescue only after a fresh provider preflight PASS", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const wallet = "managed-rescue-v3-wallet";
    saveManagedRecoveryCandidates(repository, [
      record(wallet, {
        deepHistoryStatus: "AWAITING",
        successfulTransactionCount: 100,
        closedEligibleSwaps: 1,
        eligibleSpotSwapCount: 2,
        medianHoldingMinutes: 45
      })
    ]);
    const at = new Date(NOW.getTime() + DAY);
    const window = managedRecoveryPreflightWindow(at);
    const leaseExpiresAt = new Date(at.getTime() + 5 * 60_000).toISOString();
    repository.seedManagedRecoveryPreflight({
      policyVersion: MANAGED_RECOVERY_PREFLIGHT_POLICY,
      windowStart: window.windowStart,
      readyAt: at.toISOString(),
      wallet
    });
    const pnl30 = repository.claimManagedRecoveryPreflight({
      ...window,
      now: at.toISOString(),
      leaseExpiresAt
    });
    expect(pnl30?.step).toBe("PNL_30D");
    expect(repository.saveManagedRecoveryPreflightPartial({
      claimToken: pnl30!.claimToken,
      wallet,
      policyVersion: MANAGED_RECOVERY_PREFLIGHT_POLICY,
      windowStart: window.windowStart,
      expectedStep: "PNL_30D",
      nextStep: "PNL_90D",
      observedAt: at.toISOString(),
      pnl30d: {
        duration: "30d",
        realizedProfitUsd: 10,
        realizedProfitPercent: 10,
        unrealizedProfitUsd: 0,
        totalTrades: 10,
        wins: 6,
        losses: 4
      }
    })).toBe(true);
    const pnl90 = repository.claimManagedRecoveryPreflight({
      ...window,
      now: at.toISOString(),
      leaseExpiresAt
    });
    expect(pnl90?.step).toBe("PNL_90D");
    expect(repository.saveManagedRecoveryPreflightPartial({
      claimToken: pnl90!.claimToken,
      wallet,
      policyVersion: MANAGED_RECOVERY_PREFLIGHT_POLICY,
      windowStart: window.windowStart,
      expectedStep: "PNL_90D",
      nextStep: "HISTORY",
      observedAt: at.toISOString(),
      pnl90d: {
        duration: "90d",
        realizedProfitUsd: 20,
        realizedProfitPercent: 20,
        unrealizedProfitUsd: 0,
        totalTrades: 20,
        wins: 12,
        losses: 8
      }
    })).toBe(true);
    const history = repository.claimManagedRecoveryPreflight({
      ...window,
      now: at.toISOString(),
      leaseExpiresAt
    });
    expect(history?.step).toBe("HISTORY");
    expect(repository.passManagedRecoveryPreflight({
      claimToken: history!.claimToken,
      wallet,
      policyVersion: MANAGED_RECOVERY_PREFLIGHT_POLICY,
      windowStart: window.windowStart,
      expectedStep: "HISTORY",
      validAt: at.toISOString(),
      expiresAt: window.expiresAt,
      history: {
        wallet,
        historyDays: 90,
        closedEligibleSwaps: 60,
        activeWeeks: 4,
        medianHoldingMinutes: 30,
        topTokenProfitShare: 0.2,
        topThreeProfitShare: 0.5,
        tags: []
      }
    })).toBe(true);

    const gate = {
      policyVersion: MANAGED_RECOVERY_PREFLIGHT_POLICY,
      windowStart: window.windowStart,
      validAt: at.toISOString()
    };
    const coordinator = new WalletDeepHistoryCoordinator(repository, {
      getSignaturesForAddress: async () => [],
      getTransaction: async () => null
    }, {
      allowUnpricedStructuralCompletion: true,
      includeExistingBacklog: true,
      canStartManagedRecovery: () => true,
      managedRecoveryCreditBudget: () => 2_000,
      managedRecoveryPreflightGate: () => gate,
      now: () => at
    });
    const rescued = coordinator.ensureTargets();
    expect(rescued?.cohortId).toMatch(/^managed-rescue-v3:/);
    expect(repository.getManagedRecoveryPreflightAuthorization(rescued!.cohortId, wallet))
      .toMatchObject({ wallet });
  });

  it("fails a rescue wallet closed after six pages instead of spending the reserved index credits", async () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const wallet = "managed-rescue-page-cap";
    saveManagedRecoveryCandidates(repository, [
      record(wallet, {
        deepHistoryStatus: "AWAITING",
        successfulTransactionCount: 100,
        closedEligibleSwaps: 1,
        eligibleSpotSwapCount: 2,
        medianHoldingMinutes: 45
      })
    ]);
    let pageCalls = 0;
    const coordinator = new WalletDeepHistoryCoordinator(repository, {
      getSignaturesForAddress: async () => [{
        signature: `rescue-page-${++pageCalls}`,
        slot: pageCalls,
        blockTime: (NOW.getTime() + DAY) / 1_000 - pageCalls,
        failed: false
      }],
      getTransaction: async () => null
    }, {
      pageSize: 1,
      maximumPages: 100,
      allowUnpricedStructuralCompletion: true,
      includeExistingBacklog: true,
      canStartManagedRecovery: () => true,
      managedRecoveryCreditBudget: () => 2_000,
      allowLegacyManagedRecoveryWithoutPreflight: true,
      now: () => new Date(NOW.getTime() + DAY)
    });

    const rescued = coordinator.ensureTargets();
    expect(rescued?.cohortId).toMatch(/^managed-rescue-v2:/);
    for (let page = 0; page < 7; page += 1) {
      expect(await coordinator.runOnce()).toBe(true);
    }

    expect(pageCalls).toBe(6);
    expect(repository.getWalletIndexRecord(wallet)).toMatchObject({
      deepHistoryStatus: "FAILED",
      structuralEligible: false,
      structuralReasons: ["deep-history pagination exceeded the safe 6-page ceiling"]
    });
    expect(repository.getWalletDeepHistoryEvidence(rescued!.generationId, wallet)).toBeDefined();
  });

  it("reads only evidence-bearing managed cohorts after a long empty cohort history", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const wallet = "ready-evidence-wallet";
    const cohort = repository.createWalletDeepHistoryCohort({
      selectedAt: NOW.toISOString(),
      snapshotCutoffAt: NOW.toISOString(),
      windowStart: new Date(NOW.getTime() - 90 * DAY).toISOString(),
      windowEnd: NOW.toISOString(),
      wallets: [wallet]
    });
    const ready = record(wallet, {
      deepHistoryStatus: "COMPLETE",
      deepHistoryWindowStart: cohort.windowStart,
      deepHistoryWindowEnd: cohort.windowEnd,
      deepHistorySignatureCount: 100,
      deepHistoryHydratedCount: 100,
      structuralEligible: true,
      structuralReasons: [],
      closedEligibleSwaps: 50,
      medianHoldingMinutes: 20
    });
    repository.upsertWalletIndexRecord(ready);
    repository.saveWalletDeepHistoryEvidence({
      generationId: cohort.generationId,
      cohortId: cohort.id,
      wallet,
      record: ready,
      swaps: [],
      frozenAt: NOW.toISOString()
    });
    db.prepare(`
      INSERT INTO wallet_deep_history_managed_cohort_screenings(
        cohort_id, generation_id, policy_version, manifest_digest, details_json, screened_at
      ) VALUES (?, ?, 'test-policy', ?, '{}', ?)
    `).run(cohort.id, cohort.generationId, "a".repeat(64), NOW.toISOString());

    const insertEmpty = db.prepare(`
      INSERT INTO wallet_deep_history_cohorts(
        id, sequence, generation_id, status, selected_at, snapshot_cutoff_at,
        window_start, window_end, created_at
      ) VALUES (?, ?, ?, 'OPEN', ?, ?, ?, ?, ?)
    `);
    db.transaction(() => {
      for (let sequence = 2; sequence <= 1_502; sequence += 1) {
        insertEmpty.run(
          `empty-cohort-${sequence}`,
          sequence,
          cohort.generationId,
          NOW.toISOString(),
          NOW.toISOString(),
          cohort.windowStart,
          cohort.windowEnd,
          NOW.toISOString()
        );
      }
    })();

    expect(repository.listOpenWalletDeepHistoryCohortEvidence()).toEqual([{
      cohortId: cohort.id,
      generationId: cohort.generationId,
      sequence: cohort.sequence,
      status: "MANAGED_SCREENED",
      evidence: [expect.objectContaining({ wallet, record: ready })]
    }]);
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${WALLET_DEEP_HISTORY_OPEN_EVIDENCE_QUERY}`)
      .all() as Array<{ detail: string }>;
    expect(plan[0]?.detail).toMatch(/SCAN evidence USING INDEX wallet_deep_history_evidence_cohort/iu);
    expect(plan.some(({ detail }) => /SCAN cohort/iu.test(detail))).toBe(false);
  });

  it("reads only unhanded completed cohorts while retaining nullable zero-evidence rows", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const wallet = "completed-ready-wallet";
    const readyCohort = repository.createWalletDeepHistoryCohort({
      selectedAt: NOW.toISOString(),
      snapshotCutoffAt: NOW.toISOString(),
      windowStart: new Date(NOW.getTime() - 90 * DAY).toISOString(),
      windowEnd: NOW.toISOString(),
      wallets: [wallet]
    });
    const ready = record(wallet, {
      deepHistoryStatus: "COMPLETE",
      deepHistoryWindowStart: readyCohort.windowStart,
      deepHistoryWindowEnd: readyCohort.windowEnd,
      deepHistorySignatureCount: 100,
      deepHistoryHydratedCount: 100,
      structuralEligible: true,
      structuralReasons: [],
      closedEligibleSwaps: 50,
      medianHoldingMinutes: 20
    });
    repository.upsertWalletIndexRecord(ready);
    repository.saveWalletDeepHistoryEvidence({
      generationId: readyCohort.generationId,
      cohortId: readyCohort.id,
      wallet,
      record: ready,
      swaps: [],
      frozenAt: NOW.toISOString()
    });
    db.prepare(`
      UPDATE wallet_deep_history_cohorts
      SET status = 'COMPLETE', completed_at = ?
      WHERE id = ?
    `).run(NOW.toISOString(), readyCohort.id);

    const insertCohort = db.prepare(`
      INSERT INTO wallet_deep_history_cohorts(
        id, sequence, generation_id, status, selected_at, snapshot_cutoff_at,
        window_start, window_end, created_at, completed_at
      ) VALUES (?, ?, ?, 'COMPLETE', ?, ?, ?, ?, ?, ?)
    `);
    const insertHandoff = db.prepare(`
      INSERT INTO wallet_research_handoffs(
        generation, run_id, status, wallets_json, ready_at, updated_at,
        attempts, next_attempt_at, completed_at
      ) VALUES (?, 'historical-run', 'COMPLETE', '[]', ?, ?, 1, ?, ?)
    `);
    const zeroEvidenceCohort = "new-zero-evidence-complete";
    insertCohort.run(
      zeroEvidenceCohort,
      2,
      readyCohort.generationId,
      NOW.toISOString(),
      NOW.toISOString(),
      readyCohort.windowStart,
      readyCohort.windowEnd,
      NOW.toISOString(),
      NOW.toISOString()
    );
    db.transaction(() => {
      for (let sequence = 3; sequence <= 1_502; sequence += 1) {
        const cohortId = `completed-handed-cohort-${sequence}`;
        const at = new Date(NOW.getTime() - sequence).toISOString();
        insertCohort.run(
          cohortId,
          sequence,
          readyCohort.generationId,
          at,
          at,
          readyCohort.windowStart,
          readyCohort.windowEnd,
          at,
          at
        );
        insertHandoff.run(
          `local-index-${COMPLETE_LOCAL_WALLET_RESEARCH_PIPELINE_VERSION}:` +
            `${readyCohort.generationId}:${cohortId}`,
          at,
          at,
          at,
          at
        );
      }
    })();

    const prepare = vi.spyOn(db, "prepare");
    expect(repository.listUnhandedCompletedWalletDeepHistoryCohortEvidence()).toEqual([
      {
        cohortId: readyCohort.id,
        generationId: readyCohort.generationId,
        cohortSequence: readyCohort.sequence,
        generationSequence: 1,
        evidence: [expect.objectContaining({ wallet, record: ready })]
      },
      {
        cohortId: zeroEvidenceCohort,
        generationId: readyCohort.generationId,
        cohortSequence: 2,
        generationSequence: 1,
        evidence: []
      }
    ]);
    expect(prepare).toHaveBeenCalledTimes(1);
    prepare.mockRestore();

    const plan = db.prepare(`EXPLAIN QUERY PLAN ${WALLET_DEEP_HISTORY_UNHANDED_COMPLETE_QUERY}`)
      .all() as Array<{ detail: string }>;
    expect(plan.some(({ detail }) =>
      /wallet_deep_history_cohorts_status_sequence/iu.test(detail)
    )).toBe(true);
    expect(plan.some(({ detail }) =>
      /wallet_deep_history_evidence_cohort/iu.test(detail)
    )).toBe(true);
    expect(plan.some(({ detail }) =>
      /exact_handoff.*sqlite_autoindex_wallet_research_handoffs_1/iu.test(detail)
    )).toBe(true);
  });

  it("freezes at most 100 stable coarse-screen targets and keeps them out of the expensive shortlist", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    for (let index = 0; index < 150; index += 1) {
      saveSurvivor(repository, record(`wallet-${index.toString().padStart(3, "0")}`, {
        successfulTransactionCount: 1_000 - index
      }));
    }
    const rpc: HeliusIndexRpc = {
      getSignaturesForAddress: async () => [],
      getTransaction: async () => null
    };
    const coordinator = new WalletDeepHistoryCoordinator(repository, rpc, { now: () => new Date(NOW) });
    const first = coordinator.ensureTargets();

    expect(first?.wallets).toHaveLength(100);
    expect(new Set(first?.wallets).size).toBe(100);
    expect(repository.listWalletIndexResearchShortlist(100)).toEqual([]);
    expect(repository.getWalletIndexRecord(first!.wallets[0]!)).toMatchObject({
      deepHistoryStatus: "AWAITING",
      structuralEligible: false,
      structuralReasons: [AWAITING_LOCAL_DEEP_HISTORY]
    });

    saveSurvivor(repository, record("new-best-wallet", { successfulTransactionCount: 100_000 }), "run-2");
    const restarted = new WalletDeepHistoryCoordinator(repository, rpc, {
      targetLimit: 10,
      now: () => new Date(NOW.getTime() + DAY)
    });
    expect(restarted.ensureTargets()).toEqual(first);
    expect(restarted.ensureTargets()?.wallets).not.toContain("new-best-wallet");
    expect(repository.listWalletDeepHistoryCohorts()).toEqual([
      expect.objectContaining({
        id: first?.cohortId,
        sequence: 1,
        status: "OPEN",
        wallets: first?.wallets
      })
    ]);
  });

  it("opens later survivors in a versioned shadow cohort without draining the unselected bootstrap pool", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    saveSurvivor(repository, record("bootstrap-selected", { successfulTransactionCount: 1_000 }));
    saveSurvivor(repository, record("bootstrap-unselected", { successfulTransactionCount: 10 }));
    const rpc: HeliusIndexRpc = {
      getSignaturesForAddress: async () => [],
      getTransaction: async () => null
    };
    const firstCoordinator = new WalletDeepHistoryCoordinator(repository, rpc, {
      targetLimit: 1,
      now: () => new Date(NOW)
    });
    const first = firstCoordinator.ensureTargets()!;
    expect(first).toMatchObject({ version: 2, sequence: 1, wallets: ["bootstrap-selected"] });
    repository.saveWalletIndexCheckpoint({
      pipeline: WALLET_DEEP_HISTORY_PIPELINE,
      partition: "bootstrap-selected",
      completed: true,
      updatedAt: NOW.toISOString(),
      metadata: {
        stage: "COMPLETE",
        pages: 1,
        signatureCount: 0,
        cohortId: first.cohortId,
        windowStart: first.windowStart,
        windowEnd: first.windowEnd
      }
    });
    const beforeEvidenceRevision = repository.walletResearchHandoffScanRevision();
    repository.saveWalletDeepHistoryEvidence({
      generationId: first.generationId,
      cohortId: first.cohortId,
      wallet: "bootstrap-selected",
      record: repository.getWalletIndexRecord("bootstrap-selected")!,
      swaps: [],
      frozenAt: NOW.toISOString()
    });
    expect(repository.walletResearchHandoffScanRevision()).not.toBe(beforeEvidenceRevision);
    expect(firstCoordinator.progress()).toEqual({ targets: 1, complete: 1, failed: 0, coarseSkipped: 0, pending: 0 });
    expect(firstCoordinator.ensureTargets()).toBeUndefined();

    const shadowAt = new Date(NOW.getTime() + DAY);
    saveSurvivor(repository, record("new-head-survivor", {
      successfulTransactionCount: 100_000,
      updatedAt: shadowAt.toISOString(),
      lastSeenAt: shadowAt.toISOString()
    }), "head-run");
    const restarted = new WalletDeepHistoryCoordinator(repository, rpc, {
      targetLimit: 1,
      now: () => shadowAt
    });
    const shadow = restarted.ensureTargets();

    expect(shadow).toMatchObject({ version: 2, sequence: 2, wallets: ["new-head-survivor"] });
    expect(shadow?.cohortId).not.toBe(first.cohortId);
    expect(repository.listWalletDeepHistoryCohorts()).toEqual([
      expect.objectContaining({ sequence: 2, status: "OPEN", wallets: ["new-head-survivor"] }),
      expect.objectContaining({ sequence: 1, status: "COMPLETE", wallets: ["bootstrap-selected"] })
    ]);
    expect(repository.getWalletIndexRecord("bootstrap-unselected")?.deepHistoryStatus).toBeUndefined();
  });

  it("drains the existing survivor backlog when a self-hosted RPC removes managed credit pressure", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    saveSurvivor(repository, record("first", { successfulTransactionCount: 1_000 }));
    saveSurvivor(repository, record("backlog", { successfulTransactionCount: 10 }));
    const rpc: HeliusIndexRpc = {
      getSignaturesForAddress: async () => [],
      getTransaction: async () => null
    };
    const managed = new WalletDeepHistoryCoordinator(repository, rpc, {
      targetLimit: 1,
      now: () => new Date(NOW)
    });
    const first = managed.ensureTargets()!;
    repository.saveWalletIndexCheckpoint({
      pipeline: WALLET_DEEP_HISTORY_PIPELINE,
      partition: "first",
      completed: true,
      updatedAt: NOW.toISOString(),
      metadata: {
        stage: "COMPLETE",
        pages: 1,
        signatureCount: 0,
        cohortId: first.cohortId,
        windowStart: first.windowStart,
        windowEnd: first.windowEnd
      }
    });
    managed.progress();

    const selfHosted = new WalletDeepHistoryCoordinator(repository, rpc, {
      targetLimit: 1,
      includeExistingBacklog: true,
      now: () => new Date(NOW.getTime() + DAY)
    });

    expect(selfHosted.ensureTargets()).toMatchObject({
      sequence: 2,
      wallets: ["backlog"],
      snapshotCutoffAt: first.snapshotCutoffAt,
      windowStart: first.windowStart,
      windowEnd: first.windowEnd
    });
  });

  it("keeps a managed generation lower-bounded by its prior terminal cutoff across restarts", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const oldWallets = ["old-managed-a", "old-managed-b"];
    for (const wallet of oldWallets) {
      saveSurvivor(repository, record(wallet, {
        successfulTransactionCount: wallet.endsWith("a") ? 1_000 : 900,
        spotSwapCount: 100,
        eligibleSpotSwapCount: 100,
        closedEligibleSwaps: 50,
        medianHoldingMinutes: 20
      }));
    }
    const rpc: HeliusIndexRpc = {
      getSignaturesForAddress: async () => [],
      getTransaction: async () => null
    };
    const first = new WalletDeepHistoryCoordinator(repository, rpc, {
      targetLimit: 1,
      includeExistingBacklog: true,
      allowUnpricedStructuralCompletion: true,
      now: () => new Date(NOW)
    });
    const completeTarget = (
      coordinator: WalletDeepHistoryCoordinator,
      targets: NonNullable<ReturnType<WalletDeepHistoryCoordinator["ensureTargets"]>>
    ): void => {
      const wallet = targets.wallets[0]!;
      const completed: WalletIndexRecord = {
        ...repository.getWalletIndexRecord(wallet)!,
        deepHistoryStatus: "COMPLETE",
        deepHistoryWindowStart: targets.windowStart,
        deepHistoryWindowEnd: targets.windowEnd,
        structuralEligible: true,
        structuralReasons: [],
        updatedAt: targets.windowEnd
      };
      repository.upsertWalletIndexRecord(completed);
      repository.saveWalletIndexCheckpoint({
        pipeline: WALLET_DEEP_HISTORY_PIPELINE,
        partition: `${targets.cohortId}:${wallet}`,
        completed: true,
        updatedAt: targets.windowEnd,
        metadata: {
          stage: "COMPLETE",
          pages: 1,
          signatureCount: 0,
          cohortId: targets.cohortId,
          windowStart: targets.windowStart,
          windowEnd: targets.windowEnd
        }
      });
      repository.saveWalletDeepHistoryEvidence({
        generationId: targets.generationId,
        cohortId: targets.cohortId,
        wallet,
        record: completed,
        swaps: [],
        frozenAt: targets.windowEnd
      });
      expect(coordinator.progress().pending).toBe(0);
    };

    const firstTarget = first.ensureTargets()!;
    completeTarget(first, firstTarget);
    const secondTarget = first.ensureTargets()!;
    completeTarget(first, secondTarget);
    expect(first.ensureTargets()).toBeUndefined();
    expect(repository.latestTerminalWalletDeepHistoryGeneration()?.sequence).toBe(1);

    const later = new Date(NOW.getTime() + DAY);
    saveSurvivor(repository, record("new-managed-wallet", {
      updatedAt: later.toISOString(),
      lastSeenAt: later.toISOString(),
      successfulTransactionCount: 2_000,
      spotSwapCount: 100,
      eligibleSpotSwapCount: 100,
      closedEligibleSwaps: 50,
      medianHoldingMinutes: 20
    }), "later-run");
    const restarted = new WalletDeepHistoryCoordinator(repository, rpc, {
      targetLimit: 1,
      includeExistingBacklog: true,
      allowUnpricedStructuralCompletion: true,
      now: () => later
    });
    const newTarget = restarted.ensureTargets()!;
    expect(newTarget.wallets).toEqual(["new-managed-wallet"]);
    completeTarget(restarted, newTarget);

    expect(restarted.ensureTargets()).toBeUndefined();
    expect(repository.listWalletDeepHistoryCohortsForGeneration(newTarget.generationId)).toHaveLength(1);
    for (const wallet of oldWallets) {
      expect(repository.getWalletIndexRecord(wallet)).toMatchObject({
        deepHistoryStatus: "COMPLETE",
        structuralEligible: true
      });
    }
  });

  it("migrates a legacy singleton target set into the first durable cohort without changing its wallets", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    saveSurvivor(repository, record("legacy-wallet"));
    repository.setSetting(WALLET_DEEP_HISTORY_TARGET_SETTING, {
      version: 1,
      selectedAt: NOW.toISOString(),
      windowStart: new Date(NOW.getTime() - 90 * DAY).toISOString(),
      windowEnd: NOW.toISOString(),
      wallets: ["legacy-wallet"]
    });
    const coordinator = new WalletDeepHistoryCoordinator(repository, {
      getSignaturesForAddress: async () => [],
      getTransaction: async () => null
    }, { now: () => new Date(NOW) });

    expect(coordinator.ensureTargets()).toMatchObject({
      version: 2,
      sequence: 1,
      selectedAt: NOW.toISOString(),
      wallets: ["legacy-wallet"]
    });
    expect(repository.listWalletDeepHistoryCohorts()).toEqual([
      expect.objectContaining({ sequence: 1, status: "OPEN", wallets: ["legacy-wallet"] })
    ]);
  });

  it("selects one deterministic latest snapshot per wallet and prioritizes structural evidence", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const tied = record("tied-wallet", { medianHoldingMinutes: 100, closedEligibleSwaps: 100 });
    repository.upsertWalletIndexRecord(tied);
    repository.saveWalletPreScreenSnapshot({
      wallet: tied.wallet,
      runId: "run-a",
      calculatedAt: NOW.toISOString(),
      eligible: true,
      reasons: [],
      record: tied
    });
    repository.saveWalletPreScreenSnapshot({
      wallet: tied.wallet,
      runId: "run-z",
      calculatedAt: NOW.toISOString(),
      eligible: false,
      reasons: ["latest deterministic rejection"],
      record: tied
    });
    saveSurvivor(repository, record("transfer-heavy", {
      successfulTransactionCount: 100_000,
      medianHoldingMinutes: 1,
      closedEligibleSwaps: 49,
      eligibleSpotSwapCount: 500
    }));
    saveSurvivor(repository, record("structural-first", {
      successfulTransactionCount: 50,
      medianHoldingMinutes: 20,
      closedEligibleSwaps: 2,
      eligibleSpotSwapCount: 2
    }));

    expect(repository.listLatestWalletPreScreenSurvivors(100).map((item) => item.wallet)).toEqual([
      "structural-first",
      "transfer-heavy"
    ]);
  });

  it("deduplicates identical survivor reads for one turn and returns freshly decoded records", async () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    saveSurvivor(repository, record("cached-survivor", {
      successfulTransactionCount: 321,
      medianHoldingMinutes: 20
    }));
    const prepare = vi.spyOn(db, "prepare");
    const survivorQueryCount = (): number => prepare.mock.calls.filter(([sql]) =>
      typeof sql === "string" &&
      sql.includes("ROW_NUMBER() OVER") &&
      sql.includes("wallet_prescreen_snapshots")
    ).length;

    const reads = Array.from({ length: 5 }, () => repository.listLatestWalletPreScreenSurvivors(
      100,
      undefined,
      NOW.toISOString(),
      undefined,
      true
    ));

    expect(survivorQueryCount()).toBe(1);
    expect(reads.every((items) => items[0]?.wallet === "cached-survivor")).toBe(true);
    expect(reads[0]?.[0]).not.toBe(reads[1]?.[0]);
    reads[0]![0]!.successfulTransactionCount = -1;
    expect(reads[1]?.[0]?.successfulTransactionCount).toBe(321);

    // A different argument tuple uses a distinct cache entry.
    repository.listLatestWalletPreScreenSurvivors(100, undefined, NOW.toISOString());
    expect(survivorQueryCount()).toBe(2);

    // The cache is deliberately only a same-turn deduplication window.
    await new Promise<void>((resolve) => setImmediate(resolve));
    repository.listLatestWalletPreScreenSurvivors(100, undefined, NOW.toISOString(), undefined, true);
    expect(survivorQueryCount()).toBe(3);
  });

  it("isolates every survivor cache-key argument without cross-serving results", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const oldAt = new Date(NOW.getTime() - 2 * DAY).toISOString();
    const middleAt = new Date(NOW.getTime() - DAY).toISOString();
    const oldWallet = record("cache-key-old", {
      successfulTransactionCount: 500,
      medianHoldingMinutes: 20,
      updatedAt: oldAt
    });
    const targetedWallet = record("cache-key-targeted", {
      successfulTransactionCount: 400,
      medianHoldingMinutes: 20,
      updatedAt: middleAt
    });
    const completedWallet = record("cache-key-completed", {
      successfulTransactionCount: 300,
      medianHoldingMinutes: 20
    });
    saveSurvivor(repository, oldWallet, "cache-key-old-run");
    saveSurvivor(repository, targetedWallet, "cache-key-targeted-run");
    saveSurvivor(repository, completedWallet, "cache-key-completed-run");
    const cohort = repository.createWalletDeepHistoryCohort({
      selectedAt: NOW.toISOString(),
      snapshotCutoffAt: NOW.toISOString(),
      windowStart: new Date(NOW.getTime() - 90 * DAY).toISOString(),
      windowEnd: NOW.toISOString(),
      wallets: [targetedWallet.wallet]
    });
    repository.enqueueWalletResearchHandoff({
      generation: "cache-key-handoff",
      runId: "cache-key-run",
      wallets: [completedWallet.wallet],
      readyAt: NOW.toISOString()
    });
    expect(repository.claimWalletResearchHandoff(NOW)?.generation).toBe("cache-key-handoff");
    expect(repository.completeWalletResearchHandoff("cache-key-handoff", undefined, NOW)).toBe(true);

    const prepare = vi.spyOn(db, "prepare");
    const survivorQueryCount = (): number => prepare.mock.calls.filter(([sql]) =>
      typeof sql === "string" && sql.includes("ROW_NUMBER() OVER")
    ).length;
    type SurvivorArguments = Parameters<Repository["listLatestWalletPreScreenSurvivors"]>;
    const cases: Array<{
      name: string;
      args: SurvivorArguments;
      expectedWallets: string[];
    }> = [
      {
        name: "base",
        args: [100],
        expectedWallets: [oldWallet.wallet, targetedWallet.wallet, completedWallet.wallet]
      },
      {
        name: "limit",
        args: [1],
        expectedWallets: [oldWallet.wallet]
      },
      {
        name: "newerThan",
        args: [100, oldAt],
        expectedWallets: [targetedWallet.wallet, completedWallet.wallet]
      },
      {
        name: "atOrBefore",
        args: [100, undefined, oldAt],
        expectedWallets: [oldWallet.wallet]
      },
      {
        name: "excludedGenerationId",
        args: [100, undefined, undefined, cohort.generationId],
        expectedWallets: [oldWallet.wallet, completedWallet.wallet]
      },
      {
        name: "excludeCompletedLocalQualifications",
        args: [100, undefined, undefined, undefined, true],
        expectedWallets: [oldWallet.wallet, targetedWallet.wallet]
      }
    ];

    for (const testCase of cases) {
      const before = survivorQueryCount();
      expect(
        repository.listLatestWalletPreScreenSurvivors(...testCase.args).map((item) => item.wallet),
        testCase.name
      ).toEqual(testCase.expectedWallets);
      expect(survivorQueryCount(), `${testCase.name} first read`).toBe(before + 1);
      expect(
        repository.listLatestWalletPreScreenSurvivors(...testCase.args).map((item) => item.wallet),
        `${testCase.name} cached read`
      ).toEqual(testCase.expectedWallets);
      expect(survivorQueryCount(), `${testCase.name} cached read`).toBe(before + 1);
    }

    const survivorSql = prepare.mock.calls
      .map(([sql]) => sql)
      .find((sql): sql is string => typeof sql === "string" && sql.includes("ROW_NUMBER() OVER"));
    expect(survivorSql).toMatch(
      /FROM wallet_prescreen_snapshots\s+WHERE \(\? IS NULL OR calculated_at <= \?\)\s+[^]*AND \(\? IS NULL OR calculated_at > \?\)/u
    );
  });

  it("invalidates a cached empty survivor result after an eligible pre-screen write", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const rejected = record("cache-empty-to-eligible", {
      preScreenEligible: false,
      preScreenReasons: ["initial rejection"]
    });
    repository.upsertWalletIndexRecord(rejected);
    repository.saveWalletPreScreenSnapshot({
      wallet: rejected.wallet,
      runId: "cache-empty-rejected",
      calculatedAt: NOW.toISOString(),
      eligible: false,
      reasons: ["initial rejection"],
      record: rejected
    });
    const prepare = vi.spyOn(db, "prepare");
    const survivorQueryCount = (): number => prepare.mock.calls.filter(([sql]) =>
      typeof sql === "string" && sql.includes("ROW_NUMBER() OVER")
    ).length;

    expect(repository.listLatestWalletPreScreenSurvivors(100)).toEqual([]);
    expect(repository.listLatestWalletPreScreenSurvivors(100)).toEqual([]);
    expect(survivorQueryCount()).toBe(1);

    const eligibleAt = new Date(NOW.getTime() + 60_000).toISOString();
    repository.saveWalletPreScreenSnapshot({
      wallet: rejected.wallet,
      runId: "cache-empty-eligible",
      calculatedAt: eligibleAt,
      eligible: true,
      reasons: [],
      record: {
        ...rejected,
        updatedAt: eligibleAt,
        preScreenEligible: true,
        preScreenReasons: []
      }
    });
    expect(repository.listLatestWalletPreScreenSurvivors(100).map((item) => item.wallet))
      .toEqual([rejected.wallet]);
    expect(survivorQueryCount()).toBe(2);
  });

  it("bounds direct-SQL survivor staleness to the current turn", async () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const item = record("cache-direct-sql");
    saveSurvivor(repository, item, "cache-direct-sql-run");
    const prepare = vi.spyOn(db, "prepare");
    const survivorQueryCount = (): number => prepare.mock.calls.filter(([sql]) =>
      typeof sql === "string" && sql.includes("ROW_NUMBER() OVER")
    ).length;

    expect(repository.listLatestWalletPreScreenSurvivors(100).map((entry) => entry.wallet))
      .toEqual([item.wallet]);
    db.prepare(`
      UPDATE wallet_prescreen_snapshots SET eligible = 0
      WHERE wallet = ? AND run_id = ?
    `).run(item.wallet, "cache-direct-sql-run");

    // Direct database writes bypass repository invalidation, but cannot remain
    // stale beyond the intentionally bounded one-turn cache lifetime.
    expect(repository.listLatestWalletPreScreenSurvivors(100).map((entry) => entry.wallet))
      .toEqual([item.wallet]);
    expect(survivorQueryCount()).toBe(1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(repository.listLatestWalletPreScreenSurvivors(100)).toEqual([]);
    expect(survivorQueryCount()).toBe(2);
  });

  it("invalidates survivor reads after pre-screen, target, handoff, and recovery mutations", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const first = record("cache-target-first", { successfulTransactionCount: 300 });
    const second = record("cache-target-second", { successfulTransactionCount: 200 });
    const handoff = record("cache-handoff", { successfulTransactionCount: 100 });
    for (const item of [first, second, handoff]) saveSurvivor(repository, item);
    const firstCohort = repository.createWalletDeepHistoryCohort({
      selectedAt: NOW.toISOString(),
      snapshotCutoffAt: NOW.toISOString(),
      windowStart: new Date(NOW.getTime() - 90 * DAY).toISOString(),
      windowEnd: NOW.toISOString(),
      wallets: [first.wallet]
    });

    expect(repository.listLatestWalletPreScreenSurvivors(
      100,
      undefined,
      NOW.toISOString(),
      firstCohort.generationId
    ).map((item) => item.wallet)).toEqual([second.wallet, handoff.wallet]);
    repository.createWalletDeepHistoryCohort({
      generationId: firstCohort.generationId,
      selectedAt: NOW.toISOString(),
      snapshotCutoffAt: firstCohort.snapshotCutoffAt,
      windowStart: firstCohort.windowStart,
      windowEnd: firstCohort.windowEnd,
      wallets: [second.wallet]
    });
    expect(repository.listLatestWalletPreScreenSurvivors(
      100,
      undefined,
      NOW.toISOString(),
      firstCohort.generationId
    ).map((item) => item.wallet)).toEqual([handoff.wallet]);

    const laterAt = new Date(NOW.getTime() + DAY).toISOString();
    repository.saveWalletPreScreenSnapshot({
      wallet: handoff.wallet,
      runId: "later-rejection",
      calculatedAt: laterAt,
      eligible: false,
      reasons: ["later rejection"],
      record: { ...handoff, updatedAt: laterAt, preScreenEligible: false }
    });
    expect(repository.listLatestWalletPreScreenSurvivors(100).map((item) => item.wallet))
      .not.toContain(handoff.wallet);
    expect(repository.listLatestWalletPreScreenSurvivors(100, undefined, NOW.toISOString())
      .map((item) => item.wallet)).toContain(handoff.wallet);

    repository.enqueueWalletResearchHandoff({
      generation: "cache-completed-handoff",
      runId: "cache-run",
      wallets: [handoff.wallet],
      readyAt: NOW.toISOString()
    });
    expect(repository.claimWalletResearchHandoff(NOW)?.generation).toBe("cache-completed-handoff");
    const prepare = vi.spyOn(db, "prepare");
    const survivorQueryCount = (): number => prepare.mock.calls.filter(([sql]) =>
      typeof sql === "string" && sql.includes("ROW_NUMBER() OVER")
    ).length;
    expect(repository.listLatestWalletPreScreenSurvivors(
      100,
      undefined,
      NOW.toISOString(),
      undefined,
      true
    ).map((item) => item.wallet)).toContain(handoff.wallet);
    expect(survivorQueryCount()).toBe(1);
    expect(repository.recoverRunningWalletResearchHandoffs(NOW)).toBe(1);
    expect(repository.listLatestWalletPreScreenSurvivors(
      100,
      undefined,
      NOW.toISOString(),
      undefined,
      true
    ).map((item) => item.wallet)).toContain(handoff.wallet);
    expect(survivorQueryCount()).toBe(2);
    expect(repository.claimWalletResearchHandoff(NOW)?.generation).toBe("cache-completed-handoff");
    expect(repository.completeWalletResearchHandoff("cache-completed-handoff", undefined, NOW)).toBe(true);
    expect(repository.listLatestWalletPreScreenSurvivors(
      100,
      undefined,
      NOW.toISOString(),
      undefined,
      true
    ).map((item) => item.wallet)).not.toContain(handoff.wallet);
    expect(survivorQueryCount()).toBe(3);
  });

  it("invalidates survivor reads when deep-history cohorts and generations become terminal", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const exactWallet = record("cache-exact-terminal");
    saveSurvivor(repository, exactWallet);
    const exact = repository.createWalletDeepHistoryCohort({
      selectedAt: NOW.toISOString(),
      snapshotCutoffAt: NOW.toISOString(),
      windowStart: new Date(NOW.getTime() - 90 * DAY).toISOString(),
      windowEnd: NOW.toISOString(),
      wallets: [exactWallet.wallet]
    });
    repository.saveWalletDeepHistoryEvidence({
      generationId: exact.generationId,
      cohortId: exact.id,
      wallet: exactWallet.wallet,
      record: exactWallet,
      swaps: [],
      frozenAt: NOW.toISOString()
    });
    const prepare = vi.spyOn(db, "prepare");
    const survivorQueryCount = (): number => prepare.mock.calls.filter(([sql]) =>
      typeof sql === "string" && sql.includes("ROW_NUMBER() OVER")
    ).length;
    const read = (): void => {
      repository.listLatestWalletPreScreenSurvivors(100, undefined, NOW.toISOString());
    };

    read();
    expect(survivorQueryCount()).toBe(1);
    expect(repository.completeWalletDeepHistoryCohort(exact.id, NOW)).toBe(true);
    read();
    expect(survivorQueryCount()).toBe(2);
    expect(repository.completeWalletDeepHistoryGeneration(exact.generationId, NOW)).toBe(true);
    read();
    expect(survivorQueryCount()).toBe(3);

    const managedWallet = record("cache-managed-terminal");
    saveSurvivor(repository, managedWallet, "managed-run");
    const managed = repository.createWalletDeepHistoryCohort({
      selectedAt: NOW.toISOString(),
      snapshotCutoffAt: NOW.toISOString(),
      windowStart: new Date(NOW.getTime() - 90 * DAY).toISOString(),
      windowEnd: NOW.toISOString(),
      wallets: [managedWallet.wallet]
    });
    repository.saveWalletDeepHistoryEvidence({
      generationId: managed.generationId,
      cohortId: managed.id,
      wallet: managedWallet.wallet,
      record: managedWallet,
      swaps: [],
      frozenAt: NOW.toISOString()
    });
    read();
    expect(survivorQueryCount()).toBe(4);
    expect(repository.markWalletDeepHistoryCohortManagedScreened(managed.id, "cache-policy", NOW)).toBe(true);
    read();
    expect(survivorQueryCount()).toBe(5);
    expect(repository.markWalletDeepHistoryGenerationManagedScreened(
      managed.generationId,
      "cache-policy",
      NOW
    )).toBe(true);
    read();
    expect(survivorQueryCount()).toBe(6);
  });

  it("excludes completed local handoffs while retaining a provider-only score for its first exact pass", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const completedLocal = record("completed-local-handoff", { successfulTransactionCount: 1_100 });
    const providerOnly = record("provider-only-score", { successfulTransactionCount: 1_000 });
    const controlOnly = record("control-only-score", { successfulTransactionCount: 900 });
    const fresh = record("fresh-managed-research", { successfulTransactionCount: 800 });
    for (const item of [completedLocal, providerOnly, controlOnly, fresh]) saveSurvivor(repository, item);

    const providerCohortId = "provider-cohort";
    repository.saveCohort({
      cohortId: providerCohortId,
      generatedAt: NOW.toISOString(),
      candidates: [
        {
          address: completedLocal.wallet,
          cohortId: providerCohortId,
          firstSeenAt: completedLocal.firstSeenAt,
          lastSeenAt: completedLocal.lastSeenAt,
          control: false,
          tags: []
        },
        {
          address: providerOnly.wallet,
          cohortId: providerCohortId,
          firstSeenAt: providerOnly.firstSeenAt,
          lastSeenAt: providerOnly.lastSeenAt,
          control: false,
          tags: []
        },
        {
          address: controlOnly.wallet,
          cohortId: providerCohortId,
          firstSeenAt: controlOnly.firstSeenAt,
          lastSeenAt: controlOnly.lastSeenAt,
          control: true,
          tags: []
        }
      ]
    });
    for (const wallet of [completedLocal.wallet, providerOnly.wallet, controlOnly.wallet]) {
      repository.saveWalletScore(providerCohortId, {
        wallet,
        calculatedAt: NOW.toISOString(),
        qualified: false,
        reasons: ["provider-scored"],
        historyDays: 90,
        closedEligibleSwaps: 50,
        activeWeeks: 4,
        medianHoldingMinutes: 20,
        topTokenProfitShare: 0.4,
        topThreeProfitShare: 0.7
      });
    }
    repository.enqueueWalletResearchHandoff({
      generation: "prior-local-qualification",
      runId: "prior-index-run",
      wallets: [completedLocal.wallet],
      readyAt: NOW.toISOString()
    });
    expect(repository.claimWalletResearchHandoff(NOW)?.wallets).toEqual([completedLocal.wallet]);
    expect(repository.completeWalletResearchHandoff(
      "prior-local-qualification",
      providerCohortId,
      NOW
    )).toBe(true);

    expect(repository.hasCompletedLocalProviderQualification(completedLocal.wallet)).toBe(true);
    expect(repository.hasCompletedLocalProviderQualification(providerOnly.wallet)).toBe(false);
    expect(repository.listLatestWalletPreScreenSurvivors(
      100,
      undefined,
      undefined,
      undefined,
      true
    ).map((item) => item.wallet)).toEqual([providerOnly.wallet, controlOnly.wallet, fresh.wallet]);

    const coordinator = new WalletDeepHistoryCoordinator(repository, {
      getSignaturesForAddress: async () => [],
      getTransaction: async () => null
    }, {
      allowUnpricedStructuralCompletion: true,
      now: () => new Date(NOW)
    });
    expect(coordinator.ensureTargets()?.wallets).toEqual([
      providerOnly.wallet,
      controlOnly.wallet,
      fresh.wallet
    ]);
  });

  it("selects the frozen as-of snapshot instead of mixing in a newer wallet aggregate", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const frozen = record("as-of-wallet", { successfulTransactionCount: 75, updatedAt: NOW.toISOString() });
    saveSurvivor(repository, frozen, "frozen-run");

    const laterAt = new Date(NOW.getTime() + DAY).toISOString();
    const later = record("as-of-wallet", {
      successfulTransactionCount: 9_999,
      preScreenEligible: false,
      preScreenReasons: ["later rejection"],
      updatedAt: laterAt,
      lastSeenAt: laterAt
    });
    repository.upsertWalletIndexRecord(later);
    repository.saveWalletPreScreenSnapshot({
      wallet: later.wallet,
      runId: "later-run",
      calculatedAt: laterAt,
      eligible: false,
      reasons: ["later rejection"],
      record: later
    });

    expect(repository.listLatestWalletPreScreenSurvivors(100)).toEqual([]);
    expect(repository.listLatestWalletPreScreenSurvivors(100, undefined, NOW.toISOString()))
      .toEqual([expect.objectContaining({
        wallet: "as-of-wallet",
        successfulTransactionCount: 75,
        updatedAt: NOW.toISOString()
      })]);
  });

  it("resumes pagination after restart, deduplicates overlap, and stops at the frozen 90-day cutoff", async () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    saveSurvivor(repository, record("wallet-1"));
    const cutoffSeconds = (NOW.getTime() - 90 * DAY) / 1_000;
    const requests: HeliusSignaturePageRequest[] = [];
    const rpc: HeliusIndexRpc = {
      getSignaturesForAddress: async (_wallet, request = {}) => {
        requests.push(request);
        if (!request.before) {
          return [
            { signature: "after-window", slot: 4, blockTime: NOW.getTime() / 1_000 + 1, failed: false },
            { signature: "recent-1", slot: 3, blockTime: cutoffSeconds + 300, failed: false },
            { signature: "recent-2", slot: 2, blockTime: cutoffSeconds + 200, failed: false }
          ];
        }
        return [
          { signature: "recent-2", slot: 2, blockTime: cutoffSeconds + 200, failed: false },
          { signature: "too-old", slot: 1, blockTime: cutoffSeconds - 1, failed: false }
        ];
      },
      getTransaction: async () => null
    };
    const first = new WalletDeepHistoryCoordinator(repository, rpc, {
      pageSize: 3,
      now: () => new Date(NOW)
    });
    const targets = first.ensureTargets()!;
    expect(await first.runOnce()).toBe(true);
    expect(repository.getWalletIndexCheckpoint(WALLET_DEEP_HISTORY_PIPELINE, `${targets.cohortId}:wallet-1`))
      .toMatchObject({
        beforeSignature: "recent-2",
        metadata: { stage: "PAGING", signatureCount: 2, upperSignature: "after-window", upperSlot: 4 }
      });

    const restarted = new WalletDeepHistoryCoordinator(repository, rpc, {
      pageSize: 3,
      now: () => new Date(NOW)
    });
    expect(await restarted.runOnce()).toBe(true);

    expect(requests).toEqual([{ limit: 3 }, { limit: 3, before: "recent-2" }]);
    expect(repository.walletIndexCoverage()).toMatchObject({ uniqueSignatures: 2 });
    expect(repository.getWalletIndexTransaction("after-window")).toBeUndefined();
    expect(repository.getWalletIndexTransaction("too-old")).toBeUndefined();
    expect(repository.getWalletIndexCheckpoint(WALLET_DEEP_HISTORY_PIPELINE, `${targets.cohortId}:wallet-1`))
      .toMatchObject({ metadata: { stage: "AWAITING_HYDRATION", pages: 2, signatureCount: 2 } });
    expect(repository.listWalletIndexTransactionSources("recent-2")).toEqual([
      expect.objectContaining({
        source: "helius-wallet-deep-history",
        sourceAddress: "wallet-1",
        wallet: "wallet-1"
      })
    ]);
  });

  it("fails closed with durable evidence when the safe page ceiling is reached", async () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    saveSurvivor(repository, record("ceiling-wallet"));
    let calls = 0;
    const rpc: HeliusIndexRpc = {
      getSignaturesForAddress: async () => {
        calls += 1;
        return [
          { signature: "ceiling-1", slot: 2, blockTime: NOW.getTime() / 1_000, failed: true },
          { signature: "ceiling-2", slot: 1, blockTime: NOW.getTime() / 1_000 - 1, failed: true }
        ];
      },
      getTransaction: async () => null
    };
    const coordinator = new WalletDeepHistoryCoordinator(repository, rpc, {
      pageSize: 2,
      maximumPages: 1,
      now: () => new Date(NOW)
    });
    const targets = coordinator.ensureTargets()!;

    expect(await coordinator.runOnce()).toBe(true);
    expect(repository.getWalletIndexCheckpoint(WALLET_DEEP_HISTORY_PIPELINE, `${targets.cohortId}:ceiling-wallet`))
      .toMatchObject({
        completed: false,
        metadata: { stage: "PAGING", pages: 1, upperSignature: "ceiling-1" }
      });
    expect(await coordinator.runOnce()).toBe(true);
    expect(calls).toBe(1);
    expect(repository.getWalletIndexRecord("ceiling-wallet")).toMatchObject({
      deepHistoryStatus: "FAILED",
      structuralEligible: false,
      structuralReasons: ["deep-history pagination exceeded the safe 1-page ceiling"]
    });
    expect(repository.getWalletIndexCheckpoint(WALLET_DEEP_HISTORY_PIPELINE, `${targets.cohortId}:ceiling-wallet`))
      .toMatchObject({
        completed: true,
        metadata: {
          stage: "FAILED",
          failureKind: "PAGE_CEILING",
          maximumPages: 1,
          upperSignature: "ceiling-1"
        }
      });
    expect(coordinator.progress()).toEqual({ targets: 1, complete: 0, failed: 1, coarseSkipped: 0, pending: 0 });
  });

  it("reconstructs signature count after a crash between enqueue and checkpoint commit", async () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    saveSurvivor(repository, record("wallet-1"));
    const rpc: HeliusIndexRpc = {
      getSignaturesForAddress: async () => [
        { signature: "replayed", slot: 1, blockTime: NOW.getTime() / 1_000, failed: false }
      ],
      getTransaction: async () => null
    };
    const coordinator = new WalletDeepHistoryCoordinator(repository, rpc, {
      pageSize: 10,
      now: () => new Date(NOW)
    });
    const targets = coordinator.ensureTargets()!;
    // Simulate a committed source observation followed by a process crash
    // before its matching ingestion checkpoint was written.
    repository.enqueueWalletIndexTransactions([{
      signature: "replayed",
      sourceAddress: "wallet-1",
      wallet: "wallet-1",
      source: "helius-wallet-deep-history",
      discoveredAt: NOW.toISOString(),
      slot: 1,
      blockTime: NOW.toISOString(),
      metadata: {
        deepHistory: true,
        cohortId: targets.cohortId,
        generationId: targets.generationId,
        windowStart: targets.windowStart,
        windowEnd: targets.windowEnd
      }
    }]);

    expect(repository.getWalletIndexCheckpoint(WALLET_DEEP_HISTORY_PIPELINE, `${targets.cohortId}:wallet-1`)).toBeUndefined();
    expect(await coordinator.runOnce()).toBe(true);
    expect(repository.walletDeepHistoryQueueCoverage("wallet-1").total).toBe(1);
    expect(repository.getWalletIndexCheckpoint(WALLET_DEEP_HISTORY_PIPELINE, `${targets.cohortId}:wallet-1`))
      .toMatchObject({ metadata: { stage: "AWAITING_HYDRATION", signatureCount: 1 } });
  });

  it("chunks large history pages and yields between durable commits", async () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    saveSurvivor(repository, record("responsive-wallet"));
    const signatures = Array.from({ length: 121 }, (_, index) => ({
      signature: `responsive-${index.toString().padStart(3, "0")}`,
      slot: 1_000 - index,
      blockTime: NOW.getTime() / 1_000 - index,
      failed: false
    }));
    const enqueue = vi.spyOn(repository, "enqueueWalletIndexTransactions");
    const yieldControl = vi.fn(async () => undefined);
    const coordinator = new WalletDeepHistoryCoordinator(repository, {
      getSignaturesForAddress: async () => signatures,
      getTransaction: async () => null
    }, {
      pageSize: signatures.length,
      yieldControl,
      now: () => new Date(NOW)
    });

    expect(await coordinator.runOnce()).toBe(true);
    expect(enqueue.mock.calls.map(([items]) => items.length)).toEqual([50, 50, 21]);
    expect(yieldControl).toHaveBeenCalledTimes(2);
    expect(repository.walletDeepHistoryQueueCoverage("responsive-wallet").total).toBe(121);
  });

  it("does not apply structural gates until every target signature is hydrated", async () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    saveSurvivor(repository, record("wallet-1"));
    const rpc: HeliusIndexRpc = {
      getSignaturesForAddress: async () => [
        { signature: "deep-1", slot: 1, blockTime: NOW.getTime() / 1_000, failed: false },
        { signature: "deep-2", slot: 2, blockTime: NOW.getTime() / 1_000 - 1, failed: false }
      ],
      getTransaction: async () => null
    };
    const coordinator = new WalletDeepHistoryCoordinator(repository, rpc, {
      pageSize: 10,
      now: () => new Date(NOW)
    });
    const targets = coordinator.ensureTargets()!;
    expect(await coordinator.runOnce()).toBe(true);
    expect(await coordinator.runOnce()).toBe(false);
    expect(coordinator.progress()).toEqual({ targets: 1, complete: 0, failed: 0, coarseSkipped: 0, pending: 1 });
    expect(repository.getWalletIndexRecord("wallet-1")).toMatchObject({
      deepHistoryStatus: "AWAITING_HYDRATION",
      structuralEligible: false
    });

    const leased = repository.leaseWalletIndexTransactions("test", 10, 60, NOW);
    for (const item of leased) {
      expect(repository.completeWalletIndexTransaction({
        ...item,
        success: true,
        sourceWallets: ["wallet-1"],
        updatedAt: NOW.toISOString()
      }, [], item.leaseToken!, NOW)).toBe(true);
    }
    expect(await coordinator.runOnce()).toBe(true);
    expect(repository.getWalletIndexRecord("wallet-1")).toMatchObject({
      deepHistoryStatus: "COMPLETE",
      deepHistorySignatureCount: 2,
      deepHistoryHydratedCount: 2,
      structuralEligible: false,
      structuralReasons: [
        "insufficient closed eligible swaps",
        "median holding time is too short"
      ]
    });
    expect(repository.getWalletIndexCheckpoint(WALLET_DEEP_HISTORY_PIPELINE, `${targets.cohortId}:wallet-1`))
      .toMatchObject({ completed: true, metadata: { stage: "COMPLETE" } });
    const fullEvidenceRead = vi.spyOn(repository, "getWalletDeepHistoryEvidence");
    expect(coordinator.progress()).toEqual({ targets: 1, complete: 1, failed: 0, coarseSkipped: 0, pending: 0 });
    expect(fullEvidenceRead).not.toHaveBeenCalled();
  });

  it("fails closed by default while SOL repricing remains pending", async () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const wallet = "local-unpriced-wallet";
    saveSurvivor(repository, record(wallet, { medianHoldingMinutes: 20 }));
    vi.spyOn(repository, "listIndexedSpotSwaps").mockReturnValue(structurallyEligibleSwaps(wallet));
    vi.spyOn(repository, "pendingIndexedSwapReprices").mockReturnValue(1);
    const coordinator = new WalletDeepHistoryCoordinator(repository, {
      getSignaturesForAddress: async () => [],
      getTransaction: async () => null
    }, {
      targetLimit: 1,
      now: () => new Date(NOW)
    });
    const targets = coordinator.ensureTargets()!;

    expect(await coordinator.runOnce()).toBe(true);
    expect(await coordinator.runOnce()).toBe(false);
    expect(repository.getWalletIndexRecord(wallet)).toMatchObject({
      deepHistoryStatus: "AWAITING_HYDRATION",
      structuralEligible: false,
      structuralReasons: [AWAITING_LOCAL_SOL_PRICE]
    });
    expect(repository.getWalletDeepHistoryEvidence(targets.generationId, wallet)).toBeUndefined();
    expect(coordinator.progress()).toEqual({ targets: 1, complete: 0, failed: 0, coarseSkipped: 0, pending: 1 });
  });

  it("allows only an explicitly managed structural cohort to finish while SOL repricing remains pending", async () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const wallet = "managed-structural-wallet";
    saveSurvivor(repository, record(wallet, { medianHoldingMinutes: 20 }));
    vi.spyOn(repository, "listIndexedSpotSwaps").mockReturnValue(structurallyEligibleSwaps(wallet));
    vi.spyOn(repository, "pendingIndexedSwapReprices").mockReturnValue(1);
    const coordinator = new WalletDeepHistoryCoordinator(repository, {
      getSignaturesForAddress: async () => [],
      getTransaction: async () => null
    }, {
      targetLimit: 1,
      allowUnpricedStructuralCompletion: true,
      now: () => new Date(NOW)
    });
    const targets = coordinator.ensureTargets()!;

    expect(await coordinator.runOnce()).toBe(true);
    expect(await coordinator.runOnce()).toBe(true);
    expect(repository.getWalletIndexRecord(wallet)).toMatchObject({
      deepHistoryStatus: "COMPLETE",
      closedEligibleSwaps: 51,
      medianHoldingMinutes: 20,
      structuralEligible: true,
      structuralReasons: [],
      profitPricingCoverage: "PARTIAL"
    });
    expect(repository.getWalletDeepHistoryEvidence(targets.generationId, wallet)).toBeDefined();
  });

  it("never replaces partial exact pagination with a managed coarse disposition", async () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const wallet = "managed-coarse-skip";
    saveSurvivor(repository, record(wallet, { medianHoldingMinutes: 1 }));
    let signaturePage = 0;
    const rpc: HeliusIndexRpc = {
      getSignaturesForAddress: async () => signaturePage++ === 0 ? [
        { signature: "partial-1", slot: 2, blockTime: NOW.getTime() / 1_000, failed: false },
        { signature: "partial-2", slot: 1, blockTime: NOW.getTime() / 1_000 - 1, failed: false }
      ] : [],
      getTransaction: async () => null
    };
    const exact = new WalletDeepHistoryCoordinator(repository, rpc, {
      targetLimit: 1,
      pageSize: 2,
      now: () => new Date(NOW)
    });
    const targets = exact.ensureTargets()!;
    expect(await exact.runOnce()).toBe(true);
    const partial = repository.getWalletIndexCheckpoint(
      WALLET_DEEP_HISTORY_PIPELINE,
      `${targets.cohortId}:${wallet}`
    );
    expect(partial).toMatchObject({
      completed: false,
      metadata: { stage: "PAGING", pages: 1, signatureCount: 2 }
    });

    const laterAt = new Date(NOW.getTime() + DAY).toISOString();
    saveSurvivor(repository, record(wallet, {
      medianHoldingMinutes: 100,
      updatedAt: laterAt,
      lastSeenAt: laterAt
    }), "later-run");
    const managed = new WalletDeepHistoryCoordinator(repository, rpc, {
      targetLimit: 1,
      pageSize: 2,
      includeExistingBacklog: true,
      allowUnpricedStructuralCompletion: true,
      now: () => new Date(NOW.getTime() + DAY)
    });

    expect(managed.ensureTargets()?.cohortId).toBe(targets.cohortId);
    expect(repository.getWalletDeepHistoryTargetDisposition(targets.cohortId, wallet)).toBeUndefined();
    expect(await managed.runOnce()).toBe(true);
    expect(repository.getWalletIndexCheckpoint(
      WALLET_DEEP_HISTORY_PIPELINE,
      `${targets.cohortId}:${wallet}`
    )).toMatchObject({
      completed: false,
      metadata: { stage: "AWAITING_HYDRATION", pages: 2, signatureCount: 2 }
    });
    expect(repository.walletDeepHistoryQueueCoverage(wallet, targets.cohortId).total).toBe(2);
    expect(repository.getWalletDeepHistoryEvidence(targets.generationId, wallet)).toBeUndefined();
    expect(managed.progress()).toEqual({
      targets: 1,
      complete: 0,
      failed: 0,
      coarseSkipped: 0,
      pending: 1
    });
    expect(repository.getWalletDeepHistoryCohort(targets.cohortId)?.status).toBe("OPEN");
    expect(repository.latestCompleteWalletDeepHistoryGeneration()).toBeUndefined();
  });

  it("rejects managed unpriced completion when local identity evidence is enabled", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);

    expect(() => new WalletDeepHistoryCoordinator(repository, {
      getSignaturesForAddress: async () => [],
      getTransaction: async () => null
    }, {
      allowUnpricedStructuralCompletion: true,
      identityEnabled: true
    })).toThrow(/cannot be combined with local identity evidence/i);
  });

  it("finishes an open cohort but fail-closes before freezing the next paced cohort", async () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    saveSurvivor(repository, record("paced-wallet-1"));
    saveSurvivor(repository, record("paced-wallet-2"));
    let allowNext = true;
    const coordinator = new WalletDeepHistoryCoordinator(repository, {
      getSignaturesForAddress: async () => [],
      getTransaction: async () => null
    }, {
      targetLimit: 1,
      includeExistingBacklog: true,
      canStartNextCohort: () => allowNext,
      now: () => new Date(NOW)
    });

    const first = coordinator.ensureTargets();
    expect(first?.wallets).toHaveLength(1);
    expect(await coordinator.runOnce()).toBe(true);
    expect(await coordinator.runOnce()).toBe(true);
    expect(coordinator.progress()).toEqual({ targets: 1, complete: 1, failed: 0, coarseSkipped: 0, pending: 0 });

    allowNext = false;
    expect(coordinator.ensureTargets()).toBeUndefined();
    expect(repository.openWalletDeepHistoryGeneration()).toMatchObject({ status: "OPEN" });

    allowNext = true;
    const second = coordinator.ensureTargets();
    expect(second?.wallets).toHaveLength(1);
    expect(second?.wallets).not.toEqual(first?.wallets);
  });
});

describe("deep wallet FIFO materialization", () => {
  it("accepts the unchanged 50-exit and 15-minute structural boundaries exactly", () => {
    const wallet = "wallet-boundary";
    const swaps: IndexedSpotSwap[] = [];
    const openedAt = new Date("2026-07-01T00:00:00.000Z");
    for (let index = 0; index < 50; index += 1) {
      const mint = `boundary-mint-${index}`;
      swaps.push(swap(wallet, mint, "BUY", openedAt.toISOString(), USDC_MINT, index * 2));
      swaps.push(swap(
        wallet,
        mint,
        "SELL",
        new Date(openedAt.getTime() + 15 * 60_000).toISOString(),
        USDC_MINT,
        index * 2 + 1
      ));
    }

    expect(materializeWalletDeepHistory(record(wallet), swaps, {
      windowStart: new Date(NOW.getTime() - 90 * DAY).toISOString(),
      windowEnd: NOW.toISOString(),
      signatureCount: 100,
      hydratedCount: 100,
      calculatedAt: NOW.toISOString()
    })).toMatchObject({
      closedEligibleSwaps: 50,
      medianHoldingMinutes: 15,
      structuralEligible: true,
      structuralReasons: [],
      profitPricingCoverage: "COMPLETE"
    });
  });

  it("applies exact structural gates while explicitly separating priced and unpriced profit coverage", () => {
    const wallet = "wallet-1";
    const swaps: IndexedSpotSwap[] = [];
    const openedAt = new Date("2026-07-01T00:00:00.000Z");
    for (let index = 0; index < 50; index += 1) {
      const mint = `mint-${index}`;
      swaps.push(swap(wallet, mint, "BUY", openedAt.toISOString(), USDC_MINT, index * 2));
      swaps.push(swap(
        wallet,
        mint,
        "SELL",
        new Date(openedAt.getTime() + 20 * 60_000).toISOString(),
        USDC_MINT,
        index * 2 + 1
      ));
    }
    swaps.push(swap(wallet, "sol-priced-mint", "BUY", openedAt.toISOString(), SOL_MINT, 100));
    swaps.push(swap(
      wallet,
      "sol-priced-mint",
      "SELL",
      new Date(openedAt.getTime() + 20 * 60_000).toISOString(),
      SOL_MINT,
      101
    ));

    const result = materializeWalletDeepHistory(record(wallet), swaps, {
      windowStart: new Date(NOW.getTime() - 90 * DAY).toISOString(),
      windowEnd: NOW.toISOString(),
      signatureCount: 102,
      hydratedCount: 102,
      calculatedAt: NOW.toISOString()
    });

    expect(result).toMatchObject({
      deepHistoryStatus: "COMPLETE",
      closedEligibleSwaps: 51,
      medianHoldingMinutes: 20,
      structuralEligible: true,
      structuralReasons: [],
      pricedClosedEligibleSwaps: 50,
      unpricedClosedEligibleSwaps: 1,
      realizedPnlPricedUsd: 100,
      pricedProfitTokenCount: 50,
      profitPricingCoverage: "PARTIAL"
    });
    expect(result.topTokenProfitShare).toBeCloseTo(0.02);
    expect(result.topThreeProfitShare).toBeCloseTo(0.06);
  });
});
