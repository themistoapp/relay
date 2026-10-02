// Home solar straight from Home Assistant: the live state of a PV power sensor over REST, and its
// recorder statistics (hourly mean watts) over the websocket API, which REST doesn't offer.

import { dateIn, midnightIn } from "../../engine/placeholders.js";
import { HALF_HOUR, UK, addDays, averageBySlot, slotOf, solarDays, type SolarSlot, type SolarState } from "./rules.js";

export function parseStateUrl(url: string): { base: string; entityId: string } {
  const u = new URL(url);
  const m = /^(.*)\/api\/states\/([a-z0-9_]+\.[a-z0-9_]+)\/?$/i.exec(u.pathname);
  if (!m) throw new Error("Use the sensor's state URL, e.g. https://ha.example.com/api/states/sensor.pv_power");
  return { base: `${u.origin}${m[1]}`, entityId: m[2] };
}

type Mean = { start: number; mean: number };

/** Runs recorder/statistics_during_period queries over one websocket connection. */
async function statistics(base: string, token: string, entityId: string, queries: { period: "hour" | "5minute"; start: number; end: number }[], timeoutMs: number): Promise<Mean[][]> {
  const wsUrl = base.replace(/^http/, "ws") + "/api/websocket";
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const results: Mean[][] = [];
    const timer = setTimeout(() => fail(new Error(`Home Assistant websocket timed out after ${timeoutMs / 1000} s`)), timeoutMs);
    function fail(e: Error) {
      clearTimeout(timer);
      try {
        ws.close();
      } catch {}
      reject(e);
    }
    ws.onerror = () => fail(new Error("Couldn't open the Home Assistant websocket"));
    ws.onmessage = (ev) => {
      let msg: any;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return fail(new Error("Home Assistant sent something that isn't JSON"));
      }
      if (msg.type === "auth_required") ws.send(JSON.stringify({ type: "auth", access_token: token }));
      else if (msg.type === "auth_invalid") fail(new Error("Home Assistant refused the token"));
      else if (msg.type === "auth_ok") {
        queries.forEach((q, i) =>
          ws.send(
            JSON.stringify({
              id: i + 1,
              type: "recorder/statistics_during_period",
              start_time: new Date(q.start).toISOString(),
              end_time: new Date(q.end).toISOString(),
              statistic_ids: [entityId],
              period: q.period,
              types: ["mean"],
            }),
          ),
        );
      } else if (msg.type === "result") {
        if (!msg.success) return fail(new Error(`Home Assistant statistics: ${msg.error?.message ?? "failed"}`));
        const rows = (msg.result?.[entityId] ?? []) as { start: number | string; mean: number | null }[];
        results[msg.id - 1] = rows
          .map((r) => ({ start: typeof r.start === "number" ? r.start : Date.parse(r.start), mean: Number(r.mean) }))
          .filter((r) => Number.isFinite(r.start) && Number.isFinite(r.mean));
        if (queries.every((_, i) => results[i])) {
          clearTimeout(timer);
          ws.close();
          resolve(results);
        }
      }
    };
  });
}

/** The sensor's state changes from `from` to `now`, over REST. The first entry is the state at
 *  `from` (Home Assistant adds it), so the window starts with a known value. */
async function history(base: string, token: string, entityId: string, from: number, now: number, timeoutMs: number): Promise<{ t: number; w: number | null }[]> {
  const q = new URLSearchParams({ filter_entity_id: entityId, end_time: new Date(now).toISOString() });
  const r = await fetch(`${base}/api/history/period/${new Date(from).toISOString()}?${q}&minimal_response&no_attributes`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`history: HTTP ${r.status}`);
  const rows = ((await r.json()) as { state?: unknown; last_changed?: string; last_updated?: string }[][])[0] ?? [];
  return rows
    .map((x) => {
      const w = Number(x.state);
      return { t: Math.max(from, Date.parse(x.last_changed ?? x.last_updated ?? "")), w: x.state === "" || x.state === null || !Number.isFinite(w) ? null : w };
    })
    .filter((x) => Number.isFinite(x.t));
}

/**
 * Live watts, the daily totals and the half-hour averages are fetched independently. Whichever fails keeps its previous
 * value; the error is still returned so the source shows as stale.
 */
export async function fetchSolar(
  url: string,
  token: string | null,
  timeoutMs: number,
  previous: SolarState | null,
  now = Date.now(),
  /** How far back to average into half-hours: 24 h to catch up, less once caught up. */
  historyMs = 24 * 3_600_000,
): Promise<{ state: SolarState | null; slots: SolarSlot[] | null; error: string | null }> {
  if (!token) return { state: null, slots: null, error: "Add a Home Assistant long-lived access token" };
  const { base, entityId } = parseStateUrl(url);
  const hourStart = Math.floor(now / 3_600_000) * 3_600_000;
  const since = midnightIn(addDays(dateIn(now, UK), -6), UK);

  const from = slotOf(now - historyMs);
  const [live, stats, hist] = await Promise.allSettled([
    fetch(`${base}/api/states/${entityId}`, { headers: { authorization: `Bearer ${token}`, accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) }).then(async (r) => {
      if (!r.ok) throw new Error(`live state: HTTP ${r.status}`);
      return (await r.json()) as { state?: unknown };
    }),
    statistics(base, token, entityId, [
      { period: "hour", start: since, end: hourStart },
      { period: "5minute", start: hourStart, end: now },
    ], timeoutMs),
    history(base, token, entityId, from, now, timeoutMs),
  ]);

  const errors: string[] = [];
  let watts = previous?.watts ?? null;
  if (live.status === "fulfilled") {
    // Inverters often go "unavailable" overnight; that's no reading rather than the last daytime one.
    const reading = Number(live.value.state);
    watts = Number.isFinite(reading) ? Math.max(0, Math.round(reading)) : null;
  } else errors.push((live.reason as Error).message);

  let days = previous?.days ?? [];
  if (stats.status === "fulfilled") days = solarDays(stats.value[0].filter((h) => h.start < hourStart), stats.value[1], now);
  else errors.push((stats.reason as Error).message);

  let slots: SolarSlot[] | null = null;
  if (hist.status === "fulfilled") slots = averageBySlot(hist.value, from, now);
  else errors.push((hist.reason as Error).message);

  const anyOk = live.status === "fulfilled" || stats.status === "fulfilled";
  return {
    state: anyOk ? { watts, updatedAt: new Date(now).toISOString().replace(/\.\d{3}Z$/, "Z"), days } : null,
    slots,
    error: errors.length ? errors.join("; ") : null,
  };
}
