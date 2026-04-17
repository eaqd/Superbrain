"use client";

import type { DigitEntry } from "@/lib/digits";

type Status = "idle" | "correct" | "wrong" | "reveal" | "muted";

const styles: Record<Status, string> = {
  idle: "bg-parchment hover:bg-parchment-deep border-ink/10",
  correct: "bg-gold/20 border-gold ring-2 ring-gold",
  wrong: "bg-crimson/15 border-crimson animate-shake",
  reveal: "bg-gold/15 border-gold/70",
  muted: "bg-parchment/70 border-ink/10 opacity-60",
};

export function ChoiceTile({
  entry,
  status = "idle",
  onPress,
  disabled,
}: {
  entry: DigitEntry;
  status?: Status;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onPress}
      disabled={disabled}
      className={`flex aspect-square min-h-[110px] flex-col items-center justify-center gap-1 rounded-2xl border-2 shadow-leaf transition active:scale-[0.97] no-callout ${styles[status]}`}
    >
      <span className="text-[56px] leading-none">{entry.emoji}</span>
      <span className="font-display text-xs uppercase tracking-[0.2em] text-ink/70">
        {entry.name}
      </span>
    </button>
  );
}
