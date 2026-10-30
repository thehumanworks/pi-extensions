import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  LogglyApiError,
  LogglyAuthenticationError,
  LogglyClient,
  LogglyError,
  LogglyPaginationError,
  LogglyPermissionError,
  LogglyRateLimitError,
  LogglyResponseError,
  LogglyTransportError,
  parseDuration,
  resolveTime,
  SDK_VERSION,
} from "../src/sdk/index.ts";

test("the SDK reports the package version in its User-Agent", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  assert.equal(SDK_VERSION, pkg.version);
});

type Reply = { status?: number; body?: unknown; text?: string; headers?: Record<string, string> } | Error;

function fakeFetch(replies: Reply[] | ((url: URL) => Reply)) {
  const requests: Array<{ url: URL; headers: Record<string, string>; redirect?: string }> = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push({ url, headers: init?.headers as Record<string, string>, redirect: init?.redirect });
    const reply = typeof replies === "function" ? replies(url) : replies.shift();
    if (!reply) throw new Error("unexpected request");
    if (reply instanceof Error) throw reply;
    const text = reply.text ?? JSON.stringify(reply.body ?? {});
    return new Response(text, { status: reply.status ?? 200, headers: reply.headers });
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}

const client = (replies: Reply[] | ((url: URL) => Reply), options: Partial<ConstructorParameters<typeof LogglyClient>[0]> = {}) => {
  const fake = fakeFetch(replies);
  return { ...fake, client: new LogglyClient({ subdomain: "Acme", apiToken: "token-123", retryBackoffMs: 0, fetch: fake.fetch, ...options }) };
};

const event = (id: string, extra: Record<string, unknown> = {}) => ({ id, timestamp: 1_700_000_000_000, logmsg: `message ${id}`, event: { json: { level: "error" } }, tags: ["api"], logtypes: ["json"], ...extra });

test("validates credentials and options before any request", () => {
  assert.throws(() => new LogglyClient({ subdomain: "https://acme.loggly.com", apiToken: "x" }), /subdomain/);
  assert.throws(() => new LogglyClient({ subdomain: "acme", apiToken: "has space" }), /apiToken/);
  assert.throws(() => new LogglyClient({ subdomain: "acme", apiToken: "x", maxConcurrency: 0 }), /maxConcurrency/);
  assert.throws(() => LogglyClient.fromEnv({ LOGGLY_SUBDOMAIN: "acme" }), (error: unknown) => error instanceof LogglyError && /LOGGLY_API_TOKEN/.test(error.message));
  assert.equal(LogglyClient.fromEnv({ LOGGLY_SUBDOMAIN: "Acme", LOGGLY_API_TOKEN: " t " }).origin, "https://acme.loggly.com");
});

test("count encodes the search with %20 spaces, bearer auth and no redirects", async () => {
  const { client: c, requests } = client([{ body: { count: 42, volume: 1024 } }]);
  assert.deepEqual(await c.count({ query: "json.level:error AND tag:\"my app\"", from: "-1h", includeVolume: true }), { count: 42, volumeBytes: 1024 });
  const [request] = requests;
  assert.equal(request!.url.origin + request!.url.pathname, "https://acme.loggly.com/apiv2/events/count");
  assert.match(request!.url.search, /q=json.level%3Aerror%20AND%20tag%3A%22my%20app%22/);
  assert.equal(request!.url.searchParams.get("from"), "-1h");
  assert.equal(request!.url.searchParams.get("until"), "now");
  assert.equal(request!.url.searchParams.get("include_volume"), "true");
  assert.equal(request!.headers.Authorization, "Bearer token-123");
  assert.equal(request!.redirect, "manual");
});

