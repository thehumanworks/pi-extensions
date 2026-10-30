import type { Heading, PhrasingContent, Root, RootContent, Table, TableCell, TableRow } from "mdast";
import { toString as nodeText } from "mdast-util-to-string";

export interface Metadata {
  title?: string;
  author?: string;
  subject?: string;
  description?: string;
  keywords?: string[];
  /** BCP 47 language tag, e.g. en-GB. */
  language?: string;
}

/** A flowing document: Markdown's syntax tree (mdast, with GFM tables, footnotes and front matter). */
export interface DocumentModel {
  kind: "document";
  meta: Metadata;
  tree: Root;
}

export type Scalar = string | number | boolean | Date | null;

/** A cell: a plain value, or a value with a number format, a formula or a link. */
export type Cell = Scalar | { value?: Scalar; formula?: string; format?: string; hyperlink?: string };

export interface Column {
  /** Width in characters. */
  width?: number;
  /** Excel number format for the column, e.g. "#,##0.00", "0%" or "yyyy-mm-dd". */
  format?: string;
}

export interface Sheet {
  name: string;
  rows: Cell[][];
  /** The first row holds column headings. Default true. */
  header?: boolean;
  columns?: Column[];
}

/** Tabular data: one or more named sheets of cells. */
export interface WorkbookModel {
  kind: "workbook";
  meta: Metadata;
  sheets: Sheet[];
}

export type ImageMime = "image/png" | "image/jpeg" | "image/gif" | "image/svg+xml";

/** A picture: raster bytes or SVG markup, with its natural size in CSS pixels. */
export interface ImageAsset {
  mime: ImageMime;
  data: Uint8Array;
  width: number;
  height: number;
  /** The SVG markup, for image/svg+xml. */
  svg?: string;
}

export interface ImageModel {
  kind: "image";
  meta: Metadata;
  image: ImageAsset;
  /** The diagram's source, when the image was rendered from Mermaid. */
  source?: string;
}

/** An existing PDF, kept as bytes so it can be rasterised directly. */
export interface PdfModel {
  kind: "pdf";
  meta: Metadata;
  data: Uint8Array;
}

export type Model = DocumentModel | WorkbookModel | ImageModel | PdfModel;

export function cellValue(cell: Cell): Scalar {
  if (cell === null || typeof cell !== "object" || cell instanceof Date) return cell;
  return cell.value ?? (cell.formula !== undefined ? `=${cell.formula}` : null);
}

/** How a cell reads in a document table. */
export function cellText(cell: Cell): string {
  const value = cellValue(cell);
  const format = cell !== null && typeof cell === "object" && !(cell instanceof Date) ? cell.format : undefined;
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return formatDate(value, format);
  if (typeof value === "number") return formatNumber(value, format);
  return String(value);
}

function formatDate(date: Date, format?: string): string {
  const iso = date.toISOString();
  if (format && /h/i.test(format)) return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
  return iso.slice(0, 10);
}

function formatNumber(value: number, format?: string): string {
  if (!format) return Number.isInteger(value) ? String(value) : String(Math.round(value * 1e10) / 1e10);
  const decimals = (format.split(".")[1]?.match(/0/g) ?? []).length;
  const percent = format.includes("%");
  const shown = percent ? value * 100 : value;
  let text = shown.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals, useGrouping: format.includes(",") });
  if (percent) text += "%";
  const currency = format.match(/"([^"]+)"|\[\$([^\]-]+)/);
  const symbol = currency?.[1] ?? currency?.[2] ?? format.match(/^([$€£¥])/)?.[1];
  if (symbol) text = text.startsWith("-") ? `-${symbol}${text.slice(1)}` : `${symbol}${text}`;
  return text;
}

const CURRENCY: Record<string, string> = { $: '"$"', "€": '"€"', "£": '"£"', "¥": '"¥"' };

/**
 * Read a typed value from table text, so spreadsheets get numbers, dates and formulas rather
 * than strings. Values that would change meaning stay text: identifiers with leading zeros,
 * phone numbers and version strings.
 */
