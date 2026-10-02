import { brotliCompressSync, constants as zlib, gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import type { DB } from "../../db/db.js";
import type { Secrets } from "../../crypto/secrets.js";
import { buildRequest, fetchOnce } from "../../puller/fetcher.js";
import { dateIn } from "../../engine/placeholders.js";
import { FEED, SOURCE_DEFAULTS, type FeedSettings, type SourceKey } from "./defaults.js";
import { WattsUpStore, type FeedSource, type FeedSourceInput } from "./store.js";
import { buildResponse } from "./response.js";
import { fetchSolar } from "./solar.js";
import {
  UK,
  readCarbon,
  readCarbonMix,
  readDemandForecast,
  readDemandOutturn,
  readDfs,
  readFuelinst,
  readIndgen,
  readWholesale,
  readAgile,
  shapeError,
  window3,
  type SolarState,
} from "./rules.js";

export interface PollResult {
  key: SourceKey;
  ok: boolean;
  at: number;
  durationMs: number;
  rows: number;
  latestPublish: number | null;
  error: string | null;
  /** Which URL was called (after placeholders), for the admin UI. */
  url: string | null;
  backfill: boolean;
}

/** What a source's response turned into: how many rows, and how to save them. */
interface Parsed {
  rows: number;
  latestPublish: number | null;
  save: () => void;
  sample: unknown[];
}

export interface Built {
  json: string;
  gzip: Buffer;
  br: Buffer;
  etag: string;
  builtAt: number;
  localDate: string;
}

const maxOf = (xs: number[]) => (xs.length ? Math.max(...xs) : null);
const inWindow = <T extends { start: number }>(xs: T[], now: number) => {
  const w = window3(now);
  return xs.filter((x) => x.start >= w.from && x.start < w.to);
};

export interface FeedOptions {
  maxResponseBytes: number;
  /** Longest random wait before a source's first poll, so they don't all start together. */
  startSpreadMs?: number;
  /** Set false in tests to poll only on demand. */
  autoStart?: boolean;
}

/**
 * The Watts Up feed: polls each upstream on its own timer, saves what came back into half-hour
 * rows, and keeps the serialized /v1/watts-up response ready so a request never waits on an
 * upstream. A failing source only marks itself stale; everything else carries on.
 */
export class WattsUpFeed {
  readonly store: WattsUpStore;
  private timers = new Map<SourceKey, ReturnType<typeof setTimeout>>();
  private nextAt = new Map<SourceKey, number>();
  private running = new Map<SourceKey, Promise<PollResult>>();
  /** Sources that have caught up (backfill) since this process started. */
  private caughtUp = new Set<SourceKey>();
  private built: Built | null = null;
  private buildError: string | null = null;
  private rebuildTimer: ReturnType<typeof setTimeout> | null = null;
  private house: ReturnType<typeof setInterval> | null = null;
  private stopped = true;

  constructor(
    db: DB,
    secrets: Secrets,
    private readonly opts: FeedOptions,
    private readonly log: FastifyBaseLogger,
  ) {
    this.store = new WattsUpStore(db, secrets);
    const added = this.store.seed();
    if (added.length) this.log.info({ feed: FEED, added }, "seeded Watts Up feed sources");
    this.rebuild();
  }

  start() {
    this.stopped = false;
    const spread = this.opts.startSpreadMs ?? 20_000;
    for (const s of this.store.listSources()) this.scheduleIn(s.key, Math.random() * spread);
    // Once a minute: roll over to a new day's slots at midnight, and prune old rows hourly.
    let ticks = 0;
    this.house = setInterval(() => {
      if (this.built && this.built.localDate !== dateIn(Date.now(), UK)) this.rebuild();
      if (++ticks % 60 === 1) this.prune();
    }, 60_000);
    this.house.unref?.();
  }

  stop() {
    this.stopped = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.nextAt.clear();
    if (this.house) clearInterval(this.house);
    if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
  }

  settings(): FeedSettings {
    return this.store.settings();
  }

  nextPoll(key: SourceKey): number | null {
    return this.nextAt.get(key) ?? null;
  }

  private scheduleIn(key: SourceKey, ms: number) {
    clearTimeout(this.timers.get(key));
    this.timers.delete(key);
    this.nextAt.delete(key);
    const s = this.store.getSource(key);
    if (this.stopped || !s?.enabled) return;
    const t = setTimeout(() => {
      this.timers.delete(key);
      this.poll(key).catch((e) => this.log.error({ err: e, feed: FEED, source: key }, "feed poll crashed"));
    }, ms);
    t.unref?.();
    this.timers.set(key, t);
    this.nextAt.set(key, Date.now() + ms);
  }

  /** After a success, the normal interval (with a little jitter). After a failure, sooner, backing
   *  off: 1, 2, 4… minutes, never longer than the normal interval. */
  private scheduleNext(s: FeedSource) {
    const interval = s.intervalMin * 60_000;
    const delay = s.failStreak > 0 ? Math.min(interval, 60_000 * 2 ** Math.min(s.failStreak - 1, 6)) : interval;
    this.scheduleIn(s.key, delay + Math.random() * Math.min(15_000, delay * 0.05));
  }

  /** Polls a source now. Calls for a source that's already polling share that poll. */
  poll(key: SourceKey): Promise<PollResult> {
    const inFlight = this.running.get(key);
    if (inFlight) return inFlight;
    const p = this.doPoll(key).finally(() => this.running.delete(key));
    this.running.set(key, p);
    return p;
  }

  private async doPoll(key: SourceKey): Promise<PollResult> {
    const s = this.store.getSource(key);
    if (!s) throw new Error(`No feed source ${key}`);
    const r = await this.fetchAndParse(s);
    if (r.parsed && r.ok) {
      try {
        r.parsed.save();
      } catch (e) {
        r.ok = false;
        r.error = `Couldn't save: ${(e as Error).message}`;
        this.log.error({ err: e, feed: FEED, source: key }, "feed save failed");
      }
    }
    // Solar can half-work: keep what came back, but report the part that didn't.
    const partial = r.ok && !!r.error;
    this.store.recordAttempt(key, { at: r.at, ok: r.ok && !partial, durationMs: r.durationMs, rows: r.rows, latestPublish: r.latestPublish, error: r.error });
    if (r.ok && !r.error) {
      if (r.backfill || !s.backfillUrl) this.caughtUp.add(key);
      this.log.info({ feed: FEED, source: key, rows: r.rows, ms: r.durationMs, backfill: r.backfill || undefined }, `polled ${s.name}`);
    } else this.log.warn({ feed: FEED, source: key, error: r.error }, `poll failed for ${s.name}`);
    this.rebuildSoon();
    this.scheduleNext(this.store.getSource(key)!);
    const { parsed: _p, ...result } = r;
    return result;
  }

  /** Calls a source and reads its response without saving anything (also used by "Test"). */
  async fetchAndParse(s: FeedSource, override?: Partial<FeedSourceInput>): Promise<PollResult & { parsed?: Parsed }> {
    const url = override?.url ?? s.url;
    const backfillUrl = override?.backfillUrl !== undefined ? override.backfillUrl : s.backfillUrl;
    const authType = override?.authType ?? s.authType;
    const secret = authType === "none" ? null : override?.authSecret ? override.authSecret : this.store.getSecret(s.key);
    const timeoutMs = override?.timeoutMs ?? s.timeoutMs;
    const now = Date.now();
    // Catch up on the first poll since starting, or after an hour without a good one.
    const backfill = !!backfillUrl && (!this.caughtUp.has(s.key) || !s.lastSuccessAt || now - s.lastSuccessAt > 60 * 60_000);
    const base = { key: s.key, at: now, rows: 0, latestPublish: null, backfill };

    if (s.key === "solar") {
      const started = performance.now();
      try {
        const prev = this.store.value<SolarState>("solar")?.data ?? null;
        // Average the last 24 hours into half-hours when catching up; after that, the last 90 minutes.
        const catchUp = !this.caughtUp.has(s.key) || !s.lastSuccessAt || now - s.lastSuccessAt > 60 * 60_000;
        const { state, slots, error } = await fetchSolar(url, secret, timeoutMs, prev, now, catchUp ? 24 * 3_600_000 : 90 * 60_000);
        const durationMs = Math.round(performance.now() - started);
        if (!state && !slots) return { ...base, ok: false, durationMs, error, url };
        const parsed: Parsed = {
          rows: slots?.length ?? 0,
          latestPublish: null,
          save: () => {
            if (state) this.store.setValue("solar", state);
            if (slots) this.store.saveHomeSolar(slots);
          },
          sample: [{ ...state, halfHours: slots?.slice(-6) }],
        };
        return { ...base, backfill: catchUp, ok: true, durationMs, rows: parsed.rows, error, url, parsed };
      } catch (e) {
        return { ...base, ok: false, durationMs: Math.round(performance.now() - started), error: (e as Error).message, url };
      }
    }

    const target = backfill ? backfillUrl! : url;
    const res = await fetchOnce(
      { method: "GET", url: target, headers: [], body: null, authType, authName: "", authSecret: secret, timeoutMs },
      this.opts.maxResponseBytes,
    );
    let called: string | null = null;
    try {
      called = buildRequest({ method: "GET", url: target, headers: [], body: null, authType: "none", authName: "", authSecret: null, timeoutMs }, res.at).url;
    } catch {}
    if (!res.ok) return { ...base, ok: false, durationMs: res.durationMs, error: res.error ?? `HTTP ${res.status}`, url: called };
    try {
      const parsed = this.parse(s.key, res.json, now);
      if (parsed.rows === 0 && s.key !== "dfs") return { ...base, ok: false, durationMs: res.durationMs, error: "The response had no usable rows", url: called };
      return { ...base, ok: true, durationMs: res.durationMs, rows: parsed.rows, latestPublish: parsed.latestPublish, error: null, url: called, parsed };
    } catch (e) {
      return { ...base, ok: false, durationMs: res.durationMs, error: shapeError(e) ?? (e as Error).message, url: called };
    }
  }

  private parse(key: SourceKey, json: unknown, now: number): Parsed {
    const st = this.store;
    switch (key) {
      case "fuelinst": {
        const xs = readFuelinst(json);
        return { rows: xs.length, latestPublish: maxOf(xs.map((x) => x.publish)), save: () => st.saveFuel(xs), sample: xs.slice(0, 20) };
      }
      case "demandOutturn": {
        const xs = inWindow(readDemandOutturn(json), now);
        return { rows: xs.length, latestPublish: maxOf(xs.map((x) => x.publish)), save: () => st.saveDemand(xs), sample: xs.slice(-6) };
      }
      case "demandForecast": {
        const xs = inWindow(readDemandForecast(json), now);
        return { rows: xs.length, latestPublish: maxOf(xs.map((x) => x.publish)), save: () => st.saveDemandForecast(xs), sample: xs.slice(0, 6) };
      }
      case "indgen": {
        const xs = inWindow(readIndgen(json), now);
        return { rows: xs.length, latestPublish: maxOf(xs.map((x) => x.publish)), save: () => st.saveIndgen(xs), sample: xs.slice(0, 6) };
      }
      case "carbon": {
        const xs = inWindow(readCarbon(json), now);
        return { rows: xs.length, latestPublish: null, save: () => st.saveCarbon(xs), sample: xs.slice(0, 6) };
      }
      case "carbonMix": {
        const mix = readCarbonMix(json);
        const n = Object.keys(mix.fuelsPercent).length;
        return { rows: n, latestPublish: mix.from ? Date.parse(mix.from) : null, save: () => st.setValue("carbonMix", mix), sample: [mix] };
      }
      case "wholesale": {
        const xs = inWindow(readWholesale(json), now);
        return { rows: xs.length, latestPublish: null, save: () => st.saveWholesale(xs), sample: xs.slice(0, 6) };
      }
      case "agile": {
        const xs = inWindow(readAgile(json), now);
        return { rows: xs.length, latestPublish: null, save: () => st.saveAgile(xs), sample: xs.slice(0, 6) };
      }
      case "dfs": {
        const xs = readDfs(json).filter((e) => e.end > now - 30 * 86_400_000);
        return { rows: xs.length, latestPublish: null, save: () => st.saveDfs(xs), sample: xs.slice(0, 6) };
      }
      default:
        throw new Error(`No reader for ${key}`);
    }
  }

  // ---------------------------------------------------------------- editing

  updateSource(key: SourceKey, input: FeedSourceInput): FeedSource | undefined {
    const s = this.store.updateSource(key, input);
    if (s) {
      if (input.backfillUrl !== undefined) this.caughtUp.delete(key);
      this.scheduleIn(key, 2_000);
    }
    this.rebuildSoon();
    return s;
  }

  resetSource(key: SourceKey): FeedSource | undefined {
    const d = SOURCE_DEFAULTS.find((x) => x.key === key);
    if (!d) return undefined;
    const s = this.store.resetSource(d);
    this.caughtUp.delete(key);
    this.scheduleIn(key, 2_000);
    this.rebuildSoon();
    return s;
  }

  saveSettings(s: FeedSettings) {
    this.store.saveSettings(s);
    this.rebuild();
  }

  // ---------------------------------------------------------------- the response

  private rebuildSoon() {
    if (this.rebuildTimer) return;
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = null;
      this.rebuild();
    }, 250);
    this.rebuildTimer.unref?.();
  }

  /** Builds and compresses the response. If that fails, the previous one keeps being served. */
  rebuild(now = Date.now()): Built | null {
    try {
      const json = JSON.stringify(buildResponse(this.store, this.store.settings(), now));
      const buf = Buffer.from(json);
      this.built = {
        json,
        gzip: gzipSync(buf, { level: 9 }),
        br: brotliCompressSync(buf, { params: { [zlib.BROTLI_PARAM_QUALITY]: 9, [zlib.BROTLI_PARAM_SIZE_HINT]: buf.length } }),
        etag: `"${createHash("sha1").update(json).digest("base64url")}"`,
        builtAt: now,
        localDate: dateIn(now, UK),
      };
      this.buildError = null;
    } catch (e) {
      this.buildError = (e as Error).message;
      this.log.error({ err: e, feed: FEED }, "couldn't build the Watts Up response; serving the previous one");
    }
    return this.built;
  }

  /** The response to serve. Rebuilt (from the database only) if the UK date has moved on. */
  current(now = Date.now()): Built | null {
    if (!this.built || this.built.localDate !== dateIn(now, UK)) this.rebuild(now);
    return this.built;
  }

  buildInfo() {
    return this.built
      ? { builtAt: this.built.builtAt, bytes: Buffer.byteLength(this.built.json), gzipBytes: this.built.gzip.length, brBytes: this.built.br.length, etag: this.built.etag, error: this.buildError }
      : { builtAt: null, bytes: 0, gzipBytes: 0, brBytes: 0, etag: null, error: this.buildError };
  }

  prune(now = Date.now()) {
    const n = this.store.prune(now - this.store.settings().retainDays * 86_400_000);
    if (n) this.log.info({ feed: FEED, rows: n }, "pruned old Watts Up rows");
  }
}
