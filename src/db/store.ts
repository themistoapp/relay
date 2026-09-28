import { gunzipSync, gzipSync } from "node:zlib";
import { statSync } from "node:fs";
import { tx, type DB } from "./db.js";
import { Secrets, newApiKey, sha256 } from "../crypto/secrets.js";
import { resolve } from "../engine/paths.js";
import type { EndpointDefinition, HistorySource, Snapshot } from "../engine/render.js";

export type AuthType = "none" | "bearer" | "header" | "basic" | "query";

export interface Source {
  id: number;
  name: string;
  method: string;
  url: string;
  headers: { key: string; value: string }[];
  body: string | null;
  authType: AuthType;
  authName: string;
  hasSecret: boolean;
  schedule: string;
  keepDays: number | null;
  keepCount: number | null;
  timeoutMs: number;
  enabled: boolean;
  failStreak: number;
  alerted: boolean;
  lastPulledAt: number | null;
  lastStatus: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface SourceInput {
  name: string;
  method: string;
  url: string;
  headers: { key: string; value: string }[];
  body: string | null;
  authType: AuthType;
  authName: string;
  /** undefined keeps the stored token; "" or null clears it. */
  authSecret?: string | null;
  schedule: string;
  keepDays: number | null;
  keepCount: number | null;
  timeoutMs: number;
  enabled: boolean;
}

export interface PullResult {
  at: number;
  status: number;
  ok: boolean;
  durationMs: number;
  bytes: number;
  text?: string;
  error?: string;
}

export interface SnapshotRow {
  id: number;
  sourceId: number;
  fetchedAt: number;
  status: number;
  ok: boolean;
  durationMs: number;
  bytes: number;
  bodyId: number | null;
  changed: boolean;
  error: string | null;
}

export interface Endpoint {
  id: number;
  slug: string;
  name: string;
  definition: EndpointDefinition;
  enabled: boolean;
  access: "public" | "key";
  corsOrigins: string[];
  rateLimit: number;
  rateWindow: "minute" | "hour";
  rateBy: "key" | "ip";
  cacheTtl: number;
  version: number;
  createdAt: number;
  updatedAt: number;
}

export type EndpointInput = Omit<Endpoint, "id" | "version" | "createdAt" | "updatedAt">;

export interface ApiKey {
  id: number;
  endpointId: number;
  label: string;
  hint: string;
  createdAt: number;
  lastUsedAt: number | null;
  useCount: number;
  revokedAt: number | null;
}

type Row = Record<string, any>;

const toSource = (r: Row): Source => ({
  id: r.id,
  name: r.name,
  method: r.method,
  url: r.url,
  headers: JSON.parse(r.headers),
  body: r.body,
  authType: r.auth_type,
  authName: r.auth_name,
  hasSecret: !!r.auth_secret,
  schedule: r.schedule,
  keepDays: r.keep_days,
  keepCount: r.keep_count,
  timeoutMs: r.timeout_ms,
  enabled: !!r.enabled,
  failStreak: r.fail_streak,
  alerted: !!r.alerted,
  lastPulledAt: r.last_pulled_at,
  lastStatus: r.last_status,
  lastError: r.last_error,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toSnapshot = (r: Row): SnapshotRow => ({
  id: r.id,
  sourceId: r.source_id,
  fetchedAt: r.fetched_at,
  status: r.status,
  ok: !!r.ok,
  durationMs: r.duration_ms,
  bytes: r.bytes,
  bodyId: r.body_id,
  changed: !!r.changed,
  error: r.error,
});

const toEndpoint = (r: Row): Endpoint => ({
  id: r.id,
  slug: r.slug,
  name: r.name,
  definition: JSON.parse(r.definition),
  enabled: !!r.enabled,
  access: r.access,
  corsOrigins: JSON.parse(r.cors_origins),
  rateLimit: r.rate_limit,
  rateWindow: r.rate_window,
  rateBy: r.rate_by,
  cacheTtl: r.cache_ttl,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toKey = (r: Row): ApiKey => ({
  id: r.id,
  endpointId: r.endpoint_id,
  label: r.label,
  hint: r.key_hint,
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
  useCount: r.use_count,
  revokedAt: r.revoked_at,
});

// What the Data page may show. Anything secret is masked, and no user SQL ever runs.
const BROWSABLE: Record<string, { columns: string[]; mask?: Record<string, (v: any) => string> }> = {
  sources: {
    columns: ["id", "name", "method", "url", "auth_type", "auth_secret", "schedule", "keep_days", "keep_count", "enabled", "fail_streak", "last_pulled_at", "last_status", "last_error", "created_at"],
    mask: { auth_secret: (v) => (v ? "•••••••• (encrypted, hidden)" : "") },
  },
  snapshots: { columns: ["id", "source_id", "fetched_at", "status", "ok", "duration_ms", "bytes", "body_id", "changed", "error"] },
  bodies: { columns: ["id", "source_id", "hash", "size", "data"], mask: { data: (v: Uint8Array) => `gzip, ${v.byteLength.toLocaleString("en-GB")} bytes` } },
  endpoints: {
    columns: ["id", "slug", "name", "enabled", "access", "cors_origins", "rate_limit", "rate_window", "rate_by", "cache_ttl", "definition", "version", "updated_at"],
    mask: { definition: (v: string) => (v.length > 120 ? v.slice(0, 117) + "…" : v) },
  },
  api_keys: { columns: ["id", "endpoint_id", "label", "key_hash", "key_hint", "created_at", "last_used_at", "use_count", "revoked_at"], mask: { key_hash: () => "•••••••• (hash, hidden)" } },
  request_log: { columns: ["id", "endpoint_id", "slug", "caller", "ip", "status", "ms", "at"] },
};

export class Store {
  private bodyCache = new Map<number, unknown>();

  constructor(
    readonly db: DB,
    private readonly secrets: Secrets,
    private readonly dbFile: string,
  ) {}

  // ---------------------------------------------------------------- sources

  listSources(): Source[] {
    return (this.db.prepare("SELECT * FROM sources ORDER BY name COLLATE NOCASE").all() as Row[]).map(toSource);
  }

  getSource(id: number): Source | undefined {
    const r = this.db.prepare("SELECT * FROM sources WHERE id = ?").get(id) as Row | undefined;
    return r ? toSource(r) : undefined;
  }

  getSourceSecret(id: number): string | null {
    const r = this.db.prepare("SELECT auth_secret FROM sources WHERE id = ?").get(id) as Row | undefined;
    return r?.auth_secret ? this.secrets.decrypt(r.auth_secret) : null;
  }

  createSource(input: SourceInput, now = Date.now()): Source {
    const r = this.db
      .prepare(
        `INSERT INTO sources (name, method, url, headers, body, auth_type, auth_name, auth_secret, schedule, keep_days, keep_count, timeout_ms, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.name, input.method, input.url, JSON.stringify(input.headers), input.body, input.authType, input.authName,
        input.authSecret ? this.secrets.encrypt(input.authSecret) : null,
        input.schedule, input.keepDays, input.keepCount, input.timeoutMs, input.enabled ? 1 : 0, now, now,
      );
    return this.getSource(Number(r.lastInsertRowid))!;
  }

  updateSource(id: number, input: SourceInput, now = Date.now()): Source | undefined {
    const secretSql = input.authSecret === undefined ? "" : ", auth_secret = ?";
    const secretArg = input.authSecret === undefined ? [] : [input.authSecret ? this.secrets.encrypt(input.authSecret) : null];
    const r = this.db
      .prepare(
        `UPDATE sources SET name = ?, method = ?, url = ?, headers = ?, body = ?, auth_type = ?, auth_name = ?, schedule = ?,
           keep_days = ?, keep_count = ?, timeout_ms = ?, enabled = ?, updated_at = ?${secretSql} WHERE id = ?`,
      )
      .run(
        input.name, input.method, input.url, JSON.stringify(input.headers), input.body, input.authType, input.authName, input.schedule,
        input.keepDays, input.keepCount, input.timeoutMs, input.enabled ? 1 : 0, now, ...secretArg, id,
      );
    return r.changes ? this.getSource(id) : undefined;
  }

  deleteSource(id: number): boolean {
    return tx(this.db, () => {
      this.db.prepare("DELETE FROM snapshots WHERE source_id = ?").run(id);
      this.db.prepare("DELETE FROM bodies WHERE source_id = ?").run(id);
      return this.db.prepare("DELETE FROM sources WHERE id = ?").run(id).changes > 0;
    });
  }

  /** Endpoints whose definition reads from this source. */
  endpointsUsingSource(id: number): { id: number; name: string; slug: string }[] {
    return this.listEndpoints()
      .filter((e) => e.definition.fields.some((f) => f.sourceId === id) || e.definition.output.some(function uses(n): boolean {
        return (n.t === "list" && n.sourceId === id) || ((n.t === "list" || n.t === "object") && n.children.some(uses));
      }))
      .map((e) => ({ id: e.id, name: e.name, slug: e.slug }));
  }

  // ---------------------------------------------------------------- pulls

  /** Stores one pull. The body is stored once per distinct content. */
  recordPull(sourceId: number, res: PullResult): { snapshot: SnapshotRow; failStreak: number; wasAlerted: boolean } {
    return tx(this.db, () => {
      let bodyId: number | null = null;
      let changed = false;
      if (res.ok && res.text !== undefined) {
        const hash = sha256(res.text);
        const existing = this.db.prepare("SELECT id FROM bodies WHERE source_id = ? AND hash = ?").get(sourceId, hash) as Row | undefined;
        bodyId = existing
          ? existing.id
          : Number(this.db.prepare("INSERT INTO bodies (source_id, hash, size, data) VALUES (?, ?, ?, ?)").run(sourceId, hash, Buffer.byteLength(res.text), gzipSync(res.text)).lastInsertRowid);
        const prev = this.db.prepare("SELECT body_id FROM snapshots WHERE source_id = ? AND ok = 1 ORDER BY fetched_at DESC, id DESC LIMIT 1").get(sourceId) as Row | undefined;
        changed = !prev || prev.body_id !== bodyId;
      }
      const ins = this.db
        .prepare("INSERT INTO snapshots (source_id, fetched_at, status, ok, duration_ms, bytes, body_id, changed, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(sourceId, res.at, res.status, res.ok ? 1 : 0, res.durationMs, res.bytes, bodyId, changed ? 1 : 0, res.error ?? null);
      const before = this.db.prepare("SELECT fail_streak, alerted FROM sources WHERE id = ?").get(sourceId) as Row;
      const failStreak = res.ok ? 0 : before.fail_streak + 1;
      this.db
        .prepare("UPDATE sources SET last_pulled_at = ?, last_status = ?, last_error = ?, fail_streak = ? WHERE id = ?")
        .run(res.at, res.status, res.error ?? null, failStreak, sourceId);
      const snapshot = toSnapshot(this.db.prepare("SELECT * FROM snapshots WHERE id = ?").get(Number(ins.lastInsertRowid)) as Row);
      return { snapshot, failStreak, wasAlerted: !!before.alerted };
    });
  }

  setAlerted(sourceId: number, alerted: boolean) {
    this.db.prepare("UPDATE sources SET alerted = ? WHERE id = ?").run(alerted ? 1 : 0, sourceId);
  }

  loadBody(bodyId: number): unknown {
    if (this.bodyCache.has(bodyId)) {
      const v = this.bodyCache.get(bodyId);
      this.bodyCache.delete(bodyId);
      this.bodyCache.set(bodyId, v);
      return v;
    }
    const r = this.db.prepare("SELECT data FROM bodies WHERE id = ?").get(bodyId) as Row | undefined;
    if (!r) return undefined;
    const v = JSON.parse(gunzipSync(r.data).toString("utf8"));
    this.bodyCache.set(bodyId, v);
    if (this.bodyCache.size > 300) this.bodyCache.delete(this.bodyCache.keys().next().value!);
    return v;
  }

  private snap(r: Row): Snapshot {
    const store = this;
    return {
      t: r.fetched_at,
      key: String(r.body_id),
      get body() {
        return store.loadBody(r.body_id);
      },
    };
  }

  latestOk(sourceId: number): (Snapshot & { snapshotId: number }) | undefined {
    const r = this.db.prepare("SELECT id, fetched_at, body_id FROM snapshots WHERE source_id = ? AND ok = 1 ORDER BY fetched_at DESC, id DESC LIMIT 1").get(sourceId) as Row | undefined;
    return r ? Object.assign(this.snap(r), { snapshotId: r.id as number }) : undefined;
  }

  history(): HistorySource {
    return {
      window: (sourceId, from, to) => {
        const points = (this.db.prepare("SELECT fetched_at, body_id FROM snapshots WHERE source_id = ? AND ok = 1 AND fetched_at >= ? AND fetched_at <= ? ORDER BY fetched_at").all(sourceId, from, to) as Row[]).map((r) => this.snap(r));
        const b = this.db.prepare("SELECT fetched_at, body_id FROM snapshots WHERE source_id = ? AND ok = 1 AND fetched_at <= ? ORDER BY fetched_at DESC LIMIT 1").get(sourceId, from) as Row | undefined;
        return { before: b ? this.snap(b) : undefined, points };
      },
      back: (sourceId, n, at) => {
        const r = this.db.prepare("SELECT fetched_at, body_id FROM snapshots WHERE source_id = ? AND ok = 1 AND fetched_at <= ? ORDER BY fetched_at DESC LIMIT 1 OFFSET ?").get(sourceId, at, n) as Row | undefined;
        return r ? this.snap(r) : undefined;
      },
    };
  }

  listSnapshots(sourceId: number, opts: { before?: { t: number; id: number }; limit: number; filter: "all" | "changed" | "errors"; from?: number; to?: number }): SnapshotRow[] {
    const where = ["source_id = ?"];
    const args: (number | string)[] = [sourceId];
    if (opts.before) {
      where.push("(fetched_at < ? OR (fetched_at = ? AND id < ?))");
      args.push(opts.before.t, opts.before.t, opts.before.id);
    }
    if (opts.filter === "changed") where.push("changed = 1");
    if (opts.filter === "errors") where.push("ok = 0");
    if (opts.from !== undefined) (where.push("fetched_at >= ?"), args.push(opts.from));
    if (opts.to !== undefined) (where.push("fetched_at <= ?"), args.push(opts.to));
    return (this.db.prepare(`SELECT * FROM snapshots WHERE ${where.join(" AND ")} ORDER BY fetched_at DESC, id DESC LIMIT ?`).all(...args, opts.limit) as Row[]).map(toSnapshot);
  }

  getSnapshot(id: number): SnapshotRow | undefined {
    const r = this.db.prepare("SELECT * FROM snapshots WHERE id = ?").get(id) as Row | undefined;
    return r ? toSnapshot(r) : undefined;
  }

  previousOk(s: SnapshotRow): SnapshotRow | undefined {
    const r = this.db
      .prepare("SELECT * FROM snapshots WHERE source_id = ? AND ok = 1 AND (fetched_at < ? OR (fetched_at = ? AND id < ?)) ORDER BY fetched_at DESC, id DESC LIMIT 1")
      .get(s.sourceId, s.fetchedAt, s.fetchedAt, s.id) as Row | undefined;
    return r ? toSnapshot(r) : undefined;
  }

  deleteSnapshot(id: number): boolean {
    return tx(this.db, () => {
      const s = this.getSnapshot(id);
      if (!s) return false;
      this.db.prepare("DELETE FROM snapshots WHERE id = ?").run(id);
      this.pruneBodies(s.sourceId);
      return true;
    });
  }

  countSnapshots(sourceId: number): { total: number; errors: number; changed24h: number; okRate7d: number | null } {
    const day = Date.now() - 86_400_000;
    const week = Date.now() - 7 * 86_400_000;
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS total, SUM(ok = 0) AS errors, SUM(changed = 1 AND fetched_at >= ?) AS changed24h,
           SUM(fetched_at >= ?) AS week, SUM(fetched_at >= ? AND ok = 1) AS weekOk FROM snapshots WHERE source_id = ?`,
      )
      .get(day, week, week, sourceId) as Row;
    return { total: r.total, errors: r.errors ?? 0, changed24h: r.changed24h ?? 0, okRate7d: r.week ? (r.weekOk / r.week) * 100 : null };
  }

  /** One value per successful pull, for the "field over time" chart and export. */
  series(sourceId: number, path: string, from: number, to: number, maxPoints = 2000): { t: number; v: unknown }[] {
    const rows = this.db.prepare("SELECT fetched_at, body_id FROM snapshots WHERE source_id = ? AND ok = 1 AND fetched_at >= ? AND fetched_at <= ? ORDER BY fetched_at").all(sourceId, from, to) as Row[];
    const step = Math.max(1, Math.ceil(rows.length / maxPoints));
    const out: { t: number; v: unknown }[] = [];
    for (let i = 0; i < rows.length; i += step) {
      const r = rows[i];
      out.push({ t: r.fetched_at, v: resolve(this.loadBody(r.body_id), path) ?? null });
    }
    if (rows.length && out[out.length - 1].t !== rows[rows.length - 1].fetched_at) {
      const r = rows[rows.length - 1];
      out.push({ t: r.fetched_at, v: resolve(this.loadBody(r.body_id), path) ?? null });
    }
    return out;
  }

  // ---------------------------------------------------------------- housekeeping

  /** Applies a source's retention. The latest successful pull is always kept, so endpoints can serve. */
  prune(sourceId: number, now = Date.now()): number {
    const s = this.getSource(sourceId);
    if (!s) return 0;
    return tx(this.db, () => {
      const keep = this.latestOk(sourceId)?.snapshotId ?? -1;
      let deleted = 0;
      if (s.keepDays) deleted += Number(this.db.prepare("DELETE FROM snapshots WHERE source_id = ? AND fetched_at < ? AND id != ?").run(sourceId, now - s.keepDays * 86_400_000, keep).changes);
      if (s.keepCount) {
        deleted += Number(
          this.db
            .prepare("DELETE FROM snapshots WHERE source_id = ? AND id != ? AND id NOT IN (SELECT id FROM snapshots WHERE source_id = ? ORDER BY fetched_at DESC, id DESC LIMIT ?)")
            .run(sourceId, keep, sourceId, s.keepCount).changes,
        );
      }
      this.pruneBodies(sourceId);
      return deleted;
    });
  }

  private pruneBodies(sourceId: number) {
    const gone = this.db.prepare("SELECT id FROM bodies WHERE source_id = ? AND id NOT IN (SELECT body_id FROM snapshots WHERE source_id = ? AND body_id IS NOT NULL)").all(sourceId, sourceId) as Row[];
    for (const g of gone) this.bodyCache.delete(g.id);
    this.db.prepare("DELETE FROM bodies WHERE source_id = ? AND id NOT IN (SELECT body_id FROM snapshots WHERE source_id = ? AND body_id IS NOT NULL)").run(sourceId, sourceId);
  }

  trimRequestLog(keep: number) {
    this.db.prepare("DELETE FROM request_log WHERE id <= (SELECT id FROM request_log ORDER BY id DESC LIMIT 1 OFFSET ?)").run(keep);
  }

  storage(): { dbBytes: number; sources: { id: number; name: string; snapshots: number; storedBytes: number; rawBytes: number; oldest: number | null }[] } {
    const rows = this.db
      .prepare(
        `SELECT s.id, s.name,
           (SELECT COUNT(*) FROM snapshots WHERE source_id = s.id) AS snapshots,
           (SELECT COALESCE(SUM(LENGTH(data)), 0) FROM bodies WHERE source_id = s.id) AS storedBytes,
           (SELECT COALESCE(SUM(bytes), 0) FROM snapshots WHERE source_id = s.id) AS rawBytes,
           (SELECT MIN(fetched_at) FROM snapshots WHERE source_id = s.id) AS oldest
         FROM sources s ORDER BY s.name COLLATE NOCASE`,
      )
      .all() as Row[];
    let dbBytes = 0;
    if (this.dbFile !== ":memory:") {
      for (const f of [this.dbFile, this.dbFile + "-wal"]) {
        try {
          dbBytes += statSync(f).size;
        } catch {
          /* no WAL file yet */
        }
      }
    }
    return { dbBytes, sources: rows.map((r) => ({ id: r.id, name: r.name, snapshots: r.snapshots, storedBytes: r.storedBytes, rawBytes: r.rawBytes, oldest: r.oldest })) };
  }

  // ---------------------------------------------------------------- endpoints

  listEndpoints(): Endpoint[] {
    return (this.db.prepare("SELECT * FROM endpoints ORDER BY name COLLATE NOCASE").all() as Row[]).map(toEndpoint);
  }

  getEndpoint(id: number): Endpoint | undefined {
    const r = this.db.prepare("SELECT * FROM endpoints WHERE id = ?").get(id) as Row | undefined;
    return r ? toEndpoint(r) : undefined;
  }

  getEndpointBySlug(slug: string): Endpoint | undefined {
    const r = this.db.prepare("SELECT * FROM endpoints WHERE slug = ?").get(slug) as Row | undefined;
    return r ? toEndpoint(r) : undefined;
  }

  slugTaken(slug: string, exceptId?: number): boolean {
    return !!this.db.prepare("SELECT 1 FROM endpoints WHERE slug = ? AND id != ?").get(slug, exceptId ?? -1);
  }

  createEndpoint(e: EndpointInput, now = Date.now()): Endpoint {
    const r = this.db
      .prepare(
        `INSERT INTO endpoints (slug, name, definition, enabled, access, cors_origins, rate_limit, rate_window, rate_by, cache_ttl, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(e.slug, e.name, JSON.stringify(e.definition), e.enabled ? 1 : 0, e.access, JSON.stringify(e.corsOrigins), e.rateLimit, e.rateWindow, e.rateBy, e.cacheTtl, now, now);
    return this.getEndpoint(Number(r.lastInsertRowid))!;
  }

  updateEndpoint(id: number, e: EndpointInput, now = Date.now()): Endpoint | undefined {
    const r = this.db
      .prepare(
        `UPDATE endpoints SET slug = ?, name = ?, definition = ?, enabled = ?, access = ?, cors_origins = ?, rate_limit = ?, rate_window = ?,
           rate_by = ?, cache_ttl = ?, version = version + 1, updated_at = ? WHERE id = ?`,
      )
      .run(e.slug, e.name, JSON.stringify(e.definition), e.enabled ? 1 : 0, e.access, JSON.stringify(e.corsOrigins), e.rateLimit, e.rateWindow, e.rateBy, e.cacheTtl, now, id);
    return r.changes ? this.getEndpoint(id) : undefined;
  }

  deleteEndpoint(id: number): boolean {
    return this.db.prepare("DELETE FROM endpoints WHERE id = ?").run(id).changes > 0;
  }

  // ---------------------------------------------------------------- keys

  listKeys(endpointId: number): ApiKey[] {
    return (this.db.prepare("SELECT * FROM api_keys WHERE endpoint_id = ? ORDER BY revoked_at IS NOT NULL, created_at DESC").all(endpointId) as Row[]).map(toKey);
  }

  createKey(endpointId: number, label: string, now = Date.now()): { key: string; apiKey: ApiKey } {
    const k = newApiKey();
    const r = this.db.prepare("INSERT INTO api_keys (endpoint_id, label, key_hash, key_hint, created_at) VALUES (?, ?, ?, ?, ?)").run(endpointId, label, k.hash, k.hint, now);
    return { key: k.key, apiKey: toKey(this.db.prepare("SELECT * FROM api_keys WHERE id = ?").get(Number(r.lastInsertRowid)) as Row) };
  }

  revokeKey(id: number, now = Date.now()): boolean {
    return this.db.prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(now, id).changes > 0;
  }

  findKey(endpointId: number, key: string): ApiKey | undefined {
    const r = this.db.prepare("SELECT * FROM api_keys WHERE endpoint_id = ? AND key_hash = ? AND revoked_at IS NULL").get(endpointId, sha256(key)) as Row | undefined;
    return r ? toKey(r) : undefined;
  }

  touchKey(id: number, now = Date.now()) {
    this.db.prepare("UPDATE api_keys SET last_used_at = ?, use_count = use_count + 1 WHERE id = ?").run(now, id);
  }

  // ---------------------------------------------------------------- request log

  logRequest(e: { endpointId: number | null; slug: string; keyId: number | null; caller: string | null; ip: string; status: number; ms: number; at: number }) {
    this.db.prepare("INSERT INTO request_log (endpoint_id, slug, key_id, caller, ip, status, ms, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(e.endpointId, e.slug, e.keyId, e.caller, e.ip, e.status, e.ms, e.at);
  }

  listLog(endpointId: number, limit: number): Row[] {
    return this.db.prepare("SELECT id, caller, ip, status, ms, at FROM request_log WHERE endpoint_id = ? ORDER BY id DESC LIMIT ?").all(endpointId, limit) as Row[];
  }

  callsSince(endpointId: number, since: number): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM request_log WHERE endpoint_id = ? AND at >= ?").get(endpointId, since) as Row).n;
  }

  // ---------------------------------------------------------------- data browser

  tables(): { name: string; count: number }[] {
    return Object.keys(BROWSABLE).map((name) => ({ name, count: (this.db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get() as Row).n }));
  }

  tableRows(name: string, page: number, limit: number): { columns: string[]; rows: unknown[][]; total: number } | undefined {
    const t = BROWSABLE[name];
    if (!t) return undefined;
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get() as Row).n;
    const rows = this.db.prepare(`SELECT ${t.columns.join(", ")} FROM ${name} ORDER BY id DESC LIMIT ? OFFSET ?`).all(limit, page * limit) as Row[];
    return {
      columns: t.columns,
      total,
      rows: rows.map((r) => t.columns.map((c) => (r[c] === null ? null : t.mask?.[c] ? t.mask[c](r[c]) : r[c]))),
    };
  }

  // ---------------------------------------------------------------- config export / import

  exportConfig() {
    return {
      relay: 1,
      exportedAt: new Date().toISOString(),
      note: "Tokens and API keys are not included. Re-enter tokens after importing.",
      sources: this.listSources().map(({ id, name, method, url, headers, body, authType, authName, schedule, keepDays, keepCount, timeoutMs, enabled }) => ({ id, name, method, url, headers, body, authType, authName, schedule, keepDays, keepCount, timeoutMs, enabled })),
      endpoints: this.listEndpoints().map(({ slug, name, definition, enabled, access, corsOrigins, rateLimit, rateWindow, rateBy, cacheTtl }) => ({ slug, name, definition, enabled, access, corsOrigins, rateLimit, rateWindow, rateBy, cacheTtl })),
    };
  }

  /** Adds everything in an export as new sources and endpoints. Endpoint slugs that are taken get a suffix. */
  importConfig(cfg: { sources: (Omit<SourceInput, "authSecret"> & { id: number })[]; endpoints: EndpointInput[] }): { sources: number; endpoints: number } {
    return tx(this.db, () => {
      const idMap = new Map<number, number>();
      for (const s of cfg.sources) idMap.set(s.id, this.createSource({ ...s, authSecret: null }).id);
      const remap = (id: number) => idMap.get(id) ?? id;
      const remapNodes = (nodes: EndpointDefinition["output"]): EndpointDefinition["output"] =>
        nodes.map((n) => (n.t === "list" ? { ...n, sourceId: remap(n.sourceId), children: remapNodes(n.children) } : n.t === "object" ? { ...n, children: remapNodes(n.children) } : n));
      for (const e of cfg.endpoints) {
        let slug = e.slug;
        for (let i = 2; this.slugTaken(slug); i++) slug = `${e.slug}-${i}`;
        this.createEndpoint({ ...e, slug, enabled: false, definition: { fields: e.definition.fields.map((f) => ({ ...f, sourceId: remap(f.sourceId) })), output: remapNodes(e.definition.output) } });
      }
      return { sources: cfg.sources.length, endpoints: cfg.endpoints.length };
    });
  }
}
