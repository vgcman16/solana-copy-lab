import type {
  AutonomousPaperDashboard,
  DataProviderStatus,
  ExecutionRecord,
  LiveActivityEvent,
  LiveActivityKind,
  LiveActivityTone,
  LiveOperationPressure,
  LiveOperationSource,
  LiveOperationSourceId,
  LiveOperationsSnapshot,
  ModeState,
  OperationalPauseState,
  OperationalTelemetrySnapshot,
  PositionLot,
  ProviderHealth,
  ResearchPaperDashboard,
  SignalAuditRecord,
  StockPaperDashboard,
  WalletIndexDashboardSnapshot
} from "@copylab/shared";
import { redactSensitiveText } from "@copylab/providers";
import type { AppEvent } from "./events.js";

const ACTIVITY_LIMIT = 80;
const SAFE_TEXT_LIMIT = 240;

export interface LiveOperationsBuildInput {
  capturedAt: string;
  mode: ModeState;
  dataProvider: DataProviderStatus;
  operationalPause: OperationalPauseState;
  operationalTelemetry: OperationalTelemetrySnapshot;
  providerHealth: readonly ProviderHealth[];
  providerUsage: ReadonlyMap<string, { requests: number; credits: number }>;
  walletIndex: WalletIndexDashboardSnapshot;
  positions: readonly PositionLot[];
  recentExecutions: readonly ExecutionRecord[];
  recentSignals: readonly SignalAuditRecord[];
  researchPaper: ResearchPaperDashboard;
  autonomousPaper: AutonomousPaperDashboard;
  stockPaper?: StockPaperDashboard;
  runtimeEvents: readonly AppEvent[];
}

function safeText(value: unknown, fallback: string): string {
  if (typeof value !== "string" || value.trim().length === 0) return fallback;
  return redactSensitiveText(value.trim(), SAFE_TEXT_LIMIT);
}

function safeRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function safeScalar(
  record: Record<string, unknown>,
  key: string
): string | number | boolean | undefined {
  const value = record[key];
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? value
    : undefined;
}

function boundedPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function usagePressure(percent: number | undefined): LiveOperationPressure {
  if (percent === undefined || !Number.isFinite(percent)) return "UNKNOWN";
  if (percent >= 80) return "HIGH";
  if (percent >= 50) return "MEDIUM";
  return "LOW";
}

function usage(input: {
  requests: number;
  credits?: number;
  limit?: number;
  unit?: "requests" | "CU" | "credits";
}): LiveOperationSource["usage"] {
  const used = input.credits ?? input.requests;
  const percent = input.limit && input.limit > 0
    ? boundedPercent(used / input.limit * 100)
    : undefined;
  return {
    requests: input.requests,
    ...(input.credits !== undefined ? { credits: input.credits } : {}),
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
    ...(input.unit !== undefined ? { unit: input.unit } : {}),
    window: "month",
    ...(percent !== undefined ? { percent } : {}),
    pressure: usagePressure(percent)
  };
}

function physicalSource(
  health: ProviderHealth
): LiveOperationSourceId {
  const physical = health.usage?.provider;
  if (physical === "solana_rpc") return "solana_rpc";
  if (physical === "pyth_benchmarks") return "pyth_benchmarks";
  if (health.provider === "pyth") return "pyth_benchmarks";
  return health.provider;
}

function sourceLabel(id: LiveOperationSourceId): string {
  switch (id) {
    case "birdeye": return "Birdeye";
    case "helius": return "Helius";
    case "solana_rpc": return "Self-hosted Solana RPC";
    case "jupiter": return "Jupiter";
    case "pyth_benchmarks": return "Pyth Benchmarks";
    case "alpaca_iex": return "Alpaca IEX";
    case "local_index": return "Local Index";
  }
}

