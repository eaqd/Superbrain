"use client";
import { useEffect, useRef, useState } from "react";
import { Eraser, Trash, Upload } from "lucide-react";
import { useEditor, addObject, toast } from "@/lib/pdf/store";
import { makeImage } from "@/lib/pdf/create";
import { loadImage, readFileAsDataUrl } from "@/lib/pdf/util";
import { Modal } from "./ui";

const STORE_KEY = "superbrain-pdf-signatures";
type Mode = "signature" | "initials";
type Saved = { id: string; mode: Mode; src: string };

function loadSaved(): Saved[] {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) ?? "[]");
  } catch {
    return [];
  }
}
function storeSaved(list: Saved[]) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(list.slice(0, 8)));
  } catch {
    /* quota or private mode */
  }
}

/** Crop transparent/white margins and return a PNG data URL plus its size. */
function trimCanvas(src: HTMLCanvasElement, removeWhite = false): { url: string; w: number; h: number } | null {
  const ctx = src.getContext("2d")!;
  const { width, height } = src;
  const img = ctx.getImageData(0, 0, width, height);
  const d = img.data;
  let x1 = width, y1 = height, x2 = -1, y2 = -1;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (removeWhite && d[i] > 225 && d[i + 1] > 225 && d[i + 2] > 225) d[i + 3] = 0;
      if (d[i + 3] > 12) {
        if (x < x1) x1 = x;
        if (x > x2) x2 = x;
        if (y < y1) y1 = y;
        if (y > y2) y2 = y;
      }
    }
  if (x2 < 0) return null;
  if (removeWhite) ctx.putImageData(img, 0, 0);
  const pad = 6;
  x1 = Math.max(0, x1 - pad);
  y1 = Math.max(0, y1 - pad);
  x2 = Math.min(width - 1, x2 + pad);
  y2 = Math.min(height - 1, y2 + pad);
  const out = document.createElement("canvas");
  out.width = x2 - x1 + 1;
  out.height = y2 - y1 + 1;
  out.getContext("2d")!.drawImage(src, x1, y1, out.width, out.height, 0, 0, out.width, out.height);
  return { url: out.toDataURL("image/png"), w: out.width, h: out.height };
}

const INKS = ["#111111", "#1d3fbf", "#b42318"];

