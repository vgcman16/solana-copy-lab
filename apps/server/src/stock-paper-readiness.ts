import type { AlpacaMarketClock } from "@copylab/providers";
import type { StockPaperMarketPhase } from "@copylab/shared";

export const ALPACA_BASIC_REQUEST_LIMIT = 200;
export const ALPACA_BASIC_REQUEST_WINDOW_MS = 60_000;

const MAXIMUM_CLOCK_AGE_MS = 2 * 60_000;
const MAXIMUM_QUOTE_AGE_MS = 2 * 60_000;
const MAXIMUM_BAR_AGE_MS = 4 * 60_000;
const MAXIMUM_CONFIGURABLE_BAR_AGE_MS = 30 * 60_000;
const MINIMUM_RETURNED_COVERAGE = 0.8;
const MAXIMUM_CONTINUOUS_SESSION_GAP_MS = 18 * 60 * 60_000;

export type StockPaperReadinessStatus = "READY" | "WARMING" | "BLOCKED";
export type StockPaperReadinessDisposition = "BLOCKING" | "WAITING" | "ADVISORY";

export type StockPaperReadinessReasonCode =
  | "INVALID_INPUT"
  | "CLOCK_STALE"
  | "CLOCK_PHASE_MISMATCH"
  | "CALENDAR_DISCONTINUITY"
  | "OVERNIGHT_NOT_SCHEDULED"
  | "OVERNIGHT_SESSION_PENDING"
  | "OVERNIGHT_ENTRY_DELAY"
  | "OVERNIGHT_ENTRY_WINDOW_CLOSED"
  | "SESSION_ENTRY_DELAY"
  | "SESSION_ENTRY_WINDOW_CLOSED"
  | "MARKET_SESSION_INACTIVE"
  | "QUOTE_PENDING"
  | "QUOTE_STALE"
  | "MINUTE_BAR_PENDING"
  | "MINUTE_BAR_STALE"
  | "SNAPSHOT_COVERAGE_PENDING"
  | "FRESH_SNAPSHOT_PENDING"
  | "IEX_PREMARKET_COVERAGE_PENDING"
  | "IEX_EVIDENCE_STALE_AFTER_GRACE"
  | "OPEN_POSITION_PRICING_INCOMPLETE"
  | "OVERNIGHT_ASSET_INVENTORY_PENDING"
  | "NO_OVERNIGHT_ELIGIBLE_ASSETS"
  | "NO_FRACTIONAL_EXTENDED_HOURS_ASSETS"
  | "OVERNIGHT_HALTS_PRESENT"
  | "REQUIRED_ENDPOINT_FAILED"
  | "OPTIONAL_ENDPOINT_FAILED"
  | "PROVIDER_BUDGET_PRESSURE"
  | "PROVIDER_RATE_LIMIT";

export interface StockPaperProviderCall {
  /** ISO timestamp for a completed provider request. */
  at: string;
  /** Allows a compact bucket to represent several calls made together. */
  requests?: number;
}

export interface RollingProviderBudgetInput {
  now: string;
  calls: readonly StockPaperProviderCall[];
  reserveRequests?: number;
  limit?: number;
  windowMs?: number;
}

export type RollingProviderBudgetPressure = "NORMAL" | "ELEVATED" | "HIGH" | "EXHAUSTED";

export interface RollingProviderBudgetSnapshot {
  limit: number;
  windowMs: number;
  used: number;
  remaining: number;
  reserveRequests: number;
  utilizationPercent: number;
  pressure: RollingProviderBudgetPressure;
  canReserve: boolean;
  retryAfterMs: number;
  windowStartAt: string;
  windowEndAt: string;
  oldestRequestExpiresAt?: string;
}

export interface StockPaperReadinessEndpointFailure {
  endpoint: string;
  required: boolean;
  message?: string;
}

export interface StockPaperReadinessInput {
  now: string;
  phase: StockPaperMarketPhase;
  clock: AlpacaMarketClock;
  quoteAgeMs?: number | undefined;
  minuteBarAgeMs?: number | undefined;
  /** Explicitly widens the causal evidence window for feeds whose bars are
   * delivered with a documented delay. The default remains four minutes. */
  maximumMinuteBarAgeMs?: number | undefined;
  requestedSnapshots: number;
  returnedSnapshots: number;
  freshSnapshots: number;
  openPositions: number;
  pricedOpenPositions: number;
  overnightEligibleAssets: number;
  fractionalExtendedHoursAssets: number;
  overnightHaltedAssets: number;
  endpointFailures?: readonly StockPaperReadinessEndpointFailure[];
  providerCalls: readonly StockPaperProviderCall[];
  providerRequestsToReserve?: number;
  providerRateLimit?: number;
  providerWindowMs?: number;
}

