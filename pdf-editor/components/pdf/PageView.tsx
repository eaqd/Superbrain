"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */
import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import { useEditor, mapPage, mutate, mutateLive, checkpoint, addObject, updateObject, deleteObjects, navigateTo, toast, type Tool } from "@/lib/pdf/store";
import type { EditObj, PageModel, Rect, Rot, SourceDoc, TextObj } from "@/lib/pdf/types";
import { displayRotation } from "@/lib/pdf/geometry";
import { getPage, getPageAnnotations, getPageText, loadPdfJs } from "@/lib/pdf/pdfjs";
import { deltaToPlane, displayToPlane, lineBBox, moveObj, normRect, planeTransform, resizeObj, inkBBox, rgbToHex, rgb01ToHex, uid } from "@/lib/pdf/util";
import { ObjectBody, RectsBody, Upright } from "./objects";
import { CSS_FONT, CSS_METRICS, TEXT_PAD } from "@/lib/pdf/textLayout";
import { defaultFieldSize, displayBoxToPlane, fitText, makeImage, makeInk, makeLine, makeMark, makeNote, makeShape, makeStamp, makeText, unionOf } from "@/lib/pdf/create";
import { pageRuns, type TextRun } from "@/lib/pdf/actions";
import { batesNumber, pageSelected, resolveTokens } from "@/lib/pdf/exporter";

const EMPTY: string[] = [];

export const CREATION_TOOLS: Tool[] = [
  "text",
  "textbox",
  "image",
  "rect",
  "ellipse",
  "line",
  "arrow",
  "ink",
  "whiteout",
  "link",
  "note",
  "stamp",
  "check",
  "cross",
  "dot",
  "signature",
  "initials",
  "date",
  "field-text",
  "field-checkbox",
  "field-radio",
  "field-dropdown",
  "field-listbox",
  "field-signature",
  "field-button",
  "redact-area",
  "eraser",
];
export const TEXT_TOOLS: Tool[] = ["select", "highlight", "underline", "strikeout", "squiggly", "redact-text"];
const STICKY_TOOLS: Tool[] = ["ink", "eraser", "redact-area", "highlight", "underline", "strikeout", "squiggly", "redact-text", "check", "cross", "dot"];

export interface PageGeo {
  page: PageModel;
  scale: number;
  rot: Rot;
  slot: RefObject<HTMLDivElement>;
}

/** Client point → { display (u,v), plane (x,y) } in page units. */
export function clientToPage(geo: PageGeo, clientX: number, clientY: number) {
  const r = geo.slot.current!.getBoundingClientRect();
  const u = (clientX - r.left) / geo.scale;
  const v = (clientY - r.top) / geo.scale;
  const [x, y] = displayToPlane(geo.rot, u, v, geo.page.width, geo.page.height);
  return { u, v, x, y };
}

function finishTool(e: { shiftKey: boolean }, tool: Tool) {
  if (e.shiftKey || STICKY_TOOLS.includes(tool)) return;
  useEditor.setState({ tool: "select" });
}

/* ================================================================== */

interface Props {
  page: PageModel;
  index: number;
  scale: number;
  renderScale: number;
  current: boolean;
}

export const PageView = memo(function PageView({ page, index, scale, renderScale, current }: Props) {
  const src = useEditor((s) => (page.sourceId ? s.sources[page.sourceId] : undefined));
  const tool = useEditor((s) => s.tool);
  const rot = displayRotation(page);
  const pw = page.width * scale;
  const ph = page.height * scale;
  const [dw, dh] = rot % 180 ? [ph, pw] : [pw, ph];
  const slot = useRef<HTMLDivElement>(null);
  const canvasHost = useRef<HTMLDivElement>(null);
  const textHost = useRef<HTMLDivElement>(null);
  const [annots, setAnnots] = useState<any[]>([]);
  const [view, setView] = useState<number[] | null>(null);
  const hiddenKey = page.hiddenAnnots.join(",");

  useEffect(() => {
    if (!src) return;
    let live = true;
    getPage(src.pdf, page.sourceIndex).then((pg) => live && setView(pg.view));
    getPageAnnotations(src.pdf, page.sourceIndex)
      .then((a) => live && setAnnots(a))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [src, page.sourceIndex]);

  // ---- canvas ----
  useEffect(() => {
    const host = canvasHost.current;
    if (!host || !src) return;
    let cancelled = false;
    let task: any = null;
    (async () => {
      const pg = await getPage(src.pdf, page.sourceIndex);
      const list = await getPageAnnotations(src.pdf, page.sourceIndex).catch(() => []);
      const storage = src.pdf.annotationStorage;
      const hidden = new Set(page.hiddenAnnots);
      for (const a of list) {
        if (a.annotationType === 20 || hidden.has(a.id)) storage.setValue(a.id, { noView: true });
        else if (storage.has(a.id)) storage.remove(a.id);
      }
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      let s = renderScale * dpr;
      const maxPixels = 16e6;
      if (page.width * page.height * s * s > maxPixels) s = Math.sqrt(maxPixels / (page.width * page.height));
      const vp = pg.getViewport({ scale: s, rotation: 0 });
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.floor(vp.width));
      c.height = Math.max(1, Math.floor(vp.height));
      const ctx = c.getContext("2d", { alpha: false })!;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, c.width, c.height);
      task = pg.render({ canvas: c, canvasContext: ctx, viewport: vp, annotationMode: 3 } as any);
      await task.promise;
      if (cancelled) return;
      c.setAttribute("data-scale", String(s));
      // device-pixel backing store, CSS-sized to the page plane
      c.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block";
      host.replaceChildren(c);
    })().catch((e) => {
      if (e?.name !== "RenderingCancelledException") console.warn("render failed", e);
    });
    return () => {
      cancelled = true;
      try {
        task?.cancel();
      } catch {
        /* ignore */
      }
    };
  }, [src, page.sourceIndex, renderScale, hiddenKey, page.width, page.height, page.hiddenAnnots]);

  // ---- text layer (scale-independent: sized through --total-scale-factor) ----
  useEffect(() => {
    const host = textHost.current;
    if (!host || !src) return;
    let cancelled = false;
    let layer: any = null;
    (async () => {
      const [lib, pg, text] = await Promise.all([loadPdfJs(), getPage(src.pdf, page.sourceIndex), getPageText(src.pdf, page.sourceIndex)]);
      if (cancelled) return;
      host.replaceChildren();
      layer = new lib.TextLayer({ textContentSource: text.raw, container: host, viewport: pg.getViewport({ scale: 1, rotation: 0 }) });
      await layer.render();
      if (cancelled) return;
      const end = document.createElement("div");
      end.className = "endOfContent";
      host.append(end);
    })().catch((e) => console.warn("text layer failed", e));
    return () => {
      cancelled = true;
      try {
        layer?.cancel();
      } catch {
        /* ignore */
      }
    };
  }, [src, page.sourceIndex]);

  const geo: PageGeo = useMemo(() => ({ page, scale, rot, slot }), [page, scale, rot]);
  const textEnabled = TEXT_TOOLS.includes(tool);
  const creating = CREATION_TOOLS.includes(tool);

  return (
    <div ref={slot} className={`pdf-page-slot ${current ? "current" : ""}`} data-page-id={page.id} data-page-index={index} style={{ width: dw, height: dh }}>
      <div
        className="pdf-plane"
        style={{ width: pw, height: ph, transform: planeTransform(rot, pw, ph), ["--total-scale-factor" as any]: scale } as CSSProperties}
        onPointerDown={(e) => {
          if (e.target === e.currentTarget || (e.target as HTMLElement).closest(".textLayer")) {
            if (useEditor.getState().selection) useEditor.setState({ selection: null, editingId: null });
          }
        }}
      >
        <div ref={canvasHost} className="pdf-layer" style={{ zIndex: 0 }} />
        <CoversLayer page={page} scale={scale} />
        <div
          ref={textHost}
          className={`textLayer ${textEnabled ? "" : "disabled"}`}
          onMouseDown={() => textHost.current?.classList.add("selecting")}
          onMouseUp={() => textHost.current?.classList.remove("selecting")}
        />
        <SearchLayer page={page} scale={scale} />
        {src && view && <AnnotLayer page={page} src={src} annots={annots} view={view} scale={scale} tool={tool} />}
        <ObjectLayer geo={geo} />
        {tool === "edit-text" && src && <EditTextLayer geo={geo} canvasHost={canvasHost} src={src} />}
        {creating && <InteractionLayer geo={geo} tool={tool} />}
      </div>
      <DecorPreview page={page} index={index} dw={dw} dh={dh} scale={scale} />
    </div>
  );
});

