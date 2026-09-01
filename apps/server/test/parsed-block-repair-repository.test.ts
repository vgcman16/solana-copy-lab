import { afterEach, describe, expect, it } from "vitest";
import { USDC_MINT, type IndexedSpotSwap, type WalletIndexRun, type WalletIndexTransaction } from "@copylab/shared";
import type { CopyLabDatabase } from "../src/database.js";
import { openDatabase } from "../src/database.js";
import { Repository } from "../src/repository.js";
import { ParsedBlockRepairRepository } from "../src/parsed-block-repair-repository.js";
import {
  KNOWN_AFFECTED_PARSED_BLOCK_REPAIR_CUTOFF_AT,
  KNOWN_AFFECTED_WALLET_INDEX_RUN_ID,
  KNOWN_AFFECTED_WALLET_INDEX_RUN_STARTED_AT,
  PARSED_BLOCK_REPAIR_DECODER_VERSION
} from "../src/parsed-block-repair-types.js";

const PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const WALLET = "Vote111111111111111111111111111111111111111";
const TARGET = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6zSsrPeAC8B1pPB";
const MANIFEST_CREATED_AT = new Date("2026-07-11T00:00:00.000Z");

interface SeedOptions {
  indexedAt?: string;
  success?: boolean;
  runId?: string;
  deepHistory?: boolean;
  existingSwap?: boolean;
}

function run(id = KNOWN_AFFECTED_WALLET_INDEX_RUN_ID): WalletIndexRun {
  return {
    id,
    stage: "HYDRATION",
    startedAt: KNOWN_AFFECTED_WALLET_INDEX_RUN_STARTED_AT,
    updatedAt: "2026-07-10T22:00:00.000Z",
    discoveredWallets: 5_004,
    enqueuedSignatures: 180_000,
    hydratedTransactions: 53_000,
    indexedSwaps: 2,
    preScreenedWallets: 1_680,
    structuralCandidates: 2
  };
}

function seed(
  db: CopyLabDatabase,
  signature: string,
  slot: number,
  options: SeedOptions = {}
): void {
  const indexedAt = options.indexedAt ?? "2026-07-10T20:00:00.000Z";
  const sourceRunId = options.runId ?? KNOWN_AFFECTED_WALLET_INDEX_RUN_ID;
  const success = options.success ?? true;
  const transaction = {
    signature,
    status: "PROCESSED",
    attempts: 1,
    priority: 0,
    discoveredAt: indexedAt,
    availableAt: indexedAt,
    updatedAt: indexedAt,
    sourceWallets: [],
    slot,
    success,
    indexedAt,
    processedAt: indexedAt
  };
  db.prepare(`
    INSERT INTO index_signature_queue(
      signature, slot, block_time, status, attempts, priority,
      discovered_at, available_at, processed_at, updated_at
    ) VALUES (?, ?, ?, 'PROCESSED', 1, 0, ?, ?, ?, ?)
  `).run(signature, slot, "2026-07-10T19:59:59.000Z", indexedAt, indexedAt, indexedAt, indexedAt);
  db.prepare(`
    INSERT INTO index_signature_sources(
      signature, source_address, wallet, source, first_seen_at, last_seen_at,
      discovery_count, first_run_id, last_run_id, metadata_json
    ) VALUES (?, ?, '', 'helius-program-signature', ?, ?, 1, ?, ?, NULL)
  `).run(signature, PROGRAM, indexedAt, indexedAt, sourceRunId, sourceRunId);
  if (options.deepHistory) {
    db.prepare(`
      INSERT INTO index_signature_sources(
        signature, source_address, wallet, source, first_seen_at, last_seen_at,
        discovery_count, first_run_id, last_run_id, metadata_json
      ) VALUES (?, ?, ?, 'helius-wallet-deep-history', ?, ?, 1, ?, ?, NULL)
    `).run(signature, WALLET, WALLET, indexedAt, indexedAt, sourceRunId, sourceRunId);
  }
  db.prepare(`
    INSERT INTO indexed_transactions(
      signature, slot, block_time, success, fee_payer, source_wallets_json,
      account_keys_json, program_ids_json, transaction_json, indexed_at
    ) VALUES (?, ?, ?, ?, NULL, '[]', NULL, NULL, ?, ?)
  `).run(
    signature,
    slot,
    "2026-07-10T19:59:59.000Z",
    success ? 1 : 0,
    JSON.stringify(transaction),
    indexedAt
  );
  if (options.existingSwap) insertSwap(db, swap(signature, slot), indexedAt);
}

