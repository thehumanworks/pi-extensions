import { BotAdapterError } from "@nothumanwork/bot-ai-sdk";

/** Shared route guards. No environment values or backend errors go to clients. */
export class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function publicOrigin(request: Request, configuredOrigin = process.env.BOT_UI_ORIGIN): string {
  if (configuredOrigin) {
    const configured = new URL(configuredOrigin);
    if (!["http:", "https:"].includes(configured.protocol) || configured.username || configured.password || configured.pathname !== "/" || configured.search || configured.hash) {
      throw new Error("Invalid UI origin configuration");
    }
    const requestUrl = new URL(request.url);
    const authority = request.headers.get("host") ?? requestUrl.host;
    let incoming: URL;
    try { incoming = new URL(`${requestUrl.protocol}//${authority}`); }
    catch { throw new HttpError(403, "Unknown UI host."); }
    // A reverse proxy may preserve the public Host or use a loopback upstream.
    // Still reject attacker-controlled domains on Origin-less GET requests.
    if (incoming.host.toLowerCase() !== authority.toLowerCase() || incoming.username || incoming.password || (incoming.host !== configured.host && !["localhost", "127.0.0.1", "[::1]"].includes(incoming.hostname.toLowerCase()))) {
      throw new HttpError(403, "Unknown UI host.");
    }
    return configured.origin;
  }
  const url = new URL(request.url);
  // NextURL normalizes [::1] and 127.0.0.1 to localhost. Compare the actual
  // browser authority, not that normalized URL, without trusting forwarded headers.
  const authority = request.headers.get("host") ?? url.host;
  let incoming: URL;
  try { incoming = new URL(`${url.protocol}//${authority}`); }
  catch { throw new HttpError(403, "Unknown UI host."); }
  if (incoming.host.toLowerCase() !== authority.toLowerCase() || incoming.username || incoming.password || !["localhost", "127.0.0.1", "[::1]"].includes(incoming.hostname.toLowerCase())) {
    throw new HttpError(403, "Unknown UI host.");
  }
  return incoming.origin;
}

export function assertSameOrigin(request: Request, configuredOrigin?: string): void {
  const expected = publicOrigin(request, configuredOrigin);
  const origin = request.headers.get("origin");
  // Origin-less server clients are allowed; this guard is not authentication.
  if (origin !== null && origin !== expected) throw new HttpError(403, "Cross-origin requests are not allowed.");
  if (request.headers.get("sec-fetch-site") === "cross-site") throw new HttpError(403, "Cross-origin requests are not allowed.");
}

/** Restore the public authority before passing Next's normalized Request to the adapter. */
export function canonicalRequest(request: Request): Request {
  assertSameOrigin(request);
  const url = new URL(request.url);
  return new Request(`${publicOrigin(request)}${url.pathname}${url.search}`, request);
}

export function requireId(value: string | null | undefined, label = "session"): string {
  if (!value || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value)) {
    throw new HttpError(400, `Invalid ${label} ID.`);
  }
  return value;
}

export function noStoreJson(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}

export async function route(action: () => Promise<Response>): Promise<Response> {
  try { return await action(); }
  catch (error) {
    if (error instanceof HttpError || error instanceof BotAdapterError) return noStoreJson({ error: error.message }, error.status);
    // Deliberately do not serialize URLs, daemon auth failures, stacks, or credentials.
    return noStoreJson({ error: "The bot service is unavailable or could not complete this request. Check the daemon connection and server configuration, then retry." }, 503);
  }
}
