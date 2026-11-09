"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */
import { PDFDocument } from "@cantoo/pdf-lib";
import { zipSync } from "fflate";
import { exportPdf, type ExportOptions } from "./exporter";
import { PasswordRequiredError, getPage, getPageText, openPdf, type PDFDocumentProxy } from "./pdfjs";
import { checkpoint, mutate, navigateTo, resetEditor, toast, useEditor, withBusy } from "./store";
import type { DocMeta, DocState, EditObj, OutlineItem, PageModel, Rect, SourceDoc } from "./types";
import { baseName, dataUrlToBytes, downloadBlob, moveObj, normRot, normalizeImage, readFileAsDataUrl, readFileBytes, resizeObj, uid } from "./util";

const get = () => useEditor.getState();
const set = useEditor.setState;

/* ------------------------------------------------------------------ */
/* loading                                                            */

async function askPassword(fileName: string, incorrect: boolean): Promise<string | null> {
  return new Promise((resolve) => set({ dialog: { kind: "password", fileName, incorrect, resolve } }));
}

/** Open bytes as a source document, prompting for a password when needed. */
export async function addSourceFromBytes(bytes: Uint8Array, name: string, password?: string): Promise<SourceDoc | null> {
  let pw = password;
  let pdf: PDFDocumentProxy | null = null;
  for (;;) {
    try {
      pdf = await openPdf(bytes, pw);
      break;
    } catch (e) {
      if (e instanceof PasswordRequiredError) {
        const answer = await askPassword(name, e.incorrect && pw !== undefined);
        set({ dialog: null });
        if (answer === null) return null;
        pw = answer;
        continue;
      }
      throw e;
    }
  }
  let hasForm = false;
  try {
    const fields = await pdf.getFieldObjects();
    hasForm = !!fields && Object.keys(fields).length > 0;
  } catch {
    /* ignore */
  }
  const src: SourceDoc = {
    id: uid("s"),
    name,
    bytes,
    password: pw,
    numPages: pdf.numPages,
    pdf,
    hasForm,
    encrypted: pw !== undefined,
  };
  set({ sources: { ...get().sources, [src.id]: src } });
  return src;
}

export async function pagesFromSource(src: SourceDoc): Promise<PageModel[]> {
  const out: PageModel[] = [];
  for (let i = 0; i < src.numPages; i++) {
    const page = await getPage(src.pdf, i);
    const [x1, y1, x2, y2] = page.view;
    out.push({
      id: uid("p"),
      sourceId: src.id,
      sourceIndex: i,
      baseRotation: normRot(page.rotate),
      rotation: 0,
      width: Math.abs(x2 - x1),
      height: Math.abs(y2 - y1),
      objects: [],
      hiddenAnnots: [],
    });
  }
  return out;
}

async function outlineFromSource(src: SourceDoc, pages: PageModel[]): Promise<OutlineItem[]> {
  const raw = await src.pdf.getOutline().catch(() => null);
  if (!raw) return [];
  const byIndex = new Map(pages.map((p) => [p.sourceIndex, p]));
  const convert = async (items: any[]): Promise<OutlineItem[]> => {
    const res: OutlineItem[] = [];
    for (const it of items) {
      let pageId: string | null = null;
      let top: number | null = null;
      try {
        let dest = it.dest;
        if (typeof dest === "string") dest = await src.pdf.getDestination(dest);
        if (Array.isArray(dest) && dest.length) {
          const ref = dest[0];
          const idx = typeof ref === "number" ? ref : await src.pdf.getPageIndex(ref);
          const p = byIndex.get(idx);
          if (p) {
            pageId = p.id;
            if (dest[1]?.name === "XYZ" && typeof dest[3] === "number") {
              const pg = await getPage(src.pdf, idx);
              top = Math.max(0, pg.view[3] - dest[3]);
            }
          }
        }
      } catch {
        /* unresolvable destination */
      }
      res.push({ id: uid("b"), title: it.title || "", pageId, top, children: await convert(it.items || []), open: (it.count ?? 0) > 0 });
    }
    return res;
  };
  return convert(raw);
}

