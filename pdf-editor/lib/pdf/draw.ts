/**
 * Turns editor objects into PDF drawing operators. The same operator lists are
 * used for page content (Edit / Fill & Sign / flattened comments) and for
 * annotation appearance streams (Comment tools), so both look identical.
 */
import {
  PDFDocument,
  PDFFont,
  PDFImage,
  PDFName,
  PDFOperator,
  StandardFonts,
  appendBezierCurve,
  beginText,
  closePath,
  concatTransformationMatrix,
  endText,
  fill,
  fillAndStroke,
  lineTo,
  moveTo,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  setDashPattern,
  setFillingRgbColor,
  setFontAndSize,
  setGraphicsState,
  setLineCap,
  setLineJoin,
  setLineWidth,
  setStrokingRgbColor,
  setTextMatrix,
  showText,
  stroke,
  drawObject,
  LineCapStyle,
  LineJoinStyle,
  PDFDict,
} from "@cantoo/pdf-lib";
import type { EditObj, FontKey, ImageObj, MarkObj, NoteObj, Rect, StampObj, TextObj } from "./types";
import { CSS_METRICS, TEXT_PAD, isWinAnsi, layoutText, standardFontName } from "./textLayout";
import { dataUrlToBytes, hexToRgb01 } from "./util";

/** Where operators go; resources are registered on demand. */
export interface Sink {
  ops: PDFOperator[];
  font(f: PDFFont): PDFName;
  image(img: PDFImage): PDFName;
  gs(opacity: number, blend?: "Multiply"): PDFName;
}

/** Per-document cache of embedded fonts and images. */
export class Resources {
  private fonts = new Map<string, Promise<PDFFont>>();
  private images = new Map<string, Promise<PDFImage>>();
  constructor(
    public doc: PDFDocument,
    private unicodeFont: () => Promise<Uint8Array | null>,
  ) {}

  standard(name: StandardFonts): Promise<PDFFont> {
    let p = this.fonts.get(name);
    if (!p) {
      p = this.doc.embedFont(name);
      this.fonts.set(name, p);
    }
    return p;
  }

  /** Font able to show `text`: a standard font, or the bundled Unicode font as fallback. */
  async fontFor(text: string, font: FontKey, bold: boolean, italic: boolean): Promise<PDFFont> {
    if (isWinAnsi(text)) return this.standard(standardFontName(font, bold, italic));
    let p = this.fonts.get("unicode");
    if (!p) {
      p = (async () => {
        const bytes = await this.unicodeFont();
        if (!bytes) throw new Error("no unicode font");
        return this.doc.embedFont(bytes, { subset: true });
      })();
      this.fonts.set("unicode", p);
    }
    try {
      return await p;
    } catch {
      return this.standard(standardFontName(font, bold, italic));
    }
  }

  image(src: string): Promise<PDFImage> {
    let p = this.images.get(src);
    if (!p) {
      const { bytes, mime } = dataUrlToBytes(src);
      p = /jpe?g/i.test(mime) ? this.doc.embedJpg(bytes) : this.doc.embedPng(bytes);
      this.images.set(src, p);
    }
    return p;
  }
}

/** Encode text for a font, replacing characters it cannot represent. */
export function safeEncode(font: PDFFont, text: string) {
  try {
    return font.encodeText(text);
  } catch {
    const cleaned = Array.from(text)
      .map((ch) => {
        try {
          font.encodeText(ch);
          return ch;
        } catch {
          return "?";
        }
      })
      .join("");
    return font.encodeText(cleaned);
  }
}

const rgb = (hex: string) => hexToRgb01(hex);

function strokeStyle(sink: Sink, color: string, width: number, dash = false) {
  const [r, g, b] = rgb(color);
  sink.ops.push(setStrokingRgbColor(r, g, b), setLineWidth(width), setLineCap(LineCapStyle.Round), setLineJoin(LineJoinStyle.Round));
  if (dash) sink.ops.push(setDashPattern([width * 3, width * 2], 0));
}

function fillColor(sink: Sink, color: string) {
  const [r, g, b] = rgb(color);
  sink.ops.push(setFillingRgbColor(r, g, b));
}

