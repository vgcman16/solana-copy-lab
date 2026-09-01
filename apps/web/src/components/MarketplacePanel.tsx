import {
  IconAdjustmentsHorizontal,
  IconAlertTriangle,
  IconArrowsExchange,
  IconBolt,
  IconBook2,
  IconBrain,
  IconBuildingBank,
  IconChartLine,
  IconCheck,
  IconChevronRight,
  IconClock,
  IconDatabase,
  IconFileAnalytics,
  IconFlask,
  IconHistory,
  IconLayersIntersect,
  IconLock,
  IconPlayerPause,
  IconPlayerPlay,
  IconPercentage,
  IconReceipt,
  IconRefresh,
  IconSearch,
  IconShieldCheck,
  IconSparkles,
  IconTargetArrow,
  IconTrash,
  IconUsers,
  IconWallet,
  IconX,
  type IconProps as TablerIconProps
} from "@tabler/icons-react";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode
} from "react";
import type {
  MarketplaceBrokerConnection,
  MarketplaceEnrollment,
  MarketplaceEnrollmentAllocation,
  MarketplaceEnrollmentLedger,
  MarketplacePanelProps,
  MarketplacePerformanceHistoryPoint,
  MarketplacePilot,
  MarketplacePilotCategory,
  MarketplaceRebalancePreview
} from "./marketplace-types";
import {
  calculateMarketplacePercentAllocation,
  filterMarketplacePilots,
  MARKETPLACE_ASSET_LABELS,
  MARKETPLACE_CATEGORY_LABELS,
  MARKETPLACE_RISK_LABELS,
  marketplaceMoney,
  marketplacePricingEvidenceCopy,
  marketplaceRelativeTime,
  marketplaceSignedPercent,
  pilotCanAcceptPaperEnrollment,
  validateMarketplaceAllocation
} from "./marketplace-utils";
import "./marketplace.css";

export type {
  MarketplaceActions,
  MarketplaceBrokerConnection,
  MarketplaceEnrollment,
  MarketplacePanelProps,
  MarketplacePilot,
  MarketplaceRebalancePreview
} from "./marketplace-types";

type MarketplaceView = "DISCOVER" | "MY_PILOTS" | "BROKERS";
type EnrollmentWorkflow = { type: "REBALANCE" | "SWITCH"; enrollmentId: string };

const CATEGORY_ICONS: Record<MarketplacePilotCategory, ComponentType<TablerIconProps>> = {
  WALLET_COPY: IconWallet,
  AUTONOMOUS_AI: IconBrain,
  STOCK_MOMENTUM: IconChartLine,
  THEMATIC: IconLayersIntersect,
  HEDGE_FUND_13F: IconFileAnalytics,
  POLITICIAN_DISCLOSURE: IconUsers
};

const CATEGORY_FILTERS: Array<MarketplacePilotCategory | "ALL"> = [
  "ALL",
  "WALLET_COPY",
  "AUTONOMOUS_AI",
  "STOCK_MOMENTUM",
  "THEMATIC",
  "HEDGE_FUND_13F",
  "POLITICIAN_DISCLOSURE"
];

function MarketplaceButton({
  children,
  tone = "secondary",
  busy = false,
  icon: Glyph,
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: "primary" | "secondary" | "danger" | "ghost";
  busy?: boolean;
  icon?: ComponentType<TablerIconProps>;
}) {
  return <button
    {...props}
    type={props.type ?? "button"}
    className={`marketplace-button marketplace-button-${tone} ${className}`}
    disabled={busy || props.disabled}
  >
    {busy ? <span className="marketplace-spinner" aria-hidden="true" /> : Glyph ? <Glyph size={16} stroke={1.8} aria-hidden="true" /> : null}
    <span>{children}</span>
  </button>;
}

function MarketplaceBadge({ children, tone = "neutral" }: { children: ReactNode; tone?: string }) {
  return <span className={`marketplace-badge marketplace-badge-${tone}`}>{children}</span>;
}

function PilotCategoryIcon({ pilot, size = 21 }: { pilot: MarketplacePilot; size?: number }) {
  const Glyph = CATEGORY_ICONS[pilot.category];
  return <span className={`marketplace-category-icon marketplace-category-${pilot.category.toLocaleLowerCase()}`}>
    <Glyph aria-hidden="true" size={size} stroke={1.7} />
  </span>;
}

function useDialogLifecycle(open: boolean, onClose: () => void) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; }, [onClose]);
  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const priorOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
        "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])"
      )).filter((node) => !node.hasAttribute("hidden"));
      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = priorOverflow;
      document.removeEventListener("keydown", onKeyDown);
      previousFocus?.focus();
    };
  }, [open]);
  return dialogRef;
}

function PilotAvailabilityBadges({ pilot, paperOnly }: { pilot: MarketplacePilot; paperOnly: boolean }) {
  return <div className="marketplace-badges" aria-label="Execution availability">
    {pilot.availability.paper && <MarketplaceBadge tone="paper"><IconFlask aria-hidden="true" size={12} />PAPER engine available</MarketplaceBadge>}
    {paperOnly || (!pilot.availability.manualLive && !pilot.availability.autoLive)
      ? <MarketplaceBadge tone="locked"><IconLock aria-hidden="true" size={12} />Live locked</MarketplaceBadge>
      : pilot.availability.autoLive
        ? <MarketplaceBadge tone="live"><IconBolt aria-hidden="true" size={12} />Auto live</MarketplaceBadge>
        : <MarketplaceBadge tone="warning"><IconShieldCheck aria-hidden="true" size={12} />Manual live</MarketplaceBadge>}
  </div>;
}

function PerformanceValue({ value, inverse = false }: { value: number | undefined; inverse?: boolean }) {
  const className = value === undefined
    ? "marketplace-metric-neutral"
    : inverse
      ? value <= 10 ? "marketplace-metric-positive" : "marketplace-metric-warning"
      : value >= 0 ? "marketplace-metric-positive" : "marketplace-metric-negative";
  const display = inverse && value !== undefined && Number.isFinite(value)
    ? `${Math.abs(value).toFixed(1)}%`
    : marketplaceSignedPercent(value);
  return <strong className={className}>{display}</strong>;
}

function performanceCapturedLabel(value: string): string {
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(timestamp);
}

function historyEvidenceLabel(point: MarketplacePerformanceHistoryPoint): string {
  if (point.evidenceStatus === "QUALIFIED") return "Qualified";
  if (point.evidenceStatus === "DELAYED_SOURCE") return "Delayed source";
  if (point.evidenceStatus === "INSUFFICIENT") return "Insufficient";
  return "Collecting";
}

