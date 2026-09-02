import type {
  DataProviderProfileSummary,
  DataProviderRpcReadinessSummary,
  DataProviderStatus,
  EmergencyExitRpcStatus,
  SolPriceCoverageSummary,
  SelfHostedPaperSoakSummary
} from "@copylab/shared";
import type { ProviderParityObservation } from "./provider-parity.js";
import {
  verifyBoundProviderParityObservation,
  type ProviderParityBaselineRun,
  type ProviderParityProofEpoch
} from "./provider-parity-proof.js";
import { inactiveSelfHostedPaperSoak } from "./self-hosted-paper-soak.js";
import { isSolPriceCoverageGapAcceptable } from "./local-sol-price.js";

const DAY_MS = 86_400_000;
const MAXIMUM_RPC_READINESS_AGE_MS = 10 * 60_000;
const MAXIMUM_SHADOW_HEALTH_GAP_MS = 15 * 60_000;
const MAXIMUM_SHADOW_HEALTH_AGE_MS = 10 * 60_000;
const MINIMUM_COMMON_REPLAY_WALLETS = 5;
const MINIMUM_LIVE_MATCHED_SIGNALS = 25;
const MINIMUM_DISCOVERY_OVERLAP = 5;
const REQUIRED_MATCH_CAPABILITIES: ProviderParityObservation["capability"][] = [
  "WALLET_PNL_30D",
  "WALLET_PNL_90D",
  "CHAIN_HEALTH",
  "CHAIN_HISTORY",
  "CHAIN_GAP",
  "CHAIN_LIVE"
];

export interface ProviderReadinessInput {
  profile: DataProviderProfileSummary;
  priceCoverage: SolPriceCoverageSummary;
  observations: Array<ProviderParityObservation & { id?: number }>;
  /** Exact endpoint fingerprint from the encrypted active profile. */
  endpointFingerprint?: string;
  /** ACTIVE epoch only; PREPARED evidence can never authorize promotion. */
  proofEpoch?: ProviderParityProofEpoch;
  /** Latest prepared/invalidated epoch, used only to explain a blocked coordinator. */
  proofCandidate?: ProviderParityProofEpoch;
  baselineRun?: ProviderParityBaselineRun;
  rpcReadiness?: DataProviderRpcReadinessSummary;
  selfHostedPaperSoak?: SelfHostedPaperSoakSummary;
  emergencyExitRpc?: EmergencyExitRpcStatus;
  now?: Date;
}

