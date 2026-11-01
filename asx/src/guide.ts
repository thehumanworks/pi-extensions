import { fileURLToPath } from "node:url";

// src/ and dist/ sit at the same depth below the package root.
export const PACKAGE_ROOT = fileURLToPath(new URL("../", import.meta.url));
export const README_PATH = fileURLToPath(new URL("../README.md", import.meta.url));
export const EXAMPLES_DIR = fileURLToPath(new URL("../examples/workflows/", import.meta.url));
export const BIN_PATH = fileURLToPath(new URL("../bin/asx.mjs", import.meta.url));
/** The compiled workflow behind `asx <preset>` and `asx '<expression>'`; launched by path. */
export const EXPRESSION_WORKFLOW = fileURLToPath(new URL("../dist/workflows/expression.js", import.meta.url));
export const PRESET_EXAMPLES_DIR = fileURLToPath(new URL("../examples/presets/", import.meta.url));

export const EXPRESSION_SYNTAX = `@a -> @b                 pipeline: b receives a's output as {{ input }}
@a * 3                   three copies in parallel, each with {{ copy.index }}; outputs fan in as {{ inputs }}
@a * [security, perf]    copies with {{ copy.variant }}
[@a, @b -> @c]           parallel branches on the same input
(@a -> @b) * 2           grouping
repeat (@a -> @b) until @judge max 3   loop until the judge preset (output = "verdict") approves
@a(focus=security, n=2)  stage args, merged over --args as {{ args.focus }}
A bare name is a preset when such a preset exists; @name always is. Quote expressions in the shell.`;

