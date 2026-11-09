/**
 * Font metrics needed to position glyphs of show-text operators:
 * character-code splitting (1-byte simple fonts, CMap-driven Type0 fonts) and
 * glyph advances (Widths/FirstChar, MissingWidth, standard-14 AFM metrics,
 * CID /W + /DW, Type3 FontMatrix).
 */
import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFStream,
  PDFString,
  StandardFontEmbedder,
  type PDFObject,
} from '@cantoo/pdf-lib';
import { bytesToLatin1, getStreamBytes } from './contentStream';

export interface CodeSlice {
  /** Byte offset in the string. */
  start: number;
  /** Code length in bytes. */
  length: number;
  code: number;
}

export interface FontInfo {
  readonly kind: 'simple' | 'type0' | 'type3' | 'unknown';
  /** Vertical writing mode (Type0 with a -V / WMode 1 CMap). */
  readonly vertical: boolean;
  /**
   * Factor converting glyph widths into text-space units per unit of font
   * size: 0.001 for all fonts except Type3 (FontMatrix[0]).
   */
  readonly widthScale: number;
  /** Split a show-text string into character codes. */
  splitCodes(bytes: Uint8Array): CodeSlice[];
  /** Horizontal advance (w0) in glyph units. */
  width(code: number): number;
  /** Vertical advance (w1) in glyph units (normally negative, e.g. -1000). */
  verticalAdvance(code: number): number;
}

// ---------------------------------------------------------------------------
// Small PDF object helpers
// ---------------------------------------------------------------------------

type Resolver = (o: PDFObject | undefined) => PDFObject | undefined;

function resolverFor(dict: PDFDict): Resolver {
  return (o) => (o === undefined ? undefined : dict.context.lookup(o));
}

function numOf(o: PDFObject | undefined): number | undefined {
  return o instanceof PDFNumber ? o.asNumber() : undefined;
}

function nameOf(o: PDFObject | undefined): string | undefined {
  return o instanceof PDFName ? o.decodeText() : undefined;
}

function numberArray(arr: PDFArray, resolve: Resolver): number[] {
  const out: number[] = [];
  for (let i = 0; i < arr.size(); i++) {
    const v = numOf(resolve(arr.get(i)));
    out.push(v === undefined ? NaN : v);
  }
  return out;
}

function get(dict: PDFDict | undefined, key: string): PDFObject | undefined {
  if (!dict) return undefined;
  return dict.context.lookup(dict.get(PDFName.of(key)));
}

// ---------------------------------------------------------------------------
// Standard 14 fonts
// ---------------------------------------------------------------------------

type Std14 =
  | 'Courier' | 'Courier-Bold' | 'Courier-Oblique' | 'Courier-BoldOblique'
  | 'Helvetica' | 'Helvetica-Bold' | 'Helvetica-Oblique' | 'Helvetica-BoldOblique'
  | 'Times-Roman' | 'Times-Bold' | 'Times-Italic' | 'Times-BoldItalic'
  | 'Symbol' | 'ZapfDingbats';

/**
 * Map a BaseFont name to the closest standard-14 font. Handles subset prefixes
 * and common aliases (Arial → Helvetica, TimesNewRoman → Times, CourierNew →
 * Courier). Falls back on FontDescriptor flags when `approximate` is set.
 */
