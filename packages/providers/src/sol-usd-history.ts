export const PYTH_SOL_USD_HISTORY_SOURCE = "pyth_benchmarks" as const;
export const BIRDEYE_SOL_USD_HISTORY_SOURCE = "birdeye_ohlcv_v3" as const;

export type SolUsdHistorySource =
  | typeof PYTH_SOL_USD_HISTORY_SOURCE
  | typeof BIRDEYE_SOL_USD_HISTORY_SOURCE;

/**
 * Minimal, provider-independent evidence admitted by the durable SOL/USD
 * bootstrap. Provider clients may add richer fields, but every accepted mark
 * must identify both its requested grid time and the provider observation it
 * came from.
 */
export interface SolUsdHistoricalPrice {
  source: SolUsdHistorySource;
  requestedTimestampSeconds: number;
  observationTimestampSeconds: number;
  priceUsd: number;
}

export interface SolUsdHistoricalPriceProvider {
  /** True when at least one server-side provider credential is configured. */
  readonly authenticationConfigured: boolean;
  /** Distinguishes a real Pyth bearer key from an authenticated managed fallback. */
  readonly pythAuthenticationConfigured?: boolean;
  readonly fallbackConfigured?: boolean;
  readonly activeSource?: SolUsdHistorySource;
  getSolUsdPrice(timestampSeconds: number): Promise<SolUsdHistoricalPrice>;
}

export interface ResilientSolUsdHistoryProviderOptions {
  onFallback?: (reason: "PRIMARY_NOT_CONFIGURED" | "PRIMARY_FAILED") => void;
}

/**
 * Prefers authenticated Pyth evidence and fails over to an independent,
 * strictly validated history source. A corrupt primary response is never
 * accepted: the fallback must independently return valid evidence.
 */
export class ResilientSolUsdHistoryProvider implements SolUsdHistoricalPriceProvider {
  readonly authenticationConfigured: boolean;
  readonly pythAuthenticationConfigured: boolean;
  readonly fallbackConfigured: boolean;
  private selectedSource: SolUsdHistorySource;
  private primarySuppressed = false;
  private readonly onFallback: NonNullable<ResilientSolUsdHistoryProviderOptions["onFallback"]>;
  private readonly reportedFallbackReasons = new Set<"PRIMARY_NOT_CONFIGURED" | "PRIMARY_FAILED">();

  constructor(
    private readonly primary: SolUsdHistoricalPriceProvider,
    private readonly fallback: SolUsdHistoricalPriceProvider,
    options: ResilientSolUsdHistoryProviderOptions = {}
  ) {
    this.authenticationConfigured = primary.authenticationConfigured || fallback.authenticationConfigured;
    this.pythAuthenticationConfigured = primary.pythAuthenticationConfigured
      ?? primary.authenticationConfigured;
    this.fallbackConfigured = fallback.authenticationConfigured;
    this.selectedSource = this.pythAuthenticationConfigured
      ? PYTH_SOL_USD_HISTORY_SOURCE
      : fallback.activeSource ?? BIRDEYE_SOL_USD_HISTORY_SOURCE;
    this.onFallback = options.onFallback ?? (() => undefined);
  }

  get activeSource(): SolUsdHistorySource {
    return this.selectedSource;
  }

  async getSolUsdPrice(timestampSeconds: number): Promise<SolUsdHistoricalPrice> {
    if (this.pythAuthenticationConfigured && !this.primarySuppressed) {
      try {
        const result = await this.primary.getSolUsdPrice(timestampSeconds);
        this.selectedSource = result.source;
        return result;
      } catch (error) {
        if (!this.fallbackConfigured) throw error;
        // Avoid one failed Pyth request per historical point. A fresh runtime
        // will probe Pyth again, while this worker uses the independent source.
        this.primarySuppressed = true;
        this.reportFallback("PRIMARY_FAILED");
      }
    } else if (!this.pythAuthenticationConfigured) {
      if (!this.fallbackConfigured) {
        return this.primary.getSolUsdPrice(timestampSeconds);
      }
      this.reportFallback("PRIMARY_NOT_CONFIGURED");
    }
    const result = await this.fallback.getSolUsdPrice(timestampSeconds);
    this.selectedSource = result.source;
    return result;
  }

  private reportFallback(reason: "PRIMARY_NOT_CONFIGURED" | "PRIMARY_FAILED"): void {
    if (this.reportedFallbackReasons.has(reason)) return;
    this.reportedFallbackReasons.add(reason);
    this.onFallback(reason);
  }
}
