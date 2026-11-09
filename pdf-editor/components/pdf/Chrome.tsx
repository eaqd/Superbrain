"use client";
import { useEffect, useState } from "react";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  FilePlus,
  FolderOpen,
  Keyboard,
  Moon,
  PanelLeft,
  PanelRight,
  Printer,
  Redo2,
  Save,
  Search,
  Sun,
  Undo2,
  ZoomIn,
  ZoomOut,
  Info,
  Combine,
  ImagePlus,
  X,
  FileDown,
  Minimize2,
  Lock,
} from "lucide-react";
import { useEditor, undo, redo, navigateTo, isDirty, type ToolGroup } from "@/lib/pdf/store";
import { closeDocument, printDocument, saveDocument } from "@/lib/pdf/actions";
import { GROUPS, TOOLBARS, TOOL_HINTS, type ToolItem } from "./tools";
import { Menu, MenuItem } from "./ui";
import { setZoom, zoomBy } from "./Viewer";
import { runToolAction } from "./toolActions";

export function openFilePicker(id: "pdf-open-input" | "pdf-insert-input" | "pdf-image-input") {
  document.getElementById(id)?.click();
}

export function TopBar() {
  const fileName = useEditor((s) => s.fileName);
  const canUndo = useEditor((s) => s.past.length > 0);
  const canRedo = useEditor((s) => s.future.length > 0);
  const scale = useEditor((s) => s.scale);
  const fit = useEditor((s) => s.fit);
  const page = useEditor((s) => s.currentPage);
  const total = useEditor((s) => s.doc?.pages.length ?? 0);
  const dirty = useEditor((s) => isDirty(s));
  const dark = useEditor((s) => s.darkUi);
  const left = useEditor((s) => s.left);
  const rightOpen = useEditor((s) => s.rightOpen);
  const [pageText, setPageText] = useState(String(page + 1));
  useEffect(() => setPageText(String(page + 1)), [page]);
  const [editingName, setEditingName] = useState(false);

  return (
    <header className="pdf-topbar flex h-12 flex-none items-center gap-1 overflow-hidden px-2">
      <a href="/" className="mr-1 flex items-center gap-2 rounded-md px-2 py-1 hover:bg-[var(--chrome-hover)]" title="Superbrain PDF" onClick={(e) => { e.preventDefault(); if (!dirty || confirm("Discard unsaved changes?")) closeDocument(); }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/pdf-icon.svg" alt="" width={24} height={24} />
        <span className="hidden text-[13px] font-semibold tracking-tight md:inline">Superbrain PDF</span>
      </a>
      <Menu
        trigger={(open, toggle) => (
          <button className={`flex h-8 items-center gap-1 rounded-md px-2.5 text-[13px] hover:bg-[var(--chrome-hover)] ${open ? "bg-[var(--chrome-hover)]" : ""}`} onClick={toggle}>
            File <ChevronDown size={14} />
          </button>
        )}
      >
        {(close) => (
          <>
            <MenuItem icon={<FolderOpen size={15} />} label="Open…" hint="Ctrl+O" onClick={() => (close(), openFilePicker("pdf-open-input"))} />
            <MenuItem icon={<FilePlus size={15} />} label="Insert pages from file…" onClick={() => (close(), openFilePicker("pdf-insert-input"))} />
            <MenuItem icon={<Combine size={15} />} label="Combine files…" onClick={() => (close(), useEditor.setState({ dialog: { kind: "combine" } }))} />
            <MenuItem icon={<ImagePlus size={15} />} label="New blank document…" onClick={() => (close(), useEditor.setState({ dialog: { kind: "newBlank" } }))} />
            <div className="pdf-menu-sep" />
            <MenuItem icon={<Save size={15} />} label="Save (download)" hint="Ctrl+S" onClick={() => (close(), saveDocument())} />
            <MenuItem icon={<Download size={15} />} label="Save as…" hint="Ctrl+Shift+S" onClick={() => (close(), useEditor.setState({ dialog: { kind: "save" } }))} />
            <MenuItem icon={<FileDown size={15} />} label="Export to Word, images, text…" onClick={() => (close(), useEditor.setState({ dialog: { kind: "export" } }))} />
            <MenuItem icon={<Minimize2 size={15} />} label="Compress…" onClick={() => (close(), useEditor.setState({ dialog: { kind: "compress" } }))} />
            <MenuItem icon={<Lock size={15} />} label="Protect with password…" onClick={() => (close(), useEditor.setState({ dialog: { kind: "protect" } }))} />
            <MenuItem icon={<Printer size={15} />} label="Print…" hint="Ctrl+P" onClick={() => (close(), printDocument())} />
            <div className="pdf-menu-sep" />
            <MenuItem icon={<Info size={15} />} label="Document properties…" hint="Ctrl+D" onClick={() => (close(), useEditor.setState({ dialog: { kind: "properties" } }))} />
            <MenuItem icon={<Keyboard size={15} />} label="Keyboard shortcuts" hint="?" onClick={() => (close(), useEditor.setState({ dialog: { kind: "shortcuts" } }))} />
            <div className="pdf-menu-sep" />
            <MenuItem icon={<X size={15} />} label="Close document" onClick={() => { close(); if (!dirty || confirm("Discard unsaved changes?")) closeDocument(); }} />
          </>
        )}
      </Menu>

      <div className="pdf-divider-v max-sm:!hidden" style={{ background: "#3a4152" }} />
      <button className="pdf-icon-btn" title="Undo (Ctrl+Z)" disabled={!canUndo} onClick={undo}>
        <Undo2 size={17} />
      </button>
      <button className="pdf-icon-btn max-sm:!hidden" title="Redo (Ctrl+Shift+Z)" disabled={!canRedo} onClick={redo}>
        <Redo2 size={17} />
      </button>

      <div className="mx-2 hidden min-w-0 flex-1 items-center justify-center md:flex">
        {editingName ? (
          <input
            autoFocus
            className="pdf-input h-7 text-center"
            style={{ maxWidth: 320 }}
            defaultValue={fileName}
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v) useEditor.setState({ fileName: /\.pdf$/i.test(v) ? v : `${v}.pdf` });
              setEditingName(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") setEditingName(false);
            }}
          />
        ) : (
          <button className="max-w-[420px] truncate rounded px-2 py-1 text-[13px] font-medium hover:bg-[var(--chrome-hover)]" title="Rename" onClick={() => setEditingName(true)}>
            {fileName}
            {dirty && <span className="ml-1.5 text-[var(--chrome-muted)]">• edited</span>}
          </button>
        )}
      </div>
      <div className="flex-1 md:hidden" />

      <div className="hidden items-center gap-0.5 sm:flex">
        <button className="pdf-icon-btn" title="Previous page" disabled={page <= 0} onClick={() => navigateTo(page - 1)}>
          <ChevronLeft size={17} />
        </button>
        <input
          className="pdf-input h-7 px-1 text-center"
          style={{ width: 44 }}
          value={pageText}
          aria-label="Page number"
          onChange={(e) => setPageText(e.target.value.replace(/\D/g, ""))}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              const n = parseInt(pageText, 10);
              if (n >= 1 && n <= total) navigateTo(n - 1);
              else setPageText(String(page + 1));
            }
          }}
          onBlur={() => setPageText(String(page + 1))}
        />
        <span className="px-1 text-[12px] text-[var(--chrome-muted)]">/ {total}</span>
        <button className="pdf-icon-btn" title="Next page" disabled={page >= total - 1} onClick={() => navigateTo(page + 1)}>
          <ChevronRight size={17} />
        </button>
      </div>

      <div className="pdf-divider-v hidden sm:block" style={{ background: "#3a4152" }} />
      <button className="pdf-icon-btn max-sm:!hidden" title="Zoom out (Ctrl+-)" onClick={() => zoomBy(1 / 1.2)}>
        <ZoomOut size={17} />
      </button>
      <Menu
        align="right"
        trigger={(_, toggle) => (
          <button className="h-8 min-w-[58px] rounded-md px-1.5 text-[12.5px] tabular-nums hover:bg-[var(--chrome-hover)]" onClick={toggle} title="Zoom">
            {Math.round(scale * 100)}%
          </button>
        )}
      >
        {(close) => (
          <>
            <MenuItem label="Fit width" hint="Ctrl+2" icon={fit === "width" ? "✓" : ""} onClick={() => (close(), setZoom(scale, "width"))} />
            <MenuItem label="Fit page" hint="Ctrl+0" icon={fit === "page" ? "✓" : ""} onClick={() => (close(), setZoom(scale, "page"))} />
            <div className="pdf-menu-sep" />
            {[0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4].map((z) => (
              <MenuItem key={z} label={`${z * 100}%`} hint={z === 1 ? "Ctrl+1" : undefined} icon={!fit && Math.abs(scale - z) < 0.005 ? "✓" : ""} onClick={() => (close(), setZoom(z))} />
            ))}
          </>
        )}
      </Menu>
      <button className="pdf-icon-btn max-sm:!hidden" title="Zoom in (Ctrl+=)" onClick={() => zoomBy(1.2)}>
        <ZoomIn size={17} />
      </button>
      <div className="pdf-divider-v" style={{ background: "#3a4152" }} />
      <button className="pdf-icon-btn" title="Find (Ctrl+F)" onClick={() => useEditor.setState({ left: "search" })}>
        <Search size={17} />
      </button>
      <button className={`pdf-icon-btn ${left ? "active" : ""}`} title="Toggle left panel" onClick={() => useEditor.setState({ left: left ? null : "pages" })}>
        <PanelLeft size={17} />
      </button>
      <button className={`pdf-icon-btn ${rightOpen ? "active" : ""}`} title="Toggle properties panel" onClick={() => useEditor.setState({ rightOpen: !rightOpen })}>
        <PanelRight size={17} />
      </button>
      <button className="pdf-icon-btn max-sm:!hidden" title={dark ? "Light theme" : "Dark theme"} onClick={() => useEditor.setState({ darkUi: !dark })}>
        {dark ? <Sun size={17} /> : <Moon size={17} />}
      </button>
      <button className="pdf-btn primary ml-1 h-8" onClick={() => saveDocument()} title="Save a copy (Ctrl+S)">
        <Download size={15} />
        <span className="hidden sm:inline">Save</span>
      </button>
    </header>
  );
}

