import { mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ExtensionAPI, ToolExposure } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { CONTENT_FORMATS, PAGE_SIZES } from "./src/formats.ts";

export interface CreateDocumentOptions {
  /** How the model reaches the tools. Default "direct". */
  exposure?: ToolExposure;
}

/** The conversion SDK is loaded on first use, so starting Pi stays fast. */
const sdk = () => import("./src/index.ts");

const literals = <T extends string>(values: readonly T[], description: string) => Type.Union(values.map((value) => Type.Literal(value)), { description });

const Metadata = {
  title: Type.Optional(Type.String({ description: "Title metadata; default the front matter title or first H1. Also the slide deck's cover title" })),
  author: Type.Optional(Type.String({ description: "Author metadata" })),
  subject: Type.Optional(Type.String({ description: "Subject metadata" })),
};

const Layout = {
  pageSize: Type.Optional(literals(PAGE_SIZES, "PDF, Word and RTF page size. Default A4")),
  orientation: Type.Optional(literals(["portrait", "landscape"], "Page orientation. Default portrait")),
  toc: Type.Optional(Type.Boolean({ description: "Add a table of contents after the title (PDF, Word, HTML)" })),
  accent: Type.Optional(Type.String({ pattern: "^#[0-9A-Fa-f]{6}$", description: "Accent colour for headings, links, table headers and slide titles, e.g. #1F4E79" })),
  pageNumbers: Type.Optional(Type.Boolean({ description: "Page numbers in PDF, Word and RTF footers. Default true" })),
  aspect: Type.Optional(literals(["16:9", "4:3"], "PowerPoint slide shape. Default 16:9")),
  theme: Type.Optional(Type.String({ description: "Mermaid theme: zinc-light (default), github-light, github-dark, nord-light, nord, solarized-light, tokyo-night, dracula, catppuccin-latte, ..." })),
  scale: Type.Optional(Type.Number({ minimum: 0.25, maximum: 8, description: "PNG resolution multiplier. Pages: 2 = 144 DPI. Diagrams: times natural size. Default 2" })),
  background: Type.Optional(Type.String({ description: "PNG background colour, or transparent. Default white" })),
  sheet: Type.Optional(Type.String({ description: "Sheet to write to CSV/TSV when there are several. Default the first" })),
  overwrite: Type.Optional(Type.Boolean({ description: "Replace existing output files. Default false: existing files are an error" })),
};

// Writing tools replace existing files when given overwrite: true, so they are declared destructive.
const WRITES = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;

const FileResult = Type.Object({
  format: Type.String(),
  files: Type.Array(Type.Object({ path: Type.String(), bytes: Type.Number() })),
  facts: Type.Array(Type.String()),
  warnings: Type.Array(Type.String()),
});

// A type alias, not an interface, so it is assignable to the JSON type of structuredContent.
type FileDetails = {
  format: string;
  files: { path: string; bytes: number }[];
  facts: string[];
  warnings: string[];
};

interface ReadDetails {
  path: string;
  format: string;
  facts: string[];
  warnings: string[];
  fullOutputPath?: string;
}

