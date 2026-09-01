import { afterEach, describe, expect, it, vi } from "vitest";
import type { WalletIndexCoverage, WalletScore } from "@copylab/shared";
import { openDatabase, type CopyLabDatabase } from "../src/database.js";
import { Repository } from "../src/repository.js";
import {
  WALLET_ACQUISITION_GOAL_SETTING,
  WalletAcquisitionController
} from "../src/wallet-acquisition-controller.js";

const JANUARY = new Date("2027-01-15T00:00:00.000Z");

function coverage(indexedWallets: number): WalletIndexCoverage {
  return {
    capturedAt: JANUARY.toISOString(),
    uniqueSignatures: 0,
    sourceLinks: 0,
    indexedTransactions: 0,
    indexedSwaps: 0,
    indexedWallets,
    preScreenEligibleWallets: 0,
    activitySamples: 0,
    preScreenSnapshots: 0,
    checkpoints: 0,
    activeRuns: 0,
    queueByStatus: { PENDING: 0, LEASED: 0, PROCESSED: 0, RETRY: 0, FAILED: 0 }
  };
}

function qualifyingScore(wallet: string): WalletScore {
  return {
    wallet,
    calculatedAt: JANUARY.toISOString(),
    qualified: true,
    reasons: [],
    historyDays: 90,
    closedEligibleSwaps: 60,
    activeWeeks: 4,
    medianHoldingMinutes: 30,
    topTokenProfitShare: 0.2,
    topThreeProfitShare: 0.5
  };
}

