import { Cron } from "croner";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { FastifyBaseLogger } from "fastify";
import type { Store, SnapshotRow, Source } from "../db/store.js";
import { fetchWithRetry, type RequestSpec } from "./fetcher.js";
import { sendAlert } from "./alerts.js";

export interface SchedulerOptions {
  tz: string;
  maxResponseBytes: number;
  alertWebhookUrl: string;
  alertAfterFailures: number;
  backupDir: string | null;
  backupKeep: number;
  requestLogKeep: number;
  retryDelays?: number[];
  /** Random delay before a scheduled pull, so sources on the same schedule don't all fire at once. */
  jitterMs?: number;
}

export function validateCron(expr: string, tz: string): string | null {
  try {
    const c = new Cron(expr, { timezone: tz, paused: true });
    const next = c.nextRun();
    c.stop();
    return next ? null : "That schedule never runs";
  } catch (e) {
    return (e as Error).message;
  }
}

export function nextRuns(expr: string, tz: string, n = 3): number[] {
  try {
    const c = new Cron(expr, { timezone: tz, paused: true });
    const runs = c.nextRuns(n).map((d) => d.getTime());
    c.stop();
    return runs;
  } catch {
    return [];
  }
}

export class Scheduler {
  private jobs = new Map<number, Cron>();
  private house: Cron[] = [];
  private running = new Map<number, Promise<SnapshotRow>>();

  constructor(
    private readonly store: Store,
    private readonly opts: SchedulerOptions,
    private readonly log: FastifyBaseLogger,
  ) {}

  start() {
    for (const s of this.store.listSources()) this.schedule(s);
    // Housekeeping: retention and log trimming hourly, a database backup nightly.
    this.house.push(new Cron("7 * * * *", { timezone: this.opts.tz, protect: true }, () => this.housekeeping()));
    if (this.opts.backupDir && this.opts.backupKeep > 0) {
      this.house.push(new Cron("17 3 * * *", { timezone: this.opts.tz, protect: true }, () => {
        this.backup();
      }));
    }
  }

  stop() {
    for (const j of this.jobs.values()) j.stop();
    for (const j of this.house) j.stop();
    this.jobs.clear();
    this.house = [];
  }

  /** (Re)schedules one source after it's created or edited. Missed runs are never caught up. */
  schedule(s: Source) {
    this.unschedule(s.id);
    if (!s.enabled) return;
    try {
      const job = new Cron(s.schedule, { timezone: this.opts.tz, protect: true, name: `source-${s.id}` }, async () => {
        const jitter = this.opts.jitterMs ?? 3000;
        if (jitter) await new Promise((r) => setTimeout(r, Math.random() * jitter));
        await this.pull(s.id).catch((e) => this.log.error({ err: e, sourceId: s.id }, "pull failed"));
      });
      this.jobs.set(s.id, job);
    } catch (e) {
      this.log.error({ err: e, sourceId: s.id }, `bad schedule "${s.schedule}"`);
    }
  }

  unschedule(id: number) {
    this.jobs.get(id)?.stop();
    this.jobs.delete(id);
  }

  nextRun(id: number): number | null {
    return this.jobs.get(id)?.nextRun()?.getTime() ?? null;
  }

  specFor(s: Source): RequestSpec {
    return {
      method: s.method,
      url: s.url,
      headers: s.headers,
      body: s.body,
      authType: s.authType,
      authName: s.authName,
      authSecret: s.authType === "none" ? null : this.store.getSourceSecret(s.id),
      timeoutMs: s.timeoutMs,
    };
  }

  /** Pulls a source now and stores the result. Concurrent calls for the same source share one pull. */
  pull(id: number): Promise<SnapshotRow> {
    const inFlight = this.running.get(id);
    if (inFlight) return inFlight;
    const p = this.doPull(id).finally(() => this.running.delete(id));
    this.running.set(id, p);
    return p;
  }

  private async doPull(id: number): Promise<SnapshotRow> {
    const s = this.store.getSource(id);
    if (!s) throw new Error(`No source ${id}`);
    let spec: RequestSpec;
    try {
      spec = this.specFor(s);
    } catch (e) {
      return this.store.recordPull(id, { at: Date.now(), status: 0, ok: false, durationMs: 0, bytes: 0, error: (e as Error).message }).snapshot;
    }
    const res = await fetchWithRetry(spec, this.opts.maxResponseBytes, this.opts.retryDelays ?? [2000, 5000]);
    const { snapshot, failStreak, wasAlerted } = this.store.recordPull(id, res);
    if (res.ok) this.log.info({ sourceId: id, ms: res.durationMs, changed: snapshot.changed }, `pulled "${s.name}"`);
    else this.log.warn({ sourceId: id, status: res.status, error: res.error, failStreak }, `pull failed for "${s.name}"`);

    if (this.opts.alertWebhookUrl) {
      if (!res.ok && failStreak === this.opts.alertAfterFailures) {
        this.store.setAlerted(id, true);
        void sendAlert(this.opts.alertWebhookUrl, {
          title: `Relay: ${s.name} is failing`,
          message: `${failStreak} pulls in a row have failed. Last error: ${res.error}. Endpoints keep serving the last good data.`,
          source: s.name,
          status: "failing",
        }, this.log);
      } else if (res.ok && wasAlerted) {
        this.store.setAlerted(id, false);
        void sendAlert(this.opts.alertWebhookUrl, { title: `Relay: ${s.name} is back`, message: `Pulls are working again.`, source: s.name, status: "recovered" }, this.log);
      }
    }
    if (s.keepCount || s.keepDays) this.store.prune(id);
    return snapshot;
  }

  housekeeping() {
    let pruned = 0;
    for (const s of this.store.listSources()) pruned += this.store.prune(s.id);
    this.store.trimRequestLog(this.opts.requestLogKeep);
    if (pruned) this.log.info({ pruned }, "pruned old pulls");
  }

  /** Copies the database with VACUUM INTO (a consistent snapshot, safe while running). */
  backup(now = new Date()): string | null {
    const dir = this.opts.backupDir;
    if (!dir) return null;
    mkdirSync(dir, { recursive: true });
    const stamp = now.toISOString().slice(0, 16).replace(/[:T]/g, "-");
    const file = join(dir, `relay-${stamp}.db`);
    rmSync(file, { force: true });
    this.store.db.prepare("VACUUM INTO ?").run(file);
    const old = readdirSync(dir).filter((f) => /^relay-.*\.db$/.test(f)).sort().reverse().slice(this.opts.backupKeep);
    for (const f of old) rmSync(join(dir, f), { force: true });
    this.log.info({ file }, "database backed up");
    return file;
  }

  listBackups(): string[] {
    const dir = this.opts.backupDir;
    if (!dir) return [];
    try {
      return readdirSync(dir).filter((f) => /^relay-.*\.db$/.test(f)).sort().reverse();
    } catch {
      return [];
    }
  }
}
