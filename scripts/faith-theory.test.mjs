// Faith Theory engine tests.  Run with:  npm run test:faith
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const FT = require("../public/faith/engine.js");
const B = FT.BY_ID;

function duel(a, b, world = {}, steps = 200, seed = 1) {
  const r = FT.simulate({ defs: [B[a], B[b]], group: [0, 1], groups: 2, world, steps, seed });
  return [r.groups[0].score, r.groups[1].score];
}
const close = (x, y, eps = 1e-9) => assert.ok(Math.abs(x - y) <= eps, `${x} ≉ ${y}`);

test("Eye for an Eye is Tit for Tat", () => {
  const [law, cain] = duel("law", "cain");
  close(law, (0 + 199 * 1) / 200); // betrayed once, then mutual defection
  close(cain, (5 + 199 * 1) / 200);
  const [a, b] = duel("law", "law");
  close(a, 3);
  close(b, 3);
});

test("Steadfast always keeps covenant; No Faith never does", () => {
  const [st, cain] = duel("steadfast", "cain");
  close(st, 0);
  close(cain, 5);
});

test("Show Me First is Suspicious Tit for Tat (alternates with Tit for Tat, deadlocks with itself)", () => {
  const [t, l] = duel("thomas", "law");
  close(t, 2.5);
  close(l, 2.5);
  const [x, y] = duel("thomas", "thomas");
  close(x, 1);
  close(y, 1);
});

test("Prodigal is Win-Stay Lose-Shift", () => {
  const [p, c] = duel("prodigal", "cain");
  close(p, 0.5); // C, D, C, D … against a constant defector
  close(c, 3);
});

test("Discerning forgives about one wrong in three (Generous Tit for Tat)", () => {
  let sum = 0;
  for (let seed = 1; seed <= 40; seed++) sum += duel("joseph", "cain", {}, 400, seed)[0];
  const avg = sum / 40;
  assert.ok(Math.abs(avg - 2 / 3) < 0.03, `Joseph vs Cain ≈ 2/3, got ${avg}`);
});

test("runs are deterministic for a given seed", () => {
  const a = FT.tournament({ reps: 2, world: { noise: 0.05 }, seed: 9 });
  const b = FT.tournament({ reps: 2, world: { noise: 0.05 }, seed: 9 });
  assert.deepEqual(a, b);
});

test("divine strength 0 is exactly the natural world", () => {
  const a = FT.tournament({ reps: 2, world: { noise: 0.05, divine: 0 }, seed: 4 });
  const b = FT.tournament({ reps: 2, world: { noise: 0.05 }, seed: 4 });
  assert.deepEqual(a, b);
});

test("unity raises the reward of mutual covenant by s", () => {
  const [a] = duel("law", "law", { divine: 0.5, reaping: false, restoration: false, renewal: false });
  close(a, 3.5);
});

test("reaping repays the betrayed who do not avenge themselves, and collects from the unreconciled", () => {
  const world = { divine: 1, unity: false, restoration: false, renewal: false };
  const [st, cain] = duel("steadfast", "cain", world);
  // 190 of 200 betrayals fall due before the end (delay 10)
  close(st, (190 * 3) / 200);
  close(cain, (200 * 5 - 190 * 2) / 200);
  // Eye for an Eye avenges itself, so it is not repaid after the first betrayal
  const [law] = duel("law", "cain", world);
  assert.ok(law < 1.1, `law should not be repaid, got ${law}`);
});

test("renewal softens a hardened heart that receives mercy", () => {
  const r = FT.simulate({
    defs: [B.cain, B.steadfast], group: [0, 1], groups: 2, steps: 100, seed: 1,
    world: { divine: 1, unity: false, reaping: false, restoration: false },
  });
  assert.ok(r.groups[0].finalFaith > 0.9, `Cain's faith should rise, got ${r.groups[0].finalFaith}`);
  const natural = FT.simulate({ defs: [B.cain, B.steadfast], group: [0, 1], groups: 2, steps: 100, seed: 1 });
  close(natural.groups[0].finalFaith, 0);
});

test("restoration only lifts divinely anchored faith", () => {
  const world = { divine: 1, unity: false, reaping: false, renewal: false };
  const peter = FT.simulate({ defs: [B.peter, B.cain], group: [0, 1], groups: 2, steps: 200, seed: 2, world });
  const peterNat = FT.simulate({ defs: [B.peter, B.cain], group: [0, 1], groups: 2, steps: 200, seed: 2 });
  assert.ok(peter.groups[0].meanFaith > peterNat.groups[0].meanFaith + 0.2);
  const rocky = FT.simulate({ defs: [B.rocky, B.cain], group: [0, 1], groups: 2, steps: 200, seed: 2, world });
  const rockyNat = FT.simulate({ defs: [B.rocky, B.cain], group: [0, 1], groups: 2, steps: 200, seed: 2 });
  close(rocky.groups[0].meanFaith, rockyNat.groups[0].meanFaith);
});

test("weights: an agent's partners always sum to one per step", () => {
  const asm = FT.buildAssembly([B.law, B.cain, B.joseph], 2);
  const mix = FT.mixMatrix([0.2, 0.5, 0.3], 0.25);
  mix.forEach((row) => close(row.reduce((a, b) => a + b, 0), 1));
  // a mixed run must still give each type a sensible per-move score
  const r = FT.simulate({ ...asm, mix, steps: 50, seed: 3 });
  r.groups.forEach((g) => assert.ok(g.score >= 0 && g.score <= 5));
});

test("generations: shares stay a distribution", () => {
  const g = FT.generations({ gens: 5, steps: 60, world: { noise: 0.05 } });
  g.history.forEach((row) => close(row.reduce((a, b) => a + b, 0), 1, 1e-9));
});
