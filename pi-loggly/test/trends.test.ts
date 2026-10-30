import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync as makeTemp, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { DEFAULT_HEALTH_RULES, type HealthRules } from "../src/analysis/health.ts";
import { pruneResults, writeResultFile } from "../src/results.ts";
import type { CountParams, FacetParams, FacetResult, IterateParams, LogEvent } from "../src/sdk/types.ts";
import { capturableDays, captureDay, formatTrendReport, isoDay, latestCompleteDay, loadTrends, TrendRecorder, trendRules, type TrendDay } from "../src/trends.ts";

const temps: string[] = [];
/** A private temporary directory removed after the tests. */
function tempDir(): string {
  const dir = makeTemp(join(tmpdir(), "pi-loggly-trends-"));
  temps.push(dir);
  return dir;
}
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

const rules: HealthRules = { ...DEFAULT_HEALTH_RULES, scope: "env:prod", groupBy: "app", errorQuery: "level:error", messageFields: ["json.message"] };
const NOW = Date.UTC(2026, 9, 30, 10);

function facet(field: string, counts: Record<string, number>, truncated = false): FacetResult {
  const terms = Object.entries(counts).map(([term, count]) => ({ term, count })).sort((a, b) => b.count - a.count);
  return { field, totalEvents: terms.reduce((sum, t) => sum + t.count, 0), uniqueCount: terms.length, terms, truncated };
}

function fakeClient() {
  const calls: Array<{ field: string; params: FacetParams }> = [];
  return {
    calls,
    accounts: 0,
    searches: 0,
    async account() {
      this.accounts++;
      return { subdomain: "acme", retentionDays: 30 };
    },
    async facet(field: string, params: FacetParams) {
      calls.push({ field, params });
      if (field === "json.message") return facet(field, { "Redis timeout after 30ms": 40, "Redis timeout after 45ms": 20, "Forbidden": 10 });
      if (String(params.query).includes("level:error")) return facet(field, { api: 60, worker: 10 });
      return facet(field, { api: 5000, worker: 1000 }, true);
    },
    async search(): Promise<LogEvent[]> {
      this.searches++;
      return [];
    },
    async count() {
      return { count: 0 };
    },
  };
}

/**
 * A day of errors spread evenly: 20,000 “Forbidden” (a listed message),
 * 6,000 “Queue full id <n>” with a different id each (beyond the list) and
 * 2,000 without a message. Facets and searches answer from it.
 */
function sampledDayClient(date: string) {
  const start = Date.parse(`${date}T00:00:00Z`);
  const events: LogEvent[] = [];
  const add = (count: number, app: string, json: (i: number) => Record<string, unknown>, logmsg = "") => {
    for (let i = 0; i < count; i++) events.push({ id: `${app}${i}`, timestamp: start + Math.floor(((i + 0.5) / count) * 86_400_000), logmsg, tags: [], logtypes: [], event: { json: json(i), app } });
  };
  add(20_000, "api", () => ({ message: "Forbidden" }));
  add(6_000, "worker", (i) => ({ message: `Queue full id ${i}` }));
  add(2_000, "batch", () => ({}), "disk full on /dev/sda1");
  events.sort((a, b) => a.timestamp - b.timestamp);
  const within = (params: { from?: unknown; until?: unknown }) => events.filter((e) => e.timestamp >= (params.from as Date).getTime() && e.timestamp < (params.until as Date).getTime());
  return {
    async facet(field: string, params: FacetParams) {
      if (field === "json.message") return facet(field, { Forbidden: 20_000 });
      if (String(params.query).includes("level:error")) return facet(field, { api: 20_000, worker: 6_000, batch: 2_000 });
      return facet(field, { api: 100_000, worker: 50_000, batch: 10_000 });
    },
    async search(params: IterateParams, options: { limit: number }) {
      return within(params).reverse().slice(0, options.limit);
    },
    async count(params: CountParams) {
      return { count: within(params).length };
    },
  };
}

test("capturable days are complete UTC days still fully in Loggly, oldest first", () => {
  const days = capturableDays(NOW, 30);
  assert.equal(days.length, 29);
  assert.deepEqual([days[0], days.at(-1)], ["2026-10-01", "2026-10-29"]);
  assert.equal(capturableDays(Date.UTC(2026, 9, 30, 0, 10), 30).at(-1), "2026-10-28", "yesterday waits for indexing to settle");
  assert.deepEqual(capturableDays(NOW, 2), ["2026-10-29"]);
});

