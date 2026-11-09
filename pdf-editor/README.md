# Superbrain PDF

A full PDF editor modelled on Adobe Acrobat's tool set. Everything runs in the browser — files are never uploaded.

This is a standalone Next.js app, independent of the Mnemonicon app at the repository root.

## Run it

```bash
cd pdf-editor
npm install        # also copies the pdf.js + Tesseract runtimes into public/
npm run dev        # http://localhost:3000
```

Drop in PDFs or images, or click **Try a sample**.

## Deploy

On Vercel, import the repository and set **Root Directory** to `pdf-editor` (framework: Next.js, defaults otherwise). `vercel.json` in this folder adds caching headers for the pdf.js and OCR assets.

## Tools

| Acrobat tool | Superbrain PDF |
| --- | --- |
| **View** | Continuous scroll, thumbnails, bookmarks, zoom (fit width/page, Ctrl+wheel), hand tool, text selection & copy, search with highlights, clickable links, attachments panel, dark UI |
| **Edit PDF** | Edit existing text in place (font, size, colour and position matched; the original glyphs are removed from the content stream on save), add text, images, rectangles, ovals, lines, arrows, freehand drawing, whiteout, links, crop, page size, watermark, header & footer, page numbers |
| **Comment** | Highlight, underline, strikethrough, squiggly, sticky notes, text boxes, drawing, shapes, stamps (12 presets + custom), eraser, and a comments list with authors and dates. Saved as real PDF annotations, so they stay editable in Acrobat |
| **Fill & Sign** | Fill existing AcroForm fields (text, checkbox, radio, dropdown, list), add text/check/cross/dot/date anywhere, signatures & initials (draw / type / upload, remembered on the device), sign into signature fields |
| **Prepare Form** | Create text fields, checkboxes, radio groups, dropdowns, list boxes, signature fields and buttons; flatten |
| **Organize Pages** | Grid view with drag-and-drop reordering, rotate, delete, duplicate, insert blank pages or other files, extract, split (every N pages / ranges / bookmarks), reverse, crop, resize |
| **Combine Files** | Merge any number of PDFs and images (forms and bookmarks are preserved) |
| **Create PDF** | From images (JPG, PNG, WebP, GIF…) or a blank document |
| **Redact** | Redact selected text, areas, or Find & redact (words, emails, phone numbers, card numbers, SSNs, dates, URLs, amounts). *Apply* rewrites the page content streams so text, image pixels, vector paths and annotations under the boxes are removed from the file, not just covered |
| **Protect** | AES-256 / AES-128 password encryption with permissions (printing, copying, editing, comments, forms, assembly), open password-protected files, remove passwords, sanitize (metadata, JavaScript, attachments, actions) |
| **Compress** | Downsamples and re-encodes images by effective DPI, garbage-collects unused objects, object streams |
| **Export** | Word (.docx), PNG/JPEG images, plain text, HTML, flattened PDF |
| **Scan & OCR** | Tesseract (self-hosted, English) adds an invisible searchable text layer |
| **Compare Files** | Word-level diff against another version, with a change list and optional markup |
| **Print / Properties** | Print with annotations, edit title/author/subject/keywords |

Undo/redo covers every change, and keyboard shortcuts follow Acrobat's (press `?` in the editor for the list).

## How it works

```
app/                   page, layout (UI + signature fonts), editor CSS
components/pdf/        Editor shell, Viewer + PageView (canvas, text layer, forms, objects),
                       Sidebar (pages, bookmarks, comments, search, attachments),
                       Properties panel, Organizer, Dialogs, SignatureDialog
lib/pdf/
  types.ts             document model: pages reference source files; edits are objects
  store.ts             zustand store, undo/redo history
  pdfjs.ts             pdf.js 6 loaded as static ESM from /public/pdfjs
  exporter.ts          pdf-lib export: page assembly across files, annotations,
                       forms, bookmarks, watermark/header/footer, GC, encryption
  draw.ts              objects → PDF operators (shared by page content & appearance streams)
  engine/              content-stream parser + true redaction / text removal engine
  tools/               OCR, conversions, compression, Word export, compare
scripts/copy-pdfjs.mjs copies pdf.js + Tesseract runtimes into public/ on install/build
```

Page edits (reorder, rotate, delete, insert) are instant because pages only *reference* the original files; the PDF is assembled once when you save. Operations that must change page content (apply redactions, crop, resize, OCR) "rebase" the document onto a freshly written PDF while keeping your other edits editable.

### Tests

```bash
npm run test:export   # exporter: assembly, annotations, forms, bookmarks, encryption
npm run test:redact   # redaction engine (needs poppler-utils)
npm run test:tools    # compression, Word export, compare
```

The test runners bundle TypeScript with `npx esbuild` on the fly.
