import { createHash, randomUUID } from "node:crypto";
import type {
  DataProviderProfile,
  DiscoveredWalletSet,
  LeaderSwap,
  WalletCandidate
} from "@copylab/shared";
import { dataProviderEndpointFingerprint } from "./provider-rpc-readiness.js";
import type {
  ProviderParityObservation,
  ProviderParitySink
} from "./provider-parity.js";

export const MINIMUM_PROVIDER_PARITY_REPLAY_SUBJECTS = 5;
export const MAXIMUM_PROVIDER_PARITY_CAPTURE_SKEW_MS = 5_000;

export type ProviderParityReplayRole = "WINNER" | "CONTROL";
export type ProviderParityProofEpochStatus = "PREPARED" | "ACTIVE" | "INVALIDATED";

export interface ProviderParityReplaySubject {
  address: string;
  role: ProviderParityReplayRole;
  sourceRank30d?: number;
  sourceRank90d?: number;
}

export interface ProviderParityProofEpoch {
  id: string;
  status: ProviderParityProofEpochStatus;
  endpointFingerprint: string;
  windowStartAt: string;
  windowEndAt: string;
  cutoffAt: string;
  controlPopulationAvailable: boolean;
  subjects: ProviderParityReplaySubject[];
  manifestDigest: string;
  createdAt: string;
  activatedAt?: string;
  invalidatedAt?: string;
  invalidationReason?: string;
}

export interface PrepareProviderParityProofEpochInput {
  endpointFingerprint: string;
  windowStartAt: string;
  windowEndAt: string;
  cutoffAt: string;
  controlPopulationAvailable: boolean;
  subjects: ProviderParityReplaySubject[];
  createdAt: string;
  id?: string;
}

interface ProviderParityAcquisitionTiming {
  primaryAcquiredAt: string;
  shadowAcquiredAt: string;
  acquisitionSkewMs: number;
}

export type ProviderParityProofInput =
  | ({
    kind: "DISCOVERY";
    cutoffAt: string;
    primaryUniverseDigest: string;
    shadowUniverseDigest: string;
    sharedPrimaryDigest: string;
    sharedShadowDigest: string;
    sharedAddresses: string[];
  } & ProviderParityAcquisitionTiming)
  | ({
    kind: "PNL";
    wallet: string;
    duration: "30d" | "90d";
    windowStartAt: string;
    windowEndAt: string;
    cutoffAt: string;
  } & ProviderParityAcquisitionTiming)
  | ({
    kind: "HISTORY";
    wallet: string;
    days: 90;
    windowStartAt: string;
    windowEndAt: string;
    cutoffAt: string;
  } & ProviderParityAcquisitionTiming)
  | ({
    kind: "GAP";
    wallet: string;
    sinceAt: string;
    cutoffAt: string;
    primarySignatures: string[];
    shadowSignatures: string[];
  } & ProviderParityAcquisitionTiming)
  | {
    kind: "HEALTH";
    observedAt: string;
  }
  | {
    kind: "LIVE";
    wallet: string;
    signature: string;
  };

export interface ProviderParityProofBinding {
  proofEpochId: string;
  endpointFingerprint: string;
  windowStartAt: string;
  windowEndAt: string;
  cutoffAt: string;
  manifestDigest: string;
  input: ProviderParityProofInput;
  inputDigest: string;
  resultDigest: string;
}

export type ProviderParityBaselineRunStatus =
  | "PREPARING"
  | "PREPARED"
  | "CAPTURING"
  | "BLOCKED"
  | "ACTIVE"
  | "FAILED";

export type ProviderParityBaselineBlockerCode =
  | "SHADOW_MODE_REQUIRED"
  | "ENDPOINT_FINGERPRINT_MISSING"
  | "ACTIVE_PROOF_EXISTS"
  | "FROZEN_GENERATION_MISSING"
  | "FROZEN_GENERATION_WINDOW_INVALID"
  | "FROZEN_SUBJECTS_INSUFFICIENT"
  | "MANAGED_DISCOVERY_AS_OF_UNSUPPORTED"
  | "LOCAL_DISCOVERY_AS_OF_UNSUPPORTED"
  | "MANAGED_PNL_AS_OF_UNSUPPORTED"
  | "LOCAL_PNL_AS_OF_UNSUPPORTED"
  | "MANAGED_HISTORY_AS_OF_UNSUPPORTED"
  | "LOCAL_HISTORY_AS_OF_UNSUPPORTED"
  | "MANAGED_GAP_CUTOFF_UNSUPPORTED"
  | "LOCAL_GAP_CUTOFF_UNSUPPORTED"
  | "CAPTURE_FAILED"
  | "BASELINE_DIVERGENT";

