<script lang="ts">
  import { onMount } from "svelte";
  import { api } from "../lib/api";
  import { meta, say } from "../lib/state.svelte";
  import { ago } from "../lib/format";
  import type { Endpoint, Preview, ShapeNode, Source } from "../lib/types";
  import Stepper from "../components/Stepper.svelte";
  import PickStep from "./endpoint/PickStep.svelte";
  import TransformStep from "./endpoint/TransformStep.svelte";
  import ShapeStep from "./endpoint/ShapeStep.svelte";
  import PublishStep from "./endpoint/PublishStep.svelte";

  let { id, step }: { id: number; step: string } = $props();

  let draft = $state<Endpoint | null>(null);
  let savedJson = $state("");
  let sources = $state<Source[]>([]);
  let shapes = $state<Record<number, ShapeNode | null>>({});
  let preview = $state<Preview | null>(null);
  let previewError = $state("");
  let saving = $state(false);
  let loadError = $state("");

  const editable = (e: Endpoint) => JSON.stringify({ slug: e.slug, name: e.name, definition: e.definition, enabled: e.enabled, access: e.access, corsOrigins: e.corsOrigins, rateLimit: e.rateLimit, rateWindow: e.rateWindow, rateBy: e.rateBy, cacheTtl: e.cacheTtl });
  const dirty = $derived(!!draft && editable(draft) !== savedJson);

  // Unsaved edits are kept in this browser, so a page reload doesn't lose them. They're only
  // restored onto the same saved version they were made against.
  const draftKey = $derived(`relay-draft-${id}`);
  let restored = $state(false);
  function readStoredDraft(version: number): Partial<Endpoint> | null {
    try {
      const raw = localStorage.getItem(draftKey);
      if (!raw) return null;
      const d = JSON.parse(raw);
      if (d.version === version) return d.draft;
      localStorage.removeItem(draftKey);
    } catch {
      /* storage unavailable: nothing to restore */
    }
    return null;
  }
  $effect(() => {
    if (!draft) return;
    const json = editable(draft);
    try {
      if (json !== savedJson) localStorage.setItem(draftKey, JSON.stringify({ version: draft.version, draft: JSON.parse(json) }));
      else localStorage.removeItem(draftKey);
    } catch {
      /* storage unavailable or full */
    }
  });

  async function discard() {
    try {
      localStorage.removeItem(draftKey);
    } catch {
      /* ignore */
    }
    const e = await api.get<Endpoint>(`/endpoints/${id}`);
    draft = e;
    savedJson = editable(e);
    restored = false;
    say("Changes discarded");
  }

  export async function loadShape(sourceId: number) {
    if (sourceId in shapes) return;
    shapes[sourceId] = null;
    const r = await api.get<{ shape: ShapeNode | null }>(`/sources/${sourceId}/latest`).catch(() => ({ shape: null }));
    shapes[sourceId] = r.shape;
  }

  async function load() {
    try {
      const [e, s] = await Promise.all([api.get<Endpoint>(`/endpoints/${id}`), api.get<Source[]>("/sources")]);
      savedJson = editable(e);
      const stored = readStoredDraft(e.version);
      draft = stored ? { ...e, ...stored } : e;
      restored = !!stored && editable(draft) !== savedJson;
      if (restored) say("Restored your unsaved changes");
      sources = s;
      for (const sid of new Set(draft.definition.fields.map((f) => f.sourceId))) loadShape(sid);
    } catch (err) {
      loadError = (err as Error).message;
    }
  }

  onMount(() => {
    load();
  });

  // Live preview of the unsaved definition, debounced.
  let timer: ReturnType<typeof setTimeout>;
  $effect(() => {
    if (!draft) return;
    const def = JSON.stringify(draft.definition);
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        preview = await api.post<Preview>("/preview", { definition: JSON.parse(def) });
        previewError = "";
      } catch (e) {
        previewError = (e as Error).message;
      }
    }, 250);
  });

  async function save() {
    if (!draft) return;
    saving = true;
    try {
      const { id: _i, version: _v, updatedAt: _u, calls24h: _c, keys: _k, ...body } = draft;
      const e = await api.put<Endpoint>(`/endpoints/${id}`, body);
      draft = { ...draft, ...e };
      savedJson = editable(draft);
      restored = false;
      say(draft.enabled ? "Saved. Live now." : "Saved");
    } catch (e) {
      say((e as Error).message, true);
    } finally {
      saving = false;
    }
  }

  const steps = $derived([
    { id: "pick", label: "Pick", hint: "Tick what you need", n: 3 },
    { id: "transform", label: "Transform", hint: "Maths & summaries", n: 4 },
    { id: "shape", label: "Shape", hint: "Build the output", n: 5 },
    { id: "publish", label: "Publish", hint: "URL, keys, limits", n: 6 },
  ]);
  const usedSources = $derived(draft ? sources.filter((s) => draft!.definition.fields.some((f) => f.sourceId === s.id)) : []);
</script>

<section class="card glass hero">
  <div class="hero-top">
    <div>
      <div class="eyebrow"><a href="#/endpoints">Endpoints</a> / Endpoint</div>
      <h1 class="display">{draft?.name ?? "…"}</h1>
    </div>
    {#if draft}
      <div class="row">
        {#if draft.enabled}<span class="pill ok"><span class="dot"></span>Live</span>{:else}<span class="pill">Off</span>{/if}
        {#if dirty}
          <span class="pill warn">{restored ? "Restored unsaved changes" : "Unsaved changes"}</span>
          <button class="btn ghost" type="button" onclick={discard}>Discard</button>
        {/if}
        <button class="btn primary" type="button" onclick={save} disabled={!dirty || saving}>{#if saving}<span class="spin"></span>{/if} Save</button>
      </div>
    {/if}
  </div>
  {#if draft}
    <div class="flow">
      {#each usedSources as s}<code>{s.name}</code>{/each}
      {#if usedSources.length}<span class="muted">→</span>{/if}
      <span>{draft.definition.fields.length} field{draft.definition.fields.length === 1 ? "" : "s"} · {draft.definition.fields.reduce((n, f) => n + f.ops.length, 0)} steps</span>
      <span class="muted">→</span>
      <code>{meta.publicBaseUrl}/v1/{draft.slug}</code>
      {#if preview?.fetchedAt}<span class="muted small">data from {ago(preview.fetchedAt)}</span>{/if}
    </div>
  {/if}
  <Stepper {steps} active={step} base="endpoints/{id}" />
</section>

{#if loadError}
  <section class="card glass"><p class="note bad">{loadError}</p></section>
{:else if !draft}
  <section class="card glass empty-state"><span class="spin"></span></section>
{:else if step === "transform"}
  <TransformStep bind:draft={draft} {preview} {shapes} {sources} />
{:else if step === "shape"}
  <ShapeStep bind:draft={draft} {preview} {previewError} {sources} />
{:else if step === "publish"}
  <PublishStep bind:draft={draft} {dirty} {save} {preview} />
{:else}
  <PickStep bind:draft={draft} {sources} {shapes} {loadShape} />
{/if}

<style>
  .eyebrow a { color: inherit; text-decoration: none; }
  .eyebrow a:hover { text-decoration: underline; }
</style>
