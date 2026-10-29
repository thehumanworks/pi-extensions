import { stripVTControlCharacters } from "node:util";
import type { UsageResult, UsageWindow } from "./types.ts";

/** Provider labels and account metadata are data, not terminal control sequences. */
export function safeText(value: string): string {
  return stripVTControlCharacters(value)
    .replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ")
    .slice(0, 240);
}

export function formatReset(resetsAt: number | undefined, now: number): string {
  if (resetsAt === undefined) return "Reset time not reported";
  if (resetsAt <= now) return "Reset time passed — refresh to update";
  const minutes = Math.max(1, Math.ceil((resetsAt - now) / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  const relative = [days ? `${days}d` : "", hours ? `${hours}h` : "", mins ? `${mins}m` : ""].filter(Boolean).join(" ");
  const date = new Date(resetsAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short" });
  return `Resets in ${relative} · ${date}`;
}

export function formatWindow(window: UsageWindow, now: number): string[] {
  const label = safeText(window.label);
  if (window.remainingPercent === undefined) return [`${label}: Not reported`, `  ${formatReset(window.resetsAt, now)}`];
  const left = Math.max(0, Math.min(100, window.remainingPercent));
  const percent = window.display === "used" ? 100 - left : left;
  const filled = Math.round(percent / 5);
  const bar = "█".repeat(filled) + "░".repeat(20 - filled);
  return [
    `${label}: [${bar}] ${Math.round(percent * 10) / 10}% ${window.display === "used" ? "used" : "left"}`,
    `  ${formatReset(window.resetsAt, now)}`,
  ];
}

export function formatUsage(results: readonly UsageResult[], now = Date.now()): string {
  return results.map((result) => {
    const lines = [safeText(result.provider.label)];
    if (result.status !== "ok") {
      lines.push(`${result.status === "unavailable" ? "Unavailable" : "Error"}: ${safeText(result.message)}`);
    } else {
      const data = result.snapshot;
      lines.push(`Account: ${safeText(data.account)}`);
      if (data.plan) lines.push(`Plan: ${safeText(data.plan)}`);
      lines.push(`Source: ${safeText(data.source)}`);
      lines.push(`Checked: ${new Date(data.fetchedAt).toLocaleString()}`);
      if (!data.groups.length) lines.push("", "No allowance windows reported (not necessarily unlimited).");
      for (const group of data.groups) {
        lines.push("", safeText(group.label));
        if (group.limitReached) lines.push("Limit reached / usage currently restricted");
        if (!group.windows.length) lines.push("No allowance windows reported (not necessarily unlimited).");
        for (const window of group.windows) lines.push(...formatWindow(window, now));
      }
      if (data.credits) {
        const credits = data.credits;
        const balance = credits.unlimited ? "Unlimited"
          : credits.balance != null ? safeText(credits.balance)
          : credits.hasCredits === false ? "None"
          : credits.hasCredits === true ? "Available (balance not reported)" : "Not reported";
        lines.push("", `Credits: ${balance}`);
      }
      lines.push("", ...data.notes.map(safeText));
    }
    lines.push(`Manage usage: ${safeText(result.provider.dashboardUrl)}`);
    return lines.join("\n");
  }).join("\n\n────────────────────────────────────────\n\n");
}
