// Saved histories: a source's response read as one row per time, kept long after the pull itself
// is pruned. A history says where the entries are, which field in each one says when, and which
// numbers to keep. Everything here is pure; the store does the saving.
//
// Two shapes of response are covered:
//   list   [{ "from": "2026-10-01T21:30Z", "intensity": { "actual": 120 } }, …]
//   names  { "2026-10-01 14:00:00": 812, "2026-10-01 15:00:00": 790 }   (each name is a time)

import { resolve, childPath } from "./paths.js";
import { OPS, OpError, argsWithDefaults, isPlainObject, type OpStep } from "./ops.js";
import { dateIn, midnightIn, wallClockIn } from "./placeholders.js";

export interface HistoryValue {
  /** Stable id, so a value can be renamed without losing what's saved. */
  id: string;
  name: string;
  /** Where the number is inside one entry, e.g. `$.intensity.actual`, or `$` for the entry itself. */
  path: string;
  /** Read this instead when `path` is empty, e.g. a forecast while the actual isn't in yet. */
  fallback?: string | null;
  ops: OpStep[];
}

export interface HistoryDef {
  /** Where the entries are, e.g. `$.data`. */
  rows: string;
  /** list: an array, one entry per item. names: an object whose names are times. */
  rowsKind: "list" | "names";
  /** Where the time is inside one entry, or null for "the entry's name" (names only). */
  time: string | null;
  values: HistoryValue[];
}

export interface Point {
  t: number;
  values: Record<string, number | null>;
}

// ---------------------------------------------------------------- reading times

export type TimeRead = { t: number; assumedZone?: boolean } | { error: string };

const NAIVE = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?)?$/;
const ZONED = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)\s*(Z|[+-]\d{2}:?\d{2})$/i;
// 1990 to 2200: anything outside is almost certainly not a timestamp (a price, an id, a count).
const PLAUSIBLE = (ms: number) => ms > 631_152_000_000 && ms < 7_258_118_400_000;

function fromNumber(n: number): TimeRead {
  const ms = Math.abs(n) < 1e11 ? n * 1000 : n;
  return PLAUSIBLE(ms) ? { t: Math.round(ms) } : { error: `${n} doesn't look like a time` };
}

/** Reads a time the way APIs tend to write one. Text with no time zone is read as clock time in `tz`. */
export function readTime(x: unknown, tz: string): TimeRead {
  if (x === null || x === undefined || x === "") return { error: "No time in this entry" };
  if (typeof x === "number") return Number.isFinite(x) ? fromNumber(x) : { error: "Not a time" };
  if (typeof x !== "string") return { error: "Not a time" };
  const s = x.trim();
  if (/^-?\d+(\.\d+)?$/.test(s)) return fromNumber(Number(s));
  let m = NAIVE.exec(s);
  if (m) {
    if (!Number.isFinite(Date.parse(`${m[1]}T00:00:00Z`))) return { error: `"${s}" isn't a real date` };
    const time = `${m[2] ?? "00"}:${m[3] ?? "00"}:${m[4] ?? "00"}${m[5] ?? ""}`;
    const t = wallClockIn(m[1], time, tz);
    return Number.isFinite(t) ? { t, assumedZone: true } : { error: `"${s}" isn't a time Relay can read` };
  }
  m = ZONED.exec(s);
  if (m) {
    const zone = m[3].toUpperCase() === "Z" ? "Z" : m[3].replace(/^([+-]\d{2}):?(\d{2})$/, "$1:$2");
    const t = Date.parse(`${m[1]}T${m[2]}${zone}`);
    return Number.isFinite(t) ? { t } : { error: `"${s}" isn't a time Relay can read` };
  }
  // Written-out dates, e.g. "Wed, 01 Oct 2026 21:30:00 GMT".
  if (/[a-z]/i.test(s) && /\d{4}/.test(s)) {
    const t = Date.parse(s);
    if (Number.isFinite(t) && PLAUSIBLE(t)) return { t };
  }
  return { error: `"${s.length > 40 ? s.slice(0, 37) + "…" : s}" isn't a time Relay can read` };
}

/** True when a value is very likely a time, for suggesting fields. Stricter than readTime. */
export function looksLikeTime(x: unknown, tz: string): boolean {
  if (typeof x === "number") return (x >= 1e9 && x < 1e10) || (x >= 1e12 && x < 1e13);
  if (typeof x !== "string" || !/\d{4}/.test(x)) return false;
  if (/^-?\d+(\.\d+)?$/.test(x.trim())) return looksLikeTime(Number(x), tz);
  return "t" in readTime(x, tz);
}