async function metaFromSource(src: SourceDoc): Promise<DocMeta> {
  const m: any = await src.pdf.getMetadata().catch(() => ({ info: {} }));
  const info = m?.info ?? {};
  return {
    title: info.Title ?? "",
    author: info.Author ?? "",
    subject: info.Subject ?? "",
    keywords: info.Keywords ?? "",
    creator: info.Creator ?? "",
    producer: info.Producer ?? "",
  };
}

function isPdf(file: File) {
  return file.type === "application/pdf" || /\.pdf$/i.test(file.name);
}
function isImage(file: File) {
  return file.type.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(file.name);
}

/** Load files (PDFs and images) into sources and page models. */
async function loadFiles(files: File[]): Promise<{ sources: SourceDoc[]; pages: PageModel[] }> {
  const sources: SourceDoc[] = [];
  const pages: PageModel[] = [];
  const images = files.filter((f) => !isPdf(f) && isImage(f));
  for (const f of files) {
    if (isPdf(f)) {
      const src = await addSourceFromBytes(await readFileBytes(f), f.name);
      if (!src) continue;
      sources.push(src);
      pages.push(...(await pagesFromSource(src)));
    } else if (isImage(f) && f === images[0]) {
      // all images of a drop become one source, in order
      const bytes = await imagesToPdf(images, { pageSize: "image", margin: 0 });
      const src = await addSourceFromBytes(bytes, images.length === 1 ? images[0].name : "Images");
      if (!src) continue;
      sources.push(src);
      pages.push(...(await pagesFromSource(src)));
    }
  }
  return { sources, pages };
}

export async function openFiles(files: File[]) {
  if (!files.length) return;
  const supported = files.filter((f) => isPdf(f) || isImage(f));
  if (!supported.length) {
    toast("Unsupported file type. Open a PDF or an image.", "error");
    return;
  }
  await withBusy("Opening…", async () => {
    // release the previous document's pdf.js workers
    for (const s of Object.values(get().sources)) s.pdf?.loadingTask?.destroy?.().catch?.(() => {});
    resetEditor({});
    const { sources, pages } = await loadFiles(supported);
    if (!pages.length) return;
    const first = sources[0];
    const outline = sources.length === 1 ? await outlineFromSource(first, pages) : [];
    const doc: DocState = {
      pages,
      forms: {},
      outline,
      outlineEdited: sources.length > 1,
      meta: await metaFromSource(first),
      decor: { watermark: null, headerFooter: null },
    };
    const name = sources.length === 1 ? first.name.replace(/\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i, ".pdf") : "Combined.pdf";
    const all: Record<string, SourceDoc> = {};
    for (const s of sources) all[s.id] = s;
    set({ sources: all, doc, savedDoc: sources.length === 1 && isPdf(supported[0]) ? doc : null, fileName: name, currentPage: 0, group: "view", tool: "select" });
    if (first.hasForm) toast("This document has fillable form fields.", "info");
  });
}

/** Insert files (PDF/images) as pages at `at` (default: end). */
export async function insertFiles(files: File[], at?: number) {
  if (!get().doc) return openFiles(files);
  await withBusy("Inserting pages…", async () => {
    const { pages } = await loadFiles(files);
    if (!pages.length) return;
    mutate((d) => {
      const idx = at === undefined ? d.pages.length : at;
      const next = [...d.pages];
      next.splice(idx, 0, ...pages);
      return { ...d, pages: next, outlineEdited: true };
    });
    toast(`Inserted ${pages.length} page${pages.length > 1 ? "s" : ""}`, "success");
  });
}

export async function newBlankDocument(size: [number, number] = [612, 792], count = 1) {
  resetEditor({});
  const pages: PageModel[] = Array.from({ length: count }, () => blankPage(size));
  const doc: DocState = {
    pages,
    forms: {},
    outline: [],
    outlineEdited: false,
    meta: { title: "", author: get().author, subject: "", keywords: "", creator: "", producer: "" },
    decor: { watermark: null, headerFooter: null },
  };
  set({ doc, fileName: "Untitled.pdf", savedDoc: null, group: "edit", tool: "text" });
}

