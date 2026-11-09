"use client";
import { useEditor, type DialogKind } from "@/lib/pdf/store";
import { printDocument } from "@/lib/pdf/actions";

export function runToolAction(id: string, dialog?: DialogKind["kind"]) {
  const s = useEditor.getState();
  switch (id) {
    case "search":
      useEditor.setState({ left: "search" });
      setTimeout(() => (document.querySelector("[data-search-input]") as HTMLInputElement | null)?.focus(), 30);
      return;
    case "print":
      printDocument();
      return;
    case "readMode":
      useEditor.setState({ readMode: true, selection: null, tool: "select" });
      document.documentElement.requestFullscreen?.().catch(() => {});
      return;
    case "crop": {
      const page = s.doc?.pages[s.currentPage];
      if (page) useEditor.setState({ dialog: { kind: "crop", pageIds: [page.id] } });
      return;
    }
    case "redact":
      useEditor.setState({ group: "redact", tool: "redact-text" });
      return;
    case "organize":
      useEditor.setState({ group: "organize", tool: "select" });
      return;
  }
  if (dialog) useEditor.setState({ dialog: { kind: dialog } as DialogKind });
}
