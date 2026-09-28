<script lang="ts">
  import { onMount } from "svelte";
  import { api } from "../../lib/api";
  import { meta, say } from "../../lib/state.svelte";
  import { ago, time } from "../../lib/format";
  import type { ApiKey, Endpoint, Preview } from "../../lib/types";
  import DeleteEndpoint from "./DeleteEndpoint.svelte";

  let { draft = $bindable(), dirty, save, preview }: { draft: Endpoint; dirty: boolean; save: () => Promise<void>; preview: Preview | null } = $props();

  let keys = $state<ApiKey[]>([]);
  let log = $state<{ id: number; caller: string | null; ip: string; status: number; ms: number; at: number }[]>([]);
  let newLabel = $state("");
  let revealed = $state<{ label: string; key: string } | null>(null);
  let origin = $state("");
  let originError = $state("");

  const url = $derived(`${meta.publicBaseUrl}/v1/${draft.slug}`);
  const curl = $derived(`curl ${url}` + (draft.access === "key" ? ` \\\n  -H "X-Api-Key: ${revealed?.key ?? "<your key>"}"` : ""));

  async function loadKeys() {
    keys = await api.get<ApiKey[]>(`/endpoints/${draft.id}/keys`);
  }
  async function loadLog() {
    log = await api.get(`/endpoints/${draft.id}/log?limit=25`);
  }
  onMount(() => {
    loadKeys();
    loadLog();
    const t = setInterval(loadLog, 15_000);
    return () => clearInterval(t);
  });

  async function createKey(e: SubmitEvent) {
    e.preventDefault();
    try {
      const r = await api.post<{ key: string; apiKey: ApiKey }>(`/endpoints/${draft.id}/keys`, { label: newLabel });
      revealed = { label: r.apiKey.label, key: r.key };
      newLabel = "";
      loadKeys();
    } catch (err) {
      say((err as Error).message, true);
    }
  }

  let revoking = $state<number | null>(null);
  async function revoke(id: number) {
    if (revoking !== id) {
      revoking = id;
      return;
    }
    await api.del(`/keys/${id}`);
    revoking = null;
    say("Key revoked");
    loadKeys();
  }

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

  async function copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      say(`${what} copied`);
    } catch {
      say("Couldn't copy. Select the text instead.", true);
    }
  }

  function setSlug(v: string) {
    draft.slug = v.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-{2,}/g, "-");
  }
</script>