// ---------------------------------------------------------------- entries

export interface Entry {
  /** The entry's name, for an object whose names are times. */
  name?: string;
  item: unknown;
}

export function entriesOf(body: unknown, rows: string, kind: HistoryDef["rowsKind"]): Entry[] | string {
  const v = resolve(body, rows);
  if (kind === "list") return Array.isArray(v) ? v.map((item) => ({ item })) : "The list isn't in this response any more";
  return isPlainObject(v) ? Object.entries(v).map(([name, item]) => ({ name, item })) : "The entries aren't in this response any more";
}

// ---------------------------------------------------------------- finding where the entries are

export interface ListCandidate {
  rows: string;
  kind: HistoryDef["rowsKind"];
  /** Plain words for where it is, e.g. "data", or "the whole response". */
  label: string;
  count: number;
  /** The first entry, to show what one looks like. */
  sample: unknown;
}

function labelOf(path: string): string {
  if (path === "$") return "the whole response";
  return path
    .replace(/^\$\.?/, "")
    .replace(/\["((?:[^"\\]|\\.)*)"\]/g, (_m, k) => `.${k}`)
    .replace(/\[(\d+)\]/g, (_m, i) => `.item ${Number(i) + 1}`)
    .replace(/^\./, "")
    .split(".")
    .join(" › ");
}

/** Every list in a response, plus objects whose names read as times, biggest first. */
export function findLists(body: unknown, tz: string): ListCandidate[] {
  const out: ListCandidate[] = [];
  const walk = (v: unknown, path: string, depth: number) => {
    if (depth > 6) return;
    if (Array.isArray(v)) {
      if (v.length) out.push({ rows: path, kind: "list", label: labelOf(path), count: v.length, sample: v[0] });
      // Look inside the first item only: lists of lists share a shape.
      if (v.length && (Array.isArray(v[0]) || isPlainObject(v[0]))) walk(v[0], childPath(path, 0), depth + 1);
      return;
    }
    if (!isPlainObject(v)) return;
    const names = Object.keys(v);
    const timed = names.filter((n) => looksLikeTime(n, tz)).length;
    if (names.length >= 2 && timed / names.length >= 0.8) {
      out.push({ rows: path, kind: "names", label: labelOf(path), count: names.length, sample: v[names[0]] });
      return;
    }
    for (const n of names) walk(v[n], childPath(path, n), depth + 1);
  };
  walk(body, "$", 0);
  return out.sort((a, b) => b.count - a.count);
}

// ---------------------------------------------------------------- fields inside one entry

export interface EntryField {
  /** Path inside one entry; `$` is the entry itself. */
  path: string;
  label: string;
  /** The first few entries' values. */
  samples: unknown[];
  /** Share of entries where it's a number (or number-like text). */
  numeric: number;
  /** Share of entries where it's very likely a time. */
  timeLike: number;
}

const ordinal = (n: number) => `${n}${n % 10 === 1 && n % 100 !== 11 ? "st" : n % 10 === 2 && n % 100 !== 12 ? "nd" : n % 10 === 3 && n % 100 !== 13 ? "rd" : "th"}`;

function fieldLabel(path: string): string {
  if (path === "$") return "the value";
  return path
    .replace(/^\$\.?/, "")
    .replace(/\["((?:[^"\\]|\\.)*)"\]/g, (_m, k) => `.${k}`)
    .replace(/\[(\d+)\]/g, (_m, i) => `.${ordinal(Number(i) + 1)} item`)
    .replace(/^\./, "")
    .split(".")
    .join(" › ");
}

const isNumberLike = (x: unknown) => (typeof x === "number" && Number.isFinite(x)) || (typeof x === "string" && x.trim() !== "" && Number.isFinite(Number(x)));

/** The plain values inside the first entries (up to 50), with what kind of thing each one holds. */
export function entryFields(entries: Entry[], tz: string): EntryField[] {
  const sample = entries.slice(0, 50);
  const paths = new Map<string, unknown[]>();
  const walk = (v: unknown, path: string, depth: number, i: number) => {
    if (depth > 5) return;
    if (Array.isArray(v) || isPlainObject(v)) {
      const kids = Array.isArray(v) ? v.slice(0, 20).map((x, k) => [k, x] as const) : Object.entries(v);
      for (const [k, x] of kids) walk(x, childPath(path, k), depth + 1, i);
      return;
    }
    let list = paths.get(path);
    if (!list) paths.set(path, (list = []));
    list[i] = v;
  };
  sample.forEach((e, i) => walk(e.item, "$", 0, i));
  return [...paths.entries()].map(([path, vals]) => {
    const present = sample.map((_, i) => vals[i]);
    const n = present.length || 1;
    return {
      path,
      label: fieldLabel(path),
      samples: present.slice(0, 5).map((x) => (x === undefined ? null : x)),
      numeric: present.filter(isNumberLike).length / n,
      timeLike: present.filter((x) => looksLikeTime(x, tz)).length / n,
    };
  });
}

