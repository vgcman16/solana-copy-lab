import { useState } from "react";
import type {
  AutonomousPaperDashboard,
  AutonomousPaperPosition,
  AutonomousPaperReplayInsight,
  AutonomousPaperReplayVariantParameters,
  AutonomousPaperSizingBreakdown
} from "@copylab/shared";
import { setAutonomousPaperEnabled, trainAutonomousLearning } from "../api";
import { count, dateTime, money, percent, shortKey, titleCase, tokenLabel } from "../format";
import type { ToastTone } from "../types";
import { Icon } from "./Icon";
import { Button, EmptyState, SectionHeader } from "./Primitives";

interface AutonomousPaperPanelProps {
  autonomous: AutonomousPaperDashboard;
  strictNavUsd: number;
  csrfToken: string;
  onRefresh: () => Promise<void>;
  notify: (tone: ToastTone, title: string, detail?: string) => void;
}

interface AutonomousPaperUpgradeDrain {
  laneId: string;
  fromPolicyVersion: string;
  toPolicyVersion: string;
  requestedAt: string;
  status: "DRAINING";
}

function upgradeDrainState(autonomous: AutonomousPaperDashboard): AutonomousPaperUpgradeDrain | undefined {
  return (autonomous as AutonomousPaperDashboard & {
    upgradeDrain?: AutonomousPaperUpgradeDrain;
  }).upgradeDrain;
}

function tokenName(symbol: string | undefined, mint: string): string {
  return symbol?.trim() || tokenLabel(mint);
}

function signedMoney(value: number): string {
  return `${value >= 0 ? "+" : ""}${money(value)}`;
}

function logReturnPercent(value: number): string {
  return percent((Math.exp(value) - 1) * 100);
}

function positionPnl(position: AutonomousPaperPosition): number {
  return position.lastExecutableValueUsd - position.remainingCostUsd;
}

function rewardPoints(returnPercent: number, stopLossPercent: number, takeProfitPercent: number): number {
  const denominator = returnPercent >= 0 ? takeProfitPercent : stopLossPercent;
  if (!Number.isFinite(returnPercent) || !Number.isFinite(denominator) || denominator <= 0) return 0;
  return Math.max(-100, Math.min(100, returnPercent / denominator * 100));
}

function learningLabel(
  sizing: AutonomousPaperSizingBreakdown,
  minimumGlobal: number,
  minimumContext: number
): string {
  if (!sizing.contextualReward) {
    return sizing.calibration.coldStart
      ? `Global ${count(sizing.calibration.sampleCount)}/${count(minimumGlobal)}`
      : `${sizing.calibration.rewardMultiplier.toFixed(2)}× global reward`;
  }
  if (sizing.contextualReward.active) {
    return `${sizing.contextualReward.multiplier.toFixed(2)}× context · ${count(sizing.contextualReward.comparableTrades)} similar`;
  }
  if (sizing.calibration.coldStart) {
    return `Global ${count(sizing.calibration.sampleCount)}/${count(minimumGlobal)} · context ${count(sizing.contextualReward.comparableTrades)}/${count(minimumContext)}`;
  }
  return `${sizing.calibration.rewardMultiplier.toFixed(2)}× global · context ${count(sizing.contextualReward.comparableTrades)}/${count(minimumContext)}`;
}

function stopLabel(position: AutonomousPaperPosition): string {
  if (position.trailingStopPriceUsd !== undefined) return `Trailing ${money(position.trailingStopPriceUsd)}`;
  if (position.breakEvenPriceUsd !== undefined && position.lastPriceUsd >= position.breakEvenPriceUsd) {
    return `Break-even ${money(position.breakEvenPriceUsd)}`;
  }
  return `Hard ${money(position.stopPriceUsd)}`;
}

function isControlledExploration(reasons: readonly string[]): boolean {
  return reasons.some((reason) =>
    reason === "CONTROLLED_EXPLORATION" || reason.startsWith("CONTROLLED_EXPLORATION_")
  );
}

function replayInsightLabel(classification: AutonomousPaperReplayInsight["classification"]): string {
  switch (classification) {
    case "PROFITABLE_TESTED_ALTERNATIVE": return "PROFITABLE TESTED ALTERNATIVE";
    case "REDUCED_LOSS_ONLY": return "REDUCED LOSS ONLY";
    case "NO_IMPROVEMENT": return "NO TESTED IMPROVEMENT";
    case "UNSCORABLE": return "UNSCORABLE";
  }
}

function replayInsightTone(classification: AutonomousPaperReplayInsight["classification"]): string {
  switch (classification) {
    case "PROFITABLE_TESTED_ALTERNATIVE": return "positive";
    case "REDUCED_LOSS_ONLY": return "warning";
    case "NO_IMPROVEMENT":
    case "UNSCORABLE": return "neutral";
  }
}

function replayPathDiagnosis(insight: AutonomousPaperReplayInsight): string {
  switch (insight.pathDiagnosis) {
    case "TESTED_POLICY_FOUND_PROFIT":
      return "Policy-grid result: at least one of the 1,000 tested policies finished profitable.";
    case "GRID_POLICY_GAP":
      return "Grid/policy gap: no tested policy made profit, but the captured path later offered a profitable executable sell.";
    case "ENTRY_QUALITY_PROBLEM":
      return "Entry-quality problem: neither a tested policy nor any observed executable sell after entry was profitable.";
    case "UNSCORABLE":
      return "Diagnosis unavailable: the persisted path does not contain enough complete comparable evidence.";
  }
}

