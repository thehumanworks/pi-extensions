import type { List, Nodes, PhrasingContent, Root, RootContent, Table } from "mdast";
import { toString as nodeText } from "mdast-util-to-string";
import type { DocumentModel } from "./model.ts";
import { commentText, isPageBreak } from "./prepare.ts";

/** Paragraphs are separated by blank lines; line breaks inside a paragraph are kept. */
export function parseText(text: string): DocumentModel {
  const blocks = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split(/\n\s*\n/).map((block) => block.replace(/\s+$/, "")).filter((block) => block.trim());
  const children: RootContent[] = blocks.map((block) => ({
    type: "paragraph",
    children: block.split("\n").flatMap((line, index): PhrasingContent[] => (index ? [{ type: "break" }, { type: "text", value: line }] : [{ type: "text", value: line }])),
  }));
  return { kind: "document", meta: {}, tree: { type: "root", children } };
}

function inline(nodes: PhrasingContent[]): string {
  return nodes.map((node): string => {
    switch (node.type) {
      case "break":
        return "\n";
      case "image":
        return `[Image${node.alt ? `: ${node.alt}` : ""}]`;
      case "link": {
        const text = inline(node.children);
        return text && text !== node.url && !node.url.startsWith("#") ? `${text} (${node.url})` : text || node.url;
      }
      case "footnoteReference":
        return `[${node.label ?? node.identifier}]`;
      case "html":
        return "";
      default:
        return "children" in node ? inline(node.children as PhrasingContent[]) : nodeText(node);
    }
  }).join("");
}

/** Display width, counting wide East Asian characters as two columns. */
function width(text: string): number {
  let total = 0;
  for (const char of text) total += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/.test(char) ? 2 : 1;
  return total;
}

function table(node: Table): string {
  const rows = node.children.map((row) => row.children.map((cell) => inline(cell.children).replace(/\s*\n\s*/g, " ")));
  const columns = Math.max(...rows.map((row) => row.length));
  const widths = Array.from({ length: columns }, (_, column) => Math.max(3, ...rows.map((row) => width(row[column] ?? ""))));
  const line = (row: string[]) => row.map((cell, column) => {
    const pad = " ".repeat(widths[column]! - width(cell));
    return node.align?.[column] === "right" ? pad + cell : cell + pad;
  }).join("  ").trimEnd();
  const filled = rows.map((row) => Array.from({ length: columns }, (_, column) => row[column] ?? ""));
  return [line(filled[0]!), widths.map((w) => "-".repeat(w)).join("  "), ...filled.slice(1).map(line)].join("\n");
}

function list(node: List, depth: number): string {
  let number = node.start ?? 1;
  return node.children.map((item) => {
    const marker = node.ordered ? `${number++}.` : "-";
    const check = item.checked === true ? "[x] " : item.checked === false ? "[ ] " : "";
    const indent = " ".repeat(marker.length + 1);
    const body = item.children.map((child) => block(child, depth + 1)).filter(Boolean).join("\n").split("\n");
    return [`${marker} ${check}${body[0] ?? ""}`, ...body.slice(1).map((line) => (line ? indent + line : line))].join("\n");
  }).join("\n");
}

function block(node: Nodes, depth = 0): string {
  switch (node.type) {
    case "heading": {
      const text = inline(node.children);
      if (node.depth === 1) return `${text}\n${"=".repeat(Math.max(3, width(text)))}`;
      if (node.depth === 2) return `${text}\n${"-".repeat(Math.max(3, width(text)))}`;
      return text;
    }
    case "paragraph":
      return inline(node.children);
    case "list":
      return list(node, depth);
    case "code":
      return node.value.split("\n").map((line) => `    ${line}`).join("\n");
    case "blockquote":
      return node.children.map((child) => block(child, depth)).join("\n\n").split("\n").map((line) => `> ${line}`.trimEnd()).join("\n");
    case "table":
      return table(node);
    case "thematicBreak":
      return "----";
    case "html":
      return isPageBreak(node) || commentText(node) !== undefined ? "" : node.value.replace(/<[^>]*>/g, "");
    case "yaml":
    case "definition":
      return "";
    case "footnoteDefinition":
      return `[${node.label ?? node.identifier}] ${node.children.map((child) => block(child, depth)).join("\n")}`;
    default:
      return "children" in node ? node.children.map((child) => block(child as Nodes, depth)).filter(Boolean).join("\n\n") : nodeText(node);
  }
}

/** Readable plain text: underlined headings, aligned tables, indented code. */
export function writeText(tree: Root): string {
  const blocks = tree.children.filter((node) => node.type !== "footnoteDefinition").map((node) => block(node)).filter((text) => text.trim() !== "");
  const notes = tree.children.filter((node) => node.type === "footnoteDefinition").map((node) => block(node));
  return `${[...blocks, ...(notes.length ? ["Notes\n-----", ...notes] : [])].join("\n\n")}\n`;
}