// ---------------------------------------------------------------- turning a response into points

function toNumber(x: unknown): number | null {
  if (typeof x === "number") return Number.isFinite(x) ? x : null;
  if (typeof x === "string" && x.trim() !== "" && Number.isFinite(Number(x))) return Number(x);
  return null;
}

const empty = (x: unknown) => x === null || x === undefined || x === "";

/** One value of one entry, after its fallback and steps. Returns why when there's no number. */
export function valueOf(v: HistoryValue, item: unknown, tz: string, now: number): { value: number | null; why?: string; usedFallback?: boolean } {
  let raw = resolve(item, v.path);
  let usedFallback = false;
  if (empty(raw) && v.fallback) {
    raw = resolve(item, v.fallback);
    usedFallback = true;
  }
  if (empty(raw)) return { value: null, why: "empty", usedFallback };
  let x: unknown = toNumber(raw);
  if (x === null) return { value: null, why: "not a number", usedFallback };
  for (const step of v.ops) {
    const meta = OPS[step.op];
    if (!meta || meta.kind !== "map") return { value: null, why: `"${meta?.label ?? step.op}" can't be used here` };
    try {
      x = meta.fn!(x, argsWithDefaults(step), { tz, now });
    } catch (e) {
      return { value: null, why: e instanceof OpError ? e.message : "a step failed" };
    }
  }
  const n = toNumber(x);
  return n === null ? { value: null, why: "not a number after the steps" } : { value: n, usedFallback };
}

export interface Extracted {
  points: Point[];
  /** Entries left out, grouped by reason, e.g. { "No time in this entry": 2 }. */
  skipped: Record<string, number>;
  entries: number;
  error?: string;
}

/** Reads every entry of one response into points, oldest first. A time seen twice keeps the later entry's numbers. */
export function extract(body: unknown, def: HistoryDef, tz: string, now = Date.now()): Extracted {
  const entries = entriesOf(body, def.rows, def.rowsKind);
  if (typeof entries === "string") return { points: [], skipped: {}, entries: 0, error: entries };
  const byTime = new Map<number, Point>();
  const skipped: Record<string, number> = {};
  const skip = (why: string) => (skipped[why] = (skipped[why] ?? 0) + 1);
  for (const e of entries) {
    const when = def.time === null ? readTime(e.name, tz) : readTime(resolve(e.item, def.time), tz);
    if ("error" in when) {
      skip(when.error.startsWith('"') ? "The time couldn't be read" : when.error);
      continue;
    }
    const values: Record<string, number | null> = {};
    let any = false;
    for (const v of def.values) {
      values[v.id] = valueOf(v, e.item, tz, now).value;
      if (values[v.id] !== null) any = true;
    }
    if (!any) {
      skip("No numbers in this entry");
      continue;
    }
    const prev = byTime.get(when.t);
    byTime.set(when.t, { t: when.t, values: prev ? mergeValues(prev.values, values) : values });
  }
  return { points: [...byTime.values()].sort((a, b) => a.t - b.t), skipped, entries: entries.length };
}

/** Newer numbers win, but a newer empty never wipes out a number already saved. */
export function mergeValues(old: Record<string, number | null>, next: Record<string, number | null>): Record<string, number | null> {
  const out = { ...old };
  for (const [k, v] of Object.entries(next)) if (v !== null || !(k in out)) out[k] = v;
  return out;
}

// ---------------------------------------------------------------- serving a range

export const RANGES = [
  { value: "today", label: "Today" },
  { value: "today_tomorrow", label: "Today and tomorrow" },
  { value: "around_24h", label: "24 hours either side of now" },
  { value: "next_48h", label: "The next 48 hours" },
  { value: "past_24h", label: "The last 24 hours" },
  { value: "past_7d", label: "The last 7 days" },
  { value: "past_30d", label: "The last 30 days" },
  { value: "past_365d", label: "The last year" },
  { value: "all", label: "Everything saved" },
] as const;
export type RangeId = (typeof RANGES)[number]["value"];

