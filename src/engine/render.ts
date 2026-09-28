// Turns an endpoint definition plus each source's latest pull (and history) into the JSON the
// endpoint serves. Pure: the caller supplies snapshots through RenderContext.

import { resolve, rowBase, relativeToRow } from "./paths.js";
import { OPS, OpError, argsWithDefaults, comparable, compare, durationMs, mapDeep, type Cmp, type OpStep } from "./ops.js";

export interface FieldDef {
  id: string;
  name: string;
  sourceId: number;
  /** Absolute path in the source's response, e.g. `$.stations[*].prices.E10`. */
  path: string;
  /** value: one value for the whole response (lists stay lists until a step summarises them).
   *  row: one value per item of the list the path runs through, used inside an output list. */
  mode: "value" | "row";
  ops: OpStep[];
}

export type OutNode =
  | { id: string; t: "field"; key: string; fieldId: string }
  | { id: string; t: "object"; key: string; children: OutNode[] }
  | {
      id: string;
      t: "list";
      key: string;
      sourceId: number;
      /** The list to repeat over, e.g. `$.stations[*]`. */
      over: string;
      children: OutNode[];
      sort?: string;
      dir?: "asc" | "desc";
      limit?: number;
      filter?: { key: string; cmp: Cmp; value: string } | null;
    };

export interface EndpointDefinition {
  fields: FieldDef[];
  output: OutNode[];
}

export interface Snapshot {
  t: number;
  body: unknown;
  /** Identifies the body (e.g. its row id), used to memoise work across identical pulls. */
  key: string;
}

export interface HistorySource {
  /** Successful pulls with t in [from, to], oldest first, and the last one at or before `from`
   *  (the value at the start of the window). */
  window(sourceId: number, from: number, to: number): { before?: Snapshot; points: Snapshot[] };
  /** The successful pull `n` pulls before the latest one at or before `at`. */
  back(sourceId: number, n: number, at: number): Snapshot | undefined;
}

export interface RenderContext {
  latest: Map<number, Snapshot>;
  history?: HistorySource;
  now: number;
  tz: string;
  memo?: Map<string, unknown>;
}

export interface FieldError {
  fieldId: string;
  name: string;
  message: string;
}

export class RenderError extends Error {}

function latestFor(field: FieldDef, ctx: RenderContext): Snapshot {
  const s = ctx.latest.get(field.sourceId);
  if (!s) throw new RenderError(`No data from this field's source yet`);
  return s;
}

function applyMap(v: unknown, step: OpStep, ctx: RenderContext): unknown {
  const meta = OPS[step.op];
  const a = argsWithDefaults(step);
  const env = { tz: ctx.tz, now: ctx.now };
  return mapDeep(v, (x) => (x === null || x === undefined) && meta.id !== "default" ? x : meta.fn!(x, a, env));
}

function applyPick(field: FieldDef, snap: Snapshot, v: unknown, step: OpStep): unknown {
  const base = rowBase(field.path);
  if (!base) throw new OpError(`"Pick by" needs a field inside a list`);
  const a = argsWithDefaults(step);
  const by = String(a.by || "");
  if (!by) throw new OpError(`Choose which field "pick by" compares`);
  const rows = resolve(snap.body, base);
  if (!Array.isArray(rows) || !Array.isArray(v) || rows.length !== v.length) {
    throw new OpError(`"Pick by" has to come before steps that change the list`);
  }
  let best = -1;
  let bestKey: number | string | undefined;
  rows.forEach((row, i) => {
    const k = comparable(resolve(row, by));
    if (k === undefined) return;
    if (best < 0 || (a.which === "min" ? k < bestKey! : k > bestKey!)) {
      best = i;
      bestKey = k;
    }
  });
  return best < 0 ? null : v[best];
}

