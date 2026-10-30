import { cellText, cellValue, columnLetter, inferCell, sheetName, type Cell, type Scalar, type Sheet, type WorkbookModel } from "./model.ts";

export class WorkbookError extends Error {}

/** The delimiter that splits the first lines most consistently: comma, semicolon, tab or pipe. */
export function detectDelimiter(text: string): string {
  const lines = text.split(/\r?\n/).filter((line) => line.trim()).slice(0, 20);
  let best = ",";
  let bestScore = 0;
  for (const delimiter of [",", ";", "\t", "|"]) {
    const counts = lines.map((line) => splitRecord(line, delimiter).length - 1);
    if (counts.length === 0 || counts[0] === 0) continue;
    const consistent = counts.filter((count) => count === counts[0]).length / counts.length;
    const score = consistent * counts[0]!;
    if (score > bestScore) {
      best = delimiter;
      bestScore = score;
    }
  }
  return best;
}

function splitRecord(line: string, delimiter: string): string[] {
  return parseDelimited(line, delimiter)[0] ?? [];
}

/** RFC 4180 parsing: quoted fields may contain delimiters, doubled quotes and line breaks. */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let wasQuoted = false;
  const source = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]!;
    if (quoted) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += char;
      continue;
    }
    if (char === '"' && field.trim() === "" && !wasQuoted) {
      quoted = true;
      wasQuoted = true;
      field = "";
    } else if (char === delimiter) {
      row.push(wasQuoted ? field : field.trim());
      field = "";
      wasQuoted = false;
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[i + 1] === "\n") i += 1;
      row.push(wasQuoted ? field : field.trim());
      rows.push(row);
      row = [];
      field = "";
      wasQuoted = false;
    } else if (!wasQuoted) field += char;
  }
  if (field !== "" || wasQuoted || row.length) {
    row.push(wasQuoted ? field : field.trim());
    rows.push(row);
  }
  return rows.filter((record) => !(record.length === 1 && record[0] === ""));
}

/** Read CSV or TSV. Numbers, percentages, currency, booleans, ISO dates and =formulas become typed cells unless inferTypes is false. */
export function readDelimited(text: string, options: { delimiter?: string; name?: string; inferTypes?: boolean } = {}): WorkbookModel {
  const delimiter = options.delimiter ?? detectDelimiter(text);
  const rows = parseDelimited(text, delimiter);
  const width = Math.max(0, ...rows.map((row) => row.length));
  const cells = rows.map((row) => Array.from({ length: width }, (_, column): Cell => {
    const raw = row[column] ?? "";
    if (options.inferTypes === false) return raw === "" ? null : raw;
    return inferCell(raw);
  }));
  // A header is assumed unless the first row looks like data: numbers where text would be.
  const header = !(cells[0] ?? []).some((cell) => typeof cellValue(cell) === "number");
  return { kind: "workbook", meta: {}, sheets: [{ name: sheetName(options.name ?? "Sheet1", new Set()), rows: cells, header }] };
}

