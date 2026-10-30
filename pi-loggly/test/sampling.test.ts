import assert from "node:assert/strict";
import { test } from "node:test";
import { checkEstimates, covers, estimateCount, estimatePatterns, estimateTotals, isReliable, margin, MAX_RSE, MIN_WINDOWS, planWindows, sampleErrors, seededRandom, windowParts, type ErrorSample, type SampleClient } from "../src/analysis/sampling.ts";
import { LogglyRateLimitError } from "../src/sdk/errors.ts";
import type { CountParams, IterateParams, LogEvent } from "../src/sdk/types.ts";

const DAY = 86_400_000;
const START = Date.UTC(2026, 9, 29);

const event = (timestamp: number, message: string, app = "api"): LogEvent => ({ id: `${timestamp}-${message}`, timestamp, logmsg: "", tags: [], logtypes: ["json"], event: { json: { message, app } } });
const messageOf = (e: LogEvent) => String((e.event.json as { message: string }).message);

/** A fake Loggly over a fixed list of errors: search returns the newest in the range, count counts them. */
function population(events: LogEvent[]) {
  const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp);
  const times = sorted.map((e) => e.timestamp);
  const lowerBound = (t: number) => {
    let lo = 0;
    let hi = times.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid]! < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const range = (params: { from?: unknown; until?: unknown }) => [lowerBound((params.from as Date).getTime()), lowerBound((params.until as Date).getTime())] as const;
  const client = {
    searches: 0,
    counts: 0,
    async search(params: IterateParams, options: { limit: number }) {
      client.searches++;
      const [a, b] = range(params);
      return sorted.slice(Math.max(a, b - options.limit), b).reverse();
    },
    async count(params: CountParams) {
      client.counts++;
      const [a, b] = range(params);
      return { count: b - a };
    },
  };
  return client;
}

test("windows: one per equal slice at a random offset, sized for about 60 errors, reproducible from the seed", () => {
  const plan = planWindows(START, START + DAY, 144_000, 288, 7);
  assert.equal(plan.spans.length, 288);
  assert.equal(plan.windowMs, 36_000, "60 errors at the day's average rate of 1 per 600ms");
  const slice = DAY / 288;
  plan.spans.forEach((span, i) => {
    assert.ok(span.from >= START + i * slice && span.from < START + (i + 1) * slice, `window ${i} starts in its slice`);
    assert.equal(span.until - span.from, 36_000);
  });
  assert.deepEqual(planWindows(START, START + DAY, 144_000, 288, 7), plan, "the same seed draws the same windows");
  assert.notDeepEqual(planWindows(START, START + DAY, 144_000, 288, 8).spans, plan.spans);
  assert.equal(planWindows(START, START + DAY, 10, 288, 7).windowMs, Math.floor(slice), "a window never outgrows its slice");
  assert.equal(planWindows(START, START + DAY, 50_000_000, 288, 7).windowMs, 104, "busy days get sub-second windows");
  assert.deepEqual(planWindows(START, START + DAY, 0, 288, 7).spans, [], "nothing to sample");
  const offsets = Array.from({ length: 10_000 }, seededRandom(1));
  assert.ok(offsets.every((x) => x >= 0 && x < 1));
  assert.ok(Math.abs(offsets.reduce((a, b) => a + b, 0) / offsets.length - 0.5) < 0.01);
});

test("a window past the end of the period wraps round to its start, so every moment has the same chance", () => {
  const period = { from: 1000, until: 2000 };
  assert.deepEqual(windowParts({ from: 1500, until: 1600 }, period), [{ from: 1500, until: 1600 }]);
  assert.deepEqual(windowParts({ from: 1950, until: 2050 }, period), [{ from: 1950, until: 2000 }, { from: 1000, until: 1050 }]);
  // How often each millisecond falls in a window, over many seeds: window / slice everywhere, the first moments included.
  const hits = new Array(1000).fill(0);
  const runs = 4000;
  for (let seed = 0; seed < runs; seed++) {
    for (const span of planWindows(1000, 2000, 1000, 4, seed).spans) {
      for (const part of windowParts(span, period)) for (let t = part.from; t < part.until; t++) hits[t - 1000]++;
    }
  }
  const rate = (from: number, until: number) => hits.slice(from, until).reduce((a, b) => a + b, 0) / (until - from) / runs;
  // 1,000 errors over 1,000ms: windows of 60ms in slices of 250ms, so 24% of runs cover each moment. Without wrapping, the first 50ms would get about 10%.
  for (const [from, until] of [[0, 50], [450, 550], [950, 1000]]) assert.ok(Math.abs(rate(from!, until!) - 0.24) < 0.02, `${from}–${until}ms: ${rate(from!, until!)}`);
});

