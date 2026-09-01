import { describe, expect, it } from "vitest";
import { bytes, duration } from "../src/format";

describe("operational telemetry formatting", () => {
  it("keeps storage and lag labels compact without hiding unavailable evidence", () => {
    expect(bytes(4_096)).toBe("4.00 KiB");
    expect(bytes(2 * 1024 ** 3)).toBe("2.00 GiB");
    expect(bytes(Number.NaN)).toBe("Unknown");
    expect(duration(59)).toBe("59s");
    expect(duration(60 * 60 + 30)).toBe("1h");
    expect(duration(undefined)).toBe("No evidence");
  });
});
