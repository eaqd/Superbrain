"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useRef, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, FilePlus, Trash } from "lucide-react";
import { useEditor, mutate, toast, withBusy, addObject, type DialogKind } from "@/lib/pdf/store";
import {
  applyRedactions,
  exportAs,
  extractPages,
  deletePages,
  insertFiles,
  newBlankDocument,
  openFiles,
  pageRuns,
  rangeRects,
  rebase,
  runOcr,
  saveDocument,
  splitDocument,
  buildPdf,
} from "@/lib/pdf/actions";
import { PAGE_SIZES, type HeaderFooter, type PageModel, type Rect, type Watermark } from "@/lib/pdf/types";
import { displayRotation, displaySize } from "@/lib/pdf/geometry";
import { baseName, displayToPlane, downloadBlob, formatBytes, parsePageRanges, readFileAsDataUrl, normalizeImage } from "@/lib/pdf/util";
import { CSS_FONT } from "@/lib/pdf/textLayout";
import { batesNumber, resolveTokens } from "@/lib/pdf/exporter";
import { makeMarkup, makeRedaction } from "@/lib/pdf/create";
import { getPage } from "@/lib/pdf/pdfjs";
import { ColorPicker, Field, Modal, NumberInput } from "./ui";
import SignatureDialog from "./SignatureDialog";
import { PageThumb } from "./Thumb";

type D<K extends DialogKind["kind"]> = Extract<DialogKind, { kind: K }>;
const close = () => useEditor.setState({ dialog: null });

export default function Dialogs() {
  const dialog = useEditor((s) => s.dialog);
  if (!dialog) return null;
  switch (dialog.kind) {
    case "password":
      return <PasswordDialog d={dialog} />;
    case "signature":
      return <SignatureDialog mode={dialog.mode} />;
    case "stamp":
      return <StampDialog />;
    case "watermark":
      return <WatermarkDialog />;
    case "headerFooter":
      return <HeaderFooterDialog />;
    case "pageNumbers":
      return <PageNumbersDialog />;
    case "protect":
      return <ProtectDialog />;
    case "compress":
      return <CompressDialog />;
    case "export":
      return <ExportDialog />;
    case "properties":
      return <PropertiesDialog />;
    case "split":
      return <SplitDialog />;
    case "extract":
      return <ExtractDialog d={dialog} />;
    case "combine":
      return <CombineDialog />;
    case "ocr":
      return <OcrDialog />;
    case "compare":
      return <CompareDialog />;
    case "crop":
      return <CropDialog d={dialog} />;
    case "pageSize":
      return <PageSizeDialog d={dialog} />;
    case "save":
      return <SaveDialog />;
    case "shortcuts":
      return <ShortcutsDialog />;
    case "applyRedactions":
      return <ApplyRedactionsDialog />;
    case "searchRedact":
      return <SearchRedactDialog />;
    case "link":
      return <LinkDialog d={dialog} />;
    case "newBlank":
      return <NewBlankDialog />;
    case "flatten":
      return <FlattenDialog />;
    case "sanitize":
      return <SanitizeDialog />;
    default:
      return null;
  }
}

function needDoc(): boolean {
  if (useEditor.getState().doc) return true;
  toast("Open a PDF first.", "info");
  close();
  return false;
}

function Footer({ onOk, ok = "Apply", disabled, extra }: { onOk: () => void; ok?: ReactNode; disabled?: boolean; extra?: ReactNode }) {
  return (
    <>
      {extra}
      <button className="pdf-btn" onClick={close}>
        Cancel
      </button>
      <button className="pdf-btn primary" onClick={onOk} disabled={disabled}>
        {ok}
      </button>
    </>
  );
}

/** Page selector used by several tools. */
function PageScope({ value, onChange, allowSelected = true }: { value: string; onChange: (v: string) => void; allowSelected?: boolean }) {
  const total = useEditor((s) => s.doc?.pages.length ?? 0);
  const sel = useEditor((s) => s.organizerSel.length);
  const mode = value === "all" ? "all" : value === "current" ? "current" : value === "selected" ? "selected" : "range";
  return (
    <div className="space-y-2">
      <div className="pdf-seg">
        <button className={mode === "all" ? "active" : ""} onClick={() => onChange("all")}>
          All {total}
        </button>
        <button className={mode === "current" ? "active" : ""} onClick={() => onChange("current")}>
          Current
        </button>
        {allowSelected && sel > 0 && (
          <button className={mode === "selected" ? "active" : ""} onClick={() => onChange("selected")}>
            Selected ({sel})
          </button>
        )}
        <button className={mode === "range" ? "active" : ""} onClick={() => onChange(mode === "range" ? value : "1-")}>
          Range
        </button>
      </div>
      {mode === "range" && <input className="pdf-input" value={value} placeholder="e.g. 1-3, 6, 9-" onChange={(e) => onChange(e.target.value)} />}
    </div>
  );
}

function scopePages(scope: string): PageModel[] {
  const s = useEditor.getState();
  const pages = s.doc?.pages ?? [];
  if (scope === "all") return pages;
  if (scope === "current") return pages[s.currentPage] ? [pages[s.currentPage]] : [];
  if (scope === "selected") return pages.filter((p) => s.organizerSel.includes(p.id));
  return parsePageRanges(scope, pages.length).map((i) => pages[i]);
}

/* ------------------------------------------------------------------ */

