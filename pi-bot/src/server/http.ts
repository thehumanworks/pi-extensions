import { readFile } from "node:fs/promises";
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import type { RpcExtensionUIResponse } from "@earendil-works/pi-coding-agent";
import { archiveBot, createBot, listBots, loadBot, parseBot, updateBot, validateThinking, writeDefinition, type Bot, type ThinkingLevel } from "../bots.ts";
import { modelRef, resolveModel, type Registry } from "../models.ts";
import type { ConversationHub } from "./conversations.ts";
import { badRequest, errorText, fromRequest, HttpError, notFound } from "./errors.ts";
import { openapiDocument } from "./openapi.ts";

export interface ModelInfo { id: string; provider: string; modelId: string; name: string; reasoning: boolean; contextWindow: number }

export interface AppDependencies {
  hub: ConversationHub;
  /** Models the host can use; resolved lazily because it reads credentials. */
  registry: () => Promise<Registry>;
  version: string;
}

interface RequestContext {
  params: Record<string, string>;
  query: URLSearchParams;
  body: () => Promise<Record<string, unknown>>;
  req: IncomingMessage;
  res: ServerResponse;
}

/** `undefined` means the handler wrote the response itself (streams). */
type Reply = { status?: number; body: unknown } | undefined;
type Handler = (ctx: RequestContext) => Promise<Reply>;
interface Route { method: string; path: string; pattern: RegExp; handler: Handler }

const BODY_LIMIT = 1 << 20;
const PING_MS = 15_000;

/** Public shape of a bot; paths included so a UI can point at the home. */
function publicBot(bot: Bot) {
  const { name, description, model, thinking, tools, skills, prompt, home, file } = bot;
  return { name, description, model: model ?? null, thinking: thinking ?? null, tools: tools ?? [], skills: skills ?? [], prompt, home, file };
}

export function modelInfo(registry: Registry): ModelInfo[] {
  return registry.getAvailable().map(model => ({ id: modelRef(model), provider: model.provider, modelId: model.id, name: model.name, reasoning: model.reasoning, contextWindow: model.contextWindow }));
}

/** `undefined` keeps the setting, `null` clears it ("inherit"), a string must name one model. */
async function normalizeModel(registry: () => Promise<Registry>, value: unknown): Promise<string | null | undefined> {
  if (value === undefined) return undefined;
  if (value === null || value === "" || value === "inherit") return null;
  if (typeof value !== "string") throw badRequest("model must be a string or null.");
  const model = resolveModel(await registry(), value);
  if (!model) throw badRequest(`Unknown or ambiguous model "${value}". Use provider/model-id as listed by GET /models.`);
  return modelRef(model);
}

function normalizeThinking(value: unknown): ThinkingLevel | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "" || value === "inherit") return null;
  if (typeof value !== "string") throw badRequest("thinking must be a string or null.");
  return validateThinking(value);
}

function stringList(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) throw badRequest(`${field} must be an array of strings.`);
  return value as string[];
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw badRequest(`${field} is required.`);
  return value;
}

