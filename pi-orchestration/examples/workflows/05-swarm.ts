// Swarm: N long-lived workers pull from a durable queue, share a blackboard, and can discover new work.
// Differs from parallel(): workers are persistent conversations (keep context across items) and the queue can grow.
import { Type } from "typebox";
import { defineWorkflow } from "@nothumanwork/pi-orchestration";

const MODULE_RESULT = Type.Object({
  module: Type.String(),
  migrated: Type.Boolean(),
  newDependents: Type.Array(Type.String({ description: "modules that must now be migrated too" })),
  notesForOthers: Type.String({ description: "one line for the shared blackboard" }),
});

export default defineWorkflow({
  name: "migration-swarm",
  description: "Migrate modules from library A to B with a swarm of workers that share conventions on a blackboard",
  args: Type.Object({ seedModules: Type.Array(Type.String()), workers: Type.Optional(Type.Integer({ minimum: 1, maximum: 32, default: 4 })) }),
  budget: { maxAgents: 50, maxCostUsd: 20 },

  run: async (ctx) => {
    const { results, blackboard, processed } = await ctx.swarm<string, { module: string; migrated: boolean }>({
      workers: ctx.args.workers ?? 4,
      queue: { initial: ctx.args.seedModules, allowPush: true },
      worker: {
        isolation: "none", // workers share the repo; each item touches one module
        retries: 1,
        schema: MODULE_RESULT,
        instructions: "Use the blackboard tool to read shared conventions and append new ones. Use queue_push for newly discovered modules, or return them in newDependents. Finish each module with submit_result.",
        prompt: (module, board) =>
          `Migrate module ${module} from library A to B.\n\nBlackboard (shared conventions):\n${board}\n\n` +
          `If migrating this module requires other modules to migrate, list them in newDependents.`,
      },
      until: ({ processed }) => processed >= 200, // safety stop; the queue draining is the normal end
      phase: "Migrate",
    });

    ctx.log(`processed ${processed} modules`);
    return { results, blackboard };
  },
});
