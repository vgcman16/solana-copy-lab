import type {
  IndexedSpotSwap,
  WalletIndexRecord
} from "@copylab/shared";
import type {
  CoarseWalletCandidateDecision,
  CoarseWalletCandidateEvidence
} from "@copylab/providers";
import type { Repository } from "./repository.js";

export const COARSE_WALLET_ACCEPTED_SOURCE = "local-coarse-signer-accepted";
export const COARSE_WALLET_REJECTED_SOURCE = "local-coarse-signer-rejected";
export const EXACT_WALLET_ATTRIBUTION_SOURCE = "local-exact-swap-attribution";
export const WALLET_DISCOVERY_ATTRIBUTION_SOURCES = [
  COARSE_WALLET_ACCEPTED_SOURCE,
  COARSE_WALLET_REJECTED_SOURCE,
  EXACT_WALLET_ATTRIBUTION_SOURCE
] as const;

export type CoarseWalletAdmission = "ADDED" | "EXISTING" | "TARGET_REACHED";

function attributionMetadata(
  decision: CoarseWalletCandidateDecision,
  observedSuccessfulTransactions: number
): Record<string, unknown> {
  return {
    tier: decision.tier,
    accepted: decision.accepted,
    sourceSignature: decision.sourceSignature,
    sourceProgram: decision.sourceProgram,
    observedAt: decision.observedAt,
    directInvocation: decision.accepted,
    signerCount: decision.accepted ? decision.signerCount : undefined,
    transactionSuccess: decision.accepted ? decision.transactionSuccess : undefined,
    wallet: decision.accepted ? decision.wallet : undefined,
    reasonCode: decision.accepted ? undefined : decision.reasonCode,
    observedSuccessfulTransactions
  };
}

export function recordRejectedCoarseWalletCandidate(
  repository: Repository,
  decision: Exclude<CoarseWalletCandidateDecision, { accepted: true }>,
  observedSuccessfulTransactions: number
): boolean {
  return repository.recordWalletDiscoveryAttribution({
    signature: decision.sourceSignature,
    programId: decision.sourceProgram,
    source: COARSE_WALLET_REJECTED_SOURCE,
    observedAt: decision.observedAt,
    metadata: attributionMetadata(decision, observedSuccessfulTransactions)
  });
}

/**
 * Adds a research-only candidate without inventing transaction or swap stats.
 * Target checks happen immediately before the insert, and an existing EXACT
 * wallet can never be downgraded by coarse evidence.
 */
export function materializeCoarseWalletCandidate(
  repository: Repository,
  evidence: CoarseWalletCandidateEvidence,
  targetWallets: number,
  observedSuccessfulTransactions = 1
): CoarseWalletAdmission {
  if (!Number.isSafeInteger(targetWallets) || targetWallets < 1) {
    throw new RangeError("Coarse wallet target must be a positive safe integer.");
  }
  const existing = repository.getWalletIndexRecord(evidence.wallet);
  if (!existing && repository.walletIndexCoverage().indexedWallets >= targetWallets) {
    return "TARGET_REACHED";
  }
  if (!existing) {
    const record: WalletIndexRecord = {
      wallet: evidence.wallet,
      firstSeenAt: evidence.blockTime,
      lastSeenAt: evidence.blockTime,
      historyDays: 0,
      transactionCount: 0,
      successfulTransactionCount: 0,
      spotSwapCount: 0,
      eligibleSpotSwapCount: 0,
      closedEligibleSwaps: 0,
      buyCount: 0,
      sellCount: 0,
      activeDays: 0,
      activeWeeks: 0,
      distinctMints: 0,
      medianHoldingMinutes: 0,
      preScreenEligible: false,
      preScreenReasons: ["pending activity pre-screen"],
      discoveryTier: "COARSE_SIGNER",
      discoveryProvenance: {
        sourceSignature: evidence.sourceSignature,
        sourceProgram: evidence.sourceProgram,
        source: "DIRECT_JUPITER_SINGLE_SIGNER",
        observedAt: evidence.observedAt
      },
      discoveryObservedSuccessfulTransactions: Math.max(1, observedSuccessfulTransactions),
      updatedAt: evidence.observedAt
    };
    repository.upsertWalletIndexRecord(record);
  } else if (existing.discoveryTier !== "EXACT_SWAP") {
    repository.upsertWalletIndexRecord({
      ...existing,
      discoveryTier: "COARSE_SIGNER",
      discoveryProvenance: existing.discoveryProvenance ?? {
        sourceSignature: evidence.sourceSignature,
        sourceProgram: evidence.sourceProgram,
        source: "DIRECT_JUPITER_SINGLE_SIGNER",
        observedAt: evidence.observedAt
      },
      discoveryObservedSuccessfulTransactions: Math.max(
        existing.discoveryObservedSuccessfulTransactions ?? 0,
        observedSuccessfulTransactions
      ),
      updatedAt: evidence.observedAt
    });
  }
  repository.recordWalletDiscoveryAttribution({
    signature: evidence.sourceSignature,
    programId: evidence.sourceProgram,
    wallet: evidence.wallet,
    source: COARSE_WALLET_ACCEPTED_SOURCE,
    observedAt: evidence.observedAt,
    metadata: attributionMetadata(evidence, observedSuccessfulTransactions)
  });
  return existing ? "EXISTING" : "ADDED";
}

export function exactWalletDiscoveryFields(
  swap: IndexedSpotSwap,
  fallbackProgram: string
): Pick<WalletIndexRecord, "discoveryTier" | "discoveryProvenance"> {
  return {
    discoveryTier: "EXACT_SWAP",
    discoveryProvenance: {
      sourceSignature: swap.signature,
      sourceProgram: swap.programIds.find((program) => program === fallbackProgram) ?? fallbackProgram,
      source: "STRICT_NORMALIZED_SWAP",
      observedAt: swap.indexedAt
    }
  };
}

export function recordExactWalletAttribution(
  repository: Repository,
  swap: IndexedSpotSwap,
  sourceProgram: string
): boolean {
  return repository.recordWalletDiscoveryAttribution({
    signature: swap.signature,
    programId: sourceProgram,
    wallet: swap.wallet,
    source: EXACT_WALLET_ATTRIBUTION_SOURCE,
    observedAt: swap.indexedAt,
    metadata: {
      tier: "EXACT_SWAP",
      accepted: true,
      sourceSignature: swap.signature,
      sourceProgram,
      wallet: swap.wallet,
      observedAt: swap.indexedAt,
      normalizedSwapId: swap.id
    }
  });
}
