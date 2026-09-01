import {
  BIRDEYE_SOL_USD_HISTORY_PREVIOUS_5M_SOURCE,
  BIRDEYE_SOL_USD_HISTORY_SOURCE,
  PYTH_SOL_USD_FEED_ID,
  PYTH_SOL_USD_HISTORY_SOURCE
} from "@copylab/providers";
import type { SolPriceBootstrapPhase, SolPriceBootstrapStatus } from "@copylab/shared";

export type { SolPriceBootstrapPhase, SolPriceBootstrapStatus } from "@copylab/shared";

export const SOL_PRICE_BOOTSTRAP_SETTING = "pyth_sol_usd_bootstrap_v1";
export const SOL_PRICE_BOOTSTRAP_SOURCE = PYTH_SOL_USD_HISTORY_SOURCE;
export const SOL_PRICE_BOOTSTRAP_FALLBACK_SOURCE = BIRDEYE_SOL_USD_HISTORY_SOURCE;
export const SOL_PRICE_BOOTSTRAP_PREVIOUS_5M_FALLBACK_SOURCE =
  BIRDEYE_SOL_USD_HISTORY_PREVIOUS_5M_SOURCE;
export const SOL_PRICE_BOOTSTRAP_SOURCES: ReadonlySet<string> = new Set([
  SOL_PRICE_BOOTSTRAP_SOURCE,
  SOL_PRICE_BOOTSTRAP_FALLBACK_SOURCE,
  SOL_PRICE_BOOTSTRAP_PREVIOUS_5M_FALLBACK_SOURCE
]);
export const SOL_PRICE_BOOTSTRAP_INTERVAL_SECONDS = 10 * 60;
export const SOL_PRICE_BOOTSTRAP_HORIZON_DAYS = 90;
/** Avoids churn while allowing an operator to close a genuinely stale rolling edge. */
export const SOL_PRICE_BOOTSTRAP_REFRESH_LAG_SECONDS = 60 * 60;
export const SOL_PRICE_BOOTSTRAP_TOTAL_POINTS =
  SOL_PRICE_BOOTSTRAP_HORIZON_DAYS * 24 * 60 * 60 / SOL_PRICE_BOOTSTRAP_INTERVAL_SECONDS + 1;

export interface SolPriceBootstrapCheckpoint {
  version: 1;
  phase: SolPriceBootstrapPhase;
  feedId: typeof PYTH_SOL_USD_FEED_ID;
  intervalSeconds: typeof SOL_PRICE_BOOTSTRAP_INTERVAL_SECONDS;
  horizonDays: typeof SOL_PRICE_BOOTSTRAP_HORIZON_DAYS;
  windowStartSeconds: number;
  windowEndSeconds: number;
  nextTimestampSeconds: number;
  totalPoints: number;
  completedPoints: number;
  insertedSnapshots: number;
  preservedSnapshots: number;
  cursorAttempts: number;
  startedAt: string;
  updatedAt: string;
  nextRetryAt?: string;
  completedAt?: string;
  lastError?: string;
}
