import type {
  AlpacaPaperStatus,
  DashboardSnapshot,
  AutonomousLearningOverview,
  ChampionPromotionDecision,
  DataProviderStatus,
  ModeState,
  OperationalPauseState,
  ProviderHealth,
  SolPriceBootstrapStatus,
  WalletResearchFilter,
  WalletResearchPage,
  WalletResearchSort
} from "@copylab/shared";
import type {
  AlpacaPaperCredentialsInput,
  ApiEnvelope,
  CredentialsInput,
  DataProviderProfileRequest,
  DashboardEvent,
  ProviderParityBaselineStatus,
  SetupStatus,
  WalletCreationResult,
  LiveWalletStatus
} from "./types";

const API_ROOT = "/api";

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function unwrap<T>(value: unknown): T {
  if (isRecord(value) && "data" in value && value.data !== undefined) {
    return value.data as T;
  }
  return value as T;
}

function errorText(value: unknown, fallback: string): string {
  if (!isRecord(value)) return fallback;
  const envelope = value as ApiEnvelope<unknown>;
  if (typeof envelope.error === "string" && envelope.error.trim()) return envelope.error;
  if (typeof envelope.message === "string" && envelope.message.trim()) return envelope.message;
  return fallback;
}

async function parseResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export async function apiRequest<T>(
  path: string,
  options: {
    method?: "GET" | "POST";
    body?: unknown;
    csrfToken?: string;
    signal?: AbortSignal;
  } = {}
): Promise<T> {
  const headers = new Headers({ Accept: "application/json" });
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  if (options.csrfToken) headers.set("x-csrf-token", options.csrfToken);

  const init: RequestInit = {
    method: options.method ?? "GET",
    headers,
    credentials: "same-origin"
  };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);
  if (options.signal !== undefined) init.signal = options.signal;

  const response = await fetch(`${API_ROOT}${path}`, init);
  const payload = await parseResponse(response);
  if (!response.ok) {
    throw new ApiError(errorText(payload, `Request failed (${response.status})`), response.status);
  }
  return unwrap<T>(payload);
}

export async function getCsrfToken(signal?: AbortSignal): Promise<string> {
  const payload = await apiRequest<unknown>("/security/csrf", signal === undefined ? {} : { signal });
  if (isRecord(payload)) {
    const token = payload.token ?? payload.csrfToken;
    if (typeof token === "string" && token.length > 0) return token;
  }
  throw new ApiError("The local server did not provide a CSRF token.", 500);
}

export async function getSetupStatus(signal?: AbortSignal): Promise<SetupStatus> {
  const raw = await apiRequest<unknown>("/setup/status", signal === undefined ? {} : { signal });
  if (!isRecord(raw)) throw new ApiError("Invalid setup status response.", 500);
  const providers = Array.isArray(raw.providers) ? raw.providers : [];
  const credentialsConfigured = Boolean(
    raw.credentialsConfigured ?? raw.hasCredentials ?? raw.providersConfigured
  );
  const paperConfigured = Boolean(raw.paperConfigured ?? raw.paperInitialized ?? raw.hasPaperCapital);
  const configured = Boolean(raw.configured ?? raw.complete ?? (credentialsConfigured && paperConfigured));
  const capital = raw.paperCapitalUsd ?? raw.initialNavUsd ?? raw.paperCapital;
  const rawWallet = isRecord(raw.wallet) ? raw.wallet : {};
  const wallet: LiveWalletStatus = {
    exists: Boolean(rawWallet.exists),
    backupConfirmed: Boolean(rawWallet.backupConfirmed)
  };
  if (typeof rawWallet.address === "string") wallet.address = rawWallet.address;
  return {
    configured,
    credentialsConfigured,
    paperConfigured,
    providers: providers as SetupStatus["providers"],
    paperCapitalUsd: typeof capital === "number" ? capital : null,
    wallet
  };
}

export function getDashboard(signal?: AbortSignal): Promise<DashboardSnapshot> {
  return apiRequest<DashboardSnapshot>("/dashboard", signal === undefined ? {} : { signal });
}

export function getAlpacaPaperStatus(signal?: AbortSignal): Promise<AlpacaPaperStatus> {
  return apiRequest<AlpacaPaperStatus>(
    "/alpaca-paper/status",
    signal === undefined ? {} : { signal }
  );
}

export function saveAlpacaPaperCredentials(
  input: AlpacaPaperCredentialsInput,
  csrfToken: string
): Promise<AlpacaPaperStatus> {
  return apiRequest<AlpacaPaperStatus>("/alpaca-paper/credentials", {
    method: "POST",
    body: input,
    csrfToken
  });
}

export function getDataProviderStatus(signal?: AbortSignal): Promise<DataProviderStatus> {
  return apiRequest<DataProviderStatus>("/provider/profile", signal === undefined ? {} : { signal });
}

