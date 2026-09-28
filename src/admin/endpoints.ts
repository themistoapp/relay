import type { FastifyPluginAsync } from "fastify";
import type { AdminDeps } from "./server.js";
import { idParam } from "./server.js";
import { definitionSchema, endpointSchema, parse, slugSchema } from "./schemas.js";
import type { Endpoint } from "../db/store.js";

export const endpointRoutes =
  ({ store, renderer }: AdminDeps): FastifyPluginAsync =>
  async (app) => {
    const dayStart = () => Date.now() - 86_400_000;
    const withStats = (e: Endpoint) => ({
      ...e,
      calls24h: store.callsSince(e.id, dayStart()),
      keys: store.listKeys(e.id).filter((k) => !k.revokedAt).length,
    });

    app.get("/endpoints", async () => store.listEndpoints().map(withStats));

    app.get("/endpoints/:id", async (req, reply) => {
      const e = store.getEndpoint(idParam(req));
      if (!e) return reply.code(404).send({ error: "No such endpoint." });
      return withStats(e);
    });

    app.post<{ Body: { name?: string; slug?: string } }>("/endpoints", async (req, reply) => {
      const name = String(req.body?.name ?? "").trim() || "New endpoint";
      let base = (req.body?.slug || name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "endpoint";
      const s = parse(slugSchema, base);
      if (!s.ok) return reply.code(400).send({ error: s.error });
      let slug = base;
      for (let i = 2; store.slugTaken(slug); i++) slug = `${base}-${i}`;
      return store.createEndpoint({
        slug,
        name,
        definition: { fields: [], output: [] },
        enabled: false,
        access: "key",
        corsOrigins: [],
        rateLimit: 60,
        rateWindow: "minute",
        rateBy: "key",
        cacheTtl: 60,
      });
    });

    app.put("/endpoints/:id", async (req, reply) => {
      const id = idParam(req);
      const p = parse(endpointSchema, req.body);
      if (!p.ok) return reply.code(400).send({ error: p.error });
      if (store.slugTaken(p.value.slug, id)) return reply.code(409).send({ error: `Another endpoint already uses /v1/${p.value.slug}.` });
      const e = store.updateEndpoint(id, p.value);
      if (!e) return reply.code(404).send({ error: "No such endpoint." });
      renderer.forget(id);
      return withStats(e);
    });

    app.delete("/endpoints/:id", async (req, reply) => {
      const id = idParam(req);
      if (!store.deleteEndpoint(id)) return reply.code(404).send({ error: "No such endpoint." });
      renderer.forget(id);
      return { ok: true };
    });

    // The builder's live preview of an unsaved definition.
    app.post<{ Body: { definition?: unknown } }>("/preview", async (req, reply) => {
      const p = parse(definitionSchema, req.body?.definition);
      if (!p.ok) return reply.code(400).send({ error: p.error });
      const r = renderer.preview(p.value);
      return { output: r.output, errors: r.errors, fields: r.fields, fetchedAt: r.fetchedAt, stale: r.stale, missing: r.missing };
    });

    app.get("/endpoints/:id/keys", async (req) => store.listKeys(idParam(req)));

    app.post<{ Body: { label?: string } }>("/endpoints/:id/keys", async (req, reply) => {
      const id = idParam(req);
      if (!store.getEndpoint(id)) return reply.code(404).send({ error: "No such endpoint." });
      const label = String(req.body?.label ?? "").trim().slice(0, 100);
      if (!label) return reply.code(400).send({ error: "Give the key a label, like the app that will use it." });
      return store.createKey(id, label);
    });

    app.delete("/keys/:id", async (req, reply) => {
      if (!store.revokeKey(idParam(req))) return reply.code(404).send({ error: "No such key, or it's already revoked." });
      return { ok: true };
    });

    app.get<{ Querystring: { limit?: string } }>("/endpoints/:id/log", async (req) => store.listLog(idParam(req), Math.min(500, Math.max(1, Number(req.query.limit) || 50))));
  };
