"use client";

import { useEffect, useRef, useState, type PointerEvent } from "react";
import { DIGITS } from "@/lib/digits";
import { BackLink } from "@/components/BackLink";

const SWIPE_THRESHOLD = 60;

export default function LearnPage() {
  const [index, setIndex] = useState(0);
  const [dragX, setDragX] = useState(0);
  const startX = useRef<number | null>(null);

  const entry = DIGITS[index];
  const total = DIGITS.length;

  const go = (delta: number) => {
    setIndex((i) => Math.max(0, Math.min(total - 1, i + delta)));
    setDragX(0);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") {
        setIndex((i) => Math.min(total - 1, i + 1));
        setDragX(0);
      } else if (e.key === "ArrowLeft") {
        setIndex((i) => Math.max(0, i - 1));
        setDragX(0);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [total]);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    startX.current = e.clientX;
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (startX.current === null) return;
    setDragX(e.clientX - startX.current);
  };
  const onPointerUp = () => {
    if (startX.current === null) return;
    if (dragX > SWIPE_THRESHOLD) go(-1);
    else if (dragX < -SWIPE_THRESHOLD) go(1);
    else setDragX(0);
    startX.current = null;
  };

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-6 pb-12 pt-[max(env(safe-area-inset-top),2rem)]">
      <div className="flex items-center justify-between">
        <BackLink />
        <span className="font-display text-xs uppercase tracking-[0.32em] text-ink/55">
          Codex · {String(index + 1).padStart(2, "0")} / {total}
        </span>
      </div>

      <div className="rule mt-5" />

      <div
        className="relative mt-8 select-none touch-pan-y"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <article
          key={entry.digit}
          className="animate-rise rounded-3xl border border-ink/10 bg-parchment-deep/40 p-7 shadow-leaf"
          style={{
            transform: `translateX(${dragX * 0.35}px) rotate(${dragX * 0.02}deg)`,
            transition: startX.current === null ? "transform 220ms" : "none",
          }}
        >
          <div className="flex items-baseline justify-between">
            <span className="font-display text-[12px] uppercase tracking-[0.3em] text-ink/55">
              Digit
            </span>
            <span className="font-display text-[12px] uppercase tracking-[0.3em] text-ink/55">
              Image
            </span>
          </div>

          <div className="mt-4 grid grid-cols-2 items-center gap-2">
            <div className="flex h-44 items-center justify-center rounded-2xl bg-parchment shadow-press">
              <span className="font-display text-[140px] font-black leading-none text-ink">
                {entry.digit}
              </span>
            </div>
            <div className="flex h-44 items-center justify-center rounded-2xl bg-parchment shadow-press">
              <span className="text-[100px] leading-none">{entry.emoji}</span>
            </div>
          </div>

          <div className="mt-6">
            <p className="font-display text-[11px] uppercase tracking-[0.3em] text-crimson">
              {entry.name}
            </p>
            <p className="mt-2 font-display text-xl italic leading-snug text-ink/85">
              {entry.reason}
            </p>
          </div>
        </article>
      </div>

      <div className="mt-7 flex items-center justify-between">
        <button
          onClick={() => go(-1)}
          disabled={index === 0}
          className="font-display text-sm text-ink/65 transition disabled:opacity-30 hover:text-ink"
        >
          ← Prev
        </button>
        <div className="flex items-center gap-1.5" aria-label="progress">
          {DIGITS.map((d, i) => (
            <button
              key={d.digit}
              aria-label={`Go to digit ${d.digit}`}
              onClick={() => {
                setIndex(i);
                setDragX(0);
              }}
              className={`h-1.5 rounded-full transition-all ${
                i === index ? "w-6 bg-crimson" : "w-1.5 bg-ink/20"
              }`}
            />
          ))}
        </div>
        <button
          onClick={() => go(1)}
          disabled={index === total - 1}
          className="font-display text-sm text-ink/65 transition disabled:opacity-30 hover:text-ink"
        >
          Next →
        </button>
      </div>

      <p className="mt-6 text-center text-xs text-ink/45">
        Swipe, tap a dot, or use ← →.
      </p>
    </main>
  );
}