export function PilotPerformanceHistory({
  history,
  pilotName
}: {
  history: readonly MarketplacePerformanceHistoryPoint[];
  pilotName: string;
}) {
  const ordered = useMemo(
    () => [...history].sort((left, right) => left.capturedAt.localeCompare(right.capturedAt)),
    [history]
  );
  const chartPoints = ordered
    .map((point) => ({ point, time: new Date(point.capturedAt).getTime() }))
    .filter((entry) => Number.isFinite(entry.time) &&
      entry.point.netReturnPercent !== undefined &&
      Number.isFinite(entry.point.netReturnPercent));
  const firstTime = chartPoints[0]?.time;
  const lastTime = chartPoints.at(-1)?.time;
  const canPlotTrend = chartPoints.length >= 2 && firstTime !== undefined && lastTime !== undefined && lastTime > firstTime;
  const visibleRows = ordered.slice(-8).reverse();

  if (ordered.length === 0) {
    return <div className="marketplace-history-state" data-history-state="empty">
      <IconHistory aria-hidden="true" size={18} />
      <div><strong>Performance history is collecting</strong><p>No captured snapshots are available yet. CopyLab will show a trend only after the server records real observations.</p></div>
    </div>;
  }

  let polyline = "";
  let minReturn = 0;
  let maxReturn = 0;
  if (canPlotTrend) {
    const returns = chartPoints.map(({ point }) => point.netReturnPercent!);
    minReturn = Math.min(...returns);
    maxReturn = Math.max(...returns);
    const range = maxReturn - minReturn;
    polyline = chartPoints.map(({ point, time }) => {
      const x = 12 + ((time - firstTime) / (lastTime - firstTime)) * 296;
      const y = range === 0 ? 54 : 96 - ((point.netReturnPercent! - minReturn) / range) * 84;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    }).join(" ");
  }

  const latest = ordered.at(-1)!;
  return <div className="marketplace-history" data-history-state={canPlotTrend ? "chart" : "sparse"}>
    <header>
      <div><span><IconHistory aria-hidden="true" size={13} />Recorded snapshots</span><strong>{ordered.length.toLocaleString()} captured</strong></div>
      <MarketplaceBadge tone={latest.pricingComplete ? "positive" : "warning"}>{latest.pricingComplete ? "Executable pricing" : "Pricing incomplete"}</MarketplaceBadge>
    </header>

    {canPlotTrend ? <figure className="marketplace-history-chart">
      <svg viewBox="0 0 320 108" role="img" aria-label={`${pilotName} recorded net return history from ${minReturn.toFixed(1)}% to ${maxReturn.toFixed(1)}% across ${chartPoints.length} captured snapshots`}>
        <title>{pilotName} captured net return history</title>
        <line x1="12" y1="12" x2="308" y2="12" className="marketplace-history-grid" />
        <line x1="12" y1="54" x2="308" y2="54" className="marketplace-history-grid" />
        <line x1="12" y1="96" x2="308" y2="96" className="marketplace-history-grid" />
        <polyline points={polyline} className="marketplace-history-line-glow" />
        <polyline points={polyline} className="marketplace-history-line" />
        {polyline.split(" ").map((coordinates, index) => {
          const [cx, cy] = coordinates.split(",");
          return <circle key={`${chartPoints[index]!.point.capturedAt}-${index}`} cx={cx} cy={cy} r="2.7" className="marketplace-history-point" />;
        })}
      </svg>
      <figcaption><span>{performanceCapturedLabel(chartPoints[0]!.point.capturedAt)}</span><span>Net return · recorded observations only</span><span>{performanceCapturedLabel(chartPoints.at(-1)!.point.capturedAt)}</span></figcaption>
    </figure> : <div className="marketplace-history-state marketplace-history-state-inline">
      <IconChartLine aria-hidden="true" size={17} />
      <div><strong>Not enough snapshots for a trend</strong><p>{chartPoints.length === 0 ? "Captured rows do not yet include a net-return value." : "At least two snapshots captured at different times are required for the chart."}</p></div>
    </div>}

    <div className="marketplace-history-table-wrap">
      <table className="marketplace-history-table">
        <caption className="marketplace-sr-only">{pilotName} latest recorded performance snapshots</caption>
        <thead><tr><th scope="col">Captured</th><th scope="col">Return</th><th scope="col">Realized P&amp;L</th><th scope="col">Drawdown</th><th scope="col">Closed / open</th><th scope="col">Evidence</th></tr></thead>
        <tbody>{visibleRows.map((point, index) => <tr key={`${point.capturedAt}-${index}`}>
          <th scope="row">{performanceCapturedLabel(point.capturedAt)}</th>
          <td className={point.netReturnPercent !== undefined && point.netReturnPercent < 0 ? "marketplace-metric-negative" : "marketplace-metric-positive"}>{marketplaceSignedPercent(point.netReturnPercent)}</td>
          <td>{point.realizedPnlUsd === undefined ? "—" : marketplaceMoney(point.realizedPnlUsd)}</td>
          <td>{point.maximumDrawdownPercent === undefined ? "—" : `${Math.abs(point.maximumDrawdownPercent).toFixed(1)}%`}</td>
          <td>{point.completedTrades.toLocaleString()} / {point.openPositions.toLocaleString()}</td>
          <td><span className={`marketplace-history-evidence marketplace-history-evidence-${point.evidenceStatus.toLocaleLowerCase()}`}>{historyEvidenceLabel(point)}</span></td>
        </tr>)}</tbody>
      </table>
    </div>
    {ordered.length > visibleRows.length && <p className="marketplace-history-footnote">Showing the latest {visibleRows.length} of {ordered.length.toLocaleString()} actual snapshots. The chart includes every captured snapshot with a return value.</p>}
    <p className="marketplace-history-disclosure">{latest.disclosure || "Recorded PAPER performance is not a guarantee of future results."}</p>
  </div>;
}

function PilotCard({
  pilot,
  enrolled,
  paperOnly,
  onOpen
}: {
  pilot: MarketplacePilot;
  enrolled: boolean;
  paperOnly: boolean;
  onOpen: () => void;
}) {
  return <article className={`marketplace-pilot-card marketplace-risk-${pilot.risk.toLocaleLowerCase()}`}>
    <header>
      <div className="marketplace-pilot-identity">
        <PilotCategoryIcon pilot={pilot} />
        <div>
          <span>{MARKETPLACE_CATEGORY_LABELS[pilot.category]}</span>
          <h3>{pilot.name}</h3>
        </div>
      </div>
      <MarketplaceBadge tone={pilot.risk === "EXTREME" ? "danger" : pilot.risk === "HIGH" ? "warning" : "neutral"}>
        {MARKETPLACE_RISK_LABELS[pilot.risk]}
      </MarketplaceBadge>
    </header>
    <p>{pilot.summary}</p>
    <PilotAvailabilityBadges pilot={pilot} paperOnly={paperOnly} />
    <dl className="marketplace-card-metrics">
      <div><dt>{pilot.performance.periodLabel} return</dt><dd><PerformanceValue value={pilot.performance.netReturnPercent} /></dd></div>
      <div><dt>Max drawdown</dt><dd><PerformanceValue value={pilot.performance.maximumDrawdownPercent} inverse /></dd></div>
      <div><dt>Closed trades</dt><dd><strong>{pilot.performance.completedTrades.toLocaleString()}</strong></dd></div>
    </dl>
    <div className="marketplace-evidence-line">
      <span className={`marketplace-evidence-dot marketplace-evidence-${pilot.evidence.status.toLocaleLowerCase()}`} aria-hidden="true" />
      <span>{pilot.evidence.label}</span>
      <small>{pilot.sourceTiming}</small>
    </div>
    <div className="marketplace-tag-row">
      {pilot.tags.slice(0, 3).map((tag) => <span key={tag}>{tag}</span>)}
    </div>
    <footer>
      <div>
        <span>{pilotCanAcceptPaperEnrollment(pilot) ? `From ${marketplaceMoney(pilot.allocation.minimumUsd)}` : "Research only"}</span>
        <small>Curated by {pilot.curator.name}</small>
      </div>
      <MarketplaceButton tone={enrolled ? "secondary" : "primary"} onClick={onOpen}>
        {enrolled ? "View pilot" : pilotCanAcceptPaperEnrollment(pilot) ? "Explore & allocate" : "View research"}
        <IconChevronRight aria-hidden="true" size={14} />
      </MarketplaceButton>
    </footer>
  </article>;
}

function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  return <section className="marketplace-detail-section"><h3>{title}</h3>{children}</section>;
}

