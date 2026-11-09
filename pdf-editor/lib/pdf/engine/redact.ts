/**
 * True redaction engine.
 *
 * `redactPage` rewrites a page's content so that everything inside the given
 * rectangles is physically removed from the file (not merely covered):
 *
 *  - text: glyphs whose centre lies in a rect are cut out of Tj/TJ/'/" strings;
 *    the advance is preserved with TJ adjustments so remaining glyphs don't move;
 *  - images: intersecting pixels are overwritten (or the image draw is dropped
 *    when it can't be decoded); shared image objects are never mutated;
 *  - Form XObjects: processed recursively and cloned (page-local) when changed;
 *  - vector paths entirely inside a rect are dropped (clip paths are kept);
 *  - annotations intersecting a rect are removed;
 *  - optional opaque boxes are painted over the rects.
 *
 * Replaced objects (old content streams, images, forms, annotations) that are no
 * longer reachable from the document trailer are deleted from the pdf-lib
 * context so the redacted data is not written on save. Use a full save
 * (`doc.save()`), never an incremental one, after redacting.
 */
import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
  decodePDFRawStream,
  type PDFContext,
  type PDFDocument,
  type PDFObject,
  type PDFPage,
} from '@cantoo/pdf-lib';
import { zlibSync } from 'fflate';
import {
  csName,
  csNum,
  csOp,
  formatNumber,
  getStreamBytes,
  parseContentStream,
  serializeContentStream,
  type CSDict,
  type CSObject,
  type CSOperation,
  type CSString,
} from './contentStream';
import { FALLBACK_FONT, loadFontInfo, pdfStringBytes, type FontInfo } from './fontMetrics';

export {
  parseContentStream,
  serializeContentStream,
  serializeObject,
  getStreamBytes,
  type CSObject,
  type CSOperation,
} from './contentStream';
export { loadFontInfo, type FontInfo } from './fontMetrics';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Rect in the page's default user space (same coordinate system as MediaBox; bottom-left origin; NOT affected by /Rotate). */
export interface PdfRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ImageCodec {
  /** Decode JPEG (DCTDecode) bytes to RGBA. Optional – may be absent in Node. */
  decodeJpeg?(bytes: Uint8Array): Promise<{ width: number; height: number; data: Uint8ClampedArray }>;
}

export interface RedactOptions {
  /** default true */
  removeText?: boolean;
  /** default 'pixels': blacken (fill) pixels inside rect; if the image can't be decoded, remove the whole image draw */
  images?: 'pixels' | 'remove' | 'keep';
  /** default true: drop path-painting ops whose path bbox lies entirely inside a rect */
  removeVectors?: boolean;
  /** default true: delete page annotations whose /Rect intersects a rect */
  removeAnnotations?: boolean;
  /** default true: keep /Widget (form field) annotations even when they intersect */
  keepWidgets?: boolean;
  /** RGB 0..1 opaque boxes drawn over rects after removal; default [0,0,0]; null = draw nothing */
  fillColor?: [number, number, number] | null;
  codec?: ImageCodec;
}

