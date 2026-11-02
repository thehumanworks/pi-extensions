import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sessionView } from "../entries.ts";
import type { TreeLabels } from "../marks/labels.ts";
import { loadMarks, markLookup, type MarkState, MarkStore } from "../marks/store.ts";
import type { ProjectIndex, Scope } from "../projects.ts";
import { refreshStatus } from "../marks/tool.ts";
import type { SessionSource } from "../sessions.ts";
import { isMessage } from "../trace.ts";
import { itemKey, type RecallItem } from "./attach.ts";

/** Marking from the /recall screen, as the user. */
export interface MarkControls {
  get(item: RecallItem): MarkState | undefined;
  /** Marks the message critical, or unmarks it if it is marked. */
  toggle(item: RecallItem): Promise<void>;
  /** Records that the user has seen an agent's mark or unmark. */
  review(item: RecallItem): Promise<void>;
}

/** Marks on the messages of these sessions, kept with the project each belongs to. */
export async function markControls(
  ctx: Pick<ExtensionContext, "ui" | "sessionManager" | "isIdle">,
  index: ProjectIndex,
  sources: SessionSource[],
  labels?: TreeLabels,
): Promise<MarkControls> {
  const session = ctx.sessionManager.getSessionId();
  const projects = [...new Set(sources.map((source) => source.project))];
  const load = async () => markLookup(await loadMarks(index, projects), sources);
  let lookup = await load();
  const reload = async () => {
    lookup = await load();
    await refreshStatus(ctx);
  };
  return {
    get: (item) => lookup(item.sessionId, item.entry.id),
    async toggle(item) {
      if (!isMessage(item.entry)) throw new Error("Only messages can be marked: mark the message this belongs to");
      const current = lookup(item.sessionId, item.entry.id);
      await (current?.marked
        ? MarkStore.forSessionId(index, current.sessionId).append({ op: "unmark", ref: current.ref, by: "user", session })
        : MarkStore.forSessionId(index, item.sessionId).append({ op: "mark", ref: itemKey(item), by: "user", session }));
      labels?.request(ctx, item.sessionId, item.entry.id, !current?.marked);
      await reload();
    },
    async review(item) {
      const current = lookup(item.sessionId, item.entry.id);
      if (!current || current.reviewed) return;
      await MarkStore.forSessionId(index, current.sessionId).append({ op: "review", ref: current.ref, by: "user", session });
      await reload();
    },
  };
}

/** Marked messages and the agent's unmarks the user has not reviewed, oldest first, for /recall marks. */
export async function markItems(scope: Scope, sources: SessionSource[]): Promise<RecallItem[]> {
  const states = [...(await loadMarks(scope.index, scope.projects)).values()]
    .filter((state) => state.marked || !state.reviewed)
    .sort((a, b) => a.at.localeCompare(b.at));
  const items: RecallItem[] = [];
  for (const state of states) {
    const source = sources.find((s) => s.summary.sessionId === state.sessionId);
    if (!source) continue;
    const view = sessionView(await source.load(), false);
    const entry = view.entries.find((e) => e.id === state.entryId);
    if (entry) items.push({ sessionId: state.sessionId, entry, notes: view.notes(entry.id) });
  }
  return items;
}
