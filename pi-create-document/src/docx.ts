import type { FootnoteDefinition, List, Nodes, PhrasingContent, RootContent, Table as MdTable } from "mdast";
import { toString as nodeText } from "mdast-util-to-string";
import { fit } from "./assets.ts";
import { svgToPng } from "./diagram.ts";
import { documentTitle, parseHtml } from "./html.ts";
import type { DocumentModel, ImageAsset, Metadata } from "./model.ts";
import type { PageOptions } from "./pdf.ts";
import { figureImage, isPageBreak, slugger, type PreparedDocument } from "./prepare.ts";

type Docx = typeof import("docx");
type ParagraphChild = import("docx").ParagraphChild;
type FileChild = import("docx").FileChild;
type Paragraph = import("docx").Paragraph;

const TWIPS_PER_POINT = 20;
const MARGIN = 1134; // 2 cm
const BODY_FONT = "Calibri";
const CODE_FONT = "Consolas";
const TEXT = "1F2328";
const MUTED = "59636E";
const RULE = "D0D7DE";
const CODE_BG = "F6F8FA";

interface RunStyle {
  bold?: boolean;
  italics?: boolean;
  strike?: boolean;
  code?: boolean;
  color?: string;
  link?: boolean;
  /** Half-points. */
  size?: number;
}

/** Word bookmark names: a letter first, then letters, digits and underscores, at most 40 characters. */
function bookmarkName(slug: string): string {
  const name = slug.replace(/[^\p{L}\p{N}_]/gu, "_");
  return (/^\p{L}/u.test(name) ? name : `h_${name}`).slice(0, 40);
}

class DocxBuilder {
  private readonly footnoteIds = new Map<string, number>();
  private readonly definitions = new Map<string, FootnoteDefinition>();
  private readonly slug = slugger();
  private listInstance = 0;
  readonly contentWidthPx: number;
  readonly contentWidthTwips: number;
  readonly images = new Map<string, { data: Uint8Array; type: "png" | "jpg" | "gif" }>();
  private readonly docx: Docx;
  private readonly prepared: PreparedDocument;
  private readonly accent: string;

  constructor(docx: Docx, prepared: PreparedDocument, accent: string, pageWidthTwips: number) {
    this.docx = docx;
    this.prepared = prepared;
    this.accent = accent;
    this.contentWidthTwips = pageWidthTwips - 2 * MARGIN;
    this.contentWidthPx = (this.contentWidthTwips / 1440) * 96;
    for (const node of prepared.tree.children) if (node.type === "footnoteDefinition") this.definitions.set(node.identifier, node);
  }

  /** Rasterise SVG diagrams at twice their size, so they stay sharp when printed. */
  async loadImages(): Promise<void> {
    for (const [key, asset] of this.prepared.assets) {
      if (asset.svg) this.images.set(key, { data: await svgToPng(asset.svg, { scale: 2, background: "#FFFFFF" }), type: "png" });
      else this.images.set(key, { data: asset.data, type: asset.mime === "image/jpeg" ? "jpg" : asset.mime === "image/gif" ? "gif" : "png" });
    }
  }

  private text(value: string, style: RunStyle): ParagraphChild[] {
    const { TextRun, ShadingType } = this.docx;
    return [new TextRun({
      text: value,
      bold: style.bold,
      italics: style.italics,
      strike: style.strike,
      color: style.link ? this.accent : style.color,
      underline: style.link ? {} : undefined,
      size: style.size,
      ...(style.code ? { font: CODE_FONT, size: 19, shading: { type: ShadingType.CLEAR, fill: CODE_BG, color: "auto" } } : {}),
    })];
  }

