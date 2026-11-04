#!/usr/bin/env node
/**
 * Faith Theory — run every test and record the results.
 *
 *   npm run faith
 *
 * Writes:
 *   public/faith/results.js        window.FAITH_RESULTS, read by the lab page
 *   docs/faith-theory-results.md   the same numbers as Markdown tables
 *
 * Every run is seeded, so the output is identical from run to run.
 */
import { createRequire } from "node:module";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const FT = require(join(root, "public/faith/engine.js"));

const NOISE = 0.05; // "time and chance happeneth to them all" (Eccl 9:11)
const HEAVEN = 0.5; // default strength of the modelled promises
const started = Date.now();
const log = (msg) => process.stderr.write(`  ${msg} (${((Date.now() - started) / 1000).toFixed(1)}s)\n`);

const r3 = (x) => (x == null ? null : Math.round(x * 1000) / 1000);
const roundRows = (rows) =>
  rows.map((r) => ({ id: r.id, rank: r.rank, score: r3(r.score), se: r3(r.se), coop: r3(r.coop), meanFaith: r3(r.meanFaith), finalFaith: r3(r.finalFaith) }));
const roundMatrix = (m) => m.map((row) => row.map(r3));

const results = {
  params: {
    payoff: FT.PAYOFF,
    divine: FT.DIVINE,
    noise: NOISE,
    heaven: HEAVEN,
    steps: 200,
    copies: 2,
  },
  archetypes: FT.ARCHETYPES.map(({ id, name, figure, ref, quote, source, band, classic, blurb }) => ({
    id, name, figure, ref, quote, source, band, classic, blurb,
  })),
};

// Test 1 — Under the sun: Axelrod's tournament, no noise.
const sun = FT.tournament({ reps: 20, world: { noise: 0 }, seed: 1 });
results.sun = { rows: roundRows(sun.rows), h2h: roundMatrix(sun.h2h) };
log("test 1  under the sun");

// Test 2 — Time and chance: the same tournament with 5% misfires.
const chance = FT.tournament({ reps: 20, world: { noise: NOISE }, seed: 2 });
results.chance = { rows: roundRows(chance.rows), h2h: roundMatrix(chance.h2h) };
log("test 2  time and chance");

// Test 3 — Under heaven: the four promises at strength 0.5.
const heaven = FT.tournament({ reps: 20, world: { noise: NOISE, divine: HEAVEN }, seed: 3 });
results.heaven = { rows: roundRows(heaven.rows), h2h: roundMatrix(heaven.h2h) };
log("test 3  under heaven");

// Test 3b — How much heaven does it take? Strength sweep 0 → 1.
results.sweep = FT.divineSweep({ world: { noise: NOISE }, reps: 6 }).map((x) => ({ s: x.s, rows: roundRows(x.rows) }));
log("test 3b strength sweep");

// Test 3c — Which promise does what? Each mechanic alone at full strength.
results.ablation = FT.ablation({ strength: 1, noise: NOISE, reps: 8 }).map((x) => ({ key: x.key, label: x.label, rows: roundRows(x.rows) }));
log("test 3c each promise alone");

// Test 4 — Levels of faith meeting each other (and themselves).
const levelsNatural = FT.levelsMatrix({ world: { noise: NOISE } });
const levelsDivine = FT.levelsMatrix({ world: { noise: NOISE, divine: HEAVEN } });
results.levels = {
  labels: levelsNatural.labels,
  ids: levelsNatural.ids,
  natural: roundMatrix(levelsNatural.matrix),
  divine: roundMatrix(levelsDivine.matrix),
};
log("test 4  levels matrix");

// Test 5 — The faith curve: one agent at each level inside the full assembly.
results.curve = {};
for (const style of ["focused", "undulating"]) {
  for (const [key, world] of [["natural", { noise: NOISE }], ["divine", { noise: NOISE, divine: HEAVEN }]]) {
    results.curve[`${style}_${key}`] = FT.faithCurve({ style, world, reps: 6 }).map((p) => ({
      level: p.level, score: r3(p.score), rank: p.rank, meanFaith: r3(p.meanFaith),
    }));
  }
}
log("test 5  faith curve");

