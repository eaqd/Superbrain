"use client";

import { create } from "zustand";
import type { DocState, EditObj, FontKey, PageModel, SourceDoc } from "./types";

export type ToolGroup =
  | "view"
  | "edit"
  | "comment"
  | "fill"
  | "form"
  | "organize"
  | "redact"
  | "protect"
  | "more";

export type Tool =
  | "select"
  | "hand"
  | "edit-text"
  | "text"
  | "image"
  | "rect"
  | "ellipse"
  | "line"
  | "arrow"
  | "ink"
  | "whiteout"
  | "link"
  | "highlight"
  | "underline"
  | "strikeout"
  | "squiggly"
  | "note"
  | "textbox"
  | "stamp"
  | "check"
  | "cross"
  | "dot"
  | "signature"
  | "initials"
  | "date"
  | "field-text"
  | "field-checkbox"
  | "field-radio"
  | "field-dropdown"
  | "field-listbox"
  | "field-signature"
  | "field-button"
  | "redact-area"
  | "redact-text"
  | "eraser";

export interface ToolStyle {
  color: string;
  /** Colour of new text (Add text / text boxes). */
  textColor: string;
  fill: string | null;
  strokeWidth: number;
  opacity: number;
  font: FontKey;
  size: number;
  bold: boolean;
  italic: boolean;
  highlight: string;
  dash: boolean;
}

export type LeftPanel = "pages" | "outline" | "comments" | "search" | "attachments" | "layers";

export type DialogKind =
  | { kind: "password"; fileName: string; incorrect: boolean; resolve: (pw: string | null) => void }
  | { kind: "signature"; mode: "signature" | "initials" }
  | { kind: "stamp" }
  | { kind: "watermark" }
  | { kind: "headerFooter" }
  | { kind: "pageNumbers" }
  | { kind: "protect" }
  | { kind: "compress" }
  | { kind: "export" }
  | { kind: "properties" }
  | { kind: "insertPages"; at: number }
  | { kind: "split" }
  | { kind: "extract"; indices: number[] }
  | { kind: "combine" }
  | { kind: "ocr" }
  | { kind: "compare" }
  | { kind: "crop"; pageIds: string[] }
  | { kind: "save" }
  | { kind: "shortcuts" }
  | { kind: "applyRedactions" }
  | { kind: "searchRedact" }
  | { kind: "link"; pageId: string; objId: string }
  | { kind: "newBlank" }
  | { kind: "pageSize"; pageIds: string[] }
  | { kind: "flatten" }
  | { kind: "sanitize" };

export interface Toast {
  id: number;
  text: string;
  tone: "info" | "success" | "error";
}

export interface SearchHit {
  pageId: string;
  /** Rects in page space. */
  rects: { x: number; y: number; w: number; h: number }[];
  context: string;
  index: number;
}

export interface Placement {
  src: string;
  w: number;
  h: number;
  kind: "image" | "signature" | "initials";
}

export interface EditorState {
  sources: Record<string, SourceDoc>;
  fileName: string;
  doc: DocState | null;
  past: DocState[];
  future: DocState[];
  savedDoc: DocState | null;
  lastCoalesce: { key: string; at: number } | null;

  scale: number;
  fit: "width" | "page" | null;
  currentPage: number;
  nav: { index: number; top: number | null; seq: number } | null;
  group: ToolGroup;
  tool: Tool;
  style: ToolStyle;
  selection: { pageId: string; ids: string[] } | null;
  editingId: string | null;
  left: LeftPanel | null;
  rightOpen: boolean;
  dialog: DialogKind | null;
  busy: string | null;
  toasts: Toast[];
  placement: Placement | null;
  stamp: { label: string; color: string };
  author: string;
  search: { query: string; hits: SearchHit[]; active: number; caseSensitive: boolean; wholeWord: boolean; running: boolean };
  organizerSel: string[];
  darkUi: boolean;
  /** Signature field the next signature should be placed into. */
  pendingSigRect: { pageId: string; rect: { x: number; y: number; w: number; h: number } } | null;
  /** Organize mode thumbnails size. */
  gridSize: number;
  /** Phone-sized viewport: panels become overlays, tool rail moves to the bottom. */
  narrow: boolean;
  /** Distraction-free reading (no chrome, full screen). */
  readMode: boolean;
}

export const DEFAULT_STYLE: ToolStyle = {
  color: "#d92d20",
  textColor: "#000000",
  fill: null,
  strokeWidth: 2,
  opacity: 1,
  font: "Helvetica",
  size: 14,
  bold: false,
  italic: false,
  highlight: "#ffd400",
  dash: false,
};

const initial: EditorState = {
  sources: {},
  fileName: "",
  doc: null,
  past: [],
  future: [],
  savedDoc: null,
  lastCoalesce: null,
  scale: 1,
  fit: "width",
  currentPage: 0,
  nav: null,
  group: "view",
  tool: "select",
  style: DEFAULT_STYLE,
  selection: null,
  editingId: null,
  left: "pages",
  rightOpen: true,
  dialog: null,
  busy: null,
  toasts: [],
  placement: null,
  stamp: { label: "APPROVED", color: "#16803c" },
  author: "",
  search: { query: "", hits: [], active: -1, caseSensitive: false, wholeWord: false, running: false },
  organizerSel: [],
  darkUi: false,
  pendingSigRect: null,
  gridSize: 180,
  narrow: false,
  readMode: false,
};

