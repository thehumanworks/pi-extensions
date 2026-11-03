import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type ExtensionToolContext, getAgentDir, type Theme } from "@earendil-works/pi-coding-agent";
import { marksSection } from "./marks/reader.ts";
import { MarkStore } from "./marks/store.ts";
import { createMarkTool } from "./marks/tool.ts";
import { matchProjects, type Project, projectIndex, projectName, readRecallConfig, resolveScope } from "./projects.ts";
import { recall } from "./recall.ts";
import { search } from "./search.ts";
import { recallSessions } from "./sessions-tool.ts";
import { context, workspace } from "./testing.ts";

const at = (...paths: string[]): Project[] => paths.map((path) => ({ path, sessionDir: "" }));

async function writeSettings(file: string, settings: unknown) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, typeof settings === "string" ? settings : JSON.stringify(settings));
}
/** Sets recallConfig in the project's own pi settings. */
const projectSettings = (cwd: string, recallConfig: unknown) => writeSettings(join(cwd, ".pi", "settings.json"), { recallConfig });

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

});

describe("recallConfig in pi's settings", () => {
  async function setup() {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-recall-agent-"));
    const current = at((await (await workspace()).project("ext/app")).cwd)[0]!;
    const read = (trusted = true) => readRecallConfig(current, trusted, agentDir);
    const global = (settings: unknown) => writeSettings(join(agentDir, "settings.json"), settings);
    return { current, read, global };
  }

  test("the global settings map projects, by path or last folders, to the projects they recall", async () => {
    const { current, read, global } = await setup();
    expect(await read()).toEqual([]);
    await global({ theme: "dark" });
    expect(await read()).toEqual([]);
    await global({
      recallConfig: {
        [current.path]: ["app", "app-old"],
        "ext/app": ["~/notes"],
        "other/app": ["unrelated"],
        "/elsewhere/app": ["unrelated"],
      },
    });
    expect(await read()).toEqual(["app", "app-old", "~/notes"]);
  });

  test("the project's settings list the projects it recalls, added to the global ones, if pi trusts the project", async () => {
    const { current, read, global } = await setup();
    await global({ recallConfig: { app: ["app-old"] } });
    await projectSettings(current.path, ["../app-older"]);
    expect(await read()).toEqual(["app-old", "../app-older"]);
    expect(await read(false)).toEqual(["app-old"]);
    await projectSettings(current.path, { ".": ["app-oldest"] });
    expect(await read()).toEqual(["app-old", "app-oldest"]);
  });

  test("a setting of the wrong shape, or settings that are not JSON, are errors naming the file", async () => {
    const { current, read, global } = await setup();
    const file = join(current.path, ".pi", "settings.json");
    for (const config of ["app-old", { app: "app-old" }, { app: [1] }, [["app-old"]], null]) {
      await projectSettings(current.path, config);
      await expect(read()).rejects.toThrow(`recallConfig in ${file} must map projects to lists of projects`);
    }
    await rm(file);
    await global("{ not json");
    await expect(read()).rejects.toThrow("Could not read");
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

    test("reads this project by default, and the projects recallConfig lists with it", async () => {
      const { old, now, ctx } = await setup();
      expect((await resolveScope(ctx)).projects.map((p) => p.path)).toEqual([now.cwd]);
      expect(projectsOf((await recallSessions(ctx)).sessions)).toEqual(["here", "here"]);

      await projectSettings(now.cwd, ["pi-memory"]);
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
      const ctx = {
        sessionManager: current,
        ui: { theme, setStatus() {}, notify() {} },
        isIdle: () => false,
        isProjectTrusted: () => true,
      } as unknown as ExtensionToolContext;
      await createMarkTool().execute("t", { target: ref, reason: "Chose the store" }, undefined, undefined, ctx);

      const store = MarkStore.forDir(old.sessionDir);
      expect((await store.events()).map((e) => e.ref)).toEqual([ref]);
      if (!shared) expect(await MarkStore.forSession(current).events()).toEqual([]);

      expect(await marksSection(ctx)).toBeUndefined();
      const global = join(getAgentDir(), "settings.json");
      // src/test-setup.ts points pi at a temporary folder; never write the real global settings.
      expect(global.startsWith(join(homedir(), ".pi"))).toBe(false);
      await writeSettings(global, { recallConfig: { [now.cwd]: ["pi-memory"] } });
      try {
        expect(await marksSection(ctx)).toContain(`project="${old.cwd}"`);
      } finally {
        await rm(global);
      }
      await projectSettings(now.cwd, ["pi-memory"]);
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
