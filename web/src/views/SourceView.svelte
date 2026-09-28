<script lang="ts">
  import { onMount } from "svelte";
  import { api, ApiError } from "../lib/api";
  import { go } from "../lib/router.svelte";
  import { meta, say, pending } from "../lib/state.svelte";
  import { SCHEDULES, ago, bytes, inFuture, pullsPerDay, scheduleLabel, time } from "../lib/format";
  import type { Endpoint, ShapeNode, Snapshot, Source } from "../lib/types";
  import Stepper from "../components/Stepper.svelte";
  import ShapeTree from "../components/ShapeTree.svelte";
  import JsonView from "../components/JsonView.svelte";
  import HistoryPanel from "./HistoryPanel.svelte";

  let { id, tab }: { id: string; tab: string } = $props();
  const isNew = $derived(id === "new");

  type Form = Omit<Source, "id" | "hasSecret" | "failStreak" | "lastPulledAt" | "lastStatus" | "lastError" | "nextRun" | "counts" | "usedBy">;
  const blank = (): Form => ({
    name: "",
    method: "GET",
    url: "",
    headers: [],
    body: null,
    authType: "none",
    authName: "",
    schedule: "*/15 * * * *",
    keepDays: 30,
    keepCount: null,
    timeoutMs: 15000,
    enabled: true,
  });

  let source = $state<Source | null>(null);
  let form = $state<Form>(blank());
  let secret = $state("");
  let loadError = $state("");

  type TestResult = { status: number; ok: boolean; durationMs: number; bytes: number; error: string | null; body: unknown; shape: ShapeNode | null; at: number };
  let test = $state<TestResult | null>(null);
  let testing = $state(false);
  let saving = $state(false);
  let formError = $state("");

  let latest = $state<{ snapshot: Snapshot | null; body: unknown; shape: ShapeNode | null } | null>(null);
  let pulling = $state(false);

  async function load() {
    if (isNew) return;
    try {
      source = await api.get<Source>(`/sources/${id}`);
      const { id: _i, hasSecret: _h, failStreak: _f, lastPulledAt: _l, lastStatus: _s, lastError: _e, nextRun: _n, counts: _c, usedBy: _u, ...rest } = source;
      form = { ...rest, headers: rest.headers.map((h) => ({ ...h })) };
    } catch (e) {
      loadError = (e as Error).message;
    }
  }

  async function loadLatest() {
    if (isNew) return;
    latest = await api.get(`/sources/${id}/latest`);
  }

  onMount(() => {
    load();
  });
  $effect(() => {
    if (tab === "response" && !isNew && !latest) loadLatest().catch(() => {});
  });

  // ---- schedule ----
  const preset = $derived(SCHEDULES.find((s) => s.cron === form.schedule));
  let custom = $state(false);
  let cronCheck = $state<{ error: string | null; next: number[] } | null>(null);
  let cronTimer: ReturnType<typeof setTimeout>;
  $effect(() => {
    const expr = form.schedule;
    clearTimeout(cronTimer);
    cronTimer = setTimeout(() => api.post<{ error: string | null; next: number[] }>("/schedule/check", { schedule: expr }).then((r) => (cronCheck = r)).catch(() => {}), 300);
  });

  const KEEP = [
    { label: "24 hours", days: 1 },
    { label: "7 days", days: 7 },
    { label: "30 days", days: 30 },
    { label: "90 days", days: 90 },
    { label: "1 year", days: 365 },
    { label: "Forever", days: null },
  ];

  const sizeGuess = $derived.by(() => {
    const b = test?.bytes ?? latest?.snapshot?.bytes ?? null;
    const perDay = pullsPerDay(form.schedule);
    if (!b || !perDay) return null;
    const days = form.keepDays ?? 365;
    return { pulls: perDay * days, bytes: b * perDay * days, forever: form.keepDays === null };
  });

  // ---- actions ----
  function payload() {
    return {
      ...form,
      name: form.name.trim() || hostName(form.url),
      body: form.method === "GET" ? null : form.body || null,
      headers: form.headers.filter((h) => h.key.trim()),
      authSecret: form.authType === "none" ? (isNew ? null : undefined) : secret ? secret : isNew ? null : undefined,
    };
  }

  function hostName(u: string) {
    try {
      return new URL(u).hostname;
    } catch {
      return "";
    }
  }

  async function runTest() {
    testing = true;
    formError = "";
    try {
      const r = await api.post<Omit<TestResult, "at">>("/sources/test", { ...payload(), id: source?.id });
      test = { ...r, at: Date.now() };
      if (r.ok) say(`It worked: ${r.status} in ${r.durationMs} ms`);
    } catch (e) {
      formError = (e as Error).message;
    } finally {
      testing = false;
    }
  }

  async function save() {
    saving = true;
    formError = "";
    try {
      if (isNew) {
        const s = await api.post<Source>("/sources", payload());
        say("Source saved. Pulling it now…");
        await api.post(`/sources/${s.id}/pull`).catch(() => {});
        go(`sources/${s.id}/response`);
      } else {
        source = { ...source!, ...(await api.put<Source>(`/sources/${id}`, payload())) };
        secret = "";
        say("Saved");
      }
    } catch (e) {
      formError = (e as Error).message;
    } finally {
      saving = false;
    }
  }

  async function pullNow() {
    pulling = true;
    try {
      const r = await api.post<{ snapshot: Snapshot }>(`/sources/${id}/pull`);
      if (r.snapshot.ok) say(r.snapshot.changed ? "Pulled. The response has changed." : "Pulled. No change since last time.");
      else say(`Pull failed: ${r.snapshot.error}`, true);
      await Promise.all([loadLatest(), load()]);
    } catch (e) {
      say((e as Error).message, true);
    } finally {
      pulling = false;
    }
  }

  async function buildEndpoint() {
    try {
      const e = await api.post<Endpoint>("/endpoints", { name: source?.name ?? "New endpoint" });
      pending.sourceId = source?.id ?? null;
      go(`endpoints/${e.id}/pick`);
    } catch (e) {
      say((e as Error).message, true);
    }
  }

  let confirmDelete = $state<"" | "ask" | "used">("");
  let usedBy = $state<{ name: string }[]>([]);
  async function del(force = false) {
    if (!confirmDelete) {
      confirmDelete = "ask";
      return;
    }
    try {
      await api.del(`/sources/${id}${force ? "?force=1" : ""}`);
      say("Source deleted");
      go("sources");
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        usedBy = e.data.usedBy;
        confirmDelete = "used";
      } else say((e as Error).message, true);
    }
  }

  const showTest = $derived(!!test && (!latest?.snapshot || test.at > latest.snapshot.fetchedAt));
  const responseBody = $derived(showTest ? test!.body : latest?.body);
  const responseShape = $derived(showTest ? test!.shape : latest?.shape);

  const steps = [
    { id: "request", label: "Request", hint: "URL, auth, schedule" },
    { id: "response", label: "Response", hint: "See the shape" },
    { id: "history", label: "History", hint: "Every pull, over time", n: "◷" },
  ];
