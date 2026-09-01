import { createHash } from "node:crypto";
import type {
  ApplyMarketplaceRebalanceInput,
  ApplyMarketplacePaperFillInput,
  ApplyMarketplacePaperMarkInput,
  CreateMarketplaceEnrollmentInput,
  MarketplaceAllocation,
  MarketplaceBrokerCapability,
  MarketplaceBrokerConnectionStatus,
  MarketplaceBrokerId,
  MarketplaceCatalog,
  MarketplaceEnrollment,
  MarketplaceEnrollmentEvent,
  MarketplaceEnrollmentEventKind,
  MarketplaceEnrollmentTransitionInput,
  MarketplacePaperMirrorFill,
  MarketplacePaperPosition,
  MarketplacePaperPositionMark,
  MarketplacePilotSwitchResult,
  MarketplacePilot,
  MarketplacePilotPerformance,
  MarketplaceRebalancePreview,
  SwitchMarketplacePilotInput,
  UpdateMarketplaceAllocationInput
} from "@copylab/shared";
import type { CopyLabDatabase } from "./database.js";
import {
  BUILT_IN_MARKETPLACE_BROKERS,
  MARKETPLACE_DISCLOSURES
} from "./marketplace-catalog.js";
import {
  MarketplaceRepository,
  type AppendMarketplacePerformanceInput
} from "./marketplace-repository.js";
import { MarketplacePerformanceReadModel } from "./marketplace-performance.js";

const MAXIMUM_PAPER_ALLOCATION_USD = 100_000_000;
const REBALANCE_PREVIEW_TTL_MS = 15 * 60 * 1_000;

type BrokerStatusOverrides = Partial<Record<MarketplaceBrokerId, {
  connectionStatus: MarketplaceBrokerConnectionStatus;
  message: string;
}>>;

function stableId(namespace: string, idempotencyKey: string): string {
  const digest = createHash("sha256").update(`${namespace}\0${idempotencyKey}`).digest("hex");
  return `${namespace}:${digest.slice(0, 32)}`;
}

function requireIdempotencyKey(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 256) {
    throw new Error("Marketplace idempotencyKey must contain 1 to 256 characters.");
  }
  return normalized;
}

function normalizeTime(value?: string, label = "requestedAt"): string {
  const parsed = value === undefined ? new Date() : new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error(`Marketplace ${label} must be a valid timestamp.`);
  }
  return parsed.toISOString();
}

function requireOrderedTime(value: string, prior: string): void {
  if (Date.parse(value) < Date.parse(prior)) {
    throw new Error("Marketplace mutations cannot be backdated before the current enrollment state.");
  }
}

function roundUsd(value: number): number {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function normalizeAllocation(allocation: MarketplaceAllocation): {
  allocation: MarketplaceAllocation;
  targetAllocationUsd: number;
} {
  if (!Number.isFinite(allocation.value) || allocation.value <= 0) {
    throw new Error("Marketplace allocation must be a positive finite value.");
  }
  if (allocation.kind === "USD") {
    const targetAllocationUsd = roundUsd(allocation.value);
    if (targetAllocationUsd > MAXIMUM_PAPER_ALLOCATION_USD) {
      throw new Error("Marketplace PAPER allocation exceeds the simulation limit.");
    }
    return {
      allocation: { kind: "USD", value: targetAllocationUsd },
      targetAllocationUsd
    };
  }
  if (allocation.value > 100) {
    throw new Error("Marketplace percentage allocation cannot exceed 100%.");
  }
  if (!Number.isFinite(allocation.referenceNavUsd) || allocation.referenceNavUsd <= 0 ||
      allocation.referenceNavUsd > MAXIMUM_PAPER_ALLOCATION_USD) {
    throw new Error("Marketplace percentage allocation requires a positive reference PAPER NAV.");
  }
  const value = roundUsd(allocation.value);
  const referenceNavUsd = roundUsd(allocation.referenceNavUsd);
  const targetAllocationUsd = roundUsd(referenceNavUsd * value / 100);
  return {
    allocation: { kind: "PERCENT", value, referenceNavUsd },
    targetAllocationUsd
  };
}

function sameAllocation(left: MarketplaceAllocation, right: MarketplaceAllocation): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function requirePositiveFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive finite value.`);
  }
  return value;
}

function requireNonNegativeFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative finite value.`);
  }
  return value;
}

function requireReference(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 256) {
    throw new Error(`${label} must contain 1 to 256 characters.`);
  }
  return normalized;
}

function requireEvidenceOrder(sourceOccurredAt: string, recordedAt: string): void {
  if (Date.parse(recordedAt) < Date.parse(sourceOccurredAt)) {
    throw new Error("Marketplace source evidence cannot occur after it is recorded.");
  }
}

function quantityTolerance(left: number, right: number): number {
  return Math.max(Number.EPSILON * Math.max(Math.abs(left), Math.abs(right), 1) * 8, 1e-15);
}

function event(
  kind: MarketplaceEnrollmentEventKind,
  idempotencyKey: string,
  enrollment: MarketplaceEnrollment,
  occurredAt: string,
  details: Record<string, string | number | boolean>
): MarketplaceEnrollmentEvent {
  return {
    id: stableId(`marketplace-${kind.toLowerCase()}`, idempotencyKey),
    idempotencyKey,
    enrollmentId: enrollment.id,
    pilotId: enrollment.pilotId,
    kind,
    mode: "PAPER",
    occurredAt,
    details
  };
}

/**
 * PAPER-only application service for catalog, subscription, isolated virtual
 * allocation, and rebalance workflows. This class has no broker/order method.
 */
export class MarketplaceService {
  readonly repository: MarketplaceRepository;
  private readonly runtimePerformance: MarketplacePerformanceReadModel;

  constructor(db: CopyLabDatabase) {
    this.repository = new MarketplaceRepository(db);
    this.runtimePerformance = new MarketplacePerformanceReadModel(db);
  }

