import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { CopyLabDatabase } from "../src/database.js";
import { AppService } from "../src/app-service.js";
import { buildApp } from "../src/app.js";
import { openDatabase } from "../src/database.js";
import { EventBus } from "../src/events.js";
import { ModeManager } from "../src/mode.js";
import { Repository } from "../src/repository.js";
import { SecretVault } from "../src/vault.js";
import { WalletManager } from "../src/wallet.js";
import { MockRuntime } from "./helpers.js";

class CredentialCaptureRuntime extends MockRuntime {
  credentials: Array<{
    birdeyeApiKey?: string;
    heliusApiKey?: string;
    jupiterApiKey: string;
    pythBenchmarksApiKey?: string;
  }> = [];

  override async validateCredentials(credentials: {
    birdeyeApiKey?: string;
    heliusApiKey?: string;
    jupiterApiKey: string;
    pythBenchmarksApiKey?: string;
  }) {
    this.credentials.push({ ...credentials });
    return [{
      provider: "jupiter" as const,
      ok: true,
      checkedAt: new Date().toISOString(),
      latencyMs: 1,
      message: "validated"
    }];
  }
}

describe("loopback API security", () => {
  let db: CopyLabDatabase | undefined;
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    db?.close();
    vi.unstubAllGlobals();
  });

  async function setup(remoteReadOnlyOrigin?: string): Promise<void> {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const vault = new SecretVault(repository);
    const wallet = new WalletManager(vault, repository);
    const modes = new ModeManager(repository, wallet);
    const service = new AppService(
      repository,
      vault,
      wallet,
      modes,
      new EventBus(),
      new MockRuntime()
    );
    app = await buildApp(service, {
      ...(remoteReadOnlyOrigin ? { remoteReadOnlyOrigin } : {})
    });
  }

  it("serves supervisor liveness without invoking setup or database-backed service status", async () => {
    const unavailableService = new Proxy({} as AppService, {
      get: (_target, property) => {
        throw new Error(`Health route touched AppService.${String(property)}.`);
      }
    });
    app = await buildApp(unavailableService);

    const response = await app.inject({ method: "GET", url: "/api/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(response.headers["cache-control"]).toBe("no-store");

    const remote = await app.inject({
      method: "GET",
      url: "/api/health",
      remoteAddress: "192.168.1.50"
    });
    expect(remote.statusCode).toBe(403);

    const rebound = await app.inject({
      method: "GET",
      url: "/api/health",
      headers: { host: "attacker.example" }
    });
    expect(rebound.statusCode).toBe(403);
  });

  it("rejects remote clients", async () => {
    await setup();
    const response = await app!.inject({
      method: "GET",
      url: "/api/setup/status",
      remoteAddress: "192.168.1.50"
    });
    expect(response.statusCode).toBe(403);
  });

  it("rejects DNS-rebinding hosts and cross-site origins even from loopback", async () => {
    await setup();
    const rebound = await app!.inject({
      method: "GET",
      url: "/api/security/csrf",
      headers: { host: "attacker.example" }
    });
    expect(rebound.statusCode).toBe(403);

    const hostileOrigin = await app!.inject({
      method: "GET",
      url: "/api/security/csrf",
      headers: { host: "127.0.0.1:4310", origin: "https://attacker.example" }
    });
    expect(hostileOrigin.statusCode).toBe(403);
  });

  it("allows one exact tailnet origin for reads but keeps every remote mutation blocked", async () => {
    const remoteOrigin = "http://copylab.private-tailnet.ts.net:4311";
    const remoteHost = "copylab.private-tailnet.ts.net:4311";
    await setup(remoteOrigin);

    const page = await app!.inject({
      method: "GET",
      url: "/api/setup/status",
      headers: { host: remoteHost, origin: remoteOrigin }
    });
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-security-policy"]).not.toContain("upgrade-insecure-requests");
    expect(page.headers["strict-transport-security"]).toBeUndefined();
    const pageWithoutOrigin = await app!.inject({
      method: "GET",
      url: "/api/setup/status",
      headers: { host: remoteHost }
    });
    expect(pageWithoutOrigin.statusCode).toBe(200);

    const csrf = await app!.inject({
      method: "GET",
      url: "/api/security/csrf",
      headers: { host: remoteHost, origin: remoteOrigin }
    });
    expect(csrf.statusCode).toBe(200);
    const token = csrf.json<{ csrfToken: string }>().csrfToken;
    const cookie = csrf.headers["set-cookie"];
    const mutation = await app!.inject({
      method: "POST",
      url: "/api/control/recheck-entries",
      headers: {
        host: remoteHost,
        origin: remoteOrigin,
        cookie: Array.isArray(cookie) ? cookie[0]! : cookie!,
        "x-csrf-token": token
      },
      payload: {}
    });
    expect(mutation.statusCode).toBe(403);
    expect(mutation.json()).toEqual({ error: "Private remote dashboard access is read-only." });
    for (const method of ["PUT", "PATCH", "DELETE", "OPTIONS"] as const) {
      const denied = await app!.inject({
        method,
        url: "/api/setup/status",
        headers: {
          host: remoteHost,
          origin: remoteOrigin,
          cookie: Array.isArray(cookie) ? cookie[0]! : cookie!,
          "x-csrf-token": token
        }
      });
      expect(denied.statusCode).toBe(403);
      expect(denied.json()).toEqual({ error: "Private remote dashboard access is read-only." });
    }
  });

  it("allows only the exact Alpaca PAPER credential route through the private tailnet mutation fence", async () => {
    const remoteOrigin = "http://copylab.private-tailnet.ts.net:4311";
    const remoteHost = "copylab.private-tailnet.ts.net:4311";
    await setup(remoteOrigin);
    const csrf = await app!.inject({
      method: "GET",
      url: "/api/security/csrf",
      headers: { host: remoteHost, origin: remoteOrigin }
    });
    const rawCookie = csrf.headers["set-cookie"];
    const headers = {
      host: remoteHost,
      origin: remoteOrigin,
      cookie: Array.isArray(rawCookie) ? rawCookie[0]! : rawCookie!,
      "x-csrf-token": csrf.json<{ csrfToken: string }>().csrfToken
    };

    const reachedSchemaValidation = await app!.inject({
      method: "POST",
      url: "/api/alpaca-paper/credentials",
      headers,
      payload: {
        apiKey: "paper-api-key",
        secretKey: "paper-secret-key",
        confirmation: "WRONG PHRASE"
      }
    });
    expect(reachedSchemaValidation.statusCode).toBe(400);
    expect(reachedSchemaValidation.json()).not.toEqual({
      error: "Private remote dashboard access is read-only."
    });

    const queryVariant = await app!.inject({
      method: "POST",
      url: "/api/alpaca-paper/credentials?unexpected=1",
      headers,
      payload: {}
    });
    expect(queryVariant.statusCode).toBe(403);

    const allOtherMutations = await app!.inject({
      method: "POST",
      url: "/api/control/recheck-entries",
      headers,
      payload: {}
    });
    expect(allOtherMutations.statusCode).toBe(403);
    expect(allOtherMutations.json()).toEqual({
      error: "Private remote dashboard access is read-only."
    });
  });

  it.runIf(process.platform === "win32")(
    "validates and DPAPI-encrypts Alpaca PAPER keys submitted through the exact private route",
    async () => {
      const remoteOrigin = "http://copylab.private-tailnet.ts.net:4311";
      const remoteHost = "copylab.private-tailnet.ts.net:4311";
      await setup(remoteOrigin);
      vi.stubGlobal("fetch", async (input: string | URL | Request) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        return new Response(JSON.stringify(
          url.pathname === "/v2/account"
            ? { status: "ACTIVE", trading_blocked: false }
            : { quote: { ap: 212.5, bp: 212.4 } }
        ), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      });
      const csrf = await app!.inject({
        method: "GET",
        url: "/api/security/csrf",
        headers: { host: remoteHost, origin: remoteOrigin }
      });
      const rawCookie = csrf.headers["set-cookie"];
      const apiKey = "replacement-paper-api-key";
      const secretKey = "replacement-paper-secret-key";
      const response = await app!.inject({
        method: "POST",
        url: "/api/alpaca-paper/credentials",
        headers: {
          host: remoteHost,
          origin: remoteOrigin,
          cookie: Array.isArray(rawCookie) ? rawCookie[0]! : rawCookie!,
          "x-csrf-token": csrf.json<{ csrfToken: string }>().csrfToken
        },
        payload: {
          apiKey,
          secretKey,
          confirmation: "CONNECT ALPACA PAPER"
        }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        configured: true,
        connected: true,
        paperOnly: true,
        liveOrderCapabilityEnabled: false,
        marketDataFeed: "IEX"
      });
      expect(response.body).not.toContain(apiKey);
      expect(response.body).not.toContain(secretKey);
      expect(new SecretVault(new Repository(db!)).getAlpacaPaperCredentials()).toEqual({
        apiKey,
        secretKey
      });
      const encrypted = new Repository(db!).getSecretCiphertext("alpaca-paper-credentials") ?? "";
      expect(encrypted).not.toContain(apiKey);
      expect(encrypted).not.toContain(secretKey);
    }
  );

  it("does not let a configured tailnet host bypass source-IP, exact-host, or origin checks", async () => {
    const remoteOrigin = "http://copylab.private-tailnet.ts.net:4311";
    const remoteHost = "copylab.private-tailnet.ts.net:4311";
    await setup(remoteOrigin);

    const directRemoteClient = await app!.inject({
      method: "GET",
      url: "/api/setup/status",
      remoteAddress: "100.64.0.10",
      headers: { host: remoteHost, origin: remoteOrigin }
    });
    expect(directRemoteClient.statusCode).toBe(403);

    const lookalikeHost = await app!.inject({
      method: "GET",
      url: "/api/setup/status",
      headers: { host: `evil.${remoteHost}`, origin: remoteOrigin }
    });
    expect(lookalikeHost.statusCode).toBe(403);

    const hostileOrigin = await app!.inject({
      method: "GET",
      url: "/api/setup/status",
      headers: { host: remoteHost, origin: "http://attacker.example" }
    });
    expect(hostileOrigin.statusCode).toBe(403);

    const remoteHostWithLoopbackOrigin = await app!.inject({
      method: "GET",
      url: "/api/setup/status",
      headers: { host: remoteHost, origin: "http://127.0.0.1:4310" }
    });
    expect(remoteHostWithLoopbackOrigin.statusCode).toBe(403);

    const loopbackHostWithRemoteOrigin = await app!.inject({
      method: "GET",
      url: "/api/setup/status",
      headers: { host: "127.0.0.1:4310", origin: remoteOrigin }
    });
    expect(loopbackHostWithRemoteOrigin.statusCode).toBe(403);
  });

  it("rejects non-tailnet and path-bearing remote access configuration", async () => {
    await expect(setup("https://attacker.example")).rejects.toThrow(
      "must be an exact Tailscale"
    );
    db?.close();
    db = undefined;
    await expect(setup("https://copylab.private-tailnet.ts.net/admin")).rejects.toThrow(
      "must be an exact Tailscale"
    );
  });

  it("protects the operational safety recheck with the local session and CSRF token", async () => {
    await setup();
    const denied = await app!.inject({
      method: "POST",
      url: "/api/control/recheck-entries",
      payload: {}
    });
    expect(denied.statusCode).toBe(403);

    const csrf = await app!.inject({ method: "GET", url: "/api/security/csrf" });
    const token = csrf.json<{ csrfToken: string }>().csrfToken;
    const cookie = csrf.headers["set-cookie"];
    const allowed = await app!.inject({
      method: "POST",
      url: "/api/control/recheck-entries",
      headers: {
        cookie: Array.isArray(cookie) ? cookie[0]! : cookie!,
        "x-csrf-token": token
      },
      payload: {}
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toMatchObject({ active: false, reasons: [], recovery: "NONE" });
  });

  it("protects the isolated research-paper toggle with session CSRF and exact PAPER mode", async () => {
    await setup();
    const repository = new Repository(db!);
    repository.setSetting("mode", "PAPER");
    repository.setSetting("paper_initial_nav_usd", 141);
    const denied = await app!.inject({
      method: "POST",
      url: "/api/research-paper",
      payload: { enabled: true }
    });
    expect(denied.statusCode).toBe(403);

    const csrf = await app!.inject({ method: "GET", url: "/api/security/csrf" });
    const token = csrf.json<{ csrfToken: string }>().csrfToken;
    const cookie = csrf.headers["set-cookie"];
    const allowed = await app!.inject({
      method: "POST",
      url: "/api/research-paper",
      headers: {
        cookie: Array.isArray(cookie) ? cookie[0]! : cookie!,
        "x-csrf-token": token
      },
      payload: { enabled: true }
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toMatchObject({
      promotionEligible: false,
      executionEnabled: false,
      lane: { status: "ACTIVE", initialNavPerLeaderUsd: 141 }
    });

    const deniedSizing = await app!.inject({
      method: "POST",
      url: "/api/research-paper/sizing/larger",
      payload: { confirmation: "USE $25 HIGH-RISK PAPER POSITIONS" }
    });
    expect(deniedSizing.statusCode).toBe(403);
    const wrongPhrase = await app!.inject({
      method: "POST",
      url: "/api/research-paper/sizing/larger",
      headers: {
        cookie: Array.isArray(cookie) ? cookie[0]! : cookie!,
        "x-csrf-token": token
      },
      payload: { confirmation: "use larger positions" }
    });
    expect(wrongPhrase.statusCode).toBe(400);
    const sized = await app!.inject({
      method: "POST",
      url: "/api/research-paper/sizing/larger",
      headers: {
        cookie: Array.isArray(cookie) ? cookie[0]! : cookie!,
        "x-csrf-token": token
      },
      payload: { confirmation: "USE $25 HIGH-RISK PAPER POSITIONS" }
    });
    expect(sized.statusCode).toBe(200);
    expect(sized.json()).toMatchObject({
      promotionEligible: false,
      executionEnabled: false,
      lane: {
        policyVersion: "high-risk-paper-v2",
        policy: { positionNavFraction: 0.2, maximumPositionUsd: 25 }
      }
    });
  });

  it("requires the exact typed phrase in the live-mode API request", async () => {
    await setup();
    const csrf = await app!.inject({ method: "GET", url: "/api/security/csrf" });
    const token = csrf.json<{ csrfToken: string }>().csrfToken;
    const rawCookie = csrf.headers["set-cookie"];
    const headers = {
      cookie: Array.isArray(rawCookie) ? rawCookie[0]! : rawCookie!,
      "x-csrf-token": token
    };

    for (const payload of [
      { mode: "MANUAL_LIVE" },
      { mode: "MANUAL_LIVE", confirmation: "enable manual live" },
      { mode: "AUTO_LIVE" },
      { mode: "AUTO_LIVE", confirmation: "ENABLE MANUAL LIVE" }
    ]) {
      const response = await app!.inject({ method: "POST", url: "/api/mode", headers, payload });
      expect(response.statusCode).toBe(400);
    }
  });

  it.runIf(process.platform === "win32")("requires both the session cookie and CSRF token for mutations", async () => {
    await setup();
    const pythSecret = "pyth-initial-setup-secret";
    const denied = await app!.inject({
      method: "POST",
      url: "/api/setup/credentials",
      payload: {
        birdeyeApiKey: "birdeye-key",
        heliusApiKey: "helius-key",
        jupiterApiKey: "jupiter-key"
      }
    });
    expect(denied.statusCode).toBe(403);

    const csrf = await app!.inject({ method: "GET", url: "/api/security/csrf" });
    const token = csrf.json<{ csrfToken: string }>().csrfToken;
    const cookie = csrf.headers["set-cookie"];
    const allowed = await app!.inject({
      method: "POST",
      url: "/api/setup/credentials",
      headers: {
        cookie: Array.isArray(cookie) ? cookie[0]! : cookie!,
        "x-csrf-token": token
      },
      payload: {
        birdeyeApiKey: "birdeye-key",
        heliusApiKey: "helius-key",
        jupiterApiKey: "jupiter-key",
        pythBenchmarksApiKey: pythSecret
      }
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toMatchObject({ saved: true });
    expect(allowed.body).not.toContain(pythSecret);
    const repository = new Repository(db!);
    expect(new SecretVault(repository).getCredentials()?.pythBenchmarksApiKey).toBe(pythSecret);
    expect(repository.getSecretCiphertext("provider-credentials")).not.toContain(pythSecret);
  });

  it.runIf(process.platform === "win32")("initializes the configured $141 paper bankroll and rejects the old $50 baseline", async () => {
    await setup();
    const csrf = await app!.inject({ method: "GET", url: "/api/security/csrf" });
    const token = csrf.json<{ csrfToken: string }>().csrfToken;
    const rawCookie = csrf.headers["set-cookie"];
    const headers = {
      cookie: Array.isArray(rawCookie) ? rawCookie[0]! : rawCookie!,
      "x-csrf-token": token
    };
    const credentials = await app!.inject({
      method: "POST",
      url: "/api/setup/credentials",
      headers,
      payload: {
        birdeyeApiKey: "birdeye-key",
        heliusApiKey: "helius-key",
        jupiterApiKey: "jupiter-key"
      }
    });
    expect(credentials.statusCode).toBe(200);

    const oldBaseline = await app!.inject({
      method: "POST",
      url: "/api/setup/paper",
      headers,
      payload: { initialNavUsd: 50 }
    });
    expect(oldBaseline.statusCode).toBe(400);
    expect(oldBaseline.json()).toMatchObject({ error: expect.stringContaining("$141") });

    const paper = await app!.inject({
      method: "POST",
      url: "/api/setup/paper",
      headers,
      payload: { initialNavUsd: 141 }
    });
    expect(paper.statusCode).toBe(200);
    expect(paper.json()).toMatchObject({ navUsd: 141, liquidReserveUsd: 141, solReserveUsd: 6 });

    const status = await app!.inject({ method: "GET", url: "/api/setup/status" });
    expect(status.json()).toMatchObject({
      configured: true,
      paperInitialized: true,
      paperCapitalUsd: 141,
      mode: "PAPER"
    });
  });

  it.runIf(process.platform === "win32")(
    "accepts Jupiter-only credentials in SELF_HOSTED and preserves the omitted managed secrets",
    async () => {
      db = openDatabase(":memory:");
      const repository = new Repository(db);
      const vault = new SecretVault(repository);
      vault.setDataProviderProfile({
        mode: "SELF_HOSTED",
        solanaHttpUrl: "http://127.0.0.1:8899",
        solanaWsUrl: "ws://127.0.0.1:8900"
      });
      const wallet = new WalletManager(vault, repository);
      const runtime = new CredentialCaptureRuntime();
      const service = new AppService(
        repository,
        vault,
        wallet,
        new ModeManager(repository, wallet),
        new EventBus(),
        runtime
      );
      app = await buildApp(service);
      const csrf = await app.inject({ method: "GET", url: "/api/security/csrf" });
      const rawCookie = csrf.headers["set-cookie"];
      const response = await app.inject({
        method: "POST",
        url: "/api/setup/credentials",
        headers: {
          cookie: Array.isArray(rawCookie) ? rawCookie[0]! : rawCookie!,
          "x-csrf-token": csrf.json<{ csrfToken: string }>().csrfToken
        },
        payload: { jupiterApiKey: "jupiter-key" }
      });

      expect(response.statusCode).toBe(200);
      expect(runtime.credentials).toEqual([{ jupiterApiKey: "jupiter-key" }]);
      expect(vault.getCredentials()).toEqual({ jupiterApiKey: "jupiter-key" });
      expect(service.setupStatus().credentialsConfigured).toBe(true);
    }
  );

  it("rejects a partial managed credential pair before provider validation", async () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const vault = new SecretVault(repository);
    const wallet = new WalletManager(vault, repository);
    const runtime = new CredentialCaptureRuntime();
    const service = new AppService(
      repository,
      vault,
      wallet,
      new ModeManager(repository, wallet),
      new EventBus(),
      runtime
    );
    app = await buildApp(service);
    const csrf = await app.inject({ method: "GET", url: "/api/security/csrf" });
    const rawCookie = csrf.headers["set-cookie"];
    const response = await app.inject({
      method: "POST",
      url: "/api/setup/credentials",
      headers: {
        cookie: Array.isArray(rawCookie) ? rawCookie[0]! : rawCookie!,
        "x-csrf-token": csrf.json<{ csrfToken: string }>().csrfToken
      },
      payload: {
        birdeyeApiKey: "birdeye-key",
        jupiterApiKey: "jupiter-key"
      }
    });

    expect(response.statusCode).toBe(400);
    expect(runtime.credentials).toHaveLength(0);
  });

  it.runIf(process.platform === "win32")(
    "blocks credential replacement outside SETUP/PAPER before provider validation",
    async () => {
      db = openDatabase(":memory:");
      const repository = new Repository(db);
      repository.setSetting("mode", "MANUAL_LIVE");
      const vault = new SecretVault(repository);
      const wallet = new WalletManager(vault, repository);
      const runtime = new CredentialCaptureRuntime();
      const service = new AppService(
        repository,
        vault,
        wallet,
        new ModeManager(repository, wallet),
        new EventBus(),
        runtime
      );

      await expect(service.saveCredentials({
        birdeyeApiKey: "new-birdeye",
        heliusApiKey: "new-helius",
        jupiterApiKey: "new-jupiter"
      })).rejects.toThrow("only in SETUP or PAPER");
      expect(runtime.credentials).toHaveLength(0);
      expect(vault.hasCredentials()).toBe(false);
    }
  );

  it.runIf(process.platform === "win32")(
    "rolls the encrypted credential vault back when runtime reconfiguration fails",
    async () => {
      db = openDatabase(":memory:");
      const repository = new Repository(db);
      const vault = new SecretVault(repository);
      vault.setCredentials({
        birdeyeApiKey: "old-birdeye",
        heliusApiKey: "old-helius",
        jupiterApiKey: "old-jupiter"
      });
      const wallet = new WalletManager(vault, repository);
      const runtime = new CredentialCaptureRuntime();
      let changes = 0;
      runtime.credentialsChanged = async () => {
        changes += 1;
        if (changes === 1) throw new Error("reconfiguration failed");
      };
      const service = new AppService(
        repository,
        vault,
        wallet,
        new ModeManager(repository, wallet),
        new EventBus(),
        runtime
      );

      await expect(service.saveCredentials({
        birdeyeApiKey: "new-birdeye",
        heliusApiKey: "new-helius",
        jupiterApiKey: "new-jupiter"
      })).rejects.toThrow("reconfiguration failed");
      expect(vault.getCredentials()).toEqual({
        birdeyeApiKey: "old-birdeye",
        heliusApiKey: "old-helius",
        jupiterApiKey: "old-jupiter"
      });
      expect(changes).toBe(2);
      expect(runtime.providerQuiesceCalls).toBe(1);
      expect(runtime.providerResumeCalls).toBe(1);
      expect(runtime.providerWorkQuiesced).toBe(false);
    }
  );

  it.runIf(process.platform === "win32")(
    "keeps credentials quiesced when runtime rollback cannot restore the prior provider",
    async () => {
      db = openDatabase(":memory:");
      const repository = new Repository(db);
      const vault = new SecretVault(repository);
      vault.setCredentials({
        birdeyeApiKey: "old-birdeye",
        heliusApiKey: "old-helius",
        jupiterApiKey: "old-jupiter"
      });
      const wallet = new WalletManager(vault, repository);
      const runtime = new CredentialCaptureRuntime();
      runtime.credentialsChanged = async () => {
        throw new Error("reconfiguration failed");
      };
      const service = new AppService(
        repository,
        vault,
        wallet,
        new ModeManager(repository, wallet),
        new EventBus(),
        runtime
      );

      await expect(service.saveCredentials({
        birdeyeApiKey: "new-birdeye",
        heliusApiKey: "new-helius",
        jupiterApiKey: "new-jupiter"
      })).rejects.toThrow("rollback stayed quiesced");
      expect(vault.getCredentials()).toEqual({
        birdeyeApiKey: "old-birdeye",
        heliusApiKey: "old-helius",
        jupiterApiKey: "old-jupiter"
      });
      expect(runtime.providerQuiesceCalls).toBe(1);
      expect(runtime.providerResumeCalls).toBe(0);
      expect(runtime.providerWorkQuiesced).toBe(true);
      expect(repository.listAudit(20)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          eventType: "provider_credentials_rollback_failed",
          severity: "critical"
        })
      ]));
    }
  );
});
