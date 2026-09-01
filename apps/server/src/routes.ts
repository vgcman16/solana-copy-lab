import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { DEFAULT_RISK_POLICY } from "@copylab/shared";
import type { AppService } from "./app-service.js";
import type { RequestAccessPolicy, SecurityContext } from "./security.js";
import {
  establishSession,
  requireAlpacaPaperCredentialMutationSecurity,
  requireMutationSecurity
} from "./security.js";
import { registerMarketplaceRoutes } from "./marketplace-routes.js";

const pythBenchmarksApiKeySchema = z.string()
  .trim()
  .min(8)
  .max(4_096)
  .regex(/^[^\r\n]+$/, "Pyth Benchmarks credentials must be a single-line value.");

const alpacaPaperCredentialValueSchema = z.string()
  .trim()
  .min(8)
  .max(512)
  .regex(/^[^\r\n]+$/, "Alpaca Paper credentials must be single-line values.");

const alpacaPaperCredentialsSchema = z.object({
  apiKey: alpacaPaperCredentialValueSchema,
  secretKey: alpacaPaperCredentialValueSchema,
  confirmation: z.literal("CONNECT ALPACA PAPER")
}).strict();

const credentialsSchema = z.object({
  birdeyeApiKey: z.string().min(8).max(512).optional(),
  heliusApiKey: z.string().min(8).max(512).optional(),
  jupiterApiKey: z.string().min(8).max(512),
  pythBenchmarksApiKey: pythBenchmarksApiKeySchema.optional()
}).strict().superRefine((credentials, context) => {
  if (Boolean(credentials.birdeyeApiKey) !== Boolean(credentials.heliusApiKey)) {
    context.addIssue({
      code: "custom",
      message: "Birdeye and Helius credentials must be supplied together."
    });
  }
});

const dataProviderProfileSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("MANAGED"),
    confirmation: z.literal("USE MANAGED DATA")
  }).strict(),
  z.object({
    mode: z.literal("SHADOW"),
    solanaHttpUrl: z.string().url().max(2_048),
    solanaWsUrl: z.string().url().max(2_048),
    emergencySolanaHttpUrl: z.string().url().max(2_048).optional(),
    confirmation: z.literal("ENABLE SHADOW DATA")
  }).strict(),
  z.object({
    mode: z.literal("SELF_HOSTED"),
    solanaHttpUrl: z.string().url().max(2_048),
    solanaWsUrl: z.string().url().max(2_048),
    emergencySolanaHttpUrl: z.string().url().max(2_048).optional(),
    confirmation: z.literal("ENABLE SELF HOSTED DATA")
  }).strict()
]);

const modeSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("MANUAL_LIVE"),
    confirmation: z.literal("ENABLE MANUAL LIVE")
  }).strict(),
  z.object({
    mode: z.literal("AUTO_LIVE"),
    confirmation: z.literal("ENABLE AUTO LIVE")
  }).strict()
]);

const solPriceBootstrapStartSchema = z.object({
  confirmation: z.literal("START PRICE BOOTSTRAP")
}).strict();

const solPriceBootstrapPauseSchema = z.object({
  confirmation: z.literal("PAUSE PRICE BOOTSTRAP")
}).strict();

const pythBenchmarksCredentialSchema = z.object({
  pythBenchmarksApiKey: pythBenchmarksApiKeySchema,
  confirmation: z.literal("SAVE PYTH API KEY")
}).strict();

const providerParityBaselineCaptureSchema = z.object({
  confirmation: z.literal("CAPTURE FROZEN PARITY BASELINE")
}).strict();

const researchPaperSchema = z.object({ enabled: z.boolean() }).strict();
const autonomousPaperSchema = z.object({ enabled: z.boolean() }).strict();
const autonomousPaperUpgradeSchema = z.object({ confirmed: z.literal(true) }).strict();
const autonomousLearningTrainSchema = z.object({
  confirmation: z.literal("TRAIN AUTONOMOUS LEARNER")
}).strict();
const autonomousLearningPromotionSchema = z.object({
  confirmation: z.literal("PROMOTE AUTONOMOUS CHALLENGER")
}).strict();
const researchPaperLargerSizingSchema = z.object({
  confirmation: z.literal("USE $25 HIGH-RISK PAPER POSITIONS")
}).strict();