export interface RedactReport {
  glyphsRemoved: number;
  imagesModified: number;
  imagesRemoved: number;
  pathsRemoved: number;
  annotationsRemoved: number;
  xobjectsCloned: number;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

export type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

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

function applyM(m: Matrix, x: number, y: number): [number, number] {
  return [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];
}

function invert(m: Matrix): Matrix | null {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  return [
    m[3] / det,
    -m[1] / det,
    -m[2] / det,
    m[0] / det,
    (m[2] * m[5] - m[3] * m[4]) / det,
    (m[1] * m[4] - m[0] * m[5]) / det,
  ];
}

/** Translate text matrix by (tx, ty) in text space: [1 0 0 1 tx ty] × tm. */
function translateText(tm: Matrix, tx: number, ty: number): Matrix {
  return [tm[0], tm[1], tm[2], tm[3], tx * tm[0] + ty * tm[2] + tm[4], tx * tm[1] + ty * tm[3] + tm[5]];
}

interface BBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const EPS = 1e-6;

function normRect(r: PdfRect): BBox | null {
  const vals = [r?.x, r?.y, r?.width, r?.height];
  if (!vals.every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
  const x0 = Math.min(r.x, r.x + r.width);
  const x1 = Math.max(r.x, r.x + r.width);
  const y0 = Math.min(r.y, r.y + r.height);
  const y1 = Math.max(r.y, r.y + r.height);
  if (x1 - x0 <= 0 || y1 - y0 <= 0) return null;
  return { x0, y0, x1, y1 };
}

function pointInRects(x: number, y: number, rects: BBox[]): boolean {
  for (const r of rects) if (x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1) return true;
  return false;
}

/** Positive-area overlap with any rect. */
function intersectsRects(b: BBox, rects: BBox[]): boolean {
  for (const r of rects) {
    if (Math.min(b.x1, r.x1) - Math.max(b.x0, r.x0) > EPS && Math.min(b.y1, r.y1) - Math.max(b.y0, r.y0) > EPS) {
      return true;
    }
  }
  return false;
}

function insideAnyRect(b: BBox, rects: BBox[]): boolean {
  for (const r of rects) {
    if (b.x0 >= r.x0 - EPS && b.x1 <= r.x1 + EPS && b.y0 >= r.y0 - EPS && b.y1 <= r.y1 + EPS) return true;
  }
  return false;
}

function bboxOfPoints(pts: Array<[number, number]>): BBox {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1 };
}

/** User-space bbox of a rectangle given in some space mapped by `m`. */
function transformBox(m: Matrix, x0: number, y0: number, x1: number, y1: number): BBox {
  return bboxOfPoints([applyM(m, x0, y0), applyM(m, x1, y0), applyM(m, x1, y1), applyM(m, x0, y1)]);
}

// ---------------------------------------------------------------------------
// PDF object helpers
// ---------------------------------------------------------------------------

const N = (s: string) => PDFName.of(s);
const textEncoder = new TextEncoder();

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

/** Refs directly contained in an object (dict values, array items, stream dict). */
function childRefs(obj: PDFObject | undefined, out: PDFRef[]): void {
  if (obj instanceof PDFRef) out.push(obj);
  else if (obj instanceof PDFDict) for (const v of obj.values()) childRefs(v, out);
  else if (obj instanceof PDFArray) for (const v of obj.asArray()) childRefs(v, out);
  else if (obj instanceof PDFStream) childRefs(obj.dict, out);
}

/** Set of refs reachable from the trailer (Root, Info, Encrypt). */
function reachableRefs(context: PDFContext): Set<PDFRef> {
  const seen = new Set<PDFRef>();
  const stack: PDFRef[] = [];
  const t = context.trailerInfo as Record<string, PDFObject | undefined>;
  for (const key of ['Root', 'Info', 'Encrypt', 'ID']) childRefs(t[key], stack);
  while (stack.length) {
    const ref = stack.pop()!;
    if (seen.has(ref)) continue;
    seen.add(ref);
    const obj = context.lookup(ref);
    const kids: PDFRef[] = [];
    childRefs(obj, kids);
    for (const k of kids) if (!seen.has(k)) stack.push(k);
  }
  return seen;
}

/** Occurrence counts of `targets` within objects reachable from the trailer. */
function countReferences(context: PDFContext, targets: Set<PDFRef>): Map<PDFRef, number> {
  const counts = new Map<PDFRef, number>();
  const seen = new Set<PDFRef>();
  const stack: PDFRef[] = [];
  const t = context.trailerInfo as Record<string, PDFObject | undefined>;
  for (const key of ['Root', 'Info', 'Encrypt']) childRefs(t[key], stack);
  while (stack.length) {
    const ref = stack.pop()!;
    if (seen.has(ref)) continue;
    seen.add(ref);
    const kids: PDFRef[] = [];
    childRefs(context.lookup(ref), kids);
    for (const k of kids) {
      if (targets.has(k)) counts.set(k, (counts.get(k) ?? 0) + 1);
      if (!seen.has(k)) stack.push(k);
    }
  }
  return counts;
}

/** Does `bytes` contain the name token `/name` (followed by a delimiter/whitespace/EOF)? */
function containsNameToken(bytes: Uint8Array, name: string): boolean {
  const needle = '/' + name;
  const n = needle.length;
  outer: for (let i = bytes.indexOf(0x2f); i >= 0 && i <= bytes.length - n; i = bytes.indexOf(0x2f, i + 1)) {
    for (let k = 1; k < n; k++) if (bytes[i + k] !== needle.charCodeAt(k)) continue outer;
    const after = bytes[i + n];
    if (after === undefined || after <= 0x20 || '()<>[]{}/%'.includes(String.fromCharCode(after))) return true;
  }
  return false;
}

/**
 * Replaced images/forms can stay reachable through resource dictionaries shared
 * with other pages (e.g. LibreOffice writes one /Resources for all pages, or
 * resources inherited from /Pages). If no page using such a dictionary draws
 * the object, unlink the (unused) entry so the original data is not saved.
 */
function unlinkUnusedXObjects(doc: PDFDocument, targets: PDFRef[]): void {
  if (!targets.length) return;
  const context = doc.context;
  const counts = countReferences(context, new Set(targets));

  // Page-level XObject dictionaries → pages using them.
  const users = new Map<PDFDict, PDFPage[]>();
  for (const page of doc.getPages()) {
    const res = page.node.Resources();
    const xo = res instanceof PDFDict ? dictGet(res, 'XObject') : undefined;
    if (!(xo instanceof PDFDict)) continue;
    const list = users.get(xo) ?? [];
    list.push(page);
    users.set(xo, list);
  }

  const contentCache = new Map<PDFPage, Uint8Array[]>();
  const pageContent = (page: PDFPage, xo: PDFDict): Uint8Array[] => {
    let parts = contentCache.get(page);
    if (parts) return parts;
    parts = [readPageContents(context, page.node.get(PDFName.Contents)).bytes];
    // Forms drawing names from this same dictionary (no own /Resources, or
    // resources sharing the dictionary) count as users too.
    // (Every such form is itself an entry of this dictionary.)
    for (const v of xo.values()) {
      const s = lookup(context, v);
      if (!(s instanceof PDFStream) || nameVal(dictGet(s.dict, 'Subtype')) !== 'Form') continue;
      const ownRes = dictGet(s.dict, 'Resources');
      const formXo = ownRes instanceof PDFDict ? dictGet(ownRes, 'XObject') : xo;
      if (formXo !== xo) continue;
      try {
        parts.push(getStreamBytes(s));
      } catch {
        // Undecodable: treat every name as used.
        parts.push(textEncoder.encode(Array.from(xo.keys(), (k) => k.asString()).join(' ')));
      }
    }
    contentCache.set(page, parts);
    return parts;
  };

  for (const target of targets) {
    const entries: Array<{ xo: PDFDict; key: PDFName }> = [];
    for (const xo of users.keys()) {
      for (const [k, v] of xo.entries()) if (v === target) entries.push({ xo, key: k });
    }
    // Referenced from somewhere other than page-level XObject resources: keep.
    if (!entries.length || entries.length < (counts.get(target) ?? 0)) continue;
    const used = entries.some(({ xo, key }) => {
      const nameText = key.asString().replace(/^\//, '');
      const decoded = key.decodeText().replace(/^\//, '');
      return users.get(xo)!.some((page) =>
        pageContent(page, xo).some((b) => containsNameToken(b, nameText) || containsNameToken(b, decoded)),
      );
    });
    if (!used) for (const { xo, key } of entries) xo.delete(key);
  }
}

/**
 * Strip text-bearing entries from removed annotations that are still referenced
 * (e.g. by the structure tree). Returns the refs that were unlinked (appearance
 * streams, popups, ...) so they can be deleted if now unreachable.
 */
function neutralizeAnnotations(doc: PDFDocument, refs: PDFRef[]): PDFRef[] {
  const unlinked: PDFRef[] = [];
  if (!refs.length) return unlinked;
  const context = doc.context;
  const onPages = new Set<PDFObject>();
  for (const page of doc.getPages()) {
    const annots = lookup(context, page.node.get(PDFName.Annots));
    if (annots instanceof PDFArray) for (const a of annots.asArray()) onPages.add(a);
  }
  for (const ref of refs) {
    if (onPages.has(ref)) continue; // still placed on another page: leave it alone
    const d = lookup(context, ref);
    if (!(d instanceof PDFDict)) continue;
    for (const key of ['Contents', 'RC', 'AP', 'AS', 'T', 'Subj', 'Popup', 'IRT', 'A', 'PA', 'V', 'DV', 'Parent']) {
      childRefs(d.get(N(key)), unlinked);
      d.delete(N(key));
    }
  }
  return unlinked;
}

/**
 * Delete the candidate objects (and anything only reachable through them) that
 * are no longer reachable from the trailer, so redacted data is not saved.
 */
function deleteOrphans(context: PDFContext, candidates: Iterable<PDFRef>): void {
  const list = Array.from(candidates);
  if (!list.length) return;
  if (!context.trailerInfo.Root) return; // can't determine reachability safely
  const reachable = reachableRefs(context);
  const stack = list.filter((r) => !reachable.has(r));
  const done = new Set<PDFRef>();
  while (stack.length) {
    const ref = stack.pop()!;
    if (done.has(ref) || reachable.has(ref)) continue;
    done.add(ref);
    const obj = context.lookup(ref);
    const kids: PDFRef[] = [];
    childRefs(obj, kids);
    context.delete(ref);
    for (const k of kids) if (!reachable.has(k) && !done.has(k)) stack.push(k);
  }
}

// ---------------------------------------------------------------------------
// Resources (copy-on-write)
// ---------------------------------------------------------------------------

/**
 * Wraps a resource dictionary. Lookups go to the original; adding XObjects
 * creates a shallow page-local copy so shared/inherited resources are never
 * mutated.
 */
class ResourceScope {
  private local?: PDFDict;
  private localXObjects?: PDFDict;
  private counter = 0;
  /** Cache of already-produced replacement names (per source object + CTM). */
  readonly replacements = new Map<string, string | null>();
  /** XObject names whose draws were replaced/dropped (decoded → raw). */
  private readonly replaced = new Map<string, string>();

  constructor(
    private readonly context: PDFContext,
    readonly original: PDFDict | undefined,
  ) {}

  get(category: string, rawName: string): { obj?: PDFObject; ref?: PDFRef } {
    const sub = dictGet(this.original, category);
    if (!(sub instanceof PDFDict)) return {};
    const entry = sub.get(PDFName.of(rawName));
    return { obj: lookup(this.context, entry), ref: entry instanceof PDFRef ? entry : undefined };
  }

  private ensureLocal(): PDFDict {
    if (!this.local || !this.localXObjects) {
      this.local = this.original ? this.original.clone() : this.context.obj({});
      const origX = lookup(this.context, this.local.get(PDFName.XObject));
      this.localXObjects = origX instanceof PDFDict ? origX.clone() : this.context.obj({});
      this.local.set(PDFName.XObject, this.localXObjects);
    }
    return this.localXObjects;
  }

  addXObject(ref: PDFRef, prefix: string): string {
    const xobjects = this.ensureLocal();
    let name: string;
    do name = `${prefix}${++this.counter}`;
    while (xobjects.has(PDFName.of(name)));
    xobjects.set(PDFName.of(name), ref);
    return name;
  }

  markReplaced(name: { value: string; raw: string }) {
    this.replaced.set(name.value, name.raw);
  }

  /**
   * Remove replaced XObject names that the rewritten content no longer draws,
   * so the original (unredacted) objects stop being reachable from this scope.
   */
  prune(ops: CSOperation[]) {
    if (!this.replaced.size) return;
    const used = new Set<string>();
    for (const op of ops) {
      if (op.op !== 'Do') continue;
      const n = op.operands[op.operands.length - 1];
      if (n && n.type === 'name') used.add(n.value);
    }
    for (const [value, raw] of this.replaced) {
      if (!used.has(value)) this.ensureLocal().delete(PDFName.of(raw));
    }
  }

  /** Indirect refs of the original resource / XObject dictionaries (replaced when changed). */
  originalRefs(rawResources: PDFObject | undefined): PDFRef[] {
    const out: PDFRef[] = [];
    if (rawResources instanceof PDFRef) out.push(rawResources);
    const rawX = this.original?.get(PDFName.XObject);
    if (rawX instanceof PDFRef) out.push(rawX);
    return out;
  }

  get changed(): boolean {
    return !!this.local;
  }

  get result(): PDFDict | undefined {
    return this.local;
  }
}

// ---------------------------------------------------------------------------
// Graphics state
// ---------------------------------------------------------------------------

interface GState {
  ctm: Matrix;
  font: FontInfo | null;
  fontSize: number;
  /** Tc */ charSpacing: number;
  /** Tw */ wordSpacing: number;
  /** Tz / 100 */ hScale: number;
  /** TL */ leading: number;
  /** Ts */ rise: number;
  lineWidth: number;
}

function initialGState(ctm: Matrix): GState {
  return { ctm, font: null, fontSize: 0, charSpacing: 0, wordSpacing: 0, hScale: 1, leading: 0, rise: 0, lineWidth: 1 };
}

interface Ctx {
  context: PDFContext;
  rects: BBox[];
  removeText: boolean;
  images: 'pixels' | 'remove' | 'keep';
  removeVectors: boolean;
  /** Colour used to paint redacted image pixels. */
  pixelColor: [number, number, number];
  codec?: ImageCodec;
  report: RedactReport;
  /** Form streams currently being processed (cycle guard). */
  formStack: PDFObject[];
  /** Objects replaced on this page: deleted at the end if unreachable. */
  candidates: Set<PDFRef>;
  /** Objects registered by this run (deleted again on failure). */
  created: PDFRef[];
}

interface RewriteResult {
  ops: CSOperation[];
  changed: boolean;
  /** Unbalanced `q` count at the end of the stream. */
  qDepth: number;
  inText: boolean;
  openMarked: number;
}

const PATH_CONSTRUCTION = new Set(['m', 'l', 'c', 'v', 'y', 'h', 're']);
const PATH_PAINTING = new Set(['S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*', 'n']);
const STROKING = new Set(['S', 's', 'B', 'B*', 'b', 'b*']);

interface PendingPath {
  ops: CSOperation[];
  points: Array<[number, number]>;
  clip: boolean;
  /** Malformed operands seen: never drop this path. */
  invalid: boolean;
}

/** Last `n` operands as numbers, or null. */
function nums(op: CSOperation, n: number): number[] | null {
  if (op.operands.length < n) return null;
  const out: number[] = [];
  for (let i = op.operands.length - n; i < op.operands.length; i++) {
    const o = op.operands[i];
    if (o.type !== 'number' || !Number.isFinite(o.value)) return null;
    out.push(o.value);
  }
  return out;
}

function lastOperand<T extends CSObject['type']>(op: CSOperation, type: T): Extract<CSObject, { type: T }> | null {
  const o = op.operands[op.operands.length - 1];
  return o && o.type === type ? (o as Extract<CSObject, { type: T }>) : null;
}

const ACTUAL_TEXT_KEYS = new Set(['ActualText', 'Alt', 'E']);

// ---------------------------------------------------------------------------
// Content rewriter
// ---------------------------------------------------------------------------

class ContentRewriter {
  private out: CSOperation[] = [];
  private changed = false;
  private gs: GState;
  private stack: GState[] = [];
  private tm: Matrix = IDENTITY;
  private tlm: Matrix = IDENTITY;
  private inText = false;
  private path: PendingPath | null = null;
  private marked: Array<{ index: number; tainted: boolean }> = [];

  constructor(
    private readonly ctx: Ctx,
    private readonly scope: ResourceScope,
    gs: GState,
    private readonly isPage: boolean,
  ) {
    this.gs = gs;
  }

  async run(ops: CSOperation[]): Promise<RewriteResult> {
    for (const op of ops) {
      if (this.path && !PATH_CONSTRUCTION.has(op.op) && !PATH_PAINTING.has(op.op) && op.op !== 'W' && op.op !== 'W*') {
        this.flushPath(); // malformed: path construction interrupted by another operator
      }
      const mark = this.out.length;
      try {
        await this.handle(op);
      } catch {
        // Per-operator failure: keep the original operator.
        this.out.length = mark;
        this.out.push(op);
      }
    }
    this.flushPath();
    return {
      ops: this.out,
      changed: this.changed,
      qDepth: this.stack.length,
      inText: this.inText,
      openMarked: this.marked.length,
    };
  }

  private taint() {
    for (const m of this.marked) m.tainted = true;
  }

  private flushPath() {
    if (this.path) {
      this.out.push(...this.path.ops);
      this.path = null;
    }
  }

  private async handle(op: CSOperation): Promise<void> {
    const o = op.op;
    const gs = this.gs;
    switch (o) {
      // --- graphics state -------------------------------------------------
      case 'q':
        this.stack.push({ ...gs });
        this.out.push(op);
        return;
      case 'Q':
        if (this.stack.length) {
          this.gs = this.stack.pop()!;
          this.out.push(op);
        } else if (!this.isPage) {
          this.out.push(op);
        }
        // Unbalanced Q on a page is ignored by viewers; drop it so our q…Q wrapper stays balanced.
        return;
      case 'cm': {
        const m = nums(op, 6);
        if (m) gs.ctm = mul(m as Matrix, gs.ctm);
        this.out.push(op);
        return;
      }
      case 'w': {
        const v = nums(op, 1);
        if (v) gs.lineWidth = v[0];
        this.out.push(op);
        return;
      }
      case 'gs':
        this.applyExtGState(op);
        this.out.push(op);
        return;

      // --- text state ------------------------------------------------------
      case 'BT':
        this.inText = true;
        this.tm = this.tlm = IDENTITY;
        this.out.push(op);
        return;
      case 'ET':
        this.inText = false;
        this.out.push(op);
        return;
      case 'Tf': {
        const name = op.operands.length >= 2 ? op.operands[op.operands.length - 2] : undefined;
        const size = nums(op, 1);
        if (name && name.type === 'name') gs.font = loadFontInfo(this.scope.get('Font', name.raw).obj);
        if (size) gs.fontSize = size[0];
        this.out.push(op);
        return;
      }
      case 'Tc':
      case 'Tw':
      case 'Tz':
      case 'TL':
      case 'Ts': {
        const v = nums(op, 1);
        if (v) {
          if (o === 'Tc') gs.charSpacing = v[0];
          else if (o === 'Tw') gs.wordSpacing = v[0];
          else if (o === 'Tz') gs.hScale = v[0] / 100;
          else if (o === 'TL') gs.leading = v[0];
          else gs.rise = v[0];
        }
        this.out.push(op);
        return;
      }
      case 'Td':
      case 'TD': {
        const v = nums(op, 2);
        if (v) {
          if (o === 'TD') gs.leading = -v[1];
          this.tlm = translateText(this.tlm, v[0], v[1]);
          this.tm = this.tlm;
        }
        this.out.push(op);
        return;
      }
      case 'Tm': {
        const m = nums(op, 6);
        if (m) this.tm = this.tlm = m as Matrix;
        this.out.push(op);
        return;
      }
      case 'T*':
        this.nextLine();
        this.out.push(op);
        return;

      // --- text showing -----------------------------------------------------
      case 'Tj': {
        const s = lastOperand(op, 'string');
        if (!s) return void this.out.push(op);
        this.showText(op, [s], []);
        return;
      }
      case 'TJ': {
        const a = lastOperand(op, 'array');
        if (!a) return void this.out.push(op);
        this.showText(op, a.items, []);
        return;
      }
      case "'": {
        const s = lastOperand(op, 'string');
        this.nextLine();
        if (!s) return void this.out.push(op);
        this.showText(op, [s], [csOp('T*')]);
        return;
      }
      case '"': {
        const s = lastOperand(op, 'string');
        const v = op.operands.length >= 3 ? op.operands.slice(-3, -1) : [];
        if (v.length === 2 && v[0].type === 'number' && v[1].type === 'number') {
          gs.wordSpacing = v[0].value;
          gs.charSpacing = v[1].value;
        }
        this.nextLine();
        if (!s || v.length !== 2) return void this.out.push(op);
        this.showText(op, [s], [csOp('Tw', v[0]), csOp('Tc', v[1]), csOp('T*')]);
        return;
      }

      // --- marked content ---------------------------------------------------
      case 'BMC':
      case 'BDC':
        this.marked.push({ index: this.out.length, tainted: false });
        this.out.push(op);
        return;
      case 'EMC': {
        const m = this.marked.pop();
        if (m?.tainted) this.sanitizeMarkedContent(m.index);
        this.out.push(op);
        return;
      }

      // --- paths --------------------------------------------------------------
      case 'm':
      case 'l':
      case 'c':
      case 'v':
      case 'y':
      case 'h':
      case 're':
        this.addPathOp(op);
        return;
      case 'W':
      case 'W*':
        if (this.path) {
          this.path.ops.push(op);
          this.path.clip = true;
        } else this.out.push(op);
        return;
      case 'S':
      case 's':
      case 'f':
      case 'F':
      case 'f*':
      case 'B':
      case 'B*':
      case 'b':
      case 'b*':
      case 'n':
        this.paintPath(op);
        return;

      // --- images / XObjects ----------------------------------------------------
      case 'BI':
        if (this.ctx.images !== 'keep' && intersectsRects(transformBox(gs.ctm, 0, 0, 1, 1), this.ctx.rects)) {
          this.ctx.report.imagesRemoved++;
          this.changed = true;
          this.taint();
          return;
        }
        this.out.push(op);
        return;
      case 'Do':
        await this.doXObject(op);
        return;

      default:
        this.out.push(op);
    }
  }

  private nextLine() {
    this.tlm = translateText(this.tlm, 0, -this.gs.leading);
    this.tm = this.tlm;
  }

  private applyExtGState(op: CSOperation) {
    const name = lastOperand(op, 'name');
    if (!name) return;
    const dict = this.scope.get('ExtGState', name.raw).obj;
    if (!(dict instanceof PDFDict)) return;
    const lw = numVal(dictGet(dict, 'LW'));
    if (lw !== undefined) this.gs.lineWidth = lw;
    const font = dictGet(dict, 'Font');
    if (font instanceof PDFArray && font.size() >= 2) {
      this.gs.font = loadFontInfo(lookup(this.ctx.context, font.get(0)));
      const size = numVal(lookup(this.ctx.context, font.get(1)));
      if (size !== undefined) this.gs.fontSize = size;
    }
  }

  /** Drop /ActualText, /Alt and /E from an inline BDC property list whose content was redacted. */
  private sanitizeMarkedContent(index: number) {
    const op = this.out[index];
    if (!op || op.op !== 'BDC') return;
    const props = op.operands[op.operands.length - 1];
    if (!props || props.type !== 'dict') return;
    const entries = props.entries.filter(([k]) => !ACTUAL_TEXT_KEYS.has(k.value));
    if (entries.length === props.entries.length) return;
    const dict: CSDict = { type: 'dict', entries };
    this.out[index] = { op: 'BDC', operands: [...op.operands.slice(0, -1), dict] };
  }

  // -------------------------------------------------------------------------
  // Text
  // -------------------------------------------------------------------------

  /**
   * Walk the glyphs of a show-text operation, advancing the text matrix, and
   * emit a rewritten TJ if any glyph falls inside a redaction rect.
   */
  private showText(op: CSOperation, elements: CSObject[], prefix: CSOperation[]) {
    if (!this.ctx.removeText) {
      this.out.push(op); // glyph positions are only needed to decide removals
      return;
    }
    const gs = this.gs;
    const font: FontInfo = gs.font ?? FALLBACK_FONT;
    const tfs = gs.fontSize;
    const th = gs.hScale;
    const vertical = font.vertical;
    const rects = this.ctx.rects;

    const items: CSObject[] = [];
    let current: number[] | null = null; // bytes of the string being built
    let currentHex = false;
    let pending = 0; // accumulated TJ adjustment (thousandths of text space unit)
    let removed = 0;

    const flushString = () => {
      if (current && current.length) {
        items.push({ type: 'string', bytes: Uint8Array.from(current), hex: currentHex } as CSString);
      }
      current = null;
    };
    const flushNumber = () => {
      if (Math.abs(pending) > 1e-9) items.push(csNum(Number(formatNumber(pending))));
      pending = 0;
    };

    for (const el of elements) {
      if (el.type === 'number') {
        const adj = Number.isFinite(el.value) ? el.value : 0;
        if (vertical) this.tm = translateText(this.tm, 0, (-adj / 1000) * tfs);
        else this.tm = translateText(this.tm, (-adj / 1000) * tfs * th, 0);
        flushString();
        pending += adj;
        continue;
      }
      if (el.type !== 'string') continue;
      const bytes = el.bytes;
      for (const slice of font.splitCodes(bytes)) {
        const spacing = gs.charSpacing + (slice.length === 1 && slice.code === 32 ? gs.wordSpacing : 0);
        let w = font.width(slice.code) * font.widthScale;
        if (!Number.isFinite(w)) w = 0;
        let advance: number; // unscaled advance (before Th) in text space units
        let cx: number;
        let cy: number;
        if (vertical) {
          let w1 = font.verticalAdvance(slice.code) * 0.001;
          if (!Number.isFinite(w1)) w1 = -1;
          advance = w1 * tfs + spacing;
          cx = 0;
          cy = (w1 * tfs) / 2 + gs.rise;
        } else {
          advance = w * tfs + spacing;
          cx = (w * tfs * th) / 2;
          cy = 0.3 * tfs + gs.rise;
        }

        const [px, py] = applyM(mul(this.tm, gs.ctm), cx, cy);
        const remove = pointInRects(px, py, rects);

        if (remove) {
          flushString();
          // An adjustment N moves by -N/1000 * Tfs (× Th): choose N to reproduce the glyph's advance.
          if (tfs !== 0) pending += (-1000 * advance) / tfs;
          removed++;
        } else {
          flushNumber();
          if (!current) {
            current = [];
            currentHex = el.hex;
          } else if (el.hex) currentHex = true;
          for (let k = 0; k < slice.length; k++) current.push(bytes[slice.start + k]);
        }

        if (vertical) this.tm = translateText(this.tm, 0, advance);
        else this.tm = translateText(this.tm, advance * th, 0);
      }
    }

    if (!removed) {
      this.out.push(op);
      return;
    }
    flushString();
    flushNumber();
    this.out.push(...prefix);
    if (items.length) this.out.push({ op: 'TJ', operands: [{ type: 'array', items }] });
    this.ctx.report.glyphsRemoved += removed;
    this.changed = true;
    this.taint();
  }

  // -------------------------------------------------------------------------
  // Paths
  // -------------------------------------------------------------------------

  private addPathOp(op: CSOperation) {
    if (!this.path) this.path = { ops: [], points: [], clip: false, invalid: false };
    const p = this.path;
    p.ops.push(op);
    const ctm = this.gs.ctm;
    const need: Record<string, number> = { m: 2, l: 2, c: 6, v: 4, y: 4, h: 0, re: 4 };
    const v = nums(op, need[op.op]);
    if (!v) {
      p.invalid = true;
      return;
    }
    if (op.op === 're') {
      const [x, y, w, h] = v;
      p.points.push(applyM(ctm, x, y), applyM(ctm, x + w, y), applyM(ctm, x + w, y + h), applyM(ctm, x, y + h));
    } else {
      for (let i = 0; i + 1 < v.length; i += 2) p.points.push(applyM(ctm, v[i], v[i + 1]));
    }
  }

  private paintPath(op: CSOperation) {
    const p = this.path;
    this.path = null;
    if (!p) {
      this.out.push(op);
      return;
    }
    if (this.ctx.removeVectors && !p.clip && !p.invalid && op.op !== 'n' && p.points.length) {
      let bb = bboxOfPoints(p.points);
      if (STROKING.has(op.op)) {
        const m = this.gs.ctm;
        const scale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
        const half = (Math.max(this.gs.lineWidth, 0) / 2) * scale;
        bb = { x0: bb.x0 - half, y0: bb.y0 - half, x1: bb.x1 + half, y1: bb.y1 + half };
      }
      if (insideAnyRect(bb, this.ctx.rects)) {
        this.ctx.report.pathsRemoved++;
        this.changed = true;
        return;
      }
    }
    this.out.push(...p.ops, op);
  }

  // -------------------------------------------------------------------------
  // XObjects
  // -------------------------------------------------------------------------

  private async doXObject(op: CSOperation) {
    const name = lastOperand(op, 'name');
    if (!name) return void this.out.push(op);
    const { obj, ref } = this.scope.get('XObject', name.raw);
    if (!(obj instanceof PDFStream)) return void this.out.push(op);
    const subtype = nameVal(dictGet(obj.dict, 'Subtype'));
    const ctm = this.gs.ctm;
    const key = `${ref ? ref.toString() : name.raw}|${ctm.map((v) => v.toFixed(4)).join(',')}`;

    if (subtype === 'Image') {
      if (this.ctx.images === 'keep') return void this.out.push(op);
      if (!intersectsRects(transformBox(ctm, 0, 0, 1, 1), this.ctx.rects)) return void this.out.push(op);
      let replacement: string | null | 'unchanged';
      if (this.scope.replacements.has(key)) replacement = this.scope.replacements.get(key)!;
      else {
        replacement = null;
        if (this.ctx.images === 'pixels') {
          let res: PDFRawStream | 'unchanged' | null = null;
          try {
            res = await redactImagePixels(obj, ctm, this.ctx);
          } catch {
            res = null;
          }
          if (res === 'unchanged') return void this.out.push(op);
          if (res) {
            const newRef = this.ctx.context.register(res);
            this.ctx.created.push(newRef);
            replacement = this.scope.addXObject(newRef, 'RdIm');
          }
        }
        this.scope.replacements.set(key, replacement);
      }
      if (ref) this.ctx.candidates.add(ref);
      this.scope.markReplaced(name);
      this.changed = true;
      this.taint();
      if (replacement === null) {
        this.ctx.report.imagesRemoved++;
        return; // drop the Do
      }
      this.ctx.report.imagesModified++;
      this.out.push({ op: 'Do', operands: [csName(replacement)] });
      return;
    }

    if (subtype === 'Form') {
      let replacement: string | null;
      if (this.scope.replacements.has(key)) replacement = this.scope.replacements.get(key)!;
      else {
        replacement = await this.processForm(obj, ref);
        this.scope.replacements.set(key, replacement);
      }
      if (replacement === null) return void this.out.push(op);
      this.scope.markReplaced(name);
      this.changed = true;
      this.out.push({ op: 'Do', operands: [csName(replacement)] });
      return;
    }

    this.out.push(op);
  }

  /** Recurse into a Form XObject; returns the name of a page-local modified clone, or null if unchanged. */
  private async processForm(stream: PDFStream, ref: PDFRef | undefined): Promise<string | null> {
    const ctx = this.ctx;
    if (ctx.formStack.includes(stream) || ctx.formStack.length > 24) return null;
    const context = ctx.context;
    const matrix = numArray(context, stream.dict.get(N('Matrix')));
    const formCtm = mul(matrix && matrix.length === 6 ? (matrix as Matrix) : IDENTITY, this.gs.ctm);

    // Quick reject: nothing visible of the form can touch a rect.
    const bbox = numArray(context, stream.dict.get(N('BBox')));
    if (bbox && bbox.length === 4) {
      const box = transformBox(formCtm, bbox[0], bbox[1], bbox[2], bbox[3]);
      if (!intersectsRects(box, ctx.rects)) return null;
    }

    const ownRes = dictGet(stream.dict, 'Resources');
    const scope = new ResourceScope(context, ownRes instanceof PDFDict ? ownRes : this.scope.original);
    const ops = parseContentStream(getStreamBytes(stream));
    ctx.formStack.push(stream);
    let result: RewriteResult;
    try {
      const childGs: GState = { ...this.gs, ctm: formCtm };
      result = await new ContentRewriter(ctx, scope, childGs, false).run(ops);
    } finally {
      ctx.formStack.pop();
    }
    if (!result.changed) return null;
    scope.prune(result.ops);

    const dict = stream.dict.clone();
    dict.set(N('Filter'), N('FlateDecode'));
    dict.delete(N('DecodeParms'));
    dict.delete(N('DL'));
    dict.delete(N('Length'));
    if (scope.changed && scope.result) dict.set(N('Resources'), scope.result);
    const clone = PDFRawStream.of(dict, zlibSync(serializeContentStream(result.ops)));
    const newRef = context.register(clone);
    ctx.created.push(newRef);
    if (ref) ctx.candidates.add(ref);
    ctx.report.xobjectsCloned++;
    return this.scope.addXObject(newRef, 'RdFm');
  }
}

// ---------------------------------------------------------------------------
// Image pixel redaction
// ---------------------------------------------------------------------------

const DECODABLE_FILTERS = new Set(['FlateDecode', 'LZWDecode', 'ASCIIHexDecode', 'ASCII85Decode', 'RunLengthDecode']);

interface ColorSpaceInfo {
  ncomp: number;
  kind: 'gray' | 'rgb' | 'cmyk' | 'tint';
  indexed?: { base: ColorSpaceInfo; baseObj: PDFObject; hival: number; lookup: Uint8Array };
}

function resolveColorSpace(context: PDFContext, obj: PDFObject | undefined, depth = 0): ColorSpaceInfo | null {
  const o = lookup(context, obj);
  if (depth > 4 || !o) return null;
  if (o instanceof PDFName) {
    switch (o.decodeText()) {
      case 'DeviceGray':
      case 'G':
      case 'CalGray':
        return { ncomp: 1, kind: 'gray' };
      case 'DeviceRGB':
      case 'RGB':
      case 'CalRGB':
        return { ncomp: 3, kind: 'rgb' };
      case 'DeviceCMYK':
      case 'CMYK':
        return { ncomp: 4, kind: 'cmyk' };
      default:
        return null;
    }
  }
  if (!(o instanceof PDFArray) || o.size() === 0) return null;
  const family = nameVal(lookup(context, o.get(0)));
  switch (family) {
    case 'ICCBased': {
      const s = lookup(context, o.get(1));
      const n = s instanceof PDFStream ? numVal(dictGet(s.dict, 'N')) : undefined;
      if (n === 1) return { ncomp: 1, kind: 'gray' };
      if (n === 3) return { ncomp: 3, kind: 'rgb' };
      if (n === 4) return { ncomp: 4, kind: 'cmyk' };
      return null;
    }
    case 'CalGray':
      return { ncomp: 1, kind: 'gray' };
    case 'CalRGB':
      return { ncomp: 3, kind: 'rgb' };
    case 'DeviceGray':
    case 'DeviceRGB':
    case 'DeviceCMYK':
      return resolveColorSpace(context, o.get(0), depth + 1);
    case 'Separation':
      return { ncomp: 1, kind: 'tint' };
    case 'DeviceN': {
      const names = lookup(context, o.get(1));
      return names instanceof PDFArray && names.size() > 0 ? { ncomp: names.size(), kind: 'tint' } : null;
    }
    case 'Indexed':
    case 'I': {
      const baseObj = o.get(1);
      const base = resolveColorSpace(context, baseObj, depth + 1);
      const hival = numVal(lookup(context, o.get(2)));
      const lk = lookup(context, o.get(3));
      let table: Uint8Array | undefined = pdfStringBytes(lk);
      if (!table && lk instanceof PDFStream) table = getStreamBytes(lk);
      if (!base || base.indexed || hival === undefined || !table) return null;
      return { ncomp: 1, kind: base.kind, indexed: { base, baseObj, hival: Math.floor(hival), lookup: table } };
    }
    default:
      return null;
  }
}

/** Colour components (0..1, in the colour space's own terms) approximating an RGB colour. */
function componentsFor(cs: ColorSpaceInfo, rgb: [number, number, number]): number[] {
  const [r, g, b] = rgb.map((v) => Math.min(1, Math.max(0, v)));
  const lum = 0.299 * r + 0.587 * g + 0.114 * b;
  switch (cs.kind) {
    case 'gray':
      return [lum];
    case 'rgb':
      return [r, g, b];
    case 'cmyk': {
      const k = 1 - Math.max(r, g, b);
      if (k >= 1) return [0, 0, 0, 1];
      return [(1 - r - k) / (1 - k), (1 - g - k) / (1 - k), (1 - b - k) / (1 - k), k];
    }
    case 'tint':
      return new Array(cs.ncomp).fill(1 - lum);
  }
}

/** Undo PNG (10..15) / TIFF (2) predictors. Returns null for unsupported parameters. */
function unpredict(data: Uint8Array, parms: PDFDict | undefined): Uint8Array | null {
  if (!parms) return data;
  const predictor = numVal(dictGet(parms, 'Predictor')) ?? 1;
  if (predictor <= 1) return data;
  const colors = numVal(dictGet(parms, 'Colors')) ?? 1;
  const bpc = numVal(dictGet(parms, 'BitsPerComponent')) ?? 8;
  const columns = numVal(dictGet(parms, 'Columns')) ?? 1;
  const rowLen = Math.ceil((colors * bpc * columns) / 8);
  if (predictor === 2) {
    if (bpc !== 8) return null;
    const out = data.slice();
    for (let row = 0; row * rowLen < out.length; row++) {
      const base = row * rowLen;
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
      const upLeft = row > 0 && i >= bpp ? out[prev + i - bpp] : 0;
      let v: number;
      switch (type) {
        case 0: v = x; break;
        case 1: v = x + left; break;
        case 2: v = x + up; break;
        case 3: v = x + ((left + up) >> 1); break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - upLeft);
          v = x + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
          break;
        }
        default: v = x;
      }
      out[dst + i] = v & 0xff;
    }
  }
  return out;
}

/** Decode the first `count` filters of a stream's filter chain (handles encryption via pdf-lib). */
function decodeFilterPrefix(stream: PDFRawStream, names: string[], parms: Array<PDFObject | undefined>, count: number): Uint8Array {
  if (count === names.length) return decodePDFRawStream(stream).decode();
  const dict = stream.dict.clone();
  if (count === 0) {
    dict.delete(N('Filter'));
    dict.delete(N('DecodeParms'));
  } else {
    dict.set(N('Filter'), dict.context.obj(names.slice(0, count).map((n) => N(n))));
    if (parms.some((p) => p)) {
      dict.set(N('DecodeParms'), dict.context.obj(parms.slice(0, count).map((p) => p ?? dict.context.obj(null))));
    } else dict.delete(N('DecodeParms'));
  }
  return decodePDFRawStream(PDFRawStream.of(dict, stream.contents, stream.transform)).decode();
}

/** Clip a polygon to the horizontal band lo <= y <= hi (Sutherland–Hodgman). */
function clipToBand(poly: Array<[number, number]>, lo: number, hi: number): Array<[number, number]> {
  const clip = (pts: Array<[number, number]>, inside: (p: [number, number]) => boolean, yEdge: number) => {
    const res: Array<[number, number]> = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const ina = inside(a);
      const inb = inside(b);
      if (ina) res.push(a);
      if (ina !== inb && b[1] !== a[1]) {
        const t = (yEdge - a[1]) / (b[1] - a[1]);
        res.push([a[0] + t * (b[0] - a[0]), yEdge]);
      }
    }
    return res;
  };
  return clip(clip(poly, (p) => p[1] >= lo, lo), (p) => p[1] <= hi, hi);
}