function PasswordDialog({ d }: { d: D<"password"> }) {
  const [pw, setPw] = useState("");
  return (
    <Modal
      title="Password required"
      onClose={() => d.resolve(null)}
      footer={
        <>
          <button className="pdf-btn" onClick={() => d.resolve(null)}>
            Cancel
          </button>
          <button className="pdf-btn primary" onClick={() => d.resolve(pw)}>
            Open
          </button>
        </>
      }
    >
      <p className="mb-3">“{d.fileName}” is protected. Enter its password to open it.</p>
      <input autoFocus type="password" className="pdf-input" value={pw} onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => e.key === "Enter" && d.resolve(pw)} />
      {d.incorrect && (
        <p className="mt-2 text-[12px]" style={{ color: "var(--danger)" }}>
          Incorrect password, try again.
        </p>
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------------ */

const STAMPS: { label: string; color: string }[] = [
  { label: "APPROVED", color: "#16803c" },
  { label: "NOT APPROVED", color: "#d92d20" },
  { label: "REJECTED", color: "#d92d20" },
  { label: "DRAFT", color: "#1d6fe0" },
  { label: "FINAL", color: "#16803c" },
  { label: "CONFIDENTIAL", color: "#d92d20" },
  { label: "FOR COMMENT", color: "#1d6fe0" },
  { label: "COMPLETED", color: "#16803c" },
  { label: "REVIEWED", color: "#7c3aed" },
  { label: "RECEIVED", color: "#1d6fe0" },
  { label: "VOID", color: "#d92d20" },
  { label: "SIGN HERE", color: "#f97316" },
];

function StampDialog() {
  const cur = useEditor((s) => s.stamp);
  const [custom, setCustom] = useState("");
  const [color, setColor] = useState("#1d6fe0");
  const pick = (label: string, c: string) => {
    useEditor.setState({ stamp: { label, color: c }, tool: "stamp", dialog: null });
    toast("Click on the page to place the stamp.");
  };
  return (
    <Modal title="Stamps" onClose={close} width={560} footer={<button className="pdf-btn" onClick={close}>Close</button>}>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {STAMPS.map((s) => (
          <button
            key={s.label}
            className="grid h-14 place-items-center rounded-lg border-2 px-2 text-[13px] font-extrabold tracking-wide"
            style={{ borderColor: s.color, color: s.color, background: cur.label === s.label ? "var(--accent-soft)" : "var(--panel)" }}
            onClick={() => pick(s.label, s.color)}
          >
            {s.label}
          </button>
        ))}
      </div>
      <div className="mt-5 border-t pt-4" style={{ borderColor: "var(--border)" }}>
        <Field label="Custom stamp">
          <div className="flex gap-2">
            <input className="pdf-input" value={custom} placeholder="e.g. PAID" onChange={(e) => setCustom(e.target.value.toUpperCase())} />
            <button className="pdf-btn primary" disabled={!custom.trim()} onClick={() => pick(custom.trim(), color)}>
              Use
            </button>
          </div>
        </Field>
        <div className="mt-2">
          <ColorPicker value={color} onChange={(v) => v && setColor(v)} colors={["#16803c", "#d92d20", "#1d6fe0", "#7c3aed", "#f97316", "#000000"]} />
        </div>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */

function CurrentPageThumb({ children, width = 200 }: { children?: (dw: number, dh: number, k: number) => ReactNode; width?: number }) {
  const page = useEditor((s) => s.doc?.pages[s.currentPage]);
  if (!page) return null;
  const [dw, dh] = displaySize(page);
  const k = width / dw;
  return (
    <div className="relative mx-auto" style={{ width, height: dh * k }}>
      <PageThumb page={page} width={width} />
      <div className="pointer-events-none absolute inset-0 overflow-hidden">{children?.(dw, dh, k)}</div>
    </div>
  );
}

const DEFAULT_WM: Watermark = {
  kind: "text",
  text: "CONFIDENTIAL",
  font: "Helvetica",
  bold: true,
  size: 64,
  color: "#d92d20",
  imageSrc: null,
  imageScale: 0.5,
  opacity: 0.25,
  rotation: 45,
  position: "center",
  layer: "over",
  pages: "",
};

function WatermarkDialog() {
  const existing = useEditor((s) => s.doc?.decor.watermark);
  const [w, setW] = useState<Watermark>(existing ?? DEFAULT_WM);
  const up = (p: Partial<Watermark>) => setW((x) => ({ ...x, ...p }));
  if (!needDoc()) return null;
  return (
    <Modal
      title="Watermark"
      onClose={close}
      width={720}
      footer={
        <Footer
          ok={existing ? "Update" : "Add watermark"}
          onOk={() => {
            mutate((d) => ({ ...d, decor: { ...d.decor, watermark: w } }));
            close();
          }}
          extra={
            existing && (
              <button
                className="pdf-btn mr-auto"
                style={{ color: "var(--danger)" }}
                onClick={() => {
                  mutate((d) => ({ ...d, decor: { ...d.decor, watermark: null } }));
                  close();
                }}
              >
                Remove watermark
              </button>
            )
          }
        />
      }
    >
      <div className="grid gap-5 sm:grid-cols-[1fr_220px]">
        <div className="space-y-3">
          <div className="pdf-seg">
            <button className={w.kind === "text" ? "active" : ""} onClick={() => up({ kind: "text" })}>
              Text
            </button>
            <button className={w.kind === "image" ? "active" : ""} onClick={() => up({ kind: "image" })}>
              Image
            </button>
          </div>
          {w.kind === "text" ? (
            <>
              <Field label="Text">
                <textarea className="pdf-textarea" rows={2} value={w.text} onChange={(e) => up({ text: e.target.value })} />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Font">
                  <select className="pdf-select" value={w.font} onChange={(e) => up({ font: e.target.value as any })}>
                    <option>Helvetica</option>
                    <option>Times</option>
                    <option>Courier</option>
                  </select>
                </Field>
                <Field label="Size">
                  <NumberInput value={w.size} min={6} max={300} onChange={(v) => up({ size: v })} suffix="pt" />
                </Field>
              </div>
              <label className="pdf-check">
                <input type="checkbox" checked={w.bold} onChange={(e) => up({ bold: e.target.checked })} /> Bold
              </label>
              <Field label="Colour">
                <ColorPicker value={w.color} onChange={(v) => v && up({ color: v })} />
              </Field>
            </>
          ) : (
            <>
              <Field label="Image">
                <input
                  type="file"
                  accept="image/*"
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    if (f) up({ imageSrc: (await normalizeImage(await readFileAsDataUrl(f), 2000)).src });
                  }}
                />
              </Field>
              <Field label={`Scale · ${Math.round(w.imageScale * 100)}% of page width`}>
                <input type="range" min={0.1} max={1} step={0.05} value={w.imageScale} onChange={(e) => up({ imageScale: +e.target.value })} className="w-full" />
              </Field>
            </>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Field label={`Opacity · ${Math.round(w.opacity * 100)}%`}>
              <input type="range" min={0.05} max={1} step={0.05} value={w.opacity} onChange={(e) => up({ opacity: +e.target.value })} className="w-full" />
            </Field>
            <Field label={`Rotation · ${w.rotation}°`}>
              <input type="range" min={-90} max={90} step={5} value={w.rotation} onChange={(e) => up({ rotation: +e.target.value })} className="w-full" />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Position">
              <select className="pdf-select" value={w.position} onChange={(e) => up({ position: e.target.value as any })}>
                <option value="center">Center</option>
                <option value="top">Top</option>
                <option value="bottom">Bottom</option>
              </select>
            </Field>
            <Field label="Appearance">
              <select className="pdf-select" value={w.layer} onChange={(e) => up({ layer: e.target.value as any })}>
                <option value="over">On top of page</option>
                <option value="under">Behind page content</option>
              </select>
            </Field>
          </div>
          <Field label="Pages" hint="Leave empty for all pages, or e.g. 1-3, 7">
            <input className="pdf-input" value={w.pages} onChange={(e) => up({ pages: e.target.value })} />
          </Field>
        </div>
        <CurrentPageThumb width={220}>
          {(dw, dh, k) => (
            <div
              style={{
                position: "absolute",
                left: (dw * k) / 2,
                top: (w.position === "top" ? dh * 0.18 : w.position === "bottom" ? dh * 0.82 : dh / 2) * k,
                transform: `translate(-50%,-50%) rotate(${-w.rotation}deg)`,
                opacity: w.opacity,
                color: w.color,
                fontFamily: CSS_FONT[w.font],
                fontWeight: w.bold ? 700 : 400,
                fontSize: w.size * k,
                whiteSpace: "pre",
                textAlign: "center",
                lineHeight: 1.15,
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {w.kind === "image" && w.imageSrc ? <img src={w.imageSrc} alt="" style={{ width: dw * k * w.imageScale }} /> : w.text}
            </div>
          )}
        </CurrentPageThumb>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */

const DEFAULT_HF: HeaderFooter = {
  hl: "",
  hc: "",
  hr: "",
  fl: "",
  fc: "Page {page} of {pages}",
  fr: "",
  font: "Helvetica",
  size: 10,
  color: "#333333",
  marginX: 36,
  marginY: 24,
  startNumber: 1,
  pages: "",
  batesPrefix: "",
  batesSuffix: "",
  batesStart: 1,
  batesDigits: 6,
};

function HFPreview({ h }: { h: HeaderFooter }) {
  const fileName = useEditor((s) => s.fileName);
  const title = useEditor((s) => s.doc?.meta.title ?? "");
  const total = useEditor((s) => s.doc?.pages.length ?? 1);
  const cur = useEditor((s) => s.currentPage);
  return (
    <CurrentPageThumb width={220}>
      {(dw, dh, k) =>
        (["hl", "hc", "hr", "fl", "fc", "fr"] as const).map((key) => {
          if (!h[key].trim()) return null;
          const txt = resolveTokens(h[key], { page: h.startNumber + cur, pages: total + h.startNumber - 1, bates: batesNumber(h, cur), fileName, title });
          return (
            <div
              key={key}
              style={{
                position: "absolute",
                left: h.marginX * k,
                right: h.marginX * k,
                [key[0] === "h" ? "top" : "bottom"]: h.marginY * k,
                textAlign: key[1] === "l" ? "left" : key[1] === "c" ? "center" : "right",
                fontSize: Math.max(4, h.size * k),
                fontFamily: CSS_FONT[h.font],
                color: h.color,
                whiteSpace: "pre",
                lineHeight: 1,
              }}
            >
              {txt}
            </div>
          );
        })
      }
    </CurrentPageThumb>
  );
}

function HeaderFooterDialog() {
  const existing = useEditor((s) => s.doc?.decor.headerFooter);
  const [h, setH] = useState<HeaderFooter>(existing ?? DEFAULT_HF);
  const [focus, setFocus] = useState<keyof HeaderFooter>("fc");
  const up = (p: Partial<HeaderFooter>) => setH((x) => ({ ...x, ...p }));
  if (!needDoc()) return null;
  const slot = (k: "hl" | "hc" | "hr" | "fl" | "fc" | "fr", label: string) => (
    <Field label={label}>
      <input className="pdf-input" value={h[k]} onFocus={() => setFocus(k)} onChange={(e) => up({ [k]: e.target.value } as any)} />
    </Field>
  );
  const insert = (tok: string) => up({ [focus]: `${(h as any)[focus] ?? ""}${tok}` } as any);
  return (
    <Modal
      title="Header & footer"
      onClose={close}
      width={760}
      footer={
        <Footer
          ok={existing ? "Update" : "Add"}
          onOk={() => {
            mutate((d) => ({ ...d, decor: { ...d.decor, headerFooter: h } }));
            close();
          }}
          extra={
            existing && (
              <button
                className="pdf-btn mr-auto"
                style={{ color: "var(--danger)" }}
                onClick={() => {
                  mutate((d) => ({ ...d, decor: { ...d.decor, headerFooter: null } }));
                  close();
                }}
              >
                Remove
              </button>
            )
          }
        />
      }
    >
      <div className="grid gap-5 sm:grid-cols-[1fr_220px]">
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-2">
            {slot("hl", "Header left")}
            {slot("hc", "Header center")}
            {slot("hr", "Header right")}
            {slot("fl", "Footer left")}
            {slot("fc", "Footer center")}
            {slot("fr", "Footer right")}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="pdf-label m-0 mr-1">Insert</span>
            {[
              ["{page}", "Page #"],
              ["{pages}", "Total"],
              ["{date}", "Date"],
              ["{bates}", "Bates #"],
              ["{file}", "File name"],
              ["{title}", "Title"],
            ].map(([t, l]) => (
              <button key={t} className="pdf-btn sm" onClick={() => insert(t)}>
                {l}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Font">
              <select className="pdf-select" value={h.font} onChange={(e) => up({ font: e.target.value as any })}>
                <option>Helvetica</option>
                <option>Times</option>
                <option>Courier</option>
              </select>
            </Field>
            <Field label="Size">
              <NumberInput value={h.size} min={5} max={48} onChange={(v) => up({ size: v })} suffix="pt" />
            </Field>
            <Field label="Start page # at">
              <NumberInput value={h.startNumber} min={0} max={99999} onChange={(v) => up({ startNumber: Math.round(v) })} />
            </Field>
            <Field label="Side margin">
              <NumberInput value={h.marginX} min={0} max={200} onChange={(v) => up({ marginX: v })} suffix="pt" />
            </Field>
            <Field label="Top/bottom margin">
              <NumberInput value={h.marginY} min={0} max={200} onChange={(v) => up({ marginY: v })} suffix="pt" />
            </Field>
            <Field label="Pages">
              <input className="pdf-input" value={h.pages} placeholder="All" onChange={(e) => up({ pages: e.target.value })} />
            </Field>
          </div>
          <Field label="Colour">
            <ColorPicker value={h.color} onChange={(v) => v && up({ color: v })} />
          </Field>
          <details className="rounded-md border p-2" style={{ borderColor: "var(--border)" }} open={/\{bates\}/.test(Object.values(h).join(""))}>
            <summary className="cursor-pointer text-[12.5px] font-semibold">Bates numbering</summary>
            <div className="mt-2 grid grid-cols-4 gap-2">
              <Field label="Prefix">
                <input className="pdf-input" value={h.batesPrefix} onChange={(e) => up({ batesPrefix: e.target.value })} />
              </Field>
              <Field label="Start">
                <NumberInput value={h.batesStart} min={0} onChange={(v) => up({ batesStart: Math.round(v) })} />
              </Field>
              <Field label="Digits">
                <NumberInput value={h.batesDigits} min={1} max={12} onChange={(v) => up({ batesDigits: Math.round(v) })} />
              </Field>
              <Field label="Suffix">
                <input className="pdf-input" value={h.batesSuffix} onChange={(e) => up({ batesSuffix: e.target.value })} />
              </Field>
            </div>
          </details>
        </div>
        <HFPreview h={h} />
      </div>
    </Modal>
  );
}

function PageNumbersDialog() {
  const existing = useEditor((s) => s.doc?.decor.headerFooter);
  const [pos, setPos] = useState<"fc" | "fr" | "fl" | "hc" | "hr">("fc");
  const [fmt, setFmt] = useState("Page {page} of {pages}");
  const [start, setStart] = useState(1);
  const [bates, setBates] = useState({ on: false, prefix: "ABC", digits: 6, start: 1 });
  if (!needDoc()) return null;
  const h: HeaderFooter = { ...DEFAULT_HF, ...(existing ?? {}), hl: "", hc: "", hr: "", fl: "", fc: "", fr: "", [pos]: bates.on ? "{bates}" : fmt, startNumber: start, batesPrefix: bates.prefix, batesDigits: bates.digits, batesStart: bates.start };
  return (
    <Modal
      title="Page numbers & Bates numbering"
      onClose={close}
      width={640}
      footer={
        <Footer
          ok="Apply"
          onOk={() => {
            mutate((d) => ({ ...d, decor: { ...d.decor, headerFooter: h } }));
            close();
          }}
        />
      }
    >
      <div className="grid gap-5 sm:grid-cols-[1fr_220px]">
        <div className="space-y-3">
          <div className="pdf-seg">
            <button className={!bates.on ? "active" : ""} onClick={() => setBates({ ...bates, on: false })}>
              Page numbers
            </button>
            <button className={bates.on ? "active" : ""} onClick={() => setBates({ ...bates, on: true })}>
              Bates numbers
            </button>
          </div>
          <Field label="Position">
            <select className="pdf-select" value={pos} onChange={(e) => setPos(e.target.value as any)}>
              <option value="fc">Bottom center</option>
              <option value="fr">Bottom right</option>
              <option value="fl">Bottom left</option>
              <option value="hc">Top center</option>
              <option value="hr">Top right</option>
            </select>
          </Field>
          {!bates.on ? (
            <>
              <Field label="Format">
                <select className="pdf-select" value={fmt} onChange={(e) => setFmt(e.target.value)}>
                  <option value="Page {page} of {pages}">Page 1 of 9</option>
                  <option value="{page}">1</option>
                  <option value="{page} / {pages}">1 / 9</option>
                  <option value="- {page} -">- 1 -</option>
                  <option value="Page {page}">Page 1</option>
                </select>
              </Field>
              <Field label="Start at">
                <NumberInput value={start} min={0} onChange={(v) => setStart(Math.round(v))} />
              </Field>
            </>
          ) : (
            <div className="grid grid-cols-3 gap-2">
              <Field label="Prefix">
                <input className="pdf-input" value={bates.prefix} onChange={(e) => setBates({ ...bates, prefix: e.target.value })} />
              </Field>
              <Field label="Start">
                <NumberInput value={bates.start} min={0} onChange={(v) => setBates({ ...bates, start: Math.round(v) })} />
              </Field>
              <Field label="Digits">
                <NumberInput value={bates.digits} min={1} max={12} onChange={(v) => setBates({ ...bates, digits: Math.round(v) })} />
              </Field>
            </div>
          )}
          <p className="text-[12px]" style={{ color: "var(--muted)" }}>
            For more control (several positions, dates, file name), use Header & footer.
          </p>
        </div>
        <HFPreview h={h} />
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */

function ProtectDialog() {
  const encrypted = useEditor((s) => Object.values(s.sources).some((x) => x.encrypted));
  const [userPw, setUserPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [ownerPw, setOwnerPw] = useState("");
  const [restrict, setRestrict] = useState(false);
  const [perm, setPerm] = useState({ printing: true, copying: false, modifying: false, annotating: true, fillingForms: true, documentAssembly: false, contentAccessibility: true });
  const [alg, setAlg] = useState<"AES-256" | "AES-128">("AES-256");
  if (!needDoc()) return null;
  const mismatch = userPw !== confirmPw;
  const valid = (userPw || (restrict && ownerPw)) && !mismatch;
  return (
    <Modal
      title="Protect with password"
      onClose={close}
      width={560}
      footer={
        <Footer
          ok="Save protected copy"
          disabled={!valid}
          extra={
            encrypted && (
              <button
                className="pdf-btn mr-auto"
                onClick={async () => {
                  close();
                  await saveDocument({ fileName: `${baseName(useEditor.getState().fileName)}-unlocked.pdf` });
                }}
              >
                Save without password
              </button>
            )
          }
          onOk={async () => {
            close();
            await saveDocument({
              fileName: `${baseName(useEditor.getState().fileName)}-protected.pdf`,
              encrypt: {
                userPassword: userPw || undefined,
                ownerPassword: (restrict ? ownerPw : "") || userPw || undefined,
                permissions: restrict ? { ...perm, printing: perm.printing ? "highResolution" : false } : undefined,
                algorithm: alg,
              } as any,
            });
          }}
        />
      }
    >
      <div className="space-y-3">
        <Field label="Password to open the document">
          <input type="password" className="pdf-input" value={userPw} autoComplete="new-password" onChange={(e) => setUserPw(e.target.value)} />
        </Field>
        <Field label="Confirm password">
          <input type="password" className="pdf-input" value={confirmPw} autoComplete="new-password" onChange={(e) => setConfirmPw(e.target.value)} />
        </Field>
        {mismatch && confirmPw && (
          <p className="text-[12px]" style={{ color: "var(--danger)" }}>
            Passwords don’t match.
          </p>
        )}
        <label className="pdf-check">
          <input type="checkbox" checked={restrict} onChange={(e) => setRestrict(e.target.checked)} /> Restrict editing and printing
        </label>
        {restrict && (
          <div className="space-y-2 rounded-lg border p-3" style={{ borderColor: "var(--border)" }}>
            <Field label="Permissions password (required to change these settings)">
              <input type="password" className="pdf-input" value={ownerPw} autoComplete="new-password" onChange={(e) => setOwnerPw(e.target.value)} />
            </Field>
            <div className="grid grid-cols-2 gap-1.5">
              {(
                [
                  ["printing", "Allow printing"],
                  ["copying", "Allow copying text & images"],
                  ["modifying", "Allow editing"],
                  ["annotating", "Allow comments"],
                  ["fillingForms", "Allow filling forms"],
                  ["documentAssembly", "Allow page changes"],
                  ["contentAccessibility", "Allow screen readers"],
                ] as const
              ).map(([k, l]) => (
                <label key={k} className="pdf-check">
                  <input type="checkbox" checked={perm[k]} onChange={(e) => setPerm({ ...perm, [k]: e.target.checked })} /> {l}
                </label>
              ))}
            </div>
          </div>
        )}
        <Field label="Encryption">
          <select className="pdf-select" value={alg} onChange={(e) => setAlg(e.target.value as any)}>
            <option value="AES-256">AES 256-bit (Acrobat X and later)</option>
            <option value="AES-128">AES 128-bit (Acrobat 7 and later)</option>
          </select>
        </Field>
        <p className="text-[12px]" style={{ color: "var(--muted)" }}>
          The protected copy is downloaded; the document open here stays unlocked so you can keep editing.
        </p>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */

function CompressDialog() {
  const [preset, setPreset] = useState<"high" | "balanced" | "small">("balanced");
  const [result, setResult] = useState<{ before: number; after: number; images: number } | null>(null);
  if (!needDoc()) return null;
  const presets = {
    high: { quality: 0.85, maxDpi: 220, label: "High quality", hint: "Best for printing" },
    balanced: { quality: 0.72, maxDpi: 150, label: "Balanced", hint: "Good for screens and email" },
    small: { quality: 0.55, maxDpi: 96, label: "Smallest size", hint: "Lower image quality" },
  } as const;
  const run = async () => {
    const r = await withBusy("Compressing…", async () => {
      const bytes = await buildPdf({});
      const { compressPdf } = await import("@/lib/pdf/tools/compress");
      const codec = {
        async decode(b: Uint8Array) {
          const bmp = await createImageBitmap(new Blob([b as BlobPart], { type: "image/jpeg" }));
          const c = document.createElement("canvas");
          c.width = bmp.width;
          c.height = bmp.height;
          const ctx = c.getContext("2d")!;
          ctx.drawImage(bmp, 0, 0);
          return { width: c.width, height: c.height, data: ctx.getImageData(0, 0, c.width, c.height).data };
        },
        async encodeJpeg(img: { width: number; height: number; data: Uint8ClampedArray }, quality: number) {
          const c = document.createElement("canvas");
          c.width = img.width;
          c.height = img.height;
          c.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
          const blob: Blob = await new Promise((res) => c.toBlob((b) => res(b!), "image/jpeg", quality));
          return new Uint8Array(await blob.arrayBuffer());
        },
      };
      const p = presets[preset];
      const out = await compressPdf(bytes, { quality: p.quality, maxDpi: p.maxDpi, onProgress: (m: string) => useEditor.setState({ busy: m }) }, codec as any);
      downloadBlob(out.bytes, `${baseName(useEditor.getState().fileName)}-compressed.pdf`);
      return { before: out.report.before, after: out.report.after, images: out.report.imagesRecompressed };
    });
    if (r) setResult(r);
  };
  return (
    <Modal title="Compress PDF" onClose={close} width={520} footer={result ? <button className="pdf-btn primary" onClick={close}>Done</button> : <Footer ok="Compress & download" onOk={run} />}>
      {result ? (
        <div className="space-y-2 text-center">
          <div className="text-[28px] font-semibold">{result.after < result.before ? `−${Math.round((1 - result.after / result.before) * 100)}%` : "Already optimal"}</div>
          <div style={{ color: "var(--muted)" }}>
            {formatBytes(result.before)} → {formatBytes(result.after)} · {result.images} image{result.images === 1 ? "" : "s"} optimized
          </div>
        </div>
      ) : (
        <div className="grid gap-2">
          {(Object.keys(presets) as (keyof typeof presets)[]).map((k) => (
            <button key={k} className="pdf-start-card" style={{ borderColor: preset === k ? "var(--accent)" : undefined, boxShadow: preset === k ? "var(--focus)" : undefined }} onClick={() => setPreset(k)}>
              <span>
                <span className="block font-semibold">{presets[k].label}</span>
                <span className="text-[12.5px]" style={{ color: "var(--muted)" }}>
                  {presets[k].hint} · images up to {presets[k].maxDpi} dpi
                </span>
              </span>
            </button>
          ))}
          <p className="mt-1 text-[12px]" style={{ color: "var(--muted)" }}>
            Text, vector graphics, forms and comments are kept lossless. Unused objects are removed and the file is re-packed.
          </p>
        </div>
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------------ */

function ExportDialog() {
  const [fmt, setFmt] = useState<"docx" | "png" | "jpeg" | "txt" | "html" | "pdf">("docx");
  const [scope, setScope] = useState("all");
  const [dpi, setDpi] = useState(150);
  if (!needDoc()) return null;
  const opts: [typeof fmt, string, string][] = [
    ["docx", "Microsoft Word (.docx)", "Editable text with headings and styles"],
    ["png", "PNG images", "One lossless image per page"],
    ["jpeg", "JPEG images", "Smaller photos of each page"],
    ["txt", "Plain text (.txt)", "All text, in reading order"],
    ["html", "Web page (.html)", "Text with headings for the web"],
    ["pdf", "PDF (flattened)", "Comments and fields merged into pages"],
  ];
  return (
    <Modal
      title="Convert PDF"
      onClose={close}
      width={560}
      footer={
        <Footer
          ok="Export"
          onOk={async () => {
            const pages = scopePages(scope);
            close();
            if (fmt === "pdf") await saveDocument({ flattenAnnotations: true, flattenForms: true, pageIds: pages.map((p) => p.id), fileName: `${baseName(useEditor.getState().fileName)}-flattened.pdf` });
            else await exportAs(fmt, { pageIds: scope === "all" ? undefined : pages.map((p) => p.id), dpi });
          }}
        />
      }
    >
      <div className="grid gap-1.5">
        {opts.map(([k, l, h]) => (
          <label key={k} className="flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2" style={{ borderColor: fmt === k ? "var(--accent)" : "var(--border)", background: fmt === k ? "var(--accent-soft)" : undefined }}>
            <input type="radio" name="fmt" checked={fmt === k} onChange={() => setFmt(k)} />
            <span>
              <span className="block font-medium">{l}</span>
              <span className="text-[12px]" style={{ color: "var(--muted)" }}>
                {h}
              </span>
            </span>
          </label>
        ))}
      </div>
      {(fmt === "png" || fmt === "jpeg") && (
        <Field label="Resolution">
          <select className="pdf-select mt-1" value={dpi} onChange={(e) => setDpi(+e.target.value)}>
            <option value={72}>72 dpi (screen)</option>
            <option value={150}>150 dpi</option>
            <option value={300}>300 dpi (print)</option>
            <option value={600}>600 dpi</option>
          </select>
        </Field>
      )}
      <div className="mt-3">
        <span className="pdf-label">Pages</span>
        <PageScope value={scope} onChange={setScope} />
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */

function PropertiesDialog() {
  const doc = useEditor((s) => s.doc);
  const sources = useEditor((s) => s.sources);
  const fileName = useEditor((s) => s.fileName);
  const cur = useEditor((s) => s.currentPage);
  const [meta, setMeta] = useState(doc?.meta);
  if (!doc || !meta) return null;
  const page = doc.pages[cur];
  const [w, h] = page ? displaySize(page) : [0, 0];
  const size = Object.entries(PAGE_SIZES).find(([, [a, b]]) => (Math.abs(a - w) < 2 && Math.abs(b - h) < 2) || (Math.abs(a - h) < 2 && Math.abs(b - w) < 2))?.[0];
  const srcs = Object.values(sources);
  const field = (k: keyof typeof meta, label: string) => (
    <Field label={label}>
      <input className="pdf-input" value={meta[k]} onChange={(e) => setMeta({ ...meta, [k]: e.target.value })} />
    </Field>
  );
  return (
    <Modal
      title="Document properties"
      onClose={close}
      width={600}
      footer={
        <Footer
          ok="Save properties"
          onOk={() => {
            mutate((d) => ({ ...d, meta }));
            close();
          }}
        />
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {field("title", "Title")}
        {field("author", "Author")}
        {field("subject", "Subject")}
        {field("keywords", "Keywords (comma separated)")}
        {field("creator", "Application")}
        {field("producer", "PDF producer")}
      </div>
      <dl className="mt-4 grid grid-cols-[140px_1fr] gap-y-1.5 rounded-lg border p-3 text-[12.5px]" style={{ borderColor: "var(--border)" }}>
        <dt style={{ color: "var(--muted)" }}>File</dt>
        <dd className="truncate">{fileName}</dd>
        <dt style={{ color: "var(--muted)" }}>Pages</dt>
        <dd>{doc.pages.length}</dd>
        <dt style={{ color: "var(--muted)" }}>Page size</dt>
        <dd>
          {(w / 72).toFixed(2)} × {(h / 72).toFixed(2)} in ({Math.round((w / 72) * 25.4)} × {Math.round((h / 72) * 25.4)} mm){size ? ` · ${size}` : ""}
        </dd>
        <dt style={{ color: "var(--muted)" }}>Source files</dt>
        <dd>{srcs.map((s) => `${s.name} (${formatBytes(s.bytes.length)})`).join(", ") || "—"}</dd>
        <dt style={{ color: "var(--muted)" }}>Security</dt>
        <dd>{srcs.some((s) => s.encrypted) ? "Password protected (unlocked for editing)" : "None"}</dd>
        <dt style={{ color: "var(--muted)" }}>Form fields</dt>
        <dd>{srcs.some((s) => s.hasForm) ? "Yes" : "No"}</dd>
        <dt style={{ color: "var(--muted)" }}>Edits</dt>
        <dd>{doc.pages.reduce((n, p) => n + p.objects.length, 0)} objects added</dd>
      </dl>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */

function SplitDialog() {
  const total = useEditor((s) => s.doc?.pages.length ?? 0);
  const hasOutline = useEditor((s) => (s.doc?.outline?.length ?? 0) > 0);
  const [mode, setMode] = useState<"every" | "ranges" | "bookmarks">("every");
  const [n, setN] = useState(1);
  const [ranges, setRanges] = useState("1-" + Math.ceil(total / 2) + ", " + (Math.ceil(total / 2) + 1) + "-");
  if (!needDoc()) return null;
  const parsedRanges = ranges
    .split(/[,;]+/)
    .map((r) => parsePageRanges(r, total))
    .filter((g) => g.length);
  return (
    <Modal
      title="Split document"
      onClose={close}
      width={520}
      footer={
        <Footer
          ok="Split & download"
          disabled={mode === "ranges" && !parsedRanges.length}
          onOk={() => {
            close();
            splitDocument(mode === "every" ? { kind: "every", n } : mode === "ranges" ? { kind: "ranges", ranges: parsedRanges } : { kind: "bookmarks" });
          }}
        />
      }
    >
      <div className="space-y-3">
        <label className="pdf-check">
          <input type="radio" checked={mode === "every"} onChange={() => setMode("every")} /> Every
          <span className="inline-block w-20">
            <NumberInput value={n} min={1} max={Math.max(1, total)} onChange={(v) => setN(Math.max(1, Math.round(v)))} />
          </span>
          page(s) → {Math.ceil(total / n)} files
        </label>
        <label className="pdf-check">
          <input type="radio" checked={mode === "ranges"} onChange={() => setMode("ranges")} /> By page ranges
        </label>
        {mode === "ranges" && (
          <Field label="One file per range" hint="Separate ranges with commas, e.g. 1-3, 4-7, 8-">
            <input className="pdf-input" value={ranges} onChange={(e) => setRanges(e.target.value)} />
          </Field>
        )}
        <label className="pdf-check" style={{ opacity: hasOutline ? 1 : 0.5 }}>
          <input type="radio" disabled={!hasOutline} checked={mode === "bookmarks"} onChange={() => setMode("bookmarks")} /> At each top-level bookmark
        </label>
        <p className="text-[12px]" style={{ color: "var(--muted)" }}>
          The parts are downloaded together as a .zip file. Your edits are included.
        </p>
      </div>
    </Modal>
  );
}

function ExtractDialog({ d }: { d: D<"extract"> }) {
  const pages = useEditor((s) => s.doc?.pages ?? []);
  const [range, setRange] = useState(() => toRangeString(d.indices.length ? d.indices : [useEditor.getState().currentPage]));
  const [separate, setSeparate] = useState(false);
  const [remove, setRemove] = useState(false);
  const idx = parsePageRanges(range, pages.length);
  return (
    <Modal
      title="Extract pages"
      onClose={close}
      width={460}
      footer={
        <Footer
          ok="Extract"
          disabled={!idx.length}
          onOk={async () => {
            const ids = idx.map((i) => pages[i].id);
            close();
            await extractPages(ids, separate);
            if (remove) deletePages(ids);
          }}
        />
      }
    >
      <div className="space-y-3">
        <Field label="Pages" hint={`${idx.length} page${idx.length === 1 ? "" : "s"}`}>
          <input className="pdf-input" value={range} onChange={(e) => setRange(e.target.value)} />
        </Field>
        <label className="pdf-check">
          <input type="checkbox" checked={separate} onChange={(e) => setSeparate(e.target.checked)} /> Each page as a separate file
        </label>
        <label className="pdf-check">
          <input type="checkbox" checked={remove} onChange={(e) => setRemove(e.target.checked)} /> Delete pages after extracting
        </label>
      </div>
    </Modal>
  );
}

function toRangeString(idx: number[]) {
  const s = [...idx].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < s.length; i++) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    parts.push(i === j ? `${s[i] + 1}` : `${s[i] + 1}-${s[j] + 1}`);
    i = j;
  }
  return parts.join(", ");
}

function CombineDialog() {
  const hasDoc = useEditor((s) => !!s.doc);
  const [files, setFiles] = useState<File[]>([]);
  const [includeCurrent, setIncludeCurrent] = useState(true);
  const input = useRef<HTMLInputElement>(null);
  const move = (i: number, d: number) => {
    const n = [...files];
    const j = i + d;
    if (j < 0 || j >= n.length) return;
    [n[i], n[j]] = [n[j], n[i]];
    setFiles(n);
  };
  return (
    <Modal
      title="Combine files"
      onClose={close}
      width={560}
      footer={
        <Footer
          ok="Combine"
          disabled={!files.length}
          onOk={async () => {
            close();
            if (hasDoc && includeCurrent) await insertFiles(files);
            else await openFiles(files);
          }}
        />
      }
    >
      <div
        className="pdf-dropzone mb-3 flex cursor-pointer items-center justify-center gap-2 p-5 text-[13px]"
        onClick={() => input.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setFiles([...files, ...Array.from(e.dataTransfer.files)]);
        }}
      >
        <FilePlus size={18} /> Add PDFs or images (or drop them here)
        <input ref={input} type="file" multiple hidden accept="application/pdf,.pdf,image/*" onChange={(e) => setFiles([...files, ...Array.from(e.target.files ?? [])])} />
      </div>
      {hasDoc && (
        <label className="pdf-check mb-2">
          <input type="checkbox" checked={includeCurrent} onChange={(e) => setIncludeCurrent(e.target.checked)} /> Append to the open document (otherwise start a new one)
        </label>
      )}
      <div className="space-y-1">
        {files.map((f, i) => (
          <div key={i} className="flex items-center gap-2 rounded-md border px-2 py-1.5" style={{ borderColor: "var(--border)" }}>
            <span className="w-5 text-right text-[12px]" style={{ color: "var(--faint)" }}>
              {i + 1}
            </span>
            <span className="min-w-0 flex-1 truncate">{f.name}</span>
            <span className="text-[11px]" style={{ color: "var(--faint)" }}>
              {formatBytes(f.size)}
            </span>
            <button className="pdf-icon-btn sm" onClick={() => move(i, -1)} title="Move up">
              <ArrowUp size={13} />
            </button>
            <button className="pdf-icon-btn sm" onClick={() => move(i, 1)} title="Move down">
              <ArrowDown size={13} />
            </button>
            <button className="pdf-icon-btn sm" onClick={() => setFiles(files.filter((_, k) => k !== i))} title="Remove">
              <Trash size={13} />
            </button>
          </div>
        ))}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */

function OcrDialog() {
  const [scope, setScope] = useState("all");
  const [dpi, setDpi] = useState(300);
  const [skip, setSkip] = useState(true);
  if (!needDoc()) return null;
  return (
    <Modal
      title="Scan & OCR"
      onClose={close}
      width={500}
      footer={
        <Footer
          ok="Recognize text"
          onOk={() => {
            const ids = scopePages(scope).map((p) => p.id);
            close();
            runOcr(ids, dpi, skip);
          }}
        />
      }
    >
      <div className="space-y-3">
        <p style={{ color: "var(--muted)" }}>Turns scanned pages into searchable, selectable text. The page looks exactly the same — an invisible text layer is added behind the image.</p>
        <div>
          <span className="pdf-label">Pages</span>
          <PageScope value={scope} onChange={setScope} />
        </div>
        <Field label="Language">
          <select className="pdf-select" disabled>
            <option>English</option>
          </select>
        </Field>
        <Field label="Accuracy">
          <select className="pdf-select" value={dpi} onChange={(e) => setDpi(+e.target.value)}>
            <option value={200}>Faster (200 dpi)</option>
            <option value={300}>Accurate (300 dpi)</option>
            <option value={400}>Small print (400 dpi)</option>
          </select>
        </Field>
        <label className="pdf-check">
          <input type="checkbox" checked={skip} onChange={(e) => setSkip(e.target.checked)} /> Skip pages that already contain text
        </label>
        <p className="text-[12px]" style={{ color: "var(--faint)" }}>
          Runs entirely in your browser. The first run downloads the OCR engine (~6 MB).
        </p>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */

interface CmpView {
  stats: { inserted: number; deleted: number; replaced: number; wordsA: number; wordsB: number; similarity: number };
  changes: { kind: string; a: { text: string; page: number; x: number; y: number; w: number; h: number }[]; b: { text: string; page: number }[] }[];
  otherName: string;
}

function CompareDialog() {
  const [file, setFile] = useState<File | null>(null);
  const [res, setRes] = useState<CmpView | null>(null);
  if (!needDoc()) return null;
  const words = async (bytes: Uint8Array) => {
    const { openPdf } = await import("@/lib/pdf/pdfjs");
    const { wordsFromTextItems } = await import("@/lib/pdf/tools/compare");
    const pdf = await openPdf(bytes);
    const out: any[] = [];
    for (let i = 0; i < pdf.numPages; i++) {
      const p = await pdf.getPage(i + 1);
      const tc: any = await p.getTextContent();
      out.push(...wordsFromTextItems(tc.items.filter((it: any) => typeof it.str === "string"), p.view, i));
    }
    await pdf.loadingTask.destroy();
    return out;
  };
  const run = async () => {
    if (!file) return;
    const r = await withBusy("Comparing documents…", async () => {
      const a = await words(await buildPdf({ flattenAnnotations: true }));
      const b = await words(new Uint8Array(await file.arrayBuffer()));
      const { compareWords } = await import("@/lib/pdf/tools/compare");
      return { ...compareWords(a, b, { ignorePunctuation: false }), otherName: file.name } as CmpView;
    });
    if (r) setRes(r);
  };
  const markChanges = () => {
    if (!res) return;
    const s = useEditor.getState();
    let n = 0;
    for (const c of res.changes) {
      if (!c.a.length) continue;
      const byPage = new Map<number, Rect[]>();
      for (const w of c.a) byPage.set(w.page, [...(byPage.get(w.page) ?? []), { x: w.x, y: w.y, w: w.w, h: w.h }]);
      for (const [pi, rects] of byPage) {
        const page = s.doc?.pages[pi];
        if (!page) continue;
        const o = makeMarkup(c.kind === "delete" ? "strikeout" : "highlight", rects, c.a.map((w) => w.text).join(" "), page) as any;
        o.color = c.kind === "delete" ? "#d92d20" : "#ffd400";
        o.comment = c.kind === "delete" ? `Not in ${res.otherName}` : `Changed to: “${c.b.map((w) => w.text).join(" ")}”`;
        addObject(page.id, o, false);
        n++;
      }
    }
    toast(`Marked ${n} change${n === 1 ? "" : "s"} as comments.`, "success");
    close();
  };
  return (
    <Modal
      title="Compare files"
      onClose={close}
      width={680}
      footer={
        res ? (
          <>
            <button className="pdf-btn mr-auto" onClick={() => setRes(null)}>
              Compare another
            </button>
            <button className="pdf-btn" onClick={close}>
              Close
            </button>
            <button className="pdf-btn primary" onClick={markChanges} disabled={!res.changes.some((c) => c.a.length)}>
              Mark changes in this document
            </button>
          </>
        ) : (
          <Footer ok="Compare" disabled={!file} onOk={run} />
        )
      }
    >
      {!res ? (
        <div className="space-y-3">
          <p style={{ color: "var(--muted)" }}>Compare the open document (including your edits) with another version to find inserted, deleted and changed text.</p>
          <Field label="Other version">
            <input type="file" accept="application/pdf,.pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </Field>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-4 gap-2 text-center">
            {[
              ["Similarity", `${Math.round(res.stats.similarity * 100)}%`],
              ["Replaced", res.stats.replaced],
              ["Deleted", res.stats.deleted],
              ["Inserted", res.stats.inserted],
            ].map(([l, v]) => (
              <div key={l as string} className="rounded-lg border p-2" style={{ borderColor: "var(--border)" }}>
                <div className="text-[18px] font-semibold">{v}</div>
                <div className="text-[11.5px]" style={{ color: "var(--muted)" }}>
                  {l}
                </div>
              </div>
            ))}
          </div>
          <div className="max-h-[45vh] space-y-1 overflow-auto">
            {!res.changes.length && <p className="py-6 text-center">The documents contain the same text.</p>}
            {res.changes.slice(0, 400).map((c, i) => (
              <div key={i} className="rounded-md border px-2 py-1.5 text-[12.5px]" style={{ borderColor: "var(--border)" }}>
                <span className="mr-2 text-[11px] font-semibold uppercase" style={{ color: c.kind === "insert" ? "var(--success)" : c.kind === "delete" ? "var(--danger)" : "var(--accent)" }}>
                  {c.kind}
                </span>
                <span className="mr-2 text-[11px]" style={{ color: "var(--faint)" }}>
                  p.{(c.a[0]?.page ?? c.b[0]?.page ?? 0) + 1}
                </span>
                {c.a.length > 0 && <del style={{ color: "var(--danger)" }}>{c.a.map((w) => w.text).join(" ")}</del>}
                {c.a.length > 0 && c.b.length > 0 && " → "}
                {c.b.length > 0 && <ins style={{ color: "var(--success)", textDecoration: "none" }}>{c.b.map((w) => w.text).join(" ")}</ins>}
              </div>
            ))}
          </div>
        </div>
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------------ */

async function detectMargins(page: PageModel): Promise<{ t: number; r: number; b: number; l: number } | null> {
  const s = useEditor.getState();
  const src = page.sourceId ? s.sources[page.sourceId] : null;
  if (!src) return null;
  const pg = await getPage(src.pdf, page.sourceIndex);
  const scale = 120 / 72;
  const vp = pg.getViewport({ scale, rotation: 0 });
  const c = document.createElement("canvas");
  c.width = Math.round(vp.width);
  c.height = Math.round(vp.height);
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, c.width, c.height);
  await pg.render({ canvas: c, canvasContext: ctx, viewport: vp, annotationMode: 1 } as any).promise;
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  let x1 = c.width, y1 = c.height, x2 = -1, y2 = -1;
  for (let y = 0; y < c.height; y++)
    for (let x = 0; x < c.width; x++) {
      const i = (y * c.width + x) * 4;
      if (d[i] < 245 || d[i + 1] < 245 || d[i + 2] < 245) {
        if (x < x1) x1 = x;
        if (x > x2) x2 = x;
        if (y < y1) y1 = y;
        if (y > y2) y2 = y;
      }
    }
  if (x2 < 0) return null;
  const pad = 9;
  // margins in unrotated page space
  return { l: Math.max(0, x1 / scale - pad), t: Math.max(0, y1 / scale - pad), r: Math.max(0, (c.width - x2) / scale - pad), b: Math.max(0, (c.height - y2) / scale - pad) };
}

function CropDialog({ d }: { d: D<"crop"> }) {
  const doc = useEditor((s) => s.doc);
  const [scope, setScope] = useState(d.pageIds.length > 1 ? "selected" : "current");
  const [m, setM] = useState({ t: 36, r: 36, b: 36, l: 36 });
  if (!doc) return null;
  const page = doc.pages.find((p) => p.id === d.pageIds[0]) ?? doc.pages[0];
  const rot = displayRotation(page);
  const [dw, dh] = displaySize(page);
  // display-space margins → plane rect
  const planeRect = (p: PageModel): Rect => {
    const r = displayRotation(p);
    const [w, h] = displaySize(p);
    const a = displayToPlane(r, m.l, m.t, p.width, p.height);
    const b = displayToPlane(r, w - m.r, h - m.b, p.width, p.height);
    return { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(b[0] - a[0]), h: Math.abs(b[1] - a[1]) };
  };
  const auto = async () => {
    const mm = await detectMargins(page);
    if (!mm) return toast("Couldn't find page content to detect margins.", "info");
    // convert unrotated margins to display margins
    const map: Record<number, typeof m> = {
      0: { t: mm.t, r: mm.r, b: mm.b, l: mm.l },
      90: { t: mm.l, r: mm.t, b: mm.r, l: mm.b },
      180: { t: mm.b, r: mm.l, b: mm.t, l: mm.r },
      270: { t: mm.r, r: mm.b, b: mm.l, l: mm.t },
    };
    const v = map[rot];
    setM({ t: Math.round(v.t), r: Math.round(v.r), b: Math.round(v.b), l: Math.round(v.l) });
  };
  const k = 220 / dw;
  const valid = m.l + m.r < dw - 10 && m.t + m.b < dh - 10;
  return (
    <Modal
      title="Crop pages"
      onClose={close}
      width={640}
      footer={
        <Footer
          ok="Crop"
          disabled={!valid}
          onOk={() => {
            const pages = scope === "current" || scope === "selected" ? (scope === "current" ? [page] : doc.pages.filter((p) => d.pageIds.includes(p.id))) : scopePages(scope);
            const crops: Record<string, Rect> = {};
            for (const p of pages) {
              const r = planeRect(p);
              if (r.w > 10 && r.h > 10) crops[p.id] = r;
            }
            close();
            rebase({ crops, label: "Cropping…" });
          }}
        />
      }
    >
      <div className="grid gap-5 sm:grid-cols-[1fr_220px]">
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            {(["t", "b", "l", "r"] as const).map((key) => (
              <Field key={key} label={{ t: "Top", b: "Bottom", l: "Left", r: "Right" }[key]}>
                <NumberInput value={m[key]} min={0} max={2000} onChange={(v) => setM({ ...m, [key]: v })} suffix="pt" />
              </Field>
            ))}
          </div>
          <button className="pdf-btn sm" onClick={auto}>
            Remove white margins
          </button>
          <div>
            <span className="pdf-label">Apply to</span>
            <PageScope value={scope} onChange={setScope} />
          </div>
          <p className="text-[12px]" style={{ color: "var(--muted)" }}>
            1 inch = 72 pt. Cropping sets the visible page area; your edits move with the page.
          </p>
        </div>
        <CurrentPageThumb width={220}>
          {() => (
            <div style={{ position: "absolute", left: m.l * k, top: m.t * k, right: m.r * k, bottom: m.b * k, outline: "2px solid #1d6fe0", boxShadow: "0 0 0 999px rgba(15,20,30,.45)" }} />
          )}
        </CurrentPageThumb>
      </div>
    </Modal>
  );
}

function PageSizeDialog({ d }: { d: D<"pageSize"> }) {
  const [size, setSize] = useState("A4");
  const [orient, setOrient] = useState<"auto" | "portrait" | "landscape">("auto");
  const [custom, setCustom] = useState({ w: 612, h: 792 });
  return (
    <Modal
      title="Change page size"
      onClose={close}
      width={460}
      footer={
        <Footer
          ok="Resize"
          onOk={() => {
            const pages = useEditor.getState().doc?.pages.filter((p) => d.pageIds.includes(p.id)) ?? [];
            const resize: Record<string, { w: number; h: number }> = {};
            for (const p of pages) {
              let [w, h] = size === "Custom" ? [custom.w, custom.h] : PAGE_SIZES[size];
              const landscapeNow = displaySize(p)[0] > displaySize(p)[1];
              const wantLandscape = orient === "auto" ? landscapeNow : orient === "landscape";
              // sizes are in the page's unrotated space
              const quarter = displayRotation(p) % 180 !== 0;
              if (wantLandscape !== quarter ? w < h : w > h) [w, h] = [h, w];
              resize[p.id] = { w, h };
            }
            close();
            rebase({ resize, label: "Resizing pages…" });
          }}
        />
      }
    >
      <div className="space-y-3">
        <Field label="Page size">
          <select className="pdf-select" value={size} onChange={(e) => setSize(e.target.value)}>
            {Object.keys(PAGE_SIZES).map((k) => (
              <option key={k}>{k}</option>
            ))}
            <option>Custom</option>
          </select>
        </Field>
        {size === "Custom" && (
          <div className="grid grid-cols-2 gap-2">
            <Field label="Width">
              <NumberInput value={custom.w} min={36} max={14400} onChange={(v) => setCustom({ ...custom, w: v })} suffix="pt" />
            </Field>
            <Field label="Height">
              <NumberInput value={custom.h} min={36} max={14400} onChange={(v) => setCustom({ ...custom, h: v })} suffix="pt" />
            </Field>
          </div>
        )}
        <Field label="Orientation">
          <select className="pdf-select" value={orient} onChange={(e) => setOrient(e.target.value as any)}>
            <option value="auto">Keep each page’s orientation</option>
            <option value="portrait">Portrait</option>
            <option value="landscape">Landscape</option>
          </select>
        </Field>
        <p className="text-[12px]" style={{ color: "var(--muted)" }}>
          Content is scaled to fit and centred. Applies to {d.pageIds.length} page{d.pageIds.length === 1 ? "" : "s"}.
        </p>
      </div>
    </Modal>
  );
}

function NewBlankDialog() {
  const [size, setSize] = useState("Letter");
  const [land, setLand] = useState(false);
  const [count, setCount] = useState(1);
  return (
    <Modal
      title="New blank PDF"
      onClose={close}
      width={420}
      footer={
        <Footer
          ok="Create"
          onOk={() => {
            const [w, h] = PAGE_SIZES[size];
            close();
            newBlankDocument(land ? [h, w] : [w, h], count);
          }}
        />
      }
    >
      <div className="space-y-3">
        <Field label="Page size">
          <select className="pdf-select" value={size} onChange={(e) => setSize(e.target.value)}>
            {Object.keys(PAGE_SIZES).map((k) => (
              <option key={k}>{k}</option>
            ))}
          </select>
        </Field>
        <label className="pdf-check">
          <input type="checkbox" checked={land} onChange={(e) => setLand(e.target.checked)} /> Landscape
        </label>
        <Field label="Number of pages">
          <NumberInput value={count} min={1} max={500} onChange={(v) => setCount(Math.round(v))} />
        </Field>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */

function SaveDialog() {
  const fileName = useEditor((s) => s.fileName);
  const [name, setName] = useState(fileName);
  const [flatComments, setFlatComments] = useState(false);
  const [flatForms, setFlatForms] = useState(false);
  const [strip, setStrip] = useState(false);
  return (
    <Modal
      title="Save as"
      onClose={close}
      width={460}
      footer={
        <Footer
          ok="Save"
          onOk={() => {
            close();
            useEditor.setState({ fileName: /\.pdf$/i.test(name) ? name : `${name}.pdf` });
            saveDocument({ fileName: name, flattenAnnotations: flatComments, flattenForms: flatForms, stripMetadata: strip });
          }}
        />
      }
    >
      <div className="space-y-3">
        <Field label="File name">
          <input className="pdf-input" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <label className="pdf-check">
          <input type="checkbox" checked={flatComments} onChange={(e) => setFlatComments(e.target.checked)} /> Flatten comments into the page
        </label>
        <label className="pdf-check">
          <input type="checkbox" checked={flatForms} onChange={(e) => setFlatForms(e.target.checked)} /> Flatten form fields (no longer fillable)
        </label>
        <label className="pdf-check">
          <input type="checkbox" checked={strip} onChange={(e) => setStrip(e.target.checked)} /> Remove document metadata
        </label>
      </div>
    </Modal>
  );
}

function FlattenDialog() {
  return (
    <Modal
      title="Flatten"
      onClose={close}
      width={460}
      footer={
        <Footer
          ok="Save flattened copy"
          onOk={() => {
            close();
            saveDocument({ flattenAnnotations: true, flattenForms: true, fileName: `${baseName(useEditor.getState().fileName)}-flattened.pdf` });
          }}
        />
      }
    >
      <p>Merges all form fields and comments into the page content so they can’t be changed. A flattened copy is downloaded; your working document is unchanged.</p>
    </Modal>
  );
}

function SanitizeDialog() {
  return (
    <Modal
      title="Sanitize document"
      onClose={close}
      width={500}
      footer={
        <Footer
          ok="Save sanitized copy"
          onOk={() => {
            close();
            saveDocument({ sanitize: true, fileName: `${baseName(useEditor.getState().fileName)}-sanitized.pdf` });
          }}
        />
      }
    >
      <p className="mb-2">Removes hidden information before you share the file:</p>
      <ul className="list-disc space-y-1 pl-5" style={{ color: "var(--muted)" }}>
        <li>Metadata (author, title, XMP, creation tools)</li>
        <li>Embedded files and file attachments</li>
        <li>JavaScript, automatic actions and links that launch programs</li>
        <li>Page thumbnails and private application data</li>
        <li>Content deleted earlier (unreferenced objects are always discarded)</li>
      </ul>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */

function ApplyRedactionsDialog() {
  const count = useEditor((s) => s.doc?.pages.reduce((n, p) => n + p.objects.filter((o) => o.type === "redact").length, 0) ?? 0);
  return (
    <Modal
      title="Apply redactions"
      onClose={close}
      width={480}
      footer={
        <Footer
          ok={`Apply ${count} redaction${count === 1 ? "" : "s"}`}
          disabled={!count}
          onOk={() => {
            close();
            applyRedactions();
          }}
        />
      }
    >
      {count ? (
        <p>
          The text, images and graphics under the {count} marked area{count === 1 ? "" : "s"} will be <strong>permanently removed</strong> from the document — not just covered. You can still undo in this session until you close the file.
        </p>
      ) : (
        <p>No areas are marked yet. Use Redact text, Redact area or Find & redact first.</p>
      )}
    </Modal>
  );
}

const PATTERNS: { id: string; label: string; re: RegExp }[] = [
  { id: "email", label: "Email addresses", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { id: "phone", label: "Phone numbers", re: /(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)|\d{2,4})[\s.-]?\d{3,4}[\s.-]?\d{3,4}/g },
  { id: "card", label: "Credit card numbers", re: /\b(?:\d[ -]?){13,19}\b/g },
  { id: "ssn", label: "US Social Security numbers", re: /\b\d{3}-\d{2}-\d{4}\b/g },
  { id: "date", label: "Dates", re: /\b(?:\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{4}-\d{2}-\d{2}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.? \d{1,2},? \d{4})\b/g },
  { id: "url", label: "Web addresses", re: /\bhttps?:\/\/[^\s]+|\bwww\.[^\s]+/g },
  { id: "money", label: "Amounts of money", re: /[$€£]\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:million|billion|[MBK]))?/g },
];

function SearchRedactDialog() {
  const [text, setText] = useState("");
  const [pats, setPats] = useState<string[]>([]);
  const [caseSens, setCaseSens] = useState(false);
  const [found, setFound] = useState<{ pageId: string; rects: Rect[]; text: string }[] | null>(null);
  const scan = async () => {
    const s = useEditor.getState();
    if (!s.doc) return;
    const res: { pageId: string; rects: Rect[]; text: string }[] = [];
    const regs: RegExp[] = PATTERNS.filter((p) => pats.includes(p.id)).map((p) => new RegExp(p.re.source, "g"));
    for (const t of text.split(/\n|;/).map((x) => x.trim()).filter(Boolean)) {
      regs.push(new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"), caseSens ? "g" : "gi"));
    }
    await withBusy("Searching…", async () => {
      for (const page of s.doc!.pages) {
        const r = await pageRuns(page).catch(() => null);
        if (!r) continue;
        for (const re of regs) {
          re.lastIndex = 0;
          let m: RegExpExecArray | null;
          while ((m = re.exec(r.text))) {
            if (!m[0].length) {
              re.lastIndex++;
              continue;
            }
            const rects = rangeRects(r.runs, r.offsets, m.index, m.index + m[0].length);
            if (rects.length) res.push({ pageId: page.id, rects, text: m[0] });
          }
        }
      }
    });
    setFound(res);
  };
  const markAll = () => {
    if (!found) return;
    mutate((d) => ({
      ...d,
      pages: d.pages.map((p) => {
        const mine = found.filter((f) => f.pageId === p.id);
        if (!mine.length) return p;
        return { ...p, objects: [...p.objects, ...mine.map((f) => makeRedaction(f.rects.map((r) => ({ x: r.x - 0.5, y: r.y - 0.5, w: r.w + 1, h: r.h + 1 })), p, f.text))] };
      }),
    }));
    toast(`Marked ${found.length} item${found.length === 1 ? "" : "s"} for redaction. Review them, then click Apply.`, "success", 6000);
    close();
  };
  return (
    <Modal
      title="Find & redact"
      onClose={close}
      width={560}
      footer={found ? <Footer ok={`Mark ${found.length} for redaction`} disabled={!found.length} onOk={markAll} extra={<button className="pdf-btn mr-auto" onClick={() => setFound(null)}>Back</button>} /> : <Footer ok="Find" disabled={!text.trim() && !pats.length} onOk={scan} />}
    >
      {!found ? (
        <div className="space-y-3">
          <Field label="Words or phrases" hint="One per line">
            <textarea className="pdf-textarea" rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder={"Jordan Rivera\nNorthwind"} />
          </Field>
          <label className="pdf-check">
            <input type="checkbox" checked={caseSens} onChange={(e) => setCaseSens(e.target.checked)} /> Match case
          </label>
          <div>
            <span className="pdf-label">Patterns</span>
            <div className="grid grid-cols-2 gap-1.5">
              {PATTERNS.map((p) => (
                <label key={p.id} className="pdf-check">
                  <input type="checkbox" checked={pats.includes(p.id)} onChange={(e) => setPats(e.target.checked ? [...pats, p.id] : pats.filter((x) => x !== p.id))} /> {p.label}
                </label>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div className="max-h-[50vh] space-y-1 overflow-auto">
          {!found.length && <p className="py-6 text-center">No matches found.</p>}
          {found.map((f, i) => {
            const idx = useEditor.getState().doc?.pages.findIndex((p) => p.id === f.pageId) ?? 0;
            return (
              <div key={i} className="flex gap-2 rounded-md border px-2 py-1 text-[12.5px]" style={{ borderColor: "var(--border)" }}>
                <span style={{ color: "var(--faint)" }}>p.{idx + 1}</span>
                <span className="truncate">{f.text}</span>
              </div>
            );
          })}
        </div>
      )}
    </Modal>
  );
}

function LinkDialog({ d }: { d: D<"link"> }) {
  const obj = useEditor((s) => s.doc?.pages.find((p) => p.id === d.pageId)?.objects.find((o) => o.id === d.objId));
  const pages = useEditor((s) => s.doc?.pages ?? []);
  const [kind, setKind] = useState<"url" | "page">(obj && obj.type === "link" && obj.pageId ? "page" : "url");
  const [url, setUrl] = useState(obj && obj.type === "link" ? obj.url : "");
  const [target, setTarget] = useState(obj && obj.type === "link" && obj.pageId ? obj.pageId : pages[0]?.id ?? "");
  if (!obj || obj.type !== "link") return null;
  return (
    <Modal
      title="Link"
      onClose={close}
      width={440}
      footer={
        <Footer
          ok="Save link"
          onOk={() => {
            const fixed = kind === "url" && url && !/^[a-z][a-z0-9+.-]*:/i.test(url) ? `https://${url}` : url;
            mutate((doc) => ({ ...doc, pages: doc.pages.map((p) => (p.id === d.pageId ? { ...p, objects: p.objects.map((o) => (o.id === d.objId ? ({ ...o, url: kind === "url" ? fixed : "", pageId: kind === "page" ? target : null } as any) : o)) } : p)) }));
            close();
          }}
        />
      }
    >
      <div className="space-y-3">
        <div className="pdf-seg">
          <button className={kind === "url" ? "active" : ""} onClick={() => setKind("url")}>
            Web address
          </button>
          <button className={kind === "page" ? "active" : ""} onClick={() => setKind("page")}>
            Page in document
          </button>
        </div>
        {kind === "url" ? (
          <Field label="URL">
            <input autoFocus className="pdf-input" value={url} placeholder="https://example.com" onChange={(e) => setUrl(e.target.value)} />
          </Field>
        ) : (
          <Field label="Go to page">
            <select className="pdf-select" value={target} onChange={(e) => setTarget(e.target.value)}>
              {pages.map((p, i) => (
                <option key={p.id} value={p.id}>
                  Page {i + 1}
                </option>
              ))}
            </select>
          </Field>
        )}
      </div>
    </Modal>
  );
}

function ShortcutsDialog() {
  const rows: [string, string][] = [
    ["Ctrl/⌘ + O", "Open"],
    ["Ctrl/⌘ + S", "Save (download)"],
    ["Ctrl/⌘ + Shift + S", "Save as…"],
    ["Ctrl/⌘ + P", "Print"],
    ["Ctrl/⌘ + Z / Shift + Z", "Undo / redo"],
    ["Ctrl/⌘ + F", "Find"],
    ["Ctrl/⌘ + + / −", "Zoom in / out"],
    ["Ctrl/⌘ + 0 / 1 / 2", "Fit page / 100% / fit width"],
    ["Ctrl/⌘ + C / X / V", "Copy / cut / paste objects"],
    ["Ctrl/⌘ + D", "Duplicate selection (or properties)"],
    ["Delete", "Delete selection"],
    ["Arrow keys", "Nudge selection (Shift = 10pt)"],
    ["Enter", "Edit selected text"],
    ["Esc", "Deselect / back to Select tool"],
    ["Page Up / Down, Home / End", "Navigate pages"],
    ["V H E T", "Select · Hand · Edit text · Add text"],
    ["R O L A P", "Rectangle · Oval · Line · Arrow · Draw"],
    ["N U", "Sticky note · Highlight"],
    ["Shift while drawing", "Square / circle / 45° lines; keep tool active"],
  ];
  return (
    <Modal title="Keyboard shortcuts" onClose={close} width={520} footer={<button className="pdf-btn" onClick={close}>Close</button>}>
      <table className="w-full text-[12.5px]">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k} className="border-b" style={{ borderColor: "var(--border)" }}>
              <td className="py-1.5 pr-3">
                <span className="pdf-kbd">{k}</span>
              </td>
              <td className="py-1.5">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}
