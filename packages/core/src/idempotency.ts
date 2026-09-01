import { createHash } from "node:crypto";
import type { PublicKeyString, TradeSide, TransactionSignature } from "@copylab/shared";

export interface IdempotencyParts {
  sourceSignature: TransactionSignature;
  sourceWallet: PublicKeyString;
  mint: PublicKeyString;
  action: TradeSide | "FORCED_EXIT" | "EMERGENCY_EXIT";
}

/** Length-prefixing prevents ambiguous concatenation before hashing. */
export function createIdempotencyKey(parts: IdempotencyParts): string {
  const canonical = [parts.sourceSignature, parts.sourceWallet, parts.mint, parts.action]
    .map((value) => `${Buffer.byteLength(value, "utf8")}:${value}`)
    .join("|");
  return `copy-v1-${createHash("sha256").update(canonical).digest("hex")}`;
}
