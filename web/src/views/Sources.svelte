<script lang="ts">
  import { onMount } from "svelte";
  import { api } from "../lib/api";
  import { ago, inFuture, n, scheduleLabel } from "../lib/format";
  import type { Source } from "../lib/types";

  let sources = $state<Source[] | null>(null);
  let error = $state("");

  onMount(() => {
    const load = () => api.get<Source[]>("/sources").then((s) => (sources = s)).catch((e) => (error = e.message));
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  });

  const failing = $derived(sources?.filter((s) => s.failStreak > 0).length ?? 0);
</script>

<section class="card glass hero">
  <div class="hero-top">
    <div>
      <div class="eyebrow">Step 1 · What to pull</div>
      <h1 class="display">Sources</h1>
    </div>
    <a class="btn primary" href="#/sources/new">+ New source</a>
  </div>
  <p class="sub">A source is an API Relay calls on a schedule. Every response is kept, so endpoints can compare now with earlier pulls.</p>
  {#if sources?.length}
    <div class="row">
      <span class="pill">{sources.length} source{sources.length === 1 ? "" : "s"}</span>
      {#if failing}<span class="pill bad"><span class="dot"></span>{failing} failing</span>{:else}<span class="pill ok"><span class="dot"></span>All pulling fine</span>{/if}
    </div>
  {/if}
</section>

<section class="card glass">
  {#if error}
    <p class="note bad">{error}</p>
  {:else if !sources}
    <div class="empty-state"><span class="spin"></span></div>
  {:else if !sources.length}
    <div class="empty-state">
      <h2>No sources yet</h2>
      <p>Add the first API you want Relay to pull.</p>
      <a class="btn primary" href="#/sources/new">+ New source</a>
    </div>
  {:else}
    <div class="list-cards">
      {#each sources as s (s.id)}
        <a class="lcard" href="#/sources/{s.id}/response">
          <div class="between">
            <span class="title">{s.name}</span>
            {#if !s.enabled}<span class="pill">Paused</span>
            {:else if s.failStreak > 0}<span class="pill bad"><span class="dot"></span>Failing ×{s.failStreak}</span>
            {:else if s.lastPulledAt}<span class="pill ok"><span class="dot"></span>OK</span>
            {:else}<span class="pill warn"><span class="dot"></span>Not pulled yet</span>{/if}
          </div>
          <span class="url">{s.method} {s.url}</span>
          <div class="meta">
            <span>{scheduleLabel(s.schedule)}</span>
            <span>Last pull {ago(s.lastPulledAt)}</span>
            {#if s.enabled && s.nextRun}<span>Next {inFuture(s.nextRun)}</span>{/if}
            <span>{n(s.counts.total)} stored</span>
          </div>
          {#if s.failStreak > 0 && s.lastError}<span class="err small">{s.lastError}</span>{/if}
        </a>
      {/each}
    </div>
  {/if}
</section>