// Test 6 — Generations: shares grow in proportion to score.
results.generations = {};
for (const [key, world] of [["natural", { noise: NOISE }], ["divine", { noise: NOISE, divine: HEAVEN }]]) {
  const g = FT.generations({ world, gens: 60 });
  results.generations[key] = g.history.map((row) => row.map((x) => Math.round(x * 10000) / 10000));
}
log("test 6  generations");

// Test 7 — Ten righteous: how many faithful (of 100) to out-earn a city of Cains?
const STRENGTHS = [0, 0.1, 0.2, 0.3, 0.4, 0.5];
const RIGHTEOUS = ["steadfast", "joseph", "law", "thomas", "peter", "mustard", "prodigal", "lukewarm"];
results.righteous = { strengths: STRENGTHS, ids: RIGHTEOUS, max: 50, apart: [], together: [] };
for (const [key, assembly] of [["apart", 0], ["together", 0.2]]) {
  results.righteous[key] = RIGHTEOUS.map((id) =>
    STRENGTHS.map((s) => FT.righteousThreshold({ id, assembly, max: 50, world: { noise: NOISE, divine: s } }).threshold),
  );
}
log("test 7  ten righteous");

// Test 8 — The storm: every house of its own kind, calm → storm → calm.
results.storm = {};
for (const [key, world] of [["natural", {}], ["divine", { divine: HEAVEN }]]) {
  const st = FT.storm({ world });
  results.storm[key] = {
    from: st.from, to: st.to, steps: st.steps,
    coop: st.coop.map((a) => a.map(r3)),
    faith: st.faith.map((a) => a.map(r3)),
    summary: st.summary.map((s) => ({
      id: s.id, before: r3(s.before), during: r3(s.during), after: r3(s.after),
      faithBefore: r3(s.faithBefore), faithAfter: r3(s.faithAfter), recoveredAt: s.recoveredAt,
    })),
  };
}
log("test 8  the storm");

// ------------------------------------------------------------------ write
mkdirSync(join(root, "public/faith"), { recursive: true });
writeFileSync(
  join(root, "public/faith/results.js"),
  "/* Generated by scripts/faith-theory.mjs — do not edit by hand. */\nwindow.FAITH_RESULTS = " + JSON.stringify(results) + ";\n",
);

// ------------------------------------------------------------- markdown
const name = (id) => FT.BY_ID[id].name;
const f2 = (x) => (x == null ? "—" : x.toFixed(2));
const pct = (x) => (x == null ? "—" : Math.round(x * 100) + "%");
const md = [];
const table = (head, rows, textCols = 1) => {
  md.push("| " + head.join(" | ") + " |");
  md.push("|" + head.map((h, i) => (i < textCols ? ":--" : "--:")).join("|") + "|");
  rows.forEach((r) => md.push("| " + r.join(" | ") + " |"));
  md.push("");
};
const ranking = (rows) =>
  table(
    ["#", "Archetype", "Score / move", "± SE", "Kept covenant", "Mean faith"],
    rows.slice().sort((a, b) => a.rank - b.rank).map((r) => [r.rank, name(r.id), f2(r.score), r.se.toFixed(3), pct(r.coop), f2(r.meanFaith)]),
    2,
  );

