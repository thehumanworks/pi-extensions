import assert from "node:assert/strict";
import { test } from "node:test";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { serializeConversation as piSerialize } from "@earendil-works/pi-coding-agent";
import { CODING_PROMPTS } from "../src/prompts.ts";
import { formatFiles, requestSummary, serializeConversation, serializedRequest, stripFiles, transcriptRequest } from "../src/summarize.ts";
import { assistant, usage } from "./helpers.ts";

const style = { prompts: CODING_PROMPTS, toolResultChars: 2000 };
const model = { provider: "test", id: "m" } as Model<Api>;

test("serialization matches Pi's apart from the truncation marker", () => {
	const messages = [
		{ role: "user" as const, content: "fix the bug", timestamp: 0 },
		assistant("looking", { content: [{ type: "text", text: "looking" }, { type: "toolCall", id: "1", name: "read", arguments: { path: "a.ts" } }] }),
		{ role: "toolResult" as const, toolCallId: "1", toolName: "read", content: [{ type: "text" as const, text: "y".repeat(5000) }], isError: false, timestamp: 0 },
	];
	const marker = (text: string) => text.replace(/\n\n\[\.\.\. (\d+) more characters[^\]]*\]/g, "[cut $1]");
	assert.equal(marker(serializeConversation(messages, 2000)), marker(piSerialize(messages)));
	assert.match(serializeConversation(messages, 100), /\[\.\.\. 4900 more characters omitted from this transcript only; the assistant received the complete output\]/);
});

test("serialized requests carry the previous summary and focus", () => {
	const context = serializedRequest({ messages: [{ role: "user", content: "hello", timestamp: 0 }], previousSummary: "earlier" }, { ...style, focus: "tests" });
	assert.equal(context.systemPrompt, CODING_PROMPTS.system);
	const text = (context.messages[0]!.content as { text: string }[])[0]!.text;
	assert.match(text, /<conversation>\n\[User\]: hello\n<\/conversation>/);
	assert.match(text, /<previous-summary>\nearlier\n<\/previous-summary>/);
	assert.ok(text.includes(CODING_PROMPTS.update));
	assert.ok(text.endsWith("Additional focus: tests"));
});

test("transcript requests append one instruction to the native conversation", () => {
	const system = { role: "system" as const, content: "You are Pi.", timestamp: 0 };
	const context = transcriptRequest([system, { role: "user", content: "hi", timestamp: 0 }, assistant("hello")], style);
	assert.equal(context.systemPrompt, undefined);
	assert.equal(context.messages.length, 4);
	assert.equal(context.messages[0]!.role, "system");
	assert.equal(context.messages[3]!.role, "user");
});

test("file lists are replaced, not duplicated", () => {
	const files = { readFiles: ["a.ts"], modifiedFiles: ["b.ts"] };
	const copied = `## Objective\n- x${formatFiles({ readFiles: ["old.ts"], modifiedFiles: [] })}`;
	assert.equal(stripFiles(copied) + formatFiles(files), "## Objective\n- x\n\n<read-files>\na.ts\n</read-files>\n\n<modified-files>\nb.ts\n</modified-files>");
});

test("failed, truncated, and tool-calling replies are not summaries", async () => {
	const reply = (overrides: Partial<AssistantMessage>) => async () => ({ ...assistant("summary"), usage: usage(10), ...overrides });
	assert.equal((await requestSummary(reply({}), model, { messages: [] }, {})).text, "summary");
	await assert.rejects(requestSummary(reply({ stopReason: "length" }), model, { messages: [] }, {}), /output token limit/);
	await assert.rejects(requestSummary(reply({ content: [{ type: "toolCall", id: "1", name: "read", arguments: {} }] }), model, { messages: [] }, {}), /called a tool/);
	await assert.rejects(requestSummary(reply({ content: [] }), model, { messages: [] }, {}), /empty/);
	let calls = 0;
	const flaky = async () => (calls++ === 0 ? { ...assistant(""), stopReason: "error" as const, errorMessage: "overloaded" } : assistant("second try"));
	assert.equal((await requestSummary(flaky, model, { messages: [] }, {})).text, "second try");
});
