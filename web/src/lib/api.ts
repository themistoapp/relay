// Thin wrapper over the admin API. A 401 anywhere sends you back to the sign-in screen.
import { auth } from "./state.svelte";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly data: any,
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/admin/api${path}`, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = res.headers.get("content-type")?.includes("json") ? await res.json() : await res.text();
  if (res.status === 401 && !path.startsWith("/login")) auth.signedIn = false;
  if (!res.ok) throw new ApiError((data && data.error) || `${res.status} ${res.statusText}`, res.status, data);
  return data as T;
}

export const api = {
  get: <T>(p: string) => call<T>("GET", p),
  post: <T>(p: string, b: unknown = {}) => call<T>("POST", p, b),
  put: <T>(p: string, b: unknown) => call<T>("PUT", p, b),
  del: <T>(p: string) => call<T>("DELETE", p),
};

export const exportUrl = (p: string) => `/admin/api${p}`;