describe("durable managed wallet acquisition", () => {
  let db: CopyLabDatabase | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("advances exactly 5,000 -> 10,000 -> 15,000 -> 20,000 -> 25,000 and survives reconstruction", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    let indexedWallets = 5_000;
    vi.spyOn(repository, "walletIndexCoverage").mockImplementation(() => coverage(indexedWallets));
    const first = new WalletAcquisitionController(repository, { now: () => new Date(JANUARY) });

    expect(first.targetWallets()).toBe(5_000);
    expect(first.onPipelineDrained()).toBe(true);
    expect(first.targetWallets()).toBe(10_000);

    indexedWallets = 10_000;
    const restarted = new WalletAcquisitionController(repository, { now: () => new Date(JANUARY) });
    expect(restarted.targetWallets()).toBe(10_000);
    expect(restarted.onPipelineDrained()).toBe(true);
    expect(restarted.targetWallets()).toBe(15_000);

    indexedWallets = 15_000;
    expect(restarted.onPipelineDrained()).toBe(true);
    expect(restarted.targetWallets()).toBe(20_000);

    indexedWallets = 20_000;
    expect(restarted.onPipelineDrained()).toBe(true);
    expect(restarted.targetWallets()).toBe(25_000);

    indexedWallets = 25_000;
    expect(restarted.onPipelineDrained()).toBe(false);
    expect(restarted.snapshot()).toMatchObject({
      targetWallets: 25_000,
      maximumWallets: 25_000,
      status: "MAXIMUM_REACHED"
    });
  });

  it("stops fresh discovery as soon as the latest carried cohort has three exact qualifiers", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    vi.spyOn(repository, "walletIndexCoverage").mockReturnValue(coverage(4_000));
    const wallets = Array.from({ length: 3 }, (_, index) => `qualified-${index}`);
    repository.saveCohort({
      cohortId: "birdeye-2027-01-11",
      generatedAt: JANUARY.toISOString(),
      candidates: wallets.map((address) => ({
        address,
        cohortId: "birdeye-2027-01-11",
        firstSeenAt: JANUARY.toISOString(),
        lastSeenAt: JANUARY.toISOString(),
        control: false,
        tags: []
      }))
    });
    for (const wallet of wallets) repository.saveWalletScore("birdeye-2027-01-11", qualifyingScore(wallet));
    const controller = new WalletAcquisitionController(repository, { now: () => new Date(JANUARY) });

    expect(controller.canDiscoverPage()).toBe(false);
    expect(controller.shouldContinueResearch()).toBe(false);
    expect(controller.snapshot()).toMatchObject({
      qualifiedWallets: 3,
      status: "WAITING_FOR_FREEZE"
    });
  });

  it("waits at the current target when any live monthly reserve cannot cover discovery plus scoring", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    vi.spyOn(repository, "walletIndexCoverage").mockReturnValue(coverage(5_000));
    repository.incrementUsage("helius_index", 250_000, JANUARY);
    repository.incrementUsage("birdeye", 27_000, JANUARY);
    const controller = new WalletAcquisitionController(repository, { now: () => new Date(JANUARY) });

    expect(controller.onPipelineDrained()).toBe(false);
    expect(controller.targetWallets()).toBe(5_000);
    expect(controller.shouldContinueResearch()).toBe(false);
    expect(controller.snapshot()).toMatchObject({
      status: "WAITING_FOR_BUDGET",
      budgetBlockers: expect.arrayContaining(["BIRDEYE", "HELIUS_INDEX"]),
      budget: { nextResetAt: "2027-02-01T00:00:00.000Z" }
    });
  });

  it("automatically resumes after the UTC monthly ledger window resets", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    vi.spyOn(repository, "walletIndexCoverage").mockReturnValue(coverage(5_000));
    repository.incrementUsage("helius_index", 250_000, JANUARY);
    let now = new Date(JANUARY);
    const controller = new WalletAcquisitionController(repository, { now: () => new Date(now) });
    expect(controller.onPipelineDrained()).toBe(false);

    now = new Date("2027-02-01T00:00:00.000Z");
    expect(controller.onPipelineDrained()).toBe(true);
    expect(controller.targetWallets()).toBe(10_000);
  });

  it("isolates the total Helius scoring-reserve blocker from the index sub-budget", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    vi.spyOn(repository, "walletIndexCoverage").mockReturnValue(coverage(5_000));
    repository.incrementUsage("helius", 10_000, JANUARY);
    const controller = new WalletAcquisitionController(repository, {
      now: () => new Date(JANUARY),
      signaturePageSize: 1,
      maximumIndexCreditsPerMonth: 10_000,
      maximumTotalHeliusCreditsPerMonth: 60_000
    });

    expect(controller.onPipelineDrained()).toBe(false);
    expect(controller.snapshot()).toMatchObject({
      status: "WAITING_FOR_BUDGET",
      budgetBlockers: ["HELIUS_TOTAL"]
    });
  });

  it("persists source exhaustion without skipping to a larger target", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    vi.spyOn(repository, "walletIndexCoverage").mockReturnValue(coverage(4_000));
    const controller = new WalletAcquisitionController(repository, { now: () => new Date(JANUARY) });

    expect(controller.onPipelineDrained(true)).toBe(false);
    expect(controller.snapshot()).toMatchObject({
      targetWallets: 5_000,
      status: "SOURCE_EXHAUSTED"
    });
  });

  it("keeps a prematurely persisted 10,000 target fenced while an older generation is unscreened", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    vi.spyOn(repository, "walletIndexCoverage").mockReturnValue(coverage(5_000));
    repository.createWalletDeepHistoryCohort({
      selectedAt: JANUARY.toISOString(),
      snapshotCutoffAt: JANUARY.toISOString(),
      windowStart: new Date(JANUARY.getTime() - 90 * 86_400_000).toISOString(),
      windowEnd: JANUARY.toISOString(),
      wallets: ["still-frozen-in-generation-one"]
    });
    repository.setSetting(WALLET_ACQUISITION_GOAL_SETTING, {
      version: 1,
      targetWallets: 10_000,
      status: "ACQUIRING",
      qualifiedWallets: 2,
      updatedAt: JANUARY.toISOString(),
      budgetBlockers: []
    });
    const controller = new WalletAcquisitionController(repository, { now: () => new Date(JANUARY) });

    expect(controller.targetWallets()).toBe(10_000);
    expect(controller.canDiscoverPage()).toBe(false);
    expect(controller.onPipelineDrained()).toBe(false);
    expect(controller.snapshot()).toMatchObject({ targetWallets: 10_000, status: "DRAINING" });
  });

  it("fails closed instead of guessing when its durable setting is malformed", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    repository.setSetting(WALLET_ACQUISITION_GOAL_SETTING, { version: 1, targetWallets: 12_345 });
    expect(() => new WalletAcquisitionController(repository, { now: () => new Date(JANUARY) }))
      .toThrow("fail-closed");
  });
});
