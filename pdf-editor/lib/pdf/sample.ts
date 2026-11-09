/** Builds a small demo PDF (text, form fields, link, bookmarks) for trying the editor. */
import { PDFDocument, PDFName, PDFHexString, PDFString, StandardFonts, rgb } from "@cantoo/pdf-lib";

export async function buildSamplePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const times = await doc.embedFont(StandardFonts.TimesRoman);
  doc.setTitle("Superbrain PDF — sample document");
  doc.setAuthor("Superbrain");
  doc.setSubject("A sample to try editing, commenting, forms and redaction");

  // Page 1 — letter
  const p1 = doc.addPage([612, 792]);
  p1.drawRectangle({ x: 0, y: 742, width: 612, height: 50, color: rgb(0.12, 0.14, 0.19) });
  p1.drawText("ACME RESEARCH LABS", { x: 54, y: 760, size: 16, font: bold, color: rgb(1, 1, 1) });
  p1.drawText("Quarterly Project Report", { x: 54, y: 690, size: 26, font: bold, color: rgb(0.1, 0.1, 0.12) });
  p1.drawText("Prepared for: Jordan Rivera  •  Account #: 4417-2290-1185  •  November 2026", { x: 54, y: 666, size: 10.5, font: helv, color: rgb(0.35, 0.37, 0.42) });
  const body = [
    "This sample lets you try every tool. Choose Edit > Edit text and click any line on this",
    "page to change it — the original font size, colour and position are matched.",
    "",
    "Highlights: revenue grew 18% quarter over quarter, driven by the new analytics",
    "product. Customer churn fell to 2.1%, the lowest level since the company was founded.",
    "Headcount reached 142 people across three offices in Lisbon, Austin and Singapore.",
    "",
    "Confidential: the acquisition of Northwind Systems is expected to close in Q1 for",
    "$42.5 million. Try Redact > Redact text on this sentence, then Apply.",
  ];
  body.forEach((line, i) => p1.drawText(line, { x: 54, y: 620 - i * 17, size: 12, font: times, color: rgb(0.1, 0.1, 0.12) }));
  p1.drawText("Key figures", { x: 54, y: 440, size: 15, font: bold });
  const rows = [
    ["Metric", "Q2", "Q3", "Change"],
    ["Revenue", "$4.1M", "$4.84M", "+18%"],
    ["Gross margin", "61%", "64%", "+3 pts"],
    ["Active customers", "1,820", "2,140", "+17.6%"],
  ];
  rows.forEach((r, i) => {
    const y = 410 - i * 22;
    if (i === 0) p1.drawRectangle({ x: 54, y: y - 6, width: 504, height: 22, color: rgb(0.93, 0.94, 0.96) });
    r.forEach((c, j) => p1.drawText(c, { x: 62 + j * 126, y, size: 11, font: i === 0 ? bold : helv }));
    p1.drawLine({ start: { x: 54, y: y - 7 }, end: { x: 558, y: y - 7 }, thickness: 0.5, color: rgb(0.8, 0.82, 0.86) });
  });
  p1.drawText("Visit the project site:", { x: 54, y: 290, size: 11, font: helv });
  p1.drawText("https://example.com/report", { x: 170, y: 290, size: 11, font: helv, color: rgb(0.11, 0.43, 0.88) });
  const link = doc.context.register(
    doc.context.obj({ Type: "Annot", Subtype: "Link", Rect: [168, 286, 310, 302], Border: [0, 0, 0], A: { S: "URI", URI: PDFString.of("https://example.com/report") } }),
  );
  p1.node.addAnnot(link);
  p1.drawText("Continue to the sign-off form on page 2 >>", { x: 54, y: 260, size: 11, font: helv, color: rgb(0.11, 0.43, 0.88) });
  p1.drawText("Page 1 of 2", { x: 280, y: 40, size: 9, font: helv, color: rgb(0.5, 0.5, 0.55) });

  // Page 2 — form
  const p2 = doc.addPage([612, 792]);
  const goto = doc.context.register(doc.context.obj({ Type: "Annot", Subtype: "Link", Rect: [52, 256, 290, 272], Border: [0, 0, 0], Dest: [p2.ref, PDFName.of("Fit")] }));
  p1.node.addAnnot(goto);
  p2.drawText("Sign-off form", { x: 54, y: 720, size: 24, font: bold });
  p2.drawText("Fill & Sign: click into the blue fields, then use Sign to add your signature.", { x: 54, y: 696, size: 11, font: helv, color: rgb(0.35, 0.37, 0.42) });
  const form = doc.getForm();
  const label = (t: string, y: number) => p2.drawText(t, { x: 54, y, size: 11, font: helv });
  label("Full name", 650);
  form.createTextField("full_name").addToPage(p2, { x: 160, y: 642, width: 300, height: 22 });
  label("Email", 610);
  form.createTextField("email").addToPage(p2, { x: 160, y: 602, width: 300, height: 22 });
  label("Department", 570);
  const dd = form.createDropdown("department");
  dd.addOptions(["Engineering", "Finance", "Operations", "Sales"]);
  dd.addToPage(p2, { x: 160, y: 562, width: 200, height: 22 });
  label("Approval", 530);
  const rg = form.createRadioGroup("approval");
  rg.addOptionToPage("Approve", p2, { x: 160, y: 526, width: 14, height: 14 });
  p2.drawText("Approve", { x: 180, y: 529, size: 11, font: helv });
  rg.addOptionToPage("Reject", p2, { x: 260, y: 526, width: 14, height: 14 });
  p2.drawText("Reject", { x: 280, y: 529, size: 11, font: helv });
  label("Comments", 490);
  const tf = form.createTextField("comments");
  tf.enableMultiline();
  tf.addToPage(p2, { x: 160, y: 410, width: 380, height: 92 });
  form.createCheckBox("agree").addToPage(p2, { x: 54, y: 370, width: 14, height: 14 });
  p2.drawText("I confirm the figures in this report are accurate.", { x: 76, y: 373, size: 11, font: helv });
  p2.drawLine({ start: { x: 54, y: 300 }, end: { x: 300, y: 300 }, thickness: 0.8 });
  p2.drawText("Signature", { x: 54, y: 286, size: 9, font: helv, color: rgb(0.4, 0.4, 0.45) });
  p2.drawLine({ start: { x: 340, y: 300 }, end: { x: 540, y: 300 }, thickness: 0.8 });
  p2.drawText("Date", { x: 340, y: 286, size: 9, font: helv, color: rgb(0.4, 0.4, 0.45) });
  p2.drawText("Page 2 of 2", { x: 280, y: 40, size: 9, font: helv, color: rgb(0.5, 0.5, 0.55) });

  // Bookmarks
  const ctx = doc.context;
  const root = ctx.nextRef();
  const b1 = ctx.nextRef();
  const b2 = ctx.nextRef();
  ctx.assign(b1, ctx.obj({ Title: PDFHexString.fromText("Quarterly report"), Parent: root, Next: b2, Dest: [p1.ref, PDFName.of("Fit")] }));
  ctx.assign(b2, ctx.obj({ Title: PDFHexString.fromText("Sign-off form"), Parent: root, Prev: b1, Dest: [p2.ref, PDFName.of("Fit")] }));
  ctx.assign(root, ctx.obj({ Type: "Outlines", First: b1, Last: b2, Count: 2 }));
  doc.catalog.set(PDFName.of("Outlines"), root);

  return doc.save();
}
