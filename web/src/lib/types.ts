import type { EndpointDefinition, FieldPreview, FieldError } from "$engine/render";
import type { ShapeNode } from "$engine/shape";

export type { EndpointDefinition, FieldPreview, FieldError, ShapeNode };

export interface Source {
  id: number;
  name: string;
  method: string;
  url: string;
  headers: { key: string; value: string }[];
  body: string | null;
  authType: "none" | "bearer" | "header" | "basic" | "query";
  authName: string;
  hasSecret: boolean;
  schedule: string;
  keepDays: number | null;
  keepCount: number | null;
  timeoutMs: number;
  enabled: boolean;
  failStreak: number;
  lastPulledAt: number | null;
  lastStatus: number | null;
  lastError: string | null;
  nextRun: number | null;
  counts: { total: number; errors: number; changed24h: number; okRate7d: number | null };
  usedBy?: { id: number; name: string; slug: string }[];
}

export interface Snapshot {
  id: number;
  sourceId: number;
  fetchedAt: number;
  status: number;
  ok: boolean;
  durationMs: number;
  bytes: number;
  bodyId: number | null;
  changed: boolean;
  error: string | null;
}

export interface Endpoint {
  id: number;
  slug: string;
  name: string;
  definition: EndpointDefinition;
  enabled: boolean;
  access: "public" | "key";
  corsOrigins: string[];
  rateLimit: number;
  rateWindow: "minute" | "hour";
  rateBy: "key" | "ip";
  cacheTtl: number;
  version: number;
  updatedAt: number;
  calls24h: number;
  keys: number;
}

export interface ApiKey {
  id: number;
  label: string;
  hint: string;
  createdAt: number;
  lastUsedAt: number | null;
  useCount: number;
  revokedAt: number | null;
}

export interface Preview {
  output: Record<string, unknown>;
  errors: FieldError[];
  fields: Record<string, FieldPreview>;
  fetchedAt: number | null;
  stale: boolean;
  missing: string[];
}
