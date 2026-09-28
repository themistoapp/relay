// What changed between two responses, keyed by path, so the History view can highlight lines.

import { childPath } from "./paths.js";

export type Change = { kind: "changed"; was: unknown } | { kind: "added" } | { kind: "removed"; was: unknown };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function diffJson(prev: unknown, next: unknown, path = "$", out = new Map<string, Change>()): Map<string, Change> {
  if (Array.isArray(prev) && Array.isArray(next)) {
    const n = Math.max(prev.length, next.length);
    for (let i = 0; i < n; i++) {
      const p = childPath(path, i);
      if (i >= prev.length) out.set(p, { kind: "added" });
      else if (i >= next.length) out.set(p, { kind: "removed", was: prev[i] });
      else diffJson(prev[i], next[i], p, out);
    }
    return out;
  }
  if (isObj(prev) && isObj(next)) {
    for (const k of Object.keys(next)) {
      const p = childPath(path, k);
      if (!(k in prev)) out.set(p, { kind: "added" });
      else diffJson(prev[k], next[k], p, out);
    }
    for (const k of Object.keys(prev)) if (!(k in next)) out.set(childPath(path, k), { kind: "removed", was: prev[k] });
    return out;
  }
  if (JSON.stringify(prev) !== JSON.stringify(next)) out.set(path, { kind: "changed", was: prev });
  return out;
}
