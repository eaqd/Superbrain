# Mnemonicon

A mobile-first memory atelier. Learn to remember any number by turning digits into images — then drill yourself from Apprentice to Mnemonist through ten levels.

Built with Next.js 14 (App Router), TypeScript, and Tailwind CSS. All state lives in `localStorage`; no backend, no database, no accounts.

## Deploy live

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Feaqd%2Fsuperbrain&project-name=mnemonicon&repository-name=mnemonicon)

Click the button, sign in to Vercel, accept the defaults (Next.js is auto-detected, no configuration needed). You'll get a `mnemonicon-*.vercel.app` URL within about a minute.

Make sure Vercel is set to deploy the `claude/mnemonicon-app-DWDct` branch (or merge it to `main` first).

## On your iPhone

1. Open the deployed URL in Safari.
2. Share → **Add to Home Screen**.
3. Launch from the home screen — the PWA manifest makes it open fullscreen, no browser chrome.

## The three modes

1. **Learn the Code** — swipe through digits 0–9 and meet their images: `0 ⚽ Football`, `1 🕯️ Candle`, `2 🦢 Swan`, `3 ⛓️ Chains`, `4 ⛵ Sailboat`, `5 🪝 Hook`, `6 🐘 Elephant`, `7 🚩 Flag`, `8 ⛄ Snowman`, `9 🎈 Balloon`.
2. **Speed Drill** — a digit flashes, you tap the matching image from four choices. Tracks streak, accuracy, and best reaction time.
3. **Recall Challenge** — a sequence of digits flashes one at a time, then you type them back on a custom numeric keypad (no iOS keyboard). Three correct in a row unlocks the next rank.

## Progression

| Lv | Digits | ms/digit | Rank |
| -: | -----: | -------: | ---- |
| 1  | 2      | 3000     | Apprentice |
| 2  | 3      | 3000     | Student |
| 3  | 4      | 2500     | Adept |
| 4  | 5      | 2500     | Scribe |
| 5  | 6      | 2000     | Scholar |
| 6  | 7      | 2000     | Mentalist |
| 7  | 8      | 1500     | Sage |
| 8  | 10     | 1500     | Master |
| 9  | 12     | 1200     | Grandmaster |
| 10 | 15     | 1000     | Mnemonist |

## Local development

```bash
npm install
npm run dev -- -H 0.0.0.0
```

Then open `http://<your-lan-ip>:3000` on your phone (same Wi-Fi) to test on a real device without redeploying.

## Project layout

```
app/
  layout.tsx          fonts, manifest, Apple web-app meta
  page.tsx            home (three mode tiles + level badge)
  learn/page.tsx      swipeable digit cards
  speed/page.tsx      tap-the-image drill
  recall/page.tsx     flash + keypad recall
components/           Keypad, Flasher, ChoiceTile, ModeTile, ...
lib/
  digits.ts           digit ↔ image ↔ story table
  levels.ts           10-level progression table
  storage.ts          SSR-safe localStorage helper (useGameState)
  drill.ts            question picker for speed mode
  progression.ts      streak → unlock logic + sequence generator
public/               PWA manifest, SVG icon, generated PNGs
```
