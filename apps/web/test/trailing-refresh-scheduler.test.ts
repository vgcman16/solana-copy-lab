import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTrailingRefreshScheduler,
  DEFAULT_REFRESH_INTERVAL_MS,
  MAX_REFRESH_INTERVAL_MS,
  MIN_REFRESH_INTERVAL_MS
} from "../src/trailing-refresh-scheduler";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("trailing refresh scheduler", () => {
  it("enforces a bounded refresh cadence", () => {
    const options = {
      refresh: async () => "snapshot",
      onSuccess: () => undefined
    };

    expect(() => createTrailingRefreshScheduler({
      ...options,
      intervalMs: MIN_REFRESH_INTERVAL_MS - 1
    })).toThrow(RangeError);
    expect(() => createTrailingRefreshScheduler({
      ...options,
      intervalMs: MAX_REFRESH_INTERVAL_MS + 1
    })).toThrow(RangeError);
  });

  it("coalesces a burst into one delayed refresh", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn(async () => "snapshot");
    const onSuccess = vi.fn();
    const scheduler = createTrailingRefreshScheduler({ refresh, onSuccess });

    scheduler.request();
    scheduler.request();
    scheduler.request();

    await vi.advanceTimersByTimeAsync(DEFAULT_REFRESH_INTERVAL_MS - 1);
    expect(refresh).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledOnce();
    expect(onSuccess).toHaveBeenCalledWith("snapshot");
  });

  it("allows no concurrent refresh and runs one trailing refresh", async () => {
    vi.useFakeTimers();
    const first = deferred<string>();
    const refresh = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce("second");
    const onSuccess = vi.fn();
    const scheduler = createTrailingRefreshScheduler({ refresh, onSuccess });

    scheduler.request();
    await vi.advanceTimersByTimeAsync(DEFAULT_REFRESH_INTERVAL_MS);
    expect(refresh).toHaveBeenCalledOnce();

    scheduler.request();
    scheduler.request();
    await vi.advanceTimersByTimeAsync(DEFAULT_REFRESH_INTERVAL_MS * 2);
    expect(refresh).toHaveBeenCalledOnce();

    first.resolve("first");
    await Promise.resolve();
    expect(onSuccess).toHaveBeenCalledWith("first");

    await vi.advanceTimersByTimeAsync(DEFAULT_REFRESH_INTERVAL_MS - 1);
    expect(refresh).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(onSuccess).toHaveBeenLastCalledWith("second");
  });

  it("clears scheduled work and aborts or ignores active work on disposal", async () => {
    vi.useFakeTimers();
    const active = deferred<string>();
    let activeSignal: AbortSignal | undefined;
    const refresh = vi.fn((signal: AbortSignal) => {
      activeSignal = signal;
      return active.promise;
    });
    const onSuccess = vi.fn();
    const onError = vi.fn();
    const scheduler = createTrailingRefreshScheduler({ refresh, onSuccess, onError });

    scheduler.request();
    await vi.advanceTimersByTimeAsync(DEFAULT_REFRESH_INTERVAL_MS);
    expect(activeSignal?.aborted).toBe(false);

    scheduler.dispose();
    expect(activeSignal?.aborted).toBe(true);
    active.resolve("late snapshot");
    await Promise.resolve();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();

    scheduler.request();
    await vi.advanceTimersByTimeAsync(DEFAULT_REFRESH_INTERVAL_MS);
    expect(refresh).toHaveBeenCalledOnce();
  });
});
