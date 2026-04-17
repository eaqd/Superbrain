export type Level = {
  level: number;
  digits: number;
  msPerDigit: number;
  label: string;
};

export const LEVELS: Level[] = [
  { level: 1, digits: 2, msPerDigit: 3000, label: "Apprentice" },
  { level: 2, digits: 3, msPerDigit: 3000, label: "Student" },
  { level: 3, digits: 4, msPerDigit: 2500, label: "Adept" },
  { level: 4, digits: 5, msPerDigit: 2500, label: "Scribe" },
  { level: 5, digits: 6, msPerDigit: 2000, label: "Scholar" },
  { level: 6, digits: 7, msPerDigit: 2000, label: "Mentalist" },
  { level: 7, digits: 8, msPerDigit: 1500, label: "Sage" },
  { level: 8, digits: 10, msPerDigit: 1500, label: "Master" },
  { level: 9, digits: 12, msPerDigit: 1200, label: "Grandmaster" },
  { level: 10, digits: 15, msPerDigit: 1000, label: "Mnemonist" },
];

export const MAX_LEVEL = LEVELS.length;

export function getLevel(n: number): Level {
  const idx = Math.max(1, Math.min(MAX_LEVEL, n)) - 1;
  return LEVELS[idx];
}
