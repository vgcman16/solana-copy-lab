import { describe, expect, it } from "vitest";
import { SOL_MINT, type LeaderSwap } from "@copylab/shared";
import { openDatabase } from "../src/database.js";
import { Repository } from "../src/repository.js";
import type { ProviderParityObservation } from "../src/provider-parity.js";
import { compareGapResults } from "../src/chain-provider-parity.js";
import {
  bindProviderParityObservation,
  DurableProviderParitySink,
  providerParityDiscoveryEvidence,
  prepareProviderParityProofEpoch,
  providerParityManifestDigest,
  type ProviderParityProofEpoch,
  type ProviderParityProofInput,
  type ProviderParityReplaySubject
} from "../src/provider-parity-proof.js";
import { dataProviderEndpointFingerprint } from "../src/provider-rpc-readiness.js";

const CUTOFF = "2026-07-10T12:00:00.000Z";
const START = "2026-04-11T12:00:00.000Z";
const FINGERPRINT = "b".repeat(64);
const ACQUISITION = {
  primaryAcquiredAt: CUTOFF,
  shadowAcquiredAt: CUTOFF,
  acquisitionSkewMs: 0
} as const;
const SUBJECTS: ProviderParityReplaySubject[] = [
  { address: "winner-1", role: "WINNER", sourceRank30d: 1, sourceRank90d: 2 },
  { address: "winner-2", role: "WINNER", sourceRank30d: 2, sourceRank90d: 1 },
  { address: "winner-3", role: "WINNER", sourceRank30d: 3 },
  { address: "winner-4", role: "WINNER", sourceRank90d: 3 },
  { address: "control-1", role: "CONTROL" }
];

function raw(
  capability: ProviderParityObservation["capability"],
  subject: string,
  overrides: Partial<ProviderParityObservation> = {}
): ProviderParityObservation {
  return {
    capability,
    subject,
    observedAt: CUTOFF,
    status: "MATCH",
    metrics: {},
    reasons: [],
    primary: {},
    shadow: {},
    ...overrides
  };
}

function swap(wallet: string, signature: string): LeaderSwap {
  return {
    sourceSignature: signature,
    sourceWallet: wallet,
    slot: 1,
    blockTime: "2026-07-01T12:00:00.000Z",
    detectedAt: "2026-07-01T12:00:01.000Z",
    side: "BUY",
    baseMint: SOL_MINT,
    targetMint: "target",
    baseAmountAtomic: "1",
    targetAmountAtomic: "2",
    baseAmountUi: 1,
    targetAmountUi: 2,
    leaderPriceUsd: 1,
    recovered: true
  };
}

function prepared(id = "proof"): ProviderParityProofEpoch {
  return prepareProviderParityProofEpoch({
    id,
    endpointFingerprint: FINGERPRINT,
    windowStartAt: START,
    windowEndAt: CUTOFF,
    cutoffAt: CUTOFF,
    controlPopulationAvailable: true,
    subjects: SUBJECTS,
    createdAt: CUTOFF
  });
}

function baseline(epoch: ProviderParityProofEpoch): ProviderParityObservation[] {
  const primary = {
    cohortId: "managed",
    generatedAt: CUTOFF,
    candidates: SUBJECTS.map((subject) => ({
      address: subject.address,
      cohortId: "managed",
      firstSeenAt: START,
      lastSeenAt: CUTOFF,
      control: subject.role === "CONTROL",
      tags: [],
      ...(subject.sourceRank30d !== undefined ? { sourceRank30d: subject.sourceRank30d } : {}),
      ...(subject.sourceRank90d !== undefined ? { sourceRank90d: subject.sourceRank90d } : {})
    }))
  };
  const shadow = {
    cohortId: "local",
    generatedAt: CUTOFF,
    candidates: primary.candidates.map((candidate) => ({ ...candidate, cohortId: "local" }))
  };
  const universe = providerParityDiscoveryEvidence(primary, shadow);
  const discoveryInput: ProviderParityProofInput = {
    kind: "DISCOVERY",
    ...ACQUISITION,
    cutoffAt: CUTOFF,
    ...universe
  };
  const observations = [bindProviderParityObservation(epoch, raw("WALLET_DISCOVERY", "managed|local", {
    primary,
    shadow,
    evidence: {
      primaryGeneratedAt: CUTOFF,
      shadowGeneratedAt: CUTOFF,
      ...universe
    }
  }), discoveryInput)];
  for (const subject of SUBJECTS) {
    for (const duration of ["30d", "90d"] as const) {
      const capability = duration === "30d" ? "WALLET_PNL_30D" as const : "WALLET_PNL_90D" as const;
      observations.push(bindProviderParityObservation(epoch, raw(capability, subject.address, {
        evidence: { duration, asOfAt: CUTOFF }
      }), {
        kind: "PNL",
        ...ACQUISITION,
        wallet: subject.address,
        duration,
        windowStartAt: duration === "30d" ? "2026-06-10T12:00:00.000Z" : START,
        windowEndAt: CUTOFF,
        cutoffAt: CUTOFF
      }));
    }
    observations.push(bindProviderParityObservation(epoch, raw("CHAIN_HISTORY", subject.address, {
      evidence: { days: "90", asOfAt: CUTOFF }
    }), {
      kind: "HISTORY",
      ...ACQUISITION,
      wallet: subject.address,
      days: 90,
      windowStartAt: START,
      windowEndAt: CUTOFF,
      cutoffAt: CUTOFF
    }));
    const signature = `${subject.address}-signature`;
    observations.push(bindProviderParityObservation(epoch, raw("CHAIN_GAP", subject.address, {
      primary: [swap(subject.address, signature)],
      shadow: [swap(subject.address, signature)],
      evidence: {
        sinceAt: START,
        cutoffAt: CUTOFF,
        primarySignatures: [signature],
        shadowSignatures: [signature]
      }
    }), {
      kind: "GAP",
      ...ACQUISITION,
      wallet: subject.address,
      sinceAt: START,
      cutoffAt: CUTOFF,
      primarySignatures: [signature],
      shadowSignatures: [signature]
    }));
  }
  return observations;
}

