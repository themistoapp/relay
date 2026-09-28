import proxyaddr from "proxy-addr";
import type { FastifyRequest } from "fastify";

export function trustList(spec: string): string[] {
  return spec.split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * The caller's IP. Fastify's trustProxy already walks X-Forwarded-For through trusted proxies;
 * behind Cloudflare that chain ends at an edge IP, so CLIENT_IP_HEADER (cf-connecting-ip) is read
 * instead, but only when the request really came from a trusted proxy (so it can't be spoofed).
 */
export function makeClientIp(trustSpec: string, header: string) {
  const trust = proxyaddr.compile(trustList(trustSpec));
  return (req: FastifyRequest): string => {
    if (header) {
      const peer = req.socket.remoteAddress ?? "";
      const v = req.headers[header];
      if (peer && trust(peer, 0) && typeof v === "string" && v.trim()) return v.trim();
    }
    return req.ip;
  };
}

/** Fixed-window request counter, in memory (one container, so no shared store is needed). */
export class RateLimiter {
  private buckets = new Map<string, { start: number; count: number }>();

  hit(key: string, limit: number, windowMs: number, now = Date.now()): { allowed: boolean; remaining: number; resetAt: number } {
    let b = this.buckets.get(key);
    if (!b || now - b.start >= windowMs) {
      b = { start: now, count: 0 };
      this.buckets.set(key, b);
    }
    b.count++;
    if (this.buckets.size > 50_000) this.sweep(now, windowMs);
    return { allowed: b.count <= limit, remaining: Math.max(0, limit - b.count), resetAt: b.start + windowMs };
  }

  private sweep(now: number, windowMs: number) {
    for (const [k, b] of this.buckets) if (now - b.start >= windowMs) this.buckets.delete(k);
  }
}
