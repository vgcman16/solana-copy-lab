import { describe, expect, it } from "vitest";
import {
  AUTONOMOUS_PAPER_LEARNING_CONTEXT_VERSION,
  AUTONOMOUS_PAPER_LEARNING_CONTEXT_V2_VERSION,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  type AutonomousPaperAccount,
  type AutonomousPaperMarketSnapshot,
  type AutonomousPaperPosition,
  type AutonomousPaperTrade
} from "@copylab/shared";
import {
  AUTONOMOUS_PAPER_POLICY_VERSION,
  AUTONOMOUS_PAPER_V2_POLICY,
  AUTONOMOUS_PAPER_V2_POLICY_VERSION,
  AUTONOMOUS_PAPER_V3_POLICY,
  AUTONOMOUS_PAPER_V3_POLICY_VERSION,
  AUTONOMOUS_PAPER_V4_POLICY,
  AUTONOMOUS_PAPER_V4_POLICY_VERSION,
  AUTONOMOUS_PAPER_V5_POLICY,
  AUTONOMOUS_PAPER_V5_POLICY_VERSION,
  AUTONOMOUS_PAPER_V6_POLICY,
  AUTONOMOUS_PAPER_V6_POLICY_VERSION,
  AUTONOMOUS_PAPER_V7_POLICY,
  AUTONOMOUS_PAPER_V7_POLICY_VERSION,
  AUTONOMOUS_PAPER_V8_POLICY,
  AUTONOMOUS_PAPER_V8_POLICY_VERSION,
  AUTONOMOUS_PAPER_V9_POLICY,
  AUTONOMOUS_PAPER_V9_POLICY_VERSION,
  AUTONOMOUS_PAPER_V12_POLICY,
  AUTONOMOUS_PAPER_V12_POLICY_VERSION,
  DEFAULT_AUTONOMOUS_PAPER_POLICY,
  LEGACY_AUTONOMOUS_PAPER_POLICY,
  LEGACY_AUTONOMOUS_PAPER_POLICY_VERSION,
  autonomousAdaptiveEntrySize,
  autonomousEntrySize,
  autonomousExitDecision,
  autonomousMomentum,
  autonomousPaperLearningContext,
  autonomousStaticAdmission,
  normalizeAutonomousPaperPolicy
} from "../src/autonomous-paper-policy.js";

function market(overrides: Partial<AutonomousPaperMarketSnapshot> = {}): AutonomousPaperMarketSnapshot {
  return {
    capturedAt: "2026-07-14T12:00:00.000Z",
    sourceUpdatedAt: "2026-07-14T11:59:30.000Z",
    mint: "momentum-mint",
    symbol: "MOMO",
    decimals: 6,
    tokenProgram: TOKEN_PROGRAM_ID,
    verified: true,
    suspicious: false,
    mintAuthorityDisabled: true,
    freezeAuthorityDisabled: true,
    tokenAgeDays: 30,
    priceUsd: 0.5,
    marketCapUsd: 20_000_000,
    fdvUsd: 30_000_000,
    liquidityUsd: 2_000_000,
    liquidityChange1hPercent: 2,
    volume24hUsd: 5_000_000,
    holderCount: 5_000,
    organicScore: 90,
    topHoldersPercent: 20,
    priceChange5mPercent: 4,
    priceChange1hPercent: 14,
    priceChange6hPercent: 20,
    priceChange24hPercent: 30,
    organicBuyShare5m: 0.8,
    organicBuyShare1h: 0.7,
    organicVolume5mUsd: 50_000,
    organicVolume1hUsd: 250_000,
    organicBuyers5m: 200,
    volumeAccelerationRatio: 0.3,
    buySellRatio: 3,
    momentumScore: 0,
    categoryRanks: { topTraded24h: 4, topTrending1h: 7 },
    ...overrides
  };
}

function account(overrides: Partial<AutonomousPaperAccount> = {}): AutonomousPaperAccount {
  return {
    laneId: "autonomous-lane",
    initialNavUsd: 141,
    cashUsd: 141,
    navUsd: 141,
    peakNavUsd: 141,
    deployedUsd: 0,
    realizedPnlUsd: 0,
    unrealizedPnlUsd: 0,
    maxDrawdownPercent: 0,
    openPositions: 0,
    completedTrades: 0,
    winningTrades: 0,
    grossProfitUsd: 0,
    grossLossUsd: 0,
    pricingComplete: true,
    updatedAt: "2026-07-14T12:00:00.000Z",
    ...overrides
  };
}

function position(overrides: Partial<AutonomousPaperPosition> = {}): AutonomousPaperPosition {
  return {
    id: "position-1",
    laneId: "autonomous-lane",
    entryDecisionId: "decision-1",
    mint: "momentum-mint",
    symbol: "MOMO",
    initialAmountAtomic: "1000000",
    remainingAmountAtomic: "1000000",
    entryCostUsd: 28.2,
    remainingCostUsd: 28.2,
    lastExecutableValueUsd: 28.2,
    peakExecutableValueUsd: 28.2,
    entryPriceUsd: 0.5,
    lastPriceUsd: 0.5,
    stopPriceUsd: 0.45,
    takeProfitPriceUsd: 0.65,
    weakMomentumSamples: 0,
    status: "OPEN",
    openedAt: "2026-07-14T10:00:00.000Z",
    updatedAt: "2026-07-14T12:00:00.000Z",
    ...overrides
  };
}

function trade(
  index: number,
  returnPercent: number,
  overrides: Partial<AutonomousPaperTrade> = {}
): AutonomousPaperTrade {
  const closedAt = new Date(Date.UTC(2026, 6, 14, 12, index)).toISOString();
  const costBasisUsd = 20;
  const pnlUsd = costBasisUsd * returnPercent / 100;
  return {
    id: `trade-${index.toString().padStart(3, "0")}`,
    laneId: "autonomous-lane",
    positionId: `position-${index}`,
    entryDecisionId: `entry-${index}`,
    exitDecisionId: `exit-${index}`,
    mint: `mint-${index}`,
    exitReason: returnPercent > 0 ? "TAKE_PROFIT" : "STOP_LOSS",
    openedAt: new Date(Date.UTC(2026, 6, 14, 11, index)).toISOString(),
    closedAt,
    proceedsUsd: costBasisUsd + pnlUsd,
    costBasisUsd,
    modeledCostsUsd: 0.2,
    pnlUsd,
    returnPercent,
    ...overrides
  };
}

