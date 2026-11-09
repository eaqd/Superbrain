"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */
/** Convert an (already exported) PDF to images, plain text or HTML. */
import { zipSync } from "fflate";
import { openPdf } from "../pdfjs";

export interface ImageExportOptions {
  format: "png" | "jpeg";
  dpi: number;
  quality: number;
  pages: number[];
  onProgress?: (msg: string) => void;
}

export async function pdfToImages(bytes: Uint8Array, base: string, opts: ImageExportOptions): Promise<{ data: Uint8Array; name: string; mime: string }> {
  const pdf = await openPdf(bytes);
  const files: Record<string, Uint8Array> = {};
  let last: { data: Uint8Array; name: string } | null = null;
  try {
    for (let n = 0; n < opts.pages.length; n++) {
      const i = opts.pages[n];
      opts.onProgress?.(`Rendering page ${i + 1} (${n + 1} of ${opts.pages.length})…`);
      const page = await pdf.getPage(i + 1);
      const vp = page.getViewport({ scale: opts.dpi / 72 });
      const c = document.createElement("canvas");
      c.width = Math.round(vp.width);
      c.height = Math.round(vp.height);
      const ctx = c.getContext("2d")!;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvas: c, canvasContext: ctx, viewport: vp, annotationMode: 3 } as any).promise;
      const mime = opts.format === "png" ? "image/png" : "image/jpeg";
      const blob: Blob = await new Promise((res) => c.toBlob((b) => res(b!), mime, opts.quality));
      const data = new Uint8Array(await blob.arrayBuffer());
      const name = `${base}-page-${String(i + 1).padStart(String(pdf.numPages).length, "0")}.${opts.format === "png" ? "png" : "jpg"}`;
      files[name] = data;
      last = { data, name };
      page.cleanup();
    }
  } finally {
    await pdf.loadingTask.destroy();
  }
  if (opts.pages.length === 1 && last) return { ...last, mime: opts.format === "png" ? "image/png" : "image/jpeg" };
  return { data: zipSync(files, { level: 0 }), name: `${base}-images.zip`, mime: "application/zip" };
}

export interface TextLine {
  text: string;
  x: number;
  y: number;
  width: number;
  size: number;
  fontName: string;
  bold: boolean;
  italic: boolean;
  font: "sans" | "serif" | "mono";
}

/** Group pdf.js text items into visual lines (page space, top-left origin). */
export async function extractLines(bytes: Uint8Array, onProgress?: (m: string) => void): Promise<{ width: number; height: number; lines: TextLine[] }[]> {
  const pdf = await openPdf(bytes);
  const out: { width: number; height: number; lines: TextLine[] }[] = [];
  try {
    for (let i = 0; i < pdf.numPages; i++) {
      onProgress?.(`Reading page ${i + 1} of ${pdf.numPages}…`);
      const page = await pdf.getPage(i + 1);
      const vp = page.getViewport({ scale: 1 });
      const tc: any = await page.getTextContent();
      // resolve real font names (bold/italic) through a cheap operator-list pass
      await page.getOperatorList().catch(() => null);
      const lines: TextLine[] = [];
      let cur: TextLine | null = null;
      for (const it of tc.items) {
        if (typeof it.str !== "string") continue;
        const [a, b, c, d, e, f] = vp.transform;
        const t = it.transform;
        // transform item origin into viewport space
        const x = a * t[4] + c * t[5] + e;
        const y = b * t[4] + d * t[5] + f;
        const size = Math.hypot(t[2], t[3]) || Math.hypot(t[0], t[1]) || 10;
        let fontObj: any = null;
        try {
          if ((page as any).commonObjs.has(it.fontName)) fontObj = (page as any).commonObjs.get(it.fontName);
        } catch {
          /* ignore */
        }
        const name: string = (fontObj?.name ?? "").replace(/^[A-Z]{6}\+/, "");
        const generic = tc.styles[it.fontName]?.fontFamily ?? "sans-serif";
        const font: TextLine["font"] = /mono|courier|consol/i.test(name) || generic === "monospace" ? "mono" : /serif|times|roman|georgia|garamond|cambria/i.test(name) && !/sans/i.test(name) ? "serif" : generic === "serif" ? "serif" : "sans";
        const bold = /bold|black|heavy|semibold|demi/i.test(name) || !!fontObj?.bold;
        const italic = /italic|oblique/i.test(name) || !!fontObj?.italic;
        const top = y - size * 0.85;
        if (cur && Math.abs(cur.y - top) < size * 0.4 && x <= cur.x + cur.width + size * 2 && x >= cur.x - size) {
          const gap = x - (cur.x + cur.width);
          if (gap > size * 0.15 && !cur.text.endsWith(" ") && !it.str.startsWith(" ")) cur.text += " ";
          cur.text += it.str;
          cur.width = Math.max(cur.width, x + it.width - cur.x);
        } else if (it.str.trim()) {
          cur = { text: it.str, x, y: top, width: it.width, size, fontName: name, bold, italic, font };
          lines.push(cur);
        }
        if (it.hasEOL) cur = null;
      }
      out.push({ width: vp.width, height: vp.height, lines: lines.map((l) => ({ ...l, text: l.text.replace(/\s+$/, "") })) });
      page.cleanup();
    }
  } finally {
    await pdf.loadingTask.destroy();
  }
  return out;
}

export function linesToText(pages: { lines: TextLine[] }[]): string {
  return pages
    .map((p) => {
      const sorted = [...p.lines].sort((a, b) => a.y - b.y || a.x - b.x);
      let prevY = -Infinity;
      let prevSize = 12;
      const parts: string[] = [];
      for (const l of sorted) {
        if (prevY > -Infinity && l.y - prevY > Math.max(prevSize, l.size) * 1.8) parts.push("");
        parts.push(l.text);
        prevY = l.y;
        prevSize = l.size;
      }
      return parts.join("\n");
    })
    .join("\n\n\f");
}

export function linesToHtml(pages: { width: number; lines: TextLine[] }[], title: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const body = pages
    .map((p, i) => {
      const sizes = p.lines.map((l) => l.size).sort((a, b) => a - b);
      const median = sizes[Math.floor(sizes.length / 2)] ?? 12;
      const html = [...p.lines]
        .sort((a, b) => a.y - b.y || a.x - b.x)
        .map((l) => {
          const tag = l.size >= median * 1.6 ? "h1" : l.size >= median * 1.25 ? "h2" : "p";
          let t = esc(l.text);
          if (l.bold && tag === "p") t = `<strong>${t}</strong>`;
          if (l.italic) t = `<em>${t}</em>`;
          return `<${tag}>${t}</${tag}>`;
        })
        .join("\n");
      return `<section class="page" id="page-${i + 1}">\n${html}\n</section>`;
    })
    .join("\n<hr>\n");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>body{font-family:system-ui,sans-serif;max-width:800px;margin:2rem auto;padding:0 1rem;line-height:1.5}p{margin:.3em 0}hr{margin:2rem 0}</style></head><body>\n${body}\n</body></html>`;
}
