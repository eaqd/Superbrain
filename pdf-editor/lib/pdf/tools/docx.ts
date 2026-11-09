/**
 * "Export PDF to Word": builds a .docx (OOXML WordprocessingML package) from
 * positioned text lines and images extracted from PDF pages.
 *
 * Layout reconstruction heuristics:
 *  - fragments on the same baseline that follow each other become one visual
 *    line (with a space or a tab for wide gaps);
 *  - headings: size ≥ 1.6× the page's body size → Heading 1, ≥ 1.3× → Heading 2,
 *    short all-bold body-size lines → Heading 3;
 *  - consecutive lines are joined into a paragraph when they have a similar
 *    size and font family, the same heading level, a consistent left edge
 *    (first-line / hanging indents allowed) and a vertical pitch not larger
 *    than ~1.6× the line size (or the page's typical line pitch);
 *  - alignment: centred / right / justified detection; left indentation from
 *    the x offset relative to the section margin;
 *  - bold / italic / size / colour / family per run, identical runs merged;
 *  - a page break between PDF pages (a new section when the page size changes);
 *    page size and margins from the first page;
 *  - images as inline pictures, in paragraph order by their top y.
 *
 * Pure TypeScript (fflate for the zip), no DOM.
 */
import { strToU8, zipSync, type Zippable } from 'fflate';

export interface DocxLine {
  text: string;
  /** Left edge, pt, top-left page origin. */
  x: number;
  /** Top of the line box, pt, top-left page origin. */
  y: number;
  width: number;
  /** Font size, pt. */
  size: number;
  bold: boolean;
  italic: boolean;
  font: 'sans' | 'serif' | 'mono';
  /** #rrggbb */
  color?: string;
}