<section class="card glass">
  <div class="panel-head">
    <div>
      <h2>Publish it</h2>
      <p class="sub">Endpoints are served on the public port, apart from this admin UI. Point Nginx Proxy Manager at that port to put them on a public address.</p>
    </div>
    <label class="check live">
      <input type="checkbox" bind:checked={draft.enabled} />
      {draft.enabled ? "Live" : "Off"}
    </label>
  </div>

  <div class="stack">
    <div class="url-hero">
      <span class="method">GET</span>
      <code>{url}</code>
      <button class="btn sm" type="button" onclick={() => copy(url, "URL")}>Copy</button>
    </div>
    {#if !meta.publicBaseUrlSet}<p class="hint">This is your server's own address. Once endpoints have a public address (e.g. through Nginx Proxy Manager), set <span class="mono">PUBLIC_BASE_URL</span> so this shows it instead.</p>{/if}
    {#if dirty}<p class="note warn">You have unsaved changes. They won't be served until you save. <button class="btn sm primary" type="button" onclick={save}>Save now</button></p>{/if}
    {#if preview?.errors.length}<p class="note bad">{preview.errors.length} field{preview.errors.length === 1 ? " has" : "s have"} a problem and will be served as null. See the Shape step.</p>{/if}

    <div class="form">
      <div class="fld s6">
        <label for="ep-name">Name</label>
        <input class="input" id="ep-name" bind:value={draft.name} />
      </div>
      <div class="fld s6">
        <label for="ep-slug">Address</label>
        <div class="joined">
          <span class="input mono muted">/v1/</span>
          <input class="input mono" id="ep-slug" value={draft.slug} oninput={(e) => setSlug(e.currentTarget.value)} />
        </div>
      </div>
      <div class="fld">
        <span class="lbl">Who can call it</span>
        <div class="row">
          <div class="seg">
            <button type="button" class:on={draft.access === "key"} onclick={() => (draft.access = "key")}>Only with an API key</button>
            <button type="button" class:on={draft.access === "public"} onclick={() => (draft.access = "public")}>Anyone with the URL</button>
          </div>
        </div>
        <span class="hint">{draft.access === "key" ? "Callers send a key in the X-Api-Key header, or as ?key= in the URL." : "No key needed. Check the source's terms allow republishing its data before making it public."}</span>
      </div>

      {#if draft.access === "key"}
        <div class="fld">
          <span class="lbl">API keys</span>
          {#if revealed}
            <div class="note">
              <div class="stack tight" style="min-width: 0; flex: 1">
                <span><b>New key for {revealed.label}.</b> Copy it now. It won't be shown again.</span>
                <code class="chipcode">{revealed.key}</code>
              </div>
              <button class="btn sm" type="button" onclick={() => copy(revealed!.key, "Key")}>Copy</button>
            </div>
          {/if}
          <div class="tbl-wrap">
            <table>
              <thead><tr><th>Label</th><th>Key</th><th>Last used</th><th>Calls</th><th></th></tr></thead>
              <tbody>
                {#each keys as k (k.id)}
                  <tr class:revoked={!!k.revokedAt}>
                    <td>{k.label}</td>
                    <td class="mono">rly_…{k.hint}</td>
                    <td>{k.revokedAt ? `revoked ${ago(k.revokedAt)}` : ago(k.lastUsedAt)}</td>
                    <td>{k.useCount.toLocaleString("en-GB")}</td>
                    <td>{#if !k.revokedAt}<button class="btn sm danger ghost" type="button" onclick={() => revoke(k.id)}>{revoking === k.id ? "Click again" : "Revoke"}</button>{/if}</td>
                  </tr>
                {:else}
                  <tr><td colspan="5" class="muted">No keys yet. Nothing can call this endpoint until you add one.</td></tr>
                {/each}
              </tbody>
            </table>
          </div>
          <form class="row" onsubmit={createKey}>
            <input class="input" style="max-width: 260px" bind:value={newLabel} placeholder="Label, e.g. Home Assistant" aria-label="New key label" />
            <button class="btn" type="submit" disabled={!newLabel.trim()}>+ New key</button>
          </form>
        </div>
      {/if}

      <div class="fld">
        <span class="lbl">Browsers allowed to call it (CORS)</span>
        <div class="chips">
          {#each draft.corsOrigins as o, i}
            <span class="chip">{o}<button class="x" type="button" aria-label="Remove {o}" onclick={() => draft.corsOrigins.splice(i, 1)}>×</button></span>
          {/each}
          <input class="input sm" style="width: 240px" bind:value={origin} placeholder="https://tailwind.themisto.app" aria-label="Add an origin" onkeydown={(e) => e.key === "Enter" && (e.preventDefault(), addOrigin())} />
          <button class="btn sm" type="button" onclick={addOrigin} disabled={!origin.trim()}>Add</button>
        </div>
        {#if originError}<span class="err">{originError}</span>{/if}
        <span class="hint">Only matters for web pages calling from a browser. Servers and apps like Home Assistant ignore it. Use * for any site.</span>
      </div>

      <div class="fld s4">
        <label for="ep-rate">Rate limit</label>
        <div class="joined">
          <input class="input num" id="ep-rate" type="number" min="1" style="width: 100px" bind:value={draft.rateLimit} />
          <select class="input" bind:value={draft.rateWindow} aria-label="Per">
            <option value="minute">calls a minute</option>
            <option value="hour">calls an hour</option>
          </select>
        </div>
      </div>
      <div class="fld s4">
        <label for="ep-rateby">Counted per</label>
        <select class="input" id="ep-rateby" bind:value={draft.rateBy}>
          <option value="key">API key</option>
          <option value="ip">IP address</option>
        </select>
      </div>
      <div class="fld s4">
        <label for="ep-cache">Reuse a response for</label>
        <select class="input" id="ep-cache" bind:value={draft.cacheTtl}>
          <option value={0}>Don't cache</option>
          <option value={30}>30 seconds</option>
          <option value={60}>1 minute</option>
          <option value={300}>5 minutes</option>
          <option value={900}>15 minutes</option>
          <option value={3600}>1 hour</option>
        </select>
        <span class="hint">A new pull always refreshes it straight away.</span>
      </div>
    </div>

    <div class="fld">
      <div class="between"><span class="lbl">Try it</span><button class="btn sm" type="button" onclick={() => copy(curl, "Command")}>Copy</button></div>
      <pre class="pre">{curl}</pre>
    </div>

    <div class="fld">
      <div class="between"><span class="lbl">Recent calls</span><button class="btn sm ghost" type="button" onclick={loadLog}>Refresh</button></div>
      <div class="tbl-wrap">
        <table>
          <thead><tr><th>When</th><th>Caller</th><th>IP</th><th>Status</th><th>Took</th></tr></thead>
          <tbody>
            {#each log as l (l.id)}
              <tr>
                <td>{time(l.at, true)}</td>
                <td>{l.caller ?? (draft.access === "public" ? "public" : "no key")}</td>
                <td class="mono">{l.ip}</td>
                <td><span class="status {l.status < 400 ? 'ok' : 'bad'}">{l.status}</span></td>
                <td>{l.ms} ms</td>
              </tr>
            {:else}
              <tr><td colspan="5" class="muted">No calls yet.</td></tr>
            {/each}
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <div class="panel-foot">
    <a class="btn ghost" href="#/endpoints/{draft.id}/shape">← Shape</a>
    <div class="row">
      <DeleteEndpoint id={draft.id} />
      <button class="btn primary" type="button" onclick={save} disabled={!dirty}>{draft.enabled ? "Save and publish" : "Save"}</button>
    </div>
  </div>
</section>

<style>
  .live { font-weight: 600; padding: 8px 14px; border-radius: 999px; background: var(--field); border: 1px solid var(--line); }
  .url-hero { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; padding: 14px 16px; border-radius: 18px; background: var(--field); border: 1px solid var(--line); }
  .method { font-family: var(--font-mono); font-size: .72rem; font-weight: 700; padding: 3px 8px; border-radius: 7px; background: var(--ok-soft); color: var(--ok); }
  .url-hero code { font-family: var(--font-mono); font-size: .9rem; flex: 1; min-width: 0; overflow-wrap: anywhere; }
  tr.revoked td { opacity: .5; }
  .note { align-items: center; }
</style>
