import { afterEach, describe, expect, it } from "vitest";
import type {
  DiscoveredWalletSet,
  WalletCandidate,
  WalletHistorySummary,
  WalletIndexRecord,
  WalletPreScreenSnapshot,
  WalletScore
} from "@copylab/shared";
import type { FastifyInstance } from "fastify";
import { AppService } from "../src/app-service.js";
import { buildApp } from "../src/app.js";
import { openDatabase, type CopyLabDatabase } from "../src/database.js";
import { EventBus } from "../src/events.js";
import { ModeManager } from "../src/mode.js";
import { Repository } from "../src/repository.js";
import { SecretVault } from "../src/vault.js";
import { WalletManager } from "../src/wallet.js";
import { MockRuntime } from "./helpers.js";
import { combineManagedProviderAndFrozenHistory } from "../src/wallet-research.js";

const at = "2026-07-09T12:00:00.000Z";

describe("managed frozen-history qualification evidence", () => {
  it("uses exact frozen structural metrics while retaining the stricter concentration and all tags", () => {
    const frozen: WalletIndexRecord = {
      ...indexRecord(0),
      historyDays: 90,
      closedEligibleSwaps: 60,
      activeWeeks: 4,
      medianHoldingMinutes: 30,
      deepHistorySignatureCount: 250,
      deepHistoryHydratedCount: 250,
      profitPricingCoverage: "COMPLETE",
      topTokenProfitShare: 0.3,
      topThreeProfitShare: 0.6,
      tags: ["local-tag"]
    };
    const provider: WalletHistorySummary = {
      wallet: frozen.wallet,
      historyDays: 3,
      closedEligibleSwaps: 2,
      activeWeeks: 1,
      medianHoldingMinutes: 5,
      topTokenProfitShare: 0.2,
      topThreeProfitShare: 0.5,
      tags: ["provider-tag"]
    };

    expect(combineManagedProviderAndFrozenHistory(provider, frozen)).toEqual({
      wallet: frozen.wallet,
      historyDays: 90,
      closedEligibleSwaps: 60,
      activeWeeks: 4,
      medianHoldingMinutes: 30,
      topTokenProfitShare: 0.3,
      topThreeProfitShare: 0.6,
      tags: ["local-tag", "provider-tag"]
    });
  });

  it("fails closed when the frozen RPC evidence is not terminal and fully hydrated", () => {
    const frozen = {
      ...indexRecord(0),
      deepHistorySignatureCount: 250,
      deepHistoryHydratedCount: 249
    };
    expect(() => combineManagedProviderAndFrozenHistory({
      wallet: frozen.wallet,
      historyDays: 90,
      closedEligibleSwaps: 60,
      activeWeeks: 4,
      medianHoldingMinutes: 30,
      topTokenProfitShare: 0.2,
      topThreeProfitShare: 0.5,
      tags: []
    }, frozen)).toThrow("complete immutable RPC history evidence");
  });
});

function indexRecord(index: number): WalletIndexRecord {
  const ready = index < 10;
  return {
    wallet: `wallet-${index.toString().padStart(3, "0")}`,
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: new Date(Date.parse(at) - index * 60_000).toISOString(),
    historyDays: index,
    transactionCount: 100 - index,
    successfulTransactionCount: 100 - index,
    spotSwapCount: 80 - index,
    eligibleSpotSwapCount: 75 - index,
    closedEligibleSwaps: 70 - index,
    buyCount: 40,
    sellCount: 35,
    activeDays: 20,
    activeWeeks: 4,
    distinctMints: 8,
    medianHoldingMinutes: index % 2 === 0 ? 20 : 5,
    preScreenEligible: ready,
    preScreenReasons: ready ? [] : index < 20 ? ["insufficient recent active weeks"] : ["pending activity pre-screen"],
    deepHistoryStatus: ready ? "COMPLETE" : "AWAITING",
    structuralEligible: ready && index % 2 === 0,
    structuralReasons: ready && index % 2 === 0 ? [] : ["awaiting local deep history"],
    updatedAt: at
  };
}

