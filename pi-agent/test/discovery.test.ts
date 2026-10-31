import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { agentDirectories, discoverAgents } from "../src/discovery.ts";

let root: string;
let cwd: string;
let agentDir: string;

const write = (path: string, content: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};
const agent = (name: string, description = `${name} agent`) => `---\nname: ${name}\ndescription: ${description}\n---\n\nYou are ${name}.\n`;
const projectAgents = () => join(cwd, ".pi", "agents");
const userAgents = () => join(agentDir, "agents");
const names = (result: ReturnType<typeof discoverAgents>) => result.agents.map((a) => a.definition.name);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pi-agent-discovery-"));
  cwd = join(root, "project");
  agentDir = join(root, "home", ".pi", "agent");
  mkdirSync(cwd, { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("discoverAgents", () => {
  test("loads project and user agents with their scope", () => {
    write(join(projectAgents(), "reviewer.md"), agent("reviewer"));
    write(join(userAgents(), "researcher.md"), agent("researcher"));

    const result = discoverAgents({ cwd, agentDir, projectTrusted: true });

    assert.deepEqual(
      result.agents.map(({ definition, scope, baseDir, prompt }) => ({ name: definition.name, scope, baseDir, prompt })),
      [
        { name: "reviewer", scope: "project", baseDir: projectAgents(), prompt: "You are reviewer." },
        { name: "researcher", scope: "user", baseDir: userAgents(), prompt: "You are researcher." },
      ],
    );
    assert.deepEqual(result.diagnostics, []);
  });

  test("project definitions win name collisions", () => {
    write(join(projectAgents(), "reviewer.md"), agent("reviewer", "project"));
    write(join(userAgents(), "reviewer.md"), agent("reviewer", "user"));

    const result = discoverAgents({ cwd, agentDir, projectTrusted: true });

    assert.equal(result.agents.length, 1);
    assert.equal(result.agents[0]?.definition.description, "project");
    assert.deepEqual(result.diagnostics, [
      {
        type: "collision",
        message: 'agent name "reviewer" collision',
        path: join(userAgents(), "reviewer.md"),
        collision: {
          name: "reviewer",
          winnerPath: join(projectAgents(), "reviewer.md"),
          loserPath: join(userAgents(), "reviewer.md"),
        },
      },
    ]);
  });

  test("skips project definitions until the project is trusted", () => {
    write(join(projectAgents(), "reviewer.md"), agent("reviewer", "project"));
    write(join(userAgents(), "reviewer.md"), agent("reviewer", "user"));

    const result = discoverAgents({ cwd, agentDir, projectTrusted: false });

    assert.deepEqual(names(result), ["reviewer"]);
    assert.equal(result.agents[0]?.scope, "user");
    assert.deepEqual(result.diagnostics, []);
    assert.deepEqual(agentDirectories({ cwd, agentDir, projectTrusted: false }), [{ scope: "user", dir: userAgents() }]);
  });

  test("loads only .md files directly inside an agents directory", () => {
    write(join(userAgents(), "reviewer.md"), agent("reviewer"));
    write(join(userAgents(), "review", "security.md"), agent("security"));
    write(join(userAgents(), "notes.txt"), agent("not-markdown"));

    assert.deepEqual(names(discoverAgents({ cwd, agentDir, projectTrusted: true })), ["reviewer"]);
  });

  test("skips ignored files, dot entries and node_modules", () => {
    write(join(userAgents(), ".gitignore"), "/scratch.md\n");
    write(join(userAgents(), ".ignore"), "wip-*.md\n!wip-keep.md\n");
    write(join(userAgents(), "scratch.md"), agent("scratch"));
    write(join(userAgents(), "wip-one.md"), agent("wip-one"));
    write(join(userAgents(), "wip-keep.md"), agent("wip-keep"));
    write(join(userAgents(), "done.md"), agent("done"));
    write(join(userAgents(), ".dot.md"), agent("dot"));
    write(join(userAgents(), "node_modules.md"), agent("not-a-dir"));
    mkdirSync(join(userAgents(), "node_modules"), { recursive: true });

    assert.deepEqual(names(discoverAgents({ cwd, agentDir, projectTrusted: true })).sort(), ["done", "not-a-dir", "wip-keep"]);
  });

  test("ignores documentation silently and reports invalid definitions", () => {
    write(join(userAgents(), "README.md"), "# My agents\n\nNotes for humans.\n");
    write(join(userAgents(), "unnamed.md"), "---\ndescription: no name\n---\nBody\n");
    write(join(userAgents(), "broken.md"), "---\nname: broken\n---\nBody\n");
    write(join(userAgents(), "good.md"), agent("good"));

    const result = discoverAgents({ cwd, agentDir, projectTrusted: true });

    assert.deepEqual(names(result), ["good"]);
    assert.deepEqual(result.diagnostics, [
      { type: "warning", message: "description is required", path: join(userAgents(), "broken.md") },
    ]);
  });

  test("a file reached through a symlink is not a collision", () => {
    write(join(userAgents(), "shared.md"), agent("shared"));
    mkdirSync(projectAgents(), { recursive: true });
    symlinkSync(join(userAgents(), "shared.md"), join(projectAgents(), "shared.md"));
    symlinkSync(join(root, "missing.md"), join(projectAgents(), "broken.md"));

    const result = discoverAgents({ cwd, agentDir, projectTrusted: true });

    assert.deepEqual(names(result), ["shared"]);
    assert.equal(result.agents[0]?.scope, "project");
    assert.deepEqual(result.diagnostics, []);
  });

  test("defaults to Pi's agent directory", () => {
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      write(join(userAgents(), "researcher.md"), agent("researcher"));
      assert.deepEqual(names(discoverAgents({ cwd, projectTrusted: false })), ["researcher"]);
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }
  });

  test("returns nothing when no agent directories exist", () => {
    assert.deepEqual(discoverAgents({ cwd, agentDir, projectTrusted: true }), { agents: [], diagnostics: [] });
  });
});
