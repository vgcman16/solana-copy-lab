import {
  SOL_MINT,
  USDC_MINT,
  type ProviderHealth,
  type QuoteExecutor,
  type QuoteRequest,
  type QuoteSnapshot,
  type TransactionSignature
} from "@copylab/shared";
import {
  asRecord,
  errorMessage,
  finiteNumber,
  ProviderApiError,
  requestJson,
  stringValue,
  type FetchLike
} from "./http.js";

export interface JupiterSwapOptions {
  baseUrl?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  now?: () => Date;
}

function requiredString(record: Record<string, unknown>, field: string): string {
  const value = stringValue(record[field]);
  if (!value) throw new Error(`Jupiter order response omitted ${field}`);
  return value;
}

function requiredNumber(record: Record<string, unknown>, field: string): number {
  const value = finiteNumber(record[field]);
  if (value === undefined) throw new Error(`Jupiter order response omitted ${field}`);
  return value;
}

function requiredNonNegativeNumber(record: Record<string, unknown>, field: string): number {
  const value = requiredNumber(record, field);
  if (value < 0) throw new Error(`Jupiter order response contained a negative ${field}`);
  return value;
}

function atomicAmount(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new Error(`Jupiter response contained an invalid ${field}`);
  }
  return value;
}

function isPositiveAtomic(value: string | undefined): value is string {
  return value !== undefined && /^\d+$/.test(value) && BigInt(value) > 0n;
}

function isTransactionSignature(value: string | undefined): value is string {
  return value !== undefined && /^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(value);
}

const ALLOWED_ONCHAIN_ROUTERS = new Set(["metis", "iris"]);
export const JUPITER_NO_ROUTES_ERROR_CODE = "NO_ROUTES_FOUND";

export class JupiterQuoteError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(
    code: string,
    message: string,
    options: { retryable?: boolean; cause?: unknown } = {}
  ) {
    super(`Jupiter quote failed (${code}): ${message}`, { cause: options.cause });
    this.name = "JupiterQuoteError";
    this.code = code;
    this.retryable = options.retryable ?? false;
  }
}

export function isJupiterNoRouteError(error: unknown): error is JupiterQuoteError {
  return error instanceof JupiterQuoteError && error.code === JUPITER_NO_ROUTES_ERROR_CODE;
}

function quoteErrorCode(value: unknown): string | undefined {
  const code = typeof value === "string" || typeof value === "number"
    ? String(value).trim()
    : "";
  return /^[A-Za-z0-9_.:-]{1,80}$/.test(code) ? code : undefined;
}

export function normalizePriceImpactPercent(
  directImpact: number | undefined,
  legacyImpactFraction: number | undefined
): number {
  const legacyPercent = legacyImpactFraction === undefined
    ? undefined
    : Math.abs(legacyImpactFraction * 100);
  if (directImpact === undefined) return legacyPercent ?? 0;
  const directAbsolute = Math.abs(directImpact);
  if (legacyPercent === undefined) {
    // The Swap v2 schema describes a lone `priceImpact` as a decimal fraction.
    return directAbsolute * 100;
  }
  const tolerance = Math.max(1e-8, legacyPercent * 0.01);
  if (Math.abs(directAbsolute - legacyPercent) <= tolerance) {
    // Current production responses also include priceImpactPct and expose
    // priceImpact pre-normalized to percentage points.
    return directAbsolute;
  }
  // Schema versions have differed. Fail closed when fields disagree so the
  // risk engine never understates execution cost.
  return Math.max(directAbsolute * 100, legacyPercent);
}

export class JupiterSwapProvider implements QuoteExecutor {
  private readonly baseUrl: string;
  private readonly fetch: FetchLike | undefined;
  private readonly timeoutMs: number;
  private readonly now: () => Date;
  private requestCount = 0;

  constructor(
    private readonly apiKey: string,
    options: JupiterSwapOptions = {}
  ) {
    if (!apiKey.trim()) throw new Error("Jupiter API key is required");
    this.baseUrl = (options.baseUrl ?? "https://api.jup.ag/swap/v2").replace(/\/$/, "");
    this.fetch = options.fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.now = options.now ?? (() => new Date());
  }

