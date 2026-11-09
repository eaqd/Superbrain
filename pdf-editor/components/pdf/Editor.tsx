"use client";
import { useEffect } from "react";
import { useEditor, undo, redo, deleteObjects, navigateTo, mutate, mapPage, isDirty, toast, type Tool, DEFAULT_STYLE } from "@/lib/pdf/store";
import { insertFiles, openFiles, printDocument, saveDocument } from "@/lib/pdf/actions";
import { moveObj, normalizeImage, readFileAsDataUrl, uid } from "@/lib/pdf/util";
import type { EditObj } from "@/lib/pdf/types";
import { TopBar, ToolRail, ToolBar, openFilePicker } from "./Chrome";
import Viewer, { setZoom, zoomBy } from "./Viewer";
import Sidebar from "./Sidebar";
import Properties, { duplicateSelection } from "./Properties";
import StartScreen, { applyIntent } from "./StartScreen";
import Organizer from "./Organizer";
import Dialogs from "./Dialogs";

const PREFS_KEY = "superbrain-pdf-prefs";
let clipboard: { objects: EditObj[] } | null = null;

const KEY_TOOLS: Record<string, Tool> = {
  v: "select",
  h: "hand",
  e: "edit-text",
  t: "text",
  r: "rect",
  o: "ellipse",
  l: "line",
  a: "arrow",
  p: "ink",
  n: "note",
  u: "highlight",
};

export async function placeImageFile(file: File) {
  try {
    const { src, w, h } = await normalizeImage(await readFileAsDataUrl(file));
    useEditor.setState({ placement: { src, w: w * 0.75, h: h * 0.75, kind: "image" }, tool: "image", selection: null });
    toast("Click on the page to place the image.");
  } catch {
    toast("That image could not be read.", "error");
  }
}