/** Build the request listener. Every route is also listed in the OpenAPI document. */
export function createApp(deps: AppDependencies): RequestListener & { routes: readonly Route[] } {
  const routes: Route[] = [];
  const route = (method: string, path: string, handler: Handler) => {
    routes.push({ method, path, pattern: new RegExp(`^${path.replace(/\{(\w+)\}/g, "(?<$1>[^/]+)")}$`), handler });
  };
  const bot = (ctx: RequestContext) => fromRequest(() => loadBot(decodeURIComponent(ctx.params.bot!)));
  const conversationPath = (bot: string, id: string) => `/bots/${encodeURIComponent(bot)}/conversations/${encodeURIComponent(id)}`;

  route("GET", "/", async () => ({ body: { name: "pi-bot", version: deps.version, openapi: "/openapi.json" } }));
  route("GET", "/openapi.json", async () => ({ body: openapiDocument(deps.version) }));
  route("GET", "/health", async () => ({ body: { status: "ok" } }));
  route("GET", "/models", async () => ({ body: { models: modelInfo(await deps.registry()) } }));

  route("GET", "/bots", async () => {
    const { bots, errors } = await listBots();
    return { body: { bots: bots.map(publicBot), errors } };
  });
  route("POST", "/bots", async ctx => {
    const body = await ctx.body();
    const model = await normalizeModel(deps.registry, body.model);
    const thinking = normalizeThinking(body.thinking);
    const tools = stringList(body.tools, "tools"), skills = stringList(body.skills, "skills");
    const created = await fromRequest(() => createBot({
      name: requireString(body.name, "name"), description: requireString(body.description, "description"), prompt: requireString(body.prompt, "prompt"),
      model: model ?? undefined, thinking: thinking ?? undefined, tools: tools?.length ? tools : undefined, skills: skills?.length ? skills : undefined,
    }));
    return { status: 201, body: publicBot(created) };
  });
  route("GET", "/bots/{bot}", async ctx => {
    const found = await bot(ctx);
    return { body: { ...publicBot(found), definition: await readFile(found.file, "utf8") } };
  });
  route("PATCH", "/bots/{bot}", async ctx => {
    const found = await bot(ctx);
    const body = await ctx.body();
    if (typeof body.definition === "string") {
      const { model } = parseBot(body.definition, found.name);
      if (model) await normalizeModel(deps.registry, model);
      return { body: publicBot(await fromRequest(() => writeDefinition(found.name, body.definition as string))) };
    }
    const patch = {
      description: body.description as string | undefined, prompt: body.prompt as string | undefined,
      edits: body.edits as Array<{ oldText: string; newText: string }> | undefined,
      model: await normalizeModel(deps.registry, body.model), thinking: normalizeThinking(body.thinking),
      tools: body.tools === null ? null : stringList(body.tools, "tools"), skills: body.skills === null ? null : stringList(body.skills, "skills"),
    };
    if (Object.values(patch).every(value => value === undefined)) throw badRequest("Nothing to change.");
    return { body: publicBot(await fromRequest(() => updateBot(found.name, patch))) };
  });
  route("DELETE", "/bots/{bot}", async ctx => {
    const found = await bot(ctx);
    await deps.hub.closeBot(found);
    return { body: { archived: await fromRequest(() => archiveBot(found.name)) } };
  });

  route("GET", "/bots/{bot}/conversations", async ctx => ({ body: { conversations: await deps.hub.list(await bot(ctx)) } }));
  route("PUT", "/bots/{bot}/conversations/{id}", async ctx => {
    const found = await bot(ctx);
    const id = decodeURIComponent(ctx.params.id!);
    const body = await ctx.body();
    const before = (await deps.hub.list(found)).some(conversation => conversation.id === id);
    const conversation = await fromRequest(() => deps.hub.get(found, id, { cwd: body.cwd as string | undefined }));
    return { status: before ? 200 : 201, body: await conversation.snapshot() };
  });
  route("GET", "/bots/{bot}/conversations/{id}", async ctx => {
    const conversation = await fromRequest(async () => deps.hub.get(await bot(ctx), decodeURIComponent(ctx.params.id!)));
    if (ctx.query.get("view") !== "updates") return { body: await conversation.snapshot() };
    const from = Number(ctx.query.get("offset") ?? conversation.offset);
    if (!Number.isInteger(from) || from < 0) throw badRequest("offset must be a non-negative integer.");
    streamUpdates(ctx.res, conversation, from);
    return undefined;
  });
  route("POST", "/bots/{bot}/conversations/{id}", async ctx => {
    const found = await bot(ctx);
    const id = decodeURIComponent(ctx.params.id!);
    const body = await ctx.body();
    const message = requireString(body.message, "message");
    const behavior = body.behavior;
    if (behavior !== undefined && behavior !== "steer" && behavior !== "followUp") throw badRequest('behavior must be "steer" or "followUp".');
    const conversation = await fromRequest(() => deps.hub.get(found, id, { cwd: body.cwd as string | undefined }));
    const offset = conversation.offset;
    const { submissionId, disposition } = await fromRequest(() => conversation.submit(message, behavior));
    return { status: 202, body: { submissionId, disposition, offset, streamUrl: `${conversationPath(found.name, id)}?view=updates&offset=${offset}` } };
  });
  route("POST", "/bots/{bot}/conversations/{id}/abort", async ctx => {
    const conversation = await fromRequest(async () => deps.hub.get(await bot(ctx), decodeURIComponent(ctx.params.id!)));
    await fromRequest(() => conversation.abort());
    return { status: 202, body: { state: conversation.currentState } };
  });
  route("POST", "/bots/{bot}/conversations/{id}/responses", async ctx => {
    const conversation = await fromRequest(async () => deps.hub.get(await bot(ctx), decodeURIComponent(ctx.params.id!)));
    const body = await ctx.body();
    const requestId = requireString(body.requestId, "requestId");
    const response: RpcExtensionUIResponse = body.cancelled === true ? { type: "extension_ui_response", id: requestId, cancelled: true }
      : typeof body.confirmed === "boolean" ? { type: "extension_ui_response", id: requestId, confirmed: body.confirmed }
      : typeof body.value === "string" ? { type: "extension_ui_response", id: requestId, value: body.value }
      : (() => { throw badRequest("Provide value, confirmed or cancelled."); })();
    if (!conversation.respond(response)) throw notFound(`No request "${requestId}" is waiting for an answer.`);
    return { body: { requestId, closed: true } };
  });
  route("DELETE", "/bots/{bot}/conversations/{id}", async ctx => {
    await fromRequest(async () => deps.hub.remove(await bot(ctx), decodeURIComponent(ctx.params.id!)));
    return { body: { deleted: true } };
  });

  const listener: RequestListener = (req, res) => {
    void dispatch(routes, req, res);
  };
  return Object.assign(listener, { routes: routes as readonly Route[] });
}

