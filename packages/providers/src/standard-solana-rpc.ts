import { TOKEN_PROGRAM_ID, type PublicKeyString, type TransactionSignature } from "@copylab/shared";
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
const DEFAULT_RETRY_BASE_MS = 500;
const DEFAULT_MAXIMUM_RETRY_DELAY_MS = 30_000;

export interface SolanaSignatureInfo {
  signature: TransactionSignature;
  slot: number;
  blockTime?: number;
  confirmationStatus?: "confirmed" | "finalized";
  failed: boolean;
}

export interface SolanaSignaturePageRequest {
  before?: TransactionSignature;
  until?: TransactionSignature;
  limit?: number;
}

export interface StandardSolanaRpcUsage {
  method: string;
  requests: 1;
}

export interface StandardSolanaRpcClientOptions {
  httpUrl: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  requestsPerSecond?: number;
  maximumRetries?: number;
  retryBaseMs?: number;
  maximumRetryDelayMs?: number;
  jitter?: () => number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  onRequest?: (usage: StandardSolanaRpcUsage) => void;
  tryReserve?: (usage: StandardSolanaRpcUsage) => boolean;
}

export class StandardSolanaRpcBudgetError extends Error {
  constructor(readonly method: string) {
    super(`Standard Solana RPC request budget is exhausted before ${method}`);
    this.name = "StandardSolanaRpcBudgetError";
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

function assertEndpoint(raw: string, protocols: ReadonlySet<string>, label: string): string {
  if (!raw.trim()) throw new Error(`${label} is required`);
  let endpoint: URL;
  try {
    endpoint = new URL(raw);
  } catch {
    throw new Error(`${label} must be an absolute URL`);
  }
  if (!protocols.has(endpoint.protocol)) {
    throw new Error(`${label} must use ${[...protocols].join(" or ")}`);
  }
  if (endpoint.hash) throw new Error(`${label} must not include a URL fragment`);
  return endpoint.toString();
}

export function assertSolanaHttpEndpoint(raw: string): string {
  return assertEndpoint(raw, new Set(["http:", "https:"]), "Standard Solana RPC httpUrl");
}

export function assertSolanaWebSocketEndpoint(raw: string): string {
  return assertEndpoint(raw, new Set(["ws:", "wss:"]), "Standard Solana RPC wsUrl");
}

function assertAddress(address: string, label: string): void {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
    throw new Error(`${label} must be a base58 Solana address`);
  }
}

function assertSignature(signature: string): void {
  if (!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signature)) {
    throw new Error("Standard Solana transaction signature must be base58");
  }
}

function retryableRpcError(error: Record<string, unknown>): boolean {
  const code = finiteNumber(error.code);
  return code === 429 || code === -32005 || code === -32004 || code === -32603;
}

function validTransactionError(value: unknown): boolean {
  return value === null || asRecord(value) !== undefined || (typeof value === "string" && value.length > 0);
}

/**
 * A provider-neutral client for methods in Solana's standard JSON-RPC API.
 * It deliberately has no API-key concept; authentication, when needed, is
 * encoded by the operator in the explicit endpoint URL or upstream proxy.
 */
export class StandardSolanaRpcClient {
  private readonly httpUrl: string;
  private readonly fetch: FetchLike | undefined;
  private readonly timeoutMs: number;
  private readonly maximumRetries: number;
  private readonly retryBaseMs: number;
  private readonly maximumRetryDelayMs: number;
  private readonly jitter: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly onRequest: (usage: StandardSolanaRpcUsage) => void;
  private readonly tryReserve: (usage: StandardSolanaRpcUsage) => boolean;
  private readonly queue: RequestIntervalQueue;
  private requestId = 1;

