"use client";
/* Pure renderers for editor objects inside a page plane (CSS px = pt × scale). */
import type { CSSProperties, ReactNode } from "react";
import type { EditObj, FieldObj, Rect, StampObj, TextObj } from "@/lib/pdf/types";
import { CSS_FONT, CSS_METRICS, TEXT_PAD, layoutText } from "@/lib/pdf/textLayout";
import { localSize } from "@/lib/pdf/geometry";

/** Inner, rotated box that holds an object's upright content. */
export function Upright({ o, s, children, style }: { o: EditObj; s: number; children: ReactNode; style?: CSSProperties }) {
  const [lw, lh] = localSize(o);
  return (
    <div
      style={{
        position: "absolute",
        left: (o.w * s - lw * s) / 2,
        top: (o.h * s - lh * s) / 2,
        width: lw * s,
        height: lh * s,
        transform: o.rotate ? `rotate(${o.rotate}deg)` : undefined,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export function TextContent({ o, s, hideText }: { o: TextObj; s: number; hideText?: boolean }) {
  const [lw] = localSize(o);
  const layout = layoutText(o.text, o, o.autoWidth ? null : Math.max(4, lw - TEXT_PAD * 2));
  const L = layout.lineHeight;
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: o.fill ?? undefined,
        border: o.border && o.borderWidth ? `${o.borderWidth * s}px solid ${o.border}` : undefined,
        padding: TEXT_PAD * s - (o.border ? o.borderWidth * s : 0),
        fontFamily: CSS_FONT[o.font],
        fontWeight: o.bold ? 700 : 400,
        fontStyle: o.italic ? "italic" : "normal",
        fontSize: o.size * s,
        color: o.color,
        lineHeight: `${L * s}px`,
        textAlign: o.align,
        whiteSpace: "pre",
        visibility: hideText ? "hidden" : undefined,
        overflow: "visible",
      }}
    >
      {layout.lines.map((line, i) => (
        <div key={i} style={{ height: L * s }}>
          {line || "​"}
        </div>
      ))}
    </div>
  );
}

function StampSvg({ o, w, h }: { o: StampObj; w: number; h: number }) {
  const bw = Math.max(1.5, Math.min(w, h) * 0.045);
  const hasSub = !!o.sub;
  return (
    <svg width="100%" height="100%" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ overflow: "visible" }}>
      <rect x={bw / 2} y={bw / 2} width={w - bw} height={h - bw} rx={Math.min(w, h) * 0.18} fill="none" stroke={o.color} strokeWidth={bw} />
      <text
        x={w / 2}
        y={hasSub ? h * 0.52 : h / 2}
        dominantBaseline={hasSub ? "auto" : "central"}
        textAnchor="middle"
        fill={o.color}
        fontFamily="Helvetica, Arial, sans-serif"
        fontWeight={700}
        fontSize={h * (hasSub ? 0.4 : 0.56)}
        textLength={o.label.length > 3 ? w * 0.84 : undefined}
        lengthAdjust="spacingAndGlyphs"
      >
        {o.label}
      </text>
      {hasSub && (
        <text x={w / 2} y={h * 0.8} textAnchor="middle" fill={o.color} fontFamily="Helvetica, Arial, sans-serif" fontSize={h * 0.17}>
          {o.sub}
        </text>
      )}
    </svg>
  );
}

function FieldBox({ o, s }: { o: FieldObj; s: number }) {
  const label: Record<FieldObj["fieldType"], string> = {
    text: "Text",
    checkbox: "☐",
    radio: "◯",
    dropdown: "▾",
    listbox: "List",
    signature: "✍ Sign",
    button: "Button",
  };
  const small = o.fieldType === "checkbox" || o.fieldType === "radio";
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        border: `${Math.max(1, s)}px solid #5b8def`,
        background: "rgba(91,141,239,0.12)",
        borderRadius: o.fieldType === "radio" ? "50%" : 2,
        display: "flex",
        alignItems: "center",
        justifyContent: small ? "center" : "space-between",
        padding: small ? 0 : `0 ${3 * s}px`,
        fontSize: Math.max(8, Math.min(o.h * 0.5, 11)) * s,
        color: "#2b5bc4",
        fontFamily: "Helvetica, Arial, sans-serif",
        overflow: "hidden",
        whiteSpace: "nowrap",
      }}
    >
      {small ? (
        o.checked ? "✓" : ""
      ) : (
        <>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{o.value || o.name}</span>
          <span style={{ opacity: 0.7 }}>{label[o.fieldType]}</span>
        </>
      )}
    </div>
  );
}

