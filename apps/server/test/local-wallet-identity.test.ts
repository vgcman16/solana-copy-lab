import { describe, expect, it } from "vitest";
import { classifyLocalWalletIdentity } from "../src/local-wallet-identity.js";
import {
  IDENTITY_NOW,
  IDENTITY_OTHER_CREATOR,
  IDENTITY_PEER_A,
  IDENTITY_PEER_B,
  IDENTITY_POOL_AT,
  IDENTITY_SUBJECT,
  IDENTITY_TARGET_MINT,
  cleanIdentityScan,
  coordinatedBuy,
  identityTransaction
} from "./local-wallet-identity.fixtures.js";

function classify(input = cleanIdentityScan()) {
  return classifyLocalWalletIdentity(input, { now: IDENTITY_NOW });
}

describe("local on-chain wallet identity classifier", () => {
  it("verifies clean identity only after a complete 90-day scan", () => {
    const result = classify();

    expect(result).toMatchObject({
      wallet: IDENTITY_SUBJECT,
      status: "VERIFIED",
      tags: [],
      source: "local_onchain_90d_v1",
      metrics: {
        expectedSignatures: 2,
        hydratedSignatures: 2,
        inspectedTransactions: 2,
        inspectedSwaps: 2,
        inspectedMints: 1
      }
    });
    expect(result.findings).toEqual([]);
  });

  it.each([
    ["signature pagination", (scan: ReturnType<typeof cleanIdentityScan>) => {
      scan.coverage.signatureHistoryComplete = false;
    }],
    ["window cutoff", (scan: ReturnType<typeof cleanIdentityScan>) => {
      scan.coverage.reachedWindowStart = false;
    }],
    ["hydration count", (scan: ReturnType<typeof cleanIdentityScan>) => {
      scan.coverage.hydratedSignatureCount = 1;
    }],
    ["transaction evidence", (scan: ReturnType<typeof cleanIdentityScan>) => {
      scan.transactions[0]!.tokenBalanceScanComplete = false;
    }],
    ["coordinated-buy coverage", (scan: ReturnType<typeof cleanIdentityScan>) => {
      scan.coverage.coordinatedBuyScanComplete = false;
    }]
  ])("returns UNKNOWN when %s is incomplete", (_label, mutate) => {
    const scan = cleanIdentityScan();
    mutate(scan);

    expect(classify(scan)).toMatchObject({ status: "UNKNOWN", tags: [] });
  });

  it("returns UNKNOWN when Jupiter firstPoolAt evidence is absent or conflicting", () => {
    const missing = cleanIdentityScan();
    missing.firstPools = [];
    expect(classify(missing)).toMatchObject({
      status: "UNKNOWN",
      reasons: expect.arrayContaining([expect.stringContaining("firstPoolAt is unavailable")])
    });

    const conflicting = cleanIdentityScan();
    conflicting.firstPools.push({
      ...conflicting.firstPools[0]!,
      firstPoolAt: "2026-01-01T01:00:00.000Z"
    });
    expect(classify(conflicting)).toMatchObject({
      status: "UNKNOWN",
      reasons: expect.arrayContaining([expect.stringContaining("evidence conflicts")])
    });
  });

  it("tags a signer-created traded mint as dev", () => {
    const scan = cleanIdentityScan();
    scan.transactions[0]!.mintCreations = [{
      mint: IDENTITY_TARGET_MINT,
      creatorWallet: IDENTITY_SUBJECT,
      mintAuthority: IDENTITY_SUBJECT
    }];

    const result = classify(scan);
    expect(result).toMatchObject({ status: "REJECTED", tags: ["dev"] });
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ heuristic: "SIGNER_CREATED_TRADED_MINT" })
    ]));
  });

  it("does not call the subject a dev when another signer created the mint", () => {
    const scan = cleanIdentityScan();
    scan.transactions[0]!.signers.push(IDENTITY_OTHER_CREATOR);
    scan.transactions[0]!.mintCreations = [{
      mint: IDENTITY_TARGET_MINT,
      creatorWallet: IDENTITY_OTHER_CREATOR,
      mintAuthority: IDENTITY_OTHER_CREATOR
    }];

    expect(classify(scan)).toMatchObject({ status: "VERIFIED", tags: [] });
  });

  it("tags a pre-pool receipt followed by a sale as insider even when a buy explains the receipt", () => {
    const scan = cleanIdentityScan();
    const receiptAt = "2026-01-01T12:00:00.000Z";
    scan.firstPools[0]!.firstPoolAt = "2026-01-02T00:00:00.000Z";
    scan.transactions[0]!.blockTime = receiptAt;
    scan.swaps[0]!.blockTime = receiptAt;
    scan.coordinatedBuys[0]!.blockTime = receiptAt;

    const result = classify(scan);
    expect(result).toMatchObject({ status: "REJECTED", tags: ["insider"] });
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ heuristic: "PRE_POOL_RECEIPT_THEN_SALE" })
    ]));
  });

  it("tags target inventory received without a decoded buy and later sold as insider", () => {
    const scan = cleanIdentityScan();
    scan.swaps = scan.swaps.filter((swap) => swap.side === "SELL");
    scan.coordinatedBuys = [];

    const result = classify(scan);
    expect(result).toMatchObject({ status: "REJECTED", tags: ["insider"] });
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ heuristic: "NON_SWAP_RECEIPT_THEN_SALE" })
    ]));
  });

  it("does not infer insider status from an unexplained receipt without a later decoded sale", () => {
    const scan = cleanIdentityScan();
    scan.transactions[0]!.ownerTokenDeltas[0]!.amountDeltaAtomic = "150";
    scan.swaps = scan.swaps.filter((swap) => swap.side === "BUY");
    scan.transactions[1]!.ownerTokenDeltas = [];

    expect(classify(scan)).toMatchObject({ status: "VERIFIED", tags: [] });
  });

  it("tags a buy inside the strict first-pool window as sniper", () => {
    const scan = cleanIdentityScan();
    const buyAt = "2026-01-01T00:00:30.000Z";
    scan.transactions[0]!.blockTime = buyAt;
    scan.swaps[0]!.blockTime = buyAt;
    scan.coordinatedBuys[0]!.blockTime = buyAt;

    const result = classify(scan);
    expect(result).toMatchObject({ status: "REJECTED", tags: ["sniper"] });
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ heuristic: "FIRST_POOL_BUY" })
    ]));
  });

  it("does not tag a buy just outside the strict first-pool window", () => {
    const scan = cleanIdentityScan();
    const buyAt = "2026-01-01T00:01:01.000Z";
    scan.transactions[0]!.blockTime = buyAt;
    scan.swaps[0]!.blockTime = buyAt;
    scan.coordinatedBuys[0]!.blockTime = buyAt;

    expect(classify(scan)).toMatchObject({ status: "VERIFIED", tags: [] });
  });

  it("tags three distinct wallets buying the exact same amount and mint in one slot as bundler", () => {
    const scan = cleanIdentityScan();
    scan.coordinatedBuys.push(
      coordinatedBuy({ signature: "sig-peer-a", wallet: IDENTITY_PEER_A }),
      coordinatedBuy({ signature: "sig-peer-b", wallet: IDENTITY_PEER_B })
    );

    const result = classify(scan);
    expect(result).toMatchObject({ status: "REJECTED", tags: ["bundler"] });
    expect(result.findings[0]).toMatchObject({
      heuristic: "COORDINATED_SAME_SLOT_BUY",
      relatedWallets: [IDENTITY_SUBJECT, IDENTITY_PEER_A, IDENTITY_PEER_B].sort()
    });
  });

  it.each([
    ["different amount", coordinatedBuy({
      signature: "sig-peer-b",
      wallet: IDENTITY_PEER_B,
      outputAmountAtomic: "101"
    })],
    ["different slot", coordinatedBuy({
      signature: "sig-peer-b",
      wallet: IDENTITY_PEER_B,
      slot: 101
    })],
    ["sell", coordinatedBuy({
      signature: "sig-peer-b",
      wallet: IDENTITY_PEER_B,
      side: "SELL"
    })],
    ["duplicate wallet", coordinatedBuy({
      signature: "sig-peer-b",
      wallet: IDENTITY_PEER_A
    })]
  ])("resists a false bundler match from a %s row", (_label, adversarialRow) => {
    const scan = cleanIdentityScan();
    scan.coordinatedBuys.push(
      coordinatedBuy({ signature: "sig-peer-a", wallet: IDENTITY_PEER_A }),
      adversarialRow
    );

    expect(classify(scan)).toMatchObject({ status: "VERIFIED", tags: [] });
  });

  it("fails closed on malformed atomic amounts instead of comparing UI floats", () => {
    const scan = cleanIdentityScan();
    scan.swaps[0]!.outputAmountAtomic = "1e2";

    const result = classify(scan);
    expect(result).toMatchObject({ status: "UNKNOWN", tags: [] });
    expect(result.reasons).toEqual(expect.arrayContaining([expect.stringContaining("swap") ]));
  });

  it("ignores mint creation evidence from a failed transaction", () => {
    const scan = cleanIdentityScan();
    scan.transactions.push(identityTransaction({
      signature: "sig-failed-mint",
      slot: 150,
      blockTime: "2026-02-01T00:00:00.000Z",
      success: false,
      mintCreations: [{
        mint: IDENTITY_TARGET_MINT,
        creatorWallet: IDENTITY_SUBJECT,
        mintAuthority: IDENTITY_SUBJECT
      }],
      ownerTokenDeltas: []
    }));
    scan.coverage.expectedSignatureCount = 3;
    scan.coverage.hydratedSignatureCount = 3;

    expect(classify(scan)).toMatchObject({ status: "VERIFIED", tags: [] });
  });

  it("keeps REJECTED precedence when a positive tag is found in otherwise incomplete evidence", () => {
    const scan = cleanIdentityScan();
    const buyAt = "2026-01-01T00:00:30.000Z";
    scan.transactions[0]!.blockTime = buyAt;
    scan.swaps[0]!.blockTime = buyAt;
    scan.coordinatedBuys[0]!.blockTime = buyAt;
    scan.coverage.signatureHistoryComplete = false;

    const result = classify(scan);
    expect(result).toMatchObject({ status: "REJECTED", tags: ["sniper"] });
    expect(result.reasons).toEqual(expect.arrayContaining([
      expect.stringContaining("signature pagination is incomplete")
    ]));
  });

  it("returns UNKNOWN when a materially pre-pool swap has no later sale finding", () => {
    const scan = cleanIdentityScan();
    scan.swaps = scan.swaps.filter((swap) => swap.side === "BUY");
    scan.transactions[1]!.ownerTokenDeltas = [];
    scan.firstPools[0]!.firstPoolAt = "2026-01-03T00:00:00.000Z";

    const result = classify(scan);
    expect(result).toMatchObject({ status: "UNKNOWN", tags: [] });
    expect(result.reasons).toEqual(expect.arrayContaining([
      expect.stringContaining("materially predates Jupiter firstPoolAt")
    ]));
  });

  it("uses the documented Jupiter first-pool timestamp fixture", () => {
    const scan = cleanIdentityScan();
    expect(scan.firstPools[0]).toMatchObject({ firstPoolAt: IDENTITY_POOL_AT, source: "JUPITER" });
  });
});