export interface StockPaperReadinessReason {
  code: StockPaperReadinessReasonCode;
  disposition: StockPaperReadinessDisposition;
  message: string;
  endpoint?: string;
}

export interface StockPaperReadinessSnapshot {
  status: StockPaperReadinessStatus;
  evaluatedAt: string;
  reasons: StockPaperReadinessReason[];
  countdownSeconds?: number;
  readyAt?: string;
  metrics: {
    quoteAgeMs?: number;
    minuteBarAgeMs?: number;
    maximumMinuteBarAgeMs: number;
    returnedCoveragePercent: number;
    freshCoveragePercent: number;
    openPositionPricingCoveragePercent: number;
    requestedSnapshots: number;
    returnedSnapshots: number;
    freshSnapshots: number;
    openPositions: number;
    pricedOpenPositions: number;
    overnightEligibleAssets: number;
    fractionalExtendedHoursAssets: number;
    overnightHaltedAssets: number;
    providerBudget: RollingProviderBudgetSnapshot;
  };
}

interface EasternPoint {
  weekday: string;
  minutes: number;
}

function finiteDate(value: string, label: string): number {
  const result = Date.parse(value);
  if (!Number.isFinite(result)) throw new RangeError(`${label} must be a valid ISO timestamp.`);
  return result;
}

function positiveInteger(value: number, label: string, allowZero = false): number {
  if (!Number.isInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new RangeError(`${label} must be ${allowZero ? "a non-negative" : "a positive"} integer.`);
  }
  return value;
}

function pressureFor(utilizationPercent: number, canReserve: boolean): RollingProviderBudgetPressure {
  if (!canReserve || utilizationPercent >= 100) return "EXHAUSTED";
  if (utilizationPercent >= 90) return "HIGH";
  if (utilizationPercent >= 70) return "ELEVATED";
  return "NORMAL";
}

/**
 * Calculates a strict rolling-window provider budget. Calls exactly on the
 * left edge of the window have expired; future timestamps fail closed.
 */
export function rollingProviderBudget(input: RollingProviderBudgetInput): RollingProviderBudgetSnapshot {
  const nowMs = finiteDate(input.now, "now");
  const limit = positiveInteger(input.limit ?? ALPACA_BASIC_REQUEST_LIMIT, "limit");
  const windowMs = positiveInteger(input.windowMs ?? ALPACA_BASIC_REQUEST_WINDOW_MS, "windowMs");
  const reserveRequests = positiveInteger(input.reserveRequests ?? 1, "reserveRequests", true);
  const windowStartMs = nowMs - windowMs;
  const active: Array<{ atMs: number; requests: number }> = [];

  for (const call of input.calls) {
    const atMs = finiteDate(call.at, "provider call at");
    if (atMs > nowMs) throw new RangeError("Provider call timestamps cannot be in the future.");
    const requests = positiveInteger(call.requests ?? 1, "provider call requests");
    if (atMs > windowStartMs) active.push({ atMs, requests });
  }

  active.sort((left, right) => left.atMs - right.atMs);
  const used = active.reduce((sum, call) => sum + call.requests, 0);
  const remaining = Math.max(0, limit - used);
  const canReserve = used + reserveRequests <= limit;
  let retryAfterMs = 0;
  if (!canReserve) {
    let requestsToExpire = used + reserveRequests - limit;
    for (const call of active) {
      requestsToExpire -= call.requests;
      if (requestsToExpire <= 0) {
        retryAfterMs = Math.max(1, call.atMs + windowMs - nowMs);
        break;
      }
    }
  }
  const utilizationPercent = used / limit * 100;
  const oldest = active[0];
  return {
    limit,
    windowMs,
    used,
    remaining,
    reserveRequests,
    utilizationPercent,
    pressure: pressureFor(utilizationPercent, canReserve),
    canReserve,
    retryAfterMs,
    windowStartAt: new Date(windowStartMs).toISOString(),
    windowEndAt: new Date(nowMs).toISOString(),
    ...(oldest ? { oldestRequestExpiresAt: new Date(oldest.atMs + windowMs).toISOString() } : {})
  };
}

