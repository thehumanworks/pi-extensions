import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { type ExtensionAPI, type ExtensionCommandContext, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { sessionView } from "../entries.ts";
import { clip } from "../format.ts";
import { readHistory } from "../recall.ts";
import { ALL_PROJECTS, type Project, type ProjectIndex, projectIndex, projectName, resolveScope, type Scope, type ScopeContext, SETTINGS_KEY } from "../projects.ts";
import { listSessions, type ReadonlySession, type SessionSource } from "../sessions.ts";
import type { TreeLabels } from "../marks/labels.ts";
import { refreshStatus } from "../marks/tool.ts";
import { Attachments, type RecallItem } from "./attach.ts";
import { markControls, markItems } from "./marks.ts";
import { type RecallPage, RecallScreen } from "./ui.ts";
import { handleSummaryCommand, summaryCompletions } from "../summaries/command.ts";
import { SummaryService } from "../summaries/service.ts";

/** Entries loaded per page as the list scrolls. */
const PAGE = 50;

export type RecallArgs =
  | { kind: "list" }
  | { kind: "summary"; args: string }
  | { kind: "marks" }
  | { kind: "projects" }
  | { kind: "all" }
  | { kind: "session"; sessionId: string }
  | { kind: "show"; entryId: string };

export function parseArgs(args: string): RecallArgs {
  const words = args.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return { kind: "list" };
  if (words[0] === "summary") return { kind: "summary", args: args.trim().slice("summary".length).trim() };
  if (words.length === 1 && (words[0] === "marks" || words[0] === "projects" || words[0] === ALL_PROJECTS)) {
    return { kind: words[0] === ALL_PROJECTS ? "all" : (words[0] as "marks" | "projects") };
  }
  if (words[0] === "show") {
    if (words.length !== 2) throw new Error("Usage: /recall show <message_id> or <session_id>/<message_id>");
    return { kind: "show", entryId: words[1]! };
  }
  if (words.length !== 1) throw new Error("Usage: /recall [<session_id> | marks | projects | all | show <message_id>]");
  return { kind: "session", sessionId: words[0]! };
}

/** The session with this id, or the only one whose id starts with it. */
export function resolveSession(sources: SessionSource[], id: string): SessionSource {
  const exact = sources.find((source) => source.summary.sessionId === id);
  if (exact) return exact;
  const matches = sources.filter((source) => source.summary.sessionId.startsWith(id));
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) throw new Error(`No session ${id} in this project`);
  throw new Error(`Session ${id} is ambiguous: ${matches.map((m) => m.summary.sessionId).join(", ")}`);
}

/** These sessions if one has this id or starts with it, otherwise the sessions of the project that has it. */
export async function sessionsWith(sm: ReadonlySession, index: ProjectIndex, sources: SessionSource[], id: string): Promise<SessionSource[]> {
  if (sources.some((source) => source.summary.sessionId.startsWith(id))) return sources;
  const ids = [...index.sessions.keys()];
  const found = ids.includes(id) ? [id] : ids.filter((sid) => sid.startsWith(id));
  if (found.length === 0) throw new Error(`No session ${id} in any project`);
  if (found.length > 1) throw new Error(`Session ${id} is ambiguous: ${found.join(", ")}`);
  return listSessions(sm, [index.sessions.get(found[0]!)!]);
}

/** Entries with this id, in one session for `session/entry`, otherwise in every session. */
export async function findEntries(sources: SessionSource[], ref: string): Promise<RecallItem[]> {
  const slash = ref.indexOf("/");
  const scope = slash === -1 ? sources : [resolveSession(sources, ref.slice(0, slash))];
  const entryId = slash === -1 ? ref : ref.slice(slash + 1);
  const found: RecallItem[] = [];
  for (const source of scope) {
    const view = sessionView(await source.load(), false);
    const entry = view.entries.find((e) => e.id === entryId);
    if (entry) found.push({ sessionId: source.summary.sessionId, entry, notes: view.notes(entry.id) });
    else if (slash !== -1) throw new Error(view.excluded(entryId) ?? `No entry ${entryId} in session ${source.summary.sessionId}`);
  }
  if (found.length === 0) throw new Error(`No entry ${entryId} in this project`);
  return found;
}