describe("autonomous momentum policy", () => {
  it("decodes every archived epoch exactly while current v13 shortens the evidence-backed exit envelope", () => {
    const decodedV1 = normalizeAutonomousPaperPolicy(
      LEGACY_AUTONOMOUS_PAPER_POLICY_VERSION,
      {
        scanIntervalMinutes: 5,
        positionNavFraction: 0.2
      }
    );
    const decodedV2 = normalizeAutonomousPaperPolicy(
      AUTONOMOUS_PAPER_V2_POLICY_VERSION,
      { scanIntervalMinutes: 5, positionNavFraction: 0.25 }
    );
    const decodedV3 = normalizeAutonomousPaperPolicy(
      AUTONOMOUS_PAPER_V3_POLICY_VERSION,
      {}
    );
    const decodedV4 = normalizeAutonomousPaperPolicy(
      AUTONOMOUS_PAPER_V4_POLICY_VERSION,
      {}
    );
    const decodedV5 = normalizeAutonomousPaperPolicy(
      AUTONOMOUS_PAPER_V5_POLICY_VERSION,
      {}
    );
    const decodedV6 = normalizeAutonomousPaperPolicy(
      AUTONOMOUS_PAPER_V6_POLICY_VERSION,
      {}
    );
    const decodedV7 = normalizeAutonomousPaperPolicy(
      AUTONOMOUS_PAPER_V7_POLICY_VERSION,
      {}
    );
    const decodedV8 = normalizeAutonomousPaperPolicy(
      AUTONOMOUS_PAPER_V8_POLICY_VERSION,
      {}
    );
    const decodedV9 = normalizeAutonomousPaperPolicy(
      AUTONOMOUS_PAPER_V9_POLICY_VERSION,
      {}
    );
    const decodedV12 = normalizeAutonomousPaperPolicy(
      AUTONOMOUS_PAPER_V12_POLICY_VERSION,
      {}
    );
    const decodedCurrent = normalizeAutonomousPaperPolicy(
      AUTONOMOUS_PAPER_POLICY_VERSION,
      {}
    );
    const decodedUnknown = normalizeAutonomousPaperPolicy("autonomous-momentum-paper-future", {});

    expect(decodedV1).toEqual(LEGACY_AUTONOMOUS_PAPER_POLICY);
    expect(decodedV2).toEqual(AUTONOMOUS_PAPER_V2_POLICY);
    expect(decodedV3).toEqual(AUTONOMOUS_PAPER_V3_POLICY);
    expect(decodedV4).toEqual(AUTONOMOUS_PAPER_V4_POLICY);
    expect(decodedV5).toEqual(AUTONOMOUS_PAPER_V5_POLICY);
    expect(decodedV6).toEqual(AUTONOMOUS_PAPER_V6_POLICY);
    expect(decodedV7).toEqual(AUTONOMOUS_PAPER_V7_POLICY);
    expect(decodedV8).toEqual(AUTONOMOUS_PAPER_V8_POLICY);
    expect(decodedV9).toEqual(AUTONOMOUS_PAPER_V9_POLICY);
    expect(decodedV12).toEqual(AUTONOMOUS_PAPER_V12_POLICY);
    expect(decodedCurrent).toEqual(DEFAULT_AUTONOMOUS_PAPER_POLICY);
    expect(decodedUnknown).toEqual(LEGACY_AUTONOMOUS_PAPER_POLICY);
    expect(decodedV1.confirmationSamples).toBe(2);
    expect(AUTONOMOUS_PAPER_V2_POLICY).toMatchObject({
      confirmationSamples: 1,
      minimumMomentumScore: 35,
      minimumPriceChange5mPercent: 0.25,
      minimumOrganicBuyers5m: 3
    });
    expect(AUTONOMOUS_PAPER_V3_POLICY).toEqual({
      ...AUTONOMOUS_PAPER_V2_POLICY,
      minimumPriceChange5mPercent: -0.25,
      minimumOrganicBuyers5m: 2
    });
    expect(AUTONOMOUS_PAPER_V4_POLICY).toEqual({
      ...AUTONOMOUS_PAPER_V3_POLICY,
      scanIntervalMinutes: 3,
      allowToken2022: true,
      maximumEntriesPerUtcDay: 8,
      minimumEntrySpacingMinutes: 10,
      positionNavFraction: 0.2,
      maximumDeployedFraction: 0.65,
      minimumAgeDays: 2,
      minimumLiquidityUsd: 150_000,
      minimumVolume24hUsd: 150_000,
      minimumHolderCount: 250,
      minimumOrganicScore: 45,
      maximumTopHoldersPercent: 55,
      minimumMarketCapUsd: 300_000,
      maximumMarketCapUsd: 600_000_000,
      maximumFdvToMarketCap: 5,
      minimumMomentumScore: 30,
      minimumPriceChange5mPercent: -1,
      maximumPriceChange5mPercent: 15,
      minimumPriceChange1hPercent: 0.5,
      maximumPriceChange1hPercent: 35,
      minimumPriceChange6hPercent: -10,
      maximumPriceChange6hPercent: 100,
      maximumPriceChange24hPercent: 200,
      minimumOrganicBuyShare5m: 0.5,
      minimumOrganicBuyShare1h: 0.48,
      minimumOrganicVolume5mUsd: 1_000,
      minimumOrganicVolume1hUsd: 5_000,
      minimumOrganicBuyers5m: 2,
      minimumVolumeAccelerationRatio: 0.01,
      minimumLiquidityChange1hPercent: -7,
      minimumSolPriceChange1hPercent: -5,
      minimumSolPriceChange6hPercent: -12,
      minimumSolRelativeStrength1hPercent: 0,
      maximumPriceImpactPercent: 2,
      maximumRoundTripCostPercent: 3,
      stopLossPercent: 10,
      breakEvenActivationPercent: 4,
      trailingActivationPercent: 8,
      trailingDrawdownPercent: 5,
      takeProfitPercent: 18,
      weakMomentumExitSamples: 3,
      noProgressMinutes: 45,
      maximumHoldingMinutes: 180,
      cooldownMinutes: 60,
      stopCooldownMinutes: 180,
      dailyLossPausePercent: 10,
      maximumDrawdownPercent: 20
    });
    expect(AUTONOMOUS_PAPER_V5_POLICY).toEqual({
      ...AUTONOMOUS_PAPER_V4_POLICY,
      adaptiveSizingEnabled: true,
      minimumPositionUsd: 5,
      adaptiveSizingMinimumTrades: 20,
      adaptiveSizingWindowTrades: 100,
      adaptiveSizingPriorWins: 5,
      adaptiveSizingPriorLosses: 5,
      adaptiveSizingFractionalKelly: 0.5,
      adaptiveSizingMinimumCalibrationMultiplier: 0.25,
      adaptiveSizingMaximumCalibrationMultiplier: 1.25,
      adaptiveSizingMaximumLossStreak: 3,
      adaptiveSizingLossStreakMultiplier: 0.8
    });
    expect(AUTONOMOUS_PAPER_V6_POLICY).toEqual({
      ...AUTONOMOUS_PAPER_V5_POLICY,
      maximumPositionUsd: Number.MAX_SAFE_INTEGER,
      positionNavFraction: 0.35,
      maximumDeployedFraction: 0.80
    });
    expect(AUTONOMOUS_PAPER_V7_POLICY).toEqual({
      ...AUTONOMOUS_PAPER_V6_POLICY,
      contextualRewardEnabled: true
    });
    expect(AUTONOMOUS_PAPER_V8_POLICY).toEqual({
      ...AUTONOMOUS_PAPER_V7_POLICY
    });
    expect(AUTONOMOUS_PAPER_V9_POLICY).toEqual({
      ...AUTONOMOUS_PAPER_V8_POLICY,
      maximumEntriesPerUtcDay: Number.MAX_SAFE_INTEGER
    });
    expect(AUTONOMOUS_PAPER_V12_POLICY).toEqual({
      ...AUTONOMOUS_PAPER_V9_POLICY,
      riskAtStopSizingEnabled: true,
      normalRiskAtStopNavFraction: 0.03,
      highConvictionRiskAtStopNavFraction: 0.04,
      explorationRiskAtStopNavFraction: 0.02,
      maximumDeveloperClusterFraction: 0.45,
      positionNavFraction: 0.4,
      maximumOpenPositions: 4,
      maximumDeployedFraction: 0.9,
      minimumLiquidReserveUsd: 10,
      dailyLossPausePercent: 12,
      maximumDrawdownPercent: 25
    });
    expect(DEFAULT_AUTONOMOUS_PAPER_POLICY).toEqual({
      ...AUTONOMOUS_PAPER_V12_POLICY,
      breakEvenActivationPercent: 2,
      trailingActivationPercent: 3,
      takeProfitPercent: 4,
      maximumHoldingMinutes: 120
    });
    expect(Object.isFrozen(AUTONOMOUS_PAPER_V2_POLICY)).toBe(true);
    expect(Object.isFrozen(AUTONOMOUS_PAPER_V3_POLICY)).toBe(true);
    expect(Object.isFrozen(AUTONOMOUS_PAPER_V4_POLICY)).toBe(true);
    expect(Object.isFrozen(AUTONOMOUS_PAPER_V5_POLICY)).toBe(true);
    expect(Object.isFrozen(AUTONOMOUS_PAPER_V6_POLICY)).toBe(true);
    expect(Object.isFrozen(AUTONOMOUS_PAPER_V7_POLICY)).toBe(true);
    expect(Object.isFrozen(AUTONOMOUS_PAPER_V8_POLICY)).toBe(true);
    expect(Object.isFrozen(AUTONOMOUS_PAPER_V9_POLICY)).toBe(true);
    expect(Object.isFrozen(AUTONOMOUS_PAPER_V12_POLICY)).toBe(true);
    expect(Object.isFrozen(DEFAULT_AUTONOMOUS_PAPER_POLICY)).toBe(true);
    expect(DEFAULT_AUTONOMOUS_PAPER_POLICY.confirmationSamples).toBe(1);
    expect(DEFAULT_AUTONOMOUS_PAPER_POLICY.minimumLiquidityUsd)
      .toBeLessThan(LEGACY_AUTONOMOUS_PAPER_POLICY.minimumLiquidityUsd);
    expect(AUTONOMOUS_PAPER_V5_POLICY.positionNavFraction)
      .toBe(LEGACY_AUTONOMOUS_PAPER_POLICY.positionNavFraction);
    expect(DEFAULT_AUTONOMOUS_PAPER_POLICY).toMatchObject({
      riskAtStopSizingEnabled: true,
      positionNavFraction: 0.4,
      maximumOpenPositions: 4,
      maximumDeployedFraction: 0.9,
      minimumLiquidReserveUsd: 10,
      maximumPositionUsd: Number.MAX_SAFE_INTEGER,
      maximumEntriesPerUtcDay: Number.MAX_SAFE_INTEGER
    });
    for (const compatible of [decodedV1, decodedV2, decodedV3, decodedUnknown]) {
      expect(compatible).toMatchObject({
        allowToken2022: false,
        adaptiveSizingEnabled: false,
        maximumEntriesPerUtcDay: Number.MAX_SAFE_INTEGER,
        minimumEntrySpacingMinutes: 0
      });
    }
    expect(decodedV4).toMatchObject({
      allowToken2022: true,
      adaptiveSizingEnabled: false,
      maximumEntriesPerUtcDay: 8,
      minimumEntrySpacingMinutes: 10
    });
    expect(decodedV5).toMatchObject({
      allowToken2022: true,
      adaptiveSizingEnabled: true,
      maximumPositionUsd: 50,
      positionNavFraction: 0.2,
      maximumDeployedFraction: 0.65
    });
    expect(decodedV6).toMatchObject({
      adaptiveSizingEnabled: true,
      contextualRewardEnabled: false,
      maximumPositionUsd: Number.MAX_SAFE_INTEGER,
      positionNavFraction: 0.35,
      maximumDeployedFraction: 0.80
    });
    expect(decodedV7).toMatchObject({
      adaptiveSizingEnabled: true,
      contextualRewardEnabled: true,
      maximumPositionUsd: Number.MAX_SAFE_INTEGER,
      positionNavFraction: 0.35,
      maximumDeployedFraction: 0.80
    });
    expect(decodedV8).toMatchObject({
      contextualRewardEnabled: true,
      maximumEntriesPerUtcDay: 8,
      minimumEntrySpacingMinutes: 10
    });
    expect(decodedCurrent.contextualRewardEnabled).toBe(true);
    expect(decodedCurrent.maximumEntriesPerUtcDay).toBe(Number.MAX_SAFE_INTEGER);
    expect(normalizeAutonomousPaperPolicy(AUTONOMOUS_PAPER_V3_POLICY_VERSION, {
      allowToken2022: true,
      maximumEntriesPerUtcDay: 8,
      minimumEntrySpacingMinutes: 10
    })).toEqual(AUTONOMOUS_PAPER_V3_POLICY);
    expect(normalizeAutonomousPaperPolicy(AUTONOMOUS_PAPER_V4_POLICY_VERSION, {
      adaptiveSizingEnabled: true,
      adaptiveSizingMinimumTrades: 1
    })).toEqual(AUTONOMOUS_PAPER_V4_POLICY);
  });

  it("admits a defensible mid-cap momentum candidate in v2 that v1 would reject", () => {
    const candidate = market({
      marketCapUsd: 1_000_000,
      fdvUsd: 3_000_000,
      liquidityUsd: 300_000,
      volume24hUsd: 400_000,
      holderCount: 500,
      organicScore: 60,
      topHoldersPercent: 45
    });
    const sol = market({ mint: "sol", priceChange1hPercent: 1, priceChange6hPercent: 2 });

    expect(autonomousStaticAdmission(candidate, LEGACY_AUTONOMOUS_PAPER_POLICY).eligible)
      .toBe(false);
    expect(autonomousStaticAdmission(candidate, AUTONOMOUS_PAPER_V2_POLICY).eligible)
      .toBe(true);
    expect(autonomousMomentum(candidate, sol, AUTONOMOUS_PAPER_V2_POLICY).eligible)
      .toBe(true);
  });

  it("admits a strong 1h two-buyer shallow pullback only in v3 without relaxing unsafe or missing evidence", () => {
    const candidate = market({
      priceChange5mPercent: -0.06,
      priceChange1hPercent: 14,
      priceChange6hPercent: 20,
      organicBuyShare5m: 0.99,
      organicBuyShare1h: 0.7,
      organicVolume5mUsd: 5_000,
      organicVolume1hUsd: 100_000,
      organicBuyers5m: 2,
      volumeAccelerationRatio: 0.05
    });
    const sol = market({ mint: "sol", priceChange1hPercent: 1, priceChange6hPercent: 2 });

    expect(autonomousStaticAdmission(candidate, AUTONOMOUS_PAPER_V3_POLICY))
      .toEqual({ eligible: true, reasons: [] });
    const v2 = autonomousMomentum(candidate, sol, AUTONOMOUS_PAPER_V2_POLICY);
    expect(v2.eligible).toBe(false);
    expect(v2.reasons).toEqual(expect.arrayContaining([
      "FIVE_MINUTE_MOMENTUM_OUTSIDE_RANGE",
      "LOW_ORGANIC_BUYER_BREADTH"
    ]));
    expect(autonomousMomentum(candidate, sol, AUTONOMOUS_PAPER_V3_POLICY))
      .toMatchObject({ eligible: true, reasons: [] });
    expect(autonomousMomentum(market({
      ...candidate,
      priceChange5mPercent: -0.26
    }), sol, AUTONOMOUS_PAPER_V3_POLICY)).toMatchObject({
      eligible: false,
      reasons: expect.arrayContaining(["FIVE_MINUTE_MOMENTUM_OUTSIDE_RANGE"])
    });
    expect(autonomousMomentum(market({
      ...candidate,
      organicBuyers5m: 1
    }), sol, AUTONOMOUS_PAPER_V3_POLICY)).toMatchObject({
      eligible: false,
      reasons: expect.arrayContaining(["LOW_ORGANIC_BUYER_BREADTH"])
    });

    expect(autonomousStaticAdmission(market({
      verified: false,
      liquidityUsd: -1
    }), AUTONOMOUS_PAPER_V3_POLICY).reasons).toEqual(expect.arrayContaining([
      "NOT_VERIFIED",
      "LIQUIDITY_MISSING",
      "INSUFFICIENT_LIQUIDITY"
    ]));
    expect(autonomousMomentum(market({
      ...candidate,
      organicBuyShare5m: Number.NaN
    }), sol, AUTONOMOUS_PAPER_V3_POLICY)).toMatchObject({
      eligible: false,
      reasons: expect.arrayContaining(["MOMENTUM_DATA_MISSING"])
    });
  });

  it("admits only complete high-risk-but-defensible token evidence", () => {
    expect(autonomousStaticAdmission(market())).toEqual({ eligible: true, reasons: [] });
    const rejected = autonomousStaticAdmission(market({
      verified: false,
      liquidityUsd: 100,
      topHoldersPercent: 80
    }));
    expect(rejected.eligible).toBe(false);
    expect(rejected.reasons).toEqual(expect.arrayContaining([
      "NOT_VERIFIED",
      "INSUFFICIENT_LIQUIDITY",
      "TOP_HOLDER_CONCENTRATION"
    ]));
  });

  it("admits only the canonical Token-2022 program in v4 without weakening other safety gates", () => {
    const token2022 = market({ tokenProgram: TOKEN_2022_PROGRAM_ID });
    expect(autonomousStaticAdmission(token2022, AUTONOMOUS_PAPER_V3_POLICY)).toEqual({
      eligible: false,
      reasons: ["UNSUPPORTED_TOKEN_PROGRAM"]
    });
    expect(autonomousStaticAdmission(token2022, DEFAULT_AUTONOMOUS_PAPER_POLICY)).toEqual({
      eligible: true,
      reasons: []
    });
    expect(autonomousStaticAdmission(market({
      tokenProgram: "TokenzUnknown11111111111111111111111111111111"
    }), DEFAULT_AUTONOMOUS_PAPER_POLICY).reasons).toContain("UNSUPPORTED_TOKEN_PROGRAM");

    const unsafe = autonomousStaticAdmission(market({
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      verified: false,
      suspicious: true,
      mintAuthorityDisabled: false,
      freezeAuthorityDisabled: false,
      liquidityUsd: -1
    }), DEFAULT_AUTONOMOUS_PAPER_POLICY);
    expect(unsafe.eligible).toBe(false);
    expect(unsafe.reasons).toEqual(expect.arrayContaining([
      "NOT_VERIFIED",
      "SUSPICIOUS_OR_BANNED",
      "MINT_AUTHORITY_ENABLED",
      "FREEZE_AUTHORITY_ENABLED",
      "LIQUIDITY_MISSING",
      "INSUFFICIENT_LIQUIDITY"
    ]));
    expect(unsafe.reasons).not.toContain("UNSUPPORTED_TOKEN_PROGRAM");
  });

  it("requires organic pressure, SOL-relative strength, and rejects vertical pumps", () => {
    const sol = market({
      mint: "sol",
      priceChange1hPercent: 1,
      priceChange6hPercent: 2
    });
    const accepted = autonomousMomentum(market(), sol);
    expect(accepted.eligible).toBe(true);
    expect(accepted.score).toBeGreaterThanOrEqual(DEFAULT_AUTONOMOUS_PAPER_POLICY.minimumMomentumScore);

    const pump = autonomousMomentum(market({
      priceChange5mPercent: 16,
      priceChange24hPercent: 200,
      organicBuyShare5m: 0.2
    }), sol);
    expect(pump.eligible).toBe(false);
    expect(pump.reasons).toEqual(expect.arrayContaining([
      "FIVE_MINUTE_MOMENTUM_OUTSIDE_RANGE",
      "LATE_VERTICAL_PUMP",
      "WEAK_FIVE_MINUTE_ORGANIC_BUYING"
    ]));
  });

  it("compounds and decompounds entry size while enforcing exposure and reserve", () => {
    expect(autonomousEntrySize(account())).toEqual({ allowed: true, sizeUsd: 56.4 });
    expect(autonomousEntrySize(account(), AUTONOMOUS_PAPER_V5_POLICY)).toEqual({
      allowed: true,
      sizeUsd: 28.2
    });
    expect(autonomousEntrySize(
      account({ navUsd: 100, cashUsd: 100 }),
      AUTONOMOUS_PAPER_V5_POLICY
    )).toEqual({
      allowed: true,
      sizeUsd: 20
    });
    expect(autonomousEntrySize(
      account({ navUsd: 250, cashUsd: 250 }),
      AUTONOMOUS_PAPER_V5_POLICY
    )).toEqual({
      allowed: true,
      sizeUsd: 50
    });
    expect(autonomousEntrySize(account({ openPositions: 4 }))).toEqual({
      allowed: false,
      reason: "MAX_POSITIONS"
    });
    expect(autonomousEntrySize(account({ cashUsd: 14 }))).toEqual({
      allowed: false,
      reason: "INSUFFICIENT_RESERVE"
    });
  });

  it("sizes current v10 candidates by risk at stop while preserving frozen v6 and v7 profiles", () => {
    const candidate = market({
      momentumScore: 90,
      liquidityUsd: 3_000_000,
      organicVolume5mUsd: 20_000,
      organicVolume1hUsd: 100_000,
      organicBuyers5m: 40,
      organicBuyShare5m: 0.85,
      organicBuyShare1h: 0.75,
      categoryRanks: {
        topTraded24h: 1,
        topTraded1h: 1,
        topTrending1h: 1,
        topOrganicScore5m: 1,
        topOrganicScore1h: 1
      }
    });
    const preQuote = autonomousAdaptiveEntrySize({
      account: account(),
      snapshot: candidate,
      completedTrades: []
    });
    expect(preQuote).toMatchObject({
      allowed: true,
      breakdown: {
        minimumUsd: 5,
        maximumAvailableUsd: 42.3,
        calibration: {
          sampleCount: 0,
          coldStart: true,
          multiplier: 1,
          averageReward: 0,
          baseRewardMultiplier: 1,
          rewardMultiplier: 1.2
        },
        contextualReward: {
          active: false,
          preQuoteUpperBound: true,
          multiplier: 1.2
        },
        riskMultipliers: {
          consecutiveLosses: 0,
          lossStreak: 1
        },
        bindingConstraints: ["RISK_AT_STOP_CAP"]
      }
    });
    if (!preQuote.allowed) throw new Error("Expected adaptive pre-quote sizing.");
    expect(preQuote.sizeUsd).toBeGreaterThan(5);
    expect(preQuote.sizeUsd).toBeLessThanOrEqual(42.3);

    const cheapQuote = autonomousAdaptiveEntrySize({
      account: account(),
      snapshot: candidate,
      completedTrades: [],
      quote: {
        projectedRoundTripCostPercent: 0.1,
        buyPriceImpactPercent: 0.05,
        sellPriceImpactPercent: 0.05
      }
    });
    const ceilingQuote = autonomousAdaptiveEntrySize({
      account: account(),
      snapshot: candidate,
      completedTrades: [],
      quote: {
        projectedRoundTripCostPercent: 3,
        buyPriceImpactPercent: 2,
        sellPriceImpactPercent: 2
      }
    });
    expect(cheapQuote.allowed && ceilingQuote.allowed).toBe(true);
    if (!cheapQuote.allowed || !ceilingQuote.allowed) throw new Error("Expected quote-aware sizing.");
    expect(cheapQuote.sizeUsd).toBeLessThanOrEqual(preQuote.sizeUsd);
    expect(ceilingQuote.sizeUsd).toBeLessThan(cheapQuote.sizeUsd);
    expect(ceilingQuote.breakdown.explanationCodes).toContain("QUOTE_QUALITY_REDUCTION");

    const hardCapped = autonomousAdaptiveEntrySize({
      account: account({ navUsd: 400, cashUsd: 400, peakNavUsd: 400 }),
      snapshot: candidate,
      completedTrades: []
    });
    expect(hardCapped.allowed && hardCapped.breakdown.maximumAvailableUsd).toBe(120);
    expect(hardCapped.allowed && hardCapped.breakdown.bindingConstraints).toContain("RISK_AT_STOP_CAP");
    expect(hardCapped.allowed && hardCapped.breakdown.bindingConstraints).not.toContain("HARD_USD_CAP");
    const frozenV6 = autonomousAdaptiveEntrySize({
      account: account({ navUsd: 400, cashUsd: 400, peakNavUsd: 400 }),
      snapshot: candidate,
      completedTrades: [],
      policy: AUTONOMOUS_PAPER_V6_POLICY
    });
    expect(frozenV6.allowed && frozenV6.breakdown.maximumAvailableUsd).toBe(140);
    expect(frozenV6.allowed && frozenV6.breakdown.version).toBe("adaptive-sizing-v1");
    expect(frozenV6.allowed && frozenV6.breakdown.calibration.rewardMultiplier).toBe(1);
    const frozenV7 = autonomousAdaptiveEntrySize({
      account: account({ navUsd: 400, cashUsd: 400, peakNavUsd: 400 }),
      snapshot: candidate,
      completedTrades: [],
      policy: AUTONOMOUS_PAPER_V7_POLICY
    });
    expect(frozenV7.allowed && frozenV7.breakdown.maximumAvailableUsd).toBe(140);
    expect(frozenV7.allowed && frozenV7.breakdown.version).toBe("adaptive-sizing-v2");
    expect(frozenV7.allowed && frozenV7.breakdown.contextualReward).toMatchObject({
      active: false,
      preQuoteUpperBound: true,
      multiplier: 1.2
    });
    const frozenV5 = autonomousAdaptiveEntrySize({
      account: account({ navUsd: 400, cashUsd: 400, peakNavUsd: 400 }),
      snapshot: candidate,
      completedTrades: [],
      policy: AUTONOMOUS_PAPER_V5_POLICY
    });
    expect(frozenV5.allowed && frozenV5.breakdown.maximumAvailableUsd).toBe(50);
    expect(frozenV5.allowed && frozenV5.breakdown.bindingConstraints).toContain("POLICY_POSITION_CAP");
    expect(autonomousAdaptiveEntrySize({
      account: account({ cashUsd: 14 }),
      snapshot: candidate,
      completedTrades: []
    })).toEqual({ allowed: false, reason: "INSUFFICIENT_RESERVE" });
  });

  it("uses separate v10 stop-risk budgets for exploration, normal, high-conviction, and developer clusters", () => {
    const candidate = market({
      momentumScore: 90,
      categoryRanks: { topTraded24h: 1, topTraded6h: 2, topTrending1h: 3 }
    });
    const size = (strategyArm: "CONTROLLED_EXPLORATION" | "BREAKOUT", options: {
      modelHighConviction?: boolean;
      clusterDeployedUsd?: number;
    } = {}) => autonomousAdaptiveEntrySize({
      account: account(),
      snapshot: candidate,
      completedTrades: [],
      strategyArm,
      waivedReasonCount: strategyArm === "CONTROLLED_EXPLORATION" ? 1 : 0,
      ...options
    });

    const exploration = size("CONTROLLED_EXPLORATION");
    const normal = size("BREAKOUT");
    const high = size("BREAKOUT", { modelHighConviction: true });
    const clustered = size("BREAKOUT", { clusterDeployedUsd: 40 });

    expect(exploration.allowed && exploration.breakdown.maximumAvailableUsd).toBe(28.2);
    expect(exploration.allowed && exploration.breakdown.bindingConstraints)
      .toContain("RISK_AT_STOP_CAP");
    expect(normal.allowed && normal.breakdown.maximumAvailableUsd).toBe(42.3);
    expect(high.allowed && high.breakdown.maximumAvailableUsd).toBe(56.4);
    expect(clustered.allowed && clustered.breakdown.maximumAvailableUsd).toBe(23.45);
    expect(clustered.allowed && clustered.breakdown.bindingConstraints)
      .toContain("DEVELOPER_CLUSTER_CAP");
  });

  it("preserves v6 calibration through 19 trades, then applies smoothed Kelly and cost-aware rewards", () => {
    const candidate = market({
      momentumScore: 90,
      liquidityUsd: 3_000_000,
      organicVolume5mUsd: 20_000,
      organicVolume1hUsd: 100_000,
      organicBuyers5m: 40,
      organicBuyShare5m: 0.85,
      organicBuyShare1h: 0.75,
      categoryRanks: {
        topTraded24h: 1,
        topTraded1h: 1,
        topTrending1h: 1,
        topOrganicScore5m: 1,
        topOrganicScore1h: 1
      }
    });
    const nineteen = Array.from({ length: 19 }, (_, index) => trade(index, 18));
    const cold = autonomousAdaptiveEntrySize({
      account: account(),
      snapshot: candidate,
      completedTrades: nineteen,
      policy: AUTONOMOUS_PAPER_V6_POLICY
    });
    expect(cold).toMatchObject({
      allowed: true,
      breakdown: {
        calibration: {
          sampleCount: 19,
          coldStart: true,
          multiplier: 1,
          rewardMultiplier: 1
        }
      }
    });

    const winners = [...nineteen, trade(19, 18)];
    const calibratedWin = autonomousAdaptiveEntrySize({
      account: account(),
      snapshot: candidate,
      completedTrades: [...winners].reverse(),
      policy: AUTONOMOUS_PAPER_V6_POLICY
    });
    const losses = Array.from({ length: 20 }, (_, index) => trade(index, -10));
    const calibratedLoss = autonomousAdaptiveEntrySize({
      account: account(),
      snapshot: candidate,
      completedTrades: losses,
      policy: AUTONOMOUS_PAPER_V6_POLICY
    });
    expect(calibratedWin.allowed && calibratedLoss.allowed).toBe(true);
    if (!calibratedWin.allowed || !calibratedLoss.allowed) throw new Error("Expected calibrated sizing.");
    expect(calibratedWin.breakdown.calibration).toMatchObject({
      sampleCount: 20,
      coldStart: false,
      multiplier: 1.25
    });
    expect(calibratedWin.breakdown.calibration.averageReward).toBeGreaterThan(0);
    expect(calibratedWin.breakdown.calibration.rewardMultiplier).toBeGreaterThan(1);
    expect(calibratedLoss.breakdown.calibration.multiplier).toBe(0.25);
    expect(calibratedLoss.breakdown.calibration.averageReward).toBeLessThan(0);
    expect(calibratedLoss.breakdown.calibration.rewardMultiplier).toBeLessThan(1);
    expect(calibratedLoss.breakdown.riskMultipliers).toMatchObject({
      consecutiveLosses: 3,
      lossStreak: 0.5120000000000001
    });
    expect(calibratedLoss.sizeUsd).toBeLessThan(calibratedWin.sizeUsd);
    expect(calibratedWin.breakdown.explanationCodes).toContain("EMPIRICAL_CALIBRATION");
    expect(calibratedLoss.breakdown.explanationCodes).toContain("LOSS_STREAK_REDUCTION");
  });

  it("keeps v7/v8 contextual learning gated to broad similar outcomes and deterministic", () => {
    const candidate = market({
      momentumScore: 88,
      liquidityUsd: 3_000_000,
      organicVolume5mUsd: 20_000,
      organicVolume1hUsd: 100_000,
      organicBuyers5m: 40,
      organicBuyShare5m: 0.84,
      organicBuyShare1h: 0.72,
      categoryRanks: {
        topTraded24h: 2,
        topTraded1h: 3,
        topTrending1h: 4,
        topOrganicScore5m: 5,
        topOrganicScore1h: 6
      }
    });
    const quote = {
      projectedRoundTripCostPercent: 0.25,
      buyPriceImpactPercent: 0.1,
      sellPriceImpactPercent: 0.1
    };
    const baseline = autonomousAdaptiveEntrySize({
      account: account(),
      snapshot: candidate,
      completedTrades: [],
      quote
    });
    expect(baseline.allowed).toBe(true);
    if (!baseline.allowed) throw new Error("Expected contextual baseline sizing.");
    const context = autonomousPaperLearningContext(
      baseline.breakdown,
      quote.projectedRoundTripCostPercent
    );
    const contextualTrade = (index: number, returnPercent: number): AutonomousPaperTrade =>
      trade(index, returnPercent, {
        mint: `context-mint-${index % 4}`,
        closedAt: new Date(Date.UTC(2026, 6, 10 + index % 3, 12, index)).toISOString(),
        entryLearningContext: context
      });
    const winners = Array.from({ length: 8 }, (_, index) => contextualTrade(index, 18));
    const losses = Array.from({ length: 8 }, (_, index) => contextualTrade(index, -10));
    const sizedWinners = autonomousAdaptiveEntrySize({
      account: account(),
      snapshot: candidate,
      completedTrades: [...winners].reverse(),
      quote
    });
    const replayedWinners = autonomousAdaptiveEntrySize({
      account: account(),
      snapshot: candidate,
      completedTrades: [winners[3]!, winners[0]!, winners[7]!, winners[1]!, winners[5]!, winners[2]!, winners[6]!, winners[4]!],
      quote
    });
    const sizedLosses = autonomousAdaptiveEntrySize({
      account: account(),
      snapshot: candidate,
      completedTrades: losses,
      quote
    });
    expect(sizedWinners.allowed && replayedWinners.allowed && sizedLosses.allowed).toBe(true);
    if (!sizedWinners.allowed || !replayedWinners.allowed || !sizedLosses.allowed) {
      throw new Error("Expected contextual reward sizing.");
    }
    expect(sizedWinners).toEqual(replayedWinners);
    expect(sizedWinners.breakdown.contextualReward).toMatchObject({
      active: true,
      preQuoteUpperBound: false,
      comparableTrades: 8,
      effectiveSampleSize: 8,
      distinctMints: 4,
      distinctUtcDays: 3,
      multiplier: expect.any(Number)
    });
    expect(sizedWinners.breakdown.contextualReward.multiplier).toBeGreaterThan(1);
    expect(sizedWinners.breakdown.calibration.rewardMultiplier).toBeLessThanOrEqual(1.2);
    expect(sizedWinners.breakdown.explanationCodes).toEqual(expect.arrayContaining([
      "CONTEXTUAL_REWARD_ACTIVE",
      "CONTEXTUAL_REWARD_INCREASE"
    ]));
    expect(sizedLosses.breakdown.contextualReward.multiplier).toBeLessThan(1);
    expect(sizedLosses.breakdown.calibration.rewardMultiplier).toBeGreaterThanOrEqual(0.75);
    expect(sizedLosses.sizeUsd).toBeLessThan(sizedWinners.sizeUsd);

    const tooFew = autonomousAdaptiveEntrySize({
      account: account(),
      snapshot: candidate,
      completedTrades: winners.slice(0, 7),
      quote
    });
    const concentrated = autonomousAdaptiveEntrySize({
      account: account(),
      snapshot: candidate,
      completedTrades: winners.map((value) => ({ ...value, mint: "one-mint" })),
      quote
    });
    expect(tooFew.allowed && tooFew.breakdown.contextualReward).toMatchObject({
      active: false,
      comparableTrades: 7,
      multiplier: 1
    });
    expect(concentrated.allowed && concentrated.breakdown.contextualReward).toMatchObject({
      active: false,
      comparableTrades: 2,
      distinctMints: 1,
      multiplier: 1
    });

    const withMissing = autonomousAdaptiveEntrySize({
      account: account(),
      snapshot: candidate,
      completedTrades: [...winners, trade(99, 18)],
      quote
    });
    expect(withMissing.allowed && withMissing.breakdown.contextualReward).toMatchObject({
      active: true,
      ignoredMissingContext: 1,
      comparableTrades: 8
    });
  });

  it("preserves the frozen v1 context payload and validates complete v2 arm provenance", () => {
    const candidate = market({
      momentumScore: 88,
      liquidityUsd: 3_000_000,
      organicVolume5mUsd: 20_000,
      organicVolume1hUsd: 100_000,
      organicBuyers5m: 40,
      organicBuyShare5m: 0.84,
      organicBuyShare1h: 0.72,
      categoryRanks: {
        topTraded24h: 2,
        topTraded1h: 3,
        topTrending1h: 4,
        topOrganicScore5m: 5,
        topOrganicScore1h: 6
      }
    });
    const quote = {
      projectedRoundTripCostPercent: 0.25,
      buyPriceImpactPercent: 0.1,
      sellPriceImpactPercent: 0.1
    };
    const sizing = autonomousAdaptiveEntrySize({
      account: account(),
      snapshot: candidate,
      completedTrades: [],
      quote
    });
    expect(sizing.allowed).toBe(true);
    if (!sizing.allowed) throw new Error("Expected context sizing.");

    const legacy = autonomousPaperLearningContext(
      sizing.breakdown,
      quote.projectedRoundTripCostPercent
    );
    expect(legacy).toEqual({
      version: AUTONOMOUS_PAPER_LEARNING_CONTEXT_VERSION,
      momentum: sizing.breakdown.componentScores.momentum,
      categoryRank: sizing.breakdown.componentScores.categoryRank,
      liquidityFlow: sizing.breakdown.componentScores.liquidityFlow,
      quoteQuality: sizing.breakdown.componentScores.quoteQuality,
      projectedRoundTripCostPercent: quote.projectedRoundTripCostPercent
    });
    expect("strategyArm" in legacy).toBe(false);
    expect("waivedReasonCount" in legacy).toBe(false);

    const exploration = autonomousPaperLearningContext(
      sizing.breakdown,
      quote.projectedRoundTripCostPercent,
      "CONTROLLED_EXPLORATION",
      2
    );
    expect(exploration).toEqual({
      version: AUTONOMOUS_PAPER_LEARNING_CONTEXT_V2_VERSION,
      momentum: sizing.breakdown.componentScores.momentum,
      categoryRank: sizing.breakdown.componentScores.categoryRank,
      liquidityFlow: sizing.breakdown.componentScores.liquidityFlow,
      quoteQuality: sizing.breakdown.componentScores.quoteQuality,
      projectedRoundTripCostPercent: quote.projectedRoundTripCostPercent,
      strategyArm: "CONTROLLED_EXPLORATION",
      waivedReasonCount: 2
    });

    const incompleteArm = autonomousAdaptiveEntrySize({
      account: account(),
      snapshot: candidate,
      completedTrades: [],
      quote,
      strategyArm: "MOMENTUM"
    });
    const incompleteCount = autonomousAdaptiveEntrySize({
      account: account(),
      snapshot: candidate,
      completedTrades: [],
      quote,
      waivedReasonCount: 0
    });
    expect(incompleteArm).toEqual({ allowed: false, reason: "INVALID_SIZING_EVIDENCE" });
    expect(incompleteCount).toEqual({ allowed: false, reason: "INVALID_SIZING_EVIDENCE" });
    expect(() => autonomousPaperLearningContext(
      sizing.breakdown,
      quote.projectedRoundTripCostPercent,
      "MOMENTUM",
      1
    )).toThrow(RangeError);
    expect(() => autonomousPaperLearningContext(
      sizing.breakdown,
      quote.projectedRoundTripCostPercent,
      "CONTROLLED_EXPLORATION",
      0
    )).toThrow(RangeError);
  });

  it("isolates calibration and contextual reward by strategy arm while learning within each arm", () => {
    const candidate = market({
      momentumScore: 88,
      liquidityUsd: 3_000_000,
      organicVolume5mUsd: 20_000,
      organicVolume1hUsd: 100_000,
      organicBuyers5m: 40,
      organicBuyShare5m: 0.84,
      organicBuyShare1h: 0.72,
      categoryRanks: {
        topTraded24h: 2,
        topTraded1h: 3,
        topTrending1h: 4,
        topOrganicScore5m: 5,
        topOrganicScore1h: 6
      }
    });
    const quote = {
      projectedRoundTripCostPercent: 0.25,
      buyPriceImpactPercent: 0.1,
      sellPriceImpactPercent: 0.1
    };
    const seed = autonomousAdaptiveEntrySize({
      account: account(),
      snapshot: candidate,
      completedTrades: [],
      quote
    });
    expect(seed.allowed).toBe(true);
    if (!seed.allowed) throw new Error("Expected arm-isolation seed sizing.");
    const momentumContext = autonomousPaperLearningContext(
      seed.breakdown,
      quote.projectedRoundTripCostPercent,
      "MOMENTUM",
      0
    );
    const explorationContext = autonomousPaperLearningContext(
      seed.breakdown,
      quote.projectedRoundTripCostPercent,
      "CONTROLLED_EXPLORATION",
      1
    );
    const archivedContext = autonomousPaperLearningContext(
      seed.breakdown,
      quote.projectedRoundTripCostPercent
    );
    const armTrade = (
      arm: "momentum" | "exploration" | "archived",
      index: number,
      returnPercent: number
    ): AutonomousPaperTrade => trade(200 + index, returnPercent, {
      id: `${arm}-trade-${index}`,
      mint: `${arm}-mint-${index % 4}`,
      closedAt: new Date(Date.UTC(2026, 6, 10 + index % 3, 12, index)).toISOString(),
      entryLearningContext: arm === "momentum"
        ? momentumContext
        : arm === "exploration"
          ? explorationContext
          : archivedContext
    });
    const momentumWinners = Array.from(
      { length: 8 },
      (_, index) => armTrade("momentum", index, 18)
    );
    const explorationLosses = Array.from(
      { length: 8 },
      (_, index) => armTrade("exploration", index + 20, -10)
    );

    const momentumOnly = autonomousAdaptiveEntrySize({
      account: account(),
      snapshot: candidate,
      completedTrades: momentumWinners,
      quote,
      strategyArm: "MOMENTUM",
      waivedReasonCount: 0
    });
    const momentumWithCrossArmLosses = autonomousAdaptiveEntrySize({
      account: account(),
      snapshot: candidate,
      completedTrades: [...explorationLosses, ...momentumWinners],
      quote,
      strategyArm: "MOMENTUM",
      waivedReasonCount: 0
    });
    expect(momentumOnly.allowed && momentumWithCrossArmLosses.allowed).toBe(true);
    if (!momentumOnly.allowed || !momentumWithCrossArmLosses.allowed) {
      throw new Error("Expected momentum-arm sizing.");
    }
    expect(momentumWithCrossArmLosses).toEqual(momentumOnly);
    expect(momentumOnly.breakdown.calibration.sampleCount).toBe(8);
    expect(momentumOnly.breakdown.contextualReward).toMatchObject({
      active: true,
      comparableTrades: 8,
      multiplier: expect.any(Number)
    });
    expect(momentumOnly.breakdown.contextualReward.multiplier).toBeGreaterThan(1);
    expect(momentumOnly.breakdown.contextualReward.contributingTradeIds.every(
      (id) => id.startsWith("momentum-trade-")
    )).toBe(true);

    const explorationOnly = autonomousAdaptiveEntrySize({
      account: account(),
      snapshot: candidate,
      completedTrades: explorationLosses,
      quote,
      strategyArm: "CONTROLLED_EXPLORATION",
      waivedReasonCount: 1
    });
    const explorationWithCrossArmWinners = autonomousAdaptiveEntrySize({
      account: account(),
      snapshot: candidate,
      completedTrades: [...momentumWinners, ...explorationLosses],
      quote,
      strategyArm: "CONTROLLED_EXPLORATION",
      waivedReasonCount: 1
    });
    expect(explorationOnly.allowed && explorationWithCrossArmWinners.allowed).toBe(true);
    if (!explorationOnly.allowed || !explorationWithCrossArmWinners.allowed) {
      throw new Error("Expected exploration-arm sizing.");
    }
    expect(explorationWithCrossArmWinners).toEqual(explorationOnly);
    expect(explorationOnly.breakdown.calibration.sampleCount).toBe(8);
    expect(explorationOnly.breakdown.contextualReward).toMatchObject({
      active: true,
      comparableTrades: 8,
      multiplier: expect.any(Number)
    });
    expect(explorationOnly.breakdown.contextualReward.multiplier).toBeLessThan(1);
    expect(explorationOnly.breakdown.contextualReward.contributingTradeIds.every(
      (id) => id.startsWith("exploration-trade-")
    )).toBe(true);

    const archivedWinners = Array.from(
      { length: 8 },
      (_, index) => armTrade("archived", index + 40, 18)
    );
    const archivedAsMomentum = autonomousAdaptiveEntrySize({
      account: account(),
      snapshot: candidate,
      completedTrades: archivedWinners,
      quote,
      strategyArm: "MOMENTUM",
      waivedReasonCount: 0
    });
    const archivedExcludedFromExploration = autonomousAdaptiveEntrySize({
      account: account(),
      snapshot: candidate,
      completedTrades: archivedWinners,
      quote,
      strategyArm: "CONTROLLED_EXPLORATION",
      waivedReasonCount: 1
    });
    expect(archivedAsMomentum.allowed && archivedExcludedFromExploration.allowed).toBe(true);
    if (!archivedAsMomentum.allowed || !archivedExcludedFromExploration.allowed) {
      throw new Error("Expected archived context normalization.");
    }
    expect(archivedAsMomentum.breakdown.contextualReward).toMatchObject({
      active: true,
      comparableTrades: 8
    });
    expect(archivedExcludedFromExploration.breakdown.calibration.sampleCount).toBe(0);
    expect(archivedExcludedFromExploration.breakdown.contextualReward).toMatchObject({
      active: false,
      comparableTrades: 0,
      multiplier: 1
    });
  });

  it("resets the capped loss-streak brake after the newest profitable exit", () => {
    const candidate = market({
      momentumScore: 80,
      categoryRanks: { topTraded24h: 5, topTrending1h: 5 }
    });
    const losses = [trade(1, -2), trade(2, -3), trade(3, -4), trade(4, -5)];
    const braked = autonomousAdaptiveEntrySize({
      account: account(),
      snapshot: candidate,
      completedTrades: losses
    });
    const reset = autonomousAdaptiveEntrySize({
      account: account(),
      snapshot: candidate,
      completedTrades: [...losses, trade(5, 1)]
    });
    expect(braked.allowed && reset.allowed).toBe(true);
    if (!braked.allowed || !reset.allowed) throw new Error("Expected loss-streak sizing.");
    expect(braked.breakdown.riskMultipliers.consecutiveLosses).toBe(3);
    expect(reset.breakdown.riskMultipliers).toMatchObject({
      consecutiveLosses: 0,
      lossStreak: 1
    });
    expect(reset.sizeUsd).toBeGreaterThan(braked.sizeUsd);
  });

  it("uses hard loss, trailing, momentum, and time exits deterministically", () => {
    const now = new Date("2026-07-14T12:00:00.000Z");
    expect(autonomousExitDecision({
      position: position({ lastExecutableValueUsd: 24.5 }),
      snapshot: market(),
      staticSafetyEligible: true,
      now
    }).reason).toBe("STOP_LOSS");

    expect(autonomousExitDecision({
      position: position({ lastExecutableValueUsd: 29, peakExecutableValueUsd: 35 }),
      snapshot: market(),
      staticSafetyEligible: true,
      now
    }).reason).toBe("TRAILING_STOP");

    expect(autonomousExitDecision({
      position: position({ weakMomentumSamples: 2 }),
      snapshot: market({ priceChange5mPercent: -1.5 }),
      staticSafetyEligible: true,
      now
    }).reason).toBe("WEAK_MOMENTUM");

    expect(autonomousExitDecision({
      position: position({ openedAt: "2026-07-13T20:00:00.000Z", peakExecutableValueUsd: 28.5 }),
      snapshot: market(),
      staticSafetyEligible: true,
      now
    }).reason).toBe("MAX_HOLD");
  });

  it("keeps non-negotiable token safety gates in the aggressive profile", () => {
    const unsafeCases: Partial<AutonomousPaperMarketSnapshot>[] = [
      { verified: false },
      { suspicious: true },
      { tokenProgram: "TokenzQdY2fT5Y19W9fK6f2JxLr2M5N9J4kV1t8s7" },
      { mintAuthorityDisabled: false },
      { freezeAuthorityDisabled: false },
      { tokenAgeDays: 1 },
      { liquidityUsd: 10_000 },
      { holderCount: 20 }
    ];

    for (const unsafe of unsafeCases) {
      expect(autonomousStaticAdmission(market(unsafe), DEFAULT_AUTONOMOUS_PAPER_POLICY).eligible)
        .toBe(false);
    }
  });
});