/* ================================================================== */
/* covers for "Edit text" replacements                                */

function CoversLayer({ page, scale }: { page: PageModel; scale: number }) {
  const covers = page.objects.filter((o): o is TextObj => o.type === "text" && !!o.replaces);
  if (!covers.length) return null;
  return (
    <div className="pdf-layer" style={{ zIndex: 1, pointerEvents: "none" }}>
      {covers.flatMap((o) =>
        o.replaces!.rects.map((r, i) => (
          <div key={o.id + i} style={{ position: "absolute", left: (r.x - 0.5) * scale, top: (r.y - 0.5) * scale, width: (r.w + 1) * scale, height: (r.h + 1) * scale, background: o.replaces!.color }} />
        )),
      )}
    </div>
  );
}

/* ================================================================== */
/* search hits                                                        */

function SearchLayer({ page, scale }: { page: PageModel; scale: number }) {
  const hits = useEditor((s) => s.search.hits);
  const active = useEditor((s) => s.search.active);
  const mine = useMemo(() => hits.map((h, i) => ({ h, i })).filter(({ h }) => h.pageId === page.id), [hits, page.id]);
  if (!mine.length) return null;
  return (
    <div className="pdf-layer" style={{ zIndex: 3, pointerEvents: "none" }}>
      {mine.flatMap(({ h, i }) =>
        h.rects.map((r, k) => (
          <div key={`${i}-${k}`} className={`pdf-search-hit ${i === active ? "active" : ""}`} style={{ left: r.x * scale, top: r.y * scale, width: r.w * scale, height: r.h * scale }} />
        )),
      )}
    </div>
  );
}

/* ================================================================== */
/* links + AcroForm fields of the original document                   */

