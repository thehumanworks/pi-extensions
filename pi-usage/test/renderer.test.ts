import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Image, resetCapabilitiesCache, setCapabilities, TuiAltScreen, TuiMainScreen, Text, type Terminal } from "@earendil-works/pi-tui";
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
      tui.showOverlay(view, { width: "100%", maxHeight: "100%" });
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

// pi-tui skips overlay compositing on rows that anchor an image, then draws the image over the overlay.
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
for (const Renderer of [TuiMainScreen, TuiAltScreen]) {
  test(`real ${Renderer.name} hides chat images under the usage overlay and restores them on close`, async () => {
    setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
    let output = "";
    const terminal: Terminal = {
      columns: 90, rows: 30, kittyProtocolActive: false,
      start() {}, stop() {}, async drainInput() {}, write(data) { output += data; },
      moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {},
      clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {},
    };
    const tui = new Renderer(terminal);
    const placements = () => (output.match(/\x1b_Ga=[pT]/g) ?? []).length;
    let view: UsageView | undefined;
    try {
      for (let i = 0; i < 5; i++) tui.addChild(new Text(`chat line ${i}`));
      tui.addChild(new Image(png, "image/png", { fallbackColor: (text) => text }, { maxWidthCells: 40, maxHeightCells: 10 }, { widthPx: 400, heightPx: 200 }));
      tui.start();
      await delay(30);
      assert.ok(placements() > 0, "image is drawn before the overlay opens");
      view = new UsageView(tui, { fg: (_color, text) => text, bold: (text) => text }, { matches: () => false }, () => {}, async () => []);
      tui.showOverlay(view, { width: "100%", maxHeight: "100%" });
      output = "";
      tui.requestRender(true);
      await delay(30);
      assert.equal(placements(), 0, "image is not drawn over the overlay");
      assert.match(output, /Account usage/);
      tui.hideOverlay();
      view.dispose();
      output = "";
      await delay(30);
      assert.ok(placements() > 0, "image is drawn again after close");
    } finally {
      view?.dispose();
      tui.stop();
      resetCapabilitiesCache();
    }
  });
}
