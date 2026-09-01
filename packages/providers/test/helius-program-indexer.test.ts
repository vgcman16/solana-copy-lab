import { describe, expect, it } from "vitest";
import { SOL_MINT, USDC_MINT } from "@copylab/shared";
import {
  HeliusProgramIndexer,
  confirmedTransactionMetadata,
  confirmedTransactionSigners,
  type HeliusIndexRpc
} from "../src/helius-program-indexer.js";
import {
  METEORA_DLMM_PROGRAM_ID,
  ORCA_WHIRLPOOL_PROGRAM_ID,
  RAYDIUM_AMM_V4_PROGRAM_ID,
  RAYDIUM_CLMM_PROGRAM_ID,
  RAYDIUM_CPMM_PROGRAM_ID
} from "../src/helius-decoder.js";
import type { HeliusSignatureInfo, HeliusSignaturePageRequest } from "../src/helius-rpc-client.js";
import {
  capturedRaydiumCpmmBaseInputSwap,
  capturedUsdcSpotSwap
} from "./fixtures/helius-transactions.js";

const PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const RELAYER = "11111111111111111111111111111111";
const TRADER = "Vote111111111111111111111111111111111111111";
const TARGET = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6zSsrPeAC8B1pPB";

function swapTransaction(
  options: { failed?: boolean; includeProgram?: boolean; relayer?: boolean } = {}
): unknown {
  const accountKeys = options.relayer
    ? [
        { pubkey: RELAYER, signer: true, writable: true },
        { pubkey: TRADER, signer: true, writable: true },
        { pubkey: "UsdcAccount1111111111111111111111111111111", signer: false, writable: true },
        { pubkey: "TargetAccount11111111111111111111111111111", signer: false, writable: true }
      ]
    : [
        { pubkey: TRADER, signer: true, writable: true },
        { pubkey: "UnusedAccount11111111111111111111111111111", signer: false, writable: false },
        { pubkey: "UsdcAccount1111111111111111111111111111111", signer: false, writable: true },
        { pubkey: "TargetAccount11111111111111111111111111111", signer: false, writable: true }
      ];
  const template = capturedUsdcSpotSwap.transaction.message.instructions[0]!;
  const routeAccounts = [...template.accounts];
  routeAccounts[1] = TRADER;
  return {
    slot: 42,
    blockTime: 1_800_000_000,
    transaction: {
      message: {
        accountKeys,
        instructions: options.includeProgram === false ? [] : [{
          programId: PROGRAM,
          accounts: routeAccounts,
          data: template.data
        }]
      }
    },
    meta: {
      err: options.failed ? { InstructionError: [0, "Custom"] } : null,
      fee: 5_000,
      preBalances: accountKeys.map(() => 1_000_000),
      postBalances: accountKeys.map((_key, index) => index === 0 ? 995_000 : 1_000_000),
      preTokenBalances: [
        { accountIndex: 2, owner: TRADER, mint: USDC_MINT, uiTokenAmount: { amount: "10000000", decimals: 6 } },
        { accountIndex: 3, owner: TRADER, mint: TARGET, uiTokenAmount: { amount: "0", decimals: 6 } }
      ],
      postTokenBalances: [
        { accountIndex: 2, owner: TRADER, mint: USDC_MINT, uiTokenAmount: { amount: "5000000", decimals: 6 } },
        { accountIndex: 3, owner: TRADER, mint: TARGET, uiTokenAmount: { amount: "2500000", decimals: 6 } }
      ],
      innerInstructions: capturedUsdcSpotSwap.meta.innerInstructions,
      logMessages: []
    }
  };
}

