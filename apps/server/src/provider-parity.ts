import type {
  DiscoveredWalletSet,
  ProviderHealth,
  PublicKeyString,
  WalletDiscoveryProvider,
  WalletPnlWindow
} from "@copylab/shared";
import { redactSensitiveText } from "@copylab/providers";
import {
  providerParityDiscoveryEvidence,
  type ProviderParityProofBinding
} from "./provider-parity-proof.js";

export interface HealthCheckedWalletDiscoveryProvider extends WalletDiscoveryProvider {
  checkHealth(): Promise<ProviderHealth>;
}

export type ProviderParityCapability =
  | "WALLET_DISCOVERY"
  | "WALLET_PNL_30D"
  | "WALLET_PNL_90D"
  | "CHAIN_HEALTH"
  | "CHAIN_HISTORY"
  | "CHAIN_GAP"
  | "CHAIN_LIVE";
export type ProviderParityStatus = "PENDING" | "MATCH" | "DIVERGENT" | "SHADOW_UNAVAILABLE";

export interface ProviderParityObservation {
  capability: ProviderParityCapability;
  subject: string;
  observedAt: string;
  status: ProviderParityStatus;
  metrics: Record<string, number>;
  reasons: string[];
  primary: unknown;
  shadow?: unknown;
  /** Deterministic, non-secret evidence used by the frozen replay coordinator. */
  evidence?: Record<string, string | string[]>;
  /** Present only when a durable proof epoch validated and accepted the observation. */
  proof?: ProviderParityProofBinding;
}

export interface ProviderParitySink {
  record(observation: ProviderParityObservation): Promise<void> | void;
}

export interface WalletPnlParityTolerance {
  usd: number;
  percent: number;
}

const DEFAULT_PNL_TOLERANCE: Readonly<WalletPnlParityTolerance> = Object.freeze({
  usd: 0.01,
  percent: 0.01
});

function errorText(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error), 1_000);
}

function difference(left: number, right: number): number {
  return Math.abs(left - right);
}

export function compareWalletPnl(
  wallet: string,
  primary: WalletPnlWindow,
  shadow: WalletPnlWindow,
  observedAt: string,
  tolerance: Readonly<WalletPnlParityTolerance> = DEFAULT_PNL_TOLERANCE
): ProviderParityObservation {
  const metrics = {
    realizedProfitUsdDifference: difference(primary.realizedProfitUsd, shadow.realizedProfitUsd),
    realizedProfitPercentDifference: difference(primary.realizedProfitPercent, shadow.realizedProfitPercent),
    unrealizedProfitUsdDifference: difference(primary.unrealizedProfitUsd, shadow.unrealizedProfitUsd),
    totalTradesDifference: difference(primary.totalTrades, shadow.totalTrades),
    winsDifference: difference(primary.wins, shadow.wins),
    lossesDifference: difference(primary.losses, shadow.losses)
  };
  const reasons: string[] = [];
  if (primary.duration !== shadow.duration) reasons.push("duration differs");
  if (metrics.realizedProfitUsdDifference > tolerance.usd) reasons.push("realized USD PnL differs");
  if (metrics.realizedProfitPercentDifference > tolerance.percent) reasons.push("realized PnL percent differs");
  if (metrics.unrealizedProfitUsdDifference > tolerance.usd) reasons.push("unrealized USD PnL differs");
  if (metrics.totalTradesDifference !== 0) reasons.push("completed trade count differs");
  if (metrics.winsDifference !== 0) reasons.push("win count differs");
  if (metrics.lossesDifference !== 0) reasons.push("loss count differs");
  return {
    capability: primary.duration === "30d" ? "WALLET_PNL_30D" : "WALLET_PNL_90D",
    subject: wallet,
    observedAt,
    status: reasons.length === 0 ? "MATCH" : "DIVERGENT",
    metrics,
    reasons,
    primary,
    shadow,
    evidence: {
      duration: primary.duration,
      asOfAt: observedAt
    }
  };
}

