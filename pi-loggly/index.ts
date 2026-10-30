import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { configPath, loadConfig, section, updateConfigFile, type LoadedConfig } from "./src/config.ts";
import { LogglyDashboard } from "./src/dashboard.ts";
import { describeError, HealthMonitor } from "./src/monitor.ts";
import { formatHealthReport } from "./src/report.ts";
import { defaultReportsDir, describeReport, generateReport } from "./src/reporting/generate.ts";
import type { PdfPrinter } from "./src/reporting/pdf.ts";
import { DEFAULT_TIMEFRAME, parseTimeframe, type Timeframe } from "./src/reporting/timeframe.ts";
import { defaultResultsDir, pruneResults } from "./src/results.ts";
import { LogglyClient } from "./src/sdk/client.ts";
import { StatusLine, statusRow } from "./src/status.ts";
import { registerLogglyTools, type ToolClient } from "./src/tools.ts";
import { defaultTrendsDir, loadTrends, TrendRecorder, type TrendUpdate } from "./src/trends.ts";

type Client = ToolClient & Pick<LogglyClient, "subdomain" | "account">;

export interface LogglyExtensionOptions {
  /** Configuration file. Default: loggly.json in Pi's agent directory. */
  configPath?: string;
  /** Environment holding LOGGLY_SUBDOMAIN and LOGGLY_API_TOKEN. Default: process.env. */
  env?: Record<string, string | undefined>;
  createClient?: (env: Record<string, string | undefined>) => Client;
  /** Saved daily trends. Default: pi-loggly/trends in the XDG data directory. */
  trendsDir?: string;
  /** Search results too large to show. Default: a private directory in /tmp. */
  resultsDir?: string;
  /** Reports from /loggly report. Default: pi-loggly/reports in the XDG data directory. */
  reportsDir?: string;
  /** Prints report PDFs; null skips them. Default: a headless Chromium-family browser. */
  printPdf?: PdfPrinter | null;
}

interface Completion {
  value: string;
  label: string;
  description?: string;
}

const SUBCOMMANDS: Completion[] = [
  { value: "status", label: "status", description: "on | off | toggle: show health on its own line above the footer, for this session" },
  { value: "refresh", label: "refresh", description: "run a health check now" },
  { value: "trends", label: "trends", description: "save daily trends now; every <days> | off sets a schedule" },
  { value: "report", label: "report", description: `HTML, PDF and Markdown report for a timeframe in words (default ${DEFAULT_TIMEFRAME})` },
  { value: "config", label: "config", description: "show the configuration file and settings" },
];

/** How often a session with the status line on checks for a newly completed day. No requests unless one is missing. */
const TRENDS_CHECK_MS = 3_600_000;

/** Footer entry showing a report's progress. */
const REPORT_STATUS_KEY = "loggly-report";

const REPORT_EXAMPLES: Completion[] = [
  { value: "report last 2h", label: "report last 2h", description: "the last 2 hours, compared with the 2 before" },
  { value: "report last 24 hours", label: "report last 24 hours", description: "the default when no timeframe is given" },
  { value: "report today", label: "report today", description: "since midnight, compared with the same hours yesterday" },
  { value: "report yesterday", label: "report yesterday", description: "midnight to midnight, local time" },
  { value: "report since 9am", label: "report since 9am", description: "also: since monday, since 2026-10-28 14:00" },
  { value: "report last 7 days", label: "report last 7 days", description: "also: 2026-10-28 09:00 to 12:00" },
];

/** always: report the outcome (the command); saved: only when days were saved (Pi start); never: only failures (status line). */
type TrendReport = "always" | "saved" | "never";

