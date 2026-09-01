import { afterEach, describe, expect, it } from "vitest";
import {
  AUTONOMOUS_PAPER_LABEL,
  AUTONOMOUS_PAPER_REPLAY_VARIANT_COUNT,
  AUTONOMOUS_PAPER_REPLAY_VERSION,
  TOKEN_PROGRAM_ID,
  type AutonomousPaperDecision,
  type AutonomousPaperEvent,
  type AutonomousPaperMarketSnapshot,
  type AutonomousPaperPolicy,
  type AutonomousPaperPosition,
  type AutonomousPaperReplayEpisode,
  type AutonomousPaperReplayObservation,
  type AutonomousPaperReplayReport,
  type AutonomousPaperReplayVariantParameters,
  type AutonomousPaperReplayVariantResult,
  type AutonomousPaperTrade
} from "@copylab/shared";
import { createHash } from "node:crypto";
import type { CopyLabDatabase } from "../src/database.js";
import { openDatabase } from "../src/database.js";
import {
  AUTONOMOUS_PAPER_UPGRADE_DRAIN_SETTING,
  deriveAutonomousPaperReplayInsight,
  Repository
} from "../src/repository.js";

const TARGET_MINT = "AutonomousTargetMint1111111111111111111111111";
const SECOND_MINT = "AutonomousSecondMint1111111111111111111111111";

function policy(): AutonomousPaperPolicy {
  return {
    scanIntervalMinutes: 5,
    confirmationSamples: 2,
    allowToken2022: false,
    adaptiveSizingEnabled: false,
    maximumEntriesPerUtcDay: Number.MAX_SAFE_INTEGER,
    minimumEntrySpacingMinutes: 0,
    minimumPositionUsd: 5,
    positionNavFraction: 0.2,
    maximumPositionUsd: 30,
    maximumOpenPositions: 3,
    maximumDeployedFraction: 0.6,
    minimumLiquidReserveUsd: 10,
    minimumAgeDays: 7,
    minimumLiquidityUsd: 1_000_000,
    minimumVolume24hUsd: 250_000,
    minimumHolderCount: 500,
    minimumOrganicScore: 50,
    maximumTopHoldersPercent: 40,
    minimumMarketCapUsd: 500_000,
    maximumMarketCapUsd: 50_000_000,
    maximumFdvToMarketCap: 3,
    minimumMomentumScore: 60,
    minimumPriceChange5mPercent: 0.5,
    maximumPriceChange5mPercent: 5,
    minimumPriceChange1hPercent: 2,
    maximumPriceChange1hPercent: 18,
    minimumPriceChange6hPercent: 0,
    maximumPriceChange6hPercent: 40,
    maximumPriceChange24hPercent: 80,
    minimumOrganicBuyShare5m: 0.6,
    minimumOrganicBuyShare1h: 0.55,
    minimumOrganicVolume5mUsd: 10_000,
    minimumOrganicVolume1hUsd: 50_000,
    minimumOrganicBuyers5m: 20,
    minimumVolumeAccelerationRatio: 0.1,
    minimumLiquidityChange1hPercent: -2,
    minimumSolPriceChange1hPercent: -2,
    minimumSolPriceChange6hPercent: -5,
    minimumSolRelativeStrength1hPercent: 2,
    maximumPriceImpactPercent: 1,
    maximumRoundTripCostPercent: 4,
    stopLossPercent: 12,
    breakEvenActivationPercent: 8,
    trailingActivationPercent: 15,
    trailingDrawdownPercent: 8,
    takeProfitPercent: 30,
    weakMomentumExitSamples: 3,
    noProgressMinutes: 120,
    maximumHoldingMinutes: 1_440,
    cooldownMinutes: 30,
    stopCooldownMinutes: 120,
    dailyLossPausePercent: 15,
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
    contextualRewardMaximumMultiplier: 1.2,
    riskAtStopSizingEnabled: false,
    normalRiskAtStopNavFraction: 0.03,
    highConvictionRiskAtStopNavFraction: 0.04,
    explorationRiskAtStopNavFraction: 0.02,
    maximumDeveloperClusterFraction: 1
  };
}

function snapshot(mint = TARGET_MINT, at = "2026-07-14T12:00:00.000Z"): AutonomousPaperMarketSnapshot {
  return {
    capturedAt: at,
    sourceUpdatedAt: at,
    mint,
    symbol: mint === TARGET_MINT ? "AUTO" : "AUTO2",
    decimals: 6,
    tokenProgram: TOKEN_PROGRAM_ID,
    verified: true,
    suspicious: false,
    mintAuthorityDisabled: true,
    freezeAuthorityDisabled: true,
    tokenAgeDays: 90,
    priceUsd: 1,
    marketCapUsd: 5_000_000,
    fdvUsd: 7_000_000,
    liquidityUsd: 2_000_000,
    liquidityChange1hPercent: 4,
    volume24hUsd: 1_500_000,
    holderCount: 4_000,
    organicScore: 80,
    topHoldersPercent: 20,
    priceChange5mPercent: 3,
    priceChange1hPercent: 8,
    priceChange6hPercent: 15,
    priceChange24hPercent: 20,
    organicBuyShare5m: 0.7,
    organicBuyShare1h: 0.65,
    organicVolume5mUsd: 50_000,
    organicVolume1hUsd: 200_000,
    organicBuyers5m: 80,
    volumeAccelerationRatio: 1.5,
    buySellRatio: 1.8,
    momentumScore: 82,
    categoryRanks: { toptrending5m: 3, toporganicscore5m: 4 }
  };
}

function decision(
  laneId: string,
  id = "decision-entry",
  mint = TARGET_MINT,
  at = "2026-07-14T12:00:01.000Z"
): AutonomousPaperDecision {
  return {
    id,
    laneId,
    action: "BUY",
    outcome: "SIMULATED",
    mint,
    symbol: mint === TARGET_MINT ? "AUTO" : "AUTO2",
    score: 82,
    reasons: ["Momentum and executable-cost checks passed."],
    snapshot: snapshot(mint),
    modeledPositionUsd: 28.2,
    projectedRoundTripCostPercent: 1.2,
    stressRoundTripCostPercent: 2.4,
    decidedAt: at
  };
}

function persistDecisionEvent(
  repository: Repository,
  input: {
    laneId: string;
    eventKey: string;
    action: AutonomousPaperDecision["action"];
    outcome: AutonomousPaperDecision["outcome"];
    at: string;
    reasons?: string[];
    decisionId?: string;
  }
): AutonomousPaperEvent {
  const mint = `${TARGET_MINT}-${input.eventKey}`;
  const claim: AutonomousPaperEvent = {
    eventKey: input.eventKey,
    laneId: input.laneId,
    kind: "DECISION",
    outcome: "CLAIMED",
    observedAt: input.at,
    mint,
    action: input.action
  };
  if (!repository.claimAutonomousPaperEvent(claim)) {
    throw new Error(`Failed to claim test event ${input.eventKey}.`);
  }
  const value: AutonomousPaperDecision = {
    id: input.decisionId ?? `decision-${input.eventKey}`,
    laneId: input.laneId,
    action: input.action,
    outcome: input.outcome,
    mint,
    score: 0,
    reasons: input.reasons ?? ["TEST_REASON"],
    snapshot: snapshot(mint, input.at),
    decidedAt: input.at
  };
  const terminal: AutonomousPaperEvent = {
    ...claim,
    outcome: input.outcome,
    reason: value.reasons.join(", "),
    decision: value,
    finalizedAt: input.at
  };
  if (!repository.finalizeAutonomousPaperEvent(terminal)) {
    throw new Error(`Failed to finalize test event ${input.eventKey}.`);
  }
  return terminal;
}

function candidateTerminalEvent(
  laneId: string,
  eventKey: string,
  action: "REJECT" | "OBSERVE",
  at: string,
  reasons: string[] = ["TEST_CANDIDATE_REASON"]
): AutonomousPaperEvent {
  const mint = `${TARGET_MINT}-${eventKey}`;
  const outcome = action === "REJECT" ? "REJECTED" : "ANALYSIS_ONLY";
  const value: AutonomousPaperDecision = {
    id: `decision-${eventKey}`,
    laneId,
    action,
    outcome,
    mint,
    score: 0,
    reasons,
    snapshot: snapshot(mint, at),
    decidedAt: at
  };
  return {
    eventKey,
    laneId,
    kind: "DECISION",
    mint,
    action,
    outcome,
    observedAt: at,
    reason: reasons.join(", "),
    decision: value,
    finalizedAt: at
  };
}

function persistTradeEvent(
  repository: Repository,
  trade: AutonomousPaperTrade,
  eventKey = `event-${trade.id}`,
  outcome: "SIMULATED" | "FAILED" = "SIMULATED"
): void {
  const claim: AutonomousPaperEvent = {
    eventKey,
    laneId: trade.laneId,
    kind: "TRADE",
    outcome: "CLAIMED",
    observedAt: trade.closedAt,
    mint: trade.mint,
    action: "SELL"
  };
  if (!repository.claimAutonomousPaperEvent(claim)) {
    throw new Error(`Failed to claim test trade ${trade.id}.`);
  }
  if (!repository.finalizeAutonomousPaperEvent({
    ...claim,
    outcome,
    reason: trade.exitReason,
    ...(outcome === "SIMULATED" ? { trade } : {}),
    finalizedAt: trade.closedAt
  })) throw new Error(`Failed to finalize test trade ${trade.id}.`);
}

function position(
  laneId: string,
  id = "autonomous-position-a",
  mint = TARGET_MINT,
  entryDecisionId = "decision-entry"
): AutonomousPaperPosition {
  return {
    id,
    laneId,
    entryDecisionId,
    mint,
    symbol: mint === TARGET_MINT ? "AUTO" : "AUTO2",
    initialAmountAtomic: "28000000",
    remainingAmountAtomic: "28000000",
    entryCostUsd: 28.2,
    remainingCostUsd: 28.2,
    lastExecutableValueUsd: 27.9,
    peakExecutableValueUsd: 27.9,
    entryPriceUsd: 1,
    lastPriceUsd: 1,
    stopPriceUsd: 0.88,
    takeProfitPriceUsd: 1.3,
    weakMomentumSamples: 0,
    status: "OPEN",
    openedAt: "2026-07-14T12:00:02.000Z",
    updatedAt: "2026-07-14T12:00:02.000Z"
  };
}

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

function replayEpisode(laneId: string): AutonomousPaperReplayEpisode {
  return {
    id: "replay-episode-a",
    laneId,
    positionId: "autonomous-position-a",
    entryDecisionId: "decision-entry",
    mint: TARGET_MINT,
    symbol: "AUTO",
    policyVersion: "momentum-v1",
    replayVersion: AUTONOMOUS_PAPER_REPLAY_VERSION,
    scenarioManifestDigest: replayManifestDigest(),
    status: "CAPTURING",
    actualOpenedAt: "2026-07-14T12:00:02.000Z",
    captureStartedAt: "2026-07-14T12:00:02.000Z",
    horizonEndsAt: "2026-07-14T12:06:00.000Z",
    observationCount: 0,
    updatedAt: "2026-07-14T12:00:02.000Z"
  };
}

