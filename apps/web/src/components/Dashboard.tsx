import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  DEFAULT_RISK_POLICY,
  PAPER_EVALUATION_WALLET_COUNT
} from "@copylab/shared";
import type {
  DashboardSnapshot,
  ExecutionRecord,
  ModeState,
  OperationalTelemetrySnapshot,
  PositionLot,
  PromotionGate,
  ProviderHealth,
  SignalAuditRecord,
  WalletIndexDashboardSnapshot,
  WalletResearchFilter,
  WalletResearchFunnelStage,
  WalletResearchPage,
  WalletResearchSort
} from "@copylab/shared";
import {
  changeMode,
  confirmWalletBackup,
  createLiveWallet,
  decideApproval,
  emergencyExit,
  getPendingWalletRecovery,
  getWalletResearch,
  pauseSystem,
  recheckNewEntries,
  restoreLiveWallet,
  resumeSystem
} from "../api";
import {
  bytes,
  clamp,
  count,
  dateTime,
  duration,
  money,
  percent,
  relativeTime,
  shortKey,
  titleCase,
  tokenLabel
} from "../format";
import type { SetupStatus, ToastTone, WalletCreationResult } from "../types";
import { classifyWallet, type WalletRow } from "../wallets";
import { Icon } from "./Icon";
import { DataProviderControl } from "./DataProviderControl";
import { SolPriceBootstrapControl } from "./SolPriceBootstrapControl";
import { AlpacaPaperSetupCard } from "./AlpacaPaperSetupCard";
import { ResearchPaperPanel } from "./ResearchPaperPanel";
import { AutonomousPaperPanel } from "./AutonomousPaperPanel";
import { PaperComparisonPanel } from "./PaperComparisonPanel";
import { MarketplaceWorkspace } from "./MarketplaceWorkspace";
import {
  HolographicMarketFloor,
  StockMomentumWorkspace,
  type MarketFloorWorkspace
} from "./HolographicMarketFloor";
import {
  Brand,
  Button,
  EmptyState,
  Modal,
  SectionHeader,
  StatusDot
} from "./Primitives";

interface DashboardProps {
  snapshot: DashboardSnapshot;
  csrfToken: string;
  streamConnected: boolean;
  refreshing: boolean;
  onRefresh: () => Promise<void>;
  setupStatus: SetupStatus;
  onSetupRefresh: () => Promise<SetupStatus>;
  notify: (tone: ToastTone, title: string, detail?: string) => void;
}

function ValueDelta({ value, suffix = "" }: { value: number; suffix?: string }) {
  const tone = value > 0 ? "positive" : value < 0 ? "negative" : "neutral";
  const prefix = value > 0 ? "+" : "";
  return <span className={`value-delta ${tone}`}>{prefix}{value.toFixed(1)}{suffix}</span>;
}

function ModeBadge({ mode }: { mode: ModeState }) {
  const live = mode === "MANUAL_LIVE" || mode === "AUTO_LIVE";
  return <span className={`mode-badge mode-${mode.toLowerCase()}`}><span className="mode-pulse" />{live ? "LIVE · " : ""}{titleCase(mode)}</span>;
}

function ProviderCard({ health }: { health: ProviderHealth }) {
  const physicalProvider = health.usage?.provider ?? health.provider;
  const usageLabel = physicalProvider === "solana_rpc"
    ? "Standard Solana RPC"
    : titleCase(physicalProvider);
  const requestUsage = health.usage ? `${count(health.usage.requests)} req` : undefined;
  const creditUsage = health.usage?.credits !== undefined
    ? `${count(health.usage.credits)}${health.usage.creditLimit !== undefined
      ? ` / ${count(health.usage.creditLimit)}`
      : ""} ${health.usage.creditUnit ?? "credits"}`
    : undefined;
  return (
    <article className={`provider-card ${health.ok ? "provider-ok" : "provider-bad"}`}>
      <div className="provider-card-top">
        <span className="provider-monogram">{health.provider.charAt(0).toUpperCase()}</span>
        <StatusDot ok={health.ok} label={health.ok ? "Healthy" : "Unavailable"} />
      </div>
      <div><strong>{titleCase(health.provider)}</strong><p>{health.message}</p></div>
      <footer>
        <span>{health.latencyMs !== undefined ? `${count(health.latencyMs)} ms` : "No latency"}</span>
        <span>{health.usage
          ? `${[requestUsage, creditUsage].filter(Boolean).join(" · ")} / ${health.usage.window} · ${usageLabel}`
          : relativeTime(health.checkedAt)}</span>
      </footer>
    </article>
  );
}

function WalletIndexPanel({ index }: { index: WalletIndexDashboardSnapshot }) {
  const { coverage, latestRun } = index;
  const acquisition = index.acquisition;
  const progress = clamp(coverage.indexedWallets / Math.max(1, index.targetWallets) * 100);
  const queueBacklog =
    coverage.queueByStatus.PENDING + coverage.queueByStatus.RETRY + coverage.queueByStatus.LEASED;
  const indexQuota = clamp(index.indexCreditsUsed / Math.max(1, index.indexCreditBudget) * 100);
  const totalQuota = clamp(index.totalHeliusCreditsUsed / Math.max(1, index.totalHeliusCreditBudget) * 100);
  const stage = latestRun?.stage ?? "IDLE";
  const displayedStatus = acquisition?.status ?? stage;
  const statusTone = stage === "FAILED" || acquisition?.status === "SOURCE_EXHAUSTED"
    ? "negative"
    : stage === "PAUSED" || acquisition?.status === "WAITING_FOR_BUDGET" ||
        acquisition?.status === "MAXIMUM_REACHED" || acquisition?.status === "WAITING_FOR_FREEZE"
      ? "warning"
      : "positive";
  return (
    <section className="panel wallet-index-panel">
      <SectionHeader
        eyebrow="Local intelligence"
        title="Wallet index"
        description="Confirmed Jupiter activity builds a resumable research universe. Observed signer candidates are separate from strict normalized swaps, and neither can sign or trigger a live order."
        action={<span className={`index-stage ${statusTone}`}><span className="mode-pulse" />{titleCase(displayedStatus)}</span>}
      />
      <div className="index-progress-row">
        <div><strong>{count(coverage.indexedWallets)}</strong><span>observed signer candidates of {count(index.targetWallets)} target</span></div>
        <span>{percent(progress, 1)}</span>
      </div>
      <div className="index-progress"><span style={{ width: `${progress}%` }} /></div>
      <div className="index-metrics">
        <article><span>Unique signatures</span><strong>{count(coverage.uniqueSignatures)}</strong><small>{count(queueBacklog)} queued or leased</small></article>
        <article><span>Hydrated transactions</span><strong>{count(coverage.indexedTransactions)}</strong><small>{count(coverage.queueByStatus.FAILED)} permanently failed</small></article>
        <article><span>Normalized swaps</span><strong>{count(coverage.indexedSwaps)}</strong><small>SOL / USDC two-leg only</small></article>
        <article><span>Pre-screen ready</span><strong>{count(coverage.preScreenEligibleWallets)}</strong><small>Age and activity verified</small></article>
      </div>
      <div className="index-foot">
        <div className="quota-line"><span>Indexer credits</span><div><i style={{ width: `${indexQuota}%` }} /></div><strong>{count(index.indexCreditsUsed)} / {count(index.indexCreditBudget)}</strong></div>
        <div className="quota-line"><span>Total Helius reserve</span><div><i style={{ width: `${totalQuota}%` }} /></div><strong>{count(index.totalHeliusCreditsUsed)} / {count(index.totalHeliusCreditBudget)}</strong></div>
        <small>{acquisition
          ? `${acquisition.qualifiedWallets} / ${PAPER_EVALUATION_WALLET_COUNT} exact qualifiers · ${
              acquisition.budgetBlockers.length > 0
                ? `${acquisition.budgetBlockers.map((blocker) => titleCase(blocker)).join(", ")} budget waits until ${dateTime(acquisition.budget.nextResetAt)}`
                : `automatic expansion capped at ${count(acquisition.maximumWallets)} wallets`
            }`
          : latestRun
            ? `Run updated ${relativeTime(latestRun.updatedAt)}`
            : "Waiting for the first index run"}{coverage.oldestBlockTime ? ` · chain coverage from ${dateTime(coverage.oldestBlockTime)}` : ""}</small>
      </div>
    </section>
  );
}

