import { registerPiBot } from "@nothumanwork/bot/pi";
import type { BotRunRecord } from "@nothumanwork/bot";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

/** Pi is a UI/client of the bot SDK. No bot runtime or persistence policy lives here. */
export default function piBot(pi: ExtensionAPI): void {
  registerPiBot(pi);
  pi.registerToolRenderer((toolName, next) => {
    if (toolName !== "bot_run") return next();
    return {
      renderCall(input, theme) {
        const args = input && typeof input === "object" ? input as { task?: string; bot?: string } : {};
        const task = String(args.task ?? "").replace(/\s+/g, " ");
        return new Text(`${theme.fg("toolTitle", theme.bold("bot_run "))}${theme.fg("accent", String(args.bot ?? "…"))}\n  ${task.slice(0, 120)}${task.length > 120 ? "…" : ""}`, 0, 0);
      },
      renderResult(result, { expanded, isPartial }, theme) {
        const details = result.details as Partial<BotRunRecord> | undefined;
        const body = details?.output || details?.error || result.content.filter(part => part.type === "text").map(part => part.text).join("\n") || "(working…)";
        const lines = body.split("\n");
        const shown = expanded ? body : lines.slice(0, 8).join("\n") + (lines.length > 8 ? `\n… ${lines.length - 8} more lines` : "");
        const icon = isPartial ? "⏳" : details?.status === "completed" ? "✓" : "✗";
        const footer = details?.sessionId ? `\nsession ${details.sessionId} · run ${details.runId}` : "";
        return new Text(`${theme.fg("toolTitle", `${icon} ${details?.bot ?? "bot"}`)}\n${shown}${theme.fg("dim", footer)}`, 0, 0);
      },
    };
  });
  pi.registerMessageRenderer("bot-reply", (message, { expanded }, theme) => {
    const record = message.details as BotRunRecord;
    const content = typeof message.content === "string" ? message.content : message.content.filter(part => part.type === "text").map(part => part.text).join("\n");
    const lines = content.split("\n");
    const shown = expanded ? content : lines.slice(0, 24).join("\n") + (lines.length > 24 ? "\n… (expand for the full reply)" : "");
    return new Text(`${theme.fg("accent", record.bot)} · ${record.status}\n${shown}\n${theme.fg("dim", `session ${record.sessionId} · run ${record.runId}`)}`, 0, 0);
  });
}
