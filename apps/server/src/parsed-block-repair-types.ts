import type { IndexedSpotSwap, WalletIndexTransaction } from "@copylab/shared";

/**
 * The repair version freezes selection and application semantics. A decoder
 * version is stored separately so an operator can prove exactly which strict
 * policy evaluated every item without reinterpreting an older manifest.
 */
export const PARSED_BLOCK_REPAIR_VERSION = "parsed-block-repair-v1";
export const PARSED_BLOCK_REPAIR_DECODER_VERSION = "strict-spot-swap-v1";

export const KNOWN_AFFECTED_WALLET_INDEX_RUN_ID = "a771dfeb-538e-4fd8-b357-f10cd0afb317";
export const KNOWN_AFFECTED_WALLET_INDEX_RUN_STARTED_AT = "2026-07-10T15:06:20.123Z";
/** First start of the fixed parsed-block service; later rows are out of scope. */
export const KNOWN_AFFECTED_PARSED_BLOCK_REPAIR_CUTOFF_AT = "2026-07-10T21:56:35.000Z";

export type ParsedBlockRepairManifestStatus =
  | "PENDING"
  | "RUNNING"
  | "COMPLETE"
  | "FAILED";

export type ParsedBlockRepairItemStatus =
  | "PENDING"
  | "LEASED"
  | "RETRY"
  | "RECOVERED"
  | "VALID_ZERO"
  | "FAILED";

export type ParsedBlockHydrationProvenance =
  | "PARSED_BLOCK_REPAIR"
  | "PARSED_TRANSACTION_REPAIR_FALLBACK";

export interface ParsedBlockRepairManifest {
  id: string;
  repairVersion: string;
  decoderVersion: string;
  sourceRunId: string;
  sourceRunStartedAt: string;
  cutoffAt: string;
  status: ParsedBlockRepairManifestStatus;
  maximumItems: number;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  lastError?: string;
}

export interface ParsedBlockRepairItem {
  manifestId: string;
  signature: string;
  slot: number;
  sourcePrograms: string[];
  sourceIndexedAt: string;
  sourceTransactionDigest: string;
  status: ParsedBlockRepairItemStatus;
  attempts: number;
  availableAt: string;
  createdAt: string;
  updatedAt: string;
  leaseOwner?: string;
  leaseToken?: string;
  leasedAt?: string;
  leaseExpiresAt?: string;
  lastError?: string;
  resultSwapCount?: number;
  hydrationProvenance?: ParsedBlockHydrationProvenance;
  completedAt?: string;
}

export interface ParsedBlockRepairCoverage {
  manifest?: ParsedBlockRepairManifest;
  capturedAt: string;
  total: number;
  pending: number;
  leased: number;
  retry: number;
  recovered: number;
  validZero: number;
  failed: number;
  recoveredSwaps: number;
}

export interface CreateParsedBlockRepairManifestInput {
  sourceRunId: string;
  sourceRunStartedAt: string;
  /** Frozen evidence horizon, distinct from the later manifest creation time. */
  cutoffAt: string;
  repairVersion?: string;
  decoderVersion?: string;
  maximumItems?: number;
  at?: Date;
}

export interface ApplyParsedBlockRepairInput {
  item: ParsedBlockRepairItem;
  transaction: WalletIndexTransaction;
  swaps: IndexedSpotSwap[];
  provenance: ParsedBlockHydrationProvenance;
  decoderVersion: string;
  at?: Date;
}
