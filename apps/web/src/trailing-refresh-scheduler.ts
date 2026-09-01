export const MIN_REFRESH_INTERVAL_MS = 2_000;
export const MAX_REFRESH_INTERVAL_MS = 5_000;
export const DEFAULT_REFRESH_INTERVAL_MS = 3_000;

export interface TrailingRefreshSchedulerOptions<T> {
  refresh: (signal: AbortSignal) => Promise<T>;
  onSuccess: (value: T) => void;
  onError?: (error: unknown) => void;
  intervalMs?: number;
}

export interface TrailingRefreshScheduler {
  request(): void;
  dispose(): void;
}

/**
 * Coalesces bursty refresh signals into one delayed request. Only one refresh
 * may run at a time; signals received while it runs become one trailing run.
 */
export function createTrailingRefreshScheduler<T>(
  options: TrailingRefreshSchedulerOptions<T>
): TrailingRefreshScheduler {
  const intervalMs = options.intervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
  if (
    !Number.isFinite(intervalMs) ||
    !Number.isInteger(intervalMs) ||
    intervalMs < MIN_REFRESH_INTERVAL_MS ||
    intervalMs > MAX_REFRESH_INTERVAL_MS
  ) {
    throw new RangeError(
      `Refresh interval must be an integer from ${MIN_REFRESH_INTERVAL_MS} to ${MAX_REFRESH_INTERVAL_MS} milliseconds.`
    );
  }

  let disposed = false;
  let requested = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let activeController: AbortController | undefined;

  const schedule = (): void => {
    if (disposed || running || timer !== undefined || !requested) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (disposed || running || !requested) return;

      requested = false;
      running = true;
      const controller = new AbortController();
      activeController = controller;

      void (async () => {
        try {
          const value = await options.refresh(controller.signal);
          if (!disposed && !controller.signal.aborted) options.onSuccess(value);
        } catch (error) {
          if (!disposed && !controller.signal.aborted) options.onError?.(error);
        } finally {
          if (activeController === controller) activeController = undefined;
          running = false;
          if (!disposed && requested) schedule();
        }
      })();
    }, intervalMs);
  };

  return {
    request() {
      if (disposed) return;
      requested = true;
      schedule();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      requested = false;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      activeController?.abort();
      activeController = undefined;
    }
  };
}