function finiteTime(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function calculateProviderReadiness(input: ProviderReadinessInput): DataProviderStatus {
  const now = input.now ?? new Date();
  const emergencyExitRpc = input.emergencyExitRpc ?? {
    configured: input.profile.mode === "MANAGED",
    ok: input.profile.mode === "MANAGED",
    message: input.profile.mode === "MANAGED"
      ? "Managed signer RPC remains the active exit path"
      : "An independent emergency-exit HTTP RPC is not configured"
  };
  const activeProof = input.proofEpoch?.status === "ACTIVE" &&
    input.endpointFingerprint !== undefined &&
    input.proofEpoch.endpointFingerprint === input.endpointFingerprint
    ? input.proofEpoch
    : undefined;
  const relevantBaselineRun = activeProof
    ? input.baselineRun?.proofEpochId === activeProof.id ? input.baselineRun : undefined
    : input.baselineRun;
  const verifiedObservations = activeProof
    ? input.observations.filter((observation) => {
      if (!verifyBoundProviderParityObservation(activeProof, observation).ok) return false;
      const continuous = observation.capability === "CHAIN_HEALTH" || observation.capability === "CHAIN_LIVE";
      return !continuous || !activeProof.activatedAt ||
        Date.parse(observation.observedAt) >= Date.parse(activeProof.activatedAt);
    })
    : [];
  const invalidOrUnboundObservations = input.observations.length - verifiedObservations.length;
  const ordered = [...verifiedObservations].sort((left, right) =>
    Date.parse(right.observedAt) - Date.parse(left.observedAt)
    || ((right.id ?? 0) - (left.id ?? 0))
  );
  const latestBySubject = new Map<string, ProviderParityObservation>();
  // Repository order is newest first. Preserve the first terminal observation
  // for a capability/subject and let a later MATCH supersede its earlier PENDING.
  for (const observation of ordered) {
    const key = `${observation.capability}:${observation.subject}`;
    if (!latestBySubject.has(key)) latestBySubject.set(key, observation);
  }
  const latest = [...latestBySubject.values()];
  const lastFailureAt = Math.max(
    Number.NEGATIVE_INFINITY,
    ...ordered
      .filter((entry) => entry.status === "DIVERGENT" || entry.status === "SHADOW_UNAVAILABLE")
      .map((entry) => Date.parse(entry.observedAt))
      .filter(Number.isFinite)
  );
  // A divergence or unavailable shadow result restarts the proof period even
  // after a later matching probe resolves the immediate condition.
  const qualifying = ordered.filter((entry) => Date.parse(entry.observedAt) > lastFailureAt);
  const qualifyingLatestBySubject = new Map<string, ProviderParityObservation>();
  for (const observation of qualifying) {
    const key = `${observation.capability}:${observation.subject}`;
    if (!qualifyingLatestBySubject.has(key)) qualifyingLatestBySubject.set(key, observation);
  }
  const matches = [...qualifyingLatestBySubject.values()].filter((entry) => entry.status === "MATCH");
  const matchedCapabilities = [...new Set(matches.map((entry) => entry.capability))].sort();
  const matchingSubjects = new Map<ProviderParityObservation["capability"], Set<string>>();
  for (const match of matches) {
    const subjects = matchingSubjects.get(match.capability) ?? new Set<string>();
    subjects.add(match.subject);
    matchingSubjects.set(match.capability, subjects);
  }
  const matchedSubjectCounts = Object.fromEntries(
    [...matchingSubjects.entries()].map(([capability, subjects]) => [capability, subjects.size])
  );
  const replayCapabilities: ProviderParityObservation["capability"][] = [
    "WALLET_PNL_30D",
    "WALLET_PNL_90D",
    "CHAIN_HISTORY",
    "CHAIN_GAP"
  ];
  const commonReplaySubjects = replayCapabilities.reduce<Set<string> | undefined>((common, capability) => {
    const current = matchingSubjects.get(capability) ?? new Set<string>();
    if (common === undefined) return new Set(current);
    return new Set([...common].filter((subject) => current.has(subject)));
  }, undefined) ?? new Set<string>();
  const healthTimes = qualifying
    .filter((entry) => entry.capability === "CHAIN_HEALTH" && entry.status === "MATCH")
    .map((entry) => Date.parse(entry.observedAt))
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  const earliestHealth = healthTimes[0];
  const latestHealth = healthTimes.at(-1);
  let largestHealthGapMs = 0;
  for (let index = 1; index < healthTimes.length; index += 1) {
    largestHealthGapMs = Math.max(largestHealthGapMs, (healthTimes[index] ?? 0) - (healthTimes[index - 1] ?? 0));
  }
  const evidenceDays = earliestHealth === undefined || latestHealth === undefined
    ? 0
    : Math.max(0, (latestHealth - earliestHealth) / DAY_MS);
  const parity = {
    observations: verifiedObservations.length,
    latestMatches: matches.length,
    latestDivergences: latest.filter((entry) => entry.status === "DIVERGENT").length,
    latestUnavailable: latest.filter((entry) => entry.status === "SHADOW_UNAVAILABLE").length,
    latestPending: latest.filter((entry) => entry.status === "PENDING").length,
    matchedCapabilities,
    matchedSubjectCounts,
    commonReplayWallets: commonReplaySubjects.size,
    evidenceDays,
    ...(activeProof ? {
      proofEpochId: activeProof.id,
      proofEpochStatus: activeProof.status,
      manifestDigest: activeProof.manifestDigest,
      replaySubjects: activeProof.subjects.length,
      winnerSubjects: activeProof.subjects.filter((subject) => subject.role === "WINNER").length,
      controlSubjects: activeProof.subjects.filter((subject) => subject.role === "CONTROL").length
    } : input.proofCandidate ? {
      proofEpochId: input.proofCandidate.id,
      proofEpochStatus: input.proofCandidate.status,
      manifestDigest: input.proofCandidate.manifestDigest,
      replaySubjects: input.proofCandidate.subjects.length,
      winnerSubjects: input.proofCandidate.subjects.filter((subject) => subject.role === "WINNER").length,
      controlSubjects: input.proofCandidate.subjects.filter((subject) => subject.role === "CONTROL").length
    } : {}),
    ...(invalidOrUnboundObservations > 0 ? { invalidOrUnboundObservations } : {}),
    ...(relevantBaselineRun ? {
      baselineRunId: relevantBaselineRun.id,
      baselineRunStatus: relevantBaselineRun.status,
      baselineBlockerCodes: relevantBaselineRun.blockers.map((entry) => entry.code)
    } : {}),
    ...(latestHealth !== undefined ? { latestHealthAt: new Date(latestHealth).toISOString() } : {}),
    ...(healthTimes.length > 1 ? { largestHealthGapSeconds: largestHealthGapMs / 1_000 } : {})
  };
  const blockers: string[] = [];
  if (input.profile.mode !== "SHADOW") {
    blockers.push("self-hosted providers must complete shadow mode before promotion");
  }
  if (!activeProof) {
    if (input.proofCandidate?.status === "PREPARED") {
      blockers.push(
        "frozen provider parity proof is prepared but same-cutoff managed/local baselines are not sealed"
      );
    } else if (input.proofEpoch && input.endpointFingerprint !== input.proofEpoch.endpointFingerprint) {
      blockers.push("provider parity proof belongs to different self-hosted endpoints");
    } else {
      blockers.push("no active frozen provider parity proof epoch exists for the exact self-hosted endpoints");
    }
  } else if (relevantBaselineRun?.status !== "ACTIVE") {
    blockers.push("active provider parity proof has no durable ACTIVE owning capture run");
  }
  if (relevantBaselineRun && (relevantBaselineRun.status === "BLOCKED" || relevantBaselineRun.status === "FAILED")) {
    blockers.push(
      `frozen parity baseline capture is ${relevantBaselineRun.status.toLowerCase()}: ${
        relevantBaselineRun.blockers.map((entry) => entry.code.toLowerCase()).join(", ") || "unknown blocker"
      }`
    );
  }
  if (invalidOrUnboundObservations > 0) {
    blockers.push("legacy, unbound, mixed-window, or digest-invalid parity observations were excluded");
  }
  if (input.profile.mode !== "MANAGED") {
    if (!emergencyExitRpc.configured) {
      blockers.push("an independent emergency-exit HTTP RPC must be configured");
    } else if (!emergencyExitRpc.ok) {
      blockers.push("independent emergency-exit RPC capability evidence is unhealthy");
    } else {
      const emergencyCheckedAt = finiteTime(emergencyExitRpc.checkedAt);
      if (
        emergencyCheckedAt === undefined ||
        now.getTime() < emergencyCheckedAt ||
        now.getTime() - emergencyCheckedAt > MAXIMUM_RPC_READINESS_AGE_MS
      ) {
        blockers.push("independent emergency-exit RPC capability evidence is stale");
      }
    }
    if (!input.rpcReadiness) {
      blockers.push("self-hosted RPC capability evidence is missing for the active endpoints");
    } else {
      const rpcCheckedAt = finiteTime(input.rpcReadiness.checkedAt);
      if (rpcCheckedAt === undefined || now.getTime() - rpcCheckedAt > MAXIMUM_RPC_READINESS_AGE_MS) {
        blockers.push("self-hosted RPC capability evidence is stale");
      }
      const failedCapabilities = input.rpcReadiness.capabilities
        .filter((capability) => capability.status !== "PASS")
        .map((capability) => capability.capability.toLowerCase().replaceAll("_", " "));
      if (failedCapabilities.length > 0) {
        blockers.push(
          `self-hosted RPC checks not ready: ${failedCapabilities.slice(0, 3).join(", ")}${
            failedCapabilities.length > 3 ? ` and ${failedCapabilities.length - 3} more` : ""
          }`
        );
      } else if (!input.rpcReadiness.fullCapabilitiesOk) {
        blockers.push("self-hosted full RPC capability evidence is incomplete");
      }
      if (!input.rpcReadiness.websocketOk) {
        blockers.push("self-hosted confirmed WebSocket capability is unavailable");
      }
    }
  }
  const oldestPrice = finiteTime(input.priceCoverage.oldestAt);
  const newestPrice = finiteTime(input.priceCoverage.newestAt);
  if (
    input.priceCoverage.count === 0 ||
    oldestPrice === undefined ||
    oldestPrice > now.getTime() - 90 * DAY_MS
  ) {
    blockers.push("local SOL/USD price history does not cover 90 days");
  }
  if (newestPrice === undefined || newestPrice < now.getTime() - 10 * 60_000) {
    blockers.push("local SOL/USD price history is stale");
  }
  if (!isSolPriceCoverageGapAcceptable(input.priceCoverage.largestGapSeconds)) {
    blockers.push("local SOL/USD price history contains a gap longer than ten minutes");
  }
  if ((input.priceCoverage.pendingSwapReprices ?? 0) > 0) {
    blockers.push(`${input.priceCoverage.pendingSwapReprices} SOL-legged indexed swaps still need historical USD prices`);
  }
  if (evidenceDays < 7) blockers.push("fewer than seven days of shadow parity evidence are complete");
  if (latestHealth === undefined || now.getTime() - latestHealth > MAXIMUM_SHADOW_HEALTH_AGE_MS) {
    blockers.push("shadow chain-health evidence is stale");
  }
  if (largestHealthGapMs > MAXIMUM_SHADOW_HEALTH_GAP_MS) {
    blockers.push("shadow chain-health evidence contains a monitoring gap longer than fifteen minutes");
  }
  for (const capability of REQUIRED_MATCH_CAPABILITIES) {
    if (!matchedCapabilities.includes(capability)) {
      blockers.push(`${capability.toLowerCase()} has no matching shadow evidence`);
    }
  }
  const discoveryEvidence = [...qualifyingLatestBySubject.values()]
    .find((entry) => entry.capability === "WALLET_DISCOVERY" && entry.status === "MATCH");
  const discoveryInput = discoveryEvidence?.proof?.input.kind === "DISCOVERY"
    ? discoveryEvidence.proof.input
    : undefined;
  if (
    !discoveryEvidence ||
    !discoveryInput ||
    discoveryInput.sharedPrimaryDigest !== discoveryInput.sharedShadowDigest ||
    discoveryInput.sharedAddresses.length < MINIMUM_DISCOVERY_OVERLAP
  ) {
    blockers.push(
      `local discovery needs at least ${MINIMUM_DISCOVERY_OVERLAP} shared wallets with identical frozen ranks and control lanes`
    );
  }
  if (commonReplaySubjects.size < MINIMUM_COMMON_REPLAY_WALLETS) {
    blockers.push(
      `frozen replay coverage needs at least ${MINIMUM_COMMON_REPLAY_WALLETS} wallets matching 30d/90d PnL, history, and gap repair`
    );
  }
  if ((matchingSubjects.get("CHAIN_LIVE")?.size ?? 0) < MINIMUM_LIVE_MATCHED_SIGNALS) {
    blockers.push(`live shadow coverage needs at least ${MINIMUM_LIVE_MATCHED_SIGNALS} distinct matching signals`);
  }
  if (parity.latestDivergences > 0) blockers.push("unresolved provider parity divergences remain");
  if (parity.latestUnavailable > 0) blockers.push("one or more self-hosted shadow capabilities are unavailable");
  if (parity.latestPending > 0) blockers.push("live shadow signals are still awaiting correlation");
  return {
    profile: input.profile,
    emergencyExitRpc,
    priceCoverage: input.priceCoverage,
    parity,
    ...(input.rpcReadiness ? { rpcReadiness: input.rpcReadiness } : {}),
    selfHostedPaperSoak: input.selfHostedPaperSoak ?? inactiveSelfHostedPaperSoak(),
    selfHostedReady: blockers.length === 0,
    blockers
  };
}
