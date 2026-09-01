import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AlpacaBarsResult,
  AlpacaMarketClock,
  AlpacaPaperProvider,
  AlpacaStockAsset,
  AlpacaStockSnapshot,
  AlpacaStockBar
} from "@copylab/providers";
import type {
  StockPaperCandidate,
  StockPaperPosition
} from "@copylab/shared";
import { openDatabase, type CopyLabDatabase } from "../src/database.js";
import { StockPaperEngine } from "../src/stock-paper.js";
import { StockPaperRepository } from "../src/stock-paper-repository.js";
import { evaluateStockPaperRotationDecision } from "../src/stock-paper-rotation-shadow.js";

const NOW = new Date("2026-07-17T15:00:00.000Z");

function quietProvider(
  now: Date,
  onBars?: (symbols: readonly string[]) => Map<string, AlpacaStockBar[]>
): AlpacaPaperProvider {
  return {
    async getClock(): Promise<AlpacaMarketClock> {
      return {
        timestamp: now.toISOString(),
        isOpen: true,
        nextOpen: "2026-07-20T13:30:00.000Z",
        nextClose: "2026-07-17T20:00:00.000Z"
      };
    },
    async getAssets() {
      return [];
    },
    async getSnapshots() {
      return [];
    },
    async getBars(input: { symbols: readonly string[] }): Promise<AlpacaBarsResult> {
      return { bars: onBars?.(input.symbols) ?? new Map() };
    }
  } as unknown as AlpacaPaperProvider;
}

function candidate(
  symbol: string,
  score: number,
  capturedAt: string
): StockPaperCandidate {
  return {
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
    score,
    arm: "BREAKOUT",
    highConviction: true,
    eligible: true,
    reasons: [],
    marketPhase: "REGULAR",
    marketFeed: "IEX",
    capturedAt
  };
}

function completeBars(
  decisionAt: string,
  base: number,
  step: number
): AlpacaStockBar[] {
  const decisionMs = Date.parse(decisionAt);
  const bar = (offsetMinutes: number, close: number): AlpacaStockBar => ({
    timestamp: new Date(decisionMs + offsetMinutes * 60_000).toISOString(),
    open: close - 0.05,
    high: close + 0.1,
    low: close - 0.1,
    close,
    volume: 10_000,
    tradeCount: 100,
    vwap: close
  });
  return [
    // These two sentinel prices must not enter the strict future horizon.
    bar(0, base * 10),
    ...Array.from({ length: 15 }, (_, index) =>
      bar(index + 1, base + step * (index + 1))
    ),
    bar(16, base * 20)
  ];
}

function scoringBars(
  endAt: string,
  base: number,
  slope: number,
  volumeSurge: boolean
): AlpacaStockBar[] {
  const startMs = Date.parse(endAt) - 39 * 60_000;
  return Array.from({ length: 40 }, (_, index) => {
    const close = base + slope * index;
    return {
      timestamp: new Date(startMs + index * 60_000).toISOString(),
      open: close - 0.02,
      high: close + 0.05,
      low: close - 0.05,
      close,
      volume: volumeSurge && index >= 35 ? 5_000 : 1_000,
      tradeCount: 100,
      vwap: close - slope
    };
  });
}

function marketSnapshot(input: {
  symbol: string;
  now: string;
  price: number;
  dailyVolume: number;
}): AlpacaStockSnapshot {
  return {
    symbol: input.symbol,
    latestQuote: {
      timestamp: input.now,
      bidPrice: input.price - 0.05,
      bidSize: 100,
      askPrice: input.price + 0.05,
      askSize: 100
    },
    latestTrade: { timestamp: input.now, price: input.price, size: 1 },
    minuteBar: {
      timestamp: new Date(Date.parse(input.now) - 60_000).toISOString(),
      open: input.price - 0.03,
      high: input.price + 0.05,
      low: input.price - 0.05,
      close: input.price,
      volume: 5_000,
      tradeCount: 100,
      vwap: input.price - 0.02
    },
    dailyBar: {
      timestamp: `${input.now.slice(0, 10)}T04:00:00.000Z`,
      open: input.price * 0.98,
      high: input.price * 1.02,
      low: input.price * 0.97,
      close: input.price,
      volume: input.dailyVolume,
      tradeCount: 5_000,
      vwap: input.price * 0.99
    },
    previousDailyBar: {
      timestamp: "2026-07-16T04:00:00.000Z",
      open: input.price * 0.97,
      high: input.price,
      low: input.price * 0.96,
      close: input.price * 0.98,
      volume: 1_000_000,
      tradeCount: 5_000,
      vwap: input.price * 0.98
    }
  };
}

