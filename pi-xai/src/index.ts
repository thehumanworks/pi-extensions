import { SDK_VERSION } from "@xai-official/sdk";
import { z } from "zod";
import { createAccountModule } from "./account.ts";
import { createBatchesModule } from "./batches.ts";
import { createClientProvider, type ToolkitOptions } from "./client.ts";
import { createFilesModule } from "./files.ts";
import { createHelpersModule } from "./helpers.ts";
import { createImagesModule } from "./image.ts";
import { createModelsModule } from "./models.ts";
import {
  type CallContext,
  defineModule,
  operation,
  type ToolkitTool,
} from "./module.ts";
import { createResponsesModule } from "./responses.ts";
import { createTokenizerModule } from "./tokenizer.ts";
import { createVoiceModule } from "./tts.ts";
import { createVideosModule } from "./video.ts";

/** Reusable library and tool registry. No Pi imports or import-time credential access. */
export function createXaiToolkit(options: ToolkitOptions = {}) {
  const context = createClientProvider(options);
  const modules = {
    responses: createResponsesModule(context),
    models: createModelsModule(context),
    images: createImagesModule(context),
    videos: createVideosModule(context),
    files: createFilesModule(context),
    batches: createBatchesModule(context),
    voice: createVoiceModule(context),
    tokenizer: createTokenizerModule(context),
    account: createAccountModule(context),
    helpers: createHelpersModule(),
  };
  const tools: ToolkitTool[] = Object.values(modules).flatMap(
    (module) => module.tools,
  );
  const moduleCatalog = Object.values(modules).map(
    ({ name, description, tools }) => ({
      name,
      description,
      tool_count: tools.length,
    }),
  );
  const readOnly = { readOnlyHint: true, openWorldHint: false };
  const meta = defineModule(
    "meta",
    "Inspect toolkit capabilities and tool schemas without credentials or API calls.",
    {
      capabilities: operation(
        z.object({}),
        "Describe SDK version, modules, discovery endpoints, input/output formats and important usage behavior. Works without credentials.",
        () => ({
          sdk: { package: "@xai-official/sdk", version: SDK_VERSION },
          modules: moduleCatalog,
          discovery: {
            models: "xai_models_list",
            language_details_and_pricing: "xai_models_language_list",
            image_details_and_pricing: "xai_models_image_list",
            video_details_and_pricing: "xai_models_video_list",
            voices: "xai_voice_list",
            custom_voices: "xai_voice_custom_list",
            account_permissions: "xai_account_api_key",
            token_counts: "xai_tokenizer_encode",
            schemas: "xai_meta_describe_tool",
          },
          authentication:
            options.authenticationDescription ??
            "Injected client/apiKey, or XAI_API_KEY; resolved on the first API call.",
          behavior: {
            models:
              "Model IDs are arbitrary strings. Query live model endpoints for availability, capabilities, limits and pricing.",
            responses:
              "store defaults to false. For stateless conversation history use returned input; stored response IDs require store:true.",
            streaming:
              "responses.create stream:true forwards SSE events to onUpdate and returns the final response. Cancellation closes the stream.",
            client_tools:
              "Function and shell calls are returned for the caller to execute and feed back; server tools run on xAI.",
            pagination:
              "List tools return one page and its cursor. Pass pagination_token, or input-items after=last_id, to continue.",
            polling:
              "Video/batch wait timeouts stop waiting; the remote job continues. Abort cancels local requests.",
            media_input:
              "URLs, file IDs and encoded files are supported as documented in each tool schema. Encoded files use data, encoding:base64|utf8, mime_type and filename.",
            results:
              "Tool outputs preserve all results, usage and HTTP metadata; response outputs also include text, parsed and next-turn input. Binary downloads return base64 data, mime_type and byte_length.",
            local_helpers:
              "Helper tools construct configurations or process data locally. Web/X search, code execution, collections and MCP configurations go in responses.create.tools.",
            realtime:
              "The SDK exposes ephemeral voice client secrets; WebSocket/WebRTC session transport is outside the SDK.",
          },
        }),
        readOnly,
      ),
      listTools: operation(
        z.object({
          module: z.string().optional(),
          include_schemas: z.boolean().optional(),
        }),
        "List toolkit tools, optionally for one module and with input schemas.",
        (args) => ({
          tools: tools
            .filter((tool) => !args.module || tool.module === args.module)
            .map((tool) => ({
              name: tool.name,
              module: tool.module,
              description: tool.description,
              annotations: tool.annotations,
              ...(args.include_schemas ? { parameters: tool.parameters } : {}),
            })),
        }),
        readOnly,
      ),
      describeTool: operation(
        z.object({ name: z.string() }),
        "Get the full parameter schema and usage description for a toolkit tool.",
        (args) => {
          const tool = tools.find((item) => item.name === args.name);
          if (!tool) throw new Error(`Unknown xAI tool: ${args.name}`);
          return {
            name: tool.name,
            module: tool.module,
            description: tool.description,
            parameters: tool.parameters,
            annotations: tool.annotations,
          };
        },
        readOnly,
      ),
    },
  );
  tools.push(...meta.tools);
  moduleCatalog.push({
    name: meta.name,
    description: meta.description,
    tool_count: meta.tools.length,
  });
  const registry = new Map(tools.map((tool) => [tool.name, tool]));
  if (registry.size !== tools.length) {
    throw new Error("Duplicate xAI tool names.");
  }
  return {
    ...modules,
    meta,
    modules: { ...modules, meta },
    tools,
    getClient: context.getClient,
    async executeTool(name: string, args: unknown, call?: CallContext) {
      const tool = registry.get(name);
      if (!tool) throw new Error(`Unknown xAI tool: ${name}`);
      return await tool.execute(args, call);
    },
  };
}

export type XaiToolkit = ReturnType<typeof createXaiToolkit>;
export type { ToolkitOptions } from "./client.ts";
export type {
  CallContext,
  ToolAnnotations,
  ToolkitContext,
  ToolkitTool,
} from "./module.ts";
export type { FileInput } from "./schemas.ts";
export { type JsonValue, serializeResult, toBase64, toBlob } from "./binary.ts";
export { type EnvironmentReader, getApiKey } from "./secret.ts";
export {
  createAccountModule,
  createBatchesModule,
  createFilesModule,
  createHelpersModule,
  createImagesModule,
  createModelsModule,
  createResponsesModule,
  createTokenizerModule,
  createVideosModule,
  createVoiceModule,
};
export * from "@xai-official/sdk";