function AnnotLayer({ page, src, annots, view, scale, tool }: { page: PageModel; src: SourceDoc; annots: any[]; view: number[]; scale: number; tool: Tool }) {
  const values = useEditor((s) => s.doc?.forms[src.id]);
  const hidden = useMemo(() => new Set(page.hiddenAnnots), [page.hiddenAnnots]);
  const interactive = !CREATION_TOOLS.includes(tool) && tool !== "edit-text" && tool !== "hand";
  const toRect = (r: number[]): Rect => ({ x: Math.min(r[0], r[2]) - view[0], y: view[3] - Math.max(r[1], r[3]), w: Math.abs(r[2] - r[0]), h: Math.abs(r[3] - r[1]) });

  const setValue = (name: string, v: string | boolean | string[]) =>
    mutate((d) => ({ ...d, forms: { ...d.forms, [src.id]: { ...(d.forms[src.id] ?? {}), [name]: v } } }), { coalesce: `form:${src.id}:${name}` });

  const followLink = async (a: any) => {
    if (a.url) {
      window.open(a.url, "_blank", "noopener,noreferrer");
      return;
    }
    let dest = a.dest;
    try {
      if (typeof dest === "string") dest = await src.pdf.getDestination(dest);
      if (!Array.isArray(dest)) return;
      const idx = typeof dest[0] === "number" ? dest[0] : await src.pdf.getPageIndex(dest[0]);
      const pages = useEditor.getState().doc?.pages ?? [];
      const target = pages.findIndex((p) => p.sourceId === src.id && p.sourceIndex === idx);
      if (target >= 0) {
        let top: number | null = null;
        if (dest[1]?.name === "XYZ" && typeof dest[3] === "number") {
          const pg = await getPage(src.pdf, idx);
          top = pg.view[3] - dest[3];
        }
        navigateTo(target, top);
      } else toast("That page is no longer in the document.", "info");
    } catch {
      /* ignore */
    }
  };

  const widgets = annots.filter((a) => a.annotationType === 20 && !hidden.has(a.id) && !a.hidden && a.fieldType);
  const links = annots.filter((a) => a.annotationType === 2 && !hidden.has(a.id) && (a.url || a.dest));

  return (
    <div className="pdf-layer" style={{ zIndex: 5, pointerEvents: "none" }}>
      {interactive &&
        links.map((a) => {
          const r = toRect(a.rect);
          return (
            <div
              key={a.id}
              className="pdf-link-area"
              title={a.url || "Go to page"}
              style={{ left: r.x * scale, top: r.y * scale, width: r.w * scale, height: r.h * scale, pointerEvents: tool === "select" ? "auto" : "none" }}
              onClick={() => followLink(a)}
            />
          );
        })}
      {widgets.map((a) => {
        const r = toRect(a.rect);
        const style: CSSProperties = {
          left: r.x * scale,
          top: r.y * scale,
          width: r.w * scale,
          height: r.h * scale,
          pointerEvents: interactive ? "auto" : "none",
        };
        const name: string = a.fieldName;
        const stored = values?.[name];
        const fs = a.defaultAppearanceData?.fontSize || 0;
        const autoSize = Math.max(6, Math.min(r.h * 0.7, 12));
        const fontSize = (fs > 0 ? fs : autoSize) * scale;
        const color = a.defaultAppearanceData?.fontColor ? rgb01ToHex(a.defaultAppearanceData.fontColor) : "#000";
        const cls = `pdf-form-field ${a.required ? "required" : ""}`;
        const title = a.alternativeText || name;
        if (a.fieldType === "Tx") {
          const value = typeof stored === "string" ? stored : (a.fieldValue ?? "");
          const common = {
            className: cls,
            title,
            disabled: a.readOnly,
            maxLength: a.maxLen || undefined,
            value,
            onChange: (e: any) => setValue(name, e.target.value),
            style: { ...style, fontSize, color, textAlign: (["left", "center", "right"] as const)[a.textAlignment ?? 0], letterSpacing: a.comb && a.maxLen ? `${(r.w / a.maxLen - fontSize / scale * 0.6) * scale}px` : undefined },
          };
          return a.multiLine ? <textarea key={a.id} {...common} style={{ ...common.style, resize: "none", lineHeight: 1.15 }} /> : <input key={a.id} type={a.password ? "password" : "text"} {...common} />;
        }
        if (a.fieldType === "Btn") {
          if (a.pushButton) return null;
          if (a.radioButton) {
            const cur = typeof stored === "string" ? stored : a.fieldValue;
            const checked = cur === a.buttonValue;
            return (
              <button key={a.id} className={`${cls} pdf-form-check`} title={title} disabled={a.readOnly} style={{ ...style, borderRadius: "50%" }} onClick={() => setValue(name, checked ? "Off" : a.buttonValue)}>
                {checked && <span style={{ width: "50%", height: "50%", borderRadius: "50%", background: "#000" }} />}
              </button>
            );
          }
          const cur = typeof stored === "boolean" ? stored : !!a.fieldValue && a.fieldValue !== "Off";
          return (
            <button key={a.id} className={`${cls} pdf-form-check`} title={title} disabled={a.readOnly} style={{ ...style, fontSize: Math.min(r.w, r.h) * 0.85 * scale, lineHeight: 1 }} onClick={() => setValue(name, !cur)}>
              {cur ? "✓" : ""}
            </button>
          );
        }
        if (a.fieldType === "Ch") {
          const opts: { exportValue: string; displayValue: string }[] = a.options ?? [];
          const toDisplay = (v: string) => opts.find((o) => o.exportValue === v)?.displayValue ?? v;
          const curRaw = stored !== undefined ? stored : a.fieldValue;
          const cur = (Array.isArray(curRaw) ? curRaw : curRaw ? [curRaw] : []).map((v: string) => (stored !== undefined ? v : toDisplay(v)));
          if (a.combo && !a.multiSelect) {
            return (
              <select key={a.id} className={cls} title={title} disabled={a.readOnly} value={cur[0] ?? ""} onChange={(e) => setValue(name, e.target.value)} style={{ ...style, fontSize, color }}>
                {!cur.length && <option value="" />}
                {opts.map((o, i) => (
                  <option key={i} value={o.displayValue}>
                    {o.displayValue}
                  </option>
                ))}
              </select>
            );
          }
          return (
            <select
              key={a.id}
              multiple
              className={cls}
              title={title}
              disabled={a.readOnly}
              value={cur}
              onChange={(e) => setValue(name, Array.from(e.target.selectedOptions).map((o) => o.value))}
              style={{ ...style, fontSize, color }}
            >
              {opts.map((o, i) => (
                <option key={i} value={o.displayValue}>
                  {o.displayValue}
                </option>
              ))}
            </select>
          );
        }
        if (a.fieldType === "Sig") {
          return (
            <button
              key={a.id}
              className={cls}
              title="Click to sign"
              style={{ ...style, fontSize: Math.min(11, r.h * 0.4) * scale, color: "#1d6fe0", display: "grid", placeItems: "center" }}
              onClick={() => {
                useEditor.setState({ dialog: { kind: "signature", mode: "signature" }, pendingSigRect: { pageId: page.id, rect: r } });
              }}
            >
              ✍ Sign here
            </button>
          );
        }
        return null;
      })}
    </div>
  );
}

/* ================================================================== */
/* objects: render, select, move, resize, edit                        */

function ObjectLayer({ geo }: { geo: PageGeo }) {
  const { page } = geo;
  const selected = useEditor((s) => (s.selection?.pageId === page.id ? s.selection.ids : EMPTY));
  const editingId = useEditor((s) => s.editingId);
  const tool = useEditor((s) => s.tool);
  const selectable = tool === "select" || tool === "edit-text";

  const item = (o: EditObj) => (
    <ObjectItem key={o.id} o={o} geo={geo} selectable={selectable && !(tool === "edit-text" && o.type !== "text")} selected={selected.includes(o.id)} editing={editingId === o.id} />
  );
  const highlights = page.objects.filter((o) => o.type === "highlight");
  return (
    <>
    {highlights.length > 0 && (
      // A separate layer so `multiply` blends with the rendered page underneath.
      <div className="pdf-layer" style={{ zIndex: 4, pointerEvents: "none", mixBlendMode: "multiply" }}>
        {highlights.map(item)}
      </div>
    )}
    <div className="pdf-layer" style={{ zIndex: 6, pointerEvents: "none" }}>
      {page.objects.filter((o) => o.type !== "highlight").map(item)}
      {selected.length === 1 && selectable && (() => {
        const o = page.objects.find((x) => x.id === selected[0]);
        return o && !o.locked && editingId !== o.id ? <Handles o={o} geo={geo} /> : null;
      })()}
    </div>
    </>
  );
}

