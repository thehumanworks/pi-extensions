import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, copyFile, chmod, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { startScriptedBackend } from './scripted-backend.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const app = fileURLToPath(new URL('../apps/web/', import.meta.url));
const require = createRequire(import.meta.url);

async function unusedPort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '::1', resolve); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exit = once(child, 'exit');
  const timer = setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch {} }, 4000);
  try { process.kill(-child.pid!, 'SIGTERM'); await exit; } finally { clearTimeout(timer); }
}

// Uses the supported production app, actual HTTP adapter, and actual local SQLite runtime.
// Only the model is scripted. No provider calls, real bots, or global installs.
test(`production ${process.env.BOT_TEST_WEB_BINARY ? 'native' : 'Next.js'} UI: tools, persistence, continued sessions, reconnect, explicit stop, mobile and safe errors`, { timeout: 120_000 }, async t => {
  const nativeBinary = process.env.BOT_TEST_WEB_BINARY ? resolve(process.env.BOT_TEST_WEB_BINARY) : undefined;
  if (nativeBinary) assert.ok(existsSync(nativeBinary), 'Build first: npm run build:native');
  else assert.ok(existsSync(`${app}/.next/BUILD_ID`), 'Build first: npm run build:ui');
  const backend = await startScriptedBackend();
  t.after(() => backend.close());
  const port = await unusedPort();
  const base = `http://[::1]:${port}`;
  let logs = '';
  const isolated = nativeBinary ? await mkdtemp(join(tmpdir(), 'bot-native-browser-')) : undefined;
  const executable = isolated ? join(isolated, `bot-web${process.platform === 'win32' ? '.exe' : ''}`) : process.execPath;
  if (nativeBinary) {
    await copyFile(nativeBinary, executable); await chmod(executable, 0o755);
    // Compiled deployment must not load incidental configuration or code in cwd.
    await writeFile(join(isolated!, '.env'), 'BOT_UI_ORIGIN=https://attacker.invalid\n');
    await writeFile(join(isolated!, 'bunfig.toml'), 'preload = ["./must-not-run.ts"]\n');
    await writeFile(join(isolated!, 'must-not-run.ts'), 'throw new Error("Unexpected cwd code execution")');
  }
  const args = nativeBinary ? ['web', '--host', '::1', '--port', String(port)] : [require.resolve('next/dist/bin/next'), 'start', '--hostname', '::1', '--port', String(port)];
  const next = spawn(executable, args, {
    cwd: isolated ?? app, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...(nativeBinary ? { PATH: '' } : {}), NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', BOT_SERVER_URL: backend.url, BOT_SERVER_TOKEN: backend.token, BOT_UI_ORIGIN: '' },
  });
  next.stdout!.on('data', value => { logs = (logs + String(value)).slice(-64_000); });
  next.stderr!.on('data', value => { logs = (logs + String(value)).slice(-64_000); });
  t.after(async () => { await stop(next); if (isolated) await rm(isolated, { recursive: true, force: true }); });
  const deadline = Date.now() + 30_000;
  for (;;) {
    try { const response = await fetch(base, { signal: AbortSignal.timeout(700) }); if (response.ok) break; } catch {}
    if (next.exitCode !== null || next.signalCode !== null || Date.now() > deadline) throw new Error(`Web server did not become ready: ${logs}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const executablePath = process.env.CHROMIUM_PATH ?? execFileSync('which', ['chromium'], { encoding: 'utf8' }).trim();
  const browser = await chromium.launch({ executablePath, args: ['--no-sandbox', '--no-proxy-server'] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  let cancelledRun: string | undefined;
  page.on('request', request => {
    assert.ok(!JSON.stringify(request.headers()).includes(backend.token), 'Backend token leaked to the browser');
    const match = new URL(request.url()).pathname.match(/^\/api\/runs\/([^/]+)\/cancel$/);
    if (match) cancelledRun = decodeURIComponent(match[1]!);
  });
  try {
    await page.goto(base);
    await expect(page.getByRole('heading', { name: 'Workspace test bot' })).toBeVisible();
    const input = page.getByRole('textbox');
    await expect(input).toBeEnabled();
    await input.fill('Use the echo tool to verify the adapter.');
    await page.getByRole('button', { name: /Send/ }).click();
    await expect(page.getByRole('article', { name: 'Bot message' }).filter({ hasText: 'Adapter verified.' })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('strong', { hasText: 'Adapter verified.' })).toBeVisible();
    await expect(page.getByText('echo', { exact: true }).first()).toBeVisible();
    await expect(input).toBeEnabled();
    const firstSession = new URL(page.url()).searchParams.get('session');
    assert.match(firstSession ?? '', /^dconv:\d+$/);
    assert.equal((await backend.bot.listSessions()).length, 1);

    await page.reload();
    await expect(page.getByRole('article', { name: 'Bot message' }).filter({ hasText: 'Adapter verified.' })).toBeVisible();
    await expect(page.getByRole('article', { name: 'Your message' })).toHaveCount(1);
    await expect(page.getByRole('textbox')).toBeEnabled();
    await page.getByRole('textbox').fill('Continue this saved conversation.');
    await page.getByRole('textbox').press('Enter');
    await expect(page.getByRole('article', { name: 'Bot message' }).filter({ hasText: 'Received: Continue this saved conversation.' })).toBeVisible();
    await expect(page.getByRole('textbox')).toBeEnabled();
    assert.equal(new URL(page.url()).searchParams.get('session'), firstSession);
    assert.equal((await backend.bot.listSessions()).length, 1);

    await page.getByRole('button', { name: /New session/ }).click();
    await expect(page.getByRole('article', { name: 'Your message' })).toHaveCount(0);
    await page.getByRole('textbox').fill('A slow response to test durable reconnection.');
    await page.getByRole('button', { name: /Send/ }).click();
    await expect(page.getByRole('button', { name: /Stop$/ })).toBeEnabled();
    await expect.poll(() => new URL(page.url()).searchParams.get('session')).not.toBe(firstSession);
    const secondSession = new URL(page.url()).searchParams.get('session');
    assert.match(secondSession ?? '', /^dconv:\d+$/);
    // A different session can be accepted while this run owns the executor.
    // Its snapshot has no active run ID yet: recovery must retain acceptance IDs.
    await page.getByRole('button', { name: /New session/ }).click();
    await page.getByRole('textbox').fill('Another slow response waiting in the queue.');
    await page.getByRole('button', { name: /Send/ }).click();
    await expect(page.locator('.run-status')).toHaveText('queued');
    const queuedRun = new URL(page.url()).searchParams.get('run');
    assert.match(queuedRun ?? '', /^drun:\d+$/);
    // The shared URL alone is sufficient even in a browser with no saved references.
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await expect(page.getByRole('button', { name: /Stop$/ })).toBeEnabled();
    assert.equal(new URL(page.url()).searchParams.get('run'), queuedRun);
    assert.equal((await backend.bot.getRun(queuedRun!)).status, 'queued');
    await page.getByRole('button', { name: /Stop$/ }).click();
    await expect(page.getByText('Run stopped. Your conversation is saved.', { exact: true })).toBeVisible({ timeout: 15_000 });
    assert.equal((await backend.bot.getRun(queuedRun!)).status, 'cancelled');
    await page.getByRole('button', { name: /A slow response to test durable reconnection/ }).click();
    await expect(page.getByRole('button', { name: /Stop$/ })).toBeEnabled();
    // Browser reload must detach the observer, not cancel accepted work.
    await page.reload();
    await expect(page.getByRole('button', { name: /Stop$/ })).toBeEnabled({ timeout: 20_000 });
    await expect(page.getByRole('article', { name: 'Your message' })).toHaveCount(1);
    assert.equal((await backend.bot.listSessions()).length, 3, 'Reconnect submitted a duplicate session');
    await page.getByRole('button', { name: /Stop$/ }).click();
    await expect(page.getByText('Run stopped. Your conversation is saved.', { exact: true })).toBeVisible({ timeout: 15_000 });
    assert.ok(cancelledRun);
    assert.equal((await backend.bot.getRun(cancelledRun)).status, 'cancelled');

    await page.getByRole('button', { name: /Use the echo tool to verify the adapter/ }).click();
    await expect(page.getByRole('article', { name: 'Your message' })).toHaveCount(2);
    await expect(page.getByRole('article', { name: 'Bot message' }).filter({ hasText: 'Adapter verified.' })).toBeVisible();
    assert.equal(new URL(page.url()).searchParams.get('session'), firstSession);
    assert.ok(!(await page.content()).includes(backend.token));
    assert.deepEqual(errors, [], 'Browser JavaScript errors');
    const denied = await page.request.post(`${base}/api/chat`, { headers: { origin: 'http://attacker.invalid' }, data: { id: 'cross-origin', messages: [] } });
    assert.equal(denied.status(), 403);
    const rebound = await page.request.get(`${base}/api/info`, { headers: { host: 'attacker.invalid' } });
    assert.equal(rebound.status(), 403, 'Origin-less requests with untrusted Host must not read local data');

    await mkdir(`${root}/test-results`, { recursive: true });
    await page.screenshot({ path: `${root}/test-results/workspace-desktop.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole('button', { name: 'Toggle sessions' })).toBeVisible();
    await page.getByRole('button', { name: 'Toggle sessions' }).click();
    await expect(page.getByRole('button', { name: /New session/ })).toBeVisible();
    await page.getByRole('button', { name: 'Close sessions' }).click();
    await expect(page.getByRole('textbox')).toBeVisible();
    await page.screenshot({ path: `${root}/test-results/workspace-mobile.png`, fullPage: true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Mobile layout overflows horizontally');
    const lightBackground = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe(lightBackground);
    await page.screenshot({ path: `${root}/test-results/workspace-mobile-dark.png`, fullPage: true });

    await backend.close();
    await page.reload();
    await expect(page.getByRole('alert').first()).toBeVisible();
    assert.ok(!(await page.content()).includes(backend.token), 'Backend error exposed token');
  } catch (error) {
    await mkdir(`${root}/test-results`, { recursive: true });
    await page.screenshot({ path: `${root}/test-results/workspace-failure.png`, fullPage: true }).catch(() => {});
    console.error('Browser integration server log:', logs.replaceAll(backend.token, '[redacted]'));
    console.error('Browser JavaScript errors:', errors);
    throw error;
  }
});
