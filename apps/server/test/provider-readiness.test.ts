import { describe, expect, it } from "vitest";
import type { ProviderParityObservation } from "../src/provider-parity.js";
import { calculateProviderReadiness } from "../src/provider-readiness.js";
import { SOL_MINT, type DataProviderRpcReadinessSummary, type LeaderSwap } from "@copylab/shared";
import {
  bindProviderParityObservation,
  providerParityDiscoveryEvidence,
  prepareProviderParityProofEpoch,
  type ProviderParityProofEpoch,
  type ProviderParityProofInput
} from "../src/provider-parity-proof.js";

const NOW = new Date("2026-07-10T12:00:00.000Z");
const DAY_MS = 86_400_000;
const ENDPOINT_FINGERPRINT = "a".repeat(64);
const WINDOW_START = new Date(NOW.getTime() - 90 * DAY_MS).toISOString();
const SUBJECTS = Array.from({ length: 5 }, (_, index) => ({
  address: `wallet-${index + 1}`,
  role: index === 4 ? "CONTROL" as const : "WINNER" as const,
  ...(index === 4 ? {} : { sourceRank30d: index + 1, sourceRank90d: index + 1 })
}));
const PREPARED = prepareProviderParityProofEpoch({
  id: "proof-epoch",
  endpointFingerprint: ENDPOINT_FINGERPRINT,
  windowStartAt: WINDOW_START,
  windowEndAt: NOW.toISOString(),
  cutoffAt: NOW.toISOString(),
  controlPopulationAvailable: true,
  subjects: SUBJECTS,
  createdAt: "2026-07-03T11:57:00.000Z"
});
const PROOF_EPOCH: ProviderParityProofEpoch = {
  ...PREPARED,
  status: "ACTIVE",
  activatedAt: "2026-07-03T11:58:00.000Z"
};
const ACTIVE_BASELINE_RUN = {
  id: "active-proof-run",
  status: "ACTIVE" as const,
  requestedAt: "2026-07-03T11:57:00.000Z",
  updatedAt: "2026-07-03T11:58:00.000Z",
  proofEpochId: PROOF_EPOCH.id,
  endpointFingerprint: ENDPOINT_FINGERPRINT,
  windowStartAt: WINDOW_START,
  cutoffAt: NOW.toISOString(),
  subjects: SUBJECTS,
  blockers: [],
  acquisitions: [],
  activatedAt: "2026-07-03T11:58:00.000Z"
};
const ACQUISITION = {
  primaryAcquiredAt: NOW.toISOString(),
  shadowAcquiredAt: NOW.toISOString(),
  acquisitionSkewMs: 0
} as const;

function proofContext(): Pick<
  Parameters<typeof calculateProviderReadiness>[0],
  "endpointFingerprint" | "proofEpoch" | "baselineRun"
> {
  return {
    endpointFingerprint: ENDPOINT_FINGERPRINT,
    proofEpoch: PROOF_EPOCH,
    baselineRun: ACTIVE_BASELINE_RUN
  };
}

function rpcReady(): DataProviderRpcReadinessSummary {
  return {
    checkedAt: NOW.toISOString(),
    ok: true,
    fullCapabilitiesOk: true,
    websocketOk: true,
    websocketLatencyMs: 1,
    websocketMessage: "confirmed subscription passed",
    minimumArchiveDays: 90,
    capabilities: [
      "GET_HEALTH",
      "CONFIRMED_HEAD",
      "ARCHIVE_HISTORY",
      "SIGNATURE_HISTORY",
      "FULL_TRANSACTION",
      "FULL_BLOCK",
      "BALANCE_READS"
    ].map((capability) => ({
      capability: capability as DataProviderRpcReadinessSummary["capabilities"][number]["capability"],
      status: "PASS" as const,
      latencyMs: 1,
      message: "passed",
      evidence: {}
    }))
  };
}