function startObjectDrag(e: React.PointerEvent, geo: PageGeo, ids: string[]) {
  const { page, scale, rot } = geo;
  const sx = e.clientX;
  const sy = e.clientY;
  const originals = new Map(page.objects.filter((o) => ids.includes(o.id) && !o.locked).map((o) => [o.id, o]));
  if (!originals.size) return;
  let moved = false;
  const onMove = (ev: PointerEvent) => {
    const [dx, dy] = deltaToPlane(rot, ev.clientX - sx, ev.clientY - sy);
    if (!moved && Math.hypot(dx, dy) < 3) return;
    if (!moved) {
      checkpoint();
      moved = true;
    }
    const px = dx / scale;
    const py = dy / scale;
    mutateLive((d) => mapPage(d, page.id, (p) => ({ ...p, objects: p.objects.map((o) => (originals.has(o.id) ? moveObj(originals.get(o.id)!, px, py) : o)) })));
  };
  const onUp = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

const MARKUP = new Set(["highlight", "underline", "strikeout", "squiggly", "redact"]);

function ObjectItem({ o, geo, selectable, selected, editing }: { o: EditObj; geo: PageGeo; selectable: boolean; selected: boolean; editing: boolean }) {
  const { page, scale } = geo;
  const onPointerDown = (e: React.PointerEvent) => {
    if (!selectable || e.button !== 0) return;
    e.stopPropagation();
    const s = useEditor.getState();
    if (s.editingId && s.editingId !== o.id) useEditor.setState({ editingId: null });
    let ids = [o.id];
    if (e.shiftKey && s.selection?.pageId === page.id) {
      ids = s.selection.ids.includes(o.id) ? s.selection.ids.filter((i) => i !== o.id) : [...s.selection.ids, o.id];
    } else if (s.selection?.pageId === page.id && s.selection.ids.includes(o.id)) ids = s.selection.ids;
    useEditor.setState({ selection: ids.length ? { pageId: page.id, ids } : null });
    if (!editing && !(o.type in { highlight: 1, underline: 1, strikeout: 1, squiggly: 1 })) startObjectDrag(e, geo, ids);
  };
  const onDoubleClick = (e: React.MouseEvent) => {
    if (!selectable) return;
    e.stopPropagation();
    if (o.type === "text") useEditor.setState({ editingId: o.id, selection: { pageId: page.id, ids: [o.id] } });
    if (o.type === "link") useEditor.setState({ dialog: { kind: "link", pageId: page.id, objId: o.id } });
  };

  if (MARKUP.has(o.type)) {
    const u = o.type === "redact" && !(o as any).rects.length ? null : unionOf((o as any).rects.length ? (o as any).rects : [o]);
    return (
      <div className="pdf-layer" style={{ pointerEvents: "none" }} onPointerDown={onPointerDown} onDoubleClick={onDoubleClick} data-obj-id={o.id}>
        {o.type === "redact" && !o.rects.length ? (
          <div style={{ position: "absolute", left: o.x * scale, top: o.y * scale, width: o.w * scale, height: o.h * scale, pointerEvents: selectable ? "auto" : "none", cursor: selectable ? "move" : undefined }}>
            <RectsBody o={{ ...o, rects: [{ x: 0, y: 0, w: o.w, h: o.h }] }} s={scale} />
          </div>
        ) : (
          <RectsBody o={o as any} s={scale} interactive={selectable} />
        )}
        {selected && u && <div style={{ position: "absolute", left: u.x * scale - 2, top: u.y * scale - 2, width: u.w * scale + 4, height: u.h * scale + 4, outline: "1.5px solid var(--accent)", pointerEvents: "none" }} />}
      </div>
    );
  }

  const strokeOnly = o.type === "line" || o.type === "arrow" || o.type === "ink";
  const style: CSSProperties = {
    left: o.x * scale,
    top: o.y * scale,
    width: o.w * scale,
    height: o.h * scale,
    opacity: o.type === "text" || o.type === "image" ? o.opacity : o.opacity,
    pointerEvents: selectable && !strokeOnly ? "auto" : "none",
  };
  return (
    <div
      className={`pdf-obj ${selectable ? "selectable hoverable" : ""} ${selected ? "selected" : ""}`}
      style={style}
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      data-obj-id={o.id}
      title={o.type === "note" ? o.text || "Sticky note" : o.comment || undefined}
    >
      <ObjectBody o={o} s={scale} editing={editing} />
      {strokeOnly && selectable && <StrokeHit o={o} s={scale} />}
      {editing && o.type === "text" && <TextEditor o={o} pageId={page.id} scale={scale} />}
    </div>
  );
}

function StrokeHit({ o, s }: { o: EditObj; s: number }) {
  if (o.type === "line" || o.type === "arrow")
    return (
      <svg width={o.w * s} height={o.h * s} style={{ position: "absolute", inset: 0, overflow: "visible" }}>
        <line x1={(o.x1 - o.x) * s} y1={(o.y1 - o.y) * s} x2={(o.x2 - o.x) * s} y2={(o.y2 - o.y) * s} stroke="transparent" strokeWidth={Math.max(12, o.strokeWidth * s + 8)} style={{ pointerEvents: "stroke", cursor: "move" }} />
      </svg>
    );
  if (o.type === "ink")
    return (
      <svg width={o.w * s} height={o.h * s} style={{ position: "absolute", inset: 0, overflow: "visible" }}>
        {o.paths.map((p, i) => (
          <polyline
            key={i}
            points={Array.from({ length: p.length / 2 }, (_, k) => `${(p[k * 2] - o.x) * s},${(p[k * 2 + 1] - o.y) * s}`).join(" ")}
            fill="none"
            stroke="transparent"
            strokeWidth={Math.max(12, o.strokeWidth * s + 8)}
            style={{ pointerEvents: "stroke", cursor: "move" }}
          />
        ))}
      </svg>
    );
  return null;
}

function TextEditor({ o, pageId, scale }: { o: TextObj; pageId: string; scale: number }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const finish = () => {
    const cur = useEditor.getState().doc?.pages.find((p) => p.id === pageId)?.objects.find((x) => x.id === o.id) as TextObj | undefined;
    if (cur && !cur.text.trim() && !cur.replaces) deleteObjects(pageId, [o.id]);
    if (useEditor.getState().editingId === o.id) useEditor.setState({ editingId: null });
  };
  const L = o.size * o.lineHeight;
  return (
    <Upright o={o} s={scale}>
      <textarea
        ref={ref}
        className="pdf-textedit"
        spellCheck
        value={o.text}
        onPointerDown={(e) => e.stopPropagation()}
        onChange={(e) => {
          const text = e.target.value;
          updateObject(pageId, o.id, (prev) => fitText({ ...(prev as TextObj), text, modified: Date.now() }), { coalesce: `text:${o.id}` });
        }}
        onBlur={finish}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") (e.target as HTMLTextAreaElement).blur();
        }}
        style={{
          padding: TEXT_PAD * scale,
          fontFamily: CSS_FONT[o.font],
          fontWeight: o.bold ? 700 : 400,
          fontStyle: o.italic ? "italic" : "normal",
          fontSize: o.size * scale,
          lineHeight: `${L * scale}px`,
          color: o.color,
          textAlign: o.align,
          whiteSpace: o.autoWidth ? "pre" : "pre-wrap",
          caretColor: o.color,
          background: o.fill ?? "rgba(255,255,255,0.01)",
        }}
      />
    </Upright>
  );
}

