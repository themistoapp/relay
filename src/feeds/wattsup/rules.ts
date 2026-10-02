// The Watts Up feed's rules, as pure functions: reading each upstream's response, and turning
// five-minute generation readings into half-hour averages. No database or network here.

import { dateIn, midnightIn, wallClockIn } from "../../engine/placeholders.js";

/** UK settlement days, whatever Relay's own TZ is. */
export const UK = "Europe/London";
export const HALF_HOUR = 30 * 60_000;

// ---------------------------------------------------------------- time

export function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

export const slotOf = (t: number) => Math.floor(t / HALF_HOUR) * HALF_HOUR;

/** Every half-hour of a UK local date: 48, or 46/50 on clock-change days. */
export function daySlots(date: string): number[] {
  const start = midnightIn(date, UK);
  const end = midnightIn(addDays(date, 1), UK);
  const out: number[] = [];
  for (let t = start; t < end; t += HALF_HOUR) out.push(t);
  return out;
}

/** The UK date a half-hour belongs to, and its settlement period (1 = the one starting at midnight). */
export function slotMeta(start: number): { localDate: string; settlementPeriod: number } {
  const localDate = dateIn(start, UK);
  return { localDate, settlementPeriod: Math.round((start - midnightIn(localDate, UK)) / HALF_HOUR) + 1 };
}

