/** Pi 1.4's public SDK exports the runtime, but not its config/loader helpers.
 * Keep the version-pinned internal imports in one place; never reimplement MCP parsing.
 */
import type { ExtensionFactory, LoadExtensionsResult, LoadedMcpConfig, McpExtensionOptions, EventBus } from "@earendil-works/pi-coding-agent";
const buses = new WeakMap<LoadExtensionsResult, EventBus>();
const base = import.meta.resolve("@earendil-works/pi-coding-agent");
const internal = (path: string) => import(new URL(path, base).href);
export async function readUserMcp(agentDir: string): Promise<LoadedMcpConfig> {
  const { loadMcpConfig } = await internal("./extensions/mcp/config.js");
  return loadMcpConfig({ agentDir, cwd: agentDir, projectTrusted: false });
}
export async function loadPiExtensions(paths: string[], cwd: string, factories: ExtensionFactory[], excludeServers: string[] = []): Promise<LoadExtensionsResult> {
  const { loadExtensions, loadExtensionFromFactory } = await internal("./core/extensions/loader.js");
  const { createEventBus, createExtensionRuntime } = await import("@earendil-works/pi-coding-agent");
  const bus = createEventBus();
  const runtime = createExtensionRuntime();
  const register = runtime.mcpServers.register.bind(runtime.mcpServers);
  runtime.mcpServers.register = server => { if (!matches(server.name, excludeServers)) register(server); };
  const loaded: LoadExtensionsResult = await loadExtensions(paths, cwd, bus, runtime);
  buses.set(loaded, bus);
  for (const [index, factory] of factories.entries()) loaded.extensions.push(await loadExtensionFromFactory(factory, cwd, bus, loaded.runtime, `bot:runtime:${index}`));
  return loaded;
}
export async function mcpCredentials(agentDir: string): Promise<NonNullable<McpExtensionOptions["credentials"]>> {
  const { join } = await import("node:path");
  const [{ McpOAuthCredentialStore }, { FileAuthStorageBackend }] = await Promise.all([internal("./extensions/mcp/oauth.js"), internal("./core/auth-storage.js")]);
  return new McpOAuthCredentialStore(new FileAuthStorageBackend(join(agentDir, "mcp-auth.json")), agentDir);
}
/** Exact names or '*' wildcards, consistently used for bot exclusions. */
export function matches(name: string, patterns: readonly string[] = []): boolean {
  return patterns.some(pattern => new RegExp(`^${pattern.split("*").map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(name));
}
export async function appendPiFactories(loaded: LoadExtensionsResult, cwd: string, factories: ExtensionFactory[]): Promise<void> {
  const { loadExtensionFromFactory } = await internal("./core/extensions/loader.js");
  const bus = buses.get(loaded);
  if (!bus) throw new Error("Extension runtime event bus is unavailable");
  for (const factory of factories) loaded.extensions.push(await loadExtensionFromFactory(factory, cwd, bus, loaded.runtime, `bot:runtime:${loaded.extensions.length}`));
}
