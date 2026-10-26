#!/usr/bin/env node
// Usage: node bin/migrate.mjs INPUT OUTPUT [REGION_OVERRIDE]
import {migrateFile} from '../src/migrate.mjs';

const [input, output, region] = process.argv.slice(2);

if (!input || !output) {
  console.error('Usage: node bin/migrate.mjs INPUT OUTPUT [REGION_OVERRIDE]');
  process.exit(2);
}

try {
  const result = await migrateFile(input, output, region === undefined ? {} : {region});
  console.log(JSON.stringify(result, null, 2));
} catch (err) {
  console.error(`migration failed: ${err.message}`);
  process.exit(1);
}
