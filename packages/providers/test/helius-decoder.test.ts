import { describe, expect, expectTypeOf, it } from "vitest";
import type { LeaderSwap } from "@copylab/shared";
import {
  decodeSpotSwapTransaction,
  decodeSpotSwapTransactionResult,
  decodeWalletTokenDecreases,
  decodeWalletHistorySwap,
  SpotSwapTransactionMalformedError,
  type RejectedSwapResearchAction,
  type WalletTokenDecreaseObservation
} from "../src/helius-decoder.js";
import {
  OTHER_MINT,
  SOL_MINT,
  TARGET_MINT,
  PUBLIC_SWAP_SIGNATURE,
  PUBLIC_SWAP_TARGET,
  PUBLIC_SWAP_WALLET,
  TEST_SIGNATURE,
  TEST_WALLET,
  USDC_MINT,
  capturedArbitraryJupiterInstruction,
  capturedFailedSwap,
  capturedJupiterLogSpoof,
  capturedJupiterV4SpotSwap,
  capturedJupiterV6RouteV2SpotSwap,
  capturedJupiterWithUnknownProgram,
  capturedMeteoraDlmmLiquidityChange,
  capturedMeteoraDlmmSwap,
  capturedMeteoraDlmmSwapExactOut,
  capturedMeteoraDlmmSwapWithPriceImpact,
  capturedOrcaWhirlpoolLiquidityChange,
  capturedOrcaWhirlpoolSwap,
  capturedOrcaWhirlpoolSwapV2,
  capturedRaydiumAmmV4BaseInputSwap,
  capturedRaydiumAmmV4BaseInputV2Swap,
  capturedRaydiumAmmV4BaseOutputSwap,
  capturedRaydiumAmmV4BaseOutputV2Swap,
  capturedRaydiumAmmV4Deposit,
  capturedRaydiumClmmLiquidityChange,
  capturedRaydiumClmmRouterSwap,
  capturedRaydiumClmmSwap,
  capturedRaydiumClmmSwapV2,
  capturedRaydiumCpmmBaseInputSwap,
  capturedRaydiumCpmmBaseOutputSwap,
  capturedRaydiumCpmmDeposit,
  capturedSolSpotSwap,
  capturedSolSellWithAccountClosure,
  capturedSolSpotSwapWithAtaRent,
  capturedSolSwapWithBundledTransfer,
  capturedTokenToTokenRotation,
  capturedTransfer,
  capturedUsdcSpotSwap,
  recordedWalletHistorySolBuy,
  recordedWalletHistorySolSell,
  recordedWalletHistoryUsdcBuy,
  recordedWalletHistoryUsdcSell,
  recordedPublicSolSell,
  walletHistoryUsdcBuy
} from "./fixtures/helius-transactions.js";

const context = {
  signature: TEST_SIGNATURE,
  wallet: TEST_WALLET,
  detectedAt: new Date("2024-07-03T09:46:41Z"),
  recovered: false,
  solPriceUsd: 200
};

