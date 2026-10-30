import { createRequire } from "node:module";
import type { FootnoteDefinition, List, Nodes, PhrasingContent, RootContent, Table } from "mdast";
import { toString as nodeText } from "mdast-util-to-string";
import type { Content, CustomTableLayout, TableCell, TDocumentDefinitions } from "pdfmake/interfaces.js";
import { dataUri, fit } from "./assets.ts";
import { bundledFonts, fontRuns, type FontName } from "./fonts.ts";
import type { PageSize } from "./formats.ts";
import { documentTitle } from "./html.ts";
import { figureImage, isPageBreak, slugger, type PreparedDocument } from "./prepare.ts";

export { PAGE_SIZES, type PageSize } from "./formats.ts";

const require = createRequire(import.meta.url);

/** Page dimensions in points (1/72 inch), portrait. */
export const PAGE_POINTS: Record<PageSize, [number, number]> = {
  A4: [595.28, 841.89],
  Letter: [612, 792],
  Legal: [612, 1008],
  A3: [841.89, 1190.55],
  A5: [419.53, 595.28],
};

export interface PageOptions {
  pageSize?: PageSize;
  orientation?: "portrait" | "landscape";
  /** Add a table of contents after the title. */
  toc?: boolean;
  /** Heading and link colour, as hex. */
  accent?: string;
  /** Page numbers in the footer. Default true. */
  pageNumbers?: boolean;
}

export function pageDimensions(options: PageOptions): { width: number; height: number } {
  const [w, h] = PAGE_POINTS[options.pageSize ?? "A4"];
  return options.orientation === "landscape" ? { width: h, height: w } : { width: w, height: h };
}

/** CSS pixels to points. */
const PX = 0.75;
const MARGINS: [number, number, number, number] = [56, 56, 56, 60];
const TEXT = "#1F2328";
const MUTED = "#59636E";
const RULE = "#D0D7DE";
const CODE_BG = "#F6F8FA";

interface Run {
  text: string;
  bold?: boolean;
  italics?: boolean;
  decoration?: "underline" | "lineThrough";
  color?: string;
  link?: string;
  linkToDestination?: string;
  font?: string;
  background?: string;
  fontSize?: number;
  sup?: boolean;
}

type RunStyle = Omit<Run, "text">;

let engine: typeof import("pdfmake") | undefined;

/** The pdfmake singleton with bundled fonts, no network access and file access limited to the fonts. */
function pdfmake(): typeof import("pdfmake") {
  if (engine) return engine;
  const instance = require("pdfmake") as typeof import("pdfmake");
  const fonts = bundledFonts();
  const allowed = new Set(Object.values(fonts).flatMap((files) => Object.values(files)));
  instance.setUrlAccessPolicy(() => false);
  instance.setLocalAccessPolicy((path) => allowed.has(path));
  instance.setFonts({ ...fonts });
  engine = instance;
  return instance;
}

function reportLayout(accent: string): CustomTableLayout {
  return {
    hLineWidth: (i, node) => (i === 0 || i === node.table.body.length ? 0.75 : i === (node.table.headerRows ?? 0) ? 1 : 0.5),
    vLineWidth: () => 0,
    hLineColor: (i, node) => (i === (node.table.headerRows ?? 0) ? accent : RULE),
    fillColor: (row, node) => (row < (node.table.headerRows ?? 0) ? tint(accent, 0.1) : row % 2 === 0 ? "#F9FAFB" : null),
    paddingLeft: () => 6,
    paddingRight: () => 6,
    paddingTop: () => 4,
    paddingBottom: () => 4,
  };
}

/** Mix a hex colour with white. */
export function tint(hex: string, amount: number): string {
  const value = hex.replace("#", "");
  const full = value.length === 3 ? [...value].map((c) => c + c).join("") : value.padEnd(6, "0");
  const channel = (i: number) => Math.round(parseInt(full.slice(i, i + 2), 16) * amount + 255 * (1 - amount));
  return `#${[0, 2, 4].map((i) => channel(i).toString(16).padStart(2, "0")).join("")}`;
}

