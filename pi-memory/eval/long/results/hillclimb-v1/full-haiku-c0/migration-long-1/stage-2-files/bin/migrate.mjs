#!/usr/bin/env node
// Usage: node bin/migrate.mjs INPUT OUTPUT [REGION_OVERRIDE]
import {migrateFile} from '../src/migrate.mjs';

const [inputPath, outputPath, regionOverride] = process.argv.slice(2);

if (!inputPath || !outputPath) {
  console.error('usage: node bin/migrate.mjs INPUT OUTPUT [REGION_OVERRIDE]');
  process.exit(2);
}

try {
  const options = regionOverride === undefined ? {} : {region: regionOverride};
  const result = await migrateFile(inputPath, outputPath, options);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(`migration failed: ${error.message}`);
  process.exit(1);
}
