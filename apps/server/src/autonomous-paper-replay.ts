import { createHash } from "node:crypto";
import type { AutonomousPaperExitReason } from "@copylab/shared";

export const AUTONOMOUS_PAPER_REPLAY_GRID_VERSION = "autonomous-exit-replay-v2" as const;
export const AUTONOMOUS_PAPER_REPLAY_VARIANT_COUNT = 1_000;

const STOP_LOSS_PERCENT_GRID = Object.freeze([6, 8, 10, 12, 15] as const);
const TAKE_PROFIT_PERCENT_GRID = Object.freeze([12, 18, 24, 30, 40] as const);
const TRAILING_ACTIVATION_PERCENT_GRID = Object.freeze([2, 4, 6, 8] as const);
const TRAILING_DRAWDOWN_PERCENT_GRID = Object.freeze([3, 5, 7, 9, 12] as const);
const MAXIMUM_HOLDING_MINUTES_GRID = Object.freeze([60, 180] as const);
const WEAK_MOMENTUM_SAMPLES_GRID = Object.freeze([2, 3, 4, 5] as const);
const NO_PROGRESS_MINUTES_GRID = Object.freeze([30, 45, 60, 90] as const);

/** Baseline controls retained for compatibility. V11 deterministically
 * stratifies these values across the existing 1,000-member grid. */
export const AUTONOMOUS_PAPER_REPLAY_FIXED_CONTROLS = Object.freeze({
  breakEvenActivationPercent: 4,
  weakMomentumExitSamples: 3,
  noProgressMinutes: 45
} as const);

export type AutonomousPaperReplayVariantExitReason = Exclude<
  AutonomousPaperExitReason,
  "MANUAL_PAUSE"
>;

export interface AutonomousPaperReplayVariant {
  version: typeof AUTONOMOUS_PAPER_REPLAY_GRID_VERSION;
  index: number;
  id: string;
  digest: string;
  stopLossPercent: number;
  takeProfitPercent: number;
  trailingActivationPercent: number;
  trailingDrawdownPercent: number;
  maximumHoldingMinutes: number;
  breakEvenActivationPercent: number;
  weakMomentumExitSamples: number;
  noProgressMinutes: number;
}

interface AutonomousPaperReplayObservationIdentity {
  id: string;
  observedAt: string;
  kind: "ENTRY" | "MARK" | "ACTUAL_EXIT" | "FOLLOW_THROUGH";
}

export type AutonomousPaperReplayObservation =
  | (AutonomousPaperReplayObservationIdentity & {
      status: "EXECUTABLE";
      /** Guaranteed proceeds after the modeled sell fee. Entry cost already
       * includes modeled entry costs, so replay must not subtract costs again. */
      executableValueUsd: number;
      staticSafetyEligible: boolean;
      priceChange5mPercent: number;
      /** `-1` is the frozen provider-missing sentinel; otherwise this is a
       * normalized share from zero through one. */
      organicBuyShare5m: number;
    })
  | (AutonomousPaperReplayObservationIdentity & {
      status: "UNPRICED";
      failureCode: string;
    });

export interface AutonomousPaperReplayActualOutcome {
  exitObservationId: string;
  exitReason: AutonomousPaperExitReason;
  proceedsUsd: number;
}

export interface AutonomousPaperReplayPath {
  id: string;
  openedAt: string;
  /** Cost basis after modeled entry costs. */
  entryCostUsd: number;
  observations: readonly AutonomousPaperReplayObservation[];
  actual: AutonomousPaperReplayActualOutcome;
}

export type AutonomousPaperReplayUnresolvedReason =
  | "MISSING_EXECUTABLE_OBSERVATION"
  | "PATH_ENDED_BEFORE_EXIT";

interface AutonomousPaperReplayVariantResultBase {
  variantIndex: number;
  variantId: string;
  variantDigest: string;
  observationsConsumed: number;
  peakReturnPercent: number;
  troughReturnPercent: number;
  maximumDrawdownPercent: number;
}

export type AutonomousPaperReplayVariantResult =
  | (AutonomousPaperReplayVariantResultBase & {
      status: "RESOLVED";
      exitReason: AutonomousPaperReplayVariantExitReason;
      exitObservationId: string;
      exitedAt: string;
      executableValueUsd: number;
      pnlUsd: number;
      returnPercent: number;
    })
  | (AutonomousPaperReplayVariantResultBase & {
      status: "UNRESOLVED";
      unresolvedReason: AutonomousPaperReplayUnresolvedReason;
      unresolvedAt?: string;
      unresolvedObservationId?: string;
    });

