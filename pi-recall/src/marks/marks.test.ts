import { describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonObject } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionToolContext, SessionManager, type Theme } from "@earendil-works/pi-coding-agent";
import { entryClip } from "../format.ts";
import { markControls, markItems } from "../command/marks.ts";
import { recall } from "../recall.ts";
import { search } from "../search.ts";
import { projectIndex, resolveScope } from "../projects.ts";
import { context, listProjectSessions, project } from "../testing.ts";
import { TREE_LABEL, TreeLabels } from "./labels.ts";
import { MARKS_MESSAGE_TYPE, marksSection, registerMarksReader } from "./reader.ts";
import { fold, markLookup, type MarkEvent, MarkStore, unreviewed } from "./store.ts";
import { resolveTarget } from "./target.ts";
import { createMarkTool, DEFAULT_GUIDANCE, GUIDANCE_MAX, loadGuidance } from "./tool.ts";

const usage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
let clock = Date.UTC(2026, 10, 5);

function assistant(sm: SessionManager, text: string, calls: { id: string; name: string; args: JsonObject }[] = []) {
  return sm.appendMessage({
    role: "assistant",
    content: [
      ...(text ? [{ type: "text" as const, text }] : []),
      ...calls.map((c) => ({ type: "toolCall" as const, id: c.id, name: c.name, arguments: c.args })),
    ],
    api: "test", provider: "test", model: "test", usage, stopReason: calls.length > 0 ? "toolUse" : "stop", timestamp: (clock += 1000),
  });
}

const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;

/** A tool context whose footer status and notices are recorded. */
function toolContext(sm: SessionManager, idle = false) {
  const calls = { status: undefined as string | undefined, notices: [] as string[] };
  const ui = {
    theme,
    setStatus: (_key: string, text: string | undefined) => { calls.status = text; },
    notify: (message: string) => { calls.notices.push(message); },
  };
  return { ctx: { sessionManager: sm, ui, isIdle: () => idle } as unknown as ExtensionToolContext, calls };
}

const event = (op: MarkEvent["op"], ref: string, by: MarkEvent["by"], at: string, reason?: string): MarkEvent =>
  ({ v: 1, op, ref, by, at, session: "s", ...(reason ? { reason } : {}) });

describe("marks log", () => {
  test("the latest mark or unmark decides; the user's own actions and reviews count as seen", () => {
    const states = fold([
      event("mark", "s1/a", "agent", "1", "decided A"),
      event("mark", "s1/b", "agent", "2"),
      event("review", "s1/b", "user", "3"),
      event("mark", "s1/c", "user", "4"),
      event("unmark", "s1/c", "agent", "5", "reversed"),
      event("review", "s1/zzz", "user", "6"),
    ]);
    expect(states.get("s1/a")).toEqual({ ref: "s1/a", sessionId: "s1", entryId: "a", marked: true, by: "agent", at: "1", reason: "decided A", reviewed: false });
    expect(states.get("s1/b")).toMatchObject({ marked: true, reviewed: true });
    expect(states.get("s1/c")).toMatchObject({ marked: false, by: "agent", reason: "reversed", reviewed: false });
    expect(states.has("s1/zzz")).toBe(false);
    expect(unreviewed(states).map((s) => s.ref)).toEqual(["s1/a", "s1/c"]);
  });

  test("appends one line per event and skips lines that do not parse", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-recall-marks-"));
    const store = new MarkStore(join(dir, "nested", "marks.jsonl"));
    expect(await store.events()).toEqual([]);
    await store.append({ op: "mark", ref: "s1/a", by: "agent", reason: "why", session: "s1" });
    await appendFile(store.path, "not json\n{\"op\":\"bogus\"}\n");
    await store.append({ op: "unmark", ref: "s1/a", by: "user", session: "s2" });
    const events = await store.events();
    expect(events.map((e) => [e.op, e.by, e.reason])).toEqual([["mark", "agent", "why"], ["unmark", "user", undefined]]);
    expect(events[0]).toMatchObject({ v: 1, ref: "s1/a", session: "s1", at: expect.any(String) });
    expect((await store.states()).get("s1/a")!.marked).toBe(false);
  });

  test("lives beside the project's sessions, where pi does not list it", async () => {
    const p = await project();
    const current = p.session(["one"]);
    expect(MarkStore.forSession(current).path).toBe(join(p.sessionDir, "pi-recall", "marks.jsonl"));
    await MarkStore.forSession(current).append({ op: "mark", ref: `${current.getSessionId()}/x`, by: "user", session: "s" });
    expect((await SessionManager.list(p.cwd, p.sessionDir)).map((s) => s.id)).toEqual([current.getSessionId()]);
  });

  test("a forked session shows the marks made in the session it was forked from", async () => {
    const p = await project();
    const original = p.session(["decide x"]);
    const entryId = original.getLeafId()!;
    const fork = SessionManager.forkFrom(original.getSessionFile()!, p.cwd, p.sessionDir);
    const states = fold([event("mark", `${original.getSessionId()}/${entryId}`, "user", "1")]);
    const lookup = markLookup(states, await listProjectSessions(p.session()));
    expect(lookup(fork.getSessionId(), entryId)?.ref).toBe(`${original.getSessionId()}/${entryId}`);
    expect(lookup(fork.getSessionId(), "other")).toBeUndefined();
  });
});

