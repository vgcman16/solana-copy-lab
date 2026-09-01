import { afterEach, describe, expect, it, vi } from "vitest";
import type { HeliusIndexRpc } from "@copylab/providers";
import { USDC_MINT, type WalletIndexRun } from "@copylab/shared";
import type { CopyLabDatabase } from "../src/database.js";
import { openDatabase } from "../src/database.js";
import { Repository } from "../src/repository.js";
import { ParsedBlockRepairRepository } from "../src/parsed-block-repair-repository.js";
import { ParsedBlockRepairWorker } from "../src/parsed-block-repair-worker.js";
import {
  KNOWN_AFFECTED_PARSED_BLOCK_REPAIR_CUTOFF_AT,
  KNOWN_AFFECTED_WALLET_INDEX_RUN_ID,
  KNOWN_AFFECTED_WALLET_INDEX_RUN_STARTED_AT
} from "../src/parsed-block-repair-types.js";

const PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const RAYDIUM_CPMM_PROGRAM = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C";
const EVENT_AUTHORITY = "D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf";
const WALLET = "Vote111111111111111111111111111111111111111";
const TARGET = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6zSsrPeAC8B1pPB";
const USDC_ACCOUNT = "UsdcAccount1111111111111111111111111111111";
const TARGET_ACCOUNT = "TargetAccount11111111111111111111111111111";
const TEST_SIGNATURE = "4".repeat(88);
const SLOT = 302_000_001;
const SECOND_SIGNATURE = "5".repeat(88);
const THIRD_SIGNATURE = "6".repeat(88);
const INDEXED_AT = "2026-07-10T20:00:00.000Z";
const NOW = new Date("2026-07-11T00:00:00.000Z");
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

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

const u16 = (value: number): number[] => [value & 0xff, (value >>> 8) & 0xff];
const u32 = (value: number): number[] => [
  value & 0xff,
  (value >>> 8) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 24) & 0xff
];
const u64 = (value: bigint): number[] => Array.from(
  { length: 8 },
  (_unused, index) => Number((value >> BigInt(index * 8)) & 0xffn)
);
const ROUTE_DATA = base58Encode([
  229, 23, 203, 151, 122, 227, 173, 42,
  ...u32(1),
  7, 100, 0, 1,
  ...u64(4_000_000n),
  ...u64(2_000_000n),
  ...u16(50),
  0
]);
const RAYDIUM_SWAP_DATA = "E73fXHPWvSR8VCr6ujjfVSBYgv1v9V5Dy";

function swapFixture(signature: string) {
  return {
    slot: SLOT,
    blockTime: 1_720_000_000,
    transaction: {
      signatures: [signature],
      message: {
        accountKeys: [
          { pubkey: WALLET, signer: true, writable: true },
          { pubkey: USDC_ACCOUNT, signer: false, writable: true },
          { pubkey: TARGET_ACCOUNT, signer: false, writable: true }
        ],
        instructions: [{
          programId: PROGRAM,
          accounts: [
            TOKEN_PROGRAM,
            WALLET,
            USDC_ACCOUNT,
            TARGET_ACCOUNT,
            TARGET_ACCOUNT,
            TARGET,
            PROGRAM,
            EVENT_AUTHORITY,
            PROGRAM
          ],
          data: ROUTE_DATA
        }]
      }
    },
    meta: {
      err: null,
      fee: 5_000,
      preBalances: [10_000_000_000, 0, 0],
      postBalances: [9_999_995_000, 0, 0],
      preTokenBalances: [
        { accountIndex: 1, owner: WALLET, mint: USDC_MINT, uiTokenAmount: { amount: "5000000", decimals: 6 } },
        { accountIndex: 2, owner: WALLET, mint: TARGET, uiTokenAmount: { amount: "0", decimals: 6 } }
      ],
      postTokenBalances: [
        { accountIndex: 1, owner: WALLET, mint: USDC_MINT, uiTokenAmount: { amount: "1000000", decimals: 6 } },
        { accountIndex: 2, owner: WALLET, mint: TARGET, uiTokenAmount: { amount: "2000000", decimals: 6 } }
      ],
      innerInstructions: [{
        index: 0,
        instructions: [{ programId: RAYDIUM_CPMM_PROGRAM, accounts: [], data: RAYDIUM_SWAP_DATA }]
      }],
      logMessages: [`Program ${PROGRAM} invoke [1]`]
    },
    version: 0
  };
}

function indexRun(): WalletIndexRun {
  return {
    id: KNOWN_AFFECTED_WALLET_INDEX_RUN_ID,
    stage: "HYDRATION",
    startedAt: KNOWN_AFFECTED_WALLET_INDEX_RUN_STARTED_AT,
    updatedAt: INDEXED_AT,
    discoveredWallets: 5_004,
    enqueuedSignatures: 2,
    hydratedTransactions: 2,
    indexedSwaps: 0,
    preScreenedWallets: 0,
    structuralCandidates: 0
  };
}

