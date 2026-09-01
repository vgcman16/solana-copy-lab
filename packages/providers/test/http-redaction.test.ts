import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPacedFetch,
  ProviderApiError,
  redactSensitiveText,
  requestJson
} from "../src/http.js";

describe("provider error redaction", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shares one deterministic start pace across concurrent callers", async () => {
    let nowMs = 0;
    const starts: number[] = [];
    const paced = createPacedFetch({
      requestsPerSecond: 4,
      now: () => nowMs,
      sleep: async (milliseconds) => {
        nowMs += milliseconds;
      },
      fetch: async () => {
        starts.push(nowMs);
        return new Response("{}", { status: 200 });
      }
    });

    await Promise.all([
      paced("https://example.test/one"),
      paced("https://example.test/two"),
      paced("https://example.test/three")
    ]);

    expect(starts).toEqual([0, 250, 500]);
    expect(() => createPacedFetch({ requestsPerSecond: 0 })).toThrow(/requestsPerSecond/);
  });

  it("supports a conservative shared 0.8-RPS physical-request start interval", async () => {
    let nowMs = 0;
    const starts: number[] = [];
    const paced = createPacedFetch({
      requestsPerSecond: 0.8,
      now: () => nowMs,
      sleep: async (milliseconds) => { nowMs += milliseconds; },
      fetch: async () => {
        starts.push(nowMs);
        return new Response("{}", { status: 200 });
      }
    });

    await Promise.all([
      paced("https://api.jup.ag/tokens/v2/toptraded/24h"),
      paced("https://api.jup.ag/tokens/v2/toptrending/1h"),
      paced("https://api.jup.ag/swap/v2/order")
    ]);

    expect(starts).toEqual([0, 1_250, 2_500]);
  });

  it("puts a retried GET 429 back through the same shared pacing queue", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const starts: Array<{ path: string; at: number }> = [];
    let firstMarketAttempt = true;
    const paced = createPacedFetch({
      requestsPerSecond: 0.8,
      max429Retries: 1,
      fetch: async (input) => {
        const path = new URL(input.toString()).pathname;
        starts.push({ path, at: Date.now() });
        if (path.includes("toptraded") && firstMarketAttempt) {
          firstMarketAttempt = false;
          return new Response("rate limited", {
            status: 429,
            headers: { "retry-after": "0" }
          });
        }
        return new Response("{}", { status: 200 });
      }
    });

    const completed = Promise.all([
      paced("https://api.jup.ag/tokens/v2/toptraded/24h"),
      paced("https://api.jup.ag/swap/v2/order")
    ]);
    await vi.runAllTimersAsync();
    await expect(completed).resolves.toEqual([
      expect.objectContaining({ status: 200 }),
      expect.objectContaining({ status: 200 })
    ]);

    expect(starts).toEqual([
      { path: "/tokens/v2/toptraded/24h", at: 0 },
      { path: "/swap/v2/order", at: 1_250 },
      { path: "/tokens/v2/toptraded/24h", at: 2_500 }
    ]);
  });

  it("applies Retry-After to queued peers, releases the discarded body, and meters attempts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const starts: Array<{ path: string; at: number }> = [];
    const attempts: Array<{ method: string; attempt: number }> = [];
    const cancel = vi.fn(async () => undefined);
    let firstMarketAttempt = true;
    const paced = createPacedFetch({
      requestsPerSecond: 0.8,
      max429Retries: 1,
      onRequest: (request) => attempts.push(request),
      fetch: async (input) => {
        const path = new URL(input.toString()).pathname;
        starts.push({ path, at: Date.now() });
        if (path.includes("toptraded") && firstMarketAttempt) {
          firstMarketAttempt = false;
          return {
            status: 429,
            headers: new Headers({ "retry-after": "2" }),
            body: { cancel }
          } as unknown as Response;
        }
        return new Response("{}", { status: 200 });
      }
    });

    const completed = Promise.all([
      paced("https://api.jup.ag/tokens/v2/toptraded/24h"),
      paced("https://api.jup.ag/swap/v2/order")
    ]);
    await vi.runAllTimersAsync();
    await expect(completed).resolves.toEqual([
      expect.objectContaining({ status: 200 }),
      expect.objectContaining({ status: 200 })
    ]);

    expect(starts).toEqual([
      { path: "/tokens/v2/toptraded/24h", at: 0 },
      { path: "/swap/v2/order", at: 2_000 },
      { path: "/tokens/v2/toptraded/24h", at: 3_250 }
    ]);
    expect(attempts).toEqual([
      { method: "GET", attempt: 1 },
      { method: "GET", attempt: 1 },
      { method: "GET", attempt: 2 }
    ]);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("honors valid Retry-After seconds before retrying an idempotent GET", async () => {
    let nowMs = 0;
    const starts: number[] = [];
    const sleeps: number[] = [];
    let calls = 0;
    const paced = createPacedFetch({
      requestsPerSecond: 0.8,
      max429Retries: 1,
      now: () => nowMs,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        nowMs += milliseconds;
      },
      fetch: async () => {
        starts.push(nowMs);
        calls += 1;
        return calls === 1
          ? new Response("rate limited", {
              status: 429,
              headers: { "retry-after": "2" }
            })
          : new Response("{}", { status: 200 });
      }
    });

    await expect(paced("https://api.jup.ag/swap/v2/order"))
      .resolves.toMatchObject({ status: 200 });
    expect(starts).toEqual([0, 2_000]);
    expect(sleeps).toEqual([2_000]);
  });

  it("uses bounded exponential fallback for invalid and missing Retry-After", async () => {
    let nowMs = 0;
    const starts: number[] = [];
    const sleeps: number[] = [];
    let calls = 0;
    const paced = createPacedFetch({
      requestsPerSecond: 0.8,
      max429Retries: 2,
      retryBaseMs: 2_000,
      maximumRetryDelayMs: 3_000,
      now: () => nowMs,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        nowMs += milliseconds;
      },
      fetch: async () => {
        starts.push(nowMs);
        calls += 1;
        if (calls === 1) {
          return new Response("rate limited", {
            status: 429,
            headers: { "retry-after": "not-a-delay" }
          });
        }
        if (calls === 2) return new Response("rate limited", { status: 429 });
        return new Response("{}", { status: 200 });
      }
    });

    await expect(paced("https://api.jup.ag/tokens/v2/search"))
      .resolves.toMatchObject({ status: 200 });
    expect(starts).toEqual([0, 2_000, 5_000]);
    expect(sleeps).toEqual([2_000, 3_000]);
  });

  it("keeps retries opt-in and leaves independent-bucket POST execute immediate and single-shot", async () => {
    let defaultCalls = 0;
    const defaultPaced = createPacedFetch({
      requestsPerSecond: 0.8,
      fetch: async () => {
        defaultCalls += 1;
        return new Response("rate limited", { status: 429 });
      }
    });
    await expect(defaultPaced("https://api.jup.ag/swap/v2/order"))
      .resolves.toMatchObject({ status: 429 });
    expect(defaultCalls).toBe(1);

    let nowMs = 0;
    let executeCalls = 0;
    const starts: Array<{ method: string; at: number }> = [];
    const retryingPaced = createPacedFetch({
      requestsPerSecond: 0.8,
      max429Retries: 3,
      unpacedMethods: ["POST"],
      now: () => nowMs,
      sleep: async (milliseconds) => { nowMs += milliseconds; },
      onRequest: ({ method }) => starts.push({ method, at: nowMs }),
      fetch: async (_input, init) => {
        if ((init?.method ?? "GET").toUpperCase() === "GET") {
          return new Response("{}", { status: 200 });
        }
        executeCalls += 1;
        return new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "0" }
        });
      }
    });
    await expect(retryingPaced("https://api.jup.ag/swap/v2/order"))
      .resolves.toMatchObject({ status: 200 });
    await expect(retryingPaced("https://api.jup.ag/swap/v2/execute", { method: "POST" }))
      .resolves.toMatchObject({ status: 429 });
    expect(executeCalls).toBe(1);
    expect(starts).toEqual([
      { method: "GET", at: 0 },
      { method: "POST", at: 0 }
    ]);
  });

  it("aborts during Retry-After without starting another physical request", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const controller = new AbortController();
    let calls = 0;
    const paced = createPacedFetch({
      requestsPerSecond: 0.8,
      max429Retries: 1,
      fetch: async () => {
        calls += 1;
        return new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "60" }
        });
      }
    });

    const request = paced("https://api.jup.ag/swap/v2/order", {
      signal: controller.signal
    });
    const rejected = expect(request).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    controller.abort();
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
    await vi.runAllTimersAsync();
    expect(calls).toBe(1);
  });

  it("rejects an aborted deep-queue caller without waiting for older slots", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const controller = new AbortController();
    let calls = 0;
    const paced = createPacedFetch({
      requestsPerSecond: 0.8,
      fetch: async () => {
        calls += 1;
        return new Response("{}", { status: 200 });
      }
    });

    const first = paced("https://api.jup.ag/first");
    const second = paced("https://api.jup.ag/second");
    const third = paced("https://api.jup.ag/third", { signal: controller.signal });
    await vi.advanceTimersByTimeAsync(0);
    await expect(first).resolves.toMatchObject({ status: 200 });
    expect(calls).toBe(1);

    const rejected = expect(third).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejected;
    expect(calls).toBe(1);

    await vi.runAllTimersAsync();
    await expect(second).resolves.toMatchObject({ status: 200 });
    expect(calls).toBe(2);
  });

  it("retains only an endpoint origin and removes embedded credentials, paths, and queries", () => {
    const safe = redactSensitiveText(
      "failed https://rpc-user:rpc-password@rpc.example.test/private/api-key?token=query-secret"
    );

    expect(safe).toContain("https://rpc.example.test/[redacted-endpoint]");
    for (const secret of ["rpc-user", "rpc-password", "private/api-key", "query-secret"]) {
      expect(safe).not.toContain(secret);
    }
  });

  it("removes bearer tokens even when the opaque token is shorter than 32 characters", () => {
    const safe = redactSensitiveText(
      "Authorization: Bearer secret-live-operations-token"
    );

    expect(safe).toContain("[redacted]");
    expect(safe).not.toContain("secret-live-operations-token");
  });

  it("does not leak a private endpoint when fetch exposes its input in an error", async () => {
    const endpoint = "https://rpc-user:rpc-password@rpc.example.test/private/api-key?token=query-secret";
    const caught = await requestJson(endpoint, { method: "POST" }, {
      provider: "standard-rpc",
      fetch: async (input) => {
        throw new Error(`socket failed for ${input.toString()}`);
      }
    }).catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(ProviderApiError);
    expect(String(caught)).toContain("https://rpc.example.test");
    for (const secret of ["rpc-user", "rpc-password", "private/api-key", "query-secret"]) {
      expect(String(caught)).not.toContain(secret);
    }
  });

  it("retains only a short machine-readable provider code from an HTTP error", async () => {
    const caught = await requestJson("https://api.example.test/order", undefined, {
      provider: "example",
      fetch: async () => new Response(JSON.stringify({
        error: "No routes found",
        errorCode: "NO_ROUTES_FOUND",
        secret: "must-not-be-retained"
      }), { status: 400 })
    }).catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(ProviderApiError);
    expect(caught).toMatchObject({ providerCode: "NO_ROUTES_FOUND", status: 400 });
    expect(JSON.stringify(caught)).not.toContain("must-not-be-retained");
  });
});
