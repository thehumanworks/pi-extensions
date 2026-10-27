// DAG via the `dag` recipe (a small function over ctx.parallel): nodes run as soon as their dependencies are done.
// Use when stages have a partial order (e.g. research → outline → sections → merge) and some are independent.
import { Type, type Static } from "typebox";
import { defineWorkflow } from "@nothumanwork/pi-orchestration";
import { dag } from "@nothumanwork/pi-orchestration/recipes";

const OUTLINE = Type.Object({ sections: Type.Array(Type.Object({ id: Type.String(), heading: Type.String(), brief: Type.String() })) });

export default defineWorkflow({
  name: "dag-report",
  description: "Research a topic from several angles, outline, write sections in parallel, merge",
  args: Type.Object({ topic: Type.String() }),

  run: async (ctx) => {
    const results = await dag(ctx, {
      // Independent research angles start together.
      web: { run: () => ctx.agent(`Research "${ctx.args.topic}" using available shell/network tools and public URLs; no browser or MCP tools are inherited. Return findings with URLs, and state if network access is unavailable.`, { label: "research:web" }) },
      repo: { run: () => ctx.agent(`Research how "${ctx.args.topic}" is handled in this repository; cite files.`, { label: "research:repo", tools: ["read", "bash"] }) },

      // Outline depends on both.
      outline: {
        dependsOn: ["web", "repo"],
        run: (deps) =>
          ctx.agent(`Outline a report on "${ctx.args.topic}" using:\n\n${deps.web}\n\n${deps.repo}`, { label: "outline", schema: OUTLINE }),
      },

      // Sections fan out dynamically from the outline (a nested parallel inside a node is fine; keys stay structural).
      sections: {
        dependsOn: ["outline"],
        run: async (deps) => {
          const outline = deps.outline as Static<typeof OUTLINE>;
          // A report with a missing section is not useful, so one failed section stops the rest.
          return ctx.parallel(outline.sections.map((s) => () => ctx.agent(`Write section "${s.heading}": ${s.brief}`, { label: `section:${s.id}`, phase: "Write" })), { failure: "failFast" });
        },
      },

      merge: {
        dependsOn: ["sections", "outline"],
        run: (deps) => ctx.agent(`Merge these sections into one coherent Markdown report:\n${JSON.stringify(deps.sections)}`, { label: "merge" }),
      },
    });

    return results.merge;
  },
});
