"use client";
/** Factories for new editor objects using the current tool style. */
import { useEditor, type Tool } from "./store";
import type { EditObj, FieldKind, ObjLayer, PageModel, Rect, Rot, TextObj } from "./types";
import { uprightRotate } from "./geometry";
import { measureTextBox } from "./textLayout";
import { uid } from "./util";

const st = () => useEditor.getState();

export function layerForTool(tool: Tool): ObjLayer {
  if (["highlight", "underline", "strikeout", "squiggly", "note", "textbox", "stamp"].includes(tool)) return "annot";
  return st().group === "comment" ? "annot" : "content";
}

function base(page: PageModel, rect: Rect, layer: ObjLayer, rotate?: Rot) {
  const now = Date.now();
  return {
    id: uid(),
    ...rect,
    rotate: rotate ?? uprightRotate(page),
    opacity: st().style.opacity,
    layer,
    author: st().author || "Guest",
    created: now,
    modified: now,
  };
}

/** Plane rect for an upright box of size dw×dh whose display top-left is at (u, v) (page units). */
export function displayBoxToPlane(page: PageModel, u: number, v: number, dw: number, dh: number, toPlane: (u: number, v: number) => [number, number]): Rect {
  const [x1, y1] = toPlane(u, v);
  const [x2, y2] = toPlane(u + dw, v + dh);
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
}

export function makeText(page: PageModel, at: { u: number; v: number }, toPlane: (u: number, v: number) => [number, number], opts: Partial<TextObj> = {}, layer: ObjLayer = "content"): TextObj {
  const s = st().style;
  const props = { font: s.font, bold: s.bold, italic: s.italic, size: s.size, lineHeight: 1.2, ...opts };
  const text = opts.text ?? "";
  const { w, h } = measureTextBox(text || " ", props, null);
  const rect = displayBoxToPlane(page, at.u, at.v, Math.max(w, props.size * 3), h, toPlane);
  return {
    ...base(page, rect, layer),
    type: "text",
    text,
    font: props.font,
    bold: props.bold,
    italic: props.italic,
    size: props.size,
    color: opts.color ?? s.textColor,
    align: "left",
    lineHeight: props.lineHeight,
    fill: opts.fill ?? null,
    border: opts.border ?? null,
    borderWidth: opts.borderWidth ?? 1,
    autoWidth: opts.autoWidth ?? true,
    ...(opts.replaces ? { replaces: opts.replaces } : {}),
  };
}

/** Recompute a text box size after its text/style changed. */
export function fitText(o: TextObj): TextObj {
  const quarter = o.rotate === 90 || o.rotate === 270;
  const lw = quarter ? o.h : o.w;
  const { w, h } = measureTextBox(o.text || " ", o, o.autoWidth ? null : lw);
  const nw = o.autoWidth ? Math.max(w, o.size * 1.5) : lw;
  const [bw, bh] = quarter ? [h, nw] : [nw, h];
  // keep the top-left corner as the reader sees it
  let { x, y } = o;
  if (o.rotate === 90) x = o.x + o.w - bw;
  else if (o.rotate === 180) {
    x = o.x + o.w - bw;
    y = o.y + o.h - bh;
  } else if (o.rotate === 270) y = o.y + o.h - bh;
  return { ...o, x, y, w: bw, h: bh };
}

export function makeShape(tool: Tool, page: PageModel, rect: Rect): EditObj | null {
  const s = st().style;
  const layer = layerForTool(tool);
  switch (tool) {
    case "rect":
    case "ellipse":
      return { ...base(page, rect, layer, 0), type: tool, stroke: s.color, strokeWidth: s.strokeWidth, fill: s.fill, dash: s.dash };
    case "whiteout":
      return { ...base(page, rect, "content", 0), type: "rect", stroke: null, strokeWidth: 0, fill: "#ffffff", dash: false, opacity: 1 };
    case "redact-area":
      return { ...base(page, rect, "content", 0), type: "redact", rects: [], fill: "#000000", overlayText: "", opacity: 1 };
    case "link":
      return { ...base(page, rect, "content", 0), type: "link", url: "", pageId: null, opacity: 1 };
    default:
      if (tool.startsWith("field-")) return makeField(tool.slice(6) as FieldKind, page, rect);
      return null;
  }
}

