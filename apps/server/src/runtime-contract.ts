import type {
  AutonomousLearningOverview,
  ChampionPromotionDecision,
  ExecutionRecord,
  DataProviderProfile,
  ModeState,
  OperationalPauseState,
  OperationalTelemetrySnapshot,
  ProviderCredentials,
  ProviderHealth,
  StockPaperDashboard,
  WalletAcquisitionGoal
} from "@copylab/shared";
import type { SolPriceBootstrapStatus } from "./sol-price-bootstrap-state.js";
import type { ProviderParityBaselineRun } from "./provider-parity-proof.js";

export interface RuntimeController {
  start(): Promise<void>;
  stop(): Promise<void>;
  validateCredentials(credentials: ProviderCredentials): Promise<ProviderHealth[]>;
  validateDataProviderProfile(profile: DataProviderProfile): Promise<ProviderHealth>;
  /** Stops old provider-owned workers and fences any in-flight commit path before vault mutation. */
  quiesceProviderWork(): Promise<void>;
  /** Starts provider-owned work only after the selected vault state is fully configured. */
  resumeProviderWork(): Promise<void>;
  credentialsChanged(): Promise<void>;
  dataProviderProfileChanged(): Promise<void>;
  preflightModeChange(mode: ModeState): Promise<void>;
  modeChanged(mode: ModeState): Promise<void>;
  /** Refreshes the isolated, quote-only PAPER research lane after an operator toggle. */
  researchPaperConfigurationChanged?(): Promise<void>;
  /** Starts or pauses the isolated autonomous PAPER strategy. */
  autonomousPaperConfigurationChanged?(): Promise<void>;
  /** Starts the isolated read-only Alpaca/IEX stock PAPER strategy after credential setup. */
  alpacaPaperConfigurationChanged?(): Promise<void>;
  stockPaperDashboard?(): StockPaperDashboard;
  autonomousLearningOverview?(): AutonomousLearningOverview;
  trainAutonomousLearning?(): Promise<AutonomousLearningOverview>;
  promoteAutonomousChallenger?(confirmation: string): ChampionPromotionDecision;
  approveExecution(id: string): Promise<ExecutionRecord>;
  rejectExecution(id: string): Promise<ExecutionRecord>;
  solPriceBootstrapStatus(): SolPriceBootstrapStatus;
  startSolPriceBootstrap(): SolPriceBootstrapStatus;
  pauseSolPriceBootstrap(): Promise<SolPriceBootstrapStatus>;
  captureProviderParityBaseline(): Promise<ProviderParityBaselineRun>;
  operationalPauseState(): OperationalPauseState;
  operationalTelemetry(): OperationalTelemetrySnapshot;
  walletAcquisitionStatus?(): WalletAcquisitionGoal | undefined;
  recheckOperationalPause(): Promise<OperationalPauseState>;
  emergencyExit(): Promise<{ closed: number; failed: number; locked: boolean }>;
  refreshDiscovery(): Promise<void>;
}
