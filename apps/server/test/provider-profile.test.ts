import { describe, expect, it } from "vitest";
import {
  normalizeDataProviderProfile,
  summarizeDataProviderProfile
} from "../src/provider-profile.js";

describe("data provider profile", () => {
  it("keeps the existing managed-provider mode as the safe default", () => {
    expect(normalizeDataProviderProfile({ mode: "MANAGED" })).toEqual({ mode: "MANAGED" });
  });

  it("requires standard HTTP and WebSocket endpoints outside managed mode", () => {
    expect(() => normalizeDataProviderProfile({ mode: "SELF_HOSTED" })).toThrow("HTTP RPC URL");
    expect(() => normalizeDataProviderProfile({
      mode: "SHADOW",
      solanaHttpUrl: "ftp://127.0.0.1:8899",
      solanaWsUrl: "ws://127.0.0.1:8900"
    })).toThrow("http: or https:");
    expect(() => normalizeDataProviderProfile({
      mode: "SELF_HOSTED",
      solanaHttpUrl: "http://127.0.0.1:8899",
      solanaWsUrl: "https://127.0.0.1:8900"
    })).toThrow("ws: or wss:");
  });

  it("normalizes endpoints but returns only origins to dashboard callers", () => {
    const profile = normalizeDataProviderProfile({
      mode: "SHADOW",
      solanaHttpUrl: "https://rpc.example.test/private/key?token=secret",
      solanaWsUrl: "wss://rpc.example.test/private/key?token=secret"
    });
    expect(profile.solanaHttpUrl).toContain("token=secret");
    expect(summarizeDataProviderProfile(profile)).toEqual({
      mode: "SHADOW",
      configured: true,
      httpOrigin: "https://rpc.example.test",
      wsOrigin: "wss://rpc.example.test"
    });
  });

  it("rejects fragments so secrets cannot be ambiguously normalized", () => {
    expect(() => normalizeDataProviderProfile({
      mode: "SELF_HOSTED",
      solanaHttpUrl: "http://127.0.0.1:8899/#token",
      solanaWsUrl: "ws://127.0.0.1:8900"
    })).toThrow("fragment");
  });

  it("keeps the exit-only endpoint encrypted and requires an independent origin", () => {
    const profile = normalizeDataProviderProfile({
      mode: "SELF_HOSTED",
      solanaHttpUrl: "https://primary.example.test/rpc?token=primary",
      solanaWsUrl: "wss://primary.example.test/ws?token=primary",
      emergencySolanaHttpUrl: "https://exit.example.test/rpc?token=exit"
    });
    expect(profile.emergencySolanaHttpUrl).toContain("token=exit");
    expect(summarizeDataProviderProfile(profile).emergencyHttpOrigin).toBe("https://exit.example.test");
    expect(() => normalizeDataProviderProfile({
      ...profile,
      emergencySolanaHttpUrl: "https://primary.example.test/other"
    })).toThrow("different host or port");
  });
});
