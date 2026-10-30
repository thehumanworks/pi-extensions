import type { Heading, List, ListItem, Nodes, PhrasingContent, RootContent, Table as MdTable, TableCell as MdTableCell } from "mdast";
import { toString as nodeText } from "mdast-util-to-string";
import { fit } from "./assets.ts";
import { svgToPng } from "./diagram.ts";
import { officeProperties } from "./docx.ts";
import { documentTitle } from "./html.ts";
import type { DocumentModel } from "./model.ts";
import { commentText, figureImage, isPageBreak, type PreparedDocument } from "./prepare.ts";

type PptxGenJS = import("pptxgenjs").default;
type TextProps = import("pptxgenjs").default.TextProps;
type TableRow = import("pptxgenjs").default.TableRow;
type Slide = import("pptxgenjs").default.Slide;

export interface SlideOptions {
  /** Title, heading and table header colour, as hex. */
  accent?: string;
  /** Slide shape. Default 16:9. */
  aspect?: "16:9" | "4:3";
}

/** Slide size in inches. */
const SIZES = { "16:9": { width: 13.333, height: 7.5 }, "4:3": { width: 10, height: 7.5 } } as const;
const MARGIN = 0.6;
const TITLE_Y = 0.4;
const TITLE_H = 0.9;
const BODY_Y = 1.45;
const BOTTOM = 0.55;
const FONT = "Calibri";
const CODE_FONT = "Consolas";
const TEXT = "1F2328";
const MUTED = "59636E";
const RULE = "D0D7DE";
const CODE_BG = "F6F8FA";
const BODY_SIZE = 20;
const TITLED = "Title and Content";
const COVER = "Title Slide";

interface SlideSpec {
  title?: string;
  /** Opening slide: large centred title with an optional subtitle. */
  cover?: boolean;
  blocks: RootContent[];
  notes: string[];
}

/**
 * Split a document into slides. Thematic breaks (---, as in Marp and Slidev), page breaks and
 * headings at the slide level each start a slide. The slide level is H2 when a single H1 heads
 * the document (making a cover slide), else the highest heading level used. Footnotes go to the
 * speaker notes of the slides that cite them.
 */
export function splitSlides(nodes: RootContent[]): SlideSpec[] {
  const footnotes = new Map<string, string>();
  for (const node of nodes) if (node.type === "footnoteDefinition") footnotes.set(node.identifier, nodeText(node).trim());
  const content = nodes.filter((node) => node.type !== "yaml" && node.type !== "definition" && node.type !== "footnoteDefinition");
  const headings = content.filter((node): node is Heading => node.type === "heading");
  const h1 = headings.filter((heading) => heading.depth === 1).length;
  const minDepth = Math.min(...headings.map((heading) => heading.depth));
  const level = h1 === 1 && headings.some((heading) => heading.depth === 2) ? 2 : Number.isFinite(minDepth) ? minDepth : 1;
  const chunks: RootContent[][] = [];
  let chunk: RootContent[] = [];
  for (const node of content) {
    if (node.type === "thematicBreak" || isPageBreak(node)) {
      chunks.push(chunk);
      chunk = [];
      continue;
    }
    if (node.type === "heading" && node.depth <= level && chunk.length > 0) {
      chunks.push(chunk);
      chunk = [];
    }
    chunk.push(node);
  }
  chunks.push(chunk);
  const slides: SlideSpec[] = [];
  chunks.forEach((chunk, index) => {
    const notes = chunk.map(commentText).filter((text): text is string => Boolean(text));
    const blocks = chunk.filter((node) => commentText(node) === undefined);
    if (blocks.length === 0 && notes.length === 0) return;
    const cited = new Set<string>();
    const visit = (node: Nodes) => {
      if (node.type === "footnoteReference") cited.add(node.identifier);
      if ("children" in node) for (const child of node.children) visit(child as Nodes);
    };
    blocks.forEach(visit);
    for (const id of cited) if (footnotes.has(id)) notes.push(`[${id}] ${footnotes.get(id)}`);
    const first = blocks[0];
    const title = first?.type === "heading" ? nodeText(first).trim() : undefined;
    const body = title !== undefined ? blocks.slice(1) : blocks;
    const cover = index === 0 && first?.type === "heading" && first.depth === 1 && body.every((node) => node.type === "paragraph" && !figureImage(node)) && nodeText({ type: "root", children: body }).length <= 300;
    slides.push({ title, cover, blocks: body, notes });
  });
  return slides;
}

type Item =
  | { kind: "text"; paragraphs: TextProps[][]; lines: number }
  | { kind: "code"; text: string; lines: number }
  | { kind: "table"; node: MdTable }
  | { kind: "image"; url: string; alt: string };

/** Approximate lines a text occupies at a font size within a width in inches. */
function lineCount(text: string, width: number, size: number): number {
  const perLine = Math.max(8, (width * 72) / (size * 0.5));
  return text.split("\n").reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / perLine)), 0);
}

