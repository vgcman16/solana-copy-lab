import { describe, expect, it } from "vitest";
import type {
  PublicKeyString,
  WalletDiscoveryProvider,
  WalletHistorySummary,
  WalletPnlWindow
} from "@copylab/shared";
import {
  MANAGED_RECOVERY_PREFLIGHT_POLICY,
  ManagedRecoveryPreflightCoordinator,
  managedRecoveryPreflightWindow,
  type ManagedRecoveryPreflightClaim,
  type ManagedRecoveryPreflightRepository,
  type ManagedRecoveryPreflightStep
} from "../src/managed-recovery-preflight.js";

const NOW = new Date("2026-07-11T12:34:56.000Z");
const WALLET = "preflight-wallet";

function pnl(duration: "30d" | "90d", realizedProfitUsd = 100): WalletPnlWindow {
  return {
    duration,
    realizedProfitUsd,
    realizedProfitPercent: 10,
    unrealizedProfitUsd: 2,
    totalTrades: 20,
    wins: 12,
    losses: 8
  };
}

function summary(overrides: Partial<WalletHistorySummary> = {}): WalletHistorySummary {
  return {
    wallet: WALLET,
    historyDays: 90,
    closedEligibleSwaps: 60,
    activeWeeks: 4,
    medianHoldingMinutes: 30,
    topTokenProfitShare: 0.2,
    topThreeProfitShare: 0.5,
    tags: [],
    ...overrides
  };
}

interface FakeRow {
  status: "READY" | "RETRY" | "PASS" | "REJECTED";
  step: ManagedRecoveryPreflightStep;
  attempts: number;
  pnl30d?: WalletPnlWindow;
  pnl90d?: WalletPnlWindow;
}

class FakeRepository implements ManagedRecoveryPreflightRepository {
  readonly window = managedRecoveryPreflightWindow(NOW);
  readonly events: Array<Record<string, unknown>> = [];
  readonly row: FakeRow;
  private tokenSequence = 0;

  constructor(step: ManagedRecoveryPreflightStep = "PNL_30D", partial: Partial<FakeRow> = {}) {
    this.row = { status: "READY", step, attempts: 0, ...partial };
  }

  claimManagedRecoveryPreflight(input: Parameters<ManagedRecoveryPreflightRepository["claimManagedRecoveryPreflight"]>[0]): ManagedRecoveryPreflightClaim | undefined {
    this.events.push({ kind: "claim", ...input });
    if (this.row.status !== "READY" && this.row.status !== "RETRY") return undefined;
    this.row.attempts += 1;
    this.row.status = "READY";
    return {
      ...this.window,
      claimToken: `claim-${++this.tokenSequence}`,
      wallet: WALLET,
      step: this.row.step,
      attempts: this.row.attempts,
      ...(this.row.pnl30d ? { pnl30d: this.row.pnl30d } : {}),
      ...(this.row.pnl90d ? { pnl90d: this.row.pnl90d } : {})
    };
  }

  saveManagedRecoveryPreflightPartial(input: Parameters<ManagedRecoveryPreflightRepository["saveManagedRecoveryPreflightPartial"]>[0]): boolean {
    this.events.push({ kind: "partial", ...input });
    this.row.step = input.nextStep;
    this.row.status = "READY";
    this.row.attempts = 0;
    if (input.pnl30d) this.row.pnl30d = input.pnl30d;
    if (input.pnl90d) this.row.pnl90d = input.pnl90d;
    return true;
  }

  passManagedRecoveryPreflight(input: Parameters<ManagedRecoveryPreflightRepository["passManagedRecoveryPreflight"]>[0]): boolean {
    this.events.push({ kind: "pass", ...input });
    this.row.status = "PASS";
    return true;
  }

  rejectManagedRecoveryPreflight(input: Parameters<ManagedRecoveryPreflightRepository["rejectManagedRecoveryPreflight"]>[0]): boolean {
    this.events.push({ kind: "reject", ...input });
    this.row.status = "REJECTED";
    return true;
  }

  retryManagedRecoveryPreflight(input: Parameters<ManagedRecoveryPreflightRepository["retryManagedRecoveryPreflight"]>[0]): boolean {
    this.events.push({ kind: "retry", ...input });
    this.row.status = "RETRY";
    return true;
  }
}

