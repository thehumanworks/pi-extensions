import { z } from "zod";
import type { BatchRequest } from "@xai-official/sdk";
import {
  defineModule,
  operation,
  requestOptions,
  type ToolkitContext,
} from "./module.ts";
import { requestOptionsSchema } from "./schemas.ts";

const pageQuery = z.looseObject({
  limit: z.number().int().positive().optional(),
  pagination_token: z.string().optional(),
});
const payload = z.looseObject({});
const batchRequest = z.looseObject({
  batch_request_id: z.string().nullable().optional(),
  batch_request: z.union([
    z.looseObject({ responses: payload }),
    z.looseObject({ image_generation: payload }),
    z.looseObject({ image_edit: payload }),
    z.looseObject({ video_generation: payload }),
    z.looseObject({ video_extension: payload }),
  ]),
});

export function createBatchesModule(context: ToolkitContext) {
  const idSchema = z.object({
    id: z.string().min(1),
    request: requestOptionsSchema.optional(),
  });
  const querySchema = z.object({
    query: pageQuery.optional(),
    request: requestOptionsSchema.optional(),
  });
  return defineModule(
    "batches",
    "Create and manage asynchronous xAI request batches.",
    {
      create: operation(
        z.object({
          body: z.looseObject({
            name: z.string().min(1),
            input_file_id: z.string().min(1).optional(),
          }),
          request: requestOptionsSchema.optional(),
        }),
        "Create a batch, optionally from an uploaded JSONL file.",
        async (args, call) =>
          (await context.getClient()).batches.create(
            args.body,
            requestOptions(args.request, call),
          ),
      ),
      list: operation(
        querySchema,
        "List one page of batches.",
        async (args, call) =>
          await (
            await context.getClient()
          ).batches.list(args.query, requestOptions(args.request, call)),
      ),
      get: operation(
        idSchema,
        "Get batch metadata and processing state.",
        async (args, call) =>
          (await context.getClient()).batches.get(
            args.id,
            requestOptions(args.request, call),
          ),
      ),
      cancel: operation(idSchema, "Cancel a batch.", async (args, call) =>
        (await context.getClient()).batches.cancel(
          args.id,
          requestOptions(args.request, call),
        ),
      ),
      results: operation(
        idSchema.extend({ query: pageQuery.optional() }),
        "Get one page of batch results.",
        async (args, call) =>
          await (
            await context.getClient()
          ).batches.results(
            args.id,
            args.query,
            requestOptions(args.request, call),
          ),
      ),
      requestsAdd: operation(
        idSchema.extend({
          body: z.looseObject({ batch_requests: z.array(batchRequest) }),
        }),
        "Add requests to a batch.",
        async (args, call) =>
          (await context.getClient()).batches.requests.add(
            args.id,
            args.body as { batch_requests: BatchRequest[] },
            requestOptions(args.request, call),
          ),
      ),
      requestsList: operation(
        idSchema.extend({ query: pageQuery.optional() }),
        "Get one page of batch request metadata.",
        async (args, call) =>
          await (
            await context.getClient()
          ).batches.requests.list(
            args.id,
            args.query,
            requestOptions(args.request, call),
          ),
      ),
      wait: operation(
        z.object({
          id: z.string().min(1),
          interval: z.number().int().positive().optional(),
          timeout: z.number().int().positive().optional(),
        }),
        "Poll until a batch has no pending requests; timeout does not cancel the batch.",
        async (args, call) =>
          (await context.getClient()).batches.wait(args.id, {
            interval: args.interval,
            timeout: args.timeout,
            signal: call.signal,
          }),
      ),
    },
  );
}
