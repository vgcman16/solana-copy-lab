import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type {
  MarketplaceCatalog,
  MarketplaceEnrollment,
  MarketplacePilotSwitchResult,
  MarketplaceRebalancePreview
} from "@copylab/shared";
import { AppService } from "../src/app-service.js";
import { buildApp } from "../src/app.js";
import type { CopyLabDatabase } from "../src/database.js";
import { openDatabase } from "../src/database.js";
import { EventBus } from "../src/events.js";
import { ModeManager } from "../src/mode.js";
import { Repository } from "../src/repository.js";
import { SecretVault } from "../src/vault.js";
import { WalletManager } from "../src/wallet.js";
import { MockRuntime } from "./helpers.js";

interface MarketplaceBundle {
  catalog: MarketplaceCatalog;
  enrollments: Array<{
    enrollment: MarketplaceEnrollment;
    mirroredOrders: number;
    lastMirroredAt?: string;
  }>;
  performanceHistory: Record<string, unknown[]>;
}

describe("loopback PAPER marketplace routes", () => {
  let db: CopyLabDatabase | undefined;
  let app: FastifyInstance | undefined;
  let service: AppService | undefined;

  afterEach(async () => {
    await app?.close();
    db?.close();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function setup(remoteReadOnlyOrigin?: string): Promise<void> {
    db = openDatabase(":memory:");
    const repository = new Repository(db);
    const vault = new SecretVault(repository);
    const wallet = new WalletManager(vault, repository);
    const modes = new ModeManager(repository, wallet);
    service = new AppService(
      repository,
      vault,
      wallet,
      modes,
      new EventBus(),
      new MockRuntime()
    );
    app = await buildApp(service, {
      ...(remoteReadOnlyOrigin ? { remoteReadOnlyOrigin } : {})
    });
  }

  async function mutationHeaders(): Promise<Record<string, string>> {
    const csrf = await app!.inject({ method: "GET", url: "/api/security/csrf" });
    const rawCookie = csrf.headers["set-cookie"];
    return {
      cookie: Array.isArray(rawCookie) ? rawCookie[0]! : rawCookie!,
      "x-csrf-token": csrf.json<{ csrfToken: string }>().csrfToken
    };
  }

  async function enroll(headers: Record<string, string>, key = "route-enroll-strict") {
    return app!.inject({
      method: "POST",
      url: "/api/marketplace/enroll",
      headers,
      payload: {
        pilotId: "pilot:strict-wallet-copy",
        allocation: { kind: "USD", value: 141 },
        idempotencyKey: key,
        mode: "PAPER"
      }
    });
  }

  it("publishes a truthful PAPER-only catalog and enrollment summaries", async () => {
    await setup();

    const response = await app!.inject({ method: "GET", url: "/api/marketplace" });

    expect(response.statusCode).toBe(200);
    const bundle = response.json<MarketplaceBundle>();
    expect(bundle.catalog).toMatchObject({
      paperOnly: true,
      executionModel: "INTERNAL_PAPER",
      liveOrderCapabilityEnabled: false
    });
    expect(bundle.catalog.pilots).toHaveLength(7);
    expect(bundle.catalog.brokers.find((broker) => broker.id === "COPYLAB_PAPER"))
      .toMatchObject({ connectionStatus: "CONNECTED", automaticOrderSubmissionEnabled: false });
    expect(bundle.catalog.brokers.find((broker) => broker.id === "ALPACA_PAPER"))
      .toMatchObject({ connectionStatus: "NOT_CONFIGURED", automaticOrderSubmissionEnabled: false });
    expect(bundle.enrollments).toEqual([]);
    expect(Object.keys(bundle.performanceHistory)).toHaveLength(7);
    expect(Object.values(bundle.performanceHistory).every((history) => history.length === 0)).toBe(true);
    expect((db!.prepare("SELECT COUNT(*) AS count FROM marketplace_performance_snapshots")
      .get() as { count: number }).count).toBe(0);

    const unknownFillRoute = await app!.inject({
      method: "POST",
      url: "/api/marketplace/paper-fill",
      payload: {}
    });
    expect(unknownFillRoute.statusCode).toBe(404);
  });

  it("returns a fail-closed cold read model when optional broker diagnostics exceed the UI budget", async () => {
    await setup();
    vi.useFakeTimers();
    vi.spyOn(service!, "alpacaPaperStatus").mockReturnValue(new Promise(() => {}));

    const pending = app!.inject({ method: "GET", url: "/api/marketplace" });
    await vi.advanceTimersByTimeAsync(1_001);
    const response = await pending;

    expect(response.statusCode).toBe(200);
    expect(response.json<MarketplaceBundle>().catalog.brokers.find(({ id }) => id === "ALPACA_PAPER"))
      .toMatchObject({
        connectionStatus: "NOT_CONFIGURED",
        automaticOrderSubmissionEnabled: false,
        liveExecutionSupported: false,
        message: expect.stringContaining("diagnostics are still refreshing")
      });
  });

  it("coalesces marketplace reads without writes and invalidates after a PAPER mutation", async () => {
    await setup();
    const catalog = vi.spyOn(service!.marketplace, "catalog");
    const enrollments = vi.spyOn(service!.marketplace, "listEnrollments");
    const history = vi.spyOn(service!.marketplace, "performanceHistory");
    const durableCounts = () => db!.prepare(`
      SELECT
        (SELECT COUNT(*) FROM marketplace_enrollments) AS enrollments,
        (SELECT COUNT(*) FROM marketplace_enrollment_events) AS events,
        (SELECT COUNT(*) FROM marketplace_performance_snapshots) AS performance,
        (SELECT COUNT(*) FROM audit_events) AS audits
    `).get();
    const before = durableCounts();

    const first = await app!.inject({ method: "GET", url: "/api/marketplace" });
    const second = await app!.inject({ method: "GET", url: "/api/marketplace" });
    expect(first.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(catalog).toHaveBeenCalledTimes(1);
    expect(enrollments).toHaveBeenCalledTimes(1);
    expect(history).toHaveBeenCalledTimes(7);
    expect(durableCounts()).toEqual(before);

    const headers = await mutationHeaders();
    expect((await enroll(headers, "cache-invalidation-enroll")).statusCode).toBe(200);
    const refreshed = await app!.inject({ method: "GET", url: "/api/marketplace" });
    expect(refreshed.json<MarketplaceBundle>().enrollments).toHaveLength(1);
    expect(catalog).toHaveBeenCalledTimes(2);
    expect(enrollments).toHaveBeenCalledTimes(2);
    expect(history).toHaveBeenCalledTimes(14);
  });

  it("keeps every marketplace mutation behind the local session and CSRF fence", async () => {
    const remoteOrigin = "http://copylab.private-tailnet.ts.net:4311";
    const remoteHost = "copylab.private-tailnet.ts.net:4311";
    await setup(remoteOrigin);

    const denied = await enroll({});
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toEqual({ error: "Invalid local session or CSRF token." });

    const remoteCatalog = await app!.inject({
      method: "GET",
      url: "/api/marketplace",
      headers: { host: remoteHost, origin: remoteOrigin }
    });
    expect(remoteCatalog.statusCode).toBe(200);

    const csrf = await app!.inject({
      method: "GET",
      url: "/api/security/csrf",
      headers: { host: remoteHost, origin: remoteOrigin }
    });
    const rawCookie = csrf.headers["set-cookie"];
    const remoteMutation = await app!.inject({
      method: "POST",
      url: "/api/marketplace/enroll",
      headers: {
        host: remoteHost,
        origin: remoteOrigin,
        cookie: Array.isArray(rawCookie) ? rawCookie[0]! : rawCookie!,
        "x-csrf-token": csrf.json<{ csrfToken: string }>().csrfToken
      },
      payload: {
        pilotId: "pilot:strict-wallet-copy",
        allocation: { kind: "USD", value: 141 },
        idempotencyKey: "remote-enroll"
      }
    });
    expect(remoteMutation.statusCode).toBe(403);
    expect(remoteMutation.json()).toEqual({ error: "Private remote dashboard access is read-only." });
  });

  it("runs enrollment and a true two-step rebalance without changing capital at preview", async () => {
    await setup();
    const headers = await mutationHeaders();
    const created = await enroll(headers);
    expect(created.statusCode).toBe(200);
    const enrollment = created.json<MarketplaceEnrollment>();
    expect(enrollment.account).toMatchObject({ fundedCapitalUsd: 141, cashUsd: 141, navUsd: 141 });

    const previewResponse = await app!.inject({
      method: "POST",
      url: `/api/marketplace/enrollments/${enrollment.id}/rebalance/preview`,
      headers,
      payload: { targetAllocationUsd: 200, idempotencyKey: "route-preview-200" }
    });
    expect(previewResponse.statusCode).toBe(200);
    const preview = previewResponse.json<MarketplaceRebalancePreview>();
    expect(preview).toMatchObject({
      currentFundedCapitalUsd: 141,
      targetFundedCapitalUsd: 200,
      cashDeltaUsd: 59,
      status: "PREVIEWED",
      canApply: true
    });

    const beforeApply = await app!.inject({
      method: "GET",
      url: `/api/marketplace/enrollments/${enrollment.id}`
    });
    expect(beforeApply.json<{ enrollment: MarketplaceEnrollment }>().enrollment).toMatchObject({
      targetAllocationUsd: 141,
      account: { fundedCapitalUsd: 141, cashUsd: 141, navUsd: 141 }
    });

    const applied = await app!.inject({
      method: "POST",
      url: `/api/marketplace/rebalances/${preview.id}/apply`,
      headers,
      payload: { idempotencyKey: "route-apply-200" }
    });
    expect(applied.statusCode).toBe(200);
    const appliedEnrollment = applied.json<MarketplaceEnrollment>();
    expect(appliedEnrollment).toMatchObject({
      targetAllocationUsd: 200,
      allocation: { kind: "USD", value: 200 },
      account: { fundedCapitalUsd: 200, cashUsd: 200, navUsd: 200 }
    });

    const opened = service!.marketplace.applyPaperFill({
      action: "OPEN",
      enrollmentId: enrollment.id,
      assetId: "TEST",
      quantity: 1,
      priceUsd: 10,
      modeledCostsUsd: 0.1,
      sourceReference: "route-source-open",
      idempotencyKey: "route-fill-open",
      filledAt: new Date(Date.parse(appliedEnrollment.updatedAt) + 1).toISOString()
    });
    service!.marketplace.applyPaperFill({
      action: "CLOSE",
      enrollmentId: enrollment.id,
      positionId: opened.positionId,
      assetId: "TEST",
      quantity: 1,
      priceUsd: 11,
      modeledCostsUsd: 0.1,
      sourceReference: "route-source-close",
      idempotencyKey: "route-fill-close",
      filledAt: new Date(Date.parse(appliedEnrollment.updatedAt) + 2).toISOString()
    });
    const bundle = (await app!.inject({ method: "GET", url: "/api/marketplace" }))
      .json<MarketplaceBundle>();
    expect(bundle.enrollments.find((item) => item.enrollment.id === enrollment.id))
      .toMatchObject({ mirroredOrders: 2 });

    const events = await app!.inject({
      method: "GET",
      url: `/api/marketplace/enrollments/${enrollment.id}/events?limit=20`
    });
    expect(events.statusCode).toBe(200);
    expect(events.json<{ events: Array<{ kind: string }> }>().events.map((event) => event.kind))
      .toEqual([
        "PAPER_MIRROR_CLOSED",
        "PAPER_MIRROR_OPENED",
        "REBALANCE_APPLIED",
        "REBALANCE_PREVIEWED",
        "ENROLLED"
      ]);
  });

  it("pauses, resumes, switches atomically, and avoids duplicate route audits on replay", async () => {
    await setup();
    const headers = await mutationHeaders();
    const enrollment = (await enroll(headers, "lifecycle-enroll")).json<MarketplaceEnrollment>();

    const pause = () => app!.inject({
      method: "POST",
      url: `/api/marketplace/enrollments/${enrollment.id}/pause`,
      headers,
      payload: { idempotencyKey: "lifecycle-pause" }
    });
    const firstPause = await pause();
    const replayPause = await pause();
    expect(firstPause.statusCode).toBe(200);
    expect(replayPause.json()).toEqual(firstPause.json());
    expect(service!.repository.listAudit(100)
      .filter((event) => event.eventType === "marketplace_paused")).toHaveLength(1);

    const resumed = await app!.inject({
      method: "POST",
      url: `/api/marketplace/enrollments/${enrollment.id}/resume`,
      headers,
      payload: { idempotencyKey: "lifecycle-resume" }
    });
    expect(resumed.json<MarketplaceEnrollment>().status).toBe("ACTIVE");

    const switched = await app!.inject({
      method: "POST",
      url: `/api/marketplace/enrollments/${enrollment.id}/switch`,
      headers,
      payload: {
        targetPilotId: "pilot:stock-momentum",
        idempotencyKey: "lifecycle-switch"
      }
    });
    expect(switched.statusCode).toBe(200);
    expect(switched.json<MarketplacePilotSwitchResult>()).toMatchObject({
      source: { id: enrollment.id, status: "UNENROLLED" },
      target: {
        pilotId: "pilot:stock-momentum",
        status: "ACTIVE",
        targetAllocationUsd: 141
      }
    });
    expect(service!.events.recent().some((event) =>
      event.type === "marketplace" &&
      (event.data as { action?: string }).action === "SWITCHED"
    )).toBe(true);
  });

  it("rejects malformed, live, and research-only enrollment requests", async () => {
    await setup();
    const headers = await mutationHeaders();
    for (const payload of [
      {
        pilotId: "pilot:strict-wallet-copy",
        allocation: { kind: "USD", value: 141 },
        idempotencyKey: "live-mode",
        mode: "LIVE"
      },
      {
        pilotId: "pilot:strict-wallet-copy",
        allocation: { kind: "USD", value: 141 },
        idempotencyKey: "extra-field",
        unexpected: true
      },
      {
        pilotId: "pilot:strict-wallet-copy",
        allocation: { kind: "USD", value: -1 },
        idempotencyKey: "negative-allocation"
      }
    ]) {
      const response = await app!.inject({
        method: "POST",
        url: "/api/marketplace/enroll",
        headers,
        payload
      });
      expect(response.statusCode).toBe(400);
    }

    const researchOnly = await app!.inject({
      method: "POST",
      url: "/api/marketplace/enroll",
      headers,
      payload: {
        pilotId: "pilot:hedge-fund-13f-tracker",
        allocation: { kind: "USD", value: 500 },
        idempotencyKey: "research-only"
      }
    });
    expect(researchOnly.statusCode).toBe(400);
    expect(researchOnly.json<{ error: string }>().error).toMatch(/unavailable/u);

    const unknownPerformance = await app!.inject({
      method: "GET",
      url: "/api/marketplace/pilots/pilot:does-not-exist/performance"
    });
    expect(unknownPerformance.statusCode).toBe(404);
  });
});
