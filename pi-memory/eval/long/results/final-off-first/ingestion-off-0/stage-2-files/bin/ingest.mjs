// Usage: node bin/ingest.mjs INPUT OUTPUT CHECKPOINT [BATCH_SIZE]
import { processBatch } from '../src/ingest.mjs';

const args = process.argv.slice(2);
try {
  if (args.length < 3 || args.length > 4) {
    throw new Error('Usage: node bin/ingest.mjs INPUT OUTPUT CHECKPOINT [BATCH_SIZE]');
  }
  const [inputPath, outputPath, checkpointPath, size] = args;
  const report = await processBatch({
    inputPath, outputPath, checkpointPath,
    ...(size === undefined ? {} : { batchSize: Number(size) }),
  });
  console.log(JSON.stringify(report));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
