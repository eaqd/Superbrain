/**
 * "Reduce file size / Optimize PDF".
 *
 * Pipeline (all in memory, pdf-lib object model):
 *  1. load (decrypting with the given / empty password when encrypted);
 *  2. optionally strip metadata (Info, XMP /Metadata streams, page /Thumb, /PieceInfo);
 *  3. garbage-collect objects unreachable from the trailer (also drops the
 *     original object/xref streams pdf-lib keeps around after parsing);
 *  4. merge byte-identical images / embedded font files / ICC profiles;
 *  5. measure how large every image XObject is drawn (pages, Form XObjects
 *     recursively, annotation appearances) → effective DPI;
 *  6. recompress images (DCT via the injected codec, 8-bit Flate/LZW/raw
 *     DeviceGray/DeviceRGB/ICC(1|3)/Cal*), downsampling with an area-average
 *     filter above `maxDpi`; a replacement is written in place (same object
 *     number) only when it is smaller;
 *  7. losslessly Flate-encode unfiltered streams and replace ASCII/LZW/RunLength
 *     encodings by Flate;
 *  8. GC again and save with object streams.
 * The result is never larger than the input (the input is returned instead).
 *
 * No DOM dependency: JPEG decoding/encoding is injected through `ImageCodec`.
 */
import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
  decodePDFRawStream,
  type PDFContext,
  type PDFObject,
  type PDFPage,
} from '@cantoo/pdf-lib';
import { unzlibSync, zlibSync } from 'fflate';
import { getStreamBytes, parseContentStream } from '../engine/contentStream';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ImageCodec {
  /**
   * Decode JPEG bytes (as stored in the PDF for DCTDecode) to RGBA. Must NOT
   * apply EXIF orientation or colour management (in browsers use
   * createImageBitmap(blob, { imageOrientation: 'none', colorSpaceConversion: 'none',
   * premultiplyAlpha: 'none' })); images whose decoded size differs from the
   * JPEG frame size are skipped.
   */
  decode(bytes: Uint8Array, mime: 'image/jpeg'): Promise<{ width: number; height: number; data: Uint8ClampedArray }>;
  /** Encode RGBA to JPEG at quality 0..1 (alpha is ignored; pixels are opaque). */
  encodeJpeg(rgba: { width: number; height: number; data: Uint8ClampedArray }, quality: number): Promise<Uint8Array>;
}

export interface CompressOptions {
  /** JPEG quality for re-encoded images, 0..1 (e.g. 0.85 high, 0.7 balanced, 0.5 small). */
  quality: number;
  /**
   * Downsample images whose effective resolution exceeds this DPI (null = never).
   * Effective DPI comes from the largest size the image is drawn at (CTM at the
   * Do operator). Images exceeding it by less than 5% are left at full size.
   */
  maxDpi: number | null;
  /** Convert colour images to gray. */
  grayscale?: boolean;
  /** Drop Info dict + XMP /Metadata streams, page /Thumb, /PieceInfo. */
  removeMetadata?: boolean;
  /** Password to open encrypted input. The output is saved unencrypted. */
  password?: string;
  onProgress?: (msg: string) => void;
}

