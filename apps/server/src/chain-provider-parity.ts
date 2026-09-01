import type {
  LeaderSwap,
  ProviderHealth,
  PublicKeyString,
  Unsubscribe,
  WalletHistorySummary
} from "@copylab/shared";
import { redactSensitiveText } from "@copylab/providers";
import type { ProviderParityObservation, ProviderParitySink } from "./provider-parity.js";
import type { RuntimeChainProvider, RuntimeStreamStatus } from "./runtime-chain-provider.js";
import { parityDigest } from "./provider-parity-proof.js";

interface PendingSignal {
  swap: LeaderSwap;
  timer: ReturnType<typeof setTimeout>;
}

export interface ShadowChainProviderOptions {
  matchTimeoutMs?: number;
  now?: () => Date;
  onError?: (error: Error) => void;
}

function errorText(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error), 1_000);
}

function signalKey(swap: LeaderSwap): string {
  return `${swap.sourceWallet}:${swap.sourceSignature}:${swap.side}:${swap.targetMint}`;
}

function absolute(left: number, right: number): number {
  return Math.abs(left - right);
}

export function compareLeaderSwap(
  primary: LeaderSwap,
  shadow: LeaderSwap,
  capability: "CHAIN_GAP" | "CHAIN_LIVE",
  observedAt: string
): ProviderParityObservation {
  const metrics = {
    slotDifference: absolute(primary.slot, shadow.slot),
    blockTimeDifferenceMs: absolute(Date.parse(primary.blockTime), Date.parse(shadow.blockTime)),
    baseAmountUiDifference: absolute(primary.baseAmountUi, shadow.baseAmountUi),
    targetAmountUiDifference: absolute(primary.targetAmountUi, shadow.targetAmountUi),
    leaderPriceUsdDifference: absolute(primary.leaderPriceUsd, shadow.leaderPriceUsd)
  };
  const reasons: string[] = [];
  if (primary.sourceWallet !== shadow.sourceWallet) reasons.push("source wallet differs");
  if (primary.sourceSignature !== shadow.sourceSignature) reasons.push("source signature differs");
  if (primary.side !== shadow.side) reasons.push("side differs");
  if (primary.baseMint !== shadow.baseMint) reasons.push("base mint differs");
  if (primary.targetMint !== shadow.targetMint) reasons.push("target mint differs");
  if (primary.baseAmountAtomic !== shadow.baseAmountAtomic) reasons.push("base amount differs");
  if (primary.targetAmountAtomic !== shadow.targetAmountAtomic) reasons.push("target amount differs");
  if (metrics.slotDifference !== 0) reasons.push("slot differs");
  if (metrics.blockTimeDifferenceMs !== 0) reasons.push("block time differs");
  if (metrics.leaderPriceUsdDifference > 0.01) reasons.push("leader USD price differs");
  return {
    capability,
    subject: signalKey(primary),
    observedAt,
    status: reasons.length === 0 ? "MATCH" : "DIVERGENT",
    metrics,
    reasons,
    primary,
    shadow
  };
}

export function compareHistory(
  primary: WalletHistorySummary,
  shadow: WalletHistorySummary,
  observedAt: string,
  days = 90
): ProviderParityObservation {
  const primaryTags = new Set(primary.tags);
  const shadowTags = new Set(shadow.tags);
  const tagDifference = [...primaryTags].filter((tag) => !shadowTags.has(tag)).length
    + [...shadowTags].filter((tag) => !primaryTags.has(tag)).length;
  const metrics = {
    historyDaysDifference: absolute(primary.historyDays, shadow.historyDays),
    closedEligibleSwapsDifference: absolute(primary.closedEligibleSwaps, shadow.closedEligibleSwaps),
    activeWeeksDifference: absolute(primary.activeWeeks, shadow.activeWeeks),
    medianHoldingMinutesDifference: absolute(primary.medianHoldingMinutes, shadow.medianHoldingMinutes),
    topTokenProfitShareDifference: absolute(primary.topTokenProfitShare, shadow.topTokenProfitShare),
    topThreeProfitShareDifference: absolute(primary.topThreeProfitShare, shadow.topThreeProfitShare),
    tagDifference
  };
  const reasons: string[] = [];
  for (const [key, value] of Object.entries(metrics)) {
    if (value !== 0) reasons.push(`${key} differs`);
  }
  return {
    capability: "CHAIN_HISTORY",
    subject: primary.wallet,
    observedAt,
    status: primary.wallet === shadow.wallet && reasons.length === 0 ? "MATCH" : "DIVERGENT",
    metrics,
    reasons: primary.wallet === shadow.wallet ? reasons : ["wallet differs", ...reasons],
    primary,
    shadow,
    evidence: {
      days: String(days),
      asOfAt: observedAt
    }
  };
}

