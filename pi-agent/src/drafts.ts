import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { checkName, parseDefinition, withHome } from "./definitions.ts";
import type { AgentRuntime, RunOptions, RunResult } from "./runtime.ts";
import type { AgentStore } from "./store.ts";
import { atomicWrite, digest, readOptional, withLock } from "./storage.ts";

export interface DraftEvaluation {
  id: string;
  revision: string;
  task: string;
  criteria: string;
  workspace: string;
  status: "running" | "completed" | "failed";
  result?: RunResult;
  error?: string;
}
export interface AgentDraft {
  id: string;
  purpose: string;
  suggestedName?: string;
  author?: string;
  cwd?: string;
  status: "draft" | "accepted" | "rejected";
  source?: string;
  revision?: string;
  evaluations: DraftEvaluation[];
}
export interface DraftHost {
  changed: (id: string | undefined) => void;
  confirmEvaluation: (draft: AgentDraft, task: string, criteria: string, signal: AbortSignal) => Promise<boolean>;
}

/** One durable creation workflow selected by an outer Pi session. No model acceptance API. */
export class DraftWorkflow {
  private currentId?: string;
  private controllers = new Set<AbortController>();
  private pending = new Set<Promise<DraftEvaluation>>();
  private closed = false;
  private creating = false;
  constructor(readonly store: AgentStore, readonly runtime: AgentRuntime, private host: DraftHost) {}

  private directory(id: string): string {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid draft ID.");
    return join(this.store.root, ".drafts", id);
  }
  private async read(id: string): Promise<AgentDraft> {
    const raw = await readOptional(join(this.directory(id), "draft.json"));
    if (!raw) throw new Error("Draft not found.");
    const draft = JSON.parse(raw) as AgentDraft;
    if (draft.id !== id || (draft.source !== undefined && digest(draft.source) !== draft.revision)) throw new Error("Invalid draft revision.");
    return draft;
  }
  private async save(draft: AgentDraft): Promise<void> {
    await atomicWrite(join(this.directory(draft.id), "draft.json"), JSON.stringify(draft, null, 2));
  }
  async current(): Promise<AgentDraft | undefined> {
    if (!this.currentId) return undefined;
    const draft = await this.read(this.currentId);
    return draft.status === "draft" ? draft : undefined;
  }
  async restore(id?: string): Promise<void> {
    if (id) await this.read(id);
    this.currentId = id;
  }
  async start(purpose: string, suggestedName?: string, author?: string, cwd?: string): Promise<AgentDraft> {
    if (this.closed) throw new Error("Draft workflow is closed.");
    if (this.creating) throw new Error("A creation request is already pending.");
    this.creating = true;
    try {
      if (await this.current()) throw new Error("A creation draft is already open. Accept or reject it first.");
      if (!purpose.trim()) throw new Error("Describe what the agent should do.");
      if (suggestedName) checkName(suggestedName);
      const draft: AgentDraft = { id: randomUUID(), purpose: purpose.trim(), suggestedName, author, cwd, status: "draft", evaluations: [] };
      await this.save(draft);
      if (this.closed) throw new Error("Draft workflow closed while creating the draft.");
      this.currentId = draft.id;
      this.host.changed(draft.id);
      return draft;
    } finally { this.creating = false; }
  }
  private async require(id?: string, revision?: string): Promise<AgentDraft> {
    if (this.closed) throw new Error("Draft workflow is closed.");
    const draft = await this.current();
    if (!draft || (id !== undefined && draft.id !== id) || (revision !== undefined && draft.revision !== revision)) throw new Error("Draft changed or closed. Review the current draft again.");
    return draft;
  }
  async forAuthor(author?: string): Promise<AgentDraft> {
    const draft = await this.require();
    if (draft.author !== author) throw new Error("This draft belongs to another active agent. Resume its author before iterating.");
    return draft;
  }
  async propose(source: string, author?: string): Promise<AgentDraft> {
    const before = await this.forAuthor(author);
    return withLock(this.store.root, `draft:${before.id}`, async () => {
      const draft = await this.require(before.id);
      const def = parseDefinition(source, this.store.file(draft.suggestedName ?? "agent"), this.store.homes);
      if (!def.metadata.name || !def.description || !def.prompt) throw new Error("A proposed agent needs an explicit name, description and system-prompt body.");
      if (draft.suggestedName && def.name !== draft.suggestedName) throw new Error(`Use the user-specified name '${draft.suggestedName}'.`);
      if (def.unsupported.length) throw new Error(`Unsupported runtime fields: ${def.unsupported.join(", ")}`);
      if ((await this.store.list(draft.cwd)).agents.some(a => a.name === def.name)) throw new Error(`Agent '${def.name}' already exists. Propose a new name.`);
      draft.source = withHome(source, def.home);
      draft.revision = digest(draft.source);
      await this.save(draft);
      return draft;
    }, 50);
  }

