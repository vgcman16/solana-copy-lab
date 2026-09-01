import { createHash } from "node:crypto";
import type {
  DataProviderMode,
  DataProviderProfile,
  DataProviderRpcCapability,
  DataProviderRpcReadinessSummary,
  ProviderHealth
} from "@copylab/shared";
import type {
  StandardSolanaHealth,
  StandardSolanaRpcReadinessDiagnostic
} from "@copylab/providers";

export const RPC_READINESS_SETTING = "standard_solana_rpc_readiness";

const ALL_CAPABILITIES: readonly DataProviderRpcCapability[] = [
  "GET_HEALTH",
  "CONFIRMED_HEAD",
  "ARCHIVE_HISTORY",
  "SIGNATURE_HISTORY",
  "FULL_TRANSACTION",
  "FULL_BLOCK",
  "BALANCE_READS"
];

const SHADOW_ENTRY_CAPABILITIES: readonly DataProviderRpcCapability[] = [
  "GET_HEALTH",
  "CONFIRMED_HEAD",
  "SIGNATURE_HISTORY",
  "FULL_TRANSACTION",
  "FULL_BLOCK",
  "BALANCE_READS"
];

export interface StoredDataProviderRpcReadiness extends DataProviderRpcReadinessSummary {
  endpointFingerprint: string;
}

const CAPABILITY_NAMES: ReadonlySet<string> = new Set(ALL_CAPABILITIES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStoredReadiness(value: unknown): value is StoredDataProviderRpcReadiness {
  if (!isRecord(value) ||
      typeof value.endpointFingerprint !== "string" ||
      !Number.isFinite(Date.parse(typeof value.checkedAt === "string" ? value.checkedAt : "")) ||
      typeof value.ok !== "boolean" ||
      typeof value.fullCapabilitiesOk !== "boolean" ||
      typeof value.websocketOk !== "boolean" ||
      typeof value.websocketMessage !== "string" ||
      typeof value.websocketLatencyMs !== "number" || !Number.isFinite(value.websocketLatencyMs) ||
      typeof value.minimumArchiveDays !== "number" || !Number.isFinite(value.minimumArchiveDays) ||
      !Array.isArray(value.capabilities) || value.capabilities.length !== ALL_CAPABILITIES.length) return false;
  const names = new Set<string>();
  const valid = value.capabilities.every((capability) => {
    if (!isRecord(capability) ||
        typeof capability.capability !== "string" || !CAPABILITY_NAMES.has(capability.capability) ||
        (capability.status !== "PASS" && capability.status !== "FAIL" && capability.status !== "BLOCKED") ||
        typeof capability.latencyMs !== "number" || !Number.isFinite(capability.latencyMs) ||
        typeof capability.message !== "string" || !isRecord(capability.evidence)) return false;
    names.add(capability.capability);
    return Object.values(capability.evidence).every((evidence) =>
      typeof evidence === "string" || typeof evidence === "number" || typeof evidence === "boolean"
    );
  });
  return valid && names.size === ALL_CAPABILITIES.length;
}

export function dataProviderEndpointFingerprint(profile: DataProviderProfile): string | undefined {
  if (profile.mode === "MANAGED" || !profile.solanaHttpUrl || !profile.solanaWsUrl) return undefined;
  return createHash("sha256")
    .update(new URL(profile.solanaHttpUrl).toString())
    .update("\0")
    .update(new URL(profile.solanaWsUrl).toString())
    .update("\0")
    .update(profile.emergencySolanaHttpUrl ? new URL(profile.emergencySolanaHttpUrl).toString() : "")
    .digest("hex");
}

export function createStoredRpcReadiness(
  profile: DataProviderProfile,
  diagnostic: StandardSolanaRpcReadinessDiagnostic,
  websocket: StandardSolanaHealth
): StoredDataProviderRpcReadiness {
  const endpointFingerprint = dataProviderEndpointFingerprint(profile);
  if (!endpointFingerprint) throw new Error("Self-hosted endpoints are required for RPC readiness evidence.");
  const checkedAt = Date.parse(websocket.checkedAt) >= Date.parse(diagnostic.checkedAt)
    ? websocket.checkedAt
    : diagnostic.checkedAt;
  return {
    endpointFingerprint,
    checkedAt,
    ok: diagnostic.ok && websocket.ok,
    fullCapabilitiesOk: diagnostic.ok,
    websocketOk: websocket.ok,
    websocketLatencyMs: websocket.latencyMs,
    websocketMessage: websocket.message,
    minimumArchiveDays: diagnostic.minimumArchiveDays,
    capabilities: diagnostic.capabilities.map((capability) => ({
      capability: capability.capability,
      status: capability.status,
      latencyMs: capability.latencyMs,
      message: capability.message,
      evidence: { ...capability.evidence }
    }))
  };
}

export function activeRpcReadiness(
  profile: DataProviderProfile,
  stored: unknown
): DataProviderRpcReadinessSummary | undefined {
  const fingerprint = dataProviderEndpointFingerprint(profile);
  if (!isStoredReadiness(stored) || !fingerprint || stored.endpointFingerprint !== fingerprint) return undefined;
  const { endpointFingerprint: _endpointFingerprint, ...summary } = stored;
  return summary;
}

function failedCapabilityLabels(
  mode: Exclude<DataProviderMode, "MANAGED">,
  readiness: DataProviderRpcReadinessSummary
): string[] {
  const byName = new Map(readiness.capabilities.map((capability) => [capability.capability, capability]));
  const required = mode === "SELF_HOSTED" ? ALL_CAPABILITIES : SHADOW_ENTRY_CAPABILITIES;
  return required
    .filter((capability) => byName.get(capability)?.status !== "PASS")
    .map((capability) => capability.toLowerCase().replaceAll("_", " "));
}

/** Builds the logical chain health result without exposing endpoint details. */
export function rpcProfileValidationHealth(
  mode: Exclude<DataProviderMode, "MANAGED">,
  readiness: DataProviderRpcReadinessSummary
): ProviderHealth {
  const failed = failedCapabilityLabels(mode, readiness);
  const fullFlagFailed = mode === "SELF_HOSTED" && !readiness.fullCapabilitiesOk && failed.length === 0;
  const ok = readiness.websocketOk && failed.length === 0 && !fullFlagFailed;
  const failures = [
    ...failed,
    ...(fullFlagFailed ? ["full rpc readiness"] : []),
    ...(!readiness.websocketOk ? ["confirmed websocket subscription"] : [])
  ];
  const archiveDeferred = mode === "SHADOW" && !readiness.fullCapabilitiesOk;
  return {
    provider: "helius",
    ok,
    checkedAt: readiness.checkedAt,
    latencyMs: Math.max(
      readiness.websocketLatencyMs,
      ...readiness.capabilities.map((capability) => capability.latencyMs)
    ),
    message: ok
      ? archiveDeferred
        ? "Self-hosted core RPC and confirmed WebSocket checks passed; full archive readiness remains blocked"
        : "Self-hosted full RPC and confirmed WebSocket capability checks passed"
      : `Self-hosted endpoint validation failed: ${failures.slice(0, 3).join(", ")}${
          failures.length > 3 ? ` and ${failures.length - 3} more` : ""
        }`
  };
}
