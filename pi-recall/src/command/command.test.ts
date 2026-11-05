import { describe, expect, test } from "bun:test";
import type { ExtensionContext, InputEvent, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager as TuiKeybindings, type MarkdownTheme, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import type { RecalledEntry } from "../entries.ts";
import type { MarkState } from "../marks/store.ts";
import { context, listProjectSessions, project } from "../testing.ts";
import { Attachments, itemKey, MAX_ATTACHED_CHARS, type RecallItem, recalledSection } from "./attach.ts";
import { completions, findEntries, parseArgs, resolveSession } from "./command.ts";
import type { MarkControls } from "./marks.ts";
import { entryMarkdown, RecallScreen, type RecallScreenOptions } from "./ui.ts";

const KEY = { up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D", space: " ", enter: "\r", escape: "\x1b" };

const usage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function item(id: string, text: string, sessionId = "s1", timestamp = "2026-11-02T10:00:00.000Z"): RecallItem {
  return {
    sessionId,
    entry: { type: "message", id, parentId: null, timestamp, message: { role: "user", content: text, timestamp: 0 } },
    notes: {},
  };
}

function fakeUi() {
  const calls = { widget: undefined as string[] | undefined, notices: [] as string[] };
  const ui = {
    theme: { fg: (_: string, text: string) => text },
    setWidget: (_key: string, lines: string[] | undefined) => { calls.widget = lines; },
    notify: (message: string) => { calls.notices.push(message); },
  } as unknown as ExtensionContext["ui"];
  return { ui, calls };
}

describe("parseArgs", () => {
  test("reads list, session, marks and show forms", () => {
    expect(parseArgs("")).toEqual({ kind: "list" });
    expect(parseArgs("  01a19c0e ")).toEqual({ kind: "session", sessionId: "01a19c0e" });
    expect(parseArgs("show s1/abc")).toEqual({ kind: "show", entryId: "s1/abc" });
    expect(parseArgs("marks")).toEqual({ kind: "marks" });
    expect(() => parseArgs("show")).toThrow("Usage");
    expect(() => parseArgs("a b")).toThrow("Usage");
  });
});

describe("finding sessions and entries", () => {
  test("resolves a session by id or unique prefix", async () => {
    const p = await project();
    p.session(["one"]);
    const sources = await listProjectSessions(p.session());
    const id = sources[1]!.summary.sessionId;
    expect(resolveSession(sources, id)).toBe(sources[1]!);
    expect(() => resolveSession(sources, "zzz")).toThrow("No session zzz");
    // Session ids share a time-based prefix, so a short one can match both.
    const common = id.slice(0, 1);
    if (sources[0]!.summary.sessionId.startsWith(common)) expect(() => resolveSession(sources, common)).toThrow("ambiguous");
  });

  test("finds an entry by id across sessions, including entries in context", async () => {
    const p = await project();
    const prev = p.session(["old"]);
    const current = p.session(["now"]);
    const sources = await listProjectSessions(current);
    const prevId = prev.getLeafId()!;
    expect((await findEntries(sources, prevId)).map((i) => i.sessionId)).toEqual([prev.getSessionId()]);
    expect(await findEntries(sources, `${current.getSessionId()}/${current.getLeafId()}`)).toHaveLength(1);
    await expect(findEntries(sources, "nope")).rejects.toThrow("No entry nope");
  });

  test("completes marks, show and session ids", async () => {
    const p = await project();
    const prev = p.session(["first question"]);
    const current = p.session();
    const items = (await completions(context(current), ""))!;
    expect(items.slice(0, 4).map((i) => i.label)).toEqual(["marks", "projects", "all", "show"]);
    expect(items.find((i) => i.value === prev.getSessionId())!.description).toBe("first question");
    expect(await completions(context(current), "show x")).toBeNull();
  });
});

describe("recalledSection", () => {
  test("wraps entries with their ids and leaves out thinking", () => {
    const assistant: RecallItem = {
      sessionId: "s1",
      notes: { label: "key" },
      entry: {
        type: "message", id: "a1", parentId: null, timestamp: "2026-11-02T10:00:00.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "secret" },
            { type: "text", text: "Done" },
            { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } },
          ],
          api: "test", provider: "test", model: "test", usage, stopReason: "stop", timestamp: 0,
        },
      },
    };
    expect(recalledSection([assistant])).toBe(
      '<recalled_messages source="user_selected">\n' +
      '<message session_id="s1" message_id="a1" role="assistant" timestamp="2026-11-02T10:00:00.000Z" label="key">\n' +
      'Done\n[tool call] bash {"command":"ls"}\n' +
      "</message>\n</recalled_messages>",
    );
  });

  test("names summaries by type and truncates long entries with a pointer to recall_messages", () => {
    const summary = { type: "compaction", id: "c1", parentId: null, timestamp: "t", summary: "Sum", firstKeptEntryId: "x", tokensBefore: 1 } as RecalledEntry;
    expect(recalledSection([{ sessionId: "s1", entry: summary, notes: {} }])).toContain('type="compaction"');
    const long = recalledSection([item("m1", "x".repeat(MAX_ATTACHED_CHARS + 10))]);
    expect(long).toContain(`[Shortened from ${MAX_ATTACHED_CHARS + 10} characters.`);
    expect(long).toContain("chars omitted");
    expect(long).toContain('from "s1/m1"');
  });
});