/** pt, top-left origin. `png` may also hold JPEG bytes (detected by signature). */
export interface DocxImage {
  png: Uint8Array;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** pt; lines in reading order, y = top of line box. */
export interface DocxPage {
  width: number;
  height: number;
  lines: DocxLine[];
  images?: DocxImage[];
}

export interface DocxOptions {
  title?: string;
  author?: string;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function buildDocx(pages: DocxPage[], opts: DocxOptions = {}): Uint8Array {
  const safePages = (pages ?? []).map(sanitizePage);
  if (!safePages.length) safePages.push({ width: 612, height: 792, lines: [], images: [] });

  const docBody = medianBodySize(safePages.flatMap((p) => p.lines));
  const media: MediaEntry[] = [];
  const ctx: BuildCtx = { media, drawingId: 1 };

  const sections = assignSections(safePages);
  const body: string[] = [];
  for (let pi = 0; pi < safePages.length; pi++) {
    const page = safePages[pi];
    const section = sections[pi];
    const blocks = layoutPage(page, section, docBody);
    let pageBreak = pi > 0;
    if (pi > 0 && sections[pi - 1] !== section) {
      // Close the previous section on its last paragraph; the new one starts on a new page.
      closeSection(body, sections[pi - 1]);
      pageBreak = false;
    }
    if (!blocks.length) {
      body.push(`<w:p><w:pPr>${pageBreak ? '<w:pageBreakBefore/>' : ''}<w:spacing w:before="0" w:after="0"/></w:pPr></w:p>`);
      continue;
    }
    blocks.forEach((b, i) => body.push(renderBlock(b, section, ctx, pageBreak && i === 0)));
  }
  body.push(sectPrXml(sections[sections.length - 1]));

  const documentXml =
    XML_HEADER +
    `<w:document xmlns:w="${NS.w}" xmlns:r="${NS.r}" xmlns:wp="${NS.wp}" xmlns:a="${NS.a}" xmlns:pic="${NS.pic}">` +
    `<w:body>${body.join('')}</w:body></w:document>`;

  const files: Zippable = {
    '[Content_Types].xml': [strToU8(contentTypesXml(media)), { level: 6 }],
    _rels: { '.rels': [strToU8(ROOT_RELS), { level: 6 }] },
    docProps: {
      'core.xml': [strToU8(coreXml(opts)), { level: 6 }],
      'app.xml': [strToU8(appXml(safePages.length)), { level: 6 }],
    },
    word: {
      'document.xml': [strToU8(documentXml), { level: 6 }],
      'styles.xml': [strToU8(stylesXml(safePages, docBody)), { level: 6 }],
      'settings.xml': [strToU8(SETTINGS_XML), { level: 6 }],
      _rels: { 'document.xml.rels': [strToU8(documentRelsXml(media)), { level: 6 }] },
      ...(media.length
        ? { media: Object.fromEntries(media.map((m) => [m.name, [m.data, { level: 0 }] as [Uint8Array, { level: 0 }]])) }
        : {}),
    },
  };
  return zipSync(files);
}

// ---------------------------------------------------------------------------
// Input sanitation
// ---------------------------------------------------------------------------

type Family = DocxLine['font'];

interface Seg {
  text: string;
  x: number;
  y: number;
  width: number;
  size: number;
  bold: boolean;
  italic: boolean;
  font: Family;
  color?: string;
}

interface SafePage {
  width: number;
  height: number;
  lines: Seg[];
  images: DocxImage[];
}

const fin = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

function sanitizePage(p: DocxPage): SafePage {
  const width = fin(p?.width, 612) > 1 ? fin(p?.width, 612) : 612;
  const height = fin(p?.height, 792) > 1 ? fin(p?.height, 792) : 792;
  const lines: Seg[] = [];
  for (const l of p?.lines ?? []) {
    if (!l || typeof l.text !== 'string') continue;
    const text = cleanText(l.text);
    if (!text.trim()) continue;
    const size = fin(l.size, 11) > 0.5 ? Math.min(fin(l.size, 11), 1600) : 11;
    lines.push({
      text,
      x: fin(l.x, 0),
      y: fin(l.y, 0),
      width: Math.max(0, fin(l.width, text.length * size * 0.5)),
      size,
      bold: !!l.bold,
      italic: !!l.italic,
      font: l.font === 'serif' || l.font === 'mono' ? l.font : 'sans',
      color: typeof l.color === 'string' && /^#?[0-9a-fA-F]{6}$/.test(l.color) ? l.color.replace('#', '').toUpperCase() : undefined,
    });
  }
  const images: DocxImage[] = [];
  for (const im of p?.images ?? []) {
    if (!im || !(im.png instanceof Uint8Array) || !imageKind(im.png)) continue;
    const w = fin(im.width, 0), h = fin(im.height, 0);
    if (w <= 0.5 || h <= 0.5) continue;
    images.push({ png: im.png, x: fin(im.x, 0), y: fin(im.y, 0), width: w, height: h });
  }
  return { width, height, lines, images };
}

/** Remove characters that are invalid in XML 1.0 (and stray format characters). */
function cleanText(s: string): string {
  return s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFFFE\uFFFF]/g, '')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
    .replace(/\r\n?|\n/g, ' ');
}

function imageKind(b: Uint8Array): 'png' | 'jpeg' | null {
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8) return 'jpeg';
  return null;
}

// ---------------------------------------------------------------------------
// Layout analysis
// ---------------------------------------------------------------------------

interface VLine {
  segs: Seg[];
  x: number;
  right: number;
  y: number;
  size: number;
  font: Family;
  allBold: boolean;
  text: string;
  list: boolean;
  heading: number; // 0 = body
}

interface Para {
  kind: 'p';
  lines: VLine[];
  heading: number;
  list: boolean;
  top: number;
  spaceBefore: number;
  align: 'left' | 'center' | 'right' | 'both';
  indLeft: number; // pt relative to page left edge
  firstLine: number; // pt (negative = hanging)
  pitch: number; // 0 = single line
}

interface ImgBlock {
  kind: 'img';
  image: DocxImage;
  top: number;
  spaceBefore: number;
}

type Block = Para | ImgBlock;

