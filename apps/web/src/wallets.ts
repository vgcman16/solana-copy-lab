import type { WalletCandidate, WalletScore } from "@copylab/shared";

export type WalletRow = WalletCandidate & {
  score?: WalletScore;
  trackingLane?: "ACTIVE" | "SHADOW" | "CONTROL";
};
export type WalletLaneKey = "control" | "qualified" | "shadow" | "pending";

export interface WalletLane {
  key: WalletLaneKey;
  label: string;
  detail: string;
}

/**
 * Controls are classified first so a preserved loss-side benchmark can never
 * be presented as a promotion candidate, even if an upstream score is present.
 */
export function classifyWallet(wallet: WalletRow): WalletLane {
  if (wallet.control) {
    return {
      key: "control",
      label: "Control / loser",
      detail: "Preserved bias benchmark"
    };
  }
  if (wallet.trackingLane === "SHADOW") {
    return {
      key: "shadow",
      label: "Shadow queue",
      detail: wallet.score?.qualified ? "Signals captured; never auto-promoted" : "Not eligible for promotion"
    };
  }
  if (wallet.score?.qualified) {
    return {
      key: "qualified",
      label: "Qualified",
      detail: "Frozen active cohort"
    };
  }
  if (wallet.score) {
    return {
      key: "shadow",
      label: "Shadow only",
      detail: "Not eligible for promotion"
    };
  }
  return {
    key: "pending",
    label: "Scoring",
    detail: "Qualification pending"
  };
}