describe("targets", () => {
  test("resolve the latest user message, the reply before it, refs and ids, and tool entries to their message", async () => {
    const p = await project();
    const prev = p.session(["old question"]);
    const oldId = prev.getLeafId()!;
    const current = p.session(["first"]);
    const proposal = assistant(current, "I propose a sidecar store.");
    const call = assistant(current, "", [{ id: "c1", name: "bash", args: { command: "ls" } }]);
    const latest = p.user(current, "yes, do that");
    const index = await projectIndex(current);
    const id = async (target: string) => {
      const t = await resolveTarget(current, index, target);
      return `${t.sessionId}/${t.entry.id}`;
    };
    const sid = current.getSessionId();

    expect(await id("last_user")).toBe(`${sid}/${latest}`);
    expect(await id("previous_reply")).toBe(`${sid}/${proposal}`);
    expect(await id(`${prev.getSessionId()}/${oldId}`)).toBe(`${prev.getSessionId()}/${oldId}`);
    expect(await id(proposal)).toBe(`${sid}/${proposal}`);
    expect(await id(call)).toBe(`${sid}/${proposal}`);
    await expect(id("missing/x")).rejects.toThrow("Session missing not found");
    await expect(id("nope")).rejects.toThrow("Entry nope not found");
  });

  test("explain when there is no user message or reply yet", async () => {
    const p = await project();
    const empty = p.session();
    await expect(resolveTarget(empty, await projectIndex(empty), "last_user")).rejects.toThrow("No user message");
    const first = p.session(["hi"]);
    await expect(resolveTarget(first, await projectIndex(first), "previous_reply")).rejects.toThrow("No reply");
  });
});

