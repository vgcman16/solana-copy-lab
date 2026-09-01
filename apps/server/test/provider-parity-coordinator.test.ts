import { describe, expect, it } from "vitest";
import {
  SOL_MINT,
  USDC_MINT,
  type DataProviderProfile,
  type DiscoveredWalletSet,
  type LeaderSwap,
  type IndexedSpotSwap,
  type WalletHistorySummary,
  type WalletIndexRecord,
  type WalletPnlWindow
} from "@copylab/shared";
import { openDatabase } from "../src/database.js";
import { Repository } from "../src/repository.js";
import {
  ProviderParityBaselineCoordinator,
  type PointInTimeChainProvider,
  type PointInTimeWalletDiscoveryProvider
} from "../src/provider-parity-coordinator.js";
import { LOCAL_WALLET_IDENTITY_SOURCE } from "../src/local-wallet-identity.js";
import { compareWalletDiscovery } from "../src/provider-parity.js";
import { bindProviderParityObservation } from "../src/provider-parity-proof.js";
import { dataProviderEndpointFingerprint } from "../src/provider-rpc-readiness.js";

const START = "2026-04-11T12:00:00.000Z";
const CUTOFF = "2026-07-10T12:00:00.000Z";
const WALLETS = ["winner-1", "winner-2", "winner-3", "winner-4", "control-1"];

function profile(): DataProviderProfile {
  return {
    mode: "SHADOW",
    solanaHttpUrl: "https://rpc.example.test",
    solanaWsUrl: "wss://rpc.example.test"
  };
}

function record(wallet: string, index: number): WalletIndexRecord {
  const control = wallet.startsWith("control");
  const pnl = control ? -10 : 100 - index * 10;
  return {
    wallet,
    firstSeenAt: START,
    lastSeenAt: CUTOFF,
    historyDays: 90,
    transactionCount: 100,
    successfulTransactionCount: 100,
    spotSwapCount: 60,
    eligibleSpotSwapCount: 60,
    closedEligibleSwaps: 50,
    buyCount: 50,
    sellCount: 50,
    activeDays: 30,
    activeWeeks: 4,
    distinctMints: 10,
    medianHoldingMinutes: 30,
    preScreenEligible: true,
    preScreenReasons: [],
    updatedAt: CUTOFF,
    realizedPnl30dUsd: pnl,
    realizedPnl90dUsd: pnl * 2,
    topTokenProfitShare: 0.2,
    topThreeProfitShare: 0.5,
    tags: [],
    walletIdentityStatus: "VERIFIED",
    walletIdentitySource: LOCAL_WALLET_IDENTITY_SOURCE,
    walletIdentityCheckedAt: CUTOFF,
    deepHistoryStatus: "COMPLETE",
    deepHistoryWindowStart: START,
    deepHistoryWindowEnd: CUTOFF,
    deepHistorySignatureCount: 60,
    deepHistoryHydratedCount: 60,
    structuralEligible: true,
    structuralReasons: [],
    pricedClosedEligibleSwaps: 50,
    unpricedClosedEligibleSwaps: 0,
    realizedPnlPricedUsd: pnl * 2,
    pricedProfitTokenCount: 5,
    profitPricingCoverage: "COMPLETE"
  };
}

function frozenSwaps(wallet: string, index: number): IndexedSpotSwap[] {
  const targetMint = `mint-${wallet}`;
  const proceeds = wallet.startsWith("control") ? 5 : 20 - index;
  return [
    {
      id: `${wallet}:buy`,
      signature: `${wallet}-buy-signature`,
      wallet,
      swapIndex: 0,
      slot: 1,
      blockTime: "2026-06-20T12:00:00.000Z",
      side: "BUY",
      baseMint: USDC_MINT,
      targetMint,
      inputMint: USDC_MINT,
      outputMint: targetMint,
      inputAmountAtomic: "10000000",
      outputAmountAtomic: "10000000",
      inputAmountUi: 10,
      outputAmountUi: 10,
      eligible: true,
      eligibilityReasons: [],
      programIds: [],
      indexedAt: CUTOFF,
      priceUsd: 1
    },
    {
      id: `${wallet}:sell`,
      signature: `${wallet}-sell-signature`,
      wallet,
      swapIndex: 0,
      slot: 2,
      blockTime: "2026-07-01T12:00:00.000Z",
      side: "SELL",
      baseMint: USDC_MINT,
      targetMint,
      inputMint: targetMint,
      outputMint: USDC_MINT,
      inputAmountAtomic: "10000000",
      outputAmountAtomic: String(proceeds * 1_000_000),
      inputAmountUi: 10,
      outputAmountUi: proceeds,
      eligible: true,
      eligibilityReasons: [],
      programIds: [],
      indexedAt: CUTOFF,
      priceUsd: proceeds / 10
    }
  ];
}

