<script lang="ts">
  import { onMount } from "svelte";
  import { api, exportUrl } from "../lib/api";
  import { meta, say } from "../lib/state.svelte";
  import { bytes, n, time } from "../lib/format";

  type Storage = { dbBytes: number; sources: { id: number; name: string; snapshots: number; storedBytes: number; rawBytes: number; oldest: number | null }[]; backups: string[] };

  let tables = $state<{ name: string; count: number }[]>([]);
  let table = $state("snapshots");
  let page = $state(0);
  let grid = $state<{ columns: string[]; rows: unknown[][]; total: number; limit: number } | null>(null);
  let storage = $state<Storage | null>(null);
  let backingUp = $state(false);

  const TIME_COLS = new Set(["fetched_at", "created_at", "updated_at", "last_pulled_at", "last_used_at", "revoked_at", "at"]);

  async function loadGrid() {
    grid = await api.get(`/tables/${table}?page=${page}&limit=50`);
  }
  async function loadStorage() {
    storage = await api.get<Storage>("/storage");
  }

  onMount(async () => {
    tables = await api.get("/tables");
    loadStorage();
  });
  $effect(() => {
    void table;
    void page;
    loadGrid();
  });

  function cell(col: string, v: unknown): string {
    if (v === null || v === undefined) return "";
    if (TIME_COLS.has(col) && typeof v === "number") return new Date(v).toISOString().replace("T", " ").slice(0, 19);
    return String(v);
  }

  async function backup() {
    backingUp = true;
    try {
      const r = await api.post<{ file: string | null }>("/backup");
      say(r.file ? "Backed up" : "Backups are off in this setup", !r.file);
      loadStorage();
    } catch (e) {
      say((e as Error).message, true);
    } finally {
      backingUp = false;
    }
  }

  async function importConfig(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    try {
      const cfg = JSON.parse(await file.text());
      const r = await api.post<{ sources: number; endpoints: number }>("/config/import", cfg);
      say(`Imported ${r.sources} sources and ${r.endpoints} endpoints. Re-enter their tokens, then switch the endpoints on.`);
      tables = await api.get("/tables");
      loadStorage();
    } catch (err) {
      say(err instanceof SyntaxError ? "That file isn't JSON." : (err as Error).message, true);
    }
  }

  const pages = $derived(grid ? Math.max(1, Math.ceil(grid.total / grid.limit)) : 1);
</script>

<section class="card glass hero">
  <div class="hero-top">
    <div>
      <div class="eyebrow">Database</div>
      <h1 class="display">Data</h1>
    </div>
    <span class="pill">relay.db · SQLite · {bytes(storage?.dbBytes)}</span>
  </div>
  <p class="sub">A read-only look at the tables behind Relay. Tokens and key hashes are always hidden. Response bodies are stored gzipped, once per distinct response.</p>
</section>

<section class="card glass">
  <div class="data-grid">
    <div class="box tlist">
      {#each tables as t (t.name)}
        <button type="button" class:on={t.name === table} onclick={() => { table = t.name; page = 0; }}>
          <span>{t.name}</span><span>{n(t.count)}</span>
        </button>
      {/each}
    </div>
    <div style="min-width: 0">
      {#if grid}
        <div class="tbl-wrap" style="max-height: 560px; overflow: auto">
          <table>
            <thead><tr>{#each grid.columns as c}<th>{c}</th>{/each}</tr></thead>
            <tbody>
              {#each grid.rows as r}
                <tr>{#each r as v, i}<td class:mono={typeof v === "string" && (v.startsWith("http") || v.startsWith("{"))} class:masked={typeof v === "string" && v.includes("hidden")}>{cell(grid.columns[i], v)}</td>{/each}</tr>
              {:else}
                <tr><td colspan={grid.columns.length} class="muted">Empty.</td></tr>
              {/each}
            </tbody>
          </table>
        </div>
        <div class="between pager">
          <span class="muted small">{grid.total ? `${n(page * grid.limit + 1)}–${n(Math.min(grid.total, (page + 1) * grid.limit))} of ${n(grid.total)}, newest first` : "No rows"}</span>
          <div class="row">
            <button class="btn sm ghost" type="button" disabled={page === 0} onclick={() => page--}>← Newer</button>
            <button class="btn sm" type="button" disabled={page >= pages - 1} onclick={() => page++}>Older →</button>
          </div>
        </div>
      {:else}
        <div class="empty-state"><span class="spin"></span></div>
      {/if}
    </div>
  </div>
</section>

<section class="card glass">
  <div class="split">
    <div class="stack tight">
      <h2>Storage</h2>
      <div class="tbl-wrap">
        <table>
          <thead><tr><th>Source</th><th>Pulls</th><th>On disk</th><th>Raw</th><th>Since</th></tr></thead>
          <tbody>
            {#each storage?.sources ?? [] as s (s.id)}
              <tr>
                <td><a href="#/sources/{s.id}/history">{s.name}</a></td>
                <td>{n(s.snapshots)}</td>
                <td>{bytes(s.storedBytes)}</td>
                <td class="muted">{bytes(s.rawBytes)}</td>
                <td>{s.oldest ? time(s.oldest, true) : "—"}</td>
              </tr>
            {:else}
              <tr><td colspan="5" class="muted">No sources.</td></tr>
            {/each}
          </tbody>
        </table>
      </div>
      <p class="hint">Old pulls are pruned every hour using each source's "keep history" setting.</p>
    </div>

    <div class="stack tight">
      <h2>Backups</h2>
      <p class="sub small">A copy of the database is made every night at 03:17 ({meta.tz}) in <span class="mono">/data/backups</span>, keeping the most recent ones.</p>
      <div class="tbl-wrap">
        <table>
          <tbody>
            {#each storage?.backups ?? [] as b}<tr><td class="mono">{b}</td></tr>{:else}<tr><td class="muted">No backups yet.</td></tr>{/each}
          </tbody>
        </table>
      </div>
      <div class="row"><button class="btn" type="button" onclick={backup} disabled={backingUp}>{#if backingUp}<span class="spin"></span>{/if} Back up now</button></div>

      <h2 style="margin-top: 14px">Settings export</h2>
      <p class="sub small">Every source and endpoint as one JSON file, to keep in git or move to another Relay. Tokens and API keys aren't included.</p>
      <div class="row">
        <a class="btn" href={exportUrl("/config/export")} download>Export settings</a>
        <label class="btn ghost">Import settings…<input type="file" accept="application/json,.json" hidden onchange={importConfig} /></label>
      </div>
    </div>
  </div>
</section>

<style>
  .data-grid { display: grid; gap: 16px; grid-template-columns: minmax(0, 1fr); }
  @media (min-width: 860px) { .data-grid { grid-template-columns: 210px minmax(0, 1fr); } }
  .tlist { display: grid; gap: 4px; align-content: start; padding: 8px; }
  .tlist button { display: flex; justify-content: space-between; gap: 10px; padding: 9px 12px; border-radius: 12px; border: none; background: transparent; cursor: pointer; font-family: var(--font-mono); font-size: .8rem; text-align: left; }
  .tlist button:hover { background: var(--accent-soft); }
  .tlist button.on { background: var(--glass-strong); box-shadow: var(--shadow-sm); font-weight: 700; }
  .tlist button span:last-child { color: var(--muted); font-variant-numeric: tabular-nums; }
  .pager { padding: 10px 4px 0; }
  td.masked { color: var(--muted); }
  td { max-width: 42ch; overflow: hidden; text-overflow: ellipsis; }
</style>
