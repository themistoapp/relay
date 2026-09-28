// A small JSONPath subset: `$`, `.key`, `["any key"]`, `[3]` and `[*]` (every item of a list).
// Paths are what the Pick step produces when you tick a field, e.g. `$.stations[*].prices.E10`.

export type Token = { k: "key"; v: string } | { k: "index"; v: number } | { k: "all" };

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$-]*$/;

export function parsePath(path: string): Token[] {
  const s = path.trim();
  if (!s.startsWith("$")) throw new Error(`Path must start with $: ${path}`);
  const out: Token[] = [];
  let i = 1;
  while (i < s.length) {
    const c = s[i];
    if (c === ".") {
      let j = i + 1;
      while (j < s.length && s[j] !== "." && s[j] !== "[") j++;
      const key = s.slice(i + 1, j);
      if (!key) throw new Error(`Empty key in path: ${path}`);
      out.push({ k: "key", v: key });
      i = j;
    } else if (c === "[" && s[i + 1] === '"') {
      // A quoted key can hold any character, "]" included, so scan to its closing quote.
      let j = i + 2;
      while (j < s.length && s[j] !== '"') j += s[j] === "\\" ? 2 : 1;
      if (s[j + 1] !== "]") throw new Error(`Unclosed ["…"] in path: ${path}`);
      out.push({ k: "key", v: JSON.parse(s.slice(i + 1, j + 1)) });
      i = j + 2;
    } else if (c === "[") {
      const end = s.indexOf("]", i);
      if (end < 0) throw new Error(`Unclosed [ in path: ${path}`);
      const inner = s.slice(i + 1, end);
      if (inner === "*") out.push({ k: "all" });
      else if (/^\d+$/.test(inner)) out.push({ k: "index", v: Number(inner) });
      else throw new Error(`Bad bracket in path: [${inner}]`);
      i = end + 1;
    } else throw new Error(`Unexpected "${c}" in path: ${path}`);
  }
  return out;
}

export function formatPath(tokens: Token[]): string {
  return (
    "$" +
    tokens
      .map((t) => (t.k === "all" ? "[*]" : t.k === "index" ? `[${t.v}]` : IDENT.test(t.v) ? `.${t.v}` : `[${JSON.stringify(t.v)}]`))
      .join("")
  );
}

export function childPath(parent: string, key: string | number | "*"): string {
  if (key === "*") return parent + "[*]";
  if (typeof key === "number") return `${parent}[${key}]`;
  return IDENT.test(key) ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`;
}

function walk(value: unknown, tokens: Token[], i: number): unknown {
  if (i === tokens.length) return value;
  if (value === null || value === undefined) return undefined;
  const t = tokens[i];
  if (t.k === "all") return Array.isArray(value) ? value.map((v) => walk(v, tokens, i + 1)) : undefined;
  if (t.k === "index") return Array.isArray(value) ? walk(value[t.v], tokens, i + 1) : undefined;
  if (typeof value !== "object" || Array.isArray(value)) return undefined;
  return walk((value as Record<string, unknown>)[t.v], tokens, i + 1);
}

const cache = new Map<string, Token[]>();
function tokensOf(path: string): Token[] {
  let t = cache.get(path);
  if (!t) {
    t = parsePath(path);
    if (cache.size > 2000) cache.clear();
    cache.set(path, t);
  }
  return t;
}

/** Every `[*]` in the path turns into a list, so `$.a[*].b` gives the `b` of each item of `a`. */
export function resolve(root: unknown, path: string): unknown {
  return walk(root, tokensOf(path), 0);
}

/** The part of a path up to and including its first `[*]`: the list a per-item field repeats over. */
export function rowBase(path: string): string | null {
  const t = tokensOf(path);
  const i = t.findIndex((x) => x.k === "all");
  return i < 0 ? null : formatPath(t.slice(0, i + 1));
}

/** The rest of a path after its row base, as a path from one item: `$.a[*].b.c` → `$.b.c`. */
export function relativeToRow(path: string): string {
  const t = tokensOf(path);
  const i = t.findIndex((x) => x.k === "all");
  return formatPath(i < 0 ? t : t.slice(i + 1));
}

export function isListPath(path: string): boolean {
  return tokensOf(path).some((t) => t.k === "all");
}

/** A readable label for a path, e.g. `stations[*].prices.E10` → `E10`. */
export function leafName(path: string): string {
  const keys = tokensOf(path).filter((t): t is { k: "key"; v: string } => t.k === "key");
  return keys.length ? keys[keys.length - 1].v : "value";
}
