import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

// End-to-end runs against real providers, opt-in because they cost money and need logins:
//
//   PI_AGENT_E2E_MODELS=openai/gpt-6.1-sol,claude-bridge/claude-haiku-5-5 npm test
//
// They use the real Pi agent directory, whose credentials can't be copied safely (OAuth
// refresh tokens rotate). Everything else is kept apart: the agent is a uniquely named project
// agent in a temporary project, sessions go to a temporary --session-dir, and the agent's home
// is removed afterwards. A `claude-bridge/` model loads pi-claude-bridge from Pi's npm packages.

const MODELS = (process.env.PI_AGENT_E2E_MODELS ?? "").split(",").map((model) => model.trim()).filter(Boolean);
const PI = fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js", import.meta.url));
const EXTENSION = fileURLToPath(new URL("../index.ts", import.meta.url));
const BRIDGE = join(homedir(), ".pi", "agent", "npm", "node_modules", "pi-claude-bridge");
const TIMEOUT = 180_000;

type Entry = {
  type: string;
  cwd?: string;
  customType?: string;
  data?: { name: string; home: string };
  message?: {
    role: string;
    model?: string;
    provider?: string;
    content?: string | { type: string; name?: string; text?: string }[];
    sections?: Record<string, string>;
    toolsAdded?: { name: string }[];
  };
};