export const GROUPS = [
  { value: "none", label: "Every saved time" },
  { value: "hour", label: "One per hour" },
  { value: "day", label: "One per day" },
] as const;
export type GroupId = (typeof GROUPS)[number]["value"];

export const COMBINES = [
  { value: "avg", label: "Average" },
  { value: "min", label: "Lowest" },
  { value: "max", label: "Highest" },
  { value: "sum", label: "Total" },
  { value: "first", label: "First" },
  { value: "last", label: "Last" },
] as const;
export type CombineId = (typeof COMBINES)[number]["value"];

export const TIME_FORMATS = [
  { value: "local", label: "Local time, e.g. 2026-10-01T14:30:00+01:00" },
  { value: "utc", label: "UTC, e.g. 2026-10-01T13:30:00Z" },
  { value: "unix_ms", label: "Milliseconds since 1970" },
] as const;
export type TimeFormatId = (typeof TIME_FORMATS)[number]["value"];

const H = 3_600_000;
const D = 86_400_000;

function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T12:00:00Z`) + n * D).toISOString().slice(0, 10);
}

/** The window a range covers at `now`, as [from, to). */
export function rangeWindow(range: RangeId, now: number, tz: string): [number, number] {
  const today = dateIn(now, tz);
  const hourStart = Math.floor(now / H) * H;
  switch (range) {
    case "today": return [midnightIn(today, tz), midnightIn(addDays(today, 1), tz)];
    case "today_tomorrow": return [midnightIn(today, tz), midnightIn(addDays(today, 2), tz)];
    case "around_24h": return [now - 24 * H, now + 24 * H];
    case "next_48h": return [hourStart, hourStart + 48 * H];
    case "past_24h": return [now - 24 * H, now + 1];
    case "past_7d": return [now - 7 * D, now + 1];
    case "past_30d": return [now - 30 * D, now + 1];
    case "past_365d": return [now - 365 * D, now + 1];
    case "all": return [0, Number.MAX_SAFE_INTEGER];
  }
}

function combine(xs: number[], how: CombineId): number | null {
  if (!xs.length) return null;
  switch (how) {
    case "avg": return xs.reduce((s, x) => s + x, 0) / xs.length;
    case "min": return Math.min(...xs);
    case "max": return Math.max(...xs);
    case "sum": return xs.reduce((s, x) => s + x, 0);
    case "first": return xs[0];
    case "last": return xs[xs.length - 1];
  }
}

/** ISO 8601 with the zone's offset at that moment, e.g. 2026-10-01T14:30:00+01:00. */
export function localIso(t: number, tz: string): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(new Date(t))
      .map((x) => [x.type, x.value]),
  );
  const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  const off = Math.round((wall - Math.floor(t / 1000) * 1000) / 60_000);
  const sign = off < 0 ? "-" : "+";
  const hh = String(Math.floor(Math.abs(off) / 60)).padStart(2, "0");
  const mm = String(Math.abs(off) % 60).padStart(2, "0");
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${off === 0 ? "Z" : `${sign}${hh}:${mm}`}`;
}

export function formatTime(t: number, how: TimeFormatId, tz: string): string | number {
  if (how === "unix_ms") return t;
  if (how === "utc") return new Date(t).toISOString().replace(/\.000Z$/, "Z");
  return localIso(t, tz);
}

export interface SeriesOptions {
  group: GroupId;
  combine: CombineId;
  timeFormat: TimeFormatId;
  /** Which values to include, as [id, output name]. */
  values: [string, string][];
}

/** Points (oldest first) as output rows `{ time, <name>: number }`, grouped per hour or day if asked. */
export function seriesRows(points: Point[], opts: SeriesOptions, tz: string): Record<string, unknown>[] {
  const bucketOf = (t: number) => (opts.group === "hour" ? Math.floor(t / H) * H : opts.group === "day" ? midnightIn(dateIn(t, tz), tz) : t);
  const buckets = new Map<number, Point[]>();
  for (const p of points) {
    const b = bucketOf(p.t);
    let list = buckets.get(b);
    if (!list) buckets.set(b, (list = []));
    list.push(p);
  }
  const out: Record<string, unknown>[] = [];
  for (const [t, ps] of buckets) {
    const row: Record<string, unknown> = { time: formatTime(t, opts.timeFormat, tz) };
    for (const [id, name] of opts.values) {
      const xs = ps.map((p) => p.values[id]).filter((x): x is number => typeof x === "number");
      row[name] = opts.group === "none" ? (xs[0] ?? null) : combine(xs, opts.combine);
    }
    out.push(row);
  }
  return out;
}