  inlines(nodes: PhrasingContent[], style: RunStyle = {}): ParagraphChild[] {
    const { TextRun, ExternalHyperlink, InternalHyperlink, FootnoteReferenceRun } = this.docx;
    return nodes.flatMap((node): ParagraphChild[] => {
      switch (node.type) {
        case "text":
          return this.text(node.value.replace(/\s*\n\s*/g, " "), style);
        case "emphasis":
          return this.inlines(node.children, { ...style, italics: true });
        case "strong":
          return this.inlines(node.children, { ...style, bold: true });
        case "delete":
          return this.inlines(node.children, { ...style, strike: true });
        case "inlineCode":
          return this.text(node.value, { ...style, code: true });
        case "break":
          return [new TextRun({ break: 1 })];
        case "link": {
          const children = this.inlines(node.children, { ...style, link: true }) as InstanceType<Docx["TextRun"]>[];
          if (node.url.startsWith("#")) return [new InternalHyperlink({ anchor: bookmarkName(node.url.slice(1)), children })];
          return [new ExternalHyperlink({ link: node.url, children })];
        }
        case "image": {
          const run = this.imageRun(node.url, node.alt ?? "", 160);
          return run ? [run] : this.text(`[${node.alt || "image"}]`, { ...style, italics: true, color: MUTED });
        }
        case "footnoteReference":
          return [new FootnoteReferenceRun(this.footnoteId(node.identifier))];
        case "html":
          return [];
        default:
          return "children" in node ? this.inlines(node.children as PhrasingContent[], style) : this.text(nodeText(node), style);
      }
    });
  }

  private footnoteId(identifier: string): number {
    let id = this.footnoteIds.get(identifier);
    if (id === undefined) {
      id = this.footnoteIds.size + 1;
      this.footnoteIds.set(identifier, id);
    }
    return id;
  }

  private imageRun(url: string, alt: string, maxHeightPx = 760): ParagraphChild | undefined {
    const { ImageRun } = this.docx;
    const asset: ImageAsset | undefined = this.prepared.assets.get(url);
    const image = this.images.get(url);
    if (!asset || !image) return undefined;
    const size = fit(asset.width, asset.height, this.contentWidthPx, maxHeightPx);
    return new ImageRun({
      type: image.type,
      data: image.data,
      transformation: { width: Math.round(size.width), height: Math.round(size.height) },
      altText: { name: alt || "Image", description: alt, title: alt },
    } as ConstructorParameters<Docx["ImageRun"]>[0]);
  }

  blocks(nodes: RootContent[], context: { quote?: boolean; indent?: number } = {}): FileChild[] {
    return nodes.flatMap((node) => this.block(node, context));
  }

  private paragraph(children: ParagraphChild[], context: { quote?: boolean; indent?: number }, options: Record<string, unknown> = {}): Paragraph {
    const { Paragraph, BorderStyle } = this.docx;
    return new Paragraph({
      children,
      ...(context.quote ? { indent: { left: 360 + (context.indent ?? 0) }, border: { left: { style: BorderStyle.SINGLE, size: 18, color: RULE, space: 10 } } } : context.indent ? { indent: { left: context.indent } } : {}),
      ...options,
    });
  }

