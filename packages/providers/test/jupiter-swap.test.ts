import { SOL_MINT, USDC_MINT } from "@copylab/shared";
import { describe, expect, it } from "vitest";
import {
  isJupiterNoRouteError,
  JupiterQuoteError,
  JupiterSwapProvider,
  normalizePriceImpactPercent
} from "../src/jupiter-swap.js";
import { jsonResponse, mockFetch } from "./helpers.js";

const TAKER = "7YttLkHDoNj9wyDur5KrsbG7k9QWgxsWUcJpm5bLzZx1";
const CONFIRMED_SIGNATURE =
  "4Xwyv79hMUBC2sQtcd6V89AAf3j3aa5noEtuEwPAXnUawMjsyfojzTtHaKWGcVPvu6wsiEQUsKEP5km2VD5dAusv";

function orderResponse(overrides: Record<string, unknown> = {}) {
  return {
    mode: "ultra",
    inputMint: SOL_MINT,
    outputMint: USDC_MINT,
    inAmount: "100000000",
    outAmount: "17057460",
    inUsdValue: 17.13,
    outUsdValue: 17.06,
    priceImpact: -0.013115995201493341,
    priceImpactPct: "-0.0001311599520149334",
    otherAmountThreshold: "17040402",
    slippageBps: 10,
    feeBps: 2,
    signatureFeeLamports: 5_000,
    prioritizationFeeLamports: 254_600,
    rentFeeLamports: 0,
    router: "metis",
    transaction: "dW5zaWduZWQtdHg=",
    requestId: "request-1",
    expireAt: "2026-07-09T12:00:05Z",
    ...overrides
  };
}

