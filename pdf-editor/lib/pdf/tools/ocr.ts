"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Scan & OCR: recognise text on page images with Tesseract (self-hosted under
 * /public/tesseract) and add it as an invisible, selectable/searchable text
 * layer (text render mode 3) — the same approach Acrobat uses.
 */
import {
  PDFDocument,
  StandardFonts,
  beginText,
  endText,
  popGraphicsState,
  pushGraphicsState,
  setCharacterSqueeze,
  setFontAndSize,
  setTextMatrix,
  setTextRenderingMode,
  showText,
  TextRenderingMode,
  type PDFOperator,
} from "@cantoo/pdf-lib";
import { openPdf } from "../pdfjs";
import { visibleBox } from "../exporter";
import { pageSink, safeEncode } from "../draw";

export interface OcrOptions {
  /** 0-based page indices of the PDF to process. */
  pages: number[];
  dpi: number;
  lang: string;
  /** Skip pages that already contain extractable text. */
  skipTextPages: boolean;
  onProgress?: (msg: string) => void;
}

export interface OcrReport {
  pagesProcessed: number;
  pagesSkipped: number;
  words: number;
}

async function makeWorker(lang: string, onProgress?: (m: string) => void) {
  const { createWorker } = (await import("tesseract.js")) as any;
  return createWorker(lang, 1, {
    workerPath: "/tesseract/worker.min.js",
    corePath: "/tesseract/core",
    langPath: "/tesseract/lang",
    gzip: true,
    logger: (m: any) => {
      if (m?.status === "recognizing text" && onProgress) onProgress(`Recognizing text… ${Math.round((m.progress ?? 0) * 100)}%`);
    },
  });
}

/** Returns new PDF bytes with invisible OCR text added to the selected pages. */
export async function ocrPdf(bytes: Uint8Array, opts: OcrOptions): Promise<{ bytes: Uint8Array; report: OcrReport }> {
  const progress = opts.onProgress ?? (() => {});
  const pdf = await openPdf(bytes);
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  progress("Loading OCR engine…");
  const worker = await makeWorker(opts.lang, progress);
  const report: OcrReport = { pagesProcessed: 0, pagesSkipped: 0, words: 0 };
  try {
    for (let n = 0; n < opts.pages.length; n++) {
      const index = opts.pages[n];
      const page = await pdf.getPage(index + 1);
      if (opts.skipTextPages) {
        const tc: any = await page.getTextContent();
        const chars = tc.items.reduce((k: number, it: any) => k + (it.str?.trim().length ?? 0), 0);
        if (chars > 20) {
          report.pagesSkipped++;
          continue;
        }
      }
      progress(`Rendering page ${index + 1} (${n + 1} of ${opts.pages.length})…`);
      const k = opts.dpi / 72;
      const vp = page.getViewport({ scale: k, rotation: 0 });
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(vp.width);
      canvas.height = Math.round(vp.height);
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, canvasContext: ctx, viewport: vp, annotationMode: 0 } as any).promise;
      progress(`Recognizing text on page ${index + 1}…`);
      const { data } = await worker.recognize(canvas, {}, { blocks: true, text: false });
      const target = doc.getPages()[index];
      const box = visibleBox(target);
      const ops: PDFOperator[] = [];
      const sink = pageSink(target, doc);
      const fkey = sink.font(font);
      ops.push(pushGraphicsState(), beginText(), setTextRenderingMode(TextRenderingMode.Invisible));
      for (const block of data.blocks ?? []) {
        for (const para of block.paragraphs ?? []) {
          for (const line of para.lines ?? []) {
            const lineH = (line.bbox.y1 - line.bbox.y0) / k;
            const size = Math.max(3, lineH * 0.82);
            const bl = line.baseline;
            for (const w of line.words ?? []) {
              const text = (w.text ?? "").trim();
              if (!text || w.confidence < 15) continue;
              const x0 = w.bbox.x0 / k;
              const x1 = w.bbox.x1 / k;
              const cx = (w.bbox.x0 + w.bbox.x1) / 2;
              let baseY = w.bbox.y1 / k - size * 0.18;
              if (bl && bl.x1 !== bl.x0) baseY = (bl.y0 + ((bl.y1 - bl.y0) * (cx - bl.x0)) / (bl.x1 - bl.x0)) / k;
              // add a trailing space so copied text keeps word boundaries
              const shown = text + " ";
              const natural = font.widthOfTextAtSize(shown, size);
              const target = (x1 - x0) * (shown.length / Math.max(1, text.length));
              const squeeze = Math.max(10, Math.min(400, (100 * target) / Math.max(0.01, natural)));
              ops.push(
                setFontAndSize(fkey, size),
                setCharacterSqueeze(squeeze),
                setTextMatrix(1, 0, 0, 1, box.x + x0, box.y + box.height - baseY),
                showText(safeEncode(font, shown)),
              );
              report.words++;
            }
          }
        }
      }
      ops.push(endText(), popGraphicsState());
      target.node.normalize();
      const start = doc.context.register(doc.context.contentStream([pushGraphicsState()]));
      const end = doc.context.register(doc.context.contentStream([popGraphicsState()]));
      target.node.wrapContentStreams(start, end);
      target.pushOperators(...ops);
      report.pagesProcessed++;
      page.cleanup();
    }
  } finally {
    await worker.terminate();
    await pdf.loadingTask.destroy();
  }
  progress("Saving…");
  return { bytes: await doc.save({ useObjectStreams: true }), report };
}
