import {
  USDC_MINT,
  type DiscoveredWalletSet,
  type IndexedSpotSwap,
  type ProviderHealth,
  type PublicKeyString,
  type WalletCandidate,
  type WalletDiscoveryProvider,
  type WalletIndexRecord,
  type WalletPnlWindow
} from "@copylab/shared";
import type {
  Repository,
  WalletDeepHistoryCohort,
  WalletDeepHistoryEvidence,
  WalletDeepHistoryGeneration
} from "./repository.js";
import { LOCAL_WALLET_IDENTITY_SOURCE } from "./local-wallet-identity.js";

const DAY_MS = 86_400_000;
const MINIMUM_HISTORY_MS = 90 * DAY_MS;
const EPSILON = 1e-9;

export const LOCAL_WALLET_DISCOVERY_LIMITATIONS = Object.freeze([
  "Only wallets in the newest durably COMPLETE point-in-time deep-history generation are considered.",
  "Every ranked wallet shares the same frozen 30-day and 90-day cutoff.",
  "Only normalized eligible spot swaps already stored in SQLite are included.",
  "FIFO inventory begins at the 90-day snapshot boundary; any sell requiring older opening inventory rejects the wallet.",
  "Every included swap must have a deterministic USD value and the deep-history hydration ledger must be complete.",
  "Every ranked wallet must have a terminal provider-independent on-chain identity result; UNKNOWN wallets fail closed.",
  "Realized PnL is gross of network fees, rent, priority fees, and external protocol costs because the index does not populate them consistently.",
  "Unrealized PnL is marked to the last locally observed trade price, not an executable quote.",
  "The bounded local cohort is not a market-wide ranking and this provider performs discovery only, not wallet qualification or token-safety approval."
]);

export interface LocalWalletDiscoveryOptions {
  winnerLimit?: number;
  controlLimit?: number;
  /** Immutable coordinator capture only; OPEN or partial generations fail closed. */
  generationId?: string;
}

interface LocalWalletPnl {
  record: WalletIndexRecord;
  pnl30d: WalletPnlWindow;
  pnl90d: WalletPnlWindow;
}

interface Lot {
  quantity: number;
  costUsd: number;
  openedAt: number;
}

interface RealizedExit {
  at: number;
  costUsd: number;
  pnlUsd: number;
}

export class LocalWalletDiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalWalletDiscoveryError";
  }
}

function boundedLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(10_000, Math.trunc(value)));
}

function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function targetQuantity(swap: IndexedSpotSwap): number {
  const quantity = swap.side === "BUY" ? swap.outputAmountUi : swap.inputAmountUi;
  if (!finitePositive(quantity)) {
    throw new LocalWalletDiscoveryError(`Swap ${swap.id} has an invalid target quantity.`);
  }
  return quantity;
}

function swapValueUsd(swap: IndexedSpotSwap, quantity: number): number {
  const directUsdc = swap.baseMint === USDC_MINT
    ? swap.side === "BUY" ? swap.inputAmountUi : swap.outputAmountUi
    : undefined;
  const value = directUsdc ?? (
    swap.priceUsd !== undefined && finitePositive(swap.priceUsd)
      ? swap.priceUsd * quantity
      : undefined
  );
  if (value === undefined || !finitePositive(value)) {
    throw new LocalWalletDiscoveryError(`Swap ${swap.id} has no complete USD pricing evidence.`);
  }
  return value;
}

function compareSwaps(left: IndexedSpotSwap, right: IndexedSpotSwap): number {
  return Date.parse(left.blockTime) - Date.parse(right.blockTime)
    || left.slot - right.slot
    || left.signature.localeCompare(right.signature)
    || left.swapIndex - right.swapIndex
    || left.id.localeCompare(right.id);
}

