/**
 * Redaction engine tests. Run via `node scripts/redact-tests/run.mjs`.
 * Each test receives the bundled engine module and returns optional notes.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRawStream,
  PDFRef,
  PDFString,
  StandardFontEmbedder,
  StandardFonts,
  decodePDFRawStream,
  rgb,
} from '@cantoo/pdf-lib';
import { unzlibSync, zlibSync } from 'fflate';
import {
  assert,
  compareWords,
  comparePixels,
  findInFile,
  joinText,
  keep,
  near,
  pageContentText,
  pdfjsText,
  popplerWords,
  render,
  wordRect,
} from './helpers.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const PAGE_H = 792;

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function helvetica(ctx) {
  return ctx.register(ctx.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: 'WinAnsiEncoding' }));
}

/** Times-Roman with an explicit /Widths array (exercises the Widths path). */
function timesWithWidths(ctx) {
  const emb = StandardFontEmbedder.for('Times-Roman');
  const widths = [];
  for (let c = 32; c <= 126; c++) widths.push(Math.round(emb.widthOfTextAtSize(String.fromCharCode(c), 1000)));
  return ctx.register(
    ctx.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Times-Roman', Encoding: 'WinAnsiEncoding', FirstChar: 32, LastChar: 126, Widths: widths }),
  );
}

function rawPage(doc, content, resources, size = [612, PAGE_H]) {
  const page = doc.addPage(size);
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(content)));
  page.node.set(PDFName.of('Resources'), doc.context.obj(resources));
  return page;
}

async function redactBytes(engine, bytes, pageIndex, rects, opts) {
  const doc = await PDFDocument.load(bytes);
  const report = await engine.redactPage(doc, doc.getPage(pageIndex), rects, opts);
  const out = await doc.save();
  return { out, report, doc };
}

const fmtReport = (r) => Object.entries(r).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(' ');

/** Full verification of a text redaction: words, pixels, pdf.js text. */
async function verifyTextRedaction(before, after, pageNo, rects, { fill = [0, 0, 0], ignore = [], pixelTolerance = 0 } = {}) {
  const cw = compareWords(before, after, pageNo, rects);
  assert(cw.missing.length === 0, `words missing after redaction: ${cw.missing.join(', ')}`);
  assert(cw.moved.length === 0, `words moved: ${cw.moved.join(', ')}`);
  assert(cw.extra.length === 0, `unexpected words: ${cw.extra.join(', ')}`);
  const px = comparePixels(render(before, pageNo), render(after, pageNo), null, {
    ignore: [...rects, ...ignore],
    fillRects: fill ? rects : [],
    fill: fill ?? [0, 0, 0],
  });
  assert(px.diffOutside <= pixelTolerance, `${px.diffOutside} pixels changed outside the redaction rects`);
  assert(px.badInside === 0, `${px.badInside}/${px.inside} pixels inside rects are not the fill colour`);
  return { cw, px };
}

// ---------------------------------------------------------------------------
// Image helpers
// ---------------------------------------------------------------------------

const IMG_W = 100;
const IMG_H = 60;
const pattern = (x, y) => [(x * 2) & 255, (y * 4) & 255, (x + y * 3) & 255];

function rgbPixels(w = IMG_W, h = IMG_H) {
  const data = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(pattern(x, y), (y * w + x) * 3);
  return data;
}

/** PNG-predict rows (cycling filter types 0..4) for /Predictor 15. */
function pngPredict(data, rowLen, bpp) {
  const rows = data.length / rowLen;
  const out = new Uint8Array(rows * (rowLen + 1));
  for (let r = 0; r < rows; r++) {
    const type = r % 5;
    out[r * (rowLen + 1)] = type;
    for (let i = 0; i < rowLen; i++) {
      const x = data[r * rowLen + i];
      const a = i >= bpp ? data[r * rowLen + i - bpp] : 0;
      const b = r > 0 ? data[(r - 1) * rowLen + i] : 0;
      const c = r > 0 && i >= bpp ? data[(r - 1) * rowLen + i - bpp] : 0;
      let pred = 0;
      if (type === 1) pred = a;
      else if (type === 2) pred = b;
      else if (type === 3) pred = (a + b) >> 1;
      else if (type === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[r * (rowLen + 1) + 1 + i] = (x - pred) & 255;
    }
  }
  return out;
}

/** Does pixel (px,py) of an image placed at [x,y,w,h] overlap rect r (positive area)? */
function pixelOverlaps(px, py, place, iw, ih, r) {
  const x0 = place.x + (px / iw) * place.w;
  const x1 = place.x + ((px + 1) / iw) * place.w;
  const y1 = place.y + place.h - (py / ih) * place.h;
  const y0 = place.y + place.h - ((py + 1) / ih) * place.h;
  return Math.min(x1, r.x + r.width) - Math.max(x0, r.x) > 1e-6 && Math.min(y1, r.y + r.height) - Math.max(y0, r.y) > 1e-6;
}

/** Find `Do` operations on a page (via the engine's parser) with the CTM in effect. */
function findDos(engine, doc, pageIndex) {
  const ops = engine.parseContentStream(new TextEncoder().encode(pageContentText(doc, pageIndex)));
  const res = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const mul = (m, n) => [m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3], m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3], m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5]];
  for (const op of ops) {
    if (op.op === 'q') stack.push(ctm);
    else if (op.op === 'Q') ctm = stack.pop() ?? ctm;
    else if (op.op === 'cm') ctm = mul(op.operands.map((o) => o.value), ctm);
    else if (op.op === 'Do') res.push({ name: op.operands[0].value, ctm });
  }
  return res;
}

