import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DataProviderProfile, PromotionGate } from "@copylab/shared";
import { AppService } from "../src/app-service.js";
import type { CopyLabDatabase } from "../src/database.js";
import { openDatabase } from "../src/database.js";
import { EventBus } from "../src/events.js";
import { ModeManager } from "../src/mode.js";
import { Repository } from "../src/repository.js";
import { TradingRuntime } from "../src/runtime.js";
import { RPC_READINESS_SETTING } from "../src/provider-rpc-readiness.js";
import {
  calculateSelfHostedPaperSoakStatus,
  completeFreshIndexHeadCoverage,
  selfHostedEndpointFingerprint
} from "../src/self-hosted-paper-soak.js";
import { SecretVault } from "../src/vault.js";
import { DpapiTransactionSigner, WalletManager } from "../src/wallet.js";
import {
  EMERGENCY_EXIT_RPC_STATUS_SETTING,
  emergencyExitRpcEndpointFingerprint
} from "../src/emergency-exit-rpc.js";
import { MockRuntime } from "./helpers.js";

const DAY_MS = 86_400_000;
const FIFTEEN_MINUTES_MS = 15 * 60_000;
const PROFILE: DataProviderProfile = {
  mode: "SELF_HOSTED",
  solanaHttpUrl: "https://rpc.example.test/private?token=one",
  solanaWsUrl: "wss://rpc.example.test/private?token=one",
  emergencySolanaHttpUrl: "https://exit-rpc.example.test/private?token=two"
};
const HEALTHY = Object.freeze({ discovery: true, chain: true, index: true, price: true });

function fingerprint(profile: DataProviderProfile = PROFILE): string {
  const value = selfHostedEndpointFingerprint(profile);
  if (!value) throw new Error("test profile has no endpoint fingerprint");
  return value;
}

function recordReadySoak(repository: Repository, now: Date, profile = PROFILE): void {
  const endpointFingerprint = fingerprint(profile);
  for (
    let at = now.getTime() - 7 * DAY_MS;
    at <= now.getTime();
    at += FIFTEEN_MINUTES_MS
  ) {
    repository.recordSelfHostedPaperSoakHeartbeat({
      endpointFingerprint,
      observedAt: new Date(at).toISOString(),
      health: HEALTHY
    });
  }
}

function passingPromotion(): PromotionGate {
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
    manualLiveOrders: 0,
    manualCompletedPositions: 0,
    paperShortfallP95Percent: 0.2,
    manualWorstShortfallPercent: 0,
    manualPolicyViolations: 0,
    paperPassed: true,
    manualLivePassed: false,
    blockers: []
  };
}