/** Resolve a path argument against the session's directory, expanding ~. */
function resolvePath(cwd: string, path: string): string {
  const expanded = path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

function display(cwd: string, path: string): string {
  const rel = relative(cwd, path);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : path;
}

function summary(verb: string, cwd: string, result: FileDetails): string {
  const [first, ...rest] = result.files;
  const label = `${result.format.toUpperCase()}${result.facts.length ? `, ${result.facts.join(", ")}` : ""}`;
  const lines = [`${verb} ${display(cwd, first!.path)} (${label}, ${formatSize(first!.bytes)})`];
  if (rest.length) lines.push(`Also wrote ${rest.length} file${rest.length === 1 ? "" : "s"}: ${rest.map((file) => display(cwd, file.path)).join(", ")}`);
  if (result.warnings.length) lines.push("Warnings:", ...result.warnings.map((warning) => `- ${warning}`));
  return lines.join("\n");
}

function details(result: { format: string; files: { path: string; data: Uint8Array }[]; facts: string[]; warnings: string[] }): FileDetails {
  return { format: result.format, files: result.files.map((file) => ({ path: file.path, bytes: file.data.byteLength })), facts: result.facts, warnings: result.warnings };
}

const GUIDELINES = [
  "Write documents as GitHub-flavoured Markdown: headings, lists, task lists, tables, code, quotes, links, footnotes and images (local paths or data URIs) all carry over. YAML front matter (title, author, subject, keywords, lang) sets the metadata.",
  "In Markdown content, ```mermaid fences become rendered diagrams (flowchart, sequenceDiagram, classDiagram, stateDiagram, erDiagram, xychart, pie) and ```svg fences become figures. <!-- pagebreak --> starts a new page.",
  "For PowerPoint, write one slide per `---`-separated section (or per H2 under a single H1, which becomes the cover); HTML comments on a slide become speaker notes. Long content continues on extra slides.",
  "For Excel, CSV, TSV and JSON, give Markdown tables (each becomes a sheet named after the heading above it), CSV/TSV text, or JSON records. Numbers, percentages, currency, dates and =formulas in cells become typed spreadsheet values.",
  "To check a generated PDF or diagram visually, convert it to PNG with convert_document and view the image with read. To check any other output's text, use read_document.",
];

export function registerCreateDocument(pi: ExtensionAPI, options: CreateDocumentOptions = {}): void {
  const common = {
    exposure: options.exposure,
    namespace: { name: "documents", description: "Create, convert and read PDF, Word, PowerPoint, Excel, CSV, HTML, Markdown and PNG documents." },
  } as const;

  pi.registerTool({
    ...common,
    name: "create_document",
    label: "Create document",
    description: "Write a document from Markdown (or HTML, text, CSV, TSV, JSON, Mermaid or SVG) as PDF, Word (.docx, or .doc as Rich Text), RTF, PowerPoint (.pptx), Excel (.xlsx), CSV, TSV, JSON, PNG, SVG, HTML, Markdown or text. The format comes from the file extension. Everything is bundled: no system tools, browsers or downloads.",
    promptSnippet: "Create PDF, Word, PowerPoint, Excel, CSV and PNG files from Markdown, tables or Mermaid",
    promptGuidelines: GUIDELINES,
    parameters: Type.Object({
      path: Type.String({ minLength: 1, description: "Output file, e.g. reports/q3.pdf. Its extension picks the format" }),
      content: Type.String({ description: "The document: Markdown by default; Mermaid, SVG, HTML and JSON are detected; CSV/TSV when writing a spreadsheet without Markdown tables" }),
      contentFormat: Type.Optional(literals(CONTENT_FORMATS, "What content is, when detection would guess wrong")),
      format: Type.Optional(Type.String({ description: "Output format when the extension does not give it: pdf, docx, doc, rtf, pptx, xlsx, csv, tsv, json, png, svg, html, md, txt" })),
      ...Metadata,
      ...Layout,
    }),
    outputSchema: FileResult,
    annotations: WRITES,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const { createDocument } = await sdk();
      const result = details(await createDocument({
        ...params,
        output: resolvePath(ctx.cwd, params.path),
        cwd: ctx.cwd,
        signal,
        queue: withFileMutationQueue,
      }));
      return { content: [{ type: "text", text: summary("Created", ctx.cwd, result) }], structuredContent: result, details: result };
    },
    renderCall(args, theme, context) {
      let text = theme.fg("toolTitle", theme.bold("create_document "));
      text += theme.fg("accent", args.path ? display(context.cwd ?? process.cwd(), args.path) : "...");
      if (args.content) text += theme.fg("dim", ` (${formatSize(Buffer.byteLength(args.content))} ${args.contentFormat ?? "content"})`);
      return new Text(text, 0, 0);
    },
    renderResult(result, { isPartial, expanded }, theme, context) {
      return renderFiles(result.details as FileDetails | undefined, isPartial, expanded, theme, context.cwd ?? process.cwd(), "Creating...");
    },
  });

  pi.registerTool({
    ...common,
    name: "convert_document",
    label: "Convert document",
    description: "Convert a file between formats. Reads PDF, Word (.docx, .doc), RTF, PowerPoint, Excel, CSV, TSV, JSON, HTML, Markdown, text, Mermaid (.mmd), SVG, PNG and JPEG; writes PDF, Word, RTF, PowerPoint, Excel, CSV, TSV, JSON, PNG, SVG, HTML, Markdown and text. PDF and documents to PNG render one image per page; Mermaid and SVG to PNG rasterise the diagram.",
    promptSnippet: "Convert documents between PDF, Word, PowerPoint, Excel, CSV, Markdown, HTML and PNG",
    parameters: Type.Object({
      input: Type.String({ minLength: 1, description: "File to convert" }),
      output: Type.String({ minLength: 1, description: "File to write; its extension picks the format. Several PNG pages are written as name-1.png, name-2.png, ..." }),
      from: Type.Optional(Type.String({ description: "Input format when the extension is missing or wrong" })),
      format: Type.Optional(Type.String({ description: "Output format when the extension does not give it" })),
      pages: Type.Optional(Type.String({ description: "PDF pages to read or render, e.g. 1-3,5. Default all" })),
      ...Metadata,
      ...Layout,
    }),
    outputSchema: FileResult,
    annotations: WRITES,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const { convertDocument } = await sdk();
      const result = details(await convertDocument({
        ...params,
        input: resolvePath(ctx.cwd, params.input),
        output: resolvePath(ctx.cwd, params.output),
        cwd: ctx.cwd,
        signal,
        queue: withFileMutationQueue,
      }));
      return { content: [{ type: "text", text: summary("Wrote", ctx.cwd, result) }], structuredContent: result, details: result };
    },
    renderCall(args, theme, context) {
      const cwd = context.cwd ?? process.cwd();
      let text = theme.fg("toolTitle", theme.bold("convert_document "));
      text += theme.fg("accent", args.input ? display(cwd, args.input) : "...");
      text += theme.fg("muted", " → ");
      text += theme.fg("accent", args.output ? display(cwd, args.output) : "...");
      if (args.pages) text += theme.fg("dim", ` pages ${args.pages}`);
      return new Text(text, 0, 0);
    },
    renderResult(result, { isPartial, expanded }, theme, context) {
      return renderFiles(result.details as FileDetails | undefined, isPartial, expanded, theme, context.cwd ?? process.cwd(), "Converting...");
    },
  });

  pi.registerTool({
    ...common,
    name: "read_document",
    label: "Read document",
    description: `Read a PDF, Word (.docx, .doc), RTF, PowerPoint, Excel, CSV, TSV, JSON or HTML file as Markdown text: headings, lists, tables, slides with speaker notes, and every sheet. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}; the complete text is then saved to a file.`,
    promptSnippet: "Read PDF, Word, PowerPoint and Excel files as Markdown",
    parameters: Type.Object({
      path: Type.String({ minLength: 1, description: "File to read" }),
      from: Type.Optional(Type.String({ description: "Input format when the extension is missing or wrong" })),
      pages: Type.Optional(Type.String({ description: "PDF pages, e.g. 1-3. Default all" })),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { readDocument } = await sdk();
      const path = resolvePath(ctx.cwd, params.path);
      const read = await readDocument({ path, from: params.from, pages: params.pages, cwd: ctx.cwd });
      const header = [`${display(ctx.cwd, path)} (${read.format.toUpperCase()}${read.facts.length ? `, ${read.facts.join(", ")}` : ""})`, ...read.warnings.map((warning) => `Note: ${warning}`)].join("\n");
      const truncation = truncateHead(read.markdown, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
      const info: ReadDetails = { path, format: read.format, facts: read.facts, warnings: read.warnings };
      let text = `${header}\n\n${truncation.content}`;
      if (truncation.truncated) {
        const dir = await mkdtemp(join(tmpdir(), "pi-read-document-"));
        info.fullOutputPath = join(dir, "document.md");
        await writeFile(info.fullOutputPath, read.markdown, "utf8");
        text += `\n\n[Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full Markdown: ${info.fullOutputPath}]`;
      }
      return { content: [{ type: "text", text }], details: info };
    },
    renderCall(args, theme, context) {
      let text = theme.fg("toolTitle", theme.bold("read_document "));
      text += theme.fg("accent", args.path ? display(context.cwd ?? process.cwd(), args.path) : "...");
      if (args.pages) text += theme.fg("dim", ` pages ${args.pages}`);
      return new Text(text, 0, 0);
    },
    renderResult(result, { isPartial, expanded }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Reading..."), 0, 0);
      const info = result.details as ReadDetails | undefined;
      const content = result.content[0];
      const body = content?.type === "text" ? content.text : "";
      let text = theme.fg("success", `${info?.format.toUpperCase() ?? "Document"}${info?.facts.length ? ` · ${info.facts.join(" · ")}` : ""}`);
      if (info?.fullOutputPath) text += theme.fg("warning", " (truncated)");
      if (expanded) {
        const lines = body.split("\n").slice(0, 40);
        for (const line of lines) text += `\n${theme.fg("dim", line)}`;
        if (body.split("\n").length > 40) text += `\n${theme.fg("muted", "...")}`;
      }
      return new Text(text, 0, 0);
    },
  });
}

type Theme = Parameters<NonNullable<Parameters<ExtensionAPI["registerTool"]>[0]["renderCall"]>>[1];

function renderFiles(info: FileDetails | undefined, isPartial: boolean, expanded: boolean, theme: Theme, cwd: string, working: string): Text {
  if (isPartial || !info) return new Text(theme.fg("warning", working), 0, 0);
  const [first, ...rest] = info.files;
  let text = theme.fg("success", `${display(cwd, first!.path)}`);
  text += theme.fg("muted", ` · ${[info.format.toUpperCase(), ...info.facts, formatSize(first!.bytes)].join(" · ")}`);
  if (rest.length) text += theme.fg("muted", ` · +${rest.length} file${rest.length === 1 ? "" : "s"}`);
  if (info.warnings.length) text += theme.fg("warning", ` · ${info.warnings.length} warning${info.warnings.length === 1 ? "" : "s"}`);
  if (expanded) {
    for (const file of rest) text += `\n${theme.fg("dim", `${display(cwd, file.path)} (${formatSize(file.bytes)})`)}`;
    for (const warning of info.warnings) text += `\n${theme.fg("warning", `! ${warning}`)}`;
  }
  return new Text(text, 0, 0);
}

export default function createDocumentExtension(pi: ExtensionAPI): void {
  registerCreateDocument(pi);
}
