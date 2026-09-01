import type {
  PublicKeyString,
  WalletDiscoveryProvider,
  WalletHistorySummary,
  WalletPnlWindow
} from "@copylab/shared";

export const MANAGED_RECOVERY_PREFLIGHT_POLICY = "managed-recovery-preflight-v1";

export type ManagedRecoveryPreflightStep = "PNL_30D" | "PNL_90D" | "HISTORY";

export type ManagedRecoveryPreflightRejectionCode =
  | "NON_POSITIVE_30D_PNL"
  | "NON_POSITIVE_90D_PNL"
  | "INSUFFICIENT_HISTORY"
  | "DISALLOWED_IDENTITY_TAG"
  | "TOP_TOKEN_PROFIT_CONCENTRATION"
  | "TOP_THREE_PROFIT_CONCENTRATION";

export interface ManagedRecoveryPreflightWindow {
  policyVersion: typeof MANAGED_RECOVERY_PREFLIGHT_POLICY;
  windowStart: string;
  expiresAt: string;
}

/**
 * A repository claim is a lease on exactly one provider operation. Prior
 * results are carried forward so the coordinator can validate a resumed state
 * before spending any more provider budget.
 */
export interface ManagedRecoveryPreflightClaim extends ManagedRecoveryPreflightWindow {
  claimToken: string;
  wallet: PublicKeyString;
  step: ManagedRecoveryPreflightStep;
  /** One-based number of times this durable step has been leased. */
  attempts: number;
  pnl30d?: WalletPnlWindow;
  pnl90d?: WalletPnlWindow;
}

export interface ManagedRecoveryPreflightRepository {
  claimManagedRecoveryPreflight(input: ManagedRecoveryPreflightWindow & {
    now: string;
    leaseExpiresAt: string;
  }): ManagedRecoveryPreflightClaim | undefined;

  saveManagedRecoveryPreflightPartial(input: {
    claimToken: string;
    wallet: PublicKeyString;
    policyVersion: typeof MANAGED_RECOVERY_PREFLIGHT_POLICY;
    windowStart: string;
    expectedStep: "PNL_30D" | "PNL_90D";
    nextStep: "PNL_90D" | "HISTORY";
    observedAt: string;
    pnl30d?: WalletPnlWindow;
    pnl90d?: WalletPnlWindow;
  }): boolean;

  passManagedRecoveryPreflight(input: {
    claimToken: string;
    wallet: PublicKeyString;
    policyVersion: typeof MANAGED_RECOVERY_PREFLIGHT_POLICY;
    windowStart: string;
    expectedStep: "HISTORY";
    validAt: string;
    expiresAt: string;
    history: WalletHistorySummary;
  }): boolean;

  rejectManagedRecoveryPreflight(input: {
    claimToken: string;
    wallet: PublicKeyString;
    policyVersion: typeof MANAGED_RECOVERY_PREFLIGHT_POLICY;
    windowStart: string;
    expectedStep: ManagedRecoveryPreflightStep;
    reasonCode: ManagedRecoveryPreflightRejectionCode;
    observedAt: string;
    expiresAt: string;
  }): boolean;

  retryManagedRecoveryPreflight(input: {
    claimToken: string;
    wallet: PublicKeyString;
    policyVersion: typeof MANAGED_RECOVERY_PREFLIGHT_POLICY;
    windowStart: string;
    expectedStep: ManagedRecoveryPreflightStep;
    attemptedAt: string;
    nextAttemptAt: string;
    error: string;
  }): boolean;
}

export type ManagedRecoveryHistoryProvider = Pick<
  import("@copylab/shared").ChainObserver,
  "summarizeHistory"
>;

export interface ManagedRecoveryPreflightBudgetContext extends ManagedRecoveryPreflightWindow {
  wallet: PublicKeyString;
  step: ManagedRecoveryPreflightStep;
}

export interface ManagedRecoveryPreflightCoordinatorOptions {
  now?: () => Date;
  canRun?: () => boolean | Promise<boolean>;
  canSpendBirdeye?: (
    context: ManagedRecoveryPreflightBudgetContext
  ) => boolean | Promise<boolean>;
  canSpendHelius?: (
    context: ManagedRecoveryPreflightBudgetContext
  ) => boolean | Promise<boolean>;
  retryBaseMs?: number;
  maximumRetryDelayMs?: number;
  leaseDurationMs?: number;
  /** Maximum provider attempts for one durable step before holding to expiry. */
  maximumAttemptsPerStep?: number;
}

