export type MarketplaceAssetClass = "CRYPTO" | "US_STOCKS" | "MULTI_ASSET";

export type MarketplacePilotCategory =
  | "WALLET_COPY"
  | "AUTONOMOUS_AI"
  | "STOCK_MOMENTUM"
  | "THEMATIC"
  | "HEDGE_FUND_13F"
  | "POLITICIAN_DISCLOSURE";

export type MarketplaceRisk = "CONSERVATIVE" | "MODERATE" | "HIGH" | "EXTREME";
export type MarketplacePilotStage = "ACTIVE" | "EVALUATING" | "RESEARCH_ONLY" | "PAUSED";
export type MarketplaceExecutionMode = "PAPER" | "MANUAL_LIVE" | "AUTO_LIVE";

export interface MarketplacePilotPerformance {
  periodLabel: string;
  netReturnPercent?: number;
  benchmarkReturnPercent?: number;
  netPnlUsd?: number;
  maximumDrawdownPercent?: number;
  completedTrades: number;
  winRatePercent?: number;
  profitFactor?: number;
  pricingComplete: boolean;
  observedFrom?: string;
  updatedAt?: string;
}

export interface MarketplacePerformanceHistoryPoint {
  capturedAt: string;
  netReturnPercent?: number;
  realizedPnlUsd?: number;
  maximumDrawdownPercent?: number;
  profitFactor?: number;
  winRatePercent?: number;
  completedTrades: number;
  openPositions: number;
  pricingComplete: boolean;
  evidenceStatus: "QUALIFIED" | "COLLECTING" | "DELAYED_SOURCE" | "INSUFFICIENT";
  disclosure: string;
}

export interface MarketplacePilotEvidence {
  status: "QUALIFIED" | "COLLECTING" | "DELAYED_SOURCE" | "INSUFFICIENT";
  label: string;
  sampleSize: number;
  minimumSampleSize?: number;
  profitableWeeks?: number;
  observedWeeks?: number;
  notes: string[];
}

export interface MarketplacePilot {
  id: string;
  name: string;
  summary: string;
  description: string;
  category: MarketplacePilotCategory;
  assetClass: MarketplaceAssetClass;
  risk: MarketplaceRisk;
  stage: MarketplacePilotStage;
  curator: {
    name: string;
    kind: "COPYLAB" | "WALLET_COHORT" | "PUBLIC_FILING" | "USER";
    detail?: string;
  };
  availability: {
    paper: boolean;
    manualLive: boolean;
    autoLive: boolean;
    liveRequirement?: string;
  };
  performance: MarketplacePilotPerformance;
  performanceHistory: MarketplacePerformanceHistoryPoint[];
  evidence: MarketplacePilotEvidence;
  allocation: {
    minimumUsd: number;
    recommendedUsd: number;
    maximumUsd: number;
    maximumNavPercent: number;
  };
  sourceTiming: string;
  methodology: string[];
  risks: string[];
  tags: string[];
}

export type MarketplaceEnrollmentStatus = "ACTIVE" | "PAUSED" | "REBALANCE_PENDING";

export interface MarketplaceEnrollment {
  id: string;
  pilotId: string;
  status: MarketplaceEnrollmentStatus;
  mode: MarketplaceExecutionMode;
  allocationUsd: number;
  allocationPercent?: number;
  allocationReferenceNavUsd?: number;
  currentValueUsd: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  mirroredOrders: number;
  openPositions: number;
  openedAt: string;
  updatedAt: string;
  lastMirroredAt?: string;
  pausedReason?: string;
}

export type MarketplaceEnrollmentAllocation =
  | { kind: "USD"; value: number }
  | { kind: "PERCENT"; value: number; referenceNavUsd: number };

export interface MarketplaceEnrollmentLedgerPosition {
  id: string;
  assetId: string;
  sourcePositionReference: string;
  status: "OPEN" | "CLOSED";
  quantity: number;
  entryPriceUsd: number;
  entryNotionalUsd: number;
  costBasisUsd: number;
  lastExecutableValueUsd: number;
  unrealizedPnlUsd: number;
  realizedPnlUsd?: number;
  openedAt: string;
  updatedAt: string;
  closedAt?: string;
}

