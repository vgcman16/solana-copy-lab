import { randomUUID } from "node:crypto";
import type {
  Broker,
  BrokerOrder,
  ExecutionRecord,
  ModeState,
  QuoteExecutor,
  RiskDecision,
  Signer,
  SignerValidation
} from "@copylab/shared";

export interface LiveBrokerOptions {
  signer: Signer;
  executor: QuoteExecutor;
  getMode: () => ModeState;
  allowedPrograms: readonly string[];
  allowedRoutePrograms: readonly string[];
  maximumFeeLamports: number;
  now?: () => Date;
  createId?: () => string;
  refreshOrder?: (order: BrokerOrder) => Promise<BrokerOrder>;
  revalidate?: (order: BrokerOrder) => Promise<RiskDecision> | RiskDecision;
  /** Derives the deterministic Solana signature before the signed bytes are broadcast. */
  deriveSignature?: (signedTransactionBase64: string) => string;
  onUpdate?: (record: ExecutionRecord) => Promise<void> | void;
}

interface PendingOrder {
  order: BrokerOrder;
  record: ExecutionRecord;
}

export class LiveBrokerOrchestrator implements Broker {
  readonly mode = "LIVE" as const;
  readonly #options: LiveBrokerOptions;
  readonly #now: () => Date;
  readonly #createId: () => string;
  readonly #recordsByKey = new Map<string, ExecutionRecord>();
  readonly #pending = new Map<string, PendingOrder>();

  constructor(options: LiveBrokerOptions) {
    if (options.allowedPrograms.length === 0) throw new Error("at least one allowed program is required");
    if (options.allowedRoutePrograms.length === 0) throw new Error("at least one allowed route program is required");
    if (!Number.isFinite(options.maximumFeeLamports) || options.maximumFeeLamports <= 0) {
      throw new RangeError("maximumFeeLamports must be positive");
    }
    if (options.refreshOrder && !options.revalidate) {
      throw new Error("refreshOrder requires risk revalidation before signing");
    }
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
    this.#createId = options.createId ?? randomUUID;
  }