function OperationalTelemetryPanel({ telemetry: input }: { telemetry?: OperationalTelemetrySnapshot }) {
  const telemetry: OperationalTelemetrySnapshot = input ?? {
    status: "UNAVAILABLE",
    capturedAt: new Date(0).toISOString(),
    blocksNewEntries: true,
    blockingIssueCodes: ["TELEMETRY_UNAVAILABLE"],
    issues: [{
      severity: "CRITICAL",
      code: "TELEMETRY_UNAVAILABLE",
      message: "Local operational telemetry could not be verified."
    }]
  };
  const storage = telemetry.storage;
  const queue = telemetry.indexQueue;
  const repair = telemetry.monitoringRepair;
  const tradingHead = telemetry.tradingHead;
  const audit = telemetry.audit;
  const statusTone = telemetry.status === "HEALTHY"
    ? "positive"
    : telemetry.status === "WARNING"
      ? "warning"
      : "negative";
  return (
    <section className={`panel operations-panel operations-${telemetry.status.toLowerCase()}`}>
      <SectionHeader
        eyebrow="Local operations"
        title="Data-stack telemetry"
        description="Read-only evidence from the Windows app's SQLite ledger and local volume. RPC-host disks are monitored separately; missing evidence is unhealthy, never zero."
        action={<span className={`operations-status ${statusTone}`}><span className="mode-pulse" />{titleCase(telemetry.status)}</span>}
      />
      <div className="operations-groups">
        <article>
          <header><Icon name="database" size={16} /><strong>Local app storage</strong></header>
          {storage ? <dl>
            <div><dt>Database</dt><dd>{bytes(storage.databaseBytes)}</dd></div>
            <div><dt>WAL</dt><dd>{bytes(storage.walBytes)}</dd></div>
            <div><dt>SQLite page</dt><dd>{bytes(storage.pageSizeBytes)}</dd></div>
            <div><dt>Drive free</dt><dd>{storage.driveAvailableBytes === undefined ? "Unavailable" : `${bytes(storage.driveAvailableBytes)} · ${percent(storage.driveAvailablePercent ?? 0, 1)}`}</dd></div>
          </dl> : <p>Storage telemetry unavailable.</p>}
        </article>
        <article>
          <header><Icon name="activity" size={16} /><strong>Index queue</strong></header>
          {queue ? <dl>
            <div><dt>Pending / leased</dt><dd>{count(queue.pending)} / {count(queue.leased)}</dd></div>
            <div><dt>Retry</dt><dd className={queue.retry > 0 ? "warning" : ""}>{count(queue.retry)}</dd></div>
            <div><dt>Failed</dt><dd className={queue.failed > 0 ? "negative" : ""}>{count(queue.failed)}</dd></div>
            <div>
              <dt>{queue.managedSnapshotCapped ? "Discovery scope" : tradingHead ? "Discovery heads" : "Continuous heads"}</dt>
              <dd className={queue.managedSnapshotCapped ? "" : queue.headCatchupComplete ? "" : tradingHead ? "warning" : "negative"}>
                {queue.managedSnapshotCapped
                  ? "25,000 capped · leader streams authoritative"
                  : `${count(queue.headProgramsReady)} / ${count(queue.headProgramsRequired)} · ${count(queue.headUnprocessed)} hydrating`}
              </dd>
            </div>
            <div><dt>Oldest / head lag</dt><dd>{duration(queue.oldestBacklogAgeSeconds)} / {duration(queue.newestIndexedBlockLagSeconds)}</dd></div>
          </dl> : <p>Index queue telemetry unavailable.</p>}
        </article>
        <article>
          <header><Icon name="refresh" size={16} /><strong>Gap repair</strong></header>
          {repair ? <dl>
            {tradingHead ? <>
              <div><dt>Active leaders</dt><dd className={tradingHead.repairReadyWallets === tradingHead.requiredWallets ? "" : "negative"}>{count(tradingHead.repairReadyWallets)} / {count(tradingHead.requiredWallets)} repaired</dd></div>
              <div><dt>Leader stream</dt><dd className={tradingHead.streamFresh && tradingHead.streamConnected && tradingHead.streamReady ? "" : "negative"}>{tradingHead.streamConnected && tradingHead.streamReady ? "Live" : "Not ready"} · {duration(tradingHead.lastMessageLagSeconds)}</dd></div>
              <div><dt>Leader backlog</dt><dd className={tradingHead.unprocessedSourceEvents > 0 ? "negative" : ""}>{count(tradingHead.unprocessedSourceEvents)}</dd></div>
              <div><dt>Other repairs</dt><dd className={repair.failed > 0 || repair.pending > 0 ? "warning" : ""}>{count(repair.pending)} pending · {count(repair.failed)} failed</dd></div>
            </> : <>
              <div><dt>Ready / total</dt><dd>{count(repair.ready)} / {count(repair.total)}</dd></div>
              <div><dt>Pending</dt><dd className={repair.pending > 0 ? "warning" : ""}>{count(repair.pending)}</dd></div>
              <div><dt>Failed / due</dt><dd className={repair.failed > 0 ? "negative" : ""}>{count(repair.failed)} / {count(repair.retryDue)}</dd></div>
              <div><dt>Oldest unresolved</dt><dd>{duration(repair.oldestUnreadyAgeSeconds)}</dd></div>
            </>}
          </dl> : <p>Gap-repair telemetry unavailable.</p>}
        </article>
        <article>
          <header><Icon name="shield" size={16} /><strong>Audit · 24h</strong></header>
          {audit ? <dl>
            <div><dt>Warnings · non-blocking</dt><dd className={audit.warnings > 0 ? "warning" : ""}>{count(audit.warnings)}</dd></div>
            <div><dt>Critical</dt><dd className={audit.critical > 0 ? "negative" : ""}>{count(audit.critical)}</dd></div>
            <div><dt>Latest alert</dt><dd>{audit.latestWarningOrCriticalAt ? relativeTime(audit.latestWarningOrCriticalAt) : "None"}</dd></div>
            <div><dt>Captured</dt><dd>{relativeTime(telemetry.capturedAt)}</dd></div>
          </dl> : <p>Audit telemetry unavailable.</p>}
        </article>
      </div>
      {telemetry.issues.length > 0 && <details className="operations-issues" open={telemetry.status === "CRITICAL" || telemetry.status === "UNAVAILABLE"}>
        <summary>{telemetry.issues.length} operational {telemetry.issues.length === 1 ? "issue" : "issues"}</summary>
        <ul>{telemetry.issues.map((entry) => <li className={entry.severity === "CRITICAL" ? "negative" : "warning"} key={entry.code}>{entry.message}</li>)}</ul>
      </details>}
    </section>
  );
}

function ResearchFunnel({
  label,
  stages
}: {
  label: string;
  stages: WalletResearchFunnelStage[];
}) {
  return (
    <div className="research-funnel-group">
      <strong>{label}</strong>
      <div className="research-funnel">
        {stages.map((stage, index) => {
          const prior = stages[index - 1]?.count;
          const retention = prior && prior > 0 ? stage.count / prior * 100 : undefined;
          return (
            <article key={stage.key} title={`${stage.definition} Source: ${stage.sources.join(", ")}.`}>
              <span>{stage.label}</span>
              <strong>{count(stage.count)}</strong>
              <small>{index === 0 || retention === undefined ? "funnel start" : `${percent(retention, 1)} retained`}</small>
            </article>
          );
        })}
      </div>
    </div>
  );
}

