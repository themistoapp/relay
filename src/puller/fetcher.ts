import type { AuthType, PullResult } from "../db/store.js";

export interface RequestSpec {
  method: string;
  url: string;
  headers: { key: string; value: string }[];
  body: string | null;
  authType: AuthType;
  authName: string;
  authSecret: string | null;
  timeoutMs: number;
}

const USER_AGENT = "Relay/0.1 (self-hosted API relay)";

export function buildRequest(spec: RequestSpec): { url: string; init: RequestInit } {
  const url = new URL(spec.url);
  const headers = new Headers({ "user-agent": USER_AGENT, accept: "application/json" });
  for (const h of spec.headers) if (h.key.trim()) headers.set(h.key.trim(), h.value);
  const secret = spec.authSecret ?? "";
  switch (spec.authType) {
    case "bearer":
      headers.set("authorization", `Bearer ${secret}`);
      break;
    case "header":
      headers.set(spec.authName || "x-api-key", secret);
      break;
    case "basic":
      headers.set("authorization", "Basic " + Buffer.from(`${spec.authName}:${secret}`).toString("base64"));
      break;
    case "query":
      url.searchParams.set(spec.authName || "key", secret);
      break;
  }
  const init: RequestInit = { method: spec.method, headers, redirect: "follow" };
  if (spec.body && spec.method !== "GET" && spec.method !== "HEAD") {
    init.body = spec.body;
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
  }
  return { url: url.toString(), init };
}

async function readLimited(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`Response is bigger than ${Math.round(maxBytes / 1048576)} MB (MAX_RESPONSE_MB)`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function describeError(e: unknown, timeoutMs: number): string {
  const err = e as Error & { cause?: { code?: string; message?: string } };
  if (err.name === "TimeoutError" || err.name === "AbortError") return `Timed out after ${Math.round(timeoutMs / 100) / 10} s`;
  const code = err.cause?.code;
  if (code === "ENOTFOUND") return "Couldn't find that host (DNS lookup failed)";
  if (code === "ECONNREFUSED") return "Connection refused";
  if (code) return `Couldn't connect: ${code}`;
  return err.cause?.message || err.message || String(e);
}

/** Calls an upstream API once. Never throws: failures come back as a PullResult with ok = false. */
export async function fetchOnce(spec: RequestSpec, maxBytes: number, now = () => Date.now()): Promise<PullResult & { json?: unknown }> {
  const at = now();
  const started = performance.now();
  const ms = () => Math.round(performance.now() - started);
  let url: string;
  let init: RequestInit;
  try {
    ({ url, init } = buildRequest(spec));
  } catch (e) {
    return { at, status: 0, ok: false, durationMs: 0, bytes: 0, error: `Bad request settings: ${(e as Error).message}` };
  }
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(spec.timeoutMs) });
  } catch (e) {
    return { at, status: 0, ok: false, durationMs: ms(), bytes: 0, error: describeError(e, spec.timeoutMs) };
  }
  let text: string;
  try {
    text = await readLimited(res, maxBytes);
  } catch (e) {
    return { at, status: res.status, ok: false, durationMs: ms(), bytes: 0, error: describeError(e, spec.timeoutMs) };
  }
  const bytes = Buffer.byteLength(text);
  if (!res.ok) {
    const snippet = text.slice(0, 200).replace(/\s+/g, " ").trim();
    return { at, status: res.status, ok: false, durationMs: ms(), bytes, error: `HTTP ${res.status} ${res.statusText}${snippet ? `: ${snippet}` : ""}` };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    const type = res.headers.get("content-type") ?? "unknown type";
    return { at, status: res.status, ok: false, durationMs: ms(), bytes, error: `The response isn't JSON (${type})` };
  }
  return { at, status: res.status, ok: true, durationMs: ms(), bytes, text, json };
}

const RETRYABLE = (r: PullResult) => !r.ok && (r.status === 0 || r.status >= 500 || r.status === 429);

/** Calls with retries on network errors, 5xx and 429. */
export async function fetchWithRetry(spec: RequestSpec, maxBytes: number, delays: number[]): Promise<PullResult & { json?: unknown }> {
  let r = await fetchOnce(spec, maxBytes);
  for (const d of delays) {
    if (!RETRYABLE(r)) break;
    await new Promise((res) => setTimeout(res, d));
    const first = r.at;
    r = { ...(await fetchOnce(spec, maxBytes)), at: first };
  }
  return r;
}
