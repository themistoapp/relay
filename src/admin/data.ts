import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { AdminDeps } from "./server.js";
import { endpointSchema, parse, sourceSchema } from "./schemas.js";

const importSchema = z.object({
  relay: z.literal(1),
  sources: z.array(sourceSchema.omit({ authSecret: true }).extend({ id: z.number().int() })),
  endpoints: z.array(endpointSchema),
});

export const dataRoutes =
  ({ store, scheduler }: AdminDeps): FastifyPluginAsync =>
  async (app) => {
    app.get("/tables", async () => store.tables());

    app.get<{ Params: { name: string }; Querystring: { page?: string; limit?: string } }>("/tables/:name", async (req, reply) => {
      const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
      const page = Math.max(0, Number(req.query.page) || 0);
      const t = store.tableRows(req.params.name, page, limit);
      if (!t) return reply.code(404).send({ error: "No such table." });
      return { ...t, page, limit };
    });

    app.get("/config/export", async (_req, reply) => {
      reply.header("Content-Disposition", `attachment; filename="relay-config-${new Date().toISOString().slice(0, 10)}.json"`);
      return reply.type("application/json").send(JSON.stringify(store.exportConfig(), null, 2));
    });

    app.post("/config/import", async (req, reply) => {
      const p = parse(importSchema, req.body);
      if (!p.ok) return reply.code(400).send({ error: `That file isn't a Relay export (${p.error}).` });
      const r = store.importConfig(p.value);
      for (const s of store.listSources()) scheduler.schedule(s);
      return r;
    });
  };
