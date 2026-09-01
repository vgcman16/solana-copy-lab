import type {
  ExecutionRecord,
  DataProviderProfile,
  ModeState,
  OperationalPauseState,
  OperationalTelemetrySnapshot,
  ProviderCredentials,
  ProviderHealth
} from "@copylab/shared";
import { PYTH_SOL_USD_FEED_ID } from "@copylab/providers";
import type { RuntimeController } from "../src/runtime-contract.js";
import type { ProviderParityBaselineRun } from "../src/provider-parity-proof.js";
import {
  SOL_PRICE_BOOTSTRAP_HORIZON_DAYS,
  SOL_PRICE_BOOTSTRAP_INTERVAL_SECONDS,
  SOL_PRICE_BOOTSTRAP_TOTAL_POINTS,
  type SolPriceBootstrapStatus
} from "../src/sol-price-bootstrap-state.js";

function idleSolPriceBootstrap(): SolPriceBootstrapStatus {
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

export class MockRuntime implements RuntimeController {
  started = false;
  lastMode?: ModeState;
  providerWorkQuiesced = false;
  providerQuiesceCalls = 0;
  providerResumeCalls = 0;

  async start(): Promise<void> {
    this.started = true;
  }

  async stop(): Promise<void> {
    this.started = false;
  }

  async validateCredentials(_credentials: ProviderCredentials): Promise<ProviderHealth[]> {
    return (["birdeye", "helius", "jupiter"] as const).map((provider) => ({
      provider,
      ok: true,
      checkedAt: new Date().toISOString(),
      latencyMs: 1,
      message: "validated"
    }));
  }

  async validateDataProviderProfile(_profile: DataProviderProfile): Promise<ProviderHealth> {
    return {
      provider: "helius",
      ok: true,
      checkedAt: new Date().toISOString(),
      latencyMs: 1,
      message: "validated"
    };
  }

  async quiesceProviderWork(): Promise<void> {
    this.providerQuiesceCalls += 1;
    this.providerWorkQuiesced = true;
  }

  async resumeProviderWork(): Promise<void> {
    this.providerResumeCalls += 1;
    this.providerWorkQuiesced = false;
  }

  async credentialsChanged(): Promise<void> {}

  async dataProviderProfileChanged(): Promise<void> {}

  async preflightModeChange(_mode: ModeState): Promise<void> {}

  async modeChanged(mode: ModeState): Promise<void> {
    this.lastMode = mode;
  }

  async approveExecution(_id: string): Promise<ExecutionRecord> {
    throw new Error("not used in this test");
  }

  async rejectExecution(_id: string): Promise<ExecutionRecord> {
    throw new Error("not used in this test");
  }

  solPriceBootstrapStatus(): SolPriceBootstrapStatus {
    return idleSolPriceBootstrap();
  }

  startSolPriceBootstrap(): SolPriceBootstrapStatus {
    return idleSolPriceBootstrap();
  }

  async pauseSolPriceBootstrap(): Promise<SolPriceBootstrapStatus> {
    return idleSolPriceBootstrap();
  }

  async captureProviderParityBaseline(): Promise<ProviderParityBaselineRun> {
    const at = new Date().toISOString();
    return {
      id: "mock-provider-parity-baseline",
      status: "BLOCKED",
      requestedAt: at,
      updatedAt: at,
      blockers: [{ code: "MANAGED_PNL_AS_OF_UNSUPPORTED", message: "mock blocked" }],
      acquisitions: []
    };
  }

  operationalPauseState(): OperationalPauseState {
    return {
      active: false,
      reasons: [],
      recovery: "NONE",
      lastEvaluatedAt: new Date().toISOString()
    };
  }

  operationalTelemetry(): OperationalTelemetrySnapshot {
    const capturedAt = new Date().toISOString();
    return {
      status: "HEALTHY",
      capturedAt,
      issues: [],
      blocksNewEntries: false,
      blockingIssueCodes: []
    };
  }

  async recheckOperationalPause(): Promise<OperationalPauseState> {
    return this.operationalPauseState();
  }

  async emergencyExit(): Promise<{ closed: number; failed: number; locked: boolean }> {
    return { closed: 0, failed: 0, locked: true };
  }

  async refreshDiscovery(): Promise<void> {}
}
