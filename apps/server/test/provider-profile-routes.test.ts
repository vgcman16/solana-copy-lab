import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  SOL_MINT,
  type DataProviderProfile,
  type DataProviderStatus,
  type LeaderSwap,
  type PositionLot,
  type ProviderHealth
} from "@copylab/shared";
import { AppService } from "../src/app-service.js";
import { buildApp } from "../src/app.js";
import type { CopyLabDatabase } from "../src/database.js";
import { openDatabase } from "../src/database.js";
import { EventBus } from "../src/events.js";
import { ModeManager } from "../src/mode.js";
import type { ProviderParityObservation } from "../src/provider-parity.js";
import { Repository } from "../src/repository.js";
import { SecretVault } from "../src/vault.js";
import { WalletManager } from "../src/wallet.js";
import { MockRuntime } from "./helpers.js";
import {
  RPC_READINESS_SETTING,
  dataProviderEndpointFingerprint
} from "../src/provider-rpc-readiness.js";
import {
  EMERGENCY_EXIT_RPC_STATUS_SETTING,
  emergencyExitRpcEndpointFingerprint
} from "../src/emergency-exit-rpc.js";
import {
  bindProviderParityObservation,
  providerParityDiscoveryEvidence,
  type ProviderParityBaselineAcquisition,
  type ProviderParityProofInput
} from "../src/provider-parity-proof.js";

const SHADOW_EVIDENCE_SETTING = "data_provider_shadow_evidence_started_at";
const DAY_MS = 86_400_000;
const SHADOW_A: DataProviderProfile = {
  mode: "SHADOW",
  solanaHttpUrl: "https://rpc-a.example.test/private/key?token=a",
  solanaWsUrl: "wss://rpc-a.example.test/private/key?token=a",
  emergencySolanaHttpUrl: "https://exit-a.example.test/private/key?token=a"
};
const SHADOW_B: DataProviderProfile = {
  mode: "SHADOW",
  solanaHttpUrl: "https://rpc-b.example.test/private/key?token=b",
  solanaWsUrl: "wss://rpc-b.example.test/private/key?token=b",
  emergencySolanaHttpUrl: "https://exit-b.example.test/private/key?token=b"
};

class ControlledRuntime extends MockRuntime {
  profileHealth: ProviderHealth = {
    provider: "helius",
    ok: true,
    checkedAt: new Date().toISOString(),
    latencyMs: 1,
    message: "validated"
  };
  readonly validatedProfiles: DataProviderProfile[] = [];
  readonly profilesAtChange: DataProviderProfile[] = [];
  profileChangeCalls = 0;
  failProfileChangeCalls = new Set<number>();
  validationBarrier?: Promise<void>;
  validationEntered?: () => void;
  profileChangeBarrier?: Promise<void>;
  profileChangeEntered?: () => void;
  quiesceBarrier?: Promise<void>;
  quiesceEntered?: () => void;
  profileReader?: () => DataProviderProfile;
  readonly transitionOrder: string[] = [];
  readonly profilesAtResume: DataProviderProfile[] = [];

  override async validateDataProviderProfile(profile: DataProviderProfile): Promise<ProviderHealth> {
    this.validatedProfiles.push({ ...profile });
    this.validationEntered?.();
    await this.validationBarrier;
    return { ...this.profileHealth };
  }

  override async dataProviderProfileChanged(): Promise<void> {
    this.profileChangeCalls += 1;
    if (this.profileReader) this.profilesAtChange.push({ ...this.profileReader() });
    this.transitionOrder.push(`change:${this.profileReader?.().mode ?? "unknown"}`);
    if (this.failProfileChangeCalls.has(this.profileChangeCalls)) {
      throw new Error("simulated provider reconfiguration failure");
    }
    this.profileChangeEntered?.();
    await this.profileChangeBarrier;
  }

  override async quiesceProviderWork(): Promise<void> {
    this.transitionOrder.push("quiesce");
    await super.quiesceProviderWork();
    this.quiesceEntered?.();
    await this.quiesceBarrier;
  }

  override async resumeProviderWork(): Promise<void> {
    this.transitionOrder.push(`resume:${this.profileReader?.().mode ?? "unknown"}`);
    if (this.profileReader) this.profilesAtResume.push({ ...this.profileReader() });
    await super.resumeProviderWork();
  }
}