function windowPnl(
  duration: "30d" | "90d",
  cutoff: number,
  exits: readonly RealizedExit[],
  lots: ReadonlyMap<string, readonly Lot[]>,
  lastPrices: ReadonlyMap<string, number>
): WalletPnlWindow {
  const included = exits.filter((exit) => exit.at >= cutoff);
  const realizedProfitUsd = included.reduce((sum, exit) => sum + exit.pnlUsd, 0);
  const realizedCostUsd = included.reduce((sum, exit) => sum + exit.costUsd, 0);
  let unrealizedProfitUsd = 0;
  for (const [mint, mintLots] of lots) {
    const lastPrice = lastPrices.get(mint);
    if (lastPrice === undefined || !finitePositive(lastPrice)) {
      throw new LocalWalletDiscoveryError(`Open ${mint} inventory has no local mark price.`);
    }
    for (const lot of mintLots) {
      // Mirrors duration_only semantics: an older still-open lot does not enter
      // a shorter window's unrealized result.
      if (lot.openedAt < cutoff) continue;
      unrealizedProfitUsd += lot.quantity * lastPrice - lot.costUsd;
    }
  }
  return {
    duration,
    realizedProfitUsd,
    realizedProfitPercent: realizedCostUsd > 0 ? realizedProfitUsd / realizedCostUsd * 100 : 0,
    unrealizedProfitUsd,
    totalTrades: included.length,
    wins: included.filter((exit) => exit.pnlUsd > EPSILON).length,
    losses: included.filter((exit) => exit.pnlUsd < -EPSILON).length
  };
}

function calculatePnlWindows(
  wallet: PublicKeyString,
  swaps: readonly IndexedSpotSwap[],
  cohort: WalletDeepHistoryCohort
): Pick<LocalWalletPnl, "pnl30d" | "pnl90d"> {
  const windowStart = Date.parse(cohort.windowStart);
  const windowEnd = Date.parse(cohort.windowEnd);
  const ordered = [...swaps].sort(compareSwaps);
  const lots = new Map<string, Lot[]>();
  const lastPrices = new Map<string, number>();
  const exits: RealizedExit[] = [];

  for (const swap of ordered) {
    const at = Date.parse(swap.blockTime);
    if (
      swap.wallet !== wallet ||
      !swap.eligible ||
      !Number.isFinite(at) ||
      at < windowStart ||
      at > windowEnd
    ) {
      throw new LocalWalletDiscoveryError(`Wallet ${wallet} contains inconsistent indexed swap evidence.`);
    }
    const quantity = targetQuantity(swap);
    const valueUsd = swapValueUsd(swap, quantity);
    const unitPrice = valueUsd / quantity;
    lastPrices.set(swap.targetMint, unitPrice);
    if (swap.side === "BUY") {
      const mintLots = lots.get(swap.targetMint) ?? [];
      mintLots.push({ quantity, costUsd: valueUsd, openedAt: at });
      lots.set(swap.targetMint, mintLots);
      continue;
    }

    const mintLots = lots.get(swap.targetMint) ?? [];
    let remaining = quantity;
    let matchedCost = 0;
    while (remaining > EPSILON && mintLots.length > 0) {
      const lot = mintLots[0];
      if (!lot) break;
      const matched = Math.min(remaining, lot.quantity);
      const matchedCostForLot = lot.costUsd * (matched / lot.quantity);
      matchedCost += matchedCostForLot;
      lot.quantity -= matched;
      lot.costUsd -= matchedCostForLot;
      remaining -= matched;
      if (lot.quantity <= EPSILON) mintLots.shift();
    }
    if (remaining > EPSILON) {
      throw new LocalWalletDiscoveryError(
        `Wallet ${wallet} has a sell that requires inventory from before the frozen history window.`
      );
    }
    exits.push({ at, costUsd: matchedCost, pnlUsd: valueUsd - matchedCost });
  }

  if (exits.length === 0) {
    throw new LocalWalletDiscoveryError(`Wallet ${wallet} has no fully matched realized exits.`);
  }
  return {
    pnl30d: windowPnl("30d", windowEnd - 30 * DAY_MS, exits, lots, lastPrices),
    pnl90d: windowPnl("90d", windowEnd - 90 * DAY_MS, exits, lots, lastPrices)
  };
}

