import { useState } from "react";
import type {
  ResearchPaperDashboard,
  ResearchPaperPosition
} from "@copylab/shared";
import { setResearchPaperEnabled } from "../api";
import { count, dateTime, money, percent, shortKey, titleCase, tokenLabel } from "../format";
import type { ToastTone } from "../types";
import { Icon } from "./Icon";
import { Button, EmptyState, SectionHeader } from "./Primitives";

interface ResearchPaperPanelProps {
  research: ResearchPaperDashboard;
  strictNavUsd: number;
  csrfToken: string;
  onRefresh: () => Promise<void>;
  notify: (tone: ToastTone, title: string, detail?: string) => void;
}

const SOLANA_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,96}$/u;

function SourceLink({ signature }: { signature: string | undefined }) {
  if (!signature) return <span className="muted">—</span>;
  return SOLANA_SIGNATURE.test(signature)
    ? <a href={`https://solscan.io/tx/${encodeURIComponent(signature)}`} target="_blank" rel="noreferrer" title={signature}>{shortKey(signature)}</a>
    : <span title={signature}>{shortKey(signature)}</span>;
}

function positionTone(status: ResearchPaperPosition["status"]): string {
  if (status === "UNPRICED") return "negative";
  if (status === "CLOSING") return "warning";
  if (status === "OPEN") return "positive";
  return "neutral";
}

function exitQuoteFailureLabel(position: ResearchPaperPosition): string {
  if (position.lastExitQuoteFailureCode === "JUPITER_EXIT_NO_ROUTE") return "No exit route";
  if (position.lastExitQuoteFailureCode === "JUPITER_EXIT_QUOTE_INVALID") return "Invalid exit quote";
  return "Quote service unavailable";
}

