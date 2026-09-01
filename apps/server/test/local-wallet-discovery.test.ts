import { afterEach, describe, expect, it } from "vitest";
import {
  SOL_MINT,
  USDC_MINT,
  type IndexedSpotSwap,
  type WalletIndexRecord
} from "@copylab/shared";
import { openDatabase, type CopyLabDatabase } from "../src/database.js";
import {
  LOCAL_WALLET_DISCOVERY_LIMITATIONS,
  LocalWalletDiscoveryProvider
} from "../src/local-wallet-discovery.js";
import { Repository } from "../src/repository.js";

const WINDOW_START = "2026-01-01T00:00:00.000Z";
const WINDOW_END = "2026-04-01T00:00:00.000Z";
const DISCOVERED_AT = new Date("2026-04-02T00:00:00.000Z");

interface SwapInput {
  wallet: string;
  id: string;
  at: string;
  side: "BUY" | "SELL";
  quantity: number;
  valueUsd: number;
  targetMint?: string;
  baseMint?: typeof SOL_MINT | typeof USDC_MINT;
  includePrice?: boolean;
}

function swap(input: SwapInput): IndexedSpotSwap {
  const baseMint = input.baseMint ?? USDC_MINT;
  const targetMint = input.targetMint ?? `mint-${input.wallet}`;
  const buying = input.side === "BUY";
  return {
    id: input.id,
    signature: `signature-${input.id}`,
    wallet: input.wallet,
    swapIndex: 0,
    slot: 100,
    blockTime: input.at,
    side: input.side,
    baseMint,
    targetMint,
    inputMint: buying ? baseMint : targetMint,
    outputMint: buying ? targetMint : baseMint,
    inputAmountAtomic: "1000000",
    outputAmountAtomic: "1000000",
    inputAmountUi: buying ? input.valueUsd : input.quantity,
    outputAmountUi: buying ? input.quantity : input.valueUsd,
    eligible: true,
    eligibilityReasons: [],
    programIds: ["jupiter-program"],
    indexedAt: input.at,
    ...((input.includePrice ?? true) ? { priceUsd: input.valueUsd / input.quantity } : {})
  };
}

function record(
  wallet: string,
  signatureCount: number,
  overrides: Partial<WalletIndexRecord> = {}
): WalletIndexRecord {
  return {
    wallet,
    firstSeenAt: WINDOW_START,
    lastSeenAt: WINDOW_END,
    historyDays: 90,
    transactionCount: signatureCount,
    successfulTransactionCount: signatureCount,
    spotSwapCount: signatureCount,
    eligibleSpotSwapCount: signatureCount,
    closedEligibleSwaps: 1,
    buyCount: 1,
    sellCount: 1,
    activeDays: 2,
    activeWeeks: 2,
    distinctMints: 1,
    medianHoldingMinutes: 60,
    preScreenEligible: true,
    preScreenReasons: [],
    deepHistoryStatus: "COMPLETE",
    deepHistoryWindowStart: WINDOW_START,
    deepHistoryWindowEnd: WINDOW_END,
    deepHistorySignatureCount: signatureCount,
    deepHistoryHydratedCount: signatureCount,
    structuralEligible: true,
    structuralReasons: [],
    pricedClosedEligibleSwaps: 1,
    unpricedClosedEligibleSwaps: 0,
    realizedPnlPricedUsd: 0,
    pricedProfitTokenCount: 1,
    profitPricingCoverage: "COMPLETE",
    tags: [],
    walletIdentityStatus: "VERIFIED",
    walletIdentitySource: "local_onchain_90d_v1",
    walletIdentityCheckedAt: WINDOW_END,
    updatedAt: WINDOW_END,
    ...overrides
  };
}

function persistSwap(repository: Repository, value: IndexedSpotSwap): void {
  const observedAt = new Date(value.blockTime);
  repository.enqueueWalletIndexTransactions([{
    signature: value.signature,
    sourceAddress: "jupiter-program",
    wallet: value.wallet,
    source: "local-discovery-test",
    discoveredAt: value.blockTime,
    slot: value.slot,
    blockTime: value.blockTime
  }]);
  const leased = repository.leaseWalletIndexTransactions("local-discovery-test", 1, 60, observedAt)[0];
  if (!leased?.leaseToken) throw new Error(`Unable to lease ${value.signature}`);
  const stored = repository.completeWalletIndexTransaction({
    ...leased,
    slot: value.slot,
    blockTime: value.blockTime,
    success: true,
    feePayer: value.wallet,
    accountKeys: [value.wallet],
    programIds: value.programIds,
    transactionVersion: "0",
    raw: { fixture: true }
  }, [value], leased.leaseToken, observedAt);
  if (!stored) throw new Error(`Unable to store ${value.signature}`);
}