export function sessionLabel(source: SessionSource): string {
  return source.summary.name ?? source.summary.firstMessage;
}

export async function completions(ctx: ScopeContext | undefined, prefix: string): Promise<AutocompleteItem[] | null> {
  if (prefix.startsWith("summary ")) return summaryCompletions(prefix);
  if (prefix.includes(" ")) return null;
  const items: AutocompleteItem[] = [
    { value: "marks", label: "marks", description: "Review messages marked critical" },
    { value: "projects", label: "projects", description: "Browse another project's history" },
    { value: ALL_PROJECTS, label: ALL_PROJECTS, description: "Browse every project's history" },
    { value: "show ", label: "show", description: "Show one entry in full" },
    { value: "summary", label: "summary", description: "Create, list or read saved conversation summaries" },
  ];
  if (ctx) {
    for (const { summary } of await listSessions(ctx.sessionManager, (await resolveScope(ctx)).projects)) {
      items.push({
        value: summary.sessionId,
        label: summary.sessionId,
        description: clip(`${summary.current ? "(current) " : ""}${summary.name ?? summary.firstMessage}`, 80),
      });
    }
  }
  const matches = items.filter((item) => item.value.startsWith(prefix));
  return matches.length > 0 ? matches : null;
}

/** Pages of entries before the previous page, oldest first within each. */
function pager(ctx: ExtensionCommandContext, sources: SessionSource[], sessionId?: string): () => Promise<RecallPage> {
  let before: string | undefined;
  return async () => {
    const { groups, older } = await readHistory(ctx, {
      sources,
      sessionId,
      before,
      limit: PAGE,
      // A session asked for by id is shown whole; the project list skips what is still in context.
      includeContext: sessionId !== undefined,
    });
    before = older ?? undefined;
    const items = groups.flatMap(({ source, entries, notes }) =>
      entries.map((entry) => ({ sessionId: source.summary.sessionId, entry, notes: notes(entry.id) })));
    return { items, more: older !== null };
  };
}

