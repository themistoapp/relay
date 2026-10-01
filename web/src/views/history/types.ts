import type { HistoryDef } from "$engine/histories";

export interface SavedHistory {
  id: number;
  sourceId: number;
  name: string;
  definition: HistoryDef;
  keepDays: number | null;
  createdAt: number;
  updatedAt: number;
  points: number;
  oldest: number | null;
  newest: number | null;
  usedBy?: { id: number; name: string; slug: string }[];
  sourceName?: string;
}