function replayParameterSummary(parameters: AutonomousPaperReplayVariantParameters): string {
  return [
    `Entry delay ${count(parameters.entryDelaySamples)} samples`,
    `Confirmations ${count(parameters.confirmationSamples)}`,
    `Minimum momentum ${parameters.minimumMomentumScore.toFixed(1)}`,
    `Stop loss ${percent(parameters.stopLossPercent)}`,
    `Break-even activation ${percent(parameters.breakEvenActivationPercent)}`,
    `Trailing activation ${percent(parameters.trailingActivationPercent)}`,
    `Trailing drawdown ${percent(parameters.trailingDrawdownPercent)}`,
    `Take profit ${percent(parameters.takeProfitPercent)}`,
    `Weak-momentum exit ${count(parameters.weakMomentumExitSamples)} samples`,
    `No-progress exit ${count(parameters.noProgressMinutes)} min`,
    `Maximum hold ${count(parameters.maximumHoldingMinutes)} min`
  ].join(" · ");
}

export function AutonomousPaperPanel({
  autonomous,
  strictNavUsd,
  csrfToken,
  onRefresh,
  notify
}: AutonomousPaperPanelProps) {
  const [busy, setBusy] = useState(false);
  const [trainingBusy, setTrainingBusy] = useState(false);
  const status = autonomous.lane?.status ?? "NOT_STARTED";
  const running = status === "ACTIVE";
  const isolated = autonomous.executionEnabled === false && autonomous.promotionEligible === false;
  const account = autonomous.account;
  const policy = autonomous.lane?.policy;
  const upgradeDrain = upgradeDrainState(autonomous);
  const totalPnl = account ? account.realizedPnlUsd + account.unrealizedPnlUsd : 0;
  const winRate = account && account.completedTrades > 0
    ? (account.winningTrades / account.completedTrades) * 100
    : undefined;
  const profitFactor = account && account.grossLossUsd > 0
    ? account.grossProfitUsd / account.grossLossUsd
    : account && account.grossProfitUsd > 0 ? Number.POSITIVE_INFINITY : undefined;
  const learningPolicyVersion = autonomous.learning?.policyCohortVersion ??
    autonomous.lane?.policyVersion ?? "current-policy";
  const learningEpoch = learningPolicyVersion.match(/v\d+$/i)?.[0]?.toUpperCase() ?? "Current";
  const isRegimeAdaptiveLearning = learningPolicyVersion.endsWith("-v13");
  const quarantinedArmCount = autonomous.learning?.armScores.filter(
    (score) => score.quarantined
  ).length ?? 0;

  async function toggle() {
    const enabled = !running;
    setBusy(true);
    try {
      await setAutonomousPaperEnabled(enabled, csrfToken);
      notify(
        "success",
        enabled ? "Autonomous momentum PAPER enabled" : "Autonomous momentum PAPER paused",
        `Its isolated virtual account cannot change the strict account's current ${money(strictNavUsd)} NAV or submit a transaction.`
      );
      await onRefresh();
    } catch (reason) {
      notify(
        "danger",
        enabled ? "Autonomous PAPER could not start" : "Autonomous PAPER could not pause",
        reason instanceof Error ? reason.message : "Unknown error"
      );
    } finally {
      setBusy(false);
    }
  }

  async function trainLearningBrain() {
    setTrainingBusy(true);
    try {
      const result = await trainAutonomousLearning(csrfToken);
      notify(
        "success",
        "Learning analysis completed",
        `${count(result.cohortDatasetEligiblePaths ?? result.datasetEligiblePaths)}/${count(result.minimumPathsForModelInfluence)} policy-matched executable paths are ready for validated model influence.`
      );
      await onRefresh();
    } catch (reason) {
      notify(
        "danger",
        "Learning analysis could not complete",
        reason instanceof Error ? reason.message : "Unknown error"
      );
    } finally {
      setTrainingBusy(false);
    }
  }

  return (
    <section className="panel autonomous-paper-panel" aria-labelledby="autonomous-paper-title">
      <div className="autonomous-paper-strip">
        <Icon name="spark" size={17} />
        <strong>{autonomous.label}</strong>
        <span>Experimental momentum strategy · simulated money only · profit is not guaranteed</span>
      </div>
      <SectionHeader
        eyebrow="Third comparison lane"
        title="Autonomous high-risk momentum bot"
        description={`This strategy finds and manages its own opportunities instead of copying a wallet. It has one isolated virtual bankroll and cannot touch the strict account's current ${money(strictNavUsd)} NAV.`}
        action={<Button
          tone={running ? "secondary" : "danger"}
          icon={running ? "pause" : "play"}
          busy={busy}
          disabled={!isolated}
          onClick={() => void toggle()}
        >{running ? "Pause autonomous PAPER" : "Enable autonomous PAPER"}</Button>}
      />

      {upgradeDrain && <div
        className="autonomous-isolation failed"
        role="status"
        aria-label="Autonomous PAPER policy upgrade draining"
      >
        <div><Icon name="pause" size={17} /><span><strong>New entries paused</strong><small>Policy upgrade {upgradeDrain.fromPolicyVersion} → {upgradeDrain.toPolicyVersion} was requested {dateTime(upgradeDrain.requestedAt)}.</small></span></div>
        <div><Icon name="shield" size={17} /><span><strong>Natural PAPER exits continue</strong><small>Existing simulated positions keep their normal stop, target, and time-based exits. No forced liquidation.</small></span></div>
        <div><Icon name="alert" size={17} /><span><strong>Explicit upgrade retry needed once flat</strong><small>After open positions reach zero, retry the upgrade explicitly; it will not switch policies automatically.</small></span></div>
      </div>}

      <div className={`autonomous-isolation ${isolated ? "verified" : "failed"}`}>
        <div><Icon name="lock" size={17} /><span><strong>No execution path</strong><small>No signer, approval, executable transaction, or submission is available.</small></span></div>
        <div><Icon name="shield" size={17} /><span><strong>Strict account isolated</strong><small>Strict PAPER and its live-promotion evidence stay unchanged.</small></span></div>
        <div><Icon name="database" size={17} /><span><strong>Independent ledger</strong><small>One virtual account, modeled costs, and an auditable decision journal.</small></span></div>
      </div>

      {autonomous.lane && <div className="autonomous-lane-meta">
        <div><span>Status</span><strong className={running ? "positive" : "warning"}>{titleCase(autonomous.lane.status)}</strong><small>{autonomous.lastScanAt ? `Last scan ${dateTime(autonomous.lastScanAt)}` : `Configured ${dateTime(autonomous.lane.updatedAt)}`}</small></div>
        <div><span>Policy</span><strong>{autonomous.lane.policyVersion}</strong><small>Frozen for this experiment</small></div>
        <div><span>Scan cadence</span><strong>{count(policy?.scanIntervalMinutes ?? 0)} min</strong><small>Market evidence refreshed each cycle</small></div>
        <div><span>Daily entry cap</span><strong>{policy?.maximumEntriesPerUtcDay === Number.MAX_SAFE_INTEGER ? "Unlimited" : count(policy?.maximumEntriesPerUtcDay ?? 0)}</strong><small>At most one new position per scan · {count(policy?.minimumEntrySpacingMinutes ?? 0)} min spacing</small></div>
        <div><span>Entry size</span><strong>{policy?.riskAtStopSizingEnabled ? `${percent(policy.normalRiskAtStopNavFraction * 100, 0)}–${percent(policy.highConvictionRiskAtStopNavFraction * 100, 0)} NAV risk` : policy?.adaptiveSizingEnabled ? `${money(policy.minimumPositionUsd)}–${percent(policy.positionNavFraction * 100, 0)} NAV` : `${percent((policy?.positionNavFraction ?? 0) * 100, 0)} NAV`}</strong><small>{policy?.riskAtStopSizingEnabled ? `${percent(policy.explorationRiskAtStopNavFraction * 100, 0)} exploration risk · ${percent(policy.positionNavFraction * 100, 0)} position ceiling` : policy?.adaptiveSizingEnabled ? "No flat dollar cap · conviction + reward sized" : `Capped at ${money(policy?.maximumPositionUsd ?? 0)}`}</small></div>
        <div><span>Stop / target</span><strong>{percent(policy?.stopLossPercent ?? 0)} / {percent(policy?.takeProfitPercent ?? 0)}</strong><small>Trailing protection can activate earlier</small></div>
        {policy?.riskAtStopSizingEnabled && <div><span>Portfolio budget</span><strong>{count(policy.maximumOpenPositions)} positions · {percent(policy.maximumDeployedFraction * 100, 0)}</strong><small>{money(policy.minimumLiquidReserveUsd)} reserve · {percent(policy.maximumDeveloperClusterFraction * 100, 0)} developer-cluster ceiling</small></div>}
        {policy?.riskAtStopSizingEnabled && <div><span>Loss brakes</span><strong>{percent(policy.dailyLossPausePercent)} daily · {percent(policy.maximumDrawdownPercent)} peak</strong><small>New entries pause or lock at the frozen PAPER limits</small></div>}
      </div>}

      {!account ? <EmptyState
        icon="spark"
        title="Autonomous strategy has not started"
        detail="Enable this isolated PAPER lane to create its own virtual account and begin recording market decisions. No real funds will move."
      /> : <>
        <div className="autonomous-account-metrics">
          <div><span>Starting account</span><strong>{money(account.initialNavUsd)}</strong><small>Independent virtual bankroll</small></div>
          <div><span>Current NAV</span><strong>{money(account.navUsd)}</strong><small>{money(account.cashUsd)} cash</small></div>
          <div><span>Total P&amp;L</span><strong className={totalPnl >= 0 ? "positive" : "negative"}>{signedMoney(totalPnl)}</strong><small>{signedMoney(account.realizedPnlUsd)} realized</small></div>
          <div><span>Deployed</span><strong>{money(account.deployedUsd)}</strong><small>{count(account.openPositions)} open</small></div>
          <div><span>Max drawdown</span><strong className={account.maxDrawdownPercent > 15 ? "negative" : "warning"}>{percent(account.maxDrawdownPercent)}</strong><small>{count(account.completedTrades)} completed</small></div>
          <div><span>Win rate / factor</span><strong>{winRate === undefined ? "—" : percent(winRate)}</strong><small>{profitFactor === undefined ? "No closed evidence" : `PF ${Number.isFinite(profitFactor) ? profitFactor.toFixed(2) : "∞"}`}</small></div>
        </div>

        {autonomous.learning && <div className="autonomous-subsection" aria-labelledby="autonomous-learning-title">
          <div className="autonomous-subsection-heading">
            <div>
              <h3 id="autonomous-learning-title">{learningEpoch} validated learning lab: research separated from bankroll</h3>
              <p>It records dense executable paths, compares returns with SOL, and requires purged held-out validation before any model can influence the isolated PAPER account.</p>
            </div>
            <Button
              tone="secondary"
              icon="spark"
              busy={trainingBusy}
              disabled={autonomous.learning.status === "TRAINING"}
              onClick={() => void trainLearningBrain()}
            >Analyze now</Button>
          </div>
          <div className="autonomous-account-metrics">
            <div><span>Brain status</span><strong className={autonomous.learning.status === "READY" ? "positive" : autonomous.learning.status === "DEGRADED" ? "negative" : "warning"}>{titleCase(autonomous.learning.status)}</strong><small>Schema v{count(autonomous.learning.databaseSchemaVersion)}</small></div>
            <div><span>Causal regime</span><strong>{titleCase(autonomous.learning.currentRegime)}</strong><small>No future prices in entry features</small></div>
            <div><span>{learningEpoch} cohort evidence</span><strong>{count(autonomous.learning.cohortDatasetEligiblePaths ?? autonomous.learning.datasetEligiblePaths)} / {count(autonomous.learning.minimumPathsForModelInfluence)}</strong><small>{autonomous.learning.modelInfluenceEnabled ? "Held-out validation passed" : `${count(autonomous.learning.historicalDatasetEligiblePaths ?? 0)} historical paths cannot unlock ${learningEpoch}`}</small></div>
            <div><span>{learningEpoch} shadow queue</span><strong>{count(autonomous.learning.cohortPendingEpisodes ?? autonomous.learning.pendingEpisodes)} pending</strong><small>{count(autonomous.learning.cohortActiveEpisodes ?? autonomous.learning.activeEpisodes)} active · {count(autonomous.learning.cohortCompletedEpisodes ?? autonomous.learning.completedExecutablePaths)} completed</small></div>
            <div><span>Active models</span><strong>{count(autonomous.learning.activeModels.length)} / 4</strong><small>Profitability · return · adverse tail · reward</small></div>
            <div><span>Dense path coverage</span><strong>{percent(autonomous.learning.densePathCoveragePercent ?? 0)}</strong><small>{count(autonomous.learning.pathObservationCount ?? 0)} timestamped executable marks</small></div>
            <div><span>Quote coverage</span><strong>{percent(autonomous.learning.quoteCoveragePercent ?? 0)}</strong><small>Transient failures retry before becoming unpriced</small></div>
            <div><span>Provider budget</span><strong>{percent(autonomous.learning.quoteWorkBudgetFraction * 100, 0)}</strong><small>Research work cannot consume the full quote lane</small></div>
            {autonomous.learning.scheduler && <div><span>{learningEpoch} research capacity</span><strong>{count(autonomous.learning.cohortActiveEpisodes ?? autonomous.learning.activeEpisodes)} / {count(autonomous.learning.scheduler.activeCapacity)}</strong><small>Up to {count(autonomous.learning.scheduler.maximumNewPerScan)} new paths per scan</small></div>}
            {autonomous.learning.scheduler && <div><span>Next learning refresh</span><strong>{titleCase(autonomous.learning.scheduler.nextTrainingReason)}</strong><small>{count(autonomous.learning.scheduler.newEligible45mLabelsSinceTraining)} new 45m · {count(autonomous.learning.scheduler.newEligible180mLabelsSinceTraining)} new 180m labels</small></div>}
          </div>
          {isRegimeAdaptiveLearning && <div className="autonomous-isolation verified">
            <div><Icon name="activity" size={17} /><span><strong>Regime-aware collection</strong><small>High-volatility scans reserve bankroll eligibility for strong wallet-confirmed, breakout, and continuation evidence while safe near-misses become simulation-only probes.</small></span></div>
            <div><Icon name="database" size={17} /><span><strong>Independent samples</strong><small>At most one executable shadow episode per mint per UTC day.</small></span></div>
            <div><Icon name="shield" size={17} /><span><strong>Adaptive arm quarantine</strong><small>{count(quarantinedArmCount)} arm/regime segments currently blocked after a negative confidence bound.</small></span></div>
          </div>}
          {autonomous.learning.simulationArena && <div className="autonomous-subsection" aria-labelledby="autonomous-simulation-arena-title">
            <div className="autonomous-subsection-heading">
              <div>
                <h3 id="autonomous-simulation-arena-title">Shadow Simulation Arena</h3>
                <p>Every completed executable path is replayed through a deterministic policy tournament. The arena can teach the models and propose challengers, but it cannot place a PAPER order or change position sizing.</p>
              </div>
              <span className="status-pill status-skipped neutral"><span className="tiny-dot" />{titleCase(autonomous.learning.simulationArena.status)}</span>
            </div>
            <div className="autonomous-account-metrics">
              <div><span>Policy search space</span><strong>{count(autonomous.learning.simulationArena.candidatePolicyCount)}</strong><small>Entry flow · acceleration · cost · stop · target · hold</small></div>
              <div><span>Probe queue</span><strong>{count(autonomous.learning.simulationArena.pendingOrActiveProbePaths)}</strong><small>{count(autonomous.learning.simulationArena.completedProbePaths)} completed · {count(autonomous.learning.simulationArena.datasetEligibleProbePaths)} trainable</small></div>
              <div><span>Independent paths</span><strong>{count(autonomous.learning.simulationArena.independentPathCount)}</strong><small>{count(autonomous.learning.simulationArena.denseIndependentPathCount)} have dense executable marks</small></div>
              <div><span>Latest scorable evaluations</span><strong>{count(autonomous.learning.simulationArena.latestScorableScenarioEvaluations)}</strong><small>Counterfactual variants, not extra trades</small></div>
            </div>
            <div className="autonomous-isolation verified">
              <div><Icon name="lock" size={17} /><span><strong>Capital influence: NO</strong><small>Simulation probes are permanently shadow-only and fail the champion admission gate.</small></span></div>
              <div><Icon name="database" size={17} /><span><strong>One path stays one sample</strong><small>{count(autonomous.learning.simulationArena.candidatePolicyCount)} correlated policy replays never become {count(autonomous.learning.simulationArena.candidatePolicyCount)} independent trades.</small></span></div>
              <div><Icon name="shield" size={17} /><span><strong>Promotion still evidence-gated</strong><small>{autonomous.learning.simulationArena.reasonCodes.map(titleCase).join(" · ")}</small></span></div>
            </div>
          </div>}
          {autonomous.learning.calibrations && autonomous.learning.calibrations.length > 0 && <div className="autonomous-isolation verified">
            {autonomous.learning.calibrations.map((calibration) => <div key={calibration.horizonMinutes}><Icon name="activity" size={17} /><span><strong>{count(calibration.horizonMinutes)}m held-out calibration</strong><small>{calibration.independentEpisodeCount > 0 ? <>{count(calibration.trainingEpisodeCount ?? 0)} purged train · {count(calibration.validationEpisodeCount ?? 0)} holdout · coverage {percent(calibration.featureCoverage * 100)} · drift {percent(calibration.driftScore * 100)}{calibration.brierScore !== undefined ? ` · Brier ${calibration.brierScore.toFixed(3)}` : ""}{calibration.meanAbsoluteReturnError !== undefined ? ` · MAE ${(calibration.meanAbsoluteReturnError * 100).toFixed(2)}%` : ""}</> : `Waiting for executable ${learningEpoch} cohort evidence`}</small></span></div>)}
          </div>}
          <div className="autonomous-isolation verified">
            <div><Icon name="database" size={17} /><span><strong>Separate learning ledger</strong><small>Model evidence is isolated from the trading and audit database by a durable outbox.</small></span></div>
            <div><Icon name="shield" size={17} /><span><strong>Executable labels only</strong><small>Unpriced, unsafe, or hindsight-only paths cannot train the champion.</small></span></div>
            <div><Icon name="lock" size={17} /><span><strong>Promotion blocked by default</strong><small>{autonomous.learning.promotion.allowed ? "All evidence gates passed; explicit typed review is still required." : `${count(autonomous.learning.promotion.blockerCodes.length)} evidence gates remain.`}</small></span></div>
          </div>
          <div className="autonomous-two-column">
            <div className="autonomous-subsection">
              <h3>Strategy arms by market regime</h3>
              {autonomous.learning.armScores.length === 0
                ? <p className="autonomous-empty">Arm scores appear after the first completed 180-minute executable path.</p>
                : <div className="table-scroll"><table className="autonomous-table"><thead><tr><th>Arm</th><th>Regime</th><th>180m paths</th><th>Mints / days</th><th>PF</th><th>Expected return</th><th>Lower 90%</th><th>Reward lower</th><th>Capital tier</th></tr></thead><tbody>{autonomous.learning.armScores.slice(0, 12).map((score) => <tr key={`${score.strategyArm}:${score.regime}`}>
                  <td>{titleCase(score.strategyArm)}</td><td>{titleCase(score.regime)}</td><td>{count(score.sampleCount)}</td><td>{count(score.distinctMints ?? 0)} / {count(score.distinctUtcDays ?? 0)}</td><td>{Number.isFinite(score.profitFactor ?? 0) ? (score.profitFactor ?? 0).toFixed(2) : "∞"}</td><td>{logReturnPercent(score.expectedNetLogReturn)}</td><td className={score.lowerConfidenceNetLogReturn > 0 ? "positive" : "negative"}>{logReturnPercent(score.lowerConfidenceNetLogReturn)}</td><td className={(score.lowerConfidenceRiskAdjustedReward ?? -1) > 0 ? "positive" : "negative"}>{percent(score.lowerConfidenceRiskAdjustedReward ?? 0)}</td><td className={score.eligibleForChampion ? "positive" : "warning"}>{score.eligibleForChampion ? "Champion" : score.quarantined ? "Quarantined" : "Shadow only"}</td>
                </tr>)}</tbody></table></div>}
              {autonomous.learning.admissions && autonomous.learning.admissions.length > 0 && <div className="autonomous-events">{autonomous.learning.admissions.slice(0, 4).map((admission, index) => <article key={`${admission.strategyArm}:${admission.regime}:${admission.decidedAt}:${index}`}><header><strong>{titleCase(admission.strategyArm)}</strong><span className={admission.allowed ? "positive" : "warning"}>{admission.executionTier === "CHAMPION" ? "CHAMPION CAPITAL" : "RESEARCH ONLY"}</span></header><p>{admission.reasonCodes.length > 0 ? admission.reasonCodes.map(titleCase).join(" · ") : "All evidence admission gates passed."}</p><small>{titleCase(admission.regime)} · decided {dateTime(admission.decidedAt)}</small></article>)}</div>}
            </div>
            <div className="autonomous-subsection">
              <h3>Champion / challenger gate</h3>
              <p><strong>{autonomous.learning.promotion.allowed ? "Evidence gate passed" : "Promotion remains blocked"}</strong> · {count(autonomous.learning.promotion.observedDays)} observed days · {count(autonomous.learning.promotion.executableShadowPaths)} executable paths · {count(autonomous.learning.promotion.championCompletedExits)} champion exits · {count(autonomous.learning.promotion.profitableWalkForwardFolds)}/5 profitable folds.</p>
              {autonomous.learning.promotion.blockerCodes.length > 0 && <div className="autonomous-events"><article><header><strong>Required before any policy rotation</strong><span className="warning">REVIEW</span></header><p>{autonomous.learning.promotion.blockerCodes.map(titleCase).join(" · ")}</p><small>No automatic promotion, live order, signature, or transaction is possible here.</small></article></div>}
              {autonomous.learning.challengers.length > 0 && <div className="table-scroll"><table className="autonomous-table"><thead><tr><th>Rank</th><th>Stop / target</th><th>Hold</th><th>Held-out paths</th><th>Dense coverage</th><th>Net</th><th>PF</th><th>Drawdown</th><th>Status</th></tr></thead><tbody>{autonomous.learning.challengers.map((challenger) => <tr key={challenger.id}><td>{count(challenger.rank)}</td><td>{percent(challenger.stopLossPercent)} / {percent(challenger.takeProfitPercent)}</td><td>{count(challenger.maximumHoldingMinutes)} min</td><td>{count(challenger.completedPaths)}</td><td>{percent(challenger.densePathCoveragePercent ?? 0)}</td><td className={challenger.netReturnPercent >= 0 ? "positive" : "negative"}>{percent(challenger.netReturnPercent)}</td><td>{Number.isFinite(challenger.profitFactor) ? challenger.profitFactor.toFixed(2) : "∞"}</td><td>{percent(challenger.maximumDrawdownPercent)}</td><td>{titleCase(challenger.status)}</td></tr>)}</tbody></table></div>}
            </div>
          </div>
          {autonomous.learning.recentAttributions.length > 0 && <div className="autonomous-events">{autonomous.learning.recentAttributions.slice(0, 6).map((attribution) => <article key={attribution.id}><header><strong>{titleCase(attribution.primaryCause)}</strong><span className={attribution.primaryCause === "POSITIVE_EXECUTION" ? "positive" : "warning"}>{money(attribution.avoidableLossUsd)} avoidable loss</span></header><p>{attribution.reasonCodes.map(titleCase).join(" · ")}</p><small>Independent executable shadow episode {shortKey(attribution.episodeId)}</small></article>)}</div>}
        </div>}

        <div className="autonomous-subsection">
          <h3>Open positions, stops, and targets</h3>
          {autonomous.positions.length === 0 ? <p className="autonomous-empty">The bot is scanning; it has no open simulated positions.</p> : <div className="table-scroll"><table className="autonomous-table"><thead><tr><th>Token</th><th>Status</th><th>Opened</th><th>Cost</th><th>Executable value</th><th>P&amp;L</th><th>Last price</th><th>Active stop</th><th>Target</th></tr></thead><tbody>{autonomous.positions.map((position) => {
            const pnl = positionPnl(position);
            return <tr key={position.id}>
              <td><a href={`https://solscan.io/token/${encodeURIComponent(position.mint)}`} target="_blank" rel="noreferrer" title={position.mint}>{tokenName(position.symbol, position.mint)}</a><small>{shortKey(position.mint)}</small></td>
              <td><span className={`status-pill status-skipped ${position.status === "OPEN" ? "positive" : position.status === "UNPRICED" ? "negative" : "neutral"}`}><span className="tiny-dot" />{titleCase(position.status)}</span></td>
              <td>{dateTime(position.openedAt)}</td>
              <td>{money(position.remainingCostUsd)}</td>
              <td>{position.status === "UNPRICED" ? "Unpriced" : money(position.lastExecutableValueUsd)}</td>
              <td className={pnl >= 0 ? "positive" : "negative"}>{signedMoney(pnl)}</td>
              <td>{money(position.lastPriceUsd)}</td>
              <td>{stopLabel(position)}</td>
              <td>{money(position.takeProfitPriceUsd)}</td>
            </tr>;
          })}</tbody></table></div>}
        </div>

        {autonomous.replayLab && <div className="autonomous-subsection" aria-labelledby="autonomous-replay-lab-title">
          <h3 id="autonomous-replay-lab-title">Replay Lab: actual paths vs 1,000 exit scenarios</h3>
          <p>Each completed PAPER path is evaluated against 1,000 deterministic what-if policies. Those correlated scenarios remain one independent episode and cannot change NAV, execution, or sizing.</p>
          <div className="autonomous-account-metrics">
            <div><span>Capturing</span><strong>{count(autonomous.replayLab.capturingEpisodes)}</strong><small>Following actual paths</small></div>
            <div><span>Ready</span><strong>{count(autonomous.replayLab.readyEpisodes)}</strong><small>Awaiting deterministic replay</small></div>
            <div><span>Completed</span><strong>{count(autonomous.replayLab.replayedEpisodes)}</strong><small>Replay reports generated</small></div>
            <div><span>Incomplete</span><strong>{count(autonomous.replayLab.incompleteEpisodes)}</strong><small>Never treated as a result</small></div>
            <div><span>Independent episodes</span><strong>{count(autonomous.replayLab.independentEpisodeCount)}</strong><small>Actual captured market paths</small></div>
            <div><span>Scenario evaluations</span><strong>{count(autonomous.replayLab.scenarioEvaluations)}</strong><small>1,000 variants per completed path</small></div>
          </div>
          <div className="autonomous-isolation verified">
            <div><Icon name="lock" size={17} /><span><strong>Execution disabled</strong><small>No replay can submit, approve, sign, or promote an order.</small></span></div>
            <div><Icon name="shield" size={17} /><span><strong>Used by sizing: NO</strong><small>Hindsight and scenario results are quarantined from v7/v8 position sizing.</small></span></div>
            <div><Icon name="database" size={17} /><span><strong>Episodes, not trades</strong><small>{count(autonomous.replayLab.independentEpisodeCount)} independent episodes vs {count(autonomous.replayLab.scenarioEvaluations)} correlated evaluations.</small></span></div>
          </div>
          <h3>Recent actual-vs-hindsight regret</h3>
          {autonomous.replayLab.recentReports.length === 0
            ? <p className="autonomous-empty">No completed replay report yet. Capturing can continue without affecting the PAPER account.</p>
            : <div className="autonomous-events">{autonomous.replayLab.recentReports.slice(0, 5).map((report) => {
              const episode = autonomous.replayLab?.recentEpisodes.find((value) => value.id === report.episodeId);
              const insight = autonomous.replayLab?.recentInsights?.find((value) => value.reportId === report.id);
              const label = episode ? tokenName(episode.symbol, episode.mint) : shortKey(report.positionId);
              return <article key={report.id}>
                <header><strong>{label}</strong><span className="warning">HINDSIGHT ONLY</span>{insight && <span className={replayInsightTone(insight.classification)}>{replayInsightLabel(insight.classification)}</span>}</header>
                <p>{insight && <>Actual PAPER trade {insight.actualExit === undefined ? "unscored" : `${signedMoney(insight.actualExit.pnlUsd)} (${percent(insight.actualExit.returnPercent)}) at ${dateTime(insight.actualExit.observedAt)}`} · </>}Frozen replay baseline {report.baselineReturnPercent === undefined ? "unscored" : percent(report.baselineReturnPercent)} · hindsight best {report.hindsightBestReturnPercent === undefined ? "unscored" : percent(report.hindsightBestReturnPercent)} · baseline gap {report.hindsightRegretPercent === undefined ? "unscored" : `${report.hindsightRegretPercent.toFixed(1)} percentage points`}</p>
                {insight && <>
                  <p><strong>{insight.classification === "NO_IMPROVEMENT" ? "Best tested result; no alternative improved the actual trade:" : insight.classification === "UNSCORABLE" ? "Best scorable scenario; not comparable to actual:" : "Best tested alternative:"}</strong> {insight.bestVariant ? `${titleCase(insight.bestVariant.exitReason)} at ${dateTime(insight.bestVariant.exitedAt)} produced ${signedMoney(insight.bestVariant.pnlUsd)} (${percent(insight.bestVariant.returnPercent)})${insight.improvementPercentPoints === undefined ? "" : `, an improvement over the actual trade of ${insight.improvementPercentPoints.toFixed(2)} percentage points`}.` : "No completed variant had enough evidence to name a move."}</p>
                  <p><strong>Profitable tested variants:</strong> {count(insight.profitableVariantCount)} of {count(report.scorableVariantCount)} scorable ({count(insight.evaluatedVariantCount)} evaluated). {replayPathDiagnosis(insight)}</p>
                  {insight.bestVariant && <details><summary>Exact tested parameters for variant #{count(insight.bestVariant.variantIndex + 1)}</summary><p>{replayParameterSummary(insight.bestVariant.parameters)}</p></details>}
                  {insight.bestObservedExit
                    ? <p><strong>Best observed executable sell — path oracle, not a policy:</strong> {titleCase(insight.bestObservedExit.phase)} at {dateTime(insight.bestObservedExit.observedAt)} was worth {money(insight.bestObservedExit.executableValueUsd)}, or {signedMoney(insight.bestObservedExit.pnlUsd)} ({percent(insight.bestObservedExit.returnPercent)}). Profitable observed exit: {insight.observedProfitableExit ? "YES" : "NO"}.</p>
                    : <p><strong>Best observed executable sell:</strong> unscorable; no complete post-entry quote was persisted.</p>}
                  <small>Hindsight diagnostics only · Cannot affect NAV, rewards, sizing, policy, promotion, execution, approvals, or signing.</small>
                </>}
                <small>{count(report.independentEpisodeCount)} independent episode · {count(report.variantCount)} correlated scenario evaluations · {count(report.scorableVariantCount)} scorable · Used by sizing: NO</small>
              </article>;
            })}</div>}
        </div>}

        <div className="autonomous-two-column">
          <div className="autonomous-subsection">
            <h3>Why the bot acted or passed</h3>
            {autonomous.recentDecisions.length === 0 ? <p className="autonomous-empty">No decision evidence yet.</p> : <div className="autonomous-events">{autonomous.recentDecisions.slice(0, 10).map((decision) => <article key={decision.id}>
              <header><strong>{titleCase(decision.action)} {tokenName(decision.symbol, decision.mint)}</strong>{isControlledExploration(decision.reasons) && <span className="warning">CONTROLLED_EXPLORATION</span>}<span className={decision.outcome === "SIMULATED" ? "positive" : decision.outcome === "FAILED" ? "negative" : "warning"}>{titleCase(decision.outcome)}</span></header>
              <p>{decision.reasons.join(" ") || "The persisted strategy policy produced this outcome."}</p>
              {isControlledExploration(decision.reasons) && <p><strong>Controlled PAPER evidence collection:</strong> normal token, quote, reserve, and safety gates still apply. Frozen policy unchanged.</p>}
              <dl><div><dt>Momentum</dt><dd>{decision.score.toFixed(1)}</dd></div><div><dt>Price</dt><dd>{money(decision.snapshot.priceUsd)}</dd></div><div><dt>Liquidity</dt><dd>{money(decision.snapshot.liquidityUsd, true)}</dd></div><div><dt>5m move</dt><dd>{percent(decision.snapshot.priceChange5mPercent)}</dd></div>{decision.modeledPositionUsd !== undefined && <div><dt>Position</dt><dd>{money(decision.modeledPositionUsd)}</dd></div>}{decision.sizing && <div><dt>Conviction</dt><dd>{percent(decision.sizing.componentScores.conviction * 100)}</dd></div>}{decision.sizing && <div><dt>Quote quality</dt><dd>{percent(decision.sizing.componentScores.quoteQuality * 100)}</dd></div>}{decision.sizing && <div><dt>Learning</dt><dd>{learningLabel(decision.sizing, policy?.adaptiveSizingMinimumTrades ?? 0, policy?.contextualRewardMinimumComparableTrades ?? 0)}</dd></div>}{decision.sizing?.contextualReward && <div><dt>Context breadth</dt><dd>{count(decision.sizing.contextualReward.distinctMints)} mints · {count(decision.sizing.contextualReward.distinctUtcDays)} days</dd></div>}{decision.projectedRoundTripCostPercent !== undefined && <div><dt>Round trip</dt><dd>{percent(decision.projectedRoundTripCostPercent)}</dd></div>}</dl>
              {decision.sizing && <p><strong>Size logic:</strong> {decision.sizing.explanationCodes.map(titleCase).join(" · ")}</p>}
              <small>{dateTime(decision.decidedAt)} · evidence {dateTime(decision.snapshot.sourceUpdatedAt)}</small>
            </article>)}</div>}
          </div>
          <div className="autonomous-subsection">
            <h3>Recent completed trades</h3>
            {autonomous.recentTrades.length === 0 ? <p className="autonomous-empty">No autonomous positions have closed.</p> : <div className="autonomous-events">{autonomous.recentTrades.slice(0, 10).map((trade) => <article key={trade.id}>
              <header><strong>{tokenName(trade.symbol, trade.mint)}</strong><span className={trade.pnlUsd >= 0 ? "positive" : "negative"}>{signedMoney(trade.pnlUsd)}</span></header>
              <p>{titleCase(trade.exitReason)} · {percent(trade.returnPercent)} return · {money(trade.modeledCostsUsd)} modeled costs · {rewardPoints(trade.returnPercent, policy?.stopLossPercent ?? 1, policy?.takeProfitPercent ?? 1) >= 0 ? "+" : ""}{rewardPoints(trade.returnPercent, policy?.stopLossPercent ?? 1, policy?.takeProfitPercent ?? 1).toFixed(1)} reward</p>
              <small>Opened {dateTime(trade.openedAt)} · closed {dateTime(trade.closedAt)}</small>
            </article>)}</div>}
          </div>
        </div>
      </>}

      <footer className="autonomous-footer"><Icon name="alert" size={15} /><span>This experimental bot remains PAPER-only. It compounds gains, cuts size after losses, and learns only from sufficiently broad same-lane trades with similar entry evidence; it still cannot guarantee profit.</span></footer>
    </section>
  );
}
