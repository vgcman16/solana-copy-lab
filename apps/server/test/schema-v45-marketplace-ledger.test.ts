import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { COPYLAB_SCHEMA_VERSION, openDatabase, type CopyLabDatabase } from "../src/database.js";
import { MarketplaceService } from "../src/marketplace-service.js";

describe("schema v45 marketplace evidence migration", () => {
  let db: CopyLabDatabase | undefined;
  let directory: string | undefined;

  afterEach(() => {
    db?.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it("enriches real v44 positions and fills while preserving replay identity", () => {
    directory = mkdtempSync(join(tmpdir(), "copylab-marketplace-v45-"));
    const path = join(directory, "copylab.db");
    const legacy = new Database(path);
    legacy.pragma("foreign_keys = ON");
    legacy.exec(`
      CREATE TABLE marketplace_pilots (
        id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, version INTEGER NOT NULL,
        status TEXT NOT NULL, pilot_json TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE marketplace_enrollments (
        id TEXT PRIMARY KEY, create_idempotency_key TEXT NOT NULL UNIQUE,
        pilot_id TEXT NOT NULL, mode TEXT NOT NULL CHECK (mode = 'PAPER'),
        status TEXT NOT NULL, target_allocation_usd REAL NOT NULL,
        enrollment_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        FOREIGN KEY (pilot_id) REFERENCES marketplace_pilots(id)
      );
      CREATE TABLE marketplace_enrollment_events (
        id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE,
        enrollment_id TEXT NOT NULL, pilot_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN (
          'ENROLLED', 'PAUSED', 'RESUMED', 'ALLOCATION_UPDATED',
          'REBALANCE_PREVIEWED', 'REBALANCE_APPLIED',
          'PAPER_MIRROR_OPENED', 'PAPER_MIRROR_CLOSED', 'SWITCHED', 'UNENROLLED'
        )),
        occurred_at TEXT NOT NULL, event_json TEXT NOT NULL,
        FOREIGN KEY (enrollment_id) REFERENCES marketplace_enrollments(id),
        FOREIGN KEY (pilot_id) REFERENCES marketplace_pilots(id)
      );
      CREATE INDEX marketplace_enrollment_events_recent
        ON marketplace_enrollment_events(enrollment_id, occurred_at DESC, id);
      CREATE TABLE marketplace_paper_positions (
        id TEXT PRIMARY KEY, enrollment_id TEXT NOT NULL, pilot_id TEXT NOT NULL,
        asset_id TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('OPEN', 'CLOSED')),
        position_json TEXT NOT NULL, opened_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, closed_at TEXT,
        FOREIGN KEY (enrollment_id) REFERENCES marketplace_enrollments(id),
        FOREIGN KEY (pilot_id) REFERENCES marketplace_pilots(id)
      );
      CREATE UNIQUE INDEX one_open_marketplace_paper_position_per_asset
        ON marketplace_paper_positions(enrollment_id, asset_id) WHERE status = 'OPEN';
      CREATE INDEX marketplace_paper_positions_enrollment_time
        ON marketplace_paper_positions(enrollment_id, updated_at DESC, id);
      CREATE TABLE marketplace_paper_mirror_fills (
        id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE,
        enrollment_id TEXT NOT NULL, pilot_id TEXT NOT NULL, position_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('OPEN', 'CLOSE')),
        source_reference TEXT NOT NULL, filled_at TEXT NOT NULL, fill_json TEXT NOT NULL,
        UNIQUE (enrollment_id, source_reference, action),
        FOREIGN KEY (enrollment_id) REFERENCES marketplace_enrollments(id),
        FOREIGN KEY (pilot_id) REFERENCES marketplace_pilots(id),
        FOREIGN KEY (position_id) REFERENCES marketplace_paper_positions(id)
      );
      CREATE INDEX marketplace_paper_mirror_fills_enrollment_time
        ON marketplace_paper_mirror_fills(enrollment_id, filled_at DESC, id);
    `);

    const pilotId = "pilot:strict-wallet-copy";
    const enrollmentId = "legacy-enrollment";
    const enrollment = {
      id: enrollmentId,
      pilotId,
      mode: "PAPER",
      executionModel: "INTERNAL_PAPER",
      status: "PAUSED",
      allocation: { kind: "USD", value: 100 },
      targetAllocationUsd: 100,
      account: {
        fundedCapitalUsd: 100, navUsd: 102, cashUsd: 82,
        deployedUsd: 20, realizedPnlUsd: 2, unrealizedPnlUsd: 0,
        openPositions: 1, updatedAt: "2026-07-18T12:04:00.000Z"
      },
      automaticMirroring: true,
      createdAt: "2026-07-18T12:00:00.000Z",
      updatedAt: "2026-07-18T12:04:00.000Z",
      pausedAt: "2026-07-18T12:04:00.000Z"
    };
    legacy.prepare(`
      INSERT INTO marketplace_pilots(
        id, slug, version, status, pilot_json, created_at, updated_at
      ) VALUES (?, ?, 1, 'ACTIVE', '{}', ?, ?)
    `).run(pilotId, "strict-wallet-copy", enrollment.createdAt, enrollment.updatedAt);
    legacy.prepare(`
      INSERT INTO marketplace_enrollments(
        id, create_idempotency_key, pilot_id, mode, status,
        target_allocation_usd, enrollment_json, created_at, updated_at
      ) VALUES (?, 'legacy-create', ?, 'PAPER', 'PAUSED', 100, ?, ?, ?)
    `).run(
      enrollmentId,
      pilotId,
      JSON.stringify(enrollment),
      enrollment.createdAt,
      enrollment.updatedAt
    );

    const openPosition = {
      id: "legacy-open-position", enrollmentId, pilotId, assetId: "SOL",
      status: "OPEN", quantity: 0.123456789123, entryPriceUsd: 100,
      entryNotionalUsd: 12.345679, entryCostsUsd: 0.1, costBasisUsd: 12.445679,
      lastExecutableValueUsd: 20, unrealizedPnlUsd: 7.554321,
      openedAt: "2026-07-18T12:01:00.000Z", updatedAt: "2026-07-18T12:03:00.000Z",
      realizedPnlUsd: 0
    };
    const closedPosition = {
      id: "legacy-closed-position", enrollmentId, pilotId, assetId: "BONK",
      status: "CLOSED", quantity: 1, entryPriceUsd: 1, entryNotionalUsd: 1,
      entryCostsUsd: 0, costBasisUsd: 1, lastExecutableValueUsd: 2,
      unrealizedPnlUsd: 0, openedAt: "2026-07-18T12:00:10.000Z",
      updatedAt: "2026-07-18T12:02:00.000Z", closedAt: "2026-07-18T12:02:00.000Z",
      realizedPnlUsd: 1
    };
    const insertPosition = legacy.prepare(`
      INSERT INTO marketplace_paper_positions(
        id, enrollment_id, pilot_id, asset_id, status, position_json,
        opened_at, updated_at, closed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const position of [openPosition, closedPosition]) {
      insertPosition.run(
        position.id, enrollmentId, pilotId, position.assetId, position.status,
        JSON.stringify(position), position.openedAt, position.updatedAt,
        "closedAt" in position ? position.closedAt : null
      );
    }

    const openFill = {
      id: "legacy-open-fill", idempotencyKey: "legacy-open-key",
      enrollmentId, pilotId, positionId: openPosition.id, action: "OPEN",
      assetId: "SOL", quantity: openPosition.quantity, priceUsd: 100,
      grossNotionalUsd: 12.345679, modeledCostsUsd: 0.1,
      netCashChangeUsd: -12.445679, sourceReference: "legacy-source-open",
      mode: "PAPER", executionModel: "INTERNAL_PAPER",
      filledAt: openPosition.openedAt
    };
    const closeFill = {
      id: "legacy-close-fill", idempotencyKey: "legacy-close-key",
      enrollmentId, pilotId, positionId: closedPosition.id, action: "CLOSE",
      assetId: "BONK", quantity: 1, priceUsd: 2, grossNotionalUsd: 2,
      modeledCostsUsd: 0, netCashChangeUsd: 2,
      // v44 legally allowed one OPEN and one CLOSE to share a source reference.
      // The v45 migration must preserve that evidence rather than over-tighten it.
      sourceReference: openFill.sourceReference, mode: "PAPER",
      executionModel: "INTERNAL_PAPER", filledAt: closedPosition.closedAt
    };
    const insertFill = legacy.prepare(`
      INSERT INTO marketplace_paper_mirror_fills(
        id, idempotency_key, enrollment_id, pilot_id, position_id,
        action, source_reference, filled_at, fill_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const fill of [openFill, closeFill]) {
      insertFill.run(
        fill.id, fill.idempotencyKey, enrollmentId, pilotId, fill.positionId,
        fill.action, fill.sourceReference, fill.filledAt, JSON.stringify(fill)
      );
    }
    legacy.pragma("user_version = 44");
    legacy.close();

    db = openDatabase(path);
    expect(COPYLAB_SCHEMA_VERSION).toBe(48);
    expect(db.pragma("user_version", { simple: true })).toBe(COPYLAB_SCHEMA_VERSION);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    const marketplace = new MarketplaceService(db);
    const positions = marketplace.paperPositions(enrollmentId);
    expect(positions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: openPosition.id,
        quantity: 0.123456789123,
        sourcePositionReference: `legacy:${openPosition.id}`
      }),
      expect.objectContaining({
        id: closedPosition.id,
        sourcePositionReference: `legacy:${closedPosition.id}`
      })
    ]));
    expect(marketplace.paperFills(enrollmentId)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: openFill.id,
        sourcePositionReference: `legacy:${openPosition.id}`,
        sourceOccurredAt: openFill.filledAt
      }),
      expect.objectContaining({
        id: closeFill.id,
        sourcePositionReference: `legacy:${closedPosition.id}`,
        sourceOccurredAt: closeFill.filledAt
      })
    ]));
    expect(marketplace.applyPaperFill({
      action: "OPEN",
      enrollmentId,
      assetId: openFill.assetId,
      quantity: openFill.quantity,
      priceUsd: openFill.priceUsd,
      modeledCostsUsd: openFill.modeledCostsUsd,
      sourceReference: openFill.sourceReference,
      sourcePositionReference: `legacy:${openPosition.id}`,
      sourceOccurredAt: openFill.filledAt,
      idempotencyKey: openFill.idempotencyKey,
      filledAt: openFill.filledAt
    })).toMatchObject({ id: openFill.id, sourceOccurredAt: openFill.filledAt });
  });
});
