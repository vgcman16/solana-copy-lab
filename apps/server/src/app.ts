import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { redactSensitiveText } from "@copylab/providers";
import type { AppService } from "./app-service.js";
import { registerRoutes } from "./routes.js";
import { createRequestAccessPolicy, createSecurityContext, requireLocalRequest } from "./security.js";

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unexpected error";
  return redactSensitiveText(message);
}

export interface BuildAppOptions {
  remoteReadOnlyOrigin?: string;
}

export async function buildApp(
  service: AppService,
  options: BuildAppOptions = {}
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: process.env.VITEST
      ? false
      : {
          level: process.env.LOG_LEVEL ?? "info",
          redact: ["req.headers.authorization", "req.headers.x-api-key", "req.body"]
        },
    trustProxy: false,
    bodyLimit: 32 * 1024
  });
  const security = createSecurityContext();
  const access = createRequestAccessPolicy(
    options.remoteReadOnlyOrigin ?? process.env.COPYLAB_REMOTE_READONLY_ORIGIN
  );

  await app.register(cookie);
  await app.register(helmet, {
    // CopyLab is intentionally served over loopback HTTP and an optional
    // tailnet-only HTTP proxy. Safari obeys Helmet's default
    // upgrade-insecure-requests directive even for those private origins,
    // which upgrades the module/CSS/API requests to nonexistent HTTPS and
    // leaves only the dark page background visible.
    strictTransportSecurity: false,
    contentSecurityPolicy:
      process.env.NODE_ENV === "development"
        ? false
        : {
            directives: {
              defaultSrc: ["'self'"],
              scriptSrc: ["'self'"],
              styleSrc: ["'self'", "'unsafe-inline'"],
              imgSrc: ["'self'", "data:"],
              connectSrc: ["'self'"],
              upgradeInsecureRequests: null
            }
          }
  });

  app.addHook("onRequest", async (request, reply) => {
    if (!requireLocalRequest(request, reply, access)) return reply;
  });
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("Cache-Control", "no-store");
    reply.header("X-Content-Type-Options", "nosniff");
    return payload;
  });

  app.setErrorHandler((error, _request, reply) => {
    const status =
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      typeof error.statusCode === "number"
        ? error.statusCode
        : 400;
    void reply.code(status >= 400 && status < 600 ? status : 500).send({
      error: safeErrorMessage(error)
    });
  });

  await registerRoutes(app, service, security, access);

  const here = dirname(fileURLToPath(import.meta.url));
  const webDist = resolve(here, "../../web/dist");
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, wildcard: false });
    app.get("/*", async (request, reply) => {
      if (request.url.startsWith("/api/")) {
        return reply.code(404).send({ error: "Unknown local API route." });
      }
      return reply.sendFile("index.html");
    });
  } else {
    app.get("/", async () => ({
      name: "Solana Copy Lab",
      status: "API ready",
      dashboard: "Run pnpm dev and open http://127.0.0.1:4173"
    }));
  }

  return app;
}