  async quote(request: QuoteRequest): Promise<QuoteSnapshot> {
    if (!request.inputMint || !request.outputMint || request.inputMint === request.outputMint) {
      throw new Error("Jupiter quote requires two different mint addresses");
    }
    if (!/^\d+$/.test(request.inputAmountAtomic) || BigInt(request.inputAmountAtomic) <= 0n) {
      throw new Error("Jupiter quote amount must be a positive atomic integer string");
    }

    const url = new URL(`${this.baseUrl}/order`);
    url.searchParams.set("inputMint", request.inputMint);
    url.searchParams.set("outputMint", request.outputMint);
    url.searchParams.set("amount", request.inputAmountAtomic);
    // V1 signs only the on-chain Jupiter aggregator transaction shape. RFQ and
    // third-party router transactions intentionally fail closed at this boundary.
    // Swap v2 currently labels the on-chain router `metis`; older responses used
    // `iris`, so both labels are accepted while the RFQ routers remain excluded.
    url.searchParams.set("excludeRouters", "jupiterz,dflow,okx");
    if (request.taker) url.searchParams.set("taker", request.taker);
    this.requestCount += 1;
    let payload: unknown;
    try {
      payload = await requestJson<unknown>(url, {
        headers: { "x-api-key": this.apiKey, accept: "application/json" }
      }, {
        provider: "Jupiter Swap",
        fetch: this.fetch,
        timeoutMs: this.timeoutMs
      });
    } catch (error) {
      if (error instanceof ProviderApiError && error.providerCode === JUPITER_NO_ROUTES_ERROR_CODE) {
        throw new JupiterQuoteError(
          JUPITER_NO_ROUTES_ERROR_CODE,
          "no executable route exists for the requested pair and amount",
          { retryable: false, cause: error }
        );
      }
      // Swap v2 currently returns this non-retryable HTTP 400 shape for some
      // dead/illiquid pairs without the documented NO_ROUTES_FOUND code. The
      // request has already passed our mint/amount validation, so preserve the
      // provider's exact terminal meaning instead of misclassifying it as a
      // temporary service outage and retrying it forever.
      if (
        error instanceof ProviderApiError &&
        error.status === 400 &&
        error.retryable === false &&
        /\bfailed to get quotes\b/iu.test(error.message)
      ) {
        throw new JupiterQuoteError(
          JUPITER_NO_ROUTES_ERROR_CODE,
          "no executable route exists for the requested pair and amount",
          { retryable: false, cause: error }
        );
      }
      throw error;
    }
    const order = asRecord(payload);
    if (!order) throw new Error("Jupiter order returned a non-object response");
    const apiErrorCode = quoteErrorCode(order.errorCode);
    if (apiErrorCode === JUPITER_NO_ROUTES_ERROR_CODE) {
      throw new JupiterQuoteError(
        apiErrorCode,
        stringValue(order.errorMessage) ?? stringValue(order.error) ?? "the order API rejected the quote",
        { retryable: false }
      );
    }

    const inputMint = requiredString(order, "inputMint");
    const outputMint = requiredString(order, "outputMint");
    const inAmount = atomicAmount(order.inAmount, "inAmount");
    if (
      inputMint !== request.inputMint ||
      outputMint !== request.outputMint ||
      inAmount !== request.inputAmountAtomic
    ) {
      throw new Error("Jupiter order response did not match the requested pair and amount");
    }

    const transaction = order.transaction;
    if (request.taker && (typeof transaction !== "string" || transaction.length === 0)) {
      const code = finiteNumber(order.errorCode);
      const detail = stringValue(order.errorMessage) ?? "transaction was not built";
      throw new Error(
        `Jupiter could quote but not build the order${code === undefined ? "" : ` (code ${code})`}: ${detail}`
      );
    }

    const directImpact = finiteNumber(order.priceImpact);
    const legacyImpact = finiteNumber(order.priceImpactPct);
    const priceImpactPercent = normalizePriceImpactPercent(directImpact, legacyImpact);
    const quotedAt = this.now();
    const outAmount = atomicAmount(order.outAmount, "outAmount");
    const minimumOutput = atomicAmount(order.otherAmountThreshold, "otherAmountThreshold");
    if (BigInt(outAmount) <= 0n || BigInt(minimumOutput) <= 0n || BigInt(minimumOutput) > BigInt(outAmount)) {
      throw new Error("Jupiter order response contained invalid output bounds");
    }
    const inputUsd = requiredNumber(order, "inUsdValue");
    const outputUsd = requiredNumber(order, "outUsdValue");
    if (inputUsd <= 0 || outputUsd <= 0) {
      throw new Error("Jupiter order response contained invalid USD values");
    }
    const router = requiredString(order, "router");
    if (!ALLOWED_ONCHAIN_ROUTERS.has(router.toLowerCase())) {
      throw new Error(
        `Jupiter selected unsupported router ${router}; v1 permits only Metis/Iris on-chain routes`
      );
    }
    const snapshot: QuoteSnapshot = {
      requestId: requiredString(order, "requestId"),
      quotedAt: quotedAt.toISOString(),
      inputMint,
      outputMint,
      inputAmountAtomic: inAmount,
      outputAmountAtomic: outAmount,
      inputUsd,
      outputUsd,
      priceImpactPercent,
      slippageBps: requiredNonNegativeNumber(order, "slippageBps"),
      feeBps: requiredNonNegativeNumber(order, "feeBps"),
      signatureFeeLamports: requiredNonNegativeNumber(order, "signatureFeeLamports"),
      prioritizationFeeLamports: requiredNonNegativeNumber(order, "prioritizationFeeLamports"),
      rentFeeLamports: requiredNonNegativeNumber(order, "rentFeeLamports"),
      minimumOutputAtomic: minimumOutput,
      router
    };
    if (typeof transaction === "string" && transaction.length > 0) {
      snapshot.transactionBase64 = transaction;
    }
    const expiresAt = stringValue(order.expireAt);
    if (expiresAt && Number.isFinite(Date.parse(expiresAt))) {
      snapshot.expiresAt = new Date(expiresAt).toISOString();
    }
    return snapshot;
  }

