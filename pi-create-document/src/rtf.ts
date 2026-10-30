import type { FootnoteDefinition, Heading, List, ListItem, PhrasingContent, RootContent, Table, TableRow } from "mdast";
import { toString as nodeText } from "mdast-util-to-string";
import { fit } from "./assets.ts";
import { svgToPng } from "./diagram.ts";
import { documentTitle } from "./html.ts";
import type { DocumentModel, Metadata } from "./model.ts";
import type { PageOptions } from "./pdf.ts";
import { figureImage, isPageBreak, type PreparedDocument } from "./prepare.ts";
import { rasterToPng } from "./raster.ts";

const PAGE_TWIPS = { A4: [11906, 16838], Letter: [12240, 15840], Legal: [12240, 20160], A3: [16838, 23811], A5: [8391, 11906] } as const;
const MARGIN = 1134;

/** Colour table indices. */
const C = { text: 1, accent: 2, muted: 3, rule: 4, codeBg: 5, headerBg: 6, zebra: 7 } as const;

function rgb(hex: string): [number, number, number] {
  const value = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16)) as [number, number, number];
}

function mix(hex: string, amount: number): string {
  return `#${rgb(hex).map((v) => Math.round(v * amount + 255 * (1 - amount)).toString(16).padStart(2, "0")).join("")}`;
}

/** Escape text for RTF: control characters, and non-ASCII as \uN? (signed 16-bit, surrogate pairs for astral planes). */
export function escapeRtf(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    const char = text[i]!;
    if (char === "\\" || char === "{" || char === "}") out += `\\${char}`;
    else if (char === "\t") out += "\\tab ";
    else if (char === "\n") out += "\\line ";
    else if (code < 0x20) continue;
    else if (code < 0x80) out += char;
    else out += `\\u${code > 0x7fff ? code - 0x10000 : code}?`;
  }
  return out;
}

class RtfBuilder {
  private readonly footnotes = new Map<string, FootnoteDefinition>();
  readonly images = new Map<string, { data: Uint8Array; kind: "png" | "jpeg" }>();
  readonly contentWidth: number;
  private readonly prepared: PreparedDocument;

  constructor(prepared: PreparedDocument, pageWidth: number) {
    this.prepared = prepared;
    this.contentWidth = pageWidth - 2 * MARGIN;
    for (const node of prepared.tree.children) if (node.type === "footnoteDefinition") this.footnotes.set(node.identifier, node);
  }

  async loadImages(): Promise<void> {
    for (const [key, asset] of this.prepared.assets) {
      if (asset.svg) this.images.set(key, { data: await svgToPng(asset.svg, { scale: 2, background: "#FFFFFF" }), kind: "png" });
      else if (asset.mime === "image/jpeg") this.images.set(key, { data: asset.data, kind: "jpeg" });
      else if (asset.mime === "image/png") this.images.set(key, { data: asset.data, kind: "png" });
      else this.images.set(key, { data: await rasterToPng(asset.data), kind: "png" });
    }
  }

  inlines(nodes: PhrasingContent[]): string {
    return nodes.map((node): string => {
      switch (node.type) {
        case "text":
          return escapeRtf(node.value.replace(/\s*\n\s*/g, " "));
        case "emphasis":
          return `{\\i ${this.inlines(node.children)}}`;
        case "strong":
          return `{\\b ${this.inlines(node.children)}}`;
        case "delete":
          return `{\\strike ${this.inlines(node.children)}}`;
        case "inlineCode":
          return `{\\f1\\fs19\\chshdng0\\chcbpat${C.codeBg}\\cb${C.codeBg} ${escapeRtf(node.value)}}`;
        case "break":
          return "\\line ";
        case "link":
          if (node.url.startsWith("#")) return this.inlines(node.children);
          return `{\\field{\\*\\fldinst{HYPERLINK "${escapeRtf(node.url).replace(/"/g, "%22")}"}}{\\fldrslt{\\ul\\cf${C.accent} ${this.inlines(node.children)}}}}`;
        case "image":
          return this.picture(node.url, 2400) ?? `{\\i\\cf${C.muted} [${escapeRtf(node.alt || "image")}]}`;
        case "footnoteReference": {
          const definition = this.footnotes.get(node.identifier);
          const text = definition ? definition.children.map((child) => ("children" in child ? this.inlines(child.children as PhrasingContent[]) : "")).join("\\line ") : "";
          return `{\\super\\chftn}{\\footnote\\pard\\plain\\fs18\\cf${C.text} {\\super\\chftn} ${text}}`;
        }
        case "html":
          return "";
        default:
          return "children" in node ? this.inlines(node.children as PhrasingContent[]) : escapeRtf(nodeText(node));
      }
    }).join("");
  }

