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
