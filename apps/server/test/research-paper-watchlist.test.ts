import { afterEach, describe, expect, it } from "vitest";
import {
  USDC_MINT,
  type IndexedSpotSwap,
  type ResearchPaperEvent,
  type ResearchPaperPosition,
  type WalletCandidate,
  type WalletScore
} from "@copylab/shared";
import type { CopyLabDatabase } from "../src/database.js";
import { openDatabase } from "../src/database.js";
import { Repository } from "../src/repository.js";

const NOW = new Date("2026-07-13T12:00:00.000Z");
const CURRENT = "2026-07-12T12:00:00.000Z";
const STALE = "2026-07-01T12:00:00.000Z";

function candidate(
  address: string,
  completedTrades30d: number,
  options: { pnl90d?: number; rank30d?: number; rank90d?: number } = {}
): WalletCandidate {
  return {
    address,
    cohortId: "provider-cohort",
    firstSeenAt: "2026-04-01T00:00:00.000Z",
    lastSeenAt: CURRENT,
    sourceRank30d: options.rank30d ?? 10,
    sourceRank90d: options.rank90d ?? 10,
    control: false,
    tags: [],
    pnl30d: {
      duration: "30d",
      realizedProfitUsd: 1_000,
      realizedProfitPercent: 10,
      unrealizedProfitUsd: 0,
      totalTrades: completedTrades30d * 2,
      wins: completedTrades30d - 5,
      losses: 5
    },
    pnl90d: {
      duration: "90d",
      realizedProfitUsd: options.pnl90d ?? 2_000,
      realizedProfitPercent: 20,
      unrealizedProfitUsd: 0,
      totalTrades: completedTrades30d * 4,
      wins: completedTrades30d,
      losses: 5
    }
  };
}

function score(wallet: string, qualified = false, calculatedAt = CURRENT): WalletScore {
  return {
    wallet,
    calculatedAt,
    qualified,
    reasons: qualified ? [] : ["strict qualification intentionally not required in research"],
    historyDays: 90,
    closedEligibleSwaps: 50,
    activeWeeks: 4,
    medianHoldingMinutes: 20,
    topTokenProfitShare: 0.2,
    topThreeProfitShare: 0.4
  };
}

function persistLocalSwap(repository: Repository, wallet: string, index: number): void {
  const blockTime = `2026-07-${String(10 + index).padStart(2, "0")}T12:00:00.000Z`;
  const signature = `local-${wallet}-${index}`;
  const swap: IndexedSpotSwap = {
    id: `${signature}:${wallet}:0`,
    signature,
    wallet,
    swapIndex: 0,
    slot: 100 + index,
    blockTime,
    side: "BUY",
    baseMint: USDC_MINT,
    targetMint: `mint-${wallet}`,
    inputMint: USDC_MINT,
    outputMint: `mint-${wallet}`,
    inputAmountAtomic: "1000000",
    outputAmountAtomic: "1000000",
    inputAmountUi: 1,
    outputAmountUi: 1,
    eligible: false,
    eligibilityReasons: ["research fixture"],
    programIds: ["fixture-program"],
    indexedAt: blockTime
  };
  repository.enqueueWalletIndexTransactions([{
    signature,
    sourceAddress: "fixture-program",
    wallet,
    source: "research-watchlist-test",
    discoveredAt: blockTime,
    slot: swap.slot,
    blockTime
  }]);
  const leased = repository.leaseWalletIndexTransactions(
    "research-watchlist-test",
    1,
    60,
    new Date(blockTime)
  )[0];
  if (!leased?.leaseToken) throw new Error("Fixture transaction was not leased.");
  expect(repository.completeWalletIndexTransaction({
    ...leased,
    slot: swap.slot,
    blockTime,
    success: true,
    feePayer: wallet,
    accountKeys: [wallet],
    programIds: swap.programIds,
    transactionVersion: "0",
    raw: { fixture: true }
  }, [swap], leased.leaseToken, new Date(blockTime))).toBe(true);
}