  /** Human command calls this only after displaying and confirming this exact revision. */
  async accept(id: string, revision: string): Promise<string> {
    if (this.pending.size) throw new Error("Wait for the evaluation to finish or stop it before accepting.");
    return withLock(this.store.root, `draft-evaluation:${id}`, () => withLock(this.store.root, `draft:${id}`, async () => {
      const draft = await this.require(id, revision);
      if (this.pending.size) throw new Error("Wait for the evaluation before accepting.");
      if (!draft.source) throw new Error("The active agent has not proposed a definition yet.");
      const def = parseDefinition(draft.source, this.store.file(draft.suggestedName ?? "agent"), this.store.homes);
      if ((await this.store.list(draft.cwd)).agents.some(a => a.name === def.name)) throw new Error(`Agent '${def.name}' now exists. Nothing was overwritten.`);
      await this.store.create(def.name, draft.source);
      draft.status = "accepted";
      await this.save(draft);
      this.host.changed(undefined);
      return def.name;
    }, 50));
  }
  async reject(id: string, revision?: string): Promise<void> {
    this.stop();
    await Promise.allSettled([...this.pending]);
    await withLock(this.store.root, `draft-evaluation:${id}`, () => withLock(this.store.root, `draft:${id}`, async () => {
      const draft = await this.require(id);
      if (draft.revision !== revision) throw new Error("Draft changed. Review it again.");
      draft.status = "rejected";
      await this.save(draft);
      this.stop();
      this.host.changed(undefined);
    }, 50));
  }

  evaluate(revision: string, task: string, criteria: string, author?: string, signal?: AbortSignal, onEvent?: RunOptions["onEvent"]): Promise<DraftEvaluation> {
    if (this.closed) return Promise.reject(new Error("Draft workflow is closed."));
    if (this.pending.size) return Promise.reject(new Error("An evaluation is already pending. Wait for it or /agent stop."));
    const controller = new AbortController();
    this.controllers.add(controller);
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const pending = this.runEvaluation(revision, task, criteria, author, combined, onEvent);
    this.pending.add(pending);
    void pending.finally(() => { this.pending.delete(pending); this.controllers.delete(controller); }).catch(() => {});
    return pending;
  }
  private async runEvaluation(revision: string, task: string, criteria: string, author: string | undefined, signal: AbortSignal, onEvent?: RunOptions["onEvent"]): Promise<DraftEvaluation> {
    if (!task.trim() || !criteria.trim()) throw new Error("An evaluation needs a task and explicit success criteria.");
    const before = await this.forAuthor(author);
    if (!before.source || before.revision !== revision) throw new Error("Draft changed or has no proposed definition. Read it before evaluating.");
    const source = before.source;
    // One cross-process lease covers approval, execution and result persistence.
    // Acceptance/rejection take the same lease; a resumed session cannot finalize a live trial.
    return withLock(this.store.root, `draft-evaluation:${before.id}`, async leaseSignal => {
      signal = AbortSignal.any([signal, leaseSignal]);
      await this.require(before.id, revision);
      signal.throwIfAborted();
      if (!await this.host.confirmEvaluation(before, task, criteria, signal)) throw new Error("Evaluation was not approved by the user.");
      signal.throwIfAborted();
      const evaluation = await withLock(this.store.root, `draft:${before.id}`, async () => {
        const draft = await this.require(before.id, revision);
        const id = randomUUID();
        const evaluation: DraftEvaluation = { id, revision, task, criteria, workspace: join(this.directory(draft.id), "evals", id), status: "running" };
        draft.evaluations.push(evaluation);
        await this.save(draft); // Record before execution; interrupted trials are never replayed.
        return evaluation;
      }, 50);
      try {
        evaluation.result = await this.runtime.evaluate(source, task, evaluation.workspace, { signal, onEvent });
        evaluation.status = "completed";
      } catch (e) {
        evaluation.status = "failed";
        evaluation.error = String(e);
      }
      await withLock(this.store.root, `draft:${before.id}`, async () => {
        const draft = await this.read(before.id); // Retain evidence even if rejected or revised during the trial.
        const index = draft.evaluations.findIndex(e => e.id === evaluation.id);
        if (index < 0) throw new Error("Evaluation record disappeared.");
        draft.evaluations[index] = evaluation;
        await this.save(draft);
      }, 50);
      return evaluation;
    });
  }
  stop(): void { for (const controller of this.controllers) controller.abort(new Error("Evaluation stopped")); }
  async close(): Promise<void> {
    this.closed = true;
    this.stop();
    await Promise.allSettled([...this.pending]);
  }
}