function marketAsset(symbol: string): AlpacaStockAsset {
  return {
    symbol,
    name: `${symbol} test asset`,
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

describe("StockPaperEngine rotation shadow integration", () => {
  let db: CopyLabDatabase | undefined;

  afterEach(() => {
    vi.restoreAllMocks();
    db?.close();
    db = undefined;
  });

  it("keeps the committed PAPER account identical when the independent analysis commit fails", async () => {
    db = openDatabase(":memory:");
    const repository = new StockPaperRepository(db);
    const lane = repository.ensureActiveLane("2026-07-17T14:00:00.000Z");
    const authoritativeCommits: Parameters<StockPaperRepository["commitCycle"]>[0][] = [];
    const ordering: string[] = [];
    const commitCycle = repository.commitCycle.bind(repository);
    vi.spyOn(repository, "commitCycle").mockImplementation((input) => {
      ordering.push("authoritative");
      commitCycle(input);
      authoritativeCommits.push(structuredClone(input));
    });
    vi.spyOn(repository, "commitRotationAnalysis").mockImplementation(() => {
      ordering.push("analysis");
      throw new Error("forced rotation-analysis failure");
    });
    const errors: unknown[] = [];
    const engine = new StockPaperEngine(repository, {
      mode: () => "PAPER",
      credentials: () => ({ apiKey: "paper-api-key", secretKey: "paper-secret-key" }),
      provider: () => quietProvider(NOW),
      now: () => NOW,
      onError: (error) => errors.push(error)
    });

    await expect(engine.enqueueCycle()).resolves.toBeUndefined();

    expect(ordering).toEqual(["authoritative", "analysis"]);
    expect(authoritativeCommits).toHaveLength(1);
    expect(repository.account(lane.id)).toEqual(authoritativeCommits[0]!.account);
    expect(repository.positions(lane.id)).toEqual([]);
    expect(repository.orders(lane.id)).toEqual([]);
    expect(repository.signals(lane.id)).toEqual([]);
    expect(repository.trades(lane.id)).toEqual([]);
    expect(repository.recentRotationDecisions(lane.id)).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      message: "The analysis-only stock PAPER rotation persistence failed safely."
    });
  });

  it("never persists rotation analysis when the authoritative PAPER commit fails", async () => {
    db = openDatabase(":memory:");
    const repository = new StockPaperRepository(db);
    repository.ensureActiveLane("2026-07-17T14:00:00.000Z");
    vi.spyOn(repository, "commitCycle").mockImplementation(() => {
      throw new Error("forced authoritative failure");
    });
    const analysisCommit = vi.spyOn(repository, "commitRotationAnalysis");
    const engine = new StockPaperEngine(repository, {
      mode: () => "PAPER",
      credentials: () => ({ apiKey: "paper-api-key", secretKey: "paper-secret-key" }),
      provider: () => quietProvider(NOW),
      now: () => NOW
    });

    await expect(engine.enqueueCycle()).rejects.toThrow("forced authoritative failure");
    expect(analysisCommit).not.toHaveBeenCalled();
  });

  it("scores an ineligible held symbol only for the outgoing rotation leg", async () => {
    db = openDatabase(":memory:");
    const repository = new StockPaperRepository(db);
    const now = new Date("2026-07-17T15:00:00.000Z");
    const lane = repository.ensureActiveLane("2026-07-17T14:00:00.000Z");
    const account = repository.account(lane.id)!;
    const position: StockPaperPosition = {
      id: "held-aapl",
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
      peakPriceUsd: 101,
      stopPriceUsd: 92,
      takeProfitPriceUsd: 112,
      scoreAtEntry: 70,
      openedAt: "2026-07-17T14:00:00.000Z",
      lastProtectiveBarAt: "2026-07-17T14:59:00.000Z",
      updatedAt: "2026-07-17T14:59:00.000Z"
    };
    repository.commitCycle({
      account: {
        ...account,
        cashUsd: 41,
        navUsd: 141,
        executableNavUsd: 141,
        deployedUsd: 100,
        fairDeployedUsd: 100,
        unrealizedPnlUsd: 0,
        openPositions: 1,
        updatedAt: "2026-07-17T14:59:00.000Z"
      },
      positions: [position],
      equityPoint: {
        capturedAt: "2026-07-17T14:59:00.000Z",
        navUsd: 141,
        cashUsd: 41,
        deployedUsd: 100,
        drawdownPercent: 0
      },
      market: {
        feed: "IEX",
        isOpen: true,
        phase: "REGULAR",
        scannedSymbols: 0,
        detailedSymbols: 0,
        providerRequests: 0
      }
    });
    const outgoingSnapshot = marketSnapshot({
      symbol: "AAPL",
      now: now.toISOString(),
      price: 100,
      // Deliberately below the authoritative $2m prefilter.
      dailyVolume: 1_000
    });
    const incomingSnapshot = marketSnapshot({
      symbol: "LCID",
      now: now.toISOString(),
      price: 12,
      dailyVolume: 1_000_000
    });
    const barsBySymbol = new Map<string, AlpacaStockBar[]>([
      ["AAPL", scoringBars("2026-07-17T14:59:00.000Z", 100.4, -0.01, false)],
      ["LCID", scoringBars("2026-07-17T14:59:00.000Z", 10, 0.05, true)]
    ]);
    const provider = {
      async getClock(): Promise<AlpacaMarketClock> {
        return {
          timestamp: now.toISOString(),
          isOpen: true,
          nextOpen: "2026-07-20T13:30:00.000Z",
          nextClose: "2026-07-17T20:00:00.000Z"
        };
      },
      async getAssets() {
        return [marketAsset("AAPL"), marketAsset("LCID")];
      },
      async getSnapshots(symbols: readonly string[]) {
        return [outgoingSnapshot, incomingSnapshot].filter((snapshot) =>
          symbols.includes(snapshot.symbol)
        );
      },
      async getBars(input: { symbols: readonly string[] }): Promise<AlpacaBarsResult> {
        return {
          bars: new Map(input.symbols.map((symbol) => [
            symbol,
            barsBySymbol.get(symbol) ?? []
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

    const frozen = repository.recentRotationDecisions(lane.id)[0];
    expect(frozen).toMatchObject({
      status: "ROTATE",
      outgoing: { symbol: "AAPL" },
      incoming: { symbol: "LCID" }
    });
    expect(repository.candidates(lane.id).map((entry) => entry.symbol)).not.toContain("AAPL");
  });

  it("fetches both due rotation legs and labels only their strictly future complete bars", async () => {
    db = openDatabase(":memory:");
    const repository = new StockPaperRepository(db);
    const decisionAt = "2026-07-17T14:40:00.000Z";
    const now = new Date("2026-07-17T14:56:00.000Z");
    const lane = repository.ensureActiveLane(decisionAt);
    const outgoingPosition: StockPaperPosition = {
      id: "position-aapl",
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
      peakPriceUsd: 101,
      stopPriceUsd: 92,
      takeProfitPriceUsd: 112,
      scoreAtEntry: 70,
      openedAt: "2026-07-17T14:00:00.000Z",
      updatedAt: decisionAt
    };
    const decision = evaluateStockPaperRotationDecision({
      laneId: lane.id,
      account: { navUsd: 141, cashUsd: 41, deployedUsd: 100 },
      positions: [outgoingPosition],
      candidates: [candidate("AAPL", 60, decisionAt), candidate("LCID", 80, decisionAt)],
      sourcePolicy: lane.policy,
      phase: "REGULAR",
      feed: "IEX",
      decisionAt
    });
    expect(decision.status).toBe("ROTATE");
    repository.commitRotationAnalysis({ laneId: lane.id, decisions: [decision] });

    const barRequests: string[][] = [];
    const snapshotRequests: string[][] = [];
    const aaplBars = completeBars(decisionAt, 100, -0.1);
    const lcidBars = completeBars(decisionAt, 100, 0.2);
    const provider = quietProvider(now, (symbols) => {
      barRequests.push([...symbols]);
      return new Map(symbols.map((symbol) => [
        symbol,
        symbol === "AAPL" ? aaplBars : symbol === "LCID" ? lcidBars : []
      ]));
    });
    vi.spyOn(provider, "getSnapshots").mockImplementation(async (symbols) => {
      snapshotRequests.push([...symbols]);
      return [];
    });
    const engine = new StockPaperEngine(repository, {
      mode: () => "PAPER",
      credentials: () => ({ apiKey: "paper-api-key", secretKey: "paper-secret-key" }),
      provider: () => provider,
      now: () => now
    });

    await engine.enqueueCycle();

    expect(snapshotRequests.every((symbols) =>
      !symbols.includes("AAPL") && !symbols.includes("LCID")
    )).toBe(true);
    expect(barRequests.some((symbols) =>
      symbols.includes("AAPL") && symbols.includes("LCID")
    )).toBe(true);
    expect(repository.recentRotationOutcomes(lane.id)).toContainEqual(expect.objectContaining({
      decisionId: decision.id,
      horizonMinutes: 15,
      status: "LABELED",
      outgoingFirstBarAt: "2026-07-17T14:41:00.000Z",
      outgoingLastBarAt: "2026-07-17T14:55:00.000Z",
      incomingFirstBarAt: "2026-07-17T14:41:00.000Z",
      incomingLastBarAt: "2026-07-17T14:55:00.000Z"
    }));
  });
});
