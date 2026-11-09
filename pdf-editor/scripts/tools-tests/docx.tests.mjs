/** Tests for lib/pdf/tools/docx.ts */
import { PDFDocument, StandardFonts, rgb } from '@cantoo/pdf-lib';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assert, encodePng, hasTool, near, openPdfjs, pdftotext, photoPixels, tempDir } from './helpers.mjs';

const here = dirname(fileURLToPath(import.meta.url));

function inspect(docxBytes) {
  const dir = tempDir('docx');
  const file = join(dir, 'out.docx');
  writeFileSync(file, docxBytes);
  const json = execFileSync('python3', ['-I', join(here, 'inspect_docx.py'), file], { encoding: 'utf8' });
  const info = JSON.parse(json);
  assert(info.xml_errors.length === 0, `XML errors: ${info.xml_errors.join('; ')}`);
  for (const part of ['[Content_Types].xml', '_rels/.rels', 'docProps/core.xml', 'docProps/app.xml', 'word/document.xml', 'word/styles.xml', 'word/settings.xml', 'word/_rels/document.xml.rels']) {
    assert(info.parts.includes(part), `missing part ${part}`);
  }
  info.file = file;
  info.dir = dir;
  return info;
}

/** LibreOffice → PDF → pdftotext; returns the extracted text. */
function viaLibreOffice(info) {
  execFileSync('soffice', ['--headless', '--convert-to', 'pdf', '--outdir', info.dir, info.file], { stdio: 'ignore', timeout: 120000 });
  const pdf = readFileSync(join(info.dir, 'out.pdf'));
  return { pdf, text: pdftotext(pdf) };
}

const words = (s) => s.replace(/[\u00AD]/g, '').split(/\s+/).filter(Boolean);

/** Word-wrap `text` to `width` with a pdf-lib font. */
function wrap(text, font, size, width) {
  const out = [];
  let line = '';
  for (const w of text.split(' ')) {
    const t = line ? line + ' ' + w : w;
    if (font.widthOfTextAtSize(t, size) > width && line) {
      out.push(line);
      line = w;
    } else line = t;
  }
  if (line) out.push(line);
  return out;
}

/**
 * pdf.js text items → DocxPage (what the editor's extraction does): font
 * names via commonObjs after getOperatorList, top-left coordinates.
 */
async function pdfToDocxPages(bytes, images = []) {
  const { doc, destroy } = await openPdfjs(bytes);
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const view = page.view;
    await page.getOperatorList();
    const tc = await page.getTextContent();
    const lines = [];
    for (const it of tc.items) {
      if (!('str' in it) || !it.str.trim()) continue;
      const [, , c, d, e, f] = it.transform;
      const size = Math.hypot(c, d) || it.height;
      let font = null;
      try {
        font = page.commonObjs.get(it.fontName);
      } catch {
        /* not loaded */
      }
      const name = font?.name ?? '';
      const fam = tc.styles[it.fontName]?.fontFamily ?? '';
      lines.push({
        text: it.str,
        x: e - view[0],
        y: view[3] - f - size * 0.8,
        width: it.width,
        size,
        bold: /bold|black|heavy/i.test(name) || !!font?.bold,
        italic: /italic|oblique/i.test(name) || !!font?.italic,
        font: /courier|mono/i.test(name) || fam === 'monospace' ? 'mono' : /times|serif|roman/i.test(name) || fam === 'serif' ? 'serif' : 'sans',
      });
    }
    pages.push({ width: view[2] - view[0], height: view[3] - view[1], lines, images: images[i - 1] ?? [] });
  }
  await destroy();
  return pages;
}

const L = (text, x, y, size = 11, extra = {}) => ({ text, x, y, width: text.length * size * 0.5, size, bold: false, italic: false, font: 'serif', ...extra });

