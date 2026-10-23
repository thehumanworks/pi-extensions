import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const tag = `${process.platform}-${process.arch}`;
let installedLeaf: string | undefined;
try {
  installedLeaf = dirname(require.resolve(`@oh-my-pi/pi-natives-${tag}/package.json`));
} catch { /* Native dependencies are optional on CI. */ }

for (const nested of [false, true]) {
  test(`native loader bypasses JS entry resolution (${nested ? "nested" : "hoisted"} binary)`, {
    skip: !installedLeaf && "Platform native dependency is not installed",
  }, async (t) => {
    const root = mkdtempSync(join(tmpdir(), "pi-voice-native-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const parent = join(root, "node_modules/@oh-my-pi/pi-natives");
    mkdirSync(parent, { recursive: true });
    // A deliberately unresolvable entry reproduces the compiled runtime failure.
    writeFileSync(join(parent, "package.json"), JSON.stringify({
      name: "@oh-my-pi/pi-natives", exports: { ".": "./missing.js" },
    }));
    const leaf = join(nested ? parent : root, `node_modules/@oh-my-pi/pi-natives-${tag}`);
    mkdirSync(dirname(leaf), { recursive: true });
    symlinkSync(installedLeaf!, leaf, "junction");
    const source = join(root, "native.ts");
    copyFileSync(new URL("../src/native.ts", import.meta.url), source);
    const { loadNativeAudio } = await import(pathToFileURL(source).href);
    const bindings = loadNativeAudio();
    assert.equal(typeof bindings.AudioCapture, "function");
    assert.equal(typeof bindings.LiveWebRtcPeer, "function");
    assert.equal(loadNativeAudio(), bindings);
    // Do not construct either class: loading must not open audio hardware.
  });
}

test("native loader preserves the underlying failure rather than blaming optional dependencies", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-voice-native-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "native.ts");
  copyFileSync(new URL("../src/native.ts", import.meta.url), source);
  const { loadNativeAudio } = await import(pathToFileURL(source).href);
  assert.throws(loadNativeAudio, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(error.cause instanceof Error);
    assert.match(error.message, /Cannot find installed @oh-my-pi\/pi-natives package/);
    assert.ok(error.message.includes(error.cause.message));
    assert.doesNotMatch(error.message, /Reinstall/);
    return true;
  });
});
