import {
  DEFAULT_BIRDEYE_MONTHLY_CU_BUDGET,
  DEFAULT_TOTAL_HELIUS_MONTHLY_CREDIT_BUDGET,
  DEFAULT_WALLET_INDEX_MONTHLY_CREDIT_BUDGET,
  PAPER_EVALUATION_WALLET_COUNT,
  type WalletAcquisitionBudgetBlocker,
  type WalletAcquisitionBudgetSnapshot,
  type WalletAcquisitionGoal,
  type WalletAcquisitionStatus
} from "@copylab/shared";
import type { Repository } from "./repository.js";

export const WALLET_ACQUISITION_GOAL_SETTING = "wallet_acquisition_goal_v1";
export const WALLET_ACQUISITION_STEPS = [5_000, 10_000, 15_000, 20_000, 25_000] as const;

const MAXIMUM_WALLETS = 25_000 as const;
const HELIUS_RPC_MAXIMUM_ATTEMPTS = 4;
const DEFAULT_SIGNATURE_PAGE_SIZE = 1_000;
const MANAGED_RESEARCH_BATCH_LIMIT = 5;
const MANAGED_HISTORY_MAXIMUM_PAGES = 100;
const HELIUS_WALLET_HISTORY_PAGE_CREDITS = 100;
const HELIUS_WALLET_IDENTITY_CREDITS = 100;
const HELIUS_SOL_PRICE_CREDITS = 10;
const BIRDEYE_CURRENT_COHORT_RESERVE_CU = 6 * 30 + MANAGED_RESEARCH_BATCH_LIMIT * 2 * 30;
// Six leaderboard pages plus 100 research subjects and the frozen-control
// count, each
// with a 30-day and 90-day PnL request. This safely covers a cold weekly cohort.
const BIRDEYE_SCORING_RESERVE_CU =
  6 * 30 + (100 + PAPER_EVALUATION_WALLET_COUNT) * 2 * 30;

export interface PersistedWalletAcquisitionGoal {
  version: 1;
  targetWallets: (typeof WALLET_ACQUISITION_STEPS)[number];
  status: WalletAcquisitionStatus;
  qualifiedWallets: number;
  updatedAt: string;
  budgetBlockers: WalletAcquisitionBudgetBlocker[];
}

export interface WalletAcquisitionControllerOptions {
  now?: () => Date;
  signaturePageSize?: number;
  maximumIndexCreditsPerMonth?: number;
  maximumTotalHeliusCreditsPerMonth?: number;
  maximumBirdeyeCuPerMonth?: number;
}

function monthStart(at: Date): string {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1)).toISOString().slice(0, 10);
}

function nextMonth(at: Date): string {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1)).toISOString();
}

function weekStartIso(at: Date): string {
  const date = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - day + 1);
  return date.toISOString().slice(0, 10);
}

function acquisitionTarget(value: unknown): value is PersistedWalletAcquisitionGoal["targetWallets"] {
  return WALLET_ACQUISITION_STEPS.some((step) => step === value);
}

function validStatus(value: unknown): value is WalletAcquisitionStatus {
  return value === "DRAINING" || value === "ACQUIRING" || value === "WAITING_FOR_FREEZE" ||
    value === "WAITING_FOR_BUDGET" || value === "SATISFIED" || value === "MAXIMUM_REACHED" ||
    value === "SOURCE_EXHAUSTED";
}

function validBlocker(value: unknown): value is WalletAcquisitionBudgetBlocker {
  return value === "BIRDEYE" || value === "HELIUS_INDEX" || value === "HELIUS_TOTAL";
}

function validPersistedState(value: unknown): value is PersistedWalletAcquisitionGoal {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.version === 1 &&
    acquisitionTarget(record.targetWallets) &&
    validStatus(record.status) &&
    typeof record.qualifiedWallets === "number" &&
    Number.isSafeInteger(record.qualifiedWallets) &&
    record.qualifiedWallets >= 0 &&
    typeof record.updatedAt === "string" &&
    Number.isFinite(Date.parse(record.updatedAt)) &&
    Array.isArray(record.budgetBlockers) &&
    record.budgetBlockers.every(validBlocker) &&
    new Set(record.budgetBlockers).size === record.budgetBlockers.length;
}

