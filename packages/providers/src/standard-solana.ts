import {
  SOL_MINT,
  USDC_MINT,
  type ChainObserver,
  type IsoDateTime,
  type LeaderSwap,
  type PublicKeyString,
  type TransactionSignature,
  type Unsubscribe,
  type WalletHistorySummary
} from "@copylab/shared";
import {
  DEFAULT_SPOT_SWAP_PROGRAM_IDS,
  decodeSpotSwapTransactionResult,
  decodeWalletTokenDecreases,
  type RejectedSwapObservation,
  type WalletTokenDecreaseObservation
} from "./helius-decoder.js";
import { asRecord, finiteNumber, redactSensitiveText, stringValue, type FetchLike } from "./http.js";
import {
  StandardSolanaRpcClient,
  assertSolanaWebSocketEndpoint,
  type SolanaSignatureInfo,
  type StandardSolanaRpcUsage
} from "./standard-solana-rpc.js";

const DAY_MS = 86_400_000;
const WEBSOCKET_HEALTH_PROBE_ADDRESS = "11111111111111111111111111111111";
const DEFAULT_WEBSOCKET_HEALTH_TIMEOUT_MS = 5_000;
const DEFAULT_ARCHIVE_BOUNDARY_SCAN_SLOTS = 64;
// WHATWG clients cannot send reserved protocol close code 1011. Use an
// application-defined code so Node/undici closes fail-closed instead of
// throwing an uncaught InvalidAccessError that terminates the process.
const CLIENT_STREAM_ERROR_CLOSE_CODE = 4000;

export interface StandardSolanaWebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "close" | "error" | "message", listener: (event: any) => void): void;
}

export interface StandardSolanaObserverOptions {
  httpUrl: string;
  wsUrl: string;
  fetch?: FetchLike;
  websocketFactory?: (url: string) => StandardSolanaWebSocketLike;
  timeoutMs?: number;
  requestsPerSecond?: number;
  maximumRetries?: number;
  retryBaseMs?: number;
  maximumRetryDelayMs?: number;
  maxHistoryPages?: number;
  historyPageSize?: number;
  maximumHistoryTransactions?: number;
  historyHydrationConcurrency?: number;
  /** Bounded skipped-slot scan used to prove the retained archive reaches a history cutoff. */
  archiveBoundaryScanSlots?: number;
  reconnectBaseMs?: number;
  reconnectMaximumMs?: number;
  heartbeatMs?: number;
  subscriptionAckTimeoutMs?: number;
  livenessTimeoutMs?: number;
  hydrationRetries?: number;
  hydrationRetryMs?: number;
  transactionCacheSize?: number;
  allowedSpotProgramIds?: ReadonlySet<string>;
  /** Required by summarizeHistory because standard RPC has no identity labels. */
  walletTagResolver?: (address: PublicKeyString) => Promise<string[]>;
  /** Required only for SOL-legged swaps; receives the swap's block time. */
  solPriceUsdResolver?: (at: IsoDateTime) => Promise<number>;
  jitter?: () => number;
  now?: () => Date;
  monotonicNow?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  onError?: (error: Error) => void;
  /** Audit-only rejected swap-like activity. This callback can never emit an executable swap. */
  onRejectedSwap?: (rejection: RejectedSwapObservation) => Promise<void> | void;
  /** Isolated research-only inventory evidence; never emits an executable swap. */
  onTokenDecrease?: (observation: WalletTokenDecreaseObservation) => Promise<void> | void;
  onRequest?: (usage: StandardSolanaRpcUsage) => void;
  tryReserveRequest?: (usage: StandardSolanaRpcUsage) => boolean;
}

export interface StandardSolanaHealth {
  provider: "solana-rpc";
  ok: boolean;
  checkedAt: IsoDateTime;
  latencyMs: number;
  message: string;
  usage: { requests: number; window: "process" };
}

export interface StandardSolanaStreamStatus {
  active: boolean;
  connected: boolean;
  ready: boolean;
  gapRepairPending: boolean;
  gapRepairFailed: boolean;
  lastMessageAt?: IsoDateTime;
}

export interface StandardSolanaStreamHealth extends StandardSolanaHealth, StandardSolanaStreamStatus {}

interface HistorySignatures {
  signatures: SolanaSignatureInfo[];
  reachedCutoff: boolean;
  exhausted: boolean;
  truncated: boolean;
  oldestKnownTime?: number;
}

interface SubscriptionState {
  addresses: string[];
  onSwap: (swap: LeaderSwap) => Promise<void>;
  stopped: boolean;
  socket: StandardSolanaWebSocketLike | undefined;
  reconnectAttempt: number;
  reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  ackTimer: ReturnType<typeof setTimeout> | undefined;
  everOpened: boolean;
  needsGapRepair: boolean;
  repairOnAck: boolean;
  gapRepairPending: boolean;
  gapRepairFailed: boolean;
  connectedAt: number | undefined;
  lastMessageAt: number | undefined;
  pendingRequests: Map<number, string>;
  subscriptionWallets: Map<number, string>;
  lastSeenAt: Map<string, Date>;
  pendingLiveSignatures: Map<string, PendingLiveSignature>;
  processingTail: Promise<void>;
}

interface PendingLiveSignature {
  signature: string;
  wallet: string;
  key: string;
  detectedAt: Date;
}

