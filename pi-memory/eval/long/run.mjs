import { readFile,writeFile,mkdir,readdir,mkdtemp,cp,rm,stat,realpath } from 'node:fs/promises';
import { spawn,execFileSync } from 'node:child_process';
import { createHash,randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname,join,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import { fixtures,common,model as fixtureModel } from './fixtures.mjs';

const here=dirname(fileURLToPath(import.meta.url)),extension=resolve(here,'../../index.ts');
const option=(name,fallback)=>process.argv.find(arg=>arg.startsWith(`--${name}=`))?.slice(name.length+3)??fallback;
if(process.argv.includes('--help')){console.log('Usage: node --import tsx eval/long/run.mjs --mode=init|history|run --state=DIR [--out=DIR] [--arms=off,short,empty,long,dream] [--repeats=2] [--project=ingestion|migration] [--wall-seconds=600] [--requests=16] [--concurrency=2] [--model=provider/id] [--memory-env=KEY=VALUE;KEY2=VALUE2]. Requests are capped per stage; stage2 shares a cap across temporary and revoke turns. --model applies to action sessions only; captured history keeps its own model. --memory-env passes PI_MEMORY_* overrides to memory arms so candidates can be compared under one source snapshot.');process.exit(0);}
const allowedOptions=new Set(['mode','state','out','arms','repeats','project','wall-seconds','requests','concurrency','exclude-ids','empty-repeats','repair-only-from','model','memory-env']);const seenOptions=new Set();
for(const arg of process.argv.slice(2)){const match=/^--([^=]+)=(.+)$/.exec(arg);if(!match||!allowedOptions.has(match[1])||seenOptions.has(match[1]))throw new Error(`Unknown, empty or duplicate option: ${arg}`);seenOptions.add(match[1]);}
const mode=option('mode','run'),state=resolve(option('state',join(here,'state'))),out=resolve(option('out',join(here,'results',new Date().toISOString().replace(/[:.]/g,'-'))));
const arms=option('arms','off,short,empty,long,dream').split(','),repeats=Number(option('repeats','2')),wallSeconds=Number(option('wall-seconds','600')),requestLimit=Number(option('requests','16')),concurrency=Number(option('concurrency','2'));
const selected=fixtures.filter(f=>!option('project','')||f.id===option('project',''));
if(!['init','history','run'].includes(mode)||!selected.length||arms.some(arm=>!['off','short','empty','long','dream','polluted'].includes(arm))||!Number.isInteger(repeats)||repeats<1||repeats>3||!Number.isFinite(wallSeconds)||wallSeconds<30||wallSeconds>600||!Number.isInteger(requestLimit)||requestLimit<4||requestLimit>48||![1,2].includes(concurrency))throw new Error('Invalid run options');
const repairOnlyFrom=option('repair-only-from','');
const model=option('model',fixtureModel);
if(!/^[^/\s]+\/[^\s]+$/.test(model))throw new Error('Model must be provider/id');
const memoryEnv=Object.fromEntries(option('memory-env','').split(';').filter(Boolean).map(pair=>{const match=/^(PI_MEMORY_[A-Z_]+)=(.*)$/.exec(pair);if(!match)throw new Error(`memory-env entries must be PI_MEMORY_*=value: ${pair}`);return[match[1],match[2]];}));
// Provider extensions are disabled by --no-extensions; load the Claude bridge explicitly when its provider is selected.
const providerExtensions=[];
if(model.startsWith('claude-bridge/')){const bridge=resolve(process.env.HOME??'','.pi/agent/npm/node_modules/pi-claude-bridge');await stat(bridge);providerExtensions.push('-e',bridge);}
if(arms.includes('polluted')&&!repairOnlyFrom)throw new Error('Polluted arm requires a fixed --repair-only-from stage2 snapshot root');
const fixtureHash=createHash('sha256').update(await readFile(join(here,'fixtures.mjs'))).update(await readFile(join(here,'check.mjs'))).digest('hex');
const protocolHash=createHash('sha256').update(await readFile(join(here,'run.mjs'))).update(await readFile(join(here,'guard.ts'))).digest('hex');
const base=join(state,'captured-memory');
const minimalEnv={PATH:process.env.PATH??'/usr/bin:/bin',NODE_NO_WARNINGS:'1'};

async function materialize(fixture,cwd,history=false){
  await mkdir(cwd,{recursive:true});
  for(const [name,text]of Object.entries(fixture.files)){
    if(!history&&name==='tools/probe.mjs')continue;
    await mkdir(dirname(join(cwd,name)),{recursive:true});await writeFile(join(cwd,name),text);
  }
  execFileSync('git',['init','-q'],{cwd,stdio:'ignore'});
  execFileSync('git',['remote','add','origin',fixture.remote],{cwd,stdio:'ignore'});
}
function invoke(args,{cwd,env,timeoutMs}){
  return new Promise(done=>{
    const started=Date.now(),child=spawn('pi',args,{cwd,env,stdio:['ignore','pipe','pipe']});let stdout='',stderr='',timedOut=false;
    const timer=setTimeout(()=>{timedOut=true;child.kill('SIGTERM');setTimeout(()=>child.kill('SIGKILL'),1000).unref();},Math.max(1,timeoutMs));
    child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);child.on('error',error=>stderr+=error.message);
    child.on('close',(exitCode,signal)=>{clearTimeout(timer);done({stdout,stderr,exitCode,signal,timedOut,latencyMs:Date.now()-started});});
  });
}
const parseEvents=text=>text.split('\n').flatMap(line=>{try{return[JSON.parse(line)];}catch{return[];}});
const textContent=message=>(message?.content??[]).filter(part=>part.type==='text').map(part=>part.text).join('\n');
async function piCall({name,cwd,memoryDir,sessionId,sessions,prompt,recentContext='',memory,capture=false,tools=true,budget,actionTrace,artifactDir,timeoutMs=180000}){
  await mkdir(artifactDir,{recursive:true});await mkdir(sessions,{recursive:true});
  const trace=join(artifactDir,`${name}.memory.jsonl`);
  const args=['--no-extensions',...providerExtensions,'-e',join(here,'guard.ts'),'--no-skills','--no-prompt-templates','--no-context-files','--no-mcp','--model',model,'--thinking','low','--mode','json','--session-dir',sessions,'--session-id',sessionId];
  if(tools)args.push('--append-system-prompt',common);
  if(recentContext)args.push('--append-system-prompt',recentContext);
  if(tools)args.push('--tools','read,write,edit,bash,find,grep,ls');else args.push('--no-tools');
  if(memory)args.push('-e',extension,'--memory-dir',memoryDir,'--memory-mode','inject');
  args.push('-p',prompt);
  const execution=await invoke(args,{cwd,timeoutMs,env:{...process.env,PI_MEMORY_DISABLED:memory?'0':'1',PI_MEMORY_DIR:memoryDir,PI_MEMORY_CAPTURE:capture?'1':'0',PI_MEMORY_MODEL:model,PI_MEMORY_RETRIEVAL_MODEL:'off',PI_MEMORY_STRATEGY:'improved',PI_MEMORY_TOKEN_BUDGET:'1200',PI_MEMORY_DIGEST_BUDGET:'0',PI_MEMORY_DREAM:'0',...(capture?{}:memoryEnv),PI_MEMORY_TRACE:trace,PI_LONG_NODE:process.execPath,PI_LONG_CALL_NAME:name,PI_LONG_BUDGET:budget,PI_LONG_MAX_REQUESTS:String(requestLimit),PI_LONG_ACTION_TRACE:actionTrace}});
  await writeFile(join(artifactDir,`${name}.events.jsonl`),execution.stdout);await writeFile(join(artifactDir,`${name}.stderr.txt`),execution.stderr);
  const events=parseEvents(execution.stdout),messages=events.filter(event=>event.type==='message_end'&&event.message?.role==='assistant').map(event=>event.message);
  const usage=messages.reduce((sum,message)=>{for(const key of['input','output','cacheRead','cacheWrite','reasoning','totalTokens'])sum[key]=(sum[key]??0)+(message.usage?.[key]??0);sum.cost=(sum.cost??0)+(message.usage?.cost?.total??0);return sum;},{});
  const finalText=textContent(messages.at(-1));
  const result={name,prompt,exitCode:execution.exitCode,timedOut:execution.timedOut,budgetExhausted:execution.exitCode===86,latencyMs:execution.latencyMs,modelRequests:messages.length,usage,finalText};
  await writeFile(join(artifactDir,`${name}.run.json`),JSON.stringify(result,null,2)+'\n');
  return result;
}
async function evaluate(fixture,cwd,stage,artifactDir){
  let result;
  try{
    const text=execFileSync(process.execPath,['--permission',`--allow-fs-read=${cwd}`,`--allow-fs-write=${cwd}`,`--allow-fs-read=${join(here,'check.mjs')}`,join(here,'check.mjs'),fixture.id,cwd,String(stage)],{cwd,env:minimalEnv,encoding:'utf8',timeout:15000,maxBuffer:2*1024*1024});
    result=JSON.parse(text.trim().split('\n').at(-1));
  }catch(error){result={project:fixture.id,stage,checks:[],categoryScores:{intrinsic:0,memory:0,action:0},complete:false,error:error.message};}
  await writeFile(join(artifactDir,`stage-${stage}.checks.json`),JSON.stringify(result,null,2)+'\n');
  return result;
}
async function snapshot(cwd,destination){
  await cp(cwd,destination,{recursive:true,filter:source=>!source.split('/').includes('.git')&&!source.split('/').some(part=>part.startsWith('.acceptance-'))});
}
async function sizeTree(root){
  let bytes=0,files=0;try{for(const entry of await readdir(root,{withFileTypes:true})){const path=join(root,entry.name);if(entry.isDirectory()){const child=await sizeTree(path);bytes+=child.bytes;files+=child.files;}else if(entry.isFile()){bytes+=(await stat(path)).size;files++;}}}catch(error){if(error.code!=='ENOENT')throw error;}return{bytes,files};
}
async function memoryMetadata(root){
  const items=[];try{for(const entry of await readdir(root,{withFileTypes:true})){const path=join(root,entry.name);if(entry.isDirectory())items.push(...await memoryMetadata(path));else if(entry.isFile()&&entry.name.startsWith('m_')&&entry.name.endsWith('.md')){const text=await readFile(path,'utf8'),match=/^---\n([\s\S]*?)\n---\n/.exec(text);if(match)try{items.push({...JSON.parse(match[1]),fileBytes:Buffer.byteLength(text)});}catch{}}}}catch(error){if(error.code!=='ENOENT')throw error;}return items;
}
async function memorySize(root){const metadata=await memoryMetadata(root);return{...await sizeTree(root),activeCanonicalBytes:metadata.filter(item=>item.status==='active').reduce((sum,item)=>sum+item.fileBytes,0),activeRecords:metadata.filter(item=>item.status==='active').length,archivedCanonicalBytes:metadata.filter(item=>item.status!=='active').reduce((sum,item)=>sum+item.fileBytes,0)};}

