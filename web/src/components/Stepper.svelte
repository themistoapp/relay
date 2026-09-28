<script lang="ts">
  let { steps, active, base }: { steps: { id: string; label: string; hint: string; n?: number | string }[]; active: string; base: string } = $props();
</script>

<div class="stepper-wrap">
  <nav class="stepper" aria-label="Steps">
    {#each steps as s, i (s.id)}
      <a class="step" class:active={s.id === active} href="#/{base}/{s.id}" aria-current={s.id === active ? "step" : undefined}>
        <span class="n">{s.n ?? i + 1}</span>
        <span class="t"><b>{s.label}</b><small>{s.hint}</small></span>
      </a>
    {/each}
  </nav>
</div>
