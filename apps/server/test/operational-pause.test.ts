import { describe, expect, it } from "vitest";
import {
  inactiveOperationalPause,
  legacyOperationalPause,
  resolveOperationalPause
} from "../src/operational-pause.js";

const NOW = new Date("2026-07-10T05:00:00.000Z");

describe("operational pause state", () => {
  it("automatically releases a transient outage only after the condition clears", () => {
    const paused = resolveOperationalPause(inactiveOperationalPause(NOW), ["HELIUS_OUTAGE"], NOW);
    expect(paused).toMatchObject({
      active: true,
      reasons: ["HELIUS_OUTAGE"],
      recovery: "WHEN_CONDITIONS_CLEAR"
    });
    const recovered = resolveOperationalPause(paused, [], new Date("2026-07-10T05:05:00.000Z"));
    expect(recovered).toMatchObject({ active: false, reasons: [], recovery: "NONE" });
    expect(recovered.recoveredAt).toBe("2026-07-10T05:05:00.000Z");
  });

  it("holds a daily-loss pause until the next UTC day", () => {
    const paused = resolveOperationalPause(inactiveOperationalPause(NOW), ["DAILY_LOSS"], NOW);
    expect(paused.recovery).toBe("NEXT_UTC_DAY");
    expect(resolveOperationalPause(paused, [], new Date("2026-07-10T23:59:59.000Z")).active).toBe(true);
    expect(resolveOperationalPause(paused, [], new Date("2026-07-11T00:00:00.000Z")).active).toBe(false);
  });

  it("requires a clean explicit recheck to release a balance-mismatch hold", () => {
    const paused = resolveOperationalPause(inactiveOperationalPause(NOW), ["BALANCE_MISMATCH"], NOW);
    expect(paused.recovery).toBe("MANUAL_REVIEW");
    expect(resolveOperationalPause(paused, [], new Date("2026-07-10T05:05:00.000Z")).active).toBe(true);
    expect(resolveOperationalPause(
      paused,
      [],
      new Date("2026-07-10T05:05:00.000Z"),
      true
    ).active).toBe(false);
    expect(resolveOperationalPause(
      paused,
      ["BALANCE_MISMATCH"],
      new Date("2026-07-10T05:05:00.000Z"),
      true
    ).active).toBe(true);
  });

  it("keeps an unexplained legacy pause fail-closed until a manual recheck", () => {
    const legacy = legacyOperationalPause(NOW);
    expect(resolveOperationalPause(legacy, [], new Date("2026-07-11T00:00:00.000Z")).active).toBe(true);
    expect(resolveOperationalPause(
      legacy,
      [],
      new Date("2026-07-11T00:00:00.000Z"),
      true
    ).active).toBe(false);
  });
});
