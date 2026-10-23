import { z } from "zod";

/** Serializable equivalents of SDK per-request options. Signals live in CallContext. */
export const requestOptionsSchema = z.object({
  timeout: z
    .number()
    .nonnegative()
    .optional()
    .describe("Per-attempt timeout in milliseconds; 0 disables it."),
  idleTimeout: z
    .number()
    .nonnegative()
    .optional()
    .describe("Maximum milliseconds between response chunks; 0 disables it."),
  maxResponseBodyBytes: z.number().int().positive().optional(),
  maxRetries: z.number().int().nonnegative().optional(),
  retryBeforeOutput: z.boolean().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  http: z.object({ body: z.boolean().optional() }).optional(),
});

/** No host filesystem dependency: callers supply bytes or text. */
export const fileInputSchema = z.object({
  data: z
    .string()
    .describe("Base64 bytes, or literal text when encoding is utf8."),
  encoding: z.enum(["base64", "utf8"]).optional(),
  mime_type: z.string().optional(),
  filename: z.string().optional(),
});

export type FileInput = z.infer<typeof fileInputSchema>;

export const paginationSchema = z.object({
  limit: z.number().int().positive().optional(),
  pagination_token: z.string().optional(),
});