export function getSolPriceBootstrapStatus(signal?: AbortSignal): Promise<SolPriceBootstrapStatus> {
  return apiRequest<SolPriceBootstrapStatus>(
    "/provider/sol-price-bootstrap",
    signal === undefined ? {} : { signal }
  );
}

export function getProviderParityBaselineStatus(signal?: AbortSignal): Promise<ProviderParityBaselineStatus> {
  return apiRequest<ProviderParityBaselineStatus>(
    "/provider/parity-baseline",
    signal === undefined ? {} : { signal }
  );
}

export function getWalletResearch(
  options: {
    page?: number;
    pageSize?: number;
    filter?: WalletResearchFilter;
    sort?: WalletResearchSort;
    signal?: AbortSignal;
  } = {}
): Promise<WalletResearchPage> {
  const query = new URLSearchParams({
    page: String(options.page ?? 1),
    pageSize: String(options.pageSize ?? 25),
    filter: options.filter ?? "ALL",
    sort: options.sort ?? "CLOSED_SWAPS"
  });
  return apiRequest<WalletResearchPage>(
    `/wallets/research?${query.toString()}`,
    options.signal === undefined ? {} : { signal: options.signal }
  );
}

export async function saveCredentials(input: CredentialsInput, csrfToken: string): Promise<ProviderHealth[]> {
  const result = await apiRequest<unknown>("/setup/credentials", {
    method: "POST",
    body: input,
    csrfToken
  });
  if (Array.isArray(result)) return result as ProviderHealth[];
  if (isRecord(result) && Array.isArray(result.health)) return result.health as ProviderHealth[];
  return [];
}

export function initializePaper(initialNavUsd: number, csrfToken: string): Promise<void> {
  return apiRequest<void>("/setup/paper", {
    method: "POST",
    body: { initialNavUsd },
    csrfToken
  });
}

export function saveDataProviderProfile(
  input: DataProviderProfileRequest,
  csrfToken: string
): Promise<DataProviderStatus> {
  return apiRequest<DataProviderStatus>("/provider/profile", {
    method: "POST",
    body: input,
    csrfToken
  });
}

export function startSolPriceBootstrap(
  confirmation: "START PRICE BOOTSTRAP",
  csrfToken: string
): Promise<SolPriceBootstrapStatus> {
  return apiRequest<SolPriceBootstrapStatus>("/provider/sol-price-bootstrap/start", {
    method: "POST",
    body: { confirmation },
    csrfToken
  });
}

export function pauseSolPriceBootstrap(
  confirmation: "PAUSE PRICE BOOTSTRAP",
  csrfToken: string
): Promise<SolPriceBootstrapStatus> {
  return apiRequest<SolPriceBootstrapStatus>("/provider/sol-price-bootstrap/pause", {
    method: "POST",
    body: { confirmation },
    csrfToken
  });
}

export function savePythBenchmarksApiKey(
  pythBenchmarksApiKey: string,
  confirmation: "SAVE PYTH API KEY",
  csrfToken: string
): Promise<SolPriceBootstrapStatus> {
  return apiRequest<SolPriceBootstrapStatus>("/provider/sol-price-bootstrap/credentials", {
    method: "POST",
    body: { pythBenchmarksApiKey, confirmation },
    csrfToken
  });
}

export function captureProviderParityBaseline(
  confirmation: "CAPTURE FROZEN PARITY BASELINE",
  csrfToken: string
): Promise<ProviderParityBaselineStatus> {
  return apiRequest<ProviderParityBaselineStatus>("/provider/parity-baseline/capture", {
    method: "POST",
    body: { confirmation },
    csrfToken
  });
}

export function changeMode(mode: ModeState, confirmation: string, csrfToken: string): Promise<void> {
  return apiRequest<void>("/mode", { method: "POST", body: { mode, confirmation }, csrfToken });
}

export function pauseSystem(csrfToken: string): Promise<void> {
  return apiRequest<void>("/control/pause", { method: "POST", body: {}, csrfToken });
}

export function resumeSystem(csrfToken: string): Promise<void> {
  return apiRequest<void>("/control/resume", { method: "POST", body: {}, csrfToken });
}

export function recheckNewEntries(csrfToken: string): Promise<OperationalPauseState> {
  return apiRequest<OperationalPauseState>("/control/recheck-entries", {
    method: "POST",
    body: {},
    csrfToken
  });
}

export function setResearchPaperEnabled(enabled: boolean, csrfToken: string): Promise<void> {
  return apiRequest<void>("/research-paper", {
    method: "POST",
    body: { enabled },
    csrfToken
  });
}

export function setAutonomousPaperEnabled(enabled: boolean, csrfToken: string): Promise<void> {
  return apiRequest<void>("/autonomous-paper", {
    method: "POST",
    body: { enabled },
    csrfToken
  });
}

