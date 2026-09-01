import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  RESEARCH_PAPER_LABEL,
  type ResearchPaperDashboard,
  type ResearchPaperLeaderAccount
} from "@copylab/shared";
import { ResearchPaperPanel } from "../src/components/ResearchPaperPanel";

const NOW = "2026-07-13T12:00:00.000Z";

function leader(wallet: string): ResearchPaperLeaderAccount {
  return {
    laneId: "research-lane",
    wallet,
    initialNavUsd: 141,
    cashUsd: 141,
    navUsd: 141,
    peakNavUsd: 141,
    realizedPnlUsd: 0,
    unrealizedPnlUsd: 0,
    maxDrawdownPercent: 0,
    openPositions: 0,
    completedTrades: 0,
    pricingComplete: true,
    updatedAt: NOW
  };
}

function dashboard(status: "ACTIVE" | "PAUSED" = "ACTIVE"): ResearchPaperDashboard {
  return {
    label: RESEARCH_PAPER_LABEL,
    promotionEligible: false,
    executionEnabled: false,
    lane: {
      id: "research-lane",
      label: RESEARCH_PAPER_LABEL,
      purpose: "RESEARCH_ONLY",
      policyVersion: "research-v1",
      policy: {},
      initialNavPerLeaderUsd: 141,
      status,
      startedAt: NOW,
      updatedAt: NOW
    },
    leaders: [leader("A".repeat(44)), leader("B".repeat(44)), leader("C".repeat(44))],
    positions: [],
    recentSignals: [],
    recentTrades: [],
    updatedAt: NOW
  };
}

function dashboardWithWatchlist(status: "ACTIVE" | "PAUSED" = "ACTIVE"): ResearchPaperDashboard {
  return {
    ...dashboard(status),
    watchlist: {
      latestRun: {
        id: "watchlist-run",
        laneId: "research-lane",
        policy: {
          targetWalletCount: 25,
          providerSnapshotMaxAgeDays: 7,
          activityWindowDays: 30,
          minimumRecentTrades: 25,
          localActivityLookbackDays: 7
        },
        eligibleCandidateCount: 18,
        preexistingLeaderCount: 3,
        newlyEnrolledCount: 12,
        totalLeaderCount: 15,
        strictLeaderCount: 3,
        strictOverlapCount: 2,
        researchOnlyMonitoredCount: 12,
        remainingCapacity: 10,
        selectedAt: NOW
      },
      members: []
    }
  };
}

function renderResearch(research: ResearchPaperDashboard): string {
  return renderToStaticMarkup(createElement(ResearchPaperPanel, {
    research,
    strictNavUsd: 141,
    csrfToken: "csrf-value",
    onRefresh: async () => undefined,
    notify: () => undefined
  }));
}