/** A complete starter workflow; `init` writes it and the guide shows it. */
export function template(): string {
  return `import { Type } from "typebox";
import { defineWorkflow } from "@nothumanwork/asx";

export default defineWorkflow({
  description: "Two reviewers check a file, then a judge keeps the real bugs. Use for a quick second opinion.",
  args: Type.Object({ path: Type.String() }), // checked before the run starts
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
  /** The shell command that reaches the CLI, when it differs from "asx". */
  shell?: string;
  /** The launching session's model, such as "openai/gpt-6.1-sol:medium". */
  sessionModel?: string;
}

export function guide(options: GuideOptions = {}): string {
  const shell = options.shell ?? "asx";
  const terminal = shell === "asx" ? "Shell: asx" : `Shell: \`asx\` is not on PATH here, so use the full command: ${shell}`;
  return `# asx

asx runs agents durably on a separate worker, so a run survives the Pi session that started it. There are two ways to describe the work:

- **Presets and expressions**, no code. A preset is <project>/.pi/presets/<name>.toml or ~/.pi/agent/presets/<name>.toml: model, thinking, instructions, tools and a LiquidJS task template. Its agent is a full pi session with pi's tools, the user's extensions, MCP servers, skills and context files. Expressions compose presets on one line.
- **Workflows**, TypeScript files whose run(ctx) decides what happens, for control flow that depends on results, signals, worktrees or compensation.

## Presets and expressions

\`\`\`toml
# ~/.pi/agent/presets/review.toml
model = "openai/gpt-6.1-sol"
thinking = "medium"
includeTools = ["read", "grep", "find", "bash"]   # pi --tools semantics; omit for every tool
instructions = "Report concrete findings with file:line references."
task = '''
Review focus: {{ copy.variant | default: "general" }}
{% sh git diff --staged %}
{% if args.prompt %}Also: {{ args.prompt }}{% endif %}
'''
\`\`\`

Template variables: args (--args JSON and @preset(k=v)), cwd, env, input and inputs (upstream outputs), copy.index/count/variant (inside * N), iteration and feedback (inside repeat … until). {% sh cmd %} and {{ "cmd" | sh }} insert a command's stdout; a failing command fails the stage. A judge preset sets output = "verdict" and ends its reply with {"approved": bool, "feedback": "…"}; a missing verdict counts as a rejection.

\`\`\`text
${EXPRESSION_SYNTAX}
\`\`\`

- ${shell} review --args '{"prompt":"focus on the migration"}'
- ${shell} '@review * [security, perf] -> @synthesizer'
- ${shell} plan '<expression>' shows how it runs; ${shell} presets lists presets; run … --render prints the rendered prompts without running agents.
- Pi tool: {"action":"run","expression":"@review * 2 -> @synthesizer","args":{"prompt":"…"}}. In Pi: /asx review.
- In a workflow: await ctx.preset("review", { args, inputs }) returns the agent's text; ctx.agent(prompt, { runtime: "pi", tools: ["read"] }) runs any prompt as a pi session.

Each stage is one journaled step: completed stages replay from the journal and retry re-runs only unfinished ones. status --verbose lists every stage with its pi session file (open with pi --session <file>).

# Workflows

A workflow is a TypeScript file whose run(ctx) decides what happens. Each ctx.agent() call is a fresh agent conversation; each ctx.preset() call is a pi session configured by a preset.

## 1. Write one

Save it as <project>/.pi/workflows/<name>.ts, or ~/.pi/agent/workflows/<name>.ts for every project. The filename supplies the workflow's name; set name only when you want a different kebab-case alias. Workflow files are project source: commit them and never add them to .gitignore.

\`\`\`ts
${template().trimEnd()}
\`\`\`

## 2. Validate and run

- Pi tool: {"action":"validate","workflow":{"name":"review-file"}}, then {"action":"run","workflow":{"name":"review-file"},"args":{"path":"src/a.ts"},"wait":true}
- In Pi: /asx run review-file --args '{"path":"src/a.ts"}'
- ${terminal} run review-file --args '{"path":"src/a.ts"}' --model provider/model waits and prints the result. Add --bg to get a runId at once, then ${shell} poll <runId> (returns when the run ends or waits for a signal) and ${shell} result <runId>. \`pi asx\` is not a command.

In Pi, run without wait returns a runId at once and the launching session gets a message when the run ends. status and result show progress and the outcome.

## Which model runs

Each agent uses its own model option, else the definition's defaults.model, else the launch model. Pass an agent's options at its call site; share ordinary AgentSpec objects with ...spread when several agents need the same settings. The tool and /asx launch with the session's model and thinking level. A shell launch needs --model unless the definition sets defaults.model. Every status line names the model.${options.sessionModel ? ` This session's model is ${options.sessionModel}.` : ""}

## ctx

- agent(prompt, options?): the agent's final text, or a typed value when options.schema is set. Options: model, thinkingLevel, runtime ("durable", the default: read/write/edit/bash with per-tool-call durability; "pi": a full pi session with the user's tools, journaled as one step, no schema), tools (durable: default read/write/edit/bash, [] for none; pi: pi's --tools allowlist), excludeTools (pi), instructions, schema, label, phase, isolation ("worktree" gives the agent its own Git worktree and branch), retries, timeoutMs, cwd.
- preset(name, { args?, inputs?, copy?, iteration?, feedback?, env?, presetDirs?, label?, phase?, key? }): render the preset's task (journaled) and run it as a pi session; returns the text.
- parallel(thunks, { failure?, concurrency? }): results in input order. failure "null" (default) puts null in failed slots and continues; "failFast" stops the others and throws; "allSettled" returns { status, value | reason } per slot. Failed branches always appear in status.
- pipeline(items, stage1, stage2, ...): each item moves through the stages independently; a failed item becomes null.
- step(key, async ({ cwd, signal }) => ..., { retries?, compensate? }): side effects such as files, commands or network calls. A completed step is not re-run on replay. Resolve paths against cwd; revert calls compensate.
- workflow(name, args): run another workflow as a child.
- signal(key, { schema?, prompt?, timeoutMs? }): wait for outside input, delivered with the signal action.
- sleep(ms); spawn({ name, initialPrompt }) for a background agent you can send to and wait on; swarm({ workers, queue, worker: { prompt } }) for a shared work queue.
- phase(title), log(message, data?), now(), random(), args, cwd, runId.
- Recipes: import { dag, bestOf, untilDry } from "@nothumanwork/asx/recipes".

## Rules

- run() is replayed after a restart, so keep it deterministic: ctx.now() and ctx.random() instead of Date.now() and Math.random(), and I/O only inside ctx.step. validate flags the common mistakes.
- budget ({ maxCostUsd, maxTokens, maxDurationMs }) is optional. Agent calls, arrays and loop bounds define how many agents run; no separate count or registry is needed. Use defaults only for settings every agent shares.
- Durable agents get read/write/edit/bash in the run's cwd and nothing from the Pi session. Presets and runtime "pi" agents get pi's full toolset, the user's extensions, MCP servers and skills. No agent may start asx runs; compose with ctx.workflow() or ctx.preset().

This guide covers ordinary workflows. The README adds step effects and compensation, signals, worktrees, swarms, durability and troubleshooting: ${README_PATH}
Examples (copy into .pi/workflows/ to try): ${EXAMPLES_DIR}
Preset examples (copy into .pi/presets/ or ~/.pi/agent/presets/): ${PRESET_EXAMPLES_DIR}
`;
}
