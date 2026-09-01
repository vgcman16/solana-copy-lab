import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SOL_MINT,
  USDC_MINT,
  type CopyIntent,
  type ExecutionRecord,
  type LeaderSwap,
  type QuoteSnapshot
} from "@copylab/shared";
import { AppService } from "../src/app-service.js";
import type { CopyLabDatabase } from "../src/database.js";
import { openDatabase } from "../src/database.js";
import { EventBus } from "../src/events.js";
import { ModeManager } from "../src/mode.js";
import { Repository } from "../src/repository.js";
import { SecretVault } from "../src/vault.js";
import { WalletManager } from "../src/wallet.js";
import { MockRuntime } from "./helpers.js";

describe("dashboard signal audit exposure", () => {
  let db: CopyLabDatabase | undefined;
  afterEach(() => {
    vi.restoreAllMocks();
    db?.close();
  });

  it("coalesces burst reads for fifteen seconds and invalidates immediately after a service mutation", () => {
    let cacheNow = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => cacheNow);
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const vault = new SecretVault(repository);
    const wallet = new WalletManager(vault, repository);
    const service = new AppService(
      repository,
      vault,
      wallet,
      new ModeManager(repository, wallet),
      new EventBus(),
      new MockRuntime()
    );
    const coverage = vi.spyOn(repository, "walletIndexCoverage");
    const priceCoverage = vi.spyOn(repository, "solPriceCoverage");

    const first = service.dashboard();
    expect(service.dashboard()).toBe(first);
    expect(coverage).toHaveBeenCalledTimes(1);
    expect(priceCoverage).toHaveBeenCalledTimes(1);

    cacheNow += 14_999;
    expect(service.dashboard()).toBe(first);
    expect(coverage).toHaveBeenCalledTimes(1);
    expect(priceCoverage).toHaveBeenCalledTimes(1);

    cacheNow += 1;
    const expired = service.dashboard();
    expect(expired).not.toBe(first);
    expect(coverage).toHaveBeenCalledTimes(2);
    expect(priceCoverage).toHaveBeenCalledTimes(2);

    service.startSolPriceBootstrap();
    expect(service.dashboard()).not.toBe(expired);
    expect(coverage).toHaveBeenCalledTimes(3);
    expect(priceCoverage).toHaveBeenCalledTimes(3);
  });

  it("bounds derived provider readiness while keeping setup and wallet fields fresh", () => {
    let cacheNow = 5_000;
    vi.spyOn(Date, "now").mockImplementation(() => cacheNow);
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const vault = new SecretVault(repository);
    const wallet = new WalletManager(vault, repository);
    const service = new AppService(
      repository,
      vault,
      wallet,
      new ModeManager(repository, wallet),
      new EventBus(),
      new MockRuntime()
    );
    const priceCoverage = vi.spyOn(repository, "solPriceCoverage");
    const walletStatus = vi.spyOn(wallet, "status");

    const first = service.setupStatus();
    const second = service.setupStatus();
    expect(second).not.toBe(first);
    expect(walletStatus).toHaveBeenCalledTimes(2);
    expect(priceCoverage).toHaveBeenCalledTimes(1);

    cacheNow += 15_000;
    service.setupStatus();
    expect(walletStatus).toHaveBeenCalledTimes(3);
    expect(priceCoverage).toHaveBeenCalledTimes(2);

    service.startSolPriceBootstrap();
    service.setupStatus();
    expect(walletStatus).toHaveBeenCalledTimes(4);
    expect(priceCoverage).toHaveBeenCalledTimes(3);
  });

  it("returns bounded scalar outcomes and redacts transaction bytes from execution views", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const vault = new SecretVault(repository);
    const wallet = new WalletManager(vault, repository);
    const service = new AppService(
      repository,
      vault,
      wallet,
      new ModeManager(repository, wallet),
      new EventBus(),
      new MockRuntime()
    );
    const swap: LeaderSwap = {
      sourceSignature: "leader-signature",
      sourceWallet: "leader-wallet",
      slot: 1,
      blockTime: "2026-01-01T00:00:00.000Z",
      detectedAt: "2026-01-01T00:00:01.000Z",
      side: "BUY",
      baseMint: USDC_MINT,
      targetMint: SOL_MINT,
      baseAmountAtomic: "1000000",
      targetAmountAtomic: "10000000",
      baseAmountUi: 1,
      targetAmountUi: 0.01,
      leaderPriceUsd: 100,
      recovered: false
    };
    repository.insertSourceEvent(swap);
    const intent: CopyIntent = {
      id: "dashboard-intent",
      idempotencyKey: "copy-v1-dashboard",
      createdAt: swap.detectedAt,
      sourceSwap: swap,
      side: "BUY",
      inputMint: USDC_MINT,
      outputMint: SOL_MINT,
      inputAmountAtomic: "1000000",
      inputAmountUsd: 1
    };
    repository.saveDecision("dashboard-decision", intent, undefined, {
      allowed: true,
      code: "ALLOWED",
      reasons: ["allowed"],
      decidedAt: "2026-01-01T00:00:02.000Z"
    });
    const quote: QuoteSnapshot = {
      requestId: "dashboard-quote",
      quotedAt: "2026-01-01T00:00:03.000Z",
      inputMint: USDC_MINT,
      outputMint: SOL_MINT,
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
      router: "iris",
      transactionBase64: "private-jupiter-transaction-bytes"
    };
    const execution: ExecutionRecord = {
      id: "dashboard-execution",
      idempotencyKey: intent.idempotencyKey,
      intentId: intent.id,
      mode: "PAPER",
      status: "CONFIRMED",
      createdAt: "2026-01-01T00:00:03.000Z",
      updatedAt: "2026-01-01T00:00:04.000Z",
      sourceSignature: swap.sourceSignature,
      quote,
      failureReason: `authorization: Bearer ${"secret".repeat(12)}`
    };
    repository.upsertExecution(execution);

    const dashboard = service.dashboard();
    expect(dashboard.recentSignals).toHaveLength(1);
    expect(dashboard.recentSignals[0]).toMatchObject({
      idempotencyKey: intent.idempotencyKey,
      status: "SIMULATED",
      reasonCode: "PAPER_SIMULATION"
    });
    expect(dashboard.recentSignals[0]).not.toHaveProperty("intent");
    expect(dashboard.recentSignals[0]).not.toHaveProperty("token");
    const serialized = JSON.stringify(dashboard);
    expect(serialized).not.toContain("private-jupiter-transaction-bytes");
    expect(serialized).not.toContain("secretsecret");
  });
});