/** Evaluates a value-mode field on one snapshot, running its first `upto` steps. */
export function evalField(field: FieldDef, snap: Snapshot, ctx: RenderContext, upto = field.ops.length): unknown {
  const memoKey = `${field.id}|${JSON.stringify(field.ops.slice(0, upto))}|${field.path}|${snap.key}`;
  if (ctx.memo?.has(memoKey)) return ctx.memo.get(memoKey);
  let v = resolve(snap.body, field.path);
  for (let k = 0; k < upto; k++) {
    const step = field.ops[k];
    const meta = OPS[step.op];
    if (!meta) throw new OpError(`Unknown step "${step.op}"`);
    if (meta.kind === "map") v = applyMap(v, step, ctx);
    else if (meta.kind === "list") v = meta.fn!(v, argsWithDefaults(step), { tz: ctx.tz, now: ctx.now });
    else if (meta.kind === "pick") v = applyPick(field, snap, v, step);
    else v = applyHistory(field, snap, v, k, ctx);
  }
  ctx.memo?.set(memoKey, v);
  return v;
}

function histNumber(x: unknown): number {
  if (typeof x !== "number" || !Number.isFinite(x)) {
    throw new OpError(`History steps need a single number. Add a step like "Lowest" or "First" before it`);
  }
  return x;
}

function applyHistory(field: FieldDef, snap: Snapshot, v: unknown, k: number, ctx: RenderContext): unknown {
  if (!ctx.history) throw new OpError("History isn't available here");
  const step = field.ops[k];
  const a = argsWithDefaults(step);
  const current = histNumber(v);
  const valueAt = (s: Snapshot) => {
    try {
      const x = evalField(field, s, ctx, k);
      return typeof x === "number" && Number.isFinite(x) ? x : undefined;
    } catch {
      return undefined;
    }
  };
  if (step.op === "ago") {
    const n = Math.max(1, Math.trunc(Number(a.n) || 1));
    const past = ctx.history.back(field.sourceId, n, snap.t);
    if (!past) throw new OpError(`There aren't ${n} earlier pulls yet`);
    const x = valueAt(past);
    if (x === undefined) throw new OpError(`No number ${n} pulls ago`);
    return x;
  }
  const w = ctx.history.window(field.sourceId, snap.t - durationMs(String(a.window)), snap.t);
  // The current pull is `current`; the window is every pull before it.
  const points = w.points.filter((p) => p.t < snap.t).map(valueAt).filter((x): x is number => x !== undefined);
  const before = w.before ? valueAt(w.before) : undefined;
  return OPS[step.op].hist!(current, points, before, a);
}

/** Evaluates a row-mode field on one item of its list. */
export function evalFieldOnRow(field: FieldDef, item: unknown, ctx: RenderContext): unknown {
  let v = resolve(item, relativeToRow(field.path));
  for (const step of field.ops) {
    const meta = OPS[step.op];
    if (!meta) throw new OpError(`Unknown step "${step.op}"`);
    if (meta.kind === "map") v = applyMap(v, step, ctx);
    else if (meta.kind === "list") v = meta.fn!(v, argsWithDefaults(step), { tz: ctx.tz, now: ctx.now });
    else throw new OpError(`"${meta.label}" can't be used per item. Switch this field to "Whole list"`);
  }
  return v;
}

interface RowScope {
  sourceId: number;
  over: string;
  item: unknown;
}

