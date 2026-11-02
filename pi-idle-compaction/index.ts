import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type IdleCompactionConfig, readConfig } from "./src/config.ts";

export const ENTRY_TYPE = "idle-compaction";

export interface IdleCompactionEntry {
	tokensBefore: number;
	idleMinutes: number;
}

export function describe(entry: IdleCompactionEntry): string {
	return `Idle compaction: compacted ${entry.tokensBefore.toLocaleString("en-US")} tokens after ${entry.idleMinutes} min idle, since the prompt cache had expired.`;
}

/**
 * Compacts a large conversation once it has sat idle past the prompt cache
 * lifetime, so the next message re-reads a short summary instead of the whole
 * uncached history. Pi's port of Claude Code's idle compaction.
 */
export default function idleCompaction(pi: ExtensionAPI): void {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let armedContext: ExtensionContext | undefined;
	let lastConfigError: string | undefined;

	function cancel(): void {
		clearTimeout(timer);
		timer = undefined;
		armedContext = undefined;
	}

	function config(ctx: ExtensionContext): IdleCompactionConfig | undefined {
		try {
			const result = readConfig(pi.getSettings());
			lastConfigError = undefined;
			return result;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			// Warn once per distinct problem rather than after every turn.
			if (message !== lastConfigError && ctx.hasUI) ctx.ui.notify(`Idle compaction is off: ${message}`, "warning");
			lastConfigError = message;
			return undefined;
		}
	}

	function arm(ctx: ExtensionContext): void {
		cancel();
		const settings = config(ctx);
		if (!settings?.enabled) return;
		armedContext = ctx;
		timer = setTimeout(() => {
			timer = undefined;
			armedContext = undefined;
			fire(ctx, settings);
		}, settings.idleMinutes * 60_000);
		// Never keep a print-mode process alive just to compact.
		timer.unref?.();
	}

	function fire(ctx: ExtensionContext, settings: IdleCompactionConfig): void {
		if (!ctx.isIdle() || ctx.hasPendingMessages()) return;
		const tokens = ctx.getContextUsage()?.tokens;
		if (tokens == null || tokens < settings.tokenThreshold) return;
		// Pi shows the compaction progress, and reports failure or Escape-cancellation itself.
		ctx.compact({
			onComplete: (result) => {
				const entry: IdleCompactionEntry = {
					tokensBefore: result.tokensBefore,
					idleMinutes: settings.idleMinutes,
				};
				pi.appendEntry(ENTRY_TYPE, entry);
				// RPC clients do not draw custom entries.
				if (ctx.mode === "rpc") ctx.ui.notify(describe(entry), "info");
			},
		});
	}

	pi.registerEntryRenderer<IdleCompactionEntry>(ENTRY_TYPE, (entry, _options, theme) =>
		entry.data ? new Text(theme.fg("dim", theme.italic(describe(entry.data))), 1, 0) : undefined,
	);

	pi.on("session_start", (_event, ctx) => arm(ctx));
	pi.on("agent_settled", (_event, ctx) => arm(ctx));
	pi.on("agent_start", () => cancel());
	pi.on("session_shutdown", () => cancel());
	// A warm refresh while idle keeps the cache alive, so the idle clock starts again.
	pi.on("cache_warming_decision", (event) => {
		if (event.action === "warm" && armedContext) arm(armedContext);
	});
}
