import { describe, expect, it, vi } from "vitest";
import type { StandardSolanaReadinessRpc } from "../src/standard-solana-readiness.js";
import { diagnoseStandardSolanaRpcReadiness } from "../src/standard-solana-readiness.js";

const NOW = new Date("2026-07-10T12:00:00.000Z");
const NOW_SECONDS = NOW.getTime() / 1_000;
const SIGNATURE = "5".repeat(88);

function healthyRpc(): StandardSolanaReadinessRpc {
  return {
    getHealth: async () => "ok",
    getSlot: async () => 1_000,
    getBlockTime: async (slot) => slot === 1_000 ? NOW_SECONDS - 5 : NOW_SECONDS - 100 * 86_400,
    getFirstAvailableBlock: async () => 10,
    getMinimumLedgerSlot: async () => 11,
    getSignaturesForAddress: async () => [{
      signature: SIGNATURE,
      slot: 900,
      blockTime: NOW_SECONDS - 60,
      confirmationStatus: "confirmed",
      failed: false
    }],
    getTransaction: async () => ({ slot: 900, transaction: {}, meta: {} }),
    getBlock: async (slot) => ({
      blockTime: slot < 900 ? NOW_SECONDS - 100 * 86_400 : NOW_SECONDS - 60,
      transactions: []
    }),
    getBalance: async () => 42,
    getTokenAccountsByOwner: async () => []
  };
}

