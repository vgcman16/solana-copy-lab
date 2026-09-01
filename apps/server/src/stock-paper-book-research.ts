import type {
  StockPaperBookResearchHypothesis,
  StockPaperBookResearchSource,
  StockPaperBookResearchSummary
} from "@copylab/shared";
import { FROZEN_STOCK_PAPER_SHADOW_POLICIES_V3 } from "./stock-paper-learning-v3.js";
import {
  STOCK_PAPER_BOOK_RESEARCH_VERSION,
  STOCK_PAPER_BOOK_SHADOW_HYPOTHESES,
  STOCK_PAPER_BOOK_SHADOW_MANIFEST_DIGEST,
  STOCK_PAPER_BOOK_SHADOW_SOURCE_IDENTITIES,
  stockPaperBookPublicIdentityDigest
} from "./stock-paper-book-shadow-manifest.js";

export { STOCK_PAPER_BOOK_RESEARCH_VERSION } from "./stock-paper-book-shadow-manifest.js";

/**
 * Curated, paraphrased research mappings from user-provided books.
 *
 * This module deliberately contains no order, sizing, promotion, or broker
 * dependency. Compatible ideas become frozen shadow hypotheses; incompatible
 * or currently untestable claims stay visible instead of being smuggled into
 * the strategy as assumed truth.
 */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

type StockPaperBookSourceWithoutIdentity =
  StockPaperBookResearchSource extends infer Source
    ? Source extends unknown
      ? Omit<Source, "sha256">
      : never
    : never;

function registerPublicBookSource(
  source: StockPaperBookSourceWithoutIdentity
): StockPaperBookResearchSource {
  return {
    ...source,
    sha256: stockPaperBookPublicIdentityDigest(source)
  };
}