describe("research-only active wallet watchlist", () => {
  let db: CopyLabDatabase | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  function setup(): { repository: Repository; laneId: string } {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const candidates = [
      candidate("strict-a", 50),
      candidate("strict-b", 40),
      candidate("strict-c", 10),
      candidate("research-local", 30, { rank30d: 99, rank90d: 99 }),
      candidate("research-high", 100, { rank30d: 1, rank90d: 1 }),
      candidate("research-next", 80, { rank30d: 2, rank90d: 2 }),
      candidate("holding-only", 24),
      candidate("negative-90d", 100, { pnl90d: -1 }),
      candidate("stale-provider", 100)
    ];
    repository.saveCohort({
      cohortId: "provider-cohort",
      generatedAt: CURRENT,
      candidates
    });
    for (const item of candidates) {
      repository.saveWalletScore(
        item.cohortId,
        score(item.address, item.address.startsWith("strict-"), item.address === "stale-provider" ? STALE : CURRENT)
      );
    }
    repository.setActiveWallets("provider-cohort", ["strict-a", "strict-b", "strict-c"]);
    repository.db.prepare(`
      UPDATE wallet_candidates SET updated_at = ? WHERE cohort_id = 'provider-cohort'
    `).run(CURRENT);
    repository.db.prepare(`
      UPDATE wallet_candidates SET updated_at = ?
      WHERE cohort_id = 'provider-cohort' AND address = 'stale-provider'
    `).run(STALE);
    expect(repository.freezePaperEvaluationCohort(
      "provider-cohort",
      ["strict-a", "strict-b", "strict-c"],
      141,
      CURRENT
    )?.created).toBe(true);
    persistLocalSwap(repository, "research-local", 0);
    persistLocalSwap(repository, "research-local", 1);
    const lane = repository.createResearchPaperLane({
      id: "research-lane",
      policyVersion: "high-risk-v1",
      startedAt: CURRENT
    });
    return { repository, laneId: lane.id };
  }

  it("fills only remaining capacity with fresh positive active traders and never pads or rotates", () => {
    const { repository, laneId } = setup();
    const activeStrictBefore = repository.listCandidates("provider-cohort", true).map((item) => item.address);

    const first = repository.refreshResearchPaperWatchlist(laneId, {
      targetWalletCount: 5,
      at: NOW
    });
    expect(first).toMatchObject({
      eligibleCandidateCount: 5,
      preexistingLeaderCount: 3,
      newlyEnrolledCount: 2,
      totalLeaderCount: 5,
      strictLeaderCount: 3,
      strictOverlapCount: 2,
      researchOnlyMonitoredCount: 2,
      remainingCapacity: 0,
      policy: {
        targetWalletCount: 5,
        activityWindowDays: 30,
        minimumRecentTrades: 25
      }
    });
    expect(repository.listResearchPaperWatchlistWallets(laneId, { researchOnly: true }))
      .toEqual(["research-local", "research-high"]);
    expect(repository.getResearchPaperWatchlistMember(laneId, "research-local")).toMatchObject({
      activityEvidenceSource: "LOCAL_CONFIRMED_SPOT_AND_PROVIDER",
      localConfirmedSpotSwaps: 2,
      completedTrades30d: 30
    });
    expect(repository.getResearchPaperLeader(laneId, "holding-only")).toBeUndefined();
    expect(repository.getResearchPaperLeader(laneId, "stale-provider")).toBeUndefined();

    const preserved = repository.getResearchPaperLeader(laneId, "research-local")!;
    repository.upsertResearchPaperLeader({
      ...preserved,
      cashUsd: 130,
      navUsd: 140,
      updatedAt: NOW.toISOString()
    });
    const second = repository.refreshResearchPaperWatchlist(laneId, {
      targetWalletCount: 25,
      at: NOW
    });
    expect(second).toMatchObject({
      newlyEnrolledCount: 1,
      totalLeaderCount: 6,
      remainingCapacity: 19
    });
    expect(repository.getResearchPaperLeader(laneId, "research-local")).toMatchObject({ cashUsd: 130, navUsd: 140 });
    expect(repository.listResearchPaperWatchlistWallets(laneId, { researchOnly: true }))
      .toEqual(["research-local", "research-high", "research-next"]);
    expect(repository.listCandidates("provider-cohort", true).map((item) => item.address))
      .toEqual(activeStrictBefore);
    expect(repository.activePaperEvaluationCohort()?.wallets)
      .toEqual(["strict-a", "strict-b", "strict-c"]);
  });

  it("persists direct research events, lots, and repair cursors without strict-ledger writes", () => {
    const { repository, laneId } = setup();
    repository.refreshResearchPaperWatchlist(laneId, { targetWalletCount: 5, at: NOW });
    const claim: ResearchPaperEvent = {
      eventKey: "direct-research-event",
      laneId,
      wallet: "research-local",
      kind: "SIGNAL",
      outcome: "CLAIMED",
      observedAt: NOW.toISOString(),
      sourceSignature: "direct-research-signature",
      mint: "direct-research-mint",
      action: "BUY"
    };
    expect(repository.claimResearchPaperEvent(claim)).toBe(true);
    expect(repository.db.prepare(`
      SELECT source_signature FROM research_paper_events WHERE event_key = ?
    `).get(claim.eventKey)).toEqual({ source_signature: null });
    expect(repository.getResearchPaperEvent(claim.eventKey)?.sourceSignature)
      .toBe("direct-research-signature");

    const position: ResearchPaperPosition = {
      id: "direct-research-position",
      laneId,
      wallet: claim.wallet,
      mint: claim.mint!,
      sourceEntrySignature: claim.sourceSignature!,
      openedAt: NOW.toISOString(),
      simulatedInitialAtomic: "1000",
      simulatedRemainingAtomic: "1000",
      leaderInitialAtomic: "1000",
      leaderRemainingAtomic: "1000",
      entryCostUsd: 10,
      remainingCostUsd: 10,
      lastExecutableValueUsd: 9.5,
      pendingExitFraction: 0,
      status: "OPEN",
      updatedAt: NOW.toISOString()
    };
    repository.upsertResearchPaperPosition(position);
    expect(repository.getResearchPaperPosition(position.id)).toEqual(position);
    expect(repository.db.prepare("SELECT COUNT(*) AS count FROM research_paper_positions").get())
      .toEqual({ count: 0 });
    expect(repository.db.prepare("SELECT COUNT(*) AS count FROM research_paper_watchlist_positions").get())
      .toEqual({ count: 1 });

    const pending = repository.ensureResearchPaperMonitoringCheckpoint(
      laneId,
      claim.wallet,
      "2026-07-13T11:00:00.000Z",
      NOW.toISOString()
    );
    expect(repository.startResearchPaperMonitoringRepair(
      laneId,
      claim.wallet,
      pending.cursorAt,
      NOW.toISOString()
    )).toBe(true);
    expect(repository.completeResearchPaperMonitoringRepair(
      laneId,
      claim.wallet,
      pending.cursorAt,
      "2026-07-13T12:00:00.000Z",
      NOW.toISOString()
    )).toBe(true);
    expect(repository.advanceResearchPaperMonitoringCursor(
      laneId,
      claim.wallet,
      "2026-07-13T12:05:00.000Z",
      "2026-07-13T12:05:01.000Z"
    )).toBe(true);
    expect(repository.advanceResearchPaperMonitoringCursor(
      laneId,
      claim.wallet,
      "2026-07-13T12:04:00.000Z"
    )).toBe(false);
    expect(repository.getResearchPaperMonitoringCheckpoint(laneId, claim.wallet)).toMatchObject({
      status: "READY",
      cursorAt: "2026-07-13T12:05:00.000Z"
    });

    for (const table of [
      "source_events",
      "signal_decisions",
      "signal_outcomes",
      "executions",
      "positions",
      "monitoring_repair_checkpoints"
    ]) {
      expect(repository.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get())
        .toEqual({ count: 0 });
    }
  });
});