describe("isolated high-risk research paper panel", () => {
  it("makes the hard research-only boundaries prominent", () => {
    const html = renderResearch(dashboard());

    expect(html).toContain(RESEARCH_PAPER_LABEL);
    expect(html).toContain("separate simulated research ledger");
    expect(html).toContain("cannot unlock Manual Live or Auto Live");
    expect(html).toContain("Execution disabled");
    expect(html).toContain("Promotion ineligible");
    expect(html).toContain("Pause research paper");
  });

  it("renders three independent $141 accounts without a pooled total", () => {
    const html = renderResearch(dashboard());

    expect(html.match(/Starting account/g)).toHaveLength(3);
    expect(html.match(/Not pooled/g)).toHaveLength(3);
    expect(html).toContain(`${"A".repeat(6)}…${"A".repeat(6)}`);
    expect(html).toContain(`${"B".repeat(6)}…${"B".repeat(6)}`);
    expect(html).toContain(`${"C".repeat(6)}…${"C".repeat(6)}`);
    expect(html).not.toContain("$423.00");
    expect(html).not.toContain("total NAV");
  });

  it("offers enable when the isolated lane is paused", () => {
    expect(renderResearch(dashboard("PAUSED"))).toContain("Enable research paper");
  });

  it("shows the requested, active, and enrolled wallet funnel without treating holders as traders", () => {
    const html = renderResearch(dashboardWithWatchlist());

    expect(html).toContain("Active-trader watchlist");
    expect(html).toContain("Scanning active traders");
    expect(html).toContain("Requested");
    expect(html).toContain("Eligible active traders");
    expect(html).toContain("Enrolled");
    expect(html).toContain("holding-only wallets are excluded");
    expect(html).toContain("Research-only additions need at least 25 completed trades inside the last 30 days");
    expect(html).toContain("Local exact activity from the last 7 days is ranked first");
    expect(html).toContain("Strict baseline");
    expect(html).toContain("Strict baseline</span><strong>3</strong>");
    expect(html).toContain("Original safety accounts preserved");
    expect(html).toContain("Minimum completed trades");
    expect(html).toContain("provider proof ≤7d old");
    expect(html).toContain("15 of 25 requested wallets enrolled");
    expect(html).toContain("Research-only");
    expect(html).toContain("$141.00 simulation");
  });

  it("keeps rendering safely before a local server publishes watchlist evidence", () => {
    const html = renderResearch(dashboard());

    expect(html).toContain("Waiting for watchlist status");
    expect(html).toContain("holding-only wallets are excluded");
    expect(html).toContain("The original strict baseline stays preserved");
    expect(html).toContain("Awaiting server refresh evidence");
    expect(html).toContain("3 of — requested wallets enrolled");
  });

  it("shows durable unpriced exit-quote retry timing without implying a fill", () => {
    const research = dashboard();
    research.leaders[0] = {
      ...research.leaders[0]!,
      cashUsd: 116,
      navUsd: 116,
      openPositions: 1,
      pricingComplete: false
    };
    research.positions = [{
      id: "unpriced-position",
      laneId: "research-lane",
      wallet: research.leaders[0]!.wallet,
      mint: "RetryMint111111111111111111111111111111111",
      sourceEntrySignature: "research-entry-signature",
      openedAt: NOW,
      simulatedInitialAtomic: "1000000",
      simulatedRemainingAtomic: "1000000",
      leaderInitialAtomic: "1000000",
      leaderRemainingAtomic: "1000000",
      entryCostUsd: 25,
      remainingCostUsd: 25,
      lastExecutableValueUsd: 0,
      pendingExitFraction: 0,
      status: "UNPRICED",
      exitQuoteFailureCount: 2,
      lastExitQuoteAttemptAt: "2026-07-13T12:10:00.000Z",
      nextExitQuoteRetryAt: "2026-07-13T12:20:00.000Z",
      lastExitQuoteFailureCode: "JUPITER_EXIT_QUOTE_UNAVAILABLE",
      updatedAt: "2026-07-13T12:10:00.000Z"
    }];

    const html = renderResearch(research);
    expect(html).toContain("Exit quote retry");
    expect(html).toContain("Quote service unavailable · 2 attempts");
    expect(html).toContain("Last ");
    expect(html).toContain(" · next ");
    expect(html).toContain("Unpriced");
    expect(html).not.toContain("$0.00</td><td><span class=\"research-exit-retry\"");
  });

  it("labels a structurally non-routable exit separately from provider downtime", () => {
    const research = dashboard();
    research.leaders[0] = {
      ...research.leaders[0]!,
      cashUsd: 116,
      navUsd: 116,
      openPositions: 1,
      pricingComplete: false
    };
    research.positions = [{
      id: "no-route-position",
      laneId: "research-lane",
      wallet: research.leaders[0]!.wallet,
      mint: "NoRouteMint1111111111111111111111111111111",
      sourceEntrySignature: "research-entry-signature",
      openedAt: NOW,
      simulatedInitialAtomic: "1000000",
      simulatedRemainingAtomic: "1000000",
      leaderInitialAtomic: "1000000",
      leaderRemainingAtomic: "1000000",
      entryCostUsd: 25,
      remainingCostUsd: 25,
      lastExecutableValueUsd: 0,
      pendingExitFraction: 0,
      status: "UNPRICED",
      exitQuoteFailureCount: 4,
      lastExitQuoteAttemptAt: "2026-07-13T12:10:00.000Z",
      nextExitQuoteRetryAt: "2026-07-13T12:50:00.000Z",
      lastExitQuoteFailureCode: "JUPITER_EXIT_NO_ROUTE",
      updatedAt: "2026-07-13T12:10:00.000Z"
    }];

    const html = renderResearch(research);
    expect(html).toContain("No exit route · 4 attempts");
    expect(html).not.toContain("Quote service unavailable");
  });

  it("shows robust, reconciliation-dependent performance instead of silently trusting an outlier", () => {
    const research = dashboard();
    research.leaders[0] = {
      ...research.leaders[0]!,
      cashUsd: 469.22,
      navUsd: 469.22,
      peakNavUsd: 525,
      realizedPnlUsd: 328.22,
      completedTrades: 1
    };
    research.performanceEvidence = {
      status: "RECONCILIATION_DEPENDENT",
      accountCount: 3,
      pricingIncompleteAccountCount: 0,
      unpricedPositionCount: 0,
      staleUnpricedPositionCount: 0,
      reconciliationDependentAccountCount: 1,
      medianAccountPnlUsd: 0,
      exOutlierAccountCount: 2,
      exOutlierInitialNavUsd: 141,
      exOutlierNormalizedNavUsd: 141,
      exOutlierNormalizedPnlUsd: 0,
      exOutlierNetReturnPercent: 0,
      largestOutlierWallet: research.leaders[0]!.wallet,
      largestOutlierPnlUsd: 328.22,
      leaderEvidence: [{
        wallet: research.leaders[0]!.wallet,
        status: "RECONCILIATION_DEPENDENT",
        recordedClosedTradePnlUsd: 42.83,
        nonTradeItemizedRealizedPnlUsd: 285.39,
        proportionalExitCount: 3,
        balanceReconciledTradeCount: 1
      }],
      disclosure: "Legacy proportional exits are not fully itemized."
    };

    const html = renderResearch(research);
    expect(html).toContain("Performance evidence · Reconciliation Dependent");
    expect(html).toContain("Robust result excludes the single largest absolute-P&amp;L account");
    expect(html).toContain("Ex-outlier NAV");
    expect(html).toContain("Legacy proportional exits are not fully itemized.");
    expect(html).toContain("+$285.39 gap");
    expect(html).toContain("3 proportional · 1 balance-reconciled exits");
  });
});