export function draftInstructions(draft: AgentDraft): string {
  return `We are collaboratively designing a NEW specialist agent; do not create or activate it yet.\n` +
    `User's purpose: ${draft.purpose}\n${draft.suggestedName ? `Requested name: ${draft.suggestedName}\n` : "Propose a concise lowercase-hyphenated name.\n"}` +
    `Propose a complete Markdown definition using agent_draft(action="propose", definition=...). YAML fields: name, description (when to call), home (optional), model (optional provider/model), thinking (optional), tools/skills (optional lists of names; omitted=all, []=none). The Markdown body is the system prompt.\n` +
    `Use the conversation context, clarify material ambiguities, and explain your choices. Incorporate the user's feedback in revised proposals. Use agent_draft show to recover the latest revision and evidence. Do not use agent_manage create or filesystem writes to bypass review.\n` +
    `If asked for evals, propose realistic tasks and explicit success criteria, then call agent_draft eval with the exact current revision. Each trial needs human confirmation, runs in a fresh scratch home/history with real tools, and may have external effects. Management/delegation/scheduling tools are disabled in trials. Assess the actual output against each criterion and report failures honestly; "completed" means execution finished, NOT that criteria passed. Old-revision evidence does not validate a new revision.\n` +
    `The user decides when it is successful. Only /agent accept can save the reviewed revision; /agent reject discards the draft. Never claim acceptance yourself.\n` +
    (draft.source ? `Current proposed revision: ${draft.revision}\n${draft.source}` : "No definition has been proposed yet.");
}

export function draftPreview(draft: AgentDraft): string {
  const evidence = draft.evaluations.map(e => `${e.id}: ${e.status === "running" ? "running or interrupted (no final result)" : e.status}, revision ${e.revision}${e.revision === draft.revision ? " (current)" : " (older — not evidence for current revision)"}\nTask: ${e.task}\nCriteria: ${e.criteria}\nTranscript: ${e.result?.sessionFile ?? e.workspace}${e.error ? `\nError: ${e.error}` : ""}`).join("\n\n");
  return `Agent creation draft: ${draft.purpose}\nAuthor: ${draft.author ?? "main Pi session"}\nRevision: ${draft.revision ?? "not proposed"}\n\n${draft.source ?? "Waiting for the active agent to propose a definition."}\n\nEvaluations (execution completion is not a passing grade):\n${evidence || "None. This definition has not been evaluated."}\n\nContinue chatting to iterate or request evals. /agent accept saves this revision; /agent reject discards it.`;
}
