import { z } from "zod";
import {
  checkSpeechText,
  INLINE_SPEECH_TAGS,
  type SpeechParams,
  stripInvalidSpeechTags,
  type TranscriptionParams,
  WRAPPING_SPEECH_TAGS,
} from "@xai-official/sdk";
import {
  defineModule,
  operation,
  requestOptions,
  type ToolkitContext,
} from "./module.ts";
import { fileInputSchema, requestOptionsSchema } from "./schemas.ts";
import { toBlob } from "./binary.ts";

const speechSchema = z.looseObject({
  text: z
    .string()
    .describe("Text to speak, including optional SDK speech tags."),
  language: z.string().describe("BCP-47 language code or auto."),
  voice_id: z.string().optional(),
  output_format: z
    .looseObject({
      codec: z.enum(["mp3", "wav", "pcm", "mulaw", "alaw"]),
      sample_rate: z.number().nullable().optional(),
      bit_rate: z.number().nullable().optional(),
    })
    .optional(),
  optimize_streaming_latency: z
    .union([z.literal(0), z.literal(1), z.literal(2)])
    .optional(),
  text_normalization: z.boolean().optional(),
  with_timestamps: z.boolean().optional(),
  speed: z.number().optional(),
  replace: z.record(z.string(), z.string()).optional(),
  request: requestOptionsSchema.optional(),
});
const transcriptionSchema = z
  .looseObject({
    file: fileInputSchema.optional(),
    url: z.string().optional(),
    model: z.string().optional(),
    audio_format: z
      .enum([
        "pcm",
        "mulaw",
        "alaw",
        "wav",
        "mp3",
        "ogg",
        "opus",
        "flac",
        "aac",
        "mp4",
        "m4a",
        "mkv",
      ])
      .optional(),
    sample_rate: z
      .union([
        z.literal(8000),
        z.literal(16000),
        z.literal(22050),
        z.literal(24000),
        z.literal(44100),
        z.literal(48000),
      ])
      .optional(),
    language: z.string().optional(),
    format: z.boolean().optional(),
    multichannel: z.boolean().optional(),
    channels: z.number().optional(),
    diarize: z.boolean().optional(),
    keyterm: z.array(z.string()).optional(),
    filler_words: z.boolean().optional(),
    vad_threshold: z.number().optional(),
    request: requestOptionsSchema.optional(),
  })
  .refine((args) => (args.file !== undefined) !== (args.url !== undefined), {
    message: "Provide exactly one of file or url.",
  });
const labels = {
  name: z.string(),
  description: z.string(),
  gender: z.enum(["male", "female", "neutral"]),
  accent: z.string(),
  age: z.enum(["young", "middle-aged", "old"]),
  language: z.string(),
  use_case: z.enum([
    "conversational",
    "narration",
    "characters",
    "educational",
    "advertisement",
    "social_media",
    "entertainment",
  ]),
  tone: z.enum([
    "warm",
    "casual",
    "professional",
    "friendly",
    "authoritative",
    "expressive",
    "calm",
  ]),
};
const customCreateSchema = z.looseObject(labels).partial().extend({
  file: fileInputSchema,
  request: requestOptionsSchema.optional(),
});
const customUpdateSchema = z.looseObject({
  voice_id: z.string(),
  name: labels.name.nullable().optional(),
  description: labels.description.nullable().optional(),
  gender: labels.gender.nullable().optional(),
  accent: labels.accent.nullable().optional(),
  age: labels.age.nullable().optional(),
  language: labels.language.nullable().optional(),
  use_case: labels.use_case.nullable().optional(),
  tone: labels.tone.nullable().optional(),
  request: requestOptionsSchema.optional(),
});
const voiceIdSchema = z.looseObject({
  voice_id: z.string(),
  request: requestOptionsSchema.optional(),
});
const noArgsSchema = z.looseObject({
  request: requestOptionsSchema.optional(),
});
const textSchema = z.object({ text: z.string() });

