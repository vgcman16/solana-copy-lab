import { afterEach, describe, expect, it } from "vitest";
import type { CopyLabDatabase } from "../src/database.js";
import { AppService } from "../src/app-service.js";
import { openDatabase } from "../src/database.js";
import { EventBus } from "../src/events.js";
import { ModeManager } from "../src/mode.js";
import { Repository } from "../src/repository.js";
import type { PromotionGate } from "@copylab/shared";
import { MockRuntime } from "./helpers.js";

const walletStub = {
  status: () => ({ exists: true, address: "bot", backupConfirmed: true })
};

function promotion(paperPassed: boolean, manualLivePassed: boolean): PromotionGate {
  return {
    evaluatedAt: new Date().toISOString(),
    elapsedDays: 30,
    completedExits: 50,
    netReturnPercent: 1,
    profitFactor: 1.2,
    maxDrawdownPercent: 5,
    positiveWeeks: 3,
    largestTradeProfitShare: 0.2,
    topThreeProfitShare: 0.5,
    stressNetReturnPercent: 0,
    stressMaxDrawdownPercent: 10,
    qualifyingWallets: 2,
    manualLiveOrders: 20,
    manualCompletedPositions: 5,
    paperShortfallP95Percent: 0.2,
    manualWorstShortfallPercent: 0.1,
    manualPolicyViolations: 0,
    paperPassed,
    manualLivePassed,
    blockers: []
  };
}

describe("ModeManager", () => {
  let db: CopyLabDatabase | undefined;
  afterEach(() => db?.close());

  it("blocks promotion before the paper gate passes", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    repository.setSecretCiphertext("provider-credentials", "ciphertext");
    repository.setSetting("paper_start_at", new Date().toISOString());
    const modes = new ModeManager(repository, walletStub as never);

    expect(modes.transition("PAPER")).toBe("PAPER");
    expect(() => modes.transition("MANUAL_LIVE", { confirmed: true })).toThrow("paper promotion gate");
  });

  it("requires explicit confirmation and rechecks the live gate on resume", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    repository.setSecretCiphertext("provider-credentials", "ciphertext");
    repository.setSetting("paper_start_at", new Date().toISOString());
    repository.setSetting("promotion_gate", promotion(true, true));
    const modes = new ModeManager(repository, walletStub as never);

    modes.transition("PAPER");
    expect(() => modes.transition("MANUAL_LIVE")).toThrow("explicit confirmation");
    expect(modes.transition("MANUAL_LIVE", { confirmed: true })).toBe("MANUAL_LIVE");
    expect(() => modes.transition("AUTO_LIVE")).toThrow("explicit confirmation");
    expect(modes.transition("AUTO_LIVE", { confirmed: true })).toBe("AUTO_LIVE");
    modes.transition("PAUSED");
    repository.setSetting("promotion_gate", promotion(true, false));
    expect(() => modes.transition("AUTO_LIVE")).toThrow("manual-live promotion gate");
    expect(modes.mode).toBe("PAUSED");
  });

  it("supports a reversible pause but does not unlock a hard stop", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    repository.setSecretCiphertext("provider-credentials", "ciphertext");
    repository.setSetting("paper_start_at", new Date().toISOString());
    const modes = new ModeManager(repository, walletStub as never);
    modes.transition("PAPER");
    expect(modes.transition("PAUSED")).toBe("PAUSED");
    expect(modes.transition("PAPER")).toBe("PAPER");
    modes.lock("test hard stop");
    expect(() => modes.transition("PAPER")).toThrow("acknowledged review");
    expect(modes.transition("PAPER", { reviewAcknowledged: true })).toBe("PAPER");
  });

  it.each([
    {
      label: "paper promotion",
      initialMode: "PAPER" as const,
      targetMode: "MANUAL_LIVE" as const,
      transition: (service: AppService) => service.transitionMode("MANUAL_LIVE", true)
    },
    {
      label: "automatic-live promotion",
      initialMode: "MANUAL_LIVE" as const,
      targetMode: "AUTO_LIVE" as const,
      transition: (service: AppService) => service.transitionMode("AUTO_LIVE", true)
    },
    {
      label: "live resume",
      initialMode: "PAUSED" as const,
      targetMode: "AUTO_LIVE" as const,
      transition: (service: AppService) => service.resume()
    }
  ])("fails $label closed when runtime activation rejects", async ({ initialMode, targetMode, transition }) => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    repository.setSetting("mode", initialMode);
    repository.setSetting("promotion_gate", promotion(true, true));
    if (initialMode === "PAUSED") repository.setSetting("paused_from", targetMode);
    const modes = new ModeManager(repository, walletStub as never);
    const runtime = new class extends MockRuntime {
      override async modeChanged(mode: typeof targetMode): Promise<void> {
        this.lastMode = mode;
        throw new Error("injected runtime activation failure");
      }
    }();
    const service = new AppService(
      repository,
      { getDataProviderProfile: () => ({ mode: "MANAGED" }) } as never,
      walletStub as never,
      modes,
      new EventBus(),
      runtime
    );

    await expect(transition(service)).rejects.toThrow("injected runtime activation failure");

    expect(runtime.lastMode).toBe(targetMode);
    expect(modes.mode).toBe("PAUSED");
    expect(modes.pausedFrom).toBe(targetMode);
    expect(repository.listAudit(5)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        eventType: "live_mode_activation_failed",
        severity: "critical",
        details: expect.objectContaining({
          intendedMode: targetMode,
          failure: "injected runtime activation failure"
        })
      })
    ]));
  });
});
