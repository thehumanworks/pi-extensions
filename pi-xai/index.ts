import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  createXaiToolkit,
  serializeResult,
  type ToolkitOptions,
} from "./src/index.ts";
import { getPiApiKey, PI_AUTHENTICATION_DESCRIPTION } from "./pi-auth.ts";

export interface PiToolkitOptions extends ToolkitOptions {
  /** Defaults to Pi's configured auth.json, normally ~/.pi/agent/auth.json. */
  authPath?: string;
  /** Managed local xAI cache; defaults to XAI_AUTH_FILE or ~/.config/xai/auth.json. */
  localAuthPath?: string;
}

/** Pi only adapts the transport; SDK behavior and schemas belong to src. */
export function registerXaiTools(
  pi: ExtensionAPI,
  options: PiToolkitOptions = {},
) {
  const { authPath, localAuthPath, ...toolkitOptions } = options;
  const toolkit = createXaiToolkit({
    ...toolkitOptions,
    apiKey: options.apiKey ?? (() => getPiApiKey({ authPath, localAuthPath })),
    authenticationDescription:
      options.authenticationDescription ?? PI_AUTHENTICATION_DESCRIPTION,
  });
  for (const tool of toolkit.tools) {
    const module = toolkit.modules[tool.module as keyof typeof toolkit.modules];
    pi.registerTool({
      name: tool.name,
      label: tool.name,
      description: tool.description,
      parameters: tool.parameters as ToolDefinition["parameters"],
      // The registry returns JSON values, including local helper strings/arrays.
      outputSchema: {} as ToolDefinition["parameters"],
      exposure: "codemode",
      namespace: {
        name: `xai_${tool.module}`,
        description: module.description,
        instructions:
          "Start with xai_meta_capabilities and xai_meta_describe_tool. Query live model/voice metadata before choosing IDs. Await tools through code mode; use structured results to filter large payloads. Show image base64 with image(), and keep large audio/video bytes out of text output.",
      },
      annotations: tool.annotations,
      async execute(_id, args, signal, onUpdate) {
        const result = await tool.execute(args, {
          signal,
          onUpdate: onUpdate
            ? async (event) => {
                const progress = await serializeResult(event);
                onUpdate({
                  content: [{ type: "text", text: JSON.stringify(progress) }],
                  details: progress,
                });
              }
            : undefined,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          details: result,
          structuredContent: result,
        };
      },
    });
  }
  return toolkit;
}

export default function xaiExtension(pi: ExtensionAPI) {
  registerXaiTools(pi);
}