test("estimates scale the sampled errors by slice / window, with standard errors from the spread between windows", () => {
  // Three windows of 100ms over 3s: each stands for 10 times its length.
  const sample = {
    from: 0,
    until: 3000,
    design: { windows: 3, windowMs: 100, seed: 1 },
    windows: [
      { from: 0, until: 100, count: 4, events: [event(0, "a"), event(0, "b")], weights: [2, 2] },
      { from: 1000, until: 1100, count: 2, events: [event(1000, "a"), event(1000, "a")] },
      { from: 2000, until: 2100, count: 0, events: [] },
    ],
  };
  const estimates = estimateTotals(sample, messageOf);
  // y(a) = [2, 2, 0] and y(b) = [2, 0, 0]: both have variance 4/3, so the standard error is 10 × √(3 × 4/3) = 20.
  assert.deepEqual(estimates.get("a"), { estimate: 40, se: 20, windows: 2, sampled: 3 });
  assert.deepEqual(estimates.get("b"), { estimate: 20, se: 20, windows: 1, sampled: 1 });
  const count = estimateCount(sample);
  assert.equal(count.estimate, 60);
  assert.ok(Math.abs(count.se - 10 * Math.sqrt(12)) < 1e-9);
  assert.equal(margin({ se: 10 }), 19.6);
  assert.equal(covers({ estimate: 100, se: 10 }, 119), true);
  assert.equal(covers({ estimate: 100, se: 10 }, 120), false);
  assert.equal(estimateTotals({ ...sample, design: { windows: 1, windowMs: 100, seed: 1 }, windows: [sample.windows[0]!] }, messageOf).size, 0, "one window gives no estimate");
});

test("an estimate is used only when seen in 10 windows and within 30%; checks list their misses, worst first", () => {
  assert.equal(MIN_WINDOWS, 10);
  assert.equal(MAX_RSE, 0.3);
  assert.equal(isReliable({ estimate: 1000, se: 300, windows: 10, sampled: 40 }), true);
  assert.equal(isReliable({ estimate: 1000, se: 301, windows: 10, sampled: 40 }), false, "too imprecise");
  assert.equal(isReliable({ estimate: 1000, se: 10, windows: 9, sampled: 400 }), false, "too few windows, however precise it looks");
  const estimates = new Map([
    ["inside", { estimate: 1000, se: 100, windows: 20, sampled: 50 }],
    ["outside", { estimate: 1000, se: 100, windows: 20, sampled: 50 }],
    ["far outside", { estimate: 1000, se: 100, windows: 20, sampled: 50 }],
    ["unreliable", { estimate: 1000, se: 900, windows: 20, sampled: 50 }],
    ["no exact count", { estimate: 1000, se: 100, windows: 20, sampled: 50 }],
  ]);
  const check = checkEstimates(estimates, new Map([["inside", 1150], ["outside", 1250], ["far outside", 2000], ["unreliable", 5000]]));
  assert.deepEqual([check.checked, check.inside], [3, 1]);
  assert.deepEqual(check.misses.map((miss) => [miss.key, miss.exact]), [["far outside", 2000], ["outside", 1250]]);
});

/**
 * A day of 69,000 errors: steady and cyclic patterns, one that only comes in
 * six dense bursts, and a long tail of rare messages.
 */
function syntheticDay(): { events: LogEvent[]; truth: Map<string, number> } {
  const random = seededRandom(42);
  const events: LogEvent[] = [];
  const add = (count: number, message: string, app: string, time: () => number) => {
    for (let i = 0; i < count; i++) events.push(event(Math.floor(time()), message, app));
  };
  const uniform = () => START + random() * DAY;
  add(30_000, "Redis timeout after <n>ms", "api", uniform);
  add(10_000, "Forbidden", "api", uniform);
  // Busier by day: density proportional to 1 + sin.
  add(8_000, "Queue full", "worker", () => {
    for (;;) {
      const t = random();
      if (random() * 2 < 1 + Math.sin(2 * Math.PI * t)) return START + t * DAY;
    }
  });
  const bursts = Array.from({ length: 6 }, () => START + random() * (DAY - 120_000));
  add(12_000, "Batch import failed", "batch", () => bursts[Math.floor(random() * 6)]! + random() * 120_000);
  for (let i = 0; i < 300; i++) add(30, `Rare failure ${String.fromCharCode(97 + (i % 26))}${i}`, "misc", uniform);
  const truth = new Map<string, number>();
  for (const e of events) truth.set(messageOf(e), (truth.get(messageOf(e)) ?? 0) + 1);
  return { events, truth };
}

