// The transform steps a field can run through, in order. Every op is a pure function: no eval, no
// user code. The metadata (group, args, describe) also drives the Transform step's UI.

export type OpKind = "map" | "list" | "pick" | "history";
export type Args = Record<string, number | string>;

export interface OpStep {
  op: string;
  args?: Args;
}

export interface ArgSpec {
  name: string;
  label: string;
  type: "number" | "text" | "select" | "rowpath";
  default: number | string;
  options?: { value: string; label: string }[];
}

export interface OpEnv {
  tz: string;
  now: number;
}

export interface OpMeta {
  id: string;
  label: string;
  group: "Maths" | "List" | "Text & dates" | "History";
  kind: OpKind;
  help: string;
  args: ArgSpec[];
  describe: (a: Args) => string;
  /** map: applied to every value; list: applied to the whole list. */
  fn?: (v: any, a: Args, env: OpEnv) => unknown;
  /** history: current value plus the window's values (oldest first) and the value just before it. */
  hist?: (current: number, points: number[], before: number | undefined, a: Args) => number;
}

export class OpError extends Error {}

export const WINDOWS = [
  { value: "15m", label: "15 min" },
  { value: "1h", label: "1 hour" },
  { value: "6h", label: "6 hours" },
  { value: "24h", label: "24 hours" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
];
const WINDOW_LABEL = Object.fromEntries(WINDOWS.map((w) => [w.value, w.label]));

export function durationMs(d: string): number {
  const m = /^(\d+)(m|h|d)$/.exec(String(d));
  if (!m) throw new OpError(`Unknown time window: ${d}`);
  return Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "m" | "h" | "d"];
}

const num = (a: Args, k: string) => {
  const v = Number(a[k]);
  if (!Number.isFinite(v)) throw new OpError(`"${k}" must be a number`);
  return v;
};
const str = (a: Args, k: string) => String(a[k] ?? "");

function needNumber(x: unknown, op: string): number {
  if (typeof x === "number" && Number.isFinite(x)) return x;
  if (typeof x === "string" && x.trim() !== "" && Number.isFinite(Number(x))) return Number(x);
  throw new OpError(`"${op}" needs a number, got ${JSON.stringify(x)}`);
}

function numbers(v: unknown): number[] {
  const arr = Array.isArray(v) ? v : [v];
  return arr.filter((x) => x !== null && x !== undefined).map((x) => needNumber(x, "this step"));
}

export function toDate(x: unknown): Date {
  let ms: number;
  if (typeof x === "number") ms = Math.abs(x) < 1e11 ? x * 1000 : x;
  else if (typeof x === "string" && /^-?\d+(\.\d+)?$/.test(x.trim())) {
    const n = Number(x);
    ms = Math.abs(n) < 1e11 ? n * 1000 : n;
  } else if (typeof x === "string") ms = Date.parse(x);
  else ms = NaN;
  if (!Number.isFinite(ms)) throw new OpError(`Not a date: ${JSON.stringify(x)}`);
  return new Date(ms);
}

function dateParts(d: Date, tz: string) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return p as Record<"year" | "month" | "day" | "hour" | "minute" | "second", string>;
}

function relative(ms: number, now: number): string {
  const s = Math.round((now - ms) / 1000);
  const abs = Math.abs(s);
  const [n, unit] = abs < 60 ? [abs, "sec"] : abs < 3600 ? [Math.round(abs / 60), "min"] : abs < 86400 ? [Math.round(abs / 3600), "hour"] : [Math.round(abs / 86400), "day"];
  const u = n === 1 || unit === "sec" || unit === "min" ? unit : unit + "s";
  return s >= 0 ? `${n} ${u} ago` : `in ${n} ${u}`;
}

/** Compare values that might be numbers, numeric strings or dates. */
export function comparable(x: unknown): number | string | undefined {
  if (x === null || x === undefined) return undefined;
  if (typeof x === "number") return x;
  if (typeof x === "boolean") return x ? 1 : 0;
  const s = String(x);
  if (s.trim() !== "" && Number.isFinite(Number(s))) return Number(s);
  if (/\d{4}-\d{2}-\d{2}/.test(s)) {
    const t = Date.parse(s);
    if (Number.isFinite(t)) return t;
  }
  return s;
}

