import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type {
  MarketplaceBrokerCapability as ApiBrokerCapability,
  MarketplaceEnrollment as ApiEnrollment,
  MarketplacePilot as ApiPilot,
  MarketplacePilotPerformance as ApiPilotPerformance,
  MarketplaceRebalancePreview as ApiPreview
} from "@copylab/shared";
import { MarketplaceWorkspace, marketplaceIdempotencyKey } from "../src/components/MarketplaceWorkspace";
import {
  adaptMarketplaceBroker,
  adaptMarketplaceBundle,
  adaptMarketplaceEnrollmentLedger,
  adaptMarketplacePerformanceHistory,
  adaptMarketplacePilot,
  adaptMarketplacePreview
} from "../src/marketplace-adapter";
import type { MarketplaceBundle } from "../src/marketplace-api";

const NOW = "2026-07-18T18:00:00.000Z";

function pilot(overrides: Partial<ApiPilot> = {}): ApiPilot {
  return {
    id: "pilot:stock-momentum",
    slug: "stock-momentum",
    version: 1,
    name: "US Stock Momentum",
    shortDescription: "A stock PAPER pilot.",
    longDescription: "Uses recorded official market data and isolated local PAPER fills.",
    kind: "AUTONOMOUS",
    assetClass: "US_EQUITIES",
    riskLevel: "HIGH",
    dataCadence: "NEAR_REAL_TIME",
    tags: ["stocks", "momentum"],
    paperAvailable: true,
    executionModel: "INTERNAL_PAPER",
    liveCapability: "OFFICIAL_CONNECTOR_REQUIRED",
    automaticMirroring: true,
    mirroringDestination: "ISOLATED_VIRTUAL_ACCOUNT",
    minimumPaperAllocationUsd: 100,
    status: "ACTIVE",
    evidence: {
      status: "FORWARD_TESTING",
      completedTrades: 12,
      observationDays: 8,
      source: "CopyLab stock PAPER ledger",
      methodology: "Recorded signals are replayed into an isolated virtual account.",
      limitations: ["PAPER fills can differ from live execution."],
      updatedAt: NOW
    },
    latestPerformance: {
      capturedAt: NOW,
      netReturnPercent: 1.2,
      realizedPnlUsd: 12,
      maxDrawdownPercent: 2.5,
      profitFactor: 1.3,
      winRatePercent: 55,
      completedTrades: 12,
      openPositions: 0,
      executablePricingComplete: true,
      evidenceStatus: "FORWARD_TESTING",
      disclosure: "Simulated performance."
    },
    disclosures: ["No real brokerage order is created."],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  };
}

function enrollment(): ApiEnrollment {
  return {
    id: "enrollment:1",
    pilotId: "pilot:stock-momentum",
    mode: "PAPER",
    executionModel: "INTERNAL_PAPER",
    status: "ACTIVE",
    allocation: { kind: "USD", value: 500 },
    targetAllocationUsd: 500,
    account: {
      fundedCapitalUsd: 500,
      navUsd: 512,
      cashUsd: 512,
      deployedUsd: 0,
      realizedPnlUsd: 12,
      unrealizedPnlUsd: 0,
      openPositions: 0,
      updatedAt: NOW
    },
    automaticMirroring: true,
    createdAt: NOW,
    updatedAt: NOW
  };
}

function broker(overrides: Partial<ApiBrokerCapability> = {}): ApiBrokerCapability {
  return {
    id: "ALPACA_PAPER",
    name: "Alpaca Paper",
    officialApiOnly: true,
    supportedAssetClasses: ["US_EQUITIES"],
    paperExecutionSupported: true,
    liveExecutionSupported: false,
    automaticOrderSubmissionEnabled: false,
    authentication: "API_KEYS",
    connectionStatus: "CONNECTED_LOCAL_SIMULATION",
    message: "Official data is connected; fills remain in CopyLab's local PAPER simulator.",
    ...overrides
  };
}

