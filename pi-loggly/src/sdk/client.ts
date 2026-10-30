import { apiErrorFor, LogglyError, LogglyPaginationError, LogglyResponseError, LogglyTransportError } from "./errors.ts";
import { formatTime } from "./time.ts";
import type {
  AccountInfo,
  CountParams,
  EventCount,
  EventPage,
  FacetParams,
  FacetResult,
  FieldsParams,
  IterateParams,
  LogEvent,
  RequestOptions,
  SearchParams,
  VolumeMetric,
  VolumeMetricsParams,
} from "./types.ts";

export const SDK_VERSION = "0.2.0";

export interface LogglyClientOptions {
  /** The account's subdomain label, e.g. "acme" for acme.loggly.com. */
  subdomain: string;
  /** An API token from Loggly Settings → API Tokens (not the customer/ingestion token). */
  apiToken: string;
  /** Per-attempt timeout in milliseconds. Default 60,000. */
  timeoutMs?: number;
  /** Extra attempts after the first for retryable failures. Default 2. */
  maxRetries?: number;
  /** Initial exponential backoff in milliseconds. Default 500. */
  retryBackoffMs?: number;
  /** Longest wait honoured, including server Retry-After. Default 30,000. */
  maxRetryDelayMs?: number;
  /** Maximum concurrent requests from this client; Loggly throttles bursts with HTTP 503. Default 4. */
  maxConcurrency?: number;
  /** Replaceable fetch implementation, for tests or proxies. */
  fetch?: typeof fetch;
}

const ITERATE_PATH = "/apiv2/events/iterate";
// Loggly documents 500 as retryable only when it describes a timeout; malformed
// queries also produce a generic 500, which must not be retried.
const RETRY_STATUSES = new Set([429, 502, 503, 504]);

/**
 * A typed client for Loggly's retrieval APIs: counts, field facets, paginated
 * event iteration, volume metrics and account details.
 *
 * Requests share a concurrency limit. Redirects are never followed and
 * pagination URLs are validated before the token is sent to them.
 */
export class LogglyClient {
  readonly subdomain: string;
  readonly origin: string;
  readonly #headers: Record<string, string>;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;
  readonly #backoffMs: number;
  readonly #maxDelayMs: number;
  readonly #limiter: Semaphore;

