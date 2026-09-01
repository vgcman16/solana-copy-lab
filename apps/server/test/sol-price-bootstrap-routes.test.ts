import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { PYTH_SOL_USD_FEED_ID } from "@copylab/providers";
import type {
  ModeState,
  ProviderCredentials,
  ProviderHealth,
  SolPriceBootstrapStatus
} from "@copylab/shared";
import { AppService } from "../src/app-service.js";
import { buildApp } from "../src/app.js";
import type { CopyLabDatabase } from "../src/database.js";
import { openDatabase } from "../src/database.js";
import { EventBus } from "../src/events.js";
import { ModeManager } from "../src/mode.js";
import { Repository } from "../src/repository.js";
import {
  SOL_PRICE_BOOTSTRAP_HORIZON_DAYS,
  SOL_PRICE_BOOTSTRAP_INTERVAL_SECONDS,
  SOL_PRICE_BOOTSTRAP_TOTAL_POINTS
} from "../src/sol-price-bootstrap-state.js";
import { SecretVault } from "../src/vault.js";
import { WalletManager } from "../src/wallet.js";
import { MockRuntime } from "./helpers.js";

function idleStatus(): SolPriceBootstrapStatus {
  return {
    phase: "IDLE",
    activeInProcess: false,
    authenticationConfigured: false,
    checkpointValid: true,
    feedId: PYTH_SOL_USD_FEED_ID,
    intervalSeconds: SOL_PRICE_BOOTSTRAP_INTERVAL_SECONDS,
    horizonDays: SOL_PRICE_BOOTSTRAP_HORIZON_DAYS,
    totalPoints: SOL_PRICE_BOOTSTRAP_TOTAL_POINTS,
    completedPoints: 0,
    remainingPoints: SOL_PRICE_BOOTSTRAP_TOTAL_POINTS,
    insertedSnapshots: 0,
    preservedSnapshots: 0,
    progressPercent: 0,
    cursorAttempts: 0
  };
}

class BootstrapRuntime extends MockRuntime {
  bootstrap = idleStatus();
  startCalls = 0;
  pauseCalls = 0;
  credentials: ProviderCredentials[] = [];
  onValidate: (() => void) | undefined;

  override async validateCredentials(credentials: ProviderCredentials): Promise<ProviderHealth[]> {
    this.credentials.push({ ...credentials });
    this.onValidate?.();
    const providers: ProviderHealth["provider"][] = ["birdeye", "helius", "jupiter"];
    if (credentials.pythBenchmarksApiKey) providers.push("pyth");
    return providers.map((provider) => ({
      provider,
      ok: true,
      checkedAt: new Date().toISOString(),
      message: "validated"
    }));
  }

  override async credentialsChanged(): Promise<void> {
    const latest = this.credentials.at(-1);
    this.bootstrap = {
      ...this.bootstrap,
      authenticationConfigured: Boolean(latest?.pythBenchmarksApiKey)
    };
  }

  override solPriceBootstrapStatus(): SolPriceBootstrapStatus {
    return this.bootstrap;
  }

  override startSolPriceBootstrap(): SolPriceBootstrapStatus {
    this.startCalls += 1;
    this.bootstrap = { ...this.bootstrap, phase: "RUNNING", activeInProcess: true };
    return this.bootstrap;
  }

  override async pauseSolPriceBootstrap(): Promise<SolPriceBootstrapStatus> {
    this.pauseCalls += 1;
    this.bootstrap = { ...this.bootstrap, phase: "PAUSED", activeInProcess: false };
    return this.bootstrap;
  }
}