const K = 0.5522847498;
function ellipsePath(ops: PDFOperator[], cx: number, cy: number, rx: number, ry: number) {
  ops.push(
    moveTo(cx + rx, cy),
    appendBezierCurve(cx + rx, cy + ry * K, cx + rx * K, cy + ry, cx, cy + ry),
    appendBezierCurve(cx - rx * K, cy + ry, cx - rx, cy + ry * K, cx - rx, cy),
    appendBezierCurve(cx - rx, cy - ry * K, cx - rx * K, cy - ry, cx, cy - ry),
    appendBezierCurve(cx + rx * K, cy - ry, cx + rx, cy - ry * K, cx + rx, cy),
    closePath(),
  );
}

function roundRectPath(ops: PDFOperator[], x: number, y: number, w: number, h: number, r: number) {
  r = Math.min(r, w / 2, h / 2);
  ops.push(
    moveTo(x + r, y),
    lineTo(x + w - r, y),
    appendBezierCurve(x + w - r + r * K, y, x + w, y + r - r * K, x + w, y + r),
    lineTo(x + w, y + h - r),
    appendBezierCurve(x + w, y + h - r + r * K, x + w - r + r * K, y + h, x + w - r, y + h),
    lineTo(x + r, y + h),
    appendBezierCurve(x + r - r * K, y + h, x, y + h - r + r * K, x, y + h - r),
    lineTo(x, y + r),
    appendBezierCurve(x, y + r - r * K, x + r - r * K, y, x + r, y),
    closePath(),
  );
}

/* ---------------- objects drawn in LOCAL upright space (0,0)-(lw,lh) ---------------- */

export async function drawTextOps(sink: Sink, res: Resources, o: TextObj, lw: number, lh: number) {
  const ops = sink.ops;
  if (o.fill || (o.border && o.borderWidth > 0)) {
    ops.push(pushGraphicsState());
    if (o.fill) fillColor(sink, o.fill);
    if (o.border && o.borderWidth > 0) strokeStyle(sink, o.border, o.borderWidth);
    const bw = o.border ? o.borderWidth / 2 : 0;
    ops.push(rectangle(bw, bw, lw - bw * 2, lh - bw * 2));
    ops.push(o.fill && o.border && o.borderWidth > 0 ? fillAndStroke() : o.fill ? fill() : stroke());
    ops.push(popGraphicsState());
  }
  if (!o.text) return;
  const font = await res.fontFor(o.text, o.font, o.bold, o.italic);
  const layout = layoutText(o.text, o, o.autoWidth ? null : Math.max(4, lw - TEXT_PAD * 2));
  const L = layout.lineHeight;
  const m = CSS_METRICS[o.font];
  const key = sink.font(font);
  const [r, g, b] = rgb(o.color);
  ops.push(beginText(), setFontAndSize(key, o.size), setFillingRgbColor(r, g, b));
  layout.lines.forEach((line, i) => {
    if (!line) return;
    const baselineFromTop = TEXT_PAD + i * L + (L - (m.ascent + m.descent) * o.size) / 2 + m.ascent * o.size;
    let width = 0;
    try {
      width = font.widthOfTextAtSize(line, o.size);
    } catch {
      width = line.length * o.size * 0.5;
    }
    const x = o.align === "center" ? (lw - width) / 2 : o.align === "right" ? lw - TEXT_PAD - width : TEXT_PAD;
    // Synthesize italics only for the Unicode fallback font (standard fonts have real italic faces).
    const skew = o.italic && !/Oblique|Italic/i.test(font.name) ? 0.21 : 0;
    ops.push(setTextMatrix(1, 0, skew, 1, x, lh - baselineFromTop));
    ops.push(showText(safeEncode(font, line)));
  });
  ops.push(endText());
}

export async function drawImageOps(sink: Sink, res: Resources, o: ImageObj, lw: number, lh: number) {
  const img = await res.image(o.src);
  const key = sink.image(img);
  sink.ops.push(pushGraphicsState(), concatTransformationMatrix(lw, 0, 0, lh, 0, 0), drawObject(key), popGraphicsState());
}