export function standardFontFor(baseFont: string | undefined, flags = 0, approximate = false): Std14 | undefined {
  const name = (baseFont ?? '').replace(/^[A-Z]{6}\+/, '');
  const lower = name.toLowerCase().replace(/[\s_]/g, '');
  const bold = /bold|black|heavy|semibold|demi/.test(lower) || (flags & (1 << 18)) !== 0;
  const italic = /italic|oblique|,it$/.test(lower) || (flags & (1 << 6)) !== 0;
  let family: 'Courier' | 'Helvetica' | 'Times' | 'Symbol' | 'ZapfDingbats' | undefined;
  if (lower.includes('zapf') || lower.includes('dingbat')) family = 'ZapfDingbats';
  else if (lower === 'symbol' || lower.startsWith('symbol,') || lower.startsWith('symbolmt')) family = 'Symbol';
  else if (lower.includes('courier')) family = 'Courier';
  else if (lower.includes('times')) family = 'Times';
  else if (lower.includes('helvetica') || lower.includes('arial')) family = 'Helvetica';
  else if (approximate) {
    if (flags & 1) family = 'Courier'; // FixedPitch
    else if (flags & 2) family = 'Times'; // Serif
    else family = 'Helvetica';
  }
  if (!family) return undefined;
  if (family === 'Symbol' || family === 'ZapfDingbats') return family;
  if (family === 'Times') {
    return bold && italic ? 'Times-BoldItalic' : bold ? 'Times-Bold' : italic ? 'Times-Italic' : 'Times-Roman';
  }
  const suffix = bold && italic ? '-BoldOblique' : bold ? '-Bold' : italic ? '-Oblique' : '';
  return (family + suffix) as Std14;
}

interface StdMetrics {
  widthOf(glyphName: string): number | undefined;
  builtinEncoding: Array<string | undefined>;
}

const stdCache = new Map<Std14, StdMetrics>();
let winAnsiTable: Array<string | undefined> | undefined;

function encodingTable(enc: { supportedCodePoints: number[]; encodeUnicodeCodePoint(cp: number): { code: number; name: string } }) {
  const table: Array<string | undefined> = new Array(256);
  for (const cp of enc.supportedCodePoints) {
    try {
      const { code, name } = enc.encodeUnicodeCodePoint(cp);
      if (code >= 0 && code < 256 && table[code] === undefined) table[code] = name;
    } catch {
      /* ignore */
    }
  }
  return table;
}

function stdMetrics(name: Std14): StdMetrics | undefined {
  let m = stdCache.get(name);
  if (m) return m;
  try {
    // StandardFontEmbedder exposes the AFM metrics bundled with pdf-lib.
    const embedder = StandardFontEmbedder.for(name as never);
    const font = embedder.font;
    m = {
      widthOf: (g) => {
        const w = font.getWidthOfGlyph(g);
        return typeof w === 'number' ? w : undefined;
      },
      builtinEncoding: encodingTable(embedder.encoding),
    };
    stdCache.set(name, m);
    return m;
  } catch {
    return undefined;
  }
}

function getWinAnsi(): Array<string | undefined> {
  if (!winAnsiTable) winAnsiTable = stdMetrics('Helvetica')?.builtinEncoding ?? new Array(256);
  return winAnsiTable;
}

/** Adobe StandardEncoding codes that differ from WinAnsi (others in 32..126 match). */
const STANDARD_ENCODING_DIFFS: Record<number, string> = {
  39: 'quoteright', 96: 'quoteleft', 161: 'exclamdown', 162: 'cent', 163: 'sterling', 164: 'fraction',
  165: 'yen', 166: 'florin', 167: 'section', 168: 'currency', 169: 'quotesingle', 170: 'quotedblleft',
  171: 'guillemotleft', 172: 'guilsinglleft', 173: 'guilsinglright', 174: 'fi', 175: 'fl', 177: 'endash',
  178: 'dagger', 179: 'daggerdbl', 180: 'periodcentered', 182: 'paragraph', 183: 'bullet',
  184: 'quotesinglbase', 185: 'quotedblbase', 186: 'quotedblright', 187: 'guillemotright', 188: 'ellipsis',
  189: 'perthousand', 191: 'questiondown', 193: 'grave', 194: 'acute', 195: 'circumflex', 196: 'tilde',
  197: 'macron', 198: 'breve', 199: 'dotaccent', 200: 'dieresis', 202: 'ring', 203: 'cedilla',
  205: 'hungarumlaut', 206: 'ogonek', 207: 'caron', 208: 'emdash', 225: 'AE', 227: 'ordfeminine',
  232: 'Lslash', 233: 'Oslash', 234: 'OE', 235: 'ordmasculine', 241: 'ae', 245: 'dotlessi', 248: 'lslash',
  249: 'oslash', 250: 'oe', 251: 'germandbls',
};