function WalletResearchExplorer({ index }: { index: WalletIndexDashboardSnapshot }) {
  const [filter, setFilter] = useState<WalletResearchFilter>("ALL");
  const [sort, setSort] = useState<WalletResearchSort>("CLOSED_SWAPS");
  const [page, setPage] = useState(1);
  const [reload, setReload] = useState(0);
  const [result, setResult] = useState<WalletResearchPage>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void getWalletResearch({ page, pageSize: 25, filter, sort, signal: controller.signal })
      .then((next) => setResult(next))
      .catch((reason) => {
        if (reason instanceof DOMException && reason.name === "AbortError") return;
        setError(reason instanceof Error ? reason.message : "Wallet research could not be loaded.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [filter, page, reload, sort]);

  const changeFilter = (next: WalletResearchFilter) => {
    setFilter(next);
    setPage(1);
  };
  const changeSort = (next: WalletResearchSort) => {
    setSort(next);
    setPage(1);
  };
  const lastPage = Math.max(1, result?.totalPages ?? 1);
  return (
    <section className="panel table-panel research-panel">
      <SectionHeader
        eyebrow="Research universe"
        title="Observed wallet-candidate funnel"
        description="Browse the local SQLite research index in bounded pages. Coarse signer candidates carry zero swap claims until strict decoding upgrades them; activity screening never qualifies a wallet for live trading."
        action={<button className="research-refresh" type="button" onClick={() => setReload((value) => value + 1)} disabled={loading}><Icon name="refresh" size={13} />Refresh page</button>}
      />
      <div className="research-funnel-wrap">
        <ResearchFunnel label="Local coarse screen" stages={index.researchFunnel.localIndex} />
        <ResearchFunnel label="Provider depth cohort" stages={index.researchFunnel.providerCohort} />
        {index.managedRecoveryPreflight && index.managedRecoveryPreflight.total > 0 ? (
          <p>
            Rescue pre-screen: {count(index.managedRecoveryPreflight.pass)} passed, {count(index.managedRecoveryPreflight.running)} running,
            {" "}{count(index.managedRecoveryPreflight.ready + index.managedRecoveryPreflight.retry)} queued, and {count(index.managedRecoveryPreflight.rejected)} rejected this week.
          </p>
        ) : null}
        <p>Hover a stage for its exact definition and durable SQLite source. Provider-depth counts are a separate funnel and are never inferred from local activity.</p>
      </div>
      <div className="research-controls">
        <label><span>Status</span><select value={filter} onChange={(event) => changeFilter(event.target.value as WalletResearchFilter)}>
          <option value="ALL">All observed candidates</option>
          <option value="PRESCREEN_READY">Activity proven</option>
          <option value="PRESCREEN_REJECTED">Activity rejected</option>
          <option value="AWAITING_PRESCREEN">Awaiting pre-screen</option>
        </select></label>
        <label><span>Order</span><select value={sort} onChange={(event) => changeSort(event.target.value as WalletResearchSort)}>
          <option value="CLOSED_SWAPS">Closed swaps</option>
          <option value="HISTORY">History depth</option>
          <option value="ACTIVITY">Recent activity</option>
          <option value="RECENT">Last seen</option>
        </select></label>
        <span>{result ? `${count(result.total)} matching wallets · captured ${relativeTime(result.capturedAt)}` : "Loading bounded wallet page…"}</span>
      </div>
      {error ? <div className="research-error"><Icon name="alert" size={15} />{error}</div> : result && result.items.length > 0 ? (
        <>
          <div className="table-scroll"><table className="research-table">
            <thead><tr><th>Wallet / evidence</th><th>Activity screen</th><th>History</th><th>Closed eligible swaps</th><th>Active weeks</th><th>Median hold</th><th>Last seen</th></tr></thead>
            <tbody>{result.items.map((wallet) => {
              const pending = wallet.preScreenReasons.includes("pending activity pre-screen");
              const status = wallet.preScreenEligible ? "Ready" : pending ? "Awaiting" : "Rejected";
              const tone = wallet.preScreenEligible ? "status-confirmed" : pending ? "status-pending" : "status-failed";
              return <tr key={wallet.wallet}>
                <td><div className="number-stack"><a href={`https://solscan.io/account/${wallet.wallet}`} target="_blank" rel="noreferrer" title={wallet.wallet}>{shortKey(wallet.wallet, 5, 5)}</a><small>{wallet.discoveryTier === "COARSE_SIGNER" ? "Unverified signer candidate" : "Exact normalized swap"}</small></div></td>
                <td><div className="number-stack"><span className={`status-pill ${tone}`}><span className="tiny-dot" />{status}</span><small title={wallet.preScreenReasons.join("; ")}>{wallet.preScreenReasons[0] ?? "No rejection reason"}</small></div></td>
                <td>{count(wallet.historyDays)} days</td>
                <td>{count(wallet.closedEligibleSwaps)}</td>
                <td>{count(wallet.activeWeeks)} / 4</td>
                <td>{count(wallet.medianHoldingMinutes)} min</td>
                <td>{relativeTime(wallet.lastSeenAt)}</td>
              </tr>;
            })}</tbody>
          </table></div>
          <footer className="research-pager">
            <button type="button" onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={loading || page <= 1}>Previous</button>
            <span>Page {page} of {lastPage}</span>
            <button type="button" onClick={() => setPage((value) => Math.min(lastPage, value + 1))} disabled={loading || page >= lastPage}>Next</button>
          </footer>
        </>
      ) : loading ? <div className="research-loading">Loading 25-wallet page…</div> : <EmptyState icon="database" title="No observed wallet candidates match" detail="The local indexer will add results here without expanding the dashboard payload." />}
    </section>
  );
}

interface GateMetric {
  label: string;
  value: string;
  progress: number;
  pass: boolean;
  note: string;
}

function buildGateMetrics(gate: PromotionGate): GateMetric[] {
  return [
    { label: "Observation window", value: `${gate.elapsedDays} / 30 days`, progress: gate.elapsedDays / 30 * 100, pass: gate.elapsedDays >= 30, note: "30 consecutive days" },
    { label: "Completed exits", value: `${gate.completedExits} / 50`, progress: gate.completedExits / 50 * 100, pass: gate.completedExits >= 50, note: "After modeled costs" },
    { label: "Net return", value: percent(gate.netReturnPercent), progress: gate.netReturnPercent > 0 ? 100 : 0, pass: gate.netReturnPercent > 0, note: "Must stay positive" },
    { label: "Profit factor", value: gate.profitFactor.toFixed(2), progress: gate.profitFactor / 1.2 * 100, pass: gate.profitFactor >= 1.2, note: "Target ≥ 1.20" },
    { label: "Max drawdown", value: percent(gate.maxDrawdownPercent), progress: gate.maxDrawdownPercent <= 10 ? 100 : 0, pass: gate.maxDrawdownPercent <= 10, note: "Limit ≤ 10%" },
    { label: "Profitable weeks", value: `${gate.positiveWeeks} / 3`, progress: gate.positiveWeeks / 3 * 100, pass: gate.positiveWeeks >= 3, note: "Within latest four" },
    { label: "Largest trade share", value: percent(gate.largestTradeProfitShare * (gate.largestTradeProfitShare <= 1 ? 100 : 1)), progress: gate.largestTradeProfitShare <= (gate.largestTradeProfitShare <= 1 ? .35 : 35) ? 100 : 0, pass: gate.largestTradeProfitShare <= (gate.largestTradeProfitShare <= 1 ? .35 : 35), note: "Profit concentration ≤ 35%" },
    { label: "Stress replay", value: percent(gate.stressNetReturnPercent), progress: gate.stressNetReturnPercent >= 0 ? 100 : 0, pass: gate.stressNetReturnPercent >= 0, note: "2× costs + 5 sec delay" },
    { label: "Qualified wallets", value: `${gate.qualifyingWallets} / 2`, progress: gate.qualifyingWallets / 2 * 100, pass: gate.qualifyingWallets >= 2, note: "10 exits each" }
  ];
}

function PaperGate({ gate }: { gate: PromotionGate }) {
  const metrics = buildGateMetrics(gate);
  const passed = metrics.filter((metric) => metric.pass).length;
  return (
    <section className="panel gate-panel">
      <SectionHeader
        eyebrow="Promotion gate"
        title="Paper evidence"
        description={gate.evaluationCohortId
          ? "Forward results must clear every guardrail before real orders are available."
          : `Waiting for exactly ${PAPER_EVALUATION_WALLET_COUNT} research-qualified wallets to freeze the forward cohort; the observation clock remains at zero.`}
        action={<div className="gate-score"><strong>{passed}</strong><span>of {metrics.length}<br />cleared</span></div>}
      />
      <div className="gate-overall"><div style={{ width: `${clamp(passed / metrics.length * 100)}%` }} /></div>
      <div className="gate-grid">
        {metrics.map((metric) => (
          <article className={`gate-metric ${metric.pass ? "passed" : ""}`} key={metric.label}>
            <header><span>{metric.label}</span>{metric.pass ? <Icon name="check" size={15} /> : <span className="metric-open" />}</header>
            <strong>{metric.value}</strong>
            <div className="mini-progress"><span style={{ width: `${clamp(metric.progress)}%` }} /></div>
            <small>{metric.note}</small>
          </article>
        ))}
      </div>
      {gate.blockers.length > 0 && <details className="blocker-list"><summary>{gate.blockers.length} remaining blocker{gate.blockers.length === 1 ? "" : "s"}</summary><ul>{gate.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul></details>}
    </section>
  );
}

function ModeJourney({ snapshot, walletReady, onSelect }: { snapshot: DashboardSnapshot; walletReady: boolean; onSelect: (mode: ModeState) => void }) {
  const effective = snapshot.mode === "PAUSED" ? snapshot.pausedFrom ?? "PAPER" : snapshot.mode;
  const selfHostedSoakReady = snapshot.dataProvider.profile.mode !== "SELF_HOSTED" ||
    snapshot.dataProvider.selfHostedPaperSoak.ready;
  const steps: Array<{ mode: ModeState; label: string; caption: string; unlocked: boolean }> = [
    { mode: "PAPER", label: "Paper", caption: "Observe & simulate", unlocked: true },
    {
      mode: "MANUAL_LIVE",
      label: "Manual live",
      caption: !selfHostedSoakReady
        ? `${snapshot.dataProvider.selfHostedPaperSoak.elapsedDays.toFixed(1)} / ${snapshot.dataProvider.selfHostedPaperSoak.requiredDays} self-hosted soak days`
        : walletReady ? "Approve each order" : "Secure bot wallet first",
      unlocked: snapshot.promotion.paperPassed && walletReady && selfHostedSoakReady
    },
    { mode: "AUTO_LIVE", label: "Auto live", caption: "Unattended copying", unlocked: snapshot.promotion.manualLivePassed }
  ];
  const activeIndex = steps.findIndex((item) => item.mode === effective);

  return (
    <section className="panel mode-panel">
      <SectionHeader eyebrow="Rollout" title="Trading mode" description="Live stages only unlock after measured evidence and explicit confirmation." />
      <div className="mode-journey">
        {steps.map((step, index) => {
          const active = step.mode === effective;
          return (
            <div className={`journey-step ${active ? "active" : ""} ${step.unlocked ? "unlocked" : "locked"}`} key={step.mode}>
              <span className="journey-node">{step.unlocked ? index < activeIndex ? <Icon name="check" size={14} /> : index + 1 : <Icon name="lock" size={14} />}</span>
              <div><strong>{step.label}</strong><small>{step.caption}</small></div>
              {active ? <span className="current-label">Current</span> : step.unlocked && index > activeIndex ? <button onClick={() => onSelect(step.mode)}>Enable</button> : null}
            </div>
          );
        })}
      </div>
      {effective === "MANUAL_LIVE" && (
        <div className="manual-gate-row"><span><strong>{snapshot.promotion.manualLiveOrders}</strong> / 20 approved orders</span><span><strong>{snapshot.promotion.manualCompletedPositions}</strong> / 5 completed positions</span></div>
      )}
      <div className="mode-footnote"><Icon name="shield" size={15} /><span>{!selfHostedSoakReady ? "Manual Live stays blocked until the exact self-hosted endpoint pair completes seven continuous healthy PAPER days." : snapshot.promotion.paperPassed && !walletReady ? "Manual Live stays blocked until the dedicated wallet backup is confirmed." : snapshot.promotion.paperPassed && walletReady && snapshot.mode === "PAPER" ? `Fund the dedicated wallet with about $${DEFAULT_RISK_POLICY.initialSolAllocationUsd} of SOL and ${DEFAULT_RISK_POLICY.initialNavUsd - DEFAULT_RISK_POLICY.initialSolAllocationUsd} USDC before enabling Manual Live.` : "Signing stays disabled in paper mode. API keys cannot sign transactions."}</span></div>
    </section>
  );
}

function downloadRecoveryFile(result: WalletCreationResult): void {
  const file = new Blob([JSON.stringify(result.recovery, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = result.filename.replace(/[\\/]/g, "_");
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function LiveWalletOnboarding({
  status,
  csrfToken,
  onStatusRefresh,
  notify
}: {
  status: SetupStatus["wallet"];
  csrfToken: string;
  onStatusRefresh: () => Promise<SetupStatus>;
  notify: (tone: ToastTone, title: string, detail?: string) => void;
}) {
  const [passphrase, setPassphrase] = useState("");
  const [passphraseConfirm, setPassphraseConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [downloadedName, setDownloadedName] = useState<string | null>(null);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [recoveryFile, setRecoveryFile] = useState<File | null>(null);
  const [restorePassphrase, setRestorePassphrase] = useState("");
  const [restoreConfirmation, setRestoreConfirmation] = useState("");
  const passphraseReady = passphrase.length >= 12 && passphrase === passphraseConfirm;

  async function createWallet() {
    if (!passphraseReady) return;
    setBusy(true);
    try {
      const result = await createLiveWallet(passphrase, csrfToken);
      downloadRecoveryFile(result);
      setDownloadedName(result.filename);
      setPassphrase("");
      setPassphraseConfirm("");
      await onStatusRefresh();
      notify("success", "Recovery backup downloaded", `${result.filename} contains the encrypted recovery material for ${shortKey(result.address)}.`);
    } catch (reason) {
      notify("danger", "Wallet creation failed", reason instanceof Error ? reason.message : "Unknown error");
    } finally {
      setBusy(false);
    }
  }

  async function confirmBackup() {
    if (!status.address || !acknowledged) return;
    setBusy(true);
    try {
      await confirmWalletBackup(status.address, csrfToken);
      await onStatusRefresh();
      setAcknowledged(false);
      notify("success", "Backup confirmed", "Live funding remains gated by the promotion checks and your mode confirmation.");
    } catch (reason) {
      notify("danger", "Backup confirmation failed", reason instanceof Error ? reason.message : "Unknown error");
    } finally {
      setBusy(false);
    }
  }

  async function redownloadPendingRecovery() {
    if (!status.address) return;
    setBusy(true);
    try {
      const result = await getPendingWalletRecovery(status.address, csrfToken);
      downloadRecoveryFile(result);
      setDownloadedName(result.filename);
      notify("success", "Recovery backup downloaded again", "Confirm only after the encrypted JSON is stored safely.");
    } catch (reason) {
      notify("danger", "Recovery export failed", reason instanceof Error ? reason.message : "Unknown error");
    } finally {
      setBusy(false);
    }
  }

  async function restoreWallet() {
    if (
      !recoveryFile ||
      restorePassphrase.length < 12 ||
      restoreConfirmation !== "RESTORE COPYLAB WALLET"
    ) return;
    setBusy(true);
    try {
      const text = await recoveryFile.text();
      const recovery = JSON.parse(text) as unknown;
      if (!recovery || typeof recovery !== "object" || Array.isArray(recovery)) {
        throw new Error("The selected recovery JSON is malformed.");
      }
      await restoreLiveWallet(
        recovery as Record<string, unknown>,
        restorePassphrase,
        "RESTORE COPYLAB WALLET",
        csrfToken
      );
      setRecoveryFile(null);
      setRestorePassphrase("");
      setRestoreConfirmation("");
      setRestoreOpen(false);
      await onStatusRefresh();
      notify("success", "Dedicated wallet restored", "Signing remains disabled until every live promotion and balance check passes.");
    } catch (reason) {
      notify("danger", "Wallet recovery failed", reason instanceof Error ? reason.message : "Unknown error");
    } finally {
      setBusy(false);
    }
  }

  async function copyAddress() {
    if (!status.address) return;
    try {
      await navigator.clipboard.writeText(status.address);
      notify("success", "Wallet address copied");
    } catch {
      notify("danger", "Could not copy address", "Select the address and copy it manually.");
    }
  }

  return (
    <section className={`panel live-wallet-panel ${status.backupConfirmed ? "wallet-ready" : ""}`}>
      <SectionHeader
        eyebrow="Dedicated signer"
        title="Live wallet"
        description="Create a separate bot wallet only after paper evidence passes. Your primary-wallet recovery phrase is never requested."
        action={status.backupConfirmed ? <span className="wallet-ready-badge"><Icon name="check" size={14} />Backup confirmed</span> : <span className="wallet-blocked-badge"><Icon name="lock" size={13} />Funding blocked</span>}
      />

      {!status.exists && (
        <div className="wallet-onboarding-body">
          <div className="wallet-security-copy">
            <span className="wallet-hero-icon"><Icon name="wallet" size={24} /></span>
            <h3>Create an isolated bot wallet</h3>
            <p>Choose a strong passphrase for the encrypted recovery file. CopyLab will download the JSON once; keep it somewhere offline before funding.</p>
            <ul><li>Never paste an existing seed phrase</li><li>Never fund more than you can lose</li><li>Only bot-created lots can be emergency-sold</li></ul>
          </div>
          <div className="wallet-create-form">
            <label><span>Backup passphrase</span><input type="password" autoComplete="new-password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} placeholder="At least 12 characters" /></label>
            <label><span>Confirm passphrase</span><input type="password" autoComplete="new-password" value={passphraseConfirm} onChange={(event) => setPassphraseConfirm(event.target.value)} placeholder="Repeat passphrase" /></label>
            <div className="passphrase-hint"><span className={passphrase.length >= 12 ? "pass" : ""}><Icon name="check" size={12} />12+ characters</span><span className={passphrase.length > 0 && passphrase === passphraseConfirm ? "pass" : ""}><Icon name="check" size={12} />Passphrases match</span></div>
            <Button tone="primary" icon="lock" busy={busy} disabled={!passphraseReady} onClick={() => void createWallet()}>Create & download backup</Button>
            <Button tone="ghost" disabled={busy} onClick={() => setRestoreOpen((value) => !value)}>
              {restoreOpen ? "Cancel recovery" : "Restore encrypted backup"}
            </Button>
            {restoreOpen && (
              <div className="wallet-restore-form">
                <label><span>Recovery JSON</span><input type="file" accept="application/json,.json" onChange={(event) => setRecoveryFile(event.target.files?.[0] ?? null)} /></label>
                <label><span>Backup passphrase</span><input type="password" autoComplete="current-password" value={restorePassphrase} onChange={(event) => setRestorePassphrase(event.target.value)} placeholder="Recovery-file passphrase" /></label>
                <label><span>Type RESTORE COPYLAB WALLET</span><input value={restoreConfirmation} onChange={(event) => setRestoreConfirmation(event.target.value.toUpperCase())} autoComplete="off" spellCheck={false} /></label>
                <Button
                  tone="primary"
                  busy={busy}
                  disabled={!recoveryFile || restorePassphrase.length < 12 || restoreConfirmation !== "RESTORE COPYLAB WALLET"}
                  onClick={() => void restoreWallet()}
                >Restore dedicated wallet</Button>
              </div>
            )}
          </div>
        </div>
      )}

      {status.exists && !status.backupConfirmed && (
        <div className="wallet-confirm-body">
          <span className="wallet-file-icon"><Icon name="database" size={23} /></span>
          <div className="wallet-confirm-copy"><h3>Confirm the recovery file is safe.</h3><p>{downloadedName ? <><code>{downloadedName}</code> was downloaded by your browser.</> : <>The encrypted recovery file was created earlier. Confirm only if you have it and know its passphrase.</>} CopyLab cannot display the recovery material again.</p><div className="wallet-address-row"><span>{status.address}</span><button onClick={() => void copyAddress()} aria-label="Copy bot wallet address"><Icon name="copy" size={14} />Copy address</button></div><label className="check-row wallet-ack"><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} /><span>I saved the encrypted recovery JSON and can open it with my passphrase.</span></label></div>
          <div className="wallet-confirm-actions">
            <Button tone="ghost" busy={busy} onClick={() => void redownloadPendingRecovery()}>Download backup again</Button>
            <Button tone="primary" busy={busy} disabled={!acknowledged} onClick={() => void confirmBackup()}>Confirm backup</Button>
          </div>
        </div>
      )}

      {status.exists && status.backupConfirmed && (
        <div className="wallet-ready-body">
          <span className="wallet-file-icon wallet-check-icon"><Icon name="shield" size={23} /></span>
          <div><h3>Dedicated wallet secured</h3><p>The encrypted backup is confirmed. Funding and signing still remain subject to the live-mode promotion gate.</p><div className="wallet-address-row"><span>{status.address ?? "Address unavailable"}</span>{status.address && <button onClick={() => void copyAddress()} aria-label="Copy bot wallet address"><Icon name="copy" size={14} />Copy address</button>}</div></div>
          <div className="wallet-ready-rule"><Icon name="alert" size={15} /><span>After the paper gate passes, fund about ${DEFAULT_RISK_POLICY.initialSolAllocationUsd} of SOL plus {DEFAULT_RISK_POLICY.initialNavUsd - DEFAULT_RISK_POLICY.initialSolAllocationUsd} USDC before enabling Manual Live.</span></div>
        </div>
      )}
    </section>
  );
}

function WalletTable({ wallets }: { wallets: WalletRow[] }) {
  const [filter, setFilter] = useState<"all" | "qualified" | "shadow" | "control">("all");
  const filters = [
    { key: "all", label: "All" },
    { key: "qualified", label: "Qualified" },
    { key: "shadow", label: "Shadow" },
    { key: "control", label: "Controls / losers" }
  ] as const;
  const visible = wallets.filter((wallet) => {
    const lane = classifyWallet(wallet);
    return filter === "all" || lane.key === filter;
  });
  return (
    <section className="panel table-panel">
      <SectionHeader eyebrow="Frozen cohort" title="Wallet research" description="Historical rank shortlists candidates; preserved loss-side controls expose selection bias, while forward copy quality decides promotion." action={<div className="segmented" role="group" aria-label="Wallet filter">{filters.map((item) => <button className={filter === item.key ? "active" : ""} key={item.key} onClick={() => setFilter(item.key)}>{item.label}</button>)}</div>} />
      {visible.length === 0 ? <EmptyState icon="wallet" title="No matching wallets" detail={wallets.length === 0 ? "Discovery will populate the next frozen evaluation cohort." : "Try a different cohort filter."} /> : (
        <div className="table-scroll"><table>
          <thead><tr><th>Wallet</th><th>Cohort lane</th><th>30-day realized</th><th>90-day realized</th><th>Eligible swaps</th><th>Median hold</th><th>Forward return</th></tr></thead>
          <tbody>{visible.map((wallet) => {
            const lane = classifyWallet(wallet);
            return <tr className={lane.key === "control" ? "wallet-row-control" : ""} key={wallet.address}>
            <td><div className="wallet-cell"><a href={`https://solscan.io/account/${wallet.address}`} target="_blank" rel="noreferrer" title={wallet.address}>{shortKey(wallet.address, 5, 5)}</a><div>{lane.key === "control" && <span className="tag tag-control">Preserved loser</span>}{wallet.tags.slice(0, 2).map((tag) => <span className="tag" key={tag}>{tag}</span>)}</div>{lane.key === "control" && <small className="control-note">Loss-side bias benchmark · never promoted</small>}</div></td>
            <td><div className="number-stack"><span className={`status-pill status-${lane.key}`}>{lane.key === "control" ? <span className="tiny-dot" /> : <StatusDot ok={lane.key === "qualified" ? true : lane.key === "pending" ? "warning" : false} />}{lane.label}</span><small>{lane.detail}</small></div></td>
            <td>{wallet.pnl30d ? <div className="number-stack"><ValueDelta value={wallet.pnl30d.realizedProfitPercent} suffix="%" /><small>{money(wallet.pnl30d.realizedProfitUsd, true)}</small></div> : "—"}</td>
            <td>{wallet.pnl90d ? <div className="number-stack"><ValueDelta value={wallet.pnl90d.realizedProfitPercent} suffix="%" /><small>{money(wallet.pnl90d.realizedProfitUsd, true)}</small></div> : "—"}</td>
            <td>{wallet.score ? count(wallet.score.closedEligibleSwaps) : "—"}</td>
            <td>{wallet.score ? `${count(wallet.score.medianHoldingMinutes)} min` : "—"}</td>
            <td>{wallet.score?.forwardNetReturnPercent !== undefined ? <ValueDelta value={wallet.score.forwardNetReturnPercent} suffix="%" /> : <span className="muted">Collecting</span>}</td>
          </tr>})}</tbody>
        </table></div>
      )}
    </section>
  );
}

function SignalStatus({ status }: { status: SignalAuditRecord["status"] }) {
  const className = status === "CONFIRMED" || status === "SIMULATED" || status === "APPROVED"
    ? "status-confirmed"
    : status === "FAILED" || status === "REJECTED"
      ? "status-failed"
      : status === "AWAITING_APPROVAL" || status === "SUBMITTED" || status === "SUBMITTED_UNRESOLVED" || status === "RETRY_PENDING"
        ? "status-waiting"
        : "status-skipped";
  return <span className={`status-pill ${className}`}><span className="tiny-dot" />{titleCase(status)}</span>;
}

const SOLANA_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,96}$/u;

export function safeSolscanTransactionUrl(signature: string | undefined): string | undefined {
  return signature && SOLANA_SIGNATURE.test(signature)
    ? `https://solscan.io/tx/${encodeURIComponent(signature)}`
    : undefined;
}

function TransactionLink({ signature }: { signature: string | undefined }) {
  if (!signature) return <span className="muted">—</span>;
  const url = safeSolscanTransactionUrl(signature);
  return url
    ? <a href={url} target="_blank" rel="noreferrer" title={signature}>{shortKey(signature)}</a>
    : <span className="muted" title="This source identifier is local and is not a Solana transaction signature.">{shortKey(signature)}</span>;
}

export function SignalOutcomesTable({ signals }: { signals: SignalAuditRecord[] }) {
  return (
    <section className="panel table-panel">
      <SectionHeader eyebrow="Audit trail" title="Recent signal outcomes" description="Every observed source action has one structured outcome, including analysis-only, blocked, rejected, simulated, and live states." />
      {signals.length === 0 ? <EmptyState icon="activity" title="No source signals recorded yet" detail="Blocked, rejected, simulated, and executed outcomes will appear after a leader swap is observed." /> : (
        <div className="table-scroll"><table>
          <thead><tr><th>Status</th><th>Observed</th><th>Action</th><th>Position value</th><th>Impact</th><th>Cost / shortfall</th><th>Reason</th><th>Leader transaction</th><th>Bot transaction</th></tr></thead>
          <tbody>{signals.map((signal) => <tr key={signal.idempotencyKey}>
            <td><SignalStatus status={signal.status} /></td>
            <td><div className="number-stack"><span>{dateTime(signal.observedAt)}</span><small>{signal.mode}</small></div></td>
            <td><span className="route-cell">{titleCase(signal.action)} <Icon name="arrow" size={13} /> {tokenLabel(signal.mint)}</span></td>
            <td>{signal.positionValueUsd !== undefined ? money(signal.positionValueUsd) : "—"}</td>
            <td>{signal.priceImpactPercent !== undefined ? percent(signal.priceImpactPercent, 2) : "—"}</td>
            <td><div className="number-stack"><span>{signal.actualFeesUsd !== undefined ? money(signal.actualFeesUsd) : "—"}</span><small>{signal.implementationShortfallPercent !== undefined ? `${percent(signal.implementationShortfallPercent, 2)} shortfall` : "—"}</small></div></td>
            <td><div className="number-stack"><span>{signal.reason}</span><small>{titleCase(signal.reasonCode)}{signal.decisionCode ? ` · ${titleCase(signal.decisionCode)}` : ""}</small></div></td>
            <td><TransactionLink signature={signal.sourceSignature} /></td>
            <td><TransactionLink signature={signal.targetSignature} /></td>
          </tr>)}</tbody>
        </table></div>
      )}
    </section>
  );
}

function PositionsTable({ positions }: { positions: PositionLot[] }) {
  return (
    <section className="panel table-panel positions-panel">
      <SectionHeader eyebrow="Inventory" title="Open positions" description="Executable sell quotes determine live value; deposits outside bot-created lots are excluded." />
      {positions.length === 0 ? <EmptyState icon="database" title="No open positions" detail="Eligible copied entries will appear here with their originating wallet." /> : (
        <div className="table-scroll"><table>
          <thead><tr><th>Token</th><th>Origin wallet</th><th>Opened</th><th>Cost basis</th><th>Executable value</th><th>Unrealized P&L</th><th>Exit pending</th><th>Status</th></tr></thead>
          <tbody>{positions.map((position) => {
            const pnl = position.lastExecutableValueUsd - position.remainingCostUsd;
            const pnlPct = position.remainingCostUsd > 0 ? pnl / position.remainingCostUsd * 100 : 0;
            return <tr key={position.id}>
              <td><a href={`https://solscan.io/token/${position.mint}`} target="_blank" rel="noreferrer" title={position.mint}>{tokenLabel(position.mint)}</a></td>
              <td><a href={`https://solscan.io/account/${position.sourceWallet}`} target="_blank" rel="noreferrer" title={position.sourceWallet}>{shortKey(position.sourceWallet)}</a></td>
              <td>{dateTime(position.openedAt)}</td><td>{money(position.remainingCostUsd)}</td><td>{money(position.lastExecutableValueUsd)}</td>
              <td><div className="number-stack"><ValueDelta value={pnl} /><small className={pnl >= 0 ? "positive" : "negative"}>{pnl >= 0 ? "+" : ""}{percent(pnlPct)}</small></div></td>
              <td>{position.pendingExitFraction > 0 ? percent(position.pendingExitFraction * 100, 0) : "—"}</td><td><span className={`status-pill status-${position.status.toLowerCase()}`}>{titleCase(position.status)}</span></td>
            </tr>;
          })}</tbody>
        </table></div>
      )}
    </section>
  );
}

function ApprovalQueue({ approvals, busyId, onDecision }: { approvals: ExecutionRecord[]; busyId: string | null; onDecision: (id: string, decision: "approve" | "reject") => void }) {
  return (
    <section className="panel approvals-panel">
      <SectionHeader eyebrow="Manual live" title="Approval queue" description="Quotes expire quickly. Review route, size, impact, and estimated fees before signing." action={approvals.length > 0 ? <span className="queue-count">{approvals.length} pending</span> : undefined} />
      {approvals.length === 0 ? <EmptyState icon="check" title="Queue is clear" detail="No live order is waiting for your approval." /> : <div className="approval-list">{approvals.map((approval) => <article className="approval-card" key={approval.id}>
        <div className="approval-route"><span className="token-chip">{tokenLabel(approval.quote.inputMint)}</span><Icon name="arrow" size={17} /><span className="token-chip token-chip-output">{tokenLabel(approval.quote.outputMint)}</span></div>
        <div className="approval-metrics"><div><span>Input</span><strong>{money(approval.quote.inputUsd)}</strong></div><div><span>Expected output</span><strong>{money(approval.quote.outputUsd)}</strong></div><div><span>Price impact</span><strong>{percent(approval.quote.priceImpactPercent, 2)}</strong></div><div><span>Slippage</span><strong>{approval.quote.slippageBps} bps</strong></div></div>
        <div className="approval-meta"><span>From {shortKey(approval.sourceSignature)}</span><span>{approval.quote.expiresAt ? `Expires ${relativeTime(approval.quote.expiresAt)}` : `Quoted ${relativeTime(approval.quote.quotedAt)}`}</span></div>
        <div className="approval-actions"><Button tone="danger" busy={busyId === approval.id} onClick={() => onDecision(approval.id, "reject")}>Reject</Button><Button tone="primary" busy={busyId === approval.id} onClick={() => onDecision(approval.id, "approve")}>Approve order</Button></div>
      </article>)}</div>}
    </section>
  );
}

export function Dashboard({ snapshot, csrfToken, streamConnected, refreshing, onRefresh, setupStatus, onSetupRefresh, notify }: DashboardProps) {
  const [workspace, setWorkspace] = useState<MarketFloorWorkspace>("STOCK");
  const [controlBusy, setControlBusy] = useState(false);
  const [approvalBusy, setApprovalBusy] = useState<string | null>(null);
  const [exitOpen, setExitOpen] = useState(false);
  const [exitPhrase, setExitPhrase] = useState("");
  const [modeTarget, setModeTarget] = useState<ModeState | null>(null);
  const [modePhrase, setModePhrase] = useState("");

  const portfolio = snapshot.portfolio;
  const totalPnl = portfolio.realizedPnlUsd + portfolio.unrealizedPnlUsd;
  const navReturn = portfolio.navUsd > 0 ? totalPnl / Math.max(1, portfolio.navUsd - totalPnl) * 100 : 0;
  const drawdown = portfolio.peakNavUsd > 0 ? Math.max(0, (portfolio.peakNavUsd - portfolio.navUsd) / portfolio.peakNavUsd * 100) : 0;
  const dailyReturn = portfolio.dayStartNavUsd > 0 ? (portfolio.navUsd - portfolio.dayStartNavUsd) / portfolio.dayStartNavUsd * 100 : 0;
  const healthyProviders = snapshot.providerHealth.filter((provider) => provider.ok).length;
  const openPositions = snapshot.positions.filter((position) => position.status === "OPEN" || position.status === "CLOSING");
  const modeConfirmText = modeTarget ? `ENABLE ${modeTarget.replace("_", " ")}` : "";
  const effectiveMode = snapshot.mode === "PAUSED" ? snapshot.pausedFrom ?? "PAPER" : snapshot.mode;
  const pauseReasonLabels: Record<string, string> = {
    DAILY_LOSS: "daily loss limit",
    LIVE_START_LOSS: "live-start loss limit",
    PEAK_DRAWDOWN: "peak drawdown limit",
    HELIUS_OUTAGE: "Helius outage",
    STALE_QUOTE: "stale quote",
    BALANCE_MISMATCH: "wallet balance mismatch",
    REPEATED_EXECUTION_FAILURES: "repeated failed transactions",
    LEGACY_SAFETY_PAUSE: "previous safety pause awaiting review"
  };
  const operationalPause = snapshot.operationalPause;
  const operationalDetail = operationalPause?.active
    ? `New buys are blocked: ${operationalPause.reasons.map((reason) => pauseReasonLabels[reason] ?? titleCase(reason)).join(", ")}. ${
      operationalPause.recovery === "NEXT_UTC_DAY"
        ? "This hold lasts through the current UTC day."
        : operationalPause.recovery === "MANUAL_REVIEW"
          ? "A clean explicit safety recheck is required."
          : "The system will resume automatically after the condition clears."
    }`
    : "";
  const riskAlert = snapshot.mode === "LOCKED"
    ? { tone: "danger", title: "Live mode is locked", detail: "A hard risk limit was reached. Review the ledger before any new live session.", recheck: false }
    : snapshot.mode === "PAUSED"
      ? { tone: "warning", title: "Copying is paused", detail: `The system was paused from ${titleCase(snapshot.pausedFrom ?? "PAPER")}. Existing positions remain monitored.`, recheck: false }
      : operationalPause?.active
        ? { tone: "warning", title: "Safety hold on new entries", detail: operationalDetail, recheck: operationalPause.recovery === "MANUAL_REVIEW" }
        : snapshot.operationalTelemetry?.blocksNewEntries
          ? { tone: "warning", title: "Local data-stack evidence blocks new entries", detail: "Critical or unavailable SQLite, queue, repair, or audit evidence needs operator review.", recheck: false }
        : snapshot.providerHealth.some((provider) => !provider.ok)
          ? { tone: "warning", title: "A provider needs attention", detail: "New entries may pause until all required data sources are healthy.", recheck: false }
          : null;

  const navGauge = useMemo(() => clamp(portfolio.deployedUsd / Math.max(1, portfolio.navUsd) * 100), [portfolio.deployedUsd, portfolio.navUsd]);

  async function runControl(action: "pause" | "resume") {
    setControlBusy(true);
    try {
      if (action === "pause") await pauseSystem(csrfToken);
      else await resumeSystem(csrfToken);
      notify("success", action === "pause" ? "New entries paused" : "Monitoring resumed");
      await onRefresh();
    } catch (reason) {
      notify("danger", `Could not ${action}`, reason instanceof Error ? reason.message : "Unknown error");
    } finally {
      setControlBusy(false);
    }
  }

  async function runSafetyRecheck() {
    setControlBusy(true);
    try {
      await recheckNewEntries(csrfToken);
      notify("success", "Safety hold cleared", "Current conditions passed a fresh operational check.");
      await onRefresh();
    } catch (reason) {
      notify("danger", "Safety hold remains active", reason instanceof Error ? reason.message : "Unknown error");
    } finally {
      setControlBusy(false);
    }
  }

  async function runApproval(id: string, decision: "approve" | "reject") {
    setApprovalBusy(id);
    try {
      await decideApproval(id, decision, csrfToken);
      notify("success", decision === "approve" ? "Order approved" : "Order rejected", decision === "approve" ? "The validated transaction was released for signing." : "The order will remain in the audit ledger.");
      await onRefresh();
    } catch (reason) {
      notify("danger", "Approval action failed", reason instanceof Error ? reason.message : "Unknown error");
    } finally {
      setApprovalBusy(null);
    }
  }

  async function runModeChange() {
    if (!modeTarget || modePhrase !== modeConfirmText) return;
    setControlBusy(true);
    try {
      await changeMode(modeTarget, modePhrase, csrfToken);
      notify("success", `${titleCase(modeTarget)} enabled`, "The mode change was written to the audit ledger.");
      setModeTarget(null);
      setModePhrase("");
      await onRefresh();
    } catch (reason) {
      notify("danger", "Mode change was blocked", reason instanceof Error ? reason.message : "Unknown error");
    } finally {
      setControlBusy(false);
    }
  }

  async function runEmergencyExit() {
    if (exitPhrase !== "EXIT ALL POSITIONS") return;
    setControlBusy(true);
    try {
      const result = await emergencyExit(exitPhrase, csrfToken);
      notify(
        result.failed === 0 ? "success" : "danger",
        result.failed === 0 ? "Emergency exit confirmed" : "Emergency exit needs review",
        `${result.closed} position(s) closed and ${result.failed} failed. Live mode is locked.`
      );
      setExitOpen(false);
      setExitPhrase("");
      await onRefresh();
    } catch (reason) {
      notify("danger", "Emergency exit failed", reason instanceof Error ? reason.message : "Unknown error");
    } finally {
      setControlBusy(false);
    }
  }

  const strictMetrics = (
    <section className="metrics-grid command-metrics-grid">
      <article className="metric-card metric-primary"><header><span>Strict-copy NAV</span><Icon name="wallet" size={18} /></header><strong>{money(portfolio.navUsd)}</strong><footer><ValueDelta value={navReturn} suffix="%" /><span>all-time return</span></footer></article>
      <article className="metric-card"><header><span>Strict-copy P&amp;L</span><Icon name="trend" size={18} /></header><strong className={totalPnl >= 0 ? "positive" : "negative"}>{totalPnl >= 0 ? "+" : ""}{money(totalPnl)}</strong><footer><ValueDelta value={dailyReturn} suffix="%" /><span>today</span></footer></article>
      <article className="metric-card"><header><span>Capital deployed</span><Icon name="database" size={18} /></header><strong>{money(portfolio.deployedUsd)}</strong><div className="card-progress"><span style={{ width: `${navGauge}%` }} /></div><footer><span>{percent(navGauge, 0)} of NAV</span><span>{openPositions.length} / 3 positions</span></footer></article>
      <article className="metric-card"><header><span>Peak drawdown</span><Icon name="shield" size={18} /></header><strong className={drawdown >= 8 ? "negative" : ""}>{percent(drawdown)}</strong><div className="card-progress drawdown"><span style={{ width: `${clamp(drawdown / 10 * 100)}%` }} /></div><footer><span>{money(portfolio.peakNavUsd)} peak</span><span>10% hard stop</span></footer></article>
      <article className="metric-card"><header><span>Liquid reserves</span><Icon name="spark" size={18} /></header><strong>{money(portfolio.liquidReserveUsd)}</strong><footer><span>{money(portfolio.solReserveUsd)} held as SOL</span><span>Total uncommitted</span></footer></article>
    </section>
  );

  let workspaceContent: ReactNode;
  switch (workspace) {
    case "MARKETPLACE":
      workspaceContent = <MarketplaceWorkspace
        csrfToken={csrfToken}
        onOpenProviders={() => setWorkspace("PROVIDERS")}
      />;
      break;
    case "STOCK":
      workspaceContent = <StockMomentumWorkspace stock={snapshot.stockPaper} />;
      break;
    case "STRICT":
      workspaceContent = <div className="command-workspace-stack">
        {strictMetrics}
        <PositionsTable positions={snapshot.positions} />
        <SignalOutcomesTable signals={snapshot.recentSignals} />
      </div>;
      break;
    case "HIGH_RISK":
      workspaceContent = snapshot.researchPaper ? <ResearchPaperPanel
        research={snapshot.researchPaper}
        strictNavUsd={portfolio.navUsd}
        csrfToken={csrfToken}
        onRefresh={onRefresh}
        notify={notify}
      /> : <EmptyState icon="copy" title="High-risk copy is preparing" detail="The isolated high-risk wallet-copy lane will appear after its first PAPER account snapshot." />;
      break;
    case "AUTONOMOUS":
      workspaceContent = snapshot.autonomousPaper ? <AutonomousPaperPanel
        autonomous={snapshot.autonomousPaper}
        strictNavUsd={portfolio.navUsd}
        csrfToken={csrfToken}
        onRefresh={onRefresh}
        notify={notify}
      /> : <EmptyState icon="spark" title="Autonomous momentum is preparing" detail="The autonomous PAPER lane will appear after its first market scan." />;
      break;
    case "WALLETS":
      workspaceContent = <div className="command-workspace-stack">
        <WalletIndexPanel index={snapshot.walletIndex} />
        <WalletResearchExplorer index={snapshot.walletIndex} />
        <WalletTable wallets={snapshot.activeWallets} />
      </div>;
      break;
    case "PROVIDERS":
      workspaceContent = <div className="command-workspace-stack">
        <section className="provider-section">
          <div className="provider-heading">
            <div><p className="eyebrow">System health</p><h2>Data providers</h2></div>
            <span className={healthyProviders === snapshot.providerHealth.length ? "positive" : "negative"}>{healthyProviders} / {snapshot.providerHealth.length} healthy</span>
          </div>
          <div className="provider-grid">
            {snapshot.dataProvider ? <DataProviderControl status={snapshot.dataProvider} appMode={snapshot.mode} csrfToken={csrfToken} onRefresh={onRefresh} notify={notify} /> : <div className="provider-placeholder">Local data-stack status will appear after the coordinated server update.</div>}
            {snapshot.providerHealth.length > 0 ? snapshot.providerHealth.map((health) => <ProviderCard health={health} key={health.provider} />) : <div className="provider-placeholder">Provider diagnostics are pending.</div>}
          </div>
        </section>
        <AlpacaPaperSetupCard appMode={snapshot.mode} csrfToken={csrfToken} notify={notify} />
        <SolPriceBootstrapControl status={snapshot.solPriceBootstrap} appMode={snapshot.mode} csrfToken={csrfToken} onRefresh={onRefresh} notify={notify} />
      </div>;
      break;
    case "RISK":
      workspaceContent = <div className="command-workspace-stack">
        <OperationalTelemetryPanel telemetry={snapshot.operationalTelemetry} />
        {snapshot.pendingApprovals.length > 0 && <ApprovalQueue approvals={snapshot.pendingApprovals} busyId={approvalBusy} onDecision={runApproval} />}
        <div className="dashboard-split"><PaperGate gate={snapshot.promotion} /><ModeJourney snapshot={snapshot} walletReady={setupStatus.wallet.backupConfirmed} onSelect={(mode) => { setModeTarget(mode); setModePhrase(""); }} /></div>
        {snapshot.promotion.paperPassed && <LiveWalletOnboarding status={setupStatus.wallet} csrfToken={csrfToken} onStatusRefresh={onSetupRefresh} notify={notify} />}
      </div>;
      break;
    case "AUDIT":
      workspaceContent = <div className="command-workspace-stack">
        {snapshot.paperComparisons && <PaperComparisonPanel comparisons={snapshot.paperComparisons} />}
        <SignalOutcomesTable signals={snapshot.recentSignals} />
        <PositionsTable positions={snapshot.positions} />
      </div>;
      break;
  }

  const riskBannerNode = riskAlert ? <div className={`risk-banner market-floor-risk-banner risk-${riskAlert.tone}`}><Icon name="alert" size={19} /><div><strong>{riskAlert.title}</strong><p>{riskAlert.detail}</p></div>{riskAlert.recheck && <Button tone="secondary" busy={controlBusy} onClick={() => void runSafetyRecheck()}>Recheck safety</Button>}</div> : undefined;
  const topbarActions = <>
    {snapshot.mode === "PAUSED"
      ? <Button tone="secondary" icon="play" busy={controlBusy} onClick={() => void runControl("resume")}>Resume</Button>
      : <Button tone="secondary" icon="pause" busy={controlBusy} disabled={snapshot.mode === "LOCKED"} onClick={() => void runControl("pause")}>Pause</Button>}
    <Button tone="danger" icon="alert" disabled={effectiveMode === "PAPER"} onClick={() => setExitOpen(true)}>Emergency exit</Button>
  </>;

  return (
    <div className="app-shell">
      <HolographicMarketFloor
        snapshot={snapshot}
        selected={workspace}
        onSelect={setWorkspace}
        streamConnected={streamConnected}
        refreshing={refreshing}
        onRefresh={() => void onRefresh()}
        topbarActions={topbarActions}
        riskBanner={riskBannerNode}
        workspace={workspaceContent}
        footer={<footer className="app-footer market-floor-footer"><Icon name="alert" size={14} /><p><strong>PAPER TRADING ONLY.</strong> Performance is simulated and is not indicative of future results. No real money is at risk in PAPER mode.</p><span>Balance match {percent(portfolio.balanceMismatchPercent, 2)}</span></footer>}
      />

      <Modal open={modeTarget !== null} onClose={() => { setModeTarget(null); setModePhrase(""); }} title={`Enable ${modeTarget ? titleCase(modeTarget) : "live mode"}?`} description={modeTarget === "AUTO_LIVE" ? "Auto live can submit validated orders without waiting for approval. All hard risk stops remain active." : "Manual live can sign only orders you approve. Use a dedicated bot wallet and fund only what you can lose."} danger>
        <div className="confirmation-box"><p>Type <code>{modeConfirmText}</code> to confirm.</p><input autoFocus value={modePhrase} onChange={(event) => setModePhrase(event.target.value.toUpperCase())} placeholder={modeConfirmText} /></div>
        <div className="modal-actions"><Button tone="ghost" onClick={() => { setModeTarget(null); setModePhrase(""); }}>Cancel</Button><Button tone="danger" busy={controlBusy} disabled={modePhrase !== modeConfirmText} onClick={() => void runModeChange()}>Enable mode</Button></div>
      </Modal>

      <Modal open={exitOpen} onClose={() => { setExitOpen(false); setExitPhrase(""); }} title="Emergency exit all positions?" description="This cancels queued entries, attempts to sell only bot-created positions to USDC, and locks live mode for review. Unrelated deposits are not touched." danger>
        <div className="emergency-facts"><div><span>Tracked positions</span><strong>{openPositions.length}</strong></div><div><span>Executable value</span><strong>{money(openPositions.reduce((sum, position) => sum + position.lastExecutableValueUsd, 0))}</strong></div></div>
        <div className="confirmation-box"><p>Type <code>EXIT ALL POSITIONS</code> to confirm.</p><input autoFocus value={exitPhrase} onChange={(event) => setExitPhrase(event.target.value.toUpperCase())} placeholder="EXIT ALL POSITIONS" /></div>
        <div className="modal-actions"><Button tone="ghost" onClick={() => { setExitOpen(false); setExitPhrase(""); }}>Cancel</Button><Button tone="danger" busy={controlBusy} disabled={exitPhrase !== "EXIT ALL POSITIONS"} onClick={() => void runEmergencyExit()}>Exit & lock</Button></div>
      </Modal>
    </div>
  );
}
