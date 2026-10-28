import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Load explicitly with: pi -e ./examples/quality/hello.ts
export default function hello(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    // Await the Pi API: its promise is not safe to discard or hide behind `void`.
    const name = await ctx.ui.input("Hello", "What should I call you?");
    if (name) ctx.ui.notify(`Hello, ${name}!`, "info");
  });
}
