import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SOL_MINT,
  USDC_MINT,
  type IndexedSpotSwap,
  type WalletIndexRecord
} from "@copylab/shared";
import type { HeliusIndexRpc } from "@copylab/providers";
import { openDatabase, type CopyLabDatabase } from "../src/database.js";
import { LocalWalletDiscoveryProvider } from "../src/local-wallet-discovery.js";
import { Repository } from "../src/repository.js";
import { WalletIndexWorker } from "../src/wallet-index-worker.js";
import { materializeWalletDeepHistory } from "../src/wallet-deep-history.js";

const START = "2026-01-01T00:00:00.000Z";
const END = "2026-04-01T00:00:00.000Z";
const WALLET = "ranking-wallet";

function record(wallet: string, windowStart = START, windowEnd = END): WalletIndexRecord {
  return {
    wallet,
    firstSeenAt: windowStart,
    lastSeenAt: windowEnd,
    historyDays: 90,
    transactionCount: 2,
    successfulTransactionCount: 2,
    spotSwapCount: 2,
    eligibleSpotSwapCount: 2,
    closedEligibleSwaps: 1,
    buyCount: 1,
    sellCount: 1,
    activeDays: 2,
    activeWeeks: 2,
    distinctMints: 1,
    medianHoldingMinutes: 60,
    preScreenEligible: true,
    preScreenReasons: [],
    updatedAt: windowEnd,
    deepHistoryStatus: "COMPLETE",
    deepHistoryWindowStart: windowStart,
    deepHistoryWindowEnd: windowEnd,
    deepHistorySignatureCount: 2,
    deepHistoryHydratedCount: 2,
    structuralEligible: true,
    structuralReasons: [],
    pricedClosedEligibleSwaps: 1,
    unpricedClosedEligibleSwaps: 0,
    realizedPnlPricedUsd: 10,
    pricedProfitTokenCount: 1,
    profitPricingCoverage: "COMPLETE",
    tags: [],
    walletIdentityStatus: "VERIFIED",
    walletIdentitySource: "local_onchain_90d_v1",
    walletIdentityCheckedAt: windowEnd
  };
}

function swaps(wallet: string, profit: number, windowStart = START): IndexedSpotSwap[] {
  const mint = `mint-${wallet}`;
  const buyAt = new Date(Date.parse(windowStart) + 24 * 60 * 60_000).toISOString();
  const sellAt = new Date(Date.parse(windowStart) + 60 * 24 * 60 * 60_000).toISOString();
  return [
    {
      id: `${wallet}-buy-${windowStart}`,
      signature: `${wallet}-buy-signature-${windowStart}`,
      wallet,
      swapIndex: 0,
      slot: 1,
      blockTime: buyAt,
      side: "BUY",
      baseMint: USDC_MINT,
      targetMint: mint,
      inputMint: USDC_MINT,
      outputMint: mint,
      inputAmountAtomic: "10000000",
      outputAmountAtomic: "10000000",
      inputAmountUi: 10,
      outputAmountUi: 10,
      eligible: true,
      eligibilityReasons: [],
      programIds: ["fixture"],
      indexedAt: buyAt,
      priceUsd: 1
    },
    {
      id: `${wallet}-sell-${windowStart}`,
      signature: `${wallet}-sell-signature-${windowStart}`,
      wallet,
      swapIndex: 0,
      slot: 2,
      blockTime: sellAt,
      side: "SELL",
      baseMint: USDC_MINT,
      targetMint: mint,
      inputMint: mint,
      outputMint: USDC_MINT,
      inputAmountAtomic: "10000000",
      outputAmountAtomic: String((10 + profit) * 1_000_000),
      inputAmountUi: 10,
      outputAmountUi: 10 + profit,
      eligible: true,
      eligibilityReasons: [],
      programIds: ["fixture"],
      indexedAt: sellAt,
      priceUsd: (10 + profit) / 10
    }
  ];
}

function persistUnpricedSolSwap(repository: Repository): IndexedSpotSwap {
  const at = "2026-03-01T12:00:00.000Z";
  const swap: IndexedSpotSwap = {
    id: "unpriced-sol-buy",
    signature: "unpriced-sol-signature",
    wallet: WALLET,
    swapIndex: 0,
    slot: 50,
    blockTime: at,
    side: "BUY",
    baseMint: SOL_MINT,
    targetMint: "sol-target",
    inputMint: SOL_MINT,
    outputMint: "sol-target",
    inputAmountAtomic: "1000000000",
    outputAmountAtomic: "10000000",
    inputAmountUi: 1,
    outputAmountUi: 10,
    eligible: true,
    eligibilityReasons: [],
    programIds: ["fixture"],
    indexedAt: at
  };
  repository.enqueueWalletIndexTransactions([{
    signature: swap.signature,
    sourceAddress: "fixture",
    wallet: WALLET,
    source: "fixture",
    discoveredAt: at,
    slot: swap.slot,
    blockTime: at
  }]);
  const leased = repository.leaseWalletIndexTransactions("fixture", 1, 60, new Date(at))[0]!;
  repository.completeWalletIndexTransaction({
    ...leased,
    slot: swap.slot,
    blockTime: at,
    success: true,
    sourceWallets: [WALLET],
    updatedAt: at
  }, [swap], leased.leaseToken!, new Date(at));
  return swap;
}

