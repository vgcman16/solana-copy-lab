import { TOKEN_PROGRAM_ID, type PublicKeyString } from "@copylab/shared";
import type {
  SolanaSignatureInfo,
  StandardSolanaRpcClient
} from "./standard-solana-rpc.js";
import { asRecord, finiteNumber } from "./http.js";

const DAY_SECONDS = 86_400;
const DEFAULT_MINIMUM_ARCHIVE_DAYS = 90;
const DEFAULT_MAXIMUM_HEAD_AGE_SECONDS = 120;
const DEFAULT_ARCHIVE_BOUNDARY_SCAN_SLOTS = 64;

export type StandardSolanaCapability =
  | "GET_HEALTH"
  | "CONFIRMED_HEAD"
  | "ARCHIVE_HISTORY"
  | "SIGNATURE_HISTORY"
  | "FULL_TRANSACTION"
  | "FULL_BLOCK"
  | "BALANCE_READS";

export type StandardSolanaCapabilityStatus = "PASS" | "FAIL" | "BLOCKED";

export interface StandardSolanaCapabilityDiagnostic {
  capability: StandardSolanaCapability;
  status: StandardSolanaCapabilityStatus;
  latencyMs: number;
  message: string;
  evidence: Record<string, string | number | boolean>;
}

export interface StandardSolanaRpcReadinessDiagnostic {
  provider: "solana-rpc";
  ok: boolean;
  checkedAt: string;
  probeAddress: PublicKeyString;
  minimumArchiveDays: number;
  maximumHeadAgeSeconds: number;
  capabilities: StandardSolanaCapabilityDiagnostic[];
}

export interface StandardSolanaRpcReadinessOptions {
  /** Address used to prove signature history and balance RPC compatibility. */
  probeAddress?: PublicKeyString;
  minimumArchiveDays?: number;
  maximumHeadAgeSeconds?: number;
  /** Maximum consecutive slots inspected after a skipped/pruned boundary. */
  archiveBoundaryScanSlots?: number;
  now?: () => Date;
  monotonicNow?: () => number;
}

export type StandardSolanaReadinessRpc = Pick<
  StandardSolanaRpcClient,
  | "getHealth"
  | "getSlot"
  | "getBlockTime"
  | "getFirstAvailableBlock"
  | "getMinimumLedgerSlot"
  | "getSignaturesForAddress"
  | "getTransaction"
  | "getBlock"
  | "getBalance"
  | "getTokenAccountsByOwner"
>;

interface SuccessfulCapability {
  message: string;
  evidence?: Record<string, string | number | boolean>;
}

class CapabilityFailure extends Error {
  constructor(
    message: string,
    readonly evidence: Record<string, string | number | boolean> = {}
  ) {
    super(message);
    this.name = "CapabilityFailure";
  }
}

function finitePositive(value: number, label: string, maximum: number): number {
  if (!Number.isFinite(value) || value <= 0 || value > maximum) {
    throw new RangeError(`${label} must be greater than zero and no more than ${maximum}`);
  }
  return value;
}

