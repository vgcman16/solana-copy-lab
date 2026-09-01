import { describe, expect, it } from "vitest";
import { EventBus } from "../src/events.js";

describe("EventBus history", () => {
  it("keeps a bounded newest-first snapshot for the live operations rail", () => {
    const bus = new EventBus();
    for (let index = 0; index < 205; index += 1) {
      bus.publish("wallet-index", { index });
    }

    const recent = bus.recent(3);
    expect(recent).toHaveLength(3);
    expect(recent.map((event) => event.data)).toEqual([
      { index: 204 },
      { index: 203 },
      { index: 202 }
    ]);
    expect(bus.recent(500)).toHaveLength(200);
  });
});
