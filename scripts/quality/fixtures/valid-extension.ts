import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

async function refresh(): Promise<void> {
  await Promise.resolve();
}

export default function extension(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    await refresh();
    if (ctx.hasUI) ctx.ui.notify("Ready", "info");
  });
  pi.on("session_shutdown", async () => {
    await refresh();
  });
}

// A deliberate background task still needs a rejection handler.
setTimeout(() => {
  refresh().catch((error: unknown) => {
    console.error(error);
  });
}, 10);
