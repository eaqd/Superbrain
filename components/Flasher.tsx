"use client";

import { useEffect, useRef, useState } from "react";
import { digitFor } from "@/lib/digits";

type Props = {
  sequence: number[];
  msPerDigit: number;
  training: boolean;
  onComplete: () => void;
};

export function Flasher({ sequence, msPerDigit, training, onComplete }: Props) {
  const [index, setIndex] = useState(0);
  const startedAt = useRef<number>(0);
  const rafId = useRef<number>(0);
  const completedRef = useRef(false);

  useEffect(() => {
    completedRef.current = false;
    startedAt.current = performance.now();
    setIndex(0);

    const tick = () => {
      const elapsed = performance.now() - startedAt.current;
      const next = Math.floor(elapsed / msPerDigit);
      if (next >= sequence.length) {
        if (!completedRef.current) {
          completedRef.current = true;
          onComplete();
        }
        return;
      }
      setIndex(next);
      rafId.current = window.requestAnimationFrame(tick);
    };

    rafId.current = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(rafId.current);
  }, [sequence, msPerDigit, onComplete]);

  const current = sequence[index];
  const entry = digitFor(current);

  return (
    <div className="flex flex-col items-center">
      <div className="flex items-baseline justify-center gap-2 text-xs text-ink/55">
        <span className="font-display tracking-[0.3em] uppercase">
          {index + 1} / {sequence.length}
        </span>
      </div>

      <div
        key={index}
        className="mt-3 flex h-56 w-full max-w-sm animate-flash items-center justify-center gap-6 rounded-3xl border border-ink/10 bg-parchment-deep/40 shadow-leaf"
      >
        <span className="font-display text-[160px] font-black leading-none text-ink">
          {current}
        </span>
        {training && (
          <div className="flex flex-col items-center">
            <span className="text-[64px] leading-none">{entry.emoji}</span>
            <span className="mt-2 font-display text-[10px] uppercase tracking-[0.3em] text-crimson">
              {entry.name}
            </span>
          </div>
        )}
      </div>

      <div className="mt-5 flex items-center gap-1.5">
        {sequence.map((_, i) => (
          <span
            key={i}
            className={`h-1.5 rounded-full transition-all ${
              i < index
                ? "w-4 bg-ink/30"
                : i === index
                  ? "w-6 bg-crimson"
                  : "w-1.5 bg-ink/15"
            }`}
          />
        ))}
      </div>
    </div>
  );
}