  getPendingApprovals(): ExecutionRecord[] {
    return [...this.#pending.values()].map(({ record }) => ({ ...record }));
  }

  async place(order: BrokerOrder): Promise<ExecutionRecord> {
    const existing = this.#recordsByKey.get(order.intent.idempotencyKey);
    if (existing) return { ...existing };

    const timestamp = this.#now().toISOString();
    const mode = this.#options.getMode();
    const executableMode = mode === "MANUAL_LIVE" || mode === "AUTO_LIVE";
    const record: ExecutionRecord = {
      id: this.#createId(),
      idempotencyKey: order.intent.idempotencyKey,
      intentId: order.intent.id,
      mode: "LIVE",
      status: !executableMode || !order.decision.allowed
        ? "SKIPPED"
        : mode === "MANUAL_LIVE"
          ? "AWAITING_APPROVAL"
          : "QUEUED",
      createdAt: timestamp,
      updatedAt: timestamp,
      sourceSignature: order.intent.sourceSwap.sourceSignature,
      quote: order.entryQuote
    };
    if (!executableMode) record.failureReason = `mode ${mode} does not permit live execution`;
    if (!order.decision.allowed) record.failureReason = order.decision.reasons.join("; ");
    this.#recordsByKey.set(order.intent.idempotencyKey, record);
    await this.#notify(record);

    if (record.status === "AWAITING_APPROVAL") {
      this.#pending.set(record.id, { order, record });
      return { ...record };
    }
    if (record.status === "QUEUED") return this.#submit(order, record);
    return { ...record };
  }

  async approve(executionId: string): Promise<ExecutionRecord> {
    if (this.#options.getMode() !== "MANUAL_LIVE") {
      throw new Error("manual approval is only available in MANUAL_LIVE");
    }
    const pending = this.#pending.get(executionId);
    if (!pending) throw new Error("pending execution was not found");
    this.#pending.delete(executionId);
    const timestamp = this.#now().toISOString();
    pending.record.status = "APPROVED";
    pending.record.approvedAt = timestamp;
    pending.record.updatedAt = timestamp;
    await this.#notify(pending.record);
    return this.#submit(pending.order, pending.record);
  }

  async reject(executionId: string, reason = "rejected by user"): Promise<ExecutionRecord> {
    const pending = this.#pending.get(executionId);
    if (!pending) throw new Error("pending execution was not found");
    this.#pending.delete(executionId);
    pending.record.status = "REJECTED";
    pending.record.updatedAt = this.#now().toISOString();
    pending.record.failureReason = reason;
    await this.#notify(pending.record);
    return { ...pending.record };
  }

  async cancelPending(reason = "cancelled before signing"): Promise<ExecutionRecord[]> {
    const cancelled: ExecutionRecord[] = [];
    for (const id of [...this.#pending.keys()]) {
      cancelled.push(await this.reject(id, reason));
    }
    return cancelled;
  }

  async placeForcedExit(order: BrokerOrder): Promise<ExecutionRecord> {
    if (order.intent.side !== "SELL") throw new Error("forced execution only permits recorded-position sells");
    const existing = this.#recordsByKey.get(order.intent.idempotencyKey);
    if (existing) return { ...existing };
    const timestamp = this.#now().toISOString();
    const record: ExecutionRecord = {
      id: this.#createId(),
      idempotencyKey: order.intent.idempotencyKey,
      intentId: order.intent.id,
      mode: "LIVE",
      status: order.decision.allowed ? "QUEUED" : "SKIPPED",
      createdAt: timestamp,
      updatedAt: timestamp,
      sourceSignature: order.intent.sourceSwap.sourceSignature,
      quote: order.entryQuote
    };
    if (!order.decision.allowed) record.failureReason = order.decision.reasons.join("; ");
    this.#recordsByKey.set(order.intent.idempotencyKey, record);
    await this.#notify(record);
    return record.status === "QUEUED" ? this.#submit(order, record, true) : { ...record };
  }

  async #submit(order: BrokerOrder, record: ExecutionRecord, forcedExit = false): Promise<ExecutionRecord> {
    try {
      const currentMode = this.#options.getMode();
      if (!forcedExit && currentMode !== "MANUAL_LIVE" && currentMode !== "AUTO_LIVE") {
        throw new Error(`mode changed to ${currentMode} before signing`);
      }
      if (forcedExit && order.intent.side !== "SELL") {
        throw new Error("forced execution attempted a non-sell order");
      }

      let executableOrder = order;
      if (!forcedExit && this.#options.refreshOrder) {
        executableOrder = await this.#options.refreshOrder(order);
        if (
          executableOrder.intent.id !== order.intent.id ||
          executableOrder.intent.idempotencyKey !== order.intent.idempotencyKey ||
          executableOrder.intent.inputMint !== order.intent.inputMint ||
          executableOrder.intent.outputMint !== order.intent.outputMint ||
          executableOrder.intent.inputAmountAtomic !== order.intent.inputAmountAtomic ||
          executableOrder.intent.inputAmountUsd !== order.intent.inputAmountUsd ||
          executableOrder.intent.side !== order.intent.side ||
          executableOrder.intent.sourceSwap.sourceSignature !== order.intent.sourceSwap.sourceSignature ||
          executableOrder.intent.sourceSwap.sourceWallet !== order.intent.sourceSwap.sourceWallet ||
          executableOrder.intent.sourceSwap.targetMint !== order.intent.sourceSwap.targetMint
        ) {
          throw new Error("refreshed order changed immutable intent fields");
        }
        record.quote = executableOrder.entryQuote;
      }
      if (!executableOrder.decision.allowed) {
        throw new Error(`refreshed order was denied: ${executableOrder.decision.reasons.join("; ")}`);
      }

      if (!forcedExit && this.#options.revalidate) {
        const decision = await this.#options.revalidate(executableOrder);
        if (!decision.allowed) throw new Error(`risk revalidation failed: ${decision.reasons.join("; ")}`);
      }

      const quote = executableOrder.entryQuote;
      if (!quote.transactionBase64) throw new Error("Jupiter order did not include a transaction");
      if (quote.expiresAt && Date.parse(quote.expiresAt) <= this.#now().getTime()) {
        throw new Error("Jupiter order expired before signing");
      }
      const quotedFees =
        quote.signatureFeeLamports + quote.prioritizationFeeLamports + quote.rentFeeLamports;
      if (quotedFees > this.#options.maximumFeeLamports) {
        throw new Error("quoted network and rent fees exceed the signing cap");
      }

      const wallet = await this.#options.signer.getAddress();
      const validation: SignerValidation = {
        wallet,
        inputMint: executableOrder.intent.inputMint,
        outputMint: executableOrder.intent.outputMint,
        maximumInputAtomic: executableOrder.intent.inputAmountAtomic,
        quotedOutputAtomic: quote.outputAmountAtomic,
        minimumOutputAtomic: quote.minimumOutputAtomic,
        expectedSlippageBps: quote.slippageBps,
        signatureFeeLamports: quote.signatureFeeLamports,
        prioritizationFeeLamports: quote.prioritizationFeeLamports,
        rentFeeLamports: quote.rentFeeLamports,
        expectedRouter: quote.router,
        maximumFeeLamports: this.#options.maximumFeeLamports,
        allowedPrograms: [...this.#options.allowedPrograms],
        expectedPlatformFeeBps: 0,
        allowedFeeAccounts: [],
        allowedRoutePrograms: [...this.#options.allowedRoutePrograms],
        exitOnlyRpcAuthorized: forcedExit
      };
      const signed = await this.#options.signer.signValidatedTransaction(quote.transactionBase64, validation);
      const derivedSignature = this.#options.deriveSignature?.(signed);
      if (derivedSignature) record.targetSignature = derivedSignature;
      record.status = "SUBMITTED";
      record.submittedAt = this.#now().toISOString();
      record.updatedAt = record.submittedAt;
      await this.#notify(record);
      const result = await this.#options.executor.execute(signed, quote.requestId);
      record.updatedAt = this.#now().toISOString();
      if (!result.success) {
        record.status = "FAILED";
        record.failureReason = result.error ?? "Jupiter execution failed";
      } else {
        record.status = "CONFIRMED";
        if (result.signature !== undefined) record.targetSignature = result.signature;
        if (result.inputAmountAtomic !== undefined) record.actualInputAtomic = result.inputAmountAtomic;
        if (result.outputAmountAtomic !== undefined) record.actualOutputAtomic = result.outputAmountAtomic;
        if (
          result.inputAmountAtomic !== undefined &&
          BigInt(result.inputAmountAtomic) > BigInt(executableOrder.intent.inputAmountAtomic)
        ) {
          record.policyViolation = "confirmed input exceeded the authorized cap";
        }
        if (
          result.outputAmountAtomic !== undefined &&
          BigInt(result.outputAmountAtomic) < BigInt(quote.minimumOutputAtomic)
        ) {
          record.policyViolation = record.policyViolation
            ? `${record.policyViolation}; confirmed output was below the authorized minimum`
            : "confirmed output was below the authorized minimum";
        }
      }
    } catch (error) {
      // Once SUBMITTED has been persisted, a transport error cannot prove that
      // the signed transaction was not broadcast. Preserve that ambiguity so
      // startup recovery can reconcile the deterministic signature on-chain
      // before any retry is authorized.
      record.status = record.status === "SUBMITTED" ? "SUBMITTED_UNRESOLVED" : "FAILED";
      record.updatedAt = this.#now().toISOString();
      record.failureReason = error instanceof Error ? error.message : "unknown live execution error";
    }
    await this.#notify(record);
    return { ...record };
  }

  async #notify(record: ExecutionRecord): Promise<void> {
    await this.#options.onUpdate?.({ ...record });
  }
}