export function drawShapeOps(sink: Sink, o: { type: "rect" | "ellipse"; stroke: string | null; strokeWidth: number; fill: string | null; dash: boolean }, lw: number, lh: number) {
  const ops = sink.ops;
  const sw = o.stroke ? o.strokeWidth : 0;
  ops.push(pushGraphicsState());
  if (o.fill) fillColor(sink, o.fill);
  if (o.stroke && sw > 0) strokeStyle(sink, o.stroke, sw, o.dash);
  if (o.type === "rect") ops.push(rectangle(sw / 2, sw / 2, Math.max(0, lw - sw), Math.max(0, lh - sw)));
  else ellipsePath(ops, lw / 2, lh / 2, Math.max(0, (lw - sw) / 2), Math.max(0, (lh - sw) / 2));
  ops.push(o.fill && o.stroke && sw > 0 ? fillAndStroke() : o.fill ? fill() : stroke());
  ops.push(popGraphicsState());
}

export function drawNoteIcon(sink: Sink, o: NoteObj, lw: number, lh: number) {
  const ops = sink.ops;
  ops.push(pushGraphicsState());
  fillColor(sink, o.color);
  strokeStyle(sink, "#3a3a3a", 0.8);
  roundRectPath(ops, 1, lh * 0.25, lw - 2, lh * 0.73, 2.5);
  ops.push(fillAndStroke());
  // tail
  ops.push(moveTo(lw * 0.25, lh * 0.25), lineTo(lw * 0.2, 1), lineTo(lw * 0.48, lh * 0.25), closePath(), fillAndStroke());
  // text lines
  strokeStyle(sink, "#3a3a3a", 0.9);
  for (const f of [0.78, 0.6, 0.42]) ops.push(moveTo(lw * 0.22, lh * f), lineTo(lw * 0.78, lh * f), stroke());
  ops.push(popGraphicsState());
}

export async function drawStampOps(sink: Sink, res: Resources, o: StampObj, lw: number, lh: number) {
  const ops = sink.ops;
  const bw = Math.max(1.5, Math.min(lw, lh) * 0.045);
  ops.push(pushGraphicsState());
  strokeStyle(sink, o.color, bw);
  roundRectPath(ops, bw / 2, bw / 2, lw - bw, lh - bw, Math.min(lw, lh) * 0.18);
  ops.push(stroke());
  ops.push(popGraphicsState());
  const bold = await res.standard(StandardFonts.HelveticaBold);
  const regular = await res.standard(StandardFonts.Helvetica);
  const [r, g, b] = rgb(o.color);
  const hasSub = !!o.sub;
  let size = lh * (hasSub ? 0.4 : 0.56);
  const tw = bold.widthOfTextAtSize(o.label || " ", 1);
  size = Math.min(size, (lw * 0.86) / Math.max(tw, 0.01));
  const labelY = hasSub ? lh * 0.48 : (lh - size * 0.72) / 2;
  ops.push(beginText(), setFillingRgbColor(r, g, b), setFontAndSize(sink.font(bold), size));
  ops.push(setTextMatrix(1, 0, 0, 1, (lw - tw * size) / 2, labelY), showText(safeEncode(bold, o.label)));
  if (hasSub) {
    let ss = lh * 0.17;
    const sw = regular.widthOfTextAtSize(o.sub, 1);
    ss = Math.min(ss, (lw * 0.86) / Math.max(sw, 0.01));
    ops.push(setFontAndSize(sink.font(regular), ss), setTextMatrix(1, 0, 0, 1, (lw - sw * ss) / 2, lh * 0.2), showText(safeEncode(regular, o.sub)));
  }
  ops.push(endText());
}

export function drawMarkOps(sink: Sink, o: MarkObj, lw: number, lh: number) {
  const ops = sink.ops;
  const s = Math.min(lw, lh);
  const sw = Math.max(1, s * 0.12);
  ops.push(pushGraphicsState());
  strokeStyle(sink, o.color, sw);
  switch (o.mark) {
    case "check":
      ops.push(moveTo(lw * 0.12, lh * 0.52), lineTo(lw * 0.4, lh * 0.2), lineTo(lw * 0.9, lh * 0.85), stroke());
      break;
    case "cross":
      ops.push(moveTo(lw * 0.15, lh * 0.15), lineTo(lw * 0.85, lh * 0.85), moveTo(lw * 0.15, lh * 0.85), lineTo(lw * 0.85, lh * 0.15), stroke());
      break;
    case "dot":
      fillColor(sink, o.color);
      ellipsePath(ops, lw / 2, lh / 2, lw * 0.35, lh * 0.35);
      ops.push(fill());
      break;
    case "dash":
      ops.push(moveTo(lw * 0.1, lh / 2), lineTo(lw * 0.9, lh / 2), stroke());
      break;
  }
  ops.push(popGraphicsState());
}

