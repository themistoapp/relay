import { describe, expect, it } from "vitest";
import { pino } from "pino";
import { openDb } from "../../src/db/db.js";
import { Secrets } from "../../src/crypto/secrets.js";
import {
  aggregateSlot,
  daySlots,
  readCarbonMix,
  readDemandForecast,
  readDfs,
  readFuelinst,
  readWholesale,
  readAgile,
  averageBySlot,
  agileTariff,
  slotMeta,
  solarDays,
  stationLoad,
} from "../../src/feeds/wattsup/rules.js";
import { WattsUpStore } from "../../src/feeds/wattsup/store.js";
import { buildResponse, sourceStatus } from "../../src/feeds/wattsup/response.js";
import { SETTINGS_DEFAULTS } from "../../src/feeds/wattsup/defaults.js";
import { WattsUpFeed } from "../../src/feeds/wattsup/feed.js";
import { pickEncoding } from "../../src/public/server.js";

const T = (s: string) => Date.parse(s);
const secrets = new Secrets("test-secret-that-is-long-enough");

describe("UK half-hours", () => {
  it("has 48 slots on a normal day and 46/50 on clock changes", () => {
    expect(daySlots("2026-10-02")).toHaveLength(48);
    expect(daySlots("2026-03-29")).toHaveLength(46);
    expect(daySlots("2026-10-25")).toHaveLength(50);
    expect(daySlots("2026-10-02")[0]).toBe(T("2026-10-01T23:00:00Z"));
  });

  it("numbers settlement periods from local midnight", () => {
    expect(slotMeta(T("2026-10-01T23:00:00Z"))).toEqual({ localDate: "2026-10-02", settlementPeriod: 1 });
    expect(slotMeta(T("2026-10-25T23:30:00Z"))).toEqual({ localDate: "2026-10-25", settlementPeriod: 50 });
  });
});