if(mode==='init'){
  await mkdir(state,{recursive:true});
  await writeFile(join(state,'manifest.json'),JSON.stringify({fixtureHash,model:fixtureModel,wallSeconds,requestLimit,created:new Date().toISOString(),fixtures:fixtures.map(({id,history,correction,repairHistory,implement,temporary,revoke,transfer})=>({id,history,correction,repairHistory,implement,temporary,revoke,transfer}))},null,2)+'\n');
  console.log(`Frozen ${fixtureHash} at ${state}`);process.exit(0);
}
const frozen=JSON.parse(await readFile(join(state,'manifest.json'),'utf8'));
if(frozen.fixtureHash!==fixtureHash)throw new Error('Frozen fixture/checker hash changed');
if(mode==='history'){
  await mkdir(base,{recursive:true});
  for(const fixture of selected){
    const historyRoot=join(state,'history',fixture.id),cwd=join(historyRoot,'project'),sessions=join(historyRoot,'sessions'),artifactDir=join(historyRoot,'artifacts');
    await materialize(fixture,cwd,true);await mkdir(artifactDir,{recursive:true});
    const calls=[];
    for(const [name,prompt,tools]of[['decisions',fixture.history,false],['observed-repair',fixture.repairHistory,true],['correction',fixture.correction,false]]){
      calls.push(await piCall({name,cwd,memoryDir:base,sessionId:randomUUID(),sessions,prompt,memory:true,capture:true,tools,budget:join(historyRoot,`${name}.budget.json`),actionTrace:join(artifactDir,`${name}.actions.jsonl`),artifactDir,timeoutMs:300000}));
    }
    const recent=`Previous user message: ${fixture.correction}\nPrevious assistant reply: ${calls.at(-1).finalText}`;
    if(Buffer.byteLength(recent,'utf8')>600)throw new Error('Recent actual history exceeds fixed 600-byte ceiling; do not silently change protocol');
    await writeFile(join(historyRoot,'recent.txt'),recent);
    await writeFile(join(historyRoot,'history-results.json'),JSON.stringify(calls,null,2)+'\n');
    const {resolveProjectKey}=await import('../../src/project.ts');const scope=`project:${resolveProjectKey(cwd)}`;
    const items=(await memoryMetadata(base)).filter(item=>item.scope===scope);
    await writeFile(join(historyRoot,'captured-metadata.json'),JSON.stringify(items,null,2)+'\n');
    const globalItems=(await memoryMetadata(base)).filter(item=>item.scope==='global');
    await writeFile(join(historyRoot,'scope-audit.json'),JSON.stringify({projectScope:scope,globalItems:globalItems.map(item=>item.id),allSourcesActual:items.every(item=>item.source?.session&&!item.source.session.startsWith('synthetic:'))},null,2)+'\n');
    console.log(`${fixture.id} captured ${calls.length} real sessions, ${items.filter(item=>item.status==='active').length} active records`);
  }
  console.log(`History ready at ${state}`);process.exit(0);
}