function seedGeneration(repository: Repository): void {
  const cohort = repository.createWalletDeepHistoryCohort({
    selectedAt: CUTOFF,
    snapshotCutoffAt: CUTOFF,
    windowStart: START,
    windowEnd: CUTOFF,
    wallets: WALLETS
  });
  for (const [index, wallet] of WALLETS.entries()) {
    repository.saveWalletDeepHistoryEvidence({
      generationId: cohort.generationId,
      cohortId: cohort.id,
      wallet,
      record: record(wallet, index),
      swaps: frozenSwaps(wallet, index),
      frozenAt: CUTOFF
    });
  }
  expect(repository.completeWalletDeepHistoryCohort(cohort.id, new Date(CUTOFF))).toBe(true);
  expect(repository.completeWalletDeepHistoryGeneration(cohort.generationId, new Date(CUTOFF))).toBe(true);
}

function pnl(wallet: string, duration: "30d" | "90d"): WalletPnlWindow {
  const source = record(wallet, WALLETS.indexOf(wallet));
  const value = duration === "30d" ? source.realizedPnl30dUsd! : source.realizedPnl90dUsd!;
  return {
    duration,
    realizedProfitUsd: value,
    realizedProfitPercent: value,
    unrealizedProfitUsd: 0,
    totalTrades: 50,
    wins: value > 0 ? 50 : 0,
    losses: value < 0 ? 50 : 0
  };
}

function discovery(): DiscoveredWalletSet {
  return {
    cohortId: "point-in-time",
    generatedAt: CUTOFF,
    candidates: WALLETS.map((wallet, index) => ({
      address: wallet,
      cohortId: "point-in-time",
      firstSeenAt: START,
      lastSeenAt: CUTOFF,
      control: wallet.startsWith("control"),
      tags: [],
      ...(wallet.startsWith("control") ? {} : {
        sourceRank30d: index + 1,
        sourceRank90d: index + 1
      })
    }))
  };
}

function history(wallet: string): WalletHistorySummary {
  return {
    wallet,
    historyDays: 90,
    closedEligibleSwaps: 50,
    activeWeeks: 4,
    medianHoldingMinutes: 30,
    topTokenProfitShare: 0.2,
    topThreeProfitShare: 0.5,
    tags: []
  };
}

function gap(wallet: string): LeaderSwap[] {
  return [{
    sourceSignature: `${wallet}-signature`,
    sourceWallet: wallet,
    slot: 1,
    blockTime: "2026-07-01T12:00:00.000Z",
    detectedAt: "2026-07-01T12:00:01.000Z",
    side: "BUY",
    baseMint: SOL_MINT,
    targetMint: "target",
    baseAmountAtomic: "1",
    targetAmountAtomic: "2",
    baseAmountUi: 1,
    targetAmountUi: 2,
    leaderPriceUsd: 1,
    recovered: true
  }];
}

function sources(emptyGap = false): {
  managedDiscovery: PointInTimeWalletDiscoveryProvider;
  localDiscovery: PointInTimeWalletDiscoveryProvider;
  managedChain: PointInTimeChainProvider;
  localChain: PointInTimeChainProvider;
} {
  const wallet: PointInTimeWalletDiscoveryProvider = {
    discoverCohortAt: async () => discovery(),
    getPnlAt: async (address, duration) => pnl(address, duration)
  };
  const chain: PointInTimeChainProvider = {
    summarizeHistoryAt: async (address) => history(address),
    repairGapAt: async (address) => emptyGap ? [] : gap(address)
  };
  return {
    managedDiscovery: wallet,
    localDiscovery: wallet,
    managedChain: chain,
    localChain: chain
  };
}

