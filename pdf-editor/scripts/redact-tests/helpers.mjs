/**
 * Verification helpers: pdf.js text extraction, poppler word boxes and
 * rendering (independent PDF engine), pixel comparison and "is the secret still
 * anywhere in the file" scanning.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PDFArray, PDFDocument, PDFName, PDFRawStream, PDFStream, decodePDFRawStream } from '@cantoo/pdf-lib';

const here = dirname(fileURLToPath(import.meta.url));

export class AssertionError extends Error {}
export function assert(cond, msg) {
  if (!cond) throw new AssertionError(msg);
}
export function near(a, b, tol, msg) {
  if (!(Math.abs(a - b) <= tol)) throw new AssertionError(`${msg}: expected ${b}, got ${a} (tol ${tol})`);
}

/** Save generated PDFs for manual inspection when KEEP_OUTPUT=1. */
export function keep(name, bytes) {
  if (!process.env.KEEP_OUTPUT) return;
  const dir = join(here, '.out');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), bytes);
}

function withTempFile(bytes, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'redact-test-'));
  try {
    const file = join(dir, 'in.pdf');
    writeFileSync(file, bytes);
    return fn(file, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// pdf.js
// ---------------------------------------------------------------------------

/** Text items per page via pdf.js getTextContent(). */
export async function pdfjsText(bytes) {
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    verbosity: 0,
    disableFontFace: true,
    isEvalSupported: false,
    useSystemFonts: false,
  });
  const doc = await task.promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    pages.push(tc.items.filter((it) => 'str' in it).map((it) => ({ str: it.str, transform: it.transform, width: it.width })));
  }
  await task.destroy();
  return pages;
}

export const joinText = (items) => items.map((i) => i.str).join(' ').replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------------------
// poppler
// ---------------------------------------------------------------------------

const decodeEntities = (s) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d)).replace(/&amp;/g, '&');

/**
 * Word boxes from `pdftotext -bbox` converted to PDF user space (bottom-left
 * origin; assumes MediaBox at 0,0 and no /Rotate).
 */
export function popplerWords(bytes, pageNo = 1) {
  const html = withTempFile(bytes, (file) =>
    execFileSync('pdftotext', ['-q', '-bbox', '-f', String(pageNo), '-l', String(pageNo), file, '-'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }),
  );
  const pageM = /<page width="([\d.]+)" height="([\d.]+)">/.exec(html);
  const H = pageM ? parseFloat(pageM[2]) : 792;
  const words = [];
  const re = /<word xMin="([-\d.]+)" yMin="([-\d.]+)" xMax="([-\d.]+)" yMax="([-\d.]+)">([^<]*)<\/word>/g;
  let m;
  while ((m = re.exec(html))) {
    const [xMin, yMin, xMax, yMax] = m.slice(1, 5).map(parseFloat);
    words.push({ text: decodeEntities(m[5]), x0: xMin, x1: xMax, y0: H - yMax, y1: H - yMin });
  }
  return words;
}

/** Rect (user space) of the n-th occurrence of `word` on a page, shrunk horizontally by `shrink`. */
export function wordRect(bytes, pageNo, word, nth = 0, shrink = 0.25) {
  const hits = popplerWords(bytes, pageNo).filter((w) => w.text === word);
  assert(hits.length > nth, `word "${word}" not found on page ${pageNo}`);
  const w = hits[nth];
  return { x: w.x0 + shrink, y: w.y0, width: w.x1 - w.x0 - 2 * shrink, height: w.y1 - w.y0 };
}

/**
 * Compare poppler words before/after: every word not in `removedRects` must
 * still be present at the same position (± tol) and no other word may appear.
 * Words centred in `ignoreRects` are skipped on both sides.
 */
export function compareWords(before, after, pageNo, removedRects, tol = 0.02, ignoreRects = []) {
  const centreIn = (rects) => (w) =>
    rects.some((r) => {
      const cx = (w.x0 + w.x1) / 2;
      const cy = (w.y0 + w.y1) / 2;
      return cx >= r.x && cx <= r.x + r.width && cy >= r.y && cy <= r.y + r.height;
    });
  const ignored = centreIn(ignoreRects);
  const wb = popplerWords(before, pageNo).filter((w) => !ignored(w));
  const wa = popplerWords(after, pageNo).filter((w) => !ignored(w));
  const inRemoved = centreIn(removedRects);
  const expected = wb.filter((w) => !inRemoved(w));
  const key = (w) => `${w.text}@${w.x0.toFixed(1)},${w.y0.toFixed(1)}`;
  const missing = [];
  const moved = [];
  const pool = wa.slice();
  for (const w of expected) {
    const idx = pool.findIndex((a) => a.text === w.text && Math.abs(a.x0 - w.x0) <= tol && Math.abs(a.y0 - w.y0) <= tol && Math.abs(a.x1 - w.x1) <= tol);
    if (idx >= 0) pool.splice(idx, 1);
    else {
      const similar = pool.find((a) => a.text === w.text);
      if (similar) moved.push(`${key(w)} -> ${key(similar)}`);
      else missing.push(key(w));
    }
  }
  return { expectedCount: expected.length, removedCount: wb.length - expected.length, missing, moved, extra: pool.map(key) };
}

