import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);

async function run(command: string[], env: NodeJS.ProcessEnv = process.env) {
  const child = Bun.spawn(command, { cwd: appRoot, env, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
  const status = await child.exited;
  if (status !== 0) throw new Error(`${command[0]} failed (exit ${status})`);
}

async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(entry => entry.isDirectory() ? files(join(directory, entry.name)) : entry.isFile() ? [join(directory, entry.name)] : []));
  return nested.flat().sort();
}

/** One production Next UI, exported once and embedded with its native HTTP host. */
export async function buildNative(outfile = join(appRoot, 'dist', `bot-web${process.platform === 'win32' ? '.exe' : ''}`)) {
  outfile = resolve(outfile);
  if (process.platform === 'win32' && !outfile.endsWith('.exe')) outfile += '.exe';
  const buildRoot = join(appRoot, '.build');
  await mkdir(buildRoot, { recursive: true });
  const temporary = await mkdtemp(join(buildRoot, 'native-'));
  const staged = join(temporary, 'app');
  try {
    await mkdir(staged);
    // Dynamic API routes cannot be statically exported. Both hosts use the same
    // framework-neutral API handler; only the UI shell is exported here.
    for (const name of ['app', 'components', 'lib', 'next.config.ts', 'next-env.d.ts', 'tsconfig.json', 'package.json']) {
      await cp(join(appRoot, name), join(staged, name), {
        recursive: true,
        filter: path => name !== 'app' || relative(join(appRoot, 'app'), path).split(sep)[0] !== 'api',
      });
    }
    try { await cp(join(appRoot, 'public'), join(staged, 'public'), { recursive: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await run([process.env.NODE_BINARY || 'node', require.resolve('next/dist/bin/next'), 'build', staged], {
      ...process.env,
      NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', BOT_WEB_STATIC_EXPORT: '1',
    });
    const output = join(staged, 'out');
    const assets = await files(output);
    if (!assets.some(path => relative(output, path) === 'index.html')) throw new Error('Static UI build did not produce index.html');
    const imports: string[] = [];
    const entries: string[] = [];
    for (const [index, path] of assets.entries()) {
      const name = `asset${index}`;
      imports.push(`import ${name} from ${JSON.stringify(path.replaceAll('\\', '/'))} with { type: 'file' };`);
      const pathname = '/' + relative(output, path).split(sep).join('/');
      const etag = `"${createHash('sha256').update(await readFile(path)).digest('hex')}"`;
      entries.push(`[${JSON.stringify(pathname)}, { file: ${name}, type: ${JSON.stringify(Bun.file(path).type || 'application/octet-stream')}, etag: ${JSON.stringify(etag)} }]`);
    }
    const entry = join(temporary, 'entry.ts');
    await writeFile(entry, `${imports.join('\n')}\nimport { main } from ${JSON.stringify(join(appRoot, 'native/main.ts').replaceAll('\\', '/'))};\nawait main(process.argv.slice(2), new Map([\n${entries.join(',\n')}\n])).catch(() => { console.error('Unable to start bot-web. Check the arguments, listen address and server configuration.'); process.exitCode = 1; });\n`);
    await mkdir(dirname(outfile), { recursive: true });
    // Reuse the local Bun executable: compilation must never fetch a runtime in
    // a Nix sandbox. No caller .env/bunfig/package/tsconfig loading at runtime.
    await run([process.execPath, 'build', '--compile', '--minify',
      '--compile-executable-path', process.execPath,
      '--no-compile-autoload-dotenv', '--no-compile-autoload-bunfig',
      '--no-compile-autoload-tsconfig', '--no-compile-autoload-package-json',
      '--outfile', outfile, entry]);
    console.log(`Native web UI: ${outfile} (${assets.length} embedded assets)`);
    return outfile;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log('Usage: bun run scripts/build-native.ts [--out FILE]\nBuild the current-platform standalone bot-web binary. Requires local workspace dependencies, Node and Bun.');
  } else if (args.length !== 0 && (args.length !== 2 || args[0] !== '--out' || !args[1]?.trim())) {
    console.error('Usage: bun run scripts/build-native.ts [--out FILE]'); process.exitCode = 1;
  } else {
    await buildNative(args[1]).catch(error => { console.error(error instanceof Error ? error.message : 'Native build failed'); process.exitCode = 1; });
  }
}
