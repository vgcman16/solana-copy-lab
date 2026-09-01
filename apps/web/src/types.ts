import type {
  DashboardSnapshot,
  ProviderHealth
} from "@copylab/shared";

export interface SetupStatus {
  configured: boolean;
  credentialsConfigured: boolean;
  paperConfigured: boolean;
  providers: ProviderHealth[];
  paperCapitalUsd: number | null;
  wallet: LiveWalletStatus;
}

export interface LiveWalletStatus {
  exists: boolean;
  address?: string;
  backupConfirmed: boolean;
}

export interface WalletCreationResult {
  address: string;
  filename: string;
  recovery: Record<string, unknown>;
}

export interface CredentialsInput {
  birdeyeApiKey: string;
  heliusApiKey: string;
  jupiterApiKey: string;
  pythBenchmarksApiKey?: string;
}

export interface AlpacaPaperCredentialsInput {
  apiKey: string;
  secretKey: string;
  confirmation: "CONNECT ALPACA PAPER";
}

export type DataProviderProfileRequest =
  | {
      mode: "MANAGED";
      confirmation: "USE MANAGED DATA";
    }
  | {
      mode: "SHADOW";
      solanaHttpUrl: string;
      solanaWsUrl: string;
      emergencySolanaHttpUrl: string;
      confirmation: "ENABLE SHADOW DATA";
    }
  | {
      mode: "SELF_HOSTED";
      solanaHttpUrl: string;
      solanaWsUrl: string;
      emergencySolanaHttpUrl: string;
      confirmation: "ENABLE SELF HOSTED DATA";
    };

export interface ApiEnvelope<T> {
  data?: T;
  error?: string;
  message?: string;
}

export interface ProviderParityBaselineBlocker {
  code: string;
  message: string;
}

export interface ProviderParityBaselineAcquisition {
  capability: string;
  subject: string;
  primaryAcquiredAt: string;
  shadowAcquiredAt: string;
  acquisitionSkewMs: number;
  inputDigest: string;
  resultDigest: string;
}

/** Operator-safe view returned by the frozen parity capture endpoints. */
export interface ProviderParityBaselineStatus {
  id?: string;
  status: "NOT_STARTED" | "PREPARING" | "PREPARED" | "CAPTURING" | "BLOCKED" | "ACTIVE" | "FAILED";
  requestedAt?: string;
  updatedAt?: string;
  proofEpochId?: string;
  generationId?: string;
  windowStartAt?: string;
  cutoffAt?: string;
  subjects?: Array<{
    address: string;
    role: "WINNER" | "CONTROL";
    sourceRank30d?: number;
    sourceRank90d?: number;
  }>;
  blockers: ProviderParityBaselineBlocker[];
  acquisitions: ProviderParityBaselineAcquisition[];
  activatedAt?: string;
}

export type DashboardEvent =
  | { type: "dashboard"; data: DashboardSnapshot }
  | { type: string; data?: unknown };

export type ToastTone = "success" | "danger" | "info";

export interface ToastMessage {
  id: number;
  tone: ToastTone;
  title: string;
  detail?: string;
}
