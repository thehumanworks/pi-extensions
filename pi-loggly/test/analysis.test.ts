import assert from "node:assert/strict";
import { test } from "node:test";
import { formatCount, formatPercent, formatRatio, sparkline } from "../src/analysis/format.ts";
import {
  allOf,
  collectHealth,
  DEFAULT_HEALTH_RULES,
  evaluateHealth,
  fieldMatch,
  healthWindows,
  median,
  recurrences,
  type HealthRules,
  type WindowCounts,
} from "../src/analysis/health.ts";
import { clusterMessages, extractMessage, getField, templateOf } from "../src/analysis/patterns.ts";
import type { FacetParams, FacetResult, LogEvent } from "../src/sdk/types.ts";

const event = (message: string, extra: Partial<LogEvent> = {}, fields: Record<string, unknown> = {}): LogEvent => ({
  id: Math.random().toString(36),
  timestamp: 1_000,
  logmsg: "",
  tags: [],
  logtypes: [],
  event: { json: { message, ...fields } },
  ...extra,
});

test("templates mask variable parts so equivalent messages group", () => {
  assert.equal(
    templateOf('live visit data: updateSingleRecord - Error when calling redis (sadd), {"command":"SADD","args":["VP:164742"]}'),
    "live visit data: updateSingleRecord - Error when calling redis (sadd), {…}",
  );
  assert.equal(templateOf("User 1234 failed login from 10.1.2.3:8080 at 2026-10-30T09:49:28.183Z"), "User <n> failed login from <ip> at <time>");
  assert.equal(templateOf("job 3fc58b45-1cfd-4a7a-8046-51129ac2c04f for bob@example.com"), "job <uuid> for <email>");
  assert.equal(templateOf("Run `npm install -g npm@12.2.1` to update!"), "Run `npm install -g npm@<n>` to update!", "versions are not emails");
  assert.equal(templateOf("GET https://api.example.com/v2/items?id=9&token=abc failed"), "GET https://api.example.com/v<n>/items?… failed");
  assert.equal(
    templateOf("/dynamics/script/config?lfClientId=1834&sessionId=3fc58b45-1cfd-4a7a-8046-51129ac2c04f&url=https%3A%2F%2Fshop.example.com - timeout"),
    "/dynamics/script/config?… - timeout",
    "a path's query string is masked too",
  );
  assert.equal(templateOf("Is /api down? yes"), "Is /api down? yes", "a question mark in prose is kept");
  assert.equal(templateOf("Error: boom\n    at handler (/app/x.js:10:5)"), "Error: boom");
  assert.equal(templateOf("trace deadbeefcafe1234 failed"), "trace <hex> failed");
  assert.equal(templateOf('{"only":"json"}'), '{"only":"json"}', "a message that is only JSON is kept, not erased");
  assert.equal(templateOf("   "), "(empty message)");
});

test("messages come from configured fields, then JSON logmsg, then raw logmsg", () => {
  assert.equal(extractMessage(event("from json"), ["json.message"]), "from json");
  assert.equal(extractMessage({ ...event(""), logmsg: '{"msg":"parsed"}' }, ["json.message"]), "parsed");
  assert.equal(extractMessage({ ...event(""), event: {}, logmsg: "plain text" }), "plain text");
  const dotted = { ...event(""), event: { json: { "cs(User-Agent)": "curl", nested: { a: 1 } } } };
  assert.equal(getField(dotted, "json.cs(User-Agent)"), "curl");
  assert.equal(getField(dotted, "json.nested.a"), 1);
  assert.deepEqual(getField({ ...dotted, tags: ["x"] }, "tag"), ["x"]);
});

test("clustering counts patterns, shares, time span and groups", () => {
  const events = [
    event("Timeout after 100ms", { timestamp: 3 }, {}),
    event("Timeout after 250ms", { timestamp: 1 }),
    event("Disk full", { timestamp: 2 }),
  ].map((e, i) => ({ ...e, event: { ...e.event, derived: { App: i < 2 ? "api" : "worker" } } }));
  const patterns = clusterMessages(events, { messageFields: ["json.message"], groupField: "derived.App" });
  assert.equal(patterns.length, 2);
  assert.deepEqual(
    { template: patterns[0]!.template, count: patterns[0]!.count, firstSeen: patterns[0]!.firstSeen, lastSeen: patterns[0]!.lastSeen, groups: patterns[0]!.groups },
    { template: "Timeout after <n>ms", count: 2, firstSeen: 1, lastSeen: 3, groups: { api: 2 } },
  );
  assert.ok(Math.abs(patterns[0]!.share - 2 / 3) < 1e-9);
});

