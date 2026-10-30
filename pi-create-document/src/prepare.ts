import type { Html, Image, Nodes, Paragraph, Parent, PhrasingContent, Root, RootContent } from "mdast";
import { toString as nodeText } from "mdast-util-to-string";
import { ImageLoadError, loadImage, svgAsset } from "./assets.ts";
import { DiagramError, renderMermaid, type DiagramOptions } from "./diagram.ts";
import type { DocumentModel, ImageAsset, Metadata } from "./model.ts";

export interface PrepareOptions {
  /** Directory that relative image paths resolve against. */
  baseDir: string;
  diagrams?: DiagramOptions;
}

/** A document ready for a writer: references resolved, raw HTML converted, images and diagrams loaded. */
export interface PreparedDocument {
  meta: Metadata;
  tree: Root;
  /** Images by their placeholder URL (asset:1, asset:2, ...), which image nodes now use. */
  assets: Map<string, ImageAsset>;
  warnings: string[];
}

const PAGE_BREAK = /^<!--\s*(page-?break|new-?page)\s*-->$/i;

export function isPageBreak(node: Nodes): boolean {
  return node.type === "html" && PAGE_BREAK.test(node.value.trim());
}

/** Text of an HTML comment, or undefined for other nodes. Slides use comments as speaker notes. */
export function commentText(node: Nodes): string | undefined {
  if (node.type !== "html") return undefined;
  const match = /^<!--([\s\S]*?)-->$/.exec(node.value.trim());
  return match ? match[1]!.trim() : undefined;
}

/**
 * The index of the document's title: its only level 1 heading, when nothing but front matter and
 * comments comes before it, else -1. Writers set it as the title, ahead of and outside the table
 * of contents.
 */
export function titleIndex(nodes: readonly RootContent[]): number {
  const index = nodes.findIndex((node) => node.type !== "yaml" && node.type !== "definition" && commentText(node) === undefined);
  const node = nodes[index];
  if (node?.type !== "heading" || node.depth !== 1) return -1;
  return nodes.filter((other) => other.type === "heading" && other.depth === 1).length === 1 ? index : -1;
}

/** The image of a paragraph that holds only an image, the Markdown idiom for a figure. */
export function figureImage(node: Nodes): Image | undefined {
  if (node.type !== "paragraph") return undefined;
  const content = node.children.filter((child) => !(child.type === "text" && child.value.trim() === ""));
  const only = content.length === 1 ? content[0] : undefined;
  if (only?.type === "image") return only;
  if (only?.type === "link" && only.children.length === 1 && only.children[0]!.type === "image") return only.children[0] as Image;
  return undefined;
}

/** Slug for heading anchors, unique within one document. */
export function slugger(): (text: string) => string {
  const seen = new Map<string, number>();
  return (text) => {
    const base = text.toLowerCase().trim().replace(/[^\p{L}\p{N}\s-]/gu, "").replace(/\s+/g, "-") || "section";
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count ? `${base}-${count}` : base;
  };
}

type HtmlToMdast = (html: string) => RootContent[];

/**
 * Prepare a document for writing. The input tree is not modified.
 * htmlToMdast converts raw HTML blocks; it is injected to keep this module free of HTML parsing.
 */
