export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

export interface PacedFetchOptions {
  requestsPerSecond: number;
  fetch?: FetchLike;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  /** Called immediately before every physical HTTP attempt, including retries. */
  onRequest?: (request: { method: string; attempt: number }) => void;
  /** Methods with a provider-documented independent rate bucket. They bypass
   * this start queue and always remain single-attempt. Defaults to none. */
  unpacedMethods?: readonly string[];
  /** Additional physical attempts after an idempotent GET receives HTTP 429.
   * Defaults to zero so existing callers retain single-attempt behavior. */
  max429Retries?: number;
  /** Exponential fallback delay when Retry-After is absent or invalid. */
  retryBaseMs?: number;
  /** Cap for exponential fallback delay. A valid Retry-After is honored. */
  maximumRetryDelayMs?: number;
}

function abortError(): Error {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal: AbortSignal | null | undefined): void {
  if (signal?.aborted) throw abortError();
}

async function abortableSleep(
  milliseconds: number,
  sleep: ((milliseconds: number) => Promise<void>) | undefined,
  signal: AbortSignal | null | undefined
): Promise<void> {
  throwIfAborted(signal);
  if (milliseconds <= 0) return;
  if (!signal) {
    if (sleep) await sleep(milliseconds);
    else await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
    return;
  }
  if (!sleep) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, milliseconds);
      const onAbort = (): void => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        reject(abortError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
    throwIfAborted(signal);
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    void sleep(milliseconds).then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
  throwIfAborted(signal);
}

function rejectPromptlyOnAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | null | undefined
): Promise<T> {
  if (!signal) return promise;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

function requestMethod(input: string | URL | Request, init?: RequestInit): string {
  return (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
}

function requestSignal(
  input: string | URL | Request,
  init?: RequestInit
): AbortSignal | null | undefined {
  return init?.signal ?? (input instanceof Request ? input.signal : undefined);
}

function retryAfterMilliseconds(value: string | null, nowMs: number): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isSafeInteger(seconds) ? seconds * 1_000 : undefined;
  }
  const at = Date.parse(trimmed);
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : undefined;
}

/**
 * Creates one account-wide HTTP start queue that can be shared by otherwise
 * independent provider clients. Operations may remain in flight concurrently;
 * only their start times are serialized, which prevents startup/repair bursts.
 */
export function createPacedFetch(options: PacedFetchOptions): FetchLike {
  if (
    !Number.isFinite(options.requestsPerSecond) ||
    options.requestsPerSecond <= 0 ||
    options.requestsPerSecond > 100
  ) {
    throw new RangeError("Paced fetch requestsPerSecond must be greater than 0 and no more than 100");
  }
  const now = options.now ?? Date.now;
  const sleep = options.sleep;
  const fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const intervalMs = 1_000 / options.requestsPerSecond;
  const max429Retries = options.max429Retries ?? 0;
  const retryBaseMs = options.retryBaseMs ?? 1_000;
  const maximumRetryDelayMs = options.maximumRetryDelayMs ?? 30_000;
  const unpacedMethods = new Set(
    (options.unpacedMethods ?? []).map((method) => method.trim().toUpperCase()).filter(Boolean)
  );
  if (!Number.isSafeInteger(max429Retries) || max429Retries < 0 || max429Retries > 10) {
    throw new RangeError("Paced fetch max429Retries must be a safe integer between 0 and 10");
  }
  if (!Number.isFinite(retryBaseMs) || retryBaseMs < 0) {
    throw new RangeError("Paced fetch retryBaseMs must be non-negative");
  }
  if (!Number.isFinite(maximumRetryDelayMs) || maximumRetryDelayMs < 0) {
    throw new RangeError("Paced fetch maximumRetryDelayMs must be non-negative");
  }
  let tail: Promise<void> = Promise.resolve();
  let lastStartedAt = Number.NEGATIVE_INFINITY;
  let notBeforeAt = Number.NEGATIVE_INFINITY;

  const scheduleStart = (signal: AbortSignal | null | undefined): Promise<void> => {
    const queuedStart = tail.then(async () => {
      throwIfAborted(signal);
      // Re-evaluate after every wait because another in-flight response can
      // publish an account-wide Retry-After while this request is queued.
      for (;;) {
        const current = now();
        if (current < lastStartedAt) lastStartedAt = current - intervalMs;
        const pacedStartAt = Number.isFinite(lastStartedAt)
          ? lastStartedAt + intervalMs
          : current;
        const remaining = Math.max(pacedStartAt, notBeforeAt) - current;
        if (remaining <= 0) break;
        await abortableSleep(remaining, sleep, signal);
        throwIfAborted(signal);
      }
      throwIfAborted(signal);
      lastStartedAt = now();
    });
    tail = queuedStart.then(() => undefined, () => undefined);
    // The internal queue node remains in order, but a caller whose request
    // timeout aborts does not have to wait for all older queue slots first.
    return rejectPromptlyOnAbort(queuedStart, signal);
  };

  return async (input, init) => {
    const method = requestMethod(input, init);
    const signal = requestSignal(input, init);
    if (unpacedMethods.has(method)) {
      throwIfAborted(signal);
      options.onRequest?.({ method, attempt: 1 });
      return fetch(input, init);
    }
    for (let retry = 0; ; retry += 1) {
      await scheduleStart(signal);
      throwIfAborted(signal);
      options.onRequest?.({ method, attempt: retry + 1 });
      const response = await fetch(input, init);
      if (method !== "GET" || response.status !== 429 || retry >= max429Retries) {
        return response;
      }
      const retryAfter = retryAfterMilliseconds(response.headers.get("retry-after"), now());
      const fallback = Math.min(maximumRetryDelayMs, retryBaseMs * 2 ** retry);
      const delay = retryAfter ?? fallback;
      notBeforeAt = Math.max(notBeforeAt, now() + delay);
      await response.body?.cancel().catch(() => undefined);
      // Looping deliberately submits the retry through scheduleStart again.
      // The shared not-before timestamp also holds back already queued peers.
    }
  };
}