function baseEncodingTable(name: string | undefined, std: Std14): Array<string | undefined> {
  const winAnsi = getWinAnsi();
  if (name === 'WinAnsiEncoding') return winAnsi.slice();
  if (name === 'MacRomanEncoding') {
    // Approximation: ASCII range identical to WinAnsi.
    const t: Array<string | undefined> = new Array(256);
    for (let c = 32; c < 127; c++) t[c] = winAnsi[c];
    return t;
  }
  if (!name && (std === 'Symbol' || std === 'ZapfDingbats')) {
    return (stdMetrics(std)?.builtinEncoding ?? new Array(256)).slice();
  }
  // StandardEncoding (default for non-symbolic Type1 fonts)
  const t: Array<string | undefined> = new Array(256);
  for (let c = 32; c < 127; c++) t[c] = winAnsi[c];
  for (const [code, glyph] of Object.entries(STANDARD_ENCODING_DIFFS)) t[Number(code)] = glyph;
  return t;
}

/** Build a code → width function from standard-14 AFM metrics for a simple font dict. */
function std14Widths(fontDict: PDFDict, approximate: boolean): ((code: number) => number | undefined) | undefined {
  const fd = get(fontDict, 'FontDescriptor');
  const flags = numOf(fd instanceof PDFDict ? get(fd, 'Flags') : undefined) ?? 0;
  const std = standardFontFor(nameOf(get(fontDict, 'BaseFont')), flags, approximate);
  if (!std) return undefined;
  const metrics = stdMetrics(std);
  if (!metrics) return undefined;

  const enc = get(fontDict, 'Encoding');
  let table: Array<string | undefined>;
  if (enc instanceof PDFName) table = baseEncodingTable(enc.decodeText(), std);
  else if (enc instanceof PDFDict) {
    table = baseEncodingTable(nameOf(get(enc, 'BaseEncoding')), std);
    const diffs = get(enc, 'Differences');
    if (diffs instanceof PDFArray) {
      let code = 0;
      for (let i = 0; i < diffs.size(); i++) {
        const item = fontDict.context.lookup(diffs.get(i));
        if (item instanceof PDFNumber) code = item.asNumber();
        else if (item instanceof PDFName) {
          if (code >= 0 && code < 256) table[code] = item.decodeText();
          code++;
        }
      }
    }
  } else table = baseEncodingTable(undefined, std);

  return (code: number) => {
    const glyph = table[code];
    if (!glyph) return undefined;
    return metrics.widthOf(glyph);
  };
}

// ---------------------------------------------------------------------------
// Simple fonts (Type1, MMType1, TrueType, Type3)
// ---------------------------------------------------------------------------

function splitSingleByte(bytes: Uint8Array): CodeSlice[] {
  const out: CodeSlice[] = new Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = { start: i, length: 1, code: bytes[i] };
  return out;
}

function simpleFont(dict: PDFDict, isType3: boolean): FontInfo {
  const resolve = resolverFor(dict);
  const firstChar = numOf(get(dict, 'FirstChar')) ?? 0;
  const widthsObj = get(dict, 'Widths');
  const widths = widthsObj instanceof PDFArray ? numberArray(widthsObj, resolve) : undefined;
  const fd = get(dict, 'FontDescriptor');
  const missingWidth = fd instanceof PDFDict ? numOf(get(fd, 'MissingWidth')) : undefined;

  let widthScale = 0.001;
  if (isType3) {
    const fm = get(dict, 'FontMatrix');
    const a = fm instanceof PDFArray ? numOf(resolve(fm.get(0))) : undefined;
    if (a !== undefined && Number.isFinite(a) && a !== 0) widthScale = a;
  }

  // Standard-14 metrics are resolved lazily (only needed without /Widths).
  let std: ((code: number) => number | undefined) | null | undefined;
  const stdWidth = (code: number): number | undefined => {
    if (isType3) return undefined;
    if (std === undefined) std = std14Widths(dict, !widths) ?? null;
    return std ? std(code) : undefined;
  };
  const fallback = isType3 ? 0.5 / Math.abs(widthScale) : 500;

  return {
    kind: isType3 ? 'type3' : 'simple',
    vertical: false,
    widthScale,
    splitCodes: splitSingleByte,
    width(code) {
      if (widths) {
        const idx = code - firstChar;
        if (idx >= 0 && idx < widths.length && Number.isFinite(widths[idx])) return widths[idx];
        if (missingWidth !== undefined) return missingWidth;
        return stdWidth(code) ?? fallback;
      }
      const s = stdWidth(code);
      if (s !== undefined) return s;
      return missingWidth ?? fallback;
    },
    verticalAdvance: () => -1000,
  };
}