function PilotDetailDrawer({
  pilot,
  alreadyEnrolled,
  paperOnly,
  actionsReady,
  buyingPowerUsd,
  busy,
  mutationError,
  onClose,
  onEnroll
}: {
  pilot: MarketplacePilot | undefined;
  alreadyEnrolled: boolean;
  paperOnly: boolean;
  actionsReady: boolean;
  buyingPowerUsd: number | undefined;
  busy: boolean;
  mutationError: string | undefined;
  onClose: () => void;
  onEnroll: (allocation: MarketplaceEnrollmentAllocation) => Promise<void>;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const [allocation, setAllocation] = useState("");
  const [allocationMode, setAllocationMode] = useState<"USD" | "PERCENT">("USD");
  const [allocationPercent, setAllocationPercent] = useState("");
  const [referenceNav, setReferenceNav] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const dialogRef = useDialogLifecycle(Boolean(pilot), onClose);

  useEffect(() => {
    if (!pilot) return;
    setAllocation(pilot.allocation.recommendedUsd.toFixed(2));
    setAllocationMode("USD");
    setAllocationPercent("");
    setReferenceNav("");
    setAcknowledged(false);
  }, [pilot]);

  if (!pilot) return null;
  const allocationPercentValue = Number(allocationPercent);
  const referenceNavValue = Number(referenceNav);
  const percentCalculation = calculateMarketplacePercentAllocation(
    allocationPercentValue,
    referenceNavValue,
    pilot.allocation.maximumNavPercent
  );
  const allocationValue = allocationMode === "USD"
    ? Number(allocation)
    : percentCalculation.allocationUsd ?? Number.NaN;
  const percentValidationError = allocationMode === "PERCENT"
    ? percentCalculation.error
    : undefined;
  const validationError = percentValidationError ?? validateMarketplaceAllocation(pilot, allocationValue, buyingPowerUsd);
  const canEnroll = pilotCanAcceptPaperEnrollment(pilot) && !alreadyEnrolled;

  return <div className="marketplace-overlay" role="presentation" onMouseDown={(event) => {
    if (event.currentTarget === event.target) onClose();
  }}>
    <div
      className="marketplace-drawer"
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      tabIndex={-1}
    >
      <header className="marketplace-drawer-header">
        <div className="marketplace-pilot-identity">
          <PilotCategoryIcon pilot={pilot} size={24} />
          <div><span>{MARKETPLACE_CATEGORY_LABELS[pilot.category]} · {MARKETPLACE_ASSET_LABELS[pilot.assetClass]}</span><h2 id={titleId}>{pilot.name}</h2></div>
        </div>
        <button className="marketplace-icon-button" onClick={onClose} aria-label="Close pilot details"><IconX aria-hidden="true" size={19} /></button>
      </header>

      <div className="marketplace-drawer-scroll">
        <div className="marketplace-detail-intro">
          <div><PilotAvailabilityBadges pilot={pilot} paperOnly={paperOnly} /><MarketplaceBadge tone={pilot.risk === "EXTREME" ? "danger" : "warning"}>{MARKETPLACE_RISK_LABELS[pilot.risk]}</MarketplaceBadge></div>
          <p id={descriptionId}>{pilot.description}</p>
          <small>Curated by <strong>{pilot.curator.name}</strong>{pilot.curator.detail ? ` · ${pilot.curator.detail}` : ""}</small>
        </div>

        <dl className="marketplace-detail-metrics">
          <div><dt>{pilot.performance.periodLabel} return</dt><dd><PerformanceValue value={pilot.performance.netReturnPercent} /></dd></div>
          <div><dt>Benchmark</dt><dd><PerformanceValue value={pilot.performance.benchmarkReturnPercent} /></dd></div>
          <div><dt>Max drawdown</dt><dd><PerformanceValue value={pilot.performance.maximumDrawdownPercent} inverse /></dd></div>
          <div><dt>Win rate</dt><dd><PerformanceValue value={pilot.performance.winRatePercent} /></dd></div>
          <div><dt>Profit factor</dt><dd><strong>{pilot.performance.profitFactor?.toFixed(2) ?? "—"}</strong></dd></div>
          <div><dt>Closed trades</dt><dd><strong>{pilot.performance.completedTrades.toLocaleString()}</strong></dd></div>
        </dl>
        <p className="marketplace-pricing-note"><IconDatabase aria-hidden="true" size={14} />{marketplacePricingEvidenceCopy(pilot.performance.pricingComplete)}{pilot.performance.updatedAt ? ` Updated ${marketplaceRelativeTime(pilot.performance.updatedAt)}.` : ""}</p>

        <DetailSection title="Transparent performance history">
          <PilotPerformanceHistory history={pilot.performanceHistory} pilotName={pilot.name} />
        </DetailSection>

        <DetailSection title="Evidence, not a promise">
          <div className="marketplace-evidence-card">
            <header><span className={`marketplace-evidence-dot marketplace-evidence-${pilot.evidence.status.toLocaleLowerCase()}`} /><strong>{pilot.evidence.label}</strong><span>{pilot.evidence.sampleSize.toLocaleString()} observations</span></header>
            {pilot.evidence.minimumSampleSize !== undefined && <div className="marketplace-evidence-progress"><span style={{ width: `${Math.min(100, pilot.evidence.sampleSize / Math.max(1, pilot.evidence.minimumSampleSize) * 100)}%` }} /></div>}
            <ul>{pilot.evidence.notes.map((note) => <li key={note}>{note}</li>)}</ul>
          </div>
        </DetailSection>

        <div className="marketplace-detail-columns">
          <DetailSection title="How it decides">
            <ol className="marketplace-method-list">{pilot.methodology.map((step, index) => <li key={step}><span>{index + 1}</span><p>{step}</p></li>)}</ol>
          </DetailSection>
          <DetailSection title="Know the risk">
            <ul className="marketplace-risk-list">{pilot.risks.map((risk) => <li key={risk}><IconAlertTriangle aria-hidden="true" size={14} /><span>{risk}</span></li>)}</ul>
          </DetailSection>
        </div>

        <DetailSection title="Source timing">
          <p className="marketplace-source-note"><IconClock aria-hidden="true" size={15} />{pilot.sourceTiming}</p>
        </DetailSection>

        <section className="marketplace-enroll-card" aria-labelledby={`${titleId}-allocation`}>
          <header><div><span>PAPER allocation</span><h3 id={`${titleId}-allocation`}>{canEnroll ? "Add this pilot to your lab" : alreadyEnrolled ? "Already in My Pilots" : "Enrollment unavailable"}</h3></div><IconFlask aria-hidden="true" size={20} /></header>
          {canEnroll ? <>
            <p>This creates one isolated virtual allocation. It cannot place a real brokerage order.</p>
            <div className="marketplace-allocation-mode" role="group" aria-label="Allocation input type">
              <button type="button" aria-pressed={allocationMode === "USD"} onClick={() => setAllocationMode("USD")}>Dollar amount</button>
              <button type="button" aria-pressed={allocationMode === "PERCENT"} onClick={() => setAllocationMode("PERCENT")}><IconPercentage aria-hidden="true" size={14} />Percent of reference NAV</button>
            </div>
            {allocationMode === "USD" ? <label className="marketplace-allocation-field">
              <span>Allocation amount (USD)</span>
              <div><b>$</b><input inputMode="decimal" min={pilot.allocation.minimumUsd} max={pilot.allocation.maximumUsd} step="0.01" value={allocation} onChange={(event) => setAllocation(event.target.value)} aria-describedby={`${titleId}-allocation-help`} /></div>
              <small id={`${titleId}-allocation-help`}>{marketplaceMoney(pilot.allocation.minimumUsd)} minimum · {marketplaceMoney(pilot.allocation.maximumUsd)} maximum · {pilot.allocation.maximumNavPercent}% NAV cap{buyingPowerUsd !== undefined ? ` · ${marketplaceMoney(buyingPowerUsd)} recorded PAPER buying power` : ""}</small>
            </label> : <div className="marketplace-percent-allocation">
              <label className="marketplace-allocation-field">
                <span>Allocation percentage</span>
                <div><input aria-label="Allocation percentage" inputMode="decimal" min="0.01" max="100" step="0.01" value={allocationPercent} onChange={(event) => setAllocationPercent(event.target.value)} /><b>%</b></div>
                <small>Greater than 0% and no more than this pilot's {pilot.allocation.maximumNavPercent.toFixed(2)}% reference-NAV cap.</small>
              </label>
              <label className="marketplace-allocation-field">
                <span>Reference PAPER NAV</span>
                <div><b>$</b><input aria-label="Reference PAPER NAV" inputMode="decimal" min="0.01" max="100000000" step="0.01" value={referenceNav} onChange={(event) => setReferenceNav(event.target.value)} /></div>
                <small>Enter the PAPER NAV this percentage should reference. It is not inferred buying power and does not link a brokerage account.</small>
              </label>
              <div className="marketplace-percent-preview" aria-live="polite"><span>Computed isolated PAPER allocation</span><strong>{Number.isFinite(allocationValue) && allocationValue > 0 ? marketplaceMoney(allocationValue) : "—"}</strong><small>{allocationPercentValue > 0 && referenceNavValue > 0 ? `${allocationPercentValue.toFixed(2)}% of ${marketplaceMoney(referenceNavValue)}` : "Enter both values to calculate the USD allocation."}</small></div>
            </div>}
            {validationError && <p className="marketplace-inline-error" role="alert"><IconAlertTriangle aria-hidden="true" size={14} />{validationError}</p>}
            <label className="marketplace-check-row"><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} /><span>I understand this is simulated PAPER trading and past results do not guarantee future profit.</span></label>
            {mutationError && <p className="marketplace-inline-error" role="alert"><IconAlertTriangle aria-hidden="true" size={14} />{mutationError}</p>}
            <MarketplaceButton
              tone="primary"
              icon={IconFlask}
              busy={busy}
              disabled={!actionsReady || Boolean(validationError) || !acknowledged}
              onClick={() => void onEnroll(allocationMode === "USD"
                ? { kind: "USD", value: allocationValue }
                : { kind: "PERCENT", value: allocationPercentValue, referenceNavUsd: referenceNavValue })}
            >Enroll in PAPER</MarketplaceButton>
            {!actionsReady && <small className="marketplace-action-help">Marketplace service connection is required before this control can save an enrollment.</small>}
          </> : <p>{alreadyEnrolled ? "Manage its allocation, pause state, switches, and rebalances from My Pilots." : pilot.stage === "RESEARCH_ONLY" ? "This catalog entry is research-only and has no enrollable marketplace PAPER engine in this release." : "This pilot is currently paused or does not expose an enrollable PAPER engine."}</p>}
        </section>
      </div>
    </div>
  </div>;
}