  constructor(options: LogglyClientOptions) {
    const subdomain = String(options.subdomain ?? "").trim().toLowerCase();
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(subdomain)) {
      throw new TypeError("subdomain must be the Loggly account label (e.g. \"acme\"), not a URL");
    }
    const token = String(options.apiToken ?? "");
    if (!token || /[^\x21-\x7e]/.test(token)) throw new TypeError("apiToken must be non-empty printable ASCII without whitespace");
    this.subdomain = subdomain;
    this.origin = `https://${subdomain}.loggly.com`;
    this.#headers = { Authorization: `Bearer ${token}`, Accept: "application/json", "User-Agent": `pi-loggly-sdk/${SDK_VERSION}` };
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = positive(options.timeoutMs ?? 60_000, "timeoutMs");
    this.#maxRetries = nonNegativeInteger(options.maxRetries ?? 2, "maxRetries");
    this.#backoffMs = nonNegative(options.retryBackoffMs ?? 500, "retryBackoffMs");
    this.#maxDelayMs = nonNegative(options.maxRetryDelayMs ?? 30_000, "maxRetryDelayMs");
    this.#limiter = new Semaphore(positiveInteger(options.maxConcurrency ?? 4, "maxConcurrency"));
  }

  /** Create a client from LOGGLY_SUBDOMAIN and LOGGLY_API_TOKEN. */
  static fromEnv(env: Record<string, string | undefined> = process.env, options: Omit<LogglyClientOptions, "subdomain" | "apiToken"> = {}): LogglyClient {
    const missing = ["LOGGLY_SUBDOMAIN", "LOGGLY_API_TOKEN"].filter((name) => !env[name]?.trim());
    if (missing.length) throw new LogglyError(`Loggly is not configured: set ${missing.join(" and ")} in the environment`);
    return new LogglyClient({ ...options, subdomain: env.LOGGLY_SUBDOMAIN!, apiToken: env.LOGGLY_API_TOKEN!.trim() });
  }

  /** Count events matching a search, optionally with their total size. */
  async count(params: CountParams = {}, options: RequestOptions = {}): Promise<EventCount> {
    const body = await this.#get("/apiv2/events/count", { ...searchParams(params), include_volume: params.includeVolume ? "true" : undefined }, options.signal);
    if (!isRecord(body) || !isCount(body.count)) throw new LogglyResponseError("Loggly returned an invalid event count");
    const result: EventCount = { count: body.count };
    if (isCount(body.volume)) result.volumeBytes = body.volume;
    return result;
  }

  /** List the names of fields present in matching events (at most 500). */
  async fields(params: FieldsParams = {}, options: RequestOptions = {}): Promise<string[]> {
    const size = rangeInteger(params.size ?? 100, 1, 500, "size");
    const body = await this.#get("/apiv2/fields/", { ...searchParams(params), facet_size: size }, options.signal);
    if (!isRecord(body) || !Array.isArray(body.fields)) throw new LogglyResponseError("Loggly returned an invalid field list");
    const names = body.fields.map((entry) => (isRecord(entry) && typeof entry.name === "string" ? entry.name : undefined));
    if (names.some((name) => name === undefined)) throw new LogglyResponseError("Loggly returned an invalid field list");
    return [...new Set(names as string[])].slice(0, size);
  }

  /** The most frequent values of one field in matching events, with counts (at most 300). */
  async facet(field: string, params: FacetParams = {}, options: RequestOptions = {}): Promise<FacetResult> {
    if (typeof field !== "string" || !field.trim() || /[\s/?#\\]/.test(field)) throw new TypeError("field must be a Loggly field name such as json.level");
    const size = rangeInteger(params.size ?? 10, 1, 300, "size");
    const body = await this.#get(`/apiv2/fields/${encodeURIComponent(field)}/`, { ...searchParams(params), facet_size: size }, options.signal);
    if (!isRecord(body) || !isCount(body.total_events)) throw new LogglyResponseError("Loggly returned an invalid field facet");
    const values = body[field] ?? [];
    if (!Array.isArray(values)) throw new LogglyResponseError("Loggly returned an invalid field facet");
    const terms = values.map((entry) => {
      if (!isRecord(entry) || !isCount(entry.count) || (typeof entry.term !== "string" && typeof entry.term !== "number" && typeof entry.term !== "boolean")) {
        throw new LogglyResponseError("Loggly returned an invalid field facet");
      }
      return { term: String(entry.term), count: entry.count };
    });
    const uniqueCount = isCount(body.unique_field_count) ? body.unique_field_count : terms.length;
    return { field, totalEvents: body.total_events, uniqueCount, terms, truncated: uniqueCount > terms.length || terms.length >= size };
  }

  /** Fetch the first page of a search. */
  async page(params: IterateParams = {}, options: RequestOptions = {}): Promise<EventPage> {
    const size = rangeInteger(params.size ?? 50, 1, 1000, "size");
    const order = params.order ?? "desc";
    if (order !== "asc" && order !== "desc") throw new TypeError("order must be \"asc\" or \"desc\"");
    return parsePage(await this.#get(ITERATE_PATH, { ...searchParams(params), size, order }, options.signal), this.origin);
  }

  /** Fetch a continuation page. The URL is followed verbatim after validation. */
  async nextPage(next: string, options: RequestOptions = {}): Promise<EventPage> {
    return parsePage(await this.#request(validateNext(next, this.origin), options.signal), this.origin);
  }

  /** Lazily fetch pages until Loggly omits a continuation URL. Consume promptly: cursors expire after ten minutes. */
  async *pages(params: IterateParams = {}, options: RequestOptions = {}): AsyncGenerator<EventPage> {
    let page = await this.page(params, options);
    const seen = new Set<string>();
    while (true) {
      const next = page.next;
      yield page;
      if (!next) return;
      if (seen.has(next)) throw new LogglyPaginationError("Loggly repeated a pagination URL");
      seen.add(next);
      page = await this.nextPage(next, options);
    }
  }

  /** Lazily yield events across pages, stopping after `limit` when given. */
  async *events(params: IterateParams = {}, options: RequestOptions & { limit?: number } = {}): AsyncGenerator<LogEvent> {
    const limit = options.limit === undefined ? undefined : nonNegativeInteger(options.limit, "limit");
    if (limit === 0) return;
    let count = 0;
    for await (const page of this.pages(params, options)) {
      for (const event of page.events) {
        yield event;
        if (limit !== undefined && ++count >= limit) return;
      }
    }
  }

  /** Collect up to `limit` events. The page size defaults to the limit (at most 1,000). */
  async search(params: IterateParams = {}, options: RequestOptions & { limit: number }): Promise<LogEvent[]> {
    const limit = positiveInteger(options.limit, "limit");
    const events: LogEvent[] = [];
    for await (const event of this.events({ ...params, size: params.size ?? Math.min(limit, 1000) }, options)) events.push(event);
    return events;
  }

  /** Accepted event counts and bytes over time, optionally grouped by host, app, log type or tag. */
  async volumeMetrics(params: VolumeMetricsParams, options: RequestOptions = {}): Promise<VolumeMetric[]> {
    const body = await this.#get("/apiv2/volume-metrics", {
      from: formatTime(params.from),
      until: formatTime(params.until),
      group_by: params.groupBy,
      host: params.hosts,
      app: params.apps,
      measurement_types: params.measurementTypes,
    }, options.signal);
    if (!Array.isArray(body)) throw new LogglyResponseError("Loggly returned invalid volume metrics");
    return body.map(parseVolumeMetric);
  }

  /** Account subdomain, retention and volume limit. Customer tokens are never returned. */
  async account(options: RequestOptions = {}): Promise<AccountInfo> {
    const body = await this.#get("/apiv2/customer", {}, options.signal);
    if (!isRecord(body) || typeof body.subdomain !== "string") throw new LogglyResponseError("Loggly returned invalid account details");
    const subscription = isRecord(body.subscription) ? body.subscription : {};
    const info: AccountInfo = { subdomain: body.subdomain };
    const retention = Number(subscription.retention_days);
    const limit = Number(subscription.volume_limit_mb);
    if (subscription.retention_days !== undefined && Number.isFinite(retention)) info.retentionDays = retention;
    if (subscription.volume_limit_mb !== undefined && Number.isFinite(limit)) info.volumeLimitMb = limit;
    return info;
  }

  /** A link that opens the search in Loggly's web interface. */
  searchUrl(params: SearchParams = {}): string {
    const { q, from, until } = searchParams(params);
    return `${this.origin}/search/?${encodeQuery({ terms: q, from, until, source_group: "" })}`;
  }

  async #get(path: string, params: Record<string, QueryValue>, signal?: AbortSignal): Promise<unknown> {
    const query = encodeQuery(params);
    return this.#request(new URL(`${path}${query ? `?${query}` : ""}`, this.origin), signal);
  }

  async #request(url: URL, signal?: AbortSignal): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      let response: Response | undefined;
      let text: string | undefined;
      let timedOut = false;
      const release = await this.#limiter.acquire(signal);
      try {
        signal?.throwIfAborted();
        const timeout = AbortSignal.timeout(this.#timeoutMs);
        try {
          response = await this.#fetch(url, {
            headers: this.#headers,
            redirect: "manual",
            signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
          });
          text = await response.text();
        } catch {
          if (signal?.aborted) throw signal.reason;
          timedOut = timeout.aborted;
        }
      } finally {
        release();
      }
      if (response && text !== undefined && response.ok) {
        try {
          return JSON.parse(text) as unknown;
        } catch {
          throw new LogglyResponseError("Loggly returned invalid JSON");
        }
      }
      const delay = this.#retryDelay(attempt, response && text !== undefined ? { status: response.status, headers: response.headers, text } : undefined);
      if (delay === undefined) {
        if (!response || text === undefined) {
          throw new LogglyTransportError(timedOut ? `Loggly request timed out after ${this.#timeoutMs}ms` : "Loggly request failed with a network error");
        }
        throw apiErrorFor({ status: response.status, serverMessage: serverMessage(text), requestId: response.headers.get("x-loggly-request-uuid") ?? undefined });
      }
      await sleep(delay, signal);
    }
  }

  #retryDelay(attempt: number, response?: { status: number; headers: Headers; text: string }): number | undefined {
    if (attempt >= this.#maxRetries) return undefined;
    if (response) {
      const retryable = RETRY_STATUSES.has(response.status) || (response.status === 500 && /time[d ]?\s*out/i.test(response.text));
      if (!retryable) return undefined;
      const requested = retryAfter(response.headers.get("retry-after"));
      // Never retry earlier than requested, and never wait unboundedly.
      if (requested !== undefined) return requested <= this.#maxDelayMs ? requested : undefined;
    }
    return Math.min(this.#maxDelayMs, this.#backoffMs * 2 ** Math.min(attempt, 30));
  }
}

