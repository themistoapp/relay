import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { pino } from "pino";
import { createRelay } from "../../src/app.js";
import { loadEnv } from "../../src/config/env.js";

// A fake carbon intensity API: half-hour slots around now, the past ones with actuals. Each call
// moves on one slot, like the real feed does.
const SLOT = 30 * 60_000;
const start = Math.floor(Date.now() / SLOT) * SLOT - 2 * SLOT;
let shift = 0;
const iso = (t: number) => new Date(t).toISOString().slice(0, 16) + "Z";
const slots = () =>
  [0, 1, 2, 3].map((i) => {
    const t = start + (i + shift) * SLOT;
    return { from: iso(t), to: iso(t + SLOT), intensity: { forecast: 100 + i, actual: t < Date.now() - SLOT ? 90 + i + shift : null, index: "low" } };
  });

let upstream: Server;
let upstreamUrl: string;
const env = loadEnv({ ADMIN_PASSWORD: "correct horse battery", APP_SECRET: "test-secret-that-is-long-enough", TZ: "Europe/London" } as NodeJS.ProcessEnv);
const relay = createRelay(env, { dbFile: ":memory:", logger: pino({ level: "silent" }), retryDelays: [], jitterMs: 0 });
let cookie = "";
const admin = async (method: string, url: string, payload?: unknown) => {
  const r = await relay.admin.inject({ method: method as "GET", url: `/admin/api${url}`, payload: payload as object, headers: { cookie } });
  return { status: r.statusCode, body: r.json() };
};

beforeAll(async () => {
  upstream = createServer((_req, res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: slots() })));
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/intensity`;
  await relay.admin.ready();
  await relay.public.ready();
  const login = await relay.admin.inject({ method: "POST", url: "/admin/api/login", payload: { password: env.ADMIN_PASSWORD } });
  cookie = (login.headers["set-cookie"] as string).split(";")[0];
});

afterAll(async () => {
  await relay.close();
  upstream.close();
});

describe("keeping a history", () => {
  let sourceId: number;
  let historyId: number;
  const values = [{ id: "a", name: "intensity", path: "$.intensity.actual", fallback: "$.intensity.forecast", ops: [] }];

  it("walks through the setup steps on the latest pull", async () => {
    sourceId = (
      await admin("POST", "/sources", { name: "Carbon", method: "GET", url: upstreamUrl, headers: [], body: null, authType: "none", authName: "", schedule: "*/30 * * * *", keepDays: 1, keepCount: null, timeoutMs: 5000, enabled: true })
    ).body.id;
    expect((await admin("POST", `/sources/${sourceId}/histories/explore`, {})).body).toEqual({ hasData: false });
    await admin("POST", `/sources/${sourceId}/pull`);

    const step1 = (await admin("POST", `/sources/${sourceId}/histories/explore`, {})).body;
    expect(step1.lists[0]).toMatchObject({ rows: "$.data", kind: "list", label: "data", count: 4 });

    const step2 = (await admin("POST", `/sources/${sourceId}/histories/explore`, { rows: "$.data", rowsKind: "list" })).body;
    expect(step2.entries).toBe(4);
    expect(step2.fields.find((f: { path: string }) => f.path === "$.from").timeLike).toBe(1);

    const step3 = (await admin("POST", `/sources/${sourceId}/histories/explore`, { rows: "$.data", rowsKind: "list", time: "$.from" })).body;
    expect(step3.times[0]).toEqual({ raw: iso(start), t: start });
    expect(step3.unreadableTimes).toBe(0);

    const step4 = (await admin("POST", `/sources/${sourceId}/histories/explore`, { rows: "$.data", rowsKind: "list", time: "$.from", values })).body;
    expect(step4.result).toMatchObject({ points: 4, skipped: {}, oldest: start });
    expect(step4.result.fallbacks.a).toBeGreaterThan(0);
    expect(step4.storedPulls).toBe(1);
  });

  it("saves it, filled in from the pulls already stored", async () => {
    const bad = await admin("POST", `/sources/${sourceId}/histories`, { name: "Carbon", definition: { rows: "$.data", rowsKind: "list", time: null, values }, keepDays: 400 });
    expect(bad.body.error).toMatch(/Choose which field says when/);
    const r = await admin("POST", `/sources/${sourceId}/histories`, { name: "Carbon", definition: { rows: "$.data", rowsKind: "list", time: "$.from", values }, keepDays: 400 });
    expect(r.body.rebuilt).toEqual({ pulls: 1, points: 4 });
    historyId = r.body.history.id;
  });

  it("adds each new pull's times, without repeating the overlapping ones", async () => {
    shift = 1;
    await admin("POST", `/sources/${sourceId}/pull`);
    const list = (await admin("GET", `/sources/${sourceId}/histories`)).body;
    expect(list[0]).toMatchObject({ id: historyId, points: 5, oldest: start, usedBy: [] });
    const pts = (await admin("GET", `/histories/${historyId}/points`)).body;
    expect(pts.total).toBe(5);
  });

  it("serves it from an endpoint", async () => {
    const ep = (await admin("POST", "/endpoints", { name: "Carbon history" })).body;
    const definition = { fields: [], output: [{ id: "h", t: "history", key: "carbon", sourceId, historyId, range: "around_24h", group: "none", combine: "avg", timeFormat: "utc" }] };
    const saved = await admin("PUT", `/endpoints/${ep.id}`, { ...ep, definition, enabled: true, access: "public", cacheTtl: 0 });
    expect(saved.status).toBe(200);
    const r = await relay.public.inject({ url: "/v1/carbon-history" });
    const rows = r.json().carbon;
    expect(rows).toHaveLength(5);
    expect(rows[0]).toEqual({ time: new Date(start).toISOString().replace(".000Z", "Z"), intensity: expect.any(Number) });

    const del = await admin("DELETE", `/histories/${historyId}`);
    expect(del.status).toBe(409);
    expect(del.body.error).toMatch(/Served by Carbon history/);
  });
});
