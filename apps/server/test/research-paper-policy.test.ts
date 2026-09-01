import { describe, expect, it } from "vitest";
import { DEFAULT_RISK_POLICY, type QuoteSnapshot } from "@copylab/shared";
import {
  LARGER_RESEARCH_PAPER_SIZING_POLICY,
  researchPaperEntrySize,
  researchPaperExitPlan,
  researchPaperModeledQuoteCostUsd,
  researchPaperQuoteUsable,
  researchPaperSizingPolicy
} from "../src/research-paper-policy.js";

const quote = (overrides: Partial<QuoteSnapshot> = {}): QuoteSnapshot => ({
  requestId: "research-quote",
  quotedAt: "2026-07-13T12:00:00.000Z",
  inputMint: "input",
  outputMint: "output",
  inputAmountAtomic: "5000000",
  outputAmountAtomic: "1000000",
  inputUsd: 5,
  outputUsd: 4.9,
  priceImpactPercent: 42,
  slippageBps: 5_000,
  feeBps: 100,
  signatureFeeLamports: 5_000,
  prioritizationFeeLamports: 10_000,
  rentFeeLamports: 0,
  minimumOutputAtomic: "1",
  router: "research",
  expiresAt: "2026-07-13T12:01:00.000Z",
  ...overrides
});

describe("high-risk paper research policy", () => {
  it("preserves legacy sizing for an unrevised research lane", () => {
    expect(researchPaperEntrySize({
      navUsd: 141,
      cashUsd: 141,
      deployedUsd: 0,
      openPositions: 0
    })).toEqual({
      allowed: true,
      sizeUsd: Math.min(
        DEFAULT_RISK_POLICY.maxPositionUsd,
        141 * DEFAULT_RISK_POLICY.positionNavFraction
      )
    });
  });

  it("targets $25 only for the revised high-risk PAPER policy", () => {
    expect(researchPaperEntrySize({
      navUsd: 141,
      cashUsd: 141,
      deployedUsd: 0,
      openPositions: 0
    }, LARGER_RESEARCH_PAPER_SIZING_POLICY)).toEqual({
      allowed: true,
      sizeUsd: 25
    });
    expect(researchPaperEntrySize({
      navUsd: 100,
      cashUsd: 100,
      deployedUsd: 0,
      openPositions: 0
    }, LARGER_RESEARCH_PAPER_SIZING_POLICY)).toEqual({
      allowed: true,
      sizeUsd: 20
    });
  });

  it("fails closed when a persisted research policy is incomplete", () => {
    expect(researchPaperSizingPolicy({ positionNavFraction: 0.2 })).toBeUndefined();
    expect(researchPaperEntrySize({
      navUsd: 141,
      cashUsd: 141,
      deployedUsd: 0,
      openPositions: 0
    }, undefined)).toMatchObject({ allowed: false, reason: "INVALID_POLICY" });
  });

  it("retains the strict position, deployment, and reserve boundaries", () => {
    expect(researchPaperEntrySize({
      navUsd: 141,
      cashUsd: 141,
      deployedUsd: 15,
      openPositions: DEFAULT_RISK_POLICY.maxOpenPositions
    })).toMatchObject({ allowed: false, reason: "MAX_POSITIONS" });
    expect(researchPaperEntrySize({
      navUsd: 20,
      cashUsd: 10,
      deployedUsd: 0,
      openPositions: 1
    })).toMatchObject({ allowed: false, reason: "INSUFFICIENT_RESERVE" });
    expect(researchPaperEntrySize({
      navUsd: 141,
      cashUsd: 141,
      deployedUsd: 17.3,
      openPositions: 1
    }, LARGER_RESEARCH_PAPER_SIZING_POLICY)).toMatchObject({ allowed: true, sizeUsd: 25 });
    expect(researchPaperEntrySize({
      navUsd: 141,
      cashUsd: 141,
      deployedUsd: 17.3001,
      openPositions: 1
    }, LARGER_RESEARCH_PAPER_SIZING_POLICY)).toMatchObject({ allowed: false, reason: "MAX_DEPLOYED" });
  });

  it("models fees even when price impact and slippage are intentionally unrestricted", () => {
    expect(researchPaperQuoteUsable(quote(), new Date("2026-07-13T12:00:04.000Z"))).toBe(true);
    expect(researchPaperModeledQuoteCostUsd(quote(), 200)).toBeCloseTo(0.053, 8);
    expect(researchPaperQuoteUsable(
      quote({ expiresAt: "2026-07-13T12:00:20.000Z" }),
      new Date("2026-07-13T12:00:30.000Z")
    )).toBe(false);
  });

  it("mirrors partial exits and forces a full close at 90% cumulative leader selling", () => {
    expect(researchPaperExitPlan({
      followerRemainingAtomic: "1000",
      leaderInitialAtomic: "1000",
      leaderRemainingAtomic: "1000",
      sourceSellAtomic: "250"
    })).toEqual({
      followerSellAtomic: "250",
      nextLeaderRemainingAtomic: "750",
      closesPosition: false
    });
    expect(researchPaperExitPlan({
      followerRemainingAtomic: "750",
      leaderInitialAtomic: "1000",
      leaderRemainingAtomic: "750",
      sourceSellAtomic: "650"
    })).toEqual({
      followerSellAtomic: "750",
      nextLeaderRemainingAtomic: "100",
      closesPosition: true
    });
  });
});