  private picture(url: string, maxWidth = this.contentWidth): string | undefined {
    const asset = this.prepared.assets.get(url);
    const image = this.images.get(url);
    if (!asset || !image) return undefined;
    const size = fit(asset.width * 15, asset.height * 15, maxWidth, 12_000);
    const hex = Buffer.from(image.data).toString("hex").replace(/(.{128})/g, "$1\n");
    const pixels = image.kind === "png" ? pngPixels(image.data) : { width: asset.width, height: asset.height };
    return `{\\pict\\${image.kind === "png" ? "pngblip" : "jpegblip"}\\picw${pixels.width}\\pich${pixels.height}\\picwgoal${Math.round(size.width)}\\pichgoal${Math.round(size.height)}\n${hex}}`;
  }

  blocks(nodes: RootContent[], indent = 0, quote = false): string {
    return nodes.map((node) => this.block(node, indent, quote)).join("");
  }

  private paragraph(body: string, indent: number, quote: boolean, extra = ""): string {
    const quoteFormat = quote ? `\\brdrl\\brdrs\\brdrw30\\brdrcf${C.rule}\\brsp120\\cf${C.muted}` : "";
    return `{\\pard\\plain\\s0\\sa140\\sl276\\slmult1\\li${indent + (quote ? 360 : 0)}${quoteFormat}${extra}\\f0\\fs22${quote ? `\\cf${C.muted}` : `\\cf${C.text}`} ${body}\\par}\n`;
  }

  private block(node: RootContent, indent: number, quote: boolean): string {
    switch (node.type) {
      case "heading": {
        const sizes = [36, 28, 24, 22, 22, 22];
        const color = node.depth <= 3 ? C.accent : node.depth === 6 ? C.muted : C.text;
        return `{\\pard\\plain\\s${node.depth}\\outlinelevel${node.depth - 1}\\keepn\\sb${node.depth === 1 ? 0 : 240}\\sa120\\li${indent}\\f0\\fs${sizes[node.depth - 1]}\\b\\cf${color} ${this.inlines(node.children)}\\par}\n`;
      }
      case "paragraph": {
        const image = figureImage(node);
        const picture = image ? this.picture(image.url) : undefined;
        if (picture) return `{\\pard\\plain\\qc\\sa140\\li${indent} ${picture}\\par}\n`;
        return this.paragraph(this.inlines(node.children), indent, quote);
      }
      case "list":
        return this.list(node, indent, quote);
      case "code": {
        const border = (side: string) => `\\brdr${side}\\brdrs\\brdrw10\\brdrcf${C.rule}\\brsp80`;
        const body = escapeRtf(node.value.replace(/\t/g, "    ")).replace(/\\tab /g, "    ");
        return `{\\pard\\plain\\sa200\\li${indent + 80}\\ri80${border("t")}${border("b")}${border("l")}${border("r")}\\cbpat${C.codeBg}\\f1\\fs18\\cf${C.text} ${body}\\par}\n`;
      }
      case "blockquote":
        return this.blocks(node.children, indent, true);
      case "table":
        return this.table(node, indent);
      case "thematicBreak":
        return `{\\pard\\plain\\sa240\\li${indent}\\brdrb\\brdrs\\brdrw10\\brdrcf${C.rule}\\brsp20\\fs4 \\par}\n`;
      case "html":
        return isPageBreak(node) ? "{\\pard\\plain\\page\\par}\n" : "";
      case "footnoteDefinition":
      case "definition":
      case "yaml":
        return "";
      default:
        return "children" in node ? this.blocks(node.children as RootContent[], indent, quote) : this.paragraph(escapeRtf(nodeText(node)), indent, quote);
    }
  }

