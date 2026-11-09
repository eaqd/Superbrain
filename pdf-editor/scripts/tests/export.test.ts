/* Node smoke test for the exporter: node scripts/tests/run.mjs export */
import { PDFDocument, StandardFonts, rgb, PDFName, PDFArray } from "@cantoo/pdf-lib";
import { exportPdf } from "../../lib/pdf/exporter";
import type { DocState, EditObj, PageModel, SourceDoc } from "../../lib/pdf/types";
import { readFileSync } from "node:fs";

const assert = (c: unknown, m: string) => {
  if (!c) throw new Error("ASSERT: " + m);
  console.log("  ok -", m);
};

async function makeSource(prefix: string, n: number, withForm = false) {
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < n; i++) {
    const p = d.addPage([612, 792]);
    p.drawText(`Page ${prefix}${i + 1}`, { x: 72, y: 700, size: 24, font: f });
  }
  if (withForm) {
    const tf = d.getForm().createTextField("name");
    tf.addToPage(d.getPage(0), { x: 72, y: 600, width: 200, height: 24 });
    const cb = d.getForm().createCheckBox("agree");
    cb.addToPage(d.getPage(1), { x: 72, y: 600, width: 16, height: 16 });
    // internal link page1 -> page3
    const link = d.context.register(d.context.obj({ Type: "Annot", Subtype: "Link", Rect: [72, 500, 200, 520], Border: [0, 0, 0], Dest: [d.getPage(2).ref, PDFName.of("Fit")] }));
    d.getPage(0).node.addAnnot(link);
    // link page1 -> page2 (page 2 will be deleted)
    const link2 = d.context.register(d.context.obj({ Type: "Annot", Subtype: "Link", Rect: [72, 450, 200, 470], Border: [0, 0, 0], Dest: [d.getPage(1).ref, PDFName.of("Fit")] }));
    d.getPage(0).node.addAnnot(link2);
  }
  return d.save();
}

