/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * pdf.js is served as static ESM from /public/pdfjs (copied by scripts/copy-pdfjs.mjs)
 * and loaded at runtime, which keeps it out of the webpack bundle entirely.
 */
import type * as PdfJsLib from "pdfjs-dist";

export type PdfJs = typeof PdfJsLib;
export type PDFDocumentProxy = PdfJsLib.PDFDocumentProxy;
export type PDFPageProxy = PdfJsLib.PDFPageProxy;

const BASE = "/pdfjs/";
let libPromise: Promise<PdfJs> | null = null;

export function loadPdfJs(): Promise<PdfJs> {
  if (!libPromise) {
    const url = BASE + "pdf.min.mjs";
    libPromise = (import(/* webpackIgnore: true */ url) as Promise<PdfJs>).then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = BASE + "pdf.worker.min.mjs";
      return lib;
    });
    libPromise.catch(() => {
      libPromise = null;
    });
  }
  return libPromise;
}

export const DOC_PARAMS = {
  cMapUrl: BASE + "cmaps/",
  cMapPacked: true,
  standardFontDataUrl: BASE + "standard_fonts/",
  wasmUrl: BASE + "wasm/",
  iccUrl: BASE + "iccs/",
};

export class PasswordRequiredError extends Error {
  constructor(public incorrect: boolean) {
    super(incorrect ? "Incorrect password" : "Password required");
  }
}

/** Open a PDF with pdf.js. Throws PasswordRequiredError when a password is needed. */
export async function openPdf(bytes: Uint8Array, password?: string): Promise<PDFDocumentProxy> {
  const lib = await loadPdfJs();
  const task = lib.getDocument({
    // pdf.js transfers (detaches) the buffer it is given, so hand it a copy.
    data: bytes.slice(),
    password,
    ...DOC_PARAMS,
  } as any);
  try {
    return await task.promise;
  } catch (e: any) {
    if (e?.name === "PasswordException") {
      throw new PasswordRequiredError(e.code === lib.PasswordResponses.INCORRECT_PASSWORD);
    }
    throw e;
  }
}

/* ---------------- page caches ---------------- */

type TextItem = {
  str: string;
  transform: number[];
  width: number;
  height: number;
  fontName: string;
  hasEOL: boolean;
  dir: string;
};

export interface PageText {
  items: TextItem[];
  styles: Record<string, { fontFamily: string; ascent: number; descent: number; vertical: boolean }>;
  /** Concatenated text with one entry per item in `offsets`. */
  text: string;
  offsets: number[];
  /** The untouched pdf.js TextContent (for TextLayer). */
  raw: any;
}

const textCache = new WeakMap<object, Map<number, Promise<PageText>>>();
const annotCache = new WeakMap<object, Map<number, Promise<any[]>>>();
const pageCache = new WeakMap<object, Map<number, Promise<PDFPageProxy>>>();

export function getPage(pdf: PDFDocumentProxy, index: number): Promise<PDFPageProxy> {
  let m = pageCache.get(pdf);
  if (!m) pageCache.set(pdf, (m = new Map()));
  let p = m.get(index);
  if (!p) {
    p = pdf.getPage(index + 1);
    m.set(index, p);
  }
  return p;
}

export function getPageText(pdf: PDFDocumentProxy, index: number): Promise<PageText> {
  let m = textCache.get(pdf);
  if (!m) textCache.set(pdf, (m = new Map()));
  let p = m.get(index);
  if (!p) {
    p = getPage(pdf, index).then(async (page) => {
      const tc: any = await page.getTextContent();
      const items: TextItem[] = tc.items.filter((it: any) => typeof it.str === "string");
      let text = "";
      const offsets: number[] = [];
      for (const it of items) {
        offsets.push(text.length);
        text += it.str;
        if (it.hasEOL) text += "\n";
      }
      return { items, styles: tc.styles, text, offsets, raw: tc };
    });
    m.set(index, p);
  }
  return p;
}

export function getPageAnnotations(pdf: PDFDocumentProxy, index: number): Promise<any[]> {
  let m = annotCache.get(pdf);
  if (!m) annotCache.set(pdf, (m = new Map()));
  let p = m.get(index);
  if (!p) {
    p = getPage(pdf, index).then((page) => page.getAnnotations({ intent: "display" }));
    m.set(index, p);
  }
  return p;
}
