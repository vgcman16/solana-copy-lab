import type {
  DashboardSnapshot,
  LiveOperationPressure,
  LiveOperationSource,
  LiveOperationsSnapshot,
  ModeState,
  PaperComparisonKind,
  StockPaperDashboard
} from "@copylab/shared";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { count, money, percent, relativeTime, titleCase } from "../format";
import { normalizedStockEquitySeries } from "../stock-equity-chart";
import { Icon, type IconName } from "./Icon";
import { Brand, StatusDot } from "./Primitives";
import {
  StockEquityChart,
  StockPaperPanel
} from "./StockPaperPanel";

export type MarketFloorWorkspace =
  | "STRICT"
  | "HIGH_RISK"
  | "AUTONOMOUS"
  | "STOCK"
  | "MARKETPLACE"
  | "WALLETS"
  | "PROVIDERS"
  | "RISK"
  | "AUDIT";

interface HolographicMarketFloorProps {
  snapshot: DashboardSnapshot;
  selected: MarketFloorWorkspace;
  onSelect: (workspace: MarketFloorWorkspace) => void;
  streamConnected: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  topbarActions: ReactNode;
  riskBanner?: ReactNode;
  workspace: ReactNode;
  footer: ReactNode;
}

interface StrategyCard {
  id: Extract<MarketFloorWorkspace, "STRICT" | "HIGH_RISK" | "AUTONOMOUS" | "STOCK">;
  label: string;
  eyebrow: string;
  navUsd?: number | undefined;
  pnlUsd?: number | undefined;
  drawdownPercent?: number | undefined;
  status: string;
  updatedAt?: string | undefined;
  icon: IconName;
  trace?: number[] | undefined;
}

const STRATEGY_ORDER: PaperComparisonKind[] = [
  "STRICT_COPY",
  "HIGH_RISK_COPY",
  "AUTONOMOUS_HIGH_RISK"
];

const COMPARISON_WORKSPACE: Record<PaperComparisonKind, StrategyCard["id"]> = {
  STRICT_COPY: "STRICT",
  HIGH_RISK_COPY: "HIGH_RISK",
  AUTONOMOUS_HIGH_RISK: "AUTONOMOUS"
};

const COMPARISON_ICON: Record<PaperComparisonKind, IconName> = {
  STRICT_COPY: "shield",
  HIGH_RISK_COPY: "copy",
  AUTONOMOUS_HIGH_RISK: "spark"
};

const UTILITY_WORKSPACES: Array<{
  id: Extract<MarketFloorWorkspace, "MARKETPLACE" | "WALLETS" | "PROVIDERS" | "RISK" | "AUDIT">;
  label: string;
  detail: string;
  icon: IconName;
}> = [
  { id: "MARKETPLACE", label: "Pilot marketplace", detail: "Discover and allocate PAPER pilots", icon: "spark" },
  { id: "WALLETS", label: "Wallet lab", detail: "Discovery and qualification", icon: "wallet" },
  { id: "PROVIDERS", label: "Data providers", detail: "Keys, quota and connectivity", icon: "database" },
  { id: "RISK", label: "Safety & modes", detail: "Gates, reserves and approvals", icon: "shield" },
  { id: "AUDIT", label: "Audit & comparison", detail: "Outcomes and evidence", icon: "activity" }
];

function signedMoney(value: number): string {
  return `${value >= 0 ? "+" : ""}${money(value)}`;
}

function clockTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const parts = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short"
  }).formatToParts(date);
  return parts.map((part) => part.value).join("");
}

function activityTitle(event: LiveOperationsSnapshot["activity"][number]): string {
  if (event.kind === "SIGNAL") {
    return event.tone === "SUCCESS" ? "Signal accepted" : "Signal rejected";
  }
  if (event.kind === "SIMULATION") return "Simulated fill";
  if (event.kind === "LEARNING") return "Learning engine updated";
  if (event.kind === "SCAN") return "Market data scan";
  if (event.kind === "API") return "Provider data update";
  if (event.kind === "SAFETY") {
    return event.tone === "CRITICAL" ? "Safety hold active" : "Safety evidence updated";
  }
  return titleCase(event.kind);
}

function activityIcon(event: LiveOperationsSnapshot["activity"][number]): IconName {
  if (event.kind === "SIGNAL") {
    return event.tone === "SUCCESS" ? "rocket" : "circle-x";
  }
  if (event.kind === "SIMULATION") return "message";
  if (event.kind === "SCAN" || event.kind === "API") return "database";
  if (event.kind === "SAFETY") return "shield";
  if (event.kind === "LEARNING") return "spark";
  return "activity";
}

