import type {
  DataProviderProfile,
  DataProviderProfileSummary
} from "@copylab/shared";

export const DEFAULT_DATA_PROVIDER_PROFILE: Readonly<DataProviderProfile> = Object.freeze({
  mode: "MANAGED"
});

function endpoint(value: string | undefined, protocols: readonly string[], label: string): URL {
  if (!value?.trim()) throw new Error(`${label} is required for a self-hosted data provider.`);
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error(`${label} must be an absolute URL.`);
  }
  if (!protocols.includes(parsed.protocol)) {
    throw new Error(`${label} must use ${protocols.join(" or ")}.`);
  }
  if (!parsed.hostname) throw new Error(`${label} must include a hostname.`);
  if (parsed.hash) throw new Error(`${label} cannot include a URL fragment.`);
  return parsed;
}

export function normalizeDataProviderProfile(input: DataProviderProfile): DataProviderProfile {
  if (input.mode === "MANAGED") return { mode: "MANAGED" };
  if (input.mode !== "SHADOW" && input.mode !== "SELF_HOSTED") {
    throw new Error("Unknown data-provider mode.");
  }
  const http = endpoint(input.solanaHttpUrl, ["http:", "https:"], "Solana HTTP RPC URL");
  const ws = endpoint(input.solanaWsUrl, ["ws:", "wss:"], "Solana WebSocket RPC URL");
  const emergency = input.emergencySolanaHttpUrl?.trim()
    ? endpoint(
        input.emergencySolanaHttpUrl,
        ["http:", "https:"],
        "Independent emergency-exit Solana HTTP RPC URL"
      )
    : undefined;
  if (emergency?.origin === http.origin) {
    throw new Error("The emergency-exit RPC must use a different host or port from the primary RPC.");
  }
  return {
    mode: input.mode,
    solanaHttpUrl: http.toString(),
    solanaWsUrl: ws.toString(),
    ...(emergency ? { emergencySolanaHttpUrl: emergency.toString() } : {})
  };
}

function safeOrigin(value: string): string {
  const parsed = new URL(value);
  return `${parsed.protocol}//${parsed.host}`;
}

export function summarizeDataProviderProfile(input: DataProviderProfile): DataProviderProfileSummary {
  const profile = normalizeDataProviderProfile(input);
  if (profile.mode === "MANAGED") return { mode: "MANAGED", configured: true };
  return {
    mode: profile.mode,
    configured: true,
    httpOrigin: safeOrigin(profile.solanaHttpUrl!),
    wsOrigin: safeOrigin(profile.solanaWsUrl!),
    ...(profile.emergencySolanaHttpUrl
      ? { emergencyHttpOrigin: safeOrigin(profile.emergencySolanaHttpUrl) }
      : {})
  };
}
