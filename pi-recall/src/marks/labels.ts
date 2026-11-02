import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ReadonlySession } from "../sessions.ts";

/** The pi label a mark shows as in /tree. */
export const TREE_LABEL = "critical";

type Session = Pick<ReadonlySession, "getSessionId" | "getEntry" | "getLabel">;

/**
 * Shows marks on the current session's entries as pi labels, so /tree shows them. A label is an entry in the
 * session, so changes wait until pi is idle: written during a tool call, one would land between the call and
 * its result. A label the user set is never replaced or cleared.
 */
export class TreeLabels {
  /** Whether each entry should show as marked, by entry id, for the session in sessionId. */
  private pending = new Map<string, boolean>();
  private sessionId: string | undefined;

  constructor(private readonly setLabel: (entryId: string, label: string | undefined) => void) {}

  /** Records a mark or unmark on an entry, and labels it now if pi is idle. Other sessions are left alone. */
  request(ctx: Pick<ExtensionContext, "sessionManager" | "isIdle">, sessionId: string, entryId: string, marked: boolean) {
    const sm = ctx.sessionManager;
    if (sessionId !== sm.getSessionId()) return;
    if (this.sessionId !== sessionId) {
      this.pending.clear();
      this.sessionId = sessionId;
    }
    this.pending.set(entryId, marked);
    if (ctx.isIdle()) this.flush(sm);
  }

  /** Applies waiting changes, dropping them if the session has changed since. */
  flush(sm: Session) {
    const changes = this.sessionId === sm.getSessionId() ? [...this.pending] : [];
    this.pending.clear();
    for (const [entryId, marked] of changes) {
      if (!sm.getEntry(entryId)) continue;
      const label = sm.getLabel(entryId);
      if (marked && label === undefined) this.setLabel(entryId, TREE_LABEL);
      else if (!marked && label === TREE_LABEL) this.setLabel(entryId, undefined);
    }
  }

  register(pi: Pick<ExtensionAPI, "on">) {
    pi.on("agent_settled", (_event, ctx) => this.flush(ctx.sessionManager));
    pi.on("session_shutdown", () => this.pending.clear());
  }
}
