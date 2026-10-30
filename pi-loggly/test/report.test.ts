import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync as makeTemp, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { registerLoggly } from "../index.ts";
import { DEFAULT_HEALTH_RULES, type HealthRules } from "../src/analysis/health.ts";
import { analyzePeriod, finalSilence, formatSpan } from "../src/reporting/analyze.ts";
import { bucketSize, collectPeriod, planReport } from "../src/reporting/collect.ts";
import { generateReport, plannedRequests, writeReport } from "../src/reporting/generate.ts";
import { browserPrinter, findBrowser, PdfError } from "../src/reporting/pdf.ts";
import { formatRange, renderHtml, renderMarkdown } from "../src/reporting/render.ts";
import { parseTimeframe, TimeframeError } from "../src/reporting/timeframe.ts";
import type { FacetParams, FacetResult, IterateParams, LogEvent, SearchParams } from "../src/sdk/types.ts";

// Local times are London's: summer time ended on 2026-10-25.
process.env.TZ = "Europe/London";

const temps: string[] = [];
function tempDir(prefix = "pi-loggly-report-test-"): string {
  const dir = makeTemp(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

/** Friday 30 October 2026, 11:41 (GMT, so UTC). */
const NOW = Date.UTC(2026, 9, 30, 11, 41);
const iso = (date: Date | number) => new Date(date).toISOString().replace(":00.000Z", "Z");
const rules: HealthRules = { ...DEFAULT_HEALTH_RULES, messageFields: ["json.message"] };

test("timeframes in words: rolling lengths, calendar days, since and ranges, in local time", () => {
  const parse = (text: string) => {
    const t = parseTimeframe(text, new Date(NOW));
    return [iso(t.from), iso(t.until), t.label, t.rolling ?? false];
  };
  assert.deepEqual(parse(""), ["2026-10-29T11:41Z", "2026-10-30T11:41Z", "last 24 hours", true], "the default");
  assert.deepEqual(parse("'last 2h'"), ["2026-10-30T09:41Z", "2026-10-30T11:41Z", "last 2 hours", true], "quotes are ignored");
  assert.deepEqual(parse("over the past 90 mins"), ["2026-10-30T10:11Z", "2026-10-30T11:41Z", "last 90 minutes", true]);
  assert.deepEqual(parse("Last Week"), ["2026-10-23T11:41Z", "2026-10-30T11:41Z", "last week", true]);
  assert.deepEqual(parse("today"), ["2026-10-30T00:00Z", "2026-10-30T11:41Z", "today", false]);
  assert.deepEqual(parse("yesterday"), ["2026-10-29T00:00Z", "2026-10-30T00:00Z", "yesterday", false]);
  assert.deepEqual(parse("since 9am"), ["2026-10-30T09:00Z", "2026-10-30T11:41Z", "since 9am", false]);
  assert.deepEqual(parse("since 2pm").slice(0, 2), ["2026-10-29T14:00Z", "2026-10-30T11:41Z"], "a time later today means yesterday's");
  assert.deepEqual(parse("since monday").slice(0, 2), ["2026-10-26T00:00Z", "2026-10-30T11:41Z"]);
  assert.deepEqual(parse("this week").slice(0, 2), ["2026-10-26T00:00Z", "2026-10-30T11:41Z"]);
  assert.deepEqual(parse("2026-10-28 09:00 to 12:00").slice(0, 2), ["2026-10-28T09:00Z", "2026-10-28T12:00Z"]);
  assert.deepEqual(parse("yesterday 9am to 5pm").slice(0, 2), ["2026-10-29T09:00Z", "2026-10-29T17:00Z"]);
  assert.deepEqual(parse("2026-10-24 to 2026-10-25").slice(0, 2), ["2026-10-23T23:00Z", "2026-10-26T00:00Z"], "local midnights across the clock change");
  assert.deepEqual(parse("since 3 hours ago").slice(0, 2), ["2026-10-30T08:41Z", "2026-10-30T11:41Z"]);

  assert.throws(() => parseTimeframe("banana", new Date(NOW)), (error: Error) => error instanceof TimeframeError && /^Could not read "banana" as a timeframe\. Try last 2h,/.test(error.message));
  assert.throws(() => parseTimeframe("9", new Date(NOW)), /Could not read "9"/, "a bare number is not a time");
  assert.throws(() => parseTimeframe("2026-11-02", new Date(NOW)), /starts in the future/);
  assert.throws(() => parseTimeframe("since 25:00", new Date(NOW)), /Could not read/);
});

test("plans keep the requested length, end at indexed data, and compare like with like", () => {
  assert.deepEqual([2, 24, 24 * 7, 24 * 30].map((hours) => bucketSize(hours * 3_600_000) / 60_000), [5, 60, 360, 1440]);
  const plan = (text: string, retentionDays = 30) => planReport(parseTimeframe(text, new Date(NOW)), rules, NOW, retentionDays);

  const twoHours = plan("last 2h");
  assert.deepEqual([iso(twoHours.from), iso(twoHours.until), twoHours.buckets.length, twoHours.bucketMs / 60_000], ["2026-10-30T09:39Z", "2026-10-30T11:39Z", 24, 5]);
  assert.deepEqual([iso(twoHours.buckets[1]!.from), iso(twoHours.buckets.at(-1)!.until)], ["2026-10-30T09:44Z", "2026-10-30T11:39Z"], "periods count back from the newest indexed minute");
  assert.deepEqual([iso(twoHours.previous!.from), iso(twoHours.previous!.until), twoHours.previousLabel], ["2026-10-30T07:39Z", "2026-10-30T09:39Z", "the previous 2 hours"]);
  assert.deepEqual(twoHours.notes, ["Ends 2m ago, at 11:39: Loggly needs about 2m to index new logs."]);

  const today = plan("today");
  assert.deepEqual([iso(today.from), iso(today.until), today.bucketMs / 60_000], ["2026-10-30T00:00Z", "2026-10-30T11:30Z", 30]);
  assert.deepEqual([iso(today.previous!.from), iso(today.previous!.until), today.previousLabel], ["2026-10-29T00:00Z", "2026-10-29T11:30Z", "the same hours a day earlier"]);

  const yesterday = plan("yesterday");
  assert.deepEqual([iso(yesterday.previous!.from), yesterday.previousLabel, yesterday.notes], ["2026-10-28T00:00Z", "the previous day", []], "a whole day compares with the day before");

  const week = plan("last 7 days", 3);
  assert.equal(week.previous, undefined);
  assert.deepEqual(week.notes, ["Loggly keeps 3 days of logs, so the report starts at the oldest data it still has.", "Ends 2m ago, at 11:39: Loggly needs about 2m to index new logs.", "No comparison with an earlier period: Loggly no longer has it."]);
  assert.deepEqual([iso(week.from), week.buckets.length, week.bucketMs / 3_600_000], ["2026-10-27T14:39Z", 23, 3], "whole periods inside retention");
  assert.ok(week.from >= NOW - 3 * 86_400_000 + 3_600_000);
  assert.equal(today.notes[0], "Ends at 11:30, 11m ago: the end of the last complete period of 30 minutes with indexed logs.", "calendar timeframes keep round periods");

  assert.throws(() => plan("since 11:40"), /too short: Loggly needs 2m to index new logs/);
});

test("spans and ranges read naturally", () => {
  assert.deepEqual([3_600_000, 5 * 60_000, 695 * 60_000, 2 * 86_400_000, 54 * 3_600_000].map(formatSpan), ["1 hour", "5 minutes", "11 hours 35 minutes", "2 days", "2 days 6 hours"]);
  assert.equal(formatRange(Date.UTC(2026, 9, 30, 9, 35), Date.UTC(2026, 9, 30, 11, 35)), "Fri 30 Oct 2026, 09:35–11:35");
  assert.equal(formatRange(Date.UTC(2026, 9, 29), Date.UTC(2026, 9, 30)), "Thu 29 Oct 2026");
  assert.equal(formatRange(Date.UTC(2026, 9, 23, 23), Date.UTC(2026, 9, 26)), "Sat 24 Oct 2026 – Sun 25 Oct 2026");
});

test("a system is stopped only when its final silence is longer than its earlier gaps", () => {
  assert.deepEqual(finalSilence([500, 400, 600, 0, 0]), { length: 2, events: 0, longestEarlierGap: 0 });
  assert.deepEqual(finalSilence([500, 2, 600, 500, 2, 1]), { length: 2, events: 3, longestEarlierGap: 1 }, "near zero counts as silent");
  assert.deepEqual(finalSilence([500, 0, 0, 0, 600, 0, 0]).longestEarlierGap, 3);
  assert.equal(finalSilence([500, undefined, 400]).length, 0, "unknown is not silent");
});

const BUCKET = 5 * 60_000;
const facet = (field: string, terms: Record<string, number>, total?: number): FacetResult => {
  const list = Object.entries(terms)
    .filter(([, count]) => count > 0)
    .map(([term, count]) => ({ term, count }))
    .sort((a, b) => b.count - a.count);
  return { field, totalEvents: total ?? list.reduce((sum, t) => sum + t.count, 0), uniqueCount: list.length, terms: list, truncated: false };
};
const event = (id: string, app: string, message: string, timestamp: number): LogEvent => ({ id, timestamp, logmsg: "", tags: [], logtypes: ["json"], event: { syslog: { appName: app }, json: { message } } });
const SCRIPT_MESSAGE = "<script>alert(1)</script> | failed";
const at = (hours: number, minutes: number) => Date.UTC(2026, 9, 30, hours, minutes);

/**
 * Loggly for "last 2h" at NOW: api bursts at 11:15, worker stops at 11:15,
 * billing is new, and two error messages are new.
 */
function scriptedClient() {
  const plan = planReport(parseTimeframe("last 2h", new Date(NOW)), rules, NOW, 30);
  const calls: Array<{ method: string; field?: string; from: number; until: number; query?: string }> = [];
  const client = {
    subdomain: "acme",
    calls,
    async account() {
      calls.push({ method: "account", from: 0, until: 0 });
      return { subdomain: "acme", retentionDays: 30 };
    },
    searchUrl: (params: SearchParams = {}) => `https://acme.loggly.com/search/?terms=${encodeURIComponent(params.query ?? "*")}`,
    async facet(field: string, params: FacetParams): Promise<FacetResult> {
      const from = (params.from as Date).getTime();
      const until = (params.until as Date).getTime();
      calls.push({ method: "facet", field, from, until, query: params.query });
      const errors = String(params.query).includes("syslog.severity");
      if (field === "json.message") {
        return from === plan.from
          ? facet(field, { "Card declined for order 123": 700, "Redis timeout after 30ms": 300, "Redis timeout after 45ms": 200, [SCRIPT_MESSAGE]: 200 })
          : facet(field, { "Redis timeout after 10ms": 100 });
      }
      if (from === plan.previous!.from) return errors ? facet(field, { api: 240 }) : facet(field, { api: 24_000, worker: 12_000 });
      const i = Math.round((from - plan.from) / BUCKET);
      if (errors) return facet(field, { api: i === 20 ? 400 : 10, billing: 30 });
      return facet(field, { api: 1000, worker: i < 20 ? 500 : 0, billing: 100 });
    },
    async search(params: IterateParams, options: { limit: number }) {
      const from = (params.from as Date).getTime();
      calls.push({ method: "search", from, until: (params.until as Date).getTime(), query: params.query });
      return [event(`a${from}`, "api", "Redis timeout after 30ms", from + 1000), event(`b${from}`, "billing", "Card declined for order 9", from + 2000)].slice(0, options.limit);
    },
  };
  return { client, plan };
}

test("collecting fetches each period, the comparison and a sample, as planned", async () => {
  const { client, plan } = scriptedClient();
  const progress: number[] = [];
  const data = await collectPeriod(client, rules, plan, { onProgress: (done, total) => progress.push(total - done) });
  assert.equal(client.calls.length, plannedRequests(plan, rules));
  assert.equal(client.calls.length, 24 * 3 + 1 + 3);
  assert.equal(progress.at(-1), 0, "progress ends at the total");
  assert.equal(data.buckets.length, 24);
  assert.equal(data.buckets[0]!.sample.length, 2);
  assert.deepEqual(data.previous!.errors.terms, [{ term: "api", count: 240 }]);
});

async function scriptedModel() {
  const { client, plan } = scriptedClient();
  const data = await collectPeriod(client, rules, plan);
  return analyzePeriod(data, rules, { subdomain: "acme", generatedAt: NOW, searchUrl: client.searchUrl });
}

test("findings: a stopped system, a new one, a burst and new messages, most pressing first", async () => {
  const model = await scriptedModel();
  const kinds = model.findings.map((f) => `${f.severity} ${f.kind} ${f.system ?? ""}`.trim());
  assert.deepEqual(kinds, [
    "critical stopped worker",
    "warning errors",
    "warning new-system billing",
    "warning new-message",
    "warning burst api",
    "warning new-message",
    "notice chronic billing",
  ], "720 new errors in 2 hours is a warning: critical needs ten times the scaled minimum of 173");
  const byKind = (kind: string) => model.findings.find((f) => f.kind === kind)!;
  assert.equal(byKind("stopped").detail, "No events since 11:19; it usually logs about 500 per 5 minutes.");
  assert.equal(byKind("new-system").detail, "720 errors; none in the previous 2 hours. Peak 30 at 09:39.");
  assert.equal(byKind("burst").title, "api error burst at 11:19");
  assert.equal(byKind("errors").title, "Errors up 463%");
  assert.equal(model.findings.filter((f) => f.kind === "new-message")[0]!.title, "New error message: “Card declined for order <n>”");
  assert.match(byKind("burst").url!, /^https:\/\/acme\.loggly\.com\/search\//);

  assert.deepEqual([model.totals.events, model.totals.errors, model.totals.previous!.errors], [36_400, 1_350, 240]);
  assert.deepEqual(model.topSystems, ["billing", "api"]);
  assert.deepEqual(model.peak, { from: at(11, 19), until: at(11, 24), errors: 430, usual: 40 });
  assert.equal(model.rules.minErrors, 173);
  assert.deepEqual(model.systems.find((s) => s.name === "worker")!.flags, ["stopped"]);
  assert.equal(model.messages!.covered, 1400);
  assert.deepEqual(model.messages!.rows.map((r) => [r.template, r.count, r.isNew]), [
    ["Card declined for order <n>", 700, true],
    ["Redis timeout after <n>ms", 500, false],
    ["<script>alert(<n>)</script> | failed", 200, true],
  ]);
  assert.deepEqual(model.patterns.rows.map((r) => [r.template, r.estimate, r.systems[0]!.name]), [
    ["Redis timeout after <n>ms", 675, "api"],
    ["Card declined for order <n>", 675, "billing"],
  ], "estimates weight each period's sample by its errors");
  assert.equal(model.patterns.sampled, 48);
});

test("Markdown and HTML say the same, escape log text, and link to Loggly", async () => {
  const model = await scriptedModel();
  const markdown = renderMarkdown(model);
  assert.match(markdown, /^# Loggly report: Last 2 hours\n\n\*\*acme\*\* · Fri 30 Oct 2026, 09:39–11:39 \(Europe\/London\) · compared with the previous 2 hours {2}\n/);
  assert.match(markdown, /\n## Needs attention\n\n36k events and 1\.4k errors \(3\.7% of events\) from 3 systems, 2 with errors\. Compared with the previous 2 hours, errors are up 463% and events about the same\. Errors peaked at 11:19 with 430 in 5 minutes, against a usual 40\./);
  assert.match(markdown, /\n- \*\*Critical\*\* · \[worker stopped logging\]\(https:\/\/acme\.loggly\.com\/search\/\?terms=[^)]+\): No events since 11:19/);
  assert.match(markdown, /New error message: “\\<script\\>alert\(\\<n\\>\)\\<\/script\\> \\\| failed”/, "log text in prose is escaped");
  assert.match(markdown, /\| `<script>alert\(<n>\)<\/script> \\\| failed` \| 200 \|/, "templates are code, with pipes escaped for tables");
  assert.doesNotMatch(markdown, /\]\([^)]*\([^)]*\)/, "link targets have no raw parentheses");
  assert.match(markdown, /## Error patterns \(estimated\)\n\nAll errors, grouped by pattern, estimated from 48 errors/);

  const html = renderHtml(model, { exports: { markdown: "report.md", pdf: "report.pdf" } });
  assert.match(html, /^<!doctype html>/);
  assert.doesNotMatch(html, /<script>alert/, "log text is escaped");
  assert.match(html, /&lt;script&gt;alert\(&lt;n&gt;\)&lt;\/script&gt; \| failed/);
  assert.match(html, /<section class="verdict attention"><h2>Needs attention<\/h2>/);
  assert.match(html, /Also saved as <a href="report\.md">Markdown<\/a> and <a href="report\.pdf">PDF<\/a>/);
  assert.match(html, /<svg viewBox="0 0 960 260" role="img" aria-label="Errors per 5 minutes"/);
  assert.match(html, /class="previous"\/><text[^>]*>previous average<\/text>/);
  assert.equal((html.match(/<li class="finding /g) ?? []).length, model.findings.length);
  assert.doesNotMatch(html, /https?:\/\/(?!acme\.loggly\.com)/, "no outside resources or links");
});

test("reports are written privately; a failed PDF leaves HTML and Markdown and says why", async () => {
  const model = await scriptedModel();
  const root = join(tempDir(), "reports");
  const printed: string[] = [];
  const ok = await writeReport(model, root, {
    printPdf: async (html, pdf) => {
      printed.push(readFileSync(html, "utf8").slice(0, 15));
      writeFileSync(pdf, "%PDF-1.4");
    },
  });
  assert.equal(ok.dir, join(root, "2026-10-30-1141-last-2-hours"));
  assert.deepEqual(readdirSync(ok.dir).sort(), ["report.html", "report.md", "report.pdf"]);
  assert.deepEqual(printed, ["<!doctype html>"], "the PDF is printed from the finished HTML");
  assert.equal(statSync(root).mode & 0o777, 0o700);
  assert.equal(statSync(ok.dir).mode & 0o777, 0o700);
  for (const file of [ok.html, ok.markdown]) assert.equal(statSync(file).mode & 0o777, 0o600);

  const failed = await writeReport(model, root, {
    printPdf: async () => {
      throw new PdfError("no Chromium, Chrome, Edge or Brave found; set PI_LOGGLY_BROWSER to one");
    },
  });
  assert.equal(failed.dir, join(root, "2026-10-30-1141-last-2-hours-2"), "a second report that minute gets its own directory");
  assert.deepEqual(readdirSync(failed.dir).sort(), ["report.html", "report.md"]);
  assert.equal(failed.pdf, undefined);
  assert.match(failed.pdfError!, /^no Chromium/);
  assert.doesNotMatch(readFileSync(failed.html, "utf8"), /report\.pdf/);
  assert.equal((await writeReport(model, root, { printPdf: null })).pdfError, "PDF export is off");

  const open = tempDir();
  chmodSync(open, 0o755);
  await assert.rejects(writeReport(model, open), /Refusing to write reports .* mode 700/);
});

test("PDFs are printed by a headless browser found on PATH or named in the environment", async () => {
  const bin = tempDir();
  const browser = join(bin, "chromium");
  // Writes a PDF to the --print-to-pdf path, like the real thing.
  writeFileSync(browser, '#!/bin/sh\nfor a in "$@"; do case "$a" in --print-to-pdf=*) printf "%%PDF-1.4 %s" "$*" > "${a#--print-to-pdf=}";; esac; done\n', { mode: 0o755 });
  assert.equal(findBrowser({ PATH: `relative:${bin}` }), browser);
  assert.equal(findBrowser({ PATH: bin, PI_LOGGLY_BROWSER: "/opt/edge" }), "/opt/edge");
  assert.equal(findBrowser({ PATH: tempDir() }), undefined);

  const dir = tempDir();
  const html = join(dir, "report.html");
  writeFileSync(html, "<!doctype html><p>hi</p>");
  await browserPrinter({ browser })(html, join(dir, "report.pdf"));
  const pdf = readFileSync(join(dir, "report.pdf"), "utf8");
  assert.match(pdf, /^%PDF-1\.4 --headless .*--no-pdf-header-footer --user-data-dir=\S+ --print-to-pdf=\S+ file:\/\/\S+report\.html$/);
  assert.equal(statSync(join(dir, "report.pdf")).mode & 0o777, 0o600);
  const profile = /--user-data-dir=(\S+)/.exec(pdf)![1]!;
  assert.equal(existsSync(profile), false, "the throwaway browser profile is deleted");

  const failing = join(bin, "broken");
  writeFileSync(failing, "#!/bin/sh\necho 'cannot open display' >&2\nexit 3\n", { mode: 0o755 });
  await assert.rejects(browserPrinter({ browser: failing })(html, join(dir, "x.pdf")), /broken could not print the report: cannot open display/);
  const silent = join(bin, "silent");
  writeFileSync(silent, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await assert.rejects(browserPrinter({ browser: silent })(html, join(dir, "y.pdf")), /did not write a PDF/);
  await assert.rejects(browserPrinter({ browser: join(bin, "missing") })(html, join(dir, "z.pdf")), PdfError);
});

test("generateReport asks Loggly's retention only when it is not known", async () => {
  const { client } = scriptedClient();
  const report = await generateReport({ client, rules, timeframe: "last 2h", dir: join(tempDir(), "reports"), now: NOW, printPdf: null });
  assert.equal(client.calls.filter((c) => c.method === "account").length, 1);
  assert.equal(report.model.label, "last 2 hours");
  const known = scriptedClient().client;
  await generateReport({ client: known, rules, timeframe: "last 2h", dir: join(tempDir(), "reports"), now: NOW, retentionDays: 30, printPdf: null });
  assert.equal(known.calls.filter((c) => c.method === "account").length, 0);
});

function fakePi() {
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void>; getArgumentCompletions: (prefix: string) => Array<{ value: string }> }>();
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  const pi = {
    registerTool: () => {},
    registerCommand: (name: string, command: never) => commands.set(name, command),
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
  };
  const emit = async (event: string, ctx: unknown) => {
    for (const handler of handlers.get(event) ?? []) await handler({ type: event }, ctx);
  };
  return { pi: pi as never, commands, emit };
}

function fakeCtx() {
  const statuses: Array<[string, string | undefined]> = [];
  const notes: Array<{ message: string; type?: string }> = [];
  const ctx = { mode: "tui", hasUI: true, ui: { setStatus: (key: string, text: string | undefined) => statuses.push([key, text]), notify: (message: string, type?: string) => notes.push({ message, type }) } };
  return { ctx, statuses, notes };
}

async function eventually(check: () => boolean) {
  for (let i = 0; i < 500 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(check(), "condition not reached");
}

test("/loggly report makes a report in the background, shows progress and says where it is", async () => {
  const dir = tempDir();
  const reportsDir = join(dir, "reports");
  const { client } = scriptedClient();
  const { pi, commands, emit } = fakePi();
  registerLoggly(pi, {
    configPath: join(dir, "loggly.json"),
    env: { LOGGLY_SUBDOMAIN: "acme", LOGGLY_API_TOKEN: "t" },
    createClient: () => client as never,
    trendsDir: join(dir, "trends"),
    resultsDir: join(dir, "results"),
    reportsDir,
    printPdf: async (_html, pdf) => writeFileSync(pdf, "%PDF-1.4"),
  });
  const { ctx, statuses, notes } = fakeCtx();
  await emit("session_start", ctx);
  const loggly = commands.get("loggly")!;
  const complete = (prefix: string) => loggly.getArgumentCompletions(prefix).map((c) => c.value);
  assert.deepEqual(complete("rep"), ["report", "report last 2h", "report last 24 hours", "report today", "report yesterday", "report since 9am", "report last 7 days"]);
  assert.deepEqual(complete("report y"), ["report yesterday"]);

  await loggly.handler("report banana", ctx);
  assert.match(notes.at(-1)!.message, /^Could not read "banana" as a timeframe/);
  assert.equal(notes.at(-1)!.type, "warning");

  await loggly.handler("report 'Last 2h'", ctx);
  assert.equal(notes.at(-1)!.message, "Making a Loggly report (last 2 hours) in the background. It takes under a minute for a day; a notification follows.");
  await loggly.handler("report", ctx);
  assert.equal(notes.at(-1)!.message, "A Loggly report (last 2 hours) is still being made; a notification follows when it is ready.");
  await eventually(() => notes.some((note) => note.message.startsWith("Loggly report ready")));
  const ready = notes.find((note) => note.message.startsWith("Loggly report ready"))!;
  const [reportDir] = readdirSync(reportsDir);
  assert.match(ready.message, new RegExp(`^Loggly report ready \\(last 2 hours\\)\\. Needs attention: \\d+ findings\\.\\nHTML: ${reportsDir}/${reportDir}/report\\.html\\nPDF: .*report\\.pdf\\nMarkdown: .*report\\.md$`));
  assert.equal(ready.type, "warning", "critical findings raise the notification");
  assert.ok(existsSync(join(reportsDir, reportDir!, "report.pdf")));
  assert.ok(statuses.some(([key, text]) => key === "loggly-report" && /^loggly report \d+%$/.test(text!)));
  assert.deepEqual(statuses.at(-1), ["loggly-report", undefined], "progress is cleared");

  await loggly.handler("report", ctx);
  assert.match(notes.at(-1)!.message, /^Making a Loggly report \(last 24 hours, the default; add a timeframe such as last 2h or yesterday\)/);
  await emit("session_shutdown", ctx);
});
