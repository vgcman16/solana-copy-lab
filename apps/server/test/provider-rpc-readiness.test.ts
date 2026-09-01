import { describe, expect, it } from "vitest";
import type { DataProviderProfile } from "@copylab/shared";
import type {
  StandardSolanaHealth,
  StandardSolanaRpcReadinessDiagnostic
} from "@copylab/providers";
import {
  activeRpcReadiness,
  createStoredRpcReadiness,
  rpcProfileValidationHealth
} from "../src/provider-rpc-readiness.js";

const PROFILE: DataProviderProfile = {
  mode: "SHADOW",
  solanaHttpUrl: "https://rpc.example.test/private/path?api-key=secret-http",
  solanaWsUrl: "wss://rpc.example.test/private/path?api-key=secret-ws"
};
const AT = "2026-07-10T12:00:00.000Z";
const CAPABILITIES = [
  "GET_HEALTH",
  "CONFIRMED_HEAD",
  "ARCHIVE_HISTORY",
  "SIGNATURE_HISTORY",
  "FULL_TRANSACTION",
  "FULL_BLOCK",
  "BALANCE_READS"
] as const;

function diagnostic(archiveOk: boolean): StandardSolanaRpcReadinessDiagnostic {
  return {
    provider: "solana-rpc",
    ok: archiveOk,
    checkedAt: AT,
    probeAddress: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    minimumArchiveDays: 90,
    maximumHeadAgeSeconds: 120,
    capabilities: CAPABILITIES.map((capability) => ({
      capability,
      status: capability === "ARCHIVE_HISTORY" && !archiveOk ? "FAIL" : "PASS",
      latencyMs: 2,
      message: capability === "ARCHIVE_HISTORY" && !archiveOk
        ? "Confirmed archive depth is below the required minimum"
        : "passed",
      evidence: capability === "ARCHIVE_HISTORY" ? { archiveDepthDays: 30 } : {}
    }))
  };
}

function websocket(ok = true): StandardSolanaHealth {
  return {
    provider: "solana-rpc",
    ok,
    checkedAt: AT,
    latencyMs: 3,
    message: ok
      ? "Standard Solana WebSocket accepted a confirmed logs subscription"
      : "Standard Solana WebSocket confirmed subscription probe timed out",
    usage: { requests: 0, window: "process" }
  };
}

describe("provider RPC readiness evidence", () => {
  it("allows SHADOW core collection while keeping full SELF_HOSTED archive promotion blocked", () => {
    const stored = createStoredRpcReadiness(PROFILE, diagnostic(false), websocket());

    expect(rpcProfileValidationHealth("SHADOW", stored)).toMatchObject({
      ok: true,
      message: expect.stringContaining("archive readiness remains blocked")
    });
    expect(rpcProfileValidationHealth("SELF_HOSTED", stored)).toMatchObject({
      ok: false,
      message: expect.stringContaining("archive history")
    });
  });

  it("persists only redacted, endpoint-bound evidence", () => {
    const stored = createStoredRpcReadiness(PROFILE, diagnostic(true), websocket());
    const serialized = JSON.stringify(stored);
    for (const secret of ["secret-http", "secret-ws", "private/path"]) {
      expect(serialized).not.toContain(secret);
    }
    expect(activeRpcReadiness(PROFILE, stored)).toMatchObject({ ok: true, websocketOk: true });
    expect(activeRpcReadiness({
      ...PROFILE,
      solanaHttpUrl: "https://rpc.example.test/private/path?api-key=changed"
    }, stored)).toBeUndefined();
    expect(activeRpcReadiness(PROFILE, {
      endpointFingerprint: stored.endpointFingerprint,
      capabilities: "corrupted"
    })).toBeUndefined();
  });

  it("requires the confirmed WebSocket probe in both SHADOW and SELF_HOSTED", () => {
    const stored = createStoredRpcReadiness(PROFILE, diagnostic(true), websocket(false));
    expect(rpcProfileValidationHealth("SHADOW", stored)).toMatchObject({
      ok: false,
      message: expect.stringContaining("confirmed websocket subscription")
    });
    expect(rpcProfileValidationHealth("SELF_HOSTED", stored).ok).toBe(false);
  });
});