describe("recall_mark", () => {
  test("marks as the agent, counts it unreviewed in the footer, and shows it in recall_messages", async () => {
    const p = await project();
    const prev = p.session(["use a sidecar store"]);
    const ref = `${prev.getSessionId()}/${prev.getLeafId()}`;
    const current = p.session(["go"]);
    const { ctx, calls } = toolContext(current);
    const tool = createMarkTool();

    const result = await tool.execute("t", { target: ref, reason: "User chose the sidecar store" }, undefined, undefined, ctx);
    expect(result.structuredContent).toEqual({ ref, marked: true, reason: "User chose the sidecar store", message: "use a sidecar store", unreviewed: 1 });
    expect(result.details).toEqual({ ref, action: "mark", reason: "User chose the sidecar store", message: "use a sidecar store" });
    expect(calls.status).toBe("◆ 1 unreviewed mark · /recall marks");
    expect((await MarkStore.forSession(current).events())[0]).toMatchObject({ op: "mark", ref, by: "agent", session: current.getSessionId() });

    const recalled = await recall(context(current));
    expect(recalled.sessions[0]!.entries[0]).toMatchObject({
      text: "use a sidecar store", mark: { by: "agent", reviewed: false, reason: "User chose the sidecar store" },
    });
  });

  test("unmarks where the mark was made, and refuses to unmark what is not marked", async () => {
    const p = await project();
    const original = p.session(["decide x"]);
    const entryId = original.getLeafId()!;
    const fork = SessionManager.forkFrom(original.getSessionFile()!, p.cwd, p.sessionDir);
    const { ctx, calls } = toolContext(fork);
    const tool = createMarkTool();
    await expect(tool.execute("t", { target: entryId, action: "unmark", reason: "r" }, undefined, undefined, ctx)).rejects.toThrow("is not marked");

    await MarkStore.forSession(fork).append({ op: "mark", ref: `${original.getSessionId()}/${entryId}`, by: "user", session: "s" });
    const result = await tool.execute("t", { target: entryId, action: "unmark", reason: "reversed" }, undefined, undefined, ctx);
    expect(result.structuredContent).toMatchObject({ ref: `${original.getSessionId()}/${entryId}`, marked: false });
    expect(calls.status).toBe("◆ 1 unreviewed mark · /recall marks");
  });

  test("takes its guidance from the guidance file, capped, or the default", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-recall-guidance-"));
    const file = join(dir, "recall_mark.md");
    expect(loadGuidance(file)).toBe(DEFAULT_GUIDANCE);
    await writeFile(file, "  Mark only decisions.  \n");
    expect(loadGuidance(file)).toBe("Mark only decisions.");
    await writeFile(file, "x".repeat(GUIDANCE_MAX + 50));
    expect(loadGuidance(file)).toHaveLength(GUIDANCE_MAX);
    expect(createMarkTool("Mark only decisions.").description.endsWith("Mark only decisions.")).toBe(true);
    expect(createMarkTool().description.endsWith(DEFAULT_GUIDANCE)).toBe(true);
  });

  test("shows each call and its result on one line", () => {
    const tool = createMarkTool();
    const context = {} as Parameters<NonNullable<typeof tool.renderCall>>[2];
    expect(tool.renderCall!({ target: "last_user", reason: "r" }, theme, context).render(200).join("").trim())
      .toBe("recall_mark mark last_user");
    const details = { ref: "s/a", action: "mark", reason: "User chose X", message: "use X" };
    const done = tool.renderResult!({ content: [], details } as never, { isPartial: false, expanded: false }, theme, context);
    expect(done.render(200).join("").trim()).toBe('◆ marked critical "use X" — User chose X');
    const failed = tool.renderResult!({ content: [{ type: "text", text: "s/a is not marked" }] } as never, { isPartial: false, expanded: false }, theme, context);
    expect(failed.render(200).join("").trim()).toBe("s/a is not marked");
  });
});

