import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { AppService } from "./app-service.js";
import type { SecurityContext } from "./security.js";
import { requireMutationSecurity } from "./security.js";

const resourceIdSchema = z.string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9:_-]+$/, "Marketplace resource identifiers contain unsupported characters.");

const idempotencyKeySchema = z.string()
  .trim()
  .min(1)
  .max(220)
  .regex(/^[^\u0000-\u001f\u007f]+$/, "Marketplace idempotency keys cannot contain control characters.");

const usdAllocationSchema = z.object({
  kind: z.literal("USD"),
  value: z.number().finite().positive().max(100_000_000)
}).strict();

const percentAllocationSchema = z.object({
  kind: z.literal("PERCENT"),
  value: z.number().finite().positive().max(100),
  referenceNavUsd: z.number().finite().positive().max(100_000_000)
}).strict();

const allocationSchema = z.discriminatedUnion("kind", [
  usdAllocationSchema,
  percentAllocationSchema
]);

const enrollmentBodySchema = z.object({
  pilotId: resourceIdSchema,
  allocation: allocationSchema,
  idempotencyKey: idempotencyKeySchema,
  mode: z.literal("PAPER").optional()
}).strict();

const transitionBodySchema = z.object({
  idempotencyKey: idempotencyKeySchema
}).strict();

const rebalancePreviewBodySchema = z.object({
  targetAllocationUsd: z.number().finite().positive().max(100_000_000),
  idempotencyKey: idempotencyKeySchema
}).strict();

const switchBodySchema = z.object({
  targetPilotId: resourceIdSchema,
  idempotencyKey: idempotencyKeySchema
}).strict();

const idParamsSchema = z.object({ id: resourceIdSchema }).strict();
const pilotParamsSchema = z.object({ pilotId: resourceIdSchema }).strict();
const previewParamsSchema = z.object({ previewId: resourceIdSchema }).strict();
const boundedHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(2_000).default(200)
}).strict();

// This route is a UI read model only. Source-ledger timestamps remain in the
// payload so its age is explicit, and runtime-only writes are visible within
// this bounded window. Marketplace mutations invalidate it immediately.
const MARKETPLACE_READ_MODEL_CACHE_TTL_MS = 15_000;
// Alpaca health performs two provider calls. A slow/offline provider must not
// hold the local PAPER marketplace page behind both network timeouts.
const MARKETPLACE_BROKER_UI_WAIT_MS = 1_000;

function mutationAllowed(
  request: Parameters<typeof requireMutationSecurity>[0],
  reply: Parameters<typeof requireMutationSecurity>[1],
  security: SecurityContext
): boolean {
  return requireMutationSecurity(request, reply, security);
}

function notFound(reply: FastifyReply, message: string) {
  return reply.code(404).send({ error: message });
}

function auditMutation(
  service: AppService,
  action: string,
  details: Record<string, string | number | boolean | undefined>,
  replayed = false
): void {
  if (replayed) return;
  const safeDetails = Object.fromEntries(
    Object.entries(details).filter((entry): entry is [string, string | number | boolean] =>
      entry[1] !== undefined
    )
  );
  service.repository.audit(
    `marketplace_${action.toLowerCase()}`,
    `A PAPER marketplace ${action.toLowerCase().replaceAll("_", " ")} completed.`,
    { ...safeDetails, mode: "PAPER", executionModel: "INTERNAL_PAPER" }
  );
  service.events.publish("marketplace", {
    action,
    ...safeDetails,
    mode: "PAPER",
    executionModel: "INTERNAL_PAPER"
  });
}