const SOURCES: StockPaperBookResearchSource[] = [
  registerPublicBookSource({
    id: "FALCON_METHOD",
    title: "The Falcon Method: A Proven System for Building Passive Income and Wealth Through Stock Investing",
    author: "David Solyomi",
    format: "PDF",
    userProvided: true,
    contentCopied: false,
    reviewStatus: "CURATED",
    researchEligible: true,
    reviewNote: "Useful only for slow fundamental context and eligibility ordering; its long-horizon rules are excluded from intraday features."
  }),
  registerPublicBookSource({
    id: "INVESTING_1X1",
    title: "Stock Market Investing 1x1: The Complete Wealth Creation Guide",
    author: "Andrew P. Hammond",
    format: "EPUB",
    userProvided: true,
    contentCopied: false,
    reviewStatus: "CURATED",
    researchEligible: true,
    reviewNote: "Journaling, screening, liquidity, and source-validation concepts are usable as hypotheses; calculation errors and broad claims are excluded."
  }),
  registerPublicBookSource({
    id: "INVESTING_BIBLE",
    title: "Stock Market Investing Bible, 6 Books in 1",
    author: "Mark Zuckerman",
    format: "PDF",
    userProvided: true,
    contentCopied: false,
    reviewStatus: "CURATED",
    researchEligible: true,
    reviewNote: "Only pre-trade discipline, cost evidence, same-clock benchmarking, and counterfactual concepts are mapped; stale picks and speculative claims are excluded."
  }),
  registerPublicBookSource({
    id: "FIRST_PORTFOLIO",
    title: "From Zero to Your First Portfolio",
    author: "EquityEdge Analysis (Sahil Gandhi)",
    format: "PDF",
    userProvided: true,
    contentCopied: false,
    reviewStatus: "CURATED",
    researchEligible: true,
    reviewNote: "Adds concentration and discipline provenance but no defensible new intraday entry, sizing, or exit rule."
  }),
  registerPublicBookSource({
    id: "DAY_TRADE_LIVING",
    title: "How to Day Trade for a Living: Trading Strategies and Tactics to Consistently Earn Passive Income in Any Market",
    author: "Bryan Lee",
    format: "PDF",
    userProvided: true,
    contentCopied: false,
    reviewStatus: "CAUTION",
    researchEligible: true,
    reviewNote: "Indicator ideas may propose objective ablations, but income promises, anecdotes, cross-asset generalizations, and leverage claims carry no evidentiary weight."
  }),
  registerPublicBookSource({
    id: "BOOK_OF_QUESTIONS",
    title: "The Book of Questions",
    author: "Gregory Stock, Ph.D.",
    format: "EPUB",
    userProvided: true,
    contentCopied: false,
    reviewStatus: "QUARANTINED",
    researchEligible: false,
    reviewNote: "This is a subjective values-and-dilemmas book, not a market research source; personal answers cannot become features, rewards, or risk sizing."
  }),
  registerPublicBookSource({
    id: "STOCK_STRATEGY_BUNDLE",
    title: "Stock Trading Strategy: 3-Book Bundle",
    author: "Prof. Tyler Yamazaki",
    format: "EPUB",
    userProvided: true,
    contentCopied: false,
    reviewStatus: "CAUTION",
    researchEligible: true,
    reviewNote: "Only objectively testable risk, journaling, and execution concepts may be mapped; penny-stock promotion and psychology claims are presumed unsafe until disproved."
  }),
  registerPublicBookSource({
    id: "YATES_BEGINNER",
    title: "Stock Market Investing for Beginners",
    author: "Bert Yates",
    format: "EPUB",
    userProvided: true,
    contentCopied: false,
    reviewStatus: "QUARANTINED",
    researchEligible: false,
    reviewNote: "The EPUB package metadata names this stock book, but every XHTML title names an unrelated trigger-point therapy book; no policy mapping is allowed without a clean source."
  }),
  registerPublicBookSource({
    id: "LIVMOR_OPTIONS",
    title: "Stock Market Books: 3 in 1",
    author: "Gimm Livmor",
    format: "PDF",
    userProvided: true,
    contentCopied: false,
    reviewStatus: "CAUTION",
    researchEligible: true,
    reviewNote: "Options, employee-equity, tax, margin, and promotional performance material are out of scope; only independently testable stock-risk concepts may be referenced."
  }),
  registerPublicBookSource({
    id: "RAYMOND_MULTI_ASSET",
    title: "Stock Market Investing for Beginners: 6 Books in 1",
    author: "Dave Raymond",
    format: "EPUB",
    userProvided: true,
    contentCopied: false,
    reviewStatus: "CAUTION",
    researchEligible: true,
    reviewNote: "This multi-asset compilation is restricted to clearly identified stock/day-trading sections; forex, options, swing, and crypto material cannot cross market or horizon boundaries."
  }),
  registerPublicBookSource({
    id: "PRICE_ACTION_TRADING",
    title: "Price Action Trading",
    author: "Indrazith Shantharaj",
    format: "PDF",
    userProvided: true,
    contentCopied: false,
    reviewStatus: "CAUTION",
    researchEligible: true,
    reviewNote: "Price, volume, acceptance, and rejection concepts may propose objective ablations only after every visual pattern is converted into causal mathematics."
  }),
  registerPublicBookSource({
    id: "NAKED_TRADER_STRATEGIES",
    title: "The Naked Trader's Book of Trading Strategies",
    author: "Robbie Burns",
    format: "EPUB",
    userProvided: true,
    contentCopied: false,
    reviewStatus: "CAUTION",
    researchEligible: true,
    reviewNote: "Potentially useful planning, stop, patience, confirmation-bias, and quality-plus-momentum ideas require objective definitions; gambling and spread-betting material is excluded."
  }),
  registerPublicBookSource({
    id: "RAY_BEARS_OPTIONS",
    title: "Stock Market Investing for Beginners: 3 Books in 1",
    author: "Ray Bears",
    format: "EPUB",
    userProvided: true,
    contentCopied: false,
    reviewStatus: "CAUTION",
    researchEligible: true,
    reviewNote: "Options and forex content is outside the lane; only clearly separated stock execution and risk claims may propose analysis-only tests."
  }),
  registerPublicBookSource({
    id: "TAYLOR_TRADING_BIBLE",
    title: "Trading Bible: 4 Books in 1",
    author: "Alexander Taylor",
    format: "EPUB",
    userProvided: true,
    contentCopied: false,
    reviewStatus: "CAUTION",
    researchEligible: true,
    reviewNote: "The multi-asset compilation may support pre-trade and bias hypotheses, but unsupported expert, high-profit, and cross-market claims are excluded."
  }),
  registerPublicBookSource({
    id: "OPTIONS_MADE_EASY",
    title: "Options Trading Made Easy: 3+1 Books in 1",
    author: "Josh Swing",
    format: "EPUB",
    userProvided: true,
    contentCopied: false,
    reviewStatus: "CAUTION",
    researchEligible: true,
    reviewNote: "Options payoff and leverage claims cannot enter the stock lane; stock/day sections remain hypothesis-only and require independent causal evidence."
  }),
  registerPublicBookSource({
    id: "DAY_ENTRIES_EXITS_2024",
    title: "Day Trading Entries and Exits",
    author: "David Harnett",
    format: "PDF",
    userProvided: true,
    contentCopied: false,
    reviewStatus: "CAUTION",
    researchEligible: true,
    reviewNote: "Third-party TradingView and AI-labeled indicators require exact source code, version hashes, repaint/lookahead audits, and frozen parameters before any causal replay."
  }),
  registerPublicBookSource({
    id: "MEAN_REVERSION_HANDBOOK",
    title: "Mean Reversion Day Trading Handbook",
    author: "David Harnett",
    format: "PDF",
    userProvided: true,
    contentCopied: false,
    reviewStatus: "CAUTION",
    researchEligible: true,
    reviewNote: "Mean-reversion concepts may seed a separately frozen shadow challenger; high-win-rate framing, cross-asset claims, hindsight examples, and unfrozen indicator settings are not evidence."
  }),
  registerPublicBookSource({
    id: "BREAKOUT_TRADING_SHANTHARAJ",
    title: "How to Make Money With Breakout Trading",
    author: "Indrazith Shantharaj",
    format: "PDF",
    userProvided: true,
    contentCopied: false,
    reviewStatus: "CAUTION",
    researchEligible: true,
    reviewNote: "Breakout candle, follow-through, opposing-wick, volume, and consolidation ideas require causal mathematical definitions; chart anecdotes, smart-money labels, options material, and profit framing are not evidence."
  })
];

