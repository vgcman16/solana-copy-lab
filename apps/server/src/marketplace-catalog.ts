import type {
  MarketplaceBrokerCapability,
  MarketplacePilot
} from "@copylab/shared";

const CATALOG_CREATED_AT = "2026-07-18T00:00:00.000Z";

const COMMON_DISCLOSURES = [
  "PAPER simulation only. No real brokerage order is created by the marketplace.",
  "Past or simulated performance does not guarantee future results.",
  "CopyLab is research software. It is not an investment adviser, broker-dealer, custodian, or SEC-registered adviser."
] as const;

function pilot(
  value: Omit<MarketplacePilot,
    "version" | "paperAvailable" | "executionModel" | "mirroringDestination" |
    "createdAt" | "updatedAt" | "disclosures">
): MarketplacePilot {
  return {
    ...value,
    version: 1,
    paperAvailable: value.status === "ACTIVE" && value.automaticMirroring,
    executionModel: "INTERNAL_PAPER",
    mirroringDestination: "ISOLATED_VIRTUAL_ACCOUNT",
    latestPerformance: value.latestPerformance ?? {
      capturedAt: value.evidence.updatedAt,
      completedTrades: value.evidence.completedTrades,
      openPositions: 0,
      executablePricingComplete: false,
      evidenceStatus: value.evidence.status,
      disclosure: "No current CopyLab strategy-ledger snapshot is available for this pilot."
    },
    disclosures: [...COMMON_DISCLOSURES],
    createdAt: CATALOG_CREATED_AT,
    updatedAt: CATALOG_CREATED_AT
  };
}