describe("self-hosted PAPER soak", () => {
  let db: CopyLabDatabase | undefined;
  let temporaryDirectory: string | undefined;
  let tradingRuntime: TradingRuntime | undefined;

  afterEach(async () => {
    await tradingRuntime?.stop();
    tradingRuntime = undefined;
    db?.close();
    db = undefined;
    if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = undefined;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("rejects a fresh one-signature head seed until a complete continuous slot range is committed", () => {
    const observedAt = new Date("2026-07-10T12:00:00.000Z");
    const seeded = {
      pipeline: "helius-jupiter-program-head",
      partition: "program-a",
      completed: false,
      updatedAt: observedAt.toISOString(),
      lastSignature: "seed",
      slot: 100,
      metadata: { coverageStartSlot: 101 }
    };
    expect(completeFreshIndexHeadCoverage([seeded], new Set(["program-a"]), observedAt)).toBe(false);
    expect(completeFreshIndexHeadCoverage([{
      ...seeded,
      metadata: { coverageStartSlot: 90, coverageEndSlot: 100 }
    }], new Set(["program-a"]), observedAt)).toBe(true);
    expect(completeFreshIndexHeadCoverage([{
      ...seeded,
      cursor: "old-anchor",
      beforeSignature: "next-page",
      metadata: { coverageStartSlot: 90, coverageEndSlot: 100 }
    }], new Set(["program-a"]), observedAt)).toBe(false);
    expect(completeFreshIndexHeadCoverage([{
      ...seeded,
      metadata: {
        coverageStartSlot: 100,
        coverageEndSlot: 100,
        gapReason: "MANAGED_GAP_QUARANTINED_BEFORE_PAPER_MONITORING"
      }
    }], new Set(["program-a"]), observedAt)).toBe(false);
  });

  it("requires seven continuous days with current healthy component evidence", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const now = new Date("2026-07-10T12:00:00.000Z");
    recordReadySoak(repository, now);

    expect(calculateSelfHostedPaperSoakStatus(repository, PROFILE, now)).toMatchObject({
      active: true,
      ready: true,
      requiredDays: 7,
      elapsedDays: 7,
      heartbeatCount: 673,
      largestGapSeconds: 900,
      latestHealth: HEALTHY,
      blockers: []
    });
    expect(db.pragma("user_version", { simple: true })).toBeGreaterThanOrEqual(16);
  });

  it("resets before accepting a heartbeat after a gap longer than fifteen minutes", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const endpointFingerprint = fingerprint();
    repository.recordSelfHostedPaperSoakHeartbeat({
      endpointFingerprint,
      observedAt: "2026-07-10T10:00:00.000Z",
      health: HEALTHY
    });
    repository.recordSelfHostedPaperSoakHeartbeat({
      endpointFingerprint,
      observedAt: "2026-07-10T10:16:00.000Z",
      health: HEALTHY
    });

    expect(calculateSelfHostedPaperSoakStatus(
      repository,
      PROFILE,
      new Date("2026-07-10T10:16:00.000Z")
    )).toMatchObject({
      active: true,
      ready: false,
      elapsedDays: 0,
      heartbeatCount: 1,
      startedAt: "2026-07-10T10:16:00.000Z"
    });
    expect(db.prepare(
      "SELECT status, reset_reason FROM self_hosted_paper_soak_epochs ORDER BY started_at"
    ).all()).toEqual([
      { status: "RESET", reset_reason: "the self-hosted PAPER heartbeat gap exceeded fifteen minutes" },
      { status: "ACTIVE", reset_reason: null }
    ]);
  });

  it("resets on an unhealthy interval and starts a new epoch only after health recovers", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const endpointFingerprint = fingerprint();
    repository.recordSelfHostedPaperSoakHeartbeat({
      endpointFingerprint,
      observedAt: "2026-07-10T10:00:00.000Z",
      health: HEALTHY
    });
    repository.recordSelfHostedPaperSoakHeartbeat({
      endpointFingerprint,
      observedAt: "2026-07-10T10:05:00.000Z",
      health: { ...HEALTHY, index: false }
    });
    expect(calculateSelfHostedPaperSoakStatus(
      repository,
      PROFILE,
      new Date("2026-07-10T10:05:00.000Z")
    )).toMatchObject({
      active: false,
      ready: false,
      latestHealth: { index: false },
      blockers: expect.arrayContaining(["local wallet indexing is unhealthy"])
    });

    repository.recordSelfHostedPaperSoakHeartbeat({
      endpointFingerprint,
      observedAt: "2026-07-10T10:10:00.000Z",
      health: HEALTHY
    });
    expect(calculateSelfHostedPaperSoakStatus(
      repository,
      PROFILE,
      new Date("2026-07-10T10:10:00.000Z")
    )).toMatchObject({
      active: true,
      ready: false,
      startedAt: "2026-07-10T10:10:00.000Z",
      heartbeatCount: 1
    });
  });

  it("fails closed and starts a new epoch if the system clock moves backwards", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const endpointFingerprint = fingerprint();
    repository.recordSelfHostedPaperSoakHeartbeat({
      endpointFingerprint,
      observedAt: "2026-07-10T10:10:00.000Z",
      health: HEALTHY
    });
    repository.recordSelfHostedPaperSoakHeartbeat({
      endpointFingerprint,
      observedAt: "2026-07-10T10:05:00.000Z",
      health: HEALTHY
    });

    expect(calculateSelfHostedPaperSoakStatus(
      repository,
      PROFILE,
      new Date("2026-07-10T10:04:00.000Z")
    )).toMatchObject({
      active: true,
      ready: false,
      startedAt: "2026-07-10T10:05:00.000Z",
      blockers: expect.arrayContaining(["self-hosted PAPER soak heartbeat is dated in the future"])
    });
  });

  it("preserves a valid epoch across a process restart and binds it to the exact endpoint pair", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "copylab-self-hosted-soak-"));
    const path = join(temporaryDirectory, "copylab.db");
    const now = new Date("2026-07-10T12:00:00.000Z");
    db = openDatabase(path);
    recordReadySoak(new Repository(db), now);
    db.close();
    db = openDatabase(path);
    const restarted = new Repository(db);

    expect(calculateSelfHostedPaperSoakStatus(restarted, PROFILE, now).ready).toBe(true);
    expect(calculateSelfHostedPaperSoakStatus(restarted, {
      ...PROFILE,
      solanaHttpUrl: "https://rpc.example.test/private?token=changed"
    }, now)).toMatchObject({ active: false, ready: false, heartbeatCount: 0 });
  }, 15_000);

  it("fails closed when the most recent durable heartbeat is more than ten minutes old", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const completedAt = new Date("2026-07-10T12:00:00.000Z");
    recordReadySoak(repository, completedAt);

    expect(calculateSelfHostedPaperSoakStatus(
      repository,
      PROFILE,
      new Date(completedAt.getTime() + 10 * 60_000 + 1)
    )).toMatchObject({
      active: true,
      ready: false,
      blockers: expect.arrayContaining(["self-hosted PAPER soak heartbeat is stale"])
    });
  });

  it.runIf(process.platform === "win32")(
    "resets the durable soak epoch when the encrypted provider profile changes",
    async () => {
      db = openDatabase(":memory:");
      const repository = new Repository(db);
      const vault = new SecretVault(repository);
      const wallet = new WalletManager(vault, repository);
      const modes = new ModeManager(repository, wallet);
      const runtime = new MockRuntime();
      const service = new AppService(repository, vault, wallet, modes, new EventBus(), runtime);
      vault.setDataProviderProfile(PROFILE);
      repository.setSetting("mode", "PAPER");
      recordReadySoak(repository, new Date());
      expect(repository.activeSelfHostedPaperSoakEpoch()).toBeDefined();

      await expect(service.saveDataProviderProfile({ mode: "MANAGED" })).resolves.toMatchObject({
        profile: { mode: "MANAGED" }
      });
      expect(repository.activeSelfHostedPaperSoakEpoch()).toBeUndefined();
      expect(db.prepare(`
        SELECT status, reset_reason FROM self_hosted_paper_soak_epochs ORDER BY started_at DESC LIMIT 1
      `).get()).toEqual({
        status: "RESET",
        reset_reason: "the encrypted data-provider profile changed"
      });
    }
  );

  it("runs the full RPC/WSS refresh inside the five-minute health cycle and cancels it on stop", async () => {
    vi.useFakeTimers();
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const vault = new SecretVault(repository);
    const wallet = new WalletManager(vault, repository);
    const modes = new ModeManager(repository, wallet);
    tradingRuntime = new TradingRuntime(
      repository,
      vault,
      modes,
      new EventBus(),
      new DpapiTransactionSigner(vault, repository)
    );
    const harness = tradingRuntime as unknown as {
      refreshActiveRpcReadiness(): Promise<void>;
      refreshHealth(includeDiscovery: boolean): Promise<void>;
    };
    const fullDiagnostic = vi.spyOn(harness, "refreshActiveRpcReadiness").mockResolvedValue();
    const ordinaryHealth = vi.spyOn(harness, "refreshHealth").mockResolvedValue();

    await tradingRuntime.start();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(fullDiagnostic).toHaveBeenCalledOnce();
    expect(ordinaryHealth).toHaveBeenCalledWith(false);

    await tradingRuntime.stop();
    tradingRuntime = undefined;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(fullDiagnostic).toHaveBeenCalledOnce();
  });

  it.runIf(process.platform === "win32")(
    "durably invalidates prior endpoint evidence and logical chain health when a scheduled full diagnostic fails",
    async () => {
      db = openDatabase(":memory:");
      const repository = new Repository(db);
      const vault = new SecretVault(repository);
      const wallet = new WalletManager(vault, repository);
      const modes = new ModeManager(repository, wallet);
      vault.setDataProviderProfile(PROFILE);
      repository.setSetting(RPC_READINESS_SETTING, { stale: "previous evidence" });
      tradingRuntime = new TradingRuntime(
        repository,
        vault,
        modes,
        new EventBus(),
        new DpapiTransactionSigner(vault, repository)
      );
      vi.spyOn(tradingRuntime, "validateDataProviderProfile").mockRejectedValue(
        new Error("archive probe unavailable at https://rpc.example.test/private?token=secret")
      );
      const harness = tradingRuntime as unknown as { refreshActiveRpcReadiness(): Promise<void> };

      await harness.refreshActiveRpcReadiness();
      expect(repository.getSetting(RPC_READINESS_SETTING)).toBeNull();
      expect(repository.listProviderHealth()).toEqual([
        expect.objectContaining({
          provider: "helius",
          ok: false,
          message: expect.stringContaining("full RPC/WSS diagnostic failed")
        })
      ]);
      expect(JSON.stringify(repository.listProviderHealth())).not.toContain("token=secret");
    }
  );

  it.runIf(process.platform === "win32")(
    "rechecks the soak inside the trading runtime live preflight as a defense-in-depth boundary",
    async () => {
      db = openDatabase(":memory:");
      const repository = new Repository(db);
      const vault = new SecretVault(repository);
      const wallet = new WalletManager(vault, repository);
      const modes = new ModeManager(repository, wallet);
      vault.setDataProviderProfile(PROFILE);
      repository.setSetting("mode", "PAPER");
      repository.setSetting("promotion_gate", passingPromotion());
      repository.setSecretCiphertext("bot-wallet-secret", "encrypted-test-placeholder");
      repository.setSetting("wallet_backup_confirmed", true);
      repository.setSetting(EMERGENCY_EXIT_RPC_STATUS_SETTING, {
        configured: true,
        ok: true,
        checkedAt: new Date().toISOString(),
        message: "independent exit RPC passed",
        endpointFingerprint: emergencyExitRpcEndpointFingerprint(PROFILE.emergencySolanaHttpUrl!)
      });
      tradingRuntime = new TradingRuntime(
        repository,
        vault,
        modes,
        new EventBus(),
        new DpapiTransactionSigner(vault, repository)
      );
      const harness = tradingRuntime as unknown as {
        providers: unknown;
        refreshActiveRpcReadiness(): Promise<void>;
        refreshHealth(includeDiscovery: boolean): Promise<void>;
      };
      harness.providers = {};
      vi.spyOn(harness, "refreshActiveRpcReadiness").mockResolvedValue();
      vi.spyOn(harness, "refreshHealth").mockResolvedValue();

      await expect(tradingRuntime.preflightModeChange("MANUAL_LIVE")).rejects.toThrow(
        "self-hosted PAPER soak has not passed"
      );
    }
  );

  it.runIf(process.platform === "win32")(
    "blocks the live preflight until the independent soak passes, then preserves the existing paper gate",
    async () => {
      db = openDatabase(":memory:");
      const repository = new Repository(db);
      const vault = new SecretVault(repository);
      const wallet = new WalletManager(vault, repository);
      const modes = new ModeManager(repository, wallet);
      const runtime = new MockRuntime();
      const service = new AppService(repository, vault, wallet, modes, new EventBus(), runtime);
      vault.setDataProviderProfile(PROFILE);
      repository.setSetting("mode", "PAPER");

      const preflight = vi.spyOn(runtime, "preflightModeChange");
      await expect(service.transitionMode("MANUAL_LIVE", true)).rejects.toThrow(
        "self-hosted PAPER soak"
      );
      expect(preflight).not.toHaveBeenCalled();

      const now = new Date();
      recordReadySoak(repository, now);
      repository.setSetting("promotion_gate", passingPromotion());
      repository.setSecretCiphertext("bot-wallet-secret", "encrypted-test-placeholder");
      repository.setSetting("wallet_address", "dedicated-bot-wallet");
      repository.setSetting("wallet_backup_confirmed", true);

      await expect(service.transitionMode("MANUAL_LIVE", true)).resolves.toBe("MANUAL_LIVE");
      expect(preflight).toHaveBeenCalledWith("MANUAL_LIVE");
      expect(modes.mode).toBe("MANUAL_LIVE");
    }
  );
});
