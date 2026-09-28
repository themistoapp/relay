export function ago(ms: number | null | undefined, now = Date.now()): string {
  if (!ms) return "never";
  const s = Math.round((now - ms) / 1000);
  if (s < 0) return inFuture(ms, now);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export function inFuture(ms: number | null | undefined, now = Date.now()): string {
  if (!ms) return "—";
  const s = Math.round((ms - now) / 1000);
  if (s < 60) return "in under a minute";
  if (s < 3600) return `in ${Math.round(s / 60)} min`;
  if (s < 86400) return `in ${Math.round(s / 3600)} h`;
  return `in ${Math.round(s / 86400)} d`;
}

export function bytes(n: number | null | undefined): string {
  if (!n) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

export function time(ms: number, withDate = false): string {
  const d = new Date(ms);
  const t = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  if (!withDate) return t;
  const today = new Date();
  const same = d.toDateString() === today.toDateString();
  return same ? `today ${t}` : `${d.toLocaleDateString("en-GB", { day: "numeric", month: "short" })} ${t}`;
}

export const n = (x: number | null | undefined) => (x ?? 0).toLocaleString("en-GB");

export const SCHEDULES = [
  { label: "1 min", cron: "* * * * *" },
  { label: "5 min", cron: "*/5 * * * *" },
  { label: "15 min", cron: "*/15 * * * *" },
  { label: "30 min", cron: "*/30 * * * *" },
  { label: "Hourly", cron: "0 * * * *" },
  { label: "Daily", cron: "0 6 * * *" },
];

export function scheduleLabel(cron: string): string {
  const p = SCHEDULES.find((s) => s.cron === cron);
  if (!p) return cron;
  if (p.label === "Hourly") return "Every hour";
  if (p.label === "Daily") return "Daily at 06:00";
  return `Every ${p.label}`;
}

/** Roughly how many pulls a day a cron expression makes (for storage estimates). */
export function pullsPerDay(cron: string): number | null {
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5) return null;
  const [m, h] = f;
  const per = (field: string, range: number) => {
    if (field === "*") return range;
    const step = /^\*\/(\d+)$/.exec(field);
    if (step) return Math.ceil(range / Number(step[1]));
    if (/^[\d,]+$/.test(field)) return field.split(",").length;
    return null;
  };
  const a = per(m, 60);
  const b = per(h, 24);
  return a && b ? a * b : null;
}

export function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}
