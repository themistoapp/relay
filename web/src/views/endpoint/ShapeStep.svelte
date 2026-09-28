<script lang="ts">
  import { rowBase } from "$engine/paths";
  import { CMPS } from "$engine/ops";
  import type { OutNode } from "$engine/render";
  import { contains, findNode, listName, uniqueName, type ListNode } from "../../lib/definition";
  import { uid } from "../../lib/format";
  import type { Endpoint, Preview, Source } from "../../lib/types";
  import JsonView from "../../components/JsonView.svelte";

  let { draft = $bindable(), preview, previewError, sources }: { draft: Endpoint; preview: Preview | null; previewError: string; sources: Source[] } = $props();

  const def = $derived(draft.definition);
  const fieldById = (id: string) => def.fields.find((f) => f.id === id);
  const sourceName = (id: number) => sources.find((s) => s.id === id)?.name ?? `#${id}`;

  const valueFields = $derived(def.fields.filter((f) => f.mode === "value"));
  const rowGroups = $derived.by(() => {
    const m = new Map<string, { sourceId: number; base: string; fields: typeof def.fields }>();
    for (const f of def.fields.filter((f) => f.mode === "row")) {
      const base = rowBase(f.path)!;
      const k = `${f.sourceId}|${base}`;
      if (!m.has(k)) m.set(k, { sourceId: f.sourceId, base, fields: [] });
      m.get(k)!.fields.push(f);
    }
    return [...m.values()];
  });

  // ---- adding ----
  function keysIn(nodes: OutNode[]) {
    return nodes.map((n) => n.key);
  }

  function addFieldTo(fieldId: string, container: OutNode[] | null) {
    const f = fieldById(fieldId);
    if (!f) return;
    let target = container;
    if (!target) {
      if (f.mode === "row") {
        const base = rowBase(f.path)!;
        let list = def.output.find((n): n is ListNode => n.t === "list" && n.sourceId === f.sourceId && n.over === base);
        if (!list) {
          list = { id: uid(), t: "list", key: uniqueName(keysIn(def.output), listName(base)), sourceId: f.sourceId, over: base, children: [] };
          draft.definition.output.push(list);
          list = draft.definition.output[draft.definition.output.length - 1] as ListNode;
        }
        target = list.children;
      } else target = draft.definition.output;
    }
    target.push({ id: uid(), t: "field", key: uniqueName(keysIn(target), f.name), fieldId: f.id });
  }

  function addGroup() {
    draft.definition.output.push({ id: uid(), t: "object", key: uniqueName(keysIn(def.output), "group"), children: [] });
  }

  let newList = $state("");
  function addList() {
    const g = rowGroups.find((g) => `${g.sourceId}|${g.base}` === newList);
    newList = "";
    if (!g) return;
    draft.definition.output.push({ id: uid(), t: "list", key: uniqueName(keysIn(def.output), listName(g.base)), sourceId: g.sourceId, over: g.base, children: [] });
  }

  // ---- editing ----
  function remove(id: string) {
    const f = findNode(draft.definition.output, id);
    if (f) f.parent.splice(f.index, 1);
  }

  function move(id: string, d: -1 | 1) {
    const f = findNode(draft.definition.output, id);
    if (!f) return;
    const j = f.index + d;
    if (j < 0 || j >= f.parent.length) return;
    [f.parent[f.index], f.parent[j]] = [f.parent[j], f.parent[f.index]];
  }

  // ---- drag and drop: fields from the palette, or existing nodes to a new container ----
  let over = $state<string | null>(null);

  function dragStart(e: DragEvent, payload: { field?: string; node?: string }) {
    e.dataTransfer!.setData("application/x-relay", JSON.stringify(payload));
    e.dataTransfer!.effectAllowed = "copyMove";
    e.stopPropagation();
  }

  function containerFor(id: string): OutNode[] | null {
    if (id === "root") return draft.definition.output;
    const f = findNode(draft.definition.output, id);
    return f && f.node.t !== "field" ? f.node.children : null;
  }

  function drop(e: DragEvent, containerId: string) {
    e.preventDefault();
    e.stopPropagation();
    over = null;
    let payload: { field?: string; node?: string };
    try {
      payload = JSON.parse(e.dataTransfer!.getData("application/x-relay"));
    } catch {
      return;
    }
    const target = containerFor(containerId);
    if (!target) return;
    if (payload.field) addFieldTo(payload.field, target);
    else if (payload.node) {
      const found = findNode(draft.definition.output, payload.node);
      if (!found || (containerId !== "root" && contains(found.node, containerId))) return;
      found.parent.splice(found.index, 1);
      containerFor(containerId)!.push(found.node);
    }
  }

  const dz = (id: string) => ({
    ondragover: (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      over = id;
    },
    ondragleave: (e: DragEvent) => {
      if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) over = null;
    },
    ondrop: (e: DragEvent) => drop(e, id),
  });

  const errorsFor = $derived(new Map((preview?.errors ?? []).map((e) => [e.fieldId, e.message])));
  const inUse = $derived.by(() => {
    const s = new Set<string>();
    const w = (ns: OutNode[]) => ns.forEach((n) => (n.t === "field" ? s.add(n.fieldId) : w(n.children)));
    w(def.output);
    return s;
  });
