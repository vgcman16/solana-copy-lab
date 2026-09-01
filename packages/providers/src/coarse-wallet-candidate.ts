import type { PublicKeyString, TransactionSignature } from "@copylab/shared";
import { asRecord, finiteNumber, stringValue } from "./http.js";
import {
  JUPITER_V4_PROGRAM_ID,
  JUPITER_V6_PROGRAM_ID
} from "./helius-decoder.js";
import { confirmedTransactionMetadata } from "./helius-program-indexer.js";

export const JUPITER_COARSE_WALLET_PROGRAM_IDS: ReadonlySet<string> = new Set([
  JUPITER_V6_PROGRAM_ID,
  JUPITER_V4_PROGRAM_ID
]);

export type CoarseWalletCandidateRejectionCode =
  | "PROGRAM_NOT_JUPITER"
  | "MALFORMED_TRANSACTION"
  | "FAILED_TRANSACTION"
  | "SIGNER_COUNT_NOT_ONE"
  | "FEE_PAYER_MISMATCH"
  | "JUPITER_CPI_ONLY";

export interface CoarseWalletCandidateEvidence {
  accepted: true;
  tier: "COARSE_SIGNER";
  sourceSignature: TransactionSignature;
  sourceProgram: PublicKeyString;
  wallet: PublicKeyString;
  slot: number;
  blockTime: string;
  observedAt: string;
  directInvocation: true;
  signerCount: 1;
  transactionSuccess: true;
}

export interface CoarseWalletCandidateRejection {
  accepted: false;
  tier: "COARSE_SIGNER";
  sourceSignature: TransactionSignature;
  sourceProgram: PublicKeyString;
  observedAt: string;
  reasonCode: CoarseWalletCandidateRejectionCode;
}

export type CoarseWalletCandidateDecision =
  | CoarseWalletCandidateEvidence
  | CoarseWalletCandidateRejection;

function outerInstructionProgramIds(value: unknown, accountKeys: readonly string[]): string[] | undefined {
  const root = asRecord(value);
  const transaction = asRecord(root?.transaction);
  const message = asRecord(transaction?.message);
  if (!Array.isArray(message?.instructions)) return undefined;
  const programs: string[] = [];
  for (const value of message.instructions) {
    const instruction = asRecord(value);
    if (!instruction) return undefined;
    const direct = stringValue(instruction.programId);
    if (direct) {
      programs.push(direct);
      continue;
    }
    const index = finiteNumber(instruction.programIdIndex);
    if (!Number.isSafeInteger(index) || (index ?? -1) < 0) return undefined;
    const program = accountKeys[index as number];
    if (!program) return undefined;
    programs.push(program);
  }
  return programs;
}

/**
 * Produces research-only signer evidence. This intentionally does not call or
 * replace the strict spot-swap decoder: no mint, side, amount, eligibility, or
 * copyable-swap claim is inferred here.
 */
export function classifyCoarseJupiterWalletCandidate(
  programId: PublicKeyString,
  signature: TransactionSignature,
  transaction: unknown,
  observedAt = new Date()
): CoarseWalletCandidateDecision {
  const base = {
    tier: "COARSE_SIGNER" as const,
    sourceSignature: signature,
    sourceProgram: programId,
    observedAt: observedAt.toISOString()
  };
  const reject = (reasonCode: CoarseWalletCandidateRejectionCode): CoarseWalletCandidateRejection => ({
    ...base,
    accepted: false,
    reasonCode
  });
  if (!JUPITER_COARSE_WALLET_PROGRAM_IDS.has(programId)) return reject("PROGRAM_NOT_JUPITER");
  const metadata = confirmedTransactionMetadata(transaction);
  if (!metadata) return reject("MALFORMED_TRANSACTION");
  if (!metadata.success) return reject("FAILED_TRANSACTION");
  if (metadata.signers.length !== 1) return reject("SIGNER_COUNT_NOT_ONE");
  const signer = metadata.signers[0];
  if (!signer || metadata.feePayer !== signer) return reject("FEE_PAYER_MISMATCH");
  const outerPrograms = outerInstructionProgramIds(transaction, metadata.accountKeys);
  if (!outerPrograms) return reject("MALFORMED_TRANSACTION");
  if (!outerPrograms.includes(programId)) return reject("JUPITER_CPI_ONLY");
  return {
    ...base,
    accepted: true,
    wallet: signer,
    slot: metadata.slot,
    blockTime: metadata.blockTime,
    directInvocation: true,
    signerCount: 1,
    transactionSuccess: true
  };
}
