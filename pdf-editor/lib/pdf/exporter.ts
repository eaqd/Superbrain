/**
 * Builds the output PDF from the editor model with pdf-lib.
 *
 *  1. Assemble pages (reorder / delete / duplicate / insert from other files / blank)
 *     re-using the first source document as the base so its AcroForm, bookmarks,
 *     metadata, attachments and structure survive.
 *  2. Apply true redactions and text edits (content-stream rewriting).
 *  3. Draw content objects; write comment objects as real PDF annotations.
 *  4. Fill / create form fields, links, watermark, header & footer, bookmarks, metadata.
 *  5. Drop everything unreachable (deleted pages, replaced streams) and save / encrypt.
 */
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFOperator,
  PDFPage,
  PDFRef,
  PDFStream,
  PDFString,
  PDFCheckBox,
  PDFDropdown,
  PDFOptionList,
  PDFRadioGroup,
  PDFTextField,
  PDFForm,
  PDFObjectCopier,
  PDFPageTree,
  StandardFonts,
  concatTransformationMatrix,
  degrees,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  setGraphicsState,
  drawObject,
  type SecurityOptions,
} from "@cantoo/pdf-lib";
import type { DocState, EditObj, FieldObj, HeaderFooter, OutlineItem, PageModel, Rect, SourceDoc, Watermark } from "./types";
import { Resources, drawBoxObject, drawInkOps, drawLineOps, drawMarkupOps, drawShapeOps, formSink, isBoxObject, pageSink, safeEncode, type Sink } from "./draw";
import { localSize, objectMatrix, rectToPdf, toPdf, uprightMatrix, type Matrix, type PageBox } from "./geometry";
import { hexToRgb01, normRot, parsePageRanges, dataUrlToBytes } from "./util";
import { textWidth } from "./textLayout";

export interface RasterResult {
  /** JPEG or PNG bytes of the page rendered upright-unrotated (page space). */
  bytes: Uint8Array;
  mime: "image/jpeg" | "image/png";
}

export interface ExportOptions {
  /** Draw comments into the page instead of writing annotations. */
  flattenAnnotations?: boolean;
  /** Flatten form fields into static content. */
  flattenForms?: boolean;
  /** Apply redaction marks (permanent). Default true. */
  applyRedactions?: boolean;
  /** Export only these pages (in document order). */
  pageIds?: string[];
  encrypt?: SecurityOptions | null;
  objectStreams?: boolean;
  /** Remove document info / XMP metadata. */
  stripMetadata?: boolean;
  /** Remove hidden information: metadata, JavaScript, embedded files, actions, XFA. */
  sanitize?: boolean;
  /**
   * "rebase": produce a PDF whose pages map 1:1 to the model pages with only
   * page-level changes baked in (order, rotation, crop, redactions, form values,
   * deleted annotations). Editor objects are NOT drawn – they stay editable.
   */
  mode?: "full" | "rebase";
  /** Rebase only: new crop rect per page id (page space). */
  crops?: Record<string, Rect>;
  /** Rebase only: new page size per page id (pt), content centred. */
  resize?: Record<string, { w: number; h: number }>;
  fileName?: string;
  unicodeFont?: () => Promise<Uint8Array | null>;
  /** fontkit instance (needed to embed the Unicode fallback font). */
  fontkit?: unknown;
  /** Browser fallback for redaction when content-stream rewriting fails. */
  rasterize?: (page: PageModel, redactRects: Rect[]) => Promise<RasterResult>;
  /** Extra codec hooks for the redaction engine (JPEG decode). */
  codec?: { decodeJpeg?(bytes: Uint8Array): Promise<{ width: number; height: number; data: Uint8ClampedArray }> };
  onProgress?: (msg: string) => void;
}

/* ------------------------------------------------------------------ */

function pdfjsIdToRef(id: string): { num: number; gen: number } | null {
  const m = /^(\d+)R(\d*)$/.exec(id);
  return m ? { num: +m[1], gen: m[2] ? +m[2] : 0 } : null;
}

function pdfDate(d = new Date()) {
  return PDFString.fromDate(d);
}

function text(s: string) {
  return PDFHexString.fromText(s);
}