test("on a synthetic day, estimates are unbiased, 95% intervals hold the truth about 95% of the time, and bursts are held back", async () => {
  const { events, truth } = syntheticDay();
  const client = population(events);
  const runs = 40;
  let checked = 0;
  let inside = 0;
  const steady: number[] = [];
  const totals: number[] = [];
  let burstyReliable = 0;
  let tailReliable = 0;
  let stretched = 0;
  for (let seed = 1; seed <= runs; seed++) {
    const sample = await sampleErrors(client, "*", START, START + DAY, events.length, { windows: 288, seed });
    const estimates = estimateTotals(sample, messageOf);
    const check = checkEstimates(estimates, truth);
    checked += check.checked;
    inside += check.inside;
    steady.push(estimates.get("Redis timeout after <n>ms")!.estimate);
    totals.push(estimateCount(sample).estimate);
    if (isReliable(estimates.get("Batch import failed") ?? { estimate: 0, se: 0, windows: 0, sampled: 0 })) burstyReliable++;
    for (const [key, e] of estimates) if (key.startsWith("Rare failure") && isReliable(e)) tailReliable++;
    stretched += sample.windows.filter((window) => window.weights).length;
  }
  const coverage = inside / checked;
  assert.ok(checked >= runs * 3, `steady and cyclic patterns are estimated in most runs (${checked})`);
  assert.ok(coverage >= 0.92 && coverage <= 0.99, `coverage ${coverage.toFixed(3)} is close to 95%`);
  const average = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
  assert.ok(Math.abs(average(steady) / 30_000 - 1) < 0.01, `the steady pattern is estimated without bias, bursts or not (${Math.round(average(steady))})`);
  assert.ok(Math.abs(average(totals) / events.length - 1) < 0.05, `so is the day's total (${Math.round(average(totals))})`);
  assert.ok(stretched > 0, "windows inside bursts are sampled in stretches");
  assert.ok(burstyReliable <= runs / 4, `six bursts are rarely enough to estimate (${burstyReliable} of ${runs})`);
  assert.ok(tailReliable < 300 * runs * 0.2, `messages seen 30 times a day are mostly held back (${tailReliable} of ${300 * runs})`);
});

test("a window with more than a page is counted and sampled in a random stretch, scaled up", async () => {
  // One error every 10ms for 10s, but sized as if there were 100: two windows of 5s, each holding 500.
  const steady = Array.from({ length: 1000 }, (_, i) => event(START + i * 10, i % 4 ? "a" : "b"));
  const client = population(steady);
  const sample = await sampleErrors(client, "*", START, START + 10_000, 100, { windows: 2, seed: 3 });
  assert.deepEqual(sample.design, { windows: 2, windowMs: 5000, seed: 3 });
  for (const window of sample.windows) {
    assert.equal(window.count, 500, "the window is counted exactly");
    assert.ok(window.weights && window.events.length < 200, "only a stretch is fetched");
    const standsFor = window.weights.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(standsFor / 500 - 1) < 0.05, `the stretch stands for the window (${standsFor})`);
  }
  assert.equal(estimateCount(sample).estimate, 1000);
  assert.ok(client.counts >= 2);
});

test("sampling waits out rate limits, then gives up", async () => {
  const expected = planWindows(START, START + 1000, 10, 2, 1).spans.reduce((sum, span) => sum + windowParts(span, { from: START, until: START + 1000 }).length, 0);
  let calls = 0;
  const limited: SampleClient = {
    async search() {
      calls++;
      if (calls === 1) throw new LogglyRateLimitError({ status: 429 });
      return [];
    },
    async count() {
      return { count: 0 };
    },
  };
  const waited = await sampleErrors(limited, "*", START, START + 1000, 10, { windows: 2, seed: 1, rateLimitWaitsMs: [0] });
  assert.equal(waited.windows.length, 2);
  assert.equal(calls, expected + 1, "the limited request is retried");
  const always: SampleClient = { search: async () => Promise.reject(new LogglyRateLimitError({ status: 429 })), count: async () => ({ count: 0 }) };
  await assert.rejects(sampleErrors(always, "*", START, START + 1000, 10, { windows: 2, seed: 1, rateLimitWaitsMs: [0, 0] }), LogglyRateLimitError);
});

test("pattern estimates group messages, name their systems, skip what is counted elsewhere and total the rest", () => {
  // Twenty windows of 1ms over 1s: each stands for 50.
  const windows = Array.from({ length: 20 }, (_, i) => ({
    from: i * 50,
    until: i * 50 + 1,
    count: 3,
    events: [event(START + i, `Redis timeout after ${i}ms`, "api"), event(START + i, `Redis timeout after ${i + 1}ms`, "worker"), event(START + i, i === 3 ? "Disk full" : "Forbidden", "api")],
  }));
  const sample: ErrorSample = { from: 0, until: 1000, design: { windows: 20, windowMs: 1, seed: 1 }, total: 3000, windows };
  const patterns = estimatePatterns(sample, { messageFields: ["json.message"], groupBy: "json.app" });
  assert.deepEqual(patterns.rows.map((r) => [r.template, Math.round(r.estimate), r.windows]), [["Redis timeout after <n>ms", 2000, 20], ["Forbidden", 950, 19]]);
  assert.deepEqual(patterns.rows[0]!.systems, [{ name: "api", share: 0.5 }, { name: "worker", share: 0.5 }]);
  assert.equal(Math.round(patterns.other), 50, "Disk full, seen once, is part of the rest");
  assert.deepEqual([patterns.seen, patterns.sampled], [3, 60]);
  const apiOnly = estimatePatterns(sample, { messageFields: ["json.message"], groupBy: "json.app", skip: (e) => (e.event.json as { app: string }).app === "worker" });
  assert.equal(Math.round(apiOnly.rows[0]!.estimate), 1000);
  assert.equal(apiOnly.sampled, 40);
});