test("waiting days count complete days newer than the newest saved one, without requests", async () => {
  assert.equal(latestCompleteDay(NOW), "2026-10-29");
  assert.equal(latestCompleteDay(Date.UTC(2026, 9, 30, 0, 10)), "2026-10-28", "yesterday waits for indexing to settle");
  const dir = tempDir();
  const client = fakeClient();
  const recorder = new TrendRecorder(dir, { getClient: () => client, getRules: () => rules, now: () => NOW });
  assert.equal(await recorder.waitingDays(), undefined, "nothing saved yet");
  assert.equal(await new TrendRecorder(join(dir, "missing"), { getClient: () => client, getRules: () => rules }).waitingDays(), undefined);
  writeFileSync(join(dir, "2026-10-20.json"), "{}");
  writeFileSync(join(dir, "2026-10-22.json"), "{}");
  assert.equal(await recorder.waitingDays(), 7);
  writeFileSync(join(dir, "2026-10-29.json"), "{}");
  assert.equal(await recorder.waitingDays(), 0);
  assert.equal(client.calls.length + client.accounts, 0);
  assert.equal(recorder.retentionDays, undefined, "retention is known only after an update");
});

test("a captured day holds exact totals, systems and grouped messages from three full-day queries", async () => {
  const client = fakeClient();
  const day = await captureDay(client, rules, "2026-10-29", { now: NOW });
  assert.equal(client.calls.length, 3);
  for (const call of client.calls) {
    assert.equal((call.params.from as Date).toISOString(), "2026-10-29T00:00:00.000Z");
    assert.equal((call.params.until as Date).toISOString(), "2026-10-30T00:00:00.000Z");
    assert.equal(call.params.size, 300);
  }
  assert.deepEqual(client.calls.map((c) => [c.field, c.params.query]), [["app", "env:prod AND level:error"], ["app", "env:prod"], ["json.message", "env:prod AND level:error"]]);
  assert.deepEqual(day.totals, { events: 6000, errors: 70 });
  assert.deepEqual(day.systems, { api: { events: 5000, errors: 60 }, worker: { events: 1000, errors: 10 } });
  assert.equal(day.truncated, true);
  assert.deepEqual(day.messages, [
    { template: "Redis timeout after <n>ms", count: 60, example: "Redis timeout after 30ms" },
    { template: "Forbidden", count: 10, example: "Forbidden" },
  ]);
  assert.equal(day.messagesCovered, 70);
  assert.deepEqual(day.rules, { scope: "env:prod", groupBy: "app", errorQuery: "level:error", messageField: "json.message" });
});

test("a sampled day estimates the patterns of errors beyond the exact messages, and checks itself against exact counts", async () => {
  const day = await captureDay(sampledDayClient("2026-10-29"), { ...rules, groupBy: "app" }, "2026-10-29", { now: NOW, sampleWindows: 96, seed: 5 });
  const patterns = day.patterns!;
  assert.equal(patterns.errors, 8_000, "the errors outside the listed messages, exactly");
  assert.deepEqual(patterns.design, { windows: 96, windowMs: 185_143, seed: 5 });
  assert.deepEqual(patterns.rows.map((row) => row.template), ["Queue full id <n>", "disk full on /dev/sda<n>"], "listed messages are counted exactly, not estimated");
  const [queue, disk] = patterns.rows;
  assert.ok(Math.abs(queue!.estimate - 6_000) <= 1.96 * queue!.se + 1, `${queue!.estimate} ± ${queue!.se}`);
  assert.ok(Math.abs(disk!.estimate - 2_000) <= 1.96 * disk!.se + 1, `${disk!.estimate} ± ${disk!.se}`);
  assert.deepEqual(queue!.systems, [{ name: "worker", share: 1 }]);
  assert.ok(Math.abs(patterns.estimated.estimate - 8_000) <= 1.96 * patterns.estimated.se + 1);
  assert.equal(patterns.other, 0);
  assert.ok(patterns.check.checked >= 3, "systems and the listed message are checked");
  assert.equal(patterns.check.inside, patterns.check.checked);
  assert.deepEqual(patterns.check.misses, []);
  assert.equal(day.messagesCovered, 20_000);
  assert.equal((await captureDay(sampledDayClient("2026-10-29"), rules, "2026-10-29", { now: NOW })).patterns, undefined, "no sampling unless asked");
});

