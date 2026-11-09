"use client";
import { useRef, useState } from "react";
import { ArrowLeftRight, Copy, Crop, FilePlus, FileOutput, Maximize, Plus, RotateCcw, RotateCw, Scissors, Trash, X, ZoomIn, ZoomOut, SquareDashed } from "lucide-react";
import { useEditor, navigateTo } from "@/lib/pdf/store";
import { deletePages, duplicatePages, insertBlankPage, movePages, reversePages, rotatePages } from "@/lib/pdf/actions";
import { PageThumb } from "./Thumb";
import { displaySize } from "@/lib/pdf/geometry";

export default function Organizer() {
  const pages = useEditor((s) => s.doc?.pages ?? []);
  const sel = useEditor((s) => s.organizerSel);
  const size = useEditor((s) => s.gridSize);
  const [drop, setDrop] = useState<number | null>(null);
  const anchor = useRef(0);
  const setSel = (ids: string[]) => useEditor.setState({ organizerSel: ids });
  const selIdx = pages.map((p, i) => (sel.includes(p.id) ? i : -1)).filter((i) => i >= 0);
  const target = sel.length ? sel : [];
  const insertAt = selIdx.length ? Math.max(...selIdx) + 1 : pages.length;

  const Btn = ({ icon: I, label, onClick, disabled, danger }: { icon: typeof Plus; label: string; onClick: () => void; disabled?: boolean; danger?: boolean }) => (
    <button className="pdf-tool-btn" onClick={onClick} disabled={disabled} title={label} style={danger ? { color: "var(--danger)" } : undefined}>
      <I size={18} strokeWidth={1.8} />
      <span>{label}</span>
    </button>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="pdf-scroll flex flex-none items-center gap-0.5 overflow-x-auto border-b px-2 py-1" style={{ background: "var(--panel)", borderColor: "var(--border)" }}>
        <Btn icon={Plus} label="Blank page" onClick={() => insertBlankPage(insertAt)} />
        <Btn
          icon={FilePlus}
          label="Insert file"
          onClick={() => {
            (window as unknown as { __pdfInsertAt?: number }).__pdfInsertAt = insertAt;
            document.getElementById("pdf-insert-input")?.click();
          }}
        />
        <div className="pdf-divider-v" />
        <Btn icon={RotateCcw} label="Rotate left" disabled={!target.length} onClick={() => rotatePages(target, -90)} />
        <Btn icon={RotateCw} label="Rotate right" disabled={!target.length} onClick={() => rotatePages(target, 90)} />
        <Btn icon={Copy} label="Duplicate" disabled={!target.length} onClick={() => duplicatePages(target)} />
        <Btn icon={Trash} label="Delete" danger disabled={!target.length} onClick={() => deletePages(target)} />
        <div className="pdf-divider-v" />
        <Btn icon={FileOutput} label="Extract" disabled={!target.length} onClick={() => useEditor.setState({ dialog: { kind: "extract", indices: selIdx } })} />
        <Btn icon={Scissors} label="Split" onClick={() => useEditor.setState({ dialog: { kind: "split" } })} />
        <Btn icon={Crop} label="Crop" disabled={!target.length} onClick={() => useEditor.setState({ dialog: { kind: "crop", pageIds: target } })} />
        <Btn icon={Maximize} label="Page size" disabled={!target.length} onClick={() => useEditor.setState({ dialog: { kind: "pageSize", pageIds: target } })} />
        <Btn icon={ArrowLeftRight} label="Reverse" onClick={() => reversePages()} />
        <div className="pdf-divider-v" />
        <Btn icon={SquareDashed} label={sel.length === pages.length ? "Select none" : "Select all"} onClick={() => setSel(sel.length === pages.length ? [] : pages.map((p) => p.id))} />
        <Btn icon={ZoomOut} label="Smaller" onClick={() => useEditor.setState({ gridSize: Math.max(110, size - 40) })} />
        <Btn icon={ZoomIn} label="Larger" onClick={() => useEditor.setState({ gridSize: Math.min(420, size + 40) })} />
        <div className="flex-1" />
        <button className="pdf-btn primary mr-1" onClick={() => useEditor.setState({ group: "view", tool: "select" })}>
          <X size={15} /> Close
        </button>
      </div>
      <div className="truncate border-b px-3 py-1 text-[11.5px]" style={{ borderColor: "var(--border)", color: "var(--muted)", background: "var(--panel-2)" }}>
        {sel.length ? `${sel.length} of ${pages.length} pages selected` : `${pages.length} pages`} · Drag pages to reorder · Shift/Ctrl-click to select several · Double-click to open
      </div>
      <div
        className="pdf-scroll min-h-0 flex-1 overflow-y-auto p-5"
        style={{ background: "var(--canvas)" }}
        onClick={(e) => e.target === e.currentTarget && setSel([])}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          if (e.dataTransfer.files.length) {
            e.preventDefault();
            e.stopPropagation();
            (window as unknown as { __pdfInsertAt?: number }).__pdfInsertAt = drop ?? pages.length;
            import("@/lib/pdf/actions").then((m) => m.insertFiles(Array.from(e.dataTransfer.files), drop ?? pages.length));
            setDrop(null);
          }
        }}
      >
        <div className="flex flex-wrap content-start gap-x-4 gap-y-5" onClick={(e) => e.target === e.currentTarget && setSel([])}>
          {pages.map((p, i) => (
            <div key={p.id} className="relative flex items-stretch">
              {drop === i && <div className="pdf-drop-indicator absolute -left-[9px] bottom-6 top-0 w-[3px]" />}
              <div
                className={`pdf-thumb-wrap group relative flex flex-col items-center ${sel.includes(p.id) ? "selected" : ""}`}
                style={{ width: size + 16 }}
                draggable
                onDragStart={(e) => {
                  const ids = sel.includes(p.id) ? sel : [p.id];
                  e.dataTransfer.setData("application/x-pdf-pages", JSON.stringify(ids));
                  e.dataTransfer.effectAllowed = "move";
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  setDrop(e.clientX < r.left + r.width / 2 ? i : i + 1);
                }}
                onDrop={(e) => {
                  const raw = e.dataTransfer.getData("application/x-pdf-pages");
                  if (!raw) return;
                  e.preventDefault();
                  e.stopPropagation();
                  const ids: string[] = JSON.parse(raw);
                  const t = drop ?? i;
                  const before = pages.slice(0, t).filter((x) => ids.includes(x.id)).length;
                  movePages(ids, t - before);
                  setDrop(null);
                }}
                onDragEnd={() => setDrop(null)}
                onClick={(e) => {
                  if (e.shiftKey) {
                    const [a, b] = [Math.min(anchor.current, i), Math.max(anchor.current, i)];
                    setSel(pages.slice(a, b + 1).map((x) => x.id));
                  } else if (e.metaKey || e.ctrlKey) {
                    setSel(sel.includes(p.id) ? sel.filter((x) => x !== p.id) : [...sel, p.id]);
                    anchor.current = i;
                  } else {
                    setSel([p.id]);
                    anchor.current = i;
                  }
                }}
                onDoubleClick={() => {
                  useEditor.setState({ group: "view", tool: "select" });
                  setTimeout(() => navigateTo(i), 50);
                }}
              >
                <div className="grid place-items-center" style={{ width: size, height: size * 1.3 }}>
                  {(() => {
                    const [dw, dh] = displaySize(p);
                    return <PageThumb page={p} width={dw * Math.min(size / dw, (size * 1.3) / dh)} />;
                  })()}
                </div>
                <div className="mt-1.5 text-[12px] tabular-nums" style={{ color: "var(--muted)" }}>
                  {i + 1}
                </div>
                <div className="absolute left-1/2 top-2 hidden -translate-x-1/2 gap-0.5 rounded-md p-0.5 shadow group-hover:flex" style={{ background: "var(--panel)" }}>
                  <button className="pdf-icon-btn sm" title="Rotate left" onClick={(e) => (e.stopPropagation(), rotatePages([p.id], -90))}>
                    <RotateCcw size={13} />
                  </button>
                  <button className="pdf-icon-btn sm" title="Rotate right" onClick={(e) => (e.stopPropagation(), rotatePages([p.id], 90))}>
                    <RotateCw size={13} />
                  </button>
                  <button className="pdf-icon-btn sm" title="Duplicate" onClick={(e) => (e.stopPropagation(), duplicatePages([p.id]))}>
                    <Copy size={13} />
                  </button>
                  <button className="pdf-icon-btn sm" title="Delete" onClick={(e) => (e.stopPropagation(), deletePages([p.id]))}>
                    <Trash size={13} />
                  </button>
                </div>
              </div>
              {drop === pages.length && i === pages.length - 1 && <div className="pdf-drop-indicator absolute -right-[9px] bottom-6 top-0 w-[3px]" />}
            </div>
          ))}
          <button
            className="grid place-items-center rounded-lg border-2 border-dashed text-[12px]"
            style={{ width: size + 16, height: size * 1.3 + 30, borderColor: "var(--border-strong)", color: "var(--muted)" }}
            onClick={() => insertBlankPage(pages.length)}
          >
            <span className="flex flex-col items-center gap-1">
              <Plus size={20} /> Add blank page
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
