import {
  type CreateParams,
  type InputItem,
  ResponseStream,
} from "@xai-official/sdk";
import { z } from "zod";
import { toBlob } from "./binary.ts";
import {
  defineModule,
  operation,
  requestOptions,
  type ToolkitContext,
} from "./module.ts";
import { fileInputSchema, requestOptionsSchema } from "./schemas.ts";

const itemSchema = z.looseObject({
  type: z.string().nullable().optional(),
  role: z.string().optional(),
  content: z
    .union([
      z.string(),
      z.array(
        z.looseObject({
          type: z.string(),
          text: z.string().optional(),
          image_url: z.string().optional(),
          file_id: z.string().nullable().optional(),
          image: fileInputSchema.optional(),
          detail: z.string().optional(),
        }),
      ),
    ])
    .optional(),
});
const inputSchema = z.union([z.string(), z.array(itemSchema)]);
const toolSchema = z.looseObject({
  type: z
    .string()
    .describe(
      "function, web_search, x_search, code_interpreter, file_search, mcp, image_generation, shell, or tool_search.",
    ),
});

/** Convert encoded image parts without changing encrypted reasoning or tool output. */
function convertInput(
  input: z.infer<typeof inputSchema>,
): string | InputItem[] {
  if (typeof input === "string") return input;
  return input.map((item) => ({
    ...item,
    ...(Array.isArray(item.content)
      ? {
          content: item.content.map((part) => ({
            ...part,
            ...(part.type === "input_image" && part.image
              ? { image: toBlob(part.image) }
              : {}),
          })),
        }
      : {}),
  })) as InputItem[];
}

const createSchema = z.looseObject({
  model: z.string().min(1),
  input: inputSchema,
  instructions: z.string().nullable().optional(),
  tools: z.array(toolSchema).nullable().optional(),
  tool_choice: z
    .union([
      z.string(),
      z.looseObject({ type: z.string(), name: z.string().optional() }),
    ])
    .nullable()
    .optional(),
  parallel_tool_calls: z.boolean().nullable().optional(),
  store: z
    .boolean()
    .nullable()
    .optional()
    .describe(
      "SDK default false. Set true to retrieve or continue by response ID.",
    ),
  stream: z
    .boolean()
    .optional()
    .describe(
      "When true, forwards SSE events to onUpdate and returns the final response.",
    ),
  previous_response_id: z.string().nullable().optional(),
  prompt_cache_key: z.string().nullable().optional(),
  include: z.array(z.string()).nullable().optional(),
  reasoning: z
    .looseObject({
      effort: z.string().nullable().optional(),
      summary: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  reasoning_effort: z.string().nullable().optional(),
  text: z
    .looseObject({
      format: z
        .looseObject({
          type: z.string().describe("text, json_object, or json_schema."),
          name: z.string().nullable().optional(),
          schema: z.unknown().optional(),
          strict: z.boolean().nullable().optional(),
        })
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
  max_output_tokens: z.number().int().positive().nullable().optional(),
  max_turns: z.number().int().positive().nullable().optional(),
  temperature: z.number().nullable().optional(),
  top_p: z.number().nullable().optional(),
  top_k: z.number().int().nullable().optional(),
  top_logprobs: z.number().int().nullable().optional(),
  logprobs: z.boolean().nullable().optional(),
  min_p: z.number().nullable().optional(),
  metadata: z.unknown().optional(),
  background: z.boolean().nullable().optional(),
  context_management: z.array(z.unknown()).nullable().optional(),
  search_parameters: z.looseObject({}).nullable().optional(),
  service_tier: z.string().nullable().optional(),
  truncation: z.string().nullable().optional(),
  safety_identifier: z.string().nullable().optional(),
  user: z.string().nullable().optional(),
  request: requestOptionsSchema.optional(),
});

export function createResponsesModule(context: ToolkitContext) {
  const idSchema = z.object({
    id: z.string().min(1),
    request: requestOptionsSchema.optional(),
  });
  return defineModule(
    "responses",
    "Grok responses, structured output, multimodal input, server tools, and conversation management.",
    {
      create: operation(
        createSchema,
        "Create a Grok response with optional structured JSON, function/server tools and image input. Streaming publishes progress and returns the final response. Client tool calls are returned for the caller to execute.",
        async (args, call) => {
          const { request, ...body } = args;
          const result = await (
            await context.getClient()
          ).responses.create(
            {
              ...body,
              input: convertInput(args.input),
            } as CreateParams,
            requestOptions(request, call),
          );
          if (!(result instanceof ResponseStream)) return result;
          try {
            for await (const event of result) {
              call.signal?.throwIfAborted();
              await call.onUpdate?.(event);
            }
            return await result.done();
          } finally {
            await result.close();
          }
        },
      ),
      compact: operation(
        z.looseObject({
          model: z.string().min(1),
          input: inputSchema,
          request: requestOptionsSchema.optional(),
        }),
        "Compact a conversation into encrypted output. Pass output unchanged into the next responses.create input.",
        async (args, call) => {
          const { request, ...body } = args;
          return (await context.getClient()).responses.compact(
            {
              ...body,
              input: convertInput(args.input),
            },
            requestOptions(request, call),
          );
        },
      ),
      get: operation(
        idSchema,
        "Retrieve a response created with store:true.",
        async (args, call) =>
          (await context.getClient()).responses.get(
            args.id,
            requestOptions(args.request, call),
          ),
        { readOnlyHint: true },
      ),
      delete: operation(
        idSchema,
        "Delete a stored response.",
        async (args, call) =>
          (await context.getClient()).responses.delete(
            args.id,
            requestOptions(args.request, call),
          ),
        { destructiveHint: true },
      ),
      inputItemsList: operation(
        idSchema.extend({
          query: z
            .object({
              after: z.string().optional(),
              limit: z.number().int().positive().optional(),
              order: z.enum(["asc", "desc"]).optional(),
            })
            .optional(),
        }),
        "List one page of stored response input items; continue with query.after = last_id when has_more is true.",
        async (args, call) =>
          await (
            await context.getClient()
          ).responses.inputItems.list(
            args.id,
            args.query,
            requestOptions(args.request, call),
          ),
        { readOnlyHint: true },
      ),
    },
  );
}
