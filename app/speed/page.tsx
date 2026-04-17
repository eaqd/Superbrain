"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { BackLink } from "@/components/BackLink";
import { ChoiceTile } from "@/components/ChoiceTile";
import { pickQuestion, type Question } from "@/lib/drill";
import { useGameState } from "@/lib/storage";

type Phase = "answering" | "settled";

export default function SpeedPage() {
  const [, update, hydrated] = useGameState();
  const [question, setQuestion] = useState<Question | null>(null);
  const [phase, setPhase] = useState<Phase>("answering");
  const [picked, setPicked] = useState<number | null>(null);
  const [score, setScore] = useState({ correct: 0, total: 0 });
  const [streak, setStreak] = useState(0);
  const [lastMs, setLastMs] = useState<number | null>(null);
  const [bestMs, setBestMs] = useState<number | null>(null);
  const startedAt = useRef<number>(0);
  const lastDigit = useRef<number | null>(null);

  const next = () => {
    const q = pickQuestion(lastDigit.current);
    lastDigit.current = q.digit;
    setQuestion(q);
    setPicked(null);
    setPhase("answering");
    startedAt.current = performance.now();
  };

  useEffect(() => {
    next();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onPress = (idx: number) => {
    if (!question || phase !== "answering") return;
    const ms = Math.round(performance.now() - startedAt.current);
    const correct = idx === question.correctIndex;
    setPicked(idx);
    setPhase("settled");
    setLastMs(ms);
    setScore((s) => ({
      correct: s.correct + (correct ? 1 : 0),
      total: s.total + 1,
    }));
    if (correct) {
      setStreak((s) => s + 1);
      setBestMs((b) => (b === null ? ms : Math.min(b, ms)));
    } else {
      setStreak(0);
    }

    update((prev) => {
      const newStreak = correct ? prev.currentStreak + 1 : 0;
      return {
        ...prev,
        totalCorrect: prev.totalCorrect + (correct ? 1 : 0),
        bestStreak: Math.max(prev.bestStreak, newStreak),
      };
    });

    const wait = correct ? 280 : 1100;
    window.setTimeout(next, wait);
  };

  const accuracy = useMemo(
    () => (score.total === 0 ? 0 : Math.round((score.correct / score.total) * 100)),
    [score],
  );

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-6 pb-10 pt-[max(env(safe-area-inset-top),2rem)]">
      <div className="flex items-center justify-between">
        <BackLink />
        <span className="font-display text-xs uppercase tracking-[0.32em] text-ink/55">
          Drill · Speed
        </span>
      </div>

      <div className="rule mt-5" />

      <section className="mt-6 grid grid-cols-3 gap-3 text-center">
        <Stat label="Streak" value={streak} accent="gold" />
        <Stat label="Accuracy" value={`${accuracy}%`} accent="ink" />
        <Stat
          label="Best"
          value={bestMs === null ? "—" : `${bestMs}ms`}
          accent="crimson"
        />
      </section>

      <section className="mt-7 flex flex-col items-center">
        <p className="font-display text-[11px] uppercase tracking-[0.3em] text-ink/55">
          Tap the image
        </p>
        <div
          key={question?.digit ?? "loading"}
          className="mt-3 flex h-40 w-40 animate-flash items-center justify-center rounded-3xl border border-ink/10 bg-parchment-deep/40 shadow-leaf"
        >
          <span className="font-display text-[140px] font-black leading-none text-ink">
            {question?.digit ?? "·"}
          </span>
        </div>
      </section>

      <section className="mt-7 grid grid-cols-2 gap-3">
        {question?.choices.map((c, i) => {
          let status: Parameters<typeof ChoiceTile>[0]["status"] = "idle";
          if (phase === "settled") {
            if (i === question.correctIndex) status = "correct";
            else if (i === picked) status = "wrong";
            else status = "muted";
          }
          return (
            <ChoiceTile
              key={`${question.digit}-${c.digit}`}
              entry={c}
              status={status}
              onPress={() => onPress(i)}
              disabled={phase !== "answering"}
            />
          );
        })}
      </section>

      <p className="mt-6 text-center text-xs text-ink/55">
        {hydrated && lastMs !== null
          ? `Last answer · ${lastMs}ms`
          : "Tap as fast as you can recognise the shape."}
      </p>
    </main>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string | number;
  accent: "gold" | "crimson" | "ink";
}) {
  const color =
    accent === "gold"
      ? "text-gold"
      : accent === "crimson"
        ? "text-crimson"
        : "text-ink";
  return (
    <div className="rounded-2xl border border-ink/10 bg-parchment-deep/40 px-3 py-3">
      <div className={`font-display text-2xl font-bold tabular-nums ${color}`}>
        {value}
      </div>
      <div className="mt-0.5 text-[10px] uppercase tracking-[0.25em] text-ink/55">
        {label}
      </div>
    </div>
  );
}
