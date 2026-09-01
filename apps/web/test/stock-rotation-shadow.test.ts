import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  STOCK_PAPER_LABEL,
  STOCK_PAPER_ROTATION_SHADOW_VERSION,
  type StockPaperDashboard
} from "@copylab/shared";
import { StockPaperPanel } from "../src/components/StockPaperPanel";

const at = "2026-07-17T16:00:00.000Z";

function dashboard(): StockPaperDashboard {
  return {
    label: STOCK_PAPER_LABEL,
    promotionEligible: false,
    executionEnabled: false,
    paperOnly: true,
    lane: {
      id: "stock-paper:test",
      label: STOCK_PAPER_LABEL,
      purpose: "RESEARCH_ONLY",
      policyVersion: "stock-paper-v3",
      policy: {
        scanIntervalSeconds: 60,
        initialNavUsd: 141,
        maximumOpenPositions: 4,
        maximumDeployedFraction: 0.9,
        minimumCashReserveUsd: 10,
        maximumPositionNavFraction: 0.45,
        normalRiskAtStopNavFraction: 0.04,
        highConvictionRiskAtStopNavFraction: 0.06,
        stopLossPercent: 8,
        takeProfitPercent: 12,
        trailingActivationPercent: 6,
        trailingDrawdownPercent: 4,
        maximumHoldingMinutes: 210,
        cooldownMinutes: 60,
        stopCooldownMinutes: 180,
        dailyLossPausePercent: 12,
        maximumDrawdownPercent: 25,
        maximumSpreadPercent: 1.25,
        minimumPriceUsd: 1,
        maximumPriceUsd: 500,
        minimumDailyDollarVolumeUsd: 2_000_000,
        minimumRelativeVolume: 1.15,
        minimumSignalScore: 62,
        universeSize: 280,
        detailedCandidateCount: 30,
        extendedEntrySpreadPercent: 0.6,
        extendedEntrySizeMultiplier: 0.55,
        extendedMaximumOpenPositions: 2,
        extendedFillPenaltyPercent: 0.15,
        extendedLimitConfirmationMinutes: 3,
        overnightDerivedLimitConfirmationMinutes: 25,
        maximumBarParticipationPercent: 1,
        observationRetentionDays: 180
      },
      status: "ACTIVE",
      initialNavUsd: 141,
      startedAt: at,
      updatedAt: at
    },
    account: {
      laneId: "stock-paper:test",
      initialNavUsd: 141,
      cashUsd: 14,
      navUsd: 140,
      peakNavUsd: 141,
      deployedUsd: 126,
      realizedPnlUsd: 0,
      unrealizedPnlUsd: -1,
      maxDrawdownPercent: 1,
      openPositions: 2,
      completedTrades: 0,
      winningTrades: 0,
      grossProfitUsd: 0,
      grossLossUsd: 0,
      pricingComplete: true,
      dayKey: "2026-07-17",
      dayStartNavUsd: 141,
      updatedAt: at
    },
    positions: [],
    candidates: [],
    recentSignals: [],
    recentTrades: [],
    equityCurve: [],
    armStats: [],
    orders: [],
    learning: {
      version: "stock-paper-learning-v3",
      observations: 1,
      labeledOutcomes: 1,
      missingOutcomes: 0,
      pendingOutcomes: 2,
      eligibleCoveragePercent: 100,
      distinctSymbols: 1,
      distinctDays: 1,
      shadowPolicies: [],
      outcomeQuality: [],
      rotationShadow: {
        version: STOCK_PAPER_ROTATION_SHADOW_VERSION,
        analysisOnly: true,
        affectsTrading: false,
        promotionEligible: false,
        portfolioCounterfactual: false,
        resultsAreIndependentOneStepCounterfactuals: true,
        compoundedPortfolioNavAvailable: false,
        evaluatedDecisions: 1,
        proposedRotations: 1,
        heldDecisions: 0,
        labeledOutcomes: 1,
        missingOutcomes: 0,
        incrementalWins: 1,
        incrementalWinRatePercent: 100,
        meanIncrementalPnlUsd: 0.42,
        meanIncrementalReturnPercent: 0.67,
        recentDecisions: [{
          id: "rotation:1",
          idempotencyKey: "rotation:1",
          laneId: "stock-paper:test",
          version: STOCK_PAPER_ROTATION_SHADOW_VERSION,
          policy: {
            version: STOCK_PAPER_ROTATION_SHADOW_VERSION,
            minimumPositionAgeMinutes: 15,
            rotationCooldownMinutes: 30,
            minimumScoreDelta: 10,
            minimumReplacementNotionalUsd: 1,
            maximumSwitchCostPercent: 2
          },
          policyDigest: "rotation-policy:test",
          sourcePolicyDigest: "stock-policy:test",
          idempotencyBucket: at,
          decisionAt: at,
          phase: "REGULAR",
          feed: "IEX",
          extendedFillPenaltyPercent: 0,
          status: "ROTATE",
          reasonCodes: [],
          analysisOnly: true,
          affectsTrading: false,
          promotionEligible: false,
          portfolioCounterfactual: false,
          resultsAreIndependentOneStepCounterfactuals: true,
          outgoing: {
            positionId: "position:usb",
            symbol: "USB",
            openedAt: "2026-07-17T13:46:00.000Z",
            ageMinutes: 134,
            candidateCapturedAt: at,
            currentScore: 42,
            currentRelativeVolume: 0.8,
            bidUsd: 63.8,
            askUsd: 63.9,
            spreadPercent: 0.15,
            quantity: 1,
            remainingCostUsd: 64.6,
            executableReturnPercent: -1.28,
            modeledSellPriceUsd: 63.77,
            executableProceedsUsd: 63.77,
            modeledExitCostUsd: 0.03
          },
          incoming: {
            symbol: "FCX",
            candidateCapturedAt: at,
            currentScore: 95,
            currentRelativeVolume: 5.1,
            bidUsd: 58.9,
            askUsd: 59,
            spreadPercent: 0.17,
            modeledBuyPriceUsd: 59.03,
            quantity: 1.07,
            entryNotionalUsd: 63.1,
            modeledEntryCostUsd: 0.03
          },
          scoreDelta: 53,
          modeledSwitchCostsUsd: 0.06,
          modeledSwitchCostPercent: 0.1,
          preRotationNavUsd: 140,
          preRotationCashUsd: 14,
          preRotationDeployedUsd: 126,
          hypotheticalPostSaleCashUsd: 77.77,
          hypotheticalPostSaleDeployedUsd: 62,
          hypotheticalPostSaleNavUsd: 139.77,
          hypotheticalPostEntryCashUsd: 14.67,
          hypotheticalPostEntryDeployedUsd: 125.1,
          hypotheticalPostEntryNavUsd: 139.77
        }],
        recentOutcomes: [{
          id: "rotation-outcome:1",
          idempotencyKey: "rotation-outcome:1",
          decisionId: "rotation:1",
          laneId: "stock-paper:test",
          version: STOCK_PAPER_ROTATION_SHADOW_VERSION,
          horizonMinutes: 45,
          status: "LABELED",
          dueAt: "2026-07-17T16:45:00.000Z",
          labeledAt: "2026-07-17T16:46:00.000Z",
          analysisOnly: true,
          affectsTrading: false,
          promotionEligible: false,
          portfolioCounterfactual: false,
          resultsAreIndependentOneStepCounterfactuals: true,
          baselineExitPriceUsd: 63,
          baselineExitProceedsUsd: 63,
          baselineModeledExitCostUsd: 0.03,
          baselineHoldPnlUsd: -0.8,
          rotatedIncomingExitPriceUsd: 60,
          rotatedIncomingExitProceedsUsd: 64.2,
          rotatedIncomingModeledExitCostUsd: 0.03,
          rotatedPnlUsd: 0.4,
          totalRotationModeledCostsUsd: 0.09,
          incrementalPnlUsd: 1.2,
          incrementalReturnPercent: 1.9
        }],
        updatedAt: at
      },
      bookResearch: {
        version: "stock-paper-book-research-v2",
        analysisOnly: true,
        affectsTrading: false,
        promotionEligible: false,
        fingerprintAlgorithm: "SHA-256",
        shadowManifestDigest: "test",
        policyTestsUseCausalOutcomes: true,
        sourceCount: 0,
        curatedSourceCount: 0,
        cautionSourceCount: 0,
        quarantinedSourceCount: 0,
        activeEvidenceCount: 0,
        shadowTestingCount: 0,
        dataRequiredCount: 0,
        excludedCount: 0,
        sources: [],
        hypotheses: [],
        warnings: []
      },
      promotionEnabled: false
    },
    market: {
      feed: "IEX",
      isOpen: true,
      phase: "REGULAR",
      scannedSymbols: 200,
      detailedSymbols: 30,
      providerRequests: 1,
      lastScanAt: at
    },
    updatedAt: at
  };
}

