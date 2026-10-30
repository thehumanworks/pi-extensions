import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Heading, Paragraph, PhrasingContent, RootContent } from "mdast";
import type { PDFDocumentProxy, TextItem } from "pdfjs-dist/types/src/display/api.js";
import type { DocumentModel, ImageAsset, Metadata } from "./model.ts";

const require = createRequire(import.meta.url);

async function canvas() {
  return import("@napi-rs/canvas");
}

/** Decode PNG, JPEG or GIF (first frame) and re-encode as PNG. */
export async function rasterToPng(data: Uint8Array): Promise<Uint8Array> {
  const { createCanvas, loadImage } = await canvas();
  const image = await loadImage(Buffer.from(data));
  const surface = createCanvas(image.width, image.height);
  surface.getContext("2d").drawImage(image, 0, 0);
  return new Uint8Array(await surface.encode("png"));
}

/** Convert assets a writer cannot embed (GIF in PDF and RTF) to PNG. */
export async function pngForUnsupported(assets: Map<string, ImageAsset>, supported: ImageAsset["mime"][]): Promise<void> {
  for (const [key, asset] of assets) {
    if (supported.includes(asset.mime)) continue;
    if (asset.mime === "image/svg+xml") continue;
    assets.set(key, { ...asset, mime: "image/png", data: await rasterToPng(asset.data) });
  }
}

function pdfjsAsset(folder: string): string {
  return `${join(dirname(require.resolve("pdfjs-dist/package.json")), folder)}/`;
}

/** Open a PDF; call close() when done to free the worker. */
async function openPdf(data: Uint8Array): Promise<{ pdf: PDFDocumentProxy; close: () => Promise<void> }> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // pdf.js may transfer the buffer it is given, so pass a copy.
  const task = pdfjs.getDocument({
    data: new Uint8Array(data),
    cMapUrl: pdfjsAsset("cmaps"),
    cMapPacked: true,
    standardFontDataUrl: pdfjsAsset("standard_fonts"),
    wasmUrl: pdfjsAsset("wasm"),
    iccUrl: pdfjsAsset("iccs"),
    verbosity: 0,
  });
  try {
    return { pdf: await task.promise, close: () => task.destroy() };
  } catch (error) {
    await task.destroy();
    throw error;
  }
}

export class PageRangeError extends Error {}

/** Parse "1-3,5,8-" style page selections (1-based) against a page count. */
export function parsePages(spec: string | undefined, count: number): number[] {
  if (!spec || spec.trim() === "" || spec.trim().toLowerCase() === "all") return Array.from({ length: count }, (_, i) => i + 1);
  const pages = new Set<number>();
  for (const part of spec.split(",")) {
    const match = /^\s*(\d*)\s*(?:(-)\s*(\d*))?\s*$/.exec(part);
    if (!match || (!match[1] && !match[3])) throw new PageRangeError(`Invalid page selection "${part.trim()}"; use forms like 1, 2-4 or 5-`);
    const start = match[1] ? Number(match[1]) : 1;
    const end = match[2] ? (match[3] ? Number(match[3]) : count) : start;
    if (start < 1 || end < start) throw new PageRangeError(`Invalid page range "${part.trim()}"`);
    for (let page = start; page <= Math.min(end, count); page += 1) pages.add(page);
  }
  const selected = [...pages].sort((a, b) => a - b);
  if (selected.length === 0) throw new PageRangeError(`No pages selected: the document has ${count} page${count === 1 ? "" : "s"}`);
  return selected;
}

export interface RasterPage {
  page: number;
  data: Uint8Array;
  width: number;
  height: number;
}

/** Largest PNG side in pixels; bigger requests are scaled down. */
const MAX_SIDE = 10_000;

