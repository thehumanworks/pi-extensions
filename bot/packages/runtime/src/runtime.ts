import { mkdir, mkdtemp, readFile, rename, rm, writeFile, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT as C, awaitWithContext, withAbortSignal, type Context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord";
import type { Models, Model, Api } from "@earendil-works/pi-ai";
import { ModelRuntime, getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  Harness, createRegistry, defineExtension, defineTool, defineDoc, defineTask, hook, section,
  GenerationTask, watchEvents, type ConversationId, type TaskId, type Conversation,
  type UsageState, type EntryRecord, type SubmissionRecord,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { loadProject, resolveSource, composePrompt, invokeTool, type BotProject } from "./project.js";
import { acquireLock } from "./lock.js";
import { BotError, botError } from "./errors.js";
import { expandHome, canonicalPath, isInside } from "./paths.js";
import { snapshotSource, materializeSource } from "./snapshot.js";
import { readSettings } from "./settings.js";
import { readHistory } from "./history.js";
import type { BotHandle, BotInfo, BotRunRecord, BotSessionInfo, BotEvent, BotHistoryQuery, OpenBotOptions, ReloadResult, RunOptions, Usage } from "./types.js";

const zero = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 });
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const runId = (id: number) => `drun:${id}`;
const sessionId = (id: number) => `dconv:${id}`;
function numeric(id: string, prefix: "drun" | "dconv"): number {
  if (!new RegExp(`^${prefix}:[1-9][0-9]*$`).test(id) || !Number.isSafeInteger(Number(id.split(":")[1]))) throw new BotError("INVALID_INPUT", `Invalid ${prefix === "drun" ? "durable run" : "durable session"} ID: ${id}.`);
  return Number(id.split(":")[1]);
}
type SessionMeta = { sessionId: string; cwd: string; createdAt: string; updatedAt: string; title?: string };
type RunMeta = { record: JsonValue; taskId: number; conversationId: number; message: string; requestId?: string; requestInput?: string; submissionId?: number; baseline?: JsonValue; revision: string };
type InstanceState = { sourceDir: string; activeRevision?: string; sessions: Record<string, SessionMeta>; runs: Record<string, RunMeta>; requests: Record<string, string>; tail?: number };
const Instance = defineDoc<InstanceState>({ kind: "bot.instance", version: 1, scope: "session", initial: () => ({ sourceDir: "", sessions: {}, runs: {}, requests: {} }), checkpointWhen: () => true });
type DispatchInput = { session: number; previous?: number };
type DispatchCheckpoint = { phase: "queue" } | { phase: "execute" };

/** Public for credential-path tests and embedders that need the exact default configuration. */
export function modelRuntimeOptions(agentDir = getAgentDir()) {
  return { authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), modelsStorePath: join(agentDir, "models-store.json"), allowModelNetwork: false };
}
function checkedModel(model: Model<Api>): Model<Api> {
  for (const key of ["contextWindow", "maxTokens"] as const) if (!Number.isSafeInteger(model[key]) || model[key] <= 0) throw new BotError("INVALID_INPUT", `Invalid model ${model.provider}/${model.id}: ${key} must be a positive safe integer.`);
  for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) if (!Number.isFinite(model.cost?.[key]) || model.cost[key] < 0) throw new BotError("INVALID_INPUT", `Invalid model cost ${key} for ${model.provider}/${model.id}.`);
  return model;
}
async function resolveModel(models: Models, configured: string | undefined, defaults: Record<string, any>): Promise<Model<Api>> {
  const reference = configured ?? (defaults.defaultModel ? (defaults.defaultProvider ? `${defaults.defaultProvider}/${defaults.defaultModel}` : defaults.defaultModel) : undefined);
  if (reference !== undefined && (typeof reference !== "string" || !reference.trim())) throw new BotError("INVALID_INPUT", "model must be a non-empty provider/model string.");
  if (reference) {
    // Provider model IDs may themselves contain slashes. Prefer explicit provider prefix, then exact ID.
    const at = reference.indexOf("/");
    const model = at > 0 ? models.getModel(reference.slice(0, at), reference.slice(at + 1)) : undefined;
    if (model) return checkedModel(model);
    const matches = models.getModels().filter(model => model.id === reference);
    if (matches.length === 1) return checkedModel(matches[0]!);
    throw new BotError("INVALID_INPUT", `Unknown or ambiguous model "${reference}". Use an exact provider/model from the Pi catalog; provider extension code must be declared or inherited.`);
  }
  const available = await models.getAvailable();
  if (!available.length) throw new BotError("UNAVAILABLE", "No model configured and no authenticated Pi models available. Set BOT.md model, openBot({model}), or Pi's saved defaultProvider/defaultModel.");
  return checkedModel(available[0]!);
}
function sumUsage(state: UsageState | undefined): Usage {
  const total = zero();
  for (const usage of [...Object.values(state?.models ?? {}), ...Object.values(state?.tools ?? {})]) {
    total.input += usage.input; total.output += usage.output; total.cacheRead += usage.cacheRead; total.cacheWrite += usage.cacheWrite; total.cost += usage.cost.total;
  }
  return total;
}
async function usageOf(conversation: Conversation): Promise<Usage> {
  const view = await conversation.viewState(C);
  try { return sumUsage(view.value.docs["pi.usage"] as unknown as UsageState); } finally { view.dispose(); }
}
async function allEntries(conversation: Conversation, min?: number): Promise<EntryRecord[]> {
  const entries: EntryRecord[] = [];
  let cursor;
  do {
    const page = await conversation.entries({ minEntryId: min as never, order: "ascending" }, 1000, cursor, C);
    entries.push(...page.items); cursor = page.next;
  } while (cursor);
  return entries;
}