describe("bringing marks back", () => {
  test("lists the newest marked messages with reason and author, skipping unmarked, missing and in-context ones", async () => {
    const p = await project();
    const prev = p.session(["first decision", "second decision", "unmarked later"]);
    const [first, second, third] = prev.getBranch().map((e) => e.id);
    const current = p.session(["in context now"]);
    const store = MarkStore.forSession(current);
    const ref = (id: string) => `${prev.getSessionId()}/${id}`;
    await store.append({ op: "mark", ref: ref(first!), by: "user", session: "s", at: "2026-11-05T01:00:00Z" });
    await store.append({ op: "mark", ref: ref(second!), by: "agent", reason: "Chose B", session: "s", at: "2026-11-05T02:00:00Z" });
    await store.append({ op: "mark", ref: ref(third!), by: "agent", session: "s", at: "2026-11-05T03:00:00Z" });
    await store.append({ op: "unmark", ref: ref(third!), by: "agent", session: "s", at: "2026-11-05T04:00:00Z" });
    await store.append({ op: "mark", ref: `${prev.getSessionId()}/gone`, by: "user", session: "s", at: "2026-11-05T05:00:00Z" });
    await store.append({ op: "mark", ref: `${current.getSessionId()}/${current.getLeafId()}`, by: "user", session: "s", at: "2026-11-05T06:00:00Z" });

    const text = (await marksSection(current))!;
    expect(text.startsWith("<critical_marks>\n")).toBe(true);
    expect(text.indexOf("second decision")).toBeLessThan(text.indexOf("first decision"));
    expect(text).toContain(`<mark ref="${ref(second!)}" role="user" timestamp=`);
    expect(text).toContain('marked_by="agent" reviewed="false">\nReason: Chose B\nsecond decision\n</mark>');
    expect(text).toContain('marked_by="user" reviewed="true">\nfirst decision\n</mark>');
    expect(text).not.toContain("unmarked later");
    expect(text).not.toContain("in context now");
    expect((await marksSection(current, 1))!).not.toContain("first decision");
  });

  test("returns nothing when no messages are marked", async () => {
    const p = await project();
    expect(await marksSection(p.session(["hi"]))).toBeUndefined();
  });

  test("injects before the first prompt after session start and after compaction, unless the same block is in context", async () => {
    const p = await project();
    const prev = p.session(["decision"]);
    const current = p.session(["now"]);
    await MarkStore.forSession(current).append({ op: "mark", ref: `${prev.getSessionId()}/${prev.getLeafId()}`, by: "user", session: "s" });
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    registerMarksReader({ on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, handler) } as unknown as ExtensionAPI);
    const { ctx } = toolContext(current);
    const prompt = () => handlers.get("before_agent_start")!({ type: "before_agent_start" }, ctx) as Promise<{ message: { customType: string; content: string; display: boolean } } | undefined>;

    expect(await prompt()).toBeUndefined();
    handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);
    const injected = (await prompt())!;
    expect(injected.message).toMatchObject({ customType: MARKS_MESSAGE_TYPE, display: true });
    expect(injected.message.content).toContain("decision");
    expect(await prompt()).toBeUndefined();

    // Pi saves the injected block; resuming with it still in context does not repeat it.
    current.appendCustomMessageEntry(MARKS_MESSAGE_TYPE, injected.message.content, true);
    handlers.get("session_start")!({ type: "session_start", reason: "resume" }, ctx);
    expect(await prompt()).toBeUndefined();

    // After compaction the block is gone from context, so it comes back.
    p.user(current, "more");
    current.appendCompaction("Summary", current.getLeafId()!, 10);
    handlers.get("session_compact")!({ type: "session_compact" }, ctx);
    expect((await prompt())?.message.content).toBe(injected.message.content);

    // The saved block only repeats marked messages, so recall and search leave it out.
    const later = p.session(["next"]);
    const recalled = (await recall(context(later), { sessionId: current.getSessionId() })).sessions[0]!.entries;
    expect(recalled.map((e) => e.type)).not.toContain("custom_message");
    expect((await search(context(later), { query: "decision" })).hits).toHaveLength(1);
  });
});

describe("marking in /recall", () => {
  test("toggles as the user, reviews the agent's marks, and lists marks for review", async () => {
    const p = await project();
    const prev = p.session(["decision", "other"]);
    assistant(prev, "", [{ id: "c1", name: "bash", args: { command: "ls" } }]);
    const [decision, other, toolOnly] = prev.getBranch();
    const current = p.session(["now"]);
    const { ctx, calls } = toolContext(current);
    const sources = await listProjectSessions(current);
    const item = (entry: typeof decision) => ({ sessionId: prev.getSessionId(), entry: entry as never, notes: {} });
    await MarkStore.forSession(current).append({ op: "mark", ref: `${prev.getSessionId()}/${other!.id}`, by: "agent", reason: "r", session: "s" });

    const scope = await resolveScope(current);
    const marks = await markControls(ctx, scope.index, sources);
    expect(marks.get(item(other))).toMatchObject({ marked: true, by: "agent", reviewed: false });
    await marks.review(item(other));
    expect(marks.get(item(other))!.reviewed).toBe(true);
    expect(calls.status).toBeUndefined();

    await marks.toggle(item(decision));
    expect(marks.get(item(decision))).toMatchObject({ marked: true, by: "user", reviewed: true });
    await expect(marks.toggle(item(toolOnly))).rejects.toThrow("Only messages can be marked");
    expect((await markItems(scope, sources)).map((i) => entryClip(i.entry))).toEqual(["other", "decision"]);

    await marks.toggle(item(decision));
    expect(marks.get(item(decision))!.marked).toBe(false);
    expect((await markItems(scope, sources))).toHaveLength(1);
  });
});

