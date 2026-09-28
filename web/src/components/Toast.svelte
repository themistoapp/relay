<script lang="ts">
  import { toast } from "../lib/state.svelte";
</script>

<div class="toast" class:show={toast.show} class:bad={toast.bad} role="status" aria-live="polite">{toast.text}</div>
