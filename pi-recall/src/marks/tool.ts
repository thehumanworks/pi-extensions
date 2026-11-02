import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionContext, defineTool, getAgentDir } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { clip, entryClip } from "../format.ts";
import { jsonResult } from "../result.ts";
import { projectIndex, resolveScope } from "../projects.ts";
import type { TreeLabels } from "./labels.ts";
import { loadMarks, markLookup, MarkStore, unreviewed } from "./store.ts";
import { RELATIVE_TARGETS, resolveTarget } from "./target.ts";

const STATUS_KEY = "pi-recall-marks";

/**
 * Shows how many of the agent's marks and unmarks the user has not reviewed, in pi's footer: those in this
 * project and the projects its .recallrc lists. Returns the count.
 */
export async function refreshStatus(ctx: Pick<ExtensionContext, "ui" | "sessionManager">): Promise<number> {
  const scope = await resolveScope(ctx.sessionManager);
  const n = unreviewed(await loadMarks(scope.index, scope.projects)).length;
  ctx.ui.setStatus(STATUS_KEY, n === 0 ? undefined : ctx.ui.theme.fg("warning", `◆ ${n} unreviewed mark${n === 1 ? "" : "s"} · /recall marks`));
  return n;
}

/** Longest guidance read from the guidance file. */
export const GUIDANCE_MAX = 1500;

/** When to mark, as the tool's description says it unless the guidance file replaces it. */
export const DEFAULT_GUIDANCE =
  "Mark when the user states a decision, requirement or preference that later work must follow; when the user approves or rejects " +
  "a direction you proposed (mark your proposal with previous_reply, and say in reason what was decided); when a mistake or wrong " +
  "assumption should not be repeated; or when the direction of the work changes, and why. Do not mark routine progress, questions, " +
  "plans not yet agreed, or what is easy to find again. Mark rarely: a few times per session at most.";

/** The guidance file, which tunes when the agent marks without changing how the tool works. */
export function guidancePath(agentDir = getAgentDir()): string {
  return join(agentDir, "pi-recall", "guidance", "recall_mark.md");
}

export function loadGuidance(path = guidancePath()): string {
  try {
    const text = readFileSync(path, "utf8").trim();
    return text ? text.slice(0, GUIDANCE_MAX) : DEFAULT_GUIDANCE;
  } catch {
    return DEFAULT_GUIDANCE;
  }
}

interface MarkDetails {
  [key: string]: string;
  ref: string;
  action: "mark" | "unmark";
  reason: string;
  message: string;
}

/** labels shows marks on the current session in /tree. */
export function createMarkTool(guidance = DEFAULT_GUIDANCE, labels?: TreeLabels) {
  return defineTool({
    name: "recall_mark",
    label: "Mark Critical",
    description:
      "Mark a message in this project's history as critical, or unmark it. The newest critical messages are brought back into context " +
      "at the start of later sessions and after compaction, with their reason. target is last_user (the user's latest message), " +
      "previous_reply (your reply before it), or a ref or id from recall_messages or recall_search, in any project; a tool call or output resolves " +
      "to the message it belongs to. reason says in one sentence what to remember. A mark takes effect at once; the user sees each one " +
      "and can reverse it. Unmark when a marked decision is reversed or no longer holds. " +
      guidance,
    promptSnippet: "Mark a message critical so later sessions are reminded of it",
    parameters: Type.Object({
      target: Type.String({ minLength: 1, description: `${RELATIVE_TARGETS.join(", ")}, or a ref or id from the recall tools` }),
      action: Type.Optional(StringEnum(["mark", "unmark"] as const, { default: "mark" })),
      reason: Type.String({ minLength: 1, maxLength: 300, description: "What to remember, or why the mark no longer holds" }),
    }),
    outputSchema: Type.Object({
      ref: Type.String({ description: "The message marked or unmarked" }),
      marked: Type.Boolean(),
      reason: Type.String(),
      message: Type.String({ description: "The start of the message" }),
      unreviewed: Type.Integer({ description: "Marks and unmarks the user has not reviewed yet" }),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
      const action = params.action ?? "mark";
      const sm = ctx.sessionManager;
      const index = await projectIndex(sm);
      const { sessionId, entry, sources } = await resolveTarget(sm, index, params.target, signal);
      const projects = [...new Set(sources.map((source) => source.project))];
      const existing = markLookup(await loadMarks(index, projects), sources)(sessionId, entry.id);
      if (action === "unmark" && !existing?.marked) throw new Error(`${sessionId}/${entry.id} is not marked`);
      // An unmark clears the mark where it was made, which may be the session this one was forked from.
      const ref = action === "unmark" ? existing!.ref : `${sessionId}/${entry.id}`;
      // Marks are kept with the project whose history they are on.
      await MarkStore.forSessionId(index, ref.slice(0, ref.indexOf("/"))).append({ op: action, ref, by: "agent", reason: params.reason, session: sm.getSessionId() });
      labels?.request(ctx, sessionId, entry.id, action === "mark");
      const count = await refreshStatus(ctx);
      const message = clip(entryClip(entry), 120);
      const details: MarkDetails = { ref, action, reason: params.reason, message };
      return jsonResult({ ref, marked: action === "mark", reason: params.reason, message, unreviewed: count }, details);
    },
    renderCall(args, theme) {
      const action = args.action === "unmark" ? "unmark" : "mark";
      return new Text(`${theme.fg("toolTitle", theme.bold("recall_mark "))}${theme.fg("accent", action)} ${theme.fg("muted", args.target ?? "")}`, 0, 0);
    },
    renderResult(result, { isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("dim", "Marking…"), 0, 0);
      const details = result.details as MarkDetails | undefined;
      if (!details?.ref) {
        const content = result.content[0];
        return new Text(theme.fg("error", content?.type === "text" ? content.text : "Mark failed"), 0, 0);
      }
      const head = details.action === "mark" ? theme.fg("warning", "◆ marked critical") : theme.fg("warning", "◇ unmarked");
      return new Text(`${head} ${theme.fg("muted", `"${details.message}"`)} ${theme.fg("dim", "—")} ${details.reason}`, 0, 0);
    },
  });
}