test("the recorder saves missing days privately, then makes no requests until a day completes", async () => {
  const dir = tempDir();
  writeFileSync(join(dir, "2026-10-05.json"), JSON.stringify({ version: 1, day: "2026-10-05", rules: trendRules(rules), totals: { events: 1, errors: 0 }, systems: {}, messages: [], messagesCovered: 0, truncated: false, collectedAt: "" }));
  const client = fakeClient();
  let now = NOW;
  const recorder = new TrendRecorder(dir, { getClient: () => client, getRules: () => rules, now: () => now });
  const [first, joined] = [recorder.update(), recorder.update()];
  assert.equal(first, joined, "concurrent updates in one process are joined");
  const update = await first;
  assert.equal(update.captured.length, 28, "the existing day is kept");
  assert.deepEqual([update.captured[0], update.captured.at(-1)], ["2026-10-01", "2026-10-29"]);
  assert.equal(update.stored.length, 29);
  assert.equal(client.calls.length, 28 * 3);
  assert.equal(statSync(join(dir, "2026-10-29.json")).mode & 0o777, 0o600);
  assert.ok(!readdirSync(dir).some((name) => name.endsWith(".tmp") || name === ".lock"), "no temporary files or lock left behind");

  const calls = client.calls.length;
  assert.deepEqual((await recorder.update()).captured, []);
  assert.equal(client.calls.length, calls);
  assert.equal(client.accounts, 1, "retention is asked once");

  now += 86_400_000;
  assert.deepEqual((await recorder.update()).captured, ["2026-10-30"]);
});

test("days saved with other rules or without patterns are saved again only when asked, keeping the earlier files", async () => {
  const dir = tempDir();
  const old = { version: 1, day: "2026-10-05", rules: { ...trendRules(rules), groupBy: "tag" }, totals: { events: 1, errors: 0 }, systems: {}, messages: [], messagesCovered: 0, truncated: false, collectedAt: "" };
  writeFileSync(join(dir, "2026-10-05.json"), JSON.stringify(old));
  writeFileSync(join(dir, "2026-10-06.json"), JSON.stringify({ ...old, day: "2026-10-06", rules: trendRules(rules) }));
  const client = fakeClient();
  let sampleWindows = 0;
  const recorder = new TrendRecorder(dir, { getClient: () => client, getRules: () => rules, getSampleWindows: () => sampleWindows, now: () => NOW });
  const background = await recorder.update();
  assert.equal(background.captured.length, 27, "in the background only missing days are saved");
  assert.equal(JSON.parse(readFileSync(join(dir, "2026-10-05.json"), "utf8")).rules.groupBy, "tag");

  const progress: string[] = [];
  const asked = await recorder.update(undefined, { replace: true, onProgress: ({ day, done, days }) => progress.push(`${day} ${done}/${days}`) });
  assert.deepEqual([asked.captured, asked.replaced], [["2026-10-05"], ["2026-10-05"]], "other rules: saved again; no sampling, so 10-06 is current");
  assert.deepEqual(progress, ["2026-10-05 0/1"]);
  assert.equal(JSON.parse(readFileSync(join(dir, "2026-10-05.json"), "utf8")).rules.groupBy, "app");
  const kept = readdirSync(join(dir, "replaced"));
  assert.equal(kept.length, 1);
  assert.match(kept[0]!, /^2026-10-05\.\d+\.json$/);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "replaced", kept[0]!), "utf8")), old, "the earlier file is kept as it was");
  assert.equal(statSync(join(dir, "replaced")).mode & 0o777, 0o700);
  assert.equal((await loadTrends(dir)).days.length, 29, "replaced/ is not read as days");

  sampleWindows = 20;
  rmSync(join(dir, "2026-10-07.json"));
  const quiet = await recorder.update(undefined, { sample: false });
  assert.deepEqual(quiet.captured, ["2026-10-07"]);
  assert.equal(JSON.parse(readFileSync(join(dir, "2026-10-07.json"), "utf8")).patterns, undefined, "updates that do not sample save exact counts only");
  assert.equal(client.searches, 0);
  const first = recorder.update(undefined, { sample: false });
  const second = recorder.update(undefined, { replace: true });
  assert.notEqual(first, second, "a replacing, sampling update follows a running one that does neither");
  assert.equal(recorder.update(), second, "and later updates join it");
  assert.equal(recorder.update(undefined, { sample: false }), second);
  assert.equal((await first).captured.length, 0, "the background update saves no missing days");
  const sampled = await second;
  assert.equal(sampled.captured.length, 29, "every day still in Loggly gains pattern estimates");
  assert.ok(client.searches > 0);
  assert.ok((await loadTrends(dir)).days.every((day) => day.patterns));
  assert.deepEqual((await recorder.update(undefined, { replace: true })).captured, [], "then nothing is due");
  assert.equal(existsSync(join(dir, ".lock")), false);
});

