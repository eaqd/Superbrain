"use client";
import { useState } from "react";
import {
  Combine,
  EyeOff,
  FilePlus,
  FileText,
  FolderOpen,
  ImagePlus,
  LayoutGrid,
  Lock,
  Minimize2,
  MessageSquareText,
  SquarePen,
  Signature,
  Sparkles,
  ShieldCheck,
  FileDown,
  ScanText,
} from "lucide-react";
import { useEditor, type DialogKind, type ToolGroup } from "@/lib/pdf/store";
import { openFiles } from "@/lib/pdf/actions";
import { buildSamplePdf } from "@/lib/pdf/sample";

/** After the next file is opened, jump to this tool/dialog. */
export const pendingIntent: { group?: ToolGroup; dialog?: DialogKind["kind"] } = {};

export async function openSample() {
  const bytes = await buildSamplePdf();
  await openFiles([new File([bytes as BlobPart], "Sample report.pdf", { type: "application/pdf" })]);
}

const ACTIONS: { label: string; desc: string; icon: typeof FileText; group?: ToolGroup; dialog?: DialogKind["kind"]; special?: "combine" | "images" | "blank" }[] = [
  { label: "Edit PDF", desc: "Change text, images and shapes", icon: SquarePen, group: "edit" },
  { label: "Comment", desc: "Highlight, notes, drawing, stamps", icon: MessageSquareText, group: "comment" },
  { label: "Fill & Sign", desc: "Complete forms and sign", icon: Signature, group: "fill" },
  { label: "Organize pages", desc: "Reorder, rotate, delete, insert", icon: LayoutGrid, group: "organize" },
  { label: "Combine files", desc: "Merge PDFs and images into one", icon: Combine, special: "combine" },
  { label: "Create from images", desc: "JPG, PNG, WebP → PDF", icon: ImagePlus, special: "images" },
  { label: "Redact", desc: "Permanently remove sensitive info", icon: EyeOff, group: "redact" },
  { label: "Protect", desc: "Password & permissions (AES-256)", icon: Lock, dialog: "protect" },
  { label: "Compress", desc: "Reduce file size", icon: Minimize2, dialog: "compress" },
  { label: "Convert", desc: "Export to Word, images or text", icon: FileDown, dialog: "export" },
  { label: "Prepare form", desc: "Add fillable fields", icon: ShieldCheck, group: "form" },
  { label: "Scan & OCR", desc: "Make scans searchable", icon: ScanText, dialog: "ocr" },
];

export default function StartScreen() {
  const [over, setOver] = useState(false);
  const pick = (multiple = false, accept = "application/pdf,.pdf,image/*") => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.multiple = multiple;
    input.onchange = () => {
      const files = Array.from(input.files ?? []);
      if (files.length) openFiles(files).then(applyIntent);
    };
    input.click();
  };

  return (
    <div
      className="pdf-scroll flex min-h-0 flex-1 flex-col overflow-y-auto"
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const files = Array.from(e.dataTransfer.files);
        if (files.length) openFiles(files).then(applyIntent);
      }}
    >
      <div className="pdf-topbar flex h-12 flex-none items-center gap-2 px-4">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/pdf-icon.svg" alt="" width={24} height={24} />
        <span className="text-[14px] font-semibold tracking-tight">Superbrain PDF</span>
        <span className="ml-2 hidden text-[12px] sm:inline" style={{ color: "var(--chrome-muted)" }}>
          Private by design — your files never leave this browser
        </span>
        <div className="flex-1" />
        <button className="pdf-icon-btn" title="Toggle theme" onClick={() => useEditor.setState({ darkUi: !useEditor.getState().darkUi })}>
          ◐
        </button>
      </div>

      <div className="mx-auto w-full max-w-[1040px] px-4 pb-16 pt-10 sm:px-6">
        <h1 className="text-[28px] font-semibold tracking-tight sm:text-[34px]">Do anything with your PDFs.</h1>
        <p className="mt-2 max-w-[640px] text-[14.5px]" style={{ color: "var(--muted)" }}>
          Edit text and images, comment, fill and sign forms, organize pages, redact, protect, compress and convert — all in your browser, with nothing uploaded.
        </p>

        <div className={`pdf-dropzone mt-7 flex flex-col items-center justify-center gap-3 px-6 py-12 text-center ${over ? "over" : ""}`} style={{ background: over ? undefined : "var(--panel)" }}>
          <div className="grid h-14 w-14 place-items-center rounded-2xl" style={{ background: "var(--accent-soft)", color: "var(--accent)" }}>
            <FolderOpen size={26} />
          </div>
          <div className="text-[16px] font-semibold">Drop PDFs or images here</div>
          <div className="text-[13px]" style={{ color: "var(--muted)" }}>
            Several files are combined into one document.
          </div>
          <div className="mt-2 flex flex-wrap justify-center gap-2">
            <button className="pdf-btn primary h-10 px-5 text-[14px]" onClick={() => pick(true)}>
              <FolderOpen size={16} /> Choose files
            </button>
            <button className="pdf-btn h-10 px-4 text-[14px]" onClick={() => openSample()}>
              <Sparkles size={16} /> Try a sample
            </button>
            <button className="pdf-btn h-10 px-4 text-[14px]" onClick={() => useEditor.setState({ dialog: { kind: "newBlank" } })}>
              <FilePlus size={16} /> Blank PDF
            </button>
          </div>
        </div>

        <h2 className="mb-3 mt-10 text-[13px] font-semibold uppercase tracking-wide" style={{ color: "var(--muted)" }}>
          All tools
        </h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {ACTIONS.map((a) => (
            <button
              key={a.label}
              className="pdf-start-card"
              onClick={() => {
                pendingIntent.group = a.group;
                pendingIntent.dialog = a.dialog;
                if (a.special === "images") pick(true, "image/*");
                else if (a.special === "combine") pick(true);
                else pick(false);
              }}
            >
              <span className="grid h-10 w-10 flex-none place-items-center rounded-lg" style={{ background: "var(--accent-soft)", color: "var(--accent)" }}>
                <a.icon size={20} />
              </span>
              <span>
                <span className="block text-[14px] font-semibold">{a.label}</span>
                <span className="block text-[12.5px]" style={{ color: "var(--muted)" }}>
                  {a.desc}
                </span>
              </span>
            </button>
          ))}
        </div>
        <p className="mt-10 text-center text-[12px]" style={{ color: "var(--faint)" }}>
          Works offline once loaded · Saves standard PDF annotations, forms and AES-256 encryption compatible with Adobe Acrobat
        </p>
      </div>
    </div>
  );
}

export function applyIntent() {
  const s = useEditor.getState();
  if (!s.doc) return;
  if (pendingIntent.group) {
    const g = pendingIntent.group;
    useEditor.setState({ group: g, tool: g === "comment" ? "highlight" : g === "redact" ? "redact-text" : "select" });
  }
  if (pendingIntent.dialog) useEditor.setState({ dialog: { kind: pendingIntent.dialog } as DialogKind });
  pendingIntent.group = undefined;
  pendingIntent.dialog = undefined;
}