function BrokerCard({
  broker,
  busy,
  canConnect,
  onConnect
}: {
  broker: MarketplaceBrokerConnection;
  busy: boolean;
  canConnect: boolean;
  onConnect: () => void;
}) {
  const connected = broker.status === "CONNECTED" || broker.status === "PAPER_CONNECTED";
  const localSimulation = broker.id === "COPYLAB_PAPER";
  const unsupported = broker.status === "UNAVAILABLE" ||
    broker.status === "LOCKED_NOT_IMPLEMENTED" ||
    broker.status === "OFFICIAL_ACCESS_REQUIRED" ||
    broker.status === "UNAVAILABLE_WITHOUT_WRITTEN_AUTHORIZATION" ||
    broker.status === "NOT_CONFIGURED_LIVE_LOCKED" ||
    broker.status === "ACTION_REQUIRED";
  const connectEnabled = canConnect && broker.official && !unsupported;
  const tone = connected ? "positive" : broker.status === "OFFICIAL_ACCESS_REQUIRED" ? "warning" : unsupported ? "danger" : "neutral";
  return <article className="marketplace-broker-card">
    <header>
      <span className="marketplace-broker-icon"><IconBuildingBank aria-hidden="true" size={21} /></span>
      <div><span>{localSimulation ? "Local PAPER simulator active" : connected ? "Provider PAPER/data access connected" : unsupported ? "Connector unavailable or not implemented" : broker.official ? "Official provider setup path" : "Local simulation"}</span><h3>{broker.name}</h3></div>
      <MarketplaceBadge tone={tone}>{broker.status.replaceAll("_", " ")}</MarketplaceBadge>
    </header>
    <p>{broker.detail}</p>
    <div className="marketplace-broker-capabilities">{broker.capabilities.map((capability) => <span key={capability}><IconCheck aria-hidden="true" size={12} />{capability}</span>)}</div>
    <dl>
      <div><dt>Account</dt><dd>{broker.accountLabel ?? "Not linked"}</dd></div>
      <div><dt>Provider PAPER/data</dt><dd>{broker.paperSupported ? "Capability available" : "Unavailable"}</dd></div>
      <div><dt>External routing</dt><dd>Disabled</dd></div>
      <div><dt>Live orders</dt><dd>{broker.liveSupported ? "Connector capable" : "Locked"}</dd></div>
      {broker.buyingPowerUsd !== undefined && <div><dt>Buying power</dt><dd>{marketplaceMoney(broker.buyingPowerUsd)}</dd></div>}
    </dl>
    <footer>
      <small>{broker.lastCheckedAt ? `Checked ${marketplaceRelativeTime(broker.lastCheckedAt)}` : "Connection has not been checked"}</small>
      {!connected && <MarketplaceButton busy={busy} disabled={!connectEnabled} onClick={onConnect}>{broker.status === "OFFICIAL_ACCESS_REQUIRED" ? "Official access required" : unsupported ? "Unavailable" : broker.status === "PAPER_READY" ? "Configure provider PAPER/data" : broker.official ? "Connect data access" : "Unavailable"}</MarketplaceButton>}
    </footer>
  </article>;
}

function EnrollmentCard({
  enrollment,
  pilot,
  busy,
  actionsReady,
  onTogglePause,
  onViewLedger,
  onRebalance,
  onSwitch,
  onUnenroll
}: {
  enrollment: MarketplaceEnrollment;
  pilot: MarketplacePilot | undefined;
  busy: boolean;
  actionsReady: boolean;
  onTogglePause: () => void;
  onViewLedger: () => void;
  onRebalance: () => void;
  onSwitch: () => void;
  onUnenroll: () => void;
}) {
  const totalPnl = enrollment.realizedPnlUsd + enrollment.unrealizedPnlUsd;
  return <article className={`marketplace-enrollment-card marketplace-enrollment-${enrollment.status.toLocaleLowerCase()}`}>
    <header>
      {pilot ? <PilotCategoryIcon pilot={pilot} /> : <span className="marketplace-category-icon"><IconFlask aria-hidden="true" size={20} /></span>}
      <div><span>{pilot ? MARKETPLACE_CATEGORY_LABELS[pilot.category] : "Pilot unavailable"}</span><h3>{pilot?.name ?? enrollment.pilotId}</h3></div>
      <MarketplaceBadge tone={enrollment.status === "ACTIVE" ? "positive" : "warning"}>{enrollment.status.replaceAll("_", " ")}</MarketplaceBadge>
    </header>
    <div className="marketplace-enrollment-mode"><IconLock aria-hidden="true" size={13} /><strong>{enrollment.mode}</strong><span>isolated virtual account</span></div>
    {enrollment.allocationPercent !== undefined && enrollment.allocationReferenceNavUsd !== undefined && <p className="marketplace-enrollment-allocation-source"><IconPercentage aria-hidden="true" size={13} />Allocated as {enrollment.allocationPercent.toFixed(2)}% of a {marketplaceMoney(enrollment.allocationReferenceNavUsd)} reference PAPER NAV</p>}
    <dl>
      <div><dt>Allocated</dt><dd>{marketplaceMoney(enrollment.allocationUsd)}</dd></div>
      <div><dt>Executable PAPER NAV</dt><dd>{marketplaceMoney(enrollment.currentValueUsd)}</dd></div>
      <div><dt>Net P&amp;L</dt><dd className={totalPnl >= 0 ? "marketplace-metric-positive" : "marketplace-metric-negative"}>{totalPnl >= 0 ? "+" : ""}{marketplaceMoney(totalPnl)}</dd></div>
      <div><dt>Mirrored PAPER fills</dt><dd>{enrollment.mirroredOrders.toLocaleString()}</dd></div>
    </dl>
    <p><IconClock aria-hidden="true" size={13} />{enrollment.lastMirroredAt ? `Last committed PAPER fill ${marketplaceRelativeTime(enrollment.lastMirroredAt)}` : "Waiting for the first eligible committed source fill"}</p>
    {enrollment.openPositions > 0 && <p className="marketplace-enrollment-exposure" id={`marketplace-exposure-${enrollment.id}`}><IconLock aria-hidden="true" size={13} />{enrollment.openPositions.toLocaleString()} open PAPER position{enrollment.openPositions === 1 ? "" : "s"}; unenrollment stays blocked until exposure is zero.</p>}
    {enrollment.pausedReason && <p className="marketplace-enrollment-reason"><IconAlertTriangle aria-hidden="true" size={13} />{enrollment.pausedReason}</p>}
    <footer>
      <MarketplaceButton
        tone={enrollment.status === "ACTIVE" ? "danger" : "primary"}
        icon={enrollment.status === "ACTIVE" ? IconPlayerPause : IconPlayerPlay}
        busy={busy}
        disabled={!actionsReady || enrollment.status === "REBALANCE_PENDING"}
        onClick={onTogglePause}
      >{enrollment.status === "ACTIVE" ? "Pause" : "Resume"}</MarketplaceButton>
      <MarketplaceButton icon={IconBook2} disabled={!actionsReady} onClick={onViewLedger}>View ledger</MarketplaceButton>
      <MarketplaceButton icon={IconAdjustmentsHorizontal} disabled={!actionsReady} onClick={onRebalance}>Rebalance USD</MarketplaceButton>
      <MarketplaceButton icon={IconArrowsExchange} disabled={!actionsReady} onClick={onSwitch}>Switch</MarketplaceButton>
      <MarketplaceButton
        tone="danger"
        icon={IconTrash}
        disabled={!actionsReady || enrollment.openPositions > 0}
        aria-describedby={enrollment.openPositions > 0 ? `marketplace-exposure-${enrollment.id}` : undefined}
        title={enrollment.openPositions > 0 ? "Close all PAPER exposure before unenrolling." : "Remove this isolated PAPER pilot after confirmation."}
        onClick={onUnenroll}
      >Unenroll</MarketplaceButton>
    </footer>
  </article>;
}

function marketplaceQuantity(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 8 }).format(value);
}

function marketplaceReference(value: string): string {
  if (value.length <= 22) return value;
  return `${value.slice(0, 10)}…${value.slice(-8)}`;
}

function marketplaceEventLabel(kind: MarketplaceEnrollmentLedger["events"][number]["kind"]): string {
  const labels: Record<MarketplaceEnrollmentLedger["events"][number]["kind"], string> = {
    ENROLLED: "Enrollment created",
    PAUSED: "New entries paused",
    RESUMED: "Enrollment resumed",
    ALLOCATION_UPDATED: "Allocation updated",
    REBALANCE_PREVIEWED: "Rebalance previewed",
    REBALANCE_APPLIED: "Rebalance applied",
    PAPER_MIRROR_OPENED: "PAPER position opened",
    PAPER_MIRROR_REDUCED: "PAPER position reduced",
    PAPER_MIRROR_CLOSED: "PAPER position closed",
    PAPER_POSITION_MARKED: "Executable value marked",
    SWITCHED: "Pilot switched",
    UNENROLLED: "Enrollment removed"
  };
  return labels[kind];
}