export function registerLoggly(pi: ExtensionAPI, options: LogglyExtensionOptions = {}): void {
  const path = options.configPath ?? configPath();
  const resultsDir = options.resultsDir ?? defaultResultsDir();
  // Read synchronously at load: tool exposure and guidance come from the configuration.
  let loaded: LoadedConfig = loadConfig(path);
  let client: { key: string; value: Client } | undefined;
  const getClient = (): Client => {
    const env = options.env ?? process.env;
    const key = `${env.LOGGLY_SUBDOMAIN ?? ""}\u0000${env.LOGGLY_API_TOKEN ?? ""}`;
    if (client?.key !== key) client = { key, value: (options.createClient ?? ((e) => LogglyClient.fromEnv(e)))(env) };
    return client.value;
  };
  const getRules = () => loaded.config.health;
  const monitor = new HealthMonitor({ getClient, getRules });
  const trends = new TrendRecorder(options.trendsDir ?? defaultTrendsDir(), { getClient, getRules });
  // Pi rebuilds the extension for /new, /resume, /fork and /reload, so this lasts one session.
  let statusEnabled = false;
  let statusLine: StatusLine | undefined;
  let trendTimer: ReturnType<typeof setInterval> | undefined;
  let trendController = new AbortController();
  let trendFailureShown = false;
  let reportController = new AbortController();
  let reportRunning: string | undefined;
  const reportsDir = options.reportsDir ?? defaultReportsDir();

  const updateTrends = async (ctx: ExtensionContext, report: TrendReport): Promise<TrendUpdate | undefined> => {
    try {
      const update = await trends.update(trendController.signal);
      const every = loaded.config.trends.saveEveryDays;
      if (report === "always" || (report === "saved" && update.captured.length)) ctx.ui.notify(describeTrendUpdate(update, trends.dir, every), update.busy ? "warning" : "info");
      const risk = scheduleRisk(every, trends.retentionDays);
      if (risk && report !== "never") ctx.ui.notify(risk, "warning");
      return update;
    } catch (error) {
      if (trendController.signal.aborted) return undefined;
      // Background failures are reported once per session; the next check retries.
      if (report === "always" || !trendFailureShown) ctx.ui.notify(`Could not save Loggly trends: ${describeError(error)}`, report === "always" ? "error" : "warning");
      trendFailureShown = true;
      return undefined;
    }
  };
  const stopStatus = () => {
    statusLine?.stop();
    statusLine = undefined;
    if (trendTimer) clearInterval(trendTimer);
    trendTimer = undefined;
  };
  const startStatus = (ctx: ExtensionContext) => {
    stopStatus();
    statusLine = new StatusLine(monitor, ctx.ui, statusRow(ctx.ui, ctx.mode), loaded.config.statusLine);
    statusLine.start();
    // A session that polls also saves each completed day.
    void updateTrends(ctx, "never");
    trendTimer = setInterval(() => void updateTrends(ctx, "never"), TRENDS_CHECK_MS);
    trendTimer.unref?.();
  };
  const setStatusEnabled = (enabled: boolean, ctx: ExtensionContext): boolean => {
    statusEnabled = enabled;
    if (enabled && ctx.hasUI) startStatus(ctx);
    else stopStatus();
    return enabled;
  };
  const toggleMute = (system: string): boolean => {
    let muted = false;
    loaded = updateConfigFile((raw) => {
      const health = section(raw, "health");
      const list = Array.isArray(health.muted) ? health.muted.filter((name): name is string => typeof name === "string") : [];
      muted = !list.includes(system);
      health.muted = muted ? [...list, system] : list.filter((name) => name !== system);
    }, path);
    monitor.reevaluate();
    return muted;
  };

  const startReport = (input: string, ctx: ExtensionContext) => {
    if (reportRunning) return ctx.ui.notify(`A Loggly report (${reportRunning}) is still being made; a notification follows when it is ready.`, "warning");
    let timeframe: Timeframe;
    try {
      timeframe = parseTimeframe(input);
    } catch (error) {
      return ctx.ui.notify(describeError(error), "warning");
    }
    const running = timeframe.label;
    reportRunning = running;
    const hint = input.trim() ? "" : ", the default; add a timeframe such as last 2h or yesterday";
    ctx.ui.notify(`Making a Loggly report (${running}${hint}) in the background. It takes under a minute for a day; a notification follows.`, "info");
    const { signal } = reportController;
    // Pi waits for command handlers before taking input, so the report runs on its own.
    void (async () => {
      try {
        const report = await generateReport({
          client: getClient(),
          rules: loaded.config.health,
          timeframe,
          dir: reportsDir,
          retentionDays: trends.retentionDays,
          printPdf: options.printPdf,
          signal,
          onProgress: (done, total) => {
            if (!signal.aborted) ctx.ui.setStatus(REPORT_STATUS_KEY, `loggly report ${Math.floor((done / total) * 100)}%`);
          },
        });
        ctx.ui.notify(describeReport(report), report.model.findings.some((f) => f.severity === "critical") ? "warning" : "info");
      } catch (error) {
        if (!signal.aborted) ctx.ui.notify(`Could not make the Loggly report (${running}): ${describeError(error)}`, "error");
      } finally {
        if (reportRunning === running) reportRunning = undefined;
        if (!signal.aborted) ctx.ui.setStatus(REPORT_STATUS_KEY, undefined);
      }
    })();
  };

  registerLogglyTools(pi, { getClient, getConfig: () => loaded.config, monitor, outputDir: resultsDir, trendsDir: trends.dir });

  pi.registerCommand("loggly", {
    description: "Loggly health dashboard; /loggly status on|off toggles the status line for this session",
    getArgumentCompletions: (prefix) => {
      const text = prefix.trimStart().toLowerCase().replace(/\s+/g, " ");
      if (!text.includes(" ")) {
        const matches = SUBCOMMANDS.filter((command) => command.value.startsWith(text));
        // Once the prefix picks one subcommand, offer its options too, such as the suggested schedule.
        return matches.length === 1 ? [matches[0]!, ...subcommandOptions(matches[0]!.value)] : matches;
      }
      return subcommandOptions(text.slice(0, text.indexOf(" "))).filter((option) => option.value.startsWith(text));
    },
    handler: async (args, ctx) => {
      const [sub = "", arg, value, extra] = args.trim().toLowerCase().split(/\s+/);
      if (sub === "") return openDashboard(ctx);
      if (sub === "report") return startReport(args.trim().slice("report".length), ctx);
      if (sub === "status") {
        const next = arg === "on" ? true : arg === "off" ? false : arg === undefined || arg === "toggle" ? !statusEnabled : undefined;
        if (next === undefined) return ctx.ui.notify("Usage: /loggly status [on|off|toggle]", "warning");
        setStatusEnabled(next, ctx);
        ctx.ui.notify(next ? `Loggly status line on for this session: checking every ${loaded.config.statusLine.refreshSeconds}s.` : "Loggly status line off for this session.", "info");
        return;
      }
      if (sub === "refresh") {
        const snapshot = await monitor.refresh();
        if (snapshot) ctx.ui.notify(formatHealthReport(snapshot, { maxSystems: 5 }), snapshot.status === "healthy" ? "info" : "warning");
        else ctx.ui.notify(`Loggly health check failed: ${monitor.state.error ?? "cancelled"}`, "error");
        return;
      }
      if (sub === "trends") {
        if (arg === "every" || arg === "off") {
          const days = arg === "off" ? 0 : Number(value);
          if ((arg === "off" ? value !== undefined : !Number.isInteger(days) || days < 1 || days > 365) || extra !== undefined) {
            return ctx.ui.notify(TRENDS_USAGE, "warning");
          }
          try {
            loaded = updateConfigFile((raw) => {
              section(raw, "trends").saveEveryDays = days;
            }, path);
          } catch (error) {
            return ctx.ui.notify(`Could not save ${path}: ${describeError(error)}`, "error");
          }
          if (!days) return ctx.ui.notify("Loggly trends are no longer saved at Pi start. /loggly trends still saves them now.", "info");
          ctx.ui.notify(`Loggly trends will be saved at Pi start when ${days} or more complete days are waiting. Saving any missing days now.`, "info");
          void updateTrends(ctx, "always");
          return;
        }
        if (arg !== undefined) return ctx.ui.notify(TRENDS_USAGE, "warning");
        // Pi waits for command handlers before taking input, and a first run takes minutes.
        // A running update is joined, so this reports when it ends.
        ctx.ui.notify(trends.running ? "Loggly trends are already being saved; a notification follows when done." : "Saving Loggly trends in the background, about 10 seconds per missing day.", "info");
        void updateTrends(ctx, "always");
        return;
      }
      if (sub === "config") {
        loaded = loadConfig(path);
        const problems = loaded.problems.length ? `\nProblems:\n${loaded.problems.map((p) => `- ${p}`).join("\n")}` : "";
        ctx.ui.notify(`${loaded.exists ? "Configuration" : "No configuration file; defaults"} (${path}):\n${JSON.stringify(loaded.config, null, 2)}${problems}`, "info");
        return;
      }
      ctx.ui.notify("Usage: /loggly [status on|off|toggle | refresh | trends [every <days> | off] | report [timeframe] | config]", "warning");
    },
  });

  function subcommandOptions(subcommand: string): Completion[] {
    if (subcommand === "status") {
      return [
        { value: "status on", label: "status on", description: "show health on its own line above the footer, for this session" },
        { value: "status off", label: "status off", description: "stop polling in this session" },
        { value: "status toggle", label: "status toggle", description: "switch it for this session" },
      ];
    }
    if (subcommand === "report") return REPORT_EXAMPLES;
    if (subcommand !== "trends") return [];
    const current = loaded.config.trends.saveEveryDays;
    const suggested = suggestedSchedule(trends.retentionDays);
    const every = (days: number, note: string): Completion => ({
      value: `trends every ${days}`,
      label: `trends every ${days}`,
      description: `save at Pi start when ${days} or more complete days are waiting (${note})`,
    });
    const options = [every(suggested, current === suggested ? "current schedule" : "suggested")];
    if (current && current !== suggested) options.push(every(current, "current schedule"));
    if (current) options.push({ value: "trends off", label: "trends off", description: `stop saving at Pi start (now every ${plural(current, "day")})` });
    return options;
  }

  async function openDashboard(ctx: ExtensionCommandContext): Promise<void> {
    if (ctx.mode !== "tui") {
      if (!ctx.hasUI) return;
      if (monitor.isStale(loaded.config.statusLine.refreshSeconds * 1000)) await monitor.refresh();
      const snapshot = monitor.state.snapshot;
      if (snapshot) ctx.ui.notify(formatHealthReport(snapshot, { maxSystems: 10, staleError: monitor.state.error }), "info");
      else ctx.ui.notify(`Loggly health check failed: ${monitor.state.error ?? "cancelled"}`, "error");
      return;
    }
    await ctx.ui.custom<void>(
      (tui, theme, keybindings, done) =>
        new LogglyDashboard(tui, theme, keybindings, () => done(), {
          monitor,
          getClient,
          getRules,
          statusLineEnabled: () => statusEnabled,
          toggleStatusLine: () => setStatusEnabled(!statusEnabled, ctx),
          toggleMute,
          investigate: (prompt) => {
            ctx.ui.setEditorText(prompt);
            ctx.ui.notify("Investigation prompt is in the editor: edit it or press Enter to send.", "info");
          },
          loadTrends: async () => (await loadTrends(trends.dir)).days,
          maxAgeMs: loaded.config.statusLine.refreshSeconds * 1000,
        }),
      // Full screen: a partial overlay lets the transcript show around it.
      { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left" } },
    );
  }

  pi.on("session_start", async (_event, ctx) => {
    loaded = loadConfig(path);
    if (ctx.hasUI) for (const problem of loaded.problems) ctx.ui.notify(`Loggly configuration: ${problem}`, "warning");
    void pruneResults(resultsDir).catch(() => {});
    trendController = new AbortController();
    reportController = new AbortController();
    const every = loaded.config.trends.saveEveryDays;
    if (every && ctx.hasUI) {
      // Reads only the trends directory; Loggly is asked only when enough days are waiting.
      const waiting = await trends.waitingDays().catch(() => undefined);
      if (waiting === undefined || waiting >= every) void updateTrends(ctx, "saved");
    }
    statusEnabled = loaded.config.statusLine.enabled;
    if (statusEnabled && ctx.hasUI) startStatus(ctx);
  });

  pi.on("session_shutdown", () => {
    stopStatus();
    trendController.abort();
    reportController.abort();
    monitor.cancel();
  });
}

const TRENDS_USAGE = "Usage: /loggly trends [every <days> | off]: no argument saves now; every <days> saves at Pi start when that many complete days are waiting (1 to 365).";

function describeTrendUpdate(update: TrendUpdate, dir: string, every: number): string {
  if (update.busy) return "Another Pi session is saving Loggly trends. Try again in a few minutes.";
  const span = update.stored.length ? `${plural(update.stored.length, "day")} stored, ${update.stored[0]} to ${update.stored.at(-1)}` : "no days stored";
  const saved = update.captured.length ? `saved ${plural(update.captured.length, "new day")}` : "up to date";
  const schedule = every ? `Saved at Pi start when ${every} or more complete days are waiting.` : "Run /loggly trends every <days> to save them at Pi start.";
  return `Loggly trends ${saved}: ${span} (${dir}). ${schedule}`;
}

/** A schedule for /loggly trends every: a quarter of Loggly's retention leaves room for days Pi is not opened. 7 until retention is known. */
export function suggestedSchedule(retentionDays: number | undefined): number {
  return retentionDays === undefined ? 7 : Math.max(1, Math.floor(retentionDays / 4));
}

/** A warning when the schedule can let days age out of Loggly before they are saved. */
export function scheduleRisk(every: number, retentionDays: number | undefined): string | undefined {
  if (!every || retentionDays === undefined || every <= retentionDays - 2) return undefined;
  return `Loggly keeps logs for ${plural(retentionDays, "day")}, so saving trends only when ${every} days are waiting loses days. Use /loggly trends every ${suggestedSchedule(retentionDays)}, which also allows for days Pi is not opened.`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export default function logglyExtension(pi: ExtensionAPI): void {
  registerLoggly(pi);
}