const UTC_DAY_MS = 86_400_000;
const DEFAULT_RETRY_BASE_MS = 60_000;
const DEFAULT_MAXIMUM_RETRY_DELAY_MS = 60 * 60_000;
const DEFAULT_LEASE_DURATION_MS = 5 * 60_000;
const DISALLOWED_TAGS = new Set(["dev", "bundler", "sniper", "insider"]);

function validDate(date: Date): Date {
  if (!Number.isFinite(date.getTime())) {
    throw new Error("Managed recovery preflight clock returned an invalid time.");
  }
  return date;
}

/** Returns the deterministic Monday-to-Monday UTC validity window. */
export function managedRecoveryPreflightWindow(now: Date): ManagedRecoveryPreflightWindow {
  const at = validDate(now);
  const start = new Date(at.getTime());
  const daysSinceMonday = (start.getUTCDay() + 6) % 7;
  start.setUTCDate(start.getUTCDate() - daysSinceMonday);
  start.setUTCHours(0, 0, 0, 0);
  return {
    policyVersion: MANAGED_RECOVERY_PREFLIGHT_POLICY,
    windowStart: start.toISOString(),
    expiresAt: new Date(start.getTime() + 7 * UTC_DAY_MS).toISOString()
  };
}

function validNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function validPnl(result: WalletPnlWindow, duration: "30d" | "90d"): boolean {
  return result !== null
    && typeof result === "object"
    && result.duration === duration
    && validFinite(result.realizedProfitUsd)
    && validFinite(result.realizedProfitPercent)
    && validFinite(result.unrealizedProfitUsd)
    && validNonNegativeInteger(result.totalTrades)
    && validNonNegativeInteger(result.wins)
    && validNonNegativeInteger(result.losses);
}

function normalizedTags(tags: readonly string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))].sort();
}

function wellFormedHistory(result: WalletHistorySummary, wallet: string): boolean {
  return result !== null
    && typeof result === "object"
    && result.wallet === wallet
    && validNonNegativeInteger(result.historyDays)
    && validNonNegativeInteger(result.closedEligibleSwaps)
    && validNonNegativeInteger(result.activeWeeks)
    && validFinite(result.medianHoldingMinutes)
    && result.medianHoldingMinutes >= 0
    && validFinite(result.topTokenProfitShare)
    && validFinite(result.topThreeProfitShare)
    && result.topTokenProfitShare >= 0
    && result.topTokenProfitShare <= result.topThreeProfitShare
    && result.topThreeProfitShare <= 1
    && Array.isArray(result.tags)
    && result.tags.every((tag) => typeof tag === "string");
}

