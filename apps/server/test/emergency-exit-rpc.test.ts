import { describe, expect, it } from "vitest";
import type { DataProviderProfile } from "@copylab/shared";
import {
  activeEmergencyExitRpcStatus,
  emergencyExitRpcEndpointFingerprint,
  emergencyExitRpcFresh
} from "../src/emergency-exit-rpc.js";

const PROFILE: DataProviderProfile = {
  mode: "SELF_HOSTED",
  solanaHttpUrl: "https://primary.example.test/rpc?secret=primary",
  solanaWsUrl: "wss://primary.example.test/ws?secret=primary",
  emergencySolanaHttpUrl: "https://exit.example.test/rpc?secret=exit"
};

describe("independent emergency-exit RPC evidence", () => {
  it("binds healthy evidence to the exact encrypted endpoint and enforces freshness", () => {
    const checkedAt = "2026-07-10T12:00:00.000Z";
    const status = activeEmergencyExitRpcStatus(PROFILE, {
      configured: true,
      ok: true,
      checkedAt,
      message: "passed",
      endpointFingerprint: emergencyExitRpcEndpointFingerprint(PROFILE.emergencySolanaHttpUrl!)
    });

    expect(status).toEqual({ configured: true, ok: true, checkedAt, message: "passed" });
    expect(emergencyExitRpcFresh(status, new Date("2026-07-10T12:09:59.000Z"))).toBe(true);
    expect(emergencyExitRpcFresh(status, new Date("2026-07-10T12:10:01.000Z"))).toBe(false);
    expect(emergencyExitRpcFresh(status, new Date("2026-07-10T11:59:59.000Z"))).toBe(false);
  });

  it("rejects evidence from a different endpoint and reports missing configuration", () => {
    const mismatched = activeEmergencyExitRpcStatus(PROFILE, {
      configured: true,
      ok: true,
      checkedAt: "2026-07-10T12:00:00.000Z",
      message: "passed",
      endpointFingerprint: emergencyExitRpcEndpointFingerprint("https://other.example.test")
    });
    expect(mismatched).toMatchObject({ configured: true, ok: false });

    expect(activeEmergencyExitRpcStatus({
      mode: "SELF_HOSTED",
      solanaHttpUrl: "https://primary.example.test",
      solanaWsUrl: "wss://primary.example.test"
    }, undefined)).toMatchObject({ configured: false, ok: false });
  });
});
