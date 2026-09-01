import type {
  OperationalPauseReason,
  OperationalPauseRecovery,
  OperationalPauseState
} from "@copylab/shared";

const MANUAL_REVIEW_REASONS = new Set<OperationalPauseReason>([
  "BALANCE_MISMATCH",
  "LIVE_START_LOSS",
  "PEAK_DRAWDOWN",
  "LEGACY_SAFETY_PAUSE"
]);

function recoveryFor(reasons: readonly OperationalPauseReason[]): OperationalPauseRecovery {
  if (reasons.some((reason) => MANUAL_REVIEW_REASONS.has(reason))) return "MANUAL_REVIEW";
  if (reasons.includes("DAILY_LOSS")) return "NEXT_UTC_DAY";
  return reasons.length > 0 ? "WHEN_CONDITIONS_CLEAR" : "NONE";
}

function sameUtcDay(left: string | undefined, right: Date): boolean {
  return left?.slice(0, 10) === right.toISOString().slice(0, 10);
}

export function inactiveOperationalPause(now = new Date()): OperationalPauseState {
  return {
    active: false,
    reasons: [],
    recovery: "NONE",
    lastEvaluatedAt: now.toISOString()
  };
}

export function legacyOperationalPause(now = new Date()): OperationalPauseState {
  return {
    active: true,
    reasons: ["LEGACY_SAFETY_PAUSE"],
    recovery: "MANUAL_REVIEW",
    pausedAt: now.toISOString(),
    lastEvaluatedAt: now.toISOString()
  };
}

/**
 * Resolve a periodic stop evaluation into a durable pause. A manual recheck
 * never overrides a currently unsafe condition; it only releases a prior
 * manual-review hold after the live evaluation returns no reasons.
 */
export function resolveOperationalPause(
  current: OperationalPauseState,
  reasons: readonly OperationalPauseReason[],
  now = new Date(),
  manualRecheck = false
): OperationalPauseState {
  const at = now.toISOString();
  if (reasons.length > 0) {
    const normalized = [...new Set(reasons)] as OperationalPauseReason[];
    return {
      active: true,
      reasons: normalized,
      recovery: recoveryFor(normalized),
      pausedAt: current.active ? current.pausedAt ?? at : at,
      lastEvaluatedAt: at
    };
  }

  if (!current.active) return { ...current, lastEvaluatedAt: at };
  if (current.recovery === "MANUAL_REVIEW" && !manualRecheck) {
    return { ...current, lastEvaluatedAt: at };
  }
  if (current.recovery === "NEXT_UTC_DAY" && sameUtcDay(current.pausedAt, now)) {
    return { ...current, lastEvaluatedAt: at };
  }
  return {
    active: false,
    reasons: [],
    recovery: "NONE",
    lastEvaluatedAt: at,
    recoveredAt: at
  };
}
