import { z } from "zod";
import { parsePath } from "../engine/paths.js";
import { OPS, CMPS } from "../engine/ops.js";
import type { OutNode } from "../engine/render.js";
import { COMBINES, GROUPS, RANGES, TIME_FORMATS } from "../engine/histories.js";

const path = z.string().max(500).refine((p) => {
  try {
    parsePath(p);
    return true;
  } catch {
    return false;
  }
}, "Not a valid path");

const opStep = z.object({
  op: z.string().refine((id) => id in OPS, "Unknown step"),
  args: z.record(z.string(), z.union([z.number(), z.string()])).optional(),
});

const field = z.object({
  id: z.string().min(1).max(64),
  name: z.string().max(100),
  sourceId: z.number().int(),
  path,
  mode: z.enum(["value", "row"]),
  ops: z.array(opStep).max(50),
});

const oneOf = (list: readonly { value: string }[]) => z.enum(list.map((x) => x.value) as [string, ...string[]]);

const key = z.string().min(1, "Every output key needs a name").max(100);
const cmp = z.enum(CMPS.map((c) => c.value) as [string, ...string[]]);

const outNode: z.ZodType<OutNode> = z.lazy(() =>
  z.discriminatedUnion("t", [
    z.object({ id: z.string(), t: z.literal("field"), key, fieldId: z.string() }),
    z.object({ id: z.string(), t: z.literal("object"), key, children: z.array(outNode).max(200) }),
    z.object({
      id: z.string(),
      t: z.literal("list"),
      key,
      sourceId: z.number().int(),
      over: path,
      children: z.array(outNode).max(200),
      sort: z.string().optional(),
      dir: z.enum(["asc", "desc"]).optional(),
      limit: z.number().int().min(0).max(100000).optional(),
      filter: z.object({ key: z.string(), cmp, value: z.string().max(500) }).nullable().optional(),
    }),
    z.object({
      id: z.string(),
      t: z.literal("history"),
      key,
      sourceId: z.number().int(),
      historyId: z.number().int(),
      range: oneOf(RANGES),
      group: oneOf(GROUPS),
      combine: oneOf(COMBINES),
      timeFormat: oneOf(TIME_FORMATS),
      values: z.array(z.string().max(64)).max(50).optional(),
    }),
  ]),
) as z.ZodType<OutNode>;

export const definitionSchema = z.object({
  fields: z.array(field).max(500),
  output: z.array(outNode).max(500),
});

const mapOpStep = opStep.refine((s) => OPS[s.op]?.kind === "map", "Only steps that change one value at a time can be used here");

export const historyDefSchema = z.object({
  rows: path,
  rowsKind: z.enum(["list", "names"]),
  time: path.nullable(),
  values: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        name: z.string().trim().min(1, "Every number needs a name").max(100),
        path,
        fallback: path.nullable().optional(),
        ops: z.array(mapOpStep).max(20),
      }),
    )
    .min(1, "Tick at least one number to keep")
    .max(50),
}).refine((d) => d.time !== null || d.rowsKind === "names", { message: "Choose which field says when", path: ["time"] });

export const historySchema = z.object({
  name: z.string().trim().min(1, "Give the history a name").max(100),
  definition: historyDefSchema,
  keepDays: z.number().int().min(1).max(36500).nullable(),
});

export const slugSchema = z
  .string()
  .min(1, "Give the endpoint a path")
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase letters, numbers and single dashes, e.g. fuel-prices");

export const endpointSchema = z.object({
  slug: slugSchema,
  name: z.string().min(1).max(100),
  definition: definitionSchema,
  enabled: z.boolean(),
  access: z.enum(["public", "key"]),
  corsOrigins: z
    .array(z.string().refine((o) => o === "*" || /^https?:\/\/[^/\s]+$/.test(o.replace(/\/$/, "")), "Origins look like https://example.com (no path)"))
    .max(50),
  rateLimit: z.number().int().min(1).max(100000),
  rateWindow: z.enum(["minute", "hour"]),
  rateBy: z.enum(["key", "ip"]),
  cacheTtl: z.number().int().min(0).max(86400),
});

export const sourceSchema = z.object({
  name: z.string().trim().min(1, "Give the source a name").max(100),
  method: z.enum(["GET", "POST", "PUT", "PATCH"]),
  url: z.string().url("Enter a full URL, starting http:// or https://").refine((u) => /^https?:\/\//i.test(u), "Only http and https URLs"),
  headers: z.array(z.object({ key: z.string().max(200), value: z.string().max(4000) })).max(30),
  body: z.string().max(100_000).nullable(),
  authType: z.enum(["none", "bearer", "header", "basic", "query"]),
  authName: z.string().max(200),
  authSecret: z.string().max(10_000).nullable().optional(),
  schedule: z.string().min(1).max(100),
  keepDays: z.number().int().min(1).max(3650).nullable(),
  keepCount: z.number().int().min(1).max(10_000_000).nullable(),
  timeoutMs: z.number().int().min(1000).max(120_000),
  enabled: z.boolean(),
});

export function parse<T>(schema: z.ZodType<T>, body: unknown): { ok: true; value: T } | { ok: false; error: string } {
  const r = schema.safeParse(body);
  if (r.success) return { ok: true, value: r.data };
  const i = r.error.issues[0];
  return { ok: false, error: `${i.path.length ? i.path.join(".") + ": " : ""}${i.message}` };
}
