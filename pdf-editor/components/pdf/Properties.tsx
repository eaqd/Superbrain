"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BringToFront, Copy, Italic, Lock, LockOpen, RotateCw, SendToBack, TextAlignCenter, TextAlignEnd, TextAlignStart, Trash, X } from "lucide-react";
import { useEditor, updateObject, deleteObjects, mutate, mapPage, type ToolStyle } from "@/lib/pdf/store";
import type { EditObj, FieldObj, FontKey, TextObj } from "@/lib/pdf/types";
import { ColorPicker, Field, NumberInput } from "./ui";
import { fitText } from "@/lib/pdf/create";
import { formatDate, moveObj, normRot, uid } from "@/lib/pdf/util";

const FONTS: FontKey[] = ["Helvetica", "Times", "Courier"];

export default function Properties() {
  const open = useEditor((s) => s.rightOpen);
  const selection = useEditor((s) => s.selection);
  const obj = useEditor((s) => (s.selection && s.selection.ids.length === 1 ? s.doc?.pages.find((p) => p.id === s.selection!.pageId)?.objects.find((o) => o.id === s.selection!.ids[0]) : undefined));
  const group = useEditor((s) => s.group);
  const narrow = useEditor((s) => s.narrow);
  if (!open || group === "organize") return null;
  return (
    <aside
      className={`pdf-scroll flex flex-none flex-col overflow-y-auto border-l ${narrow ? "absolute inset-y-0 right-0 z-40 shadow-2xl" : ""}`}
      style={{ background: "var(--panel)", borderColor: "var(--border)", width: narrow ? "min(300px, 86vw)" : 260 }}
    >
      <div className="flex items-center justify-between border-b px-3 py-2" style={{ borderColor: "var(--border)" }}>
        <span className="text-[12px] font-semibold uppercase tracking-wide" style={{ color: "var(--muted)" }}>
          {obj ? objTitle(obj) : selection && selection.ids.length > 1 ? `${selection.ids.length} objects` : "Tool settings"}
        </span>
        <button className="pdf-icon-btn sm" title="Close" onClick={() => useEditor.setState({ rightOpen: false })}>
          <X size={14} />
        </button>
      </div>
      <div className="space-y-4 p-3">
        {obj && selection ? (
          <ObjectProps o={obj} pageId={selection.pageId} />
        ) : selection && selection.ids.length > 1 ? (
          <MultiProps pageId={selection.pageId} ids={selection.ids} />
        ) : (
          <ToolProps />
        )}
      </div>
    </aside>
  );
}

function objTitle(o: EditObj) {
  const t: Record<string, string> = {
    text: o.type === "text" && o.replaces ? "Edited text" : o.layer === "annot" ? "Text box" : "Text",
    image: o.type === "image" && o.kind !== "image" ? (o.kind === "signature" ? "Signature" : "Initials") : "Image",
    rect: "Rectangle",
    ellipse: "Oval",
    line: "Line",
    arrow: "Arrow",
    ink: "Drawing",
    highlight: "Highlight",
    underline: "Underline",
    strikeout: "Strikethrough",
    squiggly: "Squiggly",
    note: "Sticky note",
    stamp: "Stamp",
    mark: "Mark",
    redact: "Redaction",
    link: "Link",
    field: "Form field",
  };
  return t[o.type] ?? o.type;
}

/* ---------------- tool defaults ---------------- */

