import { tx, type DB } from "../../db/db.js";
import type { Secrets } from "../../crypto/secrets.js";
import {
  FEED,
  SETTINGS_DEFAULTS,
  SOURCE_DEFAULTS,
  type FeedSettings,
  type SourceDefault,
  type SourceKey,
} from "./defaults.js";
import {
  HALF_HOUR,
  aggregateSlot,
  slotMeta,
  slotOf,
  stationLoad,
  type Carbon,
  type DemandActual,
  type DemandForecast,
  type DfsEvent,
  type FuelReading,
  type Indgen,
  type Price,
  type AgileRate,
  type SolarSlot,
} from "./rules.js";

type Row = Record<string, any>;

export interface FeedSource {
  key: SourceKey;
  name: string;
  about: string;
  url: string;
  backfillUrl: string | null;
  intervalMin: number;
  timeoutMs: number;
  authType: "none" | "bearer";
  hasSecret: boolean;
  enabled: boolean;
  failStreak: number;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  latestPublishTime: number | null;
  lastError: string | null;
  lastDurationMs: number | null;
  lastRows: number | null;
}

export interface FeedSourceInput {
  url: string;
  backfillUrl: string | null;
  intervalMin: number;
  timeoutMs: number;
  authType: "none" | "bearer";
  /** undefined keeps the stored token; "" or null clears it. */
  authSecret?: string | null;
  enabled: boolean;
}

const DEFAULTS = new Map(SOURCE_DEFAULTS.map((d) => [d.key, d]));

const toSource = (r: Row): FeedSource => ({
  key: r.key,
  name: r.name,
  about: DEFAULTS.get(r.key)?.about ?? "",
  url: r.url,
  backfillUrl: r.backfill_url,
  intervalMin: r.interval_min,
  timeoutMs: r.timeout_ms,
  authType: r.auth_type,
  hasSecret: !!r.auth_secret,
  enabled: !!r.enabled,
  failStreak: r.fail_streak,
  lastAttemptAt: r.last_attempt_at,
  lastSuccessAt: r.last_success_at,
  latestPublishTime: r.latest_publish_time,
  lastError: r.last_error,
  lastDurationMs: r.last_duration_ms,
  lastRows: r.last_rows,
});

export type SlotRow = Row;

/** Database access for the Watts Up feed: its sources, settings, half-hour rows and events. */
export class WattsUpStore {
  private stmts = new Map<string, ReturnType<DB["prepare"]>>();

  constructor(
    readonly db: DB,
    private readonly secrets: Secrets,
  ) {}

  private prep(sql: string) {
    let s = this.stmts.get(sql);
    if (!s) this.stmts.set(sql, (s = this.db.prepare(sql)));
    return s;
  }

  // ---------------------------------------------------------------- seeding

