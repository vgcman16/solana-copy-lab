import type { PublicKeyString, TransactionSignature } from "@copylab/shared";
import {
  asRecord,
  finiteNumber,
  ProviderApiError,
  requestJson,
  stringValue,
  type FetchLike
} from "./http.js";

const DEFAULT_REQUESTS_PER_SECOND = 5;
const DEFAULT_MAXIMUM_RETRIES = 3;
const DEFAULT_RETRY_BASE_MS = 1_000;
const DEFAULT_MAXIMUM_RETRY_DELAY_MS = 30_000;

export interface HeliusSignatureInfo {
  signature: TransactionSignature;
  slot: number;
  blockTime?: number;
  confirmationStatus?: string;
  failed: boolean;
}

export interface HeliusSignaturePageRequest {
  before?: TransactionSignature;
  until?: TransactionSignature;
  limit?: number;
}

export interface HeliusRpcRequestUsage {
  method: string;
  credits: number;
}

export interface HeliusRpcClientOptions {
  rpcUrl?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  requestsPerSecond?: number;
  maximumRetries?: number;
  retryBaseMs?: number;
  maximumRetryDelayMs?: number;
  jitter?: () => number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  onRequest?: (usage: HeliusRpcRequestUsage) => void;
  tryReserve?: (usage: HeliusRpcRequestUsage) => boolean;
}

export class HeliusRpcBudgetError extends Error {
  constructor(readonly method: string) {
    super(`Helius index RPC credit budget is exhausted before ${method}`);
    this.name = "HeliusRpcBudgetError";
  }
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
    this.tail = start.then(
      () => undefined,
      () => undefined
    );
    return start.then(operation);
  }
}

function retryableRpcError(error: Record<string, unknown>): boolean {
  const code = finiteNumber(error.code);
  return code === 429 || code === -32005 || code === -32004 || code === -32603;
}

function assertAddress(address: string, label: string): void {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
    throw new Error(`${label} must be a base58 Solana address`);
  }
}

export class HeliusRpcClient {
  private readonly rpcUrl: string;
  private readonly fetch: FetchLike | undefined;
  private readonly timeoutMs: number;
  private readonly maximumRetries: number;
  private readonly retryBaseMs: number;
  private readonly maximumRetryDelayMs: number;
  private readonly jitter: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly onRequest: (usage: HeliusRpcRequestUsage) => void;
  private readonly tryReserve: (usage: HeliusRpcRequestUsage) => boolean;
  private readonly queue: RequestIntervalQueue;
  private requestId = 1;

  constructor(apiKey: string, options: HeliusRpcClientOptions = {}) {
    if (!apiKey.trim()) throw new Error("Helius API key is required");
    const requestsPerSecond = options.requestsPerSecond ?? DEFAULT_REQUESTS_PER_SECOND;
    if (!Number.isFinite(requestsPerSecond) || requestsPerSecond <= 0 || requestsPerSecond > 10) {
      throw new RangeError("Helius index RPC requestsPerSecond must be between 0 and 10");
    }
    this.maximumRetries = options.maximumRetries ?? DEFAULT_MAXIMUM_RETRIES;
    if (!Number.isSafeInteger(this.maximumRetries) || this.maximumRetries < 0 || this.maximumRetries > 10) {
      throw new RangeError("Helius index RPC maximumRetries must be an integer between 0 and 10");
    }
    this.retryBaseMs = options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
    if (!Number.isFinite(this.retryBaseMs) || this.retryBaseMs < 0) {
      throw new RangeError("Helius index RPC retryBaseMs must be non-negative");
    }
    this.maximumRetryDelayMs = options.maximumRetryDelayMs ?? DEFAULT_MAXIMUM_RETRY_DELAY_MS;
    if (!Number.isFinite(this.maximumRetryDelayMs) || this.maximumRetryDelayMs < 0) {
      throw new RangeError("Helius index RPC maximumRetryDelayMs must be non-negative");
    }
    this.jitter = options.jitter ?? Math.random;
    this.rpcUrl =
      options.rpcUrl ?? `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(apiKey)}`;
    this.fetch = options.fetch;
    this.timeoutMs = options.timeoutMs ?? 12_000;
    const now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.onRequest = options.onRequest ?? (() => undefined);
    this.tryReserve = options.tryReserve ?? (() => true);
    this.queue = new RequestIntervalQueue(1_000 / requestsPerSecond, now, this.sleep);
  }