  private block(node: RootContent, context: { quote?: boolean; indent?: number }): FileChild[] {
    const { Paragraph, HeadingLevel, Bookmark, AlignmentType, BorderStyle, PageBreak, TextRun, ShadingType } = this.docx;
    switch (node.type) {
      case "heading": {
        const levels = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6];
        const id = bookmarkName(this.slug(nodeText(node).trim()));
        return [new Paragraph({ heading: levels[node.depth - 1], children: [new Bookmark({ id, children: this.inlines(node.children) as InstanceType<Docx["TextRun"]>[] })] })];
      }
      case "paragraph": {
        const image = figureImage(node);
        if (image) {
          const run = this.imageRun(image.url, image.alt ?? "");
          if (run) return [this.paragraph([run], context, { alignment: AlignmentType.CENTER, keepLines: true })];
        }
        return [this.paragraph(this.inlines(node.children, context.quote ? { color: MUTED } : {}), context)];
      }
      case "list":
        return this.list(node, 0, context);
      case "code": {
        const lines = node.value.replace(/\t/g, "    ").split("\n");
        const runs = lines.flatMap((line, index) => [...(index ? [new TextRun({ break: 1 })] : []), new TextRun({ text: line, font: CODE_FONT, size: 18, color: TEXT })]);
        const border = { style: BorderStyle.SINGLE, size: 4, color: RULE, space: 4 };
        return [new Paragraph({
          children: runs,
          shading: { type: ShadingType.CLEAR, fill: CODE_BG, color: "auto" },
          border: { top: border, bottom: border, left: border, right: border },
          spacing: { before: 60, after: 200, line: 252 },
          indent: { left: 80 + (context.indent ?? 0), right: 80 },
        })];
      }
      case "blockquote":
        return this.blocks(node.children, { ...context, quote: true });
      case "table":
        return [this.table(node, context), new Paragraph({ children: [], spacing: { after: 80 } })];
      case "thematicBreak":
        return [new Paragraph({ children: [], border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: RULE, space: 1 } }, spacing: { after: 240 } })];
      case "html":
        return isPageBreak(node) ? [new Paragraph({ children: [new PageBreak()] })] : [];
      case "footnoteDefinition":
      case "definition":
      case "yaml":
        return [];
      default:
        return "children" in node ? this.blocks(node.children as RootContent[], context) : [this.paragraph(this.text(nodeText(node), {}), context)];
    }
  }

  private list(node: List, level: number, context: { quote?: boolean; indent?: number }): FileChild[] {
    const out: FileChild[] = [];
    const instance = node.ordered ? ++this.listInstance : undefined;
    for (const item of node.children) {
      let first = true;
      for (const child of item.children) {
        if (child.type === "list") {
          out.push(...this.list(child, Math.min(level + 1, 8), context));
          continue;
        }
        if (first && child.type === "paragraph") {
          const box = item.checked === true ? "☒ " : item.checked === false ? "☐ " : "";
          const numbering = node.ordered ? { reference: "numbers", level, instance } : { reference: "bullets", level };
          out.push(this.paragraph([...(box ? this.text(box, {}) : []), ...this.inlines(child.children)], context, { numbering, spacing: { after: 60 } }));
        } else {
          out.push(...this.blocks([child], { ...context, indent: (context.indent ?? 0) + 720 * (level + 1) }));
        }
        first = false;
      }
    }
    return out;
  }

  private table(node: MdTable, context: { indent?: number }): FileChild {
    const { Table, TableRow, TableCell, Paragraph, WidthType, BorderStyle, ShadingType, AlignmentType, VerticalAlign } = this.docx;
    const columns = Math.max(...node.children.map((row) => row.children.length));
    const width = this.contentWidthTwips - (context.indent ?? 0);
    const lengths = Array.from({ length: columns }, (_, column) => Math.min(40, Math.max(4, ...node.children.map((row) => nodeText(row.children[column] ?? { type: "text", value: "" }).length))));
    const total = lengths.reduce((sum, length) => sum + length, 0);
    const columnWidths = lengths.map((length) => Math.floor((length / total) * width));
    const size = columns > 8 ? 16 : columns > 5 ? 18 : 20;
    const align = (value: string | null | undefined) => (value === "right" ? AlignmentType.RIGHT : value === "center" ? AlignmentType.CENTER : AlignmentType.LEFT);
    const line = { style: BorderStyle.SINGLE, size: 4, color: RULE };
    const none = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
    const rows = node.children.map((row, rowIndex) => new TableRow({
      // Only the header row is marked: some readers treat any tblHeader element, even "off", as a header.
      tableHeader: rowIndex === 0 ? true : undefined,
      cantSplit: true,
      children: Array.from({ length: columns }, (_, column) => {
        const cell = row.children[column];
        const runs = cell ? this.inlines(cell.children, rowIndex === 0 ? { bold: true, size } : { size }) : [];
        return new TableCell({
          width: { size: columnWidths[column]!, type: WidthType.DXA },
          verticalAlign: VerticalAlign.TOP,
          margins: { top: 60, bottom: 60, left: 100, right: 100 },
          shading: rowIndex === 0 ? { type: ShadingType.CLEAR, fill: tintHex(this.accent, 0.12), color: "auto" } : rowIndex % 2 === 0 ? { type: ShadingType.CLEAR, fill: "F9FAFB", color: "auto" } : undefined,
          borders: { top: rowIndex === 0 ? line : none, bottom: rowIndex === 0 ? { style: BorderStyle.SINGLE, size: 8, color: this.accent } : line, left: none, right: none },
          children: [new Paragraph({ alignment: align(node.align?.[column]), spacing: { after: 0 }, children: runs })],
        });
      }),
    }));
    return new Table({ rows, width: { size: width, type: WidthType.DXA }, columnWidths, indent: context.indent ? { size: context.indent, type: WidthType.DXA } : undefined });
  }

  footnotes(): Record<string, { children: Paragraph[] }> {
    const { Paragraph } = this.docx;
    const notes: Record<string, { children: Paragraph[] }> = {};
    for (const [identifier, id] of this.footnoteIds) {
      const definition = this.definitions.get(identifier);
      const paragraphs = (definition?.children ?? []).filter((child) => child.type === "paragraph").map((child) => new Paragraph({ children: this.inlines((child as { children: PhrasingContent[] }).children) }));
      notes[String(id)] = { children: paragraphs.length ? paragraphs : [new Paragraph({ children: [] })] };
    }
    return notes;
  }
}

