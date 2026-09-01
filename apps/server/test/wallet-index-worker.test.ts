import { afterEach, describe, expect, it, vi } from "vitest";
import { SOL_MINT, USDC_MINT, type IndexedSpotSwap, type WalletIndexRecord } from "@copylab/shared";
import type {
  HeliusIndexRpc,
  HeliusSignatureInfo,
  HeliusSignaturePageRequest
} from "@copylab/providers";
import { ORCA_WHIRLPOOL_PROGRAM_ID, ProviderApiError } from "@copylab/providers";
import type { CopyLabDatabase } from "../src/database.js";
import { openDatabase } from "../src/database.js";
import { Repository } from "../src/repository.js";
import { WalletIndexWorker } from "../src/wallet-index-worker.js";
import { WalletAcquisitionController } from "../src/wallet-acquisition-controller.js";

const PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const JUPITER_EVENT_AUTHORITY = "D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf";
const RAYDIUM_CPMM_PROGRAM = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C";
const USDC_ACCOUNT = "UsdcAccount1111111111111111111111111111111";
const TARGET_ACCOUNT = "TargetAccount11111111111111111111111111111";
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const WALLET = "Vote111111111111111111111111111111111111111";
const TARGET = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6zSsrPeAC8B1pPB";
const SIGNATURE = "5".repeat(88);
const NOW = new Date("2027-01-15T00:00:00Z");

function base58Encode(bytes: readonly number[]): string {
  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);
  let encoded = "";
  while (value > 0n) {
    encoded = BASE58_ALPHABET[Number(value % 58n)] + encoded;
    value /= 58n;
  }
  let leadingZeroes = 0;
  while (bytes[leadingZeroes] === 0) leadingZeroes += 1;
  return `${"1".repeat(leadingZeroes)}${encoded}`;
}

function u16(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff];
}

