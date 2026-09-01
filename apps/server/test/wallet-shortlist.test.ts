import { qualifyWallet, WALLET_REASON } from "@copylab/core";
import type {
  WalletCandidate,
  WalletHistorySummary,
  WalletIndexRecord,
  WalletPnlWindow
} from "@copylab/shared";
import { describe, expect, it } from "vitest";
import {
  buildWalletResearchShortlist,
  scoreWalletResearchCandidate
} from "../src/wallet-research.js";

const NOW = new Date("2026-07-09T12:00:00.000Z");

function record(wallet: string, overrides: Partial<WalletIndexRecord> = {}): WalletIndexRecord {
  return {
    wallet,
    firstSeenAt: "2025-01-01T00:00:00.000Z",
    lastSeenAt: NOW.toISOString(),
    historyDays: 90,
    transactionCount: 100,
    successfulTransactionCount: 100,
    spotSwapCount: 100,
    eligibleSpotSwapCount: 100,
    closedEligibleSwaps: 50,
    buyCount: 50,
    sellCount: 50,
    activeDays: 20,
    activeWeeks: 4,
    distinctMints: 10,
    medianHoldingMinutes: 20,
    preScreenEligible: true,
    preScreenReasons: [],
    deepHistoryStatus: "COMPLETE",
    structuralEligible: true,
    structuralReasons: [],
    updatedAt: NOW.toISOString(),
    ...overrides
  };
}

function pnl(duration: "30d" | "90d"): WalletPnlWindow {
  return {
    duration,
    realizedProfitUsd: 100,
    realizedProfitPercent: 10,
    unrealizedProfitUsd: 0,
    totalTrades: 100,
    wins: 60,
    losses: 40
  };
}

function provider(address: string, overrides: Partial<WalletCandidate> = {}): WalletCandidate {
  return {
    address,
    cohortId: "provider",
    firstSeenAt: NOW.toISOString(),
    lastSeenAt: NOW.toISOString(),
    control: false,
    tags: [],
    ...overrides
  };
}

function history(wallet: string): WalletHistorySummary {
  return {
    wallet,
    historyDays: 90,
    closedEligibleSwaps: 50,
    activeWeeks: 3,
    medianHoldingMinutes: 15,
    topTokenProfitShare: 0.35,
    topThreeProfitShare: 0.6,
    tags: []
  };
}

describe("wallet research shortlist structural admission", () => {
  it("admits only completed deep-history structural survivors", () => {
    const result = buildWalletResearchShortlist({
      cohortId: "cohort-1",
      localRecords: [
        record("ready"),
        record("awaiting", {
          deepHistoryStatus: "AWAITING_HYDRATION",
          structuralEligible: false,
          structuralReasons: ["awaiting local deep history"]
        }),
        record("failed-structure", {
          structuralEligible: false,
          structuralReasons: ["insufficient closed eligible swaps"]
        })
      ],
      providerCandidates: []
    });

    expect(result.candidates.map((candidate) => candidate.address)).toEqual(["ready"]);
    expect(result.localAddresses).toEqual(["ready"]);
  });

  it("preserves provider evidence for overlap without treating local structure as qualification", () => {
    const providerCandidate = provider("ready", {
      pnl30d: pnl("30d"),
      pnl90d: pnl("90d"),
      sourceRank30d: 1
    });
    const result = buildWalletResearchShortlist({
      cohortId: "cohort-1",
      localRecords: [record("ready")],
      providerCandidates: [providerCandidate]
    });
    expect(result.candidates[0]).toMatchObject({
      address: "ready",
      pnl30d: pnl("30d"),
      sourceRank30d: 1
    });

    const localOnly = buildWalletResearchShortlist({
      cohortId: "cohort-1",
      localRecords: [record("local-only")],
      providerCandidates: []
    }).candidates[0]!;
    const score = scoreWalletResearchCandidate(localOnly, history("local-only"), NOW);
    expect(score.qualified).toBe(false);
    expect(score.reasons).toEqual([WALLET_REASON.MISSING_30D_PNL, WALLET_REASON.MISSING_90D_PNL]);
    expect(score).toEqual(qualifyWallet(localOnly, history("local-only"), NOW));
  });
});
