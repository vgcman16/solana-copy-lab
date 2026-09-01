import { afterEach, describe, expect, it } from "vitest";
import type { IndexedSpotSwap } from "@copylab/shared";
import {
  JUPITER_V6_PROGRAM_ID,
  type CoarseWalletCandidateEvidence,
  type CoarseWalletCandidateRejection
} from "@copylab/providers";
import type { CopyLabDatabase } from "../src/database.js";
import { openDatabase } from "../src/database.js";
import { Repository } from "../src/repository.js";
import {
  COARSE_WALLET_REJECTED_SOURCE,
  WALLET_DISCOVERY_ATTRIBUTION_SOURCES,
  exactWalletDiscoveryFields,
  materializeCoarseWalletCandidate,
  recordRejectedCoarseWalletCandidate
} from "../src/coarse-wallet-discovery.js";

const NOW = new Date("2027-01-15T00:00:00Z");
const WALLET_A = "Vote111111111111111111111111111111111111111";
const WALLET_B = "Stake11111111111111111111111111111111111111";

function evidence(wallet: string, signature: string): CoarseWalletCandidateEvidence {
  return {
    accepted: true,
    tier: "COARSE_SIGNER",
    sourceSignature: signature,
    sourceProgram: JUPITER_V6_PROGRAM_ID,
    wallet,
    slot: 42,
    blockTime: NOW.toISOString(),
    observedAt: NOW.toISOString(),
    directInvocation: true,
    signerCount: 1,
    transactionSuccess: true
  };
}

function rejection(signature: string): CoarseWalletCandidateRejection {
  return {
    accepted: false,
    tier: "COARSE_SIGNER",
    sourceSignature: signature,
    sourceProgram: JUPITER_V6_PROGRAM_ID,
    observedAt: NOW.toISOString(),
    reasonCode: "JUPITER_CPI_ONLY"
  };
}

function persistSuccessfulProgramTransaction(
  repository: Repository,
  signature: string,
  wallet: string,
  secondsOffset: number
): void {
  const blockTime = new Date(NOW.getTime() + secondsOffset * 1_000).toISOString();
  repository.enqueueWalletIndexTransactions([{
    signature,
    sourceAddress: JUPITER_V6_PROGRAM_ID,
    source: "helius-program-signature",
    discoveredAt: NOW.toISOString(),
    slot: 42 + secondsOffset,
    blockTime,
    metadata: { failed: false }
  }]);
  const leased = repository.leaseWalletIndexTransactions("test-worker", 1, 60, NOW)[0];
  if (!leased?.leaseToken) throw new Error("Expected a leased transaction");
  expect(repository.completeWalletIndexTransaction({
    ...leased,
    success: true,
    feePayer: wallet,
    sourceWallets: [],
    accountKeys: [wallet, JUPITER_V6_PROGRAM_ID],
    programIds: [JUPITER_V6_PROGRAM_ID],
    updatedAt: blockTime
  }, [], leased.leaseToken, NOW)).toBe(true);
}

