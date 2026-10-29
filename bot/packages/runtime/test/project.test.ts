import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { initBot, loadProject, inspectBot, validateBot, invokeTool } from "../src/project.js";
import { modelRuntimeOptions } from "../src/runtime.js";
import { echoTool, fixture } from "./helpers.js";

test("explicit empty selections, owned TS tools and imported code reload", async t => {
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
  assert(info.tools.some(t => t.name === "bot_write")); assert.equal(info.inherit, "global"); assert.equal("format" in info, false);
  assert.doesNotMatch(await readFile(join(newSource, "BOT.md"), "utf8"), /^(format|version):/m);
  assert.match(await readFile(join(newSource, ".bot/MEMORY.md"), "utf8"), /200/);
});

test("explicit inherit none opts out; global discovery never uses cwd .pi", async t => {
  const f = await fixture({}, { "tools/echo.ts": echoTool("local") }); t.after(f.cleanup);
  await mkdir(join(f.agentDir, "extensions")); await writeFile(join(f.agentDir, "extensions/global.ts"), `import {Type} from 'typebox'; export default pi=>pi.registerTool({name:'global_tool',description:'global',parameters:Type.Object({}),execute:async()=>({content:[{type:'text',text:'global'}],details:undefined})});`);
  await mkdir(join(f.cwd, ".pi/extensions"), { recursive: true }); await writeFile(join(f.cwd, ".pi/extensions/evil.ts"), "throw new Error('must not load workspace code')");
  let p = await loadProject(f.source, { agentDir: f.agentDir }); assert.deepEqual(p.tools.map(t => t.name), ["bot_history", "echo"]);
  const bot = await readFile(join(f.source, "BOT.md"), "utf8"); await writeFile(join(f.source, "BOT.md"), bot.replace('inherit: "none"', 'inherit: "global"'));
  p = await loadProject(f.source, { agentDir: f.agentDir }); assert(p.extensionPaths.some(path => path.endsWith("global.ts"))); assert(!p.extensionPaths.some(path => path.endsWith("evil.ts")));
});

test("duplicate/unknown tools, unsupported APIs and connections fail rather than partially load", async t => {
  const f = await fixture({ tools: ["missing"] }); t.after(f.cleanup);
  await assert.rejects(validateBot(f.source, { agentDir: f.agentDir }), /Unknown required selected tools/);
  await mkdir(join(f.source, "extensions")); await writeFile(join(f.source, "extensions/bad.ts"), `export default pi=>{try{pi.on('session_start',()=>{})}catch{};}`);
  assert((await loadProject(f.source, { agentDir: f.agentDir })).native);
  await writeFile(join(f.source, "extensions/bad.ts"), `export default {name:'empty',tools:[]}`);
  await mkdir(join(f.source, "connections")); await writeFile(join(f.source, "connections/mcp.ts"), "export default {}");
  await assert.rejects(loadProject(f.source, { agentDir: f.agentDir }), /Unsupported connections/);
});

test("ordinary BOT.md loads without a format/version field and state/auth paths remain separate", async t => {
  const f = await fixture(); t.after(f.cleanup);
  await writeFile(join(f.source, "BOT.md"), "---\nname: ordinary\ndescription: Plain definition\n---\n\nPersona\n");
  const p = await loadProject(f.source, { agentDir: f.agentDir });
  assert.equal(p.info.name, "ordinary"); assert.equal(p.info.stateDir, join(f.source, ".bot"));
  assert.equal(p.info.inherit, "global"); assert.equal(p.definition.prompt, "Persona");
  assert.deepEqual(p.definition.extra, {});
  assert.deepEqual(modelRuntimeOptions(f.agentDir), { authPath: join(f.agentDir, "auth.json"), modelsPath: join(f.agentDir, "models.json"), modelsStorePath: join(f.agentDir, "models-store.json"), allowModelNetwork: false });
});

test("default scaffolds honor user-global defaultTools without pinning inheritance or builtins", async t => {
  const f = await fixture(); t.after(f.cleanup);
  // initBot has no agentDir option; its inspection still uses Pi's process-level
  // user directory. Do not silently change that API while changing scaffold defaults.
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = f.agentDir;
  try {
    await writeFile(join(f.agentDir, "settings.json"), JSON.stringify({ defaultTools: ["read", "grep"] }));
    const source = join(f.root, "default-scaffold");
    const info = await initBot(source);
    const definition = await readFile(join(source, "BOT.md"), "utf8");
    assert.doesNotMatch(definition, /^inherit:|^builtinTools:/m);
    assert.equal(info.inherit, "global");
    assert.deepEqual(info.tools.filter(tool => tool.source === "pi:builtin").map(tool => tool.name), ["read", "grep"]);
    assert(info.tools.some(tool => tool.name === "bot_write"));
    await writeFile(join(f.agentDir, "settings.json"), JSON.stringify({ defaultTools: ["ls"] }));
    assert.deepEqual((await inspectBot(source)).tools.filter(tool => tool.source === "pi:builtin").map(tool => tool.name), ["ls"]);

    const isolatedSource = join(f.root, "isolated-scaffold");
    const isolated = await initBot(isolatedSource, { inherit: "none" });
    assert.equal(isolated.inherit, "none");
    assert.match(await readFile(join(isolatedSource, "BOT.md"), "utf8"), /^inherit: "none"$/m);
    assert.deepEqual(isolated.tools.filter(tool => tool.source === "pi:builtin").map(tool => tool.name), ["read", "bash", "edit", "write"]);
    assert.equal((await loadProject(isolatedSource)).native, false);

    const explicitSource = join(f.root, "explicit-global-scaffold");
    await initBot(explicitSource, { inherit: "global" });
    const explicit = await readFile(join(explicitSource, "BOT.md"), "utf8");
    assert.match(explicit, /^inherit: "global"$/m); assert.doesNotMatch(explicit, /^builtinTools:/m);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});
