import {
  isFunctionCall,
  isImageGenerationCall,
  isMessage,
  isReasoning,
  ModelResponse,
  type OutputItem,
  parsePartialJson,
  toInput,
  toText,
} from "@xai-official/sdk";
import * as sdkTools from "@xai-official/sdk/tools";
import { z } from "zod";
import { defineModule, operation } from "./module.ts";

const outputSchema = z.object({
  output: z.array(z.looseObject({ type: z.string() })),
});
const itemSchema = z.object({ item: z.unknown() });
const stringList = z.array(z.string()).nullable().optional();
const readOnly = { readOnlyHint: true, openWorldHint: false };

/** SDK helpers are local tools; tool builders only construct Responses API configurations. */
export function createHelpersModule() {
  return defineModule(
    "helpers",
    "Local SDK response helpers and server-tool configuration builders.",
    {
      toText: operation(
        outputSchema,
        "Extract answer text from response output items.",
        (args) => ({ text: toText(args.output as OutputItem[]) }),
        readOnly,
      ),
      toInput: operation(
        outputSchema,
        "Convert response output into next-turn input, preserving encrypted reasoning and tool calls.",
        (args) => ({ input: toInput(args.output as OutputItem[]) }),
        readOnly,
      ),
      toJson: operation(
        z.object({
          response: z.looseObject({
            id: z.string(),
            status: z.string(),
            output: z.array(z.looseObject({ type: z.string() })),
          }),
        }),
        "Parse completed response output as JSON; rejects incomplete responses or invalid JSON.",
        (args) => ({
          value: new ModelResponse(args.response, {
            status: 0,
            headers: new Headers(),
            requestId: null,
            clientRequestId: "local",
          }).toJson(),
        }),
        readOnly,
      ),
      parsePartialJson: operation(
        z.object({ text: z.string() }),
        "Parse an unfinished JSON value. Returns null when the SDK finds no parseable value.",
        (args) => ({ value: parsePartialJson(args.text) ?? null }),
        readOnly,
      ),
      isFunctionCall: operation(
        itemSchema,
        "Check whether an output item is a client function call.",
        (args) => ({ value: isFunctionCall(args.item) }),
        readOnly,
      ),
      isImageGenerationCall: operation(
        itemSchema,
        "Check whether an output item is a server image generation call.",
        (args) => ({ value: isImageGenerationCall(args.item) }),
        readOnly,
      ),
      isMessage: operation(
        itemSchema,
        "Check whether an output item is an answer message.",
        (args) => ({ value: isMessage(args.item) }),
        readOnly,
      ),
      isReasoning: operation(
        itemSchema,
        "Check whether an output item is reasoning.",
        (args) => ({ value: isReasoning(args.item) }),
        readOnly,
      ),
      webSearch: operation(
        z.looseObject({
          allowed_domains: stringList,
          excluded_domains: stringList,
          enable_image_search: z.boolean().nullable().optional(),
          enable_image_understanding: z.boolean().nullable().optional(),
          filters: z.looseObject({}).nullable().optional(),
          user_location: z
            .looseObject({
              type: z.string(),
              city: z.string().nullable().optional(),
              country: z.string().nullable().optional(),
              region: z.string().nullable().optional(),
              timezone: z.string().nullable().optional(),
            })
            .nullable()
            .optional(),
        }),
        "Build a web_search configuration for responses.create.tools.",
        (args) => sdkTools.webSearch(args),
        readOnly,
      ),
      xSearch: operation(
        z.looseObject({
          allowed_x_handles: stringList,
          excluded_x_handles: stringList,
          enable_image_understanding: z.boolean().nullable().optional(),
          enable_video_understanding: z.boolean().nullable().optional(),
          from_date: z.string().nullable().optional(),
          to_date: z.string().nullable().optional(),
        }),
        "Build an x_search configuration; to_date is exclusive.",
        (args) => sdkTools.xSearch(args),
        readOnly,
      ),
      codeExecution: operation(
        z.object({}),
        "Build a server-side Python code_interpreter configuration.",
        () => sdkTools.codeExecution(),
        readOnly,
      ),
      collectionsSearch: operation(
        z.object({
          vector_store_ids: z.array(z.string()),
          max_num_results: z.number().int().nullable().optional(),
        }),
        "Build a file_search configuration for existing collections. Collection administration is outside this SDK.",
        (args) => sdkTools.collectionsSearch(args),
        readOnly,
      ),
      mcp: operation(
        z.object({
          server_label: z.string(),
          server_url: z.string(),
          allowed_tools: stringList,
          authorization: z.string().nullable().optional(),
          headers: z.record(z.string(), z.string()).nullable().optional(),
          server_description: z.string().nullable().optional(),
          defer_loading: z.boolean().nullable().optional(),
        }),
        "Build a remote MCP configuration for Grok; the server is called by xAI when used in a response.",
        (args) => sdkTools.mcp(args),
        readOnly,
      ),
      imageGeneration: operation(
        z.object({ action: z.string().nullable().optional() }),
        "Build a server image_generation configuration for responses.create.tools.",
        (args) => sdkTools.imageGeneration(args),
        readOnly,
      ),
      toolSearch: operation(
        z.object({}),
        "Build a tool_search configuration for loading deferred tools.",
        () => sdkTools.toolSearch(),
        readOnly,
      ),
    },
  );
}
