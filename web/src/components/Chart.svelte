<script lang="ts">
  import { time } from "../lib/format";

  let { points, errors = [] }: { points: { t: number; v: number }[]; errors?: number[] } = $props();

  const W = 960, H = 250, L = 56, R = 16, T = 14, B = 28;

  const geo = $derived.by(() => {
    if (points.length === 0) return null;
    const ys = points.map((p) => p.v);
    let lo = Math.min(...ys), hi = Math.max(...ys);
    const pad = (hi - lo || Math.abs(hi) || 1) * 0.2;
    lo -= pad;
    hi += pad;
    const t0 = points[0].t, t1 = points[points.length - 1].t;
    const span = t1 - t0 || 1;
    const x = (t: number) => L + ((t - t0) / span) * (W - L - R);
    const y = (v: number) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
    const d = points.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join("");
    const area = `${d}L${x(t1).toFixed(1)},${H - B}L${x(t0).toFixed(1)},${H - B}Z`;
    const range = hi - lo;
    const dp = Math.max(0, Math.min(4, 2 - Math.floor(Math.log10(range))));
    const ticks = [0, 1, 2, 3].map((k) => lo + range * (k / 3)).map((v) => ({ y: y(v), label: v.toFixed(dp) }));
    const xt = points.length > 1 ? [0, 0.25, 0.5, 0.75, 1].map((f) => ({ x: L + f * (W - L - R), label: time(t0 + f * span), anchor: f === 0 ? "start" : f === 1 ? "end" : "middle" })) : [];
    const last = points[points.length - 1];
    return { d, area, ticks, xt, lastX: x(last.t), lastY: y(last.v), errX: errors.filter((e) => e >= t0 && e <= t1).map(x) };
  });
</script>

{#if geo}
  <svg viewBox="0 0 {W} {H}" role="img" aria-label="Value over time">
    <defs>
      <linearGradient id="relay-area" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="var(--accent)" stop-opacity=".22" />
        <stop offset="1" stop-color="var(--accent)" stop-opacity="0" />
      </linearGradient>
    </defs>
    {#each geo.ticks as t}
      <line x1={L} x2={W - R} y1={t.y} y2={t.y} stroke="var(--line)" />
      <text x={L - 8} y={t.y + 4} text-anchor="end" font-size="11" fill="var(--muted)" font-family="ui-monospace, monospace">{t.label}</text>
    {/each}
    {#each geo.xt as t}
      <text x={t.x} y={H - 8} text-anchor={t.anchor} font-size="11" fill="var(--muted)" font-family="ui-monospace, monospace">{t.label}</text>
    {/each}
    {#each geo.errX as ex}
      <line x1={ex} x2={ex} y1={T} y2={H - B} stroke="var(--bad)" stroke-dasharray="3 3" opacity=".7" />
    {/each}
    <path d={geo.area} fill="url(#relay-area)" />
    <path d={geo.d} fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" />
    <circle cx={geo.lastX} cy={geo.lastY} r="4.5" fill="var(--accent)" stroke="var(--glass-strong)" stroke-width="2" />
  </svg>
{:else}
  <p class="muted small" style="padding: 20px 8px">No numbers to plot in this time range.</p>
{/if}

<style>
  svg { display: block; width: 100%; height: auto; }
</style>
