#!/usr/bin/env node
// Implement: node bin/ingest.mjs INPUT OUTPUT CHECKPOINT [BATCH_SIZE]
import {resolve} from 'node:path';
import {processBatch} from '../src/ingest.mjs';

const [input,output,checkpoint,size] = process.argv.slice(2);
if(!input || !output || !checkpoint){
  console.error('usage: node bin/ingest.mjs INPUT OUTPUT CHECKPOINT [BATCH_SIZE]');
  process.exit(2);
}

try {
  const report = await processBatch({
    inputPath:resolve(input),
    outputPath:resolve(output),
    checkpointPath:resolve(checkpoint),
    batchSize:size===undefined ? undefined : Number(size),
  });
  console.log(JSON.stringify(report,null,2));
} catch(err){
  console.error(err.message);
  process.exit(1);
}