describe("immutable wallet ranking generations", () => {
  let db: CopyLabDatabase | undefined;
  afterEach(() => db?.close());

  it("allows periodic wallet retargeting but rejects duplicates inside one generation", async () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const firstRecord = record(WALLET);
    const firstSwaps = swaps(WALLET, 10);
    repository.upsertWalletIndexRecord(firstRecord);
    const first = repository.createWalletDeepHistoryCohort({
      selectedAt: END,
      snapshotCutoffAt: END,
      windowStart: START,
      windowEnd: END,
      wallets: [WALLET]
    });
    repository.saveWalletDeepHistoryEvidence({
      generationId: first.generationId,
      cohortId: first.id,
      wallet: WALLET,
      record: firstRecord,
      swaps: firstSwaps,
      frozenAt: END
    });
    repository.completeWalletDeepHistoryCohort(first.id, new Date(END));
    repository.completeWalletDeepHistoryGeneration(first.generationId, new Date(END));

    const nextStart = "2026-01-02T00:00:00.000Z";
    const nextEnd = "2026-04-02T00:00:00.000Z";
    const secondRecord = record(WALLET, nextStart, nextEnd);
    const secondSwaps = swaps(WALLET, 30, nextStart);
    repository.upsertWalletIndexRecord(secondRecord);
    const second = repository.createWalletDeepHistoryCohort({
      selectedAt: nextEnd,
      snapshotCutoffAt: nextEnd,
      windowStart: nextStart,
      windowEnd: nextEnd,
      wallets: [WALLET]
    });
    expect(second.generationId).not.toBe(first.generationId);
    expect(() => repository.createWalletDeepHistoryCohort({
      generationId: second.generationId,
      selectedAt: nextEnd,
      snapshotCutoffAt: nextEnd,
      windowStart: nextStart,
      windowEnd: nextEnd,
      wallets: [WALLET]
    })).toThrow();

    const provider = new LocalWalletDiscoveryProvider(repository);
    await expect(provider.getPnl(WALLET, "90d")).resolves.toMatchObject({ realizedProfitUsd: 10 });

    repository.saveWalletDeepHistoryEvidence({
      generationId: second.generationId,
      cohortId: second.id,
      wallet: WALLET,
      record: secondRecord,
      swaps: secondSwaps,
      frozenAt: nextEnd
    });
    repository.completeWalletDeepHistoryCohort(second.id, new Date(nextEnd));
    repository.completeWalletDeepHistoryGeneration(second.generationId, new Date(nextEnd));
    await expect(provider.getPnl(WALLET, "90d")).resolves.toMatchObject({ realizedProfitUsd: 30 });
  });

  it("detects tampering instead of recalculating from altered frozen JSON", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const cohort = repository.createWalletDeepHistoryCohort({
      selectedAt: END,
      snapshotCutoffAt: END,
      windowStart: START,
      windowEnd: END,
      wallets: [WALLET]
    });
    repository.saveWalletDeepHistoryEvidence({
      generationId: cohort.generationId,
      cohortId: cohort.id,
      wallet: WALLET,
      record: record(WALLET),
      swaps: swaps(WALLET, 10),
      frozenAt: END
    });
    db.prepare(`UPDATE wallet_deep_history_evidence SET swaps_json = '[]' WHERE generation_id = ?`)
      .run(cohort.generationId);
    expect(() => repository.getWalletDeepHistoryEvidence(cohort.generationId, WALLET))
      .toThrow("digest mismatch");
  });
});