export const localTime = (t: number) =>
  new Date(t).toLocaleTimeString("en-GB", { timeZone: UK, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** Start of yesterday to the end of tomorrow, the span the feed keeps fresh. */
export function window3(now: number): { from: number; to: number; today: string } {
  const today = dateIn(now, UK);
  return { from: midnightIn(addDays(today, -1), UK), to: midnightIn(addDays(today, 2), UK), today };
}

// ---------------------------------------------------------------- reading responses

class Shape extends Error {}

function list(json: unknown, ...path: string[]): Record<string, unknown>[] {
  let v: unknown = json;
  for (const p of path) v = v && typeof v === "object" ? (v as Record<string, unknown>)[p] : undefined;
  if (!Array.isArray(v)) throw new Shape(`Expected a list at ${path.join(".") || "the top level"}`);
  return v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object");
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

/** ISO times, including the "2026-10-01T22:30Z" form without seconds. */
const when = (v: unknown): number | null => {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const t = typeof v === "number" ? v : Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

/** Keeps the entry with the newest publish time for each key. */
function newestBy<T extends { publish: number }>(items: T[], key: (x: T) => string | number): T[] {
  const best = new Map<string | number, T>();
  for (const x of items) {
    const k = key(x);
    const had = best.get(k);
    if (!had || x.publish >= had.publish) best.set(k, x);
  }
  return [...best.values()];
}

export interface FuelReading {
  start: number;
  fuel: string;
  mw: number;
  publish: number;
}

export function readFuelinst(json: unknown): FuelReading[] {
  const rows = list(json, "data");
  const out: FuelReading[] = [];
  for (const r of rows) {
    const start = when(r.startTime);
    const publish = when(r.publishTime);
    const mw = num(r.generation);
    if (start === null || publish === null || mw === null || typeof r.fuelType !== "string") continue;
    out.push({ start, fuel: r.fuelType, mw, publish });
  }
  return newestBy(out, (x) => `${x.start}|${x.fuel}`);
}

export interface DemandActual {
  start: number;
  nationalMw: number | null;
  transmissionMw: number | null;
  publish: number;
}

export function readDemandOutturn(json: unknown): DemandActual[] {
  const out: DemandActual[] = [];
  for (const r of list(json, "data")) {
    const start = when(r.startTime);
    if (start === null) continue;
    out.push({ start, nationalMw: num(r.initialDemandOutturn), transmissionMw: num(r.initialTransmissionSystemDemandOutturn), publish: when(r.publishTime) ?? 0 });
  }
  return newestBy(out, (x) => x.start);
}

export interface DemandForecast {
  start: number;
  transmissionMw: number | null;
  nationalMw: number | null;
  publish: number;
}

const boundaryN = (r: Record<string, unknown>) => r.boundary === undefined || r.boundary === "N";

export function readDemandForecast(json: unknown): DemandForecast[] {
  const out: DemandForecast[] = [];
  for (const r of list(json, "data")) {
    const start = when(r.startTime);
    if (start === null || !boundaryN(r)) continue;
    out.push({ start, transmissionMw: num(r.transmissionSystemDemand), nationalMw: num(r.nationalDemand), publish: when(r.publishTime) ?? 0 });
  }
  return newestBy(out, (x) => x.start);
}

export interface Indgen {
  start: number;
  mw: number | null;
  publish: number;
}

export function readIndgen(json: unknown): Indgen[] {
  const out: Indgen[] = [];
  for (const r of list(json, "data")) {
    const start = when(r.startTime);
    if (start === null || !boundaryN(r)) continue;
    out.push({ start, mw: num(r.generation), publish: when(r.publishTime) ?? 0 });
  }
  return newestBy(out, (x) => x.start);
}

export interface Carbon {
  start: number;
  actual: number | null;
  forecast: number | null;
  index: string | null;
}

export function readCarbon(json: unknown): Carbon[] {
  const out: Carbon[] = [];
  for (const r of list(json, "data")) {
    const start = when(r.from);
    const i = (r.intensity ?? {}) as Record<string, unknown>;
    if (start === null) continue;
    out.push({ start: slotOf(start), actual: num(i.actual), forecast: num(i.forecast), index: typeof i.index === "string" ? i.index : null });
  }
  return out;
}

export interface CarbonMix {
  from: string | null;
  to: string | null;
  fuelsPercent: Record<string, number>;
}

/** carbonintensity.org.uk/generation: {data: {from, to, generationmix: [{fuel, perc}]}}. */
export function readCarbonMix(json: unknown): CarbonMix {
  const d = (json as { data?: unknown })?.data;
  const entry = (Array.isArray(d) ? d[0] : d) as Record<string, unknown> | undefined;
  if (!entry || typeof entry !== "object") throw new Shape("Expected data with a generationmix");
  const fuelsPercent: Record<string, number> = {};
  for (const m of list(entry, "generationmix")) {
    const p = num(m.perc ?? m.percentage);
    if (typeof m.fuel === "string" && p !== null) fuelsPercent[m.fuel] = p;
  }
  const iso = (v: unknown) => (when(v) === null ? null : new Date(when(v)!).toISOString().replace(/\.000Z$/, "Z"));
  return { from: iso(entry.from), to: iso(entry.to), fuelsPercent };
}

export interface Price {
  start: number;
  gbpPerMwh: number;
}

/** NESO datastore records ({result: {records}}, or a bare {records}). "Delivery Period" is an
 *  hourly GMT range like "21:00 - 22:00"; each hour fills its two half-hours. */
export function readWholesale(json: unknown): Price[] {
  const j = json as { result?: unknown };
  const rows = j && typeof j === "object" && j.result ? list(json, "result", "records") : list(json, "records");
  const out = new Map<number, Price>();
  for (const r of rows) {
    const date = typeof r.Date === "string" ? r.Date.slice(0, 10) : null;
    const m = /^\s*(\d{1,2}):(\d{2})/.exec(String(r["Delivery Period"] ?? ""));
    const price = num(r.Price);
    if (!date || !m || price === null) continue;
    const start = Date.parse(`${date}T${m[1].padStart(2, "0")}:${m[2]}:00Z`);
    if (!Number.isFinite(start)) continue;
    out.set(start, { start, gbpPerMwh: price });
    out.set(start + HALF_HOUR, { start: start + HALF_HOUR, gbpPerMwh: price });
  }
  return [...out.values()];
}

export interface AgileRate {
  start: number;
  incVat: number | null;
  excVat: number | null;
}

/** Octopus standard-unit-rates ({results: [{valid_from, valid_to, value_inc_vat, value_exc_vat}]}).
 *  A rate covering more than one half-hour fills each of them; an open end counts as one half-hour. */
export function readAgile(json: unknown): AgileRate[] {
  const out = new Map<number, AgileRate>();
  for (const r of list(json, "results")) {
    const from = when(r.valid_from);
    if (from === null) continue;
    const to = when(r.valid_to) ?? from + HALF_HOUR;
    const rate = { incVat: num(r.value_inc_vat), excVat: num(r.value_exc_vat) };
    for (let t = slotOf(from); t < to && t < from + 2 * 86_400_000; t += HALF_HOUR) out.set(t, { start: t, ...rate });
  }
  return [...out.values()];
}

/** The tariff code in an Octopus rates URL, e.g. E-1R-AGILE-24-10-01-H, and its region letter. */
export function agileTariff(url: string): { tariffCode: string; region: string } | null {
  const m = /electricity-tariffs\/(E-[12]R-[A-Z0-9-]+-([A-P]))\//i.exec(url);
  return m ? { tariffCode: m[1], region: m[2].toUpperCase() } : null;
}

export interface DfsEvent {
  deliveryDate: string;
  eventId: string;
  start: number;
  end: number;
  type: string | null;
  tag: string | null;
  mw: number | null;
}

function dfsTimes(date: string, local: unknown, utc: unknown): number | null {
  const hm = (v: unknown) => (typeof v === "string" && /^\d{1,2}:\d{2}/.test(v) ? v.trim().slice(0, 5).padStart(5, "0") : null);
  const l = hm(local);
  if (l) return wallClockIn(date, `${l}:00`, UK);
  const u = hm(utc);
  return u ? Date.parse(`${date}T${u}:00Z`) : null;
}

/** Live records only, one event per Delivery Date + Event ID: earliest start, latest end, highest MW. */
export function readDfs(json: unknown): DfsEvent[] {
  const j = json as { result?: unknown };
  const rows = j && typeof j === "object" && j.result ? list(json, "result", "records") : list(json, "records");
  const events = new Map<string, DfsEvent>();
  for (const r of rows) {
    if (r["Service Requirement Type"] !== "Live") continue;
    const date = typeof r["Delivery Date"] === "string" ? r["Delivery Date"].slice(0, 10) : null;
    const id = r["Event ID"];
    if (!date || id === undefined || id === null) continue;
    const start = dfsTimes(date, r.From_Local, r.From_UTC);
    let end = dfsTimes(date, r.To_Local, r.To_UTC);
    if (start === null || end === null) continue;
    if (end <= start) end += 86_400_000; // e.g. 23:30 to 00:00
    const key = `${date}|${id}`;
    const mw = num(r["Service Requirement MW"]);
    const str = (v: unknown) => (typeof v === "string" && v ? v : null);
    const had = events.get(key);
    if (!had) {
      events.set(key, { deliveryDate: date, eventId: String(id), start, end, type: str(r["Event Type"]), tag: str(r["Event Tag"]), mw });
    } else {
      had.start = Math.min(had.start, start);
      had.end = Math.max(had.end, end);
      if (mw !== null) had.mw = had.mw === null ? mw : Math.max(had.mw, mw);
      had.type ??= str(r["Event Type"]);
      had.tag ??= str(r["Event Tag"]);
    }
  }
  return [...events.values()];
}

/** Rejects responses that don't look like what a source should send, with a readable message. */
export function shapeError(e: unknown): string | null {
  return e instanceof Shape ? `Unexpected response: ${e.message}` : null;
}

// ---------------------------------------------------------------- half-hour generation

export interface SlotGeneration {
  sampleCount: number;
  fuelsMw: Record<string, number>;
  domesticMw: number;
  flowsMw: Record<string, number>;
  importMw: number;
  exportMw: number;
  pumpedGenerationMw: number;
  pumpedDemandMw: number;
  publish: number;
}

const r1 = (x: number) => Math.round(x * 10) / 10;

/**
 * Averages one half-hour's five-minute readings (already one per time and fuel). Each fuel is the
 * mean over its own readings. INT* are interconnectors (positive = import). Pumped storage is split
 * by mode so pumping can't cancel generating: positive PS readings average into generation (and
 * the PS fuel), negative ones into pumping demand, each over all the PS readings.
 */
export function aggregateSlot(readings: FuelReading[]): SlotGeneration | null {
  if (!readings.length) return null;
  const times = new Set<number>();
  const byFuel = new Map<string, number[]>();
  let publish = 0;
  for (const r of readings) {
    times.add(r.start);
    publish = Math.max(publish, r.publish);
    const l = byFuel.get(r.fuel) ?? [];
    l.push(r.mw);
    byFuel.set(r.fuel, l);
  }
  const mean = (l: number[]) => l.reduce((a, b) => a + b, 0) / l.length;
  const fuelsMw: Record<string, number> = {};
  const flowsMw: Record<string, number> = {};
  let pumpedGenerationMw = 0;
  let pumpedDemandMw = 0;
  for (const [fuel, values] of [...byFuel].sort(([a], [b]) => a.localeCompare(b))) {
    if (fuel.startsWith("INT")) flowsMw[fuel] = r1(mean(values));
    else if (fuel === "PS") {
      pumpedGenerationMw = r1(mean(values.map((v) => Math.max(v, 0))));
      pumpedDemandMw = r1(mean(values.map((v) => Math.max(-v, 0))));
      fuelsMw.PS = pumpedGenerationMw;
    } else fuelsMw[fuel] = r1(mean(values));
  }
  const sum = (l: number[]) => r1(l.reduce((a, b) => a + b, 0));
  const flows = Object.values(flowsMw);
  return {
    sampleCount: times.size,
    fuelsMw,
    domesticMw: sum(Object.values(fuelsMw)),
    flowsMw,
    importMw: sum(flows.map((f) => Math.max(f, 0))),
    exportMw: sum(flows.map((f) => Math.max(-f, 0))),
    pumpedGenerationMw,
    pumpedDemandMw,
    publish,
  };
}

/** Station load: what transmission demand has left once national demand, exports and pumping are taken out. */
export function stationLoad(transmissionMw: number | null, nationalMw: number | null, exportMw: number | null, pumpedDemandMw: number | null): number | null {
  if (transmissionMw === null || nationalMw === null || exportMw === null || pumpedDemandMw === null) return null;
  return r1(Math.max(0, transmissionMw - nationalMw - exportMw - pumpedDemandMw));
}

// ---------------------------------------------------------------- home solar

export interface SolarSlot {
  start: number;
  /** Time-weighted mean watts over the part of the half-hour that has readings. */
  avgW: number;
  /** Readings that started inside the half-hour. */
  samples: number;
}

/**
 * Averages state-change readings into half-hours. Each reading holds until the next one (or
 * `to`), so a value that held for 20 minutes counts for 20 minutes however often it was logged.
 * Readings that aren't numbers ("unavailable") leave a gap rather than counting as zero; a
 * half-hour with no covered time is left out. Negative standby readings count as zero.
 */
export function averageBySlot(readings: { t: number; w: number | null }[], from: number, to: number): SolarSlot[] {
  const sorted = [...readings].sort((a, b) => a.t - b.t);
  const out: SolarSlot[] = [];
  for (let s = slotOf(from); s < to; s += HALF_HOUR) {
    const end = Math.min(s + HALF_HOUR, to);
    let wsum = 0;
    let covered = 0;
    let samples = 0;
    for (let i = 0; i < sorted.length; i++) {
      const a = Math.max(sorted[i].t, s, from);
      const b = Math.min(sorted[i + 1]?.t ?? to, end);
      if (sorted[i].t >= s && sorted[i].t < end) samples++;
      if (b <= a || sorted[i].w === null) continue;
      wsum += Math.max(0, sorted[i].w!) * (b - a);
      covered += b - a;
    }
    if (covered > 0) out.push({ start: s, avgW: r1(wsum / covered), samples });
  }
  return out;
}

export interface SolarState {
  watts: number | null;
  updatedAt: string;
  days: { date: string; kWh: number }[];
}

/** kWh per UK date for the last `n` dates including today, from hourly mean watts (plus the
 *  current hour's five-minute means). Negative standby readings count as zero. */
export function solarDays(hourly: { start: number; mean: number }[], fiveMinute: { start: number; mean: number }[], now: number, n = 7): { date: string; kWh: number }[] {
  const today = dateIn(now, UK);
  const totals = new Map<string, number>();
  for (let i = n - 1; i >= 0; i--) totals.set(addDays(today, -i), 0);
  const add = (t: number, wh: number) => {
    const d = dateIn(t, UK);
    if (totals.has(d)) totals.set(d, totals.get(d)! + wh);
  };
  for (const h of hourly) add(h.start, Math.max(0, h.mean));
  for (const m of fiveMinute) add(m.start, (Math.max(0, m.mean) * 5) / 60);
  return [...totals].map(([date, wh]) => ({ date, kWh: Math.round(wh) / 1000 }));
}
