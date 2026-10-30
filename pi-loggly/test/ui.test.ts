import assert from "node:assert/strict";
import { mkdtempSync as makeTemp, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { DEFAULT_HEALTH_RULES, evaluateHealth, type HealthRules, type HealthSnapshot, type WindowCounts } from "../src/analysis/health.ts";
import { DEFAULT_CONFIG, loadConfig, normalizeConfig, section, updateConfigFile } from "../src/config.ts";
import { investigationPrompt, LogglyDashboard, type DashboardDeps } from "../src/dashboard.ts";
import { HealthMonitor } from "../src/monitor.ts";
import { formatHealthReport } from "../src/report.ts";
import { formatStatusLine, STATUS_KEY, StatusLine, statusRow } from "../src/status.ts";
import type { FacetParams, FacetResult, LogEvent } from "../src/sdk/types.ts";
import { trendRules, type TrendDay } from "../src/trends.ts";

const temps: string[] = [];
/** A temporary directory removed after the tests. */
function mkdtempSync(prefix: string): string {
  const dir = makeTemp(prefix);
  temps.push(dir);
  return dir;
}
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text };
const KEYS: Record<string, string> = { "tui.select.up": "\x1b[A", "tui.select.down": "\x1b[B", "tui.select.confirm": "\r", "tui.select.cancel": "\x1b" };
const keybindings = { matches: (data: string, id: string) => KEYS[id] === data };
const rules: HealthRules = { ...DEFAULT_HEALTH_RULES, scope: "env:prod", groupBy: "app", errorQuery: "level:error", baselineWindows: 4, lag: "2m" };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
/** Rendered lines without the overlay's trailing padding. */
const screen = (lines: string[]) => lines.map((line) => line.trimEnd()).join("\n");

function facet(counts: Record<string, number>): FacetResult {
  const terms = Object.entries(counts).filter(([, n]) => n > 0).map(([term, count]) => ({ term, count }));
  return { field: "app", totalEvents: terms.reduce((s, t) => s + t.count, 0), uniqueCount: terms.length, terms, truncated: false };
}

/** A fake client whose current window (the latest `from`) has `current` errors per system. */
function fakeClient(current: Record<string, number>, options: { failFacet?: boolean } = {}) {
  let facets = 0;
  /** Queries whose messages were counted or read. */
  const searches: string[] = [];
  return {
    /** Facets of the health check, not of messages. */
    get facets() {
      return facets;
    },
    searches,
    subdomain: "acme",
    async count() {
      return { count: 1 };
    },
    async facet(field: string, params: FacetParams) {
      await tick();
      if (field === "json.message") {
        searches.push(params.query ?? "*");
        return { ...facet({ "db timeout after 30s": 1 }), field };
      }
      facets++;
      if (options.failFacet) throw new Error("Loggly API request failed with HTTP 503");
      // The current window ends 2–3 minutes ago (the lag); baseline windows end earlier.
      const isCurrent = (params.until as Date).getTime() >= Date.now() - 4 * 60_000;
      const errors = String(params.query).includes("level:error");
      return facet(Object.fromEntries(Object.keys(current).map((name) => [name, errors ? (isCurrent ? current[name]! : 10) : 5000])));
    },
    async search(params: { query?: string }) {
      searches.push(params.query ?? "*");
      return [{ id: "1", timestamp: Date.now(), logmsg: "", tags: [], logtypes: [], event: { json: { message: "db timeout after 30s" } } } satisfies LogEvent];
    },
    searchUrl: () => "https://acme.loggly.com/search/?terms=x",
  };
}

function snapshotOf(current: Record<string, number>): HealthSnapshot {
  const windows: WindowCounts[] = Array.from({ length: 5 }, (_, i) => ({
    from: i * 600_000,
    until: (i + 1) * 600_000,
    errors: facet(Object.fromEntries(Object.keys(current).map((name) => [name, i === 4 ? current[name]! : 10]))),
    volume: facet(Object.fromEntries(Object.keys(current).map((name) => [name, 5000]))),
  }));
  return evaluateHealth(windows, rules, 3_000_000);
}

