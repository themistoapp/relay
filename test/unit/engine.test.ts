import { describe, expect, it } from "vitest";
import { parsePath, resolve, rowBase, relativeToRow, childPath, formatPath, leafName } from "../../src/engine/paths.js";
import { inferShape, countLeaves } from "../../src/engine/shape.js";
import { OPS, compare, toDate, timeZoneProblem } from "../../src/engine/ops.js";
import { renderOutput, previewFields, evalField, type EndpointDefinition, type HistorySource, type RenderContext, type Snapshot } from "../../src/engine/render.js";
import { diffJson } from "../../src/engine/diff.js";

const FUEL = {
  updated: "2026-09-28T09:10:44Z",
  stations: [
    { name: "Tesco", distance_km: 12.4, prices: { E10: 139.9, B7: 145.9 }, updated_at: "2026-09-28T08:00:00Z" },
    { name: "Shell", distance_km: 14.1, prices: { E10: 144.9, B7: 149.9 }, updated_at: "2026-09-28T09:00:00Z" },
    { name: "BP", distance_km: 2.3, prices: { E10: 146.9 }, updated_at: "2026-09-27T20:00:00Z" },
  ],
};

describe("paths", () => {
  it("parses and formats keys, indexes, wildcards and quoted keys", () => {
    const p = '$.a[2].b[*]["weird.key]"]';
    expect(parsePath(p)).toEqual([{ k: "key", v: "a" }, { k: "index", v: 2 }, { k: "key", v: "b" }, { k: "all" }, { k: "key", v: "weird.key]" }]);
    expect(formatPath(parsePath(p))).toBe(p);
    expect(() => parsePath("a.b")).toThrow();
    expect(() => parsePath("$.a[x]")).toThrow();
  });

  it("resolves wildcards into lists and returns undefined for missing parts", () => {
    expect(resolve(FUEL, "$.stations[*].prices.E10")).toEqual([139.9, 144.9, 146.9]);
    expect(resolve(FUEL, "$.stations[*].prices.B7")).toEqual([145.9, 149.9, undefined]);
    expect(resolve(FUEL, "$.stations[1].name")).toBe("Shell");
    expect(resolve(FUEL, "$.nope.deeper")).toBeUndefined();
    expect(resolve(FUEL, "$")).toBe(FUEL);
  });

  it("splits a path into the list it repeats over and the part inside each item", () => {
    expect(rowBase("$.stations[*].prices.E10")).toBe("$.stations[*]");
    expect(relativeToRow("$.stations[*].prices.E10")).toBe("$.prices.E10");
    expect(rowBase("$.updated")).toBeNull();
    expect(childPath("$", "has space")).toBe('$["has space"]');
    expect(leafName("$.stations[*].prices.E10")).toBe("E10");
  });
});

describe("shape", () => {
  it("merges list items and marks keys only some items have as optional", () => {
    const s = inferShape(FUEL);
    const item = s.children!.stations.item!;
    expect(s.children!.stations.count).toBe(3);
    expect(item.children!.prices.children!.B7.optional).toBe(true);
    expect(item.children!.prices.children!.E10.optional).toBeUndefined();
    expect(item.children!.name.type).toBe("string");
    expect(countLeaves(s)).toBe(6);
  });

  it("marks values that are sometimes null as nullable, and conflicting types as mixed", () => {
    const s = inferShape([{ a: 1, b: 1 }, { a: null, b: "x" }]);
    expect(s.item!.children!.a).toMatchObject({ type: "number", nullable: true });
    expect(s.item!.children!.b.type).toBe("mixed");
  });
});

