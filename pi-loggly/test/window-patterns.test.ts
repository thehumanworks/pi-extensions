import assert from "node:assert/strict";
import { test } from "node:test";
import { clusterMessages } from "../src/analysis/patterns.ts";
import { allocate, describeBasis, STRATA, windowPatterns } from "../src/analysis/window-patterns.ts";
import type { CountParams, FacetParams, IterateParams, LogEvent } from "../src/sdk/types.ts";

const FROM = Date.UTC(2026, 9, 30, 15, 29);
const UNTIL = FROM + 600_000;

/** An error with a json.message, or a raw line (logmsg only) when message is undefined. */
const event = (timestamp: number, message: string | undefined, raw = "", app = "api"): LogEvent => ({
  id: `${timestamp}-${message ?? raw}`, timestamp, logmsg: raw, tags: [], logtypes: ["json"],
  event: { json: message === undefined ? { app } : { message, app } },
});

/** `count` events evenly spaced from start for ms. */
const spread = (count: number, start: number, ms: number, make: (timestamp: number, i: number) => LogEvent) =>
  Array.from({ length: count }, (_, i) => make(start + Math.floor((i * ms) / count), i));

/** The value at a dotted path of the indexed event, as Loggly facets it. */
const valueAt = (e: LogEvent, path: string) => path.split(".").reduce<unknown>((value, part) => (value as Record<string, unknown> | undefined)?.[part], e.event);

/** A fake Loggly over fixed events: counts, facets and searches in either order, narrowed by "AND [NOT] json.message:*" as Loggly does. */
function loggly(events: LogEvent[]) {
  const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp);
  const requests: string[] = [];
  const orders: string[] = [];
  const select = (params: { query?: string; from?: unknown; until?: unknown }) => {
    const narrowed = /^\(.*\) AND (NOT )?json\.message:\*$/.exec(params.query ?? "*");
    const from = (params.from as Date).getTime();
    const until = (params.until as Date).getTime();
    return sorted.filter((e) => e.timestamp >= from && e.timestamp < until && (!narrowed || ("message" in (e.event.json as object)) !== Boolean(narrowed[1])));
  };
  return {
    requests,
    orders,
    async count(params: CountParams) {
      requests.push("count");
      return { count: select(params).length };
    },
    async facet(field: string, params: FacetParams) {
      requests.push("facet");
      const list = select(params);
      const counts = new Map<string, number>();
      for (const e of list) {
        const value = valueAt(e, field);
        if (typeof value === "string") counts.set(value, (counts.get(value) ?? 0) + 1);
      }
      const size = params.size ?? 10;
      const terms = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, size).map(([term, count]) => ({ term, count }));
      return { field, totalEvents: list.length, uniqueCount: Math.min(counts.size, size), terms, truncated: counts.size > terms.length || terms.length >= size };
    },
    async search(params: IterateParams, options: { limit: number }) {
      requests.push("search");
      orders.push(params.order ?? "desc");
      const list = select(params);
      return params.order === "asc" ? list.slice(0, options.limit) : list.slice(-options.limit).reverse();
    },
  };
}

const share = (patterns: Array<{ template: string; share: number }>, template: string) => patterns.find((p) => p.template === template)?.share ?? 0;

test("a burst that runs one provider after another is counted across the window, where its newest errors would mislead", async () => {
  // As in a real incident: a 26-second burst, provider by provider, then a quiet tail of another error.
  const events = [
    ...spread(250, FROM + 60_000, 9_000, (t) => event(t, "/integrations/alpha/refresh - Error: No details found")),
    ...spread(260, FROM + 69_000, 9_000, (t) => event(t, "/integrations/beta/refresh - Error: No details found")),
    ...spread(240, FROM + 78_000, 8_000, (t) => event(t, "/integrations/gamma/refresh - Error: No details found")),
    ...spread(53, FROM, 600_000, (t) => event(t, "invalid_grant")),
  ];
  const client = loggly(events);
  const result = await windowPatterns(client, { query: "level:error", from: FROM, until: UNTIL, sampleSize: 200, messageFields: ["json.message"] });
  assert.deepEqual(client.requests, ["facet"], "one facet, no events read");
  assert.deepEqual([result.total, result.exact, result.read], [803, 803, 0]);
  assert.deepEqual(result.patterns.map((p) => [p.template, p.count]), [
    ["/integrations/beta/refresh - Error: No details found", 260],
    ["/integrations/alpha/refresh - Error: No details found", 250],
    ["/integrations/gamma/refresh - Error: No details found", 240],
    ["invalid_grant", 53],
  ]);
  assert.equal(describeBasis(result, "error"), "803 errors: all counted");

  const newest = clusterMessages((await client.search({ query: "level:error", from: new Date(FROM), until: new Date(UNTIL) }, { limit: 200 })), { messageFields: ["json.message"] });
  assert.ok(!newest.some((p) => p.template.includes("alpha")), "the newest 200 miss the first provider entirely");
});

