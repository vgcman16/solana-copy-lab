import { describe, expect, it } from "vitest";
import {
  createProviderProfileRequest,
  dataProviderChangesAllowed,
  dataProviderModeAvailable,
  providerConfirmation,
  providerEndpointsValid
} from "../src/provider-profile";

describe("data-provider profile controls", () => {
  it("uses the server's exact typed confirmations", () => {
    expect(providerConfirmation("MANAGED")).toBe("USE MANAGED DATA");
    expect(providerConfirmation("SHADOW")).toBe("ENABLE SHADOW DATA");
    expect(providerConfirmation("SELF_HOSTED")).toBe("ENABLE SELF HOSTED DATA");
  });

  it("accepts only paired HTTP and WebSocket endpoint protocols", () => {
    expect(providerEndpointsValid("https://rpc.example.test/path", "wss://rpc.example.test/path", "https://exit.example.test")).toBe(true);
    expect(providerEndpointsValid("http://127.0.0.1:8899", "ws://127.0.0.1:8900", "http://127.0.0.1:8898")).toBe(true);
    expect(providerEndpointsValid("wss://rpc.example.test", "https://rpc.example.test", "https://exit.example.test")).toBe(false);
    expect(providerEndpointsValid("not a URL", "wss://rpc.example.test", "https://exit.example.test")).toBe(false);
  });

  it("rejects endpoints with browser-visible username or password credentials", () => {
    expect(providerEndpointsValid("https://user:pass@rpc.example.test", "wss://rpc.example.test", "https://exit.example.test")).toBe(false);
    expect(providerEndpointsValid("https://rpc.example.test", "wss://user:pass@rpc.example.test", "https://exit.example.test")).toBe(false);
    expect(providerEndpointsValid("https://rpc.example.test", "wss://rpc.example.test", "https://rpc.example.test/exit")).toBe(false);
  });

  it("allows provider changes only in PAPER and locks self-hosted until readiness passes", () => {
    expect(dataProviderChangesAllowed("PAPER")).toBe(true);
    expect(dataProviderChangesAllowed("PAUSED")).toBe(false);
    expect(dataProviderChangesAllowed("MANUAL_LIVE")).toBe(false);
    expect(dataProviderModeAvailable("MANAGED", false)).toBe(true);
    expect(dataProviderModeAvailable("SHADOW", false)).toBe(true);
    expect(dataProviderModeAvailable("SELF_HOSTED", false)).toBe(false);
    expect(dataProviderModeAvailable("SELF_HOSTED", true)).toBe(true);
  });

  it("builds strict discriminated request bodies", () => {
    expect(createProviderProfileRequest("MANAGED", "ignored", "ignored", "ignored")).toEqual({
      mode: "MANAGED",
      confirmation: "USE MANAGED DATA"
    });
    expect(createProviderProfileRequest("SELF_HOSTED", "https://rpc.example.test", "wss://rpc.example.test", "https://exit.example.test")).toEqual({
      mode: "SELF_HOSTED",
      solanaHttpUrl: "https://rpc.example.test",
      solanaWsUrl: "wss://rpc.example.test",
      emergencySolanaHttpUrl: "https://exit.example.test",
      confirmation: "ENABLE SELF HOSTED DATA"
    });
  });
});
