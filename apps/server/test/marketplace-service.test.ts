import { afterEach, describe, expect, it, vi } from "vitest";
import type { CopyLabDatabase } from "../src/database.js";
import { openDatabase } from "../src/database.js";
import { MarketplaceService } from "../src/marketplace-service.js";

describe("PAPER strategy marketplace", () => {
  let db: CopyLabDatabase | undefined;

  afterEach(() => {
    vi.useRealTimers();
    db?.close();
  });

  function service(): MarketplaceService {
    db = openDatabase(":memory:");
    return new MarketplaceService(db);
  }

  it("publishes deterministic transparent pilots and fail-closed broker capabilities", () => {
    const marketplace = service();
    const catalog = marketplace.catalog({
      ALPACA_PAPER: {
        connectionStatus: "CONNECTED_LOCAL_SIMULATION",
        message: "Official paper data connected; marketplace routing disabled."
      }
    });

    expect(catalog).toMatchObject({
      paperOnly: true,
      executionModel: "INTERNAL_PAPER",
      liveOrderCapabilityEnabled: false
    });
    expect(catalog.pilots).toHaveLength(7);
    expect(catalog.pilots.every((pilot) =>
      pilot.paperAvailable === (pilot.status === "ACTIVE" && pilot.automaticMirroring) &&
      pilot.executionModel === "INTERNAL_PAPER" &&
      pilot.mirroringDestination === "ISOLATED_VIRTUAL_ACCOUNT" &&
      pilot.latestPerformance?.disclosure
    )).toBe(true);
    expect(catalog.brokers.find((broker) => broker.id === "ALPACA_PAPER"))
      .toMatchObject({
        connectionStatus: "CONNECTED_LOCAL_SIMULATION",
        liveExecutionSupported: false,
        automaticOrderSubmissionEnabled: false
      });
    expect(catalog.brokers.find((broker) => broker.id === "ROBINHOOD_EQUITIES"))
      .toMatchObject({
        connectionStatus: "NOT_CONFIGURED_LIVE_LOCKED",
        automaticOrderSubmissionEnabled: false
      });
    expect(catalog.brokers.find((broker) => broker.id === "ROBINHOOD_EQUITIES")?.message)
      .toMatch(/no Robinhood connector or setup flow is implemented/iu);
    expect(catalog.brokers.find((broker) => broker.id === "ROBINHOOD_CRYPTO"))
      .toMatchObject({ connectionStatus: "NOT_CONFIGURED_LIVE_LOCKED" });
    for (const pilotId of [
      "pilot:thematic-trend-basket",
      "pilot:hedge-fund-13f-tracker",
      "pilot:politician-disclosure-tracker"
    ]) {
      const research = catalog.pilots.find((pilot) => pilot.id === pilotId);
      expect(research).toMatchObject({ status: "RESEARCH_ONLY", paperAvailable: false });
      expect(research?.longDescription).toMatch(/catalog-only/iu);
    }
  });

  it("enrolls only active functional INTERNAL_PAPER pilots and keeps accounts isolated", () => {
    const marketplace = service();
    const strict = marketplace.enroll({
      pilotId: "pilot:strict-wallet-copy",
      allocation: { kind: "USD", value: 141 },
      idempotencyKey: "enroll-strict",
      requestedAt: "2026-07-18T12:00:00.000Z"
    });
    const stock = marketplace.enroll({
      pilotId: "pilot:stock-momentum",
      allocation: { kind: "PERCENT", value: 20, referenceNavUsd: 1_000 },
      idempotencyKey: "enroll-stock",
      requestedAt: "2026-07-18T12:00:01.000Z"
    });

    expect(strict.account).toMatchObject({ fundedCapitalUsd: 141, cashUsd: 141, navUsd: 141 });
    expect(stock.account).toMatchObject({ fundedCapitalUsd: 200, cashUsd: 200, navUsd: 200 });
    expect(strict.id).not.toBe(stock.id);
    expect(marketplace.enroll({
      pilotId: "pilot:strict-wallet-copy",
      allocation: { kind: "USD", value: 141 },
      idempotencyKey: "enroll-strict",
      requestedAt: "2026-07-18T12:00:00.000Z"
    })).toEqual(strict);
    expect(() => marketplace.enroll({
      pilotId: "pilot:hedge-fund-13f-tracker",
      allocation: { kind: "USD", value: 500 },
      idempotencyKey: "enroll-13f"
    })).toThrow(/unavailable/u);
    expect(() => marketplace.enroll({
      pilotId: "pilot:strict-wallet-copy",
      allocation: { kind: "USD", value: 141 },
      mode: "LIVE" as never,
      idempotencyKey: "live-collision"
    })).toThrow(/PAPER-only/u);
  });

  it("updates allocation through a preview and idempotent rebalance without creating profit", () => {
    const marketplace = service();
    const enrolled = marketplace.enroll({
      pilotId: "pilot:strict-wallet-copy",
      allocation: { kind: "USD", value: 141 },
      idempotencyKey: "rebalance-enroll",
      requestedAt: "2026-07-18T12:00:00.000Z"
    });
    marketplace.updateAllocation({
      enrollmentId: enrolled.id,
      allocation: { kind: "USD", value: 250 },
      idempotencyKey: "rebalance-allocation",
      requestedAt: "2026-07-18T12:01:00.000Z"
    });
    const preview = marketplace.previewRebalance({
      enrollmentId: enrolled.id,
      idempotencyKey: "rebalance-preview",
      requestedAt: "2026-07-18T12:02:00.000Z"
    });
    expect(preview).toMatchObject({ cashDeltaUsd: 109, canApply: true, status: "PREVIEWED" });
    const applied = marketplace.applyRebalance({
      previewId: preview.id,
      idempotencyKey: "rebalance-apply",
      requestedAt: "2026-07-18T12:03:00.000Z"
    });
    expect(applied.status).toBe("APPLIED");
    expect(marketplace.enrollment(enrolled.id)?.account).toMatchObject({
      fundedCapitalUsd: 250,
      navUsd: 250,
      cashUsd: 250,
      realizedPnlUsd: 0,
      unrealizedPnlUsd: 0
    });
    expect(marketplace.applyRebalance({
      previewId: preview.id,
      idempotencyKey: "rebalance-apply",
      requestedAt: "2026-07-18T12:03:00.000Z"
    })).toEqual(applied);
  });

  it("opens and closes attributed mirror fills with cash, exposure, and P&L accounting", () => {
    const marketplace = service();
    const enrolled = marketplace.enroll({
      pilotId: "pilot:strict-wallet-copy",
      allocation: { kind: "USD", value: 141 },
      idempotencyKey: "fill-enroll",
      requestedAt: "2026-07-18T12:00:00.000Z"
    });
    const opened = marketplace.applyPaperFill({
      action: "OPEN",
      enrollmentId: enrolled.id,
      assetId: "SOL",
      quantity: 1,
      priceUsd: 20,
      modeledCostsUsd: 0.2,
      sourceReference: "source-buy-1",
      idempotencyKey: "fill-open-1",
      filledAt: "2026-07-18T12:01:00.000Z"
    });
    expect(opened).toMatchObject({ action: "OPEN", grossNotionalUsd: 20, netCashChangeUsd: -20.2 });
    expect(marketplace.enrollment(enrolled.id)?.account).toMatchObject({
      navUsd: 140.8,
      cashUsd: 120.8,
      deployedUsd: 20,
      unrealizedPnlUsd: -0.2,
      openPositions: 1
    });
    expect(marketplace.applyPaperFill({
      action: "OPEN",
      enrollmentId: enrolled.id,
      assetId: "SOL",
      quantity: 1,
      priceUsd: 20,
      modeledCostsUsd: 0.2,
      sourceReference: "source-buy-1",
      idempotencyKey: "fill-open-1",
      filledAt: "2026-07-18T12:01:00.000Z"
    })).toEqual(opened);

    const closed = marketplace.applyPaperFill({
      action: "CLOSE",
      enrollmentId: enrolled.id,
      positionId: opened.positionId,
      assetId: "SOL",
      quantity: 1,
      priceUsd: 22,
      modeledCostsUsd: 0.2,
      sourceReference: "source-sell-1",
      idempotencyKey: "fill-close-1",
      filledAt: "2026-07-18T12:02:00.000Z"
    });
    expect(closed).toMatchObject({ action: "CLOSE", grossNotionalUsd: 22, netCashChangeUsd: 21.8 });
    expect(marketplace.enrollment(enrolled.id)?.account).toMatchObject({
      navUsd: 142.6,
      cashUsd: 142.6,
      deployedUsd: 0,
      realizedPnlUsd: 1.6,
      unrealizedPnlUsd: 0,
      openPositions: 0
    });
    expect(marketplace.paperPositions(enrolled.id)).toEqual([
      expect.objectContaining({ id: opened.positionId, status: "CLOSED", realizedPnlUsd: 1.6 })
    ]);
    expect(marketplace.events(enrolled.id).map((event) => event.kind))
      .toEqual(["PAPER_MIRROR_CLOSED", "PAPER_MIRROR_OPENED", "ENROLLED"]);
  });

  it("marks and partially reduces precise positions atomically while paused", () => {
    const marketplace = service();
    const enrolled = marketplace.enroll({
      pilotId: "pilot:strict-wallet-copy",
      allocation: { kind: "USD", value: 141 },
      idempotencyKey: "precise-enroll",
      requestedAt: "2026-07-18T12:00:00.000Z"
    });
    const preciseQuantity = 0.123456789123;
    const opened = marketplace.applyPaperFill({
      action: "OPEN",
      enrollmentId: enrolled.id,
      assetId: "SOL",
      quantity: preciseQuantity,
      priceUsd: 100,
      modeledCostsUsd: 0.1,
      sourceReference: "source:open:precise",
      sourcePositionReference: "source-position:precise",
      sourceOccurredAt: "2026-07-18T12:00:59.000Z",
      idempotencyKey: "precise-open",
      filledAt: "2026-07-18T12:01:00.000Z"
    });
    expect(opened.quantity).toBe(preciseQuantity);
    expect(marketplace.repository.openPaperPositionBySource(
      enrolled.id,
      "source-position:precise"
    )?.quantity).toBe(preciseQuantity);

    const marked = marketplace.markPaperPosition({
      enrollmentId: enrolled.id,
      sourcePositionReference: "source-position:precise",
      assetId: "SOL",
      priceUsd: 120,
      sourceReference: "source:mark:one",
      sourceOccurredAt: "2026-07-18T12:01:59.000Z",
      idempotencyKey: "precise-mark-one",
      recordedAt: "2026-07-18T12:02:00.000Z"
    });
    expect(marked).toMatchObject({
      previousExecutableValueUsd: 12.345679,
      executableValueUsd: 14.814815,
      sourceOccurredAt: "2026-07-18T12:01:59.000Z"
    });
    expect(marketplace.enrollment(enrolled.id)?.account).toMatchObject({
      navUsd: 143.369136,
      deployedUsd: 14.814815,
      unrealizedPnlUsd: 2.369136,
      openPositions: 1
    });
    expect(marketplace.markPaperPosition({
      enrollmentId: enrolled.id,
      sourcePositionReference: "source-position:precise",
      assetId: "SOL",
      priceUsd: 120,
      sourceReference: "source:mark:one",
      sourceOccurredAt: "2026-07-18T12:01:59.000Z",
      idempotencyKey: "precise-mark-one",
      recordedAt: "2026-07-18T12:02:00.000Z"
    })).toEqual(marked);
    expect(() => marketplace.markPaperPosition({
      enrollmentId: enrolled.id,
      sourcePositionReference: "source-position:precise",
      assetId: "SOL",
      priceUsd: 121,
      sourceReference: "source:mark:one",
      sourceOccurredAt: "2026-07-18T12:01:59.000Z",
      idempotencyKey: "a-different-mark-key",
      recordedAt: "2026-07-18T12:02:00.000Z"
    })).toThrow(/collided/iu);

    marketplace.pause({
      enrollmentId: enrolled.id,
      idempotencyKey: "precise-pause",
      requestedAt: "2026-07-18T12:03:00.000Z"
    });
    expect(() => marketplace.applyPaperFill({
      action: "OPEN",
      enrollmentId: enrolled.id,
      assetId: "BONK",
      quantity: 1,
      priceUsd: 1,
      modeledCostsUsd: 0,
      sourceReference: "source:paused-open",
      idempotencyKey: "precise-paused-open",
      filledAt: "2026-07-18T12:04:00.000Z"
    })).toThrow(/active enrollment/iu);

    const reduced = marketplace.applyPaperFill({
      action: "REDUCE",
      enrollmentId: enrolled.id,
      sourcePositionReference: "source-position:precise",
      assetId: "SOL",
      quantity: 0.023456789123,
      priceUsd: 125,
      modeledCostsUsd: 0.05,
      sourceReference: "source:reduce:one",
      sourceOccurredAt: "2026-07-18T12:03:59.000Z",
      idempotencyKey: "precise-reduce-one",
      filledAt: "2026-07-18T12:04:00.000Z"
    });
    expect(reduced.action).toBe("REDUCE");
    const remaining = marketplace.repository.openPaperPositionBySource(
      enrolled.id,
      "source-position:precise"
    );
    expect(remaining?.quantity).toBeCloseTo(0.1, 14);
    expect(remaining?.costBasisUsd).toBeLessThan(12.445679);
    expect(remaining?.realizedPnlUsd).toBeCloseTo(reduced.netCashChangeUsd -
      (12.445679 - (remaining?.costBasisUsd ?? 0)), 6);
    expect(marketplace.enrollment(enrolled.id)?.account.openPositions).toBe(1);

    const secondMark = marketplace.markPaperPosition({
      enrollmentId: enrolled.id,
      positionId: opened.positionId,
      assetId: "SOL",
      priceUsd: 130,
      sourceReference: "source:mark:two",
      sourceOccurredAt: "2026-07-18T12:04:59.000Z",
      idempotencyKey: "precise-mark-two",
      recordedAt: "2026-07-18T12:05:00.000Z"
    });
    expect(secondMark.executableValueUsd).toBe(13);

    const closed = marketplace.applyPaperFill({
      action: "CLOSE",
      enrollmentId: enrolled.id,
      sourcePositionReference: "source-position:precise",
      assetId: "SOL",
      quantity: remaining!.quantity,
      priceUsd: 135,
      modeledCostsUsd: 0.05,
      sourceReference: "source:close:precise",
      sourceOccurredAt: "2026-07-18T12:05:59.000Z",
      idempotencyKey: "precise-close",
      filledAt: "2026-07-18T12:06:00.000Z"
    });
    expect(closed.action).toBe("CLOSE");
    expect(marketplace.enrollment(enrolled.id)?.account).toMatchObject({
      deployedUsd: 0,
      unrealizedPnlUsd: 0,
      openPositions: 0
    });
    expect(marketplace.enrollment(enrolled.id)?.account.navUsd)
      .toBe(marketplace.enrollment(enrolled.id)?.account.cashUsd);
    expect(marketplace.paperMarks(enrolled.id)).toHaveLength(2);
    expect(marketplace.events(enrolled.id).map((entry) => entry.kind)).toEqual([
      "PAPER_MIRROR_CLOSED",
      "PAPER_POSITION_MARKED",
      "PAPER_MIRROR_REDUCED",
      "PAUSED",
      "PAPER_POSITION_MARKED",
      "PAPER_MIRROR_OPENED",
      "ENROLLED"
    ]);
  });

  it("replays coordinator evidence when local commit timestamps were intentionally omitted", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-18T12:01:00.000Z"));
    const marketplace = service();
    const enrolled = marketplace.enroll({
      pilotId: "pilot:strict-wallet-copy",
      allocation: { kind: "USD", value: 141 },
      idempotencyKey: "replay-enroll",
      requestedAt: "2026-07-18T12:00:00.000Z"
    });
    const fillInput = {
      action: "OPEN" as const,
      enrollmentId: enrolled.id,
      assetId: "SOL",
      quantity: 0.000000123456789,
      priceUsd: 100,
      modeledCostsUsd: 0,
      sourceReference: "source:replay:open",
      sourcePositionReference: "source-position:replay",
      sourceOccurredAt: "2026-07-18T12:00:59.000Z",
      idempotencyKey: "replay-open"
    };
    const opened = marketplace.applyPaperFill(fillInput);
    vi.setSystemTime(new Date("2026-07-18T12:02:00.000Z"));
    expect(marketplace.applyPaperFill(fillInput)).toEqual(opened);

    const markInput = {
      enrollmentId: enrolled.id,
      sourcePositionReference: "source-position:replay",
      assetId: "SOL",
      priceUsd: 110,
      sourceReference: "source:replay:mark",
      sourceOccurredAt: "2026-07-18T12:01:30.000Z",
      idempotencyKey: "replay-mark"
    };
    const mark = marketplace.markPaperPosition(markInput);
    vi.setSystemTime(new Date("2026-07-18T12:03:00.000Z"));
    expect(marketplace.markPaperPosition(markInput)).toEqual(mark);
  });

  it("switches atomically only with zero exposure and preserves the PAPER allocation", () => {
    const marketplace = service();
    const source = marketplace.enroll({
      pilotId: "pilot:stock-momentum",
      allocation: { kind: "USD", value: 250 },
      idempotencyKey: "switch-enroll",
      requestedAt: "2026-07-18T12:00:00.000Z"
    });
    const switched = marketplace.switchPilot({
      sourceEnrollmentId: source.id,
      targetPilotId: "pilot:strict-wallet-copy",
      idempotencyKey: "switch-1",
      requestedAt: "2026-07-18T12:01:00.000Z"
    });
    expect(switched.source.status).toBe("UNENROLLED");
    expect(switched.target).toMatchObject({
      pilotId: "pilot:strict-wallet-copy",
      status: "ACTIVE",
      allocation: { kind: "USD", value: 250 },
      targetAllocationUsd: 250,
      account: { fundedCapitalUsd: 250, cashUsd: 250, navUsd: 250 }
    });
    expect(marketplace.switchPilot({
      sourceEnrollmentId: source.id,
      targetPilotId: "pilot:strict-wallet-copy",
      idempotencyKey: "switch-1",
      requestedAt: "2026-07-18T12:01:00.000Z"
    })).toEqual(switched);
  });

  it("switches executable cash into a fresh target baseline without erasing source history", () => {
    const marketplace = service();
    const source = marketplace.enroll({
      pilotId: "pilot:strict-wallet-copy",
      allocation: { kind: "USD", value: 250 },
      idempotencyKey: "switch-gain-enroll",
      requestedAt: "2026-07-18T12:00:00.000Z"
    });
    const opened = marketplace.applyPaperFill({
      action: "OPEN",
      enrollmentId: source.id,
      assetId: "SOL",
      quantity: 1,
      priceUsd: 10,
      modeledCostsUsd: 0,
      sourceReference: "switch-gain-open-source",
      sourcePositionReference: "switch-gain-position",
      idempotencyKey: "switch-gain-open",
      filledAt: "2026-07-18T12:01:00.000Z"
    });
    marketplace.applyPaperFill({
      action: "CLOSE",
      enrollmentId: source.id,
      positionId: opened.positionId,
      assetId: "SOL",
      quantity: 1,
      priceUsd: 12,
      modeledCostsUsd: 0,
      sourceReference: "switch-gain-close-source",
      idempotencyKey: "switch-gain-close",
      filledAt: "2026-07-18T12:02:00.000Z"
    });

    const switched = marketplace.switchPilot({
      sourceEnrollmentId: source.id,
      targetPilotId: "pilot:stock-momentum",
      idempotencyKey: "switch-with-gain",
      requestedAt: "2026-07-18T12:03:00.000Z"
    });
    expect(switched.target).toMatchObject({
      allocation: { kind: "USD", value: 252 },
      targetAllocationUsd: 252,
      account: {
        fundedCapitalUsd: 252,
        navUsd: 252,
        cashUsd: 252,
        deployedUsd: 0,
        realizedPnlUsd: 0,
        unrealizedPnlUsd: 0,
        openPositions: 0
      }
    });
    expect(marketplace.events(switched.target.id)[0]?.details).toMatchObject({
      transferredFundedCapitalUsd: 252,
      transferredNavUsd: 252,
      transferredCashUsd: 252,
      sourceRealizedPnlUsd: 2
    });
    expect(switched.source.account.realizedPnlUsd).toBe(2);
  });

  it("checks switch minimums against transferable NAV after losses", () => {
    const marketplace = service();
    const source = marketplace.enroll({
      pilotId: "pilot:strict-wallet-copy",
      allocation: { kind: "USD", value: 100 },
      idempotencyKey: "switch-loss-enroll",
      requestedAt: "2026-07-18T12:00:00.000Z"
    });
    const opened = marketplace.applyPaperFill({
      action: "OPEN",
      enrollmentId: source.id,
      assetId: "SOL",
      quantity: 1,
      priceUsd: 10,
      modeledCostsUsd: 0,
      sourceReference: "switch-loss-open-source",
      sourcePositionReference: "switch-loss-position",
      idempotencyKey: "switch-loss-open",
      filledAt: "2026-07-18T12:01:00.000Z"
    });
    marketplace.applyPaperFill({
      action: "CLOSE",
      enrollmentId: source.id,
      positionId: opened.positionId,
      assetId: "SOL",
      quantity: 1,
      priceUsd: 9,
      modeledCostsUsd: 0,
      sourceReference: "switch-loss-close-source",
      idempotencyKey: "switch-loss-close",
      filledAt: "2026-07-18T12:02:00.000Z"
    });
    expect(marketplace.enrollment(source.id)?.account.navUsd).toBe(99);
    expect(() => marketplace.switchPilot({
      sourceEnrollmentId: source.id,
      targetPilotId: "pilot:stock-momentum",
      idempotencyKey: "switch-loss-below-minimum",
      requestedAt: "2026-07-18T12:03:00.000Z"
    })).toThrow(/requires at least \$100\.00/iu);
  });

  it("snapshots current ledger evidence into immutable history with deterministic replay", () => {
    const marketplace = service();
    db!.prepare(`
      INSERT INTO stock_paper_lanes(
        id, label, purpose, policy_version, policy_json, status,
        initial_nav_usd, started_at, updated_at
      ) VALUES (?, ?, 'RESEARCH_ONLY', ?, '{}', 'ACTIVE', 1000, ?, ?)
    `).run(
      "stock-marketplace-test",
      "US STOCK HIGH-RISK PAPER — RESEARCH ONLY",
      "stock-paper-v3",
      "2026-07-01T00:00:00.000Z",
      "2026-07-18T12:00:00.000Z"
    );
    const account = {
      laneId: "stock-marketplace-test",
      initialNavUsd: 1000,
      cashUsd: 900,
      navUsd: 1020,
      peakNavUsd: 1030,
      deployedUsd: 120,
      realizedPnlUsd: 15,
      unrealizedPnlUsd: 5,
      maxDrawdownPercent: 2,
      openPositions: 1,
      completedTrades: 10,
      winningTrades: 6,
      grossProfitUsd: 30,
      grossLossUsd: 15,
      pricingComplete: true,
      dayKey: "2026-07-18",
      dayStartNavUsd: 1010,
      updatedAt: "2026-07-18T12:00:00.000Z"
    };
    db!.prepare(`
      INSERT INTO stock_paper_accounts(lane_id, account_json, updated_at)
      VALUES (?, ?, ?)
    `).run(account.laneId, JSON.stringify(account), account.updatedAt);

    const first = marketplace.refreshPerformanceEvidence();
    const second = marketplace.refreshPerformanceEvidence();
    expect(first).toEqual(second);
    expect(first).toEqual([
      expect.objectContaining({
        capturedAt: account.updatedAt,
        netReturnPercent: 2,
        completedTrades: 10,
        openPositions: 1,
        profitFactor: 2
      })
    ]);
    expect(marketplace.performanceHistory("pilot:stock-momentum")).toEqual(first);
  });
});
