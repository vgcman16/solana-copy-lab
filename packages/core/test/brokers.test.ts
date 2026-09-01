import { describe, expect, it, vi } from "vitest";
import type { BrokerOrder, QuoteExecutor, Signer, SignerValidation } from "@copylab/shared";
import {
  LiveBrokerOrchestrator,
  PaperBroker,
  createIdempotencyKey
} from "../src/index.js";
import { NOW, TARGET_MINT, USDC_MINT, allowedDecision, exitQuote, intent, quote } from "./fixtures.js";

function order(overrides: Partial<BrokerOrder> = {}): BrokerOrder {
  return {
    intent: intent(),
    entryQuote: quote({ transactionBase64: "dHJhbnNhY3Rpb24=" }),
    decision: allowedDecision(),
    ...overrides
  };
}

describe("idempotency", () => {
  it("is deterministic, versioned, fixed length, and action-sensitive", () => {
    const parts = {
      sourceSignature: "sig",
      sourceWallet: "wallet",
      mint: "mint",
      action: "BUY" as const
    };
    const first = createIdempotencyKey(parts);
    expect(first).toBe(createIdempotencyKey(parts));
    expect(first).toMatch(/^copy-v1-[a-f0-9]{64}$/);
    expect(first).not.toBe(createIdempotencyKey({ ...parts, action: "SELL" }));
  });
});

describe("paper broker", () => {
  it("fills an allowed order deterministically using the accepted quote", async () => {
    const broker = new PaperBroker({ now: () => NOW, createId: () => "paper-1", solPriceUsd: 200 });
    const result = await broker.place(order());
    expect(result).toMatchObject({
      id: "paper-1",
      mode: "PAPER",
      status: "CONFIRMED",
      actualInputAtomic: "5000000",
      actualOutputAtomic: "5000000",
      implementationShortfallPercent: 0,
      actualFeesUsd: 0.001
    });
  });

  it("records but never fills a denied order", async () => {
    const broker = new PaperBroker({ now: () => NOW, createId: () => "paper-2" });
    const result = await broker.place(order({
      decision: allowedDecision({ allowed: false, code: "TOKEN_INELIGIBLE", reasons: ["unsafe token"] })
    }));
    expect(result).toMatchObject({ status: "SKIPPED", failureReason: "unsafe token" });
    expect(result.actualOutputAtomic).toBeUndefined();
  });
});