function ToolProps() {
  const style = useEditor((s) => s.style);
  const tool = useEditor((s) => s.tool);
  const group = useEditor((s) => s.group);
  const author = useEditor((s) => s.author);
  const set = (p: Partial<ToolStyle>) => useEditor.setState({ style: { ...style, ...p } });
  const textTools = ["text", "textbox", "date", "edit-text"].includes(tool);
  const shapeTools = ["rect", "ellipse", "line", "arrow", "ink"].includes(tool);
  const markTools = ["highlight", "underline", "strikeout", "squiggly", "check", "cross", "dot"].includes(tool);
  return (
    <>
      {(textTools || shapeTools || markTools || tool === "select") && (
        <Field label={tool === "highlight" ? "Highlight colour" : "Colour"}>
          {tool === "highlight" ? (
            <ColorPicker value={style.highlight} onChange={(v) => v && set({ highlight: v })} colors={["#ffd400", "#a6e22e", "#5ad1ff", "#ff8ad8", "#ffa94d", "#c3a6ff"]} />
          ) : textTools ? (
            <ColorPicker value={style.textColor} onChange={(v) => v && set({ textColor: v })} />
          ) : (
            <ColorPicker value={style.color} onChange={(v) => v && set({ color: v })} />
          )}
        </Field>
      )}
      {(tool === "rect" || tool === "ellipse") && (
        <Field label="Fill">
          <ColorPicker value={style.fill} allowNone onChange={(v) => set({ fill: v })} />
        </Field>
      )}
      {shapeTools && (
        <>
          <Field label={`Line width · ${style.strokeWidth}pt`}>
            <input type="range" min={0.5} max={20} step={0.5} value={style.strokeWidth} onChange={(e) => set({ strokeWidth: +e.target.value })} className="w-full" />
          </Field>
          {tool !== "ink" && (
            <label className="pdf-check">
              <input type="checkbox" checked={style.dash} onChange={(e) => set({ dash: e.target.checked })} /> Dashed line
            </label>
          )}
        </>
      )}
      {(textTools || ["check", "cross", "dot"].includes(tool)) && (
        <>
          {textTools && (
            <Field label="Font">
              <FontRow font={style.font} bold={style.bold} italic={style.italic} onChange={(p) => set(p)} />
            </Field>
          )}
          <Field label="Size">
            <NumberInput value={style.size} min={4} max={200} onChange={(v) => set({ size: v })} suffix="pt" />
          </Field>
        </>
      )}
      {(shapeTools || textTools || tool === "stamp") && (
        <Field label={`Opacity · ${Math.round(style.opacity * 100)}%`}>
          <input type="range" min={0.1} max={1} step={0.05} value={style.opacity} onChange={(e) => set({ opacity: +e.target.value })} className="w-full" />
        </Field>
      )}
      <Field label="Author name" hint="Shown on comments and stamps.">
        <input className="pdf-input" value={author} placeholder="Your name" onChange={(e) => useEditor.setState({ author: e.target.value })} onKeyDown={(e) => e.stopPropagation()} />
      </Field>
      {group === "comment" && (
        <p className="text-[12px]" style={{ color: "var(--muted)" }}>
          Comments are saved as standard PDF annotations, so they stay editable in Acrobat and other readers.
        </p>
      )}
      {group === "fill" && (
        <p className="text-[12px]" style={{ color: "var(--muted)" }}>
          Click directly into the blue form fields to fill them. Use Add text anywhere else on the page.
        </p>
      )}
    </>
  );
}

function FontRow({ font, bold, italic, onChange }: { font: FontKey; bold: boolean; italic: boolean; onChange: (p: { font?: FontKey; bold?: boolean; italic?: boolean }) => void }) {
  return (
    <div className="flex gap-1.5">
      <select className="pdf-select flex-1" value={font} onChange={(e) => onChange({ font: e.target.value as FontKey })}>
        {FONTS.map((f) => (
          <option key={f} value={f}>
            {f === "Times" ? "Times (serif)" : f === "Courier" ? "Courier (mono)" : "Helvetica (sans)"}
          </option>
        ))}
      </select>
      <button className={`pdf-icon-btn ${bold ? "active" : ""}`} style={{ border: "1px solid var(--border-strong)", fontWeight: 800 }} title="Bold" onClick={() => onChange({ bold: !bold })}>
        B
      </button>
      <button className={`pdf-icon-btn ${italic ? "active" : ""}`} style={{ border: "1px solid var(--border-strong)" }} title="Italic" onClick={() => onChange({ italic: !italic })}>
        <Italic size={15} />
      </button>
    </div>
  );
}