describe("HeliusProgramIndexer", () => {
  it("discovers every direct program supported by the strict instruction decoder", () => {
    const rpc: HeliusIndexRpc = {
      getSignaturesForAddress: async () => [],
      getTransaction: async () => null
    };
    expect(new HeliusProgramIndexer(rpc).listPrograms()).toEqual(expect.arrayContaining([
      ORCA_WHIRLPOOL_PROGRAM_ID,
      RAYDIUM_CPMM_PROGRAM_ID,
      RAYDIUM_CLMM_PROGRAM_ID,
      RAYDIUM_AMM_V4_PROGRAM_ID,
      METEORA_DLMM_PROGRAM_ID
    ]));
  });

  it("hydrates a direct-program signature only after the strict decoder proves swap intent", async () => {
    const rpc: HeliusIndexRpc = {
      getSignaturesForAddress: async () => [],
      getTransaction: async () => capturedRaydiumCpmmBaseInputSwap
    };
    const indexer = new HeliusProgramIndexer(rpc, {
      now: () => new Date("2027-01-15T08:00:00Z")
    });
    await expect(indexer.hydrateProgramSignature(
      RAYDIUM_CPMM_PROGRAM_ID,
      "direct-cpmm-signature"
    )).resolves.toEqual([
      expect.objectContaining({
        sourceProgram: RAYDIUM_CPMM_PROGRAM_ID,
        side: "BUY",
        baseMint: USDC_MINT,
        baseValueUsd: 4
      })
    ]);
  });

  it("attributes single-signer swaps and rejects ambiguous multi-signer bundles", async () => {
    const rpc: HeliusIndexRpc = {
      getSignaturesForAddress: async () => [],
      getTransaction: async () => swapTransaction()
    };
    const indexer = new HeliusProgramIndexer(rpc, {
      programIds: new Set([PROGRAM]),
      now: () => new Date("2027-01-15T08:00:00Z")
    });

    expect(confirmedTransactionSigners(swapTransaction({ relayer: true }))).toEqual([RELAYER, TRADER]);
    expect(confirmedTransactionMetadata(swapTransaction())).toMatchObject({
      slot: 42,
      success: true,
      feePayer: TRADER,
      signers: [TRADER],
      programIds: expect.arrayContaining([PROGRAM, RAYDIUM_CPMM_PROGRAM_ID])
    });
    await expect(indexer.hydrateProgramSignature(PROGRAM, "signature")).resolves.toEqual([
      expect.objectContaining({
        wallet: TRADER,
        sourceProgram: PROGRAM,
        side: "BUY",
        baseMint: USDC_MINT,
        targetMint: TARGET,
        baseValueUsd: 5
      })
    ]);
    expect(indexer.decodeProgramTransaction(
      PROGRAM,
      "ambiguous",
      swapTransaction({ relayer: true })
    )).toEqual([]);
  });

  it("rejects failed transactions and transactions that do not invoke the source program", async () => {
    let transaction: unknown = swapTransaction({ failed: true });
    const rpc: HeliusIndexRpc = {
      getSignaturesForAddress: async () => [],
      getTransaction: async () => transaction
    };
    const indexer = new HeliusProgramIndexer(rpc, { programIds: new Set([PROGRAM]) });
    await expect(indexer.hydrateProgramSignature(PROGRAM, "failed")).resolves.toEqual([]);
    transaction = swapTransaction({ includeProgram: false });
    await expect(indexer.hydrateProgramSignature(PROGRAM, "transfer")).resolves.toEqual([]);
  });

  it("returns resumable program pages", async () => {
    const requests: HeliusSignaturePageRequest[] = [];
    const rpc: HeliusIndexRpc = {
      getSignaturesForAddress: async (_address, request = {}) => {
        requests.push(request);
        return [{ signature: "tail", slot: 1, failed: false }];
      },
      getTransaction: async () => null
    };
    const indexer = new HeliusProgramIndexer(rpc, {
      programIds: new Set([PROGRAM]),
      signaturePageSize: 2
    });
    await expect(indexer.fetchProgramSignatures(PROGRAM, "before", "until")).resolves.toEqual({
      programId: PROGRAM,
      signatures: [{ signature: "tail", slot: 1, failed: false }],
      nextBefore: "tail",
      exhausted: true
    });
    expect(requests).toEqual([{ limit: 2, before: "before", until: "until" }]);
  });

  it("rejects non-advancing program and wallet pagination cursors", async () => {
    const recent = Date.parse("2027-01-14T00:00:00Z") / 1_000;
    const repeated = [
      { signature: "first", slot: 1, blockTime: recent, failed: false },
      { signature: "tail", slot: 2, blockTime: recent + 1, failed: false }
    ];
    const rpc: HeliusIndexRpc = {
      getSignaturesForAddress: async () => repeated,
      getTransaction: async () => null
    };
    const indexer = new HeliusProgramIndexer(rpc, {
      programIds: new Set([PROGRAM]),
      signaturePageSize: 2,
      activityPageSize: 2,
      maximumActivityPages: 2,
      now: () => new Date("2027-01-15T00:00:00Z")
    });
    await expect(indexer.fetchProgramSignatures(PROGRAM, "tail")).rejects.toThrow("cursor did not advance");
    await expect(indexer.preScreenWalletActivity(TRADER, {
      minimumSuccessfulTransactions: 1,
      minimumActiveWeeks: 1
    })).rejects.toThrow("cursor did not advance");
  });

  it("pre-screens age, transaction volume, and three-of-four-week activity with cursor pagination", async () => {
    const nowSeconds = Date.parse("2027-01-15T00:00:00Z") / 1_000;
    const requests: HeliusSignaturePageRequest[] = [];
    const pages: HeliusSignatureInfo[][] = [
      [0, 8, 15].flatMap((days, group) => Array.from({ length: 20 }, (_, index) => ({
        signature: `p1-${group}-${index}`,
        slot: index,
        blockTime: nowSeconds - days * 86_400,
        failed: false
      }))),
      [{ signature: "old", slot: 100, blockTime: nowSeconds - 91 * 86_400, failed: false }]
    ];
    const rpc: HeliusIndexRpc = {
      getSignaturesForAddress: async (_address, request = {}) => {
        requests.push(request);
        return pages.shift() ?? [];
      },
      getTransaction: async () => null
    };
    const indexer = new HeliusProgramIndexer(rpc, {
      activityPageSize: 60,
      maximumActivityPages: 3,
      now: () => new Date(nowSeconds * 1_000)
    });

    await expect(indexer.preScreenWalletActivity(TRADER)).resolves.toMatchObject({
      successfulTransactions: 61,
      historyDays: 90,
      activeWeeks: 3,
      reachedHistoryCutoff: true,
      truncated: false,
      passed: true,
      reasons: []
    });
    expect(requests).toHaveLength(2);
    expect(requests[1]?.before).toBe("p1-2-19");
  });

  it("fails closed when age remains unproven at the pagination cap and validates thresholds", async () => {
    const nowSeconds = Date.parse("2027-01-15T00:00:00Z") / 1_000;
    let call = 0;
    const rpc: HeliusIndexRpc = {
      getSignaturesForAddress: async () => {
        call += 1;
        return Array.from({ length: 2 }, (_, index) => ({
          signature: `${call}-${index}`,
          slot: call * 10 + index,
          blockTime: nowSeconds - (call + index) * 86_400,
          failed: false
        }));
      },
      getTransaction: async () => null
    };
    const indexer = new HeliusProgramIndexer(rpc, {
      activityPageSize: 2,
      maximumActivityPages: 2,
      now: () => new Date(nowSeconds * 1_000)
    });
    await expect(indexer.preScreenWalletActivity(TRADER, {
      minimumSuccessfulTransactions: 1,
      minimumActiveWeeks: 1
    })).resolves.toMatchObject({
      reachedHistoryCutoff: false,
      truncated: true,
      passed: false,
      reasons: ["wallet age was not proven before the pagination cap"]
    });
    await expect(indexer.preScreenWalletActivity(TRADER, {
      minimumSuccessfulTransactions: 0
    })).rejects.toThrow("minimumSuccessfulTransactions");
    await expect(indexer.preScreenWalletActivity(TRADER, {
      minimumActiveWeeks: 5
    })).rejects.toThrow("minimumActiveWeeks");
  });
});