function tintHex(hex: string, amount: number): string {
  const value = hex.replace("#", "");
  const channel = (i: number) => Math.round(parseInt(value.slice(i, i + 2), 16) * amount + 255 * (1 - amount));
  return [0, 2, 4].map((i) => channel(i).toString(16).padStart(2, "0")).join("").toUpperCase();
}

const PAGE_TWIPS = { A4: [11906, 16838], Letter: [12240, 15840], Legal: [12240, 20160], A3: [16838, 23811], A5: [8391, 11906] } as const;

/** Write a Word document. Headings use Word's built-in Heading styles, so the navigation pane, outline view and Google Docs headings work. */
export async function writeDocx(prepared: PreparedDocument, options: PageOptions = {}): Promise<Uint8Array> {
  const docx = await import("docx");
  const { Document, Packer, Paragraph, TextRun, AlignmentType, LevelFormat, Footer, PageNumber, PageOrientation, TableOfContents } = docx;
  const accent = (options.accent ?? "#1F4E79").replace("#", "").toUpperCase();
  const [portraitWidth, portraitHeight] = PAGE_TWIPS[options.pageSize ?? "A4"];
  const landscape = options.orientation === "landscape";
  const builder = new DocxBuilder(docx, prepared, accent, landscape ? portraitHeight : portraitWidth);
  await builder.loadImages();
  const nodes = prepared.tree.children;
  const lead = nodes[0]?.type === "heading" && nodes[0].depth === 1 ? 1 : 0;
  const children: FileChild[] = builder.blocks(nodes.slice(0, lead));
  if (options.toc) children.push(new TableOfContents("Contents", { hyperlink: true, headingStyleRange: "1-3" }), new Paragraph({ children: [], spacing: { after: 240 } }));
  children.push(...builder.blocks(nodes.slice(lead)));
  const bulletLevels = ["•", "◦", "▪", "•", "◦", "▪", "•", "◦", "▪"].map((text, level) => ({
    level,
    format: LevelFormat.BULLET,
    text,
    alignment: AlignmentType.LEFT,
    style: { paragraph: { indent: { left: 720 * (level + 1) - 360, hanging: 360 } } },
  }));
  const numberFormats = [LevelFormat.DECIMAL, LevelFormat.LOWER_LETTER, LevelFormat.LOWER_ROMAN];
  const numberLevels = Array.from({ length: 9 }, (_, level) => ({
    level,
    format: numberFormats[level % 3]!,
    text: `%${level + 1}.`,
    alignment: AlignmentType.LEFT,
    style: { paragraph: { indent: { left: 720 * (level + 1) - 360, hanging: 360 } } },
  }));
  const heading = (size: number, color = accent, before = 240, after = 120) => ({ run: { font: BODY_FONT, size, bold: true, color }, paragraph: { spacing: { before, after }, keepNext: true, keepLines: true } });
  const title = documentTitle(prepared);
  const meta: Metadata = prepared.meta;
  const document = new Document({
    title,
    creator: meta.author,
    subject: meta.subject,
    description: meta.description,
    keywords: meta.keywords?.join(", "),
    styles: {
      default: {
        document: { run: { font: BODY_FONT, size: 22, color: TEXT }, paragraph: { spacing: { after: 140, line: 276 } } },
        heading1: heading(36, accent, 0, 200),
        heading2: heading(28, accent, 320, 120),
        heading3: heading(24, accent, 240, 100),
        heading4: heading(22, TEXT, 200, 80),
        heading5: heading(22, TEXT, 160, 60),
        heading6: heading(22, MUTED, 160, 60),
        hyperlink: { run: { color: accent, underline: {} } },
      },
    },
    numbering: { config: [{ reference: "bullets", levels: bulletLevels }, { reference: "numbers", levels: numberLevels }] },
    footnotes: builder.footnotes(),
    sections: [{
      properties: {
        page: {
          size: { width: portraitWidth, height: portraitHeight, orientation: landscape ? PageOrientation.LANDSCAPE : PageOrientation.PORTRAIT },
          margin: { top: MARGIN, right: MARGIN, bottom: MARGIN, left: MARGIN },
        },
      },
      footers: options.pageNumbers === false ? undefined : {
        default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ children: [PageNumber.CURRENT, " / ", PageNumber.TOTAL_PAGES], size: 16, color: MUTED })] })] }),
      },
      children,
    }],
  });
  return new Uint8Array(await Packer.toBuffer(document));
}