describe("Attachments", () => {
  const input = (text: string, source: InputEvent["source"] = "interactive"): InputEvent => ({ type: "input", text, source });

  test("adds the section before the next message once, oldest first, and clears the widget", () => {
    const { ui, calls } = fakeUi();
    const attachments = new Attachments();
    attachments.set(ui, [item("m2", "later", "s1", "2026-11-02T11:00:00Z"), item("m1", "earlier", "s1", "2026-11-02T10:00:00Z")]);
    expect(calls.widget![0]).toContain("2 recalled messages");

    const result = attachments.handleInput(input("my question"), { ui } as ExtensionContext);
    expect(result.action).toBe("transform");
    const text = (result as { text: string }).text;
    expect(text.indexOf("earlier")).toBeLessThan(text.indexOf("later"));
    expect(text.endsWith("</recalled_messages>\n\nmy question")).toBe(true);
    expect(calls.widget).toBeUndefined();
    expect(attachments.handleInput(input("next"), { ui } as ExtensionContext)).toEqual({ action: "continue" });
  });

  test("keeps attachments for messages starting with / and ignores extension input", () => {
    const { ui, calls } = fakeUi();
    const attachments = new Attachments();
    attachments.set(ui, [item("m1", "hi")]);
    expect(attachments.handleInput(input("/skill:x go"), { ui } as ExtensionContext)).toEqual({ action: "continue" });
    expect(calls.notices).toHaveLength(1);
    expect(attachments.handleInput(input("auto", "extension"), { ui } as ExtensionContext)).toEqual({ action: "continue" });
    expect(attachments.selected).toHaveLength(1);
  });
});

