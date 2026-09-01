import type { IsoDateTime } from "./index.js";

export type MarketplacePilotId = string;

export type MarketplacePilotKind =
  | "WALLET_COPY"
  | "AUTONOMOUS"
  | "THEMATIC"
  | "REGULATORY_TRACKER";

export type MarketplaceAssetClass = "CRYPTO" | "US_EQUITIES";
export type MarketplaceRiskLevel = "MODERATE" | "HIGH" | "VERY_HIGH";
export type MarketplaceDataCadence =
  | "REAL_TIME"
  | "NEAR_REAL_TIME"
  | "DAILY"
  | "REGULATORY_DELAYED";

export type MarketplaceLiveCapability =
  | "DISABLED"
  | "OFFICIAL_CONNECTOR_REQUIRED"
  | "NOT_SUPPORTED";

export type MarketplaceEvidenceStatus =
  | "FORWARD_TESTING"
  | "LIMITED"
  | "SUFFICIENT"
  | "DELAYED_SOURCE";

export interface MarketplacePilotEvidence {
  status: MarketplaceEvidenceStatus;
  completedTrades: number;
  observationDays: number;
  source: string;
  methodology: string;
  limitations: string[];
  updatedAt: IsoDateTime;
}

export interface MarketplacePilotPerformance {
  capturedAt: IsoDateTime;
  netReturnPercent?: number;
  realizedPnlUsd?: number;
  maxDrawdownPercent?: number;
  profitFactor?: number;
  winRatePercent?: number;
  completedTrades: number;
  openPositions: number;
  executablePricingComplete: boolean;
  evidenceStatus: MarketplaceEvidenceStatus;
  disclosure: string;
}

