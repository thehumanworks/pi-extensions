import { z } from "zod";
import {
  defineModule,
  operation,
  requestOptions,
  type ToolkitContext,
} from "./module.ts";
import { requestOptionsSchema } from "./schemas.ts";

export function createModelsModule(context: ToolkitContext) {
  const listSchema = z.object({ request: requestOptionsSchema.optional() });
  const getSchema = listSchema.extend({ id: z.string().min(1) });
  return defineModule("models", "Discover xAI models and their capabilities.", {
    list: operation(
      listSchema,
      "List all available models.",
      async (args, call) =>
        (await context.getClient()).models.list(
          requestOptions(args.request, call),
        ),
    ),
    get: operation(
      getSchema,
      "Get an available model by ID.",
      async (args, call) =>
        (await context.getClient()).models.get(
          args.id,
          requestOptions(args.request, call),
        ),
    ),
    languageList: operation(
      listSchema,
      "List language models.",
      async (args, call) =>
        (await context.getClient()).models.language.list(
          requestOptions(args.request, call),
        ),
    ),
    languageGet: operation(
      getSchema,
      "Get a language model by ID.",
      async (args, call) =>
        (await context.getClient()).models.language.get(
          args.id,
          requestOptions(args.request, call),
        ),
    ),
    imageList: operation(
      listSchema,
      "List image generation models.",
      async (args, call) =>
        (await context.getClient()).models.image.list(
          requestOptions(args.request, call),
        ),
    ),
    imageGet: operation(
      getSchema,
      "Get an image generation model by ID.",
      async (args, call) =>
        (await context.getClient()).models.image.get(
          args.id,
          requestOptions(args.request, call),
        ),
    ),
    videoList: operation(
      listSchema,
      "List video generation models.",
      async (args, call) =>
        (await context.getClient()).models.video.list(
          requestOptions(args.request, call),
        ),
    ),
    videoGet: operation(
      getSchema,
      "Get a video generation model by ID.",
      async (args, call) =>
        (await context.getClient()).models.video.get(
          args.id,
          requestOptions(args.request, call),
        ),
    ),
  });
}
