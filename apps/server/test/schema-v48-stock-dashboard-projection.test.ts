import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  COPYLAB_SCHEMA_VERSION,
  openDatabase,
  type CopyLabDatabase
} from "../src/database.js";

describe("schema v48 stock dashboard projection indexes", () => {
  let db: CopyLabDatabase | undefined;
  let directory: string | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it("migrates v47 without rewriting evidence and covers the exact JSON projection", () => {
    directory = mkdtempSync(join(tmpdir(), "copylab-schema-v48-"));
    const databasePath = join(directory, "copylab.db");
    db = openDatabase(databasePath);
    db.prepare(`
      INSERT INTO stock_paper_lanes(
        id, label, purpose, policy_version, policy_json, initial_nav_usd,
        status, started_at, updated_at
      ) VALUES (?, 'US STOCK HIGH-RISK PAPER — RESEARCH ONLY', 'RESEARCH_ONLY', ?, '{}', 1000,
                'ACTIVE', ?, ?)
    `).run("stock-v48", "stock-paper-v48-test", "2026-09-04T09:00:00.000Z", "2026-09-04T09:00:00.000Z");
    db.prepare(`
      INSERT INTO stock_paper_observations(
        id, lane_id, symbol, decision, observed_at, policy_version, observation_json
      ) VALUES (?, ?, 'AAPL', 'REJECT', ?, ?, ?)
    `).run(
      "observation-v48",
      "stock-v48",
      "2026-09-04T09:01:00.000Z",
      "stock-paper-v48-test",
      JSON.stringify({ phase: "PREMARKET", preserved: "canonical observation evidence" })
    );
    db.prepare(`
      INSERT INTO stock_paper_observation_outcomes(
        observation_id, lane_id, symbol, horizon_minutes, status,
        due_at, labeled_at, outcome_json
      ) VALUES (?, ?, 'AAPL', 15, 'MISSING', ?, ?, ?)
    `).run(
      "observation-v48",
      "stock-v48",
      "2026-09-04T09:16:00.000Z",
      "2026-09-04T09:17:00.000Z",
      JSON.stringify({ missingReason: "PATH_GAP", preserved: "canonical outcome evidence" })
    );
    const evidenceBefore = {
      observation: db.prepare(`
        SELECT observation_json FROM stock_paper_observations WHERE id = ?
      `).get("observation-v48"),
      outcome: db.prepare(`
        SELECT outcome_json FROM stock_paper_observation_outcomes WHERE observation_id = ?
      `).get("observation-v48")
    };
    db.exec(`
      DROP INDEX stock_paper_observations_dashboard_projection;
      DROP INDEX stock_paper_outcomes_dashboard_projection;
    `);
    db.pragma("user_version = 47");
    db.close();
    db = undefined;

    const legacy = new Database(databasePath);
    expect(legacy.pragma("user_version", { simple: true })).toBe(47);
    legacy.close();

    db = openDatabase(databasePath);
    expect(COPYLAB_SCHEMA_VERSION).toBe(48);
    expect(db.pragma("user_version", { simple: true })).toBe(COPYLAB_SCHEMA_VERSION);
    expect({
      observation: db.prepare(`
        SELECT observation_json FROM stock_paper_observations WHERE id = ?
      `).get("observation-v48"),
      outcome: db.prepare(`
        SELECT outcome_json FROM stock_paper_observation_outcomes WHERE observation_id = ?
      `).get("observation-v48")
    }).toEqual(evidenceBefore);

    const projectionSql = `
      SELECT
        observation.id AS observation_id,
        observation.observed_at,
        json_extract(observation.observation_json, '$.phase') AS phase,
        outcome.horizon_minutes,
        outcome.status,
        CASE WHEN outcome.status = 'MISSING'
          THEN COALESCE(json_extract(outcome.outcome_json, '$.missingReason'), 'UNKNOWN')
        END AS missing_reason
      FROM stock_paper_observations observation
        INDEXED BY stock_paper_observations_dashboard_projection
      LEFT JOIN stock_paper_observation_outcomes outcome
        INDEXED BY stock_paper_outcomes_dashboard_projection
        ON outcome.observation_id = observation.id
      WHERE observation.lane_id = ?
      ORDER BY observation.id, outcome.horizon_minutes
    `;
    expect(db.prepare(projectionSql).all("stock-v48")).toEqual([{
      observation_id: "observation-v48",
      observed_at: "2026-09-04T09:01:00.000Z",
      phase: "PREMARKET",
      horizon_minutes: 15,
      status: "MISSING",
      missing_reason: "PATH_GAP"
    }]);
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${projectionSql}`).all("stock-v48") as Array<{
      detail: string;
    }>;
    expect(plan.some(({ detail }) =>
      detail.includes("INDEX stock_paper_observations_dashboard_projection")
    )).toBe(true);
    expect(plan.some(({ detail }) =>
      detail.includes("INDEX stock_paper_outcomes_dashboard_projection")
    )).toBe(true);
    expect(db.pragma("foreign_key_check")).toEqual([]);

    db.close();
    db = openDatabase(databasePath);
    expect(db.pragma("user_version", { simple: true })).toBe(48);
    expect(db.prepare(projectionSql).all("stock-v48")).toHaveLength(1);
  });
});
