import type {
  LocalWalletIdentityScanInput,
  WalletIdentityCoordinatedBuyEvidence,
  WalletIdentitySwapEvidence,
  WalletIdentityTransactionEvidence
} from "../src/local-wallet-identity.js";

export const IDENTITY_SUBJECT = "11111111111111111111111111111111";
export const IDENTITY_PEER_A = "ComputeBudget111111111111111111111111111111";
export const IDENTITY_PEER_B = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const IDENTITY_OTHER_CREATOR = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const IDENTITY_TARGET_MINT = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
export const IDENTITY_WINDOW_START = "2026-01-01T00:00:00.000Z";
export const IDENTITY_WINDOW_END = "2026-04-01T00:00:00.000Z";
export const IDENTITY_POOL_AT = IDENTITY_WINDOW_START;
export const IDENTITY_NOW = new Date("2026-04-02T00:00:00.000Z");

export function identityTransaction(
  overrides: Partial<WalletIdentityTransactionEvidence> = {}
): WalletIdentityTransactionEvidence {
  return {
    signature: "sig-buy",
    slot: 100,
    blockTime: "2026-01-02T00:00:00.000Z",
    success: true,
    signers: [IDENTITY_SUBJECT],
    walletMentioned: true,
    instructionScanComplete: true,
    tokenBalanceScanComplete: true,
    swapScanComplete: true,
    mintCreations: [],
    ownerTokenDeltas: [{
      mint: IDENTITY_TARGET_MINT,
      owner: IDENTITY_SUBJECT,
      amountDeltaAtomic: "100"
    }],
    ...overrides
  };
}

export function identitySwap(
  overrides: Partial<WalletIdentitySwapEvidence> = {}
): WalletIdentitySwapEvidence {
  return {
    signature: "sig-buy",
    swapIndex: 0,
    wallet: IDENTITY_SUBJECT,
    slot: 100,
    blockTime: "2026-01-02T00:00:00.000Z",
    side: "BUY",
    targetMint: IDENTITY_TARGET_MINT,
    inputAmountAtomic: "1000000",
    outputAmountAtomic: "100",
    ...overrides
  };
}

export function coordinatedBuy(
  overrides: Partial<WalletIdentityCoordinatedBuyEvidence> = {}
): WalletIdentityCoordinatedBuyEvidence {
  return {
    signature: "sig-buy",
    wallet: IDENTITY_SUBJECT,
    slot: 100,
    blockTime: "2026-01-02T00:00:00.000Z",
    side: "BUY",
    targetMint: IDENTITY_TARGET_MINT,
    outputAmountAtomic: "100",
    ...overrides
  };
}

/** Complete, deliberately ordinary 90-day scan used as the clean control. */
export function cleanIdentityScan(): LocalWalletIdentityScanInput {
  const sell = identityTransaction({
    signature: "sig-sell",
    slot: 200,
    blockTime: "2026-03-15T00:00:00.000Z",
    ownerTokenDeltas: [{
      mint: IDENTITY_TARGET_MINT,
      owner: IDENTITY_SUBJECT,
      amountDeltaAtomic: "-100"
    }]
  });
  return {
    wallet: IDENTITY_SUBJECT,
    windowStart: IDENTITY_WINDOW_START,
    windowEnd: IDENTITY_WINDOW_END,
    coverage: {
      expectedSignatureCount: 2,
      hydratedSignatureCount: 2,
      reachedWindowStart: true,
      signatureHistoryComplete: true,
      transactionHydrationComplete: true,
      coordinatedBuyScanComplete: true
    },
    transactions: [identityTransaction(), sell],
    swaps: [
      identitySwap(),
      identitySwap({
        signature: "sig-sell",
        swapIndex: 0,
        slot: 200,
        blockTime: sell.blockTime,
        side: "SELL",
        inputAmountAtomic: "100",
        outputAmountAtomic: "1500000"
      })
    ],
    coordinatedBuys: [coordinatedBuy()],
    firstPools: [{
      mint: IDENTITY_TARGET_MINT,
      source: "JUPITER",
      firstPoolAt: IDENTITY_POOL_AT,
      checkedAt: IDENTITY_WINDOW_END
    }]
  };
}
