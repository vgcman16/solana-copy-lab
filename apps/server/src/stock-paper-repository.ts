import { createHash, randomUUID } from "node:crypto";
import {
  STOCK_PAPER_CAPITAL_EVENT_VERSION,
  STOCK_PAPER_FEATURE_VERSION,
  STOCK_PAPER_LEARNING_VERSION,
  STOCK_PAPER_LABEL,
  STOCK_PAPER_POLICY_VERSION,
  STOCK_PAPER_ROTATION_SHADOW_VERSION,
  type StockPaperAccount,
  type StockPaperArmStats,
  type StockPaperCandidate,
  type StockPaperCapitalEvent,
  type StockPaperDashboard,
  type StockPaperEquityPoint,
  type StockPaperLane,
  type StockPaperMarketStatus,
  type StockPaperMarketPhase,
  type StockPaperObservation,
  type StockPaperObservationOutcome,
  type StockPaperOutcomeHorizonMinutes,
  type StockPaperOutcomeQualitySummary,
  type StockPaperOutcomeSessionPhase,
  type StockPaperOrder,
  type StockPaperOrderEvent,
  type StockPaperPolicy,
  type StockPaperPolicyVersion,
  type StockPaperPosition,
  type StockPaperRotationDecision,
  type StockPaperRotationOutcome,
  type StockPaperRotationSummary,
  type StockPaperSignal,
  type StockPaperShadowPolicyScore,
  type StockPaperStrategyArm,
  type StockPaperTrade,
  type StockPaperLearningV4Summary,
  type StockPaperWalkForwardSummary
} from "@copylab/shared";
import type { AlpacaStockBar } from "@copylab/providers";
import {
  STOCK_V41_EVIDENCE_ACTIVATION_SETTING_KEY,
  type CopyLabDatabase
} from "./database.js";
import {
  DEFAULT_STOCK_PAPER_POLICY,
  adaptiveArmDecision
} from "./stock-paper-policy.js";
import { stockPaperBookResearchSummary } from "./stock-paper-book-research.js";
import {
  FROZEN_STOCK_PAPER_SHADOW_POLICIES_V3,
  stockPaperPolicyDigestV3,
  stockPaperShadowPolicyDigestV3,
  stockPaperShadowPolicySetDigestV3
} from "./stock-paper-learning-v3.js";

const MARKET_STATUS_SETTING_PREFIX = "stock_paper_market_status:";
const LEARNING_V4_SETTING_PREFIX = "stock_paper_learning_v4:";
const OUTCOME_HORIZONS: readonly StockPaperOutcomeHorizonMinutes[] = [15, 45, 180];
const OUTCOME_SESSION_PHASES: readonly StockPaperOutcomeSessionPhase[] = [
  "REGULAR",
  "PREMARKET",
  "AFTER_HOURS",
  "OVERNIGHT"
];
const ARMS: readonly StockPaperStrategyArm[] = [
  "BREAKOUT",
  "OPENING_RANGE",
  "PULLBACK_RECOVERY",
  "VOLUME_SURGE"
];
const STOCK_SHADOW_POLICY_BY_ID = new Map(
  FROZEN_STOCK_PAPER_SHADOW_POLICIES_V3.map((policy) => [policy.id, policy])
);
const STOCK_SHADOW_POLICY_SET_DIGEST = stockPaperShadowPolicySetDigestV3();

// These are display projections only. The complete append-only evidence stays
// in SQLite and continues to feed all accounting, learning, and risk logic.
// Keeping the frequently refreshed dashboard bounded avoids repeatedly
// serializing hundreds of large replay/order records as the PAPER run grows.
const STOCK_PAPER_DASHBOARD_SIGNAL_LIMIT = 30;
const STOCK_PAPER_DASHBOARD_TRADE_LIMIT = 12;
const STOCK_PAPER_DASHBOARD_ORDER_LIMIT = 12;
const STOCK_PAPER_DASHBOARD_EQUITY_SOURCE_LIMIT = 720;
const STOCK_PAPER_DASHBOARD_EQUITY_POINT_LIMIT = 240;
const STOCK_PAPER_OUTCOME_PROJECTION_CACHE_TTL_MS = 60_000;
export const STOCK_PAPER_LEARNING_EVIDENCE_LIMIT = 20_000;

export interface StockPaperLearningEvidenceSample {
  observations: StockPaperObservation[];
  outcomes: StockPaperObservationOutcome[];
}

interface StockPaperOutcomeProjection {
  totalObservations: number;
  totalOutcomes: number;
  labeledOutcomes: number;
  missingOutcomes: number;
  quality: StockPaperOutcomeQualitySummary[];
}

function downsampleDashboardEquity(
  points: StockPaperEquityPoint[],
  limit = STOCK_PAPER_DASHBOARD_EQUITY_POINT_LIMIT
): StockPaperEquityPoint[] {
  if (points.length <= limit || limit < 2) return points;

  // Preserve both endpoints and the account-wide extrema, then distribute the
  // remaining display points evenly over the same source horizon. This keeps
  // the ALL/YTD views honest without shipping every minute-level row.
  const selected = new Set<number>([0, points.length - 1]);
  const extrema = [
    (left: StockPaperEquityPoint, right: StockPaperEquityPoint) => left.navUsd - right.navUsd,
    (left: StockPaperEquityPoint, right: StockPaperEquityPoint) => right.navUsd - left.navUsd,
    (left: StockPaperEquityPoint, right: StockPaperEquityPoint) =>
      right.drawdownPercent - left.drawdownPercent
  ];
  for (const compare of extrema) {
    let best = 0;
    for (let index = 1; index < points.length; index += 1) {
      if (compare(points[index]!, points[best]!) > 0) best = index;
    }
    selected.add(best);
  }
  const evenlySpacedSlots = Math.max(1, limit - selected.size);
  for (let slot = 1; slot <= evenlySpacedSlots && selected.size < limit; slot += 1) {
    selected.add(Math.round(slot * (points.length - 1) / (evenlySpacedSlots + 1)));
  }
  // Rounding can collide with an already-preserved extreme. Fill any remaining
  // slots deterministically rather than returning a surprisingly sparse chart.
  if (selected.size < limit) {
    for (let index = 1; index < points.length - 1 && selected.size < limit; index += 1) {
      selected.add(index);
    }
  }
  return [...selected]
    .sort((left, right) => left - right)
    .map((index) => points[index]!);
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && Number.isFinite(Date.parse(value));
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validProvenanceDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9-]+:[a-f0-9]{64}$/u.test(value);
}

export interface StockPaperCapitalAdjustmentInput {
  laneId: string;
  targetNavUsd: number;
  reason: "USER_REQUESTED_BANKROLL_INCREASE";
  createdAt: string;
}

function validCapitalEvent(event: StockPaperCapitalEvent, laneId: string): boolean {
  return event.laneId === laneId &&
    event.version === STOCK_PAPER_CAPITAL_EVENT_VERSION &&
    event.eventType === "DEPOSIT" &&
    event.reason === "USER_REQUESTED_BANKROLL_INCREASE" &&
    event.paperOnly === true &&
    event.realMoney === false &&
    event.excludedFromTradingPnl === true &&
    validTimestamp(event.createdAt) &&
    finiteNonNegative(event.priorNavUsd) &&
    finiteNonNegative(event.priorCashUsd) &&
    finiteNonNegative(event.priorInitialNavUsd) &&
    finiteNonNegative(event.priorPeakNavUsd) &&
    finiteNonNegative(event.priorDayStartNavUsd) &&
    Number.isFinite(event.deltaUsd) && event.deltaUsd > 0 &&
    Number.isFinite(event.targetNavUsd) && event.targetNavUsd > 0 &&
    Math.abs(event.adjustedNavUsd - event.targetNavUsd) <= 1e-8 &&
    Math.abs(event.adjustedNavUsd - event.priorNavUsd - event.deltaUsd) <= 1e-8 &&
    Math.abs(event.adjustedCashUsd - event.priorCashUsd - event.deltaUsd) <= 1e-8 &&
    Math.abs(event.adjustedInitialNavUsd - event.priorInitialNavUsd - event.deltaUsd) <= 1e-8 &&
    Math.abs(event.adjustedPeakNavUsd - event.priorPeakNavUsd - event.deltaUsd) <= 1e-8 &&
    Math.abs(event.adjustedDayStartNavUsd - event.priorDayStartNavUsd - event.deltaUsd) <= 1e-8 &&
    Math.abs(event.tradingPnlUsdAfter - event.tradingPnlUsdBefore) <= 1e-8 &&
    Number.isFinite(event.cumulativeExternalCapitalUsd) &&
    event.cumulativeExternalCapitalUsd >= event.deltaUsd;
}

function rotationDecisionValidationError(
  decision: StockPaperRotationDecision,
  lane: StockPaperLane,
  options: { strictCurrentPolicy?: boolean } = {}
): string | undefined {
  if (!decision.id.trim() || !decision.idempotencyKey.trim()) return "missing decision identity";
  if (decision.laneId !== lane.id || lane.purpose !== "RESEARCH_ONLY" || lane.status !== "ACTIVE") {
    return "lane is not the active research-only lane";
  }
  if (decision.version !== STOCK_PAPER_ROTATION_SHADOW_VERSION ||
      decision.policy.version !== STOCK_PAPER_ROTATION_SHADOW_VERSION) {
    return "rotation version mismatch";
  }
  if (!validProvenanceDigest(decision.policyDigest) ||
      !validProvenanceDigest(decision.sourcePolicyDigest)) {
    return "policy provenance mismatch";
  }
  if (options.strictCurrentPolicy &&
      decision.sourcePolicyDigest !== stockPaperPolicyDigestV3(lane.policy)) {
    return "source policy is not the active lane policy";
  }
  if (!validTimestamp(decision.idempotencyBucket) || !validTimestamp(decision.decisionAt)) {
    return "invalid decision clock";
  }
  if (decision.status !== "ROTATE" && decision.status !== "HOLD") {
    return "unsupported decision status";
  }
  if (!Array.isArray(decision.reasonCodes)) return "invalid reason codes";
  if (decision.analysisOnly !== true || decision.affectsTrading !== false ||
      decision.promotionEligible !== false || decision.portfolioCounterfactual !== false ||
      decision.resultsAreIndependentOneStepCounterfactuals !== true) {
    return "research-only boundary mismatch";
  }
  if (!finiteNonNegative(decision.preRotationNavUsd) ||
      !finiteNonNegative(decision.preRotationCashUsd) ||
      !finiteNonNegative(decision.preRotationDeployedUsd)) {
    return "invalid pre-rotation account evidence";
  }
  if (decision.status === "ROTATE" && (!decision.outgoing || !decision.incoming)) {
    return "rotation legs are missing";
  }
  return undefined;
}