/** Visible box (crop ∩ media) in PDF space – matches pdf.js `page.view`. */
export function visibleBox(page: PDFPage): PageBox {
  const mb = page.getMediaBox();
  let cb = mb;
  try {
    cb = page.getCropBox();
  } catch {
    /* ignore */
  }
  const x1 = Math.max(Math.min(mb.x, mb.x + mb.width), Math.min(cb.x, cb.x + cb.width));
  const y1 = Math.max(Math.min(mb.y, mb.y + mb.height), Math.min(cb.y, cb.y + cb.height));
  const x2 = Math.min(Math.max(mb.x, mb.x + mb.width), Math.max(cb.x, cb.x + cb.width));
  const y2 = Math.min(Math.max(mb.y, mb.y + mb.height), Math.max(cb.y, cb.y + cb.height));
  if (x2 - x1 < 1 || y2 - y1 < 1) return { x: mb.x, y: mb.y, width: Math.abs(mb.width), height: Math.abs(mb.height) };
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

const INHERITABLE = ["Resources", "MediaBox", "CropBox", "Rotate"];

function rebuildPageTree(out: PDFDocument, pages: PDFPage[]) {
  const ctx = out.context;
  const tree = PDFPageTree.withContext(ctx);
  const treeRef = ctx.register(tree);
  for (const p of pages) {
    p.node.set(PDFName.of("Parent"), treeRef);
    tree.pushLeafNode(p.ref);
  }
  out.catalog.set(PDFName.of("Pages"), treeRef);
  // pdf-lib caches the page list; force it to re-read the new tree.
  (out as unknown as { pageCache: { invalidate(): void } }).pageCache.invalidate();
}

function pushDownInherited(page: PDFPage) {
  const node = page.node;
  for (const k of INHERITABLE) {
    const name = PDFName.of(k);
    if (!node.get(name)) {
      const v = node.getInheritableAttribute(name);
      if (v) node.set(name, v);
    }
  }
}

function annotsOf(page: PDFPage): PDFArray | undefined {
  const a = page.node.lookup(PDFName.of("Annots"));
  return a instanceof PDFArray ? a : undefined;
}

/** Give a page its own (direct) /Annots array so edits never leak into another page. */
function ownAnnots(doc: PDFDocument, page: PDFPage): PDFArray {
  const current = annotsOf(page);
  const arr = doc.context.obj([]) as PDFArray;
  if (current) for (let i = 0; i < current.size(); i++) arr.push(current.get(i));
  page.node.set(PDFName.of("Annots"), arr);
  return arr;
}

/**
 * Strip page back-references from every annotation so pdf-lib's copier doesn't
 * drag the donor's whole page tree along, and turn explicit link destinations
 * into page *indices* we can re-point after assembly.
 */
function prepareDonor(doc: PDFDocument) {
  const pages = doc.getPages();
  const refIndex = new Map<string, number>();
  pages.forEach((p, i) => refIndex.set(p.ref.toString(), i));
  const fixDest = (holder: PDFDict, key: string) => {
    const name = PDFName.of(key);
    let d = holder.get(name);
    if (d instanceof PDFRef) d = doc.context.lookup(d);
    if (d instanceof PDFArray && d.size() > 0) {
      const first = d.get(0);
      if (first instanceof PDFRef) {
        const idx = refIndex.get(first.toString());
        const copy = doc.context.obj([]) as PDFArray;
        for (let i = 0; i < d.size(); i++) copy.push(d.get(i));
        copy.set(0, PDFNumber.of(idx === undefined ? -1 : idx));
        // marker so we know to remap after copying
        holder.set(name, copy);
        holder.set(PDFName.of("EdDestIdx"), PDFNumber.of(idx === undefined ? -1 : idx));
      }
    }
  };
  for (const p of pages) {
    const annots = annotsOf(p);
    if (!annots) continue;
    for (let i = 0; i < annots.size(); i++) {
      const a = annots.lookup(i);
      if (!(a instanceof PDFDict)) continue;
      a.delete(PDFName.of("P"));
      if (a.get(PDFName.of("Subtype"))?.toString() === "/Link") {
        fixDest(a, "Dest");
        const act = a.lookup(PDFName.of("A"));
        if (act instanceof PDFDict && act.get(PDFName.of("S"))?.toString() === "/GoTo") fixDest(act, "D");
      }
    }
  }
  // Widgets reference their field (/Parent) whose /Kids reach widgets on other pages –
  // those widgets have no /P any more, so nothing else is pulled in.
}

/* ------------------------------------------------------------------ */

export async function exportPdf(doc: DocState, sources: Record<string, SourceDoc>, opts: ExportOptions = {}): Promise<Uint8Array> {
  const progress = opts.onProgress ?? (() => {});
  const rebase = opts.mode === "rebase";
  const outPages = opts.pageIds ? doc.pages.filter((p) => opts.pageIds!.includes(p.id)) : doc.pages;
  if (!outPages.length) throw new Error("No pages to export");

  const loadSource = async (id: string) => {
    const s = sources[id];
    if (!s) throw new Error("Missing source document");
    return PDFDocument.load(s.bytes, {
      password: s.password ?? "",
      updateMetadata: false,
      throwOnInvalidObject: false,
    } as never);
  };

  progress("Assembling pages…");
  const baseId = outPages.find((p) => p.sourceId)?.sourceId ?? null;
  const out = baseId ? await loadSource(baseId) : await PDFDocument.create({ updateMetadata: false });
  if (opts.fontkit) out.registerFontkit(opts.fontkit as never);
  const basePages = baseId ? out.getPages() : [];
  basePages.forEach(pushDownInherited);
  const baseRefIdx = new Map<string, number>();
  basePages.forEach((p, i) => baseRefIdx.set(p.ref.toString(), i));

  // ---- plan where each output page comes from ----
  type Plan = { kind: "base"; idx: number } | { kind: "copy"; key: string; slot: number } | { kind: "blank" };
  const plan: Plan[] = [];
  const usedBase = new Set<number>();
  const copyReq = new Map<string, number[]>();
  for (const p of outPages) {
    if (!p.sourceId) plan.push({ kind: "blank" });
    else if (p.sourceId === baseId && !usedBase.has(p.sourceIndex)) {
      usedBase.add(p.sourceIndex);
      plan.push({ kind: "base", idx: p.sourceIndex });
    } else {
      const key = p.sourceId === baseId ? `dup:${baseId}` : p.sourceId;
      const list = copyReq.get(key) ?? [];
      list.push(p.sourceIndex);
      copyReq.set(key, list);
      plan.push({ kind: "copy", key, slot: list.length - 1 });
    }
  }

  // Hidden (deleted) annotations: map ids → positions in the donor page's /Annots.
  const hiddenPositions = (srcDoc: PDFDocument, pageIndex: number, ids: string[]): number[] => {
    if (!ids.length) return [];
    const page = srcDoc.getPages()[pageIndex];
    const annots = page && annotsOf(page);
    if (!annots) return [];
    const wanted = new Set(ids.map(pdfjsIdToRef).filter(Boolean).map((r) => `${r!.num} ${r!.gen} R`));
    const pos: number[] = [];
    for (let i = 0; i < annots.size(); i++) {
      const item = annots.get(i);
      if (item instanceof PDFRef && wanted.has(item.toString())) pos.push(i);
    }
    return pos;
  };

  const copied = new Map<string, PDFPage[]>();
  const donorDocs = new Map<string, PDFDocument>();
  const pendingHidden = new Map<PDFPage, number[]>();
  for (const [key, indices] of copyReq) {
    const srcId = key.startsWith("dup:") ? key.slice(4) : key;
    const donor = await loadSource(srcId);
    donorDocs.set(key, donor);
    // compute hidden positions BEFORE stripping anything (positions don't change)
    prepareDonor(donor);
    const pages = await out.copyPages(donor, indices);
    copied.set(key, pages);
  }

  // Build the output page list, then replace the page tree wholesale (a flat tree).
  const finalPages: PDFPage[] = [];
  outPages.forEach((p, i) => {
    const pl = plan[i];
    let page: PDFPage;
    if (pl.kind === "base") {
      page = basePages[pl.idx];
    } else if (pl.kind === "copy") {
      page = copied.get(pl.key)![pl.slot];
      const donor = donorDocs.get(pl.key)!;
      const pos = hiddenPositions(donor, p.sourceIndex, p.hiddenAnnots);
      if (pos.length) pendingHidden.set(page, pos);
    } else {
      page = PDFPage.create(out);
      page.setSize(p.width, p.height);
    }
    finalPages.push(page);
  });
  rebuildPageTree(out, finalPages);

  // Page ref lookups for link remapping / outlines.
  const outRefByModelId = new Map<string, PDFRef>();
  outPages.forEach((p, i) => outRefByModelId.set(p.id, finalPages[i].ref));
  const firstOutBySource = new Map<string, PDFRef>();
  outPages.forEach((p, i) => {
    const k = `${p.sourceId}:${p.sourceIndex}`;
    if (p.sourceId && !firstOutBySource.has(k)) firstOutBySource.set(k, finalPages[i].ref);
  });

  // ---- per-page structural fixes ----
  for (let i = 0; i < outPages.length; i++) {
    const p = outPages[i];
    const page = finalPages[i];
    const pl = plan[i];
    const annots = ownAnnots(out, page);
    // remove deleted annotations
    if (pl.kind === "base" && p.hiddenAnnots.length) {
      const wanted = new Set(p.hiddenAnnots.map(pdfjsIdToRef).filter(Boolean).map((r) => `${r!.num} ${r!.gen} R`));
      for (let k = annots.size() - 1; k >= 0; k--) {
        const it = annots.get(k);
        if (it instanceof PDFRef && wanted.has(it.toString())) annots.remove(k);
      }
    } else if (pendingHidden.has(page)) {
      const pos = pendingHidden.get(page)!.sort((a, b) => b - a);
      for (const k of pos) if (k < annots.size()) annots.remove(k);
    }
    // re-point annotation /P and link destinations
    for (let k = annots.size() - 1; k >= 0; k--) {
      const a = annots.lookup(k);
      if (!(a instanceof PDFDict)) continue;
      a.set(PDFName.of("P"), page.ref);
      const sub = a.get(PDFName.of("Subtype"))?.toString();
      if (sub !== "/Link") continue;
      const remap = (holder: PDFDict, key: string): boolean => {
        const name = PDFName.of(key);
        const marker = holder.get(PDFName.of("EdDestIdx"));
        let d = holder.get(name);
        if (d instanceof PDFRef) d = out.context.lookup(d);
        if (!(d instanceof PDFArray) || d.size() === 0) return true;
        const first = d.get(0);
        if (marker instanceof PDFNumber || first instanceof PDFNumber) {
          holder.delete(PDFName.of("EdDestIdx"));
          const idx = (first as PDFNumber).asNumber?.() ?? -1;
          const target = p.sourceId ? firstOutBySource.get(`${p.sourceId}:${idx}`) : undefined;
          if (!target) return false;
          d.set(0, target);
          return true;
        }
        if (first instanceof PDFRef && pl.kind === "base") {
          const idx = baseRefIdx.get(first.toString());
          if (idx !== undefined && !usedBase.has(idx)) return false; // target page was deleted
          if (idx !== undefined && opts.pageIds) {
            const target = firstOutBySource.get(`${baseId}:${idx}`);
            if (!target) return false;
          }
        }
        return true;
      };
      let ok = remap(a, "Dest");
      const act = a.lookup(PDFName.of("A"));
      if (act instanceof PDFDict && act.get(PDFName.of("S"))?.toString() === "/GoTo") ok = remap(act, "D") && ok;
      if (!ok) annots.remove(k);
    }
    page.setRotation(degrees(normRot(p.baseRotation + p.rotation)));
  }

  // ---- forms: merge foreign widgets, set values, clean orphans ----
  progress("Updating form fields…");
  const form = out.getForm();
  const renames = mergeForeignFields(out, finalPages, plan, donorDocs);
  applyFormValues(form, doc, outPages, renames);

  // Wrap the original content in q…Q once per page before we append anything,
  // so a stream that leaves the graphics state modified can't skew our drawing.
  const wrapped = new Set<PDFPage>();
  const wrap = (page: PDFPage) => {
    if (wrapped.has(page)) return;
    wrapped.add(page);
    page.node.normalize();
    const start = out.context.register(out.context.contentStream([pushGraphicsState()]));
    const end = out.context.register(out.context.contentStream([popGraphicsState()]));
    page.node.wrapContentStreams(start, end);
  };

  // ---- redactions & text edits (content-stream rewriting) ----
  const box = finalPages.map(visibleBox);
  const applyRedactions = opts.applyRedactions !== false;
  let overlayFont: import("@cantoo/pdf-lib").PDFFont | undefined;
  for (let i = 0; i < outPages.length; i++) {
    const p = outPages[i];
    const page = finalPages[i];
    const redacts = applyRedactions ? p.objects.filter((o) => o.type === "redact") : [];
    const edits = rebase ? [] : p.objects.filter((o): o is Extract<EditObj, { type: "text" }> => o.type === "text" && !!o.replaces);
    if (!redacts.length && !edits.length) continue;
    progress(redacts.length ? `Redacting page ${i + 1}…` : `Editing text on page ${i + 1}…`);
    const engine = await loadEngine();
    if (edits.length) {
      const rects = edits.flatMap((e) => e.replaces!.rects).map((r) => rectToPdf(box[i], r));
      let ok = false;
      if (engine) {
        try {
          await engine.redactPage(out, page, rects, { removeText: true, images: "keep", removeVectors: false, removeAnnotations: false, fillColor: null });
          ok = true;
        } catch (e) {
          console.warn("text removal failed, covering instead", e);
        }
      }
      if (!ok) {
        // Fallback: paint the original background colour over the old text.
        wrap(page);
        for (const e of edits)
          for (const r of e.replaces!.rects) {
            const pr = rectToPdf(box[i], { x: r.x - 0.5, y: r.y - 0.5, w: r.w + 1, h: r.h + 1 });
            const [cr, cg, cb] = hexToRgb01(e.replaces!.color);
            page.drawRectangle({ x: pr.x, y: pr.y, width: pr.width, height: pr.height, color: rgb(cr, cg, cb) });
          }
      }
    }
    if (redacts.length) {
      const allRects: Rect[] = redacts.flatMap((r) => (r.type === "redact" ? (r.rects.length ? r.rects : [{ x: r.x, y: r.y, w: r.w, h: r.h }]) : []));
      const fills = redacts[0].type === "redact" ? redacts[0].fill : "#000000";
      let ok = false;
      if (engine) {
        try {
          await engine.redactPage(out, page, allRects.map((r) => rectToPdf(box[i], r)), {
            fillColor: hexToRgb01(fills),
            images: "pixels",
            removeText: true,
            removeVectors: true,
            removeAnnotations: true,
            codec: opts.codec,
          });
          ok = true;
        } catch (e) {
          console.warn("content redaction failed; rasterizing page", e);
        }
      }
      if (!ok) {
        if (!opts.rasterize) throw new Error(`Could not redact page ${i + 1}`);
        const raster = await opts.rasterize(p, allRects);
        await replaceWithRaster(out, page, box[i], raster, allRects);
      }
      // overlay text on redaction boxes
      for (const r of redacts) {
        if (r.type !== "redact" || !r.overlayText) continue;
        wrap(page);
        overlayFont ??= await out.embedFont(StandardFonts.Helvetica);
        const font = overlayFont;
        const rr = rectToPdf(box[i], r.rects[0] ?? r);
        const size = Math.max(4, Math.min(rr.height * 0.7, 14));
        const [cr, cg, cb] = hexToRgb01(r.fill);
        const lum = 0.299 * cr + 0.587 * cg + 0.114 * cb;
        page.drawText(r.overlayText, { x: rr.x + 2, y: rr.y + (rr.height - size * 0.7) / 2, size, font, color: lum > 0.5 ? rgb(0, 0, 0) : rgb(1, 1, 1), maxWidth: rr.width - 4 });
      }
    }
  }

  // ---- crops / resize (rebase only) ----
  if (rebase && (opts.crops || opts.resize)) {
    for (let i = 0; i < outPages.length; i++) {
      const p = outPages[i];
      const page = finalPages[i];
      const c = opts.crops?.[p.id];
      if (c) {
        const r = rectToPdf(box[i], c);
        page.setCropBox(r.x, r.y, r.width, r.height);
        page.setTrimBox?.(r.x, r.y, r.width, r.height);
      }
      const rs = opts.resize?.[p.id];
      if (rs) {
        const b = box[i];
        const s = Math.min(rs.w / b.width, rs.h / b.height);
        const ox = (rs.w - b.width * s) / 2;
        const oy = (rs.h - b.height * s) / 2;
        page.node.normalize();
        const start = out.context.register(out.context.contentStream([pushGraphicsState(), concatTransformationMatrix(s, 0, 0, s, ox - b.x * s, oy - b.y * s)]));
        const end = out.context.register(out.context.contentStream([popGraphicsState()]));
        page.node.wrapContentStreams(start, end);
        page.setMediaBox(0, 0, rs.w, rs.h);
        page.node.delete(PDFName.of("CropBox"));
        page.node.delete(PDFName.of("TrimBox"));
        page.node.delete(PDFName.of("BleedBox"));
        page.node.delete(PDFName.of("ArtBox"));
        const annots = annotsOf(page);
        if (annots)
          for (let k = 0; k < annots.size(); k++) {
            const a = annots.lookup(k);
            if (!(a instanceof PDFDict)) continue;
            const rect = a.lookup(PDFName.of("Rect"));
            if (rect instanceof PDFArray && rect.size() === 4) {
              const v = [0, 1, 2, 3].map((j) => (rect.lookup(j) as PDFNumber).asNumber());
              a.set(PDFName.of("Rect"), out.context.obj([v[0] * s + ox - b.x * s, v[1] * s + oy - b.y * s, v[2] * s + ox - b.x * s, v[3] * s + oy - b.y * s]));
            }
          }
      }
    }
  }

  // ---- objects ----
  if (!rebase) {
    const res = new Resources(out, opts.unicodeFont ?? (async () => null));
    const pageIndexById = new Map(outPages.map((p, i) => [p.id, i]));
    for (let i = 0; i < outPages.length; i++) {
      const p = outPages[i];
      const page = finalPages[i];
      if (!p.objects.length) continue;
      progress(`Writing page ${i + 1} of ${outPages.length}…`);
      const b = box[i];
      const sink = pageSink(page, out);
      for (const o of p.objects) {
        if (o.type === "redact") {
          if (!applyRedactions) addAnnotation(out, page, b, o, await annotAppearance(out, res, b, o));
          continue;
        }
        if (o.type === "field") continue;
        if (o.type === "link") {
          addLink(out, page, b, o, o.pageId ? outRefByModelId.get(o.pageId) : undefined, o.pageId ? outPages[pageIndexById.get(o.pageId) ?? -1] : undefined);
          continue;
        }
        const asAnnot = o.layer === "annot" && !opts.flattenAnnotations;
        if (asAnnot) {
          addAnnotation(out, page, b, o, await annotAppearance(out, res, b, o));
          continue;
        }
        wrap(page);
        sink.ops = [];
        await drawContentObject(sink, res, b, o);
        page.pushOperators(...sink.ops);
      }
    }
    // ---- created form fields ----
    progress("Creating form fields…");
    const helv = await out.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < outPages.length; i++) {
      for (const o of outPages[i].objects) if (o.type === "field") createField(out, form, finalPages[i], box[i], o, helv);
    }
    // ---- decorations ----
    if (doc.decor.watermark || doc.decor.headerFooter) {
      progress("Adding watermark / header & footer…");
      const total = outPages.length;
      for (let i = 0; i < outPages.length; i++) {
        const p = outPages[i];
        const page = finalPages[i];
        const rot = normRot(p.baseRotation + p.rotation);
        if (doc.decor.watermark) await drawWatermark(out, res, page, box[i], rot, doc.decor.watermark, i, total, wrap);
        if (doc.decor.headerFooter) {
          wrap(page);
          await drawHeaderFooter(out, res, page, box[i], rot, doc.decor.headerFooter, i, total, { fileName: opts.fileName ?? "", title: doc.meta.title });
        }
      }
    }
  }

  // ---- bookmarks ----
  const baseDeleted = basePages.some((_, i) => !usedBase.has(i));
  if (doc.outline && (doc.outlineEdited || baseDeleted || !!opts.pageIds)) {
    writeOutline(out, doc.outline, outRefByModelId, outPages, box);
  } else if (!baseId && doc.outline?.length) {
    writeOutline(out, doc.outline, outRefByModelId, outPages, box);
  }

  if (opts.sanitize) sanitizeDocument(out, finalPages);

  // ---- metadata ----
  if (opts.stripMetadata || opts.sanitize) {
    out.catalog.delete(PDFName.of("Metadata"));
    const infoRef = out.context.trailerInfo.Info;
    if (infoRef) out.context.trailerInfo.Info = out.context.register(out.context.obj({}));
    out.setProducer("");
    out.setCreator("");
  } else {
    const m = doc.meta;
    out.setTitle(m.title || "");
    out.setAuthor(m.author || "");
    out.setSubject(m.subject || "");
    out.setKeywords(m.keywords ? m.keywords.split(/[,;]\s*/).filter(Boolean) : []);
    if (m.creator) out.setCreator(m.creator);
    out.setProducer(m.producer || "Superbrain PDF Editor");
    out.setModificationDate(new Date());
  }

  if (opts.flattenForms) {
    try {
      form.flatten({ updateFieldAppearances: true });
    } catch (e) {
      console.warn("flatten failed", e);
    }
  }

  cleanupForm(out, finalPages);
  progress("Optimizing…");
  await out.flush();
  garbageCollect(out);

  if (opts.encrypt) out.encrypt(opts.encrypt);
  progress("Saving…");
  return out.save({ useObjectStreams: opts.objectStreams !== false, updateFieldAppearances: true });
}

