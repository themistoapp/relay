// Helpers for editing an endpoint definition in the builder.
import { leafName, rowBase, isListPath, parsePath } from "$engine/paths";
import type { EndpointDefinition, FieldDef, OutNode } from "$engine/render";
import { uid } from "./format";

export type ListNode = Extract<OutNode, { t: "list" }>;

export function uniqueName(existing: string[], base: string): string {
  const clean = base.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "value";
  if (!existing.includes(clean)) return clean;
  for (let i = 2; ; i++) if (!existing.includes(`${clean}_${i}`)) return `${clean}_${i}`;
}

const keysOf = (nodes: OutNode[]) => nodes.map((n) => n.key);

/** The name of the list a path repeats over, e.g. `$.data.stations[*]` → `stations`. */
export function listName(base: string): string {
  const keys = parsePath(base).filter((t) => t.k === "key");
  const last = keys[keys.length - 1];
  return last && last.k === "key" ? last.v : "items";
}

export function walk(nodes: OutNode[], fn: (n: OutNode, parent: OutNode[]) => void) {
  for (const n of nodes) {
    fn(n, nodes);
    if (n.t !== "field") walk(n.children, fn);
  }
}

export function findNode(nodes: OutNode[], id: string): { node: OutNode; parent: OutNode[]; index: number } | null {
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.id === id) return { node: n, parent: nodes, index: i };
    if (n.t !== "field") {
      const f = findNode(n.children, id);
      if (f) return f;
    }
  }
  return null;
}

export function contains(node: OutNode, id: string): boolean {
  if (node.id === id) return true;
  return node.t !== "field" && node.children.some((c) => contains(c, id));
}

/** Ticking a field in the Pick step: add it, and put it somewhere sensible in the output. */
export function addField(def: EndpointDefinition, sourceId: number, path: string): FieldDef {
  const name = uniqueName(def.fields.map((f) => f.name), leafName(path));
  const field: FieldDef = { id: uid(), name, sourceId, path, mode: isListPath(path) ? "row" : "value", ops: [] };
  def.fields.push(field);
  if (field.mode === "value") {
    def.output.push({ id: uid(), t: "field", key: name, fieldId: field.id });
  } else {
    const base = rowBase(path)!;
    let list = def.output.find((n): n is ListNode => n.t === "list" && n.sourceId === sourceId && n.over === base);
    if (!list) {
      list = { id: uid(), t: "list", key: uniqueName(def.output.map((n) => n.key), listName(base)), sourceId, over: base, children: [] };
      def.output.push(list);
      // Keep editing the reactive copy the array now holds, not the plain object.
      list = def.output[def.output.length - 1] as ListNode;
    }
    list.children.push({ id: uid(), t: "field", key: uniqueName(keysOf(list.children), leafName(path)), fieldId: field.id });
  }
  return field;
}

/** Removes fields and every output node that uses them. Lists left empty go too. */
export function removeFields(def: EndpointDefinition, ids: Set<string>) {
  def.fields = def.fields.filter((f) => !ids.has(f.id));
  const prune = (nodes: OutNode[]): OutNode[] =>
    nodes
      .filter((n) => !(n.t === "field" && ids.has(n.fieldId)))
      .map((n) => (n.t === "field" ? n : { ...n, children: prune(n.children) }))
      .filter((n) => !(n.t === "list" && n.children.length === 0));
  def.output = prune(def.output);
}

export function fieldsUsing(def: EndpointDefinition, sourceId: number, path: string): FieldDef[] {
  return def.fields.filter((f) => f.sourceId === sourceId && f.path === path);
}
