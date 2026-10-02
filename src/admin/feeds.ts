import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { AdminDeps } from "./server.js";
import { parse, slugSchema } from "./schemas.js";
import { SOURCE_DEFAULTS, type SourceKey } from "../feeds/wattsup/defaults.js";
import { sourceStatus } from "../feeds/wattsup/response.js";
import type { FeedSource } from "../feeds/wattsup/store.js";

const url = z.string().url("Enter a full URL, starting http:// or https://").refine((u) => /^https?:\/\//i.test(u), "Only http and https URLs");

const sourceInput = z.object({
  url,
  backfillUrl: url.nullable(),
  intervalMin: z.number().int().min(1, "Poll at most once a minute").max(1440),
  timeoutMs: z.number().int().min(1000).max(120_000),
  authType: z.enum(["none", "bearer"]),
  authSecret: z.string().max(10_000).nullable().optional(),
  enabled: z.boolean(),
});

const origin = z.string().refine((o) => o === "*" || /^https?:\/\/[^/\s]+$/.test(o.replace(/\/$/, "")), "Origins look like https://example.com (no path)");

const settingsInput = z.object({
  enabled: z.boolean(),
  slug: slugSchema,
  corsOrigins: z.array(origin).max(50),
  maxAge: z.number().int().min(0).max(86400),
  staleWhileRevalidate: z.number().int().min(0).max(86400),
  rateLimitPerMin: z.number().int().min(1).max(100_000),
  retainDays: z.number().int().min(2, "Keep at least 2 days, so yesterday's rows are there").max(3650),
  dfsHistoryDays: z.number().int().min(0).max(365),
});

const KEYS = new Set<string>(SOURCE_DEFAULTS.map((d) => d.key));

export const feedRoutes =
  ({ wattsUp, store }: AdminDeps): FastifyPluginAsync =>
  async (app) => {
    const withStatus = (s: FeedSource) => {
      const d = SOURCE_DEFAULTS.find((x) => x.key === s.key)!;
      return {
        ...s,
        status: sourceStatus(s),
        nextPollAt: wattsUp.nextPoll(s.key),
        isDefault: s.url === d.url && (s.backfillUrl ?? null) === (d.backfillUrl ?? null) && s.intervalMin === d.intervalMin && s.timeoutMs === d.timeoutMs,
        hasBackfill: d.backfillUrl !== undefined,
      };
    };
    const key = (req: { params: unknown }) => (req.params as { key: string }).key as SourceKey;

    app.get("/feeds/watts-up", async () => ({
      settings: wattsUp.settings(),
      sources: wattsUp.store.listSources().map(withStatus),
      counts: wattsUp.store.counts(),
      build: wattsUp.buildInfo(),
    }));

    app.get("/feeds/watts-up/response", async (_req, reply) => {
      const b = wattsUp.current();
      if (!b) return reply.code(503).send({ error: "The response hasn't been built yet." });
      return reply.type("application/json; charset=utf-8").send(b.json);
    });

    app.put("/feeds/watts-up/settings", async (req, reply) => {
      const p = parse(settingsInput, req.body);
      if (!p.ok) return reply.code(400).send({ error: p.error });
      if (store.slugTaken(p.value.slug)) return reply.code(409).send({ error: `An endpoint already uses /v1/${p.value.slug}.` });
      wattsUp.saveSettings(p.value);
      return wattsUp.settings();
    });

    app.put("/feeds/watts-up/sources/:key", async (req, reply) => {
      if (!KEYS.has(key(req))) return reply.code(404).send({ error: "No such feed source." });
      const p = parse(sourceInput, req.body);
      if (!p.ok) return reply.code(400).send({ error: p.error });
      const s = wattsUp.updateSource(key(req), p.value);
      return s ? withStatus(s) : reply.code(404).send({ error: "No such feed source." });
    });

    app.post("/feeds/watts-up/sources/:key/reset", async (req, reply) => {
      const s = KEYS.has(key(req)) ? wattsUp.resetSource(key(req)) : undefined;
      return s ? withStatus(s) : reply.code(404).send({ error: "No such feed source." });
    });

    app.post("/feeds/watts-up/sources/:key/poll", async (req, reply) => {
      if (!KEYS.has(key(req))) return reply.code(404).send({ error: "No such feed source." });
      const result = await wattsUp.poll(key(req));
      return { result, source: withStatus(wattsUp.store.getSource(key(req))!) };
    });

    // Calls a source with unsaved settings and shows what Relay would read, without saving.
    app.post<{ Body: Record<string, unknown> & { backfill?: boolean } }>("/feeds/watts-up/sources/:key/test", async (req, reply) => {
      const s = KEYS.has(key(req)) ? wattsUp.store.getSource(key(req)) : undefined;
      if (!s) return reply.code(404).send({ error: "No such feed source." });
      const p = parse(sourceInput, req.body);
      if (!p.ok) return reply.code(400).send({ error: p.error });
      const v = p.value;
      // "Test" checks the URL being edited: the normal one, or the catch-up one when asked.
      const r = await wattsUp.fetchAndParse({ ...s, lastSuccessAt: Date.now() }, { ...v, url: req.body.backfill && v.backfillUrl ? v.backfillUrl : v.url, backfillUrl: null });
      const { parsed, ...rest } = r;
      return { ...rest, sample: parsed?.sample ?? [] };
    });
  };