export function blankPage([w, h]: [number, number]): PageModel {
  return { id: uid("p"), sourceId: null, sourceIndex: 0, baseRotation: 0, rotation: 0, width: w, height: h, objects: [], hiddenAnnots: [] };
}

export async function imagesToPdf(files: File[], opts: { pageSize: "image" | "A4" | "Letter"; margin: number }): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (const f of files) {
    const { src, w, h } = await normalizeImage(await readFileAsDataUrl(f));
    const { bytes, mime } = dataUrlToBytes(src);
    const img = /jpe?g/.test(mime) ? await doc.embedJpg(bytes) : await doc.embedPng(bytes);
    const pxToPt = 72 / 96;
    let pw = w * pxToPt;
    let ph = h * pxToPt;
    if (opts.pageSize !== "image") {
      const [sw, sh] = opts.pageSize === "A4" ? [595.28, 841.89] : [612, 792];
      const landscape = w > h;
      pw = landscape ? sh : sw;
      ph = landscape ? sw : sh;
    }
    const page = doc.addPage([pw, ph]);
    const m = opts.pageSize === "image" ? 0 : opts.margin;
    const s = Math.min((pw - m * 2) / img.width, (ph - m * 2) / img.height);
    const iw = img.width * s;
    const ih = img.height * s;
    page.drawImage(img, { x: (pw - iw) / 2, y: (ph - ih) / 2, width: iw, height: ih });
  }
  return doc.save();
}

export function closeDocument() {
  for (const s of Object.values(get().sources)) {
    try {
      s.pdf?.loadingTask?.destroy?.();
    } catch {
      /* ignore */
    }
  }
  resetEditor({});
}

/* ------------------------------------------------------------------ */
/* page operations                                                    */

export function rotatePages(ids: string[], delta: number) {
  if (!ids.length) return;
  mutate((d) => ({ ...d, pages: d.pages.map((p) => (ids.includes(p.id) ? { ...p, rotation: normRot(p.rotation + delta) } : p)) }));
}

export function deletePages(ids: string[]) {
  const d = get().doc;
  if (!d || !ids.length) return;
  if (ids.length >= d.pages.length) {
    toast("A document needs at least one page.", "error");
    return;
  }
  mutate((doc) => ({ ...doc, pages: doc.pages.filter((p) => !ids.includes(p.id)) }));
  set({ organizerSel: [], selection: null });
  toast(`Deleted ${ids.length} page${ids.length > 1 ? "s" : ""}`);
}

export function duplicatePages(ids: string[]) {
  mutate((d) => {
    const pages: PageModel[] = [];
    for (const p of d.pages) {
      pages.push(p);
      if (ids.includes(p.id)) pages.push({ ...p, id: uid("p"), objects: p.objects.map((o) => ({ ...o, id: uid() }) as EditObj) });
    }
    return { ...d, pages };
  });
}

export function insertBlankPage(at: number, size?: [number, number]) {
  mutate((d) => {
    const ref = d.pages[Math.min(at, d.pages.length - 1)] ?? d.pages[0];
    const s: [number, number] = size ?? (ref ? [ref.width, ref.height] : [612, 792]);
    const pages = [...d.pages];
    pages.splice(at, 0, blankPage(s));
    return { ...d, pages };
  });
}

/** Move pages (keeping their relative order) so they start at `to` (index in the list without them). */
export function movePages(ids: string[], to: number) {
  mutate((d) => {
    const moving = d.pages.filter((p) => ids.includes(p.id));
    const rest = d.pages.filter((p) => !ids.includes(p.id));
    const idx = Math.max(0, Math.min(to, rest.length));
    return { ...d, pages: [...rest.slice(0, idx), ...moving, ...rest.slice(idx)] };
  });
}

export function reversePages() {
  mutate((d) => ({ ...d, pages: [...d.pages].reverse() }));
}

/* ------------------------------------------------------------------ */
/* export / save                                                      */

