<script lang="ts">
  import { onMount } from "svelte";
  import { api } from "../lib/api";
  import { meta } from "../lib/state.svelte";
  import { ago, bytes, n } from "../lib/format";
  import type { FeedState } from "../lib/types";
  import Stepper from "../components/Stepper.svelte";
  import FeedSourceCard from "./feed/FeedSourceCard.svelte";
  import FeedServing from "./feed/FeedServing.svelte";
  import FeedPreview from "./feed/FeedPreview.svelte";

  let { tab }: { tab: string } = $props();

  let feed = $state<FeedState | null>(null);
  let error = $state("");

  async function load() {
    try {
      feed = await api.get<FeedState>("/feeds/watts-up");
      error = "";
    } catch (e) {
      error = (e as Error).message;
    }
  }

  onMount(() => {
    load();
    const t = setInterval(load, 20_000);
    return () => clearInterval(t);
  });

  const url = $derived(feed ? `${meta.publicBaseUrl}/v1/${feed.settings.slug}` : "");
  const failing = $derived(feed?.sources.filter((s) => s.status === "error" || s.status === "stale").length ?? 0);
  const paused = $derived(feed?.sources.filter((s) => !s.enabled).length ?? 0);

  const steps = [
    { id: "sources", label: "Sources", hint: "What it polls" },
    { id: "serving", label: "Serving", hint: "Address, CORS, cache" },
    { id: "preview", label: "Preview", hint: "Today and tomorrow", n: "◷" },
  ];
</script>

<section class="card glass hero">
  <div class="hero-top">
    <div>
      <div class="eyebrow">Feeds / Built in</div>
      <h1 class="display">Watts Up</h1>
    </div>
    {#if feed}
      <div class="row">
        {#if !feed.settings.enabled}<span class="pill">Not served</span>{/if}
        {#if failing}<span class="pill bad"><span class="dot"></span>{failing} stale or failing</span>
        {:else}<span class="pill ok"><span class="dot"></span>All sources fine</span>{/if}
        {#if paused}<span class="pill">{paused} paused</span>{/if}
      </div>
    {/if}
  </div>
  <p class="sub">
    Polls Elexon, National Grid ESO, NESO, Octopus and Home Assistant in the background, keeps the last good data from each, and
    serves it as UK today and tomorrow in half-hours from one address. Requests only read Relay's database, never an upstream.
  </p>
  {#if feed}
    <div class="flow">
      <code class="url">GET {url}</code>
      <span>Built {ago(feed.build.builtAt)} · {bytes(feed.build.bytes)}, {bytes(feed.build.brBytes)} with Brotli</span>
      <span>{n(feed.counts.slots)} half-hours · {n(feed.counts.fuelReadings)} readings · {n(feed.counts.dfsEvents)} DFS events</span>
    </div>
    {#if feed.build.error}<p class="note bad">The last rebuild failed, so the previous response is still served: {feed.build.error}</p>{/if}
  {/if}
  <Stepper {steps} active={tab} base="feeds/watts-up" />
</section>

{#if error}
  <section class="card glass"><p class="note bad">{error}</p></section>
{:else if !feed}
  <section class="card glass"><div class="empty-state"><span class="spin"></span></div></section>
{:else if tab === "serving"}
  <FeedServing settings={feed.settings} onsaved={load} />
{:else if tab === "preview"}
  <FeedPreview builtAt={feed.build.builtAt} />
{:else}
  <section class="card glass">
    <div class="panel-head">
      <div>
        <h2>Sources</h2>
        <p class="sub">Each is polled on its own timer. One failing doesn't stop the others; its last good data keeps being served and it shows as stale. URLs take date placeholders like <code class="chipcode">{"{now-90m}"}</code> and <code class="chipcode">{"{today-1d:date}"}</code>.</p>
      </div>
    </div>
    <div class="stack tight">
      {#each feed.sources as s (s.key)}
        <FeedSourceCard source={s} onchange={load} />
      {/each}
    </div>
  </section>
{/if}

<style>
  .flow .url { max-width: 100%; }
</style>