const HYPOTHESES: StockPaperBookResearchHypothesis[] = [
  {
    id: "IMMUTABLE_TRADE_CONTRACT",
    label: "Pre-commit every simulated trade",
    status: "ACTIVE_EVIDENCE",
    summary: "Capture the signal, entry, size, stop, target, holding limit, quote, and strategy version before a PAPER order is evaluated.",
    implementation: "CopyLab already stores an immutable entry context plus append-only order lifecycle evidence; the book audit now records why that evidence matters.",
    sources: [
      { sourceId: "INVESTING_BIBLE", locator: "PDF pp. 24, 209-210" },
      { sourceId: "INVESTING_1X1", locator: "EPUB ch. 1" }
    ],
    analysisOnly: true,
    affectsTrading: false,
    promotionEligible: false
  },
  {
    id: "SAME_CLOCK_SPY_BENCHMARK",
    label: "Measure alpha on the same clock",
    status: "ACTIVE_EVIDENCE",
    summary: "Compare each realized stock interval with SPY over the identical timestamps and after modeled costs.",
    implementation: "The v4 ledger reports notional-weighted SPY excess without presenting it as a portfolio backtest or forecast.",
    sources: [{ sourceId: "INVESTING_BIBLE", locator: "PDF pp. 80-87" }],
    analysisOnly: true,
    affectsTrading: false,
    promotionEligible: false
  },
  {
    id: "COUNTERFACTUAL_CHALLENGERS",
    label: "Preserve alternative decisions",
    status: "ACTIVE_EVIDENCE",
    summary: "Replay fixed alternatives on the same causal evidence so one winning story cannot erase losing or no-trade outcomes.",
    implementation: "The shadow-policy arena and 1,000-policy replay retain independent, cost-adjusted counterfactual paths without treating correlated variants as extra trades.",
    sources: [
      { sourceId: "INVESTING_BIBLE", locator: "PDF pp. 211-218" },
      { sourceId: "INVESTING_1X1", locator: "EPUB chs. 1, 8" }
    ],
    analysisOnly: true,
    affectsTrading: false,
    promotionEligible: false
  },
  {
    id: "ELIGIBILITY_BEFORE_RANKING",
    label: "Eligibility before ranking",
    status: "ACTIVE_EVIDENCE",
    summary: "Reject stale, unsafe, illiquid, or excessively costly observations before comparing relative signal scores.",
    implementation: "The existing PAPER policy records hard-safety evidence before the candidate can enter any learning dataset.",
    sources: [
      { sourceId: "FALCON_METHOD", locator: "PDF pp. 52-68" },
      { sourceId: "FIRST_PORTFOLIO", locator: "physical PDF pp. 41-44" }
    ],
    analysisOnly: true,
    affectsTrading: false,
    promotionEligible: false
  },
  ...STOCK_PAPER_BOOK_SHADOW_HYPOTHESES,
  {
    id: "OBJECTIVE_INDICATOR_ABLATIONS",
    label: "Objective indicator ablations",
    status: "DATA_REQUIRED",
    summary: "Test moving-average, crossover, breakout, and RSI features as separately frozen challengers rather than mixing contradictory trend and mean-reversion stories.",
    implementation: "Blocked until each formula, lookback, warm-up window, bar clock, parameter grid, and missing-bar behavior is pre-registered and reproduced from causal minute bars.",
    sources: [
      { sourceId: "DAY_TRADE_LIVING", locator: "physical PDF pp. 58-99" },
      { sourceId: "STOCK_STRATEGY_BUNDLE", locator: "EPUB day-trading chs. 5-6" },
      { sourceId: "RAYMOND_MULTI_ASSET", locator: "EPUB day-trading chs. 5-9, 12-15" }
    ],
    analysisOnly: true,
    affectsTrading: false,
    promotionEligible: false,
    requiredData: [
      "causal adjusted minute-bar warm-up history",
      "versioned indicator formulas",
      "pre-registered parameter ranges",
      "session-specific missing-bar rules",
      "purged walk-forward folds",
      "multiple-testing correction"
    ]
  },
  {
    id: "BREAKOUT_QUALITY_AND_FAILURE_LABELS",
    label: "Causal breakout-quality and failure labels",
    status: "DATA_REQUIRED",
    summary: "Translate breakout size, speed, opposing wick, relative volume, and prior consolidation into frozen numeric features, then score follow-through and false-break outcomes on the same causal clock.",
    implementation: "Blocked until resistance formation, candle geometry, volume baselines, follow-through windows, and failed-break labels are immutable and independent of future bars.",
    sources: [
      { sourceId: "BREAKOUT_TRADING_SHANTHARAJ", locator: "physical PDF pp. 23-36, 39-49, 90-95, 158-161" },
      { sourceId: "PRICE_ACTION_TRADING", locator: "physical PDF pp. 23-33, 61, 81-88; pp. 89-91 explicitly excluded" }
    ],
    analysisOnly: true,
    affectsTrading: false,
    promotionEligible: false,
    requiredData: [
      "pre-registered resistance formation window",
      "ATR-normalized candle body and range",
      "upper-wick-to-range ratio",
      "causal same-clock relative-volume baseline",
      "time-to-follow-through window",
      "failed-break and retest labels",
      "split, halt, and corporate-action-safe bars",
      "purged walk-forward evaluation with multiple-testing correction"
    ]
  },
  {
    id: "OPENING_RANGE_BREAKOUT_ABLATION",
    label: "Opening-range breakout ablation",
    status: "DATA_REQUIRED",
    summary: "Compare a frozen regular-session opening-range breakout with an unrestricted momentum control and label weak follow-through and false breaks explicitly.",
    implementation: "The source's 60-minute range and 15-minute breakout-candle fragments are test candidates, not defaults; entry, exit, auction, halt, and wick geometry must be pre-registered first.",
    sources: [{ sourceId: "BREAKOUT_TRADING_SHANTHARAJ", locator: "physical PDF pp. 90-95" }],
    analysisOnly: true,
    affectsTrading: false,
    promotionEligible: false,
    requiredData: ["regular-session and auction boundaries", "causal 15-minute bars", "frozen opening-range duration challengers", "ATR-normalized wick and body geometry", "standardized exit policies", "halts and realistic fills", "purged walk-forward evaluation"]
  },
  {
    id: "BREAKOUT_EXECUTION_COUNTERFACTUALS",
    label: "Breakout execution counterfactuals",
    status: "DATA_REQUIRED",
    summary: "Replay next-session triggers, gap/chase cutoffs, candle-based stops, fixed reward-to-risk exits, partial exits, and weak-follow-through exits from one immutable signal.",
    implementation: "Blocked until every variant shares the same causal signal, capital, fill clock, and cost model; selected chart outcomes cannot choose the winning exit after the fact.",
    sources: [{ sourceId: "BREAKOUT_TRADING_SHANTHARAJ", locator: "physical PDF pp. 35-49" }],
    analysisOnly: true,
    affectsTrading: false,
    promotionEligible: false,
    requiredData: ["opening auction and gap fills", "within-bar stop and target ordering", "partial-fill and slippage model", "shared-capital counterfactual engine", "frozen follow-through windows", "multiple-testing correction"]
  },
  {
    id: "RANGE_BOUND_REJECTION_ABLATION",
    label: "Causal range-bound rejection ablation",
    status: "DATA_REQUIRED",
    summary: "Test a lower-bound rejection defined entirely from prior bars against an unconditional boundary touch and the existing VWAP-reclaim shadow challenger.",
    implementation: "Blocked until support zones, touch count, rejection-candle geometry, confirmation, and failure are numeric and immutable before the entry clock.",
    sources: [
      { sourceId: "PRICE_ACTION_TRADING", locator: "physical PDF pp. 49-57" },
      { sourceId: "NAKED_TRADER_STRATEGIES", locator: "EPUB section 34" }
    ],
    analysisOnly: true,
    affectsTrading: false,
    promotionEligible: false,
    requiredData: ["pre-registered range lookback", "prior-bar-only support zone", "ATR-normalized zone and candle geometry", "touch-count policy", "boundary failure label", "same-clock SPY excess at frozen horizons", "corporate-action-safe bars"]
  },
  {
    id: "WINNER_ONLY_TRANCHE_ADDITION",
    label: "Winner-only tranche addition",
    status: "DATA_REQUIRED",
    summary: "Compare one-shot entry with one fixed add-on allowed only after the original PAPER lot is profitable and a causal momentum confirmation recurs.",
    implementation: "Total exposure and risk-at-stop must remain identical across variants; averaging down, margin, and anecdotal thresholds remain prohibited.",
    sources: [{ sourceId: "NAKED_TRADER_STRATEGIES", locator: "EPUB section 46" }],
    analysisOnly: true,
    affectsTrading: false,
    promotionEligible: false,
    requiredData: ["lot- and tranche-level lifecycle", "shared cash and exposure cap", "causal repeat-confirmation clock", "per-tranche stop evidence", "partial-fill costs", "portfolio-level counterfactual replay"]
  },
  {
    id: "PARTIAL_EXIT_TRAILING_REMAINDER",
    label: "Partial exit and trailing-remainder ablation",
    status: "DATA_REQUIRED",
    summary: "Compare the existing all-or-nothing lifecycle with frozen partial-exit paths whose remainder uses an objective causal trailing rule.",
    implementation: "Blocked until within-bar ordering, partial fills, shared capital, and a non-subjective trailing definition can be reproduced without hindsight.",
    sources: [
      { sourceId: "PRICE_ACTION_TRADING", locator: "physical PDF pp. 59-60, 69, 72, 75" },
      { sourceId: "BREAKOUT_TRADING_SHANTHARAJ", locator: "physical PDF pp. 46-49" }
    ],
    analysisOnly: true,
    affectsTrading: false,
    promotionEligible: false,
    requiredData: ["within-bar stop and target ordering", "partial-fill and slippage evidence", "lot accounting", "causal ATR or swing trail", "shared-capital occupancy", "turnover and tail-loss outcomes"]
  },
  {
    id: "CORPORATE_ACTION_GAP_STOP_REALISM",
    label: "Corporate-action and gap-aware stop realism",
    status: "DATA_REQUIRED",
    summary: "Measure how dividends, splits, overnight gaps, halts, and opening auctions change an intended stop versus the executable PAPER fill.",
    implementation: "This is simulator validation, not alpha; an assumed fill at the stop price is invalid whenever the market gaps or cannot trade there.",
    sources: [{ sourceId: "NAKED_TRADER_STRATEGIES", locator: "EPUB sections 6 and 31" }],
    analysisOnly: true,
    affectsTrading: false,
    promotionEligible: false,
    requiredData: ["point-in-time split and dividend events", "adjusted and unadjusted prices", "opening auction trades and NBBO", "halts", "no-fill behavior", "gap slippage distribution"]
  },
  {
    id: "THIRD_PARTY_INDICATOR_REPRODUCIBILITY_GATE",
    label: "Third-party indicator reproducibility gate",
    status: "DATA_REQUIRED",
    summary: "Treat public chart scripts and AI-labeled indicators as untrusted code until their exact version, source, parameters, causal clock, and repaint behavior are frozen and audited.",
    implementation: "No TradingView result, screenshot, optimized setting, or named machine-learning indicator may enter the learner from a chart alone.",
    sources: [
      { sourceId: "DAY_ENTRIES_EXITS_2024", locator: "physical PDF pp. 4-10 and indicator chapters 2-7" },
      { sourceId: "MEAN_REVERSION_HANDBOOK", locator: "physical PDF chs. 3-6" }
    ],
    analysisOnly: true,
    affectsTrading: false,
    promotionEligible: false,
    requiredData: ["exact source code", "content and version hash", "license and dependency versions", "repaint and lookahead audit", "frozen parameters", "causal input bars", "purged walk-forward evaluation"]
  },
  {
    id: "FROZEN_SPECIALIST_UNIVERSE",
    label: "Frozen specialist-universe comparison",
    status: "DATA_REQUIRED",
    summary: "Compare a point-in-time liquid specialist universe with the broad changing scanner without allowing hindsight-selected symbols.",
    implementation: "Blocked until formation timestamps, delisted controls, minimum symbol/regime samples, and an immutable universe-version ledger are available.",
    sources: [
      { sourceId: "INVESTING_BIBLE", locator: "PDF pp. 207-210" },
      { sourceId: "INVESTING_1X1", locator: "EPUB ch. 5" },
      { sourceId: "STOCK_STRATEGY_BUNDLE", locator: "EPUB day-trading chs. 2-3" }
    ],
    analysisOnly: true,
    affectsTrading: false,
    promotionEligible: false,
    requiredData: ["point-in-time universe formation", "delisted-symbol controls", "symbol-regime sample minimums", "frozen universe versions"]
  },
  {
    id: "SLOW_FUNDAMENTAL_OVERLAY",
    label: "Slow point-in-time fundamental overlay",
    status: "DATA_REQUIRED",
    summary: "Evaluate cash generation, capital efficiency, dilution, leverage, dividends, and valuation against each company's own history only as slow universe context.",
    implementation: "Blocked until survivorship-safe, timestamped fundamentals exist; it must remain an isolated ablation and never explain a five-minute move.",
    sources: [
      { sourceId: "FALCON_METHOD", locator: "PDF pp. 21-24, 41-59, 71-76, 88-89" },
      { sourceId: "NAKED_TRADER_STRATEGIES", locator: "EPUB sections 4, 18, 36, and 39" }
    ],
    analysisOnly: true,
    affectsTrading: false,
    promotionEligible: false,
    requiredData: [
      "point-in-time free-cash-flow yield",
      "point-in-time ROIC",
      "share-count dilution",
      "net-debt movement",
      "dividend and split adjustments",
      "historical valuation without survivorship bias"
    ]
  },
  {
    id: "SOURCE_AWARE_NEWS",
    label: "Source-aware news evidence",
    status: "DATA_REQUIRED",
    summary: "Separate publication time from event time and test novelty, ticker confidence, source identity, and independent confirmation.",
    implementation: "Article identifiers are already frozen, but source lineage and event timestamps are not yet complete enough for a causal feature.",
    sources: [
      { sourceId: "INVESTING_BIBLE", locator: "PDF pp. 20-21, 29-30" },
      { sourceId: "INVESTING_1X1", locator: "EPUB ch. 5" },
      { sourceId: "STOCK_STRATEGY_BUNDLE", locator: "EPUB B1 Ch5 part0000_split_010.html and B3 Chs. 4-5 part0000_split_034-035.html" },
      { sourceId: "NAKED_TRADER_STRATEGIES", locator: "EPUB section 10; only lawful public issuer releases" }
    ],
    analysisOnly: true,
    affectsTrading: false,
    promotionEligible: false,
    requiredData: ["publisher identity", "authoritative publication time", "original issuer filing text", "event time", "novelty", "ticker confidence", "point-in-time consensus vintage", "independent confirmation", "issuer or promoter relationship", "paid-promotion disclosure"]
  },
  {
    id: "OTC_DISCLOSURE_AND_ISSUER_RISK_GATE",
    label: "Venue, disclosure, and issuer-risk gate",
    status: "DATA_REQUIRED",
    summary: "Measure whether OTC venue, sparse reporting, paid promotion, reverse splits, acute dilution, going-concern language, or bankruptcy evidence predicts worse executable outcomes and halts.",
    implementation: "Blocked until every issuer and event field is point-in-time. It is a proposed safety ablation, never a strategy for joining a promotion or distressed move.",
    sources: [{ sourceId: "STOCK_STRATEGY_BUNDLE", locator: "EPUB B3 Chs. 1, 3-5; part0000_split_031, 033-035.html" }],
    analysisOnly: true,
    affectsTrading: false,
    promotionEligible: false,
    requiredData: ["point-in-time venue", "reporting status", "market cap", "issuer filings", "reverse-split timestamps", "offering and dilution events", "going-concern or bankruptcy flags", "halts and suspensions"]
  },
  {
    id: "POST_EARNINGS_EVENT_MOMENTUM",
    label: "Confirmed post-earnings momentum",
    status: "DATA_REQUIRED",
    summary: "Compare post-release, high-volume momentum with matched non-event observations at the same causal horizons and costs.",
    implementation: "The event must be public and timestamped before the observation; scheduled time, actual release time, surprise, and news lineage cannot be inferred after the fact.",
    sources: [
      { sourceId: "STOCK_STRATEGY_BUNDLE", locator: "EPUB B2 Ch1 part0000_split_018.html#Ch1" },
      { sourceId: "DAY_TRADE_LIVING", locator: "physical PDF pp. 60-62, 99, 106-110; post-publication only" },
      { sourceId: "NAKED_TRADER_STRATEGIES", locator: "EPUB sections 10 and 13" }
    ],
    analysisOnly: true,
    affectsTrading: false,
    promotionEligible: false,
    requiredData: ["scheduled earnings time", "actual public release time", "session", "point-in-time consensus", "reported result", "exact public issuer language", "pre-event run-up", "event-linked causal quotes and bars"]
  },
  {
    id: "MICROCAP_EXIT_FEASIBILITY_STRESS",
    label: "Sparse-bid and halt exit stress",
    status: "DATA_REQUIRED",
    summary: "Estimate partial-fill, no-fill, adverse-selection, halt, and exit-slippage risk instead of assuming a displayed microcap spread is executable size.",
    implementation: "Current spread, dollar-volume, and participation limits are not a depth or queue model; no microcap conclusion is allowed without executable market-structure evidence.",
    sources: [{ sourceId: "STOCK_STRATEGY_BUNDLE", locator: "EPUB B3 Chs. 2-4; part0000_split_032-034.html" }],
    analysisOnly: true,
    affectsTrading: false,
    promotionEligible: false,
    requiredData: ["historical NBBO or depth", "executable size", "venue", "quote age", "halts", "queue and participation assumptions", "fees and borrow constraints"]
  },
  {
    id: "THIRTY_SESSION_VOLUME_BASELINE",
    label: "Split-adjusted 30-session volume baseline",
    status: "DATA_REQUIRED",
    summary: "Compare current one-day relative-volume evidence with a split-adjusted, same-clock 30-session baseline.",
    implementation: "Blocked until the baseline is formed from immutable historical sessions with corporate-action corrections and no future membership leakage.",
    sources: [{ sourceId: "STOCK_STRATEGY_BUNDLE", locator: "EPUB B2 Ch1 and B3 Ch5; part0000_split_018 and 035.html" }],
    analysisOnly: true,
    affectsTrading: false,
    promotionEligible: false,
    requiredData: ["30 prior eligible sessions", "split adjustments", "same-clock cumulative volume", "missing-session policy", "point-in-time symbol eligibility"]
  },
  {
    id: "PORTFOLIO_RISK_SIZING_ABLATION",
    label: "Portfolio risk-at-stop sizing ablation",
    status: "DATA_REQUIRED",
    summary: "Compare frozen risk-at-stop and reward-to-risk tiers as a true capital-constrained portfolio counterfactual rather than multiplying independent trade returns.",
    implementation: "Blocked until one simulator enforces shared cash, simultaneous positions, rejected orders, slippage, and drawdown stops across every variant.",
    sources: [
      { sourceId: "STOCK_STRATEGY_BUNDLE", locator: "EPUB B2 Chs. 2, 4; part0000_split_019 and 021.html" },
      { sourceId: "PRICE_ACTION_TRADING", locator: "physical PDF pp. 93-94; leverage shortcut excluded" }
    ],
    analysisOnly: true,
    affectsTrading: false,
    promotionEligible: false,
    requiredData: ["shared-capital portfolio simulator", "simultaneous-position ordering", "causal reject/no-fill evidence", "cost and slippage model", "drawdown and daily-stop state"]
  },
  {
    id: "SECTOR_EXCESS_BENCHMARK",
    label: "Same-clock sector benchmark",
    status: "DATA_REQUIRED",
    summary: "Compare each trade with a point-in-time sector ETF over the same interval in addition to SPY.",
    implementation: "Blocked until historical sector membership and adjusted sector ETF bars are immutable and aligned to the trade clock.",
    sources: [{ sourceId: "INVESTING_BIBLE", locator: "PDF pp. 80-87" }],
    analysisOnly: true,
    affectsTrading: false,
    promotionEligible: false,
    requiredData: ["point-in-time sector membership", "adjusted sector ETF bars", "corporate-action-safe symbol history"]
  },
  {
    id: "CONCENTRATION_AND_OVERLAP_AUDIT",
    label: "Position concentration and overlap audit",
    status: "DATA_REQUIRED",
    summary: "Measure simultaneous ticker, sector, and return-correlation concentration rather than assuming that a position count alone creates diversification.",
    implementation: "The v4 artifact has a correlation seam, but it remains unavailable until adjusted, aligned return histories and point-in-time sector membership are complete.",
    sources: [{ sourceId: "FIRST_PORTFOLIO", locator: "physical PDF pp. 42, 45-50" }],
    analysisOnly: true,
    affectsTrading: false,
    promotionEligible: false,
    requiredData: ["aligned adjusted returns", "point-in-time sector membership", "simultaneous exposure weights"]
  },
  {
    id: "LONG_TERM_RULES_AS_INTRADAY_TRIGGERS",
    label: "Long-term portfolio rules as intraday triggers",
    status: "EXCLUDED",
    summary: "Do not use multi-year dividend, valuation, periodic-contribution, or rebalancing concepts to justify minute-level entries, averaging down, or ignoring a stop.",
    implementation: "Permanently excluded from the intraday feature vector.",
    sources: [
      { sourceId: "FALCON_METHOD", locator: "PDF pp. 26-31, 79-81, 85-87" },
      { sourceId: "FIRST_PORTFOLIO", locator: "physical PDF pp. 35-40, 45-58" }
    ],
    analysisOnly: true,
    affectsTrading: false,
    promotionEligible: false,
    exclusionReason: "The source describes a long-horizon buy-and-hold process whose clock and risk assumptions conflict with this intraday PAPER lane."
  },
  {
    id: "DATED_PICKS_LEVERAGE_RUMORS",
    label: "Dated picks, leverage, rumors, and subjective patterns",
    status: "EXCLUDED",
    summary: "Do not ingest old stock selections, margin suggestions, rumor trading, or untestable chart labels as strategy truth.",
    implementation: "Excluded from datasets, policies, and prompts.",
    sources: [
      { sourceId: "INVESTING_BIBLE", locator: "dated examples and speculative sections" },
      { sourceId: "INVESTING_1X1", locator: "unsupported or calculation-error passages" }
    ],
    analysisOnly: true,
    affectsTrading: false,
    promotionEligible: false,
    exclusionReason: "The claims are stale, non-causal, internally inconsistent, or not reproducibly testable with the current data."
  },
  {
    id: "SUBJECTIVE_PERSONAL_RESPONSES_AS_MODEL_INPUTS",
    label: "Subjective personal answers as market inputs",
    status: "EXCLUDED",
    summary: "Do not convert personal values, hypothetical dilemmas, intuition, or self-rated appetite for risk into return labels, market features, or autonomous position sizing.",
    implementation: "The non-market source has a public bibliographic identity for transparency and is quarantined from every stock dataset and policy.",
    sources: [{ sourceId: "BOOK_OF_QUESTIONS", locator: "EPUB introduction and questions 23, 130, 137, 261, 268, 285" }],
    analysisOnly: true,
    affectsTrading: false,
    promotionEligible: false,
    exclusionReason: "The source explicitly presents open-ended dilemmas without correct answers; responses are subjective, private, unstable, and non-causal for markets."
  },
  {
    id: "LEVERAGE_PENNY_OPTIONS_AND_CROSS_ASSET_RULES",
    label: "Leverage, penny-stock, options, and cross-asset shortcuts",
    status: "EXCLUDED",
    summary: "Do not import leverage, margin, penny-stock promotion, options payoff rules, forex systems, or crypto tactics into the isolated US-stock PAPER lane.",
    implementation: "The current lane has no leverage or derivatives model and preserves market/horizon isolation; these topics cannot bypass price, liquidity, spread, or safety gates.",
    sources: [
      { sourceId: "DAY_TRADE_LIVING", locator: "cross-asset and income claims; PDF title and strategy sections" },
      { sourceId: "STOCK_STRATEGY_BUNDLE", locator: "EPUB penny-stock chs. 1-5" },
      { sourceId: "YATES_BEGINNER", locator: "EPUB chs. 11-14; package quarantined" },
      { sourceId: "LIVMOR_OPTIONS", locator: "PDF options, employee-equity, and margin sections" },
      { sourceId: "RAYMOND_MULTI_ASSET", locator: "EPUB forex, options, swing, and crypto books" },
      { sourceId: "PRICE_ACTION_TRADING", locator: "physical PDF pp. 94, 105-107" },
      { sourceId: "NAKED_TRADER_STRATEGIES", locator: "EPUB sections 14, 24, 41-43, and 52" },
      { sourceId: "BREAKOUT_TRADING_SHANTHARAJ", locator: "options, futures, leverage, short-option, and cross-asset sections" }
    ],
    analysisOnly: true,
    affectsTrading: false,
    promotionEligible: false,
    exclusionReason: "These instruments require separate data, execution, payoff, assignment, borrow, margin, and tail-risk models and are outside this lane's declared market."
  },
  {
    id: "MANIPULATION_RUMORS_AND_NONPUBLIC_INFORMATION",
    label: "Manipulation, rumors, and nonpublic information",
    status: "EXCLUDED",
    summary: "Never coordinate promotion, trade issuer or promoter hype as confirmation, or seek information before its lawful public release.",
    implementation: "Permanently excluded from data collection, signals, policies, and counterfactual challengers; only public, provenance-qualified events may be observed.",
    sources: [
      { sourceId: "STOCK_STRATEGY_BUNDLE", locator: "EPUB contradictory pump-and-dump, fake-news, forum, and pre-public-news passages in B1 Ch5 and B3 Ch4" },
      { sourceId: "NAKED_TRADER_STRATEGIES", locator: "EPUB sections 9, 11-12, and 28" }
    ],
    analysisOnly: true,
    affectsTrading: false,
    promotionEligible: false,
    exclusionReason: "The material describes unsafe or manipulative conduct and is incompatible with a lawful, public-data-only research system."
  },
  {
    id: "PERFORMANCE_PROMISES",
    label: "Performance promises",
    status: "EXCLUDED",
    summary: "Do not treat anecdotes, back-cover claims, or author confidence as evidence of future profitability.",
    implementation: "Only causal, cost-adjusted PAPER outcomes can contribute evidence.",
    sources: [
      { sourceId: "FALCON_METHOD", locator: "performance and portfolio claims" },
      { sourceId: "INVESTING_BIBLE", locator: "anecdotal performance claims" },
      { sourceId: "INVESTING_1X1", locator: "oversimplified return claims" },
      { sourceId: "FIRST_PORTFOLIO", locator: "physical PDF pp. 25-29, 37-40, 52-58" },
      { sourceId: "DAY_TRADE_LIVING", locator: "PDF introduction and passive-income framing" },
      { sourceId: "STOCK_STRATEGY_BUNDLE", locator: "promotional and psychology sections" },
      { sourceId: "LIVMOR_OPTIONS", locator: "physical PDF pp. 8-9 and promotional sections" },
      { sourceId: "RAYMOND_MULTI_ASSET", locator: "uncited strategy and success claims" },
      { sourceId: "PRICE_ACTION_TRADING", locator: "physical PDF high-probability and return claims" },
      { sourceId: "NAKED_TRADER_STRATEGIES", locator: "anecdotal returns and certainty claims" },
      { sourceId: "MEAN_REVERSION_HANDBOOK", locator: "high-win-rate framing and hindsight examples" },
      { sourceId: "BREAKOUT_TRADING_SHANTHARAJ", locator: "selected-chart outcomes and performance claims" }
    ],
    analysisOnly: true,
    affectsTrading: false,
    promotionEligible: false,
    exclusionReason: "A claim is not a causal, held-out result and cannot become a trading rule."
  }
];

