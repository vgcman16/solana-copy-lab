import { useCallback, useEffect, useRef, useState } from "react";
import type { DashboardSnapshot } from "@copylab/shared";
import {
  ApiError,
  getDashboard,
  getSetupStatus,
  subscribeToDashboard
} from "./api";
import {
  loadStartupData,
  STARTUP_REQUEST_TIMEOUT_MS,
  STARTUP_SLOW_AFTER_MS,
  StartupTimeoutError,
  type StartupStage
} from "./startup";
import { createTrailingRefreshScheduler } from "./trailing-refresh-scheduler";
import type { SetupStatus, ToastMessage, ToastTone } from "./types";
import { Dashboard } from "./components/Dashboard";
import { Icon } from "./components/Icon";
import { Brand, Button } from "./components/Primitives";
import { SetupWizard } from "./components/SetupWizard";

type AppPhase = "loading" | "error" | "setup" | "dashboard";

interface StartupProblem {
  eyebrow: string;
  title: string;
  detail: string;
  endpoint: string;
}

function startupEndpoint(stage: StartupStage): string {
  return stage === "setup"
    ? "/api/setup/status + /api/security/csrf"
    : "/api/dashboard";
}

function isAbortError(reason: unknown): boolean {
  return reason instanceof DOMException && reason.name === "AbortError";
}

function describeStartupProblem(reason: unknown, stage: StartupStage): StartupProblem {
  if (reason instanceof StartupTimeoutError) {
    return {
      eyebrow: "Startup check timed out",
      title: "The local server took too long to respond.",
      detail: `${reason.message} This startup check is read-only; no settings were changed.`,
      endpoint: startupEndpoint(reason.stage)
    };
  }
  if (reason instanceof ApiError) {
    return {
      eyebrow: `Local server error · HTTP ${reason.status}`,
      title: "CopyLab could not finish opening.",
      detail: reason.message,
      endpoint: startupEndpoint(stage)
    };
  }
  if (reason instanceof TypeError) {
    return {
      eyebrow: "Local server unavailable",
      title: "The browser could not reach CopyLab.",
      detail: reason.message || "The connection to the local server failed.",
      endpoint: startupEndpoint(stage)
    };
  }
  return {
    eyebrow: "Startup failed",
    title: "CopyLab could not finish opening.",
    detail: reason instanceof Error ? reason.message : "The local server could not be reached.",
    endpoint: startupEndpoint(stage)
  };
}