function setup(walletSwaps: Map<string, IndexedSpotSwap[]>): {
  db: CopyLabDatabase;
  repository: Repository;
  provider: LocalWalletDiscoveryProvider;
} {
  const db = openDatabase(":memory:");
  const repository = new Repository(db);
  for (const [wallet, swaps] of walletSwaps) {
    repository.upsertWalletIndexRecord(record(wallet, swaps.length));
    swaps.forEach((value) => persistSwap(repository, value));
  }
  const cohort = repository.createWalletDeepHistoryCohort({
    selectedAt: WINDOW_END,
    snapshotCutoffAt: WINDOW_END,
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
    wallets: [...walletSwaps.keys()]
  });
  for (const [wallet, swaps] of walletSwaps) {
    const frozenRecord = repository.getWalletIndexRecord(wallet);
    if (!frozenRecord) throw new Error(`Missing ${wallet}`);
    repository.saveWalletDeepHistoryEvidence({
      generationId: cohort.generationId,
      cohortId: cohort.id,
      wallet,
      record: frozenRecord,
      swaps,
      frozenAt: WINDOW_END
    });
  }
  repository.completeWalletDeepHistoryCohort(cohort.id, new Date(WINDOW_END));
  repository.completeWalletDeepHistoryGeneration(cohort.generationId, new Date(WINDOW_END));
  return {
    db,
    repository,
    provider: new LocalWalletDiscoveryProvider(repository, { winnerLimit: 2, controlLimit: 1 })
  };
}

