<script lang="ts">
  import { rowBase, relativeToRow } from "$engine/paths";
  import { removeFields, uniqueName, walk } from "../../lib/definition";
  import { uid } from "../../lib/format";
  import { isGroupPath, leafPaths } from "../../lib/shape";
  import type { Endpoint, Preview, ShapeNode, Source } from "../../lib/types";
  import FieldCard from "./FieldCard.svelte";

  let { draft = $bindable(), preview, shapes, sources }: { draft: Endpoint; preview: Preview | null; shapes: Record<number, ShapeNode | null>; sources: Source[] } = $props();

  const sourceName = (id: number) => sources.find((s) => s.id === id)?.name ?? `source #${id}`;

  function rowPathsFor(sourceId: number, path: string): string[] {
    const base = rowBase(path);
    if (!base) return [];
    return leafPaths(shapes[sourceId])
      .map((l) => l.path)
      .filter((p) => rowBase(p) === base)
      .map(relativeToRow);
  }

  // Output keys still named after a field follow it when it's renamed.
  function rename(from: string, to: string, fieldId: string) {
    walk(draft.definition.output, (n) => {
      if (n.t === "field" && n.fieldId === fieldId && n.key === from) n.key = to;
    });
  }

  function duplicate(i: number) {
    const f = draft.definition.fields[i];
    const copy = { ...f, id: uid(), name: uniqueName(draft.definition.fields.map((x) => x.name), f.name), ops: f.ops.map((o) => ({ ...o, args: o.args ? { ...o.args } : undefined })) };
    draft.definition.fields.splice(i + 1, 0, copy);
  }
</script>

<!-- Every real zone name, for the "Format date" step's time zone box. -->
<datalist id="relay-timezones">
  {#each Intl.supportedValuesOf("timeZone") as tz}<option value={tz}></option>{/each}
</datalist>

<section class="card glass">
  <div class="panel-head">
    <div>
      <h2>Transform each field</h2>
      <p class="sub">Steps run left to right. Click a step to change it. <b>Whole list</b> fields can be summarised (lowest, average, the one where another field is highest…). <b>History</b> steps compare with earlier pulls.</p>
    </div>
  </div>

  {#if !draft.definition.fields.length}
    <div class="empty-state">
      <p>No fields picked yet.</p>
      <a class="btn primary" href="#/endpoints/{draft.id}/pick">← Pick fields</a>
    </div>
  {:else}
    <div class="stack tight">
      {#each draft.definition.fields as field, i (field.id)}
        <FieldCard
          bind:field={draft.definition.fields[i]}
          preview={preview?.fields[field.id]}
          sourceName={sourceName(field.sourceId)}
          rowPaths={rowPathsFor(field.sourceId, field.path)}
          group={isGroupPath(shapes[field.sourceId], field.path)}
          onRename={(a, b) => rename(a, b, field.id)}
          onDuplicate={() => duplicate(i)}
          onDelete={() => removeFields(draft.definition, new Set([field.id]))}
        />
      {/each}
    </div>
  {/if}

  <div class="panel-foot">
    <a class="btn ghost" href="#/endpoints/{draft.id}/pick">← Pick</a>
    <a class="btn primary" href="#/endpoints/{draft.id}/shape">Build the output →</a>
  </div>
</section>
