import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type CopyLabDatabase } from "../src/database.js";
import { StockPaperRepository } from "../src/stock-paper-repository.js";

const AT = "2026-07-17T17:00:00.000Z";

function protectedLedgerState(db: CopyLabDatabase): string {
  return JSON.stringify(Object.fromEntries([
    "stock_paper_positions",
    "stock_paper_orders",
    "stock_paper_trades"
  ].map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])));
}

describe("StockPaperRepository simulated capital adjustments", () => {
  let db: CopyLabDatabase | undefined;

  afterEach(() => db?.close());

  it("raises NAV to the target without manufacturing P&L or rewriting trading evidence", () => {
    db = openDatabase(":memory:");
    const repository = new StockPaperRepository(db);
    const lane = repository.ensureActiveLane("2026-07-17T14:00:00.000Z");
    const base = repository.account(lane.id)!;
    const losingAccount = {
      ...base,
      cashUsd: 40,
      navUsd: 139,
      fairNavUsd: 139.5,
      executableNavUsd: 139,
      peakNavUsd: 145,
      deployedUsd: 99,
      fairDeployedUsd: 99.5,
      realizedPnlUsd: -1,
      unrealizedPnlUsd: -1,
      maxDrawdownPercent: 4.14,
      openPositions: 1,
      completedTrades: 1,
      grossLossUsd: 1,
      dayStartNavUsd: 142,
      updatedAt: "2026-07-17T16:59:00.000Z"
    };
    db.prepare(`UPDATE stock_paper_accounts SET account_json = ?, updated_at = ? WHERE lane_id = ?`)
      .run(JSON.stringify(losingAccount), losingAccount.updatedAt, lane.id);
    db.prepare(`
      INSERT INTO stock_paper_positions(
        id, lane_id, symbol, arm, status, position_json, updated_at
      ) VALUES ('position:test', ?, 'AAPL', 'BREAKOUT', 'OPEN', '{"sentinel":true}', ?)
    `).run(lane.id, losingAccount.updatedAt);
    db.prepare(`
      INSERT INTO stock_paper_orders(
        id, idempotency_key, lane_id, symbol, side, status,
        submitted_at, updated_at, order_json
      ) VALUES (
        'order:test', 'order-key:test', ?, 'AAPL', 'BUY', 'FILLED', ?, ?,
        '{"sentinel":true}'
      )
    `).run(lane.id, losingAccount.updatedAt, losingAccount.updatedAt);
    db.prepare(`
      INSERT INTO stock_paper_trades(
        id, lane_id, position_id, symbol, arm, closed_at, trade_json
      ) VALUES (
        'trade:test', ?, 'position:test', 'AAPL', 'BREAKOUT', ?, '{"sentinel":true}'
      )
    `).run(lane.id, losingAccount.updatedAt);
    const protectedBefore = protectedLedgerState(db);

    const event = repository.adjustCapitalToTarget({
      laneId: lane.id,
      targetNavUsd: 1_000,
      reason: "USER_REQUESTED_BANKROLL_INCREASE",
      createdAt: AT
    });
    const account = repository.account(lane.id)!;
    const adjustedLane = repository.activeLane()!;

    expect(event).toMatchObject({
      eventType: "DEPOSIT",
      paperOnly: true,
      realMoney: false,
      excludedFromTradingPnl: true,
      targetNavUsd: 1_000,
      priorNavUsd: 139,
      adjustedNavUsd: 1_000,
      deltaUsd: 861,
      tradingPnlUsdBefore: -2,
      tradingPnlUsdAfter: -2,
      cumulativeExternalCapitalUsd: 861
    });
    expect(account).toMatchObject({
      initialNavUsd: 1_002,
      cashUsd: 901,
      navUsd: 1_000,
      fairNavUsd: 1_000.5,
      executableNavUsd: 1_000,
      peakNavUsd: 1_006,
      deployedUsd: 99,
      fairDeployedUsd: 99.5,
      realizedPnlUsd: -1,
      unrealizedPnlUsd: -1,
      dayStartNavUsd: 1_003,
      maxDrawdownPercent: 4.14,
      openPositions: 1,
      completedTrades: 1
    });
    expect(account.navUsd - account.initialNavUsd).toBe(
      losingAccount.navUsd - losingAccount.initialNavUsd
    );
    expect(account.peakNavUsd - account.navUsd).toBe(
      losingAccount.peakNavUsd - losingAccount.navUsd
    );
    expect(account.dayStartNavUsd - account.navUsd).toBe(
      losingAccount.dayStartNavUsd - losingAccount.navUsd
    );
    expect(adjustedLane.initialNavUsd).toBe(1_002);
    expect(adjustedLane.policy.initialNavUsd).toBe(1_002);
    expect(protectedLedgerState(db)).toBe(protectedBefore);
  });

  it("is idempotent for one lane/target and rejects withdrawals or ambiguous precision", () => {
    db = openDatabase(":memory:");
    const repository = new StockPaperRepository(db);
    const lane = repository.ensureActiveLane("2026-07-17T14:00:00.000Z");
    const request = {
      laneId: lane.id,
      targetNavUsd: 1_000,
      reason: "USER_REQUESTED_BANKROLL_INCREASE" as const,
      createdAt: AT
    };

    const first = repository.adjustCapitalToTarget(request);
    const accountAfterFirst = repository.account(lane.id);
    const second = repository.adjustCapitalToTarget({
      ...request,
      createdAt: "2026-07-17T17:01:00.000Z"
    });

    expect(second).toEqual(first);
    expect(repository.account(lane.id)).toEqual(accountAfterFirst);
    expect(repository.capitalEvents(lane.id)).toEqual([first]);
    expect(repository.cumulativeExternalCapitalUsd(lane.id)).toBe(859);
    expect(db.prepare("SELECT COUNT(*) AS count FROM stock_paper_capital_events").get())
      .toEqual({ count: 1 });
    expect(() => repository.adjustCapitalToTarget({
      ...request,
      targetNavUsd: 100.001
    })).toThrow(/whole cents/i);
    expect(() => repository.adjustCapitalToTarget({
      ...request,
      targetNavUsd: 100
    })).toThrow(/only increase/i);
    expect(() => repository.adjustCapitalToTarget({
      ...request,
      laneId: "stock-paper:other",
      targetNavUsd: 2_000
    })).toThrow(/active research-only lane/i);
  });
});
