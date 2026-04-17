"use client";

import { useCallback, useMemo, useState } from "react";
import { BackLink } from "@/components/BackLink";
import { Flasher } from "@/components/Flasher";
import { Keypad } from "@/components/Keypad";
import { PrimaryButton } from "@/components/PrimaryButton";
import { LEVELS, getLevel } from "@/lib/levels";
import { applyResult, generateSequence } from "@/lib/progression";
import { useGameState } from "@/lib/storage";

type Phase = "idle" | "flashing" | "input" | "result";

export default function RecallPage() {
  const [state, update, hydrated] = useGameState();
  const [phase, setPhase] = useState<Phase>("idle");
  const [sequence, setSequence] = useState<number[]>([]);
  const [answer, setAnswer] = useState("");
  const [lastCorrect, setLastCorrect] = useState<boolean | null>(null);
  const [unlockedThisRun, setUnlockedThisRun] = useState<number | null>(null);

  const lvl = useMemo(() => getLevel(state.currentLevel), [state.currentLevel]);

  const start = () => {
    const seq = generateSequence(lvl.digits);
    setSequence(seq);
    setAnswer("");
    setLastCorrect(null);
    setUnlockedThisRun(null);
    setPhase("flashing");
  };

  const onFlashDone = useCallback(() => setPhase("input"), []);

  const submit = () => {
    if (answer.length !== lvl.digits) return;
    const expected = sequence.join("");
    const correct = answer === expected;
    setLastCorrect(correct);
    setPhase("result");

    update((prev) => {
      const before = prev;
      const next = applyResult(prev, correct);
      if (next.highestUnlocked > before.highestUnlocked) {
        setUnlockedThisRun(next.highestUnlocked);
      }
      return next;
    });
  };

  const setLevel = (n: number) => {
    update((prev) =>
      n <= prev.highestUnlocked
        ? { ...prev, currentLevel: n, currentStreak: 0 }
        : prev,
    );
  };

  const toggleTraining = () => {
    update((prev) => ({ ...prev, trainingMode: !prev.trainingMode }));
  };

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-6 pb-10 pt-[max(env(safe-area-inset-top),2rem)]">
      <div className="flex items-center justify-between">
        <BackLink />
        <span className="font-display text-xs uppercase tracking-[0.32em] text-ink/55">
          Recall · Lv {lvl.level}
        </span>
      </div>

      <div className="rule mt-5" />

      {phase === "idle" && hydrated && (
        <section className="mt-6 animate-rise">
          <header>
            <p className="font-display text-[11px] uppercase tracking-[0.3em] text-crimson">
              {lvl.label}
            </p>
            <h2 className="mt-2 font-display text-3xl font-bold leading-tight">
              Hold {lvl.digits} digits in mind.
            </h2>
            <p className="mt-2 text-sm text-ink/65">
              Each digit appears for {lvl.msPerDigit}ms. Three correct in a row
              unlocks the next level.
            </p>
          </header>

          <div className="mt-6 rounded-2xl border border-ink/10 bg-parchment-deep/40 p-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="font-display text-sm font-semibold">
                  Training mode
                </div>
                <div className="text-xs text-ink/60">
                  Show the image beside each digit while it flashes.
                </div>
              </div>
              <button
                onClick={toggleTraining}
                role="switch"
                aria-checked={state.trainingMode}
                className={`relative h-7 w-12 rounded-full border transition ${
                  state.trainingMode
                    ? "border-crimson bg-crimson"
                    : "border-ink/20 bg-parchment"
                }`}
              >
                <span
                  className={`absolute top-0.5 h-5 w-5 rounded-full bg-parchment shadow-leaf transition-all ${
                    state.trainingMode ? "left-6" : "left-0.5"
                  }`}
                />
              </button>
            </div>
          </div>

          <div className="mt-5">
            <p className="font-display text-[11px] uppercase tracking-[0.3em] text-ink/55">
              Choose level
            </p>
            <div className="mt-2 grid grid-cols-5 gap-2">
              {LEVELS.map((l) => {
                const unlocked = l.level <= state.highestUnlocked;
                const active = l.level === state.currentLevel;
                return (
                  <button
                    key={l.level}
                    disabled={!unlocked}
                    onClick={() => setLevel(l.level)}
                    className={`flex h-12 flex-col items-center justify-center rounded-xl border text-sm font-semibold transition active:scale-[0.97] ${
                      active
                        ? "border-crimson bg-crimson text-parchment"
                        : unlocked
                          ? "border-ink/15 bg-parchment text-ink hover:bg-parchment-deep"
                          : "border-ink/10 bg-parchment-deep/30 text-ink/30"
                    }`}
                    aria-label={`Level ${l.level}${unlocked ? "" : " locked"}`}
                  >
                    <span className="font-display text-base">{l.level}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="mt-7 flex justify-center">
            <PrimaryButton onClick={start}>Begin · {lvl.label}</PrimaryButton>
          </div>

          <p className="mt-4 text-center text-xs text-ink/55">
            Streak {state.currentStreak} · Best {state.bestStreak}
          </p>
        </section>
      )}

      {phase === "flashing" && (
        <section className="mt-10">
          <Flasher
            sequence={sequence}
            msPerDigit={lvl.msPerDigit}
            training={state.trainingMode}
            onComplete={onFlashDone}
          />
        </section>
      )}

      {phase === "input" && (
        <section className="mt-8 animate-rise">
          <p className="text-center font-display text-[11px] uppercase tracking-[0.3em] text-crimson">
            Recall the sequence
          </p>
          <div className="mt-5">
            <Keypad
              value={answer}
              maxLength={lvl.digits}
              onDigit={(d) =>
                setAnswer((a) =>
                  a.length < lvl.digits ? a + String(d) : a,
                )
              }
              onBackspace={() => setAnswer((a) => a.slice(0, -1))}
              onSubmit={submit}
            />
          </div>
        </section>
      )}

      {phase === "result" && (
        <section className="mt-10 animate-rise">
          <p
            className={`text-center font-display text-[11px] uppercase tracking-[0.3em] ${
              lastCorrect ? "text-gold" : "text-crimson"
            }`}
          >
            {lastCorrect ? "Held in memory" : "Slipped away"}
          </p>
          <h2 className="mt-3 text-center font-display text-4xl font-bold">
            {lastCorrect ? "Correct" : "Not quite"}
          </h2>

          <div className="mt-6 rounded-2xl border border-ink/10 bg-parchment-deep/40 p-5">
            <div className="text-[11px] uppercase tracking-[0.3em] text-ink/55">
              Sequence
            </div>
            <div className="mt-2 font-display text-2xl font-bold tabular-nums">
              {sequence.join(" ")}
            </div>
            {!lastCorrect && (
              <div className="mt-2 text-sm text-ink/60">
                You said{" "}
                <span className="font-display tabular-nums text-ink">
                  {answer.split("").join(" ") || "—"}
                </span>
              </div>
            )}
          </div>

          {unlockedThisRun !== null && (
            <div className="mt-5 rounded-2xl border border-gold bg-gold/15 p-4 text-center">
              <p className="font-display text-[11px] uppercase tracking-[0.3em] text-gold">
                New rank
              </p>
              <p className="mt-1 font-display text-xl font-bold">
                {getLevel(unlockedThisRun).label} unlocked
              </p>
            </div>
          )}

          <div className="mt-7 flex justify-center gap-3">
            <PrimaryButton variant="ghost" href="/">
              Atelier
            </PrimaryButton>
            <PrimaryButton onClick={start}>Again</PrimaryButton>
          </div>
        </section>
      )}
    </main>
  );
}
