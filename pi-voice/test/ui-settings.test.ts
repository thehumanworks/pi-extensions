import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { AnimatedText, meter, VoiceWidget } from "../src/ui.ts";
import { DEFAULT_SETTINGS, isMuteKey, readSettings, writeSettings } from "../src/settings.ts";
import type { VoiceSession } from "../src/session.ts";

const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text } as unknown as Theme;

test("animated text settles Unicode graphemes without reanimating stable prefixes", () => {
  const animation = new AnimatedText();
  animation.update("Hi 👨‍👩‍👧 café 你好", 0);
  assert.notEqual(animation.render(0, t => t), "Hi 👨‍👩‍👧 café 你好");
  assert.equal(animation.render(200, t => t), "Hi 👨‍👩‍👧 café 你好");
  animation.update("Hi 👨‍👩‍👧 café 你好!", 300);
  assert.ok(animation.render(300, t => t).startsWith("Hi 👨‍👩‍👧 café 你好"));
  assert.equal(animation.render(500, t => t), "Hi 👨‍👩‍👧 café 你好!");
  assert.equal(meter([0, 1, NaN, -1]), "▁█▁▁");
});

test("widget fits narrow terminals, Unicode, theme invalidation and disposal", () => {
  const session = {
    state: { phase: "listening", muted: false, inputLevel: 0.2, outputLevel: 0.1 },
    tick() {},
  } as unknown as VoiceSession;
  const widget = new VoiceWidget(session, { ...DEFAULT_SETTINGS }, { requestRender() {} }, theme);
  try {
    widget.transcript({ role: "user", turn: 1, text: "hello 你好 🦊 ".repeat(100), final: false });
    widget.transcript({ role: "assistant", turn: 1, text: "\x1b[31mhello", final: false });
    for (const width of [0, 1, 2, 5, 10, 20, 40, 80, 200]) {
      const lines = widget.render(width);
      assert.ok(lines.length <= 6);
      for (const line of lines) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}`);
    }
    widget.invalidate();
    assert.match(widget.render(100).join("\n"), /ctrl\+x mute.*\/voice off/);
  } finally { widget.dispose(); widget.dispose(); }
});

test("config persists mute key and voice, defaults safely, rejects invalid/conflicting shortcuts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-voice-settings-"));
  const path = join(directory, "voice.json");
  try {
    assert.deepEqual(await readSettings(path), DEFAULT_SETTINGS);
    await writeSettings(path, { muteKey: "f9", voice: "cove" });
    assert.deepEqual(await readSettings(path), { muteKey: "f9", voice: "cove" });
    for (const key of ["ctrl+x", "ctrl+shift+x", "alt+m", "f9", "ctrl++"]) assert.ok(isMuteKey(key), key);
    for (const key of ["x", "shift+x", "ctrl+ctrl+x", "ctrl+c", "ctrl+d", "ctrl+z", "bad+key", "f99", "ctrl+"]) assert.ok(!isMuteKey(key), key);
    await writeFile(path, "{");
    await assert.rejects(readSettings(path), /Cannot read/);
    await writeFile(path, '{"muteKey":"x"}');
    await assert.rejects(readSettings(path), /muteKey/);
  } finally { await rm(directory, { recursive: true }); }
});
