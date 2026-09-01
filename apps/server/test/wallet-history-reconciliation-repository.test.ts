import { afterEach, describe, expect, it } from "vitest";
import type { CopyLabDatabase } from "../src/database.js";
import { openDatabase } from "../src/database.js";
import { Repository } from "../src/repository.js";
import { reconcileWalletHistory } from "../src/wallet-history-reconciliation.js";

describe("wallet history reconciliation persistence", () => {
  let db: CopyLabDatabase | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("persists an inspectable snapshot idempotently by comparison id", () => {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const snapshot = reconcileWalletHistory({
      wallet: "wallet-1",
      cohortId: "cohort-1",
      comparedAt: "2026-07-09T12:00:00.000Z",
      providerHistory: {
        wallet: "wallet-1",
        historyDays: 90,
        closedEligibleSwaps: 50,
        activeWeeks: 3,
        medianHoldingMinutes: 15,
        topTokenProfitShare: 0.25,
        topThreeProfitShare: 0.5,
        tags: []
      }
    });

    repository.saveWalletHistoryReconciliation(snapshot);
    repository.saveWalletHistoryReconciliation(snapshot);

    expect(repository.listWalletHistoryReconciliations("wallet-1", "cohort-1")).toEqual([snapshot]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM wallet_history_reconciliations").get())
      .toEqual({ count: 1 });
  });
});