export function arrowHead(x1: number, y1: number, x2: number, y2: number, sw: number) {
  // in screen space (y down): mirror of the export math in draw.ts
  const ang = Math.atan2(y2 - y1, x2 - x1);
  const len = Math.max(9, sw * 4.5);
  return [Math.PI - 0.5, Math.PI + 0.5].map((d) => [x2 + len * Math.cos(ang + d), y2 + len * Math.sin(ang + d)]);
}

function inkPath(points: number[], ox: number, oy: number, s: number) {
  if (points.length < 2) return "";
  const P = (i: number) => [(points[i] - ox) * s, (points[i + 1] - oy) * s];
  let d = `M${P(0).join(" ")}`;
  if (points.length === 2) return d + ` l0.01 0`;
  for (let i = 2; i < points.length - 2; i += 2) {
    const [x0, y0] = P(i);
    const [x1, y1] = P(i + 2);
    d += ` Q${x0} ${y0} ${(x0 + x1) / 2} ${(y0 + y1) / 2}`;
  }
  const [lx, ly] = P(points.length - 2);
  return d + ` L${lx} ${ly}`;
}

/** Render body of any object, positioned at its bbox. */
export function ObjectBody({ o, s, editing }: { o: EditObj; s: number; editing?: boolean }) {
  const W = o.w * s;
  const H = o.h * s;
  switch (o.type) {
    case "text":
      return (
        <Upright o={o} s={s}>
          <TextContent o={o} s={s} hideText={editing} />
        </Upright>
      );
    case "image":
      return (
        <Upright o={o} s={s}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={o.src} alt="" draggable={false} style={{ width: "100%", height: "100%", display: "block", userSelect: "none" }} />
        </Upright>
      );
    case "rect":
    case "ellipse": {
      const sw = o.stroke ? o.strokeWidth * s : 0;
      const [lw, lh] = localSize(o);
      const w = lw * s;
      const h = lh * s;
      return (
        <Upright o={o} s={s}>
          <svg width={w} height={h} style={{ position: "absolute", inset: 0, overflow: "visible" }}>
            {o.type === "rect" ? (
              <rect x={sw / 2} y={sw / 2} width={Math.max(0, w - sw)} height={Math.max(0, h - sw)} fill={o.fill ?? "none"} stroke={o.stroke ?? "none"} strokeWidth={sw} strokeDasharray={o.dash ? `${sw * 3} ${sw * 2}` : undefined} />
            ) : (
              <ellipse cx={w / 2} cy={h / 2} rx={Math.max(0, (w - sw) / 2)} ry={Math.max(0, (h - sw) / 2)} fill={o.fill ?? "none"} stroke={o.stroke ?? "none"} strokeWidth={sw} strokeDasharray={o.dash ? `${sw * 3} ${sw * 2}` : undefined} />
            )}
          </svg>
        </Upright>
      );
    }
    case "line":
    case "arrow": {
      const sw = o.strokeWidth * s;
      const x1 = (o.x1 - o.x) * s, y1 = (o.y1 - o.y) * s, x2 = (o.x2 - o.x) * s, y2 = (o.y2 - o.y) * s;
      const head = o.type === "arrow" ? arrowHead(x1, y1, x2, y2, sw) : null;
      return (
        <svg width={W} height={H} style={{ position: "absolute", inset: 0, overflow: "visible" }}>
          <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={o.stroke} strokeWidth={sw} strokeLinecap="round" strokeDasharray={o.dash ? `${sw * 3} ${sw * 2}` : undefined} />
          {head && <polyline points={`${head[0].join(",")} ${x2},${y2} ${head[1].join(",")}`} fill="none" stroke={o.stroke} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />}
        </svg>
      );
    }
    case "ink":
      return (
        <svg width={W} height={H} style={{ position: "absolute", inset: 0, overflow: "visible" }}>
          {o.paths.map((p, i) => (
            <path key={i} d={inkPath(p, o.x, o.y, s)} fill="none" stroke={o.stroke} strokeWidth={o.strokeWidth * s} strokeLinecap="round" strokeLinejoin="round" />
          ))}
        </svg>
      );
    case "note":
      return (
        <svg width={W} height={H} viewBox="0 0 22 22" style={{ position: "absolute", inset: 0, filter: "drop-shadow(0 1px 1px rgba(0,0,0,.25))" }}>
          <path d="M3 2.5h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H11l-5 4v-4H3a2 2 0 0 1-2-2v-10a2 2 0 0 1 2-2z" fill={o.color} stroke="#3a3a3a" strokeWidth="0.9" />
          <path d="M5.5 6.5h11M5.5 9.5h11M5.5 12.5h7" stroke="#3a3a3a" strokeWidth="1" />
        </svg>
      );
    case "stamp": {
      const [lw, lh] = localSize(o);
      return (
        <Upright o={o} s={s}>
          <StampSvg o={o} w={lw * s} h={lh * s} />
        </Upright>
      );
    }
    case "mark": {
      const [lw, lh] = localSize(o);
      const w = lw * s;
      const h = lh * s;
      const sw = Math.max(1, Math.min(w, h) * 0.12);
      return (
        <Upright o={o} s={s}>
          <svg width={w} height={h} style={{ position: "absolute", inset: 0, overflow: "visible" }} fill="none" stroke={o.color} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round">
            {o.mark === "check" && <polyline points={`${w * 0.12},${h * 0.48} ${w * 0.4},${h * 0.8} ${w * 0.9},${h * 0.15}`} />}
            {o.mark === "cross" && <path d={`M${w * 0.15} ${h * 0.15}L${w * 0.85} ${h * 0.85}M${w * 0.15} ${h * 0.85}L${w * 0.85} ${h * 0.15}`} />}
            {o.mark === "dot" && <ellipse cx={w / 2} cy={h / 2} rx={w * 0.35} ry={h * 0.35} fill={o.color} stroke="none" />}
            {o.mark === "dash" && <path d={`M${w * 0.1} ${h / 2}H${w * 0.9}`} />}
          </svg>
        </Upright>
      );
    }
    case "link":
      return <div style={{ position: "absolute", inset: 0, border: `${Math.max(1, s)}px dashed #1d6fe0`, background: "rgba(29,111,224,0.08)" }} />;
    case "field":
      return <FieldBox o={o} s={s} />;
    default:
      return null;
  }
}

