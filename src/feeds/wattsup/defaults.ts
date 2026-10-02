// What the Watts Up feed polls, as seeded on first boot. Every field here can be changed in the
// admin UI afterwards (Feeds → Watts Up), and "Reset" puts a source back to these values.
//
// URLs take the usual date placeholders ({now-90m}, {today}, {today-1d:date}…; see
// engine/placeholders), filled in Relay's TZ on every poll.

export const FEED = "watts-up";

export type SourceKey =
  | "fuelinst"
  | "demandOutturn"
  | "demandForecast"
  | "indgen"
  | "carbon"
  | "carbonMix"
  | "wholesale"
  | "dfs"
  | "agile"
  | "solar";

export interface SourceDefault {
  key: SourceKey;
  name: string;
  /** What this source fills in, for the admin UI. */
  about: string;
  url: string;
  /** Called instead of `url` on the first poll after a start, or after a long gap, to catch up. */
  backfillUrl?: string;
  intervalMin: number;
  timeoutMs: number;
  authType: "none" | "bearer";
  enabled: boolean;
}

const ELEXON = "https://data.elexon.co.uk/bmrs/api/v1";
const NESO = "https://api.neso.energy/api/3/action/datastore_search";

export const SOURCE_DEFAULTS: SourceDefault[] = [
  {
    key: "fuelinst",
    name: "Generation and interconnectors",
    about: "Elexon FUELINST: five-minute output per fuel and interconnector, averaged into each half-hour.",
    // publishDateTime is an exact window. Plain from/to snaps to whole settlement days, which is
    // what the catch-up wants.
    url: `${ELEXON}/datasets/FUELINST?publishDateTimeFrom={now-90m}&publishDateTimeTo={now}&format=json`,
    backfillUrl: `${ELEXON}/datasets/FUELINST?publishDateTimeFrom={today-90m}&publishDateTimeTo={now}&format=json`,
    intervalMin: 5,
    timeoutMs: 30_000,
    authType: "none",
    enabled: true,
  },
  {
    key: "demandOutturn",
    name: "Settled demand",
    about: "Elexon initial demand outturn: national and transmission demand for yesterday and today.",
    url: `${ELEXON}/demand/outturn?settlementDateFrom={today-1d:date}&settlementDateTo={tomorrow:date}&format=json`,
    intervalMin: 5,
    timeoutMs: 20_000,
    authType: "none",
    enabled: true,
  },
  {
    key: "demandForecast",
    name: "Demand forecast",
    about: "Elexon day-ahead demand forecast (boundary N), newest publish per half-hour.",
    url: `${ELEXON}/forecast/demand/day-ahead?format=json`,
    intervalMin: 15,
    timeoutMs: 20_000,
    authType: "none",
    enabled: true,
  },
  {
    key: "indgen",
    name: "Indicated generation",
    about: "Elexon INDGEN (boundary N), newest publish per half-hour.",
    url: `${ELEXON}/datasets/INDGEN?boundary=N&format=json`,
    intervalMin: 5,
    timeoutMs: 20_000,
    authType: "none",
    enabled: true,
  },
  {
    key: "carbon",
    name: "Carbon intensity",
    about: "National Grid ESO carbon intensity, actual and forecast, from the start of today for 48 hours.",
    url: "https://api.carbonintensity.org.uk/intensity/{today}/fw48h",
    intervalMin: 30,
    timeoutMs: 20_000,
    authType: "none",
    enabled: true,
  },
  {
    key: "carbonMix",
    name: "Current generation mix",
    about: "National Grid ESO's current half-hour generation mix, as percentages.",
    url: "https://api.carbonintensity.org.uk/generation",
    intervalMin: 15,
    timeoutMs: 20_000,
    authType: "none",
    enabled: true,
  },
  {
    key: "wholesale",
    name: "Wholesale price",
    about: "N2EX GB day-ahead hourly price (GBP/MWh), copied into both half-hours.",
    url: `${NESO}?resource_id=4f27eea5-7038-4f73-9740-e3e4ad47c26a&limit=100&sort=%22Date%22%20desc`,
    intervalMin: 15,
    timeoutMs: 20_000,
    authType: "none",
    enabled: true,
  },
  {
    key: "dfs",
    name: "DFS events",
    about: "NESO Demand Flexibility Service requirements. Only Live ones are kept.",
    url: `${NESO}?resource_id=3635fd80-49d7-4d02-964d-cc8c08d50302&limit=200&sort=%22Delivery%20Date%22%20desc`,
    intervalMin: 30,
    timeoutMs: 20_000,
    authType: "none",
    enabled: true,
  },
  {
    key: "agile",
    name: "Octopus Agile (region H)",
    about: "Octopus Agile import unit rates for region H (Southern), p/kWh, today and tomorrow. Tomorrow's arrive around 16:00. If Octopus launches a new Agile product, put its code in the URL.",
    url: "https://api.octopus.energy/v1/products/AGILE-24-10-01/electricity-tariffs/E-1R-AGILE-24-10-01-H/standard-unit-rates/?period_from={today}&period_to={tomorrow+1d}&page_size=200",
    intervalMin: 15,
    timeoutMs: 20_000,
    authType: "none",
    enabled: true,
  },
  {
    key: "solar",
    name: "Home solar",
    about: "A Home Assistant PV power sensor: live watts, its average per half-hour over the last 24 hours (time-weighted), and kWh per day for the last 7 days from its statistics.",
    // Replaced on first boot by an existing Home Assistant source's sensor URL and token, if there is one.
    url: "https://homeassistant.example.com/api/states/sensor.pv_power",
    intervalMin: 5,
    timeoutMs: 20_000,
    authType: "bearer",
    enabled: false,
  },
];

export interface FeedSettings {
  enabled: boolean;
  slug: string;
  corsOrigins: string[];
  maxAge: number;
  staleWhileRevalidate: number;
  rateLimitPerMin: number;
  /** Half-hour rows and raw readings older than this are pruned. */
  retainDays: number;
  /** DFS events that ended up to this many days ago are still listed. */
  dfsHistoryDays: number;
}

export const SETTINGS_DEFAULTS: FeedSettings = {
  enabled: true,
  slug: "watts-up",
  corsOrigins: ["https://themisto.app", "https://missioncontrol.themisto.app"],
  maxAge: 30,
  staleWhileRevalidate: 300,
  rateLimitPerMin: 120,
  retainDays: 7,
  dfsHistoryDays: 7,
};
