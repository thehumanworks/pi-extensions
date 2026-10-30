import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { looksLikeMermaid } from "./diagram.ts";
import { FORMATS, normalizeFormat, outputFormatFromPath, isOutputFormat, type ContentFormat, type InputFormat, type OutputFormat } from "./formats.ts";
import { serializeMarkdown } from "./markdown.ts";
import { loadModel, renderModel, resolveSourceFormat, ConversionError, type ConversionResult, type ConvertOptions, type OutputFile } from "./convert.ts";
import { workbookToDocument } from "./model.ts";
import { readPdf } from "./raster.ts";
import { parseDelimited } from "./workbook.ts";
import type { Image, Nodes } from "mdast";

export { ConversionError, loadModel, numberedPath, renderModel, resolveSourceFormat, type ConversionResult, type ConvertOptions, type OutputFile, type Source } from "./convert.ts";
export { looksLikeMermaid, MERMAID_TYPES, renderMermaid, svgToPng, DiagramError } from "./diagram.ts";
export { CONTENT_FORMATS, FORMATS, INPUT_FORMATS, OUTPUT_FORMATS, PAGE_SIZES, formatFromPath, normalizeFormat, sniffFormat, type ContentFormat, type InputFormat, type OutputFormat, type PageSize } from "./formats.ts";
export { parseMarkdown, serializeMarkdown } from "./markdown.ts";
export type { Cell, DocumentModel, ImageModel, Metadata, Model, PdfModel, Sheet, WorkbookModel } from "./model.ts";
export { pdfToPng, readPdf, parsePages } from "./raster.ts";

/** Largest input read, to keep conversions within memory. */
export const MAX_INPUT_BYTES = 200 * 1024 * 1024;

const CONTENT_TO_INPUT: Record<ContentFormat, InputFormat> = { markdown: "md", html: "html", text: "txt", csv: "csv", tsv: "tsv", json: "json", mermaid: "mermaid", svg: "svg" };

