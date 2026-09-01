import { describe, expect, it } from "vitest";
import { TOKEN_PROGRAM_ID } from "@copylab/shared";
import { normalizeWalletIdentityTransactionEvidence } from "../src/wallet-identity-evidence.js";
import {
  IDENTITY_OTHER_CREATOR,
  IDENTITY_SUBJECT,
  IDENTITY_TARGET_MINT
} from "./local-wallet-identity.fixtures.js";

function tokenBalance(accountIndex: number, owner: string, amount: string) {
  return {
    accountIndex,
    mint: IDENTITY_TARGET_MINT,
    owner,
    uiTokenAmount: { amount, decimals: 0, uiAmount: Number(amount), uiAmountString: amount }
  };
}

function transaction(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    slot: 123,
    blockTime: 1_767_312_000,
    version: 0,
    transaction: {
      signatures: ["sig-identity"],
      message: {
        accountKeys: [
          { pubkey: IDENTITY_SUBJECT, signer: true, writable: true },
          { pubkey: TOKEN_PROGRAM_ID, signer: false, writable: false }
        ],
        instructions: [{
          program: "spl-token",
          programId: TOKEN_PROGRAM_ID,
          parsed: {
            type: "initializeMint2",
            info: {
              mint: IDENTITY_TARGET_MINT,
              mintAuthority: IDENTITY_SUBJECT,
              decimals: 6
            }
          }
        }]
      }
    },
    meta: {
      err: null,
      loadedAddresses: { writable: [], readonly: [] },
      innerInstructions: [],
      preTokenBalances: [
        tokenBalance(2, IDENTITY_SUBJECT, "10"),
        tokenBalance(3, IDENTITY_SUBJECT, "0"),
        tokenBalance(4, IDENTITY_OTHER_CREATOR, "5")
      ],
      postTokenBalances: [
        tokenBalance(2, IDENTITY_SUBJECT, "5"),
        tokenBalance(3, IDENTITY_SUBJECT, "15"),
        tokenBalance(4, IDENTITY_OTHER_CREATOR, "100")
      ]
    },
    ...overrides
  };
}