function quote(value: string, delimiter: string): string {
  return /["\r\n]/.test(value) || value.includes(delimiter) || /^\s|\s$/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * Write one sheet as CSV or TSV, showing values as a spreadsheet displays them: formatted numbers,
 * ISO dates, and formula results (or the formula when no result is known).
 */
export function writeDelimited(sheet: Sheet, delimiter = ","): string {
  const lines = sheet.rows.map((row) => row.map((cell) => quote(cellText(cell), delimiter)).join(delimiter));
  return `${lines.join("\r\n")}\r\n`;
}

function jsonValue(cell: Cell): unknown {
  const value = cellValue(cell);
  return value instanceof Date ? value.toISOString().replace("T00:00:00.000Z", "") : value;
}

/** Each sheet as records keyed by its header row (or as arrays when it has none); several sheets become an object keyed by name. */
export function writeJson(workbook: WorkbookModel): string {
  const sheets = workbook.sheets.map((sheet) => {
    if (sheet.header === false || sheet.rows.length === 0) return sheet.rows.map((row) => row.map(jsonValue));
    const keys = (sheet.rows[0] ?? []).map((cell, index) => cellText(cell) || columnLetter(index));
    return sheet.rows.slice(1).map((row) => Object.fromEntries(keys.map((key, index) => [key, jsonValue(row[index] ?? null)])));
  });
  const data = workbook.sheets.length === 1 ? sheets[0] : Object.fromEntries(workbook.sheets.map((sheet, index) => [sheet.name, sheets[index]]));
  return `${JSON.stringify(data, null, 2)}\n`;
}

function scalar(value: unknown): Cell {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  return JSON.stringify(value);
}

function recordsToSheet(name: string, records: unknown[], taken: Set<string>): Sheet {
  if (records.every((record) => Array.isArray(record))) {
    return { name: sheetName(name, taken), rows: (records as unknown[][]).map((row) => row.map(scalar)), header: false };
  }
  const keys: string[] = [];
  for (const record of records) {
    if (record && typeof record === "object" && !Array.isArray(record)) for (const key of Object.keys(record)) if (!keys.includes(key)) keys.push(key);
  }
  if (keys.length === 0) return { name: sheetName(name, taken), rows: records.map((value) => [scalar(value)]), header: false };
  const rows: Cell[][] = [keys, ...records.map((record) => keys.map((key) => (record && typeof record === "object" ? scalar((record as Record<string, unknown>)[key]) : null)))];
  return { name: sheetName(name, taken), rows, header: true };
}

/** Read JSON: an array of records or arrays is one sheet; an object whose values are such arrays is one sheet per key. */
export function readJson(text: string, name = "Sheet1"): WorkbookModel {
  let data: unknown;
  try {
    data = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new WorkbookError(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const taken = new Set<string>();
  if (Array.isArray(data)) return { kind: "workbook", meta: {}, sheets: [recordsToSheet(name, data, taken)] };
  if (data && typeof data === "object") {
    const entries = Object.entries(data as Record<string, unknown>);
    if (entries.length > 0 && entries.every(([, value]) => Array.isArray(value))) {
      return { kind: "workbook", meta: {}, sheets: entries.map(([key, value]) => recordsToSheet(key, value as unknown[], taken)) };
    }
    return { kind: "workbook", meta: {}, sheets: [recordsToSheet(name, [data], taken)] };
  }
  throw new WorkbookError("JSON must be an array of records or arrays, or an object of such arrays");
}

type ExcelJS = typeof import("exceljs");

async function excel(): Promise<ExcelJS> {
  const loaded = (await import("exceljs")) as unknown as ExcelJS & { default?: ExcelJS };
  return loaded.default ?? loaded;
}

/** Column width in characters that fits the longest displayed value, within 8-60. */
function columnWidth(sheet: Sheet, column: number): number {
  const longest = Math.max(0, ...sheet.rows.map((row) => Math.max(...cellText(row[column] ?? null).split("\n").map((line) => line.length))));
  return Math.min(60, Math.max(8, longest + 2));
}

/** Excel's 31-bit integers aside, numbers keep full precision; strings are capped at the cell limit. */
function excelValue(cell: Cell): unknown {
  if (cell === null || typeof cell !== "object" || cell instanceof Date) return typeof cell === "string" ? cell.slice(0, 32_767) : cell;
  if (cell.formula !== undefined) return { formula: cell.formula.replace(/^=/, ""), result: cell.value ?? undefined };
  if (cell.hyperlink) return { text: String(cell.value ?? cell.hyperlink), hyperlink: cell.hyperlink };
  return cell.value ?? null;
}

/** Write an Excel workbook: bold, filled, frozen header row with filters; widths fitted to content; numbers, dates and formulas kept typed. */
export async function writeXlsx(workbook: WorkbookModel, options: { accent?: string } = {}): Promise<Uint8Array> {
  const ExcelJS = await excel();
  const book = new ExcelJS.Workbook();
  if (workbook.meta.author) book.creator = workbook.meta.author;
  if (workbook.meta.title) book.title = workbook.meta.title;
  if (workbook.meta.subject) book.subject = workbook.meta.subject;
  if (workbook.meta.description) book.description = workbook.meta.description;
  if (workbook.meta.keywords?.length) book.keywords = workbook.meta.keywords.join(", ");
  book.created = new Date();
  const accent = `FF${(options.accent ?? "#1F4E79").replace("#", "").toUpperCase()}`;
  const sheets = workbook.sheets.length ? workbook.sheets : [{ name: "Sheet1", rows: [], header: false }];
  for (const sheet of sheets) {
    const header = sheet.header !== false && sheet.rows.length > 1;
    const ws = book.addWorksheet(sheet.name, header ? { views: [{ state: "frozen", ySplit: 1 }] } : {});
    const width = Math.max(0, ...sheet.rows.map((row) => row.length));
    sheet.rows.forEach((row, rowIndex) => {
      const excelRow = ws.getRow(rowIndex + 1);
      row.forEach((cell, column) => {
        const target = excelRow.getCell(column + 1);
        target.value = excelValue(cell) as never;
        const format = cell !== null && typeof cell === "object" && !(cell instanceof Date) ? cell.format : undefined;
        const columnFormat = sheet.columns?.[column]?.format;
        if (format ?? columnFormat) target.numFmt = (format ?? columnFormat)!;
        else if (cellValue(cell) instanceof Date) target.numFmt = "yyyy-mm-dd";
        if (typeof cellValue(cell) === "string" && String(cellValue(cell)).includes("\n")) target.alignment = { wrapText: true, vertical: "top" };
        if (cell !== null && typeof cell === "object" && !(cell instanceof Date) && cell.hyperlink) target.font = { color: { argb: accent }, underline: true };
      });
    });
    for (let column = 0; column < width; column += 1) ws.getColumn(column + 1).width = sheet.columns?.[column]?.width ?? columnWidth(sheet, column);
    if (header) {
      const row = ws.getRow(1);
      for (let column = 1; column <= width; column += 1) {
        const cell = row.getCell(column);
        cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: accent } };
        cell.alignment = { vertical: "middle", wrapText: true };
        cell.border = { bottom: { style: "thin", color: { argb: accent } } };
      }
      ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: Math.max(1, width) } };
    }
  }
  const buffer = await book.xlsx.writeBuffer();
  return new Uint8Array(buffer as ArrayBuffer);
}

