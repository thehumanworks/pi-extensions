import { z } from "zod";
import {
  defineModule,
  operation,
  requestOptions,
  type ToolkitContext,
} from "./module.ts";
import { requestOptionsSchema } from "./schemas.ts";
import {
  mediaInputSchema,
  storageOptionsSchema,
  toMediaInput,
} from "./image.ts";

const outputSchema = z.looseObject({ upload_url: z.string() });
const videoFields = {
  model: z.string().describe("Video model ID."),
  output: outputSchema.nullable().optional(),
  storage_options: storageOptionsSchema.nullable().optional(),
  request: requestOptionsSchema.optional(),
};
const generateSchema = z.looseObject({
  ...videoFields,
  prompt: z.string().optional(),
  aspect_ratio: z
    .enum(["1:1", "4:3", "16:9", "3:4", "9:16", "2:3", "3:2"])
    .nullable()
    .optional(),
  duration: z.number().nullable().optional(),
  image: mediaInputSchema.nullable().optional(),
  reference_images: z.array(mediaInputSchema).optional(),
  reference_audios: z
    .array(
      z.looseObject({
        url: z.string().nullable().optional(),
        voice_id: z.string().nullable().optional(),
      }),
    )
    .optional(),
  keyframes: z
    .array(z.looseObject({ image: mediaInputSchema, timestamp_s: z.number() }))
    .optional(),
  resolution: z.enum(["480p", "720p", "1080p"]).nullable().optional(),
  user: z.string().nullable().optional(),
});
const editSchema = z.looseObject({
  ...videoFields,
  prompt: z.string(),
  video: mediaInputSchema,
  user: z.string().nullable().optional(),
});
const extendSchema = z.looseObject({
  ...videoFields,
  prompt: z.string(),
  video: mediaInputSchema,
  duration: z.number().nullable().optional(),
});

export function createVideosModule(context: ToolkitContext) {
  return defineModule(
    "videos",
    "Generate, edit, extend, and poll xAI videos.",
    {
      generate: operation(
        generateSchema,
        "Start asynchronous video generation.",
        async (args, callContext) => {
          const { request, image, reference_images, keyframes, ...fields } =
            args;
          return (await context.getClient()).videos.generate(
            {
              ...fields,
              ...(image !== undefined
                ? { image: image === null ? null : toMediaInput(image) }
                : {}),
              ...(reference_images !== undefined
                ? { reference_images: reference_images.map(toMediaInput) }
                : {}),
              ...(keyframes !== undefined
                ? {
                    keyframes: keyframes.map((frame) => ({
                      ...frame,
                      image: toMediaInput(frame.image),
                    })),
                  }
                : {}),
            },
            requestOptions(request, callContext),
          );
        },
      ),
      edit: operation(
        editSchema,
        "Start asynchronous video editing.",
        async (args, callContext) => {
          const { request, video, ...fields } = args;
          return (await context.getClient()).videos.edit(
            {
              ...fields,
              video: toMediaInput(video),
            },
            requestOptions(request, callContext),
          );
        },
      ),
      extend: operation(
        extendSchema,
        "Start an asynchronous continuation of a video.",
        async (args, callContext) => {
          const { request, video, ...fields } = args;
          return (await context.getClient()).videos.extend(
            {
              ...fields,
              video: toMediaInput(video),
            },
            requestOptions(request, callContext),
          );
        },
      ),
      get: operation(
        z.looseObject({
          request_id: z.string(),
          request: requestOptionsSchema.optional(),
        }),
        "Get a video request's status, output, usage, and HTTP metadata.",
        async (args, callContext) => {
          return (await context.getClient()).videos.get(
            args.request_id,
            requestOptions(args.request, callContext),
          );
        },
      ),
      wait: operation(
        z.looseObject({
          request_id: z.string(),
          interval: z.number().nonnegative().optional(),
          timeout: z.number().nonnegative().optional(),
        }),
        "Poll a video request until it finishes, fails, expires, or the wait times out.",
        async (args, callContext) => {
          return (await context.getClient()).videos.wait(args.request_id, {
            interval: args.interval,
            timeout: args.timeout,
            signal: callContext.signal,
          });
        },
      ),
    },
  );
}
