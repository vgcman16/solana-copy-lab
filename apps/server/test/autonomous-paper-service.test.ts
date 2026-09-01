import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type {
  AutonomousLearningOverview,
  AutonomousPaperEvent,
  AutonomousPaperPosition,
  ChampionPromotionDecision,
  PortfolioSnapshot
} from "@copylab/shared";
import { AppService } from "../src/app-service.js";
import { buildApp } from "../src/app.js";
import {
  AUTONOMOUS_PAPER_POLICY_VERSION,
  AUTONOMOUS_PAPER_V2_POLICY_VERSION,
  AUTONOMOUS_PAPER_V3_POLICY_VERSION,
  AUTONOMOUS_PAPER_V4_POLICY_VERSION,
  AUTONOMOUS_PAPER_V5_POLICY_VERSION,
  AUTONOMOUS_PAPER_V6_POLICY_VERSION,
  AUTONOMOUS_PAPER_V7_POLICY,
  AUTONOMOUS_PAPER_V7_POLICY_VERSION,
  AUTONOMOUS_PAPER_V8_POLICY,
  AUTONOMOUS_PAPER_V8_POLICY_VERSION,
  AUTONOMOUS_PAPER_V9_POLICY,
  AUTONOMOUS_PAPER_V9_POLICY_VERSION,
  DEFAULT_AUTONOMOUS_PAPER_POLICY,
  LEGACY_AUTONOMOUS_PAPER_POLICY,
  LEGACY_AUTONOMOUS_PAPER_POLICY_VERSION,
  normalizeAutonomousPaperPolicy
} from "../src/autonomous-paper-policy.js";
import type { CopyLabDatabase } from "../src/database.js";
import { openDatabase } from "../src/database.js";
import { EventBus } from "../src/events.js";
import { ModeManager } from "../src/mode.js";
import { Repository } from "../src/repository.js";
import { SecretVault } from "../src/vault.js";
import { WalletManager } from "../src/wallet.js";
import { MockRuntime } from "./helpers.js";

const NOW = "2026-07-14T12:00:00.000Z";
const SCAN_AT = "2026-07-14T12:03:08.000Z";
const LEARNING_OVERVIEW: AutonomousLearningOverview = {
  databaseSchemaVersion: 1,
  status: "COLLECTING",
  currentRegime: "CHOPPY",
  pendingEpisodes: 1,
  activeEpisodes: 2,
  completedExecutablePaths: 3,
  datasetEligiblePaths: 3,
  modelInfluenceEnabled: false,
  minimumPathsForModelInfluence: 200,
  quoteWorkBudgetFraction: 0.4,
  activeModels: [],
  armScores: [],
  challengers: [],
  recentAttributions: [],
  promotion: {
    id: "learning-promotion-blocked",
    allowed: false,
    blockerCodes: ["NEEDS_300_EXECUTABLE_SHADOW_PATHS"],
    observedDays: 1,
    executableShadowPaths: 3,
    championCompletedExits: 0,
    profitableWalkForwardFolds: 0,
    lowerConfidenceDifferencePercent: -100,
    decidedAt: NOW
  },
  updatedAt: NOW
};

class AutonomousConfigurationRuntime extends MockRuntime {
  autonomousRefreshes = 0;
  autonomousLearningTrains = 0;
  autonomousLearningPromotions = 0;
  failAutonomousRefreshAt?: number;
  onAutonomousRefresh?: (call: number) => void;

  async autonomousPaperConfigurationChanged(): Promise<void> {
    this.autonomousRefreshes += 1;
    this.onAutonomousRefresh?.(this.autonomousRefreshes);
    if (this.autonomousRefreshes === this.failAutonomousRefreshAt) {
      throw new Error(`autonomous refresh ${this.autonomousRefreshes} failed`);
    }
  }

  autonomousLearningOverview(): AutonomousLearningOverview {
    return LEARNING_OVERVIEW;
  }

  async trainAutonomousLearning(): Promise<AutonomousLearningOverview> {
    this.autonomousLearningTrains += 1;
    return { ...LEARNING_OVERVIEW, latestTrainingAt: NOW };
  }

  promoteAutonomousChallenger(confirmation: string): ChampionPromotionDecision {
    if (confirmation !== "PROMOTE AUTONOMOUS CHALLENGER") throw new Error("wrong confirmation");
    this.autonomousLearningPromotions += 1;
    return {
      ...LEARNING_OVERVIEW.promotion,
      id: "learning-promotion-approved",
      allowed: true,
      blockerCodes: []
    };
  }
}