export function EnrollmentLedgerDialog({
  enrollment,
  pilot,
  ledger,
  loading,
  error,
  onClose,
  onRetry,
  initialTab = "POSITIONS"
}: {
  enrollment: MarketplaceEnrollment | undefined;
  pilot: MarketplacePilot | undefined;
  ledger: MarketplaceEnrollmentLedger | undefined;
  loading: boolean;
  error: string | undefined;
  onClose: () => void;
  onRetry: () => void;
  initialTab?: "POSITIONS" | "FILLS" | "AUDIT";
}) {
  const titleId = useId();
  const [tab, setTab] = useState<"POSITIONS" | "FILLS" | "AUDIT">(initialTab);
  const dialogRef = useDialogLifecycle(Boolean(enrollment), onClose);

  useEffect(() => {
    if (enrollment) setTab(initialTab);
  }, [enrollment?.id, initialTab]);

  if (!enrollment) return null;
  const positions = [...(ledger?.positions ?? [])].sort((left, right) => {
    if (left.status !== right.status) return left.status === "OPEN" ? -1 : 1;
    return right.updatedAt.localeCompare(left.updatedAt);
  });
  const fills = [...(ledger?.fills ?? [])].sort((left, right) => right.filledAt.localeCompare(left.filledAt));
  const events = [...(ledger?.events ?? [])].sort((left, right) => right.occurredAt.localeCompare(left.occurredAt));

  return <div className="marketplace-overlay marketplace-modal-overlay" role="presentation" onMouseDown={(event) => {
    if (event.currentTarget === event.target) onClose();
  }}>
    <div className="marketplace-ledger-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} ref={dialogRef}>
      <header className="marketplace-ledger-header">
        <span className="marketplace-dialog-icon"><IconBook2 aria-hidden="true" size={21} /></span>
        <div><span>Committed isolated PAPER ledger</span><h2 id={titleId}>{pilot?.name ?? enrollment.pilotId}</h2><small>Positions, fills, and audit events come from the saved marketplace ledger.</small></div>
        <button className="marketplace-icon-button" aria-label="Close enrollment ledger" onClick={onClose}><IconX aria-hidden="true" size={18} /></button>
      </header>

      <div className="marketplace-ledger-summary">
        <div><span>Funded</span><strong>{marketplaceMoney(enrollment.allocationUsd)}</strong></div>
        <div><span>Executable PAPER NAV</span><strong>{marketplaceMoney(enrollment.currentValueUsd)}</strong></div>
        <div><span>Open exposure</span><strong>{enrollment.openPositions.toLocaleString()}</strong></div>
        <div><span>Committed fills</span><strong>{enrollment.mirroredOrders.toLocaleString()}</strong></div>
      </div>

      <nav className="marketplace-ledger-tabs" role="tablist" aria-label="Enrollment ledger views">
        <button role="tab" aria-selected={tab === "POSITIONS"} onClick={() => setTab("POSITIONS")}><IconChartLine aria-hidden="true" size={14} />Positions<span>{positions.length}</span></button>
        <button role="tab" aria-selected={tab === "FILLS"} onClick={() => setTab("FILLS")}><IconReceipt aria-hidden="true" size={14} />Fills<span>{fills.length}</span></button>
        <button role="tab" aria-selected={tab === "AUDIT"} onClick={() => setTab("AUDIT")}><IconHistory aria-hidden="true" size={14} />Audit<span>{events.length}</span></button>
      </nav>

      <div className="marketplace-ledger-body">
        {loading ? <div className="marketplace-ledger-state" aria-live="polite"><span className="marketplace-spinner" aria-hidden="true" /><div><strong>Loading committed ledger</strong><p>Reading the enrollment, PAPER positions, fills, and audit history.</p></div></div>
          : error ? <div className="marketplace-ledger-state marketplace-ledger-state-error" role="alert"><IconAlertTriangle aria-hidden="true" size={18} /><div><strong>Ledger unavailable</strong><p>{error}</p><MarketplaceButton icon={IconRefresh} onClick={onRetry}>Try again</MarketplaceButton></div></div>
            : tab === "POSITIONS" ? positions.length === 0 ? <div className="marketplace-ledger-state"><IconChartLine aria-hidden="true" size={18} /><div><strong>No PAPER positions recorded</strong><p>This enrollment has not opened a committed mirror lot yet. Nothing is inferred from signals or quotes.</p></div></div>
              : <div className="marketplace-ledger-table-wrap"><table className="marketplace-ledger-table"><caption className="marketplace-sr-only">Recorded PAPER positions for {pilot?.name ?? enrollment.pilotId}</caption><thead><tr><th scope="col">Asset / source lot</th><th scope="col">Status</th><th scope="col">Quantity</th><th scope="col">Entry</th><th scope="col">Executable value</th><th scope="col">P&amp;L</th><th scope="col">Updated</th></tr></thead><tbody>{positions.map((position) => <tr key={position.id}><th scope="row"><strong>{position.assetId}</strong><code title={position.sourcePositionReference}>{marketplaceReference(position.sourcePositionReference)}</code></th><td><span className={`marketplace-ledger-status marketplace-ledger-status-${position.status.toLocaleLowerCase()}`}>{position.status}</span></td><td>{marketplaceQuantity(position.quantity)}</td><td>{marketplaceMoney(position.entryPriceUsd)}<small>{marketplaceMoney(position.costBasisUsd)} basis</small></td><td>{marketplaceMoney(position.lastExecutableValueUsd)}</td><td className={(position.status === "CLOSED" ? position.realizedPnlUsd ?? 0 : position.unrealizedPnlUsd) >= 0 ? "marketplace-metric-positive" : "marketplace-metric-negative"}>{(position.status === "CLOSED" ? position.realizedPnlUsd ?? 0 : position.unrealizedPnlUsd) >= 0 ? "+" : ""}{marketplaceMoney(position.status === "CLOSED" ? position.realizedPnlUsd ?? 0 : position.unrealizedPnlUsd)}</td><td>{performanceCapturedLabel(position.updatedAt)}</td></tr>)}</tbody></table></div>
            : tab === "FILLS" ? fills.length === 0 ? <div className="marketplace-ledger-state"><IconReceipt aria-hidden="true" size={18} /><div><strong>No committed PAPER fills</strong><p>Only completed marketplace mirror fills appear here. Rejected signals and unfilled decisions are not presented as trades.</p></div></div>
              : <div className="marketplace-ledger-table-wrap"><table className="marketplace-ledger-table"><caption className="marketplace-sr-only">Committed PAPER fills for {pilot?.name ?? enrollment.pilotId}</caption><thead><tr><th scope="col">Fill / source</th><th scope="col">Action</th><th scope="col">Asset</th><th scope="col">Quantity @ price</th><th scope="col">Gross</th><th scope="col">Modeled costs</th><th scope="col">Net cash</th><th scope="col">Filled</th></tr></thead><tbody>{fills.map((fill) => <tr key={fill.id}><th scope="row"><code title={fill.sourceReference}>{marketplaceReference(fill.sourceReference)}</code><small>Source {performanceCapturedLabel(fill.sourceOccurredAt)}</small></th><td><span className={`marketplace-ledger-status marketplace-ledger-action-${fill.action.toLocaleLowerCase()}`}>{fill.action}</span></td><td>{fill.assetId}</td><td>{marketplaceQuantity(fill.quantity)}<small>@ {marketplaceMoney(fill.priceUsd)}</small></td><td>{marketplaceMoney(fill.grossNotionalUsd)}</td><td>{marketplaceMoney(fill.modeledCostsUsd)}</td><td className={fill.netCashChangeUsd >= 0 ? "marketplace-metric-positive" : "marketplace-metric-negative"}>{fill.netCashChangeUsd >= 0 ? "+" : ""}{marketplaceMoney(fill.netCashChangeUsd)}</td><td>{performanceCapturedLabel(fill.filledAt)}</td></tr>)}</tbody></table></div>
            : events.length === 0 ? <div className="marketplace-ledger-state"><IconHistory aria-hidden="true" size={18} /><div><strong>No audit events recorded</strong><p>The audit ledger is empty for this enrollment. CopyLab does not invent lifecycle events.</p></div></div>
              : <ol className="marketplace-audit-list">{events.map((event) => <li key={event.id}><span className="marketplace-audit-marker"><IconHistory aria-hidden="true" size={13} /></span><div><header><strong>{marketplaceEventLabel(event.kind)}</strong><time dateTime={event.occurredAt}>{performanceCapturedLabel(event.occurredAt)}</time></header><span>{event.kind.replaceAll("_", " ")}</span>{Object.keys(event.details).length > 0 && <dl>{Object.entries(event.details).map(([key, value]) => <div key={key}><dt>{key.replaceAll("_", " ")}</dt><dd title={String(value)}>{typeof value === "string" ? marketplaceReference(value) : String(value)}</dd></div>)}</dl>}</div></li>)}</ol>}
      </div>
      <footer className="marketplace-ledger-footnote"><IconLock aria-hidden="true" size={14} /><span>Read-only view. Up to the latest 200 audit events are loaded, and no control here can submit or sign an external order.</span></footer>
    </div>
  </div>;
}

