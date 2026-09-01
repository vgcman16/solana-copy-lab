import { randomUUID } from "node:crypto";
import {
  SOL_MINT,
  type IndexedSpotSwap,
  type WalletIndexTransaction
} from "@copylab/shared";
import {
  HeliusProgramIndexer,
  HeliusRpcBudgetError,
  ProviderApiError,
  confirmedTransactionMetadata,
  hasParsedSpotSwapSafetyInstructions,
  redactSensitiveText,
  type HeliusIndexRpc,
  type IndexedSpotSwapObservation
} from "@copylab/providers";
import type { EventBus } from "./events.js";
import { ParsedBlockRepairRepository } from "./parsed-block-repair-repository.js";
import {
  PARSED_BLOCK_REPAIR_DECODER_VERSION,
  type ParsedBlockHydrationProvenance,
  type ParsedBlockRepairItem
} from "./parsed-block-repair-types.js";

const MAX_BLOCK_TRANSACTIONS = 10_000;
const MAX_TRANSACTION_PREFETCH = 8;
const DEFAULT_TRANSACTION_PREFETCH = 4;
const SWAPS_PER_EVENT_LOOP_YIELD = 25;
const COVERAGE_PUBLISH_INTERVAL_MS = 5_000;

type TransactionHydrationResult =
  | { readonly ok: true; readonly raw: unknown | null }
  | { readonly ok: false; readonly error: unknown };

export interface ParsedBlockRepairWorkerOptions {
  rpc: HeliusIndexRpc;
  programIds: ReadonlySet<string>;
  batchSize?: number;
  /**
   * A jsonParsed Solana block can be hundreds of megabytes. Parsing that
   * response happens synchronously inside fetch's JSON decoder and can starve
   * the loopback UI for tens of seconds. Historical repair therefore uses the
   * bounded per-signature path by default. This opt-in remains available for
   * small/self-hosted block responses and deterministic fixture coverage.
   */
  blockPrefetchEnabled?: boolean;
  /**
   * Maximum number of per-signature reads allowed to wait in the RPC
   * client's existing rate-limited queue. Network hydration may overlap, but
   * decoding and every SQLite mutation remain deterministic and sequential.
   */
  transactionPrefetch?: number;
  requestsPerTurnDelayMs?: number;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
  solPriceUsdResolver?: (at: string) => Promise<number>;
}

function errorText(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error), 1_000);
}

function firstSignature(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const transaction = (value as Record<string, unknown>).transaction;
  if (!transaction || typeof transaction !== "object" || Array.isArray(transaction)) return undefined;
  const signatures = (transaction as Record<string, unknown>).signatures;
  return Array.isArray(signatures) && typeof signatures[0] === "string" ? signatures[0] : undefined;
}

