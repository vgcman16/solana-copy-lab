import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SOL_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  USDC_MINT,
  type AutonomousPaperEvent,
  type ModeState,
  type AutonomousPaperPolicy,
  type AutonomousPaperPosition,
  type QuoteRequest,
  type QuoteSnapshot
} from "@copylab/shared";
import type {
  JupiterMarketStats,
  JupiterMarketTokenSnapshot,
  JupiterMarketUniverseSnapshot
} from "@copylab/providers";
import type { CopyLabDatabase } from "../src/database.js";
import { openDatabase } from "../src/database.js";
import {
  AUTONOMOUS_PAPER_V3_POLICY,
  AUTONOMOUS_PAPER_V3_POLICY_VERSION,
  AUTONOMOUS_PAPER_V4_POLICY,
  AUTONOMOUS_PAPER_V4_POLICY_VERSION,
  AUTONOMOUS_PAPER_V5_POLICY,
  AUTONOMOUS_PAPER_V5_POLICY_VERSION,
  AUTONOMOUS_PAPER_V6_POLICY,
  AUTONOMOUS_PAPER_V6_POLICY_VERSION,
  AUTONOMOUS_PAPER_V7_POLICY,
  AUTONOMOUS_PAPER_V7_POLICY_VERSION,
  AUTONOMOUS_PAPER_V9_POLICY,
  AUTONOMOUS_PAPER_V9_POLICY_VERSION,
  AUTONOMOUS_PAPER_POLICY_VERSION,
  LEGACY_AUTONOMOUS_PAPER_POLICY,
  LEGACY_AUTONOMOUS_PAPER_POLICY_VERSION
} from "../src/autonomous-paper-policy.js";
import {
  AutonomousPaperEngine,
  autonomousMarketSnapshotFromJupiter
} from "../src/autonomous-paper.js";
import { Repository } from "../src/repository.js";

const MINT_A = "autonomous-momentum-a";
const MINT_B = "autonomous-momentum-b";

function stats(overrides: Partial<JupiterMarketStats> = {}): JupiterMarketStats {
  return {
    priceChange: 4,
    liquidityChange: 2,
    volumeChange: 10,
    buyVolume: 100_000,
    sellVolume: 50_000,
    buyOrganicVolume: 40_000,
    sellOrganicVolume: 10_000,
    numBuys: 500,
    numSells: 200,
    numTraders: 400,
    numOrganicBuyers: 200,
    numNetBuyers: 100,
    ...overrides
  };
}

function token(
  mint: string,
  updatedAt: string,
  overrides: Partial<JupiterMarketTokenSnapshot> = {}
): JupiterMarketTokenSnapshot {
  return {
    mint,
    name: `Token ${mint}`,
    symbol: mint === MINT_A ? "MOMA" : "MOMB",
    decimals: 6,
    tokenProgram: TOKEN_PROGRAM_ID,
    createdAt: "2026-06-01T00:00:00.000Z",
    firstPoolAt: "2026-06-01T00:00:00.000Z",
    holderCount: 5_000,
    fdvUsd: 30_000_000,
    marketCapUsd: 20_000_000,
    priceUsd: 0.5,
    liquidityUsd: 2_000_000,
    stats5m: stats(),
    stats1h: stats({
      priceChange: 14,
      buyVolume: 500_000,
      sellVolume: 250_000,
      buyOrganicVolume: 175_000,
      sellOrganicVolume: 75_000
    }),
    stats6h: stats({ priceChange: 20 }),
    stats24h: stats({ priceChange: 30, buyVolume: 3_000_000, sellVolume: 2_000_000 }),
    organicScore: 90,
    organicScoreLabel: "high",
    verified: true,
    tags: [],
    suspicious: false,
    mintAuthorityDisabled: true,
    freezeAuthorityDisabled: true,
    topHoldersPercent: 20,
    updatedAt,
    categoryRanks: { topTraded24h: 1, topTrending1h: 1 },
    ...overrides
  };
}

function sol(updatedAt: string): JupiterMarketTokenSnapshot {
  return token(SOL_MINT, updatedAt, {
    symbol: "SOL",
    stats1h: stats({ priceChange: 1 }),
    stats6h: stats({ priceChange: 2 }),
    categoryRanks: {}
  });
}

function quoteFor(request: QuoteRequest, at: Date, sellOutputUsd = 27.9): QuoteSnapshot {
  const buying = request.inputMint === USDC_MINT;
  const requestedUsd = buying
    ? Number(BigInt(request.inputAmountAtomic)) / 1_000_000
    : 28;
  const sellOutputAtomic = Math.floor(sellOutputUsd * 1_000_000).toString();
  const sellMinimumAtomic = Math.floor(Math.max(0.01, sellOutputUsd - 0.1) * 1_000_000).toString();
  return {
    requestId: `autonomous-${buying ? "buy" : "sell"}`,
    quotedAt: at.toISOString(),
    inputMint: request.inputMint,
    outputMint: request.outputMint,
    inputAmountAtomic: request.inputAmountAtomic,
    outputAmountAtomic: buying ? "60000000" : sellOutputAtomic,
    // The engine must use this conservative amount for its position and the
    // exact full-position sell quote.
    minimumOutputAtomic: buying ? "55000000" : sellMinimumAtomic,
    inputUsd: buying ? requestedUsd : 27.95,
    outputUsd: buying ? 28.1 : sellOutputUsd,
    priceImpactPercent: 0.4,
    slippageBps: 50,
    feeBps: 10,
    signatureFeeLamports: 5_000,
    prioritizationFeeLamports: 0,
    rentFeeLamports: 0,
    router: "quote-only-test"
  };
}

