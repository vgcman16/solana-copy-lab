import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SOL_MINT,
  USDC_MINT,
  type LeaderSwap,
  type QuoteSnapshot,
  type RejectedSourceAction,
  type RiskDecision,
  type TokenEligibility
} from "@copylab/shared";
import type { CopyLabDatabase } from "../src/database.js";
import { openDatabase } from "../src/database.js";
import { EventBus } from "../src/events.js";
import { ModeManager } from "../src/mode.js";
import { Repository } from "../src/repository.js";
import { TradingRuntime } from "../src/runtime.js";
import { SecretVault } from "../src/vault.js";
import { DpapiTransactionSigner, WalletManager } from "../src/wallet.js";

interface RejectedSwapObservation {
  action: RejectedSourceAction;
  researchAction: {
    kind: "UNSUPPORTED_ROUTE_RESEARCH_ONLY";
    source: RejectedSourceAction;
    baseAmountAtomic: string;
    targetAmountAtomic: string;
    baseAmountUi: number;
    targetAmountUi: number;
  };
  reason: string;
}

interface RuntimeHarness {
  emergencyActive: boolean;
  providers: unknown;
  monitoringRepairPending(): boolean;
  activeWalletAllowed(wallet: string): boolean;
  getToken(mint: string): Promise<TokenEligibility>;
  evaluateOrderRisk(): Promise<RiskDecision>;
  getSolPriceUsd(): Promise<number>;
  applyExecution(): Promise<void>;
  handleSwap(swap: LeaderSwap): Promise<void>;
  processBuy(swap: LeaderSwap): Promise<void>;
  queueProviderRejectedSwap(rejection: RejectedSwapObservation): Promise<void>;
}

function source(index: number, overrides: Partial<LeaderSwap> = {}): LeaderSwap {
  const now = new Date();
  return {
    sourceSignature: `source-${index}`,
    sourceWallet: "leader-wallet",
    slot: index,
    blockTime: now.toISOString(),
    detectedAt: now.toISOString(),
    side: "BUY",
    baseMint: USDC_MINT,
    targetMint: SOL_MINT,
    baseAmountAtomic: "1000000",
    targetAmountAtomic: "10000000",
    baseAmountUi: 1,
    targetAmountUi: 0.01,
    leaderPriceUsd: 100,
    recovered: false,
    ...overrides
  };
}

function quote(requestId: string, inputMint = USDC_MINT): QuoteSnapshot {
  return {
    requestId,
    quotedAt: new Date().toISOString(),
    inputMint,
    outputMint: inputMint === USDC_MINT ? SOL_MINT : USDC_MINT,
    inputAmountAtomic: "1000000",
    outputAmountAtomic: "10000000",
    inputUsd: 1,
    outputUsd: 0.99,
    priceImpactPercent: 0.1,
    slippageBps: 10,
    feeBps: 5,
    signatureFeeLamports: 5000,
    prioritizationFeeLamports: 0,
    rentFeeLamports: 0,
    minimumOutputAtomic: "9900000",
    router: "iris"
  };
}