function positiveInteger(value: number, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${label} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function blocked(capability: StandardSolanaCapability, message: string): StandardSolanaCapabilityDiagnostic {
  return { capability, status: "BLOCKED", latencyMs: 0, message, evidence: {} };
}

async function inspectCapability(
  capability: StandardSolanaCapability,
  monotonicNow: () => number,
  operation: () => Promise<SuccessfulCapability>
): Promise<StandardSolanaCapabilityDiagnostic> {
  const startedAt = monotonicNow();
  try {
    const result = await operation();
    return {
      capability,
      status: "PASS",
      latencyMs: Math.max(0, monotonicNow() - startedAt),
      message: result.message,
      evidence: result.evidence ?? {}
    };
  } catch (error) {
    // Provider, transport, and endpoint error text is intentionally excluded:
    // it can contain credentials embedded in an operator-supplied URL.
    return {
      capability,
      status: "FAIL",
      latencyMs: Math.max(0, monotonicNow() - startedAt),
      message: error instanceof CapabilityFailure
        ? error.message
        : `${capability} capability check failed`,
      evidence: error instanceof CapabilityFailure ? error.evidence : {}
    };
  }
}

/**
 * Checks only the standard Solana JSON-RPC capabilities CopyLab consumes.
 * Every required capability must pass; absent archive/full-transaction/full-
 * block/balance support is a fail-closed result rather than a soft warning.
 */
export async function diagnoseStandardSolanaRpcReadiness(
  rpc: StandardSolanaReadinessRpc,
  options: StandardSolanaRpcReadinessOptions = {}
): Promise<StandardSolanaRpcReadinessDiagnostic> {
  const minimumArchiveDays = finitePositive(
    options.minimumArchiveDays ?? DEFAULT_MINIMUM_ARCHIVE_DAYS,
    "minimumArchiveDays",
    10_000
  );
  const maximumHeadAgeSeconds = finitePositive(
    options.maximumHeadAgeSeconds ?? DEFAULT_MAXIMUM_HEAD_AGE_SECONDS,
    "maximumHeadAgeSeconds",
    DAY_SECONDS
  );
  const archiveBoundaryScanSlots = positiveInteger(
    options.archiveBoundaryScanSlots ?? DEFAULT_ARCHIVE_BOUNDARY_SCAN_SLOTS,
    "archiveBoundaryScanSlots",
    512
  );
  const now = options.now ?? (() => new Date());
  const monotonicNow = options.monotonicNow ?? Date.now;
  const checkedAt = now();
  if (!Number.isFinite(checkedAt.getTime())) throw new Error("Readiness clock returned an invalid date");
  const probeAddress = options.probeAddress ?? TOKEN_PROGRAM_ID;
  const capabilities: StandardSolanaCapabilityDiagnostic[] = [];

  const health = await inspectCapability("GET_HEALTH", monotonicNow, async () => {
    await rpc.getHealth();
    return { message: "Standard Solana getHealth passed" };
  });
  capabilities.push(health);
  if (health.status !== "PASS") {
    for (const capability of [
      "CONFIRMED_HEAD",
      "ARCHIVE_HISTORY",
      "SIGNATURE_HISTORY",
      "FULL_TRANSACTION",
      "FULL_BLOCK",
      "BALANCE_READS"
    ] as const) {
      capabilities.push(blocked(capability, `${capability} was not attempted because getHealth failed`));
    }
    return {
      provider: "solana-rpc",
      ok: false,
      checkedAt: checkedAt.toISOString(),
      probeAddress,
      minimumArchiveDays,
      maximumHeadAgeSeconds,
      capabilities
    };
  }

  let confirmedBlockTime: number | undefined;
  const head = await inspectCapability("CONFIRMED_HEAD", monotonicNow, async () => {
    const slot = await rpc.getSlot();
    const blockTime = await rpc.getBlockTime(slot);
    if (blockTime === null) throw new CapabilityFailure("Confirmed block time is unavailable", { confirmedSlot: slot });
    const ageSeconds = (checkedAt.getTime() / 1_000) - blockTime;
    if (ageSeconds < -30 || ageSeconds > maximumHeadAgeSeconds) {
      throw new CapabilityFailure("Confirmed head block time is outside the freshness limit", {
        confirmedSlot: slot,
        confirmedBlockTime: new Date(blockTime * 1_000).toISOString(),
        headAgeSeconds: ageSeconds
      });
    }
    confirmedBlockTime = blockTime;
    return {
      message: "Confirmed slot and block time are fresh",
      evidence: {
        confirmedSlot: slot,
        confirmedBlockTime: new Date(blockTime * 1_000).toISOString(),
        headAgeSeconds: Math.max(0, ageSeconds)
      }
    };
  });
  capabilities.push(head);

  if (confirmedBlockTime === undefined) {
    capabilities.push(blocked("ARCHIVE_HISTORY", "Archive depth requires a fresh confirmed head"));
  } else {
    capabilities.push(await inspectCapability("ARCHIVE_HISTORY", monotonicNow, async () => {
      let archiveStartSlot: number;
      let source: "getFirstAvailableBlock" | "minimumLedgerSlot";
      try {
        archiveStartSlot = await rpc.getFirstAvailableBlock();
        source = "getFirstAvailableBlock";
      } catch {
        archiveStartSlot = await rpc.getMinimumLedgerSlot();
        source = "minimumLedgerSlot";
      }
      let archiveBoundarySlot: number | undefined;
      let archiveStartTime: number | undefined;
      for (let offset = 0; offset < archiveBoundaryScanSlots; offset += 1) {
        const slot = archiveStartSlot + offset;
        if (!Number.isSafeInteger(slot)) break;
        try {
          const block = asRecord(await rpc.getBlock(slot));
          const blockTime = finiteNumber(block?.blockTime);
          if (
            block &&
            Array.isArray(block.transactions) &&
            Number.isSafeInteger(blockTime) &&
            (blockTime ?? -1) >= 0
          ) {
            archiveBoundarySlot = slot;
            archiveStartTime = blockTime;
            break;
          }
        } catch {
          // Skipped slots are surfaced as either null or an RPC error depending
          // on node version. Continue only within the strict scan bound.
        }
      }
      if (archiveBoundarySlot === undefined || archiveStartTime === undefined) {
        throw new CapabilityFailure("Full block data is unavailable at the archive boundary", {
          archiveStartSource: source,
          archiveStartSlot,
          archiveBoundaryScanSlots
        });
      }
      const archiveDepthDays = (confirmedBlockTime! - archiveStartTime) / DAY_SECONDS;
      if (!Number.isFinite(archiveDepthDays) || archiveDepthDays < minimumArchiveDays) {
        throw new CapabilityFailure("Confirmed archive depth is below the required minimum", {
          archiveStartSource: source,
          archiveStartSlot,
          archiveBoundarySlot,
          archiveStartTime: new Date(archiveStartTime * 1_000).toISOString(),
          archiveDepthDays
        });
      }
      return {
        message: "Required confirmed archive depth is available",
        evidence: {
          archiveStartSource: source,
          archiveStartSlot,
          archiveBoundarySlot,
          archiveStartTime: new Date(archiveStartTime * 1_000).toISOString(),
          archiveDepthDays
        }
      };
    }));
  }

  let historyProbe: SolanaSignatureInfo | undefined;
  capabilities.push(await inspectCapability("SIGNATURE_HISTORY", monotonicNow, async () => {
    const signatures = await rpc.getSignaturesForAddress(probeAddress, { limit: 1 });
    const signature = signatures[0];
    if (!signature) throw new CapabilityFailure("Confirmed address signature history is empty");
    historyProbe = signature;
    return {
      message: "Confirmed address signature history is available",
      evidence: { historySlot: signature.slot }
    };
  }));

  if (!historyProbe) {
    capabilities.push(blocked("FULL_TRANSACTION", "Full transaction check requires signature history"));
    capabilities.push(blocked("FULL_BLOCK", "Full block check requires signature history"));
  } else {
    const probe = historyProbe;
    capabilities.push(await inspectCapability("FULL_TRANSACTION", monotonicNow, async () => {
      const transaction = asRecord(await rpc.getTransaction(probe.signature));
      if (!transaction || !asRecord(transaction.transaction) || !asRecord(transaction.meta)) {
        throw new CapabilityFailure("Confirmed full transaction hydration is unavailable");
      }
      return {
        message: "Confirmed full transaction hydration is available",
        evidence: { transactionSlot: probe.slot }
      };
    }));
    capabilities.push(await inspectCapability("FULL_BLOCK", monotonicNow, async () => {
      const block = asRecord(await rpc.getBlock(probe.slot));
      if (!block || !Array.isArray(block.transactions)) {
        throw new CapabilityFailure("Confirmed full block hydration is unavailable");
      }
      return {
        message: "Confirmed full block hydration is available",
        evidence: { blockSlot: probe.slot }
      };
    }));
  }

  capabilities.push(await inspectCapability("BALANCE_READS", monotonicNow, async () => {
    const [lamports, tokenAccounts] = await Promise.all([
      rpc.getBalance(probeAddress),
      rpc.getTokenAccountsByOwner(probeAddress)
    ]);
    return {
      message: "SOL and standard SPL-token balance reads are compatible",
      evidence: { lamports, tokenAccountCount: tokenAccounts.length }
    };
  }));

  return {
    provider: "solana-rpc",
    ok: capabilities.every((capability) => capability.status === "PASS"),
    checkedAt: checkedAt.toISOString(),
    probeAddress,
    minimumArchiveDays,
    maximumHeadAgeSeconds,
    capabilities
  };
}
