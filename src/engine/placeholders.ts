// Date placeholders in a source's URL, header values and body, filled in on every pull, for APIs
// that want a date in the request, e.g. `https://api.carbonintensity.org.uk/intensity/{today}/fw48h`.
//
//   {now}        the time of the pull
//   {today}      midnight at the start of today, in TZ
//   {tomorrow}   midnight at the start of tomorrow, in TZ
//
// An offset moves any of them: {now-1h}, {now+30m}, {today-7d}. Days on {today}/{tomorrow} are
// calendar days, so they land on midnight even across a clock change. After a colon, the format:
//
//   (none)   2026-10-01T23:00:00Z   ISO 8601 in UTC
//   :date    2026-10-01             the date in TZ
//   :unix    1790895600             seconds
//   :ms      1790895600000          milliseconds
//
// Anything else in braces, like a JSON body's own, is left alone.

const PLACEHOLDER = /\{(now|today|tomorrow)(?:([+-])(\d{1,4})([mhd]))?(?::(date|unix|ms))?\}/g;

export const PLACEHOLDER_HELP = "{now}, {today}, {tomorrow}; offsets like {now-1h} or {today+2d}; formats :date, :unix, :ms";

/** The date (YYYY-MM-DD) at instant t in a time zone. */
export function dateIn(t: number, tz: string): string {
  return new Date(t).toLocaleDateString("en-CA", { timeZone: tz });
}

/** How far a time zone's clocks are ahead of UTC at instant t, in ms. */
function offsetAt(t: number, tz: string): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" })
      .formatToParts(new Date(t))
      .map((x) => [x.type, Number(x.value)]),
  );
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(t / 1000) * 1000;
}

/** The instant a date (YYYY-MM-DD) starts in a time zone. */
export function midnightIn(date: string, tz: string): number {
  return wallClockIn(date, "00:00:00", tz);
}

/** The instant a clock in a time zone shows this date (YYYY-MM-DD) and time (HH:MM:SS, fractions allowed). */
export function wallClockIn(date: string, time: string, tz: string): number {
  const guess = Date.parse(`${date}T${time}Z`);
  // Check the offset again at the first answer, in case a clock change falls between the two.
  return guess - offsetAt(guess - offsetAt(guess, tz), tz);
}

function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 };

export function fillPlaceholders(text: string, now: number, tz: string): string {
  return text.replace(PLACEHOLDER, (_all, base: string, sign?: string, amount?: string, unit?: "m" | "h" | "d", format?: string) => {
    const n = sign ? (sign === "-" ? -1 : 1) * Number(amount) : 0;
    let t: number;
    if (base === "now") t = now + n * UNIT_MS[unit ?? "m"];
    else {
      const day = addDays(dateIn(now, tz), base === "tomorrow" ? 1 : 0);
      t = unit === "d" ? midnightIn(addDays(day, n), tz) : midnightIn(day, tz) + n * UNIT_MS[unit ?? "m"];
    }
    if (format === "date") return dateIn(t, tz);
    if (format === "unix") return String(Math.floor(t / 1000));
    if (format === "ms") return String(t);
    return new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");
  });
}
