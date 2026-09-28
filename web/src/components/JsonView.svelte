<script lang="ts">
  import { childPath, parsePath, formatPath } from "$engine/paths";
  import type { Change } from "$engine/diff";

  let { value, diff = null, maxLines = 3000 }: { value: unknown; diff?: Map<string, Change> | null; maxLines?: number } = $props();

  type Line = { pad: number; key: string | null; open?: string; close?: string; prim?: { k: "s" | "n" | "l"; t: string }; comma: boolean; change?: Change; removed?: boolean };

  const parentOf = (p: string) => formatPath(parsePath(p).slice(0, -1));

  const lines = $derived.by(() => {
    const out: Line[] = [];
    const removedBy = new Map<string, { path: string; was: unknown }[]>();
    if (diff) {
      for (const [p, c] of diff) {
        if (c.kind !== "removed") continue;
        const parent = parentOf(p);
        const list = removedBy.get(parent) ?? [];
        list.push({ path: p, was: c.was });
        removedBy.set(parent, list);
      }
    }
    const prim = (v: unknown): Line["prim"] =>
      typeof v === "string" ? { k: "s", t: JSON.stringify(v) } : typeof v === "number" ? { k: "n", t: String(v) } : { k: "l", t: String(v) };
    const lastKey = (p: string) => {
      const t = parsePath(p).pop();
      return t && t.k === "key" ? t.v : null;
    };
    function walk(v: unknown, pad: number, key: string | null, path: string, comma: boolean) {
      const change = diff?.get(path);
      if (v !== null && typeof v === "object") {
        const arr = Array.isArray(v);
        const entries: [string | null, unknown, string][] = arr ? (v as unknown[]).map((x, i) => [null, x, childPath(path, i)]) : Object.entries(v as object).map(([k, x]) => [k, x, childPath(path, k)]);
        const removed = removedBy.get(path) ?? [];
        if (!entries.length && !removed.length) {
          out.push({ pad, key, prim: { k: "l", t: arr ? "[]" : "{}" }, comma, change });
          return;
        }
        out.push({ pad, key, open: arr ? "[" : "{", comma: false, change });
        entries.forEach(([k, x, p], i) => walk(x, pad + 1, k, p, i < entries.length - 1 || removed.length > 0));
        removed.forEach((r, i) => out.push({ pad: pad + 1, key: lastKey(r.path), prim: prim(typeof r.was === "object" ? JSON.stringify(r.was) : r.was), comma: i < removed.length - 1, removed: true }));
        out.push({ pad, key: null, close: arr ? "]" : "}", comma });
      } else out.push({ pad, key, prim: prim(v), comma, change });
    }
    walk(value, 0, null, "$", false);
    return out;
  });

  let showAll = $state(false);
  const shown = $derived(showAll ? lines : lines.slice(0, maxLines));
</script>

<div class="json">
  {#each shown as l}
    <div class="ln" class:chg={l.change?.kind === "changed"} class:add={l.change?.kind === "added"} class:rem={l.removed}>{"  ".repeat(l.pad)}{#if l.key !== null}<span class="k">{JSON.stringify(l.key)}</span><span class="p">: </span>{/if}{#if l.open}<span class="p">{l.open}</span>{:else if l.close}<span class="p">{l.close}</span>{:else if l.prim}<span class={l.prim.k}>{l.prim.t}</span>{/if}{#if l.comma}<span class="p">,</span>{/if}{#if l.change?.kind === "changed"}<span class="was">was {JSON.stringify(l.change.was)}</span>{:else if l.change?.kind === "added"}<span class="was">new</span>{:else if l.removed}<span class="was">removed</span>{/if}</div>
  {/each}
  {#if lines.length > shown.length}
    <div class="ln"><button class="btn sm" type="button" onclick={() => (showAll = true)}>Show all {lines.length.toLocaleString("en-GB")} lines</button></div>
  {/if}
</div>

<style>
  .json { font-family: var(--font-mono); font-size: .78rem; line-height: 1.65; padding: 12px 0; white-space: pre; min-width: max-content; }
  .ln { padding: 0 16px; }
  .k { color: var(--j-key); } .s { color: var(--j-str); } .n { color: var(--j-num); } .l { color: var(--j-lit); } .p { color: var(--muted); }
  .chg { background: var(--warn-soft); box-shadow: inset 3px 0 0 var(--warn); }
  .add { background: var(--ok-soft); box-shadow: inset 3px 0 0 var(--ok); }
  .rem { background: var(--bad-soft); box-shadow: inset 3px 0 0 var(--bad); text-decoration: line-through; text-decoration-color: var(--bad); }
  .was { color: var(--muted); font-style: italic; margin-left: 10px; text-decoration: none; display: inline-block; }
</style>