describe("diagnoseStandardSolanaRpcReadiness", () => {
  it("passes only after every CopyLab standard-RPC capability is proven", async () => {
    const diagnostic = await diagnoseStandardSolanaRpcReadiness(healthyRpc(), {
      now: () => NOW,
      monotonicNow: () => 100
    });

    expect(diagnostic).toMatchObject({
      provider: "solana-rpc",
      ok: true,
      checkedAt: NOW.toISOString(),
      minimumArchiveDays: 90,
      maximumHeadAgeSeconds: 120
    });
    expect(diagnostic.capabilities.map(({ capability, status }) => ({ capability, status }))).toEqual([
      { capability: "GET_HEALTH", status: "PASS" },
      { capability: "CONFIRMED_HEAD", status: "PASS" },
      { capability: "ARCHIVE_HISTORY", status: "PASS" },
      { capability: "SIGNATURE_HISTORY", status: "PASS" },
      { capability: "FULL_TRANSACTION", status: "PASS" },
      { capability: "FULL_BLOCK", status: "PASS" },
      { capability: "BALANCE_READS", status: "PASS" }
    ]);
    expect(diagnostic.capabilities.find(({ capability }) => capability === "ARCHIVE_HISTORY"))
      .toMatchObject({ evidence: { archiveDepthDays: 99.99994212962963 } });
  });

  it("uses minimumLedgerSlot when getFirstAvailableBlock is unsupported", async () => {
    const rpc = healthyRpc();
    const minimumLedgerSlot = vi.fn(async () => 11);
    rpc.getFirstAvailableBlock = async () => { throw new Error("method unavailable"); };
    rpc.getMinimumLedgerSlot = minimumLedgerSlot;

    const diagnostic = await diagnoseStandardSolanaRpcReadiness(rpc, { now: () => NOW });

    expect(diagnostic.ok).toBe(true);
    expect(minimumLedgerSlot).toHaveBeenCalledOnce();
    expect(diagnostic.capabilities.find(({ capability }) => capability === "ARCHIVE_HISTORY"))
      .toMatchObject({
        status: "PASS",
        evidence: { archiveStartSource: "minimumLedgerSlot", archiveStartSlot: 11 }
      });
  });

  it("fails closed on insufficient history/full-data support and redacts provider errors", async () => {
    const secret = "private-query-secret";
    const rpc = healthyRpc();
    rpc.getBlock = async (slot) => ({
      blockTime: slot < 900 ? NOW_SECONDS - 30 * 86_400 : NOW_SECONDS - 60,
      transactions: []
    });
    rpc.getSignaturesForAddress = async () => [];
    rpc.getTokenAccountsByOwner = async () => {
      throw new Error(`https://rpc.example/?api-key=${secret}`);
    };

    const diagnostic = await diagnoseStandardSolanaRpcReadiness(rpc, { now: () => NOW });

    expect(diagnostic.ok).toBe(false);
    expect(diagnostic.capabilities.find(({ capability }) => capability === "ARCHIVE_HISTORY"))
      .toMatchObject({
        status: "FAIL",
        message: "Confirmed archive depth is below the required minimum",
        evidence: { archiveDepthDays: 29.99994212962963 }
      });
    expect(diagnostic.capabilities.find(({ capability }) => capability === "SIGNATURE_HISTORY"))
      .toMatchObject({ status: "FAIL" });
    expect(diagnostic.capabilities.find(({ capability }) => capability === "FULL_TRANSACTION"))
      .toMatchObject({ status: "BLOCKED" });
    expect(diagnostic.capabilities.find(({ capability }) => capability === "FULL_BLOCK"))
      .toMatchObject({ status: "BLOCKED" });
    expect(diagnostic.capabilities.find(({ capability }) => capability === "BALANCE_READS"))
      .toMatchObject({ status: "FAIL", message: "BALANCE_READS capability check failed" });
    expect(JSON.stringify(diagnostic)).not.toContain(secret);
  });

  it("rejects nodes that retain old block times but have pruned full archive blocks", async () => {
    const rpc = healthyRpc();
    rpc.getBlock = async (slot) => slot < 900
      ? null
      : { blockTime: NOW_SECONDS - 60, transactions: [] };

    const diagnostic = await diagnoseStandardSolanaRpcReadiness(rpc, {
      now: () => NOW,
      archiveBoundaryScanSlots: 3
    });

    expect(diagnostic.ok).toBe(false);
    expect(diagnostic.capabilities.find(({ capability }) => capability === "ARCHIVE_HISTORY"))
      .toMatchObject({
        status: "FAIL",
        message: "Full block data is unavailable at the archive boundary",
        evidence: { archiveStartSlot: 10, archiveBoundaryScanSlots: 3 }
      });
    expect(diagnostic.capabilities.find(({ capability }) => capability === "FULL_BLOCK"))
      .toMatchObject({ status: "PASS" });
  });

  it("scans forward within a strict bound when the ledger boundary is a skipped slot", async () => {
    const rpc = healthyRpc();
    const getBlock = vi.fn(async (slot: number) => slot === 10
      ? null
      : { blockTime: NOW_SECONDS - 100 * 86_400, transactions: [] });
    rpc.getBlock = getBlock;

    const diagnostic = await diagnoseStandardSolanaRpcReadiness(rpc, {
      now: () => NOW,
      archiveBoundaryScanSlots: 2
    });

    expect(diagnostic.ok).toBe(true);
    expect(getBlock.mock.calls.slice(0, 2)).toEqual([[10], [11]]);
    expect(diagnostic.capabilities.find(({ capability }) => capability === "ARCHIVE_HISTORY"))
      .toMatchObject({
        status: "PASS",
        evidence: { archiveStartSlot: 10, archiveBoundarySlot: 11 }
      });
  });

  it("bounds a dead endpoint to one health attempt and blocks dependent probes", async () => {
    const rpc = healthyRpc();
    const getSlot = vi.fn(async () => 1_000);
    rpc.getHealth = async () => { throw new Error("offline"); };
    rpc.getSlot = getSlot;

    const diagnostic = await diagnoseStandardSolanaRpcReadiness(rpc, { now: () => NOW });

    expect(diagnostic.ok).toBe(false);
    expect(diagnostic.capabilities[0]).toMatchObject({ capability: "GET_HEALTH", status: "FAIL" });
    expect(diagnostic.capabilities.slice(1).every(({ status }) => status === "BLOCKED")).toBe(true);
    expect(getSlot).not.toHaveBeenCalled();
  });
});
