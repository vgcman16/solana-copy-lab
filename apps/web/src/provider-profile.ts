import type { DataProviderMode, ModeState } from "@copylab/shared";
import type { DataProviderProfileRequest } from "./types";

export type ProviderConfirmation = DataProviderProfileRequest["confirmation"];

const CONFIRMATIONS: Record<DataProviderMode, ProviderConfirmation> = {
  MANAGED: "USE MANAGED DATA",
  SHADOW: "ENABLE SHADOW DATA",
  SELF_HOSTED: "ENABLE SELF HOSTED DATA"
};

export function providerConfirmation(mode: DataProviderMode): ProviderConfirmation {
  return CONFIRMATIONS[mode];
}

function hasProtocol(value: string, allowed: readonly string[]): boolean {
  try {
    const parsed = new URL(value);
    return allowed.includes(parsed.protocol) && parsed.username === "" && parsed.password === "";
  } catch {
    return false;
  }
}

export function providerEndpointsValid(httpUrl: string, wsUrl: string, emergencyHttpUrl: string): boolean {
  if (
    !hasProtocol(httpUrl, ["http:", "https:"]) ||
    !hasProtocol(wsUrl, ["ws:", "wss:"]) ||
    !hasProtocol(emergencyHttpUrl, ["http:", "https:"])
  ) return false;
  return new URL(httpUrl).origin !== new URL(emergencyHttpUrl).origin;
}

export function dataProviderChangesAllowed(appMode: ModeState): boolean {
  return appMode === "PAPER";
}

export function dataProviderModeAvailable(mode: DataProviderMode, selfHostedReady: boolean): boolean {
  return mode !== "SELF_HOSTED" || selfHostedReady;
}

export function createProviderProfileRequest(
  mode: DataProviderMode,
  httpUrl: string,
  wsUrl: string,
  emergencyHttpUrl: string
): DataProviderProfileRequest {
  if (mode === "MANAGED") {
    return { mode, confirmation: "USE MANAGED DATA" };
  }
  if (mode === "SHADOW") {
    return {
      mode,
      solanaHttpUrl: httpUrl,
      solanaWsUrl: wsUrl,
      emergencySolanaHttpUrl: emergencyHttpUrl,
      confirmation: "ENABLE SHADOW DATA"
    };
  }
  return {
    mode: "SELF_HOSTED",
    solanaHttpUrl: httpUrl,
    solanaWsUrl: wsUrl,
    emergencySolanaHttpUrl: emergencyHttpUrl,
    confirmation: "ENABLE SELF HOSTED DATA"
  };
}
