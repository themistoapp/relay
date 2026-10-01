import { describe, expect, it } from "vitest";
import { openDb } from "../../src/db/db.js";
import { Store, type SourceInput } from "../../src/db/store.js";
import { Secrets } from "../../src/crypto/secrets.js";
import { entriesOf, entryFields, extract, findLists, rangeWindow, readTime, seriesRows, localIso, type HistoryDef } from "../../src/engine/histories.js";
import { renderOutput, type EndpointDefinition, type RenderContext } from "../../src/engine/render.js";

const TZ = "Europe/London";

// The three shapes this has to handle, trimmed from the real APIs.
const AGILE = {
  count: 3,
  results: [
    { value_exc_vat: 20.1, value_inc_vat: 21.105, valid_from: "2026-10-01T22:30:00Z", valid_to: "2026-10-01T23:00:00Z" },
    { value_exc_vat: 18, value_inc_vat: 18.9, valid_from: "2026-10-01T22:00:00Z", valid_to: "2026-10-01T22:30:00Z" },
    { value_exc_vat: 30, value_inc_vat: 31.5, valid_from: "2026-10-01T21:30:00Z", valid_to: "2026-10-01T22:00:00Z" },
  ],
};
const CARBON = {
  data: [
    { from: "2026-10-01T21:00Z", to: "2026-10-01T21:30Z", intensity: { forecast: 130, actual: 128, index: "moderate" } },
    { from: "2026-10-01T21:30Z", to: "2026-10-01T22:00Z", intensity: { forecast: 120, actual: null, index: "low" } },
    { from: "2026-10-01T22:00Z", to: "2026-10-01T22:30Z", intensity: { forecast: 110, actual: null, index: "low" } },
  ],
};
const HA_FORECAST = { "2026-10-01 14:00:00": 812, "2026-10-01 15:00:00": 790, "2026-10-01 16:00:00": 401 };

const carbonDef: HistoryDef = {
  rows: "$.data",
  rowsKind: "list",
  time: "$.from",
  values: [
    { id: "a", name: "intensity", path: "$.intensity.actual", fallback: "$.intensity.forecast", ops: [] },
    { id: "f", name: "forecast", path: "$.intensity.forecast", ops: [] },
  ],
};

describe("reading times", () => {
  it("reads the ways APIs write times", () => {
    expect(readTime("2026-10-01T21:30Z", TZ)).toEqual({ t: Date.parse("2026-10-01T21:30:00Z") });
    expect(readTime("2026-10-01T22:30:00Z", TZ)).toEqual({ t: Date.parse("2026-10-01T22:30:00Z") });
    expect(readTime("2026-10-01T22:30:00+0100", TZ)).toEqual({ t: Date.parse("2026-10-01T21:30:00Z") });
    expect(readTime(1790895600, TZ)).toEqual({ t: 1790895600000 });
    expect(readTime("1790895600000", TZ)).toEqual({ t: 1790895600000 });
    expect(readTime("Wed, 01 Oct 2026 21:30:00 GMT", TZ)).toEqual({ t: Date.parse("2026-10-01T21:30:00Z") });
  });

  it("reads text with no time zone as clock time in TZ, and says so", () => {
    // 1 October is BST, so 14:00 in London is 13:00 UTC.
    expect(readTime("2026-10-01 14:00:00", TZ)).toEqual({ t: Date.parse("2026-10-01T13:00:00Z"), assumedZone: true });
    expect(readTime("2026-12-01", TZ)).toEqual({ t: Date.parse("2026-12-01T00:00:00Z"), assumedZone: true });
  });

  it("explains what it can't read", () => {
    expect(readTime(null, TZ)).toEqual({ error: "No time in this entry" });
    expect(readTime(139.9, TZ)).toEqual({ error: "139.9 doesn't look like a time" });
    expect(readTime("soon", TZ)).toEqual({ error: `"soon" isn't a time Relay can read` });
    expect(readTime("2026-13-45", TZ)).toHaveProperty("error");
  });
});