test("dates are sent as ISO 8601 UTC", async () => {
  const { client: c, requests } = client([{ body: { count: 1 } }]);
  await c.count({ from: new Date("2026-10-30T09:00:00+01:00"), until: new Date(Date.UTC(2026, 9, 30, 9)) });
  assert.equal(requests[0]!.url.searchParams.get("from"), "2026-10-30T08:00:00.000Z");
  assert.equal(requests[0]!.url.searchParams.get("until"), "2026-10-30T09:00:00.000Z");
});

test("facet parses terms, keeps numeric terms as text and validates sizes", async () => {
  const { client: c, requests } = client([{ body: { total_events: 10, unique_field_count: 3, "json.status": [{ term: 500, count: 6 }, { term: "404", count: 3 }] } }]);
  const facet = await c.facet("json.status", { query: "*", from: "-5m", size: 2 });
  assert.deepEqual(facet, { field: "json.status", totalEvents: 10, uniqueCount: 3, terms: [{ term: "500", count: 6 }, { term: "404", count: 3 }], truncated: true });
  assert.equal(requests[0]!.url.pathname, "/apiv2/fields/json.status/");
  assert.equal(requests[0]!.url.searchParams.get("facet_size"), "2");
  await assert.rejects(c.facet("json.status", { size: 301 }), /size must be an integer from 1 to 300/);
  await assert.rejects(c.facet("bad/field"), /field must be/);
});

test("fields lists names and an absent facet field is an empty result", async () => {
  const { client: c } = client([{ body: { fields: [{ name: "tag" }, { name: "json.level" }, { name: "tag" }] } }, { body: { total_events: 5, unique_field_count: 0, "no.field": [] } }]);
  assert.deepEqual(await c.fields({ size: 10 }), ["tag", "json.level"]);
  assert.deepEqual((await c.facet("no.field")).terms, []);
});

test("a facet that fills the requested size is truncated, since Loggly caps its distinct count", async () => {
  const { client: c } = client([
    { body: { total_events: 9, unique_field_count: 2, app: [{ term: "a", count: 5 }, { term: "b", count: 4 }] } },
    { body: { total_events: 9, unique_field_count: 2, app: [{ term: "a", count: 5 }, { term: "b", count: 4 }] } },
  ]);
  assert.equal((await c.facet("app", { size: 2 })).truncated, true);
  assert.equal((await c.facet("app", { size: 3 })).truncated, false);
});

test("pages follows validated continuation URLs verbatim and stops at the limit", async () => {
  const next = "https://acme.loggly.com/apiv2/events/iterate?next=abc";
  const { client: c, requests } = client([
    { body: { events: [event("1"), event("2")], next } },
    { body: { events: [event("3")] } },
  ]);
  const ids: string[] = [];
  for await (const e of c.events({ query: "*", size: 2 })) ids.push(e.id);
  assert.deepEqual(ids, ["1", "2", "3"]);
  assert.equal(requests[1]!.url.href, next);
  assert.equal(requests[0]!.url.searchParams.get("order"), "desc");
  assert.equal(requests[0]!.url.searchParams.get("size"), "2");

  const limited = client([{ body: { events: [event("1"), event("2")], next } }]);
  assert.deepEqual((await limited.client.search({}, { limit: 1 })).map((e) => e.id), ["1"]);
  assert.equal(limited.requests[0]!.url.searchParams.get("size"), "1");
});

test("unsafe or repeated pagination URLs are rejected before the token is sent", async () => {
  for (const next of ["https://evil.example/apiv2/events/iterate?next=1", "http://acme.loggly.com/apiv2/events/iterate?next=1", "https://acme.loggly.com/apiv2/other?next=1", "https://user:pw@acme.loggly.com/apiv2/events/iterate"]) {
    const { client: c, requests } = client([{ body: { events: [], next } }]);
    await assert.rejects(c.page(), LogglyPaginationError);
    assert.equal(requests.length, 1);
  }
  const loop = "https://acme.loggly.com/apiv2/events/iterate?next=same";
  const { client: c } = client(() => ({ body: { events: [event("x")], next: loop } }));
  await assert.rejects(async () => {
    for await (const _ of c.pages()) {
      // drain
    }
  }, LogglyPaginationError);
});

