import type { Repository } from "./repository.js";

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
  } {
    return this.repository.solPriceCoverage();
  }
}
