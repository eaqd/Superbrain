/** Tests for lib/pdf/tools/compress.ts */
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  StandardFonts,
  concatTransformationMatrix,
  drawObject,
  popGraphicsState,
  pushGraphicsState,
  rgb,
} from '@cantoo/pdf-lib';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import {
  assert,
  encodeJpeg,
  encodePng,
  jpeg,
  makeCodec,
  meanAbsDiff,
  pdfImagesList,
  pdfjsText,
  pdftotext,
  photoPixels,
  renderPages,
  rng,
} from './helpers.mjs';

const N = (s) => PDFName.of(s);
const num = (o) => (o instanceof PDFNumber ? o.asNumber() : undefined);

function imageStream(doc, dict, contents) {
  return doc.context.register(PDFRawStream.of(doc.context.obj({ Type: 'XObject', Subtype: 'Image', ...dict }), contents));
}

function formStream(doc, content, dict) {
  return doc.context.register(
    PDFRawStream.of(doc.context.obj({ Type: 'XObject', Subtype: 'Form', ...dict, Filter: 'FlateDecode' }), deflateSync(Buffer.from(content))),
  );
}

/** Page with a hand-written content stream and resources. */
function rawPage(doc, content, resources, size = [612, 792]) {
  const page = doc.addPage(size);
  page.node.set(N('Resources'), doc.context.obj(resources));
  page.node.set(N('Contents'), doc.context.register(doc.context.flateStream(content)));
  return page;
}

function drawXObject(page, ref, x, y, w, h) {
  const name = page.node.newXObject('Im', ref);
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(w, 0, 0, h, x, y), drawObject(name), popGraphicsState());
}

async function loadOut(bytes) {
  return PDFDocument.load(bytes, { updateMetadata: false });
}

function dims(doc, ref) {
  const s = doc.context.lookup(PDFRef.of(ref.objectNumber, ref.generationNumber));
  assert(s instanceof PDFStream, `object ${ref} missing`);
  return { w: num(s.dict.lookup(N('Width'))), h: num(s.dict.lookup(N('Height'))), filter: s.dict.lookup(N('Filter'))?.toString(), stream: s };
}

/** Insert APP1 (Exif, orientation 6) and APP2 (ICC) segments after SOI. */
function withExifAndIcc(jpg) {
  const seg = (marker, payload) => {
    const len = payload.length + 2;
    return [0xff, marker, len >> 8, len & 0xff, ...payload];
  };
  const exif = [...Buffer.from('Exif\0\0'), 0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0];
  const icc = [...Buffer.from('ICC_PROFILE\0'), 1, 1, ...new Array(64).fill(7)];
  return new Uint8Array([0xff, 0xd8, ...seg(0xe1, exif), ...seg(0xe2, icc), ...jpg.subarray(2)]);
}

async function compress(lib, bytes, opts, stats = {}) {
  const msgs = [];
  const t0 = Date.now();
  const res = await lib.compressPdf(bytes, { quality: 0.7, maxDpi: 150, onProgress: (m) => msgs.push(m), ...opts }, makeCodec(stats));
  res.ms = Date.now() - t0;
  res.msgs = msgs;
  assert(res.bytes.length <= bytes.length, `output grew: ${bytes.length} -> ${res.bytes.length}`);
  assert(res.report.before === bytes.length && res.report.after === res.bytes.length, 'report sizes');
  return res;
}

const kb = (n) => `${(n / 1024).toFixed(0)} KB`;

