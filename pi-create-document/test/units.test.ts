import assert from "node:assert/strict";
import { test } from "node:test";
import { numberedPath, resolveSourceFormat } from "../src/convert.ts";
import { DiagramError, flattenSvg, looksLikeMermaid, mermaidType, renderMermaid } from "../src/diagram.ts";
import { formatFromPath, normalizeFormat, sniffFormat } from "../src/formats.ts";
import { detectContentFormat, resolveOutputFormat } from "../src/index.ts";
import { parseMarkdown } from "../src/markdown.ts";
import { cellText, columnLetter, documentToWorkbook, inferCell, sheetName, workbookToDocument } from "../src/model.ts";
import { splitSlides } from "../src/pptx.ts";
import { parsePages } from "../src/raster.ts";
import { readRtf } from "../src/rtf.ts";
import { detectDelimiter, parseDelimited, readDelimited, readJson, writeDelimited, writeJson } from "../src/workbook.ts";

test("format names, aliases and extensions normalise", () => {
  assert.equal(normalizeFormat("markdown"), "md");
  assert.equal(normalizeFormat(".JPG"), "jpeg");
  assert.equal(normalizeFormat("Word"), "docx");
  assert.equal(normalizeFormat("powerpoint"), "pptx");
  assert.equal(normalizeFormat("mmd"), "mermaid");
  assert.equal(normalizeFormat("odt"), undefined);
  assert.equal(formatFromPath("/a/b/Report.PDF"), "pdf");
  assert.equal(formatFromPath("notes"), undefined);
  assert.equal(resolveOutputFormat("out.xlsx"), "xlsx");
  assert.equal(resolveOutputFormat("out.bin", "pdf"), "pdf");
  assert.throws(() => resolveOutputFormat("x.foo"), /Cannot tell the output format from "x.foo"/);
});

test("files are identified by their bytes before their names", () => {
  const bytes = (text: string) => new TextEncoder().encode(text);
  assert.equal(sniffFormat(bytes("%PDF-1.7\n")), "pdf");
  assert.equal(sniffFormat(Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a)), "png");
  assert.equal(sniffFormat(Uint8Array.of(0xff, 0xd8, 0xff, 0xe0)), "jpeg");
  assert.equal(sniffFormat(bytes("\uFEFF{\\rtf1\\ansi hello}")), "rtf");
  assert.equal(sniffFormat(bytes('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>')), "svg");
  assert.equal(sniffFormat(bytes("# Title")), undefined);
  // An XLSX named .docx is still a workbook: the parts decide, not the name.
  const zip = bytes("PK\u0003\u0004....xl/workbook.xml....");
  assert.equal(sniffFormat(zip, "docx"), "xlsx");
  assert.equal(resolveSourceFormat(zip, undefined, "/tmp/misnamed.docx"), "xlsx");
  // Our .doc files are RTF; a .doc that is RTF reads as RTF.
  assert.equal(resolveSourceFormat(bytes("{\\rtf1 x}"), undefined, "/tmp/report.doc"), "rtf");
  assert.throws(() => resolveSourceFormat(bytes("not a pdf"), undefined, "/tmp/x.pdf"), /not a valid PDF/);
  const ole = Uint8Array.of(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0);
  assert.throws(() => resolveSourceFormat(ole, undefined, "/tmp/old.xls"), /Excel 97-2003 files \(\.xls\) cannot be read; save the file as \.xlsx first/);
  assert.equal(resolveSourceFormat(ole, undefined, "/tmp/old.doc"), "doc");
  assert.equal(resolveSourceFormat(bytes("flowchart LR\n  A --> B"), undefined, undefined), "mermaid");
  assert.equal(resolveSourceFormat(bytes("<!doctype html><p>x"), undefined, undefined), "html");
});

test("text content is recognised as Markdown, CSV, HTML, JSON or Mermaid", () => {
  assert.equal(detectContentFormat("# Title\n\nText", "pdf"), "md");
  assert.equal(detectContentFormat("sequenceDiagram\n  A->>B: hi", "png"), "mermaid");
  assert.equal(detectContentFormat("<html><body><p>x</p></body></html>", "pdf"), "html");
  assert.equal(detectContentFormat('[{"a": 1}]', "xlsx"), "json");
  // Quoted delimiters do not change the field count.
  assert.equal(detectContentFormat('name,amount\nWidgets,"1,200.50"\nTotal,=SUM(B2:B2)\n', "xlsx"), "csv");
  assert.equal(detectContentFormat("a\tb\n1\t2\n", "xlsx"), "tsv");
  assert.equal(detectContentFormat("| a | b |\n|---|---|\n| 1 | 2 |\n", "xlsx"), "md");
  assert.equal(detectContentFormat("a,b\n1,2\n", "pdf"), "md", "CSV is only guessed for spreadsheet outputs");
});

