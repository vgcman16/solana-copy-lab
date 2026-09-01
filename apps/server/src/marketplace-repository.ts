import type {
  MarketplaceEnrollment,
  MarketplaceEnrollmentEvent,
  MarketplacePaperMirrorFill,
  MarketplacePaperPosition,
  MarketplacePaperPositionMark,
  MarketplacePilot,
  MarketplacePilotPerformance,
  MarketplaceRebalancePreview
} from "@copylab/shared";
import type { CopyLabDatabase } from "./database.js";
import { BUILT_IN_MARKETPLACE_PILOTS } from "./marketplace-catalog.js";

interface JsonRow {
  value_json: string;
}

interface PilotRow {
  pilot_json: string;
}

interface PerformanceRow {
  id: string;
  pilot_id: string;
  snapshot_json: string;
}

interface EnrollmentRow {
  enrollment_json: string;
}

interface EventRow {
  event_json: string;
}

interface PreviewRow {
  preview_json: string;
}

interface PositionRow {
  position_json: string;
  source_position_reference: string;
}

interface FillRow {
  fill_json: string;
  source_position_reference: string;
  source_occurred_at: string;
  filled_at: string;
}

interface MarkRow {
  mark_json: string;
  source_position_reference: string;
  source_occurred_at: string;
  recorded_at: string;
}

interface FillSummaryRow {
  mirrored_orders: number;
  last_mirrored_at: string | null;
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function parsePosition(row: PositionRow): MarketplacePaperPosition {
  const parsed = parseJson<MarketplacePaperPosition>(row.position_json);
  return parsed.sourcePositionReference
    ? parsed
    : { ...parsed, sourcePositionReference: row.source_position_reference };
}

function parseFill(row: FillRow): MarketplacePaperMirrorFill {
  const parsed = parseJson<MarketplacePaperMirrorFill>(row.fill_json);
  return {
    ...parsed,
    sourcePositionReference:
      parsed.sourcePositionReference ?? row.source_position_reference,
    sourceOccurredAt: parsed.sourceOccurredAt ?? row.source_occurred_at,
    filledAt: parsed.filledAt ?? row.filled_at
  };
}

function parseMark(row: MarkRow): MarketplacePaperPositionMark {
  const parsed = parseJson<MarketplacePaperPositionMark>(row.mark_json);
  return {
    ...parsed,
    sourcePositionReference:
      parsed.sourcePositionReference ?? row.source_position_reference,
    sourceOccurredAt: parsed.sourceOccurredAt ?? row.source_occurred_at,
    recordedAt: parsed.recordedAt ?? row.recorded_at
  };
}

export interface AppendMarketplacePerformanceInput {
  id: string;
  pilotId: string;
  snapshot: MarketplacePilotPerformance;
}

/**
 * Persistence primitives for the strategy marketplace. All domain mutations
 * are committed with an append-only event in the same SQLite transaction.
 */
export class MarketplaceRepository {
  constructor(private readonly db: CopyLabDatabase) {
    this.seedBuiltInPilots();
  }

  private seedBuiltInPilots(): void {
    const upsert = this.db.prepare(`
      INSERT INTO marketplace_pilots(
        id, slug, version, status, pilot_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        slug = excluded.slug,
        version = excluded.version,
        status = excluded.status,
        pilot_json = excluded.pilot_json,
        updated_at = excluded.updated_at
      WHERE marketplace_pilots.version <= excluded.version
    `);
    this.db.transaction(() => {
      for (const pilot of BUILT_IN_MARKETPLACE_PILOTS) {
        upsert.run(
          pilot.id,
          pilot.slug,
          pilot.version,
          pilot.status,
          JSON.stringify(pilot),
          pilot.createdAt,
          pilot.updatedAt
        );
      }
    })();
  }

