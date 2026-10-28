import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CURRENT_SESSION_VERSION, SessionManager, type RpcExtensionUIResponse, type RpcSessionState } from "@earendil-works/pi-coding-agent";
import { botPaths, type Bot } from "../bots.ts";
import { listSessions, newSessionPath, sessionFileForId } from "../sessions.ts";
import { badRequest, errorText, notFound } from "./errors.ts";
import { PiProcess, type PiEvent } from "./pi-rpc.ts";
import { apiMessage, messagesFromEntries, SESSION_ID, truncate, type ApiMessage } from "./transcript.ts";

export type ConversationState = "idle" | "starting" | "running";
export type EventListener = (event: ConversationEvent) => void;

/** One record of a conversation's update stream; `offset` is its position in that stream. */
export interface ConversationEvent { offset: number; type: string; data: Record<string, unknown> }

/** An extension asked the human something; the conversation waits for `respond`. */
export interface PendingRequest {
  id: string;
  method: "select" | "confirm" | "input" | "editor";
  title: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
}

export interface ConversationSummary {
  id: string;
  bot: string;
  cwd: string;
  name?: string;
  firstMessage?: string;
  /** ISO timestamp of the last change to the session file. */
  modified: string;
  state: ConversationState;
}

export interface ConversationSnapshot extends ConversationSummary {
  /** Offset to subscribe from so no update after this snapshot is missed. */
  offset: number;
  model?: string;
  thinking?: string;
  messages: ApiMessage[];
  /** The assistant message still being streamed, if any. */
  partial?: { text: string; thinking: string };
  pendingRequests: PendingRequest[];
}

export interface HubOptions {
  /** The Pi executable (or a wrapper) and arguments placed before Pi's own. */
  command: string;
  args?: string[];
  /** The pi-bot extension to load into each child, i.e. this package's index.ts. */
  extension: string;
  env?: NodeJS.ProcessEnv;
  /** Working directory for conversations that do not name one. */
  defaultCwd: string;
  /** How long an idle child stays warm before it is stopped. */
  idleMs?: number;
  /** How many events a conversation replays to late subscribers. */
  eventLimit?: number;
}

const IDLE_MS = 10 * 60_000;
const EVENT_LIMIT = 5_000;
const SUMMARY_LIMIT = 500;

/**
 * One conversation of one bot: a session file in the bot's home plus, while the bot works,
 * a `pi --mode rpc` child bound to it. Updates form an append-only stream with offsets so
 * clients can snapshot, then follow from the snapshot's offset.
 */
export class Conversation {
  private readonly events: ConversationEvent[] = [];
  private readonly listeners = new Set<EventListener>();
  private readonly pending = new Map<string, PendingRequest>();
  private nextOffset = 0;
  private process?: PiProcess;
  private starting?: Promise<PiProcess>;
  private idleTimer?: NodeJS.Timeout;
  private partial = { text: "", thinking: "" };
  private state: ConversationState = "idle";
  private model?: string;
  private thinking?: string;

  constructor(readonly bot: Bot, readonly id: string, readonly path: string, readonly cwd: string, private readonly options: HubOptions) {}

  get currentState(): ConversationState { return this.state; }
  get offset(): number { return this.nextOffset; }
  /** Oldest offset still replayable; earlier history needs a fresh snapshot. */
  get firstOffset(): number { return this.events[0]?.offset ?? this.nextOffset; }

