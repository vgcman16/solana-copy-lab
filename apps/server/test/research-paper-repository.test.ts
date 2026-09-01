import { afterEach, describe, expect, it } from "vitest";
import {
  RESEARCH_PAPER_LABEL,
  USDC_MINT,
  type LeaderSwap,
  type ResearchPaperEvent,
  type ResearchPaperPosition,
  type ResearchPaperTrade
} from "@copylab/shared";
import type { CopyLabDatabase } from "../src/database.js";
import { openDatabase } from "../src/database.js";
import { Repository } from "../src/repository.js";

const TARGET_MINT = "ResearchTargetMint111111111111111111111111111";

function source(wallet: string, signature: string): LeaderSwap {
  return {
    sourceSignature: signature,
    sourceWallet: wallet,
    slot: 42,
    blockTime: "2026-07-13T12:00:00.000Z",
    detectedAt: "2026-07-13T12:00:01.000Z",
    side: "BUY",
    baseMint: USDC_MINT,
    targetMint: TARGET_MINT,
    baseAmountAtomic: "14100000",
    targetAmountAtomic: "1000000",
    baseAmountUi: 14.1,
    targetAmountUi: 1,
    leaderPriceUsd: 14.1,
    recovered: false
  };
}

function position(wallet: string, signature: string, id = `position-${wallet}`): ResearchPaperPosition {
  return {
    id,
    laneId: "research-v1",
    wallet,
    mint: TARGET_MINT,
    sourceEntrySignature: signature,
    openedAt: "2026-07-13T12:00:02.000Z",
    simulatedInitialAtomic: "1000000",
    simulatedRemainingAtomic: "1000000",
    leaderInitialAtomic: "1000000",
    leaderRemainingAtomic: "1000000",
    entryCostUsd: 14.1,
    remainingCostUsd: 14.1,
    lastExecutableValueUsd: 13.9,
    pendingExitFraction: 0,
    status: "OPEN",
    updatedAt: "2026-07-13T12:00:02.000Z"
  };
}

