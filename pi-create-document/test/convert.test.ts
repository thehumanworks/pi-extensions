import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { svgToPng } from "../src/diagram.ts";
import { sniffFormat } from "../src/formats.ts";
import { convertDocument, createDocument, readDocument } from "../src/index.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-create-document-test-"));
const realFetch = globalThis.fetch;
const fetched: string[] = [];

before(async () => {
  // Nothing here may use the network: remote images are refused, not downloaded.
  globalThis.fetch = (async (input: string | URL | Request) => {
    fetched.push(String(input instanceof Request ? input.url : input));
    throw new Error("network access in a test");
  }) as typeof fetch;
  const logo = await svgToPng('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60" fill="#1F4E79"/></svg>');
  writeFileSync(join(dir, "logo.png"), logo);
});

after(() => {
  globalThis.fetch = realFetch;
  rmSync(dir, { recursive: true, force: true });
});

const REPORT = `---
title: Quarterly Report
author: Ops Team
---

# Quarterly Report

Summary of **Q3** with _emphasis_, \`code\`, ~~old~~ and a [link](https://example.com).[^1]

## Metrics

| Region | Revenue | Growth |
|:-------|--------:|-------:|
| EMEA | $1,250,000 | 12.5% |
| APAC | $980,500 | 8% |

## Architecture

\`\`\`mermaid
flowchart LR
  A[Client] --> B[Service]
\`\`\`

### Tasks

- [x] Ship v2
- [ ] Migrate database
  - nested bullet

1. First
2. Second
   1. Sub-step

\`\`\`ts
function hello() {
  return 1;
}
\`\`\`

![Logo](logo.png)

## Appendix

Done.

[^1]: Figures are unaudited.
`;

const create = (output: string, extra: Partial<Parameters<typeof createDocument>[0]> = {}) => createDocument({ content: REPORT, output, cwd: dir, ...extra });
const bytes = (path: string) => new Uint8Array(readFileSync(join(dir, path)));
const text = (path: string) => readFileSync(join(dir, path), "utf8");

