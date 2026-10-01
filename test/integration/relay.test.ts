import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { pino } from "pino";
import { createRelay } from "../../src/app.js";
import { loadEnv } from "../../src/config/env.js";

// A fake upstream fuel API. Each call can change the price, and it checks the bearer token.
let e10 = 139.9;
let calls = 0;
let failNext = 0;
let upstream: Server;
let upstreamUrl: string;

const env = loadEnv({
  ADMIN_PASSWORD: "correct horse battery",
  APP_SECRET: "test-secret-that-is-long-enough",
  PUBLIC_BASE_URL: "https://api.example.test",
  TZ: "Europe/London",
} as NodeJS.ProcessEnv);

const relay = createRelay(env, { dbFile: ":memory:", logger: pino({ level: "silent" }), retryDelays: [], jitterMs: 0 });
let cookie = "";

const admin = async (method: string, url: string, payload?: unknown) => {
  const r = await relay.admin.inject({ method: method as "GET", url: `/admin/api${url}`, payload: payload as object, headers: { cookie } });
  return { status: r.statusCode, body: r.headers["content-type"]?.includes("json") ? r.json() : r.body, headers: r.headers };
};

beforeAll(async () => {
  upstream = createServer((req, res) => {
    calls++;
    if (req.headers.authorization !== "Bearer upstream-token") {
      res.writeHead(401, { "content-type": "application/json" }).end('{"error":"bad token"}');
      return;
    }
    if (failNext > 0) {
      failNext--;
      res.writeHead(502).end("bad gateway");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        updated: "2026-09-28T09:10:44Z",
        stations: [
          { name: "Tesco", distance_km: 12.4, prices: { E10: e10, B7: 145.9 } },
          { name: "Shell", distance_km: 14.1, prices: { E10: 144.9, B7: 149.9 } },
          { name: "BP", distance_km: 2.3, prices: { E10: 146.9, B7: 151.9 } },
        ],
      }),
    );
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/prices`;
  await relay.admin.ready();
  await relay.public.ready();
});

afterAll(async () => {
  await relay.close();
  upstream.close();
});

const SOURCE = () => ({
  name: "Local fuel",
  method: "GET",
  url: upstreamUrl,
  headers: [],
  body: null,
  authType: "bearer",
  authName: "",
  authSecret: "upstream-token",
  schedule: "*/15 * * * *",
  keepDays: 30,
  keepCount: null,
  timeoutMs: 5000,
  enabled: true,
});

describe("admin auth", () => {
  it("refuses the API without a session and rejects a wrong password", async () => {
    expect((await admin("GET", "/sources")).status).toBe(401);
    expect((await admin("POST", "/login", { password: "nope" })).status).toBe(401);
    expect((await admin("GET", "/session")).body).toEqual({ signedIn: false });
  });

  it("signs in with the admin password", async () => {
    const r = await relay.admin.inject({ method: "POST", url: "/admin/api/login", payload: { password: env.ADMIN_PASSWORD } });
    expect(r.statusCode).toBe(200);
    const set = r.headers["set-cookie"] as string;
    expect(set).toMatch(/HttpOnly/);
    expect(set).toMatch(/SameSite=Lax/);
    cookie = set.split(";")[0];
    expect((await admin("GET", "/session")).body).toEqual({ signedIn: true });
  });

  it("rejects text/plain bodies, so cross-site forms can't post", async () => {
    const r = await relay.admin.inject({ method: "POST", url: "/admin/api/sources", payload: "{}", headers: { cookie, "content-type": "text/plain" } });
    expect(r.statusCode).toBe(415);
  });
});

describe("the whole flow", () => {
  let sourceId: number;
  let endpointId: number;
  let apiKey: string;

  it("tests a request without saving it", async () => {
    const r = await admin("POST", "/sources/test", SOURCE());
    expect(r.body).toMatchObject({ ok: true, status: 200 });
    expect(r.body.shape.children.stations.count).toBe(3);
    const bad = await admin("POST", "/sources/test", { ...SOURCE(), authSecret: "wrong" });
    expect(bad.body).toMatchObject({ ok: false, status: 401 });
    expect(bad.body.error).toMatch(/HTTP 401/);
  });

  it("validates sources", async () => {
    expect((await admin("POST", "/sources", { ...SOURCE(), url: "ftp://x" })).status).toBe(400);
    const cron = await admin("POST", "/sources", { ...SOURCE(), schedule: "every tuesday" });
    expect(cron.status).toBe(400);
    expect(cron.body.error).toMatch(/Schedule/);
  });

  it("creates a source, keeps its token secret, and pulls it", async () => {
    const r = await admin("POST", "/sources", SOURCE());
    expect(r.status).toBe(200);
    expect(r.body.hasSecret).toBe(true);
    expect(JSON.stringify(r.body)).not.toContain("upstream-token");
    expect(r.body.nextRun).toBeGreaterThan(Date.now());
    sourceId = r.body.id;

    const pull = await admin("POST", `/sources/${sourceId}/pull`);
    expect(pull.body.snapshot).toMatchObject({ ok: true, status: 200, changed: true });
    const latest = await admin("GET", `/sources/${sourceId}/latest`);
    expect(latest.body.body.stations[0].prices.E10).toBe(139.9);
  });

  it("keeps the stored token when a source is edited without re-entering it", async () => {
    const { authSecret: _, ...rest } = SOURCE();
    const r = await admin("PUT", `/sources/${sourceId}`, { ...rest, name: "Local fuel prices" });
    expect(r.body.hasSecret).toBe(true);
    const test = await admin("POST", "/sources/test", { ...rest, id: sourceId });
    expect(test.body.ok).toBe(true);
  });

  it("stores an unchanged response once, and records failures", async () => {
    await admin("POST", `/sources/${sourceId}/pull`);
    failNext = 1;
    const failed = await admin("POST", `/sources/${sourceId}/pull`);
    expect(failed.body.snapshot).toMatchObject({ ok: false, status: 502 });
    e10 = 138.9;
    const changed = await admin("POST", `/sources/${sourceId}/pull`);
    expect(changed.body.snapshot.changed).toBe(true);

    const list = await admin("GET", `/sources/${sourceId}/snapshots`);
    expect(list.body.rows.map((s: any) => [s.ok, s.changed])).toEqual([[true, true], [false, false], [true, false], [true, true]]);
    const bodies = relay.db.prepare("SELECT COUNT(*) AS n FROM bodies").get() as { n: number };
    expect(bodies.n).toBe(2);

    const errors = await admin("GET", `/sources/${sourceId}/snapshots?filter=errors`);
    expect(errors.body.rows).toHaveLength(1);
  });

  it("shows a pull with the previous good one for diffing, and a field over time", async () => {
    const list = await admin("GET", `/sources/${sourceId}/snapshots?limit=1`);
    const r = await admin("GET", `/snapshots/${list.body.rows[0].id}`);
    expect(r.body.body.stations[0].prices.E10).toBe(138.9);
    expect(r.body.previous.body.stations[0].prices.E10).toBe(139.9);
    expect(list.body.next).toMatch(/^\d+:\d+$/);

    const series = await admin("GET", `/sources/${sourceId}/series?path=${encodeURIComponent("$.stations[0].prices.E10")}&from=0`);
    expect(series.body.points.map((p: any) => p.v)).toEqual([139.9, 139.9, 138.9]);

    const csv = await admin("GET", `/sources/${sourceId}/export?format=csv&what=series&path=${encodeURIComponent("$.stations[0].prices.E10")}`);
    expect(csv.headers["content-disposition"]).toMatch(/attachment; filename="local-fuel-prices-series-/);
    expect(csv.body.trim().split("\n")).toHaveLength(4);
  });

  it("won't delete the pull endpoints are serving", async () => {
    const list = await admin("GET", `/sources/${sourceId}/snapshots?limit=1`);
    expect((await admin("DELETE", `/snapshots/${list.body.rows[0].id}`)).status).toBe(409);
  });

  it("builds an endpoint and previews it live", async () => {
    const created = await admin("POST", "/endpoints", { name: "Fuel prices" });
    expect(created.body).toMatchObject({ slug: "fuel-prices", enabled: false, access: "key" });
    endpointId = created.body.id;

    const definition = {
      fields: [
        { id: "e10", name: "cheapest_e10", sourceId, path: "$.stations[*].prices.E10", mode: "value", ops: [{ op: "min" }, { op: "divide", args: { n: 100 } }] },
        { id: "chg", name: "e10_change", sourceId, path: "$.stations[*].prices.E10", mode: "value", ops: [{ op: "min" }, { op: "change", args: { window: "24h" } }] },
        { id: "name", name: "name", sourceId, path: "$.stations[*].name", mode: "row", ops: [] },
        { id: "miles", name: "miles", sourceId, path: "$.stations[*].distance_km", mode: "row", ops: [{ op: "multiply", args: { n: 0.621 } }, { op: "round", args: { dp: 1 } }] },
      ],
      output: [
        { id: "a", t: "field", key: "cheapest_e10", fieldId: "e10" },
        { id: "b", t: "field", key: "e10_change_24h", fieldId: "chg" },
        { id: "c", t: "list", key: "nearest", sourceId, over: "$.stations[*]", sort: "miles", dir: "asc", limit: 2, children: [
          { id: "d", t: "field", key: "name", fieldId: "name" },
          { id: "e", t: "field", key: "miles", fieldId: "miles" },
        ] },
      ],
    };
    const preview = await admin("POST", "/preview", { definition });
    expect(preview.body.errors).toEqual([]);
    expect(preview.body.output).toEqual({ cheapest_e10: 1.389, e10_change_24h: -1, nearest: [{ name: "BP", miles: 1.4 }, { name: "Tesco", miles: 7.7 }] });
    expect(preview.body.fields.miles).toEqual({ input: 12.4, output: 7.7, row: true });

    const saved = await admin("PUT", `/endpoints/${endpointId}`, {
      ...created.body,
      definition,
      enabled: true,
      corsOrigins: ["https://app.example.com"],
      rateLimit: 3,
      rateWindow: "minute",
      rateBy: "key",
      cacheTtl: 0,
    });
    expect(saved.status).toBe(200);

    const bad = await admin("PUT", `/endpoints/${endpointId}`, { ...saved.body, slug: "Not A Slug" });
    expect(bad.status).toBe(400);
  });

  it("serves the endpoint only with a valid key", async () => {
    const noKey = await relay.public.inject({ url: "/v1/fuel-prices" });
    expect(noKey.statusCode).toBe(401);

    const k = await admin("POST", `/endpoints/${endpointId}/keys`, { label: "Home Assistant" });
    apiKey = k.body.key;
    expect(apiKey).toMatch(/^rly_/);
    expect(k.body.apiKey.hint).toBe(apiKey.slice(-4));

    const wrong = await relay.public.inject({ url: "/v1/fuel-prices", headers: { "x-api-key": "rly_nope" } });
    expect(wrong.statusCode).toBe(401);

    const ok = await relay.public.inject({ url: "/v1/fuel-prices", headers: { "x-api-key": apiKey } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ cheapest_e10: 1.389, nearest: [{ name: "BP", miles: 1.4 }, { name: "Tesco", miles: 7.7 }] });
    expect(ok.headers["x-relay-fetched-at"]).toBeDefined();
    expect(ok.headers["x-relay-stale"]).toBeUndefined();
    expect(ok.headers["cache-control"]).toBe("no-store");

    const viaQuery = await relay.public.inject({ url: `/v1/fuel-prices?key=${apiKey}` });
    expect(viaQuery.statusCode).toBe(200);
  });

  it("answers CORS only for allowed origins", async () => {
    const allowed = await relay.public.inject({ method: "OPTIONS", url: "/v1/fuel-prices", headers: { origin: "https://app.example.com", "access-control-request-method": "GET" } });
    expect(allowed.statusCode).toBe(204);
    expect(allowed.headers["access-control-allow-origin"]).toBe("https://app.example.com");
    expect(allowed.headers["access-control-allow-headers"]).toMatch(/X-Api-Key/);

    const denied = await relay.public.inject({ method: "OPTIONS", url: "/v1/fuel-prices", headers: { origin: "https://evil.example", "access-control-request-method": "GET" } });
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("rate limits per key and says when to retry", async () => {
    // The limit is 3 a minute and the key has made 2 calls already.
    const third = await relay.public.inject({ url: "/v1/fuel-prices", headers: { "x-api-key": apiKey } });
    expect(third.statusCode).toBe(200);
    expect(third.headers["x-ratelimit-remaining"]).toBe("0");
    const fourth = await relay.public.inject({ url: "/v1/fuel-prices", headers: { "x-api-key": apiKey } });
    expect(fourth.statusCode).toBe(429);
    expect(Number(fourth.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("marks data as stale after a failed pull, and keeps serving it", async () => {
    await admin("PUT", `/endpoints/${endpointId}`, { ...(await admin("GET", `/endpoints/${endpointId}`)).body, rateLimit: 100 });
    failNext = 1;
    await admin("POST", `/sources/${sourceId}/pull`);
    const r = await relay.public.inject({ url: "/v1/fuel-prices", headers: { "x-api-key": apiKey } });
    expect(r.statusCode).toBe(200);
    expect(r.headers["x-relay-stale"]).toBe("true");
    expect(r.json().cheapest_e10).toBe(1.389);
  });

  it("logs requests, and revoked keys stop working", async () => {
    const log = await admin("GET", `/endpoints/${endpointId}/log`);
    expect(log.body.map((l: any) => l.status)).toContain(429);
    expect(log.body.find((l: any) => l.status === 200).caller).toBe("Home Assistant");

    const keys = await admin("GET", `/endpoints/${endpointId}/keys`);
    await admin("DELETE", `/keys/${keys.body[0].id}`);
    const r = await relay.public.inject({ url: "/v1/fuel-prices", headers: { "x-api-key": apiKey } });
    expect(r.statusCode).toBe(401);
  });

  it("serves public endpoints without a key, and hides disabled ones", async () => {
    const ep = (await admin("GET", `/endpoints/${endpointId}`)).body;
    await admin("PUT", `/endpoints/${endpointId}`, { ...ep, access: "public" });
    expect((await relay.public.inject({ url: "/v1/fuel-prices" })).statusCode).toBe(200);
    await admin("PUT", `/endpoints/${endpointId}`, { ...ep, access: "public", enabled: false });
    expect((await relay.public.inject({ url: "/v1/fuel-prices" })).statusCode).toBe(404);
    // The admin API isn't reachable on the public port at all.
    expect((await relay.public.inject({ url: "/admin/api/sources" })).statusCode).toBe(404);
  });

  it("browses tables with secrets masked", async () => {
    const tables = await admin("GET", "/tables");
    expect(tables.body.map((t: any) => t.name)).toEqual(["sources", "snapshots", "bodies", "endpoints", "histories", "api_keys", "request_log"]);
    const sources = await admin("GET", "/tables/sources");
    const col = sources.body.columns.indexOf("auth_secret");
    expect(sources.body.rows[0][col]).toMatch(/hidden/);
    const keys = await admin("GET", "/tables/api_keys");
    expect(JSON.stringify(keys.body)).not.toMatch(/[0-9a-f]{64}/);
    expect((await admin("GET", "/tables/sqlite_master")).status).toBe(404);
  });

  it("exports and re-imports config without secrets", async () => {
    const exp = await admin("GET", "/config/export");
    expect(exp.headers["content-disposition"]).toMatch(/relay-config-/);
    const cfg = exp.body;
    expect(JSON.stringify(cfg)).not.toContain("upstream-token");
    const imp = await admin("POST", "/config/import", cfg);
    expect(imp.body).toEqual({ sources: 1, histories: 0, endpoints: 1 });
    const eps = (await admin("GET", "/endpoints")).body;
    expect(eps.map((e: any) => e.slug).sort()).toEqual(["fuel-prices", "fuel-prices-2"]);
    const copy = eps.find((e: any) => e.slug === "fuel-prices-2");
    expect(copy.definition.fields[0].sourceId).not.toBe(sourceId);
  });

  it("warns before deleting a source an endpoint uses", async () => {
    const r = await admin("DELETE", `/sources/${sourceId}`);
    expect(r.status).toBe(409);
    expect(r.body.usedBy[0].slug).toBe("fuel-prices");
    expect((await admin("DELETE", `/sources/${sourceId}?force=1`)).status).toBe(200);
  });
});

describe("public address shown in the UI", () => {
  it("uses PUBLIC_BASE_URL when set", async () => {
    const r = await relay.admin.inject({ url: "/admin/api/meta", headers: { cookie } });
    expect(r.json()).toMatchObject({ publicBaseUrl: "https://api.example.test", publicBaseUrlSet: true });
  });

  it("otherwise uses the admin UI's host with the public host port", async () => {
    const bare = createRelay(loadEnv({ ADMIN_PASSWORD: env.ADMIN_PASSWORD, APP_SECRET: env.APP_SECRET, PUBLIC_HOST_PORT: "1099" } as NodeJS.ProcessEnv), { dbFile: ":memory:", logger: pino({ level: "silent" }) });
    const login = await bare.admin.inject({ method: "POST", url: "/admin/api/login", payload: { password: env.ADMIN_PASSWORD } });
    const c = (login.headers["set-cookie"] as string).split(";")[0];
    const r = await bare.admin.inject({ url: "/admin/api/meta", headers: { cookie: c, host: "192.168.1.2:1098" } });
    expect(r.json()).toMatchObject({ publicBaseUrl: "http://192.168.1.2:1099", publicBaseUrlSet: false });
    await bare.close();
  });
});