export interface ProviderParityBaselineBlocker {
  code: ProviderParityBaselineBlockerCode;
  message: string;
}

export interface ProviderParityBaselineAcquisition {
  capability: ProviderParityObservation["capability"];
  subject: string;
  primaryAcquiredAt: string;
  shadowAcquiredAt: string;
  acquisitionSkewMs: number;
  inputDigest: string;
  resultDigest: string;
}

export interface ProviderParityBaselineRun {
  id: string;
  status: ProviderParityBaselineRunStatus;
  requestedAt: string;
  updatedAt: string;
  proofEpochId?: string;
  endpointFingerprint?: string;
  generationId?: string;
  windowStartAt?: string;
  cutoffAt?: string;
  subjects?: ProviderParityReplaySubject[];
  blockers: ProviderParityBaselineBlocker[];
  acquisitions: ProviderParityBaselineAcquisition[];
  activatedAt?: string;
}

export interface ProviderParityProofStore {
  providerParityProofEpoch(id: string): ProviderParityProofEpoch | undefined;
  activeProviderParityProofEpoch(endpointFingerprint?: string): ProviderParityProofEpoch | undefined;
  saveProviderParityObservation(observation: ProviderParityObservation): number;
}

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Parity proof values must be finite.");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry !== undefined) result[key] = canonicalValue(entry);
    }
    return result;
  }
  throw new Error("Parity proof values must be JSON serializable.");
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function parityDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function providerParityDiscoveryEvidence(
  primary: DiscoveredWalletSet,
  shadow: DiscoveredWalletSet
): {
  primaryUniverseDigest: string;
  shadowUniverseDigest: string;
  sharedPrimaryDigest: string;
  sharedShadowDigest: string;
  sharedAddresses: string[];
} {
  const primaryByAddress = new Map(primary.candidates.map((candidate) => [candidate.address, candidate]));
  const shadowByAddress = new Map(shadow.candidates.map((candidate) => [candidate.address, candidate]));
  if (primaryByAddress.size !== primary.candidates.length || shadowByAddress.size !== shadow.candidates.length) {
    throw new Error("Discovery universe contains duplicate wallet addresses.");
  }
  const normalize = (candidate: WalletCandidate) => ({
    address: candidate.address,
    control: candidate.control,
    sourceRank30d: candidate.sourceRank30d ?? null,
    sourceRank90d: candidate.sourceRank90d ?? null
  });
  const primaryUniverse = [...primaryByAddress.values()].map(normalize)
    .sort((left, right) => left.address.localeCompare(right.address));
  const shadowUniverse = [...shadowByAddress.values()].map(normalize)
    .sort((left, right) => left.address.localeCompare(right.address));
  const sharedAddresses = [...primaryByAddress.keys()].filter((address) => shadowByAddress.has(address)).sort();
  const sharedPrimary = sharedAddresses.map((address) => normalize(primaryByAddress.get(address)!));
  const sharedShadow = sharedAddresses.map((address) => normalize(shadowByAddress.get(address)!));
  return {
    primaryUniverseDigest: parityDigest(primaryUniverse),
    shadowUniverseDigest: parityDigest(shadowUniverse),
    sharedPrimaryDigest: parityDigest(sharedPrimary),
    sharedShadowDigest: parityDigest(sharedShadow),
    sharedAddresses
  };
}

function assertDigest(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error(`${label} must be a SHA-256 digest.`);
}

function assertIso(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`${label} must be a canonical ISO timestamp.`);
  }
  return parsed;
}