class PdfBuilder {
  private readonly footnotes = new Map<string, number>();
  private readonly definitions = new Map<string, FootnoteDefinition>();
  private readonly slug = slugger();
  private readonly prepared: PreparedDocument;
  private readonly options: PageOptions;
  private readonly accent: string;
  readonly contentWidth: number;
  readonly contentHeight: number;

  constructor(prepared: PreparedDocument, options: PageOptions, accent: string) {
    this.prepared = prepared;
    this.options = options;
    this.accent = accent;
    const page = pageDimensions(options);
    this.contentWidth = page.width - MARGINS[0] - MARGINS[2];
    this.contentHeight = page.height - MARGINS[1] - MARGINS[3];
    for (const node of prepared.tree.children) if (node.type === "footnoteDefinition") this.definitions.set(node.identifier, node);
  }

  /** Text runs with font fallback applied. */
  private runs(text: string, style: RunStyle): Run[] {
    const base: FontName = style.font === "RobotoMono" ? "RobotoMono" : "Roboto";
    return fontRuns(text, base).map((run) => ({ ...style, text: run.text, ...(run.font !== base || style.font ? { font: run.font } : {}) }));
  }

  inlines(nodes: PhrasingContent[], style: RunStyle = {}): Run[] {
    return nodes.flatMap((node): Run[] => {
      switch (node.type) {
        case "text":
          return this.runs(node.value.replace(/\s*\n\s*/g, " "), style);
        case "emphasis":
          return this.inlines(node.children, { ...style, italics: true });
        case "strong":
          return this.inlines(node.children, { ...style, bold: true });
        case "delete":
          return this.inlines(node.children, { ...style, decoration: "lineThrough" });
        case "inlineCode":
          return this.runs(node.value, { ...style, font: "RobotoMono", fontSize: 9, background: CODE_BG });
        case "break":
          return [{ ...style, text: "\n" }];
        case "link": {
          const target = node.url.startsWith("#") ? { linkToDestination: node.url.slice(1) } : { link: node.url };
          return this.inlines(node.children, { ...style, ...target, color: this.accent, decoration: "underline" });
        }
        case "image":
          return node.alt ? this.runs(`[${node.alt}]`, { ...style, italics: true, color: MUTED }) : [];
        case "footnoteReference": {
          const number = this.footnoteNumber(node.identifier);
          return [{ ...style, text: String(number), sup: true, color: this.accent, linkToDestination: `footnote-${number}` }];
        }
        case "html":
          return [];
        default:
          return "children" in node ? this.inlines(node.children as PhrasingContent[], style) : this.runs(nodeText(node), style);
      }
    });
  }

  private footnoteNumber(identifier: string): number {
    let number = this.footnotes.get(identifier);
    if (number === undefined) {
      number = this.footnotes.size + 1;
      this.footnotes.set(identifier, number);
    }
    return number;
  }

  private image(url: string, alt: string, maxWidth = this.contentWidth, maxHeight = this.contentHeight * 0.8): Content {
    const asset = this.prepared.assets.get(url);
    if (!asset) return { text: alt ? `[${alt}]` : "[image]", italics: true, color: MUTED, margin: [0, 0, 0, 8] };
    const size = fit(asset.width * PX, asset.height * PX, maxWidth, maxHeight);
    if (asset.svg) return { svg: asset.svg, width: size.width, height: size.height, alignment: "center", margin: [0, 4, 0, 10] };
    if (asset.mime === "image/gif") return { text: `[${alt || "GIF image"}: GIF is not supported in PDF]`, italics: true, color: MUTED };
    return { image: dataUri(asset), width: size.width, height: size.height, alignment: "center", margin: [0, 4, 0, 10] };
  }

  blocks(nodes: RootContent[], width = this.contentWidth): Content[] {
    const out: Content[] = [];
    for (const node of nodes) {
      const block = this.block(node, width);
      if (block) out.push(block);
    }
    return out;
  }

