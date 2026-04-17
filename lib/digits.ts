export type DigitEntry = {
  digit: number;
  emoji: string;
  name: string;
  reason: string;
};

export const DIGITS: DigitEntry[] = [
  {
    digit: 0,
    emoji: "⚽",
    name: "Football",
    reason: "Round and closed, like the loop of a 0.",
  },
  {
    digit: 1,
    emoji: "🕯️",
    name: "Candle",
    reason: "Tall and straight, a single upright stroke.",
  },
  {
    digit: 2,
    emoji: "🦢",
    name: "Swan",
    reason: "Curved neck above, body along the base.",
  },
  {
    digit: 3,
    emoji: "⛓️",
    name: "Chains",
    reason: "Two stacked curves, links of a chain.",
  },
  {
    digit: 4,
    emoji: "⛵",
    name: "Sailboat",
    reason: "Triangular sail meeting a hull at right angles.",
  },
  {
    digit: 5,
    emoji: "🪝",
    name: "Hook",
    reason: "Top hat over a curl, exactly the shape of 5.",
  },
  {
    digit: 6,
    emoji: "🐘",
    name: "Elephant",
    reason: "Trunk curls down and around, ending in a loop.",
  },
  {
    digit: 7,
    emoji: "🚩",
    name: "Flag",
    reason: "A pole with a flag flying from the top.",
  },
  {
    digit: 8,
    emoji: "⛄",
    name: "Snowman",
    reason: "Two stacked circles, top to bottom.",
  },
  {
    digit: 9,
    emoji: "🎈",
    name: "Balloon",
    reason: "Round head with a string trailing down.",
  },
];

export function digitFor(n: number): DigitEntry {
  return DIGITS[((n % 10) + 10) % 10];
}
