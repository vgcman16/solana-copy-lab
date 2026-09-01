import type { DashboardSnapshot } from "@copylab/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api";
import {
  loadStartupData,
  StartupTimeoutError,
  type StartupApi,
  type StartupStage
} from "../src/startup";
import type { SetupStatus } from "../src/types";

const configuredStatus: SetupStatus = {
  configured: true,
  credentialsConfigured: true,
  paperConfigured: true,
  providers: [],
  paperCapitalUsd: 50,
  wallet: { exists: false, backupConfirmed: false }
};

const dashboard = {
  mode: "PAPER",
  portfolio: {}
} as unknown as DashboardSnapshot;

function startupApi(overrides: Partial<StartupApi> = {}): StartupApi {
  return {
    getCsrfToken: vi.fn().mockResolvedValue("csrf-token"),
    getSetupStatus: vi.fn().mockResolvedValue(configuredStatus),
    getDashboard: vi.fn().mockResolvedValue(dashboard),
    ...overrides
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("bounded application startup", () => {
  it("loads setup before the dashboard and reports the active stage", async () => {
    const stages: StartupStage[] = [];
    const api = startupApi();
    const controller = new AbortController();

    await expect(loadStartupData({
      api,
      signal: controller.signal,
      onStage: (stage) => stages.push(stage)
    })).resolves.toEqual({
      csrfToken: "csrf-token",
      setupStatus: configuredStatus,
      snapshot: dashboard
    });

    expect(stages).toEqual(["setup", "dashboard"]);
    expect(api.getDashboard).toHaveBeenCalledOnce();
  });

  it("does not request a dashboard before setup is complete", async () => {
    const setupStatus = { ...configuredStatus, configured: false };
    const api = startupApi({ getSetupStatus: vi.fn().mockResolvedValue(setupStatus) });

    await expect(loadStartupData({
      api,
      signal: new AbortController().signal
    })).resolves.toEqual({
      csrfToken: "csrf-token",
      setupStatus,
      snapshot: null
    });
    expect(api.getDashboard).not.toHaveBeenCalled();
  });

  it("times out a slow dashboard request and aborts its fetch signal", async () => {
    vi.useFakeTimers();
    let dashboardSignal: AbortSignal | null = null;
    const api = startupApi({
      getDashboard: vi.fn((signal: AbortSignal) => {
        dashboardSignal = signal;
        return new Promise<DashboardSnapshot>(() => undefined);
      })
    });
    const promise = loadStartupData({
      api,
      signal: new AbortController().signal,
      timeoutMs: 25
    });

    await flushMicrotasks();
    expect(api.getDashboard).toHaveBeenCalledOnce();
    const rejection = expect(promise).rejects.toMatchObject({
      name: "StartupTimeoutError",
      stage: "dashboard",
      timeoutMs: 25
    });
    await vi.advanceTimersByTimeAsync(25);
    await rejection;
    expect(dashboardSignal?.aborted).toBe(true);
  });

  it("aborts both setup reads when the setup stage exceeds its limit", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const pending = (signal: AbortSignal): Promise<never> => {
      signals.push(signal);
      return new Promise<never>(() => undefined);
    };
    const api = startupApi({
      getCsrfToken: pending,
      getSetupStatus: pending
    });
    const promise = loadStartupData({
      api,
      signal: new AbortController().signal,
      timeoutMs: 25
    });

    const rejection = expect(promise).rejects.toBeInstanceOf(StartupTimeoutError);
    await vi.advanceTimersByTimeAsync(25);
    await rejection;
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it("propagates caller cancellation and aborts the in-flight stage", async () => {
    let setupSignal: AbortSignal | null = null;
    const api = startupApi({
      getSetupStatus: vi.fn((signal: AbortSignal) => {
        setupSignal = signal;
        return new Promise<SetupStatus>(() => undefined);
      })
    });
    const controller = new AbortController();
    const promise = loadStartupData({ api, signal: controller.signal, timeoutMs: 1_000 });
    controller.abort();

    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(setupSignal?.aborted).toBe(true);
  });

  it("preserves a backend error instead of replacing it with timeout copy", async () => {
    const backendError = new ApiError("Dashboard snapshot is unavailable", 503);
    const api = startupApi({ getDashboard: vi.fn().mockRejectedValue(backendError) });

    await expect(loadStartupData({
      api,
      signal: new AbortController().signal,
      timeoutMs: 25
    })).rejects.toBe(backendError);
  });
});