function swap(signature: string, slot: number): IndexedSpotSwap {
  return {
    id: `${signature}:${WALLET}:0`,
    signature,
    wallet: WALLET,
    swapIndex: 0,
    slot,
    blockTime: "2026-07-10T19:59:59.000Z",
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
    indexedAt: "2026-07-11T00:00:01.000Z",
    priceUsd: 2
  };
}

function insertSwap(db: CopyLabDatabase, value: IndexedSpotSwap, indexedAt = value.indexedAt): void {
  db.prepare(`
    INSERT INTO indexed_spot_swaps(
      id, signature, wallet, swap_index, slot, block_time, side, base_mint,
      target_mint, input_mint, output_mint, input_amount_atomic,
      output_amount_atomic, eligible, closes_position, holding_minutes,
      realized_pnl_usd, swap_json, indexed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, NULL, NULL, ?, ?)
  `).run(
    value.id,
    value.signature,
    value.wallet,
    value.swapIndex,
    value.slot,
    value.blockTime,
    value.side,
    value.baseMint,
    value.targetMint,
    value.inputMint,
    value.outputMint,
    value.inputAmountAtomic,
    value.outputAmountAtomic,
    JSON.stringify(value),
    indexedAt
  );
}

function manifestInput(maximumItems = 100_000) {
  return {
    sourceRunId: KNOWN_AFFECTED_WALLET_INDEX_RUN_ID,
    sourceRunStartedAt: KNOWN_AFFECTED_WALLET_INDEX_RUN_STARTED_AT,
    cutoffAt: KNOWN_AFFECTED_PARSED_BLOCK_REPAIR_CUTOFF_AT,
    maximumItems,
    at: MANIFEST_CREATED_AT
  };
}

function hydrated(item: ReturnType<ParsedBlockRepairRepository["getItem"]>): WalletIndexTransaction {
  if (!item) throw new Error("missing repair item");
  return {
    signature: item.signature,
    status: "PROCESSED",
    attempts: item.attempts,
    priority: 0,
    discoveredAt: item.createdAt,
    availableAt: item.availableAt,
    updatedAt: "2026-07-11T00:00:01.000Z",
    sourceWallets: [],
    slot: item.slot,
    blockTime: "2026-07-10T19:59:59.000Z",
    success: true,
    feePayer: WALLET,
    accountKeys: [WALLET, PROGRAM],
    programIds: [PROGRAM],
    transactionVersion: "0",
    indexedAt: item.sourceIndexedAt,
    processedAt: item.sourceIndexedAt
  };
}