/* ------------------------------------------------------------------ */
/* redaction engine (content stream rewriting) – loaded lazily        */

type Engine = {
  redactPage: (doc: PDFDocument, page: PDFPage, rects: { x: number; y: number; width: number; height: number }[], opts?: Record<string, unknown>) => Promise<unknown>;
};
let enginePromise: Promise<Engine | null> | null = null;
function loadEngine(): Promise<Engine | null> {
  if (!enginePromise)
    enginePromise = import("./engine/redact").then((m) => m as unknown as Engine).catch((e) => {
      console.warn("redaction engine unavailable", e);
      return null;
    });
  return enginePromise;
}

async function replaceWithRaster(out: PDFDocument, page: PDFPage, b: PageBox, raster: RasterResult, rects: Rect[]) {
  const img = raster.mime === "image/png" ? await out.embedPng(raster.bytes) : await out.embedJpg(raster.bytes);
  const xo = PDFName.of("RedactedPage");
  const resources = out.context.obj({ XObject: { RedactedPage: img.ref } });
  const stream = out.context.contentStream([pushGraphicsState(), concatTransformationMatrix(b.width, 0, 0, b.height, b.x, b.y), drawObject(xo), popGraphicsState()]);
  page.node.set(PDFName.of("Contents"), out.context.register(stream));
  page.node.set(PDFName.of("Resources"), resources);
  // drop annotations touching the redacted areas
  const annots = annotsOf(page);
  if (annots) {
    const pdfRects = rects.map((r) => rectToPdf(b, r));
    for (let k = annots.size() - 1; k >= 0; k--) {
      const a = annots.lookup(k);
      if (!(a instanceof PDFDict)) continue;
      const r = a.lookup(PDFName.of("Rect"));
      if (!(r instanceof PDFArray)) continue;
      const [x1, y1, x2, y2] = [0, 1, 2, 3].map((j) => (r.lookup(j) as PDFNumber).asNumber());
      if (pdfRects.some((q) => Math.min(x1, x2) < q.x + q.width && Math.max(x1, x2) > q.x && Math.min(y1, y2) < q.y + q.height && Math.max(y1, y2) > q.y)) annots.remove(k);
    }
  }
}