</script>

{#snippet paletteItem(f: (typeof def.fields)[number])}
  <div class="pitem" class:unused={!inUse.has(f.id)} draggable="true" role="listitem" ondragstart={(e) => dragStart(e, { field: f.id })}>
    <span class="grip" aria-hidden="true">⋮⋮</span>
    <span class="nm" title={f.path}>{f.name}</span>
    <button class="add" type="button" aria-label="Add {f.name} to the output" onclick={() => addFieldTo(f.id, null)}>+</button>
  </div>
{/snippet}

{#snippet controls(n: OutNode, i: number, siblings: OutNode[])}
  <button class="iconbtn" type="button" aria-label="Move up" disabled={i === 0} onclick={() => move(n.id, -1)}>↑</button>
  <button class="iconbtn" type="button" aria-label="Move down" disabled={i === siblings.length - 1} onclick={() => move(n.id, 1)}>↓</button>
  <button class="iconbtn del" type="button" aria-label="Remove {n.key}" onclick={() => remove(n.id)}>✕</button>
{/snippet}

{#snippet nodes(list: OutNode[], containerId: string, emptyText: string)}
  <div class="drop" class:over={over === containerId} role="list" {...dz(containerId)}>
    {#each list as n, i (n.id)}
      {#if n.t === "field"}
        {@const f = fieldById(n.fieldId)}
        <div class="onode" class:bad={errorsFor.has(n.fieldId) || !f} draggable="true" role="listitem" ondragstart={(e) => dragStart(e, { node: n.id })}>
          <span class="grip" aria-hidden="true">⋮⋮</span>
          <input bind:value={n.key} aria-label="Output key" />
          <span class="from" title={errorsFor.get(n.fieldId) ?? f?.path}>{f ? `← ${f.name}` : "missing field"}</span>
          {@render controls(n, i, list)}
        </div>
      {:else}
        <div class="group" class:islist={n.t === "list"} draggable="true" role="listitem" ondragstart={(e) => dragStart(e, { node: n.id })}>
          <div class="onode head">
            <span class="grip" aria-hidden="true">⋮⋮</span>
            <input bind:value={n.key} aria-label="{n.t === 'list' ? 'List' : 'Group'} key" />
            <span class="type {n.t === 'list' ? 'array' : 'object'}">{n.t === "list" ? "list" : "group"}</span>
            {@render controls(n, i, list)}
          </div>
          {#if n.t === "list"}
            {@const childKeys = n.children.map((c) => c.key)}
            <div class="opts">
              <span>One item per <b>{listName(n.over)}</b> in {sourceName(n.sourceId)}</span>
              <span>· sort by
                <select value={n.sort ?? ""} onchange={(e) => (n.sort = e.currentTarget.value || undefined)} aria-label="Sort by">
                  <option value="">original order</option>
                  {#each childKeys as k}<option value={k}>{k}</option>{/each}
                </select>
              </span>
              {#if n.sort}
                <select value={n.dir ?? "asc"} onchange={(e) => (n.dir = e.currentTarget.value as "asc" | "desc")} aria-label="Sort direction">
                  <option value="asc">low → high</option>
                  <option value="desc">high → low</option>
                </select>
              {/if}
              <span>· keep
                <input type="number" min="0" placeholder="all" value={n.limit || ""} oninput={(e) => (n.limit = Number(e.currentTarget.value) || 0)} aria-label="How many items to keep" />
              </span>
              <span>· only where
                <select value={n.filter?.key ?? ""} onchange={(e) => (n.filter = e.currentTarget.value ? { key: e.currentTarget.value, cmp: n.filter?.cmp ?? ">", value: n.filter?.value ?? "" } : null)} aria-label="Filter by">
                  <option value="">(no filter)</option>
                  {#each childKeys as k}<option value={k}>{k}</option>{/each}
                </select>
              </span>
              {#if n.filter}
                <select bind:value={n.filter.cmp} aria-label="Comparison">
                  {#each CMPS as c}<option value={c.value}>{c.label}</option>{/each}
                </select>
                <input bind:value={n.filter.value} style="width: 90px" aria-label="Filter value" />
              {/if}
            </div>
          {/if}
          {@render nodes(n.children, n.id, n.t === "list" ? "Drop per-item fields here" : "Drop fields here")}
        </div>
      {/if}
    {:else}
      <div class="empty">{emptyText}</div>
    {/each}
  </div>
{/snippet}

<section class="card glass">
  <div class="panel-head">
    <div>
      <h2>Shape the API you'll serve</h2>
      <p class="sub">Drag fields into the output, or tap +. Rename keys in place and drag to regroup. A list repeats its fields for every item, and can be sorted, filtered and trimmed.</p>
    </div>
    <div class="row">
      <button class="btn sm" type="button" onclick={addGroup}>+ Group</button>
      <select class="btn sm" bind:value={newList} onchange={addList} disabled={!rowGroups.length} title={rowGroups.length ? "" : "Tick a field inside a list first"} aria-label="Add a list">
        <option value="">+ List</option>
        {#each rowGroups as g}<option value="{g.sourceId}|{g.base}">{listName(g.base)} ({sourceName(g.sourceId)})</option>{/each}
      </select>
    </div>
  </div>

  <div class="builder">
    <div class="box palette" role="list">
      <h3>Single values</h3>
      {#each valueFields as f (f.id)}{@render paletteItem(f)}{:else}<span class="muted small">None. Switch a field to "Whole list" or pick one outside a list.</span>{/each}
      {#each rowGroups as g}
        <h3>Per item of {listName(g.base)}</h3>
        {#each g.fields as f (f.id)}{@render paletteItem(f)}{/each}
      {/each}
      {#if !def.fields.length}<a class="btn sm" href="#/endpoints/{draft.id}/pick">← Pick fields first</a>{/if}
    </div>

    <div class="box">
      <div class="box-head"><h3>Output</h3><span class="muted mono small">{"{ }"}</span></div>
      <div class="otree">{@render nodes(draft.definition.output, "root", "Drop fields here")}</div>
    </div>

    <div class="box">
      <div class="box-head"><h3>Live preview</h3><span class="muted small">from the latest pulls</span></div>
      {#if previewError}<p class="note bad" style="margin: 12px">{previewError}</p>{/if}
      {#if preview?.missing.length}<p class="note warn" style="margin: 12px">No data yet from {preview.missing.join(", ")}.</p>{/if}
      {#if preview?.errors.length}
        <div class="note bad" style="margin: 12px; display: grid; gap: 4px">
          {#each preview.errors as e}<span><b>{e.name}</b>: {e.message}</span>{/each}
        </div>
      {/if}
      <div class="scroll">{#if preview}<JsonView value={preview.output} />{:else}<div class="empty-state"><span class="spin"></span></div>{/if}</div>
    </div>
  </div>

  <div class="panel-foot">
    <a class="btn ghost" href="#/endpoints/{draft.id}/transform">← Transform</a>
    <a class="btn primary" href="#/endpoints/{draft.id}/publish">Publish settings →</a>
  </div>
</section>

<style>
  .builder { display: grid; gap: 16px; grid-template-columns: minmax(0, 1fr); }
  @media (min-width: 1000px) { .builder { grid-template-columns: 220px minmax(0, 1.2fr) minmax(0, 1fr); } }
  .palette { display: grid; grid-template-columns: minmax(0, 1fr); gap: 6px; align-content: start; padding: 12px; }
  .palette h3 { margin: 8px 2px 2px; }
  .palette h3:first-child { margin-top: 0; }
  .pitem { display: flex; align-items: center; gap: 8px; padding: 7px 8px 7px 10px; border-radius: 12px; border: 1px solid var(--line); background: var(--glass-strong); cursor: grab; font-size: .8rem; }
  .pitem.unused { border-style: dashed; }
  .grip { color: var(--muted); letter-spacing: -2px; font-size: .75rem; cursor: grab; }
  .nm { font-family: var(--font-mono); font-weight: 600; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .add { border: none; background: var(--accent-soft); color: var(--accent); border-radius: 8px; width: 24px; height: 24px; cursor: pointer; font-weight: 700; flex: none; }
  .otree { padding: 10px; }
  .drop { border-radius: 14px; border: 1.5px dashed transparent; padding: 4px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 6px; min-height: 40px; transition: border-color .15s, background .15s; }
  .drop.over { border-color: var(--accent); background: var(--accent-soft); }
  .empty { font-size: .76rem; color: var(--muted); padding: 10px; text-align: center; border: 1.5px dashed var(--line); border-radius: 12px; }
  .onode { display: flex; align-items: center; gap: 6px; padding: 5px 5px 5px 8px; border-radius: 12px; background: var(--glass-strong); border: 1px solid var(--line); }
  .onode.bad { border-color: var(--bad); }
  .onode input { flex: 1; width: 0; min-width: 48px; border: none; background: transparent; font-family: var(--font-mono); font-size: .8rem; font-weight: 600; padding: 3px 4px; border-radius: 6px; }
  .onode input:focus { outline: none; background: var(--accent-soft); }
  .from { font-size: .72rem; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 16ch; }
  .onode.bad .from { color: var(--bad); }
  .onode, .group, .pitem { min-width: 0; }
  @media (max-width: 560px) { .from { display: none; } .group > .drop { margin-left: 4px; } }
  .group { border-radius: 14px; border: 1px solid var(--line); padding: 6px; display: grid; gap: 6px; background: var(--field); }
  .group.islist { border-color: var(--line-strong); background: var(--accent-soft); }
  .group > .drop { margin-left: 12px; border-left: 2px solid var(--line-strong); border-radius: 0 12px 12px 0; }
  .onode.head { background: transparent; border: none; }
  .opts { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; font-size: .74rem; color: var(--text-2); padding: 0 6px; }
  .opts select, .opts input { padding: 2px 6px; border-radius: 8px; border: 1px solid var(--line); background: var(--field); font-size: .74rem; }
  .opts input[type="number"] { width: 56px; }
</style>