function u32(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

function u64(value: bigint): number[] {
  return Array.from({ length: 8 }, (_unused, index) => Number((value >> BigInt(index * 8)) & 0xffn));
}

const JUPITER_ROUTE_DATA = base58Encode([
  229, 23, 203, 151, 122, 227, 173, 42,
  ...u32(1),
  7, 100, 0, 1,
  ...u64(5_000_000n),
  ...u64(2_500_000n),
  ...u16(50),
  0
]);

const RAYDIUM_SWAP_DATA = "E73fXHPWvSR8VCr6ujjfVSBYgv1v9V5Dy";

function jupiterRouteAccounts(): string[] {
  return [
    TOKEN_PROGRAM,
    WALLET,
    USDC_ACCOUNT,
    TARGET_ACCOUNT,
    TARGET_ACCOUNT,
    TARGET,
    PROGRAM,
    JUPITER_EVENT_AUTHORITY,
    PROGRAM
  ];
}

function confirmedSwap(): unknown {
  return {
    slot: 42,
    blockTime: Math.floor(NOW.getTime() / 1_000),
    transaction: {
      message: {
        accountKeys: [
          { pubkey: WALLET, signer: true, writable: true },
          { pubkey: USDC_ACCOUNT, signer: false, writable: true },
          { pubkey: TARGET_ACCOUNT, signer: false, writable: true }
        ],
        instructions: [{ programId: PROGRAM, accounts: jupiterRouteAccounts(), data: JUPITER_ROUTE_DATA }]
      }
    },
    meta: {
      err: null,
      fee: 5_000,
      preBalances: [1_000_000],
      postBalances: [995_000],
      preTokenBalances: [
        { accountIndex: 1, owner: WALLET, mint: USDC_MINT, uiTokenAmount: { amount: "10000000", decimals: 6 } },
        { accountIndex: 2, owner: WALLET, mint: TARGET, uiTokenAmount: { amount: "0", decimals: 6 } }
      ],
      postTokenBalances: [
        { accountIndex: 1, owner: WALLET, mint: USDC_MINT, uiTokenAmount: { amount: "5000000", decimals: 6 } },
        { accountIndex: 2, owner: WALLET, mint: TARGET, uiTokenAmount: { amount: "2500000", decimals: 6 } }
      ],
      innerInstructions: [{
        index: 0,
        instructions: [{ programId: RAYDIUM_CPMM_PROGRAM, accounts: [], data: RAYDIUM_SWAP_DATA }]
      }],
      logMessages: [`Program ${PROGRAM} invoke [1]`]
    }
  };
}

function rawBlockTransaction(signature: string, failed = false): Record<string, unknown> {
  const swap = confirmedSwap() as {
    meta: Record<string, unknown>;
  };
  return {
    transaction: {
      signatures: [signature],
      message: {
        header: {
          numRequiredSignatures: 1,
          numReadonlySignedAccounts: 0,
          numReadonlyUnsignedAccounts: 1
        },
        accountKeys: [
          WALLET,
          USDC_ACCOUNT,
          TARGET_ACCOUNT,
          PROGRAM,
          TOKEN_PROGRAM,
          TARGET,
          JUPITER_EVENT_AUTHORITY,
          RAYDIUM_CPMM_PROGRAM
        ],
        recentBlockhash: "7".repeat(32),
        instructions: [{
          programIdIndex: 3,
          accounts: [4, 0, 1, 2, 2, 5, 3, 6, 3],
          data: JUPITER_ROUTE_DATA
        }]
      }
    },
    meta: {
      ...swap.meta,
      err: failed ? { InstructionError: [0, "Custom"] } : null,
      innerInstructions: [{
        index: 0,
        instructions: [{ programIdIndex: 7, accounts: [], data: RAYDIUM_SWAP_DATA }]
      }]
    },
    version: 0
  };
}

function rawBlock(signatures: readonly string[], failed = new Set<string>()): unknown {
  return {
    blockTime: NOW.getTime() / 1_000,
    transactions: signatures.map((signature) => rawBlockTransaction(signature, failed.has(signature)))
  };
}

function parsedBlockTransaction(signature: string): Record<string, unknown> {
  const swap = confirmedSwap() as {
    transaction: { message: Record<string, unknown> };
    meta: Record<string, unknown> & {
      innerInstructions: Array<{ index: number; instructions: unknown[] }>;
    };
  };
  return {
    transaction: {
      signatures: [signature],
      message: swap.transaction.message
    },
    meta: {
      ...swap.meta,
      innerInstructions: [{
        index: 0,
        instructions: [
          ...(swap.meta.innerInstructions[0]?.instructions ?? []),
          {
            program: "spl-token",
            programId: TOKEN_PROGRAM,
            stackHeight: 2,
            parsed: {
              type: "transfer",
              info: { source: USDC_ACCOUNT, destination: TARGET_ACCOUNT }
            }
          }
        ]
      }]
    },
    version: 0
  };
}

function parsedBlock(signatures: readonly string[]): unknown {
  return {
    blockTime: NOW.getTime() / 1_000,
    transactions: signatures.map(parsedBlockTransaction)
  };
}

function rawBlockWithUnparsedTokenInstruction(signatures: readonly string[]): unknown {
  const block = rawBlock(signatures) as { transactions: Array<Record<string, unknown>> };
  for (const transaction of block.transactions) {
    const meta = transaction.meta as {
      innerInstructions: Array<{ index: number; instructions: unknown[] }>;
    };
    meta.innerInstructions[0]?.instructions.push({
      programIdIndex: 4,
      accounts: [1, 2, 0],
      data: "3"
    });
  }
  return block;
}

function activityRows(): HeliusSignatureInfo[] {
  const nowSeconds = NOW.getTime() / 1_000;
  return [0, 8, 15].flatMap((days, group) =>
    Array.from({ length: 20 }, (_, index) => ({
      signature: `${group}-${index}`,
      slot: group * 100 + index,
      blockTime: nowSeconds - days * 86_400,
      failed: false
    }))
  ).concat([{
    signature: "old",
    slot: 999,
    blockTime: nowSeconds - 91 * 86_400,
    failed: false
  }]);
}

function walletKey(index: number): string {
  return base58Encode(Array.from({ length: 32 }, (_unused, offset) => (index * 17 + offset) % 256));
}

function pendingWalletRecord(wallet: string, updatedAt = NOW.toISOString()): WalletIndexRecord {
  return {
    wallet,
    firstSeenAt: updatedAt,
    lastSeenAt: updatedAt,
    historyDays: 0,
    transactionCount: 0,
    successfulTransactionCount: 0,
    spotSwapCount: 0,
    eligibleSpotSwapCount: 0,
    closedEligibleSwaps: 0,
    buyCount: 0,
    sellCount: 0,
    activeDays: 0,
    activeWeeks: 0,
    distinctMints: 0,
    medianHoldingMinutes: 0,
    preScreenEligible: false,
    preScreenReasons: ["pending activity pre-screen"],
    updatedAt
  };
}

function persistManagedRescueCandidate(
  repository: Repository,
  wallet: string,
  successfulTransactions: number
): WalletIndexRecord {
  const record: WalletIndexRecord = {
    ...pendingWalletRecord(wallet),
    firstSeenAt: new Date(NOW.getTime() - 90 * 86_400_000).toISOString(),
    lastSeenAt: NOW.toISOString(),
    historyDays: 90,
    transactionCount: successfulTransactions,
    successfulTransactionCount: successfulTransactions,
    spotSwapCount: 10,
    eligibleSpotSwapCount: 10,
    activeDays: 20,
    activeWeeks: 4,
    distinctMints: 5,
    preScreenEligible: true,
    preScreenReasons: [],
    deepHistoryStatus: "AWAITING",
    structuralEligible: false,
    structuralReasons: ["awaiting local deep history"]
  };
  repository.upsertWalletIndexRecord(record);
  repository.saveWalletPreScreenSnapshot({
    wallet,
    runId: `rescue-${wallet}`,
    calculatedAt: NOW.toISOString(),
    eligible: true,
    reasons: [],
    record
  });
  const prior = repository.createWalletDeepHistoryCohort({
    selectedAt: NOW.toISOString(),
    snapshotCutoffAt: NOW.toISOString(),
    windowStart: new Date(NOW.getTime() - 90 * 86_400_000).toISOString(),
    windowEnd: NOW.toISOString(),
    wallets: [wallet]
  });
  repository.saveManagedCoarseCopyabilitySkip({
    cohortId: prior.id,
    wallet,
    policyVersion: "worker-rescue-floor-test-v1",
    thresholdMinutes: 15,
    decidedAt: NOW.toISOString()
  });
  if (!repository.markWalletDeepHistoryCohortManagedScreened(
    prior.id,
    "worker-rescue-floor-test-v1",
    NOW
  )) throw new Error("Expected the prior managed rescue cohort to be screened");
  if (!repository.markWalletDeepHistoryGenerationManagedScreened(
    prior.generationId,
    "worker-rescue-floor-test-v1",
    NOW
  )) throw new Error("Expected the prior managed rescue generation to be screened");
  return record;
}

function persistCoarseSourceTransaction(
  repository: Repository,
  signature: string,
  wallet: string,
  secondsOffset = 0
): void {
  const observedAt = new Date(NOW.getTime() + secondsOffset * 1_000).toISOString();
  repository.enqueueWalletIndexTransactions([{
    signature,
    sourceAddress: PROGRAM,
    source: "helius-program-signature",
    discoveredAt: observedAt,
    slot: 42 + secondsOffset,
    blockTime: observedAt,
    metadata: { failed: false }
  }]);
  const leased = repository.leaseWalletIndexTransactions("coarse-test", 1, 60, new Date(observedAt))[0];
  if (!leased?.leaseToken || leased.signature !== signature) {
    throw new Error("Expected the coarse source transaction lease");
  }
  const completed = repository.completeWalletIndexTransaction({
    ...leased,
    success: true,
    feePayer: wallet,
    sourceWallets: [],
    accountKeys: [wallet, PROGRAM],
    programIds: [PROGRAM],
    updatedAt: observedAt
  }, [], leased.leaseToken, new Date(observedAt));
  if (!completed) throw new Error("Expected the coarse source transaction to complete");
}

function confirmedSwapForWallet(wallet: string): unknown {
  return JSON.parse(JSON.stringify(confirmedSwap()).replaceAll(WALLET, wallet)) as unknown;
}

function persistUnpricedSolSwaps(
  repository: Repository,
  count: number,
  wallet = WALLET
): IndexedSpotSwap[] {
  const signature = `sol-reprice-batch-${wallet}-${count}`;
  const blockTime = new Date(NOW.getTime() - 60_000).toISOString();
  const swaps = Array.from({ length: count }, (_, index): IndexedSpotSwap => ({
    id: `${signature}:${index}`,
    signature,
    wallet,
    swapIndex: index,
    slot: 50,
    blockTime,
    side: "BUY",
    baseMint: SOL_MINT,
    targetMint: TARGET,
    inputMint: SOL_MINT,
    outputMint: TARGET,
    inputAmountAtomic: "1000000000",
    outputAmountAtomic: "10000000",
    inputAmountUi: 1,
    outputAmountUi: 10,
    eligible: true,
    eligibilityReasons: [],
    programIds: [PROGRAM],
    indexedAt: blockTime
  }));
  repository.enqueueWalletIndexTransactions([{
    signature,
    sourceAddress: PROGRAM,
    wallet,
    source: "reprice-batch-test",
    discoveredAt: blockTime,
    slot: 50,
    blockTime,
    metadata: { failed: false }
  }]);
  const leased = repository.leaseWalletIndexTransactions("reprice-batch-test", 1, 60, NOW)[0];
  if (!leased?.leaseToken) throw new Error("Expected the SOL reprice fixture to lease its source transaction");
  if (!repository.completeWalletIndexTransaction({
    ...leased,
    success: true,
    sourceWallets: [wallet],
    updatedAt: NOW.toISOString()
  }, swaps, leased.leaseToken, NOW)) {
    throw new Error("Expected the SOL reprice fixture transaction to complete");
  }
  return swaps;
}

describe("WalletIndexWorker", () => {
  let db: CopyLabDatabase | undefined;
  afterEach(() => db?.close());

  it("rejects managed unpriced completion when self-hosted identity evidence is enabled", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const rpc: HeliusIndexRpc = {
      getSignaturesForAddress: async () => [],
      getTransaction: async () => null
    };

    expect(() => new WalletIndexWorker(repository, "unused-in-test", undefined, {
      rpc,
      programIds: new Set([PROGRAM]),
      deepHistoryAllowUnpricedStructuralCompletion: true,
      identityEvidenceEnabled: true
    })).toThrow(/cannot be enabled with self-hosted identity evidence/i);
  });

  it("prioritizes a managed prescreen backlog and caps concurrent wallet reads at four", async () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const prescreenWallets = Array.from({ length: 7 }, (_unused, index) => `prescreen-wallet-${index}`);
    for (const wallet of prescreenWallets) repository.upsertWalletIndexRecord(pendingWalletRecord(wallet));
    persistCoarseSourceTransaction(repository, "coarse-waits-for-prescreen", walletKey(90));
    let activeWalletReads = 0;
    let maximumWalletReads = 0;
    let transactionReads = 0;
    const worker = new WalletIndexWorker(repository, "unused-in-test", undefined, {
      rpc: {
        getSignaturesForAddress: async () => {
          activeWalletReads += 1;
          maximumWalletReads = Math.max(maximumWalletReads, activeWalletReads);
          await new Promise<void>((resolve) => setImmediate(resolve));
          activeWalletReads -= 1;
          return activityRows();
        },
        getTransaction: async () => {
          transactionReads += 1;
          return confirmedSwapForWallet(walletKey(90));
        }
      },
      programIds: new Set([PROGRAM]),
      targetWallets: 20,
      preScreenBatchSize: prescreenWallets.length,
      deepHistoryEnabled: false,
      deepHistoryAllowUnpricedStructuralCompletion: true,
      programHeadMaintenanceEnabled: false,
      now: () => new Date(NOW)
    });

    expect(await worker.runOnce()).toBe(true);
    expect(maximumWalletReads).toBe(4);
    expect(transactionReads).toBe(0);
    expect(repository.listWalletsAwaitingPreScreen(100)).toEqual([]);
    expect((repository.db.prepare("SELECT COUNT(*) AS count FROM wallet_prescreen_snapshots").get() as {
      count: number;
    }).count).toBe(prescreenWallets.length);
  });

  it("caps coarse payload reads at four while committing every admitted wallet once", async () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const candidates = Array.from({ length: 7 }, (_unused, index) => ({
      signature: `coarse-concurrency-${index}`,
      wallet: walletKey(index + 1)
    }));
    for (const [index, candidate] of candidates.entries()) {
      persistCoarseSourceTransaction(repository, candidate.signature, candidate.wallet, index);
    }
    let activeReads = 0;
    let maximumReads = 0;
    const bySignature = new Map(candidates.map((candidate) => [candidate.signature, candidate.wallet]));
    const worker = new WalletIndexWorker(repository, "unused-in-test", undefined, {
      rpc: {
        getSignaturesForAddress: async () => [],
        getTransaction: async (signature) => {
          activeReads += 1;
          maximumReads = Math.max(maximumReads, activeReads);
          await new Promise<void>((resolve) => setImmediate(resolve));
          activeReads -= 1;
          const wallet = bySignature.get(signature);
          if (!wallet) throw new Error("Unexpected coarse signature");
          return confirmedSwapForWallet(wallet);
        }
      },
      programIds: new Set([PROGRAM]),
      targetWallets: candidates.length,
      coarseBootstrapBatchSize: candidates.length,
      deepHistoryEnabled: false,
      deepHistoryAllowUnpricedStructuralCompletion: true,
      programHeadMaintenanceEnabled: false,
      now: () => new Date(NOW)
    });

    expect(await worker.runOnce()).toBe(true);
    expect(maximumReads).toBe(4);
    expect(repository.walletIndexCoverage().indexedWallets).toBe(candidates.length);
    expect(new Set(repository.listWalletIndexRecords(100).map((record) => record.wallet)))
      .toEqual(new Set(candidates.map((candidate) => candidate.wallet)));
    expect((repository.db.prepare(`
      SELECT COUNT(*) AS count FROM index_signature_sources
      WHERE source = 'local-coarse-signer-accepted'
    `).get() as { count: number }).count).toBe(candidates.length);
  });

  it("admits the highest-activity coarse wallets deterministically at the target and stays idempotent", async () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const ranked = [
      { wallet: walletKey(30), observations: 3, label: "high" },
      { wallet: walletKey(31), observations: 2, label: "middle" },
      { wallet: walletKey(32), observations: 1, label: "low" }
    ];
    const signatureWallet = new Map<string, string>();
    for (const candidate of ranked) {
      for (let index = 0; index < candidate.observations; index += 1) {
        const signature = `${candidate.label}-${index}`;
        signatureWallet.set(signature, candidate.wallet);
        persistCoarseSourceTransaction(repository, signature, candidate.wallet, index);
      }
    }
    let calls = 0;
    const worker = new WalletIndexWorker(repository, "unused-in-test", undefined, {
      rpc: {
        getSignaturesForAddress: async () => [],
        getTransaction: async (signature) => {
          calls += 1;
          // Reverse completion timing must not reverse admission order.
          await new Promise<void>((resolve) => setTimeout(resolve, signature.startsWith("high") ? 5 : 0));
          const wallet = signatureWallet.get(signature);
          if (!wallet) throw new Error("Unexpected ranked coarse signature");
          return confirmedSwapForWallet(wallet);
        }
      },
      programIds: new Set([PROGRAM]),
      targetWallets: 2,
      coarseBootstrapBatchSize: 10,
      deepHistoryEnabled: false,
      deepHistoryAllowUnpricedStructuralCompletion: true,
      programHeadMaintenanceEnabled: false,
      now: () => new Date(NOW)
    });

    expect(await worker.runOnce()).toBe(true);
    expect(repository.listWalletIndexRecords(10).map((record) => record.wallet).sort())
      .toEqual(ranked.slice(0, 2).map((candidate) => candidate.wallet).sort());
    const callsAtTarget = calls;
    expect(await worker.runOnce()).toBe(true); // bounded prescreen for the admitted pair
    expect(await worker.runOnce()).toBe(false); // target remains complete
    expect(calls).toBe(callsAtTarget);
    expect(repository.walletIndexCoverage().indexedWallets).toBe(2);
    expect((repository.db.prepare(`
      SELECT COUNT(*) AS count FROM index_signature_sources
      WHERE source = 'local-coarse-signer-accepted'
    `).get() as { count: number }).count).toBe(2);
  });

  it("runs discovery, hydration, normalized indexing, pre-screening, and completion end to end", async () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const requests: Array<{ address: string; request?: HeliusSignaturePageRequest }> = [];
    const rpc: HeliusIndexRpc = {
      getSignaturesForAddress: async (address, request) => {
        requests.push({ address, ...(request ? { request } : {}) });
        if (address === PROGRAM) {
          return [{
            signature: SIGNATURE,
            slot: 42,
            blockTime: NOW.getTime() / 1_000,
            confirmationStatus: "confirmed",
            failed: false
          }];
        }
        return activityRows();
      },
      getTransaction: async () => confirmedSwap()
    };
    const worker = new WalletIndexWorker(repository, "unused-in-test", undefined, {
      rpc,
      programIds: new Set([PROGRAM]),
      targetWallets: 1,
      hydrationBatchSize: 5,
      preScreenBatchSize: 5,
      deepHistoryEnabled: false,
      now: () => new Date(NOW)
    });

    expect(await worker.runOnce()).toBe(true);
    expect(repository.walletIndexCoverage().queueByStatus.PENDING).toBe(1);
    expect(await worker.runOnce()).toBe(true);
    expect(repository.walletIndexCoverage()).toMatchObject({
      indexedTransactions: 1,
      indexedSwaps: 1,
      indexedWallets: 1
    });
    expect(await worker.runOnce()).toBe(true);
    expect(repository.getWalletIndexRecord(WALLET)).toMatchObject({
      preScreenEligible: true,
      historyDays: 90,
      activeWeeks: 3
    });
    expect(await worker.runOnce()).toBe(false);
    expect(repository.listWalletIndexRuns(1)[0]).toMatchObject({
      stage: "COMPLETE",
      discoveredWallets: 1,
      structuralCandidates: 0
    });
    expect(requests.map((entry) => entry.address)).toEqual([PROGRAM, WALLET]);
  });

  it("yields while committing a large discovery page before advancing its checkpoint", async () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const signatures = Array.from({ length: 120 }, (_, index) => ({
      signature: `discovery-page-${index}`,
      slot: 10_000 - index,
      blockTime: NOW.getTime() / 1_000 - index,
      confirmationStatus: "confirmed",
      failed: false
    }));
    const worker = new WalletIndexWorker(repository, "unused-in-test", undefined, {
      rpc: {
        getSignaturesForAddress: async () => signatures,
        getTransaction: async () => null
      },
      programIds: new Set([PROGRAM]),
      targetWallets: 1,
      signaturePageSize: 1_000,
      deepHistoryEnabled: false,
      now: () => new Date(NOW)
    });

    const discovery = worker.runOnce();
    const queuedBeforePageCommit = await new Promise<number>((resolve) => {
      setImmediate(() => resolve(repository.walletIndexCoverage().queueByStatus.PENDING));
    });

    expect(queuedBeforePageCommit).toBeGreaterThan(0);
    expect(queuedBeforePageCommit).toBeLessThan(signatures.length);
    expect(repository.getWalletIndexCheckpoint("helius-jupiter-program-index", PROGRAM)).toBeUndefined();
    expect(await discovery).toBe(true);
    expect(repository.walletIndexCoverage().queueByStatus.PENDING).toBe(signatures.length);
    expect(repository.getWalletIndexCheckpoint("helius-jupiter-program-index", PROGRAM)).toMatchObject({
      completed: true,
      metadata: { pages: 1, observations: signatures.length }
    });
  });

  it("coordinates managed frozen deep history ahead of the independent reprice queue", async () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const record: WalletIndexRecord = {
      wallet: WALLET,
      firstSeenAt: new Date(NOW.getTime() - 90 * 86_400_000).toISOString(),
      lastSeenAt: NOW.toISOString(),
      historyDays: 90,
      transactionCount: 60,
      successfulTransactionCount: 60,
      spotSwapCount: 1,
      eligibleSpotSwapCount: 1,
      closedEligibleSwaps: 0,
      buyCount: 1,
      sellCount: 0,
      activeDays: 3,
      activeWeeks: 3,
      distinctMints: 1,
      medianHoldingMinutes: 20,
      preScreenEligible: true,
      preScreenReasons: [],
      deepHistoryStatus: "AWAITING",
      structuralEligible: false,
      structuralReasons: ["awaiting local deep history"],
      updatedAt: NOW.toISOString()
    };
    repository.upsertWalletIndexRecord(record);
    repository.saveWalletPreScreenSnapshot({
      wallet: WALLET,
      runId: "coarse-run",
      calculatedAt: NOW.toISOString(),
      eligible: true,
      reasons: [],
      record
    });
    const repriceReads = vi.spyOn(repository, "nextPendingIndexedSwapReprice")
      .mockImplementation(() => {
        throw new Error("managed deep history must run before local repricing");
      });
    let pages = 0;
    const rpc: HeliusIndexRpc = {
      getSignaturesForAddress: async () => { pages += 1; return []; },
      getTransaction: async () => { throw new Error("empty deep history must not hydrate"); }
    };
    const readyGenerations: string[] = [];
    const worker = new WalletIndexWorker(repository, "unused-in-test", undefined, {
      rpc,
      programIds: new Set([PROGRAM]),
      targetWallets: 1,
      deepHistoryTargetLimit: 1,
      deepHistoryPageSize: 10,
      deepHistoryAllowUnpricedStructuralCompletion: true,
      now: () => new Date(NOW),
      onResearchReady: (generation) => readyGenerations.push(generation)
    });

    expect(await worker.runOnce()).toBe(true); // freezes target and completes paging
    expect(repriceReads).not.toHaveBeenCalled();
    expect(repository.listWalletIndexRuns(1)[0]?.stage).toBe("HISTORY");
    expect(await worker.runOnce()).toBe(true); // applies structural gates after terminal queue check
    expect(repriceReads).not.toHaveBeenCalled();
    expect(repository.getWalletIndexRecord(WALLET)).toMatchObject({
      deepHistoryStatus: "COMPLETE",
      structuralEligible: false,
      closedEligibleSwaps: 0
    });
    repriceReads.mockReturnValue(undefined);
    expect(await worker.runOnce()).toBe(false); // only now may the run complete
    expect(repository.listWalletIndexRuns(1)[0]).toMatchObject({ stage: "COMPLETE", structuralCandidates: 0 });
    expect(repository.listWalletResearchHandoffs()).toEqual([
      expect.objectContaining({
        status: "READY",
        runId: repository.listWalletIndexRuns(1)[0]?.id,
        wallets: []
      })
    ]);
    expect(readyGenerations).toHaveLength(1);
    expect(await worker.runOnce()).toBe(true); // seed the program head with one bounded request
    expect(await worker.runOnce()).toBe(false); // the head interval prevents an immediate repeat
    expect(repository.listWalletResearchHandoffs()).toHaveLength(1);
    expect(readyGenerations).toHaveLength(1);
    expect(pages).toBe(2);
  });

  it("hands one immutable survivor to managed scoring without waiting for a ten-wallet batch", async () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const alreadyScored = "already-provider-scored";
    const freshWallet = "partial-survivor-0";
    const wallets = [alreadyScored, freshWallet];
    const cohort = repository.createWalletDeepHistoryCohort({
      selectedAt: NOW.toISOString(),
      snapshotCutoffAt: NOW.toISOString(),
      windowStart: new Date(NOW.getTime() - 90 * 86_400_000).toISOString(),
      windowEnd: NOW.toISOString(),
      wallets
    });
    for (const wallet of wallets) {
      const record: WalletIndexRecord = {
        wallet,
        firstSeenAt: cohort.windowStart,
        lastSeenAt: cohort.windowEnd,
        historyDays: 90,
        transactionCount: 120,
        successfulTransactionCount: 120,
        spotSwapCount: 100,
        eligibleSpotSwapCount: 100,
        closedEligibleSwaps: 50,
        buyCount: 50,
        sellCount: 50,
        activeDays: 20,
        activeWeeks: 4,
        distinctMints: 10,
        medianHoldingMinutes: 20,
        preScreenEligible: true,
        preScreenReasons: [],
        deepHistoryStatus: "COMPLETE",
        deepHistoryWindowStart: cohort.windowStart,
        deepHistoryWindowEnd: cohort.windowEnd,
        deepHistorySignatureCount: 120,
        deepHistoryHydratedCount: 120,
        structuralEligible: true,
        structuralReasons: [],
        updatedAt: NOW.toISOString()
      };
      repository.upsertWalletIndexRecord(record);
      repository.saveWalletDeepHistoryEvidence({
        generationId: cohort.generationId,
        cohortId: cohort.id,
        wallet,
        record,
        swaps: [],
        frozenAt: NOW.toISOString()
      });
    }
    repository.saveCohort({
      cohortId: "provider-cohort",
      generatedAt: NOW.toISOString(),
      candidates: [{
        address: alreadyScored,
        cohortId: "provider-cohort",
        firstSeenAt: cohort.windowStart,
        lastSeenAt: cohort.windowEnd,
        control: false,
        tags: []
      }]
    });
    repository.saveWalletScore("provider-cohort", {
      wallet: alreadyScored,
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
    repository.enqueueWalletResearchHandoff({
      generation: "prior-local-qualification",
      runId: "prior-index-run",
      wallets: [alreadyScored],
      readyAt: NOW.toISOString()
    });
    expect(repository.claimWalletResearchHandoff(NOW)?.wallets).toEqual([alreadyScored]);
    expect(repository.completeWalletResearchHandoff(
      "prior-local-qualification",
      "provider-cohort",
      NOW
    )).toBe(true);
    const summaries = repository.listWalletDeepHistoryEvidenceSummaries(
      cohort.generationId,
      cohort.id
    );
    expect(summaries).toHaveLength(2);
    expect(summaries[0]).not.toHaveProperty("swaps");
    const ready: string[] = [];
    let providerCalls = 0;
    const fullEvidenceReads = vi.spyOn(repository, "listWalletDeepHistoryEvidence");
    const fullEvidenceRead = vi.spyOn(repository, "getWalletDeepHistoryEvidence");
    const historicalGenerationScans = vi.spyOn(repository, "listWalletDeepHistoryGenerations");
    const historicalGenerationCohortScans = vi.spyOn(repository, "listWalletDeepHistoryCohortsForGeneration");
    const historicalCohortScans = vi.spyOn(repository, "listWalletDeepHistoryCohorts");
    const perCohortSummaryReads = vi.spyOn(repository, "listWalletDeepHistoryEvidenceSummaries");
    const unhandedCompletedReads = vi.spyOn(
      repository,
      "listUnhandedCompletedWalletDeepHistoryCohortEvidence"
    );
    const evidenceBearingCohortReads = vi.spyOn(repository, "listOpenWalletDeepHistoryCohortEvidence");
    const worker = new WalletIndexWorker(repository, "unused-in-test", undefined, {
      rpc: {
        getSignaturesForAddress: async () => { providerCalls += 1; return []; },
        getTransaction: async () => { providerCalls += 1; return null; }
      },
      programIds: new Set([PROGRAM]),
      targetWallets: 5_000,
      deepHistoryAllowUnpricedStructuralCompletion: true,
      now: () => new Date(NOW),
      onResearchReady: (generation) => ready.push(generation)
    });

    expect(await worker.runOnce()).toBe(true);
    expect(providerCalls).toBe(0);
    expect(repository.openWalletDeepHistoryCohort()?.id).toBe(cohort.id);
    const readyHandoffs = repository.listWalletResearchHandoffs()
      .filter((handoff) => handoff.status === "READY");
    expect(readyHandoffs).toEqual([
      expect.objectContaining({
        status: "READY",
        wallets: [freshWallet]
      })
    ]);
    expect(readyHandoffs[0]?.wallets).toHaveLength(1);
    expect(ready).toHaveLength(1);
    expect(fullEvidenceReads).not.toHaveBeenCalled();
    expect(fullEvidenceRead).not.toHaveBeenCalled();
    expect(historicalGenerationScans).not.toHaveBeenCalled();
    expect(historicalGenerationCohortScans).not.toHaveBeenCalled();
    expect(historicalCohortScans).not.toHaveBeenCalled();
    expect(perCohortSummaryReads).not.toHaveBeenCalled();
    expect(unhandedCompletedReads).toHaveBeenCalledTimes(1);
    expect(evidenceBearingCohortReads).toHaveBeenCalledTimes(1);
    expect(await worker.runOnce()).toBe(false);
    expect(historicalCohortScans).not.toHaveBeenCalled();
    expect(perCohortSummaryReads).not.toHaveBeenCalled();
    expect(historicalGenerationScans).not.toHaveBeenCalled();
    expect(historicalGenerationCohortScans).not.toHaveBeenCalled();
    expect(unhandedCompletedReads).toHaveBeenCalledTimes(1);
    expect(evidenceBearingCohortReads).toHaveBeenCalledTimes(1);
  });

  it("excludes wallets already handed by the legacy partial prefix from a completed cohort", async () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const legacyWallet = "legacy-partial-wallet";
    const freshWallet = "fresh-completed-wallet";
    const cohort = repository.createWalletDeepHistoryCohort({
      selectedAt: NOW.toISOString(),
      snapshotCutoffAt: NOW.toISOString(),
      windowStart: new Date(NOW.getTime() - 90 * 86_400_000).toISOString(),
      windowEnd: NOW.toISOString(),
      wallets: [legacyWallet, freshWallet]
    });
    for (const wallet of [legacyWallet, freshWallet]) {
      const completed: WalletIndexRecord = {
        wallet,
        firstSeenAt: cohort.windowStart,
        lastSeenAt: cohort.windowEnd,
        historyDays: 90,
        transactionCount: 100,
        successfulTransactionCount: 100,
        spotSwapCount: 100,
        eligibleSpotSwapCount: 100,
        closedEligibleSwaps: 50,
        buyCount: 50,
        sellCount: 50,
        activeDays: 20,
        activeWeeks: 4,
        distinctMints: 10,
        medianHoldingMinutes: 20,
        preScreenEligible: true,
        preScreenReasons: [],
        deepHistoryStatus: "COMPLETE",
        deepHistoryWindowStart: cohort.windowStart,
        deepHistoryWindowEnd: cohort.windowEnd,
        deepHistorySignatureCount: 100,
        deepHistoryHydratedCount: 100,
        structuralEligible: true,
        structuralReasons: [],
        updatedAt: NOW.toISOString()
      };
      repository.upsertWalletIndexRecord(completed);
      repository.saveWalletDeepHistoryEvidence({
        generationId: cohort.generationId,
        cohortId: cohort.id,
        wallet,
        record: completed,
        swaps: [],
        frozenAt: NOW.toISOString()
      });
    }
    db.prepare(`
      UPDATE wallet_deep_history_cohorts
      SET status = 'COMPLETE', completed_at = ?
      WHERE id = ?
    `).run(NOW.toISOString(), cohort.id);
    const legacyGeneration = `local-index-v4-partial:${cohort.generationId}:${cohort.id}:legacy`;
    repository.enqueueWalletResearchHandoff({
      generation: legacyGeneration,
      runId: "legacy-run",
      wallets: [legacyWallet],
      readyAt: NOW.toISOString()
    });
    expect(repository.claimWalletResearchHandoff(NOW)?.generation).toBe(legacyGeneration);
    expect(repository.completeWalletResearchHandoff(legacyGeneration, undefined, NOW)).toBe(true);
    repository.createWalletDeepHistoryCohort({
      generationId: cohort.generationId,
      selectedAt: new Date(NOW.getTime() + 1).toISOString(),
      snapshotCutoffAt: NOW.toISOString(),
      windowStart: cohort.windowStart,
      windowEnd: cohort.windowEnd,
      wallets: ["open-placeholder-wallet"]
    });

    const completedReads = vi.spyOn(
      repository,
      "listUnhandedCompletedWalletDeepHistoryCohortEvidence"
    );
    const worker = new WalletIndexWorker(repository, "unused-in-test", undefined, {
      rpc: {
        getSignaturesForAddress: async () => { throw new Error("handoff scan must not use the provider"); },
        getTransaction: async () => { throw new Error("handoff scan must not use the provider"); }
      },
      programIds: new Set([PROGRAM]),
      targetWallets: 1,
      programHeadMaintenanceEnabled: false,
      now: () => new Date(NOW)
    });

    expect(await worker.runOnce()).toBe(true);
    const exactGeneration = `local-index-v4:${cohort.generationId}:${cohort.id}`;
    expect(repository.getWalletResearchHandoff(exactGeneration)).toMatchObject({
      status: "READY",
      wallets: [freshWallet]
    });
    expect(completedReads).toHaveBeenCalledTimes(1);
    expect(await worker.runOnce()).toBe(false);
    expect(completedReads).toHaveBeenCalledTimes(1);
  });

  it("pauses before issuing a request when the monthly index budget is exhausted", async () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    repository.incrementUsage("helius_index", 250_000, NOW);
    let calls = 0;
    const rpc: HeliusIndexRpc = {
      getSignaturesForAddress: async () => { calls += 1; return []; },
      getTransaction: async () => { calls += 1; return null; }
    };
    const worker = new WalletIndexWorker(repository, "unused-in-test", undefined, {
      rpc,
      programIds: new Set([PROGRAM]),
      maximumIndexCreditsPerMonth: 250_000,
      now: () => new Date(NOW)
    });

    expect(await worker.runOnce()).toBe(false);
    expect(calls).toBe(0);
    expect(repository.listWalletIndexRuns(1)[0]?.stage).toBe("PAUSED");
  });

  it("admits an 887-transaction managed rescue candidate above the 6,100-credit reserve", async () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const wallet = walletKey(71);
    persistManagedRescueCandidate(repository, wallet, 887);
    // 7,121 - 6,100 leaves 1,021 credits. After the rescue selector's 15%
    // estimate buffer, the complete 887-transaction candidate still fits.
    repository.incrementUsage("helius_index", 250_000 - 7_121, NOW);
    let historyCalls = 0;
    const worker = new WalletIndexWorker(repository, "unused-in-test", undefined, {
      rpc: {
        getSignaturesForAddress: async () => { historyCalls += 1; return []; },
        getTransaction: async () => null
      },
      programIds: new Set([PROGRAM]),
      targetWallets: 1,
      maximumIndexCreditsPerMonth: 250_000,
      deepHistoryTargetLimit: 1,
      deepHistoryAllowUnpricedStructuralCompletion: true,
      deepHistoryCanStartManagedRecovery: () => true,
      deepHistoryAllowLegacyManagedRecoveryWithoutPreflight: true,
      programHeadMaintenanceEnabled: false,
      now: () => new Date(NOW)
    });

    expect(await worker.runOnce()).toBe(true);
    expect(historyCalls).toBe(1);
    expect(repository.openWalletDeepHistoryCohort()).toMatchObject({
      id: expect.stringMatching(/^managed-rescue-v2:/),
      wallets: [wallet]
    });
  });

  it("does not spend provider-preflight quota when exact rescue headroom is at the admission reserve", async () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    persistManagedRescueCandidate(repository, walletKey(72), 887);
    repository.incrementUsage("helius_index", 250_000 - 6_100, NOW);
    const runPreflight = vi.fn(async () => true);
    const worker = new WalletIndexWorker(repository, "unused-in-test", undefined, {
      rpc: {
        getSignaturesForAddress: async () => [],
        getTransaction: async () => null
      },
      programIds: new Set([PROGRAM]),
      targetWallets: 1,
      maximumIndexCreditsPerMonth: 250_000,
      deepHistoryAllowUnpricedStructuralCompletion: true,
      deepHistoryCanStartManagedRecovery: () => true,
      deepHistoryManagedRecoveryPreflightGate: () => ({
        policyVersion: "managed-recovery-preflight-v1",
        windowStart: "2026-07-06T00:00:00.000Z",
        validAt: NOW.toISOString()
      }),
      runManagedRecoveryPreflight: runPreflight,
      programHeadMaintenanceEnabled: false,
      now: () => new Date(NOW)
    });

    expect(await worker.runOnce()).toBe(false);
    expect(runPreflight).not.toHaveBeenCalled();
  });

  it("holds an open managed rescue at 6,004 credits across denied retries without provider spam", async () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const rescue = repository.createWalletDeepHistoryCohort({
      kind: "MANAGED_RESCUE_V2",
      selectedAt: NOW.toISOString(),
      snapshotCutoffAt: NOW.toISOString(),
      windowStart: new Date(NOW.getTime() - 90 * 86_400_000).toISOString(),
      windowEnd: NOW.toISOString(),
      wallets: [walletKey(72)]
    });
    expect(rescue.id).toMatch(/^managed-rescue-v2:/);
    repository.incrementUsage("helius_index", 250_000 - 6_005, NOW);
    let providerCalls = 0;
    const worker = new WalletIndexWorker(repository, "unused-in-test", undefined, {
      rpc: {
        getSignaturesForAddress: async () => { providerCalls += 1; return []; },
        getTransaction: async () => { providerCalls += 1; return null; }
      },
      programIds: new Set([PROGRAM]),
      maximumIndexCreditsPerMonth: 250_000,
      deepHistoryAllowUnpricedStructuralCompletion: true,
      programHeadMaintenanceEnabled: false,
      now: () => new Date(NOW)
    });
    const reserveCredits = (worker as unknown as {
      reserveCredits: (credits: number) => boolean;
    }).reserveCredits.bind(worker);

    expect(reserveCredits(1)).toBe(true);
    expect(reserveCredits(1)).toBe(false);
    expect(reserveCredits(1)).toBe(false);
    expect(repository.usageSince("2027-01-01")
      .find((entry) => entry.provider === "helius_index")?.credits).toBe(250_000 - 6_004);

    expect(await worker.runOnce()).toBe(false);
    expect(await worker.runOnce()).toBe(false);
    expect(providerCalls).toBe(0);
    expect(repository.listWalletIndexRuns(1)[0]).toMatchObject({
      stage: "PAUSED",
      error: expect.stringMatching(/6,004-credit Helius index safety floor/i)
    });
  });

  it("does not apply the managed rescue hard floor to an ordinary open cohort", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    repository.createWalletDeepHistoryCohort({
      selectedAt: NOW.toISOString(),
      snapshotCutoffAt: NOW.toISOString(),
      windowStart: new Date(NOW.getTime() - 90 * 86_400_000).toISOString(),
      windowEnd: NOW.toISOString(),
      wallets: [walletKey(73)]
    });
    repository.incrementUsage("helius_index", 250_000 - 6_005, NOW);
    const worker = new WalletIndexWorker(repository, "unused-in-test", undefined, {
      rpc: {
        getSignaturesForAddress: async () => [],
        getTransaction: async () => null
      },
      programIds: new Set([PROGRAM]),
      maximumIndexCreditsPerMonth: 250_000,
      now: () => new Date(NOW)
    });
    const reserveCredits = (worker as unknown as {
      reserveCredits: (credits: number) => boolean;
    }).reserveCredits.bind(worker);

    expect(reserveCredits(2)).toBe(true);
    expect(repository.usageSince("2027-01-01")
      .find((entry) => entry.provider === "helius_index")?.credits).toBe(250_000 - 6_003);
  });

  it("does not apply legacy Helius credit counters to a self-hosted RPC index", async () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    repository.incrementUsage("helius_index", 250_000, NOW);
    let calls = 0;
    const rpc: HeliusIndexRpc = {
      getSignaturesForAddress: async () => { calls += 1; return []; },
      getTransaction: async () => { calls += 1; return null; }
    };
    const worker = new WalletIndexWorker(repository, "", undefined, {
      rpc,
      programIds: new Set([PROGRAM]),
      maximumIndexCreditsPerMonth: 250_000,
      enforceManagedCreditBudget: false,
      now: () => new Date(NOW)
    });

    await worker.runOnce();

    expect(calls).toBe(1);
    expect(repository.listWalletIndexRuns(1)[0]).toMatchObject({
      stage: "COMPLETE",
      configuration: expect.objectContaining({ dataSource: "standard-solana-rpc" })
    });
  });

  it("hydrates slot-grouped leases with one block call and falls back per missing transaction", async () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const materializeReads = vi.spyOn(repository, "listIndexedSpotSwaps");
    const coverageReads = vi.spyOn(repository, "walletIndexCoverage");
    repository.enqueueWalletIndexTransactions([
      ...["block-1", "block-2", "block-missing", "onchain-failed"].map((signature) => ({
        signature,
        sourceAddress: PROGRAM,
        source: "test",
        discoveredAt: NOW.toISOString(),
        slot: 42,
        metadata: { failed: false }
      })),
      {
        signature: "known-failed",
        sourceAddress: PROGRAM,
        source: "test",
        discoveredAt: NOW.toISOString(),
        slot: 42,
        metadata: { failed: true }
      },
      {
        signature: "no-slot",
        sourceAddress: PROGRAM,
        source: "test",
        discoveredAt: NOW.toISOString(),
        metadata: { failed: false }
      }
    ]);
    const blockSlots: number[] = [];
    const singles: string[] = [];
    const rpc: HeliusIndexRpc = {
      getSignaturesForAddress: async () => [],
      getTransaction: async (signature) => { singles.push(signature); return confirmedSwap(); },
      getBlock: async (slot) => {
        blockSlots.push(slot);
        const block = rawBlock(
          ["block-1", "unrelated", "block-2", "onchain-failed"],
          new Set(["onchain-failed"])
        ) as { transactions: unknown[] };
        block.transactions.push({ transaction: { signatures: ["block-missing"] }, meta: null });
        return block;
      }
    };
    const worker = new WalletIndexWorker(repository, "unused-in-test", undefined, {
      rpc,
      programIds: new Set([PROGRAM]),
      targetWallets: 1,
      now: () => new Date(NOW)
    });

    expect(await worker.runOnce()).toBe(true);
    expect(materializeReads).toHaveBeenCalledTimes(1);
    expect(coverageReads.mock.calls.length).toBeLessThanOrEqual(3);
    expect(blockSlots).toEqual([42]);
    expect(singles).toEqual(["block-missing", "no-slot"]);
    expect(repository.walletIndexCoverage()).toMatchObject({
      uniqueSignatures: 6,
      indexedTransactions: 6,
      indexedSwaps: 4,
      queueByStatus: { PROCESSED: 6, PENDING: 0, RETRY: 0, LEASED: 0, FAILED: 0 }
    });

    const record = repository.getWalletIndexRecord(WALLET);
    expect(record).toBeDefined();
    repository.upsertWalletIndexRecord({
      ...(record as NonNullable<typeof record>),
      historyDays: 90,
      transactionCount: 500,
      successfulTransactionCount: 400,
      activeWeeks: 4,
      deepHistoryStatus: "COMPLETE",
      deepHistoryWindowStart: new Date(NOW.getTime() - 90 * 86_400_000).toISOString(),
      deepHistoryWindowEnd: NOW.toISOString(),
      deepHistorySignatureCount: 500,
      deepHistoryHydratedCount: 500,
      structuralEligible: true,
      structuralReasons: [],
      pricedClosedEligibleSwaps: 60,
      unpricedClosedEligibleSwaps: 0,
      realizedPnlPricedUsd: 25,
      pricedProfitTokenCount: 8,
      profitPricingCoverage: "COMPLETE",
      updatedAt: NOW.toISOString()
    });
    repository.enqueueWalletIndexTransactions([{
      signature: "later-head",
      sourceAddress: PROGRAM,
      source: "test",
      discoveredAt: NOW.toISOString(),
      metadata: { failed: false }
    }]);
    expect(await worker.runOnce()).toBe(true);
    expect(repository.getWalletIndexRecord(WALLET)).toMatchObject({
      historyDays: 90,
      transactionCount: 500,
      successfulTransactionCount: 400,
      activeWeeks: 4,
      deepHistoryStatus: "COMPLETE",
      deepHistorySignatureCount: 500,
      deepHistoryHydratedCount: 500,
      structuralEligible: true,
      pricedClosedEligibleSwaps: 60,
      realizedPnlPricedUsd: 25,
      profitPricingCoverage: "COMPLETE"
    });
  });

  it("decodes jsonParsed block entries without redundant individual transaction requests", async () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const signatures = ["parsed-block-1", "parsed-block-2"];
    repository.enqueueWalletIndexTransactions(signatures.map((signature) => ({
      signature,
      sourceAddress: PROGRAM,
      source: "parsed-block-test",
      discoveredAt: NOW.toISOString(),
      slot: 46,
      metadata: { failed: false }
    })));
    const singles: string[] = [];
    const rpc: HeliusIndexRpc = {
      getSignaturesForAddress: async () => [],
      getTransaction: async (signature) => {
        singles.push(signature);
        return confirmedSwap();
      },
      getBlock: async () => parsedBlock(signatures)
    };
    const worker = new WalletIndexWorker(repository, "unused-in-test", undefined, {
      rpc,
      programIds: new Set([PROGRAM]),
      targetWallets: 1,
      deepHistoryEnabled: false,
      now: () => new Date(NOW)
    });

    expect(await worker.runOnce()).toBe(true);
    expect(singles).toEqual([]);
    expect(repository.walletIndexCoverage()).toMatchObject({
      indexedTransactions: 2,
      indexedSwaps: 2,
      indexedWallets: 1,
      queueByStatus: { PROCESSED: 2, PENDING: 0, RETRY: 0, LEASED: 0, FAILED: 0 }
    });
  });

  it("falls back per signature when a block contains unparsed safety instructions", async () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const signatures = ["raw-token-1", "raw-token-2"];
    repository.enqueueWalletIndexTransactions(signatures.map((signature) => ({
      signature,
      sourceAddress: PROGRAM,
      source: "raw-token-fallback-test",
      discoveredAt: NOW.toISOString(),
      slot: 47,
      metadata: { failed: false }
    })));
    const singles: string[] = [];
    const rpc: HeliusIndexRpc = {
      getSignaturesForAddress: async () => [],
      getTransaction: async (signature) => {
        singles.push(signature);
        return confirmedSwap();
      },
      getBlock: async () => rawBlockWithUnparsedTokenInstruction(signatures)
    };
    const worker = new WalletIndexWorker(repository, "unused-in-test", undefined, {
      rpc,
      programIds: new Set([PROGRAM]),
      targetWallets: 1,
      deepHistoryEnabled: false,
      now: () => new Date(NOW)
    });

    expect(await worker.runOnce()).toBe(true);
    expect(singles).toEqual(signatures);
    expect(repository.walletIndexCoverage()).toMatchObject({
      indexedTransactions: 2,
      indexedSwaps: 2,
      indexedWallets: 1,
      queueByStatus: { PROCESSED: 2, PENDING: 0, RETRY: 0, LEASED: 0, FAILED: 0 }
    });
  });

  it("yields loopback responsiveness and materializes one wallet once for a 100-item hydration batch", async () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const signatures = Array.from({ length: 100 }, (_, index) => `responsive-${index}`);
    repository.enqueueWalletIndexTransactions(signatures.map((signature) => ({
      signature,
      sourceAddress: PROGRAM,
      source: "responsiveness-test",
      discoveredAt: NOW.toISOString(),
      slot: 50,
      metadata: { failed: false }
    })));
    const materializeReads = vi.spyOn(repository, "listIndexedSpotSwaps");
    const coverageReads = vi.spyOn(repository, "walletIndexCoverage");
    const rpc: HeliusIndexRpc = {
      getSignaturesForAddress: async () => [],
      getTransaction: async () => confirmedSwap(),
      getBlock: async () => rawBlock(signatures)
    };
    const worker = new WalletIndexWorker(repository, "unused-in-test", undefined, {
      rpc,
      programIds: new Set([PROGRAM]),
      targetWallets: 1,
      hydrationBatchSize: 100,
      deepHistoryEnabled: false,
      now: () => new Date(NOW)
    });

    let timerFired = false;
    const timer = new Promise<void>((resolve) => setTimeout(() => {
      timerFired = true;
      resolve();
    }, 0));
    const hydration = worker.runOnce();
    await timer;
    expect(timerFired).toBe(true);
    expect(await hydration).toBe(true);
    expect(materializeReads).toHaveBeenCalledTimes(1);
    expect(coverageReads.mock.calls.length).toBeLessThanOrEqual(3);
    expect(repository.walletIndexCoverage()).toMatchObject({
      indexedTransactions: 100,
      indexedSwaps: 100,
      indexedWallets: 1,
      queueByStatus: { PROCESSED: 100, PENDING: 0, LEASED: 0, RETRY: 0, FAILED: 0 }
    });
  });

  it("completes 100 reprices before one coalesced wallet rebuild and yields to macrotasks", async () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const seededRecord = pendingWalletRecord(WALLET);
    repository.upsertWalletIndexRecord(seededRecord);
    repository.saveWalletPreScreenSnapshot({
      wallet: WALLET,
      runId: "reprice-batch-prescreen",
      calculatedAt: NOW.toISOString(),
      eligible: false,
      reasons: seededRecord.preScreenReasons,
      record: seededRecord
    });
    persistUnpricedSolSwaps(repository, 100);
    const materializeReads = vi.spyOn(repository, "listIndexedSpotSwaps");
    const cooldown = vi.fn(async (_milliseconds: number) => {
      await new Promise<void>((resolve) => setImmediate(resolve));
    });
    let priceReads = 0;
    const worker = new WalletIndexWorker(repository, "unused-in-test", undefined, {
      rpc: {
        getSignaturesForAddress: async () => [],
        getTransaction: async () => null
      },
      programIds: new Set([PROGRAM]),
      targetWallets: 1,
      deepHistoryEnabled: false,
      deepHistoryAllowUnpricedStructuralCompletion: true,
      onAcquisitionPipelineDrained: () => false,
      programHeadMaintenanceEnabled: false,
      solPriceUsdResolver: async () => { priceReads += 1; return 100; },
      sleep: cooldown,
      now: () => new Date(NOW)
    });

    expect(await worker.runOnce()).toBe(true); // repair the ingestion-time dirty marker
    materializeReads.mockClear();
    let batchFinished = false;
    const macrotask = new Promise<void>((resolve) => setImmediate(resolve));
    const batch = worker.runOnce().then((result) => {
      batchFinished = true;
      return result;
    });
    await macrotask;
    expect(batchFinished).toBe(false);
    expect(priceReads).toBeGreaterThan(0);
    expect(priceReads).toBeLessThan(100);
    expect(await batch).toBe(true);
    expect(priceReads).toBe(100);
    expect(cooldown).toHaveBeenCalledTimes(1);
    expect(cooldown).toHaveBeenLastCalledWith(1_000);
    expect(db.prepare(`
      SELECT status, COUNT(*) AS count FROM indexed_swap_reprice_queue GROUP BY status
    `).all()).toEqual([{ status: "COMPLETE", count: 100 }]);
    expect(repository.listDirtyWalletIndexRecords(10)).toHaveLength(1);
    expect(repository.hasPendingWalletIndexMaintenance(WALLET)).toBe(true);
    expect(materializeReads).not.toHaveBeenCalled();

    expect(await worker.runOnce()).toBe(true); // one rebuild for all 100 prices
    expect(materializeReads).toHaveBeenCalledTimes(1);
    expect(repository.listDirtyWalletIndexRecords(10)).toEqual([]);
    expect(repository.hasPendingWalletIndexMaintenance(WALLET)).toBe(false);
    expect(await worker.runOnce()).toBe(false); // settled COMPLETE run
    expect(await worker.runOnce()).toBe(false); // no duplicate completion transition
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM audit_events WHERE event_type = 'wallet_index_complete'
    `).get()).toEqual({ count: 1 });

    const completedRuns = repository.listWalletIndexRuns(10);
    expect(completedRuns).toHaveLength(1);
    expect(completedRuns[0]?.stage).toBe("COMPLETE");
    persistUnpricedSolSwaps(repository, 1);
    expect(await worker.runOnce()).toBe(true); // repair new ingestion dirt without reopening COMPLETE
    expect(await worker.runOnce()).toBe(true); // complete the new one-row reprice batch
    expect(cooldown).toHaveBeenCalledTimes(2);
    expect(cooldown).toHaveBeenLastCalledWith(1_000);
    expect(await worker.runOnce()).toBe(true); // rebuild the wallet once for that batch
    expect(await worker.runOnce()).toBe(false); // remain settled without another COMPLETE transition
    expect(repository.listWalletIndexRuns(10)).toMatchObject([{
      id: completedRuns[0]?.id,
      stage: "COMPLETE"
    }]);
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM audit_events WHERE event_type = 'wallet_index_complete'
    `).get()).toEqual({ count: 1 });
  });

  it("retains a failed reprice as pending evidence without dirtying or rebuilding the wallet", async () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const seededRecord = pendingWalletRecord(WALLET);
    repository.upsertWalletIndexRecord(seededRecord);
    repository.saveWalletPreScreenSnapshot({
      wallet: WALLET,
      runId: "reprice-failure-prescreen",
      calculatedAt: NOW.toISOString(),
      eligible: false,
      reasons: seededRecord.preScreenReasons,
      record: seededRecord
    });
    persistUnpricedSolSwaps(repository, 1);
    const materializeReads = vi.spyOn(repository, "listIndexedSpotSwaps");
    const worker = new WalletIndexWorker(repository, "unused-in-test", undefined, {
      rpc: {
        getSignaturesForAddress: async () => [],
        getTransaction: async () => null
      },
      programIds: new Set([PROGRAM]),
      targetWallets: 1,
      deepHistoryEnabled: false,
      deepHistoryAllowUnpricedStructuralCompletion: true,
      onAcquisitionPipelineDrained: () => false,
      programHeadMaintenanceEnabled: false,
      solPriceUsdResolver: async () => { throw new Error("price gap"); },
      now: () => new Date(NOW)
    });

    expect(await worker.runOnce()).toBe(true); // repair the ingestion-time dirty marker
    materializeReads.mockClear();
    expect(await worker.runOnce()).toBe(false);
    expect(db.prepare(`
      SELECT status, attempts, last_error FROM indexed_swap_reprice_queue
    `).get()).toEqual({ status: "PENDING", attempts: 1, last_error: "price gap" });
    expect(repository.listDirtyWalletIndexRecords(10)).toEqual([]);
    expect(repository.hasPendingWalletIndexMaintenance(WALLET)).toBe(true);
    expect(materializeReads).not.toHaveBeenCalled();
    expect(repository.listIndexedSpotSwaps(WALLET)[0]?.priceUsd).toBeUndefined();
  });

  it("defers an exact research handoff until pending and dirty wallet maintenance settles", async () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const wallet = "maintenance-deferred-wallet";
    const cleanWallet = "maintenance-clean-peer";
    const cohort = repository.createWalletDeepHistoryCohort({
      selectedAt: NOW.toISOString(),
      snapshotCutoffAt: NOW.toISOString(),
      windowStart: new Date(NOW.getTime() - 90 * 86_400_000).toISOString(),
      windowEnd: NOW.toISOString(),
      wallets: [wallet, cleanWallet]
    });
    for (const candidateWallet of [wallet, cleanWallet]) {
      const record: WalletIndexRecord = {
        wallet: candidateWallet,
        firstSeenAt: cohort.windowStart,
        lastSeenAt: cohort.windowEnd,
        historyDays: 90,
        transactionCount: 100,
        successfulTransactionCount: 100,
        spotSwapCount: 100,
        eligibleSpotSwapCount: 100,
        closedEligibleSwaps: 50,
        buyCount: 50,
        sellCount: 50,
        activeDays: 20,
        activeWeeks: 4,
        distinctMints: 10,
        medianHoldingMinutes: 20,
        preScreenEligible: true,
        preScreenReasons: [],
        deepHistoryStatus: "COMPLETE",
        deepHistoryWindowStart: cohort.windowStart,
        deepHistoryWindowEnd: cohort.windowEnd,
        deepHistorySignatureCount: 100,
        deepHistoryHydratedCount: 100,
        structuralEligible: true,
        structuralReasons: [],
        updatedAt: NOW.toISOString()
      };
      repository.upsertWalletIndexRecord(record);
      repository.saveWalletPreScreenSnapshot({
        wallet: candidateWallet,
        runId: `maintenance-handoff-prescreen-${candidateWallet}`,
        calculatedAt: NOW.toISOString(),
        eligible: true,
        reasons: [],
        record
      });
      repository.saveWalletDeepHistoryEvidence({
        generationId: cohort.generationId,
        cohortId: cohort.id,
        wallet: candidateWallet,
        record,
        swaps: [],
        frozenAt: NOW.toISOString()
      });
    }
    expect(repository.completeWalletDeepHistoryCohort(cohort.id, NOW)).toBe(true);
    expect(repository.completeWalletDeepHistoryGeneration(cohort.generationId, NOW)).toBe(true);
    persistUnpricedSolSwaps(repository, 1, wallet);
    const generation = `local-index-v4:${cohort.generationId}:${cohort.id}`;
    const worker = new WalletIndexWorker(repository, "unused-in-test", undefined, {
      rpc: {
        getSignaturesForAddress: async () => [],
        getTransaction: async () => null
      },
      programIds: new Set([PROGRAM]),
      targetWallets: 1,
      deepHistoryCanStartNextCohort: () => false,
      deepHistoryAllowUnpricedStructuralCompletion: true,
      onAcquisitionPipelineDrained: () => false,
      programHeadMaintenanceEnabled: false,
      solPriceUsdResolver: async () => 100,
      repriceBatchCooldownMs: 0,
      now: () => new Date(NOW)
    });

    expect(repository.listWalletIndexResearchShortlist().map((entry) => entry.wallet)).toEqual([cleanWallet]);
    expect(await worker.runOnce()).toBe(true); // clear ingestion-time dirty marker; price still pending
    expect(repository.getWalletResearchHandoff(generation)).toBeUndefined();
    expect(repository.listWalletIndexResearchShortlist().map((entry) => entry.wallet)).toEqual([cleanWallet]);
    expect(await worker.runOnce()).toBe(true); // complete reprice; coalesced dirty marker remains
    expect(repository.getWalletResearchHandoff(generation)).toBeUndefined();
    expect(repository.listWalletIndexResearchShortlist().map((entry) => entry.wallet)).toEqual([cleanWallet]);
    expect(await worker.runOnce()).toBe(true); // rebuild the wallet once
    expect(repository.getWalletResearchHandoff(generation)).toBeUndefined();
    expect(repository.hasPendingWalletIndexMaintenance(wallet)).toBe(false);
    expect(repository.listWalletIndexResearchShortlist().map((entry) => entry.wallet)).toEqual([
      cleanWallet,
      wallet
    ]);
    expect(await worker.runOnce()).toBe(true); // the invalidated scan now hands off exact evidence
    expect(repository.getWalletResearchHandoff(generation)).toMatchObject({
      status: "READY",
      wallets: [cleanWallet, wallet]
    });
  });

  it("yields a macrotask between continuously progressing worker turns", async () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const worker = new WalletIndexWorker(repository, "unused-in-test", undefined, {
      rpc: {
        getSignaturesForAddress: async () => [],
        getTransaction: async () => null
      },
      deepHistoryEnabled: false,
      sleep: () => new Promise<void>((resolve) => setImmediate(resolve))
    });
    let turns = 0;
    vi.spyOn(worker, "runOnce").mockImplementation(async () => {
      turns += 1;
      return turns < 1_000;
    });

    const nextMacrotask = new Promise<number>((resolve) => {
      setImmediate(() => resolve(turns));
    });
    worker.start();
    const turnsBeforeMacrotask = await nextMacrotask;
    await worker.stop();

    expect(turnsBeforeMacrotask).toBeGreaterThan(0);
    expect(turnsBeforeMacrotask).toBeLessThan(1_000);
  });

  it("repairs a crash-left dirty wallet before doing more network work", async () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    repository.enqueueWalletIndexTransactions([{
      signature: "dirty-crash",
      sourceAddress: PROGRAM,
      source: "crash-test",
      discoveredAt: NOW.toISOString(),
      slot: 42,
      metadata: { failed: false }
    }]);
    const leased = repository.leaseWalletIndexTransactions("crashed-worker", 1, 60, NOW)[0]!;
    expect(repository.completeWalletIndexTransaction({
      ...leased,
      success: true,
      sourceWallets: [WALLET],
      updatedAt: NOW.toISOString()
    }, [{
      id: "dirty-crash:wallet:0",
      signature: "dirty-crash",
      wallet: WALLET,
      swapIndex: 0,
      slot: 42,
      blockTime: NOW.toISOString(),
      side: "BUY",
      baseMint: USDC_MINT,
      targetMint: TARGET,
      inputMint: USDC_MINT,
      outputMint: TARGET,
      inputAmountAtomic: "5000000",
      outputAmountAtomic: "2500000",
      inputAmountUi: 5,
      outputAmountUi: 2.5,
      eligible: true,
      eligibilityReasons: [],
      programIds: [PROGRAM],
      indexedAt: NOW.toISOString()
    }], leased.leaseToken!, NOW)).toBe(true);
    expect(repository.listDirtyWalletIndexRecords(10)).toHaveLength(1);
    let networkCalls = 0;
    const worker = new WalletIndexWorker(repository, "unused-in-test", undefined, {
      rpc: {
        getSignaturesForAddress: async () => { networkCalls += 1; return []; },
        getTransaction: async () => { networkCalls += 1; return null; }
      },
      programIds: new Set([PROGRAM]),
      targetWallets: 1,
      deepHistoryEnabled: false,
      now: () => new Date(NOW)
    });

    expect(await worker.runOnce()).toBe(true);
    expect(networkCalls).toBe(0);
    expect(repository.listDirtyWalletIndexRecords(10)).toEqual([]);
    expect(repository.getWalletIndexRecord(WALLET)).toMatchObject({ spotSwapCount: 1, buyCount: 1 });
  });

  it("uses compact transaction reads for sparse one-signature program slots", async () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    repository.enqueueWalletIndexTransactions([1, 2, 3].map((slot) => ({
      signature: `sparse-${slot}`,
      sourceAddress: PROGRAM,
      source: "test",
      discoveredAt: NOW.toISOString(),
      slot,
      metadata: { failed: false }
    })));
    const singles: string[] = [];
    let blocks = 0;
    const rpc: HeliusIndexRpc = {
      getSignaturesForAddress: async () => [],
      getTransaction: async (signature) => { singles.push(signature); return confirmedSwap(); },
      getBlock: async () => { blocks += 1; return rawBlock([]); }
    };
    const worker = new WalletIndexWorker(repository, "unused-in-test", undefined, {
      rpc,
      programIds: new Set([PROGRAM]),
      targetWallets: 1,
      deepHistoryEnabled: false,
      now: () => new Date(NOW)
    });

    expect(await worker.runOnce()).toBe(true);
    expect(blocks).toBe(0);
    expect(singles).toEqual(["sparse-3", "sparse-2", "sparse-1"]);
    expect(repository.walletIndexCoverage().queueByStatus.PROCESSED).toBe(3);
  });

  it("keeps sparse deep-history slots on single calls and only attributes swaps to the named wallet", async () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const cohort = repository.createWalletDeepHistoryCohort({
      selectedAt: NOW.toISOString(),
      snapshotCutoffAt: NOW.toISOString(),
      windowStart: new Date(NOW.getTime() - 90 * 86_400_000).toISOString(),
      windowEnd: NOW.toISOString(),
      wallets: [WALLET, TARGET]
    });
    repository.enqueueWalletIndexTransactions([
      {
        signature: "deep-match",
        sourceAddress: WALLET,
        wallet: WALLET,
        source: "helius-wallet-deep-history",
        discoveredAt: NOW.toISOString(),
        slot: 43,
        metadata: { failed: false, cohortId: cohort.id, generationId: cohort.generationId }
      },
      {
        signature: "deep-mismatch",
        sourceAddress: TARGET,
        wallet: TARGET,
        source: "helius-wallet-deep-history",
        discoveredAt: NOW.toISOString(),
        slot: 43,
        metadata: { failed: false, cohortId: cohort.id, generationId: cohort.generationId }
      },
      {
        signature: "deep-no-slot",
        sourceAddress: WALLET,
        wallet: WALLET,
        source: "helius-wallet-deep-history",
        discoveredAt: NOW.toISOString(),
        metadata: { failed: false, cohortId: cohort.id, generationId: cohort.generationId }
      }
    ]);
    const blockSlots: number[] = [];
    const singles: string[] = [];
    const rpc: HeliusIndexRpc = {
      getSignaturesForAddress: async () => [],
      getTransaction: async (signature) => { singles.push(signature); return confirmedSwap(); },
      getBlock: async (slot) => {
        blockSlots.push(slot);
        return rawBlock(["deep-match", "deep-mismatch"]);
      }
    };
    const worker = new WalletIndexWorker(repository, "unused-in-test", undefined, {
      rpc,
      programIds: new Set([PROGRAM]),
      targetWallets: 1,
      now: () => new Date(NOW)
    });

    expect(await worker.runOnce()).toBe(true);
    expect(blockSlots).toEqual([]);
    expect(singles).toEqual(["deep-match", "deep-mismatch", "deep-no-slot"]);
    expect(repository.walletIndexCoverage()).toMatchObject({
      indexedTransactions: 3,
      indexedSwaps: 2,
      indexedWallets: 1
    });
    expect(repository.listIndexedSpotSwaps(WALLET)).toHaveLength(2);
    expect(repository.listIndexedSpotSwaps(TARGET)).toHaveLength(0);
    expect(repository.getWalletIndexTransaction("deep-mismatch")?.sourceWallets).toEqual([TARGET]);
  });

  it("disables malformed block hydration and continues the same leases with single requests", async () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    repository.enqueueWalletIndexTransactions(["malformed-1", "malformed-2"].map((signature) => ({
      signature,
      sourceAddress: PROGRAM,
      source: "test",
      discoveredAt: NOW.toISOString(),
      slot: 44,
      metadata: { failed: false }
    })));
    let singles = 0;
    let blocks = 0;
    const rpc: HeliusIndexRpc = {
      getSignaturesForAddress: async () => [],
      getTransaction: async () => { singles += 1; return confirmedSwap(); },
      getBlock: async () => { blocks += 1; return { transactions: "malformed" }; }
    };
    const worker = new WalletIndexWorker(repository, "unused-in-test", undefined, {
      rpc,
      programIds: new Set([PROGRAM]),
      targetWallets: 1,
      now: () => new Date(NOW)
    });

    expect(await worker.runOnce()).toBe(true);
    expect(blocks).toBe(1);
    expect(singles).toBe(2);
    expect(repository.getSetting("helius_index_block_supported")).toBe(false);
    expect(repository.walletIndexCoverage().queueByStatus).toMatchObject({
      PROCESSED: 2,
      RETRY: 0,
      FAILED: 0
    });
  });

  it("persists unsupported block capability and does not reprobe after restart", async () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    repository.enqueueWalletIndexTransactions(["free-1", "free-2"].map((signature) => ({
      signature,
      sourceAddress: PROGRAM,
      source: "test",
      discoveredAt: NOW.toISOString(),
      slot: 45,
      metadata: { failed: false }
    })));
    let blocks = 0;
    let singles = 0;
    const rpc: HeliusIndexRpc = {
      getSignaturesForAddress: async () => [],
      getTransaction: async () => { singles += 1; return confirmedSwap(); },
      getBlock: async () => {
        blocks += 1;
        throw new ProviderApiError(
          "Helius index RPC",
          "getBlock is unavailable for this account",
          { status: 403 }
        );
      }
    };
    const worker = new WalletIndexWorker(repository, "unused-in-test", undefined, {
      rpc,
      programIds: new Set([PROGRAM]),
      targetWallets: 1,
      now: () => new Date(NOW)
    });

    expect(await worker.runOnce()).toBe(true);
    expect(blocks).toBe(1);
    expect(singles).toBe(2);
    expect(repository.getSetting("helius_index_block_supported")).toBe(false);
    expect(repository.walletIndexCoverage().queueByStatus).toMatchObject({
      PROCESSED: 2,
      RETRY: 0,
      FAILED: 0
    });

    repository.enqueueWalletIndexTransactions([{
      signature: "free-after-restart",
      sourceAddress: PROGRAM,
      source: "test",
      discoveredAt: NOW.toISOString(),
      slot: 46,
      metadata: { failed: false }
    }]);
    const restarted = new WalletIndexWorker(repository, "unused-in-test", undefined, {
      rpc,
      programIds: new Set([PROGRAM]),
      targetWallets: 1,
      now: () => new Date(NOW)
    });
    expect(await restarted.runOnce()).toBe(true);
    expect(blocks).toBe(1);
    expect(singles).toBe(3);
    expect(repository.getWalletIndexTransaction("free-after-restart")).toMatchObject({
      status: "PROCESSED",
      attempts: 1
    });
  });

  it("polls the confirmed program head after bootstrap and advances a durable high-water mark", async () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const initial = "initial-head";
    const newest = "new-head";
    let clock = new Date(NOW);
    const programRequests: HeliusSignaturePageRequest[] = [];
    const rpc: HeliusIndexRpc = {
      getSignaturesForAddress: async (address, request = {}) => {
        if (address !== PROGRAM) return activityRows();
        programRequests.push(request);
        if (!request.until) {
          return [{ signature: initial, slot: 40, blockTime: NOW.getTime() / 1_000, failed: false }];
        }
        if (request.until === initial) {
          return [{ signature: newest, slot: 41, blockTime: NOW.getTime() / 1_000 + 1, failed: false }];
        }
        return [];
      },
      getTransaction: async () => confirmedSwap()
    };
    const worker = new WalletIndexWorker(repository, "unused-in-test", undefined, {
      rpc,
      programIds: new Set([PROGRAM]),
      targetWallets: 1,
      signaturePageSize: 2,
      headSyncIntervalMs: 60_000,
      deepHistoryEnabled: false,
      now: () => new Date(clock)
    });

    expect(await worker.runOnce()).toBe(true); // bootstrap signature page
    expect(await worker.runOnce()).toBe(true); // hydration
    expect(await worker.runOnce()).toBe(true); // activity pre-screen
    expect(await worker.runOnce()).toBe(false); // complete bootstrap before polling
    expect(await worker.runOnce()).toBe(true); // bounded head poll

    expect(programRequests).toEqual([
      { limit: 2 },
      { limit: 2, until: initial }
    ]);
    expect(repository.walletIndexCoverage()).toMatchObject({
      uniqueSignatures: 2,
      indexedTransactions: 1
    });
    expect(repository.walletIndexCoverage().queueByStatus.PENDING).toBe(1);
    expect(repository.getWalletIndexCheckpoint("helius-jupiter-program-index", PROGRAM)).toMatchObject({
      lastSignature: initial,
      slot: 40
    });
    const completedHead = repository.getWalletIndexCheckpoint("helius-jupiter-program-head", PROGRAM);
    expect(completedHead).toMatchObject({
      lastSignature: newest,
      slot: 41,
      metadata: {
        cycles: 1,
        lastCyclePages: 1,
        lastPageCount: 1,
        coverageStartSlot: 41,
        coverageEndSlot: 41
      }
    });
    expect(completedHead?.cursor).toBeUndefined();
    expect(completedHead?.beforeSignature).toBeUndefined();
    expect(repository.listWalletIndexTransactionSources(newest)).toEqual([
      expect.objectContaining({ source: "helius-program-head", sourceAddress: PROGRAM })
    ]);

    expect(await worker.runOnce()).toBe(true); // hydrate the new signature
    expect(await worker.runOnce()).toBe(false); // close the maintenance run
    expect(await worker.runOnce()).toBe(false); // interval prevents another request
    expect(programRequests).toHaveLength(2);

    clock = new Date(clock.getTime() + 61_000);
    expect(await worker.runOnce()).toBe(true); // empty but completed head poll
    expect(programRequests.at(-1)).toEqual({ limit: 2, until: newest });

    const callsBeforePause = programRequests.length;
    repository.incrementUsage("helius_index", 250_000, clock);
    clock = new Date(clock.getTime() + 61_000);
    expect(await worker.runOnce()).toBe(false);
    expect(programRequests).toHaveLength(callsBeforePause);
    expect(repository.listWalletIndexRuns(1)[0]?.stage).toBe("PAUSED");
  });

  it("fairly alternates managed deep history with the confirmed head while a frozen run is active", async () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const initial = "history-anchor";
    const newest = "history-live-head";
    repository.saveWalletIndexCheckpoint({
      pipeline: "helius-jupiter-program-index",
      partition: PROGRAM,
      completed: true,
      updatedAt: new Date(NOW.getTime() - 60 * 60_000).toISOString(),
      lastSignature: initial,
      slot: 10,
      blockTime: new Date(NOW.getTime() - 60 * 60_000).toISOString()
    });
    repository.upsertWalletIndexRecord({
      wallet: "history-wallet",
      firstSeenAt: new Date(NOW.getTime() - 90 * 86_400_000).toISOString(),
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
      updatedAt: NOW.toISOString()
    });
    repository.createWalletDeepHistoryCohort({
      selectedAt: NOW.toISOString(),
      snapshotCutoffAt: NOW.toISOString(),
      windowStart: new Date(NOW.getTime() - 90 * 86_400_000).toISOString(),
      windowEnd: NOW.toISOString(),
      wallets: ["history-wallet"]
    });
    repository.upsertWalletIndexRun({
      id: "history-run",
      // Head maintenance must not depend on this mutable label; hydration and
      // repricing legitimately change it while the frozen cohort stays open.
      stage: "HYDRATION",
      startedAt: new Date(NOW.getTime() - 60 * 60_000).toISOString(),
      updatedAt: new Date(NOW.getTime() - 60 * 60_000).toISOString(),
      discoveredWallets: 5_000,
      enqueuedSignatures: 0,
      hydratedTransactions: 0,
      indexedSwaps: 0,
      preScreenedWallets: 5_000,
      structuralCandidates: 0
    });
    const requests: Array<{ address: string; request: HeliusSignaturePageRequest }> = [];
    const worker = new WalletIndexWorker(repository, "unused-in-test", undefined, {
      rpc: {
        getSignaturesForAddress: async (address, request = {}) => {
          requests.push({ address, request });
          if (address === "history-wallet") return [];
          return [{
            signature: newest,
            slot: 11,
            blockTime: NOW.getTime() / 1_000,
            failed: false
          }];
        },
        getTransaction: async () => confirmedSwap()
      },
      programIds: new Set([PROGRAM]),
      targetWallets: 5_000,
      signaturePageSize: 1_000,
      headMaximumRepairAgeMs: 2 * 60 * 60_000,
      deepHistoryAllowUnpricedStructuralCompletion: true,
      now: () => new Date(NOW)
    });

    expect(await worker.runOnce()).toBe(true); // managed history gets the first fair turn
    expect(await worker.runOnce()).toBe(true); // the confirmed head gets the next fair turn
    expect(requests).toEqual([
      { address: "history-wallet", request: { limit: 1_000, until: undefined } },
      { address: PROGRAM, request: { limit: 1_000, until: initial } }
    ]);
    expect(repository.getWalletIndexTransaction(newest)).toMatchObject({ status: "PENDING" });
    expect(repository.getWalletIndexCheckpoint("helius-jupiter-program-head", PROGRAM))
      .toMatchObject({ lastSignature: newest, slot: 11 });
  });

  it("keeps managed historical discovery but issues no global head polls when maintenance is disabled", async () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const programRequests: HeliusSignaturePageRequest[] = [];
    let deepHistoryPhase = false;
    const rpc: HeliusIndexRpc = {
      getSignaturesForAddress: async (address, request = {}) => {
        if (address === PROGRAM) {
          programRequests.push(request);
          return request.until || request.before
            ? []
            : [{
                signature: SIGNATURE,
                slot: 42,
                blockTime: NOW.getTime() / 1_000,
                confirmationStatus: "confirmed",
                failed: false
              }];
        }
        return deepHistoryPhase ? [] : activityRows();
      },
      getTransaction: async () => confirmedSwap()
    };
    const bootstrap = new WalletIndexWorker(repository, "unused-in-test", undefined, {
      rpc,
      programIds: new Set([PROGRAM]),
      targetWallets: 1,
      hydrationBatchSize: 5,
      preScreenBatchSize: 5,
      deepHistoryEnabled: false,
      programHeadMaintenanceEnabled: false,
      now: () => new Date(NOW)
    });

    expect(await bootstrap.runOnce()).toBe(true); // historical program discovery
    expect(await bootstrap.runOnce()).toBe(true); // hydration
    expect(await bootstrap.runOnce()).toBe(true); // activity pre-screen
    expect(await bootstrap.runOnce()).toBe(false); // bootstrap completion
    expect(await bootstrap.runOnce()).toBe(false); // no post-bootstrap head poll
    expect(programRequests).toEqual([{ limit: 1_000 }]);
    expect(repository.getWalletIndexCheckpoint("helius-jupiter-program-index", PROGRAM))
      .toMatchObject({ lastSignature: SIGNATURE, slot: 42 });
    expect(repository.getWalletIndexCheckpoint("helius-jupiter-program-head", PROGRAM)).toBeUndefined();

    deepHistoryPhase = true;
    const coarsePass = {
      ...repository.getWalletIndexRecord(WALLET)!,
      medianHoldingMinutes: 20,
      updatedAt: NOW.toISOString()
    };
    repository.upsertWalletIndexRecord(coarsePass);
    repository.saveWalletPreScreenSnapshot({
      wallet: WALLET,
      runId: "zzzz-managed-coarse-pass",
      calculatedAt: NOW.toISOString(),
      eligible: true,
      reasons: [],
      record: coarsePass
    });
    repository.createWalletDeepHistoryCohort({
      selectedAt: NOW.toISOString(),
      snapshotCutoffAt: NOW.toISOString(),
      windowStart: new Date(NOW.getTime() - 90 * 86_400_000).toISOString(),
      windowEnd: NOW.toISOString(),
      wallets: [WALLET]
    });
    const managedResearch = new WalletIndexWorker(repository, "unused-in-test", undefined, {
      rpc,
      programIds: new Set([PROGRAM]),
      targetWallets: 1,
      deepHistoryAllowUnpricedStructuralCompletion: true,
      programHeadMaintenanceEnabled: false,
      now: () => new Date(NOW)
    });

    expect(await managedResearch.runOnce()).toBe(true);
    expect(repository.openWalletDeepHistoryCohort()).toBeDefined();
    expect(await managedResearch.runOnce()).toBe(true);
    expect(programRequests).toEqual([{ limit: 1_000 }]);
    expect(repository.getWalletIndexCheckpoint("helius-jupiter-program-head", PROGRAM)).toBeUndefined();
  });

  it("quarantines an oversized managed gap before paper and proves a new forward head epoch", async () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const oldHead = "old-managed-head";
    const seedHead = "new-forward-seed";
    repository.saveWalletIndexCheckpoint({
      pipeline: "helius-jupiter-program-index",
      partition: PROGRAM,
      completed: false,
      updatedAt: new Date(NOW.getTime() - 60 * 60_000).toISOString(),
      lastSignature: oldHead,
      slot: 10,
      blockTime: new Date(NOW.getTime() - 60 * 60_000).toISOString()
    });
    repository.createWalletDeepHistoryCohort({
      selectedAt: NOW.toISOString(),
      snapshotCutoffAt: NOW.toISOString(),
      windowStart: new Date(NOW.getTime() - 90 * 86_400_000).toISOString(),
      windowEnd: NOW.toISOString(),
      wallets: ["history-wallet"]
    });
    let clock = new Date(NOW);
    const requests: HeliusSignaturePageRequest[] = [];
    const worker = new WalletIndexWorker(repository, "unused-in-test", undefined, {
      rpc: {
        getSignaturesForAddress: async (_address, request = {}) => {
          requests.push(request);
          return request.limit === 1 && request.until === undefined
            ? [{
                signature: seedHead,
                slot: 20,
                blockTime: NOW.getTime() / 1_000,
                failed: false
              }]
            : [];
        },
        getTransaction: async () => confirmedSwap()
      },
      programIds: new Set([PROGRAM]),
      targetWallets: 5_000,
      deepHistoryEnabled: false,
      allowHeadEpochReseed: () => true,
      now: () => new Date(clock)
    });

    expect(await worker.runOnce()).toBe(true);
    expect(requests).toEqual([{ limit: 1 }]);
    expect(repository.getWalletIndexCheckpoint("helius-jupiter-program-head", PROGRAM)).toMatchObject({
      lastSignature: seedHead,
      slot: 20,
      metadata: {
        coverageStartSlot: 21,
        gapReason: "MANAGED_GAP_QUARANTINED_BEFORE_PAPER_MONITORING"
      }
    });
    expect(await worker.runOnce()).toBe(true); // hydrate the exact seed
    clock = new Date(clock.getTime() + 61_000);
    expect(await worker.runOnce()).toBe(true); // empty poll proves the seed-only range
    expect(requests.at(-1)).toEqual({ limit: 1_000, until: seedHead });
    expect(repository.getWalletIndexCheckpoint("helius-jupiter-program-head", PROGRAM)).toMatchObject({
      lastSignature: seedHead,
      slot: 20,
      metadata: {
        coverageStartSlot: 20,
        coverageEndSlot: 20,
        gapReason: "MANAGED_GAP_QUARANTINED_BEFORE_PAPER_MONITORING"
      }
    });
  });

  it("seeds a newly enabled direct program with one bounded head request instead of a bulk backfill", async () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const seedSignature = "direct-head-seed";
    const requests: Array<{ address: string; request: HeliusSignaturePageRequest }> = [];
    const rpc: HeliusIndexRpc = {
      getSignaturesForAddress: async (address, request = {}) => {
        requests.push({ address, request });
        if (address === ORCA_WHIRLPOOL_PROGRAM_ID) {
          return [{
            signature: seedSignature,
            slot: 99,
            blockTime: NOW.getTime() / 1_000,
            confirmationStatus: "confirmed",
            failed: false
          }];
        }
        return [];
      },
      getTransaction: async () => confirmedSwap()
    };
    const existingRecord: WalletIndexRecord = {
      wallet: WALLET,
      firstSeenAt: NOW.toISOString(),
      lastSeenAt: NOW.toISOString(),
      historyDays: 90,
      transactionCount: 60,
      successfulTransactionCount: 60,
      spotSwapCount: 1,
      eligibleSpotSwapCount: 1,
      closedEligibleSwaps: 0,
      buyCount: 1,
      sellCount: 0,
      activeDays: 3,
      activeWeeks: 3,
      distinctMints: 1,
      medianHoldingMinutes: 0,
      preScreenEligible: true,
      preScreenReasons: [],
      updatedAt: NOW.toISOString()
    };
    repository.upsertWalletIndexRecord(existingRecord);
    repository.saveWalletPreScreenSnapshot({
      wallet: WALLET,
      runId: "completed-bootstrap",
      calculatedAt: NOW.toISOString(),
      eligible: true,
      reasons: [],
      record: existingRecord
    });
    repository.upsertWalletIndexRun({
      id: "completed-bootstrap",
      stage: "COMPLETE",
      startedAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      finishedAt: NOW.toISOString(),
      discoveredWallets: 5_000,
      enqueuedSignatures: 0,
      hydratedTransactions: 0,
      indexedSwaps: 0,
      preScreenedWallets: 0,
      structuralCandidates: 0
    });
    const worker = new WalletIndexWorker(repository, "unused-in-test", undefined, {
      rpc,
      programIds: new Set([ORCA_WHIRLPOOL_PROGRAM_ID]),
      targetWallets: 1,
      signaturePageSize: 1_000,
      deepHistoryEnabled: false,
      now: () => new Date(NOW)
    });

    expect(await worker.runOnce()).toBe(false); // close the new maintenance run
    expect(await worker.runOnce()).toBe(true); // seed the new direct-program head
    expect(requests).toEqual([{
      address: ORCA_WHIRLPOOL_PROGRAM_ID,
      request: { limit: 1 }
    }]);
    expect(repository.getWalletIndexCheckpoint("helius-jupiter-program-head", ORCA_WHIRLPOOL_PROGRAM_ID))
      .toMatchObject({
        lastSignature: seedSignature,
        slot: 99,
        metadata: { lastPageCount: 1, coverageStartSlot: 100 }
      });
    expect(repository.listWalletIndexTransactionSources(seedSignature)).toEqual([
      expect.objectContaining({
        source: "helius-program-head",
        sourceAddress: ORCA_WHIRLPOOL_PROGRAM_ID,
        metadata: expect.objectContaining({ headSeed: true })
      })
    ]);
  });

  it("resumes a multi-page head gap after restart without committing the new head early", async () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const initial = "initial-head";
    const newest = "newest-3";
    const middle = "newest-2";
    const oldestNew = "newest-1";
    const programRequests: HeliusSignaturePageRequest[] = [];
    const rpc: HeliusIndexRpc = {
      getSignaturesForAddress: async (address, request = {}) => {
        if (address !== PROGRAM) return activityRows();
        programRequests.push(request);
        if (!request.until) {
          return [{ signature: initial, slot: 40, blockTime: NOW.getTime() / 1_000, failed: false }];
        }
        if (!request.before) {
          return [
            { signature: newest, slot: 43, blockTime: NOW.getTime() / 1_000 + 3, failed: false },
            { signature: middle, slot: 42, blockTime: NOW.getTime() / 1_000 + 2, failed: false }
          ];
        }
        return [{
          signature: oldestNew,
          slot: 41,
          blockTime: NOW.getTime() / 1_000 + 1,
          failed: false
        }];
      },
      getTransaction: async () => confirmedSwap()
    };
    const options = {
      rpc,
      programIds: new Set([PROGRAM]),
      targetWallets: 1,
      signaturePageSize: 2,
      hydrationBatchSize: 10,
      headSyncIntervalMs: 60_000,
      deepHistoryEnabled: false,
      now: () => new Date(NOW)
    } as const;
    const firstWorker = new WalletIndexWorker(repository, "unused-in-test", undefined, options);

    expect(await firstWorker.runOnce()).toBe(true);
    expect(await firstWorker.runOnce()).toBe(true);
    expect(await firstWorker.runOnce()).toBe(true);
    expect(await firstWorker.runOnce()).toBe(false);
    expect(await firstWorker.runOnce()).toBe(true); // first full head page

    expect(repository.getWalletIndexCheckpoint("helius-jupiter-program-head", PROGRAM)).toMatchObject({
      lastSignature: initial,
      cursor: initial,
      beforeSignature: middle,
      metadata: {
        cyclePages: 1,
        candidateHeadSignature: newest,
        candidateHeadSlot: 43,
        coverageStartSlot: 41
      }
    });

    const restartedWorker = new WalletIndexWorker(repository, "unused-in-test", undefined, options);
    expect(await restartedWorker.runOnce()).toBe(true); // durable queue hydration
    expect(await restartedWorker.runOnce()).toBe(false); // finish restarted maintenance run
    expect(await restartedWorker.runOnce()).toBe(true); // resume before+until page

    expect(programRequests.at(-1)).toEqual({ limit: 2, before: middle, until: initial });
    const resumedHead = repository.getWalletIndexCheckpoint("helius-jupiter-program-head", PROGRAM);
    expect(resumedHead).toMatchObject({
      lastSignature: newest,
      slot: 43,
      metadata: {
        cycles: 1,
        lastCyclePages: 2,
        lastPageCount: 1,
        coverageStartSlot: 41,
        coverageEndSlot: 43
      }
    });
    expect(resumedHead?.cursor).toBeUndefined();
    expect(resumedHead?.beforeSignature).toBeUndefined();
    expect(repository.walletIndexCoverage().uniqueSignatures).toBe(4);
    expect(repository.walletIndexCoverage().queueByStatus.PENDING).toBe(1);
  });

  it("keeps retryable provider outages alive beyond five attempts with bounded long backoff", async () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    repository.enqueueWalletIndexTransactions([{
      signature: "transient-provider-signature",
      sourceAddress: PROGRAM,
      source: "test",
      discoveredAt: NOW.toISOString(),
      metadata: { failed: false }
    }]);
    let clock = new Date(NOW);
    let calls = 0;
    const worker = new WalletIndexWorker(repository, "unused-in-test", undefined, {
      rpc: {
        getSignaturesForAddress: async () => [],
        getTransaction: async () => {
          calls += 1;
          throw new ProviderApiError("Helius index RPC", "temporary outage", {
            status: 503,
            retryable: true
          });
        }
      },
      programIds: new Set([PROGRAM]),
      targetWallets: 1,
      deepHistoryEnabled: false,
      now: () => new Date(clock)
    });

    for (let attempt = 1; attempt <= 6; attempt += 1) {
      expect(await worker.runOnce()).toBe(true);
      expect(repository.getWalletIndexTransaction("transient-provider-signature")).toMatchObject({
        status: "RETRY",
        attempts: attempt,
        lastError: expect.stringContaining("transient provider failure")
      });
      clock = new Date(clock.getTime() + 7 * 60 * 60_000);
    }
    expect(calls).toBe(6);
  });

  it("never counts an allowed-program transaction with malformed balance evidence as hydrated", async () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    repository.enqueueWalletIndexTransactions([{
      signature: "malformed-provider-signature",
      sourceAddress: PROGRAM,
      source: "test",
      discoveredAt: NOW.toISOString(),
      metadata: { failed: false }
    }]);
    let clock = new Date(NOW);
    let calls = 0;
    const worker = new WalletIndexWorker(repository, "unused-in-test", undefined, {
      rpc: {
        getSignaturesForAddress: async () => [],
        getTransaction: async () => {
          calls += 1;
          const raw = confirmedSwap() as { meta: Record<string, unknown> };
          return { ...raw, meta: { ...raw.meta, preTokenBalances: undefined } };
        }
      },
      programIds: new Set([PROGRAM]),
      targetWallets: 1,
      deepHistoryEnabled: false,
      now: () => new Date(clock)
    });

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      expect(await worker.runOnce()).toBe(true);
      clock = new Date(clock.getTime() + 60_000);
    }
    expect(calls).toBe(5);
    expect(repository.getWalletIndexTransaction("malformed-provider-signature")).toMatchObject({
      status: "FAILED",
      attempts: 5,
      lastError: expect.stringContaining("non-retryable data failure")
    });
    expect(repository.walletIndexCoverage()).toMatchObject({ indexedTransactions: 0, indexedSwaps: 0 });
  });

  it("lets one fresh managed acquisition page outrank the independent SOL reprice queue", async () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const repriceRead = vi.spyOn(repository, "nextPendingIndexedSwapReprice")
      .mockImplementation(() => { throw new Error("managed repricing ran before acquisition"); });
    const canDiscoverPage = vi.fn(() => true);
    const worker = new WalletIndexWorker(repository, "unused-in-test", undefined, {
      rpc: {
        getSignaturesForAddress: async () => [{
          signature: SIGNATURE,
          slot: 42,
          blockTime: Math.floor(NOW.getTime() / 1_000),
          failed: false
        }],
        getTransaction: async () => null
      },
      programIds: new Set([PROGRAM]),
      targetWallets: 5_000,
      getTargetWallets: () => 10_000,
      canDiscoverPage,
      deepHistoryEnabled: false,
      deepHistoryAllowUnpricedStructuralCompletion: true,
      programHeadMaintenanceEnabled: false,
      now: () => new Date(NOW)
    });

    await expect(worker.runOnce()).resolves.toBe(true);
    expect(canDiscoverPage).toHaveBeenCalledOnce();
    expect(repriceRead).not.toHaveBeenCalled();
    expect(repository.getWalletIndexTransaction(SIGNATURE)).toMatchObject({ status: "PENDING" });
    expect(repository.listWalletIndexRuns(1)[0]?.configuration).toMatchObject({ targetWallets: 10_000 });
  });

  it("reports an exhausted managed discovery source at the drained acquisition boundary", async () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const drained: boolean[] = [];
    const worker = new WalletIndexWorker(repository, "unused-in-test", undefined, {
      rpc: {
        getSignaturesForAddress: async () => [],
        getTransaction: async () => null
      },
      programIds: new Set([PROGRAM]),
      targetWallets: 5_000,
      getTargetWallets: () => 10_000,
      canDiscoverPage: () => true,
      onAcquisitionPipelineDrained: (sourceExhausted) => {
        drained.push(sourceExhausted);
        return true;
      },
      deepHistoryEnabled: false,
      deepHistoryAllowUnpricedStructuralCompletion: true,
      programHeadMaintenanceEnabled: false,
      now: () => new Date(NOW)
    });

    await expect(worker.runOnce()).resolves.toBe(true);
    expect(drained).toEqual([true]);
    expect(repository.getWalletIndexCheckpoint("helius-jupiter-program-index", PROGRAM))
      .toMatchObject({ completed: true });
  });

  it("does not advance or discover between multiple all-skipped cohorts in one frozen generation", async () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const actualCoverage = repository.walletIndexCoverage.bind(repository);
    vi.spyOn(repository, "walletIndexCoverage").mockImplementation((at) => ({
      ...actualCoverage(at),
      indexedWallets: 5_000
    }));
    for (let index = 0; index < 201; index += 1) {
      const wallet = `all-skipped-wallet-${index.toString().padStart(3, "0")}`;
      const record: WalletIndexRecord = {
        wallet,
        firstSeenAt: new Date(NOW.getTime() - 90 * 86_400_000).toISOString(),
        lastSeenAt: NOW.toISOString(),
        historyDays: 90,
        transactionCount: 60,
        successfulTransactionCount: 60,
        spotSwapCount: 20,
        eligibleSpotSwapCount: 20,
        closedEligibleSwaps: 0,
        buyCount: 10,
        sellCount: 10,
        activeDays: 10,
        activeWeeks: 4,
        distinctMints: 5,
        medianHoldingMinutes: 5,
        preScreenEligible: true,
        preScreenReasons: [],
        deepHistoryStatus: "AWAITING",
        structuralEligible: false,
        structuralReasons: ["awaiting local deep history"],
        updatedAt: NOW.toISOString()
      };
      repository.upsertWalletIndexRecord(record);
      repository.saveWalletPreScreenSnapshot({
        wallet,
        runId: "all-skipped-prescreen",
        calculatedAt: NOW.toISOString(),
        eligible: true,
        reasons: [],
        record
      });
    }
    const acquisition = new WalletAcquisitionController(repository, { now: () => new Date(NOW) });
    expect(acquisition.targetWallets()).toBe(5_000);
    let rpcCalls = 0;
    const worker = new WalletIndexWorker(repository, "unused-in-test", undefined, {
      rpc: {
        getSignaturesForAddress: async () => { rpcCalls += 1; return []; },
        getTransaction: async () => { rpcCalls += 1; return null; }
      },
      programIds: new Set([PROGRAM]),
      targetWallets: 5_000,
      getTargetWallets: () => acquisition.targetWallets(),
      canDiscoverPage: () => acquisition.canDiscoverPage(),
      onAcquisitionPipelineDrained: (sourceExhausted) => acquisition.onPipelineDrained(sourceExhausted),
      deepHistoryTargetLimit: 100,
      deepHistoryIncludeExistingBacklog: true,
      deepHistoryAllowUnpricedStructuralCompletion: true,
      deepHistoryCanStartNextCohort: () => acquisition.shouldContinueResearch(),
      programHeadMaintenanceEnabled: false,
      now: () => new Date(NOW)
    });

    let yieldedBeforeTerminalRollover = false;
    setImmediate(() => {
      yieldedBeforeTerminalRollover = true;
    });
    expect(await worker.runOnce()).toBe(true);
    expect(yieldedBeforeTerminalRollover).toBe(true);
    expect({
      targetWallets: acquisition.targetWallets(),
      openGeneration: repository.openWalletDeepHistoryGeneration()?.status,
      cohortScreenings: (repository.db.prepare(`
        SELECT COUNT(*) AS count FROM wallet_deep_history_managed_cohort_screenings
      `).get() as { count: number }).count,
      generationScreenings: (repository.db.prepare(`
        SELECT COUNT(*) AS count FROM wallet_deep_history_managed_generation_screenings
      `).get() as { count: number }).count
    }).toEqual({
      targetWallets: 5_000,
      openGeneration: "OPEN",
      cohortScreenings: 2,
      generationScreenings: 0
    });

    expect(await worker.runOnce()).toBe(true);
    expect(acquisition.targetWallets()).toBe(5_000);
    expect(repository.openWalletDeepHistoryGeneration()).toBeUndefined();
    expect(repository.db.prepare(`
      SELECT COUNT(*) AS count FROM wallet_deep_history_managed_generation_screenings
    `).get()).toEqual({ count: 1 });

    expect(await worker.runOnce()).toBe(true);
    expect(acquisition.targetWallets()).toBe(10_000);
    expect(repository.db.prepare(`
      SELECT COUNT(*) AS count FROM wallet_deep_history_managed_cohort_screenings
    `).get()).toEqual({ count: 3 });
    expect(rpcCalls).toBe(0);
  });
});
