import { createHash } from "node:crypto";
import type {
  ApplyMarketplacePaperFillInput,
  ApplyMarketplacePaperMarkInput,
  CopyIntent,
  ExecutionRecord,
  MarketplaceEnrollment,
  StockPaperOrder,
  StockPaperOrderEvent,
  StockPaperPosition,
  TokenEligibility
} from "@copylab/shared";
import type { CopyLabDatabase } from "./database.js";
import { MarketplaceService } from "./marketplace-service.js";
import { StockPaperRepository } from "./stock-paper-repository.js";

const STRICT_PILOT_ID = "pilot:strict-wallet-copy";
const STOCK_PILOT_ID = "pilot:stock-momentum";
const USDC_DECIMALS = 6;
const DEFAULT_PAGE_SIZE = 1_000;
const QUANTITY_EPSILON = 1e-9;

interface StrictLedgerRow {
  execution_id: string;
  execution_json: string;
  intent_json: string;
  token_json: string | null;
  applied_at: string;
}

interface StrictEvidence {
  execution: ExecutionRecord;
  intent: CopyIntent;
  token?: TokenEligibility;
  appliedAt: string;
}

interface StrictSourcePosition {
  decimals: number;
  remainingAtomic: bigint;
}

interface StrictPositionRow {
  position_id: string;
  position_json: string;
  token_json: string | null;
  persisted_at: string;
}

interface StrictPositionEvidence {
  id: string;
  mint: string;
  mode: "PAPER" | "LIVE";
  status: string;
  remainingAmountAtomic: string;
  lastExecutableValueUsd: number;
}

interface StockOrderRow {
  id: string;
  updated_at: string;
  order_json: string;
}

interface StockEventRow {
  id: string;
  decision_at: string;
  event_json: string;
}

interface StockPositionRow {
  id: string;
  updated_at: string;
  position_json: string;
}

export interface MarketplaceMirrorCoordinatorOptions {
  /** Bounded injection seam for keyset-pagination regression tests. */
  pageSize?: number;
  onError?: (stage: string, error: unknown, details?: Record<string, unknown>) => void;
  onChanged?: (change: {
    kind: "FILL" | "MARK" | "PERFORMANCE";
    enrollmentId?: string;
    pilotId?: string;
    sourceReference: string;
  }) => void;
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function finiteTime(value: string): string | undefined {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : undefined;
}

function positive(value: number): value is number {
  return Number.isFinite(value) && value > 0;
}

function nonNegative(value: number): value is number {
  return Number.isFinite(value) && value >= 0;
}

function positiveAtomic(value: string | undefined): bigint | undefined {
  if (!value || !/^\d+$/u.test(value)) return undefined;
  const amount = BigInt(value);
  return amount > 0n ? amount : undefined;
}

/** Converts an integer token amount without first coercing the integer through
 * Number. Marketplace quantities remain Numbers by contract, but this keeps
 * every decimal digit available until that final boundary. */
function atomicToQuantity(amount: bigint, decimals: number): number | undefined {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 30) return undefined;
  const digits = amount.toString().padStart(decimals + 1, "0");
  const value = decimals === 0
    ? digits
    : `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`;
  const quantity = Number(value);
  return positive(quantity) ? quantity : undefined;
}

function closeEnough(left: number, right: number): boolean {
  const scale = Math.max(1, Math.abs(left), Math.abs(right));
  return Math.abs(left - right) <= QUANTITY_EPSILON * scale;
}

function stableMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function evidenceDigest(...parts: Array<string | number>): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 20);
}

function sum<T>(values: readonly T[], select: (value: T) => number): number {
  return values.reduce((total, value) => total + select(value), 0);
}

/**
 * Serialized, internal-only bridge from committed CopyLab PAPER ledgers into
 * isolated marketplace PAPER accounts. It has no HTTP surface and never calls
 * a broker or signer. Every replay is safe because the destination ledger owns
 * durable source/idempotency constraints.
 */
