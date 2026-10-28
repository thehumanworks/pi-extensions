import { setTimeout as sleep } from 'node:timers/promises';
import type { Config } from './config.ts';
import type { Product } from './util.ts';
export interface RequestSpec { product: Product; method: string; url: string; body?: string; read: boolean; }
export interface ResponseSource { raw: string; url: string; status: number; contentType: string; link: string | null; data: unknown; }
export class Transport {
  private active = 0;
  private readonly shutdown = new AbortController();
  constructor(private readonly config: Config, private readonly fetcher: typeof globalThis.fetch, private readonly injected: boolean) {}
  redact(message: string): string {
    const auth = Buffer.from(`${this.config.username}:${this.config.token}`).toString('base64');
    for (const secret of [this.config.token, auth, this.config.username]) if (secret) message = message.split(secret).join('[REDACTED]');
    return message.replace(/\b(?:Basic|Bearer)\s+\S+/gi, '[REDACTED authorization]').slice(0, 1500);
  }
  private base(): URL {
    const c = this.config;
    if (!c.baseUrl) throw new Error('Missing ATLASSIAN_BASE_URL; configure credentials before network calls');
    // Only DNS hostname shorthand (with optional port/path), never a URL authority.
    const bare = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?::\d{1,5})?(?:\/[^?#]*)?$/.test(c.baseUrl);
    if (!bare && !/^https?:\/\/[^/]/.test(c.baseUrl)) throw new Error('Invalid ATLASSIAN_BASE_URL');
    const base = bare ? `https://${c.baseUrl}` : c.baseUrl;
    if (/[\\\s]/.test(base) || /%(?:2e|2f|5c|25)/i.test(base.split('?')[0] ?? '') || /(?:^|\/)\.{1,2}(?:\/|$)/.test(base)) throw new Error('Unsafe base URL: traversal or ambiguous URL');
    let u: URL;
    try { u = new URL(base); } catch { throw new Error('Invalid ATLASSIAN_BASE_URL'); }
    if (u.username || u.password || u.search || u.hash) throw new Error('Base URL must not contain credentials, query or fragment');
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local && (this.injected || c.allowInsecureLocalhost))) throw new Error('HTTPS base URL required (localhost HTTP requires explicit test opt-in)');
    if (c.authMode !== 'basic' && c.authMode !== 'bearer') throw new Error('ATLASSIAN_AUTH_MODE must be basic or bearer');
    if (!c.token || (c.authMode === 'basic' && !c.username)) throw new Error('Missing ATLASSIAN_API_TOKEN or ATLASSIAN_API_USERNAME');
    if (u.hostname === 'api.atlassian.com' && !/^[A-Za-z0-9_-]+$/.test(c.cloudId)) throw new Error('ATLASSIAN_CLOUD_ID required for gateway');
    return u;
  }
  root(p: Product): string {
    const u = this.base();
    if (u.hostname === 'api.atlassian.com') return `${u.origin}/ex/${p}/${this.config.cloudId}`;
    const prefix = u.pathname.replace(/\/$/, '').replace(/\/wiki$/, '');
    return u.origin + prefix;
  }
  url(p: Product, route: string): string { return this.root(p) + route; }
  /** Validate before URL normalization, then enforce origin and product root. */
  next(p: Product, link: string, current: string): string {
    if (/^\s*\/\//.test(link) || /[\\\s]/.test(link) || /%(?:2e|2f|5c|25)/i.test(link.split('?')[0] ?? '') || /(?:^|\/)\.\.(?:\/|$)/.test(link)) throw new Error('Unsafe pagination link: traversal/protocol-relative URL');
    const root = this.root(p);
    const currentUrl = new URL(current);
    let u: URL;
    if (p === 'confluence' && link.startsWith('/api/v2/')) u = new URL(root + '/wiki' + link);
    else if (link.startsWith('/') && !link.startsWith('/ex/') && new URL(root).pathname.startsWith('/ex/')) u = new URL(root + link);
    else u = new URL(link, currentUrl);
    const prefix = new URL(root).pathname.replace(/\/$/, '') + (p === 'jira' ? '/rest/api/3/' : '/wiki/');
    if (u.origin !== new URL(root).origin || u.username || u.password || u.hash || !u.pathname.startsWith(prefix)) throw new Error('Unsafe pagination URL: origin or product root mismatch');
    if (u.pathname !== currentUrl.pathname) throw new Error('Pagination changed the verified operation path');
    return u.href;
  }
  close(): void { this.shutdown.abort(); }
  async send(request: RequestSpec, signal?: AbortSignal): Promise<ResponseSource> {
    const timeout = AbortSignal.timeout(this.config.timeoutMs);
    const combined = AbortSignal.any([timeout, this.shutdown.signal, ...(signal ? [signal] : [])]);
    try {
      while (this.active >= this.config.maxConcurrency) await sleep(5, undefined, { signal: combined });
      combined.throwIfAborted();
      this.active++;
      try { return await this.attempts(request, combined); } finally { this.active--; }
    } catch (error) {
      if (combined.aborted) throw new Error(signal?.aborted ? 'Request cancelled' : 'Request deadline exceeded or service closed; mutation outcome may be uncertain');
      throw new Error(this.redact(error instanceof Error ? error.message : 'Request failed'));
    }
  }
  private async attempts(request: RequestSpec, signal: AbortSignal): Promise<ResponseSource> {
    this.base();
    const c = this.config;
    const authorization = c.authMode === 'bearer' ? `Bearer ${c.token}` : `Basic ${Buffer.from(`${c.username}:${c.token}`).toString('base64')}`;
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      let response: Response;
      try {
        response = await this.fetcher(request.url, { method: request.method, headers: { Authorization: authorization, Accept: 'application/json', ...(request.body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(request.body === undefined ? {} : { body: request.body }), redirect: 'error', signal });
      } catch (error) {
        // Node fetch wraps TLS errors in cause; only expose known safe categories.
        const codes = new Set(['UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID']);
        const codeOf = (value: unknown): unknown => value !== null && typeof value === 'object' && 'code' in value ? value.code : undefined;
        const cause = error !== null && typeof error === 'object' && 'cause' in error ? error.cause : undefined;
        const code = codeOf(cause) ?? codeOf(error);
        if (typeof code === 'string' && codes.has(code)) throw new Error(`TLS certificate verification failed (${code}); configure trusted system CA or NODE_EXTRA_CA_CERTS at runtime; never disable verification`);
        if (!request.read || attempt >= c.maxRetries || signal.aborted) throw new Error('Network request failed; mutation outcome may be uncertain (no mutation retries)');
        await sleep(Math.min(100 * 2 ** attempt, c.maxRetryDelayMs), undefined, { signal });
        continue;
      }
      if (response.redirected || (response.status >= 300 && response.status < 400)) { await response.body?.cancel(); throw new Error('Redirect rejected; credentials are never forwarded'); }
      if (response.url && response.url !== request.url) { await response.body?.cancel(); throw new Error('Unexpected response URL rejected'); }
      if (request.read && (response.status === 429 || response.status >= 500) && attempt < c.maxRetries) {
        const retryAfter = response.headers.get('retry-after');
        const delay = retryAfter === null ? Math.min(100 * 2 ** attempt, c.maxRetryDelayMs) : /^\d+(?:\.\d+)?$/.test(retryAfter) ? Number(retryAfter) * 1000 : Math.max(0, Date.parse(retryAfter) - Date.now());
        await response.body?.cancel();
        if (!Number.isFinite(delay) || delay > c.maxRetryDelayMs) throw new Error(`Retryable HTTP ${response.status}: Retry-After exceeds configured delay bound`);
        await sleep(delay, undefined, { signal });
        continue;
      }
      const raw = await this.readBody(response, signal);
      if (!response.ok) throw new Error(`HTTP ${response.status}${response.status === 429 || response.status >= 500 ? ' retryable' : ''}: ${this.redact(raw)}`);
      const contentType = response.headers.get('content-type') ?? '';
      let data: unknown = null;
      if (raw) {
        try { data = JSON.parse(raw) as unknown; } catch { data = undefined; }
      }
      return { raw, data, url: request.url, status: response.status, contentType, link: response.headers.get('link') };
    }
  }
  private async readBody(response: Response, signal: AbortSignal): Promise<string> {
    if (Number(response.headers.get('content-length')) > this.config.maxResponseBytes) { await response.body?.cancel(); throw new Error('Response exceeds byte limit; no truncated source stored'); }
    if (!response.body) return '';
    const reader = response.body.getReader();
    const parts: Uint8Array[] = [];
    let bytes = 0;
    const abort = (): void => { void reader.cancel().catch(() => { /* Abort is reported by throwIfAborted; cancellation is best effort. */ }); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      for (;;) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > this.config.maxResponseBytes) { await reader.cancel(); throw new Error('Response exceeds byte limit; no truncated source stored'); }
        parts.push(value);
      }
      signal.throwIfAborted();
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(parts));
    } finally { signal.removeEventListener('abort', abort); reader.releaseLock(); }
  }
}
