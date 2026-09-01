import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  adaptEnrollmentWithoutEvents,
  adaptMarketplaceBundle,
  adaptMarketplaceEnrollmentLedger,
  adaptMarketplacePreview
} from "../marketplace-adapter";
import {
  applyMarketplaceRebalance,
  COPYLAB_MARKETPLACE_EVENT,
  enrollMarketplace,
  getMarketplace,
  getMarketplaceEnrollmentDetails,
  getMarketplaceEnrollmentEvents,
  pauseMarketplaceEnrollment,
  previewMarketplaceRebalance,
  resumeMarketplaceEnrollment,
  switchMarketplacePilot,
  unenrollMarketplaceEnrollment,
  type MarketplaceBundle
} from "../marketplace-api";
import { MarketplacePanel } from "./MarketplacePanel";
import type { MarketplaceActions } from "./marketplace-types";

export interface MarketplaceWorkspaceProps {
  csrfToken: string;
  onOpenProviders: () => void;
}

export function marketplaceIdempotencyKey(action: string): string {
  const randomId = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `marketplace-web:${action}:${randomId}`;
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : "The local marketplace could not be reached.";
}

export function MarketplaceWorkspace({ csrfToken, onOpenProviders }: MarketplaceWorkspaceProps) {
  const [bundle, setBundle] = useState<MarketplaceBundle>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const requestRef = useRef<AbortController | undefined>(undefined);

  const load = useCallback(async (showLoading = true) => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    if (showLoading) setLoading(true);
    try {
      const next = await getMarketplace(controller.signal);
      if (controller.signal.aborted) return;
      setBundle(next);
      setError(undefined);
    } catch (reason) {
      if (controller.signal.aborted) return;
      setError(errorMessage(reason));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const refreshFromEvent = () => void load(false);
    window.addEventListener(COPYLAB_MARKETPLACE_EVENT, refreshFromEvent);
    return () => {
      window.removeEventListener(COPYLAB_MARKETPLACE_EVENT, refreshFromEvent);
      requestRef.current?.abort();
    };
  }, [load]);

  const view = useMemo(() => bundle
    ? adaptMarketplaceBundle(bundle)
    : { pilots: [], enrollments: [], brokers: [] }, [bundle]);

  const refreshAfterMutation = () => {
    window.setTimeout(() => void load(false), 0);
  };

  const actions = useMemo<MarketplaceActions>(() => ({
    enroll: async (pilotId, request) => {
      const enrollment = await enrollMarketplace(
        pilotId,
        request.allocation,
        marketplaceIdempotencyKey("enroll"),
        csrfToken
      );
      refreshAfterMutation();
      return adaptEnrollmentWithoutEvents(enrollment);
    },
    pause: async (enrollmentId) => {
      const enrollment = await pauseMarketplaceEnrollment(
        enrollmentId,
        marketplaceIdempotencyKey("pause"),
        csrfToken
      );
      refreshAfterMutation();
      return adaptEnrollmentWithoutEvents(enrollment);
    },
    resume: async (enrollmentId) => {
      const enrollment = await resumeMarketplaceEnrollment(
        enrollmentId,
        marketplaceIdempotencyKey("resume"),
        csrfToken
      );
      refreshAfterMutation();
      return adaptEnrollmentWithoutEvents(enrollment);
    },
    unenroll: async (enrollmentId) => {
      await unenrollMarketplaceEnrollment(
        enrollmentId,
        marketplaceIdempotencyKey("unenroll"),
        csrfToken
      );
      refreshAfterMutation();
    },
    loadEnrollmentLedger: async (enrollmentId, signal) => {
      const [detail, events] = await Promise.all([
        getMarketplaceEnrollmentDetails(enrollmentId, signal),
        getMarketplaceEnrollmentEvents(enrollmentId, 200, signal)
      ]);
      return adaptMarketplaceEnrollmentLedger(detail, events);
    },
    switchPilot: async (enrollmentId, targetPilotId) => {
      const result = await switchMarketplacePilot(
        enrollmentId,
        targetPilotId,
        marketplaceIdempotencyKey("switch"),
        csrfToken
      );
      refreshAfterMutation();
      return adaptEnrollmentWithoutEvents(result.target);
    },
    previewRebalance: async (enrollmentId, request) => {
      const preview = await previewMarketplaceRebalance(
        enrollmentId,
        request.targetAllocationUsd,
        marketplaceIdempotencyKey("rebalance-preview"),
        csrfToken
      );
      return adaptMarketplacePreview(preview);
    },
    confirmRebalance: async (_enrollmentId, previewId) => {
      const enrollment = await applyMarketplaceRebalance(
        previewId,
        marketplaceIdempotencyKey("rebalance-apply"),
        csrfToken
      );
      refreshAfterMutation();
      return adaptEnrollmentWithoutEvents(enrollment);
    },
    connectBroker: async (brokerId) => {
      if (brokerId !== "ALPACA_PAPER") {
        throw new Error("This broker has no supported CopyLab setup flow.");
      }
      onOpenProviders();
    }
  // load is intentionally included so mutation refreshes always use the current request lifecycle.
  }), [csrfToken, load, onOpenProviders]);

  return <MarketplacePanel
    pilots={view.pilots}
    enrollments={view.enrollments}
    brokers={view.brokers}
    actions={actions}
    loading={loading && bundle === undefined}
    {...(bundle === undefined && error !== undefined ? { error } : {})}
    paperOnly
    onRetry={() => void load()}
  />;
}