class SlideBuilder {
  readonly images = new Map<string, { data: string; width: number; height: number }>();
  readonly width: number;
  readonly height: number;
  private readonly prepared: PreparedDocument;
  private readonly accent: string;

  constructor(prepared: PreparedDocument, accent: string, aspect: "16:9" | "4:3") {
    this.prepared = prepared;
    this.accent = accent;
    this.width = SIZES[aspect].width;
    this.height = SIZES[aspect].height;
  }

  /** Slides show diagrams as PNG: PowerPoint, Keynote and Google Slides all display it. */
  async loadImages(): Promise<void> {
    for (const [key, asset] of this.prepared.assets) {
      const png = asset.svg ? await svgToPng(asset.svg, { scale: 2, background: "#FFFFFF" }) : asset.data;
      const mime = asset.svg ? "image/png" : asset.mime;
      this.images.set(key, { data: `${mime};base64,${Buffer.from(png).toString("base64")}`, width: asset.width, height: asset.height });
    }
  }

  private runs(nodes: PhrasingContent[], style: TextProps["options"] = {}): TextProps[] {
    return nodes.flatMap((node): TextProps[] => {
      switch (node.type) {
        case "text":
          return [{ text: node.value.replace(/\s*\n\s*/g, " "), options: { ...style } }];
        case "emphasis":
          return this.runs(node.children, { ...style, italic: true });
        case "strong":
          return this.runs(node.children, { ...style, bold: true });
        case "delete":
          return this.runs(node.children, { ...style, strike: "sngStrike" });
        case "inlineCode":
          return [{ text: node.value, options: { ...style, fontFace: CODE_FONT, color: TEXT, highlight: CODE_BG } }];
        case "break":
          return [{ text: "", options: { ...style, softBreakBefore: true } }];
        case "link":
          if (node.url.startsWith("#")) return this.runs(node.children, style);
          return this.runs(node.children, { ...style, hyperlink: { url: node.url }, color: this.accent });
        case "image":
          return node.alt ? [{ text: `[${node.alt}]`, options: { ...style, italic: true, color: MUTED } }] : [];
        case "footnoteReference":
          return [{ text: `[${node.label ?? node.identifier}]`, options: { ...style, superscript: true } }];
        case "html":
          return [];
        default:
          return "children" in node ? this.runs(node.children as PhrasingContent[], style) : [{ text: nodeText(node), options: { ...style } }];
      }
    });
  }

  /**
   * A paragraph's runs for pptxgenjs, which starts a paragraph at a line break, at a change of
   * alignment, or (only when no run is aligned) at every run with a bullet. Every run is therefore
   * aligned; bullet, level and spacing go on the first run and a line break on the last.
   */
  private paragraph(runs: TextProps[], options: NonNullable<TextProps["options"]>): TextProps[] {
    const list = runs.length ? runs : [{ text: "" }];
    const { align = "left", ...first } = options;
    return list.map((run, index) => ({
      text: run.text,
      options: { ...(index === 0 ? first : {}), ...run.options, align, ...(index === list.length - 1 ? { breakLine: true } : {}) },
    }));
  }

  private listParagraphs(node: List, level: number, out: TextProps[][]): void {
    let number = node.start ?? 1;
    for (const item of node.children as ListItem[]) {
      item.children.forEach((child, index) => {
        if (child.type === "list") return this.listParagraphs(child, level + 1, out);
        const runs = child.type === "paragraph" ? this.runs(child.children) : [{ text: nodeText(child) }];
        // Task items use their box as the bullet.
        const bullet = index > 0 ? false : item.checked != null ? { characterCode: item.checked ? "2611" : "2610" } : node.ordered ? { type: "number" as const, numberStartAt: number } : true;
        out.push(this.paragraph(runs, { bullet, indentLevel: level, paraSpaceAfter: 4 }));
      });
      number += 1;
    }
  }