describe("JupiterSwapProvider", () => {
  it("maps a Swap v2 order into a quote snapshot", async () => {
    const provider = new JupiterSwapProvider("key", {
      now: () => new Date("2026-07-09T12:00:00Z"),
      fetch: mockFetch((url) => {
        expect(url.pathname).toBe("/swap/v2/order");
        expect(url.searchParams.get("taker")).toBe(TAKER);
        expect(url.searchParams.get("excludeRouters")).toBe("jupiterz,dflow,okx");
        return jsonResponse(orderResponse());
      })
    });
    const quote = await provider.quote({
      inputMint: SOL_MINT,
      outputMint: USDC_MINT,
      inputAmountAtomic: "100000000",
      taker: TAKER
    });
    expect(quote).toMatchObject({
      requestId: "request-1",
      outputAmountAtomic: "17057460",
      minimumOutputAtomic: "17040402",
      inputUsd: 17.13,
      outputUsd: 17.06,
      priceImpactPercent: 0.013115995201493341,
      signatureFeeLamports: 5_000,
      prioritizationFeeLamports: 254_600,
      router: "metis",
      transactionBase64: "dW5zaWduZWQtdHg=",
      expiresAt: "2026-07-09T12:00:05.000Z"
    });
  });

  it("continues to accept the legacy Iris label for on-chain routes", async () => {
    const provider = new JupiterSwapProvider("key", {
      fetch: mockFetch(() => jsonResponse(orderResponse({ router: "iris" })))
    });
    await expect(provider.quote({
      inputMint: SOL_MINT,
      outputMint: USDC_MINT,
      inputAmountAtomic: "100000000"
    })).resolves.toMatchObject({ router: "iris" });
  });

  it("preserves Jupiter's machine-readable no-route condition without retaining raw response data", async () => {
    const provider = new JupiterSwapProvider("key", {
      fetch: mockFetch(() => jsonResponse({
        error: "No routes found",
        errorCode: "NO_ROUTES_FOUND"
      }, 400))
    });

    const caught = await provider.quote({
      inputMint: SOL_MINT,
      outputMint: USDC_MINT,
      inputAmountAtomic: "100000000"
    }).catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(JupiterQuoteError);
    expect(isJupiterNoRouteError(caught)).toBe(true);
    expect(caught).toMatchObject({ code: "NO_ROUTES_FOUND", retryable: false });
  });

  it("normalizes Swap v2's current non-retryable failed-quotes response as no-route", async () => {
    const provider = new JupiterSwapProvider("key", {
      fetch: mockFetch(() => jsonResponse({
        requestId: "opaque-request-id",
        error: "Failed to get quotes"
      }, 400))
    });

    const caught = await provider.quote({
      inputMint: SOL_MINT,
      outputMint: USDC_MINT,
      inputAmountAtomic: "100000000"
    }).catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(JupiterQuoteError);
    expect(isJupiterNoRouteError(caught)).toBe(true);
    expect(caught).toMatchObject({ code: "NO_ROUTES_FOUND", retryable: false });
  });

  it("accepts the current Metis label during credential health validation", async () => {
    const provider = new JupiterSwapProvider("key", {
      fetch: mockFetch(() => jsonResponse(orderResponse({
        router: "metis",
        inAmount: "10000000",
        transaction: null
      })))
    });
    await expect(provider.checkHealth()).resolves.toMatchObject({
      provider: "jupiter",
      ok: true,
      message: "Jupiter Swap v2 order API is reachable and authenticated"
    });
  });

  it("normalizes both documented and current price-impact response shapes conservatively", () => {
    // Documented decimal-only schema: -0.001 is 0.1%.
    expect(normalizePriceImpactPercent(-0.001, undefined)).toBeCloseTo(0.1);
    // Current /order example: direct is already percentage points and agrees
    // with the deprecated decimal-fraction field after conversion.
    expect(normalizePriceImpactPercent(-0.013115995201493341, -0.0001311599520149334))
      .toBeCloseTo(0.013115995201493341);
    // Inconsistent versions fail closed by retaining the larger normalized cost.
    expect(normalizePriceImpactPercent(0.01, 0.00001)).toBe(1);
  });

  it("rejects a taker order when Jupiter cannot build the transaction", async () => {
    const provider = new JupiterSwapProvider("key", {
      fetch: mockFetch(() => jsonResponse(orderResponse({
        transaction: "",
        errorCode: 2,
        errorMessage: "Top up SOL for gas"
      })))
    });
    await expect(provider.quote({
      inputMint: SOL_MINT,
      outputMint: USDC_MINT,
      inputAmountAtomic: "100000000",
      taker: TAKER
    })).rejects.toThrow("could quote but not build");
  });

  it.each(["jupiterz", "dflow", "okx", "unknown"])(
    "fails closed if the non-on-chain router %s is returned",
    async (router) => {
      const provider = new JupiterSwapProvider("key", {
        fetch: mockFetch(() => jsonResponse(orderResponse({ router })))
      });
      await expect(provider.quote({
        inputMint: SOL_MINT,
        outputMint: USDC_MINT,
        inputAmountAtomic: "100000000"
      })).rejects.toThrow("permits only Metis/Iris on-chain routes");
    }
  );

  it("uses wallet-reflected totals from execute and returns typed failures", async () => {
    let calls = 0;
    const provider = new JupiterSwapProvider("key", {
      fetch: mockFetch((_url, init) => {
        calls += 1;
        expect(init?.method).toBe("POST");
        return calls === 1
          ? jsonResponse({
              status: "Success",
              code: 0,
              signature: CONFIRMED_SIGNATURE,
              totalInputAmount: "100000000",
              totalOutputAmount: "17050000",
              inputAmountResult: "99900000",
              outputAmountResult: "17057460"
            })
          : jsonResponse({ status: "Failed", code: -2003, error: "Quote expired" });
      })
    });
    await expect(provider.execute("c2lnbmVk", "request-1")).resolves.toEqual({
      success: true,
      signature: CONFIRMED_SIGNATURE,
      inputAmountAtomic: "100000000",
      outputAmountAtomic: "17050000"
    });
    await expect(provider.execute("c2lnbmVk", "request-2")).resolves.toEqual({
      success: false,
      error: "Jupiter execution failed (code -2003): Quote expired"
    });
  });

  it("fails closed when a nominal success omits confirmation evidence", async () => {
    const provider = new JupiterSwapProvider("key", {
      fetch: mockFetch(() => jsonResponse({
        status: "Success",
        code: 0,
        signature: "",
        inputAmountResult: "100",
        outputAmountResult: "200"
      }))
    });
    await expect(provider.execute("c2lnbmVk", "request-1")).resolves.toEqual({
      success: false,
      inputAmountAtomic: "100",
      outputAmountAtomic: "200",
      error: "Jupiter execution returned malformed confirmation evidence (signature or wallet totals missing)"
    });
  });
});
