import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { registerVoice } from "../index.ts";
import type { DictationOptions, DictationSession } from "../src/dictation.ts";
import { VoiceSession } from "../src/session.ts";
import type { SessionOptions } from "../src/session.ts";
import { MediaUnavailableError } from "../src/transport.ts";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "pi-voice-extension-"));
  const handlers = new Map<string, (event: any, ctx?: any) => any>();
  let command!: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  let terminal: ((data: string) => { consume?: boolean } | undefined) | undefined;
  const notifications: string[] = [], entries: { type: string; customType: string; data: unknown }[] = [];
  const messages: any[] = [];
  let sessionOptions!: SessionOptions;
  let dictationOptions: DictationOptions | undefined;
  let starts = 0, stops = 0, mutes = 0, widget = false, toggles = 0, dictationStops = 0, status: string | undefined;
  let startError: Error | undefined;
  let stopError: Error | undefined;
  let editor = "";
  const fakeSession = {
    state: { phase: "listening" },
    async start() { starts++; if (startError) throw startError; },
    async stop() { stops++; if (stopError) throw stopError; },
    toggleMute() { mutes++; },
    backendDelegationStarted() {}, backendMessage() {}, backendSettled() {},
  } as unknown as VoiceSession;
  const fakeDictation = {
    state: { phase: "ready" },
    toggle() { toggles++; },
    async stop() { dictationStops++; },
  } as unknown as DictationSession;
  const ctx = {
    mode: "tui", ui: {
      notify: (text: string) => notifications.push(text),
      setWidget: (_key: string, content: unknown) => { widget = content !== undefined; },
      setStatus: (_key: string, text: string | undefined) => { status = text; },
      getEditorText: () => editor,
      setEditorText: (text: string) => { editor = text; },
      pasteToEditor: (text: string) => { editor += text; },
      onTerminalInput: (callback: typeof terminal) => { terminal = callback; return () => { terminal = undefined; }; },
    },
    sessionManager: { getSessionId: () => "test", getBranch: () => entries },
    modelRegistry: { getProvider: () => undefined, getProviderAuth: async () => ({ source: "OAuth", auth: { apiKey: "test" } }) },
  } as unknown as ExtensionCommandContext;
  const pi = {
    registerCommand: (_name: string, config: { handler: typeof command }) => { command = config.handler; },
    registerEntryRenderer() {},
    on: (event: string, handler: typeof handlers extends Map<string, infer H> ? H : never) => { handlers.set(event, handler); return () => {}; },
    appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
    sendMessage: (...args: unknown[]) => messages.push(args),
  } as unknown as ExtensionAPI;
  registerVoice(pi, {
    settingsPath: join(directory, "voice.json"),
    session: options => { sessionOptions = options; return fakeSession; },
    dictation: options => { dictationOptions = options; return fakeDictation; },
  });
  return {
    command: (args: string) => command(args, ctx), ctx, handlers, entries, messages, notifications,
    get callbacks() { return sessionOptions; }, key: (data: string) => terminal?.(data),
    counts: () => ({ starts, stops, mutes, widget }),
    dictation: () => ({ options: dictationOptions, toggles, stops: dictationStops, status }),
    failStart: (error: Error) => { startError = error; },
    failStop: (error: Error) => { stopError = error; },
    get editor() { return editor; }, set editor(value: string) { editor = value; },
    cleanup: () => rm(directory, { recursive: true }),
  };
}

test("extension registers side-effect-free, on/off is idempotent, key only intercepted while active", async () => {
  const f = await fixture();
  try {
    assert.equal(f.counts().starts, 0);
    assert.equal(f.key("\x18"), undefined);
    await f.command("on"); await f.command("on");
    assert.equal(f.counts().starts, 1);
    assert.deepEqual(f.key("\x18"), { consume: true });
    assert.equal(f.counts().mutes, 1);
    // Kitty Ctrl+X press/repeat/release: only the initial press toggles.
    f.key("\x1b[120;5:1u"); f.key("\x1b[120;5:2u"); f.key("\x1b[120;5:3u");
    assert.equal(f.counts().mutes, 2);
    await f.command("key f9");
    assert.equal(f.key("\x18"), undefined);
    f.key("\x1b[20~");
    assert.equal(f.counts().mutes, 3);
    await f.command("off"); await f.command("off");
    assert.equal(f.counts().stops, 1);
    assert.equal(f.counts().widget, false);
    assert.equal(f.key("\x1b[20~"), undefined);
  } finally { await f.command("off"); await f.cleanup(); }
});

