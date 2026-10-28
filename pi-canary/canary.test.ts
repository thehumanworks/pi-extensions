import { describe, expect, mock, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Set PI_CANARY_SDK to the installed Pi dist/index.js when this standalone
// extension is not in a package with @earendil-works/pi-coding-agent installed.
const sdk = await import(process.env.PI_CANARY_SDK || "@earendil-works/pi-coding-agent");
await mock.module("@earendil-works/pi-coding-agent", () => sdk);
// An absolute override lets the same tests measure a saved baseline version.
const extensionPath = process.env.PI_CANARY_EXTENSION || join(import.meta.dir, "canary.ts");
const canary = (await import(extensionPath)).default;

const usage = {
  input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const toolCall = { type: "toolCall", id: "call-1", name: "test_tool", arguments: {} };
const thinking = { type: "thinking", thinking: "private reasoning, not a prefix" };
// A missed prefix only triggers recovery while the agent is still working.
const midRun = (text = "Missing prefix", id = "call-0") => [{ type: "text", text }, { ...toolCall, id }];
const handover = "chirp: # Canary handover\n## Goal\nFinish the original task.\n## Current state\nTests pass.\n## Next steps\nReview the changes.";
const assistant = (content: string | any[], stopReason = "stop") => ({
  role: "assistant", content: typeof content === "string" ? [{ type: "text", text: content }] : content,
  api: "openai-completions", provider: "canary-test", model: "test", usage, stopReason, timestamp: Date.now(),
});

function harness(settings: Record<string, unknown> = { canary: "chirp" }) {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const commands = new Map<string, any>();
  const notifications: any[] = [];
  const summaryCalls: any[] = [];
  const drafts: any[] = [];
  const manager = sdk.SessionManager.inMemory(process.cwd());
  const controller = new AbortController();
  let summaryImpl = async (..._args: any[]) => assistant("## Summary\nOriginal task, decisions, and remaining work.");
  let pending = false;
  let abortCount = 0;
  const ctx: any = {
    hasUI: true, mode: "tui", cwd: process.cwd(), sessionManager: manager,
    signal: controller.signal,
    model: { id: "test", provider: "canary-test", maxTokens: 4096 },
    modelRegistry: { complete: async (...args: any[]) => {
      summaryCalls.push(args);
      return summaryImpl(...args);
    } },
    ui: { notify: (...args: any[]) => notifications.push(args), setStatus: mock(() => {}) },
    hasPendingMessages: () => pending,
    isProjectTrusted: () => false,
    waitForIdle: async () => {},
    abort: () => { abortCount++; controller.abort(); },
  };
  let initialized = false;
  const pi: any = {
    on: (name: string, fn: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, fn),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    getSettings: () => {
      if (!initialized) throw new Error("Settings are not available during extension loading");
      return structuredClone(settings);
    },
    appendEntry: (name: string, data: unknown) => manager.appendCustomEntry(name, data),
  };
  canary(pi);
  initialized = true;
  const emit = async (type: string, event: any = {}) => handlers.get(type)?.({ type, ...event }, ctx);
  const boundary = (type: string, overrides: any = {}) => ({
    type, outcome: "completed", entries: [], continue: false,
    context: {
      contextMessages: manager.buildSessionProjection().messages,
      llmMessages: sdk.convertToLlm(manager.buildSessionProjection().messages),
      pendingMessages: [], canContinue: true,
    },
    ...overrides,
  });
  const apply = (result: any) => {
    for (const draft of result?.entries || []) {
      drafts.push(draft);
      if (draft.type === "custom_message") {
        manager.appendCustomMessageEntry(draft.customType, draft.content, draft.display, draft.details);
      } else if (draft.type === "compaction") {
        manager.appendCompaction(draft.summary, draft.firstKeptEntryId, 500, draft.details, true, draft.usage);
      } else throw new Error(`Unexpected draft: ${draft.type}`);
    }
    return result;
  };
  return {
    ctx, manager, handlers, settings, notifications, summaryCalls, drafts, controller,
    emit, boundary, apply,
    setPending: (value: boolean) => { pending = value; },
    setSummary: (fn: typeof summaryImpl) => { summaryImpl = fn; },
    abortCount: () => abortCount,
    command: (action = "") => commands.get("canary").handler(action, ctx),
    async start(options: any = {}) {
      const event: any = {
        messageType: "user", prompt: "Original user task",
        systemPrompt: "Existing system instructions",
        systemPromptOptions: { sections: {}, ...options },
      };
      await emit("before_agent_start", event);
      manager.appendMessage({
        role: "system", content: options.forceSystemPrompt || "Existing system instructions",
        sections: event.systemPromptOptions.sections,
        toolsAdded: [{ name: "test_tool", description: "A test tool", parameters: { type: "object", properties: {} } }],
        timestamp: Date.now(),
      });
      const message = { role: "user", content: "Original user task", timestamp: Date.now() };
      await emit("message_start", { message });
      manager.appendMessage(message);
      return event;
    },
    async reply(content: string | any[], reason = "stop", overrides: any = {}) {
      const message = assistant(content, reason);
      await emit("message_end", { message });
      const id = manager.appendMessage(message);
      return apply(await emit("turn_end", boundary("turn_end", {
        message, messageEntryId: id, toolResults: [], toolResultEntryIds: [], turnIndex: 0, ...overrides,
      })));
    },
    async settle(overrides: any = {}) {
      return apply(await emit("agent_before_settle", boundary("agent_before_settle", overrides)));
    },
    async fail() {
      await this.command("on");
      await this.start();
      return this.reply(midRun(), "toolUse");
    },
  };
}

async function withKeywordHarness(
  run: (h: ReturnType<typeof harness> & { globalPath: string; projectPath: string; reloads: ReturnType<typeof mock> }) => Promise<void>,
  options: { global?: Record<string, unknown>; project?: Record<string, unknown>; trusted?: boolean } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "pi-canary-settings-"));
  const agentDir = join(dir, "agent");
  const cwd = join(dir, "project");
  const globalPath = join(agentDir, "settings.json");
  const projectPath = join(cwd, ".pi", "settings.json");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    mkdirSync(cwd, { recursive: true });
    if (options.global) {
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(globalPath, JSON.stringify(options.global));
    }
    if (options.project) {
      mkdirSync(join(cwd, ".pi"), { recursive: true });
      writeFileSync(projectPath, JSON.stringify(options.project));
    }
    const h = harness({ ...options.global, ...(options.trusted ? options.project : {}) });
    h.ctx.cwd = cwd;
    h.ctx.isProjectTrusted = () => options.trusted === true;
    const reloads = mock(async () => {
      for (const key of Object.keys(h.settings)) delete h.settings[key];
      if (existsSync(globalPath)) Object.assign(h.settings, JSON.parse(readFileSync(globalPath, "utf8")));
      if (options.trusted && existsSync(projectPath)) Object.assign(h.settings, JSON.parse(readFileSync(projectPath, "utf8")));
      await h.emit("session_start", { reason: "reload" });
    });
    h.ctx.reload = reloads;
    await run({ ...h, globalPath, projectPath, reloads });
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("canary keyword command and settings persistence", () => {
  test("a keyword creates settings, preserves case, reloads, and defaults to on", async () => {
    await withKeywordHarness(async (h) => {
      await h.command("  ChIrP  ");
      expect(JSON.parse(readFileSync(h.globalPath, "utf8"))).toEqual({ canary: "ChIrP" });
      expect(h.reloads).toHaveBeenCalledTimes(1);
      expect(h.settings.canary).toBe("ChIrP");
      expect(h.manager.getBranch().at(-1).data.enabled).toBe(true);
      expect((await h.start()).systemPromptOptions.sections.canary).toContain("ChIrP: {{message}}");
      await h.reply("ChIrP: Done");
      expect(await h.settle()).toBeUndefined();
      expect(statSync(h.globalPath).mode & 0o777).toBe(0o600);
      expect(readdirSync(join(h.globalPath, ".."))).toEqual(["settings.json"]);
    });
  });

  test("bare /canary is read-only status; every other word, including status, is a keyword", async () => {
    await withKeywordHarness(async (h) => {
      await h.command();
      expect(existsSync(h.globalPath)).toBe(false);
      expect(h.reloads).not.toHaveBeenCalled();
      await h.command("status");
      expect(h.settings.canary).toBe("status");
      expect((await h.start()).systemPromptOptions.sections.canary).toContain("status: {{message}}");
      const saved = readFileSync(h.globalPath, "utf8");
      await h.command("off");
      expect((await h.start()).systemPromptOptions.sections).toEqual({});
      await h.command("ON");
      expect((await h.start()).systemPromptOptions.sections.canary).toContain("status: {{message}}");
      expect(readFileSync(h.globalPath, "utf8")).toBe(saved);
      expect(h.reloads).toHaveBeenCalledTimes(1);
    });
  });

  test("keeps the whole keyword argument and preserves unrelated settings", async () => {
    const global = { theme: "dark", canary: "old", nested: { value: 1 }, extensions: ["./canary.ts"] };
    await withKeywordHarness(async (h) => {
      await h.command("Blue Canary");
      expect(JSON.parse(readFileSync(h.globalPath, "utf8"))).toEqual({ ...global, canary: "Blue Canary" });
      expect((await h.start()).systemPromptOptions.sections.canary).toContain("Blue Canary: {{message}}");
    }, { global });
  });

  test("updates a trusted project's existing override rather than a shadowed global value", async () => {
    const global = { canary: "global", theme: "dark" };
    const project = { canary: "old-project", retry: { enabled: false } };
    await withKeywordHarness(async (h) => {
      await h.command("new-project");
      expect(JSON.parse(readFileSync(h.projectPath, "utf8"))).toEqual({ ...project, canary: "new-project" });
      expect(JSON.parse(readFileSync(h.globalPath, "utf8"))).toEqual(global);
      expect(h.settings.canary).toBe("new-project");
    }, { global, project, trusted: true });
  });

  for (const trusted of [false, true]) {
    test(`uses user settings when project has no active override (trusted=${trusted})`, async () => {
      const project = trusted ? { theme: "light" } : { canary: "untrusted" };
      await withKeywordHarness(async (h) => {
        await h.command("user-keyword");
        expect(h.settings.canary).toBe("user-keyword");
        expect(JSON.parse(readFileSync(h.globalPath, "utf8"))).toEqual({ canary: "user-keyword" });
        expect(JSON.parse(readFileSync(h.projectPath, "utf8"))).toEqual(project);
      }, { project, trusted });
    });
  }

  for (const keyword of ["two\nlines", "two\twords", "nul\u0000word"]) {
    test(`rejects an invalid keyword without creating settings: ${JSON.stringify(keyword)}`, async () => {
      await withKeywordHarness(async (h) => {
        await h.command(keyword);
        expect(existsSync(h.globalPath)).toBe(false);
        expect(h.manager.getBranch()).toHaveLength(0);
        expect(h.reloads).not.toHaveBeenCalled();
        expect(h.notifications.at(-1)[1]).toBe("error");
      });
    });
  }

  for (const source of ["{ broken", "[]", "null", '"not an object"']) {
    test(`refuses to overwrite malformed settings: ${source}`, async () => {
      await withKeywordHarness(async (h) => {
        writeFileSync(h.globalPath, source);
        await h.command("new-keyword");
        expect(readFileSync(h.globalPath, "utf8")).toBe(source);
        expect(h.reloads).not.toHaveBeenCalled();
        expect(h.manager.getBranch()).toHaveLength(0);
        expect(existsSync(`${h.globalPath}.lock`)).toBe(false);
        expect(h.notifications.at(-1)[0]).toContain("Could not save");
      }, { global: {} });
    });
  }

  test("does not overwrite a locked settings file or remove another writer's lock", async () => {
    await withKeywordHarness(async (h) => {
      mkdirSync(`${h.globalPath}.lock`);
      await h.command("new-keyword");
      expect(JSON.parse(readFileSync(h.globalPath, "utf8"))).toEqual({ canary: "old" });
      expect(existsSync(`${h.globalPath}.lock`)).toBe(true);
      expect(h.reloads).not.toHaveBeenCalled();
      expect(h.notifications.at(-1)[0]).toContain("Settings are busy");
    }, { global: { canary: "old" } });
  });

  test("preserves settings symlinks and target permissions", async () => {
    await withKeywordHarness(async (h) => {
      const target = join(h.globalPath, "..", "linked-settings.json");
      renameSync(h.globalPath, target);
      symlinkSync(target, h.globalPath);
      const mode = statSync(target).mode & 0o777;
      await h.command("new-keyword");
      expect(lstatSync(h.globalPath).isSymbolicLink()).toBe(true);
      expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ canary: "new-keyword" });
      expect(statSync(target).mode & 0o777).toBe(mode);
    }, { global: { canary: "old" } });
  });

  test("a later off cancels a pending keyword change before it writes settings", async () => {
    await withKeywordHarness(async (h) => {
      let release!: () => void;
      h.ctx.waitForIdle = () => new Promise<void>((resolve) => { release = resolve; });
      const change = h.command("new-keyword");
      await h.command("off");
      release(); await change;
      expect(existsSync(h.globalPath)).toBe(false);
      expect(h.reloads).not.toHaveBeenCalled();
      expect((await h.start()).systemPromptOptions.sections).toEqual({});
    });
  });
});