export function ToolRail({ horizontal = false }: { horizontal?: boolean }) {
  const group = useEditor((s) => s.group);
  const setGroup = (g: ToolGroup) => {
    const first = TOOLBARS[g].find((t) => t.kind === "tool") as Extract<ToolItem, { kind: "tool" }> | undefined;
    useEditor.setState({ group: g, tool: g === "organize" ? "select" : first && first.tool !== "select" && g !== "edit" && g !== "fill" && g !== "form" ? first.tool : "select", selection: null, editingId: null, placement: null });
  };
  if (horizontal)
    return (
      <nav className="pdf-scroll flex h-[58px] flex-none items-stretch overflow-x-auto border-t" style={{ background: "var(--panel)", borderColor: "var(--border)" }} aria-label="Tools">
        {GROUPS.map((g) => (
          <button key={g.id} className={`pdf-rail-btn horizontal ${group === g.id ? "active" : ""}`} onClick={() => setGroup(g.id)} title={g.hint}>
            <g.icon size={19} strokeWidth={1.8} />
            <span>{g.label}</span>
          </button>
        ))}
      </nav>
    );
  return (
    <nav className="pdf-scroll flex w-[72px] flex-none flex-col items-stretch overflow-y-auto border-r py-1" style={{ background: "var(--panel)", borderColor: "var(--border)" }} aria-label="Tools">
      {GROUPS.map((g) => (
        <button key={g.id} className={`pdf-rail-btn ${group === g.id ? "active" : ""}`} onClick={() => setGroup(g.id)} title={g.hint}>
          <g.icon size={19} strokeWidth={1.8} />
          <span>{g.label}</span>
        </button>
      ))}
    </nav>
  );
}

