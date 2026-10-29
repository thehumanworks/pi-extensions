import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatMessage, SafeMarkdown } from "../components/message";
import { Sidebar } from "../components/sidebar";

test("Markdown formats content without HTML, script URLs or remote image requests", () => {
  const html = renderToStaticMarkup(<SafeMarkdown text={'# Result\n\n**Ready** [link](https://example.com)\n\n<script>alert(1)</script>\n\n[unsafe](javascript:alert%281%29)\n\n![tracker](https://evil.invalid/pixel.png)'} />);
  assert.match(html, /<h1>Result<\/h1>/);
  assert.match(html, /<strong>Ready<\/strong>/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.doesNotMatch(html, /<script|href="javascript:|<img|pixel\.png/);
});
test("tool inputs/results are inert escaped details, never executable HTML", () => {
  const html = renderToStaticMarkup(<ChatMessage message={{ id: "a", role: "assistant", parts: [
    { type: "text", text: "Checking **files**" },
    { type: "data-bot-tool", id: "tool1", data: { toolCallId: "t1", toolName: "read_file", state: "completed", input: { path: "<img src=x onerror=alert(1)>" }, output: "<script>alert(1)</script>" } }
  ] }} />);
  assert.match(html, /<details/);
  assert.match(html, /<summary>/);
  assert.match(html, /read_file/);
  assert.match(html, /completed/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script|<img/);
});
test("user messages are plain escaped text, not interpreted Markdown or HTML", () => {
  const html = renderToStaticMarkup(<ChatMessage message={{ id: "u", role: "user", parts: [{ type: "text", text: "**literal** <button>not a button</button>" }] }} />);
  assert.match(html, /\*\*literal\*\*/);
  assert.match(html, /&lt;button&gt;/);
  assert.doesNotMatch(html, /<strong>|<button>/);
  assert.match(html, /aria-label="Your message"/);
});
test("sidebar exposes session navigation, selected state, refresh and new session", () => {
  const noop = () => {};
  const html = renderToStaticMarkup(<Sidebar sessions={[{ sessionId: "s1", title: "Working notes", cwd: "/private", createdAt: "2025-01-01", updatedAt: "2025-01-01" }]} selected="s1" loading={false} open={true} onSelect={noop} onNew={noop} onRefresh={noop} onClose={noop} />);
  assert.match(html, /aria-label="Conversation history"/);
  assert.match(html, /aria-current="page"/);
  assert.match(html, /New session/);
  assert.match(html, /aria-label="Refresh sessions"/);
  assert.doesNotMatch(html, /\/private/);
});