/**
 * Pixel spans (row, x0, x1 exclusive) of a W×H image drawn with `ctm` that
 * overlap any rect. Image row 0 is the top of the unit square.
 */
function pixelSpans(rects: BBox[], ctm: Matrix, W: number, H: number): Array<[number, number, number]> | null {
  const inv = invert(ctm);
  if (!inv) return null;
  const spans: Array<[number, number, number]> = [];
  for (const r of rects) {
    const poly = ([[r.x0, r.y0], [r.x1, r.y0], [r.x1, r.y1], [r.x0, r.y1]] as Array<[number, number]>).map(([x, y]) => {
      const [u, v] = applyM(inv, x, y);
      return [u * W, (1 - v) * H] as [number, number];
    });
    const ys = poly.map((p) => p[1]);
    const r0 = Math.max(0, Math.floor(Math.min(...ys) + EPS));
    const r1 = Math.min(H, Math.ceil(Math.max(...ys) - EPS));
    for (let row = r0; row < r1; row++) {
      const band = clipToBand(poly, row, row + 1);
      if (band.length < 2) continue;
      const xs = band.map((p) => p[0]);
      const c0 = Math.max(0, Math.floor(Math.min(...xs) + EPS));
      const c1 = Math.min(W, Math.ceil(Math.max(...xs) - EPS));
      if (c1 > c0) spans.push([row, c0, c1]);
    }
  }
  return spans;
}

