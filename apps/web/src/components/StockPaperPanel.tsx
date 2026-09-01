import type {
  StockPaperDashboard,
  StockPaperEquityPoint
} from "@copylab/shared";
import { count, dateTime, money, percent, relativeTime, titleCase } from "../format";
import {
  normalizedStockEquitySeries,
  smoothStockChartPath,
  stockChartScale
} from "../stock-equity-chart";
import { Icon } from "./Icon";
import { EmptyState, SectionHeader, StatusDot } from "./Primitives";

function signedMoney(value: number): string {
  return `${value >= 0 ? "+" : ""}${money(value)}`;
}

function signedPercent(value: number): string {
  return `${value >= 0 ? "+" : ""}${percent(value)}`;
}

function points(
  values: readonly number[],
  minimum: number,
  maximum: number,
  width = 600,
  height = 180,
  offsetX = 0
): string {
  const range = maximum - minimum || 1;
  return values.map((value, index) => {
    const x = offsetX + (values.length <= 1 ? 0 : index / (values.length - 1) * width);
    const y = height - (value - minimum) / range * height;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
}

function chartTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function chartIndex(value: number): string {
  return Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1);
}

export function StockEquityChart({
  curve
}: {
  curve: readonly StockPaperEquityPoint[];
}) {
  if (curve.length < 2) {
    return <div className="stock-chart-empty"><Icon name="trend" size={20} /><span>The equity graph starts after two live-data marks.</span></div>;
  }
  const { strategy, benchmark } = normalizedStockEquitySeries(curve);
  const { minimum, maximum, ticks: yTicks } = stockChartScale({ strategy, benchmark });
  const baselineY = 180 - (100 - minimum) / (maximum - minimum || 1) * 180;
  const plotOffsetX = 12;
  const plotWidth = 588;
  const strategyPath = smoothStockChartPath(strategy, minimum, maximum, plotWidth, 180, plotOffsetX);
  const benchmarkPath = smoothStockChartPath(benchmark, minimum, maximum, plotWidth, 180, plotOffsetX);
  const timeTicks = Array.from({ length: Math.min(6, curve.length) }, (_, index) =>
    curve[Math.round(index * (curve.length - 1) / Math.max(1, Math.min(6, curve.length) - 1))]!
  );
  return <div className="stock-chart">
    <div className="stock-chart-legend"><span className="strategy">Strategy Equity</span><span className="benchmark">SPY (Benchmark)</span><strong>{signedPercent((strategy.at(-1) ?? 100) - 100)}</strong></div>
    <svg key={curve.at(-1)!.capturedAt} viewBox="0 0 600 180" preserveAspectRatio="none" role="img" aria-label="Stock paper equity return compared with SPY">
      <defs>
        <linearGradient id="stock-equity-fill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="#a9f66f" stopOpacity=".09" />
          <stop offset="100%" stopColor="#a9f66f" stopOpacity="0" />
        </linearGradient>
      </defs>
      <g className="stock-chart-y-ticks">
        {yTicks.map((tick, index) => {
          const y = index / 4 * 180;
          return <g key={`${tick}-${index}`}>
            <line x1={plotOffsetX} x2="600" y1={y} y2={y} />
            <text x="2" y={Math.min(176, Math.max(8, y + 3))}>{chartIndex(tick)}</text>
          </g>;
        })}
      </g>
      <g className="stock-chart-x-ticks">
        {Array.from({ length: 7 }, (_, index) => {
          const x = plotOffsetX + plotWidth * index / 6;
          return <line key={index} x1={x} x2={x} y1="0" y2="180" />;
        })}
      </g>
      <line className="stock-chart-zero" x1={plotOffsetX} x2="600" y1={baselineY} y2={baselineY} />
      <path className="stock-chart-strategy-fill" d={`${strategyPath} L 600 ${baselineY.toFixed(2)} L ${plotOffsetX} ${baselineY.toFixed(2)} Z`} />
      <path className="stock-chart-benchmark" d={benchmarkPath} />
      <path className="stock-chart-strategy" pathLength="1" d={strategyPath} />
    </svg>
    <img className="stock-chart-platform" src="/assets/market-chart-platform.png" alt="" aria-hidden="true" />
    <div className="stock-chart-axis stock-chart-time-axis">{timeTicks.map((point, index) => <span key={`${point.capturedAt}-${index}`}>{chartTime(point.capturedAt)}</span>)}</div>
  </div>;
}

export function StockDrawdownChart({ curve }: { curve: readonly StockPaperEquityPoint[] }) {
  if (curve.length < 2) return <div className="stock-chart-empty"><span>Drawdown history is collecting.</span></div>;
  const values = curve.map((point) => -Math.max(0, point.drawdownPercent));
  const minimum = Math.min(-1, ...values);
  return <div className="stock-chart drawdown-chart">
    <div className="stock-chart-legend"><span className="drawdown">Peak-to-trough drawdown</span><strong>{percent(Math.abs(values.at(-1) ?? 0))}</strong></div>
    <svg viewBox="0 0 600 180" preserveAspectRatio="none" role="img" aria-label="Stock paper drawdown over time">
      <defs>
        <linearGradient id="stock-drawdown-fill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="#ff716b" stopOpacity=".04" />
          <stop offset="100%" stopColor="#ff716b" stopOpacity=".3" />
        </linearGradient>
      </defs>
      <polygon
        className="stock-chart-drawdown-fill"
        points={`0,0 ${points(values, minimum, 0)} 600,0`}
      />
      <polyline className="stock-chart-drawdown" points={points(values, minimum, 0)} />
    </svg>
    <div className="stock-chart-axis"><span>0%</span><span>{percent(Math.abs(minimum))} low</span><span>{relativeTime(curve.at(-1)!.capturedAt)}</span></div>
  </div>;
}

export function StockPaperPanel({ stock }: { stock: StockPaperDashboard }) {
  const account = stock.account;
  const policy = stock.lane?.policy;
  const totalPnl = account ? account.realizedPnlUsd + account.unrealizedPnlUsd : 0;
  const returnPercent = account && account.initialNavUsd > 0
    ? totalPnl / account.initialNavUsd * 100
    : 0;
  const winRate = account && account.completedTrades > 0
    ? account.winningTrades / account.completedTrades * 100
    : 0;
  const profitFactor = account && account.grossLossUsd > 0
    ? account.grossProfitUsd / account.grossLossUsd
    : account && account.grossProfitUsd > 0 ? Number.POSITIVE_INFINITY : undefined;
  const isolated = stock.executionEnabled === false &&
    stock.promotionEligible === false &&
    stock.paperOnly;
  const readinessReasons = stock.market.readiness?.reasons ?? [];
  const readinessLabel = `${titleCase(stock.market.phase)} readiness`;
  const evidenceHealth = stock.learning.advancedAnalysis?.evidenceHealth;
  const bookResearch = stock.learning.bookResearch;
  const latestCapitalEvent = stock.capitalEvents?.[0];

  return <section className="panel stock-paper-panel" aria-labelledby="stock-paper-title">
    <div className="stock-paper-strip">
      <Icon name="trend" size={17} />
      <strong>{stock.label}</strong>
      <span>Alpaca authentication · live screeners + news context · free IEX + overnight prices · local simulated fills only</span>
    </div>
    <SectionHeader
      eyebrow="Fourth isolated comparison lane"
      title="High-risk US stock momentum lab"
      description="A deterministic stock strategy scans live leaders, movers, and news-linked symbols, persists causal PAPER orders, and labels every observed opportunity for shadow-policy learning without enabling real execution."
      action={<span className={`stock-market-badge ${stock.market.isOpen ? "open" : "closed"}`}><StatusDot ok={stock.market.isOpen ? true : "warning"} />{stock.market.isOpen ? "Feed actionable" : stock.market.sessionActive ? "Session open · feed waiting" : titleCase(stock.market.phase)}</span>}
    />

    <div className={`stock-isolation ${isolated ? "verified" : "failed"}`}>
      <div><Icon name="lock" size={17} /><span><strong>No broker orders</strong><small>Durable local PAPER intents improve fill realism, but no Alpaca trading endpoint is called.</small></span></div>
      <div><Icon name="database" size={17} /><span><strong>Separate stock PAPER ledger</strong><small>{account ? `${money(account.navUsd)} current virtual NAV` : "Virtual bankroll waiting"}; its state cannot alter a crypto account.</small></span></div>
      <div><Icon name="spark" size={17} /><span><strong>High risk, deterministic</strong><small>Up to {percent((policy?.maximumDeployedFraction ?? 0) * 100, 0)} deployed with hard data and drawdown brakes.</small></span></div>
    </div>

    {!stock.lane || !account ? <EmptyState
      icon="trend"
      title="Stock PAPER is waiting for its first cycle"
      detail="Once Alpaca Paper is connected and CopyLab is in PAPER mode, the engine creates its isolated account automatically and begins collecting free IEX and overnight market evidence."
    /> : <>
      <div className="stock-lane-meta">
        <div><span>Status</span><strong className={stock.lane.status === "ACTIVE" ? "positive" : "warning"}>{titleCase(stock.lane.status)}</strong><small>{stock.market.lastScanAt ? `Scanned ${relativeTime(stock.market.lastScanAt)}` : "First scan pending"}</small></div>
        <div><span>Feed</span><strong>{stock.market.feed}</strong><small>{count(stock.market.freshSnapshots ?? stock.market.scannedSymbols)} fresh / {count(stock.market.requestedSymbols ?? stock.market.scannedSymbols)} requested</small></div>
        <div><span>Policy</span><strong>{stock.lane.policyVersion}</strong><small>{count(policy?.scanIntervalSeconds ?? 0)} second cadence</small></div>
        <div><span>Risk budget</span><strong>{percent((policy?.normalRiskAtStopNavFraction ?? 0) * 100, 0)}–{percent((policy?.highConvictionRiskAtStopNavFraction ?? 0) * 100, 0)} NAV</strong><small>Measured at the {percent(policy?.stopLossPercent ?? 0)} stop</small></div>
        <div><span>Capacity</span><strong>{count(policy?.maximumOpenPositions ?? 0)} positions</strong><small>{percent((policy?.maximumPositionNavFraction ?? 0) * 100, 0)} max each</small></div>
        <div><span>Online discovery</span><strong>{titleCase(stock.market.screenerStatus ?? "unavailable")}</strong><small>{count(stock.market.dynamicSymbols ?? 0)} dynamic · {count(stock.market.newsSymbols ?? 0)} news-linked</small></div>
      </div>

      {stock.market.lastError && <div className="stock-paper-alert"><Icon name="alert" size={16} /><span><strong>Last cycle failed safely.</strong> {stock.market.lastError}</span></div>}
      {account.pausedReason && <div className="stock-paper-alert"><Icon name="shield" size={16} /><span><strong>New entries paused.</strong> {account.pausedReason}</span></div>}
      {latestCapitalEvent && <div className="stock-paper-alert"><Icon name="database" size={16} /><span><strong>Simulated bankroll increased to {money(latestCapitalEvent.targetNavUsd)}.</strong> {money(latestCapitalEvent.deltaUsd)} was added as PAPER cash {relativeTime(latestCapitalEvent.createdAt)}. It is recorded as external capital, excluded from trading P&amp;L, and subtracted from the performance chart.</span></div>}
      {readinessReasons.length > 0 && <div className="stock-paper-alert"><Icon name="alert" size={16} /><span><strong>{readinessLabel} details.</strong> {readinessReasons.join(" ")}</span></div>}
      {stock.market.delayedFairValueFeed === "SIP" && stock.market.delayedFairValueAt && <div className="stock-paper-alert"><Icon name="database" size={16} /><span><strong>Delayed SIP fair-value marks are active.</strong> Consolidated history from {dateTime(stock.market.delayedFairValueAt)} updates fair NAV only. It cannot make a position executable, satisfy readiness, trigger a stop, or fill a PAPER order.</span></div>}

      <div className="stock-lane-meta">
        <div><span>{readinessLabel}</span><strong className={stock.market.readiness?.status === "READY" ? "positive" : stock.market.readiness?.status === "BLOCKED" ? "negative" : "warning"}>{titleCase(stock.market.readiness?.status ?? "warming")}</strong><small>{stock.market.readiness?.countdownSeconds ? `${count(Math.ceil(stock.market.readiness.countdownSeconds / 60))}m readiness countdown` : `${count(readinessReasons.length)} active checks`}</small></div>
        <div><span>Feed age</span><strong>{stock.market.quoteAgeMs === undefined ? "—" : `${Math.round(stock.market.quoteAgeMs / 1000)}s quote`}</strong><small>{stock.market.barAgeMs === undefined ? "No minute bar" : `${Math.round(stock.market.barAgeMs / 60000)}m bar · ${stock.market.pricingEvidenceMode === "DELAYED_DERIVED" ? "free derived" : "real-time"}`}</small></div>
        <div><span>Fresh coverage</span><strong>{percent(stock.market.freshCoveragePercent ?? 0)}</strong><small>{percent(stock.market.openPositionPricingCoveragePercent ?? 100)} position pricing</small></div>
        <div><span>Overnight assets</span><strong>{count(stock.market.overnightEligibleAssets ?? 0)}</strong><small>{count(stock.market.overnightFractionalAssets ?? 0)} fractional · {count(stock.market.overnightHaltedAssets ?? 0)} halted</small></div>
        <div><span>Durable orders</span><strong>{count(stock.market.pendingOrders ?? 0)} pending</strong><small>{count(stock.orders.length)} recent audit records</small></div>
        <div><span>Learning ledger</span><strong>{count(stock.learning.observations)} observations</strong><small>{count(stock.learning.labeledOutcomes)} usable · {count(stock.learning.missingOutcomes)} missing · {percent(stock.learning.eligibleCoveragePercent)} coverage</small></div>
        <div><span>30-symbol stream</span><strong className={stock.market.streamStatus === "LIVE" ? "positive" : stock.market.streamStatus === "ERROR" ? "negative" : "warning"}>{titleCase(stock.market.streamStatus ?? "disabled")}</strong><small>{count(stock.market.streamSymbols ?? 0)} symbols · {count(stock.market.streamQuoteMessages ?? 0)} quotes · {count(stock.market.streamBarMessages ?? 0)} bars</small></div>
        <div><span>Calendar / actions</span><strong className={stock.market.calendarStatus === "VERIFIED" ? "positive" : "warning"}>{titleCase(stock.market.calendarStatus ?? "unavailable")}</strong><small>{count(stock.market.corporateActionBlockedSymbols ?? 0)} symbols safety-blocked</small></div>
      </div>

      <div className="stock-account-metrics">
        <div><span>Executable NAV</span><strong>{money(account.executableNavUsd ?? account.navUsd)}</strong><small>{account.fairNavUsd !== undefined ? `${money(account.fairNavUsd)} fair mark` : `Started at ${money(account.initialNavUsd)}`}</small></div>
        <div><span>Total P&amp;L</span><strong className={totalPnl >= 0 ? "positive" : "negative"}>{signedMoney(totalPnl)}</strong><small>{signedPercent(returnPercent)} return</small></div>
        <div><span>Cash / deployed</span><strong>{money(account.cashUsd)}</strong><small>{money(account.deployedUsd)} working</small></div>
        <div><span>Completed / open</span><strong>{count(account.completedTrades)} / {count(account.openPositions)}</strong><small>{percent(winRate)} win rate</small></div>
        <div><span>Profit factor</span><strong>{profitFactor === undefined ? "—" : Number.isFinite(profitFactor) ? profitFactor.toFixed(2) : "∞"}</strong><small>{signedMoney(account.realizedPnlUsd)} realized</small></div>
        <div><span>Max drawdown</span><strong className={account.maxDrawdownPercent >= 15 ? "negative" : "warning"}>{percent(account.maxDrawdownPercent)}</strong><small>{percent(policy?.maximumDrawdownPercent ?? 0)} hard research lock</small></div>
      </div>

    <div className="stock-graphs">
        <article><h3>Equity vs SPY</h3><p>Both lines start at 0% so performance is comparable.</p><StockEquityChart curve={stock.equityCurve} /></article>
        <article><h3>Drawdown</h3><p>How far the account has fallen below its prior peak.</p><StockDrawdownChart curve={stock.equityCurve} /></article>
      </div>

      <div className="stock-subsection">
        <h3>Learning by strategy arm</h3>
        <div className="stock-arm-grid">{stock.armStats.map((arm) => {
          const width = Math.min(100, Math.max(2, arm.winRatePercent));
          return <article key={arm.arm}>
            <header><strong>{titleCase(arm.arm)}</strong><span className={arm.pnlUsd >= 0 ? "positive" : "negative"}>{signedMoney(arm.pnlUsd)}</span></header>
            <div className="stock-arm-bar"><span style={{ width: `${width}%` }} /></div>
            <footer><span>{count(arm.trades)} total · {count(arm.learningSampleSize ?? 0)} {titleCase(stock.market.phase)} samples</span><strong>{arm.adaptiveSizingMultiplier.toFixed(2)}× · {titleCase(arm.learningStatus ?? "warming up")}</strong></footer>
          </article>;
        })}</div>
      </div>

      <div className="stock-subsection">
        <h3>Outcome evidence quality</h3>
        <p>Each horizon separates observations that are not due yet from overdue labels and permanently missing market evidence, so the learner cannot mistake a data gap for a trade result.</p>
        <div className="stock-arm-grid">{stock.learning.outcomeQuality.map((quality) => <article key={quality.horizonMinutes}>
          <header><strong>{count(quality.horizonMinutes)} minute labels</strong><span className={quality.pendingDueOutcomes === 0 ? "positive" : "warning"}>{percent(quality.completionPercent)} complete</span></header>
          <div className="stock-arm-bar"><span style={{ width: `${Math.min(100, Math.max(2, quality.eligibleCoveragePercent))}%` }} /></div>
          <footer><span>{count(quality.labeledOutcomes)} usable · {count(quality.missingOutcomes)} missing · {count(quality.pendingDueOutcomes)} overdue</span><strong>{percent(quality.eligibleCoveragePercent)} usable coverage</strong></footer>
          <small>{count(quality.futureOutcomes)} still maturing{quality.oldestPendingObservedAt ? ` · oldest overdue ${relativeTime(quality.oldestPendingObservedAt)}` : ""}{quality.topMissingReasons.length > 0 ? ` · top gap ${titleCase(quality.topMissingReasons[0]!.reason)} (${count(quality.topMissingReasons[0]!.count)})` : ""}</small>
          <div className="stock-outcome-session-grid">{quality.sessionBreakdown.map((session) => <div key={session.phase}>
            <span>{titleCase(session.phase)}</span>
            <strong>{percent(session.eligibleCoveragePercent)}</strong>
            <small>{count(session.labeledOutcomes)} usable · {count(session.missingOutcomes)} gaps · {count(session.pendingDueOutcomes)} due</small>
          </div>)}</div>
        </article>)}</div>
      </div>

      <div className="stock-subsection stock-book-research">
        <h3>Book-derived research lab</h3>
        <p>{count(bookResearch.sourceCount)} user-provided sources are registered by public bibliographic identity and converted into paraphrased, pre-registered hypotheses. Compatible ideas are measured on causal PAPER outcomes; incompatible or missing-data claims stay blocked and visible.</p>
        <div className="stock-book-summary">
          <div><span>Registered sources</span><strong>{count(bookResearch.sourceCount)}</strong><small>{count(bookResearch.curatedSourceCount)} curated · {count(bookResearch.cautionSourceCount)} caution · {count(bookResearch.quarantinedSourceCount)} quarantined</small></div>
          <div><span>Existing evidence</span><strong>{count(bookResearch.activeEvidenceCount)}</strong><small>Mapped to immutable CopyLab controls</small></div>
          <div><span>Shadow tests</span><strong className="warning">{count(bookResearch.shadowTestingCount)}</strong><small>Causal outcomes · cannot trade</small></div>
          <div><span>Need data</span><strong className="warning">{count(bookResearch.dataRequiredCount)}</strong><small>Not guessed or backfilled</small></div>
          <div><span>Excluded claims</span><strong className="negative">{count(bookResearch.excludedCount)}</strong><small>Stale, conflicting, or untestable</small></div>
        </div>
        <div className="stock-book-sources">{bookResearch.sources.map((source) => <article key={source.id} className={source.reviewStatus.toLowerCase()}>
          <header><strong>{source.title}</strong><span className={source.reviewStatus === "QUARANTINED" ? "negative" : source.reviewStatus === "CAUTION" ? "warning" : "positive"}>{titleCase(source.reviewStatus)}</span></header>
          <p>{source.author ?? "Author metadata unavailable"} · {source.format}</p>
          <small>{source.reviewNote}</small>
          <footer>Public source ID {source.sha256.slice(0, 12)}… · {source.researchEligible ? "hypothesis eligible" : "research quarantined"} · text not copied</footer>
        </article>)}</div>
        <div className="stock-paper-alert"><Icon name="database" size={16} /><span><strong>Analysis boundary is locked.</strong> These sources can propose tests, but only held-out, cost-adjusted PAPER evidence can evaluate them. No result can change orders, sizing, filters, promotion, or live execution.</span></div>
        <details className="stock-book-details">
          <summary>Inspect all {count(bookResearch.hypotheses.length)} book-derived hypotheses and exclusions</summary>
          <div className="stock-book-hypotheses">{bookResearch.hypotheses.map((hypothesis) => {
            const score = hypothesis.shadowPolicyId
              ? stock.learning.shadowPolicies.find((candidate) => candidate.policyId === hypothesis.shadowPolicyId)
              : undefined;
            const statusClass = hypothesis.status === "EXCLUDED"
              ? "negative"
              : hypothesis.status === "DATA_REQUIRED" || hypothesis.status === "SHADOW_TESTING"
                ? "warning"
                : "positive";
            return <article key={hypothesis.id}>
              <header><strong>{hypothesis.label}</strong><span className={statusClass}>{titleCase(hypothesis.status)}</span></header>
              <p>{hypothesis.summary}</p>
              <small>{hypothesis.implementation}</small>
              {score && <div className="stock-book-score"><span>{count(score.labeled)} labeled / {count(score.observations)} selected</span><strong className={score.netReturnPercent >= 0 ? "positive" : "negative"}>{signedPercent(score.netReturnPercent)}</strong></div>}
              {hypothesis.shadowPolicyId && !score && <div className="stock-book-score"><span>Frozen shadow policy</span><strong className="warning">Awaiting checkpoint</strong></div>}
              {hypothesis.requiredData && <small>Required: {hypothesis.requiredData.join(" · ")}</small>}
              {hypothesis.exclusionReason && <small>Excluded: {hypothesis.exclusionReason}</small>}
              {hypothesis.proxyWarning && <small>Proxy limit: {hypothesis.proxyWarning}</small>}
              <footer>{hypothesis.sources.map((source) => `${titleCase(source.sourceId)} · ${source.locator}`).join(" | ")}</footer>
            </article>;
          })}</div>
          <p className="stock-book-warning">{bookResearch.warnings.join(" ")}</p>
        </details>
      </div>

      <div className="stock-subsection">
        <h3>Advanced research brain v4</h3>
        {!stock.learning.advancedAnalysis ? <p className="stock-empty">The first v4 checkpoint is waiting for the next learning cycle. It will use only immutable v41 fill events and will remain unable to alter trades.</p> : <>
          <div className="stock-paper-alert"><Icon name="database" size={16} /><span><strong>{titleCase(stock.learning.advancedAnalysis.status)} · analysis only.</strong> This is realized-close bookkeeping with fixed historical notionals, not a portfolio counterfactual or profit forecast. It cannot change orders, sizing, filters, policy promotion, or live execution.</span></div>
          {(!evidenceHealth || evidenceHealth.status === "ACTIVATION_UNKNOWN") && <div className="stock-paper-alert"><Icon name="alert" size={16} /><span><strong>Evidence health has not been established.</strong> {evidenceHealth ? "The durable v41 activation boundary is unavailable." : "This persisted summary predates the durable v41 health marker."} Wait for a valid v4 checkpoint before interpreting its exclusion count.</span></div>}
          {(evidenceHealth?.postV41ExcludedTradeCount ?? 0) > 0 && <div className="stock-paper-alert stock-paper-alert-critical"><Icon name="alert" size={16} /><span><strong>Post-v41 evidence health alert.</strong> {count(evidenceHealth!.postV41ExcludedTradeCount)} completed event-era trades were excluded from v4 analysis. Legacy trades are not included in this alert. Review {evidenceHealth!.postV41ExclusionReasons.map((reason) => `${titleCase(reason.reason)} (${count(reason.count)})`).join(", ")}.</span></div>}
          <div className="stock-lane-meta">
            <div><span>Event-backed trades</span><strong>{count(stock.learning.advancedAnalysis.analyzedTradeCount)} / {count(stock.learning.advancedAnalysis.sourceTradeCount)}</strong><small>{count(stock.learning.advancedAnalysis.excludedTradeCount)} excluded rather than reconstructed</small></div>
            <div><span>Evidence health</span><strong className={!evidenceHealth || evidenceHealth.status === "ACTIVATION_UNKNOWN" ? "warning" : evidenceHealth.postV41ExcludedTradeCount > 0 ? "negative" : "positive"}>{evidenceHealth ? titleCase(evidenceHealth.status) : "Not evaluated"}</strong><small>{evidenceHealth && evidenceHealth.status !== "ACTIVATION_UNKNOWN" ? `${count(evidenceHealth.postV41ExcludedTradeCount)} post-v41 excluded · ${count(evidenceHealth.legacyExcludedTradeCount)} expected legacy` : "Awaiting a durable-marker v4 checkpoint"}</small></div>
            <div><span>Ledger return</span><strong className={stock.learning.advancedAnalysis.replay.returnPercent >= 0 ? "positive" : "negative"}>{signedPercent(stock.learning.advancedAnalysis.replay.returnPercent)}</strong><small>{signedMoney(stock.learning.advancedAnalysis.replay.totalPnlUsd)} at fixed historical notionals</small></div>
            <div><span>SPY excess</span><strong className={stock.learning.advancedAnalysis.spyExcess.excessPnlUsd >= 0 ? "positive" : "negative"}>{signedMoney(stock.learning.advancedAnalysis.spyExcess.excessPnlUsd)}</strong><small>{signedPercent(stock.learning.advancedAnalysis.spyExcess.notionalWeightedExcessReturnPercent)} notional-weighted</small></div>
            <div><span>Active days</span><strong>{count(stock.learning.advancedAnalysis.bootstrap.activeTradeDays)}</strong><small>{count(stock.learning.advancedAnalysis.uniqueSymbols)} symbols · {count(stock.learning.advancedAnalysis.spyHistoryDays)} adjusted SPY days</small></div>
            <div><span>Bootstrap diagnostic</span><strong>{signedPercent(stock.learning.advancedAnalysis.bootstrap.returnPercentP50)} median</strong><small>{signedPercent(stock.learning.advancedAnalysis.bootstrap.returnPercentP05)} to {signedPercent(stock.learning.advancedAnalysis.bootstrap.returnPercentP95)} · not a forecast</small></div>
            <div><span>Drift</span><strong className={stock.learning.advancedAnalysis.drift.status === "DETERIORATING" ? "negative" : stock.learning.advancedAnalysis.drift.status === "IMPROVING" ? "positive" : "warning"}>{titleCase(stock.learning.advancedAnalysis.drift.status)}</strong><small>{signedPercent(stock.learning.advancedAnalysis.drift.spyExcessDeltaPercent)} recent change</small></div>
          </div>
          <p>{stock.learning.advancedAnalysis.warnings.slice(0, 3).join(" ")}</p>
        </>}
      </div>

      <div className="stock-two-column">
        <div className="stock-subsection">
          <h3>Durable PAPER order ledger</h3>
          {stock.orders.length === 0 ? <p className="stock-empty">The first local order intent will appear when an eligible signal reaches execution modeling.</p> : <div className="stock-candidates">{stock.orders.slice(0, 8).map((order) => <article key={order.id}>
            <header><strong>{order.symbol} · {order.side}</strong><span className={order.status === "FILLED" ? "positive" : order.status === "SUBMITTED" || order.status === "PARTIAL" ? "warning" : "negative"}>{titleCase(order.status)}</span></header>
            <p>{order.filledQuantity.toFixed(5)} / {order.requestedQuantity.toFixed(5)} shares · {money(order.limitPriceUsd)} limit</p>
            <small>{count(order.fills.length)} causal fills · submitted {relativeTime(order.submittedAt)}{order.reason ? ` · ${order.reason}` : ""}</small>
          </article>)}</div>}
        </div>
        <div className="stock-subsection">
          <h3>Shadow-policy arena</h3>
          {stock.learning.walkForward && <div className="stock-paper-alert"><Icon name="database" size={16} /><span><strong>Research validation: {titleCase(stock.learning.walkForward.status)}.</strong> {count(stock.learning.walkForward.holdoutScorablePaths)} holdout paths across {count(stock.learning.walkForward.distinctSymbols)} symbols and {count(stock.learning.walkForward.distinctTradeDays)} days. Analysis only; it cannot change trading. Paths can overlap and are scored as independent opportunities, not as a portfolio backtest.</span></div>}
          {stock.learning.shadowPolicies.length === 0 ? <p className="stock-empty">The arena activates after causal 15-minute outcomes begin labeling. Shadow results can never place orders.</p> : <div className="stock-candidates">{stock.learning.shadowPolicies.map((policyScore) => <article key={policyScore.policyId}>
            <header><strong>{titleCase(policyScore.policyId)}</strong><span className={policyScore.netReturnPercent >= 0 ? "positive" : "negative"}>{signedPercent(policyScore.netReturnPercent)}</span></header>
            <p>{count(policyScore.labeled)} labeled / {count(policyScore.observations)} selected · {count(policyScore.wins)} wins</p>
            <small>{signedPercent(policyScore.averageReturnPercent)} average · {percent(policyScore.maximumDrawdownPercent)} drawdown · {policyScore.pathsAreIndependentTrades === false ? "overlapping paths, not portfolio P&L" : "analysis only"}</small>
          </article>)}</div>}
        </div>
      </div>

      <div className="stock-subsection">
        <h3>Position-rotation shadow challenger</h3>
        {!stock.learning.rotationShadow ? <p className="stock-empty">The one-step rotation challenger is waiting for its first causal decision. It observes the PAPER account but cannot change a position or create an order.</p> : <>
          <div className="stock-paper-alert"><Icon name="database" size={16} /><span><strong>Analysis only · independent one-step comparisons.</strong> It compares keeping one current lot with hypothetically selling it and buying a stronger same-clock candidate. Decisions can overlap, so their results are never compounded into account NAV and can never affect trading or promotion.</span></div>
          <div className="stock-lane-meta">
            <div><span>Decisions evaluated</span><strong>{count(stock.learning.rotationShadow.evaluatedDecisions)}</strong><small>{count(stock.learning.rotationShadow.proposedRotations)} rotate · {count(stock.learning.rotationShadow.heldDecisions)} hold</small></div>
            <div><span>Labeled outcomes</span><strong>{count(stock.learning.rotationShadow.labeledOutcomes)}</strong><small>{count(stock.learning.rotationShadow.missingOutcomes)} missing rather than guessed</small></div>
            <div><span>Incremental wins</span><strong>{count(stock.learning.rotationShadow.incrementalWins)}</strong><small>{percent(stock.learning.rotationShadow.incrementalWinRatePercent)} of labeled comparisons</small></div>
            <div><span>Mean rotation delta</span><strong className={stock.learning.rotationShadow.meanIncrementalPnlUsd >= 0 ? "positive" : "negative"}>{signedMoney(stock.learning.rotationShadow.meanIncrementalPnlUsd)}</strong><small>{signedPercent(stock.learning.rotationShadow.meanIncrementalReturnPercent)} versus continuing to hold</small></div>
          </div>
          <details className="stock-book-details">
            <summary>Inspect recent rotation decisions and causal outcomes</summary>
            <div className="stock-two-column">
              <div className="stock-candidates">{stock.learning.rotationShadow.recentDecisions.slice(0, 8).map((decision) => <article key={decision.id}>
                <header><strong>{decision.outgoing && decision.incoming ? `${decision.outgoing.symbol} → ${decision.incoming.symbol}` : "No safe rotation"}</strong><span className={decision.status === "ROTATE" ? "warning" : "positive"}>{decision.status}</span></header>
                <p>{decision.scoreDelta !== undefined ? `${decision.scoreDelta.toFixed(1)} point score edge` : decision.reasonCodes.map(titleCase).join(" · ")}</p>
                <small>{decision.modeledSwitchCostsUsd !== undefined ? `${money(decision.modeledSwitchCostsUsd)} modeled switching costs` : "No counterfactual order created"} · {relativeTime(decision.decisionAt)}</small>
              </article>)}</div>
              <div className="stock-candidates">{stock.learning.rotationShadow.recentOutcomes.slice(0, 8).map((outcome) => <article key={outcome.id}>
                <header><strong>{count(outcome.horizonMinutes)} minute comparison</strong><span className={outcome.status === "LABELED" ? (outcome.incrementalPnlUsd ?? 0) >= 0 ? "positive" : "negative" : "warning"}>{titleCase(outcome.status)}</span></header>
                <p>{outcome.status === "LABELED" ? `${signedMoney(outcome.incrementalPnlUsd ?? 0)} · ${signedPercent(outcome.incrementalReturnPercent ?? 0)} versus hold` : titleCase(outcome.missingReason ?? "missing causal evidence")}</p>
                <small>{outcome.status === "LABELED" ? `${money(outcome.totalRotationModeledCostsUsd ?? 0)} total modeled rotation costs` : "Missing evidence is never converted to a zero return"} · {relativeTime(outcome.labeledAt)}</small>
              </article>)}</div>
            </div>
          </details>
        </>}
      </div>

      <div className="stock-subsection">
        <h3>Open fractional positions</h3>
        {stock.positions.length === 0 ? <p className="stock-empty">No stock position is open. The engine is scanning the active session or waiting for fresh market evidence.</p> : <div className="table-scroll"><table className="stock-table"><thead><tr><th>Symbol</th><th>Arm</th><th>Opened</th><th>Cost</th><th>Value</th><th>P&amp;L</th><th>Stop</th><th>Target</th></tr></thead><tbody>{stock.positions.map((position) => {
          const pnl = position.lastValueUsd - position.remainingCostUsd;
          return <tr key={position.id}><td><strong>{position.symbol}</strong><small>{position.quantity.toFixed(5)} shares · {titleCase(position.status)}</small></td><td>{titleCase(position.arm)}</td><td>{dateTime(position.openedAt)}</td><td>{money(position.remainingCostUsd)}</td><td>{money(position.lastValueUsd)}<small>{position.delayedFairValueEvidence ? `Delayed SIP · ${relativeTime(position.delayedFairValueEvidence.evidenceAt)}` : "Executable feed mark"}</small></td><td className={pnl >= 0 ? "positive" : "negative"}>{signedMoney(pnl)}</td><td>{money(position.stopPriceUsd)}</td><td>{money(position.takeProfitPriceUsd)}</td></tr>;
        })}</tbody></table></div>}
      </div>

      <div className="stock-two-column">
        <div className="stock-subsection">
          <h3>Top current candidates</h3>
          {stock.candidates.length === 0 ? <p className="stock-empty">Detailed candidates appear when the {stock.market.feed} feed supplies both a fresh quote and a fresh minute bar.</p> : <div className="stock-candidates">{stock.candidates.slice(0, 10).map((candidate) => <article key={candidate.symbol}>
            <header><strong>{candidate.symbol}</strong><span className={candidate.eligible ? "positive" : "warning"}>{candidate.score.toFixed(1)}</span></header>
            <p>{titleCase(candidate.arm)} · {signedPercent(candidate.change5mPercent)} 5m · {candidate.relativeVolume.toFixed(2)}× relative volume</p>
            <small>{money(candidate.priceUsd)} · spread {percent(candidate.spreadPercent, 2)}{candidate.onlineSources?.length ? ` · ${candidate.onlineSources.map(titleCase).join(" + ")}` : ""}{candidate.newsArticleCount ? ` · ${count(candidate.newsArticleCount)} news` : ""}{candidate.eligible ? " · eligible" : ` · ${candidate.reasons[0] ?? "filtered"}`}</small>
          </article>)}</div>}
        </div>
        <div className="stock-subsection">
          <h3>Closed trades and 1,000-policy replay</h3>
          {stock.recentTrades.length === 0 ? <p className="stock-empty">Replay reports appear after the first completed position.</p> : <div className="stock-candidates">{stock.recentTrades.slice(0, 10).map((trade) => <article key={trade.id}>
            <header><strong>{trade.symbol} · {titleCase(trade.exitReason)}</strong><span className={trade.pnlUsd >= 0 ? "positive" : "negative"}>{signedMoney(trade.pnlUsd)}</span></header>
            <p>{signedPercent(trade.returnPercent)} actual · {trade.replay ? `${percent(trade.replay.actualPercentile)} replay percentile` : "replay pending"}</p>
            <small>{trade.replay ? `Best tested ${signedPercent(trade.replay.bestReturnPercent)} · ${count(trade.replay.profitableVariantCount)}/1,000 profitable` : `Closed ${dateTime(trade.closedAt)}`}</small>
          </article>)}</div>}
        </div>
      </div>
    </>}

    <footer className="stock-paper-footer"><Icon name="lock" size={15} /><span>This lane is for aggressive PAPER research. Real Alpaca market data does not make simulated results a profit guarantee, and no stock order can be sent from this implementation.</span></footer>
  </section>;
}