/* ---------------- objects drawn directly in PDF page space ---------------- */

export function drawLineOps(
  sink: Sink,
  o: { type: "line" | "arrow"; stroke: string; strokeWidth: number; dash: boolean },
  p1: [number, number],
  p2: [number, number],
) {
  const ops = sink.ops;
  ops.push(pushGraphicsState());
  strokeStyle(sink, o.stroke, o.strokeWidth, o.dash);
  ops.push(moveTo(p1[0], p1[1]), lineTo(p2[0], p2[1]), stroke());
  if (o.type === "arrow") {
    if (o.dash) ops.push(setDashPattern([], 0));
    const ang = Math.atan2(p2[1] - p1[1], p2[0] - p1[0]);
    const len = Math.max(9, o.strokeWidth * 4.5);
    for (const d of [Math.PI - 0.5, Math.PI + 0.5]) {
      ops.push(moveTo(p2[0], p2[1]), lineTo(p2[0] + len * Math.cos(ang + d), p2[1] + len * Math.sin(ang + d)));
    }
    ops.push(stroke());
  }
  ops.push(popGraphicsState());
}

export function drawInkOps(sink: Sink, color: string, width: number, paths: [number, number][][]) {
  const ops = sink.ops;
  ops.push(pushGraphicsState());
  strokeStyle(sink, color, width);
  for (const path of paths) {
    if (!path.length) continue;
    ops.push(moveTo(path[0][0], path[0][1]));
    if (path.length === 1) ops.push(lineTo(path[0][0] + 0.01, path[0][1]));
    // Smooth with quadratic midpoints → cubic Béziers.
    for (let i = 1; i < path.length - 1; i++) {
      const [x0, y0] = path[i];
      const [x1, y1] = path[i + 1];
      const mx = (x0 + x1) / 2;
      const my = (y0 + y1) / 2;
      const [px, py] = i === 1 ? path[0] : [(path[i - 1][0] + x0) / 2, (path[i - 1][1] + y0) / 2];
      ops.push(appendBezierCurve(px + (2 / 3) * (x0 - px), py + (2 / 3) * (y0 - py), mx + (2 / 3) * (x0 - mx), my + (2 / 3) * (y0 - my), mx, my));
    }
    if (path.length > 1) ops.push(lineTo(path[path.length - 1][0], path[path.length - 1][1]));
  }
  ops.push(stroke(), popGraphicsState());
}

/** Text-markup rects already in PDF space (bottom-left origin). */
export function drawMarkupOps(sink: Sink, type: "highlight" | "underline" | "strikeout" | "squiggly", color: string, rects: { x: number; y: number; width: number; height: number }[]) {
  const ops = sink.ops;
  ops.push(pushGraphicsState());
  if (type === "highlight") {
    ops.push(setGraphicsState(sink.gs(1, "Multiply")));
    fillColor(sink, color);
    for (const r of rects) ops.push(rectangle(r.x, r.y, r.width, r.height));
    ops.push(fill());
  } else {
    for (const r of rects) {
      const w = Math.max(0.6, r.height * 0.07);
      strokeStyle(sink, color, w);
      if (type === "underline") {
        const y = r.y + r.height * 0.08;
        ops.push(moveTo(r.x, y), lineTo(r.x + r.width, y));
      } else if (type === "strikeout") {
        const y = r.y + r.height * 0.45;
        ops.push(moveTo(r.x, y), lineTo(r.x + r.width, y));
      } else {
        const amp = r.height * 0.06;
        const step = Math.max(2, r.height * 0.15);
        const y = r.y + amp + 0.5;
        ops.push(moveTo(r.x, y));
        let up = true;
        for (let x = r.x + step; x <= r.x + r.width + 0.01; x += step) {
          ops.push(lineTo(x, y + (up ? amp * 2 : 0)));
          up = !up;
        }
      }
      ops.push(stroke());
    }
  }
  ops.push(popGraphicsState());
}