  /**
   * Adds any source or settings row that doesn't exist yet, from defaults.ts. Never touches rows
   * that are already there, so edits made in the admin UI survive restarts and upgrades. The home
   * solar source borrows the sensor URL and token of an existing Home Assistant source, if any.
   */
  seed(now = Date.now()): SourceKey[] {
    const added: SourceKey[] = [];
    for (const d of SOURCE_DEFAULTS) {
      if (this.prep("SELECT 1 FROM feed_sources WHERE feed = ? AND key = ?").get(FEED, d.key)) continue;
      let { url, enabled } = d;
      let secret: string | null = null;
      if (d.key === "solar") {
        const ha = this.db
          .prepare("SELECT url, auth_secret FROM sources WHERE auth_type = 'bearer' AND auth_secret IS NOT NULL AND url LIKE '%/api/states/sensor.%' ORDER BY id LIMIT 1")
          .get() as Row | undefined;
        if (ha) {
          url = ha.url;
          secret = ha.auth_secret;
          enabled = true;
        }
      }
      this.prep(
        `INSERT INTO feed_sources (feed, key, name, url, backfill_url, interval_min, timeout_ms, auth_type, auth_secret, enabled, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(FEED, d.key, d.name, url, d.backfillUrl ?? null, d.intervalMin, d.timeoutMs, d.authType, secret, enabled ? 1 : 0, now);
      added.push(d.key);
    }
    if (!this.prep("SELECT 1 FROM feed_settings WHERE feed = ?").get(FEED)) {
      this.prep("INSERT INTO feed_settings (feed, settings, updated_at) VALUES (?, ?, ?)").run(FEED, JSON.stringify(SETTINGS_DEFAULTS), now);
    }
    return added;
  }

  // ---------------------------------------------------------------- settings

  settings(): FeedSettings {
    const r = this.prep("SELECT settings FROM feed_settings WHERE feed = ?").get(FEED) as Row | undefined;
    return { ...SETTINGS_DEFAULTS, ...(r ? JSON.parse(r.settings) : {}) };
  }

  saveSettings(s: FeedSettings, now = Date.now()) {
    this.prep(
      "INSERT INTO feed_settings (feed, settings, updated_at) VALUES (?, ?, ?) ON CONFLICT(feed) DO UPDATE SET settings = excluded.settings, updated_at = excluded.updated_at",
    ).run(FEED, JSON.stringify(s), now);
  }

  // ---------------------------------------------------------------- sources

  listSources(): FeedSource[] {
    const order = SOURCE_DEFAULTS.map((d) => d.key);
    return (this.prep("SELECT * FROM feed_sources WHERE feed = ?").all(FEED) as Row[])
      .map(toSource)
      .sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
  }

  getSource(key: string): FeedSource | undefined {
    const r = this.prep("SELECT * FROM feed_sources WHERE feed = ? AND key = ?").get(FEED, key) as Row | undefined;
    return r ? toSource(r) : undefined;
  }

  getSecret(key: string): string | null {
    const r = this.prep("SELECT auth_secret FROM feed_sources WHERE feed = ? AND key = ?").get(FEED, key) as Row | undefined;
    return r?.auth_secret ? this.secrets.decrypt(r.auth_secret) : null;
  }

  updateSource(key: string, input: FeedSourceInput, now = Date.now()): FeedSource | undefined {
    if (!this.getSource(key)) return undefined;
    this.prep(
      "UPDATE feed_sources SET url = ?, backfill_url = ?, interval_min = ?, timeout_ms = ?, auth_type = ?, enabled = ?, updated_at = ? WHERE feed = ? AND key = ?",
    ).run(input.url, input.backfillUrl, input.intervalMin, input.timeoutMs, input.authType, input.enabled ? 1 : 0, now, FEED, key);
    if (input.authSecret !== undefined) {
      const enc = input.authSecret ? this.secrets.encrypt(input.authSecret) : null;
      this.prep("UPDATE feed_sources SET auth_secret = ? WHERE feed = ? AND key = ?").run(enc, FEED, key);
    }
    return this.getSource(key);
  }

  /** Puts a source's settings back to defaults.ts. Its token and poll history are kept. */
  resetSource(d: SourceDefault, now = Date.now()): FeedSource | undefined {
    this.prep(
      "UPDATE feed_sources SET name = ?, url = ?, backfill_url = ?, interval_min = ?, timeout_ms = ?, auth_type = ?, enabled = ?, updated_at = ? WHERE feed = ? AND key = ?",
    ).run(d.name, d.url, d.backfillUrl ?? null, d.intervalMin, d.timeoutMs, d.authType, d.enabled ? 1 : 0, now, FEED, d.key);
    return this.getSource(d.key);
  }

  recordAttempt(key: string, r: { at: number; ok: boolean; durationMs: number; rows?: number; latestPublish?: number | null; error?: string | null }) {
    if (r.ok) {
      this.prep(
        `UPDATE feed_sources SET fail_streak = 0, last_attempt_at = ?, last_success_at = ?, last_error = ?, last_duration_ms = ?, last_rows = ?,
           latest_publish_time = COALESCE(?, latest_publish_time) WHERE feed = ? AND key = ?`,
      ).run(r.at, r.at, r.error ?? null, r.durationMs, r.rows ?? null, r.latestPublish ?? null, FEED, key);
    } else {
      this.prep("UPDATE feed_sources SET fail_streak = fail_streak + 1, last_attempt_at = ?, last_error = ?, last_duration_ms = ? WHERE feed = ? AND key = ?").run(
        r.at,
        r.error ?? "Failed",
        r.durationMs,
        FEED,
        key,
      );
    }
  }

  // ---------------------------------------------------------------- snapshots

  value<T>(key: string): { data: T; updatedAt: number } | null {
    const r = this.prep("SELECT data, updated_at FROM feed_values WHERE feed = ? AND key = ?").get(FEED, key) as Row | undefined;
    return r ? { data: JSON.parse(r.data), updatedAt: r.updated_at } : null;
  }

  setValue(key: string, data: unknown, now = Date.now()) {
    this.prep("INSERT INTO feed_values (feed, key, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(feed, key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at").run(
      FEED,
      key,
      JSON.stringify(data),
      now,
    );
  }

  // ---------------------------------------------------------------- half-hour rows

  /**
   * Writes some columns of one half-hour, creating the row if needed and leaving other columns
   * alone. `keep` columns only replace a stored value with a non-null one. `newer` names the
   * publish-time column: the write is skipped if the stored data was published later.
   */
  private upsert(start: number, cols: Record<string, unknown>, opts: { keep?: string[]; newer?: string } = {}, now = Date.now()) {
    const names = Object.keys(cols);
    const set = names.map((c) => (opts.keep?.includes(c) ? `${c} = COALESCE(excluded.${c}, ${c})` : `${c} = excluded.${c}`));
    const where = opts.newer ? ` WHERE excluded.${opts.newer} >= COALESCE(wattsup_slots.${opts.newer}, 0)` : "";
    const sql =
      `INSERT INTO wattsup_slots (slot_start_utc, slot_end_utc, local_date, settlement_period, updated_at, ${names.join(", ")})
       VALUES (?, ?, ?, ?, ?, ${names.map(() => "?").join(", ")})
       ON CONFLICT(slot_start_utc) DO UPDATE SET ${set.join(", ")}, updated_at = excluded.updated_at${where}`;
    const { localDate, settlementPeriod } = slotMeta(start);
    const values = names.map((c) => {
      const v = cols[c];
      return v === undefined ? null : typeof v === "object" && v !== null ? JSON.stringify(v) : (v as string | number | null);
    });
    return Number(this.prep(sql).run(start, start + HALF_HOUR, localDate, settlementPeriod, now, ...values).changes);
  }

  private refreshStationLoad(starts: Iterable<number>) {
    const get = this.prep("SELECT transmission_demand_mw, national_demand_mw, interconnector_export_mw, pumped_storage_demand_mw FROM wattsup_slots WHERE slot_start_utc = ?");
    const set = this.prep("UPDATE wattsup_slots SET station_load_mw = ? WHERE slot_start_utc = ?");
    for (const s of starts) {
      const r = get.get(s) as Row | undefined;
      if (r) set.run(stationLoad(r.transmission_demand_mw, r.national_demand_mw, r.interconnector_export_mw, r.pumped_storage_demand_mw), s);
    }
  }

  /** Saves five-minute readings (newest publish wins), then re-averages every half-hour they touch. */
  saveFuel(readings: FuelReading[], now = Date.now()): number {
    return tx(this.db, () => {
      const ins = this.prep(
        `INSERT INTO wattsup_fuel_obs (start_utc, fuel, generation_mw, publish_time) VALUES (?, ?, ?, ?)
         ON CONFLICT(start_utc, fuel) DO UPDATE SET generation_mw = excluded.generation_mw, publish_time = excluded.publish_time
         WHERE excluded.publish_time >= wattsup_fuel_obs.publish_time`,
      );
      const touched = new Set<number>();
      for (const r of readings) {
        ins.run(r.start, r.fuel, r.mw, r.publish);
        touched.add(slotOf(r.start));
      }
      const read = this.prep("SELECT start_utc, fuel, generation_mw, publish_time FROM wattsup_fuel_obs WHERE start_utc >= ? AND start_utc < ?");
      for (const s of touched) {
        const obs = (read.all(s, s + HALF_HOUR) as Row[]).map((o) => ({ start: o.start_utc, fuel: o.fuel, mw: o.generation_mw, publish: o.publish_time }));
        const g = aggregateSlot(obs);
        if (!g) continue;
        this.upsert(
          s,
          {
            fuel_sample_count: g.sampleCount,
            generation_by_fuel_mw: g.fuelsMw,
            domestic_generation_mw: g.domesticMw,
            interconnector_flows_mw: g.flowsMw,
            interconnector_import_mw: g.importMw,
            interconnector_export_mw: g.exportMw,
            pumped_generation_mw: g.pumpedGenerationMw,
            pumped_storage_demand_mw: g.pumpedDemandMw,
            generation_publish_time: g.publish,
          },
          {},
          now,
        );
      }
      this.refreshStationLoad(touched);
      return touched.size;
    });
  }

  saveDemand(rows: DemandActual[], now = Date.now()): number {
    return tx(this.db, () => {
      let n = 0;
      for (const r of rows) {
        n += this.upsert(r.start, { national_demand_mw: r.nationalMw, transmission_demand_mw: r.transmissionMw, demand_publish_time: r.publish }, { newer: "demand_publish_time" }, now);
      }
      this.refreshStationLoad(rows.map((r) => r.start));
      return n;
    });
  }

  saveDemandForecast(rows: DemandForecast[], now = Date.now()): number {
    return tx(this.db, () =>
      rows.reduce(
        (n, r) =>
          n +
          this.upsert(
            r.start,
            { demand_forecast_mw: r.transmissionMw, national_demand_forecast_mw: r.nationalMw, demand_forecast_publish_time: r.publish },
            { newer: "demand_forecast_publish_time", keep: ["national_demand_forecast_mw"] },
            now,
          ),
        0,
      ),
    );
  }

  saveIndgen(rows: Indgen[], now = Date.now()): number {
    return tx(this.db, () => rows.reduce((n, r) => n + this.upsert(r.start, { indicated_generation_mw: r.mw, indgen_publish_time: r.publish }, { newer: "indgen_publish_time" }, now), 0));
  }

  saveCarbon(rows: Carbon[], now = Date.now()): number {
    const keep = ["carbon_actual_g_per_kwh", "carbon_forecast_g_per_kwh", "carbon_index"];
    return tx(this.db, () =>
      rows.reduce((n, r) => n + this.upsert(r.start, { carbon_actual_g_per_kwh: r.actual, carbon_forecast_g_per_kwh: r.forecast, carbon_index: r.index }, { keep }, now), 0),
    );
  }

  saveWholesale(rows: Price[], now = Date.now()): number {
    return tx(this.db, () => rows.reduce((n, r) => n + this.upsert(r.start, { wholesale_gbp_per_mwh: r.gbpPerMwh }, {}, now), 0));
  }

  saveAgile(rows: AgileRate[], now = Date.now()): number {
    return tx(this.db, () => rows.reduce((n, r) => n + this.upsert(r.start, { agile_p_per_kwh_inc_vat: r.incVat, agile_p_per_kwh_exc_vat: r.excVat }, {}, now), 0));
  }

  saveHomeSolar(rows: SolarSlot[], now = Date.now()): number {
    return tx(this.db, () => rows.reduce((n, r) => n + this.upsert(r.start, { home_solar_w: r.avgW, home_solar_samples: r.samples }, {}, now), 0));
  }

  saveDfs(events: DfsEvent[], now = Date.now()): number {
    return tx(this.db, () => {
      const ins = this.prep(
        `INSERT INTO wattsup_dfs_events (delivery_date, event_id, start_utc, end_utc, event_type, event_tag, mw, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(delivery_date, event_id) DO UPDATE SET start_utc = excluded.start_utc, end_utc = excluded.end_utc, event_type = excluded.event_type,
           event_tag = excluded.event_tag, mw = excluded.mw, updated_at = excluded.updated_at`,
      );
      for (const e of events) ins.run(e.deliveryDate, e.eventId, e.start, e.end, e.type, e.tag, e.mw, now);
      return events.length;
    });
  }

  slots(from: number, to: number): Map<number, SlotRow> {
    const rows = this.prep("SELECT * FROM wattsup_slots WHERE slot_start_utc >= ? AND slot_start_utc < ?").all(from, to) as Row[];
    return new Map(rows.map((r) => [r.slot_start_utc, r]));
  }

  /** The newest half-hour with settled demand and at least one generation reading. */
  latestBalanceSlot(): number | null {
    const r = this.prep("SELECT MAX(slot_start_utc) AS t FROM wattsup_slots WHERE national_demand_mw IS NOT NULL AND fuel_sample_count > 0").get() as Row;
    return r?.t ?? null;
  }

  dfsEvents(endingAfter: number): DfsEvent[] {
    return (this.prep("SELECT * FROM wattsup_dfs_events WHERE end_utc > ? ORDER BY start_utc").all(endingAfter) as Row[]).map((r) => ({
      deliveryDate: r.delivery_date,
      eventId: r.event_id,
      start: r.start_utc,
      end: r.end_utc,
      type: r.event_type,
      tag: r.event_tag,
      mw: r.mw,
    }));
  }

  counts(): { slots: number; fuelReadings: number; dfsEvents: number } {
    const c = (t: string) => (this.prep(`SELECT COUNT(*) AS n FROM ${t}`).get() as Row).n as number;
    return { slots: c("wattsup_slots"), fuelReadings: c("wattsup_fuel_obs"), dfsEvents: c("wattsup_dfs_events") };
  }

  /** Drops rows older than `before` (DFS events by when they ended). */
  prune(before: number): number {
    return tx(this.db, () => {
      let n = Number(this.prep("DELETE FROM wattsup_slots WHERE slot_start_utc < ?").run(before).changes);
      n += Number(this.prep("DELETE FROM wattsup_fuel_obs WHERE start_utc < ?").run(before).changes);
      n += Number(this.prep("DELETE FROM wattsup_dfs_events WHERE end_utc < ?").run(before).changes);
      return n;
    });
  }
}
