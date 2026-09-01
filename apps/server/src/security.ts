import { randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

const COOKIE_NAME = "copylab_session";
const LOOPBACK_HOST = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/;
export const REMOTE_ALPACA_PAPER_CREDENTIAL_PATH = "/api/alpaca-paper/credentials";

export interface RequestAccessPolicy {
  remoteReadOnlyOrigin?: string;
  remoteReadOnlyHost?: string;
}

export interface SecurityContext {
  sessionToken: string;
  csrfToken: string;
}

export function createSecurityContext(): SecurityContext {
  return {
    sessionToken: randomBytes(32).toString("base64url"),
    csrfToken: randomBytes(32).toString("base64url")
  };
}

export function createRequestAccessPolicy(remoteReadOnlyOrigin?: string): RequestAccessPolicy {
  const value = remoteReadOnlyOrigin?.trim();
  if (!value) return {};
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("COPYLAB_REMOTE_READONLY_ORIGIN must be an absolute URL.");
  }
  const hostname = parsed.hostname.toLowerCase();
  const tailnetHostname = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.){2}ts\.net$/;
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    !tailnetHostname.test(hostname) ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    (parsed.pathname !== "" && parsed.pathname !== "/") ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error("COPYLAB_REMOTE_READONLY_ORIGIN must be an exact Tailscale *.ts.net origin.");
  }
  return {
    remoteReadOnlyOrigin: parsed.origin.toLowerCase(),
    remoteReadOnlyHost: parsed.host.toLowerCase()
  };
}

function isLoopbackHost(host: string | undefined): boolean {
  return Boolean(host && LOOPBACK_HOST.test(host.toLowerCase()));
}

function safeEqual(left: string | undefined, right: string): boolean {
  if (!left) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function validSessionAndCsrf(
  request: FastifyRequest,
  security: SecurityContext
): boolean {
  const session = request.cookies[COOKIE_NAME];
  const csrf = request.headers["x-csrf-token"];
  const csrfValue = Array.isArray(csrf) ? csrf[0] : csrf;
  return safeEqual(session, security.sessionToken) && safeEqual(csrfValue, security.csrfToken);
}

function isRemoteAlpacaPaperCredentialRequest(
  request: FastifyRequest,
  access: RequestAccessPolicy
): boolean {
  const host = request.headers.host?.toLowerCase();
  return Boolean(
    access.remoteReadOnlyHost &&
    host === access.remoteReadOnlyHost &&
    request.method === "POST" &&
    request.url === REMOTE_ALPACA_PAPER_CREDENTIAL_PATH
  );
}

export function establishSession(reply: FastifyReply, security: SecurityContext): void {
  reply.setCookie(COOKIE_NAME, security.sessionToken, {
    httpOnly: true,
    sameSite: "strict",
    secure: false,
    path: "/"
  });
}

export function requireLocalRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  access: RequestAccessPolicy = {}
): boolean {
  const ip = request.ip.replace("::ffff:", "");
  if (ip !== "127.0.0.1" && ip !== "::1") {
    void reply.code(403).send({ error: "This service accepts loopback requests only." });
    return false;
  }
  const host = request.headers.host?.toLowerCase();
  const remoteReadOnlyHost = access.remoteReadOnlyHost;
  if (!isLoopbackHost(host) && (!remoteReadOnlyHost || host !== remoteReadOnlyHost)) {
    void reply.code(403).send({ error: "Host must be loopback or the configured private read-only origin." });
    return false;
  }
  const remoteReadOnlyRequest = Boolean(remoteReadOnlyHost && host === remoteReadOnlyHost);
  if (
    remoteReadOnlyRequest &&
    request.method !== "GET" &&
    request.method !== "HEAD" &&
    !isRemoteAlpacaPaperCredentialRequest(request, access)
  ) {
    void reply.code(403).send({ error: "Private remote dashboard access is read-only." });
    return false;
  }
  const origin = request.headers.origin;
  if (origin) {
    try {
      const parsed = new URL(origin);
      const normalizedOrigin = parsed.origin.toLowerCase();
      const loopbackOrigin = parsed.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]", "::1"].includes(parsed.hostname.toLowerCase());
      if (
        (remoteReadOnlyRequest && normalizedOrigin !== access.remoteReadOnlyOrigin) ||
        (!remoteReadOnlyRequest && !loopbackOrigin)
      ) {
        throw new Error("non-loopback origin");
      }
    } catch {
      void reply.code(403).send({ error: "Origin must be loopback or the configured private read-only origin." });
      return false;
    }
  }
  if (request.headers["sec-fetch-site"] === "cross-site") {
    void reply.code(403).send({ error: "Cross-site browser requests are not permitted." });
    return false;
  }
  return true;
}

export function requireMutationSecurity(
  request: FastifyRequest,
  reply: FastifyReply,
  security: SecurityContext
): boolean {
  if (!isLoopbackHost(request.headers.host)) {
    void reply.code(403).send({ error: "Private remote dashboard access is read-only." });
    return false;
  }
  if (!validSessionAndCsrf(request, security)) {
    void reply.code(403).send({ error: "Invalid local session or CSRF token." });
    return false;
  }
  return true;
}

/**
 * The only private-tailnet mutation: replace an Alpaca PAPER credential pair.
 * The global request policy has already enforced loopback proxying, the exact
 * configured *.ts.net Host/Origin, and the exact POST path.
 */
export function requireAlpacaPaperCredentialMutationSecurity(
  request: FastifyRequest,
  reply: FastifyReply,
  security: SecurityContext,
  access: RequestAccessPolicy
): boolean {
  if (
    !isLoopbackHost(request.headers.host) &&
    !isRemoteAlpacaPaperCredentialRequest(request, access)
  ) {
    void reply.code(403).send({ error: "This credential action is not available from this origin." });
    return false;
  }
  if (!validSessionAndCsrf(request, security)) {
    void reply.code(403).send({ error: "Invalid local session or CSRF token." });
    return false;
  }
  return true;
}