test("config keeps valid settings, reports invalid ones and defaults the rest", () => {
  const problems: string[] = [];
  const config = normalizeConfig({ statusLine: { enabled: true, refreshSeconds: 5 }, health: { groupBy: "derived.AppName", window: "ten minutes", muted: ["a"], lag: "0m" }, trends: { saveEveryDays: 7 }, tools: { exposure: "codemode" } }, problems);
  assert.equal(config.statusLine.enabled, true);
  assert.equal(config.statusLine.refreshSeconds, DEFAULT_CONFIG.statusLine.refreshSeconds);
  assert.equal(config.health.groupBy, "derived.AppName");
  assert.equal(config.health.window, DEFAULT_CONFIG.health.window);
  assert.equal(config.health.lag, "0m");
  assert.deepEqual(config.health.muted, ["a"]);
  assert.equal(config.tools.exposure, "codemode");
  assert.equal(config.trends.saveEveryDays, 7);
  assert.deepEqual(problems.map((p) => p.split(" ")[0]), ["statusLine.refreshSeconds", "health.window"]);
  assert.equal(normalizeConfig({ trends: { saveEveryDays: 1.5 } }, problems).trends.saveEveryDays, 0, "a fractional schedule is invalid");
  assert.match(problems.at(-1)!, /^trends.saveEveryDays is invalid; using 0/);
  assert.equal(DEFAULT_CONFIG.trends.sampleWindows, 288);
  assert.equal(normalizeConfig({ trends: { sampleWindows: 0 } }).trends.sampleWindows, 0, "0 turns sampling off");
  assert.equal(normalizeConfig({ trends: { sampleWindows: 96 } }).trends.sampleWindows, 96);
  for (const invalid of [10, 2000, 50.5, "288"]) {
    assert.equal(normalizeConfig({ trends: { sampleWindows: invalid } }, problems).trends.sampleWindows, 288);
    assert.match(problems.at(-1)!, /^trends.sampleWindows is invalid; using 288/);
  }
  assert.deepEqual(normalizeConfig(undefined), DEFAULT_CONFIG);
});

test("config files: missing means defaults, invalid JSON is reported, updates preserve unknown keys", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-loggly-config-"));
  const path = join(dir, "loggly.json");
  assert.deepEqual(loadConfig(path), { config: DEFAULT_CONFIG, path, exists: false, problems: [] });
  writeFileSync(path, "{nope");
  assert.match(loadConfig(path).problems[0]!, /not valid JSON/);
  assert.throws(() => updateConfigFile(() => {}, path), /not valid JSON/, "never overwrite a file the user is editing");
  writeFileSync(path, JSON.stringify({ future: { keep: true }, health: { scope: "env:prod" } }));
  const updated = updateConfigFile((raw) => {
    section(raw, "statusLine").enabled = true;
    section(raw, "health").muted = ["x"];
  }, path);
  assert.equal(updated.config.statusLine.enabled, true);
  assert.equal(updated.config.health.scope, "env:prod");
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { future: { keep: true }, health: { scope: "env:prod", muted: ["x"] }, statusLine: { enabled: true } });
});

test("the monitor joins concurrent refreshes and keeps the last good snapshot on failure", async () => {
  const client = fakeClient({ api: 400, web: 10 });
  let fail = false;
  const monitor = new HealthMonitor({
    getClient: () => (fail ? { ...client, facet: async () => { throw new Error("HTTP 503"); } } : client),
    getRules: () => rules,
  });
  const states: boolean[] = [];
  monitor.subscribe((state) => states.push(state.refreshing));
  const [a, b] = await Promise.all([monitor.refresh(), monitor.refresh()]);
  assert.equal(a, b);
  assert.equal(client.facets, 11, "one check: errors and volume for five windows, and recent volume");
  assert.equal(monitor.state.snapshot!.issues[0]!.id, "spike:api");
  assert.equal(monitor.state.snapshot!.issues[0]!.patterns![0]!.template, "db timeout after <n>s");
  assert.deepEqual(states, [true, false]);

  fail = true;
  assert.equal(await monitor.refresh(), undefined);
  assert.equal(monitor.state.error, "HTTP 503");
  assert.equal(monitor.state.snapshot, a, "a failed refresh keeps the previous snapshot");
  monitor.dispose();
});

