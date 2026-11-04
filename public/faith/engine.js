/*
 * Faith Theory — simulation engine
 * ---------------------------------
 * An Axelrod-style iterated Prisoner's Dilemma ("the Covenant Game") in which
 * every strategy is an archetype of faith drawn from Scripture.
 *
 * Each agent carries a FAITH level F in [0, 1]. Faith is global: it travels
 * with the agent from one relationship to the next, so how one partner treats
 * you shapes how you treat everyone else ("evil communications corrupt good
 * manners", 1 Cor 15:33). Every step, every agent plays one move with every
 * other agent in the assembly.
 *
 * Two kinds of world:
 *   - "Under the sun"  (natural):  only the game itself. Payoffs R3 T5 S0 P1.
 *   - "Under heaven"   (divine):   four modelled promises, scaled by a
 *                                   strength s in [0, 1]:
 *       unity        Ps 133      mutual covenant pays R + s
 *       reaping      Gal 6:7-9   betrayal is recompensed "after many days"
 *                    Rom 12:19   (`delay` steps). "Vengeance is mine; I will
 *                                repay": the betrayed receives (R-S)*s, but only
 *                                if by then they have not avenged themselves
 *                                (still keeping covenant with the betrayer —
 *                                "if we faint not"). The betrayer pays (T-R)*s,
 *                                unless by then they have been reconciled
 *                                (keeping covenant again — Matt 5:24).
 *       restoration Ps 23:3      divinely anchored faith is pulled back
 *                                toward its anchor each step (Luke 22:32)
 *       renewal     Ezek 36:26   mercy received after doing wrong softens the
 *                                heart (Rom 12:20-21), for everyone
 *
 * The divine world is a model of what the promises would do IF they operate
 * as written here. It is a thought experiment, not a measurement of God.
 *
 * Works in the browser (window.FaithTheory) and in Node (require).
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.FaithTheory = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // ------------------------------------------------------------------ payoffs
  var PAYOFF = { R: 3, T: 5, S: 0, P: 1 };

  // Strength of each divine mechanic at s = 1.
  var DIVINE = {
    unityBonus: 1.0, // R: 3 -> 4 (still below T = 5, so the dilemma remains)
    reapFraction: 1.0, // at s = 1 a betrayal is fully recompensed (if faith holds)
    restoreRate: 0.08, // per step, toward the anchor
    renewRate: 0.3, // per step, scaled by the share of mercy received
  };

  // ------------------------------------------------------------- archetypes
  // rule:   what the agent's conscience recommends this move
  //   allc  always keep covenant
  //   tft   keep covenant first, then answer the partner's last move
  //   stft  hold back first ("except I see"), then answer the last move
  //   wsls  win-stay lose-shift: if the partner kept covenant, repeat; else switch
  // F0:       starting faith (probability of acting on a good recommendation)
  // sightUp:  how much being treated well raises faith   ("walk by sight")
  // sightDown how much being betrayed lowers faith
  // mercy:    chance (times F) of keeping covenant when conscience says retaliate
  // greed:    chance of quietly holding back when conscience says keep covenant
  // wave:     amplitude of faith's own tide (James 1:6); period in steps
  // source:   "divine" (anchored in God; restoration applies), "sight"
  //           (trust in man, built on evidence), "none"
  // anchor:   where restoration pulls faith back to (defaults to F0)
  var ARCHETYPES = [
    {
      id: "steadfast",
      name: "Steadfast",
      figure: "Abraham",
      ref: "Romans 4:20",
      quote: "He staggered not at the promise of God through unbelief.",
      source: "divine",
      band: "high",
      classic: "Always Cooperate",
      blurb: "Keeps covenant with everyone, every time. Turns the other cheek (Matt 5:39).",
      rule: "allc", F0: 1, sightUp: 0, sightDown: 0, mercy: 1,
    },
    {
      id: "joseph",
      name: "Discerning",
      figure: "Joseph",
      ref: "Genesis 50:20 · Matthew 10:16",
      quote: "Ye thought evil against me; but God meant it unto good.",
      source: "divine",
      band: "high",
      classic: "Generous Tit for Tat",
      blurb: "Leads with good faith, answers betrayal, but forgives about one wrong in three. Wise as serpents, harmless as doves.",
      rule: "tft", F0: 1, sightUp: 0, sightDown: 0, mercy: 1 / 3,
    },
    {
      id: "peter",
      name: "Undulating",
      figure: "Peter on the water",
      ref: "Matthew 14:30-31 · James 1:6",
      quote: "He that wavereth is like a wave of the sea driven with the wind and tossed.",
      source: "divine",
      band: "wavering",
      classic: "none (new)",
      blurb: "Strong faith that rises and falls with its own tide and is driven hard by how others treat it.",
      rule: "tft", F0: 0.85, sightUp: 0.06, sightDown: 0.08, mercy: 0.5, wave: 0.3, period: 24,
    },
    {
      id: "mustard",
      name: "Mustard Seed",
      figure: "The disciples",
      ref: "Matthew 17:20 · Luke 17:5",
      quote: "If ye have faith as a grain of mustard seed…",
      source: "divine",
      band: "low",
      classic: "none (new)",
      blurb: "Starts with very little faith. Grows when watered with kindness and is hard to uproot.",
      rule: "tft", F0: 0.15, sightUp: 0.12, sightDown: 0.02, mercy: 1 / 3, anchor: 1,
    },
    {
      id: "law",
      name: "Eye for an Eye",
      figure: "The Law of Moses",
      ref: "Exodus 21:24",
      quote: "Eye for eye, tooth for tooth.",
      source: "sight",
      band: "high",
      classic: "Tit for Tat (Axelrod's winner)",
      blurb: "Keeps covenant first, then returns exactly what it receives. Justice by sight.",
      rule: "tft", F0: 1, sightUp: 0, sightDown: 0, mercy: 0,
    },
    {
      id: "thomas",
      name: "Show Me First",
      figure: "Thomas",
      ref: "John 20:25",
      quote: "Except I shall see… I will not believe.",
      source: "sight",
      band: "medium",
      classic: "Suspicious Tit for Tat",
      blurb: "Withholds trust until it sees good faith, then mirrors it.",
      rule: "stft", F0: 1, sightUp: 0, sightDown: 0, mercy: 0,
    },
    {
      id: "prodigal",
      name: "Prodigal",
      figure: "The prodigal son",
      ref: "Luke 15:17",
      quote: "And when he came to himself…",
      source: "sight",
      band: "medium",
      classic: "Win-Stay Lose-Shift (Pavlov)",
      blurb: "Keeps doing what pays. When famine comes, comes to himself and turns around.",
      rule: "wsls", F0: 1, sightUp: 0, sightDown: 0, mercy: 0,
    },
    {
      id: "rocky",
      name: "Rocky Ground",
      figure: "Seed on stony places",
      ref: "Matthew 13:20-21",
      quote: "When tribulation ariseth… by and by he is offended.",
      source: "sight",
      band: "high",
      classic: "≈ Grim Trigger",
      blurb: "Receives with joy and full faith, but has no root: betrayal withers it, and it barely regrows.",
      rule: "tft", F0: 1, sightUp: 0.003, sightDown: 0.15, mercy: 0,
    },
    {
      id: "thorny",
      name: "Thorny Ground",
      figure: "Ananias & Sapphira",
      ref: "Acts 5:2 · Matthew 13:22",
      quote: "…kept back part of the price.",
      source: "sight",
      band: "medium",
      classic: "Joss (sneaky Tit for Tat)",
      blurb: "Looks like Eye for an Eye, but one time in ten quietly keeps back its part.",
      rule: "tft", F0: 1, sightUp: 0, sightDown: 0, mercy: 0, greed: 0.1,
    },
    {
      id: "lukewarm",
      name: "Lukewarm",
      figure: "Laodicea",
      ref: "Revelation 3:15-16",
      quote: "Thou art neither cold nor hot.",
      source: "none",
      band: "medium",
      classic: "Random",
      blurb: "Half-hearted: keeps covenant about half the time, whatever anyone does.",
      rule: "allc", F0: 0.5, sightUp: 0, sightDown: 0, mercy: 1,
    },
    {
      id: "cain",
      name: "No Faith",
      figure: "Cain",
      ref: "Genesis 4:9",
      quote: "Am I my brother's keeper?",
      source: "none",
      band: "none",
      classic: "Always Defect",
      blurb: "Trusts no one and keeps covenant with no one. Not moved by sight.",
      rule: "tft", F0: 0, sightUp: 0, sightDown: 0, mercy: 0,
    },
  ];

  var BY_ID = {};
  ARCHETYPES.forEach(function (a) {
    BY_ID[a.id] = a;
  });

  function normalizeDef(d) {
    return {
      id: d.id,
      name: d.name || d.id,
      source: d.source || "sight",
      rule: d.rule || "tft",
      F0: d.F0 == null ? 1 : d.F0,
      sightUp: d.sightUp || 0,
      sightDown: d.sightDown || 0,
      mercy: d.mercy || 0,
      greed: d.greed || 0,
      wave: d.wave || 0,
      period: d.period || 24,
      anchor: d.anchor == null ? (d.F0 == null ? 1 : d.F0) : d.anchor,
    };
  }

  /**
   * A synthetic agent defined only by its faith LEVEL and STYLE, used for the
   * faith-spectrum tests.
   *   focused:    faith holds at `level` regardless of what it sees
   *   undulating: starts at `level`, driven by sight, with its own tide
   * Both answer betrayal like Joseph (forgive one in three, scaled by faith).
   */
  function levelAgent(level, style) {
    var undulating = style === "undulating";
    return {
      id: (undulating ? "und-" : "foc-") + level.toFixed(2),
      name: (undulating ? "Undulating " : "Focused ") + Math.round(level * 100) + "%",
      source: "divine",
      rule: "tft",
      F0: level,
      sightUp: undulating ? 0.06 : 0,
      sightDown: undulating ? 0.08 : 0,
      mercy: 1 / 3,
      wave: undulating ? 0.3 : 0,
      period: 24,
      anchor: level,
    };
  }

  // ------------------------------------------------------------------- rng
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function clamp01(x) {
    return x < 0 ? 0 : x > 1 ? 1 : x;
  }

  var NATURAL = {
    divine: 0,
    unity: true,
    reaping: true,
    restoration: true,
    renewal: true,
    noise: 0,
    delay: 10,
    storm: null, // { from, to, noise }
  };

  function worldOf(w) {
    var out = {};
    for (var k in NATURAL) out[k] = NATURAL[k];
    if (w) for (var j in w) out[j] = w[j];
    return out;
  }

  // ------------------------------------------------------------- simulate
  /**
   * Run one assembly.
   * opts.defs     array of agent definitions (one per agent)
   * opts.group    array of group indices (one per agent); groups are what
   *               results are reported by
   * opts.groups   number of groups
   * opts.mix      optional G x G matrix: mix[a][b] = weight agent of group a
   *               puts on meeting group b (rows sum to 1). Default uniform.
   * opts.world    world settings (see NATURAL)
   * opts.steps    number of steps (each step: every pair plays one move)
   * opts.seed     rng seed
   * opts.track    record per-step cooperation and faith by group
   */
  function simulate(opts) {
    var defs = opts.defs.map(normalizeDef);
    var group = opts.group;
    var G = opts.groups;
    var n = defs.length;
    var world = worldOf(opts.world);
    var steps = opts.steps || 200;
    var rand = mulberry32(opts.seed == null ? 1 : opts.seed);
    var s = world.divine || 0;
    var R = PAYOFF.R + (world.unity ? DIVINE.unityBonus * s : 0);
    var T = PAYOFF.T, S = PAYOFF.S, P = PAYOFF.P;
    var reap = world.reaping ? DIVINE.reapFraction * s : 0;
    var restore = world.restoration ? DIVINE.restoreRate * s : 0;
    var renew = world.renewal ? DIVINE.renewRate * s : 0;

    var a, b, i, j;
    var mix = opts.mix;
    if (!mix) {
      mix = [];
      for (a = 0; a < G; a++) {
        mix.push([]);
        for (b = 0; b < G; b++) mix[a].push(1 / G);
      }
    }

    // partner counts per (agent, group) and weights w[i*n+j]
    var w = new Float64Array(n * n);
    for (i = 0; i < n; i++) {
      var cnt = new Array(G).fill(0);
      for (j = 0; j < n; j++) if (j !== i) cnt[group[j]]++;
      var norm = 0;
      for (b = 0; b < G; b++) if (cnt[b] > 0) norm += mix[group[i]][b];
      for (j = 0; j < n; j++) {
        if (j === i) continue;
        var gb = group[j];
        w[i * n + j] = norm > 0 ? mix[group[i]][gb] / cnt[gb] / norm : 0;
      }
    }

    var F = new Float64Array(n);
    var Feff = new Float64Array(n);
    var phase = new Float64Array(n);
    for (i = 0; i < n; i++) {
      F[i] = defs[i].F0;
      phase[i] = rand() * Math.PI * 2;
    }
    var last = new Int8Array(n * n).fill(-1); // last[i*n+j]: i's last move toward j
    var cur = new Int8Array(n * n);

    var score = new Float64Array(n);
    var weight = new Float64Array(n);
    var coopMoves = new Float64Array(n);
    var faithSum = new Float64Array(n);
    var h2hSum = new Float64Array(G * G);
    var h2hCnt = new Float64Array(G * G);

    // deferred recompense: due[t] = list of [agent, partner, amount, kind(+1 reward / -1 debt), weight]
    var due = reap > 0 ? new Array(steps) : null;

    var track = !!opts.track;
    var tl = null;
    var groupSize = new Array(G).fill(0);
    for (i = 0; i < n; i++) groupSize[group[i]]++;
    if (track) {
      tl = { coop: [], faith: [] };
      for (a = 0; a < G; a++) {
        tl.coop.push(new Array(steps));
        tl.faith.push(new Array(steps));
      }
    }

    var coopW = new Float64Array(n);
    var mercyW = new Float64Array(n);
    var stepW = new Float64Array(n);
    var stepCoopMoves = new Float64Array(n);

    for (var t = 0; t < steps; t++) {
      var noise = world.noise;
      if (world.storm && t >= world.storm.from && t < world.storm.to) noise = world.storm.noise;

      for (i = 0; i < n; i++) {
        var d0 = defs[i];
        Feff[i] = d0.wave ? clamp01(F[i] + d0.wave * Math.sin((2 * Math.PI * t) / d0.period + phase[i])) : F[i];
        faithSum[i] += Feff[i];
      }

      // recompense falling due now
      if (due && due[t]) {
        var list = due[t];
        for (var q = 0; q < list.length; q++) {
          var e = list[q];
          // last[] still holds the previous step's moves here
          var keeping = last[e[0] * n + e[1]] === 1;
          var amt = e[3] > 0 ? (keeping ? e[2] : 0) : keeping ? 0 : -e[2];
          if (amt !== 0) {
            score[e[0]] += amt * e[4];
            h2hSum[group[e[0]] * G + group[e[1]]] += amt;
          }
        }
        due[t] = null;
      }

      // decisions
      for (i = 0; i < n; i++) {
        coopW[i] = 0;
        mercyW[i] = 0;
        stepW[i] = 0;
        stepCoopMoves[i] = 0;
      }
      for (i = 0; i < n; i++) {
        var d = defs[i];
        for (j = 0; j < n; j++) {
          if (j === i) continue;
          var pm = last[j * n + i]; // partner's last move toward me
          var good;
          switch (d.rule) {
            case "allc":
              good = true;
              break;
            case "stft":
              good = pm === 1;
              break;
            case "wsls":
              var mm = last[i * n + j];
              if (mm === -1) good = true;
              else good = pm === 1 ? mm === 1 : mm !== 1;
              break;
            default: // tft
              good = pm === -1 || pm === 1;
          }
          var p = good ? Feff[i] * (1 - d.greed) : Feff[i] * d.mercy;
          var mv = rand() < p ? 1 : 0;
          if (noise > 0 && rand() < noise) mv = 1 - mv;
          cur[i * n + j] = mv;
        }
      }

      // payoffs and observations
      for (i = 0; i < n; i++) {
        var gi = group[i];
        for (j = 0; j < n; j++) {
          if (j === i) continue;
          var mi = cur[i * n + j];
          var mj = cur[j * n + i];
          var wij = w[i * n + j];
          var pay;
          if (mi === 1 && mj === 1) pay = R;
          else if (mi === 1 && mj === 0) pay = S;
          else if (mi === 0 && mj === 1) pay = T;
          else pay = P;
          score[i] += pay * wij;
          weight[i] += wij;
          h2hSum[gi * G + group[j]] += pay;
          h2hCnt[gi * G + group[j]] += 1;
          stepW[i] += wij;
          if (mj === 1) coopW[i] += wij;
          if (mj === 1 && last[i * n + j] === 0) mercyW[i] += wij; // good returned for my evil
          if (mi === 1) {
            coopMoves[i] += 1;
            stepCoopMoves[i] += 1;
          }
          if (reap > 0 && t + world.delay < steps) {
            var tt = t + world.delay;
            if (mi === 1 && mj === 0) {
              (due[tt] || (due[tt] = [])).push([i, j, (R - S) * reap, 1, wij]);
            } else if (mi === 0 && mj === 1) {
              (due[tt] || (due[tt] = [])).push([i, j, (T - R) * reap, -1, wij]);
            }
          }
        }
      }

      // faith moves
      for (i = 0; i < n; i++) {
        var df = defs[i];
        var c = stepW[i] > 0 ? coopW[i] / stepW[i] : 0;
        var f = F[i];
        f += df.sightUp * c * (1 - f) - df.sightDown * (1 - c) * f;
        if (restore > 0 && df.source === "divine") f += restore * (df.anchor - f);
        if (renew > 0 && stepW[i] > 0) f += renew * (mercyW[i] / stepW[i]) * (1 - f);
        F[i] = clamp01(f);
      }

      if (track) {
        var gc = new Array(G).fill(0);
        var gf = new Array(G).fill(0);
        for (i = 0; i < n; i++) {
          gc[group[i]] += stepCoopMoves[i] / (n - 1);
          gf[group[i]] += Feff[i];
        }
        for (a = 0; a < G; a++) {
          tl.coop[a][t] = groupSize[a] ? gc[a] / groupSize[a] : null;
          tl.faith[a][t] = groupSize[a] ? gf[a] / groupSize[a] : null;
        }
      }

      var swap = last;
      last = cur;
      cur = swap;
    }

    // aggregate by group
    var res = [];
    for (a = 0; a < G; a++) res.push({ score: 0, coop: 0, meanFaith: 0, finalFaith: 0, n: 0 });
    for (i = 0; i < n; i++) {
      var r = res[group[i]];
      r.score += weight[i] > 0 ? score[i] / weight[i] : 0;
      r.coop += coopMoves[i] / ((n - 1) * steps);
      r.meanFaith += faithSum[i] / steps;
      r.finalFaith += F[i];
      r.n += 1;
    }
    res.forEach(function (r) {
      if (r.n) {
        r.score /= r.n;
        r.coop /= r.n;
        r.meanFaith /= r.n;
        r.finalFaith /= r.n;
      }
    });
    var h2h = [];
    for (a = 0; a < G; a++) {
      h2h.push([]);
      for (b = 0; b < G; b++) h2h[a].push(h2hCnt[a * G + b] ? h2hSum[a * G + b] / h2hCnt[a * G + b] : null);
    }
    return { groups: res, h2h: h2h, timeline: tl };
  }

  // ------------------------------------------------------------- helpers
  function buildAssembly(defList, copies) {
    var defs = [], group = [];
    defList.forEach(function (d, g) {
      for (var c = 0; c < copies; c++) {
        defs.push(d);
        group.push(g);
      }
    });
    return { defs: defs, group: group, groups: defList.length };
  }

  function mixMatrix(shares, assembly) {
    var G = shares.length, z = assembly || 0, m = [];
    for (var a = 0; a < G; a++) {
      m.push([]);
      for (var b = 0; b < G; b++) m[a].push((a === b ? z : 0) + (1 - z) * shares[b]);
    }
    return m;
  }

  function average(runs, G) {
    var out = [];
    for (var a = 0; a < G; a++) {
      var o = { score: 0, coop: 0, meanFaith: 0, finalFaith: 0 };
      runs.forEach(function (r) {
        o.score += r.groups[a].score;
        o.coop += r.groups[a].coop;
        o.meanFaith += r.groups[a].meanFaith;
        o.finalFaith += r.groups[a].finalFaith;
      });
      for (var k in o) o[k] /= runs.length;
      // standard error of the mean score across repetitions
      var v = 0;
      runs.forEach(function (r) {
        v += Math.pow(r.groups[a].score - o.score, 2);
      });
      o.se = runs.length > 1 ? Math.sqrt(v / (runs.length - 1) / runs.length) : 0;
      out.push(o);
    }
    var h2h = [];
    for (a = 0; a < G; a++) {
      h2h.push([]);
      for (var b = 0; b < G; b++) {
        var sum = 0, c = 0;
        runs.forEach(function (r) {
          if (r.h2h[a][b] != null) {
            sum += r.h2h[a][b];
            c++;
          }
        });
        h2h[a].push(c ? sum / c : null);
      }
    }
    return { groups: out, h2h: h2h };
  }

  // ---------------------------------------------------------- experiments

  /** Round robin: every archetype meets every other and its own twin. */
  function tournament(o) {
    o = o || {};
    var ids = o.ids || ARCHETYPES.map(function (x) { return x.id; });
    var defs = ids.map(function (id) { return BY_ID[id]; }).concat(o.extra || []);
    var asm = buildAssembly(defs, o.copies || 2);
    var reps = o.reps || 10, runs = [];
    for (var r = 0; r < reps; r++) {
      runs.push(simulate({
        defs: asm.defs, group: asm.group, groups: asm.groups,
        world: o.world, steps: o.steps || 200, seed: (o.seed || 1) * 1000 + r,
      }));
    }
    var avg = average(runs, asm.groups);
    var rows = defs.map(function (d, g) {
      var x = avg.groups[g];
      return { id: d.id, name: d.name, score: x.score, se: x.se, coop: x.coop, meanFaith: x.meanFaith, finalFaith: x.finalFaith };
    });
    var order = rows.map(function (_, k) { return k; }).sort(function (p, q) { return rows[q].score - rows[p].score; });
    order.forEach(function (k, rank) { rows[k].rank = rank + 1; });
    return { rows: rows, h2h: avg.h2h, ids: defs.map(function (d) { return d.id; }) };
  }

  /** Every level against every level, two agents at a time (the diagonal is self-play). */
  function levelsMatrix(o) {
    o = o || {};
    var levels = o.levels || [1, 0.75, 0.5, 0.25, 0];
    var defs = [];
    levels.forEach(function (L) { defs.push(levelAgent(L, "focused")); });
    (o.undulating || [0.85, 0.5]).forEach(function (L) { defs.push(levelAgent(L, "undulating")); });
    var reps = o.reps || 20, steps = o.steps || 200;
    var M = [];
    for (var a = 0; a < defs.length; a++) {
      M.push([]);
      for (var b = 0; b < defs.length; b++) {
        var sum = 0;
        for (var r = 0; r < reps; r++) {
          var res = simulate({
            defs: [defs[a], defs[b]], group: [0, 1], groups: 2,
            world: o.world, steps: steps, seed: 7919 * (a + 1) + 104729 * (b + 1) + r,
          });
          sum += res.groups[0].score;
        }
        M[a].push(sum / reps);
      }
    }
    return { labels: defs.map(function (d) { return d.name; }), ids: defs.map(function (d) { return d.id; }), matrix: M };
  }

  /** Insert a test agent at each faith level into the full assembly; how does it fare? */
  function faithCurve(o) {
    o = o || {};
    var levels = o.levels || [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1];
    var style = o.style || "focused";
    return levels.map(function (L, k) {
      var res = tournament({
        world: o.world, reps: o.reps || 4, steps: o.steps || 200, seed: (o.seed || 11) + k,
        extra: [levelAgent(L, style)],
      });
      var row = res.rows[res.rows.length - 1];
      return { level: L, score: row.score, coop: row.coop, meanFaith: row.meanFaith, rank: row.rank };
    });
  }

  /** Ecological tournament (Axelrod 1984, ch. 3): shares grow in proportion to score. */
  function generations(o) {
    o = o || {};
    var ids = o.ids || ARCHETYPES.map(function (x) { return x.id; });
    var defsAll = ids.map(function (id) { return BY_ID[id]; });
    var G = ids.length;
    var shares = o.shares ? o.shares.slice() : new Array(G).fill(1 / G);
    var gens = o.gens || 50, steps = o.steps || 150;
    var history = [shares.slice()], fitnessHistory = [];
    for (var g = 0; g < gens; g++) {
      var alive = [];
      for (var a = 0; a < G; a++) if (shares[a] > 1e-4) alive.push(a);
      var defs = alive.map(function (k) { return defsAll[k]; });
      var asm = buildAssembly(defs, 2);
      var sub = alive.map(function (k) { return shares[k]; });
      var tot = sub.reduce(function (x, y) { return x + y; }, 0);
      sub = sub.map(function (x) { return x / tot; });
      var res = simulate({
        defs: asm.defs, group: asm.group, groups: asm.groups,
        mix: mixMatrix(sub, o.assembly), world: o.world, steps: steps, seed: (o.seed || 5) * 7777 + g,
      });
      var fit = new Array(G).fill(0);
      alive.forEach(function (k, idx) { fit[k] = Math.max(0.01, res.groups[idx].score); });
      var mean = 0;
      for (a = 0; a < G; a++) mean += shares[a] * fit[a];
      var next = shares.map(function (x, k) { return x > 1e-4 ? (x * fit[k]) / mean : 0; });
      var s2 = next.reduce(function (x, y) { return x + y; }, 0);
      shares = next.map(function (x) { return x / s2; });
      history.push(shares.slice());
      fitnessHistory.push(fit);
    }
    return { ids: ids, history: history, fitness: fitnessHistory };
  }

  /**
   * "Peradventure ten shall be found there" (Gen 18:32).
   * A city of `size` where everyone else is Cain: how many of the faithful are
   * needed before they out-earn the faithless and begin to spread?
   */
  function righteousThreshold(o) {
    var faithful = BY_ID[o.id], cain = BY_ID.cain;
    var size = o.size || 100;
    var asm = buildAssembly([faithful, cain], 2);
    var gap = [];
    var found = null;
    for (var k = 1; k <= (o.max || 50); k++) {
      var p = k / size, diff = 0, reps = o.reps || 4;
      for (var r = 0; r < reps; r++) {
        var res = simulate({
          defs: asm.defs, group: asm.group, groups: 2,
          mix: mixMatrix([p, 1 - p], o.assembly), world: o.world, steps: o.steps || 200,
          seed: 31337 + k * 97 + r,
        });
        diff += res.groups[0].score - res.groups[1].score;
      }
      diff /= reps;
      gap.push({ k: k, diff: diff });
      if (found == null && diff > 0) found = k;
      if (found != null && k >= found + 2 && !o.full) break;
    }
    return { id: o.id, threshold: found, gap: gap };
  }

  /**
   * "The rain descended, and the floods came, and the winds blew, and beat
   * upon that house" (Matt 7:25). Each archetype lives in its own house — a
   * small community of its own kind, interacting only with itself. The world
   * is calm, then for `to - from` steps chance runs wild (every intended move
   * misfires with probability `stormNoise`), then calm returns. Which houses
   * stand?
   */
  function storm(o) {
    o = o || {};
    var ids = o.ids || ARCHETYPES.map(function (x) { return x.id; });
    var size = o.houseSize || 4;
    var steps = o.steps || 400;
    var reps = o.reps || 10;
    var from = o.from == null ? 160 : o.from, to = o.to == null ? 200 : o.to;
    var world = worldOf(o.world);
    world.noise = o.baseNoise == null ? 0 : o.baseNoise;
    world.storm = { from: from, to: to, noise: o.stormNoise == null ? 0.3 : o.stormNoise };
    var coop = [], faith = [];
    ids.forEach(function (id, k) {
      var c = new Array(steps).fill(0), f = new Array(steps).fill(0);
      var asm = buildAssembly([BY_ID[id]], size);
      for (var r = 0; r < reps; r++) {
        var res = simulate({
          defs: asm.defs, group: asm.group, groups: 1,
          world: world, steps: steps, seed: 4242 + 131 * k + r, track: true,
        });
        for (var t = 0; t < steps; t++) {
          c[t] += res.timeline.coop[0][t] / reps;
          f[t] += res.timeline.faith[0][t] / reps;
        }
      }
      coop.push(c);
      faith.push(f);
    });
    function mean(arr, x0, x1) {
      var s = 0;
      for (var t = x0; t < x1; t++) s += arr[t];
      return s / (x1 - x0);
    }
    var summary = ids.map(function (id, k) {
      var before = mean(coop[k], Math.max(0, from - 40), from);
      var during = mean(coop[k], from, to);
      var after = mean(coop[k], steps - 40, steps);
      var recoveredAt = null;
      if (before >= 0.5) {
        for (var t = to; t + 10 <= steps; t++) {
          if (mean(coop[k], t, t + 10) >= 0.9 * before) {
            recoveredAt = t - to;
            break;
          }
        }
      }
      return {
        id: id, before: before, during: during, after: after,
        faithBefore: mean(faith[k], Math.max(0, from - 40), from), faithAfter: mean(faith[k], steps - 40, steps),
        recoveredAt: recoveredAt,
      };
    });
    return { ids: ids, coop: coop, faith: faith, from: from, to: to, steps: steps, summary: summary };
  }

  /** Score of every archetype as the divine strength rises from 0 to 1. */
  function divineSweep(o) {
    o = o || {};
    var strengths = o.strengths || [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1];
    return strengths.map(function (s, k) {
      var world = worldOf(o.world);
      world.divine = s;
      var res = tournament({ world: world, reps: o.reps || 6, steps: o.steps || 200, seed: 300 + k });
      return { s: s, rows: res.rows };
    });
  }

  /** Each promise alone, to see which one does what. */
  function ablation(o) {
    o = o || {};
    var s = o.strength == null ? 1 : o.strength;
    var noise = o.noise == null ? 0.05 : o.noise;
    var conditions = [
      { key: "none", label: "Under the sun", world: { divine: 0, noise: noise } },
      { key: "unity", label: "Unity only", world: { divine: s, noise: noise, unity: true, reaping: false, restoration: false, renewal: false } },
      { key: "reaping", label: "Reaping only", world: { divine: s, noise: noise, unity: false, reaping: true, restoration: false, renewal: false } },
      { key: "restoration", label: "Restoration only", world: { divine: s, noise: noise, unity: false, reaping: false, restoration: true, renewal: false } },
      { key: "renewal", label: "Renewal only", world: { divine: s, noise: noise, unity: false, reaping: false, restoration: false, renewal: true } },
      { key: "all", label: "All four", world: { divine: s, noise: noise } },
    ];
    return conditions.map(function (c, k) {
      var res = tournament({ world: c.world, reps: o.reps || 8, steps: o.steps || 200, seed: 900 + k });
      return { key: c.key, label: c.label, rows: res.rows };
    });
  }

  return {
    PAYOFF: PAYOFF,
    DIVINE: DIVINE,
    ARCHETYPES: ARCHETYPES,
    BY_ID: BY_ID,
    levelAgent: levelAgent,
    simulate: simulate,
    buildAssembly: buildAssembly,
    mixMatrix: mixMatrix,
    tournament: tournament,
    levelsMatrix: levelsMatrix,
    faithCurve: faithCurve,
    generations: generations,
    righteousThreshold: righteousThreshold,
    storm: storm,
    divineSweep: divineSweep,
    ablation: ablation,
  };
});
