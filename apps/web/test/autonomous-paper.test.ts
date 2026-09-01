import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AUTONOMOUS_PAPER_LABEL,
  AUTONOMOUS_PAPER_REPLAY_LABEL,
  AUTONOMOUS_PAPER_REPLAY_VERSION,
  TOKEN_PROGRAM_ID,
  type AutonomousPaperDashboard,
  type AutonomousPaperMarketSnapshot,
  type AutonomousPaperPolicy
} from "@copylab/shared";
import { AutonomousPaperPanel } from "../src/components/AutonomousPaperPanel";

const NOW = "2026-07-14T12:00:00.000Z";
const SCAN_AT = "2026-07-14T12:03:08.000Z";
const MINT = "A".repeat(44);

const policy: AutonomousPaperPolicy = {
  scanIntervalMinutes: 5,
  confirmationSamples: 2,
  allowToken2022: false,
  adaptiveSizingEnabled: false,
  maximumEntriesPerUtcDay: Number.MAX_SAFE_INTEGER,
  minimumEntrySpacingMinutes: 0,
  minimumPositionUsd: 5,
  positionNavFraction: 0.2,
  maximumPositionUsd: 25,
  maximumOpenPositions: 3,
  maximumDeployedFraction: 0.6,
  minimumLiquidReserveUsd: 10,
  minimumAgeDays: 7,
  minimumLiquidityUsd: 500_000,
  minimumVolume24hUsd: 250_000,
  minimumHolderCount: 500,
  minimumOrganicScore: 60,
  maximumTopHoldersPercent: 45,
  minimumMarketCapUsd: 1_000_000,
  maximumMarketCapUsd: 100_000_000,
  maximumFdvToMarketCap: 3,
  minimumMomentumScore: 70,
  minimumPriceChange5mPercent: 0.5,
  maximumPriceChange5mPercent: 10,
  minimumPriceChange1hPercent: 2,
  maximumPriceChange1hPercent: 25,
  minimumPriceChange6hPercent: 0,
  maximumPriceChange6hPercent: 60,
  maximumPriceChange24hPercent: 120,
  minimumOrganicBuyShare5m: 0.55,
  minimumOrganicBuyShare1h: 0.5,
  minimumOrganicVolume5mUsd: 5_000,
  minimumOrganicVolume1hUsd: 25_000,
  minimumOrganicBuyers5m: 5,
  minimumVolumeAccelerationRatio: 0.05,
  minimumLiquidityChange1hPercent: -5,
  minimumSolPriceChange1hPercent: -3,
  minimumSolPriceChange6hPercent: -8,
  minimumSolRelativeStrength1hPercent: 1,
  maximumPriceImpactPercent: 1,
  maximumRoundTripCostPercent: 3,
  stopLossPercent: 15,
  breakEvenActivationPercent: 10,
  trailingActivationPercent: 20,
  trailingDrawdownPercent: 8,
  takeProfitPercent: 50,
  weakMomentumExitSamples: 3,
  noProgressMinutes: 90,
  maximumHoldingMinutes: 720,
  cooldownMinutes: 30,
  stopCooldownMinutes: 120,
  dailyLossPausePercent: 10,
  maximumDrawdownPercent: 25,
  adaptiveSizingMinimumTrades: 20,
  adaptiveSizingWindowTrades: 100,
  adaptiveSizingPriorWins: 5,
  adaptiveSizingPriorLosses: 5,
  adaptiveSizingFractionalKelly: 0.5,
  adaptiveSizingMinimumCalibrationMultiplier: 0.25,
  adaptiveSizingMaximumCalibrationMultiplier: 1.25,
  adaptiveSizingMaximumLossStreak: 3,
  adaptiveSizingLossStreakMultiplier: 0.8,
  contextualRewardEnabled: false,
  contextualRewardMinimumComparableTrades: 8,
  contextualRewardMaximumDistance: 0.4,
  contextualRewardPriorWeight: 4,
  contextualRewardGain: 0.5,
  contextualRewardMinimumEffectiveSamples: 4,
  contextualRewardMinimumDistinctMints: 4,
  contextualRewardMinimumDistinctUtcDays: 3,
  contextualRewardMaximumSamplesPerMint: 2,
  contextualRewardMinimumMultiplier: 0.75,
  contextualRewardMaximumMultiplier: 1.2
};

