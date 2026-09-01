import type { WalletHistorySummary, WalletIndexRecord, WalletPnlWindow } from "@copylab/shared";
import { afterEach, describe, expect, it } from "vitest";
import type { CopyLabDatabase } from "../src/database.js";
import { openDatabase } from "../src/database.js";
import {
  MANAGED_RECOVERY_PREFLIGHT_POLICY,
  managedRecoveryPreflightWindow
} from "../src/managed-recovery-preflight.js";
import { Repository, type ManagedRecoveryPreflightClaim } from "../src/repository.js";

const NOW = new Date("2026-07-09T12:00:00.000Z");
const DAY = 86_400_000;
const WINDOW = managedRecoveryPreflightWindow(NOW);

function record(wallet: string, successfulTransactionCount = 900): WalletIndexRecord {
  return {
    wallet,
    firstSeenAt: "2025-01-01T00:00:00.000Z",
    lastSeenAt: NOW.toISOString(),
    historyDays: 90,
    transactionCount: successfulTransactionCount,
    successfulTransactionCount,
    spotSwapCount: 10,
    eligibleSpotSwapCount: 10,
    closedEligibleSwaps: 1,
    buyCount: 5,
    sellCount: 5,
    activeDays: 20,
    activeWeeks: 4,
    distinctMints: 5,
    medianHoldingMinutes: 20,
    preScreenEligible: true,
    preScreenReasons: [],
    deepHistoryStatus: "AWAITING",
    updatedAt: NOW.toISOString()
  };
}

function saveRecoveryCandidates(repository: Repository, records: WalletIndexRecord[]): void {
  for (const item of records) {
    const coarseSnapshot = record(item.wallet, item.successfulTransactionCount);
    coarseSnapshot.closedEligibleSwaps = 0;
    coarseSnapshot.eligibleSpotSwapCount = 0;
    coarseSnapshot.medianHoldingMinutes = 0;
    repository.upsertWalletIndexRecord(coarseSnapshot);
    repository.saveWalletPreScreenSnapshot({
      wallet: item.wallet,
      runId: `preflight-${item.wallet}`,
      calculatedAt: coarseSnapshot.updatedAt,
      eligible: true,
      reasons: [],
      record: coarseSnapshot
    });
  }
  const cohort = repository.createWalletDeepHistoryCohort({
    selectedAt: NOW.toISOString(),
    snapshotCutoffAt: NOW.toISOString(),
    windowStart: new Date(NOW.getTime() - 90 * DAY).toISOString(),
    windowEnd: NOW.toISOString(),
    wallets: records.map((item) => item.wallet)
  });
  for (const item of records) {
    repository.saveManagedCoarseCopyabilitySkip({
      cohortId: cohort.id,
      wallet: item.wallet,
      policyVersion: "managed-coarse-copyability-v2",
      thresholdMinutes: 15,
      decidedAt: NOW.toISOString()
    });
  }
  expect(repository.markWalletDeepHistoryCohortManagedScreened(
    cohort.id,
    "managed-coarse-copyability-v2",
    NOW
  )).toBe(true);
  for (const item of records) {
    repository.upsertWalletIndexRecord({
      ...item,
      updatedAt: new Date(NOW.getTime() + 1_000).toISOString()
    });
  }
}

function pnl(duration: "30d" | "90d"): WalletPnlWindow {
  return {
    duration,
    realizedProfitUsd: duration === "30d" ? 20 : 50,
    realizedProfitPercent: 10,
    unrealizedProfitUsd: 0,
    totalTrades: 60,
    wins: 40,
    losses: 20
  };
}

function history(wallet: string): WalletHistorySummary {
  return {
    wallet,
    historyDays: 90,
    closedEligibleSwaps: 50,
    activeWeeks: 4,
    medianHoldingMinutes: 20,
    topTokenProfitShare: 0.2,
    topThreeProfitShare: 0.4,
    tags: []
  };
}

function claim(repository: Repository, at: Date): ManagedRecoveryPreflightClaim {
  const result = repository.claimManagedRecoveryPreflight({
    ...WINDOW,
    now: at.toISOString(),
    leaseExpiresAt: new Date(at.getTime() + 60_000).toISOString()
  });
  if (!result) throw new Error("Expected a managed recovery preflight claim.");
  return result;
}