/** Read an Excel workbook: every visible sheet, with values, number formats, formulas (with cached results) and hyperlinks. */
export async function readXlsx(data: Uint8Array): Promise<{ workbook: WorkbookModel; warnings: string[] }> {
  const ExcelJS = await excel();
  const book = new ExcelJS.Workbook();
  try {
    await book.xlsx.load(Buffer.from(data) as never);
  } catch (error) {
    throw new WorkbookError(`Could not read the workbook: ${error instanceof Error ? error.message : String(error)}`);
  }
  const warnings: string[] = [];
  const sheets: Sheet[] = [];
  const taken = new Set<string>();
  for (const ws of book.worksheets) {
    if (ws.state && ws.state !== "visible") {
      warnings.push(`Hidden sheet "${ws.name}" skipped.`);
      continue;
    }
    const rows: Cell[][] = [];
    const width = ws.actualColumnCount ? ws.columnCount : 0;
    ws.eachRow({ includeEmpty: true }, (row, rowNumber) => {
      const cells: Cell[] = [];
      for (let column = 1; column <= width; column += 1) cells.push(readCell(row.getCell(column)));
      rows[rowNumber - 1] = cells;
    });
    for (let index = 0; index < rows.length; index += 1) rows[index] ??= Array<Cell>(width).fill(null);
    // Trim trailing empty rows and columns.
    while (rows.length && rows[rows.length - 1]!.every((cell) => cellValue(cell) === null || cellValue(cell) === "")) rows.pop();
    let used = 0;
    for (const row of rows) row.forEach((cell, column) => {
      if (cellValue(cell) !== null && cellValue(cell) !== "") used = Math.max(used, column + 1);
    });
    const header = rows.length > 1 && rows[0]!.slice(0, used).every((cell) => typeof cellValue(cell) === "string" && cellValue(cell) !== "");
    sheets.push({ name: sheetName(ws.name, taken), rows: rows.map((row) => row.slice(0, used)), header });
  }
  const meta = { title: book.title || undefined, author: book.creator || undefined, subject: book.subject || undefined, description: book.description || undefined, keywords: book.keywords ? book.keywords.split(/[,;]\s*/) : undefined };
  return { workbook: { kind: "workbook", meta, sheets }, warnings };
}

function readCell(cell: import("exceljs").Cell): Cell {
  const value = cell.value as unknown;
  const format = cell.numFmt && cell.numFmt !== "General" ? cell.numFmt : undefined;
  const withFormat = (scalarValue: Scalar): Cell => (format && (typeof scalarValue === "number" || scalarValue instanceof Date) ? { value: scalarValue, format } : scalarValue);
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || value instanceof Date) return withFormat(value);
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if ("formula" in record || "sharedFormula" in record) {
      const result = record.result;
      const resultValue: Scalar = result === undefined || result === null ? null : result instanceof Date || typeof result === "number" || typeof result === "string" || typeof result === "boolean" ? result : typeof result === "object" && result && "error" in result ? String((result as { error: unknown }).error) : null;
      const formula = typeof record.formula === "string" ? record.formula : cell.formula;
      return { formula, value: resultValue, ...(format ? { format } : {}) };
    }
    if (Array.isArray(record.richText)) return (record.richText as { text: string }[]).map((part) => part.text).join("");
    if (typeof record.hyperlink === "string") return { value: typeof record.text === "string" ? record.text : String(record.text ?? record.hyperlink), hyperlink: record.hyperlink };
    if ("error" in record) return String(record.error);
  }
  return String(value);
}

/** The single sheet a CSV, TSV or similar file can hold, with a clear error when there are several. */
export function onlySheet(workbook: WorkbookModel, format: string, sheet?: string): { sheet: Sheet; warnings: string[] } {
  if (workbook.sheets.length === 0) throw new WorkbookError(`Nothing to write: no tables were found for ${format.toUpperCase()}`);
  if (sheet) {
    const found = workbook.sheets.find((candidate) => candidate.name.toLowerCase() === sheet.toLowerCase());
    if (!found) throw new WorkbookError(`No sheet named "${sheet}"; sheets: ${workbook.sheets.map((candidate) => candidate.name).join(", ")}`);
    return { sheet: found, warnings: [] };
  }
  const warnings = workbook.sheets.length > 1 ? [`${format.toUpperCase()} holds one table: wrote "${workbook.sheets[0]!.name}" and skipped ${workbook.sheets.slice(1).map((candidate) => `"${candidate.name}"`).join(", ")}. Pass sheet to choose another, or write XLSX or JSON to keep all of them.`] : [];
  return { sheet: workbook.sheets[0]!, warnings };
}