test("transcripts persist without coding turns; only delegation starts/steers Pi", async () => {
  const f = await fixture();
  try {
    await f.command("on");
    f.callbacks.onTranscript({ role: "user", turn: 1, text: "Hello", final: false });
    assert.equal(f.entries.length, 0);
    f.callbacks.onTranscript({ role: "user", turn: 1, text: "Hello.", final: true });
    assert.equal(f.entries.length, 1);
    assert.equal(f.messages.length, 0);
    f.callbacks.onDelegate("d", "Please fix the test");
    assert.equal(f.messages.length, 1);
    assert.equal(f.messages[0][1].triggerTurn, true);
    assert.equal(f.messages[0][1].deliverAs, "steer");
    assert.match(f.messages[0][0].content, /user: Hello\./);
    await f.handlers.get("session_shutdown")!({});
    assert.equal(f.counts().stops, 1);
  } finally { await f.command("off"); await f.cleanup(); }
});

test("off also cancels on during asynchronous config loading; non-TUI cannot start", async () => {
  const f = await fixture();
  try {
    const pending = f.command("on");
    await f.command("off"); await pending;
    assert.equal(f.counts().starts, 0);
    f.ctx.mode = "rpc";
    await f.command("on");
    assert.equal(f.counts().starts, 0);
    assert.match(f.notifications.at(-1)!, /interactive/);
  } finally { await f.command("off"); await f.cleanup(); }
});

test("blocked realtime media falls back to dictation; the key records instead of muting", async () => {
  const f = await fixture();
  try {
    f.failStart(new MediaUnavailableError());
    await f.command("on");
    assert.equal(f.counts().stops, 1);
    assert.equal(f.dictation().status, "dictation ●");
    assert.match(f.notifications.at(-1)!, /UDP.*Switched to dictation/s);
    assert.deepEqual(f.key("\x18"), { consume: true });
    assert.equal(f.counts().mutes, 0);
    assert.equal(f.dictation().toggles, 1);
    // Delegation hooks are realtime-only.
    await f.handlers.get("agent_settled")!({ aborted: false });
    await f.command("off");
    assert.equal(f.dictation().stops, 1);
    assert.equal(f.key("\x18"), undefined);
  } finally { await f.command("off"); await f.cleanup(); }
});

test("other realtime failures do not fall back to dictation", async () => {
  const f = await fixture();
  try {
    f.failStart(new Error("ChatGPT voice signaling failed (HTTP 403)."));
    await f.command("on");
    assert.equal(f.dictation().options, undefined);
    assert.match(f.notifications.at(-1)!, /HTTP 403/);
  } finally { await f.command("off"); await f.cleanup(); }
});

test("/voice dictate skips realtime and inserts transcripts into the editor", async () => {
  const f = await fixture();
  try {
    await f.command("dictate");
    assert.equal(f.counts().starts, 0);
    const options = f.dictation().options!;
    const editor = (): string => f.editor;
    options.onText("Fix the build.");
    assert.equal(editor(), "Fix the build.");
    options.onText("Then run tests.");
    assert.equal(editor(), "Fix the build. Then run tests.");
    const long = "x".repeat(1200);
    options.onText(long);
    assert.equal(editor(), `Fix the build. Then run tests. ${long}`);
    await f.command("off");
    options.onText("late");
    assert.ok(!editor().endsWith("late"));
  } finally { await f.command("off"); await f.cleanup(); }
});


test("stop rejection reaches its caller without an unhandled cleanup promise", async () => {
  const f = await fixture();
  try {
    await f.command("on");
    f.failStop(new Error("stop failed"));
    await assert.rejects(f.command("off"), /stop failed/);
    // A finally() chain used only for cleanup used to reject independently here.
    await new Promise<void>(resolve => { setImmediate(resolve); });
    await f.command("off");
    assert.equal(f.counts().stops, 1);
  } finally { await f.cleanup(); }
});
