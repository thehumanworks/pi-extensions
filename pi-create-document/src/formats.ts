import { extname } from "node:path";

/** Formats the SDK can write. */
export const OUTPUT_FORMATS = ["pdf", "docx", "doc", "rtf", "pptx", "xlsx", "csv", "tsv", "json", "png", "svg", "html", "md", "txt"] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

/** Formats the SDK can read. */
export const INPUT_FORMATS = ["pdf", "docx", "doc", "rtf", "pptx", "xlsx", "csv", "tsv", "json", "png", "jpeg", "svg", "mermaid", "html", "md", "txt"] as const;
export type InputFormat = (typeof INPUT_FORMATS)[number];

/** Formats a caller can name for content passed as text. */
export const CONTENT_FORMATS = ["markdown", "html", "text", "csv", "tsv", "json", "mermaid", "svg"] as const;
export type ContentFormat = (typeof CONTENT_FORMATS)[number];

export const PAGE_SIZES = ["A4", "Letter", "Legal", "A3", "A5"] as const;
export type PageSize = (typeof PAGE_SIZES)[number];

/** What a format holds: flowing documents, tables of cells, or a single picture. */
export type FormatKind = "document" | "workbook" | "image";

interface FormatInfo {
  label: string;
  extensions: string[];
  mime: string;
  kind: FormatKind;
}

export const FORMATS: Record<OutputFormat | InputFormat, FormatInfo> = {
  pdf: { label: "PDF", extensions: [".pdf"], mime: "application/pdf", kind: "document" },
  docx: { label: "Word document", extensions: [".docx"], mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", kind: "document" },
  doc: { label: "Word 97-2003 document (Rich Text)", extensions: [".doc"], mime: "application/msword", kind: "document" },
  rtf: { label: "Rich Text Format", extensions: [".rtf"], mime: "application/rtf", kind: "document" },
  pptx: { label: "PowerPoint presentation", extensions: [".pptx"], mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", kind: "document" },
  xlsx: { label: "Excel workbook", extensions: [".xlsx"], mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", kind: "workbook" },
  csv: { label: "CSV", extensions: [".csv"], mime: "text/csv", kind: "workbook" },
  tsv: { label: "TSV", extensions: [".tsv", ".tab"], mime: "text/tab-separated-values", kind: "workbook" },
  json: { label: "JSON", extensions: [".json"], mime: "application/json", kind: "workbook" },
  png: { label: "PNG image", extensions: [".png"], mime: "image/png", kind: "image" },
  jpeg: { label: "JPEG image", extensions: [".jpg", ".jpeg"], mime: "image/jpeg", kind: "image" },
  svg: { label: "SVG image", extensions: [".svg"], mime: "image/svg+xml", kind: "image" },
  mermaid: { label: "Mermaid diagram", extensions: [".mmd", ".mermaid"], mime: "text/vnd.mermaid", kind: "image" },
  html: { label: "HTML", extensions: [".html", ".htm", ".xhtml"], mime: "text/html", kind: "document" },
  md: { label: "Markdown", extensions: [".md", ".markdown", ".mdown", ".mkd"], mime: "text/markdown", kind: "document" },
  txt: { label: "plain text", extensions: [".txt", ".text", ".log"], mime: "text/plain", kind: "document" },
};

export function isOutputFormat(value: string): value is OutputFormat {
  return (OUTPUT_FORMATS as readonly string[]).includes(value);
}

export function isInputFormat(value: string): value is InputFormat {
  return (INPUT_FORMATS as readonly string[]).includes(value);
}

const ALIASES: Record<string, InputFormat> = {
  markdown: "md",
  text: "txt",
  plain: "txt",
  htm: "html",
  jpg: "jpeg",
  mmd: "mermaid",
  word: "docx",
  excel: "xlsx",
  powerpoint: "pptx",
};

/** Normalise a user-supplied format name or extension: "Markdown", ".JPG" and "mmd" all work. */
export function normalizeFormat(value: string): InputFormat | undefined {
  const name = value.trim().toLowerCase().replace(/^\./, "");
  if (isInputFormat(name)) return name;
  if (name in ALIASES) return ALIASES[name];
  for (const [format, info] of Object.entries(FORMATS)) if (info.extensions.includes(`.${name}`)) return format as InputFormat;
  return undefined;
}

/** The format implied by a file name, or undefined for unknown extensions. */
export function formatFromPath(path: string): InputFormat | undefined {
  const ext = extname(path).toLowerCase();
  if (!ext) return undefined;
  for (const [format, info] of Object.entries(FORMATS)) if (info.extensions.includes(ext)) return format as InputFormat;
  return undefined;
}

export function outputFormatFromPath(path: string): OutputFormat | undefined {
  const format = formatFromPath(path);
  return format && isOutputFormat(format) ? format : undefined;
}

export function extensionFor(format: OutputFormat): string {
  return FORMATS[format].extensions[0]!;
}

/**
 * Identify a file by its leading bytes. Office Open XML files are all ZIP archives, so the
 * extension (when it names one of them) decides between DOCX, PPTX and XLSX.
 */
export function sniffFormat(data: Uint8Array, hint?: InputFormat): InputFormat | undefined {
  const starts = (...bytes: number[]) => bytes.every((byte, index) => data[index] === byte);
  if (starts(0x25, 0x50, 0x44, 0x46)) return "pdf";
  if (starts(0x89, 0x50, 0x4e, 0x47)) return "png";
  if (starts(0xff, 0xd8, 0xff)) return "jpeg";
  if (starts(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1)) return "doc";
  if (starts(0x50, 0x4b, 0x03, 0x04)) {
    if (hint === "docx" || hint === "pptx" || hint === "xlsx") return hint;
    // Entry names appear in the local headers and in the central directory at the end.
    const latin1 = new TextDecoder("latin1");
    const names = latin1.decode(data.subarray(0, 4096)) + latin1.decode(data.subarray(Math.max(0, data.length - 65_536)));
    if (names.includes("word/document")) return "docx";
    if (names.includes("ppt/presentation")) return "pptx";
    if (names.includes("xl/workbook")) return "xlsx";
    return hint;
  }
  const text = new TextDecoder().decode(data.subarray(0, 512)).replace(/^\uFEFF/, "").trimStart();
  if (text.startsWith("{\\rtf")) return "rtf";
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(text)) return "svg";
  return undefined;
}
