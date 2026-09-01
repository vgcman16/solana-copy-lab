import { afterEach, describe, expect, it } from "vitest";
import type { WalletIndexRecord } from "@copylab/shared";
import { openDatabase, type CopyLabDatabase } from "../src/database.js";
import { Repository } from "../src/repository.js";
import {
  persistLocalWalletIdentity,
  persistManagedWalletIdentity,
  verifiedLocalWalletTags
} from "../src/wallet-identity.js";
import type { LocalWalletIdentityResult } from "../src/local-wallet-identity.js";

const AT = "2026-07-10T12:00:00.000Z";

function record(wallet = "wallet"): WalletIndexRecord {
  return {
    wallet,
    firstSeenAt: AT,
    lastSeenAt: AT,
    historyDays: 90,
    transactionCount: 50,
    successfulTransactionCount: 50,
    spotSwapCount: 50,
    eligibleSpotSwapCount: 50,
    closedEligibleSwaps: 50,
    buyCount: 25,
    sellCount: 25,
    activeDays: 10,
    activeWeeks: 4,
    distinctMints: 5,
    medianHoldingMinutes: 20,
    preScreenEligible: true,
    preScreenReasons: [],
    updatedAt: AT
  };
}

describe("wallet identity evidence", () => {
  let db: CopyLabDatabase | undefined;
  afterEach(() => db?.close());

  it("does not treat a missing tag record as a verified empty result", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    repository.upsertWalletIndexRecord(record());
    expect(() => verifiedLocalWalletTags(repository, "wallet")).toThrow("unknown");
  });

  it("keeps managed provenance separate from the local resolver and persists local decisions", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    repository.upsertWalletIndexRecord(record("clean"));
    repository.upsertWalletIndexRecord(record("bad"));

    expect(persistManagedWalletIdentity(repository, "clean", { tags: [] }, AT)).toBe(true);
    expect(() => verifiedLocalWalletTags(repository, "clean")).toThrow("unknown");
    expect(repository.getWalletIndexRecord("clean")).toMatchObject({
      walletIdentityStatus: "VERIFIED",
      walletIdentitySource: "helius_wallet_identity",
      walletIdentityCheckedAt: AT,
      tags: []
    });

    const localResult = (wallet: string, status: "VERIFIED" | "REJECTED", tags: Array<"sniper">): LocalWalletIdentityResult => ({
      wallet,
      status,
      tags,
      source: "local_onchain_90d_v1",
      checkedAt: AT,
      windowStart: "2026-04-11T12:00:00.000Z",
      windowEnd: AT,
      reasons: ["test evidence"],
      findings: [],
      metrics: {
        expectedSignatures: 50,
        hydratedSignatures: 50,
        inspectedTransactions: 50,
        successfulTransactions: 50,
        inspectedSwaps: 50,
        inspectedMints: 5,
        coordinatedBuyRows: 25
      }
    });
    expect(persistLocalWalletIdentity(repository, localResult("clean", "VERIFIED", []))).toBe(true);
    expect(verifiedLocalWalletTags(repository, "clean")).toEqual([]);
    expect(persistManagedWalletIdentity(repository, "clean", { tags: ["sniper"] }, AT)).toBe(true);
    expect(repository.getWalletIndexRecord("clean")).toMatchObject({
      walletIdentityStatus: "VERIFIED",
      walletIdentitySource: "local_onchain_90d_v1",
      tags: []
    });

    persistLocalWalletIdentity(repository, localResult("bad", "REJECTED", ["sniper"]));
    expect(repository.getWalletIndexRecord("bad")).toMatchObject({
      walletIdentityStatus: "REJECTED",
      tags: ["sniper"]
    });
    expect(verifiedLocalWalletTags(repository, "bad")).toEqual(["sniper"]);
  });
});