  /** Slide content as layout items, merging consecutive text blocks into one text box. */
  items(blocks: RootContent[], textWidth: number): Item[] {
    const items: Item[] = [];
    const text = (): Extract<Item, { kind: "text" }> => {
      const last = items[items.length - 1];
      if (last?.kind === "text") return last;
      const item: Extract<Item, { kind: "text" }> = { kind: "text", paragraphs: [], lines: 0 };
      items.push(item);
      return item;
    };
    const visit = (node: RootContent, quote: boolean) => {
      const quoteStyle = quote ? { italic: true, color: MUTED } : {};
      switch (node.type) {
        case "paragraph": {
          const image = figureImage(node);
          if (image) {
            items.push({ kind: "image", url: image.url, alt: image.alt ?? "" });
            return;
          }
          const item = text();
          item.paragraphs.push(this.paragraph(this.runs(node.children, quoteStyle), { paraSpaceAfter: 8 }));
          item.lines += lineCount(nodeText(node), textWidth, BODY_SIZE) + 0.3;
          return;
        }
        case "heading": {
          const item = text();
          item.paragraphs.push(this.paragraph(this.runs(node.children, { bold: true, color: this.accent, fontSize: node.depth <= 3 ? 20 : BODY_SIZE }), { paraSpaceAfter: 6 }));
          item.lines += 1.3;
          return;
        }
        case "list": {
          const item = text();
          const paragraphs: TextProps[][] = [];
          this.listParagraphs(node, 0, paragraphs);
          item.paragraphs.push(...paragraphs);
          for (const paragraph of paragraphs) item.lines += lineCount(paragraph.map((run) => run.text ?? "").join(""), textWidth - 0.6, BODY_SIZE) + 0.15;
          return;
        }
        case "blockquote":
          for (const child of node.children) visit(child, true);
          return;
        case "code":
          items.push({ kind: "code", text: node.value.replace(/\t/g, "    "), lines: node.value.split("\n").length });
          return;
        case "table":
          items.push({ kind: "table", node });
          return;
        case "html":
        case "thematicBreak":
          return;
        default:
          if ("children" in node) for (const child of node.children as RootContent[]) visit(child, quote);
      }
    };
    for (const block of blocks) visit(block, false);
    return items;
  }

  /** Layouts whose titles are title placeholders, so PowerPoint's outline, accessibility checks and readers see them as titles. */
  defineMasters(pptx: PptxGenJS): void {
    const width = this.width - 2 * MARGIN;
    pptx.defineSlideMaster({
      title: TITLED,
      objects: [
        { placeholder: { options: { name: "title", type: "title", x: MARGIN, y: TITLE_Y, w: width, h: TITLE_H, fontFace: FONT, fontSize: 30, bold: true, color: this.accent, align: "left", valign: "bottom", margin: 0 }, text: "" } },
        { line: { x: MARGIN, y: TITLE_Y + TITLE_H + 0.08, w: width, h: 0, line: { color: RULE, width: 1 } } },
      ],
    });
    pptx.defineSlideMaster({
      title: COVER,
      objects: [{ placeholder: { options: { name: "title", type: "title", x: MARGIN, y: this.height * 0.3, w: width, h: 1.4, fontFace: FONT, fontSize: 40, bold: true, color: this.accent, align: "center", valign: "bottom" }, text: "" } }],
    });
  }

  private addTitle(slide: Slide, title: string, continued: boolean): void {
    slide.addText(continued ? `${title} (continued)` : title, { placeholder: "title", fontFace: FONT, fontSize: title.length > 60 ? 24 : 30, bold: true, color: this.accent, align: "left", valign: "bottom", fit: "shrink", margin: 0 });
  }

  private tableRows(node: MdTable, rows: number[], fontSize: number): TableRow[] {
    const columns = Math.max(...node.children.map((row) => row.children.length));
    return [0, ...rows].map((rowIndex) => {
      const row = node.children[rowIndex]!;
      return Array.from({ length: columns }, (_, column) => {
        const cell: MdTableCell | undefined = row.children[column];
        const header = rowIndex === 0;
        const runs = cell ? this.runs(cell.children, header ? { bold: true, color: "FFFFFF" } : {}) : [];
        return {
          text: runs.length ? runs : "",
          options: {
            fontFace: FONT, fontSize, color: header ? "FFFFFF" : TEXT, align: node.align?.[column] ?? "left", valign: "middle",
            fill: { color: header ? this.accent : rowIndex % 2 === 0 ? "F3F5F7" : "FFFFFF" },
            border: [{ type: "none" }, { type: "none" }, { type: "solid", color: RULE, pt: 0.75 }, { type: "none" }],
            margin: [4, 8, 4, 8],
          },
        };
      });
    });
  }