const snapshot: AutonomousPaperMarketSnapshot = {
  capturedAt: NOW,
  sourceUpdatedAt: NOW,
  mint: MINT,
  symbol: "MOVE",
  name: "Momentum Test",
  decimals: 6,
  tokenProgram: TOKEN_PROGRAM_ID,
  verified: true,
  suspicious: false,
  mintAuthorityDisabled: true,
  freezeAuthorityDisabled: true,
  tokenAgeDays: 40,
  priceUsd: 0.2,
  marketCapUsd: 10_000_000,
  fdvUsd: 12_000_000,
  liquidityUsd: 2_000_000,
  liquidityChange1hPercent: 4,
  volume24hUsd: 3_000_000,
  holderCount: 4_000,
  organicScore: 82,
  topHoldersPercent: 28,
  priceChange5mPercent: 6,
  priceChange1hPercent: 12,
  priceChange6hPercent: 18,
  priceChange24hPercent: 30,
  organicBuyShare5m: 0.68,
  organicBuyShare1h: 0.61,
  organicVolume5mUsd: 40_000,
  organicVolume1hUsd: 350_000,
  organicBuyers5m: 120,
  volumeAccelerationRatio: 1.8,
  buySellRatio: 1.7,
  momentumScore: 84,
  categoryRanks: { volume24h: 12, momentum: 4 }
};

function dashboard(status: "ACTIVE" | "PAUSED" = "ACTIVE"): AutonomousPaperDashboard {
  return {
    label: AUTONOMOUS_PAPER_LABEL,
    promotionEligible: false,
    executionEnabled: false,
    lane: {
      id: "autonomous-lane",
      label: AUTONOMOUS_PAPER_LABEL,
      purpose: "RESEARCH_ONLY",
      policyVersion: "autonomous-momentum-v1",
      policy,
      initialNavUsd: 141,
      status,
      startedAt: NOW,
      updatedAt: NOW
    },
    account: {
      laneId: "autonomous-lane",
      initialNavUsd: 141,
      cashUsd: 116,
      navUsd: 145,
      peakNavUsd: 147,
      deployedUsd: 25,
      realizedPnlUsd: 1,
      unrealizedPnlUsd: 3,
      maxDrawdownPercent: 8,
      openPositions: 1,
      completedTrades: 2,
      winningTrades: 1,
      grossProfitUsd: 7,
      grossLossUsd: 6,
      pricingComplete: true,
      updatedAt: NOW
    },
    positions: [{
      id: "position-1",
      laneId: "autonomous-lane",
      entryDecisionId: "decision-buy",
      mint: MINT,
      symbol: "MOVE",
      initialAmountAtomic: "125000000",
      remainingAmountAtomic: "125000000",
      entryCostUsd: 25,
      remainingCostUsd: 25,
      lastExecutableValueUsd: 29,
      peakExecutableValueUsd: 31,
      entryPriceUsd: 0.2,
      lastPriceUsd: 0.232,
      stopPriceUsd: 0.17,
      breakEvenPriceUsd: 0.2,
      trailingStopPriceUsd: 0.218,
      takeProfitPriceUsd: 0.3,
      weakMomentumSamples: 0,
      status: "OPEN",
      openedAt: NOW,
      updatedAt: NOW
    }],
    recentDecisions: [{
      id: "decision-buy",
      laneId: "autonomous-lane",
      action: "BUY",
      outcome: "SIMULATED",
      mint: MINT,
      symbol: "MOVE",
      score: 84,
      reasons: ["Momentum, organic flow, liquidity, and executable cost gates passed."],
      snapshot,
      positionId: "position-1",
      modeledPositionUsd: 25,
      projectedRoundTripCostPercent: 1.4,
      stressRoundTripCostPercent: 2.1,
      decidedAt: NOW
    }],
    recentTrades: [{
      id: "trade-1",
      laneId: "autonomous-lane",
      positionId: "position-closed",
      entryDecisionId: "decision-old-buy",
      exitDecisionId: "decision-old-sell",
      mint: "B".repeat(44),
      symbol: "OLD",
      exitReason: "TRAILING_STOP",
      openedAt: NOW,
      closedAt: NOW,
      proceedsUsd: 31,
      costBasisUsd: 25,
      modeledCostsUsd: 0.3,
      pnlUsd: 5.7,
      returnPercent: 22.8
    }],
    lastScanAt: SCAN_AT,
    updatedAt: NOW
  };
}