test("page selections parse against the page count", () => {
  assert.deepEqual(parsePages(undefined, 3), [1, 2, 3]);
  assert.deepEqual(parsePages("all", 2), [1, 2]);
  assert.deepEqual(parsePages("2-3, 1, 5-", 6), [1, 2, 3, 5, 6]);
  assert.deepEqual(parsePages("-2", 6), [1, 2]);
  assert.deepEqual(parsePages("2-9", 3), [2, 3]);
  assert.throws(() => parsePages("4", 3), /No pages selected: the document has 3 page\(s\)|3 pages/);
  assert.throws(() => parsePages("x", 3), /Invalid page selection "x"/);
  assert.throws(() => parsePages("3-1", 3), /Invalid page range "3-1"/);
});

test("page images are numbered by page, in sorting order", () => {
  assert.equal(numberedPath("/out/report.png", 1, 3), "/out/report-1.png");
  assert.equal(numberedPath("/out/report.png", 3, 12), "/out/report-03.png");
  assert.equal(numberedPath("/out/report.v2.png", 7, 9), "/out/report.v2-7.png");
});

test("cells are typed without changing what they mean", () => {
  assert.equal(inferCell("42"), 42);
  assert.deepEqual(inferCell("1,250,000"), { value: 1250000, format: "#,##0" });
  assert.deepEqual(inferCell("$980,500"), { value: 980500, format: '"$"#,##0' });
  assert.deepEqual(inferCell("12.5%"), { value: 0.125, format: "0.0%" });
  assert.deepEqual(inferCell("-3.2%"), { value: -0.032, format: "0.0%" });
  assert.equal(inferCell("TRUE"), true);
  assert.deepEqual(inferCell("=SUM(A1:A3)"), { formula: "SUM(A1:A3)" });
  assert.equal(inferCell(""), null);
  const date = inferCell("2024-03-01");
  assert.ok(typeof date === "object" && date !== null && !(date instanceof Date) && date.value instanceof Date);
  assert.equal((date as { value: Date }).value.toISOString(), "2024-03-01T00:00:00.000Z");
  // Values that would change meaning as numbers stay text.
  assert.equal(inferCell("00123"), "00123");
  assert.equal(inferCell("+44 20 7946 0958"), "+44 20 7946 0958");
  assert.equal(inferCell("1.2.3"), "1.2.3");
  assert.equal(inferCell("2024-02-30"), "2024-02-30");
  assert.equal(inferCell("12345678901234567890"), "12345678901234567890");
});

test("sheet names follow Excel's rules", () => {
  const taken = new Set<string>();
  assert.equal(sheetName("Q3: Revenue/Costs [draft]?", taken), "Q3 Revenue Costs draft");
  assert.equal(sheetName("q3 revenue costs draft", taken), "q3 revenue costs draft 2");
  assert.equal(sheetName("A".repeat(40), taken).length, 31);
  assert.equal(sheetName("", taken), "Sheet");
  assert.equal(columnLetter(0), "A");
  assert.equal(columnLetter(25), "Z");
  assert.equal(columnLetter(26), "AA");
  assert.equal(columnLetter(701), "ZZ");
});

test("delimited text follows RFC 4180", () => {
  const text = '\uFEFFname,note\r\n"Smith, J","said ""hi""\nthen left"\r\nDoe,\r\n';
  assert.deepEqual(parseDelimited(text, ","), [["name", "note"], ["Smith, J", 'said "hi"\nthen left'], ["Doe", ""]]);
  assert.equal(detectDelimiter("a;b;c\n1;2;3"), ";");
  assert.equal(detectDelimiter("a\tb\n1\t2"), "\t");
  assert.equal(detectDelimiter('a,b\n"x;y",2'), ",");
  const workbook = readDelimited(text);
  const sheet = workbook.sheets[0]!;
  assert.equal(writeDelimited(sheet), 'name,note\r\n"Smith, J","said ""hi""\nthen left"\r\nDoe,\r\n');
});

test("JSON records and workbooks convert both ways", () => {
  const workbook = readJson('[{"name": "Widgets", "amount": 1200.5, "ok": true}, {"name": "Gadgets", "amount": 300}]');
  const sheet = workbook.sheets[0]!;
  assert.deepEqual(sheet.rows[0], ["name", "amount", "ok"]);
  assert.deepEqual(JSON.parse(writeJson(workbook)), [{ name: "Widgets", amount: 1200.5, ok: true }, { name: "Gadgets", amount: 300, ok: null }]);
  const many = readJson('{"First": [[1, 2], [3, 4]], "Second": [{"a": "x"}]}');
  assert.deepEqual(many.sheets.map((s) => s.name), ["First", "Second"]);
  assert.throws(() => readJson("{oops"), /Invalid JSON/);
  assert.throws(() => readJson('"text"'), /JSON must be an array of records or arrays/);
});