export function compareGapResults(
  wallet: string,
  primary: readonly LeaderSwap[],
  shadow: readonly LeaderSwap[],
  observedAt: string,
  sinceAt: string,
  cutoffAt = observedAt
): ProviderParityObservation {
  const primaryByKey = new Map(primary.map((swap) => [signalKey(swap), swap]));
  const shadowByKey = new Map(shadow.map((swap) => [signalKey(swap), swap]));
  const overlap = [...primaryByKey.keys()].filter((key) => shadowByKey.has(key));
  const payloadMismatches = overlap.filter((key) => {
    const left = primaryByKey.get(key);
    const right = shadowByKey.get(key);
    return !left || !right || compareLeaderSwap(left, right, "CHAIN_GAP", observedAt).status !== "MATCH";
  }).length;
  const metrics = {
    primarySignals: primaryByKey.size,
    shadowSignals: shadowByKey.size,
    overlapSignals: overlap.length,
    primaryOnlySignals: primaryByKey.size - overlap.length,
    shadowOnlySignals: shadowByKey.size - overlap.length,
    payloadMismatches
  };
  const reasons: string[] = [];
  const primarySignatures = [...new Set(primary.map((swap) => swap.sourceSignature))].sort();
  const shadowSignatures = [...new Set(shadow.map((swap) => swap.sourceSignature))].sort();
  if (primarySignatures.length === 0 || shadowSignatures.length === 0) {
    reasons.push("gap replay has no non-empty signature coverage");
  }
  if (metrics.primaryOnlySignals > 0) reasons.push("self-hosted gap repair missed managed signals");
  if (metrics.shadowOnlySignals > 0) reasons.push("self-hosted gap repair found signals missing from managed results");
  if (payloadMismatches > 0) reasons.push("gap-repair signal payloads differ");
  return {
    capability: "CHAIN_GAP",
    subject: wallet,
    observedAt,
    status: reasons.length === 0 ? "MATCH" : "DIVERGENT",
    metrics,
    reasons,
    primary,
    shadow,
    evidence: {
      sinceAt,
      cutoffAt,
      primarySignatures,
      shadowSignatures,
      primarySignatureDigest: parityDigest(primarySignatures),
      shadowSignatureDigest: parityDigest(shadowSignatures)
    }
  };
}

export class ShadowChainProvider implements RuntimeChainProvider {
  private readonly matchTimeoutMs: number;
  private readonly now: () => Date;
  private readonly onError: (error: Error) => void;
  private readonly primaryPending = new Map<string, PendingSignal>();
  private readonly shadowPending = new Map<string, PendingSignal>();

  constructor(
    private readonly primary: RuntimeChainProvider,
    private readonly shadow: RuntimeChainProvider,
    private readonly sink: ProviderParitySink,
    options: ShadowChainProviderOptions = {}
  ) {
    this.matchTimeoutMs = options.matchTimeoutMs ?? 30_000;
    if (!Number.isFinite(this.matchTimeoutMs) || this.matchTimeoutMs < 1) {
      throw new RangeError("Shadow chain match timeout must be positive.");
    }
    this.now = options.now ?? (() => new Date());
    this.onError = options.onError ?? (() => undefined);
  }

  async checkHealth(): Promise<ProviderHealth> {
    const primary = await this.primary.checkHealth();
    const observedAt = this.now().toISOString();
    try {
      const shadow = await this.shadow.checkHealth();
      const bothHealthy = primary.ok && shadow.ok;
      const reasons = [
        ...(!primary.ok ? ["managed chain is unhealthy"] : []),
        ...(!shadow.ok ? ["self-hosted chain is unhealthy"] : [])
      ];
      await this.sink.record({
        capability: "CHAIN_HEALTH",
        subject: "chain",
        observedAt,
        status: bothHealthy ? "MATCH" : "DIVERGENT",
        metrics: { latencyDifferenceMs: absolute(primary.latencyMs ?? 0, shadow.latencyMs ?? 0) },
        reasons,
        primary,
        shadow
      });
    } catch (error) {
      await this.unavailable("CHAIN_HEALTH", "chain", primary, error, observedAt);
    }
    return primary;
  }

  async summarizeHistory(address: PublicKeyString, days: number): Promise<WalletHistorySummary> {
    const primary = await this.primary.summarizeHistory(address, days);
    const observedAt = this.now().toISOString();
    try {
      const shadow = await this.shadow.summarizeHistory(address, days);
      await this.sink.record(compareHistory(primary, shadow, observedAt, days));
    } catch (error) {
      await this.unavailable("CHAIN_HISTORY", address, primary, error, observedAt);
    }
    return primary;
  }