function initialTarget(indexedWallets: number): PersistedWalletAcquisitionGoal["targetWallets"] {
  let target: PersistedWalletAcquisitionGoal["targetWallets"] = WALLET_ACQUISITION_STEPS[0];
  for (const step of WALLET_ACQUISITION_STEPS) {
    if (indexedWallets >= step) target = step;
  }
  return target;
}

function sameState(
  left: PersistedWalletAcquisitionGoal,
  right: Omit<PersistedWalletAcquisitionGoal, "updatedAt">
): boolean {
  return left.version === right.version &&
    left.targetWallets === right.targetWallets &&
    left.status === right.status &&
    left.qualifiedWallets === right.qualifiedWallets &&
    left.budgetBlockers.join("|") === right.budgetBlockers.join("|");
}

export class WalletAcquisitionController {
  private readonly now: () => Date;
  private readonly signaturePageSize: number;
  private readonly maximumIndexCreditsPerMonth: number;
  private readonly maximumTotalHeliusCreditsPerMonth: number;
  private readonly maximumBirdeyeCuPerMonth: number;

  constructor(
    private readonly repository: Repository,
    options: WalletAcquisitionControllerOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
    this.signaturePageSize = Math.max(
      1,
      Math.min(1_000, Math.trunc(options.signaturePageSize ?? DEFAULT_SIGNATURE_PAGE_SIZE))
    );
    this.maximumIndexCreditsPerMonth = Math.max(
      1,
      Math.trunc(options.maximumIndexCreditsPerMonth ?? DEFAULT_WALLET_INDEX_MONTHLY_CREDIT_BUDGET)
    );
    this.maximumTotalHeliusCreditsPerMonth = Math.max(
      this.maximumIndexCreditsPerMonth,
      Math.trunc(options.maximumTotalHeliusCreditsPerMonth ?? DEFAULT_TOTAL_HELIUS_MONTHLY_CREDIT_BUDGET)
    );
    this.maximumBirdeyeCuPerMonth = Math.max(
      1,
      Math.trunc(options.maximumBirdeyeCuPerMonth ?? DEFAULT_BIRDEYE_MONTHLY_CU_BUDGET)
    );
    this.loadState();
  }

  targetWallets(): PersistedWalletAcquisitionGoal["targetWallets"] {
    return this.loadState().targetWallets;
  }

  /** Fresh stop fence used immediately before every managed discovery page. */
  canDiscoverPage(): boolean {
    const state = this.loadState();
    const qualifiedWallets = this.qualifiedWallets();
    if (this.repository.activePaperEvaluationCohort()) {
      this.persist(state, "SATISFIED", qualifiedWallets, []);
      return false;
    }
    if (qualifiedWallets >= PAPER_EVALUATION_WALLET_COUNT) {
      this.persist(state, "WAITING_FOR_FREEZE", qualifiedWallets, []);
      return false;
    }
    if (!this.managedGenerationDrained()) {
      this.persist(state, "DRAINING", qualifiedWallets, []);
      return false;
    }
    if (state.status === "SOURCE_EXHAUSTED") return false;
    if (this.repository.walletIndexCoverage(this.now()).indexedWallets >= state.targetWallets) return false;
    const blockers = this.budgetBlockers();
    if (blockers.length > 0) {
      this.persist(state, "WAITING_FOR_BUDGET", qualifiedWallets, blockers);
      return false;
    }
    this.persist(state, "ACQUIRING", qualifiedWallets, []);
    return true;
  }

  /** Prevents an extra qualified result from opening another immutable cohort before freeze commits. */
  shouldContinueResearch(): boolean {
    return !this.repository.activePaperEvaluationCohort() &&
      this.qualifiedWallets() < PAPER_EVALUATION_WALLET_COUNT &&
      this.budgetBlockers().length === 0;
  }