export function ConfirmUnenrollDialog({
  enrollment,
  pilot,
  busy,
  actionsReady,
  error,
  onClose,
  onConfirm
}: {
  enrollment: MarketplaceEnrollment | undefined;
  pilot: MarketplacePilot | undefined;
  busy: boolean;
  actionsReady: boolean;
  error: string | undefined;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const titleId = useId();
  const [confirmed, setConfirmed] = useState(false);
  const dialogRef = useDialogLifecycle(Boolean(enrollment), onClose);

  useEffect(() => {
    if (enrollment) setConfirmed(false);
  }, [enrollment?.id]);

  if (!enrollment) return null;
  const exposureBlocked = enrollment.openPositions > 0;
  return <div className="marketplace-overlay marketplace-modal-overlay" role="presentation" onMouseDown={(event) => {
    if (event.currentTarget === event.target) onClose();
  }}>
    <div className="marketplace-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} ref={dialogRef}>
      <header><span className="marketplace-dialog-icon marketplace-dialog-icon-danger"><IconTrash aria-hidden="true" size={20} /></span><div><span>Isolated PAPER enrollment</span><h2 id={titleId}>Unenroll {pilot?.name ?? enrollment.pilotId}?</h2></div><button className="marketplace-icon-button" aria-label="Cancel unenrollment" onClick={onClose}><IconX aria-hidden="true" size={18} /></button></header>
      <p>Unenrollment stops future mirrored entries and removes this pilot from My Pilots. Its committed audit history remains recorded.</p>
      {exposureBlocked ? <div className="marketplace-unenroll-blocked" role="status"><IconLock aria-hidden="true" size={17} /><div><strong>Open exposure blocks unenrollment</strong><p>{enrollment.openPositions.toLocaleString()} PAPER position{enrollment.openPositions === 1 ? " is" : "s are"} still open. Close or safely resolve every position before removing this enrollment.</p></div></div> : <label className="marketplace-check-row"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span>I understand this removes the enrollment from My Pilots and stops future PAPER entries.</span></label>}
      {error && <p className="marketplace-inline-error" role="alert"><IconAlertTriangle aria-hidden="true" size={14} />{error}</p>}
      <div className="marketplace-confirm-actions"><MarketplaceButton onClick={onClose}>Keep pilot</MarketplaceButton><MarketplaceButton tone="danger" icon={IconTrash} busy={busy} disabled={!actionsReady || exposureBlocked || !confirmed} onClick={() => void onConfirm()}>Confirm unenroll</MarketplaceButton></div>
    </div>
  </div>;
}

function WorkflowDialog({
  workflow,
  enrollment,
  currentPilot,
  pilots,
  busy,
  mutationError,
  preview,
  onClose,
  onPreview,
  onConfirmPreview,
  onSwitch
}: {
  workflow: EnrollmentWorkflow | undefined;
  enrollment: MarketplaceEnrollment | undefined;
  currentPilot: MarketplacePilot | undefined;
  pilots: readonly MarketplacePilot[];
  busy: boolean;
  mutationError: string | undefined;
  preview: MarketplaceRebalancePreview | undefined;
  onClose: () => void;
  onPreview: (target: number) => Promise<void>;
  onConfirmPreview: () => Promise<void>;
  onSwitch: (targetPilotId: string) => Promise<void>;
}) {
  const titleId = useId();
  const [targetAllocation, setTargetAllocation] = useState("");
  const [targetPilotId, setTargetPilotId] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const dialogRef = useDialogLifecycle(Boolean(workflow), onClose);

  useEffect(() => {
    if (!workflow || !enrollment) return;
    setTargetAllocation(enrollment.allocationUsd.toFixed(2));
    setTargetPilotId("");
    setConfirmed(false);
  }, [workflow, enrollment]);

  if (!workflow || !enrollment) return null;
  const switchTargets = pilots.filter((pilot) => pilot.id !== enrollment.pilotId && pilotCanAcceptPaperEnrollment(pilot));
  const targetValue = Number(targetAllocation);
  const allocationError = currentPilot
    ? validateMarketplaceAllocation(currentPilot, targetValue)
    : "Current pilot details are unavailable.";
  const isRebalance = workflow.type === "REBALANCE";

  return <div className="marketplace-overlay marketplace-modal-overlay" role="presentation" onMouseDown={(event) => {
    if (event.currentTarget === event.target) onClose();
  }}>
    <div className="marketplace-workflow-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} ref={dialogRef}>
      <header><span className="marketplace-dialog-icon">{isRebalance ? <IconAdjustmentsHorizontal aria-hidden="true" size={21} /> : <IconArrowsExchange aria-hidden="true" size={21} />}</span><div><span>PAPER portfolio control</span><h2 id={titleId}>{isRebalance ? "Preview a dollar rebalance" : "Switch pilots"}</h2></div><button className="marketplace-icon-button" aria-label="Close portfolio control" onClick={onClose}><IconX aria-hidden="true" size={18} /></button></header>
      <p>{isRebalance ? `Change the isolated USD allocation for ${currentPilot?.name ?? enrollment.pilotId}. Percentage rebalancing is not supported by this route, and nothing changes until you inspect and confirm the preview.` : `Move this isolated PAPER allocation from ${currentPilot?.name ?? enrollment.pilotId} to another enrollable pilot with an implemented PAPER engine.`}</p>

      {isRebalance ? <>
        <label className="marketplace-allocation-field"><span>Target allocation (USD)</span><div><b>$</b><input inputMode="decimal" value={targetAllocation} onChange={(event) => setTargetAllocation(event.target.value)} /></div><small>Current allocation: {marketplaceMoney(enrollment.allocationUsd)} · this preview accepts dollars only</small></label>
        {allocationError && <p className="marketplace-inline-error"><IconAlertTriangle aria-hidden="true" size={14} />{allocationError}</p>}
        {!preview ? <MarketplaceButton tone="primary" icon={IconTargetArrow} busy={busy} disabled={Boolean(allocationError)} onClick={() => void onPreview(targetValue)}>Build preview</MarketplaceButton> : <div className="marketplace-rebalance-preview">
          <header><IconShieldCheck aria-hidden="true" size={18} /><div><strong>Preview ready</strong><small>Expires {new Date(preview.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</small></div></header>
          <dl>
            <div><dt>Current</dt><dd>{marketplaceMoney(preview.currentAllocationUsd)}</dd></div>
            <div><dt>Target</dt><dd>{marketplaceMoney(preview.targetAllocationUsd)}</dd></div>
            <div><dt>Cash change</dt><dd>{preview.cashChangeUsd >= 0 ? "+" : ""}{marketplaceMoney(preview.cashChangeUsd)}</dd></div>
            <div><dt>Modeled costs</dt><dd>{marketplaceMoney(preview.estimatedCostsUsd)}</dd></div>
          </dl>
          {preview.orders.length > 0 && <div className="marketplace-order-preview"><span>Modeled PAPER orders</span>{preview.orders.map((order, index) => <div key={`${order.symbol}-${order.side}-${index}`}><strong>{order.side} {order.symbol}</strong><span>{marketplaceMoney(order.estimatedNotionalUsd)}</span></div>)}</div>}
          {preview.warnings.map((warning) => <p className="marketplace-preview-warning" key={warning}><IconAlertTriangle aria-hidden="true" size={13} />{warning}</p>)}
          <label className="marketplace-check-row"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span>I reviewed this preview and authorize this PAPER-only rebalance.</span></label>
          <MarketplaceButton tone="primary" icon={IconCheck} busy={busy} disabled={!confirmed} onClick={() => void onConfirmPreview()}>Confirm PAPER rebalance</MarketplaceButton>
        </div>}
      </> : <>
        <label className="marketplace-select-field"><span>New pilot</span><select value={targetPilotId} onChange={(event) => setTargetPilotId(event.target.value)}><option value="">Select an enrollable PAPER pilot</option>{switchTargets.map((pilot) => <option key={pilot.id} value={pilot.id}>{pilot.name} · {MARKETPLACE_RISK_LABELS[pilot.risk]}</option>)}</select><small>The backend must re-run implementation availability and allocation checks before applying the switch.</small></label>
        <label className="marketplace-check-row"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span>I understand switching is allowed only after the current PAPER pilot has zero open exposure.</span></label>
        <MarketplaceButton tone="primary" icon={IconArrowsExchange} busy={busy} disabled={!targetPilotId || !confirmed} onClick={() => void onSwitch(targetPilotId)}>Confirm PAPER switch</MarketplaceButton>
      </>}
      {mutationError && <p className="marketplace-inline-error" role="alert"><IconAlertTriangle aria-hidden="true" size={14} />{mutationError}</p>}
    </div>
  </div>;
}

export function MarketplacePanel({
  pilots,
  enrollments,
  brokers,
  actions,
  loading = false,
  error,
  paperOnly = true,
  initialView = "DISCOVER",
  onRetry,
  onEnrollmentChange
}: MarketplacePanelProps) {
  const [view, setView] = useState<MarketplaceView>(initialView);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<MarketplacePilotCategory | "ALL">("ALL");
  const [assetClass, setAssetClass] = useState<"ALL" | "CRYPTO" | "US_STOCKS" | "MULTI_ASSET">("ALL");
  const [risk, setRisk] = useState<"ALL" | "CONSERVATIVE" | "MODERATE" | "HIGH" | "EXTREME">("ALL");
  const [localEnrollments, setLocalEnrollments] = useState<MarketplaceEnrollment[]>([...enrollments]);
  const [selectedPilotId, setSelectedPilotId] = useState<string>();
  const [workflow, setWorkflow] = useState<EnrollmentWorkflow>();
  const [preview, setPreview] = useState<MarketplaceRebalancePreview>();
  const [ledgerEnrollmentId, setLedgerEnrollmentId] = useState<string>();
  const [ledger, setLedger] = useState<MarketplaceEnrollmentLedger>();
  const [ledgerLoading, setLedgerLoading] = useState(false);
  const [ledgerError, setLedgerError] = useState<string>();
  const [unenrollEnrollmentId, setUnenrollEnrollmentId] = useState<string>();
  const [busyKey, setBusyKey] = useState<string>();
  const [mutationError, setMutationError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const ledgerRequestRef = useRef<AbortController | undefined>(undefined);

  useEffect(() => setLocalEnrollments([...enrollments]), [enrollments]);
  useEffect(() => () => ledgerRequestRef.current?.abort(), []);

  const filteredPilots = useMemo(() => filterMarketplacePilots(pilots, {
    query,
    category,
    assetClass,
    risk
  }), [pilots, query, category, assetClass, risk]);
  const selectedPilot = pilots.find((pilot) => pilot.id === selectedPilotId);
  const workflowEnrollment = workflow ? localEnrollments.find((enrollment) => enrollment.id === workflow.enrollmentId) : undefined;
  const workflowPilot = workflowEnrollment ? pilots.find((pilot) => pilot.id === workflowEnrollment.pilotId) : undefined;
  const ledgerEnrollment = ledgerEnrollmentId ? localEnrollments.find((enrollment) => enrollment.id === ledgerEnrollmentId) : undefined;
  const ledgerPilot = ledgerEnrollment ? pilots.find((pilot) => pilot.id === ledgerEnrollment.pilotId) : undefined;
  const unenrollEnrollment = unenrollEnrollmentId ? localEnrollments.find((enrollment) => enrollment.id === unenrollEnrollmentId) : undefined;
  const unenrollPilot = unenrollEnrollment ? pilots.find((pilot) => pilot.id === unenrollEnrollment.pilotId) : undefined;
  const paperBroker = brokers.find((broker) => broker.status === "PAPER_CONNECTED") ?? brokers.find((broker) => broker.paperSupported);
  const connectedExternalProviders = brokers.filter((broker) =>
    broker.id !== "COPYLAB_PAPER" &&
    (broker.status === "PAPER_CONNECTED" || broker.status === "CONNECTED")
  ).length;

  const replaceEnrollment = (next: MarketplaceEnrollment) => {
    setLocalEnrollments((current) => {
      const exists = current.some((enrollment) => enrollment.id === next.id);
      return exists ? current.map((enrollment) => enrollment.id === next.id ? next : enrollment) : [next, ...current];
    });
    onEnrollmentChange?.(next);
  };

  const perform = async (key: string, operation: () => Promise<MarketplaceEnrollment>, successMessage: string) => {
    setBusyKey(key);
    setMutationError(undefined);
    try {
      const next = await operation();
      replaceEnrollment(next);
      setNotice(successMessage);
      return true;
    } catch (cause) {
      setMutationError(cause instanceof Error ? cause.message : "The marketplace action failed safely.");
      return false;
    } finally {
      setBusyKey(undefined);
    }
  };

  const closePilot = () => {
    setSelectedPilotId(undefined);
    setMutationError(undefined);
  };

  const closeWorkflow = () => {
    setWorkflow(undefined);
    setPreview(undefined);
    setMutationError(undefined);
  };

  const openWorkflow = (type: EnrollmentWorkflow["type"], enrollmentId: string) => {
    setPreview(undefined);
    setMutationError(undefined);
    setWorkflow({ type, enrollmentId });
  };

  const loadEnrollmentLedger = async (enrollmentId: string) => {
    ledgerRequestRef.current?.abort();
    const controller = new AbortController();
    ledgerRequestRef.current = controller;
    setLedger(undefined);
    setLedgerError(undefined);
    if (!actions?.loadEnrollmentLedger) {
      setLedgerLoading(false);
      setLedgerError("Marketplace ledger access is unavailable until the local service connection is ready.");
      return;
    }
    setLedgerLoading(true);
    try {
      const next = await actions.loadEnrollmentLedger(enrollmentId, controller.signal);
      if (!controller.signal.aborted) setLedger(next);
    } catch (cause) {
      if (!controller.signal.aborted) {
        setLedgerError(cause instanceof Error ? cause.message : "The committed enrollment ledger could not be loaded.");
      }
    } finally {
      if (!controller.signal.aborted) setLedgerLoading(false);
    }
  };

  const openEnrollmentLedger = (enrollmentId: string) => {
    setLedgerEnrollmentId(enrollmentId);
    void loadEnrollmentLedger(enrollmentId);
  };

  const closeEnrollmentLedger = () => {
    ledgerRequestRef.current?.abort();
    setLedgerEnrollmentId(undefined);
    setLedger(undefined);
    setLedgerError(undefined);
    setLedgerLoading(false);
  };

  const confirmUnenroll = async () => {
    if (!actions || !unenrollEnrollment) return;
    if (unenrollEnrollment.openPositions > 0) {
      setMutationError("Open PAPER exposure must be zero before unenrollment.");
      return;
    }
    setBusyKey(`unenroll:${unenrollEnrollment.id}`);
    setMutationError(undefined);
    try {
      await actions.unenroll(unenrollEnrollment.id);
      setLocalEnrollments((current) => current.filter((enrollment) => enrollment.id !== unenrollEnrollment.id));
      setNotice(`${unenrollPilot?.name ?? "Pilot"} removed from My Pilots. Its audit history remains recorded.`);
      setUnenrollEnrollmentId(undefined);
    } catch (cause) {
      setMutationError(cause instanceof Error ? cause.message : "The enrollment could not be removed safely.");
    } finally {
      setBusyKey(undefined);
    }
  };

  return <section className="marketplace-panel" aria-labelledby="marketplace-title">
    <header className="marketplace-hero">
      <div className="marketplace-hero-copy">
        <span className="marketplace-kicker"><IconSparkles aria-hidden="true" size={14} />CopyLab pilot marketplace</span>
        <h2 id="marketplace-title">Choose the strategy. Keep control of the account.</h2>
        <p>Compare transparent evidence, assign isolated PAPER capital, and follow committed source fills that already passed the source strategy's PAPER policy.</p>
      </div>
      <div className="marketplace-hero-status">
        <div><IconFlask aria-hidden="true" size={18} /><span><strong>PAPER-first</strong><small>Every new pilot starts simulated</small></span></div>
        <div><IconBuildingBank aria-hidden="true" size={18} /><span><strong>{connectedExternalProviders} external connected</strong><small>Provider data paths only; local PAPER is separate</small></span></div>
        <div><IconShieldCheck aria-hidden="true" size={18} /><span><strong>User controlled</strong><small>Pause, switch, or rebalance</small></span></div>
      </div>
    </header>

    <div className="marketplace-safety-strip"><IconLock aria-hidden="true" size={15} /><span><strong>{paperOnly ? "Live execution is locked." : "Live actions require separate authorization."}</strong> Marketplace enrollment never bypasses CopyLab risk gates, and no result is a profit guarantee.</span></div>

    <nav className="marketplace-tabs" role="tablist" aria-label="Marketplace views">
      <button role="tab" aria-selected={view === "DISCOVER"} onClick={() => setView("DISCOVER")}><IconSparkles aria-hidden="true" size={15} />Discover<span>{pilots.length}</span></button>
      <button role="tab" aria-selected={view === "MY_PILOTS"} onClick={() => setView("MY_PILOTS")}><IconFlask aria-hidden="true" size={15} />My Pilots<span>{localEnrollments.length}</span></button>
      <button role="tab" aria-selected={view === "BROKERS"} onClick={() => setView("BROKERS")}><IconBuildingBank aria-hidden="true" size={15} />Provider &amp; routing<span>{connectedExternalProviders}</span></button>
    </nav>

    {notice && <div className="marketplace-notice" role="status"><IconCheck aria-hidden="true" size={15} /><span>{notice}</span><button aria-label="Dismiss confirmation" onClick={() => setNotice(undefined)}><IconX aria-hidden="true" size={14} /></button></div>}

    {loading ? <div className="marketplace-state" aria-live="polite"><span className="marketplace-loader"><IconSparkles aria-hidden="true" size={22} /></span><h3>Loading the marketplace</h3><p>CopyLab is reconciling pilots, evidence, enrollments, and broker capabilities.</p></div>
      : error ? <div className="marketplace-state marketplace-state-error"><span><IconAlertTriangle aria-hidden="true" size={22} /></span><h3>Marketplace data is unavailable</h3><p>{error}</p>{onRetry && <MarketplaceButton icon={IconRefresh} onClick={onRetry}>Try again</MarketplaceButton>}</div>
        : view === "DISCOVER" ? <div className="marketplace-view" role="tabpanel">
          <div className="marketplace-controls">
            <label className="marketplace-search"><span className="marketplace-sr-only">Search pilots</span><IconSearch aria-hidden="true" size={17} /><input type="search" placeholder="Search pilots, themes, assets, or curators" value={query} onChange={(event) => setQuery(event.target.value)} />{query && <button aria-label="Clear search" onClick={() => setQuery("")}><IconX aria-hidden="true" size={14} /></button>}</label>
            <label><span>Asset</span><select value={assetClass} onChange={(event) => setAssetClass(event.target.value as typeof assetClass)}><option value="ALL">All assets</option><option value="CRYPTO">Crypto</option><option value="US_STOCKS">US stocks</option><option value="MULTI_ASSET">Multi-asset</option></select></label>
            <label><span>Risk</span><select value={risk} onChange={(event) => setRisk(event.target.value as typeof risk)}><option value="ALL">All risk levels</option><option value="CONSERVATIVE">Conservative</option><option value="MODERATE">Moderate</option><option value="HIGH">High risk</option><option value="EXTREME">Extreme risk</option></select></label>
          </div>
          <div className="marketplace-category-chips" aria-label="Pilot categories">{CATEGORY_FILTERS.map((item) => <button key={item} aria-pressed={category === item} onClick={() => setCategory(item)}>{item === "ALL" ? "All pilots" : MARKETPLACE_CATEGORY_LABELS[item]}</button>)}</div>
            <div className="marketplace-results-heading"><div><h3>Pilot catalog</h3><p>{filteredPilots.length.toLocaleString()} of {pilots.length.toLocaleString()} entries match this view; research-only concepts are not enrollable</p></div><span><IconDatabase aria-hidden="true" size={14} />Evidence and pricing shown as recorded</span></div>
          {filteredPilots.length === 0 ? <div className="marketplace-empty"><IconSearch aria-hidden="true" size={23} /><h3>No pilots match those filters</h3><p>Try another asset, risk level, category, or search phrase.</p><MarketplaceButton onClick={() => { setQuery(""); setCategory("ALL"); setAssetClass("ALL"); setRisk("ALL"); }}>Clear filters</MarketplaceButton></div>
            : <div className="marketplace-pilot-grid">{filteredPilots.map((pilot) => <PilotCard key={pilot.id} pilot={pilot} paperOnly={paperOnly} enrolled={localEnrollments.some((enrollment) => enrollment.pilotId === pilot.id)} onOpen={() => { setMutationError(undefined); setSelectedPilotId(pilot.id); }} />)}</div>}
        </div>
          : view === "MY_PILOTS" ? <div className="marketplace-view" role="tabpanel">
            <div className="marketplace-section-heading"><div><span>Isolated PAPER accounts</span><h3>My Pilots</h3><p>Each allocation has its own ledger. Values are never pooled into a misleading combined strategy result.</p></div><MarketplaceButton tone="primary" icon={IconSparkles} onClick={() => setView("DISCOVER")}>Add a pilot</MarketplaceButton></div>
            {localEnrollments.length === 0 ? <div className="marketplace-empty"><IconFlask aria-hidden="true" size={23} /><h3>No pilots enrolled yet</h3><p>Choose an enrollable pilot with an implemented PAPER engine and assign an isolated allocation.</p><MarketplaceButton tone="primary" onClick={() => setView("DISCOVER")}>Explore pilots</MarketplaceButton></div>
              : <div className="marketplace-enrollment-grid">{localEnrollments.map((enrollment) => <EnrollmentCard
                key={enrollment.id}
                enrollment={enrollment}
                pilot={pilots.find((pilot) => pilot.id === enrollment.pilotId)}
                busy={busyKey === `toggle:${enrollment.id}`}
                actionsReady={Boolean(actions)}
                onTogglePause={() => {
                  if (!actions) return;
                  const operation = enrollment.status === "ACTIVE" ? actions.pause : actions.resume;
                  void perform(`toggle:${enrollment.id}`, () => operation(enrollment.id), `${pilots.find((pilot) => pilot.id === enrollment.pilotId)?.name ?? "Pilot"} ${enrollment.status === "ACTIVE" ? "paused" : "resumed"} in PAPER.`);
                }}
                onViewLedger={() => openEnrollmentLedger(enrollment.id)}
                onRebalance={() => openWorkflow("REBALANCE", enrollment.id)}
                onSwitch={() => openWorkflow("SWITCH", enrollment.id)}
                onUnenroll={() => {
                  setMutationError(undefined);
                  setUnenrollEnrollmentId(enrollment.id);
                }}
              />)}</div>}
          </div>
            : <div className="marketplace-view" role="tabpanel">
              <div className="marketplace-section-heading"><div><span>Provider and order-routing status</span><h3>Provider access &amp; routing boundaries</h3><p>The CopyLab simulator is local and is not counted as a connected external provider. Provider PAPER/data status describes authorized data access only; CopyLab does not route marketplace orders externally.</p></div><MarketplaceBadge tone="paper"><IconShieldCheck aria-hidden="true" size={13} />Data access · local fills</MarketplaceBadge></div>
              {brokers.length === 0 ? <div className="marketplace-empty"><IconBuildingBank aria-hidden="true" size={23} /><h3>No broker connectors reported</h3><p>Add a supported provider in setup before assigning broker-backed PAPER buying power.</p></div>
                : <div className="marketplace-broker-grid">{brokers.map((broker) => <BrokerCard key={broker.id} broker={broker} busy={busyKey === `broker:${broker.id}`} canConnect={Boolean(actions?.connectBroker) && broker.id === "ALPACA_PAPER"} onConnect={() => {
                  if (!actions?.connectBroker) return;
                  setBusyKey(`broker:${broker.id}`);
                  setMutationError(undefined);
                  void actions.connectBroker(broker.id).then(() => setNotice(`${broker.name} PAPER setup opened.`)).catch((cause: unknown) => setMutationError(cause instanceof Error ? cause.message : "Broker setup failed safely.")).finally(() => setBusyKey(undefined));
                }} />)}</div>}
              <div className="marketplace-broker-boundary"><IconLock aria-hidden="true" size={17} /><div><strong>Connection boundary</strong><p>A connected provider does not authorize real trading. Live mode requires a separately unlocked CopyLab mode, an eligible pilot, supported broker capability, explicit user confirmation, and every normal order-level risk check.</p></div></div>
            </div>}

    <footer className="marketplace-disclosure">
      <IconAlertTriangle aria-hidden="true" size={16} />
      <p><strong>Research and simulation disclosure.</strong> CopyLab is research software. It is not an investment adviser, broker-dealer, custodian, or SEC-registered adviser. Securities and crypto can lose value. Past results do not guarantee future profit, public filings and political disclosures can be delayed, and simulated fills can differ materially from live execution. Use only capital you can afford to lose.</p>
    </footer>

    <PilotDetailDrawer
      pilot={selectedPilot}
      alreadyEnrolled={selectedPilot ? localEnrollments.some((enrollment) => enrollment.pilotId === selectedPilot.id) : false}
      paperOnly={paperOnly}
      actionsReady={Boolean(actions)}
      buyingPowerUsd={paperBroker?.buyingPowerUsd}
      busy={busyKey === `enroll:${selectedPilot?.id}`}
      mutationError={mutationError}
      onClose={closePilot}
      onEnroll={async (allocation) => {
        if (!actions || !selectedPilot) return;
        const succeeded = await perform(`enroll:${selectedPilot.id}`, () => actions.enroll(selectedPilot.id, { allocation, mode: "PAPER" }), `${selectedPilot.name} added to My Pilots in PAPER.`);
        if (succeeded) { closePilot(); setView("MY_PILOTS"); }
      }}
    />
    <EnrollmentLedgerDialog
      enrollment={ledgerEnrollment}
      pilot={ledgerPilot}
      ledger={ledger}
      loading={ledgerLoading}
      error={ledgerError}
      onClose={closeEnrollmentLedger}
      onRetry={() => {
        if (ledgerEnrollmentId) void loadEnrollmentLedger(ledgerEnrollmentId);
      }}
    />
    <ConfirmUnenrollDialog
      enrollment={unenrollEnrollment}
      pilot={unenrollPilot}
      busy={busyKey === `unenroll:${unenrollEnrollment?.id}`}
      actionsReady={Boolean(actions)}
      error={mutationError}
      onClose={() => {
        setUnenrollEnrollmentId(undefined);
        setMutationError(undefined);
      }}
      onConfirm={confirmUnenroll}
    />
    <WorkflowDialog
      workflow={workflow}
      enrollment={workflowEnrollment}
      currentPilot={workflowPilot}
      pilots={pilots}
      busy={Boolean(busyKey?.startsWith("workflow:"))}
      mutationError={mutationError}
      preview={preview}
      onClose={closeWorkflow}
      onPreview={async (targetAllocationUsd) => {
        if (!actions || !workflowEnrollment) return;
        setBusyKey(`workflow:${workflowEnrollment.id}:preview`);
        setMutationError(undefined);
        try {
          setPreview(await actions.previewRebalance(workflowEnrollment.id, { targetAllocationUsd }));
        } catch (cause) {
          setMutationError(cause instanceof Error ? cause.message : "The rebalance preview failed safely.");
        } finally {
          setBusyKey(undefined);
        }
      }}
      onConfirmPreview={async () => {
        if (!actions || !workflowEnrollment || !preview) return;
        const succeeded = await perform(`workflow:${workflowEnrollment.id}:confirm`, () => actions.confirmRebalance(workflowEnrollment.id, preview.id), "PAPER allocation rebalanced after preview confirmation.");
        if (succeeded) closeWorkflow();
      }}
      onSwitch={async (targetPilotId) => {
        if (!actions || !workflowEnrollment) return;
        const targetPilot = pilots.find((pilot) => pilot.id === targetPilotId);
        const succeeded = await perform(`workflow:${workflowEnrollment.id}:switch`, () => actions.switchPilot(workflowEnrollment.id, targetPilotId), `PAPER allocation switched to ${targetPilot?.name ?? "the selected pilot"}.`);
        if (succeeded) closeWorkflow();
      }}
    />
  </section>;
}
