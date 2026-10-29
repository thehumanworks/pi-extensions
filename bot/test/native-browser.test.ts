import { fileURLToPath } from 'node:url';

// Run the same product acceptance suite against the self-contained distribution,
// including an empty PATH and a working directory without app assets/dependencies.
process.env.BOT_TEST_WEB_BINARY ||= fileURLToPath(new URL('../dist/bot-web' + (process.platform === 'win32' ? '.exe' : ''), import.meta.url));
await import('./browser.test.ts');
