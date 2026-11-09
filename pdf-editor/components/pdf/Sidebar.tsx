"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bookmark,
  ChevronDown,
  ChevronRight,
  Files,
  MessageSquare,
  Plus,
  RotateCw,
  Search,
  Trash,
  X,
  ArrowUp,
  ArrowDown,
  CaseSensitive,
  WholeWord,
  Paperclip,
  Download,
} from "lucide-react";
import { useEditor, navigateTo, mutate, mapPage, deleteObjects } from "@/lib/pdf/store";
import { deletePages, goToHit, movePages, rotatePages, runSearch, insertFiles } from "@/lib/pdf/actions";
import { getPageAnnotations } from "@/lib/pdf/pdfjs";
import type { EditObj, OutlineItem, PageModel } from "@/lib/pdf/types";
import { downloadBlob, formatBytes, formatDate, uid } from "@/lib/pdf/util";
import { PageThumb } from "./Thumb";
import type { LeftPanel } from "@/lib/pdf/store";

const TABS: { id: LeftPanel; label: string; icon: typeof Files }[] = [
  { id: "pages", label: "Pages", icon: Files },
  { id: "outline", label: "Bookmarks", icon: Bookmark },
  { id: "comments", label: "Comments", icon: MessageSquare },
  { id: "search", label: "Search", icon: Search },
  { id: "attachments", label: "Attachments", icon: Paperclip },
];

export default function Sidebar() {
  const left = useEditor((s) => s.left);
  const narrow = useEditor((s) => s.narrow);
  if (!left) return null;
  return (
    <aside
      className={`flex flex-none flex-col border-r ${narrow ? "absolute inset-y-0 left-0 z-40 shadow-2xl" : ""}`}
      style={{ background: "var(--panel)", borderColor: "var(--border)", width: narrow ? "min(300px, 86vw)" : 244 }}
    >
      <div className="flex flex-none items-center gap-0.5 border-b px-1.5 py-1" style={{ borderColor: "var(--border)" }}>
        {TABS.map((t) => (
          <button key={t.id} className={`pdf-icon-btn ${left === t.id ? "active" : ""}`} title={t.label} onClick={() => useEditor.setState({ left: t.id })}>
            <t.icon size={16} />
          </button>
        ))}
        <div className="flex-1" />
        <button className="pdf-icon-btn sm" title="Close panel" onClick={() => useEditor.setState({ left: null })}>
          <X size={15} />
        </button>
      </div>
      <div className="min-h-0 flex-1">
        {left === "pages" && <PagesPanel />}
        {left === "outline" && <OutlinePanel />}
        {left === "comments" && <CommentsPanel />}
        {left === "search" && <SearchPanel />}
        {left === "attachments" && <AttachmentsPanel />}
      </div>
    </aside>
  );
}

/* ---------------------------------------------------------------- */

