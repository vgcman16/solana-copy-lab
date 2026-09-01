import { randomUUID } from "node:crypto";
import type {
  DataProviderProfile,
  DiscoveredWalletSet,
  LeaderSwap,
  PublicKeyString,
  WalletHistorySummary,
  WalletPnlWindow
} from "@copylab/shared";
import type { Repository, WalletDeepHistoryEvidence } from "./repository.js";
import {
  compareWalletDiscovery,
  compareWalletPnl,
  type ProviderParityObservation
} from "./provider-parity.js";
import {
  compareGapResults,
  compareHistory
} from "./chain-provider-parity.js";
import {
  bindProviderParityObservation,
  canonicalJson,
  MAXIMUM_PROVIDER_PARITY_CAPTURE_SKEW_MS,
  type ProviderParityBaselineAcquisition,
  type ProviderParityBaselineBlocker,
  type ProviderParityBaselineBlockerCode,
  type ProviderParityBaselineRun,
  type ProviderParityProofEpoch,
  type ProviderParityProofInput,
  type ProviderParityReplaySubject
} from "./provider-parity-proof.js";
import { dataProviderEndpointFingerprint } from "./provider-rpc-readiness.js";
import { redactSensitiveText } from "@copylab/providers";
import { LocalWalletDiscoveryProvider } from "./local-wallet-discovery.js";

export interface PointInTimeWalletDiscoveryProvider {
  /** Must return the provider's immutable universe exactly as it existed at cutoffAt. */
  discoverCohortAt(cutoffAt: string): Promise<DiscoveredWalletSet>;
  /** Must calculate only the requested closed interval; rolling "last N days" is not sufficient. */
  getPnlAt(
    address: PublicKeyString,
    duration: "30d" | "90d",
    windowStartAt: string,
    cutoffAt: string
  ): Promise<WalletPnlWindow>;
}

export interface PointInTimeChainProvider {
  summarizeHistoryAt(
    address: PublicKeyString,
    windowStartAt: string,
    cutoffAt: string
  ): Promise<WalletHistorySummary>;
  /** Must stop at cutoffAt and must not return a rolling-to-now result. */
  repairGapAt(
    address: PublicKeyString,
    sinceAt: string,
    cutoffAt: string
  ): Promise<LeaderSwap[]>;
}

export interface ProviderParityPointInTimeSources {
  managedDiscovery?: PointInTimeWalletDiscoveryProvider;
  localDiscovery?: PointInTimeWalletDiscoveryProvider;
  managedChain?: PointInTimeChainProvider;
  localChain?: PointInTimeChainProvider;
}

export interface ProviderParityBaselineCoordinatorOptions {
  sources?: ProviderParityPointInTimeSources;
  now?: () => Date;
}

interface PairCapture<T> {
  primary: T;
  shadow: T;
  timing: {
    primaryAcquiredAt: string;
    shadowAcquiredAt: string;
    acquisitionSkewMs: number;
  };
}

function blocker(code: ProviderParityBaselineBlockerCode, message: string): ProviderParityBaselineBlocker {
  return { code, message };
}

function candidateSubjects(candidates: DiscoveredWalletSet["candidates"]): ProviderParityReplaySubject[] {
  const winners = candidates.filter((candidate) => !candidate.control);
  const controls = candidates.filter((candidate) => candidate.control);
  const selected = controls.length > 0
    ? [...winners.slice(0, 4), ...controls.slice(0, 1), ...winners.slice(4), ...controls.slice(1)]
    : winners;
  return selected.slice(0, 5).map((candidate) => ({
    address: candidate.address,
    role: candidate.control ? "CONTROL" as const : "WINNER" as const,
    ...(candidate.sourceRank30d !== undefined ? { sourceRank30d: candidate.sourceRank30d } : {}),
    ...(candidate.sourceRank90d !== undefined ? { sourceRank90d: candidate.sourceRank90d } : {})
  })).sort((left, right) => left.address.localeCompare(right.address));
}