describe("real providers", { skip: MODELS.length === 0 && "set PI_AGENT_E2E_MODELS to run" }, () => {
  let root: string;
  let project: string;
  let sessionDir: string;
  const workspaces = join(getAgentDir(), "agent-workspaces");
  const workspacesExisted = existsSync(workspaces);
  const homes: string[] = [];

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "pi-agent-e2e-"));
    project = join(root, "project");
    sessionDir = join(root, "sessions");
    mkdirSync(join(project, ".pi", "agents"), { recursive: true });
  });

  after(async () => {
    for (const home of homes) rmSync(home, { recursive: true, force: true });
    if (!workspacesExisted && existsSync(workspaces) && readdirSync(workspaces).length === 0) rmdirSync(workspaces);
    await rm(root, { recursive: true, force: true });
  });

  for (const model of MODELS) {
    // The launch model differs from the agent's, so the answer shows the agent's model applies.
    const launch = MODELS.find((other) => other !== model) ?? model;

    describe(model, () => {
      const name = `e2e-${randomBytes(4).toString("hex")}`;
      const code = `${randomBytes(3).toString("hex")}-heron`;
      const body = [
        "You are the vault keeper.",
        "When asked for the code word, read the file code.txt in your working directory with the read tool,",
        "then reply with only its exact contents: no other words, punctuation or formatting.",
      ].join(" ");
      const home = join(workspaces, name);
      let first: string | undefined;

      before(() => {
        writeFileSync(join(project, ".pi", "agents", `${name}.md`), `---\nname: ${name}\ndescription: Keeps the code word\ntools: Read\nmodel: ${model}\n---\n${body}\n`);
        homes.push(home);
        mkdirSync(home, { recursive: true });
        writeFileSync(join(home, "code.txt"), `${code}\n`);
      });

      test("--agent in print mode answers as the agent, in its home, with its tools and model", { timeout: TIMEOUT }, async () => {
        const run = await print(["--model", launch, "--agent", name, "What is the code word?"]);

        assert.equal(run.code, 0, run.stderr);
        assert.equal(run.stdout.trim(), code, run.stderr);
        const sessions = agentSessions(home);
        assert.equal(sessions.length, 1);
        first = sessions[0];
        assertAgentSession(readEntries(first!));
      });

      test("a resumed session is still the agent", { timeout: TIMEOUT }, async () => {
        assert.ok(first, "the print-mode session exists");
        const changed = `${randomBytes(3).toString("hex")}-crane`;
        writeFileSync(join(home, "code.txt"), `${changed}\n`);
        const run = await print(["--model", model, "--session", first, "The code word has changed. What is it now?"]);

        assert.equal(run.code, 0, run.stderr);
        assert.equal(run.stdout.trim(), changed, run.stderr);
        writeFileSync(join(home, "code.txt"), `${code}\n`);
        const entries = readEntries(first);
        const reads = entries.filter((entry) => toolCalls(entry).includes("read"));
        assert.equal(reads.length, 2, "both turns read the file");
      });

      test("/agent in RPC mode starts the agent's session and sends the prompt", { timeout: TIMEOUT }, async () => {
        const before = new Set(agentSessions(home));
        const rpc = startRpc(["--model", launch]);
        try {
          await rpc.send({ type: "prompt", message: `/agent ${name} What is the code word?` });
          const end = await rpc.waitFor((message) => message.type === "agent_end");
          assert.ok(end);
          const state = (await rpc.send({ type: "get_last_assistant_text" })).data as { text: string };
          assert.equal(state.text.trim(), code);
        } finally {
          await rpc.close();
        }
        const created = agentSessions(home).filter((file) => !before.has(file));
        assert.equal(created.length, 1);
        assertAgentSession(readEntries(created[0]!));
      });

      function assertAgentSession(entries: Entry[]) {
        assert.equal(entries[0]?.cwd, home, "the session's cwd is the agent's home");
        assert.equal(entries.find((entry) => entry.customType === "pi-agent")?.data?.name, name);
        const system = entries.find((entry) => entry.message?.role === "system")?.message;
        assert.equal(system?.sections?.preamble, body, "the agent's body replaces Pi's base prompt");
        assert.deepEqual(system?.toolsAdded?.map((tool) => tool.name), ["read"], "only the agent's tools are declared");
        const answers = entries.filter((entry) => entry.message?.role === "assistant").map((entry) => entry.message!);
        assert.ok(answers.length >= 2, "the model called a tool, then answered");
        for (const answer of answers) assert.equal(`${answer.provider}/${answer.model}`, model, "the agent's model answered");
        assert.ok(entries.some((entry) => toolCalls(entry).includes("read")), "the model read code.txt");
      }
    });
  }

  function baseArgs(): string[] {
    const args = ["-ne", "-e", EXTENSION];
    if (MODELS.some((model) => model.startsWith("claude-bridge/"))) args.push("-e", BRIDGE);
    args.push("--no-skills", "--no-prompt-templates", "--no-context-files", "--no-mcp", "--approve", "--session-dir", sessionDir);
    return args;
  }

  function print(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const child = spawn(process.execPath, [PI, ...baseArgs(), ...args, "-p"], { cwd: project, env: process.env });
    child.stdin.end();
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    return new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code) => resolve({ code, stdout, stderr }));
    });
  }

  function startRpc(args: string[]) {
    const child = spawn(process.execPath, [PI, ...baseArgs(), ...args, "--mode", "rpc"], { cwd: project, env: process.env });
    const messages: { type: string; id?: string; data?: unknown }[] = [];
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    createInterface({ input: child.stdout }).on("line", (line) => {
      try {
        messages.push(JSON.parse(line));
      } catch {}
    });
    let id = 0;
    const waitFor = async (predicate: (message: (typeof messages)[number]) => boolean) => {
      const deadline = Date.now() + TIMEOUT - 10_000;
      for (;;) {
        const found = messages.find(predicate);
        if (found) return found;
        if (Date.now() > deadline) throw new Error(`timed out; stderr:\n${stderr}\n${messages.map((m) => JSON.stringify(m).slice(0, 300)).join("\n")}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    };
    return {
      waitFor,
      send(command: Record<string, unknown>) {
        const requestId = String(++id);
        child.stdin.write(`${JSON.stringify({ ...command, id: requestId })}\n`);
        return waitFor((message) => message.type === "response" && message.id === requestId);
      },
      async close() {
        child.stdin.end();
        if (child.exitCode === null) await new Promise((resolve) => {
          child.on("exit", resolve);
          setTimeout(() => child.kill(), 10_000);
        });
      },
    };
  }

  function agentSessions(home: string): string[] {
    if (!existsSync(sessionDir)) return [];
    return readdirSync(sessionDir)
      .filter((file) => file.endsWith(".jsonl"))
      .map((file) => join(sessionDir, file))
      .filter((file) => readEntries(file)[0]?.cwd === home)
      .sort();
  }
});

function readEntries(file: string): Entry[] {
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function toolCalls(entry: Entry): string[] {
  const content = entry.message?.role === "assistant" ? entry.message.content : undefined;
  return Array.isArray(content) ? content.filter((part) => part.type === "toolCall").map((part) => part.name ?? "") : [];
}