export const tests = [
  {
    name: 'docx: structure from synthetic lines (paragraphs, headings, runs, lists, tabs, sections, image)',
    run({ docx }) {
      const png = encodePng(100, 50, photoPixels(100, 50, 3));
      const p1 = {
        width: 612,
        height: 792,
        lines: [
          L('Quarterly Report', 206, 72, 24, { bold: true, font: 'sans', width: 200 }),
          L('Introduction', 72, 120, 16, { bold: true, font: 'sans', width: 110 }),
          L('This is the first line of a paragraph that con-', 72, 150, 11, { width: 468 }),
          L('tinues here with more words and ends the sentence', 72, 164, 11, { width: 468 }),
          L('on the third line.', 72, 178, 11, { width: 120 }),
          L('Normal text', 72, 206, 11, { width: 60 }),
          L('bold words', 135, 206, 11, { width: 55, bold: true }),
          L('and', 193, 206, 11, { width: 18 }),
          L('italic', 214, 206, 11, { width: 26, italic: true }),
          L('and red.', 243, 206, 11, { width: 40, color: '#FF0000' }),
          L('• First item', 72, 236, 11, { width: 60 }),
          L('• Second item which wraps onto', 72, 250, 11, { width: 160 }),
          L('a second line', 84, 264, 11, { width: 70 }),
          L('Name', 72, 296, 11, { width: 30 }),
          L('Value', 300, 296, 11, { width: 30 }),
          L('Specials: A & B <tag> "q" \'a\' \u0001ctl \uD800lone end', 72, 326, 11, { width: 260 }),
          L('Summary', 72, 366, 11, { width: 50, bold: true }),
          L('Body after the bold heading.', 72, 384, 11, { width: 160 }),
          L('    Indented paragraph line one that is long enough', 108, 430, 11, { width: 432 }),
          L('second line of the indented paragraph.', 72, 444, 11, { width: 200 }),
        ],
        images: [{ png, x: 72, y: 470, width: 200, height: 100 }],
      };
      p1.lines.push(
        L('Footnote marker here', 72, 600, 11, { width: 100 }),
        L('1', 172.5, 597.5, 7, { width: 3.5 }),
        L('and the sentence goes on.', 179, 600, 11, { width: 120 }),
        L('H', 72, 630, 11, { width: 8 }),
        L('2', 80, 636, 7, { width: 3.5 }),
        L('O is water.', 84, 630, 11, { width: 50 }),
        L('Apples', 72, 660, 11, { width: 32 }),
        L('3', 300, 660, 11, { width: 6 }),
        L('Pears', 72, 674, 11, { width: 28 }),
        L('5', 300, 674, 11, { width: 6 }),
      );
      const p2 = { width: 612, height: 792, lines: [L('Second page text.', 72, 72)] };
      const p3 = { width: 792, height: 612, lines: [L('Landscape page.', 72, 72)] };
      const bytes = docx.buildDocx([p1, p2, p3], { title: 'Q & A <Report>', author: 'Jane "J" Doe' });
      assert(bytes[0] === 0x50 && bytes[1] === 0x4b, 'zip signature');
      const info = inspect(bytes);
      const P = info.paragraphs;
      const find = (t) => {
        const p = P.find((x) => x.text.startsWith(t));
        assert(p, `paragraph "${t}" not found in ${JSON.stringify(P.map((x) => x.text))}`);
        return p;
      };
      const title = find('Quarterly Report');
      assert(title.style === 'Heading 1' && title.align === 'center', `title ${title.style} ${title.align}`);
      assert(find('Introduction').style === 'Heading 2', 'heading 2');
      const para = find('This is the first');
      assert(para.text === 'This is the first line of a paragraph that continues here with more words and ends the sentence on the third line.', para.text);
      assert(para.style === 'Normal' && para.runs.length === 1 && para.runs[0].size === 11 && para.runs[0].font === 'Times New Roman', JSON.stringify(para.runs));
      const mixed = find('Normal text');
      assert(mixed.text === 'Normal text bold words and italic and red.', mixed.text);
      const bold = mixed.runs.find((r) => r.text.includes('bold words'));
      const ital = mixed.runs.find((r) => r.text.includes('italic'));
      const red = mixed.runs.find((r) => r.text.includes('red'));
      assert(bold?.bold && !bold.italic && ital?.italic && !ital.bold && red?.color === 'FF0000', JSON.stringify(mixed.runs));
      assert(find('• First item').text === '• First item', 'list item 1');
      assert(find('• Second item').text === '• Second item which wraps onto a second line', 'list item 2 joined');
      assert(find('Name').text === 'Name\tValue', `tab: ${JSON.stringify(find('Name').text)}`);
      const sp = find('Specials');
      assert(sp.text === 'Specials: A & B <tag> "q" \'a\' ctl lone end', JSON.stringify(sp.text));
      assert(find('Summary').style === 'Heading 3', `bold short line style ${find('Summary').style}`);
      assert(find('Body after').style === 'Normal', 'body after heading');
      const ind = find('Indented paragraph');
      assert(ind.text === 'Indented paragraph line one that is long enough second line of the indented paragraph.', ind.text);
      near(ind.first_line ?? 0, 36, 0.5, 'first-line indent');
      const img = P.find((p) => p.has_drawing);
      assert(img, 'image paragraph');
      assert(info.inline_shapes.length === 1, 'one inline image');
      near(info.inline_shapes[0].w, 200, 0.5, 'image width');
      near(info.inline_shapes[0].h, 100, 0.5, 'image height');
      assert(P.indexOf(img) > P.indexOf(ind), 'image after the paragraph above it');
      assert(info.parts.includes('word/media/image1.png'), 'media part');
      const fn = find('Footnote marker');
      assert(fn.text === 'Footnote marker here1 and the sentence goes on.', JSON.stringify(fn.text));
      const sup = fn.runs.find((r) => r.text === '1');
      assert(sup?.superscript && sup.size === 11, `superscript run ${JSON.stringify(fn.runs)}`);
      const h2o = find('H2O');
      assert(h2o.runs.find((r) => r.text === '2')?.subscript, `subscript run ${JSON.stringify(h2o.runs)}`);
      assert(find('Apples').text === 'Apples\t3' && find('Pears').text === 'Pears\t5', 'table rows stay separate paragraphs');
      const second = find('Second page text.');
      assert(second.page_break_before, 'page break before page 2');
      assert(info.sections.length === 2, `sections ${info.sections.length}`);
      near(info.sections[0].w, 612, 0.1, 'section 1 width');
      near(info.sections[0].left, 72, 0.1, 'left margin');
      assert(/LANDSCAPE/.test(info.sections[1].orient) && Math.abs(info.sections[1].w - 792) < 0.1, JSON.stringify(info.sections[1]));
      assert(!find('Landscape page.').page_break_before, 'section break replaces page break');
      assert(info.core.title === 'Q & A <Report>' && info.core.author === 'Jane "J" Doe', JSON.stringify(info.core));
      if (hasTool('soffice')) {
        const { text } = viaLibreOffice(info);
        assert(text.includes('Quarterly Report') && text.includes('Landscape page.'), 'LibreOffice render');
      }
      return [`${P.length} paragraphs, ${info.sections.length} sections, ${bytes.length} bytes`];
    },
  },
  {
    name: 'docx: PDF -> pdf.js lines -> docx -> LibreOffice round-trip keeps text order and paragraphs',
    async run({ docx }) {
      if (!hasTool('soffice')) return ['soffice not available: skipped'];
      const pdf = await PDFDocument.create();
      const helv = await pdf.embedFont(StandardFonts.Helvetica);
      const helvB = await pdf.embedFont(StandardFonts.HelveticaBold);
      const times = await pdf.embedFont(StandardFonts.TimesRoman);
      const timesB = await pdf.embedFont(StandardFonts.TimesRomanBold);
      const timesI = await pdf.embedFont(StandardFonts.TimesRomanItalic);
      const expected = []; // paragraphs in order
      const paragraphs = [
        'Water utilities across the region reported steady demand during the year, with consumption rising modestly in the summer months and falling back in the autumn as temperatures eased.',
        'Capital spending focused on replacing aging mains, upgrading two treatment plants and extending the monitoring network so that leaks can be found and repaired more quickly than before.',
      ];
      let page = pdf.addPage([612, 792]);
      let y = 720;
      const title = 'Annual Report 2025';
      page.drawText(title, { x: (612 - helvB.widthOfTextAtSize(title, 24)) / 2, y, size: 24, font: helvB });
      expected.push({ text: title, style: 'Heading 1', align: 'center' });
      y -= 48;
      page.drawText('Introduction', { x: 72, y, size: 16, font: helvB });
      expected.push({ text: 'Introduction', style: 'Heading 2' });
      y -= 28;
      for (const para of paragraphs) {
        for (const line of wrap(para, times, 11, 468)) {
          page.drawText(line, { x: 72, y, size: 11, font: times });
          y -= 14;
        }
        expected.push({ text: para, style: 'Normal' });
        y -= 10;
      }
      // Mixed formatting on one line.
      let x = 72;
      for (const [t, f] of [['This sentence has ', times], ['bold', timesB], [' and ', times], ['italic', timesI], [' words.', times]]) {
        page.drawText(t, { x, y, size: 11, font: f });
        x += f.widthOfTextAtSize(t, 11);
      }
      expected.push({ text: 'This sentence has bold and italic words.', style: 'Normal', runs: true });
      y -= 30;
      const png = encodePng(300, 150, photoPixels(300, 150, 5));
      const image = await pdf.embedPng(png);
      const imgTop = 792 - y;
      page.drawImage(image, { x: 72, y: y - 100, width: 200, height: 100 });
      y -= 130;
      page.drawText('Details', { x: 72, y, size: 16, font: helvB });
      expected.push({ text: 'Details', style: 'Heading 2' });
      y -= 26;
      for (const item of ['• Pipes replaced: 42 km', '• New sensors: 310', '• Customer complaints down 12%']) {
        page.drawText(item, { x: 72, y, size: 11, font: helv });
        expected.push({ text: item, style: 'Normal' });
        y -= 16;
      }
      page = pdf.addPage([612, 792]);
      page.drawText('Outlook', { x: 72, y: 720, size: 16, font: helvB, color: rgb(0.1, 0.2, 0.6) });
      expected.push({ text: 'Outlook', style: 'Heading 2', pageBreak: true });
      const outlook = 'Next year the authority expects to complete the northern pipeline and to begin planning a desalination pilot together with neighbouring municipalities.';
      let yy = 692;
      for (const line of wrap(outlook, times, 11, 468)) {
        page.drawText(line, { x: 72, y: yy, size: 11, font: times });
        yy -= 14;
      }
      expected.push({ text: outlook, style: 'Normal' });
      const pdfBytes = await pdf.save();

      const pages = await pdfToDocxPages(pdfBytes, [[{ png, x: 72, y: imgTop, width: 200, height: 100 }]]);
      const bytes = docx.buildDocx(pages, { title: 'Annual Report', author: 'Tester' });
      const info = inspect(bytes);
      const P = info.paragraphs.filter((p) => p.text.trim() || p.has_drawing);
      const textParas = P.filter((p) => !p.has_drawing);
      assert(textParas.length === expected.length, `paragraph count ${textParas.length} vs ${expected.length}: ${JSON.stringify(textParas.map((p) => p.text))}`);
      expected.forEach((e, i) => {
        const p = textParas[i];
        assert(p.text === e.text, `paragraph ${i}: ${JSON.stringify(p.text)} != ${JSON.stringify(e.text)}`);
        assert(p.style === e.style, `paragraph ${i} style ${p.style} != ${e.style}`);
        if (e.align) assert(p.align === e.align, `paragraph ${i} align ${p.align}`);
        if (e.pageBreak) assert(p.page_break_before, `paragraph ${i} page break`);
        if (e.runs) {
          assert(p.runs.some((r) => r.bold && r.text.trim() === 'bold') && p.runs.some((r) => r.italic && r.text.trim() === 'italic'), JSON.stringify(p.runs));
        }
      });
      const imgIdx = P.findIndex((p) => p.has_drawing);
      assert(imgIdx > 0 && P[imgIdx - 1].text.startsWith('This sentence') && P[imgIdx + 1].text === 'Details', 'image position');

      const { pdf: out, text } = viaLibreOffice(info);
      const gotWords = words(text);
      const wantWords = words(expected.map((e) => e.text).join(' '));
      assert(JSON.stringify(gotWords) === JSON.stringify(wantWords), `LibreOffice text differs:\n${gotWords.join(' ')}\n---\n${wantWords.join(' ')}`);
      const pagesOut = execFileSync('pdfinfo', ['-'], { input: out, encoding: 'utf8' }).match(/Pages:\s+(\d+)/)[1];
      assert(pagesOut === '2', `LibreOffice pages ${pagesOut}`);
      return [`${textParas.length} paragraphs + 1 image; LibreOffice: ${pagesOut} pages, ${gotWords.length} words in order`];
    },
  },
  {
    name: 'docx: degenerate input (no pages, empty pages, junk values) still produces a valid package',
    run({ docx }) {
      const empty = inspect(docx.buildDocx([]));
      assert(empty.sections.length === 1, 'one section');
      const junk = inspect(
        docx.buildDocx(
          [
            { width: NaN, height: -5, lines: [{ text: '\u0000\u0001', x: NaN, y: 0, width: 1, size: 0, bold: true, italic: false, font: 'sans' }, null, { text: 'ok', x: 1e9, y: -1e9, width: -4, size: 1e6, bold: false, italic: false, font: 'weird' }] },
            { width: 300, height: 300, lines: [], images: [{ png: new Uint8Array([1, 2, 3]), x: 0, y: 0, width: 10, height: 10 }] },
          ],
          { title: '\uD800bad\u0007' },
        ),
      );
      assert(junk.paragraphs.some((p) => p.text === 'ok'), 'kept valid text');
      assert(junk.inline_shapes.length === 0, 'invalid image dropped');
      if (hasTool('soffice')) viaLibreOffice(junk);
    },
  },
];
