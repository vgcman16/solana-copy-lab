import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PaperComparisonSnapshot } from "@copylab/shared";
import { PaperComparisonPanel } from "../src/components/PaperComparisonPanel";

const NOW = "2026-07-14T12:00:00.000Z";

function comparison(
  kind: PaperComparisonSnapshot["kind"],
  label: string,
  normalizedPnlUsd: number,
  basis: PaperComparisonSnapshot["basis"] = "SINGLE_ACCOUNT",
  sampleSize = 1
): PaperComparisonSnapshot {
  return {
    kind,
    label,
    status: "ACTIVE",
    basis,
    sampleSize,
    initialNavUsd: 141,
    normalizedNavUsd: 141 + normalizedPnlUsd,
    normalizedPnlUsd,
    netReturnPercent: (normalizedPnlUsd / 141) * 100,
    realizedPnlUsd: normalizedPnlUsd,
    unrealizedPnlUsd: 0,
    maxDrawdownPercent: 4.2,
    completedTrades: 12,
    openPositions: 1,
    winRatePercent: 58.3,
    profitFactor: 1.24,
    pricingComplete: true,
    ...(kind === "AUTONOMOUS_HIGH_RISK"
      ? { accountUpdatedAt: "2026-07-14T11:55:00.000Z" }
      : {}),
    updatedAt: NOW
  };
}

describe("three-way PAPER comparison", () => {
  it("renders three normalized starting-bankroll results without pooling wallet accounts", () => {
    const html = renderToStaticMarkup(createElement(PaperComparisonPanel, {
      comparisons: [
        comparison("AUTONOMOUS_HIGH_RISK", "Autonomous momentum", 7),
        comparison("HIGH_RISK_COPY", "High-risk wallet copy", -18, "EQUAL_WEIGHT_PER_ACCOUNT", 25),
        comparison("STRICT_COPY", "Strict wallet copy", 0)
      ]
    }));

    expect(html).toContain("Three-way PAPER experiment");
    expect(html).toContain("Strict wallet copy");
    expect(html).toContain("High-risk wallet copy");
    expect(html).toContain("Autonomous momentum");
    expect(html).toContain("Equal-weight result across 25 independent accounts");
    expect(html.match(/Started at \$141\.00/g)).toHaveLength(3);
    expect(html).not.toContain("$3,525.00");
    expect(html).toContain("never pooled");
    expect(html).toContain("cannot place real orders");
    expect(html).toContain("guarantee future profit");
    expect(html).toContain("Last scan");
    expect(html).toContain("Balance changed");
    expect(html.match(/Updated /g)).toHaveLength(2);
  });

  it("keeps a safe empty state before comparison snapshots are available", () => {
    const html = renderToStaticMarkup(createElement(PaperComparisonPanel, { comparisons: [] }));
    expect(html).toContain("Comparison evidence is starting");
  });

  it("uses the robust ex-outlier result when raw high-risk ledger profit is reconciliation-dependent", () => {
    const highRisk = {
      ...comparison("HIGH_RISK_COPY", "High-risk wallet copy", 12.12, "EQUAL_WEIGHT_PER_ACCOUNT", 25),
      evidenceStatus: "RECONCILIATION_DEPENDENT" as const,
      robustNormalizedNavUsd: 139.95,
      robustNormalizedPnlUsd: -1.05,
      robustNetReturnPercent: -0.74,
      medianAccountPnlUsd: 0,
      excludedOutlierWallet: "ARW9NzhpuBVYaYBZo6fW1P1U6LTNwUY6jfi7XC37Sa97",
      excludedOutlierPnlUsd: 328.22,
      reconciliationDependentAccountCount: 1,
      evidenceDisclosure: "Some realized PnL is not fully itemized."
    };
    const html = renderToStaticMarkup(createElement(PaperComparisonPanel, { comparisons: [highRisk] }));

    expect(html).toContain("Robust NAV · largest outlier excluded");
    expect(html).toContain("$139.95");
    expect(html).toContain("Robust P&amp;L");
    expect(html).toContain("-$1.05");
    expect(html).toContain("Raw equal-weight ledger NAV $153.12");
    expect(html).toContain("Reconciliation Dependent");
    expect(html).toContain("Some realized PnL is not fully itemized.");
    expect(html).toContain("ARW9N…7Sa97");
  });
});