function normalizedRank(value: number | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer.`);
  return value;
}

export function normalizeProviderParitySubjects(
  subjects: readonly ProviderParityReplaySubject[]
): ProviderParityReplaySubject[] {
  const normalized = subjects.map((subject) => {
    const address = subject.address.trim();
    if (!address) throw new Error("Parity replay subjects must have an address.");
    if (subject.role !== "WINNER" && subject.role !== "CONTROL") {
      throw new Error("Parity replay subjects must have a winner or control role.");
    }
    const sourceRank30d = normalizedRank(subject.sourceRank30d, "30-day rank");
    const sourceRank90d = normalizedRank(subject.sourceRank90d, "90-day rank");
    if (subject.role === "WINNER" && sourceRank30d === undefined && sourceRank90d === undefined) {
      throw new Error(`Winner ${address} must retain at least one source rank.`);
    }
    return {
      address,
      role: subject.role,
      ...(sourceRank30d !== undefined ? { sourceRank30d } : {}),
      ...(sourceRank90d !== undefined ? { sourceRank90d } : {})
    };
  }).sort((left, right) => left.address.localeCompare(right.address));
  if (new Set(normalized.map((subject) => subject.address)).size !== normalized.length) {
    throw new Error("Parity replay subjects must be unique.");
  }
  return normalized;
}

export function providerParityManifestDigest(input: {
  endpointFingerprint: string;
  windowStartAt: string;
  windowEndAt: string;
  cutoffAt: string;
  controlPopulationAvailable: boolean;
  subjects: readonly ProviderParityReplaySubject[];
}): string {
  return parityDigest({
    version: 1,
    endpointFingerprint: input.endpointFingerprint,
    windowStartAt: input.windowStartAt,
    windowEndAt: input.windowEndAt,
    cutoffAt: input.cutoffAt,
    controlPopulationAvailable: input.controlPopulationAvailable,
    subjects: normalizeProviderParitySubjects(input.subjects)
  });
}

export function prepareProviderParityProofEpoch(
  input: PrepareProviderParityProofEpochInput
): ProviderParityProofEpoch {
  assertDigest(input.endpointFingerprint, "Endpoint fingerprint");
  const start = assertIso(input.windowStartAt, "Replay window start");
  const end = assertIso(input.windowEndAt, "Replay window end");
  const cutoff = assertIso(input.cutoffAt, "Replay cutoff");
  assertIso(input.createdAt, "Proof creation time");
  if (start >= end) throw new Error("Replay window start must be before its end.");
  if (end !== cutoff) {
    throw new Error("Replay window end and cutoff must be the same immutable instant.");
  }
  const subjects = normalizeProviderParitySubjects(input.subjects);
  if (subjects.length < MINIMUM_PROVIDER_PARITY_REPLAY_SUBJECTS) {
    throw new Error(`Parity replay needs at least ${MINIMUM_PROVIDER_PARITY_REPLAY_SUBJECTS} frozen subjects.`);
  }
  if (!subjects.some((subject) => subject.role === "WINNER")) {
    throw new Error("Parity replay needs at least one winner subject.");
  }
  if (input.controlPopulationAvailable && !subjects.some((subject) => subject.role === "CONTROL")) {
    throw new Error("Parity replay must retain a control when controls are available.");
  }
  const manifestDigest = providerParityManifestDigest({ ...input, subjects });
  return {
    id: input.id ?? `provider-parity-proof:${randomUUID()}`,
    status: "PREPARED",
    endpointFingerprint: input.endpointFingerprint,
    windowStartAt: input.windowStartAt,
    windowEndAt: input.windowEndAt,
    cutoffAt: input.cutoffAt,
    controlPopulationAvailable: input.controlPopulationAvailable,
    subjects,
    manifestDigest,
    createdAt: input.createdAt
  };
}

function observationResult(observation: ProviderParityObservation): unknown {
  return {
    capability: observation.capability,
    subject: observation.subject,
    observedAt: observation.observedAt,
    status: observation.status,
    metrics: observation.metrics,
    reasons: observation.reasons,
    primary: observation.primary,
    ...(observation.shadow !== undefined ? { shadow: observation.shadow } : {}),
    ...(observation.evidence ? { evidence: observation.evidence } : {})
  };
}

function sortedUniqueStrings(values: readonly string[], label: string): string[] {
  const normalized = [...values];
  if (normalized.some((value) => typeof value !== "string" || !value.trim())) {
    throw new Error(`${label} must contain non-empty strings.`);
  }
  normalized.sort();
  if (new Set(normalized).size !== normalized.length) throw new Error(`${label} must be unique.`);
  return normalized;
}

function subjectAddresses(epoch: ProviderParityProofEpoch): Set<string> {
  return new Set(epoch.subjects.map((subject) => subject.address));
}

function leaderSwapFrom(value: unknown): LeaderSwap | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Partial<LeaderSwap>;
  return typeof record.sourceWallet === "string" && typeof record.sourceSignature === "string"
    ? record as LeaderSwap
    : undefined;
}

function leaderSwapsFrom(value: unknown): LeaderSwap[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const swaps = value.map(leaderSwapFrom);
  return swaps.every((swap): swap is LeaderSwap => swap !== undefined) ? swaps : undefined;
}

function discoverySetFrom(value: unknown): DiscoveredWalletSet | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as { cohortId?: unknown; generatedAt?: unknown; candidates?: unknown };
  const candidates = record.candidates;
  if (!Array.isArray(candidates)) return undefined;
  const typed = candidates.filter((candidate): candidate is WalletCandidate =>
    candidate !== null && typeof candidate === "object" &&
    typeof (candidate as Partial<WalletCandidate>).address === "string" &&
    typeof (candidate as Partial<WalletCandidate>).control === "boolean"
  );
  return typed.length === candidates.length &&
    typeof record.cohortId === "string" && typeof record.generatedAt === "string"
    ? { cohortId: record.cohortId, generatedAt: record.generatedAt, candidates: typed }
    : undefined;
}

function assertProofInput(
  epoch: ProviderParityProofEpoch,
  observation: ProviderParityObservation,
  input: ProviderParityProofInput
): void {
  const subjects = subjectAddresses(epoch);
  if (input.kind !== "HEALTH" && input.kind !== "LIVE") {
    const primaryAt = assertIso(input.primaryAcquiredAt, "Managed acquisition time");
    const shadowAt = assertIso(input.shadowAcquiredAt, "Self-hosted acquisition time");
    const preparedAt = assertIso(epoch.createdAt, "Proof preparation time");
    if (primaryAt < preparedAt || shadowAt < preparedAt) {
      throw new Error("Parity acquisition cannot predate the frozen manifest.");
    }
    const expectedSkew = Math.abs(primaryAt - shadowAt);
    if (!Number.isSafeInteger(input.acquisitionSkewMs) || input.acquisitionSkewMs !== expectedSkew) {
      throw new Error("Parity acquisition skew does not match the recorded timestamps.");
    }
    if (input.acquisitionSkewMs > MAXIMUM_PROVIDER_PARITY_CAPTURE_SKEW_MS) {
      throw new Error("Parity acquisition skew exceeds five seconds.");
    }
    if (observation.observedAt !== epoch.cutoffAt) {
      throw new Error("Frozen replay observations must be stamped with the immutable cutoff.");
    }
  }
  switch (observation.capability) {
    case "WALLET_DISCOVERY": {
      if (input.kind !== "DISCOVERY") throw new Error("Discovery proof input is missing.");
      if (input.cutoffAt !== epoch.cutoffAt) throw new Error("Discovery cutoff does not match the proof epoch.");
      for (const digest of [
        input.primaryUniverseDigest,
        input.shadowUniverseDigest,
        input.sharedPrimaryDigest,
        input.sharedShadowDigest
      ]) assertDigest(digest, "Discovery universe digest");
      const shared = sortedUniqueStrings(input.sharedAddresses, "Shared discovery addresses");
      if (![...subjects].every((subject) => shared.includes(subject))) {
        throw new Error("Discovery proof does not cover every frozen replay subject.");
      }
      if (input.sharedPrimaryDigest !== input.sharedShadowDigest) {
        throw new Error("Shared discovery ranks or control lanes do not match.");
      }
      if (
        observation.evidence?.primaryGeneratedAt !== epoch.cutoffAt ||
        observation.evidence?.shadowGeneratedAt !== epoch.cutoffAt ||
        observation.evidence?.primaryUniverseDigest !== input.primaryUniverseDigest ||
        observation.evidence?.shadowUniverseDigest !== input.shadowUniverseDigest ||
        observation.evidence?.sharedPrimaryDigest !== input.sharedPrimaryDigest ||
        observation.evidence?.sharedShadowDigest !== input.sharedShadowDigest ||
        canonicalJson(observation.evidence?.sharedAddresses) !== canonicalJson(shared)
      ) throw new Error("Discovery proof input does not match its retained universe evidence.");
      const primarySet = discoverySetFrom(observation.primary);
      const shadowSet = discoverySetFrom(observation.shadow);
      if (!primarySet || !shadowSet) {
        throw new Error("Discovery proof must retain both candidate universes.");
      }
      const actualUniverse = providerParityDiscoveryEvidence(primarySet, shadowSet);
      if (
        actualUniverse.primaryUniverseDigest !== input.primaryUniverseDigest ||
        actualUniverse.shadowUniverseDigest !== input.shadowUniverseDigest ||
        actualUniverse.sharedPrimaryDigest !== input.sharedPrimaryDigest ||
        actualUniverse.sharedShadowDigest !== input.sharedShadowDigest ||
        canonicalJson(actualUniverse.sharedAddresses) !== canonicalJson(shared)
      ) throw new Error("Discovery universe digests do not match the retained candidates.");
      const primaryCandidates = new Map(primarySet.candidates.map((candidate) => [candidate.address, candidate]));
      const shadowCandidates = new Map(shadowSet.candidates.map((candidate) => [candidate.address, candidate]));
      for (const subject of epoch.subjects) {
        const primaryCandidate = primaryCandidates.get(subject.address);
        const shadowCandidate = shadowCandidates.get(subject.address);
        const expectedControl = subject.role === "CONTROL";
        if (
          !primaryCandidate || !shadowCandidate ||
          primaryCandidate.control !== expectedControl ||
          shadowCandidate.control !== expectedControl ||
          primaryCandidate.sourceRank30d !== subject.sourceRank30d ||
          shadowCandidate.sourceRank30d !== subject.sourceRank30d ||
          primaryCandidate.sourceRank90d !== subject.sourceRank90d ||
          shadowCandidate.sourceRank90d !== subject.sourceRank90d
        ) throw new Error("Discovery proof subject ranks or control lanes differ from the frozen manifest.");
      }
      break;
    }
    case "WALLET_PNL_30D":
    case "WALLET_PNL_90D": {
      if (input.kind !== "PNL") throw new Error("PnL proof input is missing.");
      const duration = observation.capability === "WALLET_PNL_30D" ? "30d" : "90d";
      if (input.wallet !== observation.subject || !subjects.has(input.wallet) || input.duration !== duration) {
        throw new Error("PnL proof subject or duration is outside the frozen manifest.");
      }
      const expectedStart = new Date(Date.parse(epoch.cutoffAt) - (duration === "30d" ? 30 : 90) * 86_400_000).toISOString();
      if (
        input.windowStartAt !== expectedStart ||
        input.windowEndAt !== epoch.windowEndAt ||
        input.cutoffAt !== epoch.cutoffAt
      ) throw new Error("PnL proof uses a mixed or rolling window.");
      if (
        observation.evidence?.duration !== duration ||
        observation.evidence?.asOfAt !== epoch.cutoffAt
      ) throw new Error("PnL proof does not retain an exact cutoff.");
      break;
    }
    case "CHAIN_HISTORY": {
      if (input.kind !== "HISTORY") throw new Error("History proof input is missing.");
      if (
        input.wallet !== observation.subject ||
        !subjects.has(input.wallet) ||
        input.days !== 90 ||
        input.windowStartAt !== epoch.windowStartAt ||
        input.windowEndAt !== epoch.windowEndAt ||
        input.cutoffAt !== epoch.cutoffAt
      ) throw new Error("History proof uses a mixed subject or replay window.");
      if (
        observation.evidence?.days !== "90" ||
        observation.evidence?.asOfAt !== epoch.cutoffAt
      ) throw new Error("History proof does not retain an exact cutoff.");
      break;
    }
    case "CHAIN_GAP": {
      if (input.kind !== "GAP") throw new Error("Gap proof input is missing.");
      if (
        input.wallet !== observation.subject ||
        !subjects.has(input.wallet) ||
        input.sinceAt !== epoch.windowStartAt ||
        input.cutoffAt !== epoch.cutoffAt
      ) throw new Error("Gap proof uses a mixed subject or replay window.");
      const primarySignatures = sortedUniqueStrings(input.primarySignatures, "Managed gap signatures");
      const shadowSignatures = sortedUniqueStrings(input.shadowSignatures, "Self-hosted gap signatures");
      if (primarySignatures.length === 0 || shadowSignatures.length === 0) {
        throw new Error("Gap replay proof requires non-empty signature coverage from both providers.");
      }
      if (canonicalJson(primarySignatures) !== canonicalJson(shadowSignatures)) {
        throw new Error("Gap replay signature coverage differs between providers.");
      }
      const primary = leaderSwapsFrom(observation.primary);
      const shadow = leaderSwapsFrom(observation.shadow);
      if (!primary || !shadow) throw new Error("Gap replay proof must retain both result arrays.");
      const sinceMs = Date.parse(input.sinceAt);
      const cutoffMs = Date.parse(input.cutoffAt);
      if ([...primary, ...shadow].some((swap) => {
        const at = Date.parse(swap.blockTime);
        return swap.sourceWallet !== input.wallet || !Number.isFinite(at) || at < sinceMs || at > cutoffMs;
      })) throw new Error("Gap replay proof contains a signal outside its frozen boundaries.");
      const primaryResultSignatures = sortedUniqueStrings(
        [...new Set(primary.map((swap) => swap.sourceSignature))],
        "Managed gap result signatures"
      );
      const shadowResultSignatures = sortedUniqueStrings(
        [...new Set(shadow.map((swap) => swap.sourceSignature))],
        "Self-hosted gap result signatures"
      );
      if (
        canonicalJson(primaryResultSignatures) !== canonicalJson(primarySignatures) ||
        canonicalJson(shadowResultSignatures) !== canonicalJson(shadowSignatures)
      ) throw new Error("Gap proof signature metadata does not match the retained results.");
      if (
        observation.evidence?.sinceAt !== input.sinceAt ||
        observation.evidence?.cutoffAt !== input.cutoffAt ||
        canonicalJson(observation.evidence?.primarySignatures) !== canonicalJson(primarySignatures) ||
        canonicalJson(observation.evidence?.shadowSignatures) !== canonicalJson(shadowSignatures)
      ) throw new Error("Gap proof input does not match its retained coverage evidence.");
      break;
    }
    case "CHAIN_HEALTH":
      if (input.kind !== "HEALTH" || input.observedAt !== observation.observedAt) {
        throw new Error("Health proof input does not match its observation.");
      }
      break;
    case "CHAIN_LIVE": {
      if (input.kind !== "LIVE" || !subjects.has(input.wallet)) {
        throw new Error("Live proof input is outside the frozen subject set.");
      }
      const swap = leaderSwapFrom(observation.primary) ?? leaderSwapFrom(observation.shadow);
      if (!swap || swap.sourceWallet !== input.wallet || swap.sourceSignature !== input.signature) {
        throw new Error("Live proof input does not match the retained signal.");
      }
      break;
    }
  }
}

export function bindProviderParityObservation(
  epoch: ProviderParityProofEpoch,
  observation: ProviderParityObservation,
  input: ProviderParityProofInput
): ProviderParityObservation {
  if (epoch.status !== "PREPARED" && epoch.status !== "ACTIVE") {
    throw new Error("Invalidated parity proof epochs cannot receive evidence.");
  }
  if (providerParityManifestDigest(epoch) !== epoch.manifestDigest) {
    throw new Error("Parity proof manifest digest does not match its immutable fields.");
  }
  assertIso(observation.observedAt, "Parity observation time");
  assertProofInput(epoch, observation, input);
  const proof: ProviderParityProofBinding = {
    proofEpochId: epoch.id,
    endpointFingerprint: epoch.endpointFingerprint,
    windowStartAt: epoch.windowStartAt,
    windowEndAt: epoch.windowEndAt,
    cutoffAt: epoch.cutoffAt,
    manifestDigest: epoch.manifestDigest,
    input,
    inputDigest: parityDigest(input),
    resultDigest: parityDigest(observationResult(observation))
  };
  return { ...observation, proof };
}

export function verifyBoundProviderParityObservation(
  epoch: ProviderParityProofEpoch,
  observation: ProviderParityObservation
): { ok: true } | { ok: false; reason: string } {
  try {
    const proof = observation.proof;
    if (!proof) throw new Error("observation is not bound to a proof epoch");
    if (
      proof.proofEpochId !== epoch.id ||
      proof.endpointFingerprint !== epoch.endpointFingerprint ||
      proof.windowStartAt !== epoch.windowStartAt ||
      proof.windowEndAt !== epoch.windowEndAt ||
      proof.cutoffAt !== epoch.cutoffAt ||
      proof.manifestDigest !== epoch.manifestDigest
    ) throw new Error("observation proof metadata does not match the active epoch");
    if (providerParityManifestDigest(epoch) !== epoch.manifestDigest) {
      throw new Error("active manifest digest is invalid");
    }
    assertProofInput(epoch, observation, proof.input);
    if (proof.inputDigest !== parityDigest(proof.input)) throw new Error("input digest is invalid");
    if (proof.resultDigest !== parityDigest(observationResult(observation))) {
      throw new Error("result digest is invalid");
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export function providerParitySubjectsFromCandidates(
  candidates: readonly WalletCandidate[]
): ProviderParityReplaySubject[] {
  return normalizeProviderParitySubjects(candidates.map((candidate) => ({
    address: candidate.address,
    role: candidate.control ? "CONTROL" : "WINNER",
    ...(candidate.sourceRank30d !== undefined ? { sourceRank30d: candidate.sourceRank30d } : {}),
    ...(candidate.sourceRank90d !== undefined ? { sourceRank90d: candidate.sourceRank90d } : {})
  })));
}

function liveProofInput(observation: ProviderParityObservation): ProviderParityProofInput | undefined {
  const swap = leaderSwapFrom(observation.primary) ?? leaderSwapFrom(observation.shadow);
  if (!swap) return undefined;
  return { kind: "LIVE", wallet: swap.sourceWallet, signature: swap.sourceSignature };
}

/**
 * Production sink for ordinary runtime observations. Only continuous health
 * and live-signal evidence can be safely bound without a same-cutoff replay
 * coordinator. Discovery/PnL/history/gap calls remain audit-only unless a
 * future coordinator explicitly calls `recordFrozen` with complete inputs.
 */
export class DurableProviderParitySink implements ProviderParitySink {
  constructor(
    private readonly store: ProviderParityProofStore,
    private readonly profile: () => DataProviderProfile
  ) {}

  record(observation: ProviderParityObservation): void {
    const profile = this.profile();
    const endpointFingerprint = dataProviderEndpointFingerprint(profile);
    const epoch = profile.mode === "SHADOW" && endpointFingerprint
      ? this.store.activeProviderParityProofEpoch(endpointFingerprint)
      : undefined;
    if (!epoch) {
      this.store.saveProviderParityObservation(observation);
      return;
    }
    const input = observation.capability === "CHAIN_HEALTH"
      ? { kind: "HEALTH" as const, observedAt: observation.observedAt }
      : observation.capability === "CHAIN_LIVE"
        ? liveProofInput(observation)
        : undefined;
    if (!input) {
      this.store.saveProviderParityObservation(observation);
      return;
    }
    try {
      this.store.saveProviderParityObservation(bindProviderParityObservation(epoch, observation, input));
    } catch {
      // Evidence outside the frozen subject set is still useful operationally,
      // but can never silently become promotion proof.
      this.store.saveProviderParityObservation(observation);
    }
  }

  recordFrozen(
    proofEpochId: string,
    observation: ProviderParityObservation,
    input: ProviderParityProofInput
  ): number {
    const epoch = this.store.providerParityProofEpoch(proofEpochId);
    if (!epoch) throw new Error("Parity proof epoch does not exist.");
    const profile = this.profile();
    const endpointFingerprint = dataProviderEndpointFingerprint(profile);
    if (profile.mode !== "SHADOW" || endpointFingerprint !== epoch.endpointFingerprint) {
      throw new Error("Frozen parity evidence does not match the active SHADOW endpoints.");
    }
    return this.store.saveProviderParityObservation(bindProviderParityObservation(epoch, observation, input));
  }
}