describe("canary settings, command, and system prompt", () => {
  test("does not read runtime settings during factory loading; mode defaults off", async () => {
    const h = harness();
    expect((await h.start()).systemPromptOptions.sections).toEqual({});
    await h.reply("No prefix needed");
    expect(await h.settle()).toBeUndefined();
  });

  for (const value of [undefined, true, false, 42, {}, "", "   ", "two\nlines", "a\tb"]) {
    test(`rejects invalid settings.canary ${JSON.stringify(value)}`, async () => {
      const h = harness({ canary: value });
      await h.command("on");
      expect(h.manager.getBranch()).toHaveLength(0);
      expect(h.notifications.at(-1)[1]).toBe("error");
      expect((await h.start()).systemPromptOptions.sections).toEqual({});
    });
  }

  test("requires both a string setting and /canary on; persists and restores branch-local mode", async () => {
    const h = harness({ canary: " chirp " });
    await h.command("ON");
    const on = h.manager.getBranch().at(-1);
    expect(on.customType).toBe("canary-mode");
    expect(on.data.enabled).toBe(true);
    let event = await h.start();
    expect(event.systemPromptOptions.sections.canary).toContain('"chirp: "');
    expect(event.systemPromptOptions.sections.canary).toContain("Thinking/reasoning blocks, structured tool calls");
    await h.command("off");
    expect((await h.start()).systemPromptOptions.sections).toEqual({});
    h.manager.branch(on.id);
    await h.emit("session_tree");
    event = await h.start();
    expect(event.systemPromptOptions.sections.canary).toContain("CANARY MODE IS ON");
    await h.emit("session_start", { reason: "reload" });
    expect((await h.start()).systemPromptOptions.sections.canary).toContain("chirp");
    h.manager.resetLeaf();
    await h.emit("session_start", { reason: "new" });
    expect((await h.start()).systemPromptOptions.sections).toEqual({});
  });

  test("a pending /canary on cannot overwrite a later off command or session switch", async () => {
    for (const action of ["off", "session_start", "session_shutdown", "keyword-removed"]) {
      const h = harness();
      let release!: () => void;
      h.ctx.waitForIdle = () => new Promise<void>((resolve) => { release = resolve; });
      const pendingOn = h.command("on");
      if (action === "off") await h.command("off");
      else if (action === "keyword-removed") delete h.settings.canary;
      else await h.emit(action);
      release();
      await pendingOn;
      expect((await h.start()).systemPromptOptions.sections).toEqual({});
    }
  });

  test("preserves forced system prompts and supports status/usage", async () => {
    const h = harness();
    await h.command();
    expect(h.notifications.at(-1)[0]).toContain("off");
    await h.command("invalid\nkeyword");
    expect(h.notifications.at(-1)[0]).toContain("single-line");
    await h.command("on");
    const event = await h.start({ forceSystemPrompt: "Keep these instructions" });
    expect(event.systemPromptOptions.forceSystemPrompt).toStartWith("Keep these instructions\n\n<canary>");
    expect(event.systemPromptOptions.forceSystemPrompt).toContain("chirp: {{message}}");
    delete h.settings.canary;
    await h.start();
    await h.reply("No canary configured");
    expect(await h.settle()).toBeUndefined();
  });
});

