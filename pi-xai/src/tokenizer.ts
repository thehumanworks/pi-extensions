import { z } from "zod";
import {
  defineModule,
  operation,
  requestOptions,
  type ToolkitContext,
} from "./module.ts";
import { requestOptionsSchema } from "./schemas.ts";

export function createTokenizerModule(context: ToolkitContext) {
  return defineModule("tokenizer", "Tokenize text with an xAI model.", {
    encode: operation(
      z.looseObject({
        model: z.string().min(1),
        text: z.string(),
        user: z.string().nullable().optional(),
        request: requestOptionsSchema.optional(),
      }),
      "Encode text as model tokens.",
      async (args, call) => {
        const { request, ...body } = args;
        return (await context.getClient()).tokenizer.encode(
          body,
          requestOptions(request, call),
        );
      },
    ),
  });
}