function parsedBlockTransactions(
  block: unknown,
  slot: number,
  wanted: ReadonlySet<string>
): Map<string, unknown> {
  if (!block || typeof block !== "object" || Array.isArray(block)) return new Map();
  const record = block as Record<string, unknown>;
  const blockTime = record.blockTime;
  const transactions = record.transactions;
  if (
    typeof blockTime !== "number" ||
    !Number.isSafeInteger(blockTime) ||
    blockTime < 0 ||
    blockTime > 8_640_000_000_000 ||
    !Array.isArray(transactions) ||
    transactions.length > MAX_BLOCK_TRANSACTIONS
  ) return new Map();
  const mapped = new Map<string, unknown>();
  const duplicates = new Set<string>();
  for (const entry of transactions) {
    const signature = firstSignature(entry);
    if (!signature || !wanted.has(signature) || duplicates.has(signature)) continue;
    if (mapped.has(signature)) {
      mapped.delete(signature);
      duplicates.add(signature);
      continue;
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const augmented = { ...(entry as Record<string, unknown>), slot, blockTime };
    if (!confirmedTransactionMetadata(augmented)) continue;
    // The unchanged strict decoder depends on parsed Token/System/ATA safety
    // instructions. An RPC that ignored jsonParsed is a per-signature fallback,
    // never a reason to reinterpret raw instructions more permissively.
    if (!hasParsedSpotSwapSafetyInstructions(augmented)) continue;
    mapped.set(signature, augmented);
  }
  return mapped;
}

export class ParsedBlockRepairWorker {
  private readonly workerId = `parsed-block-repair-${randomUUID()}`;
  private readonly batchSize: number;
  private readonly idleDelayMs: number;
  private readonly now: () => Date;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly indexer: HeliusProgramIndexer;
  private readonly rpc: HeliusIndexRpc;
  private readonly blockPrefetchEnabled: boolean;
  private readonly transactionPrefetch: number;
  private readonly solPriceUsdResolver: ((at: string) => Promise<number>) | undefined;
  private lastCoveragePublishedAtMs = Number.NEGATIVE_INFINITY;
  private stopped = false;
  private loopPromise: Promise<void> | undefined;
  private wakeIdle: (() => void) | undefined;

  constructor(
    private readonly repair: ParsedBlockRepairRepository,
    private readonly events: EventBus | undefined,
    options: ParsedBlockRepairWorkerOptions
  ) {
    if (options.programIds.size === 0) throw new Error("Parsed-block repair requires an approved program set.");
    this.batchSize = Math.max(1, Math.min(250, Math.trunc(options.batchSize ?? 250)));
    this.idleDelayMs = Math.max(1_000, Math.min(60_000, Math.trunc(options.requestsPerTurnDelayMs ?? 10_000)));
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.rpc = options.rpc;
    this.blockPrefetchEnabled = options.blockPrefetchEnabled === true;
    const transactionPrefetch = options.transactionPrefetch ?? DEFAULT_TRANSACTION_PREFETCH;
    if (!Number.isFinite(transactionPrefetch) || transactionPrefetch < 1) {
      throw new RangeError("Parsed-block repair transactionPrefetch must be a positive finite number.");
    }
    this.transactionPrefetch = Math.min(MAX_TRANSACTION_PREFETCH, Math.trunc(transactionPrefetch));
    this.solPriceUsdResolver = options.solPriceUsdResolver;
    this.indexer = new HeliusProgramIndexer(options.rpc, {
      programIds: options.programIds,
      now: this.now
    });
  }

  start(): void {
    if (this.loopPromise) return;
    this.stopped = false;
    this.loopPromise = this.loop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.wakeIdle?.();
    await this.loopPromise;
    this.loopPromise = undefined;
  }

  async runOnce(): Promise<boolean> {
    this.repair.recoverExpiredLeases(this.now());
    const manifest = this.repair.activeManifest();
    if (!manifest) return false;
    const items = this.repair.leaseNextSlot(
      manifest.id,
      this.workerId,
      this.batchSize,
      120,
      this.now()
    );
    if (items.length === 0) {
      this.repair.refreshManifestStatus(manifest.id, this.now());
      return false;
    }

    let prefetched = new Map<string, unknown>();
    const getBlock = this.blockPrefetchEnabled ? this.rpc.getBlock?.bind(this.rpc) : undefined;
    if (getBlock) {
      try {
        const block = await getBlock(items[0]?.slot ?? -1);
        prefetched = parsedBlockTransactions(
          block,
          items[0]?.slot ?? -1,
          new Set(items.map((item) => item.signature))
        );
      } catch (error) {
        // A block request is an optimization only. Budget exhaustion is not
        // converted into hundreds of transaction requests; other failures use
        // the bounded, existing per-signature fallback.
        if (error instanceof HeliusRpcBudgetError) {
          for (const item of items) this.repair.retry(item, error, 60_000, 48, this.now());
          return true;
        }
      }
    }

    // Queue only a small sliding window through the RPC client's existing
    // limiter. The promises capture failures as values so an item that fails
    // before its turn cannot produce an unhandled rejection. Repository
    // apply/retry calls stay in the frozen manifest order below.
    const transactionFetches = new Map<number, Promise<TransactionHydrationResult>>();
    let nextPrefetchIndex = 0;
    const fillTransactionPrefetch = (): void => {
      while (
        transactionFetches.size < this.transactionPrefetch &&
        nextPrefetchIndex < items.length
      ) {
        const itemIndex = nextPrefetchIndex;
        nextPrefetchIndex += 1;
        const item = items[itemIndex];
        if (!item || prefetched.has(item.signature)) continue;
        transactionFetches.set(
          itemIndex,
          this.rpc.getTransaction(item.signature).then<TransactionHydrationResult, TransactionHydrationResult>(
            (raw) => ({ ok: true, raw }),
            (error: unknown) => ({ ok: false, error })
          )
        );
      }
    };
    fillTransactionPrefetch();

    for (const [itemIndex, item] of items.entries()) {
      try {
        const fromBlock = prefetched.get(item.signature);
        const provenance: ParsedBlockHydrationProvenance = fromBlock
          ? "PARSED_BLOCK_REPAIR"
          : "PARSED_TRANSACTION_REPAIR_FALLBACK";
        let raw = fromBlock;
        if (!raw) {
          const pending = transactionFetches.get(itemIndex);
          if (!pending) throw new Error("Repair transaction prefetch window lost its frozen manifest item.");
          const hydration = await pending;
          transactionFetches.delete(itemIndex);
          fillTransactionPrefetch();
          if (!hydration.ok) throw hydration.error;
          raw = hydration.raw;
        }
        if (raw === null) throw new Error("Confirmed repair transaction is temporarily unavailable.");
        if (firstSignature(raw) !== item.signature) {
          throw new Error("Repair RPC response signature does not match its frozen manifest item.");
        }
        const metadata = confirmedTransactionMetadata(raw);
        if (!metadata || !metadata.success || metadata.slot !== item.slot) {
          throw new Error("Repair RPC response has invalid successful transaction metadata.");
        }
        if (!hasParsedSpotSwapSafetyInstructions(raw)) {
          throw new Error("Repair RPC response did not preserve jsonParsed safety instructions.");
        }

        const programs = item.sourcePrograms.filter((program) => this.indexer.listPrograms().includes(program));
        if (programs.length === 0) throw new Error("Repair item has no approved frozen program source.");
        const observations = new Map<string, IndexedSpotSwapObservation>();
        for (const program of programs) {
          for (const observation of this.indexer.decodeProgramTransaction(
            program,
            item.signature,
            raw,
            this.now()
          )) {
            observations.set(
              `${observation.wallet}:${observation.targetMint}:${observation.side}`,
              observation
            );
          }
        }
        const swaps: IndexedSpotSwap[] = [];
        for (const [index, observation] of [...observations.values()].entries()) {
          swaps.push(await this.toIndexedSwap(observation, index, metadata.programIds));
          if ((index + 1) % SWAPS_PER_EVENT_LOOP_YIELD === 0) await this.yieldToEventLoop();
        }
        const transaction: WalletIndexTransaction = {
          signature: item.signature,
          status: "PROCESSED",
          attempts: item.attempts,
          priority: 0,
          discoveredAt: item.createdAt,
          availableAt: item.availableAt,
          updatedAt: this.now().toISOString(),
          sourceWallets: [...new Set(swaps.map((swap) => swap.wallet))],
          slot: metadata.slot,
          blockTime: metadata.blockTime,
          success: true,
          ...(metadata.feePayer ? { feePayer: metadata.feePayer } : {}),
          accountKeys: metadata.accountKeys,
          programIds: metadata.programIds,
          ...(metadata.transactionVersion ? { transactionVersion: metadata.transactionVersion } : {}),
          indexedAt: item.sourceIndexedAt,
          processedAt: item.sourceIndexedAt
        };
        this.repair.apply({
          item,
          transaction,
          swaps,
          provenance,
          decoderVersion: PARSED_BLOCK_REPAIR_DECODER_VERSION,
          at: this.now()
        });
      } catch (error) {
        const providerFailure = error instanceof ProviderApiError;
        const delay = providerFailure && error.retryable
          ? Math.min(6 * 60 * 60_000, 30_000 * 2 ** Math.min(10, item.attempts - 1))
          : 30_000;
        this.repair.retry(item, error, delay, providerFailure && error.retryable ? 48 : 8, this.now());
      }
      await this.yieldToEventLoop();
    }

    const coverageAt = this.now();
    const manifestAfter = this.repair.getManifest(manifest.id);
    const terminal = manifestAfter?.status === "COMPLETE" || manifestAfter?.status === "FAILED";
    // Full status coverage scans the frozen manifest. That is useful dashboard
    // telemetry, but not safety state and does not need to run after every
    // one- or two-item slot. Keep progress fresh to five seconds and always
    // publish terminal coverage immediately.
    if (
      terminal ||
      coverageAt.getTime() - this.lastCoveragePublishedAtMs >= COVERAGE_PUBLISH_INTERVAL_MS
    ) {
      const coverage = this.repair.coverage(manifest.id, coverageAt);
      this.lastCoveragePublishedAtMs = coverageAt.getTime();
      this.events?.publish("parsed-block-repair", coverage);
      if (terminal) this.repairAuditFinished(coverage);
    }
    return true;
  }

  private repairAuditFinished(coverage: ReturnType<ParsedBlockRepairRepository["coverage"]>): void {
    const manifest = coverage.manifest;
    if (!manifest) return;
    // The repository's audit sink is intentionally not exposed here. Publish
    // an immutable terminal event; Runtime records the corresponding startup
    // and terminal status in its existing event/audit lifecycle.
    this.events?.publish("parsed-block-repair-finished", {
      manifestId: manifest.id,
      status: manifest.status,
      recovered: coverage.recovered,
      validZero: coverage.validZero,
      failed: coverage.failed,
      recoveredSwaps: coverage.recoveredSwaps
    });
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        const progressed = await this.runOnce();
        if (!progressed) await this.interruptibleSleep(this.idleDelayMs);
        else await new Promise<void>((resolve) => setImmediate(resolve));
      } catch {
        // Every item-level failure is persisted by runOnce. An unexpected loop
        // failure waits before retrying so it cannot create a hot provider loop.
        await this.interruptibleSleep(this.idleDelayMs);
      }
    }
  }

  private async interruptibleSleep(milliseconds: number): Promise<void> {
    await Promise.race([
      this.sleep(milliseconds),
      new Promise<void>((resolve) => {
        this.wakeIdle = resolve;
      })
    ]);
    this.wakeIdle = undefined;
  }

  private async yieldToEventLoop(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  private async toIndexedSwap(
    observation: IndexedSpotSwapObservation,
    swapIndex: number,
    programIds: string[]
  ): Promise<IndexedSpotSwap> {
    const buying = observation.side === "BUY";
    let baseValueUsd = observation.baseValueUsd;
    if (baseValueUsd === undefined && observation.baseMint === SOL_MINT && this.solPriceUsdResolver) {
      try {
        const price = await this.solPriceUsdResolver(observation.blockTime);
        const resolved = observation.baseAmountUi * price;
        if (Number.isFinite(resolved) && resolved > 0) baseValueUsd = resolved;
      } catch {
        // The existing durable SOL reprice queue keeps an unpriced recovered
        // swap out of ranking until exact at-or-before evidence is available.
      }
    }
    return {
      id: `${observation.sourceSignature}:${observation.wallet}:${swapIndex}`,
      signature: observation.sourceSignature,
      wallet: observation.wallet,
      swapIndex,
      slot: observation.slot,
      blockTime: observation.blockTime,
      side: observation.side,
      baseMint: observation.baseMint,
      targetMint: observation.targetMint,
      inputMint: buying ? observation.baseMint : observation.targetMint,
      outputMint: buying ? observation.targetMint : observation.baseMint,
      inputAmountAtomic: buying ? observation.baseAmountAtomic : observation.targetAmountAtomic,
      outputAmountAtomic: buying ? observation.targetAmountAtomic : observation.baseAmountAtomic,
      inputAmountUi: buying ? observation.baseAmountUi : observation.targetAmountUi,
      outputAmountUi: buying ? observation.targetAmountUi : observation.baseAmountUi,
      eligible: true,
      eligibilityReasons: [],
      programIds,
      indexedAt: observation.indexedAt,
      ...(baseValueUsd !== undefined && observation.targetAmountUi > 0
        ? { priceUsd: baseValueUsd / observation.targetAmountUi }
        : {})
    };
  }
}
