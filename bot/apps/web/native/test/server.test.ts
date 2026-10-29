import { test, expect } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBotChatAdapter, type BotBackend, type BotRun } from "@nothumanwork/bot-ai-sdk";
import { createHandler, startServer } from "../server";
import { main, parseArgs } from "../main";

function fixture() {
  let cancelled = 0, detached = 0, submitted = 0;
  const run: BotRun = { runId: "r1", sessionId: "s1", bot: "test", cwd: "", status: "running", output: "", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 }, toolCalls: 0, createdAt: "", updatedAt: "" };
  const backend: BotBackend = {
    info: async () => ({ name: "offline", description: "test", revision: "1", tools: [], skills: [] }),
    listSessions: async () => [], getRun: async () => run,
    submit: async () => { submitted++; return run; },
    cancel: async () => { cancelled++; },
    watch: async (_id, listener) => {
      listener({ type: "snapshot", sessionId: "s1", runId: "r1", data: { entries: [] } });
      return async () => { detached++; };
    },
  };
  const adapter = createBotChatAdapter({ backend });
  return { adapter, counts: () => ({ cancelled, detached, submitted }) };
}

test("CLI grammar and non-network help/version", async () => {
  expect(parseArgs([])).toMatchObject({ host: "::1", port: 3001 });
  expect(parseArgs(["web", "--host", "::1", "--port", "4123", "--backend-url", "http://[::1]:9000"])).toMatchObject({ port: 4123, backendUrl: "http://[::1]:9000" });
  for (const args of [["--port", "0"], ["--port", "65536"], ["--port", "1x"], ["--host"], ["unexpected"]]) expect(() => parseArgs(args)).toThrow();
  await main(["--help"], new Map());
  await main(["web", "--version"], new Map());
  await expect(main(["--backend-url", "http://user:SECRET@host"], new Map())).rejects.toThrow("Invalid bot server configuration");
});

test("real IPv6 HTTP serves manifest only, HEAD/ETags, security and API guards", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bot-web-test-"));
  const file = join(dir, "embedded.html");
  await writeFile(file, "<html>same Next UI fixture</html>");
  const { adapter } = fixture();
  const running = startServer({ host: "::1", port: 0, assets: new Map([
    ["/index.html", { file, type: "text/html; charset=utf-8", etag: '"abc"' }],
    ["/_next/static/test.js", { file, type: "text/javascript", etag: '"js"' }],
  ]), getAdapter: () => adapter });
  const base = running.server.url.origin;
  try {
    const response = await fetch(base);
    expect(await response.text()).toContain("same Next UI");
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const head = await fetch(base, { method: "HEAD" });
    expect(await head.text()).toBe("");
    expect(head.headers.get("content-length")).toBe(String(Buffer.byteLength("<html>same Next UI fixture</html>")));
    expect((await fetch(base, { headers: { "if-none-match": 'W/"abc"' } })).status).toBe(304);
    expect((await fetch(`${base}/_next/static/test.js`)).headers.get("cache-control")).toContain("immutable");
    for (const path of ["/etc/passwd", "/not-a-route", "/%2e%2e%2fsecret", "/%zz"]) expect((await fetch(base + path)).status).toBeGreaterThanOrEqual(400);
    expect((await fetch(base, { method: "POST" })).status).toBe(405);
    expect((await fetch(`${base}/api/info`)).status).toBe(200);
    expect((await fetch(`${base}/api/missing`)).status).toBe(404);
    expect((await fetch(`${base}/api/info`, { method: "PUT" })).status).toBe(405);
    for (const headers of [{ origin: "https://evil.invalid" }, { host: "evil.invalid" }, { "sec-fetch-site": "cross-site" }] as HeadersInit[]) {
      expect((await fetch(`${base}/api/info`, { headers })).status).toBe(403);
    }
    const large = await fetch(`${base}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: "x".repeat(1024 * 1024 + 1) });
    expect(large.status).toBe(413);
  } finally { await running.stop(); await rm(dir, { recursive: true, force: true }); }
});

test("stream detachment and server shutdown do not cancel durable daemon work", async () => {
  const { adapter, counts } = fixture();
  const running = startServer({ host: "::1", port: 0, assets: new Map(), getAdapter: () => adapter });
  try {
    const response = await fetch(`${running.server.url.origin}/api/chat`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "chat1", messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "offline" }] }] }),
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    await Bun.sleep(30);
    expect(counts().submitted).toBe(1);
    expect(counts().cancelled).toBe(0);
    expect(counts().detached).toBeGreaterThanOrEqual(1);
    const observer = await fetch(`${running.server.url.origin}/api/chat?sessionId=s1&runId=r1`);
    const observerReader = observer.body!.getReader();
    await observerReader.read();
    await running.stop();
    expect(counts().cancelled).toBe(0);
    expect(counts().detached).toBeGreaterThanOrEqual(2);
  } finally { await running.stop(); }
  const handle = createHandler(new Map(), () => adapter);
  const cancel = await handle(new Request("http://[::1]:3001/api/runs/r1/cancel", { method: "POST" }));
  expect(cancel.status).toBe(200);
  expect(counts().cancelled).toBe(1);
});