/**
 * Overwrite the image pixels covered by the rects. Returns a new (unregistered)
 * Flate image stream, 'unchanged' if no pixel is covered, or null when the
 * image can't be decoded (caller then removes the image draw).
 */
async function redactImagePixels(stream: PDFStream, ctm: Matrix, ctx: Ctx): Promise<PDFRawStream | 'unchanged' | null> {
  if (!(stream instanceof PDFRawStream)) return null;
  const context = ctx.context;
  const dict = stream.dict;
  let width = numVal(dictGet(dict, 'Width'));
  let height = numVal(dictGet(dict, 'Height'));
  if (!width || !height || width <= 0 || height <= 0 || width * height > 1e8) return null;
  width = Math.floor(width);
  height = Math.floor(height);
  const isMask = dictGet(dict, 'ImageMask') instanceof PDFBool && (dictGet(dict, 'ImageMask') as PDFBool).asBoolean();

  const filterObj = dictGet(dict, 'Filter');
  const names: string[] = [];
  if (filterObj instanceof PDFName) names.push(filterObj.decodeText());
  else if (filterObj instanceof PDFArray) {
    for (const f of filterObj.asArray()) {
      const n = nameVal(lookup(context, f));
      if (!n) return null;
      names.push(n);
    }
  }
  const parmsObj = dictGet(dict, 'DecodeParms');
  const parms: Array<PDFObject | undefined> = names.map((_, i) => {
    if (parmsObj instanceof PDFArray) return lookup(context, parmsObj.get(i));
    return i === 0 ? parmsObj : undefined;
  });

  let data: Uint8Array;
  let bpc: number;
  let cs: ColorSpaceInfo | null;
  let decodeArr: number[] | undefined;
  let fromJpeg = false;

  const last = names[names.length - 1];
  if (last === 'DCTDecode' || last === 'DCT') {
    if (isMask || !ctx.codec?.decodeJpeg) return null;
    if (!names.slice(0, -1).every((n) => DECODABLE_FILTERS.has(n))) return null;
    const jpeg = decodeFilterPrefix(stream, names, parms, names.length - 1);
    const img = await ctx.codec.decodeJpeg(jpeg);
    if (!img || img.width <= 0 || img.height <= 0 || img.data.length < img.width * img.height * 4) return null;
    width = img.width;
    height = img.height;
    data = new Uint8Array(width * height * 3);
    for (let i = 0, j = 0; j < data.length; i += 4, j += 3) {
      data[j] = img.data[i];
      data[j + 1] = img.data[i + 1];
      data[j + 2] = img.data[i + 2];
    }
    bpc = 8;
    cs = { ncomp: 3, kind: 'rgb' };
    fromJpeg = true;
  } else {
    if (!names.every((n) => DECODABLE_FILTERS.has(n))) return null;
    let raw = decodePDFRawStream(stream).decode();
    const lastParms = parms[parms.length - 1];
    if (last === 'FlateDecode' || last === 'LZWDecode') {
      const un = unpredict(raw, lastParms instanceof PDFDict ? lastParms : undefined);
      if (!un) return null;
      raw = un;
    } else if (parms.some((p) => p instanceof PDFDict && (numVal(dictGet(p, 'Predictor')) ?? 1) > 1)) {
      return null; // predictor on a non-final filter: unsupported
    }
    data = raw;
    bpc = isMask ? 1 : numVal(dictGet(dict, 'BitsPerComponent')) ?? 8;
    if (![1, 2, 4, 8, 16].includes(bpc)) return null;
    cs = isMask ? { ncomp: 1, kind: 'gray' } : resolveColorSpace(context, dict.get(N('ColorSpace')));
    if (!cs) return null;
    decodeArr = numArray(context, dict.get(N('Decode')));
  }

  const ncomp = cs.ncomp;
  const stride = Math.ceil((width * ncomp * bpc) / 8);
  if (data.length < stride * height) {
    const padded = new Uint8Array(stride * height);
    padded.set(data);
    data = padded;
  } else if (data.length > stride * height || !fromJpeg) {
    data = data.slice(0, stride * height); // own copy (decoders may return shared buffers)
  }

  const spans = pixelSpans(ctx.rects, ctm, width, height);
  if (!spans) return null;
  if (!spans.length) return 'unchanged';

  // Sample values to write, in the image's own bit depth.
  const maxVal = (1 << bpc) - 1;
  const toSample = (value: number, comp: number, dflt: [number, number]) => {
    const dmin = decodeArr?.[comp * 2] ?? dflt[0];
    const dmax = decodeArr?.[comp * 2 + 1] ?? dflt[1];
    if (dmax === dmin) return 0;
    return Math.max(0, Math.min(maxVal, Math.round(((value - dmin) / (dmax - dmin)) * maxVal)));
  };
  let samples: number[];
  let newColorSpace: PDFObject | undefined;
  if (isMask) {
    // Stencil mask: make covered pixels unpainted (sample decoding to 1).
    samples = [toSample(1, 0, [0, 1])];
  } else if (cs.indexed) {
    const { base, baseObj, hival, lookup: table } = cs.indexed;
    const target = componentsFor(base, ctx.pixelColor).map((v) => Math.round(v * 255));
    const nb = base.ncomp;
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i <= hival && (i + 1) * nb <= table.length; i++) {
      let d = 0;
      for (let k = 0; k < nb; k++) d += (table[i * nb + k] - target[k]) ** 2;
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    if (bestDist > 0 && hival < Math.min(255, maxVal)) {
      // Append the exact colour to the palette (page-local colour space array).
      const newTable = new Uint8Array((hival + 2) * nb);
      newTable.set(table.subarray(0, Math.min(table.length, (hival + 1) * nb)));
      newTable.set(target, (hival + 1) * nb);
      best = hival + 1;
      newColorSpace = context.obj([N('Indexed'), baseObj, PDFNumber.of(hival + 1), PDFHexString.fromBytes(newTable)]);
    }
    samples = [toSample(best, 0, [0, maxVal])];
  } else {
    samples = componentsFor(cs, ctx.pixelColor).map((v, k) => toSample(v, k, [0, 1]));
  }

  // Paint spans (tracking whether any sample actually changes).
  let touched = false;
  const put = (i: number, v: number) => {
    if (data[i] !== v) {
      data[i] = v;
      touched = true;
    }
  };
  for (const [row, c0, c1] of spans) {
    const rowOff = row * stride;
    if (bpc === 8) {
      for (let x = c0; x < c1; x++) {
        const p = rowOff + x * ncomp;
        for (let k = 0; k < ncomp; k++) put(p + k, samples[k]);
      }
    } else if (bpc === 16) {
      for (let x = c0; x < c1; x++) {
        const p = rowOff + x * ncomp * 2;
        for (let k = 0; k < ncomp; k++) {
          put(p + 2 * k, samples[k] >> 8);
          put(p + 2 * k + 1, samples[k] & 0xff);
        }
      }
    } else {
      for (let x = c0; x < c1; x++) {
        for (let k = 0; k < ncomp; k++) {
          const bit = (x * ncomp + k) * bpc;
          const byte = rowOff + (bit >> 3);
          const shift = 8 - bpc - (bit & 7);
          const mask = ((1 << bpc) - 1) << shift;
          put(byte, (data[byte] & ~mask) | ((samples[k] << shift) & mask));
        }
      }
    }
  }
  // Already the fill colour everywhere (e.g. redacted twice): keep the image as is.
  if (!touched) return 'unchanged';

  const nd = dict.clone();
  nd.set(N('Filter'), N('FlateDecode'));
  nd.delete(N('DecodeParms'));
  nd.delete(N('DL'));
  nd.delete(N('Length'));
  if (fromJpeg) {
    nd.set(N('ColorSpace'), N('DeviceRGB'));
    nd.set(N('BitsPerComponent'), PDFNumber.of(8));
    nd.set(N('Width'), PDFNumber.of(width));
    nd.set(N('Height'), PDFNumber.of(height));
    nd.delete(N('Decode'));
  }
  if (newColorSpace) nd.set(N('ColorSpace'), newColorSpace);
  return PDFRawStream.of(nd, zlibSync(data));
}

