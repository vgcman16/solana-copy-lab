import type { PaperComparisonKind, PaperComparisonSnapshot } from "@copylab/shared";
import { count, dateTime, money, percent, shortKey, titleCase } from "../format";
import { Icon } from "./Icon";
import { EmptyState, SectionHeader } from "./Primitives";

interface PaperComparisonPanelProps {
  comparisons: PaperComparisonSnapshot[];
}

const COMPARISON_ORDER: Record<PaperComparisonKind, number> = {
  STRICT_COPY: 0,
  HIGH_RISK_COPY: 1,
  AUTONOMOUS_HIGH_RISK: 2
};

function signedMoney(value: number): string {
  return `${value >= 0 ? "+" : ""}${money(value)}`;
}

function finiteMetric(value: number | undefined, formatter: (metric: number) => string): string {
  return value === undefined || !Number.isFinite(value) ? "—" : formatter(value);
}

function basisLabel(comparison: PaperComparisonSnapshot): string {
  return comparison.basis === "EQUAL_WEIGHT_PER_ACCOUNT"
    ? `Equal-weight result across ${count(comparison.sampleSize)} independent accounts`
    : "One isolated virtual account";
}

export function PaperComparisonPanel({ comparisons }: PaperComparisonPanelProps) {
  const ordered = [...comparisons].sort((left, right) =>
    COMPARISON_ORDER[left.kind] - COMPARISON_ORDER[right.kind]
  );

  return (
    <section className="panel paper-comparison-panel" aria-labelledby="paper-comparison-title">
      <SectionHeader
        eyebrow="Three-way PAPER experiment"
        title="Which approach is actually working?"
        description="Each result is normalized to one starting bankroll for an honest comparison. Wallet-copy accounts are equal-weighted, never pooled, and every lane remains simulation-only."
      />
      {ordered.length === 0 ? <EmptyState
        icon="trend"
        title="Comparison evidence is starting"
        detail="The server will publish strict copy, high-risk wallet copy, and autonomous momentum results after their first account snapshots."
      /> : <div className="paper-comparison-grid">{ordered.map((comparison) => {
        const hasRobustResult = comparison.kind === "HIGH_RISK_COPY" &&
          comparison.robustNormalizedNavUsd !== undefined &&
          comparison.robustNormalizedPnlUsd !== undefined &&
          comparison.robustNetReturnPercent !== undefined;
        const displayedNav = hasRobustResult
          ? comparison.robustNormalizedNavUsd!
          : comparison.normalizedNavUsd;
        const displayedPnl = hasRobustResult
          ? comparison.robustNormalizedPnlUsd!
          : comparison.normalizedPnlUsd;
        const displayedReturn = hasRobustResult
          ? comparison.robustNetReturnPercent!
          : comparison.netReturnPercent;
        const profitable = displayedPnl >= 0;
        return <article className={`paper-comparison-card comparison-${comparison.kind.toLowerCase().replaceAll("_", "-")}`} key={comparison.kind}>
          <header>
            <span className={`comparison-status status-${comparison.status.toLowerCase()}`}><span className="tiny-dot" />{titleCase(comparison.status)}</span>
            <Icon name={comparison.kind === "AUTONOMOUS_HIGH_RISK" ? "spark" : comparison.kind === "STRICT_COPY" ? "shield" : "copy"} size={17} />
          </header>
          <h3>{comparison.label}</h3>
          <p>{basisLabel(comparison)}</p>
          <div className="comparison-nav">
            <span>{hasRobustResult ? "Robust NAV · largest outlier excluded" : "Normalized NAV"}</span>
            <strong>{money(displayedNav)}</strong>
            <small>Started at {money(comparison.initialNavUsd)}</small>
            {hasRobustResult && <small className="comparison-ledger-result">Raw equal-weight ledger NAV {money(comparison.normalizedNavUsd)}</small>}
          </div>
          <div className="comparison-result">
            <div><span>{hasRobustResult ? "Robust P&L" : "Net P&L"}</span><strong className={profitable ? "positive" : "negative"}>{signedMoney(displayedPnl)}</strong></div>
            <div><span>Return</span><strong className={displayedReturn >= 0 ? "positive" : "negative"}>{displayedReturn >= 0 ? "+" : ""}{percent(displayedReturn)}</strong></div>
          </div>
          <dl>
            <div><dt>Realized</dt><dd>{signedMoney(comparison.realizedPnlUsd)}</dd></div>
            <div><dt>Unrealized</dt><dd>{signedMoney(comparison.unrealizedPnlUsd)}</dd></div>
            <div><dt>Max drawdown</dt><dd>{percent(comparison.maxDrawdownPercent)}</dd></div>
            <div><dt>Completed / open</dt><dd>{count(comparison.completedTrades)} / {count(comparison.openPositions)}</dd></div>
            <div><dt>Win rate</dt><dd>{finiteMetric(comparison.winRatePercent, (value) => percent(value))}</dd></div>
            <div><dt>Profit factor</dt><dd>{finiteMetric(comparison.profitFactor, (value) => value.toFixed(2))}</dd></div>
            {hasRobustResult && <div><dt>Median account P&amp;L</dt><dd>{finiteMetric(comparison.medianAccountPnlUsd, signedMoney)}</dd></div>}
            {hasRobustResult && <div><dt>Excluded outlier</dt><dd title={comparison.excludedOutlierWallet}>{comparison.excludedOutlierWallet ? shortKey(comparison.excludedOutlierWallet, 5, 5) : "—"} · {finiteMetric(comparison.excludedOutlierPnlUsd, signedMoney)}</dd></div>}
          </dl>
          {comparison.evidenceStatus && comparison.evidenceStatus !== "COMPLETE" && <div className={`comparison-evidence-warning evidence-${comparison.evidenceStatus.toLowerCase().replaceAll("_", "-")}`}>
            <strong>{titleCase(comparison.evidenceStatus)}</strong>
            <span>{comparison.evidenceDisclosure ?? "The PAPER ledger needs additional pricing or reconciliation evidence."}</span>
            {comparison.reconciliationDependentAccountCount !== undefined && comparison.reconciliationDependentAccountCount > 0
              ? <small>{count(comparison.reconciliationDependentAccountCount)} account(s) include non-itemized proportional or balance-reconciled exits.</small>
              : null}
          </div>}
          <footer>
            <span className={comparison.pricingComplete ? "positive" : "warning"}>{comparison.pricingComplete ? "Executable pricing complete" : "Pricing incomplete"}</span>
            {comparison.kind === "AUTONOMOUS_HIGH_RISK" ? <span className="comparison-update-times">
              <small>Last scan {dateTime(comparison.updatedAt)}</small>
              {comparison.accountUpdatedAt && <small>Balance changed {dateTime(comparison.accountUpdatedAt)}</small>}
            </span> : <small>Updated {dateTime(comparison.updatedAt)}</small>}
          </footer>
        </article>;
      })}</div>}
      <div className="paper-comparison-footnote"><Icon name="lock" size={15} /><span>Normalized PAPER results are diagnostic only. They cannot place real orders, unlock live mode, or guarantee future profit.</span></div>
    </section>
  );
}