  private list(node: List, indent: number, quote: boolean, level = 0): string {
    const bullets = ["\\u8226?", "\\u9702?", "\\u9642?"];
    let number = node.start ?? 1;
    return node.children.map((item) => {
      const left = indent + 360 * (level + 1) + 360;
      const marker = node.ordered ? `${number++}.` : bullets[level % 3]!;
      const box = item.checked === true ? "\\u9746? " : item.checked === false ? "\\u9744? " : "";
      return item.children.map((child, index) => {
        if (child.type === "list") return this.list(child, indent, quote, level + 1);
        if (index === 0 && child.type === "paragraph") {
          return `{\\pard\\plain\\s0\\sa60\\sl276\\slmult1\\fi-360\\li${left}\\tx${left}${quote ? `\\cf${C.muted}` : `\\cf${C.text}`}\\f0\\fs22 ${marker}\\tab ${box}${this.inlines(child.children)}\\par}\n`;
        }
        return this.block(child, left, quote);
      }).join("");
    }).join("");
  }

  private table(node: Table, indent: number): string {
    const columns = Math.max(...node.children.map((row) => row.children.length));
    const width = this.contentWidth - indent;
    const lengths = Array.from({ length: columns }, (_, column) => Math.min(40, Math.max(4, ...node.children.map((row) => nodeText(row.children[column] ?? { type: "text", value: "" }).length))));
    const total = lengths.reduce((sum, length) => sum + length, 0);
    const size = columns > 8 ? 16 : columns > 5 ? 18 : 20;
    const align = (value: string | null | undefined) => (value === "right" ? "\\qr" : value === "center" ? "\\qc" : "\\ql");
    const rows = node.children.map((row, rowIndex) => {
      let edge = indent;
      const cells = Array.from({ length: columns }, (_, column) => {
        edge += Math.floor((lengths[column]! / total) * width);
        const fill = rowIndex === 0 ? `\\clcbpat${C.headerBg}` : rowIndex % 2 === 0 ? `\\clcbpat${C.zebra}` : "";
        const bottom = rowIndex === 0 ? `\\clbrdrb\\brdrs\\brdrw20\\brdrcf${C.accent}` : `\\clbrdrb\\brdrs\\brdrw10\\brdrcf${C.rule}`;
        return `${bottom}${fill}\\cellx${edge}`;
      }).join("");
      const content = Array.from({ length: columns }, (_, column) => {
        const cell = row.children[column];
        return `\\pard\\plain\\intbl${align(node.align?.[column])}\\f0\\fs${size}\\cf${C.text}${rowIndex === 0 ? "\\b" : ""} ${cell ? this.inlines(cell.children) : ""}\\cell`;
      }).join("");
      return `\\trowd\\trgaph100\\trpaddl100\\trpaddr100\\trpaddt50\\trpaddb50\\trpaddfl3\\trpaddfr3\\trpaddft3\\trpaddfb3\\trleft${indent}${rowIndex === 0 ? "\\trhdr" : ""}\\trkeep${cells}\n${content}\\row\n`;
    });
    return `${rows.join("")}{\\pard\\plain\\sa80\\fs8 \\par}\n`;
  }
}