  catalog(brokerOverrides: BrokerStatusOverrides = {}): MarketplaceCatalog {
    const pilots = this.repository.listPilots().map((pilot) => {
      const latestPerformance = this.runtimePerformance.current(pilot.id);
      return latestPerformance ? { ...pilot, latestPerformance } : pilot;
    });
    const brokers: MarketplaceBrokerCapability[] = BUILT_IN_MARKETPLACE_BROKERS.map((broker) => {
      const override = brokerOverrides[broker.id];
      return {
        ...broker,
        ...(override ?? {}),
        // Fail closed even if a caller accidentally supplies a wider object.
        liveExecutionSupported: false,
        automaticOrderSubmissionEnabled: false
      };
    });
    const updatedAt = pilots
      .flatMap((pilot) => [pilot.updatedAt, pilot.latestPerformance?.capturedAt])
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1) ?? new Date().toISOString();
    return {
      paperOnly: true,
      executionModel: "INTERNAL_PAPER",
      liveOrderCapabilityEnabled: false,
      pilots,
      brokers,
      disclosures: [...MARKETPLACE_DISCLOSURES],
      updatedAt
    };
  }

  pilot(id: string): MarketplacePilot | undefined {
    const pilot = this.repository.pilot(id);
    if (!pilot) return undefined;
    const latestPerformance = this.runtimePerformance.current(id);
    return latestPerformance ? { ...pilot, latestPerformance } : pilot;
  }

  listEnrollments(includeUnenrolled = true): MarketplaceEnrollment[] {
    return this.repository.listEnrollments(includeUnenrolled);
  }

  enrollment(id: string): MarketplaceEnrollment | undefined {
    return this.repository.enrollment(id);
  }

  enroll(input: CreateMarketplaceEnrollmentInput): MarketplaceEnrollment {
    if (input.mode !== undefined && input.mode !== "PAPER") {
      throw new Error("Marketplace enrollment is PAPER-only.");
    }
    const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
    const normalized = normalizeAllocation(input.allocation);
    const priorEvent = this.repository.eventByIdempotencyKey(idempotencyKey);
    const existing = this.repository.enrollmentByCreateKey(idempotencyKey);
    if (priorEvent || existing) {
      if (!priorEvent || priorEvent.kind !== "ENROLLED" || !existing ||
          existing.pilotId !== input.pilotId ||
          !sameAllocation(existing.allocation, normalized.allocation)) {
        throw new Error("Marketplace enrollment idempotency key collided with a different request.");
      }
      return existing;
    }
    const pilot = this.repository.pilot(input.pilotId);
    if (!pilot || pilot.status !== "ACTIVE" || pilot.paperAvailable !== true ||
        pilot.automaticMirroring !== true || pilot.executionModel !== "INTERNAL_PAPER") {
      throw new Error("Marketplace pilot is unavailable.");
    }
    if (normalized.targetAllocationUsd < pilot.minimumPaperAllocationUsd) {
      throw new Error(
        `Marketplace pilot requires at least $${pilot.minimumPaperAllocationUsd.toFixed(2)} in PAPER capital.`
      );
    }
    const current = this.repository.activeEnrollmentForPilot(pilot.id);
    if (current) {
      throw new Error("Marketplace pilot already has an active or paused enrollment.");
    }
    const requestedAt = normalizeTime(input.requestedAt);
    const enrollment: MarketplaceEnrollment = {
      id: stableId("marketplace-enrollment", idempotencyKey),
      pilotId: pilot.id,
      mode: "PAPER",
      executionModel: "INTERNAL_PAPER",
      status: "ACTIVE",
      allocation: normalized.allocation,
      targetAllocationUsd: normalized.targetAllocationUsd,
      account: {
        fundedCapitalUsd: normalized.targetAllocationUsd,
        navUsd: normalized.targetAllocationUsd,
        cashUsd: normalized.targetAllocationUsd,
        deployedUsd: 0,
        realizedPnlUsd: 0,
        unrealizedPnlUsd: 0,
        openPositions: 0,
        updatedAt: requestedAt
      },
      automaticMirroring: pilot.automaticMirroring,
      createdAt: requestedAt,
      updatedAt: requestedAt
    };
    const audit = event("ENROLLED", idempotencyKey, enrollment, requestedAt, {
      targetAllocationUsd: normalized.targetAllocationUsd,
      paperOnly: true,
      automaticMirroring: enrollment.automaticMirroring
    });
    return this.repository.insertEnrollment(enrollment, idempotencyKey, audit);
  }

  pause(input: MarketplaceEnrollmentTransitionInput): MarketplaceEnrollment {
    return this.transition(input, "PAUSED", "PAUSED");
  }

  resume(input: MarketplaceEnrollmentTransitionInput): MarketplaceEnrollment {
    return this.transition(input, "RESUMED", "ACTIVE");
  }

  unenroll(input: MarketplaceEnrollmentTransitionInput): MarketplaceEnrollment {
    const replay = this.replayedTransition(input, "UNENROLLED");
    if (replay) return replay;
    const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
    const prior = this.requireEnrollment(input.enrollmentId);
    if (prior.status === "UNENROLLED") {
      throw new Error("Marketplace enrollment is already unenrolled.");
    }
    if (prior.account.openPositions > 0 || prior.account.deployedUsd > 0) {
      throw new Error("Marketplace enrollment cannot be removed while its PAPER account has open exposure.");
    }
    const requestedAt = normalizeTime(input.requestedAt);
    requireOrderedTime(requestedAt, prior.updatedAt);
    const next: MarketplaceEnrollment = {
      ...prior,
      status: "UNENROLLED",
      updatedAt: requestedAt,
      unenrolledAt: requestedAt
    };
    const audit = event("UNENROLLED", idempotencyKey, next, requestedAt, {
      fundedCapitalUsd: next.account.fundedCapitalUsd,
      finalNavUsd: next.account.navUsd,
      paperOnly: true
    });
    return this.repository.updateEnrollment(prior, next, audit);
  }

  updateAllocation(input: UpdateMarketplaceAllocationInput): MarketplaceEnrollment {
    const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
    const priorEvent = this.repository.eventByIdempotencyKey(idempotencyKey);
    if (priorEvent) {
      if (priorEvent.kind !== "ALLOCATION_UPDATED" || priorEvent.enrollmentId !== input.enrollmentId) {
        throw new Error("Marketplace allocation idempotency key collided with a different request.");
      }
      return this.requireEnrollment(input.enrollmentId);
    }
    const prior = this.requireEnrollment(input.enrollmentId);
    if (prior.status === "UNENROLLED") {
      throw new Error("Marketplace allocation cannot change after unenrollment.");
    }
    const pilot = this.requirePilot(prior.pilotId);
    const normalized = normalizeAllocation(input.allocation);
    if (normalized.targetAllocationUsd < pilot.minimumPaperAllocationUsd) {
      throw new Error(
        `Marketplace pilot requires at least $${pilot.minimumPaperAllocationUsd.toFixed(2)} in PAPER capital.`
      );
    }
    const requestedAt = normalizeTime(input.requestedAt);
    requireOrderedTime(requestedAt, prior.updatedAt);
    const next: MarketplaceEnrollment = {
      ...prior,
      allocation: normalized.allocation,
      targetAllocationUsd: normalized.targetAllocationUsd,
      updatedAt: requestedAt
    };
    const audit = event("ALLOCATION_UPDATED", idempotencyKey, next, requestedAt, {
      priorTargetAllocationUsd: prior.targetAllocationUsd,
      targetAllocationUsd: next.targetAllocationUsd,
      requiresRebalance: next.targetAllocationUsd !== next.account.fundedCapitalUsd,
      paperOnly: true
    });
    return this.repository.updateEnrollment(prior, next, audit);
  }

  previewRebalance(
    input: MarketplaceEnrollmentTransitionInput & { targetAllocationUsd?: number }
  ): MarketplaceRebalancePreview {
    const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
    const requestedTargetAllocationUsd = input.targetAllocationUsd === undefined
      ? undefined
      : normalizeAllocation({ kind: "USD", value: input.targetAllocationUsd }).targetAllocationUsd;
    const existing = this.repository.previewByCreateKey(idempotencyKey);
    const priorEvent = this.repository.eventByIdempotencyKey(idempotencyKey);
    if (existing || priorEvent) {
      if (!existing || !priorEvent || priorEvent.kind !== "REBALANCE_PREVIEWED" ||
          existing.enrollmentId !== input.enrollmentId ||
          (requestedTargetAllocationUsd !== undefined &&
            existing.targetFundedCapitalUsd !== requestedTargetAllocationUsd)) {
        throw new Error("Marketplace rebalance-preview idempotency key collided with a different request.");
      }
      return existing;
    }
    const enrollment = this.requireEnrollment(input.enrollmentId);
    const targetFundedCapitalUsd = requestedTargetAllocationUsd ?? enrollment.targetAllocationUsd;
    const pilot = this.requirePilot(enrollment.pilotId);
    if (targetFundedCapitalUsd < pilot.minimumPaperAllocationUsd) {
      throw new Error(
        `Marketplace pilot requires at least $${pilot.minimumPaperAllocationUsd.toFixed(2)} in PAPER capital.`
      );
    }
    const requestedAt = normalizeTime(input.requestedAt);
    requireOrderedTime(requestedAt, enrollment.updatedAt);
    const cashDeltaUsd = roundUsd(
      targetFundedCapitalUsd - enrollment.account.fundedCapitalUsd
    );
    const blockers: string[] = [];
    if (enrollment.status === "UNENROLLED") blockers.push("ENROLLMENT_UNENROLLED");
    if (targetFundedCapitalUsd < enrollment.account.deployedUsd) {
      blockers.push("TARGET_BELOW_DEPLOYED_PAPER_EXPOSURE");
    }
    if (roundUsd(enrollment.account.cashUsd + cashDeltaUsd) < 0) {
      blockers.push("INSUFFICIENT_PAPER_CASH_FOR_CAPITAL_REDUCTION");
    }
    const preview: MarketplaceRebalancePreview = {
      id: stableId("marketplace-rebalance", idempotencyKey),
      enrollmentId: enrollment.id,
      pilotId: enrollment.pilotId,
      mode: "PAPER",
      status: "PREVIEWED",
      currentFundedCapitalUsd: enrollment.account.fundedCapitalUsd,
      targetFundedCapitalUsd,
      cashDeltaUsd,
      deployedUsd: enrollment.account.deployedUsd,
      canApply: blockers.length === 0,
      blockers,
      createdAt: requestedAt,
      expiresAt: new Date(Date.parse(requestedAt) + REBALANCE_PREVIEW_TTL_MS).toISOString()
    };
    const audit = event("REBALANCE_PREVIEWED", idempotencyKey, enrollment, requestedAt, {
      previewId: preview.id,
      cashDeltaUsd,
      canApply: preview.canApply,
      blockerCount: blockers.length,
      paperOnly: true
    });
    return this.repository.insertPreview(preview, idempotencyKey, audit);
  }

  applyRebalance(input: ApplyMarketplaceRebalanceInput): MarketplaceRebalancePreview {
    const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
    const priorEvent = this.repository.eventByIdempotencyKey(idempotencyKey);
    if (priorEvent) {
      if (priorEvent.kind !== "REBALANCE_APPLIED" ||
          priorEvent.details.previewId !== input.previewId) {
        throw new Error("Marketplace rebalance-apply idempotency key collided with a different request.");
      }
      const replay = this.repository.preview(input.previewId);
      if (!replay) throw new Error("Marketplace rebalance preview is unavailable.");
      return replay;
    }
    const preview = this.repository.preview(input.previewId);
    if (!preview) throw new Error("Marketplace rebalance preview is unavailable.");
    if (preview.status !== "PREVIEWED") {
      throw new Error("Marketplace rebalance preview was already consumed.");
    }
    const requestedAt = normalizeTime(input.requestedAt);
    if (Date.parse(requestedAt) > Date.parse(preview.expiresAt)) {
      this.repository.expirePreview(preview, requestedAt);
      throw new Error("Marketplace rebalance preview expired.");
    }
    if (!preview.canApply) {
      throw new Error(`Marketplace rebalance is blocked: ${preview.blockers.join(", ")}.`);
    }
    const prior = this.requireEnrollment(preview.enrollmentId);
    requireOrderedTime(requestedAt, prior.updatedAt);
    if (prior.account.fundedCapitalUsd !== preview.currentFundedCapitalUsd ||
        prior.account.deployedUsd !== preview.deployedUsd) {
      throw new Error("Marketplace rebalance preview is stale; create a new preview.");
    }
    const nextCashUsd = roundUsd(prior.account.cashUsd + preview.cashDeltaUsd);
    if (nextCashUsd < 0) {
      throw new Error("Marketplace rebalance would create negative PAPER cash.");
    }
    const next: MarketplaceEnrollment = {
      ...prior,
      allocation: { kind: "USD", value: preview.targetFundedCapitalUsd },
      targetAllocationUsd: preview.targetFundedCapitalUsd,
      account: {
        ...prior.account,
        fundedCapitalUsd: preview.targetFundedCapitalUsd,
        navUsd: roundUsd(prior.account.navUsd + preview.cashDeltaUsd),
        cashUsd: nextCashUsd,
        updatedAt: requestedAt
      },
      updatedAt: requestedAt
    };
    const applied: MarketplaceRebalancePreview = {
      ...preview,
      status: "APPLIED",
      appliedAt: requestedAt
    };
    const audit = event("REBALANCE_APPLIED", idempotencyKey, next, requestedAt, {
      previewId: preview.id,
      cashDeltaUsd: preview.cashDeltaUsd,
      fundedCapitalUsd: next.account.fundedCapitalUsd,
      navUsd: next.account.navUsd,
      paperOnly: true
    });
    return this.repository.applyPreview(prior, next, preview, applied, audit);
  }

  applyPaperFill(input: ApplyMarketplacePaperFillInput): MarketplacePaperMirrorFill {
    if (input.mode !== undefined && input.mode !== "PAPER") {
      throw new Error("Marketplace mirror fills are INTERNAL_PAPER only.");
    }
    const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
    const sourceReference = requireReference(input.sourceReference, "Marketplace sourceReference");
    const assetId = requireReference(input.assetId, "Marketplace assetId");
    // Token/share quantities are evidence, not currency. Never coerce them to
    // the six-decimal USD accounting precision used below.
    const quantity = requirePositiveFinite(input.quantity, "Marketplace fill quantity");
    const priceUsd = roundUsd(requirePositiveFinite(input.priceUsd, "Marketplace fill price"));
    const modeledCostsUsd = roundUsd(requireNonNegativeFinite(
      input.modeledCostsUsd,
      "Marketplace modeled costs"
    ));
    const grossNotionalUsd = roundUsd(quantity * priceUsd);
    if (grossNotionalUsd > MAXIMUM_PAPER_ALLOCATION_USD) {
      throw new Error("Marketplace PAPER fill exceeds the simulation limit.");
    }
    const filledAt = normalizeTime(input.filledAt, "filledAt");
    const sourceOccurredAt = normalizeTime(
      input.sourceOccurredAt ?? filledAt,
      "sourceOccurredAt"
    );
    requireEvidenceOrder(sourceOccurredAt, filledAt);
    const requestedSourcePositionReference = input.sourcePositionReference === undefined
      ? undefined
      : requireReference(
        input.sourcePositionReference,
        "Marketplace sourcePositionReference"
      );
    const priorByKey = this.repository.paperFillByIdempotencyKey(idempotencyKey);
    const priorBySource = this.repository.paperFillBySource(
      input.enrollmentId,
      sourceReference,
      input.action
    );
    if (priorByKey && priorBySource && priorByKey.id !== priorBySource.id) {
      throw new Error("Marketplace PAPER fill keys collide with different durable fills.");
    }
    const replay = priorByKey ?? priorBySource;
    if (replay) {
      if (replay.enrollmentId !== input.enrollmentId || replay.action !== input.action ||
           replay.assetId !== assetId || replay.quantity !== quantity ||
           replay.priceUsd !== priceUsd || replay.modeledCostsUsd !== modeledCostsUsd ||
           replay.sourceReference !== sourceReference ||
           (input.sourceOccurredAt !== undefined &&
             replay.sourceOccurredAt !== sourceOccurredAt) ||
           (input.filledAt !== undefined && replay.filledAt !== filledAt) ||
           (requestedSourcePositionReference !== undefined &&
             replay.sourcePositionReference !== requestedSourcePositionReference) ||
           (input.action !== "OPEN" && input.positionId !== undefined &&
             replay.positionId !== input.positionId)) {
        throw new Error("Marketplace PAPER fill idempotency collided with different evidence.");
      }
      return replay;
    }
    if (this.repository.eventByIdempotencyKey(idempotencyKey) ||
        this.repository.paperMarkByIdempotencyKey(idempotencyKey)) {
      throw new Error("Marketplace PAPER fill idempotency key was already used by another action.");
    }
    const prior = this.requireEnrollment(input.enrollmentId);
    if (prior.mode !== "PAPER" || prior.executionModel !== "INTERNAL_PAPER" ||
        prior.automaticMirroring !== true || prior.status === "UNENROLLED") {
      throw new Error("Marketplace PAPER mirroring requires an enrolled internal-mirroring account.");
    }
    if (input.action === "OPEN" && prior.status !== "ACTIVE") {
      throw new Error("Marketplace PAPER opens require an active enrollment.");
    }
    requireOrderedTime(filledAt, prior.updatedAt);

    if (input.action === "OPEN") {
      const sourcePositionReference = requestedSourcePositionReference ?? sourceReference;
      if (this.repository.openPaperPosition(prior.id, assetId)) {
        throw new Error("Marketplace PAPER account already has an open position in this asset.");
      }
      if (this.repository.openPaperPositionBySource(prior.id, sourcePositionReference)) {
        throw new Error("Marketplace source position is already open in this PAPER account.");
      }
      const cashRequiredUsd = roundUsd(grossNotionalUsd + modeledCostsUsd);
      if (cashRequiredUsd > prior.account.cashUsd) {
        throw new Error("Marketplace PAPER account has insufficient isolated cash for this fill.");
      }
      const positionId = stableId("marketplace-paper-position", idempotencyKey);
      const position: MarketplacePaperPosition = {
        id: positionId,
        enrollmentId: prior.id,
        pilotId: prior.pilotId,
        assetId,
        sourcePositionReference,
        status: "OPEN",
        quantity,
        entryPriceUsd: priceUsd,
        entryNotionalUsd: grossNotionalUsd,
        entryCostsUsd: modeledCostsUsd,
        costBasisUsd: cashRequiredUsd,
        lastExecutableValueUsd: grossNotionalUsd,
        unrealizedPnlUsd: -modeledCostsUsd,
        openedAt: filledAt,
        updatedAt: filledAt,
        realizedPnlUsd: 0
      };
      const next: MarketplaceEnrollment = {
        ...prior,
        account: {
          ...prior.account,
          navUsd: roundUsd(prior.account.navUsd - modeledCostsUsd),
          cashUsd: roundUsd(prior.account.cashUsd - cashRequiredUsd),
          deployedUsd: roundUsd(prior.account.deployedUsd + grossNotionalUsd),
          unrealizedPnlUsd: roundUsd(prior.account.unrealizedPnlUsd - modeledCostsUsd),
          openPositions: prior.account.openPositions + 1,
          updatedAt: filledAt
        },
        updatedAt: filledAt
      };
      const fill: MarketplacePaperMirrorFill = {
        id: stableId("marketplace-paper-fill", idempotencyKey),
        idempotencyKey,
        enrollmentId: prior.id,
        pilotId: prior.pilotId,
        positionId,
        action: "OPEN",
        assetId,
        sourcePositionReference,
        quantity,
        priceUsd,
        grossNotionalUsd,
        modeledCostsUsd,
        netCashChangeUsd: -cashRequiredUsd,
        sourceReference,
        sourceOccurredAt,
        mode: "PAPER",
        executionModel: "INTERNAL_PAPER",
        filledAt
      };
      const audit = event("PAPER_MIRROR_OPENED", idempotencyKey, next, filledAt, {
        fillId: fill.id,
        positionId,
        assetId,
        sourcePositionReference,
        sourceOccurredAt,
        grossNotionalUsd,
        modeledCostsUsd,
        paperOnly: true
      });
      return this.repository.commitPaperOpen(prior, next, position, fill, audit);
    }

    const positionById = input.positionId === undefined
      ? undefined
      : this.repository.paperPosition(input.positionId);
    const positionBySource = requestedSourcePositionReference === undefined
      ? undefined
      : this.repository.openPaperPositionBySource(prior.id, requestedSourcePositionReference);
    if (positionById && positionBySource && positionById.id !== positionBySource.id) {
      throw new Error("Marketplace PAPER position references resolve to different lots.");
    }
    const position = positionById ?? positionBySource;
    if (!position || position.status !== "OPEN" || position.enrollmentId !== prior.id ||
        position.assetId !== assetId) {
      throw new Error("Marketplace PAPER position is unavailable for this exit fill.");
    }
    if (requestedSourcePositionReference !== undefined &&
        position.sourcePositionReference !== requestedSourcePositionReference) {
      throw new Error("Marketplace PAPER source position reference does not match the local lot.");
    }
    requireOrderedTime(filledAt, position.updatedAt);
    const tolerance = quantityTolerance(position.quantity, quantity);
    if (quantity > position.quantity + tolerance) {
      throw new Error("Marketplace PAPER exit quantity exceeds the open isolated position.");
    }
    if (input.action === "CLOSE" && Math.abs(position.quantity - quantity) > tolerance) {
      throw new Error("Marketplace PAPER close must exit the complete isolated position.");
    }
    if (input.action === "REDUCE" && quantity >= position.quantity - tolerance) {
      throw new Error("Marketplace PAPER reduce must leave a positive isolated position.");
    }
    const netProceedsUsd = roundUsd(grossNotionalUsd - modeledCostsUsd);
    if (netProceedsUsd < 0) {
      throw new Error("Marketplace PAPER close costs cannot exceed gross proceeds.");
    }
    const proportion = input.action === "CLOSE" ? 1 : quantity / position.quantity;
    const allocatedCostBasisUsd = input.action === "CLOSE"
      ? position.costBasisUsd
      : roundUsd(position.costBasisUsd * proportion);
    const allocatedEntryNotionalUsd = input.action === "CLOSE"
      ? position.entryNotionalUsd
      : roundUsd(position.entryNotionalUsd * proportion);
    const allocatedEntryCostsUsd = input.action === "CLOSE"
      ? position.entryCostsUsd
      : roundUsd(position.entryCostsUsd * proportion);
    const allocatedExecutableValueUsd = input.action === "CLOSE"
      ? position.lastExecutableValueUsd
      : roundUsd(position.lastExecutableValueUsd * proportion);
    const realizedPnlUsd = roundUsd(netProceedsUsd - allocatedCostBasisUsd);
    const remainingQuantity = input.action === "CLOSE" ? 0 : position.quantity - quantity;
    const remainingCostBasisUsd = input.action === "CLOSE"
      ? 0
      : roundUsd(position.costBasisUsd - allocatedCostBasisUsd);
    const remainingExecutableValueUsd = input.action === "CLOSE"
      ? 0
      : roundUsd(position.lastExecutableValueUsd - allocatedExecutableValueUsd);
    const remainingUnrealizedPnlUsd = input.action === "CLOSE"
      ? 0
      : roundUsd(remainingExecutableValueUsd - remainingCostBasisUsd);
    const nextPosition: MarketplacePaperPosition = {
      ...position,
      status: input.action === "CLOSE" ? "CLOSED" : "OPEN",
      quantity: remainingQuantity,
      entryNotionalUsd: input.action === "CLOSE"
        ? 0
        : roundUsd(position.entryNotionalUsd - allocatedEntryNotionalUsd),
      entryCostsUsd: input.action === "CLOSE"
        ? 0
        : roundUsd(position.entryCostsUsd - allocatedEntryCostsUsd),
      costBasisUsd: remainingCostBasisUsd,
      lastExecutableValueUsd: remainingExecutableValueUsd,
      unrealizedPnlUsd: remainingUnrealizedPnlUsd,
      updatedAt: filledAt,
      realizedPnlUsd: roundUsd((position.realizedPnlUsd ?? 0) + realizedPnlUsd)
    };
    if (input.action === "CLOSE") nextPosition.closedAt = filledAt;
    const next: MarketplaceEnrollment = {
      ...prior,
      account: {
        ...prior.account,
        navUsd: roundUsd(prior.account.navUsd - allocatedExecutableValueUsd + netProceedsUsd),
        cashUsd: roundUsd(prior.account.cashUsd + netProceedsUsd),
        deployedUsd: roundUsd(prior.account.deployedUsd - allocatedExecutableValueUsd),
        realizedPnlUsd: roundUsd(prior.account.realizedPnlUsd + realizedPnlUsd),
        unrealizedPnlUsd: roundUsd(
          prior.account.unrealizedPnlUsd - position.unrealizedPnlUsd + remainingUnrealizedPnlUsd
        ),
        openPositions: prior.account.openPositions - (input.action === "CLOSE" ? 1 : 0),
        updatedAt: filledAt
      },
      updatedAt: filledAt
    };
    const fill: MarketplacePaperMirrorFill = {
      id: stableId("marketplace-paper-fill", idempotencyKey),
      idempotencyKey,
      enrollmentId: prior.id,
      pilotId: prior.pilotId,
      positionId: position.id,
      action: input.action,
      assetId,
      sourcePositionReference: position.sourcePositionReference,
      quantity,
      priceUsd,
      grossNotionalUsd,
      modeledCostsUsd,
      netCashChangeUsd: netProceedsUsd,
      sourceReference,
      sourceOccurredAt,
      mode: "PAPER",
      executionModel: "INTERNAL_PAPER",
      filledAt
    };
    const audit = event(
      input.action === "CLOSE" ? "PAPER_MIRROR_CLOSED" : "PAPER_MIRROR_REDUCED",
      idempotencyKey,
      next,
      filledAt,
      {
      fillId: fill.id,
      positionId: position.id,
      assetId,
      sourcePositionReference: position.sourcePositionReference,
      sourceOccurredAt,
      quantity,
      realizedPnlUsd,
      modeledCostsUsd,
      paperOnly: true
      }
    );
    return this.repository.commitPaperReduction(prior, next, position, nextPosition, fill, audit);
  }

  markPaperPosition(input: ApplyMarketplacePaperMarkInput): MarketplacePaperPositionMark {
    if (input.mode !== undefined && input.mode !== "PAPER") {
      throw new Error("Marketplace position marks are INTERNAL_PAPER only.");
    }
    const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
    const sourceReference = requireReference(input.sourceReference, "Marketplace sourceReference");
    const assetId = requireReference(input.assetId, "Marketplace assetId");
    const sourcePositionReference = input.sourcePositionReference === undefined
      ? undefined
      : requireReference(input.sourcePositionReference, "Marketplace sourcePositionReference");
    const priceUsd = roundUsd(requirePositiveFinite(input.priceUsd, "Marketplace mark price"));
    const recordedAt = normalizeTime(input.recordedAt, "recordedAt");
    const sourceOccurredAt = normalizeTime(
      input.sourceOccurredAt ?? recordedAt,
      "sourceOccurredAt"
    );
    requireEvidenceOrder(sourceOccurredAt, recordedAt);

    const priorByKey = this.repository.paperMarkByIdempotencyKey(idempotencyKey);
    const priorBySource = this.repository.paperMarkBySource(input.enrollmentId, sourceReference);
    if (priorByKey && priorBySource && priorByKey.id !== priorBySource.id) {
      throw new Error("Marketplace PAPER mark keys collide with different durable marks.");
    }
    const replay = priorByKey ?? priorBySource;
    if (replay) {
      if (replay.enrollmentId !== input.enrollmentId || replay.assetId !== assetId ||
          replay.priceUsd !== priceUsd || replay.sourceReference !== sourceReference ||
          (input.sourceOccurredAt !== undefined &&
            replay.sourceOccurredAt !== sourceOccurredAt) ||
          (input.recordedAt !== undefined && replay.recordedAt !== recordedAt) ||
          (input.positionId !== undefined && replay.positionId !== input.positionId) ||
          (sourcePositionReference !== undefined &&
            replay.sourcePositionReference !== sourcePositionReference)) {
        throw new Error("Marketplace PAPER mark idempotency collided with different evidence.");
      }
      return replay;
    }
    if (this.repository.eventByIdempotencyKey(idempotencyKey) ||
        this.repository.paperFillByIdempotencyKey(idempotencyKey)) {
      throw new Error("Marketplace PAPER mark idempotency key was already used by another action.");
    }

    const prior = this.requireEnrollment(input.enrollmentId);
    if (prior.mode !== "PAPER" || prior.executionModel !== "INTERNAL_PAPER" ||
        prior.automaticMirroring !== true || prior.status === "UNENROLLED") {
      throw new Error("Marketplace PAPER marking requires an active or paused internal account.");
    }
    requireOrderedTime(recordedAt, prior.updatedAt);
    const positionById = input.positionId === undefined
      ? undefined
      : this.repository.paperPosition(input.positionId);
    const positionBySource = sourcePositionReference === undefined
      ? undefined
      : this.repository.openPaperPositionBySource(prior.id, sourcePositionReference);
    if (positionById && positionBySource && positionById.id !== positionBySource.id) {
      throw new Error("Marketplace PAPER mark references resolve to different lots.");
    }
    const position = positionById ?? positionBySource;
    if (!position || position.status !== "OPEN" || position.enrollmentId !== prior.id ||
        position.assetId !== assetId) {
      throw new Error("Marketplace PAPER position is unavailable for marking.");
    }
    if (sourcePositionReference !== undefined &&
        position.sourcePositionReference !== sourcePositionReference) {
      throw new Error("Marketplace PAPER mark source position does not match the local lot.");
    }
    requireOrderedTime(recordedAt, position.updatedAt);

    const executableValueUsd = roundUsd(position.quantity * priceUsd);
    const unrealizedPnlUsd = roundUsd(executableValueUsd - position.costBasisUsd);
    const nextPosition: MarketplacePaperPosition = {
      ...position,
      lastExecutableValueUsd: executableValueUsd,
      unrealizedPnlUsd,
      updatedAt: recordedAt
    };
    const valueDeltaUsd = roundUsd(executableValueUsd - position.lastExecutableValueUsd);
    const next: MarketplaceEnrollment = {
      ...prior,
      account: {
        ...prior.account,
        navUsd: roundUsd(prior.account.navUsd + valueDeltaUsd),
        deployedUsd: roundUsd(prior.account.deployedUsd + valueDeltaUsd),
        unrealizedPnlUsd: roundUsd(
          prior.account.unrealizedPnlUsd - position.unrealizedPnlUsd + unrealizedPnlUsd
        ),
        updatedAt: recordedAt
      },
      updatedAt: recordedAt
    };
    const mark: MarketplacePaperPositionMark = {
      id: stableId("marketplace-paper-mark", idempotencyKey),
      idempotencyKey,
      enrollmentId: prior.id,
      pilotId: prior.pilotId,
      positionId: position.id,
      assetId,
      sourcePositionReference: position.sourcePositionReference,
      priceUsd,
      previousExecutableValueUsd: position.lastExecutableValueUsd,
      executableValueUsd,
      unrealizedPnlUsd,
      sourceReference,
      sourceOccurredAt,
      recordedAt,
      mode: "PAPER",
      executionModel: "INTERNAL_PAPER"
    };
    const audit = event("PAPER_POSITION_MARKED", idempotencyKey, next, recordedAt, {
      markId: mark.id,
      positionId: position.id,
      assetId,
      sourcePositionReference: position.sourcePositionReference,
      sourceOccurredAt,
      priceUsd,
      executableValueUsd,
      unrealizedPnlUsd,
      paperOnly: true
    });
    return this.repository.commitPaperMark(prior, next, position, nextPosition, mark, audit);
  }

  paperPositions(enrollmentId: string, includeClosed = true): MarketplacePaperPosition[] {
    return this.repository.paperPositions(enrollmentId, includeClosed);
  }

  paperFills(enrollmentId: string, limit?: number): MarketplacePaperMirrorFill[] {
    return this.repository.paperFills(enrollmentId, limit);
  }

  paperMarks(enrollmentId: string, limit?: number): MarketplacePaperPositionMark[] {
    return this.repository.paperMarks(enrollmentId, limit);
  }

  paperFillSummary(enrollmentId: string): {
    mirroredOrders: number;
    lastMirroredAt?: string;
  } {
    return this.repository.paperFillSummary(enrollmentId);
  }

  switchPilot(input: SwitchMarketplacePilotInput): MarketplacePilotSwitchResult {
    const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
    const targetCreateKey = `switch:${idempotencyKey}`;
    const sourceEventKey = `${idempotencyKey}:source`;
    const targetEventKey = `${idempotencyKey}:target`;
    const replayTarget = this.repository.enrollmentByCreateKey(targetCreateKey);
    const replaySourceEvent = this.repository.eventByIdempotencyKey(sourceEventKey);
    const replayTargetEvent = this.repository.eventByIdempotencyKey(targetEventKey);
    if (replayTarget || replaySourceEvent || replayTargetEvent) {
      if (!replayTarget || replayTarget.pilotId !== input.targetPilotId ||
          !replaySourceEvent || !replayTargetEvent ||
          replaySourceEvent.kind !== "SWITCHED" || replayTargetEvent.kind !== "SWITCHED" ||
          replaySourceEvent.enrollmentId !== input.sourceEnrollmentId ||
          replayTargetEvent.enrollmentId !== replayTarget.id) {
        throw new Error("Marketplace switch idempotency key collided with a different request.");
      }
      return { source: this.requireEnrollment(input.sourceEnrollmentId), target: replayTarget };
    }
    if (this.repository.eventByIdempotencyKey(idempotencyKey) ||
        this.repository.enrollmentByCreateKey(idempotencyKey)) {
      throw new Error("Marketplace switch idempotency key was already used by another action.");
    }
    const source = this.requireEnrollment(input.sourceEnrollmentId);
    if (source.status === "UNENROLLED") {
      throw new Error("Marketplace source enrollment is already unenrolled.");
    }
    if (source.account.openPositions > 0 || source.account.deployedUsd > 0) {
      throw new Error("Marketplace switch requires zero PAPER positions and deployed exposure.");
    }
    if (Math.abs(source.account.navUsd - source.account.cashUsd) > 0.000001 ||
        Math.abs(source.account.unrealizedPnlUsd) > 0.000001) {
      throw new Error("Marketplace switch requires reconciled zero-exposure PAPER cash and NAV.");
    }
    const transferableCapitalUsd = roundUsd(Math.min(
      source.account.navUsd,
      source.account.cashUsd
    ));
    if (source.pilotId === input.targetPilotId) {
      throw new Error("Marketplace switch target must be a different pilot.");
    }
    const targetPilot = this.requirePilot(input.targetPilotId);
    if (targetPilot.status !== "ACTIVE" || targetPilot.paperAvailable !== true ||
        targetPilot.automaticMirroring !== true || targetPilot.executionModel !== "INTERNAL_PAPER") {
      throw new Error("Marketplace switch target is not available for PAPER allocation.");
    }
    if (transferableCapitalUsd < targetPilot.minimumPaperAllocationUsd) {
      throw new Error(
        `Marketplace switch target requires at least $${targetPilot.minimumPaperAllocationUsd.toFixed(2)} in PAPER capital.`
      );
    }
    if (this.repository.activeEnrollmentForPilot(targetPilot.id)) {
      throw new Error("Marketplace switch target already has an active or paused enrollment.");
    }
    const requestedAt = normalizeTime(input.requestedAt);
    requireOrderedTime(requestedAt, source.updatedAt);
    const nextSource: MarketplaceEnrollment = {
      ...source,
      status: "UNENROLLED",
      updatedAt: requestedAt,
      unenrolledAt: requestedAt
    };
    const target: MarketplaceEnrollment = {
      id: stableId("marketplace-switch-target", idempotencyKey),
      pilotId: targetPilot.id,
      mode: "PAPER",
      executionModel: "INTERNAL_PAPER",
      status: "ACTIVE",
      allocation: { kind: "USD", value: transferableCapitalUsd },
      targetAllocationUsd: transferableCapitalUsd,
      account: {
        // The source keeps its historical result. The target begins a fresh,
        // attribution-safe baseline funded by the transferred executable cash.
        fundedCapitalUsd: transferableCapitalUsd,
        navUsd: transferableCapitalUsd,
        cashUsd: transferableCapitalUsd,
        deployedUsd: 0,
        realizedPnlUsd: 0,
        unrealizedPnlUsd: 0,
        openPositions: 0,
        updatedAt: requestedAt
      },
      automaticMirroring: true,
      createdAt: requestedAt,
      updatedAt: requestedAt
    };
    const sourceAudit = event("SWITCHED", sourceEventKey, nextSource, requestedAt, {
      direction: "OUT",
      targetEnrollmentId: target.id,
      targetPilotId: target.pilotId,
      targetAllocationUsd: target.targetAllocationUsd,
      transferredFundedCapitalUsd: target.account.fundedCapitalUsd,
      transferredNavUsd: target.account.navUsd,
      transferredCashUsd: target.account.cashUsd,
      sourceRealizedPnlUsd: source.account.realizedPnlUsd,
      paperOnly: true
    });
    const targetAudit = event("SWITCHED", targetEventKey, target, requestedAt, {
      direction: "IN",
      sourceEnrollmentId: source.id,
      sourcePilotId: source.pilotId,
      targetAllocationUsd: target.targetAllocationUsd,
      transferredFundedCapitalUsd: target.account.fundedCapitalUsd,
      transferredNavUsd: target.account.navUsd,
      transferredCashUsd: target.account.cashUsd,
      sourceRealizedPnlUsd: source.account.realizedPnlUsd,
      paperOnly: true
    });
    this.repository.commitSwitch(
      source,
      nextSource,
      target,
      targetCreateKey,
      sourceAudit,
      targetAudit
    );
    return { source: nextSource, target };
  }

  appendPerformance(input: AppendMarketplacePerformanceInput): MarketplacePilotPerformance {
    return this.repository.appendPerformance(input);
  }

  refreshPerformanceEvidence(): MarketplacePilotPerformance[] {
    const snapshots: MarketplacePilotPerformance[] = [];
    for (const pilot of this.repository.listPilots()) {
      const snapshot = this.runtimePerformance.current(pilot.id);
      if (!snapshot) continue;
      const id = stableId("marketplace-performance", `${pilot.id}\0${snapshot.capturedAt}`);
      snapshots.push(this.repository.appendPerformance({ id, pilotId: pilot.id, snapshot }));
    }
    return snapshots;
  }

  performanceHistory(pilotId: string, limit?: number): MarketplacePilotPerformance[] {
    return this.repository.performanceHistory(pilotId, limit);
  }

  events(enrollmentId: string, limit?: number): MarketplaceEnrollmentEvent[] {
    return this.repository.events(enrollmentId, limit);
  }

  private transition(
    input: MarketplaceEnrollmentTransitionInput,
    kind: "PAUSED" | "RESUMED",
    nextStatus: "PAUSED" | "ACTIVE"
  ): MarketplaceEnrollment {
    const replay = this.replayedTransition(input, kind);
    if (replay) return replay;
    const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
    const prior = this.requireEnrollment(input.enrollmentId);
    const expectedStatus = kind === "PAUSED" ? "ACTIVE" : "PAUSED";
    if (prior.status !== expectedStatus) {
      throw new Error(`Marketplace enrollment must be ${expectedStatus} before it can be ${nextStatus}.`);
    }
    const requestedAt = normalizeTime(input.requestedAt);
    requireOrderedTime(requestedAt, prior.updatedAt);
    const next: MarketplaceEnrollment = {
      ...prior,
      status: nextStatus,
      updatedAt: requestedAt
    };
    if (kind === "PAUSED") {
      next.pausedAt = requestedAt;
    } else {
      delete next.pausedAt;
    }
    const audit = event(kind, idempotencyKey, next, requestedAt, {
      priorStatus: prior.status,
      status: next.status,
      paperOnly: true
    });
    return this.repository.updateEnrollment(prior, next, audit);
  }

  private replayedTransition(
    input: MarketplaceEnrollmentTransitionInput,
    kind: MarketplaceEnrollmentEventKind
  ): MarketplaceEnrollment | undefined {
    const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
    const priorEvent = this.repository.eventByIdempotencyKey(idempotencyKey);
    if (!priorEvent) return undefined;
    if (priorEvent.kind !== kind || priorEvent.enrollmentId !== input.enrollmentId) {
      throw new Error("Marketplace transition idempotency key collided with a different request.");
    }
    return this.requireEnrollment(input.enrollmentId);
  }

  private requireEnrollment(id: string): MarketplaceEnrollment {
    const enrollment = this.repository.enrollment(id);
    if (!enrollment) throw new Error("Marketplace enrollment is unavailable.");
    return enrollment;
  }

  private requirePilot(id: string): MarketplacePilot {
    const pilot = this.repository.pilot(id);
    if (!pilot) throw new Error("Marketplace pilot is unavailable.");
    return pilot;
  }
}
