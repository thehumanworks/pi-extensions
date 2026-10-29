import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { TuiAltScreen, TuiMainScreen, Text, type Terminal } from "@earendil-works/pi-tui";
import { UsageView } from "../src/view.ts";

for (const Renderer of [TuiMainScreen, TuiAltScreen]) {
  test(`real ${Renderer.name} renders the usage overlay and closes cleanly`, async () => {
    let output = "";
    const terminal: Terminal = {
      columns: 90, rows: 30, kittyProtocolActive: false,
      start() {}, stop() {}, async drainInput() {}, write(data) { output += data; },
      moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {},
      clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {},
    };
    const tui = new Renderer(terminal);
    const view = new UsageView(tui, { fg: (_color, text) => text, bold: (text) => text }, { matches: () => false }, () => {}, async () => [{
      provider: { id: "openai", label: "OpenAI", dashboardUrl: "https://chatgpt.com/settings/usage" },
      status: "ok",
      snapshot: { account: "test account", source: "Codex login", fetchedAt: Date.now(), notes: [], groups: [
        { label: "Account allowance", windows: [{ label: "Weekly limit", remainingPercent: 80 }] },
      ] },
    }]);
    try {
      tui.addChild(new Text("Underlying conversation"));
      tui.start();
      tui.showOverlay(view, { width: "90%", maxHeight: "85%" });
      await delay(30);
      assert.match(output, /Account usage/);
      assert.match(output, /80% left/);
      assert.match(output, /r refresh/);
      tui.hideOverlay();
    } finally {
      view.dispose();
      tui.stop();
    }
  });
}