describe("labels in /tree", () => {
  /** Labels on the session's own entries, and the handlers TreeLabels registers. */
  function treeLabels(sm: SessionManager) {
    const labels = new TreeLabels((entryId, label) => sm.appendLabelChange(entryId, label));
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    labels.register({ on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, handler) } as never);
    const settle = () => handlers.get("agent_settled")!({ type: "agent_settled", aborted: false }, { sessionManager: sm });
    return { labels, settle, shutdown: () => handlers.get("session_shutdown")!({ type: "session_shutdown" }, {}) };
  }

  test("label marks on the current session once pi is idle, and never replace or clear the user's labels", async () => {
    const p = await project();
    const current = p.session(["a", "b", "c"]);
    const [a, b, c] = current.getBranch().map((e) => e.id) as [string, string, string];
    const sid = current.getSessionId();
    current.appendLabelChange(c, "mine");
    const { labels, settle } = treeLabels(current);
    let idle = false;
    const ctx = { sessionManager: current, isIdle: () => idle };

    labels.request(ctx, sid, a, true);
    labels.request(ctx, sid, c, true);
    labels.request(ctx, "another-session", b, true);
    expect(current.getLabel(a)).toBeUndefined();
    settle();
    expect(current.getLabel(a)).toBe(TREE_LABEL);
    expect(current.getLabel(c)).toBe("mine");
    expect(current.getLabel(b)).toBeUndefined();

    idle = true;
    labels.request(ctx, sid, a, false);
    expect(current.getLabel(a)).toBeUndefined();
    labels.request(ctx, sid, c, false);
    expect(current.getLabel(c)).toBe("mine");
  });

  test("drop waiting changes when the session ends or changes", async () => {
    const p = await project();
    const first = p.session(["a"]);
    const second = p.session(["b"]);
    const a = first.getLeafId()!;
    const { labels, settle, shutdown } = treeLabels(first);
    labels.request({ sessionManager: first, isIdle: () => false }, first.getSessionId(), a, true);
    shutdown();
    settle();
    expect(first.getLabel(a)).toBeUndefined();

    labels.request({ sessionManager: first, isIdle: () => false }, first.getSessionId(), a, true);
    labels.flush(second);
    labels.flush(first);
    expect(first.getLabel(a)).toBeUndefined();
  });

  test("the agent's marks show once it settles, and marks made in /recall at once", async () => {
    const p = await project();
    const current = p.session(["use a sidecar store"]);
    const latest = current.getLeafId()!;
    const { labels, settle } = treeLabels(current);

    const { ctx } = toolContext(current);
    await createMarkTool(DEFAULT_GUIDANCE, labels).execute("t", { target: "last_user", reason: "decided" }, undefined, undefined, ctx);
    expect(current.getLabel(latest)).toBeUndefined();
    settle();
    expect(current.getLabel(latest)).toBe(TREE_LABEL);

    const idle = toolContext(current, true).ctx;
    const marks = await markControls(idle, await projectIndex(current), await listProjectSessions(current), labels);
    const item = { sessionId: current.getSessionId(), entry: current.getEntry(latest) as never, notes: {} };
    await marks.toggle(item);
    expect(current.getLabel(latest)).toBeUndefined();
    await marks.toggle(item);
    expect(current.getLabel(latest)).toBe(TREE_LABEL);
  });
});