/* ------------------------------------------------------------------ */
/* content drawing                                                    */

export async function drawContentObject(sink: Sink, res: Resources, b: PageBox, o: EditObj) {
  const ops = sink.ops;
  ops.push(pushGraphicsState());
  if (o.opacity < 1) ops.push(setGraphicsState(sink.gs(o.opacity)));
  if (isBoxObject(o)) {
    const m = objectMatrix(b, o);
    const [lw, lh] = localSize(o);
    ops.push(concatTransformationMatrix(...m));
    await drawBoxObject(sink, res, o, lw, lh);
  } else if (o.type === "line" || o.type === "arrow") {
    drawLineOps(sink, o, toPdf(b, o.x1, o.y1), toPdf(b, o.x2, o.y2));
  } else if (o.type === "ink") {
    drawInkOps(
      sink,
      o.stroke,
      o.strokeWidth,
      o.paths.map((path) => {
        const pts: [number, number][] = [];
        for (let k = 0; k < path.length; k += 2) pts.push(toPdf(b, path[k], path[k + 1]));
        return pts;
      }),
    );
  } else if (o.type === "highlight" || o.type === "underline" || o.type === "strikeout" || o.type === "squiggly") {
    drawMarkupOps(sink, o.type, o.color, o.rects.map((r) => rectToPdf(b, r)));
  }
  ops.push(popGraphicsState());
}

/* ------------------------------------------------------------------ */
/* annotations                                                        */

interface Appearance {
  ref: PDFRef;
  rect: [number, number, number, number];
}

