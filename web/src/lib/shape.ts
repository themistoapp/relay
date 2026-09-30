import { childPath, parsePath } from "$engine/paths";
import type { ShapeNode } from "$engine/shape";

/** Every leaf in a shape, with list items as `[*]`. */
export function leafPaths(node: ShapeNode | null | undefined, path = "$"): { path: string; type: string }[] {
  if (!node) return [];
  if (node.type === "object") return Object.entries(node.children ?? {}).flatMap(([k, c]) => leafPaths(c, childPath(path, k)));
  if (node.type === "array") return node.item ? leafPaths(node.item, childPath(path, "*")) : [];
  return [{ path, type: node.type }];
}

/** The shape at a path, following `[*]` into list items. */
export function shapeAt(node: ShapeNode | null | undefined, tokens: string[]): ShapeNode | undefined {
  let n = node ?? undefined;
  for (const t of tokens) {
    if (!n) return undefined;
    n = t === "[*]" ? n.item : n.children?.[t];
  }
  return n;
}

/** Leaf paths inside one item of the list at `base` (e.g. `$.stations[*]`), relative to the item. */
export function rowLeafPaths(shape: ShapeNode | null | undefined, base: string): string[] {
  const prefix = base;
  return leafPaths(shape)
    .map((l) => l.path)
    .filter((p) => p.startsWith(prefix) && p !== prefix)
    .map((p) => "$" + p.slice(prefix.length));
}

/** Whether a picked path is a whole object or list rather than a single value. */
export function isGroupPath(shape: ShapeNode | null | undefined, path: string): boolean {
  let n = shape ?? undefined;
  for (const t of parsePath(path)) n = t.k === "key" ? n?.children?.[t.v] : n?.item;
  return n?.type === "object" || n?.type === "array";
}
