import { BorderedLoader, type ExtensionCommandContext, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { RecallScreen } from "../command/ui.ts";
import { type CreateSummaryOptions, type ListSummaryOptions, SummaryService } from "./service.ts";
import { type StoredSummary, summaryMetadata } from "./store.ts";

const USAGE = "Usage: /recall summary [create [project | <session_id>] | list [session [<requesting_session_id>] | project [<project>] | all] | read <summary_id>]";
export type SummaryArgs =
  | { action: "create"; options: CreateSummaryOptions }
  | { action: "list"; options: ListSummaryOptions }
  | { action: "read"; id: string };

export function parseSummaryArgs(args: string): SummaryArgs {
  const words = args.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return { action: "create", options: {} };
  if (words[0] === "create" && words.length <= 2) {
    const target = words[1];
    if (target === "all") throw new Error("Cross-project generation is not supported; use create project for this project");
    return { action: "create", options: target === "project" ? { scope: "project" } : target ? { sessionId: target } : {} };
  }
  if (words[0] === "read" && words.length === 2) return { action: "read", id: words[1]! };
  if (words[0] === "list") {
    if (words.length === 1) return { action: "list", options: {} };
    if (words[1] === "all" && words.length === 2) return { action: "list", options: { scope: "all" } };
    if (words[1] === "session" && words.length <= 3) return { action: "list", options: { scope: "session", ...(words[2] ? { sessionId: words[2] } : {}) } };
    if (words[1] === "project") {
      const project = args.trim().replace(/^list\s+project\s*/, "");
      return { action: "list", options: { scope: "project", ...(project ? { project } : {}) } };
    }
  }
  throw new Error(USAGE);
}

export function summaryCompletions(prefix: string): AutocompleteItem[] | null {
  const choices = [
    ["summary create", "Summarise this session"],
    ["summary create project", "Summarise all sessions in this project"],
    ["summary list", "Summaries requested in this session"],
    ["summary list session", "Summaries requested in a session"],
    ["summary list project", "Summaries across sessions in a project"],
    ["summary list all", "Summaries across all projects"],
    ["summary read ", "Read a stored summary by id"],
  ];
  const matches = choices.filter(([value]) => value!.startsWith(prefix)).map(([value, description]) => ({ value: value!, label: value!, description }));
  return matches.length > 0 ? matches : null;
}

async function showSummary(ctx: ExtensionCommandContext, summary: StoredSummary) {
  const meta = summaryMetadata(summary);
  const content = [
    `Project: ${summary.project}`,
    `Scope: ${summary.scope.kind}${summary.scope.kind === "session" ? ` ${summary.scope.sessionId}` : ""}`,
    `Requested in: ${summary.requesterSessionId} · by ${summary.requestedBy}`,
    `Snapshot: ${summary.requestedAt} · completed: ${summary.completedAt}`,
    `Model: ${summary.model.provider}/${summary.model.id}`,
    `${meta.messageCount} conversation messages across ${meta.sessionCount} sessions`,
    "", "---", "", summary.text,
  ].join("\n\n");
  await ctx.ui.custom((tui, theme, keybindings, done) => new RecallScreen({
    tui, theme, keybindings, markdownTheme: getMarkdownTheme(), title: `Recall · summary ${summary.id}`,
    sessionLabels: new Map(), selected: [], done,
    single: {
      sessionId: summary.requesterSessionId, notes: {},
      entry: { type: "custom_message", customType: "Saved summary", id: summary.id, parentId: null,
        timestamp: summary.completedAt, content, display: true },
    },
  }));
}

/** Called by /recall after its TUI guard. Neither browsing nor display injects messages into context. */
export async function handleSummaryCommand(args: string, ctx: ExtensionCommandContext, service: SummaryService) {
  const parsed = parseSummaryArgs(args);
  if (parsed.action === "read") return showSummary(ctx, await service.store.get(parsed.id));
  if (parsed.action === "create") {
    const result = await ctx.ui.custom<{ summary?: StoredSummary; error?: unknown }>((tui, theme, _keys, done) => {
      const loader = new BorderedLoader(tui, theme, "Summarising conversation · one request per project");
      // Wait for cancellation cleanup before closing, rather than releasing the UI while a call is still running.
      service.create(ctx, { ...parsed.options, requestedBy: "user", signal: loader.signal })
        .then(({ summary }) => done({ summary }), (error: unknown) => done({ error }));
      return loader;
    });
    if (result?.error) throw result.error;
    if (result?.summary) await showSummary(ctx, result.summary);
    return;
  }

  const cursors: (string | undefined)[] = [undefined];
  let page = 0;
  for (;;) {
    const result = await service.list(ctx, { ...parsed.options, cursor: cursors[page] });
    const labels = result.summaries.map((summary) =>
      `${summary.completedAt} · ${summary.scope.kind} · ${summary.messageCount} messages · ${summary.project} · ${summary.id}`);
    const previous = "← Previous page";
    const next = "Next page →";
    const choices = [...labels, ...(page > 0 ? [previous] : []), ...(result.next ? [next] : [])];
    if (choices.length === 0) {
      ctx.ui.notify("No saved summaries for this scope", "info");
      return;
    }
    const choice = await ctx.ui.select(`Saved summaries · ${parsed.options.scope ?? "session"} · page ${page + 1}`, choices);
    if (choice === undefined) return;
    if (choice === previous) { page--; continue; }
    if (choice === next) { cursors[++page] = result.next!; continue; }
    const summary = result.summaries[labels.indexOf(choice)];
    if (summary) await showSummary(ctx, await service.store.get(summary.id));
  }
}
