import { z } from "zod";
import {
  defineModule,
  operation,
  requestOptions,
  type ToolkitContext,
} from "./module.ts";
import { requestOptionsSchema } from "./schemas.ts";

export function createAccountModule(context: ToolkitContext) {
  return defineModule(
    "account",
    "Inspect the current xAI account credentials.",
    {
      apiKey: operation(
        z.object({ request: requestOptionsSchema.optional() }),
        "Get metadata about the current API key.",
        async (args, call) =>
          (await context.getClient()).account.apiKey(
            requestOptions(args.request, call),
          ),
      ),
    },
  );
}
