<script lang="ts">
  import { onMount } from "svelte";
  import { api } from "../lib/api";
  import { go } from "../lib/router.svelte";
  import { meta, say } from "../lib/state.svelte";
  import { n } from "../lib/format";
  import type { Endpoint } from "../lib/types";

  let endpoints = $state<Endpoint[] | null>(null);
  let error = $state("");

  onMount(() => {
    api.get<Endpoint[]>("/endpoints").then((e) => (endpoints = e)).catch((e) => (error = e.message));
  });

  async function create() {
    try {
      const e = await api.post<Endpoint>("/endpoints", { name: "New endpoint" });
      go(`endpoints/${e.id}/pick`);
    } catch (e) {
      say((e as Error).message, true);
    }
  }
</script>

<section class="card glass hero">
  <div class="hero-top">
    <div>
      <div class="eyebrow">Steps 3–6 · What to serve</div>
      <h1 class="display">Endpoints</h1>
    </div>
    <button class="btn primary" type="button" onclick={create}>+ New endpoint</button>
  </div>
  <p class="sub">An endpoint picks fields from one or more sources, transforms them, and serves the result as JSON on the public port.</p>
</section>

<section class="card glass">
  {#if error}
    <p class="note bad">{error}</p>
  {:else if !endpoints}
    <div class="empty-state"><span class="spin"></span></div>
  {:else if !endpoints.length}
    <div class="empty-state">
      <h2>No endpoints yet</h2>
      <p>Once a source has pulled some data, build an endpoint from it.</p>
      <button class="btn primary" type="button" onclick={create}>+ New endpoint</button>
    </div>
  {:else}
    <div class="list-cards">
      {#each endpoints as e (e.id)}
        <a class="lcard" href="#/endpoints/{e.id}/{e.definition.fields.length ? 'shape' : 'pick'}">
          <div class="between">
            <span class="title">{e.name}</span>
            {#if e.enabled}<span class="pill ok"><span class="dot"></span>Live</span>{:else}<span class="pill">Off</span>{/if}
          </div>
          <span class="url">GET {meta.publicBaseUrl}/v1/{e.slug}</span>
          <div class="meta">
            <span>{e.definition.fields.length} field{e.definition.fields.length === 1 ? "" : "s"}</span>
            <span>{e.access === "public" ? "Public" : `${e.keys} key${e.keys === 1 ? "" : "s"}`}</span>
            <span>{n(e.calls24h)} calls in 24h</span>
          </div>
        </a>
      {/each}
    </div>
  {/if}
</section>