describe("FUELINST averaging", () => {
  const r = (min: number, fuel: string, mw: number, publish = 0) => ({ start: T("2026-10-02T12:00:00Z") + min * 60_000, fuel, mw, publish });

  it("averages each fuel and splits interconnectors into imports and exports", () => {
    const g = aggregateSlot([r(0, "WIND", 100), r(5, "WIND", 200), r(0, "INTFR", 600), r(5, "INTFR", 400), r(0, "INTNSL", -300), r(5, "INTNSL", -100)])!;
    expect(g.sampleCount).toBe(2);
    expect(g.fuelsMw).toEqual({ WIND: 150 });
    expect(g.flowsMw).toEqual({ INTFR: 500, INTNSL: -200 });
    expect(g.importMw).toBe(500);
    expect(g.exportMw).toBe(200);
    expect(g.domesticMw).toBe(150);
  });

  it("doesn't let pumping cancel pumped generation when the mode changes in a slot", () => {
    const g = aggregateSlot([r(0, "PS", 600), r(5, "PS", 600), r(10, "PS", -300), r(15, "PS", -300), r(20, "PS", -300), r(25, "PS", -300)])!;
    expect(g.pumpedGenerationMw).toBe(200);
    expect(g.pumpedDemandMw).toBe(200);
    expect(g.fuelsMw.PS).toBe(200);
    expect(g.domesticMw).toBe(200);
  });

  it("keeps the newest publish of each reading", () => {
    const rows = readFuelinst({
      data: [
        { startTime: "2026-10-02T12:00:00Z", publishTime: "2026-10-02T12:05:00Z", fuelType: "WIND", generation: 1 },
        { startTime: "2026-10-02T12:00:00Z", publishTime: "2026-10-02T12:10:00Z", fuelType: "WIND", generation: 2 },
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].mw).toBe(2);
  });

  it("computes station load and floors it at zero", () => {
    expect(stationLoad(32577, 26752, 420, 102)).toBe(5303);
    expect(stationLoad(100, 200, 0, 0)).toBe(0);
    expect(stationLoad(null, 1, 1, 1)).toBeNull();
  });
});

describe("reading upstreams", () => {
  it("keeps boundary N forecasts only, newest publish per slot", () => {
    const rows = readDemandForecast({
      data: [
        { startTime: "2026-10-03T12:00:00Z", boundary: "N", publishTime: "2026-10-02T10:00:00Z", transmissionSystemDemand: 1, nationalDemand: 1 },
        { startTime: "2026-10-03T12:00:00Z", boundary: "N", publishTime: "2026-10-02T11:00:00Z", transmissionSystemDemand: 2, nationalDemand: 2 },
        { startTime: "2026-10-03T12:00:00Z", boundary: "B1", publishTime: "2026-10-02T12:00:00Z", transmissionSystemDemand: 3 },
      ],
    });
    expect(rows).toEqual([{ start: T("2026-10-03T12:00:00Z"), transmissionMw: 2, nationalMw: 2, publish: T("2026-10-02T11:00:00Z") }]);
  });

  it("copies an hourly GMT price into both half-hours", () => {
    const rows = readWholesale({ result: { records: [{ Date: "2026-10-03", "Delivery Period": "21:00 - 22:00", Price: 153.94 }] } });
    expect(rows).toEqual([
      { start: T("2026-10-03T21:00:00Z"), gbpPerMwh: 153.94 },
      { start: T("2026-10-03T21:30:00Z"), gbpPerMwh: 153.94 },
    ]);
    expect(readWholesale({ records: [{ Date: "2026-10-03", "Delivery Period": "00:00 - 01:00", Price: 1 }] })).toHaveLength(2);
  });

  it("groups Live DFS records into events: earliest start, latest end, highest MW", () => {
    const rec = (from: string, to: string, mw: number, type = "Live") => ({
      "Event ID": 138, "Delivery Date": "2026-10-01", From_Local: from, To_Local: to, "Event Type": "Downwards", "Event Tag": "Energy", "Service Requirement Type": type, "Service Requirement MW": mw,
    });
    const ev = readDfs({ result: { records: [rec("20:00", "20:30", 500), rec("20:30", "21:00", 700), rec("19:00", "22:00", 900, "Test")] } });
    expect(ev).toEqual([{ deliveryDate: "2026-10-01", eventId: "138", start: T("2026-10-01T19:00:00Z"), end: T("2026-10-01T20:00:00Z"), type: "Downwards", tag: "Energy", mw: 700 }]);
  });

  it("reads Octopus Agile rates into half-hours and finds the region", () => {
    const rows = readAgile({ results: [{ valid_from: "2026-10-03T21:30:00Z", valid_to: "2026-10-03T22:00:00Z", value_inc_vat: 30.4, value_exc_vat: 28.95 }] });
    expect(rows).toEqual([{ start: T("2026-10-03T21:30:00Z"), incVat: 30.4, excVat: 28.95 }]);
    expect(agileTariff("https://api.octopus.energy/v1/products/AGILE-24-10-01/electricity-tariffs/E-1R-AGILE-24-10-01-H/standard-unit-rates/")).toEqual({ tariffCode: "E-1R-AGILE-24-10-01-H", region: "H" });
  });

  it("reads the current generation mix", () => {
    const mix = readCarbonMix({ data: { from: "2026-10-02T19:30Z", to: "2026-10-02T20:00Z", generationmix: [{ fuel: "wind", perc: 31 }, { fuel: "gas", perc: 28 }] } });
    expect(mix).toEqual({ from: "2026-10-02T19:30:00Z", to: "2026-10-02T20:00:00Z", fuelsPercent: { wind: 31, gas: 28 } });
  });

  it("averages irregular solar readings into half-hours, weighted by how long each held", () => {
    const s = T("2026-10-02T12:00:00Z");
    const m = 60_000;
    const slots = averageBySlot(
      [
        { t: s - 5 * m, w: 1000 }, // carried in: held until 12:10
        { t: s + 10 * m, w: 2000 }, // held 12:10–12:15
        { t: s + 15 * m, w: null }, // unavailable 12:15–12:20: a gap, not zero
        { t: s + 20 * m, w: -3 }, // standby: zero, until 12:40
        { t: s + 40 * m, w: 600 },
      ],
      s,
      s + 45 * m,
    );
    expect(slots).toEqual([
      { start: s, avgW: 800, samples: 3 }, // (1000×10 + 2000×5 + 0×10) / 25; the 11:55 reading carries in
      { start: s + 30 * m, avgW: 200, samples: 1 }, // (0×10 + 600×5) / 15, so far
    ]);
  });

  it("turns hourly mean watts into kWh per UK date", () => {
    const now = T("2026-10-02T12:10:00Z");
    const days = solarDays([{ start: T("2026-10-02T10:00:00Z"), mean: 1500 }, { start: T("2026-10-01T22:00:00Z"), mean: -5 }], [{ start: T("2026-10-02T12:00:00Z"), mean: 1200 }], now);
    expect(days).toHaveLength(7);
    expect(days.at(-1)).toEqual({ date: "2026-10-02", kWh: 1.6 });
  });
});

describe("half-hour rows", () => {
  const store = () => {
    const s = new WattsUpStore(openDb(":memory:"), secrets);
    s.seed();
    return s;
  };
  const start = T("2026-10-02T12:00:00Z");

  it("never lets a forecast overwrite settled actuals, and ignores older publishes", () => {
    const s = store();
    s.saveDemand([{ start, nationalMw: 26000, transmissionMw: 32000, publish: 2000 }]);
    s.saveDemandForecast([{ start, transmissionMw: 31000, nationalMw: 25000, publish: 100 }]);
    s.saveDemand([{ start, nationalMw: 1, transmissionMw: 1, publish: 1000 }]);
    const row = s.slots(start, start + 1).get(start)!;
    expect(row.national_demand_mw).toBe(26000);
    expect(row.demand_forecast_mw).toBe(31000);
  });

  it("re-averages a half-hour as later readings arrive, and fills station load", () => {
    const s = store();
    s.saveDemand([{ start, nationalMw: 26000, transmissionMw: 32000, publish: 1 }]);
    s.saveFuel([{ start, fuel: "WIND", mw: 100, publish: 1 }, { start, fuel: "INTFR", mw: -500, publish: 1 }]);
    s.saveFuel([{ start: start + 300_000, fuel: "WIND", mw: 300, publish: 2 }, { start: start + 300_000, fuel: "INTFR", mw: -500, publish: 2 }]);
    const row = s.slots(start, start + 1).get(start)!;
    expect(row.fuel_sample_count).toBe(2);
    expect(JSON.parse(row.generation_by_fuel_mw)).toEqual({ WIND: 200 });
    expect(row.station_load_mw).toBe(5500);
  });

  it("keeps carbon actuals when a later pull only has a forecast", () => {
    const s = store();
    s.saveCarbon([{ start, actual: 150, forecast: 160, index: "moderate" }]);
    s.saveCarbon([{ start, actual: null, forecast: 170, index: null }]);
    const row = s.slots(start, start + 1).get(start)!;
    expect([row.carbon_actual_g_per_kwh, row.carbon_forecast_g_per_kwh, row.carbon_index]).toEqual([150, 170, "moderate"]);
  });

  it("builds every slot of today and tomorrow, with nulls where nothing is published", () => {
    const s = store();
    s.saveWholesale([{ start, gbpPerMwh: 99 }]);
    s.saveDfs([{ deliveryDate: "2026-10-02", eventId: "7", start, end: start + 3_600_000, type: "Downwards", tag: "Energy", mw: 500 }]);
    const r = buildResponse(s, SETTINGS_DEFAULTS, T("2026-10-02T12:10:00Z"));
    expect(r.days.map((d) => [d.date, d.slots.length])).toEqual([["2026-10-02", 48], ["2026-10-03", 48]]);
    const sl = r.days[0].slots.find((x) => x.start === "2026-10-02T12:00:00Z")!;
    expect(sl.wholesale.gbpPerMwh).toBe(99);
    expect(sl.dfsEventIds).toEqual(["2026-10-02-7"]);
    expect(sl.actual.complete).toBe(false);
    expect(r.days[1].slots[0].actual.demand.nationalMw).toBeNull();
    expect(r.sources.fuelinst).toEqual({ status: "pending", lastSuccessAt: null, latestPublishTime: null });
  });

  it("marks a source stale, not empty, when its last poll failed", () => {
    const s = store();
    s.recordAttempt("wholesale", { at: 1000, ok: true, durationMs: 5, rows: 10 });
    s.recordAttempt("wholesale", { at: 2000, ok: false, durationMs: 5, error: "upstream timeout" });
    expect(sourceStatus(s.getSource("wholesale")!, 3000)).toBe("stale");
  });
});

describe("seeding", () => {
  it("adds every source once and keeps edits across restarts", () => {
    const db = openDb(":memory:");
    const a = new WattsUpStore(db, secrets);
    expect(a.seed()).toHaveLength(10);
    a.updateSource("wholesale", { url: "https://example.com/x", backfillUrl: null, intervalMin: 60, timeoutMs: 5000, authType: "none", enabled: true });
    expect(new WattsUpStore(db, secrets).seed()).toEqual([]);
    expect(a.getSource("wholesale")!.url).toBe("https://example.com/x");
  });

  it("borrows an existing Home Assistant sensor URL and token for home solar", () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO sources (name, url, auth_type, auth_secret, created_at, updated_at) VALUES ('PV', 'https://ha.example.com/api/states/sensor.pv_sum', 'bearer', ?, 0, 0)").run(secrets.encrypt("tok"));
    const s = new WattsUpStore(db, secrets);
    s.seed();
    expect(s.getSource("solar")).toMatchObject({ url: "https://ha.example.com/api/states/sensor.pv_sum", enabled: true, hasSecret: true });
    expect(s.getSecret("solar")).toBe("tok");
  });
});