function seed(db: CopyLabDatabase, signature: string): void {
  const normalized = {
    signature,
    status: "PROCESSED",
    attempts: 1,
    priority: 0,
    discoveredAt: INDEXED_AT,
    availableAt: INDEXED_AT,
    updatedAt: INDEXED_AT,
    sourceWallets: [],
    slot: SLOT,
    success: true,
    indexedAt: INDEXED_AT,
    processedAt: INDEXED_AT
  };
  db.prepare(`
    INSERT INTO index_signature_queue(
      signature, slot, block_time, status, attempts, priority,
      discovered_at, available_at, processed_at, updated_at
    ) VALUES (?, ?, ?, 'PROCESSED', 1, 0, ?, ?, ?, ?)
  `).run(signature, SLOT, INDEXED_AT, INDEXED_AT, INDEXED_AT, INDEXED_AT, INDEXED_AT);
  db.prepare(`
    INSERT INTO index_signature_sources(
      signature, source_address, wallet, source, first_seen_at, last_seen_at,
      discovery_count, first_run_id, last_run_id, metadata_json
    ) VALUES (?, ?, '', 'helius-program-signature', ?, ?, 1, ?, ?, NULL)
  `).run(
    signature,
    PROGRAM,
    INDEXED_AT,
    INDEXED_AT,
    KNOWN_AFFECTED_WALLET_INDEX_RUN_ID,
    KNOWN_AFFECTED_WALLET_INDEX_RUN_ID
  );
  db.prepare(`
    INSERT INTO indexed_transactions(
      signature, slot, block_time, success, fee_payer, source_wallets_json,
      account_keys_json, program_ids_json, transaction_json, indexed_at
    ) VALUES (?, ?, ?, 1, NULL, '[]', NULL, NULL, ?, ?)
  `).run(signature, SLOT, INDEXED_AT, JSON.stringify(normalized), INDEXED_AT);
}

function strictZero(signature: string) {
  const value = swapFixture(signature);
  return {
    ...value,
    transaction: {
      ...value.transaction,
      message: {
        ...value.transaction.message,
        // Jupiter is present but this is deliberately not a recognized strict
        // route shape. It must be VALID_ZERO, never a permissive recovery.
        instructions: [{ programId: PROGRAM, accounts: [], data: "1" }]
      }
    }
  };
}

