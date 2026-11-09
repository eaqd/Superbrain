"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";

export function Modal({
  title,
  onClose,
  children,
  footer,
  width = 480,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return (
    <div className="pdf-modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="pdf-modal" style={{ maxWidth: width }} role="dialog" aria-modal="true">
        <div className="flex items-center justify-between border-b px-5 py-3.5" style={{ borderColor: "var(--border)" }}>
          <h2 className="text-[15px] font-semibold">{title}</h2>
          <button className="pdf-icon-btn sm" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="pdf-scroll min-h-0 flex-1 overflow-auto px-5 py-4">{children}</div>
        {footer && (
          <div className="flex items-center justify-end gap-2 border-t px-5 py-3" style={{ borderColor: "var(--border)", background: "var(--panel-2)" }}>
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

export function Field({ label, children, hint }: { label: ReactNode; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="block">
      <span className="pdf-label">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11.5px]" style={{ color: "var(--faint)" }}>{hint}</span>}
    </label>
  );
}

export const PALETTE = ["#000000", "#5f6368", "#ffffff", "#d92d20", "#f97316", "#ffd400", "#16a34a", "#0ea5e9", "#1d6fe0", "#7c3aed", "#db2777", "#8b5e34"];

export function ColorPicker({
  value,
  onChange,
  allowNone = false,
  colors = PALETTE,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
  allowNone?: boolean;
  colors?: string[];
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {allowNone && (
        <button type="button" className={`pdf-swatch none ${value === null ? "active" : ""}`} title="None" onClick={() => onChange(null)} />
      )}
      {colors.map((c) => (
        <button
          key={c}
          type="button"
          className={`pdf-swatch ${value?.toLowerCase() === c ? "active" : ""}`}
          style={{ background: c }}
          title={c}
          onClick={() => onChange(c)}
        />
      ))}
      <label className="pdf-swatch relative overflow-hidden" title="Custom colour" style={{ background: "conic-gradient(red, yellow, lime, aqua, blue, magenta, red)" }}>
        <input type="color" className="absolute inset-0 cursor-pointer opacity-0" value={value ?? "#000000"} onChange={(e) => onChange(e.target.value)} />
      </label>
    </div>
  );
}

/** Small dropdown menu anchored to its trigger. */
export function Menu({
  trigger,
  children,
  align = "left",
  className = "",
}: {
  trigger: (open: boolean, toggle: () => void) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: "left" | "right";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div className={`relative ${className}`} ref={ref}>
      {trigger(open, () => setOpen((o) => !o))}
      {open && (
        <div className="pdf-menu" style={{ top: "calc(100% + 4px)", [align]: 0 }}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function MenuItem({
  icon,
  label,
  hint,
  onClick,
  disabled,
  danger,
}: {
  icon?: ReactNode;
  label: ReactNode;
  hint?: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button className="pdf-menu-item" onClick={onClick} disabled={disabled} style={danger ? { color: "var(--danger)" } : undefined}>
      <span className="flex w-4 justify-center" style={{ color: danger ? "var(--danger)" : "var(--muted)" }}>
        {icon}
      </span>
      <span>{label}</span>
      {hint && <span className="hint">{hint}</span>}
    </button>
  );
}

export function NumberInput({
  value,
  onChange,
  min,
  max,
  step = 1,
  suffix,
  className = "",
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  className?: string;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(Math.round(value * 100) / 100)), [value]);
  const commit = () => {
    const n = parseFloat(text);
    if (Number.isFinite(n)) onChange(Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n)));
    else setText(String(value));
  };
  return (
    <div className={`relative ${className}`}>
      <input
        className="pdf-input pr-7"
        type="number"
        value={text}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          setText(e.target.value);
          const n = parseFloat(e.target.value);
          if (Number.isFinite(n) && (min === undefined || n >= min) && (max === undefined || n <= max)) onChange(n);
        }}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && commit()}
      />
      {suffix && <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[11px]" style={{ color: "var(--faint)" }}>{suffix}</span>}
    </div>
  );
}