function renderAutonomous(autonomous: AutonomousPaperDashboard): string {
  return renderToStaticMarkup(createElement(AutonomousPaperPanel, {
    autonomous,
    strictNavUsd: 141,
    csrfToken: "csrf-value",
    onRefresh: async () => undefined,
    notify: () => undefined
  }));
}

function learningDashboard(): AutonomousPaperDashboard {
  const autonomous = dashboard();
  return {
    ...autonomous,
    lane: {
      ...autonomous.lane!,
      policyVersion: "autonomous-regime-adaptive-paper-v13"
    },
    learning: {
      databaseSchemaVersion: 3,
      status: "COLLECTING",
      currentRegime: "HIGH_VOLATILITY",
      pendingEpisodes: 2,
      activeEpisodes: 6,
      completedExecutablePaths: 4,
      cohortPendingEpisodes: 2,
      cohortActiveEpisodes: 6,
      cohortCompletedEpisodes: 4,
      datasetEligiblePaths: 4,
      policyCohortVersion: "autonomous-regime-adaptive-paper-v13",
      cohortDatasetEligiblePaths: 4,
      historicalDatasetEligiblePaths: 0,
      pathObservationCount: 48,
      densePathCoveragePercent: 100,
      quoteCoveragePercent: 100,
      modelInfluenceEnabled: false,
      minimumPathsForModelInfluence: 200,
      quoteWorkBudgetFraction: 0.4,
      activeModels: [],
      armScores: [],
      challengers: [],
      recentAttributions: [],
      simulationArena: {
        version: "shadow-simulation-arena-v1",
        status: "COLLECTING",
        candidatePolicyCount: 7_776,
        pendingOrActiveProbePaths: 3,
        completedProbePaths: 2,
        datasetEligibleProbePaths: 2,
        independentPathCount: 4,
        denseIndependentPathCount: 4,
        latestScorableScenarioEvaluations: 12_345,
        capitalInfluenceEnabled: false,
        correlatedScenariosAreIndependentEvidence: false,
        reasonCodes: [
          "SIMULATION_PROBES_CANNOT_USE_CAPITAL",
          "POLICY_VARIANTS_ARE_CORRELATED_COUNTERFACTUALS"
        ]
      },
      promotion: {
        id: "learning-promotion-blocked",
        allowed: false,
        blockerCodes: ["NEEDS_300_EXECUTABLE_SHADOW_PATHS"],
        observedDays: 1,
        executableShadowPaths: 4,
        championCompletedExits: 0,
        profitableWalkForwardFolds: 0,
        lowerConfidenceDifferencePercent: -100,
        decidedAt: NOW
      },
      updatedAt: NOW
    }
  };
}