let fontkitPromise: Promise<unknown> | null = null;
function loadFontkit() {
  if (!fontkitPromise) fontkitPromise = import("@cantoo/fontkit").then((m: any) => m.default ?? m);
  return fontkitPromise;
}
let unicodeFontPromise: Promise<Uint8Array | null> | null = null;
function loadUnicodeFont() {
  if (!unicodeFontPromise)
    unicodeFontPromise = fetch("/pdf-fonts/DejaVuSans.ttf")
      .then((r) => (r.ok ? r.arrayBuffer() : null))
      .then((b) => (b ? new Uint8Array(b) : null))
      .catch(() => null);
  return unicodeFontPromise;
}

async function decodeJpeg(bytes: Uint8Array) {
  const bmp = await createImageBitmap(new Blob([bytes as BlobPart], { type: "image/jpeg" }));
  const c = document.createElement("canvas");
  c.width = bmp.width;
  c.height = bmp.height;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(bmp, 0, 0);
  const data = ctx.getImageData(0, 0, c.width, c.height).data;
  return { width: c.width, height: c.height, data };
}

/** Render a page (unrotated) with redaction boxes burned in – fallback for unusual content. */
async function rasterizeForRedaction(page: PageModel, rects: Rect[]) {
  const s = get().sources[page.sourceId ?? ""];
  const scale = 200 / 72;
  const c = document.createElement("canvas");
  c.width = Math.round(page.width * scale);
  c.height = Math.round(page.height * scale);
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, c.width, c.height);
  if (s) {
    const pg = await getPage(s.pdf, page.sourceIndex);
    const vp = pg.getViewport({ scale, rotation: 0 });
    await pg.render({ canvas: c, canvasContext: ctx, viewport: vp, annotationMode: 0 } as any).promise;
  }
  ctx.fillStyle = "#000";
  for (const r of rects) ctx.fillRect(r.x * scale, r.y * scale, r.w * scale, r.h * scale);
  const blob: Blob = await new Promise((res) => c.toBlob((b) => res(b!), "image/jpeg", 0.9));
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: "image/jpeg" as const };
}

export async function buildPdf(opts: ExportOptions = {}): Promise<Uint8Array> {
  const s = get();
  if (!s.doc) throw new Error("No document");
  const [fontkit] = await Promise.all([loadFontkit().catch(() => null)]);
  return exportPdf(s.doc, s.sources, {
    fileName: s.fileName,
    unicodeFont: loadUnicodeFont,
    fontkit,
    rasterize: rasterizeForRedaction,
    codec: { decodeJpeg },
    onProgress: (msg) => set({ busy: msg }),
    ...opts,
  });
}

export async function saveDocument(opts: ExportOptions & { fileName?: string } = {}) {
  const doc = get().doc;
  const bytes = await withBusy("Saving…", () => buildPdf(opts));
  if (!bytes) return null;
  const name = opts.fileName ?? get().fileName ?? "document.pdf";
  downloadBlob(bytes, name.endsWith(".pdf") ? name : `${name}.pdf`);
  if (!opts.pageIds) set({ savedDoc: doc });
  toast(`Saved ${name}`, "success");
  return bytes;
}

/**
 * Bake page-level changes into a fresh source document while keeping every
 * editor object editable (used by Apply redactions, Crop, Page size, OCR…).
 * `transform` can post-process the baked PDF (e.g. add an OCR text layer).
 */