function rotationOutcomeValidationError(
  outcome: StockPaperRotationOutcome,
  decision: StockPaperRotationDecision
): string | undefined {
  if (!outcome.id.trim() || !outcome.idempotencyKey.trim()) return "missing outcome identity";
  if (outcome.laneId !== decision.laneId || outcome.decisionId !== decision.id) {
    return "outcome decision provenance mismatch";
  }
  if (outcome.version !== STOCK_PAPER_ROTATION_SHADOW_VERSION ||
      ![15, 45, 180].includes(outcome.horizonMinutes)) {
    return "outcome version or horizon mismatch";
  }
  if (outcome.analysisOnly !== true || outcome.affectsTrading !== false ||
      outcome.promotionEligible !== false || outcome.portfolioCounterfactual !== false ||
      outcome.resultsAreIndependentOneStepCounterfactuals !== true) {
    return "research-only boundary mismatch";
  }
  if (!validTimestamp(outcome.dueAt) || !validTimestamp(outcome.labeledAt)) {
    return "invalid outcome clock";
  }
  if (decision.status !== "ROTATE") return "hold decisions cannot produce outcome rows";
  const expectedDueAt = new Date(
    Date.parse(decision.decisionAt) + outcome.horizonMinutes * 60_000
  ).toISOString();
  if (new Date(outcome.dueAt).toISOString() !== expectedDueAt) return "outcome due clock mismatch";
  if (outcome.status === "MISSING") {
    if (!outcome.missingReason) return "missing outcome reason is absent";
    if (outcome.missingReason === "DECISION_DID_NOT_ROTATE") {
      return "rotation outcome reason mismatch";
    }
  } else if (outcome.status === "LABELED") {
    if (outcome.missingReason || !Number.isFinite(outcome.incrementalPnlUsd) ||
        !Number.isFinite(outcome.incrementalReturnPercent)) {
      return "labeled outcome metrics are incomplete";
    }
  } else {
    return "unsupported outcome status";
  }
  return undefined;
}

function shadowScoreValidationError(
  score: StockPaperShadowPolicyScore,
  expected?: { datasetDigest: string; capturedAt: string; policyId?: string }
): string | undefined {
  const policy = STOCK_SHADOW_POLICY_BY_ID.get(score.policyId);
  if (!policy) return "unknown policy";
  if (expected?.policyId && score.policyId !== expected.policyId) return "policy identity mismatch";
  if (score.policyDigest !== stockPaperShadowPolicyDigestV3(policy)) return "stale policy digest";
  if (score.learnerVersion !== STOCK_PAPER_LEARNING_VERSION) return "learner version mismatch";
  if (score.pathsAreIndependentTrades !== false || score.promotionEligible !== false) {
    return "research-only contract mismatch";
  }
  if (expected && score.datasetDigest !== expected.datasetDigest) return "dataset digest mismatch";
  if (expected && score.evaluatedAt !== expected.capturedAt) return "checkpoint clock mismatch";
  if (![15, 45, 180].includes(score.horizonMinutes)) return "unsupported outcome horizon";
  return undefined;
}

function profitFactor(trades: readonly StockPaperTrade[]): number | undefined {
  const profit = trades.reduce((sum, trade) => sum + Math.max(0, trade.pnlUsd), 0);
  const loss = trades.reduce((sum, trade) => sum + Math.max(0, -trade.pnlUsd), 0);
  // Infinity becomes null when serialized to JSON, which is neither the
  // declared number nor an honest value. Omit profit factor until a loss exists.
  if (loss <= 0) return undefined;
  return profit / loss;
}

export interface StockPaperCycleCommit {
  account: StockPaperAccount;
  positions: StockPaperPosition[];
  signals?: StockPaperSignal[];
  trades?: StockPaperTrade[];
  equityPoint: StockPaperEquityPoint;
  candidates?: StockPaperCandidate[];
  bars?: Array<{ symbol: string; bar: AlpacaStockBar }>;
  orders?: StockPaperOrder[];
  orderEvents?: StockPaperOrderEvent[];
  observations?: StockPaperObservation[];
  outcomes?: StockPaperObservationOutcome[];
  shadowResults?: Array<{ id: string; capturedAt: string; score: StockPaperShadowPolicyScore }>;
  newsEvidence?: Array<{
    articleId: string;
    symbol: string;
    createdAt: string;
    observedAt: string;
    evidence: Record<string, unknown>;
  }>;
  market: StockPaperMarketStatus;
}

export interface StockPaperLearningCommit {
  laneId: string;
  checkpointId: string;
  datasetDigest: string;
  evaluationDigest: string;
  capturedAt: string;
  cutoffAt: string;
  walkForward: StockPaperWalkForwardSummary;
  shadowResults: Array<{ id: string; score: StockPaperShadowPolicyScore }>;
}

export interface StockPaperRotationAnalysisCommit {
  laneId: string;
  decisions?: StockPaperRotationDecision[];
  outcomes?: StockPaperRotationOutcome[];
}

export class StockPaperRepository {
  private outcomeProjectionCache:
    | { readonly laneId: string; readonly expiresAt: number; readonly value: StockPaperOutcomeProjection }
    | undefined;

  constructor(private readonly db: CopyLabDatabase) {}

