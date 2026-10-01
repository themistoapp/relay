<script lang="ts">
  import { onMount } from "svelte";
  import { api } from "../../lib/api";
  import { meta, say } from "../../lib/state.svelte";
  import { n } from "../../lib/format";
  import type { Source } from "../../lib/types";
  import type { SavedHistory } from "./types";
  import Chart from "../../components/Chart.svelte";
  import HistoryWizard from "./HistoryWizard.svelte";

  let { source }: { source: Source } = $props();

  let list = $state<SavedHistory[] | null>(null);
  /** The history being set up: "new", one being edited, or null when none is. */
  let editing = $state<SavedHistory | "new" | null>(null);
  let charts = $state<Record<number, { t: number; v: number }[]>>({});
  let confirmDel = $state<number | null>(null);
  let busy = $state<number | null>(null);

  async function load() {
    list = await api.get<SavedHistory[]>(`/sources/${source.id}/histories`);
    for (const h of list) loadChart(h);
  }

  async function loadChart(h: SavedHistory) {
    const v = h.definition.values[0];
    const r = await api.get<{ points: { t: number; values: Record<string, number | null> }[] }>(`/histories/${h.id}/points?from=${Date.now() - 30 * 86_400_000}`);
    charts[h.id] = r.points.map((p) => ({ t: p.t, v: p.values[v.id] })).filter((p): p is { t: number; v: number } => typeof p.v === "number");
  }

  onMount(load);

  const tz = $derived(meta.tz || "Europe/London");
  const day = (t: number) => new Date(t).toLocaleString("en-GB", { timeZone: tz, day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  const keep = (d: number | null) => (d === null ? "Kept for good" : d % 365 === 0 ? `Kept for ${d / 365} year${d === 365 ? "" : "s"}` : `Kept for ${n(d)} days`);

  async function rebuild(h: SavedHistory) {
    busy = h.id;
    try {
      const r = await api.post<{ pulls: number; points: number }>(`/histories/${h.id}/rebuild`);
      say(`Filled in ${n(r.points)} times from ${n(r.pulls)} stored pull${r.pulls === 1 ? "" : "s"}`);
      load();
    } catch (e) {
      say((e as Error).message, true);
    } finally {
      busy = null;
    }
  }

  async function remove(h: SavedHistory) {
    if (confirmDel !== h.id) {
      confirmDel = h.id;
      return;
    }
    try {
      await api.del(`/histories/${h.id}${h.usedBy?.length ? "?force=1" : ""}`);
      say("History deleted");
      load();
    } catch (e) {
      say((e as Error).message, true);
    } finally {
      confirmDel = null;
    }
  }
</script>

<section class="card glass">
  <div class="panel-head">
    <div>
      <h2>{editing === "new" ? "Keep a history" : editing ? `Edit “${editing.name}”` : "Saved histories"}</h2>
      <p class="sub">
        {#if editing}Four steps, each shown on the latest pull: find the list, pick the time, tick the numbers, then check and save.
        {:else}Numbers Relay keeps one row per time, long after the pulls they came from are pruned. An endpoint can then serve them, e.g. the last 7 days, one per hour.{/if}
      </p>
    </div>
    {#if !editing}<button class="btn sm primary" type="button" onclick={() => (editing = "new")}>+ Keep a history</button>{/if}
  </div>

  {#if editing}
    <HistoryWizard {source} history={editing === "new" ? null : editing} onDone={(saved) => { editing = null; if (saved) load(); }} />
  {:else if !list}
    <div class="empty-state"><span class="spin"></span></div>
  {:else if !list.length}
    <p class="note">
      <span>
        None yet. A history is useful when the API only shows recent data, like the next 48 hours of grid carbon or today's energy prices.
        Relay saves each time it sees, so you can serve last week's or last year's numbers even though the API has moved on.
      </span>
    </p>
  {:else}
    <div class="hlist">
      {#each list as h (h.id)}
        <div class="box">
          <div class="box-head">
            <div class="stack tight">
              <h3>{h.name}</h3>
              <span class="muted small">
                {h.definition.values.map((v) => v.name).join(", ")} ·
                {#if h.points}{n(h.points)} times saved, {day(h.oldest!)} to {day(h.newest!)}{:else}nothing saved yet{/if} ·
                {keep(h.keepDays)}
              </span>
              {#if h.usedBy?.length}<span class="small">Served by {#each h.usedBy as e, i}{i ? ", " : ""}<a href="#/endpoints/{e.id}/shape">{e.name}</a>{/each}</span>{/if}
            </div>
            <div class="row">
              <button class="btn sm" type="button" onclick={() => (editing = h)}>Edit</button>
              <button class="btn sm ghost" type="button" disabled={busy === h.id} onclick={() => rebuild(h)} title="Clear it and read every stored pull again">{busy === h.id ? "Filling in…" : "Refill from stored pulls"}</button>
              <button class="btn sm danger ghost" type="button" onclick={() => remove(h)}>{confirmDel === h.id ? (h.usedBy?.length ? "Endpoints use it. Click again" : "Click again") : "Delete"}</button>
            </div>
          </div>
          <div style="padding: 12px">
            {#if charts[h.id]}<Chart points={charts[h.id]} />{:else}<span class="spin"></span>{/if}
            <p class="hint">{h.definition.values[0]?.name}, last 30 days</p>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</section>

<style>
  .hlist { display: grid; gap: 12px; }
  .box-head h3 { margin: 0; }
</style>
