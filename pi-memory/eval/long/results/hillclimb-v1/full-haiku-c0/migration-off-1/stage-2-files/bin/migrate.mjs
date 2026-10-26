// Usage: node bin/migrate.mjs INPUT OUTPUT [REGION_OVERRIDE]
import {migrateFile} from '../src/migrate.mjs';

const [input, output, region] = process.argv.slice(2);

if (!input || !output) {
  console.error('usage: node bin/migrate.mjs INPUT OUTPUT [REGION_OVERRIDE]');
  process.exit(2);
}

const options = region ? {region} : {};
const config = await migrateFile(input, output, options);
console.log(JSON.stringify(config, null, 2));
