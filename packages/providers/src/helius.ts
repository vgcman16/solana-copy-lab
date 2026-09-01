import {
  SOL_MINT,
  USDC_MINT,
  type ChainObserver,
  type IsoDateTime,
  type LeaderSwap,
  type ProviderHealth,
  type PublicKeyString,
  type TransactionSignature,
  type Unsubscribe,
  type WalletHistorySummary
} from "@copylab/shared";
import {
  DEFAULT_SPOT_SWAP_PROGRAM_IDS,
  decodeSpotSwapTransactionResult,
  decodeWalletTokenDecreases,
  decodeWalletHistorySwap,
  type RejectedSwapObservation,
  type WalletTokenDecreaseObservation
} from "./helius-decoder.js";
import {
  asRecord,
  errorMessage,
  finiteNumber,
  ProviderApiError,
  requestJson,
  stringValue,
  type FetchLike
} from "./http.js";

// WHATWG WebSocket clients may only send close code 1000 or an
// application-defined code in the 3000-4999 range. 1011 is a valid code to
// receive from a server, but Node's undici client throws synchronously when a
// client tries to send it, which would otherwise terminate the whole process.
const CLIENT_STREAM_ERROR_CLOSE_CODE = 4000;
// Provider health is evaluated on a 60-second silence budget. Probe at half
// that interval so normal scheduler/network jitter cannot make a quiet but
// healthy subscribed wallet look like an outage.
const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_LIVENESS_TIMEOUT_MS = 90_000;

export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "close" | "error" | "message", listener: (event: any) => void): void;
}

export interface HeliusOptions {
  rpcUrl?: string;
  websocketUrl?: string;
  walletApiBaseUrl?: string;
  /** Optional shared pace for every observer HTTP request. */
  requestsPerSecond?: number;
  fetch?: FetchLike;
  websocketFactory?: (url: string) => WebSocketLike;
  timeoutMs?: number;
  maxHistoryPages?: number;
  reconnectBaseMs?: number;
  reconnectMaximumMs?: number;
  heartbeatMs?: number;
  subscriptionAckTimeoutMs?: number;
  livenessTimeoutMs?: number;
  hydrationRetries?: number;
  hydrationRetryMs?: number;
  solPriceCacheMs?: number;
  allowedSpotProgramIds?: ReadonlySet<string>;
  /** Injectable entropy for bounded reconnect and repair jitter. */
  jitter?: () => number;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
  onError?: (error: Error) => void;
  onRequest?: (usage: HeliusRequestUsage) => void;
  onRejectedSwap?: (rejection: RejectedSwapObservation) => Promise<void> | void;
  /** Isolated research-only inventory evidence; never emits an executable swap. */
  onTokenDecrease?: (observation: WalletTokenDecreaseObservation) => Promise<void> | void;
}

export interface HeliusRequestUsage {
  service: "rpc" | "wallet";
  method: string;
  credits: number;
}

export interface HeliusStreamStatus {
  active: boolean;
  connected: boolean;
  ready: boolean;
  gapRepairPending: boolean;
  gapRepairFailed: boolean;
  lastMessageAt?: IsoDateTime;
}

export interface HeliusStreamHealth extends ProviderHealth, HeliusStreamStatus {}

interface HistoryResult {
  entries: unknown[];
  reachedCutoff: boolean;
  truncated: boolean;
}

interface PendingLiveSignature {
  signature: string;
  wallet: string;
  dedupeKey: string;
  detectedAt: Date;
  socket: WebSocketLike;
}

interface SubscriptionState {
  addresses: string[];
  onSwap: (swap: LeaderSwap) => Promise<void>;
  stopped: boolean;
  socket: WebSocketLike | undefined;
  reconnectAttempt: number;
  reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  ackTimer: ReturnType<typeof setTimeout> | undefined;
  everOpened: boolean;
  needsGapRepair: boolean;
  repairOnAck: boolean;
  gapRepairPending: boolean;
  gapRepairFailed: boolean;
  gapRepairAttempt: number;
  gapRepairTimer: ReturnType<typeof setTimeout> | undefined;
  gapRepairInFlight: boolean;
  connectedAt: number | undefined;
  lastMessageAt: number | undefined;
  pendingRequests: Map<number, string>;
  subscriptionWallets: Map<number, string>;
  lastSeenAt: Map<string, Date>;
  pendingLiveSignatures: Map<string, PendingLiveSignature>;
  processingTail: Promise<void>;
}

class RequestIntervalQueue {
  private tail: Promise<void> = Promise.resolve();
  private lastStartedAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly intervalMs: number,
    private readonly now: () => number,
    private readonly sleep: (milliseconds: number) => Promise<void>
  ) {}

  schedule<T>(operation: () => Promise<T>): Promise<T> {
    const start = this.tail.then(async () => {
      const remaining = this.intervalMs - (this.now() - this.lastStartedAt);
      if (remaining > 0) await this.sleep(remaining);
      this.lastStartedAt = this.now();
    });
    this.tail = start.then(() => undefined, () => undefined);
    return start.then(operation);
  }
}