/** Guess what text content is: Mermaid, SVG, HTML and JSON are recognised; CSV only when a spreadsheet is wanted and there is no Markdown table. */
export function detectContentFormat(content: string, output: OutputFormat): InputFormat {
  const text = content.replace(/^\uFEFF/, "").trimStart();
  if (looksLikeMermaid(text)) return "mermaid";
  if (/^(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(text)) return "svg";
  if (/^(<!doctype html|<html[\s>])/i.test(text)) return "html";
  if (/^[[{]/.test(text)) {
    try {
      JSON.parse(text);
      return "json";
    } catch {
      // Not JSON: fall through to Markdown.
    }
  }
  if (FORMATS[output].kind === "workbook" && !/^\s*\|.*\|\s*$/m.test(text)) {
    const lines = text.split(/\r?\n/);
    const sample = lines.slice(0, 20).join("\n");
    for (const [delimiter, format] of [["\t", "tsv"], [",", "csv"], [";", "csv"]] as const) {
      const records = parseDelimited(sample, delimiter);
      // A record cut off by the sample is not compared.
      if (lines.length > 20) records.pop();
      const width = records[0]?.length ?? 0;
      if (width > 1 && records.every((record) => record.length === width)) return format;
    }
  }
  return "md";
}

export class FileExistsError extends Error {}

/** The output format: given explicitly, or from the path's extension. */
export function resolveOutputFormat(path: string, format?: string): OutputFormat {
  if (format) {
    const normalized = normalizeFormat(format);
    if (!normalized || !isOutputFormat(normalized)) throw new ConversionError(`Cannot write "${format}". Output formats: ${Object.keys(FORMATS).filter(isOutputFormat).join(", ")}`);
    return normalized;
  }
  const fromPath = outputFormatFromPath(path);
  if (!fromPath) throw new ConversionError(`Cannot tell the output format from "${basename(path)}"; give the file a known extension (.pdf, .docx, .doc, .rtf, .pptx, .xlsx, .csv, .tsv, .json, .png, .svg, .html, .md, .txt) or pass format`);
  return fromPath;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export interface SaveOptions {
  overwrite?: boolean;
  /** Serialises writes to one path, e.g. Pi's withFileMutationQueue. */
  queue?: <T>(path: string, write: () => Promise<T>) => Promise<T>;
}

/** Write output files atomically (temporary file, then rename), refusing to replace existing files unless overwrite is set. */
export async function saveFiles(files: OutputFile[], options: SaveOptions = {}): Promise<void> {
  if (!options.overwrite) {
    const taken: string[] = [];
    for (const file of files) if (await exists(file.path)) taken.push(file.path);
    if (taken.length) throw new FileExistsError(`${taken.length === 1 ? `${taken[0]} already exists` : `These files already exist: ${taken.join(", ")}`}. Pass overwrite: true to replace ${taken.length === 1 ? "it" : "them"}.`);
  }
  const queue = options.queue ?? ((_path, write) => write());
  for (const file of files) {
    await queue(file.path, async () => {
      await mkdir(dirname(file.path), { recursive: true });
      const temporary = `${file.path}.${randomBytes(4).toString("hex")}.tmp`;
      try {
        await writeFile(temporary, file.data);
        await rename(temporary, file.path);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
    });
  }
}

export interface CreateInput extends ConvertOptions, SaveOptions {
  /** Text to turn into the document: Markdown by default. */
  content: string;
  contentFormat?: ContentFormat;
  /** Output file. */
  output: string;
  /** Output format, when the extension does not say it. */
  format?: string;
  /** Directory that relative paths (the output, images in the content) resolve against. Default the current directory. */
  cwd?: string;
  signal?: AbortSignal;
}

/** Create a document from text content and write it. */
export async function createDocument(input: CreateInput): Promise<ConversionResult> {
  const cwd = input.cwd ?? process.cwd();
  const output = resolve(cwd, input.output);
  const format = resolveOutputFormat(output, input.format);
  const data = new TextEncoder().encode(input.content);
  const contentFormat = input.contentFormat ? CONTENT_TO_INPUT[input.contentFormat] : detectContentFormat(input.content, format);
  const { model, warnings, facts } = await loadModel({ data, format: contentFormat, baseDir: cwd }, input);
  input.signal?.throwIfAborted();
  const result = await renderModel(model, format, output, { ...input, baseDir: cwd }, input.signal);
  await saveFiles(result.files, input);
  return { ...result, warnings: [...warnings, ...result.warnings], facts: [...facts, ...result.facts] };
}

export interface ConvertInput extends ConvertOptions, SaveOptions {
  input: string;
  output: string;
  /** Input format, when the extension does not say it. */
  from?: string;
  /** Output format, when the extension does not say it. */
  format?: string;
  cwd?: string;
  signal?: AbortSignal;
}

async function readSource(path: string, from?: string): Promise<{ data: Uint8Array; format: InputFormat }> {
  const info = await stat(path).catch(() => undefined);
  if (!info) throw new ConversionError(`${path} was not found`);
  if (!info.isFile()) throw new ConversionError(`${path} is not a file`);
  if (info.size > MAX_INPUT_BYTES) throw new ConversionError(`${path} is ${Math.round(info.size / 1024 / 1024)} MB; the limit is ${MAX_INPUT_BYTES / 1024 / 1024} MB`);
  const declared = from ? normalizeFormat(from) : undefined;
  if (from && !declared) throw new ConversionError(`Unknown input format "${from}"`);
  const data = new Uint8Array(await readFile(path));
  return { data, format: resolveSourceFormat(data, declared, path) };
}

/** Convert a file to another format and write it. */
export async function convertDocument(input: ConvertInput): Promise<ConversionResult> {
  const cwd = input.cwd ?? process.cwd();
  const source = resolve(cwd, input.input);
  const output = resolve(cwd, input.output);
  if (source === output) throw new ConversionError("The output must be a different file from the input");
  const format = resolveOutputFormat(output, input.format);
  const { data, format: sourceFormat } = await readSource(source, input.from);
  const { model, warnings, facts } = await loadModel({ data, format: sourceFormat, name: basename(source), baseDir: dirname(source) }, input);
  input.signal?.throwIfAborted();
  const result = await renderModel(model, format, output, { ...input, baseDir: dirname(source) }, input.signal);
  if (result.files.some((file) => file.path === source)) throw new ConversionError("The conversion would overwrite its input; choose another output name");
  await saveFiles(result.files, input);
  return { ...result, warnings: [...warnings, ...result.warnings], facts: [...facts, ...result.facts] };
}

export interface ReadInput {
  path: string;
  from?: string;
  /** PDF pages, e.g. "1-3". */
  pages?: string;
  cwd?: string;
}

/** Read any supported file as Markdown, so its content can be inspected as text. Embedded images become placeholders. */
export async function readDocument(input: ReadInput): Promise<{ markdown: string; format: InputFormat; warnings: string[]; facts: string[] }> {
  const path = resolve(input.cwd ?? process.cwd(), input.path);
  const { data, format } = await readSource(path, input.from);
  const { model, warnings, facts } = await loadModel({ data, format, name: basename(path), baseDir: dirname(path) }, { pages: input.pages });
  let markdown: string;
  switch (model.kind) {
    case "document":
      markdown = serializeMarkdown(withImagePlaceholders(model.tree));
      break;
    case "workbook":
      markdown = serializeMarkdown(workbookToDocument(model).tree);
      facts.push(model.sheets.map((sheet) => `${sheet.name}: ${sheet.rows.length} rows`).join("; "));
      break;
    case "pdf": {
      const { document, pageCount } = await readPdf(model.data, { pages: input.pages });
      markdown = serializeMarkdown(document.tree);
      facts.push(`${pageCount} page${pageCount === 1 ? "" : "s"}`);
      warnings.push("Text extracted from the PDF; tables and images are not reconstructed. To check the layout, convert it to PNG and view the images.");
      break;
    }
    case "image":
      markdown = model.source ? `\`\`\`mermaid\n${model.source.trim()}\n\`\`\`\n` : `Image: ${Math.round(model.image.width)}x${Math.round(model.image.height)} ${model.image.mime}. Open it with an image viewer or the read tool to see it.\n`;
      break;
  }
  if (model.meta.title || model.meta.author) {
    facts.unshift([model.meta.title && `title "${model.meta.title}"`, model.meta.author && `author ${model.meta.author}`].filter(Boolean).join(", "));
  }
  return { markdown, format, warnings, facts };
}

/** Replace embedded image data with a short placeholder: base64 is noise when reading. */
function withImagePlaceholders<T extends Nodes>(tree: T): T {
  const copy = structuredClone(tree);
  let count = 0;
  const visit = (node: Nodes) => {
    if (node.type === "image" && node.url.startsWith("data:")) {
      count += 1;
      (node as Image).url = `embedded-image-${count}.${/^data:image\/(\w+)/.exec(node.url)?.[1]?.replace("jpeg", "jpg").replace("svg+xml", "svg") ?? "bin"}`;
    }
    if ("children" in node) for (const child of node.children) visit(child as Nodes);
  };
  visit(copy);
  return copy;
}