/** Render PDF pages to PNG. scale 2 gives 144 DPI. */
export async function pdfToPng(data: Uint8Array, options: { pages?: string; scale?: number; background?: string } = {}): Promise<{ pages: RasterPage[]; pageCount: number }> {
  const { createCanvas } = await canvas();
  const { pdf, close } = await openPdf(data);
  try {
    const selected = parsePages(options.pages, pdf.numPages);
    const pages: RasterPage[] = [];
    for (const number of selected) {
      const page = await pdf.getPage(number);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(options.scale ?? 2, MAX_SIDE / Math.max(base.width, base.height));
      const viewport = page.getViewport({ scale });
      const surface = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const context = surface.getContext("2d");
      context.fillStyle = options.background ?? "#FFFFFF";
      context.fillRect(0, 0, surface.width, surface.height);
      await page.render({ canvas: surface as unknown as HTMLCanvasElement, canvasContext: context as unknown as CanvasRenderingContext2D, viewport }).promise;
      pages.push({ page: number, data: new Uint8Array(await surface.encode("png")), width: surface.width, height: surface.height });
      page.cleanup();
    }
    return { pages, pageCount: pdf.numPages };
  } finally {
    await close();
  }
}

interface Line {
  text: string;
  /** Font size: the largest among the line's fragments. */
  size: number;
  /** Baseline, in PDF units from the bottom of the page. */
  y: number;
  x: number;
}

interface Fragment {
  text: string;
  x: number;
  end: number;
  size: number;
}

/** Group pdf.js text items into lines in reading order, joining fragments with a space where the gap is visible. */
export function pageLines(items: TextItem[]): Line[] {
  const groups: { y: number; size: number; fragments: Fragment[] }[] = [];
  let current: (typeof groups)[number] | undefined;
  for (const item of items) {
    if (!item.str) continue;
    const size = Math.hypot(item.transform[2], item.transform[3]) || item.height || 10;
    const x = item.transform[4] as number;
    const y = item.transform[5] as number;
    // Superscripts sit above the baseline but belong to the line.
    if (!current || Math.abs(current.y - y) > Math.max(current.size, size) * 0.5) {
      current = { y, size, fragments: [] };
      groups.push(current);
    }
    current.fragments.push({ text: item.str, x, end: x + item.width, size });
    if (item.str.trim()) current.size = Math.max(current.size, size);
  }
  const lines: Line[] = [];
  for (const group of groups) {
    const fragments = group.fragments.sort((a, b) => a.x - b.x);
    let text = "";
    let end = -Infinity;
    for (const fragment of fragments) {
      const gap = fragment.x - end;
      if (text && gap > fragment.size * 0.15 && !text.endsWith(" ") && !fragment.text.startsWith(" ")) text += " ";
      text += fragment.text;
      end = Math.max(end, fragment.end);
    }
    const textSize = Math.max(0, ...fragments.filter((fragment) => fragment.text.trim()).map((fragment) => fragment.size));
    text = text.replace(/\s+/g, " ").trim();
    if (text) lines.push({ text, size: textSize || group.size, y: group.y, x: fragments[0]!.x });
  }
  return lines;
}

/** Lines repeated at the same height on most pages, such as running headers and page numbers. */
function runningLines(pages: Line[][]): Set<string> {
  const key = (line: Line) => `${Math.round(line.y)}|${line.text.replace(/\d+/g, "#")}`;
  const counts = new Map<string, number>();
  for (const lines of pages) for (const id of new Set(lines.map(key))) counts.set(id, (counts.get(id) ?? 0) + 1);
  const repeated = new Set<string>();
  if (pages.length >= 2) for (const [id, count] of counts) if (count >= Math.max(2, pages.length * 0.6)) repeated.add(id);
  return repeated;
}

const rounded = (size: number) => Math.round(size * 2) / 2;

/**
 * Table of contents lines: "Title 3" or "Title ..... 3" whose title is also a line elsewhere (the
 * heading it points to), at least two on a page, with the "Contents" heading above them.
 */
function contentsLines(pages: Line[][]): Set<Line> {
  const normal = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();
  const texts = new Set(pages.flat().map((line) => normal(line.text)));
  const found = new Set<Line>();
  for (const lines of pages) {
    const entries = lines.filter((line) => {
      const match = /^(.+?)(?:\s*[.·…_]{2,}\s*|\s+)\d{1,4}$/.exec(line.text);
      return match !== null && texts.has(normal(match[1]!));
    });
    if (entries.length < 2) continue;
    for (const entry of entries) found.add(entry);
    const first = lines.indexOf(entries[0]!);
    const title = lines.slice(Math.max(0, first - 2), first).find((line) => /^(table of )?contents$/i.test(line.text.trim()));
    if (title) found.add(title);
  }
  return found;
}

