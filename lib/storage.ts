"use client";

import { useEffect, useState } from "react";

export type GameState = {
  currentLevel: number;
  highestUnlocked: number;
  currentStreak: number;
  bestStreak: number;
  totalCorrect: number;
  trainingMode: boolean;
};

export const DEFAULT_STATE: GameState = {
  currentLevel: 1,
  highestUnlocked: 1,
  currentStreak: 0,
  bestStreak: 0,
  totalCorrect: 0,
  trainingMode: true,
};

const KEY = "mnemonicon";

export function loadState(): GameState {
  if (typeof window === "undefined") return DEFAULT_STATE;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return DEFAULT_STATE;
    const parsed = JSON.parse(raw) as Partial<GameState>;
    return { ...DEFAULT_STATE, ...parsed };
  } catch {
    return DEFAULT_STATE;
  }
}

export function saveState(state: GameState): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* quota or private mode — ignore */
  }
}

export function useGameState(): [
  GameState,
  (updater: (prev: GameState) => GameState) => void,
  boolean,
] {
  const [state, setState] = useState<GameState>(DEFAULT_STATE);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setState(loadState());
    setHydrated(true);
  }, []);

  const update = (updater: (prev: GameState) => GameState) => {
    setState((prev) => {
      const next = updater(prev);
      saveState(next);
      return next;
    });
  };

  return [state, update, hydrated];
}