md.push("# Faith Theory — results");
md.push("");
md.push("_Generated by `npm run faith` (scripts/faith-theory.mjs). Seeded, so reruns give the same numbers._");
md.push("");
md.push(`Payoffs per move: both keep covenant R=${FT.PAYOFF.R}, betray a keeper T=${FT.PAYOFF.T}, betrayed S=${FT.PAYOFF.S}, both betray P=${FT.PAYOFF.P}. 11 archetypes × 2 copies, 200 steps, every pair plays every step. "Time and chance" noise = ${NOISE * 100}% unless stated. "Under heaven" strength s = ${HEAVEN} unless stated.`);
md.push("");
md.push("## Test 1 — Under the sun (no noise, 20 runs)");
md.push("");
ranking(results.sun.rows);
md.push("## Test 2 — Time and chance (5% misfires, 20 runs)");
md.push("");
ranking(results.chance.rows);
md.push(`## Test 3 — Under heaven (s = ${HEAVEN}, 5% misfires, 20 runs)`);
md.push("");
ranking(results.heaven.rows);
md.push("## Test 3b — Rank as heaven's strength rises");
md.push("");
table(
  ["Archetype"].concat(results.sweep.map((x) => "s=" + x.s)),
  FT.ARCHETYPES.map((a, k) => [a.name].concat(results.sweep.map((x) => "#" + x.rows[k].rank))),
);
md.push("## Test 3c — Each promise alone (s = 1): rank");
md.push("");
table(
  ["Archetype"].concat(results.ablation.map((x) => x.label)),
  FT.ARCHETYPES.map((a, k) => [a.name].concat(results.ablation.map((x) => `#${x.rows[k].rank} (${f2(x.rows[k].score)})`))),
);
for (const key of ["natural", "divine"]) {
  md.push(`## Test 4 — Levels of faith, head to head (${key === "natural" ? "under the sun" : "under heaven"})`);
  md.push("");
  md.push("Row's average score per move against the column. The diagonal is each level with its own kind.");
  md.push("");
  table(["You \\ partner"].concat(results.levels.labels), results.levels.labels.map((l, i) => [l].concat(results.levels[key][i].map(f2))));
}
md.push("## Test 5 — The faith curve (score of one agent at each level, inside the full assembly)");
md.push("");
table(
  ["Faith level", "Focused · sun", "Focused · heaven", "Undulating · sun", "Undulating · heaven"],
  results.curve.focused_natural.map((p, i) => [
    Math.round(p.level * 100) + "%",
    `${f2(p.score)} (#${p.rank})`,
    `${f2(results.curve.focused_divine[i].score)} (#${results.curve.focused_divine[i].rank})`,
    `${f2(results.curve.undulating_natural[i].score)} (#${results.curve.undulating_natural[i].rank})`,
    `${f2(results.curve.undulating_divine[i].score)} (#${results.curve.undulating_divine[i].rank})`,
  ]),
);
md.push("## Test 6 — Generations (share of the population, %)");
md.push("");
const marks = [0, 10, 20, 40, 60];
table(
  ["Archetype"].concat(marks.map((m) => "sun g" + m)).concat(marks.map((m) => "heaven g" + m)),
  FT.ARCHETYPES.map((a, k) =>
    [a.name]
      .concat(marks.map((m) => (results.generations.natural[m][k] * 100).toFixed(1)))
      .concat(marks.map((m) => (results.generations.divine[m][k] * 100).toFixed(1))),
  ),
);
for (const key of ["apart", "together"]) {
  md.push(`## Test 7 — Ten righteous: faithful needed in a city of 100 Cains (${key === "apart" ? "random meeting" : "assembling together, 20% extra time with their own kind"})`);
  md.push("");
  md.push("“—” means not even 50 of 100 would be enough.");
  md.push("");
  table(
    ["Archetype"].concat(STRENGTHS.map((s) => "s=" + s)),
    RIGHTEOUS.map((id, i) => [name(id)].concat(results.righteous[key][i].map((v) => (v == null ? "—" : String(v))))),
  );
}
for (const key of ["natural", "divine"]) {
  md.push(`## Test 8 — The storm, house by house (${key === "natural" ? "under the sun" : "under heaven"})`);
  md.push("");
  md.push("Share of moves keeping covenant: 40 steps before the storm, during it, and the last 40 steps.");
  md.push("");
  table(
    ["House", "Before", "Storm", "After", "Faith before → after", "Back to 90% in"],
    results.storm[key].summary.map((s) => [
      name(s.id), pct(s.before), pct(s.during), pct(s.after), `${f2(s.faithBefore)} → ${f2(s.faithAfter)}`,
      s.recoveredAt == null ? (s.before >= 0.5 ? "never" : "n/a (no peace before)") : s.recoveredAt + (s.recoveredAt === 1 ? " step" : " steps"),
    ]),
  );
}

mkdirSync(join(root, "docs"), { recursive: true });
writeFileSync(join(root, "docs/faith-theory-results.md"), md.join("\n"));
log("wrote public/faith/results.js and docs/faith-theory-results.md");
process.stdout.write(md.join("\n") + "\n");