/** Serialized SDK-owned runs over a single durable Harness. */
export async function openBot(source: string, options: OpenBotOptions = {}): Promise<BotHandle> {
  try { return await openInstance(source, options); } catch (error) { throw botError(error, "UNAVAILABLE"); }
}
async function openInstance(source: string, options: OpenBotOptions): Promise<BotHandle> {
  if (options.model !== undefined && (typeof options.model !== "string" || !options.model.trim())) throw new BotError("INVALID_INPUT", "model must be a non-empty string.");
  if (options.thinking !== undefined && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(options.thinking)) throw new BotError("INVALID_INPUT", "Invalid thinking level.");
  let temporary: string | undefined;
  let sourceDir = await resolveSource(source);
  let stateDir: string;
  const defaultCwd = resolve(options.cwd ?? process.cwd());
  const originalSource = sourceDir;
  const originalState = canonicalPath(expandHome(options.stateDir ?? join(sourceDir, ".bot")));
  const agentDir = canonicalPath(expandHome(options.agentDir ?? getAgentDir()));
  if (isInside(sourceDir, originalState)) throw new BotError("INVALID_INPUT", "stateDir must not equal or contain sourceDir.");
  stateDir = originalState;
  const releases: Array<() => Promise<void>> = [];
  let harness: Harness | undefined;
  let storage: Awaited<ReturnType<typeof openNodeSqliteStorage>> | undefined;
  const shortOperations = new Set<Promise<unknown>>();
  const observers = new Set<Promise<unknown>>();
  const signalCleanups = new Set<() => void>();
  function track<T>(promise: Promise<T>): Promise<T> {
    shortOperations.add(promise);
    void promise.finally(() => shortOperations.delete(promise)).catch(() => {});
    return promise;
  }
  const stops = new Set<() => Promise<void>>();
  const directControllers = new Set<AbortController>();
  let closing = false;
  let closePromise: Promise<void> | undefined;
  let operationTail: Promise<unknown> = Promise.resolve();
  let gate: Promise<unknown> = Promise.resolve();
  const assertOpen = () => { if (closing) throw new BotError("UNAVAILABLE", "Bot is closing or closed."); };
  function admit<T>(fn: () => Promise<T>): Promise<T> {
    assertOpen(); const result = operationTail.then(fn); operationTail = result.catch(() => {}); return result;
  }
  async function exclusive<T>(fn: () => Promise<T>, context: Context): Promise<T> {
    const previous = gate;
    let release!: () => void;
    const own = new Promise<void>(resolve => { release = resolve; });
    gate = previous.catch(() => {}).then(() => own);
    try { await awaitWithContext(previous, context); context.abortSignal?.throwIfAborted(); return await fn(); }
    finally { release(); }
  }
  try {
    if (options.ephemeral) {
      temporary = await mkdtemp(join(tmpdir(), "pi-bot-"));
      sourceDir = join(temporary, "source"); stateDir = join(temporary, "state");
      const files = await snapshotSource(originalSource, originalState, agentDir);
      if (JSON.stringify(await snapshotSource(originalSource, originalState, agentDir)) !== JSON.stringify(files)) throw new BotError("CONFLICT", "Source changed during ephemeral copy.");
      await materializeSource(sourceDir, files);
      // Dependencies are shared installations, not writable bot source/state. This is not a sandbox.
      if (existsSync(join(originalSource, "node_modules"))) await symlink(canonicalPath(join(originalSource, "node_modules")), join(sourceDir, "node_modules"), "dir");
    }
    await mkdir(stateDir, { recursive: true });
    // A source lock also serializes independently relocated state instances sharing writable source.
    for (const path of [...new Set([join(sourceDir, ".sdk-source.lock"), join(stateDir, ".sdk-state.lock")])].sort()) releases.push(await acquireLock(path));
    storage = await openNodeSqliteStorage(join(stateDir, "runtime.sqlite"));
    const doc = await storage.findDocument({ kind: "bot.instance", scope: { kind: "session" } }, "current", C);
    const prior = doc ? (await storage.document(doc.id, "current", C))?.value as unknown as InstanceState : undefined;
    if (prior?.sourceDir && prior.sourceDir !== sourceDir) throw new BotError("CONFLICT", `State belongs to ${prior.sourceDir}, not ${sourceDir}.`);
    let project: BotProject;
    let diagnostics: string[] = [];
    const projectOptions = { stateDir, agentDir };
    const defaults = await readSettings(agentDir);
    const models = options.models ?? await ModelRuntime.create(modelRuntimeOptions(agentDir));
    let selectedModel: Model<Api>;
    const overrideModel = options.model === undefined ? undefined : await resolveModel(models, options.model, defaults);
    async function loadCheckpoint(revision: string): Promise<BotProject> {
      if (!/^[a-f0-9]{64}$/.test(revision)) throw new BotError("UNAVAILABLE", "Invalid capability checkpoint revision.");
      const base = join(stateDir, "revisions", revision);
      const manifest = JSON.parse(await readFile(join(base, "manifest.json"), "utf8"));
      const loaded = await loadProject(join(base, "source"), projectOptions);
      if (manifest.revision !== revision || loaded.info.revision !== revision || manifest.externalRevision !== loaded.externalRevision) throw new BotError("UNAVAILABLE", "Cannot restore checkpoint: source integrity or inherited/external capability fingerprint changed. Dependencies are not snapshotted.");
      loaded.info.sourceDir = sourceDir;
      return loaded;
    }
    const recovering = Object.values(prior?.runs ?? {}).find(meta => (meta.record as unknown as BotRunRecord).status === "running");
    if (recovering) {
      // Never compile/activate a new draft before replaying an interrupted batch.
      project = await loadCheckpoint(recovering.revision);
      selectedModel = await resolveModel(models, (recovering.record as unknown as BotRunRecord).model ?? options.model ?? project.definition.model, defaults);
      diagnostics.push(`Recovered interrupted run on recorded checkpoint ${recovering.revision}; installed dependencies are not snapshotted.`);
    } else {
      try {
        project = await loadProject(sourceDir, projectOptions);
        selectedModel = overrideModel ?? await resolveModel(models, project.definition.model, defaults);
      } catch (error) {
        let revision = prior?.activeRevision;
        if (!revision && !prior) {
          try { revision = JSON.parse(await readFile(join(stateDir, "revisions", "active.json"), "utf8")).revision; } catch {}
        }
        if (!revision) throw error;
        project = await loadCheckpoint(revision);
        selectedModel = overrideModel ?? await resolveModel(models, project.definition.model, defaults);
        diagnostics = [`Draft failed validation; restored last known good checkpoint ${revision}: ${String(error)}`];
      }
    }
    const thinking = () => options.thinking ?? project.definition.thinking ?? defaults.modelThinkingLevels?.[`${selectedModel.provider}/${selectedModel.id}`] ?? defaults.defaultThinkingLevel ?? "off";
    const registry = createRegistry();
    let activeSession: number | undefined;
    let activeRun: string | undefined;
    const H = () => harness!;
    const state = async () => (await H().snapshot(Instance, C))!;
    const getRecord = (meta: RunMeta) => clone(meta.record) as unknown as BotRunRecord;
    const conversation = async (id: number) => {
      const value = await H().conversation(id as ConversationId, C);
      if (!value) throw new BotError("NOT_FOUND", `Unknown durable conversation ${sessionId(id)}.`);
      return value;
    };
    const history = async (query: BotHistoryQuery, signal: AbortSignal) => readHistory(storage!, Object.values((await state()).sessions), stateDir, query, signal);
    async function checkpoint(next: BotProject) {
      const root = join(stateDir, "revisions");
      const base = join(root, next.info.revision);
      if (existsSync(join(base, "manifest.json"))) {
        const manifest = JSON.parse(await readFile(join(base, "manifest.json"), "utf8"));
        const saved = await snapshotSource(join(base, "source"), stateDir, agentDir);
        if (manifest.revision !== next.info.revision || manifest.externalRevision !== next.externalRevision || JSON.stringify(saved) !== JSON.stringify(next.files)) throw new BotError("UNAVAILABLE", "Existing capability checkpoint is corrupt; refusing to publish it.");
      } else {
        const staging = join(root, `.sdk-checkpoint-${randomUUID()}`);
        try {
          await materializeSource(join(staging, "source"), next.files);
          await writeFile(join(staging, "manifest.json"), JSON.stringify({ revision: next.info.revision, externalRevision: next.externalRevision, createdAt: new Date().toISOString(), note: "Bounded local capability files only; credentials, SDK state and installed/external dependencies are excluded." }));
          // A pre-manifest interrupted write cannot be an accepted checkpoint.
          if (existsSync(base)) await rm(base, { recursive: true });
          await rename(staging, base);
        } finally { await rm(staging, { recursive: true, force: true }); }
      }
      const marker = join(root, `active-${randomUUID()}.tmp`);
      try { await writeFile(marker, JSON.stringify({ revision: next.info.revision })); await rename(marker, join(root, "active.json")); }
      finally { await rm(marker, { force: true }); }
    }
    function compile(next: BotProject) {
      return defineExtension({ name: "bot.capabilities", tools: next.tools.map(tool => defineTool({
        name: tool.name, description: tool.description, parameters: tool.parameters, replay: tool.replay ?? "unsafe",
        execute: async (args, api, context) => {
          const result = await invokeTool(tool, args, { cwd: (await api.agent(context)).cwd ?? defaultCwd, sourceDir, stateDir, history,
            signal: context.abortSignal ?? new AbortController().signal, sessionId: sessionId(api.conversationId), ...(activeRun ? { runId: activeRun } : {}) });
          return { output: result.content, ...(result.details === undefined ? {} : { details: result.details as JsonValue }), ...(result.isError === undefined ? {} : { isError: result.isError }) };
        },
      })), sections: [section("bot", async input => `${await composePrompt(project, input.agent.cwd ?? defaultCwd)}${diagnostics.length ? `\n<reload_diagnostics>\n${diagnostics.join("\n")}\nRepair the draft using the still-active maintenance tools.\n</reload_diagnostics>` : ""}`, { tag: false })],
      hooks: [hook(GenerationTask, { afterTools: async (_assistant, _results, api) => {
        const result = await reloadAtBoundary();
        if (result.changed) {
          await (await conversation(api.conversationId)).configure({ model: { provider: selectedModel.provider, modelId: selectedModel.id }, thinkingLevel: thinking() }, C);
        }
      } })] });
    }
    async function reloadAtBoundary(): Promise<ReloadResult> {
      try {
        const next = await loadProject(sourceDir, projectOptions);
        const nextModel = await resolveModel(models, options.model ?? next.definition.model, defaults);
        const changed = next.info.revision !== project.info.revision;
        if (changed) {
          const extension = compile(next); // build everything before the single registry publication
          const validation = createRegistry(); validation.install(extension);
          await checkpoint(next);
          await H().commit(async tx => {
            const s = await tx.doc(Instance); s.activeRevision = next.info.revision;
            if (activeRun) {
              const meta = s.runs[activeRun]!; meta.revision = next.info.revision;
              const record = getRecord(meta as RunMeta); record.model = `${nextModel.provider}/${nextModel.id}`;
              meta.record = json(record) as unknown as JsonValue;
            }
          }, C);
          registry.install(extension);
          project = next; selectedModel = nextModel;
        }
        diagnostics = next.info.diagnostics.slice();
        return { changed, revision: project.info.revision, diagnostics: diagnostics.slice() };
      } catch (error) {
        diagnostics = [`Capability reload rejected; previous revision ${project.info.revision} remains active: ${error instanceof Error ? error.message : String(error)}`];
        return { changed: false, revision: project.info.revision, diagnostics: diagnostics.slice() };
      }
    }
    async function finish(id: TaskId, status: BotRunRecord["status"], error?: string, settled?: SubmissionRecord) {
      const meta = (await state()).runs[runId(id)]!;
      const conv = await conversation(meta.conversationId);
      const baseline = meta.baseline as unknown as Usage | undefined;
      const usage = baseline ? await usageOf(conv) : zero();
      if (!settled) settled = await storage!.submissionByRequest(meta.conversationId as ConversationId, `bot:${id}`, C);
      for (const field of ["input", "output", "cacheRead", "cacheWrite", "cost"] as const) usage[field] = Math.max(0, usage[field] - (baseline?.[field] ?? 0));
      const entries = settled?.type === "input" && settled.entry ? await allEntries(conv, settled.entry) : [];
      usage.turns = entries.flatMap(entry => entry.model ?? []).filter(message => message.role === "assistant").length;
      const messages = entries.flatMap(entry => entry.model ?? []);
      const answer = settled?.type === "input" && settled.status === "done" ? entries.find(entry => entry.id === settled.answer) : [...entries].reverse().find(entry => entry.model?.some(message => message.role === "assistant"));
      const output = (answer?.model ?? []).flatMap(message => message.role === "assistant" ? message.content.filter(part => part.type === "text").map(part => part.text) : []).join("\n");
      await H().commit(async tx => {
        const s = await tx.doc(Instance); const m = s.runs[runId(id)]!;
        const record = getRecord(m as RunMeta);
        if (["completed", "failed", "cancelled"].includes(record.status)) return;
        record.status = settled?.status === "done" ? "completed" : status; record.output = output; record.usage = usage;
        record.toolCalls = messages.filter(message => message.role === "toolResult").length; record.updatedAt = new Date().toISOString();
        if (error && record.status !== "completed") record.error = error; else delete record.error;
        m.record = json(record) as unknown as JsonValue; s.sessions[record.sessionId]!.updatedAt = record.updatedAt;
      }, C);
    }
    const Dispatch = defineTask<DispatchInput, DispatchCheckpoint, null>({ name: "bot.dispatch", version: 1,
      initial: () => ({ phase: "queue" }), phases: {
        queue: async (task, runtime, context) => {
          await runtime.commit(() => task.input.previous === undefined
            ? { status: "running", checkpoint: { phase: "execute" } }
            : { status: "waiting", checkpoint: { phase: "execute" }, on: [task.input.previous as TaskId], policy: "allSettled" }, context);
        },
        execute: async (task, runtime, context) => exclusive(async () => {
          const id = runId(task.id); const meta = (await state()).runs[id]!;
          if (["completed", "failed", "cancelled"].includes(getRecord(meta).status)) {
            await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context); return;
          }
          const conv = await conversation(task.input.session);
          activeSession = task.input.session; activeRun = id;
          try {
            // Keep interrupted calls on their recorded code until the tool batch finishes.
            if (getRecord(meta).status !== "running") await reloadAtBoundary();
            await conv.configure({ cwd: getRecord(meta).cwd, model: { provider: selectedModel.provider, modelId: selectedModel.id }, thinkingLevel: thinking() }, context);
            const baseline = await usageOf(conv);
            await runtime.commit(async tx => {
              const s = await tx.doc(Instance); const m = s.runs[id]!; const record = getRecord(m as RunMeta);
              record.status = "running"; record.model = `${selectedModel.provider}/${selectedModel.id}`; record.updatedAt = new Date().toISOString();
              m.record = json(record) as unknown as JsonValue; m.revision = project.info.revision;
              if (!m.baseline) m.baseline = baseline as unknown as JsonValue;
              return undefined;
            }, context);
            const handle = (await runtime.conversation(task.input.session as ConversationId, context))!;
            const submission = await handle.submit({ type: "input", content: meta.message, requestId: `bot:${task.id}` }, context);
            await runtime.commit(async tx => { (await tx.doc(Instance)).runs[id]!.submissionId = submission.id; return undefined; }, context);
            const settled = await submission.wait(context);
            const cancelled = settled.status === "unanswered" && settled.reason === "aborted";
            await finish(task.id, settled.status === "done" ? "completed" : cancelled ? "cancelled" : "failed", settled.status === "unanswered" ? `${settled.reason}${settled.detail ? `: ${typeof settled.detail === "string" ? settled.detail : JSON.stringify(settled.detail)}` : ""}` : undefined, settled);
            await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
          } catch (error) {
            if (context.abortSignal?.aborted) throw error;
            await conv.abort(C);
            await finish(task.id, "failed", error instanceof Error ? error.message : String(error));
            await runtime.commit(() => ({ status: "terminal", outcome: { status: "failed", error: { message: String(error) } } }), context);
          } finally { activeRun = undefined; activeSession = undefined; }
        }, context),
      }, abort: async (task, runtime, context) => {
        const meta = (await state()).runs[runId(task.id)]!;
        if (getRecord(meta).status === "running") await (await conversation(task.input.session)).abort(C);
        const sub = meta.submissionId ? await H().submission(meta.submissionId as never, C) : undefined;
        await finish(task.id, "cancelled", "aborted", await sub?.status(C));
        await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
      } });
    registry.install(defineExtension({ name: "bot.scheduler", tasks: [Dispatch] }));
    registry.install(compile(project));
    await checkpoint(project);
    try {
      harness = await Harness.open(storage!, { models, registry,
        settings: { toolExecution: "sequential", afterFailedRun: "withdraw", retry: defaults.retry, compaction: { ...defaults.compaction, backgroundTokens: 0, ...(defaults.compaction?.modelOverrides ? { modelOverrides: Object.fromEntries(Object.entries(defaults.compaction.modelOverrides).map(([key, config]) => [key, { ...(config as object), backgroundTokens: 0 }])) } : {}) } },
      }, C);
    } catch (error) { await storage!.close(C).catch(() => {}); storage = undefined; throw error; }
    await H().root(C);
    await H().commit(async tx => {
      const s = await tx.doc(Instance);
      if (s.sourceDir && s.sourceDir !== sourceDir && !options.ephemeral) throw new BotError("CONFLICT", `State belongs to ${s.sourceDir}, not ${sourceDir}. Move source/state together or create a new state directory.`);
      s.sourceDir = sourceDir; s.activeRevision = project.info.revision;
    }, C);
    H().resume();
    async function getRun(id: string): Promise<BotRunRecord> {
      const s = await state(); const meta = s.runs[id];
      if (!meta) { numeric(id, "drun"); throw new BotError("NOT_FOUND", `Unknown run ${id}.`); }
      const record = getRecord(meta);
      if (record.status === "queued" || record.status === "running") {
        const task = await H().getTask(meta.taskId as TaskId, C);
        if (task?.state.status === "terminal") {
          const outcome = task.state.outcome;
          return H().commit(async tx => {
            const draft = await tx.doc(Instance); const current = getRecord(draft.runs[id]! as RunMeta);
            if (current.status !== "queued" && current.status !== "running") return current;
            current.status = outcome.status === "aborted" ? "cancelled" : "failed";
            current.error = ("error" in outcome ? outcome.error?.message : undefined) ?? `Durable dispatch ended ${outcome.status} before writing a terminal run record.`;
            current.updatedAt = new Date().toISOString();
            draft.runs[id]!.record = json(current) as unknown as JsonValue;
            return current;
          }, C);
        }
      }
      return record;
    }
    async function watch(id: string, listener: (event: BotEvent) => void): Promise<() => Promise<void>> {
      assertOpen(); const convId = numeric(id, "dconv");
      if (!(await state()).sessions[id]) throw new BotError("NOT_FOUND", `Unknown session ${id}.`);
      const stream = await watchEvents(H(), convId as ConversationId, C);
      const emit = (event: { type: string }) => listener({ type: event.type, sessionId: id, ...(activeSession === convId && activeRun ? { runId: activeRun } : {}), data: clone(event) });
      let stopped = false;
      const stop = async () => { if (!stopped) { stopped = true; stops.delete(stop); await stream.stop(); } };
      stops.add(stop);
      try { emit(stream.snapshot); stream.start(async events => { for (const event of events) emit(event); }); }
      catch (error) { await stop(); throw error; }
      return stop;
    }
    async function cancel(id: string) {
      const record = await getRun(id);
      if (["completed", "cancelled", "failed"].includes(record.status)) return;
      const task = numeric(id, "drun") as TaskId;
      await H().abortTask(task, C); await H().waitForTask(task, C);
    }
    function submit(message: string, opts: RunOptions = {}): Promise<BotRunRecord> { return track(submitImpl(message, opts)); }
    async function submitImpl(message: string, opts: RunOptions): Promise<BotRunRecord> {
      if (typeof message !== "string" || !message.trim()) throw new BotError("INVALID_INPUT", "A non-empty message is required.");
      if (Buffer.byteLength(message) > 1024 * 1024) throw new BotError("INVALID_INPUT", "Message exceeds the 1 MiB admission limit.");
      for (const key of ["session", "cwd", "requestId"] as const) if (opts[key] !== undefined && (typeof opts[key] !== "string" || !opts[key])) throw new BotError("INVALID_INPUT", `${key} must be a non-empty string.`);
      if (opts.onEvent !== undefined && typeof opts.onEvent !== "function") throw new BotError("INVALID_INPUT", "onEvent must be a function.");
      if (opts.requestId !== undefined && (!opts.requestId || Buffer.byteLength(opts.requestId) > 1024)) throw new BotError("INVALID_INPUT", "requestId must contain 1–1024 bytes.");
      opts.signal?.throwIfAborted();
      let admittedId: string | undefined;
      const abort = () => { if (admittedId) void track(cancel(admittedId)).catch(() => {}); };
      const cleanupSignal = () => { opts.signal?.removeEventListener("abort", abort); signalCleanups.delete(cleanupSignal); };
      opts.signal?.addEventListener("abort", abort, { once: true }); signalCleanups.add(cleanupSignal);
      let id: string;
      try { id = await admit(async () => {
        assertOpen(); opts.signal?.throwIfAborted();
        const s = await state();
        const requestKey = opts.requestId === undefined ? undefined : `key:${Buffer.from(opts.requestId).toString("base64url")}`;
        const requestInput = JSON.stringify({ message, session: opts.session ?? "new", cwd: opts.cwd === undefined ? null : resolve(opts.cwd) });
        if (requestKey && s.requests[requestKey]) {
          const existing = s.runs[s.requests[requestKey]!]!;
          if (existing.requestInput !== requestInput) throw new BotError("CONFLICT", "requestId was already used for a different message, session or explicit cwd.");
          return s.requests[requestKey]!;
        }
        let target = opts.session;
        const explicitCwd = opts.cwd === undefined ? undefined : resolve(opts.cwd);
        const requestedCwd = explicitCwd ?? defaultCwd;
        if (target === "last") target = Object.values(s.sessions).filter(item => item.cwd === requestedCwd).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.sessionId;
        let convId: number | undefined;
        let cwd = requestedCwd;
        if (target && target !== "new") {
          convId = numeric(target, "dconv"); const meta = s.sessions[target];
          if (!meta) throw new BotError("NOT_FOUND", `Unknown session ${target}.`);
          if (explicitCwd !== undefined && explicitCwd !== meta.cwd) throw new BotError("CONFLICT", `Session ${target} is bound to ${meta.cwd}; cannot continue in ${explicitCwd}. Create a new session.`);
          cwd = meta.cwd;
        }
        // Validate model before durable admission, even when source changed since open.
        await resolveModel(models, options.model ?? project.definition.model, defaults);
        opts.signal?.throwIfAborted();
        return H().commit(async tx => {
          opts.signal?.throwIfAborted();
          const draft = await tx.doc(Instance); const now = new Date().toISOString();
          if (convId === undefined) {
            const created = await tx.createConversation({ ownership: { kind: "ownerless" } }); convId = created.id;
            const sid = sessionId(convId);
            draft.sessions[sid] = { sessionId: sid, cwd, createdAt: now, updatedAt: now, title: message.slice(0, 100) };
          }
          const task = await tx.createTask(Dispatch, { session: convId, ...(draft.tail ? { previous: draft.tail } : {}) }, { conversationId: 1 as ConversationId, ownership: { kind: "conversation" } });
          const id = runId(task);
          const record: BotRunRecord = { runId: id, sessionId: sessionId(convId), bot: project.info.name, cwd, status: "queued", output: "", model: `${selectedModel.provider}/${selectedModel.id}`, usage: zero(), toolCalls: 0, createdAt: now, updatedAt: now };
          draft.runs[id] = { record: json(record) as unknown as JsonValue, taskId: task, conversationId: convId, message, revision: project.info.revision, ...(opts.requestId ? { requestId: opts.requestId, requestInput } : {}) };
          draft.tail = task;
          if (requestKey) draft.requests[requestKey] = id;
          opts.signal?.throwIfAborted();
          return id;
        }, C);
      }); } catch (error) { cleanupSignal(); throw error; }
      admittedId = id;
      // Cancellation after commit belongs to the admitted durable run. A pre-commit abort rolled back admission.
      if (opts.signal?.aborted) await cancel(id);
      const accepted = await getRun(id);
      let stop: (() => Promise<void>) | undefined;
      const emit = (event: BotEvent) => { try { opts.onEvent?.(event); } catch {} };
      if (opts.onEvent && !closing) {
        try { stop = await watch(accepted.sessionId, event => emit({ ...event, runId: id })); } catch { /* Observer failure never undoes durable admission. */ }
      }
      if (opts.signal?.aborted) abort();
      H().resume();
      const observation = H().waitForTask(numeric(id, "drun") as TaskId, C).then(async () => {
        if (closing) return;
        const record = await track(getRun(id));
        if (!closing) emit({ type: "run_settled", sessionId: record.sessionId, runId: id, data: record });
      }).catch(() => {}).finally(async () => { cleanupSignal(); await stop?.(); observers.delete(observation); });
      observers.add(observation); void observation.catch(() => {});
      return accepted;
    }
    const handle: BotHandle = {
      sourceDir, stateDir,
      async info(): Promise<BotInfo> { assertOpen(); return clone({ ...project.info, model: `${selectedModel.provider}/${selectedModel.id}`, thinking: thinking(), diagnostics }); },
      submit,
      async run(message, opts = {}) {
        const accepted = await submit(message, opts);
        await H().waitForTask(numeric(accepted.runId, "drun") as TaskId, C);
        assertOpen(); return track(getRun(accepted.runId));
      },
      async getRun(id) { assertOpen(); return getRun(id); },
      async listSessions(): Promise<BotSessionInfo[]> { assertOpen(); return clone(Object.values((await state()).sessions).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))); },
      watch, async cancel(id) { assertOpen(); return cancel(id); },
      async callTool(name, input, opts = {}) {
        assertOpen(); const controller = new AbortController(); directControllers.add(controller);
        const abort = () => controller.abort(opts.signal?.reason); opts.signal?.addEventListener("abort", abort, { once: true }); if (opts.signal?.aborted) abort();
        try { return await exclusive(async () => {
          assertOpen(); await reloadAtBoundary();
          const tool = project.tools.find(tool => tool.name === name); if (!tool) throw new BotError("NOT_FOUND", `Tool ${name} is not enabled for this bot.`);
          let cwd = defaultCwd; let sid = opts.session ?? "direct";
          if (opts.session) { const meta = (await state()).sessions[opts.session]; if (!meta) throw new BotError("NOT_FOUND", `Unknown session ${opts.session}.`); cwd = meta.cwd; }
          const result = await invokeTool(tool, input, { cwd, sourceDir, stateDir, history, sessionId: sid, signal: controller.signal });
          await reloadAtBoundary(); return result;
        }, withAbortSignal(controller.signal, C)); }
        finally { directControllers.delete(controller); opts.signal?.removeEventListener("abort", abort); }
      },
      async reload() { assertOpen(); return exclusive(async () => { assertOpen(); return reloadAtBoundary(); }, C); },
      close() {
        if (!closePromise) {
          closing = true;
          closePromise = (async () => {
            for (const controller of directControllers) controller.abort(new BotError("UNAVAILABLE", "Bot closing"));
            await operationTail;
            while (shortOperations.size) await Promise.allSettled([...shortOperations]);
            for (const cleanup of [...signalCleanups]) cleanup();
            await Promise.allSettled([...stops].map(stop => stop()));
            try { await H().close(C); await Promise.allSettled([...observers]); }
            finally {
              await gate;
              try {
                const released = await Promise.allSettled(releases.reverse().map(release => release()));
                const failed = released.find(result => result.status === "rejected");
                if (failed?.status === "rejected") throw failed.reason;
              } finally { if (temporary) await rm(temporary, { recursive: true, force: true }); }
            }
          })();
        }
        return closePromise;
      },
    };
    // Normalize unexpected filesystem/storage/tool failures without imposing transport semantics.
    for (const [key, value] of Object.entries(handle)) {
      if (typeof value !== "function") continue;
      (handle as unknown as Record<string, unknown>)[key] = async (...args: unknown[]) => {
        try {
          const result = value.apply(handle, args);
          return await (["submit", "getRun", "listSessions", "watch", "info", "cancel"].includes(key) ? track(result) : result);
        } catch (error) { throw botError(error, "UNAVAILABLE"); }
      };
    }
    return handle;
  } catch (error) {
    if (harness) await harness.close(C).catch(() => {}); else await storage?.close(C).catch(() => {});
    for (const release of releases.reverse()) await release().catch(() => {});
    if (temporary) await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}