function passPreflight(repository: Repository, wallet: string, startOffsetMs = 0): string {
  repository.seedManagedRecoveryPreflight({
    policyVersion: MANAGED_RECOVERY_PREFLIGHT_POLICY,
    windowStart: WINDOW.windowStart,
    readyAt: new Date(NOW.getTime() + startOffsetMs).toISOString(),
    wallet
  });
  const firstAt = new Date(NOW.getTime() + startOffsetMs);
  const first = claim(repository, firstAt);
  expect(first.wallet).toBe(wallet);
  const pnl30At = new Date(firstAt.getTime() + 1_000).toISOString();
  expect(repository.saveManagedRecoveryPreflightPartial({
    ...first,
    expectedStep: "PNL_30D",
    nextStep: "PNL_90D",
    observedAt: pnl30At,
    pnl30d: pnl("30d")
  })).toBe(true);
  const second = claim(repository, new Date(firstAt.getTime() + 2_000));
  expect(second.step).toBe("PNL_90D");
  const pnl90At = new Date(firstAt.getTime() + 3_000).toISOString();
  expect(repository.saveManagedRecoveryPreflightPartial({
    claimToken: second.claimToken,
    wallet: second.wallet,
    policyVersion: second.policyVersion,
    windowStart: second.windowStart,
    expectedStep: "PNL_90D",
    nextStep: "HISTORY",
    observedAt: pnl90At,
    pnl90d: pnl("90d")
  })).toBe(true);
  const third = claim(repository, new Date(firstAt.getTime() + 4_000));
  expect(third.step).toBe("HISTORY");
  const validAt = new Date(firstAt.getTime() + 5_000).toISOString();
  expect(repository.passManagedRecoveryPreflight({
    ...third,
    expectedStep: "HISTORY",
    validAt,
    expiresAt: WINDOW.expiresAt,
    history: history(wallet)
  })).toBe(true);
  return validAt;
}

