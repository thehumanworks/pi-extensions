import { BinaryResponse, ModelResponse } from "@xai-official/sdk";
import type { FileInput } from "./schemas.ts";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | {
      [key: string]: JsonValue;
    };

export function toBlob(input: FileInput): Blob | File {
  const bytes =
    input.encoding === "utf8"
      ? new TextEncoder().encode(input.data)
      : Uint8Array.from(atob(input.data), (char) => char.charCodeAt(0));
  const options = { type: input.mime_type ?? "application/octet-stream" };
  return input.filename
    ? new File([bytes], input.filename, options)
    : new Blob([bytes], options);
}

export function toBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)));
  }
  return btoa(chunks.join(""));
}

/** Preserve payloads and HTTP metadata across JSON-only tool transports. */
export async function serializeResult(value: unknown): Promise<JsonValue> {
  if (value === undefined || value === null) return null;
  if (value instanceof BinaryResponse) {
    const bytes = await value.bytes();
    return serializeResult({
      data: toBase64(bytes),
      encoding: "base64",
      mime_type:
        value.http.headers.get("content-type") ?? "application/octet-stream",
      byte_length: bytes.byteLength,
      http: value.http,
    });
  }
  if (value instanceof ModelResponse) {
    return serializeResult({
      ...value,
      text: value.toText(),
      input: value.toInput(),
      parsed: value.parsed,
    });
  }
  if (value instanceof Headers) return Object.fromEntries(value.entries());
  if (value instanceof Uint8Array) {
    return {
      data: toBase64(value),
      encoding: "base64",
      byte_length: value.byteLength,
    };
  }
  if (Array.isArray(value)) return Promise.all(value.map(serializeResult));
  if (typeof value === "object") {
    const entries = await Promise.all(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(
          async ([key, item]) => [key, await serializeResult(item)] as const,
        ),
    );
    return Object.fromEntries(entries);
  }
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new TypeError(`Cannot serialize tool result of type ${typeof value}`);
}