export function compareWalletDiscovery(
  primary: DiscoveredWalletSet,
  shadow: DiscoveredWalletSet,
  observedAt: string
): ProviderParityObservation {
  const primaryByAddress = new Map(primary.candidates.map((candidate) => [candidate.address, candidate]));
  const shadowByAddress = new Map(shadow.candidates.map((candidate) => [candidate.address, candidate]));
  const overlap = [...primaryByAddress.keys()].filter((address) => shadowByAddress.has(address));
  const controlMismatch = overlap.filter(
    (address) => primaryByAddress.get(address)?.control !== shadowByAddress.get(address)?.control
  ).length;
  const rank30dMismatch = overlap.filter(
    (address) => primaryByAddress.get(address)?.sourceRank30d !== shadowByAddress.get(address)?.sourceRank30d
  ).length;
  const rank90dMismatch = overlap.filter(
    (address) => primaryByAddress.get(address)?.sourceRank90d !== shadowByAddress.get(address)?.sourceRank90d
  ).length;
  const universeEvidence = providerParityDiscoveryEvidence(primary, shadow);
  const metrics = {
    primaryCandidates: primaryByAddress.size,
    shadowCandidates: shadowByAddress.size,
    overlapCandidates: overlap.length,
    primaryOnlyCandidates: primaryByAddress.size - overlap.length,
    shadowOnlyCandidates: shadowByAddress.size - overlap.length,
    controlMismatch,
    rank30dMismatch,
    rank90dMismatch
  };
  const reasons: string[] = [];
  // The providers intentionally rank different market universes: Birdeye's
  // point-in-time global list versus the locally retained, fully hydrated
  // index. Universe-only candidates are coverage metrics, not a semantic
  // failure. Shared wallets must exist and their winner/control lane must
  // agree before discovery can count as matching evidence.
  if (overlap.length === 0) reasons.push("managed and local discovery have no shared wallets");
  if (controlMismatch !== 0) reasons.push("winner/control classification differs");
  if (rank30dMismatch !== 0) reasons.push("shared 30-day ranks differ");
  if (rank90dMismatch !== 0) reasons.push("shared 90-day ranks differ");
  return {
    capability: "WALLET_DISCOVERY",
    subject: `${primary.cohortId}|${shadow.cohortId}`,
    observedAt,
    status: reasons.length === 0 ? "MATCH" : "DIVERGENT",
    metrics,
    reasons,
    primary,
    shadow,
    evidence: {
      primaryGeneratedAt: primary.generatedAt,
      shadowGeneratedAt: shadow.generatedAt,
      ...universeEvidence
    }
  };
}

export class ShadowWalletDiscoveryProvider implements HealthCheckedWalletDiscoveryProvider {
  constructor(
    private readonly primary: HealthCheckedWalletDiscoveryProvider,
    private readonly shadow: WalletDiscoveryProvider,
    private readonly sink: ProviderParitySink,
    private readonly now: () => Date = () => new Date()
  ) {}

  checkHealth(): Promise<ProviderHealth> {
    return this.primary.checkHealth();
  }

  async discoverCohort(now = this.now()): Promise<DiscoveredWalletSet> {
    const primary = await this.primary.discoverCohort(now);
    const observedAt = this.now().toISOString();
    try {
      const shadow = await this.shadow.discoverCohort(now);
      await this.sink.record(compareWalletDiscovery(primary, shadow, observedAt));
    } catch (error) {
      await this.sink.record({
        capability: "WALLET_DISCOVERY",
        subject: primary.cohortId,
        observedAt,
        status: "SHADOW_UNAVAILABLE",
        metrics: {},
        reasons: [errorText(error)],
        primary
      });
    }
    return primary;
  }

  async getPnl(address: PublicKeyString, duration: "30d" | "90d"): Promise<WalletPnlWindow> {
    const primary = await this.primary.getPnl(address, duration);
    const observedAt = this.now().toISOString();
    try {
      const shadow = await this.shadow.getPnl(address, duration);
      await this.sink.record(compareWalletPnl(address, primary, shadow, observedAt));
    } catch (error) {
      await this.sink.record({
        capability: duration === "30d" ? "WALLET_PNL_30D" : "WALLET_PNL_90D",
        subject: address,
        observedAt,
        status: "SHADOW_UNAVAILABLE",
        metrics: {},
        reasons: [errorText(error)],
        primary
      });
    }
    return primary;
  }
}
