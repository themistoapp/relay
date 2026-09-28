import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pino } from "pino";
import Fastify from "fastify";
import { openDb } from "../../src/db/db.js";
import { Store, type SourceInput } from "../../src/db/store.js";
import { Secrets } from "../../src/crypto/secrets.js";
import { Scheduler } from "../../src/puller/scheduler.js";
import { RateLimiter, makeClientIp } from "../../src/util/net.js";

const secrets = new Secrets("unit-test-secret-long-enough");
const SOURCE: SourceInput = { name: "s", method: "GET", url: "http://x.test", headers: [], body: null, authType: "bearer", authName: "", authSecret: "tok", schedule: "* * * * *", keepDays: 1, keepCount: 3, timeoutMs: 1000, enabled: true };
const DAY = 86_400_000;
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function pull(store: Store, id: number, at: number, ok: boolean, text = `{"v":${at}}`) {
  return store.recordPull(id, ok ? { at, status: 200, ok, durationMs: 1, bytes: text.length, text } : { at, status: 500, ok, durationMs: 1, bytes: 0, error: "boom" });
}

describe("store", () => {
  it("encrypts tokens at rest", () => {
    const store = new Store(openDb(":memory:"), secrets, ":memory:");
    const s = store.createSource(SOURCE);
    const raw = store.db.prepare("SELECT auth_secret FROM sources").get() as { auth_secret: string };
    expect(raw.auth_secret).toMatch(/^v1:/);
    expect(raw.auth_secret).not.toContain("tok");
    expect(store.getSourceSecret(s.id)).toBe("tok");
    expect(() => new Secrets("a-different-secret-entirely").decrypt(raw.auth_secret)).toThrow(/APP_SECRET/);
  });

  it("prunes by age and count, but always keeps the latest good pull", () => {
    const store = new Store(openDb(":memory:"), secrets, ":memory:");
    const s = store.createSource(SOURCE);
    const now = Date.now();
    pull(store, s.id, now - 3 * DAY, true, '{"keep":"me"}');
    pull(store, s.id, now - 2 * DAY, false);
    pull(store, s.id, now - DAY / 2, false);
    // The only good pull is 3 days old, past keepDays = 1, but it's what endpoints serve.
    expect(store.prune(s.id, now)).toBe(1);
    expect(store.latestOk(s.id)!.body).toEqual({ keep: "me" });

    for (let i = 5; i > 0; i--) pull(store, s.id, now - i * 1000, true);
    store.prune(s.id, now);
    const left = store.listSnapshots(s.id, { limit: 100, filter: "all" });
    expect(left).toHaveLength(3);
    // Bodies no pull points at any more are gone too.
    const bodies = store.db.prepare("SELECT COUNT(*) AS n FROM bodies").get() as { n: number };
    expect(bodies.n).toBe(3);
  });
});

describe("scheduler", () => {
  it("backs up the database and keeps only the most recent copies", () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-"));
    dirs.push(dir);
    const file = join(dir, "relay.db");
    const store = new Store(openDb(file), secrets, file);
    store.createSource(SOURCE);
    const sched = new Scheduler(store, { tz: "UTC", maxResponseBytes: 1e6, alertWebhookUrl: "", alertAfterFailures: 3, backupDir: join(dir, "backups"), backupKeep: 2, requestLogKeep: 100 }, pino({ level: "silent" }));
    for (let d = 1; d <= 3; d++) sched.backup(new Date(`2026-09-0${d}T03:17:00Z`));
    expect(readdirSync(join(dir, "backups"))).toEqual(["relay-2026-09-02-03-17.db", "relay-2026-09-03-03-17.db"]);
    const copy = new Store(openDb(join(dir, "backups", "relay-2026-09-03-03-17.db")), secrets, "");
    expect(copy.listSources()).toHaveLength(1);
  });
});

describe("net", () => {
  it("counts requests per fixed window", () => {
    const rl = new RateLimiter();
    expect(rl.hit("a", 2, 1000, 0).allowed).toBe(true);
    expect(rl.hit("a", 2, 1000, 10).allowed).toBe(true);
    expect(rl.hit("a", 2, 1000, 20)).toMatchObject({ allowed: false, remaining: 0, resetAt: 1000 });
    expect(rl.hit("a", 2, 1000, 1000).allowed).toBe(true);
    expect(rl.hit("b", 2, 1000, 20).allowed).toBe(true);
  });

  it("reads CF-Connecting-IP only from trusted proxies", async () => {
    const app = Fastify({ trustProxy: ["loopback"] });
    const ip = makeClientIp("loopback", "cf-connecting-ip");
    app.get("/", async (req) => ({ ip: ip(req) }));
    const viaProxy = await app.inject({ url: "/", remoteAddress: "127.0.0.1", headers: { "cf-connecting-ip": "203.0.113.9" } });
    expect(viaProxy.json().ip).toBe("203.0.113.9");
    const direct = await app.inject({ url: "/", remoteAddress: "198.51.100.7", headers: { "cf-connecting-ip": "203.0.113.9" } });
    expect(direct.json().ip).toBe("198.51.100.7");
  });
});
