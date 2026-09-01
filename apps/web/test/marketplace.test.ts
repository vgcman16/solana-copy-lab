import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ConfirmUnenrollDialog,
  EnrollmentLedgerDialog,
  MarketplacePanel,
  PilotPerformanceHistory
} from "../src/components/MarketplacePanel";
import type {
  MarketplaceBrokerConnection,
  MarketplaceEnrollment,
  MarketplaceEnrollmentLedger,
  MarketplacePerformanceHistoryPoint,
  MarketplacePilot
} from "../src/components/marketplace-types";
import {
  calculateMarketplacePercentAllocation,
  filterMarketplacePilots,
  pilotCanAcceptPaperEnrollment,
  marketplacePricingEvidenceCopy,
  validateMarketplaceAllocation
} from "../src/components/marketplace-utils";

const autonomousPilot: MarketplacePilot = {
  id: "autonomous-momentum",
  name: "Autonomous momentum",
  summary: "A deterministic high-risk crypto strategy with isolated PAPER accounting.",
  description: "Ranks supported crypto opportunities and acts only after cost and liquidity checks.",
  category: "AUTONOMOUS_AI",
  assetClass: "CRYPTO",
  risk: "EXTREME",
  stage: "ACTIVE",
  curator: { name: "CopyLab Research", kind: "COPYLAB", detail: "Deterministic engine" },
  availability: { paper: true, manualLive: false, autoLive: false },
  performance: {
    periodLabel: "Forward PAPER",
    netReturnPercent: -0.7,
    maximumDrawdownPercent: 2.3,
    completedTrades: 16,
    winRatePercent: 25,
    profitFactor: 0.76,
    pricingComplete: true,
    updatedAt: "2026-07-18T12:00:00.000Z"
  },
  performanceHistory: [],
  evidence: {
    status: "COLLECTING",
    label: "Forward evidence collecting",
    sampleSize: 16,
    minimumSampleSize: 50,
    notes: ["Results include modeled transaction costs.", "Policy changes cannot rewrite prior outcomes."]
  },
  allocation: { minimumUsd: 25, recommendedUsd: 100, maximumUsd: 500, maximumNavPercent: 40 },
  sourceTiming: "Live crypto market evidence; delayed or stale inputs are rejected.",
  methodology: ["Rank qualified assets.", "Model executable entry and exit costs."],
  risks: ["High volatility can cause rapid PAPER drawdown.", "PAPER fills can differ from live fills."],
  tags: ["Crypto", "Momentum", "High risk"]
};

const filingPilot: MarketplacePilot = {
  ...autonomousPilot,
  id: "public-13f",
  name: "Public 13F tracker",
  summary: "Researches delayed institutional holdings disclosures.",
  description: "A research-only view of public filings, never presented as real-time fund trading.",
  category: "HEDGE_FUND_13F",
  assetClass: "US_STOCKS",
  risk: "MODERATE",
  stage: "RESEARCH_ONLY",
  curator: { name: "Public filing index", kind: "PUBLIC_FILING" },
  availability: { paper: false, manualLive: false, autoLive: false },
  performance: { periodLabel: "Research", completedTrades: 0, pricingComplete: false },
  evidence: { status: "DELAYED_SOURCE", label: "Delayed public source", sampleSize: 0, notes: ["13F filings can arrive weeks after a trade."] },
  sourceTiming: "Quarterly 13F filings are delayed and do not reveal real-time trades.",
  tags: ["Stocks", "13F", "Public filings"]
};

const enrollment: MarketplaceEnrollment = {
  id: "enrollment-1",
  pilotId: autonomousPilot.id,
  status: "ACTIVE",
  mode: "PAPER",
  allocationUsd: 100,
  currentValueUsd: 99.3,
  realizedPnlUsd: -0.7,
  unrealizedPnlUsd: 0,
  mirroredOrders: 16,
  openPositions: 0,
  openedAt: "2026-07-10T12:00:00.000Z",
  updatedAt: "2026-07-18T12:00:00.000Z"
};

const brokers: MarketplaceBrokerConnection[] = [
  {
    id: "alpaca",
    name: "Alpaca",
    status: "PAPER_READY",
    official: true,
    paperSupported: true,
    liveSupported: false,
    buyingPowerUsd: 955,
    detail: "Official market data feeds the internal CopyLab PAPER simulator; no broker-hosted order is sent.",
    capabilities: ["Market data", "Internal PAPER fills"]
  },
  {
    id: "robinhood-equities",
    name: "Robinhood equities",
    status: "UNAVAILABLE_WITHOUT_WRITTEN_AUTHORIZATION",
    official: false,
    paperSupported: false,
    liveSupported: false,
    detail: "No authorized connector is configured.",
    capabilities: []
  }
];

