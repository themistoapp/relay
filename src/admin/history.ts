import type { FastifyPluginAsync } from "fastify";
import type { AdminDeps } from "./server.js";
import { idParam } from "./server.js";
import { parsePath } from "../engine/paths.js";

type Filter = "all" | "changed" | "errors";
const asFilter = (f?: string): Filter => (f === "changed" || f === "errors" ? f : "all");
const asTime = (v?: string) => (v && Number.isFinite(Number(v)) ? Number(v) : undefined);

export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const filename = (name: string, what: string, ext: string) =>
  `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "source"}-${what}-${new Date().toISOString().slice(0, 10)}.${ext}`;

export const historyRoutes =
  ({ store, scheduler }: AdminDeps): FastifyPluginAsync =>
  async (app) => {
    // Keyset pagination: pass the last row's `fetchedAt:id` as `before` for the next page.
    app.get<{ Querystring: { before?: string; limit?: string; filter?: string; from?: string; to?: string } }>("/sources/:id/snapshots", async (req) => {
      const q = req.query;
      const [t, id] = (q.before ?? "").split(":").map(Number);
      const limit = Math.min(200, Math.max(1, Number(q.limit) || 50));
      const rows = store.listSnapshots(idParam(req), {
        before: Number.isFinite(t) && Number.isFinite(id) && q.before ? { t, id } : undefined,
        limit,
        filter: asFilter(q.filter),
        from: asTime(q.from),
        to: asTime(q.to),
      });
      const last = rows[rows.length - 1];
      return { rows, next: rows.length === limit && last ? `${last.fetchedAt}:${last.id}` : null };
    });

    app.get("/snapshots/:id", async (req, reply) => {
      const s = store.getSnapshot(idParam(req));
      if (!s) return reply.code(404).send({ error: "No such pull." });
      const prev = store.previousOk(s);
      return {
        snapshot: s,
        body: s.bodyId ? store.loadBody(s.bodyId) : null,
        previous: prev ? { snapshot: prev, body: prev.bodyId ? store.loadBody(prev.bodyId) : null } : null,
      };
    });

    app.delete("/snapshots/:id", async (req, reply) => {
      const id = idParam(req);
      const s = store.getSnapshot(id);
      if (!s) return reply.code(404).send({ error: "No such pull." });
      const latest = store.latestOk(s.sourceId);
      if (latest?.snapshotId === id) return reply.code(409).send({ error: "That's the latest good pull, which endpoints are serving. It can't be deleted." });
      store.deleteSnapshot(id);
      return { ok: true };
    });

    app.get<{ Querystring: { path?: string; from?: string; to?: string } }>("/sources/:id/series", async (req, reply) => {
      const path = req.query.path ?? "";
      try {
        parsePath(path);
      } catch (e) {
        return reply.code(400).send({ error: (e as Error).message });
      }
      const to = asTime(req.query.to) ?? Date.now();
      const from = asTime(req.query.from) ?? to - 86_400_000;
      return { points: store.series(idParam(req), path, from, to) };
    });

    app.get<{ Querystring: { what?: string; format?: string; filter?: string; path?: string; from?: string; to?: string } }>("/sources/:id/export", async (req, reply) => {
      const id = idParam(req);
      const src = store.getSource(id);
      if (!src) return reply.code(404).send({ error: "No such source." });
      const q = req.query;
      const csv = q.format === "csv";
      const from = asTime(q.from);
      const to = asTime(q.to);

      if (q.what === "series") {
        try {
          parsePath(q.path ?? "");
        } catch (e) {
          return reply.code(400).send({ error: (e as Error).message });
        }
        const points = store.series(id, q.path!, from ?? 0, to ?? Date.now(), 1_000_000);
        reply.header("Content-Disposition", `attachment; filename="${filename(src.name, "series", csv ? "csv" : "json")}"`);
        if (!csv) return reply.type("application/json").send(JSON.stringify(points.map((p) => ({ fetched_at: new Date(p.t).toISOString(), value: p.v }))));
        return reply.type("text/csv; charset=utf-8").send("fetched_at,value\n" + points.map((p) => `${new Date(p.t).toISOString()},${csvCell(p.v)}`).join("\n") + "\n");
      }

      const rows = store.listSnapshots(id, { limit: 50_000, filter: asFilter(q.filter), from, to }).reverse();
      const out = rows.map((s) => ({
        fetched_at: new Date(s.fetchedAt).toISOString(),
        status: s.status,
        ok: s.ok,
        duration_ms: s.durationMs,
        bytes: s.bytes,
        changed: s.changed,
        error: s.error,
        body: s.bodyId ? store.loadBody(s.bodyId) : null,
      }));
      reply.header("Content-Disposition", `attachment; filename="${filename(src.name, "pulls", csv ? "csv" : "json")}"`);
      if (!csv) return reply.type("application/json").send(JSON.stringify(out));
      const cols = ["fetched_at", "status", "ok", "duration_ms", "bytes", "changed", "error", "body"] as const;
      return reply.type("text/csv; charset=utf-8").send(cols.join(",") + "\n" + out.map((r) => cols.map((c) => csvCell(r[c])).join(",")).join("\n") + "\n");
    });

    app.post("/sources/:id/prune", async (req, reply) => {
      const id = idParam(req);
      if (!store.getSource(id)) return reply.code(404).send({ error: "No such source." });
      return { deleted: store.prune(id) };
    });

    app.get("/storage", async () => ({ ...store.storage(), backups: scheduler.listBackups() }));

    app.post("/backup", async () => ({ file: scheduler.backup() }));
  };