describe("finding the entries", () => {
  it("finds lists, and objects whose names are times", () => {
    expect(findLists(AGILE, TZ)[0]).toMatchObject({ rows: "$.results", kind: "list", label: "results", count: 3 });
    expect(findLists(CARBON, TZ)[0]).toMatchObject({ rows: "$.data", kind: "list", count: 3 });
    expect(findLists(HA_FORECAST, TZ)[0]).toMatchObject({ rows: "$", kind: "names", label: "the whole response", count: 3, sample: 812 });
    expect(findLists({ forecast: { wh: HA_FORECAST } }, TZ)[0]).toMatchObject({ rows: "$.forecast.wh", label: "forecast › wh" });
  });

  it("lists the fields of an entry, marking times and numbers", () => {
    const fields = entryFields(entriesOf(CARBON, "$.data", "list") as never, TZ);
    const by = Object.fromEntries(fields.map((f) => [f.path, f]));
    expect(by["$.from"]).toMatchObject({ label: "from", timeLike: 1, numeric: 0 });
    expect(by["$.intensity.forecast"]).toMatchObject({ label: "intensity › forecast", numeric: 1, timeLike: 0 });
    expect(by["$.intensity.actual"].numeric).toBeCloseTo(1 / 3);
    const names = entryFields(entriesOf(HA_FORECAST, "$", "names") as never, TZ);
    expect(names).toEqual([expect.objectContaining({ path: "$", label: "the value", numeric: 1 })]);
  });

  it("handles entries that are lists themselves", () => {
    const body = { points: [[1790895600, 5], [1790899200, 7]] };
    const fields = entryFields(entriesOf(body, "$.points", "list") as never, TZ);
    expect(fields.map((f) => f.label)).toEqual(["1st item", "2nd item"]);
    const x = extract(body, { rows: "$.points", rowsKind: "list", time: "$[0]", values: [{ id: "v", name: "v", path: "$[1]", ops: [] }] }, TZ);
    expect(x.points.map((p) => p.values.v)).toEqual([5, 7]);
  });
});

describe("extracting points", () => {
  it("reads Agile prices oldest first, with steps applied", () => {
    const x = extract(AGILE, { rows: "$.results", rowsKind: "list", time: "$.valid_from", values: [{ id: "p", name: "price", path: "$.value_inc_vat", ops: [{ op: "round", args: { dp: 1 } }] }] }, TZ);
    expect(x.points).toEqual([
      { t: Date.parse("2026-10-01T21:30:00Z"), values: { p: 31.5 } },
      { t: Date.parse("2026-10-01T22:00:00Z"), values: { p: 18.9 } },
      { t: Date.parse("2026-10-01T22:30:00Z"), values: { p: 21.1 } },
    ]);
  });

  it("falls back to the forecast while the actual isn't in", () => {
    const x = extract(CARBON, carbonDef, TZ);
    expect(x.points.map((p) => p.values)).toEqual([{ a: 128, f: 130 }, { a: 120, f: 120 }, { a: 110, f: 110 }]);
  });

  it("reads an object whose names are times", () => {
    const x = extract(HA_FORECAST, { rows: "$", rowsKind: "names", time: null, values: [{ id: "wh", name: "wh", path: "$", ops: [{ op: "divide", args: { n: 1000 } }] }] }, TZ);
    expect(x.points[0]).toEqual({ t: Date.parse("2026-10-01T13:00:00Z"), values: { wh: 0.812 } });
  });

  it("counts what it leaves out, and why", () => {
    const body = { data: [{ from: null, v: 1 }, { from: "nope", v: 2 }, { from: "2026-10-01T21:00Z", v: null }, { from: "2026-10-01T21:30Z", v: 4 }] };
    const x = extract(body, { rows: "$.data", rowsKind: "list", time: "$.from", values: [{ id: "v", name: "v", path: "$.v", ops: [] }] }, TZ);
    expect(x.points).toHaveLength(1);
    expect(x.skipped).toEqual({ "No time in this entry": 1, "The time couldn't be read": 1, "No numbers in this entry": 1 });
    expect(extract({}, carbonDef, TZ).error).toBe("The list isn't in this response any more");
  });
});

describe("serving a range", () => {
  const pts = [0, 30, 60, 90, 24 * 60].map((m, i) => ({ t: Date.parse("2026-10-01T00:00:00Z") + m * 60_000, values: { a: i + 1 } }));

  it("groups per hour and per day, in local time", () => {
    const hourly = seriesRows(pts, { group: "hour", combine: "avg", timeFormat: "utc", values: [["a", "v"]] }, TZ);
    expect(hourly).toEqual([
      { time: "2026-10-01T00:00:00Z", v: 1.5 },
      { time: "2026-10-01T01:00:00Z", v: 3.5 },
      { time: "2026-10-02T00:00:00Z", v: 5 },
    ]);
    // 00:00 UTC on 1 October is 01:00 BST, so the first four fall on 1 October locally.
    const daily = seriesRows(pts, { group: "day", combine: "sum", timeFormat: "local", values: [["a", "v"]] }, TZ);
    expect(daily).toEqual([{ time: "2026-10-01T00:00:00+01:00", v: 10 }, { time: "2026-10-02T00:00:00+01:00", v: 5 }]);
  });

  it("works out today in local time, across a clock change", () => {
    const now = Date.parse("2026-10-25T12:00:00Z"); // clocks go back at 02:00 BST that morning
    const [from, to] = rangeWindow("today", now, TZ);
    expect(new Date(from).toISOString()).toBe("2026-10-24T23:00:00.000Z");
    expect(new Date(to).toISOString()).toBe("2026-10-26T00:00:00.000Z");
    expect(localIso(Date.parse("2026-12-01T09:00:00Z"), TZ)).toBe("2026-12-01T09:00:00Z");
  });
});

