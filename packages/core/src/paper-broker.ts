import { randomUUID } from "node:crypto";
import type { Broker, BrokerOrder, ExecutionRecord } from "@copylab/shared";

export interface PaperBrokerOptions {
  now?: () => Date;
  createId?: () => string;
  solPriceUsd?: number;
}

export class PaperBroker implements Broker {
  readonly mode = "PAPER" as const;
  readonly #now: () => Date;
  readonly #createId: () => string;
  readonly #solPriceUsd: number;

  constructor(options: PaperBrokerOptions = {}) {
    this.#now = options.now ?? (() => new Date());
    this.#createId = options.createId ?? randomUUID;
    this.#solPriceUsd = options.solPriceUsd ?? 0;
  }

  async place(order: BrokerOrder): Promise<ExecutionRecord> {
    const timestamp = this.#now().toISOString();
    const base: ExecutionRecord = {
      id: this.#createId(),
      idempotencyKey: order.intent.idempotencyKey,
      intentId: order.intent.id,
      mode: "PAPER",
      status: order.decision.allowed ? "CONFIRMED" : "SKIPPED",
      createdAt: timestamp,
      updatedAt: timestamp,
      sourceSignature: order.intent.sourceSwap.sourceSignature,
      quote: order.entryQuote
    };

    if (!order.decision.allowed) {
      base.failureReason = order.decision.reasons.join("; ");
      return base;
    }

    const lamports =
      order.entryQuote.signatureFeeLamports +
      order.entryQuote.prioritizationFeeLamports +
      order.entryQuote.rentFeeLamports;
    base.actualInputAtomic = order.entryQuote.inputAmountAtomic;
    base.actualOutputAtomic = order.entryQuote.outputAmountAtomic;
    base.actualFeesUsd =
      order.entryQuote.inputUsd * (order.entryQuote.feeBps / 10_000) +
      (lamports / 1_000_000_000) * this.#solPriceUsd;
    base.implementationShortfallPercent = 0;
    return base;
  }
}
