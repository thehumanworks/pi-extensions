// Human-in-the-loop gate: the run waits durably until a signal arrives, then continues (a restart replays up to the wait).
// Deliver the signal with:  workflow signal <runId> approve-release '{"approved":true,"note":"ship it"}'
// or from inside Pi:        workflow { action: "signal", runId, key: "approve-release", value: {...} }
import { Type } from "typebox";
import { defineWorkflow } from "@nothumanwork/pi-orchestration";

export default defineWorkflow({
  name: "release-with-approval",
  description: "Prepare a release, wait for a human to approve, then perform an npm publication dry run, with tag compensation on revert",
  args: Type.Object({ version: Type.String() }),

  run: async (ctx) => {
    ctx.phase("Prepare");
    const notes = await ctx.agent(`Draft release notes for ${ctx.args.version} from the git log since the last tag.`, { label: "notes", tools: ["read", "bash"] });

    // Journaled side effect with a compensation: `workflow revert <runId>` deletes the tag again.
    await ctx.step("tag", async () => {
      const { execFileSync } = await import("node:child_process");
      execFileSync("git", ["tag", "-a", `v${ctx.args.version}`, "-m", notes], { cwd: ctx.cwd });
      return `v${ctx.args.version}`;
    }, {
      compensate: async (tag) => {
        const { execFileSync } = await import("node:child_process");
        execFileSync("git", ["tag", "-d", tag], { cwd: ctx.cwd });
      },
    });

    ctx.phase("Approve");
    const decision = await ctx.signal("approve-release", {
      prompt: `Approve release v${ctx.args.version}?\n\n${notes}`, // shown by `status`/TUI while waiting
      schema: Type.Object({ approved: Type.Boolean(), note: Type.Optional(Type.String()) }),
      timeoutMs: 48 * 60 * 60 * 1000,
    });
    if (!decision.approved) throw new Error(`Release rejected: ${decision.note ?? "no reason"}`);

    ctx.phase("Dry run");
    await ctx.step("publish-dry-run", async () => {
      const { execFileSync } = await import("node:child_process");
      execFileSync("npm", ["publish", "--dry-run"], { cwd: ctx.cwd }); // This example never publishes.
      return true;
    });

    return { tag: `v${ctx.args.version}`, note: decision.note };
  },
});