describe("saved histories in the store", () => {
  const secrets = new Secrets("unit-test-secret-long-enough");
  const SOURCE: SourceInput = { name: "carbon", method: "GET", url: "http://x.test", headers: [], body: null, authType: "none", authName: "", schedule: "*/30 * * * *", keepDays: 1, keepCount: null, timeoutMs: 1000, enabled: true };

  it("merges overlapping pulls: one row per time, actuals replace forecasts, empties never wipe numbers", () => {
    const store = new Store(openDb(":memory:"), secrets, ":memory:");
    const s = store.createSource(SOURCE);
    const h = store.createHistory({ sourceId: s.id, name: "Carbon", definition: { ...carbonDef, values: [{ id: "a", name: "actual", path: "$.intensity.actual", ops: [] }, carbonDef.values[1]] }, keepDays: 400 });
    store.ingest(s.id, CARBON, TZ);
    const later = { data: [{ ...CARBON.data[1], intensity: { forecast: 118, actual: 121, index: "low" } }, { ...CARBON.data[2], intensity: { forecast: 112, actual: null, index: "low" } }] };
    store.ingest(s.id, later, TZ);
    expect(store.points(h.id, 0, Number.MAX_SAFE_INTEGER).map((p) => p.values)).toEqual([
      { a: 128, f: 130 },
      { a: 121, f: 118 },
      { a: null, f: 112 },
    ]);
    expect(store.historyStats(h.id).points).toBe(3);
  });

  it("rebuilds from stored pulls, and keeps points after the pulls are pruned", () => {
    const store = new Store(openDb(":memory:"), secrets, ":memory:");
    const s = store.createSource(SOURCE);
    const now = Date.parse("2026-10-01T22:00:00Z");
    store.recordPull(s.id, { at: now - 3 * 86_400_000, status: 200, ok: true, durationMs: 1, bytes: 1, text: JSON.stringify(AGILE) });
    store.recordPull(s.id, { at: now, status: 200, ok: true, durationMs: 1, bytes: 1, text: JSON.stringify(CARBON) });
    const h = store.createHistory({ sourceId: s.id, name: "Carbon", definition: carbonDef, keepDays: null });
    // The Agile pull has no `data`, so only the carbon pull adds points.
    expect(store.rebuildHistory(h.id, TZ, now)).toEqual({ pulls: 2, points: 3 });
    store.prune(s.id, now);
    expect(store.listSnapshots(s.id, { limit: 10, filter: "all" })).toHaveLength(1);
    expect(store.historyStats(h.id).points).toBe(3);
  });

  it("drops points older than the history's keep setting, but never future ones", () => {
    const store = new Store(openDb(":memory:"), secrets, ":memory:");
    const s = store.createSource(SOURCE);
    const h = store.createHistory({ sourceId: s.id, name: "Carbon", definition: carbonDef, keepDays: 1 });
    store.ingest(s.id, CARBON, TZ);
    expect(store.pruneHistories(Date.parse("2026-10-02T21:45:00Z"))).toBe(2);
    expect(store.historyStats(h.id).points).toBe(1);
  });

  it("serves a history through an endpoint, and remembers which endpoints use it", () => {
    const store = new Store(openDb(":memory:"), secrets, ":memory:");
    const s = store.createSource(SOURCE);
    const h = store.createHistory({ sourceId: s.id, name: "Carbon", definition: carbonDef, keepDays: null });
    store.ingest(s.id, CARBON, TZ);
    const def: EndpointDefinition = {
      fields: [],
      output: [{ id: "n", t: "history", key: "carbon", sourceId: s.id, historyId: h.id, range: "today", group: "none", combine: "avg", timeFormat: "utc", values: ["a"] }],
    };
    const ctx: RenderContext = { latest: new Map(), now: Date.parse("2026-10-01T22:10:00Z"), tz: TZ, histories: { get: (id) => store.getHistory(id), points: (id, f, t) => store.points(id, f, t) } };
    expect(renderOutput(def, ctx).output).toEqual({
      carbon: [
        { time: "2026-10-01T21:00:00Z", intensity: 128 },
        { time: "2026-10-01T21:30:00Z", intensity: 120 },
        { time: "2026-10-01T22:00:00Z", intensity: 110 },
      ],
    });
    store.createEndpoint({ slug: "carbon", name: "Carbon", definition: def, enabled: true, access: "public", corsOrigins: [], rateLimit: 60, rateWindow: "minute", rateBy: "ip", cacheTtl: 60 });
    expect(store.endpointsUsingHistory(h.id).map((e) => e.slug)).toEqual(["carbon"]);
    expect(store.endpointsUsingSource(s.id).map((e) => e.slug)).toEqual(["carbon"]);
    store.deleteHistory(h.id);
    expect(renderOutput(def, ctx).errors[0].message).toBe(`"carbon": that saved history was deleted`);
  });
});