export async function rebase(
  opts: Pick<ExportOptions, "crops" | "resize" | "applyRedactions"> & { label: string; transform?: (bytes: Uint8Array) => Promise<Uint8Array> },
) {
  const s = get();
  if (!s.doc) return;
  return withBusy(opts.label, async () => {
    let bytes = await exportPdf(s.doc!, s.sources, {
      mode: "rebase",
      applyRedactions: opts.applyRedactions ?? false,
      crops: opts.crops,
      resize: opts.resize,
      rasterize: rasterizeForRedaction,
      codec: { decodeJpeg },
      onProgress: (msg) => set({ busy: msg }),
    });
    if (opts.transform) bytes = await opts.transform(bytes);
    const src = await addSourceFromBytes(bytes, s.fileName);
    if (!src) return;
    const fresh = await pagesFromSource(src);
    checkpoint();
    const cur = get().doc!;
    const pages = cur.pages.map((p, i) => {
      const np = fresh[i];
      const crop = opts.crops?.[p.id];
      const resize = opts.resize?.[p.id];
      let objects = opts.applyRedactions ? p.objects.filter((o) => o.type !== "redact") : p.objects;
      if (crop) objects = objects.map((o) => moveObj(o, -crop.x, -crop.y));
      if (resize) {
        const sc = Math.min(resize.w / p.width, resize.h / p.height);
        const ox = (resize.w - p.width * sc) / 2;
        const oy = (resize.h - p.height * sc) / 2;
        objects = objects.map((o) => resizeObj(o, { x: o.x * sc + ox, y: o.y * sc + oy, w: o.w * sc, h: o.h * sc }));
      }
      return { ...p, sourceId: src.id, sourceIndex: i, baseRotation: np.baseRotation, rotation: 0 as const, width: np.width, height: np.height, hiddenAnnots: [], objects };
    });
    useEditor.setState({ doc: { ...cur, pages, forms: {} } });
    // stale search results point at old geometry
    set({ search: { ...get().search, hits: [], active: -1 } });
    return true;
  });
}

export async function runOcr(pageIds: string[], dpi: number, skipTextPages: boolean) {
  const d = get().doc;
  if (!d) return;
  const indices = pageIds.map((id) => d.pages.findIndex((p) => p.id === id)).filter((i) => i >= 0);
  let summary = "";
  const ok = await rebase({
    label: "Running OCR…",
    transform: async (bytes) => {
      const { ocrPdf } = await import("./tools/ocr");
      const { bytes: out, report } = await ocrPdf(bytes, { pages: indices, dpi, lang: "eng", skipTextPages, onProgress: (m) => set({ busy: m }) });
      summary = `Recognized ${report.words} words on ${report.pagesProcessed} page${report.pagesProcessed === 1 ? "" : "s"}${report.pagesSkipped ? ` (${report.pagesSkipped} already had text)` : ""}.`;
      return out;
    },
  });
  if (ok) toast(summary + " The document is now searchable.", "success", 6000);
}

