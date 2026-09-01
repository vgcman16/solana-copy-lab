import type { WalletHistorySummary } from "@copylab/shared";
import type { Repository } from "./repository.js";
import {
  LOCAL_WALLET_IDENTITY_SOURCE,
  type LocalWalletIdentityResult
} from "./local-wallet-identity.js";

const DISALLOWED_IDENTITY_TAGS = new Set(["dev", "bundler", "sniper", "insider"]);

export function verifiedLocalWalletTags(repository: Repository, address: string): string[] {
  const record = repository.getWalletIndexRecord(address);
  if (
    (record?.walletIdentityStatus !== "VERIFIED" && record?.walletIdentityStatus !== "REJECTED") ||
    record.walletIdentitySource !== LOCAL_WALLET_IDENTITY_SOURCE ||
    !Array.isArray(record.tags)
  ) {
    throw new Error("Local wallet identity evidence is unknown; qualification fails closed.");
  }
  return [...record.tags];
}

export function persistManagedWalletIdentity(
  repository: Repository,
  address: string,
  history: Pick<WalletHistorySummary, "tags">,
  checkedAt = new Date().toISOString()
): boolean {
  const record = repository.getWalletIndexRecord(address);
  if (!record) return false;
  // Managed history remains available in the reconciliation ledger and in
  // the immediate qualification result. Never destroy a completed local scan
  // merely because the operator temporarily returns to MANAGED mode.
  if (record.walletIdentitySource === LOCAL_WALLET_IDENTITY_SOURCE) return true;
  const tags = [...new Set(history.tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))].sort();
  repository.upsertWalletIndexRecord({
    ...record,
    tags,
    walletIdentityStatus: tags.some((tag) => DISALLOWED_IDENTITY_TAGS.has(tag)) ? "REJECTED" : "VERIFIED",
    walletIdentitySource: "helius_wallet_identity",
    walletIdentityCheckedAt: checkedAt,
    updatedAt: checkedAt
  });
  return true;
}

export function persistLocalWalletIdentity(
  repository: Repository,
  result: LocalWalletIdentityResult
): boolean {
  const record = repository.getWalletIndexRecord(result.wallet);
  if (!record) return false;
  repository.upsertWalletIndexRecord({
    ...record,
    tags: [...result.tags],
    walletIdentityStatus: result.status,
    walletIdentitySource: result.source,
    walletIdentityCheckedAt: result.checkedAt,
    updatedAt: result.checkedAt
  });
  repository.audit(
    "local_wallet_identity_classified",
    result.status === "VERIFIED"
      ? "A complete local on-chain scan verified a clean wallet identity."
      : result.status === "REJECTED"
        ? "Local on-chain identity evidence rejected the wallet."
        : "Local on-chain identity evidence remained incomplete and failed closed.",
    {
      wallet: result.wallet,
      status: result.status,
      tags: result.tags,
      source: result.source,
      windowStart: result.windowStart,
      windowEnd: result.windowEnd,
      metrics: result.metrics,
      reasons: result.reasons.slice(0, 20),
      findings: result.findings.slice(0, 20)
    },
    result.status === "VERIFIED" ? "info" : "warning"
  );
  return true;
}