  /**
   * Evaluated only after handoff, hydration, managed history, and pre-screen
   * work are drained. Returns true only when the durable target advanced.
   */
  onPipelineDrained(sourceExhausted = false): boolean {
    const state = this.loadState();
    const qualifiedWallets = this.qualifiedWallets();
    if (this.repository.activePaperEvaluationCohort()) {
      this.persist(state, "SATISFIED", qualifiedWallets, []);
      return false;
    }
    if (qualifiedWallets >= PAPER_EVALUATION_WALLET_COUNT) {
      this.persist(state, "WAITING_FOR_FREEZE", qualifiedWallets, []);
      return false;
    }
    if (!this.managedGenerationDrained()) {
      this.persist(state, "DRAINING", qualifiedWallets, []);
      return false;
    }
    const coverage = this.repository.walletIndexCoverage(this.now());
    const blockers = this.budgetBlockers();
    if (coverage.indexedWallets < state.targetWallets) {
      if (sourceExhausted) this.persist(state, "SOURCE_EXHAUSTED", qualifiedWallets, []);
      else if (blockers.length > 0) this.persist(state, "WAITING_FOR_BUDGET", qualifiedWallets, blockers);
      else this.persist(state, "ACQUIRING", qualifiedWallets, []);
      return false;
    }
    if (state.targetWallets === MAXIMUM_WALLETS) {
      this.persist(state, "MAXIMUM_REACHED", qualifiedWallets, blockers);
      return false;
    }
    if (blockers.length > 0) {
      this.persist(state, "WAITING_FOR_BUDGET", qualifiedWallets, blockers);
      return false;
    }
    const index = WALLET_ACQUISITION_STEPS.indexOf(state.targetWallets);
    const next = WALLET_ACQUISITION_STEPS[index + 1];
    if (!next) throw new Error("Wallet acquisition target progression is malformed.");
    const changed = this.persist(state, "ACQUIRING", qualifiedWallets, [], next);
    if (changed) {
      this.repository.audit(
        "wallet_acquisition_target_advanced",
        "The managed wallet universe advanced to its next quota-gated target.",
        {
          priorTargetWallets: state.targetWallets,
          targetWallets: next,
          indexedWallets: coverage.indexedWallets,
          qualifiedWallets,
          budget: this.budgetSnapshot()
        }
      );
    }
    return changed;
  }

  snapshot(): WalletAcquisitionGoal {
    const state = this.loadState();
    const qualifiedWallets = this.qualifiedWallets();
    const budget = this.budgetSnapshot();
    const budgetBlockers = this.blockersForBudget(budget);
    let status = state.status;
    if (this.repository.activePaperEvaluationCohort()) status = "SATISFIED";
    else if (qualifiedWallets >= PAPER_EVALUATION_WALLET_COUNT) status = "WAITING_FOR_FREEZE";
    else if (!this.managedGenerationDrained()) status = "DRAINING";
    else if (status === "WAITING_FOR_BUDGET" && budgetBlockers.length === 0) status = "DRAINING";
    return {
      version: 1,
      targetWallets: state.targetWallets,
      maximumWallets: MAXIMUM_WALLETS,
      qualifiedWallets,
      status,
      updatedAt: state.updatedAt,
      budgetBlockers,
      budget
    };
  }

  private loadState(): PersistedWalletAcquisitionGoal {
    const stored = this.repository.getSetting<unknown>(WALLET_ACQUISITION_GOAL_SETTING);
    if (stored !== undefined) {
      if (!validPersistedState(stored)) {
        throw new Error("Persisted wallet acquisition goal is malformed; managed discovery is fail-closed.");
      }
      return stored;
    }
    const created: PersistedWalletAcquisitionGoal = {
      version: 1,
      targetWallets: initialTarget(this.repository.walletIndexCoverage(this.now()).indexedWallets),
      status: "DRAINING",
      qualifiedWallets: this.qualifiedWallets(),
      updatedAt: this.now().toISOString(),
      budgetBlockers: []
    };
    this.repository.setSetting(WALLET_ACQUISITION_GOAL_SETTING, created);
    this.repository.audit(
      "wallet_acquisition_goal_created",
      "A durable managed wallet-acquisition goal was initialized.",
      created
    );
    return created;
  }

  private persist(
    state: PersistedWalletAcquisitionGoal,
    status: WalletAcquisitionStatus,
    qualifiedWallets: number,
    budgetBlockers: WalletAcquisitionBudgetBlocker[],
    targetWallets: PersistedWalletAcquisitionGoal["targetWallets"] = state.targetWallets
  ): boolean {
    const nextWithoutTime = {
      version: 1 as const,
      targetWallets,
      status,
      qualifiedWallets,
      budgetBlockers: [...new Set(budgetBlockers)]
    };
    if (sameState(state, nextWithoutTime)) return false;
    this.repository.setSetting(WALLET_ACQUISITION_GOAL_SETTING, {
      ...nextWithoutTime,
      updatedAt: this.now().toISOString()
    } satisfies PersistedWalletAcquisitionGoal);
    return true;
  }

