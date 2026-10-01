<script lang="ts">
  import { untrack } from "svelte";
  import { api } from "../../lib/api";
  import { meta, say } from "../../lib/state.svelte";
  import { n, time, uid } from "../../lib/format";
  import { uniqueName } from "../../lib/definition";
  import { leafName } from "$engine/paths";
  import { OPS, OP_LIST, argsWithDefaults, describeStep } from "$engine/ops";
  import type { HistoryDef, HistoryValue } from "$engine/histories";
  import type { Source } from "../../lib/types";
  import type { SavedHistory } from "./types";
  import Chart from "../../components/Chart.svelte";

  let { source, history = null, onDone }: { source: Source; history?: SavedHistory | null; onDone: (saved: boolean) => void } = $props();

  type Field = { path: string; label: string; samples: unknown[]; numeric: number; timeLike: number };
  type TimeRow = { raw: unknown; t?: number; assumedZone?: boolean; error?: string };
  type ValueRow = Record<string, { raw: unknown; value: number | null; why?: string; usedFallback?: boolean }>;
  type Explore = {
    hasData: boolean;
    fetchedAt?: number;
    error?: string;
    lists?: { rows: string; kind: HistoryDef["rowsKind"]; label: string; count: number; sample: unknown }[];
    entries?: number;
    fields?: Field[];
    times?: TimeRow[];
    unreadableTimes?: number;
    valuePreview?: ValueRow[];
    result?: { points: number; skipped: Record<string, number>; oldest: number | null; newest: number | null; sample: { t: number; values: Record<string, number | null> }[]; fallbacks: Record<string, number> };
    storedPulls?: number;
  };

  // ---- what's been chosen ----
  const start = untrack(() => history);
  let rows = $state<string | null>(start?.definition.rows ?? null);
  let rowsKind = $state<HistoryDef["rowsKind"]>(start?.definition.rowsKind ?? "list");
  /** undefined: not chosen yet. null: the entry's name (for "names" lists). */
  let timePath = $state<string | null | undefined>(start ? start.definition.time : undefined);
  let values = $state<HistoryValue[]>(start ? structuredClone($state.snapshot(start.definition.values)) : []);
  let name = $state(start?.name ?? "");
  let keepDays = $state<number | null>(start ? start.keepDays : 365);

  let step = $state<"where" | "when" | "numbers" | "save">(start ? "save" : "where");
  let ex = $state<Explore | null>(null);
  let loading = $state(false);
  let saving = $state(false);
  let saveError = $state("");
  let showAllTimes = $state(false);
  let showAllNumbers = $state(false);
  let editingOp = $state<{ v: string; i: number } | null>(null);

  // ---- asking the server what the latest pull looks like with these choices ----
  let seq = 0;
  async function explore() {
    const my = ++seq;
    loading = true;
    try {
      const body: Record<string, unknown> = {};
      if (rows) Object.assign(body, { rows, rowsKind });
      if (rows && timePath !== undefined) body.time = timePath;
      if (rows && timePath !== undefined && values.length) body.values = $state.snapshot(values);
      const r = await api.post<Explore>(`/sources/${source.id}/histories/explore`, body);
      if (my !== seq) return;
      ex = r;
      // Suggest the time field when exactly one field clearly is one. It's shown, and can be changed.
      if (rows && timePath === undefined && r.fields) {
        if (rowsKind === "names") timePath = null;
        else {
          const clear = r.fields.filter((f) => f.timeLike >= 0.8);
          if (clear.length === 1) timePath = clear[0].path;
        }
      }
    } catch (e) {
      if (my === seq) say((e as Error).message, true);
    } finally {
      if (my === seq) loading = false;
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    void JSON.stringify({ rows, rowsKind, timePath, values });
    clearTimeout(timer);
    timer = setTimeout(explore, 200);
    return () => clearTimeout(timer);
  });

  // ---- choosing ----
  function chooseList(l: NonNullable<Explore["lists"]>[number]) {
    if (rows === l.rows && rowsKind === l.kind) return;
    rows = l.rows;
    rowsKind = l.kind;
    timePath = undefined;
    values = [];
  }

  function chooseTime(p: string | null) {
    timePath = p;
    values = values.filter((v) => v.path !== p);
  }

  function toggleValue(f: Field, on: boolean) {
    if (on) {
      const base = f.path === "$" ? "value" : leafName(f.path);
      values.push({ id: uid(), name: uniqueName(values.map((v) => v.name), base), path: f.path, fallback: null, ops: [] });
    } else values = values.filter((v) => v.path !== f.path);
  }

  const MATHS = OP_LIST.filter((o) => o.kind === "map" && o.group === "Maths");
  function addOp(v: HistoryValue, id: string) {
    const m = OPS[id];
    if (!m) return;
    v.ops.push(m.args.length ? { op: id, args: Object.fromEntries(m.args.map((a) => [a.name, a.default])) } : { op: id });
    if (m.args.length) editingOp = { v: v.id, i: v.ops.length - 1 };
  }

  // ---- what to show ----
  const tz = $derived(meta.tz || "Europe/London");
  const when = (t: number) => new Date(t).toLocaleString("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const short = (v: unknown, max = 60) => {
    const s = typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v) ?? "—";
    return s.length > max ? s.slice(0, max - 1) + "…" : s;
  };
  const chosenList = $derived(ex?.lists?.find((l) => l.rows === rows && l.kind === rowsKind));
  const listLabel = $derived(chosenList?.label ?? rows?.replace(/^\$\.?/, "") ?? "");
  const fields = $derived(ex?.fields ?? []);
  const timeField = $derived(fields.find((f) => f.path === timePath));
  const timeLabel = $derived(timePath === null ? "each entry's name" : (timeField?.label ?? timePath ?? ""));
  const timeOptions = $derived([...fields].filter((f) => f.path !== "$").sort((a, b) => b.timeLike - a.timeLike));
  const likelyTimes = $derived(timeOptions.filter((f) => f.timeLike >= 0.5));
  const numberOptions = $derived([...fields].filter((f) => f.path !== timePath).sort((a, b) => b.numeric - a.numeric));
  const likelyNumbers = $derived(numberOptions.filter((f) => f.numeric > 0));
  const assumedZone = $derived(ex?.times?.some((t) => t.assumedZone));
  const fieldLabel = (p: string | null | undefined) => (p ? (fields.find((f) => f.path === p)?.label ?? p.replace(/^\$\.?/, "")) : "");

  const keepLabel = $derived(keepDays === null ? "for good" : keepDays % 365 === 0 ? `for ${keepDays / 365} year${keepDays === 365 ? "" : "s"}` : `for ${n(keepDays)} days`);
  const valueNames = $derived(values.map((v) => v.name || "(unnamed)"));
  const joinWords = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

  const chartPoints = $derived.by(() => {
    const v = values[0];
    if (!v || !ex?.result) return [];
    return ex.result.sample.map((p) => ({ t: p.t, v: p.values[v.id] })).filter((p): p is { t: number; v: number } => typeof p.v === "number");
  });

  const canWhen = $derived(!!rows);
  const canNumbers = $derived(!!rows && timePath !== undefined);
  const canSave = $derived(canNumbers && values.length > 0);
  const STEPS = $derived([
    { id: "where", label: "Where", hint: "Find the list", ok: true },
    { id: "when", label: "When", hint: "Which field is the time", ok: canWhen },
    { id: "numbers", label: "Numbers", hint: "What to keep", ok: canNumbers },
    { id: "save", label: "Save", hint: "Check and save", ok: canSave },
  ] as const);

  async function save() {
    saving = true;
    saveError = "";
    try {
      const body = { name: name.trim(), definition: { rows, rowsKind, time: timePath, values: $state.snapshot(values) }, keepDays };
      const r = history
        ? await api.put<{ rebuilt: { pulls: number; points: number } }>(`/histories/${history.id}`, body)
        : await api.post<{ rebuilt: { pulls: number; points: number } }>(`/sources/${source.id}/histories`, body);
      say(r.rebuilt.points ? `Saved. Filled in ${n(r.rebuilt.points)} times from ${n(r.rebuilt.pulls)} stored pull${r.rebuilt.pulls === 1 ? "" : "s"}.` : "Saved. It fills in from the next pull.");
      onDone(true);
    } catch (e) {
      saveError = (e as Error).message;
    } finally {
      saving = false;
    }
  }

  $effect(() => {
    if (!name && values.length) name = `${source.name} ${values[0].name}`.slice(0, 100);
  });