function replayDashboard(): AutonomousPaperDashboard {
  const autonomous = dashboard();
  return {
    ...autonomous,
    recentDecisions: [{
      ...autonomous.recentDecisions[0]!,
      id: "decision-controlled-exploration",
      reasons: [
        "CONTROLLED_EXPLORATION",
        "Quote and safety ceilings passed for bounded PAPER evidence collection."
      ]
    }, ...autonomous.recentDecisions],
    replayLab: {
      label: AUTONOMOUS_PAPER_REPLAY_LABEL,
      executionEnabled: false,
      promotionEligible: false,
      calibrationTradeCount: 0,
      independentEpisodeCount: 7,
      scenarioEvaluations: 3_000,
      capturingEpisodes: 2,
      readyEpisodes: 1,
      replayedEpisodes: 3,
      incompleteEpisodes: 1,
      recentEpisodes: [{
        id: "replay-episode-1",
        laneId: "autonomous-lane",
        positionId: "position-closed",
        entryDecisionId: "decision-old-buy",
        mint: "B".repeat(44),
        symbol: "OLD",
        policyVersion: "autonomous-momentum-paper-v8",
        replayVersion: AUTONOMOUS_PAPER_REPLAY_VERSION,
        scenarioManifestDigest: "manifest-digest",
        status: "REPLAYED",
        actualOpenedAt: NOW,
        captureStartedAt: NOW,
        horizonEndsAt: NOW,
        actualClosedAt: NOW,
        observationCount: 61,
        pathDigest: "path-digest",
        completedAt: NOW,
        updatedAt: NOW
      }],
      recentReports: [{
        id: "replay-report-1",
        episodeId: "replay-episode-1",
        laneId: "autonomous-lane",
        positionId: "position-closed",
        replayVersion: AUTONOMOUS_PAPER_REPLAY_VERSION,
        scenarioManifestDigest: "manifest-digest",
        pathDigest: "path-digest",
        resultsDigest: "results-digest",
        variantCount: 1_000,
        scorableVariantCount: 998,
        independentEpisodeCount: 1,
        calibrationTradeCount: 0,
        replayResultsAreIndependentTrades: false,
        baselineVariantId: "baseline-v8",
        baselineReturnPercent: 2,
        hindsightBestVariantId: "hindsight-417",
        hindsightBestReturnPercent: 8.5,
        hindsightRegretPercent: 6.5,
        generatedAt: NOW
      }],
      recentInsights: [{
        reportId: "replay-report-1",
        episodeId: "replay-episode-1",
        classification: "PROFITABLE_TESTED_ALTERNATIVE",
        evaluatedVariantCount: 1_000,
        profitableVariantCount: 237,
        pathDiagnosis: "TESTED_POLICY_FOUND_PROFIT",
        actualExit: {
          observationKey: "replay-observation-20",
          observedAt: NOW,
          executableValueUsd: 29.4,
          pnlUsd: -0.6,
          returnPercent: -2
        },
        bestVariant: {
          variantId: "hindsight-417",
          variantIndex: 417,
          parameters: {
            entryDelaySamples: 1,
            confirmationSamples: 2,
            minimumMomentumScore: 72,
            stopLossPercent: 9,
            breakEvenActivationPercent: 4,
            trailingActivationPercent: 8,
            trailingDrawdownPercent: 3,
            takeProfitPercent: 16,
            weakMomentumExitSamples: 4,
            noProgressMinutes: 45,
            maximumHoldingMinutes: 180
          },
          exitReason: "TAKE_PROFIT",
          exitedAt: NOW,
          pnlUsd: 1.2,
          returnPercent: 8.5
        },
        improvementPercentPoints: 6.5,
        bestObservedExit: {
          observationKey: "replay-observation-61",
          phase: "POST_EXIT",
          observedAt: NOW,
          executableValueUsd: 32.4,
          pnlUsd: 2.4,
          returnPercent: 9.1
        },
        observedProfitableExit: true
      }],
      updatedAt: NOW
    }
  };
}

function drainingUpgradeDashboard(): AutonomousPaperDashboard {
  return {
    ...dashboard(),
    upgradeDrain: {
      laneId: "autonomous-lane",
      fromPolicyVersion: "autonomous-momentum-paper-v7",
      toPolicyVersion: "autonomous-momentum-paper-v8",
      requestedAt: NOW,
      status: "DRAINING"
    }
  } as AutonomousPaperDashboard & {
    upgradeDrain: {
      laneId: string;
      fromPolicyVersion: string;
      toPolicyVersion: string;
      requestedAt: string;
      status: "DRAINING";
    };
  };
}