function positiveInteger(value: number, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${label} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function positiveFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${label} must be positive`);
  return value;
}

function validTimestamp(value: string): Date {
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) throw new Error(`Invalid ISO timestamp: ${value}`);
  return timestamp;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const right = sorted[middle] ?? 0;
  return sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? right) + right) / 2 : right;
}

function eventDataToString(data: unknown): Promise<string | undefined> {
  if (typeof data === "string") return Promise.resolve(data);
  if (data instanceof ArrayBuffer) return Promise.resolve(new TextDecoder().decode(data));
  if (ArrayBuffer.isView(data)) return Promise.resolve(new TextDecoder().decode(data));
  if (typeof Blob !== "undefined" && data instanceof Blob) return data.text();
  return Promise.resolve(undefined);
}

/**
 * ChainObserver backed only by standard Solana JSON-RPC and WebSocket methods.
 * No Helius key, enhanced transaction endpoint, or wallet-history endpoint is
 * used. Missing off-chain identity or price inputs reject data rather than
 * making qualification less strict.
 */
export class StandardSolanaObserver implements ChainObserver {
  private readonly wsUrl: string;
  private readonly rpc: StandardSolanaRpcClient;
  private readonly websocketFactory: (url: string) => StandardSolanaWebSocketLike;
  private readonly maxHistoryPages: number;
  private readonly historyPageSize: number;
  private readonly maximumHistoryTransactions: number;
  private readonly historyHydrationConcurrency: number;
  private readonly archiveBoundaryScanSlots: number;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaximumMs: number;
  private readonly heartbeatMs: number;
  private readonly subscriptionAckTimeoutMs: number;
  private readonly livenessTimeoutMs: number;
  private readonly hydrationRetries: number;
  private readonly hydrationRetryMs: number;
  private readonly transactionCacheSize: number;
  private readonly allowedSpotProgramIds: ReadonlySet<string>;
  private readonly walletTagResolver: ((address: PublicKeyString) => Promise<string[]>) | undefined;
  private readonly solPriceUsdResolver: ((at: IsoDateTime) => Promise<number>) | undefined;
  private readonly now: () => Date;
  private readonly monotonicNow: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly onError: (error: Error) => void;
  private readonly onRejectedSwap: (rejection: RejectedSwapObservation) => Promise<void> | void;
  private readonly onTokenDecrease:
    (observation: WalletTokenDecreaseObservation) => Promise<void> | void;
  private readonly observesWalletTokenDecreases: boolean;
  private readonly onUsage: (usage: StandardSolanaRpcUsage) => void;
  private readonly tryReserveWebSocketRequest: (usage: StandardSolanaRpcUsage) => boolean;
  private requestCount = 0;
  private websocketRequestId = 1;
  private activeSubscription: SubscriptionState | undefined;
  private lastStreamMessageAt: number | undefined;
  private readonly seenSignatures = new Map<string, number>();
  private readonly inFlightSignatures = new Set<string>();
  private readonly transactionCache = new Map<string, unknown>();
  private readonly inFlightTransactions = new Map<string, Promise<unknown>>();

  constructor(options: StandardSolanaObserverOptions) {
    this.wsUrl = assertSolanaWebSocketEndpoint(options.wsUrl);
    this.websocketFactory = options.websocketFactory ??
      ((url) => new WebSocket(url) as unknown as StandardSolanaWebSocketLike);
    this.maxHistoryPages = positiveInteger(options.maxHistoryPages ?? 100, "maxHistoryPages", 10_000);
    this.historyPageSize = positiveInteger(options.historyPageSize ?? 1_000, "historyPageSize", 1_000);
    this.maximumHistoryTransactions = positiveInteger(
      options.maximumHistoryTransactions ?? 20_000,
      "maximumHistoryTransactions",
      1_000_000
    );
    this.historyHydrationConcurrency = positiveInteger(
      options.historyHydrationConcurrency ?? 4,
      "historyHydrationConcurrency",
      32
    );
    this.archiveBoundaryScanSlots = positiveInteger(
      options.archiveBoundaryScanSlots ?? DEFAULT_ARCHIVE_BOUNDARY_SCAN_SLOTS,
      "archiveBoundaryScanSlots",
      10_000
    );
    this.reconnectBaseMs = positiveFinite(options.reconnectBaseMs ?? 1_000, "reconnectBaseMs");
    this.reconnectMaximumMs = positiveFinite(
      options.reconnectMaximumMs ?? 30_000,
      "reconnectMaximumMs"
    );
    if (this.reconnectMaximumMs < this.reconnectBaseMs) {
      throw new RangeError("reconnectMaximumMs must be at least reconnectBaseMs");
    }
    this.heartbeatMs = positiveFinite(options.heartbeatMs ?? 60_000, "heartbeatMs");
    this.subscriptionAckTimeoutMs = positiveFinite(
      options.subscriptionAckTimeoutMs ?? 10_000,
      "subscriptionAckTimeoutMs"
    );
    this.livenessTimeoutMs = positiveFinite(options.livenessTimeoutMs ?? 90_000, "livenessTimeoutMs");
    if (this.livenessTimeoutMs < this.heartbeatMs) {
      throw new RangeError("livenessTimeoutMs must be at least heartbeatMs");
    }
    this.hydrationRetries = positiveInteger(options.hydrationRetries ?? 3, "hydrationRetries", 20);
    this.hydrationRetryMs = options.hydrationRetryMs ?? 250;
    if (!Number.isFinite(this.hydrationRetryMs) || this.hydrationRetryMs < 0) {
      throw new RangeError("hydrationRetryMs must be non-negative");
    }
    this.transactionCacheSize = positiveInteger(
      options.transactionCacheSize ?? 10_000,
      "transactionCacheSize",
      100_000
    );
    this.allowedSpotProgramIds = options.allowedSpotProgramIds ?? DEFAULT_SPOT_SWAP_PROGRAM_IDS;
    this.walletTagResolver = options.walletTagResolver;
    this.solPriceUsdResolver = options.solPriceUsdResolver;
    this.now = options.now ?? (() => new Date());
    this.monotonicNow = options.monotonicNow ?? Date.now;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.onError = options.onError ?? (() => undefined);
    this.onRejectedSwap = options.onRejectedSwap ?? (() => undefined);
    this.observesWalletTokenDecreases = options.onTokenDecrease !== undefined;
    this.onTokenDecrease = options.onTokenDecrease ?? (() => undefined);
    this.onUsage = options.onRequest ?? (() => undefined);
    this.tryReserveWebSocketRequest = options.tryReserveRequest ?? (() => true);
    this.rpc = new StandardSolanaRpcClient({
      httpUrl: options.httpUrl,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.requestsPerSecond !== undefined ? { requestsPerSecond: options.requestsPerSecond } : {}),
      ...(options.maximumRetries !== undefined ? { maximumRetries: options.maximumRetries } : {}),
      ...(options.retryBaseMs !== undefined ? { retryBaseMs: options.retryBaseMs } : {}),
      ...(options.maximumRetryDelayMs !== undefined
        ? { maximumRetryDelayMs: options.maximumRetryDelayMs }
        : {}),
      ...(options.jitter ? { jitter: options.jitter } : {}),
      now: this.monotonicNow,
      sleep: this.sleep,
      onRequest: (usage) => {
        this.requestCount += 1;
        this.onUsage(usage);
      },
      ...(options.tryReserveRequest ? { tryReserve: options.tryReserveRequest } : {})
    });
  }

  async summarizeHistory(address: PublicKeyString, days: number): Promise<WalletHistorySummary> {
    if (!Number.isInteger(days) || days <= 0) {
      throw new Error("Standard Solana history window must be a positive whole number of days");
    }
    if (!this.walletTagResolver) {
      throw new Error(
        "Standard Solana RPC cannot verify wallet identity tags; wallet qualification fails closed without walletTagResolver"
      );
    }
    const sampledAt = this.now();
    const cutoff = new Date(sampledAt.getTime() - days * DAY_MS);
    const history = await this.fetchHistorySignatures(address, cutoff);
    await this.assertCompleteHistory(history, cutoff);
    // Qualification/history analytics must remain free of operator-facing
    // rejection observations. Only the monitoring repair and live stream
    // paths emit those audit records.
    const swaps = await this.hydrateHistory(history.signatures, address, cutoff, sampledAt, false);
    const tags = await this.resolveWalletTags(address);
    return this.summarizeSwaps(address, days, sampledAt, history, swaps, tags);
  }

  async repairGap(address: PublicKeyString, since: IsoDateTime): Promise<LeaderSwap[]> {
    const sinceDate = validTimestamp(since);
    const detectedAt = this.now();
    const history = await this.fetchHistorySignatures(address, sinceDate);
    await this.assertCompleteHistory(history, sinceDate);
    return this.hydrateHistory(history.signatures, address, sinceDate, detectedAt, true);
  }

  async subscribe(
    addresses: PublicKeyString[],
    onSwap: (swap: LeaderSwap) => Promise<void>
  ): Promise<Unsubscribe> {
    if (this.activeSubscription && !this.activeSubscription.stopped) {
      throw new Error("Standard Solana observer already has an active subscription");
    }
    const uniqueAddresses = [...new Set(addresses.filter(Boolean))];
    if (uniqueAddresses.length === 0) throw new Error("At least one wallet address is required");
    // Validate synchronously before opening a socket or mutating observer state.
    for (const address of uniqueAddresses) {
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
        throw new Error("Watched wallet must be a base58 Solana address");
      }
    }
    const connectedAt = this.now();
    const state: SubscriptionState = {
      addresses: uniqueAddresses,
      onSwap,
      stopped: false,
      socket: undefined,
      reconnectAttempt: 0,
      reconnectTimer: undefined,
      heartbeatTimer: undefined,
      ackTimer: undefined,
      everOpened: false,
      // The socket is not an atomic cutover from the preceding HTTP repair.
      // Always overlap the first acknowledged subscription from connectedAt;
      // downstream signature idempotency makes the duplicate interval safe.
      needsGapRepair: true,
      repairOnAck: false,
      gapRepairPending: true,
      gapRepairFailed: false,
      connectedAt: undefined,
      lastMessageAt: undefined,
      pendingRequests: new Map(),
      subscriptionWallets: new Map(),
      lastSeenAt: new Map(uniqueAddresses.map((address) => [address, connectedAt])),
      pendingLiveSignatures: new Map(),
      processingTail: Promise.resolve()
    };
    this.activeSubscription = state;
    this.connect(state);

    return async () => {
      if (state.stopped) return;
      state.stopped = true;
      if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
      if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
      if (state.ackTimer) clearTimeout(state.ackTimer);
      state.pendingLiveSignatures.clear();
      state.socket?.close(1000, "client unsubscribe");
      if (this.activeSubscription === state) this.activeSubscription = undefined;
    };
  }

  async hydrateSwap(
    signature: TransactionSignature,
    wallet: PublicKeyString,
    recovered = false,
    detectedAt = this.now(),
    emitRejectedObservation = false
  ): Promise<LeaderSwap | null> {
    const transaction = await this.fetchTransaction(signature);
    const decoded = decodeSpotSwapTransactionResult(transaction, {
      signature,
      wallet,
      detectedAt,
      recovered,
      // One is a decode sentinel. A SOL result is repriced or rejected below.
      solPriceUsd: 1,
      allowedSpotProgramIds: this.allowedSpotProgramIds
    });
    if (decoded.status === "REJECTED") {
      if (emitRejectedObservation) {
        await this.onRejectedSwap({
          action: decoded.action,
          researchAction: decoded.researchAction,
          reason: decoded.reason
        });
      }
      return null;
    }
    if (decoded.status === "IGNORED") {
      if (emitRejectedObservation && this.observesWalletTokenDecreases) {
        for (const observation of decodeWalletTokenDecreases(transaction, {
          signature,
          wallet,
          detectedAt,
          recovered,
          solPriceUsd: 1,
          allowedSpotProgramIds: this.allowedSpotProgramIds
        })) await this.onTokenDecrease(observation);
      }
      return null;
    }
    let swap = decoded.swap;
    if (swap?.baseMint === SOL_MINT) {
      if (!this.solPriceUsdResolver) {
        throw new Error(
          "Standard Solana RPC cannot price a SOL-legged swap; signal fails closed without solPriceUsdResolver"
        );
      }
      const solPriceUsd = await this.solPriceUsdResolver(swap.blockTime);
      if (!Number.isFinite(solPriceUsd) || solPriceUsd <= 0) {
        throw new Error("solPriceUsdResolver returned an invalid price; signal fails closed");
      }
      swap = {
        ...swap,
        leaderPriceUsd: (swap.baseAmountUi * solPriceUsd) / swap.targetAmountUi
      };
    }
    return swap;
  }

  async checkHealth(): Promise<StandardSolanaHealth> {
    const startedAt = this.monotonicNow();
    try {
      await this.rpc.getHealth();
      return {
        provider: "solana-rpc",
        ok: true,
        checkedAt: this.now().toISOString(),
        latencyMs: Math.max(0, this.monotonicNow() - startedAt),
        message: "Standard Solana RPC is reachable and healthy",
        usage: { requests: this.requestCount, window: "process" }
      };
    } catch {
      return {
        provider: "solana-rpc",
        ok: false,
        checkedAt: this.now().toISOString(),
        latencyMs: Math.max(0, this.monotonicNow() - startedAt),
        // Do not persist transport error text: custom fetch adapters can embed
        // the complete endpoint, including query-string credentials, in it.
        message: "Standard Solana RPC health check failed",
        usage: { requests: this.requestCount, window: "process" }
      };
    }
  }

  /**
   * Proves that the configured WebSocket endpoint accepts a standard Solana
   * `logsSubscribe` request at confirmed commitment. This probe is isolated
   * from the live wallet subscription and always closes its socket.
   *
   * Endpoint URLs and server-provided error text are deliberately excluded
   * from the result so credentials embedded in a query string cannot escape
   * into provider-health records or the dashboard.
   */
  async checkWebSocketHealth(
    timeoutMs = DEFAULT_WEBSOCKET_HEALTH_TIMEOUT_MS
  ): Promise<StandardSolanaHealth> {
    positiveFinite(timeoutMs, "WebSocket health timeoutMs");
    const startedAt = this.monotonicNow();
    const requestId = this.websocketRequestId++;

    return new Promise((resolve) => {
      let socket: StandardSolanaWebSocketLike | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      let requestSent = false;

      const result = (ok: boolean, message: string): StandardSolanaHealth => ({
        provider: "solana-rpc",
        ok,
        checkedAt: this.now().toISOString(),
        latencyMs: Math.max(0, this.monotonicNow() - startedAt),
        message,
        usage: { requests: this.requestCount, window: "process" }
      });
      const finish = (ok: boolean, message: string): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (socket && socket.readyState < 2) {
          try {
            socket.close(
              ok ? 1000 : CLIENT_STREAM_ERROR_CLOSE_CODE,
              ok ? "health probe complete" : "health probe failed"
            );
          } catch {
            // The health outcome is already known; socket cleanup must not
            // replace it or surface endpoint details from an adapter error.
          }
        }
        resolve(result(ok, message));
      };
      const sendProbe = (): void => {
        if (settled || requestSent || !socket) return;
        requestSent = true;
        try {
          this.recordWebSocketRequest("logsSubscribe");
          socket.send(JSON.stringify({
            jsonrpc: "2.0",
            id: requestId,
            method: "logsSubscribe",
            params: [
              { mentions: [WEBSOCKET_HEALTH_PROBE_ADDRESS] },
              { commitment: "confirmed" }
            ]
          }));
        } catch {
          finish(false, "Standard Solana WebSocket could not send the confirmed subscription probe");
        }
      };

      try {
        socket = this.websocketFactory(this.wsUrl);
      } catch {
        finish(false, "Standard Solana WebSocket could not be opened");
        return;
      }

      socket.addEventListener("open", sendProbe);
      socket.addEventListener("error", () => {
        finish(false, "Standard Solana WebSocket reported a connection error");
      });
      socket.addEventListener("close", () => {
        finish(false, "Standard Solana WebSocket closed before confirming the subscription probe");
      });
      socket.addEventListener("message", (event) => {
        void (async () => {
          let text: string | undefined;
          try {
            text = await eventDataToString(event?.data);
          } catch {
            finish(false, "Standard Solana WebSocket returned an unreadable subscription response");
            return;
          }
          if (settled || !text) return;
          let payload: unknown;
          try {
            payload = JSON.parse(text);
          } catch {
            finish(false, "Standard Solana WebSocket returned invalid JSON for the subscription probe");
            return;
          }
          const message = asRecord(payload);
          if (!message || message.jsonrpc !== "2.0") {
            finish(false, "Standard Solana WebSocket returned a malformed subscription response");
            return;
          }
          if (finiteNumber(message.id) !== requestId) return;
          if (asRecord(message.error)) {
            finish(false, "Standard Solana WebSocket rejected the confirmed subscription probe");
            return;
          }
          const subscriptionId = finiteNumber(message.result);
          if (!Number.isSafeInteger(subscriptionId) || (subscriptionId ?? -1) < 0) {
            finish(false, "Standard Solana WebSocket returned an invalid subscription id");
            return;
          }
          try {
            this.recordWebSocketRequest("logsUnsubscribe");
            socket?.send(JSON.stringify({
              jsonrpc: "2.0",
              id: this.websocketRequestId++,
              method: "logsUnsubscribe",
              params: [subscriptionId]
            }));
          } catch {
            // Acknowledged logsSubscribe is the proof required by this probe;
            // closing the isolated socket is sufficient cleanup.
          }
          finish(true, "Standard Solana WebSocket accepted a confirmed logs subscription");
        })();
      });

      timer = setTimeout(() => {
        finish(false, "Standard Solana WebSocket confirmed subscription probe timed out");
      }, timeoutMs);
      if (socket.readyState === 1) sendProbe();
    });
  }

  getStreamStatus(): StandardSolanaStreamStatus {
    const state = this.activeSubscription;
    const active = state !== undefined && !state.stopped;
    const connected = active && state.socket?.readyState === 1;
    const ready = Boolean(
      connected &&
      state.pendingRequests.size === 0 &&
      state.subscriptionWallets.size === state.addresses.length &&
      !state.gapRepairPending &&
      !state.gapRepairFailed
    );
    const lastMessageAt = state?.lastMessageAt ?? this.lastStreamMessageAt;
    return {
      active,
      connected,
      ready,
      gapRepairPending: state?.gapRepairPending ?? false,
      gapRepairFailed: state?.gapRepairFailed ?? false,
      ...(lastMessageAt !== undefined ? { lastMessageAt: new Date(lastMessageAt).toISOString() } : {})
    };
  }

  getStreamHealth(maximumSilenceMs = 60_000): StandardSolanaStreamHealth {
    positiveFinite(maximumSilenceMs, "maximumSilenceMs");
    const checkedAt = this.now();
    const status = this.getStreamStatus();
    const lastMessageTime = status.lastMessageAt ? Date.parse(status.lastMessageAt) : undefined;
    const silenceMs = lastMessageTime === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(0, checkedAt.getTime() - lastMessageTime);
    let message: string;
    if (!status.active) message = "Standard Solana wallet stream is not active";
    else if (!status.connected) message = "Standard Solana wallet stream is disconnected";
    else if (status.gapRepairFailed) message = "Standard Solana wallet stream gap repair failed closed";
    else if (status.gapRepairPending) message = "Standard Solana wallet stream is repairing a connection gap";
    else if (!status.ready) message = "Standard Solana wallet stream is awaiting subscription acknowledgement";
    else if (silenceMs > maximumSilenceMs) {
      message = `Standard Solana wallet stream has been silent for ${Math.ceil(silenceMs / 1_000)} seconds`;
    } else message = "Standard Solana wallet stream is connected, acknowledged, and live";
    return {
      provider: "solana-rpc",
      ok: status.ready && silenceMs <= maximumSilenceMs,
      checkedAt: checkedAt.toISOString(),
      latencyMs: 0,
      message,
      usage: { requests: this.requestCount, window: "process" },
      ...status
    };
  }

  private async fetchHistorySignatures(address: PublicKeyString, cutoff: Date): Promise<HistorySignatures> {
    const unique = new Map<string, SolanaSignatureInfo>();
    let before: string | undefined;
    let reachedCutoff = false;
    let exhausted = false;
    let truncated = false;
    let oldestKnownTime: number | undefined;
    for (let page = 0; page < this.maxHistoryPages; page += 1) {
      const rows = await this.rpc.getSignaturesForAddress(address, {
        limit: this.historyPageSize,
        ...(before ? { before } : {})
      });
      const sizeBefore = unique.size;
      for (const row of rows) {
        unique.set(row.signature, row);
        if (row.blockTime !== undefined) {
          const time = row.blockTime * 1_000;
          oldestKnownTime = oldestKnownTime === undefined ? time : Math.min(oldestKnownTime, time);
          if (time <= cutoff.getTime()) reachedCutoff = true;
        }
      }
      if (rows.length < this.historyPageSize) exhausted = true;
      if (reachedCutoff || exhausted) break;
      const nextBefore = rows.at(-1)?.signature;
      if (!nextBefore) throw new Error("Standard Solana history page was full without a pagination cursor");
      if (nextBefore === before || unique.size === sizeBefore) {
        throw new Error("Standard Solana history pagination cursor did not advance");
      }
      before = nextBefore;
      if (page + 1 === this.maxHistoryPages) truncated = true;
    }
    return { signatures: [...unique.values()], reachedCutoff, exhausted, truncated, ...(oldestKnownTime !== undefined ? { oldestKnownTime } : {}) };
  }

  private async assertCompleteHistory(history: HistorySignatures, cutoff: Date): Promise<void> {
    if (history.reachedCutoff) return;
    if (history.truncated && !history.reachedCutoff) {
      throw new Error(
        `Standard Solana RPC history pagination cap was reached before ${cutoff.toISOString()}; operation fails closed`
      );
    }
    if (!history.exhausted) {
      throw new Error(
        `Standard Solana RPC history did not prove coverage through ${cutoff.toISOString()}; operation fails closed`
      );
    }

    const archiveBoundary = await this.archiveBoundaryTime();
    if (archiveBoundary.getTime() > cutoff.getTime()) {
      throw new Error(
        `Standard Solana RPC retained archive begins at ${archiveBoundary.toISOString()}, after required cursor ${cutoff.toISOString()}; operation fails closed`
      );
    }
  }

  private async archiveBoundaryTime(): Promise<Date> {
    const firstAvailableSlot = await this.rpc.getFirstAvailableBlock();
    for (let offset = 0; offset < this.archiveBoundaryScanSlots; offset += 1) {
      const slot = firstAvailableSlot + offset;
      if (!Number.isSafeInteger(slot)) break;
      try {
        const blockTime = await this.rpc.getBlockTime(slot);
        if (blockTime !== null) return new Date(blockTime * 1_000);
      } catch {
        // Skipped slots may be null or an RPC error depending on node version.
        // Continue only inside the strict configured bound.
      }
    }
    throw new Error(
      `Standard Solana RPC could not prove its archive boundary within ${this.archiveBoundaryScanSlots} slots; operation fails closed`
    );
  }

  private async hydrateHistory(
    signatures: SolanaSignatureInfo[],
    wallet: PublicKeyString,
    cutoff: Date,
    detectedAt: Date,
    emitRejectedObservations: boolean
  ): Promise<LeaderSwap[]> {
    const eligible = signatures.filter(
      (entry) => !entry.failed && (entry.blockTime === undefined || entry.blockTime * 1_000 >= cutoff.getTime())
    );
    if (eligible.length > this.maximumHistoryTransactions) {
      throw new Error(
        `Standard Solana RPC history contains ${eligible.length} transactions above the safe hydration cap of ${this.maximumHistoryTransactions}; operation fails closed`
      );
    }
    const unique = new Map<string, LeaderSwap>();
    let cursor = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = cursor++;
        const entry = eligible[index];
        if (!entry) return;
        const swap = await this.hydrateSwap(
          entry.signature,
          wallet,
          true,
          detectedAt,
          emitRejectedObservations
        );
        if (swap && Date.parse(swap.blockTime) >= cutoff.getTime()) {
          unique.set(swap.sourceSignature, swap);
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(this.historyHydrationConcurrency, eligible.length) }, () => worker())
    );
    return [...unique.values()].sort((a, b) => Date.parse(a.blockTime) - Date.parse(b.blockTime));
  }

  private summarizeSwaps(
    address: PublicKeyString,
    days: number,
    sampledAt: Date,
    history: HistorySignatures,
    swaps: LeaderSwap[],
    tags: string[]
  ): WalletHistorySummary {
    const activeWeeks = new Set(
      swaps
        .map((swap) => Math.floor((sampledAt.getTime() - Date.parse(swap.blockTime)) / (7 * DAY_MS)))
        .filter((week) => week >= 0 && week < 4)
    ).size;
    const lots = new Map<string, Array<{ quantity: number; costUsd: number; openedAt: number }>>();
    const holdingMinutes: number[] = [];
    const profits = new Map<string, number>();
    let closedEligibleSwaps = 0;
    for (const swap of swaps) {
      const baseValueUsd = swap.leaderPriceUsd * swap.targetAmountUi;
      if (!Number.isFinite(baseValueUsd) || baseValueUsd <= 0) continue;
      if (swap.side === "BUY") {
        const tokenLots = lots.get(swap.targetMint) ?? [];
        tokenLots.push({ quantity: swap.targetAmountUi, costUsd: baseValueUsd, openedAt: Date.parse(swap.blockTime) });
        lots.set(swap.targetMint, tokenLots);
        continue;
      }
      const tokenLots = lots.get(swap.targetMint) ?? [];
      let remaining = swap.targetAmountUi;
      let matched = 0;
      let matchedCost = 0;
      while (remaining > 1e-12 && tokenLots.length > 0) {
        const lot = tokenLots[0];
        if (!lot) break;
        const quantity = Math.min(remaining, lot.quantity);
        const cost = lot.costUsd * (quantity / lot.quantity);
        matched += quantity;
        matchedCost += cost;
        holdingMinutes.push((Date.parse(swap.blockTime) - lot.openedAt) / 60_000);
        lot.quantity -= quantity;
        lot.costUsd -= cost;
        remaining -= quantity;
        if (lot.quantity <= 1e-12) tokenLots.shift();
      }
      if (matched <= 0) continue;
      closedEligibleSwaps += 1;
      const revenue = baseValueUsd * (matched / swap.targetAmountUi);
      profits.set(swap.targetMint, (profits.get(swap.targetMint) ?? 0) + revenue - matchedCost);
    }
    const positiveProfits = [...profits.values()].filter((profit) => profit > 0).sort((a, b) => b - a);
    const totalPositiveProfit = positiveProfits.reduce((sum, profit) => sum + profit, 0);
    const historyDays = history.reachedCutoff
      ? days
      : Math.min(
          days,
          Math.max(0, Math.floor((sampledAt.getTime() - (history.oldestKnownTime ?? sampledAt.getTime())) / DAY_MS))
        );
    return {
      wallet: address,
      historyDays,
      closedEligibleSwaps,
      activeWeeks,
      medianHoldingMinutes: Math.max(0, median(holdingMinutes)),
      topTokenProfitShare: totalPositiveProfit > 0 ? (positiveProfits[0] ?? 0) / totalPositiveProfit : 0,
      topThreeProfitShare: totalPositiveProfit > 0
        ? positiveProfits.slice(0, 3).reduce((sum, profit) => sum + profit, 0) / totalPositiveProfit
        : 0,
      tags
    };
  }

  private async resolveWalletTags(address: PublicKeyString): Promise<string[]> {
    if (!this.walletTagResolver) throw new Error("walletTagResolver is unavailable");
    const tags = await this.walletTagResolver(address);
    if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== "string")) {
      throw new Error("walletTagResolver returned malformed tags; wallet qualification fails closed");
    }
    const normalized = tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean);
    const words = normalized.flatMap((tag) => tag.split(/[^a-z0-9]+/).filter(Boolean));
    return [...new Set([...normalized, ...words])];
  }

  private async fetchTransaction(signature: TransactionSignature): Promise<unknown> {
    const cached = this.transactionCache.get(signature);
    if (cached !== undefined) return cached;
    const inFlight = this.inFlightTransactions.get(signature);
    if (inFlight) return inFlight;
    const operation = (async () => {
      let transaction: unknown | null = null;
      for (let attempt = 0; attempt < this.hydrationRetries; attempt += 1) {
        transaction = await this.rpc.getTransaction(signature);
        if (transaction !== null) break;
        if (attempt + 1 < this.hydrationRetries) await this.sleep(this.hydrationRetryMs * (attempt + 1));
      }
      if (transaction === null) {
        throw new Error(`Standard Solana getTransaction did not return confirmed data for ${signature}`);
      }
      this.transactionCache.set(signature, transaction);
      while (this.transactionCache.size > this.transactionCacheSize) {
        const oldest = this.transactionCache.keys().next().value as string | undefined;
        if (!oldest) break;
        this.transactionCache.delete(oldest);
      }
      return transaction;
    })();
    this.inFlightTransactions.set(signature, operation);
    try {
      return await operation;
    } finally {
      this.inFlightTransactions.delete(signature);
    }
  }

  private connect(state: SubscriptionState): void {
    if (state.stopped) return;
    let socket: StandardSolanaWebSocketLike;
    try {
      socket = this.websocketFactory(this.wsUrl);
    } catch (error) {
      this.report(error);
      state.needsGapRepair = true;
      this.scheduleReconnect(state);
      return;
    }
    state.socket = socket;
    state.pendingRequests.clear();
    state.subscriptionWallets.clear();
    socket.addEventListener("open", () => {
      if (state.stopped || state.socket !== socket) return;
      const reconnecting = state.everOpened || state.needsGapRepair;
      state.everOpened = true;
      state.needsGapRepair = false;
      state.repairOnAck = reconnecting;
      state.gapRepairPending = reconnecting;
      state.gapRepairFailed = false;
      state.connectedAt = this.now().getTime();
      try {
        for (const address of state.addresses) {
          const id = this.websocketRequestId++;
          state.pendingRequests.set(id, address);
          this.recordWebSocketRequest("logsSubscribe");
          socket.send(JSON.stringify({
            jsonrpc: "2.0",
            id,
            method: "logsSubscribe",
            params: [{ mentions: [address] }, { commitment: "confirmed" }]
          }));
        }
      } catch (error) {
        this.report(error instanceof Error ? error : new Error(String(error)));
        socket.close(CLIENT_STREAM_ERROR_CLOSE_CODE, "subscription request rejected");
        return;
      }
      state.ackTimer = setTimeout(() => {
        if (!state.stopped && state.socket === socket && state.pendingRequests.size > 0) {
          this.report(new Error("Standard Solana logsSubscribe acknowledgement timed out"));
          socket.close(CLIENT_STREAM_ERROR_CLOSE_CODE, "subscription acknowledgement timeout");
        }
      }, this.subscriptionAckTimeoutMs);
      state.heartbeatTimer = setInterval(() => {
        if (state.stopped || state.socket !== socket || socket.readyState !== 1) return;
        const reference = state.lastMessageAt ?? state.connectedAt;
        if (reference !== undefined && this.now().getTime() - reference > this.livenessTimeoutMs) {
          this.report(new Error("Standard Solana WebSocket liveness check timed out"));
          socket.close(CLIENT_STREAM_ERROR_CLOSE_CODE, "liveness timeout");
          return;
        }
        try {
          this.recordWebSocketRequest("getSlot");
          socket.send(JSON.stringify({
            jsonrpc: "2.0",
            id: this.websocketRequestId++,
            method: "getSlot",
            params: [{ commitment: "confirmed" }]
          }));
        } catch (error) {
          this.report(error instanceof Error ? error : new Error(String(error)));
          socket.close(CLIENT_STREAM_ERROR_CLOSE_CODE, "heartbeat request rejected");
        }
      }, this.heartbeatMs);
    });
    socket.addEventListener("message", (event) => {
      void this.handleWebSocketMessage(state, socket, event?.data);
    });
    socket.addEventListener("error", () => {
      this.report(new Error("Standard Solana WebSocket reported a connection error"));
      if (!state.stopped && state.socket === socket) {
        socket.close(CLIENT_STREAM_ERROR_CLOSE_CODE, "connection error");
      }
    });
    socket.addEventListener("close", () => {
      if (state.socket !== socket) return;
      if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
      if (state.ackTimer) clearTimeout(state.ackTimer);
      state.heartbeatTimer = undefined;
      state.ackTimer = undefined;
      state.connectedAt = undefined;
      state.socket = undefined;
      if (!state.stopped) {
        state.needsGapRepair = true;
        this.scheduleReconnect(state);
      }
    });
  }

  private scheduleReconnect(state: SubscriptionState): void {
    if (state.stopped || state.reconnectTimer) return;
    const delay = Math.min(this.reconnectMaximumMs, this.reconnectBaseMs * 2 ** state.reconnectAttempt);
    state.reconnectAttempt += 1;
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = undefined;
      this.connect(state);
    }, delay);
  }

  private async handleWebSocketMessage(
    state: SubscriptionState,
    socket: StandardSolanaWebSocketLike,
    data: unknown
  ): Promise<void> {
    if (state.stopped || state.socket !== socket) return;
    state.lastMessageAt = this.now().getTime();
    this.lastStreamMessageAt = state.lastMessageAt;
    const text = await eventDataToString(data);
    if (!text) return;
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      this.report(new Error("Standard Solana WebSocket returned invalid JSON"));
      socket.close(CLIENT_STREAM_ERROR_CLOSE_CODE, "invalid JSON");
      return;
    }
    const message = asRecord(payload);
    if (!message || message.jsonrpc !== "2.0") {
      this.report(new Error("Standard Solana WebSocket returned a malformed JSON-RPC message"));
      socket.close(CLIENT_STREAM_ERROR_CLOSE_CODE, "malformed JSON-RPC message");
      return;
    }
    const id = finiteNumber(message.id);
    const websocketError = asRecord(message.error);
    if (id !== undefined && websocketError) {
      state.pendingRequests.delete(id);
      this.report(new Error(
        `Standard Solana WebSocket request failed${finiteNumber(websocketError.code) === undefined ? "" : ` (${websocketError.code})`}: ${
          stringValue(websocketError.message) ?? "unknown WebSocket RPC error"
        }`
      ));
      socket.close(CLIENT_STREAM_ERROR_CLOSE_CODE, "WebSocket RPC request rejected");
      return;
    }
    if (id !== undefined && "result" in message) {
      const wallet = state.pendingRequests.get(id);
      if (wallet) {
        const subscriptionId = finiteNumber(message.result);
        if (!Number.isSafeInteger(subscriptionId) || (subscriptionId ?? -1) < 0) {
          this.report(new Error("Standard Solana logsSubscribe returned an invalid subscription id"));
          socket.close(CLIENT_STREAM_ERROR_CLOSE_CODE, "invalid subscription id");
          return;
        }
        state.pendingRequests.delete(id);
        state.subscriptionWallets.set(subscriptionId as number, wallet);
        if (state.pendingRequests.size === 0) this.subscriptionsReady(state, socket);
      }
      return;
    }
    if (message.method !== "logsNotification") return;
    const params = asRecord(message.params);
    const subscriptionId = finiteNumber(params?.subscription);
    const result = asRecord(params?.result);
    const value = asRecord(result?.value);
    const signature = stringValue(value?.signature);
    if (subscriptionId === undefined || !signature || value?.err !== null) return;
    const wallet = state.subscriptionWallets.get(subscriptionId);
    const key = wallet ? this.dedupeKey(wallet, signature) : undefined;
    if (!wallet || !key || this.wasSeen(key) || this.inFlightSignatures.has(key)) return;
    const pending = { signature, wallet, key, detectedAt: this.now() };
    if (state.gapRepairPending) {
      // Do not expose a live callback until the acknowledged stream has
      // repaired its overlap. The repair will usually dedupe this signature;
      // otherwise it is drained immediately after repair succeeds.
      state.pendingLiveSignatures.set(key, pending);
      return;
    }
    this.enqueueLiveSignature(state, pending);
  }

  private enqueueLiveSignature(state: SubscriptionState, pending: PendingLiveSignature): void {
    if (this.wasSeen(pending.key) || this.inFlightSignatures.has(pending.key)) return;
    this.inFlightSignatures.add(pending.key);
    state.processingTail = state.processingTail
      .then(() => this.processLiveSignature(
        state,
        pending.signature,
        pending.wallet,
        pending.key,
        pending.detectedAt
      ))
      .catch((error) => this.report(error));
  }

  private async processLiveSignature(
    state: SubscriptionState,
    signature: string,
    wallet: string,
    key: string,
    detectedAt: Date
  ): Promise<void> {
    try {
      if (state.stopped || state.gapRepairFailed || this.wasSeen(key)) return;
      const swap = await this.hydrateSwap(signature, wallet, false, detectedAt, true);
      if (swap && !state.stopped && !state.gapRepairFailed) {
        await state.onSwap(swap);
        state.lastSeenAt.set(wallet, new Date(swap.blockTime));
      }
      this.markSeen(key);
    } catch (error) {
      this.report(error);
      // Do not advertise a live stream after a transaction or callback could
      // not be handled. Reconnect repair will replay from the last durable
      // source time; downstream idempotency protects a partially handled call.
      state.gapRepairFailed = true;
      if (!state.stopped) {
        state.socket?.close(CLIENT_STREAM_ERROR_CLOSE_CODE, "live signal processing failed");
      }
    } finally {
      this.inFlightSignatures.delete(key);
    }
  }

  private subscriptionsReady(state: SubscriptionState, socket: StandardSolanaWebSocketLike): void {
    if (state.ackTimer) clearTimeout(state.ackTimer);
    state.ackTimer = undefined;
    if (!state.repairOnAck) {
      state.reconnectAttempt = 0;
      state.gapRepairPending = false;
      return;
    }
    state.repairOnAck = false;
    state.processingTail = state.processingTail
      .then(() => this.repairAfterReconnect(state))
      .then(async () => {
        state.gapRepairPending = false;
        state.gapRepairFailed = false;
        state.reconnectAttempt = 0;
        await this.drainPendingLiveSignatures(state);
      })
      .catch((error) => {
        state.gapRepairPending = false;
        state.gapRepairFailed = true;
        this.report(error);
        if (!state.stopped && state.socket === socket) {
          socket.close(CLIENT_STREAM_ERROR_CLOSE_CODE, "gap repair failed");
        }
      });
  }

  private recordWebSocketRequest(method: string): void {
    const usage: StandardSolanaRpcUsage = { method, requests: 1 };
    if (!this.tryReserveWebSocketRequest(usage)) {
      throw new Error(`Standard Solana WebSocket request budget is exhausted before ${method}`);
    }
    this.requestCount += 1;
    this.onUsage(usage);
  }

  private async drainPendingLiveSignatures(state: SubscriptionState): Promise<void> {
    const pending = [...state.pendingLiveSignatures.values()]
      .sort((left, right) => left.detectedAt.getTime() - right.detectedAt.getTime());
    state.pendingLiveSignatures.clear();
    for (const signal of pending) {
      if (state.stopped || state.gapRepairFailed || this.wasSeen(signal.key)) continue;
      this.inFlightSignatures.add(signal.key);
      await this.processLiveSignature(
        state,
        signal.signature,
        signal.wallet,
        signal.key,
        signal.detectedAt
      );
    }
  }

  private async repairAfterReconnect(state: SubscriptionState): Promise<void> {
    for (const address of state.addresses) {
      if (state.stopped) return;
      const since = state.lastSeenAt.get(address) ?? this.now();
      const repairThrough = this.now();
      const swaps = await this.repairGap(address, since.toISOString());
      for (const swap of swaps) {
        const key = this.dedupeKey(address, swap.sourceSignature);
        if (state.stopped || this.wasSeen(key)) continue;
        await state.onSwap(swap);
        this.markSeen(key);
        state.lastSeenAt.set(address, new Date(swap.blockTime));
      }
      // Notifications received while this repair was running are buffered and
      // drained afterward, so the completed HTTP snapshot can safely advance
      // the in-memory reconnect cursor even when it contained no spot swaps.
      state.lastSeenAt.set(address, repairThrough);
    }
  }

  private dedupeKey(wallet: string, signature: string): string {
    return `${wallet}:${signature}`;
  }

  private wasSeen(key: string): boolean {
    return this.seenSignatures.has(key);
  }

  private markSeen(key: string): void {
    this.seenSignatures.set(key, this.now().getTime());
    while (this.seenSignatures.size > 10_000) {
      const oldest = this.seenSignatures.keys().next().value as string | undefined;
      if (!oldest) break;
      this.seenSignatures.delete(oldest);
    }
  }

  private report(error: unknown): void {
    const normalized = error instanceof Error ? error : new Error(String(error));
    const safeMessage = redactSensitiveText(normalized.message);
    this.onError(safeMessage === normalized.message ? normalized : new Error(safeMessage));
  }
}