// ---------------------------------------------------------------------------
// Annotations
// ---------------------------------------------------------------------------

interface AnnotPlan {
  kept: PDFObject[];
  removed: PDFObject[];
  removedWidgets: PDFRef[];
}

function planAnnotations(context: PDFContext, annots: PDFArray, rects: BBox[], keepWidgets: boolean): AnnotPlan | null {
  const entries = annots.asArray();
  const dicts = entries.map((e) => lookup(context, e));
  const removed = new Set<PDFDict>();

  dicts.forEach((d) => {
    if (!(d instanceof PDFDict)) return;
    const subtype = nameVal(dictGet(d, 'Subtype'));
    if (subtype === 'Popup') return; // decided by its parent below
    if (subtype === 'Widget' && keepWidgets) return;
    const r = numArray(context, d.get(N('Rect')));
    if (!r || r.length !== 4) return;
    const box = { x0: Math.min(r[0], r[2]), y0: Math.min(r[1], r[3]), x1: Math.max(r[0], r[2]), y1: Math.max(r[1], r[3]) };
    if (intersectsRects(box, rects)) removed.add(d);
  });
  if (!removed.size) return null;

  // Popups of removed annotations, and replies (IRT) to them, go too.
  let grew = true;
  while (grew) {
    grew = false;
    for (const d of dicts) {
      if (!(d instanceof PDFDict) || removed.has(d)) continue;
      const subtype = nameVal(dictGet(d, 'Subtype'));
      if (subtype === 'Widget' && keepWidgets) continue;
      const parent = dictGet(d, 'Parent');
      const irt = dictGet(d, 'IRT');
      if ((subtype === 'Popup' && parent instanceof PDFDict && removed.has(parent)) || (irt instanceof PDFDict && removed.has(irt))) {
        removed.add(d);
        grew = true;
      }
    }
  }

  const kept: PDFObject[] = [];
  const removedEntries: PDFObject[] = [];
  const removedWidgets: PDFRef[] = [];
  entries.forEach((e, i) => {
    const d = dicts[i];
    if (d instanceof PDFDict && removed.has(d)) {
      removedEntries.push(e);
      if (e instanceof PDFRef && nameVal(dictGet(d, 'Subtype')) === 'Widget') removedWidgets.push(e);
    } else kept.push(e);
  });
  return { kept, removed: removedEntries, removedWidgets };
}