function sameInstant(left: string | undefined, right: string): boolean {
  return left !== undefined && Date.parse(left) === Date.parse(right);
}

function assertCompleteRecord(record: WalletIndexRecord, cohort: WalletDeepHistoryCohort): void {
  if (
    !record.preScreenEligible ||
    record.deepHistoryStatus !== "COMPLETE" ||
    !sameInstant(record.deepHistoryWindowStart, cohort.windowStart) ||
    !sameInstant(record.deepHistoryWindowEnd, cohort.windowEnd) ||
    record.profitPricingCoverage !== "COMPLETE" ||
    record.deepHistorySignatureCount === undefined ||
    record.deepHistoryHydratedCount === undefined ||
    !Number.isSafeInteger(record.deepHistorySignatureCount) ||
    !Number.isSafeInteger(record.deepHistoryHydratedCount) ||
    record.deepHistorySignatureCount < 1 ||
    record.deepHistoryHydratedCount !== record.deepHistorySignatureCount ||
    (record.walletIdentityStatus !== "VERIFIED" && record.walletIdentityStatus !== "REJECTED") ||
    record.walletIdentitySource !== LOCAL_WALLET_IDENTITY_SOURCE
  ) {
    throw new LocalWalletDiscoveryError(
      `Wallet ${record.wallet} does not have complete frozen history and pricing evidence.`
    );
  }
}

function descendingPnl(
  selector: (entry: LocalWalletPnl) => WalletPnlWindow
): (left: LocalWalletPnl, right: LocalWalletPnl) => number {
  return (left, right) => {
    const leftPnl = selector(left);
    const rightPnl = selector(right);
    return rightPnl.realizedProfitUsd - leftPnl.realizedProfitUsd
      || rightPnl.realizedProfitPercent - leftPnl.realizedProfitPercent
      || rightPnl.totalTrades - leftPnl.totalTrades
      || left.record.wallet.localeCompare(right.record.wallet);
  };
}

function ascendingPnl(
  selector: (entry: LocalWalletPnl) => WalletPnlWindow
): (left: LocalWalletPnl, right: LocalWalletPnl) => number {
  return (left, right) => {
    const leftPnl = selector(left);
    const rightPnl = selector(right);
    return leftPnl.realizedProfitUsd - rightPnl.realizedProfitUsd
      || leftPnl.realizedProfitPercent - rightPnl.realizedProfitPercent
      || rightPnl.totalTrades - leftPnl.totalTrades
      || left.record.wallet.localeCompare(right.record.wallet);
  };
}

/**
 * A no-network discovery seam over CopyLab's frozen SQLite evidence.
 *
 * The provider deliberately refuses partial history, unpriced swaps, unmatched
 * opening inventory, and wallets outside the selected completed deep-history
 * generation. See `LOCAL_WALLET_DISCOVERY_LIMITATIONS` before integrating it as a
 * replacement for a market-wide provider.
 */
export class LocalWalletDiscoveryProvider implements WalletDiscoveryProvider {
  private readonly winnerLimit: number;
  private readonly controlLimit: number;
  private readonly generationId: string | undefined;

  constructor(
    private readonly repository: Repository,
    options: LocalWalletDiscoveryOptions = {}
  ) {
    this.winnerLimit = boundedLimit(options.winnerLimit, 100);
    this.controlLimit = boundedLimit(options.controlLimit, 20);
    this.generationId = options.generationId?.trim() || undefined;
  }