test("re-evaluation applies new rules locally and keeps sampled patterns", async () => {
  let current = rules;
  const client = fakeClient({ api: 400, web: 10 });
  const monitor = new HealthMonitor({ getClient: () => client, getRules: () => current });
  await monitor.refresh();
  const facets = client.facets;
  current = { ...rules, muted: ["api"] };
  monitor.reevaluate();
  assert.equal(client.facets, facets, "no new queries");
  assert.equal(monitor.state.snapshot!.issues.length, 0);
  current = rules;
  monitor.reevaluate();
  assert.equal(monitor.state.snapshot!.issues[0]!.patterns![0]!.template, "db timeout after <n>s");
  monitor.dispose();
});

test("cancelling a refresh clears the refreshing state", async () => {
  const monitor = new HealthMonitor({ getClient: () => fakeClient({ api: 10 }), getRules: () => rules });
  const pending = monitor.refresh();
  assert.equal(monitor.state.refreshing, true);
  monitor.cancel();
  assert.equal(await pending, undefined);
  assert.equal(monitor.state.refreshing, false);
  assert.equal(monitor.state.error, undefined, "a cancellation is not an error");
});

test("the status line shows overall health and rotates through pressing issues", () => {
  assert.equal(formatStatusLine({ refreshing: true }, theme), "◌ loggly checking…");
  assert.match(formatStatusLine({ refreshing: false, error: "Loggly is not configured" }, theme), /^◌ loggly unavailable · Loggly is not configured/);
  assert.equal(formatStatusLine({ refreshing: false, snapshot: snapshotOf({ api: 10, web: 10 }) }, theme), "● loggly healthy · 2 systems");

  const snapshot = snapshotOf({ api: 400, web: 90, calm: 10 });
  snapshot.issues[0]!.patterns = [{ template: "db timeout after <n>s", count: 1, share: 1, example: "", firstSeen: 0, lastSeen: 0 }];
  const first = formatStatusLine({ refreshing: false, snapshot }, theme, 0);
  assert.equal(first, "✖ loggly 1 critical · 1 warning │ api errors ×40: 400 in 10m, usually 10 “db timeout after <n>s” [1/2]");
  assert.match(formatStatusLine({ refreshing: false, snapshot }, theme, 1), /│ web errors ×9: 90 in 10m.* \[2\/2\]$/);
  assert.match(formatStatusLine({ refreshing: false, snapshot, error: "HTTP 503" }, theme), /⚠ stale$/);
});

test("the status row sits above Pi's footer, is cut to the pane width and updates in place", () => {
  const calls: Array<{ key: string; content: unknown; placement?: string }> = [];
  let mounted: { render(width: number): string[]; dispose?(): void } | undefined;
  let renders = 0;
  const ui = {
    setWidget: (key: string, content: unknown, options?: { placement?: string }) => {
      calls.push({ key, content: typeof content === "function" ? "component" : content, placement: options?.placement });
      mounted?.dispose?.();
      mounted = typeof content === "function" ? content({ requestRender: () => renders++ }, theme) : undefined;
    },
  };
  const row = statusRow(ui as never, "tui");
  const long = "✖ loggly 1 critical │ checkout errors ×12: 640 in 10m, usually 50 “db timeout after <n>s” [1/3]";
  row.show(long);
  assert.deepEqual(calls, [{ key: "loggly", content: "component", placement: "belowEditor" }]);
  assert.deepEqual(mounted!.render(200), [long]);
  const narrow = mounted!.render(40);
  assert.equal(narrow.length, 1, "one line, never wrapped");
  assert.equal(visibleWidth(narrow[0]!), 40);
  assert.match(narrow[0]!, /^✖ loggly 1 critical │ checkout errors.*…/);

  row.show("● loggly healthy · 2 systems");
  assert.equal(calls.length, 1, "updates redraw the same row");
  assert.equal(renders, 1);
  row.show("● loggly healthy · 2 systems");
  assert.equal(renders, 1, "unchanged text does not redraw");
  assert.deepEqual(mounted!.render(80), ["● loggly healthy · 2 systems"]);

  // When Pi removes the widget (such as on /reload), the next update adds it again.
  mounted!.dispose!();
  mounted = undefined;
  row.show("▲ loggly degraded");
  assert.equal(calls.length, 2);
  assert.deepEqual(mounted!.render(80), ["▲ loggly degraded"]);
  row.clear();
  assert.deepEqual(calls.at(-1), { key: "loggly", content: undefined, placement: undefined });

  const rpc: unknown[] = [];
  const rpcRow = statusRow({ setWidget: (_key: string, content: unknown, options?: { placement?: string }) => rpc.push([content, options?.placement]) } as never, "rpc");
  rpcRow.show("● loggly healthy");
  rpcRow.clear();
  assert.deepEqual(rpc, [[["● loggly healthy"], "belowEditor"], [undefined, undefined]], "RPC clients get lines of text");
});

