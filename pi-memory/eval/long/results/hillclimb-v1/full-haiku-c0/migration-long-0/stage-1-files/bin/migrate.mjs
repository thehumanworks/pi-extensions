#!/usr/bin/env node
import {migrateFile} from '../src/migrate.mjs';

const [input, output, region] = process.argv.slice(2);

if (!input || !output) {
  console.error('usage: node bin/migrate.mjs INPUT OUTPUT [REGION_OVERRIDE]');
  process.exit(2);
}

try {
  const result = await migrateFile(input, output, region === undefined ? {} : {region});
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