export const useEditor = create<EditorState>(() => initial);

const get = () => useEditor.getState();
const set = useEditor.setState;

export function resetEditor(partial: Partial<EditorState>) {
  const g = get();
  const keep = { author: g.author, style: g.style, darkUi: g.darkUi, narrow: g.narrow, left: g.narrow ? null : g.left, rightOpen: g.narrow ? false : g.rightOpen };
  set({ ...initial, ...keep, ...partial });
}

/* ------------------------------ history ------------------------------ */

const MAX_HISTORY = 150;

/** Apply an undoable change. `coalesce` merges rapid edits with the same key (e.g. typing). */
export function mutate(fn: (d: DocState) => DocState, opts: { coalesce?: string } = {}) {
  const s = get();
  if (!s.doc) return;
  const next = fn(s.doc);
  if (next === s.doc) return;
  const now = Date.now();
  const merge = opts.coalesce && s.lastCoalesce && s.lastCoalesce.key === opts.coalesce && now - s.lastCoalesce.at < 1500;
  set({
    doc: next,
    past: merge ? s.past : [...s.past, s.doc].slice(-MAX_HISTORY),
    future: [],
    lastCoalesce: opts.coalesce ? { key: opts.coalesce, at: now } : null,
  });
}

/** Record a history checkpoint, then apply changes with `mutateLive` (used for drags). */
export function checkpoint() {
  const s = get();
  if (!s.doc) return;
  set({ past: [...s.past, s.doc].slice(-MAX_HISTORY), future: [], lastCoalesce: null });
}

export function mutateLive(fn: (d: DocState) => DocState) {
  const s = get();
  if (!s.doc) return;
  const next = fn(s.doc);
  if (next !== s.doc) set({ doc: next });
}

export function undo() {
  const s = get();
  if (!s.past.length || !s.doc) return;
  const prev = s.past[s.past.length - 1];
  set({ doc: prev, past: s.past.slice(0, -1), future: [s.doc, ...s.future], selection: null, editingId: null, lastCoalesce: null });
}

export function redo() {
  const s = get();
  if (!s.future.length || !s.doc) return;
  const next = s.future[0];
  set({ doc: next, future: s.future.slice(1), past: [...s.past, s.doc], selection: null, editingId: null, lastCoalesce: null });
}

/* ------------------------------ helpers ------------------------------ */

export function mapPage(d: DocState, pageId: string, fn: (p: PageModel) => PageModel): DocState {
  let changed = false;
  const pages = d.pages.map((p) => {
    if (p.id !== pageId) return p;
    const np = fn(p);
    if (np !== p) changed = true;
    return np;
  });
  return changed ? { ...d, pages } : d;
}

export function addObject(pageId: string, obj: EditObj, select = true) {
  mutate((d) => mapPage(d, pageId, (p) => ({ ...p, objects: [...p.objects, obj] })));
  if (select) set({ selection: { pageId, ids: [obj.id] } });
}

export function updateObject(pageId: string, id: string, patch: Partial<EditObj> | ((o: EditObj) => EditObj), opts: { live?: boolean; coalesce?: string } = {}) {
  const apply = (d: DocState) =>
    mapPage(d, pageId, (p) => ({
      ...p,
      objects: p.objects.map((o) =>
        o.id === id ? (typeof patch === "function" ? patch(o) : ({ ...o, ...patch, modified: Date.now() } as EditObj)) : o,
      ),
    }));
  if (opts.live) mutateLive(apply);
  else mutate(apply, { coalesce: opts.coalesce });
}

export function deleteObjects(pageId: string, ids: string[]) {
  mutate((d) => mapPage(d, pageId, (p) => ({ ...p, objects: p.objects.filter((o) => !ids.includes(o.id)) })));
  const sel = get().selection;
  if (sel && sel.pageId === pageId) set({ selection: null, editingId: null });
}

export function findObject(pageId: string, id: string): EditObj | undefined {
  return get().doc?.pages.find((p) => p.id === pageId)?.objects.find((o) => o.id === id);
}

let toastSeq = 0;
export function toast(text: string, tone: Toast["tone"] = "info", ms = 3500) {
  const id = ++toastSeq;
  set({ toasts: [...get().toasts, { id, text, tone }] });
  setTimeout(() => set({ toasts: get().toasts.filter((t) => t.id !== id) }), ms);
}

export function navigateTo(index: number, top: number | null = null) {
  set({ nav: { index, top, seq: (get().nav?.seq ?? 0) + 1 }, currentPage: index });
}

export function isDirty(s: EditorState = get()) {
  return !!s.doc && s.doc !== s.savedDoc;
}

export async function withBusy<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
  set({ busy: label });
  try {
    // let the overlay paint before heavy work starts
    await new Promise((r) => setTimeout(r, 30));
    return await fn();
  } catch (e) {
    console.error(e);
    toast(`${label.replace(/…$/, "")} failed: ${e instanceof Error ? e.message : String(e)}`, "error", 6000);
    return undefined;
  } finally {
    set({ busy: null });
  }
}