function unsupportedSources(sources: ProviderParityPointInTimeSources): ProviderParityBaselineBlocker[] {
  const blockers: ProviderParityBaselineBlocker[] = [];
  if (!sources.managedDiscovery) {
    blockers.push(
      blocker("MANAGED_DISCOVERY_AS_OF_UNSUPPORTED", "Managed discovery cannot request an immutable historical cutoff."),
      blocker("MANAGED_PNL_AS_OF_UNSUPPORTED", "Managed wallet PnL cannot request an immutable closed interval.")
    );
  }
  if (!sources.localDiscovery) {
    blockers.push(
      blocker("LOCAL_DISCOVERY_AS_OF_UNSUPPORTED", "Local discovery has no explicit point-in-time capture interface."),
      blocker("LOCAL_PNL_AS_OF_UNSUPPORTED", "Local wallet PnL has no explicit point-in-time capture interface.")
    );
  }
  if (!sources.managedChain) {
    blockers.push(
      blocker("MANAGED_HISTORY_AS_OF_UNSUPPORTED", "Managed history cannot request an immutable historical cutoff."),
      blocker("MANAGED_GAP_CUTOFF_UNSUPPORTED", "Managed gap repair cannot enforce an upper cutoff.")
    );
  }
  if (!sources.localChain) {
    blockers.push(
      blocker("LOCAL_HISTORY_AS_OF_UNSUPPORTED", "Local history has no explicit point-in-time capture interface."),
      blocker("LOCAL_GAP_CUTOFF_UNSUPPORTED", "Local gap repair has no explicit upper-cutoff interface.")
    );
  }
  return blockers;
}

class FrozenLocalWalletPointInTimeProvider implements PointInTimeWalletDiscoveryProvider {
  private readonly provider: LocalWalletDiscoveryProvider;

  constructor(
    repository: Repository,
    private readonly generationId: string,
    private readonly windowStartAt: string,
    private readonly cutoffAt: string
  ) {
    this.provider = new LocalWalletDiscoveryProvider(repository, { generationId });
  }

  async discoverCohortAt(cutoffAt: string): Promise<DiscoveredWalletSet> {
    if (cutoffAt !== this.cutoffAt) throw new Error("Local discovery cutoff differs from the frozen generation.");
    const cohort = await this.provider.discoverCohort(new Date(cutoffAt));
    if (cohort.cohortId !== `local:${this.generationId}` || cohort.generatedAt !== cutoffAt) {
      throw new Error("Local discovery did not return the pinned frozen generation.");
    }
    return cohort;
  }

  getPnlAt(
    address: PublicKeyString,
    duration: "30d" | "90d",
    windowStartAt: string,
    cutoffAt: string
  ): Promise<WalletPnlWindow> {
    const expectedStart = duration === "90d"
      ? this.windowStartAt
      : new Date(Date.parse(this.cutoffAt) - 30 * 86_400_000).toISOString();
    if (cutoffAt !== this.cutoffAt || windowStartAt !== expectedStart) {
      throw new Error("Local PnL interval differs from the pinned frozen generation.");
    }
    return this.provider.getPnl(address, duration);
  }
}

class FrozenLocalChainPointInTimeProvider implements PointInTimeChainProvider {
  constructor(
    private readonly repository: Repository,
    private readonly generationId: string,
    private readonly windowStartAt: string,
    private readonly cutoffAt: string
  ) {}

  async summarizeHistoryAt(
    address: PublicKeyString,
    windowStartAt: string,
    cutoffAt: string
  ): Promise<WalletHistorySummary> {
    const evidence = this.evidence(address, windowStartAt, cutoffAt);
    const record = evidence.record;
    if (
      record.topTokenProfitShare === undefined ||
      record.topThreeProfitShare === undefined ||
      record.walletIdentityStatus === undefined
    ) throw new Error("Frozen local history is missing concentration or identity evidence.");
    return {
      wallet: address,
      historyDays: record.historyDays,
      closedEligibleSwaps: record.closedEligibleSwaps,
      activeWeeks: record.activeWeeks,
      medianHoldingMinutes: record.medianHoldingMinutes,
      topTokenProfitShare: record.topTokenProfitShare,
      topThreeProfitShare: record.topThreeProfitShare,
      tags: [...(record.tags ?? [])].sort()
    };
  }

