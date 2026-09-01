import { describe, expect, it } from "vitest";
import { evaluateTokenPolicy, qualifyWallet, TOKEN_REASON, WALLET_REASON } from "../src/index.js";
import { NOW, TOKEN_PROGRAM_ID, token, walletCandidate, walletHistory } from "./fixtures.js";

describe("wallet qualification", () => {
  it("qualifies exact policy boundaries deterministically", () => {
    const score = qualifyWallet(walletCandidate(), walletHistory(), NOW);
    expect(score).toMatchObject({ qualified: true, reasons: [], historyDays: 90, closedEligibleSwaps: 50 });
    expect(score.calculatedAt).toBe(NOW.toISOString());
  });

  it("normalizes disallowed tags and reports every failed criterion", () => {
    const score = qualifyWallet(
      walletCandidate({
        tags: [" Sniper "],
        pnl30d: { ...walletCandidate().pnl30d!, realizedProfitUsd: 0 },
        pnl90d: undefined
      }),
      walletHistory({
        historyDays: 89,
        closedEligibleSwaps: 49,
        activeWeeks: 2,
        medianHoldingMinutes: 14.99,
        topTokenProfitShare: 0.351,
        topThreeProfitShare: 0.601
      }),
      NOW
    );
    expect(score.qualified).toBe(false);
    expect(score.reasons).toEqual(expect.arrayContaining([
      WALLET_REASON.NON_POSITIVE_30D_PNL,
      WALLET_REASON.MISSING_90D_PNL,
      WALLET_REASON.INSUFFICIENT_HISTORY,
      WALLET_REASON.INSUFFICIENT_SWAPS,
      WALLET_REASON.INSUFFICIENT_ACTIVE_WEEKS,
      WALLET_REASON.HOLDING_TIME_TOO_SHORT,
      WALLET_REASON.TOP_TOKEN_CONCENTRATION,
      WALLET_REASON.TOP_THREE_CONCENTRATION,
      `${WALLET_REASON.DISALLOWED_TAG}: sniper`
    ]));
  });
});

describe("token policy", () => {
  it("accepts exact numeric boundaries and a token exactly 30 days old", () => {
    const evaluated = evaluateTokenPolicy(
      token({ firstPoolAt: "2026-01-16T12:00:00.000Z", tokenProgram: TOKEN_PROGRAM_ID }),
      NOW
    );
    expect(evaluated.eligible).toBe(true);
    expect(evaluated.reasons).toEqual([]);
  });

  it("recomputes provider claims and rejects every unsafe property including Token-2022", () => {
    const evaluated = evaluateTokenPolicy(token({
      eligible: true,
      reasons: [],
      verified: false,
      suspicious: true,
      tokenProgram: "TokenzQdToken2022",
      mintAuthorityDisabled: false,
      freezeAuthorityDisabled: false,
      firstPoolAt: "2026-02-01T00:00:00.000Z",
      liquidityUsd: 4_999_999,
      volume24hUsd: 999_999,
      holderCount: 999,
      organicScore: 69,
      topHoldersPercent: 30.01
    }), NOW);
    expect(evaluated.eligible).toBe(false);
    expect(evaluated.reasons).toEqual(Object.values(TOKEN_REASON).filter((reason) => reason !== TOKEN_REASON.UNKNOWN_AGE));
  });

  it("requires a valid first-pool timestamp", () => {
    expect(evaluateTokenPolicy(token({ firstPoolAt: undefined }), NOW).reasons).toContain(TOKEN_REASON.UNKNOWN_AGE);
  });
});
