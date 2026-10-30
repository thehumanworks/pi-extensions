import { basename, dirname, extname, join, relative, resolve } from "node:path";
import type { Code, Image, Nodes, Root } from "mdast";
import { imageAsset, rasterSize, svgAsset, svgSize } from "./assets.ts";
import { looksLikeMermaid, renderMermaid, svgToPng } from "./diagram.ts";
import { readDoc, readDocx, writeDocx } from "./docx.ts";
import { extensionFor, FORMATS, formatFromPath, sniffFormat, type InputFormat, type OutputFormat } from "./formats.ts";
import { htmlToMdast, parseHtml, writeHtml } from "./html.ts";
import { parseMarkdown, serializeMarkdown } from "./markdown.ts";
import { documentToWorkbook, workbookToDocument, type DocumentModel, type ImageModel, type Metadata, type Model, type WorkbookModel } from "./model.ts";
import { writePdf, type PageSize } from "./pdf.ts";
import { readPptx, writePptx } from "./pptx.ts";
import { prepareDocument, type PreparedDocument } from "./prepare.ts";
import { pdfToPng, pngForUnsupported, rasterToPng, readPdf } from "./raster.ts";
import { readRtf, writeRtf } from "./rtf.ts";
import { parseText, writeText } from "./text.ts";
import { onlySheet, readDelimited, readJson, readXlsx, writeDelimited, writeJson, writeXlsx } from "./workbook.ts";

export class ConversionError extends Error {}

export interface ConvertOptions {
  /** Document metadata; overrides what the source declares. */
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string[];
  /** Page size for PDF, Word and RTF. Default A4. */
  pageSize?: PageSize;
  orientation?: "portrait" | "landscape";
  /** Table of contents after the title (PDF, Word, HTML). */
  toc?: boolean;
  /** Accent colour for headings, links, table headers and slide titles, as #RRGGBB. */
  accent?: string;
  /** Page numbers in PDF, Word and RTF footers. Default true. */
  pageNumbers?: boolean;
  /** Slide shape for PowerPoint. Default 16:9. */
  aspect?: "16:9" | "4:3";
  /** Mermaid theme name, e.g. github-light, nord-light, tokyo-night. */
  theme?: string;
  /** PNG pixel density multiplier: 2 gives 144 DPI for pages and twice the natural size for diagrams. Default 2. */
  scale?: number;
  /** PDF pages to read or render, e.g. "1-3,5". Default all. */
  pages?: string;
  /** PNG background; default white for pages and diagrams. Use "transparent" for none. */
  background?: string;
  /** Sheet to write to CSV/TSV, by name. Default the first. */
  sheet?: string;
}

export interface Source {
  data: Uint8Array;
  format: InputFormat;
  /** File name, for sheet names and messages. */
  name?: string;
  /** Directory that relative image paths in the source resolve against. */
  baseDir: string;
}

export interface OutputFile {
  path: string;
  data: Uint8Array;
}

export interface ConversionResult {
  format: OutputFormat;
  files: OutputFile[];
  warnings: string[];
  /** Facts about the result for the summary: pages, slides, sheets, rows, sizes. */
  facts: string[];
}

/** Determine a source's format from its bytes, its declared format and its name, in that order of trust for binary files. */
export function resolveSourceFormat(data: Uint8Array, declared: InputFormat | undefined, path: string | undefined): InputFormat {
  const fromName = path ? formatFromPath(path) : undefined;
  const sniffed = sniffFormat(data, declared ?? fromName);
  // Office 97-2003 files share one container format; only Word's can be read.
  const legacy = path ? /\.(xl[st]|pp[st]|pot)$/i.exec(path) : null;
  if (sniffed === "doc" && legacy && !declared) {
    const app = legacy[1]!.toLowerCase().startsWith("x") ? ["Excel", "xlsx"] : ["PowerPoint", "pptx"];
    throw new ConversionError(`${app[0]} 97-2003 files (.${legacy[1]}) cannot be read; save the file as .${app[1]} first`);
  }
  if (sniffed) {
    // Our .doc files are RTF; a declared or named .doc that is RTF reads as RTF.
    if (sniffed === "rtf") return "rtf";
    return sniffed;
  }
  const format = declared ?? fromName;
  if (format && !["pdf", "png", "jpeg", "docx", "pptx", "xlsx", "doc"].includes(format)) return format;
  if (format) throw new ConversionError(`${path ?? "The input"} is not a valid ${FORMATS[format].label} file`);
  const text = new TextDecoder().decode(data.subarray(0, 4096));
  if (looksLikeMermaid(text)) return "mermaid";
  if (/^\s*(<!doctype html|<html[\s>])/i.test(text)) return "html";
  return "md";
}

