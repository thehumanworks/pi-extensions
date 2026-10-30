import type { Root, Yaml } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { frontmatterFromMarkdown, frontmatterToMarkdown } from "mdast-util-frontmatter";
import { gfmFromMarkdown, gfmToMarkdown } from "mdast-util-gfm";
import { toMarkdown } from "mdast-util-to-markdown";
import { frontmatter } from "micromark-extension-frontmatter";
import { gfm } from "micromark-extension-gfm";
import { parse as parseYaml } from "yaml";
import type { DocumentModel, Metadata } from "./model.ts";

/** Parse GitHub-flavoured Markdown. YAML front matter (title, author, subject, keywords, lang) becomes metadata. */
export function parseMarkdown(text: string): DocumentModel {
  const tree = fromMarkdown(text.replace(/^\uFEFF/, ""), {
    extensions: [gfm(), frontmatter(["yaml"])],
    mdastExtensions: [gfmFromMarkdown(), frontmatterFromMarkdown(["yaml"])],
  });
  const yaml = tree.children[0]?.type === "yaml" ? (tree.children[0] as Yaml) : undefined;
  return { kind: "document", meta: yaml ? frontMatter(yaml.value) : {}, tree };
}

function frontMatter(source: string): Metadata {
  let data: unknown;
  try {
    data = parseYaml(source);
  } catch {
    return {};
  }
  if (!data || typeof data !== "object") return {};
  const record = data as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === "string" || typeof value === "number" ? String(value) : undefined);
  const list = (value: unknown) => (Array.isArray(value) ? value.map(String) : typeof value === "string" ? value.split(",").map((item) => item.trim()).filter(Boolean) : undefined);
  const author = Array.isArray(record.author) ? record.author.map(String).join(", ") : text(record.author ?? record.authors);
  return {
    title: text(record.title),
    author,
    subject: text(record.subject),
    description: text(record.description ?? record.abstract),
    keywords: list(record.keywords ?? record.tags),
    language: text(record.lang ?? record.language),
  };
}

export function serializeMarkdown(tree: Root): string {
  return toMarkdown(tree, {
    extensions: [gfmToMarkdown(), frontmatterToMarkdown(["yaml"])],
    bullet: "-",
    emphasis: "_",
    rule: "-",
    fences: true,
    listItemIndent: "one",
  });
}
