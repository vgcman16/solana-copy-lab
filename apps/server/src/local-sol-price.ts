import type { Repository } from "./repository.js";

export const MAXIMUM_SOL_PRICE_COVERAGE_GAP_SECONDS = 10 * 60;

/**
 * Historical observations are captured after a network response, so an otherwise
 * exact ten-minute cadence can differ by a few milliseconds from one request to
 * the next. Keep the exact measured gap in telemetry, but ignore only subsecond
 * capture jitter when applying the ten-minute continuity gate. A full additional
 * second still fails closed.
 */
export function isSolPriceCoverageGapAcceptable(largestGapSeconds: number | undefined): boolean {
  if (largestGapSeconds === undefined) return true;
  return Number.isFinite(largestGapSeconds) &&
    largestGapSeconds >= 0 &&
    largestGapSeconds < MAXIMUM_SOL_PRICE_COVERAGE_GAP_SECONDS + 1;
}

export interface SolPriceSnapshot {
  capturedAt: string;
  priceUsd: number;
  source: string;
}

export class LocalSolPriceOracle {
  constructor(
    private readonly repository: Repository,
    private readonly maximumDistanceMs = 10 * 60_000
  ) {
    if (!Number.isFinite(maximumDistanceMs) || maximumDistanceMs < 0) {
      throw new RangeError("SOL price maximum distance must be non-negative.");
    }
  }

  record(priceUsd: number, capturedAt = new Date().toISOString(), source = "jupiter_quote"): SolPriceSnapshot {
    const snapshot = { capturedAt, priceUsd, source };
    this.repository.saveSolPriceSnapshot(snapshot);
    return snapshot;
  }

  resolve(at: string): number {
    const snapshot = this.repository.nearestSolPriceSnapshot(at, this.maximumDistanceMs);
    if (!snapshot) {
      throw new Error("No at-or-before local SOL/USD price is available; SOL-legged history fails closed.");
    }
    return snapshot.priceUsd;
  }

  coverage(): {
    count: number;
    pendingSwapReprices: number;
    outOfHorizonSwapReprices: number;
    oldestAt?: string;
    newestAt?: string;
    largestGapSeconds: number;
  } {
    return this.repository.solPriceCoverage();
  }
}