  /** Add one slide per page of content, continuing long content on further slides with the same title. */
  render(pptx: PptxGenJS, spec: SlideSpec): void {
    if (spec.cover) {
      const slide = pptx.addSlide({ masterName: COVER });
      slide.addText(spec.title ?? "", { placeholder: "title", fontFace: FONT, fontSize: 40, bold: true, color: this.accent, align: "center", valign: "bottom", fit: "shrink" });
      const subtitle = spec.blocks.flatMap((node) => (node.type === "paragraph" ? [this.paragraph(this.runs(node.children), { align: "center", paraSpaceAfter: 6 })] : []));
      const meta = [this.prepared.meta.author, this.prepared.meta.subject].filter(Boolean).join(" · ");
      if (subtitle.length) slide.addText(subtitle.flat(), { x: MARGIN + 0.5, y: this.height * 0.3 + 1.55, w: this.width - 2 * MARGIN - 1, h: 1.2, fontFace: FONT, fontSize: 20, color: MUTED, align: "center", valign: "top", fit: "shrink" });
      if (meta) slide.addText(meta, { x: MARGIN, y: this.height - 1.2, w: this.width - 2 * MARGIN, h: 0.5, fontFace: FONT, fontSize: 14, color: MUTED, align: "center" });
      if (spec.notes.length) slide.addNotes(spec.notes.join("\n\n"));
      return;
    }
    const left = MARGIN;
    const fullWidth = this.width - 2 * MARGIN;
    const top = spec.title !== undefined ? BODY_Y : MARGIN;
    const bottom = this.height - BOTTOM;
    let items = this.items(spec.blocks, fullWidth);
    let slide: Slide | undefined;
    let y = top;
    let pages = 0;
    const lineHeight = (BODY_SIZE * 1.2) / 72;
    const newSlide = () => {
      slide = pptx.addSlide(spec.title !== undefined ? { masterName: TITLED } : undefined);
      pages += 1;
      if (spec.title !== undefined) this.addTitle(slide, spec.title, pages > 1);
      if (pages === 1 && spec.notes.length) slide.addNotes(spec.notes.join("\n\n"));
      y = top;
      return slide;
    };
    newSlide();

    // Short text beside a single picture reads better as two columns.
    const textItems = items.filter((item) => item.kind === "text");
    const visuals = items.filter((item) => item.kind === "image");
    if (items.length === 2 && textItems.length === 1 && visuals.length === 1 && textItems[0]!.kind === "text" && textItems[0]!.lines <= 9) {
      const textWidth = fullWidth * 0.42;
      const textItem = textItems[0] as Extract<Item, { kind: "text" }>;
      slide!.addText(textItem.paragraphs.flat(), { x: left, y: top, w: textWidth, h: bottom - top, fontFace: FONT, fontSize: BODY_SIZE, color: TEXT, valign: "middle", fit: "shrink", margin: 0 });
      this.placeImage(slide!, visuals[0] as Extract<Item, { kind: "image" }>, left + textWidth + 0.3, top, fullWidth - textWidth - 0.3, bottom - top, true);
      return;
    }

    while (items.length > 0) {
      const item = items.shift()!;
      const space = bottom - y;
      if (item.kind === "text") {
        const needed = item.lines * lineHeight + 0.1;
        if (needed <= space || y === top) {
          // Split text that overflows an empty slide at a paragraph boundary.
          let paragraphs = item.paragraphs;
          let rest: TextProps[][] = [];
          if (needed > space) {
            const ratio = space / needed;
            const keep = Math.max(1, Math.floor(paragraphs.length * ratio));
            rest = paragraphs.slice(keep);
            paragraphs = paragraphs.slice(0, keep);
          }
          const height = Math.min(space, (needed * paragraphs.length) / item.paragraphs.length);
          slide!.addText(paragraphs.flat(), { x: left, y, w: fullWidth, h: height, fontFace: FONT, fontSize: BODY_SIZE, color: TEXT, valign: "top", fit: "shrink", margin: 0 });
          y += height + 0.15;
          if (rest.length) {
            items.unshift({ kind: "text", paragraphs: rest, lines: item.lines * (rest.length / item.paragraphs.length) });
            newSlide();
          }
        } else {
          items.unshift(item);
          newSlide();
        }
      } else if (item.kind === "code") {
        const size = item.lines > 18 ? 12 : item.lines > 12 ? 14 : 16;
        const lineH = (size * 1.2) / 72;
        const fitLines = Math.max(1, Math.floor((space - 0.3) / lineH));
        if (fitLines < Math.min(item.lines, 4) && y !== top) {
          items.unshift(item);
          newSlide();
          continue;
        }
        const lines = item.text.split("\n");
        const shown = lines.slice(0, fitLines);
        const height = shown.length * lineH + 0.3;
        slide!.addText(shown.join("\n"), { x: left, y, w: fullWidth, h: height, fontFace: CODE_FONT, fontSize: size, color: TEXT, fill: { color: CODE_BG }, line: { color: RULE, width: 0.75 }, valign: "top", margin: [6, 10, 6, 10] });
        y += height + 0.2;
        if (lines.length > fitLines) {
          items.unshift({ kind: "code", text: lines.slice(fitLines).join("\n"), lines: lines.length - fitLines });
          newSlide();
        }
      } else if (item.kind === "table") {
        const node = item.node;
        const columns = Math.max(...node.children.map((row) => row.children.length));
        const fontSize = columns > 8 ? 11 : columns > 6 ? 13 : columns > 4 ? 15 : 18;
        const lengths = Array.from({ length: columns }, (_, column) => Math.min(40, Math.max(4, ...node.children.map((row) => nodeText(row.children[column] ?? { type: "text", value: "" }).length))));
        const total = lengths.reduce((sum, length) => sum + length, 0);
        const colW = lengths.map((length) => (length / total) * fullWidth);
        const rowHeight = (row: number) => {
          const lines = Math.max(1, ...Array.from({ length: columns }, (_, column) => lineCount(nodeText(node.children[row]!.children[column] ?? { type: "text", value: "" }), colW[column]! - 0.15, fontSize)));
          return (lines * fontSize * 1.2) / 72 + 0.12;
        };
        const remaining = Array.from({ length: node.children.length - 1 }, (_, index) => index + 1);
        let height = rowHeight(0);
        const rows: number[] = [];
        while (remaining.length && height + rowHeight(remaining[0]!) <= space) {
          height += rowHeight(remaining[0]!);
          rows.push(remaining.shift()!);
        }
        if (rows.length === 0 && remaining.length && y !== top) {
          items.unshift(item);
          newSlide();
          continue;
        }
        if (rows.length === 0 && remaining.length) rows.push(remaining.shift()!);
        slide!.addTable(this.tableRows(node, rows, fontSize), { x: left, y, w: fullWidth, colW, fontFace: FONT, fontSize, autoPage: false });
        y += height + 0.2;
        if (remaining.length) {
          items.unshift({ kind: "table", node: { ...node, children: [node.children[0]!, ...remaining.map((row) => node.children[row]!)] } });
          newSlide();
        }
      } else {
        const image = this.images.get(item.url);
        // A picture that would show at under 70% of its size on an empty slide goes to the next slide.
        const cramped = image ? fit(image.width, image.height, fullWidth, space).height < fit(image.width, image.height, fullWidth, bottom - top).height * 0.7 : space < 0.5;
        if (cramped && y !== top) {
          items.unshift(item);
          newSlide();
          continue;
        }
        // A picture alone on its slide is centred in the body; otherwise it follows the content above.
        y += this.placeImage(slide!, item, left, y, fullWidth, space, y === top && items.length === 0) + 0.2;
      }
    }
  }

