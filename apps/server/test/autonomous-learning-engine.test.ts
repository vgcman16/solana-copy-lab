import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SOL_MINT,
  TOKEN_PROGRAM_ID,
  USDC_MINT,
  type QuoteRequest,
  type QuoteSnapshot
} from "@copylab/shared";
import type {
  JupiterMarketStats,
  JupiterMarketTokenSnapshot
} from "@copylab/providers";
import {
  AutonomousLearningEngine,
  classifyMarketRegime
} from "../src/autonomous-learning.js";
import {
  DEFAULT_AUTONOMOUS_PAPER_POLICY,
  AUTONOMOUS_PAPER_POLICY_VERSION,
  AUTONOMOUS_PAPER_V12_POLICY,
  AUTONOMOUS_PAPER_V12_POLICY_VERSION
} from "../src/autonomous-paper-policy.js";
import type { CopyLabDatabase } from "../src/database.js";
import { openDatabase } from "../src/database.js";
import {
  AutonomousLearningRepository,
  type LearningDatabase,
  openLearningDatabase
} from "../src/learning-database.js";
import { Repository } from "../src/repository.js";

const CAPTURED_AT = "2026-07-15T00:00:00.000Z";

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

function statsWithoutOrganic(overrides: Partial<JupiterMarketStats> = {}): JupiterMarketStats {
  const result = stats(overrides);
  delete result.buyOrganicVolume;
  delete result.sellOrganicVolume;
  return result;
}

function token(
  mint = "learning-engine-mint",
  overrides: Partial<JupiterMarketTokenSnapshot> = {}
): JupiterMarketTokenSnapshot {
  return {
    mint,
    name: `Token ${mint}`,
    symbol: "LEARN",
    decimals: 6,
    tokenProgram: TOKEN_PROGRAM_ID,
    createdAt: "2026-06-01T00:00:00.000Z",
    firstPoolAt: "2026-06-01T00:00:00.000Z",
    developer: "learning-developer",
    launchpad: "learning-launchpad",
    holderCount: 5_000,
    fdvUsd: 30_000_000,
    marketCapUsd: 20_000_000,
    priceUsd: 0.5,
    liquidityUsd: 2_000_000,
    stats5m: stats({ priceChange: 4 }),
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
    updatedAt: CAPTURED_AT,
    categoryRanks: {
      topTraded24h: 1,
      topTraded6h: 2,
      topTraded1h: 3,
      topTrending6h: 4,
      topTrending1h: 5
    },
    ...overrides
  };
}

function quoteFor(request: QuoteRequest, at: Date, exitValueUsd: number): QuoteSnapshot {
  const buying = request.inputMint === USDC_MINT;
  const outputUsd = buying ? 20 : exitValueUsd;
  const outputAtomic = buying
    ? "40000000"
    : String(Math.floor(outputUsd * 1_000_000));
  return {
    requestId: `learning-${buying ? "buy" : "sell"}-${at.getTime()}`,
    quotedAt: at.toISOString(),
    inputMint: request.inputMint,
    outputMint: request.outputMint,
    inputAmountAtomic: request.inputAmountAtomic,
    outputAmountAtomic: outputAtomic,
    minimumOutputAtomic: buying
      ? "39000000"
      : String(Math.floor(Math.max(0.01, outputUsd - 0.01) * 1_000_000)),
    inputUsd: 20,
    outputUsd,
    priceImpactPercent: 0.2,
    slippageBps: 50,
    feeBps: 10,
    signatureFeeLamports: 5_000,
    prioritizationFeeLamports: 0,
    rentFeeLamports: 0,
    router: "learning-quote-only-test"
  };
}

