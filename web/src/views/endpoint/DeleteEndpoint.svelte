<script lang="ts">
  import { api } from "../../lib/api";
  import { go } from "../../lib/router.svelte";
  import { say } from "../../lib/state.svelte";

  let { id }: { id: number } = $props();
  let armed = $state(false);

  async function del() {
    if (!armed) {
      armed = true;
      return;
    }
    await api.del(`/endpoints/${id}`);
    say("Endpoint deleted");
    go("endpoints");
  }
</script>

<button class="btn danger ghost" type="button" onclick={del}>{armed ? "Click again to delete" : "Delete endpoint"}</button>
