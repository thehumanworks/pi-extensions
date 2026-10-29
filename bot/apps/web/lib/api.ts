import type { BotChatAdapter } from "@nothumanwork/bot-ai-sdk";
import { assertSameOrigin, canonicalRequest, HttpError, noStoreJson, requireId, route } from "./http";

/** Framework-neutral API entrypoint. The adapter owns bounded chat parsing and durable work. */
export function createApiHandler(getAdapter: () => BotChatAdapter) {
  return (request: Request): Promise<Response> => route(async () => {
    // Guard even missing paths and unsupported methods; never trust forwarded headers.
    assertSameOrigin(request);
    const url = new URL(request.url);
    let path: string;
    try { path = decodeURIComponent(url.pathname); }
    catch { throw new HttpError(400, "Invalid API path."); }
    let methods: string[];
    let action: () => Promise<Response>;
    if (path === "/api/chat") {
      methods = ["GET", "POST"];
      action = async () => {
        const canonical = canonicalRequest(request);
        if (request.method === "POST") return getAdapter().chat(canonical);
        return getAdapter().resume(canonical, requireId(url.searchParams.get("sessionId")),
          url.searchParams.has("runId") ? requireId(url.searchParams.get("runId"), "run") : undefined);
      };
    } else if (path === "/api/info") {
      methods = ["GET"];
      action = async () => noStoreJson(await getAdapter().info());
    } else if (path === "/api/sessions") {
      methods = ["GET"];
      action = async () => noStoreJson({ sessions: await getAdapter().sessions() });
    } else if (/^\/api\/sessions\/[^/]+$/.test(path)) {
      methods = ["GET"];
      action = async () => noStoreJson(await getAdapter().history(requireId(path.slice("/api/sessions/".length))));
    } else if (/^\/api\/runs\/[^/]+\/cancel$/.test(path)) {
      methods = ["POST"];
      action = async () => {
        await getAdapter().cancel(requireId(path.split("/")[3], "run"));
        return noStoreJson({ ok: true });
      };
    } else return noStoreJson({ error: "API route not found." }, 404);
    if (!methods.includes(request.method)) {
      const response = noStoreJson({ error: "Method not allowed." }, 405);
      response.headers.set("Allow", methods.join(", "));
      return response;
    }
    return action();
  });
}
