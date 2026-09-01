import { afterEach, describe, expect, it } from "vitest";
import { USDC_MINT, type IndexedSpotSwap } from "@copylab/shared";
import { openDatabase, type CopyLabDatabase } from "../src/database.js";
import { Repository } from "../src/repository.js";
import type { WalletIdentityTransactionEvidenceRecord } from "../src/local-wallet-identity.js";
import {
  IDENTITY_NOW,
  IDENTITY_PEER_A,
  IDENTITY_PEER_B,
  IDENTITY_SUBJECT,
  IDENTITY_TARGET_MINT
} from "./local-wallet-identity.fixtures.js";

const AT = "2026-03-01T00:00:00.000Z";
const PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";

function evidence(signature: string, wallet = IDENTITY_SUBJECT): WalletIdentityTransactionEvidenceRecord {
  return {
    wallet,
    signature,
    slot: 100,
    blockTime: AT,
    success: true,
    signers: [wallet],
    walletMentioned: true,
    instructionScanComplete: true,
    tokenBalanceScanComplete: true,
    swapScanComplete: true,
    mintCreations: [],
    ownerTokenDeltas: []
  };
}

function complete(
  repository: Repository,
  signature: string,
  wallet: string,
  swaps: IndexedSpotSwap[] = [],
  identity: WalletIdentityTransactionEvidenceRecord[] = []
): void {
  const cohort = repository.createWalletDeepHistoryCohort({
    selectedAt: AT,
    snapshotCutoffAt: AT,
    windowStart: "2025-12-01T00:00:00.000Z",
    windowEnd: AT,
    wallets: [wallet]
  });
  repository.enqueueWalletIndexTransactions([{
    signature,
    sourceAddress: wallet,
    wallet,
    source: "helius-wallet-deep-history",
    discoveredAt: AT,
    slot: 100,
    blockTime: AT,
    metadata: { failed: false, cohortId: cohort.id, generationId: cohort.generationId }
  }]);
  const leased = repository.leaseWalletIndexTransactions("identity-test", 1, 60, new Date(AT))[0]!;
  expect(repository.completeWalletIndexTransaction({
    ...leased,
    slot: 100,
    blockTime: AT,
    success: true,
    sourceWallets: [wallet],
    updatedAt: AT
  }, swaps, leased.leaseToken!, new Date(AT), identity)).toBe(true);
}

function buy(signature: string, wallet: string): IndexedSpotSwap {
  return {
    id: `${signature}:${wallet}:0`,
    signature,
    wallet,
    swapIndex: 0,
    slot: 100,
    blockTime: AT,
    side: "BUY",
    baseMint: USDC_MINT,
    targetMint: IDENTITY_TARGET_MINT,
    inputMint: USDC_MINT,
    outputMint: IDENTITY_TARGET_MINT,
    inputAmountAtomic: "1000000",
    outputAmountAtomic: "100",
    inputAmountUi: 1,
    outputAmountUi: 100,
    eligible: true,
    eligibilityReasons: [],
    programIds: [PROGRAM],
    indexedAt: AT
  };
}

