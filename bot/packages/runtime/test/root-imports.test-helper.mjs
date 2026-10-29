// Run against the published JavaScript graph, with no tsx loader and an unrelated cwd.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as sdk from "../dist/index.js";
import { connectBot } from "../dist/client.js";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { Compile } from "typebox/compile";
const [source, peer, agentDir, key] = process.argv.slice(2);
globalThis[Symbol.for(key)] = { ...sdk, connectBot, createModels, fauxProvider, Compile };
const context = { cwd: process.cwd(), sourceDir: source, stateDir: join(source, ".bot"), sessionId: "compiled", signal: new AbortController().signal };
const input = { peer, agentDir, delegate: false };
let project = await sdk.loadBot(source, { agentDir });
const first = await sdk.invokeTool(project.tools.find(t => t.name === "inspect_peer"), input, context);
assert.match(JSON.stringify(first), /generation-one/);
const helper = join(source, "lib/version.ts");
const original = await readFile(helper, "utf8");
try {
  await writeFile(helper, original.replace("generation-one", "generation-two"));
  const next = await sdk.loadBot(source, { agentDir });
  assert.notEqual(next.info.revision, project.info.revision);
  const second = await sdk.invokeTool(next.tools.find(t => t.name === "inspect_peer"), { ...input, delegate: true }, context);
  assert.match(JSON.stringify(second), /generation-two/);
  assert.match(JSON.stringify(second), /peer reply/);
  for (const name of ["esm_root", "cjs_root"]) {
    const result = await sdk.invokeTool(next.tools.find(t => t.name === name), { peer, agentDir }, context);
    assert.match(JSON.stringify(result), /peer/);
  }
  console.log(JSON.stringify({ first, second, mode: "compiled" }));
} finally { await writeFile(helper, original); }