interface SectionInfo {
  width: number;
  height: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

const LIST_RE = /^\s*(?:[•‣⁃⁌⁍∙▪▫●◦■□○➢➤✓✔·*\-–]|\(?(?:\d{1,3}|[a-zA-Z]|[ivxlcdmIVXLCDM]{1,6})[.)])\s/u;

/** Character-weighted median font size. */
function medianBodySize(lines: Seg[]): number {
  const items = lines.map((l) => [l.size, Math.max(1, l.text.trim().length)] as [number, number]).sort((a, b) => a[0] - b[0]);
  const total = items.reduce((s, [, w]) => s + w, 0);
  if (!total) return 11;
  let acc = 0;
  for (const [size, w] of items) {
    acc += w;
    if (acc >= total / 2) return size;
  }
  return items[items.length - 1][0];
}

function sectionFor(page: SafePage): SectionInfo {
  const clampM = (v: number, max: number) => Math.round(Math.min(max, Math.max(18, v)));
  const maxM = Math.max(18, Math.min(144, page.width / 3));
  const maxV = Math.max(18, Math.min(144, page.height / 4));
  if (!page.lines.length && !page.images.length) {
    return { width: page.width, height: page.height, left: clampM(72, maxM), right: clampM(72, maxM), top: clampM(72, maxV), bottom: clampM(72, maxV) };
  }
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const l of page.lines) {
    x0 = Math.min(x0, l.x);
    x1 = Math.max(x1, l.x + l.width);
    y0 = Math.min(y0, l.y);
    y1 = Math.max(y1, l.y + l.size * 1.2);
  }
  for (const im of page.images) {
    x0 = Math.min(x0, im.x);
    x1 = Math.max(x1, im.x + im.width);
    y0 = Math.min(y0, im.y);
    y1 = Math.max(y1, im.y + im.height);
  }
  return {
    width: page.width,
    height: page.height,
    left: clampM(x0, maxM),
    right: clampM(page.width - x1, maxM),
    top: clampM(y0, maxV),
    bottom: clampM(page.height - y1, maxV),
  };
}

function sameSize(a: { width: number; height: number }, b: { width: number; height: number }): boolean {
  return Math.abs(a.width - b.width) < 1.5 && Math.abs(a.height - b.height) < 1.5;
}

/**
 * One section per run of consecutive same-size pages. Margins come from the
 * run's first page with a reasonable amount of text (a sparse cover page would
 * give meaningless margins), else from the union of the run's content.
 */
function assignSections(pages: SafePage[]): SectionInfo[] {
  const out: SectionInfo[] = [];
  let i = 0;
  while (i < pages.length) {
    let j = i + 1;
    while (j < pages.length && sameSize(pages[i], pages[j])) j++;
    const run = pages.slice(i, j);
    const dense = run.find((p) => buildVLines(p.lines).length >= 6);
    const sec = dense
      ? sectionFor(dense)
      : sectionFor({ width: pages[i].width, height: pages[i].height, lines: run.flatMap((p) => p.lines), images: run.flatMap((p) => p.images) });
    for (let k = i; k < j; k++) out.push(sec);
    i = j;
  }
  return out;
}

/** Group fragments into visual lines (sequential fragments on the same baseline). */
function buildVLines(segs: Seg[]): VLine[] {
  const out: VLine[] = [];
  let cur: Seg[] = [];
  const flush = () => {
    if (cur.length) out.push(makeVLine(cur));
    cur = [];
  };
  for (const s of segs) {
    if (cur.length) {
      const prev = cur[cur.length - 1];
      const size = Math.max(prev.size, s.size);
      // Same line when the boxes overlap vertically (keeps super/subscripts on their line).
      const overlap = Math.min(prev.y + prev.size, s.y + s.size) - Math.max(prev.y, s.y);
      const sameLine = overlap >= 0.4 * Math.min(prev.size, s.size);
      const after = s.x >= prev.x + prev.width - 0.5 * size;
      if (!sameLine || !after) flush();
    }
    cur.push(s);
  }
  flush();
  return out;
}

function makeVLine(segs: Seg[]): VLine {
  let text = '';
  segs.forEach((s, i) => {
    if (i > 0) text += segSeparator(segs[i - 1], s);
    text += s.text;
  });
  const weights = new Map<string, number>();
  let maxW = -1;
  let size = segs[0].size;
  let font: Family = segs[0].font;
  for (const s of segs) {
    const w = s.text.trim().length;
    if (w > maxW) {
      maxW = w;
      size = s.size;
    }
    weights.set(s.font, (weights.get(s.font) ?? 0) + w);
  }
  let best = -1;
  for (const [f, w] of weights) {
    if (w > best) {
      best = w;
      font = f as Family;
    }
  }
  return {
    segs,
    x: Math.min(...segs.map((s) => s.x)),
    right: Math.max(...segs.map((s) => s.x + s.width)),
    y: Math.min(...segs.map((s) => s.y)),
    size,
    font,
    allBold: segs.every((s) => s.bold || !s.text.trim()),
    text,
    list: LIST_RE.test(text),
    heading: 0,
  };
}