describe("isolated research paper repository", () => {
  let db: CopyLabDatabase | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("creates one independent $141 account per leader and resumes without resetting it", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const lane = repository.createResearchPaperLane({
      id: "research-v1",
      policyVersion: "high-risk-v1",
      policy: { relaxTokenEligibility: true },
      startedAt: "2026-07-13T12:00:00.000Z"
    });
    expect(lane).toMatchObject({
      label: RESEARCH_PAPER_LABEL,
      purpose: "RESEARCH_ONLY",
      initialNavPerLeaderUsd: 141,
      status: "ACTIVE"
    });

    const accounts = repository.initializeResearchPaperLeaders(
      ["leader-a", "leader-b", "leader-c", "leader-a"],
      lane.id,
      "2026-07-13T12:00:01.000Z"
    );
    expect(accounts).toHaveLength(3);
    expect(accounts.every((account) =>
      account.initialNavUsd === 141 && account.cashUsd === 141 && account.navUsd === 141
    )).toBe(true);

    repository.upsertResearchPaperLeader({
      ...accounts[0]!,
      cashUsd: 126.9,
      navUsd: 140.8,
      peakNavUsd: 141,
      unrealizedPnlUsd: -0.2,
      openPositions: 1,
      updatedAt: "2026-07-13T12:01:00.000Z"
    });
    expect(repository.pauseResearchPaperLane(lane.id, "2026-07-13T12:02:00.000Z")?.status).toBe("PAUSED");
    expect(repository.resumeResearchPaperLane(lane.id, "2026-07-13T12:03:00.000Z")?.status).toBe("ACTIVE");
    expect(repository.getResearchPaperLeader(lane.id, "leader-a")).toMatchObject({
      initialNavUsd: 141,
      cashUsd: 126.9,
      navUsd: 140.8,
      openPositions: 1
    });
  });

  it("round-trips complete exit-quote retry evidence and rejects unsafe partial state", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const lane = repository.createResearchPaperLane({
      id: "research-v1",
      policyVersion: "high-risk-v1"
    });
    repository.initializeResearchPaperLeader("leader-a", lane.id);
    const observed = source("leader-a", "research-retry-source");
    repository.insertSourceEvent(observed);
    const retrying: ResearchPaperPosition = {
      ...position("leader-a", observed.sourceSignature),
      status: "UNPRICED",
      lastExecutableValueUsd: 0,
      exitQuoteFailureCount: 3,
      lastExitQuoteAttemptAt: "2026-07-13T12:15:00.000Z",
      nextExitQuoteRetryAt: "2026-07-13T12:35:00.000Z",
      lastExitQuoteFailureCode: "JUPITER_EXIT_QUOTE_UNAVAILABLE"
    };
    repository.upsertResearchPaperPosition(retrying);
    expect(repository.getResearchPaperPosition(retrying.id)).toEqual(retrying);

    const incomplete = { ...retrying };
    delete incomplete.nextExitQuoteRetryAt;
    expect(() => repository.upsertResearchPaperPosition(incomplete)).toThrow(/complete timestamps\/code/u);
    expect(() => repository.upsertResearchPaperPosition({
      ...retrying,
      status: "OPEN",
      lastExecutableValueUsd: 1
    })).toThrow(/UNPRICED/u);
    expect(() => repository.upsertResearchPaperPosition({
      ...retrying,
      consecutiveExitNoRouteFailureCount: 1
    })).toThrow(/typed NO_ROUTE/u);
    expect(() => repository.upsertResearchPaperPosition({
      ...retrying,
      exitQuoteFailureCount: 3,
      consecutiveExitNoRouteFailureCount: 4,
      lastExitQuoteFailureCode: "JUPITER_EXIT_NO_ROUTE"
    })).toThrow(/cannot exceed total failures/u);
    const noRouteRetry: ResearchPaperPosition = {
      ...retrying,
      consecutiveExitNoRouteFailureCount: 2,
      lastExitQuoteFailureCode: "JUPITER_EXIT_NO_ROUTE"
    };
    repository.upsertResearchPaperPosition(noRouteRetry);
    expect(repository.getResearchPaperPosition(retrying.id)).toEqual(noRouteRetry);
  });

  it("revises active sizing in place while preserving the prior policy and open lots", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const lane = repository.createResearchPaperLane({
      id: "research-v1",
      policyVersion: "high-risk-paper-v1",
      policy: {
        positionNavFraction: 0.1,
        maximumPositionUsd: 25,
        maximumOpenPositions: 3,
        maximumDeployedFraction: 0.3,
        minimumLiquidReserveUsd: 10
      },
      startedAt: "2026-07-13T12:00:00.000Z"
    });
    repository.initializeResearchPaperLeader("leader-a", lane.id);
    repository.insertSourceEvent(source("leader-a", "source-before-revision"));
    const open = position("leader-a", "source-before-revision");
    repository.upsertResearchPaperPosition(open);

    const revised = repository.reviseResearchPaperLanePolicy({
      id: lane.id,
      policyVersion: "high-risk-paper-v2",
      policy: {
        positionNavFraction: 0.2,
        maximumPositionUsd: 25,
        maximumOpenPositions: 3,
        maximumDeployedFraction: 0.3,
        minimumLiquidReserveUsd: 10
      },
      effectiveAt: "2026-07-13T12:30:00.000Z"
    });

    expect(revised).toMatchObject({
      id: lane.id,
      status: "ACTIVE",
      policyVersion: "high-risk-paper-v2",
      policy: {
        positionNavFraction: 0.2,
        maximumPositionUsd: 25,
        effectiveAt: "2026-07-13T12:30:00.000Z"
      }
    });
    expect(revised.policy.revisionHistory).toEqual([
      expect.objectContaining({
        policyVersion: "high-risk-paper-v1",
        effectiveFrom: "2026-07-13T12:00:00.000Z",
        effectiveUntil: "2026-07-13T12:30:00.000Z"
      })
    ]);
    expect(repository.getResearchPaperPosition(open.id)).toEqual(open);
    expect(repository.listAudit(10).filter((event) =>
      event.eventType === "research_paper_sizing_revised"
    )).toHaveLength(1);
    repository.reviseResearchPaperLanePolicy({
      id: lane.id,
      policyVersion: "high-risk-paper-v2",
      policy: {
        positionNavFraction: 0.2,
        maximumPositionUsd: 25,
        maximumOpenPositions: 3,
        maximumDeployedFraction: 0.3,
        minimumLiquidReserveUsd: 10
      },
      effectiveAt: "2026-07-13T12:31:00.000Z"
    });
    expect(repository.listAudit(10).filter((event) =>
      event.eventType === "research_paper_sizing_revised"
    )).toHaveLength(1);
    expect(() => repository.reviseResearchPaperLanePolicy({
      id: lane.id,
      policyVersion: "high-risk-paper-v3",
      policy: { positionNavFraction: 0.25 },
      effectiveAt: "2026-07-13T12:29:59.000Z"
    })).toThrow("cannot be backdated");
  });

  it("claims and commits research state once without touching strict trading ledgers", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const lane = repository.createResearchPaperLane({ id: "research-v1", policyVersion: "high-risk-v1" });
    const account = repository.initializeResearchPaperLeader("leader-a", lane.id);
    const observed = source("leader-a", "research-source-a");
    repository.insertSourceEvent(observed);
    const claim: ResearchPaperEvent = {
      eventKey: "research-event-a",
      laneId: lane.id,
      wallet: observed.sourceWallet,
      kind: "SIGNAL",
      outcome: "CLAIMED",
      observedAt: observed.detectedAt,
      sourceSignature: observed.sourceSignature,
      mint: observed.targetMint,
      action: "BUY",
      strictReasonCodes: ["TOKEN_INELIGIBLE"]
    };
    expect(repository.claimResearchPaperEvent(claim)).toBe(true);
    expect(repository.claimResearchPaperEvent(claim)).toBe(false);

    const lot = position(observed.sourceWallet, observed.sourceSignature);
    const terminal: ResearchPaperEvent = {
      ...claim,
      outcome: "SIMULATED",
      reason: "Research-only quote remained executable.",
      finalizedAt: "2026-07-13T12:00:03.000Z"
    };
    expect(repository.commitResearchPaperEvent({
      event: terminal,
      account: {
        ...account,
        cashUsd: 126.9,
        navUsd: 140.8,
        unrealizedPnlUsd: -0.2,
        openPositions: 1,
        updatedAt: terminal.finalizedAt!
      },
      positions: [lot]
    })).toBe(true);
    expect(repository.commitResearchPaperEvent({ event: terminal, account, positions: [lot] })).toBe(false);

    expect(repository.getResearchPaperEvent(claim.eventKey)?.outcome).toBe("SIMULATED");
    expect(repository.listResearchPaperPositions({ laneId: lane.id, openOnly: true })).toEqual([lot]);
    expect(repository.researchPaperDashboard()).toMatchObject({
      label: RESEARCH_PAPER_LABEL,
      promotionEligible: false,
      executionEnabled: false,
      lane: { id: lane.id },
      leaders: [expect.objectContaining({ wallet: "leader-a", navUsd: 140.8 })],
      positions: [expect.objectContaining({ id: lot.id })],
      recentSignals: [expect.objectContaining({ eventKey: claim.eventKey, outcome: "SIMULATED" })]
    });
    for (const table of ["signal_decisions", "executions", "positions", "portfolio_snapshots", "closed_trades"]) {
      expect(repository.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    }
  });

  it("keeps same-mint positions separate per leader and exposes bounded research trades", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const lane = repository.createResearchPaperLane({ id: "research-v1", policyVersion: "high-risk-v1" });
    repository.initializeResearchPaperLeaders(["leader-a", "leader-b"], lane.id);
    for (const wallet of ["leader-a", "leader-b"]) {
      const observed = source(wallet, `source-${wallet}`);
      repository.insertSourceEvent(observed);
      repository.upsertResearchPaperPosition(position(wallet, observed.sourceSignature));
    }
    expect(repository.listResearchPaperPositions({ laneId: lane.id, openOnly: true })).toHaveLength(2);

    const exit = source("leader-a", "research-exit-a");
    repository.insertSourceEvent(exit);
    const trade: ResearchPaperTrade = {
      id: "trade-a",
      laneId: lane.id,
      wallet: "leader-a",
      mint: TARGET_MINT,
      positionId: "position-leader-a",
      sourceEntrySignature: "source-leader-a",
      sourceExitSignature: exit.sourceSignature,
      openedAt: "2026-07-13T12:00:02.000Z",
      closedAt: "2026-07-13T13:00:00.000Z",
      proceedsUsd: 16,
      costBasisUsd: 14.1,
      modeledCostsUsd: 0.2,
      pnlUsd: 1.7
    };
    const claimed: ResearchPaperEvent = {
      eventKey: "trade-event-a",
      laneId: lane.id,
      wallet: trade.wallet,
      kind: "TRADE",
      outcome: "CLAIMED",
      observedAt: trade.closedAt,
      sourceSignature: trade.sourceExitSignature!,
      mint: trade.mint,
      action: "SELL"
    };
    expect(repository.claimResearchPaperEvent(claimed)).toBe(true);
    expect(repository.finalizeResearchPaperEvent({
      ...claimed,
      outcome: "SIMULATED",
      trade,
      finalizedAt: trade.closedAt
    })).toBe(true);
    const dashboard = repository.researchPaperDashboard(undefined, 1);
    expect(dashboard.recentTrades).toEqual([trade]);
    expect(dashboard.performanceEvidence).toMatchObject({
      status: "RECONCILIATION_DEPENDENT",
      reconciliationDependentAccountCount: 1,
      leaderEvidence: [{
        wallet: "leader-a",
        recordedClosedTradePnlUsd: 1.7,
        nonTradeItemizedRealizedPnlUsd: -1.7
      }]
    });
    expect(repository.listResearchPaperEvents({ laneId: lane.id, limit: 0 })).toEqual([]);
  });

  it("rolls event finalization and account changes back when a position write fails", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const lane = repository.createResearchPaperLane({ id: "research-v1", policyVersion: "high-risk-v1" });
    const account = repository.initializeResearchPaperLeader("leader-a", lane.id);
    const first = source("leader-a", "research-first-source");
    repository.insertSourceEvent(first);
    repository.upsertResearchPaperPosition(position(first.sourceWallet, first.sourceSignature, "existing-position"));

    const second = source("leader-a", "research-second-source");
    repository.insertSourceEvent(second);
    const claim: ResearchPaperEvent = {
      eventKey: "research-conflicting-event",
      laneId: lane.id,
      wallet: second.sourceWallet,
      kind: "SIGNAL",
      outcome: "CLAIMED",
      observedAt: second.detectedAt,
      sourceSignature: second.sourceSignature,
      mint: second.targetMint,
      action: "BUY"
    };
    expect(repository.claimResearchPaperEvent(claim)).toBe(true);
    expect(() => repository.commitResearchPaperEvent({
      event: { ...claim, outcome: "SIMULATED", finalizedAt: "2026-07-13T12:01:00.000Z" },
      account: { ...account, cashUsd: 120, navUsd: 140, openPositions: 2 },
      positions: [position(second.sourceWallet, second.sourceSignature, "conflicting-position")]
    })).toThrow();

    expect(repository.getResearchPaperEvent(claim.eventKey)?.outcome).toBe("CLAIMED");
    expect(repository.getResearchPaperLeader(lane.id, account.wallet)).toEqual(account);
    expect(repository.listResearchPaperPositions({ laneId: lane.id, openOnly: true }))
      .toEqual([expect.objectContaining({ id: "existing-position" })]);
  });
});
