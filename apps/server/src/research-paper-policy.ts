import {
  DEFAULT_RISK_POLICY,
  RESEARCH_PAPER_LABEL,
  type QuoteSnapshot
} from "@copylab/shared";

export const RESEARCH_PAPER_POLICY_VERSION = "high-risk-paper-v2";
export { RESEARCH_PAPER_LABEL };

export interface ResearchPaperSizingPolicy {
  positionNavFraction: number;
  maximumPositionUsd: number;
  maximumOpenPositions: number;
  maximumDeployedFraction: number;
  minimumLiquidReserveUsd: number;
}

/** Compatibility policy for lanes created before high-risk sizing was
 * independently configurable. */
export const LEGACY_RESEARCH_PAPER_SIZING_POLICY: ResearchPaperSizingPolicy = {
  positionNavFraction: DEFAULT_RISK_POLICY.positionNavFraction,
  maximumPositionUsd: DEFAULT_RISK_POLICY.maxPositionUsd,
  maximumOpenPositions: DEFAULT_RISK_POLICY.maxOpenPositions,
  maximumDeployedFraction: DEFAULT_RISK_POLICY.maxDeployedFraction,
  minimumLiquidReserveUsd: DEFAULT_RISK_POLICY.minimumLiquidReserveUsd
};

/** Larger entries requested for the isolated high-risk PAPER experiment.
 * The absolute and aggregate deployment ceilings remain bounded. */
export const LARGER_RESEARCH_PAPER_SIZING_POLICY: ResearchPaperSizingPolicy = {
  positionNavFraction: 0.2,
  maximumPositionUsd: 25,
  maximumOpenPositions: DEFAULT_RISK_POLICY.maxOpenPositions,
  maximumDeployedFraction: DEFAULT_RISK_POLICY.maxDeployedFraction,
  minimumLiquidReserveUsd: DEFAULT_RISK_POLICY.minimumLiquidReserveUsd
};

export function researchPaperSizingPolicy(
  persisted: Record<string, unknown>
): ResearchPaperSizingPolicy | undefined {
  const sizingKeys = [
    "positionNavFraction",
    "maximumPositionUsd",
    "maximumOpenPositions",
    "maximumDeployedFraction",
    "minimumLiquidReserveUsd"
  ] as const;
  if (!sizingKeys.some((key) => Object.hasOwn(persisted, key))) {
    return LEGACY_RESEARCH_PAPER_SIZING_POLICY;
  }
  const candidate: ResearchPaperSizingPolicy = {
    positionNavFraction: Number(persisted.positionNavFraction),
    maximumPositionUsd: Number(persisted.maximumPositionUsd),
    maximumOpenPositions: Number(persisted.maximumOpenPositions),
    maximumDeployedFraction: Number(persisted.maximumDeployedFraction),
    minimumLiquidReserveUsd: Number(persisted.minimumLiquidReserveUsd)
  };
  if (
    !Number.isFinite(candidate.positionNavFraction) || candidate.positionNavFraction <= 0 ||
    candidate.positionNavFraction > 1 ||
    !Number.isFinite(candidate.maximumPositionUsd) || candidate.maximumPositionUsd <= 0 ||
    !Number.isSafeInteger(candidate.maximumOpenPositions) || candidate.maximumOpenPositions <= 0 ||
    !Number.isFinite(candidate.maximumDeployedFraction) || candidate.maximumDeployedFraction <= 0 ||
    candidate.maximumDeployedFraction > 1 ||
    !Number.isFinite(candidate.minimumLiquidReserveUsd) || candidate.minimumLiquidReserveUsd < 0
  ) return undefined;
  return candidate;
}

export interface ResearchPaperCapitalState {
  navUsd: number;
  cashUsd: number;
  deployedUsd: number;
  openPositions: number;
}

export type ResearchPaperEntrySizingDecision =
  | { allowed: true; sizeUsd: number }
  | {
      allowed: false;
      reason: "INVALID_POLICY" | "INVALID_CAPITAL" | "MAX_POSITIONS" | "MAX_DEPLOYED" | "INSUFFICIENT_RESERVE";
    };

/**
 * Size from the policy persisted on the isolated research lane. Strict PAPER
 * never calls this function, so a research revision cannot change strict or
 * live sizing.
 */
