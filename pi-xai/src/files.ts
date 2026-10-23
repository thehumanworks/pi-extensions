import { z } from "zod";
import {
  defineModule,
  operation,
  requestOptions,
  type ToolkitContext,
} from "./module.ts";
import { fileInputSchema, requestOptionsSchema } from "./schemas.ts";
import { toBlob } from "./binary.ts";

const expiry = z.number().int().min(3600).max(2592000).nullable().optional();
const fileQuery = z.looseObject({
  limit: z.number().int().positive().optional(),
  pagination_token: z.string().optional(),
  after: z.string().optional(),
  order: z.enum(["asc", "desc"]).optional(),
  sort_by: z.enum(["created_at", "filename", "size"]).optional(),
  filter: z.string().optional(),
});

export function createFilesModule(context: ToolkitContext) {
  const idSchema = z.object({
    id: z.string().min(1),
    request: requestOptionsSchema.optional(),
  });
  return defineModule("files", "Upload and manage xAI files and public URLs.", {
    upload: operation(
      z.looseObject({
        file: fileInputSchema,
        filename: z.string().min(1).optional(),
        purpose: z.string().nullable().optional(),
        expires_after: expiry,
        request: requestOptionsSchema.optional(),
      }),
      "Upload a file from base64 or UTF-8 content.",
      async (args, call) => {
        const { file, request, ...body } = args;
        return (await context.getClient()).files.upload(
          {
            ...body,
            file: toBlob(file),
            filename: args.filename ?? file.filename ?? "upload",
          },
          requestOptions(request, call),
        );
      },
    ),
    list: operation(
      z.object({
        query: fileQuery.optional(),
        request: requestOptionsSchema.optional(),
      }),
      "List one page of files; pass pagination_token to fetch the next page.",
      async (args, call) =>
        await (
          await context.getClient()
        ).files.list(args.query, requestOptions(args.request, call)),
    ),
    get: operation(idSchema, "Get file metadata.", async (args, call) =>
      (await context.getClient()).files.get(
        args.id,
        requestOptions(args.request, call),
      ),
    ),
    delete: operation(idSchema, "Delete a file.", async (args, call) =>
      (await context.getClient()).files.delete(
        args.id,
        requestOptions(args.request, call),
      ),
    ),
    content: operation(
      idSchema.extend({
        query: z
          .looseObject({
            format: z.enum(["original", "text"]).optional(),
          })
          .optional(),
      }),
      "Download file content as a binary response.",
      async (args, call) =>
        (await context.getClient()).files.content(
          args.id,
          args.query,
          requestOptions(args.request, call),
        ),
    ),
    createPublicUrl: operation(
      idSchema.extend({
        body: z.looseObject({ expires_after: expiry }).optional(),
      }),
      "Create a public URL for a file.",
      async (args, call) =>
        (await context.getClient()).files.createPublicUrl(
          args.id,
          args.body,
          requestOptions(args.request, call),
        ),
    ),
    revokePublicUrl: operation(
      idSchema,
      "Revoke a file public URL.",
      async (args, call) =>
        (await context.getClient()).files.revokePublicUrl(
          args.id,
          requestOptions(args.request, call),
        ),
    ),
  });
}