describe("isolated autonomous high-risk PAPER engine", () => {
  let db: CopyLabDatabase | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  function setupWithPolicy(
    policyVersion: string,
    policy: Readonly<AutonomousPaperPolicy>
  ) {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    repository.createAutonomousPaperLane({
      id: "autonomous-lane",
      policyVersion,
      policy: { ...policy },
      initialNavUsd: 141,
      startedAt: "2026-07-14T12:00:00.000Z"
    });
    repository.initializeAutonomousPaperAccount("autonomous-lane", "2026-07-14T12:00:00.000Z");
    let now = new Date("2026-07-14T12:00:00.000Z");
    let mode: ModeState = "PAPER";
    let tokens: JupiterMarketTokenSnapshot[] = [token(MINT_A, "2026-07-14T11:59:30.000Z")];
    let sellOutputUsd = 27.9;
    let sellOutputTracksLatestBuy = false;
    let latestBuyUsd = 27.9;
    let quoteError = false;
    let universeError = false;
    let lookupError = false;
    let newEntriesAllowed = true;
    let inFlightQuoteCalls = 0;
    let maximumConcurrentQuoteCalls = 0;
    let solUpdatedAt: string | undefined;
    let exactTokens: JupiterMarketTokenSnapshot[] = [];
    const order: string[] = [];
    const fetchSignalUniverse = vi.fn(async (): Promise<JupiterMarketUniverseSnapshot> => {
      order.push("universe");
      if (universeError) throw new Error("universe unavailable");
      return { capturedAt: now.toISOString(), tokens };
    });
    const lookupMints = vi.fn(async (mints: readonly string[]) => {
      order.push(`lookup:${mints[0]}`);
      if (lookupError) throw new Error("mint lookup unavailable");
      return mints.map((mint) => mint === SOL_MINT
        ? sol(solUpdatedAt ?? new Date(now.getTime() - 30_000).toISOString())
        : exactTokens.find((candidate) => candidate.mint === mint) ??
          tokens.find((candidate) => candidate.mint === mint) ??
          token(mint, new Date(now.getTime() - 30_000).toISOString()));
    });
    const quote = vi.fn(async (request: QuoteRequest) => {
      order.push(`quote:${request.inputMint === USDC_MINT ? "buy" : "sell"}`);
      inFlightQuoteCalls += 1;
      maximumConcurrentQuoteCalls = Math.max(maximumConcurrentQuoteCalls, inFlightQuoteCalls);
      try {
        // Yield once so this harness detects a Promise.all burst instead of
        // treating an immediately resolved mock as sequential provider work.
        await Promise.resolve();
        if (quoteError) throw new Error("quote unavailable");
        if (request.inputMint === USDC_MINT) {
          latestBuyUsd = Number(BigInt(request.inputAmountAtomic)) / 1_000_000;
        }
        return quoteFor(
          request,
          now,
          request.inputMint !== USDC_MINT && sellOutputTracksLatestBuy
            ? latestBuyUsd
            : sellOutputUsd
        );
      } finally {
        inFlightQuoteCalls -= 1;
      }
    });
    const options = {
      mode: () => mode,
      newEntriesAllowed: () => newEntriesAllowed,
      fetchSignalUniverse,
      lookupMints,
      quote,
      solPriceUsd: () => 200,
      now: () => now
    };
    const createEngine = () => new AutonomousPaperEngine(repository, options);
    const engine = createEngine();
    return {
      repository,
      engine,
      quote,
      lookupMints,
      fetchSignalUniverse,
      order,
      setNow(value: string) { now = new Date(value); },
      setMode(value: ModeState) { mode = value; },
      setTokens(value: JupiterMarketTokenSnapshot[]) { tokens = value; },
      setExactTokens(value: JupiterMarketTokenSnapshot[]) { exactTokens = value; },
      setSellOutput(value: number) { sellOutputUsd = value; },
      setSellOutputTracksLatestBuy(value: boolean) { sellOutputTracksLatestBuy = value; },
      setQuoteError(value: boolean) { quoteError = value; },
      setUniverseError(value: boolean) { universeError = value; },
      setLookupError(value: boolean) { lookupError = value; },
      setNewEntriesAllowed(value: boolean) { newEntriesAllowed = value; },
      maximumConcurrentQuoteCalls() { return maximumConcurrentQuoteCalls; },
      setSolUpdatedAt(value: string | undefined) { solUpdatedAt = value; },
      createEngine
    };
  }

  function setupLegacy() {
    return setupWithPolicy(
      LEGACY_AUTONOMOUS_PAPER_POLICY_VERSION,
      LEGACY_AUTONOMOUS_PAPER_POLICY
    );
  }

  function setupCurrentV4(policy: Readonly<AutonomousPaperPolicy> = AUTONOMOUS_PAPER_V4_POLICY) {
    return setupWithPolicy(
      AUTONOMOUS_PAPER_V4_POLICY_VERSION,
      policy
    );
  }

  function setupCurrentV5(policy: Readonly<AutonomousPaperPolicy> = AUTONOMOUS_PAPER_V5_POLICY) {
    return setupWithPolicy(
      AUTONOMOUS_PAPER_V5_POLICY_VERSION,
      policy
    );
  }

  function setupCurrentV6(policy: Readonly<AutonomousPaperPolicy> = AUTONOMOUS_PAPER_V6_POLICY) {
    return setupWithPolicy(AUTONOMOUS_PAPER_V6_POLICY_VERSION, policy);
  }

  function setupCurrentV7(policy: Readonly<AutonomousPaperPolicy> = AUTONOMOUS_PAPER_V7_POLICY) {
    return setupWithPolicy(AUTONOMOUS_PAPER_V7_POLICY_VERSION, policy);
  }

  function setupCurrentV9(policy: Readonly<AutonomousPaperPolicy> = AUTONOMOUS_PAPER_V9_POLICY) {
    return setupWithPolicy(AUTONOMOUS_PAPER_V9_POLICY_VERSION, policy);
  }

  function setupV3() {
    return setupWithPolicy(
      AUTONOMOUS_PAPER_V3_POLICY_VERSION,
      AUTONOMOUS_PAPER_V3_POLICY
    );
  }

  function seedOpenPosition(run: ReturnType<typeof setupCurrentV7>): AutonomousPaperPosition {
    const position: AutonomousPaperPosition = {
      id: "autonomous-position-upgrade-drain",
      laneId: "autonomous-lane",
      entryDecisionId: "decision-upgrade-drain-entry",
      mint: MINT_A,
      symbol: "MOMA",
      initialAmountAtomic: "55000000",
      remainingAmountAtomic: "55000000",
      entryCostUsd: 28.2,
      remainingCostUsd: 28.2,
      lastExecutableValueUsd: 27.9,
      peakExecutableValueUsd: 27.9,
      entryPriceUsd: 1,
      lastPriceUsd: 1,
      stopPriceUsd: 0.88,
      takeProfitPriceUsd: 1.3,
      weakMomentumSamples: 0,
      status: "OPEN",
      openedAt: "2026-07-14T12:00:00.000Z",
      updatedAt: "2026-07-14T12:00:00.000Z"
    };
    run.repository.upsertAutonomousPaperPosition(position);
    const account = run.repository.getAutonomousPaperAccount("autonomous-lane")!;
    run.repository.upsertAutonomousPaperAccount({
      ...account,
      cashUsd: 112.8,
      navUsd: 140.7,
      peakNavUsd: 141,
      deployedUsd: 28.2,
      unrealizedPnlUsd: -0.3,
      maxDrawdownPercent: 0.3,
      openPositions: 1,
      pricingComplete: true,
      updatedAt: "2026-07-14T12:00:00.000Z"
    });
    return position;
  }

  it("drains v7 through normal marks and exits without any new-entry discovery", async () => {
    const run = setupCurrentV7();
    seedOpenPosition(run);
    run.repository.requestAutonomousPaperUpgradeDrain({
      laneId: "autonomous-lane",
      fromPolicyVersion: AUTONOMOUS_PAPER_V7_POLICY_VERSION,
      toPolicyVersion: AUTONOMOUS_PAPER_POLICY_VERSION
    });

    run.setNow("2026-07-14T12:03:00.000Z");
    await run.engine.enqueueCycle();

    expect(run.fetchSignalUniverse).not.toHaveBeenCalled();
    expect(run.quote.mock.calls.filter(([request]) => request.inputMint === USDC_MINT))
      .toHaveLength(0);
    expect(run.repository.autonomousPaperDashboard()).toMatchObject({
      lane: { status: "ACTIVE", policyVersion: AUTONOMOUS_PAPER_V7_POLICY_VERSION },
      account: { openPositions: 1 },
      positions: [expect.objectContaining({ id: "autonomous-position-upgrade-drain", status: "OPEN" })],
      upgradeDrain: {
        fromPolicyVersion: AUTONOMOUS_PAPER_V7_POLICY_VERSION,
        toPolicyVersion: AUTONOMOUS_PAPER_POLICY_VERSION
      }
    });

    run.setSellOutput(5);
    run.setNow("2026-07-14T12:06:00.000Z");
    run.setTokens([token(MINT_A, "2026-07-14T12:05:30.000Z")]);
    await run.engine.enqueueCycle();

    expect(run.repository.autonomousPaperDashboard()).toMatchObject({
      account: { openPositions: 0, completedTrades: 1 },
      positions: [],
      recentTrades: [expect.objectContaining({
        positionId: "autonomous-position-upgrade-drain",
        exitReason: "STOP_LOSS"
      })]
    });
    expect(run.fetchSignalUniverse).not.toHaveBeenCalled();

    const providerCallsAfterExit = run.quote.mock.calls.length;
    run.setNow("2026-07-14T12:09:00.000Z");
    await run.engine.enqueueCycle();
    expect(run.fetchSignalUniverse).not.toHaveBeenCalled();
    expect(run.quote).toHaveBeenCalledTimes(providerCallsAfterExit);
    expect(run.repository.autonomousPaperDashboard().positions).toEqual([]);
  });

  it("fails closed when an upgrade drain arrives during the first entry quote", async () => {
    const run = setupCurrentV7();
    run.quote.mockImplementation(async (request) => {
      run.repository.requestAutonomousPaperUpgradeDrain({
        laneId: "autonomous-lane",
        fromPolicyVersion: AUTONOMOUS_PAPER_V7_POLICY_VERSION,
        toPolicyVersion: AUTONOMOUS_PAPER_POLICY_VERSION
      });
      return quoteFor(request, new Date("2026-07-14T12:00:00.000Z"));
    });

    await run.engine.enqueueCycle();

    expect(run.quote).toHaveBeenCalledTimes(1);
    expect(run.repository.autonomousPaperDashboard()).toMatchObject({
      account: { cashUsd: 141, navUsd: 141, openPositions: 0 },
      positions: []
    });
    expect(run.repository.latestAutonomousPaperDecision("autonomous-lane", MINT_A))
      .toMatchObject({
        action: "BUY",
        outcome: "FAILED",
        reasons: ["POLICY_UPGRADE_DRAIN_ACTIVE"]
      });
  });

  it("lets PAPER exits continue while an operational hold blocks every new entry", async () => {
    const run = setupCurrentV7();
    seedOpenPosition(run);
    run.setNewEntriesAllowed(false);
    run.setSellOutput(5);
    run.setTokens([
      token(MINT_A, "2026-07-14T12:02:30.000Z"),
      token(MINT_B, "2026-07-14T12:02:30.000Z")
    ]);
    run.setNow("2026-07-14T12:03:00.000Z");

    await run.engine.enqueueCycle();

    expect(run.repository.autonomousPaperDashboard()).toMatchObject({
      account: { openPositions: 0, completedTrades: 1 },
      positions: [],
      recentTrades: [expect.objectContaining({
        positionId: "autonomous-position-upgrade-drain",
        exitReason: "STOP_LOSS"
      })]
    });
    expect(run.fetchSignalUniverse).toHaveBeenCalledTimes(1);
    expect(run.quote.mock.calls.filter(([request]) => request.inputMint === USDC_MINT))
      .toHaveLength(0);
    expect(run.repository.latestAutonomousPaperDecision("autonomous-lane", MINT_B))
      .toMatchObject({
        action: "REJECT",
        outcome: "REJECTED",
        reasons: ["OPERATIONAL_ENTRY_PAUSE_ACTIVE"]
      });
  });

  it("fails closed when an operational hold arrives during the first entry quote", async () => {
    const run = setupCurrentV7();
    run.quote.mockImplementation(async (request) => {
      run.setNewEntriesAllowed(false);
      return quoteFor(request, new Date("2026-07-14T12:00:00.000Z"));
    });

    await run.engine.enqueueCycle();

    expect(run.quote).toHaveBeenCalledTimes(1);
    expect(run.repository.autonomousPaperDashboard()).toMatchObject({
      account: { cashUsd: 141, navUsd: 141, openPositions: 0 },
      positions: []
    });
    expect(run.repository.latestAutonomousPaperDecision("autonomous-lane", MINT_A))
      .toMatchObject({
        action: "BUY",
        outcome: "FAILED",
        reasons: ["OPERATIONAL_ENTRY_PAUSE_ACTIVE"]
      });
  });

  it("starts no later provider work when a drain arrives during universe discovery", async () => {
    const run = setupCurrentV7();
    run.fetchSignalUniverse.mockImplementation(async () => {
      run.repository.requestAutonomousPaperUpgradeDrain({
        laneId: "autonomous-lane",
        fromPolicyVersion: AUTONOMOUS_PAPER_V7_POLICY_VERSION,
        toPolicyVersion: AUTONOMOUS_PAPER_POLICY_VERSION
      });
      return {
        capturedAt: "2026-07-14T12:00:00.000Z",
        tokens: [token(MINT_A, "2026-07-14T11:59:30.000Z")]
      };
    });

    await run.engine.enqueueCycle();

    expect(run.fetchSignalUniverse).toHaveBeenCalledTimes(1);
    expect(run.lookupMints).not.toHaveBeenCalled();
    expect(run.quote).not.toHaveBeenCalled();
    expect(run.repository.autonomousPaperDashboard()).toMatchObject({
      account: { cashUsd: 141, navUsd: 141, openPositions: 0 },
      positions: []
    });
  });

  it("converts Jupiter evidence without turning absent data into reassuring zeros", () => {
    const incomplete = token(MINT_A, "2026-07-14T11:59:30.000Z");
    delete incomplete.holderCount;
    delete incomplete.topHoldersPercent;
    delete incomplete.stats5m;
    const converted = autonomousMarketSnapshotFromJupiter(
      incomplete,
      "2026-07-14T12:00:00.000Z"
    );
    expect(converted).toMatchObject({
      holderCount: -1,
      topHoldersPercent: -1,
      organicBuyShare5m: -1,
      organicVolume5mUsd: -1
    });
  });

  it("admits a canonical Token-2022 quote-only BUY only in v4", async () => {
    const v4 = setupCurrentV4();
    v4.setTokens([token(MINT_A, "2026-07-14T11:59:30.000Z", {
      tokenProgram: TOKEN_2022_PROGRAM_ID
    })]);
    await v4.engine.enqueueCycle();

    expect(v4.repository.latestAutonomousPaperDecision("autonomous-lane", MINT_A)).toMatchObject({
      action: "BUY",
      outcome: "SIMULATED"
    });
    expect(v4.quote).toHaveBeenCalledTimes(2);
    expect(v4.repository.listAutonomousPaperPositions({
      laneId: "autonomous-lane",
      openOnly: true,
      limit: 10
    })).toHaveLength(1);
    expect(v4.repository.listPositions()).toEqual([]);
    expect(v4.repository.listExecutions()).toEqual([]);

    db?.close();
    db = undefined;
    const v3 = setupV3();
    v3.setTokens([token(MINT_A, "2026-07-14T11:59:30.000Z", {
      tokenProgram: TOKEN_2022_PROGRAM_ID
    })]);
    await v3.engine.enqueueCycle();

    expect(v3.repository.latestAutonomousPaperDecision("autonomous-lane", MINT_A)).toMatchObject({
      action: "REJECT",
      outcome: "REJECTED",
      reasons: expect.arrayContaining(["UNSUPPORTED_TOKEN_PROGRAM"])
    });
    expect(v3.quote).not.toHaveBeenCalled();
    expect(v3.repository.listAutonomousPaperPositions({ laneId: "autonomous-lane", limit: 10 }))
      .toEqual([]);
    expect(v3.repository.listPositions()).toEqual([]);
    expect(v3.repository.listExecutions()).toEqual([]);
  });

  it("v7 removes the flat cap, downsizes from a quote probe, and persists contextual cold-start evidence", async () => {
    const run = setupCurrentV7();
    run.quote.mockImplementation(async (request) => {
      const buying = request.inputMint === USDC_MINT;
      const inputUi = Number(BigInt(request.inputAmountAtomic)) / 1_000_000;
      const tokenAmountAtomic = Math.floor(inputUi * 2 * 1_000_000).toString();
      const sellUsd = inputUi / 2;
      return {
        requestId: `adaptive-${run.quote.mock.calls.length}`,
        quotedAt: "2026-07-14T12:00:00.000Z",
        inputMint: request.inputMint,
        outputMint: request.outputMint,
        inputAmountAtomic: request.inputAmountAtomic,
        outputAmountAtomic: buying
          ? tokenAmountAtomic
          : Math.floor(sellUsd * 0.995 * 1_000_000).toString(),
        minimumOutputAtomic: buying
          ? tokenAmountAtomic
          : Math.floor(sellUsd * 0.99 * 1_000_000).toString(),
        inputUsd: buying ? inputUi : sellUsd,
        outputUsd: buying ? inputUi : sellUsd * 0.995,
        priceImpactPercent: 0.25,
        slippageBps: 50,
        feeBps: 10,
        signatureFeeLamports: 5_000,
        prioritizationFeeLamports: 0,
        rentFeeLamports: 0,
        router: "adaptive-quote-only-test"
      };
    });

    await run.engine.enqueueCycle();

    expect(run.quote).toHaveBeenCalledTimes(4);
    const firstBuy = run.quote.mock.calls[0]![0];
    const firstSell = run.quote.mock.calls[1]![0];
    const finalBuy = run.quote.mock.calls[2]![0];
    const finalSell = run.quote.mock.calls[3]![0];
    expect(firstBuy.inputMint).toBe(USDC_MINT);
    expect(firstSell.inputAmountAtomic).toBe(
      Math.floor(Number(BigInt(firstBuy.inputAmountAtomic)) / 1_000_000 * 2 * 1_000_000).toString()
    );
    expect(BigInt(finalBuy.inputAmountAtomic)).toBeLessThan(BigInt(firstBuy.inputAmountAtomic));
    expect(finalSell.inputAmountAtomic).toBe(
      Math.floor(Number(BigInt(finalBuy.inputAmountAtomic)) / 1_000_000 * 2 * 1_000_000).toString()
    );

    const dashboard = run.repository.autonomousPaperDashboard();
    const buy = dashboard.recentDecisions.find((value) => value.action === "BUY");
    expect(buy).toMatchObject({
      outcome: "SIMULATED",
      reasons: expect.arrayContaining(["ADAPTIVE_HIGH_RISK_SIZE"]),
      sizing: {
        version: "adaptive-sizing-v2",
        minimumUsd: 5,
        maximumAvailableUsd: 49.35,
        contextualReward: {
          active: false,
          preQuoteUpperBound: false,
          comparableTrades: 0,
          multiplier: 1
        },
        calibration: {
          sampleCount: 0,
          coldStart: true,
          multiplier: 1,
          averageReward: 0,
          rewardMultiplier: 1
        }
      }
    });
    expect(buy!.sizing!.sizeUsd).toBe(buy!.modeledPositionUsd);
    expect(finalBuy.inputAmountAtomic).toBe(
      BigInt(Math.floor(buy!.sizing!.sizeUsd * 1_000_000)).toString()
    );
    expect(buy!.sizing!.componentScores.quoteQuality).toBeLessThan(1);
    expect(buy!.sizing!.explanationCodes).toContain("QUOTE_QUALITY_REDUCTION");
    expect(dashboard.positions).toEqual([
      expect.objectContaining({
        entryLearningContext: expect.objectContaining({
          version: "contextual-reward-v1",
          momentum: buy!.sizing!.componentScores.momentum,
          categoryRank: buy!.sizing!.componentScores.categoryRank,
          liquidityFlow: buy!.sizing!.componentScores.liquidityFlow,
          quoteQuality: buy!.sizing!.componentScores.quoteQuality,
          projectedRoundTripCostPercent: buy!.projectedRoundTripCostPercent
        })
      })
    ]);
    const entryContext = dashboard.positions[0]!.entryLearningContext;
    run.setNow("2026-07-14T12:03:00.000Z");
    run.setTokens([token(MINT_A, "2026-07-14T12:02:30.000Z")]);
    run.quote.mockImplementation(async (request) => quoteFor(
      request,
      new Date("2026-07-14T12:03:00.000Z"),
      5
    ));
    await run.engine.enqueueCycle();
    expect(run.repository.autonomousPaperDashboard()).toMatchObject({
      positions: [],
      recentTrades: [expect.objectContaining({
        mint: MINT_A,
        entryLearningContext: entryContext
      })]
    });
    expect(run.repository.listExecutions()).toEqual([]);
    expect(run.repository.listPositions()).toEqual([]);
  });

  it("v8 deterministically explores a static-safe soft-flow near miss while v7 rejects it", async () => {
    const softNearMiss = token(MINT_A, "2026-07-14T11:59:30.000Z", {
      stats1h: stats({
        priceChange: 14,
        buyVolume: 500_000,
        sellVolume: 250_000,
        buyOrganicVolume: 40_000,
        sellOrganicVolume: 60_000
      })
    });
    const v8 = setupCurrentV9();
    v8.setTokens([softNearMiss]);
    await v8.engine.enqueueCycle();

    expect(v8.quote).toHaveBeenCalled();
    expect(v8.repository.latestAutonomousPaperDecision("autonomous-lane", MINT_A))
      .toMatchObject({
        action: "BUY",
        outcome: "SIMULATED",
        reasons: expect.arrayContaining([
          "CONTROLLED_EXPLORATION",
          "WAIVED_WEAK_ONE_HOUR_ORGANIC_BUYING",
          "QUOTE_CEILINGS_PASSED"
        ])
      });
    expect(v8.repository.listAutonomousPaperPositions({
      laneId: "autonomous-lane",
      openOnly: true,
      limit: 10
    })[0]?.entryLearningContext).toMatchObject({
      version: "contextual-reward-v2",
      strategyArm: "CONTROLLED_EXPLORATION",
      waivedReasonCount: 1
    });
    expect(v8.repository.listExecutions()).toEqual([]);
    expect(v8.repository.listPositions()).toEqual([]);

    db?.close();
    db = undefined;
    const v7 = setupCurrentV7();
    v7.setTokens([softNearMiss]);
    await v7.engine.enqueueCycle();

    expect(v7.quote).not.toHaveBeenCalled();
    expect(v7.repository.latestAutonomousPaperDecision("autonomous-lane", MINT_A))
      .toMatchObject({
        action: "REJECT",
        reasons: expect.arrayContaining(["WEAK_ONE_HOUR_ORGANIC_BUYING"])
      });
  });

  it("v8 never waives static token safety for controlled exploration", async () => {
    const run = setupCurrentV9();
    run.setTokens([token(MINT_A, "2026-07-14T11:59:30.000Z", {
      mintAuthorityDisabled: false,
      stats1h: stats({
        priceChange: 14,
        buyVolume: 500_000,
        sellVolume: 250_000,
        buyOrganicVolume: 40_000,
        sellOrganicVolume: 60_000
      })
    })]);

    await run.engine.enqueueCycle();

    expect(run.quote).not.toHaveBeenCalled();
    expect(run.repository.latestAutonomousPaperDecision("autonomous-lane", MINT_A))
      .toMatchObject({
        action: "REJECT",
        reasons: expect.arrayContaining(["MINT_AUTHORITY_ENABLED"])
      });
  });

  it("persists a large rejection universe through one equivalent terminal candidate batch", async () => {
    const run = setupCurrentV9();
    const candidates = Array.from({ length: 251 }, (_, index) => token(
      `candidate-batch-${index.toString().padStart(3, "0")}`,
      "2026-07-14T11:59:30.000Z",
      { mintAuthorityDisabled: false }
    ));
    run.setTokens(candidates);
    const batch = vi.spyOn(run.repository, "commitAutonomousPaperCandidateEvents");
    const genericEventHistory = vi.spyOn(run.repository, "listAutonomousPaperEvents");
    const latestTrade = vi.spyOn(run.repository, "latestAutonomousPaperTrade");

    let cycleCompleted = false;
    let macrotaskSawCycleCompleted: boolean | undefined;
    const macrotaskTurn = new Promise<void>((resolve) => {
      run.fetchSignalUniverse.mockImplementationOnce(async () => {
        // This callback is queued before the synchronous rejection scan. It
        // can run before completion only when the scan cooperatively yields a
        // Node macrotask turn at a candidate boundary.
        setImmediate(() => {
          macrotaskSawCycleCompleted = cycleCompleted;
          resolve();
        });
        return {
          capturedAt: "2026-07-14T12:00:00.000Z",
          tokens: candidates
        };
      });
    });

    const cycle = run.engine.enqueueCycle().finally(() => {
      cycleCompleted = true;
    });
    await Promise.all([cycle, macrotaskTurn]);

    expect(macrotaskSawCycleCompleted).toBe(false);
    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls[0]![0]).toHaveLength(251);
    expect(batch.mock.calls[0]![0].every((event) =>
      event.kind === "DECISION" && event.action === "REJECT" && event.outcome === "REJECTED"
    )).toBe(true);
    const decisions = run.repository.listAutonomousPaperEvents({
      laneId: "autonomous-lane",
      kind: "DECISION",
      limit: 500
    });
    expect(decisions).toHaveLength(251);
    expect(decisions.every((event) =>
      event.outcome === "REJECTED" &&
      event.decision?.reasons.includes("MINT_AUTHORITY_ENABLED") === true
    )).toBe(true);
    expect(run.repository.latestAutonomousPaperDecision(
      "autonomous-lane",
      "candidate-batch-127"
    )).toMatchObject({
      action: "REJECT",
      outcome: "REJECTED",
      reasons: expect.arrayContaining(["MINT_AUTHORITY_ENABLED"]),
      snapshot: expect.objectContaining({ mint: "candidate-batch-127" })
    });
    expect(run.repository.listClaimedAutonomousPaperEvents("autonomous-lane")).toEqual([]);
    expect(run.repository.getAutonomousPaperAccount("autonomous-lane")).toMatchObject({
      navUsd: 141,
      openPositions: 0
    });
    expect(latestTrade).toHaveBeenCalledTimes(251);
    expect(genericEventHistory.mock.calls.some(([options]) =>
      options.kind === "TRADE" && options.mint !== undefined
    )).toBe(false);
    expect(run.repository.listExecutions()).toEqual([]);
    expect(run.quote).not.toHaveBeenCalled();
  });

  it("rechecks exact PAPER authorization after each cooperative candidate turn", async () => {
    const run = setupCurrentV9();
    const candidates = [
      token("candidate-yield-a", "2026-07-14T11:59:30.000Z", {
        mintAuthorityDisabled: false
      }),
      token("candidate-yield-b", "2026-07-14T11:59:30.000Z", {
        mintAuthorityDisabled: false
      })
    ];
    run.fetchSignalUniverse.mockImplementationOnce(async () => {
      setImmediate(() => run.setMode("MANUAL_LIVE"));
      return {
        capturedAt: "2026-07-14T12:00:00.000Z",
        tokens: candidates
      };
    });

    await run.engine.enqueueCycle();

    const decisions = run.repository.listAutonomousPaperEvents({
      laneId: "autonomous-lane",
      kind: "DECISION",
      limit: 10
    });
    expect(decisions).toEqual([
      expect.objectContaining({
        mint: "candidate-yield-a",
        action: "REJECT",
        outcome: "REJECTED",
        decision: expect.objectContaining({
          reasons: expect.arrayContaining(["MINT_AUTHORITY_ENABLED"])
        })
      })
    ]);
    expect(run.repository.latestAutonomousPaperDecision(
      "autonomous-lane",
      "candidate-yield-b"
    )).toBeUndefined();
    expect(run.repository.listAutonomousPaperEvents({
      laneId: "autonomous-lane",
      kind: "NAV_MARK",
      limit: 10
    }).find((event) => event.eventKey.startsWith("autonomous-cycle-v1:")))
      .toMatchObject({
        outcome: "FAILED",
        reason: "Exact PAPER mode or the active autonomous lane ended during candidate scanning."
      });
    expect(run.repository.getAutonomousPaperAccount("autonomous-lane")).toMatchObject({
      navUsd: 141,
      openPositions: 0
    });
    expect(run.repository.listExecutions()).toEqual([]);
    expect(run.quote).not.toHaveBeenCalled();
  });

  it("flushes already-created candidate evidence when a later candidate aborts the root cycle", async () => {
    const run = setupCurrentV9();
    run.setTokens([
      token("candidate-failure-a", "2026-07-14T11:59:30.000Z", {
        mintAuthorityDisabled: false
      }),
      token("candidate-failure-b", "2026-07-14T11:59:30.000Z", {
        mintAuthorityDisabled: false
      })
    ]);
    const originalList = run.repository.listAutonomousPaperPositions.bind(run.repository);
    let listCalls = 0;
    vi.spyOn(run.repository, "listAutonomousPaperPositions").mockImplementation((options) => {
      listCalls += 1;
      if (listCalls === 3) throw new Error("forced later candidate failure");
      return originalList(options);
    });
    const batch = vi.spyOn(run.repository, "commitAutonomousPaperCandidateEvents");

    await expect(run.engine.enqueueCycle()).rejects.toThrow("forced later candidate failure");

    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls[0]![0]).toHaveLength(1);
    expect(run.repository.listAutonomousPaperEvents({
      laneId: "autonomous-lane",
      kind: "DECISION",
      limit: 10
    })).toEqual([
      expect.objectContaining({
        action: "REJECT",
        outcome: "REJECTED",
        decision: expect.objectContaining({
          reasons: expect.arrayContaining(["MINT_AUTHORITY_ENABLED"])
        })
      })
    ]);
    expect(run.repository.listAutonomousPaperEvents({
      laneId: "autonomous-lane",
      kind: "NAV_MARK",
      limit: 10
    })[0]).toMatchObject({
      outcome: "FAILED",
      reason: "forced later candidate failure"
    });
    expect(run.repository.listClaimedAutonomousPaperEvents("autonomous-lane")).toEqual([]);
    expect(run.repository.listExecutions()).toEqual([]);
  });

  it("retains batched WAIT_NEXT_SAMPLE confirmation while BUY stays on its material path", async () => {
    const run = setupCurrentV9({
      ...AUTONOMOUS_PAPER_V9_POLICY,
      confirmationSamples: 2
    });
    const batch = vi.spyOn(run.repository, "commitAutonomousPaperCandidateEvents");

    await run.engine.enqueueCycle();

    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls[0]![0]).toEqual([
      expect.objectContaining({
        action: "OBSERVE",
        outcome: "ANALYSIS_ONLY",
        decision: expect.objectContaining({
          reasons: ["SIGNAL_PASSED", "WAIT_NEXT_SAMPLE"]
        })
      })
    ]);
    expect(run.quote).not.toHaveBeenCalled();

    run.setNow("2026-07-14T12:03:00.000Z");
    run.setTokens([token(MINT_A, "2026-07-14T12:02:30.000Z")]);
    await run.engine.enqueueCycle();

    expect(batch).toHaveBeenCalledTimes(1);
    expect(run.repository.latestAutonomousPaperDecision("autonomous-lane", MINT_A))
      .toMatchObject({ action: "BUY", outcome: "SIMULATED" });
    expect(run.repository.listAutonomousPaperPositions({
      laneId: "autonomous-lane",
      openOnly: true,
      limit: 10
    })).toHaveLength(1);
    expect(run.repository.listClaimedAutonomousPaperEvents("autonomous-lane")).toEqual([]);
    expect(run.repository.listExecutions()).toEqual([]);
  });

  it("recovers a READY v8 path containing the -1 sentinel into exactly 1,000 quarantined replays", async () => {
    const run = setupCurrentV9();

    await run.engine.enqueueCycle();

    const entered = run.repository.autonomousPaperDashboard();
    expect(entered.positions).toHaveLength(1);
    expect(entered.positions[0]!.entryLearningContext).toMatchObject({
      version: "contextual-reward-v2",
      strategyArm: "MOMENTUM",
      waivedReasonCount: 0
    });
    const capturing = entered.replayLab!.recentEpisodes[0]!;
    expect(capturing).toMatchObject({
      status: "CAPTURING",
      positionId: entered.positions[0]!.id,
      observationCount: 1
    });
    expect(run.repository.listAutonomousPaperReplayObservations(capturing.id)).toEqual([
      expect.objectContaining({
        sequence: 0,
        phase: "ENTRY",
        status: "EXECUTABLE",
        positionCostBasisUsd: entered.positions[0]!.entryCostUsd
      })
    ]);

    run.setNow("2026-07-14T12:03:00.000Z");
    run.setTokens([token(MINT_A, "2026-07-14T12:02:30.000Z")]);
    run.setSellOutput(5);
    await run.engine.enqueueCycle();

    expect(run.repository.listAutonomousPaperReplayObservations(capturing.id).map(
      (observation) => observation.phase
    )).toEqual(["ENTRY", "ACTUAL_EXIT"]);
    const beforeReplay = run.repository.getAutonomousPaperAccount("autonomous-lane")!;
    expect(beforeReplay.completedTrades).toBe(1);

    run.setTokens([]);
    run.setSellOutput(6);
    for (let minute = 6; minute <= 177; minute += 3) {
      run.setNow(new Date(Date.parse("2026-07-14T12:00:00.000Z") + minute * 60_000).toISOString());
      await run.engine.enqueueCycle();
    }

    const sentinelToken = token(MINT_A, "2026-07-14T14:59:30.000Z");
    delete sentinelToken.stats5m;
    run.setExactTokens([sentinelToken]);
    const saveReplayReport = vi.spyOn(
      run.repository,
      "saveAutonomousPaperReplayReport"
    ).mockImplementationOnce(() => {
      throw new Error("forced replay persistence interruption");
    });
    run.setNow("2026-07-14T15:00:00.000Z");
    await run.engine.enqueueCycle();

    expect(run.repository.getAutonomousPaperReplayEpisode(capturing.id)).toMatchObject({
      status: "READY",
      observationCount: 61
    });
    expect(run.repository.listAutonomousPaperReplayObservations(capturing.id).at(-1))
      .toMatchObject({
        phase: "POST_EXIT",
        status: "EXECUTABLE",
        organicBuyShare5m: -1
      });
    expect(saveReplayReport).toHaveBeenCalledTimes(1);
    saveReplayReport.mockRestore();

    run.setExactTokens([]);
    run.setNow("2026-07-14T15:03:00.000Z");
    await run.engine.enqueueCycle();

    const replayed = run.repository.getAutonomousPaperReplayEpisode(capturing.id)!;
    expect(replayed).toMatchObject({
      status: "REPLAYED",
      observationCount: 61,
      actualClosedAt: "2026-07-14T12:03:00.000Z"
    });
    const phases = run.repository.listAutonomousPaperReplayObservations(capturing.id).map(
      (observation) => observation.phase
    );
    expect(phases.slice(0, 2)).toEqual(["ENTRY", "ACTUAL_EXIT"]);
    expect(phases.slice(2)).toHaveLength(59);
    expect(phases.slice(2).every((phase) => phase === "POST_EXIT")).toBe(true);
    const report = run.repository.listAutonomousPaperReplayReports("autonomous-lane", 10)[0]!;
    expect(report).toMatchObject({
      episodeId: capturing.id,
      variantCount: 1_000,
      independentEpisodeCount: 1,
      calibrationTradeCount: 0,
      replayResultsAreIndependentTrades: false
    });
    const variants = run.repository.listAutonomousPaperReplayVariantResults(report.id);
    expect(variants).toHaveLength(1_000);
    expect(variants.every((variant) => variant.independentTradeWeight === 0)).toBe(true);
    expect(run.repository.autonomousPaperDashboard().replayLab).toMatchObject({
      independentEpisodeCount: 1,
      scenarioEvaluations: 1_000,
      replayedEpisodes: 1
    });
    expect(run.repository.getAutonomousPaperAccount("autonomous-lane")).toEqual(beforeReplay);
    expect(run.repository.listAutonomousPaperTradesForCalibration("autonomous-lane", 100))
      .toHaveLength(1);
    expect(run.repository.listExecutions()).toEqual([]);
  });

  it("marks an already-silent replay incomplete before its horizon and before tail provider work", async () => {
    const run = setupCurrentV9();
    await run.engine.enqueueCycle();
    const episode = run.repository.autonomousPaperDashboard().replayLab!.recentEpisodes[0]!;

    run.setNow("2026-07-14T12:03:00.000Z");
    run.setTokens([token(MINT_A, "2026-07-14T12:02:30.000Z")]);
    run.setSellOutput(5);
    await run.engine.enqueueCycle();

    const quoteCallsBeforeGap = run.quote.mock.calls.length;
    run.setNow("2026-07-14T12:10:01.000Z");
    run.setTokens([]);
    await run.engine.enqueueCycle();

    expect(run.repository.getAutonomousPaperReplayEpisode(episode.id)).toMatchObject({
      status: "INCOMPLETE",
      completedAt: "2026-07-14T12:10:01.000Z",
      incompleteReason: expect.stringContaining("OBSERVATION_CADENCE_GAP")
    });
    expect(run.quote.mock.calls).toHaveLength(quoteCallsBeforeGap);
    expect(run.repository.listAutonomousPaperReplayReports("autonomous-lane", 10)).toEqual([]);
  });

  it("services five overlapping valid replay paths without starving the newest path", async () => {
    const run = setupCurrentV9();
    const mints = [MINT_A, "replay-b", "replay-c", "replay-d", "replay-e"];
    run.setSellOutputTracksLatestBuy(true);

    for (let index = 0; index < mints.length; index += 1) {
      const entryMinute = index * 12;
      if (index > 0) {
        run.setNow(new Date(Date.parse("2026-07-14T12:00:00.000Z") + entryMinute * 60_000)
          .toISOString());
        run.setSellOutputTracksLatestBuy(true);
        run.setTokens([token(
          mints[index]!,
          new Date(Date.parse("2026-07-14T12:00:00.000Z") + entryMinute * 60_000 - 30_000)
            .toISOString()
        )]);
        await run.engine.enqueueCycle();
      } else {
        await run.engine.enqueueCycle();
      }

      run.setNow(new Date(
        Date.parse("2026-07-14T12:00:00.000Z") + (entryMinute + 3) * 60_000
      ).toISOString());
      const open = run.repository.listAutonomousPaperPositions({
        laneId: "autonomous-lane",
        openOnly: true
      }).find((position) => position.mint === mints[index]);
      expect(
        open,
        `expected entry ${index} for ${mints[index]}: ${JSON.stringify(
          run.repository.latestAutonomousPaperDecision("autonomous-lane", mints[index]!)
        )}`
      ).toBeDefined();
      run.setSellOutputTracksLatestBuy(false);
      run.setSellOutput(open!.entryCostUsd * 1.25 + 0.2);
      run.setTokens([token(
        mints[index]!,
        new Date(Date.parse("2026-07-14T12:00:00.000Z") + (entryMinute + 3) * 60_000 - 30_000)
          .toISOString(),
        { priceUsd: 0.7 }
      )]);
      await run.engine.enqueueCycle();

      if (index < mints.length - 1) {
        for (const offset of [6, 9]) {
          run.setNow(new Date(
            Date.parse("2026-07-14T12:00:00.000Z") + (entryMinute + offset) * 60_000
          ).toISOString());
          run.setSellOutput(27.9);
          run.setSellOutputTracksLatestBuy(false);
          run.setTokens([]);
          await run.engine.enqueueCycle();
        }
      }
    }

    const episodes = run.repository.listAutonomousPaperReplayEpisodes({
      laneId: "autonomous-lane",
      status: "CAPTURING",
      limit: 20
    });
    expect(episodes).toHaveLength(5);
    const countsBefore = new Map(episodes.map((episode) => [
      episode.id,
      run.repository.listAutonomousPaperReplayObservations(episode.id).length
    ]));

    run.lookupMints.mockClear();
    run.setNow("2026-07-14T12:54:00.000Z");
    run.setSellOutput(27.9);
    run.setTokens([]);
    await run.engine.enqueueCycle();

    for (const episode of episodes) {
      expect(run.repository.getAutonomousPaperReplayEpisode(episode.id)).toMatchObject({
        status: "CAPTURING"
      });
      expect(run.repository.listAutonomousPaperReplayObservations(episode.id)).toHaveLength(
        countsBefore.get(episode.id)! + 1
      );
    }
    expect(run.lookupMints.mock.calls).toEqual(expect.arrayContaining([
      [expect.arrayContaining(mints)]
    ]));
    expect(run.maximumConcurrentQuoteCalls()).toBe(1);
  });

  it("records an explicit UNPRICED replay sample even when the claimed root universe cycle fails", async () => {
    const run = setupCurrentV9();
    await run.engine.enqueueCycle();
    const episode = run.repository.autonomousPaperDashboard().replayLab!.recentEpisodes[0]!;

    run.setNow("2026-07-14T12:03:00.000Z");
    run.setTokens([token(MINT_A, "2026-07-14T12:02:30.000Z")]);
    run.setSellOutput(35);
    await run.engine.enqueueCycle();

    run.setNow("2026-07-14T12:06:00.000Z");
    run.setUniverseError(true);
    run.setLookupError(true);
    await expect(run.engine.enqueueCycle()).rejects.toThrow("universe unavailable");

    expect(run.repository.listAutonomousPaperReplayObservations(episode.id).at(-1)).toMatchObject({
      phase: "POST_EXIT",
      status: "UNPRICED",
      observedAt: "2026-07-14T12:06:00.000Z",
      failureCode: "POST_EXIT_MARKET_LOOKUP_FAILED"
    });
    expect(run.repository.listAutonomousPaperEvents({
      laneId: "autonomous-lane",
      kind: "NAV_MARK",
      limit: 10
    })[0]).toMatchObject({
      outcome: "FAILED",
      reason: "universe unavailable"
    });
  });

  it("fails replay closed when entry cadence could exceed the bounded provider tail", async () => {
    const run = setupCurrentV9({
      ...AUTONOMOUS_PAPER_V9_POLICY,
      scanIntervalMinutes: 1,
      minimumEntrySpacingMinutes: 0
    });

    await run.engine.enqueueCycle();

    expect(run.repository.autonomousPaperDashboard()).toMatchObject({
      account: { openPositions: 1 },
      positions: [expect.objectContaining({ status: "OPEN" })],
      replayLab: {
        capturingEpisodes: 0,
        incompleteEpisodes: 1,
        recentEpisodes: [expect.objectContaining({
          status: "INCOMPLETE",
          incompleteReason: "REPLAY_CAPACITY_UNPROVEN"
        })]
      }
    });
    expect(run.repository.listExecutions()).toEqual([]);
  });

  it("terminalizes every replay path when pathological persistence exceeds the cadence bound", async () => {
    const run = setupCurrentV9();
    await run.engine.enqueueCycle();
    const dashboard = run.repository.autonomousPaperDashboard();
    const templatePosition = dashboard.positions[0]!;
    const templateEpisode = dashboard.replayLab!.recentEpisodes[0]!;
    const templateObservation = run.repository
      .listAutonomousPaperReplayObservations(templateEpisode.id)[0]!;

    for (let index = 0; index < 20; index += 1) {
      const mint = `overflow-mint-${index}`;
      const positionId = `overflow-position-${index}`;
      const episodeId = `overflow-episode-${index}`;
      run.repository.upsertAutonomousPaperPosition({
        ...templatePosition,
        id: positionId,
        mint,
        symbol: `OV${index}`,
        remainingAmountAtomic: "0",
        remainingCostUsd: 0,
        status: "CLOSED",
        closedAt: "2026-07-14T12:00:00.000Z"
      });
      run.repository.createAutonomousPaperReplayEpisode({
        ...templateEpisode,
        id: episodeId,
        positionId,
        mint,
        symbol: `OV${index}`,
        observationCount: 0
      });
      run.repository.appendAutonomousPaperReplayObservation({
        ...templateObservation,
        observationKey: `overflow-observation-${index}`,
        episodeId,
        positionId,
        mint
      });
    }
    expect(run.repository.listAutonomousPaperReplayEpisodes({
      laneId: "autonomous-lane",
      status: "CAPTURING",
      limit: 100
    })).toHaveLength(21);

    run.setNow("2026-07-14T12:03:00.000Z");
    run.setTokens([]);
    await run.engine.enqueueCycle();

    const incomplete = run.repository.listAutonomousPaperReplayEpisodes({
      laneId: "autonomous-lane",
      status: "INCOMPLETE",
      limit: 100
    });
    expect(incomplete).toHaveLength(21);
    expect(incomplete.every((episode) =>
      episode.incompleteReason === "REPLAY_CAPACITY_EXCEEDED"
    )).toBe(true);
    expect(run.repository.listAutonomousPaperReplayEpisodes({
      laneId: "autonomous-lane",
      status: "CAPTURING",
      limit: 100
    })).toEqual([]);
    expect(run.repository.getAutonomousPaperAccount("autonomous-lane")).toMatchObject({
      openPositions: 1,
      completedTrades: 0
    });
    expect(run.repository.listExecutions()).toEqual([]);
  });

  it("records a v8 quote gap as UNPRICED so replay cannot invent a profitable or losing mark", async () => {
    const run = setupCurrentV9();
    await run.engine.enqueueCycle();
    const episode = run.repository.autonomousPaperDashboard().replayLab!.recentEpisodes[0]!;

    run.setNow("2026-07-14T12:03:00.000Z");
    run.setTokens([token(MINT_A, "2026-07-14T12:02:30.000Z")]);
    run.setQuoteError(true);
    await run.engine.enqueueCycle();
    expect(run.repository.listAutonomousPaperReplayObservations(episode.id)).toEqual([
      expect.objectContaining({ phase: "ENTRY", status: "EXECUTABLE" }),
      expect.objectContaining({
        phase: "MARK",
        status: "UNPRICED",
        failureCode: "SELL_QUOTE_UNAVAILABLE"
      })
    ]);

    run.setQuoteError(false);
    run.setSellOutput(5);
    run.setNow("2026-07-14T12:06:00.000Z");
    run.setTokens([token(MINT_A, "2026-07-14T12:05:30.000Z")]);
    await run.engine.enqueueCycle();
    run.setTokens([]);
    for (let minute = 9; minute <= 180; minute += 3) {
      run.setNow(new Date(Date.parse("2026-07-14T12:00:00.000Z") + minute * 60_000).toISOString());
      await run.engine.enqueueCycle();
    }

    const report = run.repository.listAutonomousPaperReplayReports("autonomous-lane", 10)[0]!;
    expect(report).toMatchObject({
      variantCount: 1_000,
      scorableVariantCount: 0,
      independentEpisodeCount: 1
    });
    expect(report.hindsightBestVariantId).toBeUndefined();
    expect(run.repository.listAutonomousPaperReplayVariantResults(report.id))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ outcome: "UNSCORABLE", independentTradeWeight: 0 })
      ]));
  });

  it("preserves the archived v5 adaptive engine path and its original capital ceiling", async () => {
    const run = setupCurrentV5();

    await run.engine.enqueueCycle();

    const buy = run.repository.autonomousPaperDashboard().recentDecisions
      .find((value) => value.action === "BUY");
    expect(buy).toMatchObject({
      outcome: "SIMULATED",
      sizing: {
        version: "adaptive-sizing-v1",
        maximumAvailableUsd: 28.2,
        calibration: { coldStart: true }
      }
    });
    expect(run.repository.getAutonomousPaperLane("autonomous-lane")).toMatchObject({
      policyVersion: AUTONOMOUS_PAPER_V5_POLICY_VERSION,
      policy: { maximumPositionUsd: 50, positionNavFraction: 0.2 }
    });
    expect(run.repository.listExecutions()).toEqual([]);
  });

  it("preserves v6 no-cap sizing without retroactively enabling v7 context memory", async () => {
    const run = setupCurrentV6();

    await run.engine.enqueueCycle();

    const dashboard = run.repository.autonomousPaperDashboard();
    const buy = dashboard.recentDecisions.find((value) => value.action === "BUY");
    expect(buy).toMatchObject({
      outcome: "SIMULATED",
      sizing: {
        version: "adaptive-sizing-v1",
        maximumAvailableUsd: 49.35
      }
    });
    expect(dashboard.positions[0]?.entryLearningContext).toBeUndefined();
    expect(run.repository.getAutonomousPaperLane("autonomous-lane")).toMatchObject({
      policyVersion: AUTONOMOUS_PAPER_V6_POLICY_VERSION,
      policy: { contextualRewardEnabled: false, positionNavFraction: 0.35 }
    });
  });

  it("runs only in exact PAPER, evaluates both sides of the ranked category union, and deduplicates a cycle", async () => {
    const run = setupLegacy();
    const compactCandidateDetails = vi.spyOn(
      run.repository,
      "compactAutonomousPaperCandidateDetails"
    );
    run.setMode("MANUAL_LIVE");
    await run.engine.enqueueCycle();
    expect(run.fetchSignalUniverse).not.toHaveBeenCalled();

    run.setMode("PAPER");
    run.setTokens([
      token(MINT_A, "2026-07-14T11:59:30.000Z"),
      token(MINT_B, "2026-07-14T11:59:30.000Z", {
        tags: ["stablecoin"],
        categoryRanks: { topTraded24h: 2 }
      }),
      token("trending-only", "2026-07-14T11:59:30.000Z", {
        categoryRanks: { topTrending1h: 2 }
      }),
      token("unranked", "2026-07-14T11:59:30.000Z", {
        categoryRanks: {}
      })
    ]);
    await run.engine.enqueueCycle();
    await run.engine.enqueueCycle();

    const decisions = run.repository.autonomousPaperDashboard().recentDecisions;
    expect(decisions).toHaveLength(3);
    expect(decisions.find((value) => value.mint === MINT_A)).toMatchObject({
      action: "OBSERVE",
      reasons: expect.arrayContaining(["SIGNAL_PASSED", "WAIT_NEXT_SAMPLE"])
    });
    expect(decisions.find((value) => value.mint === MINT_B)).toMatchObject({
      action: "REJECT",
      reasons: expect.arrayContaining(["STABLECOIN_EXCLUDED"])
    });
    expect(decisions.find((value) => value.mint === "trending-only")).toMatchObject({
      action: "OBSERVE",
      reasons: expect.arrayContaining(["SIGNAL_PASSED", "WAIT_NEXT_SAMPLE"])
    });
    expect(decisions.find((value) => value.mint === "unranked")).toBeUndefined();
    expect(run.fetchSignalUniverse).toHaveBeenCalledTimes(1);
    expect(run.quote).not.toHaveBeenCalled();
    expect(compactCandidateDetails).toHaveBeenCalledTimes(1);
    expect(compactCandidateDetails).toHaveBeenCalledWith("autonomous-lane");
  });

  it("v4 recognizes every category source and uses eligible momentum score within equal overlap", async () => {
    const run = setupCurrentV4();
    run.setTokens([
      token("trending-only", "2026-07-14T11:59:30.000Z", {
        categoryRanks: { topTrending1h: 1 }
      }),
      token(MINT_A, "2026-07-14T11:59:30.000Z", {
        categoryRanks: { topTraded24h: 1, topOrganicScore5m: 1 }
      }),
      token(MINT_B, "2026-07-14T11:59:30.000Z", {
        stats5m: stats({ priceChange: 10 }),
        stats1h: stats({
          priceChange: 20,
          buyVolume: 500_000,
          sellVolume: 250_000,
          buyOrganicVolume: 175_000,
          sellOrganicVolume: 75_000
        }),
        categoryRanks: { topTraded1h: 40, topOrganicScore1h: 40 }
      })
    ]);
    run.quote.mockImplementation(async (request) => {
      const buying = request.inputMint === USDC_MINT;
      return {
        ...quoteFor(request, new Date("2026-07-14T12:00:00.000Z"), 35.1),
        outputAmountAtomic: buying ? "72000000" : "35100000",
        minimumOutputAtomic: buying ? "70000000" : "35000000",
        inputUsd: buying ? 28.2 : 28.1,
        outputUsd: buying ? 28.1 : 27.9
      };
    });

    await run.engine.enqueueCycle();

    expect(run.quote).toHaveBeenCalledTimes(2);
    expect(run.quote.mock.calls[0]?.[0]).toEqual({
      inputMint: USDC_MINT,
      outputMint: MINT_B,
      inputAmountAtomic: "28200000"
    });
    expect(run.quote.mock.calls[1]?.[0]).toEqual({
      inputMint: MINT_B,
      outputMint: USDC_MINT,
      inputAmountAtomic: "70000000"
    });
    const dashboard = run.repository.autonomousPaperDashboard();
    expect(dashboard.positions).toEqual([
      expect.objectContaining({ mint: MINT_B, initialAmountAtomic: "70000000", status: "OPEN" })
    ]);
    expect(dashboard.recentDecisions.find((value) => value.action === "BUY")).toMatchObject({
      mint: MINT_B,
      outcome: "SIMULATED",
      modeledPositionUsd: 28.2,
      reasons: expect.arrayContaining(["AGGRESSIVE_SINGLE_SNAPSHOT", "QUOTE_CEILINGS_PASSED"])
    });
    expect(dashboard.recentDecisions.find((value) => value.mint === MINT_A)?.reasons)
      .toContain("CYCLE_ENTRY_LIMIT_REACHED");
    expect(dashboard.recentDecisions.find((value) => value.mint === "trending-only")?.reasons)
      .toContain("CYCLE_ENTRY_LIMIT_REACHED");
  });

  it("isolates SOL from optional hydration and preserves source ranks", async () => {
    const run = setupCurrentV4();
    const incomplete = token(MINT_A, "2026-07-14T11:59:30.000Z", {
      categoryRanks: { topOrganicScore5m: 4, topTraded1h: 9 }
    });
    delete incomplete.stats5m!.buyOrganicVolume;
    const hydrated = token(MINT_A, "2026-07-14T11:59:45.000Z");
    run.setTokens([incomplete]);
    run.setExactTokens([hydrated]);

    await run.engine.enqueueCycle();

    expect(run.lookupMints).toHaveBeenCalledTimes(2);
    expect(run.lookupMints).toHaveBeenNthCalledWith(1, [SOL_MINT]);
    expect(run.lookupMints).toHaveBeenNthCalledWith(2, [MINT_A]);
    expect(run.quote).toHaveBeenCalledTimes(2);
    expect(run.repository.latestAutonomousPaperDecision("autonomous-lane", MINT_A)).toMatchObject({
      action: "BUY",
      outcome: "SIMULATED",
      snapshot: {
        categoryRanks: { topOrganicScore5m: 4, topTraded1h: 9 }
      }
    });
  });

  it("rejects still-missing momentum evidence without retrying a failed singleton", async () => {
    const run = setupCurrentV4();
    const incomplete = token(MINT_A, "2026-07-14T11:59:30.000Z", {
      categoryRanks: { topOrganicScore5m: 1 }
    });
    delete incomplete.stats5m!.sellOrganicVolume;
    run.setTokens([incomplete]);
    run.lookupMints.mockImplementation(async (mints) => {
      if (mints[0] === MINT_A) throw new Error("optional hydration unavailable");
      return [sol("2026-07-14T11:59:45.000Z")];
    });

    await run.engine.enqueueCycle();

    expect(run.lookupMints).toHaveBeenCalledTimes(2);
    expect(run.lookupMints).toHaveBeenNthCalledWith(1, [SOL_MINT]);
    expect(run.lookupMints).toHaveBeenNthCalledWith(2, [MINT_A]);
    expect(run.quote).not.toHaveBeenCalled();
    expect(run.repository.latestAutonomousPaperDecision("autonomous-lane", MINT_A)).toMatchObject({
      action: "REJECT",
      reasons: expect.arrayContaining(["MOMENTUM_DATA_MISSING"])
    });
    expect(run.repository.latestAutonomousPaperDecision("autonomous-lane", MINT_A)?.reasons)
      .not.toContain("SOL_REGIME_UNAVAILABLE");
  });

  it("hydrates in sequential chunks of at most 50 and splits a failed chunk only once", async () => {
    const run = setupCurrentV4();
    const incomplete = Array.from({ length: 52 }, (_, index) => {
      const candidate = token(`bounded-hydration-${index}`, "2026-07-14T11:59:30.000Z", {
        categoryRanks: { topOrganicScore5m: index + 1, topTraded1h: index + 1 }
      });
      delete candidate.stats5m!.buyOrganicVolume;
      return candidate;
    });
    run.setTokens(incomplete);
    let hydrationCall = 0;
    run.lookupMints.mockImplementation(async (mints) => {
      if (mints.length === 1 && mints[0] === SOL_MINT) {
        return [sol("2026-07-14T11:59:45.000Z")];
      }
      hydrationCall += 1;
      if (hydrationCall === 1 || hydrationCall === 3) {
        throw new Error("one member made this exact-mint batch fail");
      }
      return mints.map((mint) => token(mint, "2026-07-14T11:59:45.000Z"));
    });

    await run.engine.enqueueCycle();

    const lookupSizes = run.lookupMints.mock.calls.map(([mints]) => mints.length);
    expect(lookupSizes).toEqual([1, 50, 25, 25, 2]);
    expect(Math.max(...lookupSizes.slice(1))).toBe(50);
    const successfulMint = run.lookupMints.mock.calls[2]![0][0]!;
    const failedMint = run.lookupMints.mock.calls[3]![0][0]!;
    expect(run.repository.latestAutonomousPaperDecision("autonomous-lane", successfulMint)?.snapshot)
      .toMatchObject({ categoryRanks: expect.objectContaining({ topOrganicScore5m: expect.any(Number) }) });
    expect(run.repository.latestAutonomousPaperDecision("autonomous-lane", failedMint)?.reasons)
      .toContain("MOMENTUM_DATA_MISSING");
  });

  it("fails the root without candidate work when mode changes during SOL lookup", async () => {
    const run = setupCurrentV4();
    run.lookupMints.mockImplementation(async (mints) => {
      if (mints[0] === SOL_MINT) run.setMode("MANUAL_LIVE");
      return mints.map((mint) => mint === SOL_MINT
        ? sol("2026-07-14T11:59:45.000Z")
        : token(mint, "2026-07-14T11:59:45.000Z"));
    });

    await run.engine.enqueueCycle();

    expect(run.quote).not.toHaveBeenCalled();
    expect(run.repository.latestAutonomousPaperDecision("autonomous-lane", MINT_A)).toBeUndefined();
    expect(run.repository.listAutonomousPaperPositions({ laneId: "autonomous-lane", limit: 10 }))
      .toEqual([]);
    expect(run.repository.listAutonomousPaperEvents({
      laneId: "autonomous-lane",
      kind: "NAV_MARK",
      limit: 10
    }).find((event) => event.eventKey.startsWith("autonomous-cycle-v1:")))
      .toMatchObject({ outcome: "FAILED" });
  });

  it("fails the root without candidate work when the lane pauses during hydration", async () => {
    const run = setupCurrentV4();
    const incomplete = token(MINT_A, "2026-07-14T11:59:30.000Z");
    delete incomplete.stats5m!.sellOrganicVolume;
    run.setTokens([incomplete]);
    run.lookupMints.mockImplementation(async (mints) => {
      if (mints[0] !== SOL_MINT) {
        run.repository.pauseAutonomousPaperLane("autonomous-lane", "2026-07-14T12:00:01.000Z");
      }
      return mints.map((mint) => mint === SOL_MINT
        ? sol("2026-07-14T11:59:45.000Z")
        : token(mint, "2026-07-14T11:59:45.000Z"));
    });

    await run.engine.enqueueCycle();

    expect(run.quote).not.toHaveBeenCalled();
    expect(run.repository.latestAutonomousPaperDecision("autonomous-lane", MINT_A)).toBeUndefined();
    expect(run.repository.listAutonomousPaperPositions({ laneId: "autonomous-lane", limit: 10 }))
      .toEqual([]);
    expect(run.repository.listAutonomousPaperEvents({
      laneId: "autonomous-lane",
      kind: "NAV_MARK",
      limit: 10
    }).find((event) => event.eventKey.startsWith("autonomous-cycle-v1:")))
      .toMatchObject({ outcome: "FAILED" });
  });

  it("deduplicates one-minute scheduler polls into the persisted v4 three-minute bucket", async () => {
    const run = setupCurrentV4();
    run.setTokens([token(MINT_A, "2026-07-14T11:59:30.000Z", { tags: ["stablecoin"] })]);

    await run.engine.enqueueCycle();
    run.setNow("2026-07-14T12:01:00.000Z");
    await run.engine.enqueueCycle();
    run.setNow("2026-07-14T12:02:00.000Z");
    await run.engine.enqueueCycle();
    expect(run.fetchSignalUniverse).toHaveBeenCalledTimes(1);

    run.setNow("2026-07-14T12:03:00.000Z");
    run.setTokens([token(MINT_A, "2026-07-14T12:02:30.000Z", { tags: ["stablecoin"] })]);
    await run.engine.enqueueCycle();
    expect(run.fetchSignalUniverse).toHaveBeenCalledTimes(2);
  });

  it("keeps archived policy epochs on their persisted five-minute buckets", async () => {
    const run = setupLegacy();
    run.setTokens([token(MINT_A, "2026-07-14T11:59:30.000Z", { tags: ["stablecoin"] })]);

    await run.engine.enqueueCycle();
    run.setNow("2026-07-14T12:03:00.000Z");
    await run.engine.enqueueCycle();
    expect(run.fetchSignalUniverse).toHaveBeenCalledTimes(1);

    run.setNow("2026-07-14T12:05:00.000Z");
    run.setTokens([token(MINT_A, "2026-07-14T12:04:30.000Z", { tags: ["stablecoin"] })]);
    await run.engine.enqueueCycle();
    expect(run.fetchSignalUniverse).toHaveBeenCalledTimes(2);
  });

  it("enforces the persisted UTC entry cap before quoting after an engine restart", async () => {
    const run = setupCurrentV4({
      ...AUTONOMOUS_PAPER_V4_POLICY,
      maximumEntriesPerUtcDay: 1,
      minimumEntrySpacingMinutes: 0
    });
    await run.engine.enqueueCycle();
    expect(run.repository.autonomousPaperDashboard().account?.openPositions).toBe(1);

    run.setNow("2026-07-14T12:03:00.000Z");
    run.setTokens([token(MINT_B, "2026-07-14T12:02:30.000Z")]);
    await run.createEngine().enqueueCycle();

    const entryQuotes = run.quote.mock.calls.filter(([request]) => request.inputMint === USDC_MINT);
    expect(entryQuotes).toHaveLength(1);
    expect(run.repository.latestAutonomousPaperDecision("autonomous-lane", MINT_B)?.reasons)
      .toContain("UTC_DAILY_ENTRY_CAP_REACHED");
  });

  it("retains the UTC entry cap after more than 500 newer rejected decisions", async () => {
    const run = setupCurrentV4({
      ...AUTONOMOUS_PAPER_V4_POLICY,
      maximumEntriesPerUtcDay: 1,
      minimumEntrySpacingMinutes: 0
    });
    await run.engine.enqueueCycle();

    run.setNow("2026-07-14T12:03:00.000Z");
    run.setTokens(Array.from({ length: 510 }, (_, index) => token(
      `autonomous-rejected-${index}`,
      "2026-07-14T12:02:30.000Z",
      { tags: ["stablecoin"] }
    )));
    await run.engine.enqueueCycle();

    run.setNow("2026-07-14T12:06:00.000Z");
    run.setTokens([token(MINT_B, "2026-07-14T12:05:30.000Z")]);
    await run.createEngine().enqueueCycle();

    const entryQuotes = run.quote.mock.calls.filter(([request]) => request.inputMint === USDC_MINT);
    expect(entryQuotes).toHaveLength(1);
    expect(run.repository.latestAutonomousPaperDecision("autonomous-lane", MINT_B)?.reasons)
      .toContain("UTC_DAILY_ENTRY_CAP_REACHED");
  });

  it("allows the current unlimited policy to enter after eight persisted UTC-day buys", async () => {
    const run = setupCurrentV9();
    for (let index = 0; index < 8; index += 1) {
      const observedAt = new Date(Date.UTC(2026, 6, 14, 12, index, 1)).toISOString();
      const event: AutonomousPaperEvent = {
        eventKey: `prior-current-entry-${index}`,
        laneId: "autonomous-lane",
        kind: "DECISION",
        outcome: "CLAIMED",
        observedAt,
        mint: `prior-current-entry-mint-${index}`,
        action: "BUY"
      };
      expect(run.repository.claimAutonomousPaperEvent(event)).toBe(true);
      expect(run.repository.finalizeAutonomousPaperEvent({
        ...event,
        outcome: "SIMULATED",
        finalizedAt: observedAt
      })).toBe(true);
    }

    run.setNow("2026-07-14T14:00:00.000Z");
    run.setTokens([token(MINT_A, "2026-07-14T13:59:30.000Z")]);
    await run.engine.enqueueCycle();

    expect(run.quote.mock.calls.filter(([request]) => request.inputMint === USDC_MINT))
      .not.toHaveLength(0);
    expect(run.repository.countAutonomousPaperSimulatedBuyEntriesForUtcDay(
      "autonomous-lane",
      "2026-07-14T14:00:00.000Z"
    )).toBe(9);
    expect(run.repository.latestAutonomousPaperDecision("autonomous-lane", MINT_A)?.reasons)
      .not.toContain("UTC_DAILY_ENTRY_CAP_REACHED");
  });

  it("enforces persisted minimum entry spacing and permits a later cycle", async () => {
    const run = setupCurrentV4({
      ...AUTONOMOUS_PAPER_V4_POLICY,
      maximumEntriesPerUtcDay: 8,
      minimumEntrySpacingMinutes: 10
    });
    await run.engine.enqueueCycle();

    run.setNow("2026-07-14T12:03:00.000Z");
    run.setTokens([token(MINT_B, "2026-07-14T12:02:30.000Z")]);
    await run.engine.enqueueCycle();
    expect(run.repository.latestAutonomousPaperDecision("autonomous-lane", MINT_B)?.reasons)
      .toContain("MINIMUM_ENTRY_SPACING_ACTIVE");

    run.setNow("2026-07-14T12:12:00.000Z");
    run.setTokens([token(MINT_B, "2026-07-14T12:11:30.000Z")]);
    await run.engine.enqueueCycle();

    expect(run.quote.mock.calls.filter(([request]) => request.inputMint === USDC_MINT)).toHaveLength(2);
    expect(run.repository.listAutonomousPaperPositions({
      laneId: "autonomous-lane",
      openOnly: true,
      limit: 10
    })).toHaveLength(2);
  });

  it("requires fresh, advancing two-snapshot evidence and uses conservative quote output for one entry", async () => {
    const run = setupLegacy();
    run.setTokens([
      token(MINT_A, "2026-07-14T11:59:30.000Z"),
      token(MINT_B, "2026-07-14T11:59:30.000Z")
    ]);
    await run.engine.enqueueCycle();

    run.setNow("2026-07-14T12:05:00.000Z");
    // Same provider evidence with a new local capture cannot unlock the entry.
    run.setTokens([
      token(MINT_A, "2026-07-14T11:59:30.000Z"),
      token(MINT_B, "2026-07-14T11:59:30.000Z")
    ]);
    await run.engine.enqueueCycle();
    expect(run.quote).not.toHaveBeenCalled();

    run.setNow("2026-07-14T12:10:00.000Z");
    run.setTokens([
      token(MINT_A, "2026-07-14T12:09:30.000Z"),
      token(MINT_B, "2026-07-14T12:09:30.000Z")
    ]);
    await run.engine.enqueueCycle();

    expect(run.quote).toHaveBeenCalledTimes(2);
    expect(run.quote.mock.calls[0]?.[0]).toEqual({
      inputMint: USDC_MINT,
      outputMint: MINT_A,
      inputAmountAtomic: "28200000"
    });
    expect(run.quote.mock.calls[1]?.[0]).toEqual({
      inputMint: MINT_A,
      outputMint: USDC_MINT,
      inputAmountAtomic: "55000000"
    });
    const dashboard = run.repository.autonomousPaperDashboard();
    expect(dashboard.positions).toEqual([
      expect.objectContaining({
        mint: MINT_A,
        initialAmountAtomic: "55000000",
        remainingAmountAtomic: "55000000",
        status: "OPEN"
      })
    ]);
    const buy = dashboard.recentDecisions.find((value) => value.action === "BUY");
    expect(buy).toMatchObject({
      outcome: "SIMULATED",
      modeledPositionUsd: 28.2
    });
    expect(buy?.projectedRoundTripCostPercent).toBeGreaterThan(0);
    expect(buy?.stressRoundTripCostPercent).toBeGreaterThan(buy?.projectedRoundTripCostPercent ?? 0);
    expect(dashboard.recentDecisions.find((value) => value.mint === MINT_B)).toMatchObject({
      action: "OBSERVE",
      reasons: expect.arrayContaining(["CYCLE_ENTRY_LIMIT_REACHED"])
    });
    expect(run.repository.listPositions()).toEqual([]);
    expect(run.repository.listExecutions()).toEqual([]);
  });

  it("marks every open position before scanning and fails closed as UNPRICED", async () => {
    const run = setupLegacy();
    await run.engine.enqueueCycle();
    run.setNow("2026-07-14T12:05:00.000Z");
    run.setTokens([token(MINT_A, "2026-07-14T12:04:30.000Z")]);
    await run.engine.enqueueCycle();
    expect(run.repository.autonomousPaperDashboard().positions).toHaveLength(1);

    run.order.length = 0;
    run.setNow("2026-07-14T12:10:00.000Z");
    run.setTokens([
      token(MINT_A, "2026-07-14T12:09:30.000Z"),
      token(MINT_B, "2026-07-14T12:09:30.000Z")
    ]);
    run.setQuoteError(true);
    await run.engine.enqueueCycle();

    expect(run.order.indexOf(`lookup:${MINT_A}`)).toBeLessThan(run.order.indexOf("universe"));
    expect(run.order.indexOf("quote:sell")).toBeLessThan(run.order.indexOf("universe"));
    expect(run.repository.autonomousPaperDashboard()).toMatchObject({
      account: { pricingComplete: false, openPositions: 1 },
      positions: [expect.objectContaining({ mint: MINT_A, status: "UNPRICED" })]
    });
    expect(run.repository.latestAutonomousPaperDecision("autonomous-lane", MINT_B)?.reasons)
      .toContain("OPEN_POSITION_UNPRICED");
  });

  it("simulates a stop from an exact full-position sell quote and enforces the 24-hour cooldown", async () => {
    const run = setupLegacy();
    await run.engine.enqueueCycle();
    run.setNow("2026-07-14T12:05:00.000Z");
    run.setTokens([token(MINT_A, "2026-07-14T12:04:30.000Z")]);
    await run.engine.enqueueCycle();

    run.setNow("2026-07-14T12:10:00.000Z");
    run.setTokens([token(MINT_A, "2026-07-14T12:09:30.000Z")]);
    run.setSellOutput(20);
    await run.engine.enqueueCycle();

    const dashboard = run.repository.autonomousPaperDashboard();
    expect(dashboard.positions).toEqual([]);
    expect(dashboard.recentTrades[0]).toMatchObject({
      exitReason: "STOP_LOSS",
      mint: MINT_A,
      pnlUsd: expect.any(Number),
      modeledCostsUsd: expect.any(Number)
    });
    expect(dashboard.recentTrades[0]!.pnlUsd).toBeLessThan(0);
    expect(dashboard.account).toMatchObject({ completedTrades: 1, openPositions: 0 });
    expect(run.repository.latestAutonomousPaperDecision("autonomous-lane", MINT_A)?.reasons)
      .toContain("STOP_COOLDOWN_ACTIVE");
  });

  it("rejects stale SOL/token evidence and malformed USDC quote metadata", async () => {
    const run = setupLegacy();
    run.setTokens([token(MINT_A, "2026-07-14T11:59:30.000Z")]);
    run.setSolUpdatedAt("2026-07-14T11:30:00.000Z");
    await run.engine.enqueueCycle();
    expect(run.repository.latestAutonomousPaperDecision("autonomous-lane", MINT_A)?.reasons)
      .toContain("SOL_REGIME_UNAVAILABLE");
    expect(run.quote).not.toHaveBeenCalled();

    // Build a valid first confirmation, then make the buy quote claim the
    // wrong USD amount despite the exact USDC atomic input.
    run.setNow("2026-07-14T12:05:00.000Z");
    run.setSolUpdatedAt(undefined);
    run.setTokens([token(MINT_A, "2026-07-14T12:04:30.000Z")]);
    await run.engine.enqueueCycle();
    run.setNow("2026-07-14T12:10:00.000Z");
    run.setTokens([token(MINT_A, "2026-07-14T12:09:30.000Z")]);
    run.quote.mockImplementation(async (request) => ({
      ...quoteFor(request, new Date("2026-07-14T12:10:00.000Z")),
      inputUsd: request.inputMint === USDC_MINT ? 10 : 28
    }));
    await run.engine.enqueueCycle();
    expect(run.repository.latestAutonomousPaperDecision("autonomous-lane", MINT_A)).toMatchObject({
      action: "BUY",
      outcome: "FAILED",
      reasons: ["BUY_QUOTE_USD_METADATA_MISMATCH"]
    });
    expect(run.repository.autonomousPaperDashboard().positions).toEqual([]);
  });

  it("expires a passing confirmation after two scan intervals", async () => {
    const run = setupLegacy();
    await run.engine.enqueueCycle();
    run.setNow("2026-07-14T12:15:00.000Z");
    run.setTokens([token(MINT_A, "2026-07-14T12:14:30.000Z")]);
    await run.engine.enqueueCycle();
    expect(run.quote).not.toHaveBeenCalled();
    expect(run.repository.latestAutonomousPaperDecision("autonomous-lane", MINT_A)).toMatchObject({
      action: "OBSERVE",
      reasons: expect.arrayContaining(["WAIT_NEXT_SAMPLE"])
    });
  });

  it("recovers an interrupted UTC day baseline with the persisted pre-mark NAV", () => {
    const run = setupLegacy();
    const claim = {
      eventKey: "autonomous-day-start-v1:interrupted-test",
      laneId: "autonomous-lane",
      kind: "NAV_MARK" as const,
      outcome: "CLAIMED" as const,
      observedAt: "2026-07-14T00:00:00.000Z"
    };
    expect(run.repository.claimAutonomousPaperEvent(claim)).toBe(true);
    expect(run.engine.recoverInterruptedClaims()).toBe(1);
    expect(run.repository.getAutonomousPaperEvent(claim.eventKey)).toMatchObject({
      outcome: "FAILED",
      navUsd: 141
    });
  });

  it("recovers an interrupted root buried under more than 500 newer decisions", async () => {
    const run = setupCurrentV4();
    const interruptedRoot = {
      eventKey: "autonomous-cycle-v1:buried-interrupted-root",
      laneId: "autonomous-lane",
      kind: "NAV_MARK" as const,
      outcome: "CLAIMED" as const,
      observedAt: "2026-07-14T11:00:00.000Z"
    };
    expect(run.repository.claimAutonomousPaperEvent(interruptedRoot)).toBe(true);
    run.setTokens(Array.from({ length: 510 }, (_, index) => token(
      `buried-rejection-${index}`,
      "2026-07-14T11:59:30.000Z",
      { tags: ["stablecoin"] }
    )));
    await run.engine.enqueueCycle();

    expect(run.repository.listAutonomousPaperEvents({
      laneId: "autonomous-lane",
      limit: 500
    }).some((event) => event.eventKey === interruptedRoot.eventKey)).toBe(false);
    expect(run.engine.recoverInterruptedClaims()).toBe(1);
    expect(run.repository.getAutonomousPaperEvent(interruptedRoot.eventKey)).toMatchObject({
      outcome: "FAILED"
    });
  });

  it("revalidates both quote legs at the final timestamp and rejects excessive leg skew", async () => {
    const run = setupLegacy();
    await run.engine.enqueueCycle();
    run.setNow("2026-07-14T12:05:00.000Z");
    run.setTokens([token(MINT_A, "2026-07-14T12:04:30.000Z")]);
    let call = 0;
    run.quote.mockImplementation(async (request) => {
      call += 1;
      if (call === 1) {
        return quoteFor(request, new Date("2026-07-14T12:05:00.000Z"));
      }
      run.setNow("2026-07-14T12:05:30.000Z");
      return quoteFor(request, new Date("2026-07-14T12:05:30.000Z"));
    });
    await run.engine.enqueueCycle();
    expect(run.repository.latestAutonomousPaperDecision("autonomous-lane", MINT_A)).toMatchObject({
      action: "BUY",
      outcome: "FAILED",
      reasons: ["SELL_QUOTE_FAILED_CEILINGS"]
    });
    expect(run.repository.autonomousPaperDashboard().positions).toEqual([]);
  });
});
