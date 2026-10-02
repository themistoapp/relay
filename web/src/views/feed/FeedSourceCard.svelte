<script lang="ts">
  import { untrack } from "svelte";
  import { api } from "../../lib/api";
  import { meta, say } from "../../lib/state.svelte";
  import { ago, inFuture, time } from "../../lib/format";
  import { fillPlaceholders } from "$engine/placeholders";
  import type { FeedPollResult, FeedSource } from "../../lib/types";
  import JsonView from "../../components/JsonView.svelte";

  let { source, onchange }: { source: FeedSource; onchange: () => void } = $props();

  const STATUS: Record<FeedSource["status"], { label: string; cls: string }> = {
    ok: { label: "OK", cls: "ok" },
    stale: { label: "Stale", cls: "warn" },
    error: { label: "Failing", cls: "bad" },
    pending: { label: "Not polled yet", cls: "" },
    disabled: { label: "Paused", cls: "" },
  };

  type Form = { url: string; backfillUrl: string | null; intervalMin: number; timeoutMs: number; authType: "none" | "bearer"; enabled: boolean };
  const formOf = (s: FeedSource): Form => ({ url: s.url, backfillUrl: s.backfillUrl, intervalMin: s.intervalMin, timeoutMs: s.timeoutMs, authType: s.authType, enabled: s.enabled });

  let open = $state(false);
  let form = $state<Form>(formOf(untrack(() => source)));
  let secret = $state("");
  let busy = $state<"" | "save" | "poll" | "test" | "reset">("");
  let formError = $state("");
  let test = $state<FeedPollResult | null>(null);

  function edit() {
    open = !open;
    if (open) {
      form = formOf(source);
      secret = "";
      test = null;
      formError = "";
    }
  }

  const payload = () => ({ ...form, backfillUrl: source.hasBackfill ? form.backfillUrl || null : null, authSecret: secret ? secret : undefined });
  const fill = (u: string) => {
    try {
      return fillPlaceholders(u, Date.now(), meta.tz || "Europe/London");
    } catch {
      return u;
    }
  };
  const hasDates = (u: string | null) => !!u && /\{(now|today|tomorrow)[^}]*\}/.test(u);
  const isSolar = $derived(source.key === "solar");

  async function run(kind: "save" | "poll" | "test" | "reset", backfill = false) {
    busy = kind;
    formError = "";
    try {
      if (kind === "save") {
        await api.put(`/feeds/watts-up/sources/${source.key}`, payload());
        secret = "";
        say("Saved. Polling it shortly.");
        open = false;
        onchange();
      } else if (kind === "reset") {
        const s = await api.post<FeedSource>(`/feeds/watts-up/sources/${source.key}/reset`);
        form = formOf(s);
        say("Back to the default settings");
        onchange();
      } else if (kind === "poll") {
        const r = await api.post<{ result: FeedPollResult }>(`/feeds/watts-up/sources/${source.key}/poll`);
        if (r.result.ok && !r.result.error) say(`Polled: ${r.result.rows} rows in ${r.result.durationMs} ms${r.result.backfill ? " (catch-up)" : ""}`);
        else say(`Poll failed: ${r.result.error}`, true);
        onchange();
      } else {
        test = await api.post<FeedPollResult>(`/feeds/watts-up/sources/${source.key}/test`, { ...payload(), backfill });
      }
    } catch (e) {
      formError = (e as Error).message;
      if (kind === "poll") say(formError, true);
    } finally {
      busy = "";
    }
  }

  const st = $derived(STATUS[source.status]);
</script>