  async repairGap(address: PublicKeyString, since: string): Promise<LeaderSwap[]> {
    const primary = await this.primary.repairGap(address, since);
    const observedAt = this.now().toISOString();
    try {
      const shadow = await this.shadow.repairGap(address, since);
      await this.sink.record(compareGapResults(address, primary, shadow, observedAt, since, observedAt));
    } catch (error) {
      await this.unavailable("CHAIN_GAP", address, primary, error, observedAt);
    }
    return primary;
  }

  async subscribe(
    addresses: PublicKeyString[],
    onSwap: (swap: LeaderSwap) => Promise<void>
  ): Promise<Unsubscribe> {
    const primaryUnsubscribe = await this.primary.subscribe(addresses, async (swap) => {
      await this.receivePrimary(swap);
      await onSwap(swap);
    });
    let shadowUnsubscribe: Unsubscribe | undefined;
    try {
      shadowUnsubscribe = await this.shadow.subscribe(addresses, async (swap) => this.receiveShadow(swap));
    } catch (error) {
      await this.unavailable(
        "CHAIN_LIVE",
        addresses.join(","),
        { addresses },
        error,
        this.now().toISOString()
      );
    }
    return async () => {
      this.clearPending();
      await shadowUnsubscribe?.();
      await primaryUnsubscribe();
    };
  }

  getStreamStatus(): RuntimeStreamStatus {
    return this.primary.getStreamStatus();
  }

  getStreamHealth(maximumSilenceMs = 60_000): ProviderHealth & RuntimeStreamStatus {
    return this.primary.getStreamHealth(maximumSilenceMs);
  }

  private async receivePrimary(swap: LeaderSwap): Promise<void> {
    const key = signalKey(swap);
    const shadow = this.shadowPending.get(key);
    if (shadow) {
      clearTimeout(shadow.timer);
      this.shadowPending.delete(key);
      await this.sink.record(compareLeaderSwap(swap, shadow.swap, "CHAIN_LIVE", this.now().toISOString()));
      return;
    }
    if (this.primaryPending.has(key)) return;
    await this.sink.record({
      capability: "CHAIN_LIVE",
      subject: key,
      observedAt: this.now().toISOString(),
      status: "PENDING",
      metrics: {},
      reasons: ["awaiting self-hosted signal"],
      primary: swap
    });
    const timer = setTimeout(() => {
      this.primaryPending.delete(key);
      void Promise.resolve(this.sink.record({
        capability: "CHAIN_LIVE",
        subject: key,
        observedAt: this.now().toISOString(),
        status: "DIVERGENT",
        metrics: { primaryOnlySignals: 1 },
        reasons: ["self-hosted stream missed managed signal within the match window"],
        primary: swap
      })).catch((error) => this.onError(error instanceof Error ? error : new Error(String(error))));
    }, this.matchTimeoutMs);
    this.primaryPending.set(key, { swap, timer });
  }

  private async receiveShadow(swap: LeaderSwap): Promise<void> {
    const key = signalKey(swap);
    const primary = this.primaryPending.get(key);
    if (primary) {
      clearTimeout(primary.timer);
      this.primaryPending.delete(key);
      await this.sink.record(compareLeaderSwap(primary.swap, swap, "CHAIN_LIVE", this.now().toISOString()));
      return;
    }
    if (this.shadowPending.has(key)) return;
    const timer = setTimeout(() => {
      this.shadowPending.delete(key);
      void Promise.resolve(this.sink.record({
        capability: "CHAIN_LIVE",
        subject: key,
        observedAt: this.now().toISOString(),
        status: "DIVERGENT",
        metrics: { shadowOnlySignals: 1 },
        reasons: ["self-hosted stream found a signal absent from the managed stream within the match window"],
        shadow: swap,
        primary: null
      })).catch((error) => this.onError(error instanceof Error ? error : new Error(String(error))));
    }, this.matchTimeoutMs);
    this.shadowPending.set(key, { swap, timer });
  }

  private async unavailable(
    capability: ProviderParityObservation["capability"],
    subject: string,
    primary: unknown,
    error: unknown,
    observedAt: string
  ): Promise<void> {
    await this.sink.record({
      capability,
      subject,
      observedAt,
      status: "SHADOW_UNAVAILABLE",
      metrics: {},
      reasons: [errorText(error)],
      primary
    });
  }

  private clearPending(): void {
    for (const pending of [...this.primaryPending.values(), ...this.shadowPending.values()]) {
      clearTimeout(pending.timer);
    }
    this.primaryPending.clear();
    this.shadowPending.clear();
  }
}