async function annotAppearance(out: PDFDocument, res: Resources, b: PageBox, o: EditObj): Promise<Appearance> {
  const sink = formSink(out);
  let bbox: [number, number, number, number];
  let matrix: Matrix = [1, 0, 0, 1, 0, 0];
  let rect: [number, number, number, number];
  if (isBoxObject(o)) {
    const [lw, lh] = localSize(o);
    const m = objectMatrix(b, o);
    matrix = [m[0], m[1], m[2], m[3], 0, 0];
    bbox = [0, 0, lw, lh];
    const r = rectToPdf(b, o);
    rect = [r.x, r.y, r.x + r.width, r.y + r.height];
    await drawBoxObject(sink, res, o, lw, lh);
  } else {
    // page-space objects: appearance drawn in page coordinates
    const r = rectToPdf(b, o.type === "highlight" || o.type === "underline" || o.type === "strikeout" || o.type === "squiggly" || o.type === "redact" ? unionOf(o) : o);
    rect = [r.x, r.y, r.x + r.width, r.y + r.height];
    bbox = rect;
    const fake: EditObj = { ...o, opacity: 1 };
    if (o.type === "redact") {
      for (const rr of o.rects.length ? o.rects : [o]) {
        const pr = rectToPdf(b, rr);
        sink.ops.push(pushGraphicsState(), concatTransformationMatrix(1, 0, 0, 1, pr.x, pr.y));
        drawShapeOps(sink, { type: "rect", stroke: "#d92d20", strokeWidth: 1, fill: null, dash: false }, pr.width, pr.height);
        sink.ops.push(popGraphicsState());
      }
    } else {
      sink.ops.push(pushGraphicsState());
      await drawContentObject(sink, res, b, fake);
      sink.ops.push(popGraphicsState());
    }
  }
  const stream = out.context.formXObject(sink.ops, {
    BBox: bbox,
    Matrix: matrix,
    Resources: sink.resources(),
  });
  return { ref: out.context.register(stream), rect };
}

