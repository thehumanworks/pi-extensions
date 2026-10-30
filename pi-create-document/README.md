# Pi Create Document

**PDF, Word, PowerPoint, Excel, CSV and PNG files from Pi, with nothing to install.**

Agents write text and Markdown well, but a report as a PDF, a deck or a spreadsheet usually means LibreOffice, Pandoc, a headless browser or Python packages, installed on the spot. This extension gives the agent three tools that create, convert and read those formats in-process. Fonts, diagram rendering and every file format are bundled; nothing is downloaded and no system tool is run.

- **`create_document`** writes a file from Markdown (or HTML, text, CSV, TSV, JSON, Mermaid or SVG). The extension picks the format: `report.pdf`, `report.docx`, `deck.pptx`, `data.xlsx`, `flow.png`.
- **`convert_document`** converts a file between formats. PDFs and documents become one PNG per page, so the agent can look at what it made.
- **`read_document`** reads PDF, Word, PowerPoint, Excel and other files as Markdown, so the agent can check its output or work from a file it was given.

## Install

From this checkout, after installing dependencies at the repository root:

```sh
pi install /path/to/pi-extensions/pi-create-document
```

Then restart Pi or run `/reload`. For a one-session preview:

```sh
pi -e /path/to/pi-extensions/pi-create-document/index.ts
```

Published releases:

```sh
pi install npm:@nothumanwork/pi-create-document
```