  async execute(
    signedTransactionBase64: string,
    requestId: string
  ): Promise<{
    success: boolean;
    signature?: TransactionSignature;
    inputAmountAtomic?: string;
    outputAmountAtomic?: string;
    error?: string;
  }> {
    if (!signedTransactionBase64) throw new Error("Signed Jupiter transaction is required");
    if (!requestId) throw new Error("Jupiter requestId is required");
    this.requestCount += 1;
    const payload = await requestJson<unknown>(`${this.baseUrl}/execute`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        accept: "application/json"
      },
      body: JSON.stringify({ signedTransaction: signedTransactionBase64, requestId })
    }, {
      provider: "Jupiter Swap",
      fetch: this.fetch,
      timeoutMs: this.timeoutMs
    });
    const result = asRecord(payload);
    if (!result) throw new Error("Jupiter execute returned a non-object response");
    const code = finiteNumber(result.code);
    const apiReportedSuccess = result.status === "Success" && code === 0;
    const signature = stringValue(result.signature);
    const totalInput = stringValue(result.totalInputAmount);
    const totalOutput = stringValue(result.totalOutputAmount);
    const success =
      apiReportedSuccess &&
      isTransactionSignature(signature) &&
      isPositiveAtomic(totalInput) &&
      isPositiveAtomic(totalOutput);
    const response: {
      success: boolean;
      signature?: TransactionSignature;
      inputAmountAtomic?: string;
      outputAmountAtomic?: string;
      error?: string;
    } = { success };
    const actualInput = totalInput ?? stringValue(result.inputAmountResult);
    const actualOutput = totalOutput ?? stringValue(result.outputAmountResult);
    if (isTransactionSignature(signature)) response.signature = signature;
    if (isPositiveAtomic(actualInput)) response.inputAmountAtomic = actualInput;
    if (isPositiveAtomic(actualOutput)) response.outputAmountAtomic = actualOutput;
    if (!success) {
      response.error = apiReportedSuccess
        ? "Jupiter execution returned malformed confirmation evidence (signature or wallet totals missing)"
        : `Jupiter execution failed${code === undefined ? "" : ` (code ${code})`}: ${
            stringValue(result.error) ?? "unknown execution error"
          }`;
    }
    return response;
  }

  async checkHealth(): Promise<ProviderHealth> {
    const startedAt = this.now().getTime();
    try {
      await this.quote({
        inputMint: SOL_MINT,
        outputMint: USDC_MINT,
        inputAmountAtomic: "10000000"
      });
      return {
        provider: "jupiter",
        ok: true,
        checkedAt: this.now().toISOString(),
        latencyMs: Math.max(0, this.now().getTime() - startedAt),
        message: "Jupiter Swap v2 order API is reachable and authenticated",
        usage: { requests: this.requestCount, window: "unknown" }
      };
    } catch (error) {
      return {
        provider: "jupiter",
        ok: false,
        checkedAt: this.now().toISOString(),
        latencyMs: Math.max(0, this.now().getTime() - startedAt),
        message: errorMessage(error),
        usage: { requests: this.requestCount, window: "unknown" }
      };
    }
  }
}