function assertPositiveDuration(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be positive.`);
  }
  return value;
}

function assertCommitted(committed: boolean): void {
  if (!committed) {
    throw new Error("Managed recovery preflight lost its durable claim before the result was committed.");
  }
}

export class ManagedRecoveryPreflightCoordinator {
  private readonly now: () => Date;
  private readonly canRun: () => boolean | Promise<boolean>;
  private readonly canSpendBirdeye: (
    context: ManagedRecoveryPreflightBudgetContext
  ) => boolean | Promise<boolean>;
  private readonly canSpendHelius: (
    context: ManagedRecoveryPreflightBudgetContext
  ) => boolean | Promise<boolean>;
  private readonly retryBaseMs: number;
  private readonly maximumRetryDelayMs: number;
  private readonly leaseDurationMs: number;
  private readonly maximumAttemptsPerStep: number;

  constructor(
    private readonly repository: ManagedRecoveryPreflightRepository,
    private readonly discovery: WalletDiscoveryProvider,
    private readonly history: ManagedRecoveryHistoryProvider,
    options: ManagedRecoveryPreflightCoordinatorOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
    this.canRun = options.canRun ?? (() => true);
    this.canSpendBirdeye = options.canSpendBirdeye ?? (() => true);
    this.canSpendHelius = options.canSpendHelius ?? (() => true);
    this.retryBaseMs = assertPositiveDuration(
      options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS,
      "Managed recovery preflight retryBaseMs"
    );
    this.maximumRetryDelayMs = assertPositiveDuration(
      options.maximumRetryDelayMs ?? DEFAULT_MAXIMUM_RETRY_DELAY_MS,
      "Managed recovery preflight maximumRetryDelayMs"
    );
    if (this.maximumRetryDelayMs < this.retryBaseMs) {
      throw new RangeError("Managed recovery preflight maximumRetryDelayMs must be at least retryBaseMs.");
    }
    this.leaseDurationMs = assertPositiveDuration(
      options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS,
      "Managed recovery preflight leaseDurationMs"
    );
    this.maximumAttemptsPerStep = options.maximumAttemptsPerStep ?? 3;
    if (!Number.isSafeInteger(this.maximumAttemptsPerStep) || this.maximumAttemptsPerStep < 1) {
      throw new RangeError("Managed recovery preflight maximumAttemptsPerStep must be a positive integer.");
    }
  }

  /**
   * Claims and performs at most one provider operation. Every successful
   * provider response is durably committed before another step can run.
   */
  async runOnce(): Promise<boolean> {
    if (!await this.safeFence(this.canRun)) return false;
    const startedAt = validDate(this.now());
    const window = managedRecoveryPreflightWindow(startedAt);
    const leaseExpiresAt = new Date(Math.min(
      Date.parse(window.expiresAt),
      startedAt.getTime() + this.leaseDurationMs
    )).toISOString();
    const claim = this.repository.claimManagedRecoveryPreflight({
      ...window,
      now: startedAt.toISOString(),
      leaseExpiresAt
    });
    if (!claim) return false;

    if (!this.validClaim(claim, window)) {
      this.retry(claim, startedAt, "Managed recovery preflight claimed malformed or stale durable state.");
      return true;
    }

    const context: ManagedRecoveryPreflightBudgetContext = {
      ...window,
      wallet: claim.wallet,
      step: claim.step
    };

    try {
      if (!await this.canRun()) {
        this.retry(claim, startedAt, "Managed recovery preflight is paused by its runtime fence.");
        return true;
      }
      const budgetAllowed = claim.step === "HISTORY"
        ? await this.canSpendHelius(context)
        : await this.canSpendBirdeye(context);
      if (!budgetAllowed) {
        this.retry(claim, startedAt, "Managed recovery preflight provider budget is currently fenced.");
        return true;
      }

      if (claim.step === "PNL_30D") {
        await this.runPnl30d(claim);
      } else if (claim.step === "PNL_90D") {
        await this.runPnl90d(claim, startedAt);
      } else {
        await this.runHistory(claim, startedAt);
      }
      return true;
    } catch {
      this.retry(claim, startedAt, "Managed recovery preflight provider step failed; retry is required.");
      return true;
    }
  }

  private async runPnl30d(claim: ManagedRecoveryPreflightClaim): Promise<void> {
    const pnl30d = await this.discovery.getPnl(claim.wallet, "30d");
    const observedAt = validDate(this.now()).toISOString();
    if (!validPnl(pnl30d, "30d")) {
      this.retry(claim, new Date(observedAt), "Managed recovery preflight received malformed 30-day PnL.");
      return;
    }
    if (pnl30d.realizedProfitUsd <= 0) {
      assertCommitted(this.repository.rejectManagedRecoveryPreflight({
        ...this.claimIdentity(claim),
        expectedStep: "PNL_30D",
        reasonCode: "NON_POSITIVE_30D_PNL",
        observedAt,
        expiresAt: claim.expiresAt
      }));
      return;
    }
    assertCommitted(this.repository.saveManagedRecoveryPreflightPartial({
      ...this.claimIdentity(claim),
      expectedStep: "PNL_30D",
      nextStep: "PNL_90D",
      observedAt,
      pnl30d
    }));
  }

  private async runPnl90d(claim: ManagedRecoveryPreflightClaim, attemptedAt: Date): Promise<void> {
    if (!claim.pnl30d || !validPnl(claim.pnl30d, "30d") || claim.pnl30d.realizedProfitUsd <= 0) {
      this.retry(claim, attemptedAt, "Managed recovery preflight is missing valid positive 30-day PnL state.");
      return;
    }
    const pnl90d = await this.discovery.getPnl(claim.wallet, "90d");
    const observedAt = validDate(this.now()).toISOString();
    if (!validPnl(pnl90d, "90d")) {
      this.retry(claim, new Date(observedAt), "Managed recovery preflight received malformed 90-day PnL.");
      return;
    }
    if (pnl90d.realizedProfitUsd <= 0) {
      assertCommitted(this.repository.rejectManagedRecoveryPreflight({
        ...this.claimIdentity(claim),
        expectedStep: "PNL_90D",
        reasonCode: "NON_POSITIVE_90D_PNL",
        observedAt,
        expiresAt: claim.expiresAt
      }));
      return;
    }
    assertCommitted(this.repository.saveManagedRecoveryPreflightPartial({
      ...this.claimIdentity(claim),
      expectedStep: "PNL_90D",
      nextStep: "HISTORY",
      observedAt,
      pnl90d
    }));
  }

  private async runHistory(claim: ManagedRecoveryPreflightClaim, attemptedAt: Date): Promise<void> {
    if (
      !claim.pnl30d
      || !validPnl(claim.pnl30d, "30d")
      || claim.pnl30d.realizedProfitUsd <= 0
      || !claim.pnl90d
      || !validPnl(claim.pnl90d, "90d")
      || claim.pnl90d.realizedProfitUsd <= 0
    ) {
      this.retry(claim, attemptedAt, "Managed recovery preflight is missing valid positive PnL state.");
      return;
    }
    const history = await this.history.summarizeHistory(claim.wallet, 90);
    const observedAt = validDate(this.now()).toISOString();
    if (!wellFormedHistory(history, claim.wallet)) {
      this.retry(claim, new Date(observedAt), "Managed recovery preflight history is inconclusive or malformed.");
      return;
    }
    if (history.historyDays < 90) {
      assertCommitted(this.repository.rejectManagedRecoveryPreflight({
        ...this.claimIdentity(claim),
        expectedStep: "HISTORY",
        reasonCode: "INSUFFICIENT_HISTORY",
        observedAt,
        expiresAt: claim.expiresAt
      }));
      return;
    }
    const tags = normalizedTags(history.tags);
    if (tags.some((tag) => DISALLOWED_TAGS.has(tag))) {
      assertCommitted(this.repository.rejectManagedRecoveryPreflight({
        ...this.claimIdentity(claim),
        expectedStep: "HISTORY",
        reasonCode: "DISALLOWED_IDENTITY_TAG",
        observedAt,
        expiresAt: claim.expiresAt
      }));
      return;
    }
    if (history.topTokenProfitShare > 0.35) {
      assertCommitted(this.repository.rejectManagedRecoveryPreflight({
        ...this.claimIdentity(claim),
        expectedStep: "HISTORY",
        reasonCode: "TOP_TOKEN_PROFIT_CONCENTRATION",
        observedAt,
        expiresAt: claim.expiresAt
      }));
      return;
    }
    if (history.topThreeProfitShare > 0.6) {
      assertCommitted(this.repository.rejectManagedRecoveryPreflight({
        ...this.claimIdentity(claim),
        expectedStep: "HISTORY",
        reasonCode: "TOP_THREE_PROFIT_CONCENTRATION",
        observedAt,
        expiresAt: claim.expiresAt
      }));
      return;
    }
    assertCommitted(this.repository.passManagedRecoveryPreflight({
      ...this.claimIdentity(claim),
      expectedStep: "HISTORY",
      validAt: observedAt,
      expiresAt: claim.expiresAt,
      history: { ...history, tags }
    }));
  }

  private validClaim(
    claim: ManagedRecoveryPreflightClaim,
    expected: ManagedRecoveryPreflightWindow
  ): boolean {
    return typeof claim.claimToken === "string"
      && Boolean(claim.claimToken.trim())
      && typeof claim.wallet === "string"
      && Boolean(claim.wallet.trim())
      && claim.policyVersion === expected.policyVersion
      && claim.windowStart === expected.windowStart
      && claim.expiresAt === expected.expiresAt
      && (claim.step === "PNL_30D" || claim.step === "PNL_90D" || claim.step === "HISTORY")
      && Number.isSafeInteger(claim.attempts)
      && claim.attempts >= 1;
  }

  private claimIdentity(claim: ManagedRecoveryPreflightClaim): {
    claimToken: string;
    wallet: PublicKeyString;
    policyVersion: typeof MANAGED_RECOVERY_PREFLIGHT_POLICY;
    windowStart: string;
  } {
    return {
      claimToken: claim.claimToken,
      wallet: claim.wallet,
      policyVersion: MANAGED_RECOVERY_PREFLIGHT_POLICY,
      windowStart: claim.windowStart
    };
  }

  private retry(claim: ManagedRecoveryPreflightClaim, attemptedAt: Date, error: string): void {
    const exponent = Math.max(0, Math.min(20, claim.attempts - 1));
    const delay = Math.min(this.maximumRetryDelayMs, this.retryBaseMs * 2 ** exponent);
    const nextAttemptAt = claim.attempts >= this.maximumAttemptsPerStep
      ? claim.expiresAt
      : new Date(Math.min(
          Date.parse(claim.expiresAt),
          attemptedAt.getTime() + delay
        )).toISOString();
    this.repository.retryManagedRecoveryPreflight({
      ...this.claimIdentity(claim),
      expectedStep: claim.step,
      attemptedAt: attemptedAt.toISOString(),
      nextAttemptAt,
      error: error.slice(0, 500)
    });
  }

  private async safeFence(fence: () => boolean | Promise<boolean>): Promise<boolean> {
    try {
      return await fence();
    } catch {
      return false;
    }
  }
}