export async function exportAs(kind: "png" | "jpeg" | "txt" | "html" | "docx", opts: { pageIds?: string[]; dpi?: number; quality?: number } = {}) {
  const s = get();
  if (!s.doc) return;
  const base = baseName(s.fileName || "document");
  await withBusy("Converting…", async () => {
    const bytes = await buildPdf({ flattenAnnotations: true, pageIds: opts.pageIds });
    const progress = (m: string) => set({ busy: m });
    if (kind === "png" || kind === "jpeg") {
      const { pdfToImages } = await import("./tools/formats");
      const count = opts.pageIds?.length ?? s.doc!.pages.length;
      const r = await pdfToImages(bytes, base, { format: kind, dpi: opts.dpi ?? 150, quality: opts.quality ?? 0.9, pages: Array.from({ length: count }, (_, i) => i), onProgress: progress });
      downloadBlob(r.data, r.name, r.mime);
      return;
    }
    const { extractLines, linesToText, linesToHtml } = await import("./tools/formats");
    const pages = await extractLines(bytes, progress);
    if (kind === "txt") downloadBlob(new TextEncoder().encode(linesToText(pages)), `${base}.txt`, "text/plain");
    else if (kind === "html") downloadBlob(new TextEncoder().encode(linesToHtml(pages, s.doc!.meta.title || base)), `${base}.html`, "text/html");
    else {
      const { buildDocx } = await import("./tools/docx");
      const data = buildDocx(
        pages.map((p) => ({ width: p.width, height: p.height, lines: p.lines.map((l) => ({ text: l.text, x: l.x, y: l.y, width: l.width, size: l.size, bold: l.bold, italic: l.italic, font: l.font })) })),
        { title: s.doc!.meta.title, author: s.doc!.meta.author },
      );
      downloadBlob(data, `${base}.docx`, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    }
    toast("Export complete", "success");
  });
}

export async function applyRedactions() {
  const d = get().doc;
  if (!d) return;
  const count = d.pages.reduce((n, p) => n + p.objects.filter((o) => o.type === "redact").length, 0);
  if (!count) {
    toast("Mark areas or text for redaction first.", "info");
    return;
  }
  await rebase({ applyRedactions: true, label: "Applying redactions…" });
  toast(`Applied ${count} redaction${count > 1 ? "s" : ""}. The content is permanently removed when you save.`, "success", 6000);
}

/* ------------------------------------------------------------------ */
/* split / extract                                                    */

export async function extractPages(ids: string[], asSeparate = false) {
  const s = get();
  if (!s.doc || !ids.length) return;
  await withBusy("Extracting pages…", async () => {
    const base = baseName(s.fileName || "document");
    const ordered = s.doc!.pages.filter((p) => ids.includes(p.id));
    if (!asSeparate) {
      const bytes = await buildPdf({ pageIds: ordered.map((p) => p.id) });
      downloadBlob(bytes, `${base}-extract.pdf`);
      return;
    }
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i < ordered.length; i++) {
      set({ busy: `Extracting page ${i + 1} of ${ordered.length}…` });
      files[`${base}-page-${s.doc!.pages.indexOf(ordered[i]) + 1}.pdf`] = await buildPdf({ pageIds: [ordered[i].id] });
    }
    downloadBlob(zipSync(files, { level: 0 }), `${base}-pages.zip`, "application/zip");
  });
}

export async function splitDocument(mode: { kind: "every"; n: number } | { kind: "ranges"; ranges: number[][] } | { kind: "bookmarks" }) {
  const s = get();
  if (!s.doc) return;
  const pages = s.doc.pages;
  let groups: number[][] = [];
  if (mode.kind === "every") {
    for (let i = 0; i < pages.length; i += mode.n) groups.push(Array.from({ length: Math.min(mode.n, pages.length - i) }, (_, k) => i + k));
  } else if (mode.kind === "ranges") {
    groups = mode.ranges.filter((g) => g.length);
  } else {
    const starts = (s.doc.outline ?? [])
      .map((o) => pages.findIndex((p) => p.id === o.pageId))
      .filter((i) => i >= 0)
      .sort((a, b) => a - b);
    const uniq = Array.from(new Set([0, ...starts]));
    groups = uniq.map((st, i) => Array.from({ length: (uniq[i + 1] ?? pages.length) - st }, (_, k) => st + k));
  }
  if (groups.length < 2 && mode.kind !== "ranges") {
    toast("Nothing to split.", "info");
    return;
  }
  await withBusy("Splitting…", async () => {
    const base = baseName(s.fileName || "document");
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i < groups.length; i++) {
      set({ busy: `Creating part ${i + 1} of ${groups.length}…` });
      files[`${base}-part${i + 1}.pdf`] = await buildPdf({ pageIds: groups[i].map((k) => pages[k].id) });
    }
    downloadBlob(zipSync(files, { level: 0 }), `${base}-split.zip`, "application/zip");
    toast(`Split into ${groups.length} files`, "success");
  });
}

/* ------------------------------------------------------------------ */
/* print                                                              */