export default function SignatureDialog({ mode }: { mode: Mode }) {
  const [tab, setTab] = useState<"draw" | "type" | "upload" | "saved">(() => (loadSaved().some((s) => s.mode === mode) ? "saved" : "draw"));
  const [ink, setInk] = useState(INKS[0]);
  const [typed, setTyped] = useState(() => {
    const a = useEditor.getState().author;
    return mode === "initials" ? a.split(/\s+/).map((p) => p[0] ?? "").join("").toUpperCase() : a;
  });
  const [fontIdx, setFontIdx] = useState(0);
  const [upload, setUpload] = useState<string | null>(null);
  const [removeBg, setRemoveBg] = useState(true);
  const [save, setSave] = useState(true);
  const [saved, setSaved] = useState<Saved[]>(() => loadSaved());
  const [hasInk, setHasInk] = useState(false);
  const pad = useRef<HTMLCanvasElement>(null);
  const strokes = useRef<{ x: number; y: number }[][]>([]);

  const close = () => useEditor.setState({ dialog: null, pendingSigRect: null });

  const fonts = ["--font-sig1", "--font-sig2", "--font-sig3"].map((v) => {
    const root = document.querySelector(".pdf-root");
    const val = root ? getComputedStyle(root).getPropertyValue(v).trim() : "";
    return val || "cursive";
  });

  // drawing pad
  useEffect(() => {
    const c = pad.current;
    if (!c || tab !== "draw") return;
    const dpr = window.devicePixelRatio || 1;
    const r = c.getBoundingClientRect();
    c.width = r.width * dpr;
    c.height = r.height * dpr;
    redraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const redraw = () => {
    const c = pad.current;
    if (!c) return;
    const ctx = c.getContext("2d")!;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.strokeStyle = ink;
    ctx.lineWidth = 2.6;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const s of strokes.current) {
      ctx.beginPath();
      ctx.moveTo(s[0].x, s[0].y);
      if (s.length === 1) ctx.lineTo(s[0].x + 0.1, s[0].y);
      for (let i = 1; i < s.length - 1; i++) ctx.quadraticCurveTo(s[i].x, s[i].y, (s[i].x + s[i + 1].x) / 2, (s[i].y + s[i + 1].y) / 2);
      if (s.length > 1) ctx.lineTo(s[s.length - 1].x, s[s.length - 1].y);
      ctx.stroke();
    }
  };
  useEffect(redraw, [ink]); // eslint-disable-line react-hooks/exhaustive-deps

  const pos = (e: React.PointerEvent) => {
    const r = pad.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const produce = async (): Promise<{ url: string; w: number; h: number } | null> => {
    if (tab === "draw") {
      if (!strokes.current.length) return null;
      return trimCanvas(pad.current!);
    }
    if (tab === "type") {
      if (!typed.trim()) return null;
      const family = fonts[fontIdx];
      try {
        await document.fonts.load(`96px ${family}`);
      } catch {
        /* fall back to whatever is available */
      }
      const c = document.createElement("canvas");
      const ctx = c.getContext("2d")!;
      ctx.font = `96px ${family}`;
      const w = Math.ceil(ctx.measureText(typed).width) + 60;
      c.width = w;
      c.height = 170;
      ctx.font = `96px ${family}`;
      ctx.fillStyle = ink;
      ctx.textBaseline = "middle";
      ctx.fillText(typed, 30, 90);
      return trimCanvas(c);
    }
    if (tab === "upload" && upload) {
      const img = await loadImage(upload);
      const c = document.createElement("canvas");
      const k = Math.min(1, 1200 / Math.max(img.naturalWidth, img.naturalHeight));
      c.width = Math.max(1, Math.round(img.naturalWidth * k));
      c.height = Math.max(1, Math.round(img.naturalHeight * k));
      c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
      return trimCanvas(c, removeBg);
    }
    return null;
  };

  const use = (url: string, w: number, h: number) => {
    const s = useEditor.getState();
    const target = s.pendingSigRect;
    if (target && s.doc) {
      const page = s.doc.pages.find((p) => p.id === target.pageId);
      if (page) {
        const r = target.rect;
        const k = Math.min(r.w / w, r.h / h);
        const ww = w * k;
        const hh = h * k;
        const o = makeImage(page, { x: r.x + (r.w - ww) / 2, y: r.y + (r.h - hh) / 2, w: ww, h: hh }, url, mode);
        addObject(page.id, { ...o, rotate: 0 });
        useEditor.setState({ dialog: null, pendingSigRect: null, tool: "select" });
        return;
      }
    }
    const targetW = mode === "initials" ? 60 : 160;
    useEditor.setState({ dialog: null, pendingSigRect: null, placement: { src: url, w: targetW, h: (targetW * h) / w, kind: mode }, tool: mode });
    toast(`Click where you want to place your ${mode}.`);
  };

  const confirm = async () => {
    const r = await produce();
    if (!r) {
      toast(tab === "upload" ? "Choose an image first." : "Please add your signature first.", "error");
      return;
    }
    if (save) {
      const next = [{ id: String(Date.now()), mode, src: r.url }, ...saved.filter((s) => s.src !== r.url)];
      storeSaved(next);
    }
    use(r.url, r.w, r.h);
  };

  const mine = saved.filter((s) => s.mode === mode);
  const title = mode === "initials" ? "Add initials" : "Add signature";

  return (
    <Modal
      title={title}
      onClose={close}
      width={620}
      footer={
        tab === "saved" ? (
          <button className="pdf-btn" onClick={close}>
            Cancel
          </button>
        ) : (
          <>
            <label className="pdf-check mr-auto">
              <input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} /> Remember on this device
            </label>
            <button className="pdf-btn" onClick={close}>
              Cancel
            </button>
            <button className="pdf-btn primary" onClick={confirm}>
              {useEditor.getState().pendingSigRect ? "Sign" : "Place on page"}
            </button>
          </>
        )
      }
    >
      <div className="pdf-seg mb-4">
        {mine.length > 0 && (
          <button className={tab === "saved" ? "active" : ""} onClick={() => setTab("saved")}>
            Saved
          </button>
        )}
        <button className={tab === "draw" ? "active" : ""} onClick={() => setTab("draw")}>
          Draw
        </button>
        <button className={tab === "type" ? "active" : ""} onClick={() => setTab("type")}>
          Type
        </button>
        <button className={tab === "upload" ? "active" : ""} onClick={() => setTab("upload")}>
          Upload image
        </button>
      </div>

      {tab === "saved" && (
        <div className="grid grid-cols-2 gap-3">
          {mine.map((s) => (
            <div key={s.id} className="group relative grid h-28 cursor-pointer place-items-center rounded-lg border bg-white p-2 hover:border-[var(--accent)]" style={{ borderColor: "var(--border-strong)" }} onClick={async () => {
              const img = await loadImage(s.src);
              use(s.src, img.naturalWidth, img.naturalHeight);
            }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={s.src} alt="Saved signature" className="max-h-full max-w-full" />
              <button
                className="pdf-icon-btn sm absolute right-1 top-1 hidden group-hover:inline-flex"
                title="Forget this signature"
                onClick={(e) => {
                  e.stopPropagation();
                  const next = saved.filter((x) => x.id !== s.id);
                  setSaved(next);
                  storeSaved(next);
                  if (!next.some((x) => x.mode === mode)) setTab("draw");
                }}
              >
                <Trash size={13} />
              </button>
            </div>
          ))}
        </div>
      )}

      {tab !== "saved" && tab !== "upload" && (
        <div className="mb-3 flex items-center gap-2">
          <span className="pdf-label m-0">Ink</span>
          {INKS.map((c) => (
            <button key={c} className={`pdf-swatch ${ink === c ? "active" : ""}`} style={{ background: c }} onClick={() => setInk(c)} title={c} />
          ))}
        </div>
      )}

      {tab === "draw" && (
        <div>
          <div className="relative">
            <canvas
              ref={pad}
              className="pdf-sig-pad block h-[200px] w-full"
              onPointerDown={(e) => {
                (e.target as HTMLElement).setPointerCapture(e.pointerId);
                strokes.current.push([pos(e)]);
                setHasInk(true);
                redraw();
              }}
              onPointerMove={(e) => {
                if (e.buttons !== 1 || !strokes.current.length) return;
                strokes.current[strokes.current.length - 1].push(pos(e));
                redraw();
              }}
            />
            {!hasInk && <span className="pointer-events-none absolute inset-0 grid place-items-center text-[13px] text-gray-400">Sign here with your mouse, finger or stylus</span>}
            <div className="pointer-events-none absolute bottom-10 left-8 right-8 border-b border-dashed border-gray-300" />
          </div>
          <button
            className="pdf-btn sm mt-2"
            onClick={() => {
              strokes.current = [];
              setHasInk(false);
              redraw();
            }}
          >
            <Eraser size={14} /> Clear
          </button>
        </div>
      )}

      {tab === "type" && (
        <div className="space-y-3">
          <input className="pdf-input h-10 text-[15px]" value={typed} placeholder={mode === "initials" ? "Your initials" : "Your full name"} onChange={(e) => setTyped(e.target.value)} autoFocus />
          <div className="grid gap-2">
            {fonts.map((f, i) => (
              <button
                key={i}
                className="flex h-16 items-center rounded-lg border bg-white px-4 text-left"
                style={{ borderColor: fontIdx === i ? "var(--accent)" : "var(--border-strong)", boxShadow: fontIdx === i ? "var(--focus)" : undefined, fontFamily: f, fontSize: 34, color: ink }}
                onClick={() => setFontIdx(i)}
              >
                {typed || (mode === "initials" ? "AB" : "Your name")}
              </button>
            ))}
          </div>
        </div>
      )}

      {tab === "upload" && (
        <div className="space-y-3">
          <label className="pdf-dropzone flex h-40 cursor-pointer flex-col items-center justify-center gap-2 bg-white">
            {upload ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={upload} alt="" className="max-h-36 max-w-full" />
            ) : (
              <>
                <Upload size={22} className="text-gray-400" />
                <span className="text-[13px] text-gray-500">Choose a photo or scan of your signature</span>
              </>
            )}
            <input
              type="file"
              accept="image/*"
              hidden
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (f) setUpload(await readFileAsDataUrl(f));
              }}
            />
          </label>
          <label className="pdf-check">
            <input type="checkbox" checked={removeBg} onChange={(e) => setRemoveBg(e.target.checked)} /> Remove white background
          </label>
        </div>
      )}
    </Modal>
  );
}
