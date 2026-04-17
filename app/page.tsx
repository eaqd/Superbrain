"use client";

import { useGameState } from "@/lib/storage";
import { LevelBadge } from "@/components/LevelBadge";
import { ModeTile } from "@/components/ModeTile";
import { getLevel } from "@/lib/levels";

export default function Home() {
  const [state, , hydrated] = useGameState();
  const lvl = getLevel(state.currentLevel);

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-6 pb-12 pt-[max(env(safe-area-inset-top),2.5rem)]">
      <header className="animate-rise">
        <p className="font-display text-[11px] uppercase tracking-[0.32em] text-ink/55">
          A memory atelier
        </p>
        <h1 className="mt-2 font-display text-[44px] font-black leading-[0.95] tracking-tight text-ink ink-shadow">
          Mnemonicon
        </h1>
        <p className="mt-3 max-w-xs text-base leading-snug text-ink/65">
          <span className="font-display italic font-semibold text-ink/80">
            Numbers
          </span>
          , given a shape you cannot forget.
        </p>
        <div className="rule mt-6" />
      </header>

      <section className="mt-7 flex items-center justify-between">
        {hydrated ? (
          <LevelBadge level={state.currentLevel} streak={state.currentStreak} />
        ) : (
          <span className="h-9 w-44 animate-pulse rounded-full bg-parchment-deep/60" />
        )}
        {hydrated && (
          <span className="text-xs text-ink/55">
            best{" "}
            <span className="font-semibold text-ink">{state.bestStreak}</span>
          </span>
        )}
      </section>

      <section className="mt-6 grid gap-3">
        <ModeTile
          href="/learn"
          index="I"
          title="Learn the Code"
          blurb="Meet the ten images, one digit at a time."
          accent="ink"
        />
        <ModeTile
          href="/speed"
          index="II"
          title="Speed Drill"
          blurb="See a digit. Tap its image. Beat your reaction time."
          accent="gold"
        />
        <ModeTile
          href="/recall"
          index="III"
          title="Recall Challenge"
          blurb={`Hold ${lvl.digits} digits. ${lvl.label} pace.`}
          accent="crimson"
        />
      </section>

      <footer className="mt-auto pt-12">
        <p className="text-center font-display text-xs italic text-ink/45">
          “The art of memory is the art of attention.” — Samuel Johnson
        </p>
      </footer>
    </main>
  );
}