export async function printDocument() {
  await withBusy("Preparing to print…", async () => {
    const bytes = await buildPdf({ flattenAnnotations: true });
    const pdf = await openPdf(bytes);
    const imgs: string[] = [];
    for (let i = 0; i < pdf.numPages; i++) {
      set({ busy: `Rendering page ${i + 1} of ${pdf.numPages} for print…` });
      const page = await pdf.getPage(i + 1);
      const vp = page.getViewport({ scale: 150 / 72 });
      const c = document.createElement("canvas");
      c.width = Math.round(vp.width);
      c.height = Math.round(vp.height);
      const ctx = c.getContext("2d")!;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvas: c, canvasContext: ctx, viewport: vp, annotationMode: 3 } as any).promise;
      imgs.push(await new Promise<string>((res) => c.toBlob((b) => res(URL.createObjectURL(b!)), "image/jpeg", 0.92)));
    }
    await pdf.loadingTask.destroy();
    const iframe = document.createElement("iframe");
    iframe.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0";
    document.body.appendChild(iframe);
    const idoc = iframe.contentDocument!;
    idoc.open();
    idoc.write(
      `<!doctype html><html><head><title>${get().fileName}</title><style>@page{margin:0}html,body{margin:0}img{display:block;width:100%;height:auto;page-break-after:always;break-after:page}img:last-child{page-break-after:auto}</style></head><body>${imgs.map((u) => `<img src="${u}">`).join("")}</body></html>`,
    );
    idoc.close();
    await Promise.all(Array.from(idoc.images).map((im) => (im.complete ? Promise.resolve() : new Promise((r) => (im.onload = im.onerror = r)))));
    iframe.contentWindow!.focus();
    iframe.contentWindow!.print();
    setTimeout(() => {
      iframe.remove();
      imgs.forEach((u) => URL.revokeObjectURL(u));
    }, 60_000);
  });
}

/* ------------------------------------------------------------------ */
/* search                                                             */

export interface TextRun {
  str: string;
  /** page-space box */
  x: number;
  y: number;
  w: number;
  h: number;
  size: number;
  fontName: string;
  /** baseline (page space) */
  baseline: number;
  horizontal: boolean;
  /** CSS font family pdf.js reports for the run (used to measure characters). */
  family: string;
}

/** Text items of a page converted to page-space boxes. */
export async function pageRuns(page: PageModel): Promise<{ runs: TextRun[]; text: string; offsets: number[] } | null> {
  const s = get().sources[page.sourceId ?? ""];
  if (!s) return null;
  const pg = await getPage(s.pdf, page.sourceIndex);
  const t = await getPageText(s.pdf, page.sourceIndex);
  const [vx, , , vy2] = pg.view;
  const runs: TextRun[] = t.items.map((it) => {
    const [a, b, c, dd, e, f] = it.transform;
    const size = Math.hypot(c, dd) || Math.hypot(a, b) || 10;
    const st = t.styles[it.fontName];
    const asc = st?.ascent && st.ascent > 0.3 ? st.ascent : 0.8;
    const desc = st?.descent && st.descent < 0 ? -st.descent : 0.2;
    const horizontal = Math.abs(b) < 1e-3 && Math.abs(c) < 1e-3 && a > 0;
    const baseline = vy2 - f;
    const family = st?.fontFamily || "sans-serif";
    if (horizontal) {
      return { str: it.str, x: e - vx, y: baseline - asc * size, w: it.width, h: (asc + desc) * size, size, fontName: it.fontName, baseline, horizontal, family };
    }
    // rotated text: approximate with an axis-aligned box
    const ang = Math.atan2(b, a);
    const x2 = e + Math.cos(ang) * it.width;
    const y2 = f + Math.sin(ang) * it.width;
    const xs = [e, x2, e - Math.sin(ang) * size, x2 - Math.sin(ang) * size];
    const ys = [f, y2, f + Math.cos(ang) * size, y2 + Math.cos(ang) * size];
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    return { str: it.str, x: minX - vx, y: vy2 - maxY, w: maxX - minX, h: maxY - minY, size, fontName: it.fontName, baseline, horizontal, family };
  });
  return { runs, text: t.text, offsets: t.offsets };
}

let measureCtx: CanvasRenderingContext2D | null = null;
const prefixCache = new Map<string, number[]>();