test("events are validated and normalised; unknown fields are ignored", async () => {
  const { client: c } = client([{ body: { events: [{ id: "1", timestamp: 5, extra: true }] } }, { body: { events: [{ id: 1, timestamp: 5 }] } }]);
  assert.deepEqual((await c.page()).events[0], { id: "1", timestamp: 5, logmsg: "", event: {}, tags: [], logtypes: [] });
  await assert.rejects(c.page(), LogglyResponseError);
});

test("HTTP errors map to typed errors with Loggly's short message and request id only", async () => {
  const cases: Array<[number, unknown, new (...args: never[]) => Error]> = [
    [401, { message: "Unauthorized" }, LogglyAuthenticationError],
    [403, { errors: [{ general: "You do not have permission to perform this action." }] }, LogglyPermissionError],
    [400, { message: "idmessageclientError" }, LogglyApiError],
  ];
  for (const [status, body, type] of cases) {
    const { client: c } = client([{ status, body, headers: { "x-loggly-request-uuid": "req-1" } }]);
    await assert.rejects(c.count(), (error: unknown) => {
      assert.ok(error instanceof type);
      assert.equal((error as LogglyApiError).status, status);
      assert.equal((error as LogglyApiError).requestId, "req-1");
      return true;
    });
  }
  const { client: c } = client([{ status: 404, text: "<html>private log line</html>" }]);
  await assert.rejects(c.count(), (error: unknown) => error instanceof LogglyApiError && !error.message.includes("private") && error.serverMessage === undefined);
});

test("a generic HTTP 500 (malformed query) is not retried and explains why", async () => {
  const { client: c, requests } = client([{ status: 500, body: { message: "Server error" } }, { body: { count: 1 } }]);
  await assert.rejects(c.count({ query: "json.level:(error" }), /HTTP 500 \(Server error\).*malformed queries/);
  assert.equal(requests.length, 1);
});

test("throttling, gateway errors, 500 timeouts and network failures are retried within the budget", async () => {
  const { client: c, requests } = client([
    { status: 503, body: {}, headers: { "retry-after": "0" } },
    { status: 500, body: { message: "timeout" } },
    { body: { count: 7 } },
  ]);
  assert.equal((await c.count()).count, 7);
  assert.equal(requests.length, 3);

  const exhausted = client([{ status: 429, body: {} }, { status: 429, body: {} }, { status: 429, body: {} }]);
  await assert.rejects(exhausted.client.count(), LogglyRateLimitError);
  assert.equal(exhausted.requests.length, 3);

  const network = client([new TypeError("fetch failed"), { body: { count: 1 } }]);
  assert.equal((await network.client.count()).count, 1);
  const down = client([new TypeError("fetch failed")], { maxRetries: 0 });
  await assert.rejects(down.client.count(), LogglyTransportError);
});

test("a Retry-After longer than the maximum delay fails instead of waiting", async () => {
  const { client: c, requests } = client([{ status: 503, body: {}, headers: { "retry-after": "120" } }], { maxRetryDelayMs: 1000 });
  await assert.rejects(c.count(), LogglyRateLimitError);
  assert.equal(requests.length, 1);
});