const MAX_PENDING_LIVE_SIGNATURES = 10_000;

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
  if (ArrayBuffer.isView(data)) {
    return Promise.resolve(new TextDecoder().decode(data));
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) return data.text();
  return Promise.resolve(undefined);
}

function validTimestamp(value: string): Date {
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) throw new Error(`Invalid ISO timestamp: ${value}`);
  return timestamp;
}

export class HeliusObserver implements ChainObserver {
  private readonly rpcUrl: string;
  private readonly websocketUrl: string;
  private readonly walletApiBaseUrl: string;
  private readonly fetch: FetchLike | undefined;
  private readonly websocketFactory: (url: string) => WebSocketLike;
  private readonly timeoutMs: number;
  private readonly maxHistoryPages: number;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaximumMs: number;
  private readonly heartbeatMs: number;
  private readonly subscriptionAckTimeoutMs: number;
  private readonly livenessTimeoutMs: number;
  private readonly hydrationRetries: number;
  private readonly hydrationRetryMs: number;
  private readonly solPriceCacheMs: number;
  private readonly allowedSpotProgramIds: ReadonlySet<string>;
  private readonly jitter: () => number;
  private readonly now: () => Date;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly onError: (error: Error) => void;
  private readonly onRequest: (usage: HeliusRequestUsage) => void;
  private readonly onRejectedSwap: (rejection: RejectedSwapObservation) => Promise<void> | void;
  private readonly onTokenDecrease:
    (observation: WalletTokenDecreaseObservation) => Promise<void> | void;
  private readonly observesWalletTokenDecreases: boolean;
  private readonly requestQueue: RequestIntervalQueue | undefined;
  private requestCount = 0;
  private rpcId = 1;
  private websocketRequestId = 1;
  private activeSubscription: SubscriptionState | undefined;
  private readonly seenSignatures = new Map<string, number>();
  private readonly inFlightSignatures = new Set<string>();
  private solPriceCache?: { price: number; fetchedAt: number };
  private lastStreamMessageAt: number | undefined;

