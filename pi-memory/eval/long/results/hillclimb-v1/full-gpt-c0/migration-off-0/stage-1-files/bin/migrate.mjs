// Usage: node bin/migrate.mjs INPUT OUTPUT [REGION_OVERRIDE]
import { migrateFile } from '../src/migrate.mjs';

const args = process.argv.slice(2);
if (args.length < 2 || args.length > 3) {
  console.error('Usage: node bin/migrate.mjs INPUT OUTPUT [REGION_OVERRIDE]');
  process.exitCode = 1;
} else {
  try {
    const [input, output, region] = args;
    const config = await migrateFile(input, output, { region });
    console.log(JSON.stringify(config, null, 2));
  } catch (error) {
    console.error(`Migration failed: ${error.message}`);
    process.exitCode = 1;
  }
}