/**
 * Extract a PDF's text as a document. Lines are grouped into paragraphs by spacing; lines in a
 * clearly larger font become headings. Running headers, footers and page numbers are dropped.
 * Layout such as columns and tables is not reconstructed.
 */
export async function readPdf(data: Uint8Array, options: { pages?: string } = {}): Promise<{ document: DocumentModel; pageCount: number }> {
  const { pdf, close } = await openPdf(data);
  try {
    const selected = parsePages(options.pages, pdf.numPages);
    const raw: Line[][] = [];
    for (const number of selected) {
      const page = await pdf.getPage(number);
      const content = await page.getTextContent();
      raw.push(pageLines(content.items.filter((item): item is TextItem => "str" in item)));
      page.cleanup();
    }
    const running = runningLines(raw);
    const kept = raw.map((lines) => lines.filter((line) => !running.has(`${Math.round(line.y)}|${line.text.replace(/\d+/g, "#")}`) && !/^(page\s+)?\d+(\s*(\/|of)\s*\d+)?$/i.test(line.text)));
    const contents = contentsLines(kept);
    const pages = kept.map((lines) => lines.filter((line) => !contents.has(line)));
    // Body text is the size, and its left edge the margin, that cover the most characters.
    const mostCommon = (key: (line: Line) => number, lines = pages.flat()) => {
      const weight = new Map<number, number>();
      for (const line of lines) weight.set(key(line), (weight.get(key(line)) ?? 0) + line.text.length);
      return [...weight.entries()].sort((a, b) => b[1] - a[1]);
    };
    const body = mostCommon((line) => rounded(line.size))[0]?.[0] ?? 10;
    const margin = mostCommon((line) => Math.round(line.x))[0]?.[0] ?? 0;
    // Headings start at the margin: larger text elsewhere is usually inside figures.
    const atMargin = (line: Line) => Math.abs(line.x - margin) <= 2;
    const headingSizes = mostCommon((line) => rounded(line.size), pages.flat().filter(atMargin)).map(([size]) => size).filter((size) => size >= body * 1.15).sort((a, b) => b - a).slice(0, 4);
    const children: RootContent[] = [];
    for (const lines of pages) {
      let paragraph: string[] = [];
      let previous: Line | undefined;
      const flush = () => {
        if (paragraph.length) children.push({ type: "paragraph", children: joinLines(paragraph) } satisfies Paragraph);
        paragraph = [];
      };
      for (const line of lines) {
        const level = atMargin(line) ? headingSizes.indexOf(rounded(line.size)) : -1;
        if (level >= 0 && line.text.length <= 160) {
          flush();
          const last = children[children.length - 1];
          // Headings wrapped over two lines arrive as consecutive heading lines.
          if (previous && last?.type === "heading" && last.depth === level + 1 && previous.size === line.size && previous.y - line.y < line.size * 1.6) {
            (last.children[0] as { value: string }).value += ` ${line.text}`;
          } else {
            children.push({ type: "heading", depth: (level + 1) as Heading["depth"], children: [{ type: "text", value: line.text }] });
          }
          previous = line;
          continue;
        }
        const gap = previous ? previous.y - line.y : 0;
        if (previous && (gap > Math.max(previous.size, line.size) * 1.75 || gap < 0 || Math.abs(previous.size - line.size) > 1 || Math.abs(previous.x - line.x) > line.size * 2)) flush();
        paragraph.push(line.text);
        previous = line;
      }
      flush();
    }
    const info = (await pdf.getMetadata().catch(() => undefined))?.info as Record<string, unknown> | undefined;
    const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
    const meta: Metadata = { title: text(info?.Title), author: text(info?.Author), subject: text(info?.Subject), keywords: text(info?.Keywords)?.split(/[,;]\s*/) };
    return { document: { kind: "document", meta, tree: { type: "root", children } }, pageCount: pdf.numPages };
  } finally {
    await close();
  }
}

/** Join wrapped lines into flowing text, undoing end-of-line hyphenation. */
function joinLines(lines: string[]): PhrasingContent[] {
  let text = "";
  for (const line of lines) {
    if (!text) text = line;
    else if (/[a-z]-$/.test(text) && /^[a-z]/.test(line)) text = text.slice(0, -1) + line;
    else text += ` ${line}`;
  }
  return [{ type: "text", value: text }];
}
