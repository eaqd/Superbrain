"use client";
import { getPage } from "./pdfjs";
import type { SourceDoc } from "./types";

/** Renders page thumbnails (unrotated) as object URLs, two at a time. */
const cache = new Map<string, Promise<string>>();
const queue: (() => Promise<void>)[] = [];
let running = 0;
const MAX = 2;

function pump() {
  while (running < MAX && queue.length) {
    const job = queue.shift()!;
    running++;
    job().finally(() => {
      running--;
      pump();
    });
  }
}

export function thumbnail(src: SourceDoc, index: number, width: number): Promise<string> {
  const bucket = width <= 140 ? 140 : width <= 260 ? 260 : 420;
  const key = `${src.id}:${index}:${bucket}`;
  let p = cache.get(key);
  if (!p) {
    p = new Promise<string>((resolve, reject) => {
      queue.push(async () => {
        try {
          const page = await getPage(src.pdf, index);
          const base = page.getViewport({ scale: 1, rotation: 0 });
          const scale = (bucket * Math.min(2, window.devicePixelRatio || 1)) / base.width;
          const vp = page.getViewport({ scale, rotation: 0 });
          const c = document.createElement("canvas");
          c.width = Math.max(1, Math.round(vp.width));
          c.height = Math.max(1, Math.round(vp.height));
          const ctx = c.getContext("2d")!;
          ctx.fillStyle = "#fff";
          ctx.fillRect(0, 0, c.width, c.height);
          await page.render({ canvas: c, canvasContext: ctx, viewport: vp, annotationMode: 1 } as never).promise;
          const blob: Blob = await new Promise((res) => c.toBlob((b) => res(b!), "image/png"));
          resolve(URL.createObjectURL(blob));
        } catch (e) {
          cache.delete(key);
          reject(e);
        }
      });
      pump();
    });
    cache.set(key, p);
  }
  return p;
}