export function inferCell(raw: string): Cell {
  const text = raw.trim();
  if (text === "") return null;
  if (text.startsWith("=") && text.length > 1) return { formula: text.slice(1) };
  if (/^(true|false)$/i.test(text)) return text.toLowerCase() === "true";
  const number = /^([-+]?)([$€£¥]?)\s?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(%?)$/.exec(text);
  if (number) {
    const [, sign, symbol, whole, fraction = "", percent] = number;
    if (/^0\d/.test(whole!)) return text;
    const value = Number(`${sign}${whole!.replace(/,/g, "")}${fraction}`);
    if (!Number.isFinite(value) || (whole!.replace(/,/g, "").length > 15)) return text;
    const decimals = fraction.length > 0 ? fraction.length - 1 : 0;
    const grouped = whole!.includes(",") || Boolean(symbol);
    const digits = `${grouped ? "#,##0" : "0"}${decimals ? `.${"0".repeat(decimals)}` : ""}`;
    if (percent) return { value: value / 100, format: `${digits}%` };
    if (symbol) return { value, format: `${CURRENCY[symbol]}${digits}` };
    if (grouped || decimals) return { value, format: digits };
    return value;
  }
  const date = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?Z?$/.exec(text);
  if (date) {
    const [, y, m, d, hh, mm, ss] = date;
    const value = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d), Number(hh ?? 0), Number(mm ?? 0), Number(ss ?? 0)));
    if (!Number.isNaN(value.getTime()) && value.getUTCDate() === Number(d)) return { value, format: hh ? "yyyy-mm-dd hh:mm" : "yyyy-mm-dd" };
  }
  return text;
}

/** Excel's sheet-name rules: at most 31 characters, none of : \ / ? * [ ], unique ignoring case. */
export function sheetName(wanted: string, taken: Set<string>): string {
  const base = wanted.replace(/[:\\/?*[\]]/g, " ").replace(/\s+/g, " ").trim().replace(/^'+|'+$/g, "").slice(0, 31) || "Sheet";
  let name = base;
  for (let n = 2; taken.has(name.toLowerCase()); n += 1) name = `${base.slice(0, 31 - String(n).length - 1)} ${n}`;
  taken.add(name.toLowerCase());
  return name;
}

/** A, B, ..., Z, AA, AB, ... */
export function columnLetter(index: number): string {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

function textCell(text: string): TableCell {
  return { type: "tableCell", children: text ? [{ type: "text", value: text }] : [] };
}

/** Each sheet becomes a table, under a heading when there are several sheets. */
export function workbookToDocument(workbook: WorkbookModel): DocumentModel {
  const children: RootContent[] = [];
  if (workbook.meta.title) children.push({ type: "heading", depth: 1, children: [{ type: "text", value: workbook.meta.title }] });
  for (const sheet of workbook.sheets) {
    if (workbook.sheets.length > 1) children.push({ type: "heading", depth: workbook.meta.title ? 2 : 1, children: [{ type: "text", value: sheet.name }] });
    const width = Math.max(1, ...sheet.rows.map((row) => row.length));
    const rows = sheet.header === false ? [Array.from({ length: width }, (_, column): Cell => columnLetter(column)), ...sheet.rows] : sheet.rows;
    if (rows.length === 0) {
      children.push({ type: "paragraph", children: [{ type: "emphasis", children: [{ type: "text", value: "(empty sheet)" }] }] });
      continue;
    }
    const numeric = Array.from({ length: width }, (_, column) => {
      const values = rows.slice(1).map((row) => cellValue(row[column] ?? null)).filter((value) => value !== null && value !== "");
      return values.length > 0 && values.every((value) => typeof value === "number");
    });
    const table: Table = {
      type: "table",
      align: numeric.map((isNumber) => (isNumber ? "right" : null)),
      children: rows.map((row): TableRow => ({ type: "tableRow", children: Array.from({ length: width }, (_, column) => textCell(cellText(row[column] ?? null))) })),
    };
    children.push(table);
  }
  return { kind: "document", meta: workbook.meta, tree: { type: "root", children } };
}

/** Every table becomes a sheet named after the heading above it. */
export function documentToWorkbook(document: DocumentModel, options: { inferTypes?: boolean } = {}): WorkbookModel {
  const sheets: Sheet[] = [];
  const taken = new Set<string>();
  let heading: string | undefined;
  let headingUses = 0;
  const visit = (nodes: RootContent[]) => {
    for (const node of nodes) {
      if (node.type === "heading") {
        heading = nodeText(node as Heading).trim() || undefined;
        headingUses = 0;
      } else if (node.type === "table") {
        const table = node as Table;
        const rows = table.children.map((row) => row.children.map((cell) => {
          const text = phrasingText(cell.children);
          return options.inferTypes === false ? (text === "" ? null : text) : inferCell(text);
        }));
        const label = heading && headingUses === 0 ? heading : heading ? `${heading} ${headingUses + 1}` : `Table ${sheets.length + 1}`;
        headingUses += 1;
        sheets.push({ name: sheetName(label, taken), rows, header: true });
      } else if ("children" in node && Array.isArray(node.children)) {
        visit(node.children as RootContent[]);
      }
    }
  };
  visit(document.tree.children);
  return { kind: "workbook", meta: document.meta, sheets };
}

/** Text of inline content, keeping line breaks. */
export function phrasingText(nodes: PhrasingContent[]): string {
  return nodes.map((node) => (node.type === "break" ? "\n" : nodeText(node))).join("").trim();
}
