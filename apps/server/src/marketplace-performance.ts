import type {
  AutonomousPaperAccount,
  MarketplacePilotPerformance,
  PortfolioSnapshot,
  ResearchPaperLeaderAccount,
  StockPaperAccount
} from "@copylab/shared";
import type { CopyLabDatabase } from "./database.js";

interface JsonRow {
  value_json: string;
}

interface StrictRow {
  snapshot_json: string;
  initial_nav_usd: number | null;
}

interface LaneRow {
  id: string;
  started_at: string;
}

function parse<T>(value: string): T {
  return JSON.parse(value) as T;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function elapsedDays(startedAt: string, updatedAt: string): number {
  return Math.max(0, (Date.parse(updatedAt) - Date.parse(startedAt)) / 86_400_000);
}

function tradeStats(rows: JsonRow[]): {
  wins: number;
  profitFactor?: number;
} {
  const pnl = rows
    .map((row) => parse<{ pnlUsd?: number; trade?: { pnlUsd?: number } }>(row.value_json))
    .map((value) => value.pnlUsd ?? value.trade?.pnlUsd)
    .filter(finite);
  const wins = pnl.filter((value) => value > 0).length;
  const grossProfit = pnl.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const grossLoss = Math.abs(pnl.filter((value) => value < 0).reduce((sum, value) => sum + value, 0));
  return {
    wins,
    ...(grossLoss > 0 ? { profitFactor: grossProfit / grossLoss } : {})
  };
}

function accountPerformance(
  account: AutonomousPaperAccount | StockPaperAccount,
  startedAt: string,
  disclosure: string
): MarketplacePilotPerformance {
  const stats = account.completedTrades > 0
    ? { winRatePercent: account.winningTrades / account.completedTrades * 100 }
    : {};
  const profitFactor = account.grossLossUsd > 0
    ? account.grossProfitUsd / account.grossLossUsd
    : undefined;
  return {
    capturedAt: account.updatedAt,
    netReturnPercent: (account.navUsd - account.initialNavUsd) / account.initialNavUsd * 100,
    realizedPnlUsd: account.realizedPnlUsd,
    maxDrawdownPercent: account.maxDrawdownPercent,
    ...(profitFactor === undefined ? {} : { profitFactor }),
    ...stats,
    completedTrades: account.completedTrades,
    openPositions: account.openPositions,
    executablePricingComplete: account.pricingComplete,
    evidenceStatus: account.completedTrades >= 50 && elapsedDays(startedAt, account.updatedAt) >= 30
      ? "SUFFICIENT"
      : "FORWARD_TESTING",
    disclosure
  };
}

/** Read-only adapter from existing strategy evidence into marketplace cards. */
export class MarketplacePerformanceReadModel {
  constructor(private readonly db: CopyLabDatabase) {}

  current(pilotId: string): MarketplacePilotPerformance | undefined {
    switch (pilotId) {
      case "pilot:strict-wallet-copy":
        return this.strictCopy();
      case "pilot:high-risk-wallet-copy":
        return this.highRiskCopy();
      case "pilot:autonomous-crypto-momentum":
        return this.autonomous();
      case "pilot:stock-momentum":
        return this.stock();
      default:
        return undefined;
    }
  }

  private strictCopy(): MarketplacePilotPerformance | undefined {
    const row = this.db.prepare(`
      SELECT snapshot.snapshot_json,
             COALESCE(
               cohort.initial_nav_usd,
               (
                 SELECT json_extract(initial.snapshot_json, '$.navUsd')
                 FROM portfolio_snapshots AS initial
                 WHERE initial.mode = 'PAPER'
                   AND initial.evaluation_cohort_id IS snapshot.evaluation_cohort_id
                 ORDER BY initial.captured_at, initial.id
                 LIMIT 1
               )
             ) AS initial_nav_usd
      FROM portfolio_snapshots AS snapshot
      LEFT JOIN paper_evaluation_cohorts AS cohort
        ON cohort.id = snapshot.evaluation_cohort_id
      WHERE snapshot.mode = 'PAPER'
      ORDER BY snapshot.captured_at DESC, snapshot.id DESC
      LIMIT 1
    `).get() as StrictRow | undefined;
    if (!row) return undefined;
    const snapshot = parse<PortfolioSnapshot>(row.snapshot_json);
    const trades = this.db.prepare(`
      SELECT trade_json AS value_json
      FROM closed_trades
      WHERE mode = 'PAPER'
        AND (? IS NULL OR evaluation_cohort_id = ?)
      ORDER BY closed_at
    `).all(snapshot.evaluationCohortId ?? null, snapshot.evaluationCohortId ?? null) as JsonRow[];
    const stats = tradeStats(trades);
    const initialNavUsd = row.initial_nav_usd && row.initial_nav_usd > 0
      ? row.initial_nav_usd
      : snapshot.navUsd;
    return {
      capturedAt: snapshot.capturedAt,
      netReturnPercent: (snapshot.navUsd - initialNavUsd) / initialNavUsd * 100,
      realizedPnlUsd: snapshot.realizedPnlUsd,
      maxDrawdownPercent: snapshot.peakNavUsd > 0
        ? Math.max(0, (snapshot.peakNavUsd - snapshot.navUsd) / snapshot.peakNavUsd * 100)
        : 0,
      ...(stats.profitFactor === undefined ? {} : { profitFactor: stats.profitFactor }),
      ...(trades.length > 0 ? { winRatePercent: stats.wins / trades.length * 100 } : {}),
      completedTrades: trades.length,
      openPositions: snapshot.openPositions,
      executablePricingComplete: snapshot.executablePricingComplete === true,
      evidenceStatus: trades.length >= 50 ? "SUFFICIENT" : "FORWARD_TESTING",
      disclosure: "Current strict CopyLab PAPER ledger; only executable forward evidence is included."
    };
  }

  private highRiskCopy(): MarketplacePilotPerformance | undefined {
    const lane = this.db.prepare(`
      SELECT id, started_at
      FROM research_paper_lanes
      WHERE status <> 'ARCHIVED'
      ORDER BY CASE status WHEN 'ACTIVE' THEN 0 ELSE 1 END, updated_at DESC
      LIMIT 1
    `).get() as LaneRow | undefined;
    if (!lane) return undefined;
    const accounts = (this.db.prepare(`
      SELECT account_json AS value_json
      FROM research_paper_accounts
      WHERE lane_id = ?
      ORDER BY wallet
    `).all(lane.id) as JsonRow[]).map((row) => parse<ResearchPaperLeaderAccount>(row.value_json));
    if (accounts.length === 0) return undefined;
    const trades = this.db.prepare(`
      SELECT event_json AS value_json
      FROM research_paper_events
      WHERE lane_id = ? AND kind = 'TRADE' AND outcome = 'SIMULATED'
      ORDER BY observed_at
    `).all(lane.id) as JsonRow[];
    const stats = tradeStats(trades);
    const average = (select: (account: ResearchPaperLeaderAccount) => number): number =>
      accounts.reduce((sum, account) => sum + select(account), 0) / accounts.length;
    const initialNavUsd = average((account) => account.initialNavUsd);
    const navUsd = average((account) => account.navUsd);
    const capturedAt = accounts.map((account) => account.updatedAt).sort().at(-1)!;
    return {
      capturedAt,
      netReturnPercent: (navUsd - initialNavUsd) / initialNavUsd * 100,
      realizedPnlUsd: average((account) => account.realizedPnlUsd),
      maxDrawdownPercent: Math.max(...accounts.map((account) => account.maxDrawdownPercent)),
      ...(stats.profitFactor === undefined ? {} : { profitFactor: stats.profitFactor }),
      ...(trades.length > 0 ? { winRatePercent: stats.wins / trades.length * 100 } : {}),
      completedTrades: trades.length,
      openPositions: accounts.reduce((sum, account) => sum + account.openPositions, 0),
      executablePricingComplete: accounts.every((account) => account.pricingComplete),
      evidenceStatus: trades.length >= 50 && elapsedDays(lane.started_at, capturedAt) >= 30
        ? "SUFFICIENT"
        : "FORWARD_TESTING",
      disclosure: `Equal-weight normalized results across ${accounts.length} isolated high-risk PAPER accounts; balances are not pooled.`
    };
  }

  private autonomous(): MarketplacePilotPerformance | undefined {
    const row = this.db.prepare(`
      SELECT account.account_json AS value_json, lane.started_at
      FROM autonomous_paper_accounts AS account
      JOIN autonomous_paper_lanes AS lane ON lane.id = account.lane_id
      WHERE lane.status <> 'ARCHIVED'
      ORDER BY CASE lane.status WHEN 'ACTIVE' THEN 0 ELSE 1 END, account.updated_at DESC
      LIMIT 1
    `).get() as (JsonRow & { started_at: string }) | undefined;
    return row
      ? accountPerformance(
          parse<AutonomousPaperAccount>(row.value_json),
          row.started_at,
          "Current isolated autonomous crypto PAPER ledger; replay variants are excluded from trade counts."
        )
      : undefined;
  }

  private stock(): MarketplacePilotPerformance | undefined {
    const row = this.db.prepare(`
      SELECT account.account_json AS value_json, lane.started_at
      FROM stock_paper_accounts AS account
      JOIN stock_paper_lanes AS lane ON lane.id = account.lane_id
      WHERE lane.status <> 'ARCHIVED'
      ORDER BY CASE lane.status WHEN 'ACTIVE' THEN 0 ELSE 1 END, account.updated_at DESC
      LIMIT 1
    `).get() as (JsonRow & { started_at: string }) | undefined;
    return row
      ? accountPerformance(
          parse<StockPaperAccount>(row.value_json),
          row.started_at,
          "Current US-stock PAPER ledger using executable simulated NAV; capital deposits are excluded from return."
        )
      : undefined;
  }
}