export const tests = [
  {
    name: 'compress: 3000x2000 JPEG drawn at 300x200pt is downsampled to 150 dpi',
    async run({ compress: lib }) {
      const W = 3000, H = 2000;
      const jpg = encodeJpeg(W, H, photoPixels(W, H, 3), 92);
      const doc = await PDFDocument.create();
      const page = doc.addPage([612, 792]);
      const img = await doc.embedJpg(jpg);
      page.drawImage(img, { x: 100, y: 400, width: 300, height: 200 });
      const font = await doc.embedFont(StandardFonts.Helvetica);
      page.drawText('Caption under the photo', { x: 100, y: 380, size: 12, font });
      const input = await doc.save();

      const res = await compress(lib, input, {});
      const r = res.report;
      assert(r.imagesTotal === 1 && r.imagesRecompressed === 1 && r.imagesDownsampled === 1, JSON.stringify(r));
      assert(r.after < r.before * 0.15, `not much smaller: ${r.before} -> ${r.after}`);
      const list = pdfImagesList(res.bytes);
      assert(list.length === 1 && list[0].width === 625 && list[0].height === 417 && list[0].enc === 'jpeg', JSON.stringify(list));
      assert(Math.abs(list[0].xppi - 150) <= 1, `ppi ${list[0].xppi}`);
      const [a] = renderPages(input, 72);
      const [b] = renderPages(res.bytes, 72);
      const diff = meanAbsDiff(a, b);
      assert(diff < 4, `render diff ${diff}`);
      const text = await pdfjsText(res.bytes);
      assert(text[0] === 'Caption under the photo', text[0]);
      assert(res.msgs.some((m) => /image 1 of 1/i.test(m)), 'progress messages');
      return [`${kb(r.before)} -> ${kb(r.after)} in ${res.ms} ms, render diff ${diff.toFixed(2)}`];
    },
  },
  {
    name: 'compress: Flate RGB and RGBA (SMask) images resampled consistently',
    async run({ compress: lib }) {
      const doc = await PDFDocument.create();
      const page = doc.addPage([612, 792]);
      const rgbPng = encodePng(2000, 1500, photoPixels(2000, 1500, 11));
      const rgbaPng = encodePng(1200, 1200, photoPixels(1200, 1200, 12, (x, y) => (Math.hypot(x - 600, y - 600) < 500 ? 255 : Math.max(0, 255 - (Math.hypot(x - 600, y - 600) - 500) * 2))));
      const i1 = await doc.embedPng(rgbPng);
      const i2 = await doc.embedPng(rgbaPng);
      page.drawRectangle({ x: 300, y: 300, width: 200, height: 200, color: rgb(0.1, 0.5, 0.9) });
      page.drawImage(i1, { x: 50, y: 550, width: 200, height: 150 });
      page.drawImage(i2, { x: 330, y: 330, width: 144, height: 144 });
      const input = await doc.save();

      const res = await compress(lib, input, {});
      const r = res.report;
      assert(r.imagesTotal === 2 && r.imagesRecompressed === 2 && r.imagesDownsampled === 2, JSON.stringify(r));
      const list = pdfImagesList(res.bytes);
      const main = list.filter((l) => l.type === 'image');
      const smask = list.filter((l) => l.type === 'smask');
      const rgbImg = main.find((l) => l.width === 417 && l.height === 313);
      const alphaImg = main.find((l) => l.width === 300 && l.height === 300);
      assert(rgbImg && alphaImg, JSON.stringify(list));
      assert(smask.length === 1 && smask[0].width === 300 && smask[0].height === 300, `smask ${JSON.stringify(smask)}`);
      const [a] = renderPages(input, 72);
      const [b] = renderPages(res.bytes, 72);
      const diff = meanAbsDiff(a, b);
      assert(diff < 3, `render diff ${diff}`);
      return [`${kb(r.before)} -> ${kb(r.after)}; rgb ${rgbImg.enc}, rgba ${alphaImg.enc} + smask ${smask[0].enc}; diff ${diff.toFixed(2)}`];
    },
  },
  {
    name: 'compress: text-only PDF never grows and text survives',
    async run({ compress: lib }) {
      const doc = await PDFDocument.create();
      const font = await doc.embedFont(StandardFonts.TimesRoman);
      const lines = [];
      for (let p = 0; p < 3; p++) {
        const page = doc.addPage([612, 792]);
        for (let i = 0; i < 40; i++) {
          const line = `Page ${p + 1} line ${i + 1}: the quick brown fox jumps over the lazy dog.`;
          page.drawText(line, { x: 50, y: 740 - i * 17, size: 11, font });
          lines.push(line);
        }
      }
      const input = await doc.save();
      const before = await pdfjsText(input);
      const res = await compress(lib, input, { removeMetadata: true });
      const after = await pdfjsText(res.bytes);
      assert(JSON.stringify(before) === JSON.stringify(after), 'text changed');
      // A second pass over the optimized output must not grow either.
      const again = await compress(lib, res.bytes, {});
      assert(again.bytes.length <= res.bytes.length, 'second pass grew');
      // A minimal hand-written PDF that can't shrink comes back unchanged (same array).
      const tiny = new TextEncoder().encode(
        '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 10 10]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF',
      );
      const t = await compress(lib, tiny, {});
      assert(t.bytes === tiny && t.report.unchanged === true && t.report.after === tiny.length, `tiny: ${t.bytes.length} vs ${tiny.length}`);
      return [`${input.length} -> ${res.bytes.length} bytes (second pass ${again.bytes.length}); tiny file returned unchanged`];
    },
  },
  {
    name: 'compress: effective DPI through nested forms, multiple uses, annotations, patterns',
    async run({ compress: lib }) {
      const doc = await PDFDocument.create();
      const ctx = doc.context;
      const jpg = (w, h, seed) => imageStream(doc, { Width: w, Height: h, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'DCTDecode' }, encodeJpeg(w, h, photoPixels(w, h, seed), 92));
      const imForm = jpg(2000, 2000, 21); // drawn via nested forms at 200pt
      const imTwice = jpg(1500, 1500, 22); // 72pt on page 1, 288pt on page 2
      const imAnnot = jpg(1000, 1000, 23); // only in an annotation appearance (72pt)
      const imPattern = jpg(1000, 1000, 24); // only inside a tiling pattern (unmeasurable)
      const inner = formStream(doc, 'q 1 0 0 1 0 0 cm /I0 Do Q', { BBox: [0, 0, 1, 1], Resources: { XObject: { I0: imForm } } });
      const outer = formStream(doc, 'q 2 0 0 2 0 0 cm /F0 Do Q', { BBox: [0, 0, 2, 2], Matrix: [0.5, 0, 0, 0.5, 0, 0], Resources: { XObject: { F0: inner } } });
      const pattern = ctx.register(
        PDFRawStream.of(
          ctx.obj({ Type: 'Pattern', PatternType: 1, PaintType: 1, TilingType: 1, BBox: [0, 0, 100, 100], XStep: 100, YStep: 100, Resources: { XObject: { P: imPattern } } }),
          new TextEncoder().encode('q 100 0 0 100 0 0 cm /P Do Q'),
        ),
      );
      const p1 = rawPage(doc, 'q 200 0 0 200 50 500 cm /Fo Do Q q 72 0 0 72 300 600 cm /T Do Q q /Pattern cs /Pt scn 50 50 200 200 re f Q', {
        XObject: { Fo: outer, T: imTwice },
        Pattern: { Pt: pattern },
      });
      rawPage(doc, 'q 288 0 0 288 100 100 cm /T Do Q', { XObject: { T: imTwice } });
      const ap = formStream(doc, 'q 10 0 0 10 0 0 cm /A Do Q', { BBox: [0, 0, 10, 10], Resources: { XObject: { A: imAnnot } } });
      const annot = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Stamp', Rect: [400, 100, 472, 172], AP: { N: ap } }));
      p1.node.set(N('Annots'), ctx.obj([annot]));
      const input = await doc.save({ useObjectStreams: false });

      const res = await compress(lib, input, { quality: 0.6 });
      const out = await loadOut(res.bytes);
      const f = dims(out, imForm), t = dims(out, imTwice), a = dims(out, imAnnot), p = dims(out, imPattern);
      assert(f.w === 417 && f.h === 417, `nested form image ${f.w}x${f.h}`);
      assert(t.w === 600 && t.h === 600, `twice-used image ${t.w}x${t.h}`);
      assert(a.w === 150 && a.h === 150, `annotation image ${a.w}x${a.h}`);
      assert(p.w === 1000 && p.h === 1000, `pattern image must not be downsampled: ${p.w}x${p.h}`);
      assert(res.report.imagesTotal === 4 && res.report.imagesDownsampled === 3, JSON.stringify(res.report));
      const before = renderPages(input, 40);
      const after = renderPages(res.bytes, 40);
      const diffs = before.map((b, i) => meanAbsDiff(b, after[i]));
      assert(diffs.every((d) => d < 4), `render diffs ${diffs}`);
      return [`form 417², twice 600², annot 150², pattern kept 1000²; ${kb(res.report.before)} -> ${kb(res.report.after)}; diffs ${diffs.map((d) => d.toFixed(2))}`];
    },
  },
  {
    name: 'compress: maxDpi null keeps dimensions, re-encodes only when smaller',
    async run({ compress: lib }) {
      const doc = await PDFDocument.create();
      const page = doc.addPage([612, 792]);
      const img = await doc.embedJpg(encodeJpeg(1600, 1200, photoPixels(1600, 1200, 31), 95));
      page.drawImage(img, { x: 50, y: 400, width: 160, height: 120 });
      const input = await doc.save();
      const res = await compress(lib, input, { maxDpi: null, quality: 0.6 });
      const list = pdfImagesList(res.bytes);
      assert(list[0].width === 1600 && list[0].height === 1200, JSON.stringify(list));
      assert(res.report.imagesRecompressed === 1 && res.report.imagesDownsampled === 0, JSON.stringify(res.report));
      // Already at the requested quality: nothing gained, image untouched.
      const doc2 = await PDFDocument.create();
      const img2 = await doc2.embedJpg(encodeJpeg(400, 300, photoPixels(400, 300, 32), 40));
      doc2.addPage([612, 792]).drawImage(img2, { x: 50, y: 400, width: 400, height: 300 });
      const in2 = await doc2.save();
      const res2 = await compress(lib, in2, { maxDpi: null, quality: 0.9 });
      assert(res2.report.imagesRecompressed === 0, JSON.stringify(res2.report));
      return [`${kb(res.report.before)} -> ${kb(res.report.after)}`];
    },
  },
  {
    name: 'compress: unsupported images (CMYK, Indexed, stencil, colour-key, 16-bit) are untouched',
    async run({ compress: lib }) {
      const doc = await PDFDocument.create();
      const ctx = doc.context;
      const r = rng(5);
      const noise = (n) => Uint8Array.from({ length: n }, () => Math.floor(r() * 256));
      const smooth = (w, h, c) => {
        const d = new Uint8Array(w * h * c);
        for (let i = 0; i < d.length; i++) d[i] = (i * 7 + ((i / (w * c)) | 0) * 3) & 0xff;
        return d;
      };
      const refs = {
        cmyk: imageStream(doc, { Width: 400, Height: 400, ColorSpace: 'DeviceCMYK', BitsPerComponent: 8, Filter: 'FlateDecode' }, deflateSync(smooth(400, 400, 4))),
        indexed: imageStream(
          doc,
          { Width: 400, Height: 400, ColorSpace: ['Indexed', 'DeviceRGB', 255, PDFHexString.of(Buffer.from(noise(768)).toString('hex'))], BitsPerComponent: 8, Filter: 'FlateDecode' },
          deflateSync(smooth(400, 400, 1)),
        ),
        stencil: imageStream(doc, { Width: 800, Height: 800, ImageMask: true, BitsPerComponent: 1, Filter: 'FlateDecode' }, deflateSync(smooth(100, 800, 1))),
        colorKey: imageStream(doc, { Width: 400, Height: 400, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Mask: [0, 10, 0, 10, 0, 10], Filter: 'FlateDecode' }, deflateSync(smooth(400, 400, 3))),
        sixteen: imageStream(doc, { Width: 300, Height: 300, ColorSpace: 'DeviceRGB', BitsPerComponent: 16, Filter: 'FlateDecode' }, deflateSync(smooth(300, 300, 6))),
      };
      const keys = Object.keys(refs);
      const content = keys.map((k, i) => `q 100 0 0 100 ${50 + (i % 3) * 180} ${450 + Math.floor(i / 3) * 180} cm ${k === 'stencil' ? '0 0 1 rg ' : ''}/${k} Do Q`).join('\n');
      rawPage(doc, content, { XObject: refs });
      // Unreferenced junk so the optimized file is smaller and actually written.
      ctx.register(ctx.flateStream(noise(50000)));
      const input = await doc.save({ useObjectStreams: false });
      const inDoc = await loadOut(input);
      const res = await compress(lib, input, { maxDpi: 72 });
      assert(!res.report.unchanged, 'expected the save path (junk removed)');
      const out = await loadOut(res.bytes);
      for (const k of keys) {
        const a = dims(inDoc, refs[k]).stream;
        const b = dims(out, refs[k]).stream;
        assert(Buffer.compare(Buffer.from(a.contents), Buffer.from(b.contents)) === 0, `${k} contents changed`);
        assert(a.dict.toString() === b.dict.toString(), `${k} dict changed`);
      }
      assert(res.report.imagesTotal === 5 && res.report.imagesRecompressed === 0 && res.report.objectsRemoved >= 1, JSON.stringify(res.report));
      const diff = meanAbsDiff(renderPages(input, 40)[0], renderPages(res.bytes, 40)[0]);
      assert(diff === 0, `render diff ${diff}`);
      return [`${kb(res.report.before)} -> ${kb(res.report.after)}, all 5 images byte-identical`];
    },
  },
  {
    name: 'compress: forms, annotations, outlines, metadata preserved; removeMetadata strips metadata only',
    async run({ compress: lib }) {
      const build = async () => {
        const doc = await PDFDocument.create();
        const ctx = doc.context;
        const page = doc.addPage([612, 792]);
        const font = await doc.embedFont(StandardFonts.Helvetica);
        page.drawText('Contract body text', { x: 50, y: 740, size: 14, font });
        page.drawImage(await doc.embedJpg(encodeJpeg(1800, 1200, photoPixels(1800, 1200, 41), 92)), { x: 50, y: 300, width: 300, height: 200 });
        const form = doc.getForm();
        const tf = form.createTextField('customer.name');
        tf.setText('Ada Lovelace');
        tf.addToPage(page, { x: 50, y: 650, width: 200, height: 24, font });
        const cb = form.createCheckBox('agree');
        cb.addToPage(page, { x: 50, y: 610, width: 16, height: 16 });
        cb.check();
        page.node.addAnnot(ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: [50, 50, 150, 70], Border: [0, 0, 0], A: { Type: 'Action', S: 'URI', URI: PDFString.of('https://example.com/') } })));
        page.node.addAnnot(ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Text', Rect: [500, 700, 520, 720], Contents: PDFHexString.fromText('Reviewer note ✓'), Open: false })));
        const itemRef = ctx.nextRef();
        const outlinesRef = ctx.nextRef();
        ctx.assign(itemRef, ctx.obj({ Title: PDFHexString.fromText('Chapter One'), Parent: outlinesRef, Dest: [page.ref, 'XYZ', null, null, null] }));
        ctx.assign(outlinesRef, ctx.obj({ Type: 'Outlines', First: itemRef, Last: itemRef, Count: 1 }));
        doc.catalog.set(N('Outlines'), outlinesRef);
        doc.setTitle('Secret Title');
        doc.setAuthor('Jane Doe');
        doc.catalog.set(N('Metadata'), ctx.register(ctx.stream('<?xpacket begin=""?><x:xmpmeta xmlns:x="adobe:ns:meta/">secret-xmp</x:xmpmeta><?xpacket end="w"?>', { Type: 'Metadata', Subtype: 'XML' })));
        const thumb = imageStream(doc, { Width: 40, Height: 40, ColorSpace: 'DeviceRGB', BitsPerComponent: 8 }, new Uint8Array(40 * 40 * 3).fill(128));
        page.node.set(N('Thumb'), thumb);
        page.node.set(N('PieceInfo'), ctx.obj({ MyApp: { Private: PDFString.of('private-app-data') } }));
        return doc.save();
      };
      const input = await build();
      const check = async (bytes, stripped) => {
        const d = await loadOut(bytes);
        const form = d.getForm();
        assert(form.getTextField('customer.name').getText() === 'Ada Lovelace', 'text field value');
        assert(form.getCheckBox('agree').isChecked(), 'checkbox');
        const page = d.getPage(0);
        const annots = page.node.Annots();
        const subtypes = annots.asArray().map((a) => d.context.lookup(a).get(N('Subtype')).toString());
        assert(subtypes.filter((s) => s === '/Widget').length === 2 && subtypes.includes('/Link') && subtypes.includes('/Text'), `annots ${subtypes}`);
        const outlines = d.catalog.lookup(N('Outlines'));
        const first = outlines.lookup(N('First'));
        assert(first.lookup(N('Title')).decodeText() === 'Chapter One', 'outline title');
        const dest = first.lookup(N('Dest'));
        assert(dest.get(0) === page.ref, 'outline destination');
        const raw = Buffer.from(bytes).toString('latin1');
        if (stripped) {
          assert(d.getTitle() === undefined && d.getAuthor() === undefined, 'Info not stripped');
          assert(!d.catalog.get(N('Metadata')), 'XMP not stripped');
          assert(!page.node.get(N('Thumb')) && !page.node.get(N('PieceInfo')), 'Thumb/PieceInfo not stripped');
          assert(!raw.includes('secret-xmp'), 'XMP bytes still in file');
        } else {
          assert(d.getTitle() === 'Secret Title' && d.getAuthor() === 'Jane Doe', 'Info lost');
          assert(d.catalog.get(N('Metadata')), 'XMP lost');
          assert(raw.includes('secret-xmp'), 'XMP should stay readable (uncompressed)');
        }
        const text = await pdfjsText(bytes);
        assert(text[0].includes('Contract body text'), 'body text');
      };
      const keep = await compress(lib, input, {});
      await check(keep.bytes, false);
      const strip = await compress(lib, input, { removeMetadata: true });
      await check(strip.bytes, true);
      assert(strip.bytes.length < keep.bytes.length, 'stripping metadata should save bytes');
      return [`kept: ${kb(keep.bytes.length)}, stripped: ${kb(strip.bytes.length)} (from ${kb(input.length)})`];
    },
  },
  {
    name: 'compress: encrypted input (user password, owner-only) is opened and saved unencrypted',
    async run({ compress: lib }) {
      const build = async (userPassword) => {
        const doc = await PDFDocument.create();
        const page = doc.addPage([612, 792]);
        const font = await doc.embedFont(StandardFonts.Helvetica);
        page.drawText('Confidential figures', { x: 50, y: 740, size: 14, font });
        page.drawImage(await doc.embedJpg(encodeJpeg(1500, 1000, photoPixels(1500, 1000, 51), 92)), { x: 50, y: 300, width: 300, height: 200 });
        doc.encrypt({ userPassword, ownerPassword: 'owner-pw' });
        return doc.save();
      };
      const locked = await build('secret');
      for (const [password, incorrect] of [[undefined, false], ['wrong', true]]) {
        let err = null;
        try {
          await lib.compressPdf(locked, { quality: 0.7, maxDpi: 150, password }, makeCodec());
        } catch (e) {
          err = e;
        }
        assert(err instanceof lib.PdfPasswordError && err.name === 'PdfPasswordError' && err.incorrect === incorrect, `password=${password}: ${err}`);
      }
      const res = await compress(lib, locked, { password: 'secret' });
      assert(res.report.encryptionRemoved === true && res.report.imagesDownsampled === 1, JSON.stringify(res.report));
      const text = await pdfjsText(res.bytes);
      assert(text[0] === 'Confidential figures', `text ${text[0]}`);
      assert(!Buffer.from(res.bytes).toString('latin1').includes('/Encrypt'), 'output still encrypted');

      const ownerOnly = await build('');
      const res2 = await compress(lib, ownerOnly, {});
      assert(res2.report.encryptionRemoved === true && res2.report.imagesRecompressed === 1, JSON.stringify(res2.report));
      const diff = meanAbsDiff(renderPages(ownerOnly, 40)[0], renderPages(res2.bytes, 40)[0]);
      assert(diff < 4, `diff ${diff}`);
      return [`user-password: ${kb(locked.length)} -> ${kb(res.bytes.length)}; owner-only: ${kb(ownerOnly.length)} -> ${kb(res2.bytes.length)}`];
    },
  },
  {
    name: 'compress: grayscale conversion (DCT and Flate sources)',
    async run({ compress: lib }) {
      const doc = await PDFDocument.create();
      const page = doc.addPage([612, 792]);
      page.drawImage(await doc.embedJpg(encodeJpeg(1200, 800, photoPixels(1200, 800, 61), 92)), { x: 50, y: 450, width: 300, height: 200 });
      page.drawImage(await doc.embedPng(encodePng(1000, 1000, photoPixels(1000, 1000, 62))), { x: 50, y: 100, width: 200, height: 200 });
      const input = await doc.save();
      const res = await compress(lib, input, { grayscale: true });
      assert(res.report.imagesRecompressed === 2, JSON.stringify(res.report));
      const out = renderPages(res.bytes, 50)[0];
      // Inside the image areas every rendered pixel must be gray.
      let maxSpread = 0;
      const sc = 50 / 72;
      for (const [x0, y0, w, h] of [[50, 450, 300, 200], [50, 100, 200, 200]]) {
        for (let y = Math.ceil((792 - y0 - h) * sc) + 2; y < Math.floor((792 - y0) * sc) - 2; y++) {
          for (let x = Math.ceil(x0 * sc) + 2; x < Math.floor((x0 + w) * sc) - 2; x++) {
            const o = (y * out.width + x) * 4;
            const d = out.data;
            maxSpread = Math.max(maxSpread, Math.max(d[o], d[o + 1], d[o + 2]) - Math.min(d[o], d[o + 1], d[o + 2]));
          }
        }
      }
      assert(maxSpread <= 6, `colour left in images: spread ${maxSpread}`);
      const list = pdfImagesList(res.bytes);
      return [`images: ${list.map((l) => `${l.width}x${l.height} ${l.color} ${l.enc}`).join(', ')}; max channel spread ${maxSpread}`];
    },
  },
  {
    name: 'compress: garbage collection, lossless stream recompression, duplicate merging',
    async run({ compress: lib }) {
      const doc = await PDFDocument.create();
      const ctx = doc.context;
      const r = rng(77);
      // Same JPEG embedded twice (two objects) on two pages.
      const jpgBytes = encodeJpeg(900, 600, photoPixels(900, 600, 71), 92);
      const a = await doc.embedJpg(jpgBytes);
      const b = await doc.embedJpg(jpgBytes);
      doc.addPage([612, 792]).drawImage(a, { x: 50, y: 400, width: 432, height: 288 });
      doc.addPage([612, 792]).drawImage(b, { x: 50, y: 400, width: 432, height: 288 });
      // Uncompressed vector content and an ASCIIHex-encoded content stream.
      let vec = '';
      for (let i = 0; i < 400; i++) vec += `${(i * 13) % 500} ${(i * 29) % 700} ${10 + (i % 20)} ${10 + (i % 15)} re\n${(i % 10) / 10} 0.2 0.4 rg f\n`;
      const p3 = doc.addPage([612, 792]);
      p3.node.set(N('Contents'), ctx.register(ctx.stream(vec)));
      const p4 = doc.addPage([612, 792]);
      p4.node.set(N('Contents'), ctx.register(ctx.stream(Buffer.from(vec).toString('hex') + '>', { Filter: 'ASCIIHexDecode' })));
      // Unreachable junk.
      const junk = ctx.register(ctx.flateStream(Uint8Array.from({ length: 80000 }, () => Math.floor(r() * 256))));
      const input = await doc.save({ useObjectStreams: false });

      const res = await compress(lib, input, { maxDpi: null });
      const rep = res.report;
      assert(rep.duplicatesMerged >= 1, `duplicates ${rep.duplicatesMerged}`);
      assert(rep.objectsRemoved >= 1, `removed ${rep.objectsRemoved}`); // the junk stream
      assert(rep.streamsCompressed >= 2, `streams ${rep.streamsCompressed}`);
      const out = await loadOut(res.bytes);
      assert(!out.context.lookup(junk), 'junk object survived');
      const xo = (i) => out.getPage(i).node.Resources().lookup(N('XObject')).values()[0];
      assert(xo(0) === xo(1), 'duplicate images not merged');
      for (const i of [2, 3]) {
        const c = out.getPage(i).node.Contents();
        assert(c.dict.get(N('Filter')) === N('FlateDecode'), `page ${i + 1} content filter ${c.dict.get(N('Filter'))}`);
      }
      const before = renderPages(input, 40);
      const after = renderPages(res.bytes, 40);
      const diffs = before.map((p, i) => meanAbsDiff(p, after[i]));
      assert(diffs[2] === 0 && diffs[3] === 0, `vector pages must be pixel-identical: ${diffs}`);
      assert(diffs[0] < 4 && diffs[1] < 4, `image pages ${diffs}`);
      return [`${kb(rep.before)} -> ${kb(rep.after)}; merged ${rep.duplicatesMerged}, removed ${rep.objectsRemoved}, streams ${rep.streamsCompressed}`];
    },
  },
  {
    name: 'compress: SMask with /Matte stays aligned; inverted /Decode honoured; EXIF/ICC stripped before decode',
    async run({ compress: lib }) {
      const doc = await PDFDocument.create();
      const S = 800;
      const alpha = new Uint8Array(S * S);
      const color = new Uint8Array(S * S * 3);
      const px = photoPixels(S, S, 81);
      for (let y = 0; y < S; y++) {
        for (let x = 0; x < S; x++) {
          const i = y * S + x;
          const a = Math.max(0, Math.min(255, 400 - Math.hypot(x - 400, y - 400)));
          alpha[i] = a;
          // Pre-multiplied against a white matte: c = m + a (c' - m)
          for (let k = 0; k < 3; k++) color[i * 3 + k] = Math.round(255 + (a / 255) * (px[i * 4 + k] - 255));
        }
      }
      const smask = imageStream(doc, { Width: S, Height: S, ColorSpace: 'DeviceGray', BitsPerComponent: 8, Matte: [1, 1, 1], Filter: 'FlateDecode' }, deflateSync(alpha));
      const matteImg = imageStream(doc, { Width: S, Height: S, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, SMask: smask, Filter: 'FlateDecode' }, deflateSync(color));
      const G = 600;
      const gray = new Uint8Array(G * G);
      for (let i = 0; i < gray.length; i++) gray[i] = ((i % G) * 255) / G;
      const inverted = imageStream(doc, { Width: G, Height: G, ColorSpace: 'DeviceGray', BitsPerComponent: 8, Decode: [1, 0], Filter: 'FlateDecode' }, deflateSync(gray));
      const exifJpg = withExifAndIcc(encodeJpeg(1200, 900, photoPixels(1200, 900, 82), 92));
      const exifImg = imageStream(doc, { Width: 1200, Height: 900, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'DCTDecode' }, exifJpg);
      rawPage(doc, 'q 0.9 0.9 0.6 rg 0 0 612 792 re f Q q 100 0 0 100 50 600 cm /M Do Q q 100 0 0 100 250 600 cm /D Do Q q 240 0 0 180 50 300 cm /E Do Q', {
        XObject: { M: matteImg, D: inverted, E: exifImg },
      });
      const input = await doc.save({ useObjectStreams: false });
      const stats = { rejectApp1: true };
      const res = await compress(lib, input, {}, stats);
      const out = await loadOut(res.bytes);
      const m = dims(out, matteImg), s = dims(out, smask), d = dims(out, inverted), e = dims(out, exifImg);
      assert(m.w === 208 && m.h === 208 && s.w === 208 && s.h === 208, `matte image ${m.w}x${m.h}, smask ${s.w}x${s.h}`);
      assert(s.stream.dict.get(N('Matte')), 'Matte kept');
      assert(d.w === 208 && !d.stream.dict.get(N('Decode')), `inverted image ${d.w}, Decode ${d.stream.dict.get(N('Decode'))}`);
      assert(e.w === 500 && e.h === 375, `exif image ${e.w}x${e.h}`);
      const diff = meanAbsDiff(renderPages(input, 72)[0], renderPages(res.bytes, 72)[0]);
      assert(diff < 3, `render diff ${diff}`);
      // Grayscale must not change the component count of a /Matte parent (Matte has one value per component).
      const g = await compress(lib, input, { grayscale: true });
      const gout = await loadOut(g.bytes);
      const gm = dims(gout, matteImg), gs = dims(gout, smask), ge = dims(gout, exifImg);
      const csOf = (x) => x.stream.dict.lookup(N('ColorSpace'))?.toString();
      assert(gm.w === gs.w && gm.h === gs.h && csOf(gm) === '/DeviceRGB', `matte parent ${gm.w}x${gm.h} ${csOf(gm)}, smask ${gs.w}x${gs.h}`);
      assert(gs.stream.dict.lookup(N('Matte')).size() === 3, 'Matte components');
      assert(ge.w === 500, 'other images still processed');
      return [`matte+smask 208², inverted gray 208², EXIF jpeg 500x375; diff ${diff.toFixed(2)}; ${kb(res.report.before)} -> ${kb(res.report.after)}`];
    },
  },
  {
    name: 'compress: real-world fixtures (Chrome, LibreOffice, ReportLab) keep text and appearance',
    async run({ compress: lib }) {
      const dir = join(dirname(fileURLToPath(import.meta.url)), '../redact-tests/fixtures');
      const notes = [];
      for (const f of ['chrome_print.pdf', 'libreoffice.pdf', 'reportlab_mixed.pdf']) {
        const file = join(dir, f);
        if (!existsSync(file)) {
          notes.push(`${f}: missing, skipped`);
          continue;
        }
        const input = new Uint8Array(readFileSync(file));
        const norm = (t) => t.replace(/\s+/g, ' ').trim();
        for (const maxDpi of [150, 36]) {
          const res = await compress(lib, input, { maxDpi, quality: 0.75 });
          assert(norm(pdftotext(res.bytes)) === norm(pdftotext(input)), `${f}@${maxDpi}: text changed`);
          const a = renderPages(input, 40);
          const b = renderPages(res.bytes, 40);
          assert(a.length === b.length, `${f}: page count`);
          const diffs = a.map((p, i) => meanAbsDiff(p, b[i]));
          assert(diffs.every((d) => d < (maxDpi === 36 ? 8 : 4)), `${f}@${maxDpi}: render diffs ${diffs}`);
          notes.push(`${f} @${maxDpi}dpi: ${kb(res.report.before)} -> ${kb(res.report.after)} (${res.report.imagesRecompressed}/${res.report.imagesTotal} images, ${res.report.imagesDownsampled} downsampled), max diff ${Math.max(...diffs).toFixed(2)}`);
        }
      }
      return notes;
    },
  },
  {
    name: 'compress: PDF/A-1 (XMP kept) falls back to a classic xref table',
    async run({ compress: lib }) {
      const doc = await PDFDocument.create();
      const page = doc.addPage([612, 792]);
      page.drawImage(await doc.embedJpg(encodeJpeg(1500, 1000, photoPixels(1500, 1000, 91), 92)), { x: 50, y: 300, width: 300, height: 200 });
      const xmp =
        '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
        '<rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/" pdfaid:part="1" pdfaid:conformance="B"/></rdf:RDF></x:xmpmeta><?xpacket end="w"?>';
      doc.catalog.set(N('Metadata'), doc.context.register(doc.context.stream(xmp, { Type: 'Metadata', Subtype: 'XML' })));
      const input = await doc.save({ useObjectStreams: false });
      const res = await compress(lib, input, {});
      const raw = Buffer.from(res.bytes).toString('latin1');
      assert(res.report.imagesRecompressed === 1 && !/\/Type\s*\/XRef/.test(raw) && /\nxref\b/.test(raw) && raw.includes('pdfaid:part="1"'), 'expected classic xref with XMP kept');
      const stripped = await compress(lib, input, { removeMetadata: true });
      assert(/\/Type\s*\/XRef/.test(Buffer.from(stripped.bytes).toString('latin1')), 'xref/object streams once the PDF/A claim is gone');
      return [`kept XMP: ${kb(res.bytes.length)} (xref table); stripped: ${kb(stripped.bytes.length)} (xref stream)`];
    },
  },
];
