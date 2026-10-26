// Usage: node bin/migrate.mjs INPUT OUTPUT [REGION_OVERRIDE]
import { migrateFile } from '../src/migrate.mjs';

const args = process.argv.slice(2);
if (args.length < 2 || args.length > 3) {
  console.error('Usage: node bin/migrate.mjs INPUT OUTPUT [REGION_OVERRIDE]');
  process.exitCode = 1;
} else {
  try {
    const [inputPath, outputPath, region] = args;
    const result = await migrateFile(inputPath, outputPath, { region });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`Migration failed: ${error.message}`);
    process.exitCode = 1;
  }
}