describe("resumable SOL swap repricing", () => {
  let db: CopyLabDatabase | undefined;
  afterEach(() => db?.close());

  it("reuses the immutable SOL coverage aggregate and invalidates it after an inserted price", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    repository.saveSolPriceSnapshot({
      capturedAt: "2026-03-01T12:00:00.000Z",
      priceUsd: 80,
      source: "test"
    });
    const prepare = vi.spyOn(db, "prepare");
    const aggregateScanCount = () => prepare.mock.calls.filter(([sql]) =>
      String(sql).includes("WITH ordered AS")
    ).length;

    expect(repository.solPriceCoverage(new Date("2026-03-01T12:00:01.000Z"))).toMatchObject({
      count: 1,
      oldestAt: "2026-03-01T12:00:00.000Z",
      newestAt: "2026-03-01T12:00:00.000Z"
    });
    expect(repository.solPriceCoverage(new Date("2026-03-01T12:01:01.000Z")).count).toBe(1);
    expect(aggregateScanCount()).toBe(1);

    repository.saveSolPriceSnapshot({
      capturedAt: "2026-03-01T12:01:00.000Z",
      priceUsd: 81,
      source: "test"
    });
    expect(repository.solPriceCoverage(new Date("2026-03-01T12:01:01.000Z"))).toMatchObject({
      count: 2,
      newestAt: "2026-03-01T12:01:00.000Z"
    });
    expect(aggregateScanCount()).toBe(2);
  });

  it("includes fully priced SOL legs in FIFO realized PnL", () => {
    const [buy, sell] = swaps(WALLET, 10);
    const solBuy: IndexedSpotSwap = {
      ...buy!,
      baseMint: SOL_MINT,
      inputMint: SOL_MINT,
      inputAmountUi: 1,
      priceUsd: 10
    };
    const solSell: IndexedSpotSwap = {
      ...sell!,
      baseMint: SOL_MINT,
      outputMint: SOL_MINT,
      outputAmountUi: 1.2,
      priceUsd: 12
    };
    expect(materializeWalletDeepHistory(record(WALLET), [solBuy, solSell], {
      windowStart: START,
      windowEnd: END,
      signatureCount: 2,
      hydratedCount: 2,
      calculatedAt: END
    })).toMatchObject({
      profitPricingCoverage: "COMPLETE",
      pricedClosedEligibleSwaps: 1,
      unpricedClosedEligibleSwaps: 0,
      realizedPnlPricedUsd: 20
    });
  });

  it("keeps missing coverage pending across workers and prices strictly at the swap time", async () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const swap = persistUnpricedSolSwap(repository);
    expect(repository.solPriceCoverage(new Date("2026-03-01T12:00:01.000Z")).pendingSwapReprices).toBe(1);
    const rpc: HeliusIndexRpc = {
      getSignaturesForAddress: async () => [],
      getTransaction: async () => null
    };
    let now = new Date("2026-03-01T12:00:01.000Z");
    const unavailable = new WalletIndexWorker(repository, "", undefined, {
      rpc,
      deepHistoryEnabled: false,
      targetWallets: 1,
      now: () => now,
      solPriceUsdResolver: async () => { throw new Error("price gap"); }
    });
    await unavailable.runOnce();
    expect(repository.solPriceCoverage(now).pendingSwapReprices).toBe(1);

    const requested: string[] = [];
    now = new Date("2026-03-01T12:01:00.000Z");
    const resumed = new WalletIndexWorker(repository, "", undefined, {
      rpc,
      deepHistoryEnabled: false,
      targetWallets: 1,
      now: () => now,
      solPriceUsdResolver: async (at) => { requested.push(at); return 100; }
    });
    expect(await resumed.runOnce()).toBe(true);
    expect(requested).toEqual([swap.blockTime]);
    expect(repository.solPriceCoverage(now).pendingSwapReprices).toBe(0);
    expect(repository.listIndexedSpotSwaps(WALLET)[0]).toMatchObject({ priceUsd: 10 });
  });

  it("retains older missing evidence without retrying forever or blocking the supported horizon", async () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const swap = persistUnpricedSolSwap(repository);
    const now = new Date("2026-07-10T12:00:00.000Z");
    expect(repository.solPriceCoverage(now)).toMatchObject({
      pendingSwapReprices: 0,
      outOfHorizonSwapReprices: 1
    });
    let requests = 0;
    const worker = new WalletIndexWorker(repository, "", undefined, {
      rpc: {
        getSignaturesForAddress: async () => [],
        getTransaction: async () => null
      },
      deepHistoryEnabled: false,
      targetWallets: 1,
      now: () => now,
      solPriceUsdResolver: async () => { requests += 1; return 100; }
    });
    await worker.runOnce();
    expect(requests).toBe(0);
    expect(repository.pendingIndexedSwapReprices(
      WALLET,
      new Date(Date.parse(swap.blockTime) - 1_000).toISOString(),
      new Date(Date.parse(swap.blockTime) + 1_000).toISOString()
    )).toBe(1);
    expect(repository.listIndexedSpotSwaps(WALLET)[0]?.priceUsd).toBeUndefined();
  });
});