  async repairGapAt(
    address: PublicKeyString,
    sinceAt: string,
    cutoffAt: string
  ): Promise<LeaderSwap[]> {
    const evidence = this.evidence(address, sinceAt, cutoffAt);
    return evidence.swaps
      .filter((swap) => swap.eligible && Number.isFinite(swap.priceUsd) && (swap.priceUsd ?? 0) > 0)
      .map((swap) => ({
        sourceSignature: swap.signature,
        sourceWallet: swap.wallet,
        slot: swap.slot,
        blockTime: swap.blockTime,
        detectedAt: swap.indexedAt,
        side: swap.side,
        baseMint: swap.baseMint,
        targetMint: swap.targetMint,
        baseAmountAtomic: swap.side === "BUY" ? swap.inputAmountAtomic : swap.outputAmountAtomic,
        targetAmountAtomic: swap.side === "BUY" ? swap.outputAmountAtomic : swap.inputAmountAtomic,
        baseAmountUi: swap.side === "BUY" ? swap.inputAmountUi : swap.outputAmountUi,
        targetAmountUi: swap.side === "BUY" ? swap.outputAmountUi : swap.inputAmountUi,
        leaderPriceUsd: swap.priceUsd!,
        recovered: true
      }));
  }

  private evidence(address: string, windowStartAt: string, cutoffAt: string): WalletDeepHistoryEvidence {
    if (windowStartAt !== this.windowStartAt || cutoffAt !== this.cutoffAt) {
      throw new Error("Local chain interval differs from the pinned frozen generation.");
    }
    const evidence = this.repository.getWalletDeepHistoryEvidence(this.generationId, address);
    if (
      !evidence ||
      evidence.record.deepHistoryWindowStart !== this.windowStartAt ||
      evidence.record.deepHistoryWindowEnd !== this.cutoffAt
    ) throw new Error("Pinned local chain evidence is missing or belongs to another window.");
    return evidence;
  }
}

/**
 * One explicit, durable capture operation. The production runtime currently
 * supplies no point-in-time adapters because Birdeye/Helius interfaces expose
 * rolling results. The coordinator therefore freezes a real local manifest,
 * persists precise capability blockers, and stops before making a call that
 * could be mislabeled as historical proof.
 */
export class ProviderParityBaselineCoordinator {
  private readonly sources: ProviderParityPointInTimeSources;
  private readonly now: () => Date;

  constructor(
    private readonly repository: Repository,
    private readonly profile: () => DataProviderProfile,
    options: ProviderParityBaselineCoordinatorOptions = {}
  ) {
    this.sources = options.sources ?? {};
    this.now = options.now ?? (() => new Date());
  }

  status(): ProviderParityBaselineRun | undefined {
    return this.repository.latestProviderParityBaselineRun();
  }

