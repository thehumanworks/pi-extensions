import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ImageAsset, ImageMime } from "./model.ts";

/** Pixel size of PNG, JPEG and GIF data, or undefined for anything else. */
export function rasterSize(data: Uint8Array): { width: number; height: number; mime: ImageMime } | undefined {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.length >= 24 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
    return { mime: "image/png", width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (data.length >= 10 && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) {
    return { mime: "image/gif", width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < data.length) {
      if (data[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = data[offset + 1]!;
      const length = view.getUint16(offset + 2);
      // Start-of-frame markers, excluding DHT (C4), JPG (C8) and DAC (CC).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { mime: "image/jpeg", height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
      }
      offset += 2 + length;
    }
  }
  return undefined;
}

function svgLength(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = /^\s*([\d.]+)\s*(px|pt|in|cm|mm)?\s*$/.exec(value);
  if (!match) return undefined;
  const scale = { px: 1, pt: 4 / 3, in: 96, cm: 96 / 2.54, mm: 96 / 25.4 }[match[2] ?? "px"] ?? 1;
  return Number(match[1]) * scale;
}

/** Natural size of SVG markup from its width, height and viewBox. */
export function svgSize(svg: string): { width: number; height: number } {
  const tag = /<svg\b[^>]*>/i.exec(svg)?.[0] ?? "";
  const attribute = (name: string) => new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(tag)?.[1];
  const box = attribute("viewBox")?.trim().split(/[\s,]+/).map(Number);
  const boxWidth = box && box.length === 4 && box[2]! > 0 ? box[2]! : undefined;
  const boxHeight = box && box.length === 4 && box[3]! > 0 ? box[3]! : undefined;
  let width = svgLength(attribute("width"));
  let height = svgLength(attribute("height"));
  if (width === undefined && height === undefined) {
    width = boxWidth ?? 300;
    height = boxHeight ?? 150;
  } else if (width === undefined) {
    width = boxWidth && boxHeight ? (height! * boxWidth) / boxHeight : height!;
  } else if (height === undefined) {
    height = boxWidth && boxHeight ? (width * boxHeight) / boxWidth : width;
  }
  return { width: width!, height: height! };
}

export function svgAsset(svg: string): ImageAsset {
  const { width, height } = svgSize(svg);
  return { mime: "image/svg+xml", data: new TextEncoder().encode(svg), width, height, svg };
}

/** An image asset from bytes, or undefined when they are not PNG, JPEG, GIF or SVG. */
export function imageAsset(data: Uint8Array): ImageAsset | undefined {
  const raster = rasterSize(data);
  if (raster) return { ...raster, data };
  const text = new TextDecoder().decode(data.subarray(0, 2048));
  if (/<svg[\s>]/i.test(text)) return svgAsset(new TextDecoder().decode(data));
  return undefined;
}

export function dataUri(asset: ImageAsset): string {
  return `data:${asset.mime};base64,${Buffer.from(asset.data).toString("base64")}`;
}

export class ImageLoadError extends Error {}

/**
 * Load an image referenced by a document: a data URI, a file: URL, or a path relative to baseDir.
 * Remote URLs are not fetched, so documents never make network requests.
 */
export async function loadImage(url: string, baseDir: string): Promise<ImageAsset> {
  const data = url.startsWith("data:") ? decodeDataUri(url) : await readFile(localPath(url, baseDir));
  const asset = imageAsset(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  if (!asset) throw new ImageLoadError(`${url.startsWith("data:") ? "embedded image" : url} is not a PNG, JPEG, GIF or SVG image`);
  return asset;
}

function localPath(url: string, baseDir: string): string {
  if (/^https?:\/\//i.test(url)) throw new ImageLoadError(`${url} is a remote image; download it first and reference the local file`);
  if (url.startsWith("file:")) return fileURLToPath(url);
  const path = decodeURI(url.split(/[?#]/)[0]!);
  const expanded = path.startsWith("~/") ? resolve(process.env.HOME ?? "", path.slice(2)) : path;
  return isAbsolute(expanded) ? expanded : resolve(baseDir, expanded);
}

function decodeDataUri(uri: string): Buffer {
  const comma = uri.indexOf(",");
  if (comma < 0) throw new ImageLoadError("malformed data URI");
  const header = uri.slice(5, comma);
  const body = uri.slice(comma + 1);
  return header.endsWith(";base64") ? Buffer.from(body, "base64") : Buffer.from(decodeURIComponent(body), "utf8");
}

/** Scale (width, height) down to fit within the box, never enlarging. */
export function fit(width: number, height: number, maxWidth: number, maxHeight: number): { width: number; height: number } {
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  return { width: width * scale, height: height * scale };
}