function observation(
  capability: ProviderParityObservation["capability"],
  subject: string,
  observedAt = "2026-07-10T11:59:00.000Z",
  metrics: Record<string, number> = {}
): ProviderParityObservation {
  return {
    capability,
    subject,
    observedAt,
    status: "MATCH",
    metrics,
    reasons: [],
    primary: {},
    shadow: {}
  };
}

function swap(wallet: string, signature: string): LeaderSwap {
  return {
    sourceSignature: signature,
    sourceWallet: wallet,
    slot: 1,
    blockTime: "2026-07-09T12:00:00.000Z",
    detectedAt: "2026-07-09T12:00:01.000Z",
    side: "BUY",
    baseMint: SOL_MINT,
    targetMint: "target-mint",
    baseAmountAtomic: "1",
    targetAmountAtomic: "2",
    baseAmountUi: 1,
    targetAmountUi: 2,
    leaderPriceUsd: 1,
    recovered: false
  };
}

function boundObservation(
  capability: ProviderParityObservation["capability"],
  subject: string,
  observedAt = NOW.toISOString(),
  metrics: Record<string, number> = {}
): ProviderParityObservation {
  let raw = observation(capability, subject, observedAt, metrics);
  let input: ProviderParityProofInput;
  if (capability === "WALLET_DISCOVERY") {
    const primary = {
      cohortId: "managed",
      generatedAt: NOW.toISOString(),
      candidates: SUBJECTS.map((entry) => ({
        address: entry.address,
        cohortId: "managed",
        firstSeenAt: WINDOW_START,
        lastSeenAt: NOW.toISOString(),
        control: entry.role === "CONTROL",
        tags: [],
        ...(entry.sourceRank30d !== undefined ? { sourceRank30d: entry.sourceRank30d } : {}),
        ...(entry.sourceRank90d !== undefined ? { sourceRank90d: entry.sourceRank90d } : {})
      }))
    };
    const shadow = {
      cohortId: "local",
      generatedAt: NOW.toISOString(),
      candidates: primary.candidates.map((candidate) => ({ ...candidate, cohortId: "local" }))
    };
    const universe = providerParityDiscoveryEvidence(primary, shadow);
    input = {
      kind: "DISCOVERY",
      ...ACQUISITION,
      cutoffAt: NOW.toISOString(),
      ...universe
    };
    raw = {
      ...raw,
      primary,
      shadow,
      evidence: {
        primaryGeneratedAt: NOW.toISOString(),
        shadowGeneratedAt: NOW.toISOString(),
        ...universe
      }
    };
  } else if (capability === "WALLET_PNL_30D" || capability === "WALLET_PNL_90D") {
    const duration = capability === "WALLET_PNL_30D" ? "30d" : "90d";
    input = {
      kind: "PNL",
      ...ACQUISITION,
      wallet: subject,
      duration,
      windowStartAt: new Date(NOW.getTime() - (duration === "30d" ? 30 : 90) * DAY_MS).toISOString(),
      windowEndAt: NOW.toISOString(),
      cutoffAt: NOW.toISOString()
    };
    raw = { ...raw, evidence: { duration, asOfAt: NOW.toISOString() } };
  } else if (capability === "CHAIN_HISTORY") {
    input = {
      kind: "HISTORY",
      ...ACQUISITION,
      wallet: subject,
      days: 90,
      windowStartAt: WINDOW_START,
      windowEndAt: NOW.toISOString(),
      cutoffAt: NOW.toISOString()
    };
    raw = { ...raw, evidence: { days: "90", asOfAt: NOW.toISOString() } };
  } else if (capability === "CHAIN_GAP") {
    const signature = `${subject}-gap-signature`;
    input = {
      kind: "GAP",
      ...ACQUISITION,
      wallet: subject,
      sinceAt: WINDOW_START,
      cutoffAt: NOW.toISOString(),
      primarySignatures: [signature],
      shadowSignatures: [signature]
    };
    raw = {
      ...raw,
      primary: [swap(subject, signature)],
      shadow: [swap(subject, signature)],
      evidence: {
        sinceAt: WINDOW_START,
        cutoffAt: NOW.toISOString(),
        primarySignatures: [signature],
        shadowSignatures: [signature]
      }
    };
  } else if (capability === "CHAIN_HEALTH") {
    input = { kind: "HEALTH", observedAt };
  } else {
    const separator = subject.indexOf(":");
    const wallet = subject.slice(0, separator);
    const signature = subject.slice(separator + 1);
    input = { kind: "LIVE", wallet, signature };
    raw = { ...raw, primary: swap(wallet, signature), shadow: swap(wallet, signature) };
  }
  return bindProviderParityObservation(PROOF_EPOCH, raw, input);
}

