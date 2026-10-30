import { fontFileList } from "./fonts.ts";

/** Mermaid diagram types this SDK renders. */
export const MERMAID_TYPES = ["flowchart", "sequenceDiagram", "classDiagram", "stateDiagram", "erDiagram", "xychart", "pie"] as const;

export interface DiagramOptions {
  /** A beautiful-mermaid theme name, e.g. github-light, nord-light, tokyo-night. Default zinc-light. */
  theme?: string;
  /** Accent colour (hex) for arrows, highlights and the first chart series. */
  accent?: string;
}

export class DiagramError extends Error {}

/** Mermaid source without front matter, %% comments and %%{init}%% directives. */
function cleanMermaid(source: string): string {
  let text = source.replace(/\r\n?/g, "\n").trim();
  const frontMatter = /^---\n[\s\S]*?\n---\n/.exec(text);
  if (frontMatter) text = text.slice(frontMatter[0].length);
  return text.split("\n").filter((line) => !line.trim().startsWith("%%")).join("\n").trim();
}

/** The diagram keyword on the first line, e.g. "flowchart" or "gantt". */
export function mermaidType(source: string): string {
  const first = cleanMermaid(source).split(/[\n;]/)[0]?.trim() ?? "";
  return first.split(/\s+/)[0] ?? "";
}

/** True when the text starts like a Mermaid diagram rather than a document. */
export function looksLikeMermaid(source: string): boolean {
  return /^(graph|flowchart|sequenceDiagram|classDiagram(-v2)?|stateDiagram(-v2)?|erDiagram|xychart(-beta)?|pie|gantt|journey|gitGraph|mindmap|timeline|quadrantChart|sankey(-beta)?|block(-beta)?|requirementDiagram|C4\w+|packet(-beta)?|architecture(-beta)?|kanban|radar(-beta)?|treemap(-beta)?)\b/.test(mermaidType(source));
}

/**
 * Render Mermaid source to self-contained SVG: no CSS variables, color-mix() or web-font imports,
 * so PDF engines, rasterisers and office suites draw it as browsers do.
 */
export async function renderMermaid(source: string, options: DiagramOptions = {}): Promise<string> {
  const text = cleanMermaid(source);
  const type = mermaidType(text);
  if (type === "pie") return renderPie(text, options);
  const supported = /^(graph|flowchart|sequenceDiagram|classDiagram(-v2)?|stateDiagram(-v2)?|erDiagram|xychart(-beta)?)$/;
  if (!supported.test(type)) {
    throw new DiagramError(`Mermaid "${type || "(empty)"}" diagrams are not supported; use one of ${MERMAID_TYPES.join(", ")}`);
  }
  const { renderMermaidSVG, THEMES } = await import("beautiful-mermaid");
  const theme = options.theme ? (THEMES as Record<string, object>)[options.theme] : undefined;
  if (options.theme && !theme) throw new DiagramError(`Unknown diagram theme "${options.theme}"; use one of ${Object.keys(THEMES).join(", ")}`);
  let svg: string;
  try {
    svg = renderMermaidSVG(text, { ...(theme ?? {}), ...(options.accent ? { accent: options.accent } : {}), font: "Roboto" });
  } catch (error) {
    throw new DiagramError(`Mermaid ${type} diagram could not be rendered: ${error instanceof Error ? error.message : String(error)}`);
  }
  return flattenSvg(svg);
}

/** Split on commas outside parentheses. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (char === "," && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim());
}

/** Replace each fn(...) call, innermost arguments first, using balanced parentheses. */
function replaceCalls(text: string, fn: string, replace: (args: string) => string): string {
  let out = "";
  let index = 0;
  for (;;) {
    const start = text.indexOf(`${fn}(`, index);
    if (start < 0) return out + text.slice(index);
    let depth = 0;
    let end = start + fn.length;
    for (; end < text.length; end += 1) {
      if (text[end] === "(") depth += 1;
      else if (text[end] === ")" && --depth === 0) break;
    }
    if (end >= text.length) return out + text.slice(index);
    out += text.slice(index, start) + replace(text.slice(start + fn.length + 1, end));
    index = end + 1;
  }
}

type Rgba = [number, number, number, number];

function parseColor(value: string): Rgba | undefined {
  const color = value.trim().toLowerCase();
  if (color === "transparent") return [0, 0, 0, 0];
  if (color === "white") return [255, 255, 255, 1];
  if (color === "black") return [0, 0, 0, 1];
  const hex = /^#([0-9a-f]{3,8})$/.exec(color)?.[1];
  if (hex) {
    const full = hex.length <= 4 ? [...hex].map((c) => c + c).join("") : hex;
    const byte = (i: number) => parseInt(full.slice(i, i + 2), 16);
    if (full.length === 6 || full.length === 8) return [byte(0), byte(2), byte(4), full.length === 8 ? byte(6) / 255 : 1];
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(color);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), rgb[4] ? (rgb[4].endsWith("%") ? parseFloat(rgb[4]) / 100 : Number(rgb[4])) : 1];
  return undefined;
}

