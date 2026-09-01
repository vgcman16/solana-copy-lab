import { describe, expect, it } from "vitest";
import type {
  ResearchPaperLeaderAccount,
  ResearchPaperPosition
} from "@copylab/shared";
import { summarizeResearchPaperPerformance } from "../src/research-paper-performance.js";

const NOW = "2026-09-01T12:00:00.000Z";

function leader(wallet: string, navUsd: number, realizedPnlUsd = navUsd - 141): ResearchPaperLeaderAccount {
  return {
    laneId: "research-lane",
    wallet,
    initialNavUsd: 141,
    cashUsd: navUsd,
    navUsd,
    peakNavUsd: Math.max(141, navUsd),
    realizedPnlUsd,
    unrealizedPnlUsd: navUsd - 141 - realizedPnlUsd,
    maxDrawdownPercent: 0,
    openPositions: 0,
    completedTrades: realizedPnlUsd === 0 ? 0 : 1,
    pricingComplete: true,
    updatedAt: NOW
  };
}

describe("research PAPER performance evidence", () => {
  it("keeps raw ledger history while exposing the ex-outlier loss and non-itemized gain", () => {
    const evidence = summarizeResearchPaperPerformance({
      leaders: [
        leader("ARW-outlier", 469.22, 328.22),
        leader("flat", 141, 0),
        leader("loser", 138, -3)
      ],
      positions: [],
      exitLedger: [{
        wallet: "ARW-outlier",
        recordedClosedTradePnlUsd: 42.83,
        proportionalExitCount: 3,
        balanceReconciledTradeCount: 1
      }, {
        wallet: "loser",
        recordedClosedTradePnlUsd: -3,
        proportionalExitCount: 0,
        balanceReconciledTradeCount: 0
      }],
      capturedAt: NOW
    });

    expect(evidence).toMatchObject({
      status: "RECONCILIATION_DEPENDENT",
      accountCount: 3,
      reconciliationDependentAccountCount: 1,
      medianAccountPnlUsd: 0,
      exOutlierAccountCount: 2,
      exOutlierInitialNavUsd: 141,
      exOutlierNormalizedNavUsd: 139.5,
      exOutlierNormalizedPnlUsd: -1.5,
      largestOutlierWallet: "ARW-outlier",
      largestOutlierPnlUsd: 328.22
    });
    expect(evidence.leaderEvidence[0]).toMatchObject({
      status: "RECONCILIATION_DEPENDENT",
      recordedClosedTradePnlUsd: 42.83,
      proportionalExitCount: 3,
      balanceReconciledTradeCount: 1
    });
    expect(evidence.leaderEvidence[0]!.nonTradeItemizedRealizedPnlUsd).toBeCloseTo(285.39, 8);
  });

  it("fails the performance status to incomplete and counts an old unpriced position", () => {
    const incomplete = { ...leader("unpriced", 116, 0), pricingComplete: false, openPositions: 1 };
    const position: ResearchPaperPosition = {
      id: "old-unpriced",
      laneId: "research-lane",
      wallet: incomplete.wallet,
      mint: "mint",
      sourceEntrySignature: "signature",
      openedAt: "2026-07-14T12:00:00.000Z",
      simulatedInitialAtomic: "100",
      simulatedRemainingAtomic: "100",
      leaderInitialAtomic: "100",
      leaderRemainingAtomic: "100",
      entryCostUsd: 25,
      remainingCostUsd: 25,
      lastExecutableValueUsd: 0,
      pendingExitFraction: 0,
      status: "UNPRICED",
      updatedAt: NOW
    };

    expect(summarizeResearchPaperPerformance({
      leaders: [incomplete],
      positions: [position],
      exitLedger: [],
      capturedAt: NOW
    })).toMatchObject({
      status: "PRICING_INCOMPLETE",
      pricingIncompleteAccountCount: 1,
      unpricedPositionCount: 1,
      staleUnpricedPositionCount: 1
    });
  });
});
