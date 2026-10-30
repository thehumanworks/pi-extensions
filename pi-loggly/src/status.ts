import type { ExtensionContext, ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import type { HealthIssue, HealthSnapshot, OverallStatus } from "./analysis/health.ts";
import type { StatusLineConfig } from "./config.ts";
import type { HealthMonitor, MonitorState } from "./monitor.ts";
import { clip } from "./text.ts";

export const STATUS_KEY = "loggly";

type StatusTheme = Pick<Theme, "fg">;

const OVERALL: Record<OverallStatus, { icon: string; color: "success" | "warning" | "error"; label: string }> = {
  healthy: { icon: "●", color: "success", label: "healthy" },
  degraded: { icon: "▲", color: "warning", label: "degraded" },
  critical: { icon: "✖", color: "error", label: "critical" },
};

/** Critical and warning issues, most pressing first. Notices never rotate onto the status line. */
export function pressingIssues(snapshot: HealthSnapshot): HealthIssue[] {
  return snapshot.issues.filter((issue) => issue.severity !== "notice");
}

/** One status-line string for the current monitor state, showing pressing issue `index` (modulo). */
export function formatStatusLine(state: MonitorState, theme: StatusTheme, index = 0): string {
  const snapshot = state.snapshot;
  if (!snapshot) {
    if (state.error) return theme.fg("warning", "◌ loggly unavailable") + theme.fg("dim", ` · ${clip(state.error, 60)}`);
    return theme.fg("dim", "◌ loggly checking…");
  }
  const overall = OVERALL[snapshot.status];
  const stale = state.error ? theme.fg("warning", " ⚠ stale") : "";
  const pressing = pressingIssues(snapshot);
  if (!pressing.length) {
    const notices = snapshot.issues.length;
    const detail = ` · ${snapshot.systems.length} systems${notices ? ` · ${notices} chronic` : ""}`;
    return theme.fg(overall.color, `${overall.icon} loggly ${overall.label}`) + theme.fg("dim", detail) + stale;
  }
  const critical = pressing.filter((issue) => issue.severity === "critical").length;
  const warnings = pressing.length - critical;
  const counts = [critical ? `${critical} critical` : "", warnings ? `${warnings} warning${warnings === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ");
  const issue = pressing[((index % pressing.length) + pressing.length) % pressing.length]!;
  const position = pressing.length > 1 ? theme.fg("dim", ` [${pressing.indexOf(issue) + 1}/${pressing.length}]`) : "";
  const pattern = issue.patterns?.[0];
  const message = pattern ? theme.fg("dim", ` “${clip(pattern.template, 70)}”`) : "";
  const color = issue.severity === "critical" ? "error" : "warning";
  return (
    theme.fg(overall.color, `${overall.icon} loggly ${counts}`) +
    theme.fg("dim", " │ ") +
    theme.fg(color, clip(issue.system ?? "all systems", 32)) +
    " " +
    issue.summary +
    message +
    position +
    stale
  );
}

/** Where the status line is drawn: one line of text, or nothing. */
export interface StatusDisplay {
  show(text: string): void;
  clear(): void;
}

/**
 * The status line's own row, directly above Pi's footer. Pi joins every
 * extension's footer status into one shared row cut at the pane width, where
 * Loggly could be pushed out of sight. In the TUI the row is cut to the pane
 * width rather than wrapped, so rotating issues never change the layout; RPC
 * clients only take lines of text, so they get those.
 */
export function statusRow(ui: Pick<ExtensionUIContext, "setWidget">, mode: ExtensionContext["mode"]): StatusDisplay {
  const options = { placement: "belowEditor" as const };
  if (mode !== "tui") {
    return { show: (text) => ui.setWidget(STATUS_KEY, [text], options), clear: () => ui.setWidget(STATUS_KEY, undefined) };
  }
  let row: StatusRow | undefined;
  return {
    show(text) {
      if (row) return row.set(text);
      ui.setWidget(
        STATUS_KEY,
        (tui) => {
          // Pi disposes the row when it removes the widget; the next update then adds a new one.
          const created: StatusRow = new StatusRow(tui, text, () => {
            if (row === created) row = undefined;
          });
          row = created;
          return created;
        },
        options,
      );
    },
    clear() {
      row = undefined;
      ui.setWidget(STATUS_KEY, undefined);
    },
  };
}

class StatusRow implements Component {
  readonly #tui: Pick<TUI, "requestRender">;
  readonly #onDispose: () => void;
  #text: string;

  constructor(tui: Pick<TUI, "requestRender">, text: string, onDispose: () => void) {
    this.#tui = tui;
    this.#text = text;
    this.#onDispose = onDispose;
  }

  set(text: string): void {
    if (text === this.#text) return;
    this.#text = text;
    this.#tui.requestRender();
  }

  render(width: number): string[] {
    return [truncateToWidth(this.#text, width, "…")];
  }

  invalidate(): void {}

  dispose(): void {
    this.#onDispose();
  }
}

/**
 * Keeps the status row in sync with the monitor, rotates through pressing
 * issues and notifies when a new critical issue appears.
 */
export class StatusLine {
  readonly #monitor: HealthMonitor;
  readonly #ui: Pick<ExtensionUIContext, "notify" | "theme">;
  readonly #display: StatusDisplay;
  readonly #config: StatusLineConfig;
  #unsubscribe?: () => void;
  #rotation?: ReturnType<typeof setInterval>;
  #index = 0;
  #seenCritical?: Set<string>;
  #lastSnapshot?: HealthSnapshot;

  constructor(monitor: HealthMonitor, ui: Pick<ExtensionUIContext, "notify" | "theme">, display: StatusDisplay, config: StatusLineConfig) {
    this.#monitor = monitor;
    this.#ui = ui;
    this.#display = display;
    this.#config = config;
  }

  get active(): boolean {
    return this.#unsubscribe !== undefined;
  }

  start(): void {
    if (this.active) return;
    this.#unsubscribe = this.#monitor.subscribe((state) => this.#onState(state));
    this.#rotation = setInterval(() => {
      const snapshot = this.#monitor.state.snapshot;
      if (snapshot && pressingIssues(snapshot).length > 1) {
        this.#index++;
        this.#render();
      }
    }, this.#config.rotateSeconds * 1000);
    this.#rotation.unref?.();
    this.#render();
    this.#monitor.start(this.#config.refreshSeconds * 1000);
  }

  stop(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    if (this.#rotation) clearInterval(this.#rotation);
    this.#rotation = undefined;
    this.#monitor.stop();
    this.#display.clear();
  }

  #onState(state: MonitorState): void {
    if (state.snapshot && state.snapshot !== this.#lastSnapshot) {
      // A re-evaluation (such as a mute) keeps the timestamp: not a new check.
      const fresh = state.snapshot.generatedAt !== this.#lastSnapshot?.generatedAt;
      this.#lastSnapshot = state.snapshot;
      if (fresh) {
        this.#index = 0;
        this.#notifyNewCritical(state.snapshot);
      }
    }
    this.#render();
  }

  #notifyNewCritical(snapshot: HealthSnapshot): void {
    const critical = snapshot.issues.filter((issue) => issue.severity === "critical");
    const fresh = critical.filter((issue) => !this.#seenCritical?.has(issue.id));
    this.#seenCritical = new Set(critical.map((issue) => issue.id));
    if (!this.#config.notify || !fresh.length) return;
    const lines = fresh.slice(0, 3).map((issue) => `${issue.system ?? "all systems"}: ${issue.summary}${issue.patterns?.[0] ? ` — “${clip(issue.patterns[0].template, 80)}”` : ""}`);
    const more = fresh.length > 3 ? `\n…and ${fresh.length - 3} more. Open /loggly for details.` : "\nOpen /loggly for details.";
    this.#ui.notify(`Loggly: ${fresh.length === 1 ? "new critical issue" : `${fresh.length} new critical issues`}\n${lines.join("\n")}${more}`, "warning");
  }

  #render(): void {
    this.#display.show(formatStatusLine(this.#monitor.state, this.#ui.theme, this.#index));
  }
}
