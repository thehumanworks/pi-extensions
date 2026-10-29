import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { BackgroundCompactionConfig } from "../src/config.ts";
import { PRESETS } from "../src/prompts.ts";

export const usage = (totalTokens = 0): Usage => ({
	input: totalTokens,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

/** `tokens` estimated tokens of text (Pi estimates four characters per token). */
export const words = (tokens: number, label = "x") => `${label} `.repeat(Math.ceil((tokens * 4) / (label.length + 1))).slice(0, tokens * 4);

export function assistant(text: string, extra: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "test",
		model: "test-model",
		stopReason: "stop",
		timestamp: Date.now(),
		usage: usage(),
		...extra,
	};
}

/** A session of `turns` user/assistant pairs, each about `tokens` tokens per message. */
export function session(turns: number, tokens = 1000) {
	const manager = SessionManager.inMemory("/tmp/project");
	const ids: string[] = [];
	for (let i = 0; i < turns; i++) {
		ids.push(manager.appendMessage({ role: "user", content: `question ${i} ${words(tokens)}`, timestamp: Date.now() }));
		ids.push(manager.appendMessage(assistant(`answer ${i} ${words(tokens)}`)));
	}
	return { manager, ids };
}

export function config(overrides: Partial<BackgroundCompactionConfig> = {}): BackgroundCompactionConfig {
	return {
		enabled: true,
		trigger: 0.8,
		minTokens: 0,
		swap: "threshold",
		thinking: "off",
		request: "serialized",
		prompts: PRESETS.coding!,
		promptName: "coding",
		toolResultChars: 2000,
		maxSwapRatio: 0.5,
		timeoutMs: 60_000,
		retries: 2,
		retryDelayMs: 10_000,
		...overrides,
	};
}

/** A promise with its resolvers, for summaries the test finishes by hand. */
export function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

export const tick = () => new Promise((resolve) => setImmediate(resolve));

/** Let background jobs make progress, for checks that nothing more happens. */
export const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

/** Resolves once `check` passes: summaries run as background jobs, so their effects land later. */
export async function until(check: () => boolean, what = "condition", ms = 5000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!check()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
}
