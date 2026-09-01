import { createHash } from "node:crypto";
import {
  AUTONOMOUS_PAPER_REPLAY_VARIANT_COUNT,
  AUTONOMOUS_PAPER_REPLAY_VERSION,
  type AutonomousPaperLane,
  type AutonomousPaperMarketSnapshot,
  type AutonomousPaperPosition,
  type AutonomousPaperReplayEntryEvidence,
  type AutonomousPaperReplayEpisode,
  type AutonomousPaperReplayExitEvidence,
  type AutonomousPaperReplayObservation,
  type AutonomousPaperReplayReport,
  type AutonomousPaperReplayVariantParameters,
  type AutonomousPaperReplayVariantResult,
  type AutonomousPaperTrade
} from "@copylab/shared";
import {
  AUTONOMOUS_PAPER_REPLAY_BASELINE_VARIANT,
  AUTONOMOUS_PAPER_REPLAY_FIXED_CONTROLS,
  AUTONOMOUS_PAPER_REPLAY_VARIANTS,
  evaluateAutonomousPaperReplay,
  type AutonomousPaperReplayObservation as EvaluatorObservation,
  type AutonomousPaperReplayPath
} from "./autonomous-paper-replay.js";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableId(prefix: string, ...parts: Array<string | number>): string {
  return `${prefix}:${sha256([prefix, ...parts.map(String)].join("\u0000"))}`;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

export interface AutonomousPaperReplayCadenceGap {
  previousObservedAt: string;
  nextObservedAt: string;
  gapMs: number;
  maximumAllowedGapMs: number;
}

/** A replay path may contain explicit UNPRICED samples, but it may not silently
 * jump across missing scan buckets. A two-interval allowance covers ordinary
 * scheduler jitter while still exposing provider/process outages as missing
 * causal evidence. */
export function autonomousPaperReplayCadenceGap(
  observations: readonly Pick<AutonomousPaperReplayObservation, "observedAt">[],
  scanIntervalMinutes: number
): AutonomousPaperReplayCadenceGap | undefined {
  if (!Number.isFinite(scanIntervalMinutes) || scanIntervalMinutes <= 0) {
    throw new RangeError("Replay cadence requires a positive scan interval.");
  }
  const maximumAllowedGapMs = scanIntervalMinutes * 2 * 60_000;
  for (let index = 1; index < observations.length; index += 1) {
    const previous = observations[index - 1];
    const next = observations[index];
    if (!previous || !next) continue;
    const previousMs = Date.parse(previous.observedAt);
    const nextMs = Date.parse(next.observedAt);
    if (!Number.isFinite(previousMs) || !Number.isFinite(nextMs)) {
      throw new Error("Replay cadence evidence contains an invalid timestamp.");
    }
    const gapMs = nextMs - previousMs;
    if (gapMs > maximumAllowedGapMs) {
      return {
        previousObservedAt: previous.observedAt,
        nextObservedAt: next.observedAt,
        gapMs,
        maximumAllowedGapMs
      };
    }
  }
  return undefined;
}

function parametersForVariant(
  variant: (typeof AUTONOMOUS_PAPER_REPLAY_VARIANTS)[number]
): AutonomousPaperReplayVariantParameters {
  return {
    // Replay v1 asks only the user's exit question. Entry timing and
    // confirmation remain frozen to the actual position so all variants use
    // the same acquired token amount and exact full-lot sell quotes.
    entryDelaySamples: 0,
    confirmationSamples: 1,
    minimumMomentumScore: 30,
    stopLossPercent: variant.stopLossPercent,
    breakEvenActivationPercent:
      AUTONOMOUS_PAPER_REPLAY_FIXED_CONTROLS.breakEvenActivationPercent,
    trailingActivationPercent: variant.trailingActivationPercent,
    trailingDrawdownPercent: variant.trailingDrawdownPercent,
    takeProfitPercent: variant.takeProfitPercent,
    weakMomentumExitSamples: variant.weakMomentumExitSamples,
    noProgressMinutes: variant.noProgressMinutes,
    maximumHoldingMinutes: variant.maximumHoldingMinutes
  };
}

export const AUTONOMOUS_PAPER_REPLAY_MANIFEST = Object.freeze(
  AUTONOMOUS_PAPER_REPLAY_VARIANTS.map((variant) => {
    const parameters = Object.freeze(parametersForVariant(variant));
    return Object.freeze({
      variantIndex: variant.index,
      variantId: variant.id,
      parameters,
      configurationDigest: sha256(JSON.stringify(parameters))
    });
  })
);

export const AUTONOMOUS_PAPER_REPLAY_MANIFEST_DIGEST = sha256(
  AUTONOMOUS_PAPER_REPLAY_MANIFEST
    .map((item) => `${item.variantIndex}:${item.variantId}:${item.configurationDigest}`)
    .join("\n")
);

export const AUTONOMOUS_PAPER_REPLAY_HORIZON_MINUTES = Math.max(
  ...AUTONOMOUS_PAPER_REPLAY_VARIANTS.map((variant) => variant.maximumHoldingMinutes)
);

export function newAutonomousPaperReplayEpisode(
  lane: AutonomousPaperLane,
  position: AutonomousPaperPosition
): AutonomousPaperReplayEpisode {
  const horizonEndsAt = new Date(
    Date.parse(position.openedAt) + AUTONOMOUS_PAPER_REPLAY_HORIZON_MINUTES * 60_000
  ).toISOString();
  return {
    id: stableId("autonomous-replay-episode-v1", lane.id, position.id),
    laneId: lane.id,
    positionId: position.id,
    entryDecisionId: position.entryDecisionId,
    mint: position.mint,
    ...(position.symbol ? { symbol: position.symbol } : {}),
    policyVersion: lane.policyVersion,
    replayVersion: AUTONOMOUS_PAPER_REPLAY_VERSION,
    scenarioManifestDigest: AUTONOMOUS_PAPER_REPLAY_MANIFEST_DIGEST,
    status: "CAPTURING",
    actualOpenedAt: position.openedAt,
    captureStartedAt: position.openedAt,
    horizonEndsAt,
    observationCount: 0,
    updatedAt: position.openedAt
  };
}

interface ReplayObservationIdentityInput {
  episode: AutonomousPaperReplayEpisode;
  sequence: number;
  phase: AutonomousPaperReplayObservation["phase"];
  observedAt: string;
  sourceUpdatedAt: string;
  positionCostBasisUsd: number;
}

function observationIdentity(input: ReplayObservationIdentityInput) {
  return {
    observationKey: stableId(
      "autonomous-replay-observation-v1",
      input.episode.id,
      input.sequence,
      input.phase,
      input.observedAt
    ),
    episodeId: input.episode.id,
    laneId: input.episode.laneId,
    positionId: input.episode.positionId,
    mint: input.episode.mint,
    sequence: input.sequence,
    phase: input.phase,
    observedAt: input.observedAt,
    sourceUpdatedAt: input.sourceUpdatedAt,
    positionCostBasisUsd: input.positionCostBasisUsd
  } as const;
}

export function executableAutonomousPaperReplayObservation(
  input: ReplayObservationIdentityInput & {
    snapshot: AutonomousPaperMarketSnapshot;
    staticSafetyEligible: boolean;
    signalEligible: boolean;
    exitEvidence: AutonomousPaperReplayExitEvidence;
    entryEvidence?: AutonomousPaperReplayEntryEvidence;
  }
): AutonomousPaperReplayObservation {
  return {
    ...observationIdentity(input),
    status: "EXECUTABLE",
    marketPriceUsd: input.snapshot.priceUsd,
    momentumScore: input.snapshot.momentumScore,
    priceChange5mPercent: input.snapshot.priceChange5mPercent,
    organicBuyShare5m: input.snapshot.organicBuyShare5m,
    staticSafetyEligible: input.staticSafetyEligible,
    signalEligible: input.signalEligible,
    ...(input.entryEvidence ? { entryEvidence: input.entryEvidence } : {}),
    exitEvidence: input.exitEvidence
  };
}

export function unpricedAutonomousPaperReplayObservation(
  input: ReplayObservationIdentityInput & { failureCode: string }
): AutonomousPaperReplayObservation {
  return {
    ...observationIdentity(input),
    status: "UNPRICED",
    failureCode: input.failureCode
  };
}

function evaluatorObservation(
  observation: AutonomousPaperReplayObservation
): EvaluatorObservation {
  const kind = observation.phase === "POST_EXIT"
    ? "FOLLOW_THROUGH"
    : observation.phase;
  if (observation.status === "UNPRICED") return {
    id: observation.observationKey,
    observedAt: observation.observedAt,
    kind,
    status: "UNPRICED",
    failureCode: observation.failureCode
  };
  return {
    id: observation.observationKey,
    observedAt: observation.observedAt,
    kind,
    status: "EXECUTABLE",
    executableValueUsd: observation.exitEvidence.executableValueUsd,
    staticSafetyEligible: observation.staticSafetyEligible,
    priceChange5mPercent: observation.priceChange5mPercent,
    organicBuyShare5m: observation.organicBuyShare5m
  };
}

export function buildAutonomousPaperReplayReport(input: {
  episode: AutonomousPaperReplayEpisode;
  position: AutonomousPaperPosition;
  trade: AutonomousPaperTrade;
  observations: readonly AutonomousPaperReplayObservation[];
  generatedAt: string;
}): {
  report: AutonomousPaperReplayReport;
  results: AutonomousPaperReplayVariantResult[];
} {
  const { episode, position, trade } = input;
  if (
    episode.status !== "READY" || !episode.pathDigest ||
    episode.positionId !== position.id || trade.positionId !== position.id ||
    episode.scenarioManifestDigest !== AUTONOMOUS_PAPER_REPLAY_MANIFEST_DIGEST
  ) throw new Error("Replay report input does not match one complete actual PAPER path.");
  const observations = [...input.observations].sort(
    (left, right) => left.sequence - right.sequence
  );
  const actualExit = observations.find(
    (observation): observation is Extract<
      AutonomousPaperReplayObservation,
      { status: "EXECUTABLE" }
    > => observation.phase === "ACTUAL_EXIT" && observation.status === "EXECUTABLE"
  );
  if (!actualExit || Math.abs(actualExit.exitEvidence.executableValueUsd - trade.proceedsUsd) > 0.01) {
    throw new Error("Replay actual-exit evidence does not reconcile to its actual PAPER trade.");
  }
  const path: AutonomousPaperReplayPath = {
    id: episode.id,
    openedAt: episode.actualOpenedAt,
    entryCostUsd: position.entryCostUsd,
    observations: observations.map(evaluatorObservation),
    actual: {
      exitObservationId: actualExit.observationKey,
      exitReason: trade.exitReason,
      proceedsUsd: actualExit.exitEvidence.executableValueUsd
    }
  };
  const evaluated = evaluateAutonomousPaperReplay(path);
  const reportId = stableId(
    "autonomous-replay-report-v1",
    episode.id,
    episode.pathDigest,
    AUTONOMOUS_PAPER_REPLAY_VERSION
  );
  const entryObservationKey = observations[0]?.observationKey;
  if (!entryObservationKey) throw new Error("Replay path has no entry observation.");
  const results: AutonomousPaperReplayVariantResult[] = evaluated.results.map((result) => {
    const manifest = AUTONOMOUS_PAPER_REPLAY_MANIFEST[result.variantIndex];
    if (!manifest || manifest.variantId !== result.variantId) {
      throw new Error("Replay evaluator result does not match the frozen manifest.");
    }
    const identity = {
      reportId,
      episodeId: episode.id,
      laneId: episode.laneId,
      positionId: episode.positionId,
      variantIndex: result.variantIndex,
      variantId: result.variantId,
      configurationDigest: manifest.configurationDigest,
      parameters: manifest.parameters,
      causal: true as const,
      independentTradeWeight: 0 as const
    };
    if (result.status === "UNRESOLVED") return {
      ...identity,
      outcome: "UNSCORABLE" as const
    };
    const denominator = result.returnPercent >= 0
      ? manifest.parameters.takeProfitPercent
      : manifest.parameters.stopLossPercent;
    return {
      ...identity,
      outcome: "COMPLETED" as const,
      entryObservationKey,
      exitObservationKey: result.exitObservationId,
      exitReason: result.exitReason,
      enteredAt: episode.actualOpenedAt,
      exitedAt: result.exitedAt,
      costBasisUsd: position.entryCostUsd,
      proceedsUsd: result.executableValueUsd,
      pnlUsd: result.pnlUsd,
      returnPercent: result.returnPercent,
      maximumDrawdownPercent: result.maximumDrawdownPercent,
      reward: clamp(result.returnPercent / denominator, -1, 1)
    };
  });
  if (results.length !== AUTONOMOUS_PAPER_REPLAY_VARIANT_COUNT) {
    throw new Error("Replay evaluator did not return exactly 1,000 variants.");
  }
  const resultsDigest = sha256(results.map((result) => JSON.stringify(result)).join("\n"));
  const baseline = results[AUTONOMOUS_PAPER_REPLAY_BASELINE_VARIANT.index];
  if (!baseline || baseline.variantId !== AUTONOMOUS_PAPER_REPLAY_BASELINE_VARIANT.id) {
    throw new Error("Replay baseline identity changed.");
  }
  const report: AutonomousPaperReplayReport = {
    id: reportId,
    episodeId: episode.id,
    laneId: episode.laneId,
    positionId: episode.positionId,
    replayVersion: AUTONOMOUS_PAPER_REPLAY_VERSION,
    scenarioManifestDigest: episode.scenarioManifestDigest,
    pathDigest: episode.pathDigest,
    resultsDigest,
    variantCount: AUTONOMOUS_PAPER_REPLAY_VARIANT_COUNT,
    scorableVariantCount: results.filter((result) => result.outcome !== "UNSCORABLE").length,
    independentEpisodeCount: 1,
    calibrationTradeCount: 0,
    replayResultsAreIndependentTrades: false,
    baselineVariantId: baseline.variantId,
    ...(baseline.returnPercent !== undefined
      ? { baselineReturnPercent: baseline.returnPercent }
      : {}),
    ...(evaluated.hindsightBest
      ? {
          hindsightBestVariantId: evaluated.hindsightBest.variantId,
          hindsightBestReturnPercent: evaluated.hindsightBest.returnPercent,
          ...(baseline.returnPercent !== undefined
            ? {
                hindsightRegretPercent:
                  evaluated.hindsightBest.returnPercent - baseline.returnPercent
              }
            : {})
        }
      : {}),
    generatedAt: input.generatedAt
  };
  return { report, results };
}
