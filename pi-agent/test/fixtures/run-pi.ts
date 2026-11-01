import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

// Runs the real Pi CLI with this extension and the scripted model in faux-model.ts, inside a
// temporary Pi agent directory, so no user settings, extensions or credentials take part. The
// environment is reduced to the basics too: with provider keys in it, Pi could fall back to a
// real provider when it does not select the faux model. Pi can skip restoring a resumed
// session's faux model, because the provider an extension registers may not yet be in its
// credential snapshot, so every run passes --model.

const PI = fileURLToPath(new URL("./bundle/cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
const EXTENSION = fileURLToPath(new URL("../../index.ts", import.meta.url));
const FAUX = fileURLToPath(new URL("./faux-model.ts", import.meta.url));
const BASE_ARGS = ["-e", EXTENSION, "-e", FAUX, "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-mcp", "--model", "faux/faux-1"];

export type Step = { tool: string; args?: Record<string, unknown> } | { text: string };
export type Call = { model: string; system: string; tools: string[]; last?: { role: string; text: string } };
export type PrintRun = { code: number | null; stdout: string; stderr: string; calls: Call[] };
export type SessionEntry = { type: string; customType?: string; data?: unknown; cwd?: string; message?: { role: string } };

export class Pi {
  private runs = 0;

  private constructor(
    readonly root: string,
    readonly agentDir: string,
    readonly project: string,
  ) {}

  static async create(): Promise<Pi> {
    const root = await mkdtemp(join(tmpdir(), "pi-agent-"));
    const pi = new Pi(root, join(root, "agent"), join(root, "project"));
    mkdirSync(join(pi.agentDir, "agents"), { recursive: true });
    mkdirSync(pi.project, { recursive: true });
    mkdirSync(pi.tmp, { recursive: true });
    return pi;
  }

  async dispose() {
    await rm(this.root, { recursive: true, force: true });
  }

  /** Writes an agent definition: a user agent, or a project agent in the test project. */
  defineAgent(name: string, frontmatter: string, body: string, scope: "user" | "project" = "user"): string {
    const dir = scope === "user" ? join(this.agentDir, "agents") : join(this.project, ".pi", "agents");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${name}.md`);
    writeFileSync(file, `---\nname: ${name}\ndescription: The ${name} agent\n${frontmatter}---\n${body}\n`);
    return file;
  }

  /** The children's TMPDIR. */
  get tmp(): string {
    return join(this.root, "tmp");
  }

  home(name: string): string {
    return join(this.agentDir, "agent-workspaces", name);
  }

  /** Session files whose header cwd is `cwd`, oldest first. */
  sessions(cwd: string): { file: string; entries: SessionEntry[] }[] {
    const root = join(this.agentDir, "sessions");
    if (!existsSync(root)) return [];
    const files = readdirSync(root, { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith(".jsonl"))
      .map((file) => join(root, file))
      .sort();
    return files
      .map((file) => ({ file, entries: readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) }))
      .filter((session) => session.entries[0]?.cwd === cwd);
  }

  async print(args: string[], script: Step[]): Promise<PrintRun> {
    const log = this.nextLog();
    const child = this.spawn([...args, "-p"], script, log);
    child.stdin.end();
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", resolve);
    });
    return { code, stdout, stderr, calls: readCalls(log) };
  }

  rpc(args: string[], script: Step[]): Rpc {
    const log = this.nextLog();
    return new Rpc(this.spawn([...args, "--mode", "rpc"], script, log), log);
  }

  private nextLog(): string {
    return join(this.root, `calls-${++this.runs}.jsonl`);
  }

  private spawn(args: string[], script: Step[], log: string): ChildProcessWithoutNullStreams {
    return spawn(process.execPath, [PI, ...BASE_ARGS, ...args], {
      cwd: this.project,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        SHELL: process.env.SHELL,
        TMPDIR: this.tmp,
        PI_CODING_AGENT_DIR: this.agentDir,
        PI_OFFLINE: "1",
        FAUX_LOG: log,
        FAUX_SCRIPT: JSON.stringify(script),
      },
    });
  }
}

type RpcMessage = { type: string; id?: string; command?: string; success?: boolean; data?: unknown; method?: string; message?: string; error?: string };

export class Rpc {
  readonly messages: RpcMessage[] = [];
  private waiters: (() => void)[] = [];
  private nextId = 0;
  private stderr = "";

  constructor(
    private child: ChildProcessWithoutNullStreams,
    private log: string,
  ) {
    createInterface({ input: child.stdout }).on("line", (line) => {
      try {
        this.messages.push(JSON.parse(line));
      } catch {
        return;
      }
      for (const wake of this.waiters.splice(0)) wake();
    });
    child.stderr.on("data", (chunk) => (this.stderr += chunk));
  }

  get calls(): Call[] {
    return readCalls(this.log);
  }

  /** Sends a command and resolves with its response. */
  async request(command: Record<string, unknown>): Promise<RpcMessage> {
    const id = String(++this.nextId);
    this.child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
    return this.waitFor((message) => message.type === "response" && message.id === id);
  }

  async waitFor(predicate: (message: RpcMessage) => boolean, timeoutMs = 15_000): Promise<RpcMessage> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.messages.find(predicate);
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`timed out; stderr:\n${this.stderr}\nmessages:\n${this.messages.map((m) => JSON.stringify(m).slice(0, 300)).join("\n")}`);
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 100);
      });
    }
  }

  /** Waits until the agent has ended `count` runs. */
  async runsEnded(count: number) {
    await this.waitFor(() => this.messages.filter((message) => message.type === "agent_end").length >= count);
  }

  async state(): Promise<{ sessionFile: string; model: { id: string } }> {
    return (await this.request({ type: "get_state" })).data as { sessionFile: string; model: { id: string } };
  }

  async close() {
    this.child.stdin.end();
    if (this.child.exitCode === null) {
      await new Promise((resolve) => {
        this.child.on("exit", resolve);
        setTimeout(() => this.child.kill(), 5_000);
      });
    }
  }
}

function readCalls(log: string): Call[] {
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

/** The session header cwd of a session file. */
export function sessionCwd(file: string): string | undefined {
  return JSON.parse(readFileSync(file, "utf8").split("\n")[0] ?? "{}").cwd;
}
