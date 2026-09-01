import type { DashboardSnapshot } from "@copylab/shared";
import { getCsrfToken, getDashboard, getSetupStatus } from "./api";
import type { SetupStatus } from "./types";

export const STARTUP_SLOW_AFTER_MS = 5_000;
export const STARTUP_REQUEST_TIMEOUT_MS = 30_000;

export type StartupStage = "setup" | "dashboard";

export interface StartupResult {
  csrfToken: string;
  setupStatus: SetupStatus;
  snapshot: DashboardSnapshot | null;
}

export interface StartupApi {
  getCsrfToken: (signal: AbortSignal) => Promise<string>;
  getSetupStatus: (signal: AbortSignal) => Promise<SetupStatus>;
  getDashboard: (signal: AbortSignal) => Promise<DashboardSnapshot>;
}

export class StartupTimeoutError extends Error {
  readonly stage: StartupStage;
  readonly timeoutMs: number;

  constructor(stage: StartupStage, timeoutMs: number) {
    const label = stage === "setup" ? "setup and session checks" : "dashboard request";
    super(`The ${label} did not finish within ${Math.round(timeoutMs / 1_000)} seconds.`);
    this.name = "StartupTimeoutError";
    this.stage = stage;
    this.timeoutMs = timeoutMs;
  }
}

const defaultApi: StartupApi = {
  getCsrfToken,
  getSetupStatus,
  getDashboard
};

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The startup request was canceled.", "AbortError");
}

async function runBoundedStage<T>(
  stage: StartupStage,
  signal: AbortSignal,
  timeoutMs: number,
  operation: (stageSignal: AbortSignal) => Promise<T>
): Promise<T> {
  if (signal.aborted) throw abortReason(signal);

  const stageController = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let timeoutError: StartupTimeoutError | null = null;
  let rejectOnCallerAbort: ((reason: unknown) => void) | null = null;

  const callerAbortPromise = new Promise<never>((_resolve, reject) => {
    rejectOnCallerAbort = reject;
  });
  const onCallerAbort = (): void => {
    const reason = abortReason(signal);
    stageController.abort(reason);
    rejectOnCallerAbort?.(reason);
  };
  signal.addEventListener("abort", onCallerAbort, { once: true });

  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      timeoutError = new StartupTimeoutError(stage, timeoutMs);
      reject(timeoutError);
      stageController.abort(timeoutError);
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      operation(stageController.signal),
      timeoutPromise,
      callerAbortPromise
    ]);
  } catch (reason) {
    if (timeoutError !== null) throw timeoutError;
    if (signal.aborted) throw abortReason(signal);
    if (!stageController.signal.aborted) stageController.abort(reason);
    throw reason;
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
    signal.removeEventListener("abort", onCallerAbort);
    rejectOnCallerAbort = null;
  }
}

export async function loadStartupData(options: {
  signal: AbortSignal;
  timeoutMs?: number;
  onStage?: (stage: StartupStage) => void;
  api?: StartupApi;
}): Promise<StartupResult> {
  const timeoutMs = options.timeoutMs ?? STARTUP_REQUEST_TIMEOUT_MS;
  const api = options.api ?? defaultApi;

  options.onStage?.("setup");
  const [csrfToken, setupStatus] = await runBoundedStage(
    "setup",
    options.signal,
    timeoutMs,
    (signal) => Promise.all([api.getCsrfToken(signal), api.getSetupStatus(signal)])
  );

  if (!setupStatus.configured) {
    return { csrfToken, setupStatus, snapshot: null };
  }

  options.onStage?.("dashboard");
  const snapshot = await runBoundedStage(
    "dashboard",
    options.signal,
    timeoutMs,
    api.getDashboard
  );
  return { csrfToken, setupStatus, snapshot };
}
