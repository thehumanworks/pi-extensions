#!/usr/bin/env node
// The test harness uses Node; the installed program must not. No daemon/provider
// is started or contacted: only static assets and an unknown API path are read.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const [binaryArg, version] = process.argv.slice(2);
assert(binaryArg && version, 'Usage: smoke-test.mjs /absolute/path/to/bot-web VERSION');
const binary = resolve(binaryArg);
assert.equal(readFileSync(binary).subarray(0, 4).toString('hex'), '7f454c46',
  'Linux bot-web must be an actual ELF executable, not a shell/JS wrapper');
const cwd = mkdtempSync(join(tmpdir(), 'bot-web-smoke-'));
// Intentionally do not inherit PATH, tokens, proxy settings or bot environment.
const env = { PATH: '', HOME: cwd, TMPDIR: cwd, LANG: 'C.UTF-8' };
let child;
let exited;
let logs = '';
try {
  for (const flag of ['--help', '-h', '--version', '-v']) {
    const result = spawnSync(binary, [flag], {
      cwd, env, encoding: 'utf8', timeout: 10_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${flag}: ${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, flag.includes('help') || flag === '-h' ? /bot-web/ : new RegExp(version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  // Use IPv6 loopback (IPv4 loopback is not reliable in the development WSL).
  const reservation = createServer();
  await new Promise((ok, fail) => {
    reservation.once('error', fail);
    reservation.listen(0, '::1', ok);
  });
  const port = reservation.address().port;
  await new Promise((ok, fail) => reservation.close(error => error ? fail(error) : ok()));
  child = spawn(binary, ['web', '--host', '::1', '--port', String(port),
    '--backend-url', 'http://[::1]:1'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => { logs = (logs + chunk).slice(-16_384); });
  child.stderr.on('data', chunk => { logs = (logs + chunk).slice(-16_384); });
  exited = new Promise(resolveExit => {
    child.once('error', error => resolveExit({ error }));
    child.once('exit', (code, signal) => resolveExit({ code, signal }));
  });
  const base = `http://[::1]:${port}`;
  let response;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      response = await fetch(base, { signal: AbortSignal.timeout(500) });
      break;
    } catch {
      assert(child.exitCode === null && child.signalCode === null, `Server exited: ${logs}`);
      await delay(50);
    }
  }
  assert(response, `Server never became ready: ${logs}`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/html/);
  const html = await response.text();
  assert.match(html, /<html[\s>]/i);
  const head = await fetch(base, { method: 'HEAD', signal: AbortSignal.timeout(5_000) });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  const asset = html.match(/(?:src|href)="([^" ]*\/_next\/static\/[^" ]+)"/);
  assert(asset, 'Static export must embed the actual Next UI assets');
  assert(asset[1].startsWith('/_next/static/'), 'Asset must be local, not network-hosted');
  const staticResponse = await fetch(base + asset[1].replaceAll('&amp;', '&'), {
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(staticResponse.status, 200);
  assert((await staticResponse.arrayBuffer()).byteLength > 0);
  const unknown = await fetch(`${base}/api/__bot_web_smoke_missing__`, {
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(unknown.status, 404);
  assert.match(unknown.headers.get('content-type') ?? '', /application\/json/);
  await unknown.json();
  child.kill('SIGTERM');
  const result = await Promise.race([exited, delay(5_000).then(() => null)]);
  assert(result, `Server failed to stop after SIGTERM: ${logs}`);
  assert.ifError(result.error);
  assert.equal(result.code, 0, `Unclean shutdown: ${JSON.stringify(result)}\n${logs}`);
  console.log('bot-web native smoke: help/version, embedded UI/assets, HEAD, API 404, graceful shutdown (empty PATH, fresh cwd)');
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await exited;
  }
  rmSync(cwd, { recursive: true, force: true });
}