describe("Helius spot-swap decoder", () => {
  it("decodes a successful USDC-legged Jupiter spot buy", () => {
    expect(decodeSpotSwapTransaction(capturedUsdcSpotSwap, context)).toMatchObject({
      sourceSignature: TEST_SIGNATURE,
      sourceWallet: TEST_WALLET,
      side: "BUY",
      baseMint: USDC_MINT,
      targetMint: TARGET_MINT,
      baseAmountAtomic: "4000000",
      targetAmountAtomic: "2000000",
      baseAmountUi: 4,
      targetAmountUi: 2,
      leaderPriceUsd: 2,
      recovered: false
    });
  });

  it("decodes native SOL after removing the fee from the wallet delta", () => {
    expect(decodeSpotSwapTransaction(capturedSolSpotSwap, context)).toMatchObject({
      side: "BUY",
      baseAmountAtomic: "1000000000",
      baseAmountUi: 1,
      targetAmountUi: 100,
      leaderPriceUsd: 2
    });
  });

  it("fails closed on a finalized public Jupiter RouteV2 that uses unsupported PumpSwap", () => {
    const publicContext = {
      signature: PUBLIC_SWAP_SIGNATURE,
      wallet: PUBLIC_SWAP_WALLET,
      detectedAt: new Date("2026-07-09T22:20:00Z"),
      recovered: false,
      solPriceUsd: 150
    };

    expect(decodeSpotSwapTransaction(recordedPublicSolSell, publicContext)).toBeNull();
    expectTypeOf<RejectedSwapResearchAction>().not.toMatchTypeOf<LeaderSwap>();
    expect(decodeSpotSwapTransactionResult(recordedPublicSolSell, publicContext)).toMatchObject({
      status: "REJECTED",
      action: {
        sourceSignature: PUBLIC_SWAP_SIGNATURE,
        sourceWallet: PUBLIC_SWAP_WALLET,
        side: "SELL",
        baseMint: SOL_MINT,
        targetMint: PUBLIC_SWAP_TARGET,
        recovered: false
      },
      researchAction: {
        kind: "UNSUPPORTED_ROUTE_RESEARCH_ONLY",
        source: {
          sourceSignature: PUBLIC_SWAP_SIGNATURE,
          sourceWallet: PUBLIC_SWAP_WALLET,
          side: "SELL",
          baseMint: SOL_MINT,
          targetMint: PUBLIC_SWAP_TARGET,
          recovered: false
        },
        baseAmountAtomic: "138253008",
        targetAmountAtomic: "181449172110",
        baseAmountUi: 0.138253008,
        targetAmountUi: 181449.17211
      },
      reason: expect.stringContaining("strict decoder allowlist")
    });
  });

  it.each([
    ["plain transfer", capturedTransfer],
    ["token-to-token rotation", capturedTokenToTokenRotation],
    ["arbitrary Jupiter instruction", capturedArbitraryJupiterInstruction],
    ["ambiguous Jupiter log spoof", capturedJupiterLogSpoof]
  ])("keeps non-swap or ambiguous %s activity ignored", (_label, fixture) => {
    expect(decodeSpotSwapTransactionResult(fixture, context)).toEqual({ status: "IGNORED" });
    expect(decodeSpotSwapTransaction(fixture, context)).toBeNull();
  });

  it("extracts research-only inventory loss from an ignored token-to-token rotation", () => {
    expectTypeOf<WalletTokenDecreaseObservation>().not.toMatchTypeOf<LeaderSwap>();
    expect(decodeSpotSwapTransactionResult(capturedTokenToTokenRotation, context)).toEqual({
      status: "IGNORED"
    });
    expect(decodeWalletTokenDecreases(capturedTokenToTokenRotation, context)).toEqual([{
      kind: "WALLET_TOKEN_DECREASE_RESEARCH_ONLY",
      signature: TEST_SIGNATURE,
      wallet: TEST_WALLET,
      slot: capturedTokenToTokenRotation.slot,
      blockTime: new Date(capturedTokenToTokenRotation.blockTime * 1_000).toISOString(),
      detectedAt: context.detectedAt.toISOString(),
      recovered: false,
      mint: OTHER_MINT,
      amountAtomic: "4000000",
      amountUi: 4
    }]);
  });

  it("does not extract inventory evidence from a failed transaction", () => {
    expect(decodeWalletTokenDecreases(capturedFailedSwap, context)).toEqual([]);
  });

  it("surfaces an unknown auxiliary program as audit-only while the strict wrapper stays closed", () => {
    expect(decodeSpotSwapTransaction(capturedJupiterWithUnknownProgram, context)).toBeNull();
    expect(decodeSpotSwapTransactionResult(capturedJupiterWithUnknownProgram, context)).toMatchObject({
      status: "REJECTED",
      action: {
        sourceSignature: TEST_SIGNATURE,
        sourceWallet: TEST_WALLET,
        side: "BUY",
        baseMint: USDC_MINT,
        targetMint: TARGET_MINT,
        recovered: false
      },
      researchAction: {
        kind: "UNSUPPORTED_ROUTE_RESEARCH_ONLY",
        baseAmountAtomic: "4000000",
        targetAmountAtomic: "2000000",
        baseAmountUi: 4,
        targetAmountUi: 2
      },
      reason: expect.stringContaining("strict decoder allowlist")
    });
  });

  it.each([
    ["Jupiter v4 route", capturedJupiterV4SpotSwap],
    ["Jupiter v6 RouteV2", capturedJupiterV6RouteV2SpotSwap]
  ])("decodes an exact supported %s instruction shape", (_label, fixture) => {
    expect(decodeSpotSwapTransaction(fixture, context)).toMatchObject({
      side: "BUY",
      baseMint: USDC_MINT,
      targetMint: TARGET_MINT,
      baseAmountUi: 4,
      targetAmountUi: 2
    });
  });

  it.each([
    ["failed transaction", capturedFailedSwap],
    ["plain transfer or unknown program", capturedTransfer],
    ["token-to-token rotation", capturedTokenToTokenRotation]
  ])("rejects %s", (_label, fixture) => {
    expect(decodeSpotSwapTransaction(fixture, context)).toBeNull();
  });

  it("rejects a Jupiter route whose fixed authority or token-program account is altered", () => {
    const instruction = capturedJupiterV6RouteV2SpotSwap.transaction.message.instructions[0]!;
    const wrongAuthority = [...instruction.accounts];
    wrongAuthority[0] = OTHER_MINT;
    const wrongTokenProgram = [...instruction.accounts];
    wrongTokenProgram[5] = OTHER_MINT;
    const withAccounts = (accounts: string[]) => ({
      ...capturedJupiterV6RouteV2SpotSwap,
      transaction: {
        ...capturedJupiterV6RouteV2SpotSwap.transaction,
        message: {
          ...capturedJupiterV6RouteV2SpotSwap.transaction.message,
          instructions: [{ ...instruction, accounts }]
        }
      }
    });

    expect(decodeSpotSwapTransaction(withAccounts(wrongAuthority), context)).toBeNull();
    expect(decodeSpotSwapTransaction(withAccounts(wrongTokenProgram), context)).toBeNull();
  });

  it.each([
    ["Orca Whirlpool swap", capturedOrcaWhirlpoolSwap],
    ["Orca Whirlpool swap_v2", capturedOrcaWhirlpoolSwapV2],
    ["Raydium CPMM swap_base_input", capturedRaydiumCpmmBaseInputSwap],
    ["Raydium CPMM swap_base_output", capturedRaydiumCpmmBaseOutputSwap],
    ["Raydium CLMM swap", capturedRaydiumClmmSwap],
    ["Raydium CLMM swap_v2", capturedRaydiumClmmSwapV2],
    ["Raydium CLMM swap_router_base_in", capturedRaydiumClmmRouterSwap],
    ["Raydium AMM v4 SwapBaseIn", capturedRaydiumAmmV4BaseInputSwap],
    ["Raydium AMM v4 SwapBaseOut", capturedRaydiumAmmV4BaseOutputSwap],
    ["Raydium AMM v4 SwapBaseInV2", capturedRaydiumAmmV4BaseInputV2Swap],
    ["Raydium AMM v4 SwapBaseOutV2", capturedRaydiumAmmV4BaseOutputV2Swap],
    ["Meteora DLMM swap", capturedMeteoraDlmmSwap],
    ["Meteora DLMM swap_exact_out", capturedMeteoraDlmmSwapExactOut],
    ["Meteora DLMM swap_with_price_impact", capturedMeteoraDlmmSwapWithPriceImpact]
  ])("decodes a direct %s only from its exact swap instruction", (_label, fixture) => {
    expect(decodeSpotSwapTransaction(fixture, context)).toMatchObject({
      side: "BUY",
      baseMint: USDC_MINT,
      targetMint: TARGET_MINT,
      baseAmountUi: 4,
      targetAmountUi: 2
    });
  });

  it.each([
    ["Orca Whirlpool increase_liquidity", capturedOrcaWhirlpoolLiquidityChange],
    ["Raydium CPMM deposit", capturedRaydiumCpmmDeposit],
    ["Raydium CLMM increase_liquidity_v2", capturedRaydiumClmmLiquidityChange],
    ["Raydium AMM v4 deposit", capturedRaydiumAmmV4Deposit],
    ["Meteora DLMM liquidity instruction", capturedMeteoraDlmmLiquidityChange]
  ])("rejects a direct %s lookalike with identical two-token deltas", (_label, fixture) => {
    expect(decodeSpotSwapTransaction(fixture, context)).toBeNull();
  });

  it("rejects direct-program logs and mixed swap/LP bundles without exact unambiguous intent", () => {
    const logOnly = {
      ...capturedOrcaWhirlpoolSwap,
      transaction: {
        ...capturedOrcaWhirlpoolSwap.transaction,
        message: { ...capturedOrcaWhirlpoolSwap.transaction.message, instructions: [] }
      }
    };
    const mixed = {
      ...capturedOrcaWhirlpoolSwap,
      transaction: {
        ...capturedOrcaWhirlpoolSwap.transaction,
        message: {
          ...capturedOrcaWhirlpoolSwap.transaction.message,
          instructions: [
            ...capturedOrcaWhirlpoolSwap.transaction.message.instructions,
            ...capturedOrcaWhirlpoolLiquidityChange.transaction.message.instructions
          ]
        }
      }
    };
    const crossProgramMixed = {
      ...capturedOrcaWhirlpoolSwap,
      transaction: {
        ...capturedOrcaWhirlpoolSwap.transaction,
        message: {
          ...capturedOrcaWhirlpoolSwap.transaction.message,
          instructions: [
            ...capturedOrcaWhirlpoolSwap.transaction.message.instructions,
            ...capturedRaydiumCpmmDeposit.transaction.message.instructions
          ]
        }
      }
    };
    const orcaProgram = capturedOrcaWhirlpoolSwap.transaction.message.instructions[0]!.programId;
    expect(decodeSpotSwapTransaction(logOnly, context)).toBeNull();
    expect(decodeSpotSwapTransaction(mixed, context)).toBeNull();
    expect(decodeSpotSwapTransaction(crossProgramMixed, {
      ...context,
      allowedSpotProgramIds: new Set([orcaProgram])
    })).toBeNull();
  });

  it("throws a typed fail-closed error when an allowed-program response omits required balances", () => {
    const malformed = {
      ...capturedUsdcSpotSwap,
      meta: {
        ...capturedUsdcSpotSwap.meta,
        preTokenBalances: undefined
      }
    };

    expect(() => decodeSpotSwapTransaction(malformed, context))
      .toThrow(SpotSwapTransactionMalformedError);
  });

  it.each([
    ["arbitrary Jupiter instruction", capturedArbitraryJupiterInstruction],
    ["Jupiter plus unknown program", capturedJupiterWithUnknownProgram],
    ["Jupiter log spoof", capturedJupiterLogSpoof],
    ["bundled system transfer", capturedSolSwapWithBundledTransfer]
  ])("rejects adversarial %s evidence", (_label, fixture) => {
    expect(decodeSpotSwapTransaction(fixture, context)).toBeNull();
  });

  it("rejects a valid Jupiter route bundled beside a top-level direct swap", () => {
    const fixture = {
      ...capturedUsdcSpotSwap,
      transaction: {
        ...capturedUsdcSpotSwap.transaction,
        message: {
          ...capturedUsdcSpotSwap.transaction.message,
          instructions: [
            ...capturedUsdcSpotSwap.transaction.message.instructions,
            ...capturedRaydiumCpmmBaseInputSwap.transaction.message.instructions
          ]
        }
      }
    };

    expect(decodeSpotSwapTransaction(fixture, context)).toBeNull();
  });

  it("removes ATA creation rent from a native-SOL fill", () => {
    expect(decodeSpotSwapTransaction(capturedSolSpotSwapWithAtaRent, context)).toMatchObject({
      side: "BUY",
      baseMint: SOL_MINT,
      baseAmountAtomic: "1000000000",
      targetAmountAtomic: "100000000"
    });
  });

  it("removes a closed token account rent refund from a native-SOL fill", () => {
    expect(decodeSpotSwapTransaction(capturedSolSellWithAccountClosure, context)).toMatchObject({
      side: "SELL",
      baseMint: SOL_MINT,
      baseAmountAtomic: "500000000",
      targetAmountAtomic: "100000000"
    });
  });

  it("decodes legacy Wallet History amounts only when they contain one allowed base leg", () => {
    expect(decodeWalletHistorySwap(walletHistoryUsdcBuy, { ...context, recovered: true }))
      .toMatchObject({
        side: "BUY",
        baseAmountUi: 4,
        targetAmountUi: 2,
        recovered: true
      });
    expect(decodeWalletHistorySwap({
      ...walletHistoryUsdcBuy,
      type: "TRANSFER"
    }, context)).toBeNull();
  });

  it("fails closed instead of throwing on malformed numeric history data", () => {
    expect(() => decodeWalletHistorySwap({
      ...walletHistoryUsdcBuy,
      timestamp: 1e20,
      balanceChanges: [
        { mint: USDC_MINT, amount: -1e21, decimals: 6 },
        { mint: TARGET_MINT, amount: 1, decimals: 1.5 }
      ]
    }, context)).not.toThrow();
    expect(decodeWalletHistorySwap({
      ...walletHistoryUsdcBuy,
      timestamp: 1e20,
      balanceChanges: [
        { mint: USDC_MINT, amount: -1e21, decimals: 6 },
        { mint: TARGET_MINT, amount: 1, decimals: 1.5 }
      ]
    }, context)).toBeNull();
  });

  it.each([
    ["USDC buy", recordedWalletHistoryUsdcBuy, "BUY", USDC_MINT, 4.25, 2.5, 1.7],
    ["USDC sell", recordedWalletHistoryUsdcSell, "SELL", USDC_MINT, 5, 2.5, 2],
    ["SOL buy", recordedWalletHistorySolBuy, "BUY", SOL_MINT, 0.5, 100, 1],
    ["SOL sell", recordedWalletHistorySolSell, "SELL", SOL_MINT, 0.55, 100, 1.1]
  ] as const)(
    "decodes live %s history using human-readable amounts despite zero decimals",
    (_label, fixture, side, baseMint, baseAmountUi, targetAmountUi, leaderPriceUsd) => {
      expect(decodeWalletHistorySwap(fixture, context)).toMatchObject({
        side,
        baseMint,
        targetMint: TARGET_MINT,
        baseAmountUi,
        targetAmountUi,
        leaderPriceUsd
      });
    }
  );

  it("removes a near-zero intermediary net after aggregating all history changes", () => {
    const decoded = decodeWalletHistorySwap(recordedWalletHistoryUsdcBuy, context);
    expect(decoded).toMatchObject({ targetMint: TARGET_MINT, targetAmountUi: 2.5 });
    expect(decoded?.targetMint).not.toBe(OTHER_MINT);
  });

  it("rejects malformed and ambiguous history instead of discarding inconvenient legs", () => {
    const malformed = {
      ...recordedWalletHistoryUsdcBuy,
      balanceChanges: [
        ...recordedWalletHistoryUsdcBuy.balanceChanges,
        { mint: OTHER_MINT, amount: "not-a-number", decimals: 0 }
      ]
    };
    const twoCanonicalBases = {
      ...recordedWalletHistoryUsdcBuy,
      balanceChanges: [
        { mint: USDC_MINT, amount: -4, decimals: 0 },
        { mint: SOL_MINT, amount: -0.02, decimals: 0 },
        { mint: TARGET_MINT, amount: 2, decimals: 0 }
      ]
    };
    const multipleTargets = {
      ...recordedWalletHistoryUsdcBuy,
      balanceChanges: [
        { mint: USDC_MINT, amount: -4, decimals: 0 },
        { mint: TARGET_MINT, amount: 1, decimals: 0 },
        { mint: OTHER_MINT, amount: 1, decimals: 0 }
      ]
    };

    expect(decodeWalletHistorySwap(malformed, context)).toBeNull();
    expect(decodeWalletHistorySwap(twoCanonicalBases, context)).toBeNull();
    expect(decodeWalletHistorySwap(multipleTargets, context)).toBeNull();
  });
});
