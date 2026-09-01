import type { WalletHistorySummary, WalletIndexRecord } from "@copylab/shared";
import { describe, expect, it } from "vitest";
import { scoreWalletResearchCandidate } from "../src/wallet-research.js";
import {
  reconcileWalletHistory,
  type ReconcileWalletHistoryOptions
} from "../src/wallet-history-reconciliation.js";

const COMPARED_AT = "2026-07-09T12:00:00.000Z";

function localRecord(overrides: Partial<WalletIndexRecord> = {}): WalletIndexRecord {
  return {
    wallet: "wallet-1",
    firstSeenAt: "2025-01-01T00:00:00.000Z",
    lastSeenAt: "2026-07-09T11:00:00.000Z",
    historyDays: 90,
    transactionCount: 100,
    successfulTransactionCount: 95,
    spotSwapCount: 80,
    eligibleSpotSwapCount: 70,
    closedEligibleSwaps: 50,
    buyCount: 40,
    sellCount: 40,
    activeDays: 20,
    activeWeeks: 3,
    distinctMints: 10,
    medianHoldingMinutes: 15,
    preScreenEligible: true,
    preScreenReasons: [],
    updatedAt: "2026-07-09T11:30:00.000Z",
    ...overrides
  };
}

function providerHistory(overrides: Partial<WalletHistorySummary> = {}): WalletHistorySummary {
  return {
    wallet: "wallet-1",
    historyDays: 90,
    closedEligibleSwaps: 50,
    activeWeeks: 3,
    medianHoldingMinutes: 15,
    topTokenProfitShare: 0.25,
    topThreeProfitShare: 0.5,
    tags: [],
    ...overrides
  };
}

function options(overrides: Partial<ReconcileWalletHistoryOptions> = {}): ReconcileWalletHistoryOptions {
  return {
    wallet: "wallet-1",
    cohortId: "cohort-1",
    comparedAt: COMPARED_AT,
    providerHistory: providerHistory(),
    localRecord: localRecord(),
    ...overrides
  };
}

describe("wallet history data-quality reconciliation", () => {
  it("records provider evidence without pretending a provider-only wallet was compared", () => {
    const snapshot = reconcileWalletHistory(options({ localRecord: undefined }));

    expect(snapshot).toMatchObject({
      id: `cohort-1:wallet-1:${COMPARED_AT}`,
      status: "LOCAL_UNAVAILABLE",
      comparableMetrics: 0,
      mismatchMetrics: [],
      unavailableMetrics: [
        "historyDays",
        "closedEligibleSwaps",
        "activeWeeks",
        "medianHoldingMinutes",
        "topTokenProfitShare",
        "topThreeProfitShare"
      ],
      agreementRate: 0
    });
    expect(snapshot.comparisons.every((comparison) => !comparison.comparable)).toBe(true);
    expect(snapshot.providerHistory).toEqual(providerHistory());
  });

  it("accepts bounded numeric drift and leaves unavailable local concentration fields unclaimed", () => {
    const snapshot = reconcileWalletHistory(options({
      localRecord: localRecord({
        historyDays: 84,
        closedEligibleSwaps: 42,
        activeWeeks: 2,
        medianHoldingMinutes: 18
      })
    }));

    expect(snapshot.status).toBe("PARTIAL");
    expect(snapshot.comparableMetrics).toBe(4);
    expect(snapshot.mismatchMetrics).toEqual([]);
    expect(snapshot.comparisons.filter((comparison) => !comparison.comparable).map((comparison) => comparison.metric))
      .toEqual(["topTokenProfitShare", "topThreeProfitShare"]);
    expect(snapshot.tags.comparable).toBe(false);
    expect(snapshot.agreementRate).toBe(1);
    expect(snapshot.limitations).toHaveLength(3);
    expect(snapshot.limitations).toContain(
      "Local profit concentration was not fully comparable because pricing coverage was unknown."
    );
  });

  it("claims full consistency only when every numeric field and tags are comparable", () => {
    const snapshot = reconcileWalletHistory(options({
      localRecord: localRecord({
        topTokenProfitShare: 0.25,
        topThreeProfitShare: 0.5,
        profitPricingCoverage: "COMPLETE",
        tags: []
      })
    }));

    expect(snapshot.status).toBe("CONSISTENT");
    expect(snapshot.unavailableMetrics).toEqual([]);
    expect(snapshot.limitations).toEqual([]);
    expect(snapshot.agreementRate).toBe(1);
  });

  it("reports numeric and normalized tag disagreements with an inspectable agreement rate", () => {
    const snapshot = reconcileWalletHistory(options({
      localRecord: localRecord({
        historyDays: 60,
        closedEligibleSwaps: 10,
        activeWeeks: 1,
        medianHoldingMinutes: 2,
        topTokenProfitShare: 0.6,
        topThreeProfitShare: 0.8,
        profitPricingCoverage: "COMPLETE",
        tags: [" Sniper "]
      }),
      providerHistory: providerHistory({ tags: ["insider"] })
    }));

    expect(snapshot.status).toBe("DIVERGENT");
    expect(snapshot.mismatchMetrics).toEqual([
      "historyDays",
      "closedEligibleSwaps",
      "activeWeeks",
      "medianHoldingMinutes",
      "topTokenProfitShare",
      "topThreeProfitShare"
    ]);
    expect(snapshot.tags).toMatchObject({
      comparable: true,
      localTags: ["sniper"],
      providerTags: ["insider"],
      onlyLocal: ["sniper"],
      onlyProvider: ["insider"],
      consistent: false
    });
    expect(snapshot.agreementRate).toBe(0);
    expect(snapshot.reasons).toHaveLength(7);
  });

  it("fails closed on wallet identity mismatches", () => {
    expect(() => reconcileWalletHistory(options({
      providerHistory: providerHistory({ wallet: "other-wallet" })
    }))).toThrow("Provider wallet history does not match");
    expect(() => reconcileWalletHistory(options({
      localRecord: localRecord({ wallet: "other-wallet" })
    }))).toThrow("Local wallet index record does not match");
  });

  it("cannot relax an unchanged qualification decision", () => {
    const history = providerHistory();
    const candidate = {
      address: "wallet-1",
      cohortId: "cohort-1",
      firstSeenAt: "2025-01-01T00:00:00.000Z",
      lastSeenAt: COMPARED_AT,
      control: false,
      tags: [],
      pnl30d: {
        duration: "30d" as const,
        realizedProfitUsd: 100,
        realizedProfitPercent: 10,
        unrealizedProfitUsd: 0,
        totalTrades: 60,
        wins: 40,
        losses: 20
      },
      pnl90d: {
        duration: "90d" as const,
        realizedProfitUsd: 200,
        realizedProfitPercent: 20,
        unrealizedProfitUsd: 0,
        totalTrades: 100,
        wins: 65,
        losses: 35
      }
    };
    const before = scoreWalletResearchCandidate(candidate, history, new Date(COMPARED_AT));
    const diagnostic = reconcileWalletHistory(options({
      localRecord: localRecord({ historyDays: 1, closedEligibleSwaps: 0 })
    }));
    const after = scoreWalletResearchCandidate(candidate, history, new Date(COMPARED_AT));

    expect(diagnostic.status).toBe("DIVERGENT");
    expect(after).toEqual(before);
    expect(after.qualified).toBe(true);
  });
});