test("the status line controller renders, notifies once per new critical issue and clears on stop", async () => {
  const statuses: Array<string | undefined> = [];
  const notes: string[] = [];
  const ui = { notify: (message: string) => notes.push(message), theme } as never;
  const display = { show: (text: string) => statuses.push(text), clear: () => statuses.push(undefined) };
  const client = fakeClient({ api: 400, web: 10 });
  const monitor = new HealthMonitor({ getClient: () => client, getRules: () => rules });
  const line = new StatusLine(monitor, ui, display, { ...DEFAULT_CONFIG.statusLine, refreshSeconds: 3600 });
  line.start();
  assert.equal(statuses[0], "◌ loggly checking…");
  await monitor.refresh();
  assert.match(statuses.at(-1)!, /✖ loggly 1 critical │ api errors ×40/);
  assert.equal(notes.length, 1);
  assert.match(notes[0]!, /Loggly: new critical issue\napi: errors ×40.*“db timeout after <n>s”\nOpen \/loggly/);
  await new Promise((resolve) => setTimeout(resolve, 5)); // A later check, not a re-evaluation.
  await monitor.refresh();
  assert.equal(notes.length, 1, "an issue that persists is not re-announced");
  line.stop();
  assert.equal(statuses.at(-1), undefined);
  assert.equal(monitor.running, false);
  monitor.dispose();
});

function dashboard(overrides: Partial<DashboardDeps> = {}, current: Record<string, number> = { api: 400, web: 90, calm: 10 }) {
  const client = fakeClient(current);
  const monitor = new HealthMonitor({ getClient: () => client, getRules: () => rules });
  let renders = 0;
  let closed = 0;
  const investigated: string[] = [];
  let muted: string[] = [];
  let statusOn = false;
  const deps: DashboardDeps = {
    monitor,
    getClient: () => client,
    getRules: () => rules,
    statusLineEnabled: () => statusOn,
    toggleStatusLine: () => (statusOn = !statusOn),
    toggleMute: (system) => {
      muted = muted.includes(system) ? muted.filter((m) => m !== system) : [...muted, system];
      return muted.includes(system);
    },
    investigate: (prompt) => investigated.push(prompt),
    maxAgeMs: 60_000,
    ...overrides,
  };
  const view = new LogglyDashboard({ requestRender: () => renders++, terminal: { rows: 30 } }, theme as never, keybindings, () => closed++, deps);
  return { view, monitor, client, deps, investigated, get renders() { return renders; }, get closed() { return closed; }, get muted() { return muted; } };
}