  listPilots(): MarketplacePilot[] {
    const rows = this.db.prepare(`
      SELECT pilot_json
      FROM marketplace_pilots
      ORDER BY
        CASE status WHEN 'ACTIVE' THEN 0 WHEN 'RESEARCH_ONLY' THEN 1 ELSE 2 END,
        id
    `).all() as PilotRow[];
    return rows.map((row) => {
      const pilot = parseJson<MarketplacePilot>(row.pilot_json);
      const latestPerformance = this.latestPerformance(pilot.id);
      return latestPerformance ? { ...pilot, latestPerformance } : pilot;
    });
  }

  pilot(id: string): MarketplacePilot | undefined {
    const row = this.db.prepare(`
      SELECT pilot_json FROM marketplace_pilots WHERE id = ?
    `).get(id) as PilotRow | undefined;
    if (!row) return undefined;
    const pilot = parseJson<MarketplacePilot>(row.pilot_json);
    const latestPerformance = this.latestPerformance(id);
    return latestPerformance ? { ...pilot, latestPerformance } : pilot;
  }

  appendPerformance(input: AppendMarketplacePerformanceInput): MarketplacePilotPerformance {
    if (!this.pilot(input.pilotId)) {
      throw new Error(`Marketplace pilot ${input.pilotId} does not exist.`);
    }
    const snapshotJson = JSON.stringify(input.snapshot);
    const existing = this.db.prepare(`
      SELECT id, pilot_id, snapshot_json
      FROM marketplace_performance_snapshots
      WHERE id = ? OR (pilot_id = ? AND captured_at = ?)
      LIMIT 1
    `).get(input.id, input.pilotId, input.snapshot.capturedAt) as PerformanceRow | undefined;
    if (existing) {
      if (existing.id !== input.id || existing.pilot_id !== input.pilotId ||
          existing.snapshot_json !== snapshotJson) {
        throw new Error("A marketplace performance snapshot key collided with different evidence.");
      }
      return parseJson<MarketplacePilotPerformance>(existing.snapshot_json);
    }
    this.db.prepare(`
      INSERT INTO marketplace_performance_snapshots(
        id, pilot_id, captured_at, snapshot_json
      ) VALUES (?, ?, ?, ?)
    `).run(input.id, input.pilotId, input.snapshot.capturedAt, snapshotJson);
    return input.snapshot;
  }

  latestPerformance(pilotId: string): MarketplacePilotPerformance | undefined {
    const row = this.db.prepare(`
      SELECT snapshot_json AS value_json
      FROM marketplace_performance_snapshots
      WHERE pilot_id = ?
      ORDER BY captured_at DESC, id DESC
      LIMIT 1
    `).get(pilotId) as JsonRow | undefined;
    return row ? parseJson<MarketplacePilotPerformance>(row.value_json) : undefined;
  }

  performanceHistory(pilotId: string, limit = 200): MarketplacePilotPerformance[] {
    const boundedLimit = Math.max(1, Math.min(2_000, Math.floor(limit)));
    return (this.db.prepare(`
      SELECT snapshot_json AS value_json
      FROM marketplace_performance_snapshots
      WHERE pilot_id = ?
      ORDER BY captured_at DESC, id DESC
      LIMIT ?
    `).all(pilotId, boundedLimit) as JsonRow[])
      .map((row) => parseJson<MarketplacePilotPerformance>(row.value_json));
  }

  enrollment(id: string): MarketplaceEnrollment | undefined {
    const row = this.db.prepare(`
      SELECT enrollment_json FROM marketplace_enrollments WHERE id = ?
    `).get(id) as EnrollmentRow | undefined;
    return row ? parseJson<MarketplaceEnrollment>(row.enrollment_json) : undefined;
  }

  enrollmentByCreateKey(idempotencyKey: string): MarketplaceEnrollment | undefined {
    const row = this.db.prepare(`
      SELECT enrollment_json
      FROM marketplace_enrollments
      WHERE create_idempotency_key = ?
    `).get(idempotencyKey) as EnrollmentRow | undefined;
    return row ? parseJson<MarketplaceEnrollment>(row.enrollment_json) : undefined;
  }

