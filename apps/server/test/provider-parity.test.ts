import { describe, expect, it } from "vitest";
import type {
  DiscoveredWalletSet,
  WalletDiscoveryProvider,
  WalletPnlWindow
} from "@copylab/shared";
import {
  ShadowWalletDiscoveryProvider,
  compareWalletDiscovery,
  compareWalletPnl,
  type ProviderParityObservation
} from "../src/provider-parity.js";
import { openDatabase } from "../src/database.js";
import { Repository } from "../src/repository.js";

const AT = "2026-07-10T12:00:00.000Z";

function pnl(overrides: Partial<WalletPnlWindow> = {}): WalletPnlWindow {
  return {
    duration: "30d",
    realizedProfitUsd: 10,
    realizedProfitPercent: 20,
    unrealizedProfitUsd: 1,
    totalTrades: 5,
    wins: 3,
    losses: 2,
    ...overrides
  };
}

function cohort(id: string, addresses: Array<[string, boolean]>): DiscoveredWalletSet {
  return {
    cohortId: id,
    generatedAt: AT,
    candidates: addresses.map(([address, control]) => ({
      address,
      cohortId: id,
      firstSeenAt: AT,
      lastSeenAt: AT,
      control,
      tags: []
    }))
  };
}

describe("provider parity", () => {
  it("uses explicit tolerances and exact trade counts for wallet PnL", () => {
    expect(compareWalletPnl("wallet", pnl(), pnl({ realizedProfitUsd: 10.005 }), AT).status).toBe("MATCH");
    const divergent = compareWalletPnl(
      "wallet",
      pnl(),
      pnl({ realizedProfitUsd: 10.02, totalTrades: 4 }),
      AT
    );
    expect(divergent.status).toBe("DIVERGENT");
    expect(divergent.reasons).toEqual(expect.arrayContaining([
      "realized USD PnL differs",
      "completed trade count differs"
    ]));
  });

  it("records discovery coverage and classification differences", () => {
    const result = compareWalletDiscovery(
      cohort("managed", [["one", false], ["two", true]]),
      cohort("local", [["one", true], ["three", false]]),
      AT
    );
    expect(result).toMatchObject({
      status: "DIVERGENT",
      metrics: {
        overlapCandidates: 1,
        primaryOnlyCandidates: 1,
        shadowOnlyCandidates: 1,
        controlMismatch: 1
      }
    });
  });

  it("accepts different ranked universes when shared wallet classification agrees", () => {
    const result = compareWalletDiscovery(
      cohort("managed", [["one", false], ["two", true]]),
      cohort("local", [["one", false], ["three", false]]),
      AT
    );
    expect(result).toMatchObject({
      status: "MATCH",
      reasons: [],
      metrics: {
        overlapCandidates: 1,
        primaryOnlyCandidates: 1,
        shadowOnlyCandidates: 1,
        controlMismatch: 0
      }
    });
    expect(result.evidence).toMatchObject({
      primaryUniverseDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      shadowUniverseDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      sharedPrimaryDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      sharedShadowDigest: expect.stringMatching(/^[a-f0-9]{64}$/u)
    });
  });

  it("rejects a shared wallet whose retained source rank differs", () => {
    const managed = cohort("managed", [["one", false], ["two", true]]);
    const local = cohort("local", [["one", false], ["three", false]]);
    managed.candidates[0]!.sourceRank30d = 1;
    local.candidates[0]!.sourceRank30d = 2;
    expect(compareWalletDiscovery(managed, local, AT)).toMatchObject({
      status: "DIVERGENT",
      metrics: { rank30dMismatch: 1 },
      reasons: ["shared 30-day ranks differ"]
    });
  });

  it("rejects discovery evidence with no shared wallets", () => {
    expect(compareWalletDiscovery(
      cohort("managed", [["one", false]]),
      cohort("local", [["two", false]]),
      AT
    )).toMatchObject({
      status: "DIVERGENT",
      reasons: ["managed and local discovery have no shared wallets"]
    });
  });

  it("always returns primary results while durably reporting an unavailable shadow", async () => {
    const primaryCohort = cohort("managed", [["one", false]]);
    const primary: WalletDiscoveryProvider & { checkHealth: () => Promise<{
      provider: "birdeye";
      ok: boolean;
      checkedAt: string;
      message: string;
    }> } = {
      discoverCohort: async () => primaryCohort,
      getPnl: async () => pnl(),
      checkHealth: async () => ({
        provider: "birdeye",
        ok: true,
        checkedAt: AT,
        message: "managed healthy"
      })
    };
    const shadow: WalletDiscoveryProvider = {
      discoverCohort: async () => { throw new Error("local history is incomplete"); },
      getPnl: async () => { throw new Error("local pricing is incomplete"); }
    };
    const observations: ProviderParityObservation[] = [];
    const provider = new ShadowWalletDiscoveryProvider(
      primary,
      shadow,
      { record: (observation) => { observations.push(observation); } },
      () => new Date(AT)
    );

    await expect(provider.discoverCohort()).resolves.toEqual(primaryCohort);
    await expect(provider.getPnl("one", "30d")).resolves.toEqual(pnl());
    expect(observations).toHaveLength(2);
    expect(observations.every((observation) => observation.status === "SHADOW_UNAVAILABLE")).toBe(true);
    expect(observations[0]?.reasons).toEqual(["local history is incomplete"]);
    expect(observations[1]?.reasons).toEqual(["local pricing is incomplete"]);
  });

  it("persists comparison evidence across repository instances", () => {
    const db = openDatabase(":memory:");
    try {
      const repository = new Repository(db);
      const observation = compareWalletPnl("wallet", pnl(), pnl(), AT);
      expect(repository.saveProviderParityObservation(observation)).toBe(1);
      expect(new Repository(db).listProviderParityObservations()).toEqual([{ id: 1, ...observation }]);
      expect(db.pragma("user_version", { simple: true })).toBeGreaterThanOrEqual(16);
    } finally {
      db.close();
    }
  });
});
