import { createHash } from "node:crypto";
import type { DataProviderProfile, EmergencyExitRpcStatus } from "@copylab/shared";
import {
  StandardSolanaRpcClient,
  diagnoseStandardSolanaRpcReadiness,
  redactSensitiveText,
  type StandardSolanaCapability
} from "@copylab/providers";

export const EMERGENCY_EXIT_RPC_STATUS_SETTING = "emergency_exit_rpc_status_v1";
export const EMERGENCY_EXIT_RPC_MAXIMUM_AGE_MS = 10 * 60_000;

const REQUIRED_CAPABILITIES: ReadonlySet<StandardSolanaCapability> = new Set([
  "GET_HEALTH",
  "CONFIRMED_HEAD",
  "SIGNATURE_HISTORY",
  "FULL_TRANSACTION",
  "BALANCE_READS"
]);

export interface StoredEmergencyExitRpcStatus extends EmergencyExitRpcStatus {
  configured: true;
  endpointFingerprint: string;
}

export function emergencyExitRpcEndpointFingerprint(endpoint: string): string {
  return createHash("sha256").update(new URL(endpoint).toString()).digest("hex");
}

function storedStatus(value: unknown): value is StoredEmergencyExitRpcStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return row.configured === true &&
    typeof row.ok === "boolean" &&
    typeof row.message === "string" &&
    typeof row.checkedAt === "string" && Number.isFinite(Date.parse(row.checkedAt)) &&
    typeof row.endpointFingerprint === "string" && /^[a-f0-9]{64}$/u.test(row.endpointFingerprint);
}

export async function probeEmergencyExitRpc(
  endpoint: string,
  onRequest?: () => void
): Promise<StoredEmergencyExitRpcStatus> {
  const endpointFingerprint = emergencyExitRpcEndpointFingerprint(endpoint);
  const rpc = new StandardSolanaRpcClient({
    httpUrl: endpoint,
    timeoutMs: 8_000,
    requestsPerSecond: 20,
    maximumRetries: 0,
    ...(onRequest ? { onRequest } : {})
  });
  try {
    // Reuse the strict parser/capability probes. Archive and full-block results
    // remain visible to diagnostics but are not required for the bounded exit
    // path, which needs fresh state, signatures, transactions, and balances.
    const diagnostic = await diagnoseStandardSolanaRpcReadiness(rpc, {
      minimumArchiveDays: 1,
      archiveBoundaryScanSlots: 1
    });
    const failed = diagnostic.capabilities.filter(
      (capability) => REQUIRED_CAPABILITIES.has(capability.capability) && capability.status !== "PASS"
    );
    return {
      configured: true,
      ok: failed.length === 0,
      checkedAt: diagnostic.checkedAt,
      message: failed.length === 0
        ? "Independent emergency-exit RPC passed fresh-state, transaction, and balance checks"
        : `Independent emergency-exit RPC failed: ${failed
            .slice(0, 3)
            .map((entry) => entry.capability.toLowerCase().replaceAll("_", " "))
            .join(", ")}`,
      endpointFingerprint
    };
  } catch (error) {
    return {
      configured: true,
      ok: false,
      checkedAt: new Date().toISOString(),
      message: redactSensitiveText(
        error instanceof Error ? error.message : "Independent emergency-exit RPC probe failed",
        500
      ),
      endpointFingerprint
    };
  }
}

export function activeEmergencyExitRpcStatus(
  profile: DataProviderProfile,
  stored: unknown
): EmergencyExitRpcStatus {
  if (profile.mode === "MANAGED") {
    return {
      configured: true,
      ok: true,
      message: "Managed signer RPC remains the active exit path"
    };
  }
  if (!profile.emergencySolanaHttpUrl) {
    return {
      configured: false,
      ok: false,
      message: "An independent emergency-exit HTTP RPC is not configured"
    };
  }
  if (
    !storedStatus(stored) ||
    stored.endpointFingerprint !== emergencyExitRpcEndpointFingerprint(profile.emergencySolanaHttpUrl)
  ) {
    return {
      configured: true,
      ok: false,
      message: "Independent emergency-exit RPC evidence is missing for the active endpoint"
    };
  }
  const { endpointFingerprint: _endpointFingerprint, ...summary } = stored;
  return summary;
}

export function emergencyExitRpcFresh(status: EmergencyExitRpcStatus, now = new Date()): boolean {
  if (!status.configured || !status.ok || !status.checkedAt) return false;
  const checkedAt = Date.parse(status.checkedAt);
  return Number.isFinite(checkedAt) &&
    now.getTime() >= checkedAt &&
    now.getTime() - checkedAt <= EMERGENCY_EXIT_RPC_MAXIMUM_AGE_MS;
}
