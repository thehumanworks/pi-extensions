import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatUsage } from "./src/format.ts";
import { createUsageProviders } from "./src/providers/index.ts";
import { collectUsage } from "./src/service.ts";
import type { UsageProvider } from "./src/types.ts";
import { UsageView } from "./src/view.ts";

export function registerUsage(pi: ExtensionAPI, providers: readonly UsageProvider[]): void {
  let active: AbortController | undefined;
  pi.on("session_shutdown", () => active?.abort());

  pi.registerCommand("usage", {
    description: "Show account usage limits and reset times (/usage [provider])",
    getArgumentCompletions: (prefix) => providers
      .filter((provider) => provider.id.startsWith(prefix.toLowerCase()))
      .map((provider) => ({ value: provider.id, label: provider.label })),
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/usage requires interactive Pi or an RPC client with notifications.", "warning");
        return;
      }
      const id = args.trim().toLowerCase();
      const selected = id ? providers.filter((provider) => provider.id === id) : providers;
      if (!selected.length) {
        ctx.ui.notify(`Usage: /usage [${providers.map((provider) => provider.id).join("|")}]`, "warning");
        return;
      }
      if (active) {
        ctx.ui.notify("An account usage view is already open.", "info");
        return;
      }
      const controller = new AbortController();
      active = controller;
      try {
        if (ctx.mode === "tui") {
          await ctx.ui.custom<void>((tui, theme, keys, done) => {
            const view = new UsageView(tui, theme, keys, () => done(), (signal) =>
              collectUsage(selected, ctx.modelRegistry, AbortSignal.any([signal, controller.signal])));
            controller.signal.addEventListener("abort", () => view.close(), { once: true });
            return view;
          }, { overlay: true, overlayOptions: { width: "90%", maxHeight: "85%" } });
        } else {
          const results = await collectUsage(selected, ctx.modelRegistry, controller.signal);
          if (!controller.signal.aborted) ctx.ui.notify(formatUsage(results), "info");
        }
      } catch {
        if (!controller.signal.aborted) ctx.ui.notify("Could not display account usage. Try /usage again.", "error");
      } finally {
        controller.abort();
        if (active === controller) active = undefined;
      }
    },
  });
}

export default function usageExtension(pi: ExtensionAPI): void {
  registerUsage(pi, createUsageProviders());
}
