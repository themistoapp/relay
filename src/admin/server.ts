import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Env } from "../config/env.js";
import type { Store } from "../db/store.js";
import type { Scheduler } from "../puller/scheduler.js";
import type { EndpointRenderer } from "../public/renderer.js";
import { safeEqual, type Secrets } from "../crypto/secrets.js";
import { RateLimiter, makeClientIp, trustList } from "../util/net.js";
import { buildTime, healthInfo } from "../util/health.js";
import { sourceRoutes } from "./sources.js";
import { endpointRoutes } from "./endpoints.js";
import { historyRoutes } from "./history.js";
import { dataRoutes } from "./data.js";

export interface AdminDeps {
  env: Env;
  store: Store;
  scheduler: Scheduler;
  renderer: EndpointRenderer;
  secrets: Secrets;
  /** A pino logger to share, or false for none. */
  logger?: FastifyBaseLogger | boolean;
  /** Where the built admin UI lives; defaults to dist/web next to the compiled server. */
  webDir?: string;
}

const COOKIE = "relay_session";
const SESSION_DAYS = 30;

export function buildAdminServer(deps: AdminDeps): FastifyInstance {
  const { env, secrets } = deps;
  const app = Fastify({ ...loggerOption(deps.logger), trustProxy: trustList(env.TRUST_PROXY), bodyLimit: 2 * 1024 * 1024 });
  const clientIp = makeClientIp(env.TRUST_PROXY, env.CLIENT_IP_HEADER);
  const loginLimiter = new RateLimiter();

  // JSON only: a cross-site form can't send application/json without a CORS preflight, which this
  // server never approves. Together with the SameSite cookie that covers CSRF.
  app.removeContentTypeParser("text/plain");
  app.register(cookie, { secret: secrets.cookieSecret });

  const isSignedIn = (req: FastifyRequest) => {
    const raw = req.cookies[COOKIE];
    if (!raw) return false;
    const u = req.unsignCookie(raw);
    if (!u.valid || !u.value) return false;
    const issued = Number(u.value);
    return Number.isFinite(issued) && Date.now() - issued < SESSION_DAYS * 86_400_000;
  };

  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/admin/api/")) return;
    if (req.url.startsWith("/admin/api/login") || req.url.startsWith("/admin/api/session")) return;
    if (!isSignedIn(req)) return reply.code(401).send({ error: "Sign in first." });
  });

  app.get("/healthz", async () => healthInfo(deps.store));

  app.post<{ Body: { password?: string } }>("/admin/api/login", async (req, reply) => {
    const rl = loginLimiter.hit(clientIp(req), 10, 60_000);
    if (!rl.allowed) return reply.code(429).send({ error: "Too many attempts. Wait a minute and try again." });
    if (typeof req.body?.password !== "string" || !safeEqual(req.body.password, env.ADMIN_PASSWORD)) {
      return reply.code(401).send({ error: "That password isn't right." });
    }
    reply.setCookie(COOKIE, String(Date.now()), {
      signed: true,
      httpOnly: true,
      sameSite: "lax",
      secure: req.protocol === "https",
      path: "/",
      maxAge: SESSION_DAYS * 86400,
    });
    return { ok: true };
  });

  app.post("/admin/api/logout", async (_req, reply) => {
    reply.clearCookie(COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/admin/api/session", async (req) => ({ signedIn: isSignedIn(req) }));

  app.get("/admin/api/meta", async (req) => ({
    // Without PUBLIC_BASE_URL, assume endpoints are reached on the same host as this admin UI,
    // on the public port as mapped by Docker (e.g. http://192.168.1.2:1099).
    publicBaseUrl: env.PUBLIC_BASE_URL
      ? env.PUBLIC_BASE_URL.replace(/\/$/, "")
      : `${req.protocol}://${req.hostname.includes(":") && !req.hostname.startsWith("[") ? `[${req.hostname}]` : req.hostname}:${env.PUBLIC_HOST_PORT ?? env.PUBLIC_PORT}`,
    publicBaseUrlSet: !!env.PUBLIC_BASE_URL,
    tz: env.TZ,
    builtAt: buildTime(),
    alertsOn: !!env.ALERT_WEBHOOK_URL,
    backups: deps.scheduler.listBackups(),
  }));

  app.register(sourceRoutes(deps), { prefix: "/admin/api" });
  app.register(historyRoutes(deps), { prefix: "/admin/api" });
  app.register(endpointRoutes(deps), { prefix: "/admin/api" });
  app.register(dataRoutes(deps), { prefix: "/admin/api" });

  const webDir = deps.webDir ?? fileURLToPath(new URL("../web", import.meta.url));
  const hasWeb = existsSync(webDir + "/index.html");
  if (hasWeb) {
    app.register(fastifyStatic, {
      root: webDir,
      wildcard: false,
      setHeaders: (res, file) => res.header("Cache-Control", file.includes("/assets/") ? "public, max-age=31536000, immutable" : "no-cache"),
    });
  }

  app.setNotFoundHandler((req: FastifyRequest, reply: FastifyReply) => {
    if (req.url.startsWith("/admin/api/") || req.method !== "GET" || !hasWeb) return reply.code(404).send({ error: "Not found." });
    return reply.header("Cache-Control", "no-cache").sendFile("index.html");
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    const status = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
    if (status === 500) req.log.error({ err }, "admin request failed");
    return reply.code(status).send({ error: status === 500 ? "Something went wrong. Check the server log." : err.message });
  });

  return app;
}

export function loggerOption(l: FastifyBaseLogger | boolean | undefined) {
  return typeof l === "object" ? { loggerInstance: l } : { logger: l ?? true };
}

export const idParam = (req: FastifyRequest) => Number((req.params as { id: string }).id);