function replayObservation(
  laneId: string,
  sequence: number,
  phase: AutonomousPaperReplayObservation["phase"],
  observedAt: string
): Extract<AutonomousPaperReplayObservation, { status: "EXECUTABLE" }> {
  return {
    observationKey: `replay-observation-${sequence}`,
    episodeId: "replay-episode-a",
    laneId,
    positionId: "autonomous-position-a",
    mint: TARGET_MINT,
    sequence,
    phase,
    observedAt,
    sourceUpdatedAt: observedAt,
    status: "EXECUTABLE",
    marketPriceUsd: 1 + sequence / 100,
    momentumScore: 82,
    priceChange5mPercent: 2,
    organicBuyShare5m: 0.7,
    staticSafetyEligible: true,
    signalEligible: true,
    positionCostBasisUsd: 28.2,
    ...(sequence === 0
      ? {
          entryEvidence: {
            inputUsd: 28,
            outputAmountAtomic: "28000000",
            modeledFeeUsd: 0.2,
            totalCostUsd: 28.2,
            priceImpactPercent: 0.2,
            slippageBps: 50,
            projectedRoundTripCostPercent: 1.2,
            quotedAt: observedAt
          }
        }
      : {}),
    exitEvidence: {
      inputAmountAtomic: "28000000",
      guaranteedProceedsUsd: 28 + sequence / 10,
      modeledFeeUsd: 0.1,
      executableValueUsd: 27.9 + sequence / 10,
      priceImpactPercent: 0.25,
      slippageBps: 50,
      quotedAt: observedAt
    }
  };
}

function replayParameters(index: number): AutonomousPaperReplayVariantParameters {
  return {
    entryDelaySamples: index,
    confirmationSamples: 1,
    minimumMomentumScore: 30,
    stopLossPercent: 10,
    breakEvenActivationPercent: 4,
    trailingActivationPercent: 8,
    trailingDrawdownPercent: 5,
    takeProfitPercent: 18,
    weakMomentumExitSamples: 3,
    noProgressMinutes: 45,
    maximumHoldingMinutes: 180
  };
}

function replayManifestDigest(): string {
  return digest(Array.from(
    { length: AUTONOMOUS_PAPER_REPLAY_VARIANT_COUNT },
    (_, index) => {
      const variantId = `variant-${index.toString().padStart(4, "0")}`;
      const configurationDigest = digest(JSON.stringify(replayParameters(index)));
      return `${index}:${variantId}:${configurationDigest}`;
    }
  ).join("\n"));
}

function replayResults(reportId: string, laneId: string): AutonomousPaperReplayVariantResult[] {
  return Array.from({ length: AUTONOMOUS_PAPER_REPLAY_VARIANT_COUNT }, (_, index) => {
    const parameters = replayParameters(index);
    return {
      reportId,
      episodeId: "replay-episode-a",
      laneId,
      positionId: "autonomous-position-a",
      variantIndex: index,
      variantId: `variant-${index.toString().padStart(4, "0")}`,
      configurationDigest: digest(JSON.stringify(parameters)),
      parameters,
      causal: true,
      independentTradeWeight: 0,
      outcome: index === 0 ? "COMPLETED" : "NO_ENTRY",
      ...(index === 0
        ? {
            entryObservationKey: "replay-observation-0",
            exitObservationKey: "replay-observation-2",
            exitReason: "TAKE_PROFIT" as const,
            enteredAt: "2026-07-14T12:00:02.000Z",
            exitedAt: "2026-07-14T12:04:00.000Z",
            costBasisUsd: 28.2,
            proceedsUsd: 28.1,
            pnlUsd: -0.1,
            returnPercent: -0.354609929,
            maximumDrawdownPercent: 1,
            reward: -0.03
          }
        : {})
    };
  });
}

function completedReplayVariant(
  variant: AutonomousPaperReplayVariantResult,
  pnlUsd: number,
  returnPercent: number
): AutonomousPaperReplayVariantResult {
  return {
    ...variant,
    outcome: "COMPLETED",
    entryObservationKey: "replay-observation-0",
    exitObservationKey: "replay-observation-3",
    exitReason: "TRAILING_STOP",
    enteredAt: "2026-07-14T12:00:02.000Z",
    exitedAt: "2026-07-14T12:06:00.000Z",
    costBasisUsd: 28.2,
    proceedsUsd: 28.2 + pnlUsd,
    pnlUsd,
    returnPercent,
    maximumDrawdownPercent: 1,
    reward: Math.max(-1, Math.min(1, returnPercent / 10))
  };
}

function replayReport(
  episode: AutonomousPaperReplayEpisode,
  results: readonly AutonomousPaperReplayVariantResult[]
): AutonomousPaperReplayReport {
  return {
    id: "replay-report-a",
    episodeId: episode.id,
    laneId: episode.laneId,
    positionId: episode.positionId,
    replayVersion: AUTONOMOUS_PAPER_REPLAY_VERSION,
    scenarioManifestDigest: episode.scenarioManifestDigest,
    pathDigest: episode.pathDigest!,
    resultsDigest: digest(results.map((result) => JSON.stringify(result)).join("\n")),
    variantCount: AUTONOMOUS_PAPER_REPLAY_VARIANT_COUNT,
    scorableVariantCount: AUTONOMOUS_PAPER_REPLAY_VARIANT_COUNT,
    independentEpisodeCount: 1,
    calibrationTradeCount: 0,
    replayResultsAreIndependentTrades: false,
    baselineVariantId: "variant-0000",
    baselineReturnPercent: -0.354609929,
    hindsightBestVariantId: "variant-0000",
    hindsightBestReturnPercent: -0.354609929,
    hindsightRegretPercent: 0,
    generatedAt: "2026-07-14T12:06:01.000Z"
  };
}

describe("Replay Lab dashboard hindsight insights", () => {
  const laneId = "autonomous-v1";
  const episode = {
    ...replayEpisode(laneId),
    pathDigest: "a".repeat(64)
  };
  const entry = replayObservation(laneId, 0, "ENTRY", "2026-07-14T12:00:02.000Z");

  it("names the exact profitable tested alternative without granting it trading authority", () => {
    const results = replayResults("replay-report-a", laneId);
    results[1] = completedReplayVariant(results[1]!, 0.5, 1.773049645);
    const insight = deriveAutonomousPaperReplayInsight(
      replayReport(episode, results),
      results,
      [
        entry,
        replayObservation(laneId, 1, "ACTUAL_EXIT", "2026-07-14T12:04:00.000Z"),
        replayObservation(laneId, 4, "POST_EXIT", "2026-07-14T12:06:00.000Z")
      ]
    );

    expect(insight).toMatchObject({
      classification: "PROFITABLE_TESTED_ALTERNATIVE",
      pathDiagnosis: "TESTED_POLICY_FOUND_PROFIT",
      evaluatedVariantCount: 1_000,
      profitableVariantCount: 1,
      bestVariant: {
        variantId: "variant-0001",
        variantIndex: 1,
        parameters: replayParameters(1),
        exitReason: "TRAILING_STOP",
        exitedAt: "2026-07-14T12:06:00.000Z",
        pnlUsd: 0.5,
        returnPercent: 1.773049645
      },
      observedProfitableExit: true
    });
    expect(insight.improvementPercentPoints).toBeCloseTo(2.482269503, 9);
    expect(insight).not.toHaveProperty("navUsd");
    expect(insight).not.toHaveProperty("reward");
    expect(insight).not.toHaveProperty("sizing");
    expect(insight).not.toHaveProperty("execution");
  });

  it("separates a reduced-loss policy result from a profitable later path mark", () => {
    const results = replayResults("replay-report-a", laneId);
    results[1] = completedReplayVariant(results[1]!, -0.05, -0.177304965);
    const insight = deriveAutonomousPaperReplayInsight(
      replayReport(episode, results),
      results,
      [
        entry,
        replayObservation(laneId, 1, "ACTUAL_EXIT", "2026-07-14T12:04:00.000Z"),
        replayObservation(laneId, 4, "POST_EXIT", "2026-07-14T12:06:00.000Z")
      ]
    );

    expect(insight).toMatchObject({
      classification: "REDUCED_LOSS_ONLY",
      pathDiagnosis: "GRID_POLICY_GAP",
      profitableVariantCount: 0,
      observedProfitableExit: true,
      bestObservedExit: {
        phase: "POST_EXIT"
      }
    });
    expect(insight.bestObservedExit?.executableValueUsd).toBeCloseTo(28.3, 10);
  });

  it("reports no improvement and an entry-quality problem when the whole observed path loses", () => {
    const results = replayResults("replay-report-a", laneId);
    const insight = deriveAutonomousPaperReplayInsight(
      replayReport(episode, results),
      results,
      [entry, replayObservation(laneId, 2, "ACTUAL_EXIT", "2026-07-14T12:04:00.000Z")]
    );

    expect(insight).toMatchObject({
      classification: "NO_IMPROVEMENT",
      pathDiagnosis: "ENTRY_QUALITY_PROBLEM",
      profitableVariantCount: 0,
      observedProfitableExit: false
    });
    expect(insight.improvementPercentPoints).toBeCloseTo(0, 9);
  });

  it("does not diagnose a bad entry when an unpriced gap could hide a profitable exit", () => {
    const results = replayResults("replay-report-a", laneId);
    const actualExit = replayObservation(
      laneId,
      2,
      "ACTUAL_EXIT",
      "2026-07-14T12:04:00.000Z"
    );
    const unpriced: AutonomousPaperReplayObservation = {
      observationKey: "replay-observation-3",
      episodeId: "replay-episode-a",
      laneId,
      positionId: "autonomous-position-a",
      mint: TARGET_MINT,
      sequence: 3,
      phase: "POST_EXIT",
      observedAt: "2026-07-14T12:05:00.000Z",
      sourceUpdatedAt: "2026-07-14T12:05:00.000Z",
      status: "UNPRICED",
      failureCode: "QUOTE_UNAVAILABLE",
      positionCostBasisUsd: 28.2
    };
    const insight = deriveAutonomousPaperReplayInsight(
      replayReport(episode, results),
      results,
      [entry, actualExit, unpriced]
    );

    expect(insight).toMatchObject({
      classification: "NO_IMPROVEMENT",
      pathDiagnosis: "UNSCORABLE",
      observedProfitableExit: false
    });
  });

  it("fails closed as unscorable when persisted variant coverage is incomplete", () => {
    const results = replayResults("replay-report-a", laneId);
    const insight = deriveAutonomousPaperReplayInsight(
      replayReport(episode, results),
      results.slice(0, -1),
      [entry]
    );

    expect(insight).toMatchObject({
      classification: "UNSCORABLE",
      pathDiagnosis: "UNSCORABLE",
      evaluatedVariantCount: 999,
      observedProfitableExit: false
    });
    expect(insight.improvementPercentPoints).toBeUndefined();
  });
});

