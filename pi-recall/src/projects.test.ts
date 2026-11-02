import { describe, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionToolContext, Theme } from "@earendil-works/pi-coding-agent";
import { marksSection } from "./marks/reader.ts";
import { MarkStore } from "./marks/store.ts";
import { createMarkTool } from "./marks/tool.ts";
import { matchProjects, type Project, projectIndex, projectName, readRecallrc, RECALLRC, resolveScope } from "./projects.ts";
import { recall } from "./recall.ts";
import { search } from "./search.ts";
import { recallSessions } from "./sessions-tool.ts";
import { context, workspace } from "./testing.ts";

const at = (...paths: string[]): Project[] => paths.map((path) => ({ path, sessionDir: "" }));

describe("naming projects", () => {
  const projects = at("/w/pi-extensions/pi-memory", "/w/tools/pi-memory-old", "/b/nixos", "/c/nixos", join(homedir(), "notes"));
  const paths = (name: string, base = "/") => matchProjects(name, projects, base).map((p) => p.path);

  test("by the last folders of the path, whole folder names only", () => {
    expect(paths("pi-memory")).toEqual(["/w/pi-extensions/pi-memory"]);
    expect(paths("pi-extensions/pi-memory/")).toEqual(["/w/pi-extensions/pi-memory"]);
    expect(paths("memory")).toEqual([]);
    expect(paths("nixos")).toEqual(["/b/nixos", "/c/nixos"]);
    expect(paths("c/nixos")).toEqual(["/c/nixos"]);
  });

  test("by a path, absolute, from home or relative to the project", () => {
    expect(paths("/b/nixos")).toEqual(["/b/nixos"]);
    expect(paths("/b")).toEqual([]);
    expect(paths("~/notes")).toEqual([join(homedir(), "notes")]);
    expect(paths("../nixos", "/c/app")).toEqual(["/c/nixos"]);
  });

  test("shortest end of the path that is unique", () => {
    expect(projects.map((p) => projectName(p, projects))).toEqual(["pi-memory", "pi-memory-old", "b/nixos", "c/nixos", "notes"]);
  });

  test(".recallrc lists one project per line, with # comments", async () => {
    const ws = await workspace();
    const p = await ws.project("app");
    expect(await readRecallrc(p.cwd)).toEqual([]);
    await writeFile(join(p.cwd, RECALLRC), "# old names\npi-memory  # before the rename\n\n  ~/notes\n");
    expect(await readRecallrc(p.cwd)).toEqual(["pi-memory", "~/notes"]);
  });
});

for (const shared of [false, true]) {
  describe(shared ? "one session folder for every project" : "a session folder per project", () => {
    /** A project renamed from pi-memory to pi-recall, an unrelated one, and an empty current session. */
    async function setup() {
      const ws = await workspace({ shared });
      const old = await ws.project("ext/pi-memory");
      const other = await ws.project("other");
      const now = await ws.project("ext/pi-recall");
      const oldSession = old.session(["chose the sidecar store"]);
      other.session(["unrelated sidecar"]);
      const before = now.session(["after the rename"]);
      const current = now.session();
      await rm(old.cwd, { recursive: true });
      return { old, other, now, oldSession, before, current, ctx: context(current) };
    }
    const projectsOf = (sessions: { project?: string }[]) => sessions.map((s) => s.project ?? "here");

    test("finds every project with sessions, including folders that are gone", async () => {
      const { old, other, now, oldSession, current } = await setup();
      const index = await projectIndex(current);
      expect(index.projects.map((p) => p.path).sort()).toEqual([old.cwd, now.cwd, other.cwd].sort());
      expect(index.sessions.get(oldSession.getSessionId())?.path).toBe(old.cwd);
      expect(index.sessions.get(current.getSessionId())).toBe(index.current);
    });

    test("reads this project by default, and the projects .recallrc lists with it", async () => {
      const { old, now, current, ctx } = await setup();
      expect((await resolveScope(current)).projects.map((p) => p.path)).toEqual([now.cwd]);
      expect(projectsOf((await recallSessions(ctx)).sessions)).toEqual(["here", "here"]);

      await writeFile(join(now.cwd, RECALLRC), "pi-memory\n");
      const sessions = (await recallSessions(ctx)).sessions;
      expect(projectsOf(sessions)).toEqual(["here", "here", old.cwd]);
      const read = await recall(ctx);
      expect(read.sessions).toMatchObject([
        { project: old.cwd, entries: [{ text: "chose the sidecar store" }] },
        { project: undefined, entries: [{ text: "after the rename" }] },
      ]);
      const hits = (await search(ctx, { query: "sidecar" })).hits;
      expect(hits.map((h) => h.project)).toEqual([old.cwd]);
    });

    test("reads another project, or all of them, when asked", async () => {
      const { old, other, oldSession, ctx } = await setup();
      const read = await recall(ctx, { project: "pi-memory" });
      expect(read.sessions.map((s) => s.sessionId)).toEqual([oldSession.getSessionId()]);
      expect(read.sessions[0]!.project).toBe(old.cwd);
      const hits = (await search(ctx, { query: "sidecar", project: "all" })).hits;
      expect(hits.map((h) => h.project).sort()).toEqual([old.cwd, other.cwd].sort());
      expect((await recallSessions(ctx, { project: "all" })).sessions).toHaveLength(4);
      await expect(recall(ctx, { project: "pi" })).rejects.toThrow('No project matches "pi". Pass a path');
      await expect(recall(ctx, { project: "ext" })).rejects.toThrow("Projects whose path contains it");
    });

    test("follows a session id or cursor into its project", async () => {
      const { oldSession, ctx } = await setup();
      const sid = oldSession.getSessionId();
      const ref = `${sid}/${oldSession.getLeafId()}`;
      expect((await recall(ctx, { sessionId: sid })).sessions.map((s) => s.sessionId)).toEqual([sid]);
      expect((await recall(ctx, { from: ref })).sessions[0]!.entries).toMatchObject([{ text: "chose the sidecar store" }]);
      expect((await search(ctx, { query: "sidecar", sessionId: sid })).hits.map((h) => h.ref)).toEqual([ref]);
      await expect(recall(ctx, { sessionId: "missing" })).rejects.toThrow("Session missing not found");
    });

    test("keeps a mark with the project of the message, and reads it where that project is recalled", async () => {
      const { old, now, oldSession, current } = await setup();
      const ref = `${oldSession.getSessionId()}/${oldSession.getLeafId()}`;
      const theme = { fg: (_: string, text: string) => text } as unknown as Theme;
      const ctx = { sessionManager: current, ui: { theme, setStatus() {}, notify() {} }, isIdle: () => false } as unknown as ExtensionToolContext;
      await createMarkTool().execute("t", { target: ref, reason: "Chose the store" }, undefined, undefined, ctx);

      const store = MarkStore.forDir(old.sessionDir);
      expect((await store.events()).map((e) => e.ref)).toEqual([ref]);
      if (!shared) expect(await MarkStore.forSession(current).events()).toEqual([]);

      expect(await marksSection(current)).toBeUndefined();
      await writeFile(join(now.cwd, RECALLRC), "pi-memory\n");
      expect(await marksSection(current)).toContain(`project="${old.cwd}"`);
      expect((await recall(ctx)).sessions[0]!.entries[0]).toMatchObject({ mark: { by: "agent", reason: "Chose the store" } });
    });
  });
}

test("a session the index cannot place is not found", async () => {
  const ws = await workspace();
  const p = await ws.project("app");
  const current = p.session();
  await expect(recall(context(current), { from: "nope/x" })).rejects.toThrow("Session nope not found");
});