describe("ops", () => {
  const env = { tz: "Europe/London", now: Date.parse("2026-09-28T09:15:00Z") };
  const run = (id: string, v: unknown, args: Record<string, number | string> = {}) => OPS[id].fn!(v, { ...Object.fromEntries(OPS[id].args.map((a) => [a.name, a.default])), ...args }, env);

  it("does maths", () => {
    expect(run("multiply", 1.5, { n: 100 })).toBe(150);
    expect(run("divide", 139.9, { n: 100 })).toBeCloseTo(1.399);
    expect(() => run("divide", 1, { n: 0 })).toThrow("divide by 0");
    expect(run("round", 1.005, { dp: 2 })).toBe(1.01);
    expect(run("clamp", 140, { min: 0, max: 100 })).toBe(100);
    expect(() => run("add", "abc")).toThrow("needs a number");
  });

  it("summarises lists", () => {
    const v = [3, 1, 2];
    expect(run("min", v)).toBe(1);
    expect(run("max", v)).toBe(3);
    expect(run("avg", v)).toBe(2);
    expect(run("sum", v)).toBe(6);
    expect(run("count", v)).toBe(3);
    expect(run("first", v)).toBe(3);
    expect(run("last", v)).toBe(2);
    expect(run("nth", v, { n: 2 })).toBe(1);
    expect(run("take", v, { n: 2 })).toEqual([3, 1]);
    expect(run("sort", v, { dir: "desc" })).toEqual([3, 2, 1]);
    expect(run("filter", v, { cmp: ">=", value: "2" })).toEqual([3, 2]);
    expect(run("unique", [1, 1, 2])).toEqual([1, 2]);
    expect(run("join", ["a", "b"], { sep: "/" })).toBe("a/b");
    expect(run("min", [5, undefined, 2])).toBe(2);
    expect(() => run("min", [])).toThrow("empty");
  });

  it("formats text and dates", () => {
    expect(run("to_number", "£1,234.50")).toBe(1234.5);
    expect(run("default", null, { value: "0" })).toBe(0);
    expect(run("default", 5, { value: "0" })).toBe(5);
    expect(run("prefix", 1.4, { before: "£", after: "" })).toBe("£1.4");
    expect(run("date_format", "2026-09-28T08:15:00Z", { format: "datetime", tz: "" })).toBe("2026-09-28 09:15");
    expect(run("date_format", 1790567700, { format: "iso" })).toBe("2026-09-28T03:55:00.000Z");
    expect(run("date_format", "2026-09-28T09:10:00Z", { format: "relative" })).toBe("5 min ago");
    expect(() => toDate("not a date")).toThrow("Not a date");
  });

  it("compares numbers, numeric text and dates", () => {
    expect(compare("10", ">", "9")).toBe(true);
    expect(compare("2026-09-28T09:00:00Z", ">", "2026-09-28T08:00:00Z")).toBe(true);
    expect(compare("Shell Station Road", "contains", "shell")).toBe(true);
    expect(compare(undefined, ">", "1")).toBe(false);
  });
});

// A fake history: 5 pulls an hour apart, the cheapest E10 falling from 143.9 to 139.9.
const T0 = Date.parse("2026-09-28T05:00:00Z");
const pulls: Snapshot[] = [143.9, 142.9, 142.9, 140.9, 139.9].map((p, i) => ({
  t: T0 + i * 3_600_000,
  key: String(i),
  body: { ...FUEL, stations: FUEL.stations.map((s, j) => (j === 0 ? { ...s, prices: { ...s.prices, E10: p } } : s)) },
}));
const history: HistorySource = {
  window(_id, from, to) {
    const inside = pulls.filter((p) => p.t >= from && p.t <= to);
    const before = pulls.filter((p) => p.t <= from).pop();
    return { before, points: inside };
  },
  back(_id, n, at) {
    const upto = pulls.filter((p) => p.t <= at);
    return upto[upto.length - 1 - n];
  },
};
const ctx = (): RenderContext => ({ latest: new Map([[1, pulls[4]]]), history, now: pulls[4].t, tz: "Europe/London", memo: new Map() });