test("Markdown becomes every document and spreadsheet format", async () => {
  const expected: Record<string, (data: Uint8Array) => boolean> = {
    "report.pdf": (data) => sniffFormat(data) === "pdf",
    "report.docx": (data) => sniffFormat(data) === "docx",
    "report.pptx": (data) => sniffFormat(data) === "pptx",
    "report.xlsx": (data) => sniffFormat(data) === "xlsx",
    "report.rtf": (data) => sniffFormat(data) === "rtf",
    "report.doc": (data) => sniffFormat(data) === "rtf",
    "report.html": (data) => new TextDecoder().decode(data).startsWith("<!doctype html>"),
    "report.md": (data) => new TextDecoder().decode(data).includes("| Region"),
    "report.txt": (data) => new TextDecoder().decode(data).startsWith("Quarterly Report\n================"),
    "report.csv": (data) => new TextDecoder().decode(data).startsWith("Region,Revenue,Growth\r\nEMEA"),
    "report.json": (data) => Array.isArray(JSON.parse(new TextDecoder().decode(data))),
  };
  for (const [output, check] of Object.entries(expected)) {
    const result = await create(output);
    assert.equal(result.files[0]!.path, join(dir, output));
    assert.ok(check(bytes(output)), `${output} has the expected content`);
    if (output === "report.doc") assert.match(result.warnings.join("\n"), /Rich Text Format under a \.doc name/);
    else assert.deepEqual(result.warnings, [], `${output}: ${result.warnings.join("; ")}`);
  }
  assert.match(text("report.html"), /<svg[\s\S]*Client/, "diagrams are inline SVG");
  assert.match(text("report.html"), /src="data:image\/png;base64,/, "images are embedded");
  assert.deepEqual(fetched, []);
});

test("Word documents read back with their structure", async () => {
  await create("roundtrip.docx");
  const { markdown, warnings } = await readDocument({ path: "roundtrip.docx", cwd: dir });
  assert.deepEqual(warnings, []);
  for (const fragment of [
    "# Quarterly Report",
    "## Metrics",
    "| EMEA   | $1,250,000 | 12.5%  |",
    "- [x] Ship v2\n- [ ] Migrate database\n  - nested bullet",
    "1. First\n2. Second\n   1. Sub-step",
    "```\nfunction hello() {\n  return 1;\n}\n```",
    "`code`",
    "~~old~~",
    "[link](https://example.com)",
    "[^1]",
    "[^1]: Figures are unaudited.",
    "![Diagram 1](embedded-image-1.png)",
  ]) assert.ok(markdown.includes(fragment), `missing ${JSON.stringify(fragment)} in\n${markdown}`);
});

test("a Word table of contents is written with page numbers", async () => {
  const result = await create("toc.docx", { toc: true, content: "# Title\n\n## One\n\nText.\n\n## Two\n\nMore.\n" });
  assert.deepEqual(result.warnings, []);
  const JSZip = (await import("jszip")).default;
  const xml = await (await JSZip.loadAsync(bytes("toc.docx"))).file("word/document.xml")!.async("string");
  assert.match(xml, /One<\/w:t>[\s\S]*?>1<\/w:t>/);
  assert.doesNotMatch(xml, /w:dirty="(true|1)"/, "Word does not ask to update the fields");
});

test("PowerPoint decks read back with slide titles, lists and code", async () => {
  const result = await create("deck.pptx");
  assert.ok(result.facts.some((fact) => /^\d+ slides$/.test(fact)));
  const { markdown } = await readDocument({ path: "deck.pptx", cwd: dir });
  for (const fragment of ["# Quarterly Report", "## Metrics", "## Architecture", "- [x] Ship v2", "  - nested bullet", "   1. Sub-step", "```\nfunction hello() {\n  return 1;\n}\n```", "`code`", "~~old~~", "<!-- [1] Figures are unaudited. -->"]) {
    assert.ok(markdown.includes(fragment), `missing ${JSON.stringify(fragment)} in\n${markdown}`);
  }
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(bytes("deck.pptx"));
  for (const name of Object.keys(zip.files).filter((path) => /^ppt\/slides\/slide\d+\.xml$/.test(path))) {
    const xml = await zip.file(name)!.async("string");
    // One paragraph-properties element per paragraph, as the schema requires.
    for (const paragraph of xml.match(/<a:p>[\s\S]*?<\/a:p>/g) ?? []) assert.ok((paragraph.match(/<a:pPr\b/g) ?? []).length <= 1, `${name}: ${paragraph}`);
  }
});

test("RTF and .doc output read back", async () => {
  await create("back.rtf");
  const { markdown, facts } = await readDocument({ path: "back.rtf", cwd: dir });
  assert.ok(facts.includes('title "Quarterly Report", author Ops Team') || facts.join().includes("Ops Team"), facts.join());
  for (const fragment of ["# Quarterly Report", "| APAC   | $980,500   | 8%     |", "- [x] Ship v2", "  - nested bullet", "```\nfunction hello() {\n  return 1;\n}\n```"]) {
    assert.ok(markdown.includes(fragment), `missing ${JSON.stringify(fragment)} in\n${markdown}`);
  }
  const converted = await convertDocument({ input: "back.rtf", output: "from-rtf.docx", cwd: dir });
  assert.equal(sniffFormat(bytes("from-rtf.docx")), "docx");
  assert.deepEqual(converted.warnings, []);
});

test("PDF text reads back without running footers or the table of contents", async () => {
  await create("long.pdf", { toc: true, content: `# Long\n\n${Array.from({ length: 6 }, (_, i) => `## Part ${i + 1}\n\n${"Words fill the page. ".repeat(160)}`).join("\n\n")}` });
  const { markdown, facts } = await readDocument({ path: "long.pdf", cwd: dir });
  assert.ok(facts.some((fact) => /^\d+ pages$/.test(fact)));
  assert.match(markdown, /^# Long\n/);
  assert.match(markdown, /\n## Part 6\n/);
  assert.doesNotMatch(markdown, /\b\d+ \/ \d+\b/, "page footers are dropped");
  assert.equal(markdown.match(/Part 3/g)?.length, 1, "contents entries are dropped");
});

test("PDF pages and documents render to numbered PNG files", async () => {
  const pages = await create("pages.png", { content: `# Pages\n\n${"Line of text.\n\n".repeat(120)}` });
  assert.ok(pages.files.length > 1);
  assert.deepEqual(pages.files.map((file) => file.path), pages.files.map((_, index) => join(dir, `pages-${index + 1}.png`)));
  await create("pdf-source.pdf", { content: `# Source\n\n${"Line of text.\n\n".repeat(120)}` });
  const second = await convertDocument({ input: "pdf-source.pdf", output: "second.png", pages: "2", scale: 1, cwd: dir });
  assert.deepEqual(second.files.map((file) => file.path), [join(dir, "second.png")]);
  assert.match(second.facts.join(), /pages 2 of \d+/);
  assert.equal(sniffFormat(bytes("second.png")), "png");
});

test("Mermaid renders to PNG and SVG; unsupported diagrams stay code in documents", async () => {
  const png = await createDocument({ content: "sequenceDiagram\n  Alice->>Bob: Hello", output: "seq.png", cwd: dir });
  assert.equal(sniffFormat(bytes("seq.png")), "png");
  assert.match(png.facts.join(), /^\d+x\d+ px$/);
  await createDocument({ content: 'pie title Share\n  "A" : 2\n  "B" : 1', output: "pie.svg", cwd: dir });
  assert.match(text("pie.svg"), /^<svg[\s\S]*Share/);
  const pdf = await createDocument({ content: "# Plan\n\n```mermaid\ngantt\n  title Plan\n```\n", output: "gantt.pdf", cwd: dir });
  assert.match(pdf.warnings.join(), /Diagram 1 kept as code: Mermaid "gantt" diagrams are not supported/);
  await assert.rejects(createDocument({ content: "gantt\n  title x", output: "gantt.png", cwd: dir }), /"gantt" diagrams are not supported/);
});

test("spreadsheets keep numbers, formats and formulas", async () => {
  const csv = 'name,amount,share,date\nWidgets,"1,200.50",12%,2024-03-01\nGadgets,300,5.5%,2024-04-15\nTotal,=SUM(B2:B3),,\n';
  await createDocument({ content: csv, output: "data.xlsx", cwd: dir });
  const ExcelJS = ((await import("exceljs")) as unknown as { default: typeof import("exceljs") }).default;
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(readFileSync(join(dir, "data.xlsx")) as unknown as ArrayBuffer);
  const sheet = book.worksheets[0]!;
  assert.equal(sheet.getCell("B2").value, 1200.5);
  assert.equal(sheet.getCell("B2").numFmt, "#,##0.00");
  assert.equal(sheet.getCell("C2").value, 0.12);
  assert.deepEqual(sheet.getCell("B4").value, { formula: "SUM(B2:B3)" });
  assert.equal(sheet.getCell("B4").numFmt, "#,##0.00", "a formula takes its column's number format");
  assert.ok(sheet.getCell("D2").value instanceof Date);
  assert.equal(book.creator, undefined, "no made-up author");
  const JSZip = (await import("jszip")).default;
  const workbookXml = await (await JSZip.loadAsync(bytes("data.xlsx"))).file("xl/workbook.xml")!.async("string");
  assert.match(workbookXml, /fullCalcOnLoad="1"/, "Excel works formulas out on opening");

  await convertDocument({ input: "data.xlsx", output: "data.csv", cwd: dir });
  assert.equal(text("data.csv"), 'name,amount,share,date\r\nWidgets,"1,200.50",12%,2024-03-01\r\nGadgets,300,5.5%,2024-04-15\r\nTotal,=SUM(B2:B3),,\r\n');
  const json = await convertDocument({ input: "data.xlsx", output: "data.json", cwd: dir });
  assert.deepEqual(json.warnings, []);
  assert.deepEqual(JSON.parse(text("data.json"))[0], { name: "Widgets", amount: 1200.5, share: 0.12, date: "2024-03-01" });
  await assert.rejects(createDocument({ content: "# No tables", output: "none.xlsx", cwd: dir }), /The document has no tables/);
});

test("Markdown output keeps images usable from where it is written", async () => {
  await create("images.docx");
  mkdirSync(join(dir, "out"), { recursive: true });
  await convertDocument({ input: "images.docx", output: "out/images.md", cwd: dir });
  const markdown = text("out/images.md");
  assert.match(markdown, /!\[Logo\]\(images_files\/image-\d\.png\)/);
  for (const file of readdirSync(join(dir, "out/images_files"))) assert.equal(sniffFormat(bytes(`out/images_files/${file}`)), "png");
  // Relative image paths are rebased from the source's folder to the output's.
  writeFileSync(join(dir, "page.md"), "![Logo](logo.png)\n");
  await convertDocument({ input: "page.md", output: "out/page.md", cwd: dir });
  assert.equal(text("out/page.md"), "![Logo](../logo.png)\n");
});

test("existing files are kept unless overwrite is given, and inputs are never replaced", async () => {
  await createDocument({ content: "# One", output: "keep.md", cwd: dir });
  await assert.rejects(createDocument({ content: "# Two", output: "keep.md", cwd: dir }), /keep\.md already exists\. Pass overwrite: true to replace it\./);
  assert.equal(text("keep.md"), "# One\n");
  await createDocument({ content: "# Two", output: "keep.md", cwd: dir, overwrite: true });
  assert.equal(text("keep.md"), "# Two\n");
  await assert.rejects(convertDocument({ input: "keep.md", output: "keep.md", cwd: dir, overwrite: true }), /different file from the input/);
  assert.ok(!readdirSync(dir).some((name) => name.includes(".tmp")), "no temporary files are left behind");
});

test("remote images are refused without network access", async () => {
  const result = await createDocument({ content: "# Remote\n\n![Chart](https://example.com/chart.png)\n", output: "remote.docx", cwd: dir });
  assert.match(result.warnings.join(), /Image skipped: https:\/\/example\.com\/chart\.png is a remote image; download it first and reference the local file/);
  assert.deepEqual(fetched, []);
  assert.ok(existsSync(join(dir, "remote.docx")));
});