test("the dashboard refreshes stale health on open and renders a full-size table", async () => {
  const d = dashboard();
  assert.equal(d.monitor.state.refreshing, true, "opening starts a check");
  const loading = d.view.render(100);
  assert.equal(loading.length, 30, "every terminal row");
  assert.ok(loading.some((line) => line.includes("Checking Loggly health")));
  await d.monitor.refresh();
  const lines = d.view.render(100);
  assert.ok(lines.every((line) => visibleWidth(line) === 100), "every line fills the overlay width");
  const text = screen(lines);
  assert.match(lines[0]!, /^Loggly · acme +✖ CRITICAL  1 critical · 1 warning$/);
  assert.match(text, /Pressing issues\n  ✖ api  errors ×40: 400 in 10m, usually 10\n      “db timeout after <n>s”  100% of 1 error$/m);
  assert.match(text, /SYSTEM +ERRORS +USUAL +× +ERR% +EVENTS +TREND/);
  assert.match(text, /› ✖ api +400 +10 +×40 +8% +5k  ▁▁▁▁█/);
  assert.match(lines.at(-1)!, /↑\/↓ select · enter details · i investigate · m mute · s status line off · r refresh · esc close/);
  d.view.dispose();
});

test("the dashboard narrows columns on small widths", async () => {
  const d = dashboard();
  await d.monitor.refresh();
  const text = screen(d.view.render(60));
  assert.doesNotMatch(text, /USUAL|TREND/);
  assert.ok(d.view.render(60).every((line) => visibleWidth(line) === 60));
  d.view.dispose();
});

test("dashboard keys select, drill in, mute, toggle the status line, investigate and close", async () => {
  const d = dashboard();
  await d.monitor.refresh();
  d.view.handleInput("\x1b[B");
  assert.match(screen(d.view.render(100)), /› ▲ web/);
  d.view.handleInput("s");
  assert.equal(d.view.render(100).at(-1)!.trim(), "Status line on for this session");

  d.view.handleInput("\r");
  await tick();
  await tick();
  const detail = screen(d.view.render(100));
  assert.match(detail, /‹ web  ▲ warning  app/);
  assert.match(detail, /errors  ▂▂▂▂█  now 90 · usual 10 · ×9/);
  assert.match(detail, /Error patterns  1 error: all counted · /);
  assert.match(detail, /100%  db timeout after <n>s/);
  assert.match(detail, /env:prod AND level:error AND app:"web"/);
  assert.match(detail, /Open in Loggly ↗/);
  assert.deepEqual(d.client.searches.at(-1), 'env:prod AND level:error AND app:"web"');

  d.view.handleInput("m");
  assert.deepEqual(d.muted, ["web"]);
  assert.match(screen(d.view.render(100)), /web muted: it will not raise issues/);
  d.view.handleInput("\x1b");
  assert.match(screen(d.view.render(100)), /Pressing issues/, "esc returns to the overview");

  d.view.handleInput("i");
  assert.equal(d.closed, 1, "investigating closes the dashboard first");
  assert.match(d.investigated[0]!, /^Investigate this Loggly warning issue/);
  assert.match(d.investigated[0]!, /- System: web \(app\), scope: env:prod/);
  d.view.handleInput("q");
  assert.equal(d.closed, 1, "a closed dashboard ignores input");
});

test("system details show daily errors from saved days captured with the same rules", async () => {
  const day = (date: string, errors: number, groupBy = "app"): TrendDay => ({
    version: 1, day: date, collectedAt: "", rules: { ...trendRules(rules), groupBy }, totals: { events: 1000, errors },
    systems: { web: { events: 1000, errors } }, truncated: false, messages: [], messagesCovered: 0,
  });
  const d = dashboard({ loadTrends: async () => [day("2026-10-26", 999, "tag"), day("2026-10-27", 10), day("2026-10-28", 20), day("2026-10-29", 60)] });
  await d.monitor.refresh();
  d.view.handleInput("\x1b[B");
  d.view.handleInput("\r");
  await tick();
  await tick();
  const detail = screen(d.view.render(100));
  assert.match(detail, /errors  ▂▂▂▂█  now 90/);
  assert.match(detail, /\ndaily   [▁-█]{3}  60 errors on 2026-10-29 · 30\/day over 3 saved days\n/);
  d.view.dispose();

  const fresh = dashboard({ loadTrends: async () => [day("2026-10-29", 60)] });
  await fresh.monitor.refresh();
  fresh.view.handleInput("\r");
  await tick();
  assert.doesNotMatch(screen(fresh.view.render(100)), /daily/, "one saved day is not a trend");
  fresh.view.dispose();
});