test("a fresh lock from another process makes the update busy; a stale one is taken over", async () => {
  const dir = tempDir();
  const lock = join(dir, ".lock");
  writeFileSync(lock, "12345\n");
  const client = fakeClient();
  const recorder = new TrendRecorder(dir, { getClient: () => client, getRules: () => rules, now: () => NOW });
  const busy = await recorder.update();
  assert.equal(busy.busy, true);
  assert.equal(client.calls.length, 0);
  const old = new Date(Date.now() - 60 * 60_000);
  utimesSync(lock, old, old);
  const taken = await recorder.update();
  assert.equal(taken.busy, false);
  assert.equal(taken.captured.length, 29);
});

test("saved days load oldest first; unreadable files are counted", async () => {
  const dir = tempDir();
  const client = fakeClient();
  writeFileSync(join(dir, "2026-10-02.json"), JSON.stringify(await captureDay(client, rules, "2026-10-02")));
  writeFileSync(join(dir, "2026-10-01.json"), JSON.stringify(await captureDay(client, rules, "2026-10-01")));
  writeFileSync(join(dir, "2026-10-03.json"), "{broken");
  writeFileSync(join(dir, "notes.txt"), "ignored");
  const loaded = await loadTrends(dir);
  assert.deepEqual(loaded.days.map((day) => day.day), ["2026-10-01", "2026-10-02"]);
  assert.equal(loaded.unreadable, 1);
  assert.deepEqual(await loadTrends(join(dir, "missing")), { days: [], unreadable: 0 });
});

function day(date: string, systems: Record<string, [number, number]>, messages: Record<string, number>, overrides: Partial<TrendDay> = {}): TrendDay {
  const entries = Object.entries(systems);
  return {
    version: 1,
    day: date,
    collectedAt: "",
    rules: trendRules(rules),
    totals: { events: entries.reduce((s, [, [e]]) => s + e, 0), errors: entries.reduce((s, [, [, x]]) => s + x, 0) },
    systems: Object.fromEntries(entries.map(([name, [events, errors]]) => [name, { events, errors }])),
    truncated: false,
    messages: Object.entries(messages).map(([template, count]) => ({ template, count, example: template.replace("<n>", "30") })),
    messagesCovered: Object.values(messages).reduce((a, b) => a + b, 0),
    ...overrides,
  };
}

/** 14 days: api errors triple in the second week, a redis message appears in the last three days. */
function fortnight(): TrendDay[] {
  return Array.from({ length: 14 }, (_, index) => {
    const date = new Date(Date.UTC(2026, 9, 16 + index)).toISOString().slice(0, 10);
    const late = index >= 7;
    const messages: Record<string, number> = { Forbidden: 50 };
    if (index >= 11) messages["Redis timeout after <n>ms"] = 200;
    return day(date, { api: [10_000, late ? 300 : 100], worker: [2_000, 50] }, messages);
  });
}

test("the trend report compares weeks, ranks growth and spots new messages", () => {
  const days = [...fortnight(), day("2026-10-01", { api: [1, 1] }, {}, { rules: { ...trendRules(rules), groupBy: "tag" } })];
  days.splice(3, 1); // 2026-10-19 was never saved.
  const { text, data } = formatTrendReport(days, trendRules(rules), { days: 14, top: 5, now: NOW });
  assert.match(text, /^Daily Loggly trends saved on this machine: 13 of 14 UTC days stored, 2026-10-16 to 2026-10-29\./);
  assert.match(text, /Days not saved: 2026-10-19\. \/loggly trends saves any that Loggly still keeps\./);
  assert.match(text, /All systems: errors 350\/day \(\+91%\) .*Changes compare the last 6 saved days vs the 6 before\./);
  assert.match(text, /Systems with the most errors:\n  api: 300\/day \(\+125%\) [▁-█]+\n  worker: 50\/day \(flat\)/);
  assert.match(text, /Systems whose errors grew most \(up 25% or more\):\n  api: .*\n\n/, "worker is flat, so not listed");
  assert.match(text, /Messages first saved in the last 6 days:\n  “Redis timeout after <n>ms”: 100\/day \(new\) [▁-█]+, first saved 2026-10-27/);
  assert.match(text, /cover the 300 most frequent exact messages each day, 36% of errors on average/);
  assert.doesNotMatch(text, /tag/, "days with other rules are not mixed in");
  assert.deepEqual((data.missing as string[]), ["2026-10-19"]);
});