function pngPixels(data: Uint8Array): { width: number; height: number } {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/**
 * Write Rich Text Format. Microsoft Word, LibreOffice, Pages and WordPad open it as a word
 * processing document; Word maps its headings to the built-in Heading styles.
 */
export async function writeRtf(prepared: PreparedDocument, options: PageOptions = {}): Promise<Uint8Array> {
  const [portraitWidth, portraitHeight] = PAGE_TWIPS[options.pageSize ?? "A4"];
  const landscape = options.orientation === "landscape";
  const [width, height] = landscape ? [portraitHeight, portraitWidth] : [portraitWidth, portraitHeight];
  const builder = new RtfBuilder(prepared, width);
  await builder.loadImages();
  const accent = options.accent ?? "#1F4E79";
  const colors = ["#1F2328", accent, "#59636E", "#D0D7DE", "#F6F8FA", mix(accent, 0.12), "#F9FAFB"];
  const colorTable = `{\\colortbl;${colors.map((hex) => rgb(hex)).map(([r, g, b]) => `\\red${r}\\green${g}\\blue${b};`).join("")}}`;
  const sizes = [36, 28, 24, 22, 22, 22];
  const styles = [
    "{\\s0\\sa140\\sl276\\slmult1\\f0\\fs22 Normal;}",
    ...sizes.map((size, i) => `{\\s${i + 1}\\outlinelevel${i}\\keepn\\sb240\\sa120\\f0\\fs${size}\\b\\sbasedon0\\snext0 heading ${i + 1};}`),
  ].join("");
  const title = documentTitle(prepared);
  const info = [
    title ? `{\\title ${escapeRtf(title)}}` : "",
    prepared.meta.author ? `{\\author ${escapeRtf(prepared.meta.author)}}` : "",
    prepared.meta.subject ? `{\\subject ${escapeRtf(prepared.meta.subject)}}` : "",
    prepared.meta.keywords?.length ? `{\\keywords ${escapeRtf(prepared.meta.keywords.join(", "))}}` : "",
    prepared.meta.description ? `{\\doccomm ${escapeRtf(prepared.meta.description)}}` : "",
  ].join("");
  const footer = options.pageNumbers === false ? "" : `{\\footer\\pard\\plain\\qc\\f0\\fs16\\cf${C.muted} {\\field{\\*\\fldinst PAGE}{\\fldrslt 1}} / {\\field{\\*\\fldinst NUMPAGES}{\\fldrslt 1}}\\par}\n`;
  const rtf = [
    "{\\rtf1\\ansi\\ansicpg1252\\deff0\\uc1\n",
    "{\\fonttbl{\\f0\\fswiss\\fcharset0 Calibri;}{\\f1\\fmodern\\fcharset0 Consolas;}}\n",
    colorTable, "\n",
    `{\\stylesheet${styles}}\n`,
    info ? `{\\info${info}}\n` : "",
    `\\paperw${width}\\paperh${height}\\margl${MARGIN}\\margr${MARGIN}\\margt${MARGIN}\\margb${MARGIN}${landscape ? "\\landscape" : ""}\\fet0\\ftnbj\\ftnrstcont\n`,
    footer,
    builder.blocks(prepared.tree.children),
    "}\n",
  ].join("");
  return new TextEncoder().encode(rtf);
}

const DESTINATIONS = new Set(["fonttbl", "colortbl", "stylesheet", "info", "pict", "header", "headerl", "headerr", "headerf", "footer", "footerl", "footerr", "footerf", "listtable", "listoverridetable", "rsidtbl", "generator", "xmlnstbl", "themedata", "colorschememapping", "latentstyles", "datastore", "fldinst", "object", "nonshppict", "shp", "annotation", "atnid", "atnauthor", "bkmkstart", "bkmkend", "footnote", "revtbl", "pgdsctbl", "filetbl"]);
const SYMBOLS: Record<string, string> = { emdash: "—", endash: "–", lquote: "‘", rquote: "’", ldblquote: "“", rdblquote: "”", bullet: "•", emspace: " ", enspace: " " };

interface ReadParagraph {
  text: string;
  outline?: number;
  inTable: boolean;
  /** Every visible character is in a monospaced font. */
  code?: boolean;
  /** Left indent in twips, which nests list items. */
  indent?: number;
}

/** Decode the text of a simple RTF group such as {\title ...}: escapes and \uN, no nested groups. */
function decodeRtfText(fragment: string): string {
  const decoder = new TextDecoder("windows-1252");
  return fragment
    .replace(/\\u(-?\d+) ?(\\'[0-9a-f]{2}|\?)?/gi, (_, code: string) => String.fromCharCode(Number(code) < 0 ? Number(code) + 0x10000 : Number(code)))
    .replace(/\\'([0-9a-f]{2})/gi, (_, hex: string) => decoder.decode(new Uint8Array([parseInt(hex, 16)])))
    .replace(/\\([\\{}])/g, "$1")
    .replace(/\\[a-z]+-?\d* ?/gi, "")
    .trim();
}

function rtfMetadata(source: string): Metadata {
  const field = (name: string) => {
    const match = new RegExp(`\\{\\\\${name}\\s([^{}]*)\\}`).exec(source);
    return match ? decodeRtfText(match[1]!) || undefined : undefined;
  };
  const keywords = field("keywords");
  return { title: field("title"), author: field("author"), subject: field("subject"), description: field("doccomm"), keywords: keywords ? keywords.split(/[,;]\s*/).filter(Boolean) : undefined };
}

/** Fonts in the font table that are monospaced, by number. */
function monospaceFonts(source: string): Set<number> {
  const table = /\{\\fonttbl([\s\S]*?)\}\s*(\{\\colortbl|\{\\stylesheet|\{\\\*|\\[a-z])/.exec(source)?.[1] ?? "";
  const mono = new Set<number>();
  for (const match of table.matchAll(/\\f(\d+)([^;]*);/g)) {
    if (/\\fmodern|courier|consolas|mono|menlo|monaco/i.test(match[2]!)) mono.add(Number(match[1]));
  }
  return mono;
}

/** Read RTF text: paragraphs, headings (outline levels), tables, code in monospaced fonts and simple lists. Character formatting is not kept. */
export function readRtf(data: Uint8Array): DocumentModel {
  const source = new TextDecoder("latin1").decode(data);
  const decoder = new TextDecoder("windows-1252");
  const mono = monospaceFonts(source);
  const defaultFont = Number(/\\deff(\d+)/.exec(source)?.[1] ?? 0);
  const paragraphs: ReadParagraph[] = [];
  const rows: { cells: string[]; done: boolean }[] = [];
  const stack: { skip: boolean; uc: number; font: number }[] = [];
  let skip = false;
  let uc = 1;
  let font = defaultFont;
  let pendingSkip = 0;
  let text = "";
  let visible = 0;
  let monoVisible = 0;
  let outline: number | undefined;
  let indent = 0;
  let inTable = false;
  let cells: string[] = [];
  const append = (value: string) => {
    text += value;
    const count = value.replace(/\s/g, "").length;
    visible += count;
    if (mono.has(font)) monoVisible += count;
  };
  const endParagraph = () => {
    if (inTable) return;
    paragraphs.push({ text, outline, inTable: false, code: visible > 0 && monoVisible === visible, indent });
    text = "";
    visible = 0;
    monoVisible = 0;
  };
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]!;
    if (char === "{") {
      stack.push({ skip, uc, font });
      if (source.startsWith("{\\*", i)) skip = true;
      continue;
    }
    if (char === "}") {
      const state = stack.pop();
      skip = state?.skip ?? false;
      uc = state?.uc ?? 1;
      font = state?.font ?? defaultFont;
      continue;
    }
    if (char === "\\") {
      const next = source[i + 1];
      if (next === "\\" || next === "{" || next === "}") {
        if (!skip) pendingSkip > 0 ? pendingSkip-- : append(next);
        i += 1;
        continue;
      }
      if (next === "'") {
        const byte = parseInt(source.slice(i + 2, i + 4), 16);
        if (!skip) pendingSkip > 0 ? pendingSkip-- : append(decoder.decode(new Uint8Array([byte])));
        i += 3;
        continue;
      }
      if (next === "~" || next === "_" || next === "-") {
        if (!skip) append(next === "~" ? " " : next === "_" ? "-" : "");
        i += 1;
        continue;
      }
      const match = /^\\([a-zA-Z]+)(-?\d+)? ?/.exec(source.slice(i, i + 40));
      if (!match) continue;
      i += match[0].length - 1;
      const [, word = "", param] = match;
      if (DESTINATIONS.has(word)) {
        skip = true;
        continue;
      }
      if (skip) continue;
      switch (word) {
        case "f":
          font = Number(param ?? defaultFont);
          break;
        case "plain":
          font = defaultFont;
          break;
        case "par":
          endParagraph();
          break;
        case "pard":
          outline = undefined;
          indent = 0;
          inTable = false;
          break;
        case "li":
          indent = Number(param ?? 0);
          break;
        case "intbl":
          inTable = true;
          break;
        case "outlinelevel":
          outline = Number(param ?? 0);
          break;
        case "line":
          text += "\n";
          break;
        case "tab":
          text += "\t";
          break;
        case "page":
          endParagraph();
          break;
        case "cell":
          cells.push(text.trim());
          text = "";
          break;
        case "row":
          rows.push({ cells, done: true });
          paragraphs.push({ text: `\u0000row${rows.length - 1}`, inTable: true });
          cells = [];
          text = "";
          break;
        case "uc":
          uc = Number(param ?? 1);
          break;
        case "u": {
          let code = Number(param ?? 0);
          if (code < 0) code += 0x10000;
          append(String.fromCharCode(code));
          pendingSkip = uc;
          break;
        }
        default:
          if (word in SYMBOLS) append(SYMBOLS[word]!);
      }
      continue;
    }
    if (char === "\r" || char === "\n") continue;
    if (skip) continue;
    if (pendingSkip > 0) {
      pendingSkip -= 1;
      continue;
    }
    append(char);
  }
  if (text.trim()) endParagraph();
  return { kind: "document", meta: rtfMetadata(source), tree: { type: "root", children: toBlocks(paragraphs, rows) } };
}

function toBlocks(paragraphs: ReadParagraph[], rows: { cells: string[] }[]): RootContent[] {
  const blocks: RootContent[] = [];
  let table: Table | undefined;
  // Open lists, outermost first, each with the indent of its items.
  let lists: { list: List; indent: number }[] = [];
  const phrasing = (value: string): PhrasingContent[] => value.split("\n").flatMap((line, index): PhrasingContent[] => (index ? [{ type: "break" }, { type: "text", value: line }] : [{ type: "text", value: line }]));
  for (const paragraph of paragraphs) {
    const rowMatch = /^\u0000row(\d+)$/.exec(paragraph.text);
    if (rowMatch) {
      lists = [];
      const row: TableRow = { type: "tableRow", children: rows[Number(rowMatch[1])]!.cells.map((cell) => ({ type: "tableCell", children: phrasing(cell) })) };
      if (!table) {
        table = { type: "table", children: [] };
        blocks.push(table);
      }
      table.children.push(row);
      continue;
    }
    table = undefined;
    if (paragraph.code) {
      lists = [];
      const value = paragraph.text.replace(/\t/g, "    ").replace(/\s+$/, "");
      const last = blocks[blocks.length - 1];
      if (last?.type === "code") last.value += `\n${value}`;
      else blocks.push({ type: "code", value });
      continue;
    }
    const value = paragraph.text.replace(/[ \t]+$/g, "").trim();
    if (!value) continue;
    if (paragraph.outline !== undefined && paragraph.outline < 6) {
      lists = [];
      blocks.push({ type: "heading", depth: (paragraph.outline + 1) as Heading["depth"], children: phrasing(value) });
      continue;
    }
    const bullet = /^([•◦▪]|\d+[.)])\s+(.*)$/s.exec(value);
    if (bullet) {
      const ordered = /\d/.test(bullet[1]!);
      const box = /^([☐☒☑])\s*(.*)$/s.exec(bullet[2]!);
      const item: ListItem = { type: "listItem", spread: false, checked: box ? box[1] !== "☐" : null, children: [{ type: "paragraph", children: phrasing(box ? box[2]! : bullet[2]!) }] };
      const itemIndent = paragraph.indent ?? 0;
      // Lists indented further than an open list nest in its last item; others close.
      while (lists.length && lists[lists.length - 1]!.indent > itemIndent) lists.pop();
      let open: { list: List; indent: number } | undefined = lists[lists.length - 1];
      if (open && open.indent === itemIndent && open.list.ordered !== ordered) {
        lists.pop();
        open = undefined;
      }
      if (!open || open.indent < itemIndent) {
        const list: List = { type: "list", ordered, spread: false, start: ordered ? Number.parseInt(bullet[1]!, 10) : null, children: [] };
        const parent = lists[lists.length - 1]?.list.children.at(-1);
        if (parent) parent.children.push(list);
        else blocks.push(list);
        open = { list, indent: itemIndent };
        lists.push(open);
      }
      open.list.children.push(item);
      continue;
    }
    lists = [];
    blocks.push({ type: "paragraph", children: phrasing(value) });
  }
  // Pad ragged rows so every table is rectangular.
  for (const block of blocks) {
    if (block.type !== "table") continue;
    const width = Math.max(...block.children.map((row) => row.children.length));
    for (const row of block.children) while (row.children.length < width) row.children.push({ type: "tableCell", children: [] });
  }
  return blocks;
}
