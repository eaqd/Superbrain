import type { PageModel, Rect, Rot } from "./types";
import { displayToPlane, normRot } from "./util";

/** PDF transformation matrix [a b c d e f]: (x,y) → (a·x + c·y + e, b·x + d·y + f). */
export type Matrix = [number, number, number, number, number, number];

export function affineFrom3(f: (x: number, y: number) => [number, number]): Matrix {
  const [e, ff] = f(0, 0);
  const [x1, y1] = f(1, 0);
  const [x2, y2] = f(0, 1);
  return [x1 - e, y1 - ff, x2 - e, y2 - ff, e, ff].map((v) => (Math.abs(v) < 1e-9 ? 0 : v)) as Matrix;
}

export function applyMatrix(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** Visible box of a page in PDF user space (bottom-left origin). */
export interface PageBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Page-space (top-left origin, pt) point → PDF user space. */
export function toPdf(box: PageBox, x: number, y: number): [number, number] {
  return [box.x + x, box.y + box.height - y];
}

/** Page-space rect → PDF rect (bottom-left origin). */
export function rectToPdf(box: PageBox, r: Rect): { x: number; y: number; width: number; height: number } {
  return { x: box.x + r.x, y: box.y + box.height - r.y - r.h, width: r.w, height: r.h };
}

/**
 * Matrix mapping an object's *local upright* space (origin bottom-left, y up,
 * size lw×lh where lw/lh are swapped for 90°/270° objects) to PDF user space.
 */
export function objectMatrix(box: PageBox, o: { x: number; y: number; w: number; h: number; rotate: Rot }): Matrix {
  const quarter = o.rotate === 90 || o.rotate === 270;
  const lw = quarter ? o.h : o.w;
  const lh = quarter ? o.w : o.h;
  const cx = o.x + o.w / 2;
  const cy = o.y + o.h / 2;
  const t = (o.rotate * Math.PI) / 180;
  const cos = Math.round(Math.cos(t));
  const sin = Math.round(Math.sin(t));
  return affineFrom3((s, tt) => {
    // local upright (y up) → local display (y down) relative to the box centre
    const u = s - lw / 2;
    const v = lh - tt - lh / 2;
    // CSS rotate(θ) in a y-down space (clockwise on screen)
    const px = cx + u * cos - v * sin;
    const py = cy + u * sin + v * cos;
    return toPdf(box, px, py);
  });
}

export function localSize(o: { w: number; h: number; rotate: Rot }): [number, number] {
  return o.rotate === 90 || o.rotate === 270 ? [o.h, o.w] : [o.w, o.h];
}

/**
 * Matrix mapping the page's *displayed upright* space (origin bottom-left of the page as
 * the reader sees it, after rotation; y up) to PDF user space. Used for watermarks,
 * headers/footers and page numbers which must follow the reading orientation.
 */
export function uprightMatrix(box: PageBox, rotation: Rot): { m: Matrix; width: number; height: number } {
  const quarter = rotation === 90 || rotation === 270;
  const dW = quarter ? box.height : box.width;
  const dH = quarter ? box.width : box.height;
  const m = affineFrom3((s, t) => {
    const [x, y] = displayToPlane(rotation, s, dH - t, box.width, box.height);
    return toPdf(box, x, y);
  });
  return { m, width: dW, height: dH };
}

export function displayRotation(p: Pick<PageModel, "baseRotation" | "rotation">): Rot {
  return normRot(p.baseRotation + p.rotation);
}

export function displaySize(p: Pick<PageModel, "width" | "height" | "baseRotation" | "rotation">): [number, number] {
  const r = displayRotation(p);
  return r === 90 || r === 270 ? [p.height, p.width] : [p.width, p.height];
}

/** Page rotation needed for a new object so it reads upright on screen. */
export function uprightRotate(p: Pick<PageModel, "baseRotation" | "rotation">): Rot {
  return normRot(360 - displayRotation(p));
}
