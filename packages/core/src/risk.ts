import {
  DEFAULT_RISK_POLICY,
  SOL_MINT,
  type CopyIntent,
  type ModeState,
  type PortfolioSnapshot,
  type PositionLot,
  type ProviderHealth,
  type QuoteSnapshot,
  type RiskDecision,
  type RiskPolicy,
  type RiskReasonCode,
  type TokenEligibility
} from "@copylab/shared";

export interface RiskEvaluationInput {
  now?: Date;
  mode: ModeState;
  intent: CopyIntent;
  token: TokenEligibility;
  entryQuote: QuoteSnapshot;
  exitQuote?: QuoteSnapshot;
  followerPriceUsd?: number;
  solPriceUsd: number;
  portfolio: PortfolioSnapshot;
  positions: readonly PositionLot[];
  providerHealth: readonly ProviderHealth[];
  seenIdempotencyKeys?: ReadonlySet<string> | readonly string[];
  liveStartNavUsd?: number;
}

export interface QuoteCostBreakdown {
  impactPercent: number;
  slippagePercent: number;
  routerFeePercent: number;
  networkAndRentPercent: number;
  totalPercent: number;
}

interface Finding {
  code: RiskReasonCode;
  message: string;
}

function ageSeconds(value: string, now: Date): number {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? (now.getTime() - timestamp) / 1_000 : Number.POSITIVE_INFINITY;
}

function percentageLoss(start: number, current: number): number {
  return start > 0 ? Math.max(0, ((start - current) / start) * 100) : 0;
}

function exceeds(value: number, maximum: number): boolean {
  const tolerance = Math.max(1, Math.abs(maximum)) * 1e-12;
  return value - maximum > tolerance;
}

function reachesThreshold(value: number, threshold: number): boolean {
  const tolerance = Math.max(1, Math.abs(threshold)) * 1e-12;
  return value >= threshold - tolerance;
}

function quoteLamports(quote: QuoteSnapshot): number {
  return quote.signatureFeeLamports + quote.prioritizationFeeLamports + quote.rentFeeLamports;
}

function quoteVariableCostPercent(quote: QuoteSnapshot): number {
  return quote.priceImpactPercent + quote.slippageBps / 100 + quote.feeBps / 100;
}

export function calculateProjectedRoundTripCost(
  entry: QuoteSnapshot,
  exit: QuoteSnapshot,
  solPriceUsd: number,
  positionUsd: number
): QuoteCostBreakdown {
  const impactPercent = entry.priceImpactPercent + exit.priceImpactPercent;
  const slippagePercent = (entry.slippageBps + exit.slippageBps) / 100;
  const routerFeePercent = (entry.feeBps + exit.feeBps) / 100;
  const lamports = quoteLamports(entry) + quoteLamports(exit);
  const networkAndRentUsd = (lamports / 1_000_000_000) * solPriceUsd;
  const networkAndRentPercent = positionUsd > 0 ? (networkAndRentUsd / positionUsd) * 100 : Infinity;
  return {
    impactPercent,
    slippagePercent,
    routerFeePercent,
    networkAndRentPercent,
    totalPercent: impactPercent + slippagePercent + routerFeePercent + networkAndRentPercent
  };
}

function quoteMatchesIntent(intent: CopyIntent, quote: QuoteSnapshot): boolean {
  try {
    return (
      quote.inputMint === intent.inputMint &&
      quote.outputMint === intent.outputMint &&
      BigInt(quote.inputAmountAtomic) === BigInt(intent.inputAmountAtomic)
    );
  } catch {
    return false;
  }
}

function includesKey(keys: ReadonlySet<string> | readonly string[] | undefined, key: string): boolean {
  if (!keys) return false;
  return Array.isArray(keys) ? keys.includes(key) : (keys as ReadonlySet<string>).has(key);
}

function add(findings: Finding[], code: RiskReasonCode, condition: boolean, message: string): void {
  if (condition) findings.push({ code, message });
}

