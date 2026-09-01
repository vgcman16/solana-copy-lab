import type {
  MarketplaceBrokerCapability as ApiBrokerCapability,
  MarketplaceBrokerConnectionStatus as ApiBrokerStatus,
  MarketplaceEnrollment as ApiEnrollment,
  MarketplaceEvidenceStatus as ApiEvidenceStatus,
  MarketplacePilot as ApiPilot,
  MarketplacePilotPerformance as ApiPilotPerformance,
  MarketplaceRebalancePreview as ApiRebalancePreview
} from "@copylab/shared";
import type {
  MarketplaceBrokerConnection,
  MarketplaceBrokerStatus,
  MarketplaceEnrollment,
  MarketplaceEnrollmentLedger,
  MarketplacePerformanceHistoryPoint,
  MarketplacePilot,
  MarketplacePilotCategory,
  MarketplacePilotEvidence,
  MarketplaceRebalancePreview
} from "./components/marketplace-types";
import type {
  MarketplaceBundle,
  MarketplaceEnrollmentDetailResponse,
  MarketplaceEnrollmentEventsResponse,
  MarketplaceEnrollmentSummary
} from "./marketplace-api";

const PAPER_ALLOCATION_LIMIT_USD = 100_000_000;

function pilotCategory(pilot: ApiPilot): MarketplacePilotCategory {
  if (pilot.kind === "WALLET_COPY") return "WALLET_COPY";
  if (pilot.kind === "THEMATIC") return "THEMATIC";
  if (pilot.kind === "REGULATORY_TRACKER") {
    return pilot.slug.includes("13f") || pilot.tags.some((tag) => tag.toLocaleLowerCase() === "13f")
      ? "HEDGE_FUND_13F"
      : "POLITICIAN_DISCLOSURE";
  }
  return pilot.assetClass === "US_EQUITIES" ? "STOCK_MOMENTUM" : "AUTONOMOUS_AI";
}

function evidenceStatus(status: ApiEvidenceStatus): MarketplacePilotEvidence["status"] {
  if (status === "SUFFICIENT") return "QUALIFIED";
  if (status === "DELAYED_SOURCE") return "DELAYED_SOURCE";
  if (status === "LIMITED") return "INSUFFICIENT";
  return "COLLECTING";
}

function evidenceLabel(status: ApiEvidenceStatus): string {
  if (status === "SUFFICIENT") return "Forward evidence qualified";
  if (status === "DELAYED_SOURCE") return "Delayed public source";
  if (status === "LIMITED") return "Evidence is still limited";
  return "Forward evidence collecting";
}

function sourceTiming(pilot: ApiPilot): string {
  if (pilot.dataCadence === "REAL_TIME") {
    return "Runtime source observations are recorded when required providers are healthy; use the displayed timestamp to judge freshness. Stale or ineligible signals remain blocked.";
  }
  if (pilot.dataCadence === "NEAR_REAL_TIME") {
    return "Runtime cycles record source data when provider-health and market-data freshness checks pass; use the displayed timestamp to judge freshness. Every PAPER action still uses recorded eligibility and pricing checks.";
  }
  if (pilot.dataCadence === "DAILY") {
    return "Daily research cadence; allocations change only through versioned PAPER rebalances.";
  }
  return "Regulatory disclosures can arrive weeks after the underlying activity and are research-only.";
}