test("dashboard shows configuration failures with a retry hint", async () => {
  const unconfigured = () => {
    throw new Error("Loggly is not configured: set LOGGLY_SUBDOMAIN");
  };
  const d = dashboard({ getClient: unconfigured });
  const monitor = new HealthMonitor({ getClient: unconfigured, getRules: () => rules });
  await monitor.refresh();
  const view = new LogglyDashboard({ requestRender: () => {}, terminal: { rows: 20 } }, theme as never, keybindings, () => {}, { ...d.deps, monitor });
  const text = screen(view.render(80));
  assert.match(text, /^Loggly +◌ UNAVAILABLE/);
  assert.match(text, /Could not check Loggly: Loggly is not configured: set LOGGLY_SUBDOMAIN\nPress r to retry/);
  view.dispose();
  d.view.dispose();
  d.monitor.dispose();
});

test("investigation prompts and text reports carry the evidence", () => {
  const snapshot = snapshotOf({ api: 400, calm: 10 });
  const api = snapshot.systems.find((s) => s.name === "api")!;
  const prompt = investigationPrompt(snapshot, api, snapshot.issues[0], [{ template: "db timeout", count: 3, share: 0.75, example: "", firstSeen: 0, lastSeen: 0 }]);
  assert.match(prompt, /- Error query: env:prod AND level:error AND app:"api"/);
  assert.match(prompt, /- Top error patterns: 75% “db timeout”/);
  assert.match(prompt, /loggly_timeline/);

  const report = formatHealthReport(snapshot);
  assert.match(report, /^Loggly health: CRITICAL \(1 critical\)/);
  assert.match(report, /1\. \[critical\] api: errors ×40: 400 in 10m, usually 10\n   query: env:prod AND level:error AND app:"api"/);
  assert.match(formatHealthReport(snapshot, { system: "calm" }), /No issues for this system\./);
  assert.match(formatHealthReport(snapshot, { system: "ghost" }), /No events from app:"ghost"/);
  assert.equal(STATUS_KEY, "loggly");
});

test("starting the monitor reuses a fresh snapshot", async () => {
  const client = fakeClient({ api: 10 });
  const monitor = new HealthMonitor({ getClient: () => client, getRules: () => rules });
  await monitor.refresh();
  const facets = client.facets;
  monitor.start(60_000);
  assert.equal(monitor.state.refreshing, false);
  assert.equal(client.facets, facets);
  monitor.dispose();
});

test("the dashboard separates pressing issues from ongoing ones and shows volume for quiet systems", async () => {
  const windows: WindowCounts[] = Array.from({ length: 5 }, (_, i) => ({
    from: i * 600_000,
    until: (i + 1) * 600_000,
    errors: facet({ api: i === 4 ? 400 : 10, noisy: 600 }),
    volume: facet({ api: 5000, noisy: 1000, quiet: i === 4 ? 100 : 5000 }),
  }));
  const snapshot = evaluateHealth(windows, rules, Date.now());
  assert.deepEqual(snapshot.issues.map((i) => i.id), ["spike:api", "silent:quiet", "chronic:noisy"]);
  const monitor = { state: { snapshot, refreshing: false }, subscribe: () => () => {}, isStale: () => false, refresh: async () => snapshot } as unknown as HealthMonitor;
  const view = new LogglyDashboard({ requestRender: () => {}, terminal: { rows: 30 } }, theme as never, keybindings, () => {}, {
    monitor, getClient: () => fakeClient({}), getRules: () => rules, statusLineEnabled: () => false, toggleStatusLine: () => false, toggleMute: () => false, investigate: () => {}, maxAgeMs: 1e9,
  });
  const text = screen(view.render(100));
  assert.match(text, /Pressing issues\n  ✖ api  errors ×40.*\n  ▲ quiet  log volume down 98%: 100 events in 10m, usually 5k\n\nOngoing  chronic error rates and recurring bursts; not new\n  ◆ noisy  60% of events are errors/);
  assert.match(text, /▲ quiet .* ████▁$/m, "a quiet system's trend is its volume");
  view.dispose();
});