const DEF: EndpointDefinition = {
  fields: [
    { id: "e10", name: "cheapest_e10", sourceId: 1, path: "$.stations[*].prices.E10", mode: "value", ops: [{ op: "min" }, { op: "divide", args: { n: 100 } }, { op: "round", args: { dp: 2 } }] },
    { id: "who", name: "cheapest_name", sourceId: 1, path: "$.stations[*].name", mode: "value", ops: [{ op: "pick_by", args: { by: "$.prices.E10", which: "min" } }] },
    { id: "latest", name: "freshest", sourceId: 1, path: "$.stations[*].name", mode: "value", ops: [{ op: "pick_by", args: { by: "$.updated_at", which: "max" } }] },
    { id: "chg", name: "change", sourceId: 1, path: "$.stations[*].prices.E10", mode: "value", ops: [{ op: "min" }, { op: "change", args: { window: "6h" } }] },
    { id: "chg3", name: "change3h", sourceId: 1, path: "$.stations[*].prices.E10", mode: "value", ops: [{ op: "min" }, { op: "change", args: { window: "3h" } }] },
    { id: "hi", name: "high", sourceId: 1, path: "$.stations[*].prices.E10", mode: "value", ops: [{ op: "min" }, { op: "win_max", args: { window: "24h" } }] },
    { id: "ago", name: "ago", sourceId: 1, path: "$.stations[*].prices.E10", mode: "value", ops: [{ op: "min" }, { op: "ago", args: { n: 2 } }] },
    { id: "rname", name: "name", sourceId: 1, path: "$.stations[*].name", mode: "row", ops: [{ op: "upper" }] },
    { id: "rprice", name: "e10", sourceId: 1, path: "$.stations[*].prices.E10", mode: "row", ops: [{ op: "divide", args: { n: 100 } }] },
    { id: "rmiles", name: "miles", sourceId: 1, path: "$.stations[*].distance_km", mode: "row", ops: [{ op: "multiply", args: { n: 0.621 } }, { op: "round", args: { dp: 1 } }] },
    { id: "rb7", name: "b7", sourceId: 1, path: "$.stations[*].prices.B7", mode: "row", ops: [{ op: "divide", args: { n: 100 } }] },
  ],
  output: [
    { id: "o1", t: "field", key: "cheapest_e10", fieldId: "e10" },
    { id: "o2", t: "object", key: "summary", children: [
      { id: "o3", t: "field", key: "station", fieldId: "who" },
      { id: "o4", t: "field", key: "freshest", fieldId: "latest" },
      { id: "o5", t: "field", key: "change_6h", fieldId: "chg" },
      { id: "o5b", t: "field", key: "change_3h", fieldId: "chg3" },
      { id: "o6", t: "field", key: "high_24h", fieldId: "hi" },
      { id: "o7", t: "field", key: "two_ago", fieldId: "ago" },
    ] },
    { id: "o8", t: "list", key: "cheapest", sourceId: 1, over: "$.stations[*]", sort: "e10", dir: "asc", limit: 2, children: [
      { id: "o9", t: "field", key: "name", fieldId: "rname" },
      { id: "o10", t: "field", key: "e10", fieldId: "rprice" },
      { id: "o11", t: "field", key: "miles", fieldId: "rmiles" },
      { id: "o12", t: "field", key: "b7", fieldId: "rb7" },
    ] },
    { id: "o13", t: "field", key: "all_names", fieldId: "rname" },
  ],
};