  private qualifiedWallets(): number {
    const cohort = this.repository.latestCohort();
    if (!cohort) return 0;
    const scores = new Map(
      this.repository.listWalletScores(cohort.cohortId).map((score) => [score.wallet, score] as const)
    );
    return this.repository.listCandidates(cohort.cohortId)
      .filter((candidate) => !candidate.control && scores.get(candidate.address)?.qualified)
      .length;
  }

  /**
   * A target tranche is not drained merely because its latest 100-wallet
   * cohort reached a managed terminal certificate. The whole frozen-cutoff
   * generation, plus any newer pre-screen survivors already present in the
   * current indexed universe, must be exhausted first.
   */
  private managedGenerationDrained(): boolean {
    if (this.repository.openWalletDeepHistoryCohort()) return false;
    if (this.repository.openWalletDeepHistoryGeneration()) return false;
    const terminal = this.repository.latestTerminalWalletDeepHistoryGeneration();
    return this.repository.listLatestWalletPreScreenSurvivors(
      1,
      terminal?.snapshotCutoffAt
    ).length === 0;
  }

  private budgetBlockers(): WalletAcquisitionBudgetBlocker[] {
    return this.blockersForBudget(this.budgetSnapshot());
  }

  private blockersForBudget(budget: WalletAcquisitionBudgetSnapshot): WalletAcquisitionBudgetBlocker[] {
    const blockers: WalletAcquisitionBudgetBlocker[] = [];
    if (budget.birdeyeRemainingCu < budget.birdeyeScoringReserveCu) blockers.push("BIRDEYE");
    if (budget.heliusIndexRemainingCredits < budget.heliusDiscoveryPageReserveCredits) {
      blockers.push("HELIUS_INDEX");
    }
    if (
      budget.totalHeliusRemainingCredits <
      budget.heliusDiscoveryPageReserveCredits + budget.heliusScoringReserveCredits
    ) blockers.push("HELIUS_TOTAL");
    return blockers;
  }

  private budgetSnapshot(): WalletAcquisitionBudgetSnapshot {
    const at = this.now();
    const start = monthStart(at);
    const usage = new Map(
      this.repository.usageSince(start).map((entry) => [entry.provider, entry] as const)
    );
    const indexUsed = usage.get("helius_index")?.credits ?? 0;
    const totalHeliusUsed = indexUsed + (usage.get("helius")?.credits ?? 0);
    const birdeyeUsed = usage.get("birdeye")?.credits ?? 0;
    // A transient getBlock failure may fall back to individual transaction
    // reads. Reserve both paths and all four physical RPC attempts.
    const possibleBlockReads = Math.ceil(this.signaturePageSize / 2);
    const heliusDiscoveryPageReserveCredits = HELIUS_RPC_MAXIMUM_ATTEMPTS * (
      1 + this.signaturePageSize + possibleBlockReads
    );
    const perWalletScoringCredits =
      MANAGED_HISTORY_MAXIMUM_PAGES * HELIUS_WALLET_HISTORY_PAGE_CREDITS +
      HELIUS_WALLET_IDENTITY_CREDITS +
      HELIUS_SOL_PRICE_CREDITS;
    const currentCohortId = `birdeye-${weekStartIso(at)}`;
    const birdeyeScoringReserveCu = this.repository.latestCohort()?.cohortId === currentCohortId
      ? BIRDEYE_CURRENT_COHORT_RESERVE_CU
      : BIRDEYE_SCORING_RESERVE_CU;
    return {
      monthStart: start,
      nextResetAt: nextMonth(at),
      birdeyeRemainingCu: Math.max(0, this.maximumBirdeyeCuPerMonth - birdeyeUsed),
      heliusIndexRemainingCredits: Math.max(0, this.maximumIndexCreditsPerMonth - indexUsed),
      totalHeliusRemainingCredits: Math.max(0, this.maximumTotalHeliusCreditsPerMonth - totalHeliusUsed),
      birdeyeScoringReserveCu,
      heliusDiscoveryPageReserveCredits,
      heliusScoringReserveCredits: MANAGED_RESEARCH_BATCH_LIMIT * perWalletScoringCredits
    };
  }
}
