import type { RequestOpts, SpaceXAI } from "@xai-official/sdk";
import { z } from "zod";
import { type JsonValue, serializeResult } from "./binary.ts";

export interface ToolkitContext {
  getClient(): Promise<SpaceXAI>;
}

export interface CallContext {
  signal?: AbortSignal;
  onUpdate?: (event: unknown) => void | Promise<void>;
}

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolkitTool {
  name: string;
  module: string;
  description: string;
  parameters: Record<string, unknown>;
  annotations?: ToolAnnotations;
  execute(args: unknown, context?: CallContext): Promise<JsonValue>;
}

export function requestOptions(
  options: Omit<RequestOpts, "signal"> | undefined,
  context: CallContext = {},
): RequestOpts {
  return { ...options, signal: context.signal };
}

export interface Operation<S extends z.ZodType, R> {
  schema: S;
  description: string;
  annotations?: ToolAnnotations;
  execute(args: z.output<S>, context: CallContext): Promise<R> | R;
}

export function operation<S extends z.ZodType, R>(
  schema: S,
  description: string,
  execute: (args: z.output<S>, context: CallContext) => Promise<R> | R,
  annotations?: ToolAnnotations,
): Operation<S, R> {
  return { schema, description, execute, annotations };
}

// Existential operation types are erased only while building the registry.
// Public module methods retain their own schema input and result types.
type AnyOperation = Operation<z.ZodType, unknown>;
type ModuleMethods<O extends Record<string, AnyOperation>> = {
  [K in keyof O]: (
    args: z.input<O[K]["schema"]>,
    context?: CallContext,
  ) => Promise<Awaited<ReturnType<O[K]["execute"]>>>;
};

export function defineModule<O extends Record<string, AnyOperation>>(
  name: string,
  description: string,
  operations: O,
): ModuleMethods<O> & {
  name: string;
  description: string;
  tools: ToolkitTool[];
} {
  const methods: Record<string, unknown> = {};
  const tools: ToolkitTool[] = [];
  for (const [key, op] of Object.entries(operations)) {
    const invoke = async (args: unknown, context: CallContext = {}) => {
      context.signal?.throwIfAborted();
      return await op.execute(op.schema.parse(args), context);
    };
    methods[key] = invoke;
    tools.push({
      name: `xai_${name}_${key.replace(
        /[A-Z]/g,
        (letter) => `_${letter.toLowerCase()}`,
      )}`,
      module: name,
      description: op.description,
      parameters: z.toJSONSchema(op.schema, { io: "input" }),
      annotations: op.annotations ?? {
        readOnlyHint:
          /(?:List|Get|GetAudio)$|^(list|get|content|results|wait|encode|apiKey)$/.test(
            key,
          ),
        destructiveHint:
          /(?:Delete|Update)$|^(delete|cancel|revokePublicUrl)$/.test(key),
        openWorldHint: !["helpers", "meta"].includes(name),
      },
      execute: async (args, context) =>
        serializeResult(await invoke(args, context)),
    });
  }
  return Object.assign(methods, {
    name,
    description,
    tools,
  }) as ModuleMethods<O> & {
    name: string;
    description: string;
    tools: ToolkitTool[];
  };
}
