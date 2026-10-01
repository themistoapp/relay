import type { FastifyPluginAsync } from "fastify";
import type { AdminDeps } from "./server.js";
import { idParam } from "./server.js";
import { historySchema, parse } from "./schemas.js";
import { parsePath, resolve } from "../engine/paths.js";
import { entriesOf, entryFields, extract, findLists, readTime, valueOf, type HistoryDef, type HistoryValue } from "../engine/histories.js";
import { OPS } from "../engine/ops.js";

interface ExploreBody {
  rows?: string;
  rowsKind?: HistoryDef["rowsKind"];
  time?: string | null;
  values?: HistoryValue[];
}

const okPath = (p: unknown): p is string => {
  if (typeof p !== "string") return false;
  try {
    parsePath(p);
    return true;
  } catch {
    return false;
  }
};

// Keeps previews small: a sample entry can be a big object.
function trim(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return v.length > 80 ? v.slice(0, 77) + "…" : v;
  if (Array.isArray(v)) return depth > 2 ? `[${v.length} items]` : v.slice(0, 5).map((x) => trim(x, depth + 1)).concat(v.length > 5 ? [`… ${v.length - 5} more`] : []);
  if (v && typeof v === "object") {
    if (depth > 2) return "{…}";
    return Object.fromEntries(Object.entries(v).slice(0, 12).map(([k, x]) => [k, trim(x, depth + 1)]));
  }
  return v;
}

export const historiesRoutes =
  ({ store, env }: AdminDeps): FastifyPluginAsync =>
  async (app) => {
    const tz = env.TZ;

    app.get("/histories", async () => {
      const names = new Map(store.listSources().map((s) => [s.id, s.name]));
      return store.listHistories().map((h) => ({ ...h, sourceName: names.get(h.sourceId) ?? "(deleted source)" }));
    });

    app.get("/sources/:id/histories", async (req, reply) => {
      const id = idParam(req);
      if (!store.getSource(id)) return reply.code(404).send({ error: "No such source." });
      return store.listHistories(id).map((h) => ({ ...h, usedBy: store.endpointsUsingHistory(h.id) }));
    });

    // Everything the "Keep a history" steps show, worked out on the latest good pull. Each step
    // sends what's been chosen so far and gets back the next step's choices and a preview.
    app.post<{ Body: ExploreBody }>("/sources/:id/histories/explore", async (req, reply) => {
      const id = idParam(req);
      if (!store.getSource(id)) return reply.code(404).send({ error: "No such source." });
      const latest = store.latestOk(id);
      if (!latest) return { hasData: false };
      const body = latest.body;
      const q = req.body ?? {};
      const out: Record<string, unknown> = {
        hasData: true,
        fetchedAt: latest.t,
        tz,
        lists: findLists(body, tz).slice(0, 30).map((c) => ({ ...c, sample: trim(c.sample) })),
      };
      if (!okPath(q.rows) || (q.rowsKind !== "list" && q.rowsKind !== "names")) return out;

      const entries = entriesOf(body, q.rows, q.rowsKind);
      if (typeof entries === "string") return { ...out, error: entries };
      out.entries = entries.length;
      out.fields = entryFields(entries, tz);

      // Step 2: how the chosen time reads on the first few entries.
      const timeChosen = q.time === null ? q.rowsKind === "names" : okPath(q.time);
      if (!timeChosen) return out;
      const first = entries.slice(0, 6);
      out.times = first.map((e) => {
        const raw = q.time === null ? e.name : resolve(e.item, q.time as string);
        return { raw: trim(raw), ...readTime(raw, tz) };
      });
      const unreadable = entries.filter((e) => "error" in readTime(q.time === null ? e.name : resolve(e.item, q.time as string), tz)).length;
      out.unreadableTimes = unreadable;

      // Steps 3 and 4: the numbers, per entry and as they'd be saved.
      const values = (q.values ?? []).filter((v) => okPath(v.path) && (!v.fallback || okPath(v.fallback)) && v.ops.every((s) => OPS[s.op]?.kind === "map"));
      if (!values.length) return out;
      out.valuePreview = first.map((e) => Object.fromEntries(values.map((v) => [v.id, { raw: trim(resolve(e.item, v.path)), ...valueOf(v, e.item, tz, Date.now()) }])));
      const def: HistoryDef = { rows: q.rows, rowsKind: q.rowsKind, time: q.time ?? null, values };
      const x = extract(body, def, tz);
      out.result = {
        points: x.points.length,
        skipped: x.skipped,
        oldest: x.points[0]?.t ?? null,
        newest: x.points[x.points.length - 1]?.t ?? null,
        sample: x.points.slice(0, 200),
        fallbacks: Object.fromEntries(values.filter((v) => v.fallback).map((v) => [v.id, entries.filter((e) => valueOf(v, e.item, tz, Date.now()).usedFallback).length])),
      };
      // How many stored pulls a save would read back through.
      const counts = store.countSnapshots(id);
      out.storedPulls = counts.total - counts.errors;
      return out;
    });

    app.post("/sources/:id/histories", async (req, reply) => {
      const sourceId = idParam(req);
      if (!store.getSource(sourceId)) return reply.code(404).send({ error: "No such source." });
      const p = parse(historySchema, req.body);
      if (!p.ok) return reply.code(400).send({ error: p.error });
      const h = store.createHistory({ sourceId, ...p.value });
      const rebuilt = store.rebuildHistory(h.id, tz);
      return { history: { ...h, ...store.historyStats(h.id) }, rebuilt };
    });

    app.put("/histories/:id", async (req, reply) => {
      const id = idParam(req);
      const p = parse(historySchema, req.body);
      if (!p.ok) return reply.code(400).send({ error: p.error });
      const h = store.updateHistory(id, p.value);
      if (!h) return reply.code(404).send({ error: "No such history." });
      const rebuilt = store.rebuildHistory(id, tz);
      return { history: { ...h, ...store.historyStats(id) }, rebuilt };
    });

    app.post("/histories/:id/rebuild", async (req, reply) => {
      const id = idParam(req);
      if (!store.getHistory(id)) return reply.code(404).send({ error: "No such history." });
      return store.rebuildHistory(id, tz);
    });

    app.delete<{ Querystring: { force?: string } }>("/histories/:id", async (req, reply) => {
      const id = idParam(req);
      const usedBy = store.endpointsUsingHistory(id);
      if (usedBy.length && req.query.force !== "1") {
        return reply.code(409).send({ error: `Served by ${usedBy.map((e) => e.name).join(", ")}. Those endpoints will serve an empty list instead.`, usedBy });
      }
      if (!store.deleteHistory(id)) return reply.code(404).send({ error: "No such history." });
      return { ok: true };
    });

    app.get<{ Querystring: { from?: string; to?: string } }>("/histories/:id/points", async (req, reply) => {
      const id = idParam(req);
      if (!store.getHistory(id)) return reply.code(404).send({ error: "No such history." });
      const from = Number(req.query.from) || 0;
      const to = Number(req.query.to) || Number.MAX_SAFE_INTEGER;
      const all = store.points(id, from, to);
      // At most ~2000 points for a chart; the first and last are always included.
      const step = Math.max(1, Math.ceil(all.length / 2000));
      const points = all.filter((_, i) => i % step === 0 || i === all.length - 1);
      return { points, total: all.length };
    });
  };
