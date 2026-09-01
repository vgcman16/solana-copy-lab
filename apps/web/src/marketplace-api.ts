import type {
  MarketplaceAllocation,
  MarketplaceCatalog,
  MarketplaceEnrollment,
  MarketplaceEnrollmentEvent,
  MarketplacePaperMirrorFill,
  MarketplacePaperPosition,
  MarketplacePilotPerformance,
  MarketplacePilotSwitchResult,
  MarketplaceRebalancePreview
} from "@copylab/shared";
import { apiRequest } from "./api";

export const COPYLAB_MARKETPLACE_EVENT = "copylab:marketplace";

export interface MarketplaceEnrollmentSummary {
  enrollment: MarketplaceEnrollment;
  mirroredOrders: number;
  lastMirroredAt?: string;
}

export interface MarketplaceBundle {
  catalog: MarketplaceCatalog;
  enrollments: MarketplaceEnrollmentSummary[];
  performanceHistory: Record<string, MarketplacePilotPerformance[]>;
}

export interface MarketplaceEnrollmentDetailResponse extends MarketplaceEnrollmentSummary {
  positions: MarketplacePaperPosition[];
  fills: MarketplacePaperMirrorFill[];
}

export interface MarketplaceEnrollmentEventsResponse {
  enrollmentId: string;
  events: MarketplaceEnrollmentEvent[];
}

export function getMarketplace(signal?: AbortSignal): Promise<MarketplaceBundle> {
  return apiRequest<MarketplaceBundle>(
    "/marketplace",
    signal === undefined ? {} : { signal }
  );
}

export function enrollMarketplace(
  pilotId: string,
  allocation: MarketplaceAllocation,
  idempotencyKey: string,
  csrfToken: string
): Promise<MarketplaceEnrollment> {
  return apiRequest<MarketplaceEnrollment>("/marketplace/enroll", {
    method: "POST",
    body: {
      pilotId,
      allocation,
      idempotencyKey
    },
    csrfToken
  });
}

export function getMarketplaceEnrollmentDetails(
  enrollmentId: string,
  signal?: AbortSignal
): Promise<MarketplaceEnrollmentDetailResponse> {
  return apiRequest<MarketplaceEnrollmentDetailResponse>(
    `/marketplace/enrollments/${encodeURIComponent(enrollmentId)}`,
    signal === undefined ? {} : { signal }
  );
}

export function getMarketplaceEnrollmentEvents(
  enrollmentId: string,
  limit = 200,
  signal?: AbortSignal
): Promise<MarketplaceEnrollmentEventsResponse> {
  const path = `/marketplace/enrollments/${encodeURIComponent(enrollmentId)}/events?limit=${encodeURIComponent(String(limit))}`;
  return apiRequest<MarketplaceEnrollmentEventsResponse>(
    path,
    signal === undefined ? {} : { signal }
  );
}

export function pauseMarketplaceEnrollment(
  enrollmentId: string,
  idempotencyKey: string,
  csrfToken: string
): Promise<MarketplaceEnrollment> {
  return apiRequest<MarketplaceEnrollment>(
    `/marketplace/enrollments/${encodeURIComponent(enrollmentId)}/pause`,
    { method: "POST", body: { idempotencyKey }, csrfToken }
  );
}

export function resumeMarketplaceEnrollment(
  enrollmentId: string,
  idempotencyKey: string,
  csrfToken: string
): Promise<MarketplaceEnrollment> {
  return apiRequest<MarketplaceEnrollment>(
    `/marketplace/enrollments/${encodeURIComponent(enrollmentId)}/resume`,
    { method: "POST", body: { idempotencyKey }, csrfToken }
  );
}

export function unenrollMarketplaceEnrollment(
  enrollmentId: string,
  idempotencyKey: string,
  csrfToken: string
): Promise<MarketplaceEnrollment> {
  return apiRequest<MarketplaceEnrollment>(
    `/marketplace/enrollments/${encodeURIComponent(enrollmentId)}/unenroll`,
    { method: "POST", body: { idempotencyKey }, csrfToken }
  );
}

export function previewMarketplaceRebalance(
  enrollmentId: string,
  targetAllocationUsd: number,
  idempotencyKey: string,
  csrfToken: string
): Promise<MarketplaceRebalancePreview> {
  return apiRequest<MarketplaceRebalancePreview>(
    `/marketplace/enrollments/${encodeURIComponent(enrollmentId)}/rebalance/preview`,
    {
      method: "POST",
      body: { targetAllocationUsd, idempotencyKey },
      csrfToken
    }
  );
}

export function applyMarketplaceRebalance(
  previewId: string,
  idempotencyKey: string,
  csrfToken: string
): Promise<MarketplaceEnrollment> {
  return apiRequest<MarketplaceEnrollment>(
    `/marketplace/rebalances/${encodeURIComponent(previewId)}/apply`,
    { method: "POST", body: { idempotencyKey }, csrfToken }
  );
}

export function switchMarketplacePilot(
  enrollmentId: string,
  targetPilotId: string,
  idempotencyKey: string,
  csrfToken: string
): Promise<MarketplacePilotSwitchResult> {
  return apiRequest<MarketplacePilotSwitchResult>(
    `/marketplace/enrollments/${encodeURIComponent(enrollmentId)}/switch`,
    {
      method: "POST",
      body: { targetPilotId, idempotencyKey },
      csrfToken
    }
  );
}