export function researchPaperEntrySize(
  state: ResearchPaperCapitalState,
  policy?: ResearchPaperSizingPolicy
): ResearchPaperEntrySizingDecision {
  const sizing = arguments.length >= 2 ? policy : LEGACY_RESEARCH_PAPER_SIZING_POLICY;
  if (!sizing) return { allowed: false, reason: "INVALID_POLICY" };
  if (
    !Number.isFinite(state.navUsd) || state.navUsd <= 0 ||
    !Number.isFinite(state.cashUsd) || state.cashUsd < 0 ||
    !Number.isFinite(state.deployedUsd) || state.deployedUsd < 0 ||
    !Number.isSafeInteger(state.openPositions) || state.openPositions < 0
  ) return { allowed: false, reason: "INVALID_CAPITAL" };
  if (state.openPositions >= sizing.maximumOpenPositions) {
    return { allowed: false, reason: "MAX_POSITIONS" };
  }
  const sizeUsd = Math.min(
    sizing.maximumPositionUsd,
    state.navUsd * sizing.positionNavFraction
  );
  if (state.deployedUsd + sizeUsd > state.navUsd * sizing.maximumDeployedFraction + 1e-9) {
    return { allowed: false, reason: "MAX_DEPLOYED" };
  }
  if (state.cashUsd - sizeUsd < sizing.minimumLiquidReserveUsd - 1e-9) {
    return { allowed: false, reason: "INSUFFICIENT_RESERVE" };
  }
  return { allowed: true, sizeUsd };
}

export function researchPaperModeledQuoteCostUsd(
  quote: QuoteSnapshot,
  solPriceUsd: number
): number {
  if (!Number.isFinite(solPriceUsd) || solPriceUsd < 0) {
    throw new Error("Research-paper SOL price must be a finite non-negative number.");
  }
  const networkLamports =
    quote.signatureFeeLamports +
    quote.prioritizationFeeLamports +
    quote.rentFeeLamports;
  const cost = quote.inputUsd * (quote.feeBps / 10_000) +
    (networkLamports / 1_000_000_000) * solPriceUsd;
  if (!Number.isFinite(cost) || cost < 0) {
    throw new Error("Research-paper quote costs were invalid.");
  }
  return cost;
}

export function researchPaperQuoteUsable(
  quote: QuoteSnapshot,
  now = new Date()
): boolean {
  try {
    if (
      BigInt(quote.inputAmountAtomic) <= 0n ||
      BigInt(quote.outputAmountAtomic) <= 0n ||
      BigInt(quote.minimumOutputAtomic) <= 0n
    ) return false;
  } catch {
    return false;
  }
  const quotedAt = Date.parse(quote.quotedAt);
  const quoteAgeMs = now.getTime() - quotedAt;
  return Number.isFinite(quote.inputUsd) && quote.inputUsd > 0 &&
    Number.isFinite(quote.outputUsd) && quote.outputUsd >= 0 &&
    Number.isFinite(quotedAt) && quoteAgeMs >= -1_000 &&
    quoteAgeMs <= DEFAULT_RISK_POLICY.maximumQuoteAgeSeconds * 1_000 &&
    quote.transactionBase64 === undefined &&
    (!quote.expiresAt || Date.parse(quote.expiresAt) > now.getTime());
}

export interface ResearchPaperExitPlan {
  followerSellAtomic: string;
  nextLeaderRemainingAtomic: string;
  closesPosition: boolean;
}

/** Mirror the leader's cumulative exit and close the research lot once the
 * leader has sold at least 90%, matching the strict lane's exit convention. */
export function researchPaperExitPlan(input: {
  followerRemainingAtomic: string;
  leaderInitialAtomic: string;
  leaderRemainingAtomic: string;
  sourceSellAtomic: string;
}): ResearchPaperExitPlan | undefined {
  let followerRemaining: bigint;
  let leaderInitial: bigint;
  let leaderRemaining: bigint;
  let sourceSell: bigint;
  try {
    followerRemaining = BigInt(input.followerRemainingAtomic);
    leaderInitial = BigInt(input.leaderInitialAtomic);
    leaderRemaining = BigInt(input.leaderRemainingAtomic);
    sourceSell = BigInt(input.sourceSellAtomic);
  } catch {
    return undefined;
  }
  if (
    followerRemaining <= 0n || leaderInitial <= 0n || leaderRemaining <= 0n ||
    leaderRemaining > leaderInitial || sourceSell <= 0n
  ) return undefined;
  const sold = sourceSell > leaderRemaining ? leaderRemaining : sourceSell;
  const nextLeaderRemaining = leaderRemaining - sold;
  const cumulativeSoldBillionths =
    ((leaderInitial - nextLeaderRemaining) * 1_000_000_000n) / leaderInitial;
  const closesPosition = cumulativeSoldBillionths >= 900_000_000n;
  const followerSell = closesPosition
    ? followerRemaining
    : (followerRemaining * sold) / leaderRemaining;
  if (followerSell <= 0n) return undefined;
  return {
    followerSellAtomic: followerSell.toString(),
    nextLeaderRemainingAtomic: nextLeaderRemaining.toString(),
    closesPosition
  };
}