let fieldCounter = 1;
export function makeField(kind: FieldKind, page: PageModel, rect: Rect): EditObj {
  const n = fieldCounter++;
  const names: Record<FieldKind, string> = {
    text: "Text",
    checkbox: "Check Box",
    radio: "Radio Group",
    dropdown: "Dropdown",
    listbox: "List Box",
    signature: "Signature",
    button: "Button",
  };
  return {
    ...base(page, rect, "content", 0),
    opacity: 1,
    type: "field",
    fieldType: kind,
    name: kind === "radio" ? "Radio Group 1" : `${names[kind]} ${n}`,
    options: kind === "dropdown" || kind === "listbox" ? ["Option 1", "Option 2", "Option 3"] : [],
    multiline: false,
    required: false,
    readOnly: false,
    value: kind === "button" ? "Submit" : "",
    checked: false,
    fontSize: 0,
    tooltip: "",
    exportValue: kind === "radio" ? `Choice ${n}` : "",
  };
}

/** Default size (pt) of a click-placed field. */
export function defaultFieldSize(kind: FieldKind): [number, number] {
  switch (kind) {
    case "checkbox":
    case "radio":
      return [14, 14];
    case "listbox":
      return [150, 60];
    case "signature":
      return [180, 40];
    case "button":
      return [90, 24];
    default:
      return [160, 22];
  }
}

export function makeLine(tool: "line" | "arrow", x1: number, y1: number, x2: number, y2: number): EditObj {
  const s = st().style;
  const now = Date.now();
  const pad = Math.max(4, s.strokeWidth * 3);
  return {
    id: uid(),
    type: tool,
    x: Math.min(x1, x2) - pad,
    y: Math.min(y1, y2) - pad,
    w: Math.abs(x2 - x1) + pad * 2,
    h: Math.abs(y2 - y1) + pad * 2,
    x1,
    y1,
    x2,
    y2,
    rotate: 0,
    opacity: s.opacity,
    layer: layerForTool(tool),
    author: st().author || "Guest",
    created: now,
    modified: now,
    stroke: s.color,
    strokeWidth: s.strokeWidth,
    dash: s.dash,
  };
}

export function makeInk(paths: number[][], highlighter = false): EditObj {
  const s = st().style;
  const now = Date.now();
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const p of paths)
    for (let i = 0; i < p.length; i += 2) {
      x1 = Math.min(x1, p[i]);
      x2 = Math.max(x2, p[i]);
      y1 = Math.min(y1, p[i + 1]);
      y2 = Math.max(y2, p[i + 1]);
    }
  const sw = highlighter ? Math.max(8, s.strokeWidth * 4) : s.strokeWidth;
  const pad = sw / 2 + 1;
  return {
    id: uid(),
    type: "ink",
    x: x1 - pad,
    y: y1 - pad,
    w: x2 - x1 + pad * 2,
    h: y2 - y1 + pad * 2,
    rotate: 0,
    opacity: highlighter ? 0.4 : s.opacity,
    layer: layerForTool("ink"),
    author: st().author || "Guest",
    created: now,
    modified: now,
    paths,
    stroke: highlighter ? s.highlight : s.color,
    strokeWidth: sw,
  };
}

export function makeMarkup(type: "highlight" | "underline" | "strikeout" | "squiggly", rects: Rect[], text: string, page: PageModel): EditObj {
  const s = st().style;
  const u = unionOf(rects);
  return {
    ...base(page, u, "annot", 0),
    type,
    rects,
    color: type === "highlight" ? s.highlight : s.color,
    text,
    opacity: type === "highlight" ? 1 : 1,
  };
}

export function makeRedaction(rects: Rect[], page: PageModel, text = ""): EditObj {
  const u = unionOf(rects);
  return { ...base(page, u, "content", 0), type: "redact", rects, fill: "#000000", overlayText: "", opacity: 1, comment: text || undefined };
}

export function makeNote(page: PageModel, rect: Rect): EditObj {
  return { ...base(page, rect, "annot", 0), type: "note", color: "#ffd400", text: "" };
}

export function makeStamp(page: PageModel, rect: Rect, label: string, color: string, sub: string): EditObj {
  return { ...base(page, rect, layerForTool("stamp"), undefined), type: "stamp", label, sub, color };
}

export function makeMark(page: PageModel, rect: Rect, mark: "check" | "cross" | "dot" | "dash"): EditObj {
  return { ...base(page, rect, "content"), type: "mark", mark, color: st().style.color };
}

export function makeImage(page: PageModel, rect: Rect, src: string, kind: "image" | "signature" | "initials"): EditObj {
  return { ...base(page, rect, "content"), type: "image", src, kind, opacity: 1 };
}

export function unionOf(rects: Rect[]): Rect {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const r of rects) {
    x1 = Math.min(x1, r.x);
    y1 = Math.min(y1, r.y);
    x2 = Math.max(x2, r.x + r.w);
    y2 = Math.max(y2, r.y + r.h);
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}
