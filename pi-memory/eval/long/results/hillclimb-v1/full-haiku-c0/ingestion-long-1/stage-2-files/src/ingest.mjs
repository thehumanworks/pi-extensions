import {createReadStream} from 'node:fs';
import {appendFile,mkdir,readFile,rename,writeFile} from 'node:fs/promises';
import {createInterface} from 'node:readline';
import {dirname,join} from 'node:path';

export const DEFAULT_BATCH_SIZE = 4;

async function readText(path){
  try { return await readFile(path,'utf8'); }
  catch(err){ if(err.code==='ENOENT') return null; throw err; }
}

// Valid event: a JSON object with a non-empty string tenant and an integer seq.
function parseEvent(line){
  let v;
  try { v = JSON.parse(line); } catch { return null; }
  if(v===null || typeof v!=='object' || Array.isArray(v)) return null;
  if(typeof v.tenant!=='string' || v.tenant==='' || !Number.isInteger(v.seq)) return null;
  return v;
}

const identityOf = e => JSON.stringify([e.tenant,e.seq]);

function linesOf(text){
  return text ? text.split('\n').filter(Boolean) : [];
}

async function loadCheckpoint(checkpointPath){
  const text = await readText(checkpointPath);
  if(text===null) return {nextLine:0,valid:false,missing:true};
  try {
    const cp = JSON.parse(text);
    if(Number.isInteger(cp?.nextLine) && cp.nextLine>=0) return {nextLine:cp.nextLine,valid:true};
  } catch {}
  return {nextLine:0,valid:false,missing:false};
}

// Moves a corrupt checkpoint aside (never touching output) so it can be rebuilt by replay.
async function quarantineCheckpoint(checkpointPath){
  const recoveryDir = join(dirname(checkpointPath),'recovery');
  await mkdir(recoveryDir,{recursive:true});
  let badPath = join(recoveryDir,'checkpoint.bad.json');
  if((await readText(badPath))!==null) badPath = join(recoveryDir,`checkpoint.bad.${Date.now()}.json`);
  await rename(checkpointPath,badPath);
}

async function writeCheckpointAtomic(checkpointPath,nextLine){
  const tmp = `${checkpointPath}.${process.pid}.tmp`;
  await writeFile(tmp,JSON.stringify({nextLine})+'\n');
  await rename(tmp,checkpointPath);
}

export async function processBatch({inputPath,outputPath,checkpointPath,batchSize}){
  const limit = batchSize ?? DEFAULT_BATCH_SIZE;
  if(!Number.isInteger(limit) || limit<1) throw new RangeError(`batchSize must be a positive integer, got ${batchSize}`);

  const outDir = dirname(outputPath);
  const rejectedPath = join(outDir,'rejected.ndjson');
  await mkdir(outDir,{recursive:true});
  await mkdir(dirname(checkpointPath),{recursive:true});

  const cp = await loadCheckpoint(checkpointPath);
  if(!cp.valid && !cp.missing) await quarantineCheckpoint(checkpointPath);
  // Without a usable checkpoint, replay from the start; previously quarantined lines are not re-quarantined.
  const replay = !cp.valid;
  const start = cp.nextLine;

  const seen = new Set(linesOf(await readText(outputPath)).map(l=>parseEvent(l)).filter(Boolean).map(identityOf));
  const alreadyRejected = new Map();
  if(replay) for(const l of linesOf(await readText(rejectedPath))) alreadyRejected.set(l,(alreadyRejected.get(l)??0)+1);

  const report = {accepted:0,rejected:0,duplicates:0,nextLine:start};
  const acceptedOut = [];
  const rejectedOut = [];
  const rl = createInterface({input:createReadStream(inputPath,'utf8'),crlfDelay:Infinity});
  let lineNo = 0;
  let consumed = start;
  try {
    for await(const raw of rl){
      const index = lineNo++;
      if(index<start) continue;
      consumed = index+1;
      const event = parseEvent(raw);
      if(!event){
        report.rejected++;
        const n = alreadyRejected.get(raw) ?? 0;
        if(replay && n>0) alreadyRejected.set(raw,n-1);
        else rejectedOut.push(raw);
      } else {
        const id = identityOf(event);
        if(seen.has(id)) report.duplicates++;
        else {
          seen.add(id);
          acceptedOut.push(raw);
          report.accepted++;
          if(report.accepted>=limit) break;
        }
      }
    }
  } finally {
    rl.close();
  }

  if(acceptedOut.length) await appendFile(outputPath,acceptedOut.map(l=>l+'\n').join(''));
  if(rejectedOut.length) await appendFile(rejectedPath,rejectedOut.map(l=>l+'\n').join(''));
  await writeCheckpointAtomic(checkpointPath,consumed);
  report.nextLine = consumed;
  return report;
}