function formatColor([r, g, b, a]: Rgba): string {
  if (a >= 0.999) return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
  return `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${Math.round(a * 1000) / 1000})`;
}

/** CSS color-mix(in srgb, A p%, B q%), with premultiplied alpha as browsers compute it. */
function colorMix(args: string): string {
  const [space, first = "", second = ""] = splitTopLevel(args);
  const parse = (part: string) => {
    const match = /^(.*?)\s+([\d.]+)%$/.exec(part);
    return { color: (match ? match[1] : part)!.trim(), weight: match ? Number(match[2]) / 100 : undefined };
  };
  const a = parse(first);
  const b = parse(second);
  const ca = parseColor(a.color);
  const cb = parseColor(b.color);
  if (!space?.includes("srgb") || !ca || !cb) return a.color;
  const pa = a.weight ?? (b.weight !== undefined ? 1 - b.weight : 0.5);
  const pb = b.weight ?? 1 - pa;
  const total = pa + pb || 1;
  const wa = pa / total;
  const wb = pb / total;
  const alpha = ca[3] * wa + cb[3] * wb;
  const channel = (i: number) => (alpha === 0 ? 0 : (ca[i]! * ca[3] * wa + cb[i]! * cb[3] * wb) / alpha);
  return formatColor([channel(0), channel(1), channel(2), alpha * Math.min(1, total)]);
}

/**
 * Resolve CSS custom properties and color-mix() in an SVG to literal colours, drop web-font
 * imports and point fonts at the bundled families. Class-based <style> rules remain; resvg,
 * pdfmake and browsers all apply them.
 */
export function flattenSvg(svg: string): string {
  const definitions = new Map<string, string>();
  const rootStyle = /^\s*(?:<\?xml[^>]*>\s*)?<svg\b[^>]*\sstyle="([^"]*)"/.exec(svg)?.[1] ?? "";
  for (const match of rootStyle.matchAll(/(--[\w-]+)\s*:\s*([^;]+)/g)) definitions.set(match[1]!, match[2]!.trim());
  for (const block of svg.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) {
    for (const match of block[1]!.matchAll(/(--[\w-]+)\s*:\s*([^;}]+);/g)) if (!definitions.has(match[1]!)) definitions.set(match[1]!, match[2]!.trim());
  }
  const resolve = (text: string, depth = 0): string => {
    if (depth > 16) return text;
    const substituted = replaceCalls(text, "var", (args) => {
      const [name = "", ...rest] = splitTopLevel(args);
      const value = definitions.get(name);
      if (value !== undefined) return resolve(value, depth + 1);
      return rest.length ? resolve(rest.join(","), depth + 1) : "none";
    });
    return replaceCalls(substituted, "color-mix", colorMix);
  };
  return resolve(svg)
    .replace(/@import\s+url\([^)]*\)\s*;?/g, "")
    .replace(/font-family:\s*'JetBrains Mono'[^;}]*/g, "font-family: 'Roboto Mono', monospace")
    .replace(/(\s)--[\w-]+\s*:\s*[^;}]*;/g, "$1");
}

