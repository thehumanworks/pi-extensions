import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxProvider, type FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import { AgentStore } from "../src/store.ts";

export async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pi-agent-test-"));
  const agentDir = join(root, "config");
  const cwd = join(root, "workspace");
  await Promise.all([mkdir(agentDir), mkdir(cwd)]);
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "faux", defaultModel: "faux-1", cacheWarming: { mode: "off" }, retry: { enabled: false } }));
  const store = new AgentStore(join(root, "agents"), agentDir);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, agentDir, cwd, store };
}
export function definition(name = "tester", extra = "", prompt = "Test specialist persona.") {
  return `---\nname: ${name}\ndescription: Tests code\n${extra}\n---\n\n${prompt}\n`;
}
export async function scripted(agentDir: string, responses: FauxResponseStep[]) {
  const faux = fauxProvider({ tokensPerSecond: 100000 });
  faux.setResponses(responses);
  const models = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, modelsStorePath: join(agentDir, "catalog.json"), refreshOnCreate: false });
  models.registerNativeProvider(faux.provider);
  await models.refresh({ allowNetwork: false });
  return { faux, models };
}