function PagesPanel() {
  const pages = useEditor((s) => s.doc?.pages ?? []);
  const current = useEditor((s) => s.currentPage);
  const sel = useEditor((s) => s.organizerSel);
  const [drop, setDrop] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const anchor = useRef<number>(0);

  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-thumb-index="${current}"]`) as HTMLElement | null;
    el?.scrollIntoView({ block: "nearest" });
  }, [current]);

  const click = (e: React.MouseEvent, i: number, p: PageModel) => {
    if (e.shiftKey) {
      const [a, b] = [Math.min(anchor.current, i), Math.max(anchor.current, i)];
      useEditor.setState({ organizerSel: pages.slice(a, b + 1).map((x) => x.id) });
    } else if (e.metaKey || e.ctrlKey) {
      useEditor.setState({ organizerSel: sel.includes(p.id) ? sel.filter((x) => x !== p.id) : [...sel, p.id] });
      anchor.current = i;
    } else {
      useEditor.setState({ organizerSel: [] });
      anchor.current = i;
      navigateTo(i);
      if (useEditor.getState().narrow) useEditor.setState({ left: null });
    }
  };

  return (
    <div
      ref={listRef}
      className="pdf-scroll h-full overflow-y-auto px-3 py-2"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDrop(pages.length);
        }
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        e.stopPropagation();
        insertFiles(Array.from(e.dataTransfer.files), drop ?? pages.length);
        setDrop(null);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDrop(null);
      }}
    >
      {sel.length > 1 && (
        <div className="mb-2 flex items-center justify-between rounded-md px-2 py-1 text-[12px]" style={{ background: "var(--accent-soft)", color: "var(--accent)" }}>
          {sel.length} pages selected
          <div className="flex">
            <button className="pdf-icon-btn sm" title="Rotate" onClick={() => rotatePages(sel, 90)}>
              <RotateCw size={14} />
            </button>
            <button className="pdf-icon-btn sm" title="Delete" onClick={() => deletePages(sel)}>
              <Trash size={14} />
            </button>
          </div>
        </div>
      )}
      {pages.map((p, i) => (
        <div key={p.id} data-thumb-index={i}>
          {drop === i && <div className="pdf-drop-indicator mx-2 my-1 h-[3px]" />}
          <div
            className={`pdf-thumb-wrap group relative mb-1 flex flex-col items-center ${i === current ? "current" : ""} ${sel.includes(p.id) ? "selected" : ""}`}
            draggable
            onDragStart={(e) => {
              const ids = sel.includes(p.id) ? sel : [p.id];
              e.dataTransfer.setData("application/x-pdf-pages", JSON.stringify(ids));
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(e) => {
              e.preventDefault();
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              setDrop(e.clientY < r.top + r.height / 2 ? i : i + 1);
            }}
            onDrop={(e) => {
              const raw = e.dataTransfer.getData("application/x-pdf-pages");
              if (!raw) return;
              e.preventDefault();
              e.stopPropagation();
              const ids: string[] = JSON.parse(raw);
              const target = drop ?? i;
              const before = pages.slice(0, target).filter((x) => ids.includes(x.id)).length;
              movePages(ids, target - before);
              setDrop(null);
            }}
            onDragEnd={() => setDrop(null)}
            onClick={(e) => click(e, i, p)}
          >
            <PageThumb page={p} width={168} />
            <div className="mt-1 text-[11.5px] tabular-nums" style={{ color: "var(--muted)" }}>
              {i + 1}
            </div>
            <div className="absolute right-2 top-2 hidden gap-0.5 rounded-md p-0.5 shadow group-hover:flex" style={{ background: "var(--panel)" }}>
              <button
                className="pdf-icon-btn sm"
                title="Rotate clockwise"
                onClick={(e) => {
                  e.stopPropagation();
                  rotatePages([p.id], 90);
                }}
              >
                <RotateCw size={13} />
              </button>
              <button
                className="pdf-icon-btn sm"
                title="Delete page"
                onClick={(e) => {
                  e.stopPropagation();
                  deletePages([p.id]);
                }}
              >
                <Trash size={13} />
              </button>
            </div>
          </div>
        </div>
      ))}
      {drop === pages.length && <div className="pdf-drop-indicator mx-2 my-1 h-[3px]" />}
    </div>
  );
}

/* ---------------------------------------------------------------- */

function updateOutline(fn: (items: OutlineItem[]) => OutlineItem[]) {
  mutate((d) => ({ ...d, outline: fn(d.outline ?? []), outlineEdited: true }));
}

function mapTree(items: OutlineItem[], fn: (it: OutlineItem) => OutlineItem | null): OutlineItem[] {
  const out: OutlineItem[] = [];
  for (const it of items) {
    const r = fn(it);
    if (r) out.push({ ...r, children: mapTree(r.children, fn) });
  }
  return out;
}

function moveInTree(items: OutlineItem[], id: string, dir: -1 | 1): OutlineItem[] {
  const i = items.findIndex((x) => x.id === id);
  if (i >= 0) {
    const j = i + dir;
    if (j < 0 || j >= items.length) return items;
    const next = [...items];
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  }
  return items.map((x) => ({ ...x, children: moveInTree(x.children, id, dir) }));
}

function OutlinePanel() {
  const outline = useEditor((s) => s.doc?.outline ?? []);
  const pages = useEditor((s) => s.doc?.pages ?? []);
  const current = useEditor((s) => s.currentPage);
  const [editing, setEditing] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(null);

  const add = () => {
    const page = pages[current];
    const it: OutlineItem = { id: uid("b"), title: `Page ${current + 1}`, pageId: page?.id ?? null, top: null, children: [], open: true };
    updateOutline((items) => {
      if (!active) return [...items, it];
      // add after the active bookmark at the same level
      const insert = (list: OutlineItem[]): OutlineItem[] | null => {
        const i = list.findIndex((x) => x.id === active);
        if (i >= 0) return [...list.slice(0, i + 1), it, ...list.slice(i + 1)];
        for (let k = 0; k < list.length; k++) {
          const sub = insert(list[k].children);
          if (sub) return list.map((x, j) => (j === k ? { ...x, children: sub } : x));
        }
        return null;
      };
      return insert(items) ?? [...items, it];
    });
    setEditing(it.id);
    setActive(it.id);
  };

  const Item = ({ it, depth }: { it: OutlineItem; depth: number }) => {
    const idx = pages.findIndex((p) => p.id === it.pageId);
    return (
      <div>
        <div
          className="group flex cursor-pointer items-center gap-1 rounded-md py-1 pr-1 hover:bg-[var(--hover)]"
          style={{ paddingLeft: 4 + depth * 14, background: active === it.id ? "var(--accent-soft)" : undefined }}
          onClick={() => {
            setActive(it.id);
            if (idx >= 0) navigateTo(idx, it.top);
          }}
          onDoubleClick={() => setEditing(it.id)}
        >
          <button
            className="grid h-4 w-4 flex-none place-items-center"
            style={{ visibility: it.children.length ? "visible" : "hidden" }}
            onClick={(e) => {
              e.stopPropagation();
              updateOutline((items) => mapTree(items, (x) => (x.id === it.id ? { ...x, open: !x.open } : x)));
            }}
          >
            {it.open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </button>
          {editing === it.id ? (
            <input
              autoFocus
              className="pdf-input h-6 flex-1 px-1 text-[12.5px]"
              defaultValue={it.title}
              onFocus={(e) => e.target.select()}
              onClick={(e) => e.stopPropagation()}
              onBlur={(e) => {
                const v = e.target.value;
                updateOutline((items) => mapTree(items, (x) => (x.id === it.id ? { ...x, title: v } : x)));
                setEditing(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                if (e.key === "Escape") setEditing(null);
                e.stopPropagation();
              }}
            />
          ) : (
            <span className="min-w-0 flex-1 truncate text-[12.5px]" style={{ color: idx < 0 ? "var(--faint)" : undefined }}>
              {it.title || "Untitled"}
            </span>
          )}
          <div className="hidden flex-none group-hover:flex">
            <button className="pdf-icon-btn sm" title="Move up" onClick={(e) => (e.stopPropagation(), updateOutline((items) => moveInTree(items, it.id, -1)))}>
              <ArrowUp size={12} />
            </button>
            <button className="pdf-icon-btn sm" title="Move down" onClick={(e) => (e.stopPropagation(), updateOutline((items) => moveInTree(items, it.id, 1)))}>
              <ArrowDown size={12} />
            </button>
            <button className="pdf-icon-btn sm" title="Delete bookmark" onClick={(e) => (e.stopPropagation(), updateOutline((items) => mapTree(items, (x) => (x.id === it.id ? null : x))))}>
              <Trash size={12} />
            </button>
          </div>
        </div>
        {it.open && it.children.map((c) => <Item key={c.id} it={c} depth={depth + 1} />)}
      </div>
    );
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-none items-center justify-between px-3 py-2">
        <span className="text-[12px] font-semibold" style={{ color: "var(--muted)" }}>
          Bookmarks
        </span>
        <button className="pdf-btn sm" onClick={add} title="Bookmark the current page">
          <Plus size={14} /> Add
        </button>
      </div>
      <div className="pdf-scroll min-h-0 flex-1 overflow-y-auto px-1.5 pb-3">
        {outline.length ? outline.map((it) => <Item key={it.id} it={it} depth={0} />) : <Empty text="No bookmarks yet. Add one to jump back to the current page." />}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- */

const TYPE_LABEL: Record<string, string> = {
  highlight: "Highlight",
  underline: "Underline",
  strikeout: "Strikethrough",
  squiggly: "Squiggly",
  note: "Sticky note",
  text: "Text",
  rect: "Rectangle",
  ellipse: "Oval",
  line: "Line",
  arrow: "Arrow",
  ink: "Drawing",
  stamp: "Stamp",
  redact: "Redaction",
  image: "Image",
  mark: "Mark",
  link: "Link",
  field: "Form field",
};

function CommentsPanel() {
  const pages = useEditor((s) => s.doc?.pages ?? []);
  const sources = useEditor((s) => s.sources);
  const selection = useEditor((s) => s.selection);
  const [existing, setExisting] = useState<{ page: PageModel; index: number; a: any }[]>([]);

  const items = useMemo(
    () => pages.flatMap((p, i) => p.objects.filter((o) => o.layer === "annot" || o.type === "redact").map((o) => ({ page: p, index: i, o }))),
    [pages],
  );

  useEffect(() => {
    let live = true;
    (async () => {
      const out: { page: PageModel; index: number; a: any }[] = [];
      for (let i = 0; i < pages.length && i < 500; i++) {
        const p = pages[i];
        const src = p.sourceId ? sources[p.sourceId] : null;
        if (!src) continue;
        const annots = await getPageAnnotations(src.pdf, p.sourceIndex).catch(() => []);
        for (const a of annots) {
          if ([1, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15].includes(a.annotationType) && !p.hiddenAnnots.includes(a.id) && a.annotationType !== 16) out.push({ page: p, index: i, a });
        }
      }
      if (live) setExisting(out);
    })();
    return () => {
      live = false;
    };
  }, [pages, sources]);

  const total = items.length + existing.length;
  return (
    <div className="flex h-full flex-col">
      <div className="flex-none px-3 py-2 text-[12px] font-semibold" style={{ color: "var(--muted)" }}>
        {total} comment{total === 1 ? "" : "s"}
      </div>
      <div className="pdf-scroll min-h-0 flex-1 space-y-1.5 overflow-y-auto px-2 pb-3">
        {!total && <Empty text="No comments yet. Use the Comment tools to highlight, add notes or draw." />}
        {items.map(({ page, index, o }) => (
          <CommentCard key={o.id} o={o} page={page} index={index} selected={selection?.ids.includes(o.id) ?? false} />
        ))}
        {existing.length > 0 && (
          <div className="px-1 pt-2 text-[11px] font-semibold uppercase tracking-wide" style={{ color: "var(--faint)" }}>
            In the original file
          </div>
        )}
        {existing.map(({ page, index, a }) => (
          <div key={page.id + a.id} className="rounded-lg border p-2" style={{ borderColor: "var(--border)" }}>
            <div className="flex items-center gap-2 text-[11.5px]" style={{ color: "var(--muted)" }}>
              <span className="font-semibold" style={{ color: "var(--text)" }}>
                {a.subtype}
              </span>
              <span>p. {index + 1}</span>
              <span className="flex-1 truncate">{a.titleObj?.str}</span>
              <button
                className="pdf-icon-btn sm"
                title="Delete annotation"
                onClick={() => mutate((d) => mapPage(d, page.id, (p) => ({ ...p, hiddenAnnots: [...p.hiddenAnnots, a.id] })))}
              >
                <Trash size={12} />
              </button>
            </div>
            {a.contentsObj?.str && (
              <button className="mt-1 block w-full text-left text-[12.5px]" onClick={() => navigateTo(index)}>
                {a.contentsObj.str}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function CommentCard({ o, page, index, selected }: { o: EditObj; page: PageModel; index: number; selected: boolean }) {
  const text = o.type === "note" ? o.text : o.comment ?? "";
  const quote = o.type === "highlight" || o.type === "underline" || o.type === "strikeout" || o.type === "squiggly" ? o.text : o.type === "text" ? o.text : o.type === "stamp" ? o.label : "";
  const color = "color" in o ? (o as any).color : "stroke" in o ? (o as any).stroke : "#888";
  return (
    <div
      className="cursor-pointer rounded-lg border p-2"
      style={{ borderColor: selected ? "var(--accent)" : "var(--border)", background: selected ? "var(--accent-soft)" : undefined }}
      onClick={() => {
        navigateTo(index, Math.max(0, o.y - 60));
        useEditor.setState({ selection: { pageId: page.id, ids: [o.id] }, rightOpen: true });
      }}
    >
      <div className="flex items-center gap-2 text-[11.5px]" style={{ color: "var(--muted)" }}>
        <span className="h-2.5 w-2.5 flex-none rounded-full" style={{ background: color ?? "#888" }} />
        <span className="font-semibold" style={{ color: "var(--text)" }}>
          {TYPE_LABEL[o.type]}
        </span>
        <span>p. {index + 1}</span>
        <span className="flex-1" />
        <button
          className="pdf-icon-btn sm"
          title="Delete"
          onClick={(e) => {
            e.stopPropagation();
            deleteObjects(page.id, [o.id]);
          }}
        >
          <Trash size={12} />
        </button>
      </div>
      <div className="mt-0.5 text-[11px]" style={{ color: "var(--faint)" }}>
        {o.author} · {formatDate(o.modified)}
      </div>
      {quote && (
        <div className="mt-1 line-clamp-2 border-l-2 pl-2 text-[12px] italic" style={{ borderColor: color, color: "var(--muted)" }}>
          {quote}
        </div>
      )}
      {text && <div className="mt-1 whitespace-pre-wrap text-[12.5px]">{text}</div>}
    </div>
  );
}

/* ---------------------------------------------------------------- */

function SearchPanel() {
  const search = useEditor((s) => s.search);
  const pages = useEditor((s) => s.doc?.pages ?? []);
  const [q, setQ] = useState(search.query);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);
  const pageIndex = useMemo(() => new Map(pages.map((p, i) => [p.id, i])), [pages]);
  const go = () => (q === search.query && search.hits.length ? goToHit(search.active + 1) : runSearch(q));
  return (
    <div className="flex h-full flex-col">
      <div className="flex-none space-y-2 p-3">
        <div className="relative">
          <input
            ref={inputRef}
            data-search-input
            className="pdf-input pr-8"
            placeholder="Find in document"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (e.shiftKey) goToHit(search.active - 1);
                else go();
              }
              e.stopPropagation();
            }}
          />
          <Search size={15} className="absolute right-2.5 top-1/2 -translate-y-1/2" style={{ color: "var(--faint)" } as any} />
        </div>
        <div className="flex items-center gap-1">
          <button className={`pdf-icon-btn sm ${search.caseSensitive ? "active" : ""}`} title="Match case" onClick={() => runSearch(q, { caseSensitive: !search.caseSensitive })}>
            <CaseSensitive size={15} />
          </button>
          <button className={`pdf-icon-btn sm ${search.wholeWord ? "active" : ""}`} title="Whole words" onClick={() => runSearch(q, { wholeWord: !search.wholeWord })}>
            <WholeWord size={15} />
          </button>
          <span className="flex-1 text-right text-[12px] tabular-nums" style={{ color: "var(--muted)" }}>
            {search.running ? "Searching…" : search.query ? `${search.hits.length ? search.active + 1 : 0} of ${search.hits.length}` : ""}
          </span>
          <button className="pdf-icon-btn sm" title="Previous (Shift+Enter)" disabled={!search.hits.length} onClick={() => goToHit(search.active - 1)}>
            <ArrowUp size={14} />
          </button>
          <button className="pdf-icon-btn sm" title="Next (Enter)" disabled={!search.hits.length} onClick={() => goToHit(search.active + 1)}>
            <ArrowDown size={14} />
          </button>
        </div>
      </div>
      <div className="pdf-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {search.hits.slice(0, 500).map((h, i) => (
          <button
            key={i}
            className="mb-0.5 block w-full rounded-md px-2 py-1.5 text-left text-[12px] hover:bg-[var(--hover)]"
            style={{ background: i === search.active ? "var(--accent-soft)" : undefined }}
            onClick={() => goToHit(i)}
          >
            <span className="mr-1.5 font-semibold" style={{ color: "var(--muted)" }}>
              p.{(pageIndex.get(h.pageId) ?? 0) + 1}
            </span>
            {h.context.slice(0, h.index)}
            <mark style={{ background: "#ffd54a", color: "#000", borderRadius: 2 }}>{h.context.slice(h.index, h.index + search.query.length)}</mark>
            {h.context.slice(h.index + search.query.length)}
          </button>
        ))}
        {search.hits.length > 500 && <Empty text={`Showing the first 500 of ${search.hits.length} results.`} />}
        {search.query && !search.running && !search.hits.length && <Empty text="No matches. Scanned documents may need OCR first (All tools → Scan & OCR)." />}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- */

function AttachmentsPanel() {
  const sources = useEditor((s) => s.sources);
  const [list, setList] = useState<{ name: string; size: number; get: () => Promise<Uint8Array> }[] | null>(null);
  useEffect(() => {
    let live = true;
    (async () => {
      const out: { name: string; size: number; get: () => Promise<Uint8Array> }[] = [];
      for (const src of Object.values(sources)) {
        const att = await src.pdf.getAttachments().catch(() => null);
        if (!att) continue;
        for (const [key, a] of Object.entries<any>(att)) {
          out.push({
            name: a.filename || key,
            size: a.content?.length ?? 0,
            get: async () => a.content ?? (await src.pdf.getAttachmentContent?.(key))?.content,
          });
        }
      }
      if (live) setList(out);
    })();
    return () => {
      live = false;
    };
  }, [sources]);
  return (
    <div className="pdf-scroll h-full overflow-y-auto p-2">
      {!list ? (
        <Empty text="Loading…" />
      ) : !list.length ? (
        <Empty text="This document has no file attachments." />
      ) : (
        list.map((a, i) => (
          <div key={i} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-[var(--hover)]">
            <Paperclip size={14} style={{ color: "var(--muted)" }} />
            <span className="min-w-0 flex-1 truncate text-[12.5px]">{a.name}</span>
            <span className="text-[11px]" style={{ color: "var(--faint)" }}>
              {a.size ? formatBytes(a.size) : ""}
            </span>
            <button className="pdf-icon-btn sm" title="Download" onClick={async () => downloadBlob(await a.get(), a.name, "application/octet-stream")}>
              <Download size={13} />
            </button>
          </div>
        ))
      )}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <p className="px-3 py-6 text-center text-[12px]" style={{ color: "var(--faint)" }}>
      {text}
    </p>
  );
}
