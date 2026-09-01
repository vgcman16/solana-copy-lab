import type {
  ChainObserver,
  LeaderSwap,
  ProviderHealth,
  PublicKeyString,
  Unsubscribe,
  WalletHistorySummary
} from "@copylab/shared";
import type {
  StandardSolanaHealth,
  StandardSolanaObserver,
  StandardSolanaStreamHealth,
  StandardSolanaStreamStatus
} from "@copylab/providers";

export interface RuntimeStreamStatus {
  active: boolean;
  connected: boolean;
  ready: boolean;
  lastMessageAt?: string;
}

export interface RuntimeChainProvider extends ChainObserver {
  checkHealth(): Promise<ProviderHealth>;
  getStreamStatus(): RuntimeStreamStatus;
  getStreamHealth(maximumSilenceMs?: number): ProviderHealth & RuntimeStreamStatus;
}

type StandardObserverLike = Pick<
  StandardSolanaObserver,
  | "summarizeHistory"
  | "subscribe"
  | "repairGap"
  | "checkHealth"
  | "checkWebSocketHealth"
  | "getStreamStatus"
  | "getStreamHealth"
>;

function mapHealth(health: StandardSolanaHealth): ProviderHealth {
  return {
    provider: "helius",
    ok: health.ok,
    checkedAt: health.checkedAt,
    latencyMs: health.latencyMs,
    message: `Self-hosted Solana RPC: ${health.message}`,
    usage: { requests: health.usage.requests, window: "unknown" }
  };
}

function mapStreamHealth(
  health: StandardSolanaStreamHealth
): ProviderHealth & RuntimeStreamStatus {
  return {
    ...mapHealth(health),
    active: health.active,
    connected: health.connected,
    ready: health.ready,
    ...(health.lastMessageAt ? { lastMessageAt: health.lastMessageAt } : {})
  };
}

/** Maps a provider-neutral Solana node into CopyLab's logical chain-health slot. */
export class StandardSolanaRuntimeChainProvider implements RuntimeChainProvider {
  constructor(private readonly observer: StandardObserverLike) {}

  summarizeHistory(address: PublicKeyString, days: number): Promise<WalletHistorySummary> {
    return this.observer.summarizeHistory(address, days);
  }

  subscribe(
    addresses: PublicKeyString[],
    onSwap: (swap: LeaderSwap) => Promise<void>
  ): Promise<Unsubscribe> {
    return this.observer.subscribe(addresses, onSwap);
  }

  repairGap(address: PublicKeyString, since: string): Promise<LeaderSwap[]> {
    return this.observer.repairGap(address, since);
  }

  async checkHealth(): Promise<ProviderHealth> {
    return mapHealth(await this.observer.checkHealth());
  }

  async checkWebSocketHealth(timeoutMs = 5_000): Promise<ProviderHealth> {
    return mapHealth(await this.observer.checkWebSocketHealth(timeoutMs));
  }

  async checkEndpointsHealth(websocketTimeoutMs = 5_000): Promise<ProviderHealth> {
    const [http, websocket] = await Promise.all([
      this.checkHealth(),
      this.checkWebSocketHealth(websocketTimeoutMs)
    ]);
    const failed: string[] = [];
    if (!http.ok) failed.push("HTTP JSON-RPC");
    if (!websocket.ok) failed.push("confirmed WebSocket subscription");
    return {
      provider: "helius",
      ok: failed.length === 0,
      checkedAt: Date.parse(websocket.checkedAt) >= Date.parse(http.checkedAt)
        ? websocket.checkedAt
        : http.checkedAt,
      latencyMs: Math.max(http.latencyMs ?? 0, websocket.latencyMs ?? 0),
      message: failed.length === 0
        ? "Self-hosted Solana HTTP and confirmed WebSocket endpoints are healthy"
        : `Self-hosted Solana endpoint validation failed: ${failed.join(" and ")}`,
      usage: {
        requests: Math.max(http.usage?.requests ?? 0, websocket.usage?.requests ?? 0),
        window: "unknown"
      }
    };
  }

  getStreamStatus(): StandardSolanaStreamStatus {
    return this.observer.getStreamStatus();
  }

  getStreamHealth(maximumSilenceMs = 60_000): ProviderHealth & RuntimeStreamStatus {
    return mapStreamHealth(this.observer.getStreamHealth(maximumSilenceMs));
  }
}