describe("autonomous executable shadow learning", () => {
  let mainDatabase: CopyLabDatabase | undefined;
  let learningDatabase: LearningDatabase | undefined;

  afterEach(() => {
    mainDatabase?.close();
    learningDatabase?.close();
    mainDatabase = undefined;
    learningDatabase = undefined;
  });

  it("classifies regimes deterministically from causal SOL and breadth evidence", () => {
    const candidates = Array.from({ length: 6 }, (_, index) => token(`regime-${index}`, {
      stats1h: stats({ priceChange: 3 + index / 10 })
    }));
    expect(classifyMarketRegime(token(SOL_MINT, {
      stats1h: stats({ priceChange: 1 }),
      stats6h: stats({ priceChange: 2 })
    }), candidates)).toBe("RISK_ON_TREND");
    expect(classifyMarketRegime(token(SOL_MINT, {
      stats1h: stats({ priceChange: -3 }),
      stats6h: stats({ priceChange: -6 })
    }), candidates)).toBe("RISK_OFF");
    expect(classifyMarketRegime(undefined, candidates)).toBe("UNKNOWN");
  });

  it("moves a deduplicated quote-only path through 15, 45, and 180 minute labels without trading", async () => {
    mainDatabase = openDatabase(":memory:");
    learningDatabase = openLearningDatabase(":memory:");
    const repository = new Repository(mainDatabase);
    const learning = new AutonomousLearningRepository(learningDatabase);
    const lane = repository.createAutonomousPaperLane({
      id: "learning-lane",
      policyVersion: AUTONOMOUS_PAPER_POLICY_VERSION,
      policy: { ...DEFAULT_AUTONOMOUS_PAPER_POLICY },
      initialNavUsd: 141,
      startedAt: CAPTURED_AT
    });
    repository.initializeAutonomousPaperAccount(lane.id, CAPTURED_AT);
    let now = new Date(CAPTURED_AT);
    let exitValueUsd = 19.8;
    const candidate = token();
    const quote = vi.fn(async (request: QuoteRequest) => quoteFor(request, now, exitValueUsd));
    const updates: string[] = [];
    const engine = new AutonomousLearningEngine(repository, learning, {
      quote,
      lookupMints: async () => [candidate],
      solPriceUsd: () => 150,
      now: () => now,
      walletConfirmed: () => true,
      onUpdate: ({ outcome }) => updates.push(outcome)
    });
    const universe = { capturedAt: CAPTURED_AT, tokens: [candidate] };

    engine.ingestUniverse({ lane, universe, tokens: [candidate] });
    engine.ingestUniverse({ lane, universe, tokens: [candidate] });
    expect(repository.pendingLearningOutbox()).toHaveLength(1);

    await engine.enqueueProcess();
    expect(repository.pendingLearningOutbox()).toEqual([]);
    const [opened] = learning.listEpisodes(["ACTIVE"]);
    expect(opened).toMatchObject({
      status: "ACTIVE",
      strategyArm: "WALLET_CONFIRMED_MOMENTUM",
      shadowOnly: true,
      executionTier: "SHADOW",
      referenceInputUsd: 20,
      featureVector: {
        walletConfirmed: true,
        datasetEligible: true,
        categoryBreadth: 5
      }
    });
    expect(quote).toHaveBeenCalledTimes(2);

    now = new Date("2026-07-15T00:15:00.000Z");
    exitValueUsd = 20.4;
    await engine.enqueueProcess();
    expect(learning.outcomeFor(opened!.id, 15)).toMatchObject({
      horizonMinutes: 15,
      quoteExecutable: true,
      datasetEligible: true,
      profitable: true
    });

    now = new Date("2026-07-15T00:45:00.000Z");
    exitValueUsd = 20.7;
    await engine.enqueueProcess();
    expect(learning.outcomeFor(opened!.id, 45)).toMatchObject({ horizonMinutes: 45 });

    now = new Date("2026-07-15T03:00:00.000Z");
    exitValueUsd = 21.2;
    await engine.enqueueProcess();
    expect(learning.outcomeFor(opened!.id, 180)).toMatchObject({
      horizonMinutes: 180,
      profitable: true
    });
    expect(learning.getEpisode(opened!.id)).toMatchObject({
      status: "COMPLETED",
      maximumFavorableExcursionPercent: expect.any(Number)
    });
    expect(learning.episodeCounts()).toEqual({
      pending: 0,
      active: 0,
      completed: 1,
      rejected: 0,
      unpriced: 0,
      datasetEligible: 1
    });
    expect(learning.pathObservations(opened!.id)).toHaveLength(4);
    expect(learning.outcomeFor(opened!.id, 180)).toMatchObject({
      solBenchmarkReturnPercent: 0,
      excessReturnPercent: expect.any(Number),
      riskAdjustedReward: expect.any(Number)
    });
    expect(learning.recentAttributions()).toHaveLength(3);
    expect(repository.listExecutions()).toEqual([]);
    expect(repository.listPositions()).toEqual([]);
    expect(updates).toEqual(expect.arrayContaining([
      "SHADOW_OPENED",
      "SHADOW_LABELED",
      "SHADOW_COMPLETED",
      "LEARNING_TRAINED"
    ]));

    const overview = await engine.train(true);
    expect(overview).toMatchObject({
      status: "COLLECTING",
      datasetEligiblePaths: 1,
      modelInfluenceEnabled: false,
      minimumPathsForModelInfluence: 200,
      quoteWorkBudgetFraction: 0.4,
      policyCohortVersion: AUTONOMOUS_PAPER_POLICY_VERSION,
      cohortPendingEpisodes: 0,
      cohortActiveEpisodes: 0,
      cohortCompletedEpisodes: 1,
      cohortDatasetEligiblePaths: 1,
      pathObservationCount: 4,
      quoteCoveragePercent: 100,
      simulationArena: {
        version: "shadow-simulation-arena-v1",
        candidatePolicyCount: 7_776,
        independentPathCount: 1,
        denseIndependentPathCount: 0,
        latestScorableScenarioEvaluations: 0,
        capitalInfluenceEnabled: false,
        correlatedScenariosAreIndependentEvidence: false
      },
      promotion: {
        allowed: false,
        blockerCodes: expect.arrayContaining([
          "NEEDS_30_CONSECUTIVE_OBSERVED_DAYS",
          "NEEDS_300_EXECUTABLE_SHADOW_PATHS",
          "NEEDS_100_CHAMPION_PAPER_EXITS"
        ])
      }
    });
    expect(engine.candidateStrategy(candidate, CAPTURED_AT)).toMatchObject({
      arm: "WALLET_CONFIRMED_MOMENTUM",
      modelAllowed: true,
      modelHighConviction: false
    });
    expect(engine.candidateStrategy(candidate, CAPTURED_AT, true)).toMatchObject({
      arm: "WALLET_CONFIRMED_MOMENTUM",
      modelAllowed: false,
      admission: {
        executionTier: "SHADOW",
        allowed: false,
        reasonCodes: expect.arrayContaining(["GLOBAL_MODEL_NEEDS_200_PATHS"])
      }
    });
    expect(() => engine.requestPromotion("wrong confirmation"))
      .toThrow("exact typed confirmation");
    expect(() => engine.requestPromotion("PROMOTE AUTONOMOUS CHALLENGER"))
      .toThrow("promotion is blocked");

    engine.ingestUniverse({ lane, universe, tokens: [candidate] });
    await engine.enqueueProcess();
    expect(learning.episodeCounts().completed).toBe(1);

    now = new Date("2026-07-15T03:05:00.000Z");
    engine.ingestUniverse({
      lane,
      universe: { capturedAt: now.toISOString(), tokens: [candidate] },
      tokens: [candidate]
    });
    await engine.enqueueProcess();
    expect(learning.episodeCounts().completed).toBe(1);
    expect(learning.integrityCheck()).toBe("ok");
  });

  it("uses V13 regime-aware quality gates and never promotes missing organic flow into a strategy arm", async () => {
    mainDatabase = openDatabase(":memory:");
    learningDatabase = openLearningDatabase(":memory:");
    const repository = new Repository(mainDatabase);
    const learning = new AutonomousLearningRepository(learningDatabase);
    const lane = repository.createAutonomousPaperLane({
      id: "regime-aware-lane",
      policyVersion: AUTONOMOUS_PAPER_POLICY_VERSION,
      policy: { ...DEFAULT_AUTONOMOUS_PAPER_POLICY },
      initialNavUsd: 141,
      startedAt: CAPTURED_AT
    });
    repository.initializeAutonomousPaperAccount(lane.id, CAPTURED_AT);
    const strong = token("strong-high-vol");
    const missingOrganicBreakout = token("missing-organic-breakout", {
      stats5m: statsWithoutOrganic({ priceChange: 5 }),
      stats1h: statsWithoutOrganic({ priceChange: 12 })
    });
    const highVolPullback = token("high-vol-pullback", {
      stats5m: stats({ priceChange: 0 }),
      stats1h: stats({ priceChange: 6 }),
      stats6h: stats({ priceChange: 10 })
    });
    const weak = Array.from({ length: 4 }, (_, index) => token(`weak-${index}`, {
      stats5m: stats({
        priceChange: -4,
        buyOrganicVolume: 10_000,
        sellOrganicVolume: 90_000,
        liquidityChange: -2
      }),
      stats1h: stats({
        priceChange: index % 2 === 0 ? 18 : -8,
        buyOrganicVolume: 50_000,
        sellOrganicVolume: 450_000,
        liquidityChange: -2
      }),
      stats6h: stats({ priceChange: -5 })
    }));
    const candidates = [strong, missingOrganicBreakout, highVolPullback, ...weak];
    const sol = token(SOL_MINT, {
      stats1h: stats({ priceChange: 4 }),
      stats6h: stats({ priceChange: 4 })
    });
    const byMint = new Map(candidates.map((candidate) => [candidate.mint, candidate]));
    const now = new Date(CAPTURED_AT);
    const engine = new AutonomousLearningEngine(repository, learning, {
      quote: async (request) => quoteFor(request, now, 19.8),
      lookupMints: async (mints) => mints.map((mint) => byMint.get(mint)!).filter(Boolean),
      solPriceUsd: () => 150,
      now: () => now,
      walletConfirmed: () => false
    });

    engine.ingestUniverse({
      lane,
      universe: { capturedAt: CAPTURED_AT, tokens: candidates },
      tokens: candidates,
      sol
    });
    await engine.enqueueProcess();

    expect(engine.overview().currentRegime).toBe("HIGH_VOLATILITY");
    const episodes = learning.listEpisodes([
      "PENDING_QUOTE",
      "ACTIVE",
      "COMPLETED",
      "REJECTED",
      "UNPRICED"
    ]);
    expect(episodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        mint: strong.mint,
        strategyArm: "BREAKOUT",
        shadowOnly: true
      })
    ]));
    expect(episodes.find((episode) =>
      episode.mint === missingOrganicBreakout.mint)?.strategyArm).not.toBe("BREAKOUT");
    expect(episodes.find((episode) =>
      episode.mint === highVolPullback.mint)?.strategyArm).not.toBe("PULLBACK_RECLAIM");
    expect(episodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        mint: highVolPullback.mint,
        strategyArm: "SIMULATION_PROBE",
        shadowOnly: true,
        executionTier: "SHADOW"
      })
    ]));
    expect(episodes.some((episode) => episode.strategyArm === "CONTROLLED_EXPLORATION"))
      .toBe(false);
    expect(engine.overview().simulationArena).toMatchObject({
      status: "COLLECTING",
      candidatePolicyCount: 7_776,
      pendingOrActiveProbePaths: 1,
      completedProbePaths: 0,
      capitalInfluenceEnabled: false,
      correlatedScenariosAreIndependentEvidence: false
    });
    expect(engine.candidateStrategy(highVolPullback, CAPTURED_AT, true)).toMatchObject({
      arm: "SIMULATION_PROBE",
      shadowOnly: true,
      modelAllowed: false,
      admission: {
        executionTier: "SHADOW",
        allowed: false,
        reasonCodes: expect.arrayContaining(["SHADOW_ONLY_ARM"])
      }
    });
    expect(repository.listExecutions()).toEqual([]);
    expect(repository.listPositions()).toEqual([]);
  });

  it("advances to new negative-control mints after the daily independence filter removes prior samples", async () => {
    mainDatabase = openDatabase(":memory:");
    learningDatabase = openLearningDatabase(":memory:");
    const repository = new Repository(mainDatabase);
    const learning = new AutonomousLearningRepository(learningDatabase);
    const lane = repository.createAutonomousPaperLane({
      id: "control-throughput-lane",
      policyVersion: AUTONOMOUS_PAPER_POLICY_VERSION,
      policy: { ...DEFAULT_AUTONOMOUS_PAPER_POLICY },
      initialNavUsd: 141,
      startedAt: CAPTURED_AT
    });
    repository.initializeAutonomousPaperAccount(lane.id, CAPTURED_AT);
    const negative = (mint: string, liquidityUsd: number) => token(mint, {
      liquidityUsd,
      stats5m: stats({
        priceChange: -5,
        buyOrganicVolume: 10_000,
        sellOrganicVolume: 90_000
      }),
      stats1h: stats({
        priceChange: -10,
        buyOrganicVolume: 50_000,
        sellOrganicVolume: 450_000
      }),
      stats6h: stats({ priceChange: -15 })
    });
    const controls = [
      negative("control-a", 3_000_000),
      negative("control-b", 2_000_000),
      negative("control-c", 1_000_000)
    ];
    const byMint = new Map(controls.map((candidate) => [candidate.mint, candidate]));
    let now = new Date(CAPTURED_AT);
    const engine = new AutonomousLearningEngine(repository, learning, {
      quote: async (request) => quoteFor(request, now, 19.8),
      lookupMints: async (mints) => mints.map((mint) => byMint.get(mint)!).filter(Boolean),
      solPriceUsd: () => 150,
      now: () => now,
      walletConfirmed: () => false
    });

    engine.ingestUniverse({
      lane,
      universe: { capturedAt: CAPTURED_AT, tokens: controls },
      tokens: controls
    });
    await engine.enqueueProcess();
    expect(learning.listEpisodes(["ACTIVE"]).map((episode) => episode.mint).sort())
      .toEqual(["control-a", "control-b"]);

    now = new Date("2026-07-15T00:03:00.000Z");
    engine.ingestUniverse({
      lane,
      universe: { capturedAt: now.toISOString(), tokens: controls },
      tokens: controls
    });
    await engine.enqueueProcess();

    expect(learning.listEpisodes(["ACTIVE"]).map((episode) => episode.mint).sort())
      .toEqual(["control-a", "control-b", "control-c"]);
    expect(repository.listExecutions()).toEqual([]);
    expect(repository.listPositions()).toEqual([]);
  });

  it("retries transient entry quote failures without poisoning the dataset", async () => {
    mainDatabase = openDatabase(":memory:");
    learningDatabase = openLearningDatabase(":memory:");
    const repository = new Repository(mainDatabase);
    const learning = new AutonomousLearningRepository(learningDatabase);
    const lane = repository.createAutonomousPaperLane({
      id: "retry-lane",
      policyVersion: AUTONOMOUS_PAPER_POLICY_VERSION,
      policy: { ...DEFAULT_AUTONOMOUS_PAPER_POLICY },
      initialNavUsd: 141,
      startedAt: CAPTURED_AT
    });
    repository.initializeAutonomousPaperAccount(lane.id, CAPTURED_AT);
    let now = new Date(CAPTURED_AT);
    const candidate = token("retry-mint");
    let quoteCalls = 0;
    const engine = new AutonomousLearningEngine(repository, learning, {
      quote: async (request) => {
        quoteCalls += 1;
        if (quoteCalls === 1) throw new Error("temporary provider timeout");
        return quoteFor(request, now, 19.8);
      },
      lookupMints: async () => [candidate],
      solPriceUsd: () => 150,
      now: () => now,
      walletConfirmed: () => true
    });

    engine.ingestUniverse({ lane, universe: { capturedAt: CAPTURED_AT, tokens: [candidate] }, tokens: [candidate] });
    await engine.enqueueProcess();
    expect(learning.listEpisodes(["PENDING_QUOTE"])[0]).toMatchObject({
      quoteAttempts: 1,
      failureCode: "temporary provider timeout",
      nextQuoteAttemptAt: "2026-07-15T00:01:00.000Z"
    });
    expect(learning.episodeCounts()).toMatchObject({ rejected: 0, unpriced: 0 });

    await engine.enqueueProcess();
    expect(quoteCalls).toBe(1);
    now = new Date("2026-07-15T00:01:00.000Z");
    await engine.enqueueProcess();
    const active = learning.listEpisodes(["ACTIVE"])[0]!;
    expect(active).toMatchObject({ quoteAttempts: 2 });
    expect(active).not.toHaveProperty("failureCode");
    expect(active).not.toHaveProperty("nextQuoteAttemptAt");
    expect(learning.episodeCounts()).toMatchObject({ rejected: 0, unpriced: 0 });
    expect(quoteCalls).toBe(3);
  });

  it("rejects structural safety failures immediately and samples hard-safe negative controls as shadow only", async () => {
    mainDatabase = openDatabase(":memory:");
    learningDatabase = openLearningDatabase(":memory:");
    const repository = new Repository(mainDatabase);
    const learning = new AutonomousLearningRepository(learningDatabase);
    const lane = repository.createAutonomousPaperLane({
      id: "control-lane",
      policyVersion: AUTONOMOUS_PAPER_V12_POLICY_VERSION,
      policy: { ...AUTONOMOUS_PAPER_V12_POLICY },
      initialNavUsd: 141,
      startedAt: CAPTURED_AT
    });
    repository.initializeAutonomousPaperAccount(lane.id, CAPTURED_AT);
    const unsafeAtQuoteTime = token("unsafe-mint", { suspicious: true });
    const negative = token("negative-control-mint", {
      stats5m: statsWithoutOrganic({
        priceChange: -10,
        liquidityChange: -10
      }),
      stats1h: statsWithoutOrganic({
        priceChange: -20,
        liquidityChange: -10
      }),
      stats6h: stats({ priceChange: -30 })
    });
    let now = new Date(CAPTURED_AT);
    const quote = vi.fn(async (request: QuoteRequest) => quoteFor(request, now, 19.8));
    const engine = new AutonomousLearningEngine(repository, learning, {
      quote,
      lookupMints: async (mints) => mints.map((mint) =>
        mint === unsafeAtQuoteTime.mint ? unsafeAtQuoteTime : negative
      ),
      solPriceUsd: () => 150,
      now: () => now,
      walletConfirmed: (mint) => mint === unsafeAtQuoteTime.mint
    });

    const initiallySafe = token(unsafeAtQuoteTime.mint);
    engine.ingestUniverse({
      lane,
      universe: { capturedAt: CAPTURED_AT, tokens: [initiallySafe, negative] },
      tokens: [initiallySafe, negative]
    });
    await engine.enqueueProcess();

    expect(learning.listEpisodes(["REJECTED"])[0]).toMatchObject({
      mint: unsafeAtQuoteTime.mint,
      failureCode: "LEARNING_TOKEN_SAFETY_FAILED",
      quoteAttempts: 1
    });
    const activeNegativeControl = learning.listEpisodes(["ACTIVE"])[0]!;
    expect(activeNegativeControl).toMatchObject({
      mint: negative.mint,
      strategyArm: "NEGATIVE_CONTROL",
      shadowOnly: true,
      executionTier: "SHADOW",
      featureVector: {
        negativeControl: true,
        datasetEligible: false,
        missingFeatureNames: expect.arrayContaining([
          "organicBuy5m",
          "organicBuy1h",
          "volumeAcceleration"
        ])
      }
    });
    learning.upsertEpisode({
      ...activeNegativeControl,
      featureVector: {
        ...activeNegativeControl.featureVector,
        datasetEligible: true
      }
    });
    await engine.enqueueProcess();
    expect(learning.getEpisode(activeNegativeControl.id)?.featureVector.datasetEligible).toBe(false);
    expect(repository.listExecutions()).toEqual([]);
    expect(repository.listPositions()).toEqual([]);
    expect(quote).toHaveBeenCalledTimes(2);
  });
});