export class MarketplaceMirrorCoordinator {
  private readonly marketplace: MarketplaceService;
  private readonly stock: StockPaperRepository;
  private readonly pageSize: number;
  private tail: Promise<void> = Promise.resolve();
  private performanceFingerprint: string | undefined;

  constructor(
    private readonly db: CopyLabDatabase,
    private readonly options: MarketplaceMirrorCoordinatorOptions = {}
  ) {
    this.marketplace = new MarketplaceService(db);
    this.stock = new StockPaperRepository(db);
    this.pageSize = Number.isSafeInteger(options.pageSize) && (options.pageSize as number) > 0
      ? Math.min(10_000, options.pageSize as number)
      : DEFAULT_PAGE_SIZE;
  }

  /** Replays committed evidence from both supported source ledgers. */
  reconcileStartup(): Promise<void> {
    return this.enqueue(async () => {
      await this.reconcileStrictLedger();
      this.reconcileStrictMarks();
      await this.reconcileStockLedger();
      this.capturePerformanceEvidence("startup");
    });
  }

  /** The execution id is diagnostic context; the complete committed ledger is
   * replayed so partial exits retain their exact prior source quantity after a
   * restart or duplicated runtime callback. */
  afterStrictPaperExecution(executionId: string): void {
    void this.enqueue(
      async () => {
        await this.reconcileStrictLedger();
        this.reconcileStrictMarks();
        this.capturePerformanceEvidence("strict_execution");
      },
      "strict_execution",
      { executionId }
    );
  }

  /** Invoked after the strict runtime commits fresh executable position marks. */
  afterStrictMarks(): void {
    void this.enqueue(() => {
      this.reconcileStrictMarks();
      this.capturePerformanceEvidence("strict_marks");
    }, "strict_marks");
  }

  /** Called only after StockPaperRepository.commitCycle has returned. */
  afterStockCycle(laneId: string): void {
    void this.enqueue(
      async () => {
        await this.reconcileStockLedger(laneId);
        this.capturePerformanceEvidence("stock_cycle");
      },
      "stock_cycle",
      { laneId }
    );
  }

  /** Captures immutable strategy snapshots from committed source ledgers.
   * This is runtime work, never a side effect of a dashboard GET. */
  afterPerformanceUpdate(source: string): void {
    void this.enqueue(
      () => this.capturePerformanceEvidence(source),
      "performance_evidence",
      { source }
    );
  }

  drain(): Promise<void> {
    return this.tail;
  }

  private enqueue(
    work: () => Promise<void> | void,
    stage = "startup_reconciliation",
    details?: Record<string, unknown>
  ): Promise<void> {
    const task = this.tail.then(work);
    this.tail = task.catch((error) => {
      this.options.onError?.(`marketplace_mirror_${stage}`, error, details);
    });
    return task;
  }

  private currentEnrollment(pilotId: string): MarketplaceEnrollment | undefined {
    return this.marketplace.repository.activeEnrollmentForPilot(pilotId);
  }

  private applyFill(input: ApplyMarketplacePaperFillInput): void {
    const existed = this.marketplace.repository.paperFillByIdempotencyKey(input.idempotencyKey);
    // Source ledgers are replayed from their beginning to rebuild proportional
    // source state. A previously committed destination fill is authoritative;
    // recomputing its quantity from today's remaining destination lot would be
    // both unnecessary and wrong after a prior reduction.
    if (existed) return;
    const fill = this.marketplace.applyPaperFill(input);
    this.options.onChanged?.({
      kind: "FILL",
      enrollmentId: fill.enrollmentId,
      pilotId: fill.pilotId,
      sourceReference: fill.sourceReference
    });
  }

  private applyMark(input: ApplyMarketplacePaperMarkInput): void {
    const existed = this.marketplace.repository.paperMarkByIdempotencyKey(input.idempotencyKey);
    if (existed) return;
    const mark = this.marketplace.markPaperPosition(input);
    this.options.onChanged?.({
      kind: "MARK",
      enrollmentId: mark.enrollmentId,
      pilotId: mark.pilotId,
      sourceReference: mark.sourceReference
    });
  }