describe("StockPaperPanel rotation challenger", () => {
  it("labels rotation evidence as independent analysis rather than executed P&L", () => {
    const html = renderToStaticMarkup(createElement(StockPaperPanel, { stock: dashboard() }));

    expect(html).toContain("Position-rotation shadow challenger");
    expect(html).toContain("Analysis only · independent one-step comparisons");
    expect(html).toContain("USB → FCX");
    expect(html).toContain("never compounded into account NAV");
    expect(html).not.toContain("Rotation trade executed");
  });

  it("labels delayed SIP marks as fair-value-only evidence", () => {
    const input = dashboard();
    input.market.delayedFairValueFeed = "SIP";
    input.market.delayedFairValueAt = "2026-07-17T15:44:00.000Z";
    input.market.openPositionPricingCoveragePercent = 0;
    input.positions = [{
      id: "position:delayed",
      laneId: input.lane!.id,
      symbol: "IBIT",
      arm: "BREAKOUT",
      status: "UNPRICED",
      quantity: 1,
      entryPriceUsd: 44,
      entryNotionalUsd: 44,
      remainingCostUsd: 44,
      lastBidUsd: 43.8,
      lastAskUsd: 44.1,
      lastMarkUsd: 45,
      lastValueUsd: 45,
      lastExecutableValueUsd: 43.7,
      delayedFairValueEvidence: {
        feed: "SIP_DELAYED",
        priceUsd: 45,
        evidenceAt: input.market.delayedFairValueAt,
        observedAt: at,
        barDigest: "delayed-sip-bar-digest"
      },
      peakPriceUsd: 45,
      stopPriceUsd: 40.48,
      takeProfitPriceUsd: 49.28,
      scoreAtEntry: 80,
      openedAt: "2026-07-17T13:00:00.000Z",
      updatedAt: at
    }];

    const html = renderToStaticMarkup(createElement(StockPaperPanel, { stock: input }));

    expect(html).toContain("Delayed SIP fair-value marks are active");
    expect(html).toContain("cannot make a position executable");
    expect(html).toContain("Delayed SIP");
    expect(html).toContain("Unpriced");
  });
});
