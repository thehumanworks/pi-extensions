import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";

// Resolve from the package, not a physical node_modules layout (npm hoists workspaces).
const { loadExtensions } = await import(new URL("./core/extensions/loader.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
const oauthUrl = new URL("./auth/oauth/openai-codex.js", import.meta.resolve("@earendil-works/pi-ai"));
const { openaiCodexOAuth } = await import(oauthUrl.href);
import { readFileSync } from "node:fs";

test("Pi ships openai-codex with the Codex CLI OAuth client that voice requires", () => {
  const provider = openaiCodexProvider();
  assert.equal(provider.id, "openai-codex");
  assert.equal(provider.auth.oauth?.name, "OpenAI (ChatGPT Plus/Pro)");
  assert.ok(openaiCodexOAuth.refresh, "Pi owns refresh for this login");
  // Same OAuth client as openai/codex (codex-rs/login): tokens carry chatgpt_account_id.
  const source = readFileSync(oauthUrl, "utf8");
  assert.match(source, /CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"/);
});

test("real Pi extension loader accepts the package with no load-time actions", async () => {
  const path = fileURLToPath(new URL("../index.ts", import.meta.url));
  const result = await loadExtensions([path], process.cwd());
  assert.deepEqual(result.errors, []);
  assert.equal(result.extensions.length, 1);
  assert.ok(result.extensions[0]!.commands.has("voice"));
  assert.ok(result.extensions[0]!.handlers.has("session_shutdown"));
  assert.ok(result.extensions[0]!.entryRenderers?.has("voice-transcript"));
});