export async function prepareDocument(document: DocumentModel, options: PrepareOptions, htmlToMdast: HtmlToMdast): Promise<PreparedDocument> {
  const tree = structuredClone(document.tree);
  const warnings: string[] = [];
  const assets = new Map<string, ImageAsset>();
  const byUrl = new Map<string, string | null>();
  let diagrams = 0;

  const definitions = new Map<string, { url: string; title?: string | null }>();
  const collect = (node: Nodes) => {
    if (node.type === "definition") definitions.set(node.identifier.toLowerCase(), { url: node.url, title: node.title });
    if ("children" in node) for (const child of node.children) collect(child);
  };
  collect(tree);

  const addAsset = (asset: ImageAsset): string => {
    const key = `asset:${assets.size + 1}`;
    assets.set(key, asset);
    return key;
  };

  const resolveImage = async (image: Image) => {
    if (image.url.startsWith("asset:")) return;
    if (!byUrl.has(image.url)) {
      try {
        byUrl.set(image.url, addAsset(await loadImage(image.url, options.baseDir)));
      } catch (error) {
        const reason = error instanceof ImageLoadError ? error.message : error instanceof Error && "code" in error && error.code === "ENOENT" ? `${image.url} was not found` : String(error instanceof Error ? error.message : error);
        warnings.push(`Image skipped: ${reason}.`);
        byUrl.set(image.url, null);
      }
    }
    const key = byUrl.get(image.url);
    if (key) image.url = key;
  };

  const figure = (key: string, alt: string): Paragraph => ({ type: "paragraph", children: [{ type: "image", url: key, alt }] });

  const transform = async (parent: Parent, inline: boolean): Promise<void> => {
    const output: Nodes[] = [];
    for (const node of parent.children as Nodes[]) {
      switch (node.type) {
        case "definition":
          continue;
        case "linkReference": {
          const target = definitions.get(node.identifier.toLowerCase());
          if (target) output.push({ type: "link", url: target.url, title: target.title, children: node.children });
          else output.push({ type: "text", value: nodeText(node) });
          continue;
        }
        case "imageReference": {
          const target = definitions.get(node.identifier.toLowerCase());
          if (target) {
            const image: Image = { type: "image", url: target.url, title: target.title, alt: node.alt };
            await resolveImage(image);
            output.push(image);
          } else output.push({ type: "text", value: node.alt ?? "" });
          continue;
        }
        case "image":
          await resolveImage(node);
          output.push(node);
          continue;
        case "html": {
          const html = node.value.trim();
          if (inline) {
            if (/^<br\s*\/?>$/i.test(html)) output.push({ type: "break" });
            continue;
          }
          if (/^<!--[\s\S]*-->$/.test(html)) {
            output.push(node);
            continue;
          }
          const converted: Root = { type: "root", children: htmlToMdast(html) };
          await transform(converted, false);
          output.push(...converted.children);
          continue;
        }
        case "code": {
          const lang = node.lang?.toLowerCase();
          if (lang === "mermaid") {
            diagrams += 1;
            try {
              const svg = await renderMermaid(node.value, options.diagrams);
              output.push(figure(addAsset(svgAsset(svg)), node.meta?.trim() || `Diagram ${diagrams}`));
            } catch (error) {
              if (!(error instanceof DiagramError)) throw error;
              warnings.push(`Diagram ${diagrams} kept as code: ${error.message}.`);
              output.push(node);
            }
            continue;
          }
          if (lang === "svg" && /<svg[\s>]/i.test(node.value)) {
            output.push(figure(addAsset(svgAsset(node.value)), node.meta?.trim() || "Figure"));
            continue;
          }
          output.push(node);
          continue;
        }
        case "paragraph": {
          const text = nodeText(node).trim();
          if (/^\\(newpage|pagebreak)$/.test(text)) {
            output.push({ type: "html", value: "<!-- pagebreak -->" } satisfies Html);
            continue;
          }
          await transform(node, true);
          output.push(node);
          continue;
        }
        default:
          if ("children" in node) await transform(node, inline || isPhrasingParent(node));
          output.push(node);
      }
    }
    parent.children = output as typeof parent.children;
  };
  await transform(tree, false);
  return { meta: document.meta, tree, assets, warnings };
}

function isPhrasingParent(node: Nodes): boolean {
  return ["heading", "emphasis", "strong", "delete", "link", "tableCell", "linkReference"].includes(node.type);
}

/** Flatten inline content to plain text, rendering images as their alt text. */
export function inlineText(nodes: PhrasingContent[]): string {
  return nodes.map((node) => (node.type === "break" ? "\n" : node.type === "image" ? node.alt ?? "" : nodeText(node))).join("");
}
