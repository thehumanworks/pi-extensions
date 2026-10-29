import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, type FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";

export async function fixture(fields: Record<string, unknown> = {}, files: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), "bot-sdk-test-"));
  const source = join(root, "bot"); const agentDir = join(root, "agent"); const cwd = join(root, "workspace");
  await Promise.all([mkdir(source), mkdir(agentDir), mkdir(cwd)]);
  const definition = { inherit: "none", name: "tester", description: "Test bot", model: "faux/faux-1", ...fields };
  await writeFile(join(source, "BOT.md"), `---\n${Object.entries(definition).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n")}\n---\n\nTest persona.\n`);
  for (const [path, content] of Object.entries(files)) { const target = join(source, path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, content); }
  return { root, source, agentDir, cwd, cleanup: () => rm(root, { recursive: true, force: true }) };
}
export function scripted(responses: FauxResponseStep[], tokensPerSecond = 100000) {
  const faux = fauxProvider({ tokensPerSecond }); const models = createModels(); models.setProvider(faux.provider); faux.setResponses(responses);
  return { faux, models };
}
export const echoTool = (text = "v1", name = "echo") => `import {defineTool, Type} from '@nothumanwork/bot';
export default defineTool({name:${JSON.stringify(name)}, description:'echo', parameters:Type.Object({n:Type.Number()}), replay:'safe', execute:async(args,ctx)=>({content:[{type:'text',text:${JSON.stringify(text)}+':'+args.n+':'+ctx.cwd}],details:{n:args.n}})});`;
export async function eventually<T>(read: () => Promise<T>, predicate: (value: T) => boolean, timeout = 5000): Promise<T> {
  const until = Date.now() + timeout;
  while (true) { const value = await read(); if (predicate(value)) return value; if (Date.now() > until) throw new Error(`Timed out: ${JSON.stringify(value)}`); await new Promise(resolve => setTimeout(resolve, 10)); }
}
