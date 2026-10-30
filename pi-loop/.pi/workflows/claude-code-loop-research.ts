import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-durable";
import { defineWorkflow } from "@nothumanwork/pi-orchestration";

// Workflow agents get no MCP tools, so web access comes from these Exa-backed tools.
// The worker reads EXA_API_KEY from its environment; the key never enters a transcript.
type ExaResult = { url: string; title?: string; publishedDate?: string; text?: string };

async function exa(path: "search" | "contents", body: object, signal: AbortSignal | undefined) {
  const key = process.env.EXA_API_KEY;
  if (!key) throw new Error("EXA_API_KEY is not set in the workflow worker's environment.");
  const response = await fetch(`https://api.exa.ai/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) throw new Error(`Exa ${path} failed: ${response.status} ${await response.text()}`);
  const { results = [] } = (await response.json()) as { results?: ExaResult[] };
  const text = results.map(r =>
    `## ${r.title ?? r.url}\nURL: ${r.url}${r.publishedDate ? `\nPublished: ${r.publishedDate}` : ""}\n\n${r.text ?? ""}`,
  ).join("\n\n---\n\n");
  return { output: [{ type: "text" as const, text: text || "No results." }] };
}

function failed(error: unknown) {
  return { output: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true };
}

const webSearch = defineTool({
  name: "web_search",
  description: "Search the web. Returns titles, URLs, publication dates and the start of each page. Use web_fetch to read a page in full.",
  parameters: Type.Object({
    query: Type.String({ description: "A natural-language description of the page you want." }),
    numResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: "Default 6." })),
    includeDomains: Type.Optional(Type.Array(Type.String(), { description: "Only return results from these domains." })),
  }),
  replay: "safe", // read-only, so an interrupted call may rerun
  async execute({ query, numResults = 6, includeDomains }, _api, context) {
    try {
      return await exa("search", {
        query, numResults, type: "auto", includeDomains, contents: { text: { maxCharacters: 1500 } },
      }, context.abortSignal);
    } catch (error) { return failed(error); }
  },
});

const webFetch = defineTool({
  name: "web_fetch",
  description: "Read the full text of up to 5 web pages by URL.",
  parameters: Type.Object({
    urls: Type.Array(Type.String(), { minItems: 1, maxItems: 5 }),
    maxCharacters: Type.Optional(Type.Integer({ minimum: 1000, maximum: 60000, description: "Per page. Default 20000." })),
  }),
  replay: "safe",
  async execute({ urls, maxCharacters = 20_000 }, _api, context) {
    try {
      return await exa("contents", { urls, text: { maxCharacters } }, context.abortSignal);
    } catch (error) { return failed(error); }
  },
});

export default defineWorkflow({
  name: "claude-code-loop-research", // kebab-case; run it by this name
  description:
    "Plans web searches for a question, researches each in parallel with cited primary sources, then a judge " +
    "synthesizes the answer. With localPaths, the judge compares the findings against our code in those paths.",
  args: Type.Object({
    prompt: Type.String({ minLength: 1 }),
    localPaths: Type.Optional(Type.Array(Type.String(), {
      description: "Files or directories, relative to the run cwd, holding our implementation to compare against.",
    })),
    maxQueries: Type.Optional(Type.Integer({ minimum: 1, maximum: 15 })),
  }), // checked before the run starts
  tools: [webSearch, webFetch],
  budget: { maxAgents: 20, maxDurationMs: 3_600_000 }, // a cap; the code below decides how many agents run
  async run(ctx) {
    const { prompt, localPaths = [], maxQueries = 8 } = ctx.args;
    const ours = localPaths.length
      ? `Our implementation is in these paths, relative to ${ctx.cwd}: ${localPaths.join(", ")}.`
      : "";

    ctx.phase("Orchestrator");
    const plan = await ctx.agent(
      `Plan web research for this question: ${prompt}\n${ours}` +
      (ours ? " Read it first so the queries cover every dimension on which the two could differ.\n" : "\n") +
      `Write up to ${maxQueries} web search queries. Each targets one distinct facet, is specific enough to surface ` +
      `authoritative primary sources (official documentation, changelogs, source repositories), and does not overlap the others. ` +
      `Do not modify files.`,
      {
        label: "orchestrator",
        tools: ours ? ["read", "bash"] : [],
        schema: Type.Object({ queries: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }) }),
      },
    );
    const queries = [...new Set(plan.queries.map(q => q.trim()).filter(Boolean))].slice(0, maxQueries);
    ctx.log("Search queries", { queries });

    ctx.phase("Research");
    const research = await ctx.parallel(
      queries.map((searchQuery, i) => () =>
        ctx.agent(
          `You are researching one question for a larger report on: ${prompt}\n\nQuestion: ${searchQuery}\n\n` +
          `Use web_search to find sources and web_fetch to read them in full before relying on them. Prefer primary sources: ` +
          `official documentation, changelogs and release notes, source repositories and issue trackers. Use blogs, forums ` +
          `and articles only for leads or when no primary source exists, and say so.\n\n` +
          `Return a Markdown report that answers the question in depth:\n` +
          `- Cite the URL inline for every factual claim.\n` +
          `- Give versions and dates where sources state them, including behavior that changed between versions.\n` +
          `- Separate what sources state from your inferences; mark anything unverified, conflicting or undocumented.\n` +
          `- End with a Sources list.\n` +
          `Do not answer from memory alone.`,
          {
            label: `${i + 1}-${searchQuery.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48)}`,
            model: "xai/grok-4.7",
            tools: ["web_search", "web_fetch"],
          },
        ),
      ),
      { failure: "null" }, // one failed search should not sink the rest; failures stay visible in status
    );
    const reports = queries
      .map((query, i) => ({ query, report: research[i] }))
      .filter(r => r.report !== null);
    if (!reports.length) throw new Error("Every research branch failed.");

    ctx.phase("Judge");
    return ctx.agent(
      `Answer this research question: ${prompt}\n\n` +
      (ours ? `${ours} Read it yourself. The code is the source of truth for what we do; where our documentation disagrees ` +
        `with the code, say so.\n\n` : "") +
      `Below are ${reports.length} web research reports, one per search query. Keep claims backed by primary sources, ` +
      `flag weakly sourced or contradictory ones, and use web_fetch to check any claim the answer depends on that the ` +
      `reports disagree on or cite only secondhand.\n\n` +
      `Write the final answer in Markdown:\n` +
      (ours
        ? `1. Summary: the most important similarities and differences.\n` +
          `2. Comparison table: dimension | theirs | ours | same, different or partial. Cover every dimension the evidence supports.\n` +
          `3. Notable differences in detail. Cite URLs for external claims and file:line for ours.\n`
        : `1. Summary.\n2. Detailed answer, citing URLs for every claim.\n3. Comparison or analysis where the question calls for it.\n`) +
      `4. Open questions: anything undocumented, conflicting or unverified.\n5. Sources.\n` +
      `Do not modify files.\n\nReports:\n${JSON.stringify(reports)}`,
      {
        label: "judge",
        tools: ["read", "bash", "web_search", "web_fetch"],
        timeoutMs: 1_200_000,
      },
    );
  },
});
