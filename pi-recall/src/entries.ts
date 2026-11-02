import type {
  BranchSummaryEntry,
  CompactionEntry,
  CustomMessageEntry,
  SessionEntry,
  SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import type { ReadonlySession } from "./sessions.ts";

/**
 * Entry types worth recalling. Labels, context edits and session names are attached to other entries
 * or sessions instead. Model and thinking-level changes, usage and extension state are left out: they
 * say nothing about the conversation, and assistant messages already record their model.
 */
export type RecalledEntry = SessionMessageEntry | CompactionEntry | BranchSummaryEntry | CustomMessageEntry;

const RECALLED_TYPES = new Set(["message", "compaction", "branch_summary", "custom_message"]);

/** The block of critical marks brought back into context, which only repeats messages recalled where they were said. */
export const MARKS_MESSAGE_TYPE = "pi-recall/marks";

const isRepeat = (entry: SessionEntry) => entry.type === "custom_message" && entry.customType === MARKS_MESSAGE_TYPE;

export function isRecalled(entry: SessionEntry): entry is RecalledEntry {
  return RECALLED_TYPES.has(entry.type) && !isRepeat(entry);
}

export interface EntryNotes {
  label?: string;
  contextEdit?: "removed" | "replaced";
}

export interface SessionView {
  /** Recalled entries on the active branch, oldest first. */
  entries: RecalledEntry[];
  notes(id: string): EntryNotes;
  /** Why an entry on the branch is not in `entries`, or undefined if it is or is not on the branch. */
  excluded(id: string): string | undefined;
  /** The result of a tool call on the branch, even if it is in context or on another page. */
  toolResult(callId: string): SessionMessageEntry | undefined;
  /** Whether an assistant message on the branch made this tool call. */
  hasCall(callId: string): boolean;
}

/** Ids of entries that contribute their original, unedited message to the model's context. */
export function inContextIds(sm: ReadonlySession): Set<string> {
  const projection = sm.buildSessionProjection();
  const edited = new Set(
    projection.entries.flatMap(({ sourceEntry }) => (sourceEntry.type === "context_edit" ? [sourceEntry.targetId] : [])),
  );
  return new Set(
    projection.entries
      .filter(({ sourceEntry, messages }) => messages.length > 0 && !edited.has(sourceEntry.id))
      .map(({ sourceEntry }) => sourceEntry.id),
  );
}

export function sessionView(sm: ReadonlySession, skipInContext: boolean): SessionView {
  const branch = sm.getBranch();
  const edits = new Map<string, EntryNotes["contextEdit"]>();
  for (const entry of branch) {
    if (entry.type === "context_edit") edits.set(entry.targetId, entry.replacement === null ? "removed" : "replaced");
  }
  const inContext = skipInContext ? inContextIds(sm) : new Set<string>();
  const onBranch = new Map(branch.map((entry) => [entry.id, entry]));
  const results = new Map<string, SessionMessageEntry>();
  const calls = new Set<string>();
  for (const entry of branch) {
    if (entry.type !== "message") continue;
    const { message } = entry;
    if (message.role === "toolResult") results.set(message.toolCallId, entry);
    if (message.role === "assistant") {
      for (const block of message.content) if (block.type === "toolCall") calls.add(block.id);
    }
  }

  return {
    entries: branch.filter((entry): entry is RecalledEntry => isRecalled(entry) && !inContext.has(entry.id)),
    notes(id) {
      const notes: EntryNotes = {};
      const label = sm.getLabel(id);
      if (label) notes.label = label;
      const edit = edits.get(id);
      if (edit) notes.contextEdit = edit;
      return notes;
    },
    toolResult: (callId) => results.get(callId),
    hasCall: (callId) => calls.has(callId),
    excluded(id) {
      const entry = onBranch.get(id);
      if (!entry) return undefined;
      if (isRepeat(entry)) return `entry ${id} repeats messages marked critical, which are recalled where they were said`;
      if (!isRecalled(entry)) return `entry ${id} has type ${entry.type}, which is not recalled`;
      if (inContext.has(id)) return `entry ${id} is in your context; pass includeContext true to read it`;
      return undefined;
    },
  };
}
