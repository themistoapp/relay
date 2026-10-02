import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// SQLite through Node's built-in node:sqlite: no native module to rebuild between the Mac and the
// container. Migrations are plain SQL, applied on boot, tracked with PRAGMA user_version.

const MIGRATIONS: string[] = [
  `
  CREATE TABLE sources (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    method TEXT NOT NULL DEFAULT 'GET',
    url TEXT NOT NULL,
    headers TEXT NOT NULL DEFAULT '[]',
    body TEXT,
    auth_type TEXT NOT NULL DEFAULT 'none',
    auth_name TEXT NOT NULL DEFAULT '',
    auth_secret TEXT,
    schedule TEXT NOT NULL DEFAULT '*/15 * * * *',
    keep_days INTEGER,
    keep_count INTEGER,
    timeout_ms INTEGER NOT NULL DEFAULT 15000,
    enabled INTEGER NOT NULL DEFAULT 1,
    fail_streak INTEGER NOT NULL DEFAULT 0,
    alerted INTEGER NOT NULL DEFAULT 0,
    last_pulled_at INTEGER,
    last_status INTEGER,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  -- Response bodies, gzipped and stored once per distinct content: a pull whose response hasn't
  -- changed points at the existing row instead of storing another copy.
  CREATE TABLE bodies (
    id INTEGER PRIMARY KEY,
    source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    hash TEXT NOT NULL,
    size INTEGER NOT NULL,
    data BLOB NOT NULL,
    UNIQUE (source_id, hash)
  );

  CREATE TABLE snapshots (
    id INTEGER PRIMARY KEY,
    source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    fetched_at INTEGER NOT NULL,
    status INTEGER NOT NULL,
    ok INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    bytes INTEGER NOT NULL DEFAULT 0,
    body_id INTEGER REFERENCES bodies(id),
    changed INTEGER NOT NULL DEFAULT 0,
    error TEXT
  );
  CREATE INDEX snapshots_source_time ON snapshots(source_id, fetched_at);
  CREATE INDEX snapshots_body ON snapshots(body_id);

  CREATE TABLE endpoints (
    id INTEGER PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    definition TEXT NOT NULL DEFAULT '{"fields":[],"output":[]}',
    enabled INTEGER NOT NULL DEFAULT 0,
    access TEXT NOT NULL DEFAULT 'key',
    cors_origins TEXT NOT NULL DEFAULT '[]',
    rate_limit INTEGER NOT NULL DEFAULT 60,
    rate_window TEXT NOT NULL DEFAULT 'minute',
    rate_by TEXT NOT NULL DEFAULT 'key',
    cache_ttl INTEGER NOT NULL DEFAULT 60,
    version INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE api_keys (
    id INTEGER PRIMARY KEY,
    endpoint_id INTEGER NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    key_hint TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    use_count INTEGER NOT NULL DEFAULT 0,
    revoked_at INTEGER
  );

  CREATE TABLE request_log (
    id INTEGER PRIMARY KEY,
    endpoint_id INTEGER,
    slug TEXT NOT NULL,
    key_id INTEGER,
    caller TEXT,
    ip TEXT,
    status INTEGER NOT NULL,
    ms INTEGER NOT NULL,
    at INTEGER NOT NULL
  );
  CREATE INDEX request_log_endpoint ON request_log(endpoint_id, id);
  `,
  `
  -- Saved histories: which entries of a source's response to keep as one row per time. Their points
  -- outlive the pulls they came from, so a source can keep a week of pulls and a year of history.
  CREATE TABLE histories (
    id INTEGER PRIMARY KEY,
    source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    definition TEXT NOT NULL,
    keep_days INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX histories_source ON histories(source_id);

  -- One row per history per time. data is JSON: { "<value id>": number | null }.
  CREATE TABLE history_points (
    history_id INTEGER NOT NULL REFERENCES histories(id) ON DELETE CASCADE,
    t INTEGER NOT NULL,
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (history_id, t)
  ) WITHOUT ROWID;
  `,
  `
  -- Built-in feeds: upstreams Relay polls and combines with fixed rules, served as one endpoint.
  -- Rows are seeded on boot from src/feeds/*/defaults.ts and then edited in the admin UI.
  CREATE TABLE feed_sources (
    feed TEXT NOT NULL,
    key TEXT NOT NULL,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    backfill_url TEXT,
    interval_min INTEGER NOT NULL,
    timeout_ms INTEGER NOT NULL DEFAULT 20000,
    auth_type TEXT NOT NULL DEFAULT 'none',
    auth_secret TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    fail_streak INTEGER NOT NULL DEFAULT 0,
    last_attempt_at INTEGER,
    last_success_at INTEGER,
    latest_publish_time INTEGER,
    last_error TEXT,
    last_duration_ms INTEGER,
    last_rows INTEGER,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (feed, key)
  ) WITHOUT ROWID;

  CREATE TABLE feed_settings (
    feed TEXT PRIMARY KEY,
    settings TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  -- Snapshots that aren't time series (home solar, the current carbon mix), last good value only.
  CREATE TABLE feed_values (
    feed TEXT NOT NULL,
    key TEXT NOT NULL,
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (feed, key)
  ) WITHOUT ROWID;

  -- Watts Up: one row per UTC half-hour. Times are ms since the epoch.
  CREATE TABLE wattsup_slots (
    slot_start_utc INTEGER PRIMARY KEY,
    slot_end_utc INTEGER NOT NULL,
    local_date TEXT NOT NULL,
    settlement_period INTEGER NOT NULL,
    fuel_sample_count INTEGER,
    fuel_expected_samples INTEGER NOT NULL DEFAULT 6,
    generation_by_fuel_mw TEXT,
    domestic_generation_mw REAL,
    interconnector_flows_mw TEXT,
    interconnector_import_mw REAL,
    interconnector_export_mw REAL,
    pumped_generation_mw REAL,
    pumped_storage_demand_mw REAL,
    national_demand_mw REAL,
    transmission_demand_mw REAL,
    station_load_mw REAL,
    demand_forecast_mw REAL,
    national_demand_forecast_mw REAL,
    indicated_generation_mw REAL,
    carbon_actual_g_per_kwh REAL,
    carbon_forecast_g_per_kwh REAL,
    carbon_index TEXT,
    wholesale_gbp_per_mwh REAL,
    agile_p_per_kwh_inc_vat REAL,
    agile_p_per_kwh_exc_vat REAL,
    home_solar_w REAL,
    home_solar_samples INTEGER,
    generation_publish_time INTEGER,
    demand_publish_time INTEGER,
    demand_forecast_publish_time INTEGER,
    indgen_publish_time INTEGER,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX wattsup_slots_date ON wattsup_slots(local_date);

  -- Raw FUELINST readings (newest publish per five-minute time and fuel), so slot averages can be
  -- rebuilt as late readings arrive or if the rules change.
  CREATE TABLE wattsup_fuel_obs (
    start_utc INTEGER NOT NULL,
    fuel TEXT NOT NULL,
    generation_mw REAL NOT NULL,
    publish_time INTEGER NOT NULL,
    PRIMARY KEY (start_utc, fuel)
  ) WITHOUT ROWID;

  CREATE TABLE wattsup_dfs_events (
    delivery_date TEXT NOT NULL,
    event_id TEXT NOT NULL,
    start_utc INTEGER NOT NULL,
    end_utc INTEGER NOT NULL,
    event_type TEXT,
    event_tag TEXT,
    mw REAL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (delivery_date, event_id)
  ) WITHOUT ROWID;
  `,
];

export type DB = DatabaseSync;

export function openDb(file: string): DB {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;");
  migrate(db);
  return db;
}

function migrate(db: DB) {
  const { user_version } = db.prepare("PRAGMA user_version").get() as { user_version: number };
  for (let v = user_version; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
}

export function tx<T>(db: DB, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