function decode(data: Uint8Array): string {
  return new TextDecoder().decode(data);
}

/** Read any supported source into a model. */
export async function loadModel(source: Source, options: ConvertOptions = {}): Promise<{ model: Model; warnings: string[]; facts: string[] }> {
  const warnings: string[] = [];
  const facts: string[] = [];
  const stem = source.name ? basename(source.name, extname(source.name)) : "Sheet1";
  let model: Model;
  switch (source.format) {
    case "md":
      model = parseMarkdown(decode(source.data));
      break;
    case "html":
      model = parseHtml(decode(source.data));
      break;
    case "txt":
      model = parseText(decode(source.data));
      break;
    case "docx": {
      const result = await readDocx(source.data);
      model = result.document;
      warnings.push(...result.warnings);
      break;
    }
    case "doc":
      model = await readDoc(source.data);
      warnings.push("Word 97-2003 import keeps the text only: formatting, tables and images are not read. Save the file as .docx for a fuller conversion.");
      break;
    case "rtf":
      model = readRtf(source.data);
      break;
    case "pptx": {
      const result = await readPptx(source.data);
      model = result.document;
      facts.push(`${result.slides} slide${result.slides === 1 ? "" : "s"} read`);
      break;
    }
    case "pdf":
      model = { kind: "pdf", meta: {}, data: source.data };
      break;
    case "xlsx": {
      const result = await readXlsx(source.data);
      model = result.workbook;
      warnings.push(...result.warnings);
      break;
    }
    case "csv":
    case "tsv":
      model = readDelimited(decode(source.data), { delimiter: source.format === "tsv" ? "\t" : undefined, name: stem });
      break;
    case "json":
      model = readJson(decode(source.data), stem);
      break;
    case "png":
    case "jpeg": {
      const asset = imageAsset(source.data);
      if (!asset) throw new ConversionError(`${source.name ?? "The input"} is not a readable ${source.format.toUpperCase()} image`);
      model = { kind: "image", meta: {}, image: asset };
      break;
    }
    case "svg": {
      model = { kind: "image", meta: {}, image: svgAsset(decode(source.data)) };
      break;
    }
    case "mermaid": {
      const text = decode(source.data);
      model = { kind: "image", meta: {}, image: svgAsset(await renderMermaid(text, { theme: options.theme, accent: options.accent })), source: text };
      break;
    }
  }
  const overrides: Metadata = Object.fromEntries(Object.entries({ title: options.title, author: options.author, subject: options.subject, keywords: options.keywords }).filter(([, value]) => value !== undefined));
  model.meta = { ...model.meta, ...overrides };
  return { model, warnings, facts };
}

/** The diagram of a document that holds nothing but one Mermaid or SVG code block. */
function soleDiagram(document: DocumentModel): Code | undefined {
  const content = document.tree.children.filter((node) => node.type !== "yaml" && !(node.type === "html" && /^<!--[\s\S]*-->$/.test(node.value.trim())));
  const only = content.length === 1 ? content[0] : undefined;
  return only?.type === "code" && (only.lang === "mermaid" || only.lang === "svg") ? only : undefined;
}

async function toDocument(model: Model, options: ConvertOptions, warnings: string[]): Promise<DocumentModel> {
  switch (model.kind) {
    case "document":
      return model;
    case "workbook":
      return workbookToDocument(model);
    case "pdf": {
      const { document } = await readPdf(model.data, { pages: options.pages });
      warnings.push("PDF import extracts text, headings and paragraphs; tables, columns and images are not reconstructed.");
      document.meta = { ...document.meta, ...model.meta };
      return document;
    }
    case "image": {
      if (model.source) {
        return { kind: "document", meta: model.meta, tree: { type: "root", children: [{ type: "code", lang: "mermaid", value: model.source.trim() }] } };
      }
      const url = `data:${model.image.mime};base64,${Buffer.from(model.image.data).toString("base64")}`;
      return { kind: "document", meta: model.meta, tree: { type: "root", children: [{ type: "paragraph", children: [{ type: "image", url, alt: model.meta.title ?? "" }] }] } };
    }
  }
}

async function toWorkbook(model: Model, options: ConvertOptions, warnings: string[], inferTypes: boolean): Promise<WorkbookModel> {
  if (model.kind === "workbook") return model;
  if (model.kind === "image") throw new ConversionError("Images hold no tables; write a document or image format instead");
  const document = await toDocument(model, options, warnings);
  const workbook = documentToWorkbook(document, { inferTypes });
  if (workbook.sheets.length === 0) {
    throw new ConversionError(model.kind === "pdf"
      ? "No tables could be read from this PDF: PDF import extracts text only. Convert it to Markdown or text instead"
      : "The document has no tables. Spreadsheet formats need at least one Markdown or HTML table");
  }
  return workbook;
}