export interface MarketplacePilot {
  id: MarketplacePilotId;
  slug: string;
  version: number;
  name: string;
  shortDescription: string;
  longDescription: string;
  kind: MarketplacePilotKind;
  assetClass: MarketplaceAssetClass;
  riskLevel: MarketplaceRiskLevel;
  dataCadence: MarketplaceDataCadence;
  tags: string[];
  /** True only when the pilot has an implemented, enrollable internal PAPER engine. */
  paperAvailable: boolean;
  executionModel: "INTERNAL_PAPER";
  liveCapability: MarketplaceLiveCapability;
  automaticMirroring: boolean;
  mirroringDestination: "ISOLATED_VIRTUAL_ACCOUNT";
  minimumPaperAllocationUsd: number;
  status: "ACTIVE" | "RESEARCH_ONLY" | "ARCHIVED";
  evidence: MarketplacePilotEvidence;
  latestPerformance?: MarketplacePilotPerformance;
  disclosures: string[];
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export type MarketplaceBrokerId =
  | "COPYLAB_PAPER"
  | "ALPACA_PAPER"
  | "SCHWAB_TRADER_API"
  | "ROBINHOOD_EQUITIES"
  | "ROBINHOOD_CRYPTO";

export type MarketplaceBrokerConnectionStatus =
  | "CONNECTED"
  | "CONNECTED_LOCAL_SIMULATION"
  | "NOT_CONFIGURED"
  | "NOT_CONFIGURED_LIVE_LOCKED"
  | "OFFICIAL_AGENT_CONNECTION_AVAILABLE"
  | "OFFICIAL_ACCESS_REQUIRED"
  | "UNAVAILABLE_WITHOUT_WRITTEN_AUTHORIZATION"
  | "NOT_SUPPORTED";

export interface MarketplaceBrokerCapability {
  id: MarketplaceBrokerId;
  name: string;
  officialApiOnly: true;
  supportedAssetClasses: MarketplaceAssetClass[];
  paperExecutionSupported: boolean;
  liveExecutionSupported: false;
  automaticOrderSubmissionEnabled: false;
  authentication: "NONE" | "API_KEYS" | "OAUTH" | "UNAVAILABLE";
  connectionStatus: MarketplaceBrokerConnectionStatus;
  message: string;
}

export type MarketplaceAllocation =
  | { kind: "USD"; value: number }
  | { kind: "PERCENT"; value: number; referenceNavUsd: number };

export interface MarketplacePaperAccount {
  fundedCapitalUsd: number;
  navUsd: number;
  cashUsd: number;
  deployedUsd: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  openPositions: number;
  updatedAt: IsoDateTime;
}

export type MarketplaceEnrollmentStatus = "ACTIVE" | "PAUSED" | "UNENROLLED";

export interface MarketplaceEnrollment {
  id: string;
  pilotId: MarketplacePilotId;
  mode: "PAPER";
  executionModel: "INTERNAL_PAPER";
  status: MarketplaceEnrollmentStatus;
  allocation: MarketplaceAllocation;
  targetAllocationUsd: number;
  account: MarketplacePaperAccount;
  automaticMirroring: boolean;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  pausedAt?: IsoDateTime;
  unenrolledAt?: IsoDateTime;
}

export type MarketplaceEnrollmentEventKind =
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

export interface MarketplaceEnrollmentEvent {
  id: string;
  idempotencyKey: string;
  enrollmentId: string;
  pilotId: MarketplacePilotId;
  kind: MarketplaceEnrollmentEventKind;
  mode: "PAPER";
  occurredAt: IsoDateTime;
  details: Record<string, string | number | boolean>;
}

export interface MarketplaceRebalancePreview {
  id: string;
  enrollmentId: string;
  pilotId: MarketplacePilotId;
  mode: "PAPER";
  status: "PREVIEWED" | "APPLIED" | "EXPIRED";
  currentFundedCapitalUsd: number;
  targetFundedCapitalUsd: number;
  cashDeltaUsd: number;
  deployedUsd: number;
  canApply: boolean;
  blockers: string[];
  createdAt: IsoDateTime;
  expiresAt: IsoDateTime;
  appliedAt?: IsoDateTime;
}

export interface MarketplaceCatalog {
  paperOnly: true;
  executionModel: "INTERNAL_PAPER";
  liveOrderCapabilityEnabled: false;
  pilots: MarketplacePilot[];
  brokers: MarketplaceBrokerCapability[];
  disclosures: string[];
  updatedAt: IsoDateTime;
}

export interface CreateMarketplaceEnrollmentInput {
  pilotId: MarketplacePilotId;
  allocation: MarketplaceAllocation;
  mode?: "PAPER";
  idempotencyKey: string;
  requestedAt?: IsoDateTime;
}

export interface UpdateMarketplaceAllocationInput {
  enrollmentId: string;
  allocation: MarketplaceAllocation;
  idempotencyKey: string;
  requestedAt?: IsoDateTime;
}

export interface MarketplaceEnrollmentTransitionInput {
  enrollmentId: string;
  idempotencyKey: string;
  requestedAt?: IsoDateTime;
}

export interface ApplyMarketplaceRebalanceInput {
  previewId: string;
  idempotencyKey: string;
  requestedAt?: IsoDateTime;
}

export interface MarketplacePaperPosition {
  id: string;
  enrollmentId: string;
  pilotId: MarketplacePilotId;
  assetId: string;
  /** Stable source-side lot/position identity across OPEN, MARK, REDUCE, and CLOSE. */
  sourcePositionReference: string;
  status: "OPEN" | "CLOSED";
  quantity: number;
  entryPriceUsd: number;
  entryNotionalUsd: number;
  entryCostsUsd: number;
  costBasisUsd: number;
  lastExecutableValueUsd: number;
  unrealizedPnlUsd: number;
  openedAt: IsoDateTime;
  updatedAt: IsoDateTime;
  closedAt?: IsoDateTime;
  realizedPnlUsd?: number;
}

export interface MarketplacePaperMirrorFill {
  id: string;
  idempotencyKey: string;
  enrollmentId: string;
  pilotId: MarketplacePilotId;
  positionId: string;
  action: "OPEN" | "REDUCE" | "CLOSE";
  assetId: string;
  sourcePositionReference: string;
  quantity: number;
  priceUsd: number;
  grossNotionalUsd: number;
  modeledCostsUsd: number;
  netCashChangeUsd: number;
  sourceReference: string;
  sourceOccurredAt: IsoDateTime;
  mode: "PAPER";
  executionModel: "INTERNAL_PAPER";
  filledAt: IsoDateTime;
}

export type ApplyMarketplacePaperFillInput =
  | {
      action: "OPEN";
      enrollmentId: string;
      assetId: string;
      quantity: number;
      priceUsd: number;
      modeledCostsUsd: number;
      sourceReference: string;
      sourcePositionReference?: string;
      sourceOccurredAt?: IsoDateTime;
      idempotencyKey: string;
      filledAt?: IsoDateTime;
      mode?: "PAPER";
    }
  | {
      action: "REDUCE" | "CLOSE";
      enrollmentId: string;
      /** Either local positionId or sourcePositionReference must resolve the open lot. */
      positionId?: string;
      sourcePositionReference?: string;
      assetId: string;
      quantity: number;
      priceUsd: number;
      modeledCostsUsd: number;
      sourceReference: string;
      sourceOccurredAt?: IsoDateTime;
      idempotencyKey: string;
      filledAt?: IsoDateTime;
      mode?: "PAPER";
    };

export interface MarketplacePaperPositionMark {
  id: string;
  idempotencyKey: string;
  enrollmentId: string;
  pilotId: MarketplacePilotId;
  positionId: string;
  assetId: string;
  sourcePositionReference: string;
  priceUsd: number;
  previousExecutableValueUsd: number;
  executableValueUsd: number;
  unrealizedPnlUsd: number;
  sourceReference: string;
  sourceOccurredAt: IsoDateTime;
  recordedAt: IsoDateTime;
  mode: "PAPER";
  executionModel: "INTERNAL_PAPER";
}

export interface ApplyMarketplacePaperMarkInput {
  enrollmentId: string;
  /** Either local positionId or sourcePositionReference must resolve the open lot. */
  positionId?: string;
  sourcePositionReference?: string;
  assetId: string;
  priceUsd: number;
  sourceReference: string;
  sourceOccurredAt?: IsoDateTime;
  idempotencyKey: string;
  recordedAt?: IsoDateTime;
  mode?: "PAPER";
}

export interface SwitchMarketplacePilotInput {
  sourceEnrollmentId: string;
  targetPilotId: MarketplacePilotId;
  idempotencyKey: string;
  requestedAt?: IsoDateTime;
}

export interface MarketplacePilotSwitchResult {
  source: MarketplaceEnrollment;
  target: MarketplaceEnrollment;
}