  private capturePerformanceEvidence(source: string): void {
    const snapshots = this.marketplace.refreshPerformanceEvidence();
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(snapshots.map((snapshot) => ({
        capturedAt: snapshot.capturedAt,
        netReturnPercent: snapshot.netReturnPercent,
        realizedPnlUsd: snapshot.realizedPnlUsd,
        completedTrades: snapshot.completedTrades,
        openPositions: snapshot.openPositions,
        executablePricingComplete: snapshot.executablePricingComplete
      }))))
      .digest("hex");
    const changed = fingerprint !== this.performanceFingerprint;
    this.performanceFingerprint = fingerprint;
    // Initial HTTP state is fetched after startup. Avoid emitting a synthetic
    // change notification merely because a new process has no in-memory
    // fingerprint yet.
    if (source !== "startup" && snapshots.length > 0 && changed) {
      this.options.onChanged?.({
        kind: "PERFORMANCE",
        sourceReference: `runtime:${source}`
      });
    }
  }

  /** An OPEN belongs to the enrollment state that existed at source time. A
   * later resume cannot retroactively admit an order observed during a pause. */
  private openWasEnabledAt(enrollmentId: string, sourceOccurredAt: string): boolean {
    const row = this.db.prepare(`
      SELECT kind
      FROM marketplace_enrollment_events
      WHERE enrollment_id = ? AND occurred_at <= ?
        AND kind IN ('ENROLLED', 'PAUSED', 'RESUMED', 'UNENROLLED')
      ORDER BY occurred_at DESC, id DESC
      LIMIT 1
    `).get(enrollmentId, sourceOccurredAt) as { kind: string } | undefined;
    return row?.kind === "ENROLLED" || row?.kind === "RESUMED";
  }

  private strictRows(since: string): StrictEvidence[] {
    const query = this.db.prepare(`
      SELECT execution.id AS execution_id, execution.execution_json,
             decision.intent_json, decision.token_json, application.applied_at
      FROM executions execution
      JOIN execution_applications application ON application.execution_id = execution.id
      JOIN signal_decisions decision ON decision.idempotency_key = execution.idempotency_key
      WHERE execution.mode = 'PAPER' AND execution.status = 'CONFIRMED'
        AND application.applied_at >= ?
        AND (
          application.applied_at > ? OR
          (application.applied_at = ? AND execution.id > ?)
        )
      ORDER BY application.applied_at, execution.id
      LIMIT ?
    `);
    const evidence: StrictEvidence[] = [];
    let cursorAt = "";
    let cursorId = "";
    while (true) {
      const rows = query.all(since, cursorAt, cursorAt, cursorId, this.pageSize) as StrictLedgerRow[];
      if (rows.length === 0) break;
      for (const row of rows) {
        try {
          const execution = parseJson<ExecutionRecord>(row.execution_json);
          const intent = parseJson<CopyIntent>(row.intent_json);
          const token = row.token_json ? parseJson<TokenEligibility>(row.token_json) : undefined;
          const appliedAt = finiteTime(row.applied_at);
          if (!appliedAt || execution.mode !== "PAPER" || execution.status !== "CONFIRMED" ||
              execution.id !== row.execution_id || execution.idempotencyKey !== intent.idempotencyKey) continue;
          evidence.push({ execution, intent, ...(token ? { token } : {}), appliedAt });
        } catch {
          // Invalid immutable evidence fails closed, while the scalar keyset
          // cursor still advances so one corrupt row cannot hide later rows.
        }
      }
      const last = rows.at(-1)!;
      cursorAt = last.applied_at;
      cursorId = last.execution_id;
      if (rows.length < this.pageSize) break;
    }
    return evidence;
  }

  private sourceNavAt(at: string): number | undefined {
    const row = this.db.prepare(`
      SELECT snapshot_json
      FROM portfolio_snapshots
      WHERE mode = 'PAPER' AND captured_at <= ?
      ORDER BY captured_at DESC, id DESC
      LIMIT 1
    `).get(at) as { snapshot_json: string } | undefined;
    if (row) {
      try {
        const nav = (parseJson<{ navUsd?: unknown }>(row.snapshot_json)).navUsd;
        if (typeof nav === "number" && positive(nav)) return nav;
      } catch {
        // The immutable row remains unusable rather than being reconstructed.
      }
    }
    const setting = this.db.prepare(`
      SELECT value_json FROM settings WHERE key = 'paper_initial_nav_usd'
    `).get() as { value_json: string } | undefined;
    if (!setting) return undefined;
    try {
      const nav = parseJson<unknown>(setting.value_json);
      return typeof nav === "number" && positive(nav) ? nav : undefined;
    } catch {
      return undefined;
    }
  }

  private stockSourceNavAt(laneId: string, at: string): number | undefined {
    const row = this.db.prepare(`
      SELECT point_json
      FROM stock_paper_equity_points
      WHERE lane_id = ? AND captured_at <= ?
      ORDER BY captured_at DESC
      LIMIT 1
    `).get(laneId, at) as { point_json: string } | undefined;
    if (!row) return undefined;
    try {
      const nav = parseJson<{ navUsd?: unknown }>(row.point_json).navUsd;
      return typeof nav === "number" && positive(nav) ? nav : undefined;
    } catch {
      return undefined;
    }
  }

  private async reconcileStrictLedger(): Promise<void> {
    const enrollment = this.currentEnrollment(STRICT_PILOT_ID);
    if (!enrollment) return;
    const sourcePositions = new Map<string, StrictSourcePosition>();
    for (const evidence of this.strictRows(enrollment.createdAt)) {
      const { execution, intent, token, appliedAt } = evidence;
      const sourceOccurredAt = finiteTime(execution.updatedAt) ?? appliedAt;
      const decimals = token?.decimals;
      if (!Number.isInteger(decimals) || (decimals as number) < 0 || (decimals as number) > 30) {
        continue;
      }
      if (intent.side === "BUY") {
        const receivedAtomic = positiveAtomic(
          execution.actualOutputAtomic ?? execution.quote.outputAmountAtomic
        );
        const sourceQuantity = receivedAtomic
          ? atomicToQuantity(receivedAtomic, decimals as number)
          : undefined;
        if (!receivedAtomic || !sourceQuantity) continue;
        sourcePositions.set(execution.id, {
          decimals: decimals as number,
          remainingAtomic: receivedAtomic
        });
        if (enrollment.status !== "ACTIVE" ||
            !this.openWasEnabledAt(enrollment.id, sourceOccurredAt)) continue;
        const sourceNotionalUsd = execution.quote.inputUsd;
        const sourceNavUsd = this.sourceNavAt(appliedAt);
        if (!positive(sourceNotionalUsd) || !sourceNavUsd) continue;
        const sourcePriceUsd = sourceNotionalUsd / sourceQuantity;
        const targetNotionalUsd = stableMoney(
          this.marketplace.enrollment(enrollment.id)!.account.navUsd * sourceNotionalUsd / sourceNavUsd
        );
        if (!positive(sourcePriceUsd) || !positive(targetNotionalUsd)) continue;
        const targetQuantity = targetNotionalUsd / sourcePriceUsd;
        const sourceCostsUsd = nonNegative(execution.actualFeesUsd ?? 0)
          ? execution.actualFeesUsd ?? 0
          : 0;
        const modeledCostsUsd = stableMoney(sourceCostsUsd * targetNotionalUsd / sourceNotionalUsd);
        try {
          this.applyFill({
            action: "OPEN",
            enrollmentId: enrollment.id,
            assetId: intent.sourceSwap.targetMint,
            sourcePositionReference: `strict:${execution.id}`,
            quantity: targetQuantity,
            priceUsd: sourcePriceUsd,
            modeledCostsUsd,
            sourceReference: `strict:${execution.id}:open`,
            sourceOccurredAt,
            filledAt: sourceOccurredAt,
            idempotencyKey: `marketplace:${enrollment.id}:strict:${execution.id}:open`,
            mode: "PAPER"
          });
        } catch (error) {
          // Insufficient isolated cash is a rejection, never a smaller fill.
          this.options.onError?.("marketplace_mirror_strict_open", error, {
            enrollmentId: enrollment.id,
            executionId: execution.id
          });
        }
        continue;
      }

      const sourcePositionId = intent.sourcePositionId;
      const source = sourcePositionId ? sourcePositions.get(sourcePositionId) : undefined;
      const soldAtomic = positiveAtomic(
        execution.actualInputAtomic ?? intent.inputAmountAtomic
      );
      if (!sourcePositionId || !source || !soldAtomic || soldAtomic > source.remainingAtomic) continue;
      const priorSourceRemaining = source.remainingAtomic;
      source.remainingAtomic -= soldAtomic;
      const targetPosition = this.marketplace.repository.openPaperPositionBySource(
        enrollment.id,
        `strict:${sourcePositionId}`
      );
      if (!targetPosition) continue;
      const soldQuantity = atomicToQuantity(soldAtomic, source.decimals);
      if (!soldQuantity) continue;
      const proceedsAtomic = positiveAtomic(execution.actualOutputAtomic);
      const sourceProceedsUsd = proceedsAtomic
        ? atomicToQuantity(proceedsAtomic, USDC_DECIMALS)
        : execution.quote.outputUsd;
      if (!sourceProceedsUsd || !positive(sourceProceedsUsd)) continue;
      const sourcePriceUsd = sourceProceedsUsd / soldQuantity;
      const complete = source.remainingAtomic === 0n;
      const targetQuantity = complete
        ? targetPosition.quantity
        : targetPosition.quantity * Number(soldAtomic) / Number(priorSourceRemaining);
      const targetGrossUsd = targetQuantity * sourcePriceUsd;
      const sourceCostsUsd = nonNegative(execution.actualFeesUsd ?? 0)
        ? execution.actualFeesUsd ?? 0
        : 0;
      const modeledCostsUsd = stableMoney(sourceCostsUsd * targetGrossUsd / sourceProceedsUsd);
      this.applyFill({
        action: complete ? "CLOSE" : "REDUCE",
        enrollmentId: enrollment.id,
        positionId: targetPosition.id,
        assetId: targetPosition.assetId,
        quantity: targetQuantity,
        priceUsd: sourcePriceUsd,
        modeledCostsUsd,
        sourceReference: `strict:${execution.id}:${complete ? "close" : "reduce"}`,
        sourceOccurredAt,
        filledAt: sourceOccurredAt,
        idempotencyKey: `marketplace:${enrollment.id}:strict:${execution.id}:${complete ? "close" : "reduce"}`,
        mode: "PAPER"
      });
    }
  }

  private reconcileStrictMarks(): void {
    const enrollment = this.currentEnrollment(STRICT_PILOT_ID);
    if (!enrollment) return;
    const query = this.db.prepare(`
      SELECT position.id AS position_id, position.position_json, decision.token_json,
             position.updated_at AS persisted_at
      FROM positions position
      JOIN executions execution ON execution.id = position.id
      JOIN execution_applications application ON application.execution_id = execution.id
      JOIN signal_decisions decision ON decision.idempotency_key = execution.idempotency_key
      WHERE position.mode = 'PAPER' AND position.status IN ('OPEN', 'CLOSING')
        AND execution.mode = 'PAPER' AND execution.status = 'CONFIRMED'
        AND (
          position.updated_at > ? OR
          (position.updated_at = ? AND position.id > ?)
        )
      ORDER BY position.updated_at, position.id
      LIMIT ?
    `);
    let cursorAt = "";
    let cursorId = "";
    while (true) {
      const rows = query.all(cursorAt, cursorAt, cursorId, this.pageSize) as StrictPositionRow[];
      if (rows.length === 0) break;
      for (const row of rows) {
        try {
          const source = parseJson<StrictPositionEvidence>(row.position_json);
          const token = row.token_json ? parseJson<TokenEligibility>(row.token_json) : undefined;
          const decimals = token?.decimals;
          const persistedAt = finiteTime(row.persisted_at);
          const remainingAtomic = positiveAtomic(source.remainingAmountAtomic);
          if (source.id !== row.position_id || source.mode !== "PAPER" ||
              !["OPEN", "CLOSING"].includes(source.status) || !persistedAt || !remainingAtomic ||
              !Number.isInteger(decimals) || (decimals as number) < 0 ||
              (decimals as number) > 30 || !positive(source.lastExecutableValueUsd)) continue;
          const sourceQuantity = atomicToQuantity(remainingAtomic, decimals as number);
          if (!sourceQuantity) continue;
          const target = this.marketplace.repository.openPaperPositionBySource(
            enrollment.id,
            `strict:${source.id}`
          );
          if (!target) continue;
          const priceUsd = source.lastExecutableValueUsd / sourceQuantity;
          if (!positive(priceUsd)) continue;
          const markEvidence = evidenceDigest(
            persistedAt,
            source.remainingAmountAtomic,
            source.lastExecutableValueUsd
          );
          this.applyMark({
            enrollmentId: enrollment.id,
            positionId: target.id,
            assetId: target.assetId,
            priceUsd,
            sourceReference: `strict:${source.id}:mark:${markEvidence}`,
            sourceOccurredAt: persistedAt,
            recordedAt: persistedAt,
            idempotencyKey: `marketplace:${enrollment.id}:strict:${source.id}:mark:${markEvidence}`,
            mode: "PAPER"
          });
        } catch (error) {
          this.options.onError?.("marketplace_mirror_strict_mark", error, {
            enrollmentId: enrollment.id,
            persistedAt: row.persisted_at
          });
        }
      }
      const last = rows.at(-1)!;
      cursorAt = last.persisted_at;
      cursorId = last.position_id;
      if (rows.length < this.pageSize) break;
    }
  }

  private terminalFillEvent(
    order: StockPaperOrder,
    events: readonly StockPaperOrderEvent[]
  ): StockPaperOrderEvent | undefined {
    return events
      .filter((event) => event.orderId === order.id && event.eventType === "FILL" &&
        event.newStatus === "FILLED" && event.fill)
      .sort((left, right) => left.sequence - right.sequence)
      .at(-1);
  }

  private stockOrders(laneId: string, since: string): StockPaperOrder[] {
    const query = this.db.prepare(`
      SELECT id, updated_at, order_json
      FROM stock_paper_orders
      WHERE lane_id = ? AND updated_at >= ?
        AND (updated_at > ? OR (updated_at = ? AND id > ?))
      ORDER BY updated_at, id
      LIMIT ?
    `);
    const result: StockPaperOrder[] = [];
    let cursorAt = "";
    let cursorId = "";
    while (true) {
      const rows = query.all(
        laneId,
        since,
        cursorAt,
        cursorAt,
        cursorId,
        this.pageSize
      ) as StockOrderRow[];
      if (rows.length === 0) break;
      for (const row of rows) {
        try {
          const order = parseJson<StockPaperOrder>(row.order_json);
          if (order.id === row.id && order.laneId === laneId) result.push(order);
        } catch {
          // Fail closed and advance the scalar cursor.
        }
      }
      const last = rows.at(-1)!;
      cursorAt = last.updated_at;
      cursorId = last.id;
      if (rows.length < this.pageSize) break;
    }
    return result;
  }

  private stockEvents(laneId: string, since: string): StockPaperOrderEvent[] {
    const query = this.db.prepare(`
      SELECT id, decision_at, event_json
      FROM stock_paper_order_events
      WHERE lane_id = ? AND decision_at >= ?
        AND (decision_at > ? OR (decision_at = ? AND id > ?))
      ORDER BY decision_at, id
      LIMIT ?
    `);
    const result: StockPaperOrderEvent[] = [];
    let cursorAt = "";
    let cursorId = "";
    while (true) {
      const rows = query.all(
        laneId,
        since,
        cursorAt,
        cursorAt,
        cursorId,
        this.pageSize
      ) as StockEventRow[];
      if (rows.length === 0) break;
      for (const row of rows) {
        try {
          const event = parseJson<StockPaperOrderEvent>(row.event_json);
          if (event.id === row.id && event.laneId === laneId) result.push(event);
        } catch {
          // Fail closed and advance the scalar cursor.
        }
      }
      const last = rows.at(-1)!;
      cursorAt = last.decision_at;
      cursorId = last.id;
      if (rows.length < this.pageSize) break;
    }
    return result;
  }

  private openStockPositions(laneId: string): StockPaperPosition[] {
    const query = this.db.prepare(`
      SELECT id, updated_at, position_json
      FROM stock_paper_positions
      WHERE lane_id = ? AND status IN ('OPEN', 'UNPRICED')
        AND (updated_at > ? OR (updated_at = ? AND id > ?))
      ORDER BY updated_at, id
      LIMIT ?
    `);
    const result: StockPaperPosition[] = [];
    let cursorAt = "";
    let cursorId = "";
    while (true) {
      const rows = query.all(
        laneId,
        cursorAt,
        cursorAt,
        cursorId,
        this.pageSize
      ) as StockPositionRow[];
      if (rows.length === 0) break;
      for (const row of rows) {
        try {
          const position = parseJson<StockPaperPosition>(row.position_json);
          if (position.id === row.id && position.laneId === laneId) result.push(position);
        } catch {
          // Fail closed and advance the scalar cursor.
        }
      }
      const last = rows.at(-1)!;
      cursorAt = last.updated_at;
      cursorId = last.id;
      if (rows.length < this.pageSize) break;
    }
    return result;
  }

  private validFilledStockOrder(
    order: StockPaperOrder,
    events: readonly StockPaperOrderEvent[]
  ): { event: StockPaperOrderEvent; quantity: number; grossUsd: number; costsUsd: number; priceUsd: number } | undefined {
    if (order.status !== "FILLED" || !order.positionId || order.fills.length === 0 ||
        !positive(order.requestedQuantity) || !positive(order.filledQuantity) ||
        !closeEnough(order.filledQuantity, order.requestedQuantity)) return undefined;
    const event = this.terminalFillEvent(order, events);
    if (!event) return undefined;
    const quantity = sum(order.fills, (fill) => fill.quantity);
    const grossUsd = sum(order.fills, (fill) => fill.notionalUsd);
    const costsUsd = sum(order.fills, (fill) => fill.modeledCostsUsd);
    if (!positive(quantity) || !positive(grossUsd) || !nonNegative(costsUsd) ||
        !closeEnough(quantity, order.filledQuantity)) return undefined;
    const priceUsd = grossUsd / quantity;
    return positive(priceUsd) ? { event, quantity, grossUsd, costsUsd, priceUsd } : undefined;
  }

  private async reconcileStockLedger(expectedLaneId?: string): Promise<void> {
    const enrollment = this.currentEnrollment(STOCK_PILOT_ID);
    if (!enrollment) return;
    const lane = this.stock.activeLane();
    if (!lane || (expectedLaneId && lane.id !== expectedLaneId)) return;
    const account = this.stock.account(lane.id);
    if (!account) return;
    const orders = this.stockOrders(lane.id, enrollment.createdAt);
    const events = this.stockEvents(lane.id, enrollment.createdAt);
    const sourceRemaining = new Map<string, number>();

    for (const order of orders) {
      const evidence = this.validFilledStockOrder(order, events);
      if (!evidence) continue; // Partial and unfilled orders are never mirrored.
      const sourceOccurredAt = finiteTime(evidence.event.decisionAt) ??
        finiteTime(order.updatedAt);
      if (!sourceOccurredAt || !order.positionId) continue;
      if (order.side === "BUY") {
        sourceRemaining.set(order.positionId, evidence.quantity);
        if (enrollment.status !== "ACTIVE" ||
            !this.openWasEnabledAt(enrollment.id, sourceOccurredAt)) continue;
        const refreshed = this.marketplace.enrollment(enrollment.id);
        if (!refreshed) return;
        const sourceNavUsd = this.stockSourceNavAt(lane.id, sourceOccurredAt);
        if (!sourceNavUsd) continue;
        const targetNotionalUsd = stableMoney(
          refreshed.account.navUsd * evidence.grossUsd / sourceNavUsd
        );
        if (!positive(targetNotionalUsd)) continue;
        const targetQuantity = targetNotionalUsd / evidence.priceUsd;
        const modeledCostsUsd = stableMoney(
          evidence.costsUsd * targetNotionalUsd / evidence.grossUsd
        );
        try {
          this.applyFill({
            action: "OPEN",
            enrollmentId: enrollment.id,
            assetId: order.symbol,
            sourcePositionReference: `stock:${order.positionId}`,
            quantity: targetQuantity,
            priceUsd: evidence.priceUsd,
            modeledCostsUsd,
            sourceReference: `stock:${order.id}:open`,
            sourceOccurredAt,
            filledAt: sourceOccurredAt,
            idempotencyKey: `marketplace:${enrollment.id}:stock:${order.id}:open`,
            mode: "PAPER"
          });
        } catch (error) {
          this.options.onError?.("marketplace_mirror_stock_open", error, {
            enrollmentId: enrollment.id,
            orderId: order.id
          });
        }
        continue;
      }

      const priorRemaining = sourceRemaining.get(order.positionId);
      if (typeof priorRemaining !== "number" || !positive(priorRemaining) ||
          evidence.quantity > priorRemaining + QUANTITY_EPSILON) continue;
      const remaining = Math.max(0, priorRemaining - evidence.quantity);
      sourceRemaining.set(order.positionId, remaining);
      const targetPosition = this.marketplace.repository.openPaperPositionBySource(
        enrollment.id,
        `stock:${order.positionId}`
      );
      if (!targetPosition) continue;
      const complete = closeEnough(evidence.quantity, priorRemaining);
      const targetQuantity = complete
        ? targetPosition.quantity
        : targetPosition.quantity * evidence.quantity / priorRemaining;
      const targetGrossUsd = targetQuantity * evidence.priceUsd;
      const modeledCostsUsd = stableMoney(
        evidence.costsUsd * targetGrossUsd / evidence.grossUsd
      );
      this.applyFill({
        action: complete ? "CLOSE" : "REDUCE",
        enrollmentId: enrollment.id,
        positionId: targetPosition.id,
        assetId: targetPosition.assetId,
        quantity: targetQuantity,
        priceUsd: evidence.priceUsd,
        modeledCostsUsd,
        sourceReference: `stock:${order.id}:${complete ? "close" : "reduce"}`,
        sourceOccurredAt,
        filledAt: sourceOccurredAt,
        idempotencyKey: `marketplace:${enrollment.id}:stock:${order.id}:${complete ? "close" : "reduce"}`,
        mode: "PAPER"
      });
    }

    // Marks come only from the source position row committed by the completed
    // cycle. UNPRICED/CLOSED rows cannot manufacture an executable mark.
    for (const source of this.openStockPositions(lane.id)) {
      this.markStockPosition(enrollment.id, source);
    }
  }

  private markStockPosition(enrollmentId: string, source: StockPaperPosition): void {
    if (source.status !== "OPEN" || !positive(source.quantity) ||
        !positive(source.lastExecutableValueUsd ?? 0)) return;
    const sourceOccurredAt = finiteTime(source.updatedAt);
    if (!sourceOccurredAt) return;
    const target = this.marketplace.repository.openPaperPositionBySource(
      enrollmentId,
      `stock:${source.id}`
    );
    if (!target) return;
    const priceUsd = (source.lastExecutableValueUsd as number) / source.quantity;
    if (!positive(priceUsd)) return;
    const markEvidence = evidenceDigest(
      source.updatedAt,
      source.quantity,
      source.lastExecutableValueUsd as number
    );
    this.applyMark({
      enrollmentId,
      positionId: target.id,
      assetId: target.assetId,
      priceUsd,
      sourceReference: `stock:${source.id}:mark:${markEvidence}`,
      sourceOccurredAt,
      recordedAt: sourceOccurredAt,
      idempotencyKey: `marketplace:${enrollmentId}:stock:${source.id}:mark:${markEvidence}`,
      mode: "PAPER"
    });
  }
}