export function ToolBar() {
  const group = useEditor((s) => s.group);
  const tool = useEditor((s) => s.tool);
  const placement = useEditor((s) => s.placement);
  const items = TOOLBARS[group];
  const hint = placement ? "Click on the page to place it. Press Esc to cancel." : TOOL_HINTS[tool];
  if (group === "organize") return null;
  return (
    <div className="flex flex-none flex-col border-b" style={{ background: "var(--panel)", borderColor: "var(--border)" }}>
      <div className="pdf-scroll flex items-center gap-0.5 overflow-x-auto px-2 py-1">
        {items.map((it, i) => {
          if (it.kind === "sep") return <div key={i} className="pdf-divider-v" />;
          if (it.kind === "tool")
            return (
              <button
                key={it.tool + i}
                className={`pdf-tool-btn ${tool === it.tool ? "active" : ""}`}
                title={`${it.label}${it.key ? ` (${it.key})` : ""}`}
                onClick={() => {
                  if (it.tool === "image") {
                    openFilePicker("pdf-image-input");
                    return;
                  }
                  if (it.tool === "signature" || it.tool === "initials") {
                    useEditor.setState({ tool: it.tool, dialog: { kind: "signature", mode: it.tool }, selection: null });
                    return;
                  }
                  if (it.tool === "stamp") useEditor.setState({ dialog: { kind: "stamp" } });
                  useEditor.setState({ tool: it.tool, selection: null, editingId: null, placement: null });
                }}
              >
                <it.icon size={18} strokeWidth={1.8} />
                <span>{it.label}</span>
              </button>
            );
          return (
            <button
              key={it.id + i}
              className={`pdf-tool-btn`}
              style={it.primary ? { color: "var(--accent)" } : undefined}
              title={it.label}
              onClick={() => runToolAction(it.id, it.dialog)}
            >
              <it.icon size={18} strokeWidth={1.8} />
              <span>{it.label}</span>
            </button>
          );
        })}
      </div>
      {hint && (
        <div className="truncate border-t px-3 py-1 text-[11.5px]" style={{ borderColor: "var(--border)", color: "var(--muted)", background: "var(--panel-2)" }}>
          {hint}
        </div>
      )}
    </div>
  );
}
