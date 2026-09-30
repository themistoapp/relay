<script lang="ts">
  import { childPath } from "$engine/paths";
  import type { ShapeNode } from "$engine/shape";

  let {
    shape,
    usedBy = null,
    onToggle = null,
  }: {
    shape: ShapeNode;
    /** In pick mode: the names of fields that use a path. */
    usedBy?: ((path: string) => string[]) | null;
    onToggle?: ((path: string, checked: boolean) => void) | null;
  } = $props();

  let collapsed = $state(new Set<string>());
  const toggle = (p: string) => {
    const next = new Set(collapsed);
    if (next.has(p)) next.delete(p);
    else next.add(p);
    collapsed = next;
  };
  const sample = (v: unknown) => {
    const s = JSON.stringify(v);
    return s === undefined ? "" : s.length > 40 ? s.slice(0, 39) + "…" : s;
  };
</script>

{#snippet node(sh: ShapeNode, key: string | null, path: string, depth: number)}
  {#if sh.type === "object" || sh.type === "array"}
    {#if key !== null}
      {@const used = usedBy ? usedBy(path) : []}
      <!-- A whole object or list can be picked too: it's served as it is, whatever keys it holds. -->
      <div class="trow" class:picked={used.length > 0} style:padding-left="{8 + depth * 18}px">
        {#if onToggle}
          <input type="checkbox" checked={used.length > 0} onchange={(e) => onToggle(path, e.currentTarget.checked)} aria-label="Pick all of {key}" />
        {/if}
        <button type="button" class="branch" onclick={() => toggle(path)} aria-expanded={!collapsed.has(path)}>
          <span class="chev">{collapsed.has(path) ? "▸" : "▾"}</span>
          <span class="key">{key}</span>
          <span class="type {sh.type}">{sh.type === "array" ? `list · ${sh.count} item${sh.count === 1 ? "" : "s"}` : "object"}</span>
          {#if sh.optional}<span class="opt">sometimes missing</span>{/if}
        </button>
        {#if used.length}<span class="usedby">→ {used.join(", ")}</span>{/if}
      </div>
    {/if}
    {#if !collapsed.has(path)}
      {#if sh.type === "object"}
        {#each Object.entries(sh.children ?? {}) as [k, c] (k)}
          {@render node(c, k, childPath(path, k), key === null ? depth : depth + 1)}
        {/each}
      {:else if sh.item}
        {@render node(sh.item, sh.item.type === "object" || sh.item.type === "array" ? null : "each item", childPath(path, "*"), key === null ? depth : depth + 1)}
      {:else}
        <div class="trow" style:padding-left="{8 + (depth + 1) * 18}px"><span class="muted small">empty list</span></div>
      {/if}
    {/if}
  {:else}
    {@const used = usedBy ? usedBy(path) : []}
    <label class="trow leaf" class:picked={used.length > 0} class:pickable={!!onToggle} style:padding-left="{8 + depth * 18}px">
      {#if onToggle}
        <input type="checkbox" checked={used.length > 0} onchange={(e) => onToggle(path, e.currentTarget.checked)} />
      {:else}
        <span class="chev"></span>
      {/if}
      <span class="key">{key}</span>
      <span class="type {sh.type}">{sh.type}{sh.nullable ? " · null" : ""}</span>
      {#if sh.optional}<span class="opt">sometimes missing</span>{/if}
      <span class="sample">{sample(sh.sample)}</span>
      {#if used.length}<span class="usedby">→ {used.join(", ")}</span>{/if}
    </label>
  {/if}
{/snippet}

<div class="tree">
  {@render node(shape, null, "$", 0)}
  {#if shape.type !== "object" && shape.type !== "array"}
    <p class="muted small">The response is a single {shape.type}.</p>
  {/if}
</div>

<style>
  .tree { padding: 8px; font-size: .84rem; min-width: max-content; }
  .trow { display: flex; align-items: center; gap: 8px; padding: 5px 8px; border-radius: 10px; width: 100%; border: none; background: transparent; text-align: left; }
  .trow:hover { background: var(--accent-soft); }
  .branch { cursor: pointer; display: flex; align-items: center; gap: 8px; padding: 0; border: none; background: transparent; text-align: left; flex: 1; color: inherit; font: inherit; }
  .pickable { cursor: pointer; }
  .picked { background: var(--accent-soft); }
  .key { font-family: var(--font-mono); font-size: .8rem; font-weight: 600; }
  .sample { font-family: var(--font-mono); font-size: .76rem; color: var(--muted); }
  .chev { width: 14px; color: var(--muted); font-size: .7rem; text-align: center; flex: none; }
  .opt { font-size: .68rem; color: var(--warn); }
  .usedby { font-size: .72rem; color: var(--accent); white-space: nowrap; font-weight: 600; }
  input[type="checkbox"] { width: 16px; height: 16px; accent-color: var(--accent); margin: 0; cursor: pointer; flex: none; }
</style>
