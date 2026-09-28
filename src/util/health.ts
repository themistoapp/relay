import { readFileSync } from "node:fs";
import type { Store } from "../db/store.js";

// Stamped by scripts/stamp-build.mjs at image build time, so /healthz can tell a fresh redeploy
// apart from a stale image.
let builtAt: string | null | undefined;
export function buildTime(): string | null {
  if (builtAt === undefined) {
    try {
      builtAt = readFileSync(new URL("../build-time.txt", import.meta.url), "utf8").trim();
    } catch {
      builtAt = null;
    }
  }
  return builtAt;
}

export function healthInfo(store: Store) {
  store.db.prepare("SELECT 1").get();
  return { ok: true, builtAt: buildTime(), uptimeSeconds: Math.round(process.uptime()) };
}