/* ---------------- selected object ---------------- */

function ObjectProps({ o, pageId }: { o: EditObj; pageId: string }) {
  const up = (patch: Partial<EditObj>, coalesce?: string) => updateObject(pageId, o.id, patch, { coalesce });
  const upText = (patch: Partial<TextObj>) => updateObject(pageId, o.id, (prev) => fitText({ ...(prev as TextObj), ...patch, modified: Date.now() }));
  const pageIndex = useEditor((s) => s.doc?.pages.findIndex((p) => p.id === pageId) ?? 0);
  const pages = useEditor((s) => s.doc?.pages ?? []);

  return (
    <>
      {o.type === "text" && (
        <>
          <Field label="Font">
            <FontRow font={o.font} bold={o.bold} italic={o.italic} onChange={(p) => upText(p)} />
          </Field>
          <div className="flex gap-2">
            <Field label="Size">
              <NumberInput value={o.size} min={2} max={400} onChange={(v) => upText({ size: v })} suffix="pt" />
            </Field>
            <Field label="Line spacing">
              <NumberInput value={o.lineHeight} min={0.8} max={3} step={0.1} onChange={(v) => upText({ lineHeight: v })} />
            </Field>
          </div>
          <Field label="Alignment">
            <div className="pdf-seg">
              {(["left", "center", "right"] as const).map((a) => (
                <button key={a} className={o.align === a ? "active" : ""} onClick={() => upText({ align: a, autoWidth: a === "left" ? o.autoWidth : false })} title={a}>
                  {a === "left" ? <TextAlignStart size={14} /> : a === "center" ? <TextAlignCenter size={14} /> : <TextAlignEnd size={14} />}
                </button>
              ))}
            </div>
          </Field>
          <Field label="Text colour">
            <ColorPicker value={o.color} onChange={(v) => v && up({ color: v } as any)} />
          </Field>
          {!o.replaces && (
            <>
              <Field label="Background">
                <ColorPicker value={o.fill} allowNone onChange={(v) => up({ fill: v } as any)} />
              </Field>
              <Field label="Border">
                <ColorPicker value={o.border} allowNone onChange={(v) => up({ border: v } as any)} />
              </Field>
            </>
          )}
          {o.replaces && (
            <div className="rounded-md p-2 text-[12px]" style={{ background: "var(--panel-2)", color: "var(--muted)" }}>
              Replaces “{o.replaces.original.slice(0, 80)}”. The original text is removed from the page when you save.
              <Field label="Cover colour">
                <ColorPicker value={o.replaces.color} onChange={(v) => v && up({ replaces: { ...o.replaces!, color: v } } as any)} />
              </Field>
            </div>
          )}
          <label className="pdf-check">
            <input type="checkbox" checked={!o.autoWidth} onChange={(e) => upText({ autoWidth: !e.target.checked })} /> Wrap text to box width
          </label>
        </>
      )}

      {(o.type === "rect" || o.type === "ellipse") && (
        <>
          <Field label="Line colour">
            <ColorPicker value={o.stroke} allowNone onChange={(v) => up({ stroke: v } as any)} />
          </Field>
          <Field label="Fill">
            <ColorPicker value={o.fill} allowNone onChange={(v) => up({ fill: v } as any)} />
          </Field>
          <Width o={o} up={up} />
          <label className="pdf-check">
            <input type="checkbox" checked={o.dash} onChange={(e) => up({ dash: e.target.checked } as any)} /> Dashed
          </label>
        </>
      )}
      {(o.type === "line" || o.type === "arrow" || o.type === "ink") && (
        <>
          <Field label="Colour">
            <ColorPicker value={o.stroke} onChange={(v) => v && up({ stroke: v } as any)} />
          </Field>
          <Width o={o} up={up} />
          {o.type !== "ink" && (
            <div className="flex items-center gap-3">
              <label className="pdf-check">
                <input type="checkbox" checked={o.dash} onChange={(e) => up({ dash: e.target.checked } as any)} /> Dashed
              </label>
              <label className="pdf-check">
                <input type="checkbox" checked={o.type === "arrow"} onChange={(e) => up({ type: e.target.checked ? "arrow" : "line" } as any)} /> Arrow head
              </label>
            </div>
          )}
        </>
      )}
      {(o.type === "highlight" || o.type === "underline" || o.type === "strikeout" || o.type === "squiggly" || o.type === "note" || o.type === "mark") && (
        <Field label="Colour">
          <ColorPicker
            value={o.color}
            onChange={(v) => v && up({ color: v } as any)}
            colors={o.type === "highlight" || o.type === "note" ? ["#ffd400", "#a6e22e", "#5ad1ff", "#ff8ad8", "#ffa94d", "#c3a6ff", "#000000", "#d92d20"] : undefined}
          />
        </Field>
      )}
      {o.type === "note" && (
        <Field label="Note">
          <textarea data-note-editor className="pdf-textarea" rows={5} value={o.text} placeholder="Type your note…" onChange={(e) => up({ text: e.target.value } as any, `note:${o.id}`)} onKeyDown={(e) => e.stopPropagation()} />
        </Field>
      )}
      {o.type === "stamp" && (
        <>
          <Field label="Label">
            <input className="pdf-input" value={o.label} onChange={(e) => up({ label: e.target.value } as any, `stamp:${o.id}`)} onKeyDown={(e) => e.stopPropagation()} />
          </Field>
          <Field label="Second line">
            <input className="pdf-input" value={o.sub} onChange={(e) => up({ sub: e.target.value } as any, `stamp2:${o.id}`)} onKeyDown={(e) => e.stopPropagation()} />
          </Field>
          <Field label="Colour">
            <ColorPicker value={o.color} onChange={(v) => v && up({ color: v } as any)} colors={["#16803c", "#d92d20", "#1d6fe0", "#7c3aed", "#f97316", "#000000"]} />
          </Field>
        </>
      )}
      {o.type === "redact" && (
        <>
          <Field label="Box colour">
            <ColorPicker value={o.fill} onChange={(v) => v && up({ fill: v } as any)} colors={["#000000", "#ffffff", "#5f6368", "#d92d20"]} />
          </Field>
          <Field label="Overlay text" hint="Optional text printed on the redaction box (e.g. a legal exemption code).">
            <input className="pdf-input" value={o.overlayText} placeholder="e.g. (b)(6)" onChange={(e) => up({ overlayText: e.target.value } as any, `ov:${o.id}`)} onKeyDown={(e) => e.stopPropagation()} />
          </Field>
          <button className="pdf-btn primary w-full" onClick={() => useEditor.setState({ dialog: { kind: "applyRedactions" } })}>
            Apply redactions…
          </button>
        </>
      )}
      {o.type === "link" && (
        <>
          <Field label="Link to">
            <select
              className="pdf-select"
              value={o.pageId ? "page" : "url"}
              onChange={(e) => up(e.target.value === "page" ? ({ pageId: pages[0]?.id ?? null } as any) : ({ pageId: null } as any))}
            >
              <option value="url">Web address</option>
              <option value="page">Page in this document</option>
            </select>
          </Field>
          {o.pageId ? (
            <Field label="Page">
              <select className="pdf-select" value={o.pageId} onChange={(e) => up({ pageId: e.target.value } as any)}>
                {pages.map((p, i) => (
                  <option key={p.id} value={p.id}>
                    Page {i + 1}
                  </option>
                ))}
              </select>
            </Field>
          ) : (
            <Field label="URL">
              <input className="pdf-input" value={o.url} placeholder="https://" onChange={(e) => up({ url: e.target.value } as any, `url:${o.id}`)} onKeyDown={(e) => e.stopPropagation()} />
            </Field>
          )}
        </>
      )}
      {o.type === "field" && <FieldProps o={o} up={up} />}

      {o.layer === "annot" && o.type !== "note" && (
        <Field label="Comment">
          <textarea data-comment-editor className="pdf-textarea" rows={3} value={o.comment ?? ""} placeholder="Add a comment…" onChange={(e) => up({ comment: e.target.value } as any, `c:${o.id}`)} onKeyDown={(e) => e.stopPropagation()} />
        </Field>
      )}

      {o.type !== "redact" && o.type !== "field" && o.type !== "link" && (
        <Field label={`Opacity · ${Math.round(o.opacity * 100)}%`}>
          <input type="range" min={0.05} max={1} step={0.05} value={o.opacity} onChange={(e) => updateObject(pageId, o.id, { opacity: +e.target.value }, { coalesce: `op:${o.id}` })} className="w-full" />
        </Field>
      )}

      {["text", "rect", "ellipse", "ink", "line", "arrow", "stamp", "image"].includes(o.type) && (
        <Field label="Saved as" hint={o.layer === "annot" ? "A comment (annotation) others can edit or hide." : "Part of the page content."}>
          <div className="pdf-seg">
            <button className={o.layer === "content" ? "active" : ""} onClick={() => up({ layer: "content" } as any)}>
              Page content
            </button>
            <button className={o.layer === "annot" ? "active" : ""} onClick={() => up({ layer: "annot" } as any)}>
              Comment
            </button>
          </div>
        </Field>
      )}

      <div className="flex flex-wrap gap-1 border-t pt-3" style={{ borderColor: "var(--border)" }}>
        {["text", "image", "rect", "ellipse", "stamp", "mark", "field"].includes(o.type) && (
          <button className="pdf-icon-btn" title="Rotate 90°" onClick={() => updateObject(pageId, o.id, (prev) => ({ ...prev, rotate: normRot(prev.rotate + 90), x: prev.x + (prev.w - prev.h) / 2, y: prev.y + (prev.h - prev.w) / 2, w: prev.h, h: prev.w }))}>
            <RotateCw size={16} />
          </button>
        )}
        <button className="pdf-icon-btn" title="Bring to front" onClick={() => arrange(pageId, o.id, 1)}>
          <BringToFront size={16} />
        </button>
        <button className="pdf-icon-btn" title="Send to back" onClick={() => arrange(pageId, o.id, -1)}>
          <SendToBack size={16} />
        </button>
        <button className="pdf-icon-btn" title="Duplicate (Ctrl+D)" onClick={() => duplicateSelection()}>
          <Copy size={16} />
        </button>
        <button className="pdf-icon-btn" title={o.locked ? "Unlock" : "Lock position"} onClick={() => up({ locked: !o.locked } as any)}>
          {o.locked ? <Lock size={16} /> : <LockOpen size={16} />}
        </button>
        <div className="flex-1" />
        <button className="pdf-icon-btn" title="Delete (Del)" style={{ color: "var(--danger)" }} onClick={() => deleteObjects(pageId, [o.id])}>
          <Trash size={16} />
        </button>
      </div>
      <p className="text-[11px]" style={{ color: "var(--faint)" }}>
        {o.author} · page {pageIndex + 1} · {formatDate(o.modified)}
      </p>
    </>
  );
}

