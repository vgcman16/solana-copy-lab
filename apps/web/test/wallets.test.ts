import { describe, expect, it } from "vitest";
import type { WalletCandidate, WalletScore } from "@copylab/shared";
import { classifyWallet, type WalletRow } from "../src/wallets";

function candidate(overrides: Partial<WalletCandidate> = {}): WalletCandidate {
  return {
    address: "11111111111111111111111111111111",
    cohortId: "cohort-1",
    firstSeenAt: "2026-07-01T00:00:00.000Z",
    lastSeenAt: "2026-07-09T00:00:00.000Z",
    control: false,
    tags: [],
    ...overrides
  };
}

function score(overrides: Partial<WalletScore> = {}): WalletScore {
  return {
    wallet: "11111111111111111111111111111111",
    calculatedAt: "2026-07-09T00:00:00.000Z",
    qualified: false,
    reasons: ["forward evidence pending"],
    historyDays: 90,
    closedEligibleSwaps: 50,
    activeWeeks: 3,
    medianHoldingMinutes: 15,
    topTokenProfitShare: 0.2,
    topThreeProfitShare: 0.4,
    ...overrides
  };
}

describe("wallet cohort lanes", () => {
  it("always identifies a preserved control as a loss-side benchmark", () => {
    const wallet: WalletRow = {
      ...candidate({ control: true }),
      score: score({ qualified: true })
    };

    expect(classifyWallet(wallet)).toEqual({
      key: "control",
      label: "Control / loser",
      detail: "Preserved bias benchmark"
    });
  });

  it("distinguishes qualified and shadow candidates", () => {
    expect(classifyWallet({ ...candidate(), score: score({ qualified: true }) }).key).toBe("qualified");
    expect(classifyWallet({ ...candidate(), score: score({ qualified: false }) }).key).toBe("shadow");
    expect(classifyWallet({
      ...candidate(),
      trackingLane: "SHADOW",
      score: score({ qualified: true })
    })).toMatchObject({ key: "shadow", label: "Shadow queue" });
  });

  it("keeps an unscored candidate in a pending lane", () => {
    expect(classifyWallet(candidate()).key).toBe("pending");
  });
});