function safeWholeCount(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function visibleCount(value: number | undefined): string {
  return value === undefined ? "—" : count(value);
}

function staleUnpriced(position: ResearchPaperPosition, capturedAt: string): boolean {
  return position.status === "UNPRICED" &&
    Date.parse(capturedAt) - Date.parse(position.openedAt) >= 24 * 60 * 60 * 1_000;
}

export function ResearchPaperPanel({
  research,
  strictNavUsd,
  csrfToken,
  onRefresh,
  notify
}: ResearchPaperPanelProps) {
  const [busy, setBusy] = useState(false);
  const laneStatus = research.lane?.status ?? "NOT_STARTED";
  const running = laneStatus === "ACTIVE";
  const positionNavFraction = Number(research.lane?.policy.positionNavFraction);
  const maximumPositionUsd = Number(research.lane?.policy.maximumPositionUsd);
  const sizingDetail = Number.isFinite(positionNavFraction) && Number.isFinite(maximumPositionUsd)
    ? `${percent(positionNavFraction * 100, 0)} NAV · ${money(maximumPositionUsd)} cap`
    : "Sizing evidence unavailable";
  const isolationVerified = research.promotionEligible === false && research.executionEnabled === false;
  const watchlist = research.watchlist;
  const watchlistRun = watchlist?.latestRun;
  const targetWallets = safeWholeCount(watchlistRun?.policy.targetWalletCount);
  const eligibleActiveTraders = safeWholeCount(watchlistRun?.eligibleCandidateCount);
  const enrolledWallets = safeWholeCount(watchlistRun?.totalLeaderCount) ?? watchlist?.members.length ?? research.leaders.length;
  const strictWallets = safeWholeCount(watchlistRun?.strictLeaderCount)
    ?? (watchlist ? watchlist.members.filter((member) => member.role === "STRICT_OVERLAP").length : undefined);
  const researchOnlyWallets = safeWholeCount(watchlistRun?.researchOnlyMonitoredCount)
    ?? (watchlist ? watchlist.members.filter((member) => member.role === "RESEARCH_ONLY").length : undefined);
  const activityWindowDays = safeWholeCount(watchlistRun?.policy.activityWindowDays);
  const minimumRecentTrades = safeWholeCount(watchlistRun?.policy.minimumRecentTrades);
  const providerSnapshotMaxAgeDays = safeWholeCount(watchlistRun?.policy.providerSnapshotMaxAgeDays);
  const localActivityLookbackDays = safeWholeCount(watchlistRun?.policy.localActivityLookbackDays);
  const enrollmentPercent = targetWallets && targetWallets > 0
    ? Math.min(100, (enrolledWallets / targetWallets) * 100)
    : 0;
  const watchlistStatus = !running
    ? laneStatus === "PAUSED" ? "Lane paused" : "Lane not started"
    : targetWallets !== undefined && enrolledWallets >= targetWallets
      ? "Watchlist filled"
      : watchlist ? "Scanning active traders" : "Waiting for watchlist status";
  const performanceEvidence = research.performanceEvidence;
  const evidenceByWallet = new Map(
    performanceEvidence?.leaderEvidence.map((evidence) => [evidence.wallet, evidence]) ?? []
  );

  async function toggleLane() {
    const enabled = !running;
    setBusy(true);
    try {
      await setResearchPaperEnabled(enabled, csrfToken);
      notify(
        "success",
        enabled ? "High-risk research enabled" : "High-risk research paused",
        `Every leader keeps a separate simulated account. The strict account remains isolated at its current ${money(strictNavUsd)} NAV.`
      );
      await onRefresh();
    } catch (reason) {
      notify(
        "danger",
        enabled ? "Research lane could not start" : "Research lane could not pause",
        reason instanceof Error ? reason.message : "Unknown error"
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel research-paper-panel" aria-labelledby="research-paper-title">
      <div className="research-paper-danger-strip">
        <Icon name="alert" size={17} />
        <strong>{research.label}</strong>
        <span>Unsupported routes and tokens can fail, become unpriceable, or be manipulated.</span>
      </div>
      <SectionHeader
        eyebrow="Isolated comparison lab"
        title="High-risk wallet-copy paper accounts"
        description={`This is a separate simulated research ledger. It never changes the strict account’s current ${money(strictNavUsd)} NAV, never sends or signs a transaction, and cannot unlock Manual Live or Auto Live.`}
        action={<Button
          tone={running ? "secondary" : "danger"}
          icon={running ? "pause" : "alert"}
          busy={busy}
          disabled={!isolationVerified}
          onClick={() => void toggleLane()}
        >{running ? "Pause research paper" : "Enable research paper"}</Button>}
      />

      <div className={`research-paper-isolation ${isolationVerified ? "verified" : "failed"}`}>
        <div><Icon name="shield" size={17} /><span><strong>Execution disabled</strong><small>No order, approval, signature, or live position can be created.</small></span></div>
        <div><Icon name="lock" size={17} /><span><strong>Promotion ineligible</strong><small>Research trades never count toward the strict 30-day paper gate.</small></span></div>
        <div><Icon name="database" size={17} /><span><strong>Separate ledgers</strong><small>Each wallet starts with its own account; balances are never pooled or totaled.</small></span></div>
      </div>

      {performanceEvidence && <div className={`research-performance-evidence evidence-${performanceEvidence.status.toLowerCase().replaceAll("_", "-")}`}>
        <div className="research-performance-evidence-copy">
          <span>Performance evidence · {titleCase(performanceEvidence.status)}</span>
          <strong>Robust result excludes the single largest absolute-P&amp;L account</strong>
          <p>{performanceEvidence.disclosure}</p>
        </div>
        <div className="research-performance-evidence-metrics">
          <div><span>Ex-outlier NAV</span><strong>{money(performanceEvidence.exOutlierNormalizedNavUsd)}</strong><small>{performanceEvidence.exOutlierNormalizedPnlUsd >= 0 ? "+" : ""}{money(performanceEvidence.exOutlierNormalizedPnlUsd)} · {count(performanceEvidence.exOutlierAccountCount)} accounts</small></div>
          <div><span>Median account P&amp;L</span><strong className={performanceEvidence.medianAccountPnlUsd >= 0 ? "positive" : "negative"}>{performanceEvidence.medianAccountPnlUsd >= 0 ? "+" : ""}{money(performanceEvidence.medianAccountPnlUsd)}</strong><small>Resistant to one extreme wallet</small></div>
          <div><span>Reconciliation-dependent</span><strong>{count(performanceEvidence.reconciliationDependentAccountCount)}</strong><small>Accounts with non-itemized or balance exits</small></div>
          <div><span>Unpriced / stale</span><strong className={performanceEvidence.unpricedPositionCount > 0 ? "warning" : "positive"}>{count(performanceEvidence.unpricedPositionCount)} / {count(performanceEvidence.staleUnpricedPositionCount)}</strong><small>Stale means unpriced for at least 24 hours</small></div>
        </div>
        {performanceEvidence.largestOutlierWallet && <small className="research-performance-outlier">Excluded diagnostic outlier <a href={`https://solscan.io/account/${encodeURIComponent(performanceEvidence.largestOutlierWallet)}`} target="_blank" rel="noreferrer" title={performanceEvidence.largestOutlierWallet}>{shortKey(performanceEvidence.largestOutlierWallet, 6, 6)}</a> · {performanceEvidence.largestOutlierPnlUsd! >= 0 ? "+" : ""}{money(performanceEvidence.largestOutlierPnlUsd!)}</small>}
      </div>}

      <div className="research-watchlist" aria-label="High-risk active-trader watchlist">
        <div className="research-watchlist-heading">
          <div>
            <span className={`research-watchlist-state ${running ? "active" : "paused"}`}><span className="tiny-dot" />{watchlistStatus}</span>
            <h3>Active-trader watchlist</h3>
            <p>{activityWindowDays !== undefined && minimumRecentTrades !== undefined
              ? `The original strict baseline stays preserved. Research-only additions need at least ${count(minimumRecentTrades)} completed trades inside the last ${count(activityWindowDays)} days. ${localActivityLookbackDays === undefined ? "Local exact-recent activity" : `Local exact activity from the last ${count(localActivityLookbackDays)} days`} is ranked first; holding-only wallets are excluded.`
              : "The original strict baseline stays preserved. Research-only additions require proven recent completed-trade activity; holding-only wallets are excluded."}</p>
          </div>
          <small>{watchlistRun?.selectedAt
            ? `Refreshed ${dateTime(watchlistRun.selectedAt)}${providerSnapshotMaxAgeDays === undefined ? "" : ` · provider proof ≤${count(providerSnapshotMaxAgeDays)}d old`}`
            : "Awaiting server refresh evidence"}</small>
        </div>
        <div className="research-watchlist-progress" aria-label={`${visibleCount(enrolledWallets)} of ${visibleCount(targetWallets)} requested wallets enrolled`}>
          <span style={{ width: `${enrollmentPercent}%` }} />
        </div>
        <div className="research-watchlist-metrics">
          <div><span>Requested</span><strong>{visibleCount(targetWallets)}</strong><small>Research account target</small></div>
          <div><span>Eligible active traders</span><strong>{visibleCount(eligibleActiveTraders)}</strong><small>Completed-trade proof passed</small></div>
          <div><span>Enrolled</span><strong>{visibleCount(enrolledWallets)}</strong><small>Each gets its own {money(research.lane?.initialNavPerLeaderUsd ?? 141)} simulation</small></div>
          <div><span>Strict baseline</span><strong>{visibleCount(strictWallets)}</strong><small>Original safety accounts preserved</small></div>
          <div><span>Research-only</span><strong>{visibleCount(researchOnlyWallets)}</strong><small>High-risk PAPER only</small></div>
          <div><span>Minimum completed trades</span><strong>{visibleCount(minimumRecentTrades)}</strong><small>{activityWindowDays === undefined ? "Activity window pending" : `Within ${count(activityWindowDays)} days`}</small></div>
        </div>
      </div>

      {research.lane && <div className="research-paper-lane-meta">
        <div><span>Lane</span><strong>{research.lane.label}</strong><small>{research.lane.purpose}</small></div>
        <div><span>Status</span><strong className={running ? "warning" : "negative"}>{titleCase(research.lane.status)}</strong><small>Updated {dateTime(research.lane.updatedAt)}</small></div>
        <div><span>Per-wallet start</span><strong>{money(research.lane.initialNavPerLeaderUsd)}</strong><small>One independent account per leader</small></div>
        <div><span>Policy</span><strong>{research.lane.policyVersion}</strong><small>{sizingDetail} · started {dateTime(research.lane.startedAt)}</small></div>
      </div>}

      {research.leaders.length === 0 ? <EmptyState
        icon="wallet"
        title="No high-risk wallet accounts yet"
        detail="Enable the isolated lane to create one independent simulated account for each frozen leader. No balance will be added to the strict NAV."
      /> : <div className="research-paper-leaders">{research.leaders.map((leader) => {
        const pnl = leader.realizedPnlUsd + leader.unrealizedPnlUsd;
        const positions = research.positions.filter((position) => position.wallet === leader.wallet);
        const trades = research.recentTrades.filter((trade) => trade.wallet === leader.wallet);
        const signals = research.recentSignals.filter((signal) => signal.wallet === leader.wallet);
        const leaderEvidence = evidenceByWallet.get(leader.wallet);
        return <article className="research-paper-leader" key={leader.wallet}>
          <header className="research-paper-leader-head">
            <div><span>Independent high-risk wallet-copy account</span><a href={`https://solscan.io/account/${encodeURIComponent(leader.wallet)}`} target="_blank" rel="noreferrer" title={leader.wallet}>{shortKey(leader.wallet, 6, 6)}</a></div>
            <div className="research-leader-evidence-badges">
              {leaderEvidence && leaderEvidence.status !== "COMPLETE" && <span className={`research-pricing incomplete evidence-${leaderEvidence.status.toLowerCase().replaceAll("_", "-")}`}><span className="tiny-dot" />{titleCase(leaderEvidence.status)}</span>}
              <span className={`research-pricing ${leader.pricingComplete ? "complete" : "incomplete"}`}><span className="tiny-dot" />{leader.pricingComplete ? "Pricing complete" : "Pricing incomplete"}</span>
            </div>
          </header>
          <div className="research-paper-account-metrics">
            <div><span>Starting account</span><strong>{money(leader.initialNavUsd)}</strong><small>Not pooled</small></div>
            <div><span>This wallet NAV</span><strong>{money(leader.navUsd)}</strong><small>Peak {money(leader.peakNavUsd)}</small></div>
            <div><span>This wallet P&amp;L</span><strong className={pnl >= 0 ? "positive" : "negative"}>{pnl >= 0 ? "+" : ""}{money(pnl)}</strong><small>{money(leader.realizedPnlUsd)} realized</small></div>
            <div><span>Cash</span><strong>{money(leader.cashUsd)}</strong><small>{count(leader.openPositions)} open positions</small></div>
            <div><span>Max drawdown</span><strong className={leader.maxDrawdownPercent > 10 ? "negative" : "warning"}>{percent(leader.maxDrawdownPercent)}</strong><small>{count(leader.completedTrades)} completed trades</small></div>
            {leaderEvidence && leaderEvidence.status !== "COMPLETE" && <div><span>Closed-trade itemization</span><strong>{leaderEvidence.nonTradeItemizedRealizedPnlUsd >= 0 ? "+" : ""}{money(leaderEvidence.nonTradeItemizedRealizedPnlUsd)} gap</strong><small>{count(leaderEvidence.proportionalExitCount)} proportional · {count(leaderEvidence.balanceReconciledTradeCount)} balance-reconciled exits</small></div>}
          </div>

          <div className="research-paper-subsection">
            <h3>Positions for this wallet</h3>
            {positions.length === 0 ? <p className="research-paper-empty">No isolated positions.</p> : <div className="table-scroll"><table className="research-paper-table"><thead><tr><th>Token</th><th>Status</th><th>Opened</th><th>Remaining cost</th><th>Executable value</th><th>Exit quote retry</th><th>Pending exit</th><th>Leader entry</th></tr></thead><tbody>{positions.map((position) => <tr key={position.id}>
              <td>{tokenLabel(position.mint)}</td>
              <td><span className={`status-pill status-skipped ${positionTone(position.status)}`}><span className="tiny-dot" />{staleUnpriced(position, research.updatedAt) ? "Stale unpriced" : titleCase(position.status)}</span></td>
              <td>{dateTime(position.openedAt)}</td>
              <td>{money(position.remainingCostUsd)}</td>
              <td>{position.status === "UNPRICED" ? "Unpriced" : money(position.lastExecutableValueUsd)}</td>
              <td>{position.exitQuoteFailureCount && position.lastExitQuoteAttemptAt && position.nextExitQuoteRetryAt
                ? <span className="research-exit-retry"><strong>{exitQuoteFailureLabel(position)} · {count(position.exitQuoteFailureCount)} attempts</strong><small>Last {dateTime(position.lastExitQuoteAttemptAt)} · next {dateTime(position.nextExitQuoteRetryAt)}</small></span>
                : <span className="muted">—</span>}</td>
              <td>{percent(position.pendingExitFraction * 100, 0)}</td>
              <td><SourceLink signature={position.sourceEntrySignature} /></td>
            </tr>)}</tbody></table></div>}
          </div>

          <div className="research-paper-subsection research-paper-two-column">
            <div><h3>Recent rejected signals</h3>{signals.length === 0 ? <p className="research-paper-empty">No rejected signals for this wallet.</p> : <div className="research-paper-events">{signals.slice(0, 5).map((signal) => <div key={signal.eventKey}>
              <span className="research-event-route">{titleCase(signal.action ?? signal.kind)} {signal.mint ? tokenLabel(signal.mint) : "NAV mark"}</span>
              <strong>{titleCase(signal.outcome)}</strong>
              <p>{signal.reason ?? "Research evidence was recorded without entering the strict trading path."}</p>
              <small>{signal.strictReasonCodes?.map(titleCase).join(" · ") || "Strict decoder rejection"} · <SourceLink signature={signal.sourceSignature} /></small>
            </div>)}</div>}</div>
            <div><h3>Recent closed research trades</h3>{trades.length === 0 ? <p className="research-paper-empty">No closed research trades for this wallet.</p> : <div className="research-paper-events">{trades.slice(0, 5).map((trade) => <div key={trade.id}>
              <span className="research-event-route">{tokenLabel(trade.mint)}</span>
              <strong className={trade.pnlUsd >= 0 ? "positive" : "negative"}>{trade.pnlUsd >= 0 ? "+" : ""}{money(trade.pnlUsd)}</strong>
              <p>{money(trade.proceedsUsd)} proceeds · {money(trade.modeledCostsUsd)} modeled costs</p>
              <small>Closed {dateTime(trade.closedAt)} · {titleCase(trade.exitEvidence ?? "LEADER_SWAP")} · <SourceLink signature={trade.sourceExitSignature} /></small>
            </div>)}</div>}</div>
          </div>
        </article>;
      })}</div>}

      <footer className="research-paper-footer">
        <Icon name="alert" size={15} />
        <span>Research-only results are deliberately excluded from strict NAV, drawdown stops, paper promotion, live-wallet selection, approvals, and execution.</span>
      </footer>
    </section>
  );
}