function unionOf(o: { x: number; y: number; w: number; h: number; rects?: Rect[] }): Rect {
  const rs = o.rects && o.rects.length ? o.rects : [o];
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const r of rs) {
    x1 = Math.min(x1, r.x);
    y1 = Math.min(y1, r.y);
    x2 = Math.max(x2, r.x + r.w);
    y2 = Math.max(y2, r.y + r.h);
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

function colorArr(hex: string) {
  return hexToRgb01(hex);
}

function addAnnotation(out: PDFDocument, page: PDFPage, b: PageBox, o: EditObj, ap: Appearance) {
  const ctx = out.context;
  const common: Record<string, unknown> = {
    Type: "Annot",
    Rect: ap.rect,
    P: page.ref,
    F: 4,
    NM: text(o.id),
    M: pdfDate(new Date(o.modified)),
    CreationDate: pdfDate(new Date(o.created)),
    T: text(o.author || "Guest"),
    AP: { N: ap.ref },
  };
  if (o.opacity < 1) common.CA = o.opacity;
  if (o.comment) common.Contents = text(o.comment);
  let dict: Record<string, unknown>;
  const quad = (rects: Rect[]) =>
    rects.flatMap((r) => {
      const p = rectToPdf(b, r);
      return [p.x, p.y + p.height, p.x + p.width, p.y + p.height, p.x, p.y, p.x + p.width, p.y];
    });
  switch (o.type) {
    case "highlight":
    case "underline":
    case "strikeout":
    case "squiggly": {
      const sub = { highlight: "Highlight", underline: "Underline", strikeout: "StrikeOut", squiggly: "Squiggly" }[o.type];
      dict = { ...common, Subtype: sub, C: colorArr(o.color), QuadPoints: quad(o.rects), Contents: text(o.comment || o.text || "") };
      break;
    }
    case "note":
      dict = { ...common, Subtype: "Text", Name: "Comment", C: colorArr(o.color), Contents: text(o.text), Open: false };
      break;
    case "text":
      dict = {
        ...common,
        Subtype: "FreeText",
        Contents: text(o.text),
        DA: PDFString.of(`/Helv ${o.size} Tf ${colorArr(o.color).map((v) => v.toFixed(3)).join(" ")} rg`),
        Q: o.align === "center" ? 1 : o.align === "right" ? 2 : 0,
        ...(o.rotate ? { Rotate: (360 - o.rotate) % 360 } : {}),
        BS: { W: o.border ? o.borderWidth : 0 },
        ...(o.fill ? { C: colorArr(o.fill) } : {}),
      };
      break;
    case "rect":
    case "ellipse":
      dict = {
        ...common,
        Subtype: o.type === "rect" ? "Square" : "Circle",
        C: o.stroke ? colorArr(o.stroke) : [],
        ...(o.fill ? { IC: colorArr(o.fill) } : {}),
        BS: { W: o.stroke ? o.strokeWidth : 0, S: o.dash ? "D" : "S", ...(o.dash ? { D: [o.strokeWidth * 3, o.strokeWidth * 2] } : {}) },
      };
      break;
    case "line":
    case "arrow": {
      const [x1, y1] = toPdf(b, o.x1, o.y1);
      const [x2, y2] = toPdf(b, o.x2, o.y2);
      dict = {
        ...common,
        Subtype: "Line",
        L: [x1, y1, x2, y2],
        LE: ["None", o.type === "arrow" ? "OpenArrow" : "None"],
        C: colorArr(o.stroke),
        BS: { W: o.strokeWidth, S: o.dash ? "D" : "S" },
      };
      break;
    }
    case "ink":
      dict = {
        ...common,
        Subtype: "Ink",
        C: colorArr(o.stroke),
        BS: { W: o.strokeWidth },
        InkList: o.paths.map((path) => {
          const pts: number[] = [];
          for (let k = 0; k < path.length; k += 2) pts.push(...toPdf(b, path[k], path[k + 1]));
          return pts;
        }),
      };
      break;
    case "stamp":
      dict = { ...common, Subtype: "Stamp", Name: o.label.replace(/[^A-Za-z]/g, "") || "Draft", Contents: text(o.comment || o.label) };
      break;
    case "image":
      dict = { ...common, Subtype: "Stamp", Name: "Image" };
      break;
    case "mark":
      dict = { ...common, Subtype: "Stamp", Name: o.mark };
      break;
    case "redact":
      dict = {
        ...common,
        Subtype: "Redact",
        QuadPoints: quad(o.rects.length ? o.rects : [o]),
        IC: colorArr(o.fill),
        ...(o.overlayText ? { OverlayText: text(o.overlayText) } : {}),
      };
      break;
    default:
      return;
  }
  const ref = ctx.register(ctx.obj(dict as never));
  page.node.addAnnot(ref);
}

function addLink(out: PDFDocument, page: PDFPage, b: PageBox, o: Extract<EditObj, { type: "link" }>, target: PDFRef | undefined, targetPage: PageModel | undefined) {
  const r = rectToPdf(b, o);
  const dict: Record<string, unknown> = {
    Type: "Annot",
    Subtype: "Link",
    Rect: [r.x, r.y, r.x + r.width, r.y + r.height],
    Border: [0, 0, 0],
    F: 4,
    P: page.ref,
  };
  if (o.pageId) {
    if (!target || !targetPage) return;
    dict.Dest = out.context.obj([target, PDFName.of("Fit")]);
  } else if (o.url) {
    dict.A = { S: "URI", URI: PDFString.of(o.url) };
  } else return;
  page.node.addAnnot(out.context.register(out.context.obj(dict as never)));
}

/* ------------------------------------------------------------------ */
/* forms                                                              */

/** Register widgets of copied pages in the AcroForm. Returns renamed root fields per source. */
function mergeForeignFields(out: PDFDocument, pages: PDFPage[], plan: { kind: string; key?: string }[], donors: Map<string, PDFDocument>) {
  const renames = new Map<string, Map<string, string[]>>();
  const acro = ensureAcroForm(out);
  const fields = acro.lookup(PDFName.of("Fields"), PDFArray);
  const present = new Set<string>();
  const names = new Set<string>();
  for (let i = 0; i < fields.size(); i++) {
    present.add(fields.get(i).toString());
    const f = fields.lookup(i);
    const t = f instanceof PDFDict ? f.lookup(PDFName.of("T")) : undefined;
    if (t instanceof PDFString || t instanceof PDFHexString) names.add(t.decodeText());
  }
  pages.forEach((page, i) => {
    const pl = plan[i];
    if (pl.kind !== "copy") return;
    const donor = donors.get(pl.key!);
    const annots = annotsOf(page);
    if (!annots) return;
    for (let k = 0; k < annots.size(); k++) {
      let ref: PDFObject = annots.get(k);
      const first = annots.lookup(k);
      if (!(first instanceof PDFDict) || first.get(PDFName.of("Subtype"))?.toString() !== "/Widget") continue;
      let a: PDFDict = first;
      // walk up to the root field
      for (let guard = 0; guard < 20; guard++) {
        const parent: PDFObject | undefined = a.get(PDFName.of("Parent"));
        if (!(parent instanceof PDFRef)) break;
        const pd: PDFObject | undefined = out.context.lookup(parent);
        if (!(pd instanceof PDFDict)) break;
        ref = parent;
        a = pd;
      }
      if (ref instanceof PDFRef && !present.has(ref.toString())) {
        // Keep fully-qualified names unique: rename the copied root field if needed.
        const t = a.lookup(PDFName.of("T"));
        const name = t instanceof PDFString || t instanceof PDFHexString ? t.decodeText() : null;
        if (name !== null) {
          let unique = name;
          let n = 1;
          while (names.has(unique)) unique = `${name}_${++n}`;
          if (unique !== name) {
            a.set(PDFName.of("T"), text(unique));
            const srcId = pl.key!.startsWith("dup:") ? pl.key!.slice(4) : pl.key!;
            const m = renames.get(srcId) ?? new Map<string, string[]>();
            m.set(name, [...(m.get(name) ?? []), unique]);
            renames.set(srcId, m);
          }
          names.add(unique);
        }
        fields.push(ref);
        present.add(ref.toString());
      }
    }
    // bring over default resources (fonts used by /DA strings)
    if (donor) {
      const dAcro = donor.catalog.lookup(PDFName.of("AcroForm"));
      const dDR = dAcro instanceof PDFDict ? dAcro.lookup(PDFName.of("DR")) : undefined;
      if (dDR instanceof PDFDict) {
        const copier = PDFObjectCopier.for(donor.context, out.context);
        const dr = (acro.lookup(PDFName.of("DR")) as PDFDict | undefined) ?? (out.context.obj({}) as PDFDict);
        acro.set(PDFName.of("DR"), dr);
        const dFonts = dDR.lookup(PDFName.of("Font"));
        if (dFonts instanceof PDFDict) {
          let fonts = dr.lookup(PDFName.of("Font"));
          if (!(fonts instanceof PDFDict)) {
            fonts = out.context.obj({}) as PDFDict;
            dr.set(PDFName.of("Font"), fonts);
          }
          for (const [k, v] of dFonts.entries()) if (!(fonts as PDFDict).has(k)) (fonts as PDFDict).set(k, copier.copy(v));
        }
      }
    }
  });
  return renames;
}

function ensureAcroForm(out: PDFDocument): PDFDict {
  let acro = out.catalog.lookup(PDFName.of("AcroForm"));
  if (!(acro instanceof PDFDict)) {
    out.getForm(); // creates the AcroForm
    acro = out.catalog.lookup(PDFName.of("AcroForm"));
  }
  const d = acro as PDFDict;
  if (!(d.lookup(PDFName.of("Fields")) instanceof PDFArray)) d.set(PDFName.of("Fields"), out.context.obj([]));
  return d;
}

function applyFormValues(form: PDFForm, doc: DocState, outPages: PageModel[], renames: Map<string, Map<string, string[]>>) {
  const used = new Set(outPages.map((p) => p.sourceId).filter(Boolean) as string[]);
  for (const [srcId, values] of Object.entries(doc.forms)) {
    if (!used.has(srcId)) continue;
    const entries: [string, unknown][] = [];
    for (const [name, value] of Object.entries(values)) {
      entries.push([name, value]);
      for (const alias of renames.get(srcId)?.get(name) ?? []) entries.push([alias, value]);
    }
    for (const [name, value] of entries) {
      let field;
      try {
        field = form.getFieldMaybe(name);
      } catch {
        field = undefined;
      }
      if (!field) continue;
      try {
        if (field instanceof PDFTextField) {
          const v = String(value ?? "");
          try {
            field.setText(v);
          } catch {
            // maxLength violations etc.
            field.setMaxLength(undefined);
            field.setText(v);
          }
        } else if (field instanceof PDFCheckBox) {
          if (value === true || (typeof value === "string" && value !== "Off" && value !== "")) field.check();
          else field.uncheck();
        } else if (field instanceof PDFRadioGroup) {
          const v = String(value);
          if (!v || v === "Off") field.clear();
          else if (field.getOptions().includes(v)) field.select(v);
        } else if (field instanceof PDFDropdown) {
          const vals = Array.isArray(value) ? value : [String(value)];
          const opts = field.getOptions();
          if (vals.every((v) => opts.includes(v))) field.select(vals.length > 1 ? vals : vals[0]);
          else if (field.isEditable()) field.select(vals[0]);
        } else if (field instanceof PDFOptionList) {
          const vals = Array.isArray(value) ? value : [String(value)];
          field.select(vals.filter((v) => field.getOptions().includes(v)));
        }
      } catch (e) {
        console.warn("could not set field", name, e);
      }
    }
  }
}

function uniqueFieldName(form: PDFForm, base: string) {
  let name = base || "Field";
  let n = 1;
  while (form.getFieldMaybe(name)) name = `${base}_${++n}`;
  return name;
}

function createField(out: PDFDocument, form: PDFForm, page: PDFPage, b: PageBox, o: FieldObj, font: import("@cantoo/pdf-lib").PDFFont) {
  const r = rectToPdf(b, o);
  const common = {
    x: r.x,
    y: r.y,
    width: r.width,
    height: r.height,
    borderColor: rgb(0.45, 0.45, 0.5),
    borderWidth: 1,
    backgroundColor: rgb(1, 1, 1),
    textColor: rgb(0, 0, 0),
    font,
    rotate: degrees((360 - o.rotate) % 360),
  };
  try {
    switch (o.fieldType) {
      case "text": {
        const f = form.createTextField(uniqueFieldName(form, o.name));
        if (o.multiline) f.enableMultiline();
        if (o.value) f.setText(o.value);
        f.addToPage(page, common);
        f.setFontSize(o.fontSize || 0);
        if (o.required) f.enableRequired();
        if (o.readOnly) f.enableReadOnly();
        break;
      }
      case "checkbox": {
        const f = form.createCheckBox(uniqueFieldName(form, o.name));
        f.addToPage(page, common);
        if (o.checked) f.check();
        if (o.required) f.enableRequired();
        break;
      }
      case "radio": {
        let g: PDFRadioGroup | undefined;
        const existing = form.getFieldMaybe(o.name);
        if (existing instanceof PDFRadioGroup) g = existing;
        else g = form.createRadioGroup(existing ? uniqueFieldName(form, o.name) : o.name);
        g.addOptionToPage(o.exportValue || `Choice${g.getOptions().length + 1}`, page, common);
        if (o.checked) g.select(o.exportValue || g.getOptions()[g.getOptions().length - 1]);
        break;
      }
      case "dropdown": {
        const f = form.createDropdown(uniqueFieldName(form, o.name));
        f.addOptions(o.options.length ? o.options : ["Option 1"]);
        if (o.value && o.options.includes(o.value)) f.select(o.value);
        f.addToPage(page, common);
        break;
      }
      case "listbox": {
        const f = form.createOptionList(uniqueFieldName(form, o.name));
        f.addOptions(o.options.length ? o.options : ["Option 1"]);
        if (o.value && o.options.includes(o.value)) f.select(o.value);
        f.addToPage(page, common);
        break;
      }
      case "button": {
        const f = form.createButton(uniqueFieldName(form, o.name));
        f.addToPage(o.value || "Button", page, { ...common, backgroundColor: rgb(0.88, 0.9, 0.95) });
        break;
      }
      case "signature": {
        // Unsigned signature field (/FT /Sig) that any signing tool can fill.
        const acro = ensureAcroForm(out);
        const widget = out.context.obj({
          Type: "Annot",
          Subtype: "Widget",
          FT: "Sig",
          T: text(uniqueFieldName(form, o.name)),
          Rect: [r.x, r.y, r.x + r.width, r.y + r.height],
          F: 4,
          P: page.ref,
          MK: { BC: [0.45, 0.45, 0.5] },
          ...(o.tooltip ? { TU: text(o.tooltip) } : {}),
        });
        const ref = out.context.register(widget);
        page.node.addAnnot(ref);
        acro.lookup(PDFName.of("Fields"), PDFArray).push(ref);
        break;
      }
    }
  } catch (e) {
    console.warn("field creation failed", o.name, e);
  }
}

/** Remove fields whose widgets are no longer on any page. */
function cleanupForm(out: PDFDocument, pages: PDFPage[]) {
  const acro = out.catalog.lookup(PDFName.of("AcroForm"));
  if (!(acro instanceof PDFDict)) return;
  const fields = acro.lookup(PDFName.of("Fields"));
  if (!(fields instanceof PDFArray)) return;
  const onPage = new Set<string>();
  for (const p of pages) {
    const a = annotsOf(p);
    if (a) for (let i = 0; i < a.size(); i++) onPage.add(a.get(i).toString());
  }
  const keep = (ref: PDFObject, depth: number): boolean => {
    if (depth > 30 || !(ref instanceof PDFRef)) return true;
    const d = out.context.lookup(ref);
    if (!(d instanceof PDFDict)) return false;
    const kids = d.lookup(PDFName.of("Kids"));
    if (kids instanceof PDFArray && kids.size() > 0) {
      for (let i = kids.size() - 1; i >= 0; i--) if (!keep(kids.get(i), depth + 1)) kids.remove(i);
      return kids.size() > 0;
    }
    if (d.get(PDFName.of("Subtype"))?.toString() === "/Widget") return onPage.has(ref.toString());
    return true;
  };
  for (let i = fields.size() - 1; i >= 0; i--) if (!keep(fields.get(i), 0)) fields.remove(i);
  if (fields.size() === 0 && !acro.has(PDFName.of("XFA"))) out.catalog.delete(PDFName.of("AcroForm"));
}

/* ------------------------------------------------------------------ */
/* bookmarks                                                          */

function writeOutline(out: PDFDocument, items: OutlineItem[], refs: Map<string, PDFRef>, pages: PageModel[], boxes: PageBox[]) {
  const ctx = out.context;
  const indexById = new Map(pages.map((p, i) => [p.id, i]));
  if (!items.length) {
    out.catalog.delete(PDFName.of("Outlines"));
    return;
  }
  const rootRef = ctx.nextRef();
  const build = (list: OutlineItem[], parent: PDFRef): { first: PDFRef; last: PDFRef; count: number } => {
    const refsArr = list.map(() => ctx.nextRef());
    let total = 0;
    list.forEach((it, i) => {
      const dict: Record<string, unknown> = { Title: text(it.title || "Untitled"), Parent: parent };
      if (i > 0) dict.Prev = refsArr[i - 1];
      if (i < list.length - 1) dict.Next = refsArr[i + 1];
      const target = it.pageId ? refs.get(it.pageId) : undefined;
      if (target) {
        const pi = indexById.get(it.pageId!)!;
        const top = it.top !== null && pi !== undefined ? boxes[pi].y + boxes[pi].height - it.top : null;
        dict.Dest = top !== null ? [target, PDFName.of("XYZ"), null, top, null] : [target, PDFName.of("Fit")];
      }
      if (it.children.length) {
        const sub = build(it.children, refsArr[i]);
        dict.First = sub.first;
        dict.Last = sub.last;
        dict.Count = it.open ? sub.count : -sub.count;
        if (it.open) total += sub.count;
      }
      total += 1;
      ctx.assign(refsArr[i], ctx.obj(dict as never));
    });
    return { first: refsArr[0], last: refsArr[refsArr.length - 1], count: total };
  };
  const top = build(items, rootRef);
  ctx.assign(rootRef, ctx.obj({ Type: "Outlines", First: top.first, Last: top.last, Count: top.count }));
  out.catalog.set(PDFName.of("Outlines"), rootRef);
}

/* ------------------------------------------------------------------ */
/* watermark / header & footer                                        */

export function pageSelected(range: string, index: number, total: number) {
  if (!range.trim()) return true;
  return parsePageRanges(range, total).includes(index);
}

export function resolveTokens(tpl: string, ctx: { page: number; pages: number; bates: string; fileName: string; title: string }) {
  const date = new Date().toLocaleDateString();
  return tpl
    .replace(/\{page\}/g, String(ctx.page))
    .replace(/\{pages\}/g, String(ctx.pages))
    .replace(/\{date\}/g, date)
    .replace(/\{bates\}/g, ctx.bates)
    .replace(/\{file\}/g, ctx.fileName)
    .replace(/\{title\}/g, ctx.title);
}

export function batesNumber(hf: HeaderFooter, index: number) {
  return `${hf.batesPrefix}${String(hf.batesStart + index).padStart(hf.batesDigits, "0")}${hf.batesSuffix}`;
}

async function drawWatermark(out: PDFDocument, res: Resources, page: PDFPage, b: PageBox, rot: 0 | 90 | 180 | 270, wm: Watermark, index: number, total: number, wrap: (p: PDFPage) => void) {
  if (!pageSelected(wm.pages, index, total)) return;
  const { m, width, height } = uprightMatrix(b, rot);
  const sink = pageSink(page, out);
  const ops: PDFOperator[] = (sink.ops = []);
  ops.push(pushGraphicsState(), concatTransformationMatrix(...m), setGraphicsState(sink.gs(wm.opacity)));
  const cy = wm.position === "top" ? height * 0.82 : wm.position === "bottom" ? height * 0.18 : height / 2;
  const cx = width / 2;
  const a = (wm.rotation * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  if (wm.kind === "image" && wm.imageSrc) {
    const img = await res.image(wm.imageSrc);
    const w = width * wm.imageScale;
    const h = (w * img.height) / img.width;
    // centre, rotate, scale
    ops.push(concatTransformationMatrix(cos, sin, -sin, cos, cx, cy), concatTransformationMatrix(w, 0, 0, h, -w / 2, -h / 2), drawObject(sink.image(img)));
  } else {
    const font = await res.fontFor(wm.text, wm.font, wm.bold, false);
    const lines = wm.text.split("\n");
    const L = wm.size * 1.15;
    const [r, g, bl] = hexToRgb01(wm.color);
    const { beginText, endText, setFontAndSize, setFillingRgbColor, setTextMatrix, showText } = await import("@cantoo/pdf-lib");
    ops.push(concatTransformationMatrix(cos, sin, -sin, cos, cx, cy), beginText(), setFontAndSize(sink.font(font), wm.size), setFillingRgbColor(r, g, bl));
    lines.forEach((line, i) => {
      const w = font.widthOfTextAtSize(line, wm.size);
      const y = ((lines.length - 1) / 2 - i) * L - wm.size * 0.35;
      ops.push(setTextMatrix(1, 0, 0, 1, -w / 2, y), showText(safeEncode(font, line)));
    });
    ops.push(endText());
  }
  ops.push(popGraphicsState());
  if (wm.layer === "under") {
    page.node.normalize();
    const stream = out.context.register(out.context.contentStream(ops));
    const contents = page.node.Contents();
    if (contents instanceof PDFArray) contents.insert(0, stream);
    else page.node.set(PDFName.of("Contents"), out.context.obj(contents ? [stream, contents] : [stream]));
  } else {
    wrap(page);
    page.pushOperators(...ops);
  }
}

async function drawHeaderFooter(out: PDFDocument, res: Resources, page: PDFPage, b: PageBox, rot: 0 | 90 | 180 | 270, hf: HeaderFooter, index: number, total: number, info: { fileName: string; title: string }) {
  if (!pageSelected(hf.pages, index, total)) return;
  const { m, width, height } = uprightMatrix(b, rot);
  const ctx = { page: hf.startNumber + index, pages: total + hf.startNumber - 1, bates: batesNumber(hf, index), ...info };
  const sink = pageSink(page, out);
  const ops: PDFOperator[] = (sink.ops = []);
  const [r, g, bl] = hexToRgb01(hf.color);
  const { beginText, endText, setFontAndSize, setFillingRgbColor, setTextMatrix, showText } = await import("@cantoo/pdf-lib");
  ops.push(pushGraphicsState(), concatTransformationMatrix(...m), beginText(), setFillingRgbColor(r, g, bl));
  const slots: [keyof HeaderFooter, "l" | "c" | "r", "h" | "f"][] = [
    ["hl", "l", "h"],
    ["hc", "c", "h"],
    ["hr", "r", "h"],
    ["fl", "l", "f"],
    ["fc", "c", "f"],
    ["fr", "r", "f"],
  ];
  for (const [key, align, pos] of slots) {
    const tpl = String(hf[key] ?? "");
    if (!tpl.trim()) continue;
    const s = resolveTokens(tpl, ctx);
    const font = await res.fontFor(s, hf.font, false, false);
    const w = font.widthOfTextAtSize(s, hf.size);
    const x = align === "l" ? hf.marginX : align === "c" ? (width - w) / 2 : width - hf.marginX - w;
    const y = pos === "h" ? height - hf.marginY - hf.size * 0.8 : hf.marginY;
    ops.push(setFontAndSize(sink.font(font), hf.size), setTextMatrix(1, 0, 0, 1, x, y), showText(safeEncode(font, s)));
  }
  ops.push(endText(), popGraphicsState());
  page.pushOperators(...ops);
  void textWidth;
}

/* ------------------------------------------------------------------ */
/* sanitize                                                           */

const RISKY_ACTIONS = new Set(["/JavaScript", "/Launch", "/SubmitForm", "/ImportData", "/GoToR", "/GoToE", "/Rendition", "/Sound", "/Movie"]);

/** Strip scripts, embedded files, automatic actions and hidden metadata (Acrobat "Sanitize document"). */
function sanitizeDocument(out: PDFDocument, pages: PDFPage[]) {
  const cat = out.catalog;
  for (const k of ["OpenAction", "AA", "Metadata", "PieceInfo", "SpiderInfo", "Threads", "Collection", "Perms"]) {
    if (k === "OpenAction") {
      const oa = cat.lookup(PDFName.of(k));
      if (oa instanceof PDFDict) cat.delete(PDFName.of(k));
      continue;
    }
    cat.delete(PDFName.of(k));
  }
  const names = cat.lookup(PDFName.of("Names"));
  if (names instanceof PDFDict) {
    names.delete(PDFName.of("JavaScript"));
    names.delete(PDFName.of("EmbeddedFiles"));
    names.delete(PDFName.of("AlternatePresentations"));
  }
  const acro = cat.lookup(PDFName.of("AcroForm"));
  if (acro instanceof PDFDict) acro.delete(PDFName.of("XFA"));
  const cleanDict = (d: PDFDict) => {
    d.delete(PDFName.of("AA"));
    const a = d.lookup(PDFName.of("A"));
    if (a instanceof PDFDict && RISKY_ACTIONS.has(a.get(PDFName.of("S"))?.toString() ?? "")) d.delete(PDFName.of("A"));
  };
  for (const p of pages) {
    p.node.delete(PDFName.of("AA"));
    p.node.delete(PDFName.of("PieceInfo"));
    p.node.delete(PDFName.of("Thumb"));
    const annots = annotsOf(p);
    if (!annots) continue;
    for (let i = annots.size() - 1; i >= 0; i--) {
      const a = annots.lookup(i);
      if (!(a instanceof PDFDict)) continue;
      const sub = a.get(PDFName.of("Subtype"))?.toString();
      if (sub === "/FileAttachment" || sub === "/Screen" || sub === "/Movie" || sub === "/Sound" || sub === "/RichMedia") {
        annots.remove(i);
        continue;
      }
      cleanDict(a);
      let parent = a.lookup(PDFName.of("Parent"));
      for (let g = 0; g < 20 && parent instanceof PDFDict; g++) {
        cleanDict(parent);
        parent = parent.lookup(PDFName.of("Parent"));
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* garbage collection                                                 */

/** Delete every indirect object not reachable from the trailer (deleted pages, replaced streams…). */
export function garbageCollect(doc: PDFDocument) {
  const ctx = doc.context;
  const seen = new Set<string>();
  const stack: PDFObject[] = [];
  const t = ctx.trailerInfo;
  for (const r of [t.Root, t.Info, t.ID, t.Encrypt]) if (r) stack.push(r as PDFObject);
  while (stack.length) {
    const o = stack.pop()!;
    if (o instanceof PDFRef) {
      const k = o.toString();
      if (seen.has(k)) continue;
      seen.add(k);
      const v = ctx.lookup(o);
      if (v) stack.push(v);
    } else if (o instanceof PDFDict) {
      for (const [, v] of o.entries()) stack.push(v);
    } else if (o instanceof PDFArray) {
      for (let i = 0; i < o.size(); i++) stack.push(o.get(i));
    } else if (o instanceof PDFStream) {
      stack.push(o.dict);
    }
  }
  let removed = 0;
  for (const [ref] of ctx.enumerateIndirectObjects()) {
    if (!seen.has(ref.toString())) {
      ctx.delete(ref);
      removed++;
    }
  }
  return removed;
}

export { dataUrlToBytes };
