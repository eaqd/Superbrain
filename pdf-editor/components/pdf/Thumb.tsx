"use client";
import { memo, useEffect, useRef, useState } from "react";
import type { PageModel } from "@/lib/pdf/types";
import { useEditor } from "@/lib/pdf/store";
import { thumbnail } from "@/lib/pdf/thumbs";
import { displayRotation, displaySize } from "@/lib/pdf/geometry";
import { planeTransform } from "@/lib/pdf/util";
import { ObjectBody, RectsBody } from "./objects";

/** Page thumbnail with rotation and a light rendering of editor objects. */
export const PageThumb = memo(function PageThumb({ page, width, showObjects = true }: { page: PageModel; width: number; showObjects?: boolean }) {
  const src = useEditor((s) => (page.sourceId ? s.sources[page.sourceId] : undefined));
  const ref = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [inView, setInView] = useState(false);
  const [dw, dh] = displaySize(page);
  const k = width / dw;
  const rot = displayRotation(page);
  const pw = page.width * k;
  const ph = page.height * k;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setInView(true), { rootMargin: "300px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!inView || !src) return;
    let live = true;
    thumbnail(src, page.sourceIndex, Math.max(pw, ph))
      .then((u) => live && setUrl(u))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [inView, src, page.sourceIndex, pw, ph]);

  return (
    <div ref={ref} className="pdf-thumb" style={{ width, height: dh * k }}>
      <div style={{ position: "absolute", left: 0, top: 0, width: pw, height: ph, transformOrigin: "0 0", transform: planeTransform(rot, pw, ph) }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {url ? <img src={url} alt="" draggable={false} /> : src ? <div className="h-full w-full animate-pulse" style={{ background: "#f1f2f4" }} /> : null}
        {showObjects &&
          page.objects.map((o) =>
            o.type === "highlight" || o.type === "underline" || o.type === "strikeout" || o.type === "squiggly" || (o.type === "redact" && o.rects.length) ? (
              <div key={o.id} style={{ position: "absolute", inset: 0 }}>
                <RectsBody o={o} s={k} />
              </div>
            ) : (
              <div key={o.id} style={{ position: "absolute", left: o.x * k, top: o.y * k, width: o.w * k, height: o.h * k, opacity: o.opacity }}>
                {o.type === "text" && o.replaces && <div style={{ position: "absolute", inset: 0, background: o.replaces.color }} />}
                <ObjectBody o={o} s={k} />
              </div>
            ),
          )}
      </div>
    </div>
  );
});
