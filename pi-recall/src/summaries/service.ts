import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import type { EntryNotes, RecalledEntry } from "../entries.ts";
import { matchProjects, projectIndex } from "../projects.ts";
import { listSessions } from "../sessions.ts";
import { summarise, SUMMARISER } from "../summarise.ts";
import { conversationSource } from "./source.ts";
import { type StoredSummary, type SummaryScope, SummaryStore, summaryMetadata } from "./store.ts";

type SummaryContext = Pick<ExtensionContext, "sessionManager" | "modelRegistry">;
export interface CreateSummaryOptions {
  scope?: "session" | "project";
  sessionId?: string;
  requestedBy?: "user" | "agent";
  signal?: AbortSignal;
}
export interface ListSummaryOptions {
  scope?: "session" | "project" | "all";
  /** Requesting session, not the session summarised. */
  sessionId?: string;
  project?: string;
  limit?: number;
  cursor?: string;
}

const sameScope = (a: SummaryScope, b: SummaryScope) => a.kind === b.kind &&
  (a.kind === "project" || (b.kind === "session" && a.sessionId === b.sessionId));

export class SummaryService {
  private active = new Map<AbortController, Promise<unknown>>();

  constructor(readonly store = new SummaryStore()) {}

  async shutdown(): Promise<void> {
    for (const controller of this.active.keys()) controller.abort(new Error("Session closed during summarisation"));
    await Promise.allSettled([...this.active.values()]);
  }

  async create(ctx: SummaryContext, options: CreateSummaryOptions = {}) {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, ...(options.signal ? [options.signal] : [])]);
    const work = this.generate(ctx, { ...options, signal });
    this.active.set(controller, work);
    try {
      return await work;
    } finally {
      this.active.delete(controller);
    }
  }

  private async generate(ctx: SummaryContext, options: CreateSummaryOptions) {
    const { scope = "session", sessionId, requestedBy = "agent" } = options;
    if (scope !== "session" && scope !== "project") throw new Error("Create scope must be session or project; cross-project generation is not supported");
    if (scope === "project" && sessionId !== undefined) throw new Error("sessionId is only valid with session scope");
    const sm = ctx.sessionManager;
    const project = resolve(sm.getCwd());
    const requesterSessionId = sm.getSessionId();
    return this.store.exclusive(project, options.signal, async (signal) => {
      const index = await projectIndex(sm);
      let sources = await listSessions(sm, [index.current], signal);
      let selected: SummaryScope = { kind: "project" };
      if (scope === "session") {
        const id = sessionId ?? requesterSessionId;
        const exact = sources.find((source) => source.summary.sessionId === id);
        const matches = exact ? [exact] : sources.filter((source) => source.summary.sessionId.startsWith(id));
        if (matches.length !== 1) throw new Error(matches.length === 0
          ? `No session ${id} in the current project; cross-project generation is not supported`
          : `Session ${id} is ambiguous; use its complete id`);
        sources = matches;
        selected = { kind: "session", sessionId: matches[0]!.summary.sessionId };
      }
      sources.sort((a, b) => a.summary.created.localeCompare(b.summary.created) || a.summary.sessionId.localeCompare(b.summary.sessionId));
      const entries: RecalledEntry[] = [];
      const notes = new Map<string, EntryNotes>();
      const covered: StoredSummary["sources"] = [];
      // Clone each source before the model call. Completion never moves the checkpoint past this snapshot.
      for (const source of sources) {
        signal.throwIfAborted();
        const snapshot = conversationSource(await source.load());
        if (snapshot.entries.length === 0) continue;
        const sid = source.summary.sessionId;
        covered.push({ sessionId: sid, entryIds: snapshot.entries.map((entry) => entry.id), messageIds: snapshot.messageIds });
        for (const entry of snapshot.entries) {
          const ref = `${sid}/${entry.id}`;
          entries.push({ ...entry, id: ref, parentId: entry.parentId ? `${sid}/${entry.parentId}` : null });
          notes.set(ref, snapshot.notes.get(entry.id) ?? {});
        }
      }
      const requestedAt = new Date().toISOString();
      const refs = covered.flatMap((source) => source.messageIds.map((id) => `${source.sessionId}/${id}`));
      if (refs.length === 0) throw new Error("No conversation messages to summarise; summary requests and responses do not count");
      const previous = (await this.store.records(project)).filter((record) => sameScope(record.scope, selected));
      // Union prevents branch hopping from repeatedly summarising old, already-covered messages.
      const seen = new Set(previous.flatMap((record) => record.sources.flatMap((source) =>
        source.messageIds.map((id) => `${source.sessionId}/${id}`))));
      if (!refs.some((ref) => !seen.has(ref))) {
        throw new Error(`No new conversation messages for this scope. Read saved summary ${previous[0]!.id} instead.`);
      }
      signal.throwIfAborted();
      let usage: Usage | undefined;
      const text = await summarise(ctx.modelRegistry, entries, {
        notes: (id) => notes.get(id) ?? {}, signal, onUsage: (value) => { usage = value; },
      });
      signal.throwIfAborted();
      const summary: StoredSummary = {
        v: 1, id: randomUUID(), project, scope: selected, requesterSessionId, requestedBy,
        requestedAt, completedAt: new Date().toISOString(), model: { ...SUMMARISER }, sources: covered, text,
      };
      await this.store.save(summary, signal);
      return { summary, usage };
    });
  }

  async list(ctx: Pick<SummaryContext, "sessionManager">, options: ListSummaryOptions = {}) {
    const { scope = "session", sessionId, project, limit = 20, cursor } = options;
    if (!["session", "project", "all"].includes(scope)) throw new Error("List scope must be session, project or all");
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("limit must be an integer between 1 and 50");
    if (scope !== "session" && sessionId !== undefined) throw new Error("sessionId is only valid with session scope");
    if (scope !== "project" && project !== undefined) throw new Error("project is only valid when listing project scope");
    const current = resolve(ctx.sessionManager.getCwd());
    let selectedProject = current;
    let records: StoredSummary[];
    if (scope === "all" || project !== undefined) {
      records = await this.store.records();
      if (project !== undefined) {
        const projects = [...new Set([current, ...records.map((record) => record.project)])].map((path) => ({ path, sessionDir: "" }));
        const matches = matchProjects(project, projects, current);
        if (matches.length !== 1) throw new Error(`Project ${project} ${matches.length === 0 ? "has no saved summaries" : "is ambiguous; pass its full path"}`);
        selectedProject = matches[0]!.path;
      }
    } else records = await this.store.records(current);
    const requester = sessionId ?? ctx.sessionManager.getSessionId();
    records = records.filter((record) => scope === "all" || (record.project === selectedProject &&
      (scope !== "session" || record.requesterSessionId === requester)));
    const filter = JSON.stringify([scope, scope === "all" ? null : selectedProject, scope === "session" ? requester : null]);
    let start = 0;
    if (cursor !== undefined) {
      try {
        const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
        if (value.filter !== filter || typeof value.after !== "string") throw new Error();
        start = records.findIndex((record) => record.id === value.after) + 1;
        if (start === 0) throw new Error();
      } catch {
        throw new Error("Invalid summary cursor; keep the same listing scope and filters");
      }
    }
    const page = records.slice(start, start + limit);
    return {
      summaries: page.map(summaryMetadata),
      next: start + limit < records.length
        ? Buffer.from(JSON.stringify({ filter, after: page.at(-1)!.id })).toString("base64url") : null,
    };
  }
}
