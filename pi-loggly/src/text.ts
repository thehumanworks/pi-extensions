import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

/**
 * Clip plain (unstyled) text to a terminal width with "…". Unlike
 * truncateToWidth, adds no SGR reset, so surrounding styles survive.
 */
export function clip(text: string, width: number): string {
  if (visibleWidth(text) <= width) return text;
  if (width <= 0) return "";
  return truncateToWidth(text, width, "…").replace(/\x1b\[0m/g, "");
}

/** Clip and pad plain text on the right. */
export function pad(text: string, width: number): string {
  const clipped = clip(text, width);
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

/** Clip and pad plain text on the left. */
export function lpad(text: string, width: number): string {
  const clipped = clip(text, width);
  return " ".repeat(Math.max(0, width - visibleWidth(clipped))) + clipped;
}

/** Clip a styled line to exactly `width` columns, so an overlay fully covers what is beneath. */
export function fit(line: string, width: number): string {
  const clipped = visibleWidth(line) > width ? truncateToWidth(line, width, "…") : line;
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

/** Wrap styled text with a hanging indent. */
export function wrap(text: string, width: number, indent: string, firstIndent = ""): string[] {
  const inner = Math.max(10, width - visibleWidth(indent));
  return wrapTextWithAnsi(text, inner).map((line, index) => (index === 0 ? firstIndent : indent) + line);
}