/** Render a page with pdftoppm → { width, height, data (RGB) }. */
export function render(bytes, pageNo = 1, dpi = 144) {
  return withTempFile(bytes, (file, dir) => {
    execFileSync('pdftoppm', ['-q', '-r', String(dpi), '-f', String(pageNo), '-l', String(pageNo), '-singlefile', file, join(dir, 'out')], { stdio: 'ignore' });
    const buf = readFileSync(join(dir, 'out.ppm'));
    // Parse binary PPM (P6) header.
    let pos = 0;
    const tokens = [];
    while (tokens.length < 4) {
      while (buf[pos] === 0x20 || buf[pos] === 0x0a || buf[pos] === 0x0d || buf[pos] === 0x09) pos++;
      if (buf[pos] === 0x23) {
        while (buf[pos] !== 0x0a) pos++;
        continue;
      }
      let t = '';
      while (buf[pos] > 0x20) t += String.fromCharCode(buf[pos++]);
      tokens.push(t);
    }
    pos++;
    const [, w, h] = tokens;
    return { width: +w, height: +h, dpi, data: buf.subarray(pos) };
  });
}

/**
 * Pixel comparison. `ignore` is a list of user-space rects (or polygons as
 * arrays of [x,y]) excluded from the outside-comparison (expanded by
 * `marginPt`). Also reports pixels inside `fillRects` (shrunk by 1px) that
 * aren't the expected fill colour.
 */
export function comparePixels(before, after, pageHeight, { ignore = [], fillRects = [], fill = [0, 0, 0], marginPt = 1, tol = 8 } = {}) {
  assert(before.width === after.width && before.height === after.height, 'render sizes differ');
  const s = before.dpi / 72;
  pageHeight = pageHeight ?? before.height / s;
  const polys = ignore.map((r) =>
    Array.isArray(r)
      ? r
      : [[r.x - marginPt, r.y - marginPt], [r.x + r.width + marginPt, r.y - marginPt], [r.x + r.width + marginPt, r.y + r.height + marginPt], [r.x - marginPt, r.y + r.height + marginPt]],
  );
  const inPoly = (x, y, poly) => {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i];
      const [xj, yj] = poly[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  let diffOutside = 0;
  let badInside = 0;
  let inside = 0;
  const fill255 = fill.map((v) => Math.round(v * 255));
  for (let py = 0; py < before.height; py++) {
    for (let px = 0; px < before.width; px++) {
      const x = (px + 0.5) / s;
      const y = pageHeight - (py + 0.5) / s;
      const o = (py * before.width + px) * 3;
      const inFill = fillRects.some((r) => x >= r.x + 1 / s && x <= r.x + r.width - 1 / s && y >= r.y + 1 / s && y <= r.y + r.height - 1 / s);
      if (inFill) {
        inside++;
        for (let k = 0; k < 3; k++) if (Math.abs(after.data[o + k] - fill255[k]) > tol) {
          badInside++;
          break;
        }
        continue;
      }
      if (polys.some((p) => inPoly(x, y, p))) continue;
      for (let k = 0; k < 3; k++) {
        if (Math.abs(before.data[o + k] - after.data[o + k]) > tol) {
          diffOutside++;
          break;
        }
      }
    }
  }
  return { diffOutside, badInside, inside };
}

// ---------------------------------------------------------------------------
// Secret scanning
// ---------------------------------------------------------------------------

const toHex = (s) => Array.from(s, (c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');

/**
 * Search every object of the saved file (decoded streams, dicts, strings) and
 * the raw bytes for `needles` (as text, lower/upper-case hex). Returns hits.
 */
export async function findInFile(bytes, needles) {
  const hits = [];
  const raw = Buffer.from(bytes).toString('latin1');
  const forms = (n) => [n, toHex(n), toHex(n).toUpperCase()];
  for (const n of needles) for (const f of forms(n)) if (raw.includes(f)) hits.push(`raw file contains ${JSON.stringify(f)}`);
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    let text = '';
    if (obj instanceof PDFRawStream) {
      try {
        text = Buffer.from(decodePDFRawStream(obj).decode()).toString('latin1');
      } catch {
        text = '';
      }
      text += obj.dict.toString();
    } else if (!(obj instanceof PDFStream)) text = obj.toString();
    for (const n of needles) for (const f of forms(n)) if (text.includes(f)) hits.push(`${ref} contains ${JSON.stringify(f)}`);
  }
  return hits;
}

/** Decoded (latin1) text of all /Contents streams of a page. */
export function pageContentText(doc, pageIndex) {
  const page = doc.getPage(pageIndex);
  const ctx = doc.context;
  const c = ctx.lookup(page.node.get(PDFName.of('Contents')));
  const streams = c instanceof PDFArray ? c.asArray().map((r) => ctx.lookup(r)) : [c];
  return streams
    .filter((s) => s instanceof PDFRawStream)
    .map((s) => Buffer.from(decodePDFRawStream(s).decode()).toString('latin1'))
    .join('\n');
}