/** Cumulative character positions of `str` as fractions of its width (proportional-font aware). */
function prefixFractions(str: string, family: string): number[] {
  const key = family + "\u0000" + str;
  const hit = prefixCache.get(key);
  if (hit) return hit;
  if (!measureCtx && typeof document !== "undefined") measureCtx = document.createElement("canvas").getContext("2d");
  const n = str.length;
  let out: number[];
  if (!measureCtx) out = Array.from({ length: n + 1 }, (_, i) => i / Math.max(1, n));
  else {
    measureCtx.font = `100px ${family}`;
    const total = measureCtx.measureText(str).width || 1;
    out = [0];
    for (let i = 1; i <= n; i++) out.push(Math.min(1, measureCtx.measureText(str.slice(0, i)).width / total));
  }
  if (prefixCache.size > 4000) prefixCache.clear();
  prefixCache.set(key, out);
  return out;
}

/** Rects covering characters [start, end) of the page text. */
export function rangeRects(runs: TextRun[], offsets: number[], start: number, end: number): Rect[] {
  const rects: Rect[] = [];
  runs.forEach((r, i) => {
    const s0 = offsets[i];
    const s1 = s0 + r.str.length;
    const a = Math.max(start, s0);
    const b = Math.min(end, s1);
    if (a >= b || !r.str.length) return;
    if (r.horizontal) {
      const fr = prefixFractions(r.str, r.family);
      const fx = fr[a - s0];
      const fw = fr[b - s0] - fx;
      rects.push({ x: r.x + r.w * fx, y: r.y, w: r.w * fw, h: r.h });
    } else rects.push({ x: r.x, y: r.y, w: r.w, h: r.h });
  });
  return rects;
}

let searchSeq = 0;
export async function runSearch(query: string, options?: { caseSensitive?: boolean; wholeWord?: boolean }) {
  const s = get();
  const seq = ++searchSeq;
  const caseSensitive = options?.caseSensitive ?? s.search.caseSensitive;
  const wholeWord = options?.wholeWord ?? s.search.wholeWord;
  set({ search: { ...s.search, query, caseSensitive, wholeWord, hits: [], active: -1, running: !!query } });
  if (!query || !s.doc) return;
  const esc = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  const re = new RegExp(wholeWord ? `\\b${esc}\\b` : esc, caseSensitive ? "g" : "gi");
  const hits: import("./store").SearchHit[] = [];
  for (const page of s.doc.pages) {
    if (seq !== searchSeq) return;
    const r = await pageRuns(page).catch(() => null);
    if (!r) continue;
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(r.text)) && hits.length < 5000) {
      const rects = rangeRects(r.runs, r.offsets, m.index, m.index + m[0].length);
      if (!rects.length) continue;
      const ctxStart = Math.max(0, m.index - 30);
      hits.push({ pageId: page.id, rects, context: r.text.slice(ctxStart, m.index + m[0].length + 40).replace(/\s+/g, " "), index: m.index - ctxStart });
      if (m[0].length === 0) re.lastIndex++;
    }
    if (hits.length && get().search.active === -1) {
      set({ search: { ...get().search, hits: [...hits], active: 0 } });
      goToHit(0);
    }
  }
  if (seq !== searchSeq) return;
  set({ search: { ...get().search, hits, active: hits.length ? Math.max(0, get().search.active) : -1, running: false } });
}

export function goToHit(i: number) {
  const s = get();
  const hits = s.search.hits;
  if (!hits.length || !s.doc) return;
  const idx = ((i % hits.length) + hits.length) % hits.length;
  const h = hits[idx];
  set({ search: { ...s.search, active: idx } });
  const pi = s.doc.pages.findIndex((p) => p.id === h.pageId);
  if (pi >= 0) navigateTo(pi, Math.max(0, h.rects[0].y - 80));
}

/* ------------------------------------------------------------------ */
/* misc                                                               */

export function setMeta(meta: Partial<DocMeta>) {
  mutate((d) => ({ ...d, meta: { ...d.meta, ...meta } }));
}

export function selectedPageIds(): string[] {
  const s = get();
  if (s.organizerSel.length) return s.organizerSel;
  const p = s.doc?.pages[s.currentPage];
  return p ? [p.id] : [];
}

export function allObjects(d: DocState) {
  return d.pages.flatMap((p, i) => p.objects.map((o) => ({ page: p, index: i, obj: o })));
}
