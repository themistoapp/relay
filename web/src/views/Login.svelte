<script lang="ts">
  import { api } from "../lib/api";
  import { auth } from "../lib/state.svelte";

  let password = $state("");
  let error = $state("");
  let busy = $state(false);

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    busy = true;
    error = "";
    try {
      await api.post("/login", { password });
      auth.signedIn = true;
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
    }
  }
</script>

<section class="card glass login">
  <div class="eyebrow">Self-hosted API relay</div>
  <h1 class="display">Relay</h1>
  <p class="sub">Pull APIs on a schedule, keep only the data you need, and serve it back out as your own clean API.</p>
  <form onsubmit={submit} class="stack tight">
    <label class="lbl" for="password">Admin password</label>
    <!-- svelte-ignore a11y_autofocus -->
    <input class="input" id="password" type="password" autocomplete="current-password" bind:value={password} autofocus />
    {#if error}<p class="err" role="alert">{error}</p>{/if}
    <button class="btn primary" type="submit" disabled={busy || !password}>{busy ? "Signing in…" : "Sign in"}</button>
  </form>
</section>

<style>
  .login { max-width: 460px; width: 100%; margin: 6vh auto 0; display: grid; gap: 14px; }
  form { margin-top: 10px; }
</style>