  activeEnrollmentForPilot(pilotId: string): MarketplaceEnrollment | undefined {
    const row = this.db.prepare(`
      SELECT enrollment_json
      FROM marketplace_enrollments
      WHERE pilot_id = ? AND status IN ('ACTIVE', 'PAUSED')
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).get(pilotId) as EnrollmentRow | undefined;
    return row ? parseJson<MarketplaceEnrollment>(row.enrollment_json) : undefined;
  }

  listEnrollments(includeUnenrolled = true): MarketplaceEnrollment[] {
    const clause = includeUnenrolled ? "" : "WHERE status <> 'UNENROLLED'";
    return (this.db.prepare(`
      SELECT enrollment_json
      FROM marketplace_enrollments
      ${clause}
      ORDER BY created_at DESC, id DESC
    `).all() as EnrollmentRow[])
      .map((row) => parseJson<MarketplaceEnrollment>(row.enrollment_json));
  }

  eventByIdempotencyKey(idempotencyKey: string): MarketplaceEnrollmentEvent | undefined {
    const row = this.db.prepare(`
      SELECT event_json
      FROM marketplace_enrollment_events
      WHERE idempotency_key = ?
    `).get(idempotencyKey) as EventRow | undefined;
    return row ? parseJson<MarketplaceEnrollmentEvent>(row.event_json) : undefined;
  }

  events(enrollmentId: string, limit = 200): MarketplaceEnrollmentEvent[] {
    const boundedLimit = Math.max(1, Math.min(2_000, Math.floor(limit)));
    return (this.db.prepare(`
      SELECT event_json
      FROM marketplace_enrollment_events
      WHERE enrollment_id = ?
      ORDER BY occurred_at DESC, id DESC
      LIMIT ?
    `).all(enrollmentId, boundedLimit) as EventRow[])
      .map((row) => parseJson<MarketplaceEnrollmentEvent>(row.event_json));
  }

  insertEnrollment(
    enrollment: MarketplaceEnrollment,
    createIdempotencyKey: string,
    event: MarketplaceEnrollmentEvent
  ): MarketplaceEnrollment {
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO marketplace_enrollments(
          id, create_idempotency_key, pilot_id, mode, status,
          target_allocation_usd, enrollment_json, created_at, updated_at
        ) VALUES (?, ?, ?, 'PAPER', ?, ?, ?, ?, ?)
      `).run(
        enrollment.id,
        createIdempotencyKey,
        enrollment.pilotId,
        enrollment.status,
        enrollment.targetAllocationUsd,
        JSON.stringify(enrollment),
        enrollment.createdAt,
        enrollment.updatedAt
      );
      this.insertEvent(event);
    })();
    return enrollment;
  }

  updateEnrollment(
    previous: MarketplaceEnrollment,
    next: MarketplaceEnrollment,
    event: MarketplaceEnrollmentEvent
  ): MarketplaceEnrollment {
    this.db.transaction(() => {
      const result = this.db.prepare(`
        UPDATE marketplace_enrollments
        SET status = ?, target_allocation_usd = ?, enrollment_json = ?, updated_at = ?
        WHERE id = ? AND updated_at = ?
      `).run(
        next.status,
        next.targetAllocationUsd,
        JSON.stringify(next),
        next.updatedAt,
        next.id,
        previous.updatedAt
      );
      if (result.changes !== 1) {
        throw new Error("Marketplace enrollment changed while the mutation was being committed.");
      }
      this.insertEvent(event);
    })();
    return next;
  }

  preview(id: string): MarketplaceRebalancePreview | undefined {
    const row = this.db.prepare(`
      SELECT preview_json FROM marketplace_rebalance_previews WHERE id = ?
    `).get(id) as PreviewRow | undefined;
    return row ? parseJson<MarketplaceRebalancePreview>(row.preview_json) : undefined;
  }

  previewByCreateKey(idempotencyKey: string): MarketplaceRebalancePreview | undefined {
    const row = this.db.prepare(`
      SELECT preview_json
      FROM marketplace_rebalance_previews
      WHERE create_idempotency_key = ?
    `).get(idempotencyKey) as PreviewRow | undefined;
    return row ? parseJson<MarketplaceRebalancePreview>(row.preview_json) : undefined;
  }

  insertPreview(
    preview: MarketplaceRebalancePreview,
    createIdempotencyKey: string,
    event: MarketplaceEnrollmentEvent
  ): MarketplaceRebalancePreview {
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO marketplace_rebalance_previews(
          id, create_idempotency_key, enrollment_id, pilot_id, mode,
          status, expires_at, preview_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'PAPER', ?, ?, ?, ?, ?)
      `).run(
        preview.id,
        createIdempotencyKey,
        preview.enrollmentId,
        preview.pilotId,
        preview.status,
        preview.expiresAt,
        JSON.stringify(preview),
        preview.createdAt,
        preview.createdAt
      );
      this.insertEvent(event);
    })();
    return preview;
  }

  expirePreview(preview: MarketplaceRebalancePreview, expiredAt: string): void {
    if (preview.status !== "PREVIEWED") return;
    const expired: MarketplaceRebalancePreview = { ...preview, status: "EXPIRED" };
    this.db.prepare(`
      UPDATE marketplace_rebalance_previews
      SET status = 'EXPIRED', preview_json = ?, updated_at = ?
      WHERE id = ? AND status = 'PREVIEWED'
    `).run(JSON.stringify(expired), expiredAt, preview.id);
  }

  applyPreview(
    previousEnrollment: MarketplaceEnrollment,
    nextEnrollment: MarketplaceEnrollment,
    previousPreview: MarketplaceRebalancePreview,
    nextPreview: MarketplaceRebalancePreview,
    event: MarketplaceEnrollmentEvent
  ): MarketplaceRebalancePreview {
    this.db.transaction(() => {
      const enrollmentResult = this.db.prepare(`
        UPDATE marketplace_enrollments
        SET status = ?, target_allocation_usd = ?, enrollment_json = ?, updated_at = ?
        WHERE id = ? AND updated_at = ?
      `).run(
        nextEnrollment.status,
        nextEnrollment.targetAllocationUsd,
        JSON.stringify(nextEnrollment),
        nextEnrollment.updatedAt,
        nextEnrollment.id,
        previousEnrollment.updatedAt
      );
      if (enrollmentResult.changes !== 1) {
        throw new Error("Marketplace enrollment changed before its rebalance was applied.");
      }
      const previewResult = this.db.prepare(`
        UPDATE marketplace_rebalance_previews
        SET status = 'APPLIED', preview_json = ?, updated_at = ?
        WHERE id = ? AND status = 'PREVIEWED' AND preview_json = ?
      `).run(
        JSON.stringify(nextPreview),
        nextEnrollment.updatedAt,
        previousPreview.id,
        JSON.stringify(previousPreview)
      );
      if (previewResult.changes !== 1) {
        throw new Error("Marketplace rebalance preview was already consumed or changed.");
      }
      this.insertEvent(event);
    })();
    return nextPreview;
  }

  paperPosition(id: string): MarketplacePaperPosition | undefined {
    const row = this.db.prepare(`
      SELECT position_json, source_position_reference
      FROM marketplace_paper_positions WHERE id = ?
    `).get(id) as PositionRow | undefined;
    return row ? parsePosition(row) : undefined;
  }

  openPaperPosition(enrollmentId: string, assetId: string): MarketplacePaperPosition | undefined {
    const row = this.db.prepare(`
      SELECT position_json, source_position_reference
      FROM marketplace_paper_positions
      WHERE enrollment_id = ? AND asset_id = ? AND status = 'OPEN'
      LIMIT 1
    `).get(enrollmentId, assetId) as PositionRow | undefined;
    return row ? parsePosition(row) : undefined;
  }

  openPaperPositionBySource(
    enrollmentId: string,
    sourcePositionReference: string
  ): MarketplacePaperPosition | undefined {
    const row = this.db.prepare(`
      SELECT position_json, source_position_reference
      FROM marketplace_paper_positions
      WHERE enrollment_id = ? AND source_position_reference = ? AND status = 'OPEN'
      LIMIT 1
    `).get(enrollmentId, sourcePositionReference) as PositionRow | undefined;
    return row ? parsePosition(row) : undefined;
  }

  paperPositions(enrollmentId: string, includeClosed = true): MarketplacePaperPosition[] {
    const statusClause = includeClosed ? "" : "AND status = 'OPEN'";
    return (this.db.prepare(`
      SELECT position_json, source_position_reference
      FROM marketplace_paper_positions
      WHERE enrollment_id = ? ${statusClause}
      ORDER BY opened_at DESC, id DESC
    `).all(enrollmentId) as PositionRow[])
      .map(parsePosition);
  }

  paperFillByIdempotencyKey(idempotencyKey: string): MarketplacePaperMirrorFill | undefined {
    const row = this.db.prepare(`
      SELECT fill_json, source_position_reference, source_occurred_at, filled_at
      FROM marketplace_paper_mirror_fills
      WHERE idempotency_key = ?
    `).get(idempotencyKey) as FillRow | undefined;
    return row ? parseFill(row) : undefined;
  }

  paperFillBySource(
    enrollmentId: string,
    sourceReference: string,
    action?: "OPEN" | "REDUCE" | "CLOSE"
  ): MarketplacePaperMirrorFill | undefined {
    const actionClause = action === undefined ? "" : "AND action = ?";
    const statement = this.db.prepare(`
      SELECT fill_json, source_position_reference, source_occurred_at, filled_at
      FROM marketplace_paper_mirror_fills
      WHERE enrollment_id = ? AND source_reference = ? ${actionClause}
      LIMIT 1
    `);
    const row = (action === undefined
      ? statement.get(enrollmentId, sourceReference)
      : statement.get(enrollmentId, sourceReference, action)) as FillRow | undefined;
    return row ? parseFill(row) : undefined;
  }

  paperFills(enrollmentId: string, limit = 500): MarketplacePaperMirrorFill[] {
    const boundedLimit = Math.max(1, Math.min(5_000, Math.floor(limit)));
    return (this.db.prepare(`
      SELECT fill_json, source_position_reference, source_occurred_at, filled_at
      FROM marketplace_paper_mirror_fills
      WHERE enrollment_id = ?
      ORDER BY filled_at DESC, id DESC
      LIMIT ?
    `).all(enrollmentId, boundedLimit) as FillRow[])
      .map(parseFill);
  }

  paperMarkByIdempotencyKey(idempotencyKey: string): MarketplacePaperPositionMark | undefined {
    const row = this.db.prepare(`
      SELECT mark_json, source_position_reference, source_occurred_at, recorded_at
      FROM marketplace_paper_position_marks
      WHERE idempotency_key = ?
    `).get(idempotencyKey) as MarkRow | undefined;
    return row ? parseMark(row) : undefined;
  }

  paperMarkBySource(
    enrollmentId: string,
    sourceReference: string
  ): MarketplacePaperPositionMark | undefined {
    const row = this.db.prepare(`
      SELECT mark_json, source_position_reference, source_occurred_at, recorded_at
      FROM marketplace_paper_position_marks
      WHERE enrollment_id = ? AND source_reference = ?
    `).get(enrollmentId, sourceReference) as MarkRow | undefined;
    return row ? parseMark(row) : undefined;
  }

  paperMarks(enrollmentId: string, limit = 500): MarketplacePaperPositionMark[] {
    const boundedLimit = Math.max(1, Math.min(5_000, Math.floor(limit)));
    return (this.db.prepare(`
      SELECT mark_json, source_position_reference, source_occurred_at, recorded_at
      FROM marketplace_paper_position_marks
      WHERE enrollment_id = ?
      ORDER BY recorded_at DESC, id DESC
      LIMIT ?
    `).all(enrollmentId, boundedLimit) as MarkRow[]).map(parseMark);
  }

  paperFillSummary(enrollmentId: string): {
    mirroredOrders: number;
    lastMirroredAt?: string;
  } {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS mirrored_orders, MAX(filled_at) AS last_mirrored_at
      FROM marketplace_paper_mirror_fills
      WHERE enrollment_id = ?
    `).get(enrollmentId) as FillSummaryRow;
    return {
      mirroredOrders: row.mirrored_orders,
      ...(row.last_mirrored_at ? { lastMirroredAt: row.last_mirrored_at } : {})
    };
  }

  commitPaperOpen(
    previousEnrollment: MarketplaceEnrollment,
    nextEnrollment: MarketplaceEnrollment,
    position: MarketplacePaperPosition,
    fill: MarketplacePaperMirrorFill,
    audit: MarketplaceEnrollmentEvent
  ): MarketplacePaperMirrorFill {
    this.db.transaction(() => {
      this.updateEnrollmentRow(previousEnrollment, nextEnrollment);
      this.db.prepare(`
        INSERT INTO marketplace_paper_positions(
          id, enrollment_id, pilot_id, asset_id, source_position_reference,
          status, position_json,
          opened_at, updated_at, closed_at
        ) VALUES (?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, NULL)
      `).run(
        position.id,
        position.enrollmentId,
        position.pilotId,
        position.assetId,
        position.sourcePositionReference,
        JSON.stringify(position),
        position.openedAt,
        position.updatedAt
      );
      this.insertPaperFill(fill);
      this.insertEvent(audit);
    })();
    return fill;
  }

  commitPaperReduction(
    previousEnrollment: MarketplaceEnrollment,
    nextEnrollment: MarketplaceEnrollment,
    previousPosition: MarketplacePaperPosition,
    nextPosition: MarketplacePaperPosition,
    fill: MarketplacePaperMirrorFill,
    audit: MarketplaceEnrollmentEvent
  ): MarketplacePaperMirrorFill {
    this.db.transaction(() => {
      this.updateEnrollmentRow(previousEnrollment, nextEnrollment);
      const result = this.db.prepare(`
        UPDATE marketplace_paper_positions
        SET status = ?, position_json = ?, updated_at = ?, closed_at = ?
        WHERE id = ? AND status = 'OPEN' AND position_json = ?
      `).run(
        nextPosition.status,
        JSON.stringify(nextPosition),
        nextPosition.updatedAt,
        nextPosition.closedAt ?? null,
        nextPosition.id,
        JSON.stringify(previousPosition)
      );
      if (result.changes !== 1) {
        throw new Error("Marketplace PAPER position was already reduced, closed, or changed.");
      }
      this.insertPaperFill(fill);
      this.insertEvent(audit);
    })();
    return fill;
  }

  commitPaperMark(
    previousEnrollment: MarketplaceEnrollment,
    nextEnrollment: MarketplaceEnrollment,
    previousPosition: MarketplacePaperPosition,
    nextPosition: MarketplacePaperPosition,
    mark: MarketplacePaperPositionMark,
    audit: MarketplaceEnrollmentEvent
  ): MarketplacePaperPositionMark {
    this.db.transaction(() => {
      this.updateEnrollmentRow(previousEnrollment, nextEnrollment);
      const positionResult = this.db.prepare(`
        UPDATE marketplace_paper_positions
        SET position_json = ?, updated_at = ?
        WHERE id = ? AND status = 'OPEN' AND position_json = ?
      `).run(
        JSON.stringify(nextPosition),
        nextPosition.updatedAt,
        nextPosition.id,
        JSON.stringify(previousPosition)
      );
      if (positionResult.changes !== 1) {
        throw new Error("Marketplace PAPER position changed while its mark was being committed.");
      }
      this.insertPaperMark(mark);
      this.insertEvent(audit);
    })();
    return mark;
  }

  commitSwitch(
    previousSource: MarketplaceEnrollment,
    nextSource: MarketplaceEnrollment,
    target: MarketplaceEnrollment,
    targetCreateIdempotencyKey: string,
    sourceAudit: MarketplaceEnrollmentEvent,
    targetAudit: MarketplaceEnrollmentEvent
  ): void {
    this.db.transaction(() => {
      this.updateEnrollmentRow(previousSource, nextSource);
      this.db.prepare(`
        INSERT INTO marketplace_enrollments(
          id, create_idempotency_key, pilot_id, mode, status,
          target_allocation_usd, enrollment_json, created_at, updated_at
        ) VALUES (?, ?, ?, 'PAPER', ?, ?, ?, ?, ?)
      `).run(
        target.id,
        targetCreateIdempotencyKey,
        target.pilotId,
        target.status,
        target.targetAllocationUsd,
        JSON.stringify(target),
        target.createdAt,
        target.updatedAt
      );
      this.insertEvent(sourceAudit);
      this.insertEvent(targetAudit);
    })();
  }

  private updateEnrollmentRow(
    previous: MarketplaceEnrollment,
    next: MarketplaceEnrollment
  ): void {
    const result = this.db.prepare(`
      UPDATE marketplace_enrollments
      SET status = ?, target_allocation_usd = ?, enrollment_json = ?, updated_at = ?
      WHERE id = ? AND updated_at = ?
    `).run(
      next.status,
      next.targetAllocationUsd,
      JSON.stringify(next),
      next.updatedAt,
      next.id,
      previous.updatedAt
    );
    if (result.changes !== 1) {
      throw new Error("Marketplace enrollment changed while PAPER evidence was being committed.");
    }
  }

  private insertPaperFill(fill: MarketplacePaperMirrorFill): void {
    this.db.prepare(`
      INSERT INTO marketplace_paper_mirror_fills(
        id, idempotency_key, enrollment_id, pilot_id, position_id,
        action, source_position_reference, source_reference,
        source_occurred_at, filled_at, fill_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      fill.id,
      fill.idempotencyKey,
      fill.enrollmentId,
      fill.pilotId,
      fill.positionId,
      fill.action,
      fill.sourcePositionReference,
      fill.sourceReference,
      fill.sourceOccurredAt,
      fill.filledAt,
      JSON.stringify(fill)
    );
  }

  private insertPaperMark(mark: MarketplacePaperPositionMark): void {
    this.db.prepare(`
      INSERT INTO marketplace_paper_position_marks(
        id, idempotency_key, enrollment_id, pilot_id, position_id,
        source_position_reference, source_reference, source_occurred_at,
        recorded_at, mark_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      mark.id,
      mark.idempotencyKey,
      mark.enrollmentId,
      mark.pilotId,
      mark.positionId,
      mark.sourcePositionReference,
      mark.sourceReference,
      mark.sourceOccurredAt,
      mark.recordedAt,
      JSON.stringify(mark)
    );
  }

  private insertEvent(event: MarketplaceEnrollmentEvent): void {
    const eventJson = JSON.stringify(event);
    const existing = this.db.prepare(`
      SELECT event_json FROM marketplace_enrollment_events
      WHERE id = ? OR idempotency_key = ?
      LIMIT 1
    `).get(event.id, event.idempotencyKey) as EventRow | undefined;
    if (existing) {
      const prior = parseJson<MarketplaceEnrollmentEvent>(existing.event_json);
      if (!sameJson(prior, event)) {
        throw new Error("A marketplace audit idempotency key collided with a different event.");
      }
      return;
    }
    this.db.prepare(`
      INSERT INTO marketplace_enrollment_events(
        id, idempotency_key, enrollment_id, pilot_id, kind, occurred_at, event_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id,
      event.idempotencyKey,
      event.enrollmentId,
      event.pilotId,
      event.kind,
      event.occurredAt,
      eventJson
    );
  }
}
