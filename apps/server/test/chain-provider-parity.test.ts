import { describe, expect, it } from "vitest";
import type {
  LeaderSwap,
  ProviderHealth,
  Unsubscribe,
  WalletHistorySummary
} from "@copylab/shared";
import { SOL_MINT } from "@copylab/shared";
import {
  ShadowChainProvider,
  compareHistory,
  compareLeaderSwap
} from "../src/chain-provider-parity.js";
import type { ProviderParityObservation } from "../src/provider-parity.js";
import type { RuntimeChainProvider, RuntimeStreamStatus } from "../src/runtime-chain-provider.js";

const AT = "2026-07-10T12:00:00.000Z";

function swap(overrides: Partial<LeaderSwap> = {}): LeaderSwap {
  return {
    sourceSignature: "5".repeat(88),
    sourceWallet: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
    slot: 42,
    blockTime: AT,
    detectedAt: AT,
    side: "BUY",
    baseMint: SOL_MINT,
    targetMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    baseAmountAtomic: "100",
    targetAmountAtomic: "200",
    baseAmountUi: 1,
    targetAmountUi: 2,
    leaderPriceUsd: 100,
    recovered: false,
    ...overrides
  };
}

function history(overrides: Partial<WalletHistorySummary> = {}): WalletHistorySummary {
  return {
    wallet: swap().sourceWallet,
    historyDays: 90,
    closedEligibleSwaps: 50,
    activeWeeks: 4,
    medianHoldingMinutes: 20,
    topTokenProfitShare: 0.2,
    topThreeProfitShare: 0.5,
    tags: [],
    ...overrides
  };
}

class FakeChain implements RuntimeChainProvider {
  callback: ((value: LeaderSwap) => Promise<void>) | undefined;
  history = history();
  gaps: LeaderSwap[] = [];
  healthy = true;

  async checkHealth(): Promise<ProviderHealth> {
    return { provider: "helius", ok: this.healthy, checkedAt: AT, latencyMs: 1, message: this.healthy ? "ok" : "down" };
  }
  async summarizeHistory(): Promise<WalletHistorySummary> { return this.history; }
  async repairGap(): Promise<LeaderSwap[]> { return this.gaps; }
  async subscribe(_addresses: string[], callback: (value: LeaderSwap) => Promise<void>): Promise<Unsubscribe> {
    this.callback = callback;
    return () => { this.callback = undefined; };
  }
  getStreamStatus(): RuntimeStreamStatus { return { active: true, connected: true, ready: true }; }
  getStreamHealth(): ProviderHealth & RuntimeStreamStatus {
    return { ...this.getStreamStatus(), provider: "helius", ok: true, checkedAt: AT, message: "ok" };
  }
  async emit(value: LeaderSwap): Promise<void> { await this.callback?.(value); }
}

describe("shadow chain parity", () => {
  it("compares exact history and signal payloads", () => {
    expect(compareHistory(history(), history(), AT).status).toBe("MATCH");
    expect(compareHistory(history(), history({ activeWeeks: 3 }), AT).status).toBe("DIVERGENT");
    expect(compareLeaderSwap(swap(), swap(), "CHAIN_LIVE", AT).status).toBe("MATCH");
    expect(compareLeaderSwap(swap(), swap({ targetAmountAtomic: "201" }), "CHAIN_LIVE", AT).reasons)
      .toContain("target amount differs");
  });

  it("returns managed history and gap results while persisting shadow comparisons", async () => {
    const primary = new FakeChain();
    const shadow = new FakeChain();
    primary.gaps = [swap({ recovered: true })];
    shadow.gaps = [swap({ recovered: true })];
    const observations: ProviderParityObservation[] = [];
    const provider = new ShadowChainProvider(primary, shadow, {
      record: (observation) => { observations.push(observation); }
    });

    await expect(provider.summarizeHistory(swap().sourceWallet, 90)).resolves.toEqual(primary.history);
    await expect(provider.repairGap(swap().sourceWallet, AT)).resolves.toEqual(primary.gaps);
    expect(observations.map((entry) => entry.status)).toEqual(["MATCH", "MATCH"]);
  });

  it("never counts two unhealthy endpoints as matching readiness evidence", async () => {
    const primary = new FakeChain();
    const shadow = new FakeChain();
    primary.healthy = false;
    shadow.healthy = false;
    const observations: ProviderParityObservation[] = [];
    const provider = new ShadowChainProvider(primary, shadow, {
      record: (observation) => { observations.push(observation); }
    });

    await expect(provider.checkHealth()).resolves.toMatchObject({ ok: false });
    expect(observations).toEqual([
      expect.objectContaining({
        capability: "CHAIN_HEALTH",
        status: "DIVERGENT",
        reasons: ["managed chain is unhealthy", "self-hosted chain is unhealthy"]
      })
    ]);
  });

  it("forwards managed live signals once and correlates the self-hosted stream", async () => {
    const primary = new FakeChain();
    const shadow = new FakeChain();
    const observations: ProviderParityObservation[] = [];
    const forwarded: LeaderSwap[] = [];
    const provider = new ShadowChainProvider(primary, shadow, {
      record: (observation) => { observations.push(observation); }
    }, { matchTimeoutMs: 100 });
    const unsubscribe = await provider.subscribe([swap().sourceWallet], async (value) => { forwarded.push(value); });

    await primary.emit(swap());
    await shadow.emit(swap());
    expect(forwarded).toHaveLength(1);
    expect(observations.map((entry) => entry.status)).toEqual(["PENDING", "MATCH"]);
    await unsubscribe();
  });

  it("records a durable divergence when the self-hosted stream misses a managed signal", async () => {
    const primary = new FakeChain();
    const shadow = new FakeChain();
    const observations: ProviderParityObservation[] = [];
    const provider = new ShadowChainProvider(primary, shadow, {
      record: (observation) => { observations.push(observation); }
    }, { matchTimeoutMs: 5 });
    const unsubscribe = await provider.subscribe([swap().sourceWallet], async () => undefined);
    await primary.emit(swap());
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(observations.map((entry) => entry.status)).toEqual(["PENDING", "DIVERGENT"]);
    await unsubscribe();
  });
});