// ---------------------------------------------------------------------------
// Type0 / CID fonts
// ---------------------------------------------------------------------------

interface CodespaceRange {
  length: number;
  low: number[];
  high: number[];
}

interface CMapInfo {
  /** null → fixed 2-byte codes. */
  ranges: CodespaceRange[] | null;
  vertical: boolean;
  /** Map a character code to a CID. */
  cidOf(code: number): number;
}

function hexBytes(s: string): number[] {
  const out: number[] = [];
  const clean = s.replace(/[^0-9a-fA-F]/g, '');
  for (let i = 0; i + 1 < clean.length; i += 2) out.push(parseInt(clean.substr(i, 2), 16));
  if (clean.length % 2) out.push(parseInt(clean[clean.length - 1] + '0', 16));
  return out;
}

function bytesToCode(b: number[]): number {
  let v = 0;
  for (const x of b) v = v * 256 + x;
  return v;
}

/** Parse the parts of an embedded CMap we need: codespaces, CID mappings, WMode. */
export function parseEmbeddedCMap(text: string): {
  ranges: CodespaceRange[];
  cidRanges: Array<[number, number, number]>;
  cidChars: Map<number, number>;
  vertical: boolean;
  usesIdentity: boolean;
} {
  const ranges: CodespaceRange[] = [];
  const cidRanges: Array<[number, number, number]> = [];
  const cidChars = new Map<number, number>();

  const sectionRe = (name: string) => new RegExp(`begin${name}([\\s\\S]*?)end${name}`, 'g');
  let m: RegExpExecArray | null;

  const csRe = sectionRe('codespacerange');
  while ((m = csRe.exec(text))) {
    const pairRe = /<([0-9a-fA-F\s]*)>\s*<([0-9a-fA-F\s]*)>/g;
    let p: RegExpExecArray | null;
    while ((p = pairRe.exec(m[1]))) {
      const low = hexBytes(p[1]);
      const high = hexBytes(p[2]);
      if (low.length > 0 && low.length === high.length && low.length <= 4) {
        ranges.push({ length: low.length, low, high });
      }
    }
  }

  const crRe = sectionRe('cidrange');
  while ((m = crRe.exec(text))) {
    const tripleRe = /<([0-9a-fA-F\s]*)>\s*<([0-9a-fA-F\s]*)>\s*(\d+)/g;
    let p: RegExpExecArray | null;
    while ((p = tripleRe.exec(m[1]))) {
      cidRanges.push([bytesToCode(hexBytes(p[1])), bytesToCode(hexBytes(p[2])), parseInt(p[3], 10)]);
    }
  }

  const ccRe = sectionRe('cidchar');
  while ((m = ccRe.exec(text))) {
    const pairRe = /<([0-9a-fA-F\s]*)>\s*(\d+)/g;
    let p: RegExpExecArray | null;
    while ((p = pairRe.exec(m[1]))) cidChars.set(bytesToCode(hexBytes(p[1])), parseInt(p[2], 10));
  }

  const vertical = /\/WMode\s+1\b/.test(text);
  const usesIdentity = /\/Identity-[HV]\s+usecmap/.test(text);
  return { ranges, cidRanges, cidChars, vertical, usesIdentity };
}

