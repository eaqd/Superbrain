"use client";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Copy, Highlighter, MessageSquareText, Strikethrough, Underline, EyeOff } from "lucide-react";
import { useEditor, addObject, toast } from "@/lib/pdf/store";
import { displaySize, displayRotation } from "@/lib/pdf/geometry";
import { displayToPlane, clamp } from "@/lib/pdf/util";
import { makeMarkup, makeRedaction } from "@/lib/pdf/create";
import type { Rect } from "@/lib/pdf/types";
import { PageView } from "./PageView";

const GAP = 14;
const PAD = 22;
export const MIN_SCALE = 0.1;
export const MAX_SCALE = 8;

/** Where the next zoom change should stay put (viewer-relative px). null = top-left. */
let pendingAnchor: { x: number; y: number } | "center" | null = null;

export function setZoom(next: number, fit: "width" | "page" | null = null) {
  if (!fit && pendingAnchor === null) pendingAnchor = "center";
  useEditor.setState({ scale: clamp(next, MIN_SCALE, MAX_SCALE), fit });
}

interface SelInfo {
  pageId: string;
  rects: Rect[];
  text: string;
  x: number;
  y: number;
}

export default function Viewer() {
  const doc = useEditor((s) => s.doc);
  const scale = useEditor((s) => s.scale);
  const fit = useEditor((s) => s.fit);
  const nav = useEditor((s) => s.nav);
  const tool = useEditor((s) => s.tool);
  const currentPage = useEditor((s) => s.currentPage);
  const ref = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState<[number, number]>([0, 4]);
  const [renderScale, setRenderScale] = useState(scale);
  const [sel, setSel] = useState<SelInfo | null>(null);
  const prevScale = useRef(scale);
  const pages = useMemo(() => doc?.pages ?? [], [doc?.pages]);

  const layout = useMemo(() => {
    let y = PAD;
    let maxW = 0;
    const items = pages.map((p) => {
      const [w, h] = displaySize(p);
      const it = { top: y, w: w * scale, h: h * scale };
      y += it.h + GAP;
      maxW = Math.max(maxW, it.w);
      return it;
    });
    return { items, height: y - GAP + PAD, maxW };
  }, [pages, scale]);

  // settle the canvas resolution after zooming stops
  useEffect(() => {
    const t = setTimeout(() => setRenderScale(scale), 160);
    return () => clearTimeout(t);
  }, [scale]);

  // ---- fit modes ----
  const applyFit = useCallback(() => {
    const el = ref.current;
    const s = useEditor.getState();
    if (!el || !s.doc || !s.fit) return;
    const cur = s.doc.pages[s.currentPage] ?? s.doc.pages[0];
    if (!cur) return;
    const widest = Math.max(...s.doc.pages.map((p) => displaySize(p)[0]));
    const [cw, ch] = displaySize(cur);
    const availW = el.clientWidth - PAD * 2 - 4;
    const availH = el.clientHeight - PAD * 2;
    let next = s.fit === "width" ? availW / widest : Math.min(availW / cw, availH / ch);
    next = clamp(next, MIN_SCALE, MAX_SCALE);
    if (Math.abs(next - s.scale) > 0.001) useEditor.setState({ scale: next });
  }, []);

  useEffect(() => {
    applyFit();
  }, [fit, pages.length, applyFit]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => applyFit());
    ro.observe(el);
    return () => ro.disconnect();
  }, [applyFit]);

  // ---- keep the zoom anchored ----
  useLayoutEffect(() => {
    const el = ref.current;
    const prev = prevScale.current;
    prevScale.current = scale;
    if (!el || prev === scale) return;
    const ratio = scale / prev;
    const anchor = pendingAnchor;
    pendingAnchor = null;
    const ax = anchor === "center" ? el.clientWidth / 2 : anchor ? anchor.x : 0;
    const ay = anchor === "center" ? el.clientHeight / 2 : anchor ? anchor.y : 0;
    el.scrollTop = (el.scrollTop + ay - PAD) * ratio + PAD - ay;
    el.scrollLeft = (el.scrollLeft + ax) * ratio - ax;
    updateRange();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scale]);

  // ---- visible range & current page ----
  const updateRange = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const top = el.scrollTop;
    const bottom = top + el.clientHeight;
    const items = layout.items;
    let first = 0;
    let lo = 0, hi = items.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (items[mid].top + items[mid].h < top) lo = mid + 1;
      else {
        first = mid;
        hi = mid - 1;
      }
    }
    let last = first;
    while (last < items.length - 1 && items[last + 1].top < bottom) last++;
    const over = 2;
    setRange((r) => {
      const n: [number, number] = [Math.max(0, first - over), Math.min(items.length - 1, last + over)];
      return r[0] === n[0] && r[1] === n[1] ? r : n;
    });
    // current page = the one covering the upper third of the viewport
    const probe = top + el.clientHeight * 0.33;
    let cur = first;
    for (let i = first; i <= last; i++) if (items[i].top <= probe) cur = i;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 2) cur = last;
    if (useEditor.getState().currentPage !== cur && !navLock.current) useEditor.setState({ currentPage: cur });
  }, [layout]);

  useEffect(() => {
    updateRange();
  }, [updateRange]);

  const navLock = useRef(false);
  useEffect(() => {
    if (!nav || !ref.current) return;
    const it = layout.items[nav.index];
    if (!it) return;
    const p = pages[nav.index];
    let offset = 0;
    if (nav.top !== null && p) {
      const rot = displayRotation(p);
      offset = rot === 0 ? nav.top * scale : rot === 180 ? (p.height - nav.top) * scale : 0;
    }
    navLock.current = true;
    ref.current.scrollTop = it.top - 10 + Math.max(0, offset - 40);
    useEditor.setState({ currentPage: nav.index });
    setTimeout(() => (navLock.current = false), 80);
    updateRange();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nav?.seq]);

  // ---- ctrl/⌘ + wheel zoom, pinch on trackpads ----
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      pendingAnchor = { x: e.clientX - r.left, y: e.clientY - r.top };
      const s = useEditor.getState().scale;
      const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025));
      setZoom(s * factor);
    };
    // two-finger pinch on touch screens
    let pinch: { d: number; s: number } | null = null;
    const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) pinch = { d: dist(e.touches), s: useEditor.getState().scale };
    };
    const onTouchMove = (e: TouchEvent) => {
      if (!pinch || e.touches.length !== 2) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      pendingAnchor = { x: (e.touches[0].clientX + e.touches[1].clientX) / 2 - r.left, y: (e.touches[0].clientY + e.touches[1].clientY) / 2 - r.top };
      setZoom(pinch.s * (dist(e.touches) / pinch.d));
    };
    const onTouchEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) pinch = null;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
    };
  }, []);

  // ---- hand tool: drag to pan ----
  const pan = useRef<{ x: number; y: number; sl: number; st: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    if ((tool === "hand" && e.button === 0) || e.button === 1) {
      const el = ref.current!;
      pan.current = { x: e.clientX, y: e.clientY, sl: el.scrollLeft, st: el.scrollTop };
      el.setPointerCapture(e.pointerId);
      e.preventDefault();
    }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!pan.current) return;
    const el = ref.current!;
    el.scrollLeft = pan.current.sl - (e.clientX - pan.current.x);
    el.scrollTop = pan.current.st - (e.clientY - pan.current.y);
  };
  const onPointerUp = () => (pan.current = null);

  // ---- text selection → markup / floating bar ----
  const collectSelection = useCallback((): SelInfo | null => {
    const selection = window.getSelection();
    const root = ref.current;
    if (!selection || selection.isCollapsed || !root || !selection.rangeCount) return null;
    const range = selection.getRangeAt(0);
    if (!root.contains(range.commonAncestorContainer)) return null;
    const text = selection.toString();
    if (!text.trim()) return null;
    const s = useEditor.getState();
    const slots = Array.from(root.querySelectorAll<HTMLElement>("[data-page-id]"));
    const rectsByPage = new Map<string, Rect[]>();
    const clientRects = Array.from(range.getClientRects()).filter((r) => r.width > 0.5 && r.height > 0.5);
    for (const cr of clientRects) {
      const cx = cr.left + cr.width / 2;
      const cy = cr.top + cr.height / 2;
      const slot = slots.find((el) => {
        const b = el.getBoundingClientRect();
        return cx >= b.left && cx <= b.right && cy >= b.top && cy <= b.bottom;
      });
      if (!slot) continue;
      const page = s.doc?.pages.find((p) => p.id === slot.dataset.pageId);
      if (!page) continue;
      const b = slot.getBoundingClientRect();
      const rot = displayRotation(page);
      const a = displayToPlane(rot, (cr.left - b.left) / s.scale, (cr.top - b.top) / s.scale, page.width, page.height);
      const c = displayToPlane(rot, (cr.right - b.left) / s.scale, (cr.bottom - b.top) / s.scale, page.width, page.height);
      const r = { x: Math.min(a[0], c[0]), y: Math.min(a[1], c[1]), w: Math.abs(c[0] - a[0]), h: Math.abs(c[1] - a[1]) };
      if (r.h > 200 || r.w > page.width * 0.98) continue; // endOfContent etc.
      const list = rectsByPage.get(page.id) ?? [];
      list.push(r);
      rectsByPage.set(page.id, list);
    }
    const first = Array.from(rectsByPage.entries())[0];
    if (!first) return null;
    const merged = mergeLineRects(first[1]);
    const last = clientRects[clientRects.length - 1];
    const rb = root.getBoundingClientRect();
    return { pageId: first[0], rects: merged, text, x: last.right - rb.left + root.scrollLeft, y: last.bottom - rb.top + root.scrollTop };
  }, []);

  const applyMarkup = useCallback((kind: "highlight" | "underline" | "strikeout" | "squiggly" | "redact", info: SelInfo) => {
    const s = useEditor.getState();
    const page = s.doc?.pages.find((p) => p.id === info.pageId);
    if (!page) return;
    const o = kind === "redact" ? makeRedaction(info.rects, page, info.text) : makeMarkup(kind, info.rects, info.text, page);
    addObject(page.id, o, false);
    window.getSelection()?.removeAllRanges();
    setSel(null);
  }, []);

  useEffect(() => {
    const onUp = () => {
      setTimeout(() => {
        const t = useEditor.getState().tool;
        const info = collectSelection();
        if (!info) {
          setSel(null);
          return;
        }
        if (t === "highlight" || t === "underline" || t === "strikeout" || t === "squiggly") applyMarkup(t, info);
        else if (t === "redact-text") applyMarkup("redact", info);
        else if (t === "select") setSel(info);
      }, 0);
    };
    document.addEventListener("mouseup", onUp);
    document.addEventListener("touchend", onUp);
    return () => {
      document.removeEventListener("mouseup", onUp);
      document.removeEventListener("touchend", onUp);
    };
  }, [collectSelection, applyMarkup]);

  if (!doc) return null;
  const width = Math.max(layout.maxW + PAD * 2, 0);
  const cursor = tool === "hand" ? (pan.current ? "grabbing" : "grab") : undefined;

  return (
    <div
      ref={ref}
      className="pdf-viewer pdf-scroll h-full w-full"
      tabIndex={-1}
      data-viewer
      style={{ cursor }}
      onScroll={() => {
        updateRange();
        if (sel) setSel(null);
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <div style={{ minWidth: width, padding: `${PAD}px ${PAD}px`, display: "flex", flexDirection: "column", alignItems: "center", gap: GAP, position: "relative" }}>
        {pages.map((p, i) => {
          const it = layout.items[i];
          if (i < range[0] || i > range[1]) return <div key={p.id} style={{ width: it.w, height: it.h, flex: "none" }} className="pdf-page-slot" data-page-placeholder />;
          return <PageView key={p.id} page={p} index={i} scale={scale} renderScale={renderScale} current={i === currentPage && pages.length > 1} />;
        })}
        {sel && tool === "select" && (
          <div className="pdf-floating-bar" style={{ left: clamp(sel.x - 100, 8, width - 220), top: sel.y + 8 }} onMouseDown={(e) => e.preventDefault()}>
            <button className="pdf-icon-btn sm" title="Highlight" onClick={() => applyMarkup("highlight", sel)}>
              <Highlighter size={15} />
            </button>
            <button className="pdf-icon-btn sm" title="Underline" onClick={() => applyMarkup("underline", sel)}>
              <Underline size={15} />
            </button>
            <button className="pdf-icon-btn sm" title="Strikethrough" onClick={() => applyMarkup("strikeout", sel)}>
              <Strikethrough size={15} />
            </button>
            <button
              className="pdf-icon-btn sm"
              title="Highlight and comment"
              onClick={() => {
                applyMarkup("highlight", sel);
                useEditor.setState({ rightOpen: true });
                setTimeout(() => {
                  const s = useEditor.getState();
                  const page = s.doc?.pages.find((pp) => pp.id === sel.pageId);
                  const last = page?.objects[page.objects.length - 1];
                  if (last) useEditor.setState({ selection: { pageId: sel.pageId, ids: [last.id] } });
                  setTimeout(() => (document.querySelector("[data-comment-editor]") as HTMLTextAreaElement | null)?.focus(), 60);
                }, 0);
              }}
            >
              <MessageSquareText size={15} />
            </button>
            <button
              className="pdf-icon-btn sm"
              title="Copy text"
              onClick={() => {
                navigator.clipboard?.writeText(sel.text).then(() => toast("Copied"));
                setSel(null);
              }}
            >
              <Copy size={15} />
            </button>
            <button className="pdf-icon-btn sm" title="Mark for redaction" onClick={() => applyMarkup("redact", sel)} style={{ color: "var(--danger)" }}>
              <EyeOff size={15} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Merge selection rects that belong to the same text line. */
function mergeLineRects(rects: Rect[]): Rect[] {
  const sorted = [...rects].sort((a, b) => a.y - b.y || a.x - b.x);
  const out: Rect[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.y + last.h / 2 - (r.y + r.h / 2)) < Math.min(last.h, r.h) * 0.5 && r.x <= last.x + last.w + Math.max(last.h, r.h) * 0.6) {
      const x1 = Math.min(last.x, r.x);
      const y1 = Math.min(last.y, r.y);
      const x2 = Math.max(last.x + last.w, r.x + r.w);
      const y2 = Math.max(last.y + last.h, r.y + r.h);
      out[out.length - 1] = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
    } else out.push({ ...r });
  }
  return out;
}

export function zoomBy(factor: number) {
  setZoom(useEditor.getState().scale * factor);
}