describe("autonomous momentum PAPER panel", () => {
  it("makes isolation and the lack of profit guarantees unmistakable", () => {
    const html = renderAutonomous(dashboard());
    expect(html).toContain(AUTONOMOUS_PAPER_LABEL);
    expect(html).toContain("Third comparison lane");
    expect(html).toContain("No execution path");
    expect(html).toContain("Strict account isolated");
    expect(html).toContain("Independent ledger");
    expect(html).toContain("cannot touch the strict account&#x27;s current $141.00 NAV");
    expect(html).toContain("profit is not guaranteed");
    expect(html).toContain("Pause autonomous PAPER");
    expect(html).toContain("Last scan");
    expect(html).toContain("Daily entry cap");
    expect(html).toContain("Unlimited");
    expect(html).toContain("At most one new position per scan");
  });

  it("shows the account, active stop, target, decision evidence, and completed trade", () => {
    const html = renderAutonomous(dashboard());
    expect(html).toContain("$145.00");
    expect(html).toContain("Open positions, stops, and targets");
    expect(html).toContain("Trailing $0.22");
    expect(html).toContain("$0.30");
    expect(html).toContain("Why the bot acted or passed");
    expect(html).toContain("Momentum, organic flow, liquidity, and executable cost gates passed.");
    expect(html).toContain("Round trip");
    expect(html).toContain("Trailing Stop");
    expect(html).toContain("+$5.70");
  });

  it("offers enable when the autonomous lane is paused", () => {
    expect(renderAutonomous(dashboard("PAUSED"))).toContain("Enable autonomous PAPER");
  });

  it("keeps archived dashboards compatible when Replay Lab evidence is absent", () => {
    const html = renderAutonomous(dashboard());
    expect(html).not.toContain("Replay Lab: actual paths vs 1,000 exit scenarios");
    expect(html).not.toContain("HINDSIGHT ONLY");
    expect(html).not.toContain("New entries paused");
    expect(html).not.toContain("Explicit upgrade retry needed once flat");
  });

  it("shows the simulation arena as high-throughput research with no bankroll authority", () => {
    const html = renderAutonomous(learningDashboard());
    expect(html).toContain("Shadow Simulation Arena");
    expect(html).toContain("7,776");
    expect(html).toContain("12,345");
    expect(html).toContain("Capital influence: NO");
    expect(html).toContain("One path stays one sample");
    expect(html).toContain("correlated policy replays never become");
    expect(html).toContain("Simulation Probes Cannot Use Capital");
  });

  it("explains a pending policy upgrade drain without implying forced liquidation or an automatic switch", () => {
    const html = renderAutonomous(drainingUpgradeDashboard());
    expect(html).toContain("Autonomous PAPER policy upgrade draining");
    expect(html).toContain("New entries paused");
    expect(html).toContain("autonomous-momentum-paper-v7");
    expect(html).toContain("autonomous-momentum-paper-v8");
    expect(html).toContain("Natural PAPER exits continue");
    expect(html).toContain("No forced liquidation");
    expect(html).toContain("Explicit upgrade retry needed once flat");
    expect(html).toContain("it will not switch policies automatically");
  });

  it("shows Replay Lab throughput without presenting scenarios as trades or sizing evidence", () => {
    const html = renderAutonomous(replayDashboard());
    expect(html).toContain("Replay Lab: actual paths vs 1,000 exit scenarios");
    expect(html).toContain("Capturing");
    expect(html).toContain("Completed");
    expect(html).toContain("Incomplete");
    expect(html).toContain("Independent episodes");
    expect(html).toContain("Scenario evaluations");
    expect(html).toContain("3,000");
    expect(html).toContain("1,000 variants per completed path");
    expect(html).toContain("7 independent episodes vs 3,000 correlated evaluations");
    expect(html).toContain("Execution disabled");
    expect(html).toContain("Used by sizing: NO");
    expect(html).toContain("Episodes, not trades");
  });

  it("labels recent actual-vs-hindsight regret and controlled exploration honestly", () => {
    const html = renderAutonomous(replayDashboard());
    expect(html).toContain("Recent actual-vs-hindsight regret");
    expect(html).toContain("HINDSIGHT ONLY");
    expect(html).toContain("Actual PAPER trade -$0.60 (-2.0%)");
    expect(html).toContain("Frozen replay baseline 2.0%");
    expect(html).toContain("hindsight best 8.5%");
    expect(html).toContain("baseline gap 6.5 percentage points");
    expect(html).toContain("1 independent episode");
    expect(html).toContain("1,000 correlated scenario evaluations");
    expect(html).toContain("998 scorable");
    expect(html).toContain("CONTROLLED_EXPLORATION");
    expect(html).toContain("Controlled PAPER evidence collection:");
    expect(html).toContain("Frozen policy unchanged");
  });

  it("shows the exact hindsight move, policy-grid diagnosis, and path oracle without implying authority", () => {
    const html = renderAutonomous(replayDashboard());
    expect(html).toContain("PROFITABLE TESTED ALTERNATIVE");
    expect(html).toContain("Best tested alternative:");
    expect(html).toContain("Take Profit at");
    expect(html).toContain("+$1.20 (8.5%)");
    expect(html).toContain("an improvement over the actual trade of 6.50 percentage points");
    expect(html).toContain("Profitable tested variants:");
    expect(html).toContain("237 of 998 scorable (1,000 evaluated)");
    expect(html).toContain("at least one of the 1,000 tested policies finished profitable");
    expect(html).toContain("Exact tested parameters for variant #418");
    expect(html).toContain("Entry delay 1 samples");
    expect(html).toContain("Weak-momentum exit 4 samples");
    expect(html).toContain("Maximum hold 180 min");
    expect(html).toContain("Best observed executable sell — path oracle, not a policy:");
    expect(html).toContain("Profitable observed exit: YES");
    expect(html).toContain("Cannot affect NAV, rewards, sizing, policy, promotion, execution, approvals, or signing");
  });

  it("renders an archived replay payload that predates dashboard-only insights", () => {
    const autonomous = replayDashboard();
    delete autonomous.replayLab?.recentInsights;
    const html = renderAutonomous(autonomous);

    expect(html).toContain("Recent actual-vs-hindsight regret");
    expect(html).toContain("Frozen replay baseline 2.0%");
    expect(html).not.toContain("Exact tested parameters");
    expect(html).not.toContain("path oracle");
  });

  it("distinguishes reduced loss, no improvement, and unscorable evidence in plain language", () => {
    const reducedLoss = replayDashboard();
    Object.assign(reducedLoss.replayLab!.recentInsights![0]!, {
      classification: "REDUCED_LOSS_ONLY",
      pathDiagnosis: "GRID_POLICY_GAP",
      profitableVariantCount: 0
    });
    const reducedHtml = renderAutonomous(reducedLoss);
    expect(reducedHtml).toContain("REDUCED LOSS ONLY");
    expect(reducedHtml).toContain("Grid/policy gap:");

    const noImprovement = replayDashboard();
    Object.assign(noImprovement.replayLab!.recentInsights![0]!, {
      classification: "NO_IMPROVEMENT",
      pathDiagnosis: "ENTRY_QUALITY_PROBLEM",
      profitableVariantCount: 0,
      improvementPercentPoints: 0,
      observedProfitableExit: false
    });
    const noImprovementHtml = renderAutonomous(noImprovement);
    expect(noImprovementHtml).toContain("NO TESTED IMPROVEMENT");
    expect(noImprovementHtml).toContain("Best tested result; no alternative improved the actual trade:");
    expect(noImprovementHtml).toContain("Entry-quality problem:");

    const unscorable = replayDashboard();
    Object.assign(unscorable.replayLab!.recentInsights![0]!, {
      classification: "UNSCORABLE",
      pathDiagnosis: "UNSCORABLE",
      bestVariant: undefined,
      improvementPercentPoints: undefined,
      bestObservedExit: undefined,
      observedProfitableExit: false
    });
    const unscorableHtml = renderAutonomous(unscorable);
    expect(unscorableHtml).toContain("UNSCORABLE");
    expect(unscorableHtml).toContain("No completed variant had enough evidence to name a move.");
    expect(unscorableHtml).toContain("Diagnosis unavailable:");
  });
});