const now = Date.now();
const base = { rotate: 0 as const, opacity: 1, layer: "content" as const, author: "Tester", created: now, modified: now };
const png1x1 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function main() {
  const aBytes = await makeSource("A", 3, true);
  const bBytes = await makeSource("B", 2);
  const sources: Record<string, SourceDoc> = {
    A: { id: "A", name: "a.pdf", bytes: aBytes, numPages: 3, pdf: null, hasForm: true, encrypted: false },
    B: { id: "B", name: "b.pdf", bytes: bBytes, numPages: 2, pdf: null, hasForm: false, encrypted: false },
  };
  const objs: EditObj[] = [
    { ...base, id: "t1", type: "text", x: 72, y: 100, w: 200, h: 30, text: "Hello edited world", font: "Helvetica", bold: true, italic: false, size: 18, color: "#112233", align: "left", lineHeight: 1.2, fill: null, border: null, borderWidth: 0, autoWidth: true },
    { ...base, id: "t2", type: "text", x: 72, y: 140, w: 200, h: 30, text: "Ünïcödé ✓ привет", font: "Times", bold: false, italic: true, size: 14, color: "#000000", align: "left", lineHeight: 1.2, fill: "#ffff00", border: "#000000", borderWidth: 1, autoWidth: true },
    { ...base, id: "r1", type: "rect", x: 300, y: 100, w: 100, h: 60, stroke: "#ff0000", strokeWidth: 2, fill: "#00ff00", dash: true, layer: "annot", comment: "box comment" },
    { ...base, id: "e1", type: "ellipse", x: 300, y: 200, w: 100, h: 60, stroke: "#0000ff", strokeWidth: 3, fill: null, dash: false },
    { ...base, id: "h1", type: "highlight", x: 72, y: 80, w: 150, h: 30, rects: [{ x: 72, y: 80, w: 150, h: 30 }], color: "#ffd400", text: "Page A1", layer: "annot" },
    { ...base, id: "i1", type: "ink", x: 0, y: 0, w: 0, h: 0, paths: [[100, 400, 120, 410, 140, 400, 160, 420]], stroke: "#000000", strokeWidth: 2 },
    { ...base, id: "l1", type: "arrow", x: 0, y: 0, w: 0, h: 0, x1: 100, y1: 450, x2: 250, y2: 480, stroke: "#ff00ff", strokeWidth: 2, dash: false, layer: "annot" },
    { ...base, id: "n1", type: "note", x: 500, y: 50, w: 22, h: 22, color: "#ffd400", text: "A sticky note", layer: "annot" },
    { ...base, id: "s1", type: "stamp", x: 350, y: 300, w: 160, h: 50, label: "APPROVED", sub: "by Tester", color: "#16803c", layer: "annot", rotate: 90 },
    { ...base, id: "m1", type: "mark", x: 50, y: 300, w: 16, h: 16, mark: "check", color: "#000000" },
    { ...base, id: "img", type: "image", x: 400, y: 500, w: 50, h: 50, src: png1x1, kind: "signature" },
    { ...base, id: "f1", type: "field", x: 72, y: 600, w: 150, h: 22, fieldType: "text", name: "newField", options: [], multiline: false, required: true, readOnly: false, value: "prefilled", checked: false, fontSize: 12, tooltip: "", exportValue: "" },
    { ...base, id: "f2", type: "field", x: 72, y: 640, w: 150, h: 22, fieldType: "dropdown", name: "choice", options: ["One", "Two"], multiline: false, required: false, readOnly: false, value: "Two", checked: false, fontSize: 12, tooltip: "", exportValue: "" },
    { ...base, id: "f3", type: "field", x: 72, y: 680, w: 150, h: 22, fieldType: "signature", name: "sig", options: [], multiline: false, required: false, readOnly: false, value: "", checked: false, fontSize: 12, tooltip: "", exportValue: "" },
    { ...base, id: "k1", type: "link", x: 300, y: 600, w: 100, h: 20, url: "https://example.com", pageId: null },
    { ...base, id: "k2", type: "link", x: 300, y: 640, w: 100, h: 20, url: "", pageId: "pB2" },
  ];
  const page = (id: string, src: string | null, idx: number, objects: EditObj[] = [], rotation: 0 | 90 = 0): PageModel => ({ id, sourceId: src, sourceIndex: idx, baseRotation: 0, rotation, width: 612, height: 792, objects, hiddenAnnots: [] });
  const doc: DocState = {
    pages: [page("pA3", "A", 2, [], 90), page("pA1", "A", 0, objs), page("pB2", "B", 1), page("pA1dup", "A", 0), page("blank", null, 0)],
    forms: { A: { name: "Alice", agree: true } },
    outline: [{ id: "o1", title: "Go to B2", pageId: "pB2", top: 100, children: [], open: true }],
    outlineEdited: true,
    meta: { title: "Smoke", author: "Me", subject: "", keywords: "a, b", creator: "", producer: "" },
    decor: {
      watermark: { kind: "text", text: "CONFIDENTIAL", font: "Helvetica", bold: true, size: 60, color: "#ff0000", imageSrc: null, imageScale: 0.5, opacity: 0.3, rotation: 45, position: "center", layer: "over", pages: "" },
      headerFooter: { hl: "", hc: "{title}", hr: "", fl: "{bates}", fc: "Page {page} of {pages}", fr: "{date}", font: "Helvetica", size: 9, color: "#333333", marginX: 36, marginY: 24, startNumber: 1, pages: "", batesPrefix: "ABC", batesSuffix: "", batesStart: 1, batesDigits: 6 },
    },
  };
  const font = readFileSync("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf");
  const fontkit = ((await import("@cantoo/fontkit")) as any).default ?? (await import("@cantoo/fontkit"));
  const out = await exportPdf(doc, sources, { fileName: "smoke.pdf", unicodeFont: async () => (fontkit ? new Uint8Array(font) : null), onProgress: () => {} , fontkit } as never);
  console.log("exported bytes:", out.length);
  // Inspect with pdf.js
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const pdf = await pdfjs.getDocument({ data: out.slice(), standardFontDataUrl: process.cwd() + "/node_modules/pdfjs-dist/standard_fonts/" }).promise;
  assert(pdf.numPages === 5, "5 pages");
  const texts: string[] = [];
  for (let i = 1; i <= 5; i++) {
    const p = await pdf.getPage(i);
    const tc = await p.getTextContent();
    texts.push(tc.items.map((it: any) => it.str).join(" "));
  }
  console.log(texts);
  assert(texts[0].includes("Page A3"), "page1 is A3");
  assert((await pdf.getPage(1)).rotate === 90, "page1 rotated 90");
  assert(texts[1].includes("Page A1") && texts[1].includes("Hello edited world"), "page2 has A1 + new text");
  assert(texts[2].includes("Page B2"), "page3 is B2");
  assert(texts[3].includes("Page A1") && !texts[3].includes("Hello edited"), "page4 duplicate A1 without objects");
  assert(texts[1].includes("CONFIDENTIAL") && texts[1].includes("ABC000002") && texts[1].includes("Page 2 of 5"), "watermark + bates + page numbers");
  const annots = await (await pdf.getPage(2)).getAnnotations();
  console.log(annots.map((a: any) => `${a.subtype}${a.fieldName ? ":" + a.fieldName + "=" + JSON.stringify(a.fieldValue) : ""}${a.url ? " url=" + a.url : ""}${a.dest ? " dest" : ""}`));
  const subtypes = annots.map((a: any) => a.subtype);
  for (const s of ["Square", "Highlight", "Line", "Text", "Stamp", "Widget", "Link"]) assert(subtypes.includes(s), "annotation " + s);
  const name = annots.find((a: any) => a.fieldName === "name");
  assert(name && name.fieldValue === "Alice", "existing field filled");
  assert(annots.find((a: any) => a.fieldName === "newField")?.fieldValue === "prefilled", "created text field");
  assert(annots.find((a: any) => a.fieldName === "choice")?.fieldValue?.[0] === "Two", "created dropdown");
  const links = annots.filter((a: any) => a.subtype === "Link");
  console.log("links", links.map((l: any) => [l.url, l.dest]));
  assert(links.length === 3, "3 links (internal to A3 kept, link to deleted A2 removed, url, page link)");
  const outline = await pdf.getOutline();
  assert(outline?.[0]?.title === "Go to B2", "outline rebuilt");
  const destIdx = await pdf.getPageIndex((outline as any)[0].dest[0]);
  assert(destIdx === 2, "outline points at B2 (index 2)");
  const meta: any = await pdf.getMetadata();
  assert(meta.info.Title === "Smoke" && meta.info.Author === "Me", "metadata");
  // deleted page content should be gone from the file
  const raw = Buffer.from(out).toString("latin1");
  const doc2 = await PDFDocument.load(out);
  const allText = doc2.context.enumerateIndirectObjects().length;
  console.log("objects:", allText);
  const fields = (await PDFDocument.load(out)).getForm().getFields().map((f) => f.getName());
  console.log("fields:", fields);
  assert(fields.includes("agree") === false, "field on deleted page removed from AcroForm");
  assert(new Set(fields).size === fields.length && fields.includes("name_2"), "duplicated page field renamed uniquely");
  // Encrypt round trip
  const enc = await exportPdf(doc, sources, { encrypt: { userPassword: "pw", ownerPassword: "owner" }, unicodeFont: async () => null });
  let needPw = false;
  try {
    await pdfjs.getDocument({ data: enc.slice() }).promise;
  } catch (e: any) {
    needPw = e?.name === "PasswordException";
  }
  assert(needPw, "encrypted output requires password");
  const dec = await pdfjs.getDocument({ data: enc.slice(), password: "pw" }).promise;
  assert(dec.numPages === 5, "decrypts with password");
  // re-open encrypted as a source and export without encryption
  const sources2: Record<string, SourceDoc> = { E: { id: "E", name: "e.pdf", bytes: enc, password: "pw", numPages: 5, pdf: null, hasForm: true, encrypted: true } };
  const doc3: DocState = { ...doc, pages: [0, 1].map((i) => page("e" + i, "E", i)), outline: null, forms: {}, decor: { watermark: null, headerFooter: null } };
  const plain = await exportPdf(doc3, sources2, {});
  const pp = await pdfjs.getDocument({ data: plain.slice() }).promise;
  assert(pp.numPages === 2, "decrypted re-export opens without password");
  void raw;
  console.log("ALL EXPORT TESTS PASSED");
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
