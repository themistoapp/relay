import type { Endpoint, Store } from "../db/store.js";
import { previewFields, renderOutput, type EndpointDefinition, type FieldError, type FieldPreview, type OutNode, type Snapshot } from "../engine/render.js";

export interface Rendered {
  json: string;
  output: Record<string, unknown>;
  errors: FieldError[];
  /** When the oldest of the used sources' latest good pulls happened. */
  fetchedAt: number | null;
  /** A used source's most recent pull failed, so older data is being served. */
  stale: boolean;
  /** Used sources with no successful pull yet. */
  missing: string[];
}

export function sourcesOf(def: EndpointDefinition): number[] {
  const ids = new Set(def.fields.map((f) => f.sourceId));
  const walk = (nodes: OutNode[]) => {
    for (const n of nodes) {
      if (n.t === "list" || n.t === "history") ids.add(n.sourceId);
      if (n.t === "list" || n.t === "object") walk(n.children);
    }
  };
  walk(def.output);
  return [...ids];
}

export class EndpointRenderer {
  private cache = new Map<number, { key: string; at: number; value: Rendered }>();

  constructor(
    private readonly store: Store,
    private readonly tz: string,
  ) {}

  private context(def: EndpointDefinition, now: number) {
    const latest = new Map<number, Snapshot>();
    const missing: string[] = [];
    let fetchedAt: number | null = null;
    let stale = false;
    const keyParts: string[] = [];
    for (const id of sourcesOf(def)) {
      const src = this.store.getSource(id);
      const snap = this.store.latestOk(id);
      keyParts.push(`${id}:${snap?.snapshotId ?? "-"}`);
      if (!snap) {
        missing.push(src?.name ?? `source #${id} (deleted)`);
        continue;
      }
      latest.set(id, snap);
      fetchedAt = fetchedAt === null ? snap.t : Math.min(fetchedAt, snap.t);
      if (src && src.failStreak > 0) stale = true;
    }
    const histories = {
      get: (id: number) => this.store.getHistory(id),
      points: (id: number, from: number, to: number) => this.store.points(id, from, to),
    };
    return { ctx: { latest, history: this.store.history(), histories, now, tz: this.tz, memo: new Map<string, unknown>() }, missing, fetchedAt, stale, key: keyParts.join(",") };
  }

  /** Renders a saved endpoint, reusing the last result for up to its cache TTL while no new pull has landed. */
  render(ep: Endpoint, now = Date.now()): Rendered {
    const c = this.context(ep.definition, now);
    const key = `${ep.version}|${c.key}`;
    const hit = this.cache.get(ep.id);
    if (hit && hit.key === key && ep.cacheTtl > 0 && now - hit.at < ep.cacheTtl * 1000) return hit.value;
    const { output, errors } = renderOutput(ep.definition, c.ctx);
    const value: Rendered = { json: JSON.stringify(output), output, errors, fetchedAt: c.fetchedAt, stale: c.stale, missing: c.missing };
    this.cache.set(ep.id, { key, at: now, value });
    return value;
  }

  /** Renders an unsaved definition for the builder's live preview. */
  preview(def: EndpointDefinition, now = Date.now()): Rendered & { fields: Record<string, FieldPreview> } {
    const c = this.context(def, now);
    const { output, errors } = renderOutput(def, c.ctx);
    return { json: "", output, errors, fetchedAt: c.fetchedAt, stale: c.stale, missing: c.missing, fields: previewFields(def, c.ctx) };
  }

  forget(endpointId: number) {
    this.cache.delete(endpointId);
  }
}