  async discoverCohort(now = new Date()): Promise<DiscoveredWalletSet> {
    const frozen = this.completeGeneration(now);
    const scoredByWallet = new Map<string, LocalWalletPnl>();
    for (const evidence of frozen.evidence) {
      const cohort = frozen.cohorts.get(evidence.cohortId);
      if (!cohort) throw new LocalWalletDiscoveryError(`Frozen evidence ${evidence.wallet} lost its cohort.`);
      try {
        scoredByWallet.set(evidence.wallet, this.calculateWallet(evidence, cohort));
      } catch (error) {
        if (!(error instanceof LocalWalletDiscoveryError)) throw error;
      }
    }
    const scored = [...scoredByWallet.values()];
    const by30 = [...scored].sort(descendingPnl((entry) => entry.pnl30d));
    const by90 = [...scored].sort(descendingPnl((entry) => entry.pnl90d));
    const rank30 = new Map(by30.map((entry, index) => [entry.record.wallet, index + 1]));
    const rank90 = new Map(by90.map((entry, index) => [entry.record.wallet, index + 1]));
    const selected = new Map<string, WalletCandidate>();
    const localCohortId = `local:${frozen.generation.id}`;

    const addWinner = (entry: LocalWalletPnl, duration: "30d" | "90d"): void => {
      const prior = selected.get(entry.record.wallet);
      const candidate = prior ?? this.candidate(entry, localCohortId, false);
      const rank = duration === "30d"
        ? rank30.get(entry.record.wallet)
        : rank90.get(entry.record.wallet);
      if (rank !== undefined) {
        if (duration === "30d") candidate.sourceRank30d = rank;
        else candidate.sourceRank90d = rank;
      }
      candidate.control = false;
      selected.set(entry.record.wallet, candidate);
    };
    by30
      .filter((entry) => entry.pnl30d.realizedProfitUsd > 0)
      .slice(0, this.winnerLimit)
      .forEach((entry) => addWinner(entry, "30d"));
    by90
      .filter((entry) => entry.pnl90d.realizedProfitUsd > 0)
      .slice(0, this.winnerLimit)
      .forEach((entry) => addWinner(entry, "90d"));

    const controls = scored.filter(
      (entry) => entry.pnl30d.realizedProfitUsd < 0 && entry.pnl90d.realizedProfitUsd < 0
    );
    const control30 = [...controls].sort(ascendingPnl((entry) => entry.pnl30d));
    const control90 = [...controls].sort(ascendingPnl((entry) => entry.pnl90d));
    for (const entry of [
      ...control30.slice(0, this.controlLimit),
      ...control90.slice(0, this.controlLimit)
    ]) {
      if (!selected.has(entry.record.wallet)) {
        selected.set(entry.record.wallet, this.candidate(entry, localCohortId, true));
      }
    }

    const candidates = [...selected.values()].sort((left, right) =>
      Number(left.control) - Number(right.control)
      || Math.min(left.sourceRank30d ?? Number.MAX_SAFE_INTEGER, left.sourceRank90d ?? Number.MAX_SAFE_INTEGER)
        - Math.min(right.sourceRank30d ?? Number.MAX_SAFE_INTEGER, right.sourceRank90d ?? Number.MAX_SAFE_INTEGER)
      || left.address.localeCompare(right.address)
    );
    return { cohortId: localCohortId, generatedAt: now.toISOString(), candidates };
  }

  async getPnl(
    address: PublicKeyString,
    duration: "30d" | "90d"
  ): Promise<WalletPnlWindow> {
    const frozen = this.completeGeneration();
    const evidence = frozen.evidence.find((candidate) => candidate.wallet === address);
    if (!evidence) throw new LocalWalletDiscoveryError(`Wallet ${address} is outside the newest completed generation.`);
    const cohort = frozen.cohorts.get(evidence.cohortId);
    if (!cohort) throw new LocalWalletDiscoveryError(`Frozen evidence ${address} lost its cohort.`);
    const calculated = this.calculateWallet(evidence, cohort);
    return duration === "30d" ? calculated.pnl30d : calculated.pnl90d;
  }