  block(node: RootContent, width = this.contentWidth): Content | undefined {
    switch (node.type) {
      case "heading": {
        const id = this.slug(nodeText(node).trim());
        return {
          text: this.inlines(node.children),
          style: `h${node.depth}`,
          headlineLevel: node.depth,
          id,
          ...(this.options.toc && node.depth <= 3 ? { tocItem: true, tocStyle: { fontSize: node.depth === 1 ? 11 : 10, bold: node.depth === 1 }, tocMargin: [(node.depth - 1) * 14, node.depth === 1 ? 6 : 2, 0, 0] } : {}),
        } as Content;
      }
      case "paragraph": {
        const image = figureImage(node);
        if (image) return this.image(image.url, image.alt ?? "", width);
        return { text: this.inlines(node.children), style: "p" };
      }
      case "list":
        return this.list(node, width);
      case "code":
        return {
          table: { widths: ["*"], body: [[{ text: this.runs(node.value.replace(/\t/g, "    "), { font: "RobotoMono" }), fontSize: 8.5, lineHeight: 1.25, preserveLeadingSpaces: true, color: TEXT }]] },
          layout: { hLineWidth: () => 0, vLineWidth: () => 0, fillColor: () => CODE_BG, paddingLeft: () => 10, paddingRight: () => 10, paddingTop: () => 8, paddingBottom: () => 8 },
          margin: [0, 2, 0, 10],
        };
      case "blockquote":
        return {
          table: { widths: ["*"], body: [[{ stack: this.blocks(node.children, width - 20), color: MUTED }]] },
          layout: { hLineWidth: () => 0, vLineWidth: (i) => (i === 0 ? 3 : 0), vLineColor: () => RULE, paddingLeft: () => 12, paddingRight: () => 4, paddingTop: () => 2, paddingBottom: () => 0 },
          margin: [0, 2, 0, 8],
        };
      case "table":
        return this.table(node, width);
      case "thematicBreak":
        return { canvas: [{ type: "line", x1: 0, y1: 0, x2: width, y2: 0, lineWidth: 0.75, lineColor: RULE }], margin: [0, 6, 0, 14] };
      case "html":
        return isPageBreak(node) ? { text: "", pageBreak: "after" } : undefined;
      case "footnoteDefinition":
      case "definition":
      case "yaml":
        return undefined;
      default:
        return "children" in node ? { stack: this.blocks(node.children as RootContent[], width) } : { text: this.runs(nodeText(node), {}), style: "p" };
    }
  }

  private list(node: List, width: number): Content {
    const items = node.children.map((item): Content => {
      const children = this.blocks(item.children, width - 18);
      const first = children[0];
      if (item.checked !== null && item.checked !== undefined) {
        const box = this.runs(item.checked ? "☑ " : "☐ ", { color: MUTED });
        const firstText = first && typeof first === "object" && "text" in first ? (first.text as Run[]) : [];
        return { stack: [{ text: [...box, ...firstText], style: "li" }, ...children.slice(1)], listType: "none" } as Content;
      }
      // Tight list items: drop paragraph spacing so bullets sit close together.
      return children.length === 1 && first && typeof first === "object" && "text" in first ? ({ ...first, style: "li" } as Content) : { stack: children };
    });
    if (node.ordered) return { ol: items, start: node.start ?? 1, margin: [0, 0, 0, 8], markerColor: MUTED } as Content;
    return { ul: items, margin: [0, 0, 0, 8], markerColor: MUTED } as Content;
  }

  private table(node: Table, width: number): Content {
    const rows = node.children;
    const columns = Math.max(...rows.map((row) => row.children.length));
    const fontSize = columns > 8 ? 7 : columns > 5 ? 8 : 9.5;
    // Narrow tables size to their content; wide ones share the page by content length, so long
    // text columns get more room without starving short ones.
    const lengths = Array.from({ length: columns }, (_, column) => Math.max(3, ...rows.map((row) => nodeText(row.children[column] ?? { type: "text", value: "" }).length)));
    const available = width - columns * 12;
    const natural = lengths.reduce((sum, length) => sum + length * fontSize * 0.55, 0);
    const weights = lengths.map((length) => Math.min(40, length));
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    const widths = natural <= available ? weights.map(() => "auto" as const) : weights.map((weight) => Math.max(28, (weight / total) * available));
    const body: TableCell[][] = rows.map((row, rowIndex) => Array.from({ length: columns }, (_, column): TableCell => {
      const cell = row.children[column];
      return {
        text: cell ? this.inlines(cell.children, rowIndex === 0 ? { bold: true } : {}) : "",
        alignment: node.align?.[column] ?? "left",
        fontSize,
        color: rowIndex === 0 ? TEXT : undefined,
      } as TableCell;
    }));
    return { table: { headerRows: 1, dontBreakRows: true, widths, body }, layout: "report", margin: [0, 2, 0, 12] };
  }

