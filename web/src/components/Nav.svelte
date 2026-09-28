<script lang="ts">
  import { api } from "../lib/api";
  import { auth } from "../lib/state.svelte";

  let { signedIn, section }: { signedIn: boolean; section: string } = $props();

  function toggleTheme() {
    (window as unknown as { __toggleTheme?: () => void }).__toggleTheme?.();
  }

  async function logout() {
    await api.post("/logout").catch(() => {});
    auth.signedIn = false;
  }
</script>

<nav class="nav" aria-label="Main">
  <a class="nav-brand" href="#/sources">
    <img src="/icon.svg" alt="" />
    <span>Relay</span>
  </a>
  {#if signedIn}
    <a class="nav-link" class:active={section === "sources"} href="#/sources">Sources</a>
    <a class="nav-link" class:active={section === "endpoints"} href="#/endpoints">Endpoints</a>
    <a class="nav-link" class:active={section === "data"} href="#/data">Data</a>
  {/if}
  <button class="theme-btn" type="button" aria-label="Toggle light and dark theme" onclick={toggleTheme}>
    <svg class="i-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" /></svg>
    <svg class="i-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></svg>
  </button>
  {#if signedIn}
    <button class="theme-btn" type="button" aria-label="Sign out" title="Sign out" onclick={logout}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="m16 17 5-5-5-5" /><path d="M21 12H9" /></svg>
    </button>
  {/if}
</nav>
