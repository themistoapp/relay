import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { Env } from "../config/env.js";
import type { Endpoint, Store } from "../db/store.js";
import type { EndpointRenderer } from "./renderer.js";
import { RateLimiter, makeClientIp, trustList } from "../util/net.js";
import { healthInfo } from "../util/health.js";
import { loggerOption } from "../admin/server.js";

// The only port meant to face the internet (through Nginx Proxy Manager). It serves the published
// endpoints at /v1/:slug and nothing else of the admin API.

interface Deps {
  env: Env;
  store: Store;
  renderer: EndpointRenderer;
  logger?: FastifyBaseLogger | boolean;
}

const EXPOSED = "X-Relay-Fetched-At, X-Relay-Stale, X-Relay-Warnings, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, Retry-After";

export function allowedOrigin(ep: Endpoint, origin: string | undefined): string | null {
  if (!origin) return null;
  if (ep.corsOrigins.includes("*")) return ep.access === "public" ? "*" : origin;
  return ep.corsOrigins.some((o) => o.replace(/\/$/, "").toLowerCase() === origin.toLowerCase()) ? origin : null;
}

export function buildPublicServer({ env, store, renderer, logger = true }: Deps): FastifyInstance {
  const app = Fastify({ ...loggerOption(logger), trustProxy: trustList(env.TRUST_PROXY) });
  const clientIp = makeClientIp(env.TRUST_PROXY, env.CLIENT_IP_HEADER);
  const limiter = new RateLimiter();

  app.get("/healthz", async () => healthInfo(store));

  const sendError = (reply: FastifyReply, status: number, error: string) => reply.code(status).type("application/json").send({ error });

  function cors(req: FastifyRequest, reply: FastifyReply, ep: Endpoint) {
    reply.header("Vary", "Origin");
    const allow = allowedOrigin(ep, req.headers.origin);
    if (allow) {
      reply.header("Access-Control-Allow-Origin", allow);
      reply.header("Access-Control-Expose-Headers", EXPOSED);
    }
    return allow;
  }

  app.options<{ Params: { slug: string } }>("/v1/:slug", async (req, reply) => {
    const ep = store.getEndpointBySlug(req.params.slug);
    if (!ep || !ep.enabled) return reply.code(404).send();
    if (cors(req, reply, ep)) {
      reply.header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
      reply.header("Access-Control-Allow-Headers", "X-Api-Key, Content-Type");
      reply.header("Access-Control-Max-Age", "600");
    }
    return reply.code(204).send();
  });

  app.get<{ Params: { slug: string }; Querystring: { key?: string } }>("/v1/:slug", async (req, reply) => {
    const started = performance.now();
    const ip = clientIp(req);
    const ep = store.getEndpointBySlug(req.params.slug);
    let keyId: number | null = null;
    let caller: string | null = null;
    const done = (status: number) => {
      if (!ep) return;
      store.logRequest({ endpointId: ep.id, slug: ep.slug, keyId, caller, ip, status, ms: Math.round(performance.now() - started), at: Date.now() });
    };

    if (!ep || !ep.enabled) return sendError(reply, 404, "There's no endpoint at this address.");
    cors(req, reply, ep);

    if (ep.access === "key") {
      const header = req.headers["x-api-key"];
      const key = (typeof header === "string" ? header : undefined) ?? req.query.key;
      if (!key) {
        done(401);
        return sendError(reply, 401, "This endpoint needs an API key. Send it in the X-Api-Key header or as ?key=.");
      }
      const found = store.findKey(ep.id, key);
      if (!found) {
        done(401);
        return sendError(reply, 401, "That API key isn't valid for this endpoint.");
      }
      keyId = found.id;
      caller = found.label;
      store.touchKey(found.id);
    }

    const windowMs = ep.rateWindow === "hour" ? 3_600_000 : 60_000;
    const bucket = `${ep.id}:${ep.rateBy === "key" && keyId !== null ? `k${keyId}` : `ip${ip}`}`;
    const rl = limiter.hit(bucket, ep.rateLimit, windowMs);
    reply.header("X-RateLimit-Limit", ep.rateLimit);
    reply.header("X-RateLimit-Remaining", rl.remaining);
    reply.header("X-RateLimit-Reset", Math.ceil(rl.resetAt / 1000));
    if (!rl.allowed) {
      reply.header("Retry-After", Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000)));
      done(429);
      return sendError(reply, 429, `Too many requests. The limit is ${ep.rateLimit} per ${ep.rateWindow}.`);
    }

    let r;
    try {
      r = renderer.render(ep);
    } catch (e) {
      req.log.error({ err: e, slug: ep.slug }, "render failed");
      done(500);
      return sendError(reply, 500, "Something went wrong building this response.");
    }
    if (r.fetchedAt === null) {
      done(503);
      reply.header("Retry-After", 60);
      return sendError(reply, 503, `No data yet: waiting for the first pull from ${r.missing.join(", ")}.`);
    }
    reply.header("X-Relay-Fetched-At", new Date(r.fetchedAt).toISOString());
    if (r.stale) reply.header("X-Relay-Stale", "true");
    if (r.errors.length) reply.header("X-Relay-Warnings", String(r.errors.length));
    reply.header("Cache-Control", ep.cacheTtl > 0 ? `public, max-age=${ep.cacheTtl}` : "no-store");
    done(200);
    return reply.type("application/json; charset=utf-8").send(r.json);
  });

  app.setNotFoundHandler((req, reply) => sendError(reply, 404, "Not found. Endpoints live at /v1/<name>."));
  return app;
}