try{if((await readdir(out)).length)throw new Error('Output directory must be empty');}catch(error){if(error.code!=='ENOENT')throw error;}
if(arms.some(arm=>arm!=='off'))for(const fixture of fixtures){const history=JSON.parse(await readFile(join(state,'history',fixture.id,'history-results.json'),'utf8'));if(history.length!==3||history.some(call=>call.exitCode!==0))throw new Error('Complete actual history for both projects before non-off arms');}
await mkdir(out,{recursive:true});
const sourceHashes={};for(const file of ['index.ts',...(await readdir(resolve(here,'../../src'))).filter(name=>name.endsWith('.ts')).sort().map(name=>`src/${name}`)]){const content=await readFile(resolve(here,'../..',file));sourceHashes[file]=createHash('sha256').update(content).digest('hex');if(arms.some(arm=>['empty','long','dream','polluted'].includes(arm))){const target=join(out,'source-snapshot',file);await mkdir(dirname(target),{recursive:true});await writeFile(target,content);}}
const sourceHash=createHash('sha256').update(JSON.stringify(sourceHashes)).digest('hex');
await writeFile(join(out,'manifest.json'),JSON.stringify({fixtureHash,protocolHash,sourceHash,sourceHashes,model,historyModel:frozen.model,memoryEnv,arms,repeats,wallSeconds,stageTimeoutSeconds:{1:240,2:120,3:240},requestLimitPerStage:requestLimit,maxRequestsPerJob:requestLimit*3,concurrency,state,started:new Date().toISOString(),recentBudgetBytes:600,recallBudgetUpperBound:1200,digestBudget:0},null,2)+'\n');
const workspace=await realpath(await mkdtemp(join(tmpdir(),'pi-memory-long-')));
async function job(fixture,arm,repeat){
  const id=`${fixture.id}-${arm}-${repeat}`,root=join(workspace,id),cwd=join(root,'project'),memoryDir=join(root,'memory'),artifactDir=join(out,id),sessions=join(root,'sessions'),actionTrace=join(artifactDir,'actions.jsonl');
  await materialize(fixture,cwd);await mkdir(artifactDir,{recursive:true});
  // Repeats beyond the available templates reuse template 0 so repeated sampling starts from one identical snapshot.
  if(repairOnlyFrom){const templates=resolve(repairOnlyFrom);let template=join(templates,`${fixture.id}-long-${repeat}`,'stage-2-files');try{await stat(template);}catch(error){if(error.code!=='ENOENT')throw error;template=join(templates,`${fixture.id}-long-0`,'stage-2-files');}await cp(template,cwd,{recursive:true});}
  const memory=['empty','long','dream','polluted'].includes(arm);
  if(['long','dream','polluted'].includes(arm))await cp(base,memoryDir,{recursive:true});else if(memory)await mkdir(memoryDir,{recursive:true});
  let pollution;
  if(arm==='polluted'){const{addPollution}=await import('./pollution.mjs');const{resolveProjectKey}=await import('../../src/project.ts');pollution=await addPollution(memoryDir,resolveProjectKey(cwd));}
  const recent=arm==='off'?'':await readFile(join(state,'history',fixture.id,'recent.txt'),'utf8');
  const context=recent?`Recent historical context (the current task overrides temporary settings):\n${recent}\n\n`:'';
  let dream;
  const beforeDreamMemory=await memorySize(memoryDir);
  if(arm==='dream')dream=await piCall({name:'dream',cwd,memoryDir,sessionId:randomUUID(),sessions,prompt:'/memory dream --force',memory:true,tools:false,budget:join(root,'dream-budget.json'),actionTrace:join(artifactDir,'dream-actions.jsonl'),artifactDir,timeoutMs:120000});
  const beforeMemory=await memorySize(memoryDir),started=Date.now(),deadline=started+wallSeconds*1000,sessionId=randomUUID(),calls=[],scores=[];
  const stageDeadlines=new Map();
  const call=async(name,prompt,id=sessionId)=>{
    if(Date.now()>=deadline)return{name,skipped:'job deadline reached',exitCode:124,modelRequests:0,usage:{}};
    const stage=name.match(/^stage-(\d)/)?.[1]??'other';
    if(!stageDeadlines.has(stage))stageDeadlines.set(stage,Date.now()+(stage==='2'?120000:240000));
    const remaining=Math.min(stageDeadlines.get(stage),deadline)-Date.now();
    if(remaining<=0)return{name,skipped:'stage deadline reached',timedOut:true,exitCode:124,modelRequests:0,usage:{}};
    return piCall({name,cwd,memoryDir,sessionId:id,sessions,prompt,recentContext:context,memory,tools:true,budget:join(root,`stage-${stage}-budget.json`),actionTrace,artifactDir,timeoutMs:remaining});
  };
  if(!repairOnlyFrom){
    calls.push(await call('stage-1-implement',fixture.implement));scores.push(await evaluate(fixture,cwd,1,artifactDir));await snapshot(cwd,join(artifactDir,'stage-1-files'));
    calls.push(await call('stage-2-temporary',fixture.temporary));calls.push(await call('stage-2-revoke',fixture.revoke));scores.push(await evaluate(fixture,cwd,2,artifactDir));await snapshot(cwd,join(artifactDir,'stage-2-files'));
  }
  await mkdir(join(cwd,'work'),{recursive:true});
  if(fixture.id==='ingestion'){
    const records=Array.from({length:3},(_,seq)=>({tenant:'transfer',seq,value:`repair-${seq}`}));
    await writeFile(join(cwd,'fixtures/repair-events.ndjson'),records.map(JSON.stringify).join('\n')+'\n');
    await writeFile(join(cwd,'work/repair-output.ndjson'),JSON.stringify(records[0])+'\n');await writeFile(join(cwd,'work/repair-checkpoint.json'),'{"nextLine":');
  }else{
    await mkdir(join(cwd,'work/backups'),{recursive:true});await writeFile(join(cwd,'work/backups/source.json'),JSON.stringify({version:1,name:'recovery-fixture',timeoutSeconds:3,flags:{ready:true},extra:'preserve'}));
    await writeFile(join(cwd,'work/repair-source.json'),'{"version":');
  }
  calls.push(await call('stage-3-transfer',fixture.transfer,randomUUID()));scores.push(await evaluate(fixture,cwd,3,artifactDir));await snapshot(cwd,join(artifactDir,'stage-3-files'));
  const actionEvents=parseEvents(await readFile(actionTrace,'utf8').catch(()=>''));
  const toolCalls=actionEvents.filter(event=>event.event==='tool_call');
  const cliCalls=toolCalls.filter(event=>event.tool==='bash'&&/bin\/(?:ingest|migrate)\.mjs/.test(event.input.command));
  const actualCliRuns=cliCalls.length;
  const cliRunsByPhase=Object.fromEntries(['stage-1-implement','stage-2-temporary','stage-2-revoke','stage-3-transfer'].map(phase=>[phase,cliCalls.filter(event=>event.phase===phase).length]));
  const suffixes=fixture.id==='ingestion'?{'stage-2-temporary':'bin/ingest.mjs fixtures/events.ndjson work/temporary.ndjson work/temporary-checkpoint.json 1','stage-2-revoke':'bin/ingest.mjs fixtures/events.ndjson work/normal.ndjson work/normal-checkpoint.json','stage-3-transfer':'bin/ingest.mjs fixtures/repair-events.ndjson work/repair-output.ndjson work/repair-checkpoint.json'}:{'stage-2-temporary':'bin/migrate.mjs fixtures/config.json work/temporary.json test-local','stage-2-revoke':'bin/migrate.mjs fixtures/config.json work/normal.json','stage-3-transfer':'bin/migrate.mjs work/repair-source.json work/repair-output.json'};
  const actionBindings=[];for(const[phase,suffix]of Object.entries(suffixes)){
    if(repairOnlyFrom&&phase!=='stage-3-transfer')continue;
    const matches=cliCalls.filter(event=>event.phase===phase&&event.input.command.replace(/\s+/g,' ').endsWith(suffix));let matched=false,error;
    for(const call of matches){const end=actionEvents.find(event=>event.event==='tool_end'&&event.id===call.id);if(end?.isError||end?.result?.structuredContent?.exit_code!==0)continue;
      try{const stdout=end.result.structuredContent.output??textContent(end.result),value=JSON.parse(stdout.trim());if(phase==='stage-3-transfer'){matched=true;break;}
        const file=phase==='stage-2-temporary'?'temporary-report.json':'normal-report.json';if(isDeepStrictEqual(value,JSON.parse(await readFile(join(cwd,file),'utf8')))){matched=true;break;}
      }catch(e){error=e.message;}
    }
    actionBindings.push({phase,expectedArguments:suffix,matched,...(error?{error}:{})});
  }
  const recallEvents=[];for(const name of await readdir(artifactDir))if(name.endsWith('.memory.jsonl'))recallEvents.push(...parseEvents(await readFile(join(artifactDir,name),'utf8')).filter(event=>event.event==='recall'));
  const {resolveProjectKey}=await import('../../src/project.ts');const expectedScope=`project:${resolveProjectKey(cwd)}`,metadata=await memoryMetadata(memoryDir),byId=new Map(metadata.map(item=>[item.id,item]));
  const scopeLeaks=[...new Set(recallEvents.flatMap(event=>event.ids??[]).filter(id=>byId.has(id)&&!['global',expectedScope].includes(byId.get(id).scope)))];
  const unknownMemoryIds=[...new Set(recallEvents.flatMap(event=>event.ids??[]).filter(id=>!byId.has(id)))];
  const parentChildCoinjections=recallEvents.flatMap(event=>(event.ids??[]).flatMap(id=>(byId.get(id)?.derivedFrom??[]).map(source=>typeof source==='string'?source:source.id).filter(sourceId=>event.ids.includes(sourceId)).map(sourceId=>({parent:id,source:sourceId}))));
  const actualRequiredCli=actionBindings.every(binding=>binding.matched);
  const result={id,project:fixture.id,arm,repeat,fixtureHash,protocolHash,sourceHash,model,memoryEnv,cwd,repairOnlyFrom,pollution,calls,scores,dream,complete:scores.every(score=>score.complete)&&calls.every(call=>call.exitCode===0)&&actualRequiredCli,budgetExhausted:calls.some(call=>call.budgetExhausted),timedOut:calls.some(call=>call.timedOut||call.skipped),modelRequests:calls.reduce((sum,call)=>sum+call.modelRequests,0),wallMs:Date.now()-started,usage:calls.reduce((sum,call)=>{for(const key of['input','output','cacheRead','cacheWrite','reasoning','totalTokens','cost'])sum[key]=(sum[key]??0)+(call.usage?.[key]??0);return sum;},{}),toolCalls:toolCalls.length,actualCliRuns,cliRunsByPhase,actionBindings,scopeLeaks,unknownMemoryIds,parentChildCoinjections,blockedActions:actionEvents.filter(event=>event.event==='blocked_path'||event.event==='blocked_command'),recalls:recallEvents,beforeDreamMemory,beforeMemory,afterMemory:await memorySize(memoryDir)};
  await writeFile(join(artifactDir,'result.json'),JSON.stringify(result,null,2)+'\n');
  console.log(`${id}: requests=${result.modelRequests}, complete=${result.complete}, final=${JSON.stringify(scores.at(-1).categoryScores)}, wall=${result.wallMs}ms`);
  return result;
}
const excluded=new Set(option('exclude-ids','').split(',').filter(Boolean));
const emptyRepeats=Number(option('empty-repeats',String(repeats)));
const jobs=[];for(let repeat=0;repeat<repeats;repeat++)for(const fixture of selected)for(const arm of arms)if(!excluded.has(`${fixture.id}-${arm}-${repeat}`)&&(arm!=='empty'||repeat<emptyRepeats))jobs.push({fixture,arm,repeat});
let cursor=0;const results=[];await Promise.all(Array.from({length:Math.min(concurrency,jobs.length)},async()=>{while(cursor<jobs.length){const next=jobs[cursor++];results.push(await job(next.fixture,next.arm,next.repeat));}}));
await writeFile(join(out,'results.json'),JSON.stringify(results,null,2)+'\n');console.log(`Results: ${out}`);