  async capture(): Promise<ProviderParityBaselineRun> {
    const requestedAt = this.now().toISOString();
    const id = `provider-parity-baseline:${randomUUID()}`;
    const profile = this.profile();
    if (profile.mode !== "SHADOW") {
      return this.persistTerminal({
        id,
        status: "BLOCKED",
        requestedAt,
        updatedAt: requestedAt,
        blockers: [blocker("SHADOW_MODE_REQUIRED", "Frozen parity capture requires the active SHADOW profile.")],
        acquisitions: []
      });
    }
    const endpointFingerprint = dataProviderEndpointFingerprint(profile);
    if (!endpointFingerprint) {
      return this.persistTerminal({
        id,
        status: "BLOCKED",
        requestedAt,
        updatedAt: requestedAt,
        blockers: [blocker("ENDPOINT_FINGERPRINT_MISSING", "The SHADOW endpoint fingerprint is unavailable.")],
        acquisitions: []
      });
    }
    const activeProof = this.repository.activeProviderParityProofEpoch();
    if (activeProof) {
      const owningRun = this.repository.providerParityBaselineRunForProofEpoch(activeProof.id);
      if (owningRun?.status === "ACTIVE") return owningRun;
      // This state cannot be produced by the atomic activation path. Recover
      // legacy/crash-corrupt state conservatively so it neither authorizes
      // readiness nor permanently wedges a new explicit capture.
      this.repository.invalidateProviderParityProofEpochs(
        "active proof had no durable ACTIVE owning capture run",
        requestedAt
      );
      this.repository.audit(
        "provider_parity_orphaned_active_invalidated",
        "An orphaned active provider parity proof was invalidated before a new capture.",
        { proofEpochId: activeProof.id },
        "critical"
      );
    }
    const generation = this.repository.latestCompleteWalletDeepHistoryGeneration();
    if (!generation) {
      return this.persistTerminal({
        id,
        status: "BLOCKED",
        requestedAt,
        updatedAt: requestedAt,
        endpointFingerprint,
        blockers: [blocker("FROZEN_GENERATION_MISSING", "No complete local deep-history generation is available.")],
        acquisitions: []
      });
    }
    if (
      Date.parse(generation.windowStart) >= Date.parse(generation.windowEnd) ||
      generation.windowEnd !== generation.snapshotCutoffAt
    ) {
      return this.persistTerminal({
        id,
        status: "BLOCKED",
        requestedAt,
        updatedAt: requestedAt,
        endpointFingerprint,
        generationId: generation.id,
        windowStartAt: generation.windowStart,
        cutoffAt: generation.windowEnd,
        blockers: [blocker(
          "FROZEN_GENERATION_WINDOW_INVALID",
          "The complete local generation does not share one exact window-end and snapshot cutoff."
        )],
        acquisitions: []
      });
    }
    const pinnedLocalDiscovery = new FrozenLocalWalletPointInTimeProvider(
      this.repository,
      generation.id,
      generation.windowStart,
      generation.windowEnd
    );
    const pinnedLocalChain = new FrozenLocalChainPointInTimeProvider(
      this.repository,
      generation.id,
      generation.windowStart,
      generation.windowEnd
    );
    let localUniverse: DiscoveredWalletSet;
    try {
      localUniverse = await pinnedLocalDiscovery.discoverCohortAt(generation.windowEnd);
    } catch (error) {
      return this.persistTerminal({
        id,
        status: "BLOCKED",
        requestedAt,
        updatedAt: this.now().toISOString(),
        endpointFingerprint,
        generationId: generation.id,
        windowStartAt: generation.windowStart,
        cutoffAt: generation.windowEnd,
        blockers: [blocker(
          "FROZEN_SUBJECTS_INSUFFICIENT",
          redactSensitiveText(error instanceof Error ? error.message : String(error), 1_000)
        )],
        acquisitions: []
      });
    }
    const subjects = candidateSubjects(localUniverse.candidates);
    const controlsAvailable = localUniverse.candidates.some((candidate) => candidate.control);
    if (
      subjects.length < 5 ||
      !subjects.some((subject) => subject.role === "WINNER") ||
      (controlsAvailable && !subjects.some((subject) => subject.role === "CONTROL"))
    ) {
      return this.persistTerminal({
        id,
        status: "BLOCKED",
        requestedAt,
        updatedAt: requestedAt,
        endpointFingerprint,
        generationId: generation.id,
        windowStartAt: generation.windowStart,
        cutoffAt: generation.windowEnd,
        subjects,
        blockers: [blocker(
          "FROZEN_SUBJECTS_INSUFFICIENT",
          "The latest complete generation cannot freeze five fully priced subjects with required winner/control stratification."
        )],
        acquisitions: []
      });
    }

    const priorRun = this.repository.latestProviderParityBaselineRun();
    const priorEpoch = priorRun?.proofEpochId
      ? this.repository.providerParityProofEpoch(priorRun.proofEpochId)
      : undefined;
    const resume = priorRun && priorEpoch &&
      (priorRun.status === "PREPARED" || priorRun.status === "CAPTURING") &&
      priorEpoch.status === "PREPARED" &&
      priorEpoch.endpointFingerprint === endpointFingerprint &&
      priorRun.endpointFingerprint === endpointFingerprint &&
      priorRun.generationId === generation.id &&
      priorEpoch.windowStartAt === generation.windowStart &&
      priorEpoch.windowEndAt === generation.windowEnd &&
      priorEpoch.cutoffAt === generation.windowEnd &&
      priorEpoch.controlPopulationAvailable === controlsAvailable &&
      canonicalJson(priorEpoch.subjects) === canonicalJson(subjects) &&
      canonicalJson(priorRun.subjects) === canonicalJson(subjects);
    const epoch = resume
      ? priorEpoch
      : this.repository.prepareProviderParityProofEpoch({
        endpointFingerprint,
        windowStartAt: generation.windowStart,
        windowEndAt: generation.windowEnd,
        cutoffAt: generation.windowEnd,
        controlPopulationAvailable: controlsAvailable,
        subjects,
        createdAt: requestedAt
      });
    let run: ProviderParityBaselineRun = resume
      ? priorRun
      : {
        id,
        status: "PREPARED",
        requestedAt,
        updatedAt: requestedAt,
        proofEpochId: epoch.id,
        endpointFingerprint,
        generationId: generation.id,
        windowStartAt: generation.windowStart,
        cutoffAt: generation.windowEnd,
        subjects,
        blockers: [],
        acquisitions: []
      };
    if (!resume) this.repository.saveProviderParityBaselineRun(run);

    const captureSources: ProviderParityPointInTimeSources = {
      localDiscovery: pinnedLocalDiscovery,
      localChain: pinnedLocalChain,
      ...this.sources
    };
    const missing = unsupportedSources(captureSources);
    if (missing.length > 0) {
      run = { ...run, status: "BLOCKED", updatedAt: this.now().toISOString(), blockers: missing };
      this.repository.saveProviderParityBaselineRun(run);
      return run;
    }

    run = { ...run, status: "CAPTURING", updatedAt: this.now().toISOString(), blockers: [] };
    this.repository.saveProviderParityBaselineRun(run);
    const existing: ProviderParityObservation[] = [
      ...this.repository.listProviderParityObservationsForProofEpoch(epoch.id)
    ];
    run = this.reconcileAcquisitions(run, existing);
    try {
      if (!this.hasObservation(existing, "WALLET_DISCOVERY")) {
        const discovery = await this.acquirePair(
          () => captureSources.managedDiscovery!.discoverCohortAt(epoch.cutoffAt),
          () => captureSources.localDiscovery!.discoverCohortAt(epoch.cutoffAt)
        );
        const discoveryObservation = compareWalletDiscovery(discovery.primary, discovery.shadow, epoch.cutoffAt);
        const discoveryInput: ProviderParityProofInput = {
          kind: "DISCOVERY",
          ...discovery.timing,
          cutoffAt: epoch.cutoffAt,
          primaryUniverseDigest: String(discoveryObservation.evidence?.primaryUniverseDigest ?? ""),
          shadowUniverseDigest: String(discoveryObservation.evidence?.shadowUniverseDigest ?? ""),
          sharedPrimaryDigest: String(discoveryObservation.evidence?.sharedPrimaryDigest ?? ""),
          sharedShadowDigest: String(discoveryObservation.evidence?.sharedShadowDigest ?? ""),
          sharedAddresses: Array.isArray(discoveryObservation.evidence?.sharedAddresses)
            ? discoveryObservation.evidence.sharedAddresses
            : []
        };
        const recorded = this.record(run, epoch, discoveryObservation, discoveryInput);
        run = recorded.run;
        existing.push(recorded.observation);
      }

      for (const subject of epoch.subjects) {
        for (const duration of ["30d", "90d"] as const) {
          const capability = duration === "30d" ? "WALLET_PNL_30D" as const : "WALLET_PNL_90D" as const;
          if (this.hasObservation(existing, capability, subject.address)) continue;
          const windowStartAt = new Date(
            Date.parse(epoch.cutoffAt) - (duration === "30d" ? 30 : 90) * 86_400_000
          ).toISOString();
          const captured = await this.acquirePair(
            () => captureSources.managedDiscovery!.getPnlAt(subject.address, duration, windowStartAt, epoch.cutoffAt),
            () => captureSources.localDiscovery!.getPnlAt(subject.address, duration, windowStartAt, epoch.cutoffAt)
          );
          const observation = compareWalletPnl(
            subject.address,
            captured.primary,
            captured.shadow,
            epoch.cutoffAt
          );
          const recorded = this.record(run, epoch, observation, {
            kind: "PNL",
            ...captured.timing,
            wallet: subject.address,
            duration,
            windowStartAt,
            windowEndAt: epoch.windowEndAt,
            cutoffAt: epoch.cutoffAt
          });
          run = recorded.run;
          existing.push(recorded.observation);
        }

        if (!this.hasObservation(existing, "CHAIN_HISTORY", subject.address)) {
          const history = await this.acquirePair(
            () => captureSources.managedChain!.summarizeHistoryAt(subject.address, epoch.windowStartAt, epoch.cutoffAt),
            () => captureSources.localChain!.summarizeHistoryAt(subject.address, epoch.windowStartAt, epoch.cutoffAt)
          );
          const recorded = this.record(run, epoch, compareHistory(
            history.primary,
            history.shadow,
            epoch.cutoffAt,
            90
          ), {
            kind: "HISTORY",
            ...history.timing,
            wallet: subject.address,
            days: 90,
            windowStartAt: epoch.windowStartAt,
            windowEndAt: epoch.windowEndAt,
            cutoffAt: epoch.cutoffAt
          });
          run = recorded.run;
          existing.push(recorded.observation);
        }

        if (!this.hasObservation(existing, "CHAIN_GAP", subject.address)) {
          const gap = await this.acquirePair(
            () => captureSources.managedChain!.repairGapAt(subject.address, epoch.windowStartAt, epoch.cutoffAt),
            () => captureSources.localChain!.repairGapAt(subject.address, epoch.windowStartAt, epoch.cutoffAt)
          );
          const primarySignatures = [...new Set(gap.primary.map((swap) => swap.sourceSignature))].sort();
          const shadowSignatures = [...new Set(gap.shadow.map((swap) => swap.sourceSignature))].sort();
          const recorded = this.record(run, epoch, compareGapResults(
            subject.address,
            gap.primary,
            gap.shadow,
            epoch.cutoffAt,
            epoch.windowStartAt,
            epoch.cutoffAt
          ), {
            kind: "GAP",
            ...gap.timing,
            wallet: subject.address,
            sinceAt: epoch.windowStartAt,
            cutoffAt: epoch.cutoffAt,
            primarySignatures,
            shadowSignatures
          });
          run = recorded.run;
          existing.push(recorded.observation);
        }
      }

      const activatedAt = this.now().toISOString();
      run = this.repository.activateProviderParityProofEpochWithRun(epoch.id, run, activatedAt).run;
      return run;
    } catch (error) {
      const message = redactSensitiveText(error instanceof Error ? error.message : String(error), 1_000);
      const code: ProviderParityBaselineBlockerCode = message.includes("baseline is incomplete")
        ? "BASELINE_DIVERGENT"
        : "CAPTURE_FAILED";
      run = {
        ...run,
        status: "FAILED",
        updatedAt: this.now().toISOString(),
        blockers: [blocker(code, message)]
      };
      this.repository.saveProviderParityBaselineRun(run);
      return run;
    }
  }