export interface AutonomousPaperReplayActualResult {
  exitObservationId: string;
  exitReason: AutonomousPaperExitReason;
  exitedAt: string;
  proceedsUsd: number;
  pnlUsd: number;
  returnPercent: number;
}

export interface AutonomousPaperReplayHindsightBest {
  /** Descriptive hindsight only. This must never be treated as another sample
   * or fed directly into sizing. */
  evidenceClass: "HINDSIGHT_ONLY";
  variantIndex: number;
  variantId: string;
  variantDigest: string;
  exitReason: AutonomousPaperReplayVariantExitReason;
  exitObservationId: string;
  exitedAt: string;
  executableValueUsd: number;
  pnlUsd: number;
  returnPercent: number;
  returnDeltaVsActualPercent: number;
}

export interface AutonomousPaperReplayReport {
  pathId: string;
  gridVersion: typeof AUTONOMOUS_PAPER_REPLAY_GRID_VERSION;
  gridDigest: string;
  /** A thousand counterfactual policies over one price path remain one
   * independent sample. */
  sampleCount: 1;
  variantCount: typeof AUTONOMOUS_PAPER_REPLAY_VARIANT_COUNT;
  resolvedVariantCount: number;
  unresolvedVariantCount: number;
  actual: AutonomousPaperReplayActualResult;
  hindsightBest?: AutonomousPaperReplayHindsightBest;
  results: readonly AutonomousPaperReplayVariantResult[];
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function finite(value: number, label: string, minimum = Number.NEGATIVE_INFINITY): void {
  if (!Number.isFinite(value) || value < minimum) {
    throw new RangeError(`${label} must be a finite number no lower than ${minimum}.`);
  }
}

function validateOrganicBuyShare(value: number): void {
  if (!Number.isFinite(value) || (value !== -1 && (value < 0 || value > 1))) {
    throw new RangeError(
      "Replay organic buy share must be exactly -1 or a finite number between zero and one."
    );
  }
}

function canonicalVariantPayload(input: {
  index: number;
  stopLossPercent: number;
  takeProfitPercent: number;
  trailingActivationPercent: number;
  trailingDrawdownPercent: number;
  maximumHoldingMinutes: number;
  weakMomentumExitSamples: number;
  noProgressMinutes: number;
}): Record<string, number | string> {
  return {
    version: AUTONOMOUS_PAPER_REPLAY_GRID_VERSION,
    index: input.index,
    stopLossPercent: input.stopLossPercent,
    takeProfitPercent: input.takeProfitPercent,
    trailingActivationPercent: input.trailingActivationPercent,
    trailingDrawdownPercent: input.trailingDrawdownPercent,
    maximumHoldingMinutes: input.maximumHoldingMinutes,
    breakEvenActivationPercent:
      AUTONOMOUS_PAPER_REPLAY_FIXED_CONTROLS.breakEvenActivationPercent,
    weakMomentumExitSamples: input.weakMomentumExitSamples,
    noProgressMinutes: input.noProgressMinutes
  };
}

function buildReplayVariants(): readonly AutonomousPaperReplayVariant[] {
  const variants: AutonomousPaperReplayVariant[] = [];
  for (const stopLossPercent of STOP_LOSS_PERCENT_GRID) {
    for (const takeProfitPercent of TAKE_PROFIT_PERCENT_GRID) {
      for (const trailingActivationPercent of TRAILING_ACTIVATION_PERCENT_GRID) {
        for (const trailingDrawdownPercent of TRAILING_DRAWDOWN_PERCENT_GRID) {
          for (const maximumHoldingMinutes of MAXIMUM_HOLDING_MINUTES_GRID) {
            const index = variants.length;
            const stratum = index % WEAK_MOMENTUM_SAMPLES_GRID.length;
            const payload = canonicalVariantPayload({
              index,
              stopLossPercent,
              takeProfitPercent,
              trailingActivationPercent,
              trailingDrawdownPercent,
              maximumHoldingMinutes,
              weakMomentumExitSamples: WEAK_MOMENTUM_SAMPLES_GRID[stratum]!,
              noProgressMinutes: NO_PROGRESS_MINUTES_GRID[stratum]!
            });
            const digest = sha256(JSON.stringify(payload));
            variants.push(Object.freeze({
              ...payload,
              version: AUTONOMOUS_PAPER_REPLAY_GRID_VERSION,
              index,
              id: `${AUTONOMOUS_PAPER_REPLAY_GRID_VERSION}:${index
                .toString()
                .padStart(4, "0")}:${digest.slice(0, 16)}`,
              digest
            }) as AutonomousPaperReplayVariant);
          }
        }
      }
    }
  }
  if (variants.length !== AUTONOMOUS_PAPER_REPLAY_VARIANT_COUNT) {
    throw new Error(
      `Replay grid produced ${variants.length} variants instead of ` +
      `${AUTONOMOUS_PAPER_REPLAY_VARIANT_COUNT}.`
    );
  }
  return Object.freeze(variants);
}

export const AUTONOMOUS_PAPER_REPLAY_VARIANTS = buildReplayVariants();

/** Frozen production-policy comparator. Keep the assertion beside the grid so
 * an innocent-looking grid reorder cannot silently change the baseline. */
export const AUTONOMOUS_PAPER_REPLAY_BASELINE_VARIANT =
  AUTONOMOUS_PAPER_REPLAY_VARIANTS[473]!;
if (
  AUTONOMOUS_PAPER_REPLAY_BASELINE_VARIANT.stopLossPercent !== 10 ||
  AUTONOMOUS_PAPER_REPLAY_BASELINE_VARIANT.takeProfitPercent !== 18 ||
  AUTONOMOUS_PAPER_REPLAY_BASELINE_VARIANT.trailingActivationPercent !== 8 ||
  AUTONOMOUS_PAPER_REPLAY_BASELINE_VARIANT.trailingDrawdownPercent !== 5 ||
  AUTONOMOUS_PAPER_REPLAY_BASELINE_VARIANT.maximumHoldingMinutes !== 180 ||
  AUTONOMOUS_PAPER_REPLAY_BASELINE_VARIANT.weakMomentumExitSamples !== 3 ||
  AUTONOMOUS_PAPER_REPLAY_BASELINE_VARIANT.noProgressMinutes !== 45
) throw new Error("Autonomous replay baseline no longer matches the frozen production exits.");

export const AUTONOMOUS_PAPER_REPLAY_GRID_DIGEST = sha256(JSON.stringify(
  AUTONOMOUS_PAPER_REPLAY_VARIANTS.map((variant) => ({
    index: variant.index,
    digest: variant.digest
  }))
));

function validatePath(path: AutonomousPaperReplayPath): {
  openedAtMs: number;
  entry: Extract<AutonomousPaperReplayObservation, { status: "EXECUTABLE" }>;
  actualObservation: Extract<AutonomousPaperReplayObservation, { status: "EXECUTABLE" }>;
} {
  if (!path.id.trim()) throw new Error("Replay path identity is required.");
  const openedAtMs = Date.parse(path.openedAt);
  if (!Number.isFinite(openedAtMs)) throw new Error("Replay path opening time is invalid.");
  finite(path.entryCostUsd, "Replay entry cost", Number.EPSILON);
  if (path.observations.length === 0) throw new Error("Replay path requires observations.");

  const ids = new Set<string>();
  let previousAt = Number.NEGATIVE_INFINITY;
  for (const observation of path.observations) {
    if (!observation.id.trim() || ids.has(observation.id)) {
      throw new Error("Replay observation identities must be non-empty and unique.");
    }
    ids.add(observation.id);
    const observedAt = Date.parse(observation.observedAt);
    if (!Number.isFinite(observedAt) || observedAt <= previousAt) {
      throw new Error("Replay observations must be strictly chronological.");
    }
    if (observedAt < openedAtMs) {
      throw new Error("Replay observations cannot predate the entry.");
    }
    previousAt = observedAt;
    if (observation.status === "EXECUTABLE") {
      finite(observation.executableValueUsd, "Replay executable value", 0);
      finite(observation.priceChange5mPercent, "Replay 5m price change");
      validateOrganicBuyShare(observation.organicBuyShare5m);
    } else if (!observation.failureCode.trim()) {
      throw new Error("An unpriced replay observation requires a failure code.");
    }
  }

  const entry = path.observations[0];
  if (!entry || entry.kind !== "ENTRY" || entry.status !== "EXECUTABLE" ||
      Date.parse(entry.observedAt) !== openedAtMs) {
    throw new Error("Replay path must begin with an executable entry observation.");
  }
  if (!path.actual.exitObservationId.trim()) {
    throw new Error("Replay actual outcome requires an exit observation identity.");
  }
  finite(path.actual.proceedsUsd, "Replay actual proceeds", 0);
  const actualObservation = path.observations.find(
    (observation) => observation.id === path.actual.exitObservationId
  );
  if (!actualObservation || actualObservation.kind !== "ACTUAL_EXIT" ||
      actualObservation.status !== "EXECUTABLE") {
    throw new Error("Replay actual outcome must bind to an executable ACTUAL_EXIT observation.");
  }
  if (Math.abs(actualObservation.executableValueUsd - path.actual.proceedsUsd) > 1e-6) {
    throw new Error("Replay actual proceeds do not match their executable observation.");
  }
  return { openedAtMs, entry, actualObservation };
}

function returnPercent(executableValueUsd: number, entryCostUsd: number): number {
  return (executableValueUsd / entryCostUsd - 1) * 100;
}

function unresolvedResult(input: {
  variant: AutonomousPaperReplayVariant;
  reason: AutonomousPaperReplayUnresolvedReason;
  observationsConsumed: number;
  peakReturnPercent: number;
  troughReturnPercent: number;
  maximumDrawdownPercent: number;
  observation?: AutonomousPaperReplayObservation;
}): AutonomousPaperReplayVariantResult {
  return Object.freeze({
    variantIndex: input.variant.index,
    variantId: input.variant.id,
    variantDigest: input.variant.digest,
    status: "UNRESOLVED",
    unresolvedReason: input.reason,
    observationsConsumed: input.observationsConsumed,
    peakReturnPercent: input.peakReturnPercent,
    troughReturnPercent: input.troughReturnPercent,
    maximumDrawdownPercent: input.maximumDrawdownPercent,
    ...(input.observation
      ? {
          unresolvedAt: input.observation.observedAt,
          unresolvedObservationId: input.observation.id
        }
      : {})
  });
}

function replayVariant(
  path: AutonomousPaperReplayPath,
  openedAtMs: number,
  entry: Extract<AutonomousPaperReplayObservation, { status: "EXECUTABLE" }>,
  variant: AutonomousPaperReplayVariant
): AutonomousPaperReplayVariantResult {
  const entryReturn = returnPercent(entry.executableValueUsd, path.entryCostUsd);
  let peakExecutableValueUsd = entry.executableValueUsd;
  let peakReturnPercent = entryReturn;
  let troughReturnPercent = entryReturn;
  let maximumDrawdownPercent = 0;
  let weakMomentumSamples = 0;
  let observationsConsumed = 1;

  for (let index = 1; index < path.observations.length; index += 1) {
    const observation = path.observations[index];
    if (!observation) throw new Error("Replay observation index changed during evaluation.");
    observationsConsumed += 1;
    if (observation.status === "UNPRICED") {
      return unresolvedResult({
        variant,
        reason: "MISSING_EXECUTABLE_OBSERVATION",
        observationsConsumed,
        peakReturnPercent,
        troughReturnPercent,
        maximumDrawdownPercent,
        observation
      });
    }

    const currentReturnPercent = returnPercent(
      observation.executableValueUsd,
      path.entryCostUsd
    );
    peakExecutableValueUsd = Math.max(
      peakExecutableValueUsd,
      observation.executableValueUsd
    );
    peakReturnPercent = Math.max(
      peakReturnPercent,
      returnPercent(peakExecutableValueUsd, path.entryCostUsd)
    );
    troughReturnPercent = Math.min(troughReturnPercent, currentReturnPercent);
    const peakDrawdownPercent = peakExecutableValueUsd > 0
      ? (peakExecutableValueUsd - observation.executableValueUsd) /
        peakExecutableValueUsd * 100
      : 0;
    maximumDrawdownPercent = Math.max(maximumDrawdownPercent, peakDrawdownPercent);
    const weak = observation.priceChange5mPercent <= -1 ||
      observation.organicBuyShare5m < 0.45;
    weakMomentumSamples = weak ? weakMomentumSamples + 1 : 0;
    const ageMinutes = (Date.parse(observation.observedAt) - openedAtMs) / 60_000;

    let exitReason: AutonomousPaperReplayVariantExitReason | undefined;
    if (!observation.staticSafetyEligible) exitReason = "TOKEN_SAFETY";
    else if (currentReturnPercent <= -variant.stopLossPercent) exitReason = "STOP_LOSS";
    else if (currentReturnPercent >= variant.takeProfitPercent) exitReason = "TAKE_PROFIT";
    else if (peakReturnPercent >= variant.trailingActivationPercent &&
        peakDrawdownPercent >= variant.trailingDrawdownPercent) exitReason = "TRAILING_STOP";
    else if (peakReturnPercent >= variant.breakEvenActivationPercent &&
        currentReturnPercent <= 0) exitReason = "BREAK_EVEN";
    else if (weakMomentumSamples >= variant.weakMomentumExitSamples) {
      exitReason = "WEAK_MOMENTUM";
    } else if (ageMinutes >= variant.maximumHoldingMinutes) exitReason = "MAX_HOLD";
    else if (ageMinutes >= variant.noProgressMinutes && peakReturnPercent < 3) {
      exitReason = "NO_PROGRESS";
    }

    if (exitReason) {
      return Object.freeze({
        variantIndex: variant.index,
        variantId: variant.id,
        variantDigest: variant.digest,
        status: "RESOLVED",
        exitReason,
        exitObservationId: observation.id,
        exitedAt: observation.observedAt,
        executableValueUsd: observation.executableValueUsd,
        pnlUsd: observation.executableValueUsd - path.entryCostUsd,
        returnPercent: currentReturnPercent,
        observationsConsumed,
        peakReturnPercent,
        troughReturnPercent,
        maximumDrawdownPercent
      });
    }
  }

  return unresolvedResult({
    variant,
    reason: "PATH_ENDED_BEFORE_EXIT",
    observationsConsumed,
    peakReturnPercent,
    troughReturnPercent,
    maximumDrawdownPercent
  });
}

/** Evaluates every policy against exactly one immutable path. It intentionally
 * exposes only a per-path hindsight winner; robust policy selection belongs to
 * a separately persisted, purged walk-forward/holdout process. */
export function evaluateAutonomousPaperReplay(
  path: AutonomousPaperReplayPath
): AutonomousPaperReplayReport {
  const { openedAtMs, entry, actualObservation } = validatePath(path);
  const results = Object.freeze(AUTONOMOUS_PAPER_REPLAY_VARIANTS.map((variant) =>
    replayVariant(path, openedAtMs, entry, variant)
  ));
  const resolved = results.filter((result): result is Extract<
    AutonomousPaperReplayVariantResult,
    { status: "RESOLVED" }
  > => result.status === "RESOLVED");
  const hindsight = [...resolved].sort((left, right) =>
    right.returnPercent - left.returnPercent || left.variantIndex - right.variantIndex
  )[0];
  const actualReturnPercent = returnPercent(path.actual.proceedsUsd, path.entryCostUsd);
  const actual: AutonomousPaperReplayActualResult = Object.freeze({
    exitObservationId: actualObservation.id,
    exitReason: path.actual.exitReason,
    exitedAt: actualObservation.observedAt,
    proceedsUsd: path.actual.proceedsUsd,
    pnlUsd: path.actual.proceedsUsd - path.entryCostUsd,
    returnPercent: actualReturnPercent
  });
  const hindsightBest: AutonomousPaperReplayHindsightBest | undefined = hindsight
    ? Object.freeze({
        evidenceClass: "HINDSIGHT_ONLY",
        variantIndex: hindsight.variantIndex,
        variantId: hindsight.variantId,
        variantDigest: hindsight.variantDigest,
        exitReason: hindsight.exitReason,
        exitObservationId: hindsight.exitObservationId,
        exitedAt: hindsight.exitedAt,
        executableValueUsd: hindsight.executableValueUsd,
        pnlUsd: hindsight.pnlUsd,
        returnPercent: hindsight.returnPercent,
        returnDeltaVsActualPercent: hindsight.returnPercent - actualReturnPercent
      })
    : undefined;

  return Object.freeze({
    pathId: path.id,
    gridVersion: AUTONOMOUS_PAPER_REPLAY_GRID_VERSION,
    gridDigest: AUTONOMOUS_PAPER_REPLAY_GRID_DIGEST,
    sampleCount: 1,
    variantCount: AUTONOMOUS_PAPER_REPLAY_VARIANT_COUNT,
    resolvedVariantCount: resolved.length,
    unresolvedVariantCount: results.length - resolved.length,
    actual,
    ...(hindsightBest ? { hindsightBest } : {}),
    results
  });
}
