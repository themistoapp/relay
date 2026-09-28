<script lang="ts">
  import { OPS, OP_GROUPS, OP_LIST, argsWithDefaults, describeStep, type OpMeta } from "$engine/ops";
  import { isListPath, relativeToRow, rowBase } from "$engine/paths";
  import type { FieldDef, FieldPreview } from "$engine/render";
  import { meta as server } from "../../lib/state.svelte";

  let {
    field = $bindable(),
    preview,
    sourceName,
    rowPaths,
    onRename,
    onDuplicate,
    onDelete,
  }: {
    field: FieldDef;
    preview: FieldPreview | undefined;
    sourceName: string;
    /** Neighbouring fields in the same list item, for "pick by". */
    rowPaths: string[];
    onRename: (from: string, to: string) => void;
    onDuplicate: () => void;
    onDelete: () => void;
  } = $props();

  let editing = $state<number | null>(null);
  let adding = $state("");

  const inList = $derived(isListPath(field.path));
  const allowed = (m: OpMeta) => (field.mode === "row" ? m.kind === "map" || m.kind === "list" : m.kind !== "pick" || inList);
  const groups = $derived(OP_GROUPS.map((g) => ({ g, ops: OP_LIST.filter((o) => o.group === g && allowed(o)) })).filter((x) => x.ops.length));

  function add() {
    const meta = OPS[adding];
    if (!meta) return;
    const args = Object.fromEntries(meta.args.map((a) => [a.name, a.type === "rowpath" ? (rowPaths.find((p) => p !== relativeToRow(field.path)) ?? "") : a.default]));
    field.ops.push(meta.args.length ? { op: adding, args } : { op: adding });
    if (meta.args.length) editing = field.ops.length - 1;
    adding = "";
  }

  function setMode(m: "value" | "row") {
    field.mode = m;
    if (m === "row") field.ops = field.ops.filter((o) => OPS[o.op] && (OPS[o.op].kind === "map" || OPS[o.op].kind === "list"));
    editing = null;
  }

  function move(i: number, d: -1 | 1) {
    const j = i + d;
    if (j < 0 || j >= field.ops.length) return;
    [field.ops[i], field.ops[j]] = [field.ops[j], field.ops[i]];
    editing = j;
  }

  let lastName = field.name;
  function renamed() {
    if (field.name !== lastName) onRename(lastName, field.name);
    lastName = field.name;
  }

  const fmt = (v: unknown) => {
    const s = JSON.stringify(v);
    return s === undefined ? "—" : s.length > 90 ? s.slice(0, 89) + "…" : s;
  };
</script>