describe("live broker orchestration", () => {
  it("requires manual approval, validates before signing, executes once, and deduplicates", async () => {
    let mode = "MANUAL_LIVE" as const;
    const validations: SignerValidation[] = [];
    const signer: Signer = {
      getAddress: vi.fn(async () => "bot-wallet"),
      signValidatedTransaction: vi.fn(async (_transaction, validation) => {
        validations.push(validation);
        return "signed";
      })
    };
    const executor: QuoteExecutor = {
      quote: vi.fn(),
      execute: vi.fn(async () => ({
        success: true,
        signature: "target-signature",
        inputAmountAtomic: "5000000",
        outputAmountAtomic: "4990000"
      }))
    };
    const broker = new LiveBrokerOrchestrator({
      signer,
      executor,
      getMode: () => mode,
      allowedPrograms: ["jupiter-program", "token-program"],
      allowedRoutePrograms: ["raydium-program"],
      maximumFeeLamports: 100_000,
      now: () => NOW,
      createId: () => "live-1"
    });

    const pending = await broker.place(order());
    expect(pending.status).toBe("AWAITING_APPROVAL");
    expect(signer.signValidatedTransaction).not.toHaveBeenCalled();
    expect((await broker.place(order())).id).toBe("live-1");
    expect(broker.getPendingApprovals()).toHaveLength(1);

    const result = await broker.approve(pending.id);
    expect(result).toMatchObject({
      status: "CONFIRMED",
      approvedAt: NOW.toISOString(),
      targetSignature: "target-signature",
      actualInputAtomic: "5000000",
      actualOutputAtomic: "4990000"
    });
    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect(validations).toEqual([{
      wallet: "bot-wallet",
      inputMint: USDC_MINT,
      outputMint: TARGET_MINT,
      maximumInputAtomic: "5000000",
      quotedOutputAtomic: "5000000",
      minimumOutputAtomic: "4900000",
      expectedSlippageBps: 10,
      signatureFeeLamports: 5000,
      prioritizationFeeLamports: 0,
      rentFeeLamports: 0,
      expectedRouter: "jupiter",
      maximumFeeLamports: 100_000,
      allowedPrograms: ["jupiter-program", "token-program"],
      expectedPlatformFeeBps: 0,
      allowedFeeAccounts: [],
      allowedRoutePrograms: ["raydium-program"],
      exitOnlyRpcAuthorized: false
    }]);

    // Type narrowing should not change the behavior; this also proves no second execution occurred.
    mode = "MANUAL_LIVE";
    expect((await broker.place(order())).status).toBe("CONFIRMED");
    expect(executor.execute).toHaveBeenCalledTimes(1);
  });

  it("auto mode still revalidates and fails closed before signing", async () => {
    const signer: Signer = {
      getAddress: vi.fn(async () => "bot-wallet"),
      signValidatedTransaction: vi.fn(async () => "signed")
    };
    const executor: QuoteExecutor = { quote: vi.fn(), execute: vi.fn() };
    const broker = new LiveBrokerOrchestrator({
      signer,
      executor,
      getMode: () => "AUTO_LIVE",
      allowedPrograms: ["jupiter-program"],
      allowedRoutePrograms: ["raydium-program"],
      maximumFeeLamports: 100_000,
      now: () => NOW,
      createId: () => "live-2",
      revalidate: () => allowedDecision({
        allowed: false,
        code: "QUOTE_EXPIRED",
        reasons: ["quote became stale"]
      })
    });
    const result = await broker.place(order());
    expect(result).toMatchObject({ status: "FAILED", failureReason: "risk revalidation failed: quote became stale" });
    expect(signer.signValidatedTransaction).not.toHaveBeenCalled();
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it("authorizes the independent RPC only for a recorded-position forced sell", async () => {
    const validations: SignerValidation[] = [];
    const broker = new LiveBrokerOrchestrator({
      signer: {
        getAddress: vi.fn(async () => "bot-wallet"),
        signValidatedTransaction: vi.fn(async (_transaction, validation) => {
          validations.push(validation);
          return "signed-exit";
        })
      },
      executor: {
        quote: vi.fn(),
        execute: vi.fn(async () => ({ success: true, signature: "exit-signature" }))
      },
      getMode: () => "LOCKED",
      allowedPrograms: ["jupiter-program"],
      allowedRoutePrograms: ["raydium-program"],
      maximumFeeLamports: 100_000,
      now: () => NOW,
      createId: () => "forced-exit"
    });
    const sellIntent = intent({
      id: "exit-intent",
      idempotencyKey: "exit-key",
      side: "SELL",
      inputMint: TARGET_MINT,
      outputMint: USDC_MINT,
      sourcePositionId: "recorded-position"
    });
    const result = await broker.placeForcedExit(order({
      intent: sellIntent,
      entryQuote: exitQuote({ transactionBase64: "ZXhpdA==" })
    }));

    expect(result.status).toBe("CONFIRMED");
    expect(validations).toHaveLength(1);
    expect(validations[0]?.exitOnlyRpcAuthorized).toBe(true);
  });

  it("preserves an ambiguous broadcast instead of marking it safe to retry", async () => {
    const updates: string[] = [];
    const executor: QuoteExecutor = {
      quote: vi.fn(),
      execute: vi.fn(async () => {
        throw new Error("execute response timed out");
      })
    };
    const broker = new LiveBrokerOrchestrator({
      signer: {
        getAddress: vi.fn(async () => "bot-wallet"),
        signValidatedTransaction: vi.fn(async () => "signed-bytes")
      },
      executor,
      getMode: () => "AUTO_LIVE",
      allowedPrograms: ["jupiter-program"],
      allowedRoutePrograms: ["raydium-program"],
      maximumFeeLamports: 100_000,
      now: () => NOW,
      createId: () => "ambiguous-live",
      deriveSignature: () => "deterministic-signature",
      onUpdate: (record) => updates.push(record.status)
    });

    const result = await broker.place(order());
    expect(result).toMatchObject({
      status: "SUBMITTED_UNRESOLVED",
      submittedAt: NOW.toISOString(),
      targetSignature: "deterministic-signature",
      failureReason: "execute response timed out"
    });
    expect(updates).toEqual(["QUEUED", "SUBMITTED", "SUBMITTED_UNRESOLVED"]);
    expect((await broker.place(order())).status).toBe("SUBMITTED_UNRESOLVED");
    expect(executor.execute).toHaveBeenCalledTimes(1);
  });

  it("refreshes an expired manual order before revalidation and signing", async () => {
    let currentTime = new Date("2026-02-15T12:00:00.000Z");
    const sign = vi.fn(async () => "signed-fresh");
    const signer: Signer = {
      getAddress: vi.fn(async () => "bot-wallet"),
      signValidatedTransaction: sign
    };
    const executor: QuoteExecutor = {
      quote: vi.fn(),
      execute: vi.fn(async () => ({ success: true, signature: "fresh-signature" }))
    };
    const refreshOrder = vi.fn(async (staleOrder: BrokerOrder): Promise<BrokerOrder> => ({
      ...staleOrder,
      entryQuote: quote({
        requestId: "fresh-request",
        quotedAt: "2026-02-15T12:01:00.000Z",
        expiresAt: "2026-02-15T12:01:05.000Z",
        transactionBase64: "fresh-transaction"
      }),
      exitQuote: exitQuote({
        requestId: "fresh-exit-request",
        quotedAt: "2026-02-15T12:01:00.000Z",
        expiresAt: "2026-02-15T12:01:05.000Z"
      })
    }));
    const revalidate = vi.fn(() => allowedDecision());
    const broker = new LiveBrokerOrchestrator({
      signer,
      executor,
      getMode: () => "MANUAL_LIVE",
      allowedPrograms: ["jupiter-program"],
      allowedRoutePrograms: ["raydium-program"],
      maximumFeeLamports: 100_000,
      now: () => currentTime,
      createId: () => "live-refresh",
      refreshOrder,
      revalidate
    });

    const pending = await broker.place(order({ exitQuote: exitQuote() }));
    currentTime = new Date("2026-02-15T12:01:01.000Z");
    const result = await broker.approve(pending.id);

    expect(result).toMatchObject({ status: "CONFIRMED", targetSignature: "fresh-signature" });
    expect(result.quote.requestId).toBe("fresh-request");
    expect(refreshOrder).toHaveBeenCalledTimes(1);
    expect(revalidate.mock.calls[0]![0].entryQuote.requestId).toBe("fresh-request");
    expect(revalidate.mock.calls[0]![0].exitQuote?.requestId).toBe("fresh-exit-request");
    expect(sign).toHaveBeenCalledWith("fresh-transaction", expect.any(Object));
    expect(executor.execute).toHaveBeenCalledWith("signed-fresh", "fresh-request");
  });

  it("does not allow quote refresh without a post-refresh risk check", () => {
    const signer: Signer = {
      getAddress: vi.fn(async () => "bot-wallet"),
      signValidatedTransaction: vi.fn(async () => "signed")
    };
    const executor: QuoteExecutor = { quote: vi.fn(), execute: vi.fn() };
    expect(() => new LiveBrokerOrchestrator({
      signer,
      executor,
      getMode: () => "MANUAL_LIVE",
      allowedPrograms: ["jupiter-program"],
      allowedRoutePrograms: ["raydium-program"],
      maximumFeeLamports: 10_000,
      refreshOrder: async (value) => value
    })).toThrow("refreshOrder requires risk revalidation");
  });

  it("rejects missing transactions, expired orders, and excessive quoted fees before signing", async () => {
    const sign = vi.fn(async () => "signed");
    const signer: Signer = { getAddress: vi.fn(async () => "bot-wallet"), signValidatedTransaction: sign };
    const executor: QuoteExecutor = { quote: vi.fn(), execute: vi.fn() };
    let id = 0;
    const createBroker = () => new LiveBrokerOrchestrator({
      signer,
      executor,
      getMode: () => "AUTO_LIVE",
      allowedPrograms: ["jupiter-program"],
      allowedRoutePrograms: ["raydium-program"],
      maximumFeeLamports: 10_000,
      now: () => NOW,
      createId: () => `security-${++id}`
    });

    const missing = await createBroker().place(order({ entryQuote: quote({ transactionBase64: undefined }) }));
    expect(missing.failureReason).toBe("Jupiter order did not include a transaction");

    const expired = await createBroker().place(order({
      intent: intent({ idempotencyKey: "key-expired" }),
      entryQuote: quote({ transactionBase64: "tx", expiresAt: "2026-02-15T11:59:59.000Z" })
    }));
    expect(expired.failureReason).toBe("Jupiter order expired before signing");

    const expensive = await createBroker().place(order({
      intent: intent({ idempotencyKey: "key-expensive" }),
      entryQuote: quote({ transactionBase64: "tx", signatureFeeLamports: 10_001 })
    }));
    expect(expensive.failureReason).toBe("quoted network and rent fees exceed the signing cap");
    expect(sign).not.toHaveBeenCalled();
  });

  it("does not queue denied orders or live orders while paused", async () => {
    const signer: Signer = {
      getAddress: vi.fn(async () => "bot-wallet"),
      signValidatedTransaction: vi.fn(async () => "signed")
    };
    const executor: QuoteExecutor = { quote: vi.fn(), execute: vi.fn() };
    const paused = new LiveBrokerOrchestrator({
      signer,
      executor,
      getMode: () => "PAUSED",
      allowedPrograms: ["jupiter-program"],
      allowedRoutePrograms: ["raydium-program"],
      maximumFeeLamports: 10_000,
      now: () => NOW,
      createId: () => "paused"
    });
    expect((await paused.place(order())).status).toBe("SKIPPED");
  });
});