export type Cmp = ">" | ">=" | "<" | "<=" | "==" | "!=" | "contains";
export const CMPS: { value: Cmp; label: string }[] = [
  { value: ">", label: "is more than" },
  { value: ">=", label: "is at least" },
  { value: "<", label: "is less than" },
  { value: "<=", label: "is at most" },
  { value: "==", label: "equals" },
  { value: "!=", label: "doesn't equal" },
  { value: "contains", label: "contains" },
];

export function compare(x: unknown, cmp: Cmp, value: string): boolean {
  if (cmp === "contains") return String(x ?? "").toLowerCase().includes(value.toLowerCase());
  const a = comparable(x);
  const b = comparable(value);
  if (a === undefined) return cmp === "!=";
  if (cmp === "==") return a === b || String(x) === value;
  if (cmp === "!=") return !(a === b || String(x) === value);
  if (b === undefined) return false;
  if (typeof a !== typeof b) return false;
  return cmp === ">" ? a > b : cmp === ">=" ? a >= b : cmp === "<" ? a < b : a <= b;
}

const round = (x: number, dp: number) => {
  const f = 10 ** dp;
  return Math.round((x + Number.EPSILON * Math.sign(x)) * f) / f;
};

const DATE_FORMATS = [
  { value: "datetime", label: "2026-09-28 09:15" },
  { value: "date", label: "2026-09-28" },
  { value: "time", label: "09:15" },
  { value: "iso", label: "ISO 8601 (UTC)" },
  { value: "unix", label: "Unix seconds" },
  { value: "unix_ms", label: "Unix milliseconds" },
  { value: "relative", label: "5 min ago" },
];