function xobjectOf(doc, pageIndex, name) {
  const res = doc.getPage(pageIndex).node.Resources();
  const xo = doc.context.lookup(res.get(PDFName.of('XObject')));
  const raw = xo.get(PDFName.of(name));
  return { ref: raw, stream: doc.context.lookup(raw) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

export const tests = [
  {
    name: '0 tokenizer/serializer round trip',
    async run(engine) {
      const src =
        '% comment line\n' +
        'q 1 0 0 1 -.5 +3 cm /Name#20With#2FEscapes gs\n' +
        'BT /F1 12 Tf (nested (paren) \\(esc\\) \\\\ \\101\\60\\0063 tab\\tend\\\nwrap) Tj <48 65 6c6C6f 7> Tj ET\n' +
        '/Span <</ActualText (Hi) /MCID 3>> BDC [(a) -250.5 (b) 4. (c)] TJ EMC\n' +
        '1 0 0 1 0 0 cm BI /W 4 /H 1 /CS /RGB /BPC 8 ID \x01EI \x00\xff\x45\x49\x00\x05\x06\x07\x08\x09\x0a\x0b\x0c\n EI Q\n' +
        "(x) ' 1 2 (y) \" true false null 0 0 m";
      const bytes = Uint8Array.from(src, (c) => c.charCodeAt(0));
      const ops = engine.parseContentStream(bytes);
      const names = ops.map((o) => o.op);
      const expect = ['q', 'cm', 'gs', 'BT', 'Tf', 'Tj', 'Tj', 'ET', 'BDC', 'TJ', 'EMC', 'cm', 'BI', 'Q', "'", '"', 'm'];
      assert(JSON.stringify(names) === JSON.stringify(expect), `ops: ${names.join(' ')}`);
      const cm = ops[1].operands.map((o) => o.value);
      assert(JSON.stringify(cm) === '[1,0,0,1,-0.5,3]', `cm operands ${cm}`);
      assert(ops[2].operands[0].value === 'Name With/Escapes', `name decode: ${ops[2].operands[0].value}`);
      const s1 = Buffer.from(ops[5].operands[0].bytes).toString('latin1');
      assert(s1 === 'nested (paren) (esc) \\ A0\x063 tab\tendwrap', `literal string: ${JSON.stringify(s1)}`);
      const s2 = Buffer.from(ops[6].operands[0].bytes).toString('latin1');
      assert(s2 === 'Hello\x70', `hex string: ${JSON.stringify(s2)}`);
      assert(ops[8].operands[1].type === 'dict' && ops[8].operands[1].entries.length === 2, 'BDC dict');
      const tj = ops[9].operands[0].items.map((i) => (i.type === 'number' ? i.value : Buffer.from(i.bytes).toString()));
      assert(JSON.stringify(tj) === '["a",-250.5,"b",4,"c"]', `TJ array ${JSON.stringify(tj)}`);
      assert(ops[12].inlineImage.data.length === 18, `inline image data length ${ops[12].inlineImage?.data.length}`);
      assert(ops[15].operands.length === 3, '" operands');
      // Unchanged ops re-serialize to their exact source bytes.
      const again = engine.parseContentStream(engine.serializeContentStream(ops));
      assert(JSON.stringify(again.map((o) => o.op)) === JSON.stringify(expect), 'round trip ops');
      // Structured (modified) ops serialize and re-parse to the same values.
      const strip = ops.map((o) => ({ op: o.op, operands: o.operands, inlineImage: o.inlineImage }));
      const re = engine.parseContentStream(engine.serializeContentStream(strip));
      assert(Buffer.from(re[5].operands[0].bytes).toString('latin1') === s1, 'literal string re-serialization');
      assert(re[2].operands[0].value === 'Name With/Escapes', 're-encoded name');
      assert(re[12].inlineImage.data.length === 18, 're-serialized inline image');
      return [`${ops.length} operations parsed`];
    },
  },

  {
    name: '1 helvetica word removed, neighbours keep exact positions',
    async run(engine) {
      const doc = await PDFDocument.create();
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const page = doc.addPage([612, PAGE_H]);
      page.drawText('Hello secret world', { x: 72, y: 700, size: 24, font });
      page.drawText('Another classified line stays', { x: 72, y: 650, size: 18, font, color: rgb(0.2, 0.3, 0.8) });
      const before = await doc.save();
      const rect = wordRect(before, 1, 'secret');
      const { out, report } = await redactBytes(engine, before, 0, [rect]);
      keep('t1.pdf', out);
      assert(report.glyphsRemoved === 6, `glyphsRemoved=${report.glyphsRemoved}`);

      const [tb] = await pdfjsText(before);
      const [ta] = await pdfjsText(out);
      const textAfter = joinText(ta);
      assert(!textAfter.includes('secret'), `pdf.js still sees secret: ${textAfter}`);
      assert(textAfter.includes('Hello') && textAfter.includes('world') && textAfter.includes('Another classified line stays'), textAfter);
      // pdf.js: the end of the line ("world") is exactly where it was.
      const endOf = (items, w) => {
        const it = items.find((i) => i.str.includes(w));
        return it.transform[4] + it.width;
      };
      near(endOf(ta, 'world'), endOf(tb, 'world'), 1e-3, 'pdf.js end x of "world"');
      near(ta.find((i) => i.str.includes('Hello')).transform[4], 72, 1e-6, 'start x of "Hello"');

      await verifyTextRedaction(before, out, 1, [rect]);
      const hits = await findInFile(out, ['secret']);
      assert(hits.length === 0, `secret still in file: ${hits.join('; ')}`);
      return [fmtReport(report)];
    },
  },

  {
    name: '2a TJ with kerning numbers (std-14 metrics) and Widths font',
    async run(engine) {
      const doc = await PDFDocument.create();
      const ctx = doc.context;
      rawPage(
        doc,
        'BT /F1 20 Tf 72 600 Td [(AV) -120 (Ta secret ) 80 (word) -250 (tail end)] TJ ET\n' +
          'BT /F2 16 Tf 72 560 Td [(Times ) 50 (with ) -30 (hidden) 40 ( widths here)] TJ ET\n' +
          'BT /F1 14 Tf 72 520 Td (Line three with secret inside) Tj ET',
        { Font: { F1: helvetica(ctx), F2: timesWithWidths(ctx) } },
      );
      const before = await doc.save();
      const rects = [wordRect(before, 1, 'secret', 0), wordRect(before, 1, 'hidden'), wordRect(before, 1, 'secret', 1)];
      const { out, report } = await redactBytes(engine, before, 0, rects);
      keep('t2a.pdf', out);
      assert(report.glyphsRemoved === 18, `glyphsRemoved=${report.glyphsRemoved}`);
      await verifyTextRedaction(before, out, 1, rects);
      const hits = await findInFile(out, ['secret', 'hidden']);
      assert(hits.length === 0, hits.join('; '));
      return [fmtReport(report)];
    },
  },

  {
    name: "2b Tc/Tw/Tz and ' \" operators keep side effects",
    async run(engine) {
      const doc = await PDFDocument.create();
      const ctx = doc.context;
      rawPage(
        doc,
        'BT /F1 14 Tf 3 Tc 6 Tw 130 Tz 72 600 Td (keep this secret and more) Tj ET\n' +
          'BT /F1 12 Tf 18 TL 72 520 Td (first line here) Tj 4 1.5 (second secret line) " (third secret line) \' (fourth line stays) \' ET\n' +
          'BT /F1 12 Tf 2 Ts 72 420 Td (raised secret text) Tj ET',
        { Font: { F1: helvetica(ctx) } },
      );
      const before = await doc.save();
      const rects = [0, 1, 2, 3].map((i) => wordRect(before, 1, 'secret', i));
      const { out, report } = await redactBytes(engine, before, 0, rects);
      keep('t2b.pdf', out);
      assert(report.glyphsRemoved === 24, `glyphsRemoved=${report.glyphsRemoved}`);
      const content = pageContentText(await PDFDocument.load(out), 0);
      assert(/4 Tw\s+1\.5 Tc\s+T\*/.test(content), `" rewrite should emit "aw Tw ac Tc T*": ${content}`);
      await verifyTextRedaction(before, out, 1, rects);
      assert((await findInFile(out, ['secret'])).length === 0, 'secret still in file');
      return [fmtReport(report)];
    },
  },

  {
    name: '2b2 marked content: /ActualText and /Alt of redacted spans are dropped',
    async run(engine) {
      const doc = await PDFDocument.create();
      rawPage(
        doc,
        '/Span <</ActualText (secret word) /Lang (en)>> BDC BT /F1 14 Tf 72 600 Td (Public secret) Tj ET EMC\n' +
          '/Span <</ActualText (untouched alt)>> BDC BT /F1 14 Tf 72 560 Td (Other line) Tj ET EMC',
        { Font: { F1: helvetica(doc.context) } },
      );
      const before = await doc.save();
      // poppler substitutes /ActualText when extracting, so compute the rect from AFM widths.
      const helv = StandardFontEmbedder.for('Helvetica');
      const x0 = 72 + helv.widthOfTextAtSize('Public ', 14);
      const rect = { x: x0, y: 596, width: helv.widthOfTextAtSize('secret', 14), height: 14 };
      const { out, report } = await redactBytes(engine, before, 0, [rect]);
      const c = pageContentText(await PDFDocument.load(out), 0);
      assert(report.glyphsRemoved === 6, fmtReport(report));
      assert(!c.includes('secret word') && c.includes('/Lang') && c.includes('untouched alt'), c);
      assert((await findInFile(out, ['secret'])).length === 0, 'secret still in file');
      return [fmtReport(report)];
    },
  },

  {
    name: '2c text under cm scale + 90° and 30° rotation',
    async run(engine) {
      const doc = await PDFDocument.create();
      const ctx = doc.context;
      const c = Math.cos(Math.PI / 6);
      const s = Math.sin(Math.PI / 6);
      rawPage(
        doc,
        'q 0 1 -1 0 300 150 cm 1.5 0 0 1.5 0 0 cm BT /F1 12 Tf 0 0 Td (rotated secret text) Tj ET Q\n' +
          `q ${c} ${s} ${-s} ${c} 250 450 cm BT /F1 16 Tf 10 0 Td (angled secret words here) Tj ET Q\n` +
          'q 2 0 0 0.5 72 650 cm BT /F1 20 Tf 0 0 Td (stretched secret line) Tj ET Q',
        { Font: { F1: helvetica(ctx) } },
      );
      const before = await doc.save();

      // 30° line: rect around the glyph centres of "secret", computed independently from AFM widths.
      const helv = StandardFontEmbedder.for('Helvetica');
      const fs = 16;
      const xs = 10 + helv.widthOfTextAtSize('angled ', fs);
      const xe = xs + helv.widthOfTextAtSize('secret', fs);
      const map = (x, y) => [250 + x * c - y * s, 450 + x * s + y * c];
      const p0 = map(xs + 2, 0.3 * fs);
      const p1 = map(xe - 2, 0.3 * fs);
      const angled = {
        x: Math.min(p0[0], p1[0]) - 1.5,
        y: Math.min(p0[1], p1[1]) - 1.5,
        width: Math.abs(p1[0] - p0[0]) + 3,
        height: Math.abs(p1[1] - p0[1]) + 3,
      };
      const angledInk = [map(xs - 1, -5), map(xe + 1, -5), map(xe + 1, fs), map(xs - 1, fs)];

      // poppler lists the stretched and the 90° 'secret' (the 30° line is split into fragments).
      const rects = [wordRect(before, 1, 'secret', 0), angled, wordRect(before, 1, 'secret', 1)];
      const lineEnd = map(10 + helv.widthOfTextAtSize('angled secret words here', fs) + 2, fs + 2);
      const angledLine = { x: 245, y: 445, width: lineEnd[0] - 245, height: lineEnd[1] - 445 };
      const { out, report } = await redactBytes(engine, before, 0, rects);
      keep('t2c.pdf', out);
      assert(report.glyphsRemoved === 18, `glyphsRemoved=${report.glyphsRemoved}`);
      const [ta] = await pdfjsText(out);
      const t = joinText(ta);
      assert(!t.includes('secret'), t);
      for (const w of ['rotated', 'text', 'angled', 'words here', 'stretched', 'line']) assert(t.includes(w), `missing ${w}: ${t}`);
      // poppler doesn't segment the 30° line reliably, so compare words only away from it, and pixels everywhere.
      const cw = compareWords(before, out, 1, rects, 0.02, [angledLine]);
      assert(cw.moved.length === 0 && cw.missing.length === 0 && cw.extra.length === 0 && cw.expectedCount >= 4, JSON.stringify(cw));
      const px = comparePixels(render(before), render(out), null, { ignore: [...rects, angledInk], fillRects: rects });
      assert(px.diffOutside === 0, `${px.diffOutside} pixels changed outside`);
      assert(px.badInside === 0, `${px.badInside} pixels inside not black`);
      return [fmtReport(report)];
    },
  },

  {
    name: '2d Form XObject shared by two pages: only redacted page changes',
    async run(engine) {
      const doc = await PDFDocument.create();
      const ctx = doc.context;
      const f1 = helvetica(ctx);
      const form = ctx.register(
        ctx.flateStream('BT /F1 18 Tf 0 0 Td (form secret text) Tj ET', {
          Type: 'XObject',
          Subtype: 'Form',
          BBox: [0, -10, 400, 30],
          Resources: { Font: { F1: f1 } },
        }),
      );
      rawPage(doc, 'q 1 0 0 1 72 400 cm /Fx Do Q BT /F1 12 Tf 72 300 Td (page one body) Tj ET', { Font: { F1: f1 }, XObject: { Fx: form } });
      rawPage(doc, 'q 1 0 0 1 72 400 cm /Fx Do Q BT /F1 12 Tf 72 300 Td (page two body) Tj ET', { Font: { F1: f1 }, XObject: { Fx: form } });
      const before = await doc.save();
      const rect = wordRect(before, 1, 'secret');
      const { out, report } = await redactBytes(engine, before, 0, [rect]);
      keep('t2d.pdf', out);
      assert(report.xobjectsCloned === 1 && report.glyphsRemoved === 6, fmtReport(report));
      const pages = await pdfjsText(out);
      assert(!joinText(pages[0]).includes('secret') && joinText(pages[0]).includes('form text'), joinText(pages[0]));
      assert(joinText(pages[1]).includes('form secret text'), `page 2 lost its text: ${joinText(pages[1])}`);
      await verifyTextRedaction(before, out, 1, [rect]);
      const p2 = comparePixels(render(before, 2), render(out, 2), null);
      assert(p2.diffOutside === 0, `page 2 changed (${p2.diffOutside} px)`);
      // The original form object is untouched and still used by page 2.
      const outDoc = await PDFDocument.load(out);
      const p2Form = xobjectOf(outDoc, 1, 'Fx');
      assert(p2Form.ref === form, 'page 2 still references the original form');
      assert(Buffer.from(decodePDFRawStream(p2Form.stream).decode()).toString().includes('form secret text'), 'original form intact');
      return [fmtReport(report)];
    },
  },

  {
    name: '2e nested Form XObjects used once: originals purged from the file',
    async run(engine) {
      const doc = await PDFDocument.create();
      const ctx = doc.context;
      const f1 = helvetica(ctx);
      const inner = ctx.register(
        ctx.flateStream('BT /F1 14 Tf 0 0 Td (inner secret payload) Tj ET', { Type: 'XObject', Subtype: 'Form', BBox: [-5, -5, 300, 20], Resources: { Font: { F1: f1 } } }),
      );
      const outer = ctx.register(
        ctx.flateStream('q 1 0 0 1 10 10 cm /In Do Q', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 400, 100], Matrix: [1, 0, 0, 1, 50, 0], Resources: { XObject: { In: inner } } }),
      );
      rawPage(doc, 'q 1 0 0 1 72 500 cm /Out Do Q BT /F1 12 Tf 72 300 Td (visible body) Tj ET', { Font: { F1: f1 }, XObject: { Out: outer } });
      const before = await doc.save();
      const rect = wordRect(before, 1, 'secret');
      const { out, report } = await redactBytes(engine, before, 0, [rect]);
      keep('t2e.pdf', out);
      assert(report.xobjectsCloned === 2 && report.glyphsRemoved === 6, fmtReport(report));
      await verifyTextRedaction(before, out, 1, [rect]);
      const hits = await findInFile(out, ['secret']);
      assert(hits.length === 0, `original form content still in file: ${hits.join('; ')}`);
      const outDoc = await PDFDocument.load(out);
      assert(!outDoc.context.lookup(inner) && !outDoc.context.lookup(outer), 'original forms should be deleted');
      return [fmtReport(report)];
    },
  },

  {
    name: '3 Type0 Identity-H / embedded CMap / Identity-V TJ rewrite math',
    async run(engine) {
      const doc = await PDFDocument.create();
      const ctx = doc.context;
      const cid = (extra) =>
        ctx.register(
          ctx.obj({
            Type: 'Font',
            Subtype: 'CIDFontType2',
            BaseFont: 'TestCID',
            CIDSystemInfo: { Registry: PDFString.of('Adobe'), Ordering: PDFString.of('Identity'), Supplement: 0 },
            ...extra,
          }),
        );
      const identityH = ctx.register(
        ctx.obj({ Type: 'Font', Subtype: 'Type0', BaseFont: 'TestCID', Encoding: 'Identity-H', DescendantFonts: [cid({ DW: 1000, W: [1, [500, 600, 700], 10, 20, 400] })] }),
      );
      const cmapText =
        '/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /Test-H def\n' +
        '2 begincodespacerange <00> <7F> <8000> <FFFF> endcodespacerange\n' +
        '2 begincidrange <00> <7F> 0 <8000> <80FF> 100 endcidrange\nendcmap end end';
      const cmap = ctx.register(ctx.flateStream(cmapText, { Type: 'CMap', CMapName: 'Test-H' }));
      const mixed = ctx.register(
        ctx.obj({ Type: 'Font', Subtype: 'Type0', BaseFont: 'TestCID', Encoding: cmap, DescendantFonts: [cid({ DW: 1000, W: [32, [250], 65, [600, 650], 100, [700, 710, 720]] })] }),
      );
      const identityV = ctx.register(ctx.obj({ Type: 'Font', Subtype: 'Type0', BaseFont: 'TestCID', Encoding: 'Identity-V', DescendantFonts: [cid({ DW: 1000 })] }));
      rawPage(
        doc,
        'BT /F2 10 Tf 2 Tc 100 400 Td <0001000200030004000A000B> Tj ET\n' +
          'BT /F3 20 Tf 0 Tc 5 Tw 50 300 Td <4120800142 8002> Tj ET\n' +
          'BT /F4 10 Tf 0 Tc 0 Tw 300 600 Td <000100020003> Tj ET',
        { Font: { F2: identityH, F3: mixed, F4: identityV } },
      );
      const before = await doc.save();
      // Glyph centres (computed by hand in the test plan):
      //  F2: 102.5, 110, 118.5, 129, 138, 144 (y = 403)
      //  F3: 56, 64.5, 79.1, 92.7, 106.4 (y = 306)
      //  F4: x = 300, y = 595, 585, 575
      const rects = [
        { x: 116, y: 395, width: 5, height: 15 }, // F2 glyph 3
        { x: 135, y: 395, width: 6, height: 15 }, // F2 glyph 5
        { x: 60, y: 295, width: 22, height: 20 }, // F3 space + <8001>
        { x: 290, y: 583, width: 20, height: 4 }, // F4 glyph 2
      ];
      const { out, report } = await redactBytes(engine, before, 0, rects, { fillColor: null });
      assert(report.glyphsRemoved === 5, `glyphsRemoved=${report.glyphsRemoved}`);
      const outDoc = await PDFDocument.load(out);
      const ops = engine.parseContentStream(new TextEncoder().encode(pageContentText(outDoc, 0)));
      const tjs = ops.filter((o) => o.op === 'TJ').map((o) =>
        o.operands[0].items.map((i) => (i.type === 'number' ? i.value : Buffer.from(i.bytes).toString('hex'))),
      );
      const expected = [
        ['00010002', -900, '0004', -600, '000b'],
        ['41', -1210, '428002'],
        ['0001', 1000, '0003'],
      ];
      assert(JSON.stringify(tjs) === JSON.stringify(expected), `TJ arrays ${JSON.stringify(tjs)} != ${JSON.stringify(expected)}`);
      return [`TJ arrays: ${JSON.stringify(tjs)}`];
    },
  },

  {
    name: '4 images: RGB Flate (+PNG predictor) pixels, shared original untouched, exclusive original purged',
    async run(engine) {
      const doc = await PDFDocument.create();
      const ctx = doc.context;
      const pixels = rgbPixels();
      const im1 = ctx.register(
        ctx.stream(zlibSync(pixels), { Type: 'XObject', Subtype: 'Image', Width: IMG_W, Height: IMG_H, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'FlateDecode' }),
      );
      const im2 = ctx.register(
        ctx.stream(zlibSync(pngPredict(pixels, IMG_W * 3, 3)), {
          Type: 'XObject',
          Subtype: 'Image',
          Width: IMG_W,
          Height: IMG_H,
          ColorSpace: 'DeviceRGB',
          BitsPerComponent: 8,
          Filter: 'FlateDecode',
          DecodeParms: { Predictor: 15, Colors: 3, Columns: IMG_W, BitsPerComponent: 8 },
        }),
      );
      const place1 = { x: 100, y: 300, w: 200, h: 120 };
      const place2 = { x: 350, y: 300, w: 150, h: 90 };
      rawPage(doc, `q ${place1.w} 0 0 ${place1.h} ${place1.x} ${place1.y} cm /Im1 Do Q q ${place2.w} 0 0 ${place2.h} ${place2.x} ${place2.y} cm /Im2 Do Q`, { XObject: { Im1: im1, Im2: im2 } });
      rawPage(doc, 'q 200 0 0 120 100 300 cm /Im1 Do Q', { XObject: { Im1: im1 } });
      const before = await doc.save();
      const rect = { x: 150.3, y: 330.7, width: 250, height: 100 };
      const { out, report } = await redactBytes(engine, before, 0, [rect]);
      keep('t4.pdf', out);
      assert(report.imagesModified === 2 && report.imagesRemoved === 0, fmtReport(report));

      const outDoc = await PDFDocument.load(out);
      const dos = findDos(engine, outDoc, 0);
      assert(dos.length === 2 && dos.every((d) => d.name.startsWith('RdIm')), `Do names ${dos.map((d) => d.name)}`);
      const places = [place1, place2];
      let black = 0;
      dos.forEach((d, i) => {
        const { stream } = xobjectOf(outDoc, 0, d.name);
        assert(stream.dict.get(PDFName.of('DecodeParms')) === undefined, 'DecodeParms dropped');
        const data = unzlibSync(stream.contents);
        assert(data.length === IMG_W * IMG_H * 3, 'decoded size');
        for (let y = 0; y < IMG_H; y++) {
          for (let x = 0; x < IMG_W; x++) {
            const o = (y * IMG_W + x) * 3;
            const got = [data[o], data[o + 1], data[o + 2]];
            const exp = pixelOverlaps(x, y, places[i], IMG_W, IMG_H, rect) ? [0, 0, 0] : pattern(x, y);
            if (exp[0] === 0 && exp[1] === 0 && exp[2] === 0) black++;
            assert(got.join() === exp.join(), `image ${i + 1} pixel ${x},${y}: got ${got} expected ${exp}`);
          }
        }
      });
      // Im1 is shared with page 2: unchanged and still there. Im2 was exclusive: deleted.
      const orig1 = outDoc.context.lookup(im1);
      assert(orig1 && Buffer.from(unzlibSync(orig1.contents)).equals(Buffer.from(pixels)), 'shared original image must be untouched');
      assert(xobjectOf(outDoc, 1, 'Im1').ref === im1, 'page 2 still draws the original');
      assert(!outDoc.context.lookup(im2), 'exclusive original image must be deleted');
      const p1 = outDoc.getPage(0).node.Resources().lookup(PDFName.of('XObject'));
      assert(!p1.has(PDFName.of('Im1')) && !p1.has(PDFName.of('Im2')), 'page 1 resources must not list the originals');
      const p2px = comparePixels(render(before, 2), render(out, 2), null);
      assert(p2px.diffOutside === 0, 'page 2 rendering changed');
      const px = comparePixels(render(before, 1), render(out, 1), null, { ignore: [rect], fillRects: [rect] });
      assert(px.diffOutside === 0 && px.badInside === 0, JSON.stringify(px));
      return [fmtReport(report), `${black} pixels blackened`];
    },
  },

  {
    name: '4b images: gray Decode[1 0], Indexed palette, ImageMask, JPEG via codec, remove/keep modes, inline images',
    async run(engine) {
      const doc = await PDFDocument.create();
      const ctx = doc.context;
      const W = 40;
      const H = 20;
      const gray = new Uint8Array(W * H).fill(100);
      const idx = new Uint8Array(W * H).map((_, i) => i % 4);
      const maskBits = new Uint8Array((W / 8) * H).fill(0); // all painted
      const img = (data, extra) =>
        ctx.register(ctx.stream(zlibSync(data), { Type: 'XObject', Subtype: 'Image', Width: W, Height: H, Filter: 'FlateDecode', ...extra }));
      const gImg = img(gray, { ColorSpace: 'DeviceGray', BitsPerComponent: 8, Decode: [1, 0] });
      const iImg = img(idx, { ColorSpace: [PDFName.of('Indexed'), PDFName.of('DeviceRGB'), 3, PDFHexString.of('ff000000ff000000ffffffff')], BitsPerComponent: 8 });
      const mImg = img(maskBits, { ImageMask: true, BitsPerComponent: 1 });
      const jImg = ctx.register(ctx.stream(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), { Type: 'XObject', Subtype: 'Image', Width: W, Height: H, ColorSpace: 'DeviceCMYK', BitsPerComponent: 8, Filter: 'DCTDecode' }));
      // Inline image whose data contains "EI " followed by binary bytes (must not end there).
      const inlineData = '\x01EI \x00\xff\x45\x49\x00\x05\x06\x07\x08\x09\x0a\x0b';
      const content =
        'q 80 0 0 40 50 600 cm /G Do Q q 80 0 0 40 150 600 cm /I Do Q 0 0 1 rg q 80 0 0 40 250 600 cm /M Do Q q 80 0 0 40 350 600 cm /J Do Q\n' +
        `q 40 0 0 20 50 500 cm BI /W 4 /H 1 /CS /RGB /BPC 8 ID ${inlineData} EI Q\n` +
        `q 40 0 0 20 300 500 cm BI /W 4 /H 1 /CS /RGB /BPC 8 ID ${inlineData} EI Q\n` +
        'BT /F1 12 Tf 50 450 Td (after inline images) Tj ET';
      const pageObj = rawPage(doc, '', { XObject: { G: gImg, I: iImg, M: mImg, J: jImg }, Font: { F1: helvetica(ctx) } });
      pageObj.node.set(PDFName.of('Contents'), ctx.register(ctx.stream(Uint8Array.from(content, (c) => c.charCodeAt(0)))));
      const before = await doc.save();
      // Rect covering the left half of each XObject image + the first inline image.
      const rects = [50, 150, 250, 350].map((x) => ({ x, y: 600, width: 40, height: 40 })).concat([{ x: 55, y: 505, width: 10, height: 10 }]);
      const codec = {
        async decodeJpeg(bytes) {
          assert(bytes[0] === 0xff && bytes[1] === 0xd8, 'codec receives the JPEG bytes');
          return { width: W, height: H, data: new Uint8ClampedArray(W * H * 4).fill(200) };
        },
      };
      const { out, report } = await redactBytes(engine, before, 0, rects, { codec });
      keep('t4b.pdf', out);
      assert(report.imagesModified === 4 && report.imagesRemoved === 1, fmtReport(report));
      const outDoc = await PDFDocument.load(out);
      const dos = findDos(engine, outDoc, 0);
      const get = (i) => xobjectOf(outDoc, 0, dos[i].name).stream;
      const covered = (x) => x < W / 2;
      // gray with Decode [1 0]: black = sample 255
      const g = unzlibSync(get(0).contents);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) assert(g[y * W + x] === (covered(x) ? 255 : 100), `gray ${x},${y}=${g[y * W + x]}`);
      // indexed: black appended as palette entry 4
      const iStream = get(1);
      const cs = iStream.dict.lookup(PDFName.of('ColorSpace'));
      assert(cs.lookup(2).asNumber() === 4 && Buffer.from(cs.lookup(3).asBytes()).toString('hex').endsWith('000000'), 'palette extended with black');
      const ii = unzlibSync(iStream.contents);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) assert(ii[y * W + x] === (covered(x) ? 4 : (y * W + x) % 4), `index ${x},${y}`);
      // image mask: covered bits become 1 (unpainted)
      const mm = unzlibSync(get(2).contents);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const bit = (mm[y * (W / 8) + (x >> 3)] >> (7 - (x & 7))) & 1;
        assert(bit === (covered(x) ? 1 : 0), `mask ${x},${y}=${bit}`);
      }
      // JPEG via codec → Flate DeviceRGB
      const j = get(3);
      assert(j.dict.lookup(PDFName.of('ColorSpace')) === PDFName.of('DeviceRGB') && j.dict.lookup(PDFName.of('Filter')) === PDFName.of('FlateDecode'), 'jpeg re-encoded as Flate RGB');
      const jj = unzlibSync(j.contents);
      assert(jj[0] === 0 && jj[(W - 1) * 3] === 200, 'jpeg pixels painted');
      // inline images: covered one dropped, other one kept byte-for-byte
      const content2 = pageContentText(outDoc, 0);
      assert((content2.match(/BI /g) ?? []).length === 1 && content2.includes(inlineData), 'inline image handling');
      assert(joinText((await pdfjsText(out))[0]).includes('after inline images'), 'text after inline images still parsed');

      // Without a codec the JPEG draw is removed; 'remove' / 'keep' modes.
      const r2 = (await redactBytes(engine, before, 0, rects)).report;
      assert(r2.imagesModified === 3 && r2.imagesRemoved === 2, `no codec: ${fmtReport(r2)}`);
      const r3 = (await redactBytes(engine, before, 0, rects, { images: 'remove' })).report;
      assert(r3.imagesModified === 0 && r3.imagesRemoved === 5, `remove: ${fmtReport(r3)}`);
      const r4 = await redactBytes(engine, before, 0, rects, { images: 'keep' });
      assert(r4.report.imagesModified === 0 && r4.report.imagesRemoved === 0, `keep: ${fmtReport(r4.report)}`);
      return [fmtReport(report), `no codec: ${fmtReport(r2)}`, `remove: ${fmtReport(r3)}`];
    },
  },

  {
    name: '4c inherited/shared resources (LibreOffice style): unused original image unlinked',
    async run(engine) {
      const doc = await PDFDocument.create();
      const ctx = doc.context;
      const pixels = rgbPixels();
      const mk = () =>
        ctx.register(ctx.stream(zlibSync(pixels), { Type: 'XObject', Subtype: 'Image', Width: IMG_W, Height: IMG_H, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'FlateDecode' }));
      const imA = mk(); // only on page 1
      const imB = mk(); // on pages 1 and 2
      const f1 = helvetica(ctx);
      const shared = ctx.register(ctx.obj({ Font: { F1: f1 }, XObject: { A: imA, B: imB } }));
      const p1 = rawPage(doc, 'q 100 0 0 60 72 600 cm /A Do Q q 100 0 0 60 300 600 cm /B Do Q BT /F1 12 Tf 72 500 Td (page one) Tj ET', {});
      const p2 = rawPage(doc, 'q 100 0 0 60 300 600 cm /B Do Q BT /F1 12 Tf 72 500 Td (page two) Tj ET', {});
      p1.node.delete(PDFName.of('Resources'));
      p2.node.delete(PDFName.of('Resources'));
      doc.catalog.Pages().set(PDFName.of('Resources'), shared); // inherited by both pages
      const before = await doc.save();
      const rects = [{ x: 60, y: 590, width: 400, height: 40 }];
      const { out, report } = await redactBytes(engine, before, 0, rects);
      keep('t4c.pdf', out);
      assert(report.imagesModified === 2, fmtReport(report));
      const outDoc = await PDFDocument.load(out);
      assert(!outDoc.context.lookup(imA), 'image A (no longer drawn anywhere) must be purged');
      assert(outDoc.context.lookup(imB), 'image B is still drawn on page 2');
      const sharedOut = outDoc.context.lookup(shared).lookup(PDFName.of('XObject'));
      assert(!sharedOut.has(PDFName.of('A')) && sharedOut.has(PDFName.of('B')), 'shared dict: A unlinked, B kept');
      const p2px = comparePixels(render(before, 2), render(out, 2), null);
      assert(p2px.diffOutside === 0, 'page 2 changed');
      return [fmtReport(report)];
    },
  },

  {
    name: '5 vectors (fill inside removed, clip kept, partial kept) and annotations',
    async run(engine) {
      const doc = await PDFDocument.create();
      const ctx = doc.context;
      const content =
        'q 1 0 0 rg 100 600 50 40 re f Q\n' + // fully inside R → removed
        'q 0 0 1 rg 160 600 200 40 re f Q\n' + // partially inside → kept
        'q 120 610 20 20 re W n 0 1 0 rg 0 0 612 792 re f Q\n' + // clip inside R → kept
        'q 2 w 0 0 0 RG 110 645 m 140 645 l S Q\n' + // stroked line inside → removed
        'q 0 0 0 rg 400 100 m 450 150 l 500 100 l h f Q\n' + // outside → kept
        'q 0.5 g 85 595 m 85 655 l 165 655 l 165 595 l h S Q'; // stroke outline straddling R edge → kept
      const page = rawPage(doc, content, {});
      const R = { x: 90, y: 590, width: 80, height: 70 };
      const ap = ctx.register(ctx.flateStream('BT /Helv 10 Tf 2 2 Td (annot secret) Tj ET', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 60, 20] }));
      const annot = (d) => ctx.register(ctx.obj(d));
      const square = annot({ Type: 'Annot', Subtype: 'Square', Rect: [100, 600, 150, 640], Contents: PDFString.of('secret note'), P: page.ref });
      const popup = annot({ Type: 'Annot', Subtype: 'Popup', Rect: [300, 700, 400, 760], Parent: square });
      ctx.lookup(square).set(PDFName.of('Popup'), popup);
      const link = annot({ Type: 'Annot', Subtype: 'Link', Rect: [150, 620, 200, 640], Border: [0, 0, 0], A: { S: 'URI', URI: PDFString.of('https://secret.example') } });
      const freeText = annot({ Type: 'Annot', Subtype: 'FreeText', Rect: [95, 595, 155, 615], Contents: PDFString.of('annot secret'), DA: PDFString.of('/Helv 10 Tf 0 g'), AP: { N: ap } });
      const widget = annot({ Type: 'Annot', Subtype: 'Widget', FT: 'Tx', T: PDFString.of('field1'), Rect: [100, 650, 160, 670], V: PDFString.of('keep me') });
      const far = annot({ Type: 'Annot', Subtype: 'Text', Rect: [500, 50, 520, 70], Contents: PDFString.of('far away note') });
      page.node.set(PDFName.of('Annots'), ctx.obj([square, popup, link, freeText, widget, far]));
      doc.catalog.set(PDFName.of('AcroForm'), ctx.obj({ Fields: [widget] }));
      const before = await doc.save();

      const { out, report } = await redactBytes(engine, before, 0, [R]);
      keep('t5.pdf', out);
      assert(report.pathsRemoved === 2, `pathsRemoved=${report.pathsRemoved}`);
      assert(report.annotationsRemoved === 4, `annotationsRemoved=${report.annotationsRemoved}`);
      const outDoc = await PDFDocument.load(out);
      const c = pageContentText(outDoc, 0).replace(/\s+/g, ' ');
      assert(!c.includes('100 600 50 40 re') && !c.includes('110 645 m'), 'inside paths removed');
      for (const keepIt of ['160 600 200 40 re', '120 610 20 20 re W n', '400 100 m', '85 595 m']) assert(c.includes(keepIt), `kept: ${keepIt}`);
      const annots = outDoc.getPage(0).node.Annots().asArray();
      assert(annots.length === 2 && annots.includes(widget) && annots.includes(far), `annots left: ${annots}`);
      const hits = await findInFile(out, ['secret note', 'annot secret', 'secret.example']);
      assert(hits.length === 0, `annotation data still in file: ${hits.join('; ')}`);
      const px = comparePixels(render(before), render(out), null, { ignore: [R], fillRects: [R] });
      assert(px.diffOutside === 0 && px.badInside === 0, JSON.stringify(px));

      // keepWidgets: false removes the widget and detaches it from the AcroForm.
      const r2 = await redactBytes(engine, before, 0, [R], { keepWidgets: false });
      assert(r2.report.annotationsRemoved === 5, fmtReport(r2.report));
      const fields = r2.doc.catalog.lookup(PDFName.of('AcroForm')).lookup(PDFName.of('Fields'));
      assert(fields.size() === 0, 'widget detached from AcroForm');
      return [fmtReport(report)];
    },
  },

  {
    name: '6 edit-text flow: remove a run (fillColor null) then draw replacement text',
    async run(engine) {
      const doc = await PDFDocument.create();
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const page = doc.addPage([612, PAGE_H]);
      page.drawText('Invoice total: 1,250.00 USD due', { x: 72, y: 700, size: 14, font });
      const before = await doc.save();
      const rect = wordRect(before, 1, '1,250.00', 0, 0);
      const d = await PDFDocument.load(before);
      const p = d.getPage(0);
      const report = await engine.redactPage(d, p, [rect], { fillColor: null, removeVectors: false, removeAnnotations: false, images: 'keep' });
      assert(report.glyphsRemoved === 8, fmtReport(report));
      const f = await d.embedFont(StandardFonts.Helvetica);
      p.drawText('9,999.99', { x: rect.x, y: 700, size: 14, font: f });
      const out = await d.save();
      keep('t6.pdf', out);
      const words = popplerWords(out).map((w) => w.text);
      assert(words.includes('9,999.99') && !words.includes('1,250.00') && words.includes('USD') && words.includes('due'), words.join(' '));
      const cw = compareWords(before, out, 1, [rect]);
      assert(cw.missing.length === 0 && cw.moved.length === 0, JSON.stringify(cw));
      // Nothing painted besides the new text (no box).
      const px = comparePixels(render(before), render(out), null, { ignore: [rect] });
      assert(px.diffOutside === 0, `diff outside ${px.diffOutside}`);
      return [fmtReport(report)];
    },
  },

  {
    name: '7 real-world PDFs: words removed, everything else unchanged',
    async run(engine) {
      const fixtures = join(here, 'fixtures');
      const targets = {
        'reportlab_mixed.pdf': { 1: ['confidential', '4417', 'Jane', '555', 'QX-77.', 'Bluebird.', 'password=hunter2', 'AVATAR'], 2: ['Alice', 'Smith'] },
        'libreoffice.pdf': { 1: ['CONFIDENTIAL', 'Salary:', '98,500', '078-05-1120.', 'Evergreen', 'Nightingale', '机密'] },
        'chrome_print.pdf': { 1: ['PRIVATE', 'Maria', 'Garcia,', '99812,', 'portal', '机密', 'Laptop'] },
        '/mnt/skills/examples/theme-factory/theme-showcase.pdf': { 1: ['professional', 'maritime', '#2d8b8b'], 2: ['Typography'] },
      };
      const notes = [];
      for (const [file, pages] of Object.entries(targets)) {
        const path = file.startsWith('/') ? file : join(fixtures, file);
        if (!existsSync(path)) {
          notes.push(`skipped ${file} (not found)`);
          continue;
        }
        let bytes = readFileSync(path);
        for (const [pageNoStr, words] of Object.entries(pages)) {
          const pageNo = Number(pageNoStr);
          const all = popplerWords(bytes, pageNo);
          const rects = [];
          for (const w of words) {
            const hits = all.filter((x) => x.text === w);
            assert(hits.length, `${file} p${pageNo}: word ${w} not found`);
            for (const h of hits) rects.push({ x: h.x0 + 0.25, y: h.y0, width: h.x1 - h.x0 - 0.5, height: h.y1 - h.y0 });
          }
          const { out, report } = await redactBytes(engine, bytes, pageNo - 1, rects);
          keep(`t7-${file.split('/').pop()}-p${pageNo}.pdf`, out);
          const cw = compareWords(bytes, out, pageNo, rects, 0.05);
          const after = joinText((await pdfjsText(out))[pageNo - 1]);
          const leaked = words.filter((w) => after.includes(w.replace(/[,.:]$/, '')));
          const px = comparePixels(render(bytes, pageNo, 72), render(out, pageNo, 72), null, { ignore: rects, fillRects: rects, marginPt: 1.5 });
          notes.push(
            `${file.split('/').pop()} p${pageNo}: ${fmtReport(report)} | words kept ${cw.expectedCount}, missing ${cw.missing.length}, moved ${cw.moved.length}, extra ${cw.extra.length} | pixels changed outside ${px.diffOutside}, inside not black ${px.badInside}/${px.inside}`,
          );
          assert(leaked.length === 0, `${file} p${pageNo}: pdf.js still extracts ${leaked.join(', ')}`);
          assert(cw.missing.length === 0 && cw.moved.length === 0, `${file} p${pageNo}: ${JSON.stringify(cw)}`);
          assert(px.badInside === 0, `${file} p${pageNo}: box not opaque`);
          assert(px.diffOutside === 0, `${file} p${pageNo}: ${px.diffOutside} pixels changed outside rects`);
          bytes = out; // keep redacting the same file across pages
        }
        const hits = await findInFile(bytes, ['hunter2', 'Bluebird', 'Nightingale', 'Evergreen']);
        assert(hits.length === 0, `${file}: ${hits.join('; ')}`);
      }
      return notes;
    },
  },

  {
    name: '8 robustness: full-page redaction of every fixture page, repeated calls, junk input',
    async run(engine) {
      const notes = [];
      const files = readdirSync(join(here, 'fixtures')).filter((f) => f.endsWith('.pdf')).map((f) => join(here, 'fixtures', f));
      if (existsSync('/mnt/skills/examples/theme-factory/theme-showcase.pdf')) files.push('/mnt/skills/examples/theme-factory/theme-showcase.pdf');
      for (const file of files) {
        const doc = await PDFDocument.load(readFileSync(file));
        const totals = {};
        for (const page of doc.getPages()) {
          const { width, height } = page.getMediaBox();
          const r = await engine.redactPage(doc, page, [{ x: -10, y: -10, width: width + 20, height: height + 20 }]);
          for (const [k, v] of Object.entries(r)) totals[k] = (totals[k] ?? 0) + v;
          // second call on the same page must work (and find nothing left)
          const again = await engine.redactPage(doc, page, [{ x: 0, y: 0, width, height }]);
          assert(again.glyphsRemoved === 0 && again.imagesModified === 0, `second pass found content: ${fmtReport(again)}`);
        }
        const out = await doc.save();
        const text = (await pdfjsText(out)).map(joinText).join('');
        assert(text.trim() === '', `${file}: text left after full redaction: ${text.slice(0, 80)}`);
        notes.push(`${file.split('/').pop()}: ${fmtReport(totals)}`);
      }
      // Junk / edge-case input never throws.
      const doc = await PDFDocument.create();
      const p = rawPage(doc, 'BT /Missing 12 Tf (no font) Tj ] ) >> } ET Q Q q 1 2 cm /Nope Do 5 0 0 Tm 1 2 3 TJ [ (a) 5 Tj ET <</X [1 2>> BDC BI /W 1 ID xx', {});
      const r = await engine.redactPage(doc, p, [{ x: 0, y: 0, width: 612, height: 792 }]);
      notes.push(`junk page: ${fmtReport(r) || 'no changes'}`);
      const empty = await engine.redactPage(doc, p, []);
      assert(Object.values(empty).every((v) => v === 0), 'empty rect list is a no-op');
      await doc.save();

      // Undecodable page content: descriptive error, page left untouched.
      const bad = await PDFDocument.create();
      const bp = bad.addPage([612, 792]);
      const badRef = bad.context.register(bad.context.stream(new Uint8Array([1, 2, 3]), { Filter: 'JBIG2Decode' }));
      bp.node.set(PDFName.of('Contents'), badRef);
      let message = '';
      try {
        await engine.redactPage(bad, bp, [{ x: 0, y: 0, width: 100, height: 100 }]);
      } catch (e) {
        message = e.message;
      }
      assert(/^redactPage: could not redact page/.test(message), `expected descriptive error, got "${message}"`);
      assert(bp.node.get(PDFName.of('Contents')) === badRef, 'page must be untouched after failure');
      notes.push(`undecodable content → ${message}`);
      return notes;
    },
  },
];