describe("prefix detection", () => {
  for (const text of ["chirp: Correct", "chirp: \nMultiline"]) {
    test(`accepts exact prefix: ${JSON.stringify(text)}`, async () => {
      const h = harness();
      await h.command("on"); await h.start();
      await h.reply(text);
      expect(await h.settle()).toBeUndefined();
    });
  }
  for (const text of ["Prefix appears later: chirp: bad", " chirp: bad", "**chirp**: bad", "Chirp: bad", "chirp:bad"]) {
    test(`flags a non-prefix match: ${JSON.stringify(text)}`, async () => {
      const h = harness();
      await h.command("on"); await h.start();
      const result = await h.reply(midRun(text), "toolUse");
      expect(result.continue).toBe(true);
      expect(result.entries[0].customType).toBe("canary-handover-request");
    });
  }
  test("ignores reasoning, tool-only messages, and tool results; joins text blocks", async () => {
    const h = harness();
    await h.command("on"); await h.start();
    await h.reply([thinking, toolCall], "toolUse");
    await h.emit("message_end", { message: { role: "toolResult", content: [{ type: "text", text: "no prefix" }] } });
    await h.reply([thinking, { type: "text", text: "chir" }, { type: "text", text: "p: fine" }]);
    expect(await h.settle()).toBeUndefined();
  });
  test("checks each message: a mid-run miss requests a handover immediately", async () => {
    const h = harness();
    await h.command("on"); await h.start();
    await h.reply("chirp: Planning", "toolUse");
    const result = await h.reply(midRun("Bad commentary"), "toolUse");
    expect(result.entries[0].customType).toBe("canary-handover-request");
    expect(await h.emit("tool_call", { toolName: "test_tool" })).toMatchObject({ block: true });
  });
  for (const reason of ["stop", "length"]) {
    test(`a miss on the final message (${reason}) does not request a handover, block, or compact`, async () => {
      const h = harness();
      await h.command("on"); await h.start();
      await h.reply([toolCall], "toolUse");
      expect(await h.reply("Final answer without prefix", reason)).toBeUndefined();
      expect(await h.settle()).toBeUndefined();
      expect(await h.emit("tool_call", { toolName: "test_tool" })).toBeUndefined();
      expect(h.summaryCalls).toHaveLength(0);
      expect(h.drafts).toHaveLength(0);
      expect(h.abortCount()).toBe(0);
      expect(h.notifications.at(-1)).toEqual([expect.stringContaining("No handover requested"), "warning"]);
      await h.start();
      expect((await h.reply(midRun(), "toolUse")).continue).toBe(true);
    });
  }
});

