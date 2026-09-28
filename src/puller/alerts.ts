import type { FastifyBaseLogger } from "fastify";

export interface Alert {
  title: string;
  message: string;
  source: string;
  status: "failing" | "recovered";
}

// Header values must be ASCII; ntfy decodes RFC 2047 encoded words for anything else.
const headerSafe = (v: string) => (/^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v).toString("base64")}?=`);

// ntfy topics show a JSON body as raw text, so ntfy gets a plain message with a Title header.
// Everything else (Home Assistant webhooks, Discord-style bridges, etc.) gets JSON.
export async function sendAlert(url: string, alert: Alert, log: FastifyBaseLogger): Promise<void> {
  try {
    const ntfy = /(^|\.)ntfy\./.test(new URL(url).hostname);
    const res = await fetch(url, {
      method: "POST",
      headers: ntfy ? { "content-type": "text/plain", title: headerSafe(alert.title), tags: alert.status === "failing" ? "warning" : "white_check_mark" } : { "content-type": "application/json" },
      body: ntfy ? alert.message : JSON.stringify(alert),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) log.warn({ status: res.status }, "alert webhook returned an error");
  } catch (e) {
    log.warn({ err: e }, "couldn't send alert webhook");
  }
}