export function renderOutput(def: EndpointDefinition, ctx: RenderContext): { output: Record<string, unknown>; errors: FieldError[] } {
  const fields = new Map(def.fields.map((f) => [f.id, f]));
  const errors: FieldError[] = [];
  const seen = new Set<string>();
  const fail = (f: FieldDef | undefined, id: string, message: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    errors.push({ fieldId: id, name: f?.name ?? id, message });
  };
  const valueCache = new Map<string, unknown>();

  function fieldValue(fieldId: string, row?: RowScope): unknown {
    const f = fields.get(fieldId);
    if (!f) {
      fail(undefined, fieldId, "This field was removed");
      return null;
    }
    try {
      if (f.mode === "row") {
        const base = rowBase(f.path);
        if (row && row.sourceId === f.sourceId && row.over === base) return evalFieldOnRow(f, row.item, ctx);
        // Outside its list, a per-item field gives the list of every item's value.
        const items = resolve(latestFor(f, ctx).body, base ?? "$");
        return Array.isArray(items) ? items.map((it) => evalFieldOnRow(f, it, ctx)) : null;
      }
      if (!valueCache.has(f.id)) valueCache.set(f.id, evalField(f, latestFor(f, ctx), ctx));
      return valueCache.get(f.id);
    } catch (e) {
      fail(f, f.id, (e as Error).message);
      return null;
    }
  }

  function renderNodes(nodes: OutNode[], row?: RowScope): Record<string, unknown> {
    const o: Record<string, unknown> = {};
    for (const n of nodes) {
      if (n.t === "field") o[n.key] = normalise(fieldValue(n.fieldId, row));
      else if (n.t === "object") o[n.key] = renderNodes(n.children, row);
      else o[n.key] = renderList(n);
    }
    return o;
  }

  function renderList(n: Extract<OutNode, { t: "list" }>): unknown[] {
    const snap = ctx.latest.get(n.sourceId);
    if (!snap) {
      fail(undefined, n.id, `List "${n.key}": no data from its source yet`);
      return [];
    }
    const items = resolve(snap.body, n.over);
    if (!Array.isArray(items)) {
      fail(undefined, n.id, `List "${n.key}": ${n.over} isn't a list in the latest response`);
      return [];
    }
    let rows = items.map((item) => renderNodes(n.children, { sourceId: n.sourceId, over: n.over, item }));
    if (n.filter && n.filter.key) rows = rows.filter((r) => compare(r[n.filter!.key], n.filter!.cmp, n.filter!.value));
    if (n.sort) {
      const d = n.dir === "desc" ? -1 : 1;
      const key = n.sort;
      rows.sort((x, y) => {
        const p = comparable(x[key]), q = comparable(y[key]);
        if (p === undefined) return 1;
        if (q === undefined) return -1;
        return (p < q ? -1 : p > q ? 1 : 0) * d;
      });
    }
    if (n.limit && n.limit > 0) rows = rows.slice(0, n.limit);
    return rows;
  }

  return { output: renderNodes(def.output), errors };
}

// Floating-point noise like 1.3990000000000002 is never what anyone wants to serve.
function normalise(v: unknown): unknown {
  if (typeof v === "number") return Number.isFinite(v) ? Number(v.toPrecision(12)) : null;
  if (Array.isArray(v)) return v.map(normalise);
  if (v === undefined) return null;
  return v;
}

export interface FieldPreview {
  input: unknown;
  output: unknown;
  error?: string;
  /** For per-item fields: the preview uses the list's first item. */
  row?: boolean;
}

/** What each field looks like before and after its steps, on the latest pull. */
export function previewFields(def: EndpointDefinition, ctx: RenderContext): Record<string, FieldPreview> {
  const out: Record<string, FieldPreview> = {};
  for (const f of def.fields) {
    const snap = ctx.latest.get(f.sourceId);
    if (!snap) {
      out[f.id] = { input: null, output: null, error: "No data from this source yet" };
      continue;
    }
    try {
      if (f.mode === "row") {
        const items = resolve(snap.body, rowBase(f.path) ?? "$");
        const first = Array.isArray(items) ? items[0] : undefined;
        out[f.id] = { input: normalise(resolve(first, relativeToRow(f.path))), output: normalise(evalFieldOnRow(f, first, ctx)), row: true };
      } else {
        out[f.id] = { input: normalise(resolve(snap.body, f.path)), output: normalise(evalField(f, snap, ctx)) };
      }
    } catch (e) {
      out[f.id] = { input: normalise(resolve(snap.body, f.path)), output: null, error: (e as Error).message, row: f.mode === "row" };
    }
  }
  return out;
}