describe("serving", () => {
  it("prefers Brotli, then gzip", () => {
    expect(pickEncoding("gzip, deflate, br")).toBe("br");
    expect(pickEncoding("gzip, br;q=0")).toBe("gzip");
    expect(pickEncoding(undefined)).toBeNull();
  });

  it("keeps serving the previous response if a rebuild fails", () => {
    const feed = new WattsUpFeed(openDb(":memory:"), secrets, { maxResponseBytes: 1e6 }, pino({ level: "silent" }));
    const first = feed.current()!;
    (feed.store as unknown as { slots: () => never }).slots = () => {
      throw new Error("boom");
    };
    expect(feed.rebuild(Date.now() + 1000)).toBe(first);
    expect(feed.buildInfo().error).toBe("boom");
  });
});

describe("home solar from Home Assistant", () => {
  it("averages the sensor's history into half-hours, even when the statistics socket fails", async () => {
    const { createServer } = await import("node:http");
    const now = T("2026-10-02T12:40:00Z");
    let historyUrl = "";
    const ha = createServer((req, res) => {
      if (req.headers.authorization !== "Bearer tok") return res.writeHead(401).end();
      if (req.url!.startsWith("/api/states/")) return res.writeHead(200, { "content-type": "application/json" }).end('{"state":"1234.6"}');
      historyUrl = req.url!;
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify([[
          { entity_id: "sensor.pv", state: "1000", last_changed: "2026-10-01T12:00:00+00:00" },
          { state: "2000", last_changed: "2026-10-02T12:15:00+00:00" },
          { state: "unavailable", last_changed: "2026-10-02T12:35:00+00:00" },
        ]]),
      );
    });
    await new Promise<void>((r) => ha.listen(0, "127.0.0.1", () => r()));
    const port = (ha.address() as { port: number }).port;
    const { fetchSolar } = await import("../../src/feeds/wattsup/solar.js");
    const r = await fetchSolar(`http://127.0.0.1:${port}/api/states/sensor.pv`, "tok", 2000, null, now, 60 * 60_000);
    ha.close();
    expect(historyUrl).toContain("/api/history/period/2026-10-02T11:30:00.000Z?filter_entity_id=sensor.pv");
    expect(historyUrl).toContain("minimal_response");
    expect(r.state?.watts).toBe(1235);
    expect(r.slots).toEqual([
      { start: T("2026-10-02T11:30:00Z"), avgW: 1000, samples: 1 },
      { start: T("2026-10-02T12:00:00Z"), avgW: 1500, samples: 1 },
      { start: T("2026-10-02T12:30:00Z"), avgW: 2000, samples: 1 },
    ]);
    expect(r.error).toMatch(/websocket|statistics/i);
  });
});
