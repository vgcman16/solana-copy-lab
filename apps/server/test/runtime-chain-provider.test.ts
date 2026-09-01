import { describe, expect, it } from "vitest";
import type { StandardSolanaObserver } from "@copylab/providers";
import { StandardSolanaRuntimeChainProvider } from "../src/runtime-chain-provider.js";

const AT = "2026-07-10T12:00:00.000Z";

describe("StandardSolanaRuntimeChainProvider", () => {
  it("maps self-hosted health into the existing logical chain safety slot", async () => {
    const observer = {
      checkHealth: async () => ({
        provider: "solana-rpc" as const,
        ok: true,
        checkedAt: AT,
        latencyMs: 4,
        message: "Standard Solana RPC is reachable and healthy",
        usage: { requests: 7, window: "process" as const }
      }),
      checkWebSocketHealth: async () => ({
        provider: "solana-rpc" as const,
        ok: true,
        checkedAt: AT,
        latencyMs: 3,
        message: "Standard Solana WebSocket accepted a confirmed logs subscription",
        usage: { requests: 7, window: "process" as const }
      }),
      getStreamStatus: () => ({
        active: true,
        connected: true,
        ready: true,
        gapRepairPending: false,
        gapRepairFailed: false,
        lastMessageAt: AT
      }),
      getStreamHealth: () => ({
        provider: "solana-rpc" as const,
        ok: true,
        checkedAt: AT,
        latencyMs: 0,
        message: "stream live",
        usage: { requests: 7, window: "process" as const },
        active: true,
        connected: true,
        ready: true,
        gapRepairPending: false,
        gapRepairFailed: false,
        lastMessageAt: AT
      }),
      summarizeHistory: async () => { throw new Error("not used"); },
      subscribe: async () => { throw new Error("not used"); },
      repairGap: async () => []
    } as unknown as StandardSolanaObserver;
    const provider = new StandardSolanaRuntimeChainProvider(observer);

    await expect(provider.checkHealth()).resolves.toEqual({
      provider: "helius",
      ok: true,
      checkedAt: AT,
      latencyMs: 4,
      message: "Self-hosted Solana RPC: Standard Solana RPC is reachable and healthy",
      usage: { requests: 7, window: "unknown" }
    });
    await expect(provider.checkEndpointsHealth()).resolves.toEqual({
      provider: "helius",
      ok: true,
      checkedAt: AT,
      latencyMs: 4,
      message: "Self-hosted Solana HTTP and confirmed WebSocket endpoints are healthy",
      usage: { requests: 7, window: "unknown" }
    });
    expect(provider.getStreamHealth()).toMatchObject({
      provider: "helius",
      ok: true,
      active: true,
      connected: true,
      ready: true,
      lastMessageAt: AT
    });
  });

  it("fails combined readiness when confirmed WebSocket validation fails and redacts details", async () => {
    const secret = "query-secret";
    const observer = {
      checkHealth: async () => ({
        provider: "solana-rpc" as const,
        ok: true,
        checkedAt: AT,
        latencyMs: 2,
        message: "healthy",
        usage: { requests: 1, window: "process" as const }
      }),
      checkWebSocketHealth: async () => ({
        provider: "solana-rpc" as const,
        ok: false,
        checkedAt: AT,
        latencyMs: 5,
        message: `wss://rpc.test/?api-key=${secret}`,
        usage: { requests: 1, window: "process" as const }
      }),
      getStreamStatus: () => ({
        active: false,
        connected: false,
        ready: false,
        gapRepairPending: false,
        gapRepairFailed: false
      }),
      getStreamHealth: () => ({
        provider: "solana-rpc" as const,
        ok: false,
        checkedAt: AT,
        latencyMs: 0,
        message: "not active",
        usage: { requests: 1, window: "process" as const },
        active: false,
        connected: false,
        ready: false,
        gapRepairPending: false,
        gapRepairFailed: false
      }),
      summarizeHistory: async () => { throw new Error("not used"); },
      subscribe: async () => { throw new Error("not used"); },
      repairGap: async () => []
    } as unknown as StandardSolanaObserver;

    const health = await new StandardSolanaRuntimeChainProvider(observer).checkEndpointsHealth();
    expect(health).toMatchObject({
      ok: false,
      message: "Self-hosted Solana endpoint validation failed: confirmed WebSocket subscription"
    });
    expect(JSON.stringify(health)).not.toContain(secret);
  });
});
