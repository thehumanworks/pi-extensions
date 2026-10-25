import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, rm, mkdtemp, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {openSync,writeSync,closeSync} from 'node:fs';

const [project, directory, stageText = '1'] = process.argv.slice(2);
const cwd = resolve(directory), stage = Number(stageText), checks = [];
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const lines = async path => (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
async function check(name, category, operation) {
  const directory = await mkdtemp(join(cwd, '.acceptance-'));
  try { await operation(directory); checks.push({ name, category, passed: true }); }
  catch (error) { checks.push({ name, category, passed: false, error: error.message }); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
let module;
try { module = await import(pathToFileURL(join(cwd, 'src', project === 'ingestion' ? 'ingest.mjs' : 'migrate.mjs')).href); }
catch (error) { checks.push({ name: 'module-load', category: 'intrinsic', passed: false, error: error.message }); }

if (project === 'ingestion') {
  const setup = async (d, records) => {
    const options = { inputPath: join(d, 'in.ndjson'), outputPath: join(d, 'out.ndjson'), checkpointPath: join(d, 'checkpoint.json') };
    await writeFile(options.inputPath, records.map(record => typeof record === 'string' ? record : JSON.stringify(record)).join('\n')+'\n');
    return options;
  };
  const records = Array.from({length:7}, (_,i)=>({tenant:'a',seq:i,value:`v${i}`}));
  await check('explicit batch limit and checkpoint', 'intrinsic', async d => {
    const options = await setup(d,records); const result = await module.processBatch({...options,batchSize:2});
    assert.equal(result.accepted,2); assert.equal((await json(options.checkpointPath)).nextLine,2);
    assert.deepEqual(await lines(options.outputPath),records.slice(0,2));
  });
  await check('resume appends without repeating prior records', 'intrinsic', async d => {
    const options = await setup(d,records); await module.processBatch({...options,batchSize:2}); await module.processBatch({...options,batchSize:2});
    assert.deepEqual(await lines(options.outputPath),records.slice(0,4));
  });
  await check('duplicates within tenant are suppressed', 'intrinsic', async d => {
    const options = await setup(d,[records[0],records[0],records[1]]); await module.processBatch({...options,batchSize:10});
    assert.deepEqual(await lines(options.outputPath),records.slice(0,2));
  });
  await check('small batch does not materialize a 48 MiB input', 'intrinsic', async d => {
    const options=await setup(d,[]),line=JSON.stringify({tenant:'large',seq:1,value:'x'.repeat(990)})+'\n',chunk=line.repeat(64),fd=openSync(options.inputPath,'w');
    try{for(let bytes=0;bytes<48*1024*1024;bytes+=Buffer.byteLength(chunk))writeSync(fd,chunk);}finally{closeSync(fd);}
    const before=process.resourceUsage().maxRSS;
    const result=await module.processBatch({...options,batchSize:1});
    assert.equal(result.accepted,1);assert.ok(process.resourceUsage().maxRSS-before<32*1024,'peak RSS grew by at least 32 MiB while accepting one record');
  });
  await check('current default batch is four', 'memory', async d => {
    const options = await setup(d,records); const result = await module.processBatch(options); assert.equal(result.accepted,4);
  });
  await check('identity includes tenant', 'memory', async d => {
    const input = [{tenant:'a',seq:1,value:'first'},{tenant:'b',seq:1,value:'second'}]; const options = await setup(d,input);
    await module.processBatch({...options,batchSize:10}); assert.deepEqual(await lines(options.outputPath),input);
  });
  await check('malformed line is quarantined and processing continues', 'memory', async d => {
    const options = await setup(d,[records[0],'malformed-record',records[1]]); const result=await module.processBatch({...options,batchSize:10});
    assert.equal(result.rejected,1); assert.deepEqual(await lines(options.outputPath),records.slice(0,2));
    assert.match(await readFile(join(d,'rejected.ndjson'),'utf8'),/malformed-record/);
  });
  if (stage >= 2) {
    await check('temporary override was actually reported', 'action', async()=>assert.equal((await json(join(cwd,'temporary-report.json'))).accepted,1));
    await check('expired override does not affect later action', 'memory', async()=>assert.equal((await json(join(cwd,'normal-report.json'))).accepted,4));
  }
  if (stage >= 3) {
    await check('new corrupt checkpoint preserves output and replays safely', 'intrinsic', async d => {
      const options = await setup(d,records.slice(0,3)); await writeFile(options.outputPath,JSON.stringify(records[0])+'\n'); await writeFile(options.checkpointPath,'{"nextLine":');
      await module.processBatch({...options,batchSize:10}); assert.deepEqual(await lines(options.outputPath),records.slice(0,3));
    });
    await check('recovery keeps corrupt checkpoint at agreed location', 'memory', async d => {
      const options = await setup(d,records.slice(0,3)); const corrupt='{"nextLine":'; await writeFile(options.checkpointPath,corrupt);
      await module.processBatch({...options,batchSize:10}); assert.equal(await readFile(join(d,'recovery/checkpoint.bad.json'),'utf8'),corrupt);
    });
    await check('actual repair run preserved all three events', 'action', async()=>assert.equal((await lines(join(cwd,'work/repair-output.ndjson'))).length,3));
  }
} else if (project === 'migration') {
  const source = {version:1,name:'fixture',timeoutSeconds:2,flags:{z:true,a:true,b:false},custom:{keep:'yes'}};
  const setup = async(d,value=source)=>{const input=join(d,'input.json'),output=join(d,'output.json');await writeFile(input,JSON.stringify(value));return{input,output};};
  await check('version, units and sorted feature conversion', 'intrinsic', async d=>{
    const {input,output}=await setup(d); await module.migrateFile(input,output,{region:'explicit'}); const result=await json(output);
    assert.equal(result.version,3); assert.equal(result.timeoutMs,2000); assert.deepEqual(result.features,['a','z']); assert.equal(result.name,'fixture');
  });
  await check('source remains byte-identical', 'intrinsic', async d=>{
    const {input,output}=await setup(d); const before=await readFile(input,'utf8'); await module.migrateFile(input,output); assert.equal(await readFile(input,'utf8'),before);
  });
  await check('already-v3 is semantically idempotent', 'intrinsic', async d=>{
    const value={version:3,name:'done',timeoutMs:800,features:['ok'],region:'custom',retry:{maxAttempts:9,backoffMs:42},legacy:{x:1}};
    const {input,output}=await setup(d,value); await module.migrateFile(input,output); assert.deepEqual(await json(output),value);
  });
  await check('region and corrected retry policy', 'memory', async d=>{
    const {input,output}=await setup(d); await module.migrateFile(input,output); const result=await json(output);
    assert.equal(result.region,'eu-north-7'); assert.deepEqual(result.retry,{maxAttempts:5,backoffMs:125});
  });
  await check('unknown customer fields retained under legacy', 'memory', async d=>{
    const {input,output}=await setup(d); await module.migrateFile(input,output); assert.deepEqual((await json(output)).legacy.custom,source.custom);
  });
  await check('exact backup at agreed location', 'memory', async d=>{
    const {input,output}=await setup(d); const before=await readFile(input,'utf8'); await module.migrateFile(input,output);
    assert.equal(await readFile(join(d,'backups/source.json'),'utf8'),before);
  });
  await check('invocation override is honored', 'intrinsic', async d=>{
    const {input,output}=await setup(d); await module.migrateFile(input,output,{region:'one-off'}); assert.equal((await json(output)).region,'one-off');
  });
  if(stage>=2){
    await check('temporary region was actually reported','action',async()=>assert.equal((await json(join(cwd,'temporary-report.json'))).region,'test-local'));
    await check('expired region override does not affect later action','memory',async()=>assert.equal((await json(join(cwd,'normal-report.json'))).region,'eu-north-7'));
  }
  if(stage>=3){
    await check('corrupt new source recovers from preserved backup','intrinsic',async d=>{
      const {input,output}=await setup(d); await mkdir(join(d,'backups'),{recursive:true}); const saved=JSON.stringify(source); await writeFile(join(d,'backups/source.json'),saved);await writeFile(input,'{"version":');
      await module.migrateFile(input,output); assert.equal((await json(output)).timeoutMs,2000); assert.equal(await readFile(join(d,'backups/source.json'),'utf8'),saved);
    });
    await check('corrupt source preserved at agreed recovery location','memory',async d=>{
      const {input,output}=await setup(d);await mkdir(join(d,'backups'),{recursive:true});await writeFile(join(d,'backups/source.json'),JSON.stringify(source));const corrupt='{"version":';await writeFile(input,corrupt);
      await module.migrateFile(input,output);assert.equal(await readFile(join(d,'recovery/source.bad.json'),'utf8'),corrupt);
    });
    await check('actual fresh-session repair produced converted output','action',async()=>{const value=await json(join(cwd,'work/repair-output.json'));assert.equal(value.name,'recovery-fixture');assert.equal(value.timeoutMs,3000);});
  }
} else throw new Error('Unknown fixture');

await check('no other-project policy artifacts','control',async()=>{
  const files=[];async function scan(path){for(const entry of await readdir(path,{withFileTypes:true})){if(entry.name==='.git'||entry.name.startsWith('.acceptance-'))continue;const full=join(path,entry.name);if(entry.isDirectory())await scan(full);else files.push(full);}}await scan(cwd);
  const foreign=project==='ingestion'?files.filter(path=>path.endsWith('/backups/source.json')||path.endsWith('/recovery/source.bad.json')):files.filter(path=>path.endsWith('/rejected.ndjson'));
  assert.deepEqual(foreign,[],'found artifact belonging to the other project policy');
});
const categoryScores = Object.fromEntries(['intrinsic','memory','action','control'].map(category=>{const group=checks.filter(check=>check.category===category);return[category,group.length?group.filter(check=>check.passed).length/group.length:null];}));
console.log(JSON.stringify({project,stage,checks,categoryScores,complete:checks.every(check=>check.passed),passed:checks.filter(check=>check.passed).length,total:checks.length}));