describe("paginated wallet research", () => {
  let app: FastifyInstance | undefined;
  let db: CopyLabDatabase | undefined;
  let repository: Repository;
  let service: AppService;
  let runtime: MockRuntime;

  afterEach(async () => {
    await app?.close();
    db?.close();
  });

  async function setup(): Promise<void> {
    db = openDatabase(":memory:");
    repository = new Repository(db);
    const vault = new SecretVault(repository);
    const wallet = new WalletManager(vault, repository);
    runtime = new MockRuntime();
    service = new AppService(
      repository,
      vault,
      wallet,
      new ModeManager(repository, wallet),
      new EventBus(),
      runtime
    );
    app = await buildApp(service);
    for (let index = 0; index < 70; index += 1) {
      const record = indexRecord(index);
      repository.upsertWalletIndexRecord(record);
      if (index < 20) {
        const snapshot: WalletPreScreenSnapshot = {
          wallet: record.wallet,
          runId: "run-1",
          calculatedAt: at,
          eligible: record.preScreenEligible,
          reasons: record.preScreenReasons,
          record
        };
        repository.saveWalletPreScreenSnapshot(snapshot);
      }
    }
  }

  it("returns bounded deterministic pages and explicit pre-screen filters", async () => {
    await setup();
    const secondPage = await app!.inject({
      method: "GET",
      url: "/api/wallets/research?page=2&pageSize=15&filter=ALL&sort=HISTORY"
    });
    expect(secondPage.statusCode).toBe(200);
    expect(secondPage.json()).toMatchObject({
      page: 2,
      pageSize: 15,
      total: 70,
      totalPages: 5,
      filter: "ALL",
      sort: "HISTORY"
    });
    expect(secondPage.json().items).toHaveLength(15);
    expect(secondPage.json().items[0]).toMatchObject({ historyDays: 54 });

    const ready = await app!.inject({ method: "GET", url: "/api/wallets/research?filter=PRESCREEN_READY" });
    const rejected = await app!.inject({ method: "GET", url: "/api/wallets/research?filter=PRESCREEN_REJECTED" });
    const pending = await app!.inject({ method: "GET", url: "/api/wallets/research?filter=AWAITING_PRESCREEN" });
    expect(ready.json()).toMatchObject({ total: 10 });
    expect(rejected.json()).toMatchObject({ total: 10 });
    expect(pending.json()).toMatchObject({ total: 50 });
  });

  it("rejects oversized pages and exposes source-defined funnel counts", async () => {
    await setup();
    const oversized = await app!.inject({
      method: "GET",
      url: "/api/wallets/research?pageSize=101"
    });
    expect(oversized.statusCode).toBe(400);

    const dashboard = await app!.inject({ method: "GET", url: "/api/dashboard" });
    expect(dashboard.json().operationalPause).toMatchObject({
      active: false,
      reasons: [],
      recovery: "NONE"
    });
    const funnel = dashboard.json().walletIndex.researchFunnel;
    expect(funnel.localIndex.map((stage: { key: string; count: number }) => [stage.key, stage.count])).toEqual([
      ["INDEXED", 70],
      ["ACTIVITY_SCREENED", 20],
      ["ACTIVITY_PROVEN", 10],
      ["CLOSED_SWAPS", 10],
      ["HOLDING_TIME", 5]
    ]);
    expect(funnel.localIndex[0]).toMatchObject({
      definition: expect.stringContaining("sole fee-paying signer"),
      sources: ["wallet_index", "index_signature_sources", "indexed_spot_swaps"]
    });
  });

  it("publishes the durable managed acquisition target and monthly budget blocker", async () => {
    await setup();
    (runtime as MockRuntime & { walletAcquisitionStatus: () => unknown }).walletAcquisitionStatus = () => ({
      version: 1,
      targetWallets: 10_000,
      maximumWallets: 25_000,
      qualifiedWallets: 2,
      status: "WAITING_FOR_BUDGET",
      updatedAt: at,
      budgetBlockers: ["BIRDEYE"],
      budget: {
        monthStart: "2026-07-01",
        nextResetAt: "2026-08-01T00:00:00.000Z",
        birdeyeRemainingCu: 100,
        heliusIndexRemainingCredits: 50_000,
        totalHeliusRemainingCredits: 500_000,
        birdeyeScoringReserveCu: 6_480,
        heliusDiscoveryPageReserveCredits: 6_004,
        heliusScoringReserveCredits: 50_550
      }
    });

    expect(service.dashboard().walletIndex).toMatchObject({
      targetWallets: 10_000,
      acquisition: {
        status: "WAITING_FOR_BUDGET",
        qualifiedWallets: 2,
        budgetBlockers: ["BIRDEYE"],
        budget: { nextResetAt: "2026-08-01T00:00:00.000Z" }
      }
    });
  });

  it("shows a partial qualified set as shadow-only while the exact-three freeze is waiting", async () => {
    await setup();
    const candidates: WalletCandidate[] = Array.from({ length: 2 }, (_, index) => ({
      address: `partial-${index}`,
      cohortId: "partial-cohort",
      firstSeenAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: at,
      control: false,
      tags: []
    }));
    repository.saveCohort({ cohortId: "partial-cohort", generatedAt: at, candidates });
    repository.setActiveWallets("partial-cohort", candidates.map((candidate) => candidate.address));
    for (const candidate of candidates) {
      repository.saveWalletScore("partial-cohort", {
        wallet: candidate.address,
        calculatedAt: at,
        qualified: true,
        reasons: [],
        historyDays: 90,
        closedEligibleSwaps: 50,
        activeWeeks: 3,
        medianHoldingMinutes: 15,
        topTokenProfitShare: 0.2,
        topThreeProfitShare: 0.5
      });
    }

    const dashboard = service.dashboard();
    expect(repository.activePaperEvaluationCohort()).toBeUndefined();
    expect(dashboard.activeWallets.every((candidate) => candidate.trackingLane === "SHADOW")).toBe(true);
    expect(
      dashboard.walletIndex.researchFunnel.providerCohort.find((stage) => stage.key === "FROZEN_ACTIVE")?.count
    ).toBe(0);
    expect(dashboard.promotion.elapsedDays).toBe(0);
  });

  it("keeps the dashboard cohort digest bounded while retaining lane priority", async () => {
    await setup();
    const candidates: WalletCandidate[] = Array.from({ length: 80 }, (_, index) => ({
      address: `candidate-${index.toString().padStart(3, "0")}`,
      cohortId: "cohort-large",
      firstSeenAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: at,
      sourceRank30d: index + 1,
      control: index >= 70,
      tags: []
    }));
    const cohort: DiscoveredWalletSet = { cohortId: "cohort-large", generatedAt: at, candidates };
    repository.saveCohort(cohort);
    const active = candidates.slice(0, 3).map((candidate) => candidate.address);
    repository.setActiveWallets("cohort-large", active);
    for (let index = 0; index < 60; index += 1) {
      const score: WalletScore = {
        wallet: candidates[index]!.address,
        calculatedAt: at,
        qualified: index < 20,
        reasons: index < 20 ? [] : ["not qualified"],
        historyDays: 90,
        closedEligibleSwaps: 50,
        activeWeeks: 3,
        medianHoldingMinutes: 15,
        topTokenProfitShare: 0.2,
        topThreeProfitShare: 0.4
      };
      repository.saveWalletScore("cohort-large", score);
    }
    repository.freezePaperEvaluationCohort("cohort-large", active, 141, at);

    const dashboard = service.dashboard();
    expect(dashboard.activeWallets).toHaveLength(50);
    expect(dashboard.activeWallets.slice(0, 3).every((candidate) => candidate.trackingLane === "ACTIVE")).toBe(true);
    expect(dashboard.activeWallets.filter((candidate) => candidate.trackingLane === "CONTROL")).toHaveLength(10);
  });
});
