import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  captureProviderParityBaseline,
  changeMode,
  createLiveWallet,
  getCsrfToken,
  getDataProviderStatus,
  getProviderParityBaselineStatus,
  getSolPriceBootstrapStatus,
  getSetupStatus,
  getWalletResearch,
  initializePaper,
  pauseSolPriceBootstrap,
  saveDataProviderProfile,
  savePythBenchmarksApiKey,
  setAutonomousPaperEnabled,
  setResearchPaperEnabled,
  startSolPriceBootstrap,
  subscribeToDashboard
} from "../src/api";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("local API client", () => {
  it("subscribes dashboard refreshes to every long-running and signal-outcome event", () => {
    const eventNames: string[] = [];
    let closed = false;
    class FakeEventSource {
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onmessage: ((event: MessageEvent<string>) => void) | null = null;
      constructor(_url: string, _options: EventSourceInit) {}
      addEventListener(name: string): void { eventNames.push(name); }
      close(): void { closed = true; }
    }
    vi.stubGlobal("EventSource", FakeEventSource);

    const unsubscribe = subscribeToDashboard(() => undefined, () => undefined, () => undefined);
    expect(eventNames).toEqual(expect.arrayContaining([
      "wallet-index",
      "wallet-index-reprice",
      "wallet-index-deep-history",
      "wallet-research-qualified",
      "sol-price-bootstrap",
      "research-paper",
      "autonomous-paper",
      "stock-paper",
      "alpaca-paper",
      "parsed-block-repair",
      "signal-outcome"
    ]));
    unsubscribe();
    expect(closed).toBe(true);
  });

  it("normalizes the setup status contract", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      credentialsConfigured: true,
      paperInitialized: true,
      paperCapitalUsd: 50,
      mode: "PAPER",
      wallet: { exists: true, address: "BotAddress", backupConfirmed: false }
    })));

    await expect(getSetupStatus()).resolves.toEqual({
      configured: true,
      credentialsConfigured: true,
      paperConfigured: true,
      providers: [],
      paperCapitalUsd: 50,
      wallet: { exists: true, address: "BotAddress", backupConfirmed: false }
    });
  });

  it("accepts either supported CSRF response field", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ token: "first-token" }))
      .mockResolvedValueOnce(jsonResponse({ csrfToken: "second-token" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getCsrfToken()).resolves.toBe("first-token");
    await expect(getCsrfToken()).resolves.toBe("second-token");
  });

  it("sends the CSRF token and exact paper-capital payload", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await initializePaper(141, "csrf-value");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/setup/paper");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("x-csrf-token")).toBe("csrf-value");
    expect(JSON.parse(String(init.body))).toEqual({ initialNavUsd: 141 });
  });

  it("reads only the redacted data-provider status contract", async () => {
    const status = {
      profile: {
        mode: "SHADOW",
        configured: true,
        httpOrigin: "https://rpc.example.test",
        wsOrigin: "wss://rpc.example.test"
      },
      priceCoverage: { count: 4 },
      parity: {
        observations: 2,
        latestMatches: 2,
        latestDivergences: 0,
        latestUnavailable: 0,
        latestPending: 0,
        matchedCapabilities: ["chain_health"],
        matchedSubjectCounts: { CHAIN_HEALTH: 2 },
        commonReplayWallets: 0,
        evidenceDays: 1
      },
      selfHostedReady: false,
      blockers: ["More evidence required"]
    };
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse(status));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getDataProviderStatus()).resolves.toEqual(status);
    expect(fetchMock).toHaveBeenCalledWith("/api/provider/profile", expect.any(Object));
  });

  it("sends an exact CSRF-protected shadow profile", async () => {
    const responseStatus = {
      profile: { mode: "SHADOW", configured: true, httpOrigin: "https://rpc.example.test", wsOrigin: "wss://rpc.example.test" },
      priceCoverage: { count: 0 },
      parity: { observations: 0, latestMatches: 0, latestDivergences: 0, latestUnavailable: 0, latestPending: 0, matchedCapabilities: [], matchedSubjectCounts: {}, commonReplayWallets: 0, evidenceDays: 0 },
      selfHostedReady: false,
      blockers: []
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(responseStatus));
    vi.stubGlobal("fetch", fetchMock);

    await saveDataProviderProfile({
      mode: "SHADOW",
      solanaHttpUrl: "https://rpc.example.test/private-path",
      solanaWsUrl: "wss://rpc.example.test/private-path",
      confirmation: "ENABLE SHADOW DATA"
    }, "csrf-value");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/provider/profile");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("x-csrf-token")).toBe("csrf-value");
    expect(JSON.parse(String(init.body))).toEqual({
      mode: "SHADOW",
      solanaHttpUrl: "https://rpc.example.test/private-path",
      solanaWsUrl: "wss://rpc.example.test/private-path",
      confirmation: "ENABLE SHADOW DATA"
    });
  });

  it("reads bootstrap status and sends exact CSRF-protected bootstrap mutations", async () => {
    const status = {
      phase: "IDLE",
      activeInProcess: false,
      authenticationConfigured: false,
      checkpointValid: true,
      feedId: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
      intervalSeconds: 600,
      horizonDays: 90,
      totalPoints: 12_961,
      completedPoints: 0,
      remainingPoints: 12_961,
      insertedSnapshots: 0,
      preservedSnapshots: 0,
      progressPercent: 0,
      cursorAttempts: 0
    };
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse(status));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getSolPriceBootstrapStatus()).resolves.toEqual(status);
    await startSolPriceBootstrap("START PRICE BOOTSTRAP", "csrf-value");
    await pauseSolPriceBootstrap("PAUSE PRICE BOOTSTRAP", "csrf-value");
    await savePythBenchmarksApiKey("pyth-secret-value", "SAVE PYTH API KEY", "csrf-value");

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/provider/sol-price-bootstrap",
      "/api/provider/sol-price-bootstrap/start",
      "/api/provider/sol-price-bootstrap/pause",
      "/api/provider/sol-price-bootstrap/credentials"
    ]);
    const startInit = fetchMock.mock.calls[1]![1] as RequestInit;
    const pauseInit = fetchMock.mock.calls[2]![1] as RequestInit;
    expect(new Headers(startInit.headers).get("x-csrf-token")).toBe("csrf-value");
    expect(JSON.parse(String(startInit.body))).toEqual({ confirmation: "START PRICE BOOTSTRAP" });
    expect(new Headers(pauseInit.headers).get("x-csrf-token")).toBe("csrf-value");
    expect(JSON.parse(String(pauseInit.body))).toEqual({ confirmation: "PAUSE PRICE BOOTSTRAP" });
    const credentialsInit = fetchMock.mock.calls[3]![1] as RequestInit;
    expect(new Headers(credentialsInit.headers).get("x-csrf-token")).toBe("csrf-value");
    expect(JSON.parse(String(credentialsInit.body))).toEqual({
      pythBenchmarksApiKey: "pyth-secret-value",
      confirmation: "SAVE PYTH API KEY"
    });
  });

  it("reads and captures the frozen parity baseline with exact CSRF confirmation", async () => {
    const status = {
      id: "baseline-1",
      status: "BLOCKED",
      blockers: [{ code: "MANAGED_PNL_AS_OF_UNSUPPORTED", message: "No historical cutoff." }],
      acquisitions: []
    };
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse(status));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getProviderParityBaselineStatus()).resolves.toEqual(status);
    await expect(captureProviderParityBaseline(
      "CAPTURE FROZEN PARITY BASELINE",
      "csrf-value"
    )).resolves.toEqual(status);

    expect(fetchMock.mock.calls[0]![0]).toBe("/api/provider/parity-baseline");
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe("/api/provider/parity-baseline/capture");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("x-csrf-token")).toBe("csrf-value");
    expect(JSON.parse(String(init.body))).toEqual({
      confirmation: "CAPTURE FROZEN PARITY BASELINE"
    });
  });

  it("never adds endpoint fields to a managed-profile request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      profile: { mode: "MANAGED", configured: true },
      priceCoverage: { count: 0 },
      parity: { observations: 0, latestMatches: 0, latestDivergences: 0, latestUnavailable: 0, latestPending: 0, matchedCapabilities: [], matchedSubjectCounts: {}, commonReplayWallets: 0, evidenceDays: 0 },
      selfHostedReady: false,
      blockers: []
    }));
    vi.stubGlobal("fetch", fetchMock);

    await saveDataProviderProfile({ mode: "MANAGED", confirmation: "USE MANAGED DATA" }, "csrf-value");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ mode: "MANAGED", confirmation: "USE MANAGED DATA" });
  });

  it("places the typed live confirmation inside the protected mode request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ mode: "MANUAL_LIVE" }));
    vi.stubGlobal("fetch", fetchMock);

    await changeMode("MANUAL_LIVE", "ENABLE MANUAL LIVE", "csrf-value");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/mode");
    expect(new Headers(init.headers).get("x-csrf-token")).toBe("csrf-value");
    expect(JSON.parse(String(init.body))).toEqual({
      mode: "MANUAL_LIVE",
      confirmation: "ENABLE MANUAL LIVE"
    });
  });

  it("toggles the isolated research-paper lane with an exact CSRF-protected payload", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await setResearchPaperEnabled(true, "csrf-value");
    await setResearchPaperEnabled(false, "csrf-value");

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/research-paper",
      "/api/research-paper"
    ]);
    for (const [, init] of fetchMock.mock.calls as Array<[string, RequestInit]>) {
      expect(init.method).toBe("POST");
      expect(new Headers(init.headers).get("x-csrf-token")).toBe("csrf-value");
    }
    expect(JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body))).toEqual({ enabled: true });
    expect(JSON.parse(String((fetchMock.mock.calls[1]![1] as RequestInit).body))).toEqual({ enabled: false });
  });

  it("toggles the autonomous PAPER lane with an exact CSRF-protected payload", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await setAutonomousPaperEnabled(true, "csrf-value");
    await setAutonomousPaperEnabled(false, "csrf-value");

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/autonomous-paper",
      "/api/autonomous-paper"
    ]);
    for (const [, init] of fetchMock.mock.calls as Array<[string, RequestInit]>) {
      expect(init.method).toBe("POST");
      expect(new Headers(init.headers).get("x-csrf-token")).toBe("csrf-value");
    }
    expect(JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body))).toEqual({ enabled: true });
    expect(JSON.parse(String((fetchMock.mock.calls[1]![1] as RequestInit).body))).toEqual({ enabled: false });
  });

  it("posts only the backup passphrase when creating the bot wallet", async () => {
    const result = { address: "BotAddress", filename: "recovery.json", recovery: { version: 1 } };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(result));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createLiveWallet("a-long-local-passphrase", "csrf-value")).resolves.toEqual(result);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/wallet/create");
    expect(JSON.parse(String(init.body))).toEqual({ backupPassphrase: "a-long-local-passphrase" });
  });

  it("requests one bounded wallet-research page with explicit filters", async () => {
    const payload = {
      items: [],
      page: 3,
      pageSize: 25,
      total: 75,
      totalPages: 3,
      filter: "PRESCREEN_READY",
      sort: "ACTIVITY",
      capturedAt: "2026-07-09T12:00:00.000Z"
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(payload));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getWalletResearch({
      page: 3,
      filter: "PRESCREEN_READY",
      sort: "ACTIVITY"
    })).resolves.toEqual(payload);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/wallets/research?page=3&pageSize=25&filter=PRESCREEN_READY&sort=ACTIVITY");
  });

  it("surfaces server errors without leaking the response body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "Provider key rejected" }, 400)));
    await expect(getSetupStatus()).rejects.toEqual(new ApiError("Provider key rejected", 400));
  });
});