describe("LocalWalletDiscoveryProvider", () => {
  let db: CopyLabDatabase | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("ranks equal winners by address and retains a disjoint loser control", async () => {
    const values = new Map<string, IndexedSpotSwap[]>();
    for (const wallet of ["winner-b", "winner-a"]) {
      values.set(wallet, [
        swap({ wallet, id: `${wallet}-buy`, at: "2026-01-10T00:00:00.000Z", side: "BUY", quantity: 100, valueUsd: 100 }),
        swap({ wallet, id: `${wallet}-sell`, at: "2026-03-10T00:00:00.000Z", side: "SELL", quantity: 100, valueUsd: 120 })
      ]);
    }
    values.set("loser", [
      swap({ wallet: "loser", id: "loser-buy", at: "2026-01-10T00:00:00.000Z", side: "BUY", quantity: 100, valueUsd: 100 }),
      swap({ wallet: "loser", id: "loser-sell", at: "2026-03-10T00:00:00.000Z", side: "SELL", quantity: 100, valueUsd: 80 })
    ]);
    const setupResult = setup(values);
    db = setupResult.db;

    const first = await setupResult.provider.discoverCohort(DISCOVERED_AT);
    const second = await setupResult.provider.discoverCohort(DISCOVERED_AT);

    expect(second).toEqual(first);
    expect(first.cohortId).toMatch(/^local:local-generation-v1:1:/);
    expect(first.candidates.map((candidate) => candidate.address)).toEqual([
      "winner-a",
      "winner-b",
      "loser"
    ]);
    expect(first.candidates[0]).toMatchObject({
      control: false,
      sourceRank30d: 1,
      sourceRank90d: 1,
      pnl30d: { realizedProfitUsd: 20, realizedProfitPercent: 20, wins: 1, losses: 0 }
    });
    expect(first.candidates[1]).toMatchObject({
      control: false,
      sourceRank30d: 2,
      sourceRank90d: 2
    });
    expect(first.candidates[2]).toMatchObject({
      control: true,
      pnl90d: { realizedProfitUsd: -20, realizedProfitPercent: -20, wins: 0, losses: 1 }
    });
  });

  it("uses FIFO lots across the 30-day boundary and produces deterministic window metrics", async () => {
    const wallet = "fifo-wallet";
    const values = new Map<string, IndexedSpotSwap[]>([[wallet, [
      swap({ wallet, id: "fifo-buy-old", at: "2026-01-05T00:00:00.000Z", side: "BUY", quantity: 100, valueUsd: 100 }),
      swap({ wallet, id: "fifo-sell-old", at: "2026-02-15T00:00:00.000Z", side: "SELL", quantity: 20, valueUsd: 30 }),
      swap({ wallet, id: "fifo-buy-new", at: "2026-03-05T00:00:00.000Z", side: "BUY", quantity: 20, valueUsd: 40 }),
      swap({ wallet, id: "fifo-sell-new", at: "2026-03-10T00:00:00.000Z", side: "SELL", quantity: 50, valueUsd: 100 })
    ]]]);
    const setupResult = setup(values);
    db = setupResult.db;

    await expect(setupResult.provider.getPnl(wallet, "30d")).resolves.toEqual({
      duration: "30d",
      realizedProfitUsd: 50,
      realizedProfitPercent: 100,
      unrealizedProfitUsd: 0,
      totalTrades: 1,
      wins: 1,
      losses: 0
    });
    await expect(setupResult.provider.getPnl(wallet, "90d")).resolves.toEqual({
      duration: "90d",
      realizedProfitUsd: 60,
      realizedProfitPercent: 60 / 70 * 100,
      unrealizedProfitUsd: 30,
      totalTrades: 2,
      wins: 2,
      losses: 0
    });
  });

  it("selects the newest complete generation instead of a larger stale generation", async () => {
    const older = "older-batch-winner";
    const newer = "newer-batch-winner";
    const olderSwaps = [
      swap({ wallet: older, id: "older-buy", at: "2026-01-10T00:00:00.000Z", side: "BUY", quantity: 10, valueUsd: 10 }),
      swap({ wallet: older, id: "older-sell", at: "2026-03-10T00:00:00.000Z", side: "SELL", quantity: 10, valueUsd: 20 })
    ];
    const setupResult = setup(new Map([[older, olderSwaps]]));
    db = setupResult.db;
    const newerSwaps = [
      swap({ wallet: newer, id: "newer-buy", at: "2026-01-10T00:00:00.000Z", side: "BUY", quantity: 10, valueUsd: 10 }),
      swap({ wallet: newer, id: "newer-sell", at: "2026-03-10T00:00:00.000Z", side: "SELL", quantity: 10, valueUsd: 30 })
    ];
    setupResult.repository.upsertWalletIndexRecord(record(newer, newerSwaps.length));
    newerSwaps.forEach((value) => persistSwap(setupResult.repository, value));
    const second = setupResult.repository.createWalletDeepHistoryCohort({
      selectedAt: WINDOW_END,
      snapshotCutoffAt: WINDOW_END,
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      wallets: [newer]
    });
    const newerRecord = setupResult.repository.getWalletIndexRecord(newer)!;
    setupResult.repository.saveWalletDeepHistoryEvidence({
      generationId: second.generationId,
      cohortId: second.id,
      wallet: newer,
      record: newerRecord,
      swaps: newerSwaps,
      frozenAt: WINDOW_END
    });
    setupResult.repository.completeWalletDeepHistoryCohort(second.id, new Date(WINDOW_END));
    setupResult.repository.completeWalletDeepHistoryGeneration(second.generationId, new Date(WINDOW_END));

    const discovered = await setupResult.provider.discoverCohort(DISCOVERED_AT);

    expect(discovered.cohortId).toBe(`local:${second.generationId}`);
    expect(discovered.candidates.map((candidate) => candidate.address)).toEqual([newer]);
    expect(discovered.candidates.map((candidate) => candidate.pnl90d?.realizedProfitUsd)).toEqual([20]);
  });

  it("never mixes wallets from different point-in-time ranking cutoffs", async () => {
    const oldA = "old-generation-a";
    const oldB = "old-generation-b";
    const oldValues = new Map<string, IndexedSpotSwap[]>([oldA, oldB].map((wallet, index) => [wallet, [
      swap({ wallet, id: `${wallet}-buy`, at: "2026-01-10T00:00:00.000Z", side: "BUY", quantity: 10, valueUsd: 10 }),
      swap({ wallet, id: `${wallet}-sell`, at: "2026-03-10T00:00:00.000Z", side: "SELL", quantity: 10, valueUsd: 20 + index })
    ]]));
    const setupResult = setup(oldValues);
    db = setupResult.db;

    const newer = "new-generation-only";
    const newStart = "2026-01-02T00:00:00.000Z";
    const newEnd = "2026-04-02T00:00:00.000Z";
    const newerSwaps = [
      swap({ wallet: newer, id: "new-generation-buy", at: "2026-01-10T00:00:00.000Z", side: "BUY", quantity: 10, valueUsd: 10 }),
      swap({ wallet: newer, id: "new-generation-sell", at: "2026-03-10T00:00:00.000Z", side: "SELL", quantity: 10, valueUsd: 100 })
    ];
    setupResult.repository.upsertWalletIndexRecord(record(newer, newerSwaps.length, {
      deepHistoryWindowStart: newStart,
      deepHistoryWindowEnd: newEnd,
      lastSeenAt: newEnd,
      updatedAt: newEnd
    }));
    newerSwaps.forEach((value) => persistSwap(setupResult.repository, value));
    const nextGeneration = setupResult.repository.createWalletDeepHistoryCohort({
      selectedAt: newEnd,
      snapshotCutoffAt: newEnd,
      windowStart: newStart,
      windowEnd: newEnd,
      wallets: [newer]
    });
    setupResult.repository.completeWalletDeepHistoryCohort(nextGeneration.id, new Date(newEnd));

    const discovered = await setupResult.provider.discoverCohort(new Date("2026-04-03T00:00:00.000Z"));

    expect(discovered.candidates.map((candidate) => candidate.address)).toEqual([oldB, oldA]);
    expect(discovered.candidates.map((candidate) => candidate.address)).not.toContain(newer);
  });

  it("fails closed on unpriced and unmatched evidence while ignoring later mutable aggregate changes", async () => {
    const unpriced = "unpriced";
    const unmatched = "unmatched";
    const incomplete = "incomplete";
    const values = new Map<string, IndexedSpotSwap[]>([
      [unpriced, [swap({
        wallet: unpriced,
        id: "unpriced-buy",
        at: "2026-01-10T00:00:00.000Z",
        side: "BUY",
        quantity: 10,
        valueUsd: 1,
        baseMint: SOL_MINT,
        includePrice: false
      })]],
      [unmatched, [swap({
        wallet: unmatched,
        id: "unmatched-sell",
        at: "2026-03-10T00:00:00.000Z",
        side: "SELL",
        quantity: 10,
        valueUsd: 20
      })]],
      [incomplete, [
        swap({ wallet: incomplete, id: "incomplete-buy", at: "2026-01-10T00:00:00.000Z", side: "BUY", quantity: 10, valueUsd: 10 }),
        swap({ wallet: incomplete, id: "incomplete-sell", at: "2026-03-10T00:00:00.000Z", side: "SELL", quantity: 10, valueUsd: 20 })
      ]]
    ]);
    const setupResult = setup(values);
    db = setupResult.db;
    setupResult.repository.upsertWalletIndexRecord(record(incomplete, 2, {
      deepHistoryHydratedCount: 1
    }));

    const cohort = await setupResult.provider.discoverCohort(DISCOVERED_AT);
    expect(cohort.candidates.map((candidate) => candidate.address)).toEqual([incomplete]);
    await expect(setupResult.provider.getPnl(unpriced, "90d"))
      .rejects.toThrow("no complete USD pricing evidence");
    await expect(setupResult.provider.getPnl(unmatched, "90d"))
      .rejects.toThrow("requires inventory from before the frozen history window");
    await expect(setupResult.provider.getPnl(incomplete, "90d"))
      .resolves.toMatchObject({ realizedProfitUsd: 10 });
    expect(LOCAL_WALLET_DISCOVERY_LIMITATIONS).toEqual(expect.arrayContaining([
      expect.stringContaining("network fees"),
      expect.stringContaining("not a market-wide ranking")
    ]));
  });

  it("does not recalculate a completed ranking from a later mutable identity record", async () => {
    const wallet = "identity-unknown";
    const values = new Map<string, IndexedSpotSwap[]>([[wallet, [
      swap({ wallet, id: "identity-buy", at: "2026-01-10T00:00:00.000Z", side: "BUY", quantity: 10, valueUsd: 10 }),
      swap({ wallet, id: "identity-sell", at: "2026-03-10T00:00:00.000Z", side: "SELL", quantity: 10, valueUsd: 20 })
    ]]]);
    const setupResult = setup(values);
    db = setupResult.db;
    setupResult.repository.upsertWalletIndexRecord(record(wallet, 2, {
      walletIdentityStatus: "UNKNOWN",
      walletIdentitySource: "local_onchain_90d_v1"
    }));

    await expect(setupResult.provider.discoverCohort(DISCOVERED_AT)).resolves.toMatchObject({
      candidates: [expect.objectContaining({ address: wallet })]
    });
    await expect(setupResult.provider.getPnl(wallet, "90d")).resolves.toMatchObject({ realizedProfitUsd: 10 });
  });

  it("rejects discovery when no completed frozen history cohort exists", async () => {
    db = openDatabase(":memory:");
    const provider = new LocalWalletDiscoveryProvider(new Repository(db));
    await expect(provider.discoverCohort(DISCOVERED_AT))
      .rejects.toThrow("No completed local deep-history generation is available");
  });
});
