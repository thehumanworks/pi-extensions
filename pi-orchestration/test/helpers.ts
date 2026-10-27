import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall,
  type FauxResponseFactory, type Message,
} from "@earendil-works/pi-ai";
import { rpc } from "../src/client.ts";
import type { RunRecord } from "../src/index.ts";
import type { ControlRequest } from "../src/protocol.ts";
import { TERMINAL_STATUSES } from "../src/protocol.ts";
import { startWorker, type WorkerOptions } from "../src/worker.ts";

export const MODEL = "faux/faux-1";
export const CLI = new URL("../bin/pi-workflow.mjs", import.meta.url).pathname;

function text(message: Message | undefined): string {
  if (!message || message.role === "assistant") return "";
  const content = message.content;
  if (typeof content === "string") return content;
  return content.map(block => block.type === "text" ? block.text : "").join("");
}

function directive(prompt: string, name: string): string | undefined {
  const match = new RegExp(`${name} (.*)`, "s").exec(prompt);
  return match?.[1].trim();
}

/**
 * A faux model driven by directives in the prompt, so concurrent agents need no response order:
 * SUBMIT <json>, REPAIR <json> (prose first), NEVER (prose only), BASH <command>,
 * FAIL_ONCE <id>, ECHO <text> and RECALL (repeats the conversation's first ECHO).
 */
export function scriptedModels() {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const failed = new Set<string>();
  const calls: string[] = [];
  const router: FauxResponseFactory = context => {
    const messages = context.messages;
    const last = messages.at(-1);
    const users = messages.filter(message => message.role === "user").map(text);
    const first = users[0] ?? "";
    if (last?.role === "toolResult") return fauxAssistantMessage(`tool output: ${text(last).trim()}`);
    const prompt = text(last);
    calls.push(prompt);
    const repair = /missing or invalid|Call submit_result/.test(prompt);
    const submit = directive(repair ? first : prompt, "SUBMIT") ?? (repair ? directive(first, "REPAIR") : undefined);
    if (submit !== undefined && !(repair && first.includes("NEVER")))
      return fauxAssistantMessage([fauxToolCall("submit_result", JSON.parse(submit))], { stopReason: "toolUse" });
    if (repair || prompt.includes("NEVER") || directive(prompt, "REPAIR") !== undefined) return fauxAssistantMessage("Prose without a result.");
    const command = directive(prompt, "BASH");
    if (command !== undefined) return fauxAssistantMessage([fauxToolCall("bash", { command })], { stopReason: "toolUse" });
    const flaky = directive(prompt, "FAIL_ONCE");
    if (flaky !== undefined && !failed.has(flaky)) {
      failed.add(flaky);
      return fauxAssistantMessage("", { stopReason: "error", errorMessage: "scripted provider failure" });
    }
    if (prompt.includes("RECALL")) return fauxAssistantMessage(fauxText(directive(first, "ECHO") ?? "nothing"));
    const echo = directive(prompt, "ECHO");
    return fauxAssistantMessage(echo ?? `ok: ${prompt.slice(0, 40)}`);
  };
  faux.setResponses(Array.from({ length: 2000 }, () => router));
  return { models, calls };
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Test", ...args], { cwd, encoding: "utf8" }).trim();
}

export interface Fixture {
  root: string;
  home: string;
  project: string;
  calls: string[];
  request<T = unknown>(request: ControlRequest): Promise<T>;
  launch(workflow: string, args?: unknown, extra?: Partial<Extract<ControlRequest, { action: "run" }>>): Promise<string>;
  wait(runId: string, until?: (run: RunRecord) => boolean): Promise<RunRecord>;
  run(workflow: string, args?: unknown, extra?: Partial<Extract<ControlRequest, { action: "run" }>>): Promise<RunRecord>;
  write(path: string, source: string): Promise<void>;
  close(): Promise<void>;
}

let requestCounter = 0;

/** A temporary Git project and an in-process worker using the scripted faux model. */
export async function fixture(options: { workflows?: Record<string, string>; symlinkHome?: boolean; worker?: Partial<WorkerOptions> } = {}): Promise<Fixture> {
  // Short paths keep the Unix socket within platform limits.
  const root = await mkdtemp(join(tmpdir(), "po-"));
  const project = join(root, "p");
  await mkdir(project);
  git(project, "init", "-q", "-b", "main");
  await writeFile(join(project, "README.md"), "fixture\n");
  git(project, "add", "-A");
  git(project, "commit", "-qm", "init");
  let home = join(root, "h");
  await mkdir(home);
  if (options.symlinkHome) {
    await symlink(home, join(root, "l"));
    home = join(root, "l");
  }
  const { models, calls } = scriptedModels();
  const worker = await startWorker({ home, models, retryBackoffMs: 0, maxConcurrentAgents: 4, ...options.worker });
  if (!worker) throw new Error("Fixture worker did not start.");
  const write = async (path: string, source: string) => {
    const target = join(project, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, source);
  };
  for (const [name, source] of Object.entries(options.workflows ?? {})) await write(join(".pi", "workflows", `${name}.ts`), source);
  const request = <T>(value: ControlRequest) => rpc<T>(value, { home, timeoutMs: 60_000 });
  const launch = async (workflow: string, args: unknown = {}, extra: Partial<Extract<ControlRequest, { action: "run" }>> = {}) => {
    const reply = await request<{ runId: string }>({
      action: "run", requestId: `test-${process.pid}-${++requestCounter}`, workflow: workflow.includes("/") ? { path: workflow } : { name: workflow },
      args, cwd: project, model: MODEL, origin: { kind: "cli" }, ...extra,
    });
    return reply.runId;
  };
  const wait = async (runId: string, until: (run: RunRecord) => boolean = run => TERMINAL_STATUSES.has(run.status)) => {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const run = await request<RunRecord>({ action: "status", runId, verbose: true });
      if (until(run)) return run;
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${runId}: ${JSON.stringify(run, null, 2)}`);
      await delay(20);
    }
  };
  return {
    root, home, project, calls, request, launch, wait, write,
    run: async (workflow, args, extra) => wait(await launch(workflow, args, extra)),
    close: async () => { await worker.close(); await rm(root, { recursive: true, force: true }); },
  };
}

/** Workflow module source importing the package the way users do. */
export function workflow(body: string, imports = ""): string {
  return `import { Type } from "typebox";\nimport { defineWorkflow } from "@nothumanwork/pi-orchestration";\n${imports}\nexport default defineWorkflow(${body});\n`;
}
