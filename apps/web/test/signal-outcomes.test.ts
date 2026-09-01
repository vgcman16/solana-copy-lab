import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SignalAuditRecord } from "@copylab/shared";
import {
  SignalOutcomesTable,
  safeSolscanTransactionUrl
} from "../src/components/Dashboard";

function outcome(overrides: Partial<SignalAuditRecord> = {}): SignalAuditRecord {
  return {
    id: "copy-v1-outcome",
    idempotencyKey: "copy-v1-outcome",
    sourceSignature: "1".repeat(88),
    sourceWallet: "leader-wallet",
    mint: "mint-address",
    action: "BUY",
    mode: "LIVE",
    status: "CONFIRMED",
    reasonCode: "LIVE_CONFIRMED",
    reason: "Live transaction confirmed.",
    sourceBlockTime: "2026-01-01T00:00:00.000Z",
    observedAt: "2026-01-01T00:00:01.000Z",
    updatedAt: "2026-01-01T00:00:02.000Z",
    targetSignature: "2".repeat(88),
    ...overrides
  };
}

describe("signal outcome audit table", () => {
  it("renders distinct safe leader and bot transaction links", () => {
    const html = renderToStaticMarkup(createElement(SignalOutcomesTable, { signals: [outcome()] }));
    expect(html).toContain("Leader transaction");
    expect(html).toContain("Bot transaction");
    expect(html).toContain(`https://solscan.io/tx/${"1".repeat(88)}`);
    expect(html).toContain(`https://solscan.io/tx/${"2".repeat(88)}`);
    expect(html).toContain("Live transaction confirmed.");
  });

  it("never turns a local or malformed identifier into a Solscan URL", () => {
    expect(safeSolscanTransactionUrl("local:emergency-exit")).toBeUndefined();
    expect(safeSolscanTransactionUrl("javascript:alert(1)")).toBeUndefined();
    const { targetSignature: _targetSignature, ...localOutcome } = outcome({
      sourceSignature: "local:emergency-exit"
    });
    const html = renderToStaticMarkup(createElement(SignalOutcomesTable, {
      signals: [localOutcome]
    }));
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("solscan.io/tx/local");
  });

  it("uses accurate empty-state copy", () => {
    const html = renderToStaticMarkup(createElement(SignalOutcomesTable, { signals: [] }));
    expect(html).toContain("No source signals recorded yet");
    expect(html).toContain("after a leader swap is observed");
  });
});