  /** Replay retained events from `from`, then deliver new ones until the returned function is called. */
  subscribe(from: number, listener: EventListener): () => void {
    for (const event of this.events) if (event.offset >= from) listener(event);
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Send a user message; while the bot works it is queued as a follow-up unless `behavior` says `steer`. */
  async submit(message: string, behavior?: "steer" | "followUp"): Promise<{ submissionId: string; disposition: string }> {
    const pi = await this.ensureProcess();
    const streamingBehavior = behavior ?? (this.state === "running" ? "followUp" : undefined);
    const { disposition } = await pi.request<{ disposition: string }>(streamingBehavior ? { type: "prompt", message, streamingBehavior } : { type: "prompt", message });
    if (disposition === "started") this.setState("running");
    return { submissionId: randomUUID(), disposition };
  }

  async abort(): Promise<void> {
    if (this.process?.isRunning) await this.process.request({ type: "abort" });
  }

  /** Answer a pending extension request; false when nothing waits for that id. */
  respond(response: RpcExtensionUIResponse): boolean {
    if (!this.pending.delete(response.id)) return false;
    this.process?.send(response);
    this.emit("request_closed", { requestId: response.id });
    return true;
  }

  async snapshot(): Promise<ConversationSnapshot> {
    const messages = await this.readMessages();
    const summary = this.summary(existsSync(this.path) ? statSync(this.path).mtime : new Date());
    return {
      ...summary, offset: this.nextOffset, model: this.model, thinking: this.thinking, messages,
      ...(this.state === "running" && (this.partial.text || this.partial.thinking) ? { partial: { ...this.partial } } : {}),
      pendingRequests: [...this.pending.values()],
    };
  }

  summary(modified: Date, extra: Partial<ConversationSummary> = {}): ConversationSummary {
    return { id: this.id, bot: this.bot.name, cwd: this.cwd, modified: modified.toISOString(), state: this.state, ...extra };
  }

  /** Stop the child; the session file stays. */
  async close(): Promise<void> {
    clearTimeout(this.idleTimer);
    const pi = this.process;
    this.process = undefined;
    await pi?.stop();
    this.setState("idle");
  }

  private async readMessages(): Promise<ApiMessage[]> {
    if (!existsSync(this.path)) return [];
    const dir = botPaths(this.bot.home).sessions;
    try {
      return messagesFromEntries(SessionManager.open(this.path, dir).getBranch());
    } catch {
      // Pi appends whole lines, but a read can still race a write; one retry settles it.
      await new Promise(done => setTimeout(done, 50));
      return messagesFromEntries(SessionManager.open(this.path, dir).getBranch());
    }
  }

  private ensureProcess(): Promise<PiProcess> {
    clearTimeout(this.idleTimer);
    if (this.process?.isRunning) return Promise.resolve(this.process);
    this.starting ??= this.start().finally(() => { this.starting = undefined; });
    return this.starting;
  }

  private async start(): Promise<PiProcess> {
    this.setState("starting");
    const { command, args = [], extension, env } = this.options;
    const pi = new PiProcess({
      command, cwd: this.cwd, env,
      args: [...args, "--mode", "rpc", "--bot", this.bot.name, "-e", extension, "--session-dir", botPaths(this.bot.home).sessions, "--session", this.path],
      onEvent: event => this.onEvent(event),
      onExit: (code, stderr) => this.onExit(pi, code, stderr),
    });
    try {
      const state = await pi.request<RpcSessionState>({ type: "get_state" });
      this.model = state.model ? `${state.model.provider}/${state.model.id}` : undefined;
      this.thinking = state.thinkingLevel;
    } catch (error) {
      await pi.stop();
      this.setState("idle");
      throw new Error(`Cannot start ${this.bot.name}: ${errorText(error)}`);
    }
    this.process = pi;
    this.setState("idle");
    return pi;
  }

  private onEvent(event: PiEvent): void {
    switch (event.type) {
      case "agent_start":
        this.partial = { text: "", thinking: "" };
        this.setState("running");
        break;
      case "message_start":
        if (event.message.role === "assistant") this.partial = { text: "", thinking: "" };
        break;
      case "message_update": {
        const update = event.assistantMessageEvent;
        if (update.type === "text_delta") { this.partial.text += update.delta; this.emit("delta", { kind: "text", text: update.delta }); }
        else if (update.type === "thinking_delta") { this.partial.thinking += update.delta; this.emit("delta", { kind: "thinking", text: update.delta }); }
        break;
      }
      case "message_end": {
        const message = apiMessage(event.message);
        if (message) this.emit("message", { message });
        if (event.message.role === "assistant") this.partial = { text: "", thinking: "" };
        break;
      }
      case "tool_execution_start":
        this.emit("tool", { phase: "start", toolCallId: event.toolCallId, toolName: event.toolName, args: event.args });
        break;
      case "tool_execution_end": {
        const content = (event.result as { content?: Array<{ type?: string; text?: string }> } | undefined)?.content ?? [];
        const summary = truncate(content.filter(part => part.type === "text" && part.text).map(part => part.text).join("\n"), SUMMARY_LIMIT);
        this.emit("tool", { phase: "end", toolCallId: event.toolCallId, toolName: event.toolName, isError: event.isError, durationMs: event.durationMs, summary });
        break;
      }
      case "agent_settled":
        this.setState("idle");
        this.emit("settled", { aborted: event.aborted });
        this.idleTimer = setTimeout(() => void this.close(), this.options.idleMs ?? IDLE_MS);
        this.idleTimer.unref();
        break;
      case "thinking_level_changed":
        this.thinking = event.level;
        this.emit("status", this.status());
        break;
      case "auto_retry_start":
        this.emit("notice", { level: "warning", message: `Retrying (${event.attempt}/${event.maxAttempts}): ${event.errorMessage}` });
        break;
      case "compaction_start":
        this.emit("notice", { level: "info", message: "Compacting the conversation…" });
        break;
      case "extension_ui_request":
        this.onUiRequest(event);
        break;
      default:
        break;
    }
  }

  private onUiRequest(event: Extract<PiEvent, { type: "extension_ui_request" }>): void {
    switch (event.method) {
      case "select": case "confirm": case "input": case "editor": {
        const request: PendingRequest = {
          id: event.id, method: event.method, title: event.title,
          ...(event.method === "confirm" ? { message: event.message } : {}),
          ...(event.method === "select" ? { options: event.options } : {}),
          ...(event.method === "input" && event.placeholder ? { placeholder: event.placeholder } : {}),
          ...(event.method === "editor" && event.prefill ? { prefill: event.prefill } : {}),
        };
        this.pending.set(request.id, request);
        this.emit("request", { ...request });
        const timeout = "timeout" in event ? event.timeout : undefined;
        if (timeout) setTimeout(() => { if (this.pending.delete(request.id)) this.emit("request_closed", { requestId: request.id }); }, timeout).unref();
        break;
      }
      case "notify":
        this.emit("notice", { level: event.notifyType ?? "info", message: event.message });
        break;
      default:
        break; // status lines, widgets and titles belong to a terminal UI
    }
  }

  private onExit(pi: PiProcess, code: number | null, stderr: string): void {
    if (this.process !== pi) return; // a deliberate stop, or a failed start that already reported
    this.process = undefined;
    for (const id of this.pending.keys()) this.emit("request_closed", { requestId: id });
    this.pending.clear();
    if (this.state !== "idle" || code) {
      const detail = stderr.trim().slice(-500);
      this.emit("error", { message: `${this.bot.name} stopped unexpectedly (exit ${code ?? "signal"})${detail ? `: ${detail}` : "."}` });
    }
    if (this.state === "running") this.emit("settled", { aborted: true });
    this.setState("idle");
  }

  private status(): Record<string, unknown> {
    return { state: this.state, model: this.model, thinking: this.thinking };
  }

  private setState(state: ConversationState): void {
    if (state === this.state && state !== "idle") return;
    this.state = state;
    this.emit("status", this.status());
  }

  private emit(type: string, data: Record<string, unknown>): void {
    const event = { offset: this.nextOffset++, type, data };
    this.events.push(event);
    if (this.events.length > (this.options.eventLimit ?? EVENT_LIMIT)) this.events.shift();
    for (const listener of this.listeners) listener(event);
  }
}

/** Finds, creates, lists and removes conversations, and keeps the ones with a live child. */
export class ConversationHub {
  private readonly open = new Map<string, Conversation>();