function discovery(outcomes: Partial<Record<"30d" | "90d", WalletPnlWindow | Error>> = {}): WalletDiscoveryProvider & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    discoverCohort: async () => ({ cohortId: "unused", generatedAt: NOW.toISOString(), candidates: [] }),
    getPnl: async (_wallet: PublicKeyString, duration: "30d" | "90d") => {
      calls.push(duration);
      const value = outcomes[duration] ?? pnl(duration);
      if (value instanceof Error) throw value;
      return value;
    }
  };
}

function chain(result: WalletHistorySummary | Error = summary()): {
  calls: number;
  summarizeHistory(wallet: PublicKeyString, days: number): Promise<WalletHistorySummary>;
} {
  return {
    calls: 0,
    async summarizeHistory(wallet, days) {
      this.calls += 1;
      expect(wallet).toBe(WALLET);
      expect(days).toBe(90);
      if (result instanceof Error) throw result;
      return result;
    }
  };
}

function coordinator(
  repository: FakeRepository,
  provider = discovery(),
  history = chain()
): ManagedRecoveryPreflightCoordinator {
  return new ManagedRecoveryPreflightCoordinator(repository, provider, history, {
    now: () => new Date(NOW),
    retryBaseMs: 1_000,
    maximumRetryDelayMs: 8_000
  });
}

