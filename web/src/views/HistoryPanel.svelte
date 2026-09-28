<script lang="ts">
  import { onMount } from "svelte";
  import { api, exportUrl } from "../lib/api";
  import { say } from "../lib/state.svelte";
  import { bytes, n, time } from "../lib/format";
  import { leafPaths } from "../lib/shape";
  import { diffJson } from "$engine/diff";
  import type { ShapeNode, Snapshot, Source } from "../lib/types";
  import Chart from "../components/Chart.svelte";
  import JsonView from "../components/JsonView.svelte";

  let { source }: { source: Source } = $props();

  let filter = $state<"all" | "changed" | "errors">("all");
  let rows = $state<Snapshot[]>([]);
  let next = $state<string | null>(null);
  let loading = $state(false);
  let selected = $state<number | null>(null);
  let detail = $state<{ snapshot: Snapshot; body: unknown; previous: { snapshot: Snapshot; body: unknown } | null } | null>(null);
  let showDiff = $state(true);
  let storage = $state<{ snapshots: number; storedBytes: number; rawBytes: number; oldest: number | null } | null>(null);

  let shape = $state<ShapeNode | null>(null);
  let seriesPath = $state("");
  let windowMs = $state(86_400_000);
  let points = $state<{ t: number; v: number }[]>([]);
  let seriesNote = $state("");

  async function loadRows(more = false) {
    loading = true;
    try {
      const q = new URLSearchParams({ filter, limit: "50" });
      if (more && next) q.set("before", next);
      const r = await api.get<{ rows: Snapshot[]; next: string | null }>(`/sources/${source.id}/snapshots?${q}`);
      rows = more ? [...rows, ...r.rows] : r.rows;
      next = r.next;
      if (!more && selected === null && rows.length) select(rows[0].id);
    } finally {
      loading = false;
    }
  }

  async function select(id: number) {
    selected = id;
    detail = await api.get(`/snapshots/${id}`);
  }

  async function loadStorage() {
    const s = await api.get<{ sources: { id: number; snapshots: number; storedBytes: number; rawBytes: number; oldest: number | null }[] }>("/storage");
    storage = s.sources.find((x) => x.id === source.id) ?? null;
  }

  async function loadSeries() {
    if (!seriesPath) return;
    try {
      const r = await api.get<{ points: { t: number; v: unknown }[] }>(`/sources/${source.id}/series?${new URLSearchParams({ path: seriesPath, from: String(Date.now() - windowMs) })}`);
      const num = r.points.map((p) => ({ t: p.t, v: typeof p.v === "number" ? p.v : typeof p.v === "string" && p.v.trim() !== "" ? Number(p.v) : NaN })).filter((p) => Number.isFinite(p.v));
      points = num;
      seriesNote = r.points.length && !num.length ? "That field isn't a number, so there's nothing to plot. Export it instead." : "";
    } catch (e) {
      seriesNote = (e as Error).message;
      points = [];
    }
  }

  onMount(async () => {
    loadRows();
    loadStorage();
    const latest = await api.get<{ shape: ShapeNode | null }>(`/sources/${source.id}/latest`);
    shape = latest.shape;
    const firstNumber = leafPaths(shape).find((l) => l.type === "number");
    if (firstNumber) seriesPath = firstNumber.path.replace(/\[\*\]/g, "[0]");
  });

  $effect(() => {
    void seriesPath;
    void windowMs;
    loadSeries();
  });

  const pathOptions = $derived(leafPaths(shape).map((l) => ({ ...l, path: l.path.replace(/\[\*\]/g, "[0]") })));
  const diff = $derived(detail && showDiff && detail.previous && detail.body !== null ? diffJson(detail.previous.body, detail.body) : null);
  const errorTimes = $derived(rows.filter((r) => !r.ok).map((r) => r.fetchedAt));
  const exportQ = (what: string, format: string) =>
    exportUrl(`/sources/${source.id}/export?${new URLSearchParams(what === "series" ? { what, format, path: seriesPath, from: String(Date.now() - windowMs) } : { what, format, filter })}`);

  async function prune() {
    const r = await api.post<{ deleted: number }>(`/sources/${source.id}/prune`);
    say(r.deleted ? `Removed ${n(r.deleted)} old pulls` : "Nothing to remove. Everything is inside the retention window.");
    loadRows();
    loadStorage();
  }

  let confirmDel = $state(false);
  async function deleteSelected() {
    if (!detail) return;
    if (!confirmDel) {
      confirmDel = true;
      return;
    }
    try {
      await api.del(`/snapshots/${detail.snapshot.id}`);
      say("Pull deleted");
      selected = null;
      detail = null;
      loadRows();
      loadStorage();
    } catch (e) {
      say((e as Error).message, true);
    } finally {
      confirmDel = false;
    }
  }

  const WINDOWS = [
    { label: "6 h", ms: 6 * 3_600_000 },
    { label: "24 h", ms: 86_400_000 },
    { label: "7 d", ms: 7 * 86_400_000 },
    { label: "30 d", ms: 30 * 86_400_000 },
  ];
</script>

