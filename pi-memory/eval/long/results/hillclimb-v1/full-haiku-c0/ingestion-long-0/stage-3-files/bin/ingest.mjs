#!/usr/bin/env node
// Usage: node bin/ingest.mjs INPUT OUTPUT CHECKPOINT [BATCH_SIZE]
import {processBatch} from '../src/ingest.mjs';

const [inputPath, outputPath, checkpointPath, batchArg] = process.argv.slice(2);

if (!inputPath || !outputPath || !checkpointPath) {
  console.error('usage: node bin/ingest.mjs INPUT OUTPUT CHECKPOINT [BATCH_SIZE]');
  process.exit(2);
}

const batchSize = batchArg === undefined ? undefined : Number(batchArg);
if (batchArg !== undefined && !Number.isInteger(batchSize)) {
  console.error('BATCH_SIZE must be an integer');
  process.exit(2);
}

try {
  const report = await processBatch({inputPath, outputPath, checkpointPath, batchSize});
  console.log(JSON.stringify(report, null, 2));
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