/** Pattern estimates for a day: [template, estimate, standard error]. */
function withPatterns(record: TrendDay, rows: Array<[string, number, number]>, check = { checked: 20, inside: 19 }, heldExact = true): TrendDay {
  const errors = record.totals.errors - record.messagesCovered;
  return {
    ...record,
    patterns: {
      design: { windows: 288, windowMs: 60_000, seed: 1 },
      errors,
      sampled: 500,
      rows: rows.map(([template, estimate, se]) => ({ template, estimate, se, windows: 40, example: template.replace("<n>", "7"), systems: [{ name: "worker", share: 0.8 }, { name: "api", share: 0.2 }] })),
      other: 10,
      estimated: { estimate: heldExact ? errors : errors * 3, se: 5 },
      check: { ...check, misses: [] },
    },
  };
}

test("the trend report lists estimated patterns with intervals, and growth only beyond sampling error", () => {
  // Queue doubles: well beyond its error. Disk grows 40%, within its error.
  const days = fortnight().map((record, index) => withPatterns(record, [["Queue full id <n>", index >= 7 ? 2000 : 1000, 100], ["Disk <path> full", index >= 7 ? 700 : 500, 200]], undefined, index !== 13));
  const { text, data } = formatTrendReport(days, trendRules(rules), { days: 14, top: 5, now: NOW });
  assert.match(text, /Estimated error patterns among errors outside the exact messages \(\d+% of errors\), per day on the last 7 sampled days where each could be estimated, with 95% intervals:\n  ≈2k ±74  “Queue full id <n>” \(7 of 7 days; worker 80%, api 20%\)\n  ≈700 ±148  “Disk <path> full”/);
  assert.match(text, /Estimated patterns that grew 25% or more, beyond their sampling error:\n  “Queue full id <n>”: ≈2k\/day, was ≈1k \(\+100%\)\n\n/, "Disk grew 40%, within its sampling error");
  assert.match(text, /\n\nThe patterns estimated each day account for about 100% of those errors; the rest are in patterns too rare or uneven to estimate\.\nEach day was sampled in 288 random windows\. Checked against exact counts on these days: 133 of 140 intervals held the exact count \(about 95% expected\), and 6 of 7 held the exact number of errors outside the exact messages\. Patterns that come in short bursts can be missed or underestimated\./);
  assert.doesNotMatch(text, /Patterns are estimated on/);
  assert.deepEqual((data.patterns as Array<{ template: string; perDay: number; margin: number }>).map((p) => [p.template, p.perDay, p.margin]), [["Queue full id <n>", 2000, 74], ["Disk <path> full", 700, 148]]);

  const partly = formatTrendReport([...fortnight().slice(0, 10), ...days.slice(10)], trendRules(rules), { days: 14, top: 5, now: NOW }).text;
  assert.match(partly, /on the last 4 sampled days/);
  assert.match(partly, /Patterns are estimated on 4 of 14 days; \/loggly trends adds them to days Loggly still keeps\./);
  assert.match(formatTrendReport(fortnight(), trendRules(rules), { days: 14, top: 5, now: NOW }).text, /Error patterns beyond the exact messages are not estimated on these days\. Set trends\.sampleWindows/);

  const message = formatTrendReport(days, trendRules(rules), { days: 14, top: 5, now: NOW, message: "queue" }).text;
  assert.match(message, /Estimated patterns matching it, among errors outside the exact messages \(95% intervals; – means not estimated that day\):\n  “Queue full id <n>”\n    daily: 10-16 ≈1k ±196, .*10-29 ≈2k ±196/);
});

