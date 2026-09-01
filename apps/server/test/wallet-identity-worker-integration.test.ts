import { afterEach, describe, expect, it } from "vitest";
import { USDC_MINT, type TokenEligibility, type WalletIndexRecord } from "@copylab/shared";
import type { HeliusIndexRpc, HeliusSignatureInfo } from "@copylab/providers";
import { openDatabase, type CopyLabDatabase } from "../src/database.js";
import { Repository } from "../src/repository.js";
import { WalletIndexWorker } from "../src/wallet-index-worker.js";

const NOW = new Date("2026-07-10T12:00:00.000Z");
const DAY_MS = 86_400_000;
const WINDOW_START = new Date(NOW.getTime() - 90 * DAY_MS);
const PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const JUPITER_EVENT_AUTHORITY = "D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf";
const RAYDIUM_CPMM_PROGRAM = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C";
const USDC_ACCOUNT = "UsdcAccount1111111111111111111111111111111";
const TARGET_ACCOUNT = "TargetAccount11111111111111111111111111111";
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const WALLET = "Vote111111111111111111111111111111111111111";
const TARGET = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";

function base58Encode(bytes: readonly number[]): string {
  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);
  let encoded = "";
  while (value > 0n) {
    encoded = BASE58_ALPHABET[Number(value % 58n)] + encoded;
    value /= 58n;
  }
  let leadingZeroes = 0;
  while (bytes[leadingZeroes] === 0) leadingZeroes += 1;
  return `${"1".repeat(leadingZeroes)}${encoded}`;
}

function u16(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff];
}

