import { afterEach, describe, expect, it } from "vitest";
import type {
  AlpacaBarsResult,
  AlpacaMarketClock,
  AlpacaPaperProvider,
  AlpacaStockAsset,
  AlpacaStockBar,
  AlpacaStockSnapshot
} from "@copylab/providers";
import {
  STOCK_PAPER_EXECUTION_VERSION,
  STOCK_PAPER_FEATURE_VERSION,
  type StockPaperCandidate,
  type StockPaperEntryContext,
  type StockPaperLane,
  type StockPaperObservation,
  type StockPaperOrder,
  type StockPaperPosition
} from "@copylab/shared";
import { openDatabase, type CopyLabDatabase } from "../src/database.js";
import { createStockPaperLearningObservationV3 } from "../src/stock-paper-learning-v3.js";
import {
  StockPaperEngine,
  stockAssetAllowsFractionalPhase,
  stockAssetSupportsPhase,
  stockPaperOvernightFeedMinutesRemaining,
  stockPaperSellEvidenceTimeoutAt
} from "../src/stock-paper.js";
import { StockPaperRepository } from "../src/stock-paper-repository.js";

function entryBars(endAt = "2026-07-16T14:39:00.000Z"): AlpacaStockBar[] {
  const startAt = Date.parse(endAt) - 39 * 60_000;
  return Array.from({ length: 40 }, (_, index) => {
    const close = 100 + index * 0.12;
    return {
      timestamp: new Date(startAt + index * 60_000).toISOString(),
      open: close - 0.08,
      high: close + 0.12,
      low: close - 0.14,
      close,
      volume: index >= 35 ? 3_000 : 1_000,
      tradeCount: 20,
      vwap: close - 0.2
    };
  });
}

function snapshot(
  price: number,
  timestamp = "2026-07-16T14:40:00Z"
): AlpacaStockSnapshot {
  return {
    symbol: "AAPL",
    latestQuote: {
      timestamp,
      bidPrice: price - 0.05,
      bidSize: 10,
      askPrice: price + 0.05,
      askSize: 10
    },
    latestTrade: {
      timestamp,
      price,
      size: 1
    },
    minuteBar: {
      timestamp: new Date(Date.parse(timestamp) - 60_000).toISOString(),
      open: price - 0.12,
      high: price + 0.08,
      low: price - 0.18,
      close: price,
      volume: 3_000,
      tradeCount: 40,
      vwap: price - 0.04
    },
    dailyBar: {
      timestamp: "2026-07-16T04:00:00Z",
      open: 100,
      high: Math.max(105, price),
      low: Math.min(99, price),
      close: price,
      volume: 500_000,
      tradeCount: 5_000,
      vwap: 102
    },
    previousDailyBar: {
      timestamp: "2026-07-15T04:00:00Z",
      open: 98,
      high: 101,
      low: 97,
      close: 100,
      volume: 450_000,
      tradeCount: 4_500,
      vwap: 99
    }
  };
}

function testAsset(): AlpacaStockAsset {
  return {
    symbol: "AAPL",
    name: "Apple Inc.",
    exchange: "NASDAQ",
    status: "active",
    tradable: true,
    fractionable: true,
    marginable: true,
    shortable: true,
    easyToBorrow: true,
    fractionalEhEnabled: true,
    overnightTradable: true,
    overnightHalted: false
  };
}

function testEntryContext(lane: StockPaperLane, capturedAt: string): StockPaperEntryContext {
  return {
    featureVersion: STOCK_PAPER_FEATURE_VERSION,
    policyVersion: lane.policyVersion,
    executionVersion: STOCK_PAPER_EXECUTION_VERSION,
    policyDigest: "test-policy-digest",
    phase: "OVERNIGHT",
    feed: "OVERNIGHT",
    capturedAt,
    candidateRank: 1,
    candidateScore: 90,
    relativeVolume: 2,
    spreadPercent: 0.1,
    change1mPercent: 1,
    change5mPercent: 2,
    change15mPercent: 3,
    newsArticleCount: 0,
    screenerHit: true,
    learningMultiplier: 1,
    learningStatus: "WARMING_UP",
    learningSampleSize: 0,
    modeledLimitPriceUsd: 100,
    onlineSources: ["MOST_ACTIVE"],
    highConviction: true,
    dollarVolumeUsd: 10_000_000,
    vwapDistancePercent: 1,
    dailyChangePercent: 2
  };
}

function seedPendingBuy(
  repository: StockPaperRepository,
  lane: StockPaperLane,
  submittedAt: string,
  quantity = 0.5,
  includeProvenance = true,
  expiresAt = "2026-07-17T02:00:00.000Z"
): StockPaperOrder {
  const account = repository.account(lane.id);
  if (!account) throw new Error("Expected seeded stock-paper account.");
  const order: StockPaperOrder = {
    id: `test-buy:${submittedAt}`,
    idempotencyKey: `test-buy:${submittedAt}`,
    laneId: lane.id,
    positionId: `test-position:${submittedAt}`,
    symbol: "AAPL",
    arm: "BREAKOUT",
    side: "BUY",
    status: "SUBMITTED",
    phase: "OVERNIGHT",
    feed: "OVERNIGHT",
    policyVersion: lane.policyVersion,
    executionVersion: STOCK_PAPER_EXECUTION_VERSION,
    submittedAt,
    expiresAt,
    firstEligibleBarAt: "2026-07-17T01:21:00.000Z",
    limitPriceUsd: 100,
    requestedQuantity: quantity,
    filledQuantity: 0,
    reservedNotionalUsd: quantity * 100,
    candidateScore: 90,
    ...(includeProvenance ? { entryContext: testEntryContext(lane, submittedAt) } : {}),
    fills: [],
    updatedAt: submittedAt
  };
  repository.commitCycle({
    account,
    positions: [],
    orders: [order],
    equityPoint: {
      capturedAt: submittedAt,
      navUsd: account.navUsd,
      cashUsd: account.cashUsd,
      deployedUsd: account.deployedUsd,
      drawdownPercent: 0
    },
    market: {
      feed: "OVERNIGHT",
      isOpen: true,
      phase: "OVERNIGHT",
      scannedSymbols: 0,
      detailedSymbols: 0,
      providerRequests: 0
    }
  });
  return order;
}

function seedLearningObservation(
  repository: StockPaperRepository,
  lane: StockPaperLane,
  symbol: string,
  observedAt: string,
  context: Pick<StockPaperObservation, "phase" | "feed"> = {
    phase: "REGULAR",
    feed: "IEX"
  }
): StockPaperObservation {
  const account = repository.account(lane.id);
  if (!account) throw new Error("Expected seeded stock-paper account.");
  const candidate: StockPaperCandidate = {
    symbol,
    priceUsd: 100,
    bidUsd: 99.95,
    askUsd: 100.05,
    spreadPercent: 0.1,
    change1mPercent: 0.5,
    change5mPercent: 1.5,
    change15mPercent: 3,
    changeFromOpenPercent: 3,
    dailyChangePercent: 3,
    relativeVolume: 2,
    dollarVolumeUsd: 20_000_000,
    vwapDistancePercent: 1,
    score: 82,
    arm: "BREAKOUT",
    highConviction: true,
    eligible: true,
    reasons: [],
    marketPhase: context.phase,
    marketFeed: context.feed,
    capturedAt: observedAt
  };
  const bucket = new Date(Math.floor(Date.parse(observedAt) / (15 * 60_000)) * 15 * 60_000).toISOString();
  const rich = createStockPaperLearningObservationV3({
    laneId: lane.id,
    symbol,
    arm: candidate.arm,
    phase: context.phase,
    feed: context.feed,
    policyVersion: lane.policyVersion,
    policy: lane.policy,
    tradeDayKey: observedAt.slice(0, 10),
    observedAt,
    idempotencyBucket: bucket,
    candidateRank: 1,
    candidateScore: candidate.score,
    highConviction: true,
    confirmationSamples: 2,
    entryPriceUsd: 100,
    entryNotionalUsd: 25,
    spreadPercent: candidate.spreadPercent,
    relativeVolume: candidate.relativeVolume,
    dollarVolumeUsd: candidate.dollarVolumeUsd,
    change1mPercent: candidate.change1mPercent,
    change5mPercent: candidate.change5mPercent,
    change15mPercent: candidate.change15mPercent,
    vwapDistancePercent: candidate.vwapDistancePercent,
    sessionMinute: 0,
    hardSafetyPassed: true
  });
  const observation: StockPaperObservation = {
    id: rich.id,
    laneId: lane.id,
    symbol,
    observedAt,
    idempotencyBucket: bucket,
    policyVersion: lane.policyVersion,
    policy: lane.policy,
    featureVersion: STOCK_PAPER_FEATURE_VERSION,
    executionVersion: STOCK_PAPER_EXECUTION_VERSION,
    policyDigest: rich.policyDigest,
    phase: context.phase,
    feed: context.feed,
    candidate,
    tradeDayKey: observedAt.slice(0, 10),
    candidateRank: 1,
    confirmationSamples: 2,
    entryPriceUsd: 100,
    entryNotionalUsd: 25,
    sessionMinute: 0,
    newsArticleIds: [],
    hardSafetyPassed: true,
    safetyVetoes: [],
    decision: "OBSERVED",
    reasons: []
  };
  repository.commitCycle({
    account,
    positions: [],
    observations: [observation],
    equityPoint: {
      capturedAt: observedAt,
      navUsd: account.navUsd,
      cashUsd: account.cashUsd,
      deployedUsd: account.deployedUsd,
      drawdownPercent: 0
    },
    market: {
      feed: context.feed,
      isOpen: context.phase === "REGULAR",
      phase: context.phase,
      scannedSymbols: 0,
      detailedSymbols: 0,
      providerRequests: 0
    }
  });
  return observation;
}

function snapshotWithoutMinuteBar(price: number, timestamp: string): AlpacaStockSnapshot {
  const { minuteBar: _minuteBar, ...withoutMinuteBar } = snapshot(price, timestamp);
  return withoutMinuteBar;
}

function pendingBuySafetyProvider(input: {
  now: Date;
  symbols: readonly string[];
  nextOpen?: string;
}): AlpacaPaperProvider {
  const completedBar: AlpacaStockBar = {
    timestamp: "2026-07-17T01:21:00.000Z",
    open: 99,
    high: 111,
    low: 98,
    close: 110,
    volume: 6_000,
    tradeCount: 100,
    vwap: 109.5
  };
  const symbolSet = new Set(input.symbols);
  return {
    async getClock(): Promise<AlpacaMarketClock> {
      return {
        timestamp: input.now.toISOString(),
        isOpen: false,
        nextOpen: input.nextOpen ?? "2026-07-17T13:30:00.000Z",
        nextClose: "2026-07-17T20:00:00.000Z"
      };
    },
    async getAssets() {
      return input.symbols.map((symbol) => ({
        ...testAsset(),
        symbol,
        name: `${symbol} Test Asset`
      }));
    },
    async getCorporateActions() { return { actions: [] }; },
    async getSnapshots(symbols: readonly string[]) {
      return symbols.filter((symbol) => symbolSet.has(symbol)).map((symbol) => ({
        ...snapshot(110, input.now.toISOString()),
        symbol,
        minuteBar: completedBar
      }));
    },
    async getBars(request: { symbols: readonly string[] }): Promise<AlpacaBarsResult> {
      return {
        bars: new Map(request.symbols.map((symbol) => [
          symbol,
          symbolSet.has(symbol)
            ? [...entryBars("2026-07-17T01:20:00.000Z"), completedBar]
            : []
        ]))
      };
    }
  } as unknown as AlpacaPaperProvider;
}