/* ---------------- resize handles ---------------- */

type HandleId = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "p1" | "p2";

function Handles({ o, geo }: { o: EditObj; geo: PageGeo }) {
  const { scale } = geo;
  if (o.type === "note" || o.type === "highlight" || o.type === "underline" || o.type === "strikeout" || o.type === "squiggly") return null;
  if (o.type === "redact" && o.rects.length) return null;
  let handles: { id: HandleId; x: number; y: number }[];
  if (o.type === "line" || o.type === "arrow") {
    handles = [
      { id: "p1", x: o.x1, y: o.y1 },
      { id: "p2", x: o.x2, y: o.y2 },
    ];
  } else {
    const { x, y, w, h } = o;
    handles = [
      { id: "nw", x, y },
      { id: "ne", x: x + w, y },
      { id: "se", x: x + w, y: y + h },
      { id: "sw", x, y: y + h },
    ];
    if (o.type !== "mark") {
      handles.push({ id: "n", x: x + w / 2, y }, { id: "e", x: x + w, y: y + h / 2 }, { id: "s", x: x + w / 2, y: y + h }, { id: "w", x, y: y + h / 2 });
    }
  }
  return (
    <>
      {handles.map((hd) => (
        <div
          key={hd.id}
          className="pdf-handle"
          style={{ left: hd.x * scale, top: hd.y * scale, pointerEvents: "auto", cursor: hd.id.startsWith("p") ? "crosshair" : cursorFor(hd.id, geo.rot) }}
          onPointerDown={(e) => {
            e.stopPropagation();
            e.preventDefault();
            startResize(e, geo, o, hd.id);
          }}
        />
      ))}
    </>
  );
}