describe("handover, compaction, and fresh-context continuation", () => {
  test("forces handover, blocks tools, atomically compacts all history and resumes with the handover", async () => {
    const h = harness();
    const request = await h.fail();
    expect(request.continue).toBe(true);
    expect(request.entries[0].content).toContain("CANARY FAILURE");
    expect(request.entries[0].content).toContain("Do not call tools");
    expect(await h.emit("tool_call", { toolName: "test_tool" })).toMatchObject({ block: true });
    const result = await h.reply([thinking, { type: "text", text: handover }]);
    expect(result.continue).toBe(true);
    expect(result.entries.map((entry: any) => entry.type)).toEqual(["compaction", "custom_message"]);
    expect(result.entries[0].firstKeptEntryId).toBeNull();
    expect(result.entries[0].usage).toEqual(usage);
    expect(result.entries[1].content).toContain(handover);
    const messages = h.manager.buildSessionProjection().messages;
    expect(messages.map((message: any) => message.role)).toEqual(["system", "compactionSummary", "custom"]);
    expect(messages[0].sections.canary).toContain("chirp: {{message}}");
    expect(messages[0].toolsAdded[0].name).toBe("test_tool");
    expect(h.manager.getBranch().some((entry: any) => entry.type === "message" && entry.message.content?.[0]?.text === "Missing prefix")).toBe(true);
    const [, context, options] = h.summaryCalls[0];
    expect(context.messages[0].content).toContain("Original user task");
    expect(context.messages[0].content).not.toContain("private reasoning");
    expect(context.tools).toBeUndefined();
    expect(options.signal).toBe(h.controller.signal);
    expect(options.maxTokens).toBe(4096);
    expect(await h.emit("tool_call", { toolName: "test_tool" })).toBeUndefined();
    await h.reply("chirp: Continued from the fresh context");
    expect(await h.settle()).toBeUndefined();
  });

  test("only accepts a completed, correctly prefixed handover and bounds retries", async () => {
    const h = harness(); await h.fail();
    await h.reply("chirp: Not a handover");
    expect((await h.settle()).continue).toBe(true);
    const result = await h.reply(handover, "length");
    expect(result.entries[0].customType).toBe("canary-recovery-failed");
    expect(h.summaryCalls).toHaveLength(0);
    expect(h.abortCount()).toBe(1);
    expect(await h.settle()).toBeUndefined();
  });

  test("repeated blocked handover tool calls cannot loop forever", async () => {
    const h = harness(); await h.fail();
    for (let i = 0; i < 2; i++) {
      expect(await h.emit("tool_call", { toolName: "test_tool" })).toMatchObject({ block: true });
      await h.reply([toolCall], "toolUse");
    }
    expect(h.abortCount()).toBe(1);
    expect(h.drafts.at(-1).customType).toBe("canary-recovery-failed");
    expect(h.summaryCalls).toHaveLength(0);
  });

  test("limits restarts to one per user message, but resets the limit for the next user", async () => {
    const h = harness(); await h.fail(); await h.reply(handover);
    expect(await h.reply("Final answer without prefix")).toBeUndefined();
    const result = await h.reply(midRun("Bad again"), "toolUse");
    expect(result.entries[0].content).toContain("once per user message");
    expect(result.continue).toBe(false);
    expect(h.abortCount()).toBe(1);
    h.ctx.signal = new AbortController().signal;
    await h.start();
    expect((await h.reply(midRun("Another missing prefix"), "toolUse")).continue).toBe(true);
  });

  for (const outcome of ["error", "aborted"]) {
    test(`does not start recovery after ${outcome}`, async () => {
      const h = harness(); await h.command("on"); await h.start();
      await h.reply("No prefix", outcome);
      expect(await h.settle({ outcome })).toBeUndefined();
    });
  }

  for (const response of [assistant(""), assistant("Partial summary", "length"), assistant("", "error")]) {
    test(`does not discard history for an invalid summary: ${response.stopReason}/${response.content[0]?.text}`, async () => {
      const h = harness(); await h.fail(); h.setSummary(async () => response);
      const result = await h.reply(handover);
      expect(result.entries[0].customType).toBe("canary-recovery-failed");
      expect(h.drafts.some((draft: any) => draft.type === "compaction")).toBe(false);
      expect(h.manager.buildSessionProjection().messages.some((message: any) => message.role === "assistant")).toBe(true);
    });
  }

  test("handles thrown summary errors and missing model without losing handover or history", async () => {
    for (const missingModel of [false, true]) {
      const h = harness(); await h.fail();
      if (missingModel) h.ctx.model = undefined;
      else h.setSummary(async () => { throw new Error("Provider unavailable"); });
      const result = await h.reply(handover);
      expect(result.entries[0].customType).toBe("canary-recovery-failed");
      expect(h.manager.buildSessionProjection().messages.some((message: any) => message.role === "assistant" && message.content[0]?.text === handover)).toBe(true);
      expect(h.drafts.some((draft: any) => draft.type === "compaction")).toBe(false);
    }
  });

  test("cancelling compaction, disabling mode, and new queued input do not compact stale history", async () => {
    for (const action of ["abort", "off", "pending", "keyword-change", "shutdown"]) {
      const h = harness(); await h.fail();
      h.setSummary(async () => {
        if (action === "abort") h.controller.abort();
        if (action === "off") await h.command("off");
        if (action === "pending") h.setPending(true);
        if (action === "keyword-change") h.settings.canary = "new-keyword";
        if (action === "shutdown") await h.emit("session_shutdown");
        return assistant("Valid summary");
      });
      expect(await h.reply(handover)).toBeUndefined();
      expect(h.drafts.some((draft: any) => draft.type === "compaction")).toBe(false);
    }
  });

  test("defers to queued messages and other boundary continuations", async () => {
    const h = harness();
    await h.command("on"); await h.start();
    h.setPending(true);
    expect(await h.reply(midRun("Bad prefix"), "toolUse")).toBeUndefined();
    h.setPending(false);
    expect(await h.settle()).toBeUndefined();
    await h.fail(); await h.reply("chirp: Not a handover");
    expect(await h.settle({ continue: true })).toBeUndefined();
    h.setPending(true);
    expect(await h.settle()).toBeUndefined();
    h.setPending(false);
    expect((await h.settle()).continue).toBe(true);
    await h.emit("message_start", { message: { role: "user", content: "New task" } });
    expect(await h.emit("tool_call", { toolName: "test_tool" })).toBeUndefined();
    expect(await h.settle()).toBeUndefined();
  });

  test("headless mode still enforces and recovers without UI calls", async () => {
    const h = harness(); h.ctx.hasUI = false;
    h.ctx.ui = new Proxy({}, { get: () => { throw new Error("UI is unavailable"); } });
    await h.fail();
    expect((await h.reply(handover)).continue).toBe(true);
  });
});

