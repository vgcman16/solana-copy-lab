import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  COPYLAB_SCHEMA_VERSION,
  openDatabase,
  STOCK_V41_EVIDENCE_ACTIVATION_SETTING_KEY,
  type CopyLabDatabase
} from "../src/database.js";
import { StockPaperRepository } from "../src/stock-paper-repository.js";

describe("schema v41 stock PAPER order-event ledger", () => {
  let db: CopyLabDatabase | undefined;
  let directory: string | undefined;

  afterEach(() => {
    db?.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it("migrates a v40 database to the append-only execution-evidence table", () => {
    directory = mkdtempSync(join(tmpdir(), "copylab-schema-v41-"));
    const databasePath = join(directory, "copylab.db");
    const legacy = new Database(databasePath);
    legacy.pragma("user_version = 40");
    legacy.close();

    db = openDatabase(databasePath);
    expect(db.pragma("user_version", { simple: true })).toBe(COPYLAB_SCHEMA_VERSION);
    expect(COPYLAB_SCHEMA_VERSION).toBe(47);
    expect((db.pragma("table_info(stock_paper_order_events)") as Array<{ name: string }>)
      .map((column) => column.name)).toEqual([
      "id",
      "idempotency_key",
      "lane_id",
      "order_id",
      "event_sequence",
      "symbol",
      "side",
      "event_type",
      "prior_status",
      "new_status",
      "decision_at",
      "evidence_bar_at",
      "evidence_observed_at",
      "quote_timestamp",
      "phase",
      "feed",
      "created_at",
      "event_json"
    ]);
    const uniqueIndexes = (db.pragma("index_list(stock_paper_order_events)") as Array<{
      name: string;
      unique: number;
    }>).filter((index) => index.unique === 1);
    expect(uniqueIndexes.some((index) =>
      (db!.pragma(`index_info(${JSON.stringify(index.name)})`) as Array<{ name: string }>)
        .map((column) => column.name)
        .join(",") === "idempotency_key"
    )).toBe(true);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    const marker = db.prepare("SELECT value_json FROM settings WHERE key = ?")
      .get(STOCK_V41_EVIDENCE_ACTIVATION_SETTING_KEY) as { value_json: string };
    const activatedAt = (JSON.parse(marker.value_json) as { activatedAt: string }).activatedAt;
    expect(Number.isFinite(Date.parse(activatedAt))).toBe(true);
    expect(new StockPaperRepository(db).v41EvidenceActivationAt()).toBe(
      new Date(activatedAt).toISOString()
    );
  });

  it("creates a durable v41 activation boundary even when every order event is missing", () => {
    directory = mkdtempSync(join(tmpdir(), "copylab-schema-v42-marker-"));
    const databasePath = join(directory, "copylab.db");
    const legacy = new Database(databasePath);
    legacy.pragma("user_version = 41");
    legacy.close();

    const migrationStartedAt = Date.now() - 1_000;
    db = openDatabase(databasePath);
    const repository = new StockPaperRepository(db);
    const activatedAt = repository.v41EvidenceActivationAt();

    expect(activatedAt).toBeDefined();
    expect(Date.parse(activatedAt!)).toBeGreaterThanOrEqual(migrationStartedAt);
    expect(db.prepare("SELECT COUNT(*) AS count FROM stock_paper_order_events").get())
      .toEqual({ count: 0 });
    expect(repository.v41EvidenceActivationAt()).toBe(activatedAt);
  });
});