test("query helpers quote exact matches and combine clauses", () => {
  assert.equal(fieldMatch("syslog.appName", 'shop\\live\\"api"'), 'syslog.appName:"shop\\\\live\\\\\\"api\\""');
  assert.equal(allOf("*", "env:prod", "level:(error OR fatal)", fieldMatch("app", "x")), 'env:prod AND (level:(error OR fatal)) AND app:"x"');
  assert.equal(allOf("*", undefined, " "), "*");
  assert.equal(allOf("(a OR b)"), "(a OR b)");
});

test("formatting helpers stay compact", () => {
  assert.deepEqual([formatCount(950), formatCount(1234), formatCount(21_234), formatCount(3_400_000)], ["950", "1.2k", "21k", "3.4M"]);
  assert.deepEqual([formatPercent(0.0004), formatPercent(0.095), formatPercent(0.41)], ["<0.1%", "9.5%", "41%"]);
  assert.deepEqual([formatRatio(8.14), formatRatio(63.2), formatRatio(Infinity)], ["×8.1", "×63", "×∞"]);
  assert.equal(sparkline([0, 1, 2, 4]), "▁▃▅█");
  assert.equal(sparkline([0, 0]), "▁▁");
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([4, 1, 3, 2]), 2.5);
});

test("recurrences ignore the episode still in progress", () => {
  const high = (n: number) => n >= 100;
  assert.equal(recurrences([10, 10, 10, 10, 500, 600], high), 0, "an incident that started 20 minutes ago is ongoing, not recurring");
  assert.equal(recurrences([757, 12, 12, 757, 12, 12], high), 2, "periodic bursts recur");
  assert.equal(recurrences([], high), 0);
});

// Rules with simple numbers for readable scenarios.
const rules: HealthRules = { ...DEFAULT_HEALTH_RULES, scope: "env:prod", groupBy: "app", errorQuery: "level:error", window: "10m", baselineWindows: 4, minErrors: 50, silentMinBaseline: 200 };

function facet(counts: Record<string, number>, extra: Partial<FacetResult> = {}): FacetResult {
  const terms = Object.entries(counts).filter(([, count]) => count > 0).map(([term, count]) => ({ term, count })).sort((a, b) => b.count - a.count);
  return { field: "app", totalEvents: terms.reduce((sum, t) => sum + t.count, 0), uniqueCount: terms.length, terms, truncated: false, ...extra };
}

/** Build windows from per-system series (oldest first; last is the current window). */
function windows(series: Record<string, { errors: number[]; volume: number[] }>): WindowCounts[] {
  const length = Object.values(series)[0]!.errors.length;
  return Array.from({ length }, (_, index) => ({
    from: index * 600_000,
    until: (index + 1) * 600_000,
    errors: facet(Object.fromEntries(Object.entries(series).map(([name, s]) => [name, s.errors[index]!]))),
    volume: facet(Object.fromEntries(Object.entries(series).map(([name, s]) => [name, s.volume[index]!]))),
  }));
}

const steady = { errors: [10, 12, 9, 11, 10], volume: [5000, 5100, 4900, 5000, 5050] };

test("a quiet account is healthy", () => {
  const snapshot = evaluateHealth(windows({ api: steady, worker: { errors: [0, 0, 0, 0, 0], volume: [800, 820, 790, 810, 805] } }), rules, 1);
  assert.equal(snapshot.status, "healthy");
  assert.deepEqual(snapshot.issues, []);
  assert.deepEqual(snapshot.systems.map((s) => s.status), ["ok", "ok"]);
  assert.equal(snapshot.systems[0]!.errorsBaseline, 10.5);
});

test("error spikes are warnings, large ones critical, with a reproducing query", () => {
  const snapshot = evaluateHealth(windows({
    api: { errors: [10, 12, 9, 11, 400], volume: steady.volume },
    web: { errors: [20, 20, 20, 20, 90], volume: steady.volume },
    calm: steady,
  }), rules, 1);
  assert.equal(snapshot.status, "critical");
  const [first, second] = snapshot.issues;
  assert.equal(first!.id, "spike:api");
  assert.equal(first!.severity, "critical");
  assert.equal(first!.query, 'env:prod AND level:error AND app:"api"');
  assert.match(first!.summary, /errors ×38: 400 in 10m, usually 11/);
  assert.equal(second!.id, "spike:web");
  assert.equal(second!.severity, "warning");
  assert.equal(snapshot.systems[0]!.name, "api");
});

