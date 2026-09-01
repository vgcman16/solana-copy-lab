import { afterEach, describe, expect, it } from "vitest";
import {
  STOCK_PAPER_EXECUTION_VERSION,
  type StockPaperOrder,
  type StockPaperOrderEvent
} from "@copylab/shared";
import { openDatabase, type CopyLabDatabase } from "../src/database.js";
import { StockPaperRepository } from "../src/stock-paper-repository.js";

describe("StockPaperRepository order-event ledger", () => {
  let db: CopyLabDatabase | undefined;
  afterEach(() => db?.close());

  it("appends idempotently and rejects an evidence collision", () => {
    db = openDatabase(":memory:");
    const repository = new StockPaperRepository(db);
    const now = "2026-07-16T14:40:00.000Z";
    const lane = repository.ensureActiveLane(now);
    const account = repository.account(lane.id)!;
    const order: StockPaperOrder = {
      id: "stock-order:test-event",
      idempotencyKey: "stock-order:test-event",
      laneId: lane.id,
      positionId: "stock-position:test-event",
      symbol: "AAPL",
      arm: "BREAKOUT",
      side: "BUY",
      status: "SUBMITTED",
      phase: "REGULAR",
      feed: "IEX",
      policyVersion: lane.policyVersion,
      executionVersion: STOCK_PAPER_EXECUTION_VERSION,
      submittedAt: now,
      expiresAt: "2026-07-16T14:45:00.000Z",
      firstEligibleBarAt: "2026-07-16T14:41:00.000Z",
      limitPriceUsd: 100,
      requestedQuantity: 0.25,
      filledQuantity: 0,
      reservedNotionalUsd: 25,
      candidateScore: 82,
      fills: [],
      updatedAt: now
    };
    const event: StockPaperOrderEvent = {
      id: "stock-order-event:test-event",
      idempotencyKey: "stock-order:test-event:submission",
      laneId: lane.id,
      orderId: order.id,
      sequence: 0,
      positionId: order.positionId!,
      symbol: order.symbol,
      side: order.side,
      eventType: "SUBMISSION",
      newStatus: "SUBMITTED",
      decisionAt: now,
      evidenceObservedAt: now,
      quoteTimestamp: now,
      quoteDigest: "quote-sha256",
      phase: order.phase,
      feed: order.feed,
      assumptions: {
        executionVersion: STOCK_PAPER_EXECUTION_VERSION,
        limitPriceUsd: 100,
        participationRatePercent: 1,
        marketable: false,
        spreadPercent: 0.1,
        extendedFillPenaltyPercent: 0
      },
      reason: "Durable PAPER order submitted.",
      createdAt: now
    };
    const commit = {
      account,
      positions: [],
      orders: [order],
      orderEvents: [event],
      equityPoint: {
        capturedAt: now,
        navUsd: account.navUsd,
        cashUsd: account.cashUsd,
        deployedUsd: account.deployedUsd,
        drawdownPercent: 0
      },
      market: {
        feed: "IEX" as const,
        isOpen: true,
        phase: "REGULAR" as const,
        scannedSymbols: 1,
        detailedSymbols: 1,
        providerRequests: 1
      }
    };

    repository.commitCycle(commit);
    repository.commitCycle(commit);
    expect(repository.orderEvents(lane.id, order.id)).toEqual([event]);
    expect(() => repository.commitCycle({
      ...commit,
      orderEvents: [{ ...event, reason: "different evidence" }]
    })).toThrow(/collided with different evidence/i);
  });
});
