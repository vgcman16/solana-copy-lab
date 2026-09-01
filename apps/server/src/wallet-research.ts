import { qualifyWallet } from "@copylab/core";
import {
  type WalletCandidate,
  type WalletHistorySummary,
  type WalletIndexRecord,
  type WalletScore
} from "@copylab/shared";

export const DEFAULT_LOCAL_RESEARCH_LIMIT = 50;

export interface WalletResearchShortlistOptions {
  cohortId: string;
  localRecords: readonly WalletIndexRecord[];
  /** Provider candidates must already be ordered by the provider-ranking policy. */
  providerCandidates: readonly WalletCandidate[];
  /** Loss-side controls and any other wallets that must not enter the leader lane. */
  excludedWallets?: Iterable<string>;
  totalLimit?: number;
  localLimit?: number;
}

export interface WalletResearchShortlist {
  candidates: WalletCandidate[];
  localAddresses: string[];
  providerAddresses: string[];
  overlapAddresses: string[];
}

/**
 * MANAGED qualification uses Helius twice for different evidence: the frozen
 * RPC transaction reconstruction supplies exact structural counts, while the
 * Wallet API supplies identity tags and an independent profit-concentration
 * check. The thresholds are unchanged; this only prevents the Wallet API's
 * recognized-swap subset from erasing already proven RPC history.
 */
export function combineManagedProviderAndFrozenHistory(
  provider: WalletHistorySummary,
  frozen: WalletIndexRecord
): WalletHistorySummary {
  if (
    provider.wallet !== frozen.wallet ||
    !frozen.preScreenEligible ||
    frozen.deepHistoryStatus !== "COMPLETE" ||
    frozen.structuralEligible !== true ||
    frozen.deepHistorySignatureCount === undefined ||
    frozen.deepHistoryHydratedCount === undefined ||
    !Number.isSafeInteger(frozen.deepHistorySignatureCount) ||
    frozen.deepHistorySignatureCount < 1 ||
    frozen.deepHistoryHydratedCount !== frozen.deepHistorySignatureCount
  ) {
    throw new Error("Managed structural qualification requires complete immutable RPC history evidence.");
  }
  const locallyPriced = frozen.profitPricingCoverage === "COMPLETE";
  const localTop = locallyPriced && typeof frozen.topTokenProfitShare === "number" &&
    Number.isFinite(frozen.topTokenProfitShare)
    ? frozen.topTokenProfitShare
    : undefined;
  const localTopThree = locallyPriced && typeof frozen.topThreeProfitShare === "number" &&
    Number.isFinite(frozen.topThreeProfitShare)
    ? frozen.topThreeProfitShare
    : undefined;
  return {
    wallet: provider.wallet,
    historyDays: frozen.historyDays,
    closedEligibleSwaps: frozen.closedEligibleSwaps,
    activeWeeks: frozen.activeWeeks,
    medianHoldingMinutes: frozen.medianHoldingMinutes,
    // When both sources have complete concentration evidence, choose the more
    // conservative value so source fusion can only reject more, never less.
    topTokenProfitShare: localTop === undefined
      ? provider.topTokenProfitShare
      : Math.max(provider.topTokenProfitShare, localTop),
    topThreeProfitShare: localTopThree === undefined
      ? provider.topThreeProfitShare
      : Math.max(provider.topThreeProfitShare, localTopThree),
    tags: uniqueTags(provider.tags, frozen.tags ?? [])
  };
}

function boundedLimit(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return Math.min(fallback, maximum);
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(maximum, Math.trunc(value)));
}

function uniqueTags(...sets: ReadonlyArray<readonly string[]>): string[] {
  return [...new Set(sets.flat().map((tag) => tag.trim().toLowerCase()).filter(Boolean))].sort();
}

function earlierIso(left: string, right: string): string {
  return Date.parse(left) <= Date.parse(right) ? left : right;
}

function laterIso(left: string, right: string): string {
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

/**
 * Builds the bounded expensive-research queue. `preScreenEligible` is only an
 * admission signal here: this function never creates a WalletScore and never
 * treats a local aggregate as qualification evidence.
 */
export function buildWalletResearchShortlist(
  options: WalletResearchShortlistOptions
): WalletResearchShortlist {
  const totalLimit = boundedLimit(options.totalLimit, 100, 10_000);
  const localLimit = boundedLimit(options.localLimit, DEFAULT_LOCAL_RESEARCH_LIMIT, totalLimit);
  const excluded = new Set(options.excludedWallets ?? []);
  const providers = new Map(
    options.providerCandidates
      .filter((candidate) => !candidate.control && !excluded.has(candidate.address))
      .map((candidate) => [candidate.address, candidate])
  );
  const selected = new Set<string>();
  const candidates: WalletCandidate[] = [];
  const localAddresses: string[] = [];
  const providerAddresses: string[] = [];
  const overlapAddresses: string[] = [];

  const localRecords = [...options.localRecords]
    .filter((record) =>
      record.preScreenEligible &&
      record.deepHistoryStatus === "COMPLETE" &&
      record.structuralEligible === true &&
      !excluded.has(record.wallet)
    )
    .sort((left, right) =>
      right.closedEligibleSwaps - left.closedEligibleSwaps ||
      right.historyDays - left.historyDays ||
      right.activeWeeks - left.activeWeeks ||
      right.medianHoldingMinutes - left.medianHoldingMinutes ||
      right.eligibleSpotSwapCount - left.eligibleSpotSwapCount ||
      right.successfulTransactionCount - left.successfulTransactionCount ||
      left.wallet.localeCompare(right.wallet)
    );

  for (const record of localRecords) {
    if (candidates.length >= totalLimit || localAddresses.length >= localLimit) break;
    if (selected.has(record.wallet)) continue;
    const provider = providers.get(record.wallet);
    const candidate: WalletCandidate = provider
      ? {
          ...provider,
          cohortId: options.cohortId,
          firstSeenAt: earlierIso(provider.firstSeenAt, record.firstSeenAt),
          lastSeenAt: laterIso(provider.lastSeenAt, record.lastSeenAt),
          tags: uniqueTags(provider.tags, record.tags ?? [])
        }
      : {
          address: record.wallet,
          cohortId: options.cohortId,
          firstSeenAt: record.firstSeenAt,
          lastSeenAt: record.lastSeenAt,
          control: false,
          tags: uniqueTags(record.tags ?? [])
        };
    candidates.push(candidate);
    selected.add(record.wallet);
    localAddresses.push(record.wallet);
    if (provider) overlapAddresses.push(record.wallet);
  }

  for (const provider of options.providerCandidates) {
    if (candidates.length >= totalLimit) break;
    if (provider.control || excluded.has(provider.address) || selected.has(provider.address)) continue;
    candidates.push({ ...provider, cohortId: options.cohortId });
    selected.add(provider.address);
    providerAddresses.push(provider.address);
  }

  return { candidates, localAddresses, providerAddresses, overlapAddresses };
}

/**
 * The only scoring seam for the local shortlist. It deliberately requires the
 * same detailed history used by provider-discovered wallets and delegates to
 * the unchanged core qualification policy.
 */
export function scoreWalletResearchCandidate(
  candidate: WalletCandidate,
  history: WalletHistorySummary,
  now: Date = new Date()
): WalletScore {
  return qualifyWallet(candidate, history, now);
}
