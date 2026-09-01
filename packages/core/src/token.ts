import {
  DEFAULT_TOKEN_POLICY,
  TOKEN_PROGRAM_ID,
  type TokenEligibility,
  type TokenPolicy
} from "@copylab/shared";

const DAY_MS = 86_400_000;

export const TOKEN_REASON = Object.freeze({
  UNVERIFIED: "token is not Jupiter verified",
  SUSPICIOUS: "token is banned or suspicious",
  NON_STANDARD_PROGRAM: "token does not use the standard SPL Token program",
  MINT_AUTHORITY: "mint authority is enabled",
  FREEZE_AUTHORITY: "freeze authority is enabled",
  UNKNOWN_AGE: "first pool creation time is unknown",
  TOO_NEW: "token is younger than the minimum age",
  LOW_LIQUIDITY: "token liquidity is below the minimum",
  LOW_VOLUME: "token 24-hour volume is below the minimum",
  LOW_HOLDERS: "token holder count is below the minimum",
  LOW_ORGANIC_SCORE: "token organic score is below the minimum",
  HOLDER_CONCENTRATION: "top-holder concentration is above the maximum"
});

/** Recomputes eligibility from provider facts; provider-supplied eligible/reasons are never trusted. */
export function evaluateTokenPolicy(
  token: TokenEligibility,
  now: Date = new Date(),
  policy: Readonly<TokenPolicy> = DEFAULT_TOKEN_POLICY
): TokenEligibility {
  const reasons: string[] = [];

  if (policy.requireVerified && !token.verified) reasons.push(TOKEN_REASON.UNVERIFIED);
  if (token.suspicious) reasons.push(TOKEN_REASON.SUSPICIOUS);
  if (policy.requireStandardTokenProgram && token.tokenProgram !== TOKEN_PROGRAM_ID) {
    reasons.push(TOKEN_REASON.NON_STANDARD_PROGRAM);
  }
  if (!token.mintAuthorityDisabled) reasons.push(TOKEN_REASON.MINT_AUTHORITY);
  if (!token.freezeAuthorityDisabled) reasons.push(TOKEN_REASON.FREEZE_AUTHORITY);

  const firstPoolTimestamp = token.firstPoolAt ? Date.parse(token.firstPoolAt) : Number.NaN;
  if (!Number.isFinite(firstPoolTimestamp)) {
    reasons.push(TOKEN_REASON.UNKNOWN_AGE);
  } else if ((now.getTime() - firstPoolTimestamp) / DAY_MS < policy.minimumAgeDays) {
    reasons.push(TOKEN_REASON.TOO_NEW);
  }

  if (token.liquidityUsd < policy.minimumLiquidityUsd) reasons.push(TOKEN_REASON.LOW_LIQUIDITY);
  if (token.volume24hUsd < policy.minimumVolume24hUsd) reasons.push(TOKEN_REASON.LOW_VOLUME);
  if (token.holderCount < policy.minimumHolderCount) reasons.push(TOKEN_REASON.LOW_HOLDERS);
  if (token.organicScore < policy.minimumOrganicScore) reasons.push(TOKEN_REASON.LOW_ORGANIC_SCORE);
  if (token.topHoldersPercent > policy.maximumTopHoldersPercent) {
    reasons.push(TOKEN_REASON.HOLDER_CONCENTRATION);
  }

  return {
    ...token,
    checkedAt: now.toISOString(),
    eligible: reasons.length === 0,
    reasons
  };
}