describe("marketplace backend-to-dashboard integration", () => {
  it("maps active pilots to PAPER enrollment and keeps research trackers view-only", () => {
    const active = adaptMarketplacePilot(pilot());
    const research = adaptMarketplacePilot(pilot({
      id: "pilot:hedge-fund-13f-tracker",
      slug: "hedge-fund-13f-tracker",
      name: "Hedge Fund 13F Research",
      kind: "REGULATORY_TRACKER",
      dataCadence: "REGULATORY_DELAYED",
      automaticMirroring: false,
      status: "RESEARCH_ONLY",
      tags: ["13F", "delayed"]
    }));

    expect(active.category).toBe("STOCK_MOMENTUM");
    expect(active.availability.paper).toBe(true);
    expect(active.availability.autoLive).toBe(false);
    expect(active.performance.netReturnPercent).toBe(1.2);
    expect(research.category).toBe("HEDGE_FUND_13F");
    expect(research.stage).toBe("RESEARCH_ONLY");
    expect(research.availability.paper).toBe(false);
    expect(research.sourceTiming).toContain("weeks");
  });

  it("labels Alpaca as official data with local PAPER fills and never live execution", () => {
    const adapted = adaptMarketplaceBroker(broker());
    expect(adapted.status).toBe("PAPER_CONNECTED");
    expect(adapted.accountLabel).toContain("CopyLab-local ledger");
    expect(adapted.liveSupported).toBe(false);
    expect(adapted.capabilities).toContain("No external order routing");
  });

  it("preserves unsupported connector boundaries without implying a setup flow", () => {
    const robinhood = adaptMarketplaceBroker(broker({
      id: "ROBINHOOD_EQUITIES",
      name: "Robinhood Equities",
      paperExecutionSupported: false,
      authentication: "UNAVAILABLE",
      connectionStatus: "UNAVAILABLE_WITHOUT_WRITTEN_AUTHORIZATION"
    }));
    const futureAgent = adaptMarketplaceBroker({
      ...broker({ id: "ROBINHOOD_EQUITIES", name: "Robinhood Equities" }),
      connectionStatus: "OFFICIAL_AGENT_CONNECTION_AVAILABLE" as ApiBrokerCapability["connectionStatus"]
    });
    expect(robinhood.status).toBe("UNAVAILABLE_WITHOUT_WRITTEN_AUTHORIZATION");
    expect(futureAgent.status).toBe("UNAVAILABLE");
    expect(futureAgent.liveSupported).toBe(false);
  });

  it("maps isolated account and mirror evidence from the marketplace bundle", () => {
    const bundle: MarketplaceBundle = {
      catalog: {
        paperOnly: true,
        executionModel: "INTERNAL_PAPER",
        liveOrderCapabilityEnabled: false,
        pilots: [pilot()],
        brokers: [broker()],
        disclosures: ["PAPER only."],
        updatedAt: NOW
      },
      enrollments: [{
        enrollment: enrollment(),
        mirroredOrders: 7,
        lastMirroredAt: NOW
      }],
      performanceHistory: {
        "pilot:stock-momentum": [pilot().latestPerformance!]
      }
    };
    const view = adaptMarketplaceBundle(bundle);
    expect(view.enrollments).toHaveLength(1);
    expect(view.enrollments[0]?.allocationUsd).toBe(500);
    expect(view.enrollments[0]?.currentValueUsd).toBe(512);
    expect(view.enrollments[0]?.mirroredOrders).toBe(7);
    expect(view.enrollments[0]?.openPositions).toBe(0);
    expect(view.brokers[0]?.status).toBe("PAPER_CONNECTED");
    expect(view.pilots[0]?.performanceHistory).toHaveLength(1);
  });

  it("preserves a percentage enrollment reference and maps only committed ledger rows", () => {
    const percentEnrollment: ApiEnrollment = {
      ...enrollment(),
      allocation: { kind: "PERCENT", value: 20, referenceNavUsd: 2_500 },
      targetAllocationUsd: 500
    };
    const detail = {
      enrollment: percentEnrollment,
      mirroredOrders: 1,
      lastMirroredAt: NOW,
      positions: [{
        id: "position:1",
        enrollmentId: percentEnrollment.id,
        pilotId: percentEnrollment.pilotId,
        assetId: "AAPL",
        sourcePositionReference: "source-position:1",
        status: "OPEN" as const,
        quantity: 1,
        entryPriceUsd: 100,
        entryNotionalUsd: 100,
        entryCostsUsd: 0.1,
        costBasisUsd: 100.1,
        lastExecutableValueUsd: 101,
        unrealizedPnlUsd: 0.9,
        openedAt: NOW,
        updatedAt: NOW
      }],
      fills: [{
        id: "fill:1",
        idempotencyKey: "mirror:1",
        enrollmentId: percentEnrollment.id,
        pilotId: percentEnrollment.pilotId,
        positionId: "position:1",
        action: "OPEN" as const,
        assetId: "AAPL",
        sourcePositionReference: "source-position:1",
        quantity: 1,
        priceUsd: 100,
        grossNotionalUsd: 100,
        modeledCostsUsd: 0.1,
        netCashChangeUsd: -100.1,
        sourceReference: "source-order:1",
        sourceOccurredAt: NOW,
        mode: "PAPER" as const,
        executionModel: "INTERNAL_PAPER" as const,
        filledAt: NOW
      }]
    };
    const mapped = adaptMarketplaceEnrollmentLedger(detail, {
      enrollmentId: percentEnrollment.id,
      events: [{
        id: "event:1",
        idempotencyKey: "event-key:1",
        enrollmentId: percentEnrollment.id,
        pilotId: percentEnrollment.pilotId,
        kind: "PAPER_MIRROR_OPENED",
        mode: "PAPER",
        occurredAt: NOW,
        details: { assetId: "AAPL" }
      }]
    });

    expect(mapped.enrollment.allocationPercent).toBe(20);
    expect(mapped.enrollment.allocationReferenceNavUsd).toBe(2_500);
    expect(mapped.positions).toHaveLength(1);
    expect(mapped.fills[0]?.sourceReference).toBe("source-order:1");
    expect(mapped.events[0]?.kind).toBe("PAPER_MIRROR_OPENED");
  });

  it("maps and chronologically sorts only actual captured performance snapshots", () => {
    const later = pilot().latestPerformance!;
    const earlier: ApiPilotPerformance = {
      ...later,
      capturedAt: "2026-07-17T18:00:00.000Z",
      netReturnPercent: -0.4,
      realizedPnlUsd: -4,
      completedTrades: 8,
      openPositions: 1,
      executablePricingComplete: false,
      evidenceStatus: "LIMITED"
    };

    const mapped = adaptMarketplacePerformanceHistory([later, earlier]);

    expect(mapped).toHaveLength(2);
    expect(mapped.map((point) => point.capturedAt)).toEqual([
      earlier.capturedAt,
      later.capturedAt
    ]);
    expect(mapped[0]).toMatchObject({
      netReturnPercent: -0.4,
      realizedPnlUsd: -4,
      completedTrades: 8,
      openPositions: 1,
      pricingComplete: false,
      evidenceStatus: "INSUFFICIENT"
    });
    expect(later.capturedAt).toBe(NOW);
  });

  it("maps a server rebalance preview without inventing broker orders or fees", () => {
    const raw: ApiPreview = {
      id: "preview:1",
      enrollmentId: "enrollment:1",
      pilotId: "pilot:stock-momentum",
      mode: "PAPER",
      status: "PREVIEWED",
      currentFundedCapitalUsd: 500,
      targetFundedCapitalUsd: 650,
      cashDeltaUsd: 150,
      deployedUsd: 0,
      canApply: true,
      blockers: [],
      createdAt: NOW,
      expiresAt: "2026-07-18T18:15:00.000Z"
    };
    const preview = adaptMarketplacePreview(raw);
    expect(preview.cashChangeUsd).toBe(150);
    expect(preview.estimatedCostsUsd).toBe(0);
    expect(preview.orders).toEqual([]);
  });

  it("renders a safe loading workspace and creates bounded unique mutation keys", () => {
    const html = renderToStaticMarkup(createElement(MarketplaceWorkspace, {
      csrfToken: "csrf-test",
      onOpenProviders: () => undefined
    }));
    const first = marketplaceIdempotencyKey("enroll");
    const second = marketplaceIdempotencyKey("enroll");
    expect(html).toContain("Loading the marketplace");
    expect(first).toMatch(/^marketplace-web:enroll:/);
    expect(second).not.toBe(first);
    expect(first.length).toBeLessThanOrEqual(256);
  });
});
