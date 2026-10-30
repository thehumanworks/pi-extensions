import { createRequire } from "node:module";
import type * as Fontkit from "fontkit";

const require = createRequire(import.meta.url);

export interface FontFiles {
  normal: string;
  bold: string;
  italics: string;
  bolditalics: string;
}

/** Families registered with the PDF engine, in fallback order after the text or code font. */
export type FontName = "Roboto" | "RobotoMono" | "NotoMath" | "NotoSymbols2" | "NotoEmoji";

let cached: Record<FontName, FontFiles> | undefined;

const single = (path: string): FontFiles => ({ normal: path, bold: path, italics: path, bolditalics: path });

/**
 * Bundled fonts, so output never depends on what is installed: Roboto (shipped with pdfmake)
 * for text, Roboto Mono for code, and Noto Sans Math, Noto Sans Symbols 2 and Noto Emoji for
 * arrows, check marks, shapes and emoji. All are licensed under the SIL Open Font License.
 */
export function bundledFonts(): Record<FontName, FontFiles> {
  cached ??= {
    Roboto: {
      normal: require.resolve("pdfmake/fonts/Roboto/Roboto-Regular.ttf"),
      bold: require.resolve("pdfmake/fonts/Roboto/Roboto-Medium.ttf"),
      italics: require.resolve("pdfmake/fonts/Roboto/Roboto-Italic.ttf"),
      bolditalics: require.resolve("pdfmake/fonts/Roboto/Roboto-MediumItalic.ttf"),
    },
    RobotoMono: {
      normal: require.resolve("@expo-google-fonts/roboto-mono/400Regular/RobotoMono_400Regular.ttf"),
      bold: require.resolve("@expo-google-fonts/roboto-mono/700Bold/RobotoMono_700Bold.ttf"),
      italics: require.resolve("@expo-google-fonts/roboto-mono/400Regular_Italic/RobotoMono_400Regular_Italic.ttf"),
      bolditalics: require.resolve("@expo-google-fonts/roboto-mono/700Bold_Italic/RobotoMono_700Bold_Italic.ttf"),
    },
    NotoMath: single(require.resolve("@expo-google-fonts/noto-sans-math/400Regular/NotoSansMath_400Regular.ttf")),
    NotoSymbols2: single(require.resolve("@expo-google-fonts/noto-sans-symbols-2/400Regular/NotoSansSymbols2_400Regular.ttf")),
    NotoEmoji: single(require.resolve("@expo-google-fonts/noto-emoji/400Regular/NotoEmoji_400Regular.ttf")),
  };
  return cached;
}

/** Every bundled font file, for rasterising SVG. */
export function fontFileList(): string[] {
  return [...new Set(Object.values(bundledFonts()).flatMap((files) => Object.values(files)))];
}

const FALLBACKS: FontName[] = ["NotoMath", "NotoSymbols2", "NotoEmoji"];
const faces = new Map<FontName, Fontkit.Font>();

function face(name: FontName): Fontkit.Font {
  let font = faces.get(name);
  if (!font) {
    // Loaded on first use, to keep extension start-up fast.
    const fontkit = require("fontkit") as typeof Fontkit;
    font = fontkit.openSync(bundledFonts()[name].normal) as Fontkit.Font;
    faces.set(name, font);
  }
  return font;
}

/** Emoji presentation selectors, zero-width joiners and similar marks that carry no glyph. */
const INVISIBLE = /[\uFE0E\uFE0F\u200D\u200B\u2060]/;

/**
 * Split text into runs that each use one font: the base font where it has the glyph, else the
 * first fallback that does. PDF fonts do not fall back on their own, so this avoids empty boxes.
 */
export function fontRuns(text: string, base: FontName): { text: string; font: FontName }[] {
  const runs: { text: string; font: FontName }[] = [];
  let current: FontName = base;
  let buffer = "";
  for (const char of text) {
    if (INVISIBLE.test(char)) continue;
    const code = char.codePointAt(0)!;
    // Spaces always use the base font: fallback fonts often have much wider spaces.
    const font: FontName = code > 0x7e && !/\s/.test(char) ? ([base, ...FALLBACKS].find((name) => face(name).hasGlyphForCodePoint(code)) ?? base) : base;
    if (font !== current && buffer) {
      runs.push({ text: buffer, font: current });
      buffer = "";
    }
    current = font;
    buffer += char;
  }
  if (buffer) runs.push({ text: buffer, font: current });
  return runs;
}