const PALETTE = ["#4E79A7", "#F28E2B", "#E15759", "#76B7B2", "#59A14F", "#EDC948", "#B07AA1", "#FF9DA7", "#9C755F", "#BAB0AC"];

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Approximate rendered width of text in Roboto. */
function textWidth(text: string, size: number): number {
  return [...text].reduce((sum, char) => sum + (/[il.,:;'|!]/.test(char) ? 0.28 : /[mwMW@]/.test(char) ? 0.85 : /[A-Z0-9]/.test(char) ? 0.62 : 0.52), 0) * size;
}

/** Mermaid pie charts: `pie [showData]`, optional `title`, then `"Label" : value` lines. */
function renderPie(source: string, options: DiagramOptions): string {
  const lines = source.split("\n").map((line) => line.trim()).filter(Boolean);
  const header = lines.shift() ?? "";
  const showData = /\bshowData\b/.test(header);
  let title = /\btitle\s+(.+)$/.exec(header)?.[1]?.trim();
  const slices: { label: string; value: number }[] = [];
  for (const line of lines) {
    const titleLine = /^title\s+(.+)$/.exec(line);
    if (titleLine) {
      title = titleLine[1]!.trim();
      continue;
    }
    const slice = /^"([^"]*)"\s*:\s*([-+]?\d*\.?\d+)\s*$/.exec(line) ?? /^'([^']*)'\s*:\s*([-+]?\d*\.?\d+)\s*$/.exec(line);
    if (!slice) {
      if (/^(showData|accTitle|accDescr)\b/.test(line)) continue;
      throw new DiagramError(`Mermaid pie: cannot read line "${line}"; expected "Label" : value`);
    }
    const value = Number(slice[2]);
    if (value < 0) throw new DiagramError(`Mermaid pie: "${slice[1]}" has a negative value`);
    slices.push({ label: slice[1]!, value });
  }
  const total = slices.reduce((sum, slice) => sum + slice.value, 0);
  if (slices.length === 0 || total <= 0) throw new DiagramError("Mermaid pie: no positive values to chart");
  const palette = options.accent ? [options.accent, ...PALETTE] : PALETTE;
  const radius = 130;
  const pad = 32;
  const titleHeight = title ? 44 : 0;
  const legendRow = 26;
  const legendTexts = slices.map((slice) => `${slice.label}${showData ? ` [${formatValue(slice.value)}]` : ""}  ${formatPercent(slice.value / total)}`);
  const legendWidth = 26 + Math.max(...legendTexts.map((text) => textWidth(text, 14)));
  const legendHeight = slices.length * legendRow;
  const width = Math.ceil(pad + radius * 2 + 40 + legendWidth + pad);
  const height = Math.ceil(pad + titleHeight + Math.max(radius * 2, legendHeight) + pad);
  const cx = pad + radius;
  const cy = pad + titleHeight + Math.max(radius, legendHeight / 2);
  const parts: string[] = [];
  let angle = -Math.PI / 2;
  slices.forEach((slice, index) => {
    const color = palette[index % palette.length]!;
    const sweep = (slice.value / total) * Math.PI * 2;
    if (sweep >= Math.PI * 2 - 1e-9) {
      parts.push(`<circle cx="${cx}" cy="${cy}" r="${radius}" fill="${color}" stroke="#FFFFFF" stroke-width="2"/>`);
    } else if (sweep > 0) {
      const x1 = cx + radius * Math.cos(angle);
      const y1 = cy + radius * Math.sin(angle);
      const x2 = cx + radius * Math.cos(angle + sweep);
      const y2 = cy + radius * Math.sin(angle + sweep);
      parts.push(`<path d="M${cx},${cy} L${x1.toFixed(2)},${y1.toFixed(2)} A${radius},${radius} 0 ${sweep > Math.PI ? 1 : 0} 1 ${x2.toFixed(2)},${y2.toFixed(2)} Z" fill="${color}" stroke="#FFFFFF" stroke-width="2"/>`);
    }
    if (slice.value / total >= 0.05) {
      const mid = angle + sweep / 2;
      const lx = cx + radius * 0.66 * Math.cos(mid);
      const ly = cy + radius * 0.66 * Math.sin(mid);
      parts.push(`<text x="${lx.toFixed(2)}" y="${(ly + 4.5).toFixed(2)}" text-anchor="middle" font-size="13" font-weight="500" fill="#FFFFFF">${formatPercent(slice.value / total)}</text>`);
    }
    angle += sweep;
  });
  const legendX = pad + radius * 2 + 40;
  const legendY = cy - legendHeight / 2;
  slices.forEach((slice, index) => {
    const y = legendY + index * legendRow;
    parts.push(`<rect x="${legendX}" y="${(y + 5).toFixed(2)}" width="14" height="14" rx="3" fill="${palette[index % palette.length]}"/>`);
    parts.push(`<text x="${legendX + 24}" y="${(y + 17).toFixed(2)}" font-size="14" fill="#27272A">${escapeXml(slice.label)}${showData ? ` <tspan fill="#71717A">[${formatValue(slice.value)}]</tspan>` : ""} <tspan fill="#71717A">${formatPercent(slice.value / total)}</tspan></text>`);
  });
  const heading = title ? `<text x="${width / 2}" y="${pad + 18}" text-anchor="middle" font-size="18" font-weight="600" fill="#27272A">${escapeXml(title)}</text>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">\n<style>text { font-family: 'Roboto', system-ui, sans-serif; }</style>\n<rect width="${width}" height="${height}" fill="#FFFFFF"/>\n${heading}\n${parts.join("\n")}\n</svg>`;
}

function formatPercent(fraction: number): string {
  const percent = fraction * 100;
  return `${percent >= 10 || Number.isInteger(percent) ? Math.round(percent) : percent.toFixed(1)}%`;
}

function formatValue(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
}

/** Largest PNG side in pixels; bigger requests are scaled down. */
const MAX_PIXELS = 10_000;

/** Rasterise SVG to PNG with the bundled fonts. scale multiplies the SVG's natural size. */
export async function svgToPng(svg: string, options: { scale?: number; background?: string; width?: number; height?: number } = {}): Promise<Uint8Array> {
  const { Resvg } = await import("@resvg/resvg-js");
  const probe = new Resvg(svg, { font: { loadSystemFonts: false } });
  const natural = { width: options.width ?? probe.width, height: options.height ?? probe.height };
  const scale = Math.min(options.scale ?? 2, MAX_PIXELS / Math.max(natural.width, natural.height, 1));
  const renderer = new Resvg(svg, {
    fitTo: { mode: "width", value: Math.max(1, Math.round(natural.width * scale)) },
    background: options.background,
    font: {
      fontFiles: fontFileList(),
      loadSystemFonts: false,
      defaultFontFamily: "Roboto",
      sansSerifFamily: "Roboto",
      serifFamily: "Roboto",
      monospaceFamily: "Roboto Mono",
    },
  });
  return new Uint8Array(renderer.render().asPng());
}
