import type { EditObj, LineObj, Rect, Rot } from "./types";

let counter = 0;
export function uid(prefix = "o"): string {
  counter = (counter + 1) % 1e6;
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function normRot(r: number): Rot {
  const n = ((Math.round(r / 90) * 90) % 360 + 360) % 360;
  return n as Rot;
}

/** "#rrggbb" → [r,g,b] in 0..1 */
export function hexToRgb01(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h.padEnd(6, "0");
  const n = parseInt(full.slice(0, 6), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function rgbToHex(r: number, g: number, b: number): string {
  const c = (v: number) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

export function rgb01ToHex(rgb: number[] | Uint8ClampedArray | null | undefined, fallback = "#000000"): string {
  if (!rgb || rgb.length < 3) return fallback;
  const max = Math.max(rgb[0], rgb[1], rgb[2]);
  // pdf.js reports colors as 0..255 Uint8ClampedArray; pdf files as 0..1 numbers.
  return max > 1 ? rgbToHex(rgb[0], rgb[1], rgb[2]) : rgbToHex(rgb[0] * 255, rgb[1] * 255, rgb[2] * 255);
}

export function rectsIntersect(a: Rect, b: Rect) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

export function rectContains(a: Rect, x: number, y: number) {
  return x >= a.x && x <= a.x + a.w && y >= a.y && y <= a.y + a.h;
}

export function unionRects(rects: Rect[]): Rect {
  if (!rects.length) return { x: 0, y: 0, w: 0, h: 0 };
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const r of rects) {
    x1 = Math.min(x1, r.x);
    y1 = Math.min(y1, r.y);
    x2 = Math.max(x2, r.x + r.w);
    y2 = Math.max(y2, r.y + r.h);
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

export function normRect(x1: number, y1: number, x2: number, y2: number): Rect {
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
}

/**
 * Display transform for a page plane (unrotated page drawn at `pw`×`ph` CSS px)
 * so that it appears rotated clockwise by `r` inside its slot. transform-origin: 0 0.
 */
export function planeTransform(r: Rot, pw: number, ph: number): string {
  switch (r) {
    case 90:
      return `translate(${ph}px, 0px) rotate(90deg)`;
    case 180:
      return `translate(${pw}px, ${ph}px) rotate(180deg)`;
    case 270:
      return `translate(0px, ${pw}px) rotate(270deg)`;
    default:
      return "none";
  }
}

/** Slot-relative display point (CSS px) → plane point (CSS px). */
export function displayToPlane(r: Rot, u: number, v: number, pw: number, ph: number): [number, number] {
  switch (r) {
    case 90:
      return [v, ph - u];
    case 180:
      return [pw - u, ph - v];
    case 270:
      return [pw - v, u];
    default:
      return [u, v];
  }
}

/** Display delta → plane delta. */
export function deltaToPlane(r: Rot, du: number, dv: number): [number, number] {
  switch (r) {
    case 90:
      return [dv, -du];
    case 180:
      return [-du, -dv];
    case 270:
      return [-dv, du];
    default:
      return [du, dv];
  }
}

/** Plane rect → display rect (for scrolling into view etc.). */
export function planeRectToDisplay(r: Rot, rect: Rect, pw: number, ph: number): Rect {
  const pts: [number, number][] = [
    [rect.x, rect.y],
    [rect.x + rect.w, rect.y + rect.h],
  ].map(([x, y]) => {
    switch (r) {
      case 90:
        return [ph - y, x] as [number, number];
      case 180:
        return [pw - x, ph - y] as [number, number];
      case 270:
        return [y, pw - x] as [number, number];
      default:
        return [x, y] as [number, number];
    }
  });
  return normRect(pts[0][0], pts[0][1], pts[1][0], pts[1][1]);
}

export function lineBBox(o: Pick<LineObj, "x1" | "y1" | "x2" | "y2" | "strokeWidth">): Rect {
  const pad = Math.max(4, o.strokeWidth * 3);
  const r = normRect(o.x1, o.y1, o.x2, o.y2);
  return { x: r.x - pad, y: r.y - pad, w: r.w + pad * 2, h: r.h + pad * 2 };
}

export function inkBBox(paths: number[][], strokeWidth: number): Rect {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const p of paths)
    for (let i = 0; i < p.length; i += 2) {
      x1 = Math.min(x1, p[i]);
      x2 = Math.max(x2, p[i]);
      y1 = Math.min(y1, p[i + 1]);
      y2 = Math.max(y2, p[i + 1]);
    }
  if (!isFinite(x1)) return { x: 0, y: 0, w: 0, h: 0 };
  const pad = strokeWidth / 2 + 1;
  return { x: x1 - pad, y: y1 - pad, w: x2 - x1 + pad * 2, h: y2 - y1 + pad * 2 };
}

/** Translate an object by (dx, dy) in page space. */
export function moveObj<T extends EditObj>(o: T, dx: number, dy: number): T {
  const base = { ...o, x: o.x + dx, y: o.y + dy, modified: Date.now() };
  switch (o.type) {
    case "line":
    case "arrow":
      return { ...base, x1: o.x1 + dx, y1: o.y1 + dy, x2: o.x2 + dx, y2: o.y2 + dy } as T;
    case "ink":
      return { ...base, paths: o.paths.map((p) => p.map((v, i) => v + (i % 2 ? dy : dx))) } as T;
    case "highlight":
    case "underline":
    case "strikeout":
    case "squiggly":
      return { ...base, rects: o.rects.map((r) => ({ ...r, x: r.x + dx, y: r.y + dy })) } as T;
    case "redact":
      return { ...base, rects: o.rects.map((r) => ({ ...r, x: r.x + dx, y: r.y + dy })) } as T;
    case "text":
      return base as T;
    default:
      return base as T;
  }
}

/** Resize an object from its old bbox into `nb`, scaling inner geometry. */
export function resizeObj<T extends EditObj>(o: T, nb: Rect): T {
  const sx = o.w ? nb.w / o.w : 1;
  const sy = o.h ? nb.h / o.h : 1;
  const mx = (x: number) => nb.x + (x - o.x) * sx;
  const my = (y: number) => nb.y + (y - o.y) * sy;
  const base = { ...o, ...nb, modified: Date.now() };
  switch (o.type) {
    case "line":
    case "arrow":
      return { ...base, x1: mx(o.x1), y1: my(o.y1), x2: mx(o.x2), y2: my(o.y2) } as T;
    case "ink":
      return { ...base, paths: o.paths.map((p) => p.map((v, i) => (i % 2 ? my(v) : mx(v)))) } as T;
    case "text":
      return { ...base, autoWidth: false } as T;
    default:
      return base as T;
  }
}

export function dataUrlToBytes(dataUrl: string): { bytes: Uint8Array; mime: string } {
  const [head, body] = dataUrl.split(",");
  const mime = head.slice(5).split(";")[0];
  const bin = atob(body);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { bytes, mime };
}

export function bytesToDataUrl(bytes: Uint8Array, mime: string): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  return `data:${mime};base64,${btoa(bin)}`;
}

export function readFileAsDataUrl(file: Blob): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result as string);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(file);
  });
}