test("the trend report says its first day is where saving began, and which missing days Loggly has deleted", () => {
  // Saved on 2026-10-30 when Loggly kept 30 days: 2026-10-01 was the oldest day it still had.
  const saved = (date: string, collectedAt = "2026-10-30T11:58:00.000Z") => day(date, { api: [1000, 100] }, { Forbidden: 50 }, { collectedAt });
  const days = Array.from({ length: 29 }, (_, i) => saved(isoDay(Date.UTC(2026, 9, 1 + i)))).filter((d) => !["2026-10-03", "2026-10-25"].includes(d.day));
  // Five days later, 2026-10-03 has left Loggly too, but 2026-10-25 can still be saved.
  const later = Date.UTC(2026, 10, 4, 10);
  const { text, data } = formatTrendReport(days, trendRules(rules), { days: 40, top: 5, now: later, retentionDays: 30 });
  assert.match(text, /\nThe series starts on 2026-10-01 because that was the oldest day Loggly still kept when it was saved, on 2026-10-30 \(Loggly keeps 30 days\)\. Earlier days are unknown, not zero: anything already present on 2026-10-01 may have begun before it\.\n/);
  assert.match(text, /\nDays not saved before Loggly deleted them \(it keeps 30 days\), so unknown rather than zero: 2026-10-03\.\n/);
  assert.match(text, /\nDays not saved yet: 2026-10-25, 2026-10-30 to 2026-11-03\. \/loggly trends saves them while Loggly keeps them\.\n/);
  assert.match(text, /“Forbidden”: .*, first saved 2026-10-01, the oldest saved day, so it may be older/);
  assert.deepEqual([data.oldestSaved, data.deleted], ["2026-10-01", ["2026-10-03"]]);

  // Saved long after the day itself, and with retention unknown: no claim about why.
  const unknown = formatTrendReport(days, trendRules(rules), { days: 40, top: 5, now: later }).text;
  assert.match(unknown, /\nThe series starts on 2026-10-01, the oldest saved day\. Earlier days are unknown, not zero/);
  assert.match(unknown, /\nDays not saved: 2026-09-25 to 2026-09-30, 2026-10-03, 2026-10-25, 2026-10-30 to 2026-11-03\. \/loggly trends saves any that Loggly still keeps\./);
  // A shorter window that starts after the oldest saved day needs no such line.
  assert.doesNotMatch(formatTrendReport(days, trendRules(rules), { days: 7, top: 5, now: later, retentionDays: 30 }).text, /The series starts/);
});

test("the trend report shows one system's days or matching messages", () => {
  const system = formatTrendReport(fortnight(), trendRules(rules), { days: 14, top: 5, now: NOW, system: "api" }).text;
  assert.match(system, /api: errors 300\/day \(\+200%\)/);
  assert.match(system, /  2026-10-29 +10k +300 +3%/);
  const message = formatTrendReport(fortnight(), trendRules(rules), { days: 14, top: 5, now: NOW, message: "redis" }).text;
  assert.match(message, /Error messages matching “redis”:\n  “Redis timeout after <n>ms”: .*first saved 2026-10-27\n    daily: 10-16 0, .*10-29 200/);
  const none = formatTrendReport([], trendRules(rules), { days: 30, top: 5, now: NOW }).text;
  assert.match(none, /0 of 30 UTC days stored\.\nRun \/loggly trends/);
});

test("result files are private and deleted after a day; other files are left alone", async () => {
  const dir = join(tempDir(), "results");
  const path = await writeResultFile(dir, "search", ['{"a":1}']);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(readFileSync(path, "utf8"), '{"a":1}\n');
  const old = join(dir, "search-2026-10-01T00-00-00-000Z-abcd1234.jsonl");
  const unrelated = join(dir, "keep-me.txt");
  writeFileSync(old, "{}\n");
  writeFileSync(unrelated, "x");
  const twoDaysAgo = new Date(Date.now() - 48 * 3_600_000);
  utimesSync(old, twoDaysAgo, twoDaysAgo);
  utimesSync(unrelated, twoDaysAgo, twoDaysAgo);
  assert.equal(await pruneResults(dir), 1);
  assert.deepEqual(readdirSync(dir).sort(), [path.split("/").at(-1), "keep-me.txt"].sort());
});

test("a results directory others can access is refused", async () => {
  const dir = tempDir();
  chmodSync(dir, 0o755);
  await assert.rejects(writeResultFile(dir, "search", ["{}"]), /Refusing to write log data/);
  assert.equal(await pruneResults(dir), 0);
});
