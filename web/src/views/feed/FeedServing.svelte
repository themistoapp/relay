<script lang="ts">
  import { untrack } from "svelte";
  import { api } from "../../lib/api";
  import { meta, say } from "../../lib/state.svelte";
  import type { FeedSettings } from "../../lib/types";

  let { settings, onsaved }: { settings: FeedSettings; onsaved: () => void } = $props();

  // A copy to edit; the parent's refreshes don't overwrite unsaved changes.
  let draft = $state<FeedSettings>(structuredClone($state.snapshot(untrack(() => settings))));
  let origin = $state("");
  let originError = $state("");
  let saving = $state(false);
  let formError = $state("");

  const dirty = $derived(JSON.stringify(draft) !== JSON.stringify(settings));
  const url = $derived(`${meta.publicBaseUrl}/v1/${draft.slug}`);

  function addOrigin() {
    const o = origin.trim().replace(/\/$/, "");
    if (o !== "*" && !/^https?:\/\/[^/\s]+$/.test(o)) {
      originError = "An origin looks like https://example.com, with no path.";
      return;
    }
    if (!draft.corsOrigins.includes(o)) draft.corsOrigins.push(o);
    origin = "";
    originError = "";
  }

  async function save() {
    saving = true;
    formError = "";
    try {
      draft = await api.put<FeedSettings>("/feeds/watts-up/settings", draft);
      say("Saved");
      onsaved();
    } catch (e) {
      formError = (e as Error).message;
    } finally {
      saving = false;
    }
  }
</script>

<section class="card glass">
  <div class="panel-head">
    <div>
      <h2>Serving</h2>
      <p class="sub">Public, no API key. The response is rebuilt after every poll and kept compressed, with an ETag, so browsers and proxies can reuse it.</p>
    </div>
  </div>
  <form class="form" autocomplete="off" onsubmit={(e) => { e.preventDefault(); save(); }}>
    <div class="fld s6">
      <label for="fd-slug">Address</label>
      <div class="joined">
        <span class="input mono prefix">/v1/</span>
        <input class="input mono" id="fd-slug" bind:value={draft.slug} />
      </div>
      <span class="hint"><code class="chipcode">{url}</code></span>
    </div>
    <div class="fld s6">
      <span class="lbl">Serving</span>
      <label class="check"><input type="checkbox" bind:checked={draft.enabled} /> Serve this feed</label>
      <span class="hint">Turning it off stops the address answering. Polling carries on, so it's up to date when switched back on.</span>
    </div>
    <div class="fld">
      <span class="lbl">Browsers allowed to call it (CORS)</span>
      <div class="chips">
        {#each draft.corsOrigins as o, i}
          <span class="chip">{o}<button class="x" type="button" aria-label="Remove {o}" onclick={() => draft.corsOrigins.splice(i, 1)}>×</button></span>
        {/each}
        <input class="input sm origin" bind:value={origin} placeholder="https://app.example.com" aria-label="Add an origin" onkeydown={(e) => e.key === "Enter" && (e.preventDefault(), addOrigin())} />
        <button class="btn sm" type="button" onclick={addOrigin} disabled={!origin.trim()}>Add</button>
      </div>
      {#if originError}<span class="err">{originError}</span>{/if}
    </div>
    <div class="fld s4">
      <label for="fd-age">Browser cache (seconds)</label>
      <input class="input" id="fd-age" type="number" min="0" max="86400" bind:value={draft.maxAge} />
    </div>
    <div class="fld s4">
      <label for="fd-swr">Then serve stale while refreshing (seconds)</label>
      <input class="input" id="fd-swr" type="number" min="0" max="86400" bind:value={draft.staleWhileRevalidate} />
    </div>
    <div class="fld s4">
      <label for="fd-rl">Requests per minute, per visitor</label>
      <input class="input" id="fd-rl" type="number" min="1" bind:value={draft.rateLimitPerMin} />
    </div>
    <div class="fld s6">
      <label for="fd-keep">Keep half-hours and readings for (days)</label>
      <input class="input" id="fd-keep" type="number" min="2" max="3650" bind:value={draft.retainDays} />
      <span class="hint">Only today and tomorrow are served; older rows are kept for checking and rebuilding.</span>
    </div>
    <div class="fld s6">
      <label for="fd-dfs">List DFS events that ended up to (days ago)</label>
      <input class="input" id="fd-dfs" type="number" min="0" max="365" bind:value={draft.dfsHistoryDays} />
    </div>
    {#if formError}<p class="err fld" role="alert">{formError}</p>{/if}
  </form>
  <div class="panel-foot">
    <span class="small muted">Sent as <code class="chipcode">Cache-Control: public, max-age={draft.maxAge}, stale-while-revalidate={draft.staleWhileRevalidate}</code></span>
    <div class="row">
      {#if dirty}<button class="btn ghost" type="button" onclick={() => (draft = structuredClone($state.snapshot(settings)))}>Undo changes</button>{/if}
      <button class="btn primary" type="button" onclick={save} disabled={saving || !dirty}>{#if saving}<span class="spin"></span>{/if} Save</button>
    </div>
  </div>
</section>

<style>
  .prefix { width: auto; color: var(--muted); display: inline-flex; align-items: center; }
  .origin { width: min(240px, 100%); }
</style>