function sparklinePoints(
  values: readonly number[],
  width = 160,
  height = 32
): string {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length < 2) return "";
  const minimum = Math.min(...finite);
  const maximum = Math.max(...finite);
  const range = maximum - minimum;
  const verticalPadding = 2;
  return finite.map((value, index) => {
    const x = index / Math.max(1, finite.length - 1) * width;
    const y = range <= 0
      ? height / 2
      : height - verticalPadding - (value - minimum) / range * (height - verticalPadding * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
}

function candidateSparkline(
  candidate: StockPaperDashboard["candidates"][number]
): string {
  const prices = candidate.sparklinePricesUsd?.filter((price) =>
    Number.isFinite(price) && price > 0
  ) ?? [];
  if (prices.length >= 2) {
    const withLatest = Math.abs((prices.at(-1) ?? candidate.priceUsd) - candidate.priceUsd) > 0.000_001
      ? [...prices, candidate.priceUsd]
      : prices;
    return sparklinePoints(withLatest);
  }
  return sparklinePoints([
    candidate.changeFromOpenPercent,
    candidate.change15mPercent,
    candidate.change5mPercent,
    candidate.change1mPercent
  ]);
}

function strategyCards(snapshot: DashboardSnapshot): StrategyCard[] {
  const comparisons = new Map(
    (snapshot.paperComparisons ?? []).map((comparison) => [comparison.kind, comparison])
  );
  const cards = STRATEGY_ORDER.map((kind): StrategyCard => {
    const comparison = comparisons.get(kind);
    const useRobustHighRisk = kind === "HIGH_RISK_COPY" &&
      comparison?.robustNormalizedNavUsd !== undefined &&
      comparison.robustNormalizedPnlUsd !== undefined;
    return {
      id: COMPARISON_WORKSPACE[kind],
      label: kind === "STRICT_COPY"
        ? "Strict Copy"
        : kind === "HIGH_RISK_COPY"
          ? "High-Risk Copy"
          : "Autonomous Crypto",
      eyebrow: kind === "STRICT_COPY"
        ? "Safety-first copy"
        : kind === "HIGH_RISK_COPY"
          ? "Aggressive copy"
          : "Autonomous crypto",
      navUsd: useRobustHighRisk ? comparison.robustNormalizedNavUsd : comparison?.normalizedNavUsd,
      pnlUsd: useRobustHighRisk ? comparison.robustNormalizedPnlUsd : comparison?.normalizedPnlUsd,
      drawdownPercent: comparison?.maxDrawdownPercent,
      status: comparison?.status ?? "NOT_STARTED",
      updatedAt: comparison?.updatedAt,
      icon: COMPARISON_ICON[kind]
    };
  });
  const stock = snapshot.stockPaper;
  const stockPnl = stock?.account
    ? stock.account.realizedPnlUsd + stock.account.unrealizedPnlUsd
    : undefined;
  const stockTrace = stock
    ? normalizedStockEquitySeries(stock.equityCurve).strategy.map((value) => value - 100)
    : undefined;
  cards.splice(2, 0, {
    id: "STOCK",
    label: "Stock Momentum",
    eyebrow: "Alpaca IEX PAPER",
    navUsd: stock?.account?.navUsd,
    pnlUsd: stockPnl,
    drawdownPercent: stock?.account?.maxDrawdownPercent,
    status: stock?.lane?.status ?? "NOT_STARTED",
    updatedAt: stock?.updatedAt,
    icon: "trend",
    trace: stockTrace
  });
  return cards;
}

function ModeBadge({ mode }: { mode: ModeState }) {
  const live = mode === "MANUAL_LIVE" || mode === "AUTO_LIVE";
  return (
    <span className={`mode-badge mode-${mode.toLowerCase()}`}>
      <span className="mode-pulse" />
      {live ? "LIVE · " : ""}{titleCase(mode)}
    </span>
  );
}

function StrategySwitcher({
  cards,
  selected,
  onSelect
}: {
  cards: StrategyCard[];
  selected: MarketFloorWorkspace;
  onSelect: (workspace: MarketFloorWorkspace) => void;
}) {
  const selectedCard = useRef<HTMLButtonElement | null>(null);
  const activeIndex = cards.findIndex((card) => card.id === selected);
  useEffect(() => {
    if (!window.matchMedia("(max-width: 760px)").matches) return;
    selectedCard.current?.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
      inline: "center"
    });
  }, [selected]);
  const shift = (direction: -1 | 1) => {
    const next = Math.max(0, Math.min(cards.length - 1, activeIndex + direction));
    onSelect(cards[next]!.id);
  };
  return (
    <section className="market-floor-strategy-stage" aria-labelledby="strategy-switcher-title">
      <img className="strategy-platform-asset strategy-platform-static" src="/assets/market-floor-platform.png" alt="" />
      <img className="strategy-platform-asset strategy-platform-motion" src="/assets/market-floor-platform-loop.webp" alt="" aria-hidden="true" />
      <div className="strategy-stage-heading">
        <span />
        <p id="strategy-switcher-title">Strategy switcher</p>
        <span />
      </div>
      <button className="strategy-carousel-arrow previous" type="button" onClick={() => shift(-1)} disabled={activeIndex <= 0} aria-label="Previous strategy"><Icon name="chevron" size={19} /></button>
      <div className="strategy-card-track">
        {cards.map((card, index) => {
          const active = card.id === selected;
          const pnl = card.pnlUsd ?? 0;
          const position = index - cards.findIndex((entry) => entry.id === selected);
          return (
            <button
              type="button"
              key={card.id}
              ref={active ? selectedCard : undefined}
              className={`strategy-floor-card ${active ? "active" : ""} position-${Math.max(-2, Math.min(2, position))}`}
              aria-pressed={active}
              onClick={() => onSelect(card.id)}
            >
              <header>
                <span className="strategy-card-icon"><Icon name={card.icon} size={16} /></span>
                {active && <span className={`strategy-card-status status-${card.status.toLowerCase()}`}>
                  <span className="tiny-dot" />Active
                </span>}
              </header>
              <div>
                <small>{card.eyebrow}</small>
                <h2>{card.label}</h2>
              </div>
              {active && card.trace && card.trace.length > 1 && <svg className="strategy-live-trace" viewBox="0 0 180 30" role="img" aria-label="Recent strategy return">
                <polyline points={card.trace.slice(-30).map((value, pointIndex, values) => {
                  const minimum = Math.min(...values, 0);
                  const maximum = Math.max(...values, 0);
                  const range = maximum - minimum || 1;
                  return `${pointIndex / Math.max(1, values.length - 1) * 180},${28 - (value - minimum) / range * 26}`;
                }).join(" ")} />
              </svg>}
              <dl>
                <div><dt>NAV</dt><dd>{card.navUsd === undefined ? "—" : money(card.navUsd)}</dd></div>
                <div><dt>P&amp;L</dt><dd className={pnl >= 0 ? "positive" : "negative"}>{card.pnlUsd === undefined ? "—" : signedMoney(pnl)}</dd></div>
                <div><dt>DD</dt><dd>{card.drawdownPercent === undefined ? "—" : percent(card.drawdownPercent)}</dd></div>
              </dl>
              <footer>{card.updatedAt ? `Updated ${relativeTime(card.updatedAt)}` : "Waiting for first evidence"}</footer>
            </button>
          );
        })}
      </div>
      <button className="strategy-carousel-arrow next" type="button" onClick={() => shift(1)} disabled={activeIndex >= cards.length - 1} aria-label="Next strategy"><Icon name="chevron" size={19} /></button>
    </section>
  );
}