<article class="box src">
  <div class="src-head">
    <div class="src-title">
      <span class="title">{source.name}</span>
      <span class="pill {st.cls}"><span class="dot"></span>{st.label}{source.failStreak > 1 ? ` ×${source.failStreak}` : ""}</span>
      {#if !source.isDefault}<span class="pill">Edited</span>{/if}
    </div>
    <div class="row">
      <button class="btn sm" type="button" onclick={() => run("poll")} disabled={!!busy}>{#if busy === "poll"}<span class="spin"></span>{/if} Poll now</button>
      <button class="btn sm ghost" type="button" onclick={edit} aria-expanded={open}>{open ? "Close" : "Edit"}</button>
    </div>
  </div>
  <p class="small muted">{source.about}</p>
  <div class="meta">
    <span>Every {source.intervalMin} min</span>
    <span>Last good {ago(source.lastSuccessAt)}</span>
    {#if source.latestPublishTime}<span>Published {time(source.latestPublishTime, true)}</span>{/if}
    {#if source.lastRows !== null}<span>{source.lastRows} rows · {source.lastDurationMs} ms</span>{/if}
    {#if source.enabled && source.nextPollAt}<span>Next {inFuture(source.nextPollAt)}</span>{/if}
  </div>
  {#if source.lastError && source.status !== "ok"}<p class="err small">{source.lastError}</p>{/if}

  {#if open}
    <form class="form edit" autocomplete="off" onsubmit={(e) => { e.preventDefault(); run("save"); }}>
      <div class="fld">
        <label for="fs-url-{source.key}">{isSolar ? "Home Assistant sensor state URL" : "URL"}</label>
        <input class="input mono" id="fs-url-{source.key}" type="url" required bind:value={form.url} />
        {#if isSolar}<span class="hint">The PV power sensor's <code class="chipcode">/api/states/sensor.…</code> URL. Daily kWh come from the same sensor's statistics.</span>
        {:else if hasDates(form.url)}<span class="hint">Next poll calls <code class="chipcode">{fill(form.url)}</code></span>{/if}
      </div>
      {#if source.hasBackfill}
        <div class="fld">
          <label for="fs-bf-{source.key}">Catch-up URL</label>
          <input class="input mono" id="fs-bf-{source.key}" type="url" value={form.backfillUrl ?? ""} oninput={(e) => (form.backfillUrl = e.currentTarget.value || null)} />
          <span class="hint">Used instead on the first poll after Relay starts, or after an hour without a good poll{#if hasDates(form.backfillUrl)}: <code class="chipcode">{fill(form.backfillUrl!)}</code>{/if}.</span>
        </div>
      {/if}
      <div class="fld s4">
        <label for="fs-int-{source.key}">Poll every (minutes)</label>
        <input class="input" id="fs-int-{source.key}" type="number" min="1" max="1440" bind:value={form.intervalMin} />
      </div>
      <div class="fld s4">
        <label for="fs-to-{source.key}">Give up after (seconds)</label>
        <input class="input" id="fs-to-{source.key}" type="number" min="1" max="120" value={form.timeoutMs / 1000} oninput={(e) => (form.timeoutMs = Math.round(Number(e.currentTarget.value) * 1000) || 20000)} />
      </div>
      <div class="fld s4">
        <span class="lbl">Polling</span>
        <label class="check"><input type="checkbox" bind:checked={form.enabled} /> Poll on schedule</label>
      </div>
      <div class="fld s4">
        <label for="fs-auth-{source.key}">Auth</label>
        <select class="input" id="fs-auth-{source.key}" bind:value={form.authType} disabled={isSolar}>
          <option value="none">None</option>
          <option value="bearer">Bearer token</option>
        </select>
      </div>
      {#if form.authType === "bearer"}
        <div class="fld s8">
          <label for="fs-tok-{source.key}">{isSolar ? "Long-lived access token" : "Token"}</label>
          <input class="input mono" id="fs-tok-{source.key}" type="password" bind:value={secret} placeholder={source.hasSecret ? "Saved. Leave blank to keep it." : ""} autocomplete="new-password" />
          <span class="hint">Stored encrypted and never shown again.</span>
        </div>
      {/if}
      {#if formError}<p class="err fld" role="alert">{formError}</p>{/if}
    </form>
    <div class="panel-foot">
      <div class="row">
        <button class="btn" type="button" onclick={() => run("test")} disabled={!!busy || !form.url}>{#if busy === "test"}<span class="spin"></span>{/if} Test</button>
        {#if source.hasBackfill && form.backfillUrl}<button class="btn ghost" type="button" onclick={() => run("test", true)} disabled={!!busy}>Test catch-up</button>{/if}
      </div>
      <div class="row">
        <button class="btn ghost" type="button" onclick={() => run("reset")} disabled={!!busy || source.isDefault}>Reset to default</button>
        <button class="btn primary" type="button" onclick={() => run("save")} disabled={!!busy || !form.url}>{#if busy === "save"}<span class="spin"></span>{/if} Save</button>
      </div>
    </div>
    {#if test}
      <div class="stack tight test">
        {#if test.ok}
          <p class="note"><span><b>{test.rows} rows</b> read in {test.durationMs} ms{test.error ? `, but ${test.error}` : ""}. Nothing was saved.</span></p>
        {:else}
          <p class="note bad">{test.error}</p>
        {/if}
        {#if test.url}<span class="hint">Called <code class="chipcode">{test.url}</code></span>{/if}
        {#if test.sample?.length}
          <div class="box"><div class="box-head"><h3>What Relay read (first few)</h3></div><div class="scroll short"><JsonView value={test.sample} /></div></div>
        {/if}
      </div>
    {/if}
  {/if}
</article>

<style>
  .src { padding: 14px 16px; display: grid; gap: 8px; }
  .src-head { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; }
  .src-title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
  .title { font-weight: 650; overflow-wrap: anywhere; }
  .meta { display: flex; gap: 4px 14px; flex-wrap: wrap; font-size: .76rem; color: var(--muted); }
  .edit { margin-top: 8px; padding-top: 14px; border-top: 1px solid var(--line); }
  .panel-foot { margin-top: 4px; padding-top: 12px; }
  .test { margin-top: 4px; }
  .short { max-height: 320px; }
</style>