describe("autonomous PAPER service and dashboard boundary", () => {
  let db: CopyLabDatabase | undefined;
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
    db?.close();
    db = undefined;
  });

  function setup() {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    repository.setSetting("mode", "PAPER");
    repository.setSetting("paper_initial_nav_usd", 141);
    const vault = new SecretVault(repository);
    const wallet = new WalletManager(vault, repository);
    const runtime = new AutonomousConfigurationRuntime();
    const service = new AppService(
      repository,
      vault,
      wallet,
      new ModeManager(repository, wallet),
      new EventBus(),
      runtime
    );
    return { repository, runtime, service };
  }

  function createPriorLane(
    repository: Repository,
    policyVersion = LEGACY_AUTONOMOUS_PAPER_POLICY_VERSION
  ) {
    const policy = policyVersion === LEGACY_AUTONOMOUS_PAPER_POLICY_VERSION
      ? { ...LEGACY_AUTONOMOUS_PAPER_POLICY }
      : normalizeAutonomousPaperPolicy(policyVersion, {});
    const lane = repository.createAutonomousPaperLane({
      id: `autonomous-prior:${policyVersion}`,
      policyVersion,
      policy,
      initialNavUsd: 141,
      startedAt: NOW
    });
    repository.initializeAutonomousPaperAccount(lane.id, NOW);
    return lane;
  }

  function seedOpenPosition(repository: Repository, laneId: string): AutonomousPaperPosition {
    const position: AutonomousPaperPosition = {
      id: "service-upgrade-drain-position",
      laneId,
      entryDecisionId: "service-upgrade-drain-entry",
      mint: "service-upgrade-drain-mint",
      symbol: "DRAIN",
      initialAmountAtomic: "28200000",
      remainingAmountAtomic: "28200000",
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
      openedAt: "2026-07-14T12:00:01.000Z",
      updatedAt: "2026-07-14T12:00:01.000Z"
    };
    repository.upsertAutonomousPaperPosition(position);
    const account = repository.getAutonomousPaperAccount(laneId)!;
    repository.upsertAutonomousPaperAccount({
      ...account,
      cashUsd: 112.8,
      navUsd: 140.7,
      peakNavUsd: 141,
      deployedUsd: 28.2,
      unrealizedPnlUsd: -0.3,
      maxDrawdownPercent: 0.3,
      openPositions: 1,
      pricingComplete: true,
      updatedAt: "2026-07-14T12:00:01.000Z"
    });
    return position;
  }

  function closeSeededPosition(
    repository: Repository,
    position: AutonomousPaperPosition,
    navUsd = 140
  ): void {
    repository.upsertAutonomousPaperPosition({
      ...position,
      remainingAmountAtomic: "0",
      remainingCostUsd: 0,
      lastExecutableValueUsd: 0,
      status: "CLOSED",
      closedAt: "2026-07-14T12:10:00.000Z",
      updatedAt: "2026-07-14T12:10:00.000Z"
    });
    const account = repository.getAutonomousPaperAccount(position.laneId)!;
    const realizedPnlUsd = navUsd - account.initialNavUsd;
    repository.upsertAutonomousPaperAccount({
      ...account,
      cashUsd: navUsd,
      navUsd,
      deployedUsd: 0,
      realizedPnlUsd,
      unrealizedPnlUsd: 0,
      grossProfitUsd: Math.max(0, realizedPnlUsd),
      grossLossUsd: Math.max(0, -realizedPnlUsd),
      completedTrades: 1,
      winningTrades: realizedPnlUsd > 0 ? 1 : 0,
      openPositions: 0,
      maxDrawdownPercent: Math.max(
        account.maxDrawdownPercent,
        account.peakNavUsd > 0 ? (account.peakNavUsd - navUsd) / account.peakNavUsd * 100 : 0
      ),
      pricingComplete: true,
      updatedAt: "2026-07-14T12:10:00.000Z"
    });
  }

  it("enables, pauses, and resumes one isolated account without resetting its PAPER result", async () => {
    const { repository, runtime, service } = setup();

    const enabled = await service.setAutonomousPaperEnabled(true);
    expect(enabled).toMatchObject({
      promotionEligible: false,
      executionEnabled: false,
      lane: {
        status: "ACTIVE",
        initialNavUsd: 141,
        policyVersion: AUTONOMOUS_PAPER_POLICY_VERSION,
        policy: DEFAULT_AUTONOMOUS_PAPER_POLICY
      },
      account: { initialNavUsd: 141, navUsd: 141, cashUsd: 141 }
    });
    const laneId = enabled.lane!.id;
    repository.upsertAutonomousPaperAccount({
      ...enabled.account!,
      cashUsd: 118,
      navUsd: 147,
      peakNavUsd: 149,
      deployedUsd: 29,
      unrealizedPnlUsd: 6,
      maxDrawdownPercent: 3,
      openPositions: 1,
      updatedAt: "2026-07-14T12:01:00.000Z"
    });

    const paused = await service.setAutonomousPaperEnabled(false);
    expect(paused.lane).toMatchObject({ id: laneId, status: "PAUSED" });
    const resumed = await service.setAutonomousPaperEnabled(true);
    expect(resumed).toMatchObject({
      lane: { id: laneId, status: "ACTIVE" },
      account: { navUsd: 147, cashUsd: 118, openPositions: 1 }
    });
    expect(runtime.autonomousRefreshes).toBe(3);

    expect(repository.listExecutions()).toEqual([]);
    expect(repository.listPositions()).toEqual([]);
    expect(repository.listClosedTrades("PAPER")).toEqual([]);
    expect(repository.db.prepare("SELECT COUNT(*) AS count FROM signal_decisions").get())
      .toEqual({ count: 0 });
    expect(repository.listAudit(10)).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventType: "autonomous_paper_enabled" }),
      expect.objectContaining({ eventType: "autonomous_paper_paused" })
    ]));
  });

  it("stops the lane when exact PAPER mode ends and rejects configuration outside PAPER", async () => {
    const { repository, service } = setup();
    const enabled = await service.setAutonomousPaperEnabled(true);

    await service.pause();

    expect(repository.getAutonomousPaperLane(enabled.lane!.id)?.status).toBe("PAUSED");
    await expect(service.setAutonomousPaperEnabled(true)).rejects.toThrow("exact PAPER mode");
    await expect(service.setAutonomousPaperEnabled(false)).rejects.toThrow("exact PAPER mode");
  });

  it("explicitly pauses, drains, rotates a flat v2 lane to current v10, and requeues only the new lane", async () => {
    const { repository, runtime, service } = setup();
    const prior = createPriorLane(repository, AUTONOMOUS_PAPER_V2_POLICY_VERSION);
    const initialPriorAccount = repository.getAutonomousPaperAccount(prior.id)!;
    const priorAccount = {
      ...initialPriorAccount,
      cashUsd: 145,
      navUsd: 145,
      peakNavUsd: 145,
      realizedPnlUsd: 4,
      grossProfitUsd: 4,
      updatedAt: "2026-07-14T12:05:00.000Z"
    };
    repository.upsertAutonomousPaperAccount(priorAccount);
    const order: string[] = [];
    const pause = repository.pauseAutonomousPaperLane.bind(repository);
    const rotate = repository.rotateAutonomousPaperLane.bind(repository);
    vi.spyOn(repository, "pauseAutonomousPaperLane").mockImplementation((...args) => {
      order.push("pause-prior");
      return pause(...args);
    });
    vi.spyOn(repository, "rotateAutonomousPaperLane").mockImplementation((input) => {
      order.push("rotate-current");
      expect(repository.activeAutonomousPaperLane()).toBeUndefined();
      return rotate(input);
    });
    runtime.onAutonomousRefresh = (call) => {
      order.push(call === 1 ? "drain-prior" : "requeue-current");
      if (call === 1) expect(repository.activeAutonomousPaperLane()).toBeUndefined();
      if (call === 2) {
        expect(repository.activeAutonomousPaperLane()?.policyVersion)
          .toBe(AUTONOMOUS_PAPER_POLICY_VERSION);
      }
    };

    const upgraded = await service.upgradeAutonomousPaperPolicy(true);

    expect(order).toEqual(["pause-prior", "drain-prior", "rotate-current", "requeue-current"]);
    expect(runtime.autonomousRefreshes).toBe(2);
    expect(repository.getAutonomousPaperLane(prior.id)).toMatchObject({
      status: "ARCHIVED",
      policyVersion: AUTONOMOUS_PAPER_V2_POLICY_VERSION
    });
    expect(repository.getAutonomousPaperAccount(prior.id)).toEqual(priorAccount);
    expect(upgraded).toMatchObject({
      promotionEligible: false,
      executionEnabled: false,
      lane: {
        status: "ACTIVE",
        policyVersion: AUTONOMOUS_PAPER_POLICY_VERSION,
        policy: DEFAULT_AUTONOMOUS_PAPER_POLICY
      },
      account: { initialNavUsd: 145, navUsd: 145, cashUsd: 145 }
    });
    expect(upgraded.lane?.id).not.toBe(prior.id);
    expect(repository.listExecutions()).toEqual([]);
    expect(repository.listPositions()).toEqual([]);
    expect(repository.listAudit(20)).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventType: "autonomous_paper_policy_upgraded" })
    ]));
  });

  it("accepts a flat v3 lane as an explicit prior epoch for v10", async () => {
    const { repository, runtime, service } = setup();
    const prior = createPriorLane(repository, AUTONOMOUS_PAPER_V3_POLICY_VERSION);

    const upgraded = await service.upgradeAutonomousPaperPolicy(true);

    expect(runtime.autonomousRefreshes).toBe(2);
    expect(repository.getAutonomousPaperLane(prior.id)).toMatchObject({
      status: "ARCHIVED",
      policyVersion: AUTONOMOUS_PAPER_V3_POLICY_VERSION,
      policy: expect.objectContaining({ allowToken2022: false })
    });
    expect(upgraded).toMatchObject({
      promotionEligible: false,
      executionEnabled: false,
      lane: {
        status: "ACTIVE",
        policyVersion: AUTONOMOUS_PAPER_POLICY_VERSION,
        policy: expect.objectContaining({
          allowToken2022: true,
          maximumEntriesPerUtcDay: Number.MAX_SAFE_INTEGER,
          minimumEntrySpacingMinutes: 10
        })
      },
      account: { initialNavUsd: 141, navUsd: 141, cashUsd: 141 }
    });
  });

  it("accepts a flat v4 lane and starts current learning from a clean lane-local sample", async () => {
    const { repository, runtime, service } = setup();
    const prior = createPriorLane(repository, AUTONOMOUS_PAPER_V4_POLICY_VERSION);

    const upgraded = await service.upgradeAutonomousPaperPolicy(true);

    expect(runtime.autonomousRefreshes).toBe(2);
    expect(repository.getAutonomousPaperLane(prior.id)).toMatchObject({
      status: "ARCHIVED",
      policyVersion: AUTONOMOUS_PAPER_V4_POLICY_VERSION,
      policy: expect.objectContaining({
        allowToken2022: true,
        adaptiveSizingEnabled: false
      })
    });
    expect(upgraded).toMatchObject({
      promotionEligible: false,
      executionEnabled: false,
      lane: {
        status: "ACTIVE",
        policyVersion: AUTONOMOUS_PAPER_POLICY_VERSION,
        policy: expect.objectContaining({
          adaptiveSizingEnabled: true,
          adaptiveSizingMinimumTrades: 20,
          riskAtStopSizingEnabled: true,
          maximumPositionUsd: Number.MAX_SAFE_INTEGER,
          positionNavFraction: 0.4,
          maximumDeployedFraction: 0.9
        })
      },
      account: { completedTrades: 0, initialNavUsd: 141, navUsd: 141, cashUsd: 141 }
    });
    expect(repository.listAutonomousPaperTradesForCalibration(upgraded.lane!.id)).toEqual([]);
  });

  it("rotates flat v5 to the current risk-sized contextual v10 policy without rewriting v5 evidence", async () => {
    const { repository, runtime, service } = setup();
    const prior = createPriorLane(repository, AUTONOMOUS_PAPER_V5_POLICY_VERSION);

    const upgraded = await service.upgradeAutonomousPaperPolicy(true);

    expect(runtime.autonomousRefreshes).toBe(2);
    expect(repository.getAutonomousPaperLane(prior.id)).toMatchObject({
      status: "ARCHIVED",
      policyVersion: AUTONOMOUS_PAPER_V5_POLICY_VERSION,
      policy: {
        adaptiveSizingEnabled: true,
        maximumPositionUsd: 50,
        positionNavFraction: 0.2
      }
    });
    expect(upgraded).toMatchObject({
      executionEnabled: false,
      promotionEligible: false,
      lane: {
        status: "ACTIVE",
        policyVersion: AUTONOMOUS_PAPER_POLICY_VERSION,
        policy: {
          adaptiveSizingEnabled: true,
          contextualRewardEnabled: true,
          riskAtStopSizingEnabled: true,
          maximumPositionUsd: Number.MAX_SAFE_INTEGER,
          positionNavFraction: 0.4,
          maximumDeployedFraction: 0.9
        }
      },
      account: { initialNavUsd: 141, navUsd: 141, cashUsd: 141, openPositions: 0 }
    });
  });

  it("rotates a flat v6 lane to v10 contextual learning and risk-at-stop caps", async () => {
    const { repository, runtime, service } = setup();
    const prior = createPriorLane(repository, AUTONOMOUS_PAPER_V6_POLICY_VERSION);

    const upgraded = await service.upgradeAutonomousPaperPolicy(true);

    expect(runtime.autonomousRefreshes).toBe(2);
    expect(repository.getAutonomousPaperLane(prior.id)).toMatchObject({
      status: "ARCHIVED",
      policyVersion: AUTONOMOUS_PAPER_V6_POLICY_VERSION,
      policy: {
        adaptiveSizingEnabled: true,
        contextualRewardEnabled: false,
        maximumPositionUsd: Number.MAX_SAFE_INTEGER,
        positionNavFraction: 0.35,
        maximumDeployedFraction: 0.8
      }
    });
    expect(upgraded).toMatchObject({
      executionEnabled: false,
      promotionEligible: false,
      lane: {
        policyVersion: AUTONOMOUS_PAPER_POLICY_VERSION,
        policy: {
          contextualRewardEnabled: true,
          contextualRewardMinimumComparableTrades: 8,
          contextualRewardMinimumDistinctMints: 4,
          contextualRewardMinimumDistinctUtcDays: 3,
          riskAtStopSizingEnabled: true,
          positionNavFraction: 0.4
        }
      }
    });
  });

  it("explicitly rotates a flat contextual v7 lane to current v10 without changing NAV or frozen v7 evidence", async () => {
    const { repository, runtime, service } = setup();
    const prior = createPriorLane(repository, AUTONOMOUS_PAPER_V7_POLICY_VERSION);
    const priorAccount = repository.getAutonomousPaperAccount(prior.id)!;

    const upgraded = await service.upgradeAutonomousPaperPolicy(true);

    expect(runtime.autonomousRefreshes).toBe(2);
    expect(repository.getAutonomousPaperLane(prior.id)).toMatchObject({
      status: "ARCHIVED",
      policyVersion: AUTONOMOUS_PAPER_V7_POLICY_VERSION,
      policy: AUTONOMOUS_PAPER_V7_POLICY
    });
    expect(repository.getAutonomousPaperAccount(prior.id)).toEqual(priorAccount);
    expect(upgraded).toMatchObject({
      executionEnabled: false,
      promotionEligible: false,
      lane: {
        status: "ACTIVE",
        policyVersion: AUTONOMOUS_PAPER_POLICY_VERSION,
        policy: DEFAULT_AUTONOMOUS_PAPER_POLICY
      },
      account: {
        initialNavUsd: priorAccount.navUsd,
        cashUsd: priorAccount.navUsd,
        navUsd: priorAccount.navUsd,
        openPositions: 0,
        completedTrades: 0
      }
    });
    expect(upgraded.lane?.id).not.toBe(prior.id);
  });

  it("rotates the flat v8 experiment to v10 risk-at-stop learning", async () => {
    const { repository, runtime, service } = setup();
    const prior = createPriorLane(repository, AUTONOMOUS_PAPER_V8_POLICY_VERSION);
    const priorAccount = repository.getAutonomousPaperAccount(prior.id)!;

    const upgraded = await service.upgradeAutonomousPaperPolicy(true);

    expect(runtime.autonomousRefreshes).toBe(2);
    expect(repository.getAutonomousPaperLane(prior.id)).toMatchObject({
      status: "ARCHIVED",
      policyVersion: AUTONOMOUS_PAPER_V8_POLICY_VERSION,
      policy: AUTONOMOUS_PAPER_V8_POLICY
    });
    expect(upgraded).toMatchObject({
      executionEnabled: false,
      promotionEligible: false,
      lane: {
        status: "ACTIVE",
        policyVersion: AUTONOMOUS_PAPER_POLICY_VERSION,
        policy: {
          maximumEntriesPerUtcDay: Number.MAX_SAFE_INTEGER,
          minimumEntrySpacingMinutes: AUTONOMOUS_PAPER_V8_POLICY.minimumEntrySpacingMinutes,
          riskAtStopSizingEnabled: true,
          maximumOpenPositions: 4,
          maximumDeployedFraction: 0.9
        }
      },
      account: {
        initialNavUsd: priorAccount.navUsd,
        navUsd: priorAccount.navUsd,
        cashUsd: priorAccount.navUsd,
        openPositions: 0
      }
    });
  });

  it("rotates the flat v9 experiment to v10 without rewriting frozen v9 evidence", async () => {
    const { repository, runtime, service } = setup();
    const prior = createPriorLane(repository, AUTONOMOUS_PAPER_V9_POLICY_VERSION);
    const priorAccount = repository.getAutonomousPaperAccount(prior.id)!;

    const upgraded = await service.upgradeAutonomousPaperPolicy(true);

    expect(runtime.autonomousRefreshes).toBe(2);
    expect(repository.getAutonomousPaperLane(prior.id)).toMatchObject({
      status: "ARCHIVED",
      policyVersion: AUTONOMOUS_PAPER_V9_POLICY_VERSION,
      policy: AUTONOMOUS_PAPER_V9_POLICY
    });
    expect(upgraded).toMatchObject({
      executionEnabled: false,
      promotionEligible: false,
      lane: {
        status: "ACTIVE",
        policyVersion: AUTONOMOUS_PAPER_POLICY_VERSION,
        policy: DEFAULT_AUTONOMOUS_PAPER_POLICY
      },
      account: {
        initialNavUsd: priorAccount.navUsd,
        navUsd: priorAccount.navUsd,
        cashUsd: priorAccount.navUsd,
        openPositions: 0
      }
    });
  });

  it("durably drains an open v7 lane, stays idempotent, then rotates only after a second flat confirmation", async () => {
    const { repository, runtime, service } = setup();
    const prior = createPriorLane(repository, AUTONOMOUS_PAPER_V7_POLICY_VERSION);
    const position = seedOpenPosition(repository, prior.id);

    const draining = await service.upgradeAutonomousPaperPolicy(true);
    const firstRequestedAt = draining.upgradeDrain?.requestedAt;

    expect(draining).toMatchObject({
      executionEnabled: false,
      promotionEligible: false,
      lane: {
        id: prior.id,
        status: "ACTIVE",
        policyVersion: AUTONOMOUS_PAPER_V7_POLICY_VERSION
      },
      account: { openPositions: 1 },
      upgradeDrain: {
        laneId: prior.id,
        fromPolicyVersion: AUTONOMOUS_PAPER_V7_POLICY_VERSION,
        toPolicyVersion: AUTONOMOUS_PAPER_POLICY_VERSION
      }
    });
    expect(runtime.autonomousRefreshes).toBe(1);
    expect(repository.getAutonomousPaperLane(prior.id)?.status).toBe("ACTIVE");

    const repeated = await service.upgradeAutonomousPaperPolicy(true);
    expect(repeated.lane?.id).toBe(prior.id);
    expect(repeated.upgradeDrain?.requestedAt).toBe(firstRequestedAt);
    expect(runtime.autonomousRefreshes).toBe(2);
    expect(repository.listAudit(50).filter((event) =>
      event.eventType === "autonomous_paper_policy_upgrade_drain_requested"
    )).toHaveLength(1);

    closeSeededPosition(repository, position, 140);
    const order: string[] = [];
    const pause = repository.pauseAutonomousPaperLane.bind(repository);
    const rotate = repository.rotateAutonomousPaperLane.bind(repository);
    vi.spyOn(repository, "pauseAutonomousPaperLane").mockImplementation((...args) => {
      order.push("pause-prior");
      return pause(...args);
    });
    vi.spyOn(repository, "rotateAutonomousPaperLane").mockImplementation((input) => {
      order.push("rotate-current");
      return rotate(input);
    });
    runtime.onAutonomousRefresh = (call) => {
      if (call === 3) order.push("drain-prior");
      if (call === 4) order.push("requeue-current");
    };

    const upgraded = await service.upgradeAutonomousPaperPolicy(true);

    expect(order).toEqual(["pause-prior", "drain-prior", "rotate-current", "requeue-current"]);
    expect(upgraded).toMatchObject({
      lane: { status: "ACTIVE", policyVersion: AUTONOMOUS_PAPER_POLICY_VERSION },
      account: { initialNavUsd: 140, cashUsd: 140, navUsd: 140, openPositions: 0 },
      positions: []
    });
    expect(upgraded.lane?.id).not.toBe(prior.id);
    expect(repository.getAutonomousPaperLane(prior.id)?.status).toBe("ARCHIVED");
    expect(repository.getAutonomousPaperUpgradeDrain(prior.id)).toBeUndefined();
    expect(repository.autonomousPaperUpgradeDrainBlocksEntries(upgraded.lane!.id)).toBe(false);
  });

  it("preserves a durable upgrade drain when flat rotation fails and restores v7", async () => {
    const { repository, service } = setup();
    const prior = createPriorLane(repository, AUTONOMOUS_PAPER_V7_POLICY_VERSION);
    const position = seedOpenPosition(repository, prior.id);
    await service.upgradeAutonomousPaperPolicy(true);
    closeSeededPosition(repository, position, 140);
    vi.spyOn(repository, "rotateAutonomousPaperLane").mockImplementation(() => {
      throw new Error("rotation transaction failed");
    });

    await expect(service.upgradeAutonomousPaperPolicy(true))
      .rejects.toThrow("rotation transaction failed");

    expect(repository.activeAutonomousPaperLane()).toMatchObject({
      id: prior.id,
      status: "ACTIVE",
      policyVersion: AUTONOMOUS_PAPER_V7_POLICY_VERSION
    });
    expect(repository.getAutonomousPaperUpgradeDrain(prior.id)).toMatchObject({
      toPolicyVersion: AUTONOMOUS_PAPER_POLICY_VERSION
    });
    expect(repository.autonomousPaperUpgradeDrainBlocksEntries(prior.id)).toBe(true);
  });

  it("rejects a pending drain targeting a different future policy", async () => {
    const { repository, runtime, service } = setup();
    const prior = createPriorLane(repository, AUTONOMOUS_PAPER_V7_POLICY_VERSION);
    seedOpenPosition(repository, prior.id);
    repository.requestAutonomousPaperUpgradeDrain({
      laneId: prior.id,
      fromPolicyVersion: prior.policyVersion,
      toPolicyVersion: "autonomous-momentum-paper-v999"
    });

    await expect(service.upgradeAutonomousPaperPolicy(true))
      .rejects.toThrow("targets a different policy version");

    expect(runtime.autonomousRefreshes).toBe(0);
    expect(repository.activeAutonomousPaperLane()?.id).toBe(prior.id);
    expect(repository.autonomousPaperUpgradeDrainBlocksEntries(prior.id)).toBe(true);
  });

  it("requires confirmation and exact PAPER before touching a supported prior lane", async () => {
    const { repository, service } = setup();
    const prior = createPriorLane(repository);

    await expect(service.upgradeAutonomousPaperPolicy(false))
      .rejects.toThrow("explicit confirmation");
    expect(repository.getAutonomousPaperLane(prior.id)?.status).toBe("ACTIVE");

    repository.setSetting("mode", "MANUAL_LIVE");
    await expect(service.upgradeAutonomousPaperPolicy(true))
      .rejects.toThrow("exact PAPER mode");
    expect(repository.getAutonomousPaperLane(prior.id)?.status).toBe("ACTIVE");
  });

  it("resumes and requeues the prior lane when rotation fails after the drain", async () => {
    const { repository, runtime, service } = setup();
    const prior = createPriorLane(repository);
    vi.spyOn(repository, "rotateAutonomousPaperLane").mockImplementation(() => {
      throw new Error("rotation transaction failed");
    });

    await expect(service.upgradeAutonomousPaperPolicy(true))
      .rejects.toThrow("rotation transaction failed");

    expect(runtime.autonomousRefreshes).toBe(2);
    expect(repository.activeAutonomousPaperLane()).toMatchObject({
      id: prior.id,
      status: "ACTIVE",
      policyVersion: LEGACY_AUTONOMOUS_PAPER_POLICY_VERSION
    });
    expect(repository.latestAutonomousPaperLane()?.id).toBe(prior.id);
  });

  it("resumes the prior lane without attempting rotation when the pre-rotation drain fails", async () => {
    const { repository, runtime, service } = setup();
    const prior = createPriorLane(repository);
    runtime.failAutonomousRefreshAt = 1;
    const rotate = vi.spyOn(repository, "rotateAutonomousPaperLane");

    await expect(service.upgradeAutonomousPaperPolicy(true))
      .rejects.toThrow("autonomous refresh 1 failed");

    expect(rotate).not.toHaveBeenCalled();
    expect(runtime.autonomousRefreshes).toBe(2);
    expect(repository.activeAutonomousPaperLane()).toMatchObject({
      id: prior.id,
      status: "ACTIVE",
      policyVersion: LEGACY_AUTONOMOUS_PAPER_POLICY_VERSION
    });
  });

  it("keeps the durable current-policy lane active after an immediate requeue failure", async () => {
    const { repository, runtime, service } = setup();
    const prior = createPriorLane(repository, AUTONOMOUS_PAPER_V2_POLICY_VERSION);
    runtime.failAutonomousRefreshAt = 2;

    const upgraded = await service.upgradeAutonomousPaperPolicy(true);

    expect(upgraded).toMatchObject({
      executionEnabled: false,
      promotionEligible: false,
      lane: { status: "ACTIVE", policyVersion: AUTONOMOUS_PAPER_POLICY_VERSION }
    });
    expect(repository.getAutonomousPaperLane(prior.id)?.status).toBe("ARCHIVED");
    expect(repository.activeAutonomousPaperLane()?.id).toBe(upgraded.lane?.id);
    expect(repository.listAudit(20)).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventType: "autonomous_paper_upgrade_requeue_failed" })
    ]));
  });

  it("refuses to rotate an already-current v10 lane", async () => {
    const { repository, runtime, service } = setup();
    const current = repository.createAutonomousPaperLane({
      id: "autonomous-current-policy",
      policyVersion: AUTONOMOUS_PAPER_POLICY_VERSION,
      policy: { ...DEFAULT_AUTONOMOUS_PAPER_POLICY },
      initialNavUsd: 141,
      startedAt: NOW
    });
    repository.initializeAutonomousPaperAccount(current.id, NOW);

    await expect(service.upgradeAutonomousPaperPolicy(true))
      .rejects.toThrow("already uses the current policy version");

    expect(runtime.autonomousRefreshes).toBe(0);
    expect(repository.activeAutonomousPaperLane()).toMatchObject({
      id: current.id,
      status: "ACTIVE",
      policyVersion: AUTONOMOUS_PAPER_POLICY_VERSION
    });
  });

  it("exposes learning status read-only and protects train/promotion mutations with CSRF and exact phrases", async () => {
    const { runtime, service } = setup();
    app = await buildApp(service);

    const status = await app.inject({ method: "GET", url: "/api/autonomous-learning" });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      status: "COLLECTING",
      modelInfluenceEnabled: false,
      datasetEligiblePaths: 3
    });
    const denied = await app.inject({
      method: "POST",
      url: "/api/autonomous-learning/train",
      payload: { confirmation: "TRAIN AUTONOMOUS LEARNER" }
    });
    expect(denied.statusCode).toBe(403);

    const csrf = await app.inject({ method: "GET", url: "/api/security/csrf" });
    const token = csrf.json<{ csrfToken: string }>().csrfToken;
    const rawCookie = csrf.headers["set-cookie"];
    const headers = {
      cookie: Array.isArray(rawCookie) ? rawCookie[0]! : rawCookie!,
      "x-csrf-token": token
    };
    const wrongTrain = await app.inject({
      method: "POST",
      url: "/api/autonomous-learning/train",
      headers,
      payload: { confirmation: "train" }
    });
    expect(wrongTrain.statusCode).toBe(400);
    const trained = await app.inject({
      method: "POST",
      url: "/api/autonomous-learning/train",
      headers,
      payload: { confirmation: "TRAIN AUTONOMOUS LEARNER" }
    });
    expect(trained.statusCode).toBe(200);
    expect(trained.json()).toMatchObject({ latestTrainingAt: NOW });
    expect(runtime.autonomousLearningTrains).toBe(1);

    const wrongPromotion = await app.inject({
      method: "POST",
      url: "/api/autonomous-learning/promote",
      headers,
      payload: { confirmation: "PROMOTE" }
    });
    expect(wrongPromotion.statusCode).toBe(400);
    expect(runtime.autonomousLearningPromotions).toBe(0);
    const promoted = await app.inject({
      method: "POST",
      url: "/api/autonomous-learning/promote",
      headers,
      payload: { confirmation: "PROMOTE AUTONOMOUS CHALLENGER" }
    });
    expect(promoted.statusCode).toBe(200);
    expect(promoted.json()).toMatchObject({ allowed: true, blockerCodes: [] });
    expect(runtime.autonomousLearningPromotions).toBe(1);
  });

  it("protects the strict autonomous toggle route with session CSRF and exact payload validation", async () => {
    const { service } = setup();
    app = await buildApp(service);

    const denied = await app.inject({
      method: "POST",
      url: "/api/autonomous-paper",
      payload: { enabled: true }
    });
    expect(denied.statusCode).toBe(403);

    const csrf = await app.inject({ method: "GET", url: "/api/security/csrf" });
    const token = csrf.json<{ csrfToken: string }>().csrfToken;
    const rawCookie = csrf.headers["set-cookie"];
    const headers = {
      cookie: Array.isArray(rawCookie) ? rawCookie[0]! : rawCookie!,
      "x-csrf-token": token
    };

    const extraField = await app.inject({
      method: "POST",
      url: "/api/autonomous-paper",
      headers,
      payload: { enabled: true, executionEnabled: true }
    });
    expect(extraField.statusCode).toBe(400);

    const enabled = await app.inject({
      method: "POST",
      url: "/api/autonomous-paper",
      headers,
      payload: { enabled: true }
    });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json()).toMatchObject({
      promotionEligible: false,
      executionEnabled: false,
      lane: { status: "ACTIVE", initialNavUsd: 141 },
      account: { navUsd: 141 }
    });

    const paused = await app.inject({
      method: "POST",
      url: "/api/autonomous-paper",
      headers,
      payload: { enabled: false }
    });
    expect(paused.statusCode).toBe(200);
    expect(paused.json()).toMatchObject({
      promotionEligible: false,
      executionEnabled: false,
      lane: { status: "PAUSED" }
    });
  });

  it("protects the explicit policy-upgrade route with CSRF and strict confirmation", async () => {
    const { repository, service } = setup();
    createPriorLane(repository, AUTONOMOUS_PAPER_V2_POLICY_VERSION);
    app = await buildApp(service);

    const denied = await app.inject({
      method: "POST",
      url: "/api/autonomous-paper/upgrade",
      payload: { confirmed: true }
    });
    expect(denied.statusCode).toBe(403);

    const csrf = await app.inject({ method: "GET", url: "/api/security/csrf" });
    const token = csrf.json<{ csrfToken: string }>().csrfToken;
    const rawCookie = csrf.headers["set-cookie"];
    const headers = {
      cookie: Array.isArray(rawCookie) ? rawCookie[0]! : rawCookie!,
      "x-csrf-token": token
    };

    for (const payload of [
      {},
      { confirmed: false },
      { confirmed: true, executionEnabled: true },
      { confirmed: true, policyVersion: "attacker-policy" }
    ]) {
      const rejected = await app.inject({
        method: "POST",
        url: "/api/autonomous-paper/upgrade",
        headers,
        payload
      });
      expect(rejected.statusCode).toBe(400);
    }

    const upgraded = await app.inject({
      method: "POST",
      url: "/api/autonomous-paper/upgrade",
      headers,
      payload: { confirmed: true }
    });
    expect(upgraded.statusCode).toBe(200);
    expect(upgraded.json()).toMatchObject({
      promotionEligible: false,
      executionEnabled: false,
      lane: { status: "ACTIVE", policyVersion: AUTONOMOUS_PAPER_POLICY_VERSION }
    });
  });

  it("normalizes independent wallet accounts to one $141 bankroll instead of pooling them", async () => {
    const { repository, service } = setup();
    const strictPortfolio: PortfolioSnapshot = {
      mode: "PAPER",
      capturedAt: NOW,
      navUsd: 145,
      peakNavUsd: 146,
      dayStartNavUsd: 141,
      deployedUsd: 0,
      solReserveUsd: 5,
      liquidReserveUsd: 145,
      realizedPnlUsd: 3,
      unrealizedPnlUsd: 1,
      openPositions: 0,
      balanceMismatchPercent: 0,
      executablePricingComplete: true
    };
    repository.savePortfolioSnapshot(strictPortfolio);

    const researchLane = repository.createResearchPaperLane({
      id: "comparison-wallet-copy",
      policyVersion: "comparison-v1",
      initialNavPerLeaderUsd: 141,
      startedAt: NOW
    });
    const leaderOne = repository.initializeResearchPaperLeader("A".repeat(44), researchLane.id, NOW);
    const leaderTwo = repository.initializeResearchPaperLeader("B".repeat(44), researchLane.id, NOW);
    repository.upsertResearchPaperLeader({
      ...leaderOne,
      cashUsd: 140,
      navUsd: 171,
      peakNavUsd: 175,
      realizedPnlUsd: 20,
      unrealizedPnlUsd: 10,
      maxDrawdownPercent: 4,
      openPositions: 2,
      completedTrades: 3,
      updatedAt: NOW
    });
    repository.upsertResearchPaperLeader({
      ...leaderTwo,
      cashUsd: 125,
      navUsd: 125,
      peakNavUsd: 141,
      realizedPnlUsd: -10,
      unrealizedPnlUsd: -6,
      maxDrawdownPercent: 16,
      openPositions: 0,
      completedTrades: 1,
      pricingComplete: false,
      updatedAt: NOW
    });

    const autonomousLane = repository.createAutonomousPaperLane({
      id: "comparison-autonomous",
      policyVersion: "autonomous-momentum-v1",
      policy: { ...DEFAULT_AUTONOMOUS_PAPER_POLICY },
      initialNavUsd: 141,
      startedAt: NOW
    });
    const autonomous = repository.initializeAutonomousPaperAccount(autonomousLane.id, NOW);
    repository.upsertAutonomousPaperAccount({
      ...autonomous,
      cashUsd: 130,
      navUsd: 155,
      peakNavUsd: 160,
      deployedUsd: 25,
      realizedPnlUsd: 14,
      unrealizedPnlUsd: 0,
      maxDrawdownPercent: 12,
      openPositions: 1,
      completedTrades: 4,
      winningTrades: 3,
      grossProfitUsd: 18,
      grossLossUsd: 4,
      updatedAt: NOW
    });
    const scan: AutonomousPaperEvent = {
      eventKey: "autonomous-cycle-v1:comparison-autonomous",
      laneId: autonomousLane.id,
      kind: "NAV_MARK",
      outcome: "CLAIMED",
      observedAt: "2026-07-14T12:03:00.000Z"
    };
    expect(repository.claimAutonomousPaperEvent(scan)).toBe(true);
    expect(repository.finalizeAutonomousPaperEvent({
      ...scan,
      outcome: "SIMULATED",
      navUsd: 155,
      reason: "Comparison scan completed without changing the account.",
      finalizedAt: SCAN_AT
    })).toBe(true);

    const dashboard = service.dashboard();
    expect(dashboard.paperComparisons).toHaveLength(3);
    expect(dashboard.paperComparisons?.map((comparison) => comparison.kind)).toEqual([
      "STRICT_COPY",
      "HIGH_RISK_COPY",
      "AUTONOMOUS_HIGH_RISK"
    ]);
    expect(dashboard.paperComparisons?.find(({ kind }) => kind === "STRICT_COPY"))
      .toMatchObject({
        basis: "SINGLE_ACCOUNT",
        initialNavUsd: 141,
        normalizedNavUsd: 145,
        normalizedPnlUsd: 4,
        realizedPnlUsd: 3,
        unrealizedPnlUsd: 1
      });
    expect(dashboard.paperComparisons?.find(({ kind }) => kind === "HIGH_RISK_COPY"))
      .toMatchObject({
        basis: "EQUAL_WEIGHT_PER_ACCOUNT",
        sampleSize: 2,
        initialNavUsd: 141,
        normalizedNavUsd: 148,
        normalizedPnlUsd: 7,
        realizedPnlUsd: 5,
        unrealizedPnlUsd: 2,
        maxDrawdownPercent: 10,
        completedTrades: 4,
        openPositions: 2,
        pricingComplete: false,
        evidenceStatus: "PRICING_INCOMPLETE",
        robustNormalizedNavUsd: 125,
        robustNormalizedPnlUsd: -16,
        robustNetReturnPercent: -16 / 141 * 100,
        excludedOutlierWallet: "A".repeat(44),
        excludedOutlierPnlUsd: 30,
        reconciliationDependentAccountCount: 1
      });
    expect(dashboard.paperComparisons?.find(({ kind }) => kind === "AUTONOMOUS_HIGH_RISK"))
      .toMatchObject({
        basis: "SINGLE_ACCOUNT",
        sampleSize: 1,
        initialNavUsd: 141,
        normalizedNavUsd: 155,
        normalizedPnlUsd: 14,
        realizedPnlUsd: 14,
        unrealizedPnlUsd: 0,
        winRatePercent: 75,
        profitFactor: 4.5,
        updatedAt: SCAN_AT,
        accountUpdatedAt: NOW
      });
    expect(dashboard.paperComparisons?.find(({ kind }) => kind === "HIGH_RISK_COPY")?.normalizedNavUsd)
      .not.toBe(296);
  });
});
