#!/usr/bin/env node
// Usage: node bin/ingest.mjs INPUT OUTPUT CHECKPOINT [BATCH_SIZE]
import {processBatch} from '../src/ingest.mjs';

const [inputPath, outputPath, checkpointPath, batchArg] = process.argv.slice(2);
if (!inputPath || !outputPath || !checkpointPath) {
  console.error('usage: node bin/ingest.mjs INPUT OUTPUT CHECKPOINT [BATCH_SIZE]');
  process.exit(2);
}

try {
  const batchSize = batchArg === undefined ? undefined : Number(batchArg);
  const report = await processBatch({inputPath, outputPath, checkpointPath, batchSize});
  console.log(JSON.stringify(report, null, 2));
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