  notes(): Content[] {
    if (this.footnotes.size === 0) return [];
    const entries = [...this.footnotes.entries()].sort((a, b) => a[1] - b[1]);
    return [
      { canvas: [{ type: "line", x1: 0, y1: 0, x2: 120, y2: 0, lineWidth: 0.75, lineColor: RULE }], margin: [0, 16, 0, 6] },
      ...entries.map(([identifier, number]): Content => {
        const definition = this.definitions.get(identifier);
        const blocks = definition ? this.blocks(definition.children) : [];
        const first = blocks[0] && typeof blocks[0] === "object" && "text" in blocks[0] ? (blocks[0].text as Run[]) : [];
        return { text: [{ text: `${number}. `, bold: true }, ...first], fontSize: 8.5, color: MUTED, id: `footnote-${number}`, margin: [0, 0, 0, 3] } as Content;
      }),
    ];
  }
}

/** Render a prepared document to PDF. Diagrams stay vector; text uses the bundled fonts. */
export async function writePdf(prepared: PreparedDocument, options: PageOptions = {}): Promise<Uint8Array> {
  const accent = options.accent ?? "#1F4E79";
  const engine = pdfmake();
  engine.addTableLayouts({ report: reportLayout(accent) });
  const builder = new PdfBuilder(prepared, options, accent);
  const nodes = prepared.tree.children;
  const lead = nodes[0]?.type === "heading" && nodes[0].depth === 1 ? 1 : 0;
  const content: Content[] = builder.blocks(nodes.slice(0, lead));
  if (options.toc) {
    content.push({ toc: { title: { text: "Contents", style: "tocTitle" } }, margin: [0, 0, 0, 12] } as Content);
    content.push({ canvas: [{ type: "line", x1: 0, y1: 0, x2: builder.contentWidth, y2: 0, lineWidth: 0.75, lineColor: RULE }], margin: [0, 0, 0, 14] });
  }
  content.push(...builder.blocks(nodes.slice(lead)), ...builder.notes());

  const title = documentTitle(prepared);
  const definition: TDocumentDefinitions = {
    content,
    pageSize: pageDimensions(options),
    pageMargins: MARGINS,
    info: {
      title,
      author: prepared.meta.author,
      subject: prepared.meta.subject ?? prepared.meta.description,
      keywords: prepared.meta.keywords?.join(", "),
      creator: "pi-create-document",
    },
    language: prepared.meta.language,
    defaultStyle: { font: "Roboto", fontSize: 10.5, lineHeight: 1.3, color: TEXT },
    styles: {
      h1: { fontSize: 22, bold: true, color: accent, margin: [0, 0, 0, 10] },
      h2: { fontSize: 16, bold: true, color: accent, margin: [0, 14, 0, 6] },
      h3: { fontSize: 13, bold: true, color: accent, margin: [0, 10, 0, 4] },
      h4: { fontSize: 11.5, bold: true, color: TEXT, margin: [0, 8, 0, 3] },
      h5: { fontSize: 10.5, bold: true, color: TEXT, margin: [0, 6, 0, 2] },
      h6: { fontSize: 10.5, bold: true, color: MUTED, margin: [0, 6, 0, 2] },
      p: { margin: [0, 0, 0, 8] },
      li: { margin: [0, 0, 0, 3] },
      tocTitle: { fontSize: 14, bold: true, color: accent, margin: [0, 6, 0, 8] },
    },
    footer: options.pageNumbers === false ? undefined : (page: number, pages: number) => (pages > 1 ? { text: `${page} / ${pages}`, alignment: "center", fontSize: 8, color: MUTED, margin: [0, 24, 0, 0] } : null),
    // Keep a heading with the content that follows it.
    pageBreakBefore: (node, queries) => Boolean(node.headlineLevel) && queries.getFollowingNodesOnPage().length === 0,
  };
  const buffer = await engine.createPdf(definition).getBuffer();
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}