describe("structured signal outcomes", () => {
  let db: CopyLabDatabase | undefined;
  let runtime: TradingRuntime | undefined;

  afterEach(async () => {
    await runtime?.stop();
    db?.close();
    runtime = undefined;
    db = undefined;
  });

  function setup(): { repository: Repository; harness: RuntimeHarness; events: EventBus } {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const vault = new SecretVault(repository);
    const wallet = new WalletManager(vault, repository);
    const events = new EventBus();
    runtime = new TradingRuntime(
      repository,
      vault,
      new ModeManager(repository, wallet),
      events,
      new DpapiTransactionSigner(vault, repository)
    );
    return { repository, harness: runtime as unknown as RuntimeHarness, events };
  }

  it("records every early terminal branch once and publishes structured refresh events", async () => {
    const { repository, harness, events } = setup();
    const publish = vi.spyOn(events, "publish");
    harness.activeWalletAllowed = () => true;
    harness.monitoringRepairPending = () => false;

    const recovered = source(1, { recovered: true });
    await harness.handleSwap(recovered);

    harness.monitoringRepairPending = () => true;
    await harness.handleSwap(source(2));

    harness.monitoringRepairPending = () => false;
    harness.emergencyActive = true;
    await harness.handleSwap(source(3));

    harness.emergencyActive = false;
    harness.activeWalletAllowed = () => false;
    const shadow = source(4);
    await harness.handleSwap(shadow);
    await harness.handleSwap(shadow);

    harness.activeWalletAllowed = () => true;
    repository.setSetting("mode", "PAUSED");
    repository.setSetting("paused_from", "PAPER");
    await harness.handleSwap(source(5));

    expect(repository.listSignalOutcomes()).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceSignature: recovered.sourceSignature, status: "ANALYSIS_ONLY", reasonCode: "RECOVERED_SOURCE" }),
      expect.objectContaining({ sourceSignature: "source-2", status: "BLOCKED", reasonCode: "MONITORING_GAP" }),
      expect.objectContaining({ sourceSignature: "source-3", status: "BLOCKED", reasonCode: "EMERGENCY_ACTIVE" }),
      expect.objectContaining({ sourceSignature: shadow.sourceSignature, status: "ANALYSIS_ONLY", reasonCode: "SHADOW_WALLET" }),
      expect.objectContaining({ sourceSignature: "source-5", status: "BLOCKED", reasonCode: "MODE_BLOCKED" })
    ]));
    expect(repository.db.prepare("SELECT COUNT(*) AS count FROM signal_outcomes WHERE source_signature = ?")
      .get(shadow.sourceSignature)).toEqual({ count: 1 });
    expect(publish.mock.calls.filter(([type]) => type === "signal-outcome")).toHaveLength(5);
  });

  it("persists a provider-rejected action once without entering any trading path", async () => {
    const { repository, harness, events } = setup();
    repository.setSetting("mode", "PAPER");
    const publish = vi.spyOn(events, "publish");
    const saveDecision = vi.spyOn(repository, "saveDecision");
    const saveQuote = vi.spyOn(repository, "saveQuote");
    const upsertExecution = vi.spyOn(repository, "upsertExecution");
    const upsertPosition = vi.spyOn(repository, "upsertPosition");
    const handleSwap = vi.fn(async (): Promise<void> => {
      throw new Error("provider rejection must not enter handleSwap");
    });
    const processBuy = vi.fn(async (): Promise<void> => {
      throw new Error("provider rejection must not enter processBuy");
    });
    const getToken = vi.fn(async (): Promise<TokenEligibility> => {
      throw new Error("provider rejection must not request token risk");
    });
    const evaluateOrderRisk = vi.fn(async (): Promise<RiskDecision> => {
      throw new Error("provider rejection must not evaluate order risk");
    });
    const applyExecution = vi.fn(async (): Promise<void> => {
      throw new Error("provider rejection must not apply execution");
    });
    harness.handleSwap = handleSwap;
    harness.processBuy = processBuy;
    harness.getToken = getToken;
    harness.evaluateOrderRisk = evaluateOrderRisk;
    harness.applyExecution = applyExecution;
    const observed = source(6);
    const rejection: RejectedSwapObservation = {
      action: {
        sourceSignature: observed.sourceSignature,
        sourceWallet: observed.sourceWallet,
        slot: observed.slot,
        blockTime: observed.blockTime,
        detectedAt: observed.detectedAt,
        side: observed.side,
        baseMint: observed.baseMint,
        targetMint: observed.targetMint,
        recovered: observed.recovered
      },
      researchAction: {
        kind: "UNSUPPORTED_ROUTE_RESEARCH_ONLY",
        source: {
          sourceSignature: observed.sourceSignature,
          sourceWallet: observed.sourceWallet,
          slot: observed.slot,
          blockTime: observed.blockTime,
          detectedAt: observed.detectedAt,
          side: observed.side,
          baseMint: observed.baseMint,
          targetMint: observed.targetMint,
          recovered: observed.recovered
        },
        baseAmountAtomic: observed.baseAmountAtomic,
        targetAmountAtomic: observed.targetAmountAtomic,
        baseAmountUi: observed.baseAmountUi,
        targetAmountUi: observed.targetAmountUi
      },
      reason: "Swap-like activity included unsupported Pump routing programs."
    };

    await harness.queueProviderRejectedSwap(rejection);
    await harness.queueProviderRejectedSwap(rejection);

    expect(repository.listSignalOutcomes()).toEqual([
      expect.objectContaining({
        sourceSignature: observed.sourceSignature,
        sourceWallet: observed.sourceWallet,
        mint: observed.targetMint,
        action: "BUY",
        mode: "PAPER",
        status: "REJECTED",
        reasonCode: "UNSUPPORTED_PROGRAM_ACTIVITY",
        reason: rejection.reason
      })
    ]);
    expect(repository.isSourceProcessed(observed.sourceSignature, observed.sourceWallet)).toBe(true);
    expect(publish.mock.calls.filter(([type]) => type === "signal-outcome")).toHaveLength(1);
    expect(handleSwap).not.toHaveBeenCalled();
    expect(processBuy).not.toHaveBeenCalled();
    expect(getToken).not.toHaveBeenCalled();
    expect(evaluateOrderRisk).not.toHaveBeenCalled();
    expect(applyExecution).not.toHaveBeenCalled();
    expect(saveDecision).not.toHaveBeenCalled();
    expect(saveQuote).not.toHaveBeenCalled();
    expect(upsertExecution).not.toHaveBeenCalled();
    expect(upsertPosition).not.toHaveBeenCalled();
    expect(repository.listExecutions()).toEqual([]);
    expect(repository.listPositions()).toEqual([]);
    expect(repository.db.prepare("SELECT COUNT(*) AS count FROM signal_decisions").get()).toEqual({ count: 0 });
  });

  it("records provider failure, risk rejection, and paper simulation without payload leakage", async () => {
    const { repository, harness } = setup();
    repository.setSetting("mode", "PAPER");
    harness.activeWalletAllowed = () => true;
    harness.monitoringRepairPending = () => false;
    harness.emergencyActive = false;
    harness.applyExecution = async () => undefined;
    harness.getSolPriceUsd = async () => 100;
    harness.providers = {
      token: {},
      quotes: {
        quote: async ({ inputMint }: { inputMint: string }) => quote(`quote-${inputMint}`, inputMint)
      }
    };

    harness.getToken = async () => {
      throw new Error(`authorization: Bearer ${"secret".repeat(12)}`);
    };
    await harness.handleSwap(source(10));

    harness.getToken = async (mint) => ({
      mint,
      checkedAt: new Date().toISOString(),
      eligible: true,
      reasons: [],
      verified: true,
      suspicious: false,
      mintAuthorityDisabled: true,
      freezeAuthorityDisabled: true,
      liquidityUsd: 10_000_000,
      volume24hUsd: 2_000_000,
      holderCount: 2_000,
      organicScore: 90,
      topHoldersPercent: 10
    });
    harness.evaluateOrderRisk = async () => ({
      allowed: false,
      code: "TOKEN_INELIGIBLE",
      reasons: ["risk fixture rejected"],
      decidedAt: new Date().toISOString()
    });
    await harness.handleSwap(source(11));

    harness.evaluateOrderRisk = async () => ({
      allowed: true,
      code: "ALLOWED",
      reasons: ["allowed"],
      decidedAt: new Date().toISOString()
    });
    await harness.handleSwap(source(12));

    const outcomes = repository.listSignalOutcomes();
    expect(outcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceSignature: "source-10", status: "REJECTED", reasonCode: "PROVIDER_ERROR" }),
      expect.objectContaining({ sourceSignature: "source-11", status: "REJECTED", reasonCode: "RISK_REJECTED", decisionCode: "TOKEN_INELIGIBLE" }),
      expect.objectContaining({ sourceSignature: "source-12", status: "SIMULATED", reasonCode: "PAPER_SIMULATION" })
    ]));
    expect(JSON.stringify(outcomes)).not.toContain("secretsecret");
    expect(JSON.stringify(outcomes)).not.toContain("transactionBase64");
  });
});