  constructor(
    private readonly apiKey: string,
    options: HeliusOptions = {}
  ) {
    if (!apiKey.trim()) throw new Error("Helius API key is required");
    this.rpcUrl = options.rpcUrl ?? `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(apiKey)}`;
    this.websocketUrl =
      options.websocketUrl ?? `wss://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(apiKey)}`;
    this.walletApiBaseUrl = (options.walletApiBaseUrl ?? "https://api.helius.xyz").replace(/\/$/, "");
    this.fetch = options.fetch;
    this.websocketFactory =
      options.websocketFactory ?? ((url) => new WebSocket(url) as unknown as WebSocketLike);
    this.timeoutMs = options.timeoutMs ?? 12_000;
    this.maxHistoryPages = Math.max(1, options.maxHistoryPages ?? 100);
    this.reconnectBaseMs = Math.max(10, options.reconnectBaseMs ?? 1_000);
    this.reconnectMaximumMs = Math.max(this.reconnectBaseMs, options.reconnectMaximumMs ?? 30_000);
    this.heartbeatMs = Math.max(1_000, options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
    this.subscriptionAckTimeoutMs = Math.max(10, options.subscriptionAckTimeoutMs ?? 10_000);
    this.livenessTimeoutMs = Math.max(
      this.heartbeatMs,
      options.livenessTimeoutMs ?? DEFAULT_LIVENESS_TIMEOUT_MS
    );
    this.hydrationRetries = Math.max(1, options.hydrationRetries ?? 3);
    this.hydrationRetryMs = Math.max(0, options.hydrationRetryMs ?? 250);
    this.solPriceCacheMs = Math.max(1_000, options.solPriceCacheMs ?? 60_000);
    this.allowedSpotProgramIds = options.allowedSpotProgramIds ?? DEFAULT_SPOT_SWAP_PROGRAM_IDS;
    this.jitter = options.jitter ?? Math.random;
    this.now = options.now ?? (() => new Date());
    this.sleep =
      options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    if (
      options.requestsPerSecond !== undefined &&
      (!Number.isFinite(options.requestsPerSecond) || options.requestsPerSecond <= 0 || options.requestsPerSecond > 10)
    ) {
      throw new RangeError("Helius observer requestsPerSecond must be greater than 0 and no more than 10");
    }
    this.requestQueue = options.requestsPerSecond === undefined
      ? undefined
      : new RequestIntervalQueue(1_000 / options.requestsPerSecond, () => this.now().getTime(), this.sleep);
    this.onError = options.onError ?? (() => undefined);
    this.onRequest = options.onRequest ?? (() => undefined);
    this.onRejectedSwap = options.onRejectedSwap ?? (() => undefined);
    this.observesWalletTokenDecreases = options.onTokenDecrease !== undefined;
    this.onTokenDecrease = options.onTokenDecrease ?? (() => undefined);
  }

  private request<T>(operation: () => Promise<T>): Promise<T> {
    return this.requestQueue ? this.requestQueue.schedule(operation) : operation();
  }

  async summarizeHistory(address: PublicKeyString, days: number): Promise<WalletHistorySummary> {
    if (!address) throw new Error("Helius history requires a wallet address");
    if (!Number.isInteger(days) || days <= 0) {
      throw new Error("Helius history window must be a positive whole number of days");
    }
    const now = this.now();
    const since = new Date(now.getTime() - days * 86_400_000);
    const history = await this.fetchHistory(address, since);
    const tagsPromise = this.fetchIdentityTags(address);
    const decodedSwaps = history.entries
      .map((entry) =>
        decodeWalletHistorySwap(entry, {
          signature: "history",
          wallet: address,
          detectedAt: now,
          recovered: true,
          solPriceUsd: 1
        })
      )
      .filter((swap): swap is LeaderSwap => swap !== null)
      .filter((swap) => Date.parse(swap.blockTime) >= since.getTime());
    let swaps = [...new Map(
      decodedSwaps.map((swap) => [swap.sourceSignature, swap] as const)
    ).values()]
      .sort((a, b) => Date.parse(a.blockTime) - Date.parse(b.blockTime));
    swaps = await this.priceSolSwaps(swaps);

    const activeWeeks = new Set(
      swaps
        .map((swap) => Math.floor((now.getTime() - Date.parse(swap.blockTime)) / (7 * 86_400_000)))
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
        tokenLots.push({
          quantity: swap.targetAmountUi,
          costUsd: baseValueUsd,
          openedAt: Date.parse(swap.blockTime)
        });
        lots.set(swap.targetMint, tokenLots);
        continue;
      }

      const tokenLots = lots.get(swap.targetMint) ?? [];
      let remainingToMatch = swap.targetAmountUi;
      let matched = 0;
      let matchedCost = 0;
      while (remainingToMatch > 1e-12 && tokenLots.length > 0) {
        const lot = tokenLots[0];
        if (!lot) break;
        const quantity = Math.min(remainingToMatch, lot.quantity);
        const cost = lot.costUsd * (quantity / lot.quantity);
        matched += quantity;
        matchedCost += cost;
        holdingMinutes.push((Date.parse(swap.blockTime) - lot.openedAt) / 60_000);
        lot.quantity -= quantity;
        lot.costUsd -= cost;
        remainingToMatch -= quantity;
        if (lot.quantity <= 1e-12) tokenLots.shift();
      }
      if (matched <= 0) continue;
      closedEligibleSwaps += 1;
      const matchedRevenue = baseValueUsd * (matched / swap.targetAmountUi);
      profits.set(swap.targetMint, (profits.get(swap.targetMint) ?? 0) + matchedRevenue - matchedCost);
    }

    const positiveProfits = [...profits.values()].filter((profit) => profit > 0).sort((a, b) => b - a);
    const totalPositiveProfit = positiveProfits.reduce((sum, profit) => sum + profit, 0);
    const oldestTime = swaps[0] ? Date.parse(swaps[0].blockTime) : now.getTime();
    const historyDays = history.reachedCutoff
      ? days
      : Math.min(days, Math.max(0, Math.floor((now.getTime() - oldestTime) / 86_400_000)));

    return {
      wallet: address,
      historyDays,
      closedEligibleSwaps,
      activeWeeks,
      medianHoldingMinutes: Math.max(0, median(holdingMinutes)),
      topTokenProfitShare: totalPositiveProfit > 0 ? (positiveProfits[0] ?? 0) / totalPositiveProfit : 0,
      topThreeProfitShare:
        totalPositiveProfit > 0
          ? positiveProfits.slice(0, 3).reduce((sum, profit) => sum + profit, 0) / totalPositiveProfit
          : 0,
      tags: await tagsPromise
    };
  }

  async repairGap(address: PublicKeyString, since: IsoDateTime): Promise<LeaderSwap[]> {
    if (!address) throw new Error("Helius gap repair requires a wallet address");
    const sinceDate = validTimestamp(since);
    const now = this.now();
    const history = await this.fetchHistory(address, sinceDate);
    if (history.truncated && !history.reachedCutoff) {
      throw new Error(
        `Helius gap repair reached the ${this.maxHistoryPages}-page safety cap before ${sinceDate.toISOString()}; operation fails closed`
      );
    }
    const unique = new Map<string, LeaderSwap>();
    const signatures = new Set<string>();
    for (const entry of history.entries) {
      const record = asRecord(entry);
      const signature = stringValue(record?.signature);
      const timestamp = finiteNumber(record?.timestamp);
      if (
        !signature ||
        record?.error != null ||
        (!this.observesWalletTokenDecreases && record?.type !== undefined && record.type !== "SWAP") ||
        timestamp === undefined ||
        !Number.isSafeInteger(timestamp) ||
        timestamp * 1_000 < sinceDate.getTime()
      ) continue;
      signatures.add(signature);
    }
    for (const signature of signatures) {
      const swap = await this.hydrateSwap(signature, address, true, now);
      if (swap && Date.parse(swap.blockTime) >= sinceDate.getTime()) {
        unique.set(swap.sourceSignature, swap);
      }
    }
    const swaps = [...unique.values()].sort(
      (a, b) => Date.parse(a.blockTime) - Date.parse(b.blockTime)
    );
    return swaps;
  }