export function adaptMarketplacePilot(pilot: ApiPilot): MarketplacePilot {
  const performance = pilot.latestPerformance;
  const minimumUsd = pilot.minimumPaperAllocationUsd;
  const researchOnly = pilot.status !== "ACTIVE" || !pilot.automaticMirroring;
  const observations = pilot.evidence.completedTrades;
  const notes = [
    pilot.evidence.methodology,
    ...pilot.evidence.limitations
  ].filter((value, index, values) => value.trim().length > 0 && values.indexOf(value) === index);

  return {
    id: pilot.id,
    name: pilot.name,
    summary: pilot.shortDescription,
    description: pilot.longDescription,
    category: pilotCategory(pilot),
    assetClass: pilot.assetClass === "US_EQUITIES" ? "US_STOCKS" : "CRYPTO",
    risk: pilot.riskLevel === "VERY_HIGH" ? "EXTREME" : pilot.riskLevel,
    stage: pilot.status === "ACTIVE" ? "ACTIVE" : pilot.status === "RESEARCH_ONLY" ? "RESEARCH_ONLY" : "PAUSED",
    curator: {
      name: pilot.kind === "REGULATORY_TRACKER"
        ? "Public filing research"
        : pilot.kind === "WALLET_COPY"
          ? "CopyLab wallet research"
          : "CopyLab Research",
      kind: pilot.kind === "REGULATORY_TRACKER"
        ? "PUBLIC_FILING"
        : pilot.kind === "WALLET_COPY"
          ? "WALLET_COHORT"
          : "COPYLAB",
      detail: pilot.evidence.source
    },
    availability: {
      paper: !researchOnly,
      manualLive: false,
      autoLive: false,
      liveRequirement: pilot.liveCapability === "OFFICIAL_CONNECTOR_REQUIRED"
        ? "An eligible official connector and a separate live-mode review would be required."
        : "Live marketplace execution is disabled."
    },
    performance: {
      periodLabel: pilot.evidence.observationDays > 0
        ? `${pilot.evidence.observationDays}d forward PAPER`
        : "Forward PAPER",
      ...(performance?.netReturnPercent !== undefined ? { netReturnPercent: performance.netReturnPercent } : {}),
      ...(performance?.realizedPnlUsd !== undefined ? { netPnlUsd: performance.realizedPnlUsd } : {}),
      ...(performance?.maxDrawdownPercent !== undefined ? { maximumDrawdownPercent: performance.maxDrawdownPercent } : {}),
      completedTrades: performance?.completedTrades ?? observations,
      ...(performance?.winRatePercent !== undefined ? { winRatePercent: performance.winRatePercent } : {}),
      ...(performance?.profitFactor !== undefined ? { profitFactor: performance.profitFactor } : {}),
      pricingComplete: performance?.executablePricingComplete ?? false,
      observedFrom: pilot.createdAt,
      updatedAt: performance?.capturedAt ?? pilot.evidence.updatedAt
    },
    performanceHistory: [],
    evidence: {
      status: evidenceStatus(pilot.evidence.status),
      label: evidenceLabel(pilot.evidence.status),
      sampleSize: observations,
      ...(pilot.evidence.status !== "SUFFICIENT" ? { minimumSampleSize: 50 } : {}),
      observedWeeks: Math.floor(pilot.evidence.observationDays / 7),
      notes
    },
    allocation: {
      minimumUsd,
      recommendedUsd: Math.max(minimumUsd * 2, pilot.assetClass === "US_EQUITIES" ? 250 : 50),
      maximumUsd: PAPER_ALLOCATION_LIMIT_USD,
      maximumNavPercent: 100
    },
    sourceTiming: sourceTiming(pilot),
    methodology: [pilot.evidence.methodology],
    risks: [...pilot.evidence.limitations, ...pilot.disclosures],
    tags: [...pilot.tags]
  };
}

export function adaptMarketplacePerformanceHistory(
  history: readonly ApiPilotPerformance[]
): MarketplacePerformanceHistoryPoint[] {
  return [...history]
    .sort((left, right) => left.capturedAt.localeCompare(right.capturedAt))
    .map((snapshot) => ({
      capturedAt: snapshot.capturedAt,
      ...(snapshot.netReturnPercent !== undefined
        ? { netReturnPercent: snapshot.netReturnPercent }
        : {}),
      ...(snapshot.realizedPnlUsd !== undefined
        ? { realizedPnlUsd: snapshot.realizedPnlUsd }
        : {}),
      ...(snapshot.maxDrawdownPercent !== undefined
        ? { maximumDrawdownPercent: snapshot.maxDrawdownPercent }
        : {}),
      ...(snapshot.profitFactor !== undefined
        ? { profitFactor: snapshot.profitFactor }
        : {}),
      ...(snapshot.winRatePercent !== undefined
        ? { winRatePercent: snapshot.winRatePercent }
        : {}),
      completedTrades: snapshot.completedTrades,
      openPositions: snapshot.openPositions,
      pricingComplete: snapshot.executablePricingComplete,
      evidenceStatus: evidenceStatus(snapshot.evidenceStatus),
      disclosure: snapshot.disclosure
    }));
}