test("per-attempt timeouts become transport errors; caller aborts propagate unchanged", async () => {
  const hanging = (async (_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      if (init?.signal?.aborted) return reject(init.signal.reason);
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
    })) as typeof fetch;
  const slow = new LogglyClient({ subdomain: "acme", apiToken: "t", fetch: hanging, timeoutMs: 10, maxRetries: 0 });
  // AbortSignal.timeout is unref'd; a fake fetch holds no socket open, so keep Node alive.
  const keepAlive = setTimeout(() => {}, 1000);
  await assert.rejects(slow.count(), (error: unknown) => error instanceof LogglyTransportError && /timed out after 10ms/.test(error.message));
  clearTimeout(keepAlive);
  let fetched = 0;
  const counting = (async (input: string | URL | Request, init?: RequestInit) => {
    fetched++;
    return hanging(input, init);
  }) as typeof fetch;
  const controller = new AbortController();
  const pending = new LogglyClient({ subdomain: "acme", apiToken: "t", fetch: counting }).count({}, { signal: controller.signal });
  controller.abort(new Error("stop"));
  await assert.rejects(pending, /stop/);
  assert.equal(fetched, 0, "an abort while waiting for a slot sends no request");
  const inflight = new AbortController();
  const started = new LogglyClient({ subdomain: "acme", apiToken: "t", fetch: counting }).count({}, { signal: inflight.signal });
  await new Promise((resolve) => setTimeout(resolve, 5));
  inflight.abort(new Error("stop again"));
  await assert.rejects(started, /stop again/);
  assert.equal(fetched, 1);
});

test("concurrency is limited across requests", async () => {
  let active = 0;
  let peak = 0;
  const fetch = (async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    return new Response(JSON.stringify({ count: 1 }));
  }) as typeof globalThis.fetch;
  const c = new LogglyClient({ subdomain: "acme", apiToken: "t", fetch, maxConcurrency: 2 });
  await Promise.all(Array.from({ length: 6 }, () => c.count()));
  assert.equal(peak, 2);
});

test("account details never expose customer tokens", async () => {
  const { client: c } = client([{ body: { subdomain: "Acme", tokens: ["secret-ingest-token"], subscription: { retention_days: 30, volume_limit_mb: "50000.0" } } }]);
  const account = await c.account();
  assert.deepEqual(account, { subdomain: "Acme", retentionDays: 30, volumeLimitMb: 50000 });
  assert.ok(!JSON.stringify(account).includes("secret"));
});

test("volume metrics accept the live snake_case shape and repeated parameters", async () => {
  const { client: c, requests } = client([{ body: [{ metric: "accepted", tags: ["api"], start_timestamp: 1700000000, end_timestamp: "1700003600", count: 5, volume_bytes: 99 }] }]);
  const rows = await c.volumeMetrics({ from: "-1h", until: "now", groupBy: ["tag", "host"], measurementTypes: ["count"] });
  assert.deepEqual(rows, [{ metric: "accepted", start: 1_700_000_000_000, end: 1_700_003_600_000, count: 5, volumeBytes: 99, tags: ["api"] }]);
  assert.deepEqual(requests[0]!.url.searchParams.getAll("group_by"), ["tag", "host"]);
});

test("search links open Loggly's web search", () => {
  const c = new LogglyClient({ subdomain: "acme", apiToken: "t" });
  const url = new URL(c.searchUrl({ query: "tag:api", from: "-1h" }));
  assert.equal(url.origin + url.pathname, "https://acme.loggly.com/search/");
  assert.equal(url.searchParams.get("terms"), "tag:api");
  assert.equal(url.searchParams.get("from"), "-1h");
});

test("time helpers resolve Loggly's relative syntax", () => {
  const now = Date.UTC(2026, 9, 30, 10);
  assert.equal(resolveTime("now", now), now);
  assert.equal(resolveTime("-15m", now), now - 900_000);
  assert.equal(resolveTime("-1d", now), now - 86_400_000);
  assert.equal(resolveTime("2026-10-30T09:00:00Z", now), Date.UTC(2026, 9, 30, 9));
  assert.throws(() => resolveTime("yesterday", now), /Unsupported time/);
  assert.equal(parseDuration("10m"), 600_000);
  assert.equal(parseDuration("0m", { allowZero: true }), 0);
  assert.throws(() => parseDuration("0m"), /positive/);
  assert.throws(() => parseDuration("10 minutes"), /Invalid duration/);
});