  activeLane(): StockPaperLane | undefined {
    const row = this.db.prepare(`
      SELECT id, label, purpose, policy_version, policy_json, initial_nav_usd,
             status, started_at, updated_at
      FROM stock_paper_lanes
      WHERE status = 'ACTIVE'
      LIMIT 1
    `).get() as {
      id: string;
      label: typeof STOCK_PAPER_LABEL;
      purpose: "RESEARCH_ONLY";
      policy_version: StockPaperPolicyVersion;
      policy_json: string;
      initial_nav_usd: number;
      status: StockPaperLane["status"];
      started_at: string;
      updated_at: string;
    } | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      label: row.label,
      purpose: row.purpose,
      policyVersion: row.policy_version,
      policy: parseJson<StockPaperPolicy>(row.policy_json),
      status: row.status,
      initialNavUsd: row.initial_nav_usd,
      startedAt: row.started_at,
      updatedAt: row.updated_at
    };
  }

  ensureActiveLane(now = new Date().toISOString()): StockPaperLane {
    const active = this.activeLane();
    if (active) {
      if (
        active.policyVersion === STOCK_PAPER_POLICY_VERSION &&
        Object.keys(DEFAULT_STOCK_PAPER_POLICY).every((key) => key in active.policy)
      ) return active;
      const upgraded: StockPaperLane = {
        ...active,
        policyVersion: STOCK_PAPER_POLICY_VERSION,
        policy: { ...DEFAULT_STOCK_PAPER_POLICY, ...active.policy },
        updatedAt: now
      };
      this.db.prepare(`
        UPDATE stock_paper_lanes
        SET policy_version = ?, policy_json = ?, updated_at = ?
        WHERE id = ? AND status = 'ACTIVE'
      `).run(
        upgraded.policyVersion,
        JSON.stringify(upgraded.policy),
        now,
        upgraded.id
      );
      return upgraded;
    }
    const lane: StockPaperLane = {
      id: `stock-paper:${randomUUID()}`,
      label: STOCK_PAPER_LABEL,
      purpose: "RESEARCH_ONLY",
      policyVersion: STOCK_PAPER_POLICY_VERSION,
      policy: { ...DEFAULT_STOCK_PAPER_POLICY },
      status: "ACTIVE",
      initialNavUsd: DEFAULT_STOCK_PAPER_POLICY.initialNavUsd,
      startedAt: now,
      updatedAt: now
    };
    const account: StockPaperAccount = {
      laneId: lane.id,
      initialNavUsd: lane.initialNavUsd,
      cashUsd: lane.initialNavUsd,
      navUsd: lane.initialNavUsd,
      peakNavUsd: lane.initialNavUsd,
      deployedUsd: 0,
      realizedPnlUsd: 0,
      unrealizedPnlUsd: 0,
      maxDrawdownPercent: 0,
      openPositions: 0,
      completedTrades: 0,
      winningTrades: 0,
      grossProfitUsd: 0,
      grossLossUsd: 0,
      pricingComplete: true,
      dayKey: now.slice(0, 10),
      dayStartNavUsd: lane.initialNavUsd,
      updatedAt: now
    };
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO stock_paper_lanes(
          id, label, purpose, policy_version, policy_json, initial_nav_usd,
          status, started_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)
      `).run(
        lane.id,
        lane.label,
        lane.purpose,
        lane.policyVersion,
        JSON.stringify(lane.policy),
        lane.initialNavUsd,
        now,
        now
      );
      this.db.prepare(`
        INSERT INTO stock_paper_accounts(lane_id, account_json, updated_at)
        VALUES (?, ?, ?)
      `).run(lane.id, JSON.stringify(account), now);
    })();
    return lane;
  }

  account(laneId: string): StockPaperAccount | undefined {
    const row = this.db.prepare(`
      SELECT account_json FROM stock_paper_accounts WHERE lane_id = ?
    `).get(laneId) as { account_json: string } | undefined;
    return row ? parseJson<StockPaperAccount>(row.account_json) : undefined;
  }

  capitalEvents(laneId: string, limit = 100): StockPaperCapitalEvent[] {
    const rows = this.db.prepare(`
      SELECT event_json
      FROM stock_paper_capital_events
      WHERE lane_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(laneId, Math.max(0, Math.min(10_000, Math.trunc(limit)))) as Array<{
      event_json: string;
    }>;
    return rows.flatMap((row): StockPaperCapitalEvent[] => {
      try {
        const event = parseJson<StockPaperCapitalEvent>(row.event_json);
        return validCapitalEvent(event, laneId) ? [event] : [];
      } catch {
        return [];
      }
    });
  }

  cumulativeExternalCapitalUsd(laneId: string): number {
    const row = this.db.prepare(`
      SELECT COALESCE(SUM(delta_usd), 0) AS total
      FROM stock_paper_capital_events
      WHERE lane_id = ?
    `).get(laneId) as { total: number };
    return Number.isFinite(row.total) && row.total > 0 ? row.total : 0;
  }

  /** Adds simulated cash until the isolated PAPER account reaches an explicit
   * target NAV. The same delta is added to every profit/drawdown baseline, so
   * the cash flow cannot be reported as trading performance. */
  adjustCapitalToTarget(input: StockPaperCapitalAdjustmentInput): StockPaperCapitalEvent {
    if (!validTimestamp(input.createdAt)) {
      throw new Error("The stock PAPER capital-adjustment time is invalid.");
    }
    const createdAt = new Date(input.createdAt).toISOString();
    if (!Number.isFinite(input.targetNavUsd) || input.targetNavUsd <= 0) {
      throw new Error("The stock PAPER target NAV must be a positive finite amount.");
    }
    const targetNavUsd = Math.round(input.targetNavUsd * 100) / 100;
    if (Math.abs(targetNavUsd - input.targetNavUsd) > 1e-8) {
      throw new Error("The stock PAPER target NAV must be expressed to whole cents.");
    }
    if (input.reason !== "USER_REQUESTED_BANKROLL_INCREASE") {
      throw new Error("The stock PAPER capital-adjustment reason is unsupported.");
    }
    const targetCents = Math.round(targetNavUsd * 100);
    const idempotencyKey = [
      STOCK_PAPER_CAPITAL_EVENT_VERSION,
      input.laneId,
      "target-cents",
      targetCents
    ].join(":");
    const id = `stock-paper-capital:${createHash("sha256")
      .update(idempotencyKey)
      .digest("hex")}`;

    return this.db.transaction(() => {
      const existing = this.db.prepare(`
        SELECT event_json
        FROM stock_paper_capital_events
        WHERE id = ? OR idempotency_key = ?
        LIMIT 1
      `).get(id, idempotencyKey) as { event_json: string } | undefined;
      if (existing) {
        const event = parseJson<StockPaperCapitalEvent>(existing.event_json);
        if (!validCapitalEvent(event, input.laneId) ||
            Math.abs(event.targetNavUsd - targetNavUsd) > 1e-8) {
          throw new Error("The stock PAPER capital-event identity collided with different evidence.");
        }
        return event;
      }

      const lane = this.activeLane();
      if (!lane || lane.id !== input.laneId || lane.purpose !== "RESEARCH_ONLY" ||
          lane.status !== "ACTIVE") {
        throw new Error("Stock PAPER capital can change only on the active research-only lane.");
      }
      const account = this.account(lane.id);
      if (!account) throw new Error("The active stock PAPER account does not exist.");
      if (!Number.isFinite(account.navUsd) || !Number.isFinite(account.cashUsd) ||
          !Number.isFinite(account.initialNavUsd) || !Number.isFinite(account.peakNavUsd) ||
          !Number.isFinite(account.dayStartNavUsd)) {
        throw new Error("The stock PAPER account cannot accept capital with invalid balance evidence.");
      }
      if (targetNavUsd <= account.navUsd + 1e-8) {
        throw new Error("Stock PAPER capital adjustments may only increase the current NAV.");
      }

      const deltaUsd = targetNavUsd - account.navUsd;
      const adjustedInitialNavUsd = account.initialNavUsd + deltaUsd;
      const adjustedAccount: StockPaperAccount = {
        ...account,
        initialNavUsd: adjustedInitialNavUsd,
        cashUsd: account.cashUsd + deltaUsd,
        navUsd: targetNavUsd,
        executableNavUsd: (account.executableNavUsd ?? account.navUsd) + deltaUsd,
        ...(account.fairNavUsd !== undefined
          ? { fairNavUsd: account.fairNavUsd + deltaUsd }
          : {}),
        peakNavUsd: account.peakNavUsd + deltaUsd,
        dayStartNavUsd: account.dayStartNavUsd + deltaUsd,
        updatedAt: createdAt
      };
      const tradingPnlUsd = account.realizedPnlUsd + account.unrealizedPnlUsd;
      const cumulativeExternalCapitalUsd = this.cumulativeExternalCapitalUsd(lane.id) + deltaUsd;
      const event: StockPaperCapitalEvent = {
        id,
        idempotencyKey,
        laneId: lane.id,
        version: STOCK_PAPER_CAPITAL_EVENT_VERSION,
        eventType: "DEPOSIT",
        reason: input.reason,
        paperOnly: true,
        realMoney: false,
        excludedFromTradingPnl: true,
        targetNavUsd,
        deltaUsd,
        priorNavUsd: account.navUsd,
        adjustedNavUsd: adjustedAccount.navUsd,
        priorCashUsd: account.cashUsd,
        adjustedCashUsd: adjustedAccount.cashUsd,
        priorInitialNavUsd: account.initialNavUsd,
        adjustedInitialNavUsd,
        priorPeakNavUsd: account.peakNavUsd,
        adjustedPeakNavUsd: adjustedAccount.peakNavUsd,
        priorDayStartNavUsd: account.dayStartNavUsd,
        adjustedDayStartNavUsd: adjustedAccount.dayStartNavUsd,
        tradingPnlUsdBefore: tradingPnlUsd,
        tradingPnlUsdAfter: adjustedAccount.realizedPnlUsd + adjustedAccount.unrealizedPnlUsd,
        cumulativeExternalCapitalUsd,
        createdAt
      };
      if (!validCapitalEvent(event, lane.id)) {
        throw new Error("The stock PAPER capital event failed its invariant checks.");
      }

      const adjustedPolicy: StockPaperPolicy = {
        ...lane.policy,
        initialNavUsd: adjustedInitialNavUsd
      };
      const laneUpdate = this.db.prepare(`
        UPDATE stock_paper_lanes
        SET policy_json = ?, initial_nav_usd = ?, updated_at = ?
        WHERE id = ? AND status = 'ACTIVE'
      `).run(JSON.stringify(adjustedPolicy), adjustedInitialNavUsd, createdAt, lane.id);
      if (laneUpdate.changes !== 1) {
        throw new Error("The stock PAPER lane changed during the capital adjustment.");
      }
      const accountUpdate = this.db.prepare(`
        UPDATE stock_paper_accounts
        SET account_json = ?, updated_at = ?
        WHERE lane_id = ?
      `).run(JSON.stringify(adjustedAccount), createdAt, lane.id);
      if (accountUpdate.changes !== 1) {
        throw new Error("The stock PAPER account changed during the capital adjustment.");
      }
      this.db.prepare(`
        INSERT INTO stock_paper_capital_events(
          id, idempotency_key, lane_id, event_type, delta_usd,
          target_nav_usd, created_at, event_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        event.id,
        event.idempotencyKey,
        event.laneId,
        event.eventType,
        event.deltaUsd,
        event.targetNavUsd,
        event.createdAt,
        JSON.stringify(event)
      );
      return event;
    })();
  }

  positions(laneId: string, openOnly = false, limit = 500): StockPaperPosition[] {
    const rows = this.db.prepare(`
      SELECT position_json
      FROM stock_paper_positions
      WHERE lane_id = ? ${openOnly ? "AND status IN ('OPEN', 'UNPRICED')" : ""}
      ORDER BY updated_at DESC, id DESC
      LIMIT ?
    `).all(laneId, limit) as Array<{ position_json: string }>;
    return rows.map((row) => parseJson<StockPaperPosition>(row.position_json));
  }

  trades(laneId: string, limit = 100): StockPaperTrade[] {
    return (this.db.prepare(`
      SELECT trade_json
      FROM stock_paper_trades
      WHERE lane_id = ?
      ORDER BY closed_at DESC, id DESC
      LIMIT ?
    `).all(laneId, limit) as Array<{ trade_json: string }>)
      .map((row) => parseJson<StockPaperTrade>(row.trade_json));
  }

  signals(laneId: string, limit = 100): StockPaperSignal[] {
    return (this.db.prepare(`
      SELECT signal_json
      FROM stock_paper_signals
      WHERE lane_id = ?
      ORDER BY observed_at DESC, id DESC
      LIMIT ?
    `).all(laneId, limit) as Array<{ signal_json: string }>)
      .map((row) => parseJson<StockPaperSignal>(row.signal_json));
  }

  candidates(laneId: string, limit = 40): StockPaperCandidate[] {
    return (this.db.prepare(`
      SELECT candidate_json
      FROM stock_paper_candidates
      WHERE lane_id = ?
      ORDER BY eligible DESC, score DESC, symbol
      LIMIT ?
    `).all(laneId, limit) as Array<{ candidate_json: string }>)
      .map((row) => parseJson<StockPaperCandidate>(row.candidate_json));
  }

  orders(laneId: string, limit = 100): StockPaperOrder[] {
    return (this.db.prepare(`
      SELECT order_json
      FROM stock_paper_orders
      WHERE lane_id = ?
      ORDER BY updated_at DESC, id DESC
      LIMIT ?
    `).all(laneId, limit) as Array<{ order_json: string }>)
      .map((row) => parseJson<StockPaperOrder>(row.order_json));
  }

  pendingOrders(laneId: string): StockPaperOrder[] {
    return (this.db.prepare(`
      SELECT order_json
      FROM stock_paper_orders
      WHERE lane_id = ? AND status IN ('SUBMITTED', 'PARTIAL')
      ORDER BY submitted_at, id
    `).all(laneId) as Array<{ order_json: string }>)
      .map((row) => parseJson<StockPaperOrder>(row.order_json));
  }

  orderEvents(laneId: string, orderId?: string, limit = 500): StockPaperOrderEvent[] {
    const rows = orderId
      ? this.db.prepare(`
          SELECT event_json
          FROM stock_paper_order_events
          WHERE lane_id = ? AND order_id = ?
          ORDER BY event_sequence
          LIMIT ?
        `).all(laneId, orderId, limit)
      : this.db.prepare(`
          SELECT event_json
          FROM stock_paper_order_events
          WHERE lane_id = ?
          ORDER BY decision_at DESC, id DESC
          LIMIT ?
        `).all(laneId, limit);
    return (rows as Array<{ event_json: string }>)
      .map((row) => parseJson<StockPaperOrderEvent>(row.event_json));
  }

  v41EvidenceActivationAt(): string | undefined {
    const row = this.db.prepare("SELECT value_json FROM settings WHERE key = ?")
      .get(STOCK_V41_EVIDENCE_ACTIVATION_SETTING_KEY) as { value_json: string } | undefined;
    if (!row) return undefined;
    const value = parseJson<{ activatedAt?: unknown }>(row.value_json);
    return typeof value.activatedAt === "string" && Number.isFinite(Date.parse(value.activatedAt))
      ? new Date(value.activatedAt).toISOString()
      : undefined;
  }

  observationsDue(
    laneId: string,
    horizonMinutes: 15 | 45 | 180,
    dueBefore: string,
    limit = 500
  ): StockPaperObservation[] {
    return (this.db.prepare(`
      SELECT observation_json
      FROM stock_paper_observations observation
      WHERE observation.lane_id = ?
        AND observation.observed_at <= ?
        AND NOT EXISTS (
          SELECT 1
          FROM stock_paper_observation_outcomes outcome
          WHERE outcome.observation_id = observation.id
            AND outcome.horizon_minutes = ?
        )
      ORDER BY observation.observed_at, observation.id
      LIMIT ?
    `).all(laneId, dueBefore, horizonMinutes, limit) as Array<{ observation_json: string }>)
      .map((row) => parseJson<StockPaperObservation>(row.observation_json));
  }

  observationOutcomes(laneId: string, limit = 10_000): StockPaperObservationOutcome[] {
    return (this.db.prepare(`
      SELECT outcome_json
      FROM stock_paper_observation_outcomes
      WHERE lane_id = ?
      ORDER BY labeled_at DESC, observation_id, horizon_minutes
      LIMIT ?
    `).all(laneId, limit) as Array<{ outcome_json: string }>)
      .map((row) => parseJson<StockPaperObservationOutcome>(row.outcome_json));
  }

  observations(laneId: string, limit = 10_000): StockPaperObservation[] {
    return (this.db.prepare(`
      SELECT observation_json
      FROM stock_paper_observations
      WHERE lane_id = ?
      ORDER BY observed_at DESC, id DESC
      LIMIT ?
    `).all(laneId, limit) as Array<{ observation_json: string }>)
      .map((row) => parseJson<StockPaperObservation>(row.observation_json));
  }

  /**
   * Returns a bounded, deterministic sample across the complete chronological
   * learning ledger. The old newest-N read eventually erased early evidence
   * days as new rows crossed the limit. This sampler keeps the first evidence
   * row from every UTC day and distributes the remaining capacity over the
   * full timeline. Both endpoints of every UTC evidence day are anchors when
   * capacity permits. If there are more anchors than capacity, the absolute
   * oldest and newest observations remain fixed while the interior anchors are
   * sampled across the full range. Outcomes are joined to those exact sampled
   * identities, so the observation and label cohorts cannot drift apart.
   *
   * The temporary id table is connection-local and the transaction is fully
   * synchronous. Canonical source rows are never changed or deleted.
   */
  learningEvidenceSample(
    laneId: string,
    limit = STOCK_PAPER_LEARNING_EVIDENCE_LIMIT
  ): StockPaperLearningEvidenceSample {
    if (!Number.isSafeInteger(limit) || limit < 2) {
      throw new RangeError("Stock PAPER learning evidence limit must be a safe integer of at least two.");
    }
    return this.db.transaction(() => {
      this.db.exec(`
        CREATE TEMP TABLE IF NOT EXISTS stock_paper_learning_sample_ids(
          id TEXT PRIMARY KEY
        ) WITHOUT ROWID;
        DELETE FROM stock_paper_learning_sample_ids;
      `);
      this.db.prepare(`
        WITH normalized AS (
          SELECT id, observed_at, substr(observed_at, 1, 10) AS evidence_day
          FROM stock_paper_observations INDEXED BY stock_paper_observations_due
          WHERE lane_id = @laneId
        ),
        day_ranked AS (
          SELECT id, observed_at, evidence_day,
                 row_number() OVER (
                   PARTITION BY evidence_day ORDER BY observed_at, id
                 ) AS day_row,
                 count(*) OVER (PARTITION BY evidence_day) AS rows_in_day
          FROM normalized
        ),
        anchors AS (
          SELECT id, observed_at
          FROM day_ranked
          WHERE day_row = 1 OR day_row = rows_in_day
        ),
        parameters AS (
          SELECT count(*) AS anchor_count
          FROM anchors
        ),
        day_anchor_ranked AS (
          SELECT id, observed_at,
                 row_number() OVER (ORDER BY observed_at, id) AS anchor_row,
                 count(*) OVER () AS total_anchors
          FROM anchors
        ),
        middle_anchor_ranked AS (
          SELECT id, observed_at,
                 ntile(max(1, @limit - 2)) OVER (
                   ORDER BY observed_at, id
                 ) AS bucket
          FROM day_anchor_ranked
          WHERE anchor_row > 1 AND anchor_row < total_anchors
            AND (SELECT anchor_count FROM parameters) > @limit
            AND @limit > 2
        ),
        middle_anchor_sampled AS (
          SELECT id, observed_at,
                 row_number() OVER (
                   PARTITION BY bucket ORDER BY observed_at, id
                 ) AS bucket_row
          FROM middle_anchor_ranked
        ),
        remaining_ranked AS (
          SELECT id, observed_at,
                 ntile(max(1, @limit - (SELECT anchor_count FROM parameters))) OVER (
                   ORDER BY observed_at, id
                 ) AS bucket
          FROM day_ranked
          WHERE day_row > 1 AND day_row < rows_in_day
            AND (SELECT anchor_count FROM parameters) < @limit
        ),
        remaining_sampled AS (
          SELECT id,
                 row_number() OVER (
                   PARTITION BY bucket ORDER BY observed_at, id
                 ) AS bucket_row
          FROM remaining_ranked
        ),
        sampled AS (
          SELECT id
          FROM anchors
          WHERE (SELECT anchor_count FROM parameters) <= @limit
          UNION ALL
          SELECT id
          FROM day_anchor_ranked
          WHERE (SELECT anchor_count FROM parameters) > @limit
            AND (anchor_row = 1 OR anchor_row = total_anchors)
          UNION ALL
          SELECT id
          FROM middle_anchor_sampled
          WHERE bucket_row = 1
          UNION ALL
          SELECT id
          FROM remaining_sampled
          WHERE bucket_row = 1
        )
        INSERT INTO stock_paper_learning_sample_ids(id)
        SELECT id FROM sampled
      `).run({ laneId, limit });

      const observations = (this.db.prepare(`
        SELECT observation.observation_json
        FROM stock_paper_observations observation
        JOIN stock_paper_learning_sample_ids sample ON sample.id = observation.id
        WHERE observation.lane_id = ?
        ORDER BY observation.observed_at, observation.id
      `).all(laneId) as Array<{ observation_json: string }>)
        .map((row) => parseJson<StockPaperObservation>(row.observation_json));
      const outcomes = (this.db.prepare(`
        SELECT outcome.outcome_json
        FROM stock_paper_observation_outcomes outcome
        JOIN stock_paper_learning_sample_ids sample ON sample.id = outcome.observation_id
        WHERE outcome.lane_id = ?
        ORDER BY outcome.labeled_at, outcome.observation_id, outcome.horizon_minutes
      `).all(laneId) as Array<{ outcome_json: string }>)
        .map((row) => parseJson<StockPaperObservationOutcome>(row.outcome_json));
      this.db.exec("DELETE FROM stock_paper_learning_sample_ids;");
      return { observations, outcomes };
    })();
  }

  observationIdsSince(laneId: string, since: string): Set<string> {
    return new Set((this.db.prepare(`
      SELECT id
      FROM stock_paper_observations
      WHERE lane_id = ? AND observed_at >= ?
    `).all(laneId, since) as Array<{ id: string }>).map((row) => row.id));
  }

  commitRotationAnalysis(input: StockPaperRotationAnalysisCommit): void {
    const decisions = input.decisions ?? [];
    const outcomes = input.outcomes ?? [];
    if (decisions.length === 0 && outcomes.length === 0) {
      throw new Error("A stock PAPER rotation-analysis commit cannot be empty.");
    }
    const lane = this.activeLane();
    if (!lane || lane.id !== input.laneId || lane.purpose !== "RESEARCH_ONLY") {
      throw new Error("Stock PAPER rotation analysis requires the active research-only lane.");
    }
    for (const decision of decisions) {
      const error = rotationDecisionValidationError(decision, lane, { strictCurrentPolicy: true });
      if (error) throw new Error(`Invalid stock PAPER rotation decision: ${error}.`);
    }

    const insertDecision = this.db.prepare(`
      INSERT INTO stock_paper_rotation_decisions(
        id, idempotency_key, lane_id, policy_digest, idempotency_bucket,
        decision_at, status, decision_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertOutcome = this.db.prepare(`
      INSERT INTO stock_paper_rotation_outcomes(
        id, idempotency_key, decision_id, lane_id, horizon_minutes,
        status, due_at, labeled_at, outcome_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.db.transaction(() => {
      for (const decision of decisions) {
        const decisionJson = JSON.stringify(decision);
        const prior = this.db.prepare(`
          SELECT decision_json
          FROM stock_paper_rotation_decisions
          WHERE id = ? OR idempotency_key = ?
             OR (lane_id = ? AND policy_digest = ? AND idempotency_bucket = ?)
          LIMIT 1
        `).get(
          decision.id,
          decision.idempotencyKey,
          decision.laneId,
          decision.policyDigest,
          decision.idempotencyBucket
        ) as { decision_json: string } | undefined;
        if (prior) {
          if (prior.decision_json !== decisionJson) {
            throw new Error("A stock PAPER rotation-decision identity collided with different evidence.");
          }
          continue;
        }
        insertDecision.run(
          decision.id,
          decision.idempotencyKey,
          decision.laneId,
          decision.policyDigest,
          decision.idempotencyBucket,
          decision.decisionAt,
          decision.status,
          decisionJson
        );
      }

      for (const outcome of outcomes) {
        const decisionRow = this.db.prepare(`
          SELECT decision_json
          FROM stock_paper_rotation_decisions
          WHERE id = ? AND lane_id = ?
          LIMIT 1
        `).get(outcome.decisionId, input.laneId) as { decision_json: string } | undefined;
        if (!decisionRow) {
          throw new Error("A stock PAPER rotation outcome has no committed source decision.");
        }
        let decision: StockPaperRotationDecision;
        try {
          decision = parseJson<StockPaperRotationDecision>(decisionRow.decision_json);
        } catch {
          throw new Error("A stock PAPER rotation outcome references unreadable decision evidence.");
        }
        const decisionError = rotationDecisionValidationError(decision, lane);
        if (decisionError) {
          throw new Error(`A stock PAPER rotation outcome references invalid decision evidence: ${decisionError}.`);
        }
        const outcomeError = rotationOutcomeValidationError(outcome, decision);
        if (outcomeError) throw new Error(`Invalid stock PAPER rotation outcome: ${outcomeError}.`);

        const outcomeJson = JSON.stringify(outcome);
        const prior = this.db.prepare(`
          SELECT outcome_json
          FROM stock_paper_rotation_outcomes
          WHERE id = ? OR idempotency_key = ?
             OR (decision_id = ? AND horizon_minutes = ?)
          LIMIT 1
        `).get(
          outcome.id,
          outcome.idempotencyKey,
          outcome.decisionId,
          outcome.horizonMinutes
        ) as { outcome_json: string } | undefined;
        if (prior) {
          if (prior.outcome_json !== outcomeJson) {
            throw new Error("A stock PAPER rotation-outcome identity collided with different evidence.");
          }
          continue;
        }
        insertOutcome.run(
          outcome.id,
          outcome.idempotencyKey,
          outcome.decisionId,
          outcome.laneId,
          outcome.horizonMinutes,
          outcome.status,
          outcome.dueAt,
          outcome.labeledAt,
          outcomeJson
        );
      }
    })();
  }

  rotationDecisionsDue(
    laneId: string,
    horizonMinutes: StockPaperOutcomeHorizonMinutes,
    dueBefore: string,
    limit = 500
  ): StockPaperRotationDecision[] {
    if (![15, 45, 180].includes(horizonMinutes) || !validTimestamp(dueBefore)) return [];
    const lane = this.activeLane();
    if (!lane || lane.id !== laneId) return [];
    const rows = this.db.prepare(`
      SELECT decision_json
      FROM stock_paper_rotation_decisions decision
      WHERE decision.lane_id = ?
        AND decision.status = 'ROTATE'
        AND decision.decision_at <= ?
        AND NOT EXISTS (
          SELECT 1
          FROM stock_paper_rotation_outcomes outcome
          WHERE outcome.decision_id = decision.id
            AND outcome.horizon_minutes = ?
        )
      ORDER BY decision.decision_at, decision.id
      LIMIT ?
    `).all(laneId, dueBefore, horizonMinutes, limit) as Array<{ decision_json: string }>;
    return rows.flatMap((row): StockPaperRotationDecision[] => {
      try {
        const decision = parseJson<StockPaperRotationDecision>(row.decision_json);
        return rotationDecisionValidationError(decision, lane) ? [] : [decision];
      } catch {
        return [];
      }
    });
  }

  recentRotationDecisions(laneId: string, limit = 100): StockPaperRotationDecision[] {
    const lane = this.activeLane();
    if (!lane || lane.id !== laneId) return [];
    const rows = this.db.prepare(`
      SELECT decision_json
      FROM stock_paper_rotation_decisions
      WHERE lane_id = ?
      ORDER BY decision_at DESC, id DESC
      LIMIT ?
    `).all(laneId, limit) as Array<{ decision_json: string }>;
    return rows.flatMap((row): StockPaperRotationDecision[] => {
      try {
        const decision = parseJson<StockPaperRotationDecision>(row.decision_json);
        return rotationDecisionValidationError(decision, lane) ? [] : [decision];
      } catch {
        return [];
      }
    });
  }

  recentRotationOutcomes(laneId: string, limit = 300): StockPaperRotationOutcome[] {
    const lane = this.activeLane();
    if (!lane || lane.id !== laneId) return [];
    const rows = this.db.prepare(`
      SELECT outcome.outcome_json, decision.decision_json
      FROM stock_paper_rotation_outcomes outcome
      JOIN stock_paper_rotation_decisions decision
        ON decision.id = outcome.decision_id AND decision.lane_id = outcome.lane_id
      WHERE outcome.lane_id = ?
      ORDER BY outcome.labeled_at DESC, outcome.id DESC
      LIMIT ?
    `).all(laneId, limit) as Array<{ outcome_json: string; decision_json: string }>;
    return rows.flatMap((row): StockPaperRotationOutcome[] => {
      try {
        const decision = parseJson<StockPaperRotationDecision>(row.decision_json);
        const outcome = parseJson<StockPaperRotationOutcome>(row.outcome_json);
        return rotationDecisionValidationError(decision, lane) ||
          rotationOutcomeValidationError(outcome, decision)
          ? []
          : [outcome];
      } catch {
        return [];
      }
    });
  }

  rotationSummary(laneId: string, recentLimit = 20): StockPaperRotationSummary | undefined {
    // One decision every fifteen minutes remains comfortably below these
    // bounds for the full observation-retention horizon. Invalid/tampered JSON
    // is omitted instead of contributing scalar columns to the summary.
    const decisions = this.recentRotationDecisions(laneId, 20_000);
    const outcomes = this.recentRotationOutcomes(laneId, 60_000);
    if (decisions.length === 0 && outcomes.length === 0) return undefined;
    const labeled = outcomes.filter((outcome) => outcome.status === "LABELED");
    const missing = outcomes.filter((outcome) => outcome.status === "MISSING");
    const wins = labeled.filter((outcome) => (outcome.incrementalPnlUsd ?? 0) > 0).length;
    const meanPnl = labeled.length > 0
      ? labeled.reduce((sum, outcome) => sum + (outcome.incrementalPnlUsd ?? 0), 0) / labeled.length
      : 0;
    const meanReturn = labeled.length > 0
      ? labeled.reduce((sum, outcome) => sum + (outcome.incrementalReturnPercent ?? 0), 0) /
        labeled.length
      : 0;
    const updatedAt = [...decisions.map((decision) => decision.decisionAt),
      ...outcomes.map((outcome) => outcome.labeledAt)]
      .sort((left, right) => right.localeCompare(left))[0]!;
    return {
      version: STOCK_PAPER_ROTATION_SHADOW_VERSION,
      analysisOnly: true,
      affectsTrading: false,
      promotionEligible: false,
      portfolioCounterfactual: false,
      resultsAreIndependentOneStepCounterfactuals: true,
      compoundedPortfolioNavAvailable: false,
      evaluatedDecisions: decisions.length,
      proposedRotations: decisions.filter((decision) => decision.status === "ROTATE").length,
      heldDecisions: decisions.filter((decision) => decision.status === "HOLD").length,
      labeledOutcomes: labeled.length,
      missingOutcomes: missing.length,
      incrementalWins: wins,
      incrementalWinRatePercent: labeled.length > 0 ? wins / labeled.length * 100 : 0,
      meanIncrementalPnlUsd: meanPnl,
      meanIncrementalReturnPercent: meanReturn,
      recentDecisions: decisions.slice(0, Math.max(0, recentLimit)),
      recentOutcomes: outcomes.slice(0, Math.max(0, recentLimit)),
      updatedAt
    };
  }

  commitLearningV4Summary(laneId: string, summary: StockPaperLearningV4Summary): void {
    const lane = this.activeLane();
    if (!lane || lane.id !== laneId) {
      throw new Error("Stock PAPER v4 analysis lane is not the active research lane.");
    }
    if (!summary.analysisOnly || summary.affectsTrading || summary.promotionEligible) {
      throw new Error("Stock PAPER v4 analysis attempted to cross its research-only boundary.");
    }
    if (!/^[a-f0-9]{64}$/u.test(summary.evidenceDigest) ||
        !/^[a-f0-9]{64}$/u.test(summary.datasetDigest) ||
        !/^[a-f0-9]{64}$/u.test(summary.outputDigest)) {
      throw new Error("Stock PAPER v4 analysis provenance digests are invalid.");
    }
    const value = JSON.stringify(summary);
    const artifactKey = `${LEARNING_V4_SETTING_PREFIX}${laneId}:artifact:${summary.outputDigest}`;
    const latestKey = `${LEARNING_V4_SETTING_PREFIX}${laneId}:latest`;
    const prior = this.db.prepare(`
      SELECT value_json FROM settings WHERE key = ?
    `).get(artifactKey) as { value_json: string } | undefined;
    if (prior) {
      const priorSummary = parseJson<StockPaperLearningV4Summary>(prior.value_json);
      if (priorSummary.outputDigest !== summary.outputDigest || prior.value_json !== value) {
        throw new Error("A stock PAPER v4 output digest collided with different analysis evidence.");
      }
    }
    const latest = this.latestLearningV4Summary(laneId);
    // Evidence and dataset digests identify the inputs, not the analyzer
    // artifact. A new analyzer version or configuration can legitimately
    // produce a different immutable output from identical inputs. Only an
    // exact, already-validated output identity is idempotent here.
    if (latest?.outputDigest === summary.outputDigest) return;
    const commit = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO settings(key, value_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO NOTHING
      `).run(artifactKey, value, summary.cutoffAt);
      this.db.prepare(`
        INSERT INTO settings(key, value_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value_json = excluded.value_json,
          updated_at = excluded.updated_at
      `).run(latestKey, JSON.stringify({ outputDigest: summary.outputDigest }), summary.cutoffAt);
    });
    commit();
  }

  private latestLearningV4Summary(laneId: string): StockPaperLearningV4Summary | undefined {
    const pointerRow = this.db.prepare(`
      SELECT value_json FROM settings WHERE key = ?
    `).get(`${LEARNING_V4_SETTING_PREFIX}${laneId}:latest`) as { value_json: string } | undefined;
    if (!pointerRow) return undefined;
    const pointer = parseJson<{ outputDigest?: string }>(pointerRow.value_json);
    if (!pointer.outputDigest || !/^[a-f0-9]{64}$/u.test(pointer.outputDigest)) {
      throw new Error("Persisted stock PAPER v4 latest pointer is invalid.");
    }
    const row = this.db.prepare(`
      SELECT value_json FROM settings WHERE key = ?
    `).get(
      `${LEARNING_V4_SETTING_PREFIX}${laneId}:artifact:${pointer.outputDigest}`
    ) as { value_json: string } | undefined;
    if (!row) throw new Error("Persisted stock PAPER v4 latest artifact is missing.");
    const summary = parseJson<StockPaperLearningV4Summary>(row.value_json);
    if (!summary.analysisOnly || summary.affectsTrading || summary.promotionEligible ||
        summary.outputDigest !== pointer.outputDigest ||
        !/^[a-f0-9]{64}$/u.test(summary.evidenceDigest) ||
        !/^[a-f0-9]{64}$/u.test(summary.datasetDigest) ||
        !/^[a-f0-9]{64}$/u.test(summary.outputDigest)) {
      throw new Error("Persisted stock PAPER v4 analysis violated its research-only provenance contract.");
    }
    return summary;
  }

  private outcomeQualityProjection(laneId: string, now = new Date()): StockPaperOutcomeProjection {
    const cached = this.outcomeProjectionCache;
    if (cached?.laneId === laneId && Date.now() < cached.expiresAt) return cached.value;
    type OutcomeRow = {
      observation_id: string;
      observed_at: string;
      phase: StockPaperOutcomeSessionPhase | null;
      horizon_minutes: StockPaperOutcomeHorizonMinutes | null;
      status: "LABELED" | "MISSING" | null;
      missing_reason: string | null;
    };
    type SessionAccumulator = {
      total: number;
      due: number;
      labeled: number;
      missing: number;
      missingReasons: Map<string, number>;
    };
    type HorizonAccumulator = {
      due: number;
      labeled: number;
      missing: number;
      oldestPendingObservedAt?: string;
      missingReasons: Map<string, number>;
      sessions: Map<StockPaperOutcomeSessionPhase, SessionAccumulator>;
    };

    // A single ordered projection replaces the former per-horizon query fanout.
    // The JSON phase/reason fields are decoded once per persisted row and all
    // 15/45/180-minute aggregates are reduced in memory. This keeps the exact
    // dashboard semantics while preventing three repeated scans of the growing
    // observation/outcome ledgers on every cache miss.
    const rows = this.db.prepare(`
      SELECT
        observation.id AS observation_id,
        observation.observed_at,
        json_extract(observation.observation_json, '$.phase') AS phase,
        outcome.horizon_minutes,
        outcome.status,
        CASE WHEN outcome.status = 'MISSING'
          THEN COALESCE(json_extract(outcome.outcome_json, '$.missingReason'), 'UNKNOWN')
        END AS missing_reason
      FROM stock_paper_observations observation
        INDEXED BY stock_paper_observations_dashboard_projection
      LEFT JOIN stock_paper_observation_outcomes outcome
        INDEXED BY stock_paper_outcomes_dashboard_projection
        ON outcome.observation_id = observation.id
      WHERE observation.lane_id = ?
      ORDER BY observation.id, outcome.horizon_minutes
    `).all(laneId) as OutcomeRow[];
    const dueBefore = new Map(OUTCOME_HORIZONS.map((horizonMinutes) => [
      horizonMinutes,
      new Date(now.getTime() - horizonMinutes * 60_000).toISOString()
    ]));
    const validPhases = new Set<StockPaperOutcomeSessionPhase>(OUTCOME_SESSION_PHASES);
    const horizonAccumulators = new Map<StockPaperOutcomeHorizonMinutes, HorizonAccumulator>(
      OUTCOME_HORIZONS.map((horizonMinutes) => [
      horizonMinutes,
      {
        due: 0,
        labeled: 0,
        missing: 0,
        missingReasons: new Map<string, number>(),
        sessions: new Map(OUTCOME_SESSION_PHASES.map((phase) => [
          phase,
          { total: 0, due: 0, labeled: 0, missing: 0, missingReasons: new Map<string, number>() }
        ]))
      }
    ]));
    const increment = (counts: Map<string, number>, value: string): void => {
      counts.set(value, (counts.get(value) ?? 0) + 1);
    };
    const topReasons = (counts: Map<string, number>): Array<{ reason: string; count: number }> =>
      [...counts.entries()]
        .sort((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
        .slice(0, 5)
        .map(([reason, count]) => ({ reason, count }));

    let totalObservations = 0;
    let totalOutcomes = 0;
    let labeledOutcomes = 0;
    let missingOutcomes = 0;
    let currentId: string | undefined;
    let currentObservedAt = "";
    let currentPhase: StockPaperOutcomeSessionPhase | undefined;
    let currentHorizons = new Set<StockPaperOutcomeHorizonMinutes>();
    const finalizeObservation = (): void => {
      if (!currentId) return;
      totalObservations += 1;
      for (const horizonMinutes of OUTCOME_HORIZONS) {
        const aggregate = horizonAccumulators.get(horizonMinutes)!;
        const session = currentPhase ? aggregate.sessions.get(currentPhase) : undefined;
        if (session) session.total += 1;
        if (currentObservedAt <= dueBefore.get(horizonMinutes)!) {
          aggregate.due += 1;
          if (session) session.due += 1;
          if (!currentHorizons.has(horizonMinutes) &&
              (!aggregate.oldestPendingObservedAt || currentObservedAt < aggregate.oldestPendingObservedAt)) {
            aggregate.oldestPendingObservedAt = currentObservedAt;
          }
        }
      }
    };

    for (const row of rows) {
      if (row.observation_id !== currentId) {
        finalizeObservation();
        currentId = row.observation_id;
        currentObservedAt = row.observed_at;
        currentPhase = row.phase && validPhases.has(row.phase) ? row.phase : undefined;
        currentHorizons = new Set<StockPaperOutcomeHorizonMinutes>();
      }
      if (row.horizon_minutes === null || row.status === null) continue;
      const aggregate = horizonAccumulators.get(row.horizon_minutes);
      if (!aggregate) continue;
      currentHorizons.add(row.horizon_minutes);
      totalOutcomes += 1;
      const session = currentPhase ? aggregate.sessions.get(currentPhase) : undefined;
      if (row.status === "LABELED") {
        aggregate.labeled += 1;
        labeledOutcomes += 1;
        if (session) session.labeled += 1;
      } else {
        aggregate.missing += 1;
        missingOutcomes += 1;
        if (session) session.missing += 1;
        const reason = row.missing_reason ?? "UNKNOWN";
        increment(aggregate.missingReasons, reason);
        if (session) increment(session.missingReasons, reason);
      }
    }
    finalizeObservation();

    const value = {
      totalObservations,
      totalOutcomes,
      labeledOutcomes,
      missingOutcomes,
      quality: OUTCOME_HORIZONS.map((horizonMinutes) => {
        const aggregate = horizonAccumulators.get(horizonMinutes)!;
        const completed = aggregate.labeled + aggregate.missing;
        return {
          horizonMinutes,
          totalObservations,
          dueObservations: aggregate.due,
          labeledOutcomes: aggregate.labeled,
          missingOutcomes: aggregate.missing,
          pendingDueOutcomes: Math.max(0, aggregate.due - completed),
          futureOutcomes: Math.max(0, totalObservations - aggregate.due),
          completionPercent: aggregate.due > 0 ? completed / aggregate.due * 100 : 0,
          eligibleCoveragePercent: completed > 0 ? aggregate.labeled / completed * 100 : 0,
          ...(aggregate.oldestPendingObservedAt
            ? { oldestPendingObservedAt: aggregate.oldestPendingObservedAt }
            : {}),
          topMissingReasons: topReasons(aggregate.missingReasons),
          sessionBreakdown: OUTCOME_SESSION_PHASES.map((phase) => {
            const session = aggregate.sessions.get(phase)!;
            const sessionCompleted = session.labeled + session.missing;
            return {
              phase,
              totalObservations: session.total,
              dueObservations: session.due,
              labeledOutcomes: session.labeled,
              missingOutcomes: session.missing,
              pendingDueOutcomes: Math.max(0, session.due - sessionCompleted),
              futureOutcomes: Math.max(0, session.total - session.due),
              completionPercent: session.due > 0 ? sessionCompleted / session.due * 100 : 0,
              eligibleCoveragePercent: sessionCompleted > 0
                ? session.labeled / sessionCompleted * 100
                : 0,
              topMissingReasons: topReasons(session.missingReasons)
            };
          })
        };
      })
    } satisfies StockPaperOutcomeProjection;
    this.outcomeProjectionCache = {
      laneId,
      expiresAt: Date.now() + STOCK_PAPER_OUTCOME_PROJECTION_CACHE_TTL_MS,
      value
    };
    return value;
  }

  private latestShadowScores(laneId: string): StockPaperShadowPolicyScore[] {
    const checkpoint = this.db.prepare(`
      SELECT dataset_digest, captured_at
      FROM stock_paper_learning_checkpoints
      WHERE lane_id = ?
      ORDER BY captured_at DESC, id DESC
      LIMIT 1
    `).get(laneId) as { dataset_digest: string; captured_at: string } | undefined;
    if (!checkpoint) return [];
    const scores = (this.db.prepare(`
      SELECT policy_id, result_json
      FROM stock_paper_shadow_results
      WHERE lane_id = ? AND captured_at = ?
      ORDER BY policy_id
    `).all(laneId, checkpoint.captured_at) as Array<{ policy_id: string; result_json: string }>)
      .flatMap((row): StockPaperShadowPolicyScore[] => {
        try {
          const score = parseJson<StockPaperShadowPolicyScore>(row.result_json);
          return shadowScoreValidationError(score, {
            datasetDigest: checkpoint.dataset_digest,
            capturedAt: checkpoint.captured_at,
            policyId: row.policy_id
          }) ? [] : [score];
        } catch {
          return [];
        }
      });
    if (scores.length !== FROZEN_STOCK_PAPER_SHADOW_POLICIES_V3.length ||
        new Set(scores.map((score) => score.policyId)).size !== STOCK_SHADOW_POLICY_BY_ID.size ||
        scores.some((score) => !STOCK_SHADOW_POLICY_BY_ID.has(score.policyId))) return [];
    return scores;
  }

  private latestWalkForwardSummary(laneId: string): StockPaperWalkForwardSummary | undefined {
    const row = this.db.prepare(`
      SELECT dataset_digest, evaluation_digest, captured_at, checkpoint_json
      FROM stock_paper_learning_checkpoints
      WHERE lane_id = ?
      ORDER BY captured_at DESC, id DESC
      LIMIT 1
    `).get(laneId) as {
      dataset_digest: string;
      evaluation_digest: string;
      captured_at: string;
      checkpoint_json: string;
    } | undefined;
    if (!row) return undefined;
    const summary = parseJson<StockPaperWalkForwardSummary>(row.checkpoint_json);
    if (summary.datasetDigest !== row.dataset_digest ||
        summary.evaluationDigest !== row.evaluation_digest ||
        summary.evaluatedAt !== row.captured_at ||
        summary.policySetDigest !== STOCK_SHADOW_POLICY_SET_DIGEST ||
        summary.analysisOnly !== true || summary.mayAffectTrading !== false ||
        summary.promotionEligible !== false) return undefined;
    return summary;
  }

  private learningDashboard(laneId: string) {
    const outcomeProjection = this.outcomeQualityProjection(laneId);
    const counts = this.db.prepare(`
      SELECT
        COUNT(DISTINCT symbol) AS distinct_symbols,
        COUNT(DISTINCT substr(observed_at, 1, 10)) AS distinct_days
      FROM stock_paper_observations
      WHERE lane_id = ?
    `).get(laneId) as {
      distinct_symbols: number;
      distinct_days: number;
    };
    const completedOutcomes = outcomeProjection.labeledOutcomes + outcomeProjection.missingOutcomes;
    const walkForward = this.latestWalkForwardSummary(laneId);
    const advancedAnalysis = this.latestLearningV4Summary(laneId);
    const rotationShadow = this.rotationSummary(laneId);
    return {
      version: STOCK_PAPER_LEARNING_VERSION,
      observations: outcomeProjection.totalObservations,
      labeledOutcomes: outcomeProjection.labeledOutcomes,
      missingOutcomes: outcomeProjection.missingOutcomes,
      pendingOutcomes: Math.max(
        0,
        outcomeProjection.totalObservations * OUTCOME_HORIZONS.length - outcomeProjection.totalOutcomes
      ),
      eligibleCoveragePercent: completedOutcomes > 0
        ? outcomeProjection.labeledOutcomes / completedOutcomes * 100
        : 0,
      distinctSymbols: counts.distinct_symbols,
      distinctDays: counts.distinct_days,
      shadowPolicies: this.latestShadowScores(laneId),
      ...(walkForward ? { walkForward } : {}),
      outcomeQuality: outcomeProjection.quality,
      ...(advancedAnalysis ? { advancedAnalysis } : {}),
      ...(rotationShadow ? { rotationShadow } : {}),
      bookResearch: stockPaperBookResearchSummary(),
      promotionEnabled: false as const
    };
  }

  equity(laneId: string, limit = 720): StockPaperEquityPoint[] {
    return (this.db.prepare(`
      SELECT point_json
      FROM (
        SELECT captured_at, point_json
        FROM stock_paper_equity_points
        WHERE lane_id = ?
        ORDER BY captured_at DESC
        LIMIT ?
      )
      ORDER BY captured_at
    `).all(laneId, limit) as Array<{ point_json: string }>)
      .map((row) => parseJson<StockPaperEquityPoint>(row.point_json));
  }

  bars(laneId: string, symbol: string, start: string, end: string): AlpacaStockBar[] {
    return (this.db.prepare(`
      SELECT bar_json
      FROM stock_paper_bars
      WHERE lane_id = ? AND symbol = ? AND bar_time >= ? AND bar_time <= ?
      ORDER BY bar_time
    `).all(laneId, symbol, start, end) as Array<{ bar_json: string }>)
      .map((row) => parseJson<AlpacaStockBar>(row.bar_json));
  }

  candidateSparklinePrices(
    laneId: string,
    symbol: string,
    end: string,
    limit = 48
  ): number[] {
    return (this.db.prepare(`
      SELECT bar_json
      FROM (
        SELECT bar_time, bar_json
        FROM stock_paper_bars
        WHERE lane_id = ? AND symbol = ? AND bar_time <= ?
        ORDER BY bar_time DESC
        LIMIT ?
      )
      ORDER BY bar_time
    `).all(laneId, symbol, end, limit) as Array<{ bar_json: string }>)
      .map((row) => parseJson<AlpacaStockBar>(row.bar_json).close)
      .filter((price) => Number.isFinite(price) && price > 0);
  }

  recentTradesForArm(laneId: string, arm: StockPaperStrategyArm, limit = 20): StockPaperTrade[] {
    return (this.db.prepare(`
      SELECT trade_json
      FROM stock_paper_trades
      WHERE lane_id = ? AND arm = ?
      ORDER BY closed_at DESC, id DESC
      LIMIT ?
    `).all(laneId, arm, limit) as Array<{ trade_json: string }>)
      .map((row) => parseJson<StockPaperTrade>(row.trade_json))
      .reverse();
  }

  recentTradesForContext(
    laneId: string,
    arm: StockPaperStrategyArm,
    phase: StockPaperMarketPhase,
    limit = 40,
    policyDigest?: string
  ): StockPaperTrade[] {
    return this.trades(laneId, 2_000)
      .filter((trade) =>
        trade.arm === arm &&
        trade.entryContext?.featureVersion === STOCK_PAPER_FEATURE_VERSION &&
        trade.entryContext.policyVersion === STOCK_PAPER_POLICY_VERSION &&
        trade.entryContext.phase === phase &&
        (policyDigest === undefined || trade.entryContext.policyDigest === policyDigest)
      )
      .slice(0, limit)
      .reverse();
  }

  latestTradeForSymbol(laneId: string, symbol: string): StockPaperTrade | undefined {
    const row = this.db.prepare(`
      SELECT trade_json
      FROM stock_paper_trades
      WHERE lane_id = ? AND symbol = ?
      ORDER BY closed_at DESC, id DESC
      LIMIT 1
    `).get(laneId, symbol) as { trade_json: string } | undefined;
    return row ? parseJson<StockPaperTrade>(row.trade_json) : undefined;
  }

  tradeForPosition(laneId: string, positionId: string): StockPaperTrade | undefined {
    const row = this.db.prepare(`
      SELECT trade_json
      FROM stock_paper_trades
      WHERE lane_id = ? AND position_id = ?
      LIMIT 1
    `).get(laneId, positionId) as { trade_json: string } | undefined;
    return row ? parseJson<StockPaperTrade>(row.trade_json) : undefined;
  }

  commitCycle(input: StockPaperCycleCommit): void {
    const laneId = input.account.laneId;
    let outcomeProjectionChanged = false;
    const upsertPosition = this.db.prepare(`
      INSERT INTO stock_paper_positions(
        id, lane_id, symbol, arm, status, position_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        position_json = excluded.position_json,
        updated_at = excluded.updated_at
    `);
    const insertSignal = this.db.prepare(`
      INSERT OR IGNORE INTO stock_paper_signals(
        id, lane_id, symbol, arm, action, outcome, observed_at, signal_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertTrade = this.db.prepare(`
      INSERT INTO stock_paper_trades(
        id, lane_id, position_id, symbol, arm, closed_at, trade_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `);
    const insertBar = this.db.prepare(`
      INSERT INTO stock_paper_bars(lane_id, symbol, bar_time, bar_json)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(lane_id, symbol, bar_time) DO UPDATE SET
        bar_json = excluded.bar_json
    `);
    const insertCandidate = this.db.prepare(`
      INSERT INTO stock_paper_candidates(
        lane_id, symbol, score, eligible, captured_at, candidate_json
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    const upsertOrder = this.db.prepare(`
      INSERT INTO stock_paper_orders(
        id, idempotency_key, lane_id, symbol, side, status,
        submitted_at, updated_at, order_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        updated_at = excluded.updated_at,
        order_json = excluded.order_json
    `);
    const insertOrderEvent = this.db.prepare(`
      INSERT INTO stock_paper_order_events(
        id, idempotency_key, lane_id, order_id, event_sequence, symbol, side, event_type,
        prior_status, new_status, decision_at, evidence_bar_at,
        evidence_observed_at, quote_timestamp, phase, feed, created_at, event_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertObservation = this.db.prepare(`
      INSERT INTO stock_paper_observations(
        id, lane_id, symbol, decision, observed_at, policy_version, observation_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertOutcome = this.db.prepare(`
      INSERT INTO stock_paper_observation_outcomes(
        observation_id, lane_id, symbol, horizon_minutes, status,
        due_at, labeled_at, outcome_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertShadowResult = this.db.prepare(`
      INSERT OR IGNORE INTO stock_paper_shadow_results(
        id, lane_id, policy_id, captured_at, result_json
      ) VALUES (?, ?, ?, ?, ?)
    `);
    const insertNewsEvidence = this.db.prepare(`
      INSERT OR IGNORE INTO stock_paper_news_evidence(
        article_id, lane_id, symbol, created_at, observed_at, evidence_json
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO stock_paper_accounts(lane_id, account_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(lane_id) DO UPDATE SET
          account_json = excluded.account_json,
          updated_at = excluded.updated_at
      `).run(laneId, JSON.stringify(input.account), input.account.updatedAt);
      for (const position of input.positions) {
        upsertPosition.run(
          position.id,
          position.laneId,
          position.symbol,
          position.arm,
          position.status,
          JSON.stringify(position),
          position.updatedAt
        );
      }
      for (const signal of input.signals ?? []) {
        insertSignal.run(
          signal.id,
          signal.laneId,
          signal.symbol,
          signal.arm,
          signal.action,
          signal.outcome,
          signal.observedAt,
          JSON.stringify(signal)
        );
      }
      for (const trade of input.trades ?? []) {
        insertTrade.run(
          trade.id,
          trade.laneId,
          trade.positionId,
          trade.symbol,
          trade.arm,
          trade.closedAt,
          JSON.stringify(trade)
        );
      }
      this.db.prepare(`
        INSERT OR REPLACE INTO stock_paper_equity_points(lane_id, captured_at, point_json)
        VALUES (?, ?, ?)
      `).run(laneId, input.equityPoint.capturedAt, JSON.stringify(input.equityPoint));
      for (const entry of input.bars ?? []) {
        insertBar.run(laneId, entry.symbol, entry.bar.timestamp, JSON.stringify(entry.bar));
      }
      for (const order of input.orders ?? []) {
        upsertOrder.run(
          order.id,
          order.idempotencyKey,
          order.laneId,
          order.symbol,
          order.side,
          order.status,
          order.submittedAt,
          order.updatedAt,
          JSON.stringify(order)
        );
      }
      for (const event of input.orderEvents ?? []) {
        if (event.laneId !== laneId) {
          throw new Error("Stock PAPER order-event lane does not match the committed account lane.");
        }
        const eventJson = JSON.stringify(event);
        const prior = this.db.prepare(`
          SELECT event_json
          FROM stock_paper_order_events
          WHERE id = ? OR idempotency_key = ?
             OR (order_id = ? AND event_sequence = ?)
          LIMIT 1
        `).get(event.id, event.idempotencyKey, event.orderId, event.sequence) as {
          event_json: string;
        } | undefined;
        if (prior) {
          if (prior.event_json !== eventJson) {
            throw new Error("A stock PAPER order-event idempotency key collided with different evidence.");
          }
          continue;
        }
        insertOrderEvent.run(
          event.id,
          event.idempotencyKey,
          event.laneId,
          event.orderId,
          event.sequence,
          event.symbol,
          event.side,
          event.eventType,
          event.priorStatus ?? null,
          event.newStatus,
          event.decisionAt,
          event.evidenceBarTimestamp ?? null,
          event.evidenceObservedAt ?? null,
          event.quoteTimestamp ?? null,
          event.phase,
          event.feed,
          event.createdAt,
          eventJson
        );
      }
      for (const observation of input.observations ?? []) {
        if (observation.laneId !== laneId) {
          throw new Error("Stock PAPER observation lane does not match the committed account lane.");
        }
        const observationJson = JSON.stringify(observation);
        const prior = this.db.prepare(`
          SELECT observation_json FROM stock_paper_observations WHERE id = ?
        `).get(observation.id) as { observation_json: string } | undefined;
        if (prior) {
          if (prior.observation_json !== observationJson) {
            throw new Error("A stock PAPER observation id collided with different evidence.");
          }
          continue;
        }
        insertObservation.run(
          observation.id,
          observation.laneId,
          observation.symbol,
          observation.decision,
          observation.observedAt,
          observation.policyVersion,
          observationJson
        );
        outcomeProjectionChanged = true;
      }
      for (const outcome of input.outcomes ?? []) {
        if (outcome.laneId !== laneId) {
          throw new Error("Stock PAPER outcome lane does not match the committed account lane.");
        }
        const outcomeJson = JSON.stringify(outcome);
        const prior = this.db.prepare(`
          SELECT outcome_json
          FROM stock_paper_observation_outcomes
          WHERE observation_id = ? AND horizon_minutes = ?
        `).get(outcome.observationId, outcome.horizonMinutes) as {
          outcome_json: string;
        } | undefined;
        if (prior) {
          if (prior.outcome_json !== outcomeJson) {
            throw new Error("A stock PAPER outcome key collided with different evidence.");
          }
          continue;
        }
        insertOutcome.run(
          outcome.observationId,
          outcome.laneId,
          outcome.symbol,
          outcome.horizonMinutes,
          outcome.status,
          outcome.dueAt,
          outcome.labeledAt,
          outcomeJson
        );
        outcomeProjectionChanged = true;
      }
      for (const result of input.shadowResults ?? []) {
        insertShadowResult.run(
          result.id,
          laneId,
          result.score.policyId,
          result.capturedAt,
          JSON.stringify(result.score)
        );
      }
      for (const evidence of input.newsEvidence ?? []) {
        insertNewsEvidence.run(
          evidence.articleId,
          laneId,
          evidence.symbol,
          evidence.createdAt,
          evidence.observedAt,
          JSON.stringify(evidence.evidence)
        );
      }
      if (input.candidates) {
        this.db.prepare("DELETE FROM stock_paper_candidates WHERE lane_id = ?").run(laneId);
        for (const candidate of input.candidates) {
          insertCandidate.run(
            laneId,
            candidate.symbol,
            candidate.score,
            candidate.eligible ? 1 : 0,
            candidate.capturedAt,
            JSON.stringify(candidate)
          );
        }
      }
      this.db.prepare(`
        INSERT INTO settings(key, value_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value_json = excluded.value_json,
          updated_at = excluded.updated_at
      `).run(
        `${MARKET_STATUS_SETTING_PREFIX}${laneId}`,
        JSON.stringify(input.market),
        input.equityPoint.capturedAt
      );
      this.db.prepare(`
        DELETE FROM stock_paper_equity_points
        WHERE lane_id = ?
          AND captured_at < strftime('%Y-%m-%dT%H:%M:%fZ', ?, '-90 days')
      `).run(laneId, input.equityPoint.capturedAt);
      this.db.prepare(`
        DELETE FROM stock_paper_bars
        WHERE lane_id = ?
          AND bar_time < strftime('%Y-%m-%dT%H:%M:%fZ', ?, '-30 days')
      `).run(laneId, input.equityPoint.capturedAt);
      const retentionDays = Math.max(
        30,
        Math.round(this.activeLane()?.policy.observationRetentionDays ?? 180)
      );
      const deletedObservations = this.db.prepare(`
        DELETE FROM stock_paper_observations
        WHERE lane_id = ?
          AND observed_at < strftime('%Y-%m-%dT%H:%M:%fZ', ?, ?)
      `).run(laneId, input.equityPoint.capturedAt, `-${retentionDays} days`);
      if (deletedObservations.changes > 0) outcomeProjectionChanged = true;
      this.db.prepare(`
        DELETE FROM stock_paper_news_evidence
        WHERE lane_id = ?
          AND observed_at < strftime('%Y-%m-%dT%H:%M:%fZ', ?, ?)
      `).run(laneId, input.equityPoint.capturedAt, `-${retentionDays} days`);
      this.db.prepare(`
        DELETE FROM stock_paper_shadow_results
        WHERE lane_id = ?
          AND captured_at < strftime('%Y-%m-%dT%H:%M:%fZ', ?, ?)
      `).run(laneId, input.equityPoint.capturedAt, `-${retentionDays} days`);
      this.db.prepare(`
        DELETE FROM stock_paper_learning_checkpoints
        WHERE lane_id = ?
          AND captured_at < strftime('%Y-%m-%dT%H:%M:%fZ', ?, ?)
      `).run(laneId, input.equityPoint.capturedAt, `-${retentionDays} days`);
    })();
    if (outcomeProjectionChanged) this.outcomeProjectionCache = undefined;
  }

  commitLearningEvaluation(input: StockPaperLearningCommit): void {
    const lane = this.activeLane();
    if (!lane || lane.id !== input.laneId) {
      throw new Error("Stock PAPER learning checkpoint lane is not the active research lane.");
    }
    if (input.walkForward.datasetDigest !== input.datasetDigest ||
        input.walkForward.evaluationDigest !== input.evaluationDigest ||
        input.walkForward.evaluatedAt !== input.capturedAt ||
        input.walkForward.policySetDigest !== STOCK_SHADOW_POLICY_SET_DIGEST ||
        input.walkForward.analysisOnly !== true || input.walkForward.mayAffectTrading !== false ||
        input.walkForward.promotionEligible !== false) {
      throw new Error("Stock PAPER learning checkpoint provenance does not match its commit identity.");
    }
    const committedPolicyIds = new Set<string>();
    for (const result of input.shadowResults) {
      if (committedPolicyIds.has(result.score.policyId)) {
        throw new Error("Stock PAPER learning checkpoint repeats a shadow policy.");
      }
      committedPolicyIds.add(result.score.policyId);
      const reason = shadowScoreValidationError(result.score, {
        datasetDigest: input.datasetDigest,
        capturedAt: input.capturedAt,
        policyId: result.score.policyId
      });
      if (reason) throw new Error(`Stock PAPER shadow evidence failed closed: ${reason}.`);
    }
    if (committedPolicyIds.size !== FROZEN_STOCK_PAPER_SHADOW_POLICIES_V3.length ||
        [...STOCK_SHADOW_POLICY_BY_ID.keys()].some((policyId) => !committedPolicyIds.has(policyId))) {
      throw new Error("Stock PAPER learning checkpoint must contain every frozen shadow policy exactly once.");
    }
    this.db.transaction(() => {
      for (const result of input.shadowResults) {
        const json = JSON.stringify(result.score);
        const existing = this.db.prepare(`
          SELECT result_json FROM stock_paper_shadow_results WHERE id = ?
        `).get(result.id) as { result_json: string } | undefined;
        if (existing) {
          if (existing.result_json !== json) {
            throw new Error("A stock PAPER shadow artifact id collided with different evidence.");
          }
          continue;
        }
        this.db.prepare(`
          INSERT INTO stock_paper_shadow_results(
            id, lane_id, policy_id, captured_at, result_json
          ) VALUES (?, ?, ?, ?, ?)
        `).run(result.id, input.laneId, result.score.policyId, input.capturedAt, json);
      }
      const checkpointJson = JSON.stringify(input.walkForward);
      const existingCheckpoint = this.db.prepare(`
        SELECT dataset_digest, evaluation_digest, checkpoint_json
        FROM stock_paper_learning_checkpoints
        WHERE id = ? OR (lane_id = ? AND evaluation_digest = ?)
        LIMIT 1
      `).get(input.checkpointId, input.laneId, input.evaluationDigest) as {
        dataset_digest: string;
        evaluation_digest: string;
        checkpoint_json: string;
      } | undefined;
      if (existingCheckpoint) {
        if (existingCheckpoint.dataset_digest !== input.datasetDigest ||
            existingCheckpoint.evaluation_digest !== input.evaluationDigest ||
            existingCheckpoint.checkpoint_json !== checkpointJson) {
          throw new Error("A stock PAPER learning checkpoint collided with different evidence.");
        }
        return;
      }
      this.db.prepare(`
        INSERT INTO stock_paper_learning_checkpoints(
          id, lane_id, dataset_digest, evaluation_digest,
          captured_at, cutoff_at, checkpoint_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.checkpointId,
        input.laneId,
        input.datasetDigest,
        input.evaluationDigest,
        input.capturedAt,
        input.cutoffAt,
        checkpointJson
      );
    })();
  }

  recordFailure(laneId: string, message: string, at = new Date().toISOString()): void {
    const prior = this.marketStatus(laneId);
    const market: StockPaperMarketStatus = {
      ...prior,
      isOpen: false,
      feedActionable: false,
      readiness: {
        status: "BLOCKED",
        reasons: [`REQUIRED_ENDPOINT_FAILED: ${message}`],
        checkedAt: at
      },
      lastScanAt: at,
      lastError: message
    };
    this.db.prepare(`
      INSERT INTO settings(key, value_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value_json = excluded.value_json,
        updated_at = excluded.updated_at
    `).run(`${MARKET_STATUS_SETTING_PREFIX}${laneId}`, JSON.stringify(market), at);
  }

  marketStatus(laneId: string): StockPaperMarketStatus {
    const row = this.db.prepare(`
      SELECT value_json FROM settings WHERE key = ?
    `).get(`${MARKET_STATUS_SETTING_PREFIX}${laneId}`) as { value_json: string } | undefined;
    return row
      ? parseJson<StockPaperMarketStatus>(row.value_json)
      : {
          feed: "IEX",
          isOpen: false,
          phase: "UNKNOWN",
          scannedSymbols: 0,
          detailedSymbols: 0,
          providerRequests: 0
        };
  }

  armStats(laneId: string, phase: StockPaperMarketPhase = "UNKNOWN"): StockPaperArmStats[] {
    const trades = this.trades(laneId, 2_000);
    return ARMS.map((arm) => {
      const armTrades = trades.filter((trade) => trade.arm === arm);
      const contextTrades = armTrades
        .filter((trade) =>
          trade.entryContext?.featureVersion === STOCK_PAPER_FEATURE_VERSION &&
          trade.entryContext.policyVersion === STOCK_PAPER_POLICY_VERSION &&
          trade.entryContext.phase === phase
        )
        .slice(0, 40)
        .reverse();
      const learning = adaptiveArmDecision({
        trades: contextTrades.map((trade) => ({
          pnlUsd: trade.pnlUsd,
          returnPercent: trade.returnPercent
        }))
      });
      const wins = armTrades.filter((trade) => trade.pnlUsd > 0).length;
      const factor = profitFactor(armTrades);
      return {
        arm,
        trades: armTrades.length,
        wins,
        winRatePercent: armTrades.length > 0 ? wins / armTrades.length * 100 : 0,
        pnlUsd: armTrades.reduce((sum, trade) => sum + trade.pnlUsd, 0),
        ...(factor !== undefined ? { profitFactor: factor } : {}),
        adaptiveSizingMultiplier: learning.multiplier,
        learningStatus: learning.status,
        learningSampleSize: learning.sampleSize,
        conservativeReturnPercent: learning.conservativeReturnPercent
      };
    });
  }

  dashboard(): StockPaperDashboard {
    const lane = this.activeLane();
    const updatedAt = new Date().toISOString();
    if (!lane) {
      return {
        label: STOCK_PAPER_LABEL,
        promotionEligible: false,
        executionEnabled: false,
        paperOnly: true,
        positions: [],
        candidates: [],
        recentSignals: [],
        recentTrades: [],
        equityCurve: [],
        capitalEvents: [],
        armStats: [],
        orders: [],
        learning: {
          version: STOCK_PAPER_LEARNING_VERSION,
          observations: 0,
          labeledOutcomes: 0,
          missingOutcomes: 0,
          pendingOutcomes: 0,
          eligibleCoveragePercent: 0,
          distinctSymbols: 0,
          distinctDays: 0,
          shadowPolicies: [],
          outcomeQuality: [],
          bookResearch: stockPaperBookResearchSummary(),
          promotionEnabled: false
        },
        market: {
          feed: "IEX",
          isOpen: false,
          phase: "UNKNOWN",
          scannedSymbols: 0,
          detailedSymbols: 0,
          providerRequests: 0
        },
        updatedAt
      };
    }
    const account = this.account(lane.id);
    const candidates = this.candidates(lane.id, 40);
    const sparklineSymbols = new Set(
      [...candidates]
        .sort((left, right) => right.score - left.score || left.symbol.localeCompare(right.symbol))
        .slice(0, 5)
        .map((candidate) => candidate.symbol)
    );
    return {
      label: STOCK_PAPER_LABEL,
      promotionEligible: false,
      executionEnabled: false,
      paperOnly: true,
      lane,
      ...(account ? { account } : {}),
      positions: this.positions(lane.id, true, 100),
      candidates: candidates.map((candidate) => {
        if (!sparklineSymbols.has(candidate.symbol)) return candidate;
        const sparklinePricesUsd = this.candidateSparklinePrices(
          lane.id,
          candidate.symbol,
          candidate.capturedAt
        );
        return sparklinePricesUsd.length >= 2
          ? { ...candidate, sparklinePricesUsd }
          : candidate;
      }),
      recentSignals: this.signals(lane.id, STOCK_PAPER_DASHBOARD_SIGNAL_LIMIT),
      recentTrades: this.trades(lane.id, STOCK_PAPER_DASHBOARD_TRADE_LIMIT),
      equityCurve: downsampleDashboardEquity(
        this.equity(lane.id, STOCK_PAPER_DASHBOARD_EQUITY_SOURCE_LIMIT)
      ),
      capitalEvents: this.capitalEvents(lane.id, 20),
      armStats: this.armStats(lane.id, this.marketStatus(lane.id).phase),
      orders: this.orders(lane.id, STOCK_PAPER_DASHBOARD_ORDER_LIMIT),
      learning: this.learningDashboard(lane.id),
      market: this.marketStatus(lane.id),
      updatedAt
    };
  }
}