describe("ParsedBlockRepairRepository", () => {
  let db: CopyLabDatabase | undefined;
  afterEach(() => db?.close());

  it("freezes only successful no-swap program rows from the exact affected run and grouped slots", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    repository.upsertWalletIndexRun(run());
    repository.upsertWalletIndexRun(run("other-run"));

    seed(db, "eligible-a", 100);
    seed(db, "eligible-b", 100);
    seed(db, "singleton", 101);
    seed(db, "failed-a", 102, { success: false });
    seed(db, "failed-b", 102);
    seed(db, "deep-a", 103, { deepHistory: true });
    seed(db, "deep-b", 103);
    seed(db, "swap-a", 104, { existingSwap: true });
    seed(db, "swap-b", 104);
    seed(db, "other-a", 105, { runId: "other-run" });
    seed(db, "other-b", 105, { runId: "other-run" });
    seed(db, "post-fix-a", 106, { indexedAt: "2026-07-10T21:56:36.000Z" });
    seed(db, "post-fix-b", 106, { indexedAt: "2026-07-10T21:56:36.000Z" });

    const repair = new ParsedBlockRepairRepository(repository);
    const manifest = repair.ensureKnownAffectedManifest(MANIFEST_CREATED_AT);
    if (!manifest) throw new Error("known affected manifest was not created");

    expect(manifest).toMatchObject({
      sourceRunId: KNOWN_AFFECTED_WALLET_INDEX_RUN_ID,
      sourceRunStartedAt: KNOWN_AFFECTED_WALLET_INDEX_RUN_STARTED_AT,
      cutoffAt: KNOWN_AFFECTED_PARSED_BLOCK_REPAIR_CUTOFF_AT,
      itemCount: 4,
      status: "PENDING"
    });
    expect(manifest.createdAt).toBe(MANIFEST_CREATED_AT.toISOString());
    expect(repair.listItems(manifest.id).map((item) => item.signature)).toEqual([
      "eligible-a",
      "eligible-b",
      "deep-b",
      "swap-b"
    ]);
    expect(repair.manifestPrograms(manifest.id)).toEqual([PROGRAM]);

    const same = repair.createManifest({ ...manifestInput(), at: new Date("2026-07-12T00:00:00.000Z") });
    expect(same.id).toBe(manifest.id);
    expect(same.createdAt).toBe(manifest.createdAt);
    expect(same.cutoffAt).toBe(manifest.cutoffAt);
  });

  it("rolls back manifest creation when the frozen selection exceeds its explicit bound", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    repository.upsertWalletIndexRun(run());
    seed(db, "bounded-a", 200);
    seed(db, "bounded-b", 200);
    const repair = new ParsedBlockRepairRepository(repository);

    expect(() => repair.createManifest(manifestInput(1))).toThrow(/exceeds its 1-item safety bound/i);
    expect(repair.latestManifest()).toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) AS count FROM parsed_block_repair_items").get()).toEqual({ count: 0 });
  });

  it("leases by slot and atomically records recovered and VALID_ZERO results without changing run counters", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const originalRun = run();
    repository.upsertWalletIndexRun(originalRun);
    seed(db, "repair-a", 300);
    seed(db, "repair-b", 300);
    const repair = new ParsedBlockRepairRepository(repository);
    const manifest = repair.createManifest(manifestInput());
    const leased = repair.leaseNextSlot(manifest.id, "repair-worker", 10, 120, MANIFEST_CREATED_AT);
    expect(leased).toHaveLength(2);
    expect(new Set(leased.map((item) => item.slot))).toEqual(new Set([300]));

    const first = leased[0];
    const second = leased[1];
    if (!first || !second) throw new Error("missing leased rows");
    expect(repair.apply({
      item: first,
      transaction: hydrated(first),
      swaps: [],
      provenance: "PARSED_BLOCK_REPAIR",
      decoderVersion: PARSED_BLOCK_REPAIR_DECODER_VERSION,
      at: new Date("2026-07-11T00:00:01.000Z")
    })).toBe(true);
    expect(repair.apply({
      item: second,
      transaction: hydrated(second),
      swaps: [swap(second.signature, second.slot)],
      provenance: "PARSED_TRANSACTION_REPAIR_FALLBACK",
      decoderVersion: PARSED_BLOCK_REPAIR_DECODER_VERSION,
      at: new Date("2026-07-11T00:00:02.000Z")
    })).toBe(true);

    expect(repair.coverage(manifest.id)).toMatchObject({
      total: 2,
      recovered: 1,
      validZero: 1,
      failed: 0,
      recoveredSwaps: 1,
      manifest: { status: "COMPLETE" }
    });
    expect(repository.getWalletIndexRun(originalRun.id)).toEqual(originalRun);
    expect(db.prepare(`
      SELECT hydration_provenance, decoder_version
      FROM indexed_transactions WHERE signature = ?
    `).get(second.signature)).toEqual({
      hydration_provenance: "PARSED_TRANSACTION_REPAIR_FALLBACK",
      decoder_version: PARSED_BLOCK_REPAIR_DECODER_VERSION
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM wallet_index_dirty WHERE wallet = ?").get(WALLET))
      .toEqual({ count: 1 });
  });

  it("fails closed when a frozen item gains a deep-history source before application", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    repository.upsertWalletIndexRun(run());
    seed(db, "guard-a", 400);
    seed(db, "guard-b", 400);
    const repair = new ParsedBlockRepairRepository(repository);
    const manifest = repair.createManifest(manifestInput());
    const leased = repair.leaseNextSlot(manifest.id, "repair-worker", 10, 120, MANIFEST_CREATED_AT);
    const item = leased[0];
    if (!item) throw new Error("missing leased row");
    db.prepare(`
      INSERT INTO index_signature_sources(
        signature, source_address, wallet, source, first_seen_at, last_seen_at,
        discovery_count, first_run_id, last_run_id, metadata_json
      ) VALUES (?, ?, ?, 'helius-wallet-deep-history', ?, ?, 1, ?, ?, NULL)
    `).run(
      item.signature,
      WALLET,
      WALLET,
      MANIFEST_CREATED_AT.toISOString(),
      MANIFEST_CREATED_AT.toISOString(),
      KNOWN_AFFECTED_WALLET_INDEX_RUN_ID,
      KNOWN_AFFECTED_WALLET_INDEX_RUN_ID
    );

    expect(repair.apply({
      item,
      transaction: hydrated(item),
      swaps: [swap(item.signature, item.slot)],
      provenance: "PARSED_BLOCK_REPAIR",
      decoderVersion: PARSED_BLOCK_REPAIR_DECODER_VERSION,
      at: new Date("2026-07-11T00:00:01.000Z")
    })).toBe(false);
    expect(repair.getItem(manifest.id, item.signature)).toMatchObject({
      status: "FAILED",
      lastError: expect.stringMatching(/guard rejected/i)
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM indexed_spot_swaps WHERE signature = ?").get(item.signature))
      .toEqual({ count: 0 });
  });
});
