import {
  SOL_MINT,
  TOKEN_PROGRAM_ID,
  USDC_MINT,
  type CopyIntent,
  type LeaderSwap,
  type PortfolioSnapshot,
  type ProviderHealth,
  type QuoteSnapshot,
  type RiskDecision,
  type TokenEligibility,
  type WalletCandidate,
  type WalletHistorySummary
} from "@copylab/shared";

export const NOW = new Date("2026-02-15T12:00:00.000Z");
export const WALLET = "7YLeaderWallet111111111111111111111111111111";
export const TARGET_MINT = "TargetMint111111111111111111111111111111111";

export function walletCandidate(overrides: Partial<WalletCandidate> = {}): WalletCandidate {
  return {
    address: WALLET,
    cohortId: "cohort-1",
    firstSeenAt: "2025-01-01T00:00:00.000Z",
    lastSeenAt: NOW.toISOString(),
    control: false,
    tags: [],
    pnl30d: {
      duration: "30d",
      realizedProfitUsd: 100,
      realizedProfitPercent: 10,
      unrealizedProfitUsd: 0,
      totalTrades: 60,
      wins: 40,
      losses: 20
    },
    pnl90d: {
      duration: "90d",
      realizedProfitUsd: 200,
      realizedProfitPercent: 20,
      unrealizedProfitUsd: 0,
      totalTrades: 100,
      wins: 65,
      losses: 35
    },
    ...overrides
  };
}

export function walletHistory(overrides: Partial<WalletHistorySummary> = {}): WalletHistorySummary {
  return {
    wallet: WALLET,
    historyDays: 90,
    closedEligibleSwaps: 50,
    activeWeeks: 3,
    medianHoldingMinutes: 15,
    topTokenProfitShare: 0.35,
    topThreeProfitShare: 0.6,
    tags: [],
    ...overrides
  };
}

export function token(overrides: Partial<TokenEligibility> = {}): TokenEligibility {
  return {
    mint: TARGET_MINT,
    checkedAt: NOW.toISOString(),
    eligible: true,
    reasons: [],
    tokenProgram: TOKEN_PROGRAM_ID,
    verified: true,
    suspicious: false,
    mintAuthorityDisabled: true,
    freezeAuthorityDisabled: true,
    firstPoolAt: "2025-12-01T12:00:00.000Z",
    liquidityUsd: 5_000_000,
    volume24hUsd: 1_000_000,
    holderCount: 1_000,
    organicScore: 70,
    topHoldersPercent: 30,
    ...overrides
  };
}

export function leaderSwap(overrides: Partial<LeaderSwap> = {}): LeaderSwap {
  return {
    sourceSignature: "source-signature-1",
    sourceWallet: WALLET,
    slot: 123,
    blockTime: "2026-02-15T11:59:55.000Z",
    detectedAt: "2026-02-15T11:59:56.000Z",
    side: "BUY",
    baseMint: USDC_MINT,
    targetMint: TARGET_MINT,
    baseAmountAtomic: "100000000",
    targetAmountAtomic: "100000000",
    baseAmountUi: 100,
    targetAmountUi: 100,
    leaderPriceUsd: 1,
    recovered: false,
    ...overrides
  };
}

export function intent(overrides: Partial<CopyIntent> = {}): CopyIntent {
  const sourceSwap = overrides.sourceSwap ?? leaderSwap();
  return {
    id: "intent-1",
    idempotencyKey: "key-1",
    createdAt: "2026-02-15T11:59:56.000Z",
    sourceSwap,
    side: sourceSwap.side,
    inputMint: USDC_MINT,
    outputMint: TARGET_MINT,
    inputAmountAtomic: "5000000",
    inputAmountUsd: 5,
    ...overrides
  };
}

export function quote(overrides: Partial<QuoteSnapshot> = {}): QuoteSnapshot {
  return {
    requestId: "quote-1",
    quotedAt: "2026-02-15T11:59:58.000Z",
    inputMint: USDC_MINT,
    outputMint: TARGET_MINT,
    inputAmountAtomic: "5000000",
    outputAmountAtomic: "5000000",
    inputUsd: 5,
    outputUsd: 4.99,
    priceImpactPercent: 0.1,
    slippageBps: 10,
    feeBps: 0,
    signatureFeeLamports: 5_000,
    prioritizationFeeLamports: 0,
    rentFeeLamports: 0,
    minimumOutputAtomic: "4900000",
    router: "jupiter",
    expiresAt: "2026-02-15T12:00:03.000Z",
    ...overrides
  };
}

export function exitQuote(overrides: Partial<QuoteSnapshot> = {}): QuoteSnapshot {
  return quote({
    requestId: "quote-exit-1",
    inputMint: TARGET_MINT,
    outputMint: USDC_MINT,
    inputAmountAtomic: "5000000",
    outputAmountAtomic: "4950000",
    inputUsd: 4.99,
    outputUsd: 4.95,
    minimumOutputAtomic: "4900000",
    ...overrides
  });
}

export function portfolio(overrides: Partial<PortfolioSnapshot> = {}): PortfolioSnapshot {
  return {
    mode: "PAPER",
    capturedAt: NOW.toISOString(),
    navUsd: 50,
    peakNavUsd: 50,
    dayStartNavUsd: 50,
    deployedUsd: 0,
    solReserveUsd: 5,
    liquidReserveUsd: 50,
    realizedPnlUsd: 0,
    unrealizedPnlUsd: 0,
    openPositions: 0,
    balanceMismatchPercent: 0,
    ...overrides
  };
}

export function providerHealth(overrides: Partial<ProviderHealth> = {}): ProviderHealth {
  return {
    provider: "helius",
    ok: true,
    checkedAt: NOW.toISOString(),
    latencyMs: 20,
    message: "ok",
    ...overrides
  };
}

export function allowedDecision(overrides: Partial<RiskDecision> = {}): RiskDecision {
  return {
    allowed: true,
    code: "ALLOWED",
    reasons: ["all risk checks passed"],
    decidedAt: NOW.toISOString(),
    positionSizeUsd: 5,
    ...overrides
  };
}

export { SOL_MINT, TOKEN_PROGRAM_ID, USDC_MINT };
