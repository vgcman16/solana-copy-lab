import { describe, expect, it } from "vitest";
import type { PositionLot } from "@copylab/shared";
import { calculateProjectedRoundTripCost, evaluateRisk } from "../src/index.js";
import {
  NOW,
  SOL_MINT,
  TARGET_MINT,
  USDC_MINT,
  exitQuote,
  intent,
  leaderSwap,
  portfolio,
  providerHealth,
  quote,
  token
} from "./fixtures.js";

function evaluate(overrides: Partial<Parameters<typeof evaluateRisk>[0]> = {}) {
  return evaluateRisk({
    now: NOW,
    mode: "PAPER",
    intent: intent(),
    token: token(),
    entryQuote: quote(),
    exitQuote: exitQuote(),
    followerPriceUsd: 1.005,
    solPriceUsd: 200,
    portfolio: portfolio(),
    positions: [],
    providerHealth: [providerHealth()],
    ...overrides
  });
}

function position(mint = TARGET_MINT): PositionLot {
  return {
    id: `position-${mint}`,
    mode: "PAPER",
    sourceWallet: "wallet",
    sourceEntrySignature: "sig",
    mint,
    openedAt: "2026-02-14T00:00:00.000Z",
    entryAmountAtomic: "100",
    remainingAmountAtomic: "100",
    entryCostUsd: 5,
    remainingCostUsd: 5,
    lastExecutableValueUsd: 5,
    pendingExitFraction: 0,
    status: "OPEN"
  };
}

describe("risk engine", () => {
  it("allows a safe $5 entry and returns auditable cost/divergence metrics", () => {
    const decision = evaluate();
    expect(decision.allowed).toBe(true);
    expect(decision.code).toBe("ALLOWED");
    expect(decision.positionSizeUsd).toBe(5);
    expect(decision.followerPriceDivergencePercent).toBeCloseTo(0.5);
    expect(decision.projectedRoundTripCostPercent).toBeCloseTo(0.44);
  });

  it("compounds position sizing with NAV while retaining the absolute ceiling", () => {
    expect(
      evaluate({ portfolio: portfolio({ navUsd: 141, liquidReserveUsd: 141 }) }).positionSizeUsd
    ).toBeCloseTo(14.1);
    expect(evaluate({ portfolio: portfolio({ navUsd: 120, liquidReserveUsd: 120 }) }).positionSizeUsd).toBe(12);
    expect(evaluate({ portfolio: portfolio({ navUsd: 400, liquidReserveUsd: 400 }) }).positionSizeUsd).toBe(25);
  });

  it("treats exact age and impact boundaries as allowed", () => {
    const decision = evaluate({
      intent: intent({ sourceSwap: leaderSwap({ blockTime: "2026-02-15T11:59:40.000Z" }) }),
      entryQuote: quote({ quotedAt: "2026-02-15T11:59:55.000Z", priceImpactPercent: 0.5 }),
      exitQuote: exitQuote({ quotedAt: "2026-02-15T11:59:55.000Z", priceImpactPercent: 0.5 }),
      followerPriceUsd: 1.01
    });
    expect(decision.allowed).toBe(true);
  });

  it("rejects recovered, stale, duplicate, and mismatched signals", () => {
    const riskyIntent = intent({
      idempotencyKey: "duplicate",
      sourceSwap: leaderSwap({ recovered: true, blockTime: "2026-02-15T11:00:00.000Z" })
    });
    const decision = evaluate({
      intent: riskyIntent,
      entryQuote: quote({ inputAmountAtomic: "1" }),
      seenIdempotencyKeys: new Set(["duplicate"])
    });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("DUPLICATE_SIGNAL");
    expect(decision.reasons).toEqual(expect.arrayContaining([
      "signal was already handled",
      "recovered signals are analysis-only",
      "source signal is older than 20 seconds",
      "entry quote does not match the copy intent"
    ]));
  });

  it("enforces token, quote, position, deployment, reserve, and stop controls", () => {
    const positions = [position(), position("mint-2"), position("mint-3")];
    const decision = evaluate({
      token: token({ eligible: false, reasons: ["unsafe"] }),
      exitQuote: undefined,
      followerPriceUsd: 1.02,
      entryQuote: quote({ priceImpactPercent: 0.51 }),
      portfolio: portfolio({ navUsd: 44, peakNavUsd: 50, dayStartNavUsd: 50, deployedUsd: 14, liquidReserveUsd: 14 }),
      positions,
      liveStartNavUsd: 50
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toEqual(expect.arrayContaining([
      "token is ineligible: unsafe",
      "a full-position sell quote is required",
      "follower price is more than 1% from the leader fill",
      "entry price impact exceeds 0.5%",
      "maximum open positions reached",
      "an open position already exists for this mint",
      "entry would breach the SOL or liquid reserve",
      "daily loss pause threshold reached",
      "hard live loss or drawdown threshold reached"
    ]));
  });

  it("matches the operational 10% live-start loss boundary for a $141 NAV", () => {
    const belowBoundary = evaluate({
      mode: "MANUAL_LIVE",
      portfolio: portfolio({ navUsd: 136, peakNavUsd: 141, dayStartNavUsd: 141, liquidReserveUsd: 136 }),
      liveStartNavUsd: 141
    });
    expect(belowBoundary.reasons).not.toContain("hard live loss or drawdown threshold reached");

    const atBoundary = evaluate({
      mode: "MANUAL_LIVE",
      portfolio: portfolio({ navUsd: 126.9, peakNavUsd: 141, dayStartNavUsd: 141, liquidReserveUsd: 126.9 }),
      liveStartNavUsd: 141
    });
    expect(atBoundary.reasons).toContain("hard live loss or drawdown threshold reached");
  });

  it("allows risk-reducing sells despite token ineligibility and entry loss stops", () => {
    const sellIntent = intent({
      side: "SELL",
      sourceSwap: leaderSwap({ side: "SELL" }),
      inputMint: TARGET_MINT,
      outputMint: USDC_MINT,
      inputAmountAtomic: "5000000"
    });
    const decision = evaluate({
      intent: sellIntent,
      token: token({ eligible: false, reasons: ["became unsafe"] }),
      entryQuote: exitQuote(),
      exitQuote: undefined,
      followerPriceUsd: undefined,
      portfolio: portfolio({ navUsd: 40, dayStartNavUsd: 50, peakNavUsd: 50 })
    });
    expect(decision).toMatchObject({ allowed: true, code: "ALLOWED" });
  });

  it("prices impact, slippage, router fees, network fees, and rent", () => {
    const costs = calculateProjectedRoundTripCost(
      quote({ priceImpactPercent: 0.2, slippageBps: 20, feeBps: 5, rentFeeLamports: 10_000 }),
      exitQuote({ priceImpactPercent: 0.3, slippageBps: 30, feeBps: 5, prioritizationFeeLamports: 10_000 }),
      100,
      5
    );
    expect(costs).toMatchObject({ impactPercent: 0.5, slippagePercent: 0.5, routerFeePercent: 0.1 });
    expect(costs.networkAndRentPercent).toBeCloseTo(0.06);
    expect(costs.totalPercent).toBeCloseTo(1.16);
  });

  it("accounts for spending SOL when checking the protected SOL reserve", () => {
    const solIntent = intent({
      sourceSwap: leaderSwap({ baseMint: SOL_MINT }),
      inputMint: SOL_MINT
    });
    const decision = evaluate({
      intent: solIntent,
      entryQuote: quote({ inputMint: SOL_MINT }),
      exitQuote: exitQuote({ outputMint: SOL_MINT })
    });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("INSUFFICIENT_RESERVE");
  });
});
