import type { Element, ElementContent, Root as HastRoot, RootContent as HastContent } from "hast";
import { fromHtml } from "hast-util-from-html";
import { toHtml } from "hast-util-to-html";
import { toMdast } from "hast-util-to-mdast";
import type { Heading, Nodes, Parent, PhrasingContent, Root, RootContent } from "mdast";
import { toHast, type Handler } from "mdast-util-to-hast";
import { toString as nodeText } from "mdast-util-to-string";
import { dataUri } from "./assets.ts";
import type { DocumentModel, Metadata } from "./model.ts";
import { commentText, isPageBreak, slugger, titleIndex, type PreparedDocument } from "./prepare.ts";

const svgToImage = (_state: unknown, element: Element) => {
  const markup = toHtml(element, { space: "svg" });
  const title = element.children.find((child): child is Element => child.type === "element" && child.tagName === "title");
  return {
    type: "image" as const,
    url: `data:image/svg+xml;base64,${Buffer.from(markup).toString("base64")}`,
    alt: title ? toHtml(title.children).replace(/<[^>]*>/g, "") : "",
  };
};

function htmlTree(html: string): { hast: HastRoot; isDocument: boolean } {
  const isDocument = /^\s*(<!doctype|<html[\s>])/i.test(html) || /<body[\s>]/i.test(html);
  return { hast: fromHtml(html, { fragment: !isDocument }), isDocument };
}

/** Convert an HTML fragment (for example a raw HTML block in Markdown) to Markdown nodes. */
export function htmlToMdast(html: string): RootContent[] {
  const tree = toMdast(htmlTree(html).hast, { handlers: { svg: svgToImage } }) as Root;
  return tree.children;
}

/** Parse an HTML page or fragment. The title, author, description, keywords and language become metadata. */
export function parseHtml(html: string): DocumentModel {
  const { hast } = htmlTree(html);
  const meta: Metadata = {};
  const visit = (node: HastRoot | HastContent) => {
    if (node.type === "element") {
      if (node.tagName === "html" && typeof node.properties.lang === "string") meta.language = node.properties.lang;
      if (node.tagName === "title") meta.title = toHtml(node.children).replace(/<[^>]*>/g, "").trim() || undefined;
      if (node.tagName === "meta") {
        const name = String(node.properties.name ?? "").toLowerCase();
        const content = typeof node.properties.content === "string" ? node.properties.content : undefined;
        if (content && name === "author") meta.author = content;
        if (content && name === "description") meta.description = content;
        if (content && name === "keywords") meta.keywords = content.split(",").map((word) => word.trim()).filter(Boolean);
      }
    }
    if ("children" in node) for (const child of node.children) visit(child);
  };
  visit(hast);
  const tree = toMdast(hast, { handlers: { svg: svgToImage } }) as Root;
  tidy(tree);
  return { kind: "document", meta, tree };
}

/**
 * Remove conversion noise: anchors without a target (Word bookmarks), empty paragraphs, and bold
 * that only repeats a table header's own emphasis. Items led by a ballot box become task items,
 * and lists whose items hold one paragraph each (and perhaps sublists) are tight.
 */
function tidy(node: Parent): void {
  const children: Nodes[] = [];
  for (const child of node.children as Nodes[]) {
    if ("children" in child) tidy(child);
    if (child.type === "listItem" && child.checked == null) {
      const first = child.children[0]?.type === "paragraph" ? child.children[0] : undefined;
      const head = first?.children[0];
      const box = head?.type === "text" ? /^([☐☑☒])[\s\u00a0]*/.exec(head.value) : null;
      if (head?.type === "text" && box) {
        child.checked = box[1] !== "☐";
        head.value = head.value.slice(box[0].length);
        if (!head.value) first!.children.shift();
      }
    }
    if (child.type === "list" && child.children.every((item) => item.children.filter((block) => block.type !== "list").length <= 1)) {
      child.spread = false;
      for (const item of child.children) item.spread = false;
    }
    if (child.type === "link" && !child.url) {
      children.push(...child.children);
      continue;
    }
    if (child.type === "paragraph" && child.children.every((inline) => inline.type === "text" && !inline.value.trim())) continue;
    if (child.type === "table") {
      // Cells hold inline content: paragraphs from <td><p>...</p></td> become lines.
      for (const row of child.children) {
        for (const cell of row.children) {
          const blocks = cell.children as Nodes[];
          cell.children = blocks.flatMap((block, index): PhrasingContent[] => {
            const inline = block.type === "paragraph" ? block.children : [block as PhrasingContent];
            return index > 0 && block.type === "paragraph" ? [{ type: "break" }, ...inline] : inline;
          });
        }
      }
      for (const cell of child.children[0]?.children ?? []) {
        if (cell.children.length === 1 && cell.children[0]!.type === "strong") cell.children = cell.children[0].children;
      }
    }
    children.push(child);
  }
  node.children = children as typeof node.children;
}