  async getSignaturesForAddress(
    address: PublicKeyString,
    request: HeliusSignaturePageRequest = {}
  ): Promise<HeliusSignatureInfo[]> {
    assertAddress(address, "Helius signature address");
    const limit = request.limit ?? 1_000;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new RangeError("Helius signature page limit must be between 1 and 1000");
    }
    const options: Record<string, unknown> = { limit, commitment: "confirmed" };
    if (request.before) options.before = request.before;
    if (request.until) options.until = request.until;
    const result = await this.rpc("getSignaturesForAddress", [address, options]);
    if (!Array.isArray(result)) throw new Error("Helius getSignaturesForAddress returned a non-array result");
    return result.map((entry, index) => {
      const row = asRecord(entry);
      const signature = stringValue(row?.signature);
      const slot = finiteNumber(row?.slot);
      if (!signature || slot === undefined || !Number.isSafeInteger(slot) || slot < 0) {
        throw new Error(`Helius signature result ${index} was malformed`);
      }
      if (!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signature)) {
        throw new Error(`Helius signature result ${index} contained an invalid signature`);
      }
      if (typeof row?.slot !== "number" || !Number.isSafeInteger(row.slot) || row.slot < 0) {
        throw new Error(`Helius signature result ${index} contained an invalid slot`);
      }
      let blockTime: number | undefined;
      if (row?.blockTime !== null) {
        if (
          typeof row?.blockTime !== "number" ||
          !Number.isSafeInteger(row.blockTime) ||
          row.blockTime < 0 ||
          row.blockTime > 8_640_000_000_000
        ) throw new Error(`Helius signature result ${index} contained an invalid block time`);
        blockTime = row.blockTime;
      }
      const confirmationStatus = row?.confirmationStatus === null
        ? undefined
        : stringValue(row?.confirmationStatus);
      if (confirmationStatus && confirmationStatus !== "confirmed" && confirmationStatus !== "finalized") {
        throw new Error(`Helius signature result ${index} contained an invalid confirmation status`);
      }
      // Solana's TransactionError is serialized either as a tagged object
      // (for variants with data) or as a string enum variant. Keep the
      // payload opaque here: the indexer only needs the reliable failed bit.
      const errorField = row?.err;
      const validErrorField = errorField === null ||
        asRecord(errorField) !== undefined ||
        (typeof errorField === "string" && errorField.length > 0);
      if (!validErrorField) {
        throw new Error(`Helius signature result ${index} contained an invalid error field`);
      }
      return {
        signature,
        slot,
        ...(blockTime !== undefined ? { blockTime } : {}),
        ...(confirmationStatus ? { confirmationStatus } : {}),
        failed: errorField !== null
      };
    });
  }

  getTransaction(signature: TransactionSignature): Promise<unknown | null> {
    if (!signature.trim()) throw new Error("Helius transaction signature is required");
    return this.rpc("getTransaction", [
      signature,
      { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 }
    ]);
  }

  getBlock(slot: number): Promise<unknown | null> {
    if (!Number.isSafeInteger(slot) || slot < 0) {
      throw new RangeError("Helius block slot must be a non-negative safe integer");
    }
    return this.rpc("getBlock", [
      slot,
      {
        commitment: "confirmed",
        encoding: "jsonParsed",
        transactionDetails: "full",
        rewards: false,
        maxSupportedTransactionVersion: 0
      }
    ]);
  }

  private async rpc(method: string, params: unknown): Promise<unknown> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.queue.schedule(async () => {
          const usage = { method, credits: 1 };
          if (!this.tryReserve(usage)) throw new HeliusRpcBudgetError(method);
          this.onRequest(usage);
          const payload = await requestJson<unknown>(this.rpcUrl, {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: this.requestId++, method, params })
          }, {
            provider: "Helius index RPC",
            fetch: this.fetch,
            timeoutMs: this.timeoutMs
          });
          const response = asRecord(payload);
          if (!response) throw new Error(`Helius RPC ${method} returned a non-object response`);
          const rpcError = asRecord(response.error);
          if (rpcError) {
            const message = stringValue(rpcError.message) ?? "unknown RPC error";
            const code = finiteNumber(rpcError.code);
            throw new ProviderApiError(
              "Helius index RPC",
              `${method} failed${code === undefined ? "" : ` (${code})`}: ${message}`,
              { retryable: retryableRpcError(rpcError) }
            );
          }
          if (!("result" in response)) throw new Error(`Helius RPC ${method} omitted result`);
          return response.result;
        });
      } catch (error) {
        const retryable = error instanceof ProviderApiError && error.retryable;
        if (!retryable || attempt >= this.maximumRetries) throw error;
        const jitter = this.jitter();
        if (!Number.isFinite(jitter) || jitter < 0 || jitter > 1) {
          throw new RangeError("Helius RPC jitter must return a number between 0 and 1");
        }
        const baseDelay = Math.min(this.maximumRetryDelayMs, this.retryBaseMs * 2 ** attempt);
        await this.sleep(baseDelay * (0.75 + 0.5 * jitter));
      }
    }
  }

}
