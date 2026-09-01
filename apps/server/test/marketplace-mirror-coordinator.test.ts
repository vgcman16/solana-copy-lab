import { afterEach, describe, expect, it } from "vitest";
import type {
  CopyIntent,
  ExecutionRecord,
  StockPaperOrder,
  StockPaperOrderEvent,
  StockPaperPosition
} from "@copylab/shared";
import { openDatabase, type CopyLabDatabase } from "../src/database.js";
import { MarketplaceMirrorCoordinator } from "../src/marketplace-mirror-coordinator.js";
import { MarketplaceService } from "../src/marketplace-service.js";

const T0 = "2026-07-18T12:00:00.000Z";
const T1 = "2026-07-18T12:01:00.000Z";
const T2 = "2026-07-18T12:02:00.000Z";
const T3 = "2026-07-18T12:03:00.000Z";
const T4 = "2026-07-18T12:04:00.000Z";
const T5 = "2026-07-18T12:05:00.000Z";

describe("committed-ledger marketplace PAPER mirroring", () => {
  let db: CopyLabDatabase | undefined;

  afterEach(() => db?.close());

  function setup(): { db: CopyLabDatabase; marketplace: MarketplaceService } {
    db = openDatabase(":memory:");
    return { db, marketplace: new MarketplaceService(db) };
  }

  function seedStrictExecution(input: {
    db: CopyLabDatabase;
    id: string;
    mode?: "PAPER" | "LIVE";
    status?: string;
    applied?: boolean;
    at?: string;
    side?: "BUY" | "SELL";
    sourcePositionId?: string;
    inputAtomic?: string;
    outputAtomic?: string;
    inputUsd?: number;
    outputUsd?: number;
    mint?: string;
    decimals?: number;
    markUsd?: number;
  }): void {
    const at = input.at ?? T1;
    const mode = input.mode ?? "PAPER";
    const status = input.status ?? "CONFIRMED";
    const side = input.side ?? "BUY";
    const mint = input.mint ?? "STRICT_MINT";
    const inputAtomic = input.inputAtomic ?? (side === "BUY" ? "10000000" : "1000000");
    const outputAtomic = input.outputAtomic ?? (side === "BUY" ? "1000000" : "12000000");
    const idempotencyKey = `strict-key:${input.id}`;
    const signature = `strict-signature:${input.id}`;
    const wallet = "strict-wallet";
    const intent = {
      id: `intent:${input.id}`,
      idempotencyKey,
      createdAt: at,
      sourceSwap: {
        sourceSignature: signature,
        sourceWallet: wallet,
        slot: 1,
        blockTime: at,
        detectedAt: at,
        side,
        baseMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        targetMint: mint,
        baseAmountAtomic: "0",
        targetAmountAtomic: "0",
        baseAmountUi: 0,
        targetAmountUi: 0,
        leaderPriceUsd: 0,
        recovered: false
      },
      side,
      inputMint: side === "BUY" ? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" : mint,
      outputMint: side === "BUY" ? mint : "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      inputAmountAtomic: inputAtomic,
      inputAmountUsd: input.inputUsd ?? 10,
      ...(input.sourcePositionId ? { sourcePositionId: input.sourcePositionId } : {})
    } satisfies CopyIntent;
    const execution = {
      id: input.id,
      idempotencyKey,
      mode,
      status,
      quote: {
        requestId: `quote:${input.id}`,
        inputMint: intent.inputMint,
        outputMint: intent.outputMint,
        inputAmountAtomic: inputAtomic,
        outputAmountAtomic: outputAtomic,
        inputUsd: input.inputUsd ?? 10,
        outputUsd: input.outputUsd ?? 12,
        priceImpactPercent: 0,
        feeBps: 0,
        signatureFeeLamports: 0,
        prioritizationFeeLamports: 0,
        rentFeeLamports: 0,
        quotedAt: at
      },
      actualInputAtomic: inputAtomic,
      actualOutputAtomic: outputAtomic,
      actualFeesUsd: 0,
      createdAt: at,
      updatedAt: at
    } as unknown as ExecutionRecord;
    input.db.prepare(`
      INSERT OR IGNORE INTO source_events(
        signature, wallet, event_json, observed_at, recovered, processed
      ) VALUES (?, ?, '{}', ?, 0, 1)
    `).run(signature, wallet, at);
    input.db.prepare(`
      INSERT INTO signal_decisions(
        id, source_signature, source_wallet, idempotency_key,
        intent_json, token_json, decision_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, '{}', ?)
    `).run(
      `decision:${input.id}`,
      signature,
      wallet,
      idempotencyKey,
      JSON.stringify(intent),
      JSON.stringify({ mint, decimals: input.decimals ?? 6 }),
      at
    );
    input.db.prepare(`
      INSERT INTO executions(
        id, idempotency_key, status, mode, execution_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(input.id, idempotencyKey, status, mode, JSON.stringify(execution), at, at);
    if (input.applied !== false) {
      input.db.prepare(`
        INSERT INTO execution_applications(execution_id, applied_at) VALUES (?, ?)
      `).run(input.id, at);
    }
    if (input.markUsd !== undefined) {
      const position = {
        id: input.id,
        mint,
        mode,
        status: "OPEN",
        remainingAmountAtomic: outputAtomic,
        lastExecutableValueUsd: input.markUsd
      };
      input.db.prepare(`
        INSERT INTO positions(id, mode, mint, status, position_json, updated_at)
        VALUES (?, ?, ?, 'OPEN', ?, ?)
      `).run(input.id, mode, mint, JSON.stringify(position), T2);
    }
  }

  function seedStrictNav(db: CopyLabDatabase, at: string, navUsd: number): void {
    db.prepare(`
      INSERT INTO portfolio_snapshots(mode, captured_at, snapshot_json)
      VALUES ('PAPER', ?, ?)
    `).run(at, JSON.stringify({ mode: "PAPER", capturedAt: at, navUsd }));
  }

  function seedStockBase(db: CopyLabDatabase, laneId = "stock-lane"): void {
    db.prepare(`
      INSERT INTO stock_paper_lanes(
        id, label, purpose, policy_version, policy_json, initial_nav_usd,
        status, started_at, updated_at
      ) VALUES (?, 'US STOCK HIGH-RISK PAPER — RESEARCH ONLY', 'RESEARCH_ONLY',
        'stock-paper-v3', '{}', 1000, 'ACTIVE', ?, ?)
    `).run(laneId, T0, T0);
    db.prepare(`
      INSERT INTO stock_paper_accounts(lane_id, account_json, updated_at)
      VALUES (?, ?, ?)
    `).run(laneId, JSON.stringify({
      laneId,
      initialNavUsd: 1_000,
      cashUsd: 1_000,
      navUsd: 1_000,
      peakNavUsd: 1_000,
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
      dayKey: T0.slice(0, 10),
      dayStartNavUsd: 1_000,
      updatedAt: T0
    }), T0);
  }

  function seedStockEquity(db: CopyLabDatabase, laneId: string, at: string, navUsd: number): void {
    db.prepare(`
      INSERT INTO stock_paper_equity_points(lane_id, captured_at, point_json)
      VALUES (?, ?, ?)
    `).run(laneId, at, JSON.stringify({ capturedAt: at, navUsd, cashUsd: navUsd, deployedUsd: 0, drawdownPercent: 0 }));
  }

  function seedStockOrder(input: {
    db: CopyLabDatabase;
    laneId: string;
    id: string;
    positionId: string;
    symbol: string;
    side: "BUY" | "SELL";
    status?: "PARTIAL" | "FILLED" | "CANCELED";
    quantity: number;
    requestedQuantity?: number;
    priceUsd: number;
    costsUsd?: number;
    at: string;
  }): void {
    const status = input.status ?? "FILLED";
    const fill = {
      id: `${input.id}:fill`,
      quantity: input.quantity,
      priceUsd: input.priceUsd,
      notionalUsd: input.quantity * input.priceUsd,
      modeledCostsUsd: input.costsUsd ?? 0,
      evidence: "QUOTE" as const,
      evidenceAt: input.at,
      createdAt: input.at
    };
    const order = {
      id: input.id,
      idempotencyKey: input.id,
      laneId: input.laneId,
      positionId: input.positionId,
      symbol: input.symbol,
      arm: "BREAKOUT",
      side: input.side,
      status,
      phase: "REGULAR",
      feed: "IEX",
      policyVersion: "stock-paper-v3",
      executionVersion: "stock-paper-execution-v3",
      submittedAt: input.at,
      expiresAt: input.at,
      limitPriceUsd: input.priceUsd,
      requestedQuantity: input.requestedQuantity ?? input.quantity,
      filledQuantity: input.quantity,
      averageFillPriceUsd: input.priceUsd,
      reservedNotionalUsd: 0,
      candidateScore: 1,
      fills: status === "CANCELED" ? [] : [fill],
      updatedAt: input.at
    } as unknown as StockPaperOrder;
    input.db.prepare(`
      INSERT INTO stock_paper_orders(
        id, idempotency_key, lane_id, symbol, side, status,
        submitted_at, updated_at, order_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
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
    if (status !== "FILLED") return;
    const event = {
      id: `${input.id}:event`,
      idempotencyKey: `${input.id}:event`,
      laneId: input.laneId,
      orderId: input.id,
      sequence: 1,
      positionId: input.positionId,
      symbol: input.symbol,
      side: input.side,
      eventType: "FILL",
      priorStatus: "SUBMITTED",
      newStatus: "FILLED",
      decisionAt: input.at,
      phase: "REGULAR",
      feed: "IEX",
      assumptions: {
        executionVersion: "stock-paper-execution-v3",
        limitPriceUsd: input.priceUsd,
        participationRatePercent: 100,
        marketable: false
      },
      fill,
      reason: "Committed test fill.",
      createdAt: input.at
    } as unknown as StockPaperOrderEvent;
    input.db.prepare(`
      INSERT INTO stock_paper_order_events(
        id, idempotency_key, lane_id, order_id, event_sequence,
        symbol, side, event_type, prior_status, new_status,
        decision_at, phase, feed, created_at, event_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'FILL', 'SUBMITTED', 'FILLED', ?, 'REGULAR', 'IEX', ?, ?)
    `).run(
      event.id,
      event.idempotencyKey,
      event.laneId,
      event.orderId,
      event.sequence,
      event.symbol,
      event.side,
      event.decisionAt,
      event.createdAt,
      JSON.stringify(event)
    );
  }

  function upsertStockPosition(input: {
    db: CopyLabDatabase;
    laneId: string;
    id: string;
    symbol: string;
    quantity: number;
    executableValueUsd: number;
    at: string;
    status?: "OPEN" | "CLOSED";
  }): void {
    const position = {
      id: input.id,
      laneId: input.laneId,
      symbol: input.symbol,
      arm: "BREAKOUT",
      status: input.status ?? "OPEN",
      quantity: input.quantity,
      entryPriceUsd: 1,
      entryNotionalUsd: input.quantity,
      remainingCostUsd: input.quantity,
      lastBidUsd: input.executableValueUsd / Math.max(input.quantity, 1),
      lastAskUsd: input.executableValueUsd / Math.max(input.quantity, 1),
      lastMarkUsd: input.executableValueUsd / Math.max(input.quantity, 1),
      lastValueUsd: input.executableValueUsd,
      lastExecutableValueUsd: input.executableValueUsd,
      peakPriceUsd: 1,
      stopPriceUsd: 0.8,
      takeProfitPriceUsd: 1.2,
      scoreAtEntry: 1,
      openedAt: T0,
      updatedAt: input.at,
      ...(input.status === "CLOSED" ? { closedAt: input.at } : {})
    } as unknown as StockPaperPosition;
    input.db.prepare(`
      INSERT INTO stock_paper_positions(
        id, lane_id, symbol, arm, status, position_json, updated_at
      ) VALUES (?, ?, ?, 'BREAKOUT', ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        position_json = excluded.position_json,
        updated_at = excluded.updated_at
    `).run(
      input.id,
      input.laneId,
      input.symbol,
      position.status,
      JSON.stringify(position),
      input.at
    );
  }

  it("mirrors only applied confirmed strict PAPER evidence, marks it, and replays idempotently", async () => {
    const { db, marketplace } = setup();
    const enrollment = marketplace.enroll({
      pilotId: "pilot:strict-wallet-copy",
      allocation: { kind: "USD", value: 100 },
      idempotencyKey: "strict-enroll",
      requestedAt: T0
    });
    seedStrictNav(db, T1, 100);
    seedStrictExecution({ db, id: "strict-open", at: T1, markUsd: 12 });
    seedStrictExecution({ db, id: "strict-live", mode: "LIVE", at: T1 });
    seedStrictExecution({ db, id: "strict-unapplied", applied: false, at: T1 });
    seedStrictExecution({ db, id: "strict-failed", status: "FAILED", at: T1 });

    const changes: string[] = [];
    const coordinator = new MarketplaceMirrorCoordinator(db, {
      pageSize: 2,
      onChanged: (change) => changes.push(`${change.kind}:${change.sourceReference}`)
    });
    await coordinator.reconcileStartup();

    expect(marketplace.paperFills(enrollment.id)).toHaveLength(1);
    expect(marketplace.repository.paperMarks(enrollment.id)).toHaveLength(1);
    expect(marketplace.enrollment(enrollment.id)?.account).toMatchObject({
      cashUsd: 90,
      deployedUsd: 12,
      navUsd: 102,
      openPositions: 1
    });
    expect(changes).toHaveLength(2);

    const replayChanges: string[] = [];
    const restarted = new MarketplaceMirrorCoordinator(db, {
      pageSize: 2,
      onChanged: (change) => replayChanges.push(change.sourceReference)
    });
    await restarted.reconcileStartup();
    expect(marketplace.paperFills(enrollment.id)).toHaveLength(1);
    expect(marketplace.repository.paperMarks(enrollment.id)).toHaveLength(1);
    expect(replayChanges).toEqual([]);
  });

  it("sizes stock opens from the nearest committed source NAV, compounds destination NAV, and ignores partial orders", async () => {
    const { db, marketplace } = setup();
    const laneId = "stock-nav-lane";
    seedStockBase(db, laneId);
    const enrollment = marketplace.enroll({
      pilotId: "pilot:stock-momentum",
      allocation: { kind: "USD", value: 1_000 },
      idempotencyKey: "stock-nav-enroll",
      requestedAt: T0
    });
    seedStockEquity(db, laneId, T1, 2_000);
    seedStockOrder({
      db, laneId, id: "stock-buy-a", positionId: "source-a", symbol: "AAA",
      side: "BUY", quantity: 2, priceUsd: 100, at: T1
    });
    seedStockOrder({
      db, laneId, id: "stock-partial", positionId: "source-partial", symbol: "PART",
      side: "BUY", status: "PARTIAL", quantity: 1, requestedQuantity: 2, priceUsd: 50, at: T1
    });
    upsertStockPosition({
      db, laneId, id: "source-a", symbol: "AAA", quantity: 2,
      executableValueUsd: 220, at: T2
    });

    const coordinator = new MarketplaceMirrorCoordinator(db, { pageSize: 1 });
    coordinator.afterStockCycle(laneId);
    await coordinator.drain();
    expect(marketplace.repository.openPaperPosition(enrollment.id, "AAA")).toMatchObject({
      entryNotionalUsd: 100,
      lastExecutableValueUsd: 110
    });
    expect(marketplace.repository.openPaperPosition(enrollment.id, "PART")).toBeUndefined();
    expect(marketplace.enrollment(enrollment.id)?.account.navUsd).toBe(1_010);

    seedStockEquity(db, laneId, T3, 1_000);
    seedStockOrder({
      db, laneId, id: "stock-buy-b", positionId: "source-b", symbol: "BBB",
      side: "BUY", quantity: 2, priceUsd: 50, at: T3
    });
    upsertStockPosition({
      db, laneId, id: "source-b", symbol: "BBB", quantity: 2,
      executableValueUsd: 100, at: T3
    });
    coordinator.afterStockCycle(laneId);
    coordinator.afterStockCycle(laneId);
    await coordinator.drain();

    expect(marketplace.repository.openPaperPosition(enrollment.id, "BBB")?.entryNotionalUsd)
      .toBe(101);
    expect(marketplace.paperFills(enrollment.id).filter((fill) => fill.action === "OPEN"))
      .toHaveLength(2);
  });

  it("uses source-time pause gates and mirrors pro-rata exits while paused", async () => {
    const { db, marketplace } = setup();
    const laneId = "stock-pause-lane";
    seedStockBase(db, laneId);
    const enrollment = marketplace.enroll({
      pilotId: "pilot:stock-momentum",
      allocation: { kind: "USD", value: 1_000 },
      idempotencyKey: "stock-pause-enroll",
      requestedAt: T0
    });
    seedStockEquity(db, laneId, T1, 1_000);
    seedStockOrder({
      db, laneId, id: "stock-buy-main", positionId: "source-main", symbol: "MAIN",
      side: "BUY", quantity: 10, priceUsd: 10, at: T1
    });
    upsertStockPosition({
      db, laneId, id: "source-main", symbol: "MAIN", quantity: 10,
      executableValueUsd: 100, at: T1
    });
    const coordinatorErrors: string[] = [];
    const coordinator = new MarketplaceMirrorCoordinator(db, {
      onError: (stage, error) => coordinatorErrors.push(
        `${stage}:${error instanceof Error ? error.message : String(error)}`
      )
    });
    coordinator.afterStockCycle(laneId);
    await coordinator.drain();
    const original = marketplace.repository.openPaperPosition(enrollment.id, "MAIN");
    expect(original?.quantity).toBe(10);

    marketplace.pause({
      enrollmentId: enrollment.id,
      idempotencyKey: "stock-pause",
      requestedAt: T2
    });
    seedStockEquity(db, laneId, T3, 1_000);
    seedStockOrder({
      db, laneId, id: "stock-buy-paused", positionId: "source-paused", symbol: "PAUSED",
      side: "BUY", quantity: 1, priceUsd: 100, at: T3
    });
    seedStockOrder({
      db, laneId, id: "stock-sell-half", positionId: "source-main", symbol: "MAIN",
      side: "SELL", quantity: 5, priceUsd: 12, at: T3
    });
    upsertStockPosition({
      db, laneId, id: "source-main", symbol: "MAIN", quantity: 5,
      executableValueUsd: 60, at: T3
    });
    coordinator.afterStockCycle(laneId);
    await coordinator.drain();

    expect(marketplace.repository.openPaperPosition(enrollment.id, "PAUSED")).toBeUndefined();
    expect(marketplace.repository.openPaperPosition(enrollment.id, "MAIN")?.quantity).toBe(5);
    expect(marketplace.paperFills(enrollment.id).map((fill) => fill.action))
      .toEqual(["REDUCE", "OPEN"]);

    seedStockEquity(db, laneId, T4, 1_000);
    seedStockOrder({
      db, laneId, id: "stock-sell-rest", positionId: "source-main", symbol: "MAIN",
      side: "SELL", quantity: 5, priceUsd: 13, at: T4
    });
    upsertStockPosition({
      db, laneId, id: "source-main", symbol: "MAIN", quantity: 0,
      executableValueUsd: 0, at: T4, status: "CLOSED"
    });
    coordinator.afterStockCycle(laneId);
    await coordinator.drain();
    expect(coordinatorErrors).toEqual([]);
    expect(marketplace.paperPositions(enrollment.id)[0]).toMatchObject({
      status: "CLOSED",
      quantity: 0,
      realizedPnlUsd: 25
    });

    marketplace.resume({
      enrollmentId: enrollment.id,
      idempotencyKey: "stock-resume",
      requestedAt: T5
    });
    coordinator.afterStockCycle(laneId);
    await coordinator.drain();
    // The order observed while paused remains excluded after a later resume.
    expect(marketplace.repository.openPaperPosition(enrollment.id, "PAUSED")).toBeUndefined();
  });

  it("rejects an oversized deterministic mirror instead of clamping it to cash", async () => {
    const { db, marketplace } = setup();
    const laneId = "stock-cash-lane";
    seedStockBase(db, laneId);
    const enrollment = marketplace.enroll({
      pilotId: "pilot:stock-momentum",
      allocation: { kind: "USD", value: 100 },
      idempotencyKey: "stock-cash-enroll",
      requestedAt: T0
    });
    seedStockEquity(db, laneId, T1, 100);
    seedStockOrder({
      db, laneId, id: "stock-buy-too-large", positionId: "source-large", symbol: "BIG",
      side: "BUY", quantity: 2, priceUsd: 100, at: T1
    });
    upsertStockPosition({
      db, laneId, id: "source-large", symbol: "BIG", quantity: 2,
      executableValueUsd: 200, at: T1
    });
    const failures: string[] = [];
    const coordinator = new MarketplaceMirrorCoordinator(db, {
      onError: (stage) => failures.push(stage)
    });
    coordinator.afterStockCycle(laneId);
    await coordinator.drain();

    expect(failures).toContain("marketplace_mirror_stock_open");
    expect(marketplace.paperFills(enrollment.id)).toEqual([]);
    expect(marketplace.enrollment(enrollment.id)?.account).toMatchObject({
      cashUsd: 100,
      deployedUsd: 0,
      navUsd: 100
    });
  });
});