export default function Editor() {
  const doc = useEditor((s) => !!s.doc);
  const group = useEditor((s) => s.group);
  const dark = useEditor((s) => s.darkUi);
  const busy = useEditor((s) => s.busy);
  const toasts = useEditor((s) => s.toasts);
  const narrow = useEditor((s) => s.narrow);
  const readMode = useEditor((s) => s.readMode);

  // ---- preferences ----
  useEffect(() => {
    try {
      const raw = localStorage.getItem(PREFS_KEY);
      if (raw) {
        const p = JSON.parse(raw);
        useEditor.setState({ author: p.author ?? "", darkUi: !!p.darkUi, style: { ...DEFAULT_STYLE, ...(p.style ?? {}) } });
      }
    } catch {
      /* storage unavailable */
    }
    const onResize = () => {
      const narrow = window.innerWidth < 900;
      if (narrow !== useEditor.getState().narrow) useEditor.setState(narrow ? { narrow, left: null, rightOpen: false } : { narrow, left: "pages", rightOpen: true });
    };
    if (window.innerWidth < 900) useEditor.setState({ narrow: true, left: null, rightOpen: false });
    window.addEventListener("resize", onResize);
    const unsub = useEditor.subscribe((s, prev) => {
      if (s.author === prev.author && s.darkUi === prev.darkUi && s.style === prev.style) return;
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify({ author: s.author, darkUi: s.darkUi, style: s.style }));
      } catch {
        /* ignore */
      }
    });
    return () => {
      unsub();
      window.removeEventListener("resize", onResize);
    };
  }, []);

  // ---- leave guard ----
  useEffect(() => {
    const onBefore = (e: BeforeUnloadEvent) => {
      if (isDirty()) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", onBefore);
    return () => window.removeEventListener("beforeunload", onBefore);
  }, []);

  // ---- keyboard ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useEditor.getState();
      const target = e.target as HTMLElement | null;
      const typing = !!target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable);
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (mod && k === "o") {
        e.preventDefault();
        openFilePicker("pdf-open-input");
        return;
      }
      if (!s.doc) return;
      if (s.dialog) return;
      if (mod && k === "s") {
        e.preventDefault();
        if (e.shiftKey) useEditor.setState({ dialog: { kind: "save" } });
        else saveDocument();
        return;
      }
      if (mod && k === "p") {
        e.preventDefault();
        printDocument();
        return;
      }
      if (mod && k === "f") {
        e.preventDefault();
        useEditor.setState({ left: "search" });
        setTimeout(() => (document.querySelector("[data-search-input]") as HTMLInputElement | null)?.focus(), 30);
        return;
      }
      if (mod && (k === "=" || k === "+")) {
        e.preventDefault();
        zoomBy(1.2);
        return;
      }
      if (mod && k === "-") {
        e.preventDefault();
        zoomBy(1 / 1.2);
        return;
      }
      if (mod && k === "0") {
        e.preventDefault();
        setZoom(s.scale, "page");
        return;
      }
      if (mod && k === "1") {
        e.preventDefault();
        setZoom(1);
        return;
      }
      if (mod && k === "2") {
        e.preventDefault();
        setZoom(s.scale, "width");
        return;
      }
      if (typing) return;
      if (mod && k === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && k === "y") {
        e.preventDefault();
        redo();
        return;
      }
      if (mod && k === "d") {
        e.preventDefault();
        if (s.selection) duplicateSelection();
        else useEditor.setState({ dialog: { kind: "properties" } });
        return;
      }
      if (mod && (k === "c" || k === "x") && s.selection) {
        const page = s.doc.pages.find((p) => p.id === s.selection!.pageId);
        if (!page || window.getSelection()?.toString()) return;
        clipboard = { objects: page.objects.filter((o) => s.selection!.ids.includes(o.id)) };
        if (k === "x") deleteObjects(page.id, s.selection.ids);
        e.preventDefault();
        return;
      }
      if (mod && k === "v" && clipboard) {
        const page = s.doc.pages[s.currentPage];
        if (!page) return;
        e.preventDefault();
        const sameSpot = s.selection?.pageId === page.id;
        const copies = clipboard.objects.map((o) => ({ ...(sameSpot ? moveObj(o, 12, 12) : o), id: uid(), created: Date.now() }) as EditObj);
        mutate((d) => mapPage(d, page.id, (p) => ({ ...p, objects: [...p.objects, ...copies] })));
        useEditor.setState({ selection: { pageId: page.id, ids: copies.map((c) => c.id) } });
        return;
      }
      if (mod && k === "a" && s.tool !== "select") return;
      if (e.key === "Escape") {
        if (s.readMode) {
          useEditor.setState({ readMode: false });
          if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
          return;
        }
        if (s.placement) useEditor.setState({ placement: null, tool: "select" });
        else if (s.selection) useEditor.setState({ selection: null, editingId: null });
        else if (s.tool !== "select") useEditor.setState({ tool: "select" });
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && s.selection) {
        e.preventDefault();
        deleteObjects(s.selection.pageId, s.selection.ids);
        return;
      }
      if (e.key === "Enter" && s.selection?.ids.length === 1) {
        const o = s.doc.pages.find((p) => p.id === s.selection!.pageId)?.objects.find((x) => x.id === s.selection!.ids[0]);
        if (o?.type === "text") {
          e.preventDefault();
          useEditor.setState({ editingId: o.id });
        }
        return;
      }
      if (e.key.startsWith("Arrow") && s.selection) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        const ids = s.selection.ids;
        mutate((d) => mapPage(d, s.selection!.pageId, (p) => ({ ...p, objects: p.objects.map((o) => (ids.includes(o.id) && !o.locked ? moveObj(o, dx, dy) : o)) })), { coalesce: "nudge" });
        return;
      }
      if (e.key === "PageDown" || (e.key === "ArrowRight" && !s.selection)) {
        if (s.currentPage < s.doc.pages.length - 1) {
          e.preventDefault();
          navigateTo(s.currentPage + 1);
        }
        return;
      }
      if (e.key === "PageUp" || (e.key === "ArrowLeft" && !s.selection)) {
        if (s.currentPage > 0) {
          e.preventDefault();
          navigateTo(s.currentPage - 1);
        }
        return;
      }
      if (e.key === "Home" && !mod) {
        navigateTo(0);
        return;
      }
      if (e.key === "End" && !mod) {
        navigateTo(s.doc.pages.length - 1);
        return;
      }
      if (e.key === "?") {
        useEditor.setState({ dialog: { kind: "shortcuts" } });
        return;
      }
      if (!mod && !e.altKey && KEY_TOOLS[k] && s.group !== "organize") {
        useEditor.setState({ tool: KEY_TOOLS[k], selection: null, editingId: null });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ---- paste images ----
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const s = useEditor.getState();
      const t = e.target as HTMLElement | null;
      if (!s.doc || (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA"))) return;
      const file = Array.from(e.clipboardData?.files ?? []).find((f) => f.type.startsWith("image/"));
      if (file) {
        e.preventDefault();
        placeImageFile(file);
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  const onDrop = (e: React.DragEvent) => {
    if (!useEditor.getState().doc) return;
    const files = Array.from(e.dataTransfer.files);
    if (!files.length) return;
    e.preventDefault();
    const images = files.filter((f) => f.type.startsWith("image/"));
    const pdfs = files.filter((f) => !f.type.startsWith("image/"));
    if (images.length === 1 && !pdfs.length) placeImageFile(images[0]);
    else insertFiles(files, useEditor.getState().currentPage + 1);
  };

  return (
    <div className={`pdf-app ${dark ? "dark" : ""}`} onDragOver={(e) => e.dataTransfer.types.includes("Files") && e.preventDefault()} onDrop={onDrop}>
      {doc && readMode ? (
        <div className="relative min-h-0 flex-1">
          <Viewer />
          <button
            className="pdf-btn absolute right-4 top-3 z-20 shadow-lg"
            onClick={() => {
              useEditor.setState({ readMode: false });
              if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
            }}
          >
            Exit read mode
          </button>
        </div>
      ) : doc ? (
        <>
          <TopBar />
          <div className="relative flex min-h-0 flex-1">
            {!narrow && <ToolRail />}
            {group !== "organize" && <Sidebar />}
            <main className="flex min-w-0 flex-1 flex-col">
              {group === "organize" ? (
                <Organizer />
              ) : (
                <>
                  <ToolBar />
                  <div className="relative min-h-0 flex-1">
                    <Viewer />
                  </div>
                </>
              )}
            </main>
            <Properties />
          </div>
          {narrow && <ToolRail horizontal />}
        </>
      ) : (
        <StartScreen />
      )}

      <Dialogs />

      <div className="pointer-events-none fixed bottom-4 left-1/2 z-[95] flex -translate-x-1/2 flex-col items-center gap-2">
        {toasts.map((t) => (
          <div key={t.id} className={`pdf-toast ${t.tone}`} role="status">
            {t.text}
          </div>
        ))}
      </div>
      {busy && (
        <div className="pdf-busy">
          <div className="flex items-center gap-3 rounded-xl px-5 py-4 shadow-xl" style={{ background: "var(--panel)", color: "var(--text)" }}>
            <span className="pdf-spinner" />
            <span className="text-[13.5px]">{busy}</span>
          </div>
        </div>
      )}

      <input
        id="pdf-open-input"
        type="file"
        accept="application/pdf,.pdf,image/*"
        multiple
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (files.length) openFiles(files).then(applyIntent);
        }}
      />
      <input
        id="pdf-insert-input"
        type="file"
        accept="application/pdf,.pdf,image/*"
        multiple
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          const at = (window as unknown as { __pdfInsertAt?: number }).__pdfInsertAt;
          (window as unknown as { __pdfInsertAt?: number }).__pdfInsertAt = undefined;
          if (files.length) insertFiles(files, at ?? useEditor.getState().currentPage + 1);
        }}
      />
      <input
        id="pdf-image-input"
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) placeImageFile(f);
        }}
      />
    </div>
  );
}