/** Detach removed widget annotations from the AcroForm field tree. */
function detachWidgets(context: PDFContext, widgets: PDFRef[]): void {
  const catalog = lookup(context, context.trailerInfo.Root);
  const acroForm = catalog instanceof PDFDict ? dictGet(catalog, 'AcroForm') : undefined;
  const fields = acroForm instanceof PDFDict ? dictGet(acroForm, 'Fields') : undefined;
  const removeFrom = (arr: PDFObject | undefined, ref: PDFRef): boolean => {
    if (!(arr instanceof PDFArray)) return false;
    const idx = arr.asArray().findIndex((x) => x === ref);
    if (idx < 0) return false;
    arr.remove(idx);
    return true;
  };
  for (const w of widgets) {
    let node: PDFRef = w;
    // Walk up: remove the node from its parent's Kids (or Fields); continue while the parent became empty.
    for (let depth = 0; depth < 32; depth++) {
      const d = lookup(context, node);
      const parentRaw = d instanceof PDFDict ? d.get(N('Parent')) : undefined;
      const parent = lookup(context, parentRaw);
      if (parent instanceof PDFDict && parentRaw instanceof PDFRef && parent !== d) {
        const kids = dictGet(parent, 'Kids');
        removeFrom(kids, node);
        removeFrom(fields, node);
        if (kids instanceof PDFArray && kids.size() === 0) {
          node = parentRaw;
          continue;
        }
      } else removeFrom(fields, node);
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function readPageContents(context: PDFContext, contentsRaw: PDFObject | undefined): { bytes: Uint8Array; refs: PDFRef[] } {
  const refs: PDFRef[] = [];
  const parts: Uint8Array[] = [];
  if (contentsRaw instanceof PDFRef) refs.push(contentsRaw);
  const contents = lookup(context, contentsRaw);
  const pushStream = (raw: PDFObject | undefined) => {
    const s = lookup(context, raw);
    if (raw instanceof PDFRef) refs.push(raw);
    if (s instanceof PDFStream) parts.push(getStreamBytes(s));
  };
  if (contents instanceof PDFStream) parts.push(getStreamBytes(contents));
  else if (contents instanceof PDFArray) for (const item of contents.asArray()) pushStream(item);

  // Concatenate with a newline between streams (streams may split at token boundaries).
  const total = parts.reduce((n, p) => n + p.length + 1, 0);
  const bytes = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    bytes.set(p, off);
    off += p.length;
    bytes[off++] = 0x0a;
  }
  return { bytes, refs };
}

function emptyReport(): RedactReport {
  return { glyphsRemoved: 0, imagesModified: 0, imagesRemoved: 0, pathsRemoved: 0, annotationsRemoved: 0, xobjectsCloned: 0 };
}

/**
 * Truly redact `rects` on `page`: removes text glyphs, image pixels, vector
 * paths and annotations inside the rects from the file, then (unless
 * `fillColor` is null) paints opaque boxes over them.
 *
 * Throws a descriptive Error if the page can't be processed (e.g. its content
 * stream uses an unsupported filter); in that case the document is unchanged.
 */
export async function redactPage(
  doc: PDFDocument,
  page: PDFPage,
  rects: PdfRect[],
  opts: RedactOptions = {},
): Promise<RedactReport> {
  const report = emptyReport();
  const nrects = (rects ?? []).map(normRect).filter((r): r is BBox => r !== null);
  if (!nrects.length) return report;

  const context = doc.context;
  const node = page.node;
  const fillColor = opts.fillColor === undefined ? ([0, 0, 0] as [number, number, number]) : opts.fillColor;
  const ctx: Ctx = {
    context,
    rects: nrects,
    removeText: opts.removeText !== false,
    images: opts.images ?? 'pixels',
    removeVectors: opts.removeVectors !== false,
    pixelColor: fillColor ?? [0, 0, 0],
    codec: opts.codec,
    report,
    formStack: [],
    candidates: new Set(),
    created: [],
  };

  // ---- compute (existing objects are not mutated in this phase) -------------
  const contentsRaw = node.get(PDFName.Contents);
  const resourcesRaw = node.get(PDFName.Resources);
  const annotsRaw = node.get(PDFName.Annots);
  let scope: ResourceScope;
  let result: RewriteResult;
  let oldContentRefs: PDFRef[] = [];
  let annotPlan: AnnotPlan | null = null;
  let newContentRef: PDFRef | undefined;
  try {
    const read = readPageContents(context, contentsRaw);
    oldContentRefs = read.refs;
    const ops = parseContentStream(read.bytes);
    const resources = node.Resources(); // handles inheritance from /Pages
    scope = new ResourceScope(context, resources instanceof PDFDict ? resources : undefined);
    result = await new ContentRewriter(ctx, scope, initialGState(IDENTITY), true).run(ops);
    if (result.changed) scope.prune(result.ops);

    const annots = lookup(context, annotsRaw);
    if (opts.removeAnnotations !== false && annots instanceof PDFArray) {
      annotPlan = planAnnotations(context, annots, nrects, opts.keepWidgets !== false);
    }

    if (result.changed || fillColor !== null) {
      // Wrap the original content in q…Q (closing anything left open) so the
      // boxes, and anything drawn later, start from the default graphics state.
      const body = serializeContentStream(result.ops);
      let tail = '\n';
      if (result.inText) tail += 'ET\n';
      tail += 'EMC\n'.repeat(result.openMarked);
      tail += 'Q\n'.repeat(result.qDepth);
      tail += 'Q\n';
      if (fillColor) {
        const [r, g, b] = fillColor.map((v) => formatNumber(Math.min(1, Math.max(0, Number(v) || 0))));
        tail += `q\n${r} ${g} ${b} rg\n`;
        for (const rc of nrects) {
          tail += `${formatNumber(rc.x0)} ${formatNumber(rc.y0)} ${formatNumber(rc.x1 - rc.x0)} ${formatNumber(rc.y1 - rc.y0)} re\n`;
        }
        tail += 'f\nQ\n';
      }
      const head = textEncoder.encode('q\n');
      const tailBytes = textEncoder.encode(tail);
      const all = new Uint8Array(head.length + body.length + tailBytes.length);
      all.set(head, 0);
      all.set(body, head.length);
      all.set(tailBytes, head.length + body.length);
      newContentRef = context.register(context.flateStream(all));
      ctx.created.push(newContentRef);
    }
  } catch (err) {
    for (const ref of ctx.created) {
      try {
        context.delete(ref);
      } catch {
        /* ignore */
      }
    }
    throw new Error(`redactPage: could not redact page ${pageLabel(page)}: ${errorMessage(err)}`);
  }

  // ---- commit ------------------------------------------------------------------
  if (newContentRef) {
    // Always an array, so pdf-lib's own content-stream helpers keep working.
    node.set(PDFName.Contents, context.obj([newContentRef]));
    if (contentsRaw instanceof PDFRef) ctx.candidates.add(contentsRaw);
    for (const r of oldContentRefs) ctx.candidates.add(r);
    // PDFPage caches the stream it draws into; it is no longer part of /Contents.
    const p = page as unknown as { contentStream?: unknown; contentStreamRef?: unknown };
    p.contentStream = undefined;
    p.contentStreamRef = undefined;
  }
  if (scope.changed && scope.result) {
    node.set(PDFName.Resources, scope.result);
    for (const r of scope.originalRefs(resourcesRaw)) ctx.candidates.add(r);
  }
  const removedAnnotRefs: PDFRef[] = [];
  if (annotPlan) {
    node.set(PDFName.Annots, context.obj(annotPlan.kept));
    if (annotsRaw instanceof PDFRef) ctx.candidates.add(annotsRaw);
    for (const e of annotPlan.removed) {
      if (e instanceof PDFRef) {
        ctx.candidates.add(e);
        removedAnnotRefs.push(e);
      }
    }
    if (annotPlan.removedWidgets.length) detachWidgets(context, annotPlan.removedWidgets);
    report.annotationsRemoved = annotPlan.removed.length;
  }
  if (result.changed || annotPlan) node.delete(PDFName.of('Thumb')); // stale rendered thumbnail

  // ---- cleanup: make sure the replaced originals are not written on save -------
  try {
    const xobjects = Array.from(ctx.candidates).filter((ref) => {
      const o = lookup(context, ref);
      const st = o instanceof PDFStream ? nameVal(dictGet(o.dict, 'Subtype')) : undefined;
      return st === 'Image' || st === 'Form';
    });
    unlinkUnusedXObjects(doc, xobjects);
    deleteOrphans(context, ctx.candidates);
    // Removed annotations that survived (still referenced elsewhere) lose their content.
    const survivors = removedAnnotRefs.filter((r) => context.lookup(r) !== undefined);
    deleteOrphans(context, neutralizeAnnotations(doc, survivors));
  } catch (err) {
    throw new Error(
      `redactPage: page ${pageLabel(page)} was rewritten but removing the replaced objects failed ` +
        `(original data may remain in the file): ${errorMessage(err)}`,
    );
  }
  return report;
}

function pageLabel(page: PDFPage): string {
  try {
    return page.ref.toString();
  } catch {
    return '?';
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
