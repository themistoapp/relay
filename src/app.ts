import { join } from "node:path";
import { pino, type Logger } from "pino";
import type { Env } from "./config/env.js";
import { openDb } from "./db/db.js";
import { Store } from "./db/store.js";
import { Secrets } from "./crypto/secrets.js";
import { Scheduler } from "./puller/scheduler.js";
import { EndpointRenderer } from "./public/renderer.js";
import { buildAdminServer } from "./admin/server.js";
import { buildPublicServer } from "./public/server.js";
import { WattsUpFeed } from "./feeds/wattsup/feed.js";

export interface RelayOptions {
  dbFile?: string;
  logger?: Logger;
  retryDelays?: number[];
  jitterMs?: number;
  webDir?: string;
  /** Spread of the feed's first polls; 0 in tests. */
  feedStartSpreadMs?: number;
}

/** Everything wired together, not yet listening. Tests use this with an in-memory database. */
export function createRelay(env: Env, opts: RelayOptions = {}) {
  const log = opts.logger ?? pino({ level: process.env.LOG_LEVEL ?? "info" });
  const secrets = new Secrets(env.APP_SECRET);
  const dbFile = opts.dbFile ?? join(env.DATA_DIR, "relay.db");
  const db = openDb(dbFile);
  const store = new Store(db, secrets, dbFile);
  const scheduler = new Scheduler(
    store,
    {
      tz: env.TZ,
      maxResponseBytes: env.MAX_RESPONSE_MB * 1024 * 1024,
      alertWebhookUrl: env.ALERT_WEBHOOK_URL,
      alertAfterFailures: env.ALERT_AFTER_FAILURES,
      backupDir: dbFile === ":memory:" ? null : join(env.DATA_DIR, "backups"),
      backupKeep: env.BACKUP_KEEP,
      requestLogKeep: env.REQUEST_LOG_KEEP,
      retryDelays: opts.retryDelays,
      jitterMs: opts.jitterMs,
    },
    log,
  );
  const renderer = new EndpointRenderer(store, env.TZ);
  const wattsUp = new WattsUpFeed(db, secrets, { maxResponseBytes: env.MAX_RESPONSE_MB * 1024 * 1024, startSpreadMs: opts.feedStartSpreadMs }, log.child({ feed: "watts-up" }));
  const admin = buildAdminServer({ env, store, scheduler, renderer, secrets, wattsUp, logger: log.child({ server: "admin" }), webDir: opts.webDir });
  const pub = buildPublicServer({ env, store, renderer, wattsUp, logger: log.child({ server: "public" }) });

  return {
    env,
    log,
    db,
    store,
    scheduler,
    renderer,
    wattsUp,
    admin,
    public: pub,
    async close() {
      scheduler.stop();
      wattsUp.stop();
      await Promise.all([admin.close(), pub.close()]);
      db.close();
    },
  };
}