export interface JsonRequestOptions {
  fetch: FetchLike | undefined;
  timeoutMs?: number;
  provider: string;
}

/**
 * Removes credentials and opaque endpoint paths from text before it reaches a
 * durable audit row, API response, or log. Operator RPC URLs may carry bearer
 * material in user-info, path, or query components, so retaining only the
 * origin is intentional.
 */
export function redactSensitiveText(value: unknown, maximumLength = 2_000): string {
  const text = typeof value === "string" ? value : String(value);
  return text
    .replace(/\b(?:https?|wss?):\/\/[^\s<>"']+/gi, (raw) => {
      try {
        const endpoint = new URL(raw);
        return `${endpoint.protocol}//${endpoint.host}/[redacted-endpoint]`;
      } catch {
        return "[redacted-endpoint]";
      }
    })
    .replace(/\bauthorization\s*["'=:\s]+\s*bearer\s+[^\s,"'};]+/gi, "Authorization: Bearer [redacted]")
    .replace(/\bbearer\s+[^\s,"'};]+/gi, "Bearer [redacted]")
    .replace(/(?:api[_ -]?key|authorization|bearer)\s*["'=:\s]+[^\s,"'};]+/gi, "[redacted-credential]")
    .replace(/([?&][A-Za-z0-9_.~-]{1,64}=)[^&\s]+/g, "$1[redacted]")
    .replace(/[A-Za-z0-9_-]{32,}/g, "[redacted]")
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, Math.max(0, Math.min(10_000, Math.trunc(maximumLength))));
}

export class ProviderApiError extends Error {
  readonly provider: string;
  readonly status: number | undefined;
  readonly retryable: boolean;
  /** Provider-owned machine-readable error code, when the response supplies a
   * short scalar code. The raw response body is intentionally never retained. */
  readonly providerCode: string | undefined;

  constructor(
    provider: string,
    message: string,
    options: {
      status?: number;
      retryable?: boolean;
      providerCode?: string;
      cause?: unknown;
    } = {}
  ) {
    super(`${provider}: ${redactSensitiveText(message)}`, { cause: options.cause });
    this.name = "ProviderApiError";
    this.provider = provider;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
    this.providerCode = options.providerCode;
  }
}

const DEFAULT_TIMEOUT_MS = 10_000;

function endpointLabel(input: string | URL | Request): string {
  try {
    const raw = input instanceof Request ? input.url : input.toString();
    const url = new URL(raw);
    return `${url.protocol}//${url.host}`;
  } catch {
    return "provider endpoint";
  }
}

function safeBodyPreview(body: string): string {
  if (!body) return "empty response body";
  return redactSensitiveText(body, 400);
}

function safeProviderCode(body: string): string | undefined {
  try {
    const value = JSON.parse(body) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    const candidate = record.errorCode ?? record.code;
    const code = typeof candidate === "string" || typeof candidate === "number"
      ? String(candidate).trim()
      : "";
    return /^[A-Za-z0-9_.:-]{1,80}$/.test(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

export async function requestJson<T>(
  input: string | URL | Request,
  init: RequestInit | undefined,
  options: JsonRequestOptions
): Promise<T> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const label = endpointLabel(input);

  try {
    const response = await fetchImpl(input, { ...init, signal: controller.signal });
    const body = await response.text();
    if (!response.ok) {
      const providerCode = safeProviderCode(body);
      throw new ProviderApiError(
        options.provider,
        `${label} returned HTTP ${response.status}: ${safeBodyPreview(body)}`,
        {
          status: response.status,
          retryable: response.status === 408 || response.status === 429 || response.status >= 500,
          ...(providerCode === undefined ? {} : { providerCode })
        }
      );
    }

    try {
      return JSON.parse(body) as T;
    } catch (error) {
      throw new ProviderApiError(
        options.provider,
        `${label} returned invalid JSON: ${safeBodyPreview(body)}`,
        { cause: error }
      );
    }
  } catch (error) {
    if (error instanceof ProviderApiError) throw error;
    if (controller.signal.aborted) {
      throw new ProviderApiError(
        options.provider,
        `${label} timed out after ${timeoutMs}ms`,
        { retryable: true, cause: error }
      );
    }
    throw new ProviderApiError(
      options.provider,
      `${label} request failed: ${error instanceof Error ? error.message : String(error)}`,
      { retryable: true, cause: error }
    );
  } finally {
    clearTimeout(timeout);
  }
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function nonNegativeNumber(value: unknown, fallback = 0): number {
  const parsed = finiteNumber(value);
  return parsed !== undefined && parsed >= 0 ? parsed : fallback;
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function cloneJson<T>(value: T): T {
  return structuredClone(value);
}