describe("managed recovery preflight repository", () => {
  let db: CopyLabDatabase | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("seeds deterministically, claims atomically, and prioritizes affordable raw candidates", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    saveRecoveryCandidates(repository, [record("expensive", 2_952), record("affordable", 887)]);

    const seeded = repository.seedManagedRecoveryPreflight({
      policyVersion: MANAGED_RECOVERY_PREFLIGHT_POLICY,
      windowStart: WINDOW.windowStart,
      readyAt: NOW.toISOString(),
      wallet: "affordable"
    });
    const repeated = repository.seedManagedRecoveryPreflight({
      policyVersion: MANAGED_RECOVERY_PREFLIGHT_POLICY,
      windowStart: WINDOW.windowStart,
      readyAt: NOW.toISOString(),
      wallet: "affordable"
    });
    expect(repeated?.id).toBe(seeded?.id);
    expect(repository.countManagedRecoveryPreflights()).toMatchObject({ total: 1, ready: 1 });

    const leased = claim(repository, NOW);
    expect(leased).toMatchObject({ wallet: "affordable", step: "PNL_30D", attempts: 1 });
    expect(repository.claimManagedRecoveryPreflight({
      ...WINDOW,
      now: NOW.toISOString(),
      leaseExpiresAt: new Date(NOW.getTime() + 60_000).toISOString()
    })?.wallet).toBe("expensive");
  });

  it("persists partial steps and rejects stale claim tokens", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    saveRecoveryCandidates(repository, [record("partial-wallet")]);
    const first = claim(repository, NOW);
    const observedAt = new Date(NOW.getTime() + 1_000).toISOString();
    expect(repository.saveManagedRecoveryPreflightPartial({
      ...first,
      expectedStep: "PNL_30D",
      nextStep: "PNL_90D",
      observedAt,
      pnl30d: pnl("30d")
    })).toBe(true);
    expect(repository.getManagedRecoveryPreflightForWallet({
      policyVersion: WINDOW.policyVersion,
      windowStart: WINDOW.windowStart,
      wallet: "partial-wallet"
    })).toMatchObject({ status: "READY", step: "PNL_90D", pnl30d: pnl("30d") });
    expect(repository.saveManagedRecoveryPreflightPartial({
      ...first,
      expectedStep: "PNL_30D",
      nextStep: "PNL_90D",
      observedAt,
      pnl30d: pnl("30d")
    })).toBe(false);
  });

  it("recovers expired RUNNING leases to RETRY without discarding partial evidence", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    saveRecoveryCandidates(repository, [record("recovery-wallet")]);
    const first = claim(repository, NOW);
    expect(repository.saveManagedRecoveryPreflightPartial({
      ...first,
      expectedStep: "PNL_30D",
      nextStep: "PNL_90D",
      observedAt: new Date(NOW.getTime() + 1_000).toISOString(),
      pnl30d: pnl("30d")
    })).toBe(true);
    claim(repository, new Date(NOW.getTime() + 2_000));
    expect(repository.recoverManagedRecoveryPreflightRuns({
      now: new Date(NOW.getTime() + 30_000).toISOString()
    })).toBe(0);
    expect(repository.recoverManagedRecoveryPreflightRuns({
      now: new Date(NOW.getTime() + 63_000).toISOString()
    })).toBe(1);
    expect(repository.getManagedRecoveryPreflightForWallet({
      policyVersion: WINDOW.policyVersion,
      windowStart: WINDOW.windowStart,
      wallet: "recovery-wallet"
    })).toMatchObject({ status: "RETRY", step: "PNL_90D", pnl30d: pnl("30d") });
  });

  it("requeues only the matching positive-PnL history hold without repeating PnL", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const wallet = "history-policy-alignment";
    saveRecoveryCandidates(repository, [record(wallet)]);
    const first = claim(repository, NOW);
    expect(repository.saveManagedRecoveryPreflightPartial({
      ...first,
      expectedStep: "PNL_30D",
      nextStep: "PNL_90D",
      observedAt: new Date(NOW.getTime() + 1_000).toISOString(),
      pnl30d: pnl("30d")
    })).toBe(true);
    const second = claim(repository, new Date(NOW.getTime() + 2_000));
    expect(repository.saveManagedRecoveryPreflightPartial({
      claimToken: second.claimToken,
      wallet,
      policyVersion: second.policyVersion,
      windowStart: second.windowStart,
      expectedStep: "PNL_90D",
      nextStep: "HISTORY",
      observedAt: new Date(NOW.getTime() + 3_000).toISOString(),
      pnl90d: pnl("90d")
    })).toBe(true);
    const third = claim(repository, new Date(NOW.getTime() + 4_000));
    const heldError = "Managed recovery preflight history is valid but inconclusive for this weekly window.";
    expect(repository.retryManagedRecoveryPreflight({
      claimToken: third.claimToken,
      wallet,
      policyVersion: third.policyVersion,
      windowStart: third.windowStart,
      expectedStep: "HISTORY",
      attemptedAt: new Date(NOW.getTime() + 5_000).toISOString(),
      nextAttemptAt: WINDOW.expiresAt,
      error: heldError
    })).toBe(true);

    expect(repository.requeueManagedRecoveryPreflightHistoryRetries({
      policyVersion: WINDOW.policyVersion,
      windowStart: WINDOW.windowStart,
      now: new Date(NOW.getTime() + 6_000).toISOString(),
      expectedLastError: heldError,
      reason: "Requeued after aligning zero concentration with the final qualification policy."
    })).toBe(1);
    expect(repository.getManagedRecoveryPreflightForWallet({
      policyVersion: WINDOW.policyVersion,
      windowStart: WINDOW.windowStart,
      wallet
    })).toMatchObject({ status: "READY", step: "HISTORY", attempts: 0 });
  });

  it("keeps provider failures retryable rather than terminal", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    saveRecoveryCandidates(repository, [record("retry-wallet")]);
    const first = claim(repository, NOW);
    expect(repository.retryManagedRecoveryPreflight({
      ...first,
      expectedStep: "PNL_30D",
      attemptedAt: NOW.toISOString(),
      nextAttemptAt: new Date(NOW.getTime() + 60_000).toISOString(),
      error: "temporary provider timeout"
    })).toBe(true);
    expect(repository.getManagedRecoveryPreflightForWallet({
      policyVersion: WINDOW.policyVersion,
      windowStart: WINDOW.windowStart,
      wallet: "retry-wallet"
    })).toMatchObject({ status: "RETRY", lastError: "temporary provider timeout" });
  });

  it("records policy rejections as terminal evidence rather than provider errors", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    saveRecoveryCandidates(repository, [record("rejected-wallet")]);
    const first = claim(repository, NOW);
    expect(repository.rejectManagedRecoveryPreflight({
      ...first,
      expectedStep: "PNL_30D",
      reasonCode: "NON_POSITIVE_30D_PNL",
      observedAt: new Date(NOW.getTime() + 1_000).toISOString(),
      expiresAt: WINDOW.expiresAt
    })).toBe(true);
    const rejected = repository.getManagedRecoveryPreflightForWallet({
      policyVersion: WINDOW.policyVersion,
      windowStart: WINDOW.windowStart,
      wallet: "rejected-wallet"
    });
    expect(rejected).toMatchObject({
      status: "REJECTED",
      reasons: ["NON_POSITIVE_30D_PNL"]
    });
    expect(rejected?.lastError).toBeUndefined();
  });

  it("selects only fresh PASS rows for the exact-history gate", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    saveRecoveryCandidates(repository, [record("passing-wallet"), record("unscored-wallet")]);
    const validAt = passPreflight(repository, "passing-wallet");

    expect(repository.listManagedWalletDeepHistoryRecoveryCandidates({
      limit: 10,
      preflightGate: {
        policyVersion: WINDOW.policyVersion,
        windowStart: WINDOW.windowStart,
        validAt
      }
    }).map((item) => item.wallet)).toEqual(["passing-wallet"]);
    expect(repository.listManagedWalletDeepHistoryRecoveryCandidates({
      limit: 10,
      preflightGate: {
        policyVersion: WINDOW.policyVersion,
        windowStart: WINDOW.windowStart,
        validAt: WINDOW.expiresAt
      }
    })).toEqual([]);
  });

  it("revalidates PASS and writes the authorization link in the v3 cohort transaction", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    saveRecoveryCandidates(repository, [record("authorized-wallet"), record("stale-wallet")]);
    const validAt = passPreflight(repository, "authorized-wallet");
    passPreflight(repository, "stale-wallet", 10_000);

    const cohort = repository.createWalletDeepHistoryCohort({
      kind: "MANAGED_RESCUE_V3",
      selectedAt: validAt,
      snapshotCutoffAt: validAt,
      windowStart: new Date(NOW.getTime() - 90 * DAY).toISOString(),
      windowEnd: validAt,
      wallets: ["authorized-wallet"],
      preflightGate: {
        policyVersion: WINDOW.policyVersion,
        windowStart: WINDOW.windowStart,
        validAt
      }
    });
    expect(cohort.id).toMatch(/^managed-rescue-v3:/u);
    const preflight = repository.getManagedRecoveryPreflightForWallet({
      policyVersion: WINDOW.policyVersion,
      windowStart: WINDOW.windowStart,
      wallet: "authorized-wallet"
    });
    expect(repository.getManagedRecoveryPreflightAuthorization(cohort.id, "authorized-wallet"))
      .toEqual({ cohortId: cohort.id, wallet: "authorized-wallet", preflightId: preflight?.id });

    expect(() => repository.createWalletDeepHistoryCohort({
      kind: "MANAGED_RESCUE_V3",
      selectedAt: WINDOW.expiresAt,
      snapshotCutoffAt: WINDOW.expiresAt,
      windowStart: new Date(Date.parse(WINDOW.expiresAt) - 90 * DAY).toISOString(),
      windowEnd: WINDOW.expiresAt,
      wallets: ["stale-wallet"],
      preflightGate: {
        policyVersion: WINDOW.policyVersion,
        windowStart: WINDOW.windowStart,
        validAt
      }
    })).toThrow(/no fresh passing managed recovery preflight/iu);

    db.prepare(`
      UPDATE managed_recovery_preflights SET expires_at = ? WHERE wallet = ?
    `).run(validAt, "stale-wallet");
    const cohortCount = (db.prepare("SELECT COUNT(*) AS count FROM wallet_deep_history_cohorts")
      .get() as { count: number }).count;
    expect(() => repository.createWalletDeepHistoryCohort({
      kind: "MANAGED_RESCUE_V3",
      selectedAt: validAt,
      snapshotCutoffAt: validAt,
      windowStart: new Date(NOW.getTime() - 90 * DAY).toISOString(),
      windowEnd: validAt,
      wallets: ["stale-wallet"],
      preflightGate: {
        policyVersion: WINDOW.policyVersion,
        windowStart: WINDOW.windowStart,
        validAt
      }
    })).toThrow(/no fresh passing managed recovery preflight/iu);
    expect((db.prepare("SELECT COUNT(*) AS count FROM wallet_deep_history_cohorts")
      .get() as { count: number }).count).toBe(cohortCount);
  });
});