describe("wallet identity transaction evidence normalization", () => {
  it("persists exact owner-level atomic deltas and signer-created mint evidence", () => {
    const result = normalizeWalletIdentityTransactionEvidence(transaction(), {
      signature: "sig-identity",
      wallets: [IDENTITY_SUBJECT],
      swapScanComplete: true
    });

    expect(result).toEqual([expect.objectContaining({
      signature: "sig-identity",
      success: true,
      walletMentioned: true,
      instructionScanComplete: true,
      tokenBalanceScanComplete: true,
      swapScanComplete: true,
      ownerTokenDeltas: [{
        owner: IDENTITY_SUBJECT,
        mint: IDENTITY_TARGET_MINT,
        amountDeltaAtomic: "10"
      }],
      mintCreations: [{
        mint: IDENTITY_TARGET_MINT,
        creatorWallet: IDENTITY_SUBJECT,
        mintAuthority: IDENTITY_SUBJECT
      }]
    })]);
  });

  it("emits one bounded evidence row per requested participating wallet", () => {
    const raw = transaction();
    const message = (raw.transaction as any).message;
    message.accountKeys.push({ pubkey: IDENTITY_OTHER_CREATOR, signer: false, writable: false });
    const result = normalizeWalletIdentityTransactionEvidence(raw, {
      signature: "sig-identity",
      wallets: [IDENTITY_SUBJECT, IDENTITY_OTHER_CREATOR, IDENTITY_SUBJECT],
      swapScanComplete: true
    });

    expect(result).toHaveLength(2);
    expect(result.map((entry) => entry.ownerTokenDeltas)).toEqual([
      [{ owner: IDENTITY_SUBJECT, mint: IDENTITY_TARGET_MINT, amountDeltaAtomic: "10" }],
      [{ owner: IDENTITY_OTHER_CREATOR, mint: IDENTITY_TARGET_MINT, amountDeltaAtomic: "95" }]
    ]);
  });

  it("marks token evidence incomplete on malformed atomic balances", () => {
    const raw = transaction();
    (raw.meta as any).postTokenBalances[0].uiTokenAmount.amount = "1e3";
    const [result] = normalizeWalletIdentityTransactionEvidence(raw, {
      signature: "sig-identity",
      wallets: [IDENTITY_SUBJECT],
      swapScanComplete: true
    });

    expect(result).toMatchObject({ tokenBalanceScanComplete: false });
  });

  it("marks instruction evidence incomplete when an SPL Token instruction is compiled", () => {
    const raw = transaction();
    (raw.transaction as any).message.instructions = [{
      programId: TOKEN_PROGRAM_ID,
      accounts: [0],
      data: "opaque"
    }];
    const [result] = normalizeWalletIdentityTransactionEvidence(raw, {
      signature: "sig-identity",
      wallets: [IDENTITY_SUBJECT],
      swapScanComplete: true
    });

    expect(result).toMatchObject({ instructionScanComplete: false, mintCreations: [] });
  });

  it("resolves compiled programIdIndex and fails closed on an unresolved index", () => {
    const raw = transaction();
    (raw.transaction as any).message.instructions = [{ programIdIndex: 999, accounts: [], data: "opaque" }];
    const [result] = normalizeWalletIdentityTransactionEvidence(raw, {
      signature: "sig-identity",
      wallets: [IDENTITY_SUBJECT],
      swapScanComplete: true
    });
    expect(result).toMatchObject({ instructionScanComplete: false });
  });

  it("accepts innerInstructions=null only when complete logs prove there was no CPI", () => {
    const raw = transaction();
    (raw.meta as any).innerInstructions = null;
    (raw.meta as any).logMessages = [
      `Program ${TOKEN_PROGRAM_ID} invoke [1]`,
      `Program ${TOKEN_PROGRAM_ID} success`
    ];
    const [noCpi] = normalizeWalletIdentityTransactionEvidence(raw, {
      signature: "sig-identity",
      wallets: [IDENTITY_SUBJECT],
      swapScanComplete: true
    });
    expect(noCpi).toMatchObject({ instructionScanComplete: true });

    (raw.meta as any).logMessages = [
      `Program ${TOKEN_PROGRAM_ID} invoke [1]`,
      `Program ${TOKEN_PROGRAM_ID} invoke [2]`
    ];
    const [unknownCpi] = normalizeWalletIdentityTransactionEvidence(raw, {
      signature: "sig-identity",
      wallets: [IDENTITY_SUBJECT],
      swapScanComplete: true
    });
    expect(unknownCpi).toMatchObject({ instructionScanComplete: false });
  });

  it("retains a failed signature as complete non-mutating evidence", () => {
    const raw = transaction();
    (raw.meta as any).err = { InstructionError: [0, "Custom"] };
    delete (raw.meta as any).preTokenBalances;
    delete (raw.meta as any).postTokenBalances;
    delete (raw.meta as any).innerInstructions;
    const [result] = normalizeWalletIdentityTransactionEvidence(raw, {
      signature: "sig-failed",
      wallets: [IDENTITY_SUBJECT],
      swapScanComplete: false
    });

    expect(result).toMatchObject({
      signature: "sig-failed",
      success: false,
      instructionScanComplete: true,
      tokenBalanceScanComplete: true,
      swapScanComplete: true,
      mintCreations: [],
      ownerTokenDeltas: []
    });
  });

  it("does not claim wallet participation without an account key or owner delta", () => {
    const [result] = normalizeWalletIdentityTransactionEvidence(transaction(), {
      signature: "sig-identity",
      wallets: [IDENTITY_OTHER_CREATOR],
      swapScanComplete: true
    });
    // This fixture does contain an OTHER_CREATOR token balance, so remove it
    // and verify the exact participation rule in a second normalization.
    expect(result?.walletMentioned).toBe(true);
    const raw = transaction();
    (raw.meta as any).preTokenBalances = (raw.meta as any).preTokenBalances.slice(0, 2);
    (raw.meta as any).postTokenBalances = (raw.meta as any).postTokenBalances.slice(0, 2);
    const [unmentioned] = normalizeWalletIdentityTransactionEvidence(raw, {
      signature: "sig-identity",
      wallets: [IDENTITY_OTHER_CREATOR],
      swapScanComplete: true
    });
    expect(unmentioned?.walletMentioned).toBe(false);
  });
});