function cursorFor(id: HandleId, rot: Rot) {
  const order = ["n", "ne", "e", "se", "s", "sw", "w", "nw"];
  const idx = (order.indexOf(id) + rot / 45) % 8;
  return { n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize", ne: "nesw-resize", sw: "nesw-resize", nw: "nwse-resize", se: "nwse-resize" }[order[idx]] ?? "move";
}

function startResize(e: React.PointerEvent, geo: PageGeo, o: EditObj, id: HandleId) {
  const { page, scale, rot } = geo;
  const sx = e.clientX;
  const sy = e.clientY;
  let started = false;
  const keepAspect = o.type === "image" || o.type === "stamp" || o.type === "mark";
  const onMove = (ev: PointerEvent) => {
    const [dxp, dyp] = deltaToPlane(rot, ev.clientX - sx, ev.clientY - sy);
    const dx = dxp / scale;
    const dy = dyp / scale;
    if (!started) {
      checkpoint();
      started = true;
    }
    let next: EditObj;
    if (o.type === "line" || o.type === "arrow") {
      const n = { ...o, ...(id === "p1" ? { x1: o.x1 + dx, y1: o.y1 + dy } : { x2: o.x2 + dx, y2: o.y2 + dy }) };
      next = { ...n, ...lineBBox(n), modified: Date.now() };
    } else {
      let x1 = o.x, y1 = o.y, x2 = o.x + o.w, y2 = o.y + o.h;
      if (id.includes("w")) x1 += dx;
      if (id.includes("e")) x2 += dx;
      if (id.includes("n")) y1 += dy;
      if (id.includes("s")) y2 += dy;
      let r = normRect(x1, y1, x2, y2);
      const corner = id.length === 2;
      if (keepAspect !== ev.shiftKey && corner && o.w > 0 && o.h > 0) {
        const ratio = o.w / o.h;
        if (r.w / r.h > ratio) r = { ...r, w: r.h * ratio };
        else r = { ...r, h: r.w / ratio };
        if (id.includes("w")) r.x = o.x + o.w - r.w;
        if (id.includes("n")) r.y = o.y + o.h - r.h;
      }
      r.w = Math.max(4, r.w);
      r.h = Math.max(4, r.h);
      next = resizeObj(o, r);
      if (next.type === "text") next = fitText({ ...next, autoWidth: false });
      if (next.type === "ink") next = { ...next, ...inkBBox(next.paths, next.strokeWidth) };
    }
    mutateLive((d) => mapPage(d, page.id, (p) => ({ ...p, objects: p.objects.map((x) => (x.id === o.id ? next : x)) })));
  };
  const onUp = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

/* ================================================================== */
/* creation tools                                                     */

type Draft =
  | { kind: "rect"; x1: number; y1: number; x2: number; y2: number }
  | { kind: "line"; x1: number; y1: number; x2: number; y2: number }
  | { kind: "ink"; paths: number[][] };

function InteractionLayer({ geo, tool }: { geo: PageGeo; tool: Tool }) {
  const { page, scale } = geo;
  const [draft, setDraft] = useState<Draft | null>(null);
  const draftRef = useRef<Draft | null>(null);
  const toPlane = useCallback((u: number, v: number) => displayToPlane(geo.rot, u, v, page.width, page.height), [geo.rot, page.width, page.height]);

  const update = (d: Draft | null) => {
    draftRef.current = d;
    setDraft(d);
  };

  const place = (e: React.PointerEvent, pt: { u: number; v: number; x: number; y: number }) => {
    const st = useEditor.getState();
    const style = st.style;
    const box = (dw: number, dh: number, centered = true) => displayBoxToPlane(page, centered ? pt.u - dw / 2 : pt.u, centered ? pt.v - dh / 2 : pt.v, dw, dh, toPlane);
    switch (tool) {
      case "text":
      case "date": {
        const o = makeText(page, { u: pt.u, v: pt.v - style.size * 0.7 }, toPlane, tool === "date" ? { text: new Date().toLocaleDateString() } : {}, st.group === "comment" ? "annot" : "content");
        addObject(page.id, o);
        useEditor.setState({ editingId: tool === "text" ? o.id : null });
        break;
      }
      case "textbox": {
        const o = makeText(page, { u: pt.u, v: pt.v }, toPlane, { autoWidth: false, fill: "#ffffff", border: style.color, borderWidth: 1, color: "#000000" }, "annot");
        const sized = fitText({ ...o, ...displayBoxToPlane(page, pt.u, pt.v, 180, o.size * 1.2 + 4, toPlane) });
        addObject(page.id, sized);
        useEditor.setState({ editingId: sized.id });
        break;
      }
      case "note": {
        const o = makeNote(page, { x: pt.x - 11, y: pt.y - 11, w: 22, h: 22 });
        addObject(page.id, o);
        useEditor.setState({ rightOpen: true });
        setTimeout(() => (document.querySelector("[data-note-editor]") as HTMLTextAreaElement | null)?.focus(), 50);
        break;
      }
      case "stamp": {
        const stamp = st.stamp;
        const sub = `${st.author || "Guest"} • ${new Date().toLocaleDateString()}`;
        addObject(page.id, makeStamp(page, box(160, 50), stamp.label, stamp.color, stamp.label.length > 0 ? sub : ""));
        break;
      }
      case "check":
      case "cross":
      case "dot":
        addObject(page.id, makeMark(page, box(style.size, style.size), tool), false);
        break;
      case "image":
      case "signature":
      case "initials": {
        const pl = st.placement;
        if (!pl) {
          useEditor.setState({ dialog: tool === "image" ? null : { kind: "signature", mode: tool === "initials" ? "initials" : "signature" } });
          if (tool === "image") document.getElementById("pdf-image-input")?.click();
          return;
        }
        const maxW = Math.min(page.width, page.height) * 0.5;
        const k = Math.min(1, maxW / pl.w);
        addObject(page.id, makeImage(page, box(pl.w * k, pl.h * k), pl.src, pl.kind));
        useEditor.setState({ placement: null });
        break;
      }
      default:
        if (tool.startsWith("field-")) {
          const [w, h] = defaultFieldSize(tool.slice(6) as any);
          const o = makeShape(tool, page, box(w, h, false));
          if (o) addObject(page.id, o);
        }
        return;
    }
    finishTool(e, tool);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const pt = clientToPage(geo, e.clientX, e.clientY);
    if (useEditor.getState().selection) useEditor.setState({ selection: null, editingId: null });
    if (["rect", "ellipse", "whiteout", "link", "redact-area"].includes(tool) || tool.startsWith("field-")) update({ kind: "rect", x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y });
    else if (tool === "line" || tool === "arrow") update({ kind: "line", x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y });
    else if (tool === "ink") update({ kind: "ink", paths: [[pt.x, pt.y]] });
    else if (tool === "eraser") erase(pt.x, pt.y);
    else place(e, pt);
  };

  const erase = (x: number, y: number) => {
    const hit = [...page.objects].reverse().find((o) => {
      if (o.type === "ink") return o.paths.some((p) => p.some((_, i) => i % 2 === 0 && Math.hypot(p[i] - x, p[i + 1] - y) < Math.max(6, o.strokeWidth)));
      return false;
    });
    if (hit) deleteObjects(page.id, [hit.id]);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = draftRef.current;
    if (tool === "eraser" && e.buttons === 1) {
      const pt = clientToPage(geo, e.clientX, e.clientY);
      erase(pt.x, pt.y);
      return;
    }
    if (!d) return;
    const pt = clientToPage(geo, e.clientX, e.clientY);
    if (d.kind === "ink") {
      const path = d.paths[d.paths.length - 1];
      const lx = path[path.length - 2];
      const ly = path[path.length - 1];
      if (Math.hypot(pt.x - lx, pt.y - ly) * scale < 1.5) return;
      update({ kind: "ink", paths: [...d.paths.slice(0, -1), [...path, pt.x, pt.y]] });
    } else {
      let { x, y } = pt;
      if (d.kind === "line" && e.shiftKey) {
        // snap to 45°
        const ang = Math.round(Math.atan2(y - d.y1, x - d.x1) / (Math.PI / 4)) * (Math.PI / 4);
        const len = Math.hypot(x - d.x1, y - d.y1);
        x = d.x1 + Math.cos(ang) * len;
        y = d.y1 + Math.sin(ang) * len;
      }
      if (d.kind === "rect" && e.shiftKey) {
        const size = Math.max(Math.abs(x - d.x1), Math.abs(y - d.y1));
        x = d.x1 + Math.sign(x - d.x1 || 1) * size;
        y = d.y1 + Math.sign(y - d.y1 || 1) * size;
      }
      update({ ...d, x2: x, y2: y });
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const d = draftRef.current;
    update(null);
    if (!d) return;
    if (d.kind === "ink") {
      const pts = d.paths[0];
      if (pts.length >= 2) {
        // merge into the previous stroke of this session when drawing quickly (multi-stroke signatures)
        addObject(page.id, makeInk([pts.length === 2 ? [...pts, pts[0] + 0.01, pts[1]] : pts]), false);
      }
      return;
    }
    if (d.kind === "line") {
      if (Math.hypot(d.x2 - d.x1, d.y2 - d.y1) < 2) return;
      addObject(page.id, makeLine(tool as "line" | "arrow", d.x1, d.y1, d.x2, d.y2));
      finishTool(e, tool);
      return;
    }
    let r = normRect(d.x1, d.y1, d.x2, d.y2);
    if (r.w < 3 || r.h < 3) {
      if (tool.startsWith("field-")) {
        const pt = clientToPage(geo, e.clientX, e.clientY);
        const [w, h] = defaultFieldSize(tool.slice(6) as any);
        r = displayBoxToPlane(page, pt.u, pt.v, w, h, toPlane);
      } else if (tool === "rect" || tool === "ellipse") {
        r = { x: r.x - 40, y: r.y - 25, w: 80, h: 50 };
      } else return;
    }
    const o = makeShape(tool, page, r);
    if (!o) return;
    addObject(page.id, o, tool !== "redact-area");
    if (tool === "link") useEditor.setState({ dialog: { kind: "link", pageId: page.id, objId: o.id } });
    finishTool(e, tool);
  };

  const cursor = tool === "eraser" ? "cell" : ["text", "textbox", "date"].includes(tool) ? "text" : "crosshair";
  const st = useEditor.getState().style;
  return (
    <div className="pdf-layer" style={{ zIndex: 8, cursor, touchAction: "none" }} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
      {draft?.kind === "rect" && (() => {
        const r = normRect(draft.x1, draft.y1, draft.x2, draft.y2);
        const isEllipse = tool === "ellipse";
        const color = tool === "redact-area" ? "#d92d20" : tool === "whiteout" ? "#9aa1ad" : tool.startsWith("field-") || tool === "link" ? "#1d6fe0" : st.color;
        return (
          <div
            style={{
              position: "absolute",
              left: r.x * scale,
              top: r.y * scale,
              width: r.w * scale,
              height: r.h * scale,
              border: `${Math.max(1, (tool === "rect" || isEllipse ? st.strokeWidth : 1) * scale)}px ${tool === "whiteout" || tool === "link" || tool.startsWith("field-") ? "dashed" : "solid"} ${color}`,
              borderRadius: isEllipse ? "50%" : 0,
              background: tool === "whiteout" ? "#fff" : tool === "redact-area" ? "rgba(217,45,32,.15)" : (tool === "rect" || isEllipse) && st.fill ? st.fill : "transparent",
            }}
          />
        );
      })()}
      {draft?.kind === "line" && (
        <svg className="pdf-layer" style={{ overflow: "visible" }} width="100%" height="100%">
          <line x1={draft.x1 * scale} y1={draft.y1 * scale} x2={draft.x2 * scale} y2={draft.y2 * scale} stroke={st.color} strokeWidth={st.strokeWidth * scale} strokeLinecap="round" />
        </svg>
      )}
      {draft?.kind === "ink" && (
        <svg className="pdf-layer" style={{ overflow: "visible" }} width="100%" height="100%">
          {draft.paths.map((p, i) => (
            <polyline key={i} points={Array.from({ length: p.length / 2 }, (_, k) => `${p[k * 2] * scale},${p[k * 2 + 1] * scale}`).join(" ")} fill="none" stroke={st.color} strokeWidth={st.strokeWidth * scale} strokeLinecap="round" strokeLinejoin="round" opacity={st.opacity} />
          ))}
        </svg>
      )}
    </div>
  );
}

/* ================================================================== */
/* Edit existing text                                                 */

interface TextLine {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  size: number;
  baseline: number;
  fontName: string;
}

function groupLines(runs: TextRun[]): TextLine[] {
  const lines: TextLine[] = [];
  let cur: TextLine | null = null;
  for (const r of runs) {
    if (!r.horizontal || !r.str) {
      cur = null;
      continue;
    }
    if (!r.str.trim() && !cur) continue;
    const sameLine =
      cur &&
      Math.abs(cur.baseline - r.baseline) < cur.size * 0.3 &&
      Math.abs(cur.size - r.size) < cur.size * 0.2 &&
      r.x >= cur.x + cur.w - cur.size * 0.5 &&
      r.x <= cur.x + cur.w + cur.size * 1.5;
    if (sameLine && cur) {
      const gap = r.x - (cur.x + cur.w);
      const needSpace = gap > cur.size * 0.18 && !cur.text.endsWith(" ") && !r.str.startsWith(" ");
      cur.text += (needSpace ? " " : "") + r.str;
      const right = Math.max(cur.x + cur.w, r.x + r.w);
      const top = Math.min(cur.y, r.y);
      const bottom = Math.max(cur.y + cur.h, r.y + r.h);
      cur.w = right - cur.x;
      cur.y = top;
      cur.h = bottom - top;
    } else {
      cur = { text: r.str, x: r.x, y: r.y, w: r.w, h: r.h, size: r.size, baseline: r.baseline, fontName: r.fontName };
      lines.push(cur);
    }
  }
  return lines.map((l) => ({ ...l, text: l.text.replace(/\s+$/, "") })).filter((l) => l.text.trim() && l.w > 1);
}

function detectFont(fontObj: any, generic: string | undefined): { font: "Helvetica" | "Times" | "Courier"; bold: boolean; italic: boolean } {
  const name: string = fontObj?.name ?? fontObj?.loadedName ?? "";
  const n = name.replace(/^[A-Z]{6}\+/, "");
  let font: "Helvetica" | "Times" | "Courier" = "Helvetica";
  if (/courier|mono|consol|menlo|typewriter/i.test(n) || fontObj?.isMonospace || generic === "monospace") font = "Courier";
  else if (/times|serif|roman|georgia|garamond|cambria|minion|book|palatino|baskerville/i.test(n) && !/sans/i.test(n)) font = "Times";
  else if (fontObj?.isSerifFont || generic === "serif") font = "Times";
  const bold = /bold|black|heavy|semibold|demi/i.test(n) || !!fontObj?.bold || !!fontObj?.black;
  const italic = /italic|oblique/i.test(n) || !!fontObj?.italic;
  return { font, bold, italic };
}

function sampleColors(canvas: HTMLCanvasElement | null, r: Rect, pageW: number): { text: string; bg: string } {
  if (!canvas) return { text: "#000000", bg: "#ffffff" };
  const k = canvas.width / pageW;
  const x = Math.max(0, Math.floor(r.x * k));
  const y = Math.max(0, Math.floor(r.y * k));
  const w = Math.min(canvas.width - x, Math.ceil(r.w * k));
  const h = Math.min(canvas.height - y, Math.ceil(r.h * k));
  if (w <= 0 || h <= 0) return { text: "#000000", bg: "#ffffff" };
  const data = canvas.getContext("2d")!.getImageData(x, y, w, h).data;
  const counts = new Map<number, number>();
  for (let i = 0; i < data.length; i += 4) {
    const key = ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  const unpack = (k: number) => [((k >> 10) & 31) * 8 + 4, ((k >> 5) & 31) * 8 + 4, (k & 31) * 8 + 4];
  const bg = unpack(sorted[0][0]);
  const dist = (c: number[]) => Math.abs(c[0] - bg[0]) + Math.abs(c[1] - bg[1]) + Math.abs(c[2] - bg[2]);
  const inkPixels = sorted.filter(([key]) => dist(unpack(key)) > 90).reduce((n, [, c]) => n + c, 0);
  // The ink colour is the most contrasting colour that is not just anti-aliasing noise.
  let far: [number, number] | undefined;
  for (const entry of sorted) {
    const c = unpack(entry[0]);
    if (dist(c) <= 90 || entry[1] < Math.max(2, inkPixels * 0.04)) continue;
    if (!far || dist(c) > dist(unpack(far[0]))) far = entry;
  }
  // the darkest strongly-represented colour is the ink
  const ink = far ? unpack(far[0]) : [0, 0, 0];
  const snap = (c: number[]) => c.map((v) => (v < 24 ? 0 : v > 236 ? 255 : v));
  const [tr, tg, tb] = snap(ink);
  const [br, bgc, bb] = snap(bg);
  return { text: rgbToHex(tr, tg, tb), bg: rgbToHex(br, bgc, bb) };
}

function EditTextLayer({ geo, canvasHost, src }: { geo: PageGeo; canvasHost: RefObject<HTMLDivElement>; src: SourceDoc }) {
  const { page, scale } = geo;
  const [lines, setLines] = useState<TextLine[]>([]);
  useEffect(() => {
    let live = true;
    pageRuns(page).then((r) => live && r && setLines(groupLines(r.runs)));
    return () => {
      live = false;
    };
  }, [page.sourceId, page.sourceIndex]); // eslint-disable-line react-hooks/exhaustive-deps

  const replaced = page.objects.flatMap((o) => (o.type === "text" && o.replaces ? o.replaces.rects : []));
  const visible = lines.filter((l) => !replaced.some((r) => Math.abs(r.x - (l.x - 1)) < 0.5 && Math.abs(r.y - (l.y - 1)) < 0.5));

  const edit = async (l: TextLine) => {
    const pg = await getPage(src.pdf, page.sourceIndex);
    const text = await getPageText(src.pdf, page.sourceIndex);
    let fontObj: any = null;
    try {
      if ((pg as any).commonObjs.has(l.fontName)) fontObj = (pg as any).commonObjs.get(l.fontName);
    } catch {
      /* not loaded */
    }
    const f = detectFont(fontObj, text.styles[l.fontName]?.fontFamily);
    const rect = { x: l.x - 1, y: l.y - 1, w: l.w + 2, h: l.h + 2 };
    const colors = sampleColors(canvasHost.current?.querySelector("canvas") ?? null, rect, page.width);
    const size = Math.round(l.size * 10) / 10;
    const m = CSS_METRICS[f.font];
    const L = size * 1.2;
    const baselineFromTop = TEXT_PAD + (L - (m.ascent + m.descent) * size) / 2 + m.ascent * size;
    const now = Date.now();
    const st = useEditor.getState();
    const o: TextObj = fitText({
      id: uid(),
      type: "text",
      x: l.x - TEXT_PAD,
      y: l.baseline - baselineFromTop,
      w: l.w + TEXT_PAD * 2,
      h: L + TEXT_PAD * 2,
      rotate: 0,
      opacity: 1,
      layer: "content",
      author: st.author || "Guest",
      created: now,
      modified: now,
      text: l.text,
      font: f.font,
      bold: f.bold,
      italic: f.italic,
      size,
      color: colors.text,
      align: "left",
      lineHeight: 1.2,
      fill: null,
      border: null,
      borderWidth: 1,
      autoWidth: true,
      replaces: { rects: [rect], color: colors.bg, original: l.text },
    });
    addObject(page.id, o);
    useEditor.setState({ editingId: o.id });
  };

  return (
    <div className="pdf-layer" style={{ zIndex: 7, pointerEvents: "none" }}>
      {visible.map((l, i) => (
        <div
          key={i}
          className="pdf-editable-run"
          title="Click to edit this text"
          style={{ left: (l.x - 1) * scale, top: (l.y - 1) * scale, width: (l.w + 2) * scale, height: (l.h + 2) * scale, pointerEvents: "auto" }}
          onPointerDown={(e) => {
            e.stopPropagation();
            e.preventDefault();
            edit(l);
          }}
        />
      ))}
    </div>
  );
}

/* ================================================================== */
/* watermark / header-footer preview                                  */

function DecorPreview({ index, dw, dh, scale }: { page: PageModel; index: number; dw: number; dh: number; scale: number }) {
  const decor = useEditor((s) => s.doc?.decor);
  const total = useEditor((s) => s.doc?.pages.length ?? 0);
  const meta = useEditor((s) => s.doc?.meta.title ?? "");
  const fileName = useEditor((s) => s.fileName);
  if (!decor || (!decor.watermark && !decor.headerFooter)) return null;
  const wm = decor.watermark;
  const hf = decor.headerFooter;
  return (
    <div className="pdf-layer" style={{ zIndex: 9, pointerEvents: "none", overflow: "hidden" }}>
      {wm && pageSelected(wm.pages, index, total) && (
        <div
          style={{
            position: "absolute",
            left: dw / 2,
            top: wm.position === "top" ? dh * 0.18 : wm.position === "bottom" ? dh * 0.82 : dh / 2,
            transform: `translate(-50%, -50%) rotate(${-wm.rotation}deg)`,
            opacity: wm.opacity,
            whiteSpace: "pre",
            textAlign: "center",
            color: wm.color,
            fontFamily: CSS_FONT[wm.font],
            fontWeight: wm.bold ? 700 : 400,
            fontSize: wm.size * scale,
            lineHeight: 1.15,
            mixBlendMode: wm.layer === "under" ? "multiply" : undefined,
          }}
        >
          {wm.kind === "image" && wm.imageSrc ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={wm.imageSrc} alt="" style={{ width: dw * wm.imageScale, display: "block" }} />
          ) : (
            wm.text
          )}
        </div>
      )}
      {hf &&
        pageSelected(hf.pages, index, total) &&
        (["hl", "hc", "hr", "fl", "fc", "fr"] as const).map((k) => {
          const tpl = hf[k];
          if (!tpl.trim()) return null;
          const txt = resolveTokens(tpl, { page: hf.startNumber + index, pages: total + hf.startNumber - 1, bates: batesNumber(hf, index), fileName, title: meta });
          const align = k[1] === "l" ? "left" : k[1] === "c" ? "center" : "right";
          const st: CSSProperties = {
            position: "absolute",
            left: hf.marginX * scale,
            right: hf.marginX * scale,
            textAlign: align,
            fontFamily: CSS_FONT[hf.font],
            fontSize: hf.size * scale,
            color: hf.color,
            whiteSpace: "pre",
            lineHeight: 1,
          };
          if (k[0] === "h") st.top = hf.marginY * scale;
          else st.bottom = hf.marginY * scale;
          return (
            <div key={k} style={st}>
              {txt}
            </div>
          );
        })}
    </div>
  );
}

export { makeShape };
