import { describe, expect, it } from "vitest";
import {
  JUPITER_V6_PROGRAM_ID,
  classifyCoarseJupiterWalletCandidate,
  decodeSpotSwapTransaction
} from "../src/index.js";

const WALLET = "Vote111111111111111111111111111111111111111";
const OTHER_SIGNER = "Stake11111111111111111111111111111111111111";
const SIGNATURE = "5".repeat(88);
const NOW = new Date("2027-01-15T00:00:00Z");

function transaction(options: {
  direct?: boolean;
  signers?: string[];
  failed?: boolean;
} = {}): unknown {
  const signers = options.signers ?? [WALLET];
  const direct = options.direct ?? true;
  return {
    slot: 42,
    blockTime: NOW.getTime() / 1_000,
    transaction: {
      message: {
        accountKeys: [
          ...signers.map((pubkey) => ({ pubkey, signer: true, writable: true })),
          { pubkey: JUPITER_V6_PROGRAM_ID, signer: false, writable: false }
        ],
        instructions: direct
          ? [{ programId: JUPITER_V6_PROGRAM_ID, accounts: [], data: "1" }]
          : [{ programId: "11111111111111111111111111111111", accounts: [], data: "1" }]
      }
    },
    meta: {
      err: options.failed ? { InstructionError: [0, "Custom"] } : null,
      fee: 5_000,
      preBalances: [],
      postBalances: [],
      preTokenBalances: [],
      postTokenBalances: [],
      innerInstructions: direct ? [] : [{
        index: 0,
        instructions: [{ programId: JUPITER_V6_PROGRAM_ID, accounts: [], data: "1" }]
      }],
      logMessages: [`Program ${JUPITER_V6_PROGRAM_ID} invoke [${direct ? 1 : 2}]`]
    }
  };
}

describe("coarse Jupiter wallet candidate classification", () => {
  it("accepts only the sole fee-paying signer of a successful direct Jupiter invocation", () => {
    expect(classifyCoarseJupiterWalletCandidate(
      JUPITER_V6_PROGRAM_ID,
      SIGNATURE,
      transaction(),
      NOW
    )).toMatchObject({
      accepted: true,
      tier: "COARSE_SIGNER",
      wallet: WALLET,
      directInvocation: true,
      signerCount: 1,
      transactionSuccess: true
    });
  });

  it("rejects CPI-only Jupiter attribution", () => {
    expect(classifyCoarseJupiterWalletCandidate(
      JUPITER_V6_PROGRAM_ID,
      SIGNATURE,
      transaction({ direct: false }),
      NOW
    )).toMatchObject({ accepted: false, reasonCode: "JUPITER_CPI_ONLY" });
  });

  it("rejects multi-signer and failed transactions", () => {
    expect(classifyCoarseJupiterWalletCandidate(
      JUPITER_V6_PROGRAM_ID,
      SIGNATURE,
      transaction({ signers: [WALLET, OTHER_SIGNER] }),
      NOW
    )).toMatchObject({ accepted: false, reasonCode: "SIGNER_COUNT_NOT_ONE" });
    expect(classifyCoarseJupiterWalletCandidate(
      JUPITER_V6_PROGRAM_ID,
      SIGNATURE,
      transaction({ failed: true }),
      NOW
    )).toMatchObject({ accepted: false, reasonCode: "FAILED_TRANSACTION" });
  });

  it("does not turn coarse signer evidence into a strict swap", () => {
    expect(decodeSpotSwapTransaction(transaction(), {
      signature: SIGNATURE,
      wallet: WALLET,
      detectedAt: NOW,
      recovered: true,
      solPriceUsd: 1,
      allowedSpotProgramIds: new Set([JUPITER_V6_PROGRAM_ID])
    })).toBeNull();
  });
});