export interface CompressReport {
  before: number;
  after: number;
  /** Image XObjects in the document (soft masks / stencil masks of other images not counted). */
  imagesTotal: number;
  /** Images replaced by a smaller encoding. */
  imagesRecompressed: number;
  /** imagesTotal − imagesRecompressed (unsupported encoding/colour space, or no gain). */
  imagesSkipped: number;
  /** Of the recompressed images, how many were downsampled. */
  imagesDownsampled?: number;
  /** Non-image streams re-encoded losslessly with Flate. */
  streamsCompressed?: number;
  /** Duplicate images / font files / ICC profiles merged. */
  duplicatesMerged?: number;
  /** Unreachable objects removed. */
  objectsRemoved?: number;
  /** The input was encrypted; the output is not. */
  encryptionRemoved?: boolean;
  /** True when the optimized file was not smaller and the input was returned unchanged. */
  unchanged?: boolean;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function compressPdf(
  bytes: Uint8Array,
  opts: CompressOptions,
  codec: ImageCodec,
): Promise<{ bytes: Uint8Array; report: CompressReport }> {
  const before = bytes.length;
  const progress = (msg: string) => {
    try {
      opts.onProgress?.(msg);
    } catch {
      /* ignore listener errors */
    }
  };
  const quality = clamp(Number.isFinite(opts.quality) ? opts.quality : 0.75, 0.05, 1);
  const maxDpi = opts.maxDpi !== null && Number.isFinite(opts.maxDpi) && opts.maxDpi > 0 ? opts.maxDpi : null;

  const report: CompressReport = {
    before,
    after: before,
    imagesTotal: 0,
    imagesRecompressed: 0,
    imagesSkipped: 0,
    imagesDownsampled: 0,
    streamsCompressed: 0,
    duplicatesMerged: 0,
    objectsRemoved: 0,
    encryptionRemoved: false,
  };

  progress('Opening document…');
  const { doc, wasEncrypted } = await loadDocument(bytes, opts.password);
  report.encryptionRemoved = wasEncrypted;
  const context = doc.context;

  if (opts.removeMetadata) {
    progress('Removing metadata…');
    stripMetadata(context);
  }

  report.objectsRemoved = collectGarbage(context);
  report.duplicatesMerged = dedupeStreams(context);

  progress('Analyzing images…');
  let usage = new Map<PDFRef, ImageUsage>();
  try {
    usage = new UsageScanner(context).scanDocument(doc);
  } catch {
    usage = new Map(); // measurements unavailable: images are recompressed but never downsampled
  }

  const { candidates, refCounts } = findImages(context);
  report.imagesTotal = candidates.length;
  const replaced = new Set<PDFRef>();
  for (let i = 0; i < candidates.length; i++) {
    progress(`Optimizing image ${i + 1} of ${candidates.length}…`);
    const ref = candidates[i];
    try {
      const res = await optimizeImage(context, ref, usage.get(ref), refCounts, { quality, maxDpi, grayscale: !!opts.grayscale }, codec);
      if (res) {
        report.imagesRecompressed++;
        if (res.downsampled) report.imagesDownsampled!++;
        replaced.add(ref);
        if (res.smaskRef) replaced.add(res.smaskRef);
      }
    } catch {
      /* leave the image untouched */
    }
    await tick();
  }
  report.imagesSkipped = report.imagesTotal - report.imagesRecompressed;

  progress('Compressing streams…');
  report.streamsCompressed = recompressStreams(context, replaced);
  report.objectsRemoved += collectGarbage(context);

  progress('Saving…');
  const saveOpts = { addDefaultPage: false, updateFieldAppearances: false, objectsPerTick: 1000 };
  let out: Uint8Array;
  try {
    out = await doc.save({ ...saveOpts, useObjectStreams: true });
  } catch {
    // e.g. PDF/A-1 (XMP kept) forbids object streams: classic xref table instead.
    out = await doc.save({ ...saveOpts, useObjectStreams: false });
  }
  if (out.length >= before) {
    return {
      bytes,
      report: { ...report, after: before, imagesRecompressed: 0, imagesSkipped: report.imagesTotal, imagesDownsampled: 0, encryptionRemoved: false, unchanged: true },
    };
  }
  report.after = out.length;
  return { bytes: out, report };
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/** Thrown when the input is encrypted with a user password and none (or a wrong one) was given. */
export class PdfPasswordError extends Error {
  constructor(readonly incorrect: boolean) {
    super(incorrect ? 'Incorrect password' : 'This PDF is password-protected; a password is required to optimize it');
    this.name = 'PdfPasswordError';
  }
}

async function loadDocument(bytes: Uint8Array, password?: string): Promise<{ doc: PDFDocument; wasEncrypted: boolean }> {
  // parseSpeed: objects parsed between event-loop yields (pdf-lib's default of 100 is slow in browsers).
  const base = { updateMetadata: false, parseSpeed: 2000 } as const;
  if (password !== undefined) {
    try {
      const doc = await PDFDocument.load(bytes, { ...base, password });
      return { doc, wasEncrypted: doc.context.isDecrypted && hasEncryptMarker(bytes) };
    } catch (err) {
      if (isPasswordError(err)) throw new PdfPasswordError(true);
      throw err;
    }
  }
  try {
    const doc = await PDFDocument.load(bytes, base);
    return { doc, wasEncrypted: false };
  } catch (err) {
    if (!isEncryptedError(err)) throw err;
  }
  // Owner-password-only files open with the empty user password.
  try {
    const doc = await PDFDocument.load(bytes, { ...base, password: '' });
    return { doc, wasEncrypted: true };
  } catch (err) {
    if (isPasswordError(err)) throw new PdfPasswordError(false);
    throw err;
  }
}

function isPasswordError(err: unknown): boolean {
  const m = (err as { message?: string } | null)?.message ?? '';
  return /password/i.test(m);
}

function isEncryptedError(err: unknown): boolean {
  const e = err as { name?: string; message?: string } | null;
  return !!e && (e.name === 'EncryptedPDFError' || /encrypt/i.test(e.message ?? ''));
}

function hasEncryptMarker(bytes: Uint8Array): boolean {
  // Cheap check used only for reporting.
  const needle = [0x2f, 0x45, 0x6e, 0x63, 0x72, 0x79, 0x70, 0x74]; // "/Encrypt"
  outer: for (let i = bytes.length - needle.length; i >= 0; i--) {
    for (let k = 0; k < needle.length; k++) if (bytes[i + k] !== needle[k]) continue outer;
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Small PDF helpers
// ---------------------------------------------------------------------------

type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
const N = (s: string) => PDFName.of(s);

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}

function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

function lookup(context: PDFContext, o: PDFObject | undefined): PDFObject | undefined {
  if (o === undefined) return undefined;
  try {
    return context.lookup(o);
  } catch {
    return undefined;
  }
}

function dictGet(dict: PDFDict | undefined, key: string): PDFObject | undefined {
  if (!dict) return undefined;
  return lookup(dict.context, dict.get(N(key)));
}

function numVal(o: PDFObject | undefined): number | undefined {
  return o instanceof PDFNumber ? o.asNumber() : undefined;
}

function nameVal(o: PDFObject | undefined): string | undefined {
  return o instanceof PDFName ? o.decodeText() : undefined;
}

function numArray(context: PDFContext, o: PDFObject | undefined): number[] | undefined {
  const arr = lookup(context, o);
  if (!(arr instanceof PDFArray)) return undefined;
  const out: number[] = [];
  for (let i = 0; i < arr.size(); i++) {
    const v = numVal(lookup(context, arr.get(i)));
    if (v === undefined) return undefined;
    out.push(v);
  }
  return out;
}

/** m × n: apply m first, then n. */
function mul(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

/** Largest singular value of the linear part. */
function maxScale(m: Matrix): number {
  const s = m[0] * m[0] + m[1] * m[1] + m[2] * m[2] + m[3] * m[3];
  const det = m[0] * m[3] - m[1] * m[2];
  return Math.sqrt(Math.max(0, (s + Math.sqrt(Math.max(0, s * s - 4 * det * det))) / 2));
}

function filterList(context: PDFContext, dict: PDFDict): { names: string[]; parms: Array<PDFDict | undefined> } | null {
  const f = lookup(context, dict.get(N('Filter')));
  const names: string[] = [];
  if (f instanceof PDFName) names.push(f.decodeText());
  else if (f instanceof PDFArray) {
    for (let i = 0; i < f.size(); i++) {
      const n = nameVal(lookup(context, f.get(i)));
      if (!n) return null;
      names.push(n);
    }
  } else if (f !== undefined) return null;
  const p = lookup(context, dict.get(N('DecodeParms')));
  const parms = names.map((_, i) => {
    const v = p instanceof PDFArray ? lookup(context, p.get(i)) : i === 0 ? p : undefined;
    return v instanceof PDFDict ? v : undefined;
  });
  return { names, parms };
}

/** Concatenated, decoded page content (array of streams or single stream). */
function readContents(context: PDFContext, contents: PDFObject | undefined): Uint8Array {
  const obj = lookup(context, contents);
  const parts: Uint8Array[] = [];
  if (obj instanceof PDFStream) parts.push(getStreamBytes(obj));
  else if (obj instanceof PDFArray) {
    for (let i = 0; i < obj.size(); i++) {
      const s = lookup(context, obj.get(i));
      if (s instanceof PDFStream) {
        try {
          parts.push(getStreamBytes(s));
        } catch {
          /* skip broken part */
        }
      }
    }
  }
  let len = 0;
  for (const p of parts) len += p.length + 1;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
    out[o++] = 0x0a;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Garbage collection / metadata / dedup
// ---------------------------------------------------------------------------

/** Delete indirect objects not reachable from the trailer (Root, Info, Encrypt). Returns the count. */
function collectGarbage(context: PDFContext): number {
  const reachable = new Set<PDFRef>();
  const stack: PDFObject[] = [];
  const t = context.trailerInfo;
  for (const v of [t.Root, t.Info, t.Encrypt]) if (v) stack.push(v);
  while (stack.length) {
    const o = stack.pop()!;
    if (o instanceof PDFRef) {
      if (reachable.has(o)) continue;
      reachable.add(o);
      const target = lookup(context, o);
      if (target) stack.push(target);
    } else if (o instanceof PDFDict) {
      for (const v of o.values()) stack.push(v);
    } else if (o instanceof PDFArray) {
      for (const v of o.asArray()) stack.push(v);
    } else if (o instanceof PDFStream) {
      stack.push(o.dict);
    }
  }
  let removed = 0;
  for (const [ref] of context.enumerateIndirectObjects()) {
    if (!reachable.has(ref)) {
      context.delete(ref);
      removed++;
    }
  }
  return removed;
}

function stripMetadata(context: PDFContext): void {
  context.trailerInfo.Info = undefined;
  for (const [, obj] of context.enumerateIndirectObjects()) {
    const dict = obj instanceof PDFDict ? obj : obj instanceof PDFStream ? obj.dict : undefined;
    if (!dict) continue;
    dict.delete(N('PieceInfo'));
    if (lookup(context, dict.get(N('Metadata'))) instanceof PDFStream) dict.delete(N('Metadata'));
    if (nameVal(dictGet(dict, 'Type')) === 'Page') dict.delete(N('Thumb'));
  }
}

/** Replace PDFRef occurrences inside direct containers according to `map`. */
function rewriteRefs(obj: PDFObject, map: Map<PDFRef, PDFRef>, depth = 0): void {
  if (depth > 64) return;
  if (obj instanceof PDFDict) {
    for (const [k, v] of obj.entries()) {
      if (v instanceof PDFRef) {
        const r = map.get(v);
        if (r) obj.set(k, r);
      } else if (v instanceof PDFDict || v instanceof PDFArray) rewriteRefs(v, map, depth + 1);
    }
  } else if (obj instanceof PDFArray) {
    for (let i = 0; i < obj.size(); i++) {
      const v = obj.get(i);
      if (v instanceof PDFRef) {
        const r = map.get(v);
        if (r) obj.set(i, r);
      } else if (v instanceof PDFDict || v instanceof PDFArray) rewriteRefs(v, map, depth + 1);
    }
  } else if (obj instanceof PDFStream) rewriteRefs(obj.dict, map, depth + 1);
}

function fnv1a(bytes: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function dictSignature(dict: PDFDict): string {
  return dict
    .entries()
    .filter(([k]) => k !== PDFName.Length)
    .map(([k, v]) => `${k.toString()} ${v.toString()}`)
    .sort()
    .join(' ');
}

/**
 * Merge byte-identical image XObjects, embedded font files and ICC profiles
 * (common after merging documents). Content streams and forms are never merged
 * so that editing one page can't affect another.
 */
function dedupeStreams(context: PDFContext): number {
  let merged = 0;
  for (let pass = 0; pass < 3; pass++) {
    const candidates = new Set<PDFRef>();
    for (const [ref, obj] of context.enumerateIndirectObjects()) {
      if (obj instanceof PDFRawStream && nameVal(dictGet(obj.dict, 'Subtype')) === 'Image') candidates.add(ref);
      else if (obj instanceof PDFDict) {
        for (const key of ['FontFile', 'FontFile2', 'FontFile3']) {
          const v = obj.get(N(key));
          if (v instanceof PDFRef) candidates.add(v);
        }
      }
      // ICC profiles: [/ICCBased ref] arrays, direct or indirect.
      const scanArr = (a: PDFObject | undefined) => {
        if (a instanceof PDFArray && a.size() === 2 && a.get(0) === N('ICCBased') && a.get(1) instanceof PDFRef) {
          candidates.add(a.get(1) as PDFRef);
        }
      };
      scanArr(obj);
      if (obj instanceof PDFDict || obj instanceof PDFStream) {
        const d = obj instanceof PDFStream ? obj.dict : obj;
        scanArr(d.get(N('ColorSpace')));
        const csDict = d.get(N('ColorSpace'));
        if (csDict instanceof PDFDict) for (const v of csDict.values()) scanArr(v);
      }
    }
    const groups = new Map<string, PDFRef[]>();
    for (const ref of candidates) {
      const s = lookup(context, ref);
      if (!(s instanceof PDFRawStream)) continue;
      const key = `${s.contents.length}:${fnv1a(s.contents)}:${dictSignature(s.dict)}`;
      const g = groups.get(key);
      if (g) g.push(ref);
      else groups.set(key, [ref]);
    }
    const map = new Map<PDFRef, PDFRef>();
    for (const refs of groups.values()) {
      if (refs.length < 2) continue;
      const keep = refs[0];
      const ks = lookup(context, keep) as PDFRawStream;
      for (let i = 1; i < refs.length; i++) {
        const s = lookup(context, refs[i]) as PDFRawStream;
        if (bytesEqual(ks.contents, s.contents)) map.set(refs[i], keep);
      }
    }
    if (!map.size) break;
    for (const [, obj] of context.enumerateIndirectObjects()) rewriteRefs(obj, map);
    for (const dup of map.keys()) context.delete(dup);
    merged += map.size;
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Image usage (effective DPI)
// ---------------------------------------------------------------------------

interface ImageUsage {
  /** Largest drawn width / height in points over all measured draws. */
  wPt: number;
  hPt: number;
  measured: boolean;
  /** Drawn somewhere its size can't be determined (patterns, Type3 glyphs, soft-mask groups, unparsable forms). */
  unmeasurable: boolean;
}

/**
 * A draw of an image in some coordinate space: `m` maps the unit square into
 * that space. When `bound` is set, `m` holds only scalar upper bounds of the
 * drawn width/height (m[0], m[3]) — used to keep huge nested-form expansions small.
 */
interface Draw {
  ref: PDFRef;
  m: Matrix;
  bound?: boolean;
}

const MAX_FORM_DRAWS = 4096;

function compose(d: Draw, c: Matrix): Draw {
  if (d.bound) {
    const s = maxScale(c);
    return { ref: d.ref, m: [d.m[0] * s, 0, 0, d.m[3] * s, 0, 0], bound: true };
  }
  return { ref: d.ref, m: mul(d.m, c) };
}

function drawSize(d: Draw): [number, number] {
  if (d.bound) return [Math.abs(d.m[0]), Math.abs(d.m[3])];
  return [Math.hypot(d.m[0], d.m[1]), Math.hypot(d.m[2], d.m[3])];
}

class UsageScanner {
  readonly usage = new Map<PDFRef, ImageUsage>();
  private readonly formCache = new Map<PDFRef, Draw[]>();
  private readonly auxDone = new Set<PDFObject>();

  constructor(private readonly context: PDFContext) {}

  scanDocument(doc: PDFDocument): Map<PDFRef, ImageUsage> {
    for (const page of doc.getPages()) {
      try {
        this.scanPage(page);
      } catch {
        /* a broken page only loses measurements */
      }
    }
    return this.usage;
  }

  private entry(ref: PDFRef): ImageUsage {
    let u = this.usage.get(ref);
    if (!u) {
      u = { wPt: 0, hPt: 0, measured: false, unmeasurable: false };
      this.usage.set(ref, u);
    }
    return u;
  }

  private record(d: Draw): void {
    const [w, h] = drawSize(d);
    if (!Number.isFinite(w) || !Number.isFinite(h)) {
      this.entry(d.ref).unmeasurable = true;
      return;
    }
    if (w < 0.01 || h < 0.01) return; // invisible
    const u = this.entry(d.ref);
    u.measured = true;
    u.wPt = Math.max(u.wPt, w);
    u.hPt = Math.max(u.hPt, h);
  }

  private markUnmeasurable(draws: Draw[]): void {
    for (const d of draws) this.entry(d.ref).unmeasurable = true;
  }

  private scanPage(page: PDFPage): void {
    const node = page.node;
    const res = node.Resources();
    const content = readContents(this.context, node.get(N('Contents')));
    for (const d of this.walk(content, res, new Set())) this.record(d);

    const annots = lookup(this.context, node.get(N('Annots')));
    if (!(annots instanceof PDFArray)) return;
    for (let i = 0; i < annots.size(); i++) {
      const annot = lookup(this.context, annots.get(i));
      if (!(annot instanceof PDFDict)) continue;
      const ap = dictGet(annot, 'AP');
      if (!(ap instanceof PDFDict)) continue;
      const rect = numArray(this.context, annot.get(N('Rect')));
      for (const key of ['N', 'R', 'D']) {
        const raw = ap.get(N(key));
        const v = lookup(this.context, raw);
        const forms: Array<[PDFRef, PDFStream]> = [];
        if (v instanceof PDFStream && raw instanceof PDFRef) forms.push([raw, v]);
        else if (v instanceof PDFDict) {
          for (const sv of v.values()) {
            const s = lookup(this.context, sv);
            if (s instanceof PDFStream && sv instanceof PDFRef) forms.push([sv, s]);
          }
        }
        for (const [ref, stream] of forms) {
          const draws = this.formDraws(ref, stream, res, new Set());
          const A = rect && rect.length === 4 ? this.appearanceMatrix(stream, rect) : null;
          if (!A) this.markUnmeasurable(draws);
          else for (const d of draws) this.record(compose(d, A));
        }
      }
    }
  }

  /** Matrix A (ISO 32000 12.5.5) mapping the transformed appearance BBox onto the annotation Rect. */
  private appearanceMatrix(form: PDFStream, rect: number[]): Matrix | null {
    const bbox = numArray(this.context, form.dict.get(N('BBox')));
    if (!bbox || bbox.length !== 4) return null;
    const mArr = numArray(this.context, form.dict.get(N('Matrix')));
    const m: Matrix = mArr && mArr.length === 6 ? (mArr as Matrix) : IDENTITY;
    const pts = [
      [bbox[0], bbox[1]],
      [bbox[2], bbox[1]],
      [bbox[2], bbox[3]],
      [bbox[0], bbox[3]],
    ].map(([x, y]) => [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]]);
    const tx0 = Math.min(...pts.map((p) => p[0])), tx1 = Math.max(...pts.map((p) => p[0]));
    const ty0 = Math.min(...pts.map((p) => p[1])), ty1 = Math.max(...pts.map((p) => p[1]));
    const rx0 = Math.min(rect[0], rect[2]), rx1 = Math.max(rect[0], rect[2]);
    const ry0 = Math.min(rect[1], rect[3]), ry1 = Math.max(rect[1], rect[3]);
    if (tx1 - tx0 < 1e-9 || ty1 - ty0 < 1e-9) return null;
    const sx = (rx1 - rx0) / (tx1 - tx0);
    const sy = (ry1 - ry0) / (ty1 - ty0);
    return [sx, 0, 0, sy, rx0 - tx0 * sx, ry0 - ty0 * sy];
  }

  /** Image draws of a content stream, in its own coordinate space. */
  private walk(bytes: Uint8Array, res: PDFDict | undefined, stack: Set<PDFRef>): Draw[] {
    if (res) this.scanAux(res, stack);
    const xobjects = res ? dictGet(res, 'XObject') : undefined;
    const xo = xobjects instanceof PDFDict && xobjects.keys().length ? xobjects : undefined;
    if (!xo) return []; // nothing this content could draw (Do needs an XObject resource)
    const draws: Draw[] = [];
    let ctm: Matrix = IDENTITY;
    const saved: Matrix[] = [];
    for (const op of parseContentStream(bytes)) {
      switch (op.op) {
        case 'q':
          saved.push(ctm);
          break;
        case 'Q':
          if (saved.length) ctm = saved.pop()!;
          break;
        case 'cm': {
          const v = op.operands.map((o) => (o.type === 'number' ? o.value : NaN));
          if (v.length === 6 && v.every(Number.isFinite)) ctm = mul(v as Matrix, ctm);
          break;
        }
        case 'Do': {
          const nm = op.operands[0];
          if (!xo || !nm || nm.type !== 'name') break;
          const raw = xo.get(N(nm.value));
          if (!(raw instanceof PDFRef)) break;
          const obj = lookup(this.context, raw);
          if (!(obj instanceof PDFStream)) break;
          const subtype = nameVal(dictGet(obj.dict, 'Subtype'));
          if (subtype === 'Image') draws.push({ ref: raw, m: ctm });
          else if (subtype === 'Form') {
            for (const d of this.formDraws(raw, obj, res, stack)) draws.push(compose(d, ctm));
          }
          break;
        }
      }
    }
    return draws.length > MAX_FORM_DRAWS ? collapse(draws) : draws;
  }

  /** Draws of a Form XObject in the space it is painted into (its /Matrix applied). */
  private formDraws(ref: PDFRef, stream: PDFStream, parentRes: PDFDict | undefined, stack: Set<PDFRef>): Draw[] {
    const cached = this.formCache.get(ref);
    if (cached) return cached;
    if (stack.has(ref)) return [];
    const ownRes = dictGet(stream.dict, 'Resources');
    const res = ownRes instanceof PDFDict ? ownRes : parentRes;
    const mArr = numArray(this.context, stream.dict.get(N('Matrix')));
    const matrix: Matrix = mArr && mArr.length === 6 ? (mArr as Matrix) : IDENTITY;
    stack.add(ref);
    let result: Draw[];
    try {
      const inner = this.walk(getStreamBytes(stream), res, stack);
      result = inner.map((d) => compose(d, matrix));
    } catch {
      // Unparsable form: images it may draw can't be measured.
      result = [];
      const xo = res ? dictGet(res, 'XObject') : undefined;
      if (xo instanceof PDFDict) {
        for (const v of xo.values()) if (v instanceof PDFRef) this.entry(v).unmeasurable = true;
      }
    } finally {
      stack.delete(ref);
    }
    if (ownRes instanceof PDFDict) this.formCache.set(ref, result); // inherited resources: don't cache
    return result;
  }

  /**
   * Content painted outside the normal CTM flow (tiling patterns, Type3 glyphs,
   * soft-mask groups): images found there are marked unmeasurable.
   */
  private scanAux(res: PDFDict, stack: Set<PDFRef>): void {
    if (this.auxDone.has(res)) return;
    this.auxDone.add(res);
    const visit = (raw: PDFObject | undefined, fallbackRes: PDFDict | undefined) => {
      const s = lookup(this.context, raw);
      if (!(s instanceof PDFStream) || this.auxDone.has(s)) return;
      this.auxDone.add(s);
      const own = dictGet(s.dict, 'Resources');
      try {
        this.markUnmeasurable(this.walk(getStreamBytes(s), own instanceof PDFDict ? own : fallbackRes, stack));
      } catch {
        /* ignore */
      }
    };
    const patterns = dictGet(res, 'Pattern');
    if (patterns instanceof PDFDict) for (const v of patterns.values()) visit(v, undefined);
    const fonts = dictGet(res, 'Font');
    if (fonts instanceof PDFDict) {
      for (const v of fonts.values()) {
        const f = lookup(this.context, v);
        if (!(f instanceof PDFDict) || nameVal(dictGet(f, 'Subtype')) !== 'Type3') continue;
        const fr = dictGet(f, 'Resources');
        const procs = dictGet(f, 'CharProcs');
        if (procs instanceof PDFDict) for (const p of procs.values()) visit(p, fr instanceof PDFDict ? fr : res);
      }
    }
    const gstates = dictGet(res, 'ExtGState');
    if (gstates instanceof PDFDict) {
      for (const v of gstates.values()) {
        const gs = lookup(this.context, v);
        const sm = gs instanceof PDFDict ? dictGet(gs, 'SMask') : undefined;
        if (sm instanceof PDFDict) visit(sm.get(N('G')), res);
      }
    }
  }
}

/** Collapse many draws into one bounding draw per image (upper bounds of width/height). */
function collapse(draws: Draw[]): Draw[] {
  const by = new Map<PDFRef, [number, number]>();
  for (const d of draws) {
    const [w, h] = drawSize(d);
    const cur = by.get(d.ref);
    if (!cur) by.set(d.ref, [w, h]);
    else {
      cur[0] = Math.max(cur[0], w);
      cur[1] = Math.max(cur[1], h);
    }
  }
  return [...by.entries()].map(([ref, [w, h]]) => ({ ref, m: [w, 0, 0, h, 0, 0] as Matrix, bound: true }));
}

// ---------------------------------------------------------------------------
// Image candidates
// ---------------------------------------------------------------------------

function findImages(context: PDFContext): { candidates: PDFRef[]; refCounts: Map<PDFRef, number> } {
  const refCounts = new Map<PDFRef, number>();
  const masks = new Set<PDFRef>();
  const images: PDFRef[] = [];
  const count = (o: PDFObject, depth: number) => {
    if (depth > 64) return;
    if (o instanceof PDFRef) refCounts.set(o, (refCounts.get(o) ?? 0) + 1);
    else if (o instanceof PDFDict) for (const v of o.values()) count(v, depth + 1);
    else if (o instanceof PDFArray) for (const v of o.asArray()) count(v, depth + 1);
    else if (o instanceof PDFStream) count(o.dict, depth + 1);
  };
  for (const [ref, obj] of context.enumerateIndirectObjects()) {
    count(obj, 0);
    if (obj instanceof PDFStream && nameVal(dictGet(obj.dict, 'Subtype')) === 'Image') {
      images.push(ref);
      for (const key of ['SMask', 'Mask']) {
        const v = obj.dict.get(N(key));
        if (v instanceof PDFRef) masks.add(v);
      }
    }
  }
  return { candidates: images.filter((r) => !masks.has(r)), refCounts };
}

// ---------------------------------------------------------------------------
// Image decoding
// ---------------------------------------------------------------------------

const LOSSLESS = new Set(['FlateDecode', 'LZWDecode', 'ASCIIHexDecode', 'ASCII85Decode', 'RunLengthDecode']);
const MAX_PIXELS = 40_000_000;

interface ColorInfo {
  kind: 'gray' | 'rgb';
  ncomp: 1 | 3;
  /** The original /ColorSpace value (reused when the output keeps the same components). */
  obj: PDFObject;
}

function resolveColor(context: PDFContext, raw: PDFObject | undefined): ColorInfo | null {
  const o = lookup(context, raw);
  if (!o || !raw) return null;
  if (o instanceof PDFName) {
    switch (o.decodeText()) {
      case 'DeviceGray':
      case 'CalGray':
        return { kind: 'gray', ncomp: 1, obj: raw };
      case 'DeviceRGB':
      case 'CalRGB':
        return { kind: 'rgb', ncomp: 3, obj: raw };
      default:
        return null;
    }
  }
  if (!(o instanceof PDFArray) || o.size() < 1) return null;
  switch (nameVal(lookup(context, o.get(0)))) {
    case 'ICCBased': {
      const s = lookup(context, o.get(1));
      const n = s instanceof PDFStream ? numVal(dictGet(s.dict, 'N')) : undefined;
      if (n === 1) return { kind: 'gray', ncomp: 1, obj: raw };
      if (n === 3) return { kind: 'rgb', ncomp: 3, obj: raw };
      return null;
    }
    case 'CalGray':
      return { kind: 'gray', ncomp: 1, obj: raw };
    case 'CalRGB':
      return { kind: 'rgb', ncomp: 3, obj: raw };
    case 'DeviceGray':
      return { kind: 'gray', ncomp: 1, obj: raw };
    case 'DeviceRGB':
      return { kind: 'rgb', ncomp: 3, obj: raw };
    default:
      return null; // Indexed, CMYK, Lab, Separation, DeviceN, ICC N=4...
  }
}

function hasPredictor(p: PDFDict | undefined): boolean {
  return !!p && (numVal(dictGet(p, 'Predictor')) ?? 1) > 1;
}

/** Undo PNG (10..15) / TIFF (2) predictors for 8-bit data. Null when unsupported. */
function unpredict(data: Uint8Array, parms: PDFDict | undefined): Uint8Array | null {
  if (!parms) return data;
  const predictor = numVal(dictGet(parms, 'Predictor')) ?? 1;
  if (predictor <= 1) return data;
  const colors = numVal(dictGet(parms, 'Colors')) ?? 1;
  const bpc = numVal(dictGet(parms, 'BitsPerComponent')) ?? 8;
  const columns = numVal(dictGet(parms, 'Columns')) ?? 1;
  if (colors < 1 || columns < 1 || ![1, 2, 4, 8, 16].includes(bpc)) return null;
  const rowLen = Math.ceil((colors * bpc * columns) / 8);
  if (predictor === 2) {
    if (bpc !== 8) return null;
    const out = data.slice();
    for (let base = 0; base < out.length; base += rowLen) {
      for (let i = colors; i < rowLen && base + i < out.length; i++) out[base + i] = (out[base + i] + out[base + i - colors]) & 0xff;
    }
    return out;
  }
  if (predictor < 10) return null;
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rows = Math.floor(data.length / (rowLen + 1));
  const out = new Uint8Array(rows * rowLen);
  for (let row = 0; row < rows; row++) {
    const src = row * (rowLen + 1);
    const type = data[src];
    const dst = row * rowLen;
    const prev = dst - rowLen;
    for (let i = 0; i < rowLen; i++) {
      const x = data[src + 1 + i];
      const left = i >= bpp ? out[dst + i - bpp] : 0;
      const up = row > 0 ? out[prev + i] : 0;
      let v: number;
      switch (type) {
        case 1:
          v = x + left;
          break;
        case 2:
          v = x + up;
          break;
        case 3:
          v = x + ((left + up) >> 1);
          break;
        case 4: {
          const upLeft = row > 0 && i >= bpp ? out[prev + i - bpp] : 0;
          const p = left + up - upLeft;
          const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - upLeft);
          v = x + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
          break;
        }
        default:
          v = x;
      }
      out[dst + i] = v & 0xff;
    }
  }
  return out;
}

/** Decode a losslessly encoded stream (Flate, LZW, ASCIIHex, ASCII85, RunLength; predictor on the last filter). */
function decodeLossless(context: PDFContext, stream: PDFRawStream): Uint8Array | null {
  const fl = filterList(context, stream.dict);
  if (!fl) return null;
  const { names, parms } = fl;
  if (!names.length) return stream.contents;
  if (!names.every((n) => LOSSLESS.has(n))) return null;
  for (let i = 0; i < names.length - 1; i++) if (hasPredictor(parms[i])) return null;
  let raw: Uint8Array;
  if (names.length === 1 && names[0] === 'FlateDecode') {
    try {
      raw = unzlibSync(stream.contents);
    } catch {
      raw = decodePDFRawStream(stream).decode();
    }
  } else raw = decodePDFRawStream(stream).decode();
  const last = names[names.length - 1];
  const lp = parms[parms.length - 1];
  if ((last === 'FlateDecode' || last === 'LZWDecode') && hasPredictor(lp)) return unpredict(raw, lp);
  if (hasPredictor(lp)) return null;
  return raw;
}

interface JpegInfo {
  width: number;
  height: number;
  ncomp: number;
  precision: number;
}

/** Frame header (SOFn) of a JPEG stream. */
function jpegInfo(b: Uint8Array): JpegInfo | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = b[i + 1];
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    const len = (b[i + 2] << 8) | b[i + 3];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (len < 8 || i + 2 + len > b.length) return null;
      return {
        precision: b[i + 4],
        height: (b[i + 5] << 8) | b[i + 6],
        width: (b[i + 7] << 8) | b[i + 8],
        ncomp: b[i + 9],
      };
    }
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

/**
 * Remove APP1..APP13 and APP15 segments (EXIF incl. orientation, ICC profiles,
 * XMP, Photoshop data) before handing a JPEG to a platform decoder: PDF viewers
 * ignore them, but browsers would rotate (EXIF) or colour-convert (ICC) the
 * pixels. APP0 (JFIF) and APP14 (Adobe colour transform) are kept.
 */
function stripJpegMetadata(b: Uint8Array): Uint8Array {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return b;
  const keep: Array<[number, number]> = [];
  let from = 0;
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return b; // unexpected layout: leave untouched
    const marker = b[i + 1];
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker === 0xda) break; // start of scan: entropy-coded data follows
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = (b[i + 2] << 8) | b[i + 3];
    const end = i + 2 + len;
    if (len < 2 || end > b.length) return b;
    if ((marker >= 0xe1 && marker <= 0xed) || marker === 0xef) {
      keep.push([from, i]);
      from = end;
    }
    i = end;
  }
  if (!keep.length) return b;
  keep.push([from, b.length]);
  let total = 0;
  for (const [s, e] of keep) total += e - s;
  const out = new Uint8Array(total);
  let o = 0;
  for (const [s, e] of keep) {
    out.set(b.subarray(s, e), o);
    o += e - s;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pixel operations
// ---------------------------------------------------------------------------

/** Per-axis area-average weights for shrinking `sn` samples to `dn` (dn <= sn). */
function axisWeights(sn: number, dn: number): { start: Int32Array; count: Int32Array; w: Float32Array; stride: number } {
  const scale = sn / dn;
  const stride = Math.ceil(scale) + 1;
  const start = new Int32Array(dn);
  const count = new Int32Array(dn);
  const w = new Float32Array(dn * stride);
  for (let i = 0; i < dn; i++) {
    const lo = i * scale;
    const hi = Math.min(sn, (i + 1) * scale);
    const j0 = Math.floor(lo);
    const j1 = Math.min(sn, Math.ceil(hi));
    start[i] = j0;
    let c = 0;
    for (let j = j0; j < j1 && c < stride; j++, c++) {
      const overlap = Math.min(hi, j + 1) - Math.max(lo, j);
      w[i * stride + c] = Math.max(0, overlap) / (hi - lo);
    }
    count[i] = c;
  }
  return { start, count, w, stride };
}

/** Area-average (box) resampling of interleaved 8-bit pixels; only shrinks. */
function resampleArea(src: Uint8Array, sw: number, sh: number, nc: number, dw: number, dh: number): Uint8Array {
  if (dw === sw && dh === sh) return src;
  // Horizontal pass (dw × sh), kept as float only when a vertical pass follows.
  let tmp: Float32Array | Uint8Array = src;
  if (dw !== sw) {
    const ax = axisWeights(sw, dw);
    const dst: Float32Array | Uint8Array = dh === sh ? new Uint8Array(dw * sh * nc) : new Float32Array(dw * sh * nc);
    const round = dst instanceof Uint8Array;
    for (let y = 0; y < sh; y++) {
      const srow = y * sw * nc;
      const trow = y * dw * nc;
      for (let x = 0; x < dw; x++) {
        const s0 = ax.start[x];
        const cnt = ax.count[x];
        const wo = x * ax.stride;
        for (let c = 0; c < nc; c++) {
          let acc = 0;
          for (let k = 0; k < cnt; k++) acc += src[srow + (s0 + k) * nc + c] * ax.w[wo + k];
          dst[trow + x * nc + c] = round ? Math.min(255, Math.round(acc)) : acc;
        }
      }
    }
    if (dh === sh) return dst as Uint8Array;
    tmp = dst;
  }
  // Vertical pass.
  const out = new Uint8Array(dw * dh * nc);
  const rowLen = dw * nc;
  const ay = axisWeights(sh, dh);
  const acc = new Float32Array(rowLen);
  for (let y = 0; y < dh; y++) {
    acc.fill(0);
    const s0 = ay.start[y];
    const cnt = ay.count[y];
    const wo = y * ay.stride;
    for (let k = 0; k < cnt; k++) {
      const wk = ay.w[wo + k];
      const trow = (s0 + k) * rowLen;
      for (let i = 0; i < rowLen; i++) acc[i] += tmp[trow + i] * wk;
    }
    const orow = y * rowLen;
    for (let i = 0; i < rowLen; i++) {
      const v = Math.round(acc[i]);
      out[orow + i] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  }
  return out;
}

function toGray(rgb: Uint8Array, count: number): Uint8Array {
  const out = new Uint8Array(count);
  for (let i = 0, j = 0; i < count; i++, j += 3) out[i] = (rgb[j] * 299 + rgb[j + 1] * 587 + rgb[j + 2] * 114 + 500) / 1000;
  return out;
}

function toRgba(px: Uint8Array, w: number, h: number, nc: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0, j = 0, o = 0; i < w * h; i++, j += nc, o += 4) {
    if (nc === 1) {
      out[o] = out[o + 1] = out[o + 2] = px[j];
    } else {
      out[o] = px[j];
      out[o + 1] = px[j + 1];
      out[o + 2] = px[j + 2];
    }
    out[o + 3] = 255;
  }
  return out;
}

/** PNG-predicted (per-row heuristic filter choice) + zlib. Returns data and DecodeParms values. */
function flateWithPredictor(px: Uint8Array, w: number, h: number, nc: number): Uint8Array {
  const rowLen = w * nc;
  const out = new Uint8Array(h * (rowLen + 1));
  const cand = [new Uint8Array(rowLen), new Uint8Array(rowLen), new Uint8Array(rowLen), new Uint8Array(rowLen), new Uint8Array(rowLen)];
  for (let y = 0; y < h; y++) {
    const r = y * rowLen;
    const p = r - rowLen;
    const sums = [0, 0, 0, 0, 0];
    for (let i = 0; i < rowLen; i++) {
      const x = px[r + i];
      const a = i >= nc ? px[r + i - nc] : 0;
      const b = y > 0 ? px[p + i] : 0;
      const c = y > 0 && i >= nc ? px[p + i - nc] : 0;
      const pp = a + b - c;
      const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
      const paeth = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      const v0 = x;
      const v1 = (x - a) & 0xff;
      const v2 = (x - b) & 0xff;
      const v3 = (x - ((a + b) >> 1)) & 0xff;
      const v4 = (x - paeth) & 0xff;
      cand[0][i] = v0;
      cand[1][i] = v1;
      cand[2][i] = v2;
      cand[3][i] = v3;
      cand[4][i] = v4;
      sums[0] += v0 < 128 ? v0 : 256 - v0;
      sums[1] += v1 < 128 ? v1 : 256 - v1;
      sums[2] += v2 < 128 ? v2 : 256 - v2;
      sums[3] += v3 < 128 ? v3 : 256 - v3;
      sums[4] += v4 < 128 ? v4 : 256 - v4;
    }
    let best = 0;
    for (let k = 1; k < 5; k++) if (sums[k] < sums[best]) best = k;
    const o = y * (rowLen + 1);
    out[o] = best;
    out.set(cand[best], o + 1);
  }
  return zlibSync(out, { level: 9 });
}

// ---------------------------------------------------------------------------
// Image optimization
// ---------------------------------------------------------------------------

interface ImageSettings {
  quality: number;
  maxDpi: number | null;
  grayscale: boolean;
}

interface DecodedImage {
  width: number;
  height: number;
  /** Interleaved 8-bit samples, `color.ncomp` per pixel, /Decode already applied. */
  pixels: Uint8Array;
  color: ColorInfo;
  fromJpeg: boolean;
}

async function decodeImage(context: PDFContext, stream: PDFRawStream, codec: ImageCodec): Promise<DecodedImage | null> {
  const dict = stream.dict;
  const W = numVal(dictGet(dict, 'Width'));
  const H = numVal(dictGet(dict, 'Height'));
  if (!W || !H || W < 1 || H < 1 || !Number.isInteger(W) || !Number.isInteger(H) || W * H > MAX_PIXELS) return null;
  const im = dictGet(dict, 'ImageMask');
  if (im instanceof PDFBool && im.asBoolean()) return null;
  if (lookup(context, dict.get(N('Mask'))) instanceof PDFArray) return null; // colour-key masking needs exact colours
  const color = resolveColor(context, dict.get(N('ColorSpace')));
  if (!color) return null;
  const fl = filterList(context, dict);
  if (!fl) return null;
  const nc = color.ncomp;

  // /Decode: honour linear remapping of 8-bit samples.
  const dec = numArray(context, dict.get(N('Decode')));
  let decodeMap: Uint8Array[] | null = null;
  if (dec) {
    if (dec.length < 2 * nc) return null;
    const isDefault = dec.slice(0, 2 * nc).every((v, i) => v === (i % 2 === 0 ? 0 : 1));
    if (!isDefault) {
      decodeMap = [];
      for (let c = 0; c < nc; c++) {
        const lo = dec[2 * c], hi = dec[2 * c + 1];
        const t = new Uint8Array(256);
        for (let v = 0; v < 256; v++) t[v] = clamp(Math.round((lo + (v / 255) * (hi - lo)) * 255), 0, 255);
        decodeMap.push(t);
      }
    }
  }

  let pixels: Uint8Array;
  let width = W, height = H;
  let fromJpeg = false;
  const last = fl.names[fl.names.length - 1];
  if (fl.names.length === 1 && (last === 'DCTDecode' || last === 'DCT')) {
    const p = fl.parms[0];
    if (p && dictGet(p, 'ColorTransform') !== undefined) return null; // decoder can't be told
    const jpeg = stream.contents;
    const info = jpegInfo(jpeg);
    if (!info || info.precision !== 8 || info.ncomp !== nc || info.width < 1 || info.height < 1) return null;
    if (info.width * info.height > MAX_PIXELS) return null;
    const img = await codec.decode(stripJpegMetadata(jpeg), 'image/jpeg');
    if (!img || img.width !== info.width || img.height !== info.height || img.data.length < img.width * img.height * 4) return null;
    width = img.width;
    height = img.height;
    pixels = new Uint8Array(width * height * nc);
    const d = img.data;
    if (nc === 1) for (let i = 0, j = 0; i < pixels.length; i++, j += 4) pixels[i] = d[j];
    else {
      for (let i = 0, j = 0; i < pixels.length; i += 3, j += 4) {
        pixels[i] = d[j];
        pixels[i + 1] = d[j + 1];
        pixels[i + 2] = d[j + 2];
      }
    }
    fromJpeg = true;
  } else {
    if ((numVal(dictGet(dict, 'BitsPerComponent')) ?? 0) !== 8) return null;
    const raw = decodeLossless(context, stream);
    if (!raw || raw.length < W * H * nc) return null;
    pixels = raw.length === W * H * nc ? raw : raw.subarray(0, W * H * nc);
  }

  if (decodeMap) {
    if (pixels.buffer === stream.contents.buffer) pixels = pixels.slice(); // never mutate the source stream
    for (let i = 0; i < pixels.length; i++) pixels[i] = decodeMap[i % nc][pixels[i]];
  }
  return { width, height, pixels, color, fromJpeg };
}

/** Decode an 8-bit gray soft mask (Flate/LZW/raw, no /Decode or /Matte handling needed). */
function decodeSoftMask(context: PDFContext, stream: PDFRawStream): { w: number; h: number; px: Uint8Array } | null {
  const d = stream.dict;
  const w = numVal(dictGet(d, 'Width'));
  const h = numVal(dictGet(d, 'Height'));
  if (!w || !h || !Number.isInteger(w) || !Number.isInteger(h) || w * h > MAX_PIXELS) return null;
  if ((numVal(dictGet(d, 'BitsPerComponent')) ?? 0) !== 8) return null;
  const dec = numArray(context, d.get(N('Decode')));
  if (dec && !(dec[0] === 0 && dec[1] === 1)) return null;
  const raw = decodeLossless(context, stream);
  if (!raw || raw.length < w * h) return null;
  return { w, h, px: raw.subarray(0, w * h) };
}

function newImageDict(orig: PDFDict, w: number, h: number, colorSpace: PDFObject, filter: 'DCTDecode' | 'FlateDecode', parms?: PDFDict): PDFDict {
  const d = orig.clone();
  d.set(N('Width'), PDFNumber.of(w));
  d.set(N('Height'), PDFNumber.of(h));
  d.set(N('BitsPerComponent'), PDFNumber.of(8));
  d.set(N('ColorSpace'), colorSpace);
  d.set(N('Filter'), N(filter));
  if (parms) d.set(N('DecodeParms'), parms);
  else d.delete(N('DecodeParms'));
  d.delete(N('Decode'));
  d.delete(N('DL'));
  d.delete(N('Length'));
  return d;
}

function predictorParms(context: PDFContext, w: number, nc: number): PDFDict {
  return context.obj({ Predictor: 15, Colors: nc, BitsPerComponent: 8, Columns: w });
}

async function optimizeImage(
  context: PDFContext,
  ref: PDFRef,
  use: ImageUsage | undefined,
  refCounts: Map<PDFRef, number>,
  s: ImageSettings,
  codec: ImageCodec,
): Promise<{ downsampled: boolean; smaskRef?: PDFRef } | null> {
  const stream = lookup(context, ref);
  if (!(stream instanceof PDFRawStream)) return null;
  const img = await decodeImage(context, stream, codec);
  if (!img) return null;
  const { width: W, height: H } = img;

  // Target size from the effective resolution.
  let tw = W, th = H;
  if (s.maxDpi && use && use.measured && !use.unmeasurable && use.wPt > 0 && use.hPt > 0) {
    const dpiX = (W * 72) / use.wPt;
    const dpiY = (H * 72) / use.hPt;
    if (dpiX > s.maxDpi * 1.05) tw = Math.max(1, Math.min(W, Math.round((use.wPt * s.maxDpi) / 72)));
    if (dpiY > s.maxDpi * 1.05) th = Math.max(1, Math.min(H, Math.round((use.hPt * s.maxDpi) / 72)));
  }

  // Soft mask. Without /Matte its size is independent of the parent's (both map
  // to the unit square); with /Matte (pre-multiplied colour) it must keep the
  // parent's dimensions and the parent's number of colour components.
  const smaskRaw = stream.dict.get(N('SMask'));
  const smaskRef = smaskRaw instanceof PDFRef ? smaskRaw : undefined;
  const smask = smaskRef ? lookup(context, smaskRef) : undefined;
  const matte = smask instanceof PDFStream && smask.dict.get(N('Matte')) !== undefined;
  let smaskPlan: { stream: PDFRawStream; w: number; h: number; px: Uint8Array } | null = null;
  if (tw !== W || th !== H) {
    if (smask instanceof PDFRawStream && smaskRef) {
      const exclusive = (refCounts.get(smaskRef) ?? 0) === 1;
      const sm = exclusive ? decodeSoftMask(context, smask) : null;
      if (matte && (!sm || sm.w !== W || sm.h !== H)) {
        tw = W; // can't keep the mask aligned: don't downsample
        th = H;
      } else if (sm && (matte || sm.w > tw || sm.h > th)) smaskPlan = { stream: smask, ...sm };
    } else if (smaskRaw !== undefined && smask !== undefined) {
      tw = W; // unexpected /SMask object: be conservative
      th = H;
    }
  }
  const resized = tw !== W || th !== H;

  let px = img.pixels;
  let color = img.color;
  let grayConverted = false;
  if (s.grayscale && color.kind === 'rgb' && !matte) {
    px = toGray(px, W * H);
    color = { kind: 'gray', ncomp: 1, obj: N('DeviceGray') };
    grayConverted = true;
  }
  const nc = color.ncomp;
  if (resized) px = resampleArea(px, W, H, nc, tw, th);
  const changedPixels = resized || grayConverted;

  // Candidate encodings.
  const original = stream.contents.length;
  let best: { bytes: Uint8Array; dict: PDFDict } | null = null;
  try {
    const jpg = await codec.encodeJpeg({ width: tw, height: th, data: toRgba(px, tw, th, nc) }, s.quality);
    const info = jpg ? jpegInfo(jpg) : null;
    const compsOk = matte ? info?.ncomp === img.color.ncomp : info?.ncomp === 1 || info?.ncomp === 3;
    if (info && info.width === tw && info.height === th && compsOk) {
      let cs: PDFObject;
      if (info.ncomp === 1) cs = color.kind === 'gray' ? color.obj : N('DeviceGray');
      else cs = color.kind === 'rgb' ? color.obj : N('DeviceRGB');
      best = { bytes: jpg, dict: newImageDict(stream.dict, tw, th, cs, 'DCTDecode') };
    }
  } catch {
    /* encoder failed: try lossless only */
  }
  if (changedPixels) {
    const z = flateWithPredictor(px, tw, th, nc);
    if (!best || z.length < best.bytes.length) {
      best = { bytes: z, dict: newImageDict(stream.dict, tw, th, color.obj, 'FlateDecode', predictorParms(context, tw, nc)) };
    }
  }
  if (!best) return null;
  // Same-size re-encodes must be clearly worth the generation loss.
  const threshold = changedPixels ? original : original * 0.95 - 64;
  if (best.bytes.length >= threshold) return null;

  context.assign(ref, PDFRawStream.of(best.dict, best.bytes));

  let replacedMask: PDFRef | undefined;
  if (resized && smaskPlan && smaskRef) {
    const p = smaskPlan;
    const mw = matte ? tw : Math.min(p.w, tw);
    const mh = matte ? th : Math.min(p.h, th);
    const mpx = resampleArea(p.px, p.w, p.h, 1, mw, mh);
    const z = flateWithPredictor(mpx, mw, mh, 1);
    if (matte || z.length < p.stream.contents.length) {
      const md = newImageDict(p.stream.dict, mw, mh, N('DeviceGray'), 'FlateDecode', predictorParms(context, mw, 1));
      context.assign(smaskRef, PDFRawStream.of(md, z));
      replacedMask = smaskRef;
    }
  }
  return { downsampled: resized, smaskRef: replacedMask };
}

// ---------------------------------------------------------------------------
// Lossless stream recompression
// ---------------------------------------------------------------------------

const ASCII_FILTERS = new Set(['ASCIIHexDecode', 'ASCII85Decode']);

function recompressStreams(context: PDFContext, skip: Set<PDFRef>): number {
  let count = 0;
  for (const [ref, obj] of context.enumerateIndirectObjects()) {
    if (skip.has(ref) || !(obj instanceof PDFRawStream)) continue;
    const dict = obj.dict;
    const type = nameVal(dictGet(dict, 'Type'));
    if (type === 'Metadata' || type === 'XRef' || type === 'ObjStm' || nameVal(dictGet(dict, 'Subtype')) === 'XML') continue;
    const fl = filterList(context, dict);
    if (!fl) continue;
    const { names, parms } = fl;
    try {
      if (names.length === 0) {
        if (obj.contents.length < 64) continue;
        const z = zlibSync(obj.contents, { level: 9 });
        if (z.length + 24 < obj.contents.length) {
          const d = dict.clone();
          d.set(N('Filter'), N('FlateDecode'));
          d.delete(N('DecodeParms'));
          d.delete(N('Length'));
          context.assign(ref, PDFRawStream.of(d, z));
          count++;
        }
        continue;
      }
      const wasteful = names.some((n) => n === 'ASCIIHexDecode' || n === 'ASCII85Decode' || n === 'LZWDecode' || n === 'RunLengthDecode');
      if (!wasteful) continue;

      if (names.every((n) => LOSSLESS.has(n))) {
        // Fully decodable: decode (keeping any predictor) and Flate once.
        for (let i = 0; i < names.length - 1; i++) if (parms[i]) throw new Error('parms');
        const last = names[names.length - 1];
        const lp = parms[parms.length - 1];
        if (lp && !(last === 'FlateDecode' || last === 'LZWDecode')) continue;
        const decoded = decodePDFRawStream(obj).decode();
        const z = zlibSync(decoded, { level: 9 });
        if (z.length >= obj.contents.length) continue;
        const d = dict.clone();
        d.set(N('Filter'), N('FlateDecode'));
        if (lp && hasPredictor(lp)) {
          const np = context.obj({});
          for (const key of ['Predictor', 'Colors', 'BitsPerComponent', 'Columns']) {
            const v = lp.get(N(key));
            if (v !== undefined) np.set(N(key), v);
          }
          d.set(N('DecodeParms'), np);
        } else d.delete(N('DecodeParms'));
        d.delete(N('Length'));
        context.assign(ref, PDFRawStream.of(d, z));
        count++;
        continue;
      }

      // Leading ASCII layers in front of an image codec (e.g. [/ASCII85Decode /DCTDecode]): strip them.
      let k = 0;
      while (k < names.length && ASCII_FILTERS.has(names[k]) && !parms[k]) k++;
      if (k === 0 || k === names.length) continue;
      const tmpDict = dict.clone();
      tmpDict.set(N('Filter'), context.obj(names.slice(0, k).map((n) => N(n))));
      tmpDict.delete(N('DecodeParms'));
      const stripped = decodePDFRawStream(PDFRawStream.of(tmpDict, obj.contents)).decode();
      if (stripped.length >= obj.contents.length) continue;
      const d = dict.clone();
      const rest = names.slice(k);
      const restParms = parms.slice(k);
      d.set(N('Filter'), rest.length === 1 ? N(rest[0]) : context.obj(rest.map((n) => N(n))));
      if (restParms.some((p) => p)) {
        d.set(N('DecodeParms'), rest.length === 1 ? restParms[0]! : context.obj(restParms.map((p) => p ?? null)));
      } else d.delete(N('DecodeParms'));
      d.delete(N('Length'));
      context.assign(ref, PDFRawStream.of(d, stripped));
      count++;
    } catch {
      /* leave the stream as is */
    }
  }
  return count;
}