function easternPoint(now: Date): EasternPoint | undefined {
  if (!Number.isFinite(now.getTime())) return undefined;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(now);
  const weekday = parts.find((part) => part.type === "weekday")?.value;
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  if (!weekday || !Number.isFinite(hour) || !Number.isFinite(minute)) return undefined;
  return { weekday, minutes: hour * 60 + minute };
}

function nonNegativeMetric(value: number): boolean {
  return Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

function percentage(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator * 100 : 0;
}

function pushReason(
  reasons: StockPaperReadinessReason[],
  code: StockPaperReadinessReasonCode,
  disposition: StockPaperReadinessDisposition,
  message: string,
  endpoint?: string
): void {
  reasons.push({ code, disposition, message, ...(endpoint ? { endpoint } : {}) });
}

function phaseEvidenceLabel(phase: StockPaperMarketPhase): string {
  if (phase === "PREMARKET") return "premarket IEX";
  if (phase === "REGULAR") return "regular-session IEX";
  if (phase === "AFTER_HOURS") return "after-hours IEX";
  if (phase === "OVERNIGHT") return "overnight";
  return "market-session";
}

function evaluateSessionWindow(input: {
  phase: StockPaperMarketPhase;
  point: EasternPoint;
  nowMs: number;
  nextCloseAt: number;
  reasons: StockPaperReadinessReason[];
  countdowns: number[];
}): void {
  const waitUntil = (targetMinute: number, message: string): void => {
    const countdownMs = Math.max(0, (targetMinute - input.point.minutes) * 60_000);
    if (countdownMs > 0) input.countdowns.push(countdownMs);
    pushReason(input.reasons, "SESSION_ENTRY_DELAY", "WAITING", message);
  };
  const closeWindow = (message: string): void => {
    pushReason(input.reasons, "SESSION_ENTRY_WINDOW_CLOSED", "BLOCKING", message);
  };

  if (input.phase === "PREMARKET") {
    if (input.point.minutes < 4 * 60 + 15) {
      waitUntil(4 * 60 + 15, "The premarket PAPER entry warmup runs until 4:15 AM ET.");
    } else if (input.point.minutes >= 9 * 60 + 15) {
      closeWindow("The premarket PAPER entry cutoff passed at 9:15 AM ET.");
    }
    return;
  }
  if (input.phase === "REGULAR") {
    if (input.point.minutes < 9 * 60 + 35) {
      waitUntil(9 * 60 + 35, "The regular-session PAPER opening delay runs until 9:35 AM ET.");
    } else {
      const minutesToClose = (input.nextCloseAt - input.nowMs) / 60_000;
      if (Number.isFinite(minutesToClose) && minutesToClose <= 30) {
        closeWindow("The regular-session PAPER entry cutoff begins 30 minutes before the verified close.");
      }
    }
    return;
  }
  if (input.phase === "AFTER_HOURS") {
    if (input.point.minutes < 16 * 60 + 5) {
      waitUntil(16 * 60 + 5, "The after-hours PAPER entry warmup runs until 4:05 PM ET.");
    } else if (input.point.minutes >= 19 * 60 + 45) {
      closeWindow("The after-hours PAPER entry cutoff passed at 7:45 PM ET.");
    }
    return;
  }
  if (input.phase === "OVERNIGHT") {
    if (input.point.minutes >= 20 * 60 && input.point.minutes < 20 * 60 + 15) {
      const countdownMs = (20 * 60 + 15 - input.point.minutes) * 60_000;
      input.countdowns.push(countdownMs);
      pushReason(
        input.reasons,
        "OVERNIGHT_ENTRY_DELAY",
        "WAITING",
        "Fresh overnight evidence is accumulating before entries can begin at 8:15 PM ET."
      );
    } else if (input.point.minutes >= 3 * 60 + 45 && input.point.minutes < 4 * 60) {
      pushReason(
        input.reasons,
        "OVERNIGHT_ENTRY_WINDOW_CLOSED",
        "BLOCKING",
        "The overnight PAPER entry cutoff passed at 3:45 AM ET."
      );
    }
    return;
  }
  pushReason(
    input.reasons,
    "MARKET_SESSION_INACTIVE",
    "BLOCKING",
    input.phase === "UNKNOWN"
      ? "The current US-equity market phase could not be determined."
      : "No US-equity PAPER entry session is currently active."
  );
}

/**
 * Produces a fail-closed, deterministic readiness verdict. Transient market
 * evidence is WARMING; broken required endpoints, unsafe pricing, calendar
 * gaps, or an exhausted request budget are BLOCKED.
 */
export function evaluateStockPaperReadiness(
  input: StockPaperReadinessInput
): StockPaperReadinessSnapshot {
  const nowMs = finiteDate(input.now, "now");
  const reasons: StockPaperReadinessReason[] = [];
  const countdowns: number[] = [];
  const point = easternPoint(new Date(nowMs));
  const configuredMaximumBarAgeMs = input.maximumMinuteBarAgeMs ?? MAXIMUM_BAR_AGE_MS;
  const maximumBarAgeIsValid = Number.isInteger(configuredMaximumBarAgeMs) &&
    configuredMaximumBarAgeMs >= 60_000 &&
    configuredMaximumBarAgeMs <= MAXIMUM_CONFIGURABLE_BAR_AGE_MS;
  const maximumBarAgeMs = maximumBarAgeIsValid
    ? configuredMaximumBarAgeMs
    : MAXIMUM_BAR_AGE_MS;
  const budget = rollingProviderBudget({
    now: input.now,
    calls: input.providerCalls,
    reserveRequests: input.providerRequestsToReserve ?? 1,
    limit: input.providerRateLimit ?? ALPACA_BASIC_REQUEST_LIMIT,
    windowMs: input.providerWindowMs ?? ALPACA_BASIC_REQUEST_WINDOW_MS
  });

  const countMetrics = [
    input.requestedSnapshots,
    input.returnedSnapshots,
    input.freshSnapshots,
    input.openPositions,
    input.pricedOpenPositions,
    input.overnightEligibleAssets,
    input.fractionalExtendedHoursAssets,
    input.overnightHaltedAssets
  ];
  if (!point || !maximumBarAgeIsValid || countMetrics.some((value) => !nonNegativeMetric(value)) ||
    input.returnedSnapshots > input.requestedSnapshots ||
    input.freshSnapshots > input.returnedSnapshots ||
    input.pricedOpenPositions > input.openPositions) {
    pushReason(
      reasons,
      "INVALID_INPUT",
      "BLOCKING",
      "Readiness metrics are malformed or internally inconsistent."
    );
  }

  const clockAt = Date.parse(input.clock.timestamp);
  const nextOpenAt = Date.parse(input.clock.nextOpen);
  const nextCloseAt = Date.parse(input.clock.nextClose);
  if (!Number.isFinite(clockAt) || !Number.isFinite(nextOpenAt) || !Number.isFinite(nextCloseAt)) {
    pushReason(reasons, "INVALID_INPUT", "BLOCKING", "The Alpaca market clock is malformed.");
  } else {
    const clockAgeMs = nowMs - clockAt;
    if (clockAgeMs < -30_000 || clockAgeMs > MAXIMUM_CLOCK_AGE_MS) {
      pushReason(reasons, "CLOCK_STALE", "BLOCKING", "The Alpaca market clock is stale or future-dated.");
    }
    const expectsOpenClock = input.phase === "REGULAR";
    if (input.clock.isOpen !== expectsOpenClock) {
      pushReason(
        reasons,
        "CLOCK_PHASE_MISMATCH",
        "BLOCKING",
        expectsOpenClock
          ? "The regular-session phase requires the exchange clock to report open."
          : `The exchange clock reports regular trading open during the ${input.phase.toLowerCase().replaceAll("_", " ")} phase.`
      );
    }
    const phaseRequiresContinuousNextOpen = input.phase === "PREMARKET" ||
      input.phase === "AFTER_HOURS" || input.phase === "OVERNIGHT";
    const untilNextOpenMs = nextOpenAt - nowMs;
    if (phaseRequiresContinuousNextOpen &&
        (untilNextOpenMs < 0 || untilNextOpenMs > MAXIMUM_CONTINUOUS_SESSION_GAP_MS)) {
      pushReason(
        reasons,
        "CALENDAR_DISCONTINUITY",
        "BLOCKING",
        `The next regular session is too distant for the current ${input.phase.toLowerCase().replaceAll("_", " ")} entry path.`
      );
    }
  }

  if (point) {
    if (input.phase === "AFTER_HOURS" && !["Mon", "Tue", "Wed", "Thu"].includes(point.weekday)) {
        pushReason(
          reasons,
          "OVERNIGHT_NOT_SCHEDULED",
          "BLOCKING",
          "No continuous overnight session follows this after-hours window."
        );
    }
    evaluateSessionWindow({
      phase: input.phase,
      point,
      nowMs,
      nextCloseAt,
      reasons,
      countdowns
    });
  }

  const evidenceLabel = phaseEvidenceLabel(input.phase);
  const evidenceDisposition: StockPaperReadinessDisposition = "WAITING";
  const quoteIsCurrent = input.quoteAgeMs !== undefined &&
    Number.isFinite(input.quoteAgeMs) && input.quoteAgeMs >= -30_000 &&
    input.quoteAgeMs <= MAXIMUM_QUOTE_AGE_MS;
  if (input.quoteAgeMs === undefined) {
    pushReason(reasons, "QUOTE_PENDING", evidenceDisposition, `A current ${evidenceLabel} quote has not arrived.`);
  } else if (!Number.isFinite(input.quoteAgeMs) || input.quoteAgeMs < -30_000) {
    pushReason(reasons, "INVALID_INPUT", "BLOCKING", "Quote age is invalid.");
  } else if (input.quoteAgeMs > MAXIMUM_QUOTE_AGE_MS) {
    pushReason(reasons, "QUOTE_STALE", evidenceDisposition, `The newest ${evidenceLabel} quote is stale.`);
  }

  const minuteBarIsCurrent = input.minuteBarAgeMs !== undefined &&
    Number.isFinite(input.minuteBarAgeMs) && input.minuteBarAgeMs >= -90_000 &&
    input.minuteBarAgeMs <= maximumBarAgeMs;
  if (input.minuteBarAgeMs === undefined) {
    pushReason(
      reasons,
      "MINUTE_BAR_PENDING",
      evidenceDisposition,
      `A current ${evidenceLabel} minute bar has not arrived.`
    );
  } else if (!Number.isFinite(input.minuteBarAgeMs) || input.minuteBarAgeMs < -90_000) {
    pushReason(reasons, "INVALID_INPUT", "BLOCKING", "Minute-bar age is invalid.");
  } else if (input.minuteBarAgeMs > maximumBarAgeMs) {
    pushReason(
      reasons,
      "MINUTE_BAR_STALE",
      evidenceDisposition,
      `The newest ${evidenceLabel} minute bar is stale.`
    );
  }

  const returnedCoverage = input.requestedSnapshots > 0
    ? input.returnedSnapshots / input.requestedSnapshots
    : 0;
  if (input.requestedSnapshots === 0 || returnedCoverage < MINIMUM_RETURNED_COVERAGE) {
    pushReason(
      reasons,
      "SNAPSHOT_COVERAGE_PENDING",
      "WAITING",
      `Returned ${evidenceLabel} snapshot coverage is below 80%.`
    );
  }
  if (input.freshSnapshots === 0) {
    pushReason(
      reasons,
      "FRESH_SNAPSHOT_PENDING",
      "WAITING",
      `No returned snapshot contains current ${evidenceLabel} evidence yet.`
    );
  }

  const iexEvidenceStillStale = !quoteIsCurrent || !minuteBarIsCurrent || input.freshSnapshots === 0;
  const premarketIexCoveragePending = input.phase === "PREMARKET" && point !== undefined &&
    point.minutes < 8 * 60 && iexEvidenceStillStale;
  if (premarketIexCoveragePending) {
    const countdownMs = (8 * 60 - point.minutes) * 60_000;
    if (countdownMs > 0) countdowns.push(countdownMs);
    pushReason(
      reasons,
      "IEX_PREMARKET_COVERAGE_PENDING",
      "WAITING",
      "Alpaca Basic IEX has not begun its actionable premarket coverage window; current IEX evidence is required after 8:00 AM ET. Delayed SIP bars may update fair value only and cannot price or fill PAPER orders."
    );
  }
  const premarketGracePassed = input.phase === "PREMARKET" && point !== undefined &&
    point.minutes >= 8 * 60 + 5;
  const regularGracePassed = input.phase === "REGULAR" && point !== undefined &&
    point.minutes >= 9 * 60 + 35;
  if (iexEvidenceStillStale && (premarketGracePassed || regularGracePassed)) {
    const graceLabel = input.phase === "PREMARKET" ? "8:05 AM ET" : "9:35 AM ET";
    pushReason(
      reasons,
      "IEX_EVIDENCE_STALE_AFTER_GRACE",
      "ADVISORY",
      `The ${evidenceLabel} feed still lacks current evidence after the ${graceLabel} diagnostic grace point; this warning does not change PAPER trading policy.`
    );
  }

  if (input.pricedOpenPositions < input.openPositions) {
    pushReason(
      reasons,
      "OPEN_POSITION_PRICING_INCOMPLETE",
      "BLOCKING",
      "Every open position must have executable pricing before readiness can pass."
    );
  }

  if (input.phase === "OVERNIGHT" && input.overnightEligibleAssets === 0) {
    pushReason(
      reasons,
      "NO_OVERNIGHT_ELIGIBLE_ASSETS",
      "BLOCKING",
      "No active, non-halted asset is eligible for overnight trading."
    );
  }
  if (input.phase === "OVERNIGHT" && input.fractionalExtendedHoursAssets === 0) {
    pushReason(
      reasons,
      "NO_FRACTIONAL_EXTENDED_HOURS_ASSETS",
      "ADVISORY",
      "Overnight entries are currently limited to affordable whole shares."
    );
  }
  if (input.phase === "OVERNIGHT" && input.overnightHaltedAssets > 0) {
    pushReason(
      reasons,
      "OVERNIGHT_HALTS_PRESENT",
      "ADVISORY",
      `${input.overnightHaltedAssets} overnight asset(s) are halted and must remain excluded.`
    );
  }

  for (const failure of input.endpointFailures ?? []) {
    pushReason(
      reasons,
      failure.required ? "REQUIRED_ENDPOINT_FAILED" : "OPTIONAL_ENDPOINT_FAILED",
      failure.required ? "BLOCKING" : "ADVISORY",
      failure.message?.trim() || `${failure.endpoint} failed its readiness check.`,
      failure.endpoint
    );
  }

  if (!budget.canReserve) {
    countdowns.push(budget.retryAfterMs);
    pushReason(
      reasons,
      "PROVIDER_RATE_LIMIT",
      "BLOCKING",
      "The Alpaca Basic rolling request budget cannot reserve the next cycle."
    );
  } else if (budget.pressure === "HIGH" || budget.pressure === "ELEVATED") {
    pushReason(
      reasons,
      "PROVIDER_BUDGET_PRESSURE",
      "ADVISORY",
      `The Alpaca rolling request window is ${budget.pressure.toLowerCase()}.`
    );
  }

  const status: StockPaperReadinessStatus = reasons.some((reason) => reason.disposition === "BLOCKING")
    ? "BLOCKED"
    : reasons.some((reason) => reason.disposition === "WAITING")
      ? "WARMING"
      : "READY";
  const countdownMs = countdowns.length > 0 ? Math.max(...countdowns) : 0;
  return {
    status,
    evaluatedAt: new Date(nowMs).toISOString(),
    reasons,
    ...(countdownMs > 0
      ? {
          countdownSeconds: Math.ceil(countdownMs / 1_000),
          readyAt: new Date(nowMs + countdownMs).toISOString()
        }
      : {}),
    metrics: {
      ...(input.quoteAgeMs !== undefined ? { quoteAgeMs: input.quoteAgeMs } : {}),
      ...(input.minuteBarAgeMs !== undefined ? { minuteBarAgeMs: input.minuteBarAgeMs } : {}),
      maximumMinuteBarAgeMs: maximumBarAgeMs,
      returnedCoveragePercent: percentage(input.returnedSnapshots, input.requestedSnapshots),
      freshCoveragePercent: percentage(input.freshSnapshots, input.returnedSnapshots),
      openPositionPricingCoveragePercent: input.openPositions === 0
        ? 100
        : percentage(input.pricedOpenPositions, input.openPositions),
      requestedSnapshots: input.requestedSnapshots,
      returnedSnapshots: input.returnedSnapshots,
      freshSnapshots: input.freshSnapshots,
      openPositions: input.openPositions,
      pricedOpenPositions: input.pricedOpenPositions,
      overnightEligibleAssets: input.overnightEligibleAssets,
      fractionalExtendedHoursAssets: input.fractionalExtendedHoursAssets,
      overnightHaltedAssets: input.overnightHaltedAssets,
      providerBudget: budget
    }
  };
}
