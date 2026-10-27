// Child fixture for testing kernel ownership across process death. Not a model worker.
import { acquireLock } from '../dist/lock.js';
await acquireLock(process.argv[2]);
process.stdout.write('locked\n');
setInterval(() => {}, 60_000);