export const BUILT_IN_MARKETPLACE_PILOTS: readonly MarketplacePilot[] = [
  pilot({
    id: "pilot:strict-wallet-copy",
    slug: "strict-wallet-copy",
    name: "Strict Wallet Copy",
    shortDescription: "Mirrors forward-observed Solana leaders through CopyLab's strict PAPER risk gate.",
    longDescription: "A conservative copy-research lane that accepts only leaders admitted by CopyLab's forward-evidence gates, supported spot swaps, executable pricing, and the full token-safety policy.",
    kind: "WALLET_COPY",
    assetClass: "CRYPTO",
    riskLevel: "HIGH",
    dataCadence: "REAL_TIME",
    tags: ["wallet copy", "Solana", "strict filters"],
    liveCapability: "DISABLED",
    automaticMirroring: true,
    minimumPaperAllocationUsd: 10,
    status: "ACTIVE",
    evidence: {
      status: "FORWARD_TESTING",
      completedTrades: 0,
      observationDays: 0,
      source: "CopyLab forward PAPER ledger",
      methodology: "Qualified-wallet source actions are replayed through the same deterministic risk decisions used by the PAPER broker.",
      limitations: ["Runtime performance is displayed only after executable PAPER fills are persisted."],
      updatedAt: CATALOG_CREATED_AT
    }
  }),
  pilot({
    id: "pilot:high-risk-wallet-copy",
    slug: "high-risk-wallet-copy",
    name: "High-Risk Wallet Copy",
    shortDescription: "A wider Solana leader cohort isolated from strict qualification evidence.",
    longDescription: "A research-only copy lane for testing broader leader and token coverage. Results cannot promote or weaken the strict strategy's safety rules.",
    kind: "WALLET_COPY",
    assetClass: "CRYPTO",
    riskLevel: "VERY_HIGH",
    dataCadence: "REAL_TIME",
    tags: ["wallet copy", "Solana", "research"],
    liveCapability: "NOT_SUPPORTED",
    automaticMirroring: false,
    minimumPaperAllocationUsd: 10,
    status: "RESEARCH_ONLY",
    evidence: {
      status: "LIMITED",
      completedTrades: 0,
      observationDays: 0,
      source: "CopyLab high-risk PAPER ledger",
      methodology: "Each leader receives an isolated virtual account; source buys and proportional exits are simulated with executable quotes when available.",
      limitations: ["High-risk results are intentionally excluded from live promotion evidence."],
      updatedAt: CATALOG_CREATED_AT
    }
  }),
  pilot({
    id: "pilot:autonomous-crypto-momentum",
    slug: "autonomous-crypto-momentum",
    name: "Autonomous Crypto Momentum",
    shortDescription: "CopyLab's isolated high-risk crypto momentum and replay-learning lane.",
    longDescription: "Ranks supported crypto opportunities, records every decision, and evaluates counterfactual replay variants without allowing analysis-only learning to bypass the frozen execution policy.",
    kind: "AUTONOMOUS",
    assetClass: "CRYPTO",
    riskLevel: "VERY_HIGH",
    dataCadence: "NEAR_REAL_TIME",
    tags: ["momentum", "replay learning", "crypto"],
    liveCapability: "NOT_SUPPORTED",
    automaticMirroring: false,
    minimumPaperAllocationUsd: 25,
    status: "RESEARCH_ONLY",
    evidence: {
      status: "FORWARD_TESTING",
      completedTrades: 0,
      observationDays: 0,
      source: "CopyLab autonomous PAPER and replay ledgers",
      methodology: "Frozen policy decisions trade one virtual account while analysis-only variants learn from immutable observations.",
      limitations: ["Replay findings cannot silently alter trading policy or represent live returns."],
      updatedAt: CATALOG_CREATED_AT
    }
  }),
  pilot({
    id: "pilot:stock-momentum",
    slug: "stock-momentum",
    name: "US Stock Momentum",
    shortDescription: "US-equity PAPER momentum using official Alpaca paper data when connected.",
    longDescription: "Scans a bounded US-equity universe, records market evidence and simulated order lifecycles, and maintains a separate stock learning ledger.",
    kind: "AUTONOMOUS",
    assetClass: "US_EQUITIES",
    riskLevel: "HIGH",
    dataCadence: "NEAR_REAL_TIME",
    tags: ["stocks", "momentum", "Alpaca paper"],
    liveCapability: "OFFICIAL_CONNECTOR_REQUIRED",
    automaticMirroring: true,
    minimumPaperAllocationUsd: 100,
    status: "ACTIVE",
    evidence: {
      status: "FORWARD_TESTING",
      completedTrades: 0,
      observationDays: 0,
      source: "CopyLab stock PAPER ledger and official paper-market feed",
      methodology: "Signals, fills, equity, and labeled outcomes are recorded independently from crypto research.",
      limitations: ["IEX paper data and simulated fills may differ materially from live consolidated-market execution."],
      updatedAt: CATALOG_CREATED_AT
    }
  }),
  pilot({
    id: "pilot:thematic-trend-basket",
    slug: "thematic-trend-basket",
    name: "Thematic Trend Basket",
    shortDescription: "A proposed research model for themes such as AI, clean energy, or biotech.",
    longDescription: "A catalog-only thematic concept. CopyLab does not yet implement constituent ingestion, versioned rebalances, or an enrollable PAPER engine for this model.",
    kind: "THEMATIC",
    assetClass: "US_EQUITIES",
    riskLevel: "HIGH",
    dataCadence: "DAILY",
    tags: ["themes", "basket", "stocks"],
    liveCapability: "OFFICIAL_CONNECTOR_REQUIRED",
    automaticMirroring: false,
    minimumPaperAllocationUsd: 100,
    status: "RESEARCH_ONLY",
    evidence: {
      status: "LIMITED",
      completedTrades: 0,
      observationDays: 0,
      source: "CopyLab rules-based PAPER basket",
      methodology: "Proposed methodology: versioned constituents and deterministic rebalance targets would be evaluated in an isolated virtual account after an execution model is implemented.",
      limitations: ["Theme labels are research classifications and do not establish diversification or suitability."],
      updatedAt: CATALOG_CREATED_AT
    }
  }),
  pilot({
    id: "pilot:hedge-fund-13f-tracker",
    slug: "hedge-fund-13f-tracker",
    name: "Hedge Fund 13F Research",
    shortDescription: "A proposed research model for institutional holdings disclosed in public filings.",
    longDescription: "A catalog-only 13F concept. CopyLab does not yet ingest filings or run an enrollable PAPER engine for this model, and filings must never be described as real-time manager trades.",
    kind: "REGULATORY_TRACKER",
    assetClass: "US_EQUITIES",
    riskLevel: "HIGH",
    dataCadence: "REGULATORY_DELAYED",
    tags: ["13F", "institutional holdings", "delayed"],
    liveCapability: "OFFICIAL_CONNECTOR_REQUIRED",
    automaticMirroring: false,
    minimumPaperAllocationUsd: 100,
    status: "RESEARCH_ONLY",
    evidence: {
      status: "DELAYED_SOURCE",
      completedTrades: 0,
      observationDays: 0,
      source: "Public regulatory filings",
      methodology: "Proposed methodology: published holdings would become a versioned PAPER target only after filing ingestion and validation are implemented.",
      limitations: ["13F filings are delayed, omit some instruments and shorts, and do not reveal exact trade dates."],
      updatedAt: CATALOG_CREATED_AT
    }
  }),
  pilot({
    id: "pilot:politician-disclosure-tracker",
    slug: "politician-disclosure-tracker",
    name: "Public Official Disclosure Research",
    shortDescription: "A proposed research model for securities transactions reported in public disclosures.",
    longDescription: "A catalog-only public-disclosure concept. CopyLab does not yet ingest disclosures, record their latency, or run an enrollable PAPER engine for this model.",
    kind: "REGULATORY_TRACKER",
    assetClass: "US_EQUITIES",
    riskLevel: "VERY_HIGH",
    dataCadence: "REGULATORY_DELAYED",
    tags: ["public disclosures", "delayed", "stocks"],
    liveCapability: "NOT_SUPPORTED",
    automaticMirroring: false,
    minimumPaperAllocationUsd: 100,
    status: "RESEARCH_ONLY",
    evidence: {
      status: "DELAYED_SOURCE",
      completedTrades: 0,
      observationDays: 0,
      source: "Public transaction disclosures",
      methodology: "Proposed methodology: disclosed value ranges would become conservative, versioned PAPER assumptions after ingestion and validation are implemented.",
      limitations: ["Disclosures can be delayed and report value ranges rather than exact prices or quantities."],
      updatedAt: CATALOG_CREATED_AT
    }
  })
] as const;

