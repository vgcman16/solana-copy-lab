import { createHash } from "node:crypto";
import type { StockPaperBookResearchHypothesis } from "@copylab/shared";

export const STOCK_PAPER_BOOK_RESEARCH_VERSION = "stock-paper-book-research-v2" as const;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalize(nested)]));
  }
  return value;
}

export interface StockPaperBookPublicIdentity {
  id: string;
  title: string;
  author?: string;
  format: "PDF" | "EPUB";
}

/**
 * Stable public provenance for a bibliographic record. This digest is derived
 * only from metadata committed to the repository; it is deliberately not a
 * checksum of a user's local PDF or EPUB file.
 */
export function stockPaperBookPublicIdentityDigest(
  identity: StockPaperBookPublicIdentity
): string {
  return createHash("sha256")
    .update([
      "copylab-public-book-source-v1",
      identity.id,
      identity.title,
      identity.author ?? "",
      identity.format
    ].join("\0"))
    .digest("hex")
    .toUpperCase();
}

export const STOCK_PAPER_BOOK_SHADOW_SOURCE_IDENTITIES = deepFreeze({
  FALCON_METHOD: stockPaperBookPublicIdentityDigest({
    id: "FALCON_METHOD",
    title: "The Falcon Method: A Proven System for Building Passive Income and Wealth Through Stock Investing",
    author: "David Solyomi",
    format: "PDF"
  }),
  INVESTING_1X1: stockPaperBookPublicIdentityDigest({
    id: "INVESTING_1X1",
    title: "Stock Market Investing 1x1: The Complete Wealth Creation Guide",
    author: "Andrew P. Hammond",
    format: "EPUB"
  }),
  INVESTING_BIBLE: stockPaperBookPublicIdentityDigest({
    id: "INVESTING_BIBLE",
    title: "Stock Market Investing Bible, 6 Books in 1",
    author: "Mark Zuckerman",
    format: "PDF"
  }),
  DAY_TRADE_LIVING: stockPaperBookPublicIdentityDigest({
    id: "DAY_TRADE_LIVING",
    title: "How to Day Trade for a Living: Trading Strategies and Tactics to Consistently Earn Passive Income in Any Market",
    author: "Bryan Lee",
    format: "PDF"
  }),
  MEAN_REVERSION_HANDBOOK: stockPaperBookPublicIdentityDigest({
    id: "MEAN_REVERSION_HANDBOOK",
    title: "Mean Reversion Day Trading Handbook",
    author: "David Harnett",
    format: "PDF"
  })
} as const);

export const STOCK_PAPER_BOOK_SHADOW_HYPOTHESES = deepFreeze<
  readonly StockPaperBookResearchHypothesis[]
>([
  {
    id: "EXECUTION_COST_DISCIPLINE",
    label: "Cost-stressed execution discipline",
    status: "SHADOW_TESTING",
    summary: "Test whether confirmed, liquid, non-extended entries survive a stricter spread and round-trip cost model.",
    implementation: "A frozen shadow challenger adds a 25 bps stress cost and requires two confirmations, controlled VWAP distance, controlled five-minute extension, and at least $25M modeled dollar volume.",
    sources: [
      { sourceId: "INVESTING_BIBLE", locator: "PDF pp. 28-29, 34-36, 207-209" },
      { sourceId: "INVESTING_1X1", locator: "EPUB ch. 4" },
      { sourceId: "FALCON_METHOD", locator: "PDF pp. 26-30" }
    ],
    analysisOnly: true,
    affectsTrading: false,
    promotionEligible: false,
    shadowPolicyId: "BOOK_DISCIPLINED_EXECUTION_PROXY",
    proxyWarning: "These thresholds are CopyLab's pre-registered intraday proxy, not thresholds stated or validated by the books."
  },
  {
    id: "QUALITY_BEFORE_RANKING_PROXY",
    label: "Quality-first liquidity proxy",
    status: "SHADOW_TESTING",
    summary: "Test a stricter tradability subset before relative momentum ranking while true fundamental quality data is unavailable.",
    implementation: "A frozen shadow challenger requires at least $50M modeled dollar volume, tighter spread, two confirmations, controlled extension, and a 30 bps stress cost.",
    sources: [
      { sourceId: "FALCON_METHOD", locator: "PDF pp. 52-68" },
      { sourceId: "INVESTING_1X1", locator: "EPUB ch. 5" }
    ],
    analysisOnly: true,
    affectsTrading: false,
    promotionEligible: false,
    shadowPolicyId: "BOOK_QUALITY_FIRST_LIQUIDITY_PROXY",
    proxyWarning: "Dollar volume and spread measure tradability, not business quality, intrinsic value, or future return."
  },
  {
    id: "MEAN_REVERSION_RECLAIM_PROXY",
    label: "Liquid pullback-reclaim challenger",
    status: "SHADOW_TESTING",
    summary: "Test a long-only, liquid observation that remains below VWAP after a five-minute decline but has begun a one-minute reclaim.",
    implementation: "A frozen shadow challenger requires at least $50M modeled dollar volume, at most 0.55% spread, a five-minute move no higher than -1%, VWAP distance no higher than -0.75%, a positive one-minute reclaim, and 30 bps stress cost.",
    sources: [
      { sourceId: "DAY_TRADE_LIVING", locator: "physical PDF pp. 64-66, 90-95" },
      { sourceId: "MEAN_REVERSION_HANDBOOK", locator: "physical PDF chs. 1-3, especially pp. 6-10" }
    ],
    analysisOnly: true,
    affectsTrading: false,
    promotionEligible: false,
    shadowPolicyId: "BOOK_MEAN_REVERSION_RECLAIM_PROXY",
    proxyWarning: "This is CopyLab's causal VWAP-reclaim proxy, not a claim that RSI, a moving average, or every below-mean price must revert."
  }
]);

export const STOCK_PAPER_BOOK_SHADOW_MANIFEST_DIGEST =
  `stock-paper-book-shadow-manifest-v2:${createHash("sha256")
    .update(JSON.stringify(canonicalize({
      version: STOCK_PAPER_BOOK_RESEARCH_VERSION,
      publicSourceIdentities: STOCK_PAPER_BOOK_SHADOW_SOURCE_IDENTITIES,
      hypotheses: STOCK_PAPER_BOOK_SHADOW_HYPOTHESES
    })))
    .digest("hex")}` as const;
