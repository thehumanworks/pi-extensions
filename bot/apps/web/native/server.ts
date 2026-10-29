import type { BotChatAdapter } from "@nothumanwork/bot-ai-sdk";
import { createApiHandler } from "../lib/api";
import { assertSameOrigin, HttpError, noStoreJson, route } from "../lib/http";

export type Asset = { file: string; type: string; etag?: string };
export type Assets = ReadonlyMap<string, Asset>;
const securityHeaders = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "frame-ancestors 'none'; object-src 'none'; base-uri 'self'",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

/** Assets are trusted embedded imports, never paths derived from requests. */
export function createHandler(assets: Assets, getAdapter: () => BotChatAdapter, shutdown?: AbortSignal) {
  const api = createApiHandler(getAdapter);
  return async (incoming: Request): Promise<Response> => {
    const request = shutdown ? new Request(incoming, { signal: AbortSignal.any([incoming.signal, shutdown]) }) : incoming;
    const response = await route(async () => {
      assertSameOrigin(request);
      const url = new URL(request.url);
      if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return api(request);
      if (request.method !== "GET" && request.method !== "HEAD") {
        const response = noStoreJson({ error: "Method not allowed." }, 405);
        response.headers.set("Allow", "GET, HEAD");
        return response;
      }
      let path: string;
      try { path = decodeURIComponent(url.pathname); }
      catch { throw new HttpError(400, "Invalid asset path."); }
      if (path.includes("\\") || path.includes("\0") || path.split("/").some(part => part === "." || part === "..")) {
        throw new HttpError(400, "Invalid asset path.");
      }
      // Support Next's export layout without a catch-all SPA fallback.
      const asset = assets.get(path) ?? assets.get(path === "/" ? "/index.html" : path.endsWith("/") ? `${path}index.html` : `${path}.html`);
      if (!asset) return noStoreJson({ error: "Not found." }, 404);
      const headers = new Headers({ "Content-Type": asset.type,
        "Cache-Control": path.startsWith("/_next/static/") ? "public, max-age=31536000, immutable" : "no-cache" });
      if (asset.etag) {
        headers.set("ETag", asset.etag);
        const matches = request.headers.get("if-none-match")?.split(",").map(tag => tag.trim().replace(/^W\//, ""));
        if (matches?.includes(asset.etag) || matches?.includes("*")) return new Response(null, { status: 304, headers });
      }
      const file = Bun.file(asset.file);
      headers.set("Content-Length", String(file.size));
      return new Response(request.method === "HEAD" ? null : file, { headers });
    });
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(securityHeaders)) headers.set(key, value);
    return new Response(request.method === "HEAD" ? null : response.body, { status: response.status, statusText: response.statusText, headers });
  };
}

export function startServer(options: { host?: string; port?: number; assets: Assets; getAdapter: () => BotChatAdapter }) {
  const shutdown = new AbortController();
  const server = Bun.serve({
    hostname: options.host ?? "::1", port: options.port ?? 3001,
    // Idle SSE observers are valid; the adapter independently bounds incoming chat bodies.
    idleTimeout: 0,
    maxRequestBodySize: 1024 * 1024,
    fetch: createHandler(options.assets, options.getAdapter, shutdown.signal),
    error: () => noStoreJson({ error: "The web service could not complete this request." }, 503),
  });
  return { server, async stop() {
    // Detach observers, never invoke adapter.cancel(): daemon runs survive UI exit.
    shutdown.abort();
    await server.stop(true);
  } };
}