describe("ParsedBlockRepairWorker", () => {
  let db: CopyLabDatabase | undefined;
  afterEach(() => db?.close());

  it("hydrates one grouped slot from jsonParsed block and falls back only for a missing signature", async () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    repository.upsertWalletIndexRun(indexRun());
    seed(db, TEST_SIGNATURE);
    seed(db, SECOND_SIGNATURE);
    const repair = new ParsedBlockRepairRepository(repository);
    const manifest = repair.createManifest({
      sourceRunId: KNOWN_AFFECTED_WALLET_INDEX_RUN_ID,
      sourceRunStartedAt: KNOWN_AFFECTED_WALLET_INDEX_RUN_STARTED_AT,
      cutoffAt: KNOWN_AFFECTED_PARSED_BLOCK_REPAIR_CUTOFF_AT,
      at: NOW
    });
    const swapTransaction = swapFixture(TEST_SIGNATURE);
    const zeroTransaction = strictZero(SECOND_SIGNATURE);
    const getBlock = vi.fn(async () => ({
      blockTime: swapTransaction.blockTime,
      // The second frozen signature is intentionally absent and must use the
      // ordinary per-signature jsonParsed fallback.
      transactions: [swapTransaction]
    }));
    const getTransaction = vi.fn(async (signature: string) =>
      signature === SECOND_SIGNATURE ? zeroTransaction : null
    );
    const rpc: HeliusIndexRpc = {
      getSignaturesForAddress: async () => [],
      getTransaction,
      getBlock
    };
    const worker = new ParsedBlockRepairWorker(repair, undefined, {
      rpc,
      programIds: new Set([PROGRAM]),
      batchSize: 10,
      blockPrefetchEnabled: true,
      now: () => NOW
    });

    expect(await worker.runOnce()).toBe(true);
    expect(getBlock).toHaveBeenCalledTimes(1);
    expect(getBlock).toHaveBeenCalledWith(SLOT);
    expect(getTransaction).toHaveBeenCalledTimes(1);
    expect(getTransaction).toHaveBeenCalledWith(SECOND_SIGNATURE);
    expect(repair.coverage(manifest.id, NOW)).toMatchObject({
      total: 2,
      recovered: 1,
      validZero: 1,
      retry: 0,
      failed: 0,
      recoveredSwaps: 1,
      manifest: { status: "COMPLETE" }
    });
    expect(repair.getItem(manifest.id, TEST_SIGNATURE)).toMatchObject({
      status: "RECOVERED",
      hydrationProvenance: "PARSED_BLOCK_REPAIR",
      resultSwapCount: 1
    });
    expect(repair.getItem(manifest.id, SECOND_SIGNATURE)).toMatchObject({
      status: "VALID_ZERO",
      hydrationProvenance: "PARSED_TRANSACTION_REPAIR_FALLBACK",
      resultSwapCount: 0
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM indexed_spot_swaps").get()).toEqual({ count: 1 });
  });

  it("uses bounded per-signature hydration by default even when getBlock is available", async () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    repository.upsertWalletIndexRun(indexRun());
    seed(db, TEST_SIGNATURE);
    seed(db, SECOND_SIGNATURE);
    const repair = new ParsedBlockRepairRepository(repository);
    const manifest = repair.createManifest({
      sourceRunId: KNOWN_AFFECTED_WALLET_INDEX_RUN_ID,
      sourceRunStartedAt: KNOWN_AFFECTED_WALLET_INDEX_RUN_STARTED_AT,
      cutoffAt: KNOWN_AFFECTED_PARSED_BLOCK_REPAIR_CUTOFF_AT,
      at: NOW
    });
    const getBlock = vi.fn(async () => ({
      blockTime: 1_720_000_000,
      transactions: [swapFixture(TEST_SIGNATURE), strictZero(SECOND_SIGNATURE)]
    }));
    const getTransaction = vi.fn(async (signature: string) =>
      signature === TEST_SIGNATURE ? swapFixture(signature) : strictZero(signature)
    );
    const worker = new ParsedBlockRepairWorker(repair, undefined, {
      rpc: {
        getSignaturesForAddress: async () => [],
        getTransaction,
        getBlock
      },
      programIds: new Set([PROGRAM]),
      batchSize: 10,
      now: () => NOW
    });

    expect(await worker.runOnce()).toBe(true);
    expect(getBlock).not.toHaveBeenCalled();
    expect(getTransaction).toHaveBeenCalledTimes(2);
    expect(getTransaction).toHaveBeenNthCalledWith(1, TEST_SIGNATURE);
    expect(getTransaction).toHaveBeenNthCalledWith(2, SECOND_SIGNATURE);
    expect(repair.coverage(manifest.id, NOW)).toMatchObject({
      recovered: 1,
      validZero: 1,
      retry: 0,
      failed: 0,
      recoveredSwaps: 1,
      manifest: { status: "COMPLETE" }
    });
  });

  it("bounds transaction prefetch while applying frozen manifest items sequentially", async () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    repository.upsertWalletIndexRun(indexRun());
    for (const signature of [TEST_SIGNATURE, SECOND_SIGNATURE, THIRD_SIGNATURE]) seed(db, signature);
    const repair = new ParsedBlockRepairRepository(repository);
    const manifest = repair.createManifest({
      sourceRunId: KNOWN_AFFECTED_WALLET_INDEX_RUN_ID,
      sourceRunStartedAt: KNOWN_AFFECTED_WALLET_INDEX_RUN_STARTED_AT,
      cutoffAt: KNOWN_AFFECTED_PARSED_BLOCK_REPAIR_CUTOFF_AT,
      at: NOW
    });
    const pending = new Map<string, (value: unknown) => void>();
    const getTransaction = vi.fn((signature: string) => new Promise<unknown>((resolve) => {
      pending.set(signature, resolve);
    }));
    const apply = vi.spyOn(repair, "apply");
    const worker = new ParsedBlockRepairWorker(repair, undefined, {
      rpc: {
        getSignaturesForAddress: async () => [],
        getTransaction
      },
      programIds: new Set([PROGRAM]),
      batchSize: 10,
      transactionPrefetch: 2,
      now: () => NOW
    });

    const run = worker.runOnce();
    expect(getTransaction).toHaveBeenCalledTimes(2);
    expect(getTransaction).toHaveBeenNthCalledWith(1, TEST_SIGNATURE);
    expect(getTransaction).toHaveBeenNthCalledWith(2, SECOND_SIGNATURE);
    expect(apply).not.toHaveBeenCalled();

    // A later response may arrive first, but no SQLite result is applied out
    // of the manifest's deterministic lease order.
    pending.get(SECOND_SIGNATURE)?.(strictZero(SECOND_SIGNATURE));
    await Promise.resolve();
    expect(apply).not.toHaveBeenCalled();

    pending.get(TEST_SIGNATURE)?.(strictZero(TEST_SIGNATURE));
    await vi.waitFor(() => {
      expect(getTransaction).toHaveBeenCalledTimes(3);
      expect(apply).toHaveBeenCalledTimes(2);
    });
    pending.get(THIRD_SIGNATURE)?.(strictZero(THIRD_SIGNATURE));
    await run;

    expect(apply.mock.calls.map(([input]) => input.item.signature)).toEqual([
      TEST_SIGNATURE,
      SECOND_SIGNATURE,
      THIRD_SIGNATURE
    ]);
    expect(repair.coverage(manifest.id, NOW)).toMatchObject({
      total: 3,
      recovered: 0,
      validZero: 3,
      retry: 0,
      failed: 0,
      manifest: { status: "COMPLETE" }
    });
  });
});