export function getAutonomousLearning(signal?: AbortSignal): Promise<AutonomousLearningOverview> {
  return apiRequest<AutonomousLearningOverview>(
    "/autonomous-learning",
    signal === undefined ? {} : { signal }
  );
}

export function trainAutonomousLearning(
  csrfToken: string
): Promise<AutonomousLearningOverview> {
  return apiRequest<AutonomousLearningOverview>("/autonomous-learning/train", {
    method: "POST",
    body: { confirmation: "TRAIN AUTONOMOUS LEARNER" },
    csrfToken
  });
}

export function promoteAutonomousChallenger(
  confirmation: string,
  csrfToken: string
): Promise<ChampionPromotionDecision> {
  return apiRequest<ChampionPromotionDecision>("/autonomous-learning/promote", {
    method: "POST",
    body: { confirmation },
    csrfToken
  });
}

export function emergencyExit(
  confirmation: string,
  csrfToken: string
): Promise<{ closed: number; failed: number; locked: boolean }> {
  return apiRequest<{ closed: number; failed: number; locked: boolean }>("/control/emergency-exit", {
    method: "POST",
    body: { confirmation },
    csrfToken
  });
}

export function decideApproval(
  id: string,
  decision: "approve" | "reject",
  csrfToken: string
): Promise<void> {
  return apiRequest<void>(`/approvals/${encodeURIComponent(id)}/${decision}`, {
    method: "POST",
    body: {},
    csrfToken
  });
}

export function createLiveWallet(backupPassphrase: string, csrfToken: string): Promise<WalletCreationResult> {
  return apiRequest<WalletCreationResult>("/wallet/create", {
    method: "POST",
    body: { backupPassphrase },
    csrfToken
  });
}

export function confirmWalletBackup(address: string, csrfToken: string): Promise<LiveWalletStatus> {
  return apiRequest<LiveWalletStatus>("/wallet/confirm-backup", {
    method: "POST",
    body: { address },
    csrfToken
  });
}

export function getPendingWalletRecovery(
  address: string,
  csrfToken: string
): Promise<WalletCreationResult> {
  return apiRequest<WalletCreationResult>("/wallet/pending-recovery", {
    method: "POST",
    body: { address },
    csrfToken
  });
}

export function restoreLiveWallet(
  recovery: Record<string, unknown>,
  backupPassphrase: string,
  confirmation: "RESTORE COPYLAB WALLET",
  csrfToken: string
): Promise<LiveWalletStatus> {
  return apiRequest<LiveWalletStatus>("/wallet/restore", {
    method: "POST",
    body: { recovery, backupPassphrase, confirmation },
    csrfToken
  });
}

export function subscribeToDashboard(
  onSnapshot: (snapshot: DashboardSnapshot) => void,
  onConnection: (connected: boolean) => void,
  onEvent: (eventType: string) => void
): () => void {
  const source = new EventSource(`${API_ROOT}/events`, { withCredentials: true });

  const consume = (event: MessageEvent<string>): void => {
    try {
      const payload = JSON.parse(event.data) as unknown;
      if (isRecord(payload) && "mode" in payload && "portfolio" in payload) {
        onSnapshot(payload as unknown as DashboardSnapshot);
        return;
      }
      const typed = payload as DashboardEvent;
      if (typed.type === "dashboard" && isRecord(typed.data) && "mode" in typed.data && "portfolio" in typed.data) {
        onSnapshot(typed.data as unknown as DashboardSnapshot);
        return;
      }
      if (event.type === "marketplace") {
        window.dispatchEvent(new Event("copylab:marketplace"));
      }
      onEvent(event.type);
    } catch {
      if (event.data.trim()) onEvent(event.type);
    }
  };

  source.onopen = () => onConnection(true);
  source.onerror = () => onConnection(false);
  source.onmessage = consume;
  source.addEventListener("dashboard", consume as EventListener);
  for (const eventName of [
    "setup",
    "mode",
    "wallet",
    "execution",
    "position",
    "portfolio",
    "provider-health",
    "data-provider",
    "provider-parity-baseline",
    "health",
    "promotion",
    "discovery",
    "wallet-index",
    "wallet-index-reprice",
    "wallet-index-deep-history",
    "wallet-research-qualified",
    "sol-price-bootstrap",
    "signal-outcome",
    "research-paper",
    "autonomous-paper",
    "autonomous-learning",
    "stock-paper",
    "marketplace",
    "alpaca-paper",
    "parsed-block-repair",
    "parsed-block-repair-finished",
    "runtime-error",
    "operational-pause",
    "emergency-exit"
  ]) {
    source.addEventListener(eventName, consume as EventListener);
  }

  return () => source.close();
}