  async subscribe(
    addresses: PublicKeyString[],
    onSwap: (swap: LeaderSwap) => Promise<void>
  ): Promise<Unsubscribe> {
    if (this.activeSubscription && !this.activeSubscription.stopped) {
      throw new Error("Helius observer already has an active subscription");
    }
    const uniqueAddresses = [...new Set(addresses.filter(Boolean))];
    if (uniqueAddresses.length === 0) throw new Error("At least one wallet address is required");
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
      needsGapRepair: false,
      repairOnAck: false,
      gapRepairPending: false,
      gapRepairFailed: false,
      gapRepairAttempt: 0,
      gapRepairTimer: undefined,
      gapRepairInFlight: false,
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
      if (state.gapRepairTimer) clearTimeout(state.gapRepairTimer);
      if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
      if (state.ackTimer) clearTimeout(state.ackTimer);
      state.socket?.close(1000, "client unsubscribe");
      if (this.activeSubscription === state) this.activeSubscription = undefined;
    };
  }

  async hydrateSwap(
    signature: TransactionSignature,
    wallet: PublicKeyString,
    recovered = false,
    detectedAt = this.now()
  ): Promise<LeaderSwap | null> {
    let transaction: unknown = null;
    for (let attempt = 0; attempt < this.hydrationRetries; attempt += 1) {
      transaction = await this.rpc("getTransaction", [
        signature,
        { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 }
      ]);
      if (transaction !== null) break;
      if (attempt + 1 < this.hydrationRetries) await this.sleep(this.hydrationRetryMs);
    }
    if (transaction === null) {
      throw new Error(`Helius getTransaction did not return confirmed data for ${signature}`);
    }
    const decoded = decodeSpotSwapTransactionResult(transaction, {
      signature,
      wallet,
      detectedAt,
      recovered,
      solPriceUsd: 1,
      allowedSpotProgramIds: this.allowedSpotProgramIds
    });
    if (decoded.status === "REJECTED") {
      await this.onRejectedSwap({
        action: decoded.action,
        researchAction: decoded.researchAction,
        reason: decoded.reason
      });
      return null;
    }
    if (decoded.status === "IGNORED") {
      if (this.observesWalletTokenDecreases) {
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
      const solPriceUsd = await this.getSolPriceUsd();
      swap = {
        ...swap,
        leaderPriceUsd: (swap.baseAmountUi * solPriceUsd) / swap.targetAmountUi
      };
    }
    return swap;
  }

  getStreamStatus(): HeliusStreamStatus {
    const state = this.activeSubscription;
    const active = state !== undefined && !state.stopped;
    const connected = active && state.socket?.readyState === 1;
    const ready =
      connected &&
      state.pendingRequests.size === 0 &&
      state.subscriptionWallets.size === state.addresses.length &&
      !state.gapRepairPending &&
      !state.gapRepairFailed;
    const lastMessageAt = state?.lastMessageAt ?? this.lastStreamMessageAt;
    return {
      active,
      connected,
      ready,
      gapRepairPending: state?.gapRepairPending ?? false,
      gapRepairFailed: state?.gapRepairFailed ?? false,
      ...(lastMessageAt !== undefined
        ? { lastMessageAt: new Date(lastMessageAt).toISOString() }
        : {})
    };
  }

  getStreamHealth(maximumSilenceMs = 60_000): HeliusStreamHealth {
    if (!Number.isFinite(maximumSilenceMs) || maximumSilenceMs <= 0) {
      throw new RangeError("maximumSilenceMs must be a positive finite number");
    }
    const checkedAt = this.now();
    const status = this.getStreamStatus();
    const lastMessageTime = status.lastMessageAt ? Date.parse(status.lastMessageAt) : undefined;
    const silenceMs = lastMessageTime === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(0, checkedAt.getTime() - lastMessageTime);
    let message: string;
    if (!status.active) message = "Helius wallet stream is not active";
    else if (!status.connected) message = "Helius wallet stream is disconnected";
    else if (status.gapRepairFailed) message = "Helius wallet stream gap repair failed closed";
    else if (status.gapRepairPending) message = "Helius wallet stream is repairing a connection gap";
    else if (!status.ready) message = "Helius wallet stream is awaiting subscription acknowledgement";
    else if (silenceMs > maximumSilenceMs) {
      message = `Helius wallet stream has been silent for ${Math.ceil(silenceMs / 1_000)} seconds`;
    } else {
      message = "Helius wallet stream is connected, acknowledged, and live";
    }
    return {
      provider: "helius",
      ok:
        status.active &&
        status.connected &&
        status.ready &&
        silenceMs <= maximumSilenceMs,
      checkedAt: checkedAt.toISOString(),
      message,
      ...status
    };
  }

  async checkHealth(): Promise<ProviderHealth> {
    const startedAt = this.now().getTime();
    try {
      const health = await this.rpc("getHealth", []);
      if (health !== "ok") throw new Error(`Helius RPC health returned ${JSON.stringify(health)}`);
      return {
        provider: "helius",
        ok: true,
        checkedAt: this.now().toISOString(),
        latencyMs: Math.max(0, this.now().getTime() - startedAt),
        message: "Helius RPC is reachable and healthy",
        usage: { requests: this.requestCount, window: "unknown" }
      };
    } catch (error) {
      return {
        provider: "helius",
        ok: false,
        checkedAt: this.now().toISOString(),
        latencyMs: Math.max(0, this.now().getTime() - startedAt),
        message: errorMessage(error),
        usage: { requests: this.requestCount, window: "unknown" }
      };
    }
  }

  private connect(state: SubscriptionState): void {
    if (state.stopped) return;
    let socket: WebSocketLike;
    try {
      socket = this.websocketFactory(this.websocketUrl);
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
      for (const address of state.addresses) {
        const id = this.websocketRequestId++;
        state.pendingRequests.set(id, address);
        socket.send(JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "logsSubscribe",
          params: [{ mentions: [address] }, { commitment: "confirmed" }]
        }));
      }
      state.ackTimer = setTimeout(() => {
        if (!state.stopped && state.socket === socket && state.pendingRequests.size > 0) {
          this.report(new Error("Helius logsSubscribe acknowledgement timed out"));
          socket.close(CLIENT_STREAM_ERROR_CLOSE_CODE, "subscription acknowledgement timeout");
        }
      }, this.subscriptionAckTimeoutMs);
      state.heartbeatTimer = setInterval(() => {
        if (!state.stopped && state.socket === socket && socket.readyState === 1) {
          const livenessReference = state.lastMessageAt ?? state.connectedAt;
          if (
            livenessReference !== undefined &&
            this.now().getTime() - livenessReference >= this.livenessTimeoutMs
          ) {
            this.report(new Error("Helius WebSocket liveness check timed out"));
            socket.close(CLIENT_STREAM_ERROR_CLOSE_CODE, "liveness timeout");
            return;
          }
          socket.send(JSON.stringify({
            jsonrpc: "2.0",
            id: this.websocketRequestId++,
            method: "getSlot",
            params: [{ commitment: "confirmed" }]
          }));
        }
      }, this.heartbeatMs);
    });

    socket.addEventListener("message", (event) => {
      void this.handleWebSocketMessage(state, socket, event?.data);
    });
    socket.addEventListener("error", () => {
      this.report(new Error("Helius WebSocket reported a connection error"));
      if (!state.stopped && state.socket === socket) {
        socket.close(CLIENT_STREAM_ERROR_CLOSE_CODE, "connection error");
      }
    });
    socket.addEventListener("close", () => {
      if (state.socket !== socket) return;
      if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
      if (state.ackTimer) clearTimeout(state.ackTimer);
      if (state.gapRepairTimer) clearTimeout(state.gapRepairTimer);
      state.heartbeatTimer = undefined;
      state.ackTimer = undefined;
      state.gapRepairTimer = undefined;
      state.connectedAt = undefined;
      state.socket = undefined;
      if (!state.stopped) {
        state.needsGapRepair = true;
        state.gapRepairPending = true;
        state.gapRepairFailed = false;
        this.scheduleReconnect(state);
      }
    });
  }

  private scheduleReconnect(state: SubscriptionState): void {
    if (state.stopped || state.reconnectTimer) return;
    const delay = this.backoffDelay(state.reconnectAttempt);
    state.reconnectAttempt += 1;
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = undefined;
      this.connect(state);
    }, delay);
  }

  private async handleWebSocketMessage(
    state: SubscriptionState,
    socket: WebSocketLike,
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
      this.report(new Error("Helius WebSocket returned invalid JSON"));
      return;
    }
    const message = asRecord(payload);
    if (!message) return;
    const id = finiteNumber(message.id);
    const websocketError = asRecord(message.error);
    if (id !== undefined && websocketError && state.pendingRequests.has(id)) {
      state.pendingRequests.delete(id);
      this.report(new Error(
        `Helius logsSubscribe failed${finiteNumber(websocketError.code) === undefined ? "" : ` (${websocketError.code})`}: ${
          stringValue(websocketError.message) ?? "unknown WebSocket RPC error"
        }`
      ));
      socket.close(CLIENT_STREAM_ERROR_CLOSE_CODE, "subscription rejected");
      return;
    }
    const resultId = finiteNumber(message.result);
    if (id !== undefined && resultId !== undefined) {
      const wallet = state.pendingRequests.get(id);
      if (wallet) {
        state.pendingRequests.delete(id);
        state.subscriptionWallets.set(resultId, wallet);
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
    const dedupeKey = wallet ? this.dedupeKey(wallet, signature) : undefined;
    if (!wallet || !dedupeKey || this.wasSeen(dedupeKey) || this.inFlightSignatures.has(dedupeKey)) {
      return;
    }
    const pending: PendingLiveSignature = {
      signature,
      wallet,
      dedupeKey,
      detectedAt: this.now(),
      socket
    };
    if (state.gapRepairPending || state.gapRepairFailed) {
      state.pendingLiveSignatures.set(dedupeKey, pending);
      if (state.pendingLiveSignatures.size > MAX_PENDING_LIVE_SIGNATURES) {
        const oldest = state.pendingLiveSignatures.keys().next().value as string | undefined;
        if (oldest) state.pendingLiveSignatures.delete(oldest);
        this.report(new Error("Helius pending live-signal buffer reached its safety cap"));
        if (state.socket === socket) socket.close(CLIENT_STREAM_ERROR_CLOSE_CODE, "pending signal buffer full");
      }
      return;
    }
    this.enqueueLiveSignature(state, pending);
  }

  private enqueueLiveSignature(
    state: SubscriptionState,
    pending: PendingLiveSignature,
    allowDuringGapRepair = false
  ): Promise<void> {
    if (this.wasSeen(pending.dedupeKey) || this.inFlightSignatures.has(pending.dedupeKey)) {
      return Promise.resolve();
    }
    this.inFlightSignatures.add(pending.dedupeKey);
    const task = state.processingTail.then(() =>
      this.processLiveSignature(state, pending, allowDuringGapRepair)
    );
    state.processingTail = task.catch((error) => this.report(error));
    return task;
  }

  private async processLiveSignature(
    state: SubscriptionState,
    pending: PendingLiveSignature,
    allowDuringGapRepair = false
  ): Promise<void> {
    const { signature, wallet, dedupeKey, detectedAt, socket } = pending;
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          if (
            state.stopped ||
            state.socket !== socket ||
            state.gapRepairFailed ||
            (!allowDuringGapRepair && state.gapRepairPending) ||
            this.wasSeen(dedupeKey)
          ) return;
          const swap = await this.hydrateSwap(signature, wallet, false, detectedAt);
          if (
            swap &&
            !state.stopped &&
            state.socket === socket &&
            !state.gapRepairFailed &&
            (allowDuringGapRepair || !state.gapRepairPending)
          ) {
            await state.onSwap(swap);
            this.markSeen(dedupeKey);
            state.lastSeenAt.set(wallet, new Date(swap.blockTime));
          } else if (!swap) {
            this.markSeen(dedupeKey);
          }
          return;
        } catch (error) {
          if (attempt === 2 || state.stopped) {
            this.report(error);
            state.gapRepairFailed = true;
            if (!state.stopped && state.socket === socket) {
              socket.close(CLIENT_STREAM_ERROR_CLOSE_CODE, "live signal processing failed");
            }
            return;
          }
          await this.sleep(this.hydrationRetryMs * (attempt + 1));
        }
      }
    } finally {
      this.inFlightSignatures.delete(dedupeKey);
    }
  }

  private async repairAfterReconnect(state: SubscriptionState, socket: WebSocketLike): Promise<void> {
    for (const address of state.addresses) {
      if (state.stopped || state.socket !== socket) return;
      const since = state.lastSeenAt.get(address) ?? this.now();
      const repairThrough = this.now();
      const swaps = await this.repairGap(address, since.toISOString());
      for (const swap of swaps) {
        const dedupeKey = this.dedupeKey(address, swap.sourceSignature);
        if (state.stopped || state.socket !== socket || this.wasSeen(dedupeKey)) continue;
        // Repaired swaps remain explicitly recovered. Downstream policy stores
        // them for audit and rejects stale recovered events from execution.
        await state.onSwap(swap);
        this.markSeen(dedupeKey);
        state.lastSeenAt.set(address, new Date(swap.blockTime));
      }
      if (state.socket === socket) state.lastSeenAt.set(address, repairThrough);
    }
  }

  private subscriptionsReady(state: SubscriptionState, socket: WebSocketLike): void {
    if (state.ackTimer) clearTimeout(state.ackTimer);
    state.ackTimer = undefined;
    state.reconnectAttempt = 0;
    if (!state.repairOnAck) {
      state.gapRepairPending = false;
      state.gapRepairFailed = false;
      return;
    }
    state.repairOnAck = false;
    this.startGapRepair(state, socket);
  }

  private startGapRepair(state: SubscriptionState, socket: WebSocketLike): void {
    if (state.stopped || state.socket !== socket || state.gapRepairInFlight) return;
    if (state.gapRepairTimer) {
      clearTimeout(state.gapRepairTimer);
      state.gapRepairTimer = undefined;
    }
    state.gapRepairPending = true;
    state.gapRepairFailed = false;
    state.gapRepairInFlight = true;
    void this.repairAfterReconnect(state, socket)
      .then(async () => {
        if (state.stopped || state.socket !== socket) return;
        await this.drainPendingLiveSignatures(state, socket);
        if (state.stopped || state.socket !== socket || state.gapRepairFailed) return;
        // Readiness stays fail-closed through the complete serialized drain.
        // Notifications received during the drain remain buffered, so no newer
        // live action can overtake an older signal observed on this socket.
        state.gapRepairPending = false;
        state.gapRepairFailed = false;
        state.gapRepairAttempt = 0;
      })
      .catch((error) => {
        if (state.stopped || state.socket !== socket) return;
        state.gapRepairPending = false;
        state.gapRepairFailed = true;
        this.report(error);
        this.scheduleGapRepair(state, socket);
      })
      .finally(() => {
        state.gapRepairInFlight = false;
        const currentSocket = state.socket;
        if (
          !state.stopped &&
          currentSocket &&
          currentSocket !== socket &&
          state.gapRepairPending &&
          state.pendingRequests.size === 0 &&
          state.subscriptionWallets.size === state.addresses.length
        ) {
          this.startGapRepair(state, currentSocket);
        }
      });
  }

  private scheduleGapRepair(state: SubscriptionState, socket: WebSocketLike): void {
    if (state.stopped || state.socket !== socket || state.gapRepairTimer) return;
    const delay = this.backoffDelay(state.gapRepairAttempt);
    state.gapRepairAttempt += 1;
    state.gapRepairTimer = setTimeout(() => {
      state.gapRepairTimer = undefined;
      this.startGapRepair(state, socket);
    }, delay);
  }

  private async drainPendingLiveSignatures(
    state: SubscriptionState,
    socket: WebSocketLike
  ): Promise<void> {
    // Finish any task admitted before the disconnect first. While
    // gapRepairPending is true, every new notification is added to the buffer
    // rather than the processing tail.
    await state.processingTail;
    while (!state.stopped && state.socket === socket && !state.gapRepairFailed) {
      const pending = [...state.pendingLiveSignatures.values()]
        .sort((left, right) => left.detectedAt.getTime() - right.detectedAt.getTime());
      state.pendingLiveSignatures.clear();
      if (pending.length === 0) return;
      for (const signal of pending) {
        if (
          state.stopped ||
          state.socket !== socket ||
          state.gapRepairFailed ||
          this.wasSeen(signal.dedupeKey)
        ) continue;
        // Signals from an obsolete socket are covered by reconnect repair and
        // must not be reclassified as fresh live events after a delay.
        if (signal.socket !== socket) continue;
        await this.enqueueLiveSignature(state, signal, true);
      }
    }
  }

  private backoffDelay(attempt: number): number {
    const exponential = Math.min(
      this.reconnectMaximumMs,
      this.reconnectBaseMs * 2 ** Math.min(Math.max(0, attempt), 30)
    );
    let sample = 0.5;
    try {
      const candidate = this.jitter();
      if (Number.isFinite(candidate)) sample = candidate;
    } catch {
      // Retry pacing must remain safe even if an injected entropy source fails.
    }
    const entropy = Math.min(1, Math.max(0, sample));
    return Math.max(1, Math.min(
      this.reconnectMaximumMs,
      Math.round(exponential * (0.5 + entropy * 0.5))
    ));
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

  private async fetchHistory(address: string, since: Date): Promise<HistoryResult> {
    const entries: unknown[] = [];
    let before: string | undefined;
    let reachedCutoff = false;
    let truncated = false;
    for (let page = 0; page < this.maxHistoryPages; page += 1) {
      const url = new URL(`${this.walletApiBaseUrl}/v1/wallet/${encodeURIComponent(address)}/history`);
      url.searchParams.set("limit", "100");
      url.searchParams.set("type", "SWAP");
      url.searchParams.set("tokenAccounts", "balanceChanged");
      if (before) url.searchParams.set("before", before);
      this.requestCount += 1;
      this.onRequest({ service: "wallet", method: "history", credits: 100 });
      const payload = await this.request(() => requestJson<unknown>(url, {
        headers: { "X-Api-Key": this.apiKey, accept: "application/json" }
      }, {
        provider: "Helius Wallet API",
        fetch: this.fetch,
        timeoutMs: this.timeoutMs
      }));
      const response = asRecord(payload);
      const pageEntries = Array.isArray(response?.data) ? response.data : undefined;
      if (!pageEntries) throw new Error("Helius Wallet History returned no data array");
      entries.push(...pageEntries);
      const oldest = pageEntries.reduce<number>((minimum, entry) => {
        const timestamp = finiteNumber(asRecord(entry)?.timestamp);
        return timestamp === undefined ? minimum : Math.min(minimum, timestamp * 1_000);
      }, Number.POSITIVE_INFINITY);
      if (oldest <= since.getTime()) {
        reachedCutoff = true;
        break;
      }
      const pagination = asRecord(response?.pagination);
      if (pagination?.hasMore !== true) break;
      const nextBefore = stringValue(pagination.nextCursor);
      if (!nextBefore) throw new Error("Helius Wallet History indicated more pages without a cursor");
      if (nextBefore === before) throw new Error("Helius Wallet History pagination cursor did not advance");
      before = nextBefore;
      if (page + 1 === this.maxHistoryPages) truncated = true;
    }
    return { entries, reachedCutoff, truncated };
  }

  private async fetchIdentityTags(address: string): Promise<string[]> {
    const url = new URL(`${this.walletApiBaseUrl}/v1/wallet/${encodeURIComponent(address)}/identity`);
    this.requestCount += 1;
    this.onRequest({ service: "wallet", method: "identity", credits: 100 });
    try {
      const payload = await this.request(() => requestJson<unknown>(url, {
        headers: { "X-Api-Key": this.apiKey, accept: "application/json" }
      }, {
        provider: "Helius Wallet API",
        fetch: this.fetch,
        timeoutMs: this.timeoutMs
      }));
      const root = asRecord(payload);
      const data = asRecord(root?.data) ?? root;
      const values = Array.isArray(data?.tags)
        ? data.tags.filter((tag): tag is string => typeof tag === "string")
        : [];
      const category = stringValue(data?.category);
      if (category) values.push(category);
      const normalized = values.map((tag) => tag.trim().toLowerCase()).filter(Boolean);
      const words = normalized.flatMap((tag) => tag.split(/[^a-z0-9]+/).filter(Boolean));
      return [...new Set([...normalized, ...words])];
    } catch (error) {
      if (error instanceof ProviderApiError && error.status === 404) return [];
      throw new Error(
        `Helius wallet tags could not be verified; wallet qualification must fail closed: ${errorMessage(error)}`,
        { cause: error }
      );
    }
  }

  private async getSolPriceUsd(): Promise<number> {
    const now = this.now().getTime();
    if (this.solPriceCache && now - this.solPriceCache.fetchedAt <= this.solPriceCacheMs) {
      return this.solPriceCache.price;
    }
    const asset = asRecord(await this.rpc("getAsset", { id: SOL_MINT }));
    const tokenInfo = asRecord(asset?.token_info);
    const priceInfo = asRecord(tokenInfo?.price_info);
    const price = finiteNumber(priceInfo?.price_per_token);
    if (price === undefined || price <= 0) {
      throw new Error("Helius getAsset did not return a usable SOL/USD price");
    }
    this.solPriceCache = { price, fetchedAt: now };
    return price;
  }

  private async priceSolSwaps(swaps: LeaderSwap[]): Promise<LeaderSwap[]> {
    if (!swaps.some((swap) => swap.baseMint === SOL_MINT)) return swaps;
    let solPriceUsd: number;
    try {
      solPriceUsd = await this.getSolPriceUsd();
    } catch (error) {
      this.report(error);
      // A SOL-legged swap cannot satisfy LeaderSwap's USD-price contract when
      // the price oracle is unavailable. USDC-legged swaps remain usable.
      return swaps.filter((swap) => swap.baseMint === USDC_MINT);
    }
    return swaps.map((swap) =>
      swap.baseMint === SOL_MINT
        ? {
            ...swap,
            leaderPriceUsd: (swap.baseAmountUi * solPriceUsd) / swap.targetAmountUi
          }
        : swap
    );
  }

  private async rpc(method: string, params: unknown): Promise<unknown> {
    this.requestCount += 1;
    this.onRequest({ service: "rpc", method, credits: method === "getAsset" ? 10 : 1 });
    const payload = await this.request(() => requestJson<unknown>(this.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: this.rpcId++, method, params })
    }, {
      provider: "Helius RPC",
      fetch: this.fetch,
      timeoutMs: this.timeoutMs
    }));
    const response = asRecord(payload);
    if (!response) throw new Error(`Helius RPC ${method} returned a non-object response`);
    const rpcError = asRecord(response.error);
    if (rpcError) {
      throw new Error(
        `Helius RPC ${method} failed${finiteNumber(rpcError.code) === undefined ? "" : ` (${rpcError.code})`}: ${
          stringValue(rpcError.message) ?? "unknown RPC error"
        }`
      );
    }
    if (!("result" in response)) throw new Error(`Helius RPC ${method} omitted result`);
    return response.result;
  }

  private report(error: unknown): void {
    this.onError(error instanceof Error ? error : new Error(String(error)));
  }
}
