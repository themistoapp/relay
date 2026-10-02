import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { Env } from "../config/env.js";
import type { Endpoint, Store } from "../db/store.js";
import type { EndpointRenderer } from "./renderer.js";
import { RateLimiter, makeClientIp, trustList } from "../util/net.js";
import { healthInfo } from "../util/health.js";
import { loggerOption } from "../admin/server.js";
import type { WattsUpFeed } from "../feeds/wattsup/feed.js";
import type { FeedSettings } from "../feeds/wattsup/defaults.js";

// The only port meant to face the internet (through Nginx Proxy Manager). It serves the published
// endpoints at /v1/:slug and nothing else of the admin API.

interface Deps {
  env: Env;
  store: Store;
  renderer: EndpointRenderer;
  wattsUp: WattsUpFeed;
  logger?: FastifyBaseLogger | boolean;
}

const EXPOSED = "X-Relay-Fetched-At, X-Relay-Stale, X-Relay-Warnings, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, Retry-After";

export function allowedOrigin(ep: Endpoint, origin: string | undefined): string | null {
  if (!origin) return null;
  if (ep.corsOrigins.includes("*")) return ep.access === "public" ? "*" : origin;
  return ep.corsOrigins.some((o) => o.replace(/\/$/, "").toLowerCase() === origin.toLowerCase()) ? origin : null;
}

export function feedOrigin(s: FeedSettings, origin: string | undefined): string | null {
  if (!origin) return null;
  if (s.corsOrigins.includes("*")) return "*";
  return s.corsOrigins.some((o) => o.replace(/\/$/, "").toLowerCase() === origin.toLowerCase()) ? origin : null;
}

/** Picks Brotli, then gzip, then none, from an Accept-Encoding header (honouring q=0). */
export function pickEncoding(header: string | undefined): "br" | "gzip" | null {
  const accepted = new Map<string, number>();
  for (const part of (header ?? "").toLowerCase().split(",")) {
    const [name, ...params] = part.trim().split(";");
    if (!name) continue;
    const q = params.map((p) => /^\s*q=([\d.]+)/.exec(p)).find(Boolean);
    accepted.set(name.trim(), q ? Number(q[1]) : 1);
  }
  const ok = (e: string) => (accepted.get(e) ?? accepted.get("*") ?? 0) > 0;
  return ok("br") ? "br" : ok("gzip") ? "gzip" : null;
}

export function buildPublicServer({ env, store, renderer, wattsUp, logger = true }: Deps): FastifyInstance {
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

  // The Watts Up feed: always from the response built after the last poll, never from an upstream.
  function feedCors(req: FastifyRequest, reply: FastifyReply, settings: FeedSettings) {
    reply.header("Vary", "Origin, Accept-Encoding");
    const allow = feedOrigin(settings, req.headers.origin);
    if (allow) {
      reply.header("Access-Control-Allow-Origin", allow);
      reply.header("Access-Control-Expose-Headers", "ETag, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, Retry-After");
    }
    return allow;
  }

  function serveFeed(req: FastifyRequest, reply: FastifyReply, settings: FeedSettings) {
    const started = performance.now();
    const ip = clientIp(req);
    const done = (status: number) =>
      store.logRequest({ endpointId: null, slug: settings.slug, keyId: null, caller: "watts-up feed", ip, status, ms: Math.round(performance.now() - started), at: Date.now() });
    feedCors(req, reply, settings);
    const rl = limiter.hit(`feed:${ip}`, settings.rateLimitPerMin, 60_000);
    reply.header("X-RateLimit-Limit", settings.rateLimitPerMin);
    reply.header("X-RateLimit-Remaining", rl.remaining);
    reply.header("X-RateLimit-Reset", Math.ceil(rl.resetAt / 1000));
    if (!rl.allowed) {
      reply.header("Retry-After", Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000)));
      done(429);
      return sendError(reply, 429, `Too many requests. The limit is ${settings.rateLimitPerMin} per minute.`);
    }
    const built = wattsUp.current();
    if (!built) {
      done(503);
      reply.header("Retry-After", 30);
      return sendError(reply, 503, "The Watts Up feed isn't ready yet.");
    }
    reply.header("Cache-Control", settings.maxAge > 0 ? `public, max-age=${settings.maxAge}, stale-while-revalidate=${settings.staleWhileRevalidate}` : "no-cache");
    reply.header("ETag", built.etag);
    reply.header("Last-Modified", new Date(built.builtAt).toUTCString());
    const inm = req.headers["if-none-match"];
    if (typeof inm === "string" && inm.split(",").some((t) => t.trim().replace(/^W\//, "") === built.etag)) {
      done(304);
      return reply.code(304).send();
    }
    const enc = pickEncoding(req.headers["accept-encoding"] as string | undefined);
    reply.type("application/json; charset=utf-8");
    done(200);
    if (enc === "br") return reply.header("Content-Encoding", "br").send(built.br);
    if (enc === "gzip") return reply.header("Content-Encoding", "gzip").send(built.gzip);
    return reply.send(built.json);
  }

  const feedAt = (slug: string) => {
    const s = wattsUp.settings();
    return s.enabled && s.slug === slug ? s : null;
  };

  app.options<{ Params: { slug: string } }>("/v1/:slug", async (req, reply) => {
    const feed = feedAt(req.params.slug);
    if (feed) {
      if (feedCors(req, reply, feed)) {
        reply.header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
        reply.header("Access-Control-Allow-Headers", "Content-Type, If-None-Match");
        reply.header("Access-Control-Max-Age", "600");
      }
      return reply.code(204).send();
    }
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
    const feed = feedAt(req.params.slug);
    if (feed) return serveFeed(req, reply, feed);
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
