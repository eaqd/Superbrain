import { StandardFontEmbedder, StandardFonts } from "@cantoo/pdf-lib";
import type { FontKey } from "./types";

/** Standard-14 font used for a FontKey/bold/italic combination. */
export function standardFontName(font: FontKey, bold: boolean, italic: boolean): StandardFonts {
  switch (font) {
    case "Times":
      return bold && italic
        ? StandardFonts.TimesRomanBoldItalic
        : bold
          ? StandardFonts.TimesRomanBold
          : italic
            ? StandardFonts.TimesRomanItalic
            : StandardFonts.TimesRoman;
    case "Courier":
      return bold && italic
        ? StandardFonts.CourierBoldOblique
        : bold
          ? StandardFonts.CourierBold
          : italic
            ? StandardFonts.CourierOblique
            : StandardFonts.Courier;
    default:
      return bold && italic
        ? StandardFonts.HelveticaBoldOblique
        : bold
          ? StandardFonts.HelveticaBold
          : italic
            ? StandardFonts.HelveticaOblique
            : StandardFonts.Helvetica;
  }
}

/** CSS stacks that are metric-compatible with the PDF standard fonts. */
export const CSS_FONT: Record<FontKey, string> = {
  Helvetica: "Helvetica, Arial, 'Liberation Sans', 'Nimbus Sans', sans-serif",
  Times: "'Times New Roman', Times, 'Liberation Serif', 'Nimbus Roman', serif",
  Courier: "'Courier New', Courier, 'Liberation Mono', 'Nimbus Mono PS', monospace",
};

/**
 * Vertical metrics of the browser fonts above (Arial / Times New Roman / Courier New).
 * Used when exporting so the baseline of each line matches what the editor showed.
 */
export const CSS_METRICS: Record<FontKey, { ascent: number; descent: number }> = {
  Helvetica: { ascent: 0.905, descent: 0.212 },
  Times: { ascent: 0.891, descent: 0.216 },
  Courier: { ascent: 0.833, descent: 0.3 },
};

export const TEXT_PAD = 2;

const embedders = new Map<string, StandardFontEmbedder>();
const charWidthCache = new Map<string, number>();

function embedder(name: StandardFonts) {
  let e = embedders.get(name);
  if (!e) {
    e = StandardFontEmbedder.for(name as never);
    embedders.set(name, e);
  }
  return e;
}

const WIN_ANSI_EXTRA = new Set(Array.from("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ"));

/** Can the WinAnsi-encoded standard fonts represent this text? */
export function isWinAnsi(text: string): boolean {
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c === 10 || c === 13 || c === 9) continue;
    if ((c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff)) continue;
    if (WIN_ANSI_EXTRA.has(ch)) continue;
    return false;
  }
  return true;
}

/** Width (pt) of `text` at 1pt, falling back to 0.55em for characters the font can't encode. */
export function textWidth(text: string, font: FontKey, bold: boolean, italic: boolean, size: number): number {
  const name = standardFontName(font, bold, italic);
  const e = embedder(name);
  let w = 0;
  for (const ch of text) {
    const key = name + ch;
    let cw = charWidthCache.get(key);
    if (cw === undefined) {
      try {
        cw = e.widthOfTextAtSize(ch, 1);
      } catch {
        cw = font === "Courier" ? 0.6 : 0.55;
      }
      charWidthCache.set(key, cw);
    }
    w += cw;
  }
  return w * size;
}

export interface TextLayout {
  lines: string[];
  /** Widest line (pt). */
  width: number;
  lineHeight: number;
}

/** Break text into lines. maxWidth=null → only explicit newlines. Shared by editor and export (WYSIWYG). */
export function layoutText(
  text: string,
  o: { font: FontKey; bold: boolean; italic: boolean; size: number; lineHeight: number },
  maxWidth: number | null,
): TextLayout {
  const measure = (s: string) => textWidth(s, o.font, o.bold, o.italic, o.size);
  const lines: string[] = [];
  for (const para of text.split("\n")) {
    if (maxWidth === null || measure(para) <= maxWidth) {
      lines.push(para);
      continue;
    }
    const words = para.split(/(\s+)/);
    let line = "";
    for (const token of words) {
      const candidate = line + token;
      if (measure(candidate.trimEnd()) <= maxWidth || line === "") {
        if (line === "" && measure(token) > maxWidth && token.trim()) {
          // Break a single long word by characters.
          let chunk = "";
          for (const ch of token) {
            if (measure(chunk + ch) > maxWidth && chunk) {
              lines.push(chunk);
              chunk = ch;
            } else chunk += ch;
          }
          line = chunk;
        } else line = candidate;
      } else {
        lines.push(line.trimEnd());
        line = token.trim() ? token : "";
      }
    }
    lines.push(line.trimEnd());
  }
  const width = Math.max(0, ...lines.map(measure));
  return { lines, width, lineHeight: o.size * o.lineHeight };
}

/** Size a text box needs for its content. */
export function measureTextBox(
  text: string,
  o: { font: FontKey; bold: boolean; italic: boolean; size: number; lineHeight: number },
  fixedWidth: number | null,
): { w: number; h: number; layout: TextLayout } {
  const inner = fixedWidth === null ? null : Math.max(4, fixedWidth - TEXT_PAD * 2);
  const layout = layoutText(text, o, inner);
  const w = fixedWidth ?? Math.max(o.size * 0.6, layout.width) + TEXT_PAD * 2 + 1;
  const h = Math.max(1, layout.lines.length) * layout.lineHeight + TEXT_PAD * 2;
  return { w, h, layout };
}