function count(status: StockPaperBookResearchHypothesis["status"]): number {
  return HYPOTHESES.filter((hypothesis) => hypothesis.status === status).length;
}

const sourceIds = new Set(SOURCES.map((source) => source.id));
if (sourceIds.size !== SOURCES.length) throw new Error("Book research source ids must be unique.");
const hypothesisIds = new Set(HYPOTHESES.map((hypothesis) => hypothesis.id));
if (hypothesisIds.size !== HYPOTHESES.length) throw new Error("Book research hypothesis ids must be unique.");

const sourceById = new Map(SOURCES.map((source) => [source.id, source]));
for (const source of SOURCES) {
  const quarantined = source.reviewStatus === "QUARANTINED";
  if (quarantined === source.researchEligible) {
    throw new Error(`Book source ${source.id} has inconsistent quarantine eligibility.`);
  }
}
for (const [sourceId, sha256] of Object.entries(STOCK_PAPER_BOOK_SHADOW_SOURCE_IDENTITIES)) {
  if (sourceById.get(sourceId)?.sha256 !== sha256) {
    throw new Error(`Book shadow manifest identity ${sourceId} does not match the source registry.`);
  }
}

const policyById = new Map(FROZEN_STOCK_PAPER_SHADOW_POLICIES_V3.map((policy) => [policy.id, policy]));
if (policyById.size !== FROZEN_STOCK_PAPER_SHADOW_POLICIES_V3.length) {
  throw new Error("Stock PAPER shadow policy ids must be unique.");
}
const hypothesisById = new Map(HYPOTHESES.map((hypothesis) => [hypothesis.id, hypothesis]));
const linkedPolicyIds = new Set<string>();
for (const hypothesis of HYPOTHESES) {
  const shadowTesting = hypothesis.status === "SHADOW_TESTING";
  if (shadowTesting !== Boolean(hypothesis.shadowPolicyId)) {
    throw new Error(`Book research hypothesis ${hypothesis.id} has inconsistent shadow linkage.`);
  }
  if (hypothesis.shadowPolicyId) {
    if (linkedPolicyIds.has(hypothesis.shadowPolicyId)) {
      throw new Error(`Book shadow policy ${hypothesis.shadowPolicyId} is linked more than once.`);
    }
    linkedPolicyIds.add(hypothesis.shadowPolicyId);
    const policy = policyById.get(hypothesis.shadowPolicyId);
    if (!policy) {
      throw new Error(`Book research hypothesis ${hypothesis.id} references an unknown shadow policy.`);
    }
    if (policy.researchBasisId !== hypothesis.id ||
        policy.researchManifestDigest !== STOCK_PAPER_BOOK_SHADOW_MANIFEST_DIGEST) {
      throw new Error(`Book shadow policy ${policy.id} does not match its frozen research manifest.`);
    }
  }
  for (const provenance of hypothesis.sources) {
    const source = sourceById.get(provenance.sourceId);
    if (!source) throw new Error(`Book research hypothesis ${hypothesis.id} references an unknown source.`);
    if ((source.reviewStatus === "QUARANTINED" || !source.researchEligible) &&
        hypothesis.status !== "EXCLUDED") {
      throw new Error(`Quarantined book source ${source.id} cannot support a research hypothesis.`);
    }
  }
}
for (const policy of FROZEN_STOCK_PAPER_SHADOW_POLICIES_V3) {
  const hasBasis = policy.researchBasisId !== undefined;
  const hasManifest = policy.researchManifestDigest !== undefined;
  if (hasBasis !== hasManifest) {
    throw new Error(`Stock PAPER shadow policy ${policy.id} has incomplete research provenance.`);
  }
  if (!hasBasis) continue;
  const hypothesis = hypothesisById.get(policy.researchBasisId!);
  if (!hypothesis || hypothesis.status !== "SHADOW_TESTING" ||
      hypothesis.shadowPolicyId !== policy.id ||
      policy.researchManifestDigest !== STOCK_PAPER_BOOK_SHADOW_MANIFEST_DIGEST) {
    throw new Error(`Stock PAPER shadow policy ${policy.id} lacks a one-to-one research hypothesis.`);
  }
}

