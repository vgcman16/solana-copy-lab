import { afterEach, describe, expect, it, vi } from "vitest";
import type { DataProviderProfile } from "@copylab/shared";
import { AppService, dashboardUsageProvider } from "../src/app-service.js";
import type { CopyLabDatabase } from "../src/database.js";
import { openDatabase } from "../src/database.js";
import { EventBus } from "../src/events.js";
import { ModeManager } from "../src/mode.js";
import { Repository } from "../src/repository.js";
import type { SecretVault } from "../src/vault.js";
import { WalletManager } from "../src/wallet.js";
import { MockRuntime } from "./helpers.js";

describe("provider usage attribution", () => {
  let db: CopyLabDatabase | undefined;
  afterEach(() => {
    vi.restoreAllMocks();
    db?.close();
  });

  it("maps only the logical chain slot to standard RPC outside MANAGED", () => {
    expect(dashboardUsageProvider("MANAGED", "helius")).toBe("helius");
    expect(dashboardUsageProvider("SHADOW", "helius")).toBe("solana_rpc");
    expect(dashboardUsageProvider("SELF_HOSTED", "helius")).toBe("solana_rpc");
    expect(dashboardUsageProvider("SELF_HOSTED", "jupiter")).toBe("jupiter");
    expect(dashboardUsageProvider("SHADOW", "birdeye")).toBe("birdeye");
    expect(dashboardUsageProvider("MANAGED", "pyth")).toBe("pyth_benchmarks");
  });

  it("reports physical standard-RPC requests in SHADOW/SELF_HOSTED and preserves MANAGED Helius accounting", () => {
    let cacheNow = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => cacheNow);
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    let profile: DataProviderProfile = {
      mode: "SELF_HOSTED",
      solanaHttpUrl: "http://127.0.0.1:8899",
      solanaWsUrl: "ws://127.0.0.1:8900"
    };
    const vault = {
      getDataProviderProfile: () => profile
    } as unknown as SecretVault;
    const wallet = new WalletManager(vault, repository);
    const modes = new ModeManager(repository, wallet);
    const events = new EventBus();
    const service = new AppService(
      repository,
      vault,
      wallet,
      modes,
      events,
      new MockRuntime()
    );
    const checkedAt = new Date().toISOString();
    repository.setProviderHealth({
      provider: "helius",
      ok: true,
      checkedAt,
      message: "logical chain health"
    });
    repository.incrementUsage("solana_rpc");
    repository.incrementUsage("solana_rpc");
    repository.incrementUsage("helius");
    repository.incrementUsage("alpaca_iex");

    const chainHealth = () => service.dashboard().providerHealth.find(({ provider }) => provider === "helius");
    expect(chainHealth()?.usage).toMatchObject({ provider: "solana_rpc", requests: 2, window: "month" });

    profile = {
      mode: "SHADOW",
      solanaHttpUrl: "http://127.0.0.1:8899",
      solanaWsUrl: "ws://127.0.0.1:8900"
    };
    cacheNow += 14_999;
    expect(chainHealth()?.usage).toMatchObject({ provider: "solana_rpc", requests: 2 });

    profile = { mode: "MANAGED" };
    cacheNow += 1;
    expect(chainHealth()?.usage).toMatchObject({ provider: "helius", requests: 1, window: "month" });

    events.publish("runtime-error", {
      event: "Authorization: Bearer secret-live-operations-token"
    });
    cacheNow += 1_000;
    const live = service.dashboard().liveOperations;
    expect(live.stream).toEqual({
      transport: "SSE",
      refreshOnEvent: true,
      credentialFieldsExposed: false,
      rawProviderPayloadsExposed: false
    });
    expect(live.sources.find(({ id }) => id === "alpaca_iex")?.usage.requests).toBe(1);
    expect(live.sources.find(({ id }) => id === "local_index")).toBeDefined();
    expect(JSON.stringify(live)).not.toContain("secret-live-operations-token");
  });
});
