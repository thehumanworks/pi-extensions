import type { Theme } from "@earendil-works/pi-coding-agent";
import { hyperlink, Key, matchesKey, visibleWidth, type Component, type KeybindingsManager, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { formatAge, formatClock, formatCount, formatPercent, formatRatio, sparkline } from "./analysis/format.ts";
import { allOf, valueMatch, type HealthIssue, type HealthRules, type HealthSnapshot, type SystemHealth, type SystemStatus, type TimeRange } from "./analysis/health.ts";
import type { MessagePattern } from "./analysis/patterns.ts";
import { describeBasis, windowPatterns, type PatternBasis } from "./analysis/window-patterns.ts";
import { describeError, type HealthMonitor } from "./monitor.ts";
import type { LogglyClient } from "./sdk/client.ts";
import { formatDuration } from "./sdk/time.ts";
import { fit, lpad, pad, wrap } from "./text.ts";
import { comparableRules, systemCounts, trendRules, type TrendDay } from "./trends.ts";

type DashboardTheme = Pick<Theme, "fg" | "bg" | "bold">;
type DashboardClient = Pick<LogglyClient, "count" | "facet" | "search" | "searchUrl" | "subdomain">;

export interface DashboardDeps {
  monitor: HealthMonitor;
  getRules: () => HealthRules;
  /** Throws when Loggly is not configured. */
  getClient: () => DashboardClient;
  statusLineEnabled: () => boolean;
  /** Returns the new state. */
  toggleStatusLine: () => boolean;
  /** Returns whether the system is now muted. */
  toggleMute: (system: string) => boolean;
  /** Hand an investigation prompt to the user (the dashboard closes first). */
  investigate: (prompt: string) => void;
  /** Saved daily trends, shown in system details. */
  loadTrends?: () => Promise<TrendDay[]>;
  /** Snapshots older than this are refreshed when the dashboard opens. */
  maxAgeMs: number;
  now?: () => number;
}

interface DetailState {
  system: string;
  range: TimeRange;
  scopeLabel: string;
  patterns?: MessagePattern[];
  basis?: PatternBasis;
  loading: boolean;
  error?: string;
  controller?: AbortController;
}

const STATUS_STYLE: Record<SystemStatus, { icon: string; color: "error" | "warning" | "muted" | "success" | "dim" }> = {
  critical: { icon: "✖", color: "error" },
  warning: { icon: "▲", color: "warning" },
  notice: { icon: "◆", color: "muted" },
  ok: { icon: "●", color: "success" },
  muted: { icon: "○", color: "dim" },
};

/**
 * The /loggly full-screen overlay: overall health, pressing issues and a systems table,
 * with a per-system drill-in showing trends and sampled error patterns.
 */
export class LogglyDashboard implements Component {
  readonly #tui: Pick<TUI, "requestRender"> & { terminal?: { rows: number } };
  readonly #theme: DashboardTheme;
  readonly #keys: Pick<KeybindingsManager, "matches">;
  readonly #done: () => void;
  readonly #deps: DashboardDeps;
  readonly #unsubscribe: () => void;
  readonly #ticker: ReturnType<typeof setInterval>;
  #view: "overview" | "detail" = "overview";
  #selectedName?: string;
  #offset = 0;
  #detailScroll = 0;
  #detail?: DetailState;
  #trends?: TrendDay[];
  #flash?: { text: string; color: "success" | "warning" | "error" | "muted" };
  #cache?: { width: number; height: number; lines: string[] };
  #disposed = false;

  constructor(
    tui: Pick<TUI, "requestRender"> & { terminal?: { rows: number } },
    theme: DashboardTheme,
    keys: Pick<KeybindingsManager, "matches">,
    done: () => void,
    deps: DashboardDeps,
  ) {
    this.#tui = tui;
    this.#theme = theme;
    this.#keys = keys;
    this.#done = done;
    this.#deps = deps;
    this.#unsubscribe = deps.monitor.subscribe(() => this.#update());
    // Keep "updated Ns ago" honest while open.
    this.#ticker = setInterval(() => this.#update(), 5_000);
    this.#ticker.unref?.();
    if (deps.monitor.isStale(deps.maxAgeMs) && !deps.monitor.state.refreshing) void deps.monitor.refresh();
    deps.loadTrends?.().then((days) => {
      this.#trends = days;
      this.#update();
    }, () => {});
  }

  invalidate(): void {
    this.#cache = undefined;
  }

  render(width: number): string[] {
    // Pi overlays call render() directly: fill every terminal row so nothing shows beneath.
    const height = Math.max(10, this.#tui.terminal?.rows ?? 24);
    if (this.#cache?.width === width && this.#cache.height === height) return this.#cache.lines;
    const body = this.#view === "detail" && this.#detail ? this.#renderDetail(width, height - 1) : this.#renderOverview(width, height - 1);
    const lines = [...body.slice(0, height - 1)];
    while (lines.length < height - 1) lines.push("");
    lines.push(this.#footer());
    const fitted = lines.map((line) => fit(line, width));
    this.#cache = { width, height, lines: fitted };
    return fitted;
  }

  handleMouse(event: TuiMouseEvent): { handled: boolean } | undefined {
    if (event.type !== "wheel") return;
    this.#move(Math.sign(event.wheelDelta ?? 0));
    return { handled: true };
  }

  handleInput(data: string): void {
    if (this.#disposed) return;
    this.#flash = undefined;
    const cancel = this.#keys.matches(data, "tui.select.cancel");
    if (this.#view === "detail") {
      if (cancel || matchesKey(data, Key.left) || matchesKey(data, Key.backspace)) {
        this.#closeDetail();
      } else if (matchesKey(data, "q")) {
        this.close();
        return;
      } else if (this.#keys.matches(data, "tui.select.up")) this.#detailScroll = Math.max(0, this.#detailScroll - 1);
      else if (this.#keys.matches(data, "tui.select.down")) this.#detailScroll++;
      else if (matchesKey(data, Key.pageUp)) this.#detailScroll = Math.max(0, this.#detailScroll - 10);
      else if (matchesKey(data, Key.pageDown)) this.#detailScroll += 10;
      else if (matchesKey(data, "r")) this.#sample(this.#detail!.system, true);
      else if (!this.#sharedKeys(data, this.#detail!.system)) return;
      this.#update();
      return;
    }
    if (cancel || matchesKey(data, "q")) {
      this.close();
      return;
    }
    const selected = this.#selectedSystem();
    if (this.#keys.matches(data, "tui.select.up")) this.#move(-1);
    else if (this.#keys.matches(data, "tui.select.down")) this.#move(1);
    else if (matchesKey(data, Key.pageUp)) this.#move(-10);
    else if (matchesKey(data, Key.pageDown)) this.#move(10);
    else if (matchesKey(data, Key.home)) this.#move(-Infinity);
    else if (matchesKey(data, Key.end)) this.#move(Infinity);
    else if ((this.#keys.matches(data, "tui.select.confirm") || matchesKey(data, Key.right)) && selected) this.#openDetail(selected.name);
    else if (matchesKey(data, "r")) void this.#deps.monitor.refresh();
    else if (matchesKey(data, "s")) this.#toggleStatusLine();
    else if (!selected || !this.#sharedKeys(data, selected.name)) return;
    this.#update();
  }

  close(): void {
    if (this.#disposed) return;
    this.dispose();
    this.#done();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unsubscribe();
    clearInterval(this.#ticker);
    this.#detail?.controller?.abort();
  }

  /** Keys available in both views. Returns whether the key was handled. */
  #sharedKeys(data: string, system: string): boolean {
    if (matchesKey(data, "m")) {
      try {
        const muted = this.#deps.toggleMute(system);
        this.#flash = { text: `${system} ${muted ? "muted: it will not raise issues" : "unmuted"}`, color: "muted" };
      } catch (error) {
        this.#flash = { text: `Could not update mutes: ${describeError(error)}`, color: "error" };
      }
      return true;
    }
    if (matchesKey(data, "i")) {
      const snapshot = this.#deps.monitor.state.snapshot;
      const health = snapshot?.systems.find((s) => s.name === system);
      if (!snapshot || !health) return true;
      const patterns = this.#detail?.system === system ? this.#detail.patterns : undefined;
      const prompt = investigationPrompt(snapshot, health, snapshot.issues.find((issue) => issue.system === system), patterns);
      this.close();
      this.#deps.investigate(prompt);
      return true;
    }
    return false;
  }

  #update(): void {
    if (this.#disposed) return;
    this.invalidate();
    this.#tui.requestRender();
  }

  #toggleStatusLine(): void {
    try {
      const enabled = this.#deps.toggleStatusLine();
      this.#flash = { text: `Status line ${enabled ? "on" : "off"} for this session`, color: "success" };
    } catch (error) {
      this.#flash = { text: `Could not change the status line: ${describeError(error)}`, color: "error" };
    }
  }

  #systems(): SystemHealth[] {
    return this.#deps.monitor.state.snapshot?.systems ?? [];
  }

  #selectedIndex(): number {
    const systems = this.#systems();
    const index = systems.findIndex((system) => system.name === this.#selectedName);
    return index >= 0 ? index : 0;
  }

  #selectedSystem(): SystemHealth | undefined {
    return this.#systems()[this.#selectedIndex()];
  }

  #move(delta: number): void {
    if (this.#view === "detail") {
      this.#detailScroll = Math.max(0, this.#detailScroll + delta);
      this.#update();
      return;
    }
    const systems = this.#systems();
    if (!systems.length) return;
    const next = Math.max(0, Math.min(systems.length - 1, this.#selectedIndex() + (Number.isFinite(delta) ? delta : delta > 0 ? systems.length : -systems.length)));
    this.#selectedName = systems[next]!.name;
    this.#update();
  }

  #openDetail(system: string): void {
    this.#view = "detail";
    this.#detailScroll = 0;
    this.#sample(system, false);
  }

  #closeDetail(): void {
    this.#detail?.controller?.abort();
    this.#detail = undefined;
    this.#view = "overview";
  }

  /** Show the issue's patterns, or measure this system's errors in its window. */
  #sample(system: string, force: boolean): void {
    const snapshot = this.#deps.monitor.state.snapshot;
    if (!snapshot) return;
    this.#detail?.controller?.abort();
    const issue = snapshot.issues.find((candidate) => candidate.system === system);
    const health = snapshot.systems.find((candidate) => candidate.name === system);
    // A quiet system has few current errors: look across the whole baseline instead.
    const wide = !health || health.errorsNow < 5;
    const range = wide ? { from: snapshot.windows[0]!.from, until: snapshot.current.until } : snapshot.current;
    const scopeLabel = `${formatClock(range.from)}–${formatClock(range.until)}`;
    if (!force && issue?.patterns) {
      this.#detail = { system, range: { from: issue.from, until: issue.until }, scopeLabel: `${formatClock(issue.from)}–${formatClock(issue.until)}`, patterns: issue.patterns, basis: issue.basis, loading: false };
      return;
    }
    const controller = new AbortController();
    const detail: DetailState = { system, range, scopeLabel, loading: true, controller };
    this.#detail = detail;
    const rules = snapshot.rules;
    let client: DashboardClient;
    try {
      client = this.#deps.getClient();
    } catch (error) {
      detail.loading = false;
      detail.error = describeError(error);
      return;
    }
    const query = allOf(rules.scope, rules.errorQuery, valueMatch(rules.groupBy, system, snapshot.systems.map((s) => s.name)));
    windowPatterns(client, { query, from: range.from, until: range.until, sampleSize: rules.sampleSize, messageFields: rules.messageFields, limit: 10, signal: controller.signal }).then(
      ({ patterns, ...basis }) => {
        if (controller.signal.aborted) return;
        detail.basis = basis;
        detail.patterns = patterns;
      },
      (error: unknown) => {
        if (!controller.signal.aborted) detail.error = describeError(error);
      },
    ).finally(() => {
      if (controller.signal.aborted) return;
      detail.loading = false;
      detail.controller = undefined;
      this.#update();
    });
  }

  #header(width: number): string[] {
    const t = this.#theme;
    const state = this.#deps.monitor.state;
    const snapshot = state.snapshot;
    let subdomain = "";
    try {
      subdomain = this.#deps.getClient().subdomain;
    } catch {
      // Not configured: the body explains.
    }
    const title = t.bold(t.fg("accent", "Loggly")) + (subdomain ? t.fg("dim", ` · ${subdomain}`) : "");
    let badge = t.fg("dim", "checking…");
    if (snapshot) {
      const counts = countSeverities(snapshot);
      const label = snapshot.status === "healthy" ? t.fg("success", "● HEALTHY") : snapshot.status === "degraded" ? t.fg("warning", "▲ DEGRADED") : t.fg("error", "✖ CRITICAL");
      const detail = [counts.critical && `${counts.critical} critical`, counts.warning && `${counts.warning} warning${counts.warning === 1 ? "" : "s"}`, counts.notice && `${counts.notice} chronic`].filter(Boolean).join(" · ");
      badge = label + (detail ? t.fg("dim", `  ${detail}`) : "");
    } else if (state.error) badge = t.fg("warning", "◌ UNAVAILABLE");
    const gap = Math.max(2, width - visibleWidth(title) - visibleWidth(badge));
    const lines = [title + " ".repeat(gap) + badge];
    if (snapshot) {
      const now = this.#deps.now?.() ?? Date.now();
      const baseline = formatDuration(snapshot.windowMs * snapshot.rules.baselineWindows);
      const meta = [
        `${snapshot.rules.groupBy} in ${snapshot.rules.scope}`,
        `window ${formatDuration(snapshot.windowMs)} ${formatClock(snapshot.current.from)}–${formatClock(snapshot.current.until)} vs ${baseline} before`,
        state.refreshing ? "refreshing…" : `updated ${formatAge(now - snapshot.generatedAt)}`,
      ];
      lines.push(t.fg("dim", meta.join(" · ")) + (state.error ? t.fg("warning", `  ⚠ last refresh failed: ${state.error}`) : ""));
    } else lines.push("");
    return lines;
  }

  #renderOverview(width: number, height: number): string[] {
    const t = this.#theme;
    const state = this.#deps.monitor.state;
    const snapshot = state.snapshot;
    const lines = this.#header(width);
    lines.push("");
    if (!snapshot) {
      if (state.error) {
        lines.push(t.fg("error", `Could not check Loggly: ${state.error}`));
        lines.push(t.fg("dim", "Press r to retry. Credentials come from LOGGLY_SUBDOMAIN and LOGGLY_API_TOKEN."));
      } else lines.push(t.fg("muted", "Checking Loggly health… (about 10–20 seconds)"));
      return lines;
    }

    // Pressing issues come first and may use the whole budget; ongoing notices get what is left.
    const pressing = snapshot.issues.filter((issue) => issue.severity !== "notice");
    const ongoing = snapshot.issues.filter((issue) => issue.severity === "notice");
    const budget = Math.max(4, Math.floor(height * 0.45));
    // Leave room for the Ongoing heading, its spacer and one line.
    const pressingLines = pressing.length
      ? this.#issueLines(pressing, budget - (ongoing.length ? 3 : 0))
      : [t.fg("success", "  None: no error spikes, new errors or quiet systems.")];
    lines.push(t.bold("Pressing issues"), ...pressingLines);
    if (ongoing.length) {
      lines.push("", t.bold("Ongoing") + t.fg("dim", "  chronic error rates and recurring bursts; not new"));
      lines.push(...this.#issueLines(ongoing, Math.max(1, budget - pressingLines.length - 2)));
    }
    lines.push("");

    const systems = snapshot.systems;
    const compact = width < 72;
    const trendWidth = snapshot.windows.length;
    const fixed = 4 + 8 + 7 + 7 + 8 + (compact ? 0 : 8 + trendWidth + 2);
    const nameWidth = Math.max(12, width - fixed);
    const header = `    ${pad("SYSTEM", nameWidth)}${lpad("ERRORS", 8)}${compact ? "" : lpad("USUAL", 8)}${lpad("×", 7)}${lpad("ERR%", 7)}${lpad("EVENTS", 8)}${compact ? "" : `  ${"TREND"}`}`;
    lines.push(t.bold(`Systems (${systems.length})`) + (snapshot.truncated ? t.fg("warning", `  ⚠ only the ${snapshot.rules.maxSystems} largest are tracked`) : ""));
    lines.push(t.fg("dim", header));

    const rows = Math.max(1, height - lines.length);
    const selected = this.#selectedIndex();
    if (selected < this.#offset) this.#offset = selected;
    if (selected >= this.#offset + rows) this.#offset = selected - rows + 1;
    this.#offset = Math.max(0, Math.min(this.#offset, Math.max(0, systems.length - rows)));
    const rules = snapshot.rules;
    for (const [index, system] of systems.slice(this.#offset, this.#offset + rows).entries()) {
      const isSelected = this.#offset + index === selected;
      const style = STATUS_STYLE[system.status];
      const muted = system.status === "muted";
      const color = (c: Parameters<DashboardTheme["fg"]>[0], text: string) => t.fg(muted ? "dim" : c, text);
      const ratioText = system.errorsNow || system.errorsBaseline ? formatRatio(system.ratio) : "–";
      const cells = [
        (isSelected ? t.fg("accent", "› ") : "  ") + t.fg(style.color, style.icon) + " ",
        color(system.status === "ok" ? "text" : style.color, pad(system.name, nameWidth)),
        color("text", lpad(formatCount(system.errorsNow), 8)),
        compact ? "" : color("muted", lpad(formatCount(system.errorsBaseline), 8)),
        color(system.ratio >= rules.spikeRatio && system.errorsNow >= rules.minErrors ? "warning" : "muted", lpad(ratioText, 7)),
        color(system.errorRate >= rules.chronicErrorRate ? "warning" : "muted", lpad(system.volumeNow ? formatPercent(system.errorRate) : "–", 7)),
        color("muted", lpad(formatCount(system.volumeNow), 8)),
        // A quiet system's story is its volume, not its errors.
        compact ? "" : `  ${system.issue === "silent" ? color(style.color, sparkline(system.volume)) : color("accent", sparkline(system.errors))}`,
      ];
      const row = cells.join("");
      lines.push(isSelected ? t.bg("selectedBg", fit(row, width)) : row);
    }
    if (!systems.length) lines.push(t.fg("muted", `  No events matched ${rules.scope} in the last ${formatDuration(snapshot.windowMs * snapshot.windows.length)}. Check health.scope and health.groupBy in the config.`));
    return lines;
  }

  /** Errors per saved day over the last 30 saved days, when at least two exist. */
  #dailyErrors(system: string, rules: HealthRules): string | undefined {
    const t = this.#theme;
    const current = trendRules(rules);
    const days = (this.#trends ?? []).filter((day) => comparableRules(day.rules, current)).slice(-30);
    if (days.length < 2) return undefined;
    const errors = days.map((day) => systemCounts(day, system)?.errors ?? 0);
    const average = errors.reduce((sum, count) => sum + count, 0) / errors.length;
    return `${t.fg("dim", "daily  ")} ${t.fg("accent", sparkline(errors))}  ${formatCount(errors.at(-1)!)} errors on ${days.at(-1)!.day} · ${formatCount(average)}/day over ${days.length} saved days`;
  }

  /** Issue lines with their top pattern, ending with an overflow note when over budget. */
  #issueLines(issues: readonly HealthIssue[], budget: number): string[] {
    const t = this.#theme;
    const lines: string[] = [];
    for (const [index, issue] of issues.entries()) {
      const style = STATUS_STYLE[issue.severity];
      const entry = [`  ${t.fg(style.color, style.icon)} ${t.fg(style.color, issue.system ?? "all systems")}  ${issue.summary}`];
      const pattern = issue.patterns?.[0];
      if (pattern) entry.push(t.fg("dim", `      “${pattern.template}”  ${formatPercent(pattern.share)}${issue.basis ? ` of ${formatCount(issue.basis.total)} error${issue.basis.total === 1 ? "" : "s"}${issue.basis.exact < issue.basis.total ? " (estimated)" : ""}` : ""}`));
      // Keep a line for the overflow note unless this is the last issue.
      const reserve = index < issues.length - 1 ? 1 : 0;
      if (lines.length + entry.length + reserve > budget) {
        if (lines.length + 1 <= budget || !lines.length) lines.push(t.fg("dim", `  …${issues.length - index} more (see systems below)`));
        break;
      }
      lines.push(...entry);
    }
    return lines;
  }

  #renderDetail(width: number, height: number): string[] {
    const t = this.#theme;
    const snapshot = this.#deps.monitor.state.snapshot;
    const detail = this.#detail!;
    if (!snapshot) return this.#header(width);
    const system = snapshot.systems.find((candidate) => candidate.name === detail.system);
    const issue = snapshot.issues.find((candidate) => candidate.system === detail.system);
    const style = STATUS_STYLE[system?.status ?? "ok"];
    const head = [
      t.fg("dim", "‹ ") + t.bold(t.fg(style.color, detail.system)) + "  " + t.fg(style.color, `${style.icon} ${system?.status ?? "unknown"}`) + t.fg("dim", `  ${snapshot.rules.groupBy}`),
      issue ? issue.summary : t.fg("dim", "No issue in the current window."),
    ];
    const body: string[] = [""];
    if (system) {
      body.push(`${t.fg("dim", "errors ")} ${t.fg("accent", sparkline(system.errors))}  now ${t.bold(formatCount(system.errorsNow))} · usual ${formatCount(system.errorsBaseline)} · ${formatRatio(system.ratio)}`);
      body.push(`${t.fg("dim", "events ")} ${t.fg("accent", sparkline(system.volume))}  now ${t.bold(formatCount(system.volumeNow))} · usual ${formatCount(system.volumeBaseline)} · ${formatPercent(system.errorRate)} errors`);
      body.push(t.fg("dim", `        ${formatDuration(snapshot.windowMs)} windows, ${formatClock(snapshot.windows[0]!.from)} to ${formatClock(snapshot.current.until)}`));
      const daily = this.#dailyErrors(detail.system, snapshot.rules);
      if (daily) body.push(daily);
      body.push("");
    }
    const sampleLabel = detail.basis ? `${describeBasis(detail.basis, "error")} · ${detail.scopeLabel}` : detail.scopeLabel;
    body.push(t.bold("Error patterns") + t.fg("dim", `  ${sampleLabel}`));
    if (detail.loading) body.push(t.fg("muted", "  Counting errors…"));
    else if (detail.error) body.push(t.fg("error", `  Could not sample errors: ${detail.error}`));
    else if (!detail.patterns?.length) body.push(t.fg("muted", "  No errors in this range."));
    else {
      for (const pattern of detail.patterns) {
        const share = lpad(formatPercent(pattern.share), 6);
        body.push(...wrap(`${t.fg("accent", share)}  ${pattern.template}`, width, "        "));
        if (pattern.example !== pattern.template) body.push(...wrap(t.fg("dim", `e.g. ${pattern.example}`), width, "        ", "        ").slice(0, 2));
        const estimated = detail.basis && detail.basis.exact < detail.basis.total ? "≈" : "";
        body.push(t.fg("dim", `        ${estimated}${pattern.count}×${pattern.firstSeen !== undefined ? ` · ${formatClock(pattern.firstSeen)}–${formatClock(pattern.lastSeen!)}` : ""}`));
      }
    }
    const rules = snapshot.rules;
    const query = issue?.query ?? allOf(rules.scope, rules.errorQuery, valueMatch(rules.groupBy, detail.system, snapshot.systems.map((s) => s.name)));
    body.push("", t.bold("Query"));
    body.push(...wrap(t.fg("muted", query), width, "  ", "  "));
    try {
      const url = this.#deps.getClient().searchUrl({ query, from: new Date(detail.range.from), until: new Date(detail.range.until) });
      body.push("  " + hyperlink(t.fg("accent", "Open in Loggly ↗"), url) + t.fg("dim", "  (ctrl/cmd-click)"));
    } catch {
      // Not configured; nothing to link.
    }
    if (this.#flash) body.push("", t.fg(this.#flash.color, this.#flash.text));
    const room = Math.max(1, height - head.length);
    this.#detailScroll = Math.min(this.#detailScroll, Math.max(0, body.length - room));
    return [...head, ...body.slice(this.#detailScroll, this.#detailScroll + room)];
  }

  #footer(): string {
    const t = this.#theme;
    if (this.#flash && this.#view === "overview") return t.fg(this.#flash.color, this.#flash.text);
    const status = `s status line ${this.#deps.statusLineEnabled() ? "on" : "off"}`;
    const keys = this.#view === "detail"
      ? ["esc back", "↑/↓ scroll", "i investigate", "m mute", "r resample", "q close"]
      : ["↑/↓ select", "enter details", "i investigate", "m mute", status, "r refresh", "esc close"];
    return t.fg("dim", keys.join(" · "));
  }
}

/** A prompt asking the agent to investigate one system with the Loggly tools. */
export function investigationPrompt(snapshot: HealthSnapshot, system: SystemHealth, issue?: HealthIssue, patterns?: MessagePattern[]): string {
  const rules = snapshot.rules;
  const range = issue ?? snapshot.current;
  const top = (issue?.patterns ?? patterns ?? []).slice(0, 3);
  const lines = [
    issue
      ? `Investigate this Loggly ${issue.severity} issue using the loggly tools.`
      : `Review the health of this system in Loggly using the loggly tools.`,
    "",
    `- System: ${system.name} (${rules.groupBy}), scope: ${rules.scope}`,
    `- Problem: ${issue ? issue.summary : `${formatCount(system.errorsNow)} errors and ${formatCount(system.volumeNow)} events in ${formatDuration(snapshot.windowMs)}, usually ${formatCount(system.errorsBaseline)} errors`}`,
    `- Window: ${new Date(range.from).toISOString()} to ${new Date(range.until).toISOString()}`,
    `- Error query: ${issue?.query ?? allOf(rules.scope, rules.errorQuery, valueMatch(rules.groupBy, system.name, snapshot.systems.map((s) => s.name)))}`,
  ];
  if (top.length) lines.push(`- Top error patterns: ${top.map((pattern) => `${formatPercent(pattern.share)} “${pattern.template}”`).join("; ")}`);
  lines.push(
    "",
    "Establish when it started (loggly_timeline), which messages dominate (loggly_patterns), the blast radius (other systems, hosts, clients or routes via loggly_facet) and the likely root cause, citing example events. Then suggest a fix and a Loggly alert (query, threshold, window) that would have caught it.",
  );
  return lines.join("\n");
}

function countSeverities(snapshot: HealthSnapshot): Record<"critical" | "warning" | "notice", number> {
  const counts = { critical: 0, warning: 0, notice: 0 };
  for (const issue of snapshot.issues) counts[issue.severity]++;
  return counts;
}
