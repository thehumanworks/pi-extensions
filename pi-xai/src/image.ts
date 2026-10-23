import { z } from "zod";
import type { ImageEditParams, ImageInput } from "@xai-official/sdk";
import {
  defineModule,
  operation,
  requestOptions,
  type ToolkitContext,
} from "./module.ts";
import { fileInputSchema, requestOptionsSchema } from "./schemas.ts";
import { toBlob } from "./binary.ts";

/** JSON media inputs can reference uploaded files, URLs, or inline encoded bytes. */
export const mediaInputSchema = z.union([
  fileInputSchema,
  z
    .looseObject({
      url: z.string().optional(),
      file_id: z.string().nullable().optional(),
    })
    .refine((value) => (value.url !== undefined) !== (value.file_id != null), {
      message: "Provide exactly one of url or file_id.",
    }),
]);

export function toMediaInput(
  input: z.infer<typeof mediaInputSchema>,
): ImageInput {
  return "data" in input && typeof input.data === "string"
    ? toBlob(input as z.infer<typeof fileInputSchema>)
    : (input as ImageInput);
}

export const storageOptionsSchema = z.looseObject({
  filename: z.string(),
  expires_after: z.number().nullable().optional(),
  public_url: z
    .union([
      z.boolean(),
      z.looseObject({ expires_after: z.number().nullable().optional() }),
    ])
    .nullable()
    .optional(),
});

const imageFields = {
  model: z.string().describe("Image model ID."),
  prompt: z.string(),
  aspect_ratio: z
    .enum([
      "1:1",
      "4:3",
      "16:9",
      "3:4",
      "9:16",
      "2:3",
      "3:2",
      "9:19.5",
      "19.5:9",
      "9:20",
      "20:9",
      "1:2",
      "2:1",
      "21:9",
      "5:2",
      "auto",
    ])
    .nullable()
    .optional(),
  n: z.number().nullable().optional(),
  quality: z.enum(["low", "medium", "auto"]).nullable().optional(),
  resolution: z.enum(["1k", "1.5k", "2k"]).nullable().optional(),
  response_format: z.enum(["url", "b64_json"]).nullable().optional(),
  storage_options: storageOptionsSchema.nullable().optional(),
  user: z.string().nullable().optional(),
  request: requestOptionsSchema.optional(),
};

export function createImagesModule(context: ToolkitContext) {
  return defineModule("images", "Generate and edit images with xAI.", {
    generate: operation(
      z.looseObject(imageFields),
      "Generate images; returns every image, usage, and HTTP metadata.",
      async (args, callContext) => {
        const { request, ...body } = args;
        return (await context.getClient()).images.generate(
          body,
          requestOptions(request, callContext),
        );
      },
    ),
    edit: operation(
      z
        .looseObject({
          ...imageFields,
          image: mediaInputSchema.optional(),
          images: z.array(mediaInputSchema).optional(),
        })
        .refine(
          (args) => (args.image !== undefined) !== (args.images !== undefined),
          {
            message: "Provide exactly one of image or images.",
          },
        ),
      "Edit one or more reference images; returns all generated images.",
      async (args, callContext) => {
        const { request, image, images, ...fields } = args;
        const body: ImageEditParams =
          images !== undefined
            ? { ...fields, images: images.map(toMediaInput) }
            : { ...fields, image: toMediaInput(image!) };
        return (await context.getClient()).images.edit(
          body,
          requestOptions(request, callContext),
        );
      },
    ),
  });
}