function mutationAllowed(request: Parameters<typeof requireMutationSecurity>[0], reply: Parameters<typeof requireMutationSecurity>[1], security: SecurityContext): boolean {
  return requireMutationSecurity(request, reply, security);
}

export async function registerRoutes(
  app: FastifyInstance,
  service: AppService,
  security: SecurityContext,
  access: RequestAccessPolicy
): Promise<void> {
  // Supervisor liveness must never depend on DPAPI, SQLite aggregation, or
  // provider/runtime state. Those richer checks belong to setup/status and the
  // dashboard; this route proves only that the loopback HTTP event loop can
  // accept and complete a request.
  app.get("/api/health", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    return { ok: true };
  });

  app.get("/api/security/csrf", async (_request, reply) => {
    establishSession(reply, security);
    return { csrfToken: security.csrfToken };
  });

  app.get("/api/setup/status", async () => service.setupStatus());
  app.get("/api/dashboard", async () => service.dashboard());
  app.get("/api/live-operations", async () => service.dashboard().liveOperations);
  app.get("/api/autonomous-learning", async () => service.autonomousLearningOverview());
  app.get("/api/wallets/research", async (request) => {
    const query = z.object({
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(25),
      filter: z.enum(["ALL", "PRESCREEN_READY", "PRESCREEN_REJECTED", "AWAITING_PRESCREEN"]).default("ALL"),
      sort: z.enum(["CLOSED_SWAPS", "HISTORY", "ACTIVITY", "RECENT"]).default("CLOSED_SWAPS")
    }).parse(request.query);
    return service.walletResearchPage(query);
  });
  app.get("/api/audit", async (request) => {
    const parsed = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(request.query);
    return service.repository.listAudit(parsed.limit);
  });
  app.get("/api/usage", async () => {
    const date = new Date();
    date.setUTCDate(1);
    return service.repository.usageSince(date.toISOString().slice(0, 10));
  });
  app.get("/api/provider/profile", async () => service.dataProviderStatus());
  app.get("/api/alpaca-paper/status", async () => service.alpacaPaperStatus());
  app.get("/api/provider/sol-price-bootstrap", async () => service.solPriceBootstrapStatus());
  app.get("/api/provider/parity-baseline", async () =>
    service.providerParityBaselineStatus() ?? {
      status: "NOT_STARTED",
      blockers: [{
        code: "CAPTURE_NOT_REQUESTED",
        message: "No frozen provider parity baseline capture has been requested."
      }],
      acquisitions: []
    }
  );

  app.get("/api/events", async (_request, reply) => {
    service.events.attach(reply);
    return reply;
  });

  app.post("/api/setup/credentials", async (request, reply) => {
    if (!mutationAllowed(request, reply, security)) return reply;
    const credentials = credentialsSchema.parse(request.body);
    const health = await service.saveCredentials({
      jupiterApiKey: credentials.jupiterApiKey,
      ...(credentials.birdeyeApiKey ? { birdeyeApiKey: credentials.birdeyeApiKey } : {}),
      ...(credentials.heliusApiKey ? { heliusApiKey: credentials.heliusApiKey } : {}),
      ...(credentials.pythBenchmarksApiKey
        ? { pythBenchmarksApiKey: credentials.pythBenchmarksApiKey }
        : {})
    });
    return { saved: true, health };
  });

  app.post("/api/alpaca-paper/credentials", async (request, reply) => {
    if (!requireAlpacaPaperCredentialMutationSecurity(
      request,
      reply,
      security,
      access
    )) return reply;
    const credentials = alpacaPaperCredentialsSchema.parse(request.body);
    return service.saveAlpacaPaperCredentials({
      apiKey: credentials.apiKey,
      secretKey: credentials.secretKey
    });
  });

  app.post("/api/provider/profile", async (request, reply) => {
    if (!mutationAllowed(request, reply, security)) return reply;
    const body = dataProviderProfileSchema.parse(request.body);
    return service.saveDataProviderProfile(body.mode === "MANAGED"
      ? { mode: "MANAGED" }
      : {
          mode: body.mode,
          solanaHttpUrl: body.solanaHttpUrl,
          solanaWsUrl: body.solanaWsUrl,
          ...(body.emergencySolanaHttpUrl
            ? { emergencySolanaHttpUrl: body.emergencySolanaHttpUrl }
            : {})
        });
  });

  app.post("/api/provider/sol-price-bootstrap/start", async (request, reply) => {
    if (!mutationAllowed(request, reply, security)) return reply;
    solPriceBootstrapStartSchema.parse(request.body);
    return service.startSolPriceBootstrap();
  });

  app.post("/api/provider/sol-price-bootstrap/pause", async (request, reply) => {
    if (!mutationAllowed(request, reply, security)) return reply;
    solPriceBootstrapPauseSchema.parse(request.body);
    return service.pauseSolPriceBootstrap();
  });

  app.post("/api/provider/sol-price-bootstrap/credentials", async (request, reply) => {
    if (!mutationAllowed(request, reply, security)) return reply;
    const body = pythBenchmarksCredentialSchema.parse(request.body);
    return service.savePythBenchmarksApiKey(body.pythBenchmarksApiKey);
  });

  app.post("/api/provider/parity-baseline/capture", async (request, reply) => {
    if (!mutationAllowed(request, reply, security)) return reply;
    providerParityBaselineCaptureSchema.parse(request.body);
    return service.captureProviderParityBaseline();
  });

  app.post("/api/setup/paper", async (request, reply) => {
    if (!mutationAllowed(request, reply, security)) return reply;
    const body = z.object({
      initialNavUsd: z.number().default(DEFAULT_RISK_POLICY.initialNavUsd)
    }).parse(request.body ?? {});
    return service.initializePaper(body.initialNavUsd);
  });

  app.post("/api/wallet/create", async (request, reply) => {
    if (!mutationAllowed(request, reply, security)) return reply;
    const body = z.object({ backupPassphrase: z.string().min(12).max(256) }).parse(request.body);
    const created = service.wallet.create(body.backupPassphrase);
    service.events.publish("wallet", { address: created.address, backupConfirmed: false });
    return {
      address: created.address,
      filename: `copylab-recovery-${created.address.slice(0, 8)}.json`,
      recovery: created.recovery
    };
  });

  app.post("/api/wallet/confirm-backup", async (request, reply) => {
    if (!mutationAllowed(request, reply, security)) return reply;
    const body = z.object({ address: z.string().min(32).max(64) }).parse(request.body);
    service.wallet.confirmBackup(body.address);
    service.events.publish("wallet", { address: body.address, backupConfirmed: true });
    return service.wallet.status();
  });

  app.post("/api/wallet/pending-recovery", async (request, reply) => {
    if (!mutationAllowed(request, reply, security)) return reply;
    const body = z.object({ address: z.string().min(32).max(64) }).strict().parse(request.body);
    const recovery = service.wallet.pendingRecovery(body.address);
    return {
      address: body.address,
      filename: `copylab-recovery-${body.address.slice(0, 8)}.json`,
      recovery
    };
  });

  app.post("/api/wallet/restore", async (request, reply) => {
    if (!mutationAllowed(request, reply, security)) return reply;
    const recoverySchema = z.object({
      version: z.literal(1),
      algorithm: z.literal("aes-256-gcm+scrypt"),
      address: z.string().min(32).max(64),
      salt: z.string().min(1).max(1_024),
      iv: z.string().min(1).max(1_024),
      tag: z.string().min(1).max(1_024),
      ciphertext: z.string().min(1).max(4_096),
      createdAt: z.string().datetime()
    }).strict();
    const body = z.object({
      recovery: recoverySchema,
      backupPassphrase: z.string().min(12).max(256),
      confirmation: z.literal("RESTORE COPYLAB WALLET")
    }).strict().parse(request.body);
    const restored = service.wallet.restore(body.recovery, body.backupPassphrase);
    service.events.publish("wallet", restored);
    return service.wallet.status();
  });

  app.post("/api/mode", async (request, reply) => {
    if (!mutationAllowed(request, reply, security)) return reply;
    const { mode } = modeSchema.parse(request.body);
    return { mode: await service.transitionMode(mode, true) };
  });

  app.post("/api/control/pause", async (request, reply) => {
    if (!mutationAllowed(request, reply, security)) return reply;
    return { mode: await service.pause() };
  });

  app.post("/api/control/resume", async (request, reply) => {
    if (!mutationAllowed(request, reply, security)) return reply;
    return { mode: await service.resume() };
  });

  app.post("/api/control/recheck-entries", async (request, reply) => {
    if (!mutationAllowed(request, reply, security)) return reply;
    return service.runtime.recheckOperationalPause();
  });

  app.post("/api/research-paper", async (request, reply) => {
    if (!mutationAllowed(request, reply, security)) return reply;
    const { enabled } = researchPaperSchema.parse(request.body);
    return service.setResearchPaperEnabled(enabled);
  });

  app.post("/api/autonomous-paper", async (request, reply) => {
    if (!mutationAllowed(request, reply, security)) return reply;
    const { enabled } = autonomousPaperSchema.parse(request.body);
    return service.setAutonomousPaperEnabled(enabled);
  });

  app.post("/api/autonomous-paper/upgrade", async (request, reply) => {
    if (!mutationAllowed(request, reply, security)) return reply;
    const { confirmed } = autonomousPaperUpgradeSchema.parse(request.body);
    return service.upgradeAutonomousPaperPolicy(confirmed);
  });

  app.post("/api/autonomous-learning/train", async (request, reply) => {
    if (!mutationAllowed(request, reply, security)) return reply;
    autonomousLearningTrainSchema.parse(request.body);
    return service.trainAutonomousLearning();
  });

  app.post("/api/autonomous-learning/promote", async (request, reply) => {
    if (!mutationAllowed(request, reply, security)) return reply;
    const { confirmation } = autonomousLearningPromotionSchema.parse(request.body);
    return service.promoteAutonomousChallenger(confirmation);
  });

  app.post("/api/research-paper/sizing/larger", async (request, reply) => {
    if (!mutationAllowed(request, reply, security)) return reply;
    researchPaperLargerSizingSchema.parse(request.body);
    return service.enlargeResearchPaperEntries();
  });

  app.post("/api/control/emergency-exit", async (request, reply) => {
    if (!mutationAllowed(request, reply, security)) return reply;
    const body = z.object({ confirmation: z.literal("EXIT ALL POSITIONS") }).parse(request.body);
    void body;
    const result = await service.runtime.emergencyExit();
    service.events.publish("emergency-exit", result);
    return result;
  });

  app.post("/api/approvals/:id/approve", async (request, reply) => {
    if (!mutationAllowed(request, reply, security)) return reply;
    const { id } = z.object({ id: z.string().min(1).max(128) }).parse(request.params);
    const execution = await service.runtime.approveExecution(id);
    service.events.publish("execution", execution);
    return execution;
  });

  app.post("/api/approvals/:id/reject", async (request, reply) => {
    if (!mutationAllowed(request, reply, security)) return reply;
    const { id } = z.object({ id: z.string().min(1).max(128) }).parse(request.params);
    const execution = await service.runtime.rejectExecution(id);
    service.events.publish("execution", execution);
    return execution;
  });

  app.post("/api/discovery/refresh", async (request, reply) => {
    if (!mutationAllowed(request, reply, security)) return reply;
    await service.runtime.refreshDiscovery();
    return { queued: true };
  });

  await registerMarketplaceRoutes(app, service, security);
}
