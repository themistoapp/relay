import { describe, expect, it } from "vitest";
import { fillPlaceholders, midnightIn } from "../../src/engine/placeholders.js";
import { buildRequest, contentTypeFor, type RequestSpec } from "../../src/puller/fetcher.js";

const LONDON = "Europe/London";
// 23:30 on 30 Sep 2026 in London (BST): 22:30 UTC.
const BST_LATE = Date.parse("2026-09-30T22:30:00Z");
// 00:30 on 1 Oct 2026 in London: still 30 Sep in UTC.
const BST_AFTER_MIDNIGHT = Date.parse("2026-09-30T23:30:00Z");

describe("date placeholders", () => {
  it("fills now, today and tomorrow as ISO 8601 in UTC", () => {
    expect(fillPlaceholders("{now}", BST_LATE, LONDON)).toBe("2026-09-30T22:30:00Z");
    expect(fillPlaceholders("{today}", BST_LATE, LONDON)).toBe("2026-09-29T23:00:00Z");
    expect(fillPlaceholders("{tomorrow}", BST_LATE, LONDON)).toBe("2026-09-30T23:00:00Z");
  });

  it("goes by the date in the time zone, not UTC", () => {
    expect(fillPlaceholders("{today}", BST_AFTER_MIDNIGHT, LONDON)).toBe("2026-09-30T23:00:00Z");
    expect(fillPlaceholders("{today:date}", BST_AFTER_MIDNIGHT, LONDON)).toBe("2026-10-01");
    expect(fillPlaceholders("{today}", BST_AFTER_MIDNIGHT, "UTC")).toBe("2026-09-30T00:00:00Z");
  });

  it("finds midnight either side of a clock change", () => {
    expect(new Date(midnightIn("2026-10-25", LONDON)).toISOString()).toBe("2026-10-24T23:00:00.000Z"); // clocks go back at 02:00
    expect(new Date(midnightIn("2026-10-26", LONDON)).toISOString()).toBe("2026-10-26T00:00:00.000Z");
    expect(new Date(midnightIn("2026-03-29", LONDON)).toISOString()).toBe("2026-03-29T00:00:00.000Z"); // clocks go forward at 01:00
    expect(new Date(midnightIn("2026-03-30", LONDON)).toISOString()).toBe("2026-03-29T23:00:00.000Z");
  });

  it("applies offsets, with days on today/tomorrow landing on midnight", () => {
    expect(fillPlaceholders("{now-1h}", BST_LATE, LONDON)).toBe("2026-09-30T21:30:00Z");
    expect(fillPlaceholders("{now+30m}", BST_LATE, LONDON)).toBe("2026-09-30T23:00:00Z");
    expect(fillPlaceholders("{today+2d:date}", BST_LATE, LONDON)).toBe("2026-10-02");
    // 24 Oct + 2 days crosses the clock change: still midnight, now in GMT.
    expect(fillPlaceholders("{today+2d}", Date.parse("2026-10-24T12:00:00Z"), LONDON)).toBe("2026-10-26T00:00:00Z");
    expect(fillPlaceholders("{tomorrow+6h}", BST_LATE, LONDON)).toBe("2026-10-01T05:00:00Z");
  });

  it("writes unix seconds and milliseconds", () => {
    expect(fillPlaceholders("{now:unix}", BST_LATE, LONDON)).toBe(String(BST_LATE / 1000));
    expect(fillPlaceholders("{now:ms}", BST_LATE, LONDON)).toBe(String(BST_LATE));
  });

  it("leaves other braces alone", () => {
    const body = '{"from": "{today}", "tag": "{notaplaceholder}", "n": {"a": 1}}';
    expect(fillPlaceholders(body, BST_LATE, LONDON)).toBe('{"from": "2026-09-29T23:00:00Z", "tag": "{notaplaceholder}", "n": {"a": 1}}');
  });
});

describe("building a request", () => {
  const spec = (over: Partial<RequestSpec>): RequestSpec => ({ method: "GET", url: "https://api.example.com/x", headers: [], body: null, authType: "none", authName: "", authSecret: null, timeoutMs: 1000, ...over });

  it("fills placeholders in the URL, header values and body", () => {
    const { url, init } = buildRequest(
      spec({ method: "POST", url: "https://api.carbonintensity.org.uk/intensity/{today}/fw48h", headers: [{ key: "X-From", value: "{today:date}" }], body: '{"at": "{now}"}' }),
      BST_LATE,
      LONDON,
    );
    expect(url).toBe("https://api.carbonintensity.org.uk/intensity/2026-09-29T23:00:00Z/fw48h");
    expect((init.headers as Headers).get("x-from")).toBe("2026-09-30");
    expect(init.body).toBe('{"at": "2026-09-30T22:30:00Z"}');
  });

  it("sets a Content-Type to match the body unless a header sets one", () => {
    expect(contentTypeFor('  {"a": 1}')).toBe("application/json");
    expect(contentTypeFor("[1, 2]")).toBe("application/json");
    expect(contentTypeFor("grant_type=client_credentials&scope=read")).toBe("application/x-www-form-urlencoded");
    expect(contentTypeFor("hello there")).toBe("text/plain; charset=utf-8");
    const own = buildRequest(spec({ method: "POST", body: "a=1", headers: [{ key: "Content-Type", value: "application/xml" }] }));
    expect((own.init.headers as Headers).get("content-type")).toBe("application/xml");
    const form = buildRequest(spec({ method: "POST", body: "a=1&b=2" }));
    expect((form.init.headers as Headers).get("content-type")).toBe("application/x-www-form-urlencoded");
  });

  it("never sends a body with GET", () => {
    expect(buildRequest(spec({ body: '{"a": 1}' })).init.body).toBeUndefined();
  });
});
