/**
 * Shared helpers for the tools tests: assertions, temp files, a jpeg-js based
 * ImageCodec, PNG encoding, pdf.js text extraction and poppler wrappers.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

const deps = process.env.TOOLS_TEST_DEPS || '/tmp/tools-test-deps';
const req = createRequire(join(deps, 'node_modules', 'noop.js'));
export const jpeg = req('jpeg-js');
export const { PNG } = req('pngjs');

export class AssertionError extends Error {}
export function assert(cond, msg) {
  if (!cond) throw new AssertionError(msg);
}
export function near(a, b, tol, msg) {
  if (!(Math.abs(a - b) <= tol)) throw new AssertionError(`${msg}: expected ${b}, got ${a} (tol ${tol})`);
}

/** Fresh directory under the run's work dir. */
export function tempDir(prefix = 't') {
  return mkdtempSync(join(process.env.TOOLS_TEST_WORK || '/tmp', prefix + '-'));
}

export function writeTemp(name, bytes) {
  const dir = tempDir('f');
  const file = join(dir, name);
  writeFileSync(file, bytes);
  return file;
}

// ---------------------------------------------------------------------------
// Image codecs (Node stand-ins for the browser canvas codec)
// ---------------------------------------------------------------------------

export function makeCodec(stats = {}) {
  return {
    async decode(bytes, mime) {
      stats.decodes = (stats.decodes ?? 0) + 1;
      if (stats.rejectApp1) {
        for (let i = 2; i + 1 < bytes.length; ) {
          if (bytes[i] !== 0xff) break;
          const m = bytes[i + 1];
          if (m === 0xda) break;
          if (m === 0xe1 || m === 0xe2) throw new Error('codec received APP1/APP2 metadata');
          i += 2 + ((bytes[i + 2] << 8) | bytes[i + 3]);
        }
      }
      assert(mime === 'image/jpeg', 'mime');
      const r = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 2048, maxResolutionInMP: 400 });
      return { width: r.width, height: r.height, data: new Uint8ClampedArray(r.data.buffer, r.data.byteOffset, r.data.length) };
    },
    async encodeJpeg(img, quality) {
      stats.encodes = (stats.encodes ?? 0) + 1;
      const r = jpeg.encode({ width: img.width, height: img.height, data: Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length) }, Math.round(quality * 100));
      return new Uint8Array(r.data);
    },
  };
}

/** Encode RGBA/RGB/gray pixels as JPEG (jpeg-js always writes 3-component YCbCr). */
export function encodeJpeg(width, height, rgba, quality = 92) {
  return new Uint8Array(jpeg.encode({ width, height, data: Buffer.from(rgba) }, quality).data);
}

export function encodePng(width, height, rgba) {
  const png = new PNG({ width, height });
  png.data = Buffer.from(rgba);
  return new Uint8Array(PNG.sync.write(png));
}

export function decodePng(bytes) {
  const p = PNG.sync.read(Buffer.from(bytes));
  return { width: p.width, height: p.height, data: p.data };
}

/** Deterministic PRNG. */
export function rng(seed = 1) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

/** Photo-like RGBA: smooth gradients + blobs + mild noise. */
export function photoPixels(w, h, seed = 7, alphaFn) {
  const r = rng(seed);
  const data = new Uint8Array(w * h * 4);
  const blobs = Array.from({ length: 6 }, () => [r() * w, r() * h, (0.1 + r() * 0.3) * Math.max(w, h), r() * 255, r() * 255, r() * 255]);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let R = (x / w) * 200 + 30, G = (y / h) * 180 + 40, B = ((x + y) / (w + h)) * 150 + 60;
      for (const [bx, by, br, cr, cg, cb] of blobs) {
        const d = Math.hypot(x - bx, y - by) / br;
        if (d < 1) {
          const t = (1 - d) * 0.7;
          R = R * (1 - t) + cr * t;
          G = G * (1 - t) + cg * t;
          B = B * (1 - t) + cb * t;
        }
      }
      const n = (r() - 0.5) * 24;
      const o = (y * w + x) * 4;
      data[o] = Math.max(0, Math.min(255, R + n));
      data[o + 1] = Math.max(0, Math.min(255, G + n));
      data[o + 2] = Math.max(0, Math.min(255, B + n));
      data[o + 3] = alphaFn ? alphaFn(x, y) : 255;
    }
  }
  return data;
}

// ---------------------------------------------------------------------------
// pdf.js
// ---------------------------------------------------------------------------

export async function openPdfjs(bytes, password) {
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    password,
    verbosity: 0,
    disableFontFace: true,
    isEvalSupported: false,
    useSystemFonts: false,
  });
  return { doc: await task.promise, destroy: () => task.destroy() };
}

/** Text items per page via pdf.js. */
export async function pdfjsItems(bytes, password) {
  const { doc, destroy } = await openPdfjs(bytes, password);
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    pages.push({ view: page.view, items: tc.items.filter((it) => 'str' in it) });
  }
  await destroy();
  return pages;
}

export async function pdfjsText(bytes, password) {
  const pages = await pdfjsItems(bytes, password);
  return pages.map((p) => p.items.map((i) => i.str).join(' ').replace(/\s+/g, ' ').trim());
}

// ---------------------------------------------------------------------------
// poppler
// ---------------------------------------------------------------------------

export function hasTool(name) {
  try {
    execFileSync('which', [name], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** `pdfimages -list` rows. */
export function pdfImagesList(bytes) {
  const file = writeTemp('in.pdf', bytes);
  const out = execFileSync('pdfimages', ['-list', file], { encoding: 'utf8' });
  return out
    .split('\n')
    .slice(2)
    .filter((l) => l.trim())
    .map((l) => {
      const c = l.trim().split(/\s+/);
      return { page: +c[0], type: c[2], width: +c[3], height: +c[4], color: c[5], comp: +c[6], bpc: +c[7], enc: c[8], object: +c[10], xppi: +c[12], yppi: +c[13] };
    });
}

/** Render page 1..n at `dpi` with pdftoppm; returns decoded PNGs. */
export function renderPages(bytes, dpi = 50, password) {
  const dir = tempDir('r');
  const file = join(dir, 'in.pdf');
  writeFileSync(file, bytes);
  const args = ['-r', String(dpi), '-png'];
  if (password !== undefined) args.push('-upw', password);
  execFileSync('pdftoppm', [...args, file, join(dir, 'p')], { stdio: ['ignore', 'ignore', 'pipe'] });
  const files = execFileSync('ls', [dir], { encoding: 'utf8' })
    .split('\n')
    .filter((f) => f.startsWith('p') && f.endsWith('.png'))
    .sort();
  return files.map((f) => decodePng(readFileSync(join(dir, f))));
}

/** Mean absolute per-channel difference (0..255) between two renders. */
export function meanAbsDiff(a, b) {
  assert(a.width === b.width && a.height === b.height, `render size mismatch ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  let sum = 0;
  let n = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    for (let k = 0; k < 3; k++) sum += Math.abs(a.data[i + k] - b.data[i + k]);
    n += 3;
  }
  return sum / n;
}

export function pdftotext(bytes, extra = []) {
  const file = writeTemp('in.pdf', bytes);
  return execFileSync('pdftotext', [...extra, file, '-'], { encoding: 'utf8' });
}

export function python(code, args = []) {
  return execFileSync('python3', ['-I', '-c', code, ...args], { encoding: 'utf8' });
}