export const BUILT_IN_MARKETPLACE_BROKERS: readonly MarketplaceBrokerCapability[] = [
  {
    id: "COPYLAB_PAPER",
    name: "CopyLab Isolated PAPER",
    officialApiOnly: true,
    supportedAssetClasses: ["CRYPTO", "US_EQUITIES"],
    paperExecutionSupported: true,
    liveExecutionSupported: false,
    automaticOrderSubmissionEnabled: false,
    authentication: "NONE",
    connectionStatus: "CONNECTED",
    message: "Local isolated simulation ledger; no external funds or orders."
  },
  {
    id: "ALPACA_PAPER",
    name: "Alpaca Paper",
    officialApiOnly: true,
    supportedAssetClasses: ["US_EQUITIES"],
    paperExecutionSupported: true,
    liveExecutionSupported: false,
    automaticOrderSubmissionEnabled: false,
    authentication: "API_KEYS",
    connectionStatus: "NOT_CONFIGURED",
    message: "Official paper credentials may supply stock PAPER data; marketplace order submission remains disabled."
  },
  {
    id: "SCHWAB_TRADER_API",
    name: "Schwab Trader API",
    officialApiOnly: true,
    supportedAssetClasses: ["US_EQUITIES"],
    paperExecutionSupported: false,
    liveExecutionSupported: false,
    automaticOrderSubmissionEnabled: false,
    authentication: "OAUTH",
    connectionStatus: "OFFICIAL_ACCESS_REQUIRED",
    message: "No connector is active. An approved official application and explicit live authorization would be required."
  },
  {
    id: "ROBINHOOD_EQUITIES",
    name: "Robinhood Agentic Trading",
    officialApiOnly: true,
    supportedAssetClasses: ["US_EQUITIES"],
    paperExecutionSupported: false,
    liveExecutionSupported: false,
    automaticOrderSubmissionEnabled: false,
    authentication: "OAUTH",
    connectionStatus: "NOT_CONFIGURED_LIVE_LOCKED",
    message: "No Robinhood connector or setup flow is implemented in CopyLab. The service is not connected, and all live routing remains locked."
  },
  {
    id: "ROBINHOOD_CRYPTO",
    name: "Robinhood Crypto",
    officialApiOnly: true,
    supportedAssetClasses: ["CRYPTO"],
    paperExecutionSupported: false,
    liveExecutionSupported: false,
    automaticOrderSubmissionEnabled: false,
    authentication: "API_KEYS",
    connectionStatus: "NOT_CONFIGURED_LIVE_LOCKED",
    message: "Official crypto access is not configured and live routing remains locked; marketplace simulation stays internal PAPER."
  }
] as const;

export const MARKETPLACE_DISCLOSURES = [...COMMON_DISCLOSURES] as const;