function loadCMap(enc: PDFObject | undefined): CMapInfo {
  const identity: CMapInfo = { ranges: null, vertical: false, cidOf: (c) => c };
  if (enc instanceof PDFName) {
    const n = enc.decodeText();
    const vertical = /-V$/.test(n);
    if (/^Identity-[HV]$/.test(n)) return { ...identity, vertical };
    // Predefined non-identity CMap: assume 2-byte codes; CIDs unknown (→ /DW).
    return { ranges: null, vertical, cidOf: () => -1 };
  }
  if (enc instanceof PDFStream) {
    let text = '';
    try {
      text = bytesToLatin1(getStreamBytes(enc));
    } catch {
      return identity;
    }
    const parsed = parseEmbeddedCMap(text);
    const wmode = numOf(enc.dict.context.lookup(enc.dict.get(PDFName.of('WMode'))));
    const useCMap = enc.dict.context.lookup(enc.dict.get(PDFName.of('UseCMap')));
    const usesIdentity =
      parsed.usesIdentity || (useCMap instanceof PDFName && /^Identity-[HV]$/.test(useCMap.decodeText()));
    const vertical = parsed.vertical || wmode === 1;
    const hasCidMappings = parsed.cidRanges.length > 0 || parsed.cidChars.size > 0;
    const cidOf = (code: number): number => {
      const direct = parsed.cidChars.get(code);
      if (direct !== undefined) return direct;
      for (const [lo, hi, cid] of parsed.cidRanges) if (code >= lo && code <= hi) return cid + (code - lo);
      return usesIdentity || !hasCidMappings ? code : 0;
    };
    return { ranges: parsed.ranges.length ? parsed.ranges : null, vertical, cidOf };
  }
  return identity;
}

function splitWithRanges(bytes: Uint8Array, ranges: CodespaceRange[]): CodeSlice[] {
  const out: CodeSlice[] = [];
  const minLen = Math.max(1, Math.min(...ranges.map((r) => r.length)));
  let i = 0;
  const n = bytes.length;
  while (i < n) {
    let matched = false;
    let code = 0;
    for (let len = 1; len <= 4 && i + len <= n; len++) {
      code = code * 256 + bytes[i + len - 1];
      for (const r of ranges) {
        if (r.length !== len) continue;
        let ok = true;
        for (let k = 0; k < len; k++) {
          const b = bytes[i + k];
          if (b < r.low[k] || b > r.high[k]) {
            ok = false;
            break;
          }
        }
        if (ok) {
          out.push({ start: i, length: len, code });
          i += len;
          matched = true;
          break;
        }
      }
      if (matched) break;
    }
    if (!matched) {
      // No codespace matches: consume the shortest code length.
      const len = Math.min(minLen, n - i);
      let c = 0;
      for (let k = 0; k < len; k++) c = c * 256 + bytes[i + k];
      out.push({ start: i, length: len, code: c });
      i += len;
    }
  }
  return out;
}

function splitTwoByte(bytes: Uint8Array): CodeSlice[] {
  const out: CodeSlice[] = [];
  for (let i = 0; i < bytes.length; i += 2) {
    if (i + 1 < bytes.length) out.push({ start: i, length: 2, code: (bytes[i] << 8) | bytes[i + 1] });
    else out.push({ start: i, length: 1, code: bytes[i] });
  }
  return out;
}

/** Parse a CID /W array into a lookup function. */
function parseCidWidths(w: PDFArray | undefined, resolve: Resolver): (cid: number) => number | undefined {
  const single = new Map<number, number>();
  const ranges: Array<[number, number, number]> = [];
  if (w) {
    const items = w.asArray().map((x) => resolve(x));
    let i = 0;
    while (i < items.length) {
      const first = numOf(items[i]);
      const next = items[i + 1];
      if (first === undefined) {
        i++;
        continue;
      }
      if (next instanceof PDFArray) {
        const ws = numberArray(next, resolve);
        ws.forEach((v, k) => Number.isFinite(v) && single.set(first + k, v));
        i += 2;
      } else {
        const last = numOf(next);
        const v = numOf(items[i + 2]);
        if (last !== undefined && v !== undefined) ranges.push([first, last, v]);
        i += 3;
      }
    }
  }
  return (cid) => {
    const s = single.get(cid);
    if (s !== undefined) return s;
    for (const [a, b, v] of ranges) if (cid >= a && cid <= b) return v;
    return undefined;
  };
}