test("events without the message field are counted with one query and read at both ends of every slice of the window", async () => {
  // Raw lines carry their message in logmsg only: a burst of one at the start, another at the end.
  const events = [
    ...spread(400, FROM, 600_000, (t) => event(t, "Request timed out")),
    ...spread(600, FROM, 120_000, (t, i) => event(t, undefined, JSON.stringify({ message: `Token refresh failed for client ${i}` }))),
    ...spread(600, FROM + 480_000, 120_000, (t) => event(t, undefined, "    at refresh (/app/src/token.js:41:13)")),
  ];
  const client = loggly(events);
  const result = await windowPatterns(client, { query: "level:error", from: FROM, until: UNTIL, sampleSize: 200, messageFields: ["json.message", "json.msg"] });
  assert.deepEqual([result.total, result.exact], [1600, 400], "the facet counts the messages; the raw lines are estimated");
  assert.ok(result.read <= 200);
  assert.deepEqual(client.requests.filter((r) => r !== "search"), ["facet", ...Array(STRATA).fill("count")], "a facet, then a count per slice of the window");
  assert.deepEqual(client.orders, ["desc", "asc", "desc", "asc"], "both slices with raw lines are read from both ends");
  assert.equal(share(result.patterns, "Request timed out"), 0.25);
  assert.equal(share(result.patterns, "Token refresh failed for client <n>"), 0.375);
  assert.equal(share(result.patterns, "at <stack frame>"), 0.375);
  assert.equal(describeBasis(result, "error"), "1,600 errors: 400 counted, the rest estimated from 200 read at both ends of 4 equal time slices");
});

test("messages beyond the facet's 300 values are estimated from events read across the window", async () => {
  // 1,000 distinct values of one pattern overflow the facet; the counted values are not double-counted.
  const events = [
    ...spread(500, FROM, 600_000, (t) => event(t, "Disk full")),
    ...spread(1000, FROM, 600_000, (t, i) => event(t, `Payment ${i} declined`)),
  ];
  const client = loggly(events);
  const result = await windowPatterns(client, { query: "level:error", from: FROM, until: UNTIL, sampleSize: 200, messageFields: ["json.message"] });
  assert.equal(result.total, 1500);
  assert.equal(result.exact, 500 + 299, "Disk full and the 299 payment values the facet returned");
  assert.deepEqual(result.patterns.map((p) => [p.template, p.count]), [["Payment <n> declined", 1000], ["Disk full", 500]]);
});

test("a window no larger than the sample is read whole; without a facetable field it is counted first", async () => {
  const events = spread(120, FROM, 600_000, (t, i) => event(t, undefined, i % 3 ? "Connection reset" : "Disk full"));
  const client = loggly(events);
  const result = await windowPatterns(client, { query: "level:error", from: FROM, until: UNTIL, sampleSize: 200, messageFields: ["logmsg"] });
  assert.deepEqual(client.requests, ["count", "search"]);
  assert.deepEqual([result.total, result.exact, result.read], [120, 120, 120]);
  assert.deepEqual(result.patterns.map((p) => [p.template, p.count]), [["Connection reset", 80], ["Disk full", 40]]);
});

test("counted patterns still get a group breakdown, from events read across the window", async () => {
  // The newest events are all from one system; most of the window is another.
  const events = [...spread(300, FROM, 450_000, (t) => event(t, "Forbidden", "", "api")), ...spread(100, FROM + 450_000, 150_000, (t) => event(t, "Forbidden", "", "worker"))];
  const client = loggly(events);
  const result = await windowPatterns(client, { query: "level:error", from: FROM, until: UNTIL, sampleSize: 40, messageFields: ["json.message"], groupField: "json.app" });
  assert.deepEqual([result.total, result.exact, result.read], [400, 400, 40]);
  assert.deepEqual(result.patterns[0]!.groups, { api: 300, worker: 100 });
  assert.equal(result.onlyGroup, undefined);
  assert.ok(result.patterns[0]!.firstSeen! < FROM + 150_000 && result.patterns[0]!.lastSeen! >= FROM + 450_000, "seen across the window");
});

test("a window from a single group puts every pattern in it, including patterns no read reached", async () => {
  // A burst of one error at the start, buried under a later flood: the reads miss it.
  const events = [...spread(10, FROM, 1_000, (t) => event(t, "Disk full")), ...spread(990, FROM + 150_000, 1_000, (t) => event(t, "Forbidden"))];
  const client = loggly(events);
  const result = await windowPatterns(client, { query: "level:error", from: FROM, until: UNTIL, sampleSize: 40, messageFields: ["json.message"], groupField: "json.app" });
  assert.equal(result.onlyGroup, "api");
  assert.deepEqual(result.patterns.map((p) => [p.template, p.groups]), [["Forbidden", { api: 990 }], ["Disk full", { api: 10 }]]);
});

test("budgets split across slices in proportion to their counts, reading every non-empty slice", () => {
  assert.deepEqual(allocate([600, 0, 0, 600], 200), [100, 0, 0, 100]);
  assert.deepEqual(allocate([1, 1000, 0, 5], 10), [1, 8, 0, 1]);
  assert.deepEqual(allocate([3, 2, 0, 0], 200), [3, 2, 0, 0], "never more than a slice holds");
  assert.deepEqual(allocate([0, 0, 0, 0], 50), [0, 0, 0, 0]);
});