<section class="card glass">
  <div class="panel-head">
    <div>
      <h2>History</h2>
      <p class="sub">Every pull is kept for {source.keepDays ? `${source.keepDays} day${source.keepDays === 1 ? "" : "s"}` : "ever"}. Browse the responses, see what changed, and track any field over time.</p>
    </div>
    <div class="chips">
      <a class="btn sm" href={exportQ("pulls", "csv")} download>Export CSV</a>
      <a class="btn sm" href={exportQ("pulls", "json")} download>Export JSON</a>
      <button class="btn sm ghost" type="button" onclick={prune}>Prune now</button>
    </div>
  </div>

  <div class="stack">
    <div class="stats">
      <div class="stat"><b>{n(source.counts.total)}</b><span>pulls stored{storage?.oldest ? ` · since ${time(storage.oldest, true)}` : ""}</span></div>
      <div class="stat"><b>{bytes(storage?.storedBytes)}</b><span>on disk ({bytes(storage?.rawBytes)} before compression and de-duplication)</span></div>
      <div class="stat"><b>{source.counts.okRate7d === null ? "—" : `${source.counts.okRate7d.toFixed(1)}%`}</b><span>pulls OK in the last 7 days</span></div>
      <div class="stat"><b>{n(source.counts.changed24h)}</b><span>changes in the last 24 h</span></div>
    </div>

    <div class="box">
      <div class="box-head">
        <div class="row">
          <h3>Field over time</h3>
          <select class="input sm mono" style="width: auto; max-width: 100%" bind:value={seriesPath} aria-label="Field to chart">
            {#each pathOptions as o}<option value={o.path}>{o.path.replace(/^\$\.?/, "")} · {o.type}</option>{/each}
            {#if seriesPath && !pathOptions.some((o) => o.path === seriesPath)}<option value={seriesPath}>{seriesPath}</option>{/if}
          </select>
          <div class="seg sm">
            {#each WINDOWS as w}<button type="button" class:on={windowMs === w.ms} onclick={() => (windowMs = w.ms)}>{w.label}</button>{/each}
          </div>
        </div>
        <div class="row">
          {#if points.length}<span class="mono" style="font-weight: 700">{points[points.length - 1].v}<span class="muted small" style="font-weight: 400">&nbsp;latest</span></span>{/if}
          <a class="btn sm ghost" href={exportQ("series", "csv")} download>CSV</a>
        </div>
      </div>
      <div style="padding: 12px">
        {#if seriesNote}<p class="muted small">{seriesNote}</p>{:else}<Chart {points} errors={errorTimes} />{/if}
      </div>
      <p class="hint" style="padding: 0 16px 12px">Pick a field inside a list by editing its number, e.g. <span class="mono">stations[2].price</span>. Red dashed lines are failed pulls.</p>
    </div>

    <div class="split">
      <div class="box">
        <div class="box-head">
          <h3>Pulls</h3>
          <div class="seg sm">
            {#each [["all", "All"], ["changed", "Changed"], ["errors", "Failed"]] as [v, l]}
              <button type="button" class:on={filter === v} onclick={() => { filter = v as typeof filter; loadRows(); }}>{l}</button>
            {/each}
          </div>
        </div>
        <div class="scroll" style="max-height: 460px">
          <table>
            <thead><tr><th>When</th><th>Status</th><th>Took</th><th>Size</th><th>Changed</th></tr></thead>
            <tbody>
              {#each rows as r (r.id)}
                <tr class="click" class:sel={r.id === selected} onclick={() => select(r.id)}>
                  <td>{time(r.fetchedAt, true)}</td>
                  <td><span class="status {r.ok ? 'ok' : 'bad'}">{r.status || "—"}</span></td>
                  <td>{n(r.durationMs)} ms</td>
                  <td>{r.ok ? bytes(r.bytes) : "—"}</td>
                  <td>{#if r.changed}<span class="mark on" title="Changed"></span>{:else}<span class="mark" title="No change"></span>{/if}</td>
                </tr>
              {:else}
                <tr><td colspan="5" class="muted">{loading ? "Loading…" : "No pulls match."}</td></tr>
              {/each}
            </tbody>
          </table>
          {#if next}<div style="padding: 10px"><button class="btn sm" type="button" onclick={() => loadRows(true)} disabled={loading}>Load older</button></div>{/if}
        </div>
      </div>

      <div class="box">
        <div class="box-head">
          <h3>{detail ? `${time(detail.snapshot.fetchedAt, true)} response` : "Response"}</h3>
          {#if detail}
            <div class="row">
              {#if detail.body !== null && detail.previous}
                <label class="check small"><input type="checkbox" bind:checked={showDiff} /> Changes since previous pull</label>
              {/if}
              <button class="btn sm danger ghost" type="button" onclick={deleteSelected}>{confirmDel ? "Click again" : "Delete"}</button>
            </div>
          {/if}
        </div>
        <div class="scroll" style="max-height: 460px">
          {#if !detail}
            <p class="muted small" style="padding: 16px">Pick a pull to see its response.</p>
          {:else if detail.body === null}
            <div style="padding: 16px" class="stack tight">
              <span class="status bad" style="justify-self: start">{detail.snapshot.status || "No response"}</span>
              <p>{detail.snapshot.error}</p>
              <p class="muted small">Endpoints kept serving the last good pull.</p>
            </div>
          {:else}
            {#if diff && diff.size === 0 && showDiff}<p class="muted small" style="padding: 10px 16px 0">Same as the previous pull.</p>{/if}
            <JsonView value={detail.body} {diff} />
          {/if}
        </div>
      </div>
    </div>
  </div>
</section>

<style>
  .mark { display: inline-block; width: 8px; height: 8px; border-radius: 50%; border: 1.5px solid var(--line); }
  .mark.on { background: var(--warn); border-color: var(--warn); }
</style>