describe("CopyLab marketplace UI", () => {
  it("renders transparent PAPER-first catalog evidence and a direct adviser disclosure", () => {
    const html = renderToStaticMarkup(createElement(MarketplacePanel, {
      pilots: [autonomousPilot, filingPilot],
      enrollments: [],
      brokers
    }));

    expect(html).toContain("CopyLab pilot marketplace");
    expect(html).toContain("Autonomous momentum");
    expect(html).toContain("Public 13F tracker");
    expect(html).toContain("PAPER engine available");
    expect(html).toContain("Live locked");
    expect(html).toContain("Past results do not guarantee future profit");
    expect(html).toContain("public filings and political disclosures can be delayed");
    expect(html).toContain("not an investment adviser, broker-dealer, custodian, or SEC-registered adviser");
    expect(html).not.toContain("guaranteed returns");
    expect(html).not.toContain("qualified strategy");
    expect(html).not.toContain("qualified pilot");
  });

  it("renders isolated enrollment controls in My Pilots", () => {
    const html = renderToStaticMarkup(createElement(MarketplacePanel, {
      pilots: [autonomousPilot],
      enrollments: [enrollment],
      brokers,
      initialView: "MY_PILOTS"
    }));

    expect(html).toContain("My Pilots");
    expect(html).toContain("isolated virtual account");
    expect(html).toContain("Pause");
    expect(html).toContain("View ledger");
    expect(html).toContain("Rebalance");
    expect(html).toContain("Switch");
    expect(html).toContain("Unenroll");
    expect(html).toContain("never pooled");
  });

  it("keeps unsupported broker controls disabled", () => {
    const localPaper: MarketplaceBrokerConnection = {
      id: "COPYLAB_PAPER",
      name: "CopyLab Isolated PAPER",
      status: "PAPER_CONNECTED",
      official: true,
      paperSupported: true,
      liveSupported: false,
      detail: "Local isolated simulation ledger; no external funds or orders.",
      capabilities: ["Isolated local PAPER ledger", "No external order routing"]
    };
    const html = renderToStaticMarkup(createElement(MarketplacePanel, {
      pilots: [],
      enrollments: [],
      brokers: [localPaper, ...brokers],
      initialView: "BROKERS",
      actions: {
        enroll: async () => enrollment,
        pause: async () => enrollment,
        resume: async () => enrollment,
        unenroll: async () => undefined,
        loadEnrollmentLedger: async () => ({ enrollment, positions: [], fills: [], events: [] }),
        switchPilot: async () => enrollment,
        previewRebalance: async () => ({
          id: "preview-1",
          enrollmentId: enrollment.id,
          currentAllocationUsd: 100,
          targetAllocationUsd: 110,
          cashChangeUsd: 10,
          estimatedCostsUsd: 0.1,
          orders: [],
          warnings: [],
          expiresAt: "2026-07-18T12:01:00.000Z"
        }),
        confirmRebalance: async () => enrollment,
        connectBroker: async () => undefined
      }
    }));

    expect(html).toContain("Configure provider PAPER/data");
    expect(html).toContain("UNAVAILABLE WITHOUT WRITTEN AUTHORIZATION");
    expect(html).toContain("0 external connected");
    expect(html).toContain("Local PAPER simulator active");
    expect(html).toContain("Provider access &amp; routing boundaries");
    expect(html).not.toContain("Official setup path");
    expect(html).toContain("disabled");
  });

  it("filters by category, asset, risk, and free text without mutating the source", () => {
    const source = [autonomousPilot, filingPilot];
    expect(filterMarketplacePilots(source, {
      query: "institutional",
      category: "ALL",
      assetClass: "ALL",
      risk: "ALL"
    })).toEqual([filingPilot]);
    expect(filterMarketplacePilots(source, {
      query: "",
      category: "AUTONOMOUS_AI",
      assetClass: "CRYPTO",
      risk: "EXTREME"
    })).toEqual([autonomousPilot]);
    expect(filterMarketplacePilots(source, {
      query: "",
      category: "ALL",
      assetClass: "US_STOCKS",
      risk: "ALL"
    })).toEqual([filingPilot]);
    expect(source).toHaveLength(2);
  });

  it("validates PAPER allocations and blocks research-only enrollment", () => {
    expect(validateMarketplaceAllocation(autonomousPilot, 24)).toContain("Minimum PAPER allocation");
    expect(validateMarketplaceAllocation(autonomousPilot, 501)).toContain("Maximum PAPER allocation");
    expect(validateMarketplaceAllocation(autonomousPilot, 100, 50)).toContain("available PAPER buying power");
    expect(validateMarketplaceAllocation(autonomousPilot, 100)).toBeUndefined();
    expect(pilotCanAcceptPaperEnrollment(autonomousPilot)).toBe(true);
    expect(pilotCanAcceptPaperEnrollment(filingPilot)).toBe(false);
  });

  it("calculates percentage enrollment from an explicit reference NAV without inventing buying power", () => {
    expect(calculateMarketplacePercentAllocation(25, 1_000)).toEqual({ allocationUsd: 250 });
    expect(calculateMarketplacePercentAllocation(0, 1_000).error).toContain("greater than 0%");
    expect(calculateMarketplacePercentAllocation(41, 1_000, 40).error).toContain("40.00%");
    expect(calculateMarketplacePercentAllocation(25, 0).error).toContain("Reference NAV");
  });

  it("keeps incomplete pricing evidence separate from the pilot enrollment decision", () => {
    const copy = marketplacePricingEvidenceCopy(false);
    expect(copy).toContain("qualification separately determines enrollment availability");
    expect(copy).not.toContain("not enrollment-ready");
  });

  it("renders committed positions, fills, and audit events in the enrollment ledger", () => {
    const ledger: MarketplaceEnrollmentLedger = {
      enrollment,
      positions: [{
        id: "position-1",
        assetId: "AAPL",
        sourcePositionReference: "stock-source-position-reference-1",
        status: "OPEN",
        quantity: 0.5,
        entryPriceUsd: 200,
        entryNotionalUsd: 100,
        costBasisUsd: 100.1,
        lastExecutableValueUsd: 102,
        unrealizedPnlUsd: 1.9,
        openedAt: "2026-07-18T11:00:00.000Z",
        updatedAt: "2026-07-18T12:00:00.000Z"
      }],
      fills: [{
        id: "fill-1",
        action: "OPEN",
        assetId: "AAPL",
        sourcePositionReference: "stock-source-position-reference-1",
        quantity: 0.5,
        priceUsd: 200,
        grossNotionalUsd: 100,
        modeledCostsUsd: 0.1,
        netCashChangeUsd: -100.1,
        sourceReference: "stock-source-order-reference-1",
        sourceOccurredAt: "2026-07-18T10:59:58.000Z",
        filledAt: "2026-07-18T11:00:00.000Z"
      }],
      events: [{
        id: "event-1",
        kind: "PAPER_MIRROR_OPENED",
        occurredAt: "2026-07-18T11:00:00.000Z",
        details: { assetId: "AAPL", modeledCostsUsd: 0.1 }
      }]
    };
    const sharedProps = {
      enrollment,
      pilot: autonomousPilot,
      ledger,
      loading: false,
      error: undefined,
      onClose: () => undefined,
      onRetry: () => undefined
    };
    const positionsHtml = renderToStaticMarkup(createElement(EnrollmentLedgerDialog, sharedProps));
    const fillsHtml = renderToStaticMarkup(createElement(EnrollmentLedgerDialog, { ...sharedProps, initialTab: "FILLS" as const }));
    const auditHtml = renderToStaticMarkup(createElement(EnrollmentLedgerDialog, { ...sharedProps, initialTab: "AUDIT" as const }));

    expect(positionsHtml).toContain("Committed isolated PAPER ledger");
    expect(positionsHtml).toContain("AAPL");
    expect(positionsHtml).toContain("Read-only view");
    expect(fillsHtml).toContain("Modeled costs");
    expect(fillsHtml).toContain("-$100.10");
    expect(auditHtml).toContain("PAPER position opened");
    expect(auditHtml).toContain("modeledCostsUsd");
  });

  it("blocks unenrollment while committed PAPER exposure remains and requires confirmation otherwise", () => {
    const blockedHtml = renderToStaticMarkup(createElement(ConfirmUnenrollDialog, {
      enrollment: { ...enrollment, openPositions: 1 },
      pilot: autonomousPilot,
      busy: false,
      actionsReady: true,
      error: undefined,
      onClose: () => undefined,
      onConfirm: async () => undefined
    }));
    const readyHtml = renderToStaticMarkup(createElement(ConfirmUnenrollDialog, {
      enrollment,
      pilot: autonomousPilot,
      busy: false,
      actionsReady: true,
      error: undefined,
      onClose: () => undefined,
      onConfirm: async () => undefined
    }));

    expect(blockedHtml).toContain("Open exposure blocks unenrollment");
    expect(blockedHtml).toContain("disabled");
    expect(readyHtml).toContain("stops future PAPER entries");
    expect(readyHtml).toContain("Confirm unenroll");
  });

  it("shows a truthful collecting state when no performance snapshots exist", () => {
    const html = renderToStaticMarkup(createElement(PilotPerformanceHistory, {
      history: [],
      pilotName: autonomousPilot.name
    }));

    expect(html).toContain('data-history-state="empty"');
    expect(html).toContain("No captured snapshots are available yet");
    expect(html).not.toContain("marketplace-history-chart");
  });

  it("shows the actual sparse snapshot without inventing a trend line", () => {
    const history: MarketplacePerformanceHistoryPoint[] = [{
      capturedAt: "2026-07-18T12:00:00.000Z",
      netReturnPercent: -0.7,
      realizedPnlUsd: -0.98,
      maximumDrawdownPercent: 2.3,
      completedTrades: 16,
      openPositions: 0,
      pricingComplete: true,
      evidenceStatus: "COLLECTING",
      disclosure: "Simulated PAPER performance."
    }];
    const html = renderToStaticMarkup(createElement(PilotPerformanceHistory, {
      history,
      pilotName: autonomousPilot.name
    }));

    expect(html).toContain('data-history-state="sparse"');
    expect(html).toContain("Not enough snapshots for a trend");
    expect(html).toContain("-0.7%");
    expect(html).toContain("-$0.98");
    expect(html).not.toContain("marketplace-history-line");
  });
});