</script>

<section class="card glass hero">
  <div class="hero-top">
    <div>
      <div class="eyebrow"><a href="#/sources">Sources</a> / {isNew ? "New" : "Source"}</div>
      <h1 class="display">{isNew ? form.name || "New source" : (source?.name ?? "…")}</h1>
    </div>
    {#if source}
      <div class="row">
        {#if !source.enabled}<span class="pill">Paused</span>
        {:else if source.failStreak > 0}<span class="pill bad"><span class="dot"></span>Failing ×{source.failStreak}</span>
        {:else if source.lastPulledAt}<span class="pill ok"><span class="dot"></span>Pulled {ago(source.lastPulledAt)}</span>{/if}
        <span class="pill">{scheduleLabel(source.schedule)}</span>
        {#if source.enabled && source.nextRun}<span class="pill">Next {inFuture(source.nextRun)}</span>{/if}
      </div>
    {/if}
  </div>
  {#if source?.failStreak && source.lastError}<p class="note bad">Last pull failed: {source.lastError}</p>{/if}
  {#if !isNew}<Stepper {steps} active={tab} base="sources/{id}" />{/if}
</section>

{#if loadError}
  <section class="card glass"><p class="note bad">{loadError}</p></section>
{:else if tab === "history" && source}
  <HistoryPanel {source} />
{:else if tab === "response" && (source || test)}
  <section class="card glass">
    <div class="panel-head">
      <div>
        <h2>What the API sends back</h2>
        <p class="sub">
          {#if showTest}Test result from {time(test!.at)}, not saved. Save the source to start storing pulls.
          {:else if latest?.snapshot}The latest good pull, from {time(latest.snapshot.fetchedAt, true)}. List items are merged, so keys only some items have still show up.
          {:else}No successful pull yet.{/if}
        </p>
      </div>
      <div class="row">
        {#if responseBody !== undefined && responseBody !== null}
          <span class="pill"><span class="status ok">{showTest ? test!.status : latest?.snapshot?.status}</span>{bytes(showTest ? test!.bytes : latest?.snapshot?.bytes)} · {showTest ? test!.durationMs : latest?.snapshot?.durationMs} ms</span>
        {/if}
        {#if !isNew}<button class="btn" type="button" onclick={pullNow} disabled={pulling}>{#if pulling}<span class="spin"></span>{/if} Pull now</button>{/if}
        {#if !isNew && latest?.snapshot}<button class="btn primary" type="button" onclick={buildEndpoint}>Build an endpoint →</button>{/if}
      </div>
    </div>
    {#if showTest && !test!.ok}
      <p class="note bad">{test!.error}</p>
    {:else if responseShape}
      <div class="split">
        <div class="box"><div class="box-head"><h3>Shape</h3></div><div class="scroll"><ShapeTree shape={responseShape} /></div></div>
        <div class="box"><div class="box-head"><h3>Raw response</h3></div><div class="scroll"><JsonView value={responseBody} /></div></div>
      </div>
    {:else if latest === null}
      <div class="empty-state"><span class="spin"></span></div>
    {:else}
      <div class="empty-state"><p>Nothing yet. Press <b>Pull now</b>, or wait for the schedule.</p></div>
    {/if}
  </section>
{:else}
  <section class="card glass">
    <div class="panel-head">
      <div>
        <h2>Where does the data come from?</h2>
        <p class="sub">Relay calls this URL on a schedule and keeps every response, so later steps can look back over time.</p>
      </div>
    </div>
    <form class="form" autocomplete="off" onsubmit={(e) => { e.preventDefault(); save(); }}>
      <div class="fld s6">
        <label for="src-name">Name</label>
        <input class="input" id="src-name" bind:value={form.name} placeholder={hostName(form.url) || "e.g. Local fuel"} />
      </div>
      <div class="fld s6">
        <label for="src-keep">Keep history for</label>
        <select class="input" id="src-keep" value={String(form.keepDays)} onchange={(e) => (form.keepDays = e.currentTarget.value === "null" ? null : Number(e.currentTarget.value))}>
          {#each KEEP as k}<option value={String(k.days)}>{k.label}</option>{/each}
          {#if !KEEP.some((k) => k.days === form.keepDays)}<option value={String(form.keepDays)}>{form.keepDays} days</option>{/if}
        </select>
        {#if sizeGuess}
          <span class="hint">About {sizeGuess.pulls.toLocaleString("en-GB")} pulls{sizeGuess.forever ? " a year" : ""}. At most {bytes(sizeGuess.bytes)} before compression; unchanged responses are only stored once.</span>
        {/if}
      </div>
      <div class="fld">
        <label for="src-url">Request</label>
        <div class="joined">
          <select class="input mono" bind:value={form.method} aria-label="HTTP method">
            {#each ["GET", "POST", "PUT", "PATCH"] as m}<option>{m}</option>{/each}
          </select>
          <input class="input mono" id="src-url" type="url" required bind:value={form.url} placeholder="https://api.example.com/v1/prices?town=example" />
        </div>
      </div>
      {#if form.method !== "GET"}
        <div class="fld">
          <label for="src-body">Request body (JSON)</label>
          <textarea class="input" id="src-body" value={form.body ?? ""} oninput={(e) => (form.body = e.currentTarget.value)}></textarea>
        </div>
      {/if}
      <div class="fld s4">
        <label for="src-auth">Auth</label>
        <select class="input" id="src-auth" bind:value={form.authType}>
          <option value="none">None</option>
          <option value="bearer">Bearer token</option>
          <option value="header">API key in a header</option>
          <option value="query">API key in the URL</option>
          <option value="basic">Username and password</option>
        </select>
      </div>
      {#if form.authType === "header" || form.authType === "query" || form.authType === "basic"}
        <div class="fld s3">
          <label for="src-authname">{form.authType === "basic" ? "Username" : form.authType === "header" ? "Header name" : "Parameter name"}</label>
          <input class="input mono" id="src-authname" bind:value={form.authName} placeholder={form.authType === "header" ? "X-Api-Key" : form.authType === "query" ? "key" : ""} />
        </div>
      {/if}
      {#if form.authType !== "none"}
        <div class="fld {form.authType === 'bearer' ? 's8' : 's4'}">
          <label for="src-secret">{form.authType === "basic" ? "Password" : "Token"}</label>
          <input class="input mono" id="src-secret" type="password" bind:value={secret} placeholder={source?.hasSecret ? "Saved. Leave blank to keep it." : ""} autocomplete="new-password" />
          <span class="hint">Stored encrypted. Never shown again, and hidden in the Data browser.</span>
        </div>
      {/if}
      <div class="fld">
        <span class="lbl">Extra headers</span>
        {#each form.headers as h, i}
          <div class="joined">
            <input class="input mono" style="width: 34%" bind:value={h.key} placeholder="Header" aria-label="Header name" />
            <input class="input mono" bind:value={h.value} placeholder="Value" aria-label="Header value" />
            <button class="iconbtn del" type="button" aria-label="Remove header" onclick={() => form.headers.splice(i, 1)}>✕</button>
          </div>
        {/each}
        <div><button class="btn sm ghost" type="button" onclick={() => form.headers.push({ key: "", value: "" })}>+ Add header</button></div>
      </div>
      <div class="fld">
        <span class="lbl">Pull every</span>
        <div class="row">
          <div class="seg">
            {#each SCHEDULES as s}
              <button type="button" class:on={!custom && preset?.cron === s.cron} onclick={() => { custom = false; form.schedule = s.cron; }}>{s.label}</button>
            {/each}
            <button type="button" class:on={custom || !preset} onclick={() => (custom = true)}>Custom</button>
          </div>
        </div>
        {#if custom || !preset}
          <input class="input mono" style="max-width: 280px" bind:value={form.schedule} aria-label="Cron expression" placeholder="*/15 6-22 * * *" />
          <span class="hint">Cron: minute hour day month weekday, in {meta.tz || "the server's time zone"}.</span>
        {/if}
        {#if cronCheck?.error}<span class="err">{cronCheck.error}</span>
        {:else if cronCheck?.next.length}<span class="hint">Next: {cronCheck.next.map((t) => time(t, true)).join(", ")}</span>{/if}
      </div>
      <details class="fld">
        <summary class="lbl">More settings</summary>
        <div class="form" style="margin-top: 12px">
          <div class="fld s4">
            <label for="src-timeout">Give up after (seconds)</label>
            <input class="input" id="src-timeout" type="number" min="1" max="120" value={form.timeoutMs / 1000} oninput={(e) => (form.timeoutMs = Math.round(Number(e.currentTarget.value) * 1000) || 15000)} />
          </div>
          <div class="fld s4">
            <label for="src-count">Also keep at most (pulls)</label>
            <input class="input" id="src-count" type="number" min="1" placeholder="No limit" value={form.keepCount ?? ""} oninput={(e) => (form.keepCount = e.currentTarget.value ? Number(e.currentTarget.value) : null)} />
          </div>
          <div class="fld s4">
            <span class="lbl">Schedule</span>
            <label class="check"><input type="checkbox" bind:checked={form.enabled} /> Pull on schedule</label>
          </div>
        </div>
      </details>
      {#if formError}<p class="err fld" role="alert">{formError}</p>{/if}
    </form>

    <div class="panel-foot">
      <div class="row">
        <button class="btn" type="button" onclick={runTest} disabled={testing || !form.url}>{#if testing}<span class="spin"></span>{/if} Test request</button>
        {#if test}
          <span class="small">
            <span class="status {test.ok ? 'ok' : 'bad'}">{test.status || "—"}</span>
            {test.ok ? `${test.durationMs} ms · ${bytes(test.bytes)}` : test.error}
            {#if test.ok && !isNew}· <a href="#/sources/{id}/response">See it</a>{/if}
          </span>
        {/if}
      </div>
      <div class="row">
        {#if !isNew}
          {#if confirmDelete === "used"}
            <span class="small err">Used by {usedBy.map((u) => u.name).join(", ")}.</span>
            <button class="btn danger" type="button" onclick={() => del(true)}>Delete anyway</button>
          {:else}
            <button class="btn danger ghost" type="button" onclick={() => del()}>{confirmDelete ? "Click again to delete" : "Delete"}</button>
          {/if}
        {/if}
        <button class="btn primary" type="button" onclick={save} disabled={saving || !form.url}>{#if saving}<span class="spin"></span>{/if} {isNew ? "Save and pull" : "Save"}</button>
      </div>
    </div>
    {#if isNew && test?.ok && test.shape}
      <div style="margin-top: 18px" class="split">
        <div class="box"><div class="box-head"><h3>Shape</h3></div><div class="scroll"><ShapeTree shape={test.shape} /></div></div>
        <div class="box"><div class="box-head"><h3>Raw response</h3></div><div class="scroll"><JsonView value={test.body} /></div></div>
      </div>
    {/if}
  </section>
{/if}

<style>
  details summary { cursor: pointer; }
  .eyebrow a { color: inherit; text-decoration: none; }
  .eyebrow a:hover { text-decoration: underline; }
</style>
