"use client";

import dynamic from "next/dynamic";

// The editor is browser-only (canvas, pdf.js workers, File APIs).
const Editor = dynamic(() => import("@/components/pdf/Editor"), {
  ssr: false,
  loading: () => (
    <div className="pdf-app fixed inset-0 grid place-items-center">
      <div className="flex items-center gap-3 text-sm" style={{ color: "var(--muted)" }}>
        <span className="pdf-spinner" /> Loading editor…
      </div>
    </div>
  ),
});

export default function PdfPage() {
  return <Editor />;
}
