import type { FastifyPluginAsync } from "fastify";
import type { AdminDeps } from "./server.js";
import { idParam } from "./server.js";
import { parse, sourceSchema } from "./schemas.js";
import { fetchOnce } from "../puller/fetcher.js";
import { nextRuns, validateCron } from "../puller/scheduler.js";
import { inferShape } from "../engine/shape.js";
import type { Source } from "../db/store.js";

export const sourceRoutes =
  ({ store, scheduler, env }: AdminDeps): FastifyPluginAsync =>
  async (app) => {
    const maxBytes = env.MAX_RESPONSE_MB * 1024 * 1024;
    const withStats = (s: Source) => ({ ...s, nextRun: scheduler.nextRun(s.id), counts: store.countSnapshots(s.id) });

    app.get("/sources", async () => store.listSources().map(withStats));

    app.get("/sources/:id", async (req, reply) => {
      const s = store.getSource(idParam(req));
      if (!s) return reply.code(404).send({ error: "No such source." });
      return { ...withStats(s), usedBy: store.endpointsUsingSource(s.id) };
    });

    app.post("/sources", async (req, reply) => {
      const p = parse(sourceSchema, req.body);
      if (!p.ok) return reply.code(400).send({ error: p.error });
      const cronError = validateCron(p.value.schedule, env.TZ);
      if (cronError) return reply.code(400).send({ error: `Schedule: ${cronError}` });
      const s = store.createSource(p.value);
      scheduler.schedule(s);
      return withStats(s);
    });

    app.put("/sources/:id", async (req, reply) => {
      const p = parse(sourceSchema, req.body);
      if (!p.ok) return reply.code(400).send({ error: p.error });
      const cronError = validateCron(p.value.schedule, env.TZ);
      if (cronError) return reply.code(400).send({ error: `Schedule: ${cronError}` });
      const s = store.updateSource(idParam(req), p.value);
      if (!s) return reply.code(404).send({ error: "No such source." });
      scheduler.schedule(s);
      return withStats(s);
    });

    app.delete<{ Querystring: { force?: string } }>("/sources/:id", async (req, reply) => {
      const id = idParam(req);
      const usedBy = store.endpointsUsingSource(id);
      if (usedBy.length && req.query.force !== "1") {
        return reply.code(409).send({ error: `Used by ${usedBy.map((e) => e.name).join(", ")}. Those endpoints will stop serving its fields.`, usedBy });
      }
      scheduler.unschedule(id);
      if (!store.deleteSource(id)) return reply.code(404).send({ error: "No such source." });
      return { ok: true };
    });

    // Runs a request without saving anything, for the "Test request" button. An unsaved form can
    // reuse a saved source's token by passing its id with authSecret left out.
    app.post<{ Body: Record<string, unknown> & { id?: number } }>("/sources/test", async (req, reply) => {
      const p = parse(sourceSchema, { ...req.body, name: req.body?.name || "test" });
      if (!p.ok) return reply.code(400).send({ error: p.error });
      const v = p.value;
      let secret: string | null = v.authSecret ?? null;
      if (v.authSecret === undefined && typeof req.body.id === "number") secret = store.getSourceSecret(req.body.id);
      const r = await fetchOnce({ ...v, authSecret: v.authType === "none" ? null : secret }, maxBytes);
      return { status: r.status, ok: r.ok, durationMs: r.durationMs, bytes: r.bytes, error: r.error ?? null, body: r.json ?? null, shape: r.ok ? inferShape(r.json) : null };
    });

    app.post("/sources/:id/pull", async (req, reply) => {
      const id = idParam(req);
      if (!store.getSource(id)) return reply.code(404).send({ error: "No such source." });
      const snapshot = await scheduler.pull(id);
      return { snapshot };
    });

    app.get("/sources/:id/latest", async (req, reply) => {
      const id = idParam(req);
      if (!store.getSource(id)) return reply.code(404).send({ error: "No such source." });
      const latest = store.latestOk(id);
      if (!latest) return { snapshot: null, body: null, shape: null };
      const body = latest.body;
      return { snapshot: store.getSnapshot(latest.snapshotId), body, shape: inferShape(body) };
    });

    app.post<{ Body: { schedule?: string } }>("/schedule/check", async (req) => {
      const expr = String(req.body?.schedule ?? "");
      const error = validateCron(expr, env.TZ);
      return { error, next: error ? [] : nextRuns(expr, env.TZ, 3) };
    });
  };