/** Rects of a markup/redaction object in PDF space. */
export function markupRects(rects: Rect[], toPdfRect: (r: Rect) => { x: number; y: number; width: number; height: number }) {
  return rects.map(toPdfRect);
}

/** Objects that are drawn in their own local upright box. */
export function isBoxObject(o: EditObj): boolean {
  return ["text", "image", "rect", "ellipse", "note", "stamp", "mark"].includes(o.type);
}

export async function drawBoxObject(sink: Sink, res: Resources, o: EditObj, lw: number, lh: number) {
  switch (o.type) {
    case "text":
      return drawTextOps(sink, res, o, lw, lh);
    case "image":
      return drawImageOps(sink, res, o, lw, lh);
    case "rect":
    case "ellipse":
      return drawShapeOps(sink, o, lw, lh);
    case "note":
      return drawNoteIcon(sink, o, lw, lh);
    case "stamp":
      return drawStampOps(sink, res, o, lw, lh);
    case "mark":
      return drawMarkOps(sink, o, lw, lh);
  }
}

/** A Sink that writes into a page's resources. */
export function pageSink(page: { node: { newFontDictionary(tag: string, ref: import("@cantoo/pdf-lib").PDFRef): PDFName; newXObject(tag: string, ref: import("@cantoo/pdf-lib").PDFRef): PDFName; newExtGState(tag: string, dict: PDFDict): PDFName } }, doc: PDFDocument): Sink {
  const fonts = new Map<PDFFont, PDFName>();
  const images = new Map<PDFImage, PDFName>();
  const states = new Map<string, PDFName>();
  return {
    ops: [],
    font(f) {
      let n = fonts.get(f);
      if (!n) fonts.set(f, (n = page.node.newFontDictionary("EdF", f.ref)));
      return n;
    },
    image(img) {
      let n = images.get(img);
      if (!n) images.set(img, (n = page.node.newXObject("EdI", img.ref)));
      return n;
    },
    gs(opacity, blend) {
      const k = `${opacity}:${blend ?? ""}`;
      let n = states.get(k);
      if (!n) {
        const dict = doc.context.obj({ Type: "ExtGState", ca: opacity, CA: opacity, ...(blend ? { BM: blend } : {}) });
        states.set(k, (n = page.node.newExtGState("EdG", dict)));
      }
      return n;
    },
  };
}

/** A Sink that collects resources for an appearance stream (form XObject). */
export function formSink(doc: PDFDocument): Sink & { resources(): PDFDict } {
  const font = new Map<PDFFont, string>();
  const xo = new Map<PDFImage, string>();
  const gs = new Map<string, { name: string; dict: PDFDict }>();
  return {
    ops: [],
    font(f) {
      let n = font.get(f);
      if (!n) font.set(f, (n = `F${font.size}`));
      return PDFName.of(n);
    },
    image(img) {
      let n = xo.get(img);
      if (!n) xo.set(img, (n = `Im${xo.size}`));
      return PDFName.of(n);
    },
    gs(opacity, blend) {
      const k = `${opacity}:${blend ?? ""}`;
      let e = gs.get(k);
      if (!e) {
        e = { name: `GS${gs.size}`, dict: doc.context.obj({ Type: "ExtGState", ca: opacity, CA: opacity, ...(blend ? { BM: blend } : {}) }) };
        gs.set(k, e);
      }
      return PDFName.of(e.name);
    },
    resources() {
      const Font: Record<string, import("@cantoo/pdf-lib").PDFRef> = {};
      font.forEach((n, f) => (Font[n] = f.ref));
      const XObject: Record<string, import("@cantoo/pdf-lib").PDFRef> = {};
      xo.forEach((n, i) => (XObject[n] = i.ref));
      const ExtGState: Record<string, PDFDict> = {};
      gs.forEach((e) => (ExtGState[e.name] = e.dict));
      return doc.context.obj({ Font, XObject, ExtGState }) as PDFDict;
    },
  };
}