export function evaluateRisk(
  input: RiskEvaluationInput,
  policy: Readonly<RiskPolicy> = DEFAULT_RISK_POLICY
): RiskDecision {
  const now = input.now ?? new Date();
  const findings: Finding[] = [];
  const isBuy = input.intent.side === "BUY";
  const activePositions = input.positions.filter(
    (position) => position.status === "OPEN" || position.status === "CLOSING"
  );

  add(
    findings,
    "MODE_BLOCKED",
    !["PAPER", "MANUAL_LIVE", "AUTO_LIVE"].includes(input.mode),
    `mode ${input.mode} does not permit copy execution`
  );
  add(findings, "DUPLICATE_SIGNAL", includesKey(input.seenIdempotencyKeys, input.intent.idempotencyKey), "signal was already handled");
  add(findings, "RECOVERED_SIGNAL", input.intent.sourceSwap.recovered, "recovered signals are analysis-only");
  add(
    findings,
    "STALE_SIGNAL",
    ageSeconds(input.intent.sourceSwap.blockTime, now) > policy.maximumSignalAgeSeconds,
    `source signal is older than ${policy.maximumSignalAgeSeconds} seconds`
  );

  const criticalProviderDown = input.providerHealth.some(
    (health) => (health.provider === "helius" || health.provider === "jupiter") && !health.ok
  );
  add(findings, "PROVIDER_UNHEALTHY", criticalProviderDown, "a critical execution provider is unhealthy");
  add(
    findings,
    "BALANCE_MISMATCH",
    input.portfolio.balanceMismatchPercent > 1,
    "recorded and on-chain balances differ by more than 1% of NAV"
  );
  add(findings, "UNKNOWN_TRANSACTION", !quoteMatchesIntent(input.intent, input.entryQuote), "entry quote does not match the copy intent");

  const entryAge = ageSeconds(input.entryQuote.quotedAt, now);
  const entryExpiredAt = input.entryQuote.expiresAt ? Date.parse(input.entryQuote.expiresAt) : undefined;
  const entryExpired =
    entryAge > policy.maximumQuoteAgeSeconds ||
    (entryExpiredAt !== undefined && (!Number.isFinite(entryExpiredAt) || entryExpiredAt <= now.getTime()));
  add(findings, "QUOTE_EXPIRED", entryExpired, "entry quote is stale or expired");

  let projectedRoundTripCostPercent: number | undefined;
  let followerPriceDivergencePercent: number | undefined;
  const positionSizeUsd = Math.min(policy.maxPositionUsd, input.portfolio.navUsd * policy.positionNavFraction);

  if (isBuy) {
    add(findings, "TOKEN_INELIGIBLE", !input.token.eligible, `token is ineligible: ${input.token.reasons.join("; ")}`);
    add(findings, "NO_SELL_QUOTE", !input.exitQuote, "a full-position sell quote is required");

    if (input.exitQuote) {
      const exitAge = ageSeconds(input.exitQuote.quotedAt, now);
      const exitExpiredAt = input.exitQuote.expiresAt ? Date.parse(input.exitQuote.expiresAt) : undefined;
      add(
        findings,
        "QUOTE_EXPIRED",
        exitAge > policy.maximumQuoteAgeSeconds ||
          (exitExpiredAt !== undefined && (!Number.isFinite(exitExpiredAt) || exitExpiredAt <= now.getTime())),
        "exit quote is stale or expired"
      );

      add(
        findings,
        "UNKNOWN_TRANSACTION",
        input.exitQuote.inputMint !== input.intent.outputMint || input.exitQuote.outputMint !== input.intent.inputMint,
        "exit quote does not reverse the entry route"
      );
      add(
        findings,
        "PRICE_IMPACT",
        exceeds(input.exitQuote.priceImpactPercent, policy.maximumPriceImpactPercent),
        `exit price impact exceeds ${policy.maximumPriceImpactPercent}%`
      );

      if (Number.isFinite(input.solPriceUsd) && input.solPriceUsd > 0) {
        projectedRoundTripCostPercent = calculateProjectedRoundTripCost(
          input.entryQuote,
          input.exitQuote,
          input.solPriceUsd,
          input.intent.inputAmountUsd
        ).totalPercent;
        add(
          findings,
          "ROUND_TRIP_COST",
          exceeds(projectedRoundTripCostPercent, policy.maximumRoundTripCostPercent),
          `projected round-trip cost exceeds ${policy.maximumRoundTripCostPercent}%`
        );
      } else {
        add(findings, "UNKNOWN_TRANSACTION", true, "a positive SOL/USD price is required to price network fees");
      }
    }

    if (
      input.followerPriceUsd !== undefined &&
      Number.isFinite(input.followerPriceUsd) &&
      input.followerPriceUsd > 0 &&
      input.intent.sourceSwap.leaderPriceUsd > 0
    ) {
      followerPriceDivergencePercent =
        (Math.abs(input.followerPriceUsd - input.intent.sourceSwap.leaderPriceUsd) /
          input.intent.sourceSwap.leaderPriceUsd) *
        100;
      add(
        findings,
        "PRICE_DIVERGENCE",
        exceeds(followerPriceDivergencePercent, policy.maximumLeaderDivergencePercent),
        `follower price is more than ${policy.maximumLeaderDivergencePercent}% from the leader fill`
      );
    } else {
      add(findings, "UNKNOWN_TRANSACTION", true, "a positive follower token price is required");
    }

    add(
      findings,
      "PRICE_IMPACT",
      exceeds(input.entryQuote.priceImpactPercent, policy.maximumPriceImpactPercent),
      `entry price impact exceeds ${policy.maximumPriceImpactPercent}%`
    );
    add(findings, "MAX_POSITIONS", activePositions.length >= policy.maxOpenPositions, "maximum open positions reached");
    add(
      findings,
      "DUPLICATE_POSITION",
      activePositions.some((position) => position.mint === input.intent.sourceSwap.targetMint),
      "an open position already exists for this mint"
    );
    add(
      findings,
      "MAX_DEPLOYED",
      input.intent.inputAmountUsd <= 0 || input.intent.inputAmountUsd > positionSizeUsd,
      `entry exceeds the ${positionSizeUsd.toFixed(2)} USD position cap`
    );
    add(
      findings,
      "MAX_DEPLOYED",
      input.portfolio.navUsd <= 0 ||
        input.portfolio.deployedUsd + input.intent.inputAmountUsd >
          input.portfolio.navUsd * policy.maxDeployedFraction,
      `entry would deploy more than ${policy.maxDeployedFraction * 100}% of NAV`
    );

    const solAfterEntry =
      input.portfolio.solReserveUsd - (input.intent.inputMint === SOL_MINT ? input.intent.inputAmountUsd : 0);
    const liquidAfterEntry = input.portfolio.liquidReserveUsd - input.intent.inputAmountUsd;
    add(
      findings,
      "INSUFFICIENT_RESERVE",
      solAfterEntry < policy.minimumSolReserveUsd || liquidAfterEntry < policy.minimumLiquidReserveUsd,
      "entry would breach the SOL or liquid reserve"
    );

    add(
      findings,
      "DAILY_LOSS_STOP",
      reachesThreshold(
        percentageLoss(input.portfolio.dayStartNavUsd, input.portfolio.navUsd),
        policy.dailyLossPausePercent
      ),
      "daily loss pause threshold reached"
    );
    const hardLossReached =
      input.liveStartNavUsd !== undefined &&
      reachesThreshold(
        percentageLoss(input.liveStartNavUsd, input.portfolio.navUsd),
        policy.hardLiveStartLossPercent
      );
    const hardDrawdownReached = reachesThreshold(
      percentageLoss(input.portfolio.peakNavUsd, input.portfolio.navUsd),
      policy.hardDrawdownPercent
    );
    add(findings, "HARD_DRAWDOWN_STOP", hardLossReached || hardDrawdownReached, "hard live loss or drawdown threshold reached");
  } else {
    add(
      findings,
      "PRICE_IMPACT",
      exceeds(input.entryQuote.priceImpactPercent, policy.maximumPriceImpactPercent),
      `exit price impact exceeds ${policy.maximumPriceImpactPercent}%`
    );
  }

  const first = findings[0];
  const result: RiskDecision = {
    allowed: findings.length === 0,
    code: first?.code ?? "ALLOWED",
    reasons: findings.length === 0 ? ["all risk checks passed"] : findings.map((finding) => finding.message),
    decidedAt: now.toISOString(),
    positionSizeUsd
  };
  if (projectedRoundTripCostPercent !== undefined) {
    result.projectedRoundTripCostPercent = projectedRoundTripCostPercent;
  }
  if (followerPriceDivergencePercent !== undefined) {
    result.followerPriceDivergencePercent = followerPriceDivergencePercent;
  }
  return result;
}

export function estimateOneWayVariableCostPercent(quote: QuoteSnapshot): number {
  return quoteVariableCostPercent(quote);
}