export interface MarketplaceEnrollmentLedgerFill {
  id: string;
  action: "OPEN" | "REDUCE" | "CLOSE";
  assetId: string;
  sourcePositionReference: string;
  quantity: number;
  priceUsd: number;
  grossNotionalUsd: number;
  modeledCostsUsd: number;
  netCashChangeUsd: number;
  sourceReference: string;
  sourceOccurredAt: string;
  filledAt: string;
}

export interface MarketplaceEnrollmentLedgerEvent {
  id: string;
  kind:
    | "ENROLLED"
    | "PAUSED"
    | "RESUMED"
    | "ALLOCATION_UPDATED"
    | "REBALANCE_PREVIEWED"
    | "REBALANCE_APPLIED"
    | "PAPER_MIRROR_OPENED"
    | "PAPER_MIRROR_REDUCED"
    | "PAPER_MIRROR_CLOSED"
    | "PAPER_POSITION_MARKED"
    | "SWITCHED"
    | "UNENROLLED";
  occurredAt: string;
  details: Record<string, string | number | boolean>;
}

export interface MarketplaceEnrollmentLedger {
  enrollment: MarketplaceEnrollment;
  positions: MarketplaceEnrollmentLedgerPosition[];
  fills: MarketplaceEnrollmentLedgerFill[];
  events: MarketplaceEnrollmentLedgerEvent[];
}

export type MarketplaceBrokerStatus =
  | "PAPER_READY"
  | "PAPER_CONNECTED"
  | "CONNECTED"
  | "ACTION_REQUIRED"
  | "NOT_CONNECTED"
  | "LOCKED_NOT_IMPLEMENTED"
  | "OFFICIAL_ACCESS_REQUIRED"
  | "UNAVAILABLE_WITHOUT_WRITTEN_AUTHORIZATION"
  | "NOT_CONFIGURED_LIVE_LOCKED"
  | "UNAVAILABLE";

export interface MarketplaceBrokerConnection {
  id: string;
  name: string;
  status: MarketplaceBrokerStatus;
  official: boolean;
  paperSupported: boolean;
  liveSupported: boolean;
  accountLabel?: string;
  buyingPowerUsd?: number;
  detail: string;
  capabilities: string[];
  lastCheckedAt?: string;
}

export interface MarketplaceRebalancePreview {
  id: string;
  enrollmentId: string;
  currentAllocationUsd: number;
  targetAllocationUsd: number;
  cashChangeUsd: number;
  estimatedCostsUsd: number;
  projectedUncommittedCashUsd?: number;
  orders: Array<{
    symbol: string;
    side: "BUY" | "SELL";
    estimatedNotionalUsd: number;
  }>;
  warnings: string[];
  expiresAt: string;
}

export interface MarketplaceActions {
  enroll(
    pilotId: string,
    request: { allocation: MarketplaceEnrollmentAllocation; mode: "PAPER" }
  ): Promise<MarketplaceEnrollment>;
  pause(enrollmentId: string): Promise<MarketplaceEnrollment>;
  resume(enrollmentId: string): Promise<MarketplaceEnrollment>;
  unenroll(enrollmentId: string): Promise<void>;
  loadEnrollmentLedger(enrollmentId: string, signal?: AbortSignal): Promise<MarketplaceEnrollmentLedger>;
  switchPilot(enrollmentId: string, targetPilotId: string): Promise<MarketplaceEnrollment>;
  previewRebalance(
    enrollmentId: string,
    request: { targetAllocationUsd: number }
  ): Promise<MarketplaceRebalancePreview>;
  confirmRebalance(enrollmentId: string, previewId: string): Promise<MarketplaceEnrollment>;
  connectBroker?(brokerId: string): Promise<void>;
}

export interface MarketplacePanelProps {
  pilots: readonly MarketplacePilot[];
  enrollments: readonly MarketplaceEnrollment[];
  brokers: readonly MarketplaceBrokerConnection[];
  actions?: MarketplaceActions;
  loading?: boolean;
  error?: string;
  paperOnly?: boolean;
  initialView?: "DISCOVER" | "MY_PILOTS" | "BROKERS";
  onRetry?: () => void;
  onEnrollmentChange?: (enrollment: MarketplaceEnrollment) => void;
}