interface Harness {
  app: FastifyInstance;
  repository: Repository;
  vault: SecretVault;
  modes: ModeManager;
  events: EventBus;
  runtime: ControlledRuntime;
  service: AppService;
}

function position(id: string, mode: "PAPER" | "LIVE", status: "OPEN" | "CLOSING" = "OPEN"): PositionLot {
  return {
    id,
    mode,
    sourceWallet: "leader-wallet",
    sourceEntrySignature: `${id}-entry`,
    mint: SOL_MINT,
    openedAt: new Date().toISOString(),
    entryAmountAtomic: "1000",
    remainingAmountAtomic: "1000",
    entryCostUsd: 5,
    remainingCostUsd: 5,
    lastExecutableValueUsd: 5,
    pendingExitFraction: 0,
    status
  };
}

function matchingObservation(
  capability: ProviderParityObservation["capability"],
  subject: string,
  observedAt: string,
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

function seedReadyShadowEvidence(repository: Repository, now = Date.now()): void {
  const oldEvidenceAt = new Date(now - 8 * DAY_MS).toISOString();
  const latestEvidenceAt = new Date(now - 60_000).toISOString();
  const proofWindowStart = new Date(Date.parse(oldEvidenceAt) - 90 * DAY_MS).toISOString();
  const subjects = Array.from({ length: 5 }, (_, index) => ({
    address: `wallet-${index + 1}`,
    role: index === 4 ? "CONTROL" as const : "WINNER" as const,
    ...(index === 4 ? {} : { sourceRank30d: index + 1, sourceRank90d: index + 1 })
  }));
  const epoch = repository.prepareProviderParityProofEpoch({
    endpointFingerprint: dataProviderEndpointFingerprint(SHADOW_A)!,
    windowStartAt: proofWindowStart,
    windowEndAt: oldEvidenceAt,
    cutoffAt: oldEvidenceAt,
    controlPopulationAvailable: true,
    subjects,
    createdAt: oldEvidenceAt
  });
  const acquisition = {
    primaryAcquiredAt: oldEvidenceAt,
    shadowAcquiredAt: oldEvidenceAt,
    acquisitionSkewMs: 0
  } as const;
  const baselineAcquisitions: ProviderParityBaselineAcquisition[] = [];
  const saveBound = (
    observation: ProviderParityObservation,
    input: ProviderParityProofInput
  ): void => {
    const bound = bindProviderParityObservation(epoch, observation, input);
    repository.saveProviderParityObservation(bound);
    if (input.kind !== "HEALTH" && input.kind !== "LIVE") {
      baselineAcquisitions.push({
        capability: bound.capability,
        subject: bound.subject,
        primaryAcquiredAt: input.primaryAcquiredAt,
        shadowAcquiredAt: input.shadowAcquiredAt,
        acquisitionSkewMs: input.acquisitionSkewMs,
        inputDigest: bound.proof!.inputDigest,
        resultDigest: bound.proof!.resultDigest
      });
    }
  };
  const sourceSwap = (wallet: string, signature: string, at: string): LeaderSwap => ({
    sourceSignature: signature,
    sourceWallet: wallet,
    slot: 1,
    blockTime: at,
    detectedAt: at,
    side: "BUY",
    baseMint: SOL_MINT,
    targetMint: "target-mint",
    baseAmountAtomic: "1",
    targetAmountAtomic: "2",
    baseAmountUi: 1,
    targetAmountUi: 2,
    leaderPriceUsd: 1,
    recovered: true
  });
  repository.setSetting(SHADOW_EVIDENCE_SETTING, new Date(now - 9 * DAY_MS).toISOString());
  repository.setSetting(RPC_READINESS_SETTING, {
    endpointFingerprint: dataProviderEndpointFingerprint(SHADOW_A),
    checkedAt: latestEvidenceAt,
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
      capability,
      status: "PASS",
      latencyMs: 1,
      message: "passed",
      evidence: {}
    }))
  });
  repository.setSetting(EMERGENCY_EXIT_RPC_STATUS_SETTING, {
    configured: true,
    ok: true,
    checkedAt: latestEvidenceAt,
    message: "independent exit RPC passed",
    endpointFingerprint: emergencyExitRpcEndpointFingerprint(SHADOW_A.emergencySolanaHttpUrl!)
  });
  vi.spyOn(repository, "solPriceCoverage").mockReturnValue({
    count: 26_209,
    pendingSwapReprices: 0,
    outOfHorizonSwapReprices: 0,
    oldestAt: new Date(now - 91 * DAY_MS).toISOString(),
    newestAt: latestEvidenceAt,
    largestGapSeconds: 300
  });
  const primaryDiscovery = {
    cohortId: "managed",
    generatedAt: oldEvidenceAt,
    candidates: subjects.map((subject) => ({
      address: subject.address,
      cohortId: "managed",
      firstSeenAt: proofWindowStart,
      lastSeenAt: oldEvidenceAt,
      control: subject.role === "CONTROL",
      tags: [],
      ...(subject.sourceRank30d !== undefined ? { sourceRank30d: subject.sourceRank30d } : {}),
      ...(subject.sourceRank90d !== undefined ? { sourceRank90d: subject.sourceRank90d } : {})
    }))
  };
  const shadowDiscovery = {
    cohortId: "local",
    generatedAt: oldEvidenceAt,
    candidates: primaryDiscovery.candidates.map((candidate) => ({ ...candidate, cohortId: "local" }))
  };
  const universe = providerParityDiscoveryEvidence(primaryDiscovery, shadowDiscovery);
  saveBound({
    ...matchingObservation("WALLET_DISCOVERY", "cohort", oldEvidenceAt, { overlapCandidates: 5 }),
    primary: primaryDiscovery,
    shadow: shadowDiscovery,
    evidence: {
      primaryGeneratedAt: oldEvidenceAt,
      shadowGeneratedAt: oldEvidenceAt,
      ...universe
    }
  }, {
    kind: "DISCOVERY",
    ...acquisition,
    cutoffAt: oldEvidenceAt,
    ...universe
  });
  for (let index = 0; index < 5; index += 1) {
    const wallet = `wallet-${index + 1}`;
    for (const duration of ["30d", "90d"] as const) {
      const capability = duration === "30d" ? "WALLET_PNL_30D" as const : "WALLET_PNL_90D" as const;
      saveBound({
        ...matchingObservation(capability, wallet, oldEvidenceAt),
        evidence: { duration, asOfAt: oldEvidenceAt }
      }, {
        kind: "PNL",
        ...acquisition,
        wallet,
        duration,
        windowStartAt: new Date(Date.parse(oldEvidenceAt) - (duration === "30d" ? 30 : 90) * DAY_MS).toISOString(),
        windowEndAt: oldEvidenceAt,
        cutoffAt: oldEvidenceAt
      });
    }
    saveBound({
      ...matchingObservation("CHAIN_HISTORY", wallet, oldEvidenceAt),
      evidence: { days: "90", asOfAt: oldEvidenceAt }
    }, {
      kind: "HISTORY",
      ...acquisition,
      wallet,
      days: 90,
      windowStartAt: proofWindowStart,
      windowEndAt: oldEvidenceAt,
      cutoffAt: oldEvidenceAt
    });
    const signature = `${wallet}-gap-signature`;
    const gapAt = new Date(Date.parse(oldEvidenceAt) - DAY_MS).toISOString();
    saveBound({
      ...matchingObservation("CHAIN_GAP", wallet, oldEvidenceAt),
      primary: [sourceSwap(wallet, signature, gapAt)],
      shadow: [sourceSwap(wallet, signature, gapAt)],
      evidence: {
        sinceAt: proofWindowStart,
        cutoffAt: oldEvidenceAt,
        primarySignatures: [signature],
        shadowSignatures: [signature]
      }
    }, {
      kind: "GAP",
      ...acquisition,
      wallet,
      sinceAt: proofWindowStart,
      cutoffAt: oldEvidenceAt,
      primarySignatures: [signature],
      shadowSignatures: [signature]
    });
  }
  const captureRun = {
    id: `profile-ready-run:${epoch.id}`,
    status: "CAPTURING" as const,
    requestedAt: oldEvidenceAt,
    updatedAt: oldEvidenceAt,
    proofEpochId: epoch.id,
    endpointFingerprint: epoch.endpointFingerprint,
    windowStartAt: epoch.windowStartAt,
    cutoffAt: epoch.cutoffAt,
    subjects: epoch.subjects,
    blockers: [],
    acquisitions: baselineAcquisitions
  };
  repository.saveProviderParityBaselineRun(captureRun);
  repository.activateProviderParityProofEpochWithRun(epoch.id, captureRun, oldEvidenceAt);
  for (let at = Date.parse(oldEvidenceAt); at <= Date.parse(latestEvidenceAt); at += 10 * 60_000) {
    const observedAt = new Date(at).toISOString();
    saveBound(matchingObservation("CHAIN_HEALTH", "chain", observedAt), {
      kind: "HEALTH",
      observedAt
    });
  }
  saveBound(matchingObservation("CHAIN_HEALTH", "latest-chain", latestEvidenceAt), {
    kind: "HEALTH",
    observedAt: latestEvidenceAt
  });
  for (let index = 0; index < 25; index += 1) {
    const wallet = `wallet-${(index % 5) + 1}`;
    const signature = `signature-${index + 1}`;
    saveBound({
      ...matchingObservation("CHAIN_LIVE", `${wallet}:${signature}`, latestEvidenceAt),
      primary: sourceSwap(wallet, signature, latestEvidenceAt),
      shadow: sourceSwap(wallet, signature, latestEvidenceAt)
    }, { kind: "LIVE", wallet, signature });
  }
}