  /** Place an image in a box, centred horizontally (and vertically when asked); returns the height used. */
  private placeImage(slide: Slide, item: { url: string; alt: string }, x: number, y: number, width: number, height: number, middle: boolean): number {
    const image = this.images.get(item.url);
    if (!image) {
      slide.addText(`[${item.alt || "image"}]`, { x, y, w: width, h: 0.5, fontFace: FONT, fontSize: 14, italic: true, color: MUTED });
      return 0.5;
    }
    const size = fit(image.width / 96, image.height / 96, width, height);
    // Diagrams are often small; scale them up to use the space, to at most 1.6x.
    const grow = Math.min(1.6, width / size.width, height / size.height);
    const w = size.width * Math.max(1, grow);
    const h = size.height * Math.max(1, grow);
    slide.addImage({ data: image.data, x: x + (width - w) / 2, y: middle ? y + (height - h) / 2 : y, w, h, altText: item.alt });
    return middle ? height : h;
  }
}

/** Write a PowerPoint presentation. Text stays editable; diagrams become pictures. */
export async function writePptx(prepared: PreparedDocument, options: SlideOptions = {}): Promise<{ data: Uint8Array; slides: number }> {
  // The ES build's default export is the class; the CommonJS-style types put it one level deeper.
  const loaded = (await import("pptxgenjs")) as unknown as { default: (new () => PptxGenJS) & { default?: new () => PptxGenJS } };
  const Presentation = loaded.default.default ?? loaded.default;
  const pptx = new Presentation();
  const aspect = options.aspect ?? "16:9";
  pptx.layout = aspect === "4:3" ? "LAYOUT_4x3" : "LAYOUT_WIDE";
  pptx.theme = { headFontFace: FONT, bodyFontFace: FONT };
  const title = documentTitle(prepared);
  if (title) pptx.title = title;
  if (prepared.meta.author) pptx.author = prepared.meta.author;
  if (prepared.meta.subject) pptx.subject = prepared.meta.subject;
  const accent = (options.accent ?? "#1F4E79").replace("#", "").toUpperCase();
  const builder = new SlideBuilder(prepared, accent, aspect);
  builder.defineMasters(pptx);
  await builder.loadImages();
  const specs = splitSlides(prepared.tree.children);
  if (specs.length === 0) specs.push({ title, cover: true, blocks: [], notes: [] });
  for (const spec of specs) builder.render(pptx, spec);
  const slides = (pptx as unknown as { slides: unknown[] }).slides.length;
  // Number every slide after the cover.
  (pptx as unknown as { slides: Slide[] }).slides.forEach((slide, index) => {
    if (index > 0 || !specs[0]?.cover) slide.slideNumber = { x: builder.width - MARGIN - 0.8, y: builder.height - 0.45, w: 0.8, h: 0.3, fontFace: FONT, fontSize: 10, color: MUTED, align: "right" };
  });
  const data = (await pptx.write({ outputType: "nodebuffer", compression: true })) as Buffer;
  return { data: await singleParagraphProperties(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)), slides };
}

