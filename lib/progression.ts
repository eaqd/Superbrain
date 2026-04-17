import { MAX_LEVEL } from "@/lib/levels";
import type { GameState } from "@/lib/storage";

const UNLOCK_AT_STREAK = 3;

export function applyResult(prev: GameState, correct: boolean): GameState {
  if (!correct) {
    return { ...prev, currentStreak: 0 };
  }

  const currentStreak = prev.currentStreak + 1;
  const totalCorrect = prev.totalCorrect + 1;
  const bestStreak = Math.max(prev.bestStreak, currentStreak);

  let highestUnlocked = prev.highestUnlocked;
  let currentLevel = prev.currentLevel;

  if (
    currentStreak >= UNLOCK_AT_STREAK &&
    prev.currentLevel === prev.highestUnlocked &&
    prev.highestUnlocked < MAX_LEVEL
  ) {
    highestUnlocked = prev.highestUnlocked + 1;
    currentLevel = highestUnlocked;
    return {
      ...prev,
      currentStreak: 0,
      bestStreak,
      totalCorrect,
      highestUnlocked,
      currentLevel,
    };
  }

  return {
    ...prev,
    currentStreak,
    bestStreak,
    totalCorrect,
  };
}

export function generateSequence(length: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < length; i++) {
    let d = Math.floor(Math.random() * 10);
    if (i > 0 && d === out[i - 1]) {
      d = (d + 1) % 10;
    }
    out.push(d);
  }
  return out;
}