describe("provider parity baseline coordinator", () => {
  it("freezes a durable manifest and reports exact as-of interface blockers without rolling calls", async () => {
    const db = openDatabase(":memory:");
    try {
      const repository = new Repository(db);
      seedGeneration(repository);
      const run = await new ProviderParityBaselineCoordinator(
        repository,
        profile,
        { now: () => new Date(CUTOFF) }
      ).capture();

      expect(run).toMatchObject({
        status: "BLOCKED",
        cutoffAt: CUTOFF,
        windowStartAt: START,
        subjects: expect.arrayContaining([
          expect.objectContaining({ role: "WINNER" }),
          expect.objectContaining({ role: "CONTROL" })
        ]),
        acquisitions: []
      });
      expect(run.blockers.map((entry) => entry.code)).toEqual(expect.arrayContaining([
        "MANAGED_DISCOVERY_AS_OF_UNSUPPORTED",
        "MANAGED_PNL_AS_OF_UNSUPPORTED",
        "MANAGED_HISTORY_AS_OF_UNSUPPORTED",
        "MANAGED_GAP_CUTOFF_UNSUPPORTED"
      ]));
      expect(repository.providerParityProofEpoch(run.proofEpochId!)?.status).toBe("PREPARED");
      expect(repository.activeProviderParityProofEpoch()).toBeUndefined();
      expect(new Repository(db).latestProviderParityBaselineRun()).toEqual(run);
    } finally {
      db.close();
    }
  });

  it("invalidates a superseded prepared epoch on repeated blocked capture and endpoint change", async () => {
    const db = openDatabase(":memory:");
    try {
      const repository = new Repository(db);
      seedGeneration(repository);
      let activeProfile = profile();
      const coordinator = () => new ProviderParityBaselineCoordinator(
        repository,
        () => activeProfile,
        { now: () => new Date(CUTOFF) }
      );
      const first = await coordinator().capture();
      const second = await coordinator().capture();
      expect(first.status).toBe("BLOCKED");
      expect(second.status).toBe("BLOCKED");
      expect(second.proofEpochId).not.toBe(first.proofEpochId);
      expect(repository.providerParityProofEpoch(first.proofEpochId!)?.status).toBe("INVALIDATED");
      expect(repository.providerParityProofEpoch(second.proofEpochId!)?.status).toBe("PREPARED");

      activeProfile = {
        mode: "SHADOW",
        solanaHttpUrl: "https://rpc-b.example.test",
        solanaWsUrl: "wss://rpc-b.example.test"
      };
      const third = await coordinator().capture();
      expect(third.status).toBe("BLOCKED");
      expect(third.endpointFingerprint).not.toBe(second.endpointFingerprint);
      expect(repository.providerParityProofEpoch(second.proofEpochId!)?.status).toBe("INVALIDATED");
      expect(repository.providerParityProofEpoch(third.proofEpochId!)?.status).toBe("PREPARED");
      expect(repository.latestProviderParityBaselineRun()?.id).toBe(third.id);
    } finally {
      db.close();
    }
  });

  it("captures and activates a complete point-in-time baseline through the explicit adapter contract", async () => {
    const db = openDatabase(":memory:");
    try {
      const repository = new Repository(db);
      seedGeneration(repository);
      const coordinator = new ProviderParityBaselineCoordinator(repository, profile, {
        sources: sources(),
        now: () => new Date(CUTOFF)
      });
      const run = await coordinator.capture();

      expect(run).toMatchObject({ status: "ACTIVE", blockers: [] });
      expect(run.acquisitions).toHaveLength(21);
      expect(run.acquisitions.every((entry) => entry.acquisitionSkewMs === 0)).toBe(true);
      expect(run.acquisitions.every((entry) => /^[a-f0-9]{64}$/u.test(entry.inputDigest))).toBe(true);
      expect(repository.activeProviderParityProofEpoch()?.id).toBe(run.proofEpochId);
      expect(repository.listProviderParityObservationsForProofEpoch(run.proofEpochId!)).toHaveLength(21);
      const repeated = await coordinator.capture();
      expect(repeated).toEqual(run);
      expect(repository.latestProviderParityBaselineRun()).toEqual(run);
    } finally {
      db.close();
    }
  });

  it("resumes the exact CAPTURING run and reconciles already-bound evidence without reacquiring it", async () => {
    const db = openDatabase(":memory:");
    try {
      const repository = new Repository(db);
      seedGeneration(repository);
      const endpointFingerprint = dataProviderEndpointFingerprint(profile())!;
      const subjects = WALLETS.map((wallet, index) => wallet.startsWith("control")
        ? { address: wallet, role: "CONTROL" as const }
        : { address: wallet, role: "WINNER" as const, sourceRank30d: index + 1, sourceRank90d: index + 1 }
      ).sort((left, right) => left.address.localeCompare(right.address));
      const epoch = repository.prepareProviderParityProofEpoch({
        id: "resumable-proof",
        endpointFingerprint,
        windowStartAt: START,
        windowEndAt: CUTOFF,
        cutoffAt: CUTOFF,
        controlPopulationAvailable: true,
        subjects,
        createdAt: CUTOFF
      });
      const partialRun = {
        id: "resumable-run",
        status: "CAPTURING" as const,
        requestedAt: CUTOFF,
        updatedAt: CUTOFF,
        proofEpochId: epoch.id,
        endpointFingerprint,
        generationId: repository.latestCompleteWalletDeepHistoryGeneration()!.id,
        windowStartAt: START,
        cutoffAt: CUTOFF,
        subjects,
        blockers: [],
        acquisitions: []
      };
      repository.saveProviderParityBaselineRun(partialRun);
      const primary = discovery();
      const shadow = { ...discovery(), cohortId: "local-point-in-time" };
      const observation = compareWalletDiscovery(primary, shadow, CUTOFF);
      const bound = bindProviderParityObservation(epoch, observation, {
        kind: "DISCOVERY",
        primaryAcquiredAt: CUTOFF,
        shadowAcquiredAt: CUTOFF,
        acquisitionSkewMs: 0,
        cutoffAt: CUTOFF,
        primaryUniverseDigest: String(observation.evidence?.primaryUniverseDigest),
        shadowUniverseDigest: String(observation.evidence?.shadowUniverseDigest),
        sharedPrimaryDigest: String(observation.evidence?.sharedPrimaryDigest),
        sharedShadowDigest: String(observation.evidence?.sharedShadowDigest),
        sharedAddresses: observation.evidence?.sharedAddresses as string[]
      });
      // Simulates an older crash seam where the binding committed before its
      // acquisition was appended. New writes use one atomic repository call.
      repository.saveProviderParityObservation(bound);

      const pointInTimeSources = sources();
      let managedDiscoveryCalls = 0;
      const originalDiscover = pointInTimeSources.managedDiscovery.discoverCohortAt;
      pointInTimeSources.managedDiscovery = {
        ...pointInTimeSources.managedDiscovery,
        discoverCohortAt: async (cutoffAt) => {
          managedDiscoveryCalls += 1;
          return originalDiscover(cutoffAt);
        }
      };
      const run = await new ProviderParityBaselineCoordinator(repository, profile, {
        sources: pointInTimeSources,
        now: () => new Date(CUTOFF)
      }).capture();
      expect(run).toMatchObject({ id: partialRun.id, status: "ACTIVE" });
      expect(managedDiscoveryCalls).toBe(0);
      expect(run.acquisitions).toHaveLength(21);
      expect(repository.listProviderParityObservationsForProofEpoch(epoch.id)).toHaveLength(21);
    } finally {
      db.close();
    }
  });

  it("invalidates an orphaned ACTIVE epoch and allows a fresh atomic capture", async () => {
    const db = openDatabase(":memory:");
    try {
      const repository = new Repository(db);
      seedGeneration(repository);
      const coordinator = new ProviderParityBaselineCoordinator(repository, profile, {
        sources: sources(),
        now: () => new Date(CUTOFF)
      });
      const first = await coordinator.capture();
      expect(first.status).toBe("ACTIVE");
      db.prepare("DELETE FROM provider_parity_baseline_runs WHERE id = ?").run(first.id);

      const second = await coordinator.capture();
      expect(second.status).toBe("ACTIVE");
      expect(second.proofEpochId).not.toBe(first.proofEpochId);
      expect(repository.providerParityProofEpoch(first.proofEpochId!)?.status).toBe("INVALIDATED");
      expect(repository.listAudit(10)).toEqual(expect.arrayContaining([
        expect.objectContaining({ eventType: "provider_parity_orphaned_active_invalidated", severity: "critical" })
      ]));
    } finally {
      db.close();
    }
  });

  it("fails closed and never activates when both gap results are empty", async () => {
    const db = openDatabase(":memory:");
    try {
      const repository = new Repository(db);
      seedGeneration(repository);
      const run = await new ProviderParityBaselineCoordinator(repository, profile, {
        sources: sources(true),
        now: () => new Date(CUTOFF)
      }).capture();
      expect(run.status).toBe("FAILED");
      expect(run.blockers[0]?.code).toBe("CAPTURE_FAILED");
      expect(run.blockers[0]?.message).toMatch(/non-empty signature coverage/u);
      expect(repository.activeProviderParityProofEpoch()).toBeUndefined();
      expect(repository.providerParityProofEpoch(run.proofEpochId!)?.status).toBe("PREPARED");
    } finally {
      db.close();
    }
  });
});