/**
 * pptxgenjs writes paragraph properties (a:pPr) before every run of a paragraph, but the schema
 * allows one, first; PowerPoint offers to repair such files. Keep only the leading one.
 */
async function singleParagraphProperties(data: Uint8Array): Promise<Uint8Array> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(data);
  for (const name of Object.keys(zip.files).filter((path) => /^ppt\/(slides|slideLayouts|slideMasters|notesSlides)\/[^/]+\.xml$/.test(path))) {
    const xml = await zip.file(name)!.async("string");
    const fixed = xml.replace(/<a:p>([\s\S]*?)<\/a:p>/g, (_, body: string) => {
      const kept = body.replace(/<a:pPr\b[^>]*?(?:\/>|>[\s\S]*?<\/a:pPr>)/g, (match: string, offset: number) => (offset === 0 ? match : ""));
      return `<a:p>${kept}</a:p>`;
    });
    if (fixed !== xml) zip.file(name, fixed);
  }
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

const NS = {
  a: "http://schemas.openxmlformats.org/drawingml/2006/main",
  p: "http://schemas.openxmlformats.org/presentationml/2006/main",
  r: "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
};

type XmlElement = import("@xmldom/xmldom").Element;

function elements(node: XmlElement, localName?: string): XmlElement[] {
  const out: XmlElement[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === 1 && (!localName || (child as XmlElement).localName === localName)) out.push(child as XmlElement);
  }
  return out;
}

function first(node: XmlElement | undefined, ...path: string[]): XmlElement | undefined {
  let current = node;
  for (const name of path) current = current ? elements(current, name)[0] : undefined;
  return current;
}

function descendants(node: XmlElement, localName: string): XmlElement[] {
  return Array.from(node.getElementsByTagNameNS("*", localName)) as unknown as XmlElement[];
}

/** Relationship targets by id, resolved against the part's folder. */
async function relationships(zip: import("jszip"), part: string): Promise<Map<string, { target: string; external: boolean; type: string }>> {
  const folder = part.slice(0, part.lastIndexOf("/") + 1);
  const relsPath = `${folder}_rels/${part.slice(folder.length)}.rels`;
  const xml = await zip.file(relsPath)?.async("string");
  const map = new Map<string, { target: string; external: boolean; type: string }>();
  if (!xml) return map;
  const { DOMParser } = await import("@xmldom/xmldom");
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  for (const rel of descendants(doc.documentElement as unknown as XmlElement, "Relationship")) {
    const external = rel.getAttribute("TargetMode") === "External";
    const target = rel.getAttribute("Target") ?? "";
    map.set(rel.getAttribute("Id") ?? "", { target: external ? target : resolvePart(folder, target), external, type: rel.getAttribute("Type") ?? "" });
  }
  return map;
}

function resolvePart(folder: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = folder.split("/").filter(Boolean);
  for (const segment of target.split("/")) {
    if (segment === "..") parts.pop();
    else if (segment !== ".") parts.push(segment);
  }
  return parts.join("/");
}

interface Run {
  text: string;
  bold: boolean;
  italic: boolean;
  strike: boolean;
  code: boolean;
  url?: string;
  break?: boolean;
}

/** Consecutive items with the same key. */
function groups<K>(items: Run[], key: (run: Run) => K): { key: K; items: Run[] }[] {
  const out: { key: K; items: Run[] }[] = [];
  for (const item of items) {
    const last = out[out.length - 1];
    if (last && last.key === key(item)) last.items.push(item);
    else out.push({ key: key(item), items: [item] });
  }
  return out;
}

/** Wrap content in strong, emphasis or delete, keeping whitespace at its edges outside, as Markdown needs. */
function wrap(type: "strong" | "emphasis" | "delete", children: PhrasingContent[]): PhrasingContent[] {
  const before = children[0]?.type === "text" ? /^\s*/.exec(children[0].value)![0] : "";
  const lastChild = children[children.length - 1];
  const after = lastChild?.type === "text" ? /\s*$/.exec(lastChild.value)![0] : "";
  const inner = structuredClone(children);
  if (before) (inner[0] as { value: string }).value = (inner[0] as { value: string }).value.slice(before.length);
  if (after) {
    const end = inner[inner.length - 1] as { value: string };
    end.value = end.value.slice(0, end.value.length - after.length);
  }
  const content = inner.filter((node) => node.type !== "text" || node.value);
  if (!content.length) return [{ type: "text", value: before + after }];
  return [...(before ? [{ type: "text" as const, value: before }] : []), { type, children: content }, ...(after ? [{ type: "text" as const, value: after }] : [])];
}