describe("data-provider profile API and transitions", () => {
  let db: CopyLabDatabase | undefined;
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
    db?.close();
    db = undefined;
  });

  async function setup(): Promise<Harness> {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const vault = new SecretVault(repository);
    const wallet = new WalletManager(vault, repository);
    const modes = new ModeManager(repository, wallet);
    const events = new EventBus();
    const runtime = new ControlledRuntime();
    const service = new AppService(repository, vault, wallet, modes, events, runtime);
    app = await buildApp(service);
    runtime.profileReader = () => vault.getDataProviderProfile();
    return { app, repository, vault, modes, events, runtime, service };
  }

  async function mutationHeaders(instance: FastifyInstance): Promise<Record<string, string>> {
    const csrf = await instance.inject({ method: "GET", url: "/api/security/csrf" });
    const token = csrf.json<{ csrfToken: string }>().csrfToken;
    const rawCookie = csrf.headers["set-cookie"];
    return {
      cookie: Array.isArray(rawCookie) ? rawCookie[0]! : rawCookie!,
      "x-csrf-token": token
    };
  }

  it("requires the local session, CSRF token, and exact typed confirmation", async () => {
    const { app: instance, runtime } = await setup();
    const denied = await instance.inject({
      method: "POST",
      url: "/api/provider/profile",
      payload: { mode: "MANAGED", confirmation: "USE MANAGED DATA" }
    });
    expect(denied.statusCode).toBe(403);

    const headers = await mutationHeaders(instance);
    for (const payload of [
      { mode: "MANAGED", confirmation: "use managed data" },
      { ...SHADOW_A, confirmation: "enable shadow data" },
      { ...SHADOW_A, mode: "SELF_HOSTED", confirmation: "ENABLE SHADOW DATA" },
      { mode: "MANAGED" }
    ]) {
      const response = await instance.inject({
        method: "POST",
        url: "/api/provider/profile",
        headers,
        payload
      });
      expect(response.statusCode).toBe(400);
    }
    expect(runtime.validatedProfiles).toHaveLength(0);
  });

  it.runIf(process.platform === "win32")("protects the explicit frozen parity capture with CSRF and exact confirmation", async () => {
    const { app: instance, repository, vault } = await setup();
    const initial = await instance.inject({ method: "GET", url: "/api/provider/parity-baseline" });
    expect(initial).toMatchObject({ statusCode: 200 });
    expect(initial.json()).toMatchObject({ status: "NOT_STARTED", acquisitions: [] });

    repository.setSetting("mode", "PAPER");
    vault.setDataProviderProfile(SHADOW_A);
    const denied = await instance.inject({
      method: "POST",
      url: "/api/provider/parity-baseline/capture",
      payload: { confirmation: "CAPTURE FROZEN PARITY BASELINE" }
    });
    expect(denied.statusCode).toBe(403);

    const headers = await mutationHeaders(instance);
    const wrong = await instance.inject({
      method: "POST",
      url: "/api/provider/parity-baseline/capture",
      headers,
      payload: { confirmation: "capture frozen parity baseline" }
    });
    expect(wrong.statusCode).toBe(400);

    const captured = await instance.inject({
      method: "POST",
      url: "/api/provider/parity-baseline/capture",
      headers,
      payload: { confirmation: "CAPTURE FROZEN PARITY BASELINE" }
    });
    expect(captured.statusCode).toBe(200);
    expect(captured.json()).toMatchObject({
      status: "BLOCKED",
      blockers: [{ code: "MANAGED_PNL_AS_OF_UNSUPPORTED" }],
      acquisitions: []
    });
  });

  it.runIf(process.platform === "win32")("returns only redacted endpoint origins", async () => {
    const { app: instance, vault } = await setup();
    vault.setDataProviderProfile({
      mode: "SHADOW",
      solanaHttpUrl: "https://rpc-user:rpc-password@rpc.example.test:8899/private/key?token=secret-http",
      solanaWsUrl: "wss://ws-user:ws-password@rpc.example.test:8900/private/key?token=secret-ws",
      emergencySolanaHttpUrl: "https://exit-user:exit-password@exit.example.test:8899/private/key?token=secret-exit"
    });
    const response = await instance.inject({ method: "GET", url: "/api/provider/profile" });
    expect(response.statusCode).toBe(200);
    expect(response.json<DataProviderStatus>().profile).toEqual({
      mode: "SHADOW",
      configured: true,
      httpOrigin: "https://rpc.example.test:8899",
      wsOrigin: "wss://rpc.example.test:8900",
      emergencyHttpOrigin: "https://exit.example.test:8899"
    });
    for (const secret of [
      "rpc-user", "rpc-password", "exit-user", "exit-password", "private/key",
      "secret-http", "secret-ws", "secret-exit"
    ]) {
      expect(response.body).not.toContain(secret);
    }
  });

  it.runIf(process.platform === "win32")("allows changes only in SETUP and PAPER", async () => {
    const { app: instance, repository, runtime } = await setup();
    const headers = await mutationHeaders(instance);
    const setupChange = await instance.inject({
      method: "POST",
      url: "/api/provider/profile",
      headers,
      payload: { ...SHADOW_A, confirmation: "ENABLE SHADOW DATA" }
    });
    expect(setupChange.statusCode).toBe(200);
    expect(setupChange.json<DataProviderStatus>().profile.mode).toBe("SHADOW");
    expect(Number.isFinite(Date.parse(repository.getSetting<string>(SHADOW_EVIDENCE_SETTING)!))).toBe(true);

    repository.setSetting("mode", "PAPER");
    const paperChange = await instance.inject({
      method: "POST",
      url: "/api/provider/profile",
      headers,
      payload: { mode: "MANAGED", confirmation: "USE MANAGED DATA" }
    });
    expect(paperChange.statusCode).toBe(200);
    expect(paperChange.json<DataProviderStatus>().profile.mode).toBe("MANAGED");

    for (const mode of ["MANUAL_LIVE", "AUTO_LIVE", "PAUSED", "LOCKED"] as const) {
      repository.setSetting("mode", mode);
      const blocked = await instance.inject({
        method: "POST",
        url: "/api/provider/profile",
        headers,
        payload: { mode: "MANAGED", confirmation: "USE MANAGED DATA" }
      });
      expect(blocked.statusCode).toBe(400);
      expect(blocked.json()).toMatchObject({ error: expect.stringContaining("only in SETUP or PAPER") });
    }
    expect(runtime.validatedProfiles).toHaveLength(2);
    expect(runtime.profileChangeCalls).toBe(2);
  });

  it("blocks both paper and live open positions before health validation", async () => {
    const { repository, runtime, service } = await setup();
    const paper = position("paper-open", "PAPER");
    repository.upsertPosition(paper);
    await expect(service.saveDataProviderProfile(SHADOW_A)).rejects.toThrow("Close every bot-created position");
    repository.upsertPosition({ ...paper, status: "CLOSED", closedAt: new Date().toISOString() });

    repository.upsertPosition(position("live-closing", "LIVE", "CLOSING"));
    await expect(service.saveDataProviderProfile(SHADOW_A)).rejects.toThrow("Close every bot-created position");
    expect(runtime.validatedProfiles).toHaveLength(0);
    expect(runtime.profileChangeCalls).toBe(0);
  });

  it("rejects unhealthy endpoints without saving or reconfiguring", async () => {
    const { repository, vault, runtime, service } = await setup();
    runtime.profileHealth = { ...runtime.profileHealth, ok: false, message: "RPC health probe failed" };
    await expect(service.saveDataProviderProfile(SHADOW_A)).rejects.toThrow(
      "Data-provider validation failed: RPC health probe failed"
    );
    expect(vault.getDataProviderProfile()).toEqual({ mode: "MANAGED" });
    expect(runtime.profileChangeCalls).toBe(0);
    expect(repository.listAudit(20)).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ eventType: "data_provider_profile_changed" })
    ]));
  });

  it.runIf(process.platform === "win32")(
    "keeps the prior profile visible until old provider work is quiesced",
    async () => {
      const { vault, runtime, service } = await setup();
      let releaseQuiesce!: () => void;
      let quiesceStarted!: () => void;
      runtime.quiesceBarrier = new Promise<void>((resolve) => { releaseQuiesce = resolve; });
      const started = new Promise<void>((resolve) => { quiesceStarted = resolve; });
      runtime.quiesceEntered = quiesceStarted;

      const saving = service.saveDataProviderProfile(SHADOW_A);
      await started;
      expect(vault.getDataProviderProfile()).toEqual({ mode: "MANAGED" });
      expect(runtime.profileChangeCalls).toBe(0);
      expect(runtime.providerWorkQuiesced).toBe(true);

      releaseQuiesce();
      await expect(saving).resolves.toMatchObject({ profile: { mode: "SHADOW" } });
      expect(runtime.transitionOrder).toEqual(["quiesce", "change:SHADOW", "resume:SHADOW"]);
      expect(runtime.providerQuiesceCalls).toBe(1);
      expect(runtime.providerResumeCalls).toBe(1);
      expect(runtime.profilesAtResume).toEqual([SHADOW_A]);
      expect(runtime.providerWorkQuiesced).toBe(false);
    }
  );

  it.runIf(process.platform === "win32")("blocks SELF_HOSTED until the active shadow evidence is ready", async () => {
    const { repository, vault, runtime, service } = await setup();
    vault.setDataProviderProfile(SHADOW_A);
    repository.setSetting(SHADOW_EVIDENCE_SETTING, new Date().toISOString());
    await expect(service.saveDataProviderProfile({ ...SHADOW_A, mode: "SELF_HOSTED" })).rejects.toThrow(
      "Self-hosted promotion is blocked"
    );
    expect(vault.getDataProviderProfile().mode).toBe("SHADOW");
    expect(runtime.validatedProfiles).toHaveLength(0);
  });

  it.runIf(process.platform === "win32")("requires the exact endpoints that produced ready SHADOW evidence", async () => {
    const { vault, repository, runtime, service } = await setup();
    vault.setDataProviderProfile(SHADOW_A);
    seedReadyShadowEvidence(repository);
    expect(service.dataProviderStatus()).toMatchObject({
      selfHostedReady: true,
      blockers: [],
      rpcReadiness: { ok: true, fullCapabilitiesOk: true, websocketOk: true }
    });

    await expect(service.saveDataProviderProfile({ ...SHADOW_B, mode: "SELF_HOSTED" })).rejects.toThrow(
      "exact primary, WebSocket, and emergency-exit endpoints"
    );
    expect(vault.getDataProviderProfile()).toMatchObject(SHADOW_A);
    expect(runtime.validatedProfiles).toHaveLength(0);
  });

  it.runIf(process.platform === "win32")("rechecks readiness instead of using cached display status for SELF_HOSTED promotion", async () => {
    const { vault, repository, runtime, service } = await setup();
    vault.setDataProviderProfile(SHADOW_A);
    seedReadyShadowEvidence(repository);
    expect(service.dataProviderStatus().selfHostedReady).toBe(true);

    repository.invalidateProviderParityProofEpochs(
      "test invalidated the active proof after display status was cached",
      new Date().toISOString()
    );
    await expect(service.saveDataProviderProfile({ ...SHADOW_A, mode: "SELF_HOSTED" })).rejects.toThrow(
      "Self-hosted promotion is blocked"
    );
    expect(vault.getDataProviderProfile()).toMatchObject(SHADOW_A);
    expect(runtime.validatedProfiles).toHaveLength(0);
  });

  it.runIf(process.platform === "win32")("cannot reuse endpoint A evidence after changing SHADOW to endpoint B", async () => {
    const { vault, repository, runtime, service } = await setup();
    vault.setDataProviderProfile(SHADOW_A);
    seedReadyShadowEvidence(repository);
    expect(service.dataProviderStatus().selfHostedReady).toBe(true);

    const previousCutoff = repository.getSetting<string>(SHADOW_EVIDENCE_SETTING)!;
    const status = await service.saveDataProviderProfile(SHADOW_B);
    const nextCutoff = repository.getSetting<string>(SHADOW_EVIDENCE_SETTING)!;
    expect(Date.parse(nextCutoff)).toBeGreaterThan(Date.parse(previousCutoff));
    expect(status).toMatchObject({ profile: { mode: "SHADOW" }, selfHostedReady: false });
    expect(status.parity.observations).toBe(0);
    expect(service.providerParityBaselineStatus()).toBeUndefined();

    await expect(service.saveDataProviderProfile({ ...SHADOW_B, mode: "SELF_HOSTED" })).rejects.toThrow(
      "Self-hosted promotion is blocked"
    );
    expect(runtime.validatedProfiles).toHaveLength(1);
    expect(vault.getDataProviderProfile()).toMatchObject(SHADOW_B);
  });

  it.runIf(process.platform === "win32")("restores the prior profile when runtime reconfiguration fails", async () => {
    const { vault, repository, events, runtime, service } = await setup();
    vault.setDataProviderProfile(SHADOW_A);
    const oldCutoff = new Date(Date.now() - DAY_MS).toISOString();
    repository.setSetting(SHADOW_EVIDENCE_SETTING, oldCutoff);
    runtime.failProfileChangeCalls.add(1);
    const publish = vi.spyOn(events, "publish");

    await expect(service.saveDataProviderProfile(SHADOW_B)).rejects.toThrow(
      "simulated provider reconfiguration failure"
    );
    expect(vault.getDataProviderProfile()).toMatchObject(SHADOW_A);
    expect(runtime.profileChangeCalls).toBe(2);
    expect(runtime.profilesAtChange).toEqual([SHADOW_B, SHADOW_A]);
    expect(runtime.transitionOrder).toEqual([
      "quiesce",
      "change:SHADOW",
      "change:SHADOW",
      "resume:SHADOW"
    ]);
    expect(runtime.providerQuiesceCalls).toBe(1);
    expect(runtime.providerResumeCalls).toBe(1);
    expect(runtime.profilesAtResume).toEqual([SHADOW_A]);
    expect(runtime.providerWorkQuiesced).toBe(false);
    expect(Date.parse(repository.getSetting<string>(SHADOW_EVIDENCE_SETTING)!)).toBeGreaterThan(
      Date.parse(oldCutoff)
    );
    expect(publish).not.toHaveBeenCalledWith("data-provider", expect.anything());
    expect(repository.listAudit(20)).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ eventType: "data_provider_profile_changed" })
    ]));
  });

  it.runIf(process.platform === "win32")(
    "stays quiesced when both profile reconfiguration and rollback fail",
    async () => {
      const { vault, repository, runtime, service } = await setup();
      vault.setDataProviderProfile(SHADOW_A);
      runtime.failProfileChangeCalls.add(1);
      runtime.failProfileChangeCalls.add(2);

      await expect(service.saveDataProviderProfile(SHADOW_B)).rejects.toThrow(
        "rollback stayed quiesced"
      );
      expect(vault.getDataProviderProfile()).toEqual(SHADOW_A);
      expect(runtime.profileChangeCalls).toBe(2);
      expect(runtime.providerQuiesceCalls).toBe(1);
      expect(runtime.providerResumeCalls).toBe(0);
      expect(runtime.providerWorkQuiesced).toBe(true);
      expect(repository.listAudit(20)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          eventType: "data_provider_profile_rollback_failed",
          severity: "critical"
        })
      ]));
    }
  );

  it.runIf(process.platform === "win32")("rechecks mode after asynchronous health validation", async () => {
    const { repository, vault, runtime, service } = await setup();
    let releaseValidation!: () => void;
    let validationStarted!: () => void;
    runtime.validationBarrier = new Promise<void>((resolve) => { releaseValidation = resolve; });
    const started = new Promise<void>((resolve) => { validationStarted = resolve; });
    runtime.validationEntered = validationStarted;

    const saving = service.saveDataProviderProfile(SHADOW_A);
    await started;
    repository.setSetting("mode", "MANUAL_LIVE");
    releaseValidation();

    await expect(saving).rejects.toThrow("only in SETUP or PAPER");
    expect(vault.getDataProviderProfile()).toEqual({ mode: "MANAGED" });
    expect(runtime.profileChangeCalls).toBe(0);
  });

  it.runIf(process.platform === "win32")("rechecks open positions after asynchronous health validation", async () => {
    const { repository, vault, runtime, service } = await setup();
    let releaseValidation!: () => void;
    let validationStarted!: () => void;
    runtime.validationBarrier = new Promise<void>((resolve) => { releaseValidation = resolve; });
    const started = new Promise<void>((resolve) => { validationStarted = resolve; });
    runtime.validationEntered = validationStarted;

    const saving = service.saveDataProviderProfile(SHADOW_A);
    await started;
    repository.upsertPosition(position("late-paper-position", "PAPER"));
    releaseValidation();

    await expect(saving).rejects.toThrow("Close every bot-created position");
    expect(vault.getDataProviderProfile()).toEqual({ mode: "MANAGED" });
    expect(runtime.profileChangeCalls).toBe(0);
  });

  it.runIf(process.platform === "win32")(
    "serializes concurrent profile changes across validation and reconfiguration",
    async () => {
      const { repository, vault, modes, events, runtime, service } = await setup();
      const peerService = new AppService(repository, vault, service.wallet, modes, events, runtime);
      let releaseFirstValidation!: () => void;
      let firstValidationStarted!: () => void;
      runtime.validationBarrier = new Promise<void>((resolve) => { releaseFirstValidation = resolve; });
      const started = new Promise<void>((resolve) => { firstValidationStarted = resolve; });
      runtime.validationEntered = firstValidationStarted;

      const first = service.saveDataProviderProfile(SHADOW_A);
      await started;
      const second = peerService.saveDataProviderProfile(SHADOW_B);
      try {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        expect(runtime.validatedProfiles).toEqual([SHADOW_A]);
        expect(runtime.profileChangeCalls).toBe(0);
      } finally {
        releaseFirstValidation();
      }

      await expect(Promise.all([first, second])).resolves.toHaveLength(2);
      expect(runtime.validatedProfiles).toEqual([SHADOW_A, SHADOW_B]);
      expect(runtime.profilesAtChange).toEqual([SHADOW_A, SHADOW_B]);
      expect(vault.getDataProviderProfile()).toEqual(SHADOW_B);
    }
  );

  it.runIf(process.platform === "win32")(
    "holds a mode transition until provider reconfiguration is fully committed",
    async () => {
      const { repository, vault, modes, runtime, service } = await setup();
      repository.setSetting("mode", "PAPER");
      let releaseReconfiguration!: () => void;
      let reconfigurationStarted!: () => void;
      runtime.profileChangeBarrier = new Promise<void>((resolve) => { releaseReconfiguration = resolve; });
      const started = new Promise<void>((resolve) => { reconfigurationStarted = resolve; });
      runtime.profileChangeEntered = reconfigurationStarted;
      const preflight = vi.spyOn(runtime, "preflightModeChange");

      const saving = service.saveDataProviderProfile(SHADOW_A);
      await started;
      const pausing = service.transitionMode("PAUSED");
      try {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        expect(vault.getDataProviderProfile()).toEqual(SHADOW_A);
        expect(modes.mode).toBe("PAPER");
        expect(preflight).not.toHaveBeenCalled();
      } finally {
        releaseReconfiguration();
      }

      await expect(saving).resolves.toMatchObject({ profile: { mode: "SHADOW" } });
      await expect(pausing).resolves.toBe("PAUSED");
      expect(preflight).toHaveBeenCalledOnce();
    }
  );

  it.runIf(process.platform === "win32")(
    "rejects a queued profile change after a concurrent mode transition leaves PAPER",
    async () => {
      const { repository, vault, runtime, service } = await setup();
      repository.setSetting("mode", "PAPER");
      let releasePreflight!: () => void;
      let preflightStarted!: () => void;
      const preflightBarrier = new Promise<void>((resolve) => { releasePreflight = resolve; });
      const started = new Promise<void>((resolve) => { preflightStarted = resolve; });
      vi.spyOn(runtime, "preflightModeChange").mockImplementation(async () => {
        preflightStarted();
        await preflightBarrier;
      });

      const pausing = service.transitionMode("PAUSED");
      await started;
      const saving = service.saveDataProviderProfile(SHADOW_A);
      try {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        expect(runtime.validatedProfiles).toHaveLength(0);
      } finally {
        releasePreflight();
      }

      await expect(pausing).resolves.toBe("PAUSED");
      await expect(saving).rejects.toThrow("only in SETUP or PAPER");
      expect(vault.getDataProviderProfile()).toEqual({ mode: "MANAGED" });
      expect(runtime.validatedProfiles).toHaveLength(0);
    }
  );
});