describe("SOL/USD bootstrap API", () => {
  let db: CopyLabDatabase | undefined;
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    db?.close();
  });

  async function setup(): Promise<{
    app: FastifyInstance;
    repository: Repository;
    runtime: BootstrapRuntime;
    vault: SecretVault;
  }> {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const vault = new SecretVault(repository);
    const wallet = new WalletManager(vault, repository);
    const runtime = new BootstrapRuntime();
    const service = new AppService(
      repository,
      vault,
      wallet,
      new ModeManager(repository, wallet),
      new EventBus(),
      runtime
    );
    app = await buildApp(service);
    return { app, repository, runtime, vault };
  }

  async function mutationHeaders(instance: FastifyInstance): Promise<Record<string, string>> {
    const csrf = await instance.inject({ method: "GET", url: "/api/security/csrf" });
    const cookie = csrf.headers["set-cookie"];
    return {
      cookie: Array.isArray(cookie) ? cookie[0]! : cookie!,
      "x-csrf-token": csrf.json<{ csrfToken: string }>().csrfToken
    };
  }

  it("returns redacted status directly and in the dashboard without starting work", async () => {
    const { app: instance, runtime } = await setup();
    const status = await instance.inject({ method: "GET", url: "/api/provider/sol-price-bootstrap" });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      phase: "IDLE",
      authenticationConfigured: false,
      feedId: PYTH_SOL_USD_FEED_ID,
      totalPoints: 12_961
    });
    const dashboard = await instance.inject({ method: "GET", url: "/api/dashboard" });
    expect(dashboard.json()).toMatchObject({ solPriceBootstrap: { phase: "IDLE", completedPoints: 0 } });
    expect(runtime.startCalls).toBe(0);
  });

  it("requires CSRF and the exact typed start and pause phrases", async () => {
    const { app: instance, runtime } = await setup();
    const denied = await instance.inject({
      method: "POST",
      url: "/api/provider/sol-price-bootstrap/start",
      payload: { confirmation: "START PRICE BOOTSTRAP" }
    });
    expect(denied.statusCode).toBe(403);

    const headers = await mutationHeaders(instance);
    for (const payload of [
      {},
      { confirmation: "start pyth bootstrap" },
      { confirmation: "START PRICE BOOTSTRAP", extra: true }
    ]) {
      const invalid = await instance.inject({
        method: "POST",
        url: "/api/provider/sol-price-bootstrap/start",
        headers,
        payload
      });
      expect(invalid.statusCode).toBe(400);
    }
    expect(runtime.startCalls).toBe(0);

    const started = await instance.inject({
      method: "POST",
      url: "/api/provider/sol-price-bootstrap/start",
      headers,
      payload: { confirmation: "START PRICE BOOTSTRAP" }
    });
    expect(started.statusCode).toBe(200);
    expect(started.json()).toMatchObject({ phase: "RUNNING", activeInProcess: true });
    expect(runtime.startCalls).toBe(1);

    const badPause = await instance.inject({
      method: "POST",
      url: "/api/provider/sol-price-bootstrap/pause",
      headers,
      payload: { confirmation: "pause pyth bootstrap" }
    });
    expect(badPause.statusCode).toBe(400);
    const paused = await instance.inject({
      method: "POST",
      url: "/api/provider/sol-price-bootstrap/pause",
      headers,
      payload: { confirmation: "PAUSE PRICE BOOTSTRAP" }
    });
    expect(paused.statusCode).toBe(200);
    expect(paused.json()).toMatchObject({ phase: "PAUSED", activeInProcess: false });
    expect(runtime.pauseCalls).toBe(1);
  });

  it.runIf(process.platform === "win32")(
    "validates and DPAPI-encrypts a Pyth key without ever returning it",
    async () => {
      const { app: instance, repository, runtime, vault } = await setup();
      vault.setCredentials({
        birdeyeApiKey: "birdeye-key",
        heliusApiKey: "helius-key",
        jupiterApiKey: "jupiter-key"
      });
      const secret = "pyth-private-bearer-value";
      const denied = await instance.inject({
        method: "POST",
        url: "/api/provider/sol-price-bootstrap/credentials",
        payload: { pythBenchmarksApiKey: secret, confirmation: "SAVE PYTH API KEY" }
      });
      expect(denied.statusCode).toBe(403);

      const headers = await mutationHeaders(instance);
      for (const payload of [
        { pythBenchmarksApiKey: secret, confirmation: "save pyth api key" },
        { pythBenchmarksApiKey: secret, confirmation: "SAVE PYTH API KEY", extra: true }
      ]) {
        const invalid = await instance.inject({
          method: "POST",
          url: "/api/provider/sol-price-bootstrap/credentials",
          headers,
          payload
        });
        expect(invalid.statusCode).toBe(400);
      }

      const saved = await instance.inject({
        method: "POST",
        url: "/api/provider/sol-price-bootstrap/credentials",
        headers,
        payload: { pythBenchmarksApiKey: secret, confirmation: "SAVE PYTH API KEY" }
      });
      expect(saved.statusCode).toBe(200);
      expect(saved.json()).toMatchObject({ authenticationConfigured: true });
      expect(saved.body).not.toContain(secret);
      expect(runtime.credentials.at(-1)).toEqual({
        birdeyeApiKey: "birdeye-key",
        heliusApiKey: "helius-key",
        jupiterApiKey: "jupiter-key",
        pythBenchmarksApiKey: secret
      });
      expect(vault.getCredentials()?.pythBenchmarksApiKey).toBe(secret);
      expect(repository.getSecretCiphertext("provider-credentials")).not.toContain(secret);

      const status = await instance.inject({
        method: "GET",
        url: "/api/provider/sol-price-bootstrap"
      });
      expect(status.body).not.toContain(secret);
      expect(status.json()).toMatchObject({ authenticationConfigured: true });

      repository.setSetting("mode", "MANUAL_LIVE");
      const blocked = await instance.inject({
        method: "POST",
        url: "/api/provider/sol-price-bootstrap/credentials",
        headers,
        payload: {
          pythBenchmarksApiKey: "replacement-private-value",
          confirmation: "SAVE PYTH API KEY"
        }
      });
      expect(blocked.statusCode).toBe(400);
      expect(vault.getCredentials()?.pythBenchmarksApiKey).toBe(secret);
    }
  );

  it.runIf(process.platform === "win32")(
    "rechecks PAPER mode after asynchronous Pyth credential validation",
    async () => {
      const { app: instance, repository, runtime, vault } = await setup();
      vault.setCredentials({
        birdeyeApiKey: "birdeye-key",
        heliusApiKey: "helius-key",
        jupiterApiKey: "jupiter-key"
      });
      repository.setSetting("mode", "PAPER");
      runtime.onValidate = () => repository.setSetting("mode", "MANUAL_LIVE");
      const headers = await mutationHeaders(instance);
      const response = await instance.inject({
        method: "POST",
        url: "/api/provider/sol-price-bootstrap/credentials",
        headers,
        payload: {
          pythBenchmarksApiKey: "race-safe-private-value",
          confirmation: "SAVE PYTH API KEY"
        }
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: expect.stringContaining("SETUP or PAPER") });
      expect(vault.getCredentials()?.pythBenchmarksApiKey).toBeUndefined();
    }
  );

  it("allows explicit start only in SETUP or PAPER while pause remains fail-safe", async () => {
    const { app: instance, repository, runtime } = await setup();
    const headers = await mutationHeaders(instance);
    const start = () => instance.inject({
      method: "POST",
      url: "/api/provider/sol-price-bootstrap/start",
      headers,
      payload: { confirmation: "START PRICE BOOTSTRAP" }
    });

    expect((await start()).statusCode).toBe(200);
    repository.setSetting("mode", "PAPER");
    expect((await start()).statusCode).toBe(200);
    expect(runtime.startCalls).toBe(2);

    for (const mode of ["MANUAL_LIVE", "AUTO_LIVE", "PAUSED", "LOCKED"] satisfies ModeState[]) {
      repository.setSetting("mode", mode);
      const blocked = await start();
      expect(blocked.statusCode).toBe(400);
      expect(blocked.json()).toMatchObject({ error: expect.stringContaining("only in SETUP or PAPER") });
    }
    expect(runtime.startCalls).toBe(2);

    const paused = await instance.inject({
      method: "POST",
      url: "/api/provider/sol-price-bootstrap/pause",
      headers,
      payload: { confirmation: "PAUSE PRICE BOOTSTRAP" }
    });
    expect(paused.statusCode).toBe(200);
    expect(runtime.pauseCalls).toBe(1);
  });
});