  private persistTerminal(run: ProviderParityBaselineRun): ProviderParityBaselineRun {
    this.repository.saveProviderParityBaselineRun(run);
    return run;
  }

  private async acquirePair<T>(
    primary: () => Promise<T>,
    shadow: () => Promise<T>
  ): Promise<PairCapture<T>> {
    let primaryAcquiredAt = "";
    let shadowAcquiredAt = "";
    const [primaryValue, shadowValue] = await Promise.all([
      primary().then((value) => {
        primaryAcquiredAt = this.now().toISOString();
        return value;
      }),
      shadow().then((value) => {
        shadowAcquiredAt = this.now().toISOString();
        return value;
      })
    ]);
    const acquisitionSkewMs = Math.abs(Date.parse(primaryAcquiredAt) - Date.parse(shadowAcquiredAt));
    if (acquisitionSkewMs > MAXIMUM_PROVIDER_PARITY_CAPTURE_SKEW_MS) {
      throw new Error("Point-in-time provider acquisition skew exceeded five seconds.");
    }
    return {
      primary: primaryValue,
      shadow: shadowValue,
      timing: { primaryAcquiredAt, shadowAcquiredAt, acquisitionSkewMs }
    };
  }

  private hasObservation(
    observations: readonly ProviderParityObservation[],
    capability: ProviderParityObservation["capability"],
    subject?: string
  ): boolean {
    return observations.some((observation) =>
      observation.capability === capability && (subject === undefined || observation.subject === subject)
    );
  }