/** Parse a CID /W2 array into a cid → w1 lookup (vertical advance). */
function parseCidW2(w2: PDFArray | undefined, resolve: Resolver): (cid: number) => number | undefined {
  const single = new Map<number, number>();
  const ranges: Array<[number, number, number]> = [];
  if (w2) {
    const items = w2.asArray().map((x) => resolve(x));
    let i = 0;
    while (i < items.length) {
      const first = numOf(items[i]);
      const next = items[i + 1];
      if (first === undefined) {
        i++;
        continue;
      }
      if (next instanceof PDFArray) {
        // c [w1 vx vy  w1 vx vy ...]
        const vals = numberArray(next, resolve);
        for (let k = 0; k * 3 < vals.length; k++) {
          const w1 = vals[k * 3];
          if (Number.isFinite(w1)) single.set(first + k, w1);
        }
        i += 2;
      } else {
        const last = numOf(next);
        const w1 = numOf(items[i + 2]);
        if (last !== undefined && w1 !== undefined) ranges.push([first, last, w1]);
        i += 5;
      }
    }
  }
  return (cid) => {
    const s = single.get(cid);
    if (s !== undefined) return s;
    for (const [a, b, v] of ranges) if (cid >= a && cid <= b) return v;
    return undefined;
  };
}

function type0Font(dict: PDFDict): FontInfo {
  const resolve = resolverFor(dict);
  const cmap = loadCMap(get(dict, 'Encoding'));
  const descArr = get(dict, 'DescendantFonts');
  const desc = descArr instanceof PDFArray ? resolve(descArr.get(0)) : undefined;
  const cidFont = desc instanceof PDFDict ? desc : undefined;

  const dw = numOf(get(cidFont, 'DW')) ?? 1000;
  const wObj = get(cidFont, 'W');
  const widthOfCid = parseCidWidths(wObj instanceof PDFArray ? wObj : undefined, resolve);

  const dw2 = get(cidFont, 'DW2');
  const dw2Arr = dw2 instanceof PDFArray ? numberArray(dw2, resolve) : [];
  const defaultW1 = Number.isFinite(dw2Arr[1]) ? dw2Arr[1] : -1000;
  const w2Obj = get(cidFont, 'W2');
  const w1OfCid = parseCidW2(w2Obj instanceof PDFArray ? w2Obj : undefined, resolve);

  const ranges = cmap.ranges;
  return {
    kind: 'type0',
    vertical: cmap.vertical,
    widthScale: 0.001,
    splitCodes: ranges ? (b) => splitWithRanges(b, ranges) : splitTwoByte,
    width(code) {
      const cid = cmap.cidOf(code);
      if (cid < 0) return dw;
      return widthOfCid(cid) ?? dw;
    },
    verticalAdvance(code) {
      const cid = cmap.cidOf(code);
      if (cid < 0) return defaultW1;
      return w1OfCid(cid) ?? defaultW1;
    },
  };
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/** Metrics used when a font cannot be resolved: 1-byte codes, 500 units wide. */
export const FALLBACK_FONT: FontInfo = {
  kind: 'unknown',
  vertical: false,
  widthScale: 0.001,
  splitCodes: splitSingleByte,
  width: () => 500,
  verticalAdvance: () => -1000,
};

const fontInfoCache = new WeakMap<PDFDict, FontInfo>();

/** Build (and cache per font dictionary) the metrics for a font resource. */
export function loadFontInfo(fontDict: PDFObject | undefined): FontInfo {
  if (!(fontDict instanceof PDFDict)) return FALLBACK_FONT;
  const cached = fontInfoCache.get(fontDict);
  if (cached) return cached;
  let info: FontInfo;
  try {
    const subtype = nameOf(get(fontDict, 'Subtype'));
    if (subtype === 'Type0') info = type0Font(fontDict);
    else info = simpleFont(fontDict, subtype === 'Type3');
  } catch {
    info = FALLBACK_FONT;
  }
  fontInfoCache.set(fontDict, info);
  return info;
}

/** Decode a PDF string object (literal or hex) to raw bytes. */
export function pdfStringBytes(o: PDFObject | undefined): Uint8Array | undefined {
  if (o instanceof PDFString || o instanceof PDFHexString) return o.asBytes();
  return undefined;
}