<div class="fcard">
  <div class="top">
    <input class="input name" bind:value={field.name} onchange={renamed} aria-label="Field name" />
    <span class="path" title={field.path}>{sourceName} · {field.path.replace(/^\$\.?/, "")}</span>
    <span class="spacer"></span>
    {#if inList}
      <div class="seg sm" role="group" aria-label="Use per item or across the whole list">
        <button type="button" class:on={field.mode === "row"} onclick={() => setMode("row")}>Per item</button>
        <button type="button" class:on={field.mode === "value"} onclick={() => setMode("value")}>Whole list</button>
      </div>
    {/if}
    <button class="btn sm ghost" type="button" onclick={onDuplicate}>Duplicate</button>
    <button class="iconbtn del" type="button" aria-label="Remove field" title="Remove field" onclick={onDelete}>✕</button>
  </div>

  <div class="pipe">
    <span class="chip src">{field.mode === "row" ? `each ${rowBase(field.path)?.replace(/^\$\.?/, "").replace("[*]", "")} → ${relativeToRow(field.path).replace(/^\$\.?/, "")}` : inList ? "the whole list" : "value"}</span>
    {#each field.ops as step, i}
      <span class="to">→</span>
      <span class="chip" class:hist={OPS[step.op]?.kind === "history"} class:editing={editing === i}>
        <button type="button" class="lab" onclick={() => (editing = editing === i ? null : i)} title={OPS[step.op]?.help}>{describeStep(step)}</button>
        <button type="button" class="x" aria-label="Remove step" onclick={() => { field.ops.splice(i, 1); editing = null; }}>×</button>
      </span>
    {/each}
    <span class="to">→</span>
    <select class="addop" bind:value={adding} onchange={add} aria-label="Add a step">
      <option value="">+ add step</option>
      {#each groups as g}
        <optgroup label={g.g}>
          {#each g.ops as o}<option value={o.id}>{o.label}</option>{/each}
        </optgroup>
      {/each}
    </select>
  </div>

  {#if editing !== null && field.ops[editing]}
    {@const step = field.ops[editing]}
    {@const meta = OPS[step.op]}
    <div class="editor">
      <b>{meta.label}</b>
      <span class="muted small">{meta.help}</span>
      {#each meta.args as a}
        {@const val = argsWithDefaults(step)[a.name]}
        <label class="arg">
          <span>{a.label}</span>
          {#if a.type === "number"}
            <input class="input sm" type="number" step="any" value={val} oninput={(e) => (step.args = { ...step.args, [a.name]: e.currentTarget.value === "" ? a.default : Number(e.currentTarget.value) })} />
          {:else if a.type === "select"}
            <select class="input sm" value={val} onchange={(e) => (step.args = { ...step.args, [a.name]: e.currentTarget.value })}>
              {#each a.options ?? [] as o}<option value={o.value}>{o.label}</option>{/each}
            </select>
          {:else if a.type === "timezone"}
            <input class="input sm mono" list="relay-timezones" value={val} placeholder="{server.tz || 'Europe/London'} (server)" oninput={(e) => (step.args = { ...step.args, [a.name]: e.currentTarget.value.trim() })} />
          {:else if a.type === "rowpath"}
            <select class="input sm mono" value={val} onchange={(e) => (step.args = { ...step.args, [a.name]: e.currentTarget.value })}>
              {#each rowPaths as p}<option value={p}>{p.replace(/^\$\.?/, "")}</option>{/each}
            </select>
          {:else}
            <input class="input sm" value={val} oninput={(e) => (step.args = { ...step.args, [a.name]: e.currentTarget.value })} />
          {/if}
        </label>
      {/each}
      <span class="spacer"></span>
      <button class="iconbtn" type="button" aria-label="Move step earlier" disabled={editing === 0} onclick={() => move(editing!, -1)}>←</button>
      <button class="iconbtn" type="button" aria-label="Move step later" disabled={editing === field.ops.length - 1} onclick={() => move(editing!, 1)}>→</button>
      <button class="btn sm" type="button" onclick={() => (editing = null)}>Done</button>
    </div>
  {/if}

  <div class="preview">
    {#if !preview}
      <span class="spin"></span>
    {:else}
      <span class="muted">{preview.row ? "First item:" : "Now:"}</span>
      <span class="before">{fmt(preview.input)}</span>
      <span class="to">→</span>
      {#if preview.error}<span class="err">{preview.error}</span>{:else}<span class="after">{fmt(preview.output)}</span>{/if}
    {/if}
  </div>
</div>

<style>
  .fcard { border-radius: 18px; border: 1px solid var(--line); background: var(--field); padding: 14px 16px; display: grid; gap: 12px; }
  .top { display: flex; gap: 10px 14px; align-items: center; flex-wrap: wrap; }
  .name { width: 200px; font-family: var(--font-mono); font-size: .82rem; padding: 6px 10px; }
  .path { font-family: var(--font-mono); font-size: .74rem; color: var(--muted); overflow-wrap: anywhere; min-width: 0; }
  .spacer { flex: 1; }
  .pipe { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .chip.src { padding: 5px 11px; background: transparent; border-style: dashed; color: var(--muted); font-weight: 500; font-family: var(--font-mono); font-size: .72rem; }
  .chip.hist { border-color: var(--line-strong); color: var(--accent); }
  .chip.editing { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
  .chip .lab { border: none; background: none; padding: 0; font: inherit; color: inherit; cursor: pointer; }
  .to { color: var(--muted); font-size: .8rem; }
  .addop { padding: 5px 8px; border-radius: 10px; border: 1px dashed var(--line-strong); background: transparent; font-size: .76rem; cursor: pointer; }
  .editor { display: flex; flex-wrap: wrap; gap: 8px 14px; align-items: center; padding: 10px 12px; border-radius: 14px; background: var(--accent-soft); font-size: .82rem; }
  .arg { display: inline-flex; gap: 6px; align-items: center; font-size: .78rem; color: var(--text-2); }
  .arg .input { width: auto; min-width: 80px; }
  .preview { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; font-family: var(--font-mono); font-size: .78rem; }
  .before { color: var(--muted); overflow-wrap: anywhere; }
  .after { color: var(--text); font-weight: 700; padding: 2px 8px; border-radius: 8px; background: var(--accent-soft); overflow-wrap: anywhere; }
  .err { font-family: var(--font-body); }
</style>