function Width({ o, up }: { o: EditObj & { strokeWidth: number }; up: (p: Partial<EditObj>, c?: string) => void }) {
  return (
    <Field label={`Line width · ${o.strokeWidth}pt`}>
      <input type="range" min={0.5} max={24} step={0.5} value={o.strokeWidth} onChange={(e) => up({ strokeWidth: +e.target.value } as any, `sw:${o.id}`)} className="w-full" />
    </Field>
  );
}

function FieldProps({ o, up }: { o: FieldObj; up: (p: Partial<EditObj>, c?: string) => void }) {
  const stop = (e: React.KeyboardEvent) => e.stopPropagation();
  return (
    <>
      <Field label="Field name" hint={o.fieldType === "radio" ? "Radio buttons sharing a name form one group." : "Must be unique within the form."}>
        <input className="pdf-input" value={o.name} onChange={(e) => up({ name: e.target.value } as any, `fn:${o.id}`)} onKeyDown={stop} />
      </Field>
      {o.fieldType === "radio" && (
        <Field label="Export value">
          <input className="pdf-input" value={o.exportValue} onChange={(e) => up({ exportValue: e.target.value } as any, `ev:${o.id}`)} onKeyDown={stop} />
        </Field>
      )}
      {(o.fieldType === "dropdown" || o.fieldType === "listbox") && (
        <Field label="Options (one per line)">
          <textarea className="pdf-textarea" rows={4} value={o.options.join("\n")} onChange={(e) => up({ options: e.target.value.split("\n") } as any, `opt:${o.id}`)} onKeyDown={stop} />
        </Field>
      )}
      {(o.fieldType === "text" || o.fieldType === "dropdown" || o.fieldType === "listbox" || o.fieldType === "button") && (
        <Field label={o.fieldType === "button" ? "Label" : "Default value"}>
          <input className="pdf-input" value={o.value} onChange={(e) => up({ value: e.target.value } as any, `dv:${o.id}`)} onKeyDown={stop} />
        </Field>
      )}
      {(o.fieldType === "checkbox" || o.fieldType === "radio") && (
        <label className="pdf-check">
          <input type="checkbox" checked={o.checked} onChange={(e) => up({ checked: e.target.checked } as any)} /> Checked by default
        </label>
      )}
      {o.fieldType === "text" && (
        <label className="pdf-check">
          <input type="checkbox" checked={o.multiline} onChange={(e) => up({ multiline: e.target.checked } as any)} /> Multi-line
        </label>
      )}
      <div className="flex gap-3">
        <label className="pdf-check">
          <input type="checkbox" checked={o.required} onChange={(e) => up({ required: e.target.checked } as any)} /> Required
        </label>
        <label className="pdf-check">
          <input type="checkbox" checked={o.readOnly} onChange={(e) => up({ readOnly: e.target.checked } as any)} /> Read-only
        </label>
      </div>
      {o.fieldType === "text" && (
        <Field label="Font size" hint="0 = auto">
          <NumberInput value={o.fontSize} min={0} max={72} onChange={(v) => up({ fontSize: v } as any)} suffix="pt" />
        </Field>
      )}
      <Field label="Tooltip">
        <input className="pdf-input" value={o.tooltip} onChange={(e) => up({ tooltip: e.target.value } as any, `tt:${o.id}`)} onKeyDown={stop} />
      </Field>
    </>
  );
}