  constructor(options: StandardSolanaRpcClientOptions) {
    this.httpUrl = assertSolanaHttpEndpoint(options.httpUrl);
    const requestsPerSecond = options.requestsPerSecond ?? DEFAULT_REQUESTS_PER_SECOND;
    if (!Number.isFinite(requestsPerSecond) || requestsPerSecond <= 0 || requestsPerSecond > 100) {
      throw new RangeError("Standard Solana RPC requestsPerSecond must be between 0 and 100");
    }
    this.maximumRetries = options.maximumRetries ?? DEFAULT_MAXIMUM_RETRIES;
    if (!Number.isSafeInteger(this.maximumRetries) || this.maximumRetries < 0 || this.maximumRetries > 10) {
      throw new RangeError("Standard Solana RPC maximumRetries must be an integer between 0 and 10");
    }
    this.retryBaseMs = options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
    if (!Number.isFinite(this.retryBaseMs) || this.retryBaseMs < 0) {
      throw new RangeError("Standard Solana RPC retryBaseMs must be non-negative");
    }
    this.maximumRetryDelayMs = options.maximumRetryDelayMs ?? DEFAULT_MAXIMUM_RETRY_DELAY_MS;
    if (!Number.isFinite(this.maximumRetryDelayMs) || this.maximumRetryDelayMs < 0) {
      throw new RangeError("Standard Solana RPC maximumRetryDelayMs must be non-negative");
    }
    this.fetch = options.fetch;
    this.timeoutMs = options.timeoutMs ?? 12_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new RangeError("Standard Solana RPC timeoutMs must be positive");
    }
    this.jitter = options.jitter ?? Math.random;
    const now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.onRequest = options.onRequest ?? (() => undefined);
    this.tryReserve = options.tryReserve ?? (() => true);
    this.queue = new RequestIntervalQueue(1_000 / requestsPerSecond, now, this.sleep);
  }

  async getHealth(): Promise<"ok"> {
    const result = await this.rpc("getHealth", []);
    if (result !== "ok") throw new Error(`Standard Solana RPC getHealth returned ${JSON.stringify(result)}`);
    return "ok";
  }

  async getSlot(): Promise<number> {
    const result = await this.rpc("getSlot", [{ commitment: "confirmed" }]);
    if (!Number.isSafeInteger(result) || (result as number) < 0) {
      throw new Error("Standard Solana RPC getSlot returned an invalid slot");
    }
    return result as number;
  }

  async getBlockTime(slot: number): Promise<number | null> {
    if (!Number.isSafeInteger(slot) || slot < 0) {
      throw new RangeError("Standard Solana block-time slot must be a non-negative safe integer");
    }
    const result = await this.rpc("getBlockTime", [slot]);
    if (result === null) return null;
    if (!Number.isSafeInteger(result) || (result as number) < 0) {
      throw new Error("Standard Solana RPC getBlockTime returned an invalid timestamp");
    }
    return result as number;
  }

  async getFirstAvailableBlock(): Promise<number> {
    const result = await this.rpc("getFirstAvailableBlock", []);
    if (!Number.isSafeInteger(result) || (result as number) < 0) {
      throw new Error("Standard Solana RPC getFirstAvailableBlock returned an invalid slot");
    }
    return result as number;
  }

  async getMinimumLedgerSlot(): Promise<number> {
    const result = await this.rpc("minimumLedgerSlot", []);
    if (!Number.isSafeInteger(result) || (result as number) < 0) {
      throw new Error("Standard Solana RPC minimumLedgerSlot returned an invalid slot");
    }
    return result as number;
  }

  async getBalance(address: PublicKeyString): Promise<number> {
    assertAddress(address, "Standard Solana balance address");
    const result = asRecord(await this.rpc("getBalance", [address, { commitment: "confirmed" }]));
    const value = finiteNumber(result?.value);
    if (!Number.isSafeInteger(value) || (value ?? -1) < 0) {
      throw new Error("Standard Solana RPC getBalance returned an invalid balance");
    }
    return value as number;
  }

  async getTokenAccountsByOwner(address: PublicKeyString): Promise<unknown[]> {
    assertAddress(address, "Standard Solana token-account owner");
    const result = asRecord(await this.rpc("getTokenAccountsByOwner", [
      address,
      { programId: TOKEN_PROGRAM_ID },
      { commitment: "confirmed", encoding: "base64" }
    ]));
    if (!Array.isArray(result?.value)) {
      throw new Error("Standard Solana RPC getTokenAccountsByOwner returned an invalid account list");
    }
    return result.value;
  }

  async getSignaturesForAddress(
    address: PublicKeyString,
    request: SolanaSignaturePageRequest = {}
  ): Promise<SolanaSignatureInfo[]> {
    assertAddress(address, "Standard Solana signature address");
    const limit = request.limit ?? 1_000;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new RangeError("Standard Solana signature page limit must be between 1 and 1000");
    }
    if (request.before) assertSignature(request.before);
    if (request.until) assertSignature(request.until);
    const configuration: Record<string, unknown> = { limit, commitment: "confirmed" };
    if (request.before) configuration.before = request.before;
    if (request.until) configuration.until = request.until;
    const result = await this.rpc("getSignaturesForAddress", [address, configuration]);
    if (!Array.isArray(result)) {
      throw new Error("Standard Solana RPC getSignaturesForAddress returned a non-array result");
    }
    return result.map((entry, index) => {
      const row = asRecord(entry);
      const signature = stringValue(row?.signature);
      const slot = finiteNumber(row?.slot);
      if (!signature || !Number.isSafeInteger(slot) || (slot ?? -1) < 0) {
        throw new Error(`Standard Solana signature result ${index} was malformed`);
      }
      assertSignature(signature);
      let blockTime: number | undefined;
      if (row?.blockTime !== null) {
        if (
          typeof row?.blockTime !== "number" ||
          !Number.isSafeInteger(row.blockTime) ||
          row.blockTime < 0 ||
          row.blockTime > 8_640_000_000_000
        ) {
          throw new Error(`Standard Solana signature result ${index} contained an invalid block time`);
        }
        blockTime = row.blockTime;
      }
      const confirmationStatusValue = row?.confirmationStatus === null
        ? undefined
        : stringValue(row?.confirmationStatus);
      if (
        confirmationStatusValue &&
        confirmationStatusValue !== "confirmed" &&
        confirmationStatusValue !== "finalized"
      ) {
        throw new Error(`Standard Solana signature result ${index} contained an invalid confirmation status`);
      }
      const confirmationStatus: "confirmed" | "finalized" | undefined =
        confirmationStatusValue === "confirmed" || confirmationStatusValue === "finalized"
          ? confirmationStatusValue
          : undefined;
      if (!validTransactionError(row?.err)) {
        throw new Error(`Standard Solana signature result ${index} contained an invalid error field`);
      }
      return {
        signature,
        slot: slot as number,
        ...(blockTime !== undefined ? { blockTime } : {}),
        ...(confirmationStatus ? { confirmationStatus } : {}),
        failed: row?.err !== null
      };
    });
  }

  getTransaction(signature: TransactionSignature): Promise<unknown | null> {
    assertSignature(signature);
    return this.rpc("getTransaction", [
      signature,
      { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 }
    ]);
  }

  getBlock(slot: number): Promise<unknown | null> {
    if (!Number.isSafeInteger(slot) || slot < 0) {
      throw new RangeError("Standard Solana block slot must be a non-negative safe integer");
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
          const usage = { method, requests: 1 as const };
          if (!this.tryReserve(usage)) throw new StandardSolanaRpcBudgetError(method);
          this.onRequest(usage);
          const requestId = this.requestId++;
          const payload = await requestJson<unknown>(this.httpUrl, {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })
          }, {
            provider: "Standard Solana RPC",
            fetch: this.fetch,
            timeoutMs: this.timeoutMs
          });
          const response = asRecord(payload);
          if (!response) throw new Error(`Standard Solana RPC ${method} returned a non-object response`);
          if (response.jsonrpc !== "2.0" || response.id !== requestId) {
            throw new Error(`Standard Solana RPC ${method} returned a mismatched JSON-RPC response`);
          }
          const rpcError = asRecord(response.error);
          if (rpcError) {
            const message = stringValue(rpcError.message) ?? "unknown RPC error";
            const code = finiteNumber(rpcError.code);
            throw new ProviderApiError(
              "Standard Solana RPC",
              `${method} failed${code === undefined ? "" : ` (${code})`}: ${message}`,
              { retryable: retryableRpcError(rpcError) }
            );
          }
          if (!("result" in response)) throw new Error(`Standard Solana RPC ${method} omitted result`);
          return response.result;
        });
      } catch (error) {
        const retryable = error instanceof ProviderApiError && error.retryable;
        if (!retryable || attempt >= this.maximumRetries) throw error;
        const jitter = this.jitter();
        if (!Number.isFinite(jitter) || jitter < 0 || jitter > 1) {
          throw new RangeError("Standard Solana RPC jitter must return a number between 0 and 1");
        }
        const baseDelay = Math.min(this.maximumRetryDelayMs, this.retryBaseMs * 2 ** attempt);
        await this.sleep(baseDelay * (0.75 + 0.5 * jitter));
      }
    }
  }
}