async function dispatch(routes: Route[], req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const candidates = routes.filter(route => route.pattern.test(url.pathname));
  const route = candidates.find(route => route.method === req.method);
  try {
    if (!route) {
      if (candidates.length) throw new HttpError(405, `${req.method} is not allowed here.`);
      throw notFound(`No route for ${req.method} ${url.pathname}.`);
    }
    const params = url.pathname.match(route.pattern)?.groups ?? {};
    const reply = await route.handler({ params, query: url.searchParams, body: () => readJson(req), req, res });
    if (reply) sendJson(res, reply.status ?? 200, reply.body);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    if (status === 500) console.error(`pi-bot-server: ${req.method} ${url.pathname}:`, error);
    if (!res.headersSent) sendJson(res, status, { error: { status, message: errorText(error) } });
    else res.end();
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > BODY_LIMIT) throw new HttpError(413, "Request body is too large.");
    chunks.push(chunk as Buffer);
  }
  if (!size) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch {
    throw badRequest("Request body must be a JSON object.");
  }
}

/** Server-sent events: `id` is the offset, `event` the type, `data` the JSON payload. */
function streamUpdates(res: ServerResponse, conversation: { firstOffset: number; subscribe: (from: number, listener: (event: { offset: number; type: string; data: unknown }) => void) => () => void }, from: number): void {
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
  res.write(`: updates from ${from}\n\n`);
  if (from < conversation.firstOffset) res.write(`event: gap\ndata: ${JSON.stringify({ from, firstOffset: conversation.firstOffset })}\n\n`);
  const unsubscribe = conversation.subscribe(from, event => {
    res.write(`id: ${event.offset}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
  });
  const ping = setInterval(() => res.write(": ping\n\n"), PING_MS);
  res.on("close", () => { unsubscribe(); clearInterval(ping); });
}