function MultiProps({ pageId, ids }: { pageId: string; ids: string[] }) {
  return (
    <div className="flex gap-1">
      <button className="pdf-btn sm" onClick={() => duplicateSelection()}>
        <Copy size={14} /> Duplicate
      </button>
      <button className="pdf-btn sm" style={{ color: "var(--danger)" }} onClick={() => deleteObjects(pageId, ids)}>
        <Trash size={14} /> Delete
      </button>
    </div>
  );
}

function arrange(pageId: string, id: string, dir: 1 | -1) {
  mutate((d) =>
    mapPage(d, pageId, (p) => {
      const o = p.objects.find((x) => x.id === id);
      if (!o) return p;
      const rest = p.objects.filter((x) => x.id !== id);
      return { ...p, objects: dir === 1 ? [...rest, o] : [o, ...rest] };
    }),
  );
}

export function duplicateSelection() {
  const s = useEditor.getState();
  if (!s.selection) return;
  const { pageId, ids } = s.selection;
  const page = s.doc?.pages.find((p) => p.id === pageId);
  if (!page) return;
  const copies = page.objects.filter((o) => ids.includes(o.id)).map((o) => ({ ...moveObj(o, 12, 12), id: uid(), created: Date.now() }) as EditObj);
  mutate((d) => mapPage(d, pageId, (p) => ({ ...p, objects: [...p.objects, ...copies] })));
  useEditor.setState({ selection: { pageId, ids: copies.map((c) => c.id) } });
}