const ops: OpMeta[] = [
  // ---- Maths: applied to every number ----
  { id: "add", label: "Add", group: "Maths", kind: "map", help: "Add a number.", args: [{ name: "n", label: "Add", type: "number", default: 1 }], describe: (a) => `+ ${a.n}`, fn: (x, a) => needNumber(x, "add") + num(a, "n") },
  { id: "subtract", label: "Subtract", group: "Maths", kind: "map", help: "Subtract a number.", args: [{ name: "n", label: "Subtract", type: "number", default: 1 }], describe: (a) => `− ${a.n}`, fn: (x, a) => needNumber(x, "subtract") - num(a, "n") },
  { id: "multiply", label: "Multiply", group: "Maths", kind: "map", help: "Multiply by a number.", args: [{ name: "n", label: "Multiply by", type: "number", default: 100 }], describe: (a) => `× ${a.n}`, fn: (x, a) => needNumber(x, "multiply") * num(a, "n") },
  {
    id: "divide", label: "Divide", group: "Maths", kind: "map", help: "Divide by a number.", args: [{ name: "n", label: "Divide by", type: "number", default: 100 }], describe: (a) => `÷ ${a.n}`,
    fn: (x, a) => {
      const n = num(a, "n");
      if (n === 0) throw new OpError("Can't divide by 0");
      return needNumber(x, "divide") / n;
    },
  },
  { id: "round", label: "Round", group: "Maths", kind: "map", help: "Round to a number of decimal places.", args: [{ name: "dp", label: "Decimal places", type: "number", default: 2 }], describe: (a) => `round to ${a.dp}dp`, fn: (x, a) => round(needNumber(x, "round"), Math.max(0, Math.min(10, Math.trunc(num(a, "dp"))))) },
  { id: "floor", label: "Round down", group: "Maths", kind: "map", help: "Round down to a whole number.", args: [], describe: () => "round down", fn: (x) => Math.floor(needNumber(x, "round down")) },
  { id: "ceil", label: "Round up", group: "Maths", kind: "map", help: "Round up to a whole number.", args: [], describe: () => "round up", fn: (x) => Math.ceil(needNumber(x, "round up")) },
  { id: "abs", label: "Absolute", group: "Maths", kind: "map", help: "Drop the minus sign.", args: [], describe: () => "absolute", fn: (x) => Math.abs(needNumber(x, "absolute")) },
  {
    id: "clamp", label: "Clamp", group: "Maths", kind: "map", help: "Keep the value between a minimum and maximum.",
    args: [{ name: "min", label: "Min", type: "number", default: 0 }, { name: "max", label: "Max", type: "number", default: 100 }],
    describe: (a) => `clamp ${a.min}–${a.max}`, fn: (x, a) => Math.min(num(a, "max"), Math.max(num(a, "min"), needNumber(x, "clamp"))),
  },

  // ---- List: work on the whole list ----
  { id: "min", label: "Lowest", group: "List", kind: "list", help: "The lowest number in the list.", args: [], describe: () => "lowest", fn: (v) => { const n = numbers(v); if (!n.length) throw new OpError("The list is empty"); return Math.min(...n); } },
  { id: "max", label: "Highest", group: "List", kind: "list", help: "The highest number in the list.", args: [], describe: () => "highest", fn: (v) => { const n = numbers(v); if (!n.length) throw new OpError("The list is empty"); return Math.max(...n); } },
  { id: "avg", label: "Average", group: "List", kind: "list", help: "The mean of the numbers in the list.", args: [], describe: () => "average", fn: (v) => { const n = numbers(v); if (!n.length) throw new OpError("The list is empty"); return n.reduce((s, x) => s + x, 0) / n.length; } },
  { id: "sum", label: "Sum", group: "List", kind: "list", help: "Add up the list.", args: [], describe: () => "sum", fn: (v) => numbers(v).reduce((s, x) => s + x, 0) },
  { id: "count", label: "Count", group: "List", kind: "list", help: "How many items are in the list.", args: [], describe: () => "count", fn: (v) => (Array.isArray(v) ? v.length : v === null || v === undefined ? 0 : 1) },
  { id: "first", label: "First", group: "List", kind: "list", help: "The first item.", args: [], describe: () => "first", fn: (v) => (Array.isArray(v) ? (v[0] ?? null) : v) },
  { id: "last", label: "Last", group: "List", kind: "list", help: "The last item.", args: [], describe: () => "last", fn: (v) => (Array.isArray(v) ? (v[v.length - 1] ?? null) : v) },
  { id: "nth", label: "Item number", group: "List", kind: "list", help: "One item by position (1 is the first).", args: [{ name: "n", label: "Position", type: "number", default: 1 }], describe: (a) => `item ${a.n}`, fn: (v, a) => (Array.isArray(v) ? (v[Math.trunc(num(a, "n")) - 1] ?? null) : v) },
  { id: "take", label: "First N", group: "List", kind: "list", help: "Keep only the first N items.", args: [{ name: "n", label: "How many", type: "number", default: 3 }], describe: (a) => `first ${a.n}`, fn: (v, a) => (Array.isArray(v) ? v.slice(0, Math.max(0, Math.trunc(num(a, "n")))) : v) },
  {
    id: "sort", label: "Sort", group: "List", kind: "list", help: "Sort the list.",
    args: [{ name: "dir", label: "Order", type: "select", default: "asc", options: [{ value: "asc", label: "low → high" }, { value: "desc", label: "high → low" }] }],
    describe: (a) => (a.dir === "desc" ? "sort high → low" : "sort low → high"),
    fn: (v, a) => {
      if (!Array.isArray(v)) return v;
      const d = a.dir === "desc" ? -1 : 1;
      return [...v].sort((x, y) => {
        const p = comparable(x), q = comparable(y);
        if (p === undefined) return 1;
        if (q === undefined) return -1;
        return (p < q ? -1 : p > q ? 1 : 0) * d;
      });
    },
  },
  {
    id: "filter", label: "Filter", group: "List", kind: "list", help: "Keep items that match.",
    args: [{ name: "cmp", label: "Keep if", type: "select", default: ">", options: CMPS }, { name: "value", label: "Value", type: "text", default: "0" }],
    describe: (a) => `keep if ${CMPS.find((c) => c.value === a.cmp)?.label ?? a.cmp} ${a.value}`,
    fn: (v, a) => (Array.isArray(v) ? v.filter((x) => compare(x, a.cmp as Cmp, str(a, "value"))) : v),
  },
  { id: "unique", label: "Unique", group: "List", kind: "list", help: "Remove duplicates.", args: [], describe: () => "unique", fn: (v) => (Array.isArray(v) ? [...new Map(v.map((x) => [JSON.stringify(x), x])).values()] : v) },
  { id: "join", label: "Join", group: "List", kind: "list", help: "Join the list into one piece of text.", args: [{ name: "sep", label: "Separator", type: "text", default: ", " }], describe: (a) => `join with "${a.sep}"`, fn: (v, a) => (Array.isArray(v) ? v.map((x) => (x === null || x === undefined ? "" : String(x))).join(str(a, "sep")) : v) },
  {
    id: "pick_by", label: "Pick by another field", group: "List", kind: "pick",
    help: "Take the item where a neighbouring field is highest or lowest, e.g. the name of the cheapest station, or the most recent reading.",
    args: [
      { name: "by", label: "Where", type: "rowpath", default: "" },
      { name: "which", label: "is", type: "select", default: "max", options: [{ value: "max", label: "highest / most recent" }, { value: "min", label: "lowest / oldest" }] },
    ],
    describe: (a) => `where ${String(a.by).replace(/^\$\.?/, "") || "…"} is ${a.which === "min" ? "lowest" : "highest"}`,
  },

  // ---- Text & dates: applied to every value ----
  {
    id: "to_number", label: "To number", group: "Text & dates", kind: "map", help: "Turn text like \"12.5\" into a number.", args: [], describe: () => "to number",
    fn: (x) => (x === null || x === undefined ? null : needNumber(typeof x === "string" ? x.replace(/[,£$€%\s]/g, "") : x, "to number")),
  },
  { id: "to_string", label: "To text", group: "Text & dates", kind: "map", help: "Turn the value into text.", args: [], describe: () => "to text", fn: (x) => (x === null || x === undefined ? x : typeof x === "object" ? JSON.stringify(x) : String(x)) },
  {
    id: "default", label: "If empty", group: "Text & dates", kind: "map", help: "Use this value when the field is missing or null.", args: [{ name: "value", label: "Use", type: "text", default: "0" }],
    describe: (a) => `if empty → ${a.value}`,
    fn: (x, a) => {
      if (x !== null && x !== undefined && x !== "") return x;
      const s = str(a, "value");
      try { return JSON.parse(s); } catch { return s; }
    },
  },
  { id: "upper", label: "Uppercase", group: "Text & dates", kind: "map", help: "UPPERCASE the text.", args: [], describe: () => "uppercase", fn: (x) => (typeof x === "string" ? x.toUpperCase() : x) },
  { id: "lower", label: "Lowercase", group: "Text & dates", kind: "map", help: "lowercase the text.", args: [], describe: () => "lowercase", fn: (x) => (typeof x === "string" ? x.toLowerCase() : x) },
  {
    id: "prefix", label: "Add text", group: "Text & dates", kind: "map", help: "Put text before and/or after the value, e.g. £ or %.",
    args: [{ name: "before", label: "Before", type: "text", default: "" }, { name: "after", label: "After", type: "text", default: "" }],
    describe: (a) => `"${a.before}…${a.after}"`, fn: (x, a) => (x === null || x === undefined ? x : `${str(a, "before")}${x}${str(a, "after")}`),
  },
  {
    id: "date_format", label: "Format date", group: "Text & dates", kind: "map", help: "Read a date or timestamp and write it another way.",
    args: [{ name: "format", label: "As", type: "select", default: "datetime", options: DATE_FORMATS }, { name: "tz", label: "Time zone", type: "text", default: "" }],
    describe: (a) => `date as ${DATE_FORMATS.find((f) => f.value === a.format)?.label ?? a.format}`,
    fn: (x, a, env) => {
      if (x === null || x === undefined) return x;
      const d = toDate(x);
      const tz = str(a, "tz") || env.tz;
      switch (a.format) {
        case "iso": return d.toISOString();
        case "unix": return Math.floor(d.getTime() / 1000);
        case "unix_ms": return d.getTime();
        case "relative": return relative(d.getTime(), env.now);
      }
      let p;
      try { p = dateParts(d, tz); } catch { throw new OpError(`Unknown time zone: ${tz}`); }
      if (a.format === "date") return `${p.year}-${p.month}-${p.day}`;
      if (a.format === "time") return `${p.hour}:${p.minute}`;
      return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
    },
  },

  // ---- History: compare with earlier pulls (needs a single number) ----
  { id: "ago", label: "Value N pulls ago", group: "History", kind: "history", help: "What this value was a number of pulls back.", args: [{ name: "n", label: "Pulls back", type: "number", default: 1 }], describe: (a) => `${a.n} pull${Number(a.n) === 1 ? "" : "s"} ago` },
  { id: "change", label: "Change over", group: "History", kind: "history", help: "Now minus the value at the start of the window.", args: [{ name: "window", label: "Window", type: "select", default: "24h", options: WINDOWS }], describe: (a) => `change over ${WINDOW_LABEL[a.window] ?? a.window}`, hist: (c, pts, before) => c - (before ?? pts[0] ?? c) },
  {
    id: "pct_change", label: "% change over", group: "History", kind: "history", help: "Percentage change since the start of the window.", args: [{ name: "window", label: "Window", type: "select", default: "24h", options: WINDOWS }],
    describe: (a) => `% change over ${WINDOW_LABEL[a.window] ?? a.window}`,
    hist: (c, pts, before) => {
      const b = before ?? pts[0] ?? c;
      if (b === 0) throw new OpError("Can't work out % change from 0");
      return ((c - b) / Math.abs(b)) * 100;
    },
  },
  { id: "win_min", label: "Lowest over", group: "History", kind: "history", help: "The lowest value seen in the window.", args: [{ name: "window", label: "Window", type: "select", default: "24h", options: WINDOWS }], describe: (a) => `lowest over ${WINDOW_LABEL[a.window] ?? a.window}`, hist: (c, pts) => Math.min(c, ...pts) },
  { id: "win_max", label: "Highest over", group: "History", kind: "history", help: "The highest value seen in the window.", args: [{ name: "window", label: "Window", type: "select", default: "24h", options: WINDOWS }], describe: (a) => `highest over ${WINDOW_LABEL[a.window] ?? a.window}`, hist: (c, pts) => Math.max(c, ...pts) },
  { id: "win_avg", label: "Average over", group: "History", kind: "history", help: "The average of every pull in the window.", args: [{ name: "window", label: "Window", type: "select", default: "24h", options: WINDOWS }], describe: (a) => `average over ${WINDOW_LABEL[a.window] ?? a.window}`, hist: (c, pts) => (pts.length ? pts.reduce((s, x) => s + x, 0) / pts.length : c) },
];

export const OPS: Record<string, OpMeta> = Object.fromEntries(ops.map((o) => [o.id, o]));
export const OP_LIST = ops;
export const OP_GROUPS = ["Maths", "List", "Text & dates", "History"] as const;

export function argsWithDefaults(step: OpStep): Args {
  const meta = OPS[step.op];
  const a: Args = {};
  for (const s of meta?.args ?? []) a[s.name] = step.args?.[s.name] ?? s.default;
  return a;
}

export function describeStep(step: OpStep): string {
  const meta = OPS[step.op];
  return meta ? meta.describe(argsWithDefaults(step)) : `unknown step "${step.op}"`;
}

/** Applies a map op to a value, or to every value inside nested lists. Null passes through. */
export function mapDeep(v: unknown, f: (x: unknown) => unknown): unknown {
  if (Array.isArray(v)) return v.map((x) => mapDeep(x, f));
  return f(v);
}