/** Markups & redactions are drawn per-rect in plane coordinates. */
export function RectsBody({ o, s, interactive }: { o: Extract<EditObj, { type: "highlight" | "underline" | "strikeout" | "squiggly" | "redact" }>; s: number; interactive?: boolean }) {
  const rects: Rect[] = o.type === "redact" ? (o.rects.length ? o.rects : [o]) : o.rects;
  return (
    <>
      {rects.map((r, i) => {
        const st: CSSProperties = { position: "absolute", left: r.x * s, top: r.y * s, width: r.w * s, height: r.h * s, pointerEvents: interactive ? "auto" : "none", cursor: interactive ? "pointer" : undefined };
        if (o.type === "highlight") return <div key={i} style={{ ...st, background: o.color, mixBlendMode: "multiply", opacity: o.opacity }} />;
        if (o.type === "redact")
          return (
            <div key={i} className="pdf-redact-mark" style={{ ...st, border: `${Math.max(1, s * 1.2)}px solid #d92d20`, background: "repeating-linear-gradient(45deg, rgba(217,45,32,.18) 0 4px, rgba(217,45,32,.06) 4px 8px)" }}>
              {i === 0 && o.overlayText && <span style={{ fontSize: Math.min(r.h * 0.6, 12) * s, color: "#d92d20", paddingLeft: 2, whiteSpace: "nowrap" }}>{o.overlayText}</span>}
            </div>
          );
        const lw = Math.max(1, r.h * 0.07 * s);
        const step = Math.max(2, r.h * 0.15);
        return (
          <div key={i} style={st}>
            {o.type === "underline" && <div style={{ position: "absolute", left: 0, right: 0, top: r.h * 0.92 * s - lw / 2, height: lw, background: o.color, opacity: o.opacity }} />}
            {o.type === "strikeout" && <div style={{ position: "absolute", left: 0, right: 0, top: r.h * 0.55 * s - lw / 2, height: lw, background: o.color, opacity: o.opacity }} />}
            {o.type === "squiggly" && (
              <svg style={{ position: "absolute", left: 0, top: r.h * 0.8 * s, overflow: "visible" }} width={r.w * s} height={r.h * 0.2 * s}>
                <polyline
                  fill="none"
                  stroke={o.color}
                  strokeWidth={lw}
                  opacity={o.opacity}
                  points={Array.from({ length: Math.max(2, Math.floor(r.w / step) + 1) }, (_, k) => `${k * step * s},${k % 2 ? 0 : r.h * 0.12 * s}`).join(" ")}
                />
              </svg>
            )}
          </div>
        );
      })}
    </>
  );
}

export { CSS_METRICS };