describe("wallet identity persistence and exact coverage", () => {
  let db: CopyLabDatabase | undefined;
  afterEach(() => db?.close());

  it("migrates schema 17 with normalized evidence and first-pool tables", () => {
    db = openDatabase(":memory:");
    expect(db.pragma("user_version", { simple: true })).toBeGreaterThanOrEqual(17);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
    expect(tables.map((row) => row.name)).toEqual(expect.arrayContaining([
      "wallet_identity_transaction_evidence",
      "wallet_identity_first_pools"
    ]));
  });

  it("atomically stores minimal evidence and reports exact deep-history coverage", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    complete(repository, "sig-evidence", IDENTITY_SUBJECT, [], [evidence("sig-evidence")]);

    expect(repository.walletIdentityEvidenceCoverage(IDENTITY_SUBJECT)).toEqual({
      sourceSignatures: 1,
      processedSignatures: 1,
      evidenceSignatures: 1,
      missingEvidence: 0
    });
    expect(repository.listWalletIdentityTransactionEvidence(
      IDENTITY_SUBJECT,
      "2026-01-01T00:00:00.000Z",
      "2026-04-01T00:00:00.000Z"
    )).toEqual([evidence("sig-evidence")]);
    const transaction = db.prepare("SELECT transaction_json FROM indexed_transactions WHERE signature = ?")
      .get("sig-evidence") as { transaction_json: string };
    expect(JSON.parse(transaction.transaction_json)).not.toHaveProperty("raw");
  });

  it("never commits identity evidence with a stale lease token", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const cohort = repository.createWalletDeepHistoryCohort({
      selectedAt: AT,
      snapshotCutoffAt: AT,
      windowStart: "2025-12-01T00:00:00.000Z",
      windowEnd: AT,
      wallets: [IDENTITY_SUBJECT]
    });
    repository.enqueueWalletIndexTransactions([{
      signature: "sig-stale",
      sourceAddress: IDENTITY_SUBJECT,
      wallet: IDENTITY_SUBJECT,
      source: "helius-wallet-deep-history",
      discoveredAt: AT,
      slot: 100,
      blockTime: AT,
      metadata: { cohortId: cohort.id, generationId: cohort.generationId }
    }]);
    const leased = repository.leaseWalletIndexTransactions("identity-test", 1, 60, new Date(AT))[0]!;
    expect(repository.completeWalletIndexTransaction({
      ...leased,
      slot: 100,
      blockTime: AT,
      success: true,
      sourceWallets: [IDENTITY_SUBJECT],
      updatedAt: AT
    }, [], "stale", new Date(AT), [evidence("sig-stale")])).toBe(false);
    expect(repository.walletIdentityEvidenceCoverage(IDENTITY_SUBJECT)).toMatchObject({ evidenceSignatures: 0 });
  });

  it("rejects identity evidence without the exact wallet deep-history source link", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    repository.enqueueWalletIndexTransactions([{
      signature: "sig-forged",
      sourceAddress: PROGRAM,
      source: "helius-program-head",
      discoveredAt: AT,
      slot: 100,
      blockTime: AT
    }]);
    const leased = repository.leaseWalletIndexTransactions("identity-test", 1, 60, new Date(AT))[0]!;
    expect(() => repository.completeWalletIndexTransaction({
      ...leased,
      slot: 100,
      blockTime: AT,
      success: true,
      sourceWallets: [],
      updatedAt: AT
    }, [], leased.leaseToken!, new Date(AT), [evidence("sig-forged")])).toThrow(
      "no matching deep-history source link"
    );
    expect(repository.getWalletIndexTransaction("sig-forged")).toMatchObject({ status: "LEASED" });
  });

  it("caches Jupiter firstPoolAt monotonically, including a null fail-closed result", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    repository.saveWalletIdentityFirstPool({
      mint: IDENTITY_TARGET_MINT,
      source: "JUPITER",
      firstPoolAt: null,
      checkedAt: "2026-01-01T00:00:00.000Z"
    });
    repository.saveWalletIdentityFirstPool({
      mint: IDENTITY_TARGET_MINT,
      source: "JUPITER",
      firstPoolAt: "2025-12-01T00:00:00.000Z",
      checkedAt: IDENTITY_NOW.toISOString()
    });
    repository.saveWalletIdentityFirstPool({
      mint: IDENTITY_TARGET_MINT,
      source: "JUPITER",
      firstPoolAt: null,
      checkedAt: "2026-01-02T00:00:00.000Z"
    });

    expect(repository.getWalletIdentityFirstPool(IDENTITY_TARGET_MINT)).toEqual({
      mint: IDENTITY_TARGET_MINT,
      source: "JUPITER",
      firstPoolAt: "2025-12-01T00:00:00.000Z",
      checkedAt: IDENTITY_NOW.toISOString()
    });
  });

  it("returns peer buys only after every configured program head and slot hydration is complete", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    for (const [signature, wallet] of [
      ["sig-subject", IDENTITY_SUBJECT],
      ["sig-peer-a", IDENTITY_PEER_A],
      ["sig-peer-b", IDENTITY_PEER_B]
    ] as const) {
      complete(repository, signature, wallet, [buy(signature, wallet)]);
      repository.enqueueWalletIndexTransactions([{
        signature,
        sourceAddress: PROGRAM,
        source: "helius-program-head",
        discoveredAt: AT,
        slot: 100,
        blockTime: AT
      }]);
    }
    repository.saveWalletIndexCheckpoint({
      pipeline: "helius-jupiter-program-head",
      partition: PROGRAM,
      completed: false,
      updatedAt: AT,
      lastSignature: "sig-subject",
      slot: 110,
      metadata: { coverageStartSlot: 90, coverageEndSlot: 110 }
    });

    const subject = buy("sig-subject", IDENTITY_SUBJECT);
    const peers = repository.listCoordinatedBuyEvidence([subject]);
    expect(peers).toMatchObject({ complete: true, rows: expect.arrayContaining([
      expect.objectContaining({ wallet: IDENTITY_SUBJECT }),
      expect.objectContaining({ wallet: IDENTITY_PEER_A }),
      expect.objectContaining({ wallet: IDENTITY_PEER_B })
    ]) });
    expect(repository.walletIdentityProgramSlotCoverage([PROGRAM], [100])).toEqual({
      complete: true,
      reasons: []
    });

    repository.enqueueWalletIndexTransactions([{
      signature: "sig-pending-peer",
      sourceAddress: PROGRAM,
      source: "helius-program-head",
      discoveredAt: AT,
      slot: 100,
      blockTime: AT
    }]);
    expect(repository.walletIdentityProgramSlotCoverage([PROGRAM], [100])).toMatchObject({
      complete: false,
      reasons: [expect.stringContaining("unhydrated signatures")]
    });
    expect(repository.walletIdentityProgramSlotCoverage([PROGRAM], [89])).toMatchObject({
      complete: false,
      reasons: [expect.stringContaining("does not cover slot")]
    });
  });
});