/** Render an image model to PNG or SVG bytes. */
async function imageBytes(model: ImageModel, format: "png" | "svg", options: ConvertOptions): Promise<Uint8Array> {
  const asset = model.image;
  if (format === "svg") {
    if (!asset.svg) throw new ConversionError("SVG output needs vector input: a Mermaid diagram or an SVG file. Write PNG for raster images");
    return new TextEncoder().encode(asset.svg);
  }
  const background = options.background === "transparent" ? undefined : options.background ?? "#FFFFFF";
  if (asset.svg) return svgToPng(asset.svg, { scale: options.scale ?? 2, background });
  if (asset.mime === "image/png") return asset.data;
  return rasterToPng(asset.data);
}

/**
 * Point a Markdown output's images at files it can use: images held as data URIs are written to a
 * folder beside it, and relative paths are rebased from the source's directory to the output's.
 */
function localiseImages(tree: Root, outputPath: string, baseDir: string): OutputFile[] {
  const files: OutputFile[] = [];
  const folder = join(dirname(outputPath), `${basename(outputPath, extname(outputPath))}_files`);
  const extensions: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/svg+xml": ".svg" };
  const visit = (node: Nodes) => {
    if ((node.type === "image" || node.type === "definition") && node.url && !/^([a-z][a-z0-9+.-]*:|#|\/|~)/i.test(node.url) && resolve(baseDir) !== resolve(dirname(outputPath))) {
      const [path, suffix = ""] = node.url.split(/(?=[?#])/, 2);
      let decoded = path!;
      try {
        decoded = decodeURI(path!);
      } catch {
        // Keep malformed escapes as written.
      }
      node.url = encodeURI(relative(dirname(outputPath), resolve(baseDir, decoded)).split("\\").join("/")) + suffix;
    }
    if (node.type === "image" && node.url.startsWith("data:")) {
      const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(node.url);
      const extension = match ? extensions[match[1]!] : undefined;
      if (match && extension) {
        const path = join(folder, `image-${files.length + 1}${extension}`);
        const data = match[2] ? Buffer.from(match[3]!, "base64") : Buffer.from(decodeURIComponent(match[3]!), "utf8");
        files.push({ path, data: new Uint8Array(data) });
        (node as Image).url = relative(dirname(outputPath), path).split("\\").join("/");
      }
    }
    if ("children" in node) for (const child of node.children) visit(child as Nodes);
  };
  visit(tree);
  return files;
}

function pdfPageCount(pdf: Uint8Array): number {
  return (Buffer.from(pdf).toString("latin1").match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length;
}

/**
 * The file for one page of several: report.png becomes report-2.png for page 2, with the number
 * padded to the width of the last page's (report-02.png of 12) so the files sort in page order.
 */
export function numberedPath(path: string, page: number, lastPage: number): string {
  const extension = extname(path);
  return `${path.slice(0, path.length - extension.length)}-${String(page).padStart(String(lastPage).length, "0")}${extension}`;
}

/** Convert a model to an output format. outputPath names the main file; extra files (pages, images) are placed beside it. */
export async function renderModel(model: Model, format: OutputFormat, outputPath: string, options: ConvertOptions & { baseDir: string }, signal?: AbortSignal): Promise<ConversionResult> {
  const warnings: string[] = [];
  const facts: string[] = [];
  const page = { pageSize: options.pageSize, orientation: options.orientation, toc: options.toc, accent: options.accent, pageNumbers: options.pageNumbers };
  const prepare = async (document: DocumentModel): Promise<PreparedDocument> => {
    const prepared = await prepareDocument(document, { baseDir: options.baseDir, diagrams: { theme: options.theme, accent: options.accent } }, htmlToMdast);
    warnings.push(...prepared.warnings);
    signal?.throwIfAborted();
    return prepared;
  };
  const single = (data: Uint8Array): ConversionResult => ({ format, files: [{ path: outputPath, data }], warnings, facts });

  // A document that is just a diagram becomes that diagram when an image is asked for.
  if ((format === "png" || format === "svg") && model.kind === "document") {
    const diagram = soleDiagram(model);
    if (diagram) {
      const svg = diagram.lang === "mermaid" ? await renderMermaid(diagram.value, { theme: options.theme, accent: options.accent }) : diagram.value;
      model = { kind: "image", meta: model.meta, image: svgAsset(svg), source: diagram.lang === "mermaid" ? diagram.value : undefined };
    }
  }

  switch (format) {
    case "pdf": {
      if (model.kind === "pdf") return single(model.data);
      const prepared = await prepare(await toDocument(model, options, warnings));
      await pngForUnsupported(prepared.assets, ["image/png", "image/jpeg", "image/svg+xml"]);
      const pdf = await writePdf(prepared, page);
      facts.push(`${pdfPageCount(pdf)} page${pdfPageCount(pdf) === 1 ? "" : "s"}`);
      return single(pdf);
    }
    case "docx": {
      const written = await writeDocx(await prepare(await toDocument(model, options, warnings)), page);
      warnings.push(...written.warnings);
      return single(written.data);
    }
    case "doc":
      warnings.push("Saved as Rich Text Format under a .doc name, which Word and LibreOffice open as a Word document. Write .docx for full fidelity and for Google Docs.");
      return single(await writeRtf(await prepare(await toDocument(model, options, warnings)), page));
    case "rtf":
      return single(await writeRtf(await prepare(await toDocument(model, options, warnings)), page));
    case "pptx": {
      const prepared = await prepare(await toDocument(model, options, warnings));
      const { data, slides } = await writePptx(prepared, { accent: options.accent, aspect: options.aspect });
      facts.push(`${slides} slide${slides === 1 ? "" : "s"}`);
      return single(data);
    }
    case "html":
      return single(new TextEncoder().encode(writeHtml(await prepare(await toDocument(model, options, warnings)), { toc: options.toc, accent: options.accent })));
    case "md": {
      const document = await toDocument(model, options, warnings);
      const tree = structuredClone(document.tree);
      const images = localiseImages(tree, outputPath, options.baseDir);
      const front = document.meta.title && !tree.children.some((node) => node.type === "yaml" || (node.type === "heading" && node.depth === 1));
      if (front) tree.children.unshift({ type: "heading", depth: 1, children: [{ type: "text", value: document.meta.title! }] });
      if (images.length) facts.push(`${images.length} image${images.length === 1 ? "" : "s"} saved beside it`);
      return { format, files: [{ path: outputPath, data: new TextEncoder().encode(serializeMarkdown(tree)) }, ...images], warnings, facts };
    }
    case "txt":
      return single(new TextEncoder().encode(writeText((await toDocument(model, options, warnings)).tree)));
    case "xlsx": {
      const workbook = await toWorkbook(model, options, warnings, true);
      facts.push(`${workbook.sheets.length} sheet${workbook.sheets.length === 1 ? "" : "s"}`);
      return single(await writeXlsx(workbook, { accent: options.accent }));
    }
    case "csv":
    case "tsv": {
      const workbook = await toWorkbook(model, options, warnings, false);
      const { sheet, warnings: sheetWarnings } = onlySheet(workbook, format, options.sheet);
      warnings.push(...sheetWarnings);
      facts.push(`${Math.max(0, sheet.rows.length - (sheet.header === false ? 0 : 1))} data rows`);
      return single(new TextEncoder().encode(writeDelimited(sheet, format === "tsv" ? "\t" : ",")));
    }
    case "json": {
      const workbook = await toWorkbook(model, options, warnings, true);
      return single(new TextEncoder().encode(writeJson(workbook)));
    }
    case "png":
    case "svg": {
      if (model.kind === "image") {
        const data = await imageBytes(model, format, options);
        const size = format === "png" ? rasterSize(data) : svgSize(new TextDecoder().decode(data));
        if (size) facts.push(`${Math.round(size.width)}x${Math.round(size.height)} ${format === "png" ? "px" : "units"}`);
        return single(data);
      }
      if (format === "svg") throw new ConversionError("SVG output needs a Mermaid diagram or SVG input. Write PNG to render document pages");
      let pdf: Uint8Array;
      if (model.kind === "pdf") pdf = model.data;
      else {
        const prepared = await prepare(await toDocument(model, options, warnings));
        await pngForUnsupported(prepared.assets, ["image/png", "image/jpeg", "image/svg+xml"]);
        pdf = await writePdf(prepared, page);
      }
      signal?.throwIfAborted();
      const background = options.background === "transparent" ? "rgba(0,0,0,0)" : options.background;
      const { pages, pageCount } = await pdfToPng(pdf, { pages: options.pages, scale: options.scale, background });
      facts.push(pages.length === pageCount ? `${pageCount} page${pageCount === 1 ? "" : "s"}` : `pages ${pages.map((p) => p.page).join(", ")} of ${pageCount}`);
      facts.push(`${pages[0]!.width}x${pages[0]!.height} px`);
      // One page keeps the requested name; several are numbered by their page.
      const files = pages.map((p) => ({ path: pages.length === 1 ? outputPath : numberedPath(outputPath, p.page, pageCount), data: p.data }));
      return { format, files, warnings, facts };
    }
  }
}

/** The output path with the format's extension when the path has none. */
export function withExtension(path: string, format: OutputFormat): string {
  return extname(path) ? path : `${path}${extensionFor(format)}`;
}