test("Markdown tables become sheets named after their headings, and back", () => {
  const document = parseMarkdown("# Report\n\n## Q3: Sales\n\n| Region | Revenue |\n|---|---:|\n| EMEA | $1,250 |\n\n## Costs\n\n| Item | Cost |\n|---|---|\n| Rent | 10 |\n");
  const workbook = documentToWorkbook(document, { inferTypes: true });
  assert.deepEqual(workbook.sheets.map((sheet) => sheet.name), ["Q3 Sales", "Costs"]);
  assert.deepEqual(workbook.sheets[0]!.rows[1]![1], { value: 1250, format: '"$"#,##0' });
  assert.equal(cellText(workbook.sheets[0]!.rows[1]![1]!), "$1,250");
  const back = workbookToDocument(workbook);
  assert.deepEqual(back.tree.children.map((node) => node.type), ["heading", "table", "heading", "table"]);
});

test("slides split at the slide level, with a cover for a single title", () => {
  const { tree } = parseMarkdown("# Deck\n\nIntro\n\n## One\n\nA\n\n### Detail\n\nB\n\n## Two\n\n---\n\nC[^n]\n\n<!-- pagebreak -->\n\nD\n\n[^n]: Note.\n");
  const slides = splitSlides(tree.children);
  assert.deepEqual(slides.map((slide) => [slide.title ?? null, Boolean(slide.cover)]), [["Deck", true], ["One", false], ["Two", false], [null, false], [null, false]]);
  assert.deepEqual(slides[3]!.notes, ["[n] Note."]);
  const flat = splitSlides(parseMarkdown("## A\n\nx\n\n## B\n\ny\n").tree.children);
  assert.deepEqual(flat.map((slide) => slide.title), ["A", "B"]);
});

test("Mermaid diagrams are recognised and unsupported types are named", async () => {
  assert.equal(mermaidType("---\ntitle: x\n---\n%% comment\n%%{init: {}}%%\nflowchart TD\nA-->B"), "flowchart");
  assert.ok(looksLikeMermaid("graph LR\n A-->B"));
  assert.ok(!looksLikeMermaid("# Heading"));
  await assert.rejects(renderMermaid("gantt\n  title x"), (error: unknown) => error instanceof DiagramError && /"gantt" diagrams are not supported/.test(error.message));
  const svg = await renderMermaid("pie title Share\n  \"A\" : 3\n  \"B\" : 1");
  assert.match(svg, /^<svg/);
  // Self-contained: no web fonts, CSS variables or colour mixing left for a renderer to resolve.
  const flow = flattenSvg(await renderMermaid("flowchart LR\n  A[Start] --> B{Choice}"));
  assert.doesNotMatch(flow, /@import|var\(--|color-mix\(/);
});

test("RTF reads headings, tables, nested lists, code and document properties", () => {
  const rtf = [
    "{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Calibri;}{\\f1\\fmodern Consolas;}}",
    "{\\info{\\title Plan \\'e9t\\'e9}{\\author Ops}}",
    "{\\pard\\outlinelevel0 Heading\\par}",
    "{\\pard Caf\\'e9 \\u8364? 5\\par}",
    "{\\pard\\li720 \\u8226?\\tab One\\par}",
    "{\\pard\\li1080 \\u9702?\\tab Inner\\par}",
    "{\\pard\\li720 \\u8226?\\tab Two\\par}",
    "{\\pard\\f1 let x = 1;\\par}{\\pard\\f1 let y = 2;\\par}",
    "\\trowd\\cellx1000\\cellx2000\\pard\\intbl A\\cell B\\cell\\row",
    "\\trowd\\cellx1000\\cellx2000\\pard\\intbl 1\\cell 2\\cell\\row",
    "}",
  ].join("\n");
  const document = readRtf(new TextEncoder().encode(rtf));
  assert.equal(document.meta.title, "Plan été");
  assert.equal(document.meta.author, "Ops");
  const [heading, paragraph, list, code, table] = document.tree.children;
  assert.equal(heading?.type, "heading");
  assert.equal(paragraph?.type === "paragraph" && paragraph.children[0]?.type === "text" ? paragraph.children[0].value : "", "Café € 5");
  assert.equal(list?.type, "list");
  assert.equal(list?.type === "list" ? list.children.length : 0, 2);
  assert.equal(list?.type === "list" ? list.children[0]!.children[1]?.type : "", "list", "the deeper item nests in the first");
  assert.deepEqual(code, { type: "code", value: "let x = 1;\nlet y = 2;" });
  assert.equal(table?.type === "table" ? table.children.length : 0, 2);
});
