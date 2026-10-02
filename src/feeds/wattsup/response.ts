import { dateIn } from "../../engine/placeholders.js";
import type { FeedSettings } from "./defaults.js";
import type { FeedSource, SlotRow, WattsUpStore } from "./store.js";
import { HALF_HOUR, UK, addDays, agileTariff, daySlots, localTime, slotMeta, type CarbonMix, type SolarState } from "./rules.js";

export const SCHEMA_VERSION = 1;

const iso = (t: number | null | undefined) => (t === null || t === undefined ? null : new Date(t).toISOString().slice(0, 19) + "Z");
const json = (v: string | null | undefined) => (v ? (JSON.parse(v) as Record<string, number>) : null);

export type SourceStatus = "ok" | "stale" | "error" | "pending" | "disabled";

/**
 * ok: the last poll worked. stale: there's earlier good data, but the last poll failed or the last
 * success is over three intervals old. error: it has never worked. pending: not polled yet.
 */
export function sourceStatus(s: FeedSource, now = Date.now()): SourceStatus {
  if (!s.enabled) return s.lastSuccessAt ? "stale" : "disabled";
  if (!s.lastAttemptAt) return "pending";
  if (!s.lastSuccessAt) return "error";
  if (s.failStreak > 0 || now - s.lastSuccessAt > 3 * s.intervalMin * 60_000) return "stale";
  return "ok";
}

function slot(start: number, r: SlotRow | undefined, dfs: { id: string; start: number; end: number }[]) {
  const samples: number | null = r?.fuel_sample_count ?? null;
  const hasFuel = !!samples;
  const hasDemand = r?.national_demand_mw !== null && r?.national_demand_mw !== undefined;
  const v = (k: string): number | null => r?.[k] ?? null;
  return {
    start: iso(start),
    end: iso(start + HALF_HOUR),
    localTime: localTime(start),
    settlementPeriod: slotMeta(start).settlementPeriod,
    actual: {
      sampleCount: samples ?? 0,
      expectedSamples: r?.fuel_expected_samples ?? 6,
      complete: hasFuel && hasDemand,
      generation: { totalMw: hasFuel ? v("domestic_generation_mw") : null, fuelsMw: hasFuel ? json(r?.generation_by_fuel_mw) : null },
      interconnectors: {
        flowsMw: hasFuel ? json(r?.interconnector_flows_mw) : null,
        importsMw: hasFuel ? v("interconnector_import_mw") : null,
        exportsMw: hasFuel ? v("interconnector_export_mw") : null,
      },
      demand: {
        nationalMw: v("national_demand_mw"),
        transmissionMw: v("transmission_demand_mw"),
        stationLoadMw: v("station_load_mw"),
        pumpedStorageMw: hasFuel ? v("pumped_storage_demand_mw") : null,
      },
      supplyMw: hasFuel ? Math.round(((v("domestic_generation_mw") ?? 0) + (v("interconnector_import_mw") ?? 0)) * 10) / 10 : null,
    },
    forecast: {
      demandMw: v("demand_forecast_mw"),
      nationalDemandMw: v("national_demand_forecast_mw"),
      indicatedGenerationMw: v("indicated_generation_mw"),
    },
    carbon: { actualGPerKwh: v("carbon_actual_g_per_kwh"), forecastGPerKwh: v("carbon_forecast_g_per_kwh"), index: r?.carbon_index ?? null },
    wholesale: { gbpPerMwh: v("wholesale_gbp_per_mwh") },
    homeSolar: { avgW: v("home_solar_w"), samples: r?.home_solar_samples ?? 0 },
    agile: { pPerKwhIncVat: v("agile_p_per_kwh_inc_vat"), pPerKwhExcVat: v("agile_p_per_kwh_exc_vat") },
    dfsEventIds: dfs.filter((e) => e.start < start + HALF_HOUR && e.end > start).map((e) => e.id),
  };
}

/** The whole /v1/watts-up response, read from the database only. */
export function buildResponse(store: WattsUpStore, settings: FeedSettings, now = Date.now()) {
  const today = dateIn(now, UK);
  const dates = [today, addDays(today, 1)];
  const all = dates.map(daySlots);
  const from = all[0][0];
  const to = all[1][all[1].length - 1] + HALF_HOUR;
  const rows = store.slots(from, to);

  const events = store.dfsEvents(Math.min(from, now - settings.dfsHistoryDays * 86_400_000)).map((e) => ({ ...e, id: `${e.deliveryDate}-${e.eventId}` }));
  const mix = store.value<CarbonMix>("carbonMix");
  const solar = store.value<SolarState>("solar");

  const sources: Record<string, unknown> = {};
  for (const s of store.listSources()) {
    const status = sourceStatus(s, now);
    sources[s.key] = {
      status,
      lastSuccessAt: iso(s.lastSuccessAt),
      latestPublishTime: iso(s.latestPublishTime),
      ...(s.lastError && status !== "ok" ? { error: s.lastError } : {}),
    };
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: iso(now),
    timezone: UK,
    latestBalanceSlot: iso(store.latestBalanceSlot()),
    days: dates.map((date, i) => ({ date, slots: all[i].map((s) => slot(s, rows.get(s), events)) })),
    carbon: { currentMix: mix ? mix.data : null },
    solar: solar ? solar.data : null,
    agile: agileTariff(store.getSource("agile")?.url ?? ""),
    dfsEvents: events.map((e) => ({ id: e.id, eventId: e.eventId, deliveryDate: e.deliveryDate, start: iso(e.start), end: iso(e.end), type: e.type, tag: e.tag, mw: e.mw })),
    sources,
  };
}