describe("ManagedRecoveryPreflightCoordinator", () => {
  it("uses deterministic Monday-to-Monday UTC windows", () => {
    expect(managedRecoveryPreflightWindow(new Date("2026-07-12T23:59:59.999Z"))).toEqual({
      policyVersion: MANAGED_RECOVERY_PREFLIGHT_POLICY,
      windowStart: "2026-07-06T00:00:00.000Z",
      expiresAt: "2026-07-13T00:00:00.000Z"
    });
    expect(managedRecoveryPreflightWindow(new Date("2026-07-13T00:00:00.000Z"))).toMatchObject({
      windowStart: "2026-07-13T00:00:00.000Z",
      expiresAt: "2026-07-20T00:00:00.000Z"
    });
  });

  it("short-circuits after a valid non-positive 30-day result", async () => {
    const repository = new FakeRepository();
    const provider = discovery({ "30d": pnl("30d", 0) });
    const history = chain();
    const worker = coordinator(repository, provider, history);

    await expect(worker.runOnce()).resolves.toBe(true);
    expect(provider.calls).toEqual(["30d"]);
    expect(history.calls).toBe(0);
    expect(repository.row.status).toBe("REJECTED");
    expect(repository.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "reject", reasonCode: "NON_POSITIVE_30D_PNL" })
    ]));
  });

  it("short-circuits after a valid non-positive 90-day result without Helius spend", async () => {
    const repository = new FakeRepository("PNL_90D", { pnl30d: pnl("30d") });
    const provider = discovery({ "90d": pnl("90d", -1) });
    const history = chain();
    const worker = coordinator(repository, provider, history);

    await worker.runOnce();
    expect(provider.calls).toEqual(["90d"]);
    expect(history.calls).toBe(0);
    expect(repository.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "reject", reasonCode: "NON_POSITIVE_90D_PNL" })
    ]));
  });

  it("persists each positive provider step and passes only after valid history", async () => {
    const repository = new FakeRepository();
    const provider = discovery();
    const history = chain();
    const worker = coordinator(repository, provider, history);

    await worker.runOnce();
    expect(repository.row).toMatchObject({ status: "READY", step: "PNL_90D" });
    expect(history.calls).toBe(0);
    await worker.runOnce();
    expect(repository.row).toMatchObject({ status: "READY", step: "HISTORY" });
    expect(history.calls).toBe(0);
    await worker.runOnce();

    expect(provider.calls).toEqual(["30d", "90d"]);
    expect(history.calls).toBe(1);
    expect(repository.row.status).toBe("PASS");
    expect(repository.events.filter(({ kind }) => kind === "partial")).toHaveLength(2);
    expect(repository.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "pass", expiresAt: "2026-07-13T00:00:00.000Z" })
    ]));
  });

  it.each([
    [summary({ tags: [" Sniper "] }), "DISALLOWED_IDENTITY_TAG"],
    [summary({ historyDays: 89 }), "INSUFFICIENT_HISTORY"],
    [summary({ topTokenProfitShare: 0.36 }), "TOP_TOKEN_PROFIT_CONCENTRATION"],
    [summary({ topThreeProfitShare: 0.61 }), "TOP_THREE_PROFIT_CONCENTRATION"]
  ])("rejects valid unsafe history", async (result, reasonCode) => {
    const repository = new FakeRepository("HISTORY", {
      pnl30d: pnl("30d"),
      pnl90d: pnl("90d")
    });
    const worker = coordinator(repository, discovery(), chain(result));

    await worker.runOnce();
    expect(repository.row.status).toBe("REJECTED");
    expect(repository.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "reject", reasonCode })
    ]));
  });

  it.each([
    summary({ topTokenProfitShare: Number.NaN }),
    summary({ topTokenProfitShare: 0.6, topThreeProfitShare: 0.5 })
  ])("retries inconclusive or malformed history without passing", async (result) => {
    const repository = new FakeRepository("HISTORY", {
      pnl30d: pnl("30d"),
      pnl90d: pnl("90d")
    });
    const worker = coordinator(repository, discovery(), chain(result));

    await worker.runOnce();
    expect(repository.row.status).toBe("RETRY");
    expect(repository.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "retry", error: expect.stringContaining("inconclusive") })
    ]));
    expect(repository.events.some(({ kind }) => kind === "pass" || kind === "reject")).toBe(false);
  });

  it("keeps zero concentration eligible because final policy only rejects shares above the limits", async () => {
    const repository = new FakeRepository("HISTORY", {
      pnl30d: pnl("30d"),
      pnl90d: pnl("90d")
    });
    const worker = coordinator(
      repository,
      discovery(),
      chain(summary({ topTokenProfitShare: 0, topThreeProfitShare: 0 }))
    );

    await worker.runOnce();
    expect(repository.row.status).toBe("PASS");
  });

  it("converts provider exceptions into bounded durable retry state", async () => {
    const repository = new FakeRepository("PNL_90D", { pnl30d: pnl("30d") });
    const provider = discovery({ "90d": new Error("secret-bearing upstream URL") });
    const worker = coordinator(repository, provider, chain());

    await worker.runOnce();
    const retry = repository.events.find(({ kind }) => kind === "retry");
    expect(retry).toMatchObject({
      expectedStep: "PNL_90D",
      nextAttemptAt: "2026-07-11T12:34:57.000Z",
      error: "Managed recovery preflight provider step failed; retry is required."
    });
    expect(JSON.stringify(retry)).not.toContain("secret-bearing");
  });

  it("holds a repeatedly failing provider step until weekly expiry after three attempts", async () => {
    const repository = new FakeRepository("PNL_90D", {
      pnl30d: pnl("30d"),
      attempts: 2
    });
    const worker = coordinator(
      repository,
      discovery({ "90d": new Error("still unavailable") }),
      chain()
    );

    await worker.runOnce();
    expect(repository.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "retry",
        expectedStep: "PNL_90D",
        nextAttemptAt: "2026-07-13T00:00:00.000Z"
      })
    ]));
  });

  it("resumes at the persisted partial step without repeating 30-day PnL", async () => {
    const repository = new FakeRepository("PNL_90D", { pnl30d: pnl("30d") });
    const provider = discovery();
    const history = chain();
    const worker = coordinator(repository, provider, history);

    await worker.runOnce();
    expect(provider.calls).toEqual(["90d"]);
    expect(repository.row.step).toBe("HISTORY");
    expect(history.calls).toBe(0);
  });

  it("does not claim or call providers while the runtime fence is closed", async () => {
    const repository = new FakeRepository();
    const provider = discovery();
    const history = chain();
    const worker = new ManagedRecoveryPreflightCoordinator(repository, provider, history, {
      now: () => new Date(NOW),
      canRun: () => false
    });

    await expect(worker.runOnce()).resolves.toBe(false);
    expect(repository.events).toEqual([]);
    expect(provider.calls).toEqual([]);
    expect(history.calls).toBe(0);
  });
});
