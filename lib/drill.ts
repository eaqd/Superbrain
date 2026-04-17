import { DIGITS, type DigitEntry } from "@/lib/digits";

export type Question = {
  digit: number;
  choices: DigitEntry[];
  correctIndex: number;
};

function shuffle<T>(arr: T[]): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function pickQuestion(lastDigit: number | null): Question {
  const pool = DIGITS.filter((d) => d.digit !== lastDigit);
  const target = pool[Math.floor(Math.random() * pool.length)];
  const distractors = shuffle(DIGITS.filter((d) => d.digit !== target.digit)).slice(
    0,
    3,
  );
  const choices = shuffle([target, ...distractors]);
  return {
    digit: target.digit,
    choices,
    correctIndex: choices.findIndex((c) => c.digit === target.digit),
  };
}