export function adaptMarketplaceEnrollment(
  summary: MarketplaceEnrollmentSummary
): MarketplaceEnrollment {
  const enrollment = summary.enrollment;
  const allocationPercent = enrollment.allocation.kind === "PERCENT"
    ? enrollment.allocation.value
    : undefined;
  const allocationReferenceNavUsd = enrollment.allocation.kind === "PERCENT"
    ? enrollment.allocation.referenceNavUsd
    : undefined;
  return {
    id: enrollment.id,
    pilotId: enrollment.pilotId,
    status: enrollment.status === "PAUSED" ? "PAUSED" : "ACTIVE",
    mode: "PAPER",
    allocationUsd: enrollment.account.fundedCapitalUsd,
    ...(allocationPercent !== undefined ? { allocationPercent } : {}),
    ...(allocationReferenceNavUsd !== undefined ? { allocationReferenceNavUsd } : {}),
    currentValueUsd: enrollment.account.navUsd,
    realizedPnlUsd: enrollment.account.realizedPnlUsd,
    unrealizedPnlUsd: enrollment.account.unrealizedPnlUsd,
    mirroredOrders: summary.mirroredOrders,
    openPositions: enrollment.account.openPositions,
    openedAt: enrollment.createdAt,
    updatedAt: enrollment.updatedAt,
    ...(summary.lastMirroredAt !== undefined ? { lastMirroredAt: summary.lastMirroredAt } : {}),
    ...(enrollment.status === "PAUSED"
      ? { pausedReason: "Paused by the user; new PAPER mirrors are disabled." }
      : {})
  };
}

export function adaptMarketplaceEnrollmentLedger(
  detail: MarketplaceEnrollmentDetailResponse,
  eventResponse: MarketplaceEnrollmentEventsResponse
): MarketplaceEnrollmentLedger {
  return {
    enrollment: adaptMarketplaceEnrollment(detail),
    positions: detail.positions.map((position) => ({
      id: position.id,
      assetId: position.assetId,
      sourcePositionReference: position.sourcePositionReference,
      status: position.status,
      quantity: position.quantity,
      entryPriceUsd: position.entryPriceUsd,
      entryNotionalUsd: position.entryNotionalUsd,
      costBasisUsd: position.costBasisUsd,
      lastExecutableValueUsd: position.lastExecutableValueUsd,
      unrealizedPnlUsd: position.unrealizedPnlUsd,
      ...(position.realizedPnlUsd !== undefined ? { realizedPnlUsd: position.realizedPnlUsd } : {}),
      openedAt: position.openedAt,
      updatedAt: position.updatedAt,
      ...(position.closedAt !== undefined ? { closedAt: position.closedAt } : {})
    })),
    fills: detail.fills.map((fill) => ({
      id: fill.id,
      action: fill.action,
      assetId: fill.assetId,
      sourcePositionReference: fill.sourcePositionReference,
      quantity: fill.quantity,
      priceUsd: fill.priceUsd,
      grossNotionalUsd: fill.grossNotionalUsd,
      modeledCostsUsd: fill.modeledCostsUsd,
      netCashChangeUsd: fill.netCashChangeUsd,
      sourceReference: fill.sourceReference,
      sourceOccurredAt: fill.sourceOccurredAt,
      filledAt: fill.filledAt
    })),
    events: eventResponse.events.map((event) => ({
      id: event.id,
      kind: event.kind,
      occurredAt: event.occurredAt,
      details: event.details
    }))
  };
}