  private acquisition(observation: ProviderParityObservation): ProviderParityBaselineAcquisition {
    const proof = observation.proof;
    if (!proof) throw new Error("Frozen parity observation has no proof binding.");
    const input = proof.input;
    return {
      capability: observation.capability,
      subject: observation.subject,
      primaryAcquiredAt: input.kind === "HEALTH" || input.kind === "LIVE"
        ? observation.observedAt
        : input.primaryAcquiredAt,
      shadowAcquiredAt: input.kind === "HEALTH" || input.kind === "LIVE"
        ? observation.observedAt
        : input.shadowAcquiredAt,
      acquisitionSkewMs: input.kind === "HEALTH" || input.kind === "LIVE" ? 0 : input.acquisitionSkewMs,
      inputDigest: proof.inputDigest,
      resultDigest: proof.resultDigest
    };
  }

  private reconcileAcquisitions(
    run: ProviderParityBaselineRun,
    observations: readonly ProviderParityObservation[]
  ): ProviderParityBaselineRun {
    let next = run;
    const retained = new Set(run.acquisitions.map((entry) => `${entry.inputDigest}:${entry.resultDigest}`));
    for (const observation of observations) {
      const acquisition = this.acquisition(observation);
      const key = `${acquisition.inputDigest}:${acquisition.resultDigest}`;
      if (retained.has(key)) continue;
      next = {
        ...next,
        acquisitions: [...next.acquisitions, acquisition],
        updatedAt: this.now().toISOString()
      };
      this.repository.saveProviderParityBaselineRun(next);
      retained.add(key);
    }
    return next;
  }

  private record(
    run: ProviderParityBaselineRun,
    epoch: ProviderParityProofEpoch,
    observation: ProviderParityObservation,
    input: ProviderParityProofInput
  ): { run: ProviderParityBaselineRun; observation: ProviderParityObservation } {
    const profile = this.profile();
    if (
      profile.mode !== "SHADOW" ||
      dataProviderEndpointFingerprint(profile) !== epoch.endpointFingerprint
    ) throw new Error("Frozen parity capture endpoints changed before the durable observation commit.");
    const bound = bindProviderParityObservation(epoch, observation, input);
    const acquisition = this.acquisition(bound);
    const saved = this.repository.appendProviderParityBaselineObservation(run, bound, acquisition);
    return { run: saved.run, observation: bound };
  }
}