/** Runs of formatted text as Markdown inline content: one link, emphasis or strong per stretch, not per run. */
function phrasing(runs: Run[]): PhrasingContent[] {
  const leaves = (items: Run[]): PhrasingContent[] => groups(items, (run) => (run.break ? "break" : run.code ? "code" : "text")).flatMap(({ key, items: same }): PhrasingContent[] => {
    if (key === "break") return same.map(() => ({ type: "break" }));
    const value = same.map((run) => run.text).join("");
    return [key === "code" ? { type: "inlineCode", value } : { type: "text", value }];
  });
  return groups(runs, (run) => run.url ?? "").flatMap(({ key: url, items }) => {
    const content = groups(items, (run) => run.italic).flatMap(({ key: italic, items: sameItalic }) => {
      const inner = groups(sameItalic, (run) => run.bold).flatMap(({ key: bold, items: sameBold }) => {
        const struck = groups(sameBold, (run) => run.strike).flatMap(({ key: strike, items: same }) => (strike ? wrap("delete", leaves(same)) : leaves(same)));
        return bold ? wrap("strong", struck) : struck;
      });
      return italic ? wrap("emphasis", inner) : inner;
    });
    return url ? [{ type: "link" as const, url, children: content }] : content;
  });
}

/** Whether a text run is set in a monospaced font. */
function monospaced(run: XmlElement): boolean {
  const typeface = first(run, "rPr", "latin")?.getAttribute("typeface") ?? "";
  return /consolas|courier|mono|menlo|monaco|cascadia|source code/i.test(typeface);
}

const MEDIA_MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", svg: "image/svg+xml" };

/**
 * Read a PowerPoint presentation as a document: one section per slide, separated by thematic
 * breaks, with titles as headings, bullets as lists, tables, pictures and speaker notes (as
 * HTML comments, which writing a presentation turns back into notes).
 */