  async checkHealth(now = new Date()): Promise<ProviderHealth> {
    const startedAt = Date.now();
    try {
      const frozen = this.completeGeneration(now);
      return {
        provider: "birdeye",
        ok: true,
        checkedAt: now.toISOString(),
        latencyMs: Math.max(0, Date.now() - startedAt),
        message: `Local wallet discovery is ready from generation ${frozen.generation.sequence} covering ${frozen.evidence.length} frozen wallet(s)`,
        usage: { requests: 0, window: "unknown" }
      };
    } catch (error) {
      return {
        provider: "birdeye",
        ok: false,
        checkedAt: now.toISOString(),
        latencyMs: Math.max(0, Date.now() - startedAt),
        message: error instanceof Error ? error.message : "Local wallet discovery is unavailable",
        usage: { requests: 0, window: "unknown" }
      };
    }
  }

  private completeGeneration(now = new Date()): {
    generation: WalletDeepHistoryGeneration;
    cohorts: Map<string, WalletDeepHistoryCohort>;
    evidence: WalletDeepHistoryEvidence[];
  } {
    const generation = this.generationId
      ? this.repository.getWalletDeepHistoryGeneration(this.generationId)
      : this.repository.latestCompleteWalletDeepHistoryGeneration();
    if (!generation) throw new LocalWalletDiscoveryError("No completed local deep-history generation is available.");
    if (generation.status !== "COMPLETE") {
      throw new LocalWalletDiscoveryError(`Local deep-history generation ${generation.id} is not COMPLETE.`);
    }
    const start = Date.parse(generation.windowStart);
    const end = Date.parse(generation.windowEnd);
    if (
      !Number.isFinite(start) || !Number.isFinite(end) ||
      end - start < MINIMUM_HISTORY_MS || end > now.getTime()
    ) {
      throw new LocalWalletDiscoveryError(
        `Local deep-history generation ${generation.id} has incomplete 90-day coverage.`
      );
    }
    const cohortList = this.repository.listWalletDeepHistoryCohortsForGeneration(generation.id);
    if (cohortList.length === 0 || cohortList.some((cohort) => cohort.status !== "COMPLETE")) {
      throw new LocalWalletDiscoveryError(`Completed generation ${generation.id} has a partial cohort.`);
    }
    const expectedWallets = new Set(cohortList.flatMap((cohort) => cohort.wallets));
    const evidence = this.repository.listWalletDeepHistoryEvidence(generation.id);
    if (evidence.length !== expectedWallets.size || evidence.some((row) => !expectedWallets.has(row.wallet))) {
      throw new LocalWalletDiscoveryError(`Completed generation ${generation.id} has incomplete frozen evidence.`);
    }
    return {
      generation,
      cohorts: new Map(cohortList.map((cohort) => [cohort.id, cohort])),
      evidence
    };
  }

  private calculateWallet(evidence: WalletDeepHistoryEvidence, cohort: WalletDeepHistoryCohort): LocalWalletPnl {
    const wallet = evidence.wallet;
    if (evidence.generationId !== cohort.generationId || !cohort.wallets.includes(wallet)) {
      throw new LocalWalletDiscoveryError(`Wallet ${wallet} is outside its frozen generation cohort.`);
    }
    const record = evidence.record;
    assertCompleteRecord(record, cohort);
    const windows = calculatePnlWindows(wallet, evidence.swaps, cohort);
    return { record, ...windows };
  }

  private candidate(
    entry: LocalWalletPnl,
    cohortId: string,
    control: boolean
  ): WalletCandidate {
    return {
      address: entry.record.wallet,
      cohortId,
      firstSeenAt: entry.record.firstSeenAt,
      lastSeenAt: entry.record.lastSeenAt,
      control,
      tags: [...new Set((entry.record.tags ?? []).map((tag) => tag.trim().toLowerCase()).filter(Boolean))].sort(),
      pnl30d: entry.pnl30d,
      pnl90d: entry.pnl90d
    };
  }
}
