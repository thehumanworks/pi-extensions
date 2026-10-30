import { fileURLToPath } from "node:url";

// src/ and dist/ sit at the same depth below the package root.
export const PACKAGE_ROOT = fileURLToPath(new URL("../", import.meta.url));
export const README_PATH = fileURLToPath(new URL("../README.md", import.meta.url));
export const EXAMPLES_DIR = fileURLToPath(new URL("../examples/workflows/", import.meta.url));
export const BIN_PATH = fileURLToPath(new URL("../bin/workflow.mjs", import.meta.url));

/** A complete starter workflow; `init` writes it and the guide shows it. */
export function template(name = "review-file"): string {
  return `import { Type } from "typebox";
import { defineWorkflow } from "@nothumanwork/pi-orchestration";

export default defineWorkflow({
  name: "${name}", // kebab-case; run it by this name
  description: "Two reviewers check a file, then a judge keeps the real bugs. Use for a quick second opinion.",
  args: Type.Object({ path: Type.String() }), // checked before the run starts
  budget: { maxAgents: 3 }, // a cap; the code below decides how many agents run
  async run(ctx) {
    ctx.phase("Review");
    const reviews = await ctx.parallel(
      ["correctness", "edge cases"].map(focus => () =>
        ctx.agent(\`Review \${ctx.args.path} for \${focus} bugs. Cite lines.\`, { label: focus, tools: ["read"] })),
      { failure: "failFast" }, // the default, "null", turns a failed branch into null and carries on
    );
    ctx.phase("Judge");
    return ctx.agent(\`Which of these reported bugs are real? Check the code.\\n\${JSON.stringify(reviews)}\`, {
      label: "judge",
      tools: ["read", "bash"],
      schema: Type.Object({ bugs: Type.Array(Type.String()) }), // typed, validated result
    });
  },
});
`;
}

export interface GuideOptions {
  /** The shell command that reaches the CLI, when it differs from "workflow". */
  shell?: string;
  /** The launching session's model, such as "openai/gpt-6.1-sol:medium". */
  sessionModel?: string;
}

export function guide(options: GuideOptions = {}): string {
  const shell = options.shell ?? "workflow";
  const terminal = shell === "workflow" ? "Shell: workflow" : `Shell: \`workflow\` is not on PATH here, so use the full command: ${shell}`;
  return `# Workflows

A workflow is a TypeScript file whose run(ctx) decides what happens. Each ctx.agent() call is a fresh agent conversation. A separate worker runs it, so a run survives the Pi session that started it.

## 1. Write one

Save it as <project>/.pi/workflows/<name>.ts, or ~/.pi/agent/workflows/<name>.ts for every project. Workflow files are project source: commit them and never add them to .gitignore.

\`\`\`ts
${template().trimEnd()}
\`\`\`

## 2. Validate and run

- Pi tool: {"action":"validate","workflow":{"name":"review-file"}}, then {"action":"run","workflow":{"name":"review-file"},"args":{"path":"src/a.ts"},"wait":true}
- In Pi: /workflow run review-file --args '{"path":"src/a.ts"}'
- ${terminal} run review-file --args '{"path":"src/a.ts"}' --model provider/model. \`pi workflow\` is not a command.

Without wait, run returns a runId at once; the launching session gets a message when the run ends. status and result show progress and the outcome.

## Which model runs

Each agent uses its own model option, else its agentType's, else the definition's defaults.model, else the launch model. The tool and /workflow launch with the session's model and thinking level. A shell launch needs --model unless the definition sets defaults.model. Every status line names the model.${options.sessionModel ? ` This session's model is ${options.sessionModel}.` : ""}

## ctx

- agent(prompt, options?): the agent's final text, or a typed value when options.schema is set. Options: model, thinkingLevel, tools (default read/write/edit/bash; [] for none), instructions, schema, label, phase, isolation ("worktree" gives the agent its own Git worktree and branch), retries, timeoutMs, cwd, agentType.
- parallel(thunks, { failure?, concurrency? }): results in input order. failure "null" (default) puts null in failed slots and continues; "failFast" stops the others and throws; "allSettled" returns { status, value | reason } per slot. Failed branches always appear in status.
- pipeline(items, stage1, stage2, ...): each item moves through the stages independently; a failed item becomes null.
- step(key, async ({ cwd, signal }) => ..., { retries?, compensate? }): side effects such as files, commands or network calls. A completed step is not re-run on replay. Resolve paths against cwd; revert calls compensate.
- workflow(name, args): run another workflow as a child.
- signal(key, { schema?, prompt?, timeoutMs? }): wait for outside input, delivered with the signal action.
- sleep(ms); spawn({ name, initialPrompt }) for a background agent you can send to and wait on; swarm({ workers, queue, worker: { prompt } }) for a shared work queue.
- phase(title), log(message, data?), now(), random(), args, cwd, runId.
- Recipes: import { dag, bestOf, untilDry } from "@nothumanwork/pi-orchestration/recipes".

## Rules

- run() is replayed after a restart, so keep it deterministic: ctx.now() and ctx.random() instead of Date.now() and Math.random(), and I/O only inside ctx.step. validate flags the common mistakes.
- budget ({ maxAgents, maxCostUsd, maxTokens, maxDurationMs }) only sets limits. The code decides how many agents run.
- Agents get read/write/edit/bash in the run's cwd. They do not get the Pi session's extensions, MCP tools or skills, and they cannot start workflows; compose with ctx.workflow().

This guide covers ordinary workflows. The README adds step effects and compensation, signals, worktrees, swarms, durability and troubleshooting: ${README_PATH}
Examples (copy into .pi/workflows/ to try): ${EXAMPLES_DIR}
`;
}