  constructor(private readonly options: HubOptions) {}

  async list(bot: Bot): Promise<ConversationSummary[]> {
    const dir = botPaths(bot.home).sessions;
    await mkdir(dir, { recursive: true });
    return (await listSessions(dir)).map(session => ({
      id: session.id, bot: bot.name, cwd: session.cwd, modified: session.modified.toISOString(),
      ...(session.name ? { name: session.name } : {}), ...(session.firstMessage ? { firstMessage: session.firstMessage } : {}),
      state: this.open.get(key(bot, session.id))?.currentState ?? "idle",
    }));
  }

  /** The conversation `id` of `bot`; with `create`, a missing one starts empty in `create.cwd`. */
  async get(bot: Bot, id: string, create?: { cwd?: string }): Promise<Conversation> {
    const existing = this.open.get(key(bot, id));
    if (existing) return existing;
    if (!SESSION_ID.test(id)) throw badRequest("Conversation ids contain only letters, digits, '.', '_' and '-', and start and end with a letter or digit.");
    const dir = botPaths(bot.home).sessions;
    await mkdir(dir, { recursive: true });
    let path = await sessionFileForId(dir, id);
    let cwd: string;
    if (path) {
      cwd = await headerCwd(path);
    } else {
      if (!create) throw notFound(`Bot ${bot.name} has no conversation "${id}".`);
      cwd = resolve(create.cwd ?? this.options.defaultCwd);
      if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw badRequest(`Working directory ${cwd} does not exist.`);
      path = newSessionPath(dir, id);
      const header = { type: "session", version: CURRENT_SESSION_VERSION, id, timestamp: new Date().toISOString(), cwd };
      await writeFile(path, `${JSON.stringify(header)}\n`, { flag: "wx" });
    }
    const conversation = new Conversation(bot, id, path, cwd, this.options);
    this.open.set(key(bot, id), conversation);
    return conversation;
  }

  /** Stop the child and delete the session file. */
  async remove(bot: Bot, id: string): Promise<void> {
    const conversation = await this.get(bot, id);
    await conversation.close();
    this.open.delete(key(bot, id));
    await rm(conversation.path, { force: true });
  }

  /** Stop every child of `bot` and forget its conversations, e.g. before archiving the bot. */
  async closeBot(bot: Bot): Promise<void> {
    const mine = [...this.open.entries()].filter(([, conversation]) => conversation.bot.name === bot.name);
    for (const [id] of mine) this.open.delete(id);
    await Promise.all(mine.map(([, conversation]) => conversation.close()));
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.open.values()].map(conversation => conversation.close()));
  }
}

const key = (bot: Bot, id: string) => `${bot.name}\u0000${id}`;

async function headerCwd(path: string): Promise<string> {
  const firstLine = (await readFile(path, "utf8")).split("\n", 1)[0] ?? "";
  try { return String((JSON.parse(firstLine) as { cwd?: string }).cwd ?? process.cwd()); } catch { return process.cwd(); }
}