describe("coarse wallet discovery persistence", () => {
  let db: CopyLabDatabase | undefined;
  afterEach(() => db?.close());

  it("materializes zero swap claims, persists provenance, stays idempotent, and obeys the target cap", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    persistSuccessfulProgramTransaction(repository, "a".repeat(88), WALLET_A, 0);
    persistSuccessfulProgramTransaction(repository, "b".repeat(88), WALLET_B, 1);

    expect(materializeCoarseWalletCandidate(repository, evidence(WALLET_A, "a".repeat(88)), 1, 7))
      .toBe("ADDED");
    expect(repository.getWalletIndexRecord(WALLET_A)).toMatchObject({
      discoveryTier: "COARSE_SIGNER",
      discoveryObservedSuccessfulTransactions: 7,
      spotSwapCount: 0,
      eligibleSpotSwapCount: 0,
      closedEligibleSwaps: 0,
      successfulTransactionCount: 0,
      preScreenEligible: false,
      preScreenReasons: ["pending activity pre-screen"]
    });
    expect(materializeCoarseWalletCandidate(repository, evidence(WALLET_A, "a".repeat(88)), 1, 7))
      .toBe("EXISTING");
    expect(materializeCoarseWalletCandidate(repository, evidence(WALLET_B, "b".repeat(88)), 1, 2))
      .toBe("TARGET_REACHED");
    expect(repository.walletIndexCoverage().indexedWallets).toBe(1);
    const attributions = repository.listWalletIndexTransactionSources("a".repeat(88))
      .filter((source) => source.source === "local-coarse-signer-accepted");
    expect(attributions).toHaveLength(1);
    expect(attributions[0]).toMatchObject({
      wallet: WALLET_A,
      metadata: { tier: "COARSE_SIGNER", accepted: true, directInvocation: true }
    });
  });

  it("ranks the bounded bootstrap by observed successful activity and advances past audited rejections", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    persistSuccessfulProgramTransaction(repository, "1".repeat(88), WALLET_A, 0);
    persistSuccessfulProgramTransaction(repository, "2".repeat(88), WALLET_A, 2);
    persistSuccessfulProgramTransaction(repository, "3".repeat(88), WALLET_B, 1);

    expect(repository.listCoarseWalletBootstrapCandidates(
      [JUPITER_V6_PROGRAM_ID],
      WALLET_DISCOVERY_ATTRIBUTION_SOURCES,
      2
    )).toMatchObject([
      { signature: "2".repeat(88), wallet: WALLET_A, observedSuccessfulTransactions: 2 },
      { signature: "3".repeat(88), wallet: WALLET_B, observedSuccessfulTransactions: 1 }
    ]);

    expect(recordRejectedCoarseWalletCandidate(repository, rejection("2".repeat(88)), 2)).toBe(true);
    expect(recordRejectedCoarseWalletCandidate(repository, rejection("2".repeat(88)), 2)).toBe(false);
    expect(repository.listCoarseWalletBootstrapCandidates(
      [JUPITER_V6_PROGRAM_ID],
      WALLET_DISCOVERY_ATTRIBUTION_SOURCES,
      1
    )[0]).toMatchObject({
      signature: "1".repeat(88),
      wallet: WALLET_A,
      observedSuccessfulTransactions: 2
    });
    expect(repository.listWalletIndexTransactionSources("2".repeat(88)))
      .toContainEqual(expect.objectContaining({ source: COARSE_WALLET_REJECTED_SOURCE }));
  });

  it("uses a covering successful-fee-payer index instead of sorting transaction payload rows", () => {
    db = openDatabase(":memory:");
    const index = db.prepare(`
      SELECT sql
      FROM sqlite_master
      WHERE type = 'index' AND name = 'indexed_transactions_coarse_wallet_candidates'
    `).get() as { sql: string } | undefined;
    expect(index?.sql).toContain("fee_payer, block_time DESC, signature, slot, success");
    const plan = db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT fee_payer, block_time, signature, slot
      FROM indexed_transactions
      WHERE success = 1 AND fee_payer IS NOT NULL AND fee_payer <> ''
      ORDER BY fee_payer, block_time DESC, signature
    `).all() as Array<{ detail: string }>;
    const details = plan.map((step) => step.detail).join("\n");
    expect(details).toContain("USING COVERING INDEX indexed_transactions_coarse_wallet_candidates");
    expect(details).not.toContain("USE TEMP B-TREE FOR ORDER BY");
  });

  it("upgrades coarse provenance to exact swap evidence and never downgrades it", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    persistSuccessfulProgramTransaction(repository, "4".repeat(88), WALLET_A, 0);
    materializeCoarseWalletCandidate(repository, evidence(WALLET_A, "4".repeat(88)), 5);
    const coarse = repository.getWalletIndexRecord(WALLET_A);
    if (!coarse) throw new Error("Expected a coarse wallet record");
    const swap = {
      id: "exact-swap",
      signature: "4".repeat(88),
      wallet: WALLET_A,
      swapIndex: 0,
      slot: 42,
      blockTime: NOW.toISOString(),
      side: "BUY",
      baseMint: "So11111111111111111111111111111111111111112",
      targetMint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6zSsrPeAC8B1pPB",
      inputMint: "So11111111111111111111111111111111111111112",
      outputMint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6zSsrPeAC8B1pPB",
      inputAmountAtomic: "1",
      outputAmountAtomic: "1",
      inputAmountUi: 1,
      outputAmountUi: 1,
      eligible: true,
      eligibilityReasons: [],
      programIds: [JUPITER_V6_PROGRAM_ID],
      indexedAt: NOW.toISOString()
    } satisfies IndexedSpotSwap;
    repository.upsertWalletIndexRecord({
      ...coarse,
      ...exactWalletDiscoveryFields(swap, JUPITER_V6_PROGRAM_ID),
      spotSwapCount: 1,
      eligibleSpotSwapCount: 1,
      updatedAt: new Date(NOW.getTime() + 1_000).toISOString()
    });
    materializeCoarseWalletCandidate(
      repository,
      { ...evidence(WALLET_A, "4".repeat(88)), observedAt: new Date(NOW.getTime() + 2_000).toISOString() },
      5,
      10
    );
    expect(repository.getWalletIndexRecord(WALLET_A)).toMatchObject({
      discoveryTier: "EXACT_SWAP",
      discoveryProvenance: { source: "STRICT_NORMALIZED_SWAP" },
      spotSwapCount: 1
    });
  });
});
