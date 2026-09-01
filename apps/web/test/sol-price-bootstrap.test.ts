import { describe, expect, it } from "vitest";
import type { SolPriceBootstrapStatus } from "@copylab/shared";
import {
  PAUSE_PYTH_BOOTSTRAP_CONFIRMATION,
  SAVE_PYTH_API_KEY_CONFIRMATION,
  START_PYTH_BOOTSTRAP_CONFIRMATION,
  pythBenchmarksCredentialChangeAllowed,
  solPriceBootstrapPauseAllowed,
  solPriceBootstrapStartAllowed,
  solPriceBootstrapStartLabel
} from "../src/sol-price-bootstrap";

function status(overrides: Partial<SolPriceBootstrapStatus> = {}): SolPriceBootstrapStatus {
  return {
    phase: "IDLE",
    activeInProcess: false,
    authenticationConfigured: false,
    checkpointValid: true,
    feedId: "feed",
    intervalSeconds: 600,
    horizonDays: 90,
    totalPoints: 12_961,
    completedPoints: 0,
    remainingPoints: 12_961,
    insertedSnapshots: 0,
    preservedSnapshots: 0,
    progressPercent: 0,
    cursorAttempts: 0,
    ...overrides
  };
}

describe("Pyth bootstrap dashboard controls", () => {
  it("shares the server's exact confirmation phrases", () => {
    expect(START_PYTH_BOOTSTRAP_CONFIRMATION).toBe("START PRICE BOOTSTRAP");
    expect(PAUSE_PYTH_BOOTSTRAP_CONFIRMATION).toBe("PAUSE PRICE BOOTSTRAP");
    expect(SAVE_PYTH_API_KEY_CONFIRMATION).toBe("SAVE PYTH API KEY");
  });

  it("changes the encrypted Pyth credential only before live modes", () => {
    expect(pythBenchmarksCredentialChangeAllowed("SETUP")).toBe(true);
    expect(pythBenchmarksCredentialChangeAllowed("PAPER")).toBe(true);
    expect(pythBenchmarksCredentialChangeAllowed("MANUAL_LIVE")).toBe(false);
    expect(pythBenchmarksCredentialChangeAllowed("AUTO_LIVE")).toBe(false);
    expect(pythBenchmarksCredentialChangeAllowed("PAUSED")).toBe(false);
    expect(pythBenchmarksCredentialChangeAllowed("LOCKED")).toBe(false);
  });

  it("starts only from SETUP/PAPER with a valid dormant cursor", () => {
    expect(solPriceBootstrapStartAllowed("SETUP", status())).toBe(true);
    expect(solPriceBootstrapStartAllowed("PAPER", status({ phase: "PAUSED" }))).toBe(true);
    expect(solPriceBootstrapStartAllowed("MANUAL_LIVE", status())).toBe(false);
    expect(solPriceBootstrapStartAllowed("PAPER", status({ phase: "COMPLETE" }))).toBe(false);
    expect(solPriceBootstrapStartAllowed("PAPER", status({ phase: "COMPLETE", refreshAvailable: true }))).toBe(true);
    expect(solPriceBootstrapStartAllowed("PAPER", status({ checkpointValid: false }))).toBe(false);
    expect(solPriceBootstrapStartAllowed("PAPER", status({ phase: "RUNNING", activeInProcess: true }))).toBe(false);
  });

  it("offers pause only while an in-process run is active", () => {
    expect(solPriceBootstrapPauseAllowed(status({ phase: "RUNNING", activeInProcess: true }))).toBe(true);
    expect(solPriceBootstrapPauseAllowed(status({ phase: "RETRY_WAIT", activeInProcess: true }))).toBe(true);
    expect(solPriceBootstrapPauseAllowed(status({ phase: "RUNNING", activeInProcess: false }))).toBe(false);
    expect(solPriceBootstrapStartLabel(status())).toBe("Start bootstrap");
    expect(solPriceBootstrapStartLabel(status({ phase: "FAILED" }))).toBe("Resume bootstrap");
    expect(solPriceBootstrapStartLabel(status({ phase: "COMPLETE", refreshAvailable: true }))).toBe("Refresh history");
  });
});
