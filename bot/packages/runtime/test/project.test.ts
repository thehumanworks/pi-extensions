import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { initBot, loadProject, inspectBot, validateBot, invokeTool } from "../src/project.js";
import { modelRuntimeOptions } from "../src/runtime.js";
import { echoTool, fixture } from "./helpers.js";

test("v2 explicit empty selections, owned TS tools and imported code reload", async t => {
  const imported = `import {version} from '../lib/version.ts';\n${echoTool().replace('"v1"', 'version')}`;
  const f = await fixture({ tools: ["echo"], skills: [] }, { "tools/echo.ts": imported, "lib/version.ts": "export const version='v1';" }); t.after(f.cleanup);
  const p = await loadProject(join(f.source, "BOT.md"), { agentDir: f.agentDir });
  assert.equal(p.info.inherit, "none"); assert.equal(p.info.stateDir, join(f.source, ".bot")); assert.deepEqual(p.info.tools.map(t => t.name), ["echo"]);
  const context = { cwd: f.cwd, sourceDir: f.source, stateDir: p.info.stateDir, sessionId: "test", signal: new AbortController().signal };
  assert.match(JSON.stringify(await invokeTool(p.tools[0]!, { n: 3 }, context)), /v1:3/);
  await assert.rejects(invokeTool(p.tools[0]!, { n: "invalid" }, context), /validation|number|Invalid/i);
  await writeFile(join(f.source, "lib/version.ts"), "export const version='v2';");
  const next = await loadProject(f.source, { agentDir: f.agentDir }); assert.notEqual(next.info.revision, p.info.revision);
  assert.match(JSON.stringify(await invokeTool(next.tools[0]!, { n: 1 }, context)), /v2:1/);
  const bot = await readFile(join(f.source, "BOT.md"), "utf8"); await writeFile(join(f.source, "BOT.md"), bot.replace('["echo"]', "[]"));
  assert.deepEqual((await inspectBot(f.source, { agentDir: f.agentDir })).tools, []);
  await writeFile(join(f.source, "BOT.md"), bot.replace('tools: ["echo"]', "builtinTools: []\nmaintenance: false"));
  assert.deepEqual((await inspectBot(f.source, { agentDir: f.agentDir })).tools.map(t => t.name), ["bot_history", "echo"]);
});

test("scaffold is non-destructive and explicitly declares autonomous self-maintenance", async t => {
  const f = await fixture(); t.after(f.cleanup);
  const original = await readFile(join(f.source, "BOT.md"), "utf8");
  await initBot(f.source, { prompt: "Do not overwrite" }); assert.equal(await readFile(join(f.source, "BOT.md"), "utf8"), original);
  const newSource = join(f.root, "newbot"); const info = await initBot(newSource);
  assert(info.tools.some(t => t.name === "bot_write")); assert.equal(info.inherit, "none"); assert.equal(info.format, 2);
  assert.match(await readFile(join(newSource, ".bot/MEMORY.md"), "utf8"), /200/);
});

test("global resources are opt-in and never use cwd .pi", async t => {
  const f = await fixture({}, { "tools/echo.ts": echoTool("local") }); t.after(f.cleanup);
  await mkdir(join(f.agentDir, "extensions")); await writeFile(join(f.agentDir, "extensions/global.ts"), `import {Type} from 'typebox'; export default pi=>pi.registerTool({name:'global_tool',description:'global',parameters:Type.Object({}),execute:async()=>({content:[{type:'text',text:'global'}],details:undefined})});`);
  await mkdir(join(f.cwd, ".pi/extensions"), { recursive: true }); await writeFile(join(f.cwd, ".pi/extensions/evil.ts"), "throw new Error('must not load workspace code')");
  let p = await loadProject(f.source, { agentDir: f.agentDir }); assert.deepEqual(p.tools.map(t => t.name), ["bot_history", "echo"]);
  const bot = await readFile(join(f.source, "BOT.md"), "utf8"); await writeFile(join(f.source, "BOT.md"), bot.replace("format: 2", 'format: 2\ninherit: global'));
  p = await loadProject(f.source, { agentDir: f.agentDir }); assert(p.tools.some(t => t.name === "global_tool")); assert(!p.tools.some(t => t.name === "evil"));
});

test("duplicate/unknown tools, unsupported APIs and connections fail rather than partially load", async t => {
  const f = await fixture({ tools: ["missing"] }); t.after(f.cleanup);
  await assert.rejects(validateBot(f.source, { agentDir: f.agentDir }), /Unknown required selected tools/);
  await mkdir(join(f.source, "extensions")); await writeFile(join(f.source, "extensions/bad.ts"), `export default pi=>{try{pi.on('session_start',()=>{})}catch{};}`);
  await assert.rejects(loadProject(f.source, { agentDir: f.agentDir }), /Unsupported classic Pi extension API pi.on/);
  await writeFile(join(f.source, "extensions/bad.ts"), `export default {name:'empty',tools:[]}`);
  await mkdir(join(f.source, "connections")); await writeFile(join(f.source, "connections/mcp.ts"), "export default {}");
  await assert.rejects(loadProject(f.source, { agentDir: f.agentDir }), /Unsupported connections/);
});

test("unversioned definitions use current semantics and state/auth paths remain separate", async t => {
  const f = await fixture(); t.after(f.cleanup);
  const p = await loadProject(f.source, { agentDir: f.agentDir });
  assert.equal(p.info.format, 2); assert.equal(p.info.stateDir, join(f.source, ".bot"));
  await writeFile(join(f.source, "BOT.md"), "---\nname: old\ndescription: no format\n---\n\nPersona\n");
  const unversioned = await loadProject(f.source, { agentDir: f.agentDir });
  assert.equal(unversioned.info.format, 2);
  assert.equal(unversioned.info.stateDir, join(f.source, ".bot"));
  assert.equal(unversioned.definition.inherit, "none");
  assert.deepEqual(modelRuntimeOptions(f.agentDir), { authPath: join(f.agentDir, "auth.json"), modelsPath: join(f.agentDir, "models.json"), modelsStorePath: join(f.agentDir, "models-store.json"), allowModelNetwork: false });
});