function UtilitySwitcher({
  selected,
  onSelect
}: {
  selected: MarketFloorWorkspace;
  onSelect: (workspace: MarketFloorWorkspace) => void;
}) {
  return (
    <nav className="market-floor-utility-nav" aria-label="Command center workspaces">
      {UTILITY_WORKSPACES.map((item) => (
        <button
          type="button"
          key={item.id}
          className={selected === item.id ? "active" : ""}
          aria-pressed={selected === item.id}
          onClick={() => onSelect(item.id)}
        >
          <Icon name={item.icon} size={15} />
          <span><strong>{item.label}</strong><small>{item.detail}</small></span>
        </button>
      ))}
    </nav>
  );
}

function CommandDrawer({
  selected,
  onSelect,
  refreshing,
  onRefresh
}: {
  selected: MarketFloorWorkspace;
  onSelect: (workspace: MarketFloorWorkspace) => void;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const drawer = useRef<HTMLDetailsElement | null>(null);
  return (
    <details className="command-drawer" ref={drawer}>
      <summary className="icon-button" aria-label="Open command workspaces" title="Command workspaces"><Icon name="menu" size={16} /></summary>
      <div className="command-drawer-popover">
        <header>
          <div><strong>Command workspaces</strong><small>All existing controls stay available here.</small></div>
          <button className="icon-button" type="button" aria-label="Refresh dashboard" title="Refresh dashboard" disabled={refreshing} onClick={() => {
            onRefresh();
            drawer.current?.removeAttribute("open");
          }}><Icon name="refresh" size={15} className={refreshing ? "spin" : ""} /></button>
        </header>
        <UtilitySwitcher selected={selected} onSelect={(next) => {
          onSelect(next);
          drawer.current?.removeAttribute("open");
        }} />
      </div>
    </details>
  );
}

function pressureTone(pressure: LiveOperationPressure): string {
  return pressure === "HIGH" ? "negative" : pressure === "MEDIUM" ? "warning" : "positive";
}

function sourceIcon(source: LiveOperationSource): IconName {
  if (source.id === "local_index") return "activity";
  if (source.id === "alpaca_iex") return "trend";
  if (source.id === "jupiter") return "arrow";
  if (source.id === "solana_rpc" || source.id === "helius") return "database";
  if (source.id === "pyth_benchmarks") return "spark";
  return "eye";
}

const PROVIDER_LOGOS: Partial<Record<LiveOperationSource["id"], string>> = {
  alpaca_iex: "/assets/providers/alpaca.png",
  birdeye: "/assets/providers/birdeye.png",
  helius: "/assets/providers/helius.svg",
  jupiter: "/assets/providers/jupiter.png"
};

function ProviderMark({ source }: { source: LiveOperationSource }) {
  const logo = PROVIDER_LOGOS[source.id];
  return logo
    ? <img className={`provider-logo provider-logo-${source.id}`} src={logo} alt={`${source.label} logo`} />
    : <Icon name={sourceIcon(source)} size={15} />;
}

function usageLabel(source: LiveOperationSource): string {
  const usage = source.usage;
  if (usage.limit !== undefined) {
    return `${count(usage.requests)} / ${count(usage.limit)} ${usage.unit ?? "requests"}`;
  }
  if (usage.credits !== undefined) {
    return `${count(usage.credits)} ${usage.unit ?? "credits"}`;
  }
  return `${count(usage.requests)} requests`;
}

function sourceDetail(source: LiveOperationSource): string {
  if (source.id === "birdeye") return "Market data";
  if (source.id === "helius" || source.id === "solana_rpc") return "On-chain data";
  if (source.id === "jupiter") return "DEX / routing";
  if (source.id === "alpaca_iex") return "Execution data";
  return source.scope === "CRYPTO" ? "Market / chain data" : titleCase(source.scope);
}

function activityBadge(event: LiveOperationsSnapshot["activity"][number]): string {
  if (event.kind === "SIGNAL") {
    if (event.tone === "SUCCESS") return "Accepted";
    if (event.tone === "WARNING" || event.tone === "CRITICAL") return "Rejected";
    return "Signal";
  }
  if (event.kind === "SIMULATION") return "Simulated";
  if (event.kind === "SCAN" || event.kind === "API") return "Update";
  if (event.kind === "SAFETY") return event.tone === "CRITICAL" ? "Blocked" : "Safety";
  if (event.kind === "LEARNING") return "Learning";
  return titleCase(event.kind);
}

function armIcon(arm: StockPaperDashboard["armStats"][number]["arm"]): IconName {
  if (arm === "BREAKOUT") return "chart";
  if (arm === "OPENING_RANGE") return "candle";
  if (arm === "PULLBACK_RECOVERY") return "pullback";
  return "histogram";
}

export function LiveOperationsObservatory({
  live,
  riskBanner,
  onSelect
}: {
  live: LiveOperationsSnapshot;
  riskBanner?: ReactNode;
  onSelect: (workspace: MarketFloorWorkspace) => void;
}) {
  const seenEventIdsRef = useRef<Set<string>>(new Set());
  const pulseTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [dataPulse, setDataPulse] = useState<{
    active: boolean;
    eventId: string;
    source: string;
  }>({
    active: false,
    eventId: "",
    source: ""
  });
  useEffect(() => {
    const unseenEvents = live.activity.filter((event) => !seenEventIdsRef.current.has(event.id));
    for (const event of live.activity) seenEventIdsRef.current.add(event.id);
    const providerEvent = unseenEvents.find((event) =>
      ["birdeye", "helius", "solana_rpc", "jupiter", "alpaca_iex"].includes(event.source)
    );
    const event = providerEvent ?? unseenEvents[0];
    if (!event) return;
    if (pulseTimerRef.current) clearTimeout(pulseTimerRef.current);
    setDataPulse({
      active: true,
      eventId: event.id,
      source: event.source
    });
    pulseTimerRef.current = setTimeout(() => {
      setDataPulse((current) => ({ ...current, active: false }));
    }, 4_100);
    return () => {
      if (pulseTimerRef.current) clearTimeout(pulseTimerRef.current);
    };
  }, [live.activity]);
  const healthySources = live.sources.filter((source) => source.status === "ONLINE").length;
  const highestPressure = live.sources.some((source) => source.usage.pressure === "HIGH")
    ? "HIGH"
    : live.sources.some((source) => source.usage.pressure === "MEDIUM")
      ? "MEDIUM"
      : "LOW";
  const activePulseSource = dataPulse.source === "solana_rpc" ? "helius" : dataPulse.source;
  const hasProviderPacket = ["birdeye", "helius", "jupiter", "alpaca_iex"].includes(activePulseSource);
  const lastActivity = live.activity[0];
  const meteredSources = live.sources.filter((source) =>
    source.usage.limit !== undefined && source.usage.limit > 0
  );
  const monthlyUsagePercent = meteredSources.length === 0
    ? 0
    : Math.max(...meteredSources.map((source) =>
      Math.min(100, source.usage.requests / Math.max(1, source.usage.limit ?? 1) * 100)
    ));
  const sourceById = new Map(live.sources.map((source) => [source.id, source]));
  const local = sourceById.get("local_index");
  const topologySources = [
    sourceById.get("birdeye"),
    sourceById.get("helius") ?? sourceById.get("solana_rpc"),
    sourceById.get("jupiter"),
    sourceById.get("alpaca_iex")
  ].filter((source): source is LiveOperationSource => Boolean(source));
  const topologyIds = new Set([
    ...topologySources.map((source) => source.id),
    ...(local ? [local.id] : [])
  ]);
  const extraSources = live.sources.filter((source) => !topologyIds.has(source.id));
  return (
    <aside className="live-observatory" aria-labelledby="live-observatory-title">
      <header className="observatory-heading">
        <div>
          <p className="eyebrow"><span className="observatory-live-dot" />Live data observatory</p>
          <span className="sr-only" id="live-observatory-title">Live data observatory</span>
        </div>
      </header>

      <div className={`observatory-topology ${dataPulse.active ? "receiving-data" : ""}`} data-active-source={activePulseSource}>
        <img
          className="topology-reference"
          src="/assets/option-2-holographic-market-floor-reference.png"
          alt=""
          aria-hidden="true"
        />
        <img className="topology-static" src="/assets/observatory-topology.png" alt="" />
        {dataPulse.active && hasProviderPacket && <img
          className="topology-motion"
          src={`/assets/observatory-topology-loop.png?event=${encodeURIComponent(dataPulse.eventId)}`}
          alt=""
          aria-hidden="true"
        />}
        {topologySources.map((source, index) => (
          <article className={`topology-source topology-source-${index + 1} source-${source.status.toLowerCase()} ${dataPulse.active && activePulseSource === source.id ? "transmitting" : ""}`} key={source.id}>
            <span><ProviderMark source={source} /></span>
            <div><strong>{source.label}</strong><small>{sourceDetail(source)}</small></div>
            <footer><StatusDot ok={source.status === "ONLINE" ? true : source.status === "DEGRADED" || source.status === "IDLE" ? "warning" : false} /><em>{source.latencyMs === undefined ? usageLabel(source) : `${count(source.latencyMs)} ms`}</em></footer>
          </article>
        ))}
        {local && <article className={`topology-hub source-${local.status.toLowerCase()} ${dataPulse.active ? "processing" : ""}`}>
          <strong>Local Index</strong>
          <small>Strategy engine</small>
          <footer><StatusDot ok={local.status === "ONLINE" ? true : local.status === "DEGRADED" ? "warning" : false} /><span>{local.metrics.indexedWallets ? `${count(Number(local.metrics.indexedWallets))} wallets` : titleCase(local.status)}</span></footer>
        </article>}
      </div>

      {extraSources.length > 0 && <div className="observatory-extra-sources">{extraSources.map((source) => <span key={source.id}><StatusDot ok={source.status === "ONLINE" ? true : "warning"} />{source.label} · {titleCase(source.status)}</span>)}</div>}

      <div className="observatory-health-grid">
        <article>
          <span><Icon name="heartbeat" size={14} />Health</span>
          <strong className={healthySources === live.sources.length ? "positive" : "warning"}>
            {healthySources === live.sources.length ? "Healthy" : `${healthySources} / ${live.sources.length}`}
          </strong>
          <small>{healthySources} of {live.sources.length} sources online</small>
        </article>
        <article>
          <span><Icon name="database" size={14} />Monthly usage</span>
          <strong>{percent(monthlyUsagePercent)}</strong>
          <small>highest metered provider</small>
          <i><b style={{ width: `${monthlyUsagePercent}%` }} /></i>
        </article>
        <article>
          <span><Icon name="gauge" size={14} />Rate pressure</span>
          <strong className={pressureTone(highestPressure)}>{titleCase(highestPressure)}</strong>
          <small>highest provider load</small>
        </article>
      </div>

      <div className="observatory-totals">
        <article><span>Last event</span><strong>{lastActivity ? clockTime(lastActivity.at).replace(/\s[A-Z]{2,5}$/, "") : "None"}</strong><small>{lastActivity?.source ? titleCase(lastActivity.source) : "waiting"}</small></article>
        <article><span>Accepted</span><strong className="positive">{count(live.totals.recentAcceptedSignals)}</strong><small>recent signals</small></article>
        <article><span>Rejected</span><strong className="negative">{count(live.totals.recentRejectedSignals)}</strong><small>recent signals</small></article>
        <article><span>Simulated</span><strong>{count(live.totals.recentSimulatedActions)}</strong><small>PAPER actions</small></article>
      </div>

      <section className="observatory-activity">
        <header>
          <div><span className="observatory-live-dot" /><strong>Activity stream</strong></div>
          <span className="activity-live-pill"><span />Live</span>
        </header>
        {live.activity.length === 0 ? (
          <div className="observatory-empty">
            <Icon name="activity" size={18} />
            <span>Waiting for the next provider, scan, signal, or safety event.</span>
          </div>
        ) : (
          <ol>
            {live.activity.slice(0, 5).map((event) => (
              <li className={`tone-${event.tone.toLowerCase()}`} key={event.id}>
                <time>{clockTime(event.at).replace(/\s[A-Z]{2,5}$/, "")}</time>
                <span className="activity-node"><Icon name={activityIcon(event)} size={12} /></span>
                <div>
                  <strong>{activityTitle(event)}</strong>
                  <small>{event.detail ?? event.summary}</small>
                </div>
                <em>{activityBadge(event)}</em>
              </li>
            ))}
          </ol>
        )}
        <footer><button type="button" onClick={() => onSelect("AUDIT")}>View full activity log <Icon name="arrow" size={13} /></button></footer>
      </section>

      {riskBanner && <div className="observatory-risk-slot">{riskBanner}</div>}
      <footer className="observatory-privacy">
        <Icon name="lock" size={13} />
        <span>No credentials, endpoints, request bodies, or raw provider payloads are exposed here.</span>
      </footer>
    </aside>
  );
}

function StockMetric({
  icon,
  label,
  value,
  detail,
  tone
}: {
  icon: IconName;
  label: string;
  value: string;
  detail: string;
  tone?: "positive" | "negative" | "warning" | undefined;
}) {
  return (
    <article>
      <span className="stock-command-icon"><Icon name={icon} size={15} /></span>
      <div><small>{label}</small><strong className={tone}>{value}</strong><em>{detail}</em></div>
    </article>
  );
}

export function StockMomentumWorkspace({
  stock
}: {
  stock?: StockPaperDashboard | undefined;
}) {
  const [range, setRange] = useState<"TODAY" | "1D" | "5D" | "1M" | "YTD" | "ALL">("1D");
  if (!stock?.account || !stock.lane) {
    return (
      <section className="stock-command-empty panel">
        <Icon name="trend" size={26} />
        <h2>Stock momentum is preparing its first PAPER cycle</h2>
        <p>Connect Alpaca Paper in Data Providers. The isolated IEX engine will then build its own $141 virtual ledger without any stock-order capability.</p>
      </section>
    );
  }
  const { account, market, lane } = stock;
  const policy = lane.policy;
  const totalPnl = account.realizedPnlUsd + account.unrealizedPnlUsd;
  const topCandidates = [...stock.candidates]
    .sort((left, right) => right.score - left.score || left.symbol.localeCompare(right.symbol))
    .slice(0, 5);
  const now = Date.parse(stock.equityCurve.at(-1)?.capturedAt ?? stock.updatedAt);
  const cutoff = range === "TODAY"
    ? Date.parse(new Date(now).toISOString().slice(0, 10))
    : range === "1D"
      ? now - 24 * 60 * 60_000
      : range === "5D"
        ? now - 5 * 24 * 60 * 60_000
        : range === "1M"
          ? now - 31 * 24 * 60 * 60_000
          : range === "YTD"
            ? Date.parse(`${new Date(now).getUTCFullYear()}-01-01T00:00:00.000Z`)
            : Number.NEGATIVE_INFINITY;
  const rangedCurve = stock.equityCurve.filter((point) => Date.parse(point.capturedAt) >= cutoff);
  const visibleCurve = rangedCurve.length >= 2 ? rangedCurve : stock.equityCurve;
  const normalizedSeries = normalizedStockEquitySeries(visibleCurve);
  const strategyReturns = normalizedSeries.strategy.map((value) => value - 100);
  const benchmarkReturns = normalizedSeries.benchmark.map((value) => value - 100);
  const strategyReturn = strategyReturns.at(-1) ?? 0;
  const benchmarkReturn = benchmarkReturns.at(-1) ?? 0;
  const outperformance = strategyReturn - benchmarkReturn;
  const correlation = (() => {
    if (strategyReturns.length < 3 || benchmarkReturns.length !== strategyReturns.length) return undefined;
    const leftMean = strategyReturns.reduce((sum, value) => sum + value, 0) / strategyReturns.length;
    const rightMean = benchmarkReturns.reduce((sum, value) => sum + value, 0) / benchmarkReturns.length;
    let numerator = 0;
    let leftVariance = 0;
    let rightVariance = 0;
    for (let index = 0; index < strategyReturns.length; index += 1) {
      const left = strategyReturns[index]! - leftMean;
      const right = benchmarkReturns[index]! - rightMean;
      numerator += left * right;
      leftVariance += left * left;
      rightVariance += right * right;
    }
    const denominator = Math.sqrt(leftVariance * rightVariance);
    return denominator > 0 ? numerator / denominator : undefined;
  })();
  return (
    <div className="stock-command-workspace">
      <section className="stock-command-metrics" aria-label="Stock momentum status">
        <StockMetric icon="clock" label="Market phase" value={titleCase(market.phase)} detail={market.isOpen ? "Regular session" : market.nextOpen ? `Opens ${relativeTime(market.nextOpen)}` : "Session closed"} tone={market.isOpen ? "positive" : "warning"} />
        <StockMetric icon="rocket" label="Symbols scanned" value={count(market.scannedSymbols)} detail={`${count(market.detailedSymbols)} deep-ranked`} />
        <StockMetric icon="settings" label="Candidates ranked" value={count(stock.candidates.length)} detail={`${count(stock.candidates.filter((candidate) => candidate.eligible).length)} eligible now`} />
        <StockMetric icon="wallet" label="Normalized NAV" value={money(account.navUsd)} detail={`Started ${money(account.initialNavUsd)}`} />
        <StockMetric icon="chart" label="Total P&L" value={signedMoney(totalPnl)} detail={`${signedMoney(account.realizedPnlUsd)} realized`} tone={totalPnl >= 0 ? "positive" : "negative"} />
        <StockMetric icon="coins" label="Cash / deployed" value={money(account.cashUsd)} detail={`${money(account.deployedUsd)} working`} />
        <StockMetric icon="shield" label="Drawdown" value={percent(account.maxDrawdownPercent)} detail={`${percent(policy.maximumDrawdownPercent)} hard lock`} tone={account.maxDrawdownPercent >= policy.maximumDrawdownPercent * .7 ? "warning" : undefined} />
        <StockMetric icon="shield-lock" label="Paper only" value="NO ORDERS" detail="Alpaca IEX data only" tone="warning" />
      </section>

      {market.lastError && <div className="stock-command-alert"><Icon name="alert" size={15} /><span><strong>Last scan failed safely.</strong> {market.lastError}</span></div>}
      {account.pausedReason && <div className="stock-command-alert"><Icon name="shield" size={15} /><span><strong>New entries paused.</strong> {account.pausedReason}</span></div>}

      <section className="stock-command-chart-deck">
        <article className="stock-command-chart-main">
          <header>
            <div className="stock-command-chart-title"><h2>Equity vs SPY</h2><Icon name="info" size={14} /></div>
            <div className="stock-range-controls">
              {(["TODAY", "1D", "5D", "1M", "YTD", "ALL"] as const).map((option) => <button type="button" className={`${range === option ? "active" : ""} ${option === "TODAY" ? "today-selector" : ""}`} aria-pressed={range === option} onClick={() => setRange(option)} key={option}>
                <span>{option === "TODAY" ? "Today" : option === "ALL" ? "All" : option}</span>
                {option === "TODAY" && <Icon name="chevron" size={11} />}
              </button>)}
            </div>
          </header>
          <div className="stock-command-chart-body">
            <StockEquityChart curve={visibleCurve} />
            <aside>
              <span>Outperformance</span>
              <strong className={outperformance >= 0 ? "positive" : "negative"}>{outperformance >= 0 ? "+" : ""}{percent(outperformance)}</strong>
              <small>vs SPY</small>
              <hr />
              <span>Correlation</span>
              <strong>{correlation === undefined ? "—" : correlation.toFixed(2)}</strong>
              <small>{count(visibleCurve.length)} live marks</small>
            </aside>
          </div>
        </article>
      </section>

      <section className="stock-command-candidates">
        <header><h2>Top candidates</h2><span>(Momentum Score)</span></header>
        {topCandidates.length === 0 ? <p className="stock-command-no-data">Candidates appear after the next successful regular-session scan.</p> : (
          <div>
            {topCandidates.map((candidate, index) => (
              <article key={candidate.symbol}>
                <header><span>{index + 1}</span><div><strong>{candidate.symbol}</strong><small>{candidate.name ?? candidate.exchange ?? titleCase(candidate.arm)}</small></div><em>{candidate.score.toFixed(0)}</em></header>
                <svg className="candidate-sparkline" viewBox="0 0 160 32" role="img" aria-label={`${candidate.symbol} recent one-minute price history`}>
                  <polyline points={candidateSparkline(candidate)} />
                </svg>
                <footer><strong>{money(candidate.priceUsd)}</strong><span className={candidate.change5mPercent >= 0 ? "positive" : "negative"}>{candidate.change5mPercent >= 0 ? "+" : ""}{percent(candidate.change5mPercent)}</span></footer>
                <div className="candidate-tags" aria-label={`${candidate.symbol} signal labels`}>
                  <span>{titleCase(candidate.arm)}</span>
                  <span>{candidate.eligible ? "Eligible" : "Watch only"}</span>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <div className="stock-command-bottom-grid">
        <section className="stock-command-arms">
          <header><h2>Learning arms</h2><span>Bounded next-size adaptation</span></header>
          <div>{stock.armStats.map((arm) => (
            <article key={arm.arm}>
              <header><Icon name={armIcon(arm.arm)} size={14} /><strong>{titleCase(arm.arm)}</strong></header>
              <b className={arm.pnlUsd >= 0 ? "positive" : "negative"}>{signedMoney(arm.pnlUsd)}</b>
              <p>{count(arm.trades)} trades · {percent(arm.winRatePercent)} wins</p>
              <div><span style={{ width: `${Math.max(4, Math.min(100, arm.adaptiveSizingMultiplier / 1.4 * 100))}%` }} /></div>
              <footer><strong>{arm.adaptiveSizingMultiplier.toFixed(2)}×</strong><span>next size</span></footer>
            </article>
          ))}</div>
        </section>

        <section className="stock-command-risk">
          <header><h2>Risk envelope</h2><span>High risk · hard deterministic brakes</span></header>
          <dl>
            <div><dt>Risk budget</dt><dd>{percent(policy.normalRiskAtStopNavFraction * 100, 0)}–{percent(policy.highConvictionRiskAtStopNavFraction * 100, 0)} NAV</dd><span><i style={{ width: "66%" }} /></span></div>
            <div><dt>Max drawdown</dt><dd>{percent(policy.maximumDrawdownPercent)}</dd><span><i style={{ width: `${Math.min(100, account.maxDrawdownPercent / policy.maximumDrawdownPercent * 100)}%` }} /></span></div>
            <div><dt>Max position</dt><dd>{percent(policy.maximumPositionNavFraction * 100, 0)} NAV</dd><span><i style={{ width: `${policy.maximumPositionNavFraction * 100}%` }} /></span></div>
            <div className="risk-wide"><dt>Deployment / capacity</dt><dd>{percent(account.deployedUsd / Math.max(1, account.navUsd) * 100)} · {account.openPositions}/{policy.maximumOpenPositions} open</dd><span><i style={{ width: `${Math.min(100, account.deployedUsd / Math.max(1, account.navUsd * policy.maximumDeployedFraction) * 100)}%` }} /></span></div>
            <div className="risk-wide"><dt>Liquidity buffer</dt><dd>{money(account.cashUsd)}</dd><span><i style={{ width: `${Math.min(100, account.cashUsd / Math.max(1, account.navUsd) * 100)}%` }} /></span></div>
          </dl>
        </section>
      </div>

      <footer className="stock-command-disclosure">
        <Icon name="alert" size={13} />
        <span><strong>PAPER TRADING ONLY.</strong> Performance is simulated and not indicative of future results. No real money or stock order is at risk.</span>
        <em>Updated {relativeTime(stock.updatedAt)}</em>
      </footer>

      <details className="stock-command-ledger">
        <summary><span><Icon name="database" size={15} />Open the full stock ledger, positions, trades and 1,000-policy replays</span><Icon name="chevron" size={15} /></summary>
        <StockPaperPanel stock={stock} />
      </details>
    </div>
  );
}

export function HolographicMarketFloor({
  snapshot,
  selected,
  onSelect,
  streamConnected,
  refreshing,
  onRefresh,
  topbarActions,
  riskBanner,
  workspace,
  footer
}: HolographicMarketFloorProps) {
  const cards = strategyCards(snapshot);
  return (
    <>
      <header className="topbar market-floor-topbar">
        <div className="market-floor-brand-cluster">
          <div className="market-floor-brand-command">
            <Brand />
            <CommandDrawer selected={selected} onSelect={onSelect} refreshing={refreshing} onRefresh={onRefresh} />
          </div>
          <button
            type="button"
            className={`marketplace-launch-button ${selected === "MARKETPLACE" ? "active" : ""}`}
            aria-pressed={selected === "MARKETPLACE"}
            onClick={() => onSelect("MARKETPLACE")}
          ><Icon name="spark" size={15} /><span>Pilot marketplace</span></button>
        </div>
        <div className="topbar-status">
          <ModeBadge mode={snapshot.mode} />
          <span className="connection-label"><StatusDot ok={streamConnected ? true : "warning"} />{streamConnected ? "Live updates" : "Reconnecting"}</span>
          <span className="updated-label">{clockTime(snapshot.updatedAt)}</span>
        </div>
        <div className="topbar-actions">
          {topbarActions}
        </div>
      </header>

      <main className="market-floor-main">
        <div className={`market-floor-layout ${selected === "MARKETPLACE" ? "market-floor-layout-marketplace" : ""}`}>
          <div className="market-floor-primary">
            {selected !== "MARKETPLACE" && <StrategySwitcher cards={cards} selected={selected} onSelect={onSelect} />}
            <section className="market-floor-workspace" aria-live="polite">{workspace}</section>
          </div>
          {selected !== "MARKETPLACE" && <LiveOperationsObservatory live={snapshot.liveOperations} riskBanner={riskBanner} onSelect={onSelect} />}
        </div>
        {footer}
      </main>
    </>
  );
}