// These tests load canary.ts through Pi's real file loader and run the actual
// extension runner, model runtime, lifecycle, and projection. Only the provider
// is scripted; there are no network calls or changes to the user's settings.
async function realSession(responses: any[], options: { fileSettings?: boolean; command?: string; beforeCanary?: string } = {}) {
  const ai = await import(import.meta.resolve("@earendil-works/pi-ai", process.env.PI_CANARY_SDK || import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "pi-canary-"));
  let session: any;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const cleanup = () => {
    session?.dispose();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    const runtime = await sdk.ModelRuntime.create({
      authPath: join(dir, "auth.json"), modelsPath: null, modelsStorePath: join(dir, "models.json"),
      allowModelNetwork: false, refreshOnCreate: false,
    });
    const calls: any[] = [];
    runtime.registerProvider("canary-test", {
      api: "openai-completions", baseUrl: "https://unused.invalid", apiKey: "not-a-real-key",
      models: [{ id: "test", name: "Test", reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 8192,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      streamSimple: (_model: any, context: any, options: any) => {
        calls.push({ context: structuredClone(context), signal: options.signal });
        const scripted = responses.shift();
        if (!scripted) throw new Error("Unexpected extra model request");
        const stream = ai.createAssistantMessageEventStream();
        void Promise.resolve(typeof scripted === "function" ? scripted(options.signal) : scripted).then((response) => {
          stream.push({ type: "start", partial: { ...response, content: [], stopReason: "pending" } });
          if (response.stopReason === "aborted" || response.stopReason === "error") {
            stream.push({ type: "error", reason: response.stopReason, error: response });
          } else {
            stream.push({ type: "done", reason: response.stopReason, message: response });
          }
          stream.end();
        }).catch((error: unknown) => {
          const failure = assistant("", "error");
          stream.push({ type: "error", reason: "error", error: { ...failure, errorMessage: String(error) } });
          stream.end();
        });
        return stream;
      },
    });
    const initialSettings = { canary: "chirp", compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" };
    const settingsPath = join(dir, "settings.json");
    if (options.fileSettings) writeFileSync(settingsPath, JSON.stringify(initialSettings));
    const settings = options.fileSettings
      ? sdk.SettingsManager.create(dir, dir)
      : sdk.SettingsManager.inMemory(initialSettings);
    const earlierExtension = join(dir, "earlier-extension.ts");
    if (options.beforeCanary) writeFileSync(earlierExtension, options.beforeCanary);
    const loader = new sdk.DefaultResourceLoader({
      cwd: dir, agentDir: dir, settingsManager: settings, noExtensions: true,
      noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [...(options.beforeCanary ? [earlierExtension] : []), extensionPath], systemPrompt: "Existing system instructions.",
    });
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);
    const errors: any[] = [];
    let executions = 0;
    const result = await sdk.createAgentSession({
      cwd: dir, agentDir: dir, modelRuntime: runtime, model: runtime.getModel("canary-test", "test"),
      resourceLoader: loader, settingsManager: settings, sessionManager: sdk.SessionManager.inMemory(dir), tools: ["test_tool"], thinkingLevel: "off",
      customTools: [{ name: "test_tool", label: "Test", description: "Test tool", parameters: ai.Type.Object({}),
        execute: async () => { executions++; return { content: [{ type: "text", text: "Executed" }], details: undefined }; } }],
    });
    session = result.session;
    await session.bindExtensions({
      mode: "print", onError: (error: any) => errors.push(error),
      commandContextActions: {
        waitForIdle: () => session.waitForIdle(),
        reload: () => session.reload(),
      },
    });
    await session.prompt(options.command || "/canary on");
    return { session, calls, errors, cleanup, settingsPath, executions: () => executions };
  } catch (error) { cleanup(); throw error; }
}

test("real Pi lifecycle: keyword command persists, reloads settings, and enables the new prefix immediately", async () => {
  const h = await realSession([assistant("NeW: Done.")], { fileSettings: true, command: "/canary NeW" });
  try {
    expect(h.session.settingsManager.getSettings().canary).toBe("NeW");
    const saved = JSON.parse(readFileSync(h.settingsPath, "utf8"));
    expect(saved.canary).toBe("NeW");
    expect(saved.compaction).toEqual({ enabled: false });
    await h.session.prompt("Complete the original request.");
    expect(h.errors).toEqual([]);
    expect(h.calls).toHaveLength(1);
    expect(JSON.stringify(h.calls[0].context)).toContain("NeW: {{message}}");
    expect(h.session.getLastAssistantText()).toBe("NeW: Done.");
    await h.session.prompt("/canary off");
    expect(JSON.parse(readFileSync(h.settingsPath, "utf8")).canary).toBe("NeW");
  } finally { h.cleanup(); }
}, 20000);

test("real Pi lifecycle: file-loaded extension -> handover -> compaction -> automatic continuation", async () => {
  const responses = [assistant(midRun(), "toolUse"), assistant(handover), assistant("## Summary\nThe original request is complete."), assistant("chirp: Finished.")];
  const h = await realSession(responses);
  try {
    await h.session.prompt("Complete the original request.");
    expect(h.errors).toEqual([]);
    expect(responses).toHaveLength(0);
    expect(h.calls).toHaveLength(4);
    expect(JSON.stringify(h.calls[0].context)).toContain("chirp: {{message}}");
    expect(JSON.stringify(h.calls[1].context)).toContain("CANARY FAILURE");
    expect(h.calls[2].signal).toBeInstanceOf(AbortSignal);
    expect(JSON.stringify(h.calls[2].context)).toContain("conversation compaction assistant");
    expect(JSON.stringify(h.calls[3].context)).toContain("The original request is complete");
    expect(JSON.stringify(h.calls[3].context)).toContain(handover.replaceAll("\n", "\\n"));
    expect(h.calls[3].context.messages.some((message: any) => message.role === "assistant" && message.content?.[0]?.text === "Missing prefix")).toBe(false);
    expect(h.session.getLastAssistantText()).toBe("chirp: Finished.");
    expect(h.session.sessionManager.getBranch().filter((entry: any) => entry.type === "compaction")).toHaveLength(1);
    expect(h.session.isIdle).toBe(true);
  } finally { h.cleanup(); }
}, 20000);

test("real Pi lifecycle: a missed prefix on the final message ends the turn without handover or compaction", async () => {
  const h = await realSession([assistant("chirp: Working.", "toolUse"), assistant("Done, without the prefix.")].map((message, i) =>
    i === 0 ? { ...message, content: [...message.content, toolCall] } : message));
  try {
    await h.session.prompt("Complete the original request.");
    expect(h.errors).toEqual([]);
    expect(h.calls).toHaveLength(2);
    expect(h.executions()).toBe(1);
    const branch = h.session.sessionManager.getBranch();
    expect(branch.some((entry: any) => ["canary-handover-request", "canary-recovery-failed", "canary-resume"].includes(entry.customType))).toBe(false);
    expect(branch.some((entry: any) => entry.type === "compaction")).toBe(false);
    expect(h.session.getLastAssistantText()).toBe("Done, without the prefix.");
    expect(h.session.isIdle).toBe(true);
  } finally { h.cleanup(); }
}, 20000);

test("real Pi lifecycle: abort cancels an in-flight summary without compacting or restarting", async () => {
  let started!: () => void;
  const summaryStarted = new Promise<void>((resolve) => { started = resolve; });
  const responses = [assistant(midRun(), "toolUse"), assistant(handover), (signal: AbortSignal) => {
    started();
    return new Promise((resolve) => signal.addEventListener("abort", () => resolve(assistant("", "aborted")), { once: true }));
  }];
  const h = await realSession(responses);
  try {
    const run = h.session.prompt("Complete the original request.");
    await summaryStarted;
    await h.session.abort();
    await run;
    expect(h.errors).toEqual([]);
    expect(h.calls).toHaveLength(3);
    expect(h.calls[2].signal.aborted).toBe(true);
    expect(h.session.sessionManager.getBranch().some((entry: any) => entry.type === "compaction")).toBe(false);
    expect(h.session.getLastAssistantText()).toBe(handover);
    expect(h.session.isIdle).toBe(true);
  } finally { h.cleanup(); }
}, 20000);

test("real Pi lifecycle: two blocked handover tool attempts stop without executing tools", async () => {
  const responses = [assistant(midRun(), "toolUse"), assistant([toolCall], "toolUse"), assistant([{ ...toolCall, id: "call-2" }], "toolUse")];
  const h = await realSession(responses);
  try {
    await h.session.prompt("Complete the original request.");
    expect(h.errors).toEqual([]);
    expect(h.calls).toHaveLength(3);
    expect(h.executions()).toBe(1); // Only the tool call that accompanied the missed prefix.
    expect(h.session.sessionManager.getBranch().some((entry: any) => entry.customType === "canary-recovery-failed")).toBe(true);
    expect(h.session.sessionManager.getBranch().some((entry: any) => entry.type === "compaction")).toBe(false);
    expect(h.session.isIdle).toBe(true);
  } finally { h.cleanup(); }
}, 20000);

describe("measured canary improvements", () => {
  test("real lifecycle: a deferred handover pauses without submitting another request", async () => {
    const responses = [
      assistant(midRun(), "toolUse"),
      assistant([], "deferred"), assistant([], "deferred"), assistant([], "deferred"),
      assistant(handover), assistant("The task is complete."), assistant("chirp: Finished."),
    ];
    const h = await realSession(responses);
    try {
      await h.session.prompt("Complete the original request.");
      const branch = h.session.sessionManager.getBranch();
      const metrics = {
        requests: h.calls.length,
        failures: branch.filter((entry: any) => entry.customType === "canary-recovery-failed").length,
        compactions: branch.filter((entry: any) => entry.type === "compaction").length,
        idle: h.session.isIdle,
      };
      console.log("MEASURE deferred", JSON.stringify(metrics));
      expect(h.errors).toEqual([]);
      expect(metrics).toEqual({ requests: 2, failures: 1, compactions: 0, idle: true });
    } finally { h.cleanup(); }
  }, 20000);

  for (const boundary of ["request", "failure", "compaction", "summary-error"]) {
    test(`preserves earlier boundary drafts during ${boundary}`, async () => {
      const h = harness();
      const prior = { type: "custom_message", customType: "other-extension-audit", content: "Preserve this audit record.", display: false };
      let result: any;
      if (boundary === "request") {
        await h.command("on"); await h.start();
        result = await h.reply(midRun(), "toolUse", { entries: [prior] });
      } else {
        await h.fail();
        if (boundary === "failure") {
          await h.reply("chirp: Not a handover");
          result = await h.reply("chirp: Still not a handover", "stop", { entries: [prior] });
        } else {
          if (boundary === "summary-error") h.setSummary(async () => { throw new Error("Provider unavailable"); });
          result = await h.reply(handover, "stop", { entries: [prior] });
        }
      }
      const retained = result?.entries?.includes(prior) === true;
      console.log("MEASURE boundary", JSON.stringify({ boundary, retained }));
      expect(retained).toBe(true);
      expect(h.manager.getBranch().some((entry: any) => entry.type === "custom_message" && entry.customType === prior.customType)).toBe(true);
    });
  }

  test("an earlier extension continuation cannot bypass the handover attempt budget", async () => {
    const h = harness(); await h.fail();
    let result: any;
    for (let i = 0; i < 2; i++) {
      result = await h.reply("chirp: Not a handover", "stop", { continue: true });
    }
    const metrics = { aborts: h.abortCount(), failures: h.drafts.filter((entry: any) => entry.customType === "canary-recovery-failed").length };
    console.log("MEASURE continuation", JSON.stringify(metrics));
    expect(metrics).toEqual({ aborts: 1, failures: 1 });
    expect(result.continue).toBe(false);
  });

  test("an earlier extension continuation cannot prolong recovery with valid handovers", async () => {
    const h = harness(); await h.fail();
    await h.reply(handover, "stop", { continue: true });
    const result = await h.reply(handover, "stop", { continue: true });
    expect(h.abortCount()).toBe(1);
    expect(result.entries.at(-1).content).toContain("continuation");
    expect(h.summaryCalls).toHaveLength(0);
  });

  for (const codePoint of [0x85, 0x2028, 0x2029]) {
    test(`rejects Unicode separator U+${codePoint.toString(16)} in settings and commands`, async () => {
      const keyword = `two${String.fromCodePoint(codePoint)}lines`;
      const h = harness({ canary: keyword });
      await h.command("on");
      const settingsAccepted = !!(await h.start()).systemPromptOptions.sections.canary;
      let commandSaved = false;
      await withKeywordHarness(async (configured) => {
        await configured.command(keyword);
        commandSaved = existsSync(configured.globalPath);
      });
      console.log("MEASURE unicode", JSON.stringify({ codePoint, settingsAccepted, commandSaved }));
      expect(settingsAccepted).toBe(false);
      expect(commandSaved).toBe(false);
    });
  }

  for (const scope of ["user", "project"]) {
    test(`updates BOM-prefixed ${scope} settings without losing unrelated fields`, async () => {
      await withKeywordHarness(async (h) => {
        const path = scope === "user" ? h.globalPath : h.projectPath;
        const before = { canary: "old", theme: "dark", retry: { enabled: false } };
        writeFileSync(path, "\uFEFF" + JSON.stringify(before));
        await h.command("NewKeyword");
        const saved = readFileSync(path, "utf8").replace(/^\uFEFF/u, "");
        const settings = JSON.parse(saved);
        console.log("MEASURE bom", JSON.stringify({ scope, updated: settings.canary === "NewKeyword", reloads: h.reloads.mock.calls.length }));
        expect(settings).toEqual({ ...before, canary: "NewKeyword" });
        expect(h.settings.canary).toBe("NewKeyword");
        expect(h.reloads).toHaveBeenCalledTimes(1);
      }, scope === "user" ? { global: { canary: "old" } } : { global: { canary: "global" }, project: { canary: "old" }, trusted: true });
    });
  }
});

describe("recovery compatibility controls", () => {
  test("deferred responses outside recovery do not trigger a handover", async () => {
    const h = harness(); await h.command("on"); await h.start();
    await h.reply([], "deferred");
    expect(await h.settle()).toBeUndefined();
    expect(h.abortCount()).toBe(0);
  });

  test("queued user input keeps priority over an exhausted recovery budget", async () => {
    const h = harness(); await h.fail();
    await h.reply("chirp: Not a handover");
    h.setPending(true);
    expect(await h.reply("chirp: Still not a handover", "stop", { continue: true })).toBeUndefined();
    expect(h.abortCount()).toBe(0);
    await h.emit("message_start", { message: { role: "user", content: "A new instruction" } });
    h.setPending(false);
    expect(await h.emit("tool_call", { toolName: "test_tool" })).toBeUndefined();
    expect(await h.settle()).toBeUndefined();
  });

  test("accepts a valid handover on the last allowed attempt", async () => {
    const h = harness(); await h.fail();
    await h.reply("chirp: Not a handover");
    const result = await h.reply(handover);
    expect(result.entries.some((entry: any) => entry.type === "compaction")).toBe(true);
    expect(h.abortCount()).toBe(0);
  });

  test("real lifecycle: earlier extension audit drafts survive the whole recovery", async () => {
    const beforeCanary = `export default function(pi) {
      let sequence = 0;
      for (const type of ["turn_end", "agent_before_settle"]) {
        pi.on(type, event => ({
          entries: [...event.entries, {
            type: "custom", customType: "earlier-extension-audit",
            data: { sequence: ++sequence, boundary: event.type }
          }]
        }));
      }
    }`;
    const h = await realSession([
      assistant(midRun(), "toolUse"), assistant(handover),
      assistant("The original task is complete."), assistant("chirp: Finished."),
    ], { beforeCanary });
    try {
      await h.session.prompt("Complete the original request.");
      const audits = h.session.sessionManager.getBranch().filter((entry: any) =>
        entry.type === "custom" && entry.customType === "earlier-extension-audit");
      const sequences = audits.map((entry: any) => entry.data.sequence);
      console.log("MEASURE real-boundary", JSON.stringify({ sequences }));
      expect(h.errors).toEqual([]);
      expect(sequences).toEqual([1, 2, 3, 4]);
      expect(h.session.isIdle).toBe(true);
    } finally { h.cleanup(); }
  }, 20000);
});
