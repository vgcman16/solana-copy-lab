import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FROZEN_STOCK_PAPER_SHADOW_POLICIES_V3 } from "../src/stock-paper-learning-v3.js";
import {
  STOCK_PAPER_BOOK_RESEARCH_VERSION,
  stockPaperBookResearchSummary
} from "../src/stock-paper-book-research.js";
import { STOCK_PAPER_BOOK_SHADOW_MANIFEST_DIGEST } from "../src/stock-paper-book-shadow-manifest.js";

describe("stock PAPER book research registry", () => {
  it("identifies all user-provided sources from public metadata without copying their text", () => {
    const summary = stockPaperBookResearchSummary();

    expect(summary).toMatchObject({
      version: STOCK_PAPER_BOOK_RESEARCH_VERSION,
      analysisOnly: true,
      affectsTrading: false,
      promotionEligible: false,
      fingerprintAlgorithm: "SHA-256",
      shadowManifestDigest: STOCK_PAPER_BOOK_SHADOW_MANIFEST_DIGEST,
      policyTestsUseCausalOutcomes: true,
      sourceCount: 18,
      curatedSourceCount: 4,
      cautionSourceCount: 12,
      quarantinedSourceCount: 2
    });
    expect(summary.sources.map((source) => source.sha256)).toEqual(
      summary.sources.map((source) => createHash("sha256")
        .update([
          "copylab-public-book-source-v1",
          source.id,
          source.title,
          source.author ?? "",
          source.format
        ].join("\0"))
        .digest("hex")
        .toUpperCase())
    );
    expect(summary.sources.every((source) => source.userProvided && !source.contentCopied)).toBe(true);
    expect(summary.sources.filter((source) => !source.researchEligible)
      .map((source) => source.id)).toEqual(["BOOK_OF_QUESTIONS", "YATES_BEGINNER"]);
    const quarantinedIds = new Set(summary.sources
      .filter((source) => source.reviewStatus === "QUARANTINED")
      .map((source) => source.id));
    expect(summary.hypotheses.every((hypothesis) =>
      hypothesis.status === "EXCLUDED" ||
      hypothesis.sources.every((source) => !quarantinedIds.has(source.sourceId))
    )).toBe(true);
    expect(Object.isFrozen(summary)).toBe(true);
    expect(Object.isFrozen(summary.sources)).toBe(true);
    expect(Object.isFrozen(summary.hypotheses[0]!.sources)).toBe(true);
    expect(new Set(summary.sources.map((source) => source.id)).size).toBe(summary.sourceCount);
    expect(new Set(summary.sources.map((source) => source.sha256)).size).toBe(summary.sourceCount);
    expect(summary.sources.every((source) => /^[A-F0-9]{64}$/.test(source.sha256))).toBe(true);
    expect(new Set(summary.hypotheses.map((hypothesis) => hypothesis.id)).size)
      .toBe(summary.hypotheses.length);
    expect(summary.sources.every((source) =>
      (source.reviewStatus === "QUARANTINED") === !source.researchEligible
    )).toBe(true);
  });

  it("links only shadow-testing hypotheses to frozen analysis policies", () => {
    const summary = stockPaperBookResearchSummary();
    const policyById = new Map(FROZEN_STOCK_PAPER_SHADOW_POLICIES_V3.map((policy) => [policy.id, policy]));
    const shadowHypotheses = summary.hypotheses.filter((hypothesis) =>
      hypothesis.status === "SHADOW_TESTING"
    );

    expect(shadowHypotheses).toHaveLength(summary.shadowTestingCount);
    for (const hypothesis of shadowHypotheses) {
      expect(hypothesis.shadowPolicyId).toBeDefined();
      expect(policyById.get(hypothesis.shadowPolicyId!)?.researchBasisId).toBe(hypothesis.id);
      expect(policyById.get(hypothesis.shadowPolicyId!)?.researchManifestDigest)
        .toBe(STOCK_PAPER_BOOK_SHADOW_MANIFEST_DIGEST);
      expect(hypothesis).toMatchObject({
        analysisOnly: true,
        affectsTrading: false,
        promotionEligible: false
      });
    }
    expect(summary.hypotheses.filter((hypothesis) => hypothesis.status !== "SHADOW_TESTING")
      .every((hypothesis) => hypothesis.shadowPolicyId === undefined)).toBe(true);
  });

  it("keeps long-horizon, missing-data, and unsupported claims out of trading", () => {
    const summary = stockPaperBookResearchSummary();
    const longTerm = summary.hypotheses.find((hypothesis) =>
      hypothesis.id === "LONG_TERM_RULES_AS_INTRADAY_TRIGGERS"
    );
    const fundamentals = summary.hypotheses.find((hypothesis) =>
      hypothesis.id === "SLOW_FUNDAMENTAL_OVERLAY"
    );
    const concentration = summary.hypotheses.find((hypothesis) =>
      hypothesis.id === "CONCENTRATION_AND_OVERLAP_AUDIT"
    );
    const breakout = summary.hypotheses.find((hypothesis) =>
      hypothesis.id === "BREAKOUT_QUALITY_AND_FAILURE_LABELS"
    );
    const partialExit = summary.hypotheses.find((hypothesis) =>
      hypothesis.id === "PARTIAL_EXIT_TRAILING_REMAINDER"
    );
    const gapStops = summary.hypotheses.find((hypothesis) =>
      hypothesis.id === "CORPORATE_ACTION_GAP_STOP_REALISM"
    );

    expect(longTerm).toMatchObject({ status: "EXCLUDED", affectsTrading: false });
    expect(longTerm?.exclusionReason).toBeTruthy();
    expect(fundamentals).toMatchObject({ status: "DATA_REQUIRED", affectsTrading: false });
    expect(fundamentals?.requiredData?.length).toBeGreaterThan(3);
    expect(concentration).toMatchObject({ status: "DATA_REQUIRED", affectsTrading: false });
    expect(breakout).toMatchObject({
      status: "DATA_REQUIRED",
      affectsTrading: false,
      promotionEligible: false
    });
    expect(breakout?.requiredData).toContain("failed-break and retest labels");
    expect(partialExit).toMatchObject({ status: "DATA_REQUIRED", affectsTrading: false });
    expect(partialExit?.requiredData).toContain("lot accounting");
    expect(gapStops).toMatchObject({ status: "DATA_REQUIRED", affectsTrading: false });
    expect(gapStops?.requiredData).toContain("no-fill behavior");
    expect(summary.hypotheses.every((hypothesis) =>
      hypothesis.analysisOnly && !hypothesis.affectsTrading && !hypothesis.promotionEligible
    )).toBe(true);
  });
});