export function createVoiceModule(context: ToolkitContext) {
  return defineModule(
    "voice",
    "Speech synthesis, transcription, voice management, and realtime client secrets.",
    {
      speak: operation(
        speechSchema,
        "Synthesize speech as a BinaryResponse, or JSON base64 audio and timings when with_timestamps is true.",
        async (args, callContext) => {
          const { request, ...body } = args;
          return (await context.getClient()).voice.speak(
            body as SpeechParams<string>,
            requestOptions(request, callContext),
          );
        },
      ),
      transcribe: operation(
        transcriptionSchema,
        "Transcribe encoded audio or an audio URL with optional words, speakers, and channels.",
        async (args, callContext) => {
          const { request, file, url, ...fields } = args;
          const body: TranscriptionParams =
            file !== undefined
              ? { ...fields, file: toBlob(file) }
              : { ...fields, url: url! };
          return (await context.getClient()).voice.transcribe(
            body,
            requestOptions(request, callContext),
          );
        },
      ),
      list: operation(
        noArgsSchema,
        "List built-in voices.",
        async (args, callContext) =>
          (await context.getClient()).voice.list(
            requestOptions(args.request, callContext),
          ),
      ),
      get: operation(
        voiceIdSchema,
        "Get a built-in voice.",
        async (args, callContext) =>
          (await context.getClient()).voice.get(
            args.voice_id,
            requestOptions(args.request, callContext),
          ),
      ),
      customCreate: operation(
        customCreateSchema,
        "Create a custom voice from reference audio and optional labels.",
        async (args, callContext) => {
          const { request, file, ...labels } = args;
          return (await context.getClient()).voice.custom.create(
            {
              ...labels,
              file: toBlob(file),
            },
            requestOptions(request, callContext),
          );
        },
      ),
      customList: operation(
        z.looseObject({
          limit: z.number().optional(),
          pagination_token: z.string().optional(),
          request: requestOptionsSchema.optional(),
        }),
        "List one page of custom voices, including the next pagination token.",
        async (args, callContext) => {
          const { request, ...query } = args;
          return await (
            await context.getClient()
          ).voice.custom.list(query, requestOptions(request, callContext));
        },
      ),
      customGet: operation(
        voiceIdSchema,
        "Get a custom voice.",
        async (args, callContext) =>
          (await context.getClient()).voice.custom.get(
            args.voice_id,
            requestOptions(args.request, callContext),
          ),
      ),
      customUpdate: operation(
        customUpdateSchema,
        "Update custom voice labels. Omitted fields are unchanged; null clears a label.",
        async (args, callContext) => {
          const { voice_id, request, ...body } = args;
          return (await context.getClient()).voice.custom.update(
            voice_id,
            body,
            requestOptions(request, callContext),
          );
        },
      ),
      customDelete: operation(
        voiceIdSchema,
        "Delete a custom voice.",
        async (args, callContext) =>
          (await context.getClient()).voice.custom.delete(
            args.voice_id,
            requestOptions(args.request, callContext),
          ),
      ),
      customGetAudio: operation(
        voiceIdSchema,
        "Download a custom voice's reference audio as a BinaryResponse.",
        async (args, callContext) =>
          (await context.getClient()).voice.custom.getAudio(
            args.voice_id,
            requestOptions(args.request, callContext),
          ),
      ),
      clientSecretsCreate: operation(
        z.looseObject({
          expires_after: z
            .looseObject({ seconds: z.number().optional() })
            .optional(),
          session: z
            .looseObject({
              model: z.string().optional(),
              reasoning: z
                .looseObject({
                  effort: z.enum(["high", "none"]).optional(),
                })
                .optional(),
            })
            .nullable()
            .optional(),
          request: requestOptionsSchema.optional(),
        }),
        "Create a short-lived client secret for realtime voice sessions.",
        async (args, callContext) => {
          const { request, ...body } = args;
          return (await context.getClient()).voice.clientSecrets.create(
            body,
            requestOptions(request, callContext),
          );
        },
      ),
      speechTags: operation(
        z.object({}),
        "List supported inline and wrapping speech tags.",
        () => ({
          inline: INLINE_SPEECH_TAGS,
          wrapping: WRAPPING_SPEECH_TAGS,
        }),
      ),
      checkSpeechText: operation(
        textSchema,
        "List unknown, unclosed, or incorrectly nested speech tag problems.",
        (args) => checkSpeechText(args.text),
      ),
      stripInvalidSpeechTags: operation(
        textSchema,
        "Remove invalid speech tags while retaining their words.",
        (args) => stripInvalidSpeechTags(args.text),
      ),
    },
  );
}
