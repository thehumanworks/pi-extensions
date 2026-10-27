// Pipeline: each item flows through stages independently — no barrier between stages.
// Default to this over parallel()+parallel() when a later stage does not need ALL earlier results at once.
import { Type } from "typebox";
import { defineWorkflow } from "@nothumanwork/pi-orchestration";

const FINDINGS = Type.Object({ file: Type.String(), findings: Type.Array(Type.Object({ line: Type.Integer(), severity: Type.String(), issue: Type.String() })) });
const VERDICT = Type.Object({ file: Type.String(), confirmed: Type.Array(Type.Object({ line: Type.Integer(), issue: Type.String(), fixSuggestion: Type.String() })) });

export default defineWorkflow({
  name: "audit-pipeline",
  description: "Audit every file under a path: find → verify → write fix notes, streaming per file",
  args: Type.Object({ path: Type.String(), pattern: Type.Optional(Type.String({ default: "**/*.ts" })) }),

  run: async (ctx) => {
    // A journaled side effect: the file list must be stable across replays.
    const files = await ctx.step("list-files", async () => {
      const { execFileSync } = await import("node:child_process");
      return execFileSync("git", ["ls-files", "--", ctx.args.path], { cwd: ctx.cwd, encoding: "utf8" })
        .split("\n")
        .filter((f) => f.endsWith(".ts"));
    });

    const notes = await ctx.pipeline(
      files,
      // stage 1: find
      (file) => ctx.agent(`Audit ${file} for missing auth checks and unsafe input handling.`, { label: `find:${file}`, phase: "Find", schema: FINDINGS, tools: ["read"] }),
      // stage 2: verify — a skeptic tries to refute each finding
      (found, file) =>
        ctx.agent(`Try to refute each finding. Keep only the ones you cannot refute.\n${JSON.stringify(found)}`, {
          label: `verify:${file}`,
          phase: "Verify",
          schema: VERDICT,
          tools: ["read", "bash"],
        }),
      // stage 3: plain code — no agent needed
      async (verdict) => (verdict.confirmed.length ? `## ${verdict.file}\n` + verdict.confirmed.map((c) => `- L${c.line}: ${c.issue} → ${c.fixSuggestion}`).join("\n") : ""),
    );

    return notes.filter(Boolean).join("\n\n");
  },
});
