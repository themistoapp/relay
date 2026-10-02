<script lang="ts">
  import { api } from "../../lib/api";
  import JsonView from "../../components/JsonView.svelte";

  let { builtAt }: { builtAt: number | null } = $props();

  type Slot = {
    start: string;
    localTime: string;
    settlementPeriod: number;
    actual: {
      sampleCount: number;
      complete: boolean;
      generation: { totalMw: number | null };
      interconnectors: { importsMw: number | null; exportsMw: number | null };
      demand: { nationalMw: number | null; transmissionMw: number | null; stationLoadMw: number | null; pumpedStorageMw: number | null };
      supplyMw: number | null;
    };
    forecast: { demandMw: number | null; indicatedGenerationMw: number | null };
    carbon: { actualGPerKwh: number | null; forecastGPerKwh: number | null };
    wholesale: { gbpPerMwh: number | null };
    agile: { pPerKwhIncVat: number | null };
    homeSolar: { avgW: number | null; samples: number };
    dfsEventIds: string[];
  };
  type Response = { latestBalanceSlot: string | null; days: { date: string; slots: Slot[] }[]; [k: string]: unknown };

  let data = $state<Response | null>(null);
  let error = $state("");
  let day = $state(0);
  let showRaw = $state(false);

  // Reload whenever the parent sees a newer build.
  $effect(() => {
    void builtAt;
    api.get<Response>("/feeds/watts-up/response").then((r) => ((data = r), (error = ""))).catch((e) => (error = e.message));
  });

  const mw = (v: number | null | undefined) => (v === null || v === undefined ? "" : Math.round(v).toLocaleString("en-GB"));
  const d = $derived(data?.days[day]);
  const label = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
</script>

<section class="card glass">
  <div class="panel-head">
    <div>
      <h2>What's being served</h2>
      <p class="sub">Every half-hour of UK today and tomorrow. Blank cells haven't been published yet. Samples are five-minute generation readings out of 6.</p>
    </div>
    {#if data}
      <div class="seg" role="tablist">
        {#each data.days as dd, i}<button type="button" role="tab" aria-selected={day === i} class:on={day === i} onclick={() => (day = i)}>{i === 0 ? "Today" : "Tomorrow"} · {label(dd.date)}</button>{/each}
      </div>
    {/if}
  </div>

  {#if error}
    <p class="note bad">{error}</p>
  {:else if !d}
    <div class="empty-state"><span class="spin"></span></div>
  {:else}
    <div class="tbl-wrap slots">
      <table>
        <thead>
          <tr>
            <th>Time</th><th>SP</th><th>Samples</th><th>Generation</th><th>Imports</th><th>Exports</th><th>Demand</th><th>Transmission</th><th>Station</th><th>Pumping</th>
            <th>Fcst demand</th><th>INDGEN</th><th>gCO₂/kWh</th><th>£/MWh</th><th>Agile p</th><th>Home PV W</th><th>DFS</th>
          </tr>
        </thead>
        <tbody>
          {#each d.slots as s (s.start)}
            <tr class:latest={s.start === data?.latestBalanceSlot}>
              <td class="mono">{s.localTime}</td>
              <td class="muted">{s.settlementPeriod}</td>
              <td class:muted={!s.actual.complete}>{s.actual.sampleCount || ""}</td>
              <td>{mw(s.actual.generation.totalMw)}</td>
              <td>{mw(s.actual.interconnectors.importsMw)}</td>
              <td>{mw(s.actual.interconnectors.exportsMw)}</td>
              <td>{mw(s.actual.demand.nationalMw)}</td>
              <td>{mw(s.actual.demand.transmissionMw)}</td>
              <td>{mw(s.actual.demand.stationLoadMw)}</td>
              <td>{mw(s.actual.demand.pumpedStorageMw)}</td>
              <td>{mw(s.forecast.demandMw)}</td>
              <td>{mw(s.forecast.indicatedGenerationMw)}</td>
              <td title={s.carbon.actualGPerKwh === null && s.carbon.forecastGPerKwh !== null ? "Forecast" : "Actual"} class:muted={s.carbon.actualGPerKwh === null}>{s.carbon.actualGPerKwh ?? s.carbon.forecastGPerKwh ?? ""}</td>
              <td>{s.wholesale.gbpPerMwh ?? ""}</td>
              <td>{s.agile.pPerKwhIncVat ?? ""}</td>
              <td title="{s.homeSolar.samples} readings">{mw(s.homeSolar.avgW)}</td>
              <td>{s.dfsEventIds.length ? "●" : ""}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    <p class="hint">MW unless marked. Grey carbon figures are forecasts. The highlighted row is the latest half-hour with settled demand and generation.</p>
    <div class="row">
      <button class="btn sm ghost" type="button" onclick={() => (showRaw = !showRaw)} aria-expanded={showRaw}>{showRaw ? "Hide" : "Show"} the raw JSON</button>
    </div>
    {#if showRaw}<div class="box"><div class="scroll"><JsonView value={data} /></div></div>{/if}
  {/if}
</section>

<style>
  .slots { max-height: 620px; overflow: auto; }
  .slots th { position: sticky; top: 0; background: var(--glass-strong); z-index: 1; }
  .slots td, .slots th { padding: 6px 10px; text-align: right; }
  .slots td:first-child, .slots th:first-child { text-align: left; }
  tr.latest td { background: var(--accent-mid); }
</style>