/** Give each SVG's ids a prefix so several inline diagrams on one page cannot clash. */
function scopeSvgIds(svg: string, prefix: string): string {
  const ids = [...svg.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]!);
  let out = svg;
  for (const id of new Set(ids)) {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out
      .replace(new RegExp(`(\\sid=")${escaped}"`, "g"), `$1${prefix}${id}"`)
      .replace(new RegExp(`url\\(#${escaped}\\)`, "g"), `url(#${prefix}${id})`)
      .replace(new RegExp(`(href=")#${escaped}"`, "g"), `$1#${prefix}${id}"`);
  }
  return out.replace(/^\s*<\?xml[^>]*>\s*/, "");
}

export interface HtmlOptions {
  /** Include a linked table of contents of level 1-3 headings. */
  toc?: boolean;
  /** Heading and link colour. Default #1F4E79. */
  accent?: string;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function documentTitle(prepared: { meta: Metadata; tree: Root }): string | undefined {
  if (prepared.meta.title) return prepared.meta.title;
  const heading = prepared.tree.children.find((node): node is Heading => node.type === "heading" && node.depth === 1);
  return heading ? nodeText(heading).trim() || undefined : undefined;
}

/** A standalone HTML page with inline styles, diagrams as inline SVG and images as data URIs. */
export function writeHtml(prepared: PreparedDocument, options: HtmlOptions = {}): string {
  const slug = slugger();
  const toc: { depth: number; id: string; text: string }[] = [];
  const tree = structuredClone(prepared.tree);
  const lead = titleIndex(tree.children) + 1;
  for (const [index, node] of tree.children.entries()) {
    if (node.type !== "heading") continue;
    const text = nodeText(node).trim();
    const id = slug(text);
    node.data = { ...node.data, hProperties: { ...node.data?.hProperties, id } };
    if (node.depth <= 3 && index !== lead - 1) toc.push({ depth: node.depth, id, text });
  }
  let diagramIndex = 0;
  const image: Handler = (_state, node: { url: string; alt?: string | null; title?: string | null }) => {
    const asset = prepared.assets.get(node.url);
    if (asset?.svg) {
      diagramIndex += 1;
      return { type: "element", tagName: "span", properties: { className: ["figure-svg"], role: "img", ariaLabel: node.alt ?? undefined }, children: [{ type: "raw", value: scopeSvgIds(asset.svg, `d${diagramIndex}-`) } as unknown as ElementContent] };
    }
    const src = asset ? dataUri(asset) : node.url;
    return { type: "element", tagName: "img", properties: { src, alt: node.alt ?? "", title: node.title ?? undefined, ...(asset ? { width: Math.round(asset.width), height: Math.round(asset.height) } : {}) }, children: [] };
  };
  const html: Handler = (_state, node: { value: string }) => {
    if (isPageBreak(node as never)) return { type: "element", tagName: "div", properties: { className: ["page-break"] }, children: [] };
    if (commentText(node as never) !== undefined) return undefined;
    return { type: "raw", value: node.value } as unknown as ElementContent;
  };
  const render = (children: RootContent[]) => toHtml(toHast({ type: "root", children }, { allowDangerousHtml: true, handlers: { image, html }, footnoteLabel: "Notes" }), { allowDangerousHtml: true });
  // The contents go after a leading title heading.
  const heading = render(tree.children.slice(0, lead));
  const body = render(tree.children.slice(lead));
  const title = documentTitle(prepared) ?? "Document";
  const accent = options.accent ?? "#1F4E79";
  const contents = options.toc && toc.length > 0
    ? `<nav class="toc"><h2>Contents</h2><ul>${toc.map((entry) => `<li class="toc-${entry.depth - Math.min(...toc.map((other) => other.depth)) + 1}"><a href="#${escapeHtml(entry.id)}">${escapeHtml(entry.text)}</a></li>`).join("")}</ul></nav>\n`
    : "";
  const meta = [
    prepared.meta.author ? `<meta name="author" content="${escapeHtml(prepared.meta.author)}">` : "",
    prepared.meta.description ?? prepared.meta.subject ? `<meta name="description" content="${escapeHtml(prepared.meta.description ?? prepared.meta.subject ?? "")}">` : "",
    prepared.meta.keywords?.length ? `<meta name="keywords" content="${escapeHtml(prepared.meta.keywords.join(", "))}">` : "",
  ].filter(Boolean).join("\n");
  return `<!doctype html>
<html lang="${escapeHtml(prepared.meta.language ?? "en")}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
${meta}
<style>
:root { --accent: ${accent}; --text: #1f2328; --muted: #59636e; --border: #d1d9e0; --code-bg: #f6f8fa; }
* { box-sizing: border-box; }
body { margin: 0; color: var(--text); background: #fff; font: 16px/1.6 "Segoe UI", Roboto, "Helvetica Neue", Arial, system-ui, sans-serif; }
main { max-width: 52rem; margin: 0 auto; padding: 3rem 1.5rem 4rem; }
h1, h2, h3, h4, h5, h6 { color: var(--accent); line-height: 1.25; margin: 1.6em 0 0.6em; font-weight: 600; }
h1 { font-size: 2rem; margin-top: 0; } h2 { font-size: 1.5rem; padding-bottom: .3em; border-bottom: 1px solid var(--border); }
h3 { font-size: 1.25rem; } h4 { font-size: 1.05rem; } h5, h6 { font-size: 1rem; color: var(--muted); }
p, ul, ol, table, pre, blockquote, figure { margin: 0 0 1em; }
a { color: var(--accent); }
img, .figure-svg svg { max-width: 100%; height: auto; }
.figure-svg { display: block; text-align: center; }
p:has(> img:only-child), p:has(> .figure-svg:only-child) { text-align: center; }
code { font: 0.875em/1.5 "Roboto Mono", "SFMono-Regular", Consolas, "Liberation Mono", monospace; background: var(--code-bg); padding: .15em .35em; border-radius: 4px; }
pre { background: var(--code-bg); padding: 1rem; border-radius: 6px; overflow-x: auto; }
pre code { padding: 0; background: none; }
blockquote { border-left: 4px solid var(--border); color: var(--muted); padding: 0 1rem; margin-left: 0; }
table { border-collapse: collapse; width: 100%; font-size: .95em; display: block; overflow-x: auto; }
th, td { border: 1px solid var(--border); padding: .45rem .75rem; vertical-align: top; }
th { background: color-mix(in srgb, var(--accent) 10%, #fff); text-align: left; }
tbody tr:nth-child(even) { background: #f9fafb; }
hr { border: 0; border-top: 1px solid var(--border); margin: 2rem 0; }
.toc { border: 1px solid var(--border); border-radius: 6px; padding: .5rem 1.25rem; margin-bottom: 2rem; }
.toc h2 { border: 0; margin: .5rem 0; font-size: 1.1rem; } .toc ul { list-style: none; padding-left: 0; }
.toc-2 { padding-left: 1rem; } .toc-3 { padding-left: 2rem; }
.page-break { break-after: page; }
.footnotes { font-size: .9em; color: var(--muted); border-top: 1px solid var(--border); margin-top: 2rem; }
.contains-task-list { list-style: none; padding-left: 1.2em; }
@media print { main { max-width: none; padding: 0; } a { color: inherit; } pre, table, figure, img { break-inside: avoid; } h1, h2, h3 { break-after: avoid; } }
</style>
</head>
<body>
<main>
${heading}${heading ? "\n" : ""}${contents}${body}
</main>
</body>
</html>
`;
}