const date = (time: number) => {
  const d = new Date(time);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** Asks which project to browse, most recently active first, noting this one, those recallConfig lists and moved ones. */
async function pickProject(ctx: ExtensionCommandContext, scope: Scope): Promise<Project | undefined> {
  const { index } = scope;
  const linked = new Set(scope.projects);
  const rows = await Promise.all(index.projects.map(async (project) => {
    const files = [...index.sessions].filter(([, p]) => p === project).flatMap(([id]) => index.files.get(id) ?? []);
    const times = await Promise.all(files.map((file) => stat(file).then((s) => s.mtimeMs, () => 0)));
    const notes = [
      project === index.current ? "this project" : linked.has(project) ? `in ${SETTINGS_KEY}` : "",
      existsSync(project.path) ? "" : "folder gone",
    ].filter(Boolean);
    const label = `${projectName(project, index.projects)} · ${files.length} session${files.length === 1 ? "" : "s"}` +
      (files.length > 0 ? ` · ${date(Math.max(...times))}` : "") + (notes.length > 0 ? ` · ${notes.join(", ")}` : "");
    return { project, label, latest: Math.max(0, ...times) };
  }));
  rows.sort((a, b) => b.latest - a.latest);
  const choice = await ctx.ui.select(`Recall from which project? ${index.projects.length} have sessions`, rows.map((row) => row.label));
  return rows.find((row) => row.label === choice)?.project;
}

export function registerRecallCommand(pi: ExtensionAPI, labels?: TreeLabels, summaries = new SummaryService()) {
  const attachments = new Attachments();
  // Argument completion has no context, so keep the one from the latest event.
  let latest: ScopeContext | undefined;

  pi.on("session_start", async (_event, ctx) => {
    latest = ctx;
    await refreshStatus(ctx).catch(() => undefined);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    attachments.clear(ctx.ui);
    latest = undefined;
  });
  pi.on("input", (event, ctx) => attachments.handleInput(event, ctx));

  pi.registerCommand("recall", {
    description: "Browse, mark and attach earlier messages; summary creates, lists or reads saved summaries",
    getArgumentCompletions: (prefix) => completions(latest, prefix),
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/recall needs the interactive terminal UI", "warning");
        return;
      }
      latest = ctx;
      try {
        const parsed = parseArgs(args);
        if (parsed.kind === "summary") {
          await handleSummaryCommand(parsed.args, ctx, summaries);
          return;
        }
        const sm = ctx.sessionManager;
        const index = await projectIndex(sm);
        const linked = await resolveScope(ctx, undefined, index);
        let scope = linked;
        let where = linked.projects.length > 1 ? ` · ${linked.projects.length} projects` : "";
        if (parsed.kind === "all") {
          scope = await resolveScope(ctx, ALL_PROJECTS, index);
          where = ` · all ${scope.projects.length} projects`;
        } else if (parsed.kind === "projects") {
          const project = await pickProject(ctx, linked);
          if (!project) return;
          scope = { index, projects: [project] };
          where = ` · ${projectName(project, index.projects)}`;
        }
        let sources = await listSessions(sm, scope.projects);
        if (parsed.kind === "session") sources = await sessionsWith(sm, index, sources, parsed.sessionId);
        if (parsed.kind === "show" && parsed.entryId.includes("/")) {
          sources = await sessionsWith(sm, index, sources, parsed.entryId.slice(0, parsed.entryId.indexOf("/")));
        }
        const sessionLabels = new Map(sources.map((source) => [source.summary.sessionId, sessionLabel(source)]));
        const sessionProjects = new Map(sources.flatMap((source) =>
          source.summary.project ? [[source.summary.sessionId, projectName(source.project, index.projects)] as const] : []));

        let title = `Recall · ${sources.length} session${sources.length === 1 ? "" : "s"}${where}`;
        let loadOlder: (() => Promise<RecallPage>) | undefined;
        let single: RecallItem | undefined;
        if (parsed.kind === "list" || parsed.kind === "all" || parsed.kind === "projects") {
          loadOlder = pager(ctx, sources);
        } else if (parsed.kind === "marks") {
          const items = await markItems(scope, sources);
          if (items.length === 0) {
            ctx.ui.notify("No messages are marked critical in this project", "info");
            return;
          }
          title = `Recall · marks · ${items.length}`;
          loadOlder = async () => ({ items, more: false });
        } else if (parsed.kind === "session") {
          const source = resolveSession(sources, parsed.sessionId);
          title = `Recall · session ${source.summary.sessionId.slice(0, 8)} · ${clip(sessionLabel(source), 50)}`;
          loadOlder = pager(ctx, sources, source.summary.sessionId);
        } else {
          const found = await findEntries(sources, parsed.entryId);
          single = found[0];
          if (found.length > 1) {
            const labels = found.map((item) => `${item.sessionId}/${item.entry.id} · ${clip(sessionLabels.get(item.sessionId) ?? "", 60)}`);
            const choice = await ctx.ui.select(`Entry ${parsed.entryId} is in ${found.length} sessions`, labels);
            if (choice === undefined) return;
            single = found[labels.indexOf(choice)];
          }
        }

        const marks = await markControls(ctx, index, sources, labels);
        const result = await ctx.ui.custom<RecallItem[] | undefined>((tui, theme, keybindings, done) =>
          new RecallScreen({
            tui,
            theme,
            keybindings,
            markdownTheme: getMarkdownTheme(),
            title,
            sessionLabels,
            sessionProjects,
            selected: attachments.selected,
            loadOlder,
            single,
            marks,
            done,
          }));
        if (result !== undefined) attachments.set(ctx.ui, result);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
