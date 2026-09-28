// Works out the shape of a JSON response: the keys, their types and a sample value. Items of a
// list are merged, so a key that only some items have still appears (marked optional).

export type ShapeType = "object" | "array" | "string" | "number" | "boolean" | "null" | "mixed";

export interface ShapeNode {
  type: ShapeType;
  /** Also seen as null in some items. */
  nullable?: boolean;
  /** Missing from some items of the list this node sits in. */
  optional?: boolean;
  children?: Record<string, ShapeNode>;
  item?: ShapeNode;
  /** Number of items, for arrays. */
  count?: number;
  sample?: unknown;
}

const MAX_ITEMS = 200;

function typeOf(v: unknown): ShapeType {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  const t = typeof v;
  return t === "string" || t === "number" || t === "boolean" || t === "object" ? t : "mixed";
}

export function inferShape(value: unknown): ShapeNode {
  const type = typeOf(value);
  if (type === "object") {
    const children: Record<string, ShapeNode> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) children[k] = inferShape(v);
    return { type, children };
  }
  if (type === "array") {
    const arr = value as unknown[];
    const items = arr.slice(0, MAX_ITEMS).map(inferShape);
    return { type, count: arr.length, item: items.length ? items.reduce(merge) : undefined };
  }
  return { type, sample: value };
}

// Merge two shapes of sibling list items. Keys missing from either side become optional.
function merge(a: ShapeNode, b: ShapeNode): ShapeNode {
  if (a.type === "null" && b.type !== "null") return { ...b, nullable: true };
  if (b.type === "null" && a.type !== "null") return { ...a, nullable: true };
  if (a.type !== b.type) return { type: "mixed", sample: a.sample ?? b.sample, nullable: a.nullable || b.nullable };
  if (a.type === "object") {
    const children: Record<string, ShapeNode> = {};
    const keys = new Set([...Object.keys(a.children ?? {}), ...Object.keys(b.children ?? {})]);
    for (const k of keys) {
      const x = a.children?.[k];
      const y = b.children?.[k];
      children[k] = x && y ? merge(x, y) : { ...(x ?? y)!, optional: true };
    }
    return { type: "object", children, nullable: a.nullable || b.nullable };
  }
  if (a.type === "array") {
    const item = a.item && b.item ? merge(a.item, b.item) : (a.item ?? b.item);
    return { type: "array", count: Math.max(a.count ?? 0, b.count ?? 0), item, nullable: a.nullable || b.nullable };
  }
  return { ...a, nullable: a.nullable || b.nullable };
}

/** Counts the leaf (non-object, non-array) fields in a shape. */
export function countLeaves(node: ShapeNode | undefined): number {
  if (!node) return 0;
  if (node.type === "object") return Object.values(node.children ?? {}).reduce((s, c) => s + countLeaves(c), 0);
  if (node.type === "array") return node.item ? countLeaves(node.item) : 0;
  return 1;
}
