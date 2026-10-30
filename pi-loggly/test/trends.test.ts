import assert from "node:assert/strict";
import { chmodSync, mkdtempSync as makeTemp, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { DEFAULT_HEALTH_RULES, type HealthRules } from "../src/analysis/health.ts";
import { pruneResults, writeResultFile } from "../src/results.ts";
import type { FacetParams, FacetResult } from "../src/sdk/types.ts";
import { capturableDays, captureDay, formatTrendReport, latestCompleteDay, loadTrends, TrendRecorder, trendRules, type TrendDay } from "../src/trends.ts";

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