function u32(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

function u64(value: bigint): number[] {
  return Array.from({ length: 8 }, (_unused, index) => Number((value >> BigInt(index * 8)) & 0xffn));
}

const JUPITER_ROUTE_DATA = base58Encode([
  229, 23, 203, 151, 122, 227, 173, 42,
  ...u32(1),
  7, 100, 0, 1,
  ...u64(5_000_000n),
  ...u64(2_500_000n),
  ...u16(50),
  0
]);
const RAYDIUM_SWAP_DATA = "E73fXHPWvSR8VCr6ujjfVSBYgv1v9V5Dy";

function jupiterRouteAccounts(): string[] {
  return [
    TOKEN_PROGRAM,
    WALLET,
    USDC_ACCOUNT,
    TARGET_ACCOUNT,
    TARGET_ACCOUNT,
    TARGET,
    PROGRAM,
    JUPITER_EVENT_AUTHORITY,
    PROGRAM
  ];
}

function record(): WalletIndexRecord {
  return {
    wallet: WALLET,
    firstSeenAt: WINDOW_START.toISOString(),
    lastSeenAt: NOW.toISOString(),
    historyDays: 90,
    transactionCount: 60,
    successfulTransactionCount: 59,
    spotSwapCount: 1,
    eligibleSpotSwapCount: 1,
    closedEligibleSwaps: 0,
    buyCount: 1,
    sellCount: 0,
    activeDays: 3,
    activeWeeks: 3,
    distinctMints: 1,
    medianHoldingMinutes: 0,
    preScreenEligible: true,
    preScreenReasons: [],
    updatedAt: NOW.toISOString()
  };
}

function rawTransaction(signature: string, slot: number, at: Date, failed: boolean): unknown {
  return {
    slot,
    blockTime: Math.floor(at.getTime() / 1_000),
    version: 0,
    transaction: {
      signatures: [signature],
      message: {
        accountKeys: [
          { pubkey: WALLET, signer: true, writable: true },
          { pubkey: USDC_ACCOUNT, signer: false, writable: true },
          { pubkey: TARGET_ACCOUNT, signer: false, writable: true }
        ],
        instructions: [{ programId: PROGRAM, accounts: jupiterRouteAccounts(), data: JUPITER_ROUTE_DATA }]
      }
    },
    meta: {
      err: failed ? { InstructionError: [0, "Custom"] } : null,
      fee: 5_000,
      preBalances: [1_000_000, 0],
      postBalances: [995_000, 0],
      preTokenBalances: [
        { accountIndex: 1, owner: WALLET, mint: USDC_MINT, uiTokenAmount: { amount: "10000000", decimals: 6 } },
        { accountIndex: 2, owner: WALLET, mint: TARGET, uiTokenAmount: { amount: "0", decimals: 6 } }
      ],
      postTokenBalances: failed ? [
        { accountIndex: 1, owner: WALLET, mint: USDC_MINT, uiTokenAmount: { amount: "10000000", decimals: 6 } },
        { accountIndex: 2, owner: WALLET, mint: TARGET, uiTokenAmount: { amount: "0", decimals: 6 } }
      ] : [
        { accountIndex: 1, owner: WALLET, mint: USDC_MINT, uiTokenAmount: { amount: "5000000", decimals: 6 } },
        { accountIndex: 2, owner: WALLET, mint: TARGET, uiTokenAmount: { amount: "2500000", decimals: 6 } }
      ],
      innerInstructions: [{
        index: 0,
        instructions: [{ programId: RAYDIUM_CPMM_PROGRAM, accounts: [], data: RAYDIUM_SWAP_DATA }]
      }],
      logMessages: [`Program ${PROGRAM} invoke [1]`]
    }
  };
}

function tokenEligibility(mint: string, now: Date): TokenEligibility {
  return {
    mint,
    checkedAt: now.toISOString(),
    eligible: true,
    reasons: [],
    verified: true,
    suspicious: false,
    mintAuthorityDisabled: true,
    freezeAuthorityDisabled: true,
    liquidityUsd: 10_000_000,
    volume24hUsd: 2_000_000,
    holderCount: 5_000,
    organicScore: 90,
    topHoldersPercent: 10,
    firstPoolAt: new Date(WINDOW_START.getTime() - DAY_MS).toISOString()
  };
}

describe("self-hosted wallet identity integration", () => {
  let db: CopyLabDatabase | undefined;
  afterEach(() => db?.close());

  it("hydrates successful and failed history signatures and persists fail-closed local identity", async () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const candidate = record();
    repository.upsertWalletIndexRecord(candidate);
    repository.saveWalletPreScreenSnapshot({
      wallet: WALLET,
      runId: "prescreen",
      calculatedAt: NOW.toISOString(),
      eligible: true,
      reasons: [],
      record: candidate
    });
    const successfulAt = new Date(NOW.getTime() - DAY_MS);
    const signatures: HeliusSignatureInfo[] = [
      { signature: "sig-success", slot: 100, blockTime: successfulAt.getTime() / 1_000, failed: false },
      { signature: "sig-failed", slot: 90, blockTime: WINDOW_START.getTime() / 1_000, failed: true }
    ];
    const hydrated: string[] = [];
    const rpc: HeliusIndexRpc = {
      getSignaturesForAddress: async (address) => address === WALLET ? signatures : [],
      getTransaction: async (signature) => {
        hydrated.push(signature);
        return signature === "sig-failed"
          ? rawTransaction(signature, 90, WINDOW_START, true)
          : rawTransaction(signature, 100, successfulAt, false);
      }
    };
    const worker = new WalletIndexWorker(repository, "", undefined, {
      rpc,
      programIds: new Set([PROGRAM]),
      targetWallets: 1,
      deepHistoryTargetLimit: 1,
      deepHistoryPageSize: 10,
      enforceManagedCreditBudget: false,
      identityEvidenceEnabled: true,
      identityFirstPoolResolver: async (mint, now) => tokenEligibility(mint, now),
      now: () => new Date(NOW)
    });

    expect(await worker.runOnce()).toBe(true); // page the frozen wallet window
    expect(repository.walletDeepHistoryQueueCoverage(WALLET)).toMatchObject({ total: 2, pending: 2 });
    expect(await worker.runOnce()).toBe(true); // hydrate both, including the failed signature
    expect(hydrated.sort()).toEqual(["sig-failed", "sig-success"]);
    expect(repository.walletIdentityEvidenceCoverage(WALLET)).toEqual({
      sourceSignatures: 2,
      processedSignatures: 2,
      evidenceSignatures: 2,
      missingEvidence: 0
    });
    expect(repository.listWalletIdentityTransactionEvidence(
      WALLET,
      WINDOW_START.toISOString(),
      NOW.toISOString()
    )).toEqual(expect.arrayContaining([
      expect.objectContaining({ signature: "sig-success", success: true }),
      expect.objectContaining({ signature: "sig-failed", success: false })
    ]));

    expect(await worker.runOnce()).toBe(true); // materialize + classify
    expect(repository.getWalletIndexRecord(WALLET)).toMatchObject({
      deepHistoryStatus: "COMPLETE",
      deepHistorySignatureCount: 2,
      deepHistoryHydratedCount: 2,
      walletIdentityStatus: "UNKNOWN",
      walletIdentitySource: "local_onchain_90d_v1",
      tags: []
    });
    expect(repository.listAudit(50)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        eventType: "local_wallet_identity_classified",
        severity: "warning",
        details: expect.objectContaining({
          reasons: expect.arrayContaining([expect.stringContaining("no committed continuous head range")])
        })
      })
    ]));

    repository.saveWalletIndexCheckpoint({
      pipeline: "helius-jupiter-program-head",
      partition: PROGRAM,
      completed: false,
      updatedAt: NOW.toISOString(),
      lastSignature: "program-head",
      slot: 110,
      metadata: { coverageStartSlot: 80, coverageEndSlot: 110 }
    });
    expect(await worker.runOnce()).toBe(false); // finish the index run first
    expect(await worker.runOnce()).toBe(true); // reclassify after exact head coverage becomes available
    expect(repository.getWalletIndexRecord(WALLET)).toMatchObject({
      walletIdentityStatus: "VERIFIED",
      walletIdentitySource: "local_onchain_90d_v1",
      tags: []
    });
  });
});