/** Text inserted between two fragments of the same visual line. */
function segSeparator(prev: Seg, next: Seg): string {
  if (/\s$/.test(prev.text) || /^\s/.test(next.text)) return '';
  const gap = next.x - (prev.x + prev.width);
  const size = Math.max(prev.size, next.size);
  if (gap > 2.5 * size) return '\t';
  if (gap > 0.12 * size) return ' ';
  return '';
}

function layoutPage(page: SafePage, sec: SectionInfo, docBody: number): Block[] {
  const vlines = buildVLines(page.lines);
  const pageChars = page.lines.reduce((s, l) => s + l.text.length, 0);
  const body = pageChars >= 200 ? medianBodySize(page.lines) : docBody;
  const colLeft = sec.left;
  const colRight = page.width - sec.right;
  const colW = Math.max(1, colRight - colLeft);

  // Headings.
  for (let i = 0; i < vlines.length; i++) {
    const v = vlines[i];
    const ratio = v.size / body;
    if (ratio >= 1.6) v.heading = 1;
    else if (ratio >= 1.3) v.heading = 2;
    else if (v.allBold && ratio >= 0.95 && !v.list) {
      const words = v.text.trim().split(/\s+/).length;
      const short = v.text.trim().length <= 90 && words <= 12 && v.right - v.x < 0.75 * colW;
      const prev = vlines[i - 1];
      // Last line of a bold paragraph is not a heading.
      const continuesBold = prev && prev.allBold && prev.right - prev.x >= 0.75 * colW && v.y - prev.y > 0 && v.y - prev.y < 1.6 * prev.size;
      if (short && !continuesBold && !/[,;]$/.test(v.text.trim())) v.heading = 3;
    }
  }

  // Typical line pitch (relative to size) on this page: 30th percentile of plausible pitches.
  const ratios: number[] = [];
  for (let i = 1; i < vlines.length; i++) {
    const a = vlines[i - 1], b = vlines[i];
    if (Math.abs(a.size - b.size) > 0.12 * Math.max(a.size, b.size) + 0.5) continue;
    const r = (b.y - a.y) / a.size;
    if (r >= 0.9 && r <= 3) ratios.push(r);
  }
  ratios.sort((a, b) => a - b);
  const typicalRatio = ratios.length >= 3 ? ratios[Math.floor(ratios.length * 0.3)] : 1.2;
  const maxRatio = Math.max(1.6, typicalRatio * 1.15);

  const isCentered = (v: VLine) => {
    const c = (v.x + v.right) / 2;
    const w = v.right - v.x;
    const tol = Math.max(3, 0.03 * page.width);
    return w < 0.85 * colW && (Math.abs(c - page.width / 2) <= tol || Math.abs(c - (colLeft + colRight) / 2) <= tol);
  };

  // Paragraph grouping.
  const paras: Para[] = [];
  let cur: Para | null = null;
  const canMerge = (p: Para, m: VLine): boolean => {
    const l = p.lines[p.lines.length - 1];
    if (p.heading !== m.heading) return false;
    if (m.list) return false;
    if (l.text.includes('\t') || m.text.includes('\t')) return false; // table-like rows stay separate
    const size = Math.max(l.size, m.size);
    if (Math.abs(l.size - m.size) > 0.12 * size + 0.5) return false;
    if (l.font !== m.font) return false;
    const pitch = m.y - l.y;
    if (pitch < 0.5 * l.size || pitch > maxRatio * l.size) return false;
    if (p.lines.length >= 2 && pitch > p.pitch * 1.3 + 0.5) return false;
    const centered = p.lines.every(isCentered) && p.lines.some((v) => v.right - v.x < 0.85 * colW);
    if (centered) return isCentered(m);
    const tol = Math.max(2, 0.6 * size);
    if (p.lines.length === 1) {
      if (p.list) {
        if (m.x < l.x - tol || m.x > l.x + 4 * size) return false;
      } else if (m.x > l.x + tol || m.x < l.x - 4 * size) return false; // allow first-line indent
    } else {
      const bodyLeft = p.lines[1].x;
      if (Math.abs(m.x - bodyLeft) > tol) return false;
    }
    // Previous line ended well before the column edge: the paragraph is over.
    const refRight = p.lines.length >= 2 ? Math.max(...p.lines.map((v) => v.right)) : colRight;
    const refLeft = p.lines.length >= 2 ? p.lines[1].x : colLeft;
    if (l.right < refRight - 0.25 * Math.max(1, refRight - refLeft) && /[.!?:;)"'”’]$/.test(l.text.trim())) return false;
    return true;
  };
  for (const v of vlines) {
    if (cur && canMerge(cur, v)) {
      cur.lines.push(v);
      cur.pitch = (v.y - cur.lines[0].y) / (cur.lines.length - 1);
      continue;
    }
    cur = { kind: 'p', lines: [v], heading: v.heading, list: v.list, top: v.y, spaceBefore: 0, align: 'left', indLeft: 0, firstLine: 0, pitch: 0 };
    paras.push(cur);
  }

  // Paragraph properties.
  for (const p of paras) {
    const first = p.lines[0];
    const n = p.lines.length;
    const maxRight = Math.max(...p.lines.map((v) => v.right));
    const centered = p.lines.every(isCentered) && p.lines.some((v) => v.right - v.x < 0.85 * colW);
    const rightAligned =
      !centered && p.lines.every((v) => Math.abs(v.right - colRight) <= Math.max(2, 0.3 * v.size) && v.x > colLeft + 0.25 * colW);
    if (centered) p.align = 'center';
    else if (rightAligned) p.align = 'right';
    else if (n >= 3) {
      const tol = Math.max(1, 0.004 * colW);
      const full = p.lines.slice(0, -1).every((v) => Math.abs(v.right - maxRight) <= tol);
      if (full && maxRight > colRight - 0.1 * colW) p.align = 'both';
    }
    if (p.align === 'left' || p.align === 'both') {
      const bodyLeft = n >= 2 ? Math.min(...p.lines.slice(1).map((v) => v.x)) : first.x;
      p.indLeft = bodyLeft;
      p.firstLine = first.x - bodyLeft;
    }
  }

  // Merge with images in order of their top edge.
  const images = [...page.images].sort((a, b) => a.y - b.y);
  const blocks: Block[] = [];
  let ii = 0;
  for (const p of paras) {
    while (ii < images.length && images[ii].y <= p.top + 0.5 * p.lines[0].size) {
      blocks.push({ kind: 'img', image: images[ii], top: images[ii].y, spaceBefore: 0 });
      ii++;
    }
    blocks.push(p);
  }
  for (; ii < images.length; ii++) blocks.push({ kind: 'img', image: images[ii], top: images[ii].y, spaceBefore: 0 });

  // Vertical spacing: extra space beyond the natural advance of the previous block.
  let prevBottom = sec.top; // where the next line would naturally start
  for (const b of blocks) {
    if (b.kind === 'img') {
      b.spaceBefore = clampSpace(b.top - prevBottom, page.height);
      prevBottom = b.top + b.image.height;
    } else {
      const lead = b.lines[0].size * 0.15; // ascender gap included in a line box
      b.spaceBefore = clampSpace(b.top - prevBottom - lead, page.height);
      const last = b.lines[b.lines.length - 1];
      const advance = b.pitch > 0 ? b.pitch : last.size * 1.2;
      prevBottom = last.y + advance;
    }
  }
  return blocks;
}

function clampSpace(v: number, pageH: number): number {
  if (!Number.isFinite(v) || v < 1) return 0;
  return Math.min(v, pageH * 0.5);
}

// ---------------------------------------------------------------------------
// XML rendering
// ---------------------------------------------------------------------------

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS = {
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  wp: 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  pic: 'http://schemas.openxmlformats.org/drawingml/2006/picture',
};

const FONT_NAME: Record<Family, string> = { sans: 'Arial', serif: 'Times New Roman', mono: 'Courier New' };

interface MediaEntry {
  name: string;
  rid: string;
  data: Uint8Array;
}

interface BuildCtx {
  media: MediaEntry[];
  drawingId: number;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s: string) => esc(s).replace(/"/g, '&quot;');
const tw = (pt: number) => Math.round(pt * 20);
const EMU_PER_PT = 12700;

interface Run {
  text: string;
  font: Family;
  bold: boolean;
  italic: boolean;
  half: number; // size in half-points
  color?: string;
  vert?: 'superscript' | 'subscript';
}

const runKey = (r: Run) => `${r.font}|${r.bold ? 1 : 0}|${r.italic ? 1 : 0}|${r.half}|${r.color ?? ''}|${r.vert ?? ''}`;

/** Small fragment raised above / lowered below its line's baseline. */
function vertPosition(s: Seg, line: VLine): Run['vert'] {
  if (s.size >= 0.85 * line.size) return undefined;
  const base = line.segs.find((x) => x.size >= 0.85 * line.size) ?? line.segs[0];
  const lineBaseline = base.y + base.size * 0.8;
  const segBaseline = s.y + s.size * 0.8;
  if (lineBaseline - segBaseline > 0.15 * line.size) return 'superscript';
  if (segBaseline - lineBaseline > 0.1 * line.size) return 'subscript';
  return undefined;
}

function paragraphRuns(p: Para): Run[] {
  const runs: Run[] = [];
  const push = (text: string, s: Seg, line?: VLine) => {
    if (!text) return;
    const vert = line ? vertPosition(s, line) : undefined;
    // Word shrinks super/subscripts itself: give them the line's size.
    const size = vert && line ? line.size : s.size;
    const run: Run = { text, font: s.font, bold: s.bold, italic: s.italic, half: Math.max(2, Math.round(size * 2)), color: s.color, vert };
    const last = runs[runs.length - 1];
    if (last && runKey(last) === runKey(run)) last.text += text;
    else runs.push(run);
  };
  /** Separator text: appended to the previous run unless that is a super/subscript. */
  const appendSep = (text: string, next: Seg, line: VLine) => {
    const last = runs[runs.length - 1];
    if (last && !last.vert) last.text += text;
    else push(text, { ...next, size: line.size, y: line.y }, line);
  };
  p.lines.forEach((v, li) => {
    if (li > 0) {
      const last = runs[runs.length - 1];
      const nextText = v.segs[0].text;
      if (last) {
        if (/[A-Za-zÀ-ɏ]-$/.test(last.text) && /^[a-zß-ɏ]/.test(nextText)) {
          last.text = last.text.slice(0, -1); // de-hyphenate a word broken across lines
        } else if (/\u00AD$/.test(last.text)) {
          last.text = last.text.slice(0, -1);
        } else if (!/\s$/.test(last.text) && !/^\s/.test(nextText)) {
          appendSep(' ', v.segs[0], v);
        }
      }
    }
    v.segs.forEach((s, si) => {
      if (si > 0) {
        const sep = segSeparator(v.segs[si - 1], s);
        if (sep) appendSep(sep, s, v);
      }
      push(s.text, s, v);
    });
  });
  if (runs.length) {
    runs[0].text = runs[0].text.replace(/^\s+/, '');
    runs[runs.length - 1].text = runs[runs.length - 1].text.replace(/\s+$/, '');
  }
  return runs.filter((r) => r.text.length > 0);
}

function runXml(r: Run): string {
  const f = escAttr(FONT_NAME[r.font]);
  let rPr = `<w:rFonts w:ascii="${f}" w:hAnsi="${f}" w:cs="${f}"/>`;
  if (r.bold) rPr += '<w:b/><w:bCs/>';
  if (r.italic) rPr += '<w:i/><w:iCs/>';
  if (r.color && r.color !== '000000') rPr += `<w:color w:val="${r.color}"/>`;
  rPr += `<w:sz w:val="${r.half}"/><w:szCs w:val="${r.half}"/>`;
  if (r.vert) rPr += `<w:vertAlign w:val="${r.vert}"/>`;
  // Tabs become <w:tab/>; text pieces in <w:t>.
  let content = '';
  r.text.split('\t').forEach((part, i) => {
    if (i > 0) content += '<w:tab/>';
    if (part) content += `<w:t xml:space="preserve">${esc(part)}</w:t>`;
  });
  return `<w:r><w:rPr>${rPr}</w:rPr>${content}</w:r>`;
}

function renderBlock(b: Block, sec: SectionInfo, ctx: BuildCtx, pageBreak: boolean): string {
  if (b.kind === 'img') return imageParagraph(b, sec, ctx, pageBreak);
  let pPr = '';
  if (b.heading) pPr += `<w:pStyle w:val="Heading${b.heading}"/>`;
  if (b.heading) pPr += '<w:keepNext/>';
  if (pageBreak) pPr += '<w:pageBreakBefore/>';
  let spacing = `<w:spacing w:before="${tw(b.spaceBefore)}" w:after="0"`;
  if (b.pitch > 0) spacing += ` w:line="${Math.max(1, tw(b.pitch))}" w:lineRule="atLeast"`;
  pPr += spacing + '/>';
  if (b.align === 'left' || b.align === 'both') {
    const left = Math.max(-sec.left, b.indLeft - sec.left);
    let ind = '';
    if (Math.abs(left) >= 2) ind += ` w:left="${tw(left)}"`;
    if (b.firstLine >= 2) ind += ` w:firstLine="${tw(b.firstLine)}"`;
    else if (b.firstLine <= -2) ind += ` w:hanging="${tw(-b.firstLine)}"`;
    if (ind) pPr += `<w:ind${ind}/>`;
  }
  if (b.align !== 'left') pPr += `<w:jc w:val="${b.align}"/>`;
  const runs = paragraphRuns(b).map(runXml).join('');
  return `<w:p><w:pPr>${pPr}</w:pPr>${runs}</w:p>`;
}

function imageParagraph(b: ImgBlock, sec: SectionInfo, ctx: BuildCtx, pageBreak: boolean): string {
  const im = b.image;
  const kind = imageKind(im.png) ?? 'png';
  const idx = ctx.media.length + 1;
  const name = `image${idx}.${kind === 'png' ? 'png' : 'jpeg'}`;
  const rid = `rIdImg${idx}`;
  ctx.media.push({ name, rid, data: im.png });

  // Fit into the text area.
  const colW = Math.max(36, sec.width - sec.left - sec.right);
  const colH = Math.max(36, sec.height - sec.top - sec.bottom);
  const scale = Math.min(1, colW / im.width, colH / im.height);
  const w = im.width * scale;
  const h = im.height * scale;
  const cx = Math.max(1, Math.round(w * EMU_PER_PT));
  const cy = Math.max(1, Math.round(h * EMU_PER_PT));

  const center = im.x + im.width / 2;
  const centered = Math.abs(center - sec.width / 2) <= Math.max(3, 0.03 * sec.width) && im.width < 0.95 * colW;
  let pPr = pageBreak ? '<w:pageBreakBefore/>' : '';
  pPr += `<w:spacing w:before="${tw(b.spaceBefore)}" w:after="0"/>`;
  if (centered) pPr += '<w:jc w:val="center"/>';
  else {
    const left = Math.min(Math.max(0, im.x - sec.left), Math.max(0, colW - w));
    if (left >= 2) pPr += `<w:ind w:left="${tw(left)}"/>`;
  }
  const id = ctx.drawingId++;
  const drawing =
    `<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">` +
    `<wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>` +
    `<wp:docPr id="${id}" name="Picture ${id}"/>` +
    `<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>` +
    `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="${name}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
    `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>`;
  return `<w:p><w:pPr>${pPr}</w:pPr><w:r>${drawing}</w:r></w:p>`;
}

function sectPrXml(s: SectionInfo, type?: 'nextPage'): string {
  const landscape = s.width > s.height;
  const top = tw(s.top), bottom = tw(s.bottom);
  return (
    `<w:sectPr>${type ? `<w:type w:val="${type}"/>` : ''}` +
    `<w:pgSz w:w="${tw(s.width)}" w:h="${tw(s.height)}"${landscape ? ' w:orient="landscape"' : ''}/>` +
    `<w:pgMar w:top="${top}" w:right="${tw(s.right)}" w:bottom="${bottom}" w:left="${tw(s.left)}" ` +
    `w:header="${Math.min(720, Math.round(top / 2))}" w:footer="${Math.min(720, Math.round(bottom / 2))}" w:gutter="0"/>` +
    `<w:cols w:space="720"/></w:sectPr>`
  );
}

/** Attach a section break (describing `s`) to the last paragraph written. */
function closeSection(body: string[], s: SectionInfo): void {
  const sect = sectPrXml(s, 'nextPage');
  for (let i = body.length - 1; i >= 0; i--) {
    const p = body[i];
    if (!p.startsWith('<w:p>')) continue;
    body[i] = p.includes('<w:pPr>') ? p.replace('</w:pPr>', `${sect}</w:pPr>`) : p.replace('<w:p>', `<w:p><w:pPr>${sect}</w:pPr>`);
    return;
  }
  body.push(`<w:p><w:pPr>${sect}</w:pPr></w:p>`);
}

// ---------------------------------------------------------------------------
// Package parts
// ---------------------------------------------------------------------------

function contentTypesXml(media: MediaEntry[]): string {
  const hasJpeg = media.some((m) => m.name.endsWith('.jpeg'));
  return (
    XML_HEADER +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Default Extension="png" ContentType="image/png"/>' +
    (hasJpeg ? '<Default Extension="jpeg" ContentType="image/jpeg"/>' : '') +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
    '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>' +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
    '</Types>'
  );
}

const ROOT_RELS =
  XML_HEADER +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
  '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
  '</Relationships>';

function documentRelsXml(media: MediaEntry[]): string {
  return (
    XML_HEADER +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>' +
    media
      .map((m) => `<Relationship Id="${m.rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${m.name}"/>`)
      .join('') +
    '</Relationships>'
  );
}

function w3cdtf(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function coreXml(opts: DocxOptions): string {
  const now = w3cdtf(new Date());
  const title = typeof opts.title === 'string' ? cleanText(opts.title).trim() : '';
  const author = typeof opts.author === 'string' ? cleanText(opts.author).trim() : '';
  return (
    XML_HEADER +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
    'xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    (title ? `<dc:title>${esc(title)}</dc:title>` : '') +
    (author ? `<dc:creator>${esc(author)}</dc:creator><cp:lastModifiedBy>${esc(author)}</cp:lastModifiedBy>` : '') +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>` +
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>` +
    '</cp:coreProperties>'
  );
}

function appXml(pages: number): string {
  return (
    XML_HEADER +
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ' +
    'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
    `<Application>PDF Editor</Application><Pages>${pages}</Pages></Properties>`
  );
}

function stylesXml(pages: SafePage[], docBody: number): string {
  // Default font: the dominant family of the document.
  const counts: Record<Family, number> = { sans: 0, serif: 0, mono: 0 };
  for (const p of pages) for (const l of p.lines) counts[l.font] += l.text.length;
  const fam = (Object.keys(counts) as Family[]).sort((a, b) => counts[b] - counts[a])[0];
  const font = escAttr(FONT_NAME[fam]);
  const half = Math.max(2, Math.round(docBody * 2));
  const heading = (n: number, sz: number) =>
    `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/><w:basedOn w:val="Normal"/>` +
    `<w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/>` +
    `<w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="240" w:after="60"/><w:outlineLvl w:val="${n - 1}"/></w:pPr>` +
    `<w:rPr><w:b/><w:bCs/><w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/></w:rPr></w:style>`;
  return (
    XML_HEADER +
    `<w:styles xmlns:w="${NS.w}">` +
    '<w:docDefaults><w:rPrDefault><w:rPr>' +
    `<w:rFonts w:ascii="${font}" w:eastAsia="${font}" w:hAnsi="${font}" w:cs="${font}"/>` +
    `<w:sz w:val="${half}"/><w:szCs w:val="${half}"/><w:lang w:val="en-US" w:eastAsia="en-US" w:bidi="ar-SA"/>` +
    '</w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
    heading(1, Math.round(half * 1.8)) +
    heading(2, Math.round(half * 1.4)) +
    heading(3, Math.round(half * 1.15)) +
    '<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/>' +
    '<w:uiPriority w:val="1"/><w:semiHidden/><w:unhideWhenUsed/></w:style>' +
    '</w:styles>'
  );
}

const SETTINGS_XML =
  XML_HEADER +
  `<w:settings xmlns:w="${NS.w}">` +
  '<w:zoom w:percent="100"/><w:defaultTabStop w:val="720"/><w:characterSpacingControl w:val="doNotCompress"/>' +
  '<w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat>' +
  '</w:settings>';