export function adaptEnrollmentWithoutEvents(enrollment: ApiEnrollment): MarketplaceEnrollment {
  return adaptMarketplaceEnrollment({ enrollment, mirroredOrders: 0 });
}

function brokerStatus(status: ApiBrokerStatus | string, brokerId: string): MarketplaceBrokerStatus {
  const normalized = String(status);
  if (normalized === "CONNECTED" || normalized === "CONNECTED_LOCAL_SIMULATION") return "PAPER_CONNECTED";
  if (normalized === "NOT_CONFIGURED") return brokerId === "ALPACA_PAPER" ? "PAPER_READY" : "NOT_CONNECTED";
  if (normalized === "OFFICIAL_AGENT_CONNECTION_AVAILABLE") return "UNAVAILABLE";
  if (normalized === "NOT_CONFIGURED_LIVE_LOCKED") return "NOT_CONFIGURED_LIVE_LOCKED";
  if (normalized === "OFFICIAL_ACCESS_REQUIRED") return "OFFICIAL_ACCESS_REQUIRED";
  if (normalized === "UNAVAILABLE_WITHOUT_WRITTEN_AUTHORIZATION") {
    return "UNAVAILABLE_WITHOUT_WRITTEN_AUTHORIZATION";
  }
  return "UNAVAILABLE";
}

export function adaptMarketplaceBroker(broker: ApiBrokerCapability): MarketplaceBrokerConnection {
  const capabilities = [
    broker.supportedAssetClasses.includes("CRYPTO") ? "Crypto research" : undefined,
    broker.supportedAssetClasses.includes("US_EQUITIES") ? "US-equity research" : undefined,
    broker.id === "COPYLAB_PAPER" ? "Isolated local PAPER ledger" : undefined,
    broker.paperExecutionSupported && broker.id !== "COPYLAB_PAPER"
      ? "Official provider PAPER/data capability"
      : undefined,
    broker.id === "COPYLAB_PAPER" ? "CopyLab-local PAPER fills" : "CopyLab-local fills only",
    "No external order routing"
  ].filter((value): value is string => value !== undefined);
  const accountLabel = broker.id === "COPYLAB_PAPER"
    ? "Local isolated simulation"
    : broker.connectionStatus === "CONNECTED_LOCAL_SIMULATION"
      ? "Official data access · CopyLab-local ledger"
      : undefined;
  return {
    id: broker.id,
    name: broker.name,
    status: brokerStatus(broker.connectionStatus, broker.id),
    official: broker.officialApiOnly,
    paperSupported: broker.paperExecutionSupported,
    liveSupported: false,
    ...(accountLabel !== undefined ? { accountLabel } : {}),
    detail: broker.message,
    capabilities
  };
}

export function adaptMarketplacePreview(preview: ApiRebalancePreview): MarketplaceRebalancePreview {
  return {
    id: preview.id,
    enrollmentId: preview.enrollmentId,
    currentAllocationUsd: preview.currentFundedCapitalUsd,
    targetAllocationUsd: preview.targetFundedCapitalUsd,
    cashChangeUsd: preview.cashDeltaUsd,
    estimatedCostsUsd: 0,
    orders: [],
    warnings: preview.blockers.map((blocker) => blocker.replaceAll("_", " ").toLocaleLowerCase()),
    expiresAt: preview.expiresAt
  };
}

export function adaptMarketplaceBundle(bundle: MarketplaceBundle): {
  pilots: MarketplacePilot[];
  enrollments: MarketplaceEnrollment[];
  brokers: MarketplaceBrokerConnection[];
} {
  return {
    pilots: bundle.catalog.pilots.map((pilot) => ({
      ...adaptMarketplacePilot(pilot),
      performanceHistory: adaptMarketplacePerformanceHistory(
        bundle.performanceHistory?.[pilot.id] ?? []
      )
    })),
    enrollments: bundle.enrollments
      .filter(({ enrollment }) => enrollment.status !== "UNENROLLED")
      .map(adaptMarketplaceEnrollment),
    brokers: bundle.catalog.brokers.map(adaptMarketplaceBroker)
  };
}