async function brokerOverrides(service: AppService) {
  let timeout: number | undefined;
  const timedOut = new Promise<undefined>((resolve) => {
    timeout = setTimeout(resolve, MARKETPLACE_BROKER_UI_WAIT_MS);
  });
  let alpaca: Awaited<ReturnType<AppService["alpacaPaperStatus"]>> | undefined;
  try {
    alpaca = await Promise.race([
      service.alpacaPaperStatus().catch(() => undefined),
      timedOut
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  return {
    ALPACA_PAPER: alpaca?.connected
      ? {
          connectionStatus: "CONNECTED_LOCAL_SIMULATION" as const,
          message: "Official Alpaca Paper data is authenticated; marketplace positions and orders remain isolated local simulations."
        }
      : {
          connectionStatus: "NOT_CONFIGURED" as const,
          message: alpaca === undefined
            ? "Alpaca Paper diagnostics are still refreshing; the marketplace remains an isolated local PAPER simulation with external orders disabled."
            : alpaca.configured
            ? "Alpaca Paper credentials are saved but provider diagnostics are not healthy; external order submission remains disabled."
            : "Alpaca Paper is optional and not configured; marketplace positions and orders remain isolated local simulations."
        }
  };
}

function enrollmentSummary(service: AppService, enrollmentId: string) {
  return service.marketplace.paperFillSummary(enrollmentId);
}

/**
 * Loopback marketplace control surface. All mutations are CSRF-protected and
 * operate on isolated INTERNAL_PAPER ledgers only. No route accepts a broker
 * order, wallet signature, or live-execution request.
 */
export async function registerMarketplaceRoutes(
  app: FastifyInstance,
  service: AppService,
  security: SecurityContext
): Promise<void> {
  type MarketplaceReadModel = Awaited<ReturnType<typeof buildMarketplaceReadModel>>;
  let readModelRevision = 0;
  let readModelCache:
    | { readonly revision: number; readonly expiresAt: number; readonly value: MarketplaceReadModel }
    | undefined;
  let readModelInFlight:
    | { readonly revision: number; readonly promise: Promise<MarketplaceReadModel> }
    | undefined;

  async function buildMarketplaceReadModel(): Promise<{
    catalog: ReturnType<AppService["marketplace"]["catalog"]>;
    enrollments: Array<{
      enrollment: ReturnType<AppService["marketplace"]["listEnrollments"]>[number];
      mirroredOrders: number;
      lastMirroredAt?: string;
    }>;
    performanceHistory: Record<string, ReturnType<AppService["marketplace"]["performanceHistory"]>>;
  }> {
    const catalog = service.marketplace.catalog(await brokerOverrides(service));
    const enrollments = service.marketplace.listEnrollments(false).map((enrollment) => ({
      enrollment,
      ...enrollmentSummary(service, enrollment.id)
    }));
    const performanceHistory = Object.fromEntries(
      catalog.pilots.map((pilot) => [
        pilot.id,
        service.marketplace.performanceHistory(pilot.id, 120)
      ])
    );
    return { catalog, enrollments, performanceHistory };
  }

  async function marketplaceReadModel(): Promise<MarketplaceReadModel> {
    const revision = readModelRevision;
    const cached = readModelCache;
    if (cached && cached.revision === revision && Date.now() < cached.expiresAt) {
      return cached.value;
    }
    const pending = readModelInFlight;
    if (pending?.revision === revision) return pending.promise;

    const promise = buildMarketplaceReadModel();
    readModelInFlight = { revision, promise };
    try {
      const value = await promise;
      if (readModelRevision === revision) {
        readModelCache = {
          revision,
          value,
          // Measure from completion so cold provider/SQLite work cannot consume
          // the useful coalescing window before the result is available.
          expiresAt: Date.now() + MARKETPLACE_READ_MODEL_CACHE_TTL_MS
        };
      }
      return value;
    } finally {
      if (readModelInFlight?.promise === promise) readModelInFlight = undefined;
    }
  }

  function invalidateMarketplaceReadModel(): void {
    readModelRevision += 1;
    readModelCache = undefined;
  }

  app.get("/api/marketplace", async () => {
    return marketplaceReadModel();
  });

  app.get("/api/marketplace/pilots/:pilotId", async (request, reply) => {
    const { pilotId } = pilotParamsSchema.parse(request.params);
    const pilot = service.marketplace.pilot(pilotId);
    if (!pilot) return notFound(reply, "Marketplace pilot was not found.");
    return { pilot };
  });

  app.get("/api/marketplace/pilots/:pilotId/performance", async (request, reply) => {
    const { pilotId } = pilotParamsSchema.parse(request.params);
    const { limit } = boundedHistoryQuerySchema.parse(request.query);
    if (!service.marketplace.pilot(pilotId)) {
      return notFound(reply, "Marketplace pilot was not found.");
    }
    return {
      pilotId,
      history: service.marketplace.performanceHistory(pilotId, limit)
    };
  });

  app.get("/api/marketplace/enrollments/:id", async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const enrollment = service.marketplace.enrollment(id);
    if (!enrollment) return notFound(reply, "Marketplace enrollment was not found.");
    return {
      enrollment,
      ...enrollmentSummary(service, id),
      positions: service.marketplace.paperPositions(id),
      fills: service.marketplace.paperFills(id)
    };
  });

  app.get("/api/marketplace/enrollments/:id/events", async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const { limit } = boundedHistoryQuerySchema.parse(request.query);
    if (!service.marketplace.enrollment(id)) {
      return notFound(reply, "Marketplace enrollment was not found.");
    }
    return {
      enrollmentId: id,
      events: service.marketplace.events(id, limit)
    };
  });

  app.post("/api/marketplace/enroll", async (request, reply) => {
    if (!mutationAllowed(request, reply, security)) return reply;
    const body = enrollmentBodySchema.parse(request.body);
    const replayed = Boolean(service.marketplace.repository.eventByIdempotencyKey(body.idempotencyKey));
    const enrollment = service.marketplace.enroll({
      pilotId: body.pilotId,
      allocation: body.allocation,
      mode: "PAPER",
      idempotencyKey: body.idempotencyKey
    });
    invalidateMarketplaceReadModel();
    auditMutation(service, "ENROLLED", {
      enrollmentId: enrollment.id,
      pilotId: enrollment.pilotId,
      targetAllocationUsd: enrollment.targetAllocationUsd
    }, replayed);
    return enrollment;
  });

  app.post("/api/marketplace/enrollments/:id/pause", async (request, reply) => {
    if (!mutationAllowed(request, reply, security)) return reply;
    const { id } = idParamsSchema.parse(request.params);
    const body = transitionBodySchema.parse(request.body);
    const replayed = Boolean(service.marketplace.repository.eventByIdempotencyKey(body.idempotencyKey));
    const enrollment = service.marketplace.pause({
      enrollmentId: id,
      idempotencyKey: body.idempotencyKey
    });
    invalidateMarketplaceReadModel();
    auditMutation(service, "PAUSED", { enrollmentId: id, pilotId: enrollment.pilotId }, replayed);
    return enrollment;
  });

  app.post("/api/marketplace/enrollments/:id/resume", async (request, reply) => {
    if (!mutationAllowed(request, reply, security)) return reply;
    const { id } = idParamsSchema.parse(request.params);
    const body = transitionBodySchema.parse(request.body);
    const replayed = Boolean(service.marketplace.repository.eventByIdempotencyKey(body.idempotencyKey));
    const enrollment = service.marketplace.resume({
      enrollmentId: id,
      idempotencyKey: body.idempotencyKey
    });
    invalidateMarketplaceReadModel();
    auditMutation(service, "RESUMED", { enrollmentId: id, pilotId: enrollment.pilotId }, replayed);
    return enrollment;
  });

  app.post("/api/marketplace/enrollments/:id/unenroll", async (request, reply) => {
    if (!mutationAllowed(request, reply, security)) return reply;
    const { id } = idParamsSchema.parse(request.params);
    const body = transitionBodySchema.parse(request.body);
    const replayed = Boolean(service.marketplace.repository.eventByIdempotencyKey(body.idempotencyKey));
    const enrollment = service.marketplace.unenroll({
      enrollmentId: id,
      idempotencyKey: body.idempotencyKey
    });
    invalidateMarketplaceReadModel();
    auditMutation(service, "UNENROLLED", { enrollmentId: id, pilotId: enrollment.pilotId }, replayed);
    return enrollment;
  });

  app.post("/api/marketplace/enrollments/:id/rebalance/preview", async (request, reply) => {
    if (!mutationAllowed(request, reply, security)) return reply;
    const { id } = idParamsSchema.parse(request.params);
    const body = rebalancePreviewBodySchema.parse(request.body);
    const replayed = Boolean(service.marketplace.repository.eventByIdempotencyKey(body.idempotencyKey));
    const preview = service.marketplace.previewRebalance({
      enrollmentId: id,
      targetAllocationUsd: body.targetAllocationUsd,
      idempotencyKey: body.idempotencyKey
    });
    invalidateMarketplaceReadModel();
    auditMutation(service, "REBALANCE_PREVIEWED", {
      enrollmentId: id,
      pilotId: preview.pilotId,
      previewId: preview.id,
      targetAllocationUsd: preview.targetFundedCapitalUsd,
      canApply: preview.canApply
    }, replayed);
    return preview;
  });

  app.post("/api/marketplace/rebalances/:previewId/apply", async (request, reply) => {
    if (!mutationAllowed(request, reply, security)) return reply;
    const { previewId } = previewParamsSchema.parse(request.params);
    const body = transitionBodySchema.parse(request.body);
    const replayed = Boolean(service.marketplace.repository.eventByIdempotencyKey(body.idempotencyKey));
    const preview = service.marketplace.applyRebalance({
      previewId,
      idempotencyKey: body.idempotencyKey
    });
    invalidateMarketplaceReadModel();
    const enrollment = service.marketplace.enrollment(preview.enrollmentId);
    if (!enrollment) throw new Error("Applied marketplace enrollment is unavailable.");
    auditMutation(service, "REBALANCE_APPLIED", {
      enrollmentId: enrollment.id,
      pilotId: enrollment.pilotId,
      previewId,
      targetAllocationUsd: enrollment.targetAllocationUsd
    }, replayed);
    return enrollment;
  });

  app.post("/api/marketplace/enrollments/:id/switch", async (request, reply) => {
    if (!mutationAllowed(request, reply, security)) return reply;
    const { id } = idParamsSchema.parse(request.params);
    const body = switchBodySchema.parse(request.body);
    const replayed = Boolean(
      service.marketplace.repository.enrollmentByCreateKey(`switch:${body.idempotencyKey}`)
    );
    const result = service.marketplace.switchPilot({
      sourceEnrollmentId: id,
      targetPilotId: body.targetPilotId,
      idempotencyKey: body.idempotencyKey
    });
    invalidateMarketplaceReadModel();
    auditMutation(service, "SWITCHED", {
      sourceEnrollmentId: result.source.id,
      sourcePilotId: result.source.pilotId,
      targetEnrollmentId: result.target.id,
      targetPilotId: result.target.pilotId,
      targetAllocationUsd: result.target.targetAllocationUsd
    }, replayed);
    return result;
  });
}