describe("isolated autonomous paper repository", () => {
  let db: CopyLabDatabase | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("creates one frozen-policy account and resumes it without resetting NAV", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const lane = repository.createAutonomousPaperLane({
      id: "autonomous-v1",
      policyVersion: "momentum-v1",
      policy: policy(),
      initialNavUsd: 141,
      startedAt: "2026-07-14T12:00:00.000Z"
    });
    expect(lane).toMatchObject({
      label: AUTONOMOUS_PAPER_LABEL,
      purpose: "RESEARCH_ONLY",
      initialNavUsd: 141,
      status: "ACTIVE"
    });
    const account = repository.initializeAutonomousPaperAccount(lane.id);
    repository.upsertAutonomousPaperAccount({
      ...account,
      cashUsd: 112.8,
      navUsd: 140.7,
      deployedUsd: 28.2,
      unrealizedPnlUsd: -0.3,
      maxDrawdownPercent: (141 - 140.7) / 141 * 100,
      openPositions: 1,
      updatedAt: "2026-07-14T12:01:00.000Z"
    });

    expect(repository.pauseAutonomousPaperLane(lane.id, "2026-07-14T12:02:00.000Z")?.status)
      .toBe("PAUSED");
    expect(repository.resumeAutonomousPaperLane(lane.id, "2026-07-14T12:03:00.000Z")?.status)
      .toBe("ACTIVE");
    expect(repository.initializeAutonomousPaperAccount(lane.id)).toMatchObject({
      initialNavUsd: 141,
      cashUsd: 112.8,
      navUsd: 140.7,
      openPositions: 1
    });
    expect(() => repository.createAutonomousPaperLane({
      id: lane.id,
      policyVersion: lane.policyVersion,
      policy: { ...policy(), maximumPositionUsd: 40 },
      initialNavUsd: 141
    })).toThrow("cannot change its frozen policy");
  });

  it("returns the latest material trade for only the requested mint", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const lane = repository.createAutonomousPaperLane({
      id: "autonomous-latest-trade",
      policyVersion: "momentum-v1",
      policy: policy(),
      initialNavUsd: 141,
      startedAt: "2026-07-14T12:00:00.000Z"
    });
    const trade = (
      id: string,
      mint: string,
      closedAt: string
    ): AutonomousPaperTrade => ({
      id,
      laneId: lane.id,
      positionId: `position-${id}`,
      entryDecisionId: `entry-${id}`,
      exitDecisionId: `exit-${id}`,
      mint,
      exitReason: "TAKE_PROFIT",
      openedAt: "2026-07-14T12:00:00.000Z",
      closedAt,
      proceedsUsd: 30,
      costBasisUsd: 28,
      modeledCostsUsd: 0.2,
      pnlUsd: 1.8,
      returnPercent: 6.43
    });
    const targetOlder = trade(
      "target-older",
      TARGET_MINT,
      "2026-07-14T12:30:00.000Z"
    );
    const targetTieA = trade(
      "target-tie-a",
      TARGET_MINT,
      "2026-07-14T14:00:00.000Z"
    );
    const targetTieZ = trade(
      "target-tie-z",
      TARGET_MINT,
      "2026-07-14T14:00:00.000Z"
    );
    const second = trade(
      "second-latest",
      SECOND_MINT,
      "2026-07-14T15:00:00.000Z"
    );
    persistTradeEvent(repository, targetOlder, "trade-target-older");
    persistTradeEvent(repository, targetTieA, "trade-target-a");
    persistTradeEvent(repository, targetTieZ, "trade-target-z");
    persistTradeEvent(repository, second, "trade-second");

    // A newer failed TRADE event has no material trade payload and must not
    // hide the same latest successful trade that the former map/find path saw.
    persistTradeEvent(
      repository,
      trade("target-failed", TARGET_MINT, "2026-07-14T16:00:00.000Z"),
      "trade-target-failed",
      "FAILED"
    );

    expect(repository.latestAutonomousPaperTrade(lane.id, TARGET_MINT)).toEqual(targetTieZ);
    expect(repository.latestAutonomousPaperTrade(lane.id, SECOND_MINT)).toEqual(second);
    expect(repository.latestAutonomousPaperTrade(lane.id, "unknown-mint")).toBeUndefined();
  });

  it("persists one lane-bound policy-upgrade drain without changing the PAPER account", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const lane = repository.createAutonomousPaperLane({
      id: "autonomous-drain-v7",
      policyVersion: "autonomous-momentum-paper-v7",
      policy: policy(),
      initialNavUsd: 141,
      startedAt: "2026-07-14T12:00:00.000Z"
    });
    const before = repository.initializeAutonomousPaperAccount(
      lane.id,
      "2026-07-14T12:00:00.000Z"
    );
    expect(repository.autonomousPaperUpgradeDrainBlocksEntries(lane.id)).toBe(false);

    const drain = repository.requestAutonomousPaperUpgradeDrain({
      laneId: lane.id,
      fromPolicyVersion: lane.policyVersion,
      toPolicyVersion: "autonomous-momentum-paper-v8",
      requestedAt: "2026-07-14T12:01:00.000Z"
    });

    expect(drain).toEqual({
      laneId: lane.id,
      fromPolicyVersion: "autonomous-momentum-paper-v7",
      toPolicyVersion: "autonomous-momentum-paper-v8",
      requestedAt: "2026-07-14T12:01:00.000Z"
    });
    expect(new Repository(db).getAutonomousPaperUpgradeDrain()).toEqual(drain);
    expect(new Repository(db).autonomousPaperUpgradeDrainBlocksEntries(lane.id)).toBe(true);
    expect(repository.autonomousPaperDashboard(lane.id).upgradeDrain).toEqual(drain);
    expect(repository.requestAutonomousPaperUpgradeDrain({
      laneId: lane.id,
      fromPolicyVersion: lane.policyVersion,
      toPolicyVersion: "autonomous-momentum-paper-v8",
      requestedAt: "2026-07-14T12:02:00.000Z"
    })).toEqual(drain);
    expect(repository.pauseAutonomousPaperLane(lane.id, "2026-07-14T12:03:00.000Z")?.status)
      .toBe("PAUSED");
    expect(repository.getAutonomousPaperUpgradeDrain(lane.id)).toBeUndefined();
    expect(repository.resumeAutonomousPaperLane(lane.id, "2026-07-14T12:04:00.000Z")?.status)
      .toBe("ACTIVE");
    expect(repository.getAutonomousPaperUpgradeDrain(lane.id)).toEqual(drain);
    expect(repository.getAutonomousPaperAccount(lane.id)).toEqual(before);
  });

  it("rejects invalid upgrade-drain requests and hides mismatched or stale durable state", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const lane = repository.createAutonomousPaperLane({
      id: "autonomous-drain-validation",
      policyVersion: "autonomous-momentum-paper-v7",
      policy: policy(),
      initialNavUsd: 141,
      startedAt: "2026-07-14T12:00:00.000Z"
    });
    repository.initializeAutonomousPaperAccount(lane.id, lane.startedAt);

    expect(() => repository.requestAutonomousPaperUpgradeDrain({
      laneId: lane.id,
      fromPolicyVersion: "autonomous-momentum-paper-v6",
      toPolicyVersion: "autonomous-momentum-paper-v8",
      requestedAt: "2026-07-14T12:01:00.000Z"
    })).toThrow("must match the source policy version");
    expect(() => repository.requestAutonomousPaperUpgradeDrain({
      laneId: lane.id,
      fromPolicyVersion: lane.policyVersion,
      toPolicyVersion: lane.policyVersion,
      requestedAt: "2026-07-14T12:01:00.000Z"
    })).toThrow("metadata is invalid");
    expect(() => repository.requestAutonomousPaperUpgradeDrain({
      laneId: lane.id,
      fromPolicyVersion: lane.policyVersion,
      toPolicyVersion: "autonomous-momentum-paper-v8",
      requestedAt: "2026-07-14T11:59:59.000Z"
    })).toThrow("cannot be backdated");

    repository.setSetting(AUTONOMOUS_PAPER_UPGRADE_DRAIN_SETTING, {
      laneId: lane.id,
      fromPolicyVersion: "wrong-policy",
      toPolicyVersion: "autonomous-momentum-paper-v8",
      requestedAt: "2026-07-14T12:01:00.000Z"
    });
    expect(repository.getAutonomousPaperUpgradeDrain()).toBeUndefined();
    expect(repository.getAutonomousPaperUpgradeDrain("another-lane")).toBeUndefined();
    expect(repository.autonomousPaperUpgradeDrainBlocksEntries(lane.id)).toBe(true);
    expect(repository.autonomousPaperDashboard(lane.id)).not.toHaveProperty("upgradeDrain");

    repository.setSetting(AUTONOMOUS_PAPER_UPGRADE_DRAIN_SETTING, {
      laneId: lane.id,
      fromPolicyVersion: lane.policyVersion,
      toPolicyVersion: "autonomous-momentum-paper-v8",
      requestedAt: "2026-07-14T11:59:59.000Z"
    });
    expect(repository.getAutonomousPaperUpgradeDrain(lane.id)).toBeUndefined();
    expect(repository.autonomousPaperUpgradeDrainBlocksEntries(lane.id)).toBe(true);
    expect(repository.autonomousPaperDashboard(lane.id)).not.toHaveProperty("upgradeDrain");

    db.prepare("UPDATE settings SET value_json = '{' WHERE key = ?")
      .run(AUTONOMOUS_PAPER_UPGRADE_DRAIN_SETTING);
    expect(repository.getAutonomousPaperUpgradeDrain(lane.id)).toBeUndefined();
    expect(repository.autonomousPaperUpgradeDrainBlocksEntries(lane.id)).toBe(true);
    expect(() => repository.autonomousPaperDashboard(lane.id)).not.toThrow();
    expect(repository.getAutonomousPaperAccount(lane.id)).toMatchObject({
      initialNavUsd: 141,
      cashUsd: 141,
      navUsd: 141,
      openPositions: 0
    });
  });

  it("clears an upgrade drain only for its bound lane", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const lane = repository.createAutonomousPaperLane({
      id: "autonomous-drain-clear",
      policyVersion: "autonomous-momentum-paper-v7",
      policy: policy(),
      initialNavUsd: 141,
      startedAt: "2026-07-14T12:00:00.000Z"
    });
    const account = repository.initializeAutonomousPaperAccount(lane.id, lane.startedAt);
    const drain = repository.requestAutonomousPaperUpgradeDrain({
      laneId: lane.id,
      fromPolicyVersion: lane.policyVersion,
      toPolicyVersion: "autonomous-momentum-paper-v8",
      requestedAt: "2026-07-14T12:01:00.000Z"
    });

    expect(repository.clearAutonomousPaperUpgradeDrain("another-lane")).toBe(false);
    expect(repository.getAutonomousPaperUpgradeDrain(lane.id)).toEqual(drain);
    expect(repository.clearAutonomousPaperUpgradeDrain(lane.id)).toBe(true);
    expect(repository.clearAutonomousPaperUpgradeDrain(lane.id)).toBe(false);
    expect(repository.getAutonomousPaperUpgradeDrain(lane.id)).toBeUndefined();
    expect(repository.autonomousPaperUpgradeDrainBlocksEntries(lane.id)).toBe(false);
    expect(repository.autonomousPaperDashboard(lane.id)).not.toHaveProperty("upgradeDrain");
    expect(repository.getAutonomousPaperAccount(lane.id)).toEqual(account);
  });

  it("validates every token, cadence, and adaptive-sizing policy control", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const create = (candidate: unknown) => repository.createAutonomousPaperLane({
      id: "invalid-v6-policy",
      policyVersion: "autonomous-momentum-paper-v7",
      policy: candidate as AutonomousPaperPolicy,
      initialNavUsd: 141,
      startedAt: "2026-07-14T12:00:00.000Z"
    });

    const missing = { ...policy() } as Partial<AutonomousPaperPolicy>;
    delete missing.allowToken2022;
    expect(() => create(missing)).toThrow("boolean feature gate");
    expect(() => create({ ...policy(), allowToken2022: 1 })).toThrow("boolean feature gate");
    expect(() => create({ ...policy(), unexpectedControl: 1 })).toThrow("boolean feature gate");
    expect(() => create({ ...policy(), maximumEntriesPerUtcDay: 0 }))
      .toThrow("positive policy limits");
    expect(() => create({ ...policy(), maximumEntriesPerUtcDay: 1.5 }))
      .toThrow("count limits");
    expect(() => create({ ...policy(), minimumEntrySpacingMinutes: -1 }))
      .toThrow("cannot be negative");
    expect(() => create({ ...policy(), minimumPositionUsd: 4.99 }))
      .toThrow("adaptive-sizing controls");
    expect(() => create({
      ...policy(),
      adaptiveSizingMinimumTrades: 101,
      adaptiveSizingWindowTrades: 100
    })).toThrow("adaptive-sizing controls");
    expect(() => create({ ...policy(), adaptiveSizingLossStreakMultiplier: 1.01 }))
      .toThrow("adaptive-sizing controls");
    expect(() => create({ ...policy(), contextualRewardEnabled: 1 }))
      .toThrow("boolean feature gate");
    expect(() => create({ ...policy(), contextualRewardMinimumComparableTrades: 7.5 }))
      .toThrow("count limits");
    expect(() => create({
      ...policy(),
      contextualRewardMinimumComparableTrades: 8,
      contextualRewardMinimumDistinctMints: 3,
      contextualRewardMaximumSamplesPerMint: 2
    })).toThrow("adaptive-sizing controls");
    expect(() => create({ ...policy(), contextualRewardMaximumMultiplier: 0.99 }))
      .toThrow("adaptive-sizing controls");
    expect(() => create({ ...policy(), minimumEntrySpacingMinutes: 1.5 }))
      .toThrow("count limits");

    const lane = create({
      ...policy(),
      allowToken2022: true,
      adaptiveSizingEnabled: true,
      contextualRewardEnabled: true,
      maximumEntriesPerUtcDay: 8,
      minimumEntrySpacingMinutes: 10,
      maximumPositionUsd: Number.MAX_SAFE_INTEGER,
      positionNavFraction: 0.35,
      maximumDeployedFraction: 0.80
    });
    expect(repository.getAutonomousPaperLane(lane.id)?.policy).toMatchObject({
      allowToken2022: true,
      adaptiveSizingEnabled: true,
      contextualRewardEnabled: true,
      maximumEntriesPerUtcDay: 8,
      minimumEntrySpacingMinutes: 10,
      maximumPositionUsd: Number.MAX_SAFE_INTEGER,
      positionNavFraction: 0.35,
      maximumDeployedFraction: 0.80
    });
  });

  it("rotates a paused flat account into a distinct policy epoch without rewriting prior evidence", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const prior = repository.createAutonomousPaperLane({
      id: "autonomous-v1",
      policyVersion: "momentum-v1",
      policy: policy(),
      initialNavUsd: 141,
      startedAt: "2026-07-14T12:00:00.000Z"
    });
    const initial = repository.initializeAutonomousPaperAccount(
      prior.id,
      "2026-07-14T12:00:00.000Z"
    );
    const carriedAccount = {
      ...initial,
      cashUsd: 150,
      navUsd: 150,
      peakNavUsd: 150,
      realizedPnlUsd: 9,
      grossProfitUsd: 9,
      updatedAt: "2026-07-14T12:05:00.000Z"
    };
    repository.upsertAutonomousPaperAccount(carriedAccount);
    const evidence: AutonomousPaperEvent = {
      eventKey: "prior-policy-nav-evidence",
      laneId: prior.id,
      kind: "NAV_MARK",
      outcome: "CLAIMED",
      observedAt: "2026-07-14T12:05:00.000Z"
    };
    expect(repository.claimAutonomousPaperEvent(evidence)).toBe(true);
    expect(repository.finalizeAutonomousPaperEvent({
      ...evidence,
      outcome: "SIMULATED",
      navUsd: 150,
      reason: "Prior policy evidence remains immutable.",
      finalizedAt: "2026-07-14T12:05:01.000Z"
    })).toBe(true);
    expect(repository.pauseAutonomousPaperLane(prior.id, "2026-07-14T12:06:00.000Z")?.status)
      .toBe("PAUSED");

    const nextPolicy = {
      ...policy(),
      confirmationSamples: 1,
      positionNavFraction: 0.25,
      minimumLiquidityUsd: 250_000,
      minimumMomentumScore: 50
    };
    const next = repository.rotateAutonomousPaperLane({
      priorLaneId: prior.id,
      newLaneId: "autonomous-v2",
      policyVersion: "momentum-v2",
      policy: nextPolicy,
      rotatedAt: "2026-07-14T12:07:00.000Z"
    });

    expect(next).toMatchObject({
      id: "autonomous-v2",
      policyVersion: "momentum-v2",
      policy: nextPolicy,
      initialNavUsd: 150,
      status: "ACTIVE",
      startedAt: "2026-07-14T12:07:00.000Z"
    });
    expect(repository.getAutonomousPaperLane(prior.id)).toMatchObject({
      status: "ARCHIVED",
      archivedAt: "2026-07-14T12:07:00.000Z",
      policyVersion: "momentum-v1",
      initialNavUsd: 141
    });
    expect(repository.getAutonomousPaperAccount(prior.id)).toEqual(carriedAccount);
    expect(repository.getAutonomousPaperEvent(evidence.eventKey)).toMatchObject({
      laneId: prior.id,
      outcome: "SIMULATED",
      navUsd: 150
    });
    expect(repository.getAutonomousPaperAccount(next.id)).toMatchObject({
      laneId: next.id,
      initialNavUsd: 150,
      cashUsd: 150,
      navUsd: 150,
      peakNavUsd: 150,
      deployedUsd: 0,
      realizedPnlUsd: 0,
      unrealizedPnlUsd: 0,
      openPositions: 0,
      completedTrades: 0
    });
    expect(repository.activeAutonomousPaperLane()?.id).toBe(next.id);
    expect(repository.listAudit(10)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        eventType: "autonomous_paper_policy_rotated",
        details: expect.objectContaining({
          priorLaneId: prior.id,
          newLaneId: next.id,
          priorPolicyVersion: "momentum-v1",
          policyVersion: "momentum-v2",
          carryForwardNavUsd: 150,
          priorEventCount: 1,
          priorDataPreserved: true,
          executionEnabled: false,
          promotionEligible: false
        })
      })
    ]));
  });

  it("atomically consumes an exact policy-upgrade drain during rotation", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const prior = repository.createAutonomousPaperLane({
      id: "autonomous-drained-v7",
      policyVersion: "autonomous-momentum-paper-v7",
      policy: policy(),
      initialNavUsd: 141,
      startedAt: "2026-07-14T12:00:00.000Z"
    });
    repository.initializeAutonomousPaperAccount(prior.id, prior.startedAt);
    repository.requestAutonomousPaperUpgradeDrain({
      laneId: prior.id,
      fromPolicyVersion: prior.policyVersion,
      toPolicyVersion: "autonomous-momentum-paper-v8",
      requestedAt: "2026-07-14T12:01:00.000Z"
    });
    repository.pauseAutonomousPaperLane(prior.id, "2026-07-14T12:02:00.000Z");

    const next = repository.rotateAutonomousPaperLane({
      priorLaneId: prior.id,
      newLaneId: "autonomous-drained-v8",
      policyVersion: "autonomous-momentum-paper-v8",
      policy: { ...policy(), confirmationSamples: 1 },
      rotatedAt: "2026-07-14T12:03:00.000Z"
    });

    expect(next.status).toBe("ACTIVE");
    expect(repository.getSetting(AUTONOMOUS_PAPER_UPGRADE_DRAIN_SETTING)).toBeUndefined();
    expect(repository.autonomousPaperUpgradeDrainBlocksEntries(next.id)).toBe(false);
    expect(repository.listAudit(10)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        eventType: "autonomous_paper_policy_rotated",
        details: expect.objectContaining({ upgradeDrainConsumed: true })
      })
    ]));
  });

  it("fails rotation closed when a durable drain does not authorize its target policy", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const prior = repository.createAutonomousPaperLane({
      id: "autonomous-mismatched-drain-v7",
      policyVersion: "autonomous-momentum-paper-v7",
      policy: policy(),
      initialNavUsd: 141,
      startedAt: "2026-07-14T12:00:00.000Z"
    });
    repository.initializeAutonomousPaperAccount(prior.id, prior.startedAt);
    repository.requestAutonomousPaperUpgradeDrain({
      laneId: prior.id,
      fromPolicyVersion: prior.policyVersion,
      toPolicyVersion: "autonomous-momentum-paper-v9",
      requestedAt: "2026-07-14T12:01:00.000Z"
    });
    repository.pauseAutonomousPaperLane(prior.id, "2026-07-14T12:02:00.000Z");

    expect(() => repository.rotateAutonomousPaperLane({
      priorLaneId: prior.id,
      newLaneId: "autonomous-mismatched-drain-v8",
      policyVersion: "autonomous-momentum-paper-v8",
      policy: { ...policy(), confirmationSamples: 1 },
      rotatedAt: "2026-07-14T12:03:00.000Z"
    })).toThrow("blocked by invalid upgrade-drain state");
    expect(repository.getAutonomousPaperLane(prior.id)?.status).toBe("PAUSED");
    expect(repository.getAutonomousPaperLane("autonomous-mismatched-drain-v8")).toBeUndefined();
    expect(repository.autonomousPaperUpgradeDrainBlocksEntries(prior.id)).toBe(true);
  });

  it("refuses rotation while active, non-flat, or holding an unfinished autonomous claim", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const prior = repository.createAutonomousPaperLane({
      id: "autonomous-v1",
      policyVersion: "momentum-v1",
      policy: policy(),
      initialNavUsd: 141,
      startedAt: "2026-07-14T12:00:00.000Z"
    });
    const initial = repository.initializeAutonomousPaperAccount(
      prior.id,
      "2026-07-14T12:00:00.000Z"
    );
    const rotate = () => repository.rotateAutonomousPaperLane({
      priorLaneId: prior.id,
      newLaneId: "autonomous-v2",
      policyVersion: "momentum-v2",
      policy: { ...policy(), confirmationSamples: 1 },
      rotatedAt: "2026-07-14T12:10:00.000Z"
    });

    expect(rotate).toThrow("requires no active lane");
    repository.pauseAutonomousPaperLane(prior.id, "2026-07-14T12:01:00.000Z");
    const open = position(prior.id);
    repository.upsertAutonomousPaperPosition(open);
    repository.upsertAutonomousPaperAccount({
      ...initial,
      cashUsd: 112.8,
      navUsd: 140.7,
      deployedUsd: 28.2,
      unrealizedPnlUsd: -0.3,
      maxDrawdownPercent: (141 - 140.7) / 141 * 100,
      openPositions: 1,
      updatedAt: "2026-07-14T12:02:00.000Z"
    });
    expect(rotate).toThrow("flat, fully priced, reconciled");

    repository.upsertAutonomousPaperPosition({
      ...open,
      remainingAmountAtomic: "0",
      remainingCostUsd: 0,
      lastExecutableValueUsd: 0,
      status: "CLOSED",
      updatedAt: "2026-07-14T12:03:00.000Z",
      closedAt: "2026-07-14T12:03:00.000Z"
    });
    repository.upsertAutonomousPaperAccount({
      ...initial,
      updatedAt: "2026-07-14T12:03:00.000Z"
    });
    const unfinished: AutonomousPaperEvent = {
      eventKey: "unfinished-before-policy-rotation",
      laneId: prior.id,
      kind: "NAV_MARK",
      outcome: "CLAIMED",
      observedAt: "2026-07-14T12:04:00.000Z"
    };
    expect(repository.claimAutonomousPaperEvent(unfinished)).toBe(true);
    expect(rotate).toThrow("all autonomous claims to be finalized");

    expect(repository.getAutonomousPaperLane(prior.id)?.status).toBe("PAUSED");
    expect(repository.getAutonomousPaperLane("autonomous-v2")).toBeUndefined();
    expect(repository.getAutonomousPaperAccount("autonomous-v2")).toBeUndefined();
    expect(repository.listAudit(10).some((event) =>
      event.eventType === "autonomous_paper_policy_rotated"
    )).toBe(false);
  });

  it("rolls the archive, new lane, account, and audit back as one transaction", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const prior = repository.createAutonomousPaperLane({
      id: "autonomous-v1",
      policyVersion: "momentum-v1",
      policy: policy(),
      initialNavUsd: 141,
      startedAt: "2026-07-14T12:00:00.000Z"
    });
    repository.initializeAutonomousPaperAccount(prior.id, "2026-07-14T12:00:00.000Z");
    const drain = repository.requestAutonomousPaperUpgradeDrain({
      laneId: prior.id,
      fromPolicyVersion: prior.policyVersion,
      toPolicyVersion: "momentum-v2",
      requestedAt: "2026-07-14T12:00:30.000Z"
    });
    repository.pauseAutonomousPaperLane(prior.id, "2026-07-14T12:01:00.000Z");
    repository.db.exec(`
      CREATE TRIGGER reject_autonomous_rotation_audit
      BEFORE INSERT ON audit_events
      WHEN NEW.event_type = 'autonomous_paper_policy_rotated'
      BEGIN
        SELECT RAISE(ABORT, 'forced rotation audit failure');
      END;
    `);

    expect(() => repository.rotateAutonomousPaperLane({
      priorLaneId: prior.id,
      newLaneId: "autonomous-v2",
      policyVersion: "momentum-v2",
      policy: { ...policy(), confirmationSamples: 1 },
      rotatedAt: "2026-07-14T12:02:00.000Z"
    })).toThrow("forced rotation audit failure");

    const rolledBackPrior = repository.getAutonomousPaperLane(prior.id);
    expect(rolledBackPrior?.status).toBe("PAUSED");
    expect(rolledBackPrior).not.toHaveProperty("archivedAt");
    expect(repository.getAutonomousPaperLane("autonomous-v2")).toBeUndefined();
    expect(repository.getAutonomousPaperAccount("autonomous-v2")).toBeUndefined();
    expect(repository.activeAutonomousPaperLane()).toBeUndefined();
    expect(repository.getSetting(AUTONOMOUS_PAPER_UPGRADE_DRAIN_SETTING)).toEqual(drain);
    expect(repository.autonomousPaperUpgradeDrainBlocksEntries(prior.id)).toBe(true);
  });

  it("reports the newest completed scan separately from the account ledger timestamp", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const startedAt = "2026-07-14T12:00:00.000Z";
    const observedAt = "2026-07-14T12:03:00.000Z";
    const finalizedAt = "2026-07-14T12:03:08.000Z";
    const lane = repository.createAutonomousPaperLane({
      id: "autonomous-scan-freshness",
      policyVersion: "momentum-v1",
      policy: policy(),
      initialNavUsd: 141,
      startedAt
    });
    repository.initializeAutonomousPaperAccount(lane.id, startedAt);

    expect(repository.autonomousPaperDashboard(lane.id).lastScanAt).toBeUndefined();
    const scan: AutonomousPaperEvent = {
      eventKey: "autonomous-cycle-v1:scan-freshness",
      laneId: lane.id,
      kind: "NAV_MARK",
      outcome: "CLAIMED",
      observedAt
    };
    expect(repository.claimAutonomousPaperEvent(scan)).toBe(true);
    expect(repository.finalizeAutonomousPaperEvent({
      ...scan,
      outcome: "SIMULATED",
      navUsd: 141,
      reason: "Completed scan recorded without a balance mutation.",
      finalizedAt
    })).toBe(true);

    const dashboard = repository.autonomousPaperDashboard(lane.id);
    expect(dashboard.lastScanAt).toBe(finalizedAt);
    expect(dashboard.account?.updatedAt).toBe(startedAt);

    const newerDayStart: AutonomousPaperEvent = {
      eventKey: "autonomous-day-start-v1:newer-baseline",
      laneId: lane.id,
      kind: "NAV_MARK",
      outcome: "CLAIMED",
      observedAt: "2026-07-14T12:06:00.000Z"
    };
    expect(repository.claimAutonomousPaperEvent(newerDayStart)).toBe(true);
    expect(repository.finalizeAutonomousPaperEvent({
      ...newerDayStart,
      outcome: "SIMULATED",
      navUsd: 141,
      reason: "Daily baseline is not a completed market scan.",
      finalizedAt: "2026-07-14T12:06:01.000Z"
    })).toBe(true);
    const newerFailedCycle: AutonomousPaperEvent = {
      eventKey: "autonomous-cycle-v1:newer-failed-scan",
      laneId: lane.id,
      kind: "NAV_MARK",
      outcome: "CLAIMED",
      observedAt: "2026-07-14T12:09:00.000Z"
    };
    expect(repository.claimAutonomousPaperEvent(newerFailedCycle)).toBe(true);
    expect(repository.finalizeAutonomousPaperEvent({
      ...newerFailedCycle,
      outcome: "FAILED",
      reason: "Failed cycles must not claim fresh completed-scan status.",
      finalizedAt: "2026-07-14T12:09:01.000Z"
    })).toBe(true);
    expect(repository.autonomousPaperDashboard(lane.id).lastScanAt).toBe(finalizedAt);
  });

  it("claims and atomically commits a decision without touching strict or execution ledgers", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const lane = repository.createAutonomousPaperLane({
      id: "autonomous-v1",
      policyVersion: "momentum-v1",
      policy: policy()
    });
    const account = repository.initializeAutonomousPaperAccount(lane.id);
    const claim: AutonomousPaperEvent = {
      eventKey: "autonomous-entry-event",
      laneId: lane.id,
      kind: "DECISION",
      outcome: "CLAIMED",
      observedAt: "2026-07-14T12:00:01.000Z",
      mint: TARGET_MINT,
      action: "BUY"
    };
    expect(repository.claimAutonomousPaperEvent(claim)).toBe(true);
    expect(repository.claimAutonomousPaperEvent(claim)).toBe(false);
    const entry = decision(lane.id);
    const lot = position(lane.id);
    const replay = {
      episode: replayEpisode(lane.id),
      observation: replayObservation(
        lane.id,
        0,
        "ENTRY",
        "2026-07-14T12:00:02.000Z"
      )
    };
    const terminal: AutonomousPaperEvent = {
      ...claim,
      outcome: "SIMULATED",
      reason: "Quote-only autonomous entry was simulated.",
      navUsd: 140.7,
      decision: entry,
      finalizedAt: "2026-07-14T12:00:02.000Z"
    };
    expect(repository.commitAutonomousPaperEvent({
      event: terminal,
      account: {
        ...account,
        cashUsd: 112.8,
        navUsd: 140.7,
        deployedUsd: 28.2,
        unrealizedPnlUsd: -0.3,
        maxDrawdownPercent: (141 - 140.7) / 141 * 100,
        openPositions: 1,
        updatedAt: terminal.finalizedAt!
      },
      positions: [lot],
      replay
    })).toBe(true);
    expect(repository.commitAutonomousPaperEvent({ event: terminal })).toBe(false);
    expect(repository.latestAutonomousPaperDecision(lane.id, TARGET_MINT)).toEqual(entry);
    expect(repository.autonomousPaperDashboard()).toMatchObject({
      label: AUTONOMOUS_PAPER_LABEL,
      promotionEligible: false,
      executionEnabled: false,
      lane: { id: lane.id },
      account: { navUsd: 140.7, openPositions: 1 },
      positions: [{ id: lot.id }],
      recentDecisions: [{ id: entry.id }]
    });
    expect(repository.getAutonomousPaperReplayEpisode(replay.episode.id)).toMatchObject({
      ...replay.episode,
      observationCount: 1
    });
    expect(repository.listAutonomousPaperReplayObservations(replay.episode.id))
      .toEqual([replay.observation]);
    for (const table of [
      "source_events",
      "signal_decisions",
      "executions",
      "positions",
      "portfolio_snapshots",
      "closed_trades"
    ]) {
      expect(repository.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get())
        .toEqual({ count: 0 });
    }
  });

  it("batches auxiliary candidate claims and finalizations with exact retry idempotency", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const lane = repository.createAutonomousPaperLane({
      id: "autonomous-v1",
      policyVersion: "momentum-v1",
      policy: policy()
    });
    const rejected = candidateTerminalEvent(
      lane.id,
      "candidate-batch-rejected",
      "REJECT",
      "2026-07-14T12:00:01.000Z",
      ["MINT_AUTHORITY_ENABLED", "LOW_LIQUIDITY"]
    );
    const observed = candidateTerminalEvent(
      lane.id,
      "candidate-batch-observed",
      "OBSERVE",
      "2026-07-14T12:00:02.000Z",
      ["SIGNAL_PASSED", "WAIT_NEXT_SAMPLE"]
    );
    const legacyClaimed = candidateTerminalEvent(
      lane.id,
      "candidate-batch-legacy-claim",
      "REJECT",
      "2026-07-14T12:00:03.000Z"
    );
    expect(repository.claimAutonomousPaperEvent({
      eventKey: legacyClaimed.eventKey,
      laneId: legacyClaimed.laneId,
      kind: legacyClaimed.kind,
      mint: legacyClaimed.mint!,
      action: legacyClaimed.action!,
      outcome: "CLAIMED",
      observedAt: legacyClaimed.observedAt
    })).toBe(true);

    expect(repository.commitAutonomousPaperCandidateEvents([
      rejected,
      observed,
      legacyClaimed,
      rejected
    ])).toBe(2);
    expect(repository.getAutonomousPaperEvent(rejected.eventKey)).toMatchObject({
      outcome: "REJECTED",
      reason: "MINT_AUTHORITY_ENABLED, LOW_LIQUIDITY",
      decision: { reasons: ["MINT_AUTHORITY_ENABLED", "LOW_LIQUIDITY"] }
    });
    expect(repository.getAutonomousPaperEvent(observed.eventKey)).toMatchObject({
      outcome: "ANALYSIS_ONLY",
      decision: { reasons: ["SIGNAL_PASSED", "WAIT_NEXT_SAMPLE"] }
    });
    expect(repository.getAutonomousPaperEvent(legacyClaimed.eventKey)).toMatchObject({
      outcome: "CLAIMED"
    });
    const frozenRejected = repository.getAutonomousPaperEvent(rejected.eventKey);
    expect(repository.commitAutonomousPaperCandidateEvents([rejected, observed])).toBe(0);
    expect(repository.getAutonomousPaperEvent(rejected.eventKey)).toEqual(frozenRejected);

    const material: AutonomousPaperEvent = {
      ...rejected,
      eventKey: "candidate-batch-material-buy",
      action: "BUY",
      outcome: "SIMULATED",
      decision: {
        ...rejected.decision!,
        id: "candidate-batch-material-buy-decision",
        action: "BUY",
        outcome: "SIMULATED"
      }
    };
    expect(() => repository.commitAutonomousPaperCandidateEvents([material]))
      .toThrow(/only terminal REJECT\/OBSERVE/iu);
    expect(repository.getAutonomousPaperEvent(material.eventKey)).toBeUndefined();
    expect(repository.listExecutions()).toEqual([]);
  });

  it("rolls back every candidate event when any terminal finalization is malformed", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const lane = repository.createAutonomousPaperLane({
      id: "autonomous-v1",
      policyVersion: "momentum-v1",
      policy: policy()
    });
    const first = candidateTerminalEvent(
      lane.id,
      "candidate-batch-rollback-first",
      "REJECT",
      "2026-07-14T12:00:01.000Z"
    );
    const malformed = {
      ...candidateTerminalEvent(
        lane.id,
        "candidate-batch-rollback-malformed",
        "OBSERVE",
        "2026-07-14T12:00:02.000Z"
      ),
      finalizedAt: "2026-07-14T11:59:59.000Z"
    };

    expect(() => repository.commitAutonomousPaperCandidateEvents([first, malformed]))
      .toThrow(/cannot finalize before/iu);
    expect(repository.getAutonomousPaperEvent(first.eventKey)).toBeUndefined();
    expect(repository.getAutonomousPaperEvent(malformed.eventKey)).toBeUndefined();
    expect(repository.listClaimedAutonomousPaperEvents(lane.id)).toEqual([]);
  });

  it("never lets rejected replay evidence cancel an actual PAPER ledger commit", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const lane = repository.createAutonomousPaperLane({
      id: "autonomous-v1",
      policyVersion: "momentum-v1",
      policy: policy()
    });
    const account = repository.initializeAutonomousPaperAccount(lane.id);
    const lot = position(lane.id);
    const claim: AutonomousPaperEvent = {
      eventKey: "autonomous-entry-with-bad-replay",
      laneId: lane.id,
      kind: "DECISION",
      outcome: "CLAIMED",
      observedAt: "2026-07-14T12:00:01.000Z",
      mint: TARGET_MINT,
      action: "BUY"
    };
    expect(repository.claimAutonomousPaperEvent(claim)).toBe(true);
    expect(repository.commitAutonomousPaperEvent({
      event: {
        ...claim,
        outcome: "SIMULATED",
        decision: decision(lane.id),
        finalizedAt: "2026-07-14T12:00:02.000Z"
      },
      account: {
        ...account,
        cashUsd: 112.8,
        navUsd: 140.7,
        deployedUsd: 28.2,
        unrealizedPnlUsd: -0.3,
        maxDrawdownPercent: (141 - 140.7) / 141 * 100,
        openPositions: 1,
        updatedAt: "2026-07-14T12:00:02.000Z"
      },
      positions: [lot],
      replay: {
        episode: replayEpisode(lane.id),
        observation: {
          ...replayObservation(lane.id, 0, "ENTRY", "2026-07-14T12:00:02.000Z"),
          laneId: "wrong-lane"
        }
      }
    })).toBe(true);

    expect(repository.getAutonomousPaperEvent(claim.eventKey)).toMatchObject({
      outcome: "SIMULATED"
    });
    expect(repository.getAutonomousPaperPosition(lot.id)).toEqual(lot);
    expect(repository.getAutonomousPaperAccount(lane.id)).toMatchObject({ openPositions: 1 });
    expect(repository.getAutonomousPaperReplayEpisode("replay-episode-a")).toBeUndefined();
    expect(repository.listAudit(20)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        eventType: "autonomous_paper_replay_capture_failed",
        severity: "warning"
      })
    ]));
  });

  it("lists every unfinished active-lane claim beyond the bounded recent-event window", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const lane = repository.createAutonomousPaperLane({
      id: "autonomous-v1",
      policyVersion: "momentum-v1",
      policy: policy(),
      startedAt: "2026-07-14T12:00:00.000Z"
    });
    const interruptedRoot: AutonomousPaperEvent = {
      eventKey: "interrupted-cycle-root",
      laneId: lane.id,
      kind: "NAV_MARK",
      outcome: "CLAIMED",
      observedAt: "2026-07-14T12:00:00.000Z"
    };
    expect(repository.claimAutonomousPaperEvent(interruptedRoot)).toBe(true);

    for (let index = 0; index < 501; index += 1) {
      const observedAt = new Date(Date.UTC(2026, 6, 14, 13, 0, index)).toISOString();
      const claim: AutonomousPaperEvent = {
        eventKey: `newer-terminal-decision-${index.toString().padStart(3, "0")}`,
        laneId: lane.id,
        kind: "DECISION",
        outcome: "CLAIMED",
        observedAt,
        mint: `${TARGET_MINT}-${index}`,
        action: "REJECT"
      };
      expect(repository.claimAutonomousPaperEvent(claim)).toBe(true);
      expect(repository.finalizeAutonomousPaperEvent({
        ...claim,
        outcome: "REJECTED",
        reason: "Newer generic rejection evidence.",
        finalizedAt: observedAt
      })).toBe(true);
    }

    expect(repository.listAutonomousPaperEvents({ laneId: lane.id, limit: 500 }))
      .not.toContainEqual(expect.objectContaining({ eventKey: interruptedRoot.eventKey }));
    expect(repository.listClaimedAutonomousPaperEvents(lane.id)).toEqual([interruptedRoot]);

    repository.pauseAutonomousPaperLane(lane.id, "2026-07-14T14:00:00.000Z");
    expect(() => repository.listClaimedAutonomousPaperEvents(lane.id))
      .toThrow("active autonomous paper lane");
  });

  it("reserves buried material decisions and trade evidence without crowding out current candidates", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const lane = repository.createAutonomousPaperLane({
      id: "autonomous-dashboard-material",
      policyVersion: "momentum-v1",
      policy: policy(),
      startedAt: "2026-07-14T10:00:00.000Z"
    });

    for (let index = 0; index < 60; index += 1) {
      persistDecisionEvent(repository, {
        laneId: lane.id,
        eventKey: `older-material-${index.toString().padStart(3, "0")}`,
        action: "BUY",
        outcome: "FAILED",
        at: new Date(Date.UTC(2026, 6, 14, 11, 0, index)).toISOString(),
        reasons: ["OLDER_MATERIAL_FAILURE"],
        ...(index >= 58 ? { decisionId: "duplicate-material-decision" } : {})
      });
    }

    const buyEvent = persistDecisionEvent(repository, {
      laneId: lane.id,
      eventKey: "buried-simulated-buy",
      action: "BUY",
      outcome: "SIMULATED",
      at: "2026-07-14T12:00:00.000Z",
      reasons: ["QUOTE_CEILINGS_PASSED"]
    });
    const buyDecision = buyEvent.decision!;
    const sellAt = "2026-07-14T12:01:00.000Z";
    const sellDecision: AutonomousPaperDecision = {
      id: "buried-simulated-sell-decision",
      laneId: lane.id,
      action: "SELL",
      outcome: "SIMULATED",
      mint: buyDecision.mint,
      score: 82,
      reasons: ["TAKE_PROFIT"],
      snapshot: snapshot(buyDecision.mint, sellAt),
      positionId: "buried-position",
      decidedAt: sellAt
    };
    const trade: AutonomousPaperTrade = {
      id: "buried-trade",
      laneId: lane.id,
      positionId: "buried-position",
      entryDecisionId: buyDecision.id,
      exitDecisionId: sellDecision.id,
      mint: buyDecision.mint,
      exitReason: "TAKE_PROFIT",
      openedAt: buyDecision.decidedAt,
      closedAt: sellAt,
      proceedsUsd: 35,
      costBasisUsd: 28.2,
      modeledCostsUsd: 0.3,
      pnlUsd: 6.5,
      returnPercent: 23.05
    };
    const tradeClaim: AutonomousPaperEvent = {
      eventKey: "buried-trade-event",
      laneId: lane.id,
      kind: "TRADE",
      outcome: "CLAIMED",
      observedAt: sellAt,
      mint: trade.mint,
      action: "SELL"
    };
    expect(repository.claimAutonomousPaperEvent(tradeClaim)).toBe(true);
    expect(repository.finalizeAutonomousPaperEvent({
      ...tradeClaim,
      outcome: "SIMULATED",
      reason: "TAKE_PROFIT",
      decision: sellDecision,
      trade,
      finalizedAt: sellAt
    })).toBe(true);
    const failedEvent = persistDecisionEvent(repository, {
      laneId: lane.id,
      eventKey: "buried-failed-mark",
      action: "OBSERVE",
      outcome: "FAILED",
      at: "2026-07-14T12:02:00.000Z",
      reasons: ["SELL_QUOTE_UNAVAILABLE"]
    });

    for (let index = 0; index < 550; index += 1) {
      persistDecisionEvent(repository, {
        laneId: lane.id,
        eventKey: `newer-rejection-${index.toString().padStart(3, "0")}`,
        action: "REJECT",
        outcome: "REJECTED",
        at: new Date(Date.UTC(2026, 6, 14, 13, 0, index)).toISOString(),
        reasons: ["NEWER_CANDIDATE_REJECTION"]
      });
    }

    const genericWindow = repository.listAutonomousPaperEvents({ laneId: lane.id, limit: 500 });
    expect(genericWindow.map((event) => event.eventKey)).not.toContain(buyEvent.eventKey);
    expect(genericWindow.map((event) => event.eventKey)).not.toContain(tradeClaim.eventKey);

    const dashboard = repository.autonomousPaperDashboard(lane.id, 20);
    const decisionIds = dashboard.recentDecisions.map((value) => value.id);
    expect(decisionIds).toEqual(expect.arrayContaining([
      buyDecision.id,
      sellDecision.id,
      failedEvent.decision!.id,
      "duplicate-material-decision"
    ]));
    expect(new Set(decisionIds).size).toBe(decisionIds.length);
    expect(dashboard.recentDecisions).toHaveLength(20);
    expect(dashboard.recentDecisions.filter((value) => value.action === "REJECT")).toHaveLength(15);
    expect(dashboard.recentTrades).toEqual([trade]);
  });

  it("counts UTC-day simulated entries separately from the latest persisted entry", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const lane = repository.createAutonomousPaperLane({
      id: "autonomous-v1",
      policyVersion: "momentum-v1",
      policy: policy(),
      startedAt: "2026-07-13T12:00:00.000Z"
    });
    const persistEntry = (
      eventKey: string,
      observedAt: string,
      outcome: "SIMULATED" | "REJECTED" = "SIMULATED"
    ) => {
      const claim: AutonomousPaperEvent = {
        eventKey,
        laneId: lane.id,
        kind: "DECISION",
        outcome: "CLAIMED",
        observedAt,
        mint: `${TARGET_MINT}-${eventKey}`,
        action: "BUY"
      };
      expect(repository.claimAutonomousPaperEvent(claim)).toBe(true);
      expect(repository.finalizeAutonomousPaperEvent({
        ...claim,
        outcome,
        finalizedAt: observedAt
      })).toBe(true);
    };
    persistEntry("yesterday", "2026-07-13T23:59:00.000Z");
    persistEntry("today-early", "2026-07-14T00:10:00.000Z");
    persistEntry("today-latest", "2026-07-14T12:20:00.000Z");
    persistEntry("rejected-buy", "2026-07-14T12:25:00.000Z", "REJECTED");
    persistEntry("future-entry", "2026-07-14T13:00:00.000Z");

    const through = "2026-07-14T12:30:00.000Z";
    expect(repository.countAutonomousPaperSimulatedBuyEntriesForUtcDay(lane.id, through))
      .toBe(2);
    expect(repository.latestAutonomousPaperSimulatedBuyEntryAtOrBefore(lane.id, through))
      .toBe("2026-07-14T12:20:00.000Z");
    expect(repository.countAutonomousPaperSimulatedBuyEntriesForUtcDay(
      lane.id,
      "2026-07-14T23:59:00.000Z"
    )).toBe(3);
    expect(() => repository.countAutonomousPaperSimulatedBuyEntriesForUtcDay(lane.id, "bad"))
      .toThrow("time is invalid");
  });

  it("counts only persisted v8 controlled-exploration BUY entries for the UTC-day cap", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const lane = repository.createAutonomousPaperLane({
      id: "autonomous-v8",
      policyVersion: "autonomous-momentum-paper-v8",
      policy: policy(),
      startedAt: "2026-07-13T12:00:00.000Z"
    });
    const add = (eventKey: string, at: string, reasons: string[]) => persistDecisionEvent(repository, {
      laneId: lane.id,
      eventKey,
      action: "BUY",
      outcome: "SIMULATED",
      at,
      reasons
    });
    add("prior-exploration", "2026-07-13T23:59:00.000Z", ["CONTROLLED_EXPLORATION"]);
    add("normal-buy", "2026-07-14T00:05:00.000Z", ["QUOTE_CEILINGS_PASSED"]);
    add("waiver-only", "2026-07-14T00:06:00.000Z", [
      "WAIVED_WEAK_ONE_HOUR_ORGANIC_BUYING"
    ]);
    add("exploration-a", "2026-07-14T00:07:00.000Z", [
      "CONTROLLED_EXPLORATION",
      "WAIVED_WEAK_ONE_HOUR_ORGANIC_BUYING"
    ]);
    add("exploration-b", "2026-07-14T12:00:00.000Z", ["CONTROLLED_EXPLORATION"]);
    add("future-exploration", "2026-07-14T13:00:00.000Z", ["CONTROLLED_EXPLORATION"]);

    expect(repository.countAutonomousPaperControlledExplorationEntriesForUtcDay(
      lane.id,
      "2026-07-14T12:30:00.000Z"
    )).toBe(2);
    expect(repository.countAutonomousPaperControlledExplorationEntriesForUtcDay(
      lane.id,
      "2026-07-14T23:59:00.000Z"
    )).toBe(3);
    expect(() => repository.countAutonomousPaperControlledExplorationEntriesForUtcDay(
      lane.id,
      "bad"
    )).toThrow("time is invalid");
  });

  it("returns newest material completed exits for deterministic sizing calibration", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const lane = repository.createAutonomousPaperLane({
      id: "autonomous-calibration",
      policyVersion: "momentum-v5",
      policy: policy()
    });
    const makeTrade = (
      id: string,
      closedAt: string,
      returnPercent: number
    ): AutonomousPaperTrade => ({
      id,
      laneId: lane.id,
      positionId: `position-${id}`,
      entryDecisionId: `entry-${id}`,
      exitDecisionId: `exit-${id}`,
      mint: `${TARGET_MINT}-${id}`,
      exitReason: returnPercent > 0 ? "TAKE_PROFIT" : "STOP_LOSS",
      openedAt: "2026-07-14T10:00:00.000Z",
      closedAt,
      proceedsUsd: 20 * (1 + returnPercent / 100),
      costBasisUsd: 20,
      modeledCostsUsd: 0.2,
      pnlUsd: 20 * returnPercent / 100,
      returnPercent,
      entryLearningContext: {
        version: "contextual-reward-v1",
        momentum: 0.8,
        categoryRank: 0.7,
        liquidityFlow: 0.6,
        quoteQuality: 0.9,
        projectedRoundTripCostPercent: 0.2
      }
    });
    const older = makeTrade("older", "2026-07-14T12:00:00.000Z", -4);
    const newer = makeTrade("newer", "2026-07-14T12:05:00.000Z", 8);
    persistTradeEvent(repository, older);
    persistTradeEvent(repository, newer);
    persistTradeEvent(
      repository,
      makeTrade("failed", "2026-07-14T12:10:00.000Z", 20),
      "event-failed",
      "FAILED"
    );
    persistDecisionEvent(repository, {
      laneId: lane.id,
      eventKey: "not-a-trade",
      action: "SELL",
      outcome: "SIMULATED",
      at: "2026-07-14T12:11:00.000Z"
    });

    expect(repository.listAutonomousPaperTradesForCalibration(lane.id)).toEqual([newer, older]);
    expect(repository.listAutonomousPaperTradesForCalibration(lane.id, 1)).toEqual([newer]);
    expect(repository.listAutonomousPaperTradesForCalibration(lane.id, 0)).toEqual([]);
    expect(() => repository.listAutonomousPaperTradesForCalibration("missing-lane"))
      .toThrow("existing lane");
  });

  it("atomically rolls old candidate detail by UTC day while preserving every material event", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const lane = repository.createAutonomousPaperLane({
      id: "autonomous-retention",
      policyVersion: "momentum-v1",
      policy: policy()
    });
    const candidates = [
      ["candidate-1", "REJECT", "REJECTED", "2026-07-13T23:50:00.000Z", ["BETA", "ALPHA", "ALPHA"]],
      ["candidate-2", "REJECT", "REJECTED", "2026-07-13T23:51:00.000Z", ["ALPHA"]],
      ["candidate-3", "OBSERVE", "ANALYSIS_ONLY", "2026-07-13T23:52:00.000Z", ["WAIT_NEXT_SAMPLE"]],
      ["candidate-4", "REJECT", "REJECTED", "2026-07-14T00:01:00.000Z", ["BETA"]],
      ["candidate-5", "REJECT", "REJECTED", "2026-07-14T00:02:00.000Z", ["RECENT"]],
      ["candidate-6", "OBSERVE", "ANALYSIS_ONLY", "2026-07-14T00:03:00.000Z", ["RECENT"]]
    ] as const;
    for (const [eventKey, action, outcome, at, reasons] of candidates) {
      persistDecisionEvent(repository, { laneId: lane.id, eventKey, action, outcome, at, reasons: [...reasons] });
    }

    for (const [eventKey, action, outcome] of [
      ["material-buy", "BUY", "SIMULATED"],
      ["material-sell", "SELL", "SIMULATED"],
      ["material-failed", "REJECT", "FAILED"]
    ] as const) {
      persistDecisionEvent(repository, {
        laneId: lane.id,
        eventKey,
        action,
        outcome,
        at: "2026-07-14T00:10:00.000Z"
      });
    }
    const rootClaim: AutonomousPaperEvent = {
      eventKey: "same-bucket-root",
      laneId: lane.id,
      kind: "NAV_MARK",
      outcome: "CLAIMED",
      observedAt: "2026-07-14T00:09:00.000Z"
    };
    expect(repository.claimAutonomousPaperEvent(rootClaim)).toBe(true);
    expect(repository.finalizeAutonomousPaperEvent({
      ...rootClaim,
      outcome: "SIMULATED",
      finalizedAt: rootClaim.observedAt
    })).toBe(true);
    const tradeClaim: AutonomousPaperEvent = {
      eventKey: "material-trade",
      laneId: lane.id,
      kind: "TRADE",
      outcome: "CLAIMED",
      observedAt: "2026-07-14T00:11:00.000Z",
      mint: TARGET_MINT,
      action: "SELL"
    };
    expect(repository.claimAutonomousPaperEvent(tradeClaim)).toBe(true);
    expect(repository.finalizeAutonomousPaperEvent({
      ...tradeClaim,
      outcome: "SIMULATED",
      finalizedAt: tradeClaim.observedAt
    })).toBe(true);
    const unfinished: AutonomousPaperEvent = {
      eventKey: "material-claimed",
      laneId: lane.id,
      kind: "DECISION",
      outcome: "CLAIMED",
      observedAt: "2026-07-14T00:12:00.000Z",
      mint: SECOND_MINT,
      action: "REJECT"
    };
    expect(repository.claimAutonomousPaperEvent(unfinished)).toBe(true);

    const compacted = repository.compactAutonomousPaperCandidateDetails(lane.id, {
      retainNewest: 2,
      batchSize: 10
    });
    expect(compacted).toMatchObject({
      compacted: 4,
      rollupRows: 3,
      retainedCandidateDetails: 2,
      retainNewest: 2,
      batchSize: 10
    });
    expect(repository.getAutonomousPaperEvent("candidate-1")).toBeUndefined();
    expect(repository.getAutonomousPaperEvent("candidate-4")).toBeUndefined();
    expect(repository.getAutonomousPaperEvent("candidate-5")).toBeDefined();
    expect(repository.getAutonomousPaperEvent("candidate-6")).toBeDefined();
    for (const eventKey of [
      "material-buy",
      "material-sell",
      "material-failed",
      "same-bucket-root",
      "material-trade",
      "material-claimed"
    ]) expect(repository.getAutonomousPaperEvent(eventKey)).toBeDefined();
    expect(repository.claimAutonomousPaperEvent(rootClaim)).toBe(false);

    const rollups = repository.listAutonomousPaperCandidateRollups(lane.id);
    expect(rollups.find((rollup) =>
      rollup.utcDay === "2026-07-13" && rollup.action === "REJECT"
    )).toMatchObject({
      outcome: "REJECTED",
      decisionCount: 2,
      firstObservedAt: "2026-07-13T23:50:00.000Z",
      lastObservedAt: "2026-07-13T23:51:00.000Z",
      reasonCounts: { ALPHA: 2, BETA: 1 }
    });
    expect(rollups.find((rollup) => rollup.action === "OBSERVE")).toMatchObject({
      utcDay: "2026-07-13",
      outcome: "ANALYSIS_ONLY",
      decisionCount: 1,
      reasonCounts: { WAIT_NEXT_SAMPLE: 1 }
    });
    expect(rollups.find((rollup) =>
      rollup.utcDay === "2026-07-14" && rollup.action === "REJECT"
    )).toMatchObject({ decisionCount: 1, reasonCounts: { BETA: 1 } });
    expect((db.prepare(`
      SELECT reason_counts_json FROM autonomous_paper_candidate_rollups
      WHERE lane_id = ? AND utc_day = '2026-07-13' AND action = 'REJECT'
    `).get(lane.id) as { reason_counts_json: string }).reason_counts_json)
      .toBe('{"ALPHA":2,"BETA":1}');
    expect(repository.listAudit(10)).toContainEqual(expect.objectContaining({
      eventType: "autonomous_paper_candidate_details_compacted",
      details: expect.objectContaining({ compacted: 4, retainedCandidateDetails: 2 })
    }));
    expect(repository.compactAutonomousPaperCandidateDetails(lane.id, {
      retainNewest: 2,
      batchSize: 10
    })).toMatchObject({ compacted: 0, retainedCandidateDetails: 2 });
    expect(repository.listAutonomousPaperCandidateRollups(lane.id)).toEqual(rollups);
  });

  it("rolls back rollup, deletion, and audit together when compaction deletion fails", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const lane = repository.createAutonomousPaperLane({
      id: "autonomous-retention-rollback",
      policyVersion: "momentum-v1",
      policy: policy()
    });
    for (let index = 0; index < 3; index += 1) {
      persistDecisionEvent(repository, {
        laneId: lane.id,
        eventKey: `rollback-${index}`,
        action: "REJECT",
        outcome: "REJECTED",
        at: `2026-07-14T00:0${index}:00.000Z`,
        reasons: ["ROLLBACK_REASON"]
      });
    }
    db.exec(`
      CREATE TRIGGER abort_autonomous_candidate_delete
      BEFORE DELETE ON autonomous_paper_events
      WHEN OLD.event_key = 'rollback-0'
      BEGIN
        SELECT RAISE(ABORT, 'forced candidate delete failure');
      END;
    `);

    expect(() => repository.compactAutonomousPaperCandidateDetails(lane.id, {
      retainNewest: 0,
      batchSize: 2
    })).toThrow("forced candidate delete failure");
    expect(repository.listAutonomousPaperCandidateRollups(lane.id)).toEqual([]);
    expect(repository.getAutonomousPaperEvent("rollback-0")).toBeDefined();
    expect(repository.getAutonomousPaperEvent("rollback-1")).toBeDefined();
    expect(repository.listAudit(10).some((entry) =>
      entry.eventType === "autonomous_paper_candidate_details_compacted"
    )).toBe(false);

    db.exec("DROP TRIGGER abort_autonomous_candidate_delete");
    expect(repository.compactAutonomousPaperCandidateDetails(lane.id, {
      retainNewest: 0,
      batchSize: 2
    })).toMatchObject({ compacted: 2, retainedCandidateDetails: 1 });
    expect(repository.listAutonomousPaperCandidateRollups(lane.id)[0]).toMatchObject({
      decisionCount: 2,
      reasonCounts: { ROLLBACK_REASON: 2 }
    });
  });

  it("keeps candidate detail bounded under repeated maximum-size test batches", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const lane = repository.createAutonomousPaperLane({
      id: "autonomous-retention-steady",
      policyVersion: "momentum-v1",
      policy: policy()
    });
    for (let round = 0; round < 10; round += 1) {
      for (let index = 0; index < 4; index += 1) {
        const sequence = round * 4 + index;
        persistDecisionEvent(repository, {
          laneId: lane.id,
          eventKey: `steady-${sequence.toString().padStart(3, "0")}`,
          action: "REJECT",
          outcome: "REJECTED",
          at: new Date(Date.UTC(2026, 6, 14, 0, sequence)).toISOString(),
          reasons: ["STEADY_REASON"]
        });
      }
      const result = repository.compactAutonomousPaperCandidateDetails(lane.id, {
        retainNewest: 3,
        batchSize: 4
      });
      expect(result.retainedCandidateDetails).toBeLessThanOrEqual(3);
    }
    expect(repository.listAutonomousPaperCandidateRollups(lane.id)).toEqual([
      expect.objectContaining({
        utcDay: "2026-07-14",
        action: "REJECT",
        outcome: "REJECTED",
        decisionCount: 37,
        reasonCounts: { STEADY_REASON: 37 }
      })
    ]);
    expect((db.prepare(`
      SELECT COUNT(*) AS count FROM autonomous_paper_events
      WHERE lane_id = ? AND kind = 'DECISION' AND action = 'REJECT' AND outcome = 'REJECTED'
    `).get(lane.id) as { count: number }).count).toBe(3);
  });

  it("enforces one open lot per mint and returns bounded closed-trade evidence", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const lane = repository.createAutonomousPaperLane({
      id: "autonomous-v1",
      policyVersion: "momentum-v1",
      policy: policy()
    });
    repository.initializeAutonomousPaperAccount(lane.id);
    const open = position(lane.id);
    repository.upsertAutonomousPaperPosition(open);
    expect(() => repository.upsertAutonomousPaperPosition(
      position(lane.id, "duplicate-open", TARGET_MINT, "decision-two")
    )).toThrow();

    repository.upsertAutonomousPaperPosition({
      ...open,
      remainingAmountAtomic: "0",
      remainingCostUsd: 0,
      lastExecutableValueUsd: 0,
      status: "CLOSED",
      updatedAt: "2026-07-14T13:00:00.000Z",
      closedAt: "2026-07-14T13:00:00.000Z"
    });
    repository.upsertAutonomousPaperPosition(
      position(lane.id, "replacement-open", TARGET_MINT, "decision-three")
    );
    expect(repository.listAutonomousPaperPositions({ laneId: lane.id, openOnly: true }))
      .toEqual([expect.objectContaining({ id: "replacement-open" })]);

    const trade: AutonomousPaperTrade = {
      id: "autonomous-trade-a",
      laneId: lane.id,
      positionId: open.id,
      entryDecisionId: open.entryDecisionId,
      exitDecisionId: "decision-exit",
      mint: TARGET_MINT,
      symbol: "AUTO",
      exitReason: "TAKE_PROFIT",
      openedAt: open.openedAt,
      closedAt: "2026-07-14T13:00:00.000Z",
      proceedsUsd: 35,
      costBasisUsd: 28.2,
      modeledCostsUsd: 0.3,
      pnlUsd: 6.5,
      returnPercent: 23.05
    };
    const claim: AutonomousPaperEvent = {
      eventKey: "autonomous-trade-event",
      laneId: lane.id,
      kind: "TRADE",
      outcome: "CLAIMED",
      observedAt: trade.closedAt,
      mint: trade.mint,
      action: "SELL"
    };
    expect(repository.claimAutonomousPaperEvent(claim)).toBe(true);
    expect(repository.finalizeAutonomousPaperEvent({
      ...claim,
      outcome: "SIMULATED",
      trade,
      finalizedAt: trade.closedAt
    })).toBe(true);
    expect(repository.autonomousPaperDashboard(undefined, 1).recentTrades).toEqual([trade]);
    expect(repository.listAutonomousPaperEvents({ laneId: lane.id, limit: 0 })).toEqual([]);
  });

  it("rolls finalization and account mutation back when a position write conflicts", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const lane = repository.createAutonomousPaperLane({
      id: "autonomous-v1",
      policyVersion: "momentum-v1",
      policy: policy()
    });
    const account = repository.initializeAutonomousPaperAccount(lane.id);
    repository.upsertAutonomousPaperPosition(position(lane.id, "existing-open"));
    const claim: AutonomousPaperEvent = {
      eventKey: "autonomous-conflicting-entry",
      laneId: lane.id,
      kind: "DECISION",
      outcome: "CLAIMED",
      observedAt: "2026-07-14T12:05:00.000Z",
      mint: TARGET_MINT,
      action: "BUY"
    };
    expect(repository.claimAutonomousPaperEvent(claim)).toBe(true);
    const competingDecision = decision(
      lane.id,
      "decision-conflict",
      TARGET_MINT,
      claim.observedAt
    );
    expect(() => repository.commitAutonomousPaperEvent({
      event: {
        ...claim,
        outcome: "SIMULATED",
        decision: competingDecision,
        finalizedAt: "2026-07-14T12:05:01.000Z"
      },
      account: {
        ...account,
        cashUsd: 112.8,
        navUsd: 140.7,
        deployedUsd: 27.9,
        unrealizedPnlUsd: -0.3,
        openPositions: 1,
        updatedAt: "2026-07-14T12:05:01.000Z"
      },
      positions: [position(lane.id, "conflicting-open", TARGET_MINT, competingDecision.id)]
    })).toThrow();

    expect(repository.getAutonomousPaperEvent(claim.eventKey)?.outcome).toBe("CLAIMED");
    expect(repository.getAutonomousPaperAccount(lane.id)).toEqual(account);
    expect(repository.listAutonomousPaperPositions({ laneId: lane.id, openOnly: true }))
      .toEqual([expect.objectContaining({ id: "existing-open" })]);
  });

  it("persists one actual-position Replay Lab path and 1,000 zero-weight variants atomically", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const lane = repository.createAutonomousPaperLane({
      id: "autonomous-v1",
      policyVersion: "momentum-v1",
      policy: policy()
    });
    const account = repository.initializeAutonomousPaperAccount(lane.id);
    repository.upsertAutonomousPaperPosition(position(lane.id));
    const episode = replayEpisode(lane.id);

    expect(repository.createAutonomousPaperReplayEpisode(episode)).toEqual(episode);
    expect(repository.createAutonomousPaperReplayEpisode(episode)).toEqual(episode);
    const observations = [
      replayObservation(lane.id, 0, "ENTRY", "2026-07-14T12:00:02.000Z"),
      {
        ...replayObservation(lane.id, 1, "MARK", "2026-07-14T12:03:00.000Z"),
        organicBuyShare5m: -1
      },
      replayObservation(lane.id, 2, "ACTUAL_EXIT", "2026-07-14T12:04:00.000Z"),
      replayObservation(lane.id, 3, "POST_EXIT", "2026-07-14T12:06:00.000Z")
    ];
    for (const observation of observations) {
      expect(repository.appendAutonomousPaperReplayObservation(observation)).toBe(true);
    }
    expect(repository.appendAutonomousPaperReplayObservation(observations[3]!)).toBe(false);
    expect(() => repository.appendAutonomousPaperReplayObservation({
      ...observations[3]!,
      marketPriceUsd: 99
    })).toThrow(/idempotency evidence changed/iu);
    expect(() => repository.appendAutonomousPaperReplayObservation({
      ...replayObservation(lane.id, 4, "POST_EXIT", "2026-07-14T12:06:01.000Z"),
      transactionBase64: "forbidden"
    } as unknown as AutonomousPaperReplayObservation)).toThrow(/unsupported fields/iu);
    expect(() => repository.appendAutonomousPaperReplayObservation({
      ...replayObservation(lane.id, 4, "POST_EXIT", "2026-07-14T12:06:01.000Z"),
      organicBuyShare5m: -0.5
    })).toThrow(/organic-buy share is invalid/iu);

    const ready = repository.completeAutonomousPaperReplayEpisode(episode.id, {
      completedAt: "2026-07-14T12:06:00.000Z"
    });
    expect(ready).toMatchObject({
      status: "READY",
      observationCount: 4,
      actualClosedAt: "2026-07-14T12:04:00.000Z",
      pathDigest: expect.stringMatching(/^[a-f0-9]{64}$/u)
    });
    const results = replayResults("replay-report-a", lane.id);
    const report = replayReport(ready, results);
    expect(repository.saveAutonomousPaperReplayReport(report, results)).toBe(true);
    expect(repository.saveAutonomousPaperReplayReport(report, results)).toBe(false);
    expect(repository.listAutonomousPaperReplayVariantResults(report.id)).toHaveLength(1_000);
    expect(repository.getAutonomousPaperReplayEpisode(episode.id)?.status).toBe("REPLAYED");
    expect(repository.autonomousPaperReplayDashboard(lane.id)).toMatchObject({
      executionEnabled: false,
      promotionEligible: false,
      calibrationTradeCount: 0,
      independentEpisodeCount: 1,
      scenarioEvaluations: 1_000,
      replayedEpisodes: 1,
      recentInsights: [{
        reportId: report.id,
        classification: "NO_IMPROVEMENT",
        evaluatedVariantCount: 1_000,
        profitableVariantCount: 0,
        bestVariant: {
          variantId: "variant-0000",
          exitReason: "TAKE_PROFIT",
          pnlUsd: -0.1
        }
      }]
    });
    expect(repository.autonomousPaperDashboard(lane.id).replayLab?.scenarioEvaluations).toBe(1_000);

    // Replays are physically absent from the only calibration/trade ledger and
    // cannot mutate the autonomous account or its independent trade count.
    expect(repository.listAutonomousPaperTradesForCalibration(lane.id)).toEqual([]);
    expect(repository.getAutonomousPaperAccount(lane.id)).toEqual(account);
    expect(repository.autonomousPaperDashboard(lane.id).recentTrades).toEqual([]);
  });

  it("rolls back a malformed 1,000-variant report without partially replaying its episode", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const lane = repository.createAutonomousPaperLane({
      id: "autonomous-v1",
      policyVersion: "momentum-v1",
      policy: policy()
    });
    repository.upsertAutonomousPaperPosition(position(lane.id));
    const episode = repository.createAutonomousPaperReplayEpisode(replayEpisode(lane.id));
    for (const observation of [
      replayObservation(lane.id, 0, "ENTRY", "2026-07-14T12:00:02.000Z"),
      replayObservation(lane.id, 1, "ACTUAL_EXIT", "2026-07-14T12:04:00.000Z"),
      replayObservation(lane.id, 2, "POST_EXIT", "2026-07-14T12:06:00.000Z")
    ]) repository.appendAutonomousPaperReplayObservation(observation);
    const ready = repository.completeAutonomousPaperReplayEpisode(episode.id, {
      completedAt: "2026-07-14T12:06:00.000Z"
    });
    const results = replayResults("replay-report-a", lane.id);
    const malformed = results.map((result) => ({ ...result }));
    malformed[999] = { ...malformed[999]!, configurationDigest: malformed[998]!.configurationDigest };
    const report = replayReport(ready, malformed);

    expect(() => repository.saveAutonomousPaperReplayReport(report, malformed)).toThrow();
    expect(repository.getAutonomousPaperReplayReport(report.id)).toBeUndefined();
    expect(repository.listAutonomousPaperReplayVariantResults(report.id)).toEqual([]);
    expect(repository.getAutonomousPaperReplayEpisode(episode.id)?.status).toBe("READY");
  });

  it("keeps different mints independent", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const lane = repository.createAutonomousPaperLane({
      id: "autonomous-v1",
      policyVersion: "momentum-v1",
      policy: policy()
    });
    repository.upsertAutonomousPaperPosition(position(lane.id));
    repository.upsertAutonomousPaperPosition(
      position(lane.id, "autonomous-position-b", SECOND_MINT, "decision-second-mint")
    );
    expect(repository.listAutonomousPaperPositions({ laneId: lane.id, openOnly: true }))
      .toHaveLength(2);
  });
});