describe("RecallScreen", () => {
  const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
  const identity = (text: string) => text;
  const markdownTheme: MarkdownTheme = {
    heading: identity, link: identity, linkUrl: identity, code: identity, codeBlock: identity,
    codeBlockBorder: identity, quote: identity, quoteBorder: identity, hr: identity, listBullet: identity,
    bold: identity, italic: identity, strikethrough: identity, underline: identity,
  };

  function screen(options: Partial<RecallScreenOptions> = {}) {
    const result: { value?: RecallItem[] | undefined; done: boolean } = { done: false };
    const s = new RecallScreen({
      tui: { terminal: { rows: 20 }, requestRender() {} },
      theme,
      keybindings: new TuiKeybindings(TUI_KEYBINDINGS) as unknown as KeybindingsManager,
      markdownTheme,
      title: "Recall",
      sessionLabels: new Map([["s1", "first session"], ["s2", "second session"]]),
      selected: [],
      done: (value) => Object.assign(result, { value, done: true }),
      ...options,
    });
    return { s, result, text: () => s.render(100).join("\n") };
  }

  const pages = (...pageList: RecallItem[][]) => {
    let n = 0;
    return async () => ({ items: pageList[n++] ?? [], more: n < pageList.length });
  };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  test("lists entries by session with the cursor on the newest, and loads older pages moving up", async () => {
    const older = [item("o1", "oldest", "s1")];
    const newer = [item("n1", "middle", "s1"), item("n2", "newest", "s2")];
    const { s, text } = screen({ loadOlder: pages(newer, older) });
    await tick();
    expect(text()).toContain("── s1 · \"first session\"");
    expect(text()).toContain("── s2 · \"second session\"");
    expect(text()).toMatch(/› .*n2 {2}user/);
    expect(text()).not.toContain("oldest");

    s.handleInput(KEY.up);
    await tick();
    expect(text()).toContain("oldest");
    expect(text()).toMatch(/› .*n1 {2}user/);
  });

  test("selects with space, views with right, returns with left, and attaches on enter", async () => {
    const { s, result, text } = screen({ loadOlder: pages([item("m1", "first"), item("m2", "second **bold**")]) });
    await tick();
    s.handleInput(KEY.space);
    expect(text()).toContain("1 selected");
    s.handleInput(KEY.up);
    s.handleInput(KEY.right);
    expect(text()).toContain("message m1");
    s.handleInput(KEY.space);
    expect(text()).toContain("2 selected");
    s.handleInput(KEY.left);
    expect(text()).toMatch(/›.*m1/);
    s.handleInput(KEY.enter);
    expect(result.value!.map((i) => i.entry.id).sort()).toEqual(["m1", "m2"]);
  });

  test("starts with existing attachments selected, and escape cancels", async () => {
    const attached = item("m1", "first");
    const { s, result, text } = screen({ loadOlder: pages([item("m1", "first")]), selected: [attached] });
    await tick();
    expect(text()).toContain("1 selected");
    s.handleInput(KEY.escape);
    expect(result).toEqual({ done: true, value: undefined });
  });

  test("shows one entry alone, scrolling, without selection", () => {
    const long = item("m1", Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n\n"));
    const { s, result, text } = screen({ single: long });
    expect(text()).toContain("line 0");
    expect(text()).toContain("escape close");
    s.handleInput("\x1b[6~"); // pageDown
    expect(text()).not.toContain("line 0\n");
    s.handleInput(KEY.space);
    s.handleInput(KEY.left);
    expect(text()).not.toContain("selected");
    s.handleInput(KEY.enter);
    expect(result).toEqual({ done: true, value: undefined });
  });

  /** Mark controls over an in-memory map, failing for entries whose id starts with "t". */
  function fakeMarks(initial: Record<string, Partial<MarkState>> = {}): MarkControls & { states: Map<string, MarkState> } {
    const states = new Map<string, MarkState>(Object.entries(initial).map(([ref, state]) => [ref, {
      ref, sessionId: "s1", entryId: ref.slice(3), marked: true, by: "agent", at: "t", reviewed: false, ...state,
    }]));
    return {
      states,
      get: (item) => states.get(itemKey(item)),
      async toggle(item) {
        if (item.entry.id.startsWith("t")) throw new Error("Only messages can be marked");
        const ref = itemKey(item);
        const marked = !states.get(ref)?.marked;
        states.set(ref, { ref, sessionId: item.sessionId, entryId: item.entry.id, marked, by: "user", at: "t", reviewed: true });
      },
      async review(item) {
        const state = states.get(itemKey(item));
        if (state) state.reviewed = true;
      },
    };
  }

  test("marks critical with p, reviews with r, and shows each state as a badge", async () => {
    const marks = fakeMarks({ "s1/m2": { reason: "User chose X" } });
    const { s, text } = screen({ loadOlder: pages([item("m1", "plain"), item("m2", "agent marked")]), marks });
    await tick();
    expect(text()).toContain("p critical · r reviewed");
    expect(text()).toMatch(/› ◆ .*m2/);

    s.handleInput(KEY.right);
    expect(text()).toContain("◆ critical by agent, unreviewed: User chose X");
    s.handleInput("r");
    await tick();
    expect(text()).toContain("◆ critical by agent: User chose X");
    s.handleInput(KEY.left);

    s.handleInput(KEY.up);
    s.handleInput("p");
    await tick();
    expect(marks.states.get("s1/m1")).toMatchObject({ marked: true, by: "user" });
    expect(text()).toMatch(/› ◆ .*m1/);
    s.handleInput("p");
    await tick();
    expect(text()).toMatch(/› {3}.*m1/);
  });

  test("shows an unmark by the agent until reviewed, and why a mark failed in place of the hints", async () => {
    const marks = fakeMarks({ "s1/m1": { marked: false } });
    const { s, text } = screen({ loadOlder: pages([item("m1", "was critical"), item("t1", "tool entry")]), marks });
    await tick();
    s.handleInput("p");
    await tick();
    expect(text()).toContain("Only messages can be marked");
    expect(text()).not.toContain("p critical");
    s.handleInput(KEY.up);
    expect(text()).toContain("p critical");
    expect(text()).toMatch(/› ◇ .*m1/);
    s.handleInput("r");
    await tick();
    expect(text()).toMatch(/› {3}.*m1/);
  });

  test("renders tool calls and results as code", () => {
    expect(entryMarkdown({
      type: "message", id: "r", parentId: null, timestamp: "t",
      message: { role: "toolResult", toolCallId: "c", toolName: "bash", isError: true, content: [{ type: "text", text: "a ``` b" }], timestamp: 0 },
    })).toBe("**bash** (error)\n````\na ``` b\n````");
  });
});
