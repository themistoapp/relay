// What a source's request body looks like, shared by the fetcher and the source editor.

/** The Content-Type a body looks like, for when no header sets one: JSON, form fields
 *  (`a=1&b=two`), or plain text. */
export function contentTypeFor(body: string): string {
  const t = body.trim();
  if (/^[[{]/.test(t)) return "application/json";
  if (/^[^=&\s]+=[^&\s]*(&[^=&\s]+=[^&\s]*)*$/.test(t)) return "application/x-www-form-urlencoded";
  return "text/plain; charset=utf-8";
}