const SUMMARY = deepFreeze<StockPaperBookResearchSummary>({
  version: STOCK_PAPER_BOOK_RESEARCH_VERSION,
  analysisOnly: true,
  affectsTrading: false,
  promotionEligible: false,
  fingerprintAlgorithm: "SHA-256",
  shadowManifestDigest: STOCK_PAPER_BOOK_SHADOW_MANIFEST_DIGEST,
  policyTestsUseCausalOutcomes: true,
  sourceCount: SOURCES.length,
  curatedSourceCount: SOURCES.filter((source) => source.reviewStatus === "CURATED").length,
  cautionSourceCount: SOURCES.filter((source) => source.reviewStatus === "CAUTION").length,
  quarantinedSourceCount: SOURCES.filter((source) => source.reviewStatus === "QUARANTINED").length,
  activeEvidenceCount: count("ACTIVE_EVIDENCE"),
  shadowTestingCount: count("SHADOW_TESTING"),
  dataRequiredCount: count("DATA_REQUIRED"),
  excludedCount: count("EXCLUDED"),
  sources: SOURCES,
  hypotheses: HYPOTHESES,
  warnings: [
    "Book-derived thresholds are pre-registered CopyLab proxies, not proven rules from the sources.",
    "Long-term fundamental concepts must not be presented as causes of minute-level price moves.",
    "Multiple shadow challengers and small samples can produce false winners; walk-forward evidence remains mandatory.",
    "No book-derived result can alter PAPER orders, sizing, filters, promotion, or live execution."
  ]
});

export function stockPaperBookResearchSummary(): StockPaperBookResearchSummary {
  return SUMMARY;
}
