<script lang="ts">
  import { onMount } from "svelte";
  import { api } from "./lib/api";
  import { auth, meta } from "./lib/state.svelte";
  import { route } from "./lib/router.svelte";
  import Backdrop from "./components/Backdrop.svelte";
  import Nav from "./components/Nav.svelte";
  import Toast from "./components/Toast.svelte";
  import Login from "./views/Login.svelte";
  import Sources from "./views/Sources.svelte";
  import SourceView from "./views/SourceView.svelte";
  import Endpoints from "./views/Endpoints.svelte";
  import EndpointView from "./views/EndpointView.svelte";
  import DataView from "./views/DataView.svelte";

  onMount(async () => {
    const s = await api.get<{ signedIn: boolean }>("/session").catch(() => ({ signedIn: false }));
    auth.signedIn = s.signedIn;
  });

  $effect(() => {
    if (auth.signedIn) api.get<typeof meta>("/meta").then((m) => Object.assign(meta, m)).catch(() => {});
  });

  const section = $derived(route.parts[0] ?? "sources");
</script>

<Backdrop />
<Nav signedIn={!!auth.signedIn} {section} />

<main class="page">
  {#if auth.signedIn === null}
    <div class="card glass empty-state"><span class="spin"></span></div>
  {:else if !auth.signedIn}
    <Login />
  {:else if section === "sources" && route.parts[1]}
    {#key route.parts[1]}<SourceView id={route.parts[1]} tab={route.parts[2] ?? "request"} />{/key}
  {:else if section === "endpoints" && route.parts[1]}
    {#key route.parts[1]}<EndpointView id={Number(route.parts[1])} step={route.parts[2] ?? "pick"} />{/key}
  {:else if section === "endpoints"}
    <Endpoints />
  {:else if section === "data"}
    <DataView />
  {:else}
    <Sources />
  {/if}
</main>

<Toast />
