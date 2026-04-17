import { getLevel } from "@/lib/levels";

export function LevelBadge({
  level,
  streak,
}: {
  level: number;
  streak: number;
}) {
  const info = getLevel(level);
  return (
    <div className="inline-flex items-center gap-3 rounded-full border border-ink/10 bg-parchment-deep/60 px-4 py-2 text-sm font-medium text-ink/80 backdrop-blur">
      <span className="font-display text-base text-crimson">
        Lv {info.level}
      </span>
      <span className="h-3 w-px bg-ink/20" aria-hidden />
      <span className="italic">{info.label}</span>
      <span className="h-3 w-px bg-ink/20" aria-hidden />
      <span className="tabular-nums">
        streak <span className="font-semibold text-gold">{streak}</span>
      </span>
    </div>
  );
}