export default function App() {
  const [phase, setPhase] = useState<AppPhase>("loading");
  const [csrfToken, setCsrfToken] = useState("");
  const [setupStatus, setSetupStatus] = useState<SetupStatus | null>(null);
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [startupProblem, setStartupProblem] = useState<StartupProblem | null>(null);
  const [startupStage, setStartupStage] = useState<StartupStage>("setup");
  const [startupDelayed, setStartupDelayed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [streamConnected, setStreamConnected] = useState(false);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const toastId = useRef(0);
  const startupController = useRef<AbortController | null>(null);
  const startupDelayTimer = useRef<number | null>(null);

  const notify = useCallback((tone: ToastTone, title: string, detail?: string) => {
    const id = ++toastId.current;
    const message: ToastMessage = detail === undefined ? { id, tone, title } : { id, tone, title, detail };
    setToasts((current) => [...current, message].slice(-3));
    window.setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 5_000);
  }, []);

  const clearStartupDelay = useCallback(() => {
    if (startupDelayTimer.current !== null) {
      window.clearTimeout(startupDelayTimer.current);
      startupDelayTimer.current = null;
    }
  }, []);

  const loadApplication = useCallback(async () => {
    startupController.current?.abort();
    clearStartupDelay();
    const controller = new AbortController();
    startupController.current = controller;
    setPhase("loading");
    setStartupProblem(null);
    setStartupDelayed(false);
    setStreamConnected(false);
    let activeStage: StartupStage = "setup";

    try {
      const result = await loadStartupData({
        signal: controller.signal,
        onStage: (stage) => {
          if (startupController.current !== controller || controller.signal.aborted) return;
          activeStage = stage;
          setStartupStage(stage);
          setStartupDelayed(false);
          clearStartupDelay();
          startupDelayTimer.current = window.setTimeout(() => {
            if (startupController.current === controller && !controller.signal.aborted) {
              setStartupDelayed(true);
            }
          }, STARTUP_SLOW_AFTER_MS);
        }
      });
      if (startupController.current !== controller || controller.signal.aborted) return;
      setCsrfToken(result.csrfToken);
      setSetupStatus(result.setupStatus);
      setSnapshot(result.snapshot);
      setPhase(result.snapshot === null ? "setup" : "dashboard");
    } catch (reason) {
      if (
        startupController.current !== controller
        || controller.signal.aborted
        || isAbortError(reason)
      ) return;
      setStartupProblem(describeStartupProblem(reason, activeStage));
      setPhase("error");
    } finally {
      if (startupController.current === controller) {
        clearStartupDelay();
        startupController.current = null;
      }
    }
  }, [clearStartupDelay]);

  useEffect(() => {
    void loadApplication();
    return () => {
      startupController.current?.abort();
      startupController.current = null;
      clearStartupDelay();
    };
  }, [clearStartupDelay, loadApplication]);

  useEffect(() => {
    if (phase !== "dashboard") return;
    const refreshScheduler = createTrailingRefreshScheduler({
      refresh: (signal) => getDashboard(signal),
      onSuccess: setSnapshot,
      onError: () => setStreamConnected(false)
    });
    const requestVisibleRefresh = (): void => {
      if (document.visibilityState === "visible") refreshScheduler.request();
    };
    document.addEventListener("visibilitychange", requestVisibleRefresh);
    const unsubscribe = subscribeToDashboard(setSnapshot, setStreamConnected, (eventType) => {
      // High-frequency index and price-bootstrap events are hints, not full
      // snapshots. Coalesce them into one bounded single-flight dashboard read
      // and leave hidden tabs dormant so multiple open copies cannot amplify a
      // busy SQLite worker into a request pile-up.
      requestVisibleRefresh();
      if (eventType === "wallet" || eventType === "setup") {
        void getSetupStatus().then(setSetupStatus).catch(() => undefined);
      }
    });
    return () => {
      document.removeEventListener("visibilitychange", requestVisibleRefresh);
      refreshScheduler.dispose();
      unsubscribe();
    };
  }, [phase]);

  const refreshSetup = useCallback(async (): Promise<SetupStatus> => {
    const status = await getSetupStatus();
    setSetupStatus(status);
    return status;
  }, []);

  const refreshDashboard = useCallback(async () => {
    setRefreshing(true);
    try {
      const nextSnapshot = await getDashboard();
      setSnapshot(nextSnapshot);
    } catch (reason) {
      notify("danger", "Refresh failed", reason instanceof Error ? reason.message : "Unknown error");
    } finally {
      setRefreshing(false);
    }
  }, [notify]);

  return (
    <>
      {phase === "loading" && <LoadingScreen
        stage={startupStage}
        delayed={startupDelayed}
        onRetry={() => void loadApplication()}
        onReload={() => window.location.reload()}
      />}
      {phase === "error" && startupProblem && <ConnectionError
        problem={startupProblem}
        onRetry={() => void loadApplication()}
        onReload={() => window.location.reload()}
      />}
      {phase === "setup" && setupStatus && csrfToken && (
        <SetupWizard csrfToken={csrfToken} status={setupStatus} onRefresh={refreshSetup} onComplete={loadApplication} />
      )}
      {phase === "dashboard" && snapshot && setupStatus && csrfToken && (
        <Dashboard
          snapshot={snapshot}
          csrfToken={csrfToken}
          streamConnected={streamConnected}
          refreshing={refreshing}
          onRefresh={refreshDashboard}
          setupStatus={setupStatus}
          onSetupRefresh={refreshSetup}
          notify={notify}
        />
      )}
      <div className="toast-region" aria-live="polite" aria-atomic="false">
        {toasts.map((toast) => <div className={`toast toast-${toast.tone}`} key={toast.id}>
          <span className="toast-icon"><Icon name={toast.tone === "success" ? "check" : toast.tone === "danger" ? "alert" : "activity"} size={17} /></span>
          <div><strong>{toast.title}</strong>{toast.detail && <p>{toast.detail}</p>}</div>
          <button onClick={() => setToasts((current) => current.filter((item) => item.id !== toast.id))} aria-label="Dismiss notification"><Icon name="close" size={15} /></button>
        </div>)}
      </div>
    </>
  );
}

function LoadingScreen({
  stage,
  delayed,
  onRetry,
  onReload
}: {
  stage: StartupStage;
  delayed: boolean;
  onRetry: () => void;
  onReload: () => void;
}) {
  const timeoutSeconds = Math.round(STARTUP_REQUEST_TIMEOUT_MS / 1_000);
  return (
    <main className="state-screen loading-screen" aria-busy="true">
      <Brand />
      <div className="loading-orbit"><span /><span /><Icon name="activity" size={25} /></div>
      <p className="eyebrow">{delayed ? "Taking longer than usual" : "Opening your local lab"}</p>
      <h1>{stage === "setup" ? "Checking local setup" : "Loading the dashboard"}</h1>
      <p aria-live="polite">{stage === "setup"
        ? "Waiting for the encrypted setup and local session checks."
        : "Setup is ready. Waiting for the current dashboard snapshot."}</p>
      <div className={`loading-status ${delayed ? "slow" : ""}`}>
        <span>Current request</span>
        <code>{startupEndpoint(stage)}</code>
        <small>{delayed
          ? `No response has completed yet. This attempt stops automatically after ${timeoutSeconds} seconds.`
          : `The request will stop automatically if it exceeds ${timeoutSeconds} seconds.`}</small>
      </div>
      {delayed && <div className="state-actions">
        <Button tone="primary" icon="refresh" onClick={onRetry}>Retry now</Button>
        <Button tone="secondary" onClick={onReload}>Reload page</Button>
      </div>}
    </main>
  );
}

function ConnectionError({
  problem,
  onRetry,
  onReload
}: {
  problem: StartupProblem;
  onRetry: () => void;
  onReload: () => void;
}) {
  return (
    <main className="state-screen error-screen">
      <Brand />
      <span className="state-icon"><Icon name="alert" size={27} /></span>
      <p className="eyebrow">{problem.eyebrow}</p>
      <h1>{problem.title}</h1>
      <p className="state-detail">{problem.detail}</p>
      <div className="server-hint"><span>Startup request</span><code>{problem.endpoint}</code></div>
      <div className="state-actions">
        <Button tone="primary" icon="refresh" onClick={onRetry}>Try again</Button>
        <Button tone="secondary" onClick={onReload}>Reload page</Button>
      </div>
    </main>
  );
}