test("small changes and absolute floors do not raise spikes", () => {
  const snapshot = evaluateHealth(windows({ tiny: { errors: [1, 1, 1, 1, 30], volume: [500, 500, 500, 500, 500] } }), rules, 1);
  assert.deepEqual(snapshot.issues, [], "30 errors is below minErrors even at ×30");
});

test("periodic bursts are recurring notices; an ongoing incident stays a spike", () => {
  // Like the live integrationauth trend █▁▁█▁▁█: a burst every third window.
  const periodic = evaluateHealth(windows({ cron: { errors: [12, 700, 12, 12, 757], volume: [600, 3000, 600, 600, 3000] } }), rules, 1);
  assert.equal(periodic.issues[0]!.kind, "recurring");
  assert.equal(periodic.issues[0]!.severity, "notice");
  assert.equal(periodic.status, "healthy", "notices do not degrade overall health");

  const ongoing = evaluateHealth(windows({ api: { errors: [10, 10, 10, 500, 600], volume: steady.volume } }), rules, 1);
  assert.equal(ongoing.issues[0]!.kind, "spike");
  assert.equal(ongoing.issues[0]!.severity, "critical");
});

test("errors from a system with none are new errors: warning, or critical when large", () => {
  const small = evaluateHealth(windows({ job: { errors: [0, 0, 0, 0, 76], volume: [0, 0, 0, 0, 164] } }), rules, 1);
  assert.equal(small.issues[0]!.id, "new-errors:job");
  assert.equal(small.issues[0]!.severity, "warning");
  assert.match(small.issues[0]!.summary, /new errors: 76 in 10m, usually none/);
  const large = evaluateHealth(windows({ job: { errors: [0, 0, 0, 0, 900], volume: [100, 100, 100, 100, 1000] } }), rules, 1);
  assert.equal(large.issues[0]!.severity, "critical");
});

test("a system with no events is critical; one quiet window is a warning until it persists", () => {
  const stopped = evaluateHealth(windows({ api: { errors: [5, 5, 5, 5, 0], volume: [5000, 5000, 5000, 5000, 0] }, other: steady }), rules, 1);
  assert.deepEqual([stopped.issues[0]!.id, stopped.issues[0]!.severity], ["silent:api", "critical"]);
  assert.match(stopped.issues[0]!.summary, /^stopped logging: no events in 10m, usually 5k$/);
  assert.equal(stopped.issues[0]!.query, 'env:prod AND app:"api"');
  assert.equal(stopped.systems[0]!.issue, "silent");

  const lull = evaluateHealth(windows({ api: { errors: [5, 5, 5, 5, 0], volume: [5000, 5000, 5000, 5000, 200] }, other: steady }), rules, 1);
  assert.deepEqual([lull.issues[0]!.severity, lull.issues[0]!.summary], ["warning", "log volume down 96%: 200 events in 10m, usually 5k"]);

  const persisted = evaluateHealth(windows({ api: { errors: [5, 5, 5, 0, 0], volume: [5000, 5000, 5000, 300, 200] }, other: steady }), rules, 1);
  assert.equal(persisted.issues[0]!.severity, "critical");
  assert.match(persisted.issues[0]!.summary, /; also low in the previous window$/);
});

test("a quiet window is cleared when logging has since resumed", () => {
  const ws = windows({ api: { errors: [5, 5, 5, 5, 0], volume: [5000, 5000, 5000, 5000, 200] }, other: steady });
  const resumed = (count: number, ms = 120_000) => evaluateHealth(ws, rules, 1, { from: 3_000_000, until: 3_000_000 + ms, volume: facet({ api: count, other: 1000 }) });
  assert.deepEqual(resumed(900).issues, [], "900 events in 2m is above the quiet rate (500 per 10m)");
  assert.equal(resumed(50).issues[0]!.id, "silent:api", "still quiet");
  assert.equal(resumed(900, 10_000).issues[0]!.id, "silent:api", "10 seconds is too short to judge");
});

test("systems that are regularly quiet are not silent", () => {
  const batch = evaluateHealth(windows({ batch: { errors: [0, 0, 0, 0, 0], volume: [900, 0, 900, 900, 0] }, other: steady }), rules, 1);
  assert.deepEqual(batch.issues, [], "a job that is idle between runs is not silent");
});

test("an account-wide volume drop is one ingestion issue, not one per system", () => {
  const snapshot = evaluateHealth(windows({ a: { errors: [0, 0, 0, 0, 0], volume: [5000, 5000, 5000, 5000, 10] }, b: { errors: [0, 0, 0, 0, 0], volume: [4000, 4000, 4000, 4000, 5] } }), rules, 1);
  assert.deepEqual(snapshot.issues.map((issue) => issue.id), ["ingestion"]);
  assert.match(snapshot.issues[0]!.summary, /possible ingestion or indexing delay/);
});