export async function readFileBytes(file: Blob): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}

export function downloadBlob(data: Uint8Array | Blob, name: string, mime = "application/pdf") {
  const blob = data instanceof Blob ? data : new Blob([data as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function baseName(name: string) {
  return name.replace(/\.[^.]+$/, "");
}

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/** Parse "1-3, 5, 8-" into 0-based indices within [0, count). */
export function parsePageRanges(input: string, count: number): number[] {
  const out: number[] = [];
  for (const part of input.split(/[,;\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d*)\s*-\s*(\d*)$/);
    if (m) {
      const a = m[1] ? parseInt(m[1], 10) : 1;
      const b = m[2] ? parseInt(m[2], 10) : count;
      for (let i = Math.max(1, a); i <= Math.min(count, b); i++) out.push(i - 1);
    } else if (/^\d+$/.test(part)) {
      const n = parseInt(part, 10);
      if (n >= 1 && n <= count) out.push(n - 1);
    }
  }
  return Array.from(new Set(out)).sort((a, b) => a - b);
}

export function formatDate(ts: number) {
  return new Date(ts).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error("Could not load image"));
    img.src = src;
  });
}

/** Re-encode any browser-decodable image (webp, gif, svg…) as PNG/JPEG data URL. */
export async function normalizeImage(src: string, maxDim = 3000): Promise<{ src: string; w: number; h: number }> {
  const img = await loadImage(src);
  const w = img.naturalWidth || 300;
  const h = img.naturalHeight || 150;
  const isPngJpg = /^data:image\/(png|jpe?g);/i.test(src);
  if (isPngJpg && Math.max(w, h) <= maxDim) return { src, w, h };
  const s = Math.min(1, maxDim / Math.max(w, h));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w * s));
  c.height = Math.max(1, Math.round(h * s));
  const ctx = c.getContext("2d")!;
  ctx.drawImage(img, 0, 0, c.width, c.height);
  const jpeg = /^data:image\/jpe?g/i.test(src);
  return { src: c.toDataURL(jpeg ? "image/jpeg" : "image/png", 0.92), w, h };
}