/** Read a Word document through its HTML rendering: headings, lists, tables, links, images and footnotes survive. */
export async function readDocx(data: Uint8Array): Promise<{ document: DocumentModel; warnings: string[] }> {
  const mammoth = (await import("mammoth")).default;
  const result = await mammoth.convertToHtml({ buffer: Buffer.from(data) }, {
    styleMap: [
      "p[style-name='Title'] => h1:fresh",
      "p[style-name='Subtitle'] => h2:fresh",
      "p[style-name='Quote'] => blockquote:fresh",
      "p[style-name='Intense Quote'] => blockquote:fresh",
      "p[style-name='Source Code'] => pre:separator('\\n')",
      "p[style-name='Code'] => pre:separator('\\n')",
      "r[style-name='Verbatim Char'] => code",
      "p[style-name='TOC Heading'] => !",
      ...Array.from({ length: 9 }, (_, i) => `p[style-name='toc ${i + 1}'] => !`),
    ],
  });
  const document = parseHtml(`<body>${result.value}</body>`);
  document.meta = { ...document.meta, ...(await officeProperties(data)) };
  const warnings = result.messages.filter((message) => message.type === "warning").map((message) => message.message);
  return { document, warnings: warnings.length ? [`Word import: ${warnings.length} formatting feature${warnings.length === 1 ? "" : "s"} could not be represented (${[...new Set(warnings)].slice(0, 3).join("; ")}).`] : [] };
}

/** Title, author, subject, description and keywords from an Office file's docProps/core.xml. */
export async function officeProperties(data: Uint8Array): Promise<Metadata> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(data);
  const xml = await zip.file("docProps/core.xml")?.async("string");
  if (!xml) return {};
  const field = (tag: string) => {
    const value = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(xml)?.[1]?.trim();
    return value ? value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&") : undefined;
  };
  const keywords = field("cp:keywords");
  return {
    ...(field("dc:title") ? { title: field("dc:title") } : {}),
    ...(field("dc:creator") ? { author: field("dc:creator") } : {}),
    ...(field("dc:subject") ? { subject: field("dc:subject") } : {}),
    ...(field("dc:description") ? { description: field("dc:description") } : {}),
    ...(keywords ? { keywords: keywords.split(/[,;]\s*/).filter(Boolean) } : {}),
  };
}

/** Read a binary Word 97-2003 document. Only the text survives; each paragraph becomes one Markdown paragraph. */
export async function readDoc(data: Uint8Array): Promise<DocumentModel> {
  const WordExtractor = (await import("word-extractor")).default;
  const extracted = await new WordExtractor().extract(Buffer.from(data));
  const paragraphs = (text: string) => text.replace(/\r\n?/g, "\n").split("\n").map((line) => line.trim()).filter(Boolean);
  const children: RootContent[] = paragraphs(extracted.getBody()).map((line) => ({ type: "paragraph", children: [{ type: "text", value: line }] }));
  const notes = [...paragraphs(extracted.getFootnotes()), ...paragraphs(extracted.getEndnotes())];
  if (notes.length) {
    children.push({ type: "heading", depth: 2, children: [{ type: "text", value: "Notes" }] });
    children.push(...notes.map((line): RootContent => ({ type: "paragraph", children: [{ type: "text", value: line }] })));
  }
  return { kind: "document", meta: {}, tree: { type: "root", children } };
}
