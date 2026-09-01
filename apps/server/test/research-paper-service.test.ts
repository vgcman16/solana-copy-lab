import { afterEach, describe, expect, it } from "vitest";
import type { CopyLabDatabase } from "../src/database.js";
import { openDatabase } from "../src/database.js";
import { Repository } from "../src/repository.js";
import { AppService } from "../src/app-service.js";
import { EventBus } from "../src/events.js";
import { ModeManager } from "../src/mode.js";
import { SecretVault } from "../src/vault.js";
import { WalletManager } from "../src/wallet.js";
import { MockRuntime } from "./helpers.js";

describe("high-risk research service boundary", () => {
  let db: CopyLabDatabase | undefined;

  afterEach(() => {
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
    const runtime = new class extends MockRuntime {
      researchRefreshes = 0;
      async researchPaperConfigurationChanged(): Promise<void> {
        this.researchRefreshes += 1;
      }
    }();
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

  it("enables, pauses, and resumes one isolated lane without resetting it", async () => {
    const { repository, runtime, service } = setup();
    const enabled = await service.setResearchPaperEnabled(true);
    expect(enabled).toMatchObject({
      promotionEligible: false,
      executionEnabled: false,
      lane: { status: "ACTIVE", initialNavPerLeaderUsd: 141 }
    });
    const laneId = enabled.lane!.id;

    const paused = await service.setResearchPaperEnabled(false);
    expect(paused.lane).toMatchObject({ id: laneId, status: "PAUSED" });

    const resumed = await service.setResearchPaperEnabled(true);
    expect(resumed.lane).toMatchObject({ id: laneId, status: "ACTIVE" });
    expect(runtime.researchRefreshes).toBe(3);
    expect(repository.listExecutions()).toEqual([]);
    expect(repository.listPositions()).toEqual([]);
    expect(repository.listClosedTrades("PAPER")).toEqual([]);
    expect(repository.db.prepare("SELECT COUNT(*) AS count FROM signal_decisions").get()).toEqual({ count: 0 });
  });

  it("pauses the research lane when exact PAPER mode ends", async () => {
    const { repository, service } = setup();
    const enabled = await service.setResearchPaperEnabled(true);
    await service.pause();
    expect(repository.getResearchPaperLane(enabled.lane!.id)?.status).toBe("PAUSED");
    await expect(service.setResearchPaperEnabled(true)).rejects.toThrow("exact PAPER mode");
  });

  it("revises only the active high-risk PAPER lane to $25 future entries", async () => {
    const { repository, runtime, service } = setup();
    const lane = repository.createResearchPaperLane({
      id: "legacy-research-lane",
      policyVersion: "high-risk-paper-v1",
      policy: {
        comparison: "legacy",
        positionNavFraction: 0.1,
        maximumPositionUsd: 25,
        maximumOpenPositions: 3,
        maximumDeployedFraction: 0.3,
        minimumLiquidReserveUsd: 10,
        promotionEligible: false,
        executionEnabled: false
      }
    });

    const revised = await service.enlargeResearchPaperEntries();
    expect(revised).toMatchObject({
      promotionEligible: false,
      executionEnabled: false,
      lane: {
        id: lane.id,
        policyVersion: "high-risk-paper-v2",
        policy: {
          positionNavFraction: 0.2,
          maximumPositionUsd: 25,
          maximumDeployedFraction: 0.3,
          promotionEligible: false,
          executionEnabled: false
        }
      }
    });
    expect(runtime.researchRefreshes).toBe(1);
    expect(repository.listPositions()).toEqual([]);
    expect(repository.listExecutions()).toEqual([]);
    expect(repository.listAudit(10)).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventType: "research_paper_sizing_revised" })
    ]));
  });
});