</script>

<div class="wiz">
  <div class="stepper-wrap">
    <div class="stepper" role="tablist">
      {#each STEPS as s, i (s.id)}
        <button type="button" role="tab" class="step" class:active={step === s.id} aria-selected={step === s.id} disabled={!s.ok} onclick={() => (step = s.id)}>
          <span class="n">{i + 1}</span>
          <span class="t"><b>{s.label}</b><small>{s.hint}</small></span>
        </button>
      {/each}
    </div>
  </div>

  {#if !ex}
    <div class="empty-state"><span class="spin"></span></div>
  {:else if !ex.hasData}
    <p class="note warn">There's no successful pull of this source yet, so there's nothing to look at. Pull it once from the Request step, then come back.</p>
  {:else if step === "where"}
    <div class="q">
      <h3>Which list has one entry per time?</h3>
      <p class="muted small">Relay looked through the latest response (pulled {time(ex.fetchedAt!, true)}) for lists. Pick the one where each entry is one moment, like a half-hour slot, an hour or a day.</p>
    </div>
    <div class="choices">
      {#each ex.lists ?? [] as l (l.rows + l.kind)}
        <button type="button" class="choice" class:on={rows === l.rows && rowsKind === l.kind} onclick={() => chooseList(l)}>
          <span class="radio" aria-hidden="true"></span>
          <span class="body">
            <span class="title"><b class="mono">{l.label}</b> <span class="muted">· {n(l.count)} {l.kind === "names" ? "names" : "entries"}</span></span>
            {#if l.kind === "names"}<span class="small">Each <b>name</b> in here is a time, so every name and its value is one entry.</span>{/if}
            <code class="sample">{l.kind === "names" ? "first one: " : "first entry: "}{short(l.sample, 140)}</code>
          </span>
        </button>
      {:else}
        <p class="note warn">Relay couldn't find a list in this response. A history needs a list of entries that each have a time.</p>
      {/each}
    </div>
    {#if ex.error}<p class="note bad">{ex.error}</p>{/if}

  {:else if step === "when"}
    <div class="q">
      <h3>Which field says when?</h3>
      <p class="muted small">Each entry needs a time so Relay can line them up. If two pulls both have an entry for the same time, the newer one replaces the older.</p>
    </div>
    <div class="choices">
      {#if rowsKind === "names"}
        <button type="button" class="choice" class:on={timePath === null} onclick={() => chooseTime(null)}>
          <span class="radio" aria-hidden="true"></span>
          <span class="body"><span class="title"><b>The entry's name</b> <span class="tag">Looks like a time</span></span><span class="small muted">The names in {listLabel} are the times.</span></span>
        </button>
      {/if}
      {#each showAllTimes ? timeOptions : likelyTimes as f (f.path)}
        <button type="button" class="choice" class:on={timePath === f.path} onclick={() => chooseTime(f.path)}>
          <span class="radio" aria-hidden="true"></span>
          <span class="body">
            <span class="title"><b class="mono">{f.label}</b> {#if f.timeLike >= 0.5}<span class="tag">Looks like a time</span>{/if}</span>
            <code class="sample">{f.samples.slice(0, 3).map((s) => short(s, 40)).join("   ")}</code>
          </span>
        </button>
      {/each}
      {#if !likelyTimes.length && rowsKind !== "names" && !showAllTimes}<p class="note warn">No field in these entries looks like a time. Show the other fields to pick one anyway.</p>{/if}
      {#if timeOptions.length > likelyTimes.length}
        <button type="button" class="btn sm ghost more" onclick={() => (showAllTimes = !showAllTimes)}>{showAllTimes ? "Only show likely times" : `Show the other ${timeOptions.length - likelyTimes.length} fields`}</button>
      {/if}
    </div>

    {#if timePath !== undefined && ex.times}
      <div class="box">
        <div class="box-head"><h3>How Relay reads it</h3><span class="muted small">first {ex.times.length} of {n(ex.entries)} entries</span></div>
        <table>
          <thead><tr><th>In the response</th><th>Read as ({tz})</th></tr></thead>
          <tbody>
            {#each ex.times as r}
              <tr><td class="mono">{short(r.raw, 48)}</td><td>{#if r.t !== undefined}{when(r.t)}{:else}<span class="err">{r.error}</span>{/if}</td></tr>
            {/each}
          </tbody>
        </table>
        <div class="foot stack tight">
          {#if assumedZone}<p class="small muted">This text doesn't say which time zone it's in, so Relay reads it as {tz} time (the server's TZ setting).</p>{/if}
          {#if ex.unreadableTimes}<p class="small warn-text">{n(ex.unreadableTimes)} of {n(ex.entries)} entries have a time Relay can't read. They'll be left out.</p>{/if}
          {#if !ex.unreadableTimes && !assumedZone}<p class="small muted">Every entry's time reads fine.</p>{/if}
        </div>
      </div>
    {/if}

  {:else if step === "numbers"}
    <div class="q">
      <h3>Which numbers do you want to keep?</h3>
      <p class="muted small">Tick the numbers to save for each time. The name is what your endpoint will call it.</p>
    </div>
    <div class="choices">
      {#each showAllNumbers ? numberOptions : likelyNumbers as f (f.path)}
        {@const v = values.find((x) => x.path === f.path)}
        <div class="choice" class:on={!!v}>
          <label class="pickrow">
            <input type="checkbox" checked={!!v} onchange={(e) => toggleValue(f, e.currentTarget.checked)} />
            <span class="body">
              <span class="title"><b class="mono">{f.label}</b> {#if f.numeric < 1 && f.numeric > 0}<span class="muted small">· a number in {Math.round(f.numeric * 100)}% of entries</span>{:else if f.numeric === 0}<span class="muted small">· not a number</span>{/if}</span>
              <code class="sample">{f.samples.slice(0, 4).map((s) => short(s, 24)).join("   ")}</code>
            </span>
          </label>
          {#if v}
            {@const vi = values.indexOf(v)}
            <div class="valopts">
              <label class="arg"><span>Call it</span><input class="input sm mono" bind:value={values[vi].name} /></label>
              <label class="arg"><span>If it's empty, use</span>
                <select class="input sm" value={v.fallback ?? ""} onchange={(e) => (values[vi].fallback = e.currentTarget.value || null)}>
                  <option value="">nothing (leave it empty)</option>
                  {#each likelyNumbers.filter((o) => o.path !== f.path) as o}<option value={o.path}>{o.label}</option>{/each}
                </select>
              </label>
              <span class="pipe">
                <span class="muted small">Change it:</span>
                {#each v.ops as s, i}
                  <span class="chip" class:editing={editingOp?.v === v.id && editingOp.i === i}>
                    <button type="button" class="lab" onclick={() => (editingOp = editingOp?.v === v.id && editingOp.i === i ? null : { v: v.id, i })}>{describeStep(s)}</button>
                    <button type="button" class="x" aria-label="Remove step" onclick={() => { values[vi].ops.splice(i, 1); editingOp = null; }}>×</button>
                  </span>
                {/each}
                <select class="addop" value="" onchange={(e) => { addOp(values[vi], e.currentTarget.value); e.currentTarget.value = ""; }} aria-label="Add a step">
                  <option value="">+ add step</option>
                  {#each MATHS as o}<option value={o.id}>{o.label}</option>{/each}
                </select>
              </span>
              {#if editingOp?.v === v.id && v.ops[editingOp.i]}
                {@const s = v.ops[editingOp.i]}
                <div class="editor">
                  <b>{OPS[s.op].label}</b><span class="muted small">{OPS[s.op].help}</span>
                  {#each OPS[s.op].args as a}
                    <label class="arg"><span>{a.label}</span>
                      <input class="input sm" type="number" step="any" value={argsWithDefaults(s)[a.name]} oninput={(e) => (s.args = { ...s.args, [a.name]: e.currentTarget.value === "" ? a.default : Number(e.currentTarget.value) })} />
                    </label>
                  {/each}
                  <button class="btn sm" type="button" onclick={() => (editingOp = null)}>Done</button>
                </div>
              {/if}
              {#if ex.valuePreview}
                <span class="prev">
                  {#each ex.valuePreview.slice(0, 4) as row}
                    {@const c = row[v.id]}
                    {#if c}
                      <span class="pv" title={c.why ?? ""}>
                        <span class="muted">{short(c.raw, 16)}</span> → {#if c.value !== null}<b>{c.value}</b>{#if c.usedFallback}<span class="fb">from {fieldLabel(v.fallback)}</span>{/if}{:else}<span class="err">{c.why === "empty" ? "empty" : c.why}</span>{/if}
                      </span>
                    {/if}
                  {/each}
                </span>
              {/if}
            </div>
          {/if}
        </div>
      {:else}
        <p class="note warn">No numbers in these entries. Show every field to pick text that holds numbers.</p>
      {/each}
      {#if numberOptions.length > likelyNumbers.length}
        <button type="button" class="btn sm ghost more" onclick={() => (showAllNumbers = !showAllNumbers)}>{showAllNumbers ? "Only show numbers" : `Show the other ${numberOptions.length - likelyNumbers.length} fields`}</button>
      {/if}
    </div>

  {:else if step === "save"}
    <div class="q">
      <h3>Check and save</h3>
      <p class="muted small">This is what the latest pull gives. Nothing is saved until you press Save.</p>
    </div>
    <div class="savegrid">
      <label class="fld"><span class="lbl">Name</span><input class="input" bind:value={name} maxlength="100" placeholder="e.g. Carbon intensity" /></label>
      <div class="fld">
        <span class="lbl">Keep each time</span>
        <div class="seg sm">
          {#each [[30, "30 days"], [365, "1 year"], [1825, "5 years"], [null, "For good"]] as [d, l]}
            <button type="button" class:on={keepDays === d} onclick={() => (keepDays = d as number | null)}>{l}</button>
          {/each}
          <input class="input sm days" type="number" min="1" max="36500" value={keepDays ?? ""} placeholder="days" aria-label="Days to keep" oninput={(e) => (keepDays = Number(e.currentTarget.value) || null)} />
        </div>
      </div>
    </div>

    {#if ex.result}
      <p class="note">
        <span>
          Every time Relay pulls <b>{source.name}</b>, it goes through each entry of <b>{listLabel}</b> and saves
          <b>{joinWords(valueNames)}</b> for the time in <b>{timeLabel}</b>. The latest pull gives <b>{n(ex.result.points)}</b> time{ex.result.points === 1 ? "" : "s"}{#if ex.result.oldest && ex.result.newest}, from {when(ex.result.oldest)} to {when(ex.result.newest)}{/if}.
          If a time is already saved, the newer numbers replace the old ones (an empty number never replaces a saved one). Each time is kept {keepLabel}{keepDays ? ", even after the pull it came from is deleted" : ""}.
        </span>
      </p>
      {#if Object.keys(ex.result.skipped).length}
        <p class="note warn"><span>Left out of the latest pull: {#each Object.entries(ex.result.skipped) as [why, count], i}{i ? "; " : ""}{n(count)} × {why.toLowerCase()}{/each}.</span></p>
      {/if}
      {#each values.filter((v) => ex?.result?.fallbacks[v.id]) as v}
        <p class="small muted">{n(ex.result.fallbacks[v.id])} entries use {fieldLabel(v.fallback)} because {v.name} was empty.</p>
      {/each}
      {#if !history && ex.storedPulls}<p class="small muted">Saving also reads back through the {n(ex.storedPulls)} pull{ex.storedPulls === 1 ? "" : "s"} already stored, so the history starts with everything Relay has kept so far.</p>{/if}
      {#if history}<p class="small muted">Saving changes clears this history and fills it in again from the pulls still stored.</p>{/if}

      <div class="split">
        <div class="box">
          <div class="box-head"><h3>{values[0]?.name ?? "Value"} in the latest pull</h3></div>
          <div style="padding: 12px"><Chart points={chartPoints} /></div>
        </div>
        <div class="box">
          <div class="box-head"><h3>First rows</h3><span class="muted small">{n(ex.result.points)} in all</span></div>
          <div class="scroll" style="max-height: 300px">
            <table>
              <thead><tr><th>Time</th>{#each values as v}<th class="mono">{v.name}</th>{/each}</tr></thead>
              <tbody>
                {#each ex.result.sample.slice(0, 12) as p}
                  <tr><td>{when(p.t)}</td>{#each values as v}<td class="mono">{p.values[v.id] ?? "—"}</td>{/each}</tr>
                {/each}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    {:else if loading}
      <div class="empty-state"><span class="spin"></span></div>
    {/if}
    {#if saveError}<p class="note bad">{saveError}</p>{/if}
  {/if}

  <div class="panel-foot">
    <button class="btn ghost" type="button" onclick={() => onDone(false)}>Cancel</button>
    <span class="row">
      {#if step !== "where"}<button class="btn" type="button" onclick={() => (step = STEPS[STEPS.findIndex((s) => s.id === step) - 1].id)}>← Back</button>{/if}
      {#if step === "save"}
        <button class="btn primary" type="button" disabled={!canSave || saving || !name.trim()} onclick={save}>{saving ? "Saving…" : history ? "Save changes" : "Save history"}</button>
      {:else}
        {@const next = STEPS[STEPS.findIndex((s) => s.id === step) + 1]}
        <button class="btn primary" type="button" disabled={!next.ok} onclick={() => (step = next.id)}>Next: {next.label.toLowerCase()} →</button>
      {/if}
    </span>
  </div>
</div>

<style>
  .wiz { display: grid; gap: 14px; }
  .step:disabled { opacity: .45; cursor: not-allowed; }
  .q h3 { margin: 0 0 4px; }
  .choices { display: grid; gap: 8px; }
  .choice { display: grid; gap: 8px; text-align: left; padding: 10px 14px; border-radius: 16px; border: 1px solid var(--line); background: var(--field); color: inherit; font: inherit; }
  button.choice { display: flex; gap: 12px; align-items: flex-start; cursor: pointer; }
  .choice:hover { border-color: var(--line-strong); }
  .choice.on { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
  .radio { width: 16px; height: 16px; border-radius: 50%; border: 1.5px solid var(--line-strong); flex: none; margin-top: 2px; }
  .choice.on .radio { border: 5px solid var(--accent); }
  .body { display: grid; gap: 4px; min-width: 0; }
  .title { font-size: .86rem; }
  .sample { font-family: var(--font-mono); font-size: .72rem; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tag { font-size: .68rem; padding: 1px 7px; border-radius: 999px; background: var(--accent-soft); color: var(--accent); font-weight: 600; margin-left: 4px; }
  .more { justify-self: start; }
  .pickrow { display: flex; gap: 12px; align-items: flex-start; cursor: pointer; }
  .pickrow input { width: 16px; height: 16px; accent-color: var(--accent); margin: 2px 0 0; flex: none; }
  .valopts { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; padding: 8px 0 2px 28px; border-top: 1px dashed var(--line); }
  .arg { display: inline-flex; gap: 6px; align-items: center; font-size: .78rem; color: var(--text-2); }
  .arg .input { width: auto; min-width: 90px; }
  .pipe { display: inline-flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .chip .lab { border: none; background: none; padding: 0; font: inherit; color: inherit; cursor: pointer; }
  .chip.editing { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
  .addop { padding: 4px 8px; border-radius: 10px; border: 1px dashed var(--line-strong); background: transparent; font-size: .74rem; cursor: pointer; }
  .editor { display: flex; flex-wrap: wrap; gap: 8px 14px; align-items: center; padding: 8px 12px; border-radius: 14px; background: var(--accent-soft); font-size: .8rem; width: 100%; }
  .prev { display: flex; flex-wrap: wrap; gap: 6px 14px; font-family: var(--font-mono); font-size: .74rem; width: 100%; }
  .pv b { padding: 1px 6px; border-radius: 6px; background: var(--accent-soft); }
  .fb { font-family: var(--font-body); font-size: .68rem; color: var(--warn); margin-left: 4px; }
  .err { color: var(--bad); }
  .warn-text { color: var(--warn); }
  .foot { padding: 10px 14px; }
  .savegrid { display: grid; gap: 12px; grid-template-columns: minmax(0, 1fr); }
  @media (min-width: 760px) { .savegrid { grid-template-columns: minmax(0, 1fr) auto; align-items: end; } }
  .days { width: 80px; padding: 3px 8px; }
  table { width: 100%; }
</style>
