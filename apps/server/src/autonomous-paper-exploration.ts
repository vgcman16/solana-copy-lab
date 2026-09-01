import type { AutonomousMomentumResult } from "./autonomous-paper-policy.js";

/** Frozen semantics for the v8 PAPER-only exploration arm.  These are kept
 * outside the generic policy object because older policy epochs must never be
 * opted into a new admission path by a later JSON default or migration. */
export const AUTONOMOUS_PAPER_EXPLORATION_VERSION =
  "controlled-soft-momentum-v1" as const;

export const AUTONOMOUS_PAPER_EXPLORATION_MINIMUM_SCORE = 30;
export const AUTONOMOUS_PAPER_EXPLORATION_MAXIMUM_SOFT_REASONS = 2;
export const AUTONOMOUS_PAPER_EXPLORATION_MAXIMUM_ENTRIES_PER_UTC_DAY = 4;

/** Only flow-strength misses are exploratory.  Missing evidence, token
 * safety, liquidity drain, vertical-pump, absolute momentum-range, and SOL
 * regime failures remain hard rejections even in the high-risk PAPER arm. */
export const AUTONOMOUS_PAPER_EXPLORATION_SOFT_REASONS = Object.freeze([
  "WEAK_FIVE_MINUTE_ORGANIC_BUYING",
  "WEAK_ONE_HOUR_ORGANIC_BUYING",
  "LOW_FIVE_MINUTE_ORGANIC_VOLUME",
  "LOW_ONE_HOUR_ORGANIC_VOLUME",
  "LOW_ORGANIC_BUYER_BREADTH",
  "LOW_VOLUME_ACCELERATION"
] as const);

export type AutonomousPaperExplorationSoftReason =
  typeof AUTONOMOUS_PAPER_EXPLORATION_SOFT_REASONS[number];

export interface AutonomousPaperExplorationAdmission {
  eligible: boolean;
  version: typeof AUTONOMOUS_PAPER_EXPLORATION_VERSION;
  score: number;
  waivedReasons: AutonomousPaperExplorationSoftReason[];
  blockingReasons: string[];
}

const softReasons = new Set<string>(AUTONOMOUS_PAPER_EXPLORATION_SOFT_REASONS);

/** Deterministic near-miss classifier.  The caller must independently prove
 * static token admission, complete/fresh evidence, capital limits, cadence,
 * and exact round-trip quote ceilings before a simulated position can open. */
export function autonomousControlledExploration(
  momentum: AutonomousMomentumResult
): AutonomousPaperExplorationAdmission {
  const unique = [...new Set(momentum.reasons)];
  const waivedReasons = unique.filter(
    (reason): reason is AutonomousPaperExplorationSoftReason => softReasons.has(reason)
  );
  const blockingReasons = unique.filter((reason) => !softReasons.has(reason));
  const eligible =
    !momentum.eligible &&
    Number.isFinite(momentum.score) &&
    momentum.score >= AUTONOMOUS_PAPER_EXPLORATION_MINIMUM_SCORE &&
    waivedReasons.length >= 1 &&
    waivedReasons.length <= AUTONOMOUS_PAPER_EXPLORATION_MAXIMUM_SOFT_REASONS &&
    blockingReasons.length === 0;
  return {
    eligible,
    version: AUTONOMOUS_PAPER_EXPLORATION_VERSION,
    score: momentum.score,
    waivedReasons,
    blockingReasons
  };
}
