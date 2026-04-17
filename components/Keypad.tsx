"use client";

type Props = {
  value: string;
  maxLength: number;
  onDigit: (d: number) => void;
  onBackspace: () => void;
  onSubmit: () => void;
  disabled?: boolean;
};

export function Keypad({
  value,
  maxLength,
  onDigit,
  onBackspace,
  onSubmit,
  disabled,
}: Props) {
  const slots = Array.from({ length: maxLength }, (_, i) => value[i] ?? "");
  const ready = value.length === maxLength;

  return (
    <div className="select-none">
      <div
        className="flex flex-wrap justify-center gap-2"
        aria-label="Your answer"
      >
        {slots.map((c, i) => (
          <span
            key={i}
            className={`flex h-12 w-9 items-center justify-center rounded-lg border font-display text-2xl tabular-nums shadow-press ${
              c
                ? "border-ink/30 bg-parchment text-ink"
                : "border-ink/10 bg-parchment-deep/40 text-ink/30"
            }`}
          >
            {c || "·"}
          </span>
        ))}
      </div>

      <div className="mx-auto mt-6 grid max-w-xs grid-cols-3 gap-2">
        {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
          <button
            key={n}
            disabled={disabled || value.length >= maxLength}
            onClick={() => onDigit(n)}
            className="flex h-16 items-center justify-center rounded-2xl border border-ink/10 bg-parchment font-display text-3xl text-ink shadow-leaf transition active:scale-[0.97] active:bg-parchment-deep disabled:opacity-40"
          >
            {n}
          </button>
        ))}
        <button
          disabled={disabled || value.length === 0}
          onClick={onBackspace}
          className="flex h-16 items-center justify-center rounded-2xl border border-ink/10 bg-parchment-deep/60 font-display text-2xl text-ink/70 shadow-leaf transition active:scale-[0.97] disabled:opacity-30"
          aria-label="Backspace"
        >
          ⌫
        </button>
        <button
          disabled={disabled || value.length >= maxLength}
          onClick={() => onDigit(0)}
          className="flex h-16 items-center justify-center rounded-2xl border border-ink/10 bg-parchment font-display text-3xl text-ink shadow-leaf transition active:scale-[0.97] active:bg-parchment-deep disabled:opacity-40"
        >
          0
        </button>
        <button
          disabled={disabled || !ready}
          onClick={onSubmit}
          className={`flex h-16 items-center justify-center rounded-2xl border font-display text-2xl shadow-leaf transition active:scale-[0.97] ${
            ready
              ? "border-crimson bg-crimson text-parchment"
              : "border-ink/10 bg-parchment-deep/40 text-ink/30"
          }`}
          aria-label="Submit"
        >
          ✓
        </button>
      </div>
    </div>
  );
}