function continuousHealth(start: string, end: string): ProviderParityObservation[] {
  const rows: ProviderParityObservation[] = [];
  for (let at = Date.parse(start); at <= Date.parse(end); at += 10 * 60_000) {
    rows.push(boundObservation("CHAIN_HEALTH", "chain", new Date(at).toISOString()));
  }
  return rows;
}

function replayCoverage(observedAt = NOW.toISOString()): ProviderParityObservation[] {
  const wallets = Array.from({ length: 5 }, (_, index) => `wallet-${index + 1}`);
  const replay = wallets.flatMap((wallet) => [
    boundObservation("WALLET_PNL_30D", wallet, observedAt),
    boundObservation("WALLET_PNL_90D", wallet, observedAt),
    boundObservation("CHAIN_HISTORY", wallet, observedAt),
    boundObservation("CHAIN_GAP", wallet, observedAt)
  ]);
  const live = Array.from({ length: 25 }, (_, index) =>
    boundObservation("CHAIN_LIVE", `wallet-${(index % 5) + 1}:signature-${index + 1}`, observedAt)
  );
  return [...replay, ...live];
}

describe("provider readiness", () => {
  it("requires seven-day parity, all capabilities, and fresh 90-day prices", () => {
    const observations = [
      boundObservation("WALLET_DISCOVERY", "cohort", undefined, { overlapCandidates: 5 }),
      ...replayCoverage(),
      ...continuousHealth("2026-07-03T11:58:00.000Z", "2026-07-10T11:58:00.000Z")
    ];
    const result = calculateProviderReadiness({
      ...proofContext(),
      profile: {
        mode: "SHADOW",
        configured: true,
        httpOrigin: "http://127.0.0.1:8899",
        wsOrigin: "ws://127.0.0.1:8900"
      },
      priceCoverage: {
        count: 30_000,
        oldestAt: "2026-04-01T00:00:00.000Z",
        newestAt: "2026-07-10T11:58:00.000Z",
        largestGapSeconds: 300
      },
      observations,
      rpcReadiness: rpcReady(),
      emergencyExitRpc: {
        configured: true,
        ok: true,
        checkedAt: "2026-07-10T11:58:00.000Z",
        message: "independent exit RPC passed"
      },
      now: NOW
    });
    expect(result).toMatchObject({ selfHostedReady: true, blockers: [] });
    expect(result.parity).toMatchObject({
      commonReplayWallets: 5,
      matchedSubjectCounts: {
        WALLET_PNL_30D: 5,
        WALLET_PNL_90D: 5,
        CHAIN_HISTORY: 5,
        CHAIN_GAP: 5,
        CHAIN_LIVE: 25
      }
    });
  });

  it("excludes legacy, mixed-window, and digest-tampered rows even beside complete proof evidence", () => {
    const complete = [
      boundObservation("WALLET_DISCOVERY", "cohort", undefined, { overlapCandidates: 5 }),
      ...replayCoverage(),
      ...continuousHealth("2026-07-03T11:58:00.000Z", "2026-07-10T11:58:00.000Z")
    ];
    const valid = complete[1]!;
    const tampered = { ...valid, metrics: { tampered: 1 } };
    const legacy = observation("WALLET_PNL_30D", "wallet-1");
    const result = calculateProviderReadiness({
      ...proofContext(),
      profile: {
        mode: "SHADOW",
        configured: true,
        httpOrigin: "http://127.0.0.1:8899",
        wsOrigin: "ws://127.0.0.1:8900"
      },
      priceCoverage: {
        count: 30_000,
        oldestAt: "2026-04-01T00:00:00.000Z",
        newestAt: "2026-07-10T11:58:00.000Z",
        largestGapSeconds: 300
      },
      observations: [...complete, tampered, legacy],
      rpcReadiness: rpcReady(),
      emergencyExitRpc: {
        configured: true,
        ok: true,
        checkedAt: "2026-07-10T11:58:00.000Z",
        message: "independent exit RPC passed"
      },
      now: NOW
    });
    expect(result.selfHostedReady).toBe(false);
    expect(result.parity.invalidOrUnboundObservations).toBe(2);
    expect(result.blockers).toContain(
      "legacy, unbound, mixed-window, or digest-invalid parity observations were excluded"
    );
  });

  it("exposes machine-readable coordinator blockers while no proof epoch is active", () => {
    const result = calculateProviderReadiness({
      profile: {
        mode: "SHADOW",
        configured: true,
        httpOrigin: "http://127.0.0.1:8899",
        wsOrigin: "ws://127.0.0.1:8900"
      },
      endpointFingerprint: ENDPOINT_FINGERPRINT,
      proofCandidate: PREPARED,
      baselineRun: {
        id: "blocked-run",
        status: "BLOCKED",
        requestedAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
        proofEpochId: PREPARED.id,
        endpointFingerprint: ENDPOINT_FINGERPRINT,
        windowStartAt: WINDOW_START,
        cutoffAt: NOW.toISOString(),
        subjects: SUBJECTS,
        blockers: [{
          code: "MANAGED_PNL_AS_OF_UNSUPPORTED",
          message: "Managed wallet PnL cannot request an immutable closed interval."
        }],
        acquisitions: []
      },
      priceCoverage: { count: 0, pendingSwapReprices: 0 },
      observations: [],
      now: NOW
    });
    expect(result.selfHostedReady).toBe(false);
    expect(result.parity).toMatchObject({
      proofEpochStatus: "PREPARED",
      baselineRunId: "blocked-run",
      baselineRunStatus: "BLOCKED",
      baselineBlockerCodes: ["MANAGED_PNL_AS_OF_UNSUPPORTED"]
    });
    expect(result.blockers).toContain(
      "frozen parity baseline capture is blocked: managed_pnl_as_of_unsupported"
    );
  });

  it("keeps historical frozen replay evidence while applying activation time only to continuous evidence", () => {
    const activatedAfterCutoff: ProviderParityProofEpoch = {
      ...PROOF_EPOCH,
      activatedAt: "2026-07-10T12:00:30.000Z"
    };
    const observations = [
      boundObservation("WALLET_DISCOVERY", "cohort", NOW.toISOString(), { overlapCandidates: 5 }),
      ...replayCoverage(NOW.toISOString()).filter((entry) => entry.capability !== "CHAIN_LIVE"),
      boundObservation("CHAIN_HEALTH", "chain", "2026-07-10T12:00:40.000Z")
    ];
    const result = calculateProviderReadiness({
      profile: { mode: "SHADOW", configured: true },
      endpointFingerprint: ENDPOINT_FINGERPRINT,
      proofEpoch: activatedAfterCutoff,
      baselineRun: {
        ...ACTIVE_BASELINE_RUN,
        activatedAt: activatedAfterCutoff.activatedAt!,
        updatedAt: activatedAfterCutoff.activatedAt!
      },
      priceCoverage: { count: 0, pendingSwapReprices: 0 },
      observations,
      now: new Date("2026-07-10T12:01:00.000Z")
    });
    expect(result.parity.commonReplayWallets).toBe(5);
    expect(result.parity.matchedCapabilities).toEqual(expect.arrayContaining([
      "WALLET_DISCOVERY",
      "WALLET_PNL_30D",
      "WALLET_PNL_90D",
      "CHAIN_HISTORY",
      "CHAIN_GAP",
      "CHAIN_HEALTH"
    ]));
  });

  it("ignores a blocked run that does not own the active proof epoch", () => {
    const observations = [
      boundObservation("WALLET_DISCOVERY", "cohort", undefined, { overlapCandidates: 5 }),
      ...replayCoverage(),
      ...continuousHealth("2026-07-03T11:58:00.000Z", "2026-07-10T11:58:00.000Z")
    ];
    const result = calculateProviderReadiness({
      ...proofContext(),
      baselineRun: {
        id: "unrelated-blocked-run",
        status: "BLOCKED",
        requestedAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
        proofEpochId: "another-proof",
        blockers: [{ code: "MANAGED_PNL_AS_OF_UNSUPPORTED", message: "unrelated" }],
        acquisitions: []
      },
      profile: { mode: "SHADOW", configured: true },
      priceCoverage: {
        count: 30_000,
        pendingSwapReprices: 0,
        oldestAt: "2026-04-01T00:00:00.000Z",
        newestAt: "2026-07-10T11:58:00.000Z",
        largestGapSeconds: 300
      },
      observations,
      rpcReadiness: rpcReady(),
      emergencyExitRpc: {
        configured: true,
        ok: true,
        checkedAt: "2026-07-10T11:58:00.000Z",
        message: "independent exit RPC passed"
      },
      now: NOW
    });
    expect(result.selfHostedReady).toBe(false);
    expect(result.parity.baselineRunId).toBeUndefined();
    expect(result.blockers).toContain("active provider parity proof has no durable ACTIVE owning capture run");
    expect(result.blockers).not.toEqual(expect.arrayContaining([
      expect.stringContaining("frozen parity baseline capture is blocked")
    ]));
  });

  it("requires RPC capability evidence checked within the last ten minutes", () => {
    const staleRpcReadiness = rpcReady();
    staleRpcReadiness.checkedAt = "2026-07-10T11:49:59.000Z";
    const observations = [
      boundObservation("WALLET_DISCOVERY", "cohort", undefined, { overlapCandidates: 5 }),
      ...replayCoverage(),
      ...continuousHealth("2026-07-03T11:58:00.000Z", "2026-07-10T11:58:00.000Z")
    ];
    const result = calculateProviderReadiness({
      ...proofContext(),
      profile: {
        mode: "SHADOW",
        configured: true,
        httpOrigin: "http://127.0.0.1:8899",
        wsOrigin: "ws://127.0.0.1:8900"
      },
      priceCoverage: {
        count: 30_000,
        oldestAt: "2026-04-01T00:00:00.000Z",
        newestAt: "2026-07-10T11:58:00.000Z",
        largestGapSeconds: 300
      },
      observations,
      rpcReadiness: staleRpcReadiness,
      now: NOW
    });

    expect(result.selfHostedReady).toBe(false);
    expect(result.blockers).toContain("self-hosted RPC capability evidence is stale");
  });

  it("rejects superficial parity from only one replay wallet or live signal", () => {
    const observations = [
      boundObservation("WALLET_DISCOVERY", "cohort", undefined, { overlapCandidates: 5 }),
      boundObservation("WALLET_PNL_30D", "wallet-1"),
      boundObservation("WALLET_PNL_90D", "wallet-1"),
      boundObservation("CHAIN_HISTORY", "wallet-1"),
      boundObservation("CHAIN_GAP", "wallet-1"),
      boundObservation("CHAIN_LIVE", "wallet-1:signature-1"),
      ...continuousHealth("2026-07-03T11:58:00.000Z", "2026-07-10T11:58:00.000Z")
    ];
    const result = calculateProviderReadiness({
      ...proofContext(),
      profile: {
        mode: "SHADOW",
        configured: true,
        httpOrigin: "http://127.0.0.1:8899",
        wsOrigin: "ws://127.0.0.1:8900"
      },
      priceCoverage: {
        count: 30_000,
        oldestAt: "2026-04-01T00:00:00.000Z",
        newestAt: "2026-07-10T11:58:00.000Z",
        largestGapSeconds: 300
      },
      observations,
      rpcReadiness: rpcReady(),
      now: NOW
    });

    expect(result.selfHostedReady).toBe(false);
    expect(result.blockers).toEqual(expect.arrayContaining([
      expect.stringContaining("at least 5 wallets"),
      expect.stringContaining("at least 25 distinct")
    ]));
  });

  it("restarts the seven-day clock after a resolved divergence", () => {
    const oldHealth = continuousHealth("2026-07-01T11:58:00.000Z", "2026-07-10T11:58:00.000Z");
    const failureMatch = boundObservation("CHAIN_HEALTH", "chain", "2026-07-09T12:00:00.000Z");
    const failure = bindProviderParityObservation(PROOF_EPOCH, {
      ...failureMatch,
      status: "DIVERGENT",
      reasons: ["health differed"]
    }, failureMatch.proof!.input);
    const result = calculateProviderReadiness({
      ...proofContext(),
      profile: {
        mode: "SHADOW",
        configured: true,
        httpOrigin: "http://127.0.0.1:8899",
        wsOrigin: "ws://127.0.0.1:8900"
      },
      priceCoverage: {
        count: 30_000,
        oldestAt: "2026-04-01T00:00:00.000Z",
        newestAt: "2026-07-10T11:58:00.000Z",
        largestGapSeconds: 300
      },
      observations: [
        ...oldHealth,
        failure,
        boundObservation("CHAIN_HEALTH", "chain", "2026-07-10T11:58:00.000Z")
      ],
      now: NOW
    });

    expect(result.selfHostedReady).toBe(false);
    expect(result.parity.evidenceDays).toBeLessThan(2);
    expect(result.blockers).toContain("fewer than seven days of shadow parity evidence are complete");
  });

  it("rejects a seven-day span with a hidden monitoring outage", () => {
    const observations = continuousHealth("2026-07-03T11:58:00.000Z", "2026-07-10T11:58:00.000Z")
      .filter((entry) => {
        const at = Date.parse(entry.observedAt);
        return at < Date.parse("2026-07-07T00:00:00.000Z") || at > Date.parse("2026-07-07T01:00:00.000Z");
      });
    const result = calculateProviderReadiness({
      ...proofContext(),
      profile: {
        mode: "SHADOW",
        configured: true,
        httpOrigin: "http://127.0.0.1:8899",
        wsOrigin: "ws://127.0.0.1:8900"
      },
      priceCoverage: {
        count: 30_000,
        oldestAt: "2026-04-01T00:00:00.000Z",
        newestAt: "2026-07-10T11:58:00.000Z",
        largestGapSeconds: 300
      },
      observations,
      now: NOW
    });

    expect(result.blockers).toContain(
      "shadow chain-health evidence contains a monitoring gap longer than fifteen minutes"
    );
  });

  it("rejects sparse price endpoints that conceal an uncovered historical interval", () => {
    const result = calculateProviderReadiness({
      ...proofContext(),
      profile: {
        mode: "SHADOW",
        configured: true,
        httpOrigin: "http://127.0.0.1:8899",
        wsOrigin: "ws://127.0.0.1:8900"
      },
      priceCoverage: {
        count: 30_000,
        oldestAt: "2026-04-01T00:00:00.000Z",
        newestAt: "2026-07-10T11:58:00.000Z",
        largestGapSeconds: 601
      },
      observations: [],
      now: NOW
    });

    expect(result.selfHostedReady).toBe(false);
    expect(result.blockers).toContain("local SOL/USD price history contains a gap longer than ten minutes");
  });

  it("does not mistake subsecond price-capture jitter for a missing ten-minute interval", () => {
    const result = calculateProviderReadiness({
      ...proofContext(),
      profile: {
        mode: "SHADOW",
        configured: true,
        httpOrigin: "http://127.0.0.1:8899",
        wsOrigin: "ws://127.0.0.1:8900"
      },
      priceCoverage: {
        count: 30_000,
        oldestAt: "2026-04-01T00:00:00.000Z",
        newestAt: "2026-07-10T11:58:00.000Z",
        largestGapSeconds: 600.048
      },
      observations: [],
      now: NOW
    });

    expect(result.blockers).not.toContain("local SOL/USD price history contains a gap longer than ten minutes");
  });

  it("rejects nominal price coverage while SOL-legged swaps remain unpriced", () => {
    const result = calculateProviderReadiness({
      ...proofContext(),
      profile: {
        mode: "SHADOW",
        configured: true,
        httpOrigin: "http://127.0.0.1:8899",
        wsOrigin: "ws://127.0.0.1:8900"
      },
      priceCoverage: {
        count: 30_000,
        pendingSwapReprices: 2,
        oldestAt: "2026-04-01T00:00:00.000Z",
        newestAt: "2026-07-10T11:58:00.000Z",
        largestGapSeconds: 300
      },
      observations: [],
      now: NOW
    });

    expect(result.selfHostedReady).toBe(false);
    expect(result.blockers).toContain("2 SOL-legged indexed swaps still need historical USD prices");
  });

  it("exposes concise RPC capability blockers as dashboard readiness evidence", () => {
    const rpcReadiness = rpcReady();
    rpcReadiness.ok = false;
    rpcReadiness.fullCapabilitiesOk = false;
    rpcReadiness.capabilities = rpcReadiness.capabilities.map((capability) => capability.capability === "ARCHIVE_HISTORY"
      ? { ...capability, status: "FAIL", message: "archive too shallow" }
      : capability);
    const result = calculateProviderReadiness({
      ...proofContext(),
      profile: {
        mode: "SHADOW",
        configured: true,
        httpOrigin: "http://127.0.0.1:8899",
        wsOrigin: "ws://127.0.0.1:8900"
      },
      priceCoverage: { count: 0 },
      observations: [],
      rpcReadiness,
      now: NOW
    });

    expect(result.rpcReadiness).toEqual(rpcReadiness);
    expect(result.blockers).toContain("self-hosted RPC checks not ready: archive history");
  });

  it("keeps self-hosted promotion blocked on stale prices or a latest divergence", () => {
    const matching = boundObservation("CHAIN_LIVE", "wallet-1:signal", "2026-07-09T12:00:00.000Z");
    const divergent = bindProviderParityObservation(PROOF_EPOCH, {
      ...matching,
      observedAt: "2026-07-10T11:59:00.000Z",
      status: "DIVERGENT",
      reasons: ["missed"]
    }, matching.proof!.input);
    const result = calculateProviderReadiness({
      ...proofContext(),
      profile: { mode: "MANAGED", configured: true },
      priceCoverage: { count: 1, oldestAt: "2026-07-01T00:00:00.000Z", newestAt: "2026-07-01T00:00:00.000Z" },
      observations: [divergent, matching],
      now: NOW
    });
    expect(result.selfHostedReady).toBe(false);
    expect(result.blockers).toEqual(expect.arrayContaining([
      expect.stringContaining("shadow mode"),
      expect.stringContaining("90 days"),
      expect.stringContaining("stale"),
      expect.stringContaining("divergences")
    ]));
  });
});