export async function readPptx(data: Uint8Array): Promise<{ document: DocumentModel; slides: number }> {
  const JSZip = (await import("jszip")).default;
  const { DOMParser } = await import("@xmldom/xmldom");
  const zip = await JSZip.loadAsync(data);
  const parse = async (part: string) => {
    const xml = await zip.file(part)?.async("string");
    return xml ? (new DOMParser().parseFromString(xml, "application/xml").documentElement as unknown as XmlElement) : undefined;
  };
  const presentation = await parse("ppt/presentation.xml");
  if (!presentation) throw new Error("Not a PowerPoint presentation: ppt/presentation.xml is missing");
  const presentationRels = await relationships(zip, "ppt/presentation.xml");
  const slideParts = descendants(presentation, "sldId").map((slide) => presentationRels.get(slide.getAttributeNS(NS.r, "id") ?? "")?.target).filter((part): part is string => Boolean(part));
  const children: RootContent[] = [];
  let slideNumber = 0;
  for (const part of slideParts) {
    const slide = await parse(part);
    if (!slide) continue;
    slideNumber += 1;
    const rels = await relationships(zip, part);
    const tree = first(slide, "cSld", "spTree");
    const blocks: RootContent[] = [];
    let title: { text: string; cover: boolean } | undefined;

    const runs = (paragraph: XmlElement): PhrasingContent[] => {
      const out: Run[] = [];
      for (const node of elements(paragraph)) {
        if (node.localName === "br") out.push({ text: "", bold: false, italic: false, strike: false, code: false, break: true });
        if (node.localName !== "r" && node.localName !== "fld") continue;
        const text = elements(node, "t").map((t) => t.textContent ?? "").join("");
        if (!text) continue;
        const props = first(node, "rPr");
        const link = props ? first(props, "hlinkClick")?.getAttributeNS(NS.r, "id") : undefined;
        const target = link ? rels.get(link) : undefined;
        const strike = props?.getAttribute("strike");
        out.push({ text, bold: props?.getAttribute("b") === "1", italic: props?.getAttribute("i") === "1", strike: Boolean(strike && strike !== "noStrike"), code: monospaced(node), url: target?.external ? target.target : undefined });
      }
      return phrasing(out);
    };

    const textBody = (body: XmlElement, bulleted: boolean) => {
      let list: { node: List; level: number }[] = [];
      let code: { type: "code"; value: string } | undefined;
      for (const paragraph of elements(body, "p")) {
        // Paragraphs set wholly in a monospaced font are code, one line each.
        const textRuns = elements(paragraph).filter((node) => node.localName === "r");
        if (textRuns.length && textRuns.every(monospaced)) {
          const line = elements(paragraph).map((node) => (node.localName === "br" ? "\n" : elements(node, "t").map((t) => t.textContent ?? "").join(""))).join("");
          if (code) code.value += `\n${line}`;
          else {
            code = { type: "code", value: line };
            blocks.push(code);
          }
          list = [];
          continue;
        }
        code = undefined;
        const content = runs(paragraph);
        if (!content.length) {
          list = [];
          continue;
        }
        const props = first(paragraph, "pPr");
        const level = Number(props?.getAttribute("lvl") ?? 0);
        const explicit = props ? elements(props).find((child) => ["buChar", "buAutoNum", "buNone", "buBlip"].includes(child.localName ?? "")) : undefined;
        const isBullet = explicit ? explicit.localName !== "buNone" : bulleted;
        if (!isBullet) {
          list = [];
          blocks.push({ type: "paragraph", children: content });
          continue;
        }
        const ordered = explicit?.localName === "buAutoNum";
        while (list.length > level + 1) list.pop();
        let current = list[level];
        if (!current || current.node.ordered !== ordered) {
          const node: List = { type: "list", ordered, spread: false, children: [] };
          const parent = list[level - 1]?.node.children.at(-1);
          if (parent) parent.children.push(node);
          else blocks.push(node);
          current = { node, level };
          list[level] = current;
          list.length = level + 1;
        }
        // Task items: a ballot box as the bullet, or leading the text.
        const head = content[0];
        const leading = head?.type === "text" ? /^([☑☒☐])\s*/.exec(head.value) : null;
        if (head?.type === "text" && leading) {
          head.value = head.value.slice(leading[0].length);
          if (!head.value) content.shift();
        }
        const box = leading?.[1] ?? /^[☑☒☐]$/.exec(explicit?.getAttribute("char") ?? "")?.[0];
        current.node.children.push({ type: "listItem", spread: false, checked: box ? box !== "☐" : undefined, children: [{ type: "paragraph", children: content }] });
      }
    };

    const visit = async (container: XmlElement) => {
      for (const shape of elements(container)) {
        switch (shape.localName) {
          case "sp": {
            const placeholder = first(shape, "nvSpPr", "nvPr", "ph");
            const type = placeholder?.getAttribute("type") ?? (placeholder ? "body" : undefined);
            const body = first(shape, "txBody");
            if (!body) break;
            if ((type === "title" || type === "ctrTitle") && !title) {
              title = { text: elements(body, "p").map((p) => runs(p).map((node) => nodeText(node)).join("")).join(" ").trim(), cover: type === "ctrTitle" };
              break;
            }
            if (type === "sldNum" || type === "dt" || type === "ftr") break;
            textBody(body, type === "body" || type === "obj" || (placeholder !== undefined && !type?.startsWith("sub")));
            break;
          }
          case "graphicFrame": {
            const table = descendants(shape, "tbl")[0];
            if (!table) break;
            const rows = elements(table, "tr").map((row) => ({
              type: "tableRow" as const,
              children: elements(row, "tc").map((cell) => {
                const body = first(cell, "txBody");
                const content = body ? elements(body, "p").map(runs).filter((line) => line.length) : [];
                return { type: "tableCell" as const, children: content.flatMap((line, index): PhrasingContent[] => (index ? [{ type: "break" }, ...line] : line)) };
              }),
            }));
            if (rows.length) blocks.push({ type: "table", children: rows });
            break;
          }
          case "pic": {
            const embed = descendants(shape, "blip")[0]?.getAttributeNS(NS.r, "embed");
            const target = embed ? rels.get(embed) : undefined;
            const alt = first(shape, "nvPicPr", "cNvPr")?.getAttribute("descr") ?? "";
            const media = target && !target.external ? await zip.file(target.target)?.async("base64") : undefined;
            const mime = MEDIA_MIME[target?.target.split(".").pop()?.toLowerCase() ?? ""];
            if (media && mime) blocks.push({ type: "paragraph", children: [{ type: "image", url: `data:${mime};base64,${media}`, alt }] });
            break;
          }
          case "grpSp":
            await visit(shape);
            break;
        }
      }
    };
    if (tree) await visit(tree);

    if (children.length) children.push({ type: "thematicBreak" });
    const heading = title as { text: string; cover: boolean } | undefined;
    if (heading?.text) children.push({ type: "heading", depth: heading.cover || slideNumber === 1 ? 1 : 2, children: [{ type: "text", value: heading.text }] });
    children.push(...blocks);
    const notesPart = [...rels.values()].find((rel) => rel.type.endsWith("/notesSlide"))?.target;
    const notes = notesPart ? await parse(notesPart) : undefined;
    if (notes) {
      const text = descendants(notes, "sp")
        .filter((shape) => first(shape, "nvSpPr", "nvPr", "ph")?.getAttribute("type") === "body")
        .flatMap((shape) => descendants(shape, "p").map((p) => descendants(p, "t").map((t) => t.textContent ?? "").join("")))
        .join("\n")
        .trim();
      if (text) children.push({ type: "html", value: `<!-- ${text.replace(/--/g, "‑‑")} -->` });
    }
  }
  return { document: { kind: "document", meta: await officeProperties(data), tree: { type: "root", children } }, slides: slideNumber };
}
