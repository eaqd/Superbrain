// Copies the pdf.js runtime (library, worker, CMaps, standard fonts, wasm decoders)
// into public/pdfjs so the editor can load it as plain static ESM, bypassing the bundler.
// Runs automatically on `npm install` (postinstall) and before dev/build.
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules", "pdfjs-dist");
const out = join(root, "public", "pdfjs");

if (!existsSync(src)) {
  console.warn("[copy-pdfjs] pdfjs-dist not installed yet; skipping");
  process.exit(0);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// The legacy build supports a wider range of browsers (older Safari/iOS).
for (const f of ["pdf.min.mjs", "pdf.worker.min.mjs"]) {
  cpSync(join(src, "legacy", "build", f), join(out, f));
}
for (const dir of ["cmaps", "standard_fonts", "wasm", "iccs"]) {
  if (existsSync(join(src, dir))) cpSync(join(src, dir), join(out, dir), { recursive: true });
}
console.log("[copy-pdfjs] pdf.js assets copied to public/pdfjs");

// Tesseract (OCR) runtime + English model, self-hosted so OCR works without third-party CDNs.
const tess = join(root, "node_modules", "tesseract.js", "dist");
const core = join(root, "node_modules", "tesseract.js-core");
const lang = join(root, "node_modules", "@tesseract.js-data", "eng", "4.0.0_best_int");
const tOut = join(root, "public", "tesseract");
if (existsSync(tess) && existsSync(core)) {
  rmSync(tOut, { recursive: true, force: true });
  mkdirSync(join(tOut, "core"), { recursive: true });
  mkdirSync(join(tOut, "lang"), { recursive: true });
  cpSync(join(tess, "worker.min.js"), join(tOut, "worker.min.js"));
  for (const f of ["tesseract-core-lstm.wasm.js", "tesseract-core-simd-lstm.wasm.js", "tesseract-core-relaxedsimd-lstm.wasm.js"]) {
    if (existsSync(join(core, f))) cpSync(join(core, f), join(tOut, "core", f));
  }
  if (existsSync(lang)) cpSync(join(lang, "eng.traineddata.gz"), join(tOut, "lang", "eng.traineddata.gz"));
  console.log("[copy-pdfjs] tesseract OCR assets copied to public/tesseract");
}
