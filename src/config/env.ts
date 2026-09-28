import { z } from "zod";
import { timeZoneProblem } from "../engine/ops.js";

const optionalUrl = z
  .string()
  .optional()
  .default("")
  .refine((v) => v === "" || /^https?:\/\//.test(v), "must be an http(s) URL if set");

const envSchema = z.object({
  // One admin login for the GUI on ADMIN_PORT.
  ADMIN_PASSWORD: z.string().min(8, "ADMIN_PASSWORD must be at least 8 characters"),
  // Encrypts upstream API tokens at rest and signs the admin session cookie. Back it up: without it,
  // stored tokens can't be decrypted and have to be re-entered.
  APP_SECRET: z.string().min(16, "APP_SECRET must be at least 16 characters (try: openssl rand -base64 32)"),
  DATA_DIR: z.string().min(1).default("./data"),
  HOST: z.string().min(1).default("0.0.0.0"),
  // The admin UI and its API. Keep this LAN-only or behind Cloudflare Access.
  ADMIN_PORT: z.coerce.number().int().positive().default(8080),
  // Only the re-served endpoints (/v1/:slug) and /healthz. This is the port to point a reverse proxy at.
  PUBLIC_PORT: z.coerce.number().int().positive().default(8081),
  // How endpoints are reached from outside, for the URLs shown in the UI.
  // Empty (the default) means: the address you opened the admin UI on, with PUBLIC_HOST_PORT.
  PUBLIC_BASE_URL: z.string().default("").refine((v) => v === "" || /^https?:\/\/[^\s]+$/.test(v), "must be an http(s) URL if set"),
  // The host port Docker maps to PUBLIC_PORT. Only used to guess PUBLIC_BASE_URL when it isn't set.
  PUBLIC_HOST_PORT: z.coerce.number().int().positive().optional(),
  // A full zone name like Europe/London (handles GMT/BST by itself). Abbreviations are refused.
  TZ: z.string().min(1).default("Europe/London").superRefine((tz, ctx) => {
    const problem = timeZoneProblem(tz);
    if (problem) ctx.addIssue({ code: "custom", message: problem });
  }),
  // Which proxies may set X-Forwarded-For (proxy-addr syntax). The default trusts private networks,
  // i.e. Nginx Proxy Manager on the same host or LAN, so rate limits and logs see real client IPs.
  TRUST_PROXY: z.string().default("loopback,linklocal,uniquelocal"),
  // Behind Cloudflare, set to cf-connecting-ip: X-Forwarded-For would otherwise end at a Cloudflare
  // edge IP. Only read from requests that came through a trusted proxy.
  CLIENT_IP_HEADER: z.string().default("").transform((v) => v.toLowerCase()),
  ALERT_WEBHOOK_URL: optionalUrl,
  ALERT_AFTER_FAILURES: z.coerce.number().int().positive().default(3),
  BACKUP_KEEP: z.coerce.number().int().min(0).default(7),
  REQUEST_LOG_KEEP: z.coerce.number().int().positive().default(20000),
  MAX_RESPONSE_MB: z.coerce.number().positive().default(10),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}