type QueryValue = string | number | readonly string[] | undefined;

function encodeQuery(params: Record<string, QueryValue>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(item))}`);
  }
  return parts.join("&");
}

function searchParams(params: SearchParams): { q: string; from: string; until: string } {
  const query = params.query ?? "*";
  if (typeof query !== "string" || !query.trim()) throw new TypeError("query must be a non-empty Loggly search query");
  return { q: query, from: formatTime(params.from ?? "-24h"), until: formatTime(params.until ?? "now") };
}

function validateNext(next: string, origin: string): URL {
  let url: URL;
  try {
    url = new URL(next);
  } catch {
    throw new LogglyPaginationError("Loggly returned an invalid pagination URL");
  }
  const expected = new URL(origin);
  if (url.protocol !== "https:" || url.host.toLowerCase() !== expected.host || url.pathname !== ITERATE_PATH || url.username || url.password || url.hash) {
    throw new LogglyPaginationError("Pagination URLs must use HTTPS and the same Loggly host and iterator path");
  }
  return url;
}

function parsePage(body: unknown, origin: string): EventPage {
  if (!isRecord(body) || !Array.isArray(body.events)) throw new LogglyResponseError("Loggly returned an invalid event page");
  const page: EventPage = { events: body.events.map(parseEvent) };
  if (body.next !== undefined && body.next !== null) {
    if (typeof body.next !== "string" || !body.next) throw new LogglyResponseError("Loggly returned an invalid event page");
    validateNext(body.next, origin);
    page.next = body.next;
  }
  return page;
}

function parseEvent(value: unknown): LogEvent {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.timestamp !== "number" || !Number.isFinite(value.timestamp)) {
    throw new LogglyResponseError("Loggly returned an invalid event");
  }
  if (value.logmsg !== undefined && typeof value.logmsg !== "string") throw new LogglyResponseError("Loggly returned an invalid event");
  const event: LogEvent = {
    id: value.id,
    timestamp: value.timestamp,
    logmsg: value.logmsg ?? "",
    event: isRecord(value.event) ? value.event : {},
    tags: stringArray(value.tags),
    logtypes: stringArray(value.logtypes),
  };
  if (typeof value.raw === "string") event.raw = value.raw;
  if (typeof value.unparsed === "string") event.unparsed = value.unparsed;
  return event;
}

function parseVolumeMetric(value: unknown): VolumeMetric {
  if (!isRecord(value)) throw new LogglyResponseError("Loggly returned invalid volume metrics");
  // The live API uses snake_case; the published example uses camelCase.
  const start = Number(value.start_timestamp ?? value.startTimestamp);
  const end = Number(value.end_timestamp ?? value.endTimestamp);
  if (!Number.isFinite(start) || !Number.isFinite(end)) throw new LogglyResponseError("Loggly returned invalid volume metrics");
  const metric: VolumeMetric = { start: start * 1000, end: end * 1000 };
  if (typeof value.metric === "string") metric.metric = value.metric;
  if (isCount(value.count)) metric.count = value.count;
  if (isCount(value.volume_bytes)) metric.volumeBytes = value.volume_bytes;
  if (typeof value.host === "string") metric.host = value.host;
  if (typeof value.app === "string") metric.app = value.app;
  if (typeof value.log_type === "string") metric.logType = value.log_type;
  if (Array.isArray(value.tags)) metric.tags = stringArray(value.tags);
  return metric;
}

/** Loggly's short error text, sanitised; never an HTML page or a large body. */
function serverMessage(text: string): string | undefined {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return undefined;
  }
  let message: unknown;
  if (isRecord(body)) {
    message = body.message ?? body.error;
    if (message === undefined && Array.isArray(body.errors) && isRecord(body.errors[0])) message = Object.values(body.errors[0]).find((v) => typeof v === "string");
  }
  if (typeof message !== "string") return undefined;
  const clean = message.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return clean ? clean.slice(0, 200) : undefined;
}

function retryAfter(value: string | null): number | undefined {
  if (value === null) return undefined;
  const seconds = Number(value);
  if (value.trim() && Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** FIFO counting semaphore; waiting acquisitions can be aborted. */
class Semaphore {
  #available: number;
  readonly #waiting: Array<() => void> = [];

  constructor(size: number) {
    this.#available = size;
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    if (this.#available > 0) {
      this.#available--;
      return this.#releaser();
    }
    await new Promise<void>((resolve, reject) => {
      const grant = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = () => {
        const index = this.#waiting.indexOf(grant);
        if (index >= 0) this.#waiting.splice(index, 1);
        reject(signal!.reason);
      };
      this.#waiting.push(grant);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    return this.#releaser();
  }

  #releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.#waiting.shift();
      if (next) next();
      else this.#available++;
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function positive(value: number, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new TypeError(`${name} must be a positive number`);
  return value;
}

function nonNegative(value: number, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new TypeError(`${name} must be a non-negative number`);
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative integer`);
  return value;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`);
  return value;
}

function rangeInteger(value: number, min: number, max: number, name: string): number {
  if (!Number.isInteger(value) || value < min || value > max) throw new TypeError(`${name} must be an integer from ${min} to ${max}`);
  return value;
}