describe("frozen provider parity proof", () => {
  it("produces the same manifest digest regardless of subject input order", () => {
    const left = prepared("left");
    const right = prepareProviderParityProofEpoch({
      id: "right",
      endpointFingerprint: FINGERPRINT,
      windowStartAt: START,
      windowEndAt: CUTOFF,
      cutoffAt: CUTOFF,
      controlPopulationAvailable: true,
      subjects: [...SUBJECTS].reverse(),
      createdAt: CUTOFF
    });
    expect(left.manifestDigest).toBe(right.manifestDigest);
    expect(left.manifestDigest).toBe(providerParityManifestDigest(left));
  });

  it("rejects undersized, unstratified, or rolling manifests", () => {
    expect(() => prepareProviderParityProofEpoch({
      endpointFingerprint: FINGERPRINT,
      windowStartAt: START,
      windowEndAt: CUTOFF,
      cutoffAt: CUTOFF,
      controlPopulationAvailable: true,
      subjects: SUBJECTS.slice(0, 4),
      createdAt: CUTOFF
    })).toThrow(/at least 5/u);
    expect(() => prepareProviderParityProofEpoch({
      endpointFingerprint: FINGERPRINT,
      windowStartAt: START,
      windowEndAt: CUTOFF,
      cutoffAt: CUTOFF,
      controlPopulationAvailable: true,
      subjects: SUBJECTS.slice(0, 4).concat({ address: "winner-5", role: "WINNER", sourceRank30d: 5 }),
      createdAt: CUTOFF
    })).toThrow(/retain a control/u);
    expect(() => prepareProviderParityProofEpoch({
      endpointFingerprint: FINGERPRINT,
      windowStartAt: START,
      windowEndAt: "2026-07-10T11:59:59.000Z",
      cutoffAt: CUTOFF,
      controlPopulationAvailable: true,
      subjects: SUBJECTS,
      createdAt: CUTOFF
    })).toThrow(/same immutable instant/u);
  });

  it("never treats empty gap arrays as replay proof", () => {
    const comparison = compareGapResults("winner-1", [], [], CUTOFF, START, CUTOFF);
    expect(comparison).toMatchObject({
      status: "DIVERGENT",
      reasons: ["gap replay has no non-empty signature coverage"]
    });
    expect(() => bindProviderParityObservation(prepared(), comparison, {
      kind: "GAP",
      ...ACQUISITION,
      wallet: "winner-1",
      sinceAt: START,
      cutoffAt: CUTOFF,
      primarySignatures: [],
      shadowSignatures: []
    })).toThrow(/non-empty signature coverage/u);
  });

  it("rejects falsified or excessive acquisition skew", () => {
    const epoch = prepared();
    const observation = baseline(epoch)[0]!;
    const input = observation.proof!.input;
    expect(input.kind).toBe("DISCOVERY");
    if (input.kind !== "DISCOVERY") throw new Error("test fixture is not discovery proof");
    expect(() => bindProviderParityObservation(epoch, observation, {
      ...input,
      shadowAcquiredAt: "2026-07-10T12:00:06.000Z",
      acquisitionSkewMs: 6_000
    })).toThrow(/exceeds five seconds/u);
    expect(() => bindProviderParityObservation(epoch, observation, {
      ...input,
      shadowAcquiredAt: "2026-07-10T12:00:01.000Z",
      acquisitionSkewMs: 0
    })).toThrow(/does not match/u);
  });

  it("persists only verified bindings and activates only a complete same-cutoff baseline", () => {
    const db = openDatabase(":memory:");
    try {
      const repository = new Repository(db);
      const epoch = repository.prepareProviderParityProofEpoch({
        id: "durable-proof",
        endpointFingerprint: FINGERPRINT,
        windowStartAt: START,
        windowEndAt: CUTOFF,
        cutoffAt: CUTOFF,
        controlPopulationAvailable: true,
        subjects: SUBJECTS,
        createdAt: CUTOFF
      });
      expect(() => repository.activateProviderParityProofEpoch(epoch.id, CUTOFF)).toThrow(/baseline is incomplete/u);

      const observations = baseline(epoch);
      for (const observation of observations) repository.saveProviderParityObservation(observation);
      const tampered = { ...observations[1]!, metrics: { changed: 1 } };
      expect(() => repository.saveProviderParityObservation(tampered)).toThrow(/result digest is invalid/u);

      const captureRun = {
        id: "atomic-capture-run",
        status: "CAPTURING" as const,
        requestedAt: CUTOFF,
        updatedAt: CUTOFF,
        proofEpochId: epoch.id,
        endpointFingerprint: epoch.endpointFingerprint,
        windowStartAt: epoch.windowStartAt,
        cutoffAt: epoch.cutoffAt,
        subjects: epoch.subjects,
        blockers: [],
        acquisitions: observations.map((observation) => ({
          capability: observation.capability,
          subject: observation.subject,
          primaryAcquiredAt: (observation.proof!.input as typeof ACQUISITION).primaryAcquiredAt,
          shadowAcquiredAt: (observation.proof!.input as typeof ACQUISITION).shadowAcquiredAt,
          acquisitionSkewMs: (observation.proof!.input as typeof ACQUISITION).acquisitionSkewMs,
          inputDigest: observation.proof!.inputDigest,
          resultDigest: observation.proof!.resultDigest
        }))
      };
      repository.saveProviderParityBaselineRun(captureRun);
      db.exec(`
        CREATE TRIGGER fail_atomic_parity_activation
        BEFORE UPDATE ON provider_parity_baseline_runs
        WHEN NEW.status = 'ACTIVE'
        BEGIN
          SELECT RAISE(ABORT, 'simulated run update failure');
        END;
      `);
      expect(() => repository.activateProviderParityProofEpochWithRun(epoch.id, captureRun, CUTOFF))
        .toThrow(/simulated run update failure/u);
      expect(repository.providerParityProofEpoch(epoch.id)?.status).toBe("PREPARED");
      expect(repository.providerParityBaselineRun(captureRun.id)?.status).toBe("CAPTURING");
      db.exec("DROP TRIGGER fail_atomic_parity_activation");
      const activation = repository.activateProviderParityProofEpochWithRun(epoch.id, captureRun, CUTOFF);
      const active = activation.epoch;
      expect(active.status).toBe("ACTIVE");
      expect(activation.run.status).toBe("ACTIVE");
      expect(repository.listProviderParityObservationsForProofEpoch(epoch.id)).toHaveLength(observations.length);
      expect(new Repository(db).activeProviderParityProofEpoch(FINGERPRINT)).toEqual(active);
      expect(db.pragma("user_version", { simple: true })).toBeGreaterThanOrEqual(18);
    } finally {
      db.close();
    }
  });

  it("does not attach a foreign epoch to an otherwise valid observation", () => {
    const epoch = prepared();
    const observation = baseline(epoch)[1]!;
    const foreign = { ...epoch, endpointFingerprint: "c".repeat(64) };
    expect(() => bindProviderParityObservation(foreign, observation, observation.proof!.input))
      .toThrow(/manifest digest/u);
  });

  it("binds only continuous runtime evidence and leaves rolling replay calls audit-only", () => {
    const db = openDatabase(":memory:");
    try {
      const repository = new Repository(db);
      const profile = {
        mode: "SHADOW" as const,
        solanaHttpUrl: "https://rpc.example.test",
        solanaWsUrl: "wss://rpc.example.test"
      };
      const fingerprint = dataProviderEndpointFingerprint(profile)!;
      const epoch = repository.prepareProviderParityProofEpoch({
        id: "runtime-proof",
        endpointFingerprint: fingerprint,
        windowStartAt: START,
        windowEndAt: CUTOFF,
        cutoffAt: CUTOFF,
        controlPopulationAvailable: true,
        subjects: SUBJECTS,
        createdAt: CUTOFF
      });
      for (const observation of baseline(epoch)) repository.saveProviderParityObservation(observation);
      repository.activateProviderParityProofEpoch(epoch.id, CUTOFF);

      const sink = new DurableProviderParitySink(repository, () => profile);
      sink.record(raw("CHAIN_HEALTH", "chain", { observedAt: "2026-07-10T12:01:00.000Z" }));
      sink.record(raw("WALLET_PNL_30D", "winner-1", {
        observedAt: "2026-07-10T12:01:00.000Z",
        evidence: { duration: "30d", asOfAt: "2026-07-10T12:01:00.000Z" }
      }));

      const all = repository.listProviderParityObservations(2);
      expect(all[0]?.capability).toBe("WALLET_PNL_30D");
      expect(all[0]?.proof).toBeUndefined();
      expect(all[1]).toMatchObject({ capability: "CHAIN_HEALTH", proof: { proofEpochId: epoch.id } });
    } finally {
      db.close();
    }
  });
});
