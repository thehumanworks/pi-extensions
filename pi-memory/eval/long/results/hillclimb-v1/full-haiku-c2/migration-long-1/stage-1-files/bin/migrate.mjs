#!/usr/bin/env node
// Usage: node bin/migrate.mjs INPUT OUTPUT [REGION_OVERRIDE]
import {migrateFile} from '../src/migrate.mjs';

const [input, output, region] = process.argv.slice(2);
if (!input || !output) {
  console.error('usage: node bin/migrate.mjs INPUT OUTPUT [REGION_OVERRIDE]');
  process.exit(2);
}

const result = await migrateFile(input, output, region ? {region} : {});
console.log(JSON.stringify(result, null, 2));
