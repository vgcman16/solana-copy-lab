import type {
  DataProviderProfile,
  SelfHostedPaperSoakHealth,
  SelfHostedPaperSoakSummary,
  WalletIndexCheckpoint
} from "@copylab/shared";
import { dataProviderEndpointFingerprint } from "./provider-rpc-readiness.js";

const DAY_MS = 86_400_000;
export const SELF_HOSTED_PAPER_SOAK_REQUIRED_DAYS = 7;
export const SELF_HOSTED_PAPER_SOAK_MAXIMUM_GAP_MS = 15 * 60_000;
export const SELF_HOSTED_PAPER_SOAK_MAXIMUM_AGE_MS = 10 * 60_000;

export interface SelfHostedPaperSoakEpoch {
  id: string;
  endpointFingerprint: string;
  startedAt: string;
  status: "ACTIVE" | "RESET";
  endedAt?: string;
  resetReason?: string;
}

export interface SelfHostedPaperSoakHeartbeat {
  id: number;
  epochId?: string;
  endpointFingerprint: string;
  observedAt: string;
  healthy: boolean;
  health: SelfHostedPaperSoakHealth;
}

export interface SelfHostedPaperSoakHeartbeatInput {
  endpointFingerprint: string;
  observedAt: string;
  health: SelfHostedPaperSoakHealth;
}

export interface SelfHostedPaperSoakStore {
  activeSelfHostedPaperSoakEpoch(endpointFingerprint?: string): SelfHostedPaperSoakEpoch | undefined;
  listSelfHostedPaperSoakHeartbeats(epochId: string): SelfHostedPaperSoakHeartbeat[];
  latestSelfHostedPaperSoakHeartbeat(endpointFingerprint: string): SelfHostedPaperSoakHeartbeat | undefined;
}

function finiteTime(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function selfHostedEndpointFingerprint(profile: DataProviderProfile): string | undefined {
  return profile.mode === "SELF_HOSTED" ? dataProviderEndpointFingerprint(profile) : undefined;
}

export function completeFreshIndexHeadCoverage(
  checkpoints: readonly WalletIndexCheckpoint[],
  programIds: ReadonlySet<string>,
  observedAt: Date
): boolean {
  if (programIds.size === 0) return false;
  const byProgram = new Map(checkpoints.map((checkpoint) => [checkpoint.partition, checkpoint]));
  return [...programIds].every((programId) => {
    const checkpoint = byProgram.get(programId);
    if (!checkpoint) return false;
    const updatedAt = Date.parse(checkpoint.updatedAt);
    const ageMs = observedAt.getTime() - updatedAt;
    const coverageStartSlot = checkpoint.metadata?.coverageStartSlot;
    const coverageEndSlot = checkpoint.metadata?.coverageEndSlot;
    return Number.isFinite(updatedAt) &&
      ageMs >= 0 && ageMs <= SELF_HOSTED_PAPER_SOAK_MAXIMUM_AGE_MS &&
      typeof coverageStartSlot === "number" &&
      Number.isSafeInteger(coverageStartSlot) &&
      coverageStartSlot >= 0 &&
      typeof coverageEndSlot === "number" &&
      Number.isSafeInteger(coverageEndSlot) &&
      coverageEndSlot >= coverageStartSlot &&
      checkpoint.slot === coverageEndSlot &&
      checkpoint.cursor === undefined &&
      checkpoint.beforeSignature === undefined &&
      // A managed forward-only reseed is safe for a not-yet-started managed
      // paper cohort, but it is not proof of self-hosted historical parity.
      typeof checkpoint.metadata?.gapReason !== "string";
  });
}

export function inactiveSelfHostedPaperSoak(): SelfHostedPaperSoakSummary {
  return {
    active: false,
    ready: false,
    requiredDays: SELF_HOSTED_PAPER_SOAK_REQUIRED_DAYS,
    elapsedDays: 0,
    heartbeatCount: 0,
    blockers: ["the self-hosted PAPER soak starts only after SELF_HOSTED becomes active"]
  };
}

export function calculateSelfHostedPaperSoakStatus(
  store: SelfHostedPaperSoakStore,
  profile: DataProviderProfile,
  now = new Date()
): SelfHostedPaperSoakSummary {
  const endpointFingerprint = selfHostedEndpointFingerprint(profile);
  if (!endpointFingerprint) return inactiveSelfHostedPaperSoak();

  const epoch = store.activeSelfHostedPaperSoakEpoch(endpointFingerprint);
  const heartbeats = epoch ? store.listSelfHostedPaperSoakHeartbeats(epoch.id) : [];
  const latest = heartbeats.at(-1) ?? store.latestSelfHostedPaperSoakHeartbeat(endpointFingerprint);
  const blockers: string[] = [];
  if (!epoch) blockers.push("no healthy self-hosted PAPER soak is active for these endpoints");

  const times = heartbeats
    .filter((heartbeat) => heartbeat.healthy)
    .map((heartbeat) => Date.parse(heartbeat.observedAt))
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  let largestGapMs = 0;
  for (let index = 1; index < times.length; index += 1) {
    largestGapMs = Math.max(largestGapMs, (times[index] ?? 0) - (times[index - 1] ?? 0));
  }
  const firstAt = times[0] ?? finiteTime(epoch?.startedAt);
  const latestAt = times.at(-1);
  const elapsedDays = firstAt === undefined || latestAt === undefined
    ? 0
    : Math.max(0, (latestAt - firstAt) / DAY_MS);

  if (elapsedDays < SELF_HOSTED_PAPER_SOAK_REQUIRED_DAYS) {
    blockers.push(`self-hosted PAPER soak needs ${SELF_HOSTED_PAPER_SOAK_REQUIRED_DAYS} continuous days`);
  }
  if (latestAt === undefined || now.getTime() - latestAt > SELF_HOSTED_PAPER_SOAK_MAXIMUM_AGE_MS) {
    blockers.push("self-hosted PAPER soak heartbeat is stale");
  }
  if (latestAt !== undefined && latestAt > now.getTime()) {
    blockers.push("self-hosted PAPER soak heartbeat is dated in the future");
  }
  if (largestGapMs > SELF_HOSTED_PAPER_SOAK_MAXIMUM_GAP_MS) {
    blockers.push("self-hosted PAPER soak contains a heartbeat gap longer than fifteen minutes");
  }
  if (latest) {
    if (!latest.health.discovery) blockers.push("local wallet discovery is unhealthy");
    if (!latest.health.chain) blockers.push("self-hosted Solana chain access is unhealthy");
    if (!latest.health.index) blockers.push("local wallet indexing is unhealthy");
    if (!latest.health.price) blockers.push("local SOL/USD price coverage is unhealthy");
  }

  return {
    active: Boolean(epoch),
    ready: blockers.length === 0,
    requiredDays: SELF_HOSTED_PAPER_SOAK_REQUIRED_DAYS,
    elapsedDays,
    heartbeatCount: heartbeats.length,
    ...(epoch ? { startedAt: epoch.startedAt } : {}),
    ...(latestAt !== undefined ? { latestHeartbeatAt: new Date(latestAt).toISOString() } : {}),
    ...(times.length > 1 ? { largestGapSeconds: largestGapMs / 1_000 } : {}),
    ...(latest ? { latestHealth: latest.health } : {}),
    blockers
  };
}