Requires Pi 1.4.0 and Node.js 22.19+. Two dependencies are native: [`@napi-rs/canvas`](https://github.com/Brooooooklyn/canvas) (PDF pages to PNG) and [`@resvg/resvg-js`](https://github.com/thx/resvg-js) (SVG to PNG). npm installs their prebuilt binaries for Linux, macOS and Windows on x64 and arm64. Neither runs an install script.

## Formats

| Format | Write | Read |
| --- | --- | --- |
| PDF (`.pdf`) | Yes: selectable text, vector diagrams, contents page, page numbers | Text, headings and paragraphs |
| Word (`.docx`) | Yes: Word's heading styles, lists, tables, footnotes, images, contents | Yes, with images |
| Word 97–2003 (`.doc`) | As Rich Text under a `.doc` name, with a warning (see [Limits](#limits)) | Text only |
| Rich Text (`.rtf`) | Yes | Yes, without images |
| PowerPoint (`.pptx`) | Yes: editable text, title placeholders, tables, pictures, speaker notes | Yes: slides, notes, tables and pictures |
| Excel (`.xlsx`) | Yes: typed cells, number formats, formulas, frozen header, filters | Yes: every visible sheet |
| CSV, TSV (`.csv`, `.tsv`) | Yes (RFC 4180) | Yes |
| JSON (`.json`) | Records, or an object of sheets | Records or rows |
| PNG (`.png`) | Document and PDF pages, Mermaid diagrams, SVG and images | As an image |
| SVG (`.svg`) | Mermaid diagrams and SVG | As an image |
| HTML (`.html`) | One self-contained page: inline styles, SVG and images | Yes |
| Markdown, text (`.md`, `.txt`) | Yes; images are saved beside the file | Yes |
| Mermaid (`.mmd`), JPEG | — | Yes |

Word, PowerPoint and Excel output is standard Office Open XML, the format Microsoft Office uses and Google Docs, Slides and Sheets import; it was checked by rendering it in LibreOffice. Workbooks ask the application to work out their formulas on opening.

## Writing documents

Content is GitHub-flavoured Markdown:

- Headings, emphasis, strikethrough, inline code, links, lists, task lists, tables with column alignment, block quotes, code blocks, footnotes, horizontal rules and images (local paths or `data:` URIs) all carry over.
- YAML front matter sets the metadata: `title`, `author`, `subject`, `description`, `keywords` and `lang`.
- A ```` ```mermaid ```` block becomes a diagram: `flowchart`/`graph`, `sequenceDiagram`, `classDiagram`, `stateDiagram`, `erDiagram`, `xychart` and `pie`. Other Mermaid types stay as code, with a warning. A ```` ```svg ```` block becomes a figure.
- `<!-- pagebreak -->` (or `\newpage`) starts a new page.
- A single level 1 heading at the top is the title: Word's Title style, the PDF and HTML title, the deck's cover slide. With `toc: true`, PDF, Word and HTML get a table of contents after it. In Word it is a real table-of-contents field, written with its page numbers.

**Slides.** A new slide starts at each `---`, page break, and heading at the slide level: H2 under a single H1 (which becomes the cover), otherwise the top heading level used. Content that does not fit continues on further slides titled "(continued)". A short text beside one picture is laid out in two columns. HTML comments and footnotes become speaker notes.

**Spreadsheets.** Each Markdown or HTML table becomes a sheet named after the heading above it, or give CSV, TSV or JSON. Cells become typed values: numbers with thousands separators, currency and percentages keep their display format, ISO dates become dates, `TRUE`/`FALSE` become booleans and `=SUM(B2:B9)` becomes a formula. Identifiers with leading zeros, phone numbers and version strings stay text.

**Images.** Relative paths resolve against the session directory for `create_document`, or the input's folder for `convert_document`. Remote `http(s)` images are never fetched; download them first. A skipped image is a warning, not a failure.

## Tool options

| Option | Applies to | Effect |
| --- | --- | --- |
| `format`, `from` | all | Output or input format when the extension does not say it |
| `contentFormat` | `create_document` | `markdown`, `html`, `text`, `csv`, `tsv`, `json`, `mermaid` or `svg`, when detection would guess wrong |
| `title`, `author`, `subject` | documents | Metadata, overriding front matter |
| `pageSize`, `orientation` | PDF, Word, RTF, PNG pages | `A4` (default), `Letter`, `Legal`, `A3`, `A5`; portrait or landscape |
| `toc` | PDF, Word, HTML | Table of contents after the title |
| `pageNumbers` | PDF, Word, RTF | Footer page numbers; on by default |
| `accent` | all documents | Colour of headings, links, table headers and slide titles, such as `#1F4E79` |
| `aspect` | PowerPoint | `16:9` (default) or `4:3` |
| `theme` | diagrams | Mermaid theme such as `github-light`, `nord` or `dracula`; default zinc light |
| `scale`, `background` | PNG | Resolution (2 = 144 DPI for pages) and background colour or `transparent` |
| `pages` | PDF input | Pages to read or render, such as `1-3,5` |
| `sheet` | CSV, TSV output | The sheet to write when there are several |
| `overwrite` | writes | Replace existing files. Without it, an existing output is an error |

Several PNG pages are written as `name-1.png`, `name-2.png`, … numbered by page. Writes go through Pi's file mutation queue and a temporary file, so a failed conversion leaves nothing half-written. A conversion never replaces its own input.

## Limits

- **Legacy `.doc`.** No JavaScript library writes Word 97–2003 binary files. A `.doc` output holds Rich Text, which Word and LibreOffice open as a Word document; the result says so. Write `.docx` for full fidelity and for Google Docs. Reading a real `.doc` keeps only its text. Excel and PowerPoint 97–2003 files (`.xls`, `.ppt`) cannot be read; save them as `.xlsx` or `.pptx`.
- **Reading PDFs** recovers text, headings and paragraphs, and drops running headers, footers and contents pages. Tables, columns and images are not rebuilt. To see a PDF, convert it to PNG.
- **Fonts.** Text is set in Roboto and code in Roboto Mono, with Noto fallbacks for maths, symbols and emoji. Emoji are monochrome in PDF and PNG output. Word, RTF and PowerPoint output names Calibri and Consolas, which the viewing application supplies.
- **Word contents page numbers** come from laying the pages out as Word does. When the layout meets something it cannot measure exactly, such as emoji, it estimates the rest and the result warns. Word corrects the numbers when the table is updated.
- **Inputs** are limited to 200 MB. PNG output is limited to 10,000 pixels a side.

## SDK

The conversion code works without Pi:

```ts
import { convertDocument, createDocument, readDocument } from "@nothumanwork/pi-create-document";

await createDocument({ content: "# Q3\n\n| Region | Revenue |\n|---|---:|\n| EMEA | $1,250 |\n", output: "q3.xlsx" });
await convertDocument({ input: "q3.xlsx", output: "q3.pdf" });
const { markdown } = await readDocument({ path: "q3.pdf" });
```

`renderMermaid`, `svgToPng`, `pdfToPng` and `readPdf` are exported too. The Pi extension is the `./pi` export.

## Dependencies

Documents are written with [pdfmake](https://github.com/bpampuch/pdfmake), [docx](https://github.com/dolanmiu/docx), [PptxGenJS](https://github.com/gitbrent/PptxGenJS) and [ExcelJS](https://github.com/exceljs/exceljs). They are read with [PDF.js](https://github.com/mozilla/pdf.js), [mammoth](https://github.com/mwilliamson/mammoth.js) and [word-extractor](https://github.com/morungos/node-word-extractor). Diagrams come from [beautiful-mermaid](https://github.com/lukilabs/beautiful-mermaid), and Markdown is handled by the [unified](https://unifiedjs.com) mdast and hast utilities. RTF reading and writing, and pie charts, are this package's own. The dependencies are under permissive licences (MIT, ISC, BSD, Apache-2.0 and similar), except two with file-level copyleft: `@resvg/resvg-js` (MPL-2.0) and `elkjs` (EPL-2.0), which beautiful-mermaid uses for layout. The bundled fonts are under the SIL Open Font License.

`npm audit` reports two advisories in this package's dependency tree, neither reachable from it:

- `image-size` (GHSA-5p2g-fcmc-qvqq, GHSA-w3rx-r6r6-pgpr) is declared by PptxGenJS 4.0.1 but not imported by either of its builds.
- `uuid` before 11.1.1 (GHSA-w5hq-g745-h8pq) affects v3, v5 and v6 called with a buffer. ExcelJS 4.4.0 only calls v4 without one.

`npm audit fix --force` would downgrade both libraries to releases with breaking changes, so it is not applied.

## Development

```sh
npm run check --workspace @nothumanwork/pi-create-document
npm test --workspace @nothumanwork/pi-create-document
```

The tests convert a sample report to every format and read each back. They stub `fetch` to show that nothing reaches the network.