describe("render", () => {
  it("renders single values, picks, history, objects and sorted/limited lists", () => {
    const { output, errors } = renderOutput(DEF, ctx());
    expect(errors).toEqual([]);
    expect(output).toEqual({
      cheapest_e10: 1.4,
      summary: {
        station: "Tesco",
        freshest: "Shell",
        change_6h: -4, // no pull before the window's start (03:00), so vs its first pull: 143.9 at 05:00
        change_3h: -3, // vs 142.9 at 06:00, the pull right on the window's start
        high_24h: 143.9,
        two_ago: 142.9,
      },
      cheapest: [
        { name: "TESCO", e10: 1.399, miles: 7.7, b7: 1.459 },
        { name: "SHELL", e10: 1.449, miles: 8.8, b7: 1.499 },
      ],
      all_names: ["TESCO", "SHELL", "BP"],
    });
  });

  it("filters lists before sorting and limiting", () => {
    const def: EndpointDefinition = { ...DEF, output: [{ ...(DEF.output[2] as any), filter: { key: "miles", cmp: "<", value: "8" }, limit: 0 }] };
    const { output } = renderOutput(def, ctx());
    expect((output.cheapest as any[]).map((r) => r.name)).toEqual(["TESCO", "BP"]);
  });

  it("reports a broken field without breaking the rest of the output", () => {
    const def: EndpointDefinition = {
      fields: [
        { id: "bad", name: "bad", sourceId: 1, path: "$.stations[*].name", mode: "value", ops: [{ op: "multiply", args: { n: 2 } }] },
        { id: "ok", name: "ok", sourceId: 1, path: "$.updated", mode: "value", ops: [] },
        { id: "nosrc", name: "nosrc", sourceId: 9, path: "$.x", mode: "value", ops: [] },
        { id: "histlist", name: "histlist", sourceId: 1, path: "$.stations[*].prices.E10", mode: "value", ops: [{ op: "win_max", args: { window: "1h" } }] },
      ],
      output: [
        { id: "a", t: "field", key: "bad", fieldId: "bad" },
        { id: "b", t: "field", key: "ok", fieldId: "ok" },
        { id: "c", t: "field", key: "nosrc", fieldId: "nosrc" },
        { id: "d", t: "field", key: "histlist", fieldId: "histlist" },
        { id: "e", t: "field", key: "gone", fieldId: "deleted" },
      ],
    };
    const { output, errors } = renderOutput(def, ctx());
    expect(output).toEqual({ bad: null, ok: FUEL.updated, nosrc: null, histlist: null, gone: null });
    expect(errors.map((e) => e.name)).toEqual(["bad", "nosrc", "histlist", "deleted"]);
    expect(errors[0].message).toMatch(/needs a number/);
    expect(errors[2].message).toMatch(/single number/);
  });

  it("previews each field's value before and after its steps", () => {
    const p = previewFields(DEF, ctx());
    expect(p.e10).toEqual({ input: [139.9, 144.9, 146.9], output: 1.4 });
    expect(p.rmiles).toEqual({ input: 12.4, output: 7.7, row: true });
  });

  it("memoises identical work across a render", () => {
    const c = ctx();
    evalField(DEF.fields[5], pulls[4], c);
    const size = c.memo!.size;
    evalField(DEF.fields[5], pulls[4], c);
    expect(c.memo!.size).toBe(size);
  });
});

describe("diff", () => {
  it("reports changed, added and removed values by path", () => {
    const d = diffJson({ a: 1, b: [1, 2], c: { x: 1 } }, { a: 2, b: [1, 2, 3], c: {}, d: true });
    expect(Object.fromEntries(d)).toEqual({
      "$.a": { kind: "changed", was: 1 },
      "$.b[2]": { kind: "added" },
      "$.c.x": { kind: "removed", was: 1 },
      "$.d": { kind: "added" },
    });
  });
});

describe("time zones", () => {
  const fmt = (tz: string) => OPS.date_format.fn!("2026-09-28T06:10:00Z", { format: "time", tz }, { tz: "Europe/London", now: 0 });

  it("uses full zone names, including British Summer Time for Europe/London", () => {
    expect(fmt("Europe/London")).toBe("07:10");
    expect(fmt("")).toBe("07:10");
    expect(fmt("UTC")).toBe("06:10");
    expect(OPS.date_format.fn!("2026-12-28T06:10:00Z", { format: "time", tz: "Europe/London" }, { tz: "UTC", now: 0 })).toBe("06:10");
  });

  it("refuses abbreviations, which ICU maps to surprising places (BST is Bangladesh)", () => {
    expect(() => fmt("BST")).toThrow(/Europe\/London, which switches between GMT and BST/);
    expect(() => fmt("EST")).toThrow(/America\/New_York/);
    expect(() => fmt("Mars/Olympus")).toThrow(/Unknown time zone/);
    expect(timeZoneProblem("Europe/London")).toBeNull();
  });
});