describe("StockPaperEngine", () => {
  let db: CopyLabDatabase | undefined;

  afterEach(() => db?.close());

  it("requires explicit extended-hours fractional eligibility and a non-halted overnight asset", () => {
    const asset: AlpacaStockAsset = {
      symbol: "AAPL",
      status: "active",
      tradable: true,
      fractionable: true,
      marginable: true,
      shortable: true,
      easyToBorrow: true,
      fractionalEhEnabled: false,
      overnightTradable: true,
      overnightHalted: false
    };
    expect(stockAssetSupportsPhase(asset, "REGULAR")).toBe(true);
    expect(stockAssetSupportsPhase(asset, "AFTER_HOURS")).toBe(true);
    expect(stockAssetAllowsFractionalPhase(asset, "AFTER_HOURS")).toBe(false);
    expect(stockAssetAllowsFractionalPhase({ ...asset, fractionalEhEnabled: true }, "AFTER_HOURS")).toBe(true);
    expect(stockAssetSupportsPhase({ ...asset, fractionalEhEnabled: true }, "OVERNIGHT")).toBe(true);
    expect(stockAssetSupportsPhase({
      ...asset,
      fractionalEhEnabled: true,
      overnightHalted: true
    }, "OVERNIGHT")).toBe(false);
  });

  it("coalesces concurrent cycle triggers and recovers once from an asset-endpoint failure", async () => {
    db = openDatabase(":memory:");
    const repository = new StockPaperRepository(db);
    let now = new Date("2026-07-16T15:00:00.000Z");
    let clockCalls = 0;
    let assetCalls = 0;
    let firstAssetsStartedResolve!: () => void;
    let secondAssetsStartedResolve!: () => void;
    let rejectFirstAssets!: (reason?: unknown) => void;
    let resolveSecondAssets!: (assets: AlpacaStockAsset[]) => void;
    const firstAssetsStarted = new Promise<void>((resolve) => {
      firstAssetsStartedResolve = resolve;
    });
    const secondAssetsStarted = new Promise<void>((resolve) => {
      secondAssetsStartedResolve = resolve;
    });
    const provider = {
      async getClock(): Promise<AlpacaMarketClock> {
        clockCalls += 1;
        return {
          timestamp: now.toISOString(),
          isOpen: true,
          nextOpen: "2026-07-17T13:30:00.000Z",
          nextClose: "2026-07-16T20:00:00.000Z"
        };
      },
      async getAssets(): Promise<AlpacaStockAsset[]> {
        assetCalls += 1;
        if (assetCalls === 1) {
          firstAssetsStartedResolve();
          return new Promise<AlpacaStockAsset[]>((_resolve, reject) => {
            rejectFirstAssets = reject;
          });
        }
        secondAssetsStartedResolve();
        return new Promise<AlpacaStockAsset[]>((resolve) => {
          resolveSecondAssets = resolve;
        });
      },
      async getSnapshots(): Promise<AlpacaStockSnapshot[]> {
        return [];
      },
      async getBars(input: { symbols: readonly string[] }): Promise<AlpacaBarsResult> {
        return { bars: new Map(input.symbols.map((symbol) => [symbol, []])) };
      }
    } as unknown as AlpacaPaperProvider;
    const errors: unknown[] = [];
    const engine = new StockPaperEngine(repository, {
      mode: () => "PAPER",
      credentials: () => ({ apiKey: "paper-api-key", secretKey: "paper-secret-key" }),
      provider: () => provider,
      now: () => now,
      onError: (error) => {
        errors.push(error);
        if (errors.length === 1) now = new Date("2026-07-16T15:05:00.000Z");
      }
    });

    const first = engine.enqueueCycle();
    await firstAssetsStarted;
    const pending = engine.enqueueCycle();
    const coalesced = engine.enqueueCycle();
    expect(coalesced).toBe(pending);
    expect(clockCalls).toBe(1);
    expect(assetCalls).toBe(1);

    rejectFirstAssets(new Error("asset universe unavailable"));
    await expect(first).rejects.toThrow("Alpaca Assets inventory is unavailable");
    await secondAssetsStarted;

    const blocked = repository.dashboard();
    expect(blocked.market).toMatchObject({
      feedActionable: false,
      readiness: { status: "BLOCKED" }
    });
    expect(blocked.market.readiness?.reasons).toEqual([
      expect.stringContaining("REQUIRED_ENDPOINT_FAILED")
    ]);
    expect(blocked.positions).toEqual([]);
    expect(blocked.recentSignals).toEqual([]);
    expect(blocked.recentTrades).toEqual([]);
    expect(blocked.orders).toEqual([]);
    expect(blocked.equityCurve).toEqual([]);
    expect(errors).toHaveLength(1);

    resolveSecondAssets([]);
    await Promise.all([pending, coalesced]);
    await engine.drain();

    const recovered = repository.dashboard();
    expect(clockCalls).toBe(2);
    expect(assetCalls).toBe(2);
    expect(recovered.market.lastError).toBeUndefined();
    expect(recovered.positions).toEqual([]);
    expect(recovered.recentSignals).toEqual([]);
    expect(recovered.recentTrades).toEqual([]);
    expect(recovered.orders).toEqual([]);
    expect(recovered.equityCurve).toHaveLength(1);
    expect(errors).toHaveLength(1);
  });

  it("blocks no-cache asset retries for four minutes and retries exactly at five minutes", async () => {
    db = openDatabase(":memory:");
    const repository = new StockPaperRepository(db);
    const startedAt = Date.parse("2026-07-16T15:00:00.000Z");
    let now = new Date(startedAt);
    let assetCalls = 0;
    let snapshotCalls = 0;
    let assetsAvailable = false;
    const provider = {
      async getClock(): Promise<AlpacaMarketClock> {
        return {
          timestamp: now.toISOString(),
          isOpen: true,
          nextOpen: "2026-07-17T13:30:00.000Z",
          nextClose: "2026-07-16T20:00:00.000Z"
        };
      },
      async getAssets(): Promise<AlpacaStockAsset[]> {
        assetCalls += 1;
        if (!assetsAvailable) throw new Error("asset endpoint failed");
        return [];
      },
      async getSnapshots(): Promise<AlpacaStockSnapshot[]> {
        snapshotCalls += 1;
        return [];
      },
      async getBars(input: { symbols: readonly string[] }): Promise<AlpacaBarsResult> {
        return { bars: new Map(input.symbols.map((symbol) => [symbol, []])) };
      }
    } as unknown as AlpacaPaperProvider;
    const engine = new StockPaperEngine(repository, {
      mode: () => "PAPER",
      credentials: () => ({ apiKey: "paper-api-key", secretKey: "paper-secret-key" }),
      provider: () => provider,
      now: () => now
    });

    await expect(engine.enqueueCycle()).rejects.toThrow(
      "Alpaca Assets inventory is unavailable"
    );
    expect(assetCalls).toBe(1);
    for (let minute = 1; minute <= 4; minute += 1) {
      now = new Date(startedAt + minute * 60_000);
      await expect(engine.enqueueCycle()).rejects.toThrow(
        "Alpaca Assets inventory is unavailable"
      );
      expect(assetCalls).toBe(1);
      const blocked = repository.dashboard();
      expect(blocked.market.readiness?.status).toBe("BLOCKED");
      expect(blocked.positions).toEqual([]);
      expect(blocked.recentSignals).toEqual([]);
      expect(blocked.recentTrades).toEqual([]);
      expect(blocked.orders).toEqual([]);
      expect(blocked.equityCurve).toEqual([]);
    }
    expect(snapshotCalls).toBe(0);

    assetsAvailable = true;
    now = new Date(startedAt + 5 * 60_000);
    await expect(engine.enqueueCycle()).resolves.toBeUndefined();
    await engine.drain();
    const recovered = repository.dashboard();
    expect(assetCalls).toBe(2);
    expect(snapshotCalls).toBe(1);
    expect(recovered.market.lastError).toBeUndefined();
    expect(recovered.positions).toEqual([]);
    expect(recovered.recentSignals).toEqual([]);
    expect(recovered.recentTrades).toEqual([]);
    expect(recovered.orders).toEqual([]);
    expect(recovered.equityCurve).toHaveLength(1);
  });

  it("uses only the same overnight cache during cooldown and clears it after a successful retry", async () => {
    db = openDatabase(":memory:");
    const repository = new StockPaperRepository(db);
    const startedAt = Date.parse("2026-07-17T01:00:00.000Z");
    let now = new Date(startedAt);
    let assetCalls = 0;
    const provider = {
      async getClock(): Promise<AlpacaMarketClock> {
        return {
          timestamp: now.toISOString(),
          isOpen: false,
          nextOpen: "2026-07-17T13:30:00.000Z",
          nextClose: "2026-07-17T20:00:00.000Z"
        };
      },
      async getAssets(): Promise<AlpacaStockAsset[]> {
        assetCalls += 1;
        if (assetCalls === 2) throw new Error("overnight asset refresh failed");
        return [testAsset()];
      },
      async getSnapshots(): Promise<AlpacaStockSnapshot[]> {
        return [];
      },
      async getBars(input: { symbols: readonly string[] }): Promise<AlpacaBarsResult> {
        return { bars: new Map(input.symbols.map((symbol) => [symbol, []])) };
      }
    } as unknown as AlpacaPaperProvider;
    const engine = new StockPaperEngine(repository, {
      mode: () => "PAPER",
      credentials: () => ({ apiKey: "paper-api-key", secretKey: "paper-secret-key" }),
      provider: () => provider,
      now: () => now
    });

    await engine.enqueueCycle();
    expect(assetCalls).toBe(1);

    now = new Date(startedAt + 10 * 60_000);
    await expect(engine.enqueueCycle()).resolves.toBeUndefined();
    expect(assetCalls).toBe(2);
    expect(repository.dashboard().market.readiness?.reasons).toEqual(
      expect.arrayContaining([expect.stringContaining("OPTIONAL_ENDPOINT_FAILED")])
    );

    for (let minute = 11; minute <= 14; minute += 1) {
      now = new Date(startedAt + minute * 60_000);
      await expect(engine.enqueueCycle()).resolves.toBeUndefined();
      expect(assetCalls).toBe(2);
      expect(repository.dashboard().market.readiness?.reasons).toEqual(
        expect.arrayContaining([expect.stringContaining("OPTIONAL_ENDPOINT_FAILED")])
      );
    }

    now = new Date(startedAt + 15 * 60_000);
    await expect(engine.enqueueCycle()).resolves.toBeUndefined();
    expect(assetCalls).toBe(3);
    expect(repository.dashboard().market.readiness?.reasons ?? []).not.toEqual(
      expect.arrayContaining([expect.stringContaining("OPTIONAL_ENDPOINT_FAILED")])
    );

    now = new Date(startedAt + 25 * 60_000);
    await expect(engine.enqueueCycle()).resolves.toBeUndefined();
    await engine.drain();
    expect(assetCalls).toBe(4);
    const dashboard = repository.dashboard();
    expect(dashboard.positions).toEqual([]);
    expect(dashboard.recentSignals).toEqual([]);
    expect(dashboard.recentTrades).toEqual([]);
    expect(dashboard.orders).toEqual([]);
  });

  it("never borrows an IEX asset cache for an overnight key", async () => {
    db = openDatabase(":memory:");
    const repository = new StockPaperRepository(db);
    let now = new Date("2026-07-16T15:00:00.000Z");
    let assetCalls = 0;
    let snapshotCalls = 0;
    const provider = {
      async getClock(): Promise<AlpacaMarketClock> {
        return {
          timestamp: now.toISOString(),
          isOpen: now.getUTCHours() === 15,
          nextOpen: "2026-07-17T13:30:00.000Z",
          nextClose: "2026-07-17T20:00:00.000Z"
        };
      },
      async getAssets(): Promise<AlpacaStockAsset[]> {
        assetCalls += 1;
        if (assetCalls >= 2) throw new Error("overnight inventory unavailable");
        return [testAsset()];
      },
      async getSnapshots(): Promise<AlpacaStockSnapshot[]> {
        snapshotCalls += 1;
        return [];
      },
      async getBars(input: { symbols: readonly string[] }): Promise<AlpacaBarsResult> {
        return { bars: new Map(input.symbols.map((symbol) => [symbol, []])) };
      }
    } as unknown as AlpacaPaperProvider;
    const engine = new StockPaperEngine(repository, {
      mode: () => "PAPER",
      credentials: () => ({ apiKey: "paper-api-key", secretKey: "paper-secret-key" }),
      provider: () => provider,
      now: () => now
    });

    await engine.enqueueCycle();
    expect(assetCalls).toBe(1);
    expect(snapshotCalls).toBe(1);
    expect(repository.dashboard().equityCurve).toHaveLength(1);

    now = new Date("2026-07-17T01:00:00.000Z");
    await expect(engine.enqueueCycle()).rejects.toThrow(
      "Alpaca Assets inventory is unavailable"
    );
    expect(assetCalls).toBe(2);
    expect(snapshotCalls).toBe(1);

    now = new Date("2026-07-17T01:01:00.000Z");
    await expect(engine.enqueueCycle()).rejects.toThrow(
      "Alpaca Assets inventory is unavailable"
    );
    expect(assetCalls).toBe(2);
    expect(snapshotCalls).toBe(1);
    const blocked = repository.dashboard();
    expect(blocked.market.readiness?.status).toBe("BLOCKED");
    expect(blocked.equityCurve).toHaveLength(1);
    expect(blocked.positions).toEqual([]);
    expect(blocked.recentSignals).toEqual([]);
    expect(blocked.recentTrades).toEqual([]);
    expect(blocked.orders).toEqual([]);
  });

  it("fetches actual due observation symbols before labeling rotated-out evidence", async () => {
    db = openDatabase(":memory:");
    const repository = new StockPaperRepository(db);
    const observedAt = "2026-07-16T14:00:00.000Z";
    const now = new Date("2026-07-16T14:46:00.000Z");
    const lane = repository.ensureActiveLane(observedAt);
    seedLearningObservation(repository, lane, "ZZZ", observedAt);
    const snapshotRequests: string[][] = [];
    const barRequests: string[][] = [];
    const provider = {
      async getClock(): Promise<AlpacaMarketClock> {
        return {
          timestamp: now.toISOString(),
          isOpen: true,
          nextOpen: "2026-07-17T13:30:00.000Z",
          nextClose: "2026-07-16T20:00:00.000Z"
        };
      },
      async getAssets(): Promise<AlpacaStockAsset[]> {
        return [testAsset()];
      },
      async getSnapshots(symbols: readonly string[]): Promise<AlpacaStockSnapshot[]> {
        snapshotRequests.push([...symbols]);
        return symbols.includes("AAPL") ? [snapshot(104.8, now.toISOString())] : [];
      },
      async getBars(input: { symbols: readonly string[] }): Promise<AlpacaBarsResult> {
        barRequests.push([...input.symbols]);
        const rows = new Map<string, AlpacaStockBar[]>();
        for (const symbol of input.symbols) {
          rows.set(symbol, symbol === "ZZZ"
            ? Array.from({ length: 45 }, (_, index) => ({
                timestamp: new Date(Date.parse(observedAt) + (index + 1) * 60_000).toISOString(),
                open: 100 + index * 0.01,
                high: 100.2 + index * 0.01,
                low: 99.8 + index * 0.01,
                close: 100.1 + index * 0.01,
                volume: 1_000,
                tradeCount: 20,
                vwap: 100 + index * 0.01
              }))
            : symbol === "AAPL" ? entryBars("2026-07-16T14:45:00.000Z") : []);
        }
        return { bars: rows };
      }
    } as unknown as AlpacaPaperProvider;
    const engine = new StockPaperEngine(repository, {
      mode: () => "PAPER",
      credentials: () => ({ apiKey: "paper-api-key", secretKey: "paper-secret-key" }),
      provider: () => provider,
      now: () => now
    });

    await engine.enqueueCycle();
    await engine.drain();

    expect(snapshotRequests.every((symbols) => !symbols.includes("ZZZ"))).toBe(true);
    expect(barRequests.some((symbols) => symbols.includes("ZZZ"))).toBe(true);
    expect(repository.dashboard().learning).toMatchObject({
      labeledOutcomes: 2,
      missingOutcomes: 0
    });
  });

  it("backfills due outcomes from the observation's original feed after the market phase changes", async () => {
    db = openDatabase(":memory:");
    const repository = new StockPaperRepository(db);
    const observedAt = "2026-07-16T01:00:00.000Z";
    const now = new Date("2026-07-16T14:46:00.000Z");
    const lane = repository.ensureActiveLane(observedAt);
    seedLearningObservation(repository, lane, "ZZZ", observedAt, {
      phase: "OVERNIGHT",
      feed: "OVERNIGHT"
    });
    const barRequests: Array<{ symbols: string[]; feed?: string }> = [];
    const provider = {
      async getClock(): Promise<AlpacaMarketClock> {
        return {
          timestamp: now.toISOString(),
          isOpen: true,
          nextOpen: "2026-07-17T13:30:00.000Z",
          nextClose: "2026-07-16T20:00:00.000Z"
        };
      },
      async getAssets(): Promise<AlpacaStockAsset[]> {
        return [testAsset()];
      },
      async getSnapshots(): Promise<AlpacaStockSnapshot[]> {
        return [];
      },
      async getBars(input: {
        symbols: readonly string[];
        feed?: string;
      }): Promise<AlpacaBarsResult> {
        barRequests.push({
          symbols: [...input.symbols],
          ...(input.feed ? { feed: input.feed } : {})
        });
        const bars = new Map<string, AlpacaStockBar[]>();
        for (const symbol of input.symbols) {
          bars.set(symbol, input.feed === "boats" && (symbol === "ZZZ" || symbol === "SPY")
            ? Array.from({ length: 180 }, (_, index) => ({
                timestamp: new Date(Date.parse(observedAt) + (index + 1) * 60_000).toISOString(),
                open: 100 + index * 0.01,
                high: 100.2 + index * 0.01,
                low: 99.8 + index * 0.01,
                close: 100.1 + index * 0.01,
                volume: 1_000,
                tradeCount: 20,
                vwap: 100 + index * 0.01
              }))
            : []);
        }
        return { bars };
      }
    } as unknown as AlpacaPaperProvider;
    const engine = new StockPaperEngine(repository, {
      mode: () => "PAPER",
      credentials: () => ({ apiKey: "paper-api-key", secretKey: "paper-secret-key" }),
      provider: () => provider,
      now: () => now
    });

    await engine.enqueueCycle();
    await engine.drain();

    expect(barRequests.some((request) =>
      request.feed === "boats" && request.symbols.includes("ZZZ")
    )).toBe(true);
    expect(barRequests.some((request) =>
      request.feed === "iex" && request.symbols.includes("ZZZ")
    )).toBe(false);
    expect(repository.observationOutcomes(lane.id)).toHaveLength(3);
    expect(repository.observationOutcomes(lane.id).every((outcome) =>
      outcome.status === "LABELED"
    )).toBe(true);
  });

  it("keeps Friday regular-session entries independent from the distant Monday next-open diagnostic", async () => {
    db = openDatabase(":memory:");
    const repository = new StockPaperRepository(db);
    const now = new Date("2026-07-17T14:40:00.000Z"); // Friday 10:40 AM ET
    const bars = entryBars("2026-07-17T14:39:00.000Z");
    const provider = {
      async getClock(): Promise<AlpacaMarketClock> {
        return {
          timestamp: now.toISOString(),
          isOpen: true,
          nextOpen: "2026-07-20T13:30:00.000Z",
          nextClose: "2026-07-17T20:00:00.000Z"
        };
      },
      async getCalendar() {
        return [
          { date: "2026-07-17", open: "09:30", close: "16:00" },
          { date: "2026-07-20", open: "09:30", close: "16:00" }
        ];
      },
      async getAssets(): Promise<AlpacaStockAsset[]> {
        return [testAsset()];
      },
      async getCorporateActions() {
        return { actions: [] };
      },
      async getSnapshots(symbols: readonly string[]): Promise<AlpacaStockSnapshot[]> {
        return [
          ...(symbols.includes("AAPL") ? [snapshot(104.8, now.toISOString())] : []),
          ...(symbols.includes("SPY")
            ? [{ ...snapshot(500, now.toISOString()), symbol: "SPY" }]
            : [])
        ];
      },
      async getBars(input: { symbols: readonly string[] }): Promise<AlpacaBarsResult> {
        return {
          bars: new Map(input.symbols.map((symbol) => [
            symbol,
            symbol === "AAPL" || symbol === "SPY" ? bars : []
          ]))
        };
      }
    } as unknown as AlpacaPaperProvider;
    const engine = new StockPaperEngine(repository, {
      mode: () => "PAPER",
      credentials: () => ({ apiKey: "paper-api-key", secretKey: "paper-secret-key" }),
      provider: () => provider,
      now: () => now
    });

    await engine.enqueueCycle();
    const dashboard = repository.dashboard();
    expect(dashboard.positions).toHaveLength(1);
    expect(dashboard.recentSignals).toContainEqual(expect.objectContaining({
      action: "BUY",
      outcome: "SIMULATED"
    }));
    expect(dashboard.market).toMatchObject({
      phase: "REGULAR",
      calendarStatus: "VERIFIED",
      readiness: { status: "READY", reasons: [] }
    });
    expect(dashboard.market.readiness?.reasons.some((reason) =>
      /CALENDAR_DISCONTINUITY|OVERNIGHT_SESSION_PENDING/iu.test(reason)
    )).toBe(false);
  });

  it("records quote receipt after cycle start and keeps order-event clocks causal", async () => {
    db = openDatabase(":memory:");
    const repository = new StockPaperRepository(db);
    const cycleStartedAt = new Date("2026-07-17T14:40:00.000Z");
    const quoteAt = "2026-07-17T14:40:01.000Z";
    const evidenceReceivedAt = new Date("2026-07-17T14:40:02.000Z");
    const bars = entryBars("2026-07-17T14:39:00.000Z");
    let snapshotsReturned = false;
    const provider = {
      async getClock(): Promise<AlpacaMarketClock> {
        return {
          timestamp: cycleStartedAt.toISOString(),
          isOpen: true,
          nextOpen: "2026-07-20T13:30:00.000Z",
          nextClose: "2026-07-17T20:00:00.000Z"
        };
      },
      async getCalendar() {
        return [
          { date: "2026-07-17", open: "09:30", close: "16:00" },
          { date: "2026-07-20", open: "09:30", close: "16:00" }
        ];
      },
      async getAssets(): Promise<AlpacaStockAsset[]> {
        return [testAsset()];
      },
      async getCorporateActions() {
        return { actions: [] };
      },
      async getSnapshots(symbols: readonly string[]): Promise<AlpacaStockSnapshot[]> {
        const result = [
          ...(symbols.includes("AAPL") ? [snapshot(104.8, quoteAt)] : []),
          ...(symbols.includes("SPY")
            ? [{ ...snapshot(500, quoteAt), symbol: "SPY" }]
            : [])
        ];
        snapshotsReturned = true;
        return result;
      },
      async getBars(input: { symbols: readonly string[] }): Promise<AlpacaBarsResult> {
        return {
          bars: new Map(input.symbols.map((symbol) => [
            symbol,
            symbol === "AAPL" || symbol === "SPY" ? bars : []
          ]))
        };
      }
    } as unknown as AlpacaPaperProvider;
    const engine = new StockPaperEngine(repository, {
      mode: () => "PAPER",
      credentials: () => ({ apiKey: "paper-api-key", secretKey: "paper-secret-key" }),
      provider: () => provider,
      now: () => snapshotsReturned ? evidenceReceivedAt : cycleStartedAt
    });

    await engine.enqueueCycle();

    const dashboard = repository.dashboard();
    expect(dashboard.positions).toHaveLength(1);
    const filledOrder = dashboard.orders.find((order) =>
      order.side === "BUY" && order.status === "FILLED"
    );
    expect(filledOrder).toBeDefined();
    const fillEvent = repository.orderEvents(dashboard.lane!.id, filledOrder!.id)
      .find((event) => event.eventType === "FILL");
    expect(fillEvent).toMatchObject({
      quoteTimestamp: quoteAt,
      evidenceObservedAt: evidenceReceivedAt.toISOString(),
      benchmarkTimestamp: quoteAt,
      benchmarkObservedAt: evidenceReceivedAt.toISOString(),
      decisionAt: evidenceReceivedAt.toISOString(),
      createdAt: evidenceReceivedAt.toISOString()
    });
    expect(Date.parse(fillEvent!.quoteTimestamp!)).toBeGreaterThan(cycleStartedAt.getTime());
    expect(Date.parse(fillEvent!.evidenceObservedAt!))
      .toBeGreaterThanOrEqual(Date.parse(fillEvent!.quoteTimestamp!));
    expect(Date.parse(fillEvent!.decisionAt))
      .toBeGreaterThanOrEqual(Date.parse(fillEvent!.evidenceObservedAt!));
    expect(fillEvent!.fill?.evidenceAt).toBe(quoteAt);
    expect(db.prepare("SELECT COUNT(*) AS count FROM executions").get()).toEqual({ count: 0 });
  });

  it("opens and exits only the isolated simulated ledger, then creates a 1,000-policy replay", async () => {
    db = openDatabase(":memory:");
    const repository = new StockPaperRepository(db);
    let now = new Date("2026-07-16T14:40:00.000Z");
    let cycle = 1;
    const assets: AlpacaStockAsset[] = [{
      symbol: "AAPL",
      name: "Apple Inc.",
      exchange: "NASDAQ",
      status: "active",
      tradable: true,
      fractionable: true,
      marginable: true,
      shortable: true,
      easyToBorrow: true,
      fractionalEhEnabled: true,
      overnightTradable: true,
      overnightHalted: false
    }];
    const provider = {
      async getClock(): Promise<AlpacaMarketClock> {
        return {
          timestamp: now.toISOString(),
          isOpen: true,
          nextOpen: "2026-07-17T13:30:00.000Z",
          nextClose: "2026-07-16T20:00:00.000Z"
        };
      },
      async getAssets(): Promise<AlpacaStockAsset[]> {
        return assets;
      },
      async getSnapshots(symbols: readonly string[]): Promise<AlpacaStockSnapshot[]> {
        return [
          ...(symbols.includes("AAPL")
            ? [snapshot(cycle === 1 ? 104.8 : 90, now.toISOString())]
            : []),
          ...(symbols.includes("SPY")
            ? [{ ...snapshot(500, now.toISOString()), symbol: "SPY" }]
            : [])
        ];
      },
      async getBars(): Promise<AlpacaBarsResult> {
        const bars = cycle === 1
          ? entryBars()
          : cycle === 4
            ? Array.from({ length: 15 }, (_, index) => ({
                timestamp: new Date(Date.parse("2026-07-16T14:41:00.000Z") + index * 60_000).toISOString(),
                open: 91,
                high: 91.2,
                low: 89.8,
                close: 90,
                volume: 8_000,
                tradeCount: 100,
                vwap: 90.4
              }))
            : [{
              timestamp: cycle === 2
                ? "2026-07-16T14:41:00.000Z"
                : "2026-07-16T14:43:00.000Z",
              open: 91,
              high: 91.2,
              low: 89.8,
              close: 90,
              volume: 8_000,
              tradeCount: 100,
              vwap: 90.4
            }];
        return { bars: new Map([
          ["AAPL", bars],
          ["SPY", bars.map((bar) => ({
            ...bar,
            open: 500,
            high: 500.2,
            low: 499.8,
            close: 500,
            vwap: 500
          }))]
        ]) };
      }
    } as unknown as AlpacaPaperProvider;
    let providerRequests = 0;
    const backgroundErrors: unknown[] = [];
    const engine = new StockPaperEngine(repository, {
      mode: () => "PAPER",
      credentials: () => ({ apiKey: "paper-api-key", secretKey: "paper-secret-key" }),
      provider: () => provider,
      now: () => now,
      onProviderRequest: () => {
        providerRequests += 1;
      },
      onError: (error) => backgroundErrors.push(error)
    });

    await engine.enqueueCycle();
    let dashboard = repository.dashboard();
    expect(dashboard.positions).toHaveLength(1);
    expect(dashboard.positions[0]?.entryContext).toMatchObject({
      featureVersion: "stock-features-v3",
      policyVersion: "stock-paper-v3",
      executionVersion: "stock-execution-v3",
      phase: "REGULAR",
      feed: "IEX",
      learningStatus: "WARMING_UP",
      learningSampleSize: 0
    });
    expect(dashboard.candidates[0]?.sparklinePricesUsd).toHaveLength(40);
    expect(dashboard.account?.cashUsd).toBeLessThan(141);
    expect(dashboard.recentSignals.some((signal) =>
      signal.action === "BUY" && signal.outcome === "SIMULATED"
    )).toBe(true);
    expect(dashboard.learning.observations).toBe(1);
    expect(dashboard.market.providerRequests).toBe(4);

    cycle = 2;
    now = new Date("2026-07-16T14:42:00.000Z");
    await engine.enqueueCycle();
    dashboard = repository.dashboard();
    expect(dashboard.positions).toHaveLength(1);
    expect(dashboard.orders.some((order) =>
      order.side === "SELL" && order.status === "SUBMITTED"
    )).toBe(true);
    expect(dashboard.account?.completedTrades).toBe(0);

    cycle = 3;
    now = new Date("2026-07-16T14:44:00.000Z");
    await engine.enqueueCycle();
    cycle = 4;
    now = new Date("2026-07-16T14:56:00.000Z");
    await engine.enqueueCycle();
    await engine.drain();
    dashboard = repository.dashboard();
    expect(dashboard.positions).toHaveLength(0);
    expect(dashboard.learning.observations).toBe(2);
    expect(dashboard.account).toMatchObject({
      completedTrades: 1,
      winningTrades: 0
    });
    expect(dashboard.recentTrades[0]).toMatchObject({
      symbol: "AAPL",
      exitReason: "STOP_LOSS",
      entryContext: {
        featureVersion: "stock-features-v3",
        phase: "REGULAR",
        feed: "IEX"
      },
      pathEvidence: {
        schemaVersion: "stock-paper-trade-path-v1",
        provenance: "RECORDED_CAUSAL_MINUTE_BARS",
        causalWindow: "ENTRY_MINUTE_EXCLUSIVE_EXIT_MINUTE_EXCLUSIVE"
      },
      replay: {
        variantCount: 1000,
        scorableVariantCount: 1000
      }
    });
    expect(dashboard.market.providerRequests).toBe(4);
    expect(providerRequests).toBe(14);
    const tradeEvents = repository.orderEvents(dashboard.lane!.id).filter((event) =>
      event.positionId === dashboard.recentTrades[0]!.positionId && event.eventType === "FILL"
    );
    expect(tradeEvents).toHaveLength(2);
    expect(tradeEvents.every((event) =>
      event.benchmarkSymbol === "SPY" &&
      /^[a-f0-9]{64}$/u.test(event.benchmarkDigest ?? "") &&
      Boolean(event.benchmarkTimestamp) &&
      Boolean(event.benchmarkObservedAt)
    )).toBe(true);
    expect(backgroundErrors).toEqual([]);
    expect(dashboard.learning.advancedAnalysis).toMatchObject({
      status: "INSUFFICIENT_EVIDENCE",
      analysisOnly: true,
      affectsTrading: false,
      promotionEligible: false,
      sourceTradeCount: 1,
      analyzedTradeCount: 1,
      excludedTradeCount: 0
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM executions").get()).toEqual({ count: 0 });
  });

  it("uses the free overnight feed for an isolated high-conviction paper entry", async () => {
    db = openDatabase(":memory:");
    const repository = new StockPaperRepository(db);
    let now = new Date("2026-07-17T01:20:00.000Z");
    const requestedSnapshotFeeds: Array<string | undefined> = [];
    const requestedBarFeeds: Array<string | undefined> = [];
    const provider = {
      async getClock(): Promise<AlpacaMarketClock> {
        return {
          timestamp: now.toISOString(),
          isOpen: false,
          nextOpen: "2026-07-17T13:30:00.000Z",
          nextClose: "2026-07-17T20:00:00.000Z"
        };
      },
      async getAssets(): Promise<AlpacaStockAsset[]> {
        return [{
          symbol: "AAPL",
          name: "Apple Inc.",
          exchange: "NASDAQ",
          status: "active",
          tradable: true,
          fractionable: true,
          marginable: true,
          shortable: true,
          easyToBorrow: true,
          fractionalEhEnabled: true,
          overnightTradable: true,
          overnightHalted: false
        }];
      },
      async getCorporateActions() {
        return { actions: [] };
      },
      async getSnapshots(
        symbols: readonly string[],
        feed?: string
      ): Promise<AlpacaStockSnapshot[]> {
        requestedSnapshotFeeds.push(feed);
        return symbols.includes("AAPL") ? [snapshot(104.8, now.toISOString())] : [];
      },
      async getBars(input: { symbols: readonly string[]; feed?: string }): Promise<AlpacaBarsResult> {
        requestedBarFeeds.push(input.feed);
        return {
          bars: new Map(input.symbols.map((symbol) => [
            symbol,
            symbol === "AAPL"
              ? entryBars(new Date(now.getTime() - 60_000).toISOString())
              : []
          ]))
        };
      }
    } as unknown as AlpacaPaperProvider;
    let engine = new StockPaperEngine(repository, {
      mode: () => "PAPER",
      credentials: () => ({ apiKey: "paper-api-key", secretKey: "paper-secret-key" }),
      provider: () => provider,
      now: () => now
    });

    await engine.enqueueCycle();
    let dashboard = repository.dashboard();

    expect(dashboard.positions).toHaveLength(0);
    expect(dashboard.recentSignals.some((signal) =>
      signal.action === "BUY" &&
      signal.outcome === "ANALYSIS_ONLY" &&
      signal.reasons.some((reason) => reason.includes("strictly later complete minute bar"))
    )).toBe(true);
    expect(dashboard.orders[0]).toMatchObject({
      side: "BUY",
      status: "SUBMITTED",
      executionVersion: "stock-execution-v3"
    });
    expect(
      Date.parse(dashboard.orders[0]!.expiresAt) - Date.parse(dashboard.orders[0]!.submittedAt)
    ).toBe(dashboard.lane!.policy.overnightDerivedLimitConfirmationMinutes * 60_000);

    // Recreate the engine before the causal bar arrives. The submitted intent
    // must be rehydrated from SQLite rather than living only in memory.
    engine.stop();
    engine = new StockPaperEngine(repository, {
      mode: () => "PAPER",
      credentials: () => ({ apiKey: "paper-api-key", secretKey: "paper-secret-key" }),
      provider: () => provider,
      now: () => now
    });

    now = new Date("2026-07-17T01:21:00.000Z");
    await engine.enqueueCycle();
    dashboard = repository.dashboard();

    // The 01:20 bar contains price action from the submission minute and is
    // deliberately ineligible. The first causal evidence bar starts 01:21.
    expect(dashboard.positions).toHaveLength(0);
    expect(dashboard.orders[0]?.status).toBe("SUBMITTED");

    now = new Date("2026-07-17T01:22:00.000Z");
    await engine.enqueueCycle();
    dashboard = repository.dashboard();

    expect(requestedSnapshotFeeds).toContain("overnight");
    expect(requestedBarFeeds).toContain("boats");
    expect(dashboard.market).toMatchObject({
      feed: "OVERNIGHT",
      phase: "OVERNIGHT",
      isOpen: true,
      barFreshnessLimitMs: 20 * 60_000,
      pricingEvidenceMode: "DELAYED_DERIVED"
    });
    expect(dashboard.positions).toHaveLength(1);
    expect(dashboard.positions[0]?.entryNotionalUsd).toBeLessThanOrEqual(35);
    expect(dashboard.recentSignals.some((signal) =>
      signal.action === "BUY" &&
      signal.outcome === "SIMULATED" &&
      signal.reasons.some((reason) => reason.includes("causal next-bar PAPER fill"))
    )).toBe(true);
    expect(dashboard.orders[0]?.status).toBe("FILLED");
    const filledOrder = dashboard.orders.find((order) => order.side === "BUY")!;
    const fillEvent = repository.orderEvents(dashboard.lane!.id, filledOrder.id)
      .find((event) => event.eventType === "FILL");
    expect(fillEvent).toMatchObject({
      priorStatus: "SUBMITTED",
      newStatus: "FILLED",
      evidenceBarTimestamp: "2026-07-17T01:21:00.000Z",
      evidenceObservedAt: "2026-07-17T01:22:00.000Z",
      quoteTimestamp: "2026-07-17T01:22:00.000Z",
      phase: "OVERNIGHT",
      feed: "OVERNIGHT",
      assumptions: {
        executionVersion: STOCK_PAPER_EXECUTION_VERSION,
        participationRatePercent: dashboard.lane!.policy.maximumBarParticipationPercent,
        marketable: false,
        extendedFillPenaltyPercent: dashboard.lane!.policy.extendedFillPenaltyPercent
      }
    });
    expect(fillEvent?.quoteDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(fillEvent?.barDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(db.prepare("SELECT COUNT(*) AS count FROM executions").get()).toEqual({ count: 0 });
  });

  it("keeps an accepted overnight BUY alive until the delayed BOATS bar arrives", async () => {
    db = openDatabase(":memory:");
    const repository = new StockPaperRepository(db);
    const submittedAt = "2026-07-17T01:20:00.000Z";
    const lane = repository.ensureActiveLane(submittedAt);
    const seededOrder = seedPendingBuy(
      repository,
      lane,
      submittedAt,
      0.5,
      true,
      "2026-07-17T01:45:00.000Z"
    );
    const frozenEntryContext = structuredClone(seededOrder.entryContext!);
    let now = new Date("2026-07-17T01:21:00.000Z");
    const historicalRequests: Array<{ observedAt: string; end: string; feed?: string }> = [];
    const causalBar: AlpacaStockBar = {
      timestamp: "2026-07-17T01:21:00.000Z",
      open: 99,
      high: 101,
      low: 98,
      close: 100,
      volume: 10_000,
      tradeCount: 100,
      vwap: 100
    };
    const priorBars = Array.from({ length: 40 }, (_, index): AlpacaStockBar => ({
      timestamp: new Date(Date.parse("2026-07-17T00:25:00.000Z") + index * 60_000).toISOString(),
      open: 100,
      high: 100.1,
      low: 99.9,
      close: 100,
      volume: 1_000,
      tradeCount: 20,
      vwap: 100
    }));
    const provider = {
      async getClock(): Promise<AlpacaMarketClock> {
        return {
          timestamp: now.toISOString(),
          isOpen: false,
          nextOpen: "2026-07-17T13:30:00.000Z",
          nextClose: "2026-07-17T20:00:00.000Z"
        };
      },
      async getAssets(): Promise<AlpacaStockAsset[]> {
        return [testAsset()];
      },
      async getCorporateActions() {
        return { actions: [] };
      },
      async getSnapshots(symbols: readonly string[]): Promise<AlpacaStockSnapshot[]> {
        if (!symbols.includes("AAPL")) return [];
        const current = snapshot(100, now.toISOString());
        return [{
          ...current,
          minuteBar: {
            ...current.minuteBar!,
            timestamp: new Date(now.getTime() - 16 * 60_000).toISOString(),
            open: 100,
            high: 100.2,
            low: 99.8,
            close: 100,
            vwap: 100
          }
        }];
      },
      async getBars(input: {
        symbols: readonly string[];
        end: string;
        feed?: string;
      }): Promise<AlpacaBarsResult> {
        historicalRequests.push({
          observedAt: now.toISOString(),
          end: input.end,
          ...(input.feed ? { feed: input.feed } : {})
        });
        const available = [...priorBars, causalBar]
          .filter((bar) => Date.parse(bar.timestamp) < Date.parse(input.end));
        return {
          bars: new Map(input.symbols.map((symbol) => [
            symbol,
            symbol === "AAPL" ? available : []
          ]))
        };
      }
    } as unknown as AlpacaPaperProvider;
    const engine = new StockPaperEngine(repository, {
      mode: () => "PAPER",
      credentials: () => ({ apiKey: "paper-api-key", secretKey: "paper-secret-key" }),
      provider: () => provider,
      now: () => now
    });

    for (const checkpoint of [
      "2026-07-17T01:21:00.000Z",
      "2026-07-17T01:25:00.000Z",
      "2026-07-17T01:30:00.000Z",
      "2026-07-17T01:36:00.000Z"
    ]) {
      now = new Date(checkpoint);
      await engine.enqueueCycle();
      const pending = repository.orders(lane.id).find((order) => order.id === seededOrder.id);
      expect(pending).toMatchObject({ status: "SUBMITTED", filledQuantity: 0, fills: [] });
      expect(repository.positions(lane.id, true)).toEqual([]);
      const decayedCandidate = repository.candidates(lane.id, 100)
        .find((candidate) => candidate.symbol === "AAPL");
      expect(decayedCandidate).toBeDefined();
      expect(decayedCandidate?.score).toBeLessThan(lane.policy.minimumSignalScore);
      expect(decayedCandidate?.highConviction).toBe(false);
      expect(repository.orderEvents(lane.id, seededOrder.id).some((event) =>
        event.newStatus === "CANCELED"
      )).toBe(false);
    }

    now = new Date("2026-07-17T01:38:00.000Z");
    await engine.enqueueCycle();

    const filled = repository.orders(lane.id).find((order) => order.id === seededOrder.id)!;
    expect(filled).toMatchObject({
      status: "FILLED",
      filledQuantity: 0.5,
      lastEvaluatedBarAt: causalBar.timestamp,
      entryContext: frozenEntryContext
    });
    expect(repository.positions(lane.id, true)).toEqual([
      expect.objectContaining({
        id: seededOrder.positionId,
        quantity: 0.5,
        entryContext: frozenEntryContext
      })
    ]);
    const events = repository.orderEvents(lane.id, seededOrder.id);
    expect(events.filter((event) => event.eventType === "FILL")).toHaveLength(1);
    expect(events.some((event) => event.newStatus === "CANCELED")).toBe(false);
    expect(events.find((event) => event.eventType === "FILL")).toMatchObject({
      evidenceBarTimestamp: causalBar.timestamp,
      newStatus: "FILLED"
    });
    expect(historicalRequests.length).toBeGreaterThanOrEqual(5);
    for (const request of historicalRequests) {
      expect(request.feed).toBe("boats");
      expect(Date.parse(request.end)).toBe(Date.parse(request.observedAt) - 16 * 60_000);
    }
    expect(db.prepare("SELECT COUNT(*) AS count FROM executions").get()).toEqual({ count: 0 });
  });

  it("fills a pending overnight BUY after its symbol leaves the current candidate set", async () => {
    db = openDatabase(":memory:");
    const repository = new StockPaperRepository(db);
    const submittedAt = "2026-07-17T01:20:00.000Z";
    const lane = repository.ensureActiveLane(submittedAt);
    const seededOrder = seedPendingBuy(
      repository,
      lane,
      submittedAt,
      0.5,
      true,
      "2026-07-17T01:45:00.000Z"
    );
    const now = new Date("2026-07-17T01:38:00.000Z");
    const fillableBar: AlpacaStockBar = {
      timestamp: "2026-07-17T01:21:00.000Z",
      open: 99,
      high: 101,
      low: 98,
      close: 100,
      volume: 10_000,
      tradeCount: 100,
      vwap: 100
    };
    const provider = {
      async getClock(): Promise<AlpacaMarketClock> {
        return {
          timestamp: now.toISOString(),
          isOpen: false,
          nextOpen: "2026-07-17T13:30:00.000Z",
          nextClose: "2026-07-17T20:00:00.000Z"
        };
      },
      async getAssets(): Promise<AlpacaStockAsset[]> { return [testAsset()]; },
      async getCorporateActions() { return { actions: [] }; },
      async getSnapshots(symbols: readonly string[]): Promise<AlpacaStockSnapshot[]> {
        if (!symbols.includes("AAPL")) return [];
        const current = snapshot(100, now.toISOString());
        return [{
          ...current,
          minuteBar: {
            ...current.minuteBar!,
            timestamp: "2026-07-17T01:22:00.000Z"
          },
          previousDailyBar: {
            ...current.previousDailyBar!,
            volume: 1
          }
        }];
      },
      async getBars(input: { symbols: readonly string[] }): Promise<AlpacaBarsResult> {
        return {
          bars: new Map(input.symbols.map((symbol) => [
            symbol,
            symbol === "AAPL" ? [fillableBar] : []
          ]))
        };
      }
    } as unknown as AlpacaPaperProvider;
    const engine = new StockPaperEngine(repository, {
      mode: () => "PAPER",
      credentials: () => ({ apiKey: "paper-api-key", secretKey: "paper-secret-key" }),
      provider: () => provider,
      now: () => now
    });

    await engine.enqueueCycle();

    expect(repository.candidates(lane.id, 100).some((candidate) => candidate.symbol === "AAPL"))
      .toBe(false);
    expect(repository.orders(lane.id).find((order) => order.id === seededOrder.id)).toMatchObject({
      status: "FILLED",
      filledQuantity: 0.5,
      lastEvaluatedBarAt: fillableBar.timestamp
    });
    expect(repository.positions(lane.id, true)).toEqual([
      expect.objectContaining({ id: seededOrder.positionId, quantity: 0.5 })
    ]);
    expect(repository.orderEvents(lane.id, seededOrder.id).some((event) =>
      event.newStatus === "CANCELED"
    )).toBe(false);
  });

  it("holds a pending overnight BUY on a stale quote and fills after quote recovery", async () => {
    db = openDatabase(":memory:");
    const repository = new StockPaperRepository(db);
    const submittedAt = "2026-07-17T01:20:00.000Z";
    const lane = repository.ensureActiveLane(submittedAt);
    const seededOrder = seedPendingBuy(
      repository,
      lane,
      submittedAt,
      0.5,
      true,
      "2026-07-17T01:45:00.000Z"
    );
    let now = new Date("2026-07-17T01:38:00.000Z");
    let quoteFresh = false;
    const fillableBar: AlpacaStockBar = {
      timestamp: "2026-07-17T01:21:00.000Z",
      open: 99,
      high: 101,
      low: 98,
      close: 100,
      volume: 10_000,
      tradeCount: 100,
      vwap: 100
    };
    const provider = {
      async getClock(): Promise<AlpacaMarketClock> {
        return {
          timestamp: now.toISOString(),
          isOpen: false,
          nextOpen: "2026-07-17T13:30:00.000Z",
          nextClose: "2026-07-17T20:00:00.000Z"
        };
      },
      async getAssets(): Promise<AlpacaStockAsset[]> { return [testAsset()]; },
      async getCorporateActions() { return { actions: [] }; },
      async getSnapshots(symbols: readonly string[]): Promise<AlpacaStockSnapshot[]> {
        if (!symbols.includes("AAPL")) return [];
        const quoteAt = quoteFresh
          ? now.toISOString()
          : new Date(now.getTime() - 5 * 60_000).toISOString();
        const current = snapshot(100, quoteAt);
        return [{
          ...current,
          minuteBar: {
            ...current.minuteBar!,
            timestamp: "2026-07-17T01:22:00.000Z"
          }
        }];
      },
      async getBars(input: { symbols: readonly string[] }): Promise<AlpacaBarsResult> {
        return {
          bars: new Map(input.symbols.map((symbol) => [
            symbol,
            symbol === "AAPL" ? [fillableBar] : []
          ]))
        };
      }
    } as unknown as AlpacaPaperProvider;
    const engine = new StockPaperEngine(repository, {
      mode: () => "PAPER",
      credentials: () => ({ apiKey: "paper-api-key", secretKey: "paper-secret-key" }),
      provider: () => provider,
      now: () => now
    });

    await engine.enqueueCycle();
    expect(repository.orders(lane.id).find((order) => order.id === seededOrder.id)).toMatchObject({
      status: "SUBMITTED",
      filledQuantity: 0
    });
    expect(repository.positions(lane.id, true)).toEqual([]);
    expect(repository.orderEvents(lane.id, seededOrder.id)).toEqual([]);

    quoteFresh = true;
    now = new Date("2026-07-17T01:39:00.000Z");
    await engine.enqueueCycle();

    expect(repository.orders(lane.id).find((order) => order.id === seededOrder.id)).toMatchObject({
      status: "FILLED",
      filledQuantity: 0.5,
      lastEvaluatedBarAt: fillableBar.timestamp
    });
    expect(repository.orderEvents(lane.id, seededOrder.id).filter((event) =>
      event.eventType === "FILL"
    )).toHaveLength(1);
    expect(repository.orderEvents(lane.id, seededOrder.id).some((event) =>
      event.newStatus === "CANCELED"
    )).toBe(false);
  });

  it("expires an accepted overnight BUY instead of canceling it for soft signal drift", async () => {
    db = openDatabase(":memory:");
    const repository = new StockPaperRepository(db);
    const submittedAt = "2026-07-17T01:20:00.000Z";
    const lane = repository.ensureActiveLane(submittedAt);
    const seededOrder = seedPendingBuy(
      repository,
      lane,
      submittedAt,
      0.5,
      true,
      "2026-07-17T01:45:00.000Z"
    );
    const now = new Date("2026-07-17T01:46:00.000Z");
    const provider = {
      async getClock(): Promise<AlpacaMarketClock> {
        return {
          timestamp: now.toISOString(),
          isOpen: false,
          nextOpen: "2026-07-17T13:30:00.000Z",
          nextClose: "2026-07-17T20:00:00.000Z"
        };
      },
      async getAssets(): Promise<AlpacaStockAsset[]> { return [testAsset()]; },
      async getCorporateActions() { return { actions: [] }; },
      async getSnapshots(symbols: readonly string[]): Promise<AlpacaStockSnapshot[]> {
        if (!symbols.includes("AAPL")) return [];
        const current = snapshot(100, now.toISOString());
        return [{
          ...current,
          minuteBar: {
            ...current.minuteBar!,
            timestamp: "2026-07-17T01:30:00.000Z",
            open: 102,
            high: 103,
            low: 101,
            close: 102,
            vwap: 102
          },
          previousDailyBar: {
            ...current.previousDailyBar!,
            volume: 1
          }
        }];
      },
      async getBars(input: { symbols: readonly string[] }): Promise<AlpacaBarsResult> {
        const preSubmissionBar: AlpacaStockBar = {
          timestamp: "2026-07-17T01:20:00.000Z",
          open: 99,
          high: 101,
          low: 98,
          close: 100,
          volume: 10_000,
          tradeCount: 100,
          vwap: 100
        };
        return {
          bars: new Map(input.symbols.map((symbol) => [
            symbol,
            symbol === "AAPL" ? [preSubmissionBar] : []
          ]))
        };
      }
    } as unknown as AlpacaPaperProvider;
    const engine = new StockPaperEngine(repository, {
      mode: () => "PAPER",
      credentials: () => ({ apiKey: "paper-api-key", secretKey: "paper-secret-key" }),
      provider: () => provider,
      now: () => now
    });

    await engine.enqueueCycle();

    expect(repository.candidates(lane.id, 100).some((candidate) => candidate.symbol === "AAPL"))
      .toBe(false);
    expect(repository.orders(lane.id).find((order) => order.id === seededOrder.id)).toMatchObject({
      status: "EXPIRED",
      filledQuantity: 0,
      reason: "The order expired without a fill."
    });
    expect(repository.positions(lane.id, true)).toEqual([]);
    expect(repository.orderEvents(lane.id, seededOrder.id)).toContainEqual(expect.objectContaining({
      eventType: "STATUS_TRANSITION",
      priorStatus: "SUBMITTED",
      newStatus: "EXPIRED"
    }));
  });

  it("does not use an incomplete current-minute bar as entry evidence", async () => {
    db = openDatabase(":memory:");
    const repository = new StockPaperRepository(db);
    const lane = repository.ensureActiveLane("2026-07-17T01:20:30.000Z");
    const seededOrder = seedPendingBuy(repository, lane, "2026-07-17T01:20:30.000Z");
    let now = new Date("2026-07-17T01:21:30.000Z");
    const currentMinuteBar: AlpacaStockBar = {
      timestamp: "2026-07-17T01:21:00.000Z",
      open: 109,
      high: 111,
      low: 98,
      close: 110,
      volume: 3_000,
      tradeCount: 50,
      vwap: 109.5
    };
    const provider = {
      async getClock(): Promise<AlpacaMarketClock> {
        return {
          timestamp: now.toISOString(),
          isOpen: false,
          nextOpen: "2026-07-17T13:30:00.000Z",
          nextClose: "2026-07-17T20:00:00.000Z"
        };
      },
      async getAssets(): Promise<AlpacaStockAsset[]> {
        return [testAsset()];
      },
      async getCorporateActions() {
        return { actions: [] };
      },
      async getSnapshots(symbols: readonly string[]): Promise<AlpacaStockSnapshot[]> {
        if (!symbols.includes("AAPL")) return [];
        return [{ ...snapshot(110, now.toISOString()), minuteBar: currentMinuteBar }];
      },
      async getBars(input: { symbols: readonly string[] }): Promise<AlpacaBarsResult> {
        return {
          bars: new Map(input.symbols.map((symbol) => [
            symbol,
            symbol === "AAPL"
              ? [...entryBars("2026-07-17T01:20:00.000Z"), currentMinuteBar]
              : []
          ]))
        };
      }
    } as unknown as AlpacaPaperProvider;
    const engine = new StockPaperEngine(repository, {
      mode: () => "PAPER",
      credentials: () => ({ apiKey: "paper-api-key", secretKey: "paper-secret-key" }),
      provider: () => provider,
      now: () => now
    });

    await engine.enqueueCycle();
    let dashboard = repository.dashboard();
    expect(dashboard.positions).toHaveLength(0);
    expect(dashboard.orders.find((order) => order.id === seededOrder.id)).toMatchObject({
      status: "SUBMITTED",
      filledQuantity: 0
    });

    now = new Date("2026-07-17T01:22:00.000Z");
    await engine.enqueueCycle();
    dashboard = repository.dashboard();
    expect(dashboard.positions).toHaveLength(1);
    expect(dashboard.orders.find((order) => order.id === seededOrder.id)).toMatchObject({
      status: "FILLED",
      filledQuantity: 0.5,
      lastEvaluatedBarAt: currentMinuteBar.timestamp
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM executions").get()).toEqual({ count: 0 });
  });

  it("rejects missing entry provenance before recording any otherwise-fillable evidence", async () => {
    db = openDatabase(":memory:");
    const repository = new StockPaperRepository(db);
    const lane = repository.ensureActiveLane("2026-07-17T01:20:30.000Z");
    const seededOrder = seedPendingBuy(
      repository,
      lane,
      "2026-07-17T01:20:30.000Z",
      1,
      false
    );
    const now = new Date("2026-07-17T01:22:00.000Z");
    const provider = {
      async getClock(): Promise<AlpacaMarketClock> {
        return {
          timestamp: now.toISOString(),
          isOpen: false,
          nextOpen: "2026-07-17T13:30:00.000Z",
          nextClose: "2026-07-17T20:00:00.000Z"
        };
      },
      async getAssets(): Promise<AlpacaStockAsset[]> {
        return [testAsset()];
      },
      async getCorporateActions() {
        return { actions: [] };
      },
      async getSnapshots(symbols: readonly string[]): Promise<AlpacaStockSnapshot[]> {
        return symbols.includes("AAPL")
          ? [snapshotWithoutMinuteBar(99, now.toISOString())]
          : [];
      },
      async getBars(input: { symbols: readonly string[] }): Promise<AlpacaBarsResult> {
        const fillableBar: AlpacaStockBar = {
          timestamp: "2026-07-17T01:21:00.000Z",
          open: 99,
          high: 100,
          low: 98,
          close: 99,
          volume: 1_000,
          tradeCount: 20,
          vwap: 99
        };
        return {
          bars: new Map(input.symbols.map((symbol) => [
            symbol,
            symbol === "AAPL" ? [fillableBar] : []
          ]))
        };
      }
    } as unknown as AlpacaPaperProvider;
    const engine = new StockPaperEngine(repository, {
      mode: () => "PAPER",
      credentials: () => ({ apiKey: "paper-api-key", secretKey: "paper-secret-key" }),
      provider: () => provider,
      now: () => now
    });

    await engine.enqueueCycle();
    const dashboard = repository.dashboard();
    expect(dashboard.positions).toHaveLength(0);
    expect(dashboard.account?.cashUsd).toBe(141);
    expect(dashboard.orders.find((order) => order.id === seededOrder.id)).toMatchObject({
      status: "REJECTED",
      filledQuantity: 0,
      fills: []
    });
  });

  it("cancels a partial BUY before an earlier stop and liquidates thin volume without reopening", async () => {
    db = openDatabase(":memory:");
    const repository = new StockPaperRepository(db);
    const lane = repository.ensureActiveLane("2026-07-17T01:20:30.000Z");
    const seededOrder = seedPendingBuy(repository, lane, "2026-07-17T01:20:30.000Z");
    let now = new Date("2026-07-17T01:24:00.000Z");
    let stage = 0;
    const buyFillBar: AlpacaStockBar = {
      timestamp: "2026-07-17T01:21:00.000Z",
      open: 99,
      high: 100,
      low: 98,
      close: 99,
      volume: 10,
      tradeCount: 10,
      vwap: 99
    };
    const stopBar: AlpacaStockBar = {
      timestamp: "2026-07-17T01:22:00.000Z",
      open: 90,
      high: 91,
      low: 89,
      close: 90,
      volume: 10,
      tradeCount: 10,
      vwap: 90
    };
    const forbiddenLaterBuyBar: AlpacaStockBar = {
      timestamp: "2026-07-17T01:23:00.000Z",
      open: 109,
      high: 111,
      low: 98,
      close: 110,
      volume: 3_000,
      tradeCount: 100,
      vwap: 109.5
    };
    const firstThinSellBar: AlpacaStockBar = {
      timestamp: "2026-07-17T01:25:00.000Z",
      open: 88,
      high: 89,
      low: 87,
      close: 88,
      volume: 5,
      tradeCount: 5,
      vwap: 88
    };
    const secondThinSellBar: AlpacaStockBar = {
      timestamp: "2026-07-17T01:26:00.000Z",
      open: 87,
      high: 88,
      low: 86,
      close: 87,
      volume: 5,
      tradeCount: 5,
      vwap: 87
    };
    const provider = {
      async getClock(): Promise<AlpacaMarketClock> {
        return {
          timestamp: now.toISOString(),
          isOpen: false,
          nextOpen: "2026-07-17T13:30:00.000Z",
          nextClose: "2026-07-17T20:00:00.000Z"
        };
      },
      async getAssets(): Promise<AlpacaStockAsset[]> {
        return [testAsset()];
      },
      async getCorporateActions() {
        return { actions: [] };
      },
      async getSnapshots(symbols: readonly string[]): Promise<AlpacaStockSnapshot[]> {
        if (!symbols.includes("AAPL")) return [];
        const current = snapshot(stage === 0 ? 110 : 87, now.toISOString());
        if (stage === 0 && current.minuteBar) {
          return [{ ...current, minuteBar: { ...current.minuteBar, volume: 6_000 } }];
        }
        return [{
          ...current,
          minuteBar: stage === 1 ? firstThinSellBar : secondThinSellBar
        }];
      },
      async getBars(input: { symbols: readonly string[] }): Promise<AlpacaBarsResult> {
        const evidence = stage === 0
          ? [
              ...entryBars("2026-07-17T01:20:00.000Z"),
              buyFillBar,
              stopBar,
              forbiddenLaterBuyBar
            ]
          : stage === 1
            ? [firstThinSellBar]
            : [firstThinSellBar, secondThinSellBar];
        return {
          bars: new Map(input.symbols.map((symbol) => [
            symbol,
            symbol === "AAPL" ? evidence : []
          ]))
        };
      }
    } as unknown as AlpacaPaperProvider;
    const engine = new StockPaperEngine(repository, {
      mode: () => "PAPER",
      credentials: () => ({ apiKey: "paper-api-key", secretKey: "paper-secret-key" }),
      provider: () => provider,
      now: () => now
    });

    await engine.enqueueCycle();
    let dashboard = repository.dashboard();
    const canceledBuy = dashboard.orders.find((order) => order.id === seededOrder.id);
    const submittedSell = dashboard.orders.find((order) => order.side === "SELL");
    expect(canceledBuy).toMatchObject({ status: "CANCELED", filledQuantity: 0.1 });
    expect(canceledBuy?.reason).toContain("STOP_LOSS");
    expect(dashboard.positions).toHaveLength(1);
    expect(dashboard.positions[0]?.quantity).toBeCloseTo(0.1, 10);
    expect(submittedSell).toMatchObject({
      status: "SUBMITTED",
      requestedQuantity: 0.1,
      filledQuantity: 0,
      exitReason: "STOP_LOSS",
      exitCostBasisUsd: 9.9
    });
    expect(dashboard.recentTrades).toHaveLength(0);

    stage = 1;
    now = new Date("2026-07-17T01:26:00.000Z");
    await engine.enqueueCycle();
    dashboard = repository.dashboard();
    expect(dashboard.positions).toHaveLength(1);
    expect(dashboard.positions[0]?.quantity).toBeCloseTo(0.05, 10);
    expect(dashboard.orders.find((order) => order.side === "SELL")).toMatchObject({
      status: "PARTIAL",
      filledQuantity: 0.05
    });
    expect(dashboard.recentTrades).toHaveLength(0);

    stage = 2;
    now = new Date("2026-07-17T01:27:00.000Z");
    await engine.enqueueCycle();
    dashboard = repository.dashboard();
    expect(dashboard.positions).toHaveLength(0);
    expect(dashboard.orders.find((order) => order.side === "SELL")).toMatchObject({
      status: "FILLED",
      filledQuantity: 0.1
    });
    expect(dashboard.recentTrades).toHaveLength(1);
    expect(dashboard.recentTrades[0]).toMatchObject({
      positionId: seededOrder.positionId,
      exitReason: "STOP_LOSS",
      quantity: 0.1
    });
    expect(dashboard.account?.completedTrades).toBe(1);

    stage = 3;
    now = new Date("2026-07-17T01:28:00.000Z");
    await engine.enqueueCycle();
    dashboard = repository.dashboard();
    expect(dashboard.positions).toHaveLength(0);
    expect(dashboard.recentTrades).toHaveLength(1);
    expect(dashboard.account?.completedTrades).toBe(1);
    expect(dashboard.orders.find((order) => order.id === seededOrder.id)).toMatchObject({
      status: "CANCELED",
      filledQuantity: 0.1
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM executions").get()).toEqual({ count: 0 });

    const closedTrade = dashboard.recentTrades[0]!;
    expect(() => repository.commitCycle({
      account: dashboard.account!,
      positions: [],
      trades: [{ ...closedTrade, id: "stock-trade:forbidden-second-close" }],
      equityPoint: {
        capturedAt: "2026-07-17T01:28:30.000Z",
        navUsd: dashboard.account!.navUsd,
        cashUsd: dashboard.account!.cashUsd,
        deployedUsd: dashboard.account!.deployedUsd,
        drawdownPercent: 0
      },
      market: dashboard.market
    })).toThrow(/unique/i);
  });

  it("re-checks cash and deployment capacity before each sequential pending BUY fill", async () => {
    db = openDatabase(":memory:");
    const repository = new StockPaperRepository(db);
    const now = new Date("2026-07-17T01:22:00.000Z");
    const lane = repository.ensureActiveLane("2026-07-17T01:20:10.000Z");
    const first = seedPendingBuy(repository, lane, "2026-07-17T01:20:10.000Z", 0.31);
    const second: StockPaperOrder = {
      ...first,
      id: "test-buy:msft:2026-07-17T01:20:20.000Z",
      idempotencyKey: "test-buy:msft:2026-07-17T01:20:20.000Z",
      positionId: "test-position:msft:2026-07-17T01:20:20.000Z",
      symbol: "MSFT",
      submittedAt: "2026-07-17T01:20:20.000Z",
      updatedAt: "2026-07-17T01:20:20.000Z",
      ...(first.entryContext
        ? {
            entryContext: {
              ...first.entryContext,
              capturedAt: "2026-07-17T01:20:20.000Z"
            }
          }
        : {})
    };
    const account = repository.account(lane.id)!;
    const constrainedAccount = {
      ...account,
      cashUsd: 70,
      navUsd: 70,
      executableNavUsd: 70,
      fairNavUsd: 70,
      peakNavUsd: 70,
      dayStartNavUsd: 70,
      updatedAt: second.submittedAt
    };
    repository.commitCycle({
      account: constrainedAccount,
      positions: [],
      orders: [first, second],
      equityPoint: {
        capturedAt: second.submittedAt,
        navUsd: 70,
        cashUsd: 70,
        deployedUsd: 0,
        drawdownPercent: 0
      },
      market: {
        feed: "OVERNIGHT",
        isOpen: true,
        phase: "OVERNIGHT",
        scannedSymbols: 2,
        detailedSymbols: 2,
        providerRequests: 1
      }
    });
    const provider = pendingBuySafetyProvider({ now, symbols: ["AAPL", "MSFT"] });
    const engine = new StockPaperEngine(repository, {
      mode: () => "PAPER",
      credentials: () => ({ apiKey: "paper-api-key", secretKey: "paper-secret-key" }),
      provider: () => provider,
      now: () => now
    });

    await engine.enqueueCycle();
    const dashboard = repository.dashboard();
    expect(dashboard.orders.find((order) => order.id === first.id)).toMatchObject({
      status: "FILLED",
      filledQuantity: 0.31
    });
    const canceledSecond = dashboard.orders.find((order) => order.id === second.id)!;
    expect(canceledSecond).toMatchObject({ status: "CANCELED", filledQuantity: 0, fills: [] });
    expect(canceledSecond.reason).toContain("minimum cash reserve");
    expect(dashboard.positions).toHaveLength(1);
    expect(dashboard.positions[0]).toMatchObject({ symbol: "AAPL", quantity: 0.31 });
    expect(repository.orderEvents(lane.id, second.id).some((event) => event.eventType === "FILL"))
      .toBe(false);
  });

  it("cancels an oversized pending BUY before fill evidence can breach the per-position NAV cap", async () => {
    db = openDatabase(":memory:");
    const repository = new StockPaperRepository(db);
    const now = new Date("2026-07-17T01:22:00.000Z");
    const lane = repository.ensureActiveLane("2026-07-17T01:20:10.000Z");
    const order = seedPendingBuy(
      repository,
      lane,
      "2026-07-17T01:20:10.000Z",
      1
    );
    const provider = pendingBuySafetyProvider({ now, symbols: ["AAPL"] });
    const engine = new StockPaperEngine(repository, {
      mode: () => "PAPER",
      credentials: () => ({ apiKey: "paper-api-key", secretKey: "paper-secret-key" }),
      provider: () => provider,
      now: () => now
    });

    await engine.enqueueCycle();
    const dashboard = repository.dashboard();
    const canceled = dashboard.orders.find((entry) => entry.id === order.id)!;
    expect(canceled).toMatchObject({ status: "CANCELED", filledQuantity: 0, fills: [] });
    expect(canceled.reason).toContain("maximum per-position NAV fraction");
    expect(dashboard.positions).toEqual([]);
    expect(dashboard.account).toMatchObject({ cashUsd: 141, deployedUsd: 0 });

    const events = repository.orderEvents(lane.id, order.id);
    expect(events.some((event) => event.eventType === "FILL")).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({
      eventType: "STATUS_TRANSITION",
      priorStatus: "SUBMITTED",
      newStatus: "CANCELED"
    }));
  });

  it("cancels a pending BUY when the exchange calendar loses its continuous entry window", async () => {
    db = openDatabase(":memory:");
    const repository = new StockPaperRepository(db);
    const now = new Date("2026-07-17T01:22:00.000Z");
    const lane = repository.ensureActiveLane("2026-07-17T01:20:10.000Z");
    const order = seedPendingBuy(repository, lane, "2026-07-17T01:20:10.000Z", 0.3);
    const provider = pendingBuySafetyProvider({
      now,
      symbols: ["AAPL"],
      nextOpen: "2026-07-20T13:30:00.000Z"
    });
    const engine = new StockPaperEngine(repository, {
      mode: () => "PAPER",
      credentials: () => ({ apiKey: "paper-api-key", secretKey: "paper-secret-key" }),
      provider: () => provider,
      now: () => now
    });

    await engine.enqueueCycle();
    const canceled = repository.orders(lane.id).find((entry) => entry.id === order.id)!;
    expect(canceled).toMatchObject({ status: "CANCELED", filledQuantity: 0, fills: [] });
    expect(canceled.reason).toContain("continuous actionable entry window");
    expect(repository.positions(lane.id, true)).toEqual([]);
  });

  it("cancels a paused partial BUY before bar resolution without changing its open lot", async () => {
    db = openDatabase(":memory:");
    const repository = new StockPaperRepository(db);
    const submittedAt = "2026-07-17T01:20:30.000Z";
    const now = new Date("2026-07-17T01:22:00.000Z");
    const lane = repository.ensureActiveLane(submittedAt);
    const seeded = seedPendingBuy(repository, lane, submittedAt);
    const account = repository.account(lane.id)!;
    const fill = {
      id: `${seeded.id}:seed-fill`,
      quantity: 0.1,
      priceUsd: 99,
      notionalUsd: 9.9,
      modeledCostsUsd: 0,
      evidence: "BAR" as const,
      evidenceAt: "2026-07-17T01:21:00.000Z",
      createdAt: "2026-07-17T01:21:30.000Z"
    };
    const partialOrder: StockPaperOrder = {
      ...seeded,
      status: "PARTIAL",
      filledQuantity: 0.1,
      averageFillPriceUsd: 99,
      reservedNotionalUsd: (seeded.requestedQuantity - 0.1) * seeded.limitPriceUsd,
      fills: [fill],
      updatedAt: fill.createdAt
    };
    const partialPosition: StockPaperPosition = {
      id: seeded.positionId!,
      laneId: lane.id,
      symbol: seeded.symbol,
      arm: seeded.arm,
      status: "OPEN",
      quantity: 0.1,
      entryPriceUsd: 99,
      entryNotionalUsd: 9.9,
      remainingCostUsd: 9.9,
      lastBidUsd: 99,
      lastAskUsd: 99.1,
      lastMarkUsd: 99,
      lastValueUsd: 9.9,
      lastExecutableValueUsd: 9.9,
      peakPriceUsd: 99,
      stopPriceUsd: 91.08,
      takeProfitPriceUsd: 110.88,
      scoreAtEntry: seeded.candidateScore,
      ...(seeded.entryContext ? { entryContext: seeded.entryContext } : {}),
      openedAt: fill.evidenceAt,
      updatedAt: fill.createdAt
    };
    repository.commitCycle({
      account: {
        ...account,
        cashUsd: 131.1,
        navUsd: 141,
        deployedUsd: 9.9,
        openPositions: 1,
        pausedReason: "Manual PAPER safety pause.",
        updatedAt: fill.createdAt
      },
      positions: [partialPosition],
      orders: [partialOrder],
      equityPoint: {
        capturedAt: fill.createdAt,
        navUsd: 141,
        cashUsd: 131.1,
        deployedUsd: 9.9,
        drawdownPercent: 0
      },
      market: {
        feed: "OVERNIGHT",
        isOpen: true,
        phase: "OVERNIGHT",
        scannedSymbols: 1,
        detailedSymbols: 1,
        providerRequests: 1
      }
    });
    const provider = {
      async getClock(): Promise<AlpacaMarketClock> {
        return {
          timestamp: now.toISOString(),
          isOpen: false,
          nextOpen: "2026-07-17T13:30:00.000Z",
          nextClose: "2026-07-17T20:00:00.000Z"
        };
      },
      async getAssets() { return [testAsset()]; },
      async getCorporateActions() { return { actions: [] }; },
      async getSnapshots(symbols: readonly string[]) {
        return symbols.includes("AAPL") ? [snapshot(99, now.toISOString())] : [];
      },
      async getBars(input: { symbols: readonly string[] }): Promise<AlpacaBarsResult> {
        const fillable = {
          timestamp: "2026-07-17T01:21:00.000Z",
          open: 99,
          high: 100,
          low: 98,
          close: 99,
          volume: 10_000,
          tradeCount: 100,
          vwap: 99
        };
        return { bars: new Map(input.symbols.map((symbol) => [
          symbol,
          symbol === "AAPL" ? [fillable] : []
        ])) };
      }
    } as unknown as AlpacaPaperProvider;
    const engine = new StockPaperEngine(repository, {
      mode: () => "PAPER",
      credentials: () => ({ apiKey: "paper-api-key", secretKey: "paper-secret-key" }),
      provider: () => provider,
      now: () => now
    });

    await engine.enqueueCycle();
    const dashboard = repository.dashboard();
    const canceled = dashboard.orders.find((order) => order.id === seeded.id)!;
    expect(canceled).toMatchObject({
      status: "CANCELED",
      filledQuantity: 0.1,
      fills: [fill]
    });
    expect(canceled.reason).toContain("account is paused");
    expect(dashboard.positions.find((position) => position.id === partialPosition.id)?.quantity)
      .toBeCloseTo(0.1, 10);
    expect(repository.orderEvents(lane.id, seeded.id)).toEqual([
      expect.objectContaining({
        eventType: "STATUS_TRANSITION",
        priorStatus: "PARTIAL",
        newStatus: "CANCELED"
      })
    ]);
    expect(repository.orderEvents(lane.id, seeded.id).some((event) => event.eventType === "FILL"))
      .toBe(false);
  });

  it("expires unverifiable SELL evidence and rolls the liquidation into a finite new session order", async () => {
    db = openDatabase(":memory:");
    const repository = new StockPaperRepository(db);
    const now = new Date("2026-07-17T01:20:00.000Z");
    const lane = repository.ensureActiveLane("2026-07-17T00:50:00.000Z");
    const account = repository.account(lane.id)!;
    const position: StockPaperPosition = {
      id: "stock-position:rollover",
      laneId: lane.id,
      symbol: "AAPL",
      arm: "BREAKOUT",
      status: "OPEN",
      quantity: 0.75,
      entryPriceUsd: 100,
      entryNotionalUsd: 75,
      remainingCostUsd: 75,
      lastBidUsd: 99.95,
      lastAskUsd: 100.05,
      lastMarkUsd: 100,
      lastValueUsd: 75,
      lastExecutableValueUsd: 74.925,
      peakPriceUsd: 100,
      stopPriceUsd: 92,
      takeProfitPriceUsd: 112,
      scoreAtEntry: 82,
      openedAt: "2026-07-17T00:50:00.000Z",
      updatedAt: "2026-07-17T00:55:00.000Z"
    };
    const carriedFill = {
      id: "stock-order:rollover-old:fill-1",
      quantity: 0.25,
      priceUsd: 100,
      notionalUsd: 25,
      modeledCostsUsd: 0,
      evidence: "BAR" as const,
      evidenceAt: "2026-07-17T00:56:00.000Z",
      createdAt: "2026-07-17T01:00:00.000Z"
    };
    const oldOrder: StockPaperOrder = {
      id: "stock-order:rollover-old",
      idempotencyKey: "stock-order:rollover-old",
      laneId: lane.id,
      positionId: position.id,
      symbol: position.symbol,
      arm: position.arm,
      side: "SELL",
      status: "PARTIAL",
      phase: "OVERNIGHT",
      feed: "OVERNIGHT",
      policyVersion: lane.policyVersion,
      executionVersion: STOCK_PAPER_EXECUTION_VERSION,
      submittedAt: "2026-07-17T00:55:00.000Z",
      expiresAt: "2026-07-17T01:10:00.000Z",
      evidenceTimeoutAt: "2026-07-17T01:10:00.000Z",
      triggerEvidenceAt: "2026-07-17T00:54:00.000Z",
      triggerObservedAt: "2026-07-17T00:55:00.000Z",
      rolloverCount: 0,
      firstEligibleBarAt: "2026-07-17T00:56:00.000Z",
      limitPriceUsd: 99.9,
      requestedQuantity: 1,
      filledQuantity: 0.25,
      averageFillPriceUsd: 100,
      reservedNotionalUsd: 0,
      candidateScore: 82,
      exitReason: "DATA_SAFETY",
      exitCostBasisUsd: 100,
      fills: [carriedFill],
      reason: "Awaiting causal liquidation evidence.",
      updatedAt: "2026-07-17T00:55:00.000Z"
    };
    repository.commitCycle({
      account: {
        ...account,
        cashUsd: 66,
        navUsd: 141,
        deployedUsd: 75,
        openPositions: 1,
        updatedAt: oldOrder.updatedAt
      },
      positions: [position],
      orders: [oldOrder],
      equityPoint: {
        capturedAt: oldOrder.updatedAt,
        navUsd: 141,
        cashUsd: 66,
        deployedUsd: 75,
        drawdownPercent: 0
      },
      market: {
        feed: "OVERNIGHT",
        isOpen: true,
        phase: "OVERNIGHT",
        scannedSymbols: 1,
        detailedSymbols: 1,
        providerRequests: 1
      }
    });
    const provider = {
      async getClock(): Promise<AlpacaMarketClock> {
        return {
          timestamp: now.toISOString(),
          isOpen: false,
          nextOpen: "2026-07-17T13:30:00.000Z",
          nextClose: "2026-07-17T20:00:00.000Z"
        };
      },
      async getAssets() { return [testAsset()]; },
      async getCorporateActions() { return { actions: [] }; },
      async getSnapshots(symbols: readonly string[]) {
        return symbols.includes("AAPL") ? [snapshot(100, now.toISOString())] : [];
      },
      async getBars(input: { symbols: readonly string[] }): Promise<AlpacaBarsResult> {
        return { bars: new Map(input.symbols.map((symbol) => [
          symbol,
          symbol === "AAPL" ? entryBars("2026-07-17T01:19:00.000Z") : []
        ])) };
      }
    } as unknown as AlpacaPaperProvider;
    const engine = new StockPaperEngine(repository, {
      mode: () => "PAPER",
      credentials: () => ({ apiKey: "paper-api-key", secretKey: "paper-secret-key" }),
      provider: () => provider,
      now: () => now
    });

    await engine.enqueueCycle();
    const orders = repository.orders(lane.id, 10);
    expect(orders.find((order) => order.id === oldOrder.id)).toMatchObject({
      status: "EXPIRED",
      filledQuantity: 0.25,
      fills: [carriedFill]
    });
    const replacement = orders.find((order) => order.replacesOrderId === oldOrder.id)!;
    expect(replacement).toMatchObject({
      side: "SELL",
      status: "SUBMITTED",
      evidenceTimeoutAt: replacement.expiresAt,
      rolloverCount: 1,
      triggerEvidenceAt: oldOrder.triggerEvidenceAt,
      triggerObservedAt: oldOrder.triggerObservedAt,
      exitReason: oldOrder.exitReason,
      exitCostBasisUsd: oldOrder.exitCostBasisUsd,
      requestedQuantity: 1,
      filledQuantity: 0.25,
      averageFillPriceUsd: 100,
      fills: [carriedFill]
    });
    expect(Date.parse(replacement.expiresAt)).toBeGreaterThan(now.getTime());
    expect(replacement.expiresAt).not.toBe("9999-12-31T23:59:59.999Z");
    expect(repository.positions(lane.id, true)[0]).toMatchObject({
      id: position.id,
      status: "OPEN",
      quantity: 0.75
    });
    const rolloverEvents = repository.orderEvents(lane.id);
    expect(rolloverEvents.filter((event) => event.eventType === "FILL")).toEqual([]);
    expect(rolloverEvents.map((event) => ({
      orderId: event.orderId,
      eventType: event.eventType,
      newStatus: event.newStatus
    }))).toEqual(expect.arrayContaining([
      { orderId: oldOrder.id, eventType: "STATUS_TRANSITION", newStatus: "EXPIRED" },
      { orderId: replacement.id, eventType: "SUBMISSION", newStatus: "SUBMITTED" }
    ]));
  });

  it("computes the finite BOATS boundary on both sides of midnight", () => {
    expect(stockPaperOvernightFeedMinutesRemaining("2026-07-17T00:20:00.000Z"))
      .toBe(460); // 8:20 PM ET to 4:00 AM ET
    expect(stockPaperOvernightFeedMinutesRemaining("2026-07-17T07:50:00.000Z"))
      .toBe(10); // 3:50 AM ET to 4:00 AM ET
    expect(stockPaperOvernightFeedMinutesRemaining("2026-07-17T11:00:00.000Z"))
      .toBeUndefined();
  });

  it("keeps one finite PREMARKET liquidation alive through the free-feed evidence gap", () => {
    expect(stockPaperSellEvidenceTimeoutAt(
      "2026-07-17T08:00:00.000Z", // 4:00 AM ET
      "PREMARKET"
    )).toBe("2026-07-17T12:09:00.000Z");
    expect(stockPaperSellEvidenceTimeoutAt(
      "2026-07-17T12:10:00.000Z", // 8:10 AM ET
      "PREMARKET"
    )).toBe("2026-07-17T12:19:00.000Z");
    expect(stockPaperSellEvidenceTimeoutAt(
      "2026-07-17T01:20:00.000Z",
      "OVERNIGHT"
    )).toBe("2026-07-17T01:45:00.000Z");
  });

  it("cancels an unfilled overnight BUY after the entry cutoff", async () => {
    db = openDatabase(":memory:");
    const repository = new StockPaperRepository(db);
    const submittedAt = "2026-07-17T01:20:00.000Z";
    const now = new Date("2026-07-17T07:46:00.000Z"); // 3:46 AM ET
    const lane = repository.ensureActiveLane(submittedAt);
    const order = seedPendingBuy(
      repository,
      lane,
      submittedAt,
      0.25,
      true,
      "2026-07-17T08:05:00.000Z"
    );
    const engine = new StockPaperEngine(repository, {
      mode: () => "PAPER",
      credentials: () => ({ apiKey: "paper-api-key", secretKey: "paper-secret-key" }),
      provider: () => pendingBuySafetyProvider({ now, symbols: ["AAPL"] }),
      now: () => now
    });

    await engine.enqueueCycle();

    expect(repository.orders(lane.id).find((entry) => entry.id === order.id)).toMatchObject({
      status: "CANCELED",
      filledQuantity: 0,
      fills: [],
      reason: "The extended-hours entry window closed before the pending PAPER order filled."
    });
    expect(repository.positions(lane.id, true)).toEqual([]);
  });

  it("uses delayed SIP only for fair value while executable NAV and orders stay blocked", async () => {
    db = openDatabase(":memory:");
    const repository = new StockPaperRepository(db);
    const now = new Date("2026-07-17T11:15:00.000Z"); // 7:15 AM ET
    const lane = repository.ensureActiveLane(now.toISOString());
    const account = repository.account(lane.id)!;
    const position: StockPaperPosition = {
      id: "stock-position:delayed-sip",
      laneId: lane.id,
      symbol: "AAPL",
      arm: "BREAKOUT",
      status: "UNPRICED",
      quantity: 1,
      entryPriceUsd: 100,
      entryNotionalUsd: 100,
      remainingCostUsd: 100,
      lastBidUsd: 98.9,
      lastAskUsd: 99.1,
      lastMarkUsd: 99,
      lastValueUsd: 99,
      lastExecutableValueUsd: 99,
      peakPriceUsd: 100,
      stopPriceUsd: 92,
      takeProfitPriceUsd: 112,
      scoreAtEntry: 80,
      openedAt: "2026-07-17T05:00:00.000Z",
      updatedAt: "2026-07-17T07:44:00.000Z"
    };
    repository.commitCycle({
      account: {
        ...account,
        cashUsd: 41,
        navUsd: 140,
        executableNavUsd: 140,
        fairNavUsd: 140,
        deployedUsd: 99,
        fairDeployedUsd: 99,
        openPositions: 1,
        pricingComplete: false,
        updatedAt: position.updatedAt
      },
      positions: [position],
      equityPoint: {
        capturedAt: position.updatedAt,
        navUsd: 140,
        cashUsd: 41,
        deployedUsd: 99,
        drawdownPercent: 0
      },
      market: {
        feed: "OVERNIGHT",
        isOpen: false,
        phase: "OVERNIGHT",
        scannedSymbols: 0,
        detailedSymbols: 0,
        providerRequests: 0
      }
    });
    const staleAt = "2026-07-17T07:44:00.000Z";
    const delayedSipBar: AlpacaStockBar = {
      timestamp: "2026-07-17T10:59:00.000Z",
      open: 102.8,
      high: 103.2,
      low: 102.7,
      close: 103,
      volume: 10_000,
      tradeCount: 100,
      vwap: 102.95
    };
    const requestedFeeds: Array<string | undefined> = [];
    const provider = {
      async getClock(): Promise<AlpacaMarketClock> {
        return {
          timestamp: now.toISOString(),
          isOpen: false,
          nextOpen: "2026-07-17T13:30:00.000Z",
          nextClose: "2026-07-17T20:00:00.000Z"
        };
      },
      async getAssets(): Promise<AlpacaStockAsset[]> { return [testAsset()]; },
      async getCorporateActions() { return { actions: [] }; },
      async getSnapshots(symbols: readonly string[]): Promise<AlpacaStockSnapshot[]> {
        return symbols.includes("AAPL") ? [snapshot(99, staleAt)] : [];
      },
      async getBars(input: {
        symbols: readonly string[];
        feed?: "iex" | "boats" | "sip";
      }): Promise<AlpacaBarsResult> {
        requestedFeeds.push(input.feed);
        return {
          bars: new Map(input.symbols.map((symbol) => [
            symbol,
            input.feed === "sip" && symbol === "AAPL" ? [delayedSipBar] : []
          ]))
        };
      }
    } as unknown as AlpacaPaperProvider;
    const engine = new StockPaperEngine(repository, {
      mode: () => "PAPER",
      credentials: () => ({ apiKey: "paper-api-key", secretKey: "paper-secret-key" }),
      provider: () => provider,
      now: () => now
    });

    await engine.enqueueCycle();

    const dashboard = repository.dashboard();
    expect(requestedFeeds).toContain("sip");
    expect(dashboard.positions[0]).toMatchObject({
      status: "UNPRICED",
      lastMarkUsd: 103,
      lastValueUsd: 103,
      lastExecutableValueUsd: 99,
      delayedFairValueEvidence: {
        feed: "SIP_DELAYED",
        priceUsd: 103,
        evidenceAt: delayedSipBar.timestamp,
        observedAt: now.toISOString()
      }
    });
    expect(dashboard.account).toMatchObject({
      pricingComplete: false,
      deployedUsd: 99,
      executableNavUsd: 140,
      fairDeployedUsd: 103,
      fairNavUsd: 144
    });
    expect(dashboard.orders.filter((entry) => entry.side === "SELL")).toEqual([]);
    expect(dashboard.market).toMatchObject({
      feed: "IEX",
      phase: "PREMARKET",
      delayedFairValueFeed: "SIP",
      delayedFairValueAt: delayedSipBar.timestamp,
      openPositionPricingCoveragePercent: 0
    });
  });

  it("arms a real-evidence SESSION_END liquidation early enough for delayed BOATS confirmation", async () => {
    db = openDatabase(":memory:");
    const repository = new StockPaperRepository(db);
    const now = new Date("2026-07-17T07:25:00.000Z"); // 3:25 AM ET
    const lane = repository.ensureActiveLane("2026-07-17T06:00:00.000Z");
    const account = repository.account(lane.id)!;
    const position: StockPaperPosition = {
      id: "stock-position:boats-boundary",
      laneId: lane.id,
      symbol: "AAPL",
      arm: "BREAKOUT",
      status: "OPEN",
      quantity: 1,
      entryPriceUsd: 100,
      entryNotionalUsd: 100,
      remainingCostUsd: 100,
      lastBidUsd: 99.95,
      lastAskUsd: 100.05,
      lastMarkUsd: 100,
      lastValueUsd: 100,
      lastExecutableValueUsd: 99.9,
      peakPriceUsd: 100,
      stopPriceUsd: 92,
      takeProfitPriceUsd: 112,
      scoreAtEntry: 82,
      openedAt: "2026-07-17T06:00:00.000Z",
      updatedAt: "2026-07-17T07:24:00.000Z"
    };
    repository.commitCycle({
      account: {
        ...account,
        cashUsd: 41,
        navUsd: 140.9,
        deployedUsd: 99.9,
        openPositions: 1,
        pricingComplete: true,
        updatedAt: position.updatedAt
      },
      positions: [position],
      equityPoint: {
        capturedAt: position.updatedAt,
        navUsd: 140.9,
        cashUsd: 41,
        deployedUsd: 99.9,
        drawdownPercent: 0
      },
      market: {
        feed: "OVERNIGHT",
        isOpen: true,
        phase: "OVERNIGHT",
        scannedSymbols: 1,
        detailedSymbols: 1,
        providerRequests: 1
      }
    });
    const provider = {
      async getClock(): Promise<AlpacaMarketClock> {
        return {
          timestamp: now.toISOString(),
          isOpen: false,
          nextOpen: "2026-07-17T13:30:00.000Z",
          nextClose: "2026-07-17T20:00:00.000Z"
        };
      },
      async getAssets(): Promise<AlpacaStockAsset[]> { return [testAsset()]; },
      async getCorporateActions() { return { actions: [] }; },
      async getSnapshots(symbols: readonly string[]): Promise<AlpacaStockSnapshot[]> {
        return symbols.includes("AAPL") ? [snapshot(100, now.toISOString())] : [];
      },
      async getBars(input: { symbols: readonly string[] }): Promise<AlpacaBarsResult> {
        return { bars: new Map(input.symbols.map((symbol) => [
          symbol,
          symbol === "AAPL" ? entryBars("2026-07-17T07:09:00.000Z") : []
        ])) };
      }
    } as unknown as AlpacaPaperProvider;
    const engine = new StockPaperEngine(repository, {
      mode: () => "PAPER",
      credentials: () => ({ apiKey: "paper-api-key", secretKey: "paper-secret-key" }),
      provider: () => provider,
      now: () => now
    });

    await engine.enqueueCycle();

    const sell = repository.orders(lane.id).find((entry) => entry.side === "SELL");
    expect(sell).toMatchObject({
      symbol: "AAPL",
      side: "SELL",
      status: "SUBMITTED",
      phase: "OVERNIGHT",
      feed: "OVERNIGHT",
      exitReason: "SESSION_END"
    });
    expect(repository.positions(lane.id, true)).toHaveLength(1);
    expect(repository.trades(lane.id)).toEqual([]);
  });
});
