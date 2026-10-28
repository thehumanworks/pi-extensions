import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as sdk from "../src/index.js";
import { connectBot } from "../src/client.js";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { Compile } from "typebox/compile";
import { fixture, scripted } from "./helpers.js";

function inspectorTool(key: string) {
  return `import {defineTool,Type,inspectBot,openBot,listBots} from '@nothumanwork/bot';
import {connectBot} from '@nothumanwork/bot/client';
import {createModels} from '@earendil-works/pi-ai/models';
import {fauxProvider,fauxAssistantMessage} from '@earendil-works/pi-ai/providers/faux';
import {Compile} from 'typebox/compile';
import {version} from '../lib/version.ts';
const host=globalThis[Symbol.for(${JSON.stringify(key)})];
for (const [name,value] of Object.entries({defineTool,Type,inspectBot,openBot,listBots,connectBot,createModels,fauxProvider,Compile})) {
  if(value !== host[name]) throw new Error('Native singleton identity changed: '+name);
}
export default defineTool({name:'inspect_peer',description:'Inspect or delegate to a peer',parameters:Type.Object({peer:Type.String(),agentDir:Type.String(),delegate:Type.Boolean()}),execute:async(args,ctx)=>{
  const info=await inspectBot(args.peer,{agentDir:args.agentDir});
  if(!Compile(Type.String()).Check(info.name))throw new Error('schema check failed');
  let reply='not delegated';
  if(args.delegate){
    const faux=fauxProvider({tokensPerSecond:100000});const models=createModels();models.setProvider(faux.provider);faux.setResponses([fauxAssistantMessage('peer reply '+version)]);
    const peer=await openBot(args.peer,{models,agentDir:args.agentDir,cwd:ctx.cwd});
    try{const result=await peer.run('respond');if(result.status!=='completed')throw new Error(result.error);reply=result.output;}finally{await peer.close();}
  }
  return {name:info.name,version,reply,nativeSdk:true};
}});`;
}

async function importFixture() {
  const f = await fixture({ tools: ["inspect_peer", "esm_root", "cjs_root"] });
  const key = `root-sdk-imports:${f.root}`;
  Reflect.set(globalThis, Symbol.for(key), { ...sdk, connectBot, createModels, fauxProvider, Compile });
  await mkdir(join(f.source, "tools")); await mkdir(join(f.source, "lib"));
  await writeFile(join(f.source, "tools/inspect_peer.ts"), inspectorTool(key));
  await writeFile(join(f.source, "lib/version.ts"), "export const version='generation-one';");
  await writeFile(join(f.source, "tools/esm_root.mjs"), `import {defineTool,Type,inspectBot} from '@nothumanwork/bot';export default defineTool({name:'esm_root',description:'ESM root',parameters:Type.Object({peer:Type.String(),agentDir:Type.String()}),execute:async args=>(await inspectBot(args.peer,{agentDir:args.agentDir})).name});`);
  await writeFile(join(f.source, "tools/cjs_root.cjs"), `const {defineTool,Type,inspectBot}=require('@nothumanwork/bot');module.exports=defineTool({name:'cjs_root',description:'CJS root',parameters:Type.Object({peer:Type.String(),agentDir:Type.String()}),execute:async args=>(await inspectBot(args.peer,{agentDir:args.agentDir})).name});`);
  const peer = join(f.root, "peer"); await mkdir(peer);
  await writeFile(join(peer, "BOT.md"), '---\nname: peer\ndescription: Scripted peer\nmodel: faux/faux-1\ntools: []\nskills: []\n---\n\nPeer persona.\n');
  return { ...f, peer, key, cleanup: async () => { Reflect.deleteProperty(globalThis, Symbol.for(key)); await f.cleanup(); } };
}

test("authored SDK root imports share native functions while generations stay fresh", async t => {
  const f = await importFixture(); t.after(f.cleanup);
  const project = await sdk.loadBot(f.source, { agentDir: f.agentDir });
  const context = { cwd: f.cwd, sourceDir: f.source, stateDir: project.info.stateDir, sessionId: "native", signal: new AbortController().signal };
  const args = { peer: f.peer, agentDir: f.agentDir, delegate: false };
  const first = await sdk.invokeTool(project.tools.find(t => t.name === "inspect_peer")!, args, context); assert.match(JSON.stringify(first), /generation-one/);
  await writeFile(join(f.source, "lib/version.ts"), "export const version='generation-two';");
  const next = await sdk.loadBot(f.source, { agentDir: f.agentDir }); assert.notEqual(next.info.revision, project.info.revision);
  const second = await sdk.invokeTool(next.tools.find(t => t.name === "inspect_peer")!, { ...args, delegate: true }, context);
  assert.match(JSON.stringify(second), /peer reply generation-two/);
  for (const name of ["esm_root", "cjs_root"]) assert.match(JSON.stringify(await sdk.invokeTool(next.tools.find(t => t.name === name)!, args, context)), /peer/);
});

test("compiled SDK root and subpaths work without cwd packages or a TS host loader", async t => {
  const f = await importFixture(); t.after(f.cleanup);
  const child = await promisify(execFile)(process.execPath, [fileURLToPath(new URL("./root-imports.test-helper.mjs", import.meta.url)), f.source, f.peer, f.agentDir, f.key], { cwd: f.cwd, timeout: 30000 });
  assert.match(child.stdout, /"mode":"compiled"/); assert.match(child.stdout, /peer reply generation-two/);
});

test("skill files/assets refer to isolated and restored source generations", async t => {
  const f = await fixture({ tools: [], skills: ["local"] }, { "skills/local/SKILL.md": "---\nname: local\ndescription: Skill with local assets\n---\nRead asset.txt relative to this skill.\n", "skills/local/asset.txt": "pinned asset" }); t.after(f.cleanup);
  const { models } = scripted([]);
  let bot = await sdk.openBot(f.source, { models, agentDir: f.agentDir, ephemeral: true });
  let file = (await bot.info()).skills[0]!.source;
  assert(file.startsWith(bot.sourceDir + "/")); assert.equal(await readFile(join(dirname(file), "asset.txt"), "utf8"), "pinned asset");
  const isolated = await sdk.loadBot(bot.sourceDir, { agentDir: f.agentDir, stateDir: bot.stateDir }); assert(isolated.prompt.includes(file)); await bot.close();
  bot = await sdk.openBot(f.source, { models, agentDir: f.agentDir }); const revision = (await bot.info()).revision; await bot.close();
  await writeFile(join(f.source, "BOT.md"), "invalid draft"); await writeFile(join(f.source, "skills/local/asset.txt"), "unvalidated live asset");
  bot = await sdk.openBot(f.source, { models, agentDir: f.agentDir }); t.after(() => bot.close());
  file = (await bot.info()).skills[0]!.source;
  assert.equal(file, join(bot.stateDir, "revisions", revision, "source/skills/local/SKILL.md"));
  assert.equal(await readFile(join(dirname(file), "asset.txt"), "utf8"), "pinned asset");
});