function providerSource(health: ProviderHealth): LiveOperationSource {
  const id = physicalSource(health);
  const requests = health.usage?.requests ?? 0;
  const credits = health.usage?.credits;
  const limit = health.usage?.creditLimit ?? health.usage?.limit;
  return {
    id,
    label: sourceLabel(id),
    scope: "CRYPTO",
    status: health.ok ? "ONLINE" : "DEGRADED",
    checkedAt: health.checkedAt,
    ...(health.latencyMs !== undefined ? { latencyMs: health.latencyMs } : {}),
    message: safeText(health.message, `${sourceLabel(id)} status is unavailable.`),
    usage: usage({
      requests,
      ...(credits !== undefined ? { credits } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(health.usage?.creditUnit ? { unit: health.usage.creditUnit } : {})
    }),
    lastEventAt: health.checkedAt,
    lastEvent: health.ok ? "Health check passed." : "Health check needs attention.",
    metrics: {
      authenticated: health.ok,
      logicalProvider: health.provider
    }
  };
}

function stockSource(
  stock: StockPaperDashboard | undefined,
  providerUsage: ReadonlyMap<string, { requests: number; credits: number }>
): LiveOperationSource {
  const market = stock?.market;
  const usageRow = providerUsage.get("alpaca_iex");
  const configured = Boolean(stock?.lane);
  const status = !configured
    ? "UNCONFIGURED"
    : market?.lastError
      ? "DEGRADED"
      : market?.lastScanAt
        ? "ONLINE"
        : "IDLE";
  return {
    id: "alpaca_iex",
    label: sourceLabel("alpaca_iex"),
    scope: "STOCK",
    status,
    ...(market?.lastScanAt ? { checkedAt: market.lastScanAt } : {}),
    message: market?.lastError
      ? safeText(market.lastError, "The latest IEX scan failed safely.")
      : configured
        ? "Real free Alpaca IEX and overnight prices feed an isolated local PAPER ledger."
        : "Alpaca Paper has not been connected.",
    usage: usage({
      requests: usageRow?.requests ?? 0,
      ...(usageRow && usageRow.credits > 0 ? { credits: usageRow.credits } : {}),
      unit: "requests"
    }),
    ...(market?.lastScanAt ? { lastEventAt: market.lastScanAt } : {}),
    lastEvent: market?.lastScanAt
      ? `${market.feed} scan completed: ${market.scannedSymbols} symbols, ${market.detailedSymbols} detailed.`
      : "Waiting for the first Alpaca market scan.",
    metrics: {
      paperOnly: true,
      liveOrdersEnabled: false,
      feed: market?.feed ?? "IEX",
      marketPhase: market?.phase ?? "UNKNOWN",
      scannedSymbols: market?.scannedSymbols ?? 0,
      detailedSymbols: market?.detailedSymbols ?? 0,
      openPositions: stock?.positions.length ?? 0,
      completedTrades: stock?.account?.completedTrades ?? 0,
      ...(market?.scanDurationMs !== undefined ? { scanDurationMs: market.scanDurationMs } : {})
    }
  };
}

function localIndexSource(
  input: Pick<
    LiveOperationsBuildInput,
    "walletIndex" | "operationalTelemetry" | "providerUsage"
  >
): LiveOperationSource {
  const usageRow = input.providerUsage.get("helius_index");
  const coverage = input.walletIndex.coverage;
  const latestRun = input.walletIndex.latestRun;
  const status = input.operationalTelemetry.status === "HEALTHY"
    ? "ONLINE"
    : input.operationalTelemetry.status === "UNAVAILABLE"
      ? "OFFLINE"
      : "DEGRADED";
  return {
    id: "local_index",
    label: sourceLabel("local_index"),
    scope: "LOCAL",
    status,
    checkedAt: input.operationalTelemetry.capturedAt,
    message: input.operationalTelemetry.issues[0]?.message ??
      "SQLite indexing, repair, scoring, and audit ledgers are operating locally.",
    usage: usage({
      requests: usageRow?.requests ?? 0,
      credits: usageRow?.credits ?? 0,
      limit: input.walletIndex.indexCreditBudget,
      unit: "credits"
    }),
    lastEventAt: latestRun?.updatedAt ?? coverage.capturedAt,
    lastEvent: latestRun
      ? `Wallet index ${latestRun.stage.toLowerCase()} stage updated.`
      : "Wallet index coverage updated.",
    metrics: {
      indexedWallets: coverage.indexedWallets,
      indexedSwaps: coverage.indexedSwaps,
      activityProven: input.walletIndex.researchFunnel.localIndex
        .find((stage) => stage.key === "ACTIVITY_PROVEN")?.count ?? 0,
      researchQualified: input.walletIndex.researchFunnel.providerCohort
        .find((stage) => stage.key === "RESEARCH_QUALIFIED")?.count ?? 0,
      pendingQueue: coverage.queueByStatus.PENDING,
      retryQueue: coverage.queueByStatus.RETRY,
      failedQueue: coverage.queueByStatus.FAILED
    }
  };
}

function eventTone(type: string, data: Record<string, unknown>): LiveActivityTone {
  if (type === "runtime-error" || type === "emergency-exit") return "CRITICAL";
  if (
    type === "operational-pause" ||
    safeScalar(data, "outcome") === "REJECTED" ||
    safeScalar(data, "status") === "FAILED"
  ) return "WARNING";
  if (
    type === "execution" ||
    safeScalar(data, "outcome") === "SIMULATED" ||
    safeScalar(data, "outcome") === "CYCLE_COMPLETED"
  ) return "SUCCESS";
  return "INFO";
}

function eventKind(type: string): LiveActivityKind {
  if (type === "health" || type === "provider-health" || type === "alpaca-paper") return "API";
  if (type.includes("learning")) return "LEARNING";
  if (type.includes("signal")) return "SIGNAL";
  if (type.includes("position") || type === "portfolio") return "POSITION";
  if (type.includes("pause") || type === "emergency-exit" || type === "runtime-error") return "SAFETY";
  if (
    type.includes("stock-paper") ||
    type.includes("wallet-index") ||
    type.includes("repair") ||
    type === "discovery"
  ) return "SCAN";
  if (type.includes("paper") || type === "execution") return "SIMULATION";
  return "SYSTEM";
}

function runtimeSource(type: string): LiveOperationSourceId {
  if (type === "stock-paper" || type === "alpaca-paper") return "alpaca_iex";
  if (type === "health" || type === "provider-health") return "helius";
  if (type === "data-provider") return "solana_rpc";
  return "local_index";
}

function runtimeSummary(type: string, data: Record<string, unknown>): string {
  switch (type) {
    case "stock-paper": {
      const scanned = safeScalar(data, "scannedSymbols");
      const detailed = safeScalar(data, "detailedSymbols");
      if (typeof scanned === "number") {
        return `IEX scan complete · ${scanned} symbols${typeof detailed === "number" ? ` · ${detailed} ranked` : ""}`;
      }
      return "Stock PAPER engine updated.";
    }
    case "autonomous-paper":
      return `Autonomous crypto · ${safeText(safeScalar(data, "outcome"), "cycle updated")}`;
    case "autonomous-learning":
      return `Learning engine · ${safeText(safeScalar(data, "outcome"), "evidence updated")}`;
    case "research-paper":
      return `High-risk wallet copy · ${safeText(safeScalar(data, "outcome"), "ledger updated")}`;
    case "signal-outcome":
      return `Copy signal · ${safeText(safeScalar(data, "status"), "decision updated")}`;
    case "health":
    case "provider-health":
      return "Provider health evidence refreshed.";
    case "wallet-index":
      return "Local wallet index progressed.";
    case "wallet-index-deep-history":
      return "Wallet deep-history scoring progressed.";
    case "wallet-research-qualified":
      return "A wallet passed the research qualification gate.";
    case "runtime-error":
      return `Runtime warning · ${safeText(safeScalar(data, "event"), "operation failed safely")}`;
    case "operational-pause":
      return "Operational entry-safety state changed.";
    case "emergency-exit":
      return "Emergency-exit state changed.";
    default:
      return `${type.replaceAll("-", " ")} updated.`;
  }
}

function runtimeActivity(event: AppEvent): LiveActivityEvent {
  const data = safeRecord(event.data);
  const metrics: Record<string, string | number | boolean> = {};
  for (const key of [
    "outcome",
    "status",
    "entries",
    "trades",
    "openPositions",
    "scannedSymbols",
    "detailedSymbols",
    "providerRequests",
    "scanDurationMs"
  ]) {
    const value = safeScalar(data, key);
    if (value !== undefined) metrics[key] = value;
  }
  return {
    id: `runtime:${event.at}:${event.type}`,
    at: event.at,
    source: runtimeSource(event.type),
    kind: eventKind(event.type),
    tone: eventTone(event.type, data),
    summary: runtimeSummary(event.type, data),
    ...(Object.keys(metrics).length > 0 ? { metrics } : {})
  };
}

function providerActivity(health: ProviderHealth): LiveActivityEvent {
  const source = physicalSource(health);
  return {
    id: `provider:${source}:${health.checkedAt}`,
    at: health.checkedAt,
    source,
    kind: "API",
    tone: health.ok ? "SUCCESS" : "WARNING",
    summary: `${sourceLabel(source)} health ${health.ok ? "passed" : "needs attention"}.`,
    ...(health.latencyMs !== undefined ? { metrics: { latencyMs: health.latencyMs } } : {})
  };
}

function stockActivities(stock: StockPaperDashboard | undefined): LiveActivityEvent[] {
  if (!stock) return [];
  const events: LiveActivityEvent[] = [];
  if (stock.market.lastScanAt) {
    events.push({
      id: `stock-scan:${stock.market.lastScanAt}`,
      at: stock.market.lastScanAt,
      source: "alpaca_iex",
      kind: "SCAN",
      tone: stock.market.lastError ? "WARNING" : "SUCCESS",
      summary: stock.market.lastError
        ? "The latest IEX cycle failed safely."
        : `IEX scan complete · ${stock.market.scannedSymbols} symbols · ${stock.market.detailedSymbols} ranked`,
      metrics: {
        providerRequests: stock.market.providerRequests,
        marketPhase: stock.market.phase,
        ...(stock.market.scanDurationMs !== undefined
          ? { scanDurationMs: stock.market.scanDurationMs }
          : {})
      }
    });
  }
  for (const signal of stock.recentSignals.slice(0, 30)) {
    events.push({
      id: `stock-signal:${signal.id}`,
      at: signal.observedAt,
      source: "alpaca_iex",
      kind: signal.outcome === "SIMULATED" ? "SIMULATION" : "SIGNAL",
      tone: signal.outcome === "SIMULATED"
        ? "SUCCESS"
        : signal.outcome === "FAILED"
          ? "CRITICAL"
          : signal.outcome === "REJECTED"
            ? "WARNING"
            : "INFO",
      summary: `${signal.symbol} · ${signal.action.toLowerCase()} · ${signal.outcome.toLowerCase()}`,
      detail: safeText(signal.reasons[0], "Policy evidence recorded."),
      metrics: {
        score: signal.score,
        ...(signal.notionalUsd !== undefined ? { simulatedNotionalUsd: signal.notionalUsd } : {})
      }
    });
  }
  return events;
}

function cryptoActivities(input: LiveOperationsBuildInput): LiveActivityEvent[] {
  const events: LiveActivityEvent[] = [];
  for (const signal of input.recentSignals.slice(0, 30)) {
    events.push({
      id: `copy-signal:${signal.id}`,
      at: signal.updatedAt,
      source: "local_index",
      kind: signal.status === "SIMULATED" ? "SIMULATION" : "SIGNAL",
      tone: ["REJECTED", "BLOCKED", "FAILED"].includes(signal.status)
        ? "WARNING"
        : ["SIMULATED", "CONFIRMED"].includes(signal.status)
          ? "SUCCESS"
          : "INFO",
      summary: `Strict copy · ${signal.action.toLowerCase()} · ${signal.status.toLowerCase()}`,
      detail: safeText(signal.reason, signal.reasonCode),
      metrics: {
        reasonCode: signal.reasonCode,
        ...(signal.positionValueUsd !== undefined
          ? { positionValueUsd: signal.positionValueUsd }
          : {})
      }
    });
  }
  for (const event of input.researchPaper.recentSignals.slice(0, 20)) {
    events.push({
      id: `research:${event.eventKey}`,
      at: event.finalizedAt ?? event.observedAt,
      source: "local_index",
      kind: event.kind === "TRADE" ? "SIMULATION" : "SIGNAL",
      tone: event.outcome === "SIMULATED"
        ? "SUCCESS"
        : event.outcome === "FAILED"
          ? "CRITICAL"
          : event.outcome === "REJECTED"
            ? "WARNING"
            : "INFO",
      summary: `High-risk copy · ${(event.action ?? event.kind).toLowerCase()} · ${event.outcome.toLowerCase()}`,
      ...(event.reason ? { detail: safeText(event.reason, "Policy evidence recorded.") } : {})
    });
  }
  for (const decision of input.autonomousPaper.recentDecisions.slice(0, 20)) {
    events.push({
      id: `autonomous:${decision.id}`,
      at: decision.decidedAt,
      source: "local_index",
      kind: decision.outcome === "SIMULATED" ? "SIMULATION" : "SIGNAL",
      tone: decision.outcome === "SIMULATED"
        ? "SUCCESS"
        : decision.outcome === "FAILED"
          ? "CRITICAL"
          : decision.outcome === "REJECTED"
            ? "WARNING"
            : "INFO",
      summary: `Autonomous crypto · ${decision.action.toLowerCase()} · ${decision.outcome.toLowerCase()}`,
      detail: safeText(decision.reasons[0], "Strategy evidence recorded."),
      metrics: {
        score: decision.score,
        ...(decision.modeledPositionUsd !== undefined
          ? { simulatedNotionalUsd: decision.modeledPositionUsd }
          : {})
      }
    });
  }
  return events;
}

function safetyActivities(input: LiveOperationsBuildInput): LiveActivityEvent[] {
  const events: LiveActivityEvent[] = [];
  if (input.operationalPause.active) {
    events.push({
      id: `pause:${input.operationalPause.lastEvaluatedAt}`,
      at: input.operationalPause.lastEvaluatedAt,
      source: "local_index",
      kind: "SAFETY",
      tone: "WARNING",
      summary: "New entries are paused by operational safety.",
      detail: input.operationalPause.reasons.join(", "),
      metrics: { recovery: input.operationalPause.recovery }
    });
  }
  for (const issue of input.operationalTelemetry.issues.slice(0, 10)) {
    events.push({
      id: `telemetry:${input.operationalTelemetry.capturedAt}:${issue.code}`,
      at: input.operationalTelemetry.capturedAt,
      source: "local_index",
      kind: "SAFETY",
      tone: issue.severity === "CRITICAL" ? "CRITICAL" : "WARNING",
      summary: issue.message,
      metrics: { code: issue.code }
    });
  }
  return events;
}

function acceptedSignalCount(input: LiveOperationsBuildInput): number {
  const strict = input.recentSignals.filter((signal) =>
    ["QUEUED", "AWAITING_APPROVAL", "APPROVED", "SUBMITTED", "SUBMITTED_UNRESOLVED", "SIMULATED", "CONFIRMED"]
      .includes(signal.status)
  ).length;
  const research = input.researchPaper.recentSignals.filter((event) =>
    event.kind === "SIGNAL" && event.outcome === "SIMULATED"
  ).length;
  const autonomous = input.autonomousPaper.recentDecisions.filter((decision) =>
    decision.outcome === "SIMULATED"
  ).length;
  const stock = input.stockPaper?.recentSignals.filter((signal) =>
    signal.outcome === "SIMULATED"
  ).length ?? 0;
  return strict + research + autonomous + stock;
}

function rejectedSignalCount(input: LiveOperationsBuildInput): number {
  const strict = input.recentSignals.filter((signal) =>
    ["BLOCKED", "REJECTED", "FAILED"].includes(signal.status)
  ).length;
  const research = input.researchPaper.recentSignals.filter((event) =>
    event.kind === "SIGNAL" && ["REJECTED", "FAILED"].includes(event.outcome)
  ).length;
  const autonomous = input.autonomousPaper.recentDecisions.filter((decision) =>
    ["REJECTED", "FAILED"].includes(decision.outcome)
  ).length;
  const stock = input.stockPaper?.recentSignals.filter((signal) =>
    ["REJECTED", "FAILED"].includes(signal.outcome)
  ).length ?? 0;
  return strict + research + autonomous + stock;
}

function simulatedActionCount(input: LiveOperationsBuildInput): number {
  return input.recentSignals.filter((signal) => signal.status === "SIMULATED").length +
    input.researchPaper.recentSignals.filter((event) => event.outcome === "SIMULATED").length +
    input.autonomousPaper.recentDecisions.filter((decision) => decision.outcome === "SIMULATED").length +
    (input.stockPaper?.recentSignals.filter((signal) => signal.outcome === "SIMULATED").length ?? 0);
}

function deduplicatedSources(sources: readonly LiveOperationSource[]): LiveOperationSource[] {
  const byId = new Map<LiveOperationSourceId, LiveOperationSource>();
  for (const source of sources) {
    const prior = byId.get(source.id);
    if (!prior || Date.parse(source.checkedAt ?? "") > Date.parse(prior.checkedAt ?? "")) {
      byId.set(source.id, source);
    }
  }
  return [...byId.values()];
}

export function buildLiveOperationsSnapshot(
  input: LiveOperationsBuildInput
): LiveOperationsSnapshot {
  const sources = deduplicatedSources([
    ...input.providerHealth.map(providerSource),
    stockSource(input.stockPaper, input.providerUsage),
    localIndexSource(input)
  ]);
  const activities = [
    ...input.runtimeEvents.map(runtimeActivity),
    ...input.providerHealth.map(providerActivity),
    ...stockActivities(input.stockPaper),
    ...cryptoActivities(input),
    ...safetyActivities(input)
  ]
    .filter((event) => Number.isFinite(Date.parse(event.at)))
    .sort((left, right) => Date.parse(right.at) - Date.parse(left.at))
    .filter((event, index, all) => all.findIndex((candidate) => candidate.id === event.id) === index)
    .slice(0, ACTIVITY_LIMIT);
  const liveOrderCapabilityEnabled = input.mode === "MANUAL_LIVE" || input.mode === "AUTO_LIVE";
  return {
    capturedAt: input.capturedAt,
    paperOnly: input.mode === "PAPER",
    liveOrderCapabilityEnabled,
    stream: {
      transport: "SSE",
      refreshOnEvent: true,
      credentialFieldsExposed: false,
      rawProviderPayloadsExposed: false
    },
    sources,
    activity: activities,
    totals: {
      recentAcceptedSignals: acceptedSignalCount(input),
      recentRejectedSignals: rejectedSignalCount(input),
      recentSimulatedActions: simulatedActionCount(input),
      openPositions:
        input.positions.length +
        input.researchPaper.positions.length +
        input.autonomousPaper.positions.length +
        (input.stockPaper?.positions.length ?? 0)
    }
  };
}