test("chronic error rates are notices; muted systems raise nothing", () => {
  const snapshot = evaluateHealth(windows({
    noisy: { errors: [600, 600, 600, 600, 600], volume: [1000, 1000, 1000, 1000, 1000] },
    loud: { errors: [10, 10, 10, 10, 900], volume: steady.volume },
    calm: steady,
  }), { ...rules, muted: ["loud"] }, 1);
  assert.deepEqual(snapshot.issues.map((issue) => [issue.id, issue.severity]), [["chronic:noisy", "notice"]]);
  assert.equal(snapshot.systems.find((s) => s.name === "loud")!.status, "muted");
  assert.equal(snapshot.status, "healthy");
});

test("absent systems in a truncated facet are not assumed silent", () => {
  const ws = windows({ big: steady, small: { errors: [0, 0, 0, 0, 0], volume: [300, 300, 300, 300, 0] } });
  // The current window lists only "big" and says more systems exist.
  ws[4]!.volume = facet({ big: 5050 }, { truncated: true });
  const snapshot = evaluateHealth(ws, rules, 1);
  assert.ok(!snapshot.issues.some((issue) => issue.kind === "silent"), "small's true count is unknown below 5050");
  assert.equal(snapshot.truncated, true);
});

test("health windows align to minutes and skip the indexing lag", () => {
  const now = Date.UTC(2026, 9, 30, 10, 7, 42);
  const ranges = healthWindows({ ...rules, window: "10m", baselineWindows: 2, lag: "2m" }, now);
  assert.deepEqual(ranges.map((r) => [new Date(r.from).toISOString().slice(11, 16), new Date(r.until).toISOString().slice(11, 16)]), [["09:35", "09:45"], ["09:45", "09:55"], ["09:55", "10:05"]]);
});

test("collectHealth facets each window, then samples the top issues' messages", async () => {
  const calls: Array<{ field: string; params: FacetParams }> = [];
  const series: Record<string, number[]> = { errors: [10, 10, 10, 10, 500], volume: [5000, 5000, 5000, 5000, 5000] };
  let index = 0;
  const starts: number[] = [];
  const client = {
    async facet(field: string, params: FacetParams) {
      calls.push({ field, params });
      const from = (params.from as Date).getTime();
      if (!starts.includes(from)) starts.push(from);
      starts.sort((a, b) => a - b);
      const window = starts.indexOf(from);
      const isErrors = String(params.query).includes("level:error");
      index++;
      return facet({ api: (isErrors ? series.errors : series.volume)[Math.min(window, 4)]! });
    },
    async search() {
      return [event("redis timeout after 30ms"), event("redis timeout after 31ms"), event("other")];
    },
  };
  // Facet calls arrive in window order, so window indexes match the series.
  const snapshot = await collectHealth(client, rules, { now: Date.UTC(2026, 9, 30, 10) });
  assert.equal(index, 11, "errors and volume for 5 windows, and volume since the last");
  assert.equal(starts.at(-1), Date.UTC(2026, 9, 30, 9, 58), "the recent window starts where the current one ends");
  assert.ok(calls.every((call) => call.field === "app" && call.params.size === 300));
  assert.ok(calls.some((call) => call.params.query === "env:prod AND level:error"));
  assert.ok(calls.some((call) => call.params.query === "env:prod"));
  assert.equal(snapshot.issues[0]!.id, "spike:api");
  assert.equal(snapshot.issues[0]!.sampled, 3);
  assert.equal(snapshot.issues[0]!.patterns![0]!.template, "redis timeout after <n>ms");
});

test("collectHealth fails as a whole when a window fails; sampling failures are warnings", async () => {
  const failing = { facet: async () => { throw new Error("HTTP 503"); }, search: async () => [] };
  await assert.rejects(collectHealth(failing, rules), /HTTP 503/);
  const sampleFails = {
    facet: async (_field: string, params: FacetParams) => facet({ api: String(params.query).includes("level:error") ? ((params.from as Date).getTime() > Date.UTC(2026, 9, 30, 9, 45) ? 500 : 10) : 5000 }),
    search: async () => { throw new Error("HTTP 429"); },
  };
  const snapshot = await collectHealth(sampleFails, rules, { now: Date.UTC(2026, 9, 30, 10) });
  assert.equal(snapshot.issues[0]!.patterns, undefined);
  assert.match(snapshot.warnings.join("\n"), /Could not sample messages for api: HTTP 429/);
});
