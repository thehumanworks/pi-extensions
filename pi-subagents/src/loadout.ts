import { isAbsolute } from "node:path";
import {
  createCodemodeExtension,
  createToolSearchExtension,
  DefaultResourceLoader,
  getAgentDir,
  parseArgs,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionContext,
  type InlineExtension,
  type ToolInfo,
} from "@earendil-works/pi-coding-agent";

export const management = new Set(["subagent_delegate", "subagent_resume", "subagent_status"]);

export function accessible(pi: ExtensionAPI) {
  const active = new Set(pi.getActiveTools());
  return pi
    .getAllTools()
    .filter(
      (t) =>
        !management.has(t.name) &&
        t.exposure !== "hidden" &&
        (active.has(t.name) || t.exposure === "codemode" || t.exposure === "deferred"),
    );
}

/** Recreate the lead's configured extension hooks and model-facing tool routers in
 * a native worker session. Never start another task board inside that session. */
export async function resources(pi: ExtensionAPI, ctx: ExtensionContext, tools: ToolInfo[], prompt: string) {
  const args = parseArgs(process.argv.slice(2));
  const settingsManager = SettingsManager.inMemory(pi.getSettings(), {
    projectTrusted: ctx.isProjectTrusted(),
  });
  const builtin = (name: string, factory: ReturnType<typeof createCodemodeExtension>): InlineExtension => ({
    name,
    factory,
    builtin: true,
    replaceable: true,
  });
  const factories = [
    builtin("codemode", createCodemodeExtension()),
    builtin("tool-search", createToolSearchExtension()),
  ];
  const paths = new Set(args.extensions?.filter((p) => p !== "builtin:mcp"));
  for (const t of tools) {
    if (t.exposure !== "model-only") continue;
    const path = t.sourceInfo.path;
    if (isAbsolute(path) && /\.[cm]?[jt]s$/.test(path)) paths.add(path);
    if (["builtin:codemode", "builtin:tool-search"].includes(path)) paths.add(path);
  }
  const resourceLoader = new DefaultResourceLoader({
    cwd: ctx.cwd,
    agentDir: getAgentDir(),
    settingsManager,
    noExtensions: args.noExtensions,
    additionalExtensionPaths: [...paths],
    extensionFactories: factories,
    disabledBuiltinExtensions: ["mcp"],
    noSkills: true,
    noThemes: true,
    noPromptTemplates: true,
    noContextFiles: true,
    // The prompt is complete. Skip SYSTEM.md / APPEND_SYSTEM.md discovery and treat it as literal text.
    systemPrompt: "",
    appendSystemPrompt: [],
    systemPromptOverride: () => prompt,
    extensionsOverride(result) {
      return { ...result, extensions: result.extensions.filter((e) => !e.tools.has("subagent_delegate")) };
    },
  });
  await resourceLoader.reload();
  const loaded = resourceLoader.getExtensions();
  if (loaded.errors.length)
    throw new Error(
      "Worker extension load failed: " + loaded.errors.map((e) => e.path + ": " + e.error).join("; "),
    );
  for (const ext of loaded.extensions)
    for (const key of ext.flags.keys()) {
      const value = pi.getFlag(key);
      if (value !== undefined) loaded.runtime.flagValues.set(key, value);
    }
  return { resourceLoader, settingsManager };
}
