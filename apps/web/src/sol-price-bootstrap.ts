import type { ModeState, SolPriceBootstrapStatus } from "@copylab/shared";

export const START_PYTH_BOOTSTRAP_CONFIRMATION = "START PRICE BOOTSTRAP" as const;
export const PAUSE_PYTH_BOOTSTRAP_CONFIRMATION = "PAUSE PRICE BOOTSTRAP" as const;
export const SAVE_PYTH_API_KEY_CONFIRMATION = "SAVE PYTH API KEY" as const;

export function pythBenchmarksCredentialChangeAllowed(mode: ModeState): boolean {
  return mode === "SETUP" || mode === "PAPER";
}

export function solPriceBootstrapStartAllowed(
  mode: ModeState,
  status: SolPriceBootstrapStatus
): boolean {
  return (mode === "SETUP" || mode === "PAPER")
    && (status.phase !== "COMPLETE" || status.refreshAvailable === true)
    && !status.activeInProcess
    && status.checkpointValid;
}

export function solPriceBootstrapPauseAllowed(status: SolPriceBootstrapStatus): boolean {
  return status.activeInProcess && (status.phase === "RUNNING" || status.phase === "RETRY_WAIT");
}

export function solPriceBootstrapStartLabel(status: SolPriceBootstrapStatus): string {
  if (status.phase === "IDLE") return "Start bootstrap";
  if (status.phase === "COMPLETE" && status.refreshAvailable) return "Refresh history";
  return "Resume bootstrap";
}
