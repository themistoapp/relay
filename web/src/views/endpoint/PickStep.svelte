<script lang="ts">
  import { untrack } from "svelte";
  import { pending } from "../../lib/state.svelte";
  import { addField, fieldsUsing, removeFields } from "../../lib/definition";
  import type { Endpoint, ShapeNode, Source } from "../../lib/types";
  import ShapeTree from "../../components/ShapeTree.svelte";

  let { draft = $bindable(), sources, shapes, loadShape }: { draft: Endpoint; sources: Source[]; shapes: Record<number, ShapeNode | null>; loadShape: (id: number) => Promise<void> } = $props();

  // The starting source: one handed over by "Build an endpoint →", else the one already in use.
  const first = untrack(() => pending.sourceId ?? draft.definition.fields[0]?.sourceId ?? sources[0]?.id ?? null);
  pending.sourceId = null;
  let sourceId = $state<number | null>(first);

  $effect(() => {
    if (sourceId !== null) loadShape(sourceId);
  });

  const shape = $derived(sourceId === null ? undefined : shapes[sourceId]);
  const def = $derived(draft.definition);

  function usedBy(path: string) {
    return sourceId === null ? [] : fieldsUsing(def, sourceId, path).map((f) => f.name);
  }

  function toggle(path: string, checked: boolean) {
    if (sourceId === null) return;
    if (checked) addField(draft.definition, sourceId, path);
    else removeFields(draft.definition, new Set(fieldsUsing(def, sourceId, path).map((f) => f.id)));
  }

  const perSource = $derived(sources.map((s) => ({ ...s, picked: def.fields.filter((f) => f.sourceId === s.id).length })));
</script>

<section class="card glass">
  <div class="panel-head">
    <div>
      <h2>Tick the data you want</h2>
      <p class="sub">Each tick becomes a field you can transform. Fields inside a list are used once per item, or summarised across the whole list in the next step. You can pick from more than one source.</p>
    </div>
    <span class="pill">{def.fields.length} field{def.fields.length === 1 ? "" : "s"} picked</span>
  </div>

  {#if !sources.length}
    <div class="empty-state">
      <p>There are no sources yet.</p>
      <a class="btn primary" href="#/sources/new">+ New source</a>
    </div>
  {:else}
    <div class="stack">
      <div class="row">
        <label class="lbl" for="pick-source">Source</label>
        <select class="input" id="pick-source" style="width: auto" bind:value={sourceId}>
          {#each perSource as s}<option value={s.id}>{s.name}{s.picked ? ` (${s.picked} picked)` : ""}</option>{/each}
        </select>
      </div>
      <div class="box">
        {#if shape === undefined || (shape === null && sourceId !== null && !(sourceId in shapes))}
          <div class="empty-state"><span class="spin"></span></div>
        {:else if shape === null}
          <div class="empty-state">
            <p>This source hasn't pulled any data yet, so there's nothing to pick from.</p>
            <a class="btn" href="#/sources/{sourceId}/response">Go to the source</a>
          </div>
        {:else}
          <div class="scroll" style="max-height: 620px"><ShapeTree {shape} {usedBy} onToggle={toggle} /></div>
        {/if}
      </div>
    </div>
  {/if}

  <div class="panel-foot">
    <span class="muted small">Unticking a field also removes it from the output.</span>
    <a class="btn primary" href="#/endpoints/{draft.id}/transform">Transform →</a>
  </div>
</section>
